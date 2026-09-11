/**
 * e2e-evidence.mjs — P4-1 证据生成器（可复跑）。
 *
 * 作用：把「真实浏览器 E2E 到底证明了什么」变成一段可复述的现场读数，而不是只给一句「7/7 通过」：
 *   · 浏览器标识（`Browser.getVersion`）；
 *   · 绘制前后 canvas 的非透明像素数与包围盒（证明**真的渲染**，不是只有 DOM 变化）；
 *   · 服务端落库元素数（证明**真的发出去了**，前端伪造不了）；
 *   · 只读房间的真实读数（角色文案 / body.readonly / 工具禁用 / 服务端零写入）；
 *   · 截图像素尺寸与字节数（PNG 头解析，不依赖图像库）。
 *
 * 运行（从仓库根）：
 *   node docs/P4-1-evidence/e2e-evidence.mjs
 * 找不到浏览器时打印 SKIP 并退出码 0（与本仓库其他「环境不足则 SKIP」的脚本一致）。
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer, json } from '../../whiteboard/apps/server/test/helpers.mjs'
import { launchBrowser, browserProbe } from '../../scripts/e2e/cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHOT_DIR = join(ROOT, '.ci', 'e2e-shots')

/** 读 PNG 头（IHDR）里的宽高与文件字节数——不引入图像库。 */
function pngInfo(file) {
  const buf = readFileSync(file)
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return {
    file,
    isPng,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: statSync(file).size,
  }
}

const CANVAS_INK = () => {
  const c = document.getElementById('board')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let count = 0
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] === 0) continue
    const p = (i - 3) / 4
    const x = p % c.width
    const y = (p - x) / c.width
    count += 1
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { count, bbox: count ? [minX, minY, maxX, maxY] : null, canvas: [c.width, c.height] }
}

const READONLY = () => ({
  roleText: document.getElementById('role')?.textContent ?? null,
  roleClass: document.getElementById('role')?.className ?? null,
  bodyReadonly: document.body.classList.contains('readonly'),
  toolsDisabled: [...document.querySelectorAll('.tool')].map((b) => b.disabled),
  hint: document.getElementById('hint')?.textContent ?? null,
})

const READY = () => {
  const dot = document.getElementById('conn')
  const online = document.getElementById('online')
  return dot?.className === 'dot on' && (online?.textContent ?? '').startsWith('在线: 1')
}

const probe = browserProbe()
if (!probe.available) {
  console.log('[SKIP] 未找到可用浏览器（Edge/Chrome）：' + probe.envHint)
  console.log('       探测路径：' + probe.tried.join(' | '))
  process.exit(0)
}

const out = []
const say = (s) => { out.push(s); console.log(s) }

const srv = await startServer({ WHITEBOARD_ROOMS: 'main:tok-main:rw,view:tok-view:ro' })
const browser = await launchBrowser({ width: 1000, height: 700 })
const ver = browser.version()
say('# P4-1 真实浏览器 E2E 现场读数')
say('')
say('- 探测到的浏览器：`' + probe.exe + '`')
say('- `Browser.getVersion`：product=`' + ver.product + '` protocol=`' + ver.protocolVersion + '` revision=`' + (ver.revision ?? '').slice(0, 12) + '`')
say('- 白板服务：真实 `apps/server/src/index.js` 进程，端口 ' + srv.port + '（内存房间，`WB_IN_MEMORY=1`）')

try {
  const page = await browser.newPage()
  const t0 = Date.now()

  // ① 可编辑房间：真实鼠标绘制
  await page.goto(`http://127.0.0.1:${srv.port}/?room=main&token=tok-main`)
  await page.waitFor(READY, { timeoutMs: 10000, label: '就绪' })
  const readyMs = Date.now() - t0
  const before = await page.evaluate(CANVAS_INK)
  await page.click('[data-tool="rect"]')
  const stage = await page.centerOf('#stage')
  await page.drag({ x: stage.x - 120, y: stage.y - 60 }, { x: stage.x + 60, y: stage.y + 40 }, { steps: 8 })
  const after = await page.evaluate(CANVAS_INK)
  let elements = -1
  for (let i = 0; i < 60; i += 1) {
    const r = await json(srv.port, '/api/rooms/main')
    if (r.status === 200 && (r.body?.elements ?? 0) >= 1) { elements = r.body.elements; break }
    await new Promise((r2) => setTimeout(r2, 100))
  }
  mkdirSync(SHOT_DIR, { recursive: true })
  const shot = join(SHOT_DIR, 'evidence-drawn-rect.png')
  await page.screenshot(shot)

  say('')
  say('## 可编辑房间（?room=main&token=tok-main）')
  say('')
  say('- 页面就绪（连接点变绿 + 在线数含自己）耗时：' + readyMs + ' ms')
  say('- 绘制前 canvas 非透明像素：**' + before.count + '**；绘制后：**' + after.count + '**（包围盒 ' + JSON.stringify(after.bbox) + '，画布 ' + JSON.stringify(after.canvas) + '）')
  say('- 服务端 `/api/rooms/main` 落库元素数：**' + elements + '**（前端伪造不了这个数字）')
  const info = pngInfo(shot)
  say('- 截图：`' + info.file.replace(ROOT + '\\', '') + '`，' + info.width + '×' + info.height + '，' + info.bytes + ' 字节，PNG 魔数=' + info.isPng)

  // ② 只读房间
  await page.goto(`http://127.0.0.1:${srv.port}/?room=view&token=tok-view`)
  await page.waitFor(() => document.getElementById('role')?.textContent === '只读', { timeoutMs: 10000, label: '只读角色' })
  const ro = await page.evaluate(READONLY)
  await page.press('r') // 快捷键仍可切工具（keydown 只判 tag），随后拖拽应被前端拦住
  const stage2 = await page.centerOf('#stage')
  await page.drag({ x: stage2.x - 80, y: stage2.y - 40 }, { x: stage2.x + 40, y: stage2.y + 40 }, { steps: 5 })
  await new Promise((r) => setTimeout(r, 300))
  const noticeRo = await page.evaluate(() => {
    const el = document.getElementById('limit')
    return el && el.style.display !== 'none' ? el.textContent : ''
  })
  const roWrite = await json(srv.port, '/api/rooms/view')
  const shot3 = join(SHOT_DIR, 'evidence-readonly.png')
  await page.screenshot(shot3)

  say('')
  say('## 只读房间（?room=view&token=tok-view）')
  say('')
  say('- `#role` 文本/类：`' + ro.roleText + '` / `' + ro.roleClass + '`；`body.readonly`=' + ro.bodyReadonly)
  say('- 工具按钮禁用状态：' + JSON.stringify(ro.toolsDisabled))
  say('- 提示条文案（快捷键切工具后强行拖拽）：`' + noticeRo + '`')
  say('- 服务端 `/api/rooms/view` 元素数：**' + (roWrite.body?.elements ?? '(房间未打开)') + '**（只读写入为零）')
  const info3 = pngInfo(shot3)
  say('- 截图：`' + info3.file.replace(ROOT + '\\', '') + '`，' + info3.width + '×' + info3.height + '，' + info3.bytes + ' 字节')

  say('')
  say('## 页面健康')
  say('')
  say('- `Runtime.exceptionThrown` 捕获数：' + page.pageErrors.length)
  say('- `console.error` 捕获数：' + page.consoleErrors.length)
  say('')
  say('总计耗时：' + (Date.now() - t0) + ' ms')
  await page.close()
} finally {
  await browser.close()
  await srv.stop()
}

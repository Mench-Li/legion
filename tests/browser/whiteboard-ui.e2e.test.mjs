/**
 * whiteboard-ui.e2e.test.mjs — 白板前端的**真实浏览器 DOM 端到端**（P4-1）。
 *
 * 补的是 REMAINING-TASKS #6 登记的盲区：P3-1 的房间/角色/只读/限流这些「只有 DOM 行为能证明」的结论，
 * 此前只有 `apps/web/test/ui-contract.test.mjs` 的**静态契约**（断言 id 存在、CSS 类有样式——
 * 它能证明「接线没断」，但证明不了「点了真的会切房间」）与人工走查。本文件用真实 Chrome/Edge
 * 驱动真实页面、真实鼠标事件、真实 canvas 渲染，并把结论落到**服务端状态**上。
 *
 * 分工（与既有测试不重叠）：
 *   · `apps/server/test/governance.e2e.test.mjs`：服务端治理语义（token/角色/限流/隔离），用 ws 客户端；
 *   · `apps/web/test/ui-contract.test.mjs`：静态接线契约（id/CSS/模块存在性），零依赖；
 *   · **本文件**：同一批治理语义在**浏览器里**的表现——UI 是否真的切只读、提示是否真的出现、
 *     画的东西是否真的到了服务端、canvas 是否真的画出了像素。
 *
 * 运行：
 *   node --test tests/browser/whiteboard-ui.e2e.test.mjs
 *   找不到 Edge/Chrome 时整组 **SKIP**（不伪绿）；用 `DSH_E2E_BROWSER=<可执行文件>` 指定。
 * 截图：失败/成功都可落盘到 `DSH_E2E_SHOT_DIR`（默认 `.ci/e2e-shots/`），供证据文档引用。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer, json } from '../../whiteboard/apps/server/test/helpers.mjs'
import { launchBrowser, browserProbe } from '../../scripts/e2e/cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHOT_DIR = process.env.DSH_E2E_SHOT_DIR || join(ROOT, '.ci', 'e2e-shots')

const ROOMS_CFG = 'main:tok-main:rw,view:tok-view:ro'
const probe = browserProbe()
const describeBrowser = probe.available ? describe : describe.skip

/**
 * 浏览器侧要加载的共享模块是**构建产物**（`whiteboard/apps/web/public/shared/` 未跟踪，
 * 由 `whiteboard/scripts/build.mjs` 从 packages/shared/src 拷贝）。CI 的 `build` 阶段会生成它，
 * 但 `--only test` 会跳过该阶段 —— 此时若不管，页面模块 404、断言只会以「连接不上」的形式炸掉，
 * 定位成本很高。所以这里显式补建一次（零依赖、幂等、只写构建产物目录）。
 */
function ensureWhiteboardAssets() {
  const sharedDir = join(ROOT, 'whiteboard', 'apps', 'web', 'public', 'shared')
  const asset = join(sharedDir, 'room.mjs')
  // 只判断「目录里有 room.mjs」不够：**新增**一个共享模块后，旧目录仍在、room.mjs 也在，
  // 但新模块缺失 → 页面 import 404，报错表现是「连不上/welcome 没来」，定位成本很高（真实踩到）。
  // 所以按「main.mjs 实际 import 了哪些 shared 模块」逐个检查，缺哪个就重建。
  const imported = [...readFileSync(join(ROOT, 'whiteboard', 'apps', 'web', 'public', 'js', 'main.mjs'), 'utf8')
    .matchAll(/from\s+'\.\.\/shared\/([\w.-]+\.mjs)'/g)].map((m) => m[1])
  const missing = imported.filter((f) => !existsSync(join(sharedDir, f)))
  if (existsSync(asset) && missing.length === 0) return 'present'
  const r = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: join(ROOT, 'whiteboard'), encoding: 'utf8', timeout: 60000,
  })
  const stillMissing = imported.filter((f) => !existsSync(join(sharedDir, f)))
  if (r.status !== 0 || !existsSync(asset) || stillMissing.length > 0) {
    throw new Error('whiteboard 静态产物缺失且自动构建失败（缺 ' + (stillMissing.join(', ') || 'room.mjs')
      + '）：' + (r.stderr || r.stdout || r.error?.message || 'unknown'))
  }
  return missing.length > 0 ? 'built-missing:' + missing.join(',') : 'built'
}

if (probe.available) {
  const how = ensureWhiteboardAssets()
  if (how !== 'present') console.log('[e2e] 已自动执行 whiteboard build（`--only test` 会跳过 build 阶段）：whiteboard/scripts/build.mjs（' + how + '）')
}

if (!probe.available) {
  console.log('[skip] 未找到可用浏览器（Edge/Chrome），本组跳过：' + probe.envHint)
  console.log('[skip] 探测过的路径：' + probe.tried.join(' | '))
}

/** 白板页面「已连接并收到 welcome」的判据：连接点变绿 + 在线数含自己。 */
const READY = () => {
  const dot = document.getElementById('conn')
  const online = document.getElementById('online')
  return dot?.className === 'dot on' && (online?.textContent ?? '').startsWith('在线: 1')
}

/** canvas 主画布的非透明像素统计（用来证明「真的画出来了」，而不是只有 DOM 变化）。 */
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
  return { count, minX, minY, maxX, maxY, width: c.width, height: c.height }
}

/** 房间已落库的元素数（服务端真实状态，前端伪造不了）；房间尚未打开时返回 -1。 */
async function roomElements(port, room) {
  const r = await json(port, `/api/rooms/${encodeURIComponent(room)}`)
  return r.status === 200 ? (r.body?.elements ?? -1) : -1
}

/**
 * 等到服务端确实**打开了**该房间（而不是等到页面看起来就绪）。
 * 用途：页内切换房间时不发生导航，`#online` 会保留上一个房间的读数，
 * 只等页面状态会与「新连接尚未建立」竞态；`/api/rooms/:id` 从 404(room_not_open) 变 200
 * 才是「新房间的 ws 已建立」的硬证据。
 */
async function waitRoomOpen(port, room, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    const r = await json(port, `/api/rooms/${encodeURIComponent(room)}`)
    if (r.status === 200) return true
    if (Date.now() - t0 > timeoutMs) throw new Error(`房间 ${room} 在 ${timeoutMs}ms 内未被服务端打开（最后 status=${r.status}）`)
    await new Promise((r2) => setTimeout(r2, 50))
  }
}

async function shot(page, name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot(join(SHOT_DIR, name + '.png'))
  } catch { /* 截图失败不影响结论 */ }
}

/** 只读房间里的「反馈」判据：要么给出只读提示，要么工具本身不可用（两者都算没有静默失败）。 */
const READONLY_FEEDBACK = () => {
  const notice = document.getElementById('limit')
  const visible = notice && notice.style.display !== 'none' ? notice.textContent : ''
  const toolsInert = [...document.querySelectorAll('.tool')].every((b) => b.disabled)
  return { visible, toolsInert, readonly: document.body.classList.contains('readonly') }
}

describeBrowser('P4-1 白板前端 · 真实浏览器 DOM 端到端', () => {
  let srv, browser, page

  before(async () => {
    srv = await startServer({ WHITEBOARD_ROOMS: ROOMS_CFG })
    browser = await launchBrowser({ width: 1000, height: 700 })
    page = await browser.newPage()
  }, { timeout: 90000 })

  after(async () => {
    if (page) await page.close()
    if (browser) await browser.close()
    if (srv) await srv.stop()
  }, { timeout: 30000 })

  const open = (qs) => page.goto(`http://127.0.0.1:${srv.port}/${qs}`)
  const ready = () => page.waitFor(READY, { timeoutMs: 10000, label: '页面连接就绪' })

  /**
   * 装一个**透明**的 WebSocket 捕获器（页面加载前注入，因此在之后每次导航都生效）。
   * 用途：用例 ⑧/⑨ 需要「真的把连接断掉」来制造确定性的「连接未就绪窗口」——
   * 实测 CDP 的 `Network.emulateNetworkConditions({offline:true})` **不影响已建立的 WebSocket**
   * （op 照样送达），所以只能用这种方式。幂等：重复调用只装一次（用例之间不得互相依赖）。
   */
  let wsCaptureInstalled = false
  async function installWsCapture() {
    if (wsCaptureInstalled) return
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        '(() => {',
        '  const Original = window.WebSocket;',
        '  window.WebSocket = function (...args) {',
        '    const s = new Original(...args);',
        '    window.__lastWs = s;',
        '    return s;',
        '  };',
        '  window.WebSocket.prototype = Original.prototype;',
        '  for (const k of ["OPEN", "CLOSED", "CONNECTING", "CLOSING"]) window.WebSocket[k] = Original[k];',
        '})();',
      ].join('\n'),
    })
    wsCaptureInstalled = true
  }

  it('① 进入指定房间：标题/标签/角色/连接点都由真实 welcome 驱动', async () => {
    await open('?room=main&token=tok-main')
    await ready()
    assert.equal(await page.text('#room-label'), 'main')
    assert.equal(await page.text('#role'), '可编辑')
    assert.match(await page.evaluate(() => document.title), /main$/, '标签页标题应跟随房间')
    assert.equal(await page.evaluate(() => document.body.classList.contains('readonly')), false)
    assert.equal(await page.evaluate(() => document.getElementById('room-input').value), 'main', '房间输入框应与当前房间一致')
    // 分享链接里的 token 会被记住（按房间隔离），这样后续打开同房间无需再带 token
    assert.equal(await page.evaluate(() => localStorage.getItem('wb.token.main')), 'tok-main', 'token 应按房间写入 localStorage')
    // 但**切换**房间时不得把它写回 URL（见用例 ④）——分享链接本身带 token 是设计如此
    const consoleNoise = page.consoleErrors.filter((l) => !/favicon/i.test(l))
    assert.deepEqual(consoleNoise, [], '初始加载不应有 console.error：' + consoleNoise.join(' | '))
    await shot(page, 'case1-room-main')
  })

  it('② 真实鼠标绘制 → 服务端落库 + canvas 真的画出像素', async () => {
    const room = 'draw-a'
    await open(`?room=${room}`)
    await ready()
    assert.equal(await roomElements(srv.port, room), 0, '该房间应是全新的空房间（否则后续断言无意义）')
    const before = await page.evaluate(CANVAS_INK)
    assert.equal(before.count, 0, '空房间画布应无墨迹')

    await page.click('[data-tool="rect"]')
    assert.equal(await page.evaluate(() => document.querySelector('[data-tool="rect"]').classList.contains('active')), true, '工具按钮应切到激活态')

    const stage = await page.centerOf('#stage')
    await page.drag({ x: stage.x - 120, y: stage.y - 60 }, { x: stage.x + 60, y: stage.y + 40 }, { steps: 8 })

    // 服务端状态是最终判据：前端「看起来画了」但没发出去，在这里必须失败
    const t0 = Date.now()
    let elements = 0
    while (Date.now() - t0 < 8000) {
      elements = await roomElements(srv.port, room)
      if (elements >= 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(elements, 1, '真实拖拽应在服务端产生 1 个元素')

    const after = await page.waitFor(CANVAS_INK, { timeoutMs: 3000, label: 'canvas 出现墨迹' })
    assert.ok(after.count > 0, 'canvas 应有非透明像素（真实渲染，而不是只有 DOM 变化）')
    assert.ok(after.maxX - after.minX > 20 && after.maxY - after.minY > 20, '墨迹范围应与拖拽出的矩形相称：' + JSON.stringify(after))
    await shot(page, 'case2-drawn-rect')
  })

  it('③ 只读房间：UI 切只读、工具禁用、强行绘制只得到反馈且服务端无写入', async () => {
    await open('?room=view&token=tok-view')
    await page.waitFor(() => document.getElementById('role')?.textContent === '只读', { timeoutMs: 10000, label: '角色下发为只读' })
    assert.equal(await page.evaluate(() => document.getElementById('role').className), 'role ro')
    assert.equal(await page.evaluate(() => document.body.classList.contains('readonly')), true)
    assert.match(await page.text('#hint'), /只读房间/)
    const disabled = await page.evaluate(() => [...document.querySelectorAll('.tool')].map((b) => b.disabled))
    assert.deepEqual(disabled, disabled.map(() => true), '只读时所有工具按钮都应禁用')

    // 绕过按钮禁用：键盘快捷键仍能切工具（main.mjs 的 keydown 只做 tag 判断），
    // 于是「用户用快捷键 + 拖拽」这条真实路径需要在前端被拦住并给出可读反馈。
    // 注：若将来把只读态的**绘制类**工具快捷键改为惰性，本用例的反馈判据仍成立（见 READONLY_FEEDBACK）。
    await page.press('r')
    const stage = await page.centerOf('#stage')
    await page.drag({ x: stage.x - 80, y: stage.y - 40 }, { x: stage.x + 40, y: stage.y + 40 }, { steps: 5 })
    await new Promise((r) => setTimeout(r, 300))

    const fb = await page.evaluate(READONLY_FEEDBACK)
    const gaveFeedback = /只读/.test(fb.visible) || fb.toolsInert
    assert.ok(gaveFeedback, '只读态下的绘制尝试必须有可读反馈（提示或工具惰性），实际：' + JSON.stringify(fb))
    assert.equal(await roomElements(srv.port, 'view'), 0, '只读房间不得产生任何写入')
    await shot(page, 'case3-readonly')
  })

  it('④ 切换房间：URL 更新但不带 token，画的内容落在新房间', async () => {
    await open('?room=main&token=tok-main')
    await ready()
    await page.fill('#room-input', 'switch-a')
    await page.click('#room-go')
    await page.waitFor(() => document.getElementById('room-label')?.textContent === 'switch-a', { timeoutMs: 10000, label: '房间标签切换' })
    await ready()
    // 页内切换不触发导航：本用例主动等新房间连接真的建立，让「画的内容落在新房间」这条断言
    // 不受时序影响（**连接未就绪时画东西**这条竞态由用例 ⑧ 专门覆盖，P4-3 修复）。
    await waitRoomOpen(srv.port, 'switch-a')
    const search = await page.evaluate(() => location.search)
    assert.match(search, /room=switch-a/)
    assert.ok(!search.includes('token'), '切房间不得把 token 写进 URL（会留在浏览器历史里）')

    await page.click('[data-tool="rect"]')
    const stage = await page.centerOf('#stage')
    await page.drag({ x: stage.x - 60, y: stage.y - 30 }, { x: stage.x + 50, y: stage.y + 30 }, { steps: 6 })
    const t0 = Date.now()
    let elements = 0
    while (Date.now() - t0 < 8000) {
      elements = await roomElements(srv.port, 'switch-a')
      if (elements >= 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(elements, 1, '切换后的房间应收到新画的元素')
    assert.equal(await roomElements(srv.port, 'main'), 0, '原房间不应被写入（房间隔离在浏览器路径上同样成立）')
    await shot(page, 'case4-room-switch')
  })

  it('⑤ 非法房间号：不切房间、给出可读提示（而不是静默落到别处）', async () => {
    await open('?room=main&token=tok-main')
    await ready()
    await page.fill('#room-input', 'BAD ROOM')
    await page.click('#room-go')
    const notice = await page.waitFor(() => {
      const el = document.getElementById('limit')
      return el && el.style.display !== 'none' ? el.textContent : null
    }, { timeoutMs: 3000, label: '非法房间提示出现' })
    assert.match(notice, /非法/, '应提示房间 ID 非法：' + notice)
    assert.equal(await page.text('#room-label'), 'main', '非法输入不得改动当前房间')
    assert.match(await page.evaluate(() => location.search), /room=main/, 'URL 不得被非法值改写')
  })

  it('⑥ 主路径无页面异常、无 console 报错（真实浏览器侧的健康判据）', async () => {
    await open('?room=main&token=tok-main')
    await ready()
    assert.deepEqual(page.pageErrors, [], '页面出现未捕获异常：\n' + page.pageErrors.join('\n'))
    assert.deepEqual(page.consoleErrors, [], 'console.error 不应出现：\n' + page.consoleErrors.join('\n'))
  })

  /**
   * 用例 ⑧（P4-3 / 候选 #10）：**连接未就绪窗口内画的东西不能静默丢**。
   *
   * 原缺陷复现路径：`main.mjs` 的 `send()` 只在 `ws.readyState === OPEN` 时发送，其余情况静默 return
   * → 切房间/断线重连的窗口里画的东西①服务端从没收到、②welcome 把 `doc` 换成服务端文档后屏上也消失。
   *
   * 怎么把「窗口」变成确定性的：等 socket 就绪后再断网是没用的（实测 CDP `Network.emulateNetworkConditions`
   * 的 offline **不影响已建立的 WebSocket**，op 照样送达）。这里改为在页面加载前注入脚本捕获 WebSocket
   * 实例，然后在窗口内**真的关掉它** —— 之后 `onclose` 会走 `setTimeout(connect, retryDelay)`，
   * 至少 1s 内 `readyState !== OPEN`，这就是我们要的那个窗口（也是真实用户会遇到的「网络抖一下」）。
   */
  it('⑧ 连接未就绪窗口内的绘制：入队 + 可见提示 + 重连后自动补发（不再静默丢失）', async () => {
    const room = 'race-room'
    await installWsCapture()
    await open(`?room=${room}&token=tok-main`)
    await ready()
    assert.equal(await roomElements(srv.port, room), 0, '该房间应是全新的空房间')

    // 真的把当前连接关掉 → 进入「连接未就绪」窗口（重连至少 1s 后才会发生）
    const closed = await page.evaluate(() => {
      const s = window.__lastWs
      if (!s) return 'no-socket'
      s.close()
      return s.readyState
    })
    assert.notEqual(closed, 'no-socket', '捕获器应已拿到 WebSocket 实例（否则本用例没有测到窗口）')
    await page.waitFor(() => document.getElementById('conn')?.className === 'dot off', { timeoutMs: 3000, label: '连接点变为断开' })

    // 窗口内立刻画一个矩形（真实鼠标事件）
    await page.click('[data-tool="rect"]')
    const stage = await page.centerOf('#stage')
    await page.drag({ x: stage.x - 90, y: stage.y - 50 }, { x: stage.x + 30, y: stage.y + 20 }, { steps: 5 })

    // ① 必须有可见提示（旧行为：静默丢，什么都不说）
    const notice = await page.evaluate(() => {
      const el = document.getElementById('limit')
      return el && el.style.display !== 'none' ? el.textContent : ''
    })
    assert.match(notice, /暂存|未就绪/, '连接未就绪时的绘制必须给出可读提示，而不是静默丢弃：' + JSON.stringify(notice))
    // ② 此刻服务端还没有这个元素（证明它确实还没发出去，而不是我们测错了窗口）
    assert.equal(await roomElements(srv.port, room), 0, '窗口内的绘制此时不应已在服务端')
    // ③ 本地画布上看得见（用户的操作不是「没反应」）
    const localInk = await page.waitFor(CANVAS_INK, { timeoutMs: 3000, label: '本地画布出现墨迹' })
    assert.ok(localInk.count > 0, '窗口内的绘制应先在本地画出来')

    // 重连（retryDelay 1s 起）→ welcome → 自动补发
    await page.waitFor(() => document.getElementById('conn')?.className === 'dot on', { timeoutMs: 15000, label: '自动重连成功' })
    const t0 = Date.now()
    let elements = 0
    while (Date.now() - t0 < 8000) {
      elements = await roomElements(srv.port, room)
      if (elements >= 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(elements, 1, '重连后必须自动补发窗口内的绘制（旧行为：服务端永远只有 0 个元素）')

    // 补发后本地也不能「屏上消失」：welcome 换过 doc，补发时已重新应用
    const afterInk = await page.evaluate(CANVAS_INK)
    assert.ok(afterInk.count > 0, '补发后本地画布仍应有该元素（welcome 不得把它抹掉）')
    const afterNotice = await page.evaluate(() => {
      const el = document.getElementById('limit')
      return el && el.style.display !== 'none' ? el.textContent : ''
    })
    assert.match(afterNotice, /补发/, '补发完成后应如实告知，而不是留着「暂存中」让人以为还没发出去：' + JSON.stringify(afterNotice))
    assert.deepEqual(page.pageErrors, [], '本路径不应产生页面异常：\n' + page.pageErrors.join('\n'))
    await shot(page, 'case8-pending-ops-flush')
  })

  /**
   * 用例 ⑨（P4-3）：候选 #10 登记的**原始复现路径** ——「切房间 → 在新连接就绪前立刻拖拽」。
   * 修复前的实际结果：元素不出现在**任何**房间（旧连接已关、新连接未就绪，op 被静默丢掉）。
   * 修复后要求：入队 → 新房间 welcome 后补发 → 落在**新房间**，且不泄漏到旧房间。
   */
  it('⑨ 切房间后立刻绘制（原始复现路径）：补发到新房间，且不泄漏到旧房间', async () => {
    const from = 'main'
    const to = 'switch-race'
    await installWsCapture()
    await open(`?room=${from}&token=tok-main`)
    await ready()

    await page.fill('#room-input', to)
    await page.click('#room-go')
    // 立刻把刚建立的连接关掉：模拟「新连接还没就绪」。房间标签已切，但连接不可用。
    await page.waitFor(() => document.getElementById('room-label')?.textContent === 'switch-race', { timeoutMs: 10000, label: '房间标签切换' })
    await page.evaluate(() => { window.__lastWs?.close() })
    await page.waitFor(() => document.getElementById('conn')?.className === 'dot off', { timeoutMs: 3000, label: '新连接断开' })

    await page.click('[data-tool="rect"]')
    const stage = await page.centerOf('#stage')
    await page.drag({ x: stage.x - 70, y: stage.y - 40 }, { x: stage.x + 40, y: stage.y + 30 }, { steps: 5 })
    const notice = await page.evaluate(() => {
      const el = document.getElementById('limit')
      return el && el.style.display !== 'none' ? el.textContent : ''
    })
    assert.match(notice, /暂存|未就绪/, '切房间窗口内的绘制同样必须给出可读提示：' + JSON.stringify(notice))

    await page.waitFor(() => document.getElementById('conn')?.className === 'dot on', { timeoutMs: 15000, label: '新房间自动重连' })
    const t0 = Date.now()
    let inNew = 0
    while (Date.now() - t0 < 8000) {
      inNew = await roomElements(srv.port, to)
      if (inNew >= 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(inNew, 1, '补发必须落在**新房间**（旧行为：两个房间都没有这个元素）')
    assert.equal(await roomElements(srv.port, from), 0, '不得把新房间的绘制泄漏到旧房间')
    await shot(page, 'case9-switch-then-draw')
  })
})

describeBrowser('P4-1 白板前端 · 限流提示（服务端限流配置下的真实表现）', () => {
  let srv2, browser2, page2

  before(async () => {
    // 令牌桶：1 个/秒的补充速率 + 6 个突发容量。前端会周期性发 presence（约 20Hz 节流后的稀疏帧），
    // 因此「前几张图能落库、后面的被丢弃」是这里要复现的真实场景（默认部署是 120/秒 + 240 突发，不会触发）。
    srv2 = await startServer({
      WHITEBOARD_ROOMS: 'slow:tok-slow:rw',
      WB_MESSAGE_RATE_PER_SEC: '1',
      WB_MESSAGE_BURST: '6',
      WB_RATE_STRIKES: '20',
      WB_RATE_STRIKE_WINDOW_MS: '10000',
    })
    browser2 = await launchBrowser({ width: 900, height: 640 })
    page2 = await browser2.newPage()
  }, { timeout: 90000 })

  after(async () => {
    if (page2) await page2.close()
    if (browser2) await browser2.close()
    if (srv2) await srv2.stop()
  }, { timeout: 30000 })

  it('超限的绘制会被丢弃并在 UI 上给出「操作过于频繁」提示，落库数少于绘制数', async () => {
    await page2.goto(`http://127.0.0.1:${srv2.port}/?room=slow&token=tok-slow`)
    await page2.waitFor(READY, { timeoutMs: 10000, label: '页面连接就绪' })
    await page2.click('[data-tool="rect"]')
    const stage = await page2.centerOf('#stage')

    // 连续 10 次互不重叠的绘制：突发容量 6 用尽后，后续消息会被服务端丢弃并回 rate_limited
    const draws = 10
    for (let i = 0; i < draws; i += 1) {
      const x = stage.x - 200 + (i % 5) * 60
      const y = stage.y - 60 + Math.floor(i / 5) * 60
      await page2.drag({ x, y }, { x: x + 40, y: y + 30 }, { steps: 3 })
    }

    const notice = await page2.waitFor(() => {
      const el = document.getElementById('limit')
      return el && el.style.display !== 'none' ? el.textContent : null
    }, { timeoutMs: 5000, label: '限流提示出现' })
    assert.match(notice, /过于频繁|频率/, '应给出可读的限流提示，而不是静默丢弃：' + notice)
    await shot(page2, 'case7-rate-limited')

    // 服务端真实状态：确实画进去了一些（说明限流不是「全丢」），但少于绘制次数（说明超限被丢弃）
    await new Promise((r) => setTimeout(r, 500))
    const elements = await roomElements(srv2.port, 'slow')
    assert.ok(elements >= 1, '突发容量内的绘制应落库，实际 ' + elements)
    assert.ok(elements < draws, `超限的绘制不得落库：落库 ${elements} 次 / 绘制 ${draws} 次`)
  })
})

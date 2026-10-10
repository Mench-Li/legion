/**
 * desktop.e2e.test.mjs — 腿 2：**真桌面后台进程 + 真桌面壳页面**（T-195）。
 *
 * ## 这一条腿**不**启动 Electron，这是有意的
 *
 * 真实的桌面应用是 `desktop/main.mjs` 的 Electron 主进程，而它需要
 * `desktop/node_modules/electron`（44.4.5）——本机**不存在**，而仓库纪律
 * 明令「禁止联网下载依赖」（`LEGION.md`）。
 *
 * 所以本文件不假装启动了桌面应用。它验证桌面壳**两侧边界上真实存在的东西**：
 *
 * | # | 对象 | 为什么它值得测 |
 * | --- | --- | --- |
 * | 1 | 真 `product/launcher/desktop-bridge.mjs` 子进程 | **全仓没有任何测试驱动过它**（`desktop/main.test.mjs` 用的是 `fakeBridge()`） |
 * | 2 | 真 JSON-lines 协议校验 | 它是对外唯一的控制通道，畸形输入必须被具名拒绝 |
 * | 3 | 真进程生命周期 | "收到回执"与"进程真的退出"是两件事（`main.mjs` 的退出事务依赖后者） |
 * | 4 | 真 `startup.html` 渲染 | 壳的启动页是用户在服务就绪前看到的唯一东西 |
 *
 *   > 一个"用假 bridge 测出来的桥客户端"，
 *   > 与一个"真的能驱动 bridge 进程"的客户端，
 *   > 在单元测试上是同一个东西——只不过前者从没证明过协议的两端能对上。
 *
 * ## ⚠️ 诚实边界（写在文件里，不是写在事后报告里）
 *
 * - **没有启动 Electron**，所以窗口、托盘、`ipcMain` 真路径、单实例锁、退出事务
 *   （`desktop/main.mjs:189-218`）**都没有被本文件覆盖**。
 * - 第 4 条用一个**与 `preload.cjs` 同形的 `window.legion` 替身**注入页面。
 *   这是**替身**，不是 Electron 的 preload——`preload.cjs` 自己的暴露面契约
 *   由既有的 `desktop/main.test.mjs:111-125`（VM 里跑真 preload 源码）守着，
 *   本文件不重复它、也不声称覆盖了它。
 * - 真机安装包 / Authenticode / `verify:closure` 都不在这里（需要证书与预置载荷）。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT, probeBrowser } from './harness.mjs'

const BRIDGE = join(ROOT, 'product', 'launcher', 'desktop-bridge.mjs')
const STARTUP = join(ROOT, 'desktop', 'startup.html')

/** 逐行读 NDJSON 的子进程客户端（与 `desktop/runtime.mjs` 同协议的简化版）。 */
function startBridgeProcess() {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  let buffer = ''
  const queue = []
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (line.trim() === '') continue
      const frame = JSON.parse(line)
      const w = waiters.shift()
      if (w) w(frame)
      else queue.push(frame)
    }
  })
  let nextId = 1
  return {
    child,
    /** 发一帧并等它的回执。 */
    request(type, payload = {}, { id } = {}) {
      const rid = id ?? `e2e-${nextId++}`
      child.stdin.write(`${JSON.stringify({ version: 1, id: rid, type, payload })}\n`)
      return new Promise((resolve, reject) => {
        if (queue.length > 0) return resolve(queue.shift())
        const timer = setTimeout(() => reject(new Error(`回执超时：${type}（id=${rid}）`)), 15_000)
        waiters.push((frame) => { clearTimeout(timer); resolve(frame) })
      })
    },
    /** 原样发一行（用于畸形输入），不等待配对。 */
    sendRaw(line) { child.stdin.write(line) },
    /** 等下一帧（不管 id）。 */
    nextFrame(timeoutMs = 15_000) {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待帧超时')), timeoutMs)
        waiters.push((frame) => { clearTimeout(timer); resolve(frame) })
      })
    },
    /** 结束 stdin 并等进程真的退出；返回退出码（超时则 kill 并返回 null）。 */
    async endAndWait(timeoutMs = 15_000) {
      child.stdin.end()
      const exited = Promise.race([
        once(child, 'exit').then(([code, signal]) => ({ code, signal })),
        new Promise((r) => setTimeout(() => r(null), timeoutMs)),
      ])
      const r = await exited
      if (r === null) { try { child.kill('SIGKILL') } catch { /* 已死 */ } return null }
      return r
    },
  }
}

describe('腿 2 · 桌面端（真后台进程与真壳页面）', () => {
  let bridge

  before(() => {
    assert.ok(existsSync(BRIDGE), `桌面后台入口应存在：${BRIDGE}`)
    bridge = startBridgeProcess()
  })

  after(async () => {
    if (!bridge) return
    try { bridge.child.stdin.end() } catch { /* 已关 */ }
    await new Promise((r) => setTimeout(r, 200))
    if (bridge.child.exitCode === null) { try { bridge.child.kill('SIGKILL') } catch { /* 已死 */ } }
  })

  it('① 真 bridge 进程应答 status（协议两端真的对得上）', async () => {
    const frame = await bridge.request('status')
    assert.equal(frame.version, 1, '回执应带协议版本')
    assert.equal(frame.type, 'result', '回执类型应为 result')
    assert.equal(frame.ok, true, `status 应成功：${JSON.stringify(frame)}`)
    // 进程还没有被要求启动服务，所以这里**如实**是 unavailable —— 不把它读成失败。
    assert.ok(['unavailable', 'ready', 'degraded', 'starting'].includes(frame.payload.state),
      `state 应是已知档位之一，实际 ${JSON.stringify(frame.payload.state)}`)
    assert.ok(Array.isArray(frame.payload.processes), 'processes 应是数组')
  })

  it('② 畸形请求被具名拒绝（协议是对外唯一控制通道）', async () => {
    const cases = [
      { raw: 'not json\n', code: 'BAD_JSON' },
      { raw: '{"version":2,"id":"x","type":"status","payload":{}}\n', code: 'BAD_VERSION' },
      { raw: '{"version":1,"id":"bad id!","type":"status","payload":{}}\n', code: 'BAD_ID' },
      { raw: '{"version":1,"id":"y","type":"nope","payload":{}}\n', code: 'UNKNOWN_TYPE' },
      { raw: '{"version":1,"id":"z","type":"status"}\n', code: 'BAD_PAYLOAD' },
    ]
    for (const c of cases) {
      bridge.sendRaw(c.raw)
      const frame = await bridge.nextFrame()
      assert.equal(frame.ok, false, `${c.code} 应被拒绝，实际 ${JSON.stringify(frame)}`)
      assert.equal(frame.payload?.code, c.code, `拒绝理由应具名为 ${c.code}，实际 ${JSON.stringify(frame.payload)}`)
    }
  })

  it('③ 超长单行被拒（不许把内存吃光再报错）', async () => {
    // `MAX_LINE_BYTES` 是 64 KiB（desktop-protocol.mjs:2）。发一行明显超限的。
    bridge.sendRaw(`${'x'.repeat(70 * 1024)}\n`)
    const frame = await bridge.nextFrame()
    assert.equal(frame.ok, false, '超长行应被拒绝')
    assert.equal(frame.payload?.code, 'LINE_TOO_LARGE', `实际 ${JSON.stringify(frame.payload)}`)
  })

  it('④ 进程生命周期：结束 stdin 后进程**真的**退出', async () => {
    // 为什么单独一条：`main.mjs` 的退出事务要求"桥真的退出了"才 `app.quit()`
    // （`main.test.mjs:33-43` 用假 bridge 测过这条**逻辑**），
    // 但"真进程会不会退"是另一个事实——一个卡住不退的 bridge 会让桌面端永远关不掉。
    const r = await bridge.endAndWait()
    assert.ok(r !== null, '结束 stdin 后 bridge 进程应在超时内退出（否则桌面端关不掉）')
    assert.equal(r.code, 0, `bridge 退出码应为 0，实际 code=${r.code} signal=${r.signal}`)
    bridge = null
  })
})

// ── 壳页面（需要浏览器；与上面共用同一套 SKIP 纪律）─────────────────────────
const probe = probeBrowser()
const describeBrowser = probe ? describe : describe.skip
if (!probe) {
  console.log('[skip] 未找到可用浏览器（Edge/Chrome），腿 2 的壳页面部分跳过。')
}

describeBrowser('腿 2b · 桌面壳启动页（真浏览器渲染）', () => {
  let session

  before(async () => {
    // 按需 import，避免没有浏览器时也加载基座。
    const { launchBrowser } = await import('../../scripts/e2e/cdp.mjs')
    const browser = await launchBrowser({ headless: true, width: 1180, height: 800 })
    const page = await browser.newPage()
    // 注入一个与 `preload.cjs` **同形**的替身：真实桌面里由 preload 提供它，
    // 而这里没有 Electron。替身的形状来自 `desktop/main.mjs:223-288` 的
    // `legion:command` 允许清单（8 个命令）。
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.legion = {
          command: async () => ({ ok: false, code: 'E2E_STUB' }),
          onState: () => () => {},
          onCommand: () => {},
        };
      `,
    })
    session = { browser, page, close: async () => { await page.close(); await browser.close() } }
  })

  after(async () => { if (session) await session.close() })

  it('⑤ 启动页渲染出「正在启动」这一屏（服务就绪前用户唯一看到的东西）', async () => {
    const { page } = session
    await page.goto(new URL(`file:///${STARTUP.replace(/\\/g, '/')}`).href)
    const heading = await page.text('#heading')
    assert.ok(heading && heading.length > 0, `#heading 应有启动文案，实际 ${JSON.stringify(heading)}`)
    const detail = await page.text('#detail')
    assert.ok(detail !== null, '#detail 应存在（它是 aria-live 状态行）')
    // 进度条与操作区：初始应隐藏（启动中不该给用户"重试/停止"按钮）。
    const actionsHidden = await page.evaluate(() => document.querySelector('#actions')?.hasAttribute('hidden'))
    assert.equal(actionsHidden, true, '启动中 #actions 应是隐藏的')
    const setupHidden = await page.evaluate(() => document.querySelector('#setup')?.hasAttribute('hidden'))
    assert.equal(setupHidden, true, '未进入设置流程时 #setup 应是隐藏的')
  })
})

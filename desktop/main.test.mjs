import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createInteractiveMarker, BRIDGE_DEADLINES, canNavigate, closeAction, createBridgeClient, desktopRequestHeaders, externalUrl, workbenchTarget } from './runtime.mjs'
import { failureMessage, portConflictMessage } from './messages.mjs'

function fakeBridge() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  const sent = []
  child.stdin.on('data', chunk => sent.push(JSON.parse(String(chunk))))
  return { child, sent }
}

test('request deadline clears its slot; a late reply cannot resolve another request', { timeout: 1000 }, async () => {
  const { child, sent } = fakeBridge()
  const client = createBridgeClient(child, { deadlines: { status: 10 }, maxPending: 1 })
  const expired = client.request('status')
  await assert.rejects(client.request('status'), { code: 'BRIDGE_BUSY' })
  await assert.rejects(expired, { code: 'BRIDGE_TIMEOUT' })
  const next = client.request('status')
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'result', id: sent[0].id, ok: true, payload: { old: true } })}\n`)
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'result', id: sent[1].id, ok: true, payload: { current: true } })}\n`)
  assert.deepEqual(await next, { current: true })
  child.emit('exit', 0)
})

test('stop acknowledgement and ending stdin do not prove bridge exit', async () => {
  const { child, sent } = fakeBridge()
  const client = createBridgeClient(child, { exitTimeoutMs: 15 })
  const stop = client.request('stop')
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'result', id: sent[0].id, ok: true, payload: { state: 'stopped' } })}\n`)
  await stop
  await assert.rejects(client.close(), { code: 'BRIDGE_EXIT_TIMEOUT' })
  await assert.rejects(client.request('start'), { code: 'BRIDGE_CLOSING' })
  child.emit('exit', 0)
  await client.close()
})

test('malformed transport rejects requests but shutdown still waits for actual process exit', async () => {
  const { child } = fakeBridge()
  const client = createBridgeClient(child, { exitTimeoutMs: 10 })
  const pending = client.request('status')
  child.stdout.write('not-json\n')
  await assert.rejects(pending, { code: 'BRIDGE_PROTOCOL_ERROR' })
  await assert.rejects(client.close(), { code: 'BRIDGE_EXIT_TIMEOUT' })
  child.emit('exit', 1)
  await assert.rejects(client.close(), { code: 'BRIDGE_EXIT_FAILED' })
})

test('window allows only bundled startup page and the verified Workbench origin', () => {
  const startup = 'file:///C:/Program%20Files/Legion/startup.html'
  const origin = 'http://127.0.0.1:5173'
  assert.equal(canNavigate(startup, { startup, origin }), true)
  assert.equal(canNavigate(`${origin}/tasks`, { startup, origin }), true)
  for (const url of ['http://evil.test/', 'http://localhost:5173/', 'http://user@127.0.0.1:5173/', 'file:///C:/Windows/system.ini', 'javascript:alert(1)']) {
    assert.equal(canNavigate(url, { startup, origin }), false, url)
  }
  assert.equal(externalUrl('https://example.org/docs'), 'https://example.org/docs')
  assert.equal(externalUrl('file:///C:/Windows/system.ini'), null)
})

test('workbench target exists only after verified service status', () => {
  assert.equal(workbenchTarget({ state: 'ready', workbenchUrl: 'http://127.0.0.1:5173' }), 'http://127.0.0.1:5173')
  assert.equal(workbenchTarget({ state: 'unavailable', workbenchUrl: 'http://127.0.0.1:5173' }), null)
  assert.equal(workbenchTarget({ state: 'ready', workbenchUrl: 'http://evil.test' }), null)
  assert.equal(closeAction({ quitting: false, closeToTray: true }), 'hide')
  assert.equal(closeAction({ quitting: true, closeToTray: true }), 'close')
})

test('bridge client correlates request and rejects pending work when child dies', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  const sent = []
  child.stdin.on('data', (chunk) => sent.push(JSON.parse(String(chunk))))
  const client = createBridgeClient(child)
  const first = client.request('status')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'status')
  child.stdout.write(`${JSON.stringify({ version: 1, id: sent[0].id, type: 'result', ok: true, payload: { state: 'ready' } })}\n`)
  assert.equal((await first).state, 'ready')
  const pending = client.request('start', { token: 'private-test-token' })
  assert.equal(sent[1].payload.token, 'private-test-token')
  child.emit('exit', 1)
  await assert.rejects(pending, { code: 'BRIDGE_EXITED' })
  await assert.rejects(client.request('status'), { code: 'BRIDGE_EXITED' })
})

test('bridge client forwards only validated port conflict context', async () => {
  const { child, sent } = fakeBridge()
  const client = createBridgeClient(child)
  const pending = client.request('start')
  child.stdout.write(`${JSON.stringify({ version: 1, id: sent[0].id, type: 'result', ok: false, payload: {
    code: 'PORT_IN_USE', portConflict: { process: 'workbench', port: 5173, listening: true, secret: 'drop-this' },
  } })}\n`)
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'PORT_IN_USE')
    assert.deepEqual(error.portConflict, { process: 'workbench', port: 5173, listening: true })
    assert.equal(error.portConflict.secret, undefined)
    return true
  })
  child.emit('exit', 0)
})

test('sandbox-compatible preload exposes only the startup command allowlist', async () => {
  let exposed
  const calls = []
  const filename = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, api) { exposed = api } },
      ipcRenderer: { invoke(_channel, command) { calls.push(command); return Promise.resolve(command) }, on() {}, removeListener() {} },
    }),
  })
  assert.deepEqual(Object.keys(exposed).sort(), ['chooseWorkspace', 'configureIdentity', 'configureModel', 'configureWorkspace', 'onState', 'retry', 'status', 'stop'])
  assert.equal(await exposed.retry(), 'retry')
  assert.deepEqual(calls, ['retry'])
})

test('startup failure identifies missing execution identity instead of blaming the network', () => {
  assert.equal(failureMessage('ENFORCEMENT_IDENTITY_MISSING'), '缺少执行身份配置，请完成首次设置。')
})

test('★★★ 升级期间被挡下的启动：说"正在升级"，不说"无法启动"，也不给错误代码', () => {
  // 这两个码来自 `barrier.mjs` 的 `startupGate`，意思是"有一次升级正在进行
  // 或尚未收尾"——一个**正常的、会自己结束**的状态。
  //
  // 在此之前它们不在 `remedies` 表里，于是落到兜底「请查看诊断信息后重试。」，
  // 显示在「Legion 暂时无法启动」之下。也就是说：用户在一次正常升级进行中
  // 重新打开 Legion，看到的是"这个软件坏了"。
  //
  //   > 一个"看起来像故障"的正常状态，会换来用户针对故障才该做的处置——
  //   > 重装、删数据目录、联系管理员，而其中任何一个都可能把升级弄坏。
  for (const code of ['UPDATE_MAINTENANCE', 'UPDATE_TRANSACTION_UNFINISHED']) {
    const message = failureMessage(code)
    assert.notEqual(message, '请查看诊断信息后重试。', `${code} 落到了兜底文案（表里没有它）`)
    assert.match(message, /升级|维护/, `${code} 的文案没有说明"这是升级/维护"：${message}`)
    // ★ 必须说"稍候/等待"：用户唯一该做的动作是等，而不是修。
    assert.match(message, /稍候|等待/, `${code} 的文案没有让用户等：${message}`)
  }
  // 最危险的那一条要明确劝阻删数据目录（`adviceFor('recovery-required')` 的意图）。
  assert.match(failureMessage('UPDATE_TRANSACTION_UNFINISHED'), /不要.*删除数据目录/)
})

/**
 * 在 VM 里跑 `startup.mjs`，拿到它真正的 `render`。
 *
 * `startup.mjs` 是一个**浏览器脚本**（模块作用域里就 `querySelector` 并订阅
 * `window.legion`），所以它在 Node 里 import 不进来。给它一套最小的 DOM 替身
 * 之后，`render` 会注册到 `window.legion.onState` 上，于是断言可以打在
 * **真正渲染出来的文案**上，而不是源码字符串上。
 *
 * 源码文本断言在这里是不够的：`heading.textContent = false ? '正在升级' : …`
 * 里那个字符串仍然在文件里，而用户看到的是"无法启动"。
 *
 * ★ 它的 `import { failureMessage, … } from './messages.mjs'` 被剥掉，
 *   改由 VM 上下文注入**真正的**那两个函数——注入替身会让文案断言失去意义。
 */
function renderStartup() {
  const elements = new Map()
  const makeElement = (selector) => {
    const node = {
      selector, textContent: '', hidden: false, disabled: false, listeners: {},
      addEventListener(type, fn) { node.listeners[type] = fn },
      querySelector: () => makeElement(`${selector} > *`),
      reset() {},
    }
    elements.set(selector, node)
    return node
  }
  let render = null
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'startup.mjs'), 'utf8')
    .replace(/^import .*$/m, '')
  const context = {
    document: { querySelector: (selector) => elements.get(selector) ?? makeElement(selector) },
    window: {
      legion: {
        onState: (fn) => { render = fn },
        status: () => Promise.resolve(null), retry: () => {}, stop: () => {},
      },
    },
    // 真的那两个函数，不是替身。
    failureMessage, portConflictMessage,
    FormData: class { get() { return null } },
    console,
  }
  runInNewContext(source, context)
  return { render, elements }
}

test('★★★ 升级期间的启动拒绝渲染成"正在升级"，而不是"无法启动"', () => {
  for (const code of ['UPDATE_MAINTENANCE', 'UPDATE_TRANSACTION_UNFINISHED']) {
    const { render, elements } = renderStartup()
    assert.equal(typeof render, 'function', 'startup.mjs 没有注册 render')
    render({ state: 'failed', code })
    const heading = elements.get('#heading').textContent
    const detail = elements.get('#detail').textContent
    assert.equal(heading, 'Legion 正在升级', `${code} 的标题是「${heading}」`)
    // ★ 正文里**不该**出现错误代码：那串码只对排查故障的人有意义，而这里
    //   不是故障。出现了就意味着它落到了通用失败分支。
    assert.equal(detail.includes(code), false, `${code} 的正文里出现了错误代码：${detail}`)
    assert.match(detail, /稍候|等待/, `${code} 的正文没有让用户等：${detail}`)
    // ★ 不显示进度条：一条不动的进度条读起来是"卡住了"。
    assert.equal(elements.get('#progress').hidden, true, `${code} 显示了进度条`)
    // ★ 但动作区要留着：升级可能刚好做完了，重试是用户唯一该做的事。
    assert.equal(elements.get('#actions').hidden, false, `${code} 把动作区藏起来了（用户没法重试）`)
  }
})

test('★ 真正的故障仍然说"无法启动"并给出错误代码', () => {
  // 反向对照：上面那条不能是靠"什么状态都显示正在升级"通过的。
  const { render, elements } = renderStartup()
  render({ state: 'failed', code: 'PORT_IN_USE' })
  assert.equal(elements.get('#heading').textContent, 'Legion 暂时无法启动')
  assert.match(elements.get('#detail').textContent, /PORT_IN_USE/)
})

test('★★★ 协议里的每个命令都在期限表里有上限（漏一个 = 它立刻超时）', () => {
  // ★ 取值的写法是 `deadlines[type] ?? BRIDGE_DEADLINES[type]`，而把
  //   `undefined` 交给 `setTimeout` 是 **0 毫秒**——不是在"没有上限"与
  //   "用默认值"之间选，而是**立刻超时**。
  //
  //   所以"加一个命令、忘了加期限"的表现是：那条命令永远返回 `BRIDGE_TIMEOUT`，
  //   而排查会从"Launcher 卡住了"开始——离真正的原因（少一行表项）很远。
  //
  //   这条判据拿**协议的类型表**逐个问期限表，让"加命令"这件事不能只改一半。
  const protocolSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'product', 'launcher', 'desktop-protocol.mjs'), 'utf8')
  const match = protocolSource.match(/const TYPES = new Set\(\[([\s\S]*?)\]\)/)
  assert.notEqual(match, null, '没有从协议源码里认出 TYPES（正则过期了？）')
  const types = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(types.length >= 10, `协议类型表看起来是空的：${JSON.stringify(types)}`)
  const missing = types.filter((t) => !(t in BRIDGE_DEADLINES))
  assert.deepEqual(missing, [], `这些命令没有期限，会立刻超时：${missing.join(', ')}`)
  // 每一项都必须是正的有限数（`0` 与 `NaN` 同样是"立刻超时"）。
  for (const [type, ms] of Object.entries(BRIDGE_DEADLINES)) {
    assert.ok(Number.isFinite(ms) && ms > 0, `${type} 的期限是 ${ms}`)
  }
})

test('★★ 后台的拒绝必须把它的中文说明带到用户面前', async () => {
  // `desktop-bridge.mjs` 每个 `ok: false` 的 payload 里都有 `reason`，
  // 而 `runtime.mjs` 原先只取 `code`、把那句话丢掉——用户看到的是一串
  // 大写内部码，而写那句话的人本来是为了让他看懂。
  //
  //   > 一条被丢掉的错误解释，与一条从来没写过的错误解释，
  //   > 在用户那一端是同一个东西。
  const { child, sent } = fakeBridge()
  const client = createBridgeClient(child, { deadlines: { status: 1000 } })
  const promise = client.request('status', {})
  // 让后台回一条拒绝（带中文 reason）。`child.stdout` 是客户端读的那一端，
  // 所以往它**写**一行就是"后台回了一条消息"。
  await new Promise((resolve) => setImmediate(resolve))
  const request = sent.at(-1)
  child.stdout.write(JSON.stringify({
    version: 1, id: request.id, type: 'result', ok: false,
    payload: { code: 'CLAIM_CONTROL_UNAVAILABLE', reason: '共享后台不由桌面端管理' },
  }) + '\n')
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'CLAIM_CONTROL_UNAVAILABLE')
    assert.equal(error.reason, '共享后台不由桌面端管理')
    assert.match(error.message, /共享后台不由桌面端管理/, '中文说明没有出现在错误信息里')
    return true
  })
})

test('port conflict help names the service and port and rejects untrusted detail', () => {
  assert.equal(portConflictMessage({ process: 'team-hub', port: 8787, listening: true }),
    'team-hub 数据服务需要端口 8787，已有进程正在监听。\n'
      + 'PowerShell 查看占用：Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalPort,OwningProcess')
  assert.equal(portConflictMessage({ process: 'unknown', port: 8787, listening: true }), '')
  assert.equal(portConflictMessage({ process: 'runtime', port: '8787', listening: true }), '')
})

test('desktop credential belongs only to the owned main frame and verified origin', () => {
  const origin = 'http://127.0.0.1:5173'
  const owner = { origin, token: 'private-test-token', webContentsId: 7 }
  const request = { url: `${origin}/api/fs/home`, webContentsId: 7, resourceType: 'xhr',
    frame: { parent: null, url: `${origin}/tasks` }, requestHeaders: { Accept: 'application/json' } }
  assert.equal(desktopRequestHeaders(request, owner).Authorization, 'Bearer private-test-token')
  for (const details of [
    { ...request, webContentsId: 8 },
    { ...request, url: 'https://evil.test/api' },
    { ...request, frame: { parent: {}, url: `${origin}/tasks` } },
    { ...request, frame: null },
    { ...request, frame: { parent: null, url: 'https://evil.test/' } },
    { ...request, requestHeaders: { Origin: 'https://evil.test' } },
    { ...request, resourceType: 'subFrame' },
  ]) assert.equal(desktopRequestHeaders(details, owner).Authorization, undefined)
  assert.equal(desktopRequestHeaders(request, { ...owner, origin: null }).Authorization, undefined)
  assert.equal(desktopRequestHeaders({ ...request, resourceType: 'mainFrame', frame: { parent: null, url: 'file:///startup.html' } }, owner).Authorization, 'Bearer private-test-token')
})

// ---------------------------------------------------------------------------
// ★★★★ 「桌面可交互」一次性标记：**投递失败不许消费标记**
// ---------------------------------------------------------------------------

test('★★★★ 运行时还没装载时标记不许被消费（否则首次自动检查永远不开始）', () => {
  // ★★ 设计 §6 line 132：「启动达到桌面可交互状态后延迟 30～90 秒首次检查」。
  //
  //   启动顺序是
  //
  //     app.whenReady() → createWindow() → createTray() → startUpdateRuntime()
  //
  //   而 `ready-to-show`（窗口真的画出来）与 `resolveUpdateRuntime()` 都要等
  //   异步，**谁先到不确定**。原来的写法是
  //
  //     let marked = false
  //     function markUpdateInteractive() {
  //       if (marked) return
  //       marked = true                                   // ← 先置位
  //       try { updateRuntime?.markInteractive?.() } catch {}   // ← 再投递
  //     }
  //
  //   于是"窗口先到"那一次：`marked` 被置为 `true`，而投递是一个**空操作**
  //   （可选链把 `null` 吃掉）。运行时随后装载完成，**再也没有人来标记**。
  //
  //   > 一次**被空操作消费掉**的一次性标记，与一次从来没发生过的标记，
  //   > 在用户那一端是同一件事：**自动检查永远不会开始**。
  //
  //   而它是竞态：开发模式下窗口加载慢（Vite dev server）走的是"运行时先到"
  //   那条路，打包之后本地文件加载快就可能中招——**同一份代码，两种行为**。
  let runtime = null
  const mark = createInteractiveMarker({ readRuntime: () => runtime })

  // ── ① 窗口先到：运行时还没有 ⇒ 标记**不许**被消费 ──
  const first = mark()
  assert.equal(first.delivered, false, '运行时还没装载，却报告"已投递"')
  assert.equal(first.alreadyDelivered, false)
  assert.match(first.reason, /还未装载/)

  // ── ② 运行时装载完成 → 补投必须成功（这就是修法的那一半）──
  let marked = 0
  runtime = { ok: true, markInteractive: () => { marked += 1 } }
  const second = mark()
  assert.equal(second.delivered, true, `补投没有成功：${second.reason}`)
  assert.equal(second.alreadyDelivered, false)
  assert.equal(marked, 1, `底层 markInteractive 被调了 ${marked} 次，应当是 1 次`)

  // ── ③ 之后必须**幂等**：窗口那次再来一遍不许重复投递 ──
  const third = mark()
  assert.equal(third.delivered, true)
  assert.equal(third.alreadyDelivered, true, '第二次投递应当自报 alreadyDelivered')
  assert.equal(marked, 1, `幂等被破坏：底层被调了 ${marked} 次`)
})

test('★★★★ 运行时先到：窗口那次正常投递，装载后的补投是幂等空操作', () => {
  // ★ 竞态的**另一个方向**。两个方向都必须得到同一个结果（首次检查被安排），
  //   所以这条与上一条是一对——只测一个方向的话，"补投"这件事可能被写成
  //   "重复标记"，而重复标记会让计时被重置（首次延迟从第二次调用重新算）。
  let marked = 0
  const runtime = { ok: true, markInteractive: () => { marked += 1 } }
  const mark = createInteractiveMarker({ readRuntime: () => runtime })

  const windowFirst = mark()
  assert.equal(windowFirst.delivered, true)
  assert.equal(marked, 1)

  const afterLoad = mark()
  assert.equal(afterLoad.delivered, true)
  assert.equal(afterLoad.alreadyDelivered, true)
  assert.equal(marked, 1, '装载后的补投重复标记了 —— 首次延迟会被重新计时')
})

test('★★ 运行时不可用 / 没有 markInteractive / 投递抛错：都不消费标记', () => {
  // ★ 三种"投递不成"的形状都要**留着标记**，因为调用方还有下一次机会
  //   （面板打开时会再投一次）。一次抛错不该让自动检查永久失效。
  const cases = [
    [{ ok: false, reason: '没有配置更新地址' }, /不可用/, '运行时 ok !== true'],
    [{ ok: true }, /没有 markInteractive/, '运行时缺 markInteractive'],
    [{ ok: true, markInteractive: () => { throw new Error('boom') } }, /抛错/, '投递抛错'],
  ]
  for (const [runtime, pattern, label] of cases) {
    const mark = createInteractiveMarker({ readRuntime: () => runtime })
    const first = mark()
    assert.equal(first.delivered, false, `${label}：被报告成"已投递"`)
    assert.match(first.reason, pattern, `${label}：理由不对（${first.reason}）`)
    // ★ 再投一次必须**还是** delivered:false（标记没被消费掉）。
    //   "标记还在"这件事更强的那一半（换一个好的运行时就投得进去）由下一条覆盖。
    const again = mark()
    assert.equal(again.delivered, false, `${label}：第二次投递竟然成功了（标记状态不对）`)
  }
})

test('★★ 投递抛错之后，换一个好的运行时**仍然能**投递（标记没被吃掉）', () => {
  // ★ 上一条只证明了"第一次报告 delivered:false"。这一条证明**标记还在**：
  //   把 readRuntime 换成一个好的运行时，同一个 marker 必须能投递成功。
  //   没有这一条，"不消费标记"这个结论只停留在返回值上。
  let current = { ok: true, markInteractive: () => { throw new Error('第一次抛错') } }
  let marked = 0
  const mark = createInteractiveMarker({ readRuntime: () => current })

  const failed = mark()
  assert.equal(failed.delivered, false)
  assert.match(failed.reason, /抛错/)

  current = { ok: true, markInteractive: () => { marked += 1 } }
  const retry = mark()
  assert.equal(retry.delivered, true, `抛错之后再也投不进去了：${retry.reason}`)
  assert.equal(retry.alreadyDelivered, false, '这一次应当是**真的**投递，不是幂等空操作')
  assert.equal(marked, 1)
})

test('★ `createInteractiveMarker` 缺 readRuntime 时明确报错（不是静默的空操作）', () => {
  assert.throws(() => createInteractiveMarker({}), /readRuntime/)
  assert.throws(() => createInteractiveMarker(), /readRuntime/)
})

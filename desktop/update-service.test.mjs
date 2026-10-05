// desktop/update-service.test.mjs
// ============================================================================
// 更新 IPC 面的回归 —— 设计 §7 那张"有界操作"表
//
// 这些用例全部**不需要 Electron**：被测的是命令白名单、输入校验、来源校验
// 与状态脱敏投影。这四件事恰恰是"暴露面"的全部内容，所以它们必须能在
// 普通 CI 里跑——而不是靠"启动一次桌面端看一眼"。
//
// `update-service.mjs` 之所以把 `electron` 延迟导入，就是为了这一条。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UPDATE_COMMANDS, UPDATE_STATE_CHANNEL, createUpdateService, projectState, validateOperationInput, validateTargetInput,
} from './update-service.mjs'

const DIGEST = 'a'.repeat(64)
const RELEASE = 'rel-1.1.0'

/** 一个最小的客户端替身：记录调用，返回可控结果。 */
function createFakeClient({ state = 'available', usable = true, installResult = { ok: true } } = {}) {
  const calls = []
  let current = {
    state, usable, unavailableReason: usable ? null : '没有配置更新地址',
    channel: 'stable', currentVersion: '1.0.0', releaseId: RELEASE,
    productVersion: '1.1.0', manifestDigest: DIGEST, identityLabel: `${RELEASE}@1.1.0#aaaa`,
    ready: state === 'ready', progress: null, lastCheck: null, lastError: null,
    operationId: state === 'downloading' ? 3 : null, snoozedUntilMs: null,
    needsInstallApproval: false,
    // 刻意塞进两个"凭据类"字段：投影必须把它们挡在外面。
    workbenchToken: 'secret-token', hostUrl: 'https://updates.example.com/legion',
  }
  const listeners = new Set()
  return {
    calls,
    subscribe(listener) { listeners.add(listener); listener(current); return () => listeners.delete(listener) },
    snapshot: () => current,
    setState(patch) { current = { ...current, ...patch }; for (const l of listeners) l(current) },
    state: () => current.state,
    async check(options) { calls.push(['check', options]); return { outcome: 'available', candidate: { releaseId: RELEASE, manifestSha256: DIGEST } } },
    async download(releaseId, manifestDigest, options) {
      calls.push(['download', { releaseId, manifestDigest, options }])
      return { ok: true, code: null, reason: null, reused: false, path: 'C:\\cache\\pkg.zip' }
    },
    cancelDownload(operationId) { calls.push(['cancelDownload', operationId]); return { ok: true, code: null, reason: null, operationId: operationId ?? 3 } },
    async install(releaseId, manifestDigest, options) {
      calls.push(['install', { releaseId, manifestDigest, pendingTasks: options?.pendingTasks }])
      return installResult
    },
    snooze() { calls.push(['snooze']); return { ok: true, snoozedUntilMs: 1, releaseId: RELEASE } },
    shouldNotify: () => false,
  }
}

/** 一个能通过来源校验的事件替身。 */
function allowedEvent(service) {
  const contents = { mainFrame: { url: 'file:///C:/legion/desktop/update.html' } }
  const panel = { webContents: contents, isDestroyed: () => false, show() {}, focus() {} }
  // 让 service 认为面板就是这一个。
  service.__testPanel = panel
  return { sender: contents, senderFrame: contents.mainFrame }
}

/**
 * 建立一个"面板已打开"的服务。
 *
 * `createPanel` 是注入的，所以这里能精确控制"哪个 BrowserWindow 是面板"
 * 以及它的 URL——来源校验的判据因此可以被逐条驱动。
 *
 * ★ 必须 `await service.showPanel()`：在面板真的打开之前，来源校验对
 *   **所有**调用都是拒绝的（`panel === null`）。这一点本身就是一条判据，
 *   由「面板尚未打开时 → 拒绝」那个用例覆盖。
 */
async function setupService({
  client = createFakeClient(), panelUrl = 'file:///C:/legion/desktop/update.html', readTasks = null,
} = {}) {
  const contents = {
    mainFrame: { url: panelUrl }, id: 42, send() {},
  }
  const panel = {
    webContents: contents, isDestroyed: () => false, show() {}, focus() {}, on() {}, close() {},
  }
  const service = createUpdateService({
    client,
    desktopDir: 'C:\\legion\\desktop',
    createPanel: () => ({ window: panel, url: panelUrl, ready: Promise.resolve() }),
    ...(readTasks === null ? {} : { readTasks }),
  })
  await service.showPanel()
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { service, client, event, contents }
}

// ---------------------------------------------------------------------------
// ① 命令白名单
// ---------------------------------------------------------------------------

test('未知命令被拒绝：没有通用入口可以越权', async () => {
  const { service, event } = await setupService()
  for (const command of ['update.fetch', 'update.shell', 'update.exec', 'legion:command', '__proto__', '']) {
    const result = await service.dispatch(command, {}, event)
    assert.equal(result.ok, false, `命令 ${command} 被接受了`)
    assert.equal(result.code, 'UPDATE_IPC_UNKNOWN_COMMAND')
  }
})

test('暴露的命令恰好是设计 §7 那张表（+ 一个只读的 update.tasks）', async () => {
  // 设计 §7 line 152 列了 5 条（status/check 算一条、download、
  // cancelDownload、install、subscribe），加上 snooze。
  //
  // `update.tasks` 是**本实现新增**的一条，理由要写在这里：设计 §7 line 150
  // 要求「安装确认显示是否有在途任务」，而那张表里没有一条命令能取到这个
  // 读数（快照里也没有它）。它是**无参数**的只读命令，返回主进程自己读到的
  // 读数——所以它不扩大"渲染进程能做什么"这个面。
  assert.deepEqual([...UPDATE_COMMANDS], [
    'update.status', 'update.check', 'update.tasks',
    'update.download', 'update.cancelDownload', 'update.install', 'update.snooze',
  ])
  // ★ 没有"传我一个 URL / 路径"的入口。
  for (const command of UPDATE_COMMANDS) {
    assert.equal(/fetch|url|path|exec|shell|spawn|open/.test(command), false, `${command} 看起来像是一个能越权的入口`)
  }
})

// ---------------------------------------------------------------------------
// ② 来源校验
// ---------------------------------------------------------------------------

test('来源不是面板 → 拒绝，且不执行任何动作', async () => {
  const { service, client, event } = await setupService()
  const foreign = { sender: { mainFrame: { url: 'https://evil.example/x.html' } }, senderFrame: { url: 'https://evil.example/x.html' } }
  const result = await service.dispatch('update.download', { releaseId: RELEASE, manifestDigest: DIGEST }, foreign)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UPDATE_IPC_FORBIDDEN')
  assert.equal(client.calls.length, 0, '来源不可信时仍然执行了动作')
  // 而同一个服务对合法的来源仍然工作。
  const ok = await service.dispatch('update.status', {}, event)
  assert.equal(ok.ok, true)
})

test('来源是面板里的子框架 → 拒绝（子框架的 URL 可能被重定向）', async () => {
  const { service, event, contents } = await setupService()
  const subFrame = { url: 'file:///C:/legion/desktop/update.html' }
  const result = await service.dispatch('update.check', {}, { sender: contents, senderFrame: subFrame })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UPDATE_IPC_FORBIDDEN')
  // 合法来源仍然可用（避免"顺手把所有人挡掉"也算通过）。
  assert.equal((await service.dispatch('update.check', {}, event)).ok, true)
})

test('面板尚未打开时 → 拒绝', async () => {
  const client = createFakeClient()
  const service = createUpdateService({ client, desktopDir: 'C:\\legion\\desktop', createPanel: () => { throw new Error('不该被调用') } })
  const result = await service.dispatch('update.status', {}, { sender: {}, senderFrame: { url: 'file:///x.html' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UPDATE_IPC_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// ③ 输入校验：没有 URL、路径、shell 参数
// ---------------------------------------------------------------------------

test('★ 目标输入只接受 releaseId + manifestDigest：路径与 URL 一律拒绝', () => {
  const good = validateTargetInput({ releaseId: RELEASE, manifestDigest: DIGEST })
  assert.equal(good.ok, true)
  const bad = [
    { releaseId: RELEASE, manifestDigest: DIGEST, path: 'C:\\Windows\\System32\\cmd.exe' },
    { releaseId: RELEASE, manifestDigest: DIGEST, url: 'https://evil.example/x.zip' },
    { releaseId: RELEASE, manifestDigest: DIGEST, args: ['/c', 'calc'] },
    { releaseId: '../../escape', manifestDigest: DIGEST },
    { releaseId: 'rel/../..', manifestDigest: DIGEST },
    { releaseId: RELEASE, manifestDigest: DIGEST.toUpperCase() },
    { releaseId: RELEASE, manifestDigest: 'zz'.repeat(32) },
    { releaseId: RELEASE },
    { manifestDigest: DIGEST },
    { releaseId: 1, manifestDigest: DIGEST },
    null,
    [],
    'update',
  ]
  for (const payload of bad) {
    const result = validateTargetInput(payload)
    assert.equal(result.ok, false, `非法输入被接受：${JSON.stringify(payload)}`)
  }
})

test('取消输入只接受正整数 operationId', () => {
  assert.equal(validateOperationInput({ operationId: 3 }).ok, true)
  assert.equal(validateOperationInput({}).operationId, null)
  for (const payload of [{ operationId: 0 }, { operationId: -1 }, { operationId: 1.5 }, { operationId: '3' }, { operationId: 3, path: 'x' }]) {
    assert.equal(validateOperationInput(payload).ok, false, `非法取消输入被接受：${JSON.stringify(payload)}`)
  }
})

test('下载命令把输入原样交给客户端（并为身份绑定留下完整目标）', async () => {
  const { service, client, event } = await setupService()
  const result = await service.dispatch('update.download', { releaseId: RELEASE, manifestDigest: DIGEST }, event)
  assert.equal(result.ok, true)
  assert.deepEqual(client.calls[0], ['download', { releaseId: RELEASE, manifestDigest: DIGEST, options: undefined }])
})

test('下载命令的非法输入在**到达客户端之前**就被拒', async () => {
  const { service, client, event } = await setupService()
  const result = await service.dispatch('update.download', { releaseId: RELEASE, manifestDigest: DIGEST, path: 'C:\\evil.exe' }, event)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UPDATE_IPC_BAD_INPUT')
  assert.equal(client.calls.length, 0)
})

// ---------------------------------------------------------------------------
// ④ 状态投影是白名单
// ---------------------------------------------------------------------------

test('★ 状态投影不含凭据：白名单而不是原样转发', () => {
  const projected = projectState({
    state: 'downloading', usable: true, channel: 'stable',
    workbenchToken: 'secret-token', hostUrl: 'https://updates.example.com/legion?k=1',
    trustStore: { keys: new Map() }, configPath: 'C:\\legion\\update-config.json',
    progress: { phase: 'downloading', bytes: 100, total: 400, extra: 'nope' },
    lastError: { code: 'net-offline', reason: '无法连接更新服务器。', stack: 'at foo' },
  })
  for (const leak of ['workbenchToken', 'hostUrl', 'trustStore', 'configPath']) {
    assert.equal(Object.hasOwn(projected, leak), false, `投影泄露了 ${leak}`)
  }
  assert.equal(Object.hasOwn(projected.progress, 'extra'), false)
  assert.equal(Object.hasOwn(projected.lastError, 'stack'), false)
  assert.equal(projected.progress.bytes, 100)
  assert.equal(projected.lastError.code, 'net-offline')
})

test('状态投影带出身份的另一半（界面必须能拼出 update.download 的输入）', () => {
  const projected = projectState({ state: 'available', releaseId: RELEASE, manifestDigest: DIGEST })
  assert.equal(projected.releaseId, RELEASE)
  assert.equal(projected.manifestDigest, DIGEST)
  // 不合法的摘要不能流出去：界面拿着它去下载只会被主进程拒。
  assert.equal(projectState({ manifestDigest: 'nope' }).manifestDigest, null)
})

test('订阅推送走 update-state 通道，且推的是投影过的状态', async () => {
  const { service, client } = await setupService()
  const sent = []
  // 打开面板时服务会订阅并在推送时 `send`。用一个能捕获的 contents。
  const captured = createUpdateService({
    client,
    desktopDir: 'C:\\legion\\desktop',
    createPanel: () => ({
      window: {
        webContents: { mainFrame: { url: 'file:///C:/legion/desktop/update.html' }, send: (channel, state) => sent.push([channel, state]) },
        isDestroyed: () => false, show() {}, focus() {}, on() {}, close() {},
      },
      url: 'file:///C:/legion/desktop/update.html',
      ready: Promise.resolve(),
    }),
  })
  await captured.showPanel()
  client.setState({ state: 'ready' })
  assert.ok(sent.length >= 1, '没有推送任何状态')
  assert.equal(sent[0][0], UPDATE_STATE_CHANNEL)
  assert.equal(sent.at(-1)[1].state, 'ready')
  assert.equal(Object.hasOwn(sent.at(-1)[1], 'workbenchToken'), false)
  void service
})

// ---------------------------------------------------------------------------
// ⑤ 不可用时的行为
// ---------------------------------------------------------------------------

test('配置不可用：除 status 之外的命令都明确说不可用，而不是静默失败', async () => {
  const { service, event } = await setupService({ client: createFakeClient({ usable: false }) })
  const status = await service.dispatch('update.status', {}, event)
  assert.equal(status.ok, true, 'status 必须仍然可用——否则界面无法说明为什么不可用')
  assert.equal(status.state.usable, false)
  assert.match(status.state.unavailableReason, /更新地址/)

  for (const command of ['update.check', 'update.download', 'update.install']) {
    const payload = command === 'update.status' ? {} : { releaseId: RELEASE, manifestDigest: DIGEST }
    const result = await service.dispatch(command, payload, event)
    assert.equal(result.ok, false, `${command} 在不可用时仍然执行了`)
    assert.equal(result.code, 'UPDATE_IPC_UNAVAILABLE')
  }
})

// ---------------------------------------------------------------------------
// ⑥ 稍后 / 安装
// ---------------------------------------------------------------------------

test('稍后：转成 snooze，不改变"能不能安装"这件事', async () => {
  const { service, client, event } = await setupService({ client: createFakeClient({ state: 'ready' }) })
  const result = await service.dispatch('update.snooze', {}, event)
  assert.equal(result.ok, true)
  assert.equal(client.calls.at(-1)[0], 'snooze')
})

test('★★ 投影必须带上"稍后针对的是哪一个发行"（漏字段 = 界面永远看不到它）', async () => {
  // ★ 客户端到界面之间有一层**显式的**投影（`projectSnapshot`），
  //   `client.snapshot()` 里的字段不会自动过来。所以每加一个界面要用的字段，
  //   都必须在这层里加一次——而漏掉它的时候，**两边的用例都不会红**：
  //   客户端那一侧的用例看的是客户端的快照，服务这一侧的用例看的是投影，
  //   只有"界面拿不到它"这一件事没人测。
  //
  //   这正是 ⑰ 的形状（算了/校验了，但没有携带到调用方读的那个对象里）。
  const { service, client, event } = await setupService({ client: createFakeClient({ state: 'available' }) })
  // 让替身进入"已对某个发行点过稍后"的状态。
  client.setState({ snoozedUntilMs: Date.now() + 60_000, snoozedReleaseId: RELEASE })
  const reading = service.snapshot()
  assert.equal(reading.snoozedReleaseId, RELEASE,
    '投影把 snoozedReleaseId 丢了：界面无法把"这个发行我已推迟"与"任何发行都别烦我"分开')
  assert.equal(typeof reading.snoozedUntilMs, 'number')
  // 没有稍后过时是 null，不是 undefined（"没推迟过"要能被明确表达）。
  client.setState({ snoozedUntilMs: null, snoozedReleaseId: null })
  assert.equal(service.snapshot().snoozedReleaseId, null)
  void event
})

test('安装：只把身份转交，不转交任何路径', async () => {
  const { service, client, event } = await setupService({ client: createFakeClient({ state: 'ready' }) })
  const result = await service.dispatch('update.install', { releaseId: RELEASE, manifestDigest: DIGEST }, event)
  assert.equal(result.ok, true)
  const [, call] = client.calls.at(-1)
  assert.equal(call.releaseId, RELEASE)
  assert.equal(call.manifestDigest, DIGEST)
})

test('★★ 安装：渲染进程**不可能**提供在途任务读数（它是预检的输入）', async () => {
  // 在途任务读数决定预检的结论：`[]` → ok（放行）、`null` → unknown（拦）。
  // 所以渲染进程若能提供它，就能把"任务正在跑"说成"没有任务"。
  //
  // 实际的防线是 `validateTargetInput` 的**精确字段集**判据
  // （`['manifestDigest','releaseId']`，多一个字段就拒）。这一条把那条
  // 防线与它的**目的**连起来：光说"多字段被拒"看不出为什么不能多。
  const { service, client, event } = await setupService({ client: createFakeClient({ state: 'ready' }) })

  // ① 带 `pendingTasks` 的载荷被输入校验直接拒掉，根本到不了 client。
  const before = client.calls.length
  const rejected = await service.dispatch('update.install', {
    releaseId: RELEASE, manifestDigest: DIGEST,
    pendingTasks: [],   // ← 企图把环境说成干净的
  }, event)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'UPDATE_IPC_BAD_INPUT')
  assert.match(rejected.reason, /只接受 releaseId\/manifestDigest/)
  assert.equal(client.calls.length, before, '被拒的载荷仍然被转交下去了')

  // ② 合法载荷只带身份：client 拿不到任何任务读数（由主进程自己读）。
  const accepted = await service.dispatch('update.install', { releaseId: RELEASE, manifestDigest: DIGEST }, event)
  assert.equal(accepted.ok, true)
  const [, call] = client.calls.at(-1)
  assert.equal(call.pendingTasks, undefined,
    'client 收到了来自渲染进程的任务读数')
})

test('★ update.tasks：只读读数，读不到是 ok:false 而不是空数组', async () => {
  // 设计 §7 line 150 的**展示**读数。它与安装判据用的读数分开取，
  // 但由同一个 provider 提供，所以界面与预检不会互相矛盾。
  const { service, event } = await setupService({
    client: createFakeClient({ state: 'ready' }),
    readTasks: async () => [{ id: 't-1', state: 'in_progress' }, { id: 't-2', state: 'done' }],
  })
  const reading = await service.dispatch('update.tasks', {}, event)
  assert.equal(reading.ok, true)
  assert.equal(reading.tasks.length, 2)
  assert.match(reading.summary, /1 个在跑/)
  // ★ 投影只带 id/state（界面不需要别的，别的也不该过去）。
  assert.deepEqual(Object.keys(reading.tasks[0]).sort(), ['id', 'state'])

  // 确实没有任务：`[]` 是**合法**读数。
  const empty = await setupService({ client: createFakeClient({ state: 'ready' }), readTasks: async () => [] })
  const emptyReading = await empty.service.dispatch('update.tasks', {}, empty.event)
  assert.equal(emptyReading.ok, true)
  assert.deepEqual([...emptyReading.tasks], [])
  assert.equal(emptyReading.summary, '没有任务')

  // 读不到（provider 返回 null）→ `ok: false`，**不是** `tasks: []`。
  const unreadable = await setupService({ client: createFakeClient({ state: 'ready' }), readTasks: async () => null })
  const failed = await unreadable.service.dispatch('update.tasks', {}, unreadable.event)
  assert.equal(failed.ok, false, '读不到被报成了成功')
  assert.equal(failed.tasks, undefined, '读不到时给出了 tasks 字段')
  assert.match(failed.reason, /查不到不等于没有/)

  // provider 抛错 → 同样是 `ok: false`。
  const throwing = await setupService({
    client: createFakeClient({ state: 'ready' }),
    readTasks: async () => { throw new Error('bridge 断了') },
  })
  const thrown = await throwing.service.dispatch('update.tasks', {}, throwing.event)
  assert.equal(thrown.ok, false)
  assert.match(thrown.reason, /bridge 断了/)

  // 没有 provider（例如测试环境）→ 明确不可用，而不是假装"没有任务"。
  const noProvider = await setupService({ client: createFakeClient({ state: 'ready' }) })
  const absent = await noProvider.service.dispatch('update.tasks', {}, noProvider.event)
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /没有配置/)
})

test('安装失败：把失败原因如实带出去（不假装成功）', async () => {
  const client = createFakeClient({ state: 'ready', installResult: { ok: false, code: 'update-install-failed', reason: '健康检查失败，已回退' } })
  const { service, event } = await setupService({ client })
  const result = await service.dispatch('update.install', { releaseId: RELEASE, manifestDigest: DIGEST }, event)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'update-install-failed')
  assert.match(result.reason, /回退/)
})

test('dispatch 的返回值可结构化克隆（不会把 Error 变成空对象）', async () => {
  const { service, event } = await setupService()
  const result = await service.dispatch('update.check', {}, event)
  // 经 IPC 之后形状必须还原：JSON 往返一次仍然相等。
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

// ---------------------------------------------------------------------------
// ⑩ 面板是**单例**（设计 §10 第 4 行的"多个窗口"）
// ---------------------------------------------------------------------------

test('★★★ 面板是单例：再次打开复用同一个窗口，不新开一个（设计 §10 第 4 行）', async () => {
  // ★ 设计 §10 第 4 行要求「重复点击、**多个窗口**、下载中发现新版 →
  //   一次网络/安装事务；确认目标保持一致」。
  //
  //   这条守的是**三个子情形里的第二个**：
  //     · 重复点击        → 已有用例（`client.test.mjs` 的"并发检查共享一次请求"）
  //     · 下载中发现新版  → 已有用例（同文件的"下载期间候选变了"）
  //     · **多个窗口**    → **此前一条用例都没有**（本用例）
  //
  //   实现是 `showPanel()` 开头那次复用：
  //     `if (panel !== null && panel.isDestroyed?.() !== true) { panel.show(); ... }`
  //   一个"总是新开窗口"的实现会让每个用例都照样绿——因为那些用例只调用
  //   `showPanel()` **一次**。而后果是两个面板同时驱动**同一个** client：
  //   用户在一个窗口点"安装"、在另一个窗口点"稍后"，而两者本应互斥。
  //
  //   > "同一个东西只该有一个"这条判据，只有在**第二次**调用时才看得见。
  const contents = { mainFrame: { url: 'file:///C:/legion/desktop/update.html' }, id: 7, send() {} }
  let created = 0
  let shown = 0
  const panel = {
    webContents: contents, isDestroyed: () => false,
    show() { shown += 1 }, focus() {}, on() {}, close() {},
  }
  const service = createUpdateService({
    client: createFakeClient(),
    desktopDir: 'C:\\legion\\desktop',
    createPanel: () => { created += 1; return { window: panel, url: contents.mainFrame.url, ready: Promise.resolve() } },
  })
  const first = await service.showPanel()
  const second = await service.showPanel()
  assert.equal(created, 1, `面板被建了 ${created} 次——多个窗口会同时驱动同一个 client`)
  assert.equal(first, second, '两次 showPanel 返回的不是同一个窗口')
  assert.equal(second, panel)
  // ★ 第二次必须是"把它**显示出来**"（而不是静默返回一个看不见的窗口）。
  //   第一次**不**由 service 调 `show()`：窗口是 `createPanel` 建的，显示由工厂负责。
  //   （我第一版把这里写成"期望 2 次"——那是我对分工的假设，不是实现的行为；
  //     断言纠正过来之后它反而更精确地说明了"哪一次由谁负责显示"。）
  assert.equal(shown, 1, `show() 被调了 ${shown} 次，期望 1 次（只有"复用"那一次）`)
  assert.equal(service.panelOpen, true)
})

test('★ 面板关掉之后再打开会**真的**新建一个（单例不等于永远只有一个）', async () => {
  // 上面那条的反向对照：如果"单例"被实现成"永远只建一次"，
  // 那么用户关掉面板之后就再也打不开了——那是另一个方向的错。
  const contents = { mainFrame: { url: 'file:///C:/legion/desktop/update.html' }, id: 8, send() {} }
  let created = 0
  let destroyed = false
  const panel = {
    webContents: contents,
    isDestroyed: () => destroyed,
    show() {}, focus() {}, on() {}, close() { destroyed = true },
  }
  const service = createUpdateService({
    client: createFakeClient(),
    desktopDir: 'C:\\legion\\desktop',
    createPanel: () => { created += 1; return { window: panel, url: contents.mainFrame.url, ready: Promise.resolve() } },
  })
  await service.showPanel()
  assert.equal(created, 1)
  assert.equal(service.panelOpen, true)
  service.close()
  assert.equal(service.panelOpen, false, 'close() 之后仍然认为面板开着')
  destroyed = true
  await service.showPanel()
  assert.equal(created, 2, '面板关掉之后再打开没有新建——用户会打不开面板')
})

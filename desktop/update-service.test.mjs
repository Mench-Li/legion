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
async function setupService({ client = createFakeClient(), panelUrl = 'file:///C:/legion/desktop/update.html' } = {}) {
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

test('暴露的命令恰好是设计 §7 那张表', async () => {
  assert.deepEqual([...UPDATE_COMMANDS], [
    'update.status', 'update.check', 'update.download', 'update.cancelDownload', 'update.install', 'update.snooze',
  ])
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

test('安装：只把身份与在途任务读数转交，不转交任何路径', async () => {
  const { service, client, event } = await setupService({ client: createFakeClient({ state: 'ready' }) })
  const result = await service.dispatch('update.install', { releaseId: RELEASE, manifestDigest: DIGEST }, event)
  assert.equal(result.ok, true)
  const [, call] = client.calls.at(-1)
  assert.equal(call.releaseId, RELEASE)
  assert.equal(call.manifestDigest, DIGEST)
  assert.equal(call.pendingTasks, null)
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

// orchestrator/worker/worker.test.mjs
// ============================================================================
// PRT-301 worker 的判据
//
// 两条最重要的断言都不是「它能不能干活」，而是**它会不会干不该干的事**：
//   ① 没有执行引擎时**不认领**。一个「积极」的 worker 会照常认领然后立刻失败，
//      把每个任务的重试额度烧光，最后全部落进 Dead Letter——外部表现是
//      「任务在跑，但全都失败了」，而真因只是「没配执行引擎」。
//   ② 状态文件里**不得出现凭证**。这个文件会被贴进 issue 与诊断包，
//      而这个进程恰好持有 TEAM_HUB_TOKEN。
//
// 另有一条真实进程用例：它是唯一能证明「SIGTERM 真的能把它停下来」
// 与「状态文件真的落在磁盘上」的判据——注入 clock 证明不了这两件事。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createWorker, WORKER_DEFAULTS, WORKER_STATES } from './main.mjs'
import { DEFAULT_STATUS_MAX_AGE_MS, FORBIDDEN_STATUS_KEYS, isStatusFresh, readStatusFile, redactStatus, STATUS_RELPATH, writeStatusFile } from './status-file.mjs'
import { createHubClient, readWorkerEnv, runWorkerProcess, WORKER_ENV } from './run.mjs'

const WORKER_ENTRY = fileURLToPath(new URL('../../product/orchestrator/worker.mjs', import.meta.url))

/** 记录调用的假 hub。 */
function fakeHub({ tasks = [], failClaim = false } = {}) {
  const calls = { claim: 0, transition: [], release: [], heartbeat: [] }
  const queue = [...tasks]
  return {
    calls,
    async claim() {
      calls.claim += 1
      if (failClaim) throw new Error('ECONNREFUSED')
      return queue.shift() ?? null
    },
    async transition(arg) { calls.transition.push(arg); return { ok: true } },
    async release(arg) { calls.release.push(arg); return { ok: true } },
    async heartbeat(arg) { calls.heartbeat.push(arg); return { ok: true } },
  }
}

function tempDataDir() {
  const root = mkdtempSync(join(tmpdir(), 'legion-worker-'))
  return { root, dataDir: join(root, 'data') }
}

// ---------------------------------------------------------------- ① 不认领

test('① 没有执行引擎时**不认领任何任务**（认领会烧光重试额度）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', leaseEpoch: 1 }] })
    const logs = []
    const w = createWorker({ hub, executor: null, dataDir, logger: (l) => logs.push(l) })
    const r = await w.tick()
    assert.equal(r.reason, 'no-executor')
    assert.equal(hub.calls.claim, 0, '没有执行引擎时一次 claim 都不能发')
    assert.equal(w.state, 'no-executor')
    assert.ok(WORKER_STATES.includes(w.state))
    assert.match(logs.join('\n'), /不认领任何任务/)
    // 状态文件必须如实说明，否则外部只看到「进程在」
    const status = readStatusFile(w.statusPath)
    assert.equal(status.ok, true)
    assert.equal(status.status.executorConfigured, false)
    assert.equal(status.status.state, 'no-executor')
    assert.equal(status.status.claimed, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('① 没有 hub 时不认领，并报 hub-unreachable', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const w = createWorker({ hub: null, executor: { execute: async () => ({ outcome: 'completed' }) }, dataDir })
    const r = await w.tick()
    assert.equal(r.reason, 'hub-not-configured')
    assert.equal(w.state, 'hub-unreachable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('① 认领失败不致命：记录连续失败并进入退避，不退出', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ failClaim: true })
    const w = createWorker({ hub, executor: { execute: async () => ({ outcome: 'completed' }) }, dataDir })
    const r = await w.tick()
    assert.equal(r.reason, 'claim-failed')
    assert.equal(w.counters.consecutiveFailures, 1)
    assert.equal(w.state, 'hub-unreachable')
    // 连续失败计数必须能到阈值——否则「hub 挂了」会表现成高频重试
    await w.tick()
    await w.tick()
    assert.equal(w.counters.consecutiveFailures, 3)
    assert.equal(w.snapshot().lastError.stage, 'claim')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ② 正常一轮

test('② 认领 → 执行 → 提交终态：计数与状态文件同步', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', leaseEpoch: 7 }] })
    const seen = []
    const w = createWorker({
      hub,
      executor: { execute: async (lease) => { seen.push(lease); return { outcome: 'completed' } } },
      dataDir,
    })
    const r = await w.tick()
    assert.equal(r.outcome, 'completed')
    assert.equal(seen[0].taskId, 't1')
    assert.equal(hub.calls.transition.length, 1)
    // 提交终态必须携带领取时的 leaseEpoch：不带的写入会被 team-hub 拒绝（PRT-313），
    // 而如果它被静默接受，迟到的 worker 就能改写别人的结果。
    assert.equal(hub.calls.transition[0].leaseEpoch, 7)
    assert.equal(w.counters.claimed, 1)
    assert.equal(w.counters.completed, 1)
    const status = readStatusFile(w.statusPath)
    assert.equal(status.status.completed, 1)
    assert.equal(status.status.currentTaskId, null, '执行结束后不得残留当前任务')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 空队列是空闲，不是失败（连续失败计数要归零）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ failClaim: true })
    const w = createWorker({ hub, executor: { execute: async () => ({ outcome: 'completed' }) }, dataDir })
    await w.tick()
    assert.equal(w.counters.consecutiveFailures, 1)
    hub.calls.claim = 0
    const emptyHub = fakeHub({ tasks: [] })
    const w2 = createWorker({ hub: emptyHub, executor: { execute: async () => ({ outcome: 'completed' }) }, dataDir })
    const r = await w2.tick()
    assert.equal(r.reason, 'queue-empty')
    assert.equal(w2.counters.consecutiveFailures, 0)
    assert.equal(w2.state, 'idle')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 执行抛错记成 failed，不把 worker 一起带走', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', leaseEpoch: 1 }] })
    const w = createWorker({
      hub,
      executor: { execute: async () => { throw new Error('boom') } },
      dataDir,
    })
    const r = await w.tick()
    assert.equal(r.outcome, 'failed')
    assert.equal(w.counters.failed, 1)
    assert.equal(w.snapshot().lastError.stage, 'execute')
    assert.equal(w.snapshot().lastError.message, 'boom')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② outcome_unknown 单独计数（它既不是成功也不是普通失败）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', leaseEpoch: 3 }] })
    const w = createWorker({ hub, executor: { execute: async () => ({ outcome: 'outcome_unknown', detail: '外部写结果不可确认' }) }, dataDir })
    await w.tick()
    assert.equal(w.counters.unknownOutcome, 1)
    assert.equal(w.counters.completed, 0)
    assert.equal(w.counters.failed, 0)
    assert.equal(hub.calls.transition[0].outcome, 'outcome_unknown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ③ 停止

test('③ 优雅停止必须释放持有的 lease（不释放会让队列看起来卡住）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub()
    let resolveExec
    const w = createWorker({
      hub,
      executor: { execute: () => new Promise((r) => { resolveExec = r }) },
      dataDir,
    })
    // 手工把 lease 放进去，模拟「正在执行中收到停止信号」
    hub.claim = async () => ({ taskId: 't-busy', leaseEpoch: 11 })
    const tickPromise = w.tick()
    await new Promise((r) => setImmediate(r))
    const stopped = await w.stop({ reason: 'SIGTERM' })
    assert.equal(stopped.ok, true)
    assert.equal(hub.calls.release.length, 1)
    assert.equal(hub.calls.release[0].taskId, 't-busy')
    assert.equal(hub.calls.release[0].leaseEpoch, 11)
    assert.equal(w.state, 'stopped')
    resolveExec({ outcome: 'completed' })
    await tickPromise
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('③ 停止是幂等的；释放失败要记日志但不抛错', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub()
    hub.release = async () => { throw new Error('hub 已下线') }
    hub.claim = async () => ({ taskId: 't1', leaseEpoch: 1 })
    let resolveExec
    const logs = []
    const w = createWorker({ hub, executor: { execute: () => new Promise((r) => { resolveExec = r }) }, dataDir, logger: (l) => logs.push(l) })
    const tickPromise = w.tick()
    await new Promise((r) => setImmediate(r))
    const first = await w.stop({ reason: 'SIGINT' })
    assert.equal(first.ok, true)
    assert.equal(first.released.ok, false)
    assert.match(logs.join('\n'), /释放 lease 失败/)
    const second = await w.stop({ reason: 'again' })
    assert.equal(second.alreadyStopped, true)
    resolveExec({ outcome: 'completed' })
    await tickPromise
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ④ 状态文件

test('④ 状态文件绝不写入凭证（它会被贴进 issue 与诊断包）', () => {
  const { value, removed } = redactStatus({
    workerId: 'w1',
    token: 'super-secret',
    nested: { TEAM_HUB_TOKEN: 'abc', authorization: 'Bearer x', ok: 1 },
    list: [{ apiKey: 'k', keep: true }],
  })
  assert.deepEqual([...removed].sort(), ['list[0].apiKey', 'nested.TEAM_HUB_TOKEN', 'nested.authorization', 'token'])
  assert.equal(JSON.stringify(value).includes('super-secret'), false)
  assert.equal(JSON.stringify(value).includes('Bearer x'), false)
  assert.equal(JSON.stringify(value).includes('"k"'), false)
  assert.equal(value.nested.ok, 1)
  assert.equal(value.list[0].keep, true)
  // 禁用键名单本身要覆盖常见命名
  for (const k of ['token', 'secret', 'password', 'apiKey']) assert.ok(FORBIDDEN_STATUS_KEYS.includes(k))
})

test('④ 状态文件原子写入：写失败不抛错，但如实报出来', () => {
  const { root, dataDir } = tempDataDir()
  try {
    const path = join(dataDir, STATUS_RELPATH)
    const ok = writeStatusFile(path, { workerId: 'w1', state: 'idle', token: 'x' })
    assert.equal(ok.ok, true)
    assert.deepEqual([...ok.removed], ['token'])
    assert.equal(existsSync(path), true)
    // 临时文件不得残留：诊断目录里多一个 .tmp 会让人以为写入被打断
    assert.equal(existsSync(`${path}.tmp`), false)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.token, undefined)
    assert.equal(parsed.workerId, 'w1')
    assert.equal(typeof parsed.statusWrittenAt, 'string')

    const failed = writeStatusFile(path, { ok: 1 }, {
      writeFile: () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e },
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'STATUS_WRITE_FAILED')
    assert.match(failed.message, /ENOSPC/)
    assert.match(failed.message, /worker 会继续工作/, '观测失败不得被描述成致命错误')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('④ readStatusFile 对「不存在」与「坏了」给出不同结论', () => {
  const { root, dataDir } = tempDataDir()
  try {
    const path = join(dataDir, STATUS_RELPATH)
    const missing = readStatusFile(path)
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /不存在/)
    // 两种情形的处置完全不同：不存在 = 没启动过；坏了 = 有人写坏了 / 被 kill -9 打断
    writeStatusFile(path, { state: 'idle' })
    writeFileSync(path, '{ 坏')
    const broken = readStatusFile(path)
    assert.equal(broken.ok, false)
    assert.match(broken.reason, /不可解析/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ⑤ 进程外壳

test('⑤ readWorkerEnv / WORKER_ENV 逐字对应，默认值来自 WORKER_DEFAULTS', () => {
  const env = readWorkerEnv({ TEAM_HUB_URL: 'http://127.0.0.1:8787', TEAM_HUB_TOKEN: 't', LEGION_DATA_DIR: 'D:\\d' })
  assert.equal(env.hubUrl, 'http://127.0.0.1:8787')
  assert.equal(env.hubToken, 't')
  assert.equal(env.dataDir, 'D:\\d')
  assert.equal(readWorkerEnv({}).hubUrl, null)
  assert.equal(WORKER_ENV.HUB_URL, 'TEAM_HUB_URL')
  assert.equal(WORKER_ENV.DATA_DIR, 'LEGION_DATA_DIR')
  // 默认值本身也要被断言：节奏参数是「产品变卡」与「忙等循环」之间的那条线，
  // 它们被悄悄改成 0 不会有任何用例失败。
  assert.equal(WORKER_DEFAULTS.pollIntervalMs > 0, true)
  assert.equal(WORKER_DEFAULTS.heartbeatIntervalMs > 0, true)
  assert.equal(WORKER_DEFAULTS.failureBackoffMs > 0, true)
  assert.equal(WORKER_DEFAULTS.maxConsecutiveFailures >= 1, true)
  // 心跳间隔必须**短于**轮询间隔无关，但必须显著小于一个租期才可能有效；
  // 这里只能断言它不为 0（0 会让心跳被关闭，见 main.mjs 的 startHeartbeat）
  assert.notEqual(WORKER_DEFAULTS.heartbeatIntervalMs, 0)
})

// ---------------------------------------------------------------- ⑥ 心跳

test('⑥ 执行期间发心跳：长任务不发心跳一定会被第二个 worker 重跑', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't-long', leaseEpoch: 5 }] })
    let finishExec
    const w = createWorker({
      hub,
      executor: { execute: () => new Promise((r) => { finishExec = r }) },
      dataDir,
      heartbeatIntervalMs: 5,
    })
    const tick = w.tick()
    // 让心跳真的跑几轮
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(hub.calls.heartbeat.length >= 2, `期望至少 2 次心跳，实际 ${hub.calls.heartbeat.length}`)
    // 心跳必须带 leaseEpoch：不带 epoch 的心跳无法证明「我还是持有者」
    assert.equal(hub.calls.heartbeat[0].taskId, 't-long')
    assert.equal(hub.calls.heartbeat[0].leaseEpoch, 5)
    assert.equal(w.snapshot().leaseMayBeLost, false)
    finishExec({ outcome: 'completed' })
    await tick
    // 执行结束后必须停掉心跳：继续发会让一个已释放的 lease 看起来还活着
    const after = hub.calls.heartbeat.length
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(hub.calls.heartbeat.length, after, '执行结束后不得继续发心跳')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑥ 心跳失败必须可见：lease 可能已易主，结果可能被拒绝或覆盖别人的结果', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', leaseEpoch: 1 }] })
    hub.heartbeat = async () => { throw new Error('hub 已重启，我的 lease 没了') }
    let finishExec
    const logs = []
    const w = createWorker({
      hub,
      executor: { execute: () => new Promise((r) => { finishExec = r }) },
      dataDir,
      heartbeatIntervalMs: 5,
      logger: (l) => logs.push(l),
    })
    const tick = w.tick()
    await new Promise((r) => setTimeout(r, 40))
    const snap = w.snapshot()
    assert.ok(snap.counters.heartbeatFailures >= 1)
    assert.equal(snap.leaseMayBeLost, true)
    // 日志必须说清后果，而不只是「心跳失败」
    assert.match(logs.join('\n'), /lease 可能已过期并被其他 worker 接管/)
    assert.match(logs.join('\n'), /覆盖别人的结果/)
    // 状态文件也要带上这个标志：运维不该只能靠翻日志才能发现
    const status = readStatusFile(w.statusPath)
    assert.equal(status.status.leaseMayBeLost, true)
    assert.ok(status.status.heartbeatFailures >= 1)
    finishExec({ outcome: 'completed' })
    await tick
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑥ heartbeatIntervalMs = 0 关闭心跳（显式关闭，不是「忘了配」）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', leaseEpoch: 1 }] })
    let finishExec
    const w = createWorker({
      hub,
      executor: { execute: () => new Promise((r) => { finishExec = r }) },
      dataDir,
      heartbeatIntervalMs: 0,
    })
    const tick = w.tick()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(hub.calls.heartbeat.length, 0)
    finishExec({ outcome: 'completed' })
    await tick
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ⑦ 真实进程

test('⑤ hub 客户端缺 token 时**不发匿名请求**（401 的文案离真因太远）', () => {
  assert.throws(() => createHubClient({ baseUrl: 'http://x', token: '' }), /需要 token/)
  assert.throws(() => createHubClient({ baseUrl: '' , token: 't' }), /需要 baseUrl/)
  // 有 token 时构造成功，且请求带 Bearer 头
  const calls = []
  const client = createHubClient({
    baseUrl: 'http://127.0.0.1:8787/',
    token: 'secret-token',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ taskId: 't1' }) } },
  })
  return client.claim({ workerId: 'w1' }).then((r) => {
    assert.equal(r.taskId, 't1')
    assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/runtime/claim')
    assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token')
  })
})

test('⑦ runWorkerProcess：缺 LEGION_DATA_DIR 时返回非零退出码**且带原因**', async () => {
  const lines = []
  const r = await runWorkerProcess({ env: {}, write: (l) => lines.push(l), installSignalHandlers: false })
  // 判别式联合：`ok === false` 时下游必须读出 exitCode 才能退出。
  // 上一版返回裸数字 8，而入口写成 `const { runPromise } = await …`——
  // 解构得到 undefined，`await undefined` 通过，退出码被设成 0：
  // Launcher 会认为「worker 起来了」，而它其实什么都没做。
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 8)
  assert.equal(r.worker, null)
  assert.match(r.message, /LEGION_DATA_DIR/)
  assert.equal(lines.length, 0, '起不来时把话交给调用方去 stderr，不写两遍')
})

test('⑦ runWorkerProcess：hub 客户端建不起来时仍以 hub-unreachable 运行（不静默退出）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const lines = []
    const startup = await runWorkerProcess({
      env: { LEGION_DATA_DIR: dataDir, TEAM_HUB_URL: 'http://127.0.0.1:1' }, // 有 URL 但没有 token
      executor: { execute: async () => ({ outcome: 'completed' }) },
      write: (l) => lines.push(l),
      installSignalHandlers: false,
    })
    assert.equal(startup.ok, true)
    assert.match(lines.join('\n'), /数据面客户端未能建立/)
    assert.equal(startup.worker.snapshot().hubConfigured, false)
    await startup.worker.tick()
    assert.equal(startup.worker.state, 'hub-unreachable')
    assert.equal(typeof startup.statusPath, 'string')
    assert.match(startup.statusPath, /worker\.status\.json$/)
    await startup.worker.stop({ reason: 'test' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ⑥ 真实进程

test('⑥ 真实进程：入口能起来、写状态文件；被终止后状态文件**停在那**（这正是要判定的东西）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const child = spawn(process.execPath, [WORKER_ENTRY], {
      env: { ...process.env, LEGION_DATA_DIR: dataDir, LEGION_WORKER_ID: 'real-1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    child.stdout.on('data', (d) => out.push(String(d)))
    child.stderr.on('data', (d) => out.push(String(d)))

    const statusPath = join(dataDir, STATUS_RELPATH)
    // 等状态文件出现：这是「进程真的跑起来了」的唯一可信信号
    const deadline = Date.now() + 20000
    while (!existsSync(statusPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    assert.equal(existsSync(statusPath), true, `状态文件未出现；输出：\n${out.join('')}`)

    const status = readStatusFile(statusPath)
    assert.equal(status.ok, true)
    assert.equal(status.status.workerId, 'real-1')
    assert.equal(status.status.state, 'no-executor', '没有执行引擎时必须如实报 no-executor 且不认领')
    assert.equal(status.status.claimed, 0)
    assert.equal(status.status.pid, child.pid)
    // 状态必须是新鲜的（刚写出来的），否则下面「陈旧判定」的断言就失去意义
    const fresh = isStatusFresh(status.status)
    assert.equal(fresh.fresh, true, fresh.reason ?? '')
    // 环境里没有 token，状态文件里也不该有
    assert.equal(JSON.stringify(status.status).includes('TEAM_HUB_TOKEN'), false)

    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    child.kill('SIGTERM')
    const result = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 15000)),
    ])
    assert.notEqual(result.code, 'timeout', `终止后 15s 未退出；输出：\n${out.join('')}`)

    if (process.platform === 'win32') {
      // **平台事实**：Windows 上 `child.kill('SIGTERM')`（以及任何进程管理器发的「终止」）
      // 会**无条件终止**目标进程——接收方的信号处理器根本不会被调用。
      // 因此这里只断言「它确实被终止了」，而**不能**断言 exit code 0 或状态文件的
      // stopped 收尾：在本机那条优雅路径一次都没走过。
      assert.equal(result.signal, 'SIGTERM', `期望被信号终止，实际 ${JSON.stringify(result)}`)
      // 这条断言记录的是**后果**：状态文件停在最后一刻的值，而不是 stopped。
      // 「文件存在」与「worker 还活着」因此必须分开判定（isStatusFresh）。
      const stale = readStatusFile(statusPath)
      assert.notEqual(stale.status.state, 'stopped',
        'Windows 上不应出现 stopped：若出现了说明信号处理器真的被调用了，这条平台结论需要重新验证')
    } else {
      // POSIX：信号处理器会被调用，优雅停止应当走完并留下收尾痕迹
      assert.equal(result.code, 0, `非零退出：${JSON.stringify(result)}；输出：\n${out.join('')}`)
      const finalStatus = readStatusFile(statusPath)
      assert.equal(finalStatus.status.state, 'stopped')
      assert.equal(finalStatus.status.stopReason, 'SIGTERM')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑥ 陈旧状态判定：文件在但进程已死时**不得**报成在跑', () => {
  // 这条判据的直接来源就是上一条用例——Windows 上终止不走信号处理器，
  // 于是「状态文件存在」与「worker 还活着」是两件事。
  const base = Date.parse('2026-09-11T10:00:00.000Z')
  const status = { state: 'executing', statusWrittenAt: '2026-09-11T10:00:00.000Z' }
  const now = () => base
  assert.equal(isStatusFresh(status, { now: now(), maxAgeMs: 30000 }).fresh, true)
  // 默认窗口必须明显大于心跳间隔，否则一个正常工作的 worker 会被周期性报成「已死」——
  // 而误报「已死」的代价是有人去重启一个正常进程。
  assert.equal(DEFAULT_STATUS_MAX_AGE_MS >= WORKER_DEFAULTS.heartbeatIntervalMs * 2, true)
  assert.equal(isStatusFresh(status, { now: base + DEFAULT_STATUS_MAX_AGE_MS - 1000 }).fresh, true)
  assert.equal(isStatusFresh(status, { now: base + DEFAULT_STATUS_MAX_AGE_MS + 1000 }).fresh, false)

  const later = isStatusFresh(status, { now: base + 60000, maxAgeMs: 30000 })
  assert.equal(later.fresh, false)
  assert.match(later.reason, /已被强制终止/)
  assert.equal(later.ageMs, 60000)

  // 缺时间戳 / 时间戳坏了 / 时钟回拨：一律报「不新鲜」。
  // 宁可说「不确定」，也不要把一个可能已经死掉的 worker 报成在跑——
  // 后者的代价是任务永远没人认领，且没有任何错误信息。
  assert.equal(isStatusFresh({ state: 'idle' }, { now: base }).fresh, false)
  assert.equal(isStatusFresh({ statusWrittenAt: 'not-a-date' }, { now: base }).fresh, false)
  const future = isStatusFresh({ statusWrittenAt: '2026-09-11T11:00:00.000Z' }, { now: base })
  assert.equal(future.fresh, false)
  assert.match(future.reason, /时钟可能被调整过/)
})

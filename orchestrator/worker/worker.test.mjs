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

import { createWorker, inPlaceStages, REQUIRED_STAGE_KEYS, WORKER_DEFAULTS, WORKER_STATES } from './main.mjs'
import { DEFAULT_STATUS_MAX_AGE_MS, FORBIDDEN_STATUS_KEYS, isStatusFresh, readStatusFile, redactStatus, STATUS_RELPATH, writeStatusFile } from './status-file.mjs'
import { createHubClient, HubHttpError, readWorkerEnv, runWorkerProcess, WORKER_ENV } from './run.mjs'

const WORKER_ENTRY = fileURLToPath(new URL('../../product/orchestrator/worker.mjs', import.meta.url))

/** 记录调用的假 hub。 */
function fakeHub({ tasks = [], failClaim = false, failReport = null } = {}) {
  const calls = { claim: 0, transition: [], release: [], heartbeat: [], fail: [] }
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
    /**
     * 失败上报由**服务端**决定去向（PRT-309）。假 hub 也要如实返回那三个字段——
     * 只返回 `{ok:true}` 的话，"worker 有没有把服务端的处置读出来"这件事就测不到，
     * 而那正是这一层要保证的东西。
     */
    async fail(arg) {
      calls.fail.push(arg)
      if (failReport !== null) throw failReport
      return { ok: true, action: 'retry-new-attempt', nextAttemptAtMs: 1_700_000_002_000, attemptsUsed: 1, maxAttempts: 5 }
    },
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
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
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
    const w = createWorker({ hub: null, executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) }, dataDir })
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
    const w = createWorker({ hub, executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) }, dataDir })
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
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 7 }] })
    const seen = []
    const w = createWorker({
      hub,
      executor: { ...inPlaceStages(), execute: async (lease) => { seen.push(lease); return { outcome: 'completed' } } },
      dataDir,
    })
    const r = await w.tick()
    assert.equal(r.outcome, 'completed')
    assert.equal(seen[0].taskId, 't1')
    // §6.4 的顺序：每个阶段**先落库意图，再做副作用**，最后才提交结果。
    // 断言的是完整序列，因为「跳过一个阶段」正是状态机会拒绝、而这里能查出的事。
    assert.deepEqual(hub.calls.transition.map((t) => t.to),
      ['PreparingWorkspace', 'BuildingContext', 'Running', undefined],
      '最后一条是结果提交（用 outcome 而不是 to）')
    assert.deepEqual(r.trace, ['PreparingWorkspace', 'BuildingContext', 'Running'])
    // 提交终态必须携带领取时的 leaseEpoch：不带的写入会被 team-hub 拒绝（PRT-313），
    // 而如果它被静默接受，迟到的 worker 就能改写别人的结果。
    for (const t of hub.calls.transition) {
      assert.equal(t.leaseEpoch, 7, '每一次写入都要带 epoch，包括中间阶段')
      assert.equal(t.attemptId, 'att:t1:1', '写入按 attemptId 定位，不是 taskId')
    }
    assert.equal(hub.calls.transition[3].outcome, 'completed')
    assert.equal(w.counters.claimed, 1)
    assert.equal(w.counters.completed, 1)
    const status = readStatusFile(w.statusPath)
    assert.equal(status.status.completed, 1)
    assert.equal(status.status.currentAttemptId, null, '执行结束后不得残留当前尝试')
    assert.equal(status.status.stageMode, 'full')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 空队列是空闲，不是失败（连续失败计数要归零）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ failClaim: true })
    const w = createWorker({ hub, executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) }, dataDir })
    await w.tick()
    assert.equal(w.counters.consecutiveFailures, 1)
    hub.calls.claim = 0
    const emptyHub = fakeHub({ tasks: [] })
    const w2 = createWorker({ hub: emptyHub, executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) }, dataDir })
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
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    const w = createWorker({
      hub,
      executor: { ...inPlaceStages(), execute: async () => { throw new Error('boom') } },
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
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 3 }] })
    const w = createWorker({ hub, executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'outcome_unknown', detail: '外部写结果不可确认' }) }, dataDir })
    await w.tick()
    assert.equal(w.counters.unknownOutcome, 1)
    assert.equal(w.counters.completed, 0)
    assert.equal(w.counters.failed, 0)
    const submit = hub.calls.transition[hub.calls.transition.length - 1]
    assert.equal(submit.outcome, 'outcome_unknown',
      '结果未知必须如实提交：它的去向是「等人工」，而不是被一次自动重试变成重复副作用')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 只有 execute 的执行引擎**不认领**（状态机不允许跳状态，它会烧光重试额度）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    const logs = []
    const w = createWorker({ hub, executor: { execute: async () => ({ outcome: 'completed' }) }, dataDir, logger: (l) => logs.push(l) })
    const r = await w.tick()
    assert.equal(r.reason, 'no-stages')
    assert.deepEqual([...r.missingStages], ['prepareWorkspace', 'buildContext'])
    // 一次 claim 都不能发：任务已被领走却做不完，比不领更坏
    assert.equal(hub.calls.claim, 0)
    assert.equal(w.state, 'no-stages')
    assert.match(logs.join('\n'), /缺少必需阶段/)
    const status = readStatusFile(w.statusPath)
    assert.equal(status.status.stageMode, 'incomplete')
    assert.deepEqual([...status.status.missingStages], ['prepareWorkspace', 'buildContext'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② REQUIRED_STAGE_KEYS 与状态机的路径一致（三者缺一不可）', () => {
  assert.deepEqual([...REQUIRED_STAGE_KEYS], ['prepareWorkspace', 'buildContext', 'execute'])
  // inPlaceStages 只铺两个前置阶段：execute 必须由调用方给（它是业务本体）
  const s = inPlaceStages()
  assert.equal(typeof s.prepareWorkspace, 'function')
  assert.equal(typeof s.buildContext, 'function')
  assert.equal(s.execute, undefined)
  // 降级阶段必须如实说明自己没做什么，否则日后翻记录会以为当时有工作区隔离
  return Promise.all([s.prepareWorkspace({}), s.buildContext({})]).then(([a, b]) => {
    assert.equal(a.kind, 'in-place')
    assert.equal(b.kind, 'minimal')
    assert.match(a.note, /PRT-306\/401/)
    // PRT-411：降级时也要**可判定地**说出"没有冻结快照"，
    // 而不是让人从 `kind` 的字符串去猜。
    assert.equal(s.contextFrozen, false)
  })
})

test('② PRT-411：`buildContext` 的结果会被写进证据（此前它被丢掉了）', async () => {
  // 此前 `step()` 返回的 detail **被直接丢掉**，于是无论这个阶段做没做、
  // 做了什么，证据里都只有一条状态迁移——"没有上下文快照"与"冻结好了一份"
  // 在记录上完全一样。这里从**终态迁移的参数**里把它捞出来。
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    const w = createWorker({
      hub, dataDir, logger: () => {},
      executor: {
        ...inPlaceStages({ contextStage: async (lease) => ({ kind: 'frozen', attemptId: lease.attemptId, snapshotHash: 'sha256:abc', includedCount: 4, excludedCount: 1, truncationCount: 0, redactionCount: 2, tokensKind: 'conservative-estimate', tokens: 120, canReadDefaulted: false }) }),
        execute: async () => ({ outcome: 'completed' }),
      },
    })
    const r = await w.tick()
    assert.equal(r.outcome, 'completed')
    const last = hub.calls.transition[hub.calls.transition.length - 1]
    assert.equal(last.context.frozen.contextFrozen, true, '冻结成功必须被记为 frozen')
    assert.equal(last.context.frozen.snapshotHash, 'sha256:abc')
    assert.equal(last.context.frozen.redactionCount, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('② PRT-411：降级时证据里写 `not minimal`——两种情形不许同形', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    const w = createWorker({
      hub, dataDir, logger: () => {},
      executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) },
    })
    await w.tick()
    const last = hub.calls.transition[hub.calls.transition.length - 1]
    assert.equal(last.context.frozen.contextFrozen, false, '降级时不许写成 frozen')
    assert.equal(last.context.frozen.kind, 'minimal')
    assert.match(last.context.frozen.note, /无上下文快照/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('② PRT-411：阶段没跑到时证据是 `not-reached`，不是 `null`', async () => {
  // `null` 会让"没跑到"与"跑了但没快照"混为一谈。
  const { root, dataDir } = tempDataDir()
  try {
    // prepareWorkspace 抛错 → 根本走不到 buildContext
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    const w = createWorker({
      hub, dataDir, logger: () => {},
      executor: {
        ...inPlaceStages(),
        prepareWorkspace: async () => { throw new Error('工作区建不起来') },
        execute: async () => ({ outcome: 'completed' }),
      },
    })
    await w.tick()
    const failed = hub.calls.fail[hub.calls.fail.length - 1]
    // 失败必须归到**真正出错的那个阶段**：归错了会得到 `runtime-unavailable`
    // （可重试），而真实原因是"工作区没能建起来"。
    assert.equal(failed.failureCode, 'workspace-prepare-failed', `期望工作区阶段失败，实际 ${failed.failureCode}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('② 先落库意图再执行：阶段状态在副作用**之前**就已经写进去了', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    const order = []
    const originalTransition = hub.transition
    hub.transition = async (arg) => { order.push(`persist:${arg.to ?? arg.outcome}`); return originalTransition(arg) }
    const w = createWorker({
      hub,
      executor: {
        prepareWorkspace: async () => { order.push('effect:prepare'); return { kind: 'in-place' } },
        buildContext: async () => { order.push('effect:context'); return { kind: 'minimal' } },
        execute: async () => { order.push('effect:execute'); return { outcome: 'completed' } },
      },
      dataDir,
    })
    await w.tick()
    // 顺序反过来的话，进程在做事中途被杀会留下一个「看起来没开始」的 Attempt，
    // 恢复扫描会以为可以安全重跑——而它可能已经改过外部系统。
    assert.deepEqual(order, [
      'persist:PreparingWorkspace', 'effect:prepare',
      'persist:BuildingContext', 'effect:context',
      'persist:Running', 'effect:execute',
      'persist:completed',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 阶段失败要如实上报，不能让它停在中间等租约过期', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub2 = fakeHub({ tasks: [{ taskId: 't2', attemptId: 'att:t2:1', leaseEpoch: 2 }] })
    const w2 = createWorker({
      hub: hub2,
      executor: {
        prepareWorkspace: async () => { throw new Error('工作区建不起来') },
        buildContext: async () => ({ kind: 'minimal' }),
        execute: async () => ({ outcome: 'completed' }),
      },
      dataDir,
    })
    const r = await w2.tick()
    assert.equal(r.outcome, 'failed')
    assert.equal(r.error.stage, 'prepareWorkspace', '阶段名必须被标出来，否则失败码会误导成 runtime-unavailable')
    assert.equal(r.reported, true)
    // 上报走 `/api/runtime/fail`（服务端单一入口），**不是** `transition({to:'RetryableFailure'})`。
    // 后者只把尝试标成失败就结束了，"接下来怎么办"没人做，任务会永远停在中间态。
    assert.equal(hub2.calls.fail.length, 1, '失败必须走上报入口——只有它会让服务端决定重试还是 Dead Letter')
    assert.equal(hub2.calls.transition.length, 1, '前三个阶段之外的迁移只有 PreparingWorkspace，失败本身不再走 transition')
    const last = hub2.calls.fail[0]
    // 我们知道它失败在哪一步，因此不该让恢复扫描去猜
    assert.equal(last.failureCode, 'workspace-prepare-failed')
    assert.match(last.detail, /工作区建不起来/)
    // worker 要把服务端的处置读出来（否则界面上看不到"它还会自动重试几次"）
    assert.equal(r.error.disposition, 'retry-new-attempt')
    assert.equal(typeof r.error.nextAttemptAtMs, 'number')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ③ 停止

test('② 上报失败本身失败时不得抛错：最可能的原因是「你已被接管」，那是正确结果', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    // 服务端在 fail 上返回 LEASE_EPOCH_STALE：别人已经接管了这条尝试。
    const stale = new HubHttpError('被接管', { status: 409, code: 'LEASE_EPOCH_STALE', currentEpoch: 9 })
    const hub = fakeHub({
      tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }],
      failReport: stale,
    })
    const w = createWorker({
      hub,
      executor: {
        prepareWorkspace: async () => ({ kind: 'in-place' }),
        buildContext: async () => ({ kind: 'minimal' }),
        execute: async () => { throw new Error('执行炸了') },
      },
      dataDir,
    })
    const r = await w.tick()
    // tick 不能抛：抛出去会让 worker 主循环把一次正常竞态当成崩溃处理
    assert.equal(r.outcome, 'failed')
    assert.equal(r.reported, false, '上报失败要如实报 false，不能假装成功')
    assert.match(r.error.reportFailed, /被接管/)
    // 失败原因本身仍然被保留（诊断要靠它）
    assert.equal(r.error.stage, 'execute')
    assert.match(r.error.message, /执行炸了/)
    // worker 回到 idle 而不是卡死或退出
    assert.equal(w.state, 'idle')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('③ 优雅停止必须释放持有的 lease（不释放会让队列看起来卡住）', async () => {
  const { root, dataDir } = tempDataDir()
  try {
    const hub = fakeHub()
    let resolveExec
    const w = createWorker({
      hub,
      executor: { ...inPlaceStages(), execute: () => new Promise((r) => { resolveExec = r }) },
      dataDir,
    })
    // 手工把 lease 放进去，模拟「正在执行中收到停止信号」
    hub.claim = async () => ({ taskId: 't-busy', attemptId: 'att:t-busy:1', leaseEpoch: 11 })
    const tickPromise = w.tick()
    await new Promise((r) => setImmediate(r))
    const stopped = await w.stop({ reason: 'SIGTERM' })
    assert.equal(stopped.ok, true)
    assert.equal(hub.calls.release.length, 1)
    assert.equal(hub.calls.release[0].attemptId, 'att:t-busy:1', '释放按 attemptId 定位')
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
    hub.claim = async () => ({ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 })
    let resolveExec
    const logs = []
    const w = createWorker({ hub, executor: { ...inPlaceStages(), execute: () => new Promise((r) => { resolveExec = r }) }, dataDir, logger: (l) => logs.push(l) })
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
    const hub = fakeHub({ tasks: [{ taskId: 't-long', attemptId: 'att:t-long:1', leaseEpoch: 5 }] })
    let finishExec
    const w = createWorker({
      hub,
      executor: { ...inPlaceStages(), execute: () => new Promise((r) => { finishExec = r }) },
      dataDir,
      heartbeatIntervalMs: 5,
    })
    const tick = w.tick()
    // 让心跳真的跑几轮
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(hub.calls.heartbeat.length >= 2, `期望至少 2 次心跳，实际 ${hub.calls.heartbeat.length}`)
    // 心跳必须带 attemptId + leaseEpoch：不带的请求无法证明「我还是持有者」
    assert.equal(hub.calls.heartbeat[0].attemptId, 'att:t-long:1')
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
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    hub.heartbeat = async () => { throw new Error('hub 已重启，我的 lease 没了') }
    let finishExec
    const logs = []
    const w = createWorker({
      hub,
      executor: { ...inPlaceStages(), execute: () => new Promise((r) => { finishExec = r }) },
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
    const hub = fakeHub({ tasks: [{ taskId: 't1', attemptId: 'att:t1:1', leaseEpoch: 1 }] })
    let finishExec
    const w = createWorker({
      hub,
      executor: { ...inPlaceStages(), execute: () => new Promise((r) => { finishExec = r }) },
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
  // 有 token 时构造成功，请求带 Bearer 头，且**解包**出 claimed
  const calls = []
  const client = createHubClient({
    baseUrl: 'http://127.0.0.1:8787/',
    token: 'secret-token',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ ok: true, claimed: { taskId: 't1', attemptId: 'att:t1:1' } }) } },
  })
  return client.claim({ workerId: 'w1' }).then((r) => {
    // 解包这件事必须被断言：不解包时调用方在信封上找 taskId 会得到 undefined，
    // 而 `undefined` 恰好就是「没领到」的判据——于是任务被领走却永远没人做。
    assert.equal(r.taskId, 't1')
    assert.equal(r.attemptId, 'att:t1:1')
    assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/runtime/claim')
    assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token')
  })
})

test('⑤ hub 客户端把服务端的具名错误码传上来（否则 worker 只能靠文案猜）', async () => {
  const client = createHubClient({
    baseUrl: 'http://x',
    token: 't',
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'leaseEpoch 不符', code: 'LEASE_EPOCH_STALE', currentEpoch: 4 }),
    }),
  })
  await assert.rejects(() => client.heartbeat({ attemptId: 'att:t1:1', leaseEpoch: 1, workerId: 'w1' }), (e) => {
    assert.ok(e instanceof HubHttpError)
    assert.equal(e.status, 409)
    // 这两个字段决定 worker 做什么：STALE = 停手，EXPIRED = 加快或停手
    assert.equal(e.code, 'LEASE_EPOCH_STALE')
    assert.equal(e.currentEpoch, 4)
    return true
  })
  // 队列空时 claim 返回 null（不是抛错）：「没事可做」不是异常
  const empty = createHubClient({ baseUrl: 'http://x', token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, claimed: null }) }) })
  assert.equal(await empty.claim({ workerId: 'w1' }), null)
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
      executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) },
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

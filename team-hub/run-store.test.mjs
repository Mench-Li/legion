// team-hub/run-store.test.mjs
// ============================================================================
// PRT-302 / PRT-303 / PRT-313 的判据：Attempt、Lease、权威时间、epoch 拒写
//
// 阶段 3 的完成标准是「强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或
// 重复执行已确认的外部写操作」。这一组用例逐条对着它写：
//
//   - 「不丢任务」  → 过期租约被回收，且回收后任务**可被再次领取**（不是卡死）；
//   - 「不伪装成功」→ 未完成的任务状态不得是 done/completed（含全部异常路径）；
//   - 「不重复执行」→ ① 过期 worker 的写入被 epoch 拒掉；
//                     ② 可能已产生外部副作用的执行被挂起等人工，而不是自动重跑；
//                     ③ 并发领取下同一条任务只会被一个 worker 拿到。
//
// 所有时间都由注入的 clock 决定，因此「租期到期」是**确定性跨过去**的，
// 不 sleep。唯一一处真实并发用的是两个**独立的 SQLite 连接**（模拟两个进程），
// 因为「同一条任务被领两次」这件事只有在真的有两个写入者时才可能发生。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  RUN_ERRORS,
  createRunStore,
  ensureRunSchema,
  mapOutcomeToState,
} from './run-store.mjs'
import { createContextStore, ensureContextSchema } from './context-store.mjs'
import { readFileSync as readSrc } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
import { assembleContext } from '../runtime/context/assembler.mjs'
import { TOKEN_ESTIMATOR_KINDS } from '../runtime/contracts/context.mjs'

/** 建一个临时库 + 最小 tasks 表（与 server.mjs 的列对齐到本项目用到的部分）。 */
function makeEnv({ startMs = 1_700_000_000_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-runstore-'))
  const dbFile = join(root, 'team.db')
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  let clockMs = startMs
  const clock = () => clockMs
  const advance = (ms) => { clockMs += ms; return clockMs }
  // PRT-411：`BuildingContext → Running` 现在**真的**要求一份已落库的上下文快照。
  // 夹具因此必须建那张表——否则闸门在"表不存在"与"没有快照"之间分不出来。
  ensureContextSchema(db)
  const store = createRunStore({ db, clock })
  const addTask = (id, { status = 'todo', scope = 'default', priority = 'medium', hold = 0 } = {}) => {
    db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, id, priority, status, scope, hold, new Date(clockMs).toISOString(), new Date(clockMs).toISOString())
    return id
  }
  const taskStatus = (id) => db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)?.status ?? null
  /**
   * 冻结这份 Attempt 的上下文——真实 worker 在 `buildContext` 阶段做的事。
   *
   * 走**真实的写入路径**（assembleContext → contextStore.record）而不是手写一条
   * INSERT：后者要把 20 个 NOT NULL 列名抄一遍，而那些列一旦增删，
   * 这份夹具会**静默地**与真实表结构脱节（插入报错还算好的，
   * 列名恰好还兼容时才真正难查）。用例考的是迁移闸门，不是快照写入，
   * 所以这里要的是"用最少的、不会漂移的机制让证据存在"。
   */
  const ctxStore = createContextStore({ db, clock, writeAudit: () => {} })
  const freezeContext = (attemptId, { runId = 'run-test' } = {}) => {
    const snap = assembleContext({
      attemptId,
      runId,
      frozenAtMs: clockMs,
      candidates: [],
      policy: { scope: 'default', canRead: () => true, maxTokens: null },
      tokenizer: { kind: TOKEN_ESTIMATOR_KINDS.EXACT, count: () => 0 },
    })
    ctxStore.record(snap, { scope: 'default', actor: 'test' })
    return attemptId
  }
  return {
    root, dbFile, db, store, clock, advance, addTask, taskStatus, freezeContext,
    cleanup() { try { db.close() } catch { /* 已关 */ } rmSync(root, { recursive: true, force: true }) },
  }
}

/** 断言抛出的是具名仓储错误。 */
function assertRunError(fn, code) {
  try {
    fn()
  } catch (e) {
    assert.equal(e.code, code, `期望错误码 ${code}，实际 ${e.code}（${e.message}）`)
    return e
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`)
}

// ---------------------------------------------------------------- ① 建表与领取

test('① 建表幂等：重复 ensureRunSchema 不报错，且历史表相关路径不提供 UPDATE', () => {
  const env = makeEnv()
  try {
    ensureRunSchema(env.db)
    ensureRunSchema(env.db)
    const tables = env.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    assert.ok(tables.includes('run_attempts'))
    assert.ok(tables.includes('run_attempt_events'))
    // 历史表只有 seq 主键，没有 updatedAt —— 结构上就无法「修改一条历史」
    const cols = env.db.prepare('PRAGMA table_info(run_attempt_events)').all().map((c) => c.name)
    assert.equal(cols.includes('updated_at_ms'), false)
    assert.equal(cols.includes('updated_at'), false)
  } finally { env.cleanup() }
})

test('① 空队列返回 claimed: null 且不是一个错误（「没事可做」不是异常）', () => {
  const env = makeEnv()
  try {
    const r = env.store.claim({ workerId: 'w1' })
    assert.equal(r.ok, true)
    assert.equal(r.claimed, null)
    assert.equal(r.reason, 'queue-empty')
    assert.equal(typeof r.serverTimeMs, 'number')
  } finally { env.cleanup() }
})

test('① 领取把 todo 任务变成第 1 次尝试，并返回 leaseEpoch 与到期时间', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const r = env.store.claim({ workerId: 'w1' })
    assert.equal(r.claimed.taskId, 't1')
    assert.equal(r.claimed.attemptNo, 1)
    assert.equal(r.claimed.attemptId, 'att:t1:1')
    assert.equal(r.claimed.state, 'Leased')
    assert.equal(r.claimed.leaseEpoch, 1, '第一次领取的 epoch 从 1 开始（0 表示「还没被领过」）')
    assert.equal(r.claimed.leaseExpiresAtMs, r.serverTimeMs + DEFAULT_LEASE_TTL_MS)
    assert.equal(env.store.getAttempt('att:t1:1').workerId, 'w1')
  } finally { env.cleanup() }
})

test('① 已被 hold 的任务不得被领取（将军拦截优先于队列）', () => {
  const env = makeEnv()
  try {
    env.addTask('t-hold', { hold: 1 })
    const r = env.store.claim({ workerId: 'w1' })
    assert.equal(r.claimed, null)
    assert.equal(r.reason, 'queue-empty')
    assert.equal(env.taskStatus('t-hold'), 'todo', '被拦截的任务状态不得被领取动作改写')
  } finally { env.cleanup() }
})

test('① 已在进行的看板任务不会被重复入队（同一任务不得有两条活跃尝试）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1', { status: 'in_progress' })
    const r = env.store.claim({ workerId: 'w1' })
    assert.equal(r.claimed, null)
    assert.equal(env.store.historyOf('t1').length, 0, '非 todo 任务不该被凭空造出尝试')
  } finally { env.cleanup() }
})

test('① 高优先级先被领取（队列顺序不是随机的）', () => {
  const env = makeEnv()
  try {
    env.addTask('t-low', { priority: 'low' })
    env.addTask('t-high', { priority: 'high' })
    const r = env.store.claim({ workerId: 'w1' })
    assert.equal(r.claimed.taskId, 't-high')
  } finally { env.cleanup() }
})

test('① 分空间领取：指定 scope 时不得领到别的空间的任务', () => {
  const env = makeEnv()
  try {
    env.addTask('t-a', { scope: 'space-a' })
    env.addTask('t-b', { scope: 'space-b' })
    const r = env.store.claim({ workerId: 'w1', scope: 'space-b' })
    assert.equal(r.claimed.taskId, 't-b')
    assert.equal(r.claimed.attemptId, 'att:t-b:1')
    // 不指定 scope 时才可能领到另一个空间
    const r2 = env.store.claim({ workerId: 'w2' })
    assert.equal(r2.claimed.taskId, 't-a')
  } finally { env.cleanup() }
})

test('① 领取输入校验：workerId 必填，租期必须是正数且有上限', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    assertRunError(() => env.store.claim({ workerId: '' }), RUN_ERRORS.WORKER_REQUIRED)
    assertRunError(() => env.store.claim({ workerId: '  ' }), RUN_ERRORS.WORKER_REQUIRED)
    assertRunError(() => env.store.claim({ workerId: 'w1', leaseTtlMs: 0 }), RUN_ERRORS.BAD_LEASE_TTL)
    assertRunError(() => env.store.claim({ workerId: 'w1', leaseTtlMs: -1 }), RUN_ERRORS.BAD_LEASE_TTL)
    assertRunError(() => env.store.claim({ workerId: 'w1', leaseTtlMs: 1.5 }), RUN_ERRORS.BAD_LEASE_TTL)
    // 超长租期 = 没有租约：崩溃的 worker 会一直占着任务，外部只看到「队列不动」
    const tooLong = assertRunError(() => env.store.claim({ workerId: 'w1', leaseTtlMs: MAX_LEASE_TTL_MS + 1 }), RUN_ERRORS.BAD_LEASE_TTL)
    assert.match(tooLong.message, /等于没有租约/)
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ② 权威时间

test('② 客户端时间被忽略并如实回报（租期不能由持有者自己申报）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const liar = env.clock() + 999_999_999
    const r = env.store.claim({ workerId: 'w1', nowMs: liar })
    assert.deepEqual([...r.ignoredClientFields], ['nowMs'])
    // 到期时间以**服务端**时钟为准，而不是客户端声称的那个未来
    assert.equal(r.claimed.leaseExpiresAtMs, r.serverTimeMs + DEFAULT_LEASE_TTL_MS)
    assert.notEqual(r.claimed.leaseExpiresAtMs, liar + DEFAULT_LEASE_TTL_MS)
  } finally { env.cleanup() }
})

test('② 心跳续租延长到期时间；请求里带的时间不参与判定', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.advance(30_000)
    const hb = env.store.heartbeat({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', nowMs: env.clock() + 10_000_000 })
    assert.deepEqual([...hb.ignoredClientFields], ['nowMs'])
    assert.equal(hb.leaseExpiresAtMs, env.clock() + DEFAULT_LEASE_TTL_MS)
    assert.ok(hb.leaseExpiresAtMs > c.leaseExpiresAtMs)
  } finally { env.cleanup() }
})

test('② 心跳区分三种失败：epoch 不符 / 已被他人持有 / 租期已过', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    // 租期已过：你还是持有者，但超过了自己承诺的时间窗 → 该加快/停手
    env.advance(DEFAULT_LEASE_TTL_MS + 1)
    const expired = assertRunError(
      () => env.store.heartbeat({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1' }),
      RUN_ERRORS.LEASE_EXPIRED)
    assert.equal(expired.leaseExpiresAtMs, c.leaseExpiresAtMs)
    // epoch 不符：已经有人接管了 → 立刻停手，不要提交
    const stale = assertRunError(
      () => env.store.heartbeat({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch + 5, workerId: 'w1' }),
      RUN_ERRORS.LEASE_EPOCH_STALE)
    assert.equal(stale.currentEpoch, c.leaseEpoch)
    // epoch 对但 worker 不同：状态被外部改过
    assertRunError(
      () => env.store.heartbeat({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-other' }),
      RUN_ERRORS.LEASE_NOT_HELD)
    // 不存在的尝试
    assertRunError(() => env.store.heartbeat({ attemptId: 'att:nope:1', leaseEpoch: 1, workerId: 'w1' }), RUN_ERRORS.ATTEMPT_NOT_FOUND)
    // epoch 缺失：不带 epoch 的写入无法证明「我还是持有者」
    assertRunError(() => env.store.heartbeat({ attemptId: c.attemptId, workerId: 'w1' }), RUN_ERRORS.EPOCH_REQUIRED)
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ③ epoch 拒写

test('③ 过期 worker 的写入被拒，且错误里带**当前** epoch（只说「拒绝」会让它无限重试）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const first = env.store.claim({ workerId: 'w-old' }).claimed
    // 租约过期 → 回收 → 新 worker 领到（epoch 前进）
    env.advance(DEFAULT_LEASE_TTL_MS + 1)
    env.store.recoverExpired({ externalEffectPossible: false })
    const second = env.store.claim({ workerId: 'w-new' }).claimed
    assert.equal(second.taskId, 't1')
    assert.equal(second.leaseEpoch, 1, '新尝试的 epoch 从 1 重新开始（它是另一条尝试）')

    // 老 worker 醒了，以为自己还在跑
    const stale = assertRunError(() => env.store.transition({
      attemptId: first.attemptId, leaseEpoch: first.leaseEpoch, workerId: 'w-old', outcome: 'completed',
    }), RUN_ERRORS.LEASE_EPOCH_STALE)
    assert.equal(stale.currentEpoch, 2,
      '必须告诉它真实 epoch（回收时推进），否则它会收到「迁移非法」这种误导性的错误：' +
      '它确实没写进去，但它会以为「我状态写错了」而不是「我已经不是持有者了，我该停手」')
    assert.match(stale.message, /过期的 worker 不得改写别人的结果/)
    // 关键：被拒之后那条尝试的状态**没有被改写**
    assert.equal(env.store.getAttempt(first.attemptId).state, 'RetryableFailure')
    assert.notEqual(env.store.getAttempt(first.attemptId).outcome, 'completed')
  } finally { env.cleanup() }
})

test('③ 同一尝试的旧 epoch 写入被拒（epoch 是单调的，不是「随便给个数字」）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    assert.equal(c.leaseEpoch, 1)
    // 用 0（=「还没被领过」）去写，必须被拒
    env.freezeContext(c.attemptId)
    assertRunError(() => env.store.transition({ attemptId: c.attemptId, leaseEpoch: 0, workerId: 'w1', to: 'Running' }), RUN_ERRORS.LEASE_EPOCH_STALE)
    assertRunError(() => env.store.release({ attemptId: c.attemptId, leaseEpoch: 99, workerId: 'w1' }), RUN_ERRORS.LEASE_EPOCH_STALE)
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ④ 状态机接线

test('④ 结果名义映射：completed 落到 Validating 而不是 Completed（执行完成 ≠ 交付被接受）', () => {
  assert.equal(mapOutcomeToState('completed'), 'Validating')
  assert.equal(mapOutcomeToState('failed'), 'RetryableFailure')
  assert.equal(mapOutcomeToState('outcome_unknown'), 'UnknownOutcome')
  assert.equal(mapOutcomeToState('cancelled'), 'Cancelled')
  // 未知名义**不猜**：猜错的方向是「把失败记成完成」
  assert.equal(mapOutcomeToState('whatever'), null)
  assert.equal(mapOutcomeToState(null), null)
})

test('④ 无法确定目标状态时拒绝写入（不给默认值）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'whatever',
    }), RUN_ERRORS.UNKNOWN_OUTCOME)
    assert.match(e.message, /不做默认/)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Leased', '被拒的迁移不得留下半个状态')
  } finally { env.cleanup() }
})

test('④ 非法迁移被状态机拒掉，仓储码与状态机码各自可辨', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    // Leased → Completed 是跳状态（没跑过工作区/上下文/验收）
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Completed', context: { hasNextPost: false },
    }), RUN_ERRORS.TRANSITION_REJECTED)
    // 两个字段各有各的读者：调用方按仓储码分支，告警按状态机码分类。
    // 合成一个字段会让「仓储码有时候是状态机码」，于是谁都不能依赖它。
    assert.equal(e.stateMachineCode, 'ILLEGAL_TRANSITION')
    assert.equal(e.from, 'Leased')
    assert.equal(e.to, 'Completed')
    assert.match(e.message, /不是合法迁移/)
  } finally { env.cleanup() }
})

test('④ 正常路径逐段可走，且每段落库的要求（requiresPersist）被回报', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    let r = env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    assert.deepEqual([...r.requiresPersist], ['attempt'])
    r = env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'BuildingContext' })
    assert.deepEqual([...r.requiresPersist], ['attempt', 'workspace'])
    env.freezeContext(c.attemptId)
    r = env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Running' })
    assert.deepEqual([...r.requiresPersist], ['attempt', 'contextSnapshot'])
    assert.equal(r.taskStatus, 'in_progress')
    assert.equal(env.taskStatus('t1'), 'in_progress', '运行状态要投影到看板任务')
    r = env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'completed' })
    assert.equal(r.attempt.state, 'Validating')
    assert.equal(r.taskStatus, 'in_review')
    assert.equal(env.taskStatus('t1'), 'in_review')
  } finally { env.cleanup() }
})

test('④ 幂等：重复提交同一次迁移是「已生效」，不追加事件、不报错', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    // 走完整段正常路径：Leased → PreparingWorkspace → BuildingContext → Running → Validating
    for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
      if (to === 'Running') env.freezeContext(c.attemptId)
      env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to })
    }
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'completed' })
    const before = env.store.eventsOf(c.attemptId).length
    const again = env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'completed' })
    assert.equal(again.ok, true)
    assert.equal(again.idempotent, true)
    assert.equal(env.store.eventsOf(c.attemptId).length, before, '重放不得写第二条事件')
  } finally { env.cleanup() }
})

test('④ UnknownOutcome 不得回到队列：仓储层同样返回具名码', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'BuildingContext' })
    env.freezeContext(c.attemptId)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Running' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    assert.equal(env.store.getAttempt(c.attemptId).state, 'UnknownOutcome')
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Queued',
    }), RUN_ERRORS.TRANSITION_REJECTED)
    assert.equal(e.stateMachineCode, 'UNKNOWN_OUTCOME_NOT_RETRYABLE')
    assert.match(e.message, /重复副作用/)
    // 任务不得显示为「待办」，否则它会被再次领取并重跑
    assert.notEqual(env.taskStatus('t1'), 'todo')
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ⑤ 不可覆盖历史

test('⑤ 重试新建尝试，历史尝试不被改写（「试过几次、每次错在哪」必须能查）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const a1 = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: a1.attemptId, leaseEpoch: a1.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({
      attemptId: a1.attemptId, leaseEpoch: a1.leaseEpoch, workerId: 'w1', to: 'RetryableFailure',
      context: { failureCode: 'runtime-unavailable', detail: '引擎没起来' },
    })
    // 重试：RetryableFailure → Queued 在状态机里是 createsNewAttempt
    const retry = env.store.transition({
      attemptId: a1.attemptId, leaseEpoch: a1.leaseEpoch, workerId: 'w1', to: 'Queued',
      context: { retryBudgetRemaining: true },
    })
    assert.equal(retry.createsNewAttempt, true)
    assert.equal(retry.previousAttemptId, a1.attemptId)
    assert.equal(retry.attempt.attemptId, 'att:t1:2')
    assert.equal(retry.attempt.attemptNo, 2)
    assert.equal(retry.attempt.state, 'Queued')

    const history = env.store.historyOf('t1')
    assert.equal(history.length, 2)
    // 第 1 次尝试仍在，且保留了它的失败原因——这就是「不可覆盖」
    assert.equal(history[0].attemptId, 'att:t1:1')
    assert.equal(history[0].state, 'RetryableFailure')
    assert.equal(history[0].failureCode, 'runtime-unavailable')
    assert.equal(history[0].detail, '引擎没起来')
    assert.equal(history[1].attemptId, 'att:t1:2')

    // 新尝试可被领取，且只能领到**最新的**那一次（历史尝试不会被反复领取）
    const again = env.store.claim({ workerId: 'w2' }).claimed
    assert.equal(again.attemptId, 'att:t1:2')
    assert.equal(again.attemptNo, 2)
    const third = env.store.claim({ workerId: 'w3' })
    assert.equal(third.claimed, null, '同一任务不得同时有两条活跃尝试')
  } finally { env.cleanup() }
})

test('⑤ 事件流只追加：每次迁移一条，序号单调，且带 requiresPersist 证据', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    const events = env.store.eventsOf(c.attemptId)
    assert.deepEqual(events.map((e) => e.toState), ['Queued', 'Leased', 'PreparingWorkspace'])
    assert.deepEqual(events.map((e) => e.fromState), [null, 'Queued', 'Leased'])
    assert.equal(events[1].actor, 'w1')
    assert.equal(events[1].leaseEpoch, 1)
    assert.deepEqual(events[1].requiresPersist, ['attempt', 'lease'])
    for (let i = 1; i < events.length; i += 1) assert.ok(events[i].seq > events[i - 1].seq, 'seq 必须单调')
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ⑥ 回收与恢复

test('⑥ 过期租约回收：未越过外部写边界 → 新建尝试重试，任务可被再次领取（不丢任务）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w-dead' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-dead', to: 'PreparingWorkspace' })
    env.advance(DEFAULT_LEASE_TTL_MS + 1)

    let seen = null
    const r = env.store.recoverExpired({ externalEffectPossible: (a) => { seen = a; return false } })
    assert.equal(r.recovered.length, 1)
    assert.equal(r.recovered[0].action, 'retry-new-attempt')
    assert.equal(r.recovered[0].newAttemptId, 'att:t1:2')
    // 判定函数拿到的必须是**那条尝试**，而不是整张表
    assert.equal(seen.attemptId, c.attemptId)
    assert.equal(seen.state, 'PreparingWorkspace')
    // 不丢任务：回收后立刻能被领走
    const again = env.store.claim({ workerId: 'w-fresh' }).claimed
    assert.equal(again.attemptId, 'att:t1:2')
    assert.equal(env.taskStatus('t1'), 'in_progress')
  } finally { env.cleanup() }
})

test('⑥ 可能已产生外部副作用 → 挂起等人工，**绝不**自动重跑', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w-dead' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-dead', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-dead', to: 'BuildingContext' })
    env.freezeContext(c.attemptId)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-dead', to: 'Running' })
    env.advance(DEFAULT_LEASE_TTL_MS + 1)

    const r = env.store.recoverExpired({ externalEffectPossible: (a) => a.state === 'Running' })
    assert.equal(r.recovered[0].action, 'mark-unknown-outcome')
    assert.equal(env.store.getAttempt(c.attemptId).state, 'UnknownOutcome')
    // 关键：没有新尝试被创建，任务也**不能**被再领走
    assert.equal(env.store.historyOf('t1').length, 1)
    assert.equal(env.store.claim({ workerId: 'w-fresh' }).claimed, null)
    assert.equal(env.taskStatus('t1'), 'blocked', '等人工的任务不得显示为待办')
  } finally { env.cleanup() }
})

test('⑥ 缺少「外部副作用是否可能已发生」时拒绝回收（这一条不能猜）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.advance(DEFAULT_LEASE_TTL_MS + 1)
    const e = assertRunError(() => env.store.recoverExpired({}), 'EXTERNAL_EFFECT_UNKNOWN')
    assert.match(e.message, /不能猜/)
    // 被拒之后什么都没动
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Leased')
    assert.equal(env.store.historyOf('t1').length, 1)
  } finally { env.cleanup() }
})

test('⑥ 未过期的租约不被回收（正常执行中的任务不得被抢走）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.advance(DEFAULT_LEASE_TTL_MS - 1000)
    const r = env.store.recoverExpired({ externalEffectPossible: false })
    assert.equal(r.scanned, 0)
    assert.equal(r.recovered.length, 0)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'PreparingWorkspace')
  } finally { env.cleanup() }
})

test('⑥ 已终结的尝试即使租约字段还在也不会被回收（终态不得被改写）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Cancelled' })
    env.advance(DEFAULT_LEASE_TTL_MS + 1)
    const r = env.store.recoverExpired({ externalEffectPossible: true })
    assert.equal(r.scanned, 0)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Cancelled')
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ⑦ 放弃与统计

test('⑦ 优雅释放回到 RetryableFailure（不是直接回队列，否则同一次尝试会被重跑）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    // 走到 Running 再释放：这才是「正在执行时收到 SIGTERM」的真实场景
    for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
      // 进 Running 前必须先冻结上下文（PRT-411）；没有快照就没有"模型当时看到了什么"。
      if (to === 'Running') env.freezeContext(c.attemptId)
      env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to })
    }
    const r = env.store.release({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', reason: 'SIGTERM' })
    assert.equal(r.released, true)
    assert.equal(r.attempt.state, 'RetryableFailure')
    const events = env.store.eventsOf(c.attemptId)
    // 释放事件后面还会跟一条 epoch 作废事件，因此按 reason 找而不是取最后一条
    assert.ok(events.some((e) => e.reason === 'SIGTERM'), `事件流里应有 reason=SIGTERM 的记录：${JSON.stringify(events.map((e) => e.reason))}`)
    // 释放必须推进 epoch：否则「先释放再提交」会被状态机当成一次合法迁移接受
    assert.ok(events.some((e) => e.reason === 'SIGTERM:lease-invalidated'))
    const invalidated = events.find((e) => e.reason === 'SIGTERM:lease-invalidated')
    assert.equal(invalidated.leaseEpoch, c.leaseEpoch + 1, '释放后 epoch 必须前进，旧 epoch 的写入才会被拒')
    assert.equal(env.store.getAttempt(c.attemptId).leaseEpoch, c.leaseEpoch + 1)
    // 释放后不得仍被这条尝试占用：它已终结，新尝试才代表可执行
    assert.equal(env.store.stats().byState.Leased, 0)
  } finally { env.cleanup() }
})

test('⑦ 释放必须立刻让任务可被重新领取（「让别人接」不能等到租期过期）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w-leaving' }).claimed
    const r = env.store.release({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-leaving', reason: 'SIGTERM' })
    // 释放要**同时**做两件事：终结当前尝试（历史保留）、排一次新尝试。
    // 只终结不排队的话，队列里没有任何 Queued 尝试，任务要一直等到
    // lease_expires_at_ms 过期、被恢复扫描捡起来才能再做一次——
    // 而释放的全部意义就是不等租期自然过期；那样 SIGTERM 时释放与不释放没有区别。
    assert.equal(r.nextAttemptId, 'att:t1:2')
    assert.equal(r.attemptNo, 2)
    // 立刻就能被另一个 worker 领走，不必等租期
    const next = env.store.claim({ workerId: 'w-taking-over' }).claimed
    assert.equal(next.attemptId, 'att:t1:2')
    assert.equal(next.attemptNo, 2)
    assert.equal(next.state, 'Leased')
    // 第 1 次尝试仍在，且它的失败原因不会被覆盖
    const history = env.store.historyOf('t1')
    assert.equal(history.length, 2)
    assert.equal(history[0].state, 'RetryableFailure')
    assert.equal(history[1].state, 'Leased')
  } finally { env.cleanup() }
})

test('⑦ 排队中的尝试也必须遵守将军拦截（hold 优先于队列，且不留痕的失效最危险）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.release({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', reason: 'SIGTERM' })
    // 此刻库里有一条 Queued 尝试。将军把它 hold 住。
    env.db.prepare('UPDATE tasks SET hold = 1 WHERE id = ?').run('t1')
    assert.equal(env.store.claim({ workerId: 'w2' }).claimed, null,
      '被 hold 的任务即使队列里有 Queued 尝试也不得被领走——「拦截优先于队列」若只在一条候选路径上生效，就等于没有生效')
    // 人工把任务标成已完成，同样不得再被领走
    env.db.prepare('UPDATE tasks SET hold = 0, status = ? WHERE id = ?').run('done', 't1')
    assert.equal(env.store.claim({ workerId: 'w2' }).claimed, null, '人工标成 done 的任务不得被队列里的旧尝试重新拉起来')
    // 放回 todo 后立刻恢复可领取（不是把尝试作废了，只是不执行）
    env.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('todo', 't1')
    assert.equal(env.store.claim({ workerId: 'w2' }).claimed.attemptId, 'att:t1:2')
  } finally { env.cleanup() }
})

test('⑦ 释放终态尝试是幂等的（停止路径上多发一次是正常竞态）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Cancelled' })
    const r = env.store.release({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1' })
    assert.equal(r.ok, true)
    assert.equal(r.alreadyFinished, true)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Cancelled')
  } finally { env.cleanup() }
})

test('⑦ stats：每个已登记状态都有计数，且过期租约单独报出来', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    env.addTask('t2')
    const a = env.store.claim({ workerId: 'w1' }).claimed
    env.store.claim({ workerId: 'w1' })
    env.advance(DEFAULT_LEASE_TTL_MS + 1)
    const s = env.store.stats()
    // 全函数式映射：13 个状态一个不缺，缺的那一支会让「有多少任务卡住」算错
    assert.equal(Object.keys(s.byState).length, 13)
    assert.equal(s.byState.Queued, 0)
    assert.equal(s.byState.Leased, 2)
    assert.equal(s.expiredLeases, 2)
    assert.equal(typeof s.serverTimeMs, 'number')
    assert.equal(a.attemptId, 'att:t1:1')
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- ⑧ 真实并发

test('⑧ 两个独立连接同时领取：同一条任务只可能被一个 worker 拿到', () => {
  const env = makeEnv()
  const db2 = new DatabaseSync(env.dbFile)
  try {
    db2.exec('PRAGMA journal_mode = WAL')
    db2.exec('PRAGMA busy_timeout = 5000')
    env.addTask('t1')
    // 两个仓储 = 两个进程各持一条连接（这才是「同一条任务被领两次」的真实条件）
    const store2 = createRunStore({ db: db2, clock: env.clock })

    // 交替推进，模拟并发交错：A 领 → B 领（应落空）→ A 再领（应落空）
    const a1 = env.store.claim({ workerId: 'w-A' })
    const b1 = store2.claim({ workerId: 'w-B' })
    assert.equal(a1.claimed.taskId, 't1')
    assert.equal(b1.claimed, null, 'B 不得领到已被 A 领走的任务')
    const a2 = env.store.claim({ workerId: 'w-A' })
    assert.equal(a2.claimed, null)

    // 库里只有一条尝试、一个持有者
    const rows = env.db.prepare('SELECT id, worker_id FROM run_attempts').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].worker_id, 'w-A')
    // 历史表里只有一条 Leased 事件
    const leasedEvents = env.db.prepare("SELECT COUNT(*) AS n FROM run_attempt_events WHERE to_state = 'Leased'").get()
    assert.equal(Number(leasedEvents.n), 1)
  } finally {
    try { db2.close() } catch { /* 已关 */ }
    env.cleanup()
  }
})

test('⑧ 两个连接同时写：第二个用过期 epoch 写入被拒，且第一个的结果完好', () => {
  const env = makeEnv()
  const db2 = new DatabaseSync(env.dbFile)
  try {
    db2.exec('PRAGMA journal_mode = WAL')
    db2.exec('PRAGMA busy_timeout = 5000')
    env.addTask('t1')
    const store2 = createRunStore({ db: db2, clock: env.clock })
    const claim = env.store.claim({ workerId: 'w-A' }).claimed
    // B 抢不到租约，于是它拿着一个「它以为的 epoch」来写
    assertRunError(() => store2.transition({
      attemptId: claim.attemptId, leaseEpoch: 0, workerId: 'w-B', to: 'PreparingWorkspace',
    }), RUN_ERRORS.LEASE_EPOCH_STALE)
    // A 的写入不受影响
    const ok = env.store.transition({ attemptId: claim.attemptId, leaseEpoch: claim.leaseEpoch, workerId: 'w-A', to: 'PreparingWorkspace' })
    assert.equal(ok.ok, true)
    assert.equal(env.store.getAttempt(claim.attemptId).state, 'PreparingWorkspace')
  } finally {
    try { db2.close() } catch { /* 已关 */ }
    env.cleanup()
  }
})

test('⑧ 事务失败要完整回滚：被拒的迁移不留半个状态，也不留半条事件', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    const eventsBefore = env.store.eventsOf(c.attemptId).length
    assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Completed',
    }), RUN_ERRORS.TRANSITION_REJECTED)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Leased')
    assert.equal(env.store.getAttempt(c.attemptId).finishedAtMs, null)
    assert.equal(env.store.eventsOf(c.attemptId).length, eventsBefore, '被拒的迁移不得留下事件')
  } finally { env.cleanup() }
})

// ============================================================================
// PRT-411：冻结时点真的是一道闸门
// ============================================================================
//
// 状态机为 `BuildingContext → Running` 声明了 `requiresPersist: ['attempt','contextSnapshot']`。
// 在 PRT-411 之前这条声明**没有实现**——它只是事件流里的一段 JSON，
// 于是 Attempt 可以在没有任何上下文快照的情况下进入 `Running`，
// 而 spec §6.5 要固定住的正是"实际发送给 Runtime 的不可变输入"。
//
// 「声明了一件事」与「保证了一件事」在输出上完全一样，只要没人去违反它。
// 所以这里**去违反它**。

test('⑪ **没有上下文快照就不能进 Running**（声明变成闸门，而不是一段 JSON）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'BuildingContext' })
    // 不冻结，直接进 Running
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Running',
    }), 'EVIDENCE_MISSING')
    // 必须说清**缺的是哪一项**，否则排查只能去看状态机源码
    assert.deepEqual([...e.missing], ['contextSnapshot'])
    // 409 而不是 400：请求本身合法，是当前状态缺前提
    assert.equal(e.statusCode, 409)
    // 而且它**真的没动**：被拒的迁移不得留下半个状态
    assert.equal(env.store.getAttempt(c.attemptId).state, 'BuildingContext')
  } finally { env.cleanup() }
})

test('⑪ 冻结之后就进得去了（闸门不是"总是拒绝"）', () => {
  // 一个总是失败的核验比没有核验更坏：所有人都会学会绕过它。
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'BuildingContext' })
    env.freezeContext(c.attemptId)
    const r = env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Running' })
    assert.equal(r.attempt.state, 'Running')
  } finally { env.cleanup() }
})

test('⑪ 别人（别的 Attempt）的快照不算数——闸门查的是**这一次**', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'BuildingContext' })
    // 给**另一条** Attempt 冻结快照
    env.freezeContext('att:someone-else')
    assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Running',
    }), 'EVIDENCE_MISSING')
  } finally { env.cleanup() }
})

test('⑪ 表不存在时报 EVIDENCE_MISSING 而不是崩成 500', () => {
  // 「查不到快照」与「没有那张表」对这一步是**同一个事实**：没有依据。
  // 让 db.prepare 抛出去会把它变成 500，而 500 说明"我们坏了"，
  // 不是"这一步缺前提"——两者对运维的意义完全不同。
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'BuildingContext' })
    env.db.exec('DROP TABLE run_context_snapshots')
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Running',
    }), 'EVIDENCE_MISSING')
    assert.deepEqual([...e.missing], ['contextSnapshot'])
  } finally { env.cleanup() }
})

test('⑪ 核验清单是**总**的：状态机声明的每一项都有归宿', () => {
  // 一条"没人实现的声明"和一条"实现了的声明"在事件流里长得一模一样。
  // 这里把状态机声明的所有 requiresPersist 名字收齐，逐个问：
  // 它是**已被核验**的，还是**已知未实现**的？两者都行，但必须显式归类。
  const smSrc = readSrc(resolve(HERE, '..', 'orchestrator', 'state-machine', 'transitions.mjs'), 'utf8')
  const src = readSrc(resolve(HERE, 'run-store.mjs'), 'utf8')
  // **已知未实现**的清单。每一条都要有理由，因为"没实现"和"忘了实现"在这里同形。
  //
  // `workspace` 是**这条用例第一次跑就抓到的真实缺口**：
  // 状态机为 `PreparingWorkspace → BuildingContext` 声明了
  // `requiresPersist: ['attempt','workspace']`，而全仓库**没有任何工作区持久化**
  // （没有表、没有 store）——因为 PRT-306 工作区隔离本身还没交付
  // （`inPlaceStages` 明说"原地执行、无隔离"）。所以它此刻**不可能**被核验，
  // 这也正是它必须显式列在这里的原因：那条声明今天是一句空话，
  // 而空话与保证在事件流里长得一模一样。
  // 交付 PRT-306 时必须回来把它从这份清单挪走。
  const KNOWN_UNIMPLEMENTED = [
    'runResult',     // PRT-312 结果提取：尚未建表
    'approval',      // PRT-619 审批冻结：尚未建表
    'reconciliation', // PRT-313 对账：尚未建表
    'workspace',     // PRT-306 工作区隔离未交付，无工作区表可查（见上）
  ]
  const declared = new Set()
  for (const m of smSrc.matchAll(/requiresPersist: Object\.freeze\(\[([^\]]*)\]\)/g)) {
    for (const name of m[1].split(',')) {
      const s = name.trim().replace(/['"]/g, '')
      if (s) declared.add(s)
    }
  }
  for (const name of declared) {
    if (name === 'attempt' || name === 'lease') continue
    const implemented = new RegExp(`^\\s*${name}: `, 'm').test(src)
    const knownUnimplemented = KNOWN_UNIMPLEMENTED.includes(name)
    assert.ok(implemented || knownUnimplemented,
      `\`${name}\` 既没有核验实现，也不在"已知未实现"清单里——` +
      '它是一条**看起来像保证**的声明')
  }
  // 反方向：清单里不该有已经实现了的（那会让清单变成过期文档）
  for (const name of KNOWN_UNIMPLEMENTED) {
    assert.ok(!new RegExp(`^\\s*${name}: `, 'm').test(src),
      `\`${name}\` 已经实现了，应从"已知未实现"清单里移除`)
  }
})

// team-hub/run-store-policy.test.mjs
// ============================================================================
// PRT-309 / PRT-310 / PRT-311：失败之后会怎样
//
// 这一组问的不是「状态存不存在」，而是「失败之后系统做什么」。
// 它单独成文件是因为这四类缺陷有一个共同特征：**都不会报错**。
//
//   ① 无限重试      —— 没有上限时任务安静地永远跑下去，吃掉配额、日志和外部调用次数；
//   ② 停在中间态    —— 任务既没有可领的队列、也不在等人工清单里，
//                      从任何界面看只是"失败了"，而没有人会去处理它；
//   ③ 静默消失      —— DeadLetter/UnknownOutcome 只是历史里的一行，用户以为它还在跑；
//   ④ 重复副作用    —— 一个真的已经交付的结果被当失败重做，
//                      或挂起等人工的尝试因为"又报了一次失败"被重新拉起来。
//
// 时间全部由注入的 clock 决定：退避与租期到期都是**确定性跨过去**的，不 sleep。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  RUN_ERRORS,
  createRunStore,
} from './run-store.mjs'
import { createContextStore, ensureContextSchema } from './context-store.mjs'
import { freezeFixtureContext } from './context-fixture.mjs'

/** 建一个临时库 + 最小 tasks 表。与 run-store.test.mjs 的同名工具保持一致的形状。 */
function makeEnv({ startMs = 1_700_000_000_000, storeOptions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-runpolicy-'))
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
  // PRT-411：进 Running 要求一份已落库的上下文快照。
  ensureContextSchema(db)
  const ctxStore = createContextStore({ db, clock })
  const store = createRunStore({ db, clock, ...storeOptions })
  const addTask = (id, { status = 'todo', scope = 'default', priority = 'medium', hold = 0 } = {}) => {
    db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, id, priority, status, scope, hold, new Date(clockMs).toISOString(), new Date(clockMs).toISOString())
    return id
  }
  const taskStatus = (id) => db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)?.status ?? null
  return {
    root, dbFile, db, store, ctxStore, clock, advance, addTask, taskStatus,
    cleanup() { try { db.close() } catch { /* 已关 */ } rmSync(root, { recursive: true, force: true }) },
  }
}

function assertRunError(fn, code) {
  try {
    fn()
  } catch (e) {
    assert.equal(e.code, code, `期望错误码 ${code}，实际 ${e.code}（${e.message}）`)
    return e
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`)
}

/** 把一次认领推到 `Running`（外部写边界就在这一步之后）。 */
function claimToRunning(env, workerId = 'w1') {
  const c = env.store.claim({ workerId }).claimed
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    if (to === 'Running') freezeFixtureContext({ store: env.ctxStore, attemptId: c.attemptId, frozenAtMs: env.clock(), scope: 'default' })
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId, to })
  }
  return c
}

/**
 * 一路失败到额度耗尽，返回最后一次 `failAndRetry` 的结果。
 *
 * 每次失败之间把退避闸门跨过去（`advance`），因此不 sleep 真实时间。
 */
function failUntilDeadLetter(env, workerId = 'w1') {
  let c = claimToRunning(env, workerId)
  let last = null
  for (let i = 0; i < env.store.maxAttempts + 1; i++) {
    last = env.store.failAndRetry({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: workerId, failureCode: 'runtime-unavailable',
    })
    if (last.action === 'dead-letter') return { last, attemptId: c.attemptId }
    env.advance((last.nextAttemptAtMs ?? env.clock()) - env.clock() + 1)
    c = env.store.claim({ workerId }).claimed
    for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
      if (to === 'Running') freezeFixtureContext({ store: env.ctxStore, attemptId: c.attemptId, frozenAtMs: env.clock(), scope: 'default' })
      env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId, to })
    }
  }
  throw new Error('没能在额度内走到 DeadLetter——这本身就是「无限重试」的征兆')
}

// ---------------------------------------------------------------- PRT-309

test('⑨ 重试真的会退避（退避写进队列，而不只是一个没人用的返回值）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    const r = env.store.failAndRetry({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1', failureCode: 'runtime-unavailable' })
    assert.equal(r.action, 'retry-new-attempt')
    assert.ok(r.nextAttemptAtMs > env.clock(), '退避必须是一个未来的时刻')
    assert.equal(r.nextAttemptAtMs, env.clock() + env.store.backoffPolicy.baseMs,
      '第 1 次失败的退避 = baseMs（默认 2000）')

    // 关键：在退避到期之前，这条尝试**领不到**。
    // 漏掉这道闸门时 retryDelayMs 只是一段纯函数，「退避」这个词在系统里不成立：
    // 一个持续失败的引擎会被立刻反复重试，把配额和日志一起打满。
    assert.equal(env.store.claim({ workerId: 'w2' }).claimed, null,
      '还在退避窗口内的尝试不得被领取')
    assert.equal(env.store.claim({ workerId: 'w2' }).reason, 'queue-empty')

    env.advance(env.store.backoffPolicy.baseMs + 1)
    const next = env.store.claim({ workerId: 'w2' }).claimed
    assert.equal(next.attemptNo, 2, '退避结束后领到的是新建的那次尝试')
  } finally { env.cleanup() }
})

test('⑨ 退避按尝试次数递增，且有上限（指数退避不能无限增长）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const policy = env.store.backoffPolicy
    const seen = []
    let c = claimToRunning(env)
    for (let i = 0; i < 4; i++) {
      const r = env.store.failAndRetry({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1', failureCode: 'runtime-unavailable' })
      assert.equal(r.action, 'retry-new-attempt', `第 ${i + 1} 次应仍在额度内`)
      seen.push(r.nextAttemptAtMs - env.clock())
      env.advance(r.nextAttemptAtMs - env.clock() + 1)
      c = env.store.claim({ workerId: 'w1' }).claimed
      for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
        if (to === 'Running') freezeFixtureContext({ store: env.ctxStore, attemptId: c.attemptId, frozenAtMs: env.clock(), scope: 'default' })
        env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to })
      }
    }
    assert.deepEqual(seen, [2000, 4000, 8000, 16000], `退避应为 base×factor^(n-1)：${seen}`)
    assert.ok(Math.max(...seen) <= policy.maxMs, '任何一次退避都不得超过上限')
  } finally { env.cleanup() }
})

test('⑨ 额度用完进 Dead Letter——**不是无限重试**（而无限重试不会报任何错）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const max = env.store.maxAttempts
    const { last, attemptId } = failUntilDeadLetter(env)
    assert.match(last.reason, /重试额度已用完/)
    assert.equal(last.attemptsUsed, max)
    assert.equal(last.maxAttempts, max)

    // 走到 DeadLetter 而不是停在 RetryableFailure：停在中间态的话，
    // 这条任务既没有可领的队列、也不在等人工列表里，从任何界面看都只是"失败了"，
    // 而没有任何人会去处理它。
    const dead = env.store.getAttempt(attemptId)
    assert.equal(dead.state, 'DeadLetter')
    assert.equal(dead.finishedAtMs, env.clock())
    // 事件流里能看出「先失败、后因额度耗尽被丢弃」两步
    const reasons = env.store.eventsOf(attemptId).map((e) => e.reason)
    assert.ok(reasons.some((r) => r !== null && r.includes('retry-budget-exhausted')),
      `事件流缺额度耗尽记录：${JSON.stringify(reasons)}`)
    // 不再有可领取的尝试
    assert.equal(env.store.claim({ workerId: 'w9' }).claimed, null)
    // 任务投影为 blocked（需要人看一眼），不是 todo
    assert.equal(env.taskStatus('t1'), 'blocked')
  } finally { env.cleanup() }
})

test('⑨ maxAttempts 非法时拒绝，而不是当成「不重试」静默执行', () => {
  const env = makeEnv()
  try {
    for (const bad of [0, -1, 1.5, 'many']) {
      assert.throws(() => createRunStore({ db: env.db, clock: env.clock, maxAttempts: bad }),
        (e) => e.code === RUN_ERRORS.BAD_MAX_ATTEMPTS,
        `maxAttempts=${JSON.stringify(bad)} 必须拒绝：悄悄按「不重试」执行会让配置错误表现为「任务全都只试一次就进 Dead Letter」`)
    }
    // 1 是合法配置（只做首次、不重试）
    const s = createRunStore({ db: env.db, clock: env.clock, maxAttempts: 1 })
    assert.equal(s.maxAttempts, 1)
  } finally { env.cleanup() }
})

test('⑨ 失败上报必须走完备路径：不允许任务停在 RetryableFailure（没人会处理它）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    const r = env.store.failAndRetry({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1',
      failureCode: 'runtime-unavailable', detail: '上游 502',
    })
    assert.equal(r.action, 'retry-new-attempt')
    // 旧尝试保留失败原因（不可覆盖）
    const old = env.store.getAttempt(c.attemptId)
    assert.equal(old.state, 'RetryableFailure')
    assert.equal(old.failureCode, 'runtime-unavailable')
    assert.equal(old.detail, '上游 502')
    // 新尝试已经在队列里，且**共享同一个幂等键**
    assert.equal(r.nextAttempt.taskId, 't1')
    assert.equal(r.nextAttempt.attemptNo, 2)
    assert.equal(r.nextAttempt.idempotencyKey, old.idempotencyKey,
      '重试必须复用同一个幂等键：换了键，外部系统就无法判断「这是同一次操作的重试」，去重失效')
    assert.equal(r.nextAttempt.state, 'Queued')
  } finally { env.cleanup() }
})

test('⑨ 重复上报同一个失败不会重复排队（崩溃后重放是正常路径）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    const first = env.store.failAndRetry({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1', failureCode: 'runtime-unavailable' })
    assert.equal(first.action, 'retry-new-attempt')
    // 同一个 worker 因为崩溃重放又报了一次：此时它的 epoch 已经过期
    const replay = assertRunError(() => env.store.failAndRetry({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1', failureCode: 'runtime-unavailable',
    }), RUN_ERRORS.LEASE_EPOCH_STALE)
    assert.match(replay.message, /不能替别人报失败/)
    // 不带 epoch 的系统侧重放是 no-op，不产生第三次尝试。
    // 这一条是**必须**的：`RetryableFailure` 已经结算过了，若继续处理会再触发一次
    // `RetryableFailure → Queued`，于是一次失败被结算两次、排出两条排队尝试，
    // 之后同一条任务会被两个 worker 各领一条——重复副作用，而没有任何报错。
    const again = env.store.failAndRetry({ attemptId: c.attemptId, actor: 'system' })
    assert.equal(again.alreadySettled, true)
    assert.equal(again.action, 'noop')
    assert.equal(again.reason, 'already-settled')
    assert.equal(env.store.historyOf('t1').length, 2, '重放不得产生第三次尝试')
  } finally { env.cleanup() }
})

test('⑨ 租约过期回收也要查额度——「每次快失败就被杀」的任务不得永远重试', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const max = env.store.maxAttempts
    let deadLettered = null
    for (let i = 0; i < max + 2; i++) {
      const c = env.store.claim({ workerId: 'w1' }).claimed
      if (c === null) break
      // 每次都被强杀：没有任何失败上报，只有租约一次次过期
      env.advance(120000 + 1)
      const rec = env.store.recoverExpired({ externalEffectPossible: false })
      const entry = rec.recovered[0]
      if (entry !== undefined && entry.action === 'dead-letter') { deadLettered = entry; break }
      // 回收后没有退避等待：租期本身就是那段等待
      assert.equal(entry.nextAttemptAtMs, null, '租约过期的回收不应再叠一段退避——等待已经由租期付过了')
    }
    assert.ok(deadLettered !== null, '「每次都被杀」的任务必须最终进 Dead Letter，否则它会永远重试下去')
    assert.equal(deadLettered.attemptsUsed, max)
    assert.equal(env.store.listHeld().items.length, 1)
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- PRT-310

test('⑩ 等人工清单：只列 UnknownOutcome 与 DeadLetter，且标出哪一条才是当前需要处理的', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    env.addTask('t2')
    env.addTask('t3')
    // t1：外部写结果不可确认
    const c1 = claimToRunning(env)
    env.store.transition({ attemptId: c1.attemptId, leaseEpoch: c1.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    // t2：额度耗尽进 DeadLetter
    const t2 = failUntilDeadLetter(env)
    assert.equal(t2.last.action, 'dead-letter')
    // t3：正常失败一次（还在重试中），不该出现在等人工清单里
    const c3 = claimToRunning(env)
    env.store.failAndRetry({ attemptId: c3.attemptId, leaseEpoch: c3.leaseEpoch, actor: 'w1', failureCode: 'x' })

    const held = env.store.listHeld()
    const states = held.items.map((i) => i.state).sort()
    assert.deepEqual(states, ['DeadLetter', 'UnknownOutcome'])
    assert.equal(held.actionable, 2, '两条都是各自任务的最新尝试，都需要人处理')
    // t2 的历史里有 5 条尝试，但只有最新的那条进列表——
    // 否则每次重试都会让待办清单变长，人工要在一堆早已被替代的条目里找活的那些
    assert.equal(env.store.historyOf('t2').length, env.store.maxAttempts)
    assert.equal(held.items.filter((i) => i.taskId === 't2').length, 1)
    assert.equal(held.items.find((i) => i.taskId === 't1').taskStatus, 'blocked')
  } finally { env.cleanup() }
})

// ---------------------------------------------------------------- PRT-311

test('⑪ 对账确认「外部写已发生」→ 按成功继续验收，**绝不重跑**', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    assert.equal(env.store.getAttempt(c.attemptId).state, 'UnknownOutcome')

    const r = env.store.resolveAttempt({
      attemptId: c.attemptId, decision: 'external-effect-happened', actor: 'general', note: '对账单显示已扣费',
    })
    assert.equal(r.action, 'continue-validation')
    assert.equal(r.attempt.state, 'Validating')
    assert.equal(r.attempt.externalEffect, 'confirmed')
    assert.equal(r.attempt.resolvedBy, 'general')
    assert.equal(r.attempt.resolvedNote, '对账单显示已扣费')
    // 不产生新尝试——重跑一个已生效的外部写就是重复副作用
    assert.equal(env.store.historyOf('t1').length, 1)
    assert.equal(env.store.listHeld().items.length, 0, '处置后不再挂在等人工清单上')
  } finally { env.cleanup() }
})

test('⑪ 对账确认「外部写未发生」→ 降级为可重试失败，不直接回队列', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })

    const r = env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'external-effect-absent', actor: 'general' })
    assert.equal(r.action, 'retry-new-attempt')
    assert.equal(r.attempt.externalEffect, 'absent')
    // 旧尝试记下"未知"这件事本身的结局：它就是失败
    assert.equal(r.attempt.state, 'RetryableFailure')
    assert.equal(r.nextAttempt.attemptNo, 2)
    // 仍然不是直接回 Queued：那会让 UnknownOutcome → Queued 的禁令自己失效
    assert.equal(env.store.getAttempt(c.attemptId).state, 'RetryableFailure')
  } finally { env.cleanup() }
})

test('⑪ 处置决定不认识时拒绝，且**不做任何默认**', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    for (const bad of ['retry', 'yes', '', undefined, null]) {
      assert.throws(() => env.store.resolveAttempt({ attemptId: c.attemptId, decision: bad, actor: 'general' }),
        (e) => e.code === 'BAD_DECISION',
        `决定「${bad}」必须被拒绝：猜错的两种结果分别是重复执行一次已生效的外部写、静默丢弃一次已完成的交付`)
    }
    // 状态没被改动
    assert.equal(env.store.getAttempt(c.attemptId).state, 'UnknownOutcome')
    assert.equal(env.store.getAttempt(c.attemptId).externalEffect, null)
    // 处置必须留痕：谁做的决定
    assert.throws(() => env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'cancel' }),
      (e) => e.code === RUN_ERRORS.WORKER_REQUIRED)
  } finally { env.cleanup() }
})

test('⑪ 不需要处置的状态拒绝处置（「有人点错按钮」与「租约不是你的」是两件事）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    const e = assertRunError(() => env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'cancel', actor: 'general' }),
      RUN_ERRORS.NOT_HELD)
    assert.match(e.message, /不需要人工处置/)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Leased', '被拒的处置不得改动状态')
  } finally { env.cleanup() }
})

test('⑪ 处置仍然过状态机：DeadLetter 是终态，不能从它那里"重试"', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'dead-letter', actor: 'general' })
    assert.equal(env.store.getAttempt(c.attemptId).state, 'DeadLetter')
    // 人工处置不是绕过规则的后门：终态上不能凭空再试一次
    const e = assertRunError(() => env.store.resolveAttempt({
      attemptId: c.attemptId, decision: 'external-effect-absent', actor: 'general',
    }), RUN_ERRORS.NOT_HELD)
    assert.match(e.message, /终态/)
  } finally { env.cleanup() }
})

test('⑪ 幂等键跨尝试稳定（含 attempt_no 就等于没有幂等键）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    const first = env.store.getAttempt(c.attemptId)
    assert.equal(first.idempotencyKey, 'idem:t1')
    // 幂等键里不得出现尝试编号：出现了就是每次重试一个新键
    assert.equal(/:\d+$/.test(first.idempotencyKey), false)
    const r = env.store.failAndRetry({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1', failureCode: 'x' })
    assert.equal(r.nextAttempt.idempotencyKey, 'idem:t1')
    // 跨任务必须是不同的键，否则两个任务的外部写会互相去重掉。
    // 用另一个 scope 隔离，避免 t1 的待领尝试干扰这次领取。
    env.addTask('t2', { scope: 'other' })
    const c2 = env.store.claim({ workerId: 'w2', scope: 'other' }).claimed
    assert.equal(c2.taskId, 't2')
    assert.equal(env.store.getAttempt(c2.attemptId).idempotencyKey, 'idem:t2')
    assert.equal(env.store.retryBudgetOf('t1').idempotencyKey, 'idem:t1')
  } finally { env.cleanup() }
})

// ============================================================================
// ⑫ 对账落库（`UnknownOutcome` 四条出边要求的 `reconciliation` 证据）
//
// 这一组盯的是一种**不会报错**的失败：状态机为 `UnknownOutcome → Validating /
// RetryableFailure / DeadLetter / Cancelled` **四条边全部**声明了
// `requiresPersist: ['attempt','reconciliation']`，而在此之前那句话是空话，
// 而且是**两重**的：
//   · `EVIDENCE_CHECKS` 里没有这个探针，`checkEvidence` 直接 `continue` 跳过；
//   · `resolveAttempt()` 的 `move()` **根本不调 `checkEvidence`**——
//     连"被跳过"都算不上，这条边从来没有被闸门看过一眼。
// 于是"外部写到底发生了没有"这个决定只活在 `run_attempts` 的三列里，
// 而 `cancel` 那条路连那三列都不写。两条路的差别在库里都看不出来。
//
//   > 一个"记下来但从不检查"的要求，与一个"没有这个要求"，
//   > 在库里的表现是同一个东西——只不过前者在事件流里看起来像一句保证。
// ============================================================================

/** 这条 Attempt 名下的对账行（按写入顺序）。 */
function reconciliationRows(env, attemptId) {
  return env.db.prepare(
    'SELECT attempt_id, task_id, decision, external_effect, actor, note, lease_epoch, at_ms FROM run_reconciliations WHERE attempt_id = ? ORDER BY seq',
  ).all(attemptId)
}

test('⑫ ★★ 对账未落库时，**通用迁移路由**不得把 UnknownOutcome 推到 Validating', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    assert.equal(env.store.getAttempt(c.attemptId).state, 'UnknownOutcome')
    assert.equal(reconciliationRows(env, c.attemptId).length, 0)

    // 这条断言是本组的全部意义：守卫输入**给足了**（`externalEffectConfirmed: true`），
    // 状态机上这条边是合法的，唯一缺的东西就是"对过账"这件事本身。
    // 没有它，任何人都能绕过人工处置那条路径把一次未知结局判成"写成功了"。
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Validating',
      context: { externalEffectConfirmed: true },
    }), RUN_ERRORS.EVIDENCE_MISSING)
    assert.deepEqual([...e.missing], ['reconciliation'],
      '缺的必须**具名**是 reconciliation——笼统的"证据缺失"排查时只能去读状态机源码')
    // 状态没被推进：拒绝而不是"记一条警告然后继续"
    assert.equal(env.store.getAttempt(c.attemptId).state, 'UnknownOutcome')
  } finally { env.cleanup() }
})

test('⑫ ★★ 每一次人工处置都写一行对账——**四条决定**，含不写 external_effect 的 cancel', () => {
  // `cancel` 单独重要：另外三条决定都经 `setVerdict()` 写 `run_attempts` 的三列，
  // 唯独它不写。若对账复用那三列，"决定不做"这条路上就**没有任何凭据**，
  // 而对账要求的正是"每一次处置都有凭据"。
  const CASES = [
    { decision: 'external-effect-happened', expectEffect: 'confirmed', expectState: 'Validating' },
    { decision: 'external-effect-absent', expectEffect: 'absent', expectState: 'RetryableFailure' },
    { decision: 'dead-letter', expectEffect: null, expectState: 'DeadLetter' },
    { decision: 'cancel', expectEffect: null, expectState: 'Cancelled' },
  ]
  for (const k of CASES) {
    const env = makeEnv()
    try {
      env.addTask('t1')
      const c = claimToRunning(env)
      env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
      const leaseEpoch = env.store.getAttempt(c.attemptId).leaseEpoch

      env.store.resolveAttempt({
        attemptId: c.attemptId, decision: k.decision, actor: 'general', note: `处置：${k.decision}`,
      })

      const rows = reconciliationRows(env, c.attemptId)
      assert.equal(rows.length, 1, `${k.decision}：一次处置必须正好留一行对账`)
      const r = rows[0]
      assert.equal(r.decision, k.decision, `${k.decision}：留下的必须是**这次**的决定`)
      assert.equal(r.actor, 'general', '决定必须能定位到人——"谁判的"是对账要回答的第一个问题')
      assert.equal(r.note, `处置：${k.decision}`)
      assert.equal(r.external_effect, k.expectEffect,
        `${k.decision}：对账要记下"按哪种结论处置的"，而 cancel/dead-letter 的结论是"未确认"（null）而不是编一个`)
      assert.equal(r.attempt_id, c.attemptId)
      assert.equal(r.task_id, 't1', '任务号要跟着行一起走，否则按任务查对账要走一次 join')
      assert.equal(r.lease_epoch, leaseEpoch, '租约世代要留痕：事后要能分出"哪一次持有期间做的决定"')
      assert.equal(Number.isInteger(r.at_ms), true)
      // 状态确实推进了（对账只是**依据**，不是替代品）
      assert.equal(env.store.getAttempt(c.attemptId).state, k.expectState)
    } finally { env.cleanup() }
  }
})

test('⑫ ★ 对账行**只追加**：同一条尝试被二次处置时，第一行不被改写', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    // 第一次：确认没发生 → RetryableFailure（仍允许再处置）
    env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'external-effect-absent', actor: 'general', note: '第一次' })
    const first = reconciliationRows(env, c.attemptId)
    assert.equal(first.length, 1)

    // 第二次：把它兜底成 DeadLetter
    env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'dead-letter', actor: 'ops', note: '第二次' })
    const rows = reconciliationRows(env, c.attemptId)
    assert.equal(rows.length, 2, '两次处置必须留两行——只留最后一行会让"当初为什么这么判"消失')
    // 第一行**逐字段没变**（只追加，不提供 UPDATE/DELETE 路径）
    assert.deepEqual(rows[0], first[0], '历史对账不得被后一次处置改写')
    assert.equal(rows[1].actor, 'ops')
    assert.equal(rows[1].decision, 'dead-letter')

    // ★ 同一件事还要**从公开读方法**再看一遍：上面 `rows` 是我自己写的 SQL，
    // 而产品（路由器、界面）读的是 `reconciliationsOf()`。两者一旦分叉——
    // 比如读方法被写成只回最新一行——"多次处置的历史被折叠"这件事
    // 在只查原始表的断言下**完全看不见**：表里明明两行，读出来一行。
    //
    //   > 一个「按表查」的断言，与一个「按产品的读法查」的断言，
    //   > 在"历史有没有被折叠"上是同一个东西——只不过只有后者会红。
    const viaApi = env.store.reconciliationsOf(c.attemptId)
    assert.equal(viaApi.length, 2, '读方法不得把多次处置折叠成一行')
    assert.deepEqual(viaApi.map((r) => r.decision), ['external-effect-absent', 'dead-letter'],
      '读回来必须是**按发生顺序**的完整历史')
    assert.equal(viaApi[0].note, '第一次')
    assert.equal(viaApi[1].note, '第二次')
    assert.equal(viaApi[0].actor, 'general')
    assert.equal(viaApi[1].actor, 'ops')
  } finally { env.cleanup() }
})

test('⑫ ★ 人工处置走完后，**同一个库**里对账行数是可查的（不是只写在返回值里）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', outcome: 'outcome_unknown' })
    env.store.resolveAttempt({ attemptId: c.attemptId, decision: 'external-effect-happened', actor: 'general' })
    // 关掉数据库连接再重开：对账必须**真的落盘**，而不是活在进程内存里。
    // 一个只改了返回值、没写库的实现，在"处置完当下"看起来完全一样。
    env.db.close()
    const reopened = new DatabaseSync(env.dbFile)
    try {
      const n = reopened.prepare('SELECT COUNT(*) AS n FROM run_reconciliations WHERE attempt_id = ?').get(c.attemptId).n
      assert.equal(n, 1, '重开库之后对账行必须还在')
      const row = reopened.prepare('SELECT decision, actor FROM run_reconciliations WHERE attempt_id = ?').get(c.attemptId)
      assert.equal(row.decision, 'external-effect-happened')
      assert.equal(row.actor, 'general')
    } finally { reopened.close() }
  } finally { env.cleanup() }
})

// ============================================================================
// ⑬ 运行结果落库（`Running` 三条出边要求的 `runResult` 证据）
//
// `Running → Validating / RetryableFailure / UnknownOutcome` 三条边全都声明了
// `requiresPersist: ['attempt','runResult']`（只有 `Running → Cancelled` 不要，
// 取消不产生结果）。在此之前那句话是空话：`EVIDENCE_CHECKS` 里没有这个探针。
//
// ★ 这一组里**最重要的一条是"闸门真的会红"**。本批的设计允许"只报结局、没有引擎
// 输出"也算一条记录（否则每一次引擎抛错都会变成 `EVIDENCE_MISSING`，失败通道
// 整体不可用）——那就有必要证明：这个让步没有把闸门变成恒真。
//
//   > 一条"在有人真的什么都没报时才会红"的断言，
//   > 与一条"任何情况下都不会红"的断言，在绿的时候长得一模一样。
// ============================================================================

/** 这条 Attempt 名下的运行结果行。 */
function runResultRows(env, attemptId) {
  return env.db.prepare(
    'SELECT attempt_id, task_id, outcome, source, code, detail, result_json, run_id, lease_epoch, at_ms FROM run_results WHERE attempt_id = ? ORDER BY seq',
  ).all(attemptId)
}

test('⑬ ★★ 闸门不是恒真的：`Running → Validating` **既不报结局、也不给结果**时必须被拒', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Running')

    // 这一条是本组存在的理由。它模拟的是：有人声称"这次跑完了"，
    // 却说不出它是怎么结束的——没有 outcome、没有引擎结果。
    const e = assertRunError(() => env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'Validating',
    }), RUN_ERRORS.EVIDENCE_MISSING)
    assert.deepEqual([...e.missing], ['runResult'],
      '缺的必须**具名**是 runResult；笼统的"证据缺失"排查时只能去读状态机源码')
    // 拒绝而不是"记一条警告然后继续"：状态不得被推进，库里也不得留下半条记录
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Running')
    assert.equal(runResultRows(env, c.attemptId).length, 0)
  } finally { env.cleanup() }
})

test('⑬ ★ 引擎给了结果 → 原文**逐字**落库，来源标 `engine`', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    // 引擎口径的词表（`succeeded`）与仓储口径（`completed`）**故意不同**，
    // 这一条同时钉住"两套词表没有被悄悄归一"。
    const engineResult = {
      runId: 'run-abc', outcome: 'succeeded', code: null,
      output: '产物正文', usage: { inputTokens: 11, outputTokens: 7 }, userMessage: '运行完成',
    }
    env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1',
      outcome: 'completed', context: { runResult: engineResult, detail: '一句话摘要' },
    })
    assert.equal(env.store.getAttempt(c.attemptId).state, 'Validating')

    const rows = runResultRows(env, c.attemptId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'engine')
    assert.equal(rows[0].outcome, 'completed', '仓储口径那一列必须是 worker 报的结局')
    assert.equal(rows[0].run_id, 'run-abc')
    assert.equal(rows[0].detail, '一句话摘要')
    // 引擎的原文**一字不改**——包括它自己那套词表里的 `succeeded`
    assert.deepEqual(JSON.parse(rows[0].result_json), engineResult,
      '引擎给的 RunResult 必须原样存下：它是"模型当时输出了什么"的唯一凭据')
  } finally { env.cleanup() }
})

test('⑬ ★ 只报结局、没有引擎产出 → 一条 `report-only`，`result` 必须是 **null** 而不是空对象', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1',
      outcome: 'completed', context: { detail: '没有引擎原文' },
    })
    const rows = runResultRows(env, c.attemptId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'report-only')
    assert.equal(rows[0].outcome, 'completed')
    assert.equal(rows[0].result_json, null,
      '没有引擎产出时必须是 null。写个 {} 上去，事后就看不出"引擎没说话"与"引擎说了个空的"')
    // 读回来也必须分得清
    const got = env.store.runResultsOf(c.attemptId)
    assert.equal(got[0].source, 'report-only')
    assert.equal(got[0].result, null)
  } finally { env.cleanup() }
})

test('⑬ ★★ 引擎抛错那条路（`failAndRetry`）也得留下结果——否则每次真失败都被拒', () => {
  // 这一条是上一批量出来的陷阱的回归闸：`Running → RetryableFailure` **也**要求
  // `runResult`，而引擎在抛错时没有终态事件、没有 `result`。
  // 若探针只认"引擎产出的原文"，这里会变成 EVIDENCE_MISSING——**每一次真实失败**。
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    const r = env.store.failAndRetry({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1',
      failureCode: 'RUNTIME_UNAVAILABLE', detail: '引擎炸了',
    })
    assert.equal(r.ok, true, '正常失败路径必须仍然走得通')
    const rows = runResultRows(env, c.attemptId)
    assert.equal(rows.length, 1, '失败也必须有一行结果：它是这条边的证据')
    assert.equal(rows[0].source, 'report-only')
    assert.equal(rows[0].outcome, 'failed')
    assert.equal(rows[0].code, 'RUNTIME_UNAVAILABLE')
    assert.equal(rows[0].result_json, null, '引擎没产出东西，就如实写 null')
  } finally { env.cleanup() }
})

test('⑬ 一条 Attempt 只有一份结果：重放迁移不写第二行', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    const args = {
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1',
      outcome: 'completed', context: { runResult: { runId: 'run-1', outcome: 'succeeded' } },
    }
    env.store.transition(args)
    const first = runResultRows(env, c.attemptId)
    assert.equal(first.length, 1)

    // 重放同一次迁移（worker 写完后崩溃再重放是**正常路径**）
    const again = env.store.transition(args)
    assert.equal(again.ok, true)
    assert.equal(again.idempotent, true)
    const second = runResultRows(env, c.attemptId)
    assert.equal(second.length, 1, '重放不得写第二行结果——一条尝试不会有两份互相矛盾的运行结果')
    assert.deepEqual(second[0], first[0], '重放也不得改写已有那一行')
  } finally { env.cleanup() }
})

test('⑬ 读方法把两套 outcome 词表**都**原样给出，不做翻译', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1',
      outcome: 'completed', context: { runResult: { runId: 'run-1', outcome: 'succeeded' } },
    })
    const got = env.store.runResultsOf(c.attemptId)
    assert.equal(got.length, 1)
    // 仓储口径在列上，引擎口径在 result 里。两者都在，且**互不覆盖**。
    assert.equal(got[0].outcome, 'completed', '列上是仓储口径')
    assert.equal(got[0].result.outcome, 'succeeded', '引擎口径留在原文里，不得被翻译成 completed')
    assert.equal(got[0].source, 'engine')
    assert.equal(Number.isInteger(got[0].atMs), true)
    assert.equal(Number.isInteger(got[0].leaseEpoch), true)
  } finally { env.cleanup() }
})

// ============================================================================
// ⑭ 「卡在 RetryableFailure」必须有人看得见——而**合法重试不能**变成待办
//
// 本批修掉的缺陷（PRT-309）：worker **返回**失败时走的是 `transition` 而不是
// `fail`，于是那次失败没有任何人接手，attempt 停在 `RetryableFailure`、
// 没有后继尝试，而 `task.status` 还是 `todo`——每个看板都把它算成"待办的、
// 还没被领走的"，派发器却永远领不到它。
//
// worker 那一侧已经改成走 `fail`（见 `orchestrator/worker/worker.test.mjs`）。
// 这一组补的是**纵深**：不管是谁造出这个形状（例如直接调通用迁移路由），
// 人工待办清单都必须把它列出来。
//
// 同一份文件里本来就自相矛盾：`resolveAttempt()` 早就把 `RetryableFailure`
// 列为需要人工处置的状态，而这个清单从来不列它——于是那条处置路径
// **没有任何人会被告知去用**。声明了能处置、却没人被通知，与不能处置是一回事。
//
// ★ 但把它收进清单有一个**必须同时守住的反向风险**：每一次合法重试都会留下
// 一条历史的 `RetryableFailure`。若不加区分地列出来，一个重试了 5 次的任务
// 会往待办里塞 4 条早已被替代的条目——清单会被噪音淹没，而"清单被淹没"
// 与"没有清单"在效果上是一样的。所以下面**成对**断言：
//   有 ⇒ 卡住的形状**必须**出现；
//   无 ⇒ 合法重试的中间态**必须不**出现。
// ============================================================================

test('⑭ ★★ 卡在 RetryableFailure（无人接手）必须出现在人工待办里', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    // 通用迁移路由（外部调用方进得来）：把 Running 推到 RetryableFailure 就收工。
    // 这正是 worker 修好之前那条路造出来的形状。
    env.store.transition({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1',
      to: 'RetryableFailure', outcome: 'failed',
    })
    assert.equal(env.store.getAttempt(c.attemptId).state, 'RetryableFailure')

    // 先把"它确实卡住了"量出来：队列里领不到它
    const claim = env.store.claim({ workerId: 'w-next' })
    assert.equal(claim.claimed, null, '这个形状的定义就是"领不到"——领得到就不是卡住')

    // ★ 因此它必须有人看得见。看不到它，任务就是静默停住。
    const held = env.store.listHeld()
    assert.equal(held.actionable, 1,
      '卡住的尝试必须出现在待人工处理的清单里；否则任务状态是 todo 而永远没人管它')
    assert.equal(held.items[0].attemptId, c.attemptId)
    assert.equal(held.items[0].state, 'RetryableFailure')

    // 而且它**真的能被处置**（清单里列出来但处置不了，等于没列）
    const r = env.store.resolveAttempt({
      attemptId: c.attemptId, actor: 'ops', decision: 'external-effect-absent', note: '重排',
    })
    assert.equal(r.action, 'retry-new-attempt')
    assert.notEqual(r.nextAttemptId, null, '处置之后必须真的排出一条新尝试')
    assert.equal(env.store.listHeld().actionable, 0, '处置后不再挂在等人工清单上')
  } finally { env.cleanup() }
})

test('⑭ ★★ 合法重试的中间态**不得**进待办清单（否则清单被噪音淹没）', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = claimToRunning(env)
    // 走失败结算的唯一入口：它会终结为 RetryableFailure **并立刻排一条新尝试**
    const r = env.store.failAndRetry({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, actor: 'w1', failureCode: 'runtime-unavailable',
    })
    assert.equal(r.action, 'retry-new-attempt')
    // 库里此刻确实有一条 RetryableFailure（历史）与一条 Queued（最新）
    const states = env.db.prepare('SELECT state FROM run_attempts WHERE task_id = ? ORDER BY attempt_no').all('t1')
      .map((x) => x.state)
    assert.deepEqual(states, ['RetryableFailure', 'Queued'])

    const held = env.store.listHeld()
    assert.equal(held.items.length, 0,
      '历史上那条 RetryableFailure 是**已被接手**的失败——它有人管（新尝试已经在队列里），' +
      '把它列进待办会让每次重试都产出一条假待办')
    assert.equal(held.actionable, 0)
  } finally { env.cleanup() }
})

test('⑭ ★ 额度耗尽进 DeadLetter：清单里是那一条 DeadLetter，不是中间那几条失败', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const { last } = failUntilDeadLetter(env)
    assert.equal(last.action, 'dead-letter')
    // 这条任务一共有 maxAttempts 次失败尝试，但只有最后那条 NeedsHuman
    const total = env.db.prepare('SELECT COUNT(*) AS n FROM run_attempts WHERE task_id = ?').get('t1').n
    assert.ok(total > 1, `本该有多次尝试，实际 ${total}`)

    const held = env.store.listHeld()
    assert.equal(held.items.length, 1, '清单里只该有那一条 DeadLetter，中间态不该混进来')
    assert.equal(held.items[0].state, 'DeadLetter')
    assert.equal(held.actionable, 1, '额度过期的那条才是需要人处理的')
  } finally { env.cleanup() }
})

// ============================================================================
// ⑮ `Queued → Leased` 声明的 `lease` 证据（本批补上的最后一个缺失探针）
//
// 这条边声明 `requiresPersist: ['attempt','lease']`，而那行字旁边自己还写着
// 「领取必须用 team-hub 事务与 team-hub 时钟」。在补探针之前它**只是事件流里的一段
// JSON**：`EVIDENCE_CHECKS` 里没有 `lease`，`checkEvidence` 直接 `continue` 跳过，
// 于是通用迁移路由能造出这个形状（真 `createRunStore` 实测）：
//
//     state='Leased'  lease_epoch=0  lease_expires_at_ms=null  worker_id=null
//
// 一个**没有租约的「已租出」**。两个出口都关着：再 `claim` 领不到（`queue-empty`），
// 回收扫描拿 `lease_expires_at_ms` 比时间而它是 `NULL`（`NULL <= x` 不成立）
// ⇒ 永远不会被判为过期。与 PRT-309 那个缺陷同一形状：安静停住，没人知道。
//
// ★ 成对断言（两个相反方向，缺一个这条边界就没守住）：
//   有 ⇒ 通用路由**必须**被拒，且**不得**留下半个状态、任务**仍可被领走**；
//   无 ⇒ 真正的领取入口 `claim()` **必须**照常可用（探针不能误伤它）。
// ============================================================================

test('⑮ ★★ 通用路由不得凭空造出 Leased：缺 lease 证据就拒，且不动那一行', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    // 先造出一条 Queued 尝试：claim 之后 release，就得到一条全新的 Queued 尝试
    const c0 = env.store.claim({ workerId: 'w0' }).claimed
    env.store.release({ attemptId: c0.attemptId, leaseEpoch: c0.leaseEpoch, workerId: 'w0', reason: 'setup' })
    const q = env.db.prepare("SELECT * FROM run_attempts WHERE task_id = 't1' AND state = 'Queued'").get()
    assert.notEqual(q, undefined, '夹具要先有一条 Queued 尝试')
    // 断言探针的判据确实为假，而不是"碰巧被别的门拦住了"
    assert.equal(q.lease_epoch, 0, 'Queued 行必须还没被领过（否则这条用例测的不是它）')
    assert.equal(q.lease_expires_at_ms, null)

    const e = assertRunError(() => env.store.transition({
      attemptId: q.id, workerId: 'w-forge', leaseEpoch: 0, to: 'Leased',
    }), RUN_ERRORS.EVIDENCE_MISSING)
    assert.deepEqual([...e.missing], ['lease'], '缺的必须是 lease 这一项本身')
    // 错误信息要给出**正确的补救方向**：不是"去补一条租约"，而是"改用 claim()"。
    // 一个错的诊断比没有诊断更坏——顺着"先补租约"走，人会去手写那两列。
    assert.match(e.message, /claim\(\)/, '必须指出正确的路径是 claim()，而不是让人去补租约')

    // ★ 不得留下半个状态：那一行一字未改
    const after = env.db.prepare('SELECT state, lease_epoch, lease_expires_at_ms, worker_id FROM run_attempts WHERE id = ?').get(q.id)
    assert.equal(after.state, 'Queued', '被拒的迁移不得改动状态')
    assert.equal(after.lease_epoch, 0)
    assert.equal(after.lease_expires_at_ms, null)
    assert.equal(after.worker_id, null, '被拒的伪造领取不得留下 worker 归属')

    // ★ 最要紧的一条：被拒之后这条尝试**仍然领得走**。
    // 拒绝的意义是"别用这条路"，不是"把这个任务废掉"——若拒完变成领不到，
    // 那它就从"造出一个假 Leased"退化成"让一个真任务静默停住"，两种都是缺陷。
    const claimed = env.store.claim({ workerId: 'w-real' }).claimed
    assert.notEqual(claimed, null, '被拒之后必须仍能正常领取')
    assert.equal(claimed.attemptId, q.id)
  } finally { env.cleanup() }
})

test('⑮ ★★ 真正的领取入口 claim() 不受影响：它写的是真租约，探针认的就是它', () => {
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c = env.store.claim({ workerId: 'w1' }).claimed
    assert.notEqual(c, null)
    const row = env.db.prepare('SELECT state, lease_epoch, lease_expires_at_ms FROM run_attempts WHERE id = ?').get(c.attemptId)
    assert.equal(row.state, 'Leased')
    // claim 的租约与状态写在**同一条 UPDATE** 里，所以"进入 Leased"与"留下租约"
    // 在构造上同时成立——这正是探针判据（epoch>0 且到期时间非空）的正面样本。
    assert.ok(row.lease_epoch > 0, `claim 必须推进 lease_epoch，实际 ${row.lease_epoch}`)
    assert.notEqual(row.lease_expires_at_ms, null, 'claim 必须写下租约到期时间')

    // 而且从 Leased 往下走**不受**这条探针影响（只有 Queued→Leased 声明了 lease）。
    // 若探针写成"任何迁移都要求租约"，正常流水线会在这里整段卡死。
    env.store.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w1', to: 'PreparingWorkspace' })
    assert.equal(env.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(c.attemptId).state, 'PreparingWorkspace')
  } finally { env.cleanup() }
})

test('⑮ ★★ 探针不是恒假：一行**真的**记着租约时，这条边必须放行', () => {
  // ★ 这一条是**防空洞**用的，而且是必须的：
  // 上面两条用例量的都是"被拒"这个方向，而 `lease: () => false`（一个恒假的探针）
  // 同样满足它们——两个读数一样。若不做这一条，"探针在核验"这件事就没有证据。
  //
  //   > 一个"永远说缺证据"的探针，与一个"真的在核验证据"的探针，
  //   > 在只看"非法的那次被拒了"时是同一个东西——只不过前者拦住的是全部。
  //
  // 为什么必须**直接改库**来构造：本批实测过四种真实流程（release / failAndRetry /
  // recoverExpired / 额度耗尽），库里每一条 `Queued` 行都是 `lease_epoch=0` +
  // 到期时间 null，也就是说探针的"真"分支在正常流程里**到不了**。
  // 既然到不了，就只能把这个状态造出来量——这不是"测一个够不着的分支"，
  // 而是"量那个探针判据本身到底在判什么"。
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c0 = env.store.claim({ workerId: 'w0' }).claimed
    env.store.release({ attemptId: c0.attemptId, leaseEpoch: c0.leaseEpoch, workerId: 'w0', reason: 'setup' })
    const q = env.db.prepare("SELECT * FROM run_attempts WHERE task_id = 't1' AND state = 'Queued'").get()
    assert.equal(q.lease_epoch, 0, '前提：这一行本来是"从没领过"')

    // 造出"这一行记着租约"的状态
    env.db.prepare('UPDATE run_attempts SET lease_epoch = 1, lease_expires_at_ms = ?, worker_id = ? WHERE id = ?')
      .run(1_700_000_120_000, 'w-past', q.id)

    // 判据为真 ⇒ 这条边放行（探针判的是"证据在不在"，不是"这条路许不许用"）
    const r = env.store.transition({ attemptId: q.id, workerId: 'w-forge', leaseEpoch: 1, to: 'Leased' })
    assert.equal(r.attempt.state, 'Leased', '记着租约时必须放行——否则探针就是恒假的')
    assert.equal(env.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(q.id).state, 'Leased')
  } finally { env.cleanup() }
})

test('⑮ ★ 判据是两个条件的**合取**：有 epoch 但没有到期时间，不算"留下了租约"', () => {
  // 探针写的是 `lease_epoch > 0 && lease_expires_at_ms !== null`。只测"被拒"与"放行"
  // 两个端点，是**测不出第二个条件的**——把探针改成只看 `lease_epoch > 0`，
  // 上面两条用例仍然全绿（本批用变异确认过这一点）。
  //
  //   > 一条判据里"多余的那个条件"，与"那个条件被验证过"，
  //   > 在两端都取到极值的用例集合里是同一个东西——只不过前者永远不会被删对。
  //
  // 为什么这个条件在语义上必须有：`lease_expires_at_ms` 是回收扫描唯一的时间依据
  // （它拿这一列与当前时间比）。一行 `lease_epoch > 0` 而到期时间为 `NULL` 的尝试，
  // 正是本批要拦的那个形状的变体——它会被判成"已租出"，却永远不被判为过期。
  // 所以"有 epoch"不等于"有租约"：**没有到期时间的租约不是租约。**
  const env = makeEnv()
  try {
    env.addTask('t1')
    const c0 = env.store.claim({ workerId: 'w0' }).claimed
    env.store.release({ attemptId: c0.attemptId, leaseEpoch: c0.leaseEpoch, workerId: 'w0', reason: 'setup' })
    const q = env.db.prepare("SELECT * FROM run_attempts WHERE task_id = 't1' AND state = 'Queued'").get()

    // 只有 epoch，没有到期时间
    env.db.prepare('UPDATE run_attempts SET lease_epoch = 1, lease_expires_at_ms = NULL WHERE id = ?').run(q.id)
    const e = assertRunError(() => env.store.transition({
      attemptId: q.id, workerId: 'w-forge', leaseEpoch: 1, to: 'Leased',
    }), RUN_ERRORS.EVIDENCE_MISSING)
    assert.deepEqual([...e.missing], ['lease'], '没有到期时间的租约不算租约')
    assert.equal(env.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(q.id).state, 'Queued', '状态不得被推进')
  } finally { env.cleanup() }
})

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

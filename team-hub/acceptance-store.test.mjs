// team-hub/acceptance-store.test.mjs
// ============================================================================
// 机器验收接入运行面（PRT-307）的用例
//
// 上一组（`orchestrator/acceptance/`）问的是"判据过没过"；这一组问的是
// **结论有没有真的生效**：
//   ① 验收记录落库了吗（否则 `requiresPersist` 那句话只是事件流里的一段 JSON）；
//   ② 状态按结论推进了吗（通过 → HandingOff/Completed；打回 → 重试或 DeadLetter；
//      交人工 → AwaitingApproval 且 returnTo=Validating）；
//   ③ 一条**从未被验收过**的尝试能不能进 Completed（不能——这正是"伪装成功"）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createRunStore, ensureRunSchema, RUN_ERRORS } from './run-store.mjs'

/** 造一个带 tasks 表的最小库（列与 run-store.test.mjs 的夹具对齐到本项目用到的部分）。 */
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT, acceptance TEXT DEFAULT '[]'
    )
  `)
  ensureRunSchema(db)
  return db
}

let clockMs = 1_700_000_000_000
const clock = () => clockMs

/** 建库 + 建任务 + 建一条已跑到 Validating 的尝试。 */
function makeEnv({ acceptance = '[]', maxAttempts = 5 } = {}) {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  db.prepare('INSERT INTO tasks (id, title, status, scope, hold, createdAt, updatedAt, acceptance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('t1', '任务一', 'todo', 'default', 0, new Date(clockMs).toISOString(), new Date(clockMs).toISOString(), acceptance)
  const store = createRunStore({ db, clock, maxAttempts })
  const claimed = store.claim({ workerId: 'w1' })
  assert.ok(claimed.claimed !== null, '夹具应当能领到任务')
  const attemptId = claimed.claimed.attemptId
  const epoch = claimed.claimed.leaseEpoch
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to })
  }
  // 执行成功 → Validating（**不是** Completed：机器验收是一道独立关卡）
  store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', outcome: 'completed', detail: 'exec-ok' })
  const st = store.getAttempt(attemptId)
  assert.equal(st.state, 'Validating', '执行成功必须落在 Validating，否则这一组用例问的东西就不存在了')
  return { db, store, attemptId, epoch }
}

const GATE = [{ kind: 'run-completed' }]

test('① 验收结论落库，且只存判定所需的叶子字段', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  const r = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'w1',
    runResult: { outcome: 'completed', detail: 'exec-ok', result: { a: 1 }, artifacts: [{ path: 'x' }], secret: '不该进库的东西' },
    hasNextPost: false,
  })
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'accepted')

  const rows = store.validationsOf(attemptId)
  assert.equal(rows.length, 1, '验收结论必须落库：状态机为 Validating → Completed 声明了 requiresPersist: [attempt, validation]')
  const v = rows[0]
  assert.equal(v.decision, 'accepted')
  assert.equal(v.actor, 'w1')
  assert.equal(v.leaseEpoch, 1)
  assert.deepEqual({ ...v.gate }, { total: 1, passed: 1, failed: 0, unverifiable: 0 })
  assert.deepEqual(v.run.artifactPaths, ['x'])
  // 只存叶子字段：整个 runResult 里未被判定用到的字段不得进库
  const raw = JSON.stringify(rows)
  assert.ok(!raw.includes('不该进库的东西'),
    '验收记录长期保存，不得把整个 runResult 原样落库（可能含产物内容或漏脱敏的东西）')
})

test('① 验收通过 → Completed（链尾）/ HandingOff（还有下一岗位）', () => {
  const chainEnd = makeEnv({ acceptance: JSON.stringify(GATE) })
  const done = chainEnd.store.recordValidation({
    attemptId: chainEnd.attemptId, leaseEpoch: 1, actor: 'w1',
    runResult: { outcome: 'completed' }, hasNextPost: false,
  })
  assert.equal(chainEnd.store.getAttempt(chainEnd.attemptId).state, 'Completed')
  assert.equal(done.taskStatus, 'done')

  const mid = makeEnv({ acceptance: JSON.stringify(GATE) })
  const handed = mid.store.recordValidation({
    attemptId: mid.attemptId, leaseEpoch: 1, actor: 'w1',
    runResult: { outcome: 'completed' }, hasNextPost: true, nextPost: 'reviewer',
  })
  assert.equal(mid.store.getAttempt(mid.attemptId).state, 'HandingOff')
  assert.equal(handed.nextPost, 'reviewer')
})

test('② 验收通过但没说还有没有下一岗位 → 拒绝，且**整笔回滚**（不留验收记录）', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  assert.throws(
    () => store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: undefined }),
    (e) => e.code === 'MISSING_GUARD_INPUT',
    '缺 hasNextPost 时必须拒绝：默认完成会静默掐断任务链，默认交接会创建没有承接方的任务')
  assert.equal(store.getAttempt(attemptId).state, 'Validating', '状态不得推进')
  assert.equal(store.validationsOf(attemptId).length, 0,
    '验收记录必须一起回滚：留一条没有对应状态迁移的记录，会让下一次调用看到"已经验收过了"而不知道它有没有生效')
})

test('③ 从未被验收过的尝试**不能**进 Completed（EVIDENCE_MISSING）', () => {
  // 这是"伪装成功"最直接的形态：直接 transition 到 Completed 而不做验收。
  // 状态机为这条边声明了 requiresPersist: [attempt, validation]；
  // 若只记录不核验，事件流里那句话看起来像是在保证它，而实际上没有。
  const { store, attemptId, epoch } = makeEnv({ acceptance: JSON.stringify(GATE) })
  assert.throws(
    () => store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'Completed', context: { hasNextPost: false } }),
    (e) => e.code === RUN_ERRORS.EVIDENCE_MISSING,
    '没有验收记录就进 Completed 必须被拒绝')
  assert.equal(store.getAttempt(attemptId).state, 'Validating', '被拒绝后状态必须原地不动')
  assert.equal(store.validationsOf(attemptId).length, 0)
})

test('③ 打完验收之后，走完验收的那条边就通了（闸门认的是记录，不是调用方的话）', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: true })
  assert.equal(store.getAttempt(attemptId).state, 'HandingOff')
  // `HandingOff → Completed` 要求 `handoff` 证据（PRT-308）——直接收口会被拒。
  // 这条断言是"闸门真的在管这一步"，不是"这条路走不通"：
  // 没有后继却收口，等于任务链静默断在这里。
  assert.throws(
    () => store.transition({ attemptId, leaseEpoch: 1, workerId: 'w1', to: 'Completed', context: { hasNextPost: false } }),
    (e) => e.code === RUN_ERRORS.EVIDENCE_MISSING,
    '没有交接记录就收口必须被拒绝')
  assert.equal(store.getAttempt(attemptId).state, 'HandingOff', '被拒绝后状态必须原地不动')
})

test('④ 打回：判据确认不满足 → 新建下一次尝试（走重试额度的唯一决策点）', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify([{ kind: 'artifact', path: 'missing.md' }]) })
  const r = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'w1',
    runResult: { outcome: 'completed', artifacts: [] }, hasNextPost: false,
  })
  assert.equal(r.decision, 'rejected')
  assert.equal(r.settlement.action, 'retry-new-attempt')
  assert.equal(store.validationsOf(attemptId)[0].decision, 'rejected')
  const history = store.historyOf('t1')
  assert.equal(history.length, 2, '打回必须新建一次尝试，而不是把旧行改回队列')
  assert.equal(history[0].failureCode, 'acceptance-rejected')
  assert.equal(history[0].state, 'RetryableFailure')
  assert.equal(history[1].state, 'Queued')
  assert.equal(r.taskStatus, 'todo', '还有额度时任务回到可领取')
})

test('④ 打回且额度耗尽 → DeadLetter 等人工（不是无限重试）', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify([{ kind: 'artifact', path: 'missing.md' }]), maxAttempts: 1 })
  const r = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'w1',
    runResult: { outcome: 'completed', artifacts: [] }, hasNextPost: false,
  })
  assert.equal(r.decision, 'rejected')
  assert.equal(r.settlement.action, 'dead-letter')
  assert.equal(store.getAttempt(attemptId).state, 'DeadLetter')
  assert.equal(r.taskStatus, 'blocked')
  assert.equal(store.historyOf('t1').length, 1, '额度耗尽时不得新建尝试')
  // 必须能从等人工清单里找到它，否则"不静默重跑"会变成"静默消失"
  const held = store.listHeld()
  assert.deepEqual(held.items.map((h) => h.attemptId), [attemptId])
  assert.equal(held.actionable, 1, '它是最新一次尝试，因此是可处置的那一条')
})

test('⑤ 判不了 → AwaitingApproval，且 returnTo 是 Validating（批准后不必重跑执行）', () => {
  const { store, attemptId } = makeEnv({ acceptance: '["产出与本阶段职责一致"]' })
  const r = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'w1',
    runResult: { outcome: 'completed' }, hasNextPost: false,
  })
  assert.equal(r.decision, 'needs-human')
  const st = store.getAttempt(attemptId)
  assert.equal(st.state, 'AwaitingApproval')
  assert.equal(st.returnTo, 'Validating',
    'returnTo 必须是 Validating：人工批准后回到验收继续，而不是重跑一次执行')
  assert.equal(r.taskStatus, 'in_review')
  assert.equal(store.validationsOf(attemptId).length, 1)
})

test('⑤ 任务没有声明任何判据 → needs-human（而不是默认为"做完了"）', () => {
  const { store, attemptId } = makeEnv({ acceptance: '[]' })
  const r = store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false })
  assert.equal(r.decision, 'needs-human')
  assert.match(r.reason, /没有声明任何验收判据/)
  assert.equal(store.getAttempt(attemptId).state, 'AwaitingApproval')
})

test('⑤ acceptance 不是合法 JSON → BAD_ACCEPTANCE_CRITERIA（不是"没有判据"）', () => {
  // 数据坏了与"没有判据"是两件事：当成空判据会让它静默挂到人工审批上，
  // 而没人知道那一行坏了、也没人能修。
  const { store, attemptId } = makeEnv({ acceptance: '{"not":"an array"}' })
  assert.throws(
    () => store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false }),
    (e) => e.code === RUN_ERRORS.BAD_ACCEPTANCE_CRITERIA)
  assert.equal(store.getAttempt(attemptId).state, 'Validating')
  assert.equal(store.validationsOf(attemptId).length, 0)

  const broken = makeEnv({ acceptance: '这是坏数据' })
  assert.throws(
    () => broken.store.recordValidation({ attemptId: broken.attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false }),
    (e) => e.code === RUN_ERRORS.BAD_ACCEPTANCE_CRITERIA)
})

test('⑥ 只有在 Validating 上的尝试才能被验收', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  // Running 上的尝试（另造一条）不得被验收
  const claimed = store.claim({ workerId: 'w2' })
  assert.equal(claimed.claimed, null, '夹具只有一个任务')
  // 已完成的尝试再验一次也必须拒绝
  store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false })
  assert.equal(store.getAttempt(attemptId).state, 'Completed')
  assert.throws(
    () => store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false }),
    (e) => e.code === RUN_ERRORS.NOT_VALIDATING,
    '已经结束的尝试不得再被验收：那等于给一份已经生效的结论再出一份')
})

test('⑥ 过期 epoch 不得写入验收结论', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  assert.throws(
    () => store.recordValidation({ attemptId, leaseEpoch: 99, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false }),
    (e) => e.code === RUN_ERRORS.LEASE_EPOCH_STALE && e.currentEpoch === 1,
    '过期 worker 的结论必须被拒绝，并且要告诉它真实的 epoch')
  assert.equal(store.validationsOf(attemptId).length, 0)
})

test('⑥ 需要 actor：谁做的验收决定必须留痕', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  for (const bad of [undefined, null, '', 42]) {
    assert.throws(
      () => store.recordValidation({ attemptId, leaseEpoch: 1, actor: bad, runResult: { outcome: 'completed' }, hasNextPost: false }),
      (e) => e.code === RUN_ERRORS.WORKER_REQUIRED,
      `actor=${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('⑥ runResult 形状不对 → 契约错误且**不落库**（不得变成一条 rejected）', () => {
  const { store, attemptId } = makeEnv({ acceptance: JSON.stringify(GATE) })
  for (const bad of [null, undefined, 'completed', 42, []]) {
    assert.throws(
      () => store.recordValidation({ attemptId, leaseEpoch: 1, actor: 'w1', runResult: bad, hasNextPost: false }),
      (e) => e.code === 'RUN_RESULT_INVALID',
      `runResult=${JSON.stringify(bad)} 必须被拒绝`)
  }
  assert.equal(store.validationsOf(attemptId).length, 0,
    '调用方给错了东西不是一次验收结论；落一条 rejected 会让一条本来能通过的任务被打回')
  assert.equal(store.getAttempt(attemptId).state, 'Validating')
})

test('⑦ 人工复审可显式覆盖判据（覆盖是显式的，不传才用任务契约）', () => {
  // 任务契约里的判据机器核不了（散文），但人工复审可以给出机器判据。
  const { store, attemptId } = makeEnv({ acceptance: '["产出与本阶段职责一致"]' })
  const r = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'reviewer:alice',
    runResult: { outcome: 'completed', result: { summary: 'x' } },
    criteria: [{ kind: 'structured-result', required: ['summary'] }],
    hasNextPost: false,
  })
  assert.equal(r.decision, 'accepted', '覆盖后按覆盖的判据判')
  assert.equal(store.getAttempt(attemptId).state, 'Completed')
  const v = store.validationsOf(attemptId)[0]
  assert.deepEqual(v.criteria, [{ kind: 'structured-result', required: ['summary'] }],
    '实际用的判据必须落库，否则事后无法回答"当时按什么验的"')
})

test('⑦ 同一尝试可以被验收多次（记录只追加，不覆盖）', () => {
  // 人工复审、驳回后重验都会产生第二条记录。第一份结论必须还在——
  // "当时为什么说它不通过"是复查时唯一能看的东西。
  //
  // 构造"同一尝试被验两次"需要一个能重新进入 Validating 的路径：
  // 这里是**人工复审**——`needs-human` 把它送进 AwaitingApproval（returnTo=Validating），
  // 人工批准后回到 Validating，于是可以再验一次。这条路径本身也值得走一遍。
  const { store, attemptId } = makeEnv({ acceptance: '["产出与本阶段职责一致"]' })
  const first = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false,
  })
  assert.equal(first.decision, 'needs-human')
  assert.equal(store.getAttempt(attemptId).state, 'AwaitingApproval')

  // 人工批准 → 回到 Validating（`approvalOrigin` 用 return_to 决定回哪）
  store.transition({
    attemptId, leaseEpoch: 1, workerId: 'reviewer:alice', to: 'Validating',
    context: { returnTo: 'Validating' }, reason: 'approval:approved',
  })
  assert.equal(store.getAttempt(attemptId).state, 'Validating', '批准后必须回到验收，而不是重跑执行')

  // 第二次验收：人工给出机器判据并覆盖
  const second = store.recordValidation({
    attemptId, leaseEpoch: 1, actor: 'reviewer:alice',
    runResult: { outcome: 'completed', result: { summary: 'x' } },
    criteria: [{ kind: 'structured-result', required: ['summary'] }],
    hasNextPost: false,
  })
  assert.equal(second.decision, 'accepted')
  assert.equal(store.getAttempt(attemptId).state, 'Completed')

  const rows = store.validationsOf(attemptId)
  assert.equal(rows.length, 2, '两份结论都必须留着（只追加，不覆盖）')
  assert.equal(rows[0].decision, 'needs-human', '第一份结论必须原样保留')
  assert.deepEqual(rows[0].criteria, ['产出与本阶段职责一致'])
  assert.equal(rows[1].decision, 'accepted')
  assert.deepEqual(rows[1].criteria, [{ kind: 'structured-result', required: ['summary'] }])
})

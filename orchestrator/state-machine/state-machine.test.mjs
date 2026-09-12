// orchestrator/state-machine/state-machine.test.mjs
// ============================================================================
// PRT-301 持久化运行状态机的判据（spec §6.4 / §6.1）
//
// 这一组的断言几乎全是**拒绝**：状态机最危险的失效方式不是「写错一个状态」，
// 而是「本该拒绝的迁移被接受了」。接受了之后没有异常、没有日志，
// 只有用户看到「已完成」变回「进行中」，或者任务链在某处静静断掉。
// 因此每一条拒绝都配一条用例，且断言的是**具名错误码**——
// 笼统的「非法迁移」无法被 metrics 单独统计，也无法告诉人下一步做什么。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_ATTEMPT_STATES,
  ATTEMPT_STATES,
  FAILURE_CLASSES,
  RECOVERY_ACTIONS,
  TASK_STATUS_OF,
  TASK_STATUSES,
  TERMINAL_ATTEMPT_STATES,
  TRANSITION_ERRORS,
  allowedTargets,
  allTransitionEdges,
  applyTransition,
  classifyFailure,
  isActiveAttemptState,
  isTerminalAttemptState,
  recoveryDecision,
  requiresHuman,
  retryDelayMs,
  taskStatusMatrix,
  taskStatusOf,
  transitionPlan,
} from './index.mjs'

// ---------------------------------------------------------------- ① 状态与映射

test('① 13 个状态与 spec §6.4 逐一对应', () => {
  assert.equal(ATTEMPT_STATES.length, 13)
  assert.deepEqual([...ATTEMPT_STATES], [
    'Queued', 'Leased', 'PreparingWorkspace', 'BuildingContext', 'Running',
    'AwaitingApproval', 'Validating', 'HandingOff', 'Completed',
    'RetryableFailure', 'UnknownOutcome', 'Cancelled', 'DeadLetter',
  ])
})

test('① 任务状态映射是**全函数**：每个状态都有任务状态，且取值合法', () => {
  // 缺失的那一支会把任务永久留在 in_progress，而 worker 日志一切正常——
  // 「卡住」没有任何错误信息，是最难接的一类工单。
  for (const row of taskStatusMatrix()) {
    assert.ok(TASK_STATUSES.includes(row.status), `${row.state}(${row.branch}) 映射到未登记的任务状态 ${row.status}`)
  }
  assert.equal(taskStatusMatrix().length, 15, '13 个状态 + AwaitingApproval/RetryableFailure 各多一个分支')
  for (const state of ATTEMPT_STATES) {
    assert.ok(state in TASK_STATUS_OF, `${state} 缺少映射项`)
  }
})

test('① AwaitingApproval 的任务状态由「从哪来」决定（工具级 in_progress / 交付级 in_review）', () => {
  assert.equal(taskStatusOf('AwaitingApproval', { approvalFrom: 'Running' }).status, 'in_progress')
  assert.equal(taskStatusOf('AwaitingApproval', { approvalFrom: 'Validating' }).status, 'in_review')
  const missing = taskStatusOf('AwaitingApproval', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'APPROVAL_ORIGIN_REQUIRED')
  // in_review 是唯一一个「看起来结束、其实还在跑」的状态：映射错会让用户
  // 以为任务已完成，或让它出现在「待人工处置」列表里而实际并不需要干预。
  assert.equal(taskStatusOf('Validating', {}).status, 'in_review')
  assert.equal(taskStatusOf('HandingOff', {}).status, 'in_progress')
})

test('① RetryableFailure 必须给出重试额度（有→todo，无→blocked）', () => {
  assert.equal(taskStatusOf('RetryableFailure', { retryBudgetRemaining: true }).status, 'todo')
  assert.equal(taskStatusOf('RetryableFailure', { retryBudgetRemaining: false }).status, 'blocked')
  const missing = taskStatusOf('RetryableFailure', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'RETRY_BUDGET_REQUIRED')
  // 猜错会让「还会自动重试」与「等人处理」表现成同一种状态
  assert.equal(missing.status, undefined)
})

test('① 活跃态不是「非终态」——RetryableFailure/UnknownOutcome 都不持有 lease 但都不是终态', () => {
  assert.deepEqual([...ACTIVE_ATTEMPT_STATES], ['Leased', 'PreparingWorkspace', 'BuildingContext', 'Running', 'AwaitingApproval', 'Validating', 'HandingOff'])
  assert.equal(isActiveAttemptState('RetryableFailure'), false)
  assert.equal(isTerminalAttemptState('RetryableFailure'), false)
  assert.equal(isActiveAttemptState('UnknownOutcome'), false)
  assert.equal(isTerminalAttemptState('UnknownOutcome'), false)
  // 把活跃=!终态 会让恢复扫描给已经放弃的 Attempt 续期，
  // 于是「已经死掉的任务」在 metrics 里表现成「有活跃 lease」。
  assert.equal(isActiveAttemptState('Queued'), false)
})

test('① 只有 Completed/Cancelled/DeadLetter 是终态；UnknownOutcome 需要人工', () => {
  assert.deepEqual([...TERMINAL_ATTEMPT_STATES], ['Completed', 'Cancelled', 'DeadLetter'])
  assert.equal(requiresHuman('UnknownOutcome'), true)
  assert.equal(requiresHuman('DeadLetter'), true)
  assert.equal(requiresHuman('RetryableFailure'), false)
})

// ---------------------------------------------------------------- ② 正常路径

test('② 正常路径逐段合法：Queued → … → Completed', () => {
  const path = ['Leased', 'PreparingWorkspace', 'BuildingContext', 'Running', 'Validating']
  let current = 'Queued'
  for (const to of path) {
    const plan = transitionPlan(current, to, {})
    assert.equal(plan.ok, true, `${current} → ${to}：${plan.message}`)
    current = plan.to
  }
  const finish = transitionPlan(current, 'Completed', { hasNextPost: false })
  assert.equal(finish.ok, true, finish.message)
})

test('② 每条边都声明「副作用之前必须先落库什么」（spec §6.4）', () => {
  // 这条把「先持久化意图，再做副作用」从一句原则变成可断言的事实。
  assert.deepEqual([...transitionPlan('Queued', 'Leased').requiresPersist], ['attempt', 'lease'])
  assert.deepEqual([...transitionPlan('PreparingWorkspace', 'BuildingContext').requiresPersist], ['attempt', 'workspace'])
  assert.deepEqual([...transitionPlan('BuildingContext', 'Running').requiresPersist], ['attempt', 'contextSnapshot'])
  assert.deepEqual([...transitionPlan('HandingOff', 'Completed').requiresPersist], ['attempt', 'handoff'])
  // 幂等重复应用不要求再落库（已经落过了）
  assert.deepEqual([...transitionPlan('Running', 'Running').requiresPersist], [])
})

test('② 迁移表覆盖全部 13 个状态（不留未定义的表项）', () => {
  for (const state of ATTEMPT_STATES) {
    assert.doesNotThrow(() => allowedTargets(state), `${state} 没有迁移表项`)
  }
  const edges = allTransitionEdges()
  assert.ok(edges.length >= 28, `迁移边太少（${edges.length}），可能有状态漏了出边`)
  for (const e of edges) {
    assert.ok(ATTEMPT_STATES.includes(e.from) && ATTEMPT_STATES.includes(e.to))
  }
})

test('② 幂等：重复应用同一次迁移是「已生效」，不是错误', () => {
  // worker 写入后崩溃、重启后重放同一次迁移是正常路径。
  const again = transitionPlan('Running', 'Running')
  assert.equal(again.ok, true)
  assert.equal(again.idempotent, true)
  assert.match(again.note, /重复应用/)

  const viaApply = applyTransition({ current: 'Completed', expectedFrom: 'Completed', to: 'Completed' })
  assert.equal(viaApply.ok, true)
  assert.equal(viaApply.idempotent, true)
})

// ---------------------------------------------------------------- ③ 拒绝

test('③ 不许跳状态：Queued → Running 非法（跳过工作区与上下文）', () => {
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running', 'Validating', 'Completed']) {
    const plan = transitionPlan('Queued', to)
    assert.equal(plan.ok, false, `Queued → ${to} 不应被允许`)
    assert.equal(plan.code, TRANSITION_ERRORS.ILLEGAL)
  }
  // 跳过的执行没有工作区、没有上下文快照：产物落在错误目录、审计缺来源哈希，
  // 而它在状态层面与正常执行**完全一致**。
  assert.match(transitionPlan('Queued', 'Running').message, /允许的目标：Leased, Cancelled/)
})

test('③ 终态不得离开：迟到的结果只能记进 audit', () => {
  for (const from of TERMINAL_ATTEMPT_STATES) {
    for (const to of ATTEMPT_STATES) {
      if (to === from) continue
      const plan = transitionPlan(from, to)
      assert.equal(plan.ok, false, `${from} → ${to} 不应被允许`)
      assert.equal(plan.code, TRANSITION_ERRORS.TERMINAL)
    }
  }
  assert.match(transitionPlan('Completed', 'Running').message, /迟到的结果只能作为诊断记录/)
})

test('③ UnknownOutcome 不得回到队列——错误码是具名的（重复外部副作用的守卫）', () => {
  // 「自动重试」这条路永远封死：这几条边不存在，且报具名码而不是笼统的 ILLEGAL_TRANSITION
  for (const to of ['Queued', 'Leased', 'Running', 'PreparingWorkspace', 'HandingOff']) {
    const plan = transitionPlan('UnknownOutcome', to)
    assert.equal(plan.ok, false)
    assert.equal(plan.code, TRANSITION_ERRORS.UNKNOWN_OUTCOME_NOT_RETRYABLE,
      `UnknownOutcome → ${to} 必须是具名的 UNKNOWN_OUTCOME_NOT_RETRYABLE，而不是笼统的 ILLEGAL_TRANSITION`)
  }
  assert.match(transitionPlan('UnknownOutcome', 'Queued').message, /重复副作用/)
  // 放弃的两条出口
  assert.equal(transitionPlan('UnknownOutcome', 'DeadLetter').ok, true)
  assert.equal(transitionPlan('UnknownOutcome', 'Cancelled').ok, true)
})

test('③ 人工对账的两个确定结论必须能被记下来（否则一个丢了、一个永远等人工）', () => {
  // 确认外部写**已发生** → 按成功继续验收，绝不重跑。
  // 缺这条边时，一个真交付了的结果只能进 DeadLetter（当失败重做，可能重复付费）
  // 或 Cancelled（当没做过，交付静默消失）。
  assert.equal(transitionPlan('UnknownOutcome', 'Validating', { externalEffectConfirmed: true }).ok, true)
  const wrongWay = transitionPlan('UnknownOutcome', 'Validating', { externalEffectConfirmed: false })
  assert.equal(wrongWay.ok, false)
  assert.equal(wrongWay.code, TRANSITION_ERRORS.GUARD_FAILED)
  assert.match(wrongWay.message, /RetryableFailure/)

  // 确认外部写**未发生** → 降级为普通可重试失败，回到既有的重试额度判定。
  // 注意仍然不是直接回 Queued：若允许，`UnknownOutcome → Queued` 的禁令就自己失效了。
  assert.equal(transitionPlan('UnknownOutcome', 'RetryableFailure', { externalEffectConfirmed: false }).ok, true)
  const wrongWay2 = transitionPlan('UnknownOutcome', 'RetryableFailure', { externalEffectConfirmed: true })
  assert.equal(wrongWay2.ok, false)
  assert.equal(wrongWay2.code, TRANSITION_ERRORS.GUARD_FAILED)
  assert.match(wrongWay2.message, /重复付费|重复副作用/)

  // **缺省必须报错，不能默认任何一个方向**：
  // 默认「已发生」把没做成的交付当成功推进验收；默认「未发生」重复执行一次已经生效的外部写。
  for (const to of ['Validating', 'RetryableFailure']) {
    const missing = transitionPlan('UnknownOutcome', to, {})
    assert.equal(missing.ok, false)
    assert.equal(missing.code, TRANSITION_ERRORS.MISSING_GUARD_INPUT,
      `UnknownOutcome → ${to} 缺 externalEffectConfirmed 时必须报「缺输入」，而不是默认一个方向`)
    assert.match(missing.message, /不得默认/)
  }
  // 非布尔值同样不得通过（"yes"、1 这些都不是对账结论）
  for (const bogus of ['yes', 1, null]) {
    assert.equal(transitionPlan('UnknownOutcome', 'Validating', { externalEffectConfirmed: bogus }).ok, false)
    assert.equal(transitionPlan('UnknownOutcome', 'RetryableFailure', { externalEffectConfirmed: bogus }).ok, false)
  }
})

test('③ CAS：调用方以为的状态与实际不符时拒写（过期 worker 不得改写别人的结果）', () => {
  // 场景：worker A 的 lease 过期，worker B 已把任务做到 Completed；
  // A 醒过来想把状态写回 Running。没有这一条，用户会看到「已完成」变回「进行中」。
  const stale = applyTransition({ current: 'Completed', expectedFrom: 'Running', to: 'Running' })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, TRANSITION_ERRORS.STALE)
  assert.equal(stale.current, 'Completed')
  assert.equal(stale.expectedFrom, 'Running')
  assert.match(stale.message, /状态已被他人改写/)

  // 不传 expectedFrom 时（例如首次创建 Attempt）不做 CAS 判定
  assert.equal(applyTransition({ current: 'Queued', to: 'Leased' }).ok, true)
})

test('③ 未登记的状态名被点名拒绝', () => {
  assert.equal(transitionPlan('Nope', 'Running').code, TRANSITION_ERRORS.UNKNOWN_FROM)
  assert.equal(transitionPlan('Queued', 'Nope').code, TRANSITION_ERRORS.UNKNOWN_TO)
})

// ---------------------------------------------------------------- ④ 守卫

test('④ Validating 必须显式回答「有没有下一岗位」', () => {
  // 缺这个输入时不得默认「没有下一岗位」——那会静默掐断任务链，
  // 直到目标停住才被发现，而那时已经过了很久。
  const missing = transitionPlan('Validating', 'Completed', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, TRANSITION_ERRORS.GUARD_FAILED)
  assert.match(missing.message, /不得默认「没有下一岗位」/)

  assert.equal(transitionPlan('Validating', 'Completed', { hasNextPost: false }).ok, true)
  assert.equal(transitionPlan('Validating', 'HandingOff', { hasNextPost: true }).ok, true)
  // 用交接表达链尾会创建一个没有承接方的任务
  const wrong = transitionPlan('Validating', 'HandingOff', { hasNextPost: false })
  assert.equal(wrong.ok, false)
  assert.match(wrong.message, /没有承接方的任务/)
})

test('④ 进入 AwaitingApproval 必须记下 returnTo', () => {
  const missing = transitionPlan('Running', 'AwaitingApproval', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, TRANSITION_ERRORS.MISSING_GUARD_INPUT)
  assert.match(missing.message, /不记的话批准后只能猜/)

  assert.equal(transitionPlan('Running', 'AwaitingApproval', { returnTo: 'Running' }).ok, true)
  assert.equal(transitionPlan('Validating', 'AwaitingApproval', { returnTo: 'Validating' }).ok, true)
  const bad = transitionPlan('Running', 'AwaitingApproval', { returnTo: 'Queued' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /returnTo 只能是 Running/)
})

test('④ AwaitingApproval 只能回到记下的那一步（回到别处会跳过验收）', () => {
  // 单一 AwaitingApproval → Running 出边会静默跳过验收：
  // 交付级审批通过后本该进 HandingOff/Completed，却回到了 Running 再跑一遍。
  const approved = transitionPlan('AwaitingApproval', 'Running', { returnTo: 'Running' })
  assert.equal(approved.ok, true)
  assert.equal(approved.taskStatusHint, 'in_progress')

  const delivery = transitionPlan('AwaitingApproval', 'Validating', { returnTo: 'Validating' })
  assert.equal(delivery.ok, true)
  assert.equal(delivery.taskStatusHint, 'in_review')

  const wrongTarget = transitionPlan('AwaitingApproval', 'Running', { returnTo: 'Validating' })
  assert.equal(wrongTarget.ok, false)
  assert.equal(wrongTarget.code, TRANSITION_ERRORS.RETURN_TO_REQUIRED)
  assert.match(wrongTarget.message, /只能回到进入暂停时记下的 returnTo/)

  // 拒绝审批 / TTL 到期自动 deny：转 RetryableFailure（有额度回 todo，否则 blocked）
  assert.equal(transitionPlan('AwaitingApproval', 'RetryableFailure', { returnTo: 'Running' }).ok, true)
  assert.equal(transitionPlan('AwaitingApproval', 'Cancelled', { returnTo: 'Running' }).ok, true)
})

test('④ 已知外部副作用未发生时必须走 RetryableFailure，不走 UnknownOutcome', () => {
  const wrong = transitionPlan('Running', 'UnknownOutcome', { externalEffectConfirmed: true })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, TRANSITION_ERRORS.GUARD_FAILED)
  assert.match(wrong.message, /可自动重试的任务挂起来/)
  // 能确认未执行 → 可重试
  assert.equal(transitionPlan('Running', 'RetryableFailure').ok, true)
  assert.equal(transitionPlan('Running', 'UnknownOutcome').ok, true)
})

test('④ RetryableFailure → Queued 必须新建 attempt，且需要重试额度', () => {
  const noBudget = transitionPlan('RetryableFailure', 'Queued', { retryBudgetRemaining: false })
  assert.equal(noBudget.ok, false)
  assert.match(noBudget.message, /重试额度已用完/)

  const missing = transitionPlan('RetryableFailure', 'Queued', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, TRANSITION_ERRORS.MISSING_GUARD_INPUT)

  const retry = transitionPlan('RetryableFailure', 'Queued', { retryBudgetRemaining: true })
  assert.equal(retry.ok, true)
  assert.equal(retry.createsNewAttempt, true, '重试必须新建 attempt，不得覆盖历史')
  // 其余出边都不新建 attempt
  assert.equal(transitionPlan('Queued', 'Leased').createsNewAttempt, false)
  assert.equal(transitionPlan('RetryableFailure', 'DeadLetter').createsNewAttempt, false)
})

// ---------------------------------------------------------------- ⑤ 失败分类

test('⑤ 未登记的失败码**不**默认可重试（对不认识的错误自动重试最坏是重复外部写）', () => {
  const noEffect = classifyFailure('something-new')
  assert.equal(noEffect.ok, true)
  assert.equal(noEffect.class, FAILURE_CLASSES.FATAL)
  assert.equal(noEffect.attemptState, 'DeadLetter')
  assert.match(noEffect.reason, /不.*默认重试/)

  const withEffect = classifyFailure('something-new', { externalEffectPossible: true })
  assert.equal(withEffect.class, FAILURE_CLASSES.UNKNOWN_OUTCOME)
  assert.equal(withEffect.attemptState, 'UnknownOutcome')

  // 任何未登记的码都不得得到 retryable
  for (const code of ['x', 'y', 'ECONNRESET-ish']) {
    assert.notEqual(classifyFailure(code).class, FAILURE_CLASSES.RETRYABLE)
    assert.notEqual(classifyFailure(code, { externalEffectPossible: true }).class, FAILURE_CLASSES.RETRYABLE)
  }
})

test('⑤ 已登记的码按表分类；空码被拒绝', () => {
  assert.equal(classifyFailure('model-rate-limited').attemptState, 'RetryableFailure')
  assert.equal(classifyFailure('external-effect-unconfirmed').attemptState, 'UnknownOutcome')
  assert.equal(classifyFailure('permission-denied').attemptState, 'DeadLetter')
  // 「结果未知」的分类必须自己解释为什么不能重试
  assert.match(classifyFailure('tool-timeout-after-call').reason, /无法确认/)

  const empty = classifyFailure('  ')
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'FAILURE_CODE_REQUIRED')
})

test('⑤ 取消不是失败：它有独立终态，不应出现在 Dead Letter 里', () => {
  const c = classifyFailure('cancelled')
  assert.equal(c.class, FAILURE_CLASSES.FATAL)
  assert.equal(c.attemptState, 'Cancelled')
  assert.match(c.reason, /不是失败/)
})

// ---------------------------------------------------------------- ⑥ 退避

test('⑥ 退避指数增长、受上限约束，且 attemptNo 从 1 开始', () => {
  const d1 = retryDelayMs(1, { baseMs: 1000, factor: 2, maxMs: 60000 })
  const d2 = retryDelayMs(2, { baseMs: 1000, factor: 2, maxMs: 60000 })
  const d3 = retryDelayMs(3, { baseMs: 1000, factor: 2, maxMs: 60000 })
  assert.deepEqual([d1.delayMs, d2.delayMs, d3.delayMs], [1000, 2000, 4000])
  assert.equal(d3.capped, false)

  const capped = retryDelayMs(20, { baseMs: 1000, factor: 2, maxMs: 60000 })
  assert.equal(capped.delayMs, 60000)
  assert.equal(capped.capped, true)

  // attemptNo 0 / 负数会落到分数次幂上，得到比 baseMs 还小的值：
  // 于是「退避」实际上在加速。这在指数退避实现里是很常见的笔误。
  for (const bad of [0, -1, 1.5, 'x', null]) {
    const r = retryDelayMs(bad, { baseMs: 1000 })
    assert.equal(r.ok, false, `attemptNo=${bad} 应被拒绝`)
    assert.equal(r.code, 'ATTEMPT_NO_INVALID')
  }
})

test('⑥ baseMs 必须 > 0：退避为 0 会变成忙等循环', () => {
  for (const bad of [0, -5, NaN, Infinity, 'x']) {
    const r = retryDelayMs(1, { baseMs: bad })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BACKOFF_BASE_INVALID')
  }
  assert.equal(retryDelayMs(1, { baseMs: 1000, factor: 1 }).delayMs, 1000, 'factor=1 是固定间隔，合法')
  assert.equal(retryDelayMs(1, { baseMs: 1000, factor: 0.5 }).ok, false, 'factor<1 会让退避越来越短')
})

// ---------------------------------------------------------------- ⑦ 恢复判定

test('⑦ 恢复判定：lease 有效时不抢占（抢占会导致同一任务被执行两次）', () => {
  const r = recoveryDecision({ attemptState: 'Running', leaseValid: true, attemptInFlight: true })
  assert.equal(r.action, 'none')
  const w = recoveryDecision({ attemptState: 'Running', leaseValid: true })
  assert.equal(w.action, 'wait')
  // 即便 lease 有效，也**不能**因为「有残留 Attempt」就重试
  assert.notEqual(w.action, 'retry-new-attempt')
})

test('⑦ 恢复判定：lease 过期但未说明外部副作用时**拒绝判定**（不能猜）', () => {
  const r = recoveryDecision({ attemptState: 'Running', leaseValid: false })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EXTERNAL_EFFECT_UNKNOWN')
  assert.match(r.message, /不能猜/)
})

test('⑦ 恢复判定：已可能产生外部副作用 → UnknownOutcome，绝不自动重试', () => {
  const r = recoveryDecision({ attemptState: 'Running', leaseValid: false, externalEffectPossible: true })
  assert.equal(r.action, 'mark-unknown-outcome')
  assert.match(r.reason, /绝不自动重试/)
  // 与「结果未知不得自动重试」是同一条规则的两个入口
  const s = recoveryDecision({ attemptState: 'HandingOff', leaseValid: false, externalEffectPossible: true })
  assert.equal(s.action, 'mark-unknown-outcome')
})

test('⑦ 恢复判定：确认未越过外部写边界 → 新建 attempt 重试', () => {
  const r = recoveryDecision({ attemptState: 'BuildingContext', leaseValid: false, externalEffectPossible: false })
  assert.equal(r.action, 'retry-new-attempt')
  assert.match(r.reason, /不覆盖历史 attempt/)
})

test('⑦ 恢复判定：Queued 可领取，终态与人工态不动', () => {
  assert.equal(recoveryDecision({ attemptState: 'Queued' }).action, 'claim-eligible')
  assert.equal(recoveryDecision({ attemptState: 'Completed' }).action, 'none')
  assert.equal(recoveryDecision({ attemptState: 'Cancelled' }).action, 'none')
  assert.equal(recoveryDecision({ attemptState: 'UnknownOutcome' }).action, 'await-human')
  assert.equal(recoveryDecision({ attemptState: 'DeadLetter' }).action, 'await-human')
  for (const { action } of [recoveryDecision({ attemptState: 'DeadLetter' }), recoveryDecision({ attemptState: 'Queued' })]) {
    assert.ok(RECOVERY_ACTIONS.includes(action), `未登记的动作 ${action}`)
  }
  // AwaitingApproval 且 lease 有效：审批等待期 heartbeat 继续，不得被抢占
  // （抢占会让审批中的任务被另一个 worker 重跑，违背「已确认外部写操作重复执行为零」）
  assert.equal(recoveryDecision({ attemptState: 'AwaitingApproval', leaseValid: true }).action, 'wait')
})

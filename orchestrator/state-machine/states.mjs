// orchestrator/state-machine/states.mjs
// ============================================================================
// 持久化运行状态机：状态集合与 team-hub 任务状态映射（PRT-301，spec §6.4）
//
// 纯模块，不依赖 Cordis/DSH（`orchestrator/` 属 must-be-zero 前缀）。
//
// ## 为什么状态映射要单独成文件、单独受测
//
// 状态机有两层：**Attempt 级的细状态**（13 个）与 **team-hub 的用户可见任务状态**
// （todo/in_progress/in_review/done/blocked/canceled）。用户看的是后者，编排逻辑判断的是前者。
// 映射一旦不是**全函数**，缺失的那一支的表现是：任务停在 `in_progress` 再也不动，
// 而 worker 日志里一切正常——这类「卡住」没有任何错误信息，是运维最难接的一类工单。
// 因此这里把映射写成覆盖全部 13 个状态的**穷尽表**，并由用例断言穷尽性。
//
// 第二个陷阱是 `in_review`。它是唯一一个「看起来结束、其实还在跑」的状态：
// 交付级审批等待时 Attempt 仍持有 lease 并继续 heartbeat。若映射成 `done`，
// 用户会以为任务已完成并据此做下一步；若映射成 `blocked`，它会出现在「待人工处置」列表里
// 而实际并不需要人工干预。两者都不是小偏差。
// ============================================================================

/** Attempt / Run 级状态（spec §6.4 运行状态机，13 个）。 */
export const ATTEMPT_STATES = Object.freeze([
  // 正常路径
  'Queued',
  'Leased',
  'PreparingWorkspace',
  'BuildingContext',
  'Running',
  'AwaitingApproval',
  'Validating',
  'HandingOff',
  'Completed',
  // 异常路径
  'RetryableFailure',
  'UnknownOutcome',
  'Cancelled',
  'DeadLetter',
])

/** team-hub 任务状态（数据面既有取值，不改名）。 */
export const TASK_STATUSES = Object.freeze([
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'canceled',
])

/** 终态：到达后不得再离开（迟到的结果只能记进 audit）。 */
export const TERMINAL_ATTEMPT_STATES = Object.freeze([
  'Completed',
  'Cancelled',
  'DeadLetter',
])

/**
 * 「活跃」= 该 Attempt 正在持有或应当持有 lease。
 *
 * 它与终态**不互补**：`RetryableFailure` 和 `UnknownOutcome` 都不是终态，
 * 但都不再持有 lease。把它当成 `!terminal` 会让恢复扫描去为已经放弃的 Attempt 续期，
 * 于是「已经死掉的任务」在 metrics 里表现成「有活跃 lease」。
 */
export const ACTIVE_ATTEMPT_STATES = Object.freeze([
  'Leased',
  'PreparingWorkspace',
  'BuildingContext',
  'Running',
  'AwaitingApproval',
  'Validating',
  'HandingOff',
])

/** 需要人工处置才能继续的状态。 */
export const HUMAN_REQUIRED_ATTEMPT_STATES = Object.freeze([
  'UnknownOutcome',
  'DeadLetter',
])

const STATE_SET = new Set(ATTEMPT_STATES)
const TASK_STATUS_SET = new Set(TASK_STATUSES)
const TERMINAL_SET = new Set(TERMINAL_ATTEMPT_STATES)
const ACTIVE_SET = new Set(ACTIVE_ATTEMPT_STATES)

export function isKnownAttemptState(state) {
  return STATE_SET.has(state)
}

export function isTerminalAttemptState(state) {
  return TERMINAL_SET.has(state)
}

export function isActiveAttemptState(state) {
  return ACTIVE_SET.has(state)
}

export function isKnownTaskStatus(status) {
  return TASK_STATUS_SET.has(status)
}

export function requiresHuman(state) {
  return HUMAN_REQUIRED_ATTEMPT_STATES.includes(state)
}

/**
 * Attempt 状态 → team-hub 任务状态（spec §6.4 的映射表，穷尽 13 项）。
 *
 * `RetryableFailure` 是唯一需要额外输入的项：有重试额度时回到 `todo`（等下一轮认领），
 * 额度用完则是 `blocked`（必须有人看一眼）。把它固定成其中一个会让另一种情形失去表达力，
 * 因此这一项由调用方显式给 `retryBudgetRemaining`，且**不给就报错**——
 * 默认值会把「还有额度」和「没额度」混成同一种表现。
 */
export const TASK_STATUS_OF = Object.freeze({
  Queued: 'todo',
  Leased: 'in_progress',
  PreparingWorkspace: 'in_progress',
  BuildingContext: 'in_progress',
  Running: 'in_progress',
  AwaitingApproval: 'in_progress',
  Validating: 'in_review',
  HandingOff: 'in_progress',
  Completed: 'done',
  RetryableFailure: null, // 见 taskStatusOf：需要 retryBudgetRemaining
  UnknownOutcome: 'blocked',
  Cancelled: 'canceled',
  DeadLetter: 'blocked',
})

/**
 * 交付级审批等待时的任务状态。
 *
 * `AwaitingApproval` 有两个入口：运行中的工具请求（Task 仍由该 Attempt 持有，`in_progress`）
 * 与验收后的交付审批（`in_review`）。同一状态对应两种任务状态，因此必须由
 * 「从哪来」决定——这正是 `AwaitingApproval` 携带 `returnTo` 的原因。
 */
export const AWAITING_APPROVAL_TASK_STATUS = Object.freeze({
  Running: 'in_progress',
  Validating: 'in_review',
})

/**
 * 计算用户可见的任务状态。
 *
 * 返回 `{ ok, status }` 或 `{ ok: false, code, message }`。**不用异常**：
 * 映射失败发生在「我们已经落库了一个 attempt 状态」之后，此时抛错会把
 * 「数据已写但状态算不出来」变成一次崩溃；返回值让调用方可以选择写入
 * `blocked` 并记 audit。
 */
export function taskStatusOf(attemptState, { retryBudgetRemaining, approvalFrom = null } = {}) {
  if (!isKnownAttemptState(attemptState)) {
    return Object.freeze({ ok: false, code: 'UNKNOWN_ATTEMPT_STATE', message: `未登记的 Attempt 状态「${attemptState}」` })
  }
  if (attemptState === 'RetryableFailure') {
    if (typeof retryBudgetRemaining !== 'boolean') {
      return Object.freeze({
        ok: false,
        code: 'RETRY_BUDGET_REQUIRED',
        message: 'RetryableFailure 的任务状态取决于是否还有重试额度（有→todo，无→blocked）；' +
          '缺这个输入时不能猜，猜错会让「还会自动重试」与「等人处理」表现成同一种状态',
      })
    }
    return Object.freeze({ ok: true, status: retryBudgetRemaining ? 'todo' : 'blocked' })
  }
  if (attemptState === 'AwaitingApproval') {
    const status = AWAITING_APPROVAL_TASK_STATUS[approvalFrom]
    if (status === undefined) {
      return Object.freeze({
        ok: false,
        code: 'APPROVAL_ORIGIN_REQUIRED',
        message: 'AwaitingApproval 的任务状态取决于它是工具级暂停（in_progress）还是交付级审批（in_review）；' +
          `当前 approvalFrom=${JSON.stringify(approvalFrom)}。缺这个输入会把「还在跑」和「等验收」混为一谈`,
      })
    }
    return Object.freeze({ ok: true, status })
  }
  return Object.freeze({ ok: true, status: TASK_STATUS_OF[attemptState] })
}

/** 全部映射（含 AwaitingApproval 的两个分支）——供文档生成与穷尽性断言使用。 */
export function taskStatusMatrix() {
  const out = []
  for (const state of ATTEMPT_STATES) {
    if (state === 'RetryableFailure') {
      out.push(Object.freeze({ state, branch: 'retry-budget-remaining', status: 'todo' }))
      out.push(Object.freeze({ state, branch: 'retry-budget-exhausted', status: 'blocked' }))
    } else if (state === 'AwaitingApproval') {
      out.push(Object.freeze({ state, branch: 'tool-level', status: 'in_progress' }))
      out.push(Object.freeze({ state, branch: 'delivery-level', status: 'in_review' }))
    } else {
      out.push(Object.freeze({ state, branch: null, status: TASK_STATUS_OF[state] }))
    }
  }
  return Object.freeze(out)
}

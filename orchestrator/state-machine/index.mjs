// orchestrator/state-machine/index.mjs
// ============================================================================
// 持久化运行状态机（PRT-301，spec §6.4）统一出口。
//
// 这里只做**纯逻辑**：状态、迁移、守卫、失败分类、恢复判定。
// 落库（team-hub 事务、leaseEpoch 拒写）属 PRT-302/313，本模块不碰数据库——
// 状态机一旦和连接绑在一起，「同一个迁移在两种时序下」就没法单独测，
// 而这类缺陷恰恰只在并发与崩溃恢复时出现。
// ============================================================================

export {
  ATTEMPT_STATES,
  ACTIVE_ATTEMPT_STATES,
  AWAITING_APPROVAL_TASK_STATUS,
  HUMAN_REQUIRED_ATTEMPT_STATES,
  TASK_STATUSES,
  TASK_STATUS_OF,
  TERMINAL_ATTEMPT_STATES,
  isActiveAttemptState,
  isKnownAttemptState,
  isKnownTaskStatus,
  isTerminalAttemptState,
  requiresHuman,
  taskStatusMatrix,
  taskStatusOf,
} from './states.mjs'

export {
  TRANSITIONS,
  TRANSITION_ERRORS,
  allowedTargets,
  allTransitionEdges,
  applyTransition,
  transitionPlan,
} from './transitions.mjs'

export {
  FAILURE_CLASSES,
  FAILURE_CODES,
  RECOVERY_ACTIONS,
  classifyFailure,
  recoveryDecision,
  retryDelayMs,
} from './failure.mjs'

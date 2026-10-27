// orchestrator/state-machine/failure-kind.mjs
// ============================================================================
// 失败分类的**只读归一化**（2026-10-27 决策 #6，方案 B）。
//
// ## 为什么是"映射层"而不是"统一码表"
//
// 九类失败的判据分散在四层（运行状态机、team-hub 任务/Attempt、写入预约、
// 集成 worker），每层有各自的语境与码。把它们并成一张码表要改四处写入路径
// 与全部历史数据，而其中两类（见下）**本来就不是失败**。
//
// 方案 B：数据面各自权威，另加一个**只读纯函数**把"这个任务现在卡在什么性质
// 的事上"归一成一个面向用户的类别。它不写库、不改任何写入路径，回退成本为零。
//
// ## 两条不许被做成"失败"的
//
//   · **依赖未完成** —— 那不是失败，是"还没轮到它"。给它一个失败码会让它进
//     重试计数器，而"等上游"不该消耗额度。
//   · **验收返工** —— 那是流程正常工作。做成失败会把"按设计返工"显示成"出错了"。
//
// `kind: 'waiting'` 与 `kind: 'rework'` 就是为这两条留的。
// ============================================================================

/**
 * 面向用户的失败类别（封闭集合——新增一类必须显式加进来，否则 `unknown`）。
 *
 * 顺序即"遇到多重原因时的优先解释顺序"：越靠前越需要人立刻处理。
 */
export const FAILURE_KINDS = Object.freeze([
  'auth',          // 认证缺失/失效
  'permission',    // 权限与工具能力不兼容
  'node',          // 节点未就绪 / provider 不匹配
  'integration',   // 文件冲突 / 集成失败
  'agent',         // Agent 明确失败
  'unknown',       // 结果未知（进程/节点断开），需要人工核对
  'rework',        // 验收返工（**不是失败**）
  'waiting',       // 依赖未完成（**不是失败**）
  'none',          // 没有失败
])

/** 每个类别的一句话解释（UI/指标共用一份文案，避免各写一遍）。 */
export const FAILURE_KIND_LABELS = Object.freeze({
  auth: '认证缺失或失效',
  permission: '权限与工具能力不兼容',
  node: '执行节点或 provider 不就绪',
  integration: '文件冲突或集成失败',
  agent: 'Agent 明确失败',
  unknown: '结果未知，待核对',
  rework: '验收返工（流程正常）',
  waiting: '等待前置任务（流程正常）',
  none: '没有失败',
})

/** 哪几类**不是**失败（指标分母必须排除它们，否则失败率会被流程正常态污染）。 */
export const NON_FAILURE_KINDS = Object.freeze(['none', 'waiting', 'rework'])

/** 错误码 → 类别。<键是各层已有的具名码，不是新造的。> */
const CODE_TO_KIND = Object.freeze({
  AUTH_FAILED: 'auth',
  'permission-denied': 'permission',
  PERMISSION_DENIED: 'permission',
  AGENT_NODE_NOT_READY: 'node',
  AGENT_NODE_NOT_REGISTERED: 'node',
  AGENT_NODE_PROVIDER_INCOMPATIBLE: 'node',
  AGENT_NODE_WORKSPACE_MISMATCH: 'node',
  AGENT_TOOL_CONFIG_UNRESOLVED: 'node',
  AGENT_MODEL_CONFIG_UNSUPPORTED: 'node',
  GIT_CONFLICT: 'integration',
  JOB_CONTENTION: 'integration',
  VALIDATION_FAILED: 'integration',
  REPO_UNBOUND: 'integration',
  FILE_CONTENTION: 'integration',
  AGENT_WORKFLOW_HANDOFF_EVIDENCE_MISSING: 'agent',
  AGENT_WORKFLOW_TARGET_MISSING: 'agent',
  AGENT_WORKFLOW_SNAPSHOT_MISSING: 'agent',
  AGENT_WORKFLOW_GRAPH_INVALID: 'agent',
  // 升级不是失败：它让流程停在等人决定，但审查结论仍然有效。
  AGENT_WORKFLOW_REWORK_REPEATED: 'rework',
})

/** 阶段 Attempt 状态 → 类别（`unknown` 是唯一需要人工核对的一档）。 */
const ATTEMPT_STATE_TO_KIND = Object.freeze({
  failed: 'agent',
  unknown: 'unknown',
  canceled: 'none',
  completed: 'none',
  starting: 'none',
  running: 'none',
})

/** 写入预约状态 → 类别。`reconciling` = 取消未确认，按"结果未知"处理。 */
const RESERVATION_STATE_TO_KIND = Object.freeze({
  reconciling: 'unknown',
})

/**
 * 归一化一个任务的当前状态。
 *
 * ★ 参数全部可选：这个函数**不查库**，调用方把手上已有的读数递进来。
 *   这样它才能在指标、UI、单测三处被同一个实现复用。
 *
 * @param {object} input
 * @param {string|null} [input.errorCode] 最近的具名错误码（各层原样传）
 * @param {string|null} [input.attemptState] 阶段 Attempt 状态
 * @param {string|null} [input.stopReason] Attempt 的 stop_reason
 * @param {string|null} [input.reservationState] 写入预约状态
 * @param {boolean} [input.blockedByDependency] 是否只是被上游挡着
 * @param {boolean} [input.reviewRework] 是否处于审查返工
 * @returns {{kind: string, label: string, isFailure: boolean, reason: string}}
 */
export function failureKindOf({
  errorCode = null,
  attemptState = null,
  stopReason = null,
  reservationState = null,
  blockedByDependency = false,
  reviewRework = false,
} = {}) {
  const verdict = (kind, reason) => Object.freeze({
    kind,
    label: FAILURE_KIND_LABELS[kind],
    isFailure: !NON_FAILURE_KINDS.includes(kind),
    reason,
  })
  // 具名码最具体，优先。
  if (typeof errorCode === 'string' && Object.prototype.hasOwnProperty.call(CODE_TO_KIND, errorCode)) {
    return verdict(CODE_TO_KIND[errorCode], `errorCode=${errorCode}`)
  }
  // 取消未确认：占用还被冻结着，这是"结果未知"的一种。
  if (typeof reservationState === 'string' && Object.prototype.hasOwnProperty.call(RESERVATION_STATE_TO_KIND, reservationState)) {
    return verdict(RESERVATION_STATE_TO_KIND[reservationState], `reservationState=${reservationState}`)
  }
  if (typeof attemptState === 'string' && Object.prototype.hasOwnProperty.call(ATTEMPT_STATE_TO_KIND, attemptState)) {
    const kind = ATTEMPT_STATE_TO_KIND[attemptState]
    if (kind !== 'none') {
      return verdict(kind, `attemptState=${attemptState}${stopReason ? `（${stopReason}）` : ''}`)
    }
  }
  // ★ 以下两条**不是失败**，但必须排在 `none` 之前：否则"在等上游"会被读成"没问题"。
  if (reviewRework) return verdict('rework', '处于审查返工')
  if (blockedByDependency) return verdict('waiting', '被未完成的上游任务挡着')
  return verdict('none', '没有失败读数')
}

/**
 * 指标用：一批 verdict 里**真正失败**的比例。
 *
 * ★ 分母排除 `NON_FAILURE_KINDS`。把它们算进分母会让"流程正常返工"拉低失败率——
 *   而那个数字会被读成"系统很健康"。
 */
export function failureRate(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts.filter((item) => item !== null && typeof item === 'object') : []
  const failures = list.filter((item) => item.isFailure === true).length
  const fails = list.filter((item) => item.isFailure === true || NON_FAILURE_KINDS.includes(item.kind))
  if (fails.length === 0) return { available: false, value: null, reason: '没有可判定的样本', failures, total: 0 }
  return { available: true, value: failures / fails.length, reason: null, failures, total: fails.length }
}

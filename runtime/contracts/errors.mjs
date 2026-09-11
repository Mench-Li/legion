// runtime/contracts/errors.mjs
// ============================================================================
// Runtime Contract 标准错误码与处置映射（PRT-104）
//
// 这是一个**纯模块**：不依赖 Cordis、DSH、网络或文件系统。它必须能被内存
// Fake Adapter 与 Orchestrator 单测直接使用（spec §6.1）。
//
// 为什么错误码也要有 catalog，而不是散落的字符串常量：
//   「这个错误要不要自动重试」是编排正确性的核心，而它最容易在 Adapter 里被
//   就地判断——每个 Adapter 各判一次，就会出现「同一错误两处结论不同」。
//   spec §6.1 要求「Adapter 不得自行把未知错误归类为成功或普通可重试错误」，
//   因此重试性由契约统一裁决，Adapter 只负责**归类**，不负责**决策**。
//
// 版本化：本 catalog 是 Runtime Contract 的一部分，改动即为契约主版本变更。
// ============================================================================

/**
 * 重试性分类（互斥）。
 * - `auto`        可直接自动重试，无需额外条件。
 * - `conditional` 满足前置条件才可自动重试（见 `requires`）。
 * - `manual`      必须人工处置，不许自动重试。
 * - `never`       重试无意义或有害（确定性失败、终态、需修复环境）。
 */
export const RETRYABILITY = Object.freeze({
  AUTO: 'auto',
  CONDITIONAL: 'conditional',
  MANUAL: 'manual',
  NEVER: 'never',
})

/** 审计等级：决定该错误进 audit 时的严重度，供产品状态与告警使用。 */
export const AUDIT_LEVEL = Object.freeze({
  NOTICE: 'notice',
  WARN: 'warn',
  ERROR: 'error',
})

/** 自动重试的前置条件标识（机器可判，不写自然语言）。 */
export const RETRY_REQUIRES = Object.freeze({
  /** 必须已确认没有未知的外部副作用（spec §6.1 TIMEOUT 条款）。 */
  NO_UNCONFIRMED_EXTERNAL_EFFECT: 'no-unconfirmed-external-effect',
  /** 必须由 Runtime Manager 给出可继续或可安全重来的恢复判断。 */
  RECOVERY_JUDGMENT: 'recovery-judgment',
  /** 必须存在显式配置的 fallback 模型档案。 */
  EXPLICIT_FALLBACK: 'explicit-fallback',
  /** 必须由任务策略允许创建新的 Attempt。 */
  TASK_POLICY_NEW_ATTEMPT: 'task-policy-new-attempt',
  /** 必须已恢复健康（RUNTIME_UNAVAILABLE / NOT_READY）。 */
  RUNTIME_READY: 'runtime-ready',
})

/**
 * 标准错误码 catalog（spec §6.1）。
 * `userMessage` 面向客户，不得出现 DSH/Cordis 词汇（spec §4.1）。
 */
export const ERROR_CATALOG = Object.freeze({
  RUNTIME_UNAVAILABLE: Object.freeze({
    retryability: RETRYABILITY.AUTO,
    requires: RETRY_REQUIRES.RUNTIME_READY,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: 'AI 执行引擎当前不可用，系统会在其恢复后自动重试。',
  }),
  RUNTIME_NOT_READY: Object.freeze({
    retryability: RETRYABILITY.AUTO,
    requires: RETRY_REQUIRES.RUNTIME_READY,
    auditLevel: AUDIT_LEVEL.NOTICE,
    userMessage: 'AI 执行引擎正在启动或升级，暂不接收新任务。',
  }),
  UNSUPPORTED_CAPABILITY: Object.freeze({
    retryability: RETRYABILITY.NEVER,
    requires: null,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '当前产品版本不支持该任务所需的能力，请联系支持。',
  }),
  SECRET_UNAVAILABLE: Object.freeze({
    retryability: RETRYABILITY.MANUAL,
    requires: null,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '无法读取本机保存的模型凭证，请在设置中重新配置。',
  }),
  AUTH_FAILED: Object.freeze({
    retryability: RETRYABILITY.MANUAL,
    requires: null,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '模型服务拒绝了当前凭证，请检查或更换凭证。',
  }),
  MODEL_UNAVAILABLE: Object.freeze({
    retryability: RETRYABILITY.CONDITIONAL,
    requires: RETRY_REQUIRES.EXPLICIT_FALLBACK,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: '所选模型当前不可用，将按配置的备用模型继续。',
  }),
  RATE_LIMITED: Object.freeze({
    retryability: RETRYABILITY.AUTO,
    requires: null,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: '模型服务触发限流，系统将退避后重试。',
  }),
  BUDGET_EXCEEDED: Object.freeze({
    retryability: RETRYABILITY.MANUAL,
    requires: null,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: '本次运行已达到预算上限并已停止，请调整预算后重试。',
  }),
  CONTEXT_TOO_LARGE: Object.freeze({
    retryability: RETRYABILITY.NEVER,
    requires: null,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '任务上下文超出模型限制，裁剪后仍无法容纳，请精简输入。',
  }),
  TOOL_DENIED: Object.freeze({
    retryability: RETRYABILITY.NEVER,
    requires: null,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: '该操作未获授权，已拒绝执行。',
  }),
  TIMEOUT: Object.freeze({
    retryability: RETRYABILITY.CONDITIONAL,
    requires: RETRY_REQUIRES.NO_UNCONFIRMED_EXTERNAL_EFFECT,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: '本次运行超时。系统已停止，并会先确认外部操作结果再决定是否重试。',
  }),
  CANCELLED: Object.freeze({
    retryability: RETRYABILITY.NEVER,
    requires: null,
    auditLevel: AUDIT_LEVEL.NOTICE,
    userMessage: '本次运行已被取消。',
  }),
  RUNTIME_CRASHED: Object.freeze({
    retryability: RETRYABILITY.CONDITIONAL,
    requires: RETRY_REQUIRES.RECOVERY_JUDGMENT,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '执行引擎意外退出。系统正在确认任务状态，不会将其记为成功。',
  }),
  OUTCOME_UNKNOWN: Object.freeze({
    retryability: RETRYABILITY.MANUAL,
    requires: null,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '无法确认该操作在外部系统是否已生效，需要人工确认后再继续。',
  }),
  INVALID_RESULT: Object.freeze({
    retryability: RETRYABILITY.CONDITIONAL,
    requires: RETRY_REQUIRES.TASK_POLICY_NEW_ATTEMPT,
    auditLevel: AUDIT_LEVEL.WARN,
    userMessage: '本次输出未通过验收检查，将按任务策略重新尝试。',
  }),
  SCHEMA_MIGRATION_FAILED: Object.freeze({
    retryability: RETRYABILITY.NEVER,
    requires: null,
    auditLevel: AUDIT_LEVEL.ERROR,
    userMessage: '产品数据升级失败，已停止启动。请回滚到上一版本或联系支持。',
  }),
})

/** 全部标准错误码。 */
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_CATALOG))

const CODE_SET = new Set(ERROR_CODES)

/** 是否为已知标准错误码。Adapter 归类未知错误时用它兜底。 */
export function isKnownErrorCode(code) {
  return CODE_SET.has(code)
}

/**
 * 取错误码的处置描述。未知码**抛错**而不是返回默认值：
 * 静默兜底会让「未归类错误」看起来像正常可重试错误（spec §6.1 明令禁止）。
 */
export function describeError(code) {
  if (!CODE_SET.has(code)) {
    throw new RuntimeContractError(
      'UNSUPPORTED_CAPABILITY',
      `未知错误码：${String(code)}。Adapter 必须把它归类为标准码，不得透传。`,
    )
  }
  return ERROR_CATALOG[code]
}

/**
 * 判定该错误在当前上下文下是否允许自动重试。
 *
 * @param {string} code 标准错误码
 * @param {object} [context]
 * @param {boolean} [context.confirmedNoExternalEffect] 是否已确认无未知外部副作用
 * @param {boolean} [context.recoveryJudgment] 是否已有恢复判断
 * @param {boolean} [context.explicitFallback] 是否配置了备用模型档案
 * @param {boolean} [context.taskPolicyAllowsNewAttempt] 任务策略是否允许新 Attempt
 * @param {boolean} [context.runtimeReady] Runtime 是否已恢复健康
 * @returns {{retryable: boolean, reason: string}}
 */
export function isRetryable(code, context = {}) {
  const entry = describeError(code)
  if (entry.retryability === RETRYABILITY.NEVER) {
    return { retryable: false, reason: '该错误的自动重试没有意义或有害' }
  }
  if (entry.retryability === RETRYABILITY.MANUAL) {
    return { retryable: false, reason: '该错误必须人工处置' }
  }
  if (entry.retryability === RETRYABILITY.AUTO && entry.requires === null) {
    return { retryable: true, reason: '可直接自动重试' }
  }
  switch (entry.requires) {
    case RETRY_REQUIRES.RUNTIME_READY:
      return context.runtimeReady === true
        ? { retryable: true, reason: '执行引擎已恢复健康' }
        : { retryable: false, reason: '执行引擎尚未恢复健康' }
    case RETRY_REQUIRES.NO_UNCONFIRMED_EXTERNAL_EFFECT:
      // 这是 spec §6.1 最容易被忽略的一条：超时可能是「写成功但没收到回执」，
      // 也可能什么都没发生。未确认前自动重试会造成重复外部写。
      return context.confirmedNoExternalEffect === true
        ? { retryable: true, reason: '已确认无未知外部副作用' }
        : { retryable: false, reason: '无法确认外部副作用，须先查询或人工处置' }
    case RETRY_REQUIRES.RECOVERY_JUDGMENT:
      return context.recoveryJudgment === true
        ? { retryable: true, reason: '已有恢复判断' }
        : { retryable: false, reason: '尚无恢复判断' }
    case RETRY_REQUIRES.EXPLICIT_FALLBACK:
      return context.explicitFallback === true
        ? { retryable: true, reason: '存在显式配置的备用模型' }
        : { retryable: false, reason: '未配置备用模型，不得静默降级' }
    case RETRY_REQUIRES.TASK_POLICY_NEW_ATTEMPT:
      return context.taskPolicyAllowsNewAttempt === true
        ? { retryable: true, reason: '任务策略允许新建 Attempt' }
        : { retryable: false, reason: '任务策略不允许新建 Attempt' }
    default:
      return { retryable: false, reason: '前置条件未知，fail closed' }
  }
}

/** 该错误码是否意味着「外部结果可能已生效但未确认」。 */
export function isOutcomeUnknownLike(code) {
  return code === 'OUTCOME_UNKNOWN' || code === 'RUNTIME_CRASHED' || code === 'TIMEOUT'
}

/**
 * 契约级错误。Adapter 把 DSH 异常转换后抛出它，Orchestrator 只认 `code`。
 * 刻意不携带 DSH 原始异常对象：契约不得泄漏执行引擎内部结构（spec §6.2）。
 */
export class RuntimeContractError extends Error {
  /**
   * @param {string} code 标准错误码
   * @param {string} message 面向开发者的诊断信息（不得含密钥）
   * @param {object} [options]
   * @param {boolean} [options.outcomeUnknown] 外部结果是否可能已生效但未确认
   * @param {object} [options.details] 结构化补充信息（仅无损 JSON）
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'RuntimeContractError'
    if (!CODE_SET.has(code)) {
      throw new Error(`RuntimeContractError 使用了未登记的错误码：${String(code)}`)
    }
    this.code = code
    this.outcomeUnknown = options.outcomeUnknown === true
    this.details = options.details && typeof options.details === 'object' ? { ...options.details } : {}
  }

  /** 用户可见文案（不含 DSH/Cordis 词汇）。 */
  get userMessage() {
    return ERROR_CATALOG[this.code].userMessage
  }
}

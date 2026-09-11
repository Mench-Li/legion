// runtime/adapters/dsh/errors.mjs
// ============================================================================
// DSH 异常标准化与重试分类（PRT-206）
//
// ## 两条硬规则
//
// ① **未知错误不得映射成良性结果。** 分类表的兜底是 `RUNTIME_CRASHED`
//    并标记 `unknown: true`，而不是「看起来像成功」或某个默认可重试的码。
//    一个把「我不认识的故障」翻译成「可自动重试」的分类器，会把无限重试
//    伪装成韧性——生产上的表现是任务反复重跑同一个必然失败的调用。
//
// ② **面向用户的消息不得出现 DSH/Cordis 词汇。** 用户买的是 Legion，
//    报错里出现引擎内部的服务名只会让人觉得产品在漏气。
//    `userMessage` 一律取自 `runtime/contracts/errors.mjs` 的目录，
//    DSH 原始文本只进 `details`（且必须已脱敏）。
//
// ## 顺序敏感
//
// 模式表**按序**匹配、首个命中即返回。顺序错会让分类漂移，例如把
// 「429 + quota exhausted」先匹配到 AUTH 就会误判为不可自动重试。
// 表按「越具体越靠前」排列，并有单测锁住顺序（见测试里的顺序断言）。
// ============================================================================
import { RuntimeContractError, describeError, isRetryable } from '../../contracts/index.mjs'
import { redactValue } from './redact.mjs'

/**
 * DSH/网络异常 → 标准错误码的模式表。**按序匹配，首个命中即返回。**
 *
 * 每条的 `why` 是「为什么归到这一类」，排障时比模式本身更重要。
 */
export const ERROR_PATTERNS = Object.freeze([
  { code: 'AUTH_FAILED', re: /\b(401|403)\b|unauthorized|invalid[\s_-]?api[\s_-]?key|authentication\s+failed|incorrect\s+api\s+key/i, why: '凭证被拒：重试无用，必须由用户修配置' },
  { code: 'RATE_LIMITED', re: /\b429\b|rate[\s_-]?limit|too\s+many\s+requests|quota\s+exhausted|overloaded/i, why: '限流/配额：可退避重试' },
  { code: 'SECRET_UNAVAILABLE', re: /secret|keychain|credential[\s_-]?not[\s_-]?found|no\s+such\s+ref|密钥/i, why: '密钥库读不到：属产品配置问题' },
  { code: 'MODEL_UNAVAILABLE', re: /model[\s_-]?not[\s_-]?found|no\s+such\s+model|unknown\s+model|model\s+unavailable/i, why: '模型不存在或下线' },
  { code: 'CONTEXT_TOO_LARGE', re: /context[\s_-]?length|too\s+many\s+tokens|maximum\s+context|exceeds?\s+.*token/i, why: '上下文超限：需裁剪，重试无用' },
  { code: 'BUDGET_EXCEEDED', re: /budget|cost[\s_-]?limit|exceeds?\s+.*(cost|budget)/i, why: '预算闸门' },
  { code: 'TOOL_DENIED', re: /tool[\s_-]?denied|permission\s+denied|not\s+allowed\s+to\s+use/i, why: '权限强制面拒绝' },
  { code: 'UNSUPPORTED_CAPABILITY', re: /unsupported|not\s+supported|capabilit/i, why: '运行时能力不满足' },
  { code: 'RUNTIME_UNAVAILABLE', re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch\s+failed|socket\s+hang\s+up|network|连接/i, why: '运行时不可达' },
  { code: 'RUNTIME_CRASHED', re: /EPIPE|ECONNRESET|subprocess|child\s+process|exited\s+with|异常退出/i, why: '子进程崩溃' },
  { code: 'SCHEMA_MIGRATION_FAILED', re: /migration|schema[\s_-]?version|migrat/i, why: '存储迁移失败' },
])

/** 已知的 `stopReason` → 标准错误码。`completed` 不在表内（那是成功路径）。 */
export const STOP_REASON_MAP = Object.freeze({
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  aborted: 'CANCELLED',
  timeout: 'TIMEOUT',
  length: 'INVALID_RESULT',
  max_tokens: 'INVALID_RESULT',
  max_output_tokens: 'INVALID_RESULT',
  content_filter: 'INVALID_RESULT',
  tool_use: 'INVALID_RESULT',
  failed: 'RUNTIME_CRASHED',
  error: 'RUNTIME_CRASHED',
})

/**
 * 取异常的文本指纹（message + code + name）。
 *
 * 只取这些字段：异常的 `stack` 含绝对路径与内部符号，
 * 写进审计等于把内部结构泄漏出去，而且对分类没有增量信息。
 */
export function errorFingerprint(err) {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  const parts = []
  if (typeof err.name === 'string') parts.push(err.name)
  if (typeof err.code === 'string') parts.push(err.code)
  if (typeof err.message === 'string') parts.push(err.message)
  if (parts.length === 0) return String(err)
  return parts.join(': ')
}

/**
 * 把 DSH 异常或文本标准化为契约错误码。
 *
 * @param err 异常对象或错误文本
 * @param options.abortedBy 'timeout' | 'caller' | null  —— 由适配器告知是谁发起的取消。
 *   **这一项必须由调用方传入**，不能从消息猜：`AbortError` 的文本对
 *   「用户点了取消」和「看门狗超时」是一样的，而两者对用户的意义完全不同
 *   （前者不该重试，后者可以）。猜错会导致取消被当成超时而被自动重试。
 */
export function classifyDshError(err, options = {}) {
  const { abortedBy = null } = options
  const text = errorFingerprint(err)

  if (abortedBy === 'timeout') {
    return { code: 'TIMEOUT', unknown: false, detail: redactValue(text).value, why: '看门狗强制结算：run.result 未在期限内结算' }
  }
  if (abortedBy === 'caller') {
    return { code: 'CANCELLED', unknown: false, detail: redactValue(text).value, why: '调用方主动取消' }
  }
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(text)) {
      return { code: p.code, unknown: false, detail: redactValue(text).value, why: p.why }
    }
  }
  // 兜底：未知故障 → 崩溃 + unknown 标记（见文件头规则 ①）
  return {
    code: 'RUNTIME_CRASHED',
    unknown: true,
    detail: redactValue(text).value,
    why: '未识别的异常：按崩溃处理，不假设可重试',
  }
}

/**
 * `stopReason` → 标准错误码。
 *
 * 返回 `null` 表示 `completed`（成功路径，是否可信由结构化输出校验决定）。
 * **未知 stopReason 返回 INVALID_RESULT + unknown**，而不是 null——
 * 把「我不认识的停止原因」当成成功是这里最危险的写法。
 */
export function classifyStopReason(stopReason) {
  const key = String(stopReason ?? '').trim().toLowerCase()
  if (key === '') return { code: 'INVALID_RESULT', unknown: true, detail: '缺少 stopReason' }
  if (key === 'completed') return { code: null, unknown: false, detail: 'completed' }
  if (Object.hasOwn(STOP_REASON_MAP, key)) {
    return { code: STOP_REASON_MAP[key], unknown: false, detail: key }
  }
  return { code: 'INVALID_RESULT', unknown: true, detail: `未识别的 stopReason：${key}` }
}

/**
 * 构造契约异常（带脱敏后的 details）。
 *
 * `outcomeUnknown` 只在**确实可能已产生外部副作用**时才置 true——
 * 一个连不上模型的 429 不可能改了用户文件。滥用它会锁死所有重试。
 */
export function toContractError(classification, { runId, outcomeUnknown = false } = {}) {
  const entry = describeError(classification.code)
  const err = new RuntimeContractError(classification.code, classification.detail || entry.userMessage, {
    outcomeUnknown,
    details: {
      runId: runId ?? null,
      reason: classification.why ?? null,
      // 原始文本只在这里，且已脱敏；userMessage 绝不包含它
      source: classification.detail ?? null,
    },
  })
  return err
}

/** 该错误码在当前上下文下是否可自动重试。委托契约目录，适配器不自建重试策略。 */
export function retryVerdict(code, context) {
  return isRetryable(code, context)
}

// orchestrator/state-machine/failure.mjs
// ============================================================================
// 失败分类、重试退避与恢复判定（PRT-301 的异常路径；PRT-309/310/311 的逻辑部分）
//
// 纯模块。这一个文件回答三个问题，每一个的**错误默认值**都会造成不可逆后果：
//
// ① 「这个失败能自动重试吗？」——默认成「能」会让一个没见过的错误**无限重试**，
//    而无限重试外部写操作就是重复副作用。因此未登记的错误码默认**不可重试**。
//
// ② 「进程崩了，这个 Attempt 现在算什么？」——默认成「重试」会在已经发生过外部
//    副作用的情况下重跑一遍（重复付费）。因此崩溃恢复必须显式回答
//    「这次执行有没有可能已经产生了外部副作用」，缺这个输入就拒绝判定。
//
// ③ 「退避多久？」——退避为 0 会让崩溃进程变成忙等循环，把日志和 CPU 一起打满，
//    而症状是「产品变卡」而不是「有个循环」。因此 baseMs 必须 > 0。
// ============================================================================

/** 失败的三分类。分类决定 Attempt 的去向，而不是由调用方各写一遍 if。 */
export const FAILURE_CLASSES = Object.freeze({
  RETRYABLE: 'retryable',
  UNKNOWN_OUTCOME: 'unknown-outcome',
  FATAL: 'fatal',
})

/**
 * 已登记的失败码 → 分类。
 *
 * **未登记的码不在表里**：`classifyFailure` 会按「外部副作用是否可能已发生」决定
 * 它是 `unknown-outcome` 还是 `fatal`，**绝不会**给出 `retryable`。
 * 理由：新错误码意味着「我们还不知道它是什么」；对一个不认识的错误自动重试，
 * 最好的情况是浪费一次额度，最坏的情况是重复执行外部写操作。
 */
export const FAILURE_CODES = Object.freeze({
  // —— 可重试：这些失败要么明确没有产生外部副作用，要么本身就是「暂时不可用」 ——
  'runtime-unavailable': FAILURE_CLASSES.RETRYABLE,
  'connection-refused': FAILURE_CLASSES.RETRYABLE,
  'model-rate-limited': FAILURE_CLASSES.RETRYABLE,
  'model-timeout': FAILURE_CLASSES.RETRYABLE,
  'workspace-prepare-failed': FAILURE_CLASSES.RETRYABLE,
  'context-build-failed': FAILURE_CLASSES.RETRYABLE,
  'validation-failed': FAILURE_CLASSES.RETRYABLE,

  // —— 结果未知：外部写操作可能已经发生，不得自动重试（spec §6.4 / §15）——
  'external-effect-unconfirmed': FAILURE_CLASSES.UNKNOWN_OUTCOME,
  'tool-timeout-after-call': FAILURE_CLASSES.UNKNOWN_OUTCOME,
  'process-killed-mid-write': FAILURE_CLASSES.UNKNOWN_OUTCOME,

  // —— 致命：重试不会改变结果，必须人工处置 ——
  'permission-denied': FAILURE_CLASSES.FATAL,
  'approval-denied': FAILURE_CLASSES.FATAL,
  'budget-exceeded': FAILURE_CLASSES.FATAL,
  'schema-invalid-request': FAILURE_CLASSES.FATAL,
  'capability-unsupported': FAILURE_CLASSES.FATAL,
  'lease-epoch-stale': FAILURE_CLASSES.FATAL,
  cancelled: FAILURE_CLASSES.FATAL,
})

/** 分类 → Attempt 目标状态。 */
const CLASS_TO_STATE = Object.freeze({
  [FAILURE_CLASSES.RETRYABLE]: 'RetryableFailure',
  [FAILURE_CLASSES.UNKNOWN_OUTCOME]: 'UnknownOutcome',
  [FAILURE_CLASSES.FATAL]: 'DeadLetter',
})

/**
 * 分类一次失败。
 *
 * 返回 `{ ok, class, attemptState, nextTaskStatusHint, reason, code }`。
 * `nextTaskStatusHint` 交给 `states.mjs` 的 `taskStatusOf` 最终决定（它还需要重试额度）。
 */
export function classifyFailure(code, { externalEffectPossible = false, detail = null } = {}) {
  const trimmed = typeof code === 'string' ? code.trim() : ''
  if (trimmed === '') {
    return Object.freeze({
      ok: false,
      code: 'FAILURE_CODE_REQUIRED',
      message: '失败必须有可归因的码：没有码的失败无法分类，也无法在 Dead Letter 里被人看懂',
    })
  }
  const known = FAILURE_CODES[trimmed]
  if (known !== undefined) {
    if (known === FAILURE_CLASSES.FATAL && trimmed === 'cancelled') {
      return Object.freeze({
        ok: true,
        failureCode: trimmed,
        class: FAILURE_CLASSES.FATAL,
        attemptState: 'Cancelled',
        reason: '用户取消不是失败：它有自己的终态，不应出现在 Dead Letter 里',
        detail,
      })
    }
    return Object.freeze({
      ok: true,
      failureCode: trimmed,
      class: known,
      attemptState: CLASS_TO_STATE[known],
      reason: known === FAILURE_CLASSES.UNKNOWN_OUTCOME
        ? '外部结果无法确认：不得自动重试，只能人工处置（重复外部写入的代价高于等待）'
        : (known === FAILURE_CLASSES.RETRYABLE ? '已登记为可重试' : '已登记为致命：重试不会改变结果'),
      detail,
    })
  }
  // 未登记的码：不给 retryable。见文件头 ①。
  if (externalEffectPossible === true) {
    return Object.freeze({
      ok: true,
      failureCode: trimmed,
      class: FAILURE_CLASSES.UNKNOWN_OUTCOME,
      attemptState: 'UnknownOutcome',
      reason: `未登记的失败码「${trimmed}」且外部副作用可能已发生：按「结果未知」处理，不得自动重试`,
      unregistered: true,
      detail,
    })
  }
  return Object.freeze({
    ok: true,
    failureCode: trimmed,
    class: FAILURE_CLASSES.FATAL,
    attemptState: 'DeadLetter',
    reason: `未登记的失败码「${trimmed}」：按「需要人工确认」处理，**不**默认重试` +
      '（对不认识的错误自动重试，最坏情况是重复执行外部写操作）',
    unregistered: true,
    detail,
  })
}

// ---------------------------------------------------------------- 重试退避

export const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 2000,
  factor: 2,
  maxMs: 300000,
  jitter: 0,
})

/**
 * 第 n 次重试前应等待多久（指数退避 + 上限 + 可选抖动）。
 *
 * `attemptNo` 从 1 开始（第一次重试）。**必须 >= 1**：
 * 0 或负数会让 `factor ** (n-1)` 落到分数次幂上，得到比 baseMs 还小的值，
 * 于是「退避」实际上在加速——这在指数退避的实现里是很常见的一处笔误。
 */
export function retryDelayMs(attemptNo, { baseMs = DEFAULT_BACKOFF.baseMs, factor = DEFAULT_BACKOFF.factor, maxMs = DEFAULT_BACKOFF.maxMs, jitter = 0, random = Math.random } = {}) {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    return Object.freeze({ ok: false, code: 'ATTEMPT_NO_INVALID', message: `attemptNo 必须是从 1 开始的整数，收到 ${JSON.stringify(attemptNo)}` })
  }
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    return Object.freeze({
      ok: false,
      code: 'BACKOFF_BASE_INVALID',
      message: `baseMs 必须 > 0（收到 ${JSON.stringify(baseMs)}）：退避为 0 会让崩溃进程变成忙等循环，` +
        '症状是「产品变卡」而不是「有个循环」，很难归因',
    })
  }
  if (!Number.isFinite(factor) || factor < 1) {
    return Object.freeze({ ok: false, code: 'BACKOFF_FACTOR_INVALID', message: `factor 必须 >= 1，收到 ${JSON.stringify(factor)}` })
  }
  const raw = baseMs * (factor ** (attemptNo - 1))
  const capped = Math.min(raw, Number.isFinite(maxMs) && maxMs > 0 ? maxMs : raw)
  const jitterAmount = jitter > 0 ? capped * jitter * (random() * 2 - 1) : 0
  const delayMs = Math.max(0, Math.round(capped + jitterAmount))
  return Object.freeze({ ok: true, delayMs, capped: capped !== raw, attemptNo })
}

// ---------------------------------------------------------------- 恢复判定

export const RECOVERY_ACTIONS = Object.freeze([
  'none',
  'claim-eligible',
  'wait',
  'resume-in-place',
  'retry-new-attempt',
  'mark-unknown-outcome',
  'await-human',
])

/**
 * 进程/worker 重启后如何处置一个残留的 Attempt。
 *
 * 输入全部显式，**没有默认值**——判错的代价不对称：
 * 把「可能已经写过外部系统」的执行当成可重试，会重复写；把它当成结果未知，
 * 最坏只是多一次人工确认。因此这里要求调用方明确回答 `externalEffectPossible`，
 * 缺这个输入直接拒绝判定而不是猜一个。
 */
export function recoveryDecision({
  attemptState,
  leaseValid = false,
  externalEffectPossible = undefined,
  attemptInFlight = false,
} = {}) {
  if (attemptState === 'Queued') {
    return Object.freeze({ ok: true, action: 'claim-eligible', reason: '尚未领取：正常进入领取流程' })
  }
  const humanStates = ['UnknownOutcome', 'DeadLetter', 'Completed', 'Cancelled']
  if (humanStates.includes(attemptState)) {
    return Object.freeze({
      ok: true,
      action: attemptState === 'UnknownOutcome' || attemptState === 'DeadLetter' ? 'await-human' : 'none',
      reason: attemptState === 'UnknownOutcome' || attemptState === 'DeadLetter'
        ? '等待人工处置：恢复扫描不得自动推进这两个状态'
        : '终态：不动',
    })
  }
  if (leaseValid === true) {
    return Object.freeze({
      ok: true,
      action: attemptInFlight ? 'none' : 'wait',
      reason: 'lease 仍有效：由持有者继续，恢复扫描不得抢占（抢占会造成同一任务被执行两次）',
    })
  }
  // lease 已过期。到这里必须知道「有没有可能已产生外部副作用」。
  if (typeof externalEffectPossible !== 'boolean') {
    return Object.freeze({
      ok: false,
      code: 'EXTERNAL_EFFECT_UNKNOWN',
      message: `Attempt 处于 ${attemptState} 且 lease 已过期，但未说明外部副作用是否可能已发生。` +
        '这一条不能猜：判成「可重试」会在已发生副作用时重复执行，判成「未知」会让本可自动恢复的任务挂起。' +
        '调用方必须显式给出 externalEffectPossible',
    })
  }
  if (externalEffectPossible === true) {
    return Object.freeze({
      ok: true,
      action: 'mark-unknown-outcome',
      reason: 'lease 过期且外部副作用可能已发生：进入 UnknownOutcome 等人工确认，绝不自动重试',
    })
  }
  // 尚未越过外部写边界：可以安全地新建 attempt。历史 attempt 保留。
  return Object.freeze({
    ok: true,
    action: 'retry-new-attempt',
    reason: 'lease 过期且确认未产生外部副作用：新建 attempt 重试（不覆盖历史 attempt）',
  })
}

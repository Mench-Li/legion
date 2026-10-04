// product/update/schedule.mjs
// ============================================================================
// 检查节奏 —— 设计 §6（line 132–134）的可执行形式
//
// 原文拆成四句话，这里每一句都对应一个**独立**的判据：
//
//   ① 「启动达到桌面可交互状态后延迟 30～90 秒首次检查」
//      → 首次检查不锚在进程启动，而锚在 `markInteractive()`。锚错了会让
//        一次冷启动在用户还没看到窗口时就发请求，而用户感受到的是
//        "开机后风扇转了一下"。
//
//   ② 「之后以 6 小时为基准、±20% 抖动检查」
//      → 抖动是**每台机器各自**的。所有人都整点检查的部署，会在整点
//        把自己的托管打出一个尖峰，而"6 小时"这个数字让人以为已经摊平了。
//
//   ③ 「恢复前台或系统唤醒时，仅在到期后补一次，不累计执行错过的周期」
//      → 唤醒**不**触发检查，它只触发一次"到期判定"。睡 20 小时之后补
//        一次是对的；把错过的 3 次排队补出来是错的。
//
//   ④ 「手动检查立即执行，并与已有检查共享一次网络请求」
//      → 手动检查**不排队**：它要么发起，要么搭上正在飞的那一次。这条
//        规定的反面（"每次点击都发一次请求"）正是用户连点五下时会发生的事。
//
// 失败退避是第 ⑤ 条：「按 15 分钟、30 分钟、1 小时逐步退避，最终上限 6 小时，
// 加入抖动」。注意"成功恢复正常周期"是**单独**一句话：退避状态必须在一次
// 成功之后被清掉，否则一次偶发失败会让这台机器在之后很久都检查得很稀。
// ============================================================================

import { randomBytes } from 'node:crypto'

/** 设计 §6 line 132–134 的数字，集中在一处。 */
export const CHECK_POLICY_DEFAULTS = Object.freeze({
  /** 首次检查延迟区间：30～90 秒。 */
  firstDelayMinMs: 30_000,
  firstDelayMaxMs: 90_000,
  /** 正常周期：6 小时。 */
  intervalMs: 6 * 60 * 60 * 1000,
  /** ±20% 抖动。 */
  jitterRatio: 0.2,
  /** 失败退避阶梯：15 分钟 → 30 分钟 → 1 小时。 */
  backoffMs: Object.freeze([15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]),
  /** 退避上限：6 小时（与正常周期同值——再长就不叫"检查更新"了）。 */
  maxBackoffMs: 6 * 60 * 60 * 1000,
})

/** 界面需要区分的检查触发来源（设计 §7：手动失败要显示错误与重试按钮）。 */
export const CHECK_TRIGGERS = Object.freeze(['startup', 'periodic', 'manual', 'resume', 'retry'])

/** 一次检查的结论分类。只有 `failed` 与 `cancelled` 不进退避。 */
export const CHECK_OUTCOMES = Object.freeze([
  /** 有新版。 */
  'available',
  /** 没有新版（含"通道指向更旧版本"的撤回清单情形）。 */
  'up-to-date',
  /** 网络/校验失败。 */
  'failed',
  /** 被取消（退出、手动取消）。**不进退避**。 */
  'cancelled',
])

/**
 * 抖动：`base * (1 ± jitterRatio)`，但**下限与上限都夹住**。
 *
 * 夹住下限不是细节：`base=6h` 而且抖动允许下探 20% 时得到 4.8 小时，
 * 那是设计允许的；但如果有人把 `jitterRatio` 配成 1.5，不夹下限会得到
 * 一个**负的**间隔，`setTimeout(负数)` 立刻触发 → 无限循环请求托管。
 * 一个"配置错就把托管打挂"的调度器不值得信任，所以这里夹住。
 */
export function withJitter(baseMs, { jitterRatio = CHECK_POLICY_DEFAULTS.jitterRatio, random = Math.random } = {}) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new Error(`withJitter 需要正的 baseMs，实际 ${baseMs}`)
  const ratio = Math.min(Math.max(jitterRatio, 0), 1)
  const factor = 1 + (random() * 2 - 1) * ratio
  return Math.max(1, Math.round(baseMs * factor))
}

/**
 * 算下一次检查时间。**纯函数**：给定状态与随机源，结果完全确定。
 *
 * @param {object} args
 * @param {number} args.nowMs
 * @param {number|null} args.interactiveAtMs   桌面可交互的时刻（首次检查的锚点）
 * @param {number|null} args.lastCheckAtMs     上次**完成**检查的时刻
 * @param {number} args.consecutiveFailures    连续失败次数（成功时归零）
 * @param {number|null} args.notBeforeMs       最早不得早于（用于"退出前不要检查"）
 * @param {Function} args.random
 */
export function planNextCheck({
  nowMs, interactiveAtMs = null, lastCheckAtMs = null, consecutiveFailures = 0,
  notBeforeMs = null, policy = CHECK_POLICY_DEFAULTS, random = Math.random,
} = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('planNextCheck 需要 nowMs')
  const failures = Math.max(0, Math.trunc(consecutiveFailures))

  // ① 还没到可交互状态：首次检查**不**开始计时。
  if (interactiveAtMs === null) {
    return Object.freeze({
      dueAtMs: null, kind: 'waiting-interactive', intervalMs: null,
      reason: '桌面尚未达到可交互状态，首次检查不开始计时',
    })
  }

  // ② 首次检查（或者可交互之后还一次都没检查过）。
  if (lastCheckAtMs === null) {
    const raw = policy.firstDelayMinMs + random() * (policy.firstDelayMaxMs - policy.firstDelayMinMs)
    let dueAtMs = interactiveAtMs + Math.round(raw)
    if (notBeforeMs !== null && dueAtMs < notBeforeMs) dueAtMs = notBeforeMs
    return Object.freeze({
      dueAtMs, kind: 'first', intervalMs: dueAtMs - interactiveAtMs,
      reason: `首次检查延迟 ${Math.round((dueAtMs - interactiveAtMs) / 1000)} 秒`,
    })
  }

  // ⑤ 失败退避 vs ② 正常周期。两者都加抖动。
  const base = failures === 0
    ? policy.intervalMs
    : Math.min(policy.backoffMs[Math.min(failures, policy.backoffMs.length) - 1], policy.maxBackoffMs)
  const intervalMs = withJitter(base, { jitterRatio: policy.jitterRatio, random })
  let dueAtMs = Math.max(nowMs, lastCheckAtMs) + intervalMs
  if (notBeforeMs !== null && dueAtMs < notBeforeMs) dueAtMs = notBeforeMs
  return Object.freeze({
    dueAtMs,
    kind: failures === 0 ? 'periodic' : 'backoff',
    intervalMs,
    reason: failures === 0
      ? `正常周期 ${Math.round(base / 60000)} 分钟（抖动后 ${Math.round(intervalMs / 60000)} 分钟）`
      : `第 ${failures} 次连续失败，退避到 ${Math.round(intervalMs / 60000)} 分钟`,
  })
}

/**
 * ③ 唤醒/恢复前台：只在**已到期**时补一次。
 *
 * 返回的 `due` 为 false 时，调用方什么也不做——**不重排**、不累积。
 */
export function planResumeCatchUp({ nowMs, dueAtMs }) {
  if (dueAtMs === null || !Number.isFinite(dueAtMs)) {
    return Object.freeze({ due: false, reason: '还没有排定的检查时间' })
  }
  if (nowMs < dueAtMs) {
    return Object.freeze({
      due: false, reason: `尚未到期，还有 ${Math.round((dueAtMs - nowMs) / 1000)} 秒`,
    })
  }
  // ★ 措辞很关键：这里补的是"一次"，而不是"错过的那些次"。
  return Object.freeze({ due: true, reason: '已到期，补一次检查（错过的周期不累计）' })
}

/** 退避阶梯的可读读数（界面与日志用）。 */
export function describeBackoff(consecutiveFailures, policy = CHECK_POLICY_DEFAULTS) {
  const failures = Math.max(0, Math.trunc(consecutiveFailures))
  if (failures === 0) return Object.freeze({ step: 0, baseMs: policy.intervalMs, label: '正常周期' })
  const index = Math.min(failures, policy.backoffMs.length) - 1
  const baseMs = Math.min(policy.backoffMs[index], policy.maxBackoffMs)
  const atCeiling = failures > policy.backoffMs.length
  return Object.freeze({
    step: failures, baseMs, atCeiling,
    label: atCeiling ? `退避已达上限 ${Math.round(baseMs / 60000)} 分钟` : `退避第 ${failures} 档 ${Math.round(baseMs / 60000)} 分钟`,
  })
}

// ---------------------------------------------------------------------------
// 调度器
// ---------------------------------------------------------------------------

/**
 * 建立检查调度器。
 *
 * 外部效果全部注入（计时器、时钟、随机源、实际检查函数），因为"6 小时后
 * 会不会检查"这件事没法在测试里等。判据（`planNextCheck`）是纯函数，
 * 调度器只负责把判据接到计时器上。
 *
 * @param {object} args
 * @param {(trigger: string, signal: AbortSignal) => Promise<{outcome: string}>} args.runCheck
 * @param {Function} [args.onState] 状态变化回调（界面订阅用）
 */
export function createCheckScheduler({
  runCheck,
  policy = CHECK_POLICY_DEFAULTS,
  now = () => Date.now(),
  random = Math.random,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  onState = () => {},
  log = () => {},
} = {}) {
  if (typeof runCheck !== 'function') throw new Error('createCheckScheduler 需要 runCheck')

  let interactiveAtMs = null
  let lastCheckAtMs = null
  let lastOutcome = null
  let lastError = null
  let consecutiveFailures = 0
  let dueAtMs = null
  let dueKind = null
  let dueReason = null
  let timer = null
  let inFlight = null
  let stopped = false

  function snapshot() {
    return Object.freeze({
      interactiveAtMs,
      lastCheckAtMs,
      lastOutcome,
      lastError,
      consecutiveFailures,
      dueAtMs,
      dueKind,
      dueReason,
      inFlight: inFlight !== null,
      stopped,
      backoff: describeBackoff(consecutiveFailures, policy),
    })
  }

  function publish() { onState(snapshot()) }

  function reschedule({ trigger = 'periodic' } = {}) {
    if (stopped) return snapshot()
    const plan = planNextCheck({ nowMs: now(), interactiveAtMs, lastCheckAtMs, consecutiveFailures, policy, random })
    dueAtMs = plan.dueAtMs
    dueKind = plan.kind
    dueReason = plan.reason
    if (timer !== null) { clearTimer(timer); timer = null }
    if (dueAtMs !== null) {
      const delay = Math.max(0, dueAtMs - now())
      log(`[update] 下次检查：${plan.kind} ${new Date(dueAtMs).toISOString()}（${plan.reason}）`)
      timer = setTimer(() => { void run('periodic') }, delay)
      if (typeof timer?.unref === 'function') timer.unref()
    }
    publish()
    return snapshot()
  }

  /**
   * 跑一次检查。**同一个时刻只会有一个在飞**——手动检查搭上它。
   *
   * 返回的 promise 对所有并发调用者是**同一个**：这就是"共享一次网络请求"
   * 的实现方式，而不是"两个请求碰巧同时发出"。
   */
  function run(trigger = 'periodic') {
    if (stopped) return Promise.resolve(Object.freeze({ outcome: 'cancelled', shared: false, reason: '调度器已停止' }))
    // ★ 并发调用拿到的是**同一个 promise**。这就是设计 §6 那句「手动检查
    //   与已有检查共享一次网络请求」的实现方式：不是"尽量错开"，而是
    //   第二次调用根本不会发出第二个请求。
    if (inFlight !== null) {
      return inFlight.then((result) => Object.freeze({ ...result, shared: true, sharedWith: result.trigger ?? null }))
    }
    const startedAtMs = now()
    const controller = new AbortController()
    const current = (async () => {
      let result
      try {
        const produced = await runCheck(trigger, controller.signal)
        result = Object.freeze({ ...produced, trigger, startedAtMs, finishedAtMs: now() })
      } catch (error) {
        result = Object.freeze({
          outcome: 'failed', trigger, startedAtMs, finishedAtMs: now(),
          code: error?.code ?? 'update-check-failed', reason: error?.message ?? String(error),
        })
      }
      lastCheckAtMs = result.finishedAtMs
      lastOutcome = result.outcome
      lastError = result.outcome === 'failed'
        ? Object.freeze({ code: result.code ?? null, reason: result.reason ?? null })
        : null
      // ⑤ 成功恢复正常周期；失败进下一档退避；取消**不动**退避计数
      //    （一次"用户点了取消"不该让下次检查被推远）。
      if (result.outcome === 'failed') consecutiveFailures += 1
      else if (result.outcome !== 'cancelled') consecutiveFailures = 0
      return result
    })()
    inFlight = current
    const settle = () => {
      if (inFlight === current) inFlight = null
      reschedule({ trigger })
    }
    void current.then(settle, settle)
    publish()
    return current
  }

  return Object.freeze({
    snapshot,
    /** ① 桌面可交互。首次检查从这一刻开始计时。 */
    markInteractive() {
      if (stopped) return snapshot()
      if (interactiveAtMs === null) interactiveAtMs = now()
      return reschedule({ trigger: 'startup' })
    },
    /** ④ 手动检查：**立即**跑（或者搭上在飞的那一次）。 */
    manual() {
      if (stopped) return Promise.resolve(Object.freeze({ outcome: 'cancelled', reason: '调度器已停止' }))
      return run('manual')
    },
    /** ③ 恢复前台/系统唤醒：只在到期时补一次。 */
    notifyResume() {
      if (stopped) return Object.freeze({ due: false, reason: '调度器已停止' })
      const plan = planResumeCatchUp({ nowMs: now(), dueAtMs })
      if (!plan.due) return plan
      void run('resume')
      return plan
    },
    /** 用户点"重试"：等同于手动，但触发来源分开记（界面文案不同）。 */
    retry() {
      if (stopped) return Promise.resolve(Object.freeze({ outcome: 'cancelled', reason: '调度器已停止' }))
      return run('retry')
    },
    stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
      dueAtMs = null
      dueKind = null
      publish()
      return snapshot()
    },
    /** 让出计时器（退出前调用，避免退出流程里又触发一次检查）。 */
    suspend() {
      if (timer !== null) { clearTimer(timer); timer = null }
      publish()
      return snapshot()
    },
    reschedule,
  })
}

/**
 * 生成一个**每台机器不同**的抖动种子。
 *
 * 不用 `Math.random` 的默认实现是为了让"同一台机器在重启之后抖动稳定"，
 * 但设计只要求"不要所有机器同时检查"，所以随机就够。保留这个函数是为了
 * 将来要做稳定抖动时有唯一的落点。
 */
export function jitterSeed() {
  return randomBytes(8).readUInt32BE(0)
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckSchedule() {
  const problems = []
  const p = CHECK_POLICY_DEFAULTS
  if (p.firstDelayMinMs !== 30_000 || p.firstDelayMaxMs !== 90_000) problems.push('首次检查延迟不是 30～90 秒')
  if (p.intervalMs !== 6 * 60 * 60 * 1000) problems.push('正常周期不是 6 小时')
  if (p.jitterRatio !== 0.2) problems.push('抖动不是 ±20%')
  if (p.backoffMs.join(',') !== [15, 30, 60].map((m) => m * 60_000).join(',')) problems.push('退避阶梯不是 15/30/60 分钟')
  if (p.maxBackoffMs !== 6 * 60 * 60 * 1000) problems.push('退避上限不是 6 小时')

  // ① 未进入可交互状态：没有排定时间。
  const notInteractive = planNextCheck({ nowMs: 0, random: () => 0.5 })
  if (notInteractive.dueAtMs !== null) problems.push('未可交互时排定了检查')

  // ① 首次检查落在区间内。
  for (const r of [0, 0.5, 0.999]) {
    const plan = planNextCheck({ nowMs: 0, interactiveAtMs: 1000, random: () => r })
    const delay = plan.dueAtMs - 1000
    if (delay < p.firstDelayMinMs || delay > p.firstDelayMaxMs) problems.push(`首次延迟 ${delay} 越界（random=${r}）`)
  }

  // ② 正常周期在 ±20% 内。
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const plan = planNextCheck({ nowMs: 0, interactiveAtMs: 0, lastCheckAtMs: 0, consecutiveFailures: 0, random: () => r })
    if (plan.intervalMs < p.intervalMs * 0.8 || plan.intervalMs > p.intervalMs * 1.2) {
      problems.push(`正常周期 ${plan.intervalMs} 越出 ±20%（random=${r}）`)
    }
  }

  // ⑤ 退避阶梯随失败次数上升，并在上限夹住。
  const ladder = [1, 2, 3].map((failures) => planNextCheck({
    nowMs: 0, interactiveAtMs: 0, lastCheckAtMs: 0, consecutiveFailures: failures, random: () => 0.5,
  }).intervalMs)
  if (!(ladder[0] < ladder[1] && ladder[1] < ladder[2])) problems.push(`退避阶梯没有递增：${ladder.join(',')}`)
  if (ladder[0] !== Math.round(15 * 60_000 * 1)) problems.push('第一次退避不是 15 分钟')
  const ceiling = planNextCheck({
    nowMs: 0, interactiveAtMs: 0, lastCheckAtMs: 0, consecutiveFailures: 99, random: () => 0.5,
  })
  if (ceiling.intervalMs > p.maxBackoffMs) problems.push('退避超过上限')

  // 抖动不能产出非正间隔（配置写错时也不能）。
  const extreme = withJitter(1000, { jitterRatio: 5, random: () => 0 })
  if (!(extreme >= 1)) problems.push(`极端抖动产出了非正间隔：${extreme}`)

  // ③ 唤醒只在到期时触发一次。
  if (planResumeCatchUp({ nowMs: 100, dueAtMs: 200 }).due) problems.push('未到期时唤醒触发了检查')
  if (!planResumeCatchUp({ nowMs: 300, dueAtMs: 200 }).due) problems.push('已到期时唤醒没有触发检查')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    policy: p,
    sample: Object.freeze({
      firstDelays: [0, 0.5, 1].map((r) => planNextCheck({ nowMs: 0, interactiveAtMs: 1000, random: () => r }).intervalMs),
      ladder,
      ceilingMs: ceiling.intervalMs,
    }),
  })
}

export const SCHEDULE_CHECKED = selfCheckSchedule()

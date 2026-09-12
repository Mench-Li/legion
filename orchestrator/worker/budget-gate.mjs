// orchestrator/worker/budget-gate.mjs
// ============================================================================
// 执行路径上的预算闸门（PRT-510 的**运行侧**接线）
//
// ## 为什么还要一个模块
//
// `team-hub/budget-ledger.mjs` 已经完整实现了「原子预留 / 采集 / 结算 /
// 取消 / Unknown Outcome 锁定」，并且有套件、全绿、HTTP 路由齐全
// （`/api/runtime/run-budget/reserve|observe|settle|resolve`）。
//
// 而**执行路径上一次都没有调用过它**。
//
//   > 一个功能没有入口，与一个功能不存在，在用户看来完全一样。
//
// 这条与 PRT-253 是同一个形状的缺口，所以修法也一样：给出那个入口。
//
// ## 只靠事后的 `checkBudget` 是不够的
//
// `runtime/adapters/dsh/usage.mjs` 的 `checkBudget` 在**运行结束之后**
// 拿实际 usage 判一次超支。它能回答"这次花超了吗"，
// 但**回答不了"这笔钱现在还在不在"**。
//
// 差别在并发上：两个 Attempt 各有 $5 上限、账户里一共 $5。
// 事后判定会让两次都跑完、都"没超自己的上限"、一共花 $10。
// 预留是唯一能拦住这件事的动作——因为它在**花钱之前**把钱占住。
//
//   > 「花了多少」可以在事后回答；「还能不能花」只能在事前回答。
//
// ## 三件事必须成对
//
// 预留与结算是一对。只预留不结算 = 余额被永久占住（表现为"能跑但都说没钱"）；
// 只结算不预留 = 账本里出现一笔没有预留的支出。
// 因此本模块把两者绑在同一个 `runBudgeted()` 里，
// 并且**失败方向永远是"钱还占着"而不是"钱放掉了"**：
//
//   · 预留失败 → 不执行（这是闸门，不是建议）
//   · 结算失败 → 预留继续占着，并如实上报（`settleFailed`）
//   · 结果未知 → 转 `locked`，**不写任何金额**，等人工处置
//
// ## 结算发生在终态之后，而不是"execute 返回之后"
//
// 映射是显式的：
//
//   completed / failed / cancelled → settle({ outcome: 'known' })   用实际用量
//   outcome_unknown                → settle({ outcome: 'unknown' }) → locked
//
// `outcome_unknown` 走 `locked` 而不是当作 0 结算，理由在账本模块头已经写过：
// **写入任何数字都等于宣称"算清了"**，而那时我们恰恰不知道算没算清。
// ============================================================================

/** 本模块的具名码。跨进程读取（worker 上报 → hub 记录 → 人排查），属契约。 */
export const BUDGET_GATE_CODES = Object.freeze({
  /** 预留失败：余额不够，或预算参数本身不合法。 */
  RESERVE_FAILED: 'BUDGET_RESERVE_FAILED',
  /** 预算未启用（没有预算上限）——如实记下，不让它隐形。 */
  UNBOUNDED: 'BUDGET_UNBOUNDED',
  /** 结算失败：预留仍占着，需要人工看。 */
  SETTLE_FAILED: 'BUDGET_SETTLE_FAILED',
  /** 结算用的 actor 没给。谁结算的必须留痕。 */
  ACTOR_REQUIRED: 'BUDGET_ACTOR_REQUIRED',
  /** 接线错误。 */
  BAD_WIRING: 'BUDGET_BAD_WIRING',
})

export class BudgetGateError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BudgetGateError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** 终态 outcome → 结算用的账本 outcome。`outcome_unknown` 之外的都算"已知"。 */
export function settlementOutcomeFor(runOutcome) {
  if (runOutcome === 'outcome_unknown') return 'unknown'
  // 其余（completed / failed / cancelled / timed-out / 任何未知字符串）
  // 一律走"已知"：它们都已经结束了，用量是可读的。
  // **不把未知字符串映射成 'unknown'**：那会让一处拼写错误把余额永久锁住，
  // 而锁住的表现是"这个 worker 之后都说没钱"——排查方向会被带偏。
  return 'known'
}

/** 从终态事件的 usage 里取两个 token 数。取不到就是 `null`（不是 0）。 */
export function tokensOf(terminalEvent) {
  const u = terminalEvent?.usage
  if (u === null || typeof u !== 'object') return { tokensIn: null, tokensOut: null }
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return { tokensIn: n(u.tokensIn), tokensOut: n(u.tokensOut) }
}

/**
 * 造一个预算闸门。
 *
 * @param {object} deps
 * @param {(path: string, body: object) => Promise<{status:number, body:object}>} deps.post
 *   hub 的 POST 适配器（与 `context-stage.mjs` 同一个形状，复用同一条注入通道）。
 * @param {string} deps.actor 谁在花钱必须留痕（worker id 或用户名）。
 * @param {string} [deps.scope]
 * @param {string} [deps.currency]
 * @param {(meta: object) => void} [deps.onNote] 诊断输出（不给就静默，但不影响判定）。
 */
export function createBudgetGate(deps = {}) {
  const { post, actor, scope = 'default', currency = 'USD', onNote = null } = deps

  if (typeof post !== 'function') {
    throw new BudgetGateError(BUDGET_GATE_CODES.BAD_WIRING,
      'createBudgetGate 需要 post(path, body)：预留与结算都要经 hub 的账本路由。' +
      '少了它，这条路径只能"假装花过钱"')
  }
  if (typeof actor !== 'string' || actor.trim() === '') {
    // 不默认一个 actor：**谁结算的必须留痕**，而一个默认值会让"没人签名"
    // 与"某人签了名"在账本里长得一样。
    throw new BudgetGateError(BUDGET_GATE_CODES.ACTOR_REQUIRED,
      'createBudgetGate 需要 actor：谁花的钱、谁结算的必须留痕，不给默认值')
  }

  const note = (payload) => { if (typeof onNote === 'function') onNote(payload) }

  /** 调一条账本路由，把非 2xx 变成异常（带 hub 的具名码）。 */
  async function call(path, body, failCode) {
    const res = await post(path, body)
    if (res === null || typeof res !== 'object') {
      throw new BudgetGateError(failCode, `${path} 无响应`, { path })
    }
    if (res.status < 200 || res.status >= 300 || res.body?.ok !== true) {
      throw new BudgetGateError(failCode,
        `${path} 失败（HTTP ${res.status}）：${res.body?.error ?? '无说明'}`,
        { path, status: res.status, hubCode: res.body?.code ?? null })
    }
    return res.body
  }

  /**
   * 运行前预留。
   *
   * 返回 `{ budgetState, reservation }`。`budgetState === 'unbounded'`
   * 表示这次运行**没有上限**——账本照实这么说，调用方可以据此决定要不要拒绝。
   */
  async function reserve(lease) {
    const attemptId = lease?.attemptId
    if (typeof attemptId !== 'string' || attemptId === '') {
      throw new BudgetGateError(BUDGET_GATE_CODES.BAD_WIRING, 'lease 缺 attemptId：账本的键是一次 Attempt')
    }
    const budget = lease.budget ?? null
    const body = {
      attemptId,
      scope: lease.scope ?? scope,
      taskId: lease.taskId ?? null,
      modelProfileId: lease.modelProfileRef ?? null,
      budget,
      priceTableVersion: lease.priceTableVersion ?? null,
      currency,
      tokensIn: lease.estimatedTokensIn ?? 0,
      tokensOut: lease.estimatedTokensOut ?? 0,
      actor: actor.trim(),
    }
    const out = await call('/api/runtime/run-budget/reserve', body, BUDGET_GATE_CODES.RESERVE_FAILED)
    const budgetState = out.budgetState ?? null
    if (budgetState === 'unbounded') {
      // **如实说出来，而不是让它隐形。** 一个没有上限的运行与一个有上限的运行
      // 在日志里长得一样，而它们的风险完全不同。
      note({
        kind: BUDGET_GATE_CODES.UNBOUNDED,
        detail: `Attempt ${attemptId} 没有预算上限（budgetState=unbounded）：这次运行的花费不会被任何预留挡住`,
      })
    }
    return Object.freeze({ budgetState, reservation: out.reservation ?? null })
  }

  /**
   * 终态结算。
   *
   * **不抛**：一次结算失败不该把已经跑完的执行结果变成异常——
   * 那会让调用方丢掉 outcome（于是不知道该不该重试），而钱那边其实只是"还占着"。
   * 失败以 `{ settled: false, code }` 如实返回，由调用方决定怎么上报。
   */
  async function settle(lease, runOutcome, terminalEvent = null) {
    const attemptId = lease?.attemptId
    const { tokensIn, tokensOut } = tokensOf(terminalEvent)
    const body = {
      attemptId,
      outcome: settlementOutcomeFor(runOutcome),
      actor: actor.trim(),
      modelProfileId: lease?.modelProfileRef ?? null,
      tokensIn,
      tokensOut,
      reason: runOutcome === 'outcome_unknown'
        ? '运行结果未知：余额保持占用，等人工处置'
        : `运行结束（${runOutcome}）`,
    }
    try {
      const out = await call('/api/runtime/run-budget/settle', body, BUDGET_GATE_CODES.SETTLE_FAILED)
      return Object.freeze({ settled: true, reservation: out.reservation ?? null, tokensIn, tokensOut })
    } catch (e) {
      // 失败的**方向**是安全的：预留仍然占着（钱没被放掉），只是需要有人看。
      note({
        kind: BUDGET_GATE_CODES.SETTLE_FAILED,
        attemptId,
        detail: `Attempt ${attemptId} 结算失败：${e?.message ?? e}。` +
          '预留仍然占着——这个方向是安全的，但需要人工处置，否则余额会被一直占住',
        hubCode: e?.hubCode ?? null,
      })
      return Object.freeze({ settled: false, code: e?.code ?? null, message: e?.message ?? String(e), tokensIn, tokensOut })
    }
  }

  /**
   * 运行中采集一次实际用量。
   *
   * 账本可能要求取消（到了硬上限）。**本模块不自己取消**——
   * 它不知道 Run 的生命周期，而"以为取消已经发出去了"是最坏的一种错觉。
   * 返回 `{ cancel: true }` 由调用方去真的取消。
   */
  async function observe(lease, usage) {
    if (usage === null || typeof usage !== 'object') return Object.freeze({ cancel: false })
    try {
      const out = await call('/api/runtime/run-budget/observe', {
        attemptId: lease?.attemptId,
        tokensIn: usage.tokensIn ?? null,
        tokensOut: usage.tokensOut ?? null,
        modelProfileId: lease?.modelProfileRef ?? null,
      }, BUDGET_GATE_CODES.RESERVE_FAILED)
      return Object.freeze({ cancel: out.cancel === true, kind: out.kind ?? null, reservation: out.reservation ?? null })
    } catch (e) {
      // 采集失败不改变预算判定：宁可继续跑（超支仍会被事后判定抓到），
      // 也不因为一次网络抖动把一次正常运行杀掉。
      note({ kind: 'BUDGET_OBSERVE_FAILED', attemptId: lease?.attemptId, detail: e?.message ?? String(e) })
      return Object.freeze({ cancel: false })
    }
  }

  return Object.freeze({ reserve, settle, observe })
}

/**
 * 把「预留 → 执行 → 结算」绑成一次调用。
 *
 * 这是**唯一**应当被执行的形状：分成两步调用的调用方迟早会漏掉结算，
 * 而漏掉结算的表现是"能跑但一直说没钱"——一个看起来像配置问题的账务泄漏。
 *
 * @param {object} input
 * @param {object} input.gate `createBudgetGate` 的产物
 * @param {object} input.lease
 * @param {(lease: object) => Promise<{outcome: string, detail?: string}>} input.run
 * @param {() => object|null} [input.terminalEventOf]
 *   取本次运行的终态事件（用于读 usage）。给了就在结算时带上真实用量。
 * @param {boolean} [input.requireBounded]
 *   `true` 时**没有上限就不执行**。默认 `false`——默认拒绝会让每一次
 *   没配预算的调用都静默失败，而"默认放行"会让无上限运行隐形。
 *   两者都不好，所以把它变成调用方的一个**显式选择**，并在返回里如实报告
 *   `budgetState`，让"没上限"这件事始终可见。
 */
export async function runBudgeted({ gate, lease, run, terminalEventOf = null, requireBounded = false } = {}) {
  if (gate === null || typeof gate !== 'object') {
    throw new BudgetGateError(BUDGET_GATE_CODES.BAD_WIRING, 'runBudgeted 需要 gate')
  }
  if (typeof run !== 'function') {
    throw new BudgetGateError(BUDGET_GATE_CODES.BAD_WIRING, 'runBudgeted 需要 run(lease)')
  }

  // ① 预留。失败就是**不执行**——这是闸门，不是建议。
  const { budgetState, reservation } = await gate.reserve(lease)
  if (requireBounded === true && budgetState !== 'bounded') {
    throw new BudgetGateError(BUDGET_GATE_CODES.UNBOUNDED,
      `Attempt ${lease?.attemptId} 没有预算上限（budgetState=${budgetState}），` +
      '而调用方声明了 requireBounded：**不执行**。' +
      '一个没有上限的运行是一次不受任何预留约束的支出',
      { attemptId: lease?.attemptId, budgetState })
  }

  // ② 执行。抛错也要走到结算——半途抛出时用量未知，按"结果未知"锁住。
  let result
  let threw = null
  try {
    result = await run(lease)
  } catch (e) {
    threw = e
  }

  const terminalEvent = typeof terminalEventOf === 'function' ? terminalEventOf() : null
  const outcome = threw !== null ? 'outcome_unknown' : (result?.outcome ?? 'outcome_unknown')

  // ③ 结算。**抛错路径也结算**，且按"未知"——因为我们不知道那些 token 花掉没有。
  const settlement = await gate.settle(lease, outcome, terminalEvent)

  if (threw !== null) throw threw
  return Object.freeze({
    ...result,
    budgetState,
    reservation,
    settlement,
  })
}

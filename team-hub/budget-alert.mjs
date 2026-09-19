// team-hub/budget-alert.mjs
// ============================================================================
// F-15 用量/成本/预算 —— **告警与降级**那一半（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.4）
//
// spec 那一行逐字是：
//
//   > **F-15 用量/成本/预算**：按 scope、goal、task、employee、model 记录
//   > token、调用次数、耗时和成本，支持**告警、降级、暂停和硬阻止**。
//
// 四件事里，「暂停」与「硬阻止」由 `budget-ledger.mjs` 实现（预留超限 ⇒
// `cancel-requested` ⇒ 调用方去真的取消 Run 并把 Attempt 标 `BUDGET_EXCEEDED`）；
// 「按五个维度读出来」由 `usage-rollup.mjs` 实现。
//
// **本模块补的是剩下那两件：告警与降级。**
//
// ## 为什么这两件不能靠"读一下报表，看数字大不大"糊过去
//
// 因为 `usageTotals()` 里**每一个数字都有一个"不知道"的邻居**——
// 那是 `usage-rollup.mjs` 用整篇文件头立下的纪律。而告警这条路上，
// 那条纪律会变成一个**具体的、危险的**输出：
//
//   已知花费 0 元 / 上限 100 元 / 但有 7 条记录金额未知
//     ⇒ `spent / limit = 0` ⇒ **"一切正常，离上限还远"**
//
// 而真相是**有 7 笔账不知道多少钱**，其中一笔可能已经超了。
//
//   > 一张把"不知道"当成"还没花"的告警，
//   > 与一张真的"还没花"的告警，是一模一样的绿——
//   > 只不过前者的绿会在**最需要它红的那一次**继续保持绿。
//
// ## 于是本模块把"两个正交的东西"分开报，再用一条规则把它们接起来
//
//   · `level`       —— 序数，**只由已知金额**算出来：`ok` < `warn` < `degrade` < `block`
//   · `confidence`  —— `exact` / `partial` / `unknown`，**由"不知道有多少条"算出来**
//   · `action`      —— 由两者**取更严的那一个**（见下）
//   · `allClear`    —— 一个布尔，**只有在 `configured && level === 'ok' && confidence === 'exact'`
//                      时才为 true**
//
// 把 `confidence` 塞进 `level` 的序数里是**错的**：那是两个不同的问题
// （"花了多少" vs "这个数可不可信"），合成一列之后必然要选一个，
// 而无论怎么选都会丢东西——丢了之后的表现，就是上面那句"离上限还远"。
//
// ### 那条接起来的规则（**只有这一条**）
//
//   1. `confidence !== 'exact'` 时，`action` **永远不许是 `none`**；
//   2. 已知金额跨过某一级时，那一级的 `action` 照常生效；
//   3. `action` 取 1 与 2 里**更严**的那个。
//
// 规则 1 是全部要点：它保证了"数不可信"这个事实**不可能**被读成一个放行。
//
// ## 三条不许发明的东西（与 PRT-253 §3 同一条纪律）
//
//   ① **不发明上限。** 没给 `limit` 就**抛**，不落回任何默认值——
//      一个"没配上限所以按 0 处理"的实现，会让每一道预算告警
//      在**没配**的时候报绿。
//   ② **不发明阈值。** 没给 `thresholds` 时 `configured: false`，
//      而 `allClear` **照样是 false**——"没配告警"与"一切正常"必须分得开。
//   ③ **不发明降级目标。** 降到哪个模型是**配置**，不是本模块的知识；
//      降级那级被触发而没人给目标时，报 `DEGRADE_TARGET_UNSET`，
//      而不是替调用方挑一个便宜的。
//
//   还有一条**不做**的：混币种时**不换算**。汇率是一个会随时间变的外部事实，
//   而告警不该偷偷引入它——混币种直接落 `confidence: 'unknown'`。
// ============================================================================

/** 本模块的形状版本。改变返回结构时必须改它。 */
export const BUDGET_ALERT_VERSION = 'legion/budget-alert@1'

/**
 * 花费等级，**序数**（数组顺序就是严重度顺序）。
 *
 * `ok` 是唯一表示"可以放行"的一级；其余三级都要求动作。
 */
export const BUDGET_ALERT_LEVELS = Object.freeze(['ok', 'warn', 'degrade', 'block'])

/** 这个读数有多可信。与 `level` **正交**，不许互相折算。 */
export const BUDGET_ALERT_CONFIDENCE = Object.freeze(['exact', 'partial', 'unknown'])

/**
 * 该做的动作，**序数**（数组顺序就是严重度顺序）。
 *
 * `review` 是一个真实动作而不是"什么都不做"：它的意思是
 * **"这个数不足以支撑放行，要人看一眼"**。
 */
export const BUDGET_ALERT_ACTIONS = Object.freeze(['none', 'review', 'degrade-model', 'block-new-runs'])

/** 三个阈值名。数组顺序**必须**是严重度顺序，下面按它做单调性校验。 */
export const BUDGET_ALERT_RUNGS = Object.freeze(['warn', 'degrade', 'block'])

export const BUDGET_ALERT_CODES = Object.freeze({
  LIMIT_REQUIRED: 'LIMIT_REQUIRED',
  LIMIT_INVALID: 'LIMIT_INVALID',
  THRESHOLDS_INVALID: 'THRESHOLDS_INVALID',
  THRESHOLD_OUT_OF_RANGE: 'THRESHOLD_OUT_OF_RANGE',
  THRESHOLDS_UNORDERED: 'THRESHOLDS_UNORDERED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  TOTALS_INVALID: 'TOTALS_INVALID',
  PREVIOUS_LEVEL_INVALID: 'PREVIOUS_LEVEL_INVALID',
})

/** 出现在 `reasons` 里的具名理由。它们是读的人据此分支的东西，所以是封闭集合。 */
export const BUDGET_ALERT_REASONS = Object.freeze([
  'NOT_CONFIGURED',        // 没配阈值 ⇒ 无法认证"一切正常"
  'SPEND_UNKNOWN',         // 有记录金额未知，且**一条已知的都没有**
  'SPEND_PARTIAL',         // 有记录金额未知，但还有已知的
  'MIXED_CURRENCY',        // 金额之和没有意义
  'LIMIT_CROSSED',         // 已知金额已跨过某一级
  'DEGRADE_TARGET_UNSET',  // 降级那级被触发，而没人说降到哪
])

function fail(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

const levelIndex = (lv) => BUDGET_ALERT_LEVELS.indexOf(lv)
const actionIndex = (a) => BUDGET_ALERT_ACTIONS.indexOf(a)

/** 每一级对应的动作。这是一张**定义**表，不是默认值。 */
const ACTION_FOR_LEVEL = Object.freeze({
  ok: 'none',
  warn: 'review',
  degrade: 'degrade-model',
  block: 'block-new-runs',
})

/**
 * 数不可信时的动作下限。**这就是那条规则 1**，写成一张表以便被用例钉住。
 *
 * `partial` 与 `unknown` 都给 `review`：我们**没有**理由按一个不知道的数
 * 去封别人的运行——但同样没有理由说"没事"。⇒ 交给人看。
 * ★ 它**不许**是 `none`，那是本模块存在的全部意义。
 */
const ACTION_FLOOR_FOR_CONFIDENCE = Object.freeze({
  exact: 'none',
  partial: 'review',
  unknown: 'review',
})

/**
 * ★★★ 上面那张表与 `BUDGET_ALERT_CONFIDENCE` **必须逐项对齐**。
 *
 *   这条不变式是**机械的**，因为它们的漂移是**静默**的：
 *   `ACTION_FLOOR_FOR_CONFIDENCE[confidence]` 在遇到一个未登记的置信度时
 *   返回 `undefined`，而 `strictestAction(fromLevel, undefined)` 会把它
 *   当作一个新的动作档位——于是**动作下限凭空消失**，而一行错都没有。
 *
 *   > 一张把置信度映射到动作下限的表，与一张**少了一行**的同名表，
 *   > 在"这次告警该不该拦住"这个读数上是同一个东西：都不会报错。
 *
 *   所以：**声明一个置信度而不给它动作下限**必须是一个**构造期就炸**的编程错误，
 *   不是一个运行期才可能显形的空值。（这与 `RUN_RECORD_FIELD_NOT_WIRED` 同族。）
 */
export function confidenceFloorsAligned({ vocabulary = BUDGET_ALERT_CONFIDENCE, floors = ACTION_FLOOR_FOR_CONFIDENCE } = {}) {
  const missingFloor = vocabulary.filter((c) => floors[c] === undefined)
  const undeclared = Object.keys(floors).filter((c) => !vocabulary.includes(c))
  return Object.freeze({
    ok: missingFloor.length === 0 && undeclared.length === 0,
    missingFloor: Object.freeze(missingFloor),
    undeclared: Object.freeze(undeclared),
  })
}

{
  // ★ 这里**直接遍历那两张表本身**（而不是遍历一个形参）——因为"这张表有没有
  //   机械消费者"是一个可被读出来的事实，而不是一句注释里的承诺。
  //   （第 40 轮 `RUN_RECORD_OPTIONAL_FIELDS` 的教训：声明表 + 手写名字 = 装饰。）
  for (const confidence of BUDGET_ALERT_CONFIDENCE) {
    if (ACTION_FLOOR_FOR_CONFIDENCE[confidence] === undefined) {
      throw new Error(`budget-alert：置信度「${confidence}」**没有动作下限**。`
        + '`ACTION_FLOOR_FOR_CONFIDENCE[它]` 是 `undefined` ⇒ `strictestAction` 会把它当成'
        + '一个新档位 ⇒ **动作下限凭空消失，而一行错都没有**。')
    }
  }
  for (const key of Object.keys(ACTION_FLOOR_FOR_CONFIDENCE)) {
    if (!BUDGET_ALERT_CONFIDENCE.includes(key)) {
      throw new Error(`budget-alert：动作下限表里的「${key}」不在置信度词表里——`
        + '一条永远不会被走到的下限规则，与一条写错的规则是同一个东西。')
    }
  }
}

/** 取更严的那个动作。 */
const strictestAction = (a, b) => (actionIndex(a) >= actionIndex(b) ? a : b)

/**
 * 校验阈值表。
 *
 * 三条拒绝，各自具名：
 *   · 给了一个不认识的名字 —— 静默忽略它会让"我配了 block: 0.5"与"没配"
 *     在读数上同形（那正是"配了没生效"那一类事故）；
 *   · 比例不在 `(0, 1]` —— 0 会让**每一次**求值都触发，
 *     而 `> 1` 会让那一级**永远不触发**（一个永远不触发的告警与没有它一样）；
 *   · 不严格递增 —— `warn: 0.8, degrade: 0.5` 时"降级"比"告警"先到，
 *     于是**降级这一级永远不会被观察到**（它一出现就已经被 warn 盖住）。
 */
function normalizeThresholds(thresholds) {
  if (thresholds === undefined || thresholds === null) return { configured: false, ratios: {} }
  if (typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw fail(BUDGET_ALERT_CODES.THRESHOLDS_INVALID,
      `阈值表必须是一个对象，收到 ${Array.isArray(thresholds) ? '数组' : typeof thresholds}`)
  }

  const unknown = Object.keys(thresholds).filter((k) => !BUDGET_ALERT_RUNGS.includes(k))
  if (unknown.length > 0) {
    throw fail(BUDGET_ALERT_CODES.THRESHOLDS_INVALID,
      `不认识的阈值名 ${JSON.stringify(unknown)}；可选 ${BUDGET_ALERT_RUNGS.join(' / ')}。`
      + '★ 不静默忽略：忽略它会让"我配了它"与"没配"在读数上同形')
  }

  const ratios = {}
  for (const rung of BUDGET_ALERT_RUNGS) {
    if (thresholds[rung] === undefined || thresholds[rung] === null) continue
    const v = thresholds[rung]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw fail(BUDGET_ALERT_CODES.THRESHOLDS_INVALID,
        `${rung} 的比例必须是一个有限数，收到 ${JSON.stringify(v)}`)
    }
    if (!(v > 0 && v <= 1)) {
      throw fail(BUDGET_ALERT_CODES.THRESHOLD_OUT_OF_RANGE,
        `${rung} = ${v} 不在 (0, 1] 里。`
        + '0 会让每一次求值都触发；> 1 会让这一级永远不触发——'
        + '而一个永远不触发的告警与没有它，在"它有没有救过我"这件事上是同一个回答')
    }
    ratios[rung] = v
  }

  const present = BUDGET_ALERT_RUNGS.filter((r) => ratios[r] !== undefined)
  for (let i = 1; i < present.length; i += 1) {
    const lo = present[i - 1]
    const hi = present[i]
    if (!(ratios[lo] < ratios[hi])) {
      throw fail(BUDGET_ALERT_CODES.THRESHOLDS_UNORDERED,
        `${lo}=${ratios[lo]} 不小于 ${hi}=${ratios[hi]}（${BUDGET_ALERT_RUNGS.join(' < ')} 必须严格递增）。`
        + '★ 顺序反了时，"降级"那一级一出现就已经被"告警"盖住 ⇒ 它永远不会被观察到')
    }
  }

  return { configured: present.length > 0, ratios, present }
}

/**
 * 由**已知金额**定级。
 *
 * 判据是 `ratio >= 阈值`（跨过即算，不是"超过"）：阈值就是"到这条线就开始动作"，
 * 用 `>` 会让恰好等于阈值的那一次**不动作**，而那是配置者最想它动作的一次。
 */
function levelFromRatio(ratio, ratios) {
  let level = 'ok'
  let crossed = null
  for (const rung of BUDGET_ALERT_RUNGS) {
    const t = ratios[rung]
    if (t === undefined) continue
    if (ratio >= t && levelIndex(rung) > levelIndex(level)) {
      level = rung
      crossed = rung
    }
  }
  return { level, crossed }
}

/**
 * 由"有多少条不知道"定可信度。
 *
 * `totals` 的字段名与 `usageTotals()` **逐字对齐**（`amount` /
 * `amountUnknownRecords` / `records` / `mixedCurrency` / `currency`）——
 * 这一层刻意不重新查库，也刻意不自己算一遍金额：
 * **告警与报表必须看同一份数**，否则"报表说 3 元、告警说 5 元"是迟早的事。
 */
function confidenceOf(totals) {
  if (totals.mixedCurrency === true) return { confidence: 'unknown', reason: 'MIXED_CURRENCY' }
  const unknownRecords = Number(totals.amountUnknownRecords ?? 0)
  const records = Number(totals.records ?? 0)
  if (unknownRecords > 0) {
    // ★ 一条已知的都没有 ⇒ 我们**完全**不知道花了多少。
    //   这与"知道一部分"是两句不同的话，尽管两者的 `amount` 都可能是 0。
    if (unknownRecords >= records) return { confidence: 'unknown', reason: 'SPEND_UNKNOWN' }
    return { confidence: 'partial', reason: 'SPEND_PARTIAL' }
  }
  return { confidence: 'exact', reason: null }
}

/**
 * 求值。
 *
 * @param {object} args
 * @param {object} args.totals       `usageTotals()` 的返回值（或同形状的对象）
 * @param {object} args.limit        `{ amount, currency }`，**必填**——本模块不发明上限
 * @param {object} [args.thresholds] `{ warn?, degrade?, block? }`，比例（0, 1]
 * @param {string} [args.degradeTo]  降级目标（模型档案 id）。不给则报 `DEGRADE_TARGET_UNSET`
 * @param {string} [args.previousLevel] 上一次的 `level`，用来报 `direction`（防抖读数，不做防抖）
 * @returns {Readonly<object>} 见文件头的四行表
 */
export function evaluateBudgetAlert({
  totals, limit, thresholds = null, degradeTo = null, previousLevel = null,
} = {}) {
  // ── ① 上限：必填，不发明默认值 ────────────────────────────────────────
  if (limit === undefined || limit === null) {
    throw fail(BUDGET_ALERT_CODES.LIMIT_REQUIRED,
      '没给预算上限。★ 本模块**不**落回任何默认值：一个"没配上限所以按 0 处理"的实现，'
      + '会让每一道预算告警在**没配**的时候报绿')
  }
  if (typeof limit !== 'object' || Array.isArray(limit)) {
    throw fail(BUDGET_ALERT_CODES.LIMIT_INVALID,
      `上限必须是 { amount, currency } 对象，收到 ${Array.isArray(limit) ? '数组' : typeof limit}`)
  }
  const limitAmount = limit.amount
  if (typeof limitAmount !== 'number' || !Number.isFinite(limitAmount) || limitAmount <= 0) {
    throw fail(BUDGET_ALERT_CODES.LIMIT_INVALID,
      `上限金额必须是一个有限正数，收到 ${JSON.stringify(limitAmount)}`)
  }

  // ── ② totals 形状 ──────────────────────────────────────────────────────
  if (totals === undefined || totals === null || typeof totals !== 'object' || Array.isArray(totals)) {
    throw fail(BUDGET_ALERT_CODES.TOTALS_INVALID,
      `totals 必须是 usageTotals() 的返回值，收到 ${Array.isArray(totals) ? '数组' : typeof totals}`)
  }

  // ── ③ 币种：不换算，对不上就拒 ────────────────────────────────────────
  const totalsCurrency = totals.mixedCurrency === true ? null : (totals.currency ?? null)
  const limitCurrency = limit.currency ?? null
  if (limitCurrency !== null && totalsCurrency !== null && limitCurrency !== totalsCurrency) {
    throw fail(BUDGET_ALERT_CODES.CURRENCY_MISMATCH,
      `上限是 ${limitCurrency}，而用量是 ${totalsCurrency}。`
      + '★ 本模块**不**替你换算：汇率是一个会随时间变的外部事实，告警不该偷偷引入它')
  }

  // ── ④ 阈值 ─────────────────────────────────────────────────────────────
  const { configured, ratios } = normalizeThresholds(thresholds)

  // ── ⑤ 上一次的等级（只用来报方向，不做防抖）────────────────────────────
  if (previousLevel !== null && previousLevel !== undefined
      && !BUDGET_ALERT_LEVELS.includes(previousLevel)) {
    throw fail(BUDGET_ALERT_CODES.PREVIOUS_LEVEL_INVALID,
      `previousLevel = ${JSON.stringify(previousLevel)} 不在 ${BUDGET_ALERT_LEVELS.join(' / ')} 里`)
  }

  const spent = Number(totals.amount ?? 0)
  const ratio = spent / limitAmount
  const { level, crossed } = levelFromRatio(ratio, ratios)
  const { confidence, reason: confidenceReason } = confidenceOf(totals)
  const unknownRecords = Number(totals.amountUnknownRecords ?? 0)

  // ── ⑥ 把两个正交的东西接起来：**只有这一条规则** ────────────────────────
  const fromLevel = ACTION_FOR_LEVEL[level]
  const fromConfidence = configured ? ACTION_FLOOR_FOR_CONFIDENCE[confidence] : 'review'
  const action = strictestAction(fromLevel, fromConfidence)

  // ── ⑦ 具名理由（封闭集合）─────────────────────────────────────────────
  const reasons = []
  if (!configured) reasons.push('NOT_CONFIGURED')
  if (confidenceReason !== null) reasons.push(confidenceReason)
  if (crossed !== null) reasons.push('LIMIT_CROSSED')
  if (action === 'degrade-model' && (degradeTo === null || degradeTo === undefined)) {
    reasons.push('DEGRADE_TARGET_UNSET')
  }

  // ── ⑧ 方向：只报，不防抖 ───────────────────────────────────────────────
  let direction = 'unknown'
  if (previousLevel !== null && previousLevel !== undefined) {
    const d = levelIndex(level) - levelIndex(previousLevel)
    direction = d > 0 ? 'escalating' : (d < 0 ? 'de-escalating' : 'steady')
  }

  return Object.freeze({
    version: BUDGET_ALERT_VERSION,
    // 唯一表示"可以放行"的那个布尔。★ 它的算法本身就是本模块的立场：
    // 三件事**同时**成立才算数——配了阈值、已知金额没跨线、且这个数是可信的。
    allClear: configured && level === 'ok' && confidence === 'exact',
    configured,
    level,
    confidence,
    action,
    // 已知金额、上限、比例。`ratio` 在混币种时**仍然是算出来的**，
    // 但 `confidence` 会同时是 `unknown` ⇒ 读的人不会只看它。
    spent,
    limit: limitAmount,
    currency: limitCurrency ?? totalsCurrency,
    ratio,
    // 跨过的是哪一级（`null` = 一级都没跨）。有了它，读的人不必自己再比一遍。
    crossedRung: crossed,
    thresholds: Object.freeze({ ...ratios }),
    unknownRecords,
    mixedCurrency: totals.mixedCurrency === true,
    records: Number(totals.records ?? 0),
    // 降级目标**原样回传**，本模块不认识它、也不校验它 ——
    // 那是模型档案那边的事（避免在这里内联第二份"什么算合法模型 id"）。
    degradeTo: degradeTo ?? null,
    direction,
    previousLevel: previousLevel ?? null,
    reasons: Object.freeze(reasons),
    serverTimeMs: Date.now(),
  })
}

/**
 * 形成期自检：把**每一级都能到达**、以及那条唯一的接续规则跑一遍，
 * 留下**算出来的值**。
 *
 * 为什么必须有这一条：一个只会返回 `ok` 的实现在"用例都跑绿"这件事上
 * 看起来完全正常——而它的表现恰好是**预算告警从来不响**。
 * 所以这里逐级造样本，并且**要求四级各出现一次**。
 */
export function selfCheckBudgetAlert() {
  const thresholds = { warn: 0.5, degrade: 0.8, block: 1.0 }
  const limit = { amount: 100, currency: 'USD' }
  const at = (amount, extra = {}) => evaluateBudgetAlert({
    totals: { amount, records: 1, amountUnknownRecords: 0, mixedCurrency: false, currency: 'USD', ...extra },
    limit,
    thresholds,
    degradeTo: 'cheap-model',
  })

  const observed = {
    ok: at(10),
    warn: at(60),
    degrade: at(85),
    block: at(120),
  }
  const levelsSeen = Object.values(observed).map((r) => r.level)

  // ★ 这条是**规则 1** 的反向对照：金额完全一样（0 元，远低于任何阈值），
  //   只有"不知道有多少条"变了 —— 而 `allClear` 必须翻。
  const blind = evaluateBudgetAlert({
    totals: { amount: 0, records: 7, amountUnknownRecords: 7, mixedCurrency: false, currency: 'USD' },
    limit,
    thresholds,
    degradeTo: 'cheap-model',
  })

  // ★ 反向对照之二：把阈值拿掉。金额仍然是同一个 0 元，`level` 仍然是 `ok`，
  //   而 `allClear` **必须**是 false（"没配告警"不是"一切正常"）。
  const unconfigured = evaluateBudgetAlert({
    totals: { amount: 0, records: 1, amountUnknownRecords: 0, mixedCurrency: false, currency: 'USD' },
    limit,
    thresholds: null,
    degradeTo: 'cheap-model',
  })

  return Object.freeze({
    version: BUDGET_ALERT_VERSION,
    // 四级各出现一次（`Object.values` 的顺序就是 `at()` 里写的顺序）
    levelsSeen: Object.freeze(levelsSeen),
    everyLevelReachable: BUDGET_ALERT_LEVELS.every((lv) => levelsSeen.includes(lv)),
    // 已知金额 0、但账目不可信 ⇒ 不许放行
    blindAllClear: blind.allClear,
    blindLevel: blind.level,
    blindConfidence: blind.confidence,
    blindAction: blind.action,
    // 没配阈值 ⇒ 不许放行
    unconfiguredAllClear: unconfigured.allClear,
    unconfiguredLevel: unconfigured.level,
    unconfiguredAction: unconfigured.action,
  })
}

/** 供 `reachability` / `silent-declarations` 一类的探针识别本模块已被自检。 */
export const BUDGET_ALERT_CHECKED = Object.freeze({
  module: 'team-hub/budget-alert.mjs',
  version: BUDGET_ALERT_VERSION,
  selfCheck: 'selfCheckBudgetAlert',
})

// runtime/contracts/price-table.mjs
// ============================================================================
// 带版本的价目表（PRT-511，spec §6.6 第 408 行）
//
// spec：「费用记录必须冻结 `priceTableVersion`、币种、模型计价单位、生效时间和
// 运行时估算结果。后续价格表更新不得重算历史 `usage_records`。」
//
// ── 为什么"版本"必须是构造的一部分，而不是一条纪律 ──
//
// "后续价格表更新不得重算历史"这句话，如果靠"大家都记得别去动老记录"来兑现，
// 它的失效方式是**静默**的：某天有人为了让报表更准，把估算函数改成
// "按当前价重算"，于是三个月前的费用记录全部变了，而没有任何一处报错。
//
// 因此这里把版本做成**结构性**的：
//
//   ① **没有版本的价目表构造不出来。** 版本与生效时间是必填的。一个"当前价"
//      这种无名对象无法被冻结进记录，也就无法被事后解释。
//   ② **价目表不可变，换价 = 换表。** 不是 `updatePrice()`，而是构造一张新表。
//      于是"历史记录用的是哪张表"在类型上就有答案——它引用的是那个对象。
//   ③ **未知模型返回 `unknown`，绝不返回 0。** 返回 0 会让"价格没配"看起来像
//      "这次免费"，于是预算闸门静默失效——一个**看起来在工作**的安全检查比
//      没有检查更危险，因为它会让人停止人工核对。这与 `usage.mjs` 里
//      `estimatedCostUsd` 返回 `null` 是同一条纪律。
//   ④ **估算单调**：token 数不减，费用不减。这条不是数学上的显然——按"阶梯价"
//      或"缓存命中价"实现时很容易被破坏，而破坏了之后"多花钱反而更便宜"会让
//      预算判定在边界上给出反直觉的结论。
//
// ── 交付边界 ──
//
// 这里只有"给定 token 数算出钱"。真实价格、供应商账单核对、以及
// "实际 usage 从哪来"分别是 PRT-207（采集）与运维输入（填价）。
// **本模块不自造任何价格**：`PRICE_TABLE_UNSET` 是合法且当前的默认状态。
// ============================================================================

/** 价目表层的具名错误码。 */
export const PRICE_ERRORS = Object.freeze({
  VERSION_REQUIRED: 'VERSION_REQUIRED',
  CURRENCY_REQUIRED: 'CURRENCY_REQUIRED',
  EFFECTIVE_AT_REQUIRED: 'EFFECTIVE_AT_REQUIRED',
  MODELS_NOT_OBJECT: 'MODELS_NOT_OBJECT',
  MODEL_ENTRY_INVALID: 'MODEL_ENTRY_INVALID',
  BILLING_UNIT_REQUIRED: 'BILLING_UNIT_REQUIRED',
  TABLE_INVALID: 'TABLE_INVALID',
})

/** 一次估算没有结果的原因。**封闭集合**：新增必须显式登记。 */
export const ESTIMATE_UNKNOWN_REASONS = Object.freeze([
  'MODEL_NOT_PRICED',   // 这张表里没有这个模型
  'TOKENS_UNKNOWN',     // token 数不知道（不是 0）
  'CURRENCY_MISMATCH',  // 表与预算的币种不一致
])

export class PriceError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'PriceError'
    this.code = code
    Object.assign(this, extra)
  }
}

const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 构造一张**不可变**的价目表。
 *
 * @param {object} spec
 * @param {string} spec.version        版本号（冻结进每条 usage 记录）
 * @param {string} spec.currency       币种
 * @param {number} spec.effectiveAtMs  生效时间（epoch ms）
 * @param {object} spec.models         `model -> { billingUnit, perUnit, unitSize, currency? }`
 *
 * `models[model].perUnit` 是"每个计价单位多少钱"，
 * `unitSize` 是"多少 token 算一个计价单位"（默认 1_000_000，即每百万 token）。
 * 计价单位必须显式给出：只写"每 token 的价格"而不写单位，
 * 事后没人能判断某个数字是每千还是每百万——而这个差别是 1000 倍。
 */
export function createPriceTable(spec = {}) {
  const { version, currency, effectiveAtMs, models } = spec
  if (!isNonEmptyString(version)) {
    throw new PriceError(PRICE_ERRORS.VERSION_REQUIRED,
      '价目表必须有 version：没有版本号的价格无法被冻结进费用记录，' +
      '也就无法回答"这条记录用的是哪版价"')
  }
  if (!isNonEmptyString(currency)) {
    throw new PriceError(PRICE_ERRORS.CURRENCY_REQUIRED,
      '价目表必须有 currency：金额脱离币种不构成金额')
  }
  if (typeof effectiveAtMs !== 'number' || !Number.isFinite(effectiveAtMs)) {
    throw new PriceError(PRICE_ERRORS.EFFECTIVE_AT_REQUIRED,
      '价目表必须有 effectiveAtMs：没有生效时间的价格在事后对账时不可解释')
  }
  if (models === null || typeof models !== 'object' || Array.isArray(models)) {
    throw new PriceError(PRICE_ERRORS.MODELS_NOT_OBJECT, 'models 必须是 model -> 单价 的对象')
  }

  const frozen = {}
  for (const [model, entry] of Object.entries(models)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID, `${model} 的单价必须是对象`)
    }
    if (!isNonEmptyString(entry.billingUnit)) {
      throw new PriceError(PRICE_ERRORS.BILLING_UNIT_REQUIRED,
        `${model} 缺少 billingUnit：只给价格不写计价单位，事后无法判断` +
        '某个数字是每千还是每百万——而这个差别是 1000 倍')
    }
    if (typeof entry.perUnit !== 'number' || !Number.isFinite(entry.perUnit) || entry.perUnit < 0) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID, `${model}.perUnit 必须是非负有限数`)
    }
    if (entry.unitSize !== undefined && !isPosInt(entry.unitSize)) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID, `${model}.unitSize 必须是正整数`)
    }
    if (entry.currency !== undefined && entry.currency !== currency) {
      // 单模型换币种意味着这张表的 `currency` 不再是它的币种，
      // 于是一条记录里会同时存在两个币种的金额。
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
        `${model}.currency=${entry.currency} 与表的 currency=${currency} 不一致：` +
        '混合币种的记录无法相加，也无法判预算')
    }
    frozen[model] = Object.freeze({
      billingUnit: entry.billingUnit,
      perUnit: entry.perUnit,
      unitSize: entry.unitSize ?? 1_000_000,
    })
  }

  return Object.freeze({
    version: version.trim(),
    currency: currency.trim(),
    effectiveAtMs,
    models: Object.freeze(frozen),
    /** 表里没有任何模型时的哨兵：估算一律返回 unknown。 */
    isEmpty: Object.keys(frozen).length === 0,
  })
}

/**
 * 当前价目表：**空表且未设定**。
 *
 * 与 `usage.mjs` 的 `PRICING` 一样，空表是刻意的当前状态：阶段 0～1 没有真实
 * 执行过，没有任何可核对的真实价格。填假价格比留空更糟——留空会得到
 * `unknown`，填假会得到一个看起来很专业的错误数字。
 */
export const PRICE_TABLE_UNSET = createPriceTable({
  version: 'UNSET',
  currency: 'USD',
  effectiveAtMs: 0,
  models: {},
})

/**
 * 估算一次调用的费用。
 *
 * 永远返回同一个形状，用 `ok` 区分，**不用异常**：
 * 调用方（预算闸门、诊断面板、报表）需要的是把"不知道"和"为零"分开处理，
 * 而不是在 catch 里再拼一次。
 *
 * @returns {{
 *   ok: boolean, reason: string|null, message: string,
 *   amount: number|null, currency: string|null, billingUnit: string|null,
 *   priceTableVersion: string|null, effectiveAtMs: number|null,
 *   tokensIn: number|null, tokensOut: number|null
 * }}
 */
/** 一个对象是否真的是 `createPriceTable` 的产物。 */
function isPriceTable(t) {
  return t !== null && typeof t === 'object' &&
    isNonEmptyString(t.version) &&
    isNonEmptyString(t.currency) &&
    typeof t.effectiveAtMs === 'number' &&
    t.models !== null && typeof t.models === 'object'
}

export function estimateCost({ priceTable, model, tokensIn, tokensOut }) {
  if (!isPriceTable(priceTable)) {
    // 早退而不是让 `priceTable.models[model]` 抛 TypeError：
    // TypeError 会被上层当成**代码缺陷**（500），而这里其实是"传了个不是
    // 价目表的东西"——一个具名的 400 才能告诉调用方该传什么。
    throw new PriceError(PRICE_ERRORS.TABLE_INVALID,
      'estimateCost 需要 createPriceTable 的产物（含 version / currency / effectiveAtMs / models）')
  }
  const base = {
    amount: null, currency: priceTable.currency, billingUnit: null,
    priceTableVersion: priceTable.version, effectiveAtMs: priceTable.effectiveAtMs,
    tokensIn: typeof tokensIn === 'number' && Number.isFinite(tokensIn) ? tokensIn : null,
    tokensOut: typeof tokensOut === 'number' && Number.isFinite(tokensOut) ? tokensOut : null,
  }
  // token 数不知道时**不能**当成 0：那会让"没采集到用量"看起来像"这次免费"。
  if (base.tokensIn === null || base.tokensOut === null) {
    return Object.freeze({
      ...base, ok: false, reason: 'TOKENS_UNKNOWN',
      message: `用量未知（tokensIn=${JSON.stringify(tokensIn)}, tokensOut=${JSON.stringify(tokensOut)}）：` +
        '不得当成 0——那会把"没采集到"变成"免费"',
    })
  }
  const entry = priceTable.models[model]
  if (entry === undefined) {
    return Object.freeze({
      ...base, ok: false, reason: 'MODEL_NOT_PRICED',
      message: `价目表 ${priceTable.version} 里没有模型 ${model}：` +
        '不得当成 0 费用——一个看起来在工作、实际永远放行的预算闸门比没有闸门更危险',
    })
  }
  const unitsIn = base.tokensIn / entry.unitSize
  const unitsOut = base.tokensOut / entry.unitSize
  const amount = unitsIn * entry.perUnit + unitsOut * entry.perUnit
  return Object.freeze({
    ...base,
    ok: true,
    reason: null,
    message: '',
    amount,
    billingUnit: entry.billingUnit,
  })
}

/**
 * 把估算结果压成**可落库**的冻结字段（PRT-511 的"冻结"）。
 *
 * `runtimeEstimate` 就是"运行时估算结果"本身：它带着算它时用的那张表的版本。
 * 落库之后，改价目表不影响这些数字——不是因为我们不去重算，
 * 而是因为**重算需要的那张表已经不存在了**（不可变，换价 = 换表），
 * 而这些字段记录了当时用的是哪一张。
 */
export function frozenEstimate(estimate) {
  if (estimate === null || typeof estimate !== 'object' || typeof estimate.ok !== 'boolean') {
    throw new PriceError(PRICE_ERRORS.TABLE_INVALID, 'frozenEstimate 需要 estimateCost 的结果')
  }
  return Object.freeze({
    ok: estimate.ok === true,
    // 未定价时 amount 保持 null 落库——落 0 会把"没配价"永久固化成"免费"
    amount: estimate.ok ? estimate.amount : null,
    reason: estimate.reason ?? null,
    currency: estimate.currency,
    billingUnit: estimate.billingUnit,
    priceTableVersion: estimate.priceTableVersion,
    effectiveAtMs: estimate.effectiveAtMs,
    tokensIn: estimate.tokensIn,
    tokensOut: estimate.tokensOut,
  })
}

/**
 * 是否允许从 `from` 模型切到 `to` 模型。
 *
 * spec 第 408 行：「**不得在未获用户批准时自动切换到更昂贵模型**」。
 *
 * 这条判定的失败方式是**安静地多花钱**：fallback 链在主档案失败时自动前进，
 * 如果下一个更贵，成本就上去了，而运行日志里只有一条"已切换到备用模型"。
 *
 * 三条规则：
 *   ① 更便宜或同价 → 允许（省钱不需要批准）；
 *   ② 更贵且**没有**批准 → 拒绝，并说清贵多少；
 *   ③ **任一侧未定价** → 拒绝。这一条是刻意的：不知道贵多少时放行，
 *      等于把"我查不清"当成"应该没问题"，而代价是真实的钱。
 *      未定价时的正确动作是去补价目表，不是让运行继续。
 *
 * @returns {{allowed: boolean, code: string, message: string,
 *            fromAmount: number|null, toAmount: number|null, currency: string|null}}
 */
export function canSwitchModel({ priceTable, from, to, tokensIn, tokensOut, approved = false }) {
  const a = estimateCost({ priceTable, model: from, tokensIn, tokensOut })
  const b = estimateCost({ priceTable, model: to, tokensIn, tokensOut })
  const base = {
    fromAmount: a.ok ? a.amount : null,
    toAmount: b.ok ? b.amount : null,
    currency: priceTable.currency,
  }
  if (!a.ok || !b.ok) {
    const missing = []
    if (!a.ok) missing.push(`from(${from})=${a.reason}`)
    if (!b.ok) missing.push(`to(${to})=${b.reason}`)
    return Object.freeze({
      ...base, allowed: false, code: 'PRICE_UNKNOWN',
      message: `无法比较两个模型的费用（${missing.join(', ')}）：` +
        '不知道贵多少时放行，等于把"查不清"当成"没问题"，而代价是真实的钱——' +
        '正确动作是补价目表，不是让运行继续',
    })
  }
  if (b.amount <= a.amount) {
    return Object.freeze({
      ...base, allowed: true, code: 'NOT_MORE_EXPENSIVE',
      message: `切到 ${to} 不更贵（${a.amount} → ${b.amount} ${priceTable.currency}）`,
    })
  }
  if (approved === true) {
    return Object.freeze({
      ...base, allowed: true, code: 'APPROVED',
      message: `切到更贵的 ${to}（${a.amount} → ${b.amount} ${priceTable.currency}）已获批准`,
    })
  }
  return Object.freeze({
    ...base, allowed: false, code: 'MORE_EXPENSIVE_NEEDS_APPROVAL',
    message: `切到 ${to} 更贵（${a.amount} → ${b.amount} ${priceTable.currency}，` +
      `多 ${b.amount - a.amount}）：不得在未获用户批准时自动切换到更昂贵模型`,
  })
}

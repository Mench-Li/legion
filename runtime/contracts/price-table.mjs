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
// ── 2026-09-15：UNSET 之后的第一张真实价目表，以及一处结构性缺陷的修复 ──
//
// 第一版 `estimateCost` 写的是 `unitsIn * entry.perUnit + unitsOut * entry.perUnit`
// ——**输入与输出用同一个单价**。真实价目表里这两个数不一样（Flash：cache miss
// 输入每百万 $0.15、输出每百万 $0.60），所以那个形状**装不下**它本来要装的价格：
// 调用方只能按输入价算输出（低估）或按输出价算输入（高估），两种都不对，
// 而且**不会有任何报错**——缺陷的表现形式是一个看起来正常的数字。
//
// 现在一条 entry 可以同时给 `perUnitIn` / `perUnitOut`；只给 `perUnit` 的老写法
// 仍然照旧（向后兼容），因为"输入输出恰好同价"本身是合法的一种价格。
//
// ── 真实价格有两个轴，`estimateCost` 默认一律取**更贵**的那一支 ──
//
//   轴 1（时区/时段）：DeepSeek 按 UTC 墙钟分 peak / off-peak，价差 **2 倍**；
//   轴 2（缓存）：输入侧分 cache hit / cache miss，价差最高 **50 倍**。
//
// 对**估算**来说，唯一安全的默认是取更贵的那一支：
//
//   · 预算闸门**少算** → 用户静默超支（不可见，事后才发现）；
//   · 预算闸门**多算** → 提前拒绝（可见，人会去看为什么）。
//
// 所以默认 basis = **peak + cache miss**；便宜的取值必须由调用方**显式**给出
// （`atMs` 表示"我知道这次调用发生在什么时刻"；`tokensInCacheHit` 表示
// "我知道输入里有多少是缓存命中"）。一个不肯显式声明的调用方拿到的是上界，
// 不是猜测——上界是保守的，而"取中间值"才是猜测。
//
// 这条默认由用例钉死（见 `price-table.test.mjs` 的 "★ 保守默认" 一组）：
// 谁把默认换成便宜那一支，用例立刻红。
//
// ── 价目表是**记录的常量**，不是网络抓取 ──
//
// `DEEPSEEK_PRICE_TABLE` 是 2026-09-15 从 `sourceUrl` 页面**手工录入**的一张表，
// 带着来源 URL、检索日期、模型版本串与 peak 规则（作为**数据**，不是散文）。
// 本模块**不做**任何网络请求：一个在估算费用时抓网页的实现，会把
// "这一笔钱按哪版价算的"变成一次不可复现的运行时副作用。
//
// 页面自己写着「Product prices may vary and DeepSeek reserves the right to
// adjust them」。因此 `retrievedAt` 与 `version` 一起冻结进每条估算结果：
// **一张过期的价目表必须看得出来它是过期的**，而不是被当成权威。
//
// ── 交付边界 ──
//
// 这里只有"给定 token 数算出钱"。真实账单核对、以及"实际 usage 从哪来"
// 分别是 PRT-207（采集）与运维输入（发布新版本价目表）。
// `PRICE_TABLE_UNSET` 仍是"没有价目表"的哨兵：**没有来源的模型依然不报价**，
// 只是现在有两个有来源的模型了。
// ============================================================================

/** 价目表层的具名错误码。 */
export const PRICE_ERRORS = Object.freeze({
  VERSION_REQUIRED: 'VERSION_REQUIRED',
  CURRENCY_REQUIRED: 'CURRENCY_REQUIRED',
  EFFECTIVE_AT_REQUIRED: 'EFFECTIVE_AT_REQUIRED',
  MODELS_NOT_OBJECT: 'MODELS_NOT_OBJECT',
  MODEL_ENTRY_INVALID: 'MODEL_ENTRY_INVALID',
  BILLING_UNIT_REQUIRED: 'BILLING_UNIT_REQUIRED',
  TIME_OF_DAY_INVALID: 'TIME_OF_DAY_INVALID',
  TABLE_INVALID: 'TABLE_INVALID',
})

/** 一次估算没有结果的原因。**封闭集合**：新增必须显式登记。 */
export const ESTIMATE_UNKNOWN_REASONS = Object.freeze([
  'MODEL_NOT_PRICED',     // 这张表里没有这个模型
  'TOKENS_UNKNOWN',       // token 数不知道（不是 0）
  'TOKENS_INCONSISTENT',  // 输入与缓存命中数自相矛盾（命中数 > 输入数）
  'CURRENCY_MISMATCH',    // 表与预算的币种不一致
])

/** 时段判定的取值。`flat` = 这张表的这个模型没有 peak/off-peak 之分。 */
export const TIME_OF_DAY_VALUES = Object.freeze(['peak', 'off-peak', 'flat'])

/** 一条 entry 的价格**来源**类型：页面上直接写的 / 由命名规则推导的 / 未声明。 */
export const PRICE_SOURCE_KINDS = Object.freeze(['page', 'derived', 'unspecified'])

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
const isNonNegFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** entry 的封闭字段集。`hasPeak` 是归一化产物，接受它是为了让"落库再取回"幂等。 */
const ENTRY_KEYS = new Set([
  'billingUnit', 'unitSize', 'currency',
  'perUnit', 'perUnitIn', 'perUnitOut', 'perUnitInCacheHit',
  'peak', 'hasPeak', 'sourceKind', 'modelVersion', 'aliasOf', 'note',
])
const PEAK_KEYS = new Set(['perUnitIn', 'perUnitOut', 'perUnitInCacheHit'])

/**
 * 拒绝未知字段。
 *
 * 这不是洁癖：一个拼错的 `peek` 会被**静默忽略**，于是这个模型没有 peak 价，
 * 而"默认取更贵那一支"就悄悄退回了便宜的那一支——一个 2 倍的低估，
 * 没有任何一处报错。封闭形状把拼写错误变成构造期的一次失败。
 */
function rejectUnknownKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
        `${where} 有未知字段 ${JSON.stringify(key)}：价目表 entry 是封闭形状——` +
        '多一个字段通常意味着某个真字段被拼错了，而拼错的 peak 会让' +
        '"默认取更贵那一支"静默退回便宜的那一支')
    }
  }
}

/** 读一个单价字段：缺省 → `undefined`；给了就必须是非负有限数。 */
function readRate(spec, field, where) {
  const raw = spec[field]
  if (raw === undefined) return undefined
  if (!isNonNegFinite(raw)) {
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
      `${where}.${field} 必须是非负有限数（收到 ${JSON.stringify(raw)}）`)
  }
  return raw
}

/**
 * 校验并归一化一条 entry。
 *
 * 两种形状**互斥**，且必须给全：
 *   · 老形状 `perUnit`（输入输出同价）；
 *   · 新形状 `perUnitIn` + `perUnitOut`（输入输出不同价）。
 *
 * 只给 `perUnitIn` 不给 `perUnitOut`（或反之）会被拒绝：那会让"没写的那一侧"
 * 悄悄沿用另一侧的价，而**缺一个价**与**那一侧恰好同价**是两回事。
 */
function normalizeEntry(model, entry, tableCurrency) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID, `${model} 的单价必须是对象`)
  }
  rejectUnknownKeys(entry, ENTRY_KEYS, model)
  if (!isNonEmptyString(entry.billingUnit)) {
    throw new PriceError(PRICE_ERRORS.BILLING_UNIT_REQUIRED,
      `${model} 缺少 billingUnit：只给价格不写计价单位，事后无法判断` +
      '某个数字是每千还是每百万——而这个差别是 1000 倍')
  }
  if (entry.unitSize !== undefined && !isPosInt(entry.unitSize)) {
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID, `${model}.unitSize 必须是正整数`)
  }
  if (entry.currency !== undefined && entry.currency !== tableCurrency) {
    // 单模型换币种意味着这张表的 `currency` 不再是它的币种，
    // 于是一条记录里会同时存在两个币种的金额。
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
      `${model}.currency=${entry.currency} 与表的 currency=${tableCurrency} 不一致：` +
      '混合币种的记录无法相加，也无法判预算')
  }

  const perUnit = readRate(entry, 'perUnit', model)
  const perUnitIn = readRate(entry, 'perUnitIn', model)
  const perUnitOut = readRate(entry, 'perUnitOut', model)
  const directional = perUnitIn !== undefined || perUnitOut !== undefined

  if (perUnit !== undefined && directional) {
    // 归一化后的 entry 会**同时**带着 `perUnit`（向后兼容的读法）与
    // `perUnitIn`/`perUnitOut`。所以"三者一致"必须放行——否则一张表落库再取回
    // （budget-ledger 的价目表登记处就是这么做的）会构造失败，历史记录引用
    // 的那个版本会变成"取不到"。真正要拒绝的是**不一致**：那时没人知道哪个是真价。
    const consistent = perUnitIn === perUnit && perUnitOut === perUnit
    if (!consistent) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
        `${model} 同时给了 perUnit=${perUnit} 与 perUnitIn/perUnitOut=` +
        `${perUnitIn}/${perUnitOut}：两者不一致时读者无法判断哪一个是真价`)
    }
  }
  if (directional && (perUnitIn === undefined || perUnitOut === undefined)) {
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
      `${model} 只给了一侧的方向价：perUnitIn / perUnitOut 必须成对——` +
      '缺的那一侧不是"同价"，是"没写"')
  }
  if (perUnit === undefined && !directional) {
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
      `${model} 没有任何单价：给 perUnit，或给 perUnitIn + perUnitOut`)
  }

  const baseIn = perUnit !== undefined ? perUnit : perUnitIn
  const baseOut = perUnit !== undefined ? perUnit : perUnitOut
  const baseHit = readRate(entry, 'perUnitInCacheHit', model)
  if (baseHit !== undefined && baseHit > baseIn) {
    // 缓存命中比未命中**更贵**会让"保守默认"那一支反过来变成便宜的：
    // 一个把 miss 当上界的实现会因此**低估**。
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
      `${model}.perUnitInCacheHit=${baseHit} 大于 perUnitIn=${baseIn}：` +
      '缓存命中不可能比未命中更贵——这个形状会让"按 miss 估上界"变成低估')
  }

  // peak 必须与 base 同形，且**逐项不低于** base。
  // "peak ≥ base" 不是对供应商的假设，而是这条默认赖以成立的前提：
  // 默认取 peak 之所以保守，全靠它真的更贵。
  let peak
  if (entry.peak !== undefined) {
    const p = entry.peak
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID, `${model}.peak 必须是对象`)
    }
    rejectUnknownKeys(p, PEAK_KEYS, `${model}.peak`)
    if (p.perUnit !== undefined) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
        `${model}.peak 不得使用 perUnit：它必须与 base 同形（perUnitIn/perUnitOut）`)
    }
    const pIn = readRate(p, 'perUnitIn', `${model}.peak`)
    const pOut = readRate(p, 'perUnitOut', `${model}.peak`)
    if (pIn === undefined || pOut === undefined) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
        `${model}.peak 必须同时给 perUnitIn 与 perUnitOut`)
    }
    if (pIn < baseIn || pOut < baseOut) {
      throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
        `${model}.peak 不得低于 base（peakIn=${pIn} vs in=${baseIn}，` +
        `peakOut=${pOut} vs out=${baseOut}）：默认取 peak 的保守性建立在它更贵之上`)
    }
    const pHit = readRate(p, 'perUnitInCacheHit', `${model}.peak`)
    if (pHit !== undefined) {
      if (baseHit === undefined) {
        throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
          `${model}.peak.perUnitInCacheHit 没有对应的 base perUnitInCacheHit`)
      }
      if (pHit < baseHit) {
        throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
          `${model}.peak.perUnitInCacheHit=${pHit} 低于 base ${baseHit}`)
      }
      if (pHit > pIn) {
        throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
          `${model}.peak.perUnitInCacheHit=${pHit} 大于 peak.perUnitIn=${pIn}`)
      }
    }
    peak = Object.freeze({ perUnitIn: pIn, perUnitOut: pOut, perUnitInCacheHit: pHit })
  }

  const sourceKind = entry.sourceKind ?? 'unspecified'
  if (!PRICE_SOURCE_KINDS.includes(sourceKind)) {
    throw new PriceError(PRICE_ERRORS.MODEL_ENTRY_INVALID,
      `${model}.sourceKind=${JSON.stringify(sourceKind)} 不在 ${PRICE_SOURCE_KINDS.join(' / ')} 内：` +
      '来源是封闭集合，新增必须显式登记')
  }

  return Object.freeze({
    billingUnit: entry.billingUnit,
    unitSize: entry.unitSize ?? 1_000_000,
    // 老形状原样保留：读 `perUnit` 的老调用方不受影响。
    perUnit,
    perUnitIn: baseIn,
    perUnitOut: baseOut,
    perUnitInCacheHit: baseHit,
    peak,
    hasPeak: peak !== undefined,
    sourceKind,
    modelVersion: isNonEmptyString(entry.modelVersion) ? entry.modelVersion.trim() : null,
    aliasOf: isNonEmptyString(entry.aliasOf) ? entry.aliasOf.trim() : null,
    note: isNonEmptyString(entry.note) ? entry.note.trim() : null,
  })
}

/**
 * 校验并归一化 peak/off-peak 规则（**数据**，不是散文）。
 *
 * 只接受 `timezone: 'UTC'`：规则原文就是 UTC，而一个"本地时间"的规则在没有
 * 转换的情况下一定会在某些机器上判错——判错的方向还可能是**少算**。
 */
function normalizeTimeOfDay(spec) {
  if (spec === undefined) return undefined
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new PriceError(PRICE_ERRORS.TIME_OF_DAY_INVALID, 'timeOfDay 必须是对象')
  }
  if (spec.timezone !== 'UTC') {
    throw new PriceError(PRICE_ERRORS.TIME_OF_DAY_INVALID,
      `timeOfDay.timezone=${JSON.stringify(spec.timezone)}：只支持 UTC。` +
      '供应商的规则按 UTC 写，而本进程不做时区转换——声明成别的时区会静默判错')
  }
  const weekdays = spec.peakWeekdays
  if (!Array.isArray(weekdays) || weekdays.length === 0 ||
    !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new PriceError(PRICE_ERRORS.TIME_OF_DAY_INVALID,
      'timeOfDay.peakWeekdays 必须是 0..6 的非空整数数组（0 = 周日，与 getUTCDay 一致）')
  }
  const ranges = spec.peakHourRanges
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new PriceError(PRICE_ERRORS.TIME_OF_DAY_INVALID,
      'timeOfDay.peakHourRanges 必须是非空的 [startHour, endHour) 数组')
  }
  const normRanges = ranges.map((r) => {
    if (!Array.isArray(r) || r.length !== 2) {
      throw new PriceError(PRICE_ERRORS.TIME_OF_DAY_INVALID, 'peakHourRanges 每一项必须是 [start, end]')
    }
    const [s, e] = r
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || s >= e) {
      throw new PriceError(PRICE_ERRORS.TIME_OF_DAY_INVALID,
        `peakHourRanges 区间 ${JSON.stringify(r)} 非法：[start, end) 须满足 0 ≤ start < end ≤ 24`)
    }
    return Object.freeze([s, e])
  })
  return Object.freeze({
    timezone: 'UTC',
    peakWeekdays: Object.freeze([...new Set(weekdays)].sort((a, b) => a - b)),
    peakHourRanges: Object.freeze(normRanges),
    note: isNonEmptyString(spec.note) ? spec.note.trim() : null,
  })
}

/**
 * 一个时刻落在 peak 还是 off-peak。
 *
 * 无法判定（时间戳非法 / 规则缺失或不是 UTC）返回 `null`——**不返回 `'off-peak'`**。
 * 把"判不出来"默认成便宜的时段，正是这条默认要避免的那种静默低估。
 *
 * @returns {'peak' | 'off-peak' | null}
 */
export function timeOfDayAt(atMs, rule) {
  if (!isNonNegFinite(atMs)) return null
  if (rule === null || typeof rule !== 'object' || rule.timezone !== 'UTC') return null
  const d = new Date(atMs)
  if (Number.isNaN(d.getTime())) return null
  const weekday = d.getUTCDay()
  if (!Array.isArray(rule.peakWeekdays) || !rule.peakWeekdays.includes(weekday)) return 'off-peak'
  const hour = d.getUTCHours()
  const inPeak = Array.isArray(rule.peakHourRanges) &&
    rule.peakHourRanges.some((r) => Array.isArray(r) && hour >= r[0] && hour < r[1])
  return inPeak ? 'peak' : 'off-peak'
}

/**
 * 构造一张**不可变**的价目表。
 *
 * @param {object} spec
 * @param {string} spec.version        版本号（冻结进每条 usage 记录）
 * @param {string} spec.currency       币种
 * @param {number} spec.effectiveAtMs  生效时间（epoch ms）
 * @param {object} spec.models         `model -> entry`
 * @param {object} [spec.timeOfDay]    peak/off-peak 规则（UTC，数据）
 * @param {string} [spec.sourceUrl]    这张表从哪一页手工录入的
 * @param {string} [spec.retrievedAt]  检索日期（ISO 日期串）
 * @param {string} [spec.note]         录入说明（含"价格可变"之类的页面声明）
 *
 * entry 的单价形状（二选一）：
 *   · `perUnit` —— 输入输出同价（老形状，仍然支持）；
 *   · `perUnitIn` + `perUnitOut` —— 输入输出不同价。
 * 可选 `perUnitInCacheHit`（缓存命中的输入价）与 `peak: { perUnitIn, perUnitOut,
 * perUnitInCacheHit? }`（peak 时段的价，逐项 ≥ base）。
 *
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
    frozen[model] = normalizeEntry(model, entry, currency.trim())
  }

  // peak 价存在、却没有 peak 规则时，`atMs` 无法派生时段——默认仍取 peak（保守）。
  // 这不是错误：只取 peak、不派生是完全合法的用法（`timeOfDay` 是可选的）。
  const timeOfDay = normalizeTimeOfDay(spec.timeOfDay)

  return Object.freeze({
    version: version.trim(),
    currency: currency.trim(),
    effectiveAtMs,
    models: Object.freeze(frozen),
    timeOfDay,
    sourceKind: 'recorded',
    sourceUrl: isNonEmptyString(spec.sourceUrl) ? spec.sourceUrl.trim() : null,
    retrievedAt: isNonEmptyString(spec.retrievedAt) ? spec.retrievedAt.trim() : null,
    note: isNonEmptyString(spec.note) ? spec.note.trim() : null,
    /** 表里没有任何模型时的哨兵：估算一律返回 unknown。 */
    isEmpty: Object.keys(frozen).length === 0,
  })
}

/** 一个对象是否真的是 `createPriceTable` 的产物。 */
export function isPriceTable(t) {
  return t !== null && typeof t === 'object' &&
    isNonEmptyString(t.version) &&
    isNonEmptyString(t.currency) &&
    typeof t.effectiveAtMs === 'number' &&
    t.models !== null && typeof t.models === 'object'
}

/**
 * 当前价目表：**空表且未设定**。
 *
 * 空表是"没有价目表"的哨兵。填假价格比留空更糟——留空会得到 `unknown`，
 * 填假会得到一个看起来很专业的错误数字。真实价格见 `DEEPSEEK_PRICE_TABLE`。
 */
export const PRICE_TABLE_UNSET = createPriceTable({
  version: 'UNSET',
  currency: 'USD',
  effectiveAtMs: 0,
  models: {},
})

// ============================================================================
// 记录的价格：DeepSeek 官方「Models & Pricing」（手工录入，非运行时抓取）
// ============================================================================

/** 这张表的出处。**任何数字都能回到这五个字段**，否则它就只是一串看着像价的数。 */
export const DEEPSEEK_PRICING_PROVENANCE = Object.freeze({
  sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  pageTitle: 'Models & Pricing',
  /** 页面检索日期。页面页脚：Copyright © 2026 DeepSeek, Inc.，另有一条 2026-09-14 的注记。 */
  retrievedAt: '2026-09-15',
  currency: 'USD',
  pricingUnit: 'per 1M tokens',
  handEntered: true,
  /** 页面原文声明。它决定了这张表**必须**带着检索日期，而不是被当成永久权威。 */
  vendorDisclaimer: 'Product prices may vary and DeepSeek reserves the right to adjust them',
  note:
    '手工录入的常量（不是运行时网络抓取）。价格随页面变化：估算结果里冻结了 ' +
    'version / effectiveAtMs / retrievedAt，过期与否看得出来。',
})

/** peak/off-peak 规则（**数据**）：peak 01:00–04:00 与 06:00–10:00 UTC，周一至周五；其余 off-peak。 */
export const DEEPSEEK_PEAK_RULE = Object.freeze({
  timezone: 'UTC',
  peakWeekdays: Object.freeze([1, 2, 3, 4, 5]),
  peakHourRanges: Object.freeze([Object.freeze([1, 4]), Object.freeze([6, 10])]),
  note: 'off-peak 单价恰为 peak 的一半（页面原文）',
})

const MTOK = 1_000_000

/** Flash 档：输入 cache hit / miss 与输出是**三个不同的数**——老的单 perUnit 装不下。 */
const FLASH_RATES = Object.freeze({
  billingUnit: 'per-mtok',
  unitSize: MTOK,
  perUnitInCacheHit: 0.003,
  perUnitIn: 0.15,
  perUnitOut: 0.6,
  peak: Object.freeze({ perUnitInCacheHit: 0.006, perUnitIn: 0.3, perUnitOut: 1.2 }),
})

/** Pro 档。 */
const PRO_RATES = Object.freeze({
  billingUnit: 'per-mtok',
  unitSize: MTOK,
  perUnitInCacheHit: 0.022,
  perUnitIn: 0.66,
  perUnitOut: 1.98,
  peak: Object.freeze({ perUnitInCacheHit: 0.044, perUnitIn: 1.32, perUnitOut: 3.96 }),
})

/**
 * 2026-09-15 从页面记录下来的价目表。
 *
 * 每个 model key 的 `sourceKind` 说明它是怎么进来的，**两者的可信度不同**：
 *   · `page`    —— 页面直接命名（含页面明确说"按 Flash 价计费"的退役名）；
 *   · `derived` —— 页面**没有**命名，由 provider 的端点后缀约定推导
 *                  （`-openai` 是 OpenAI 兼容端点，不是另一个 SKU）。
 * 推导出来的那两条在估算结果里会如实标出来（`priceSource.kind === 'derived'`），
 * 因为"官方页面给这个模型报过价"与"我们按命名规则把它归到了那一档"不是一个事实。
 *
 * **不在这张表里的模型 = 没有价**，不是 0，也不是"照 Flash 算"。
 */
export const DEEPSEEK_PRICE_TABLE = createPriceTable({
  version: 'deepseek-2026-09-15',
  currency: DEEPSEEK_PRICING_PROVENANCE.currency,
  // 页面没有给"生效日期"，只有检索日期。用检索日期做锚点，并把它写成 retrievedAt：
  // 一个编出来的 effectiveAtMs 与一个真实的检索日期，在事后对账时不是一回事。
  effectiveAtMs: Date.UTC(2026, 8, 15),
  sourceUrl: DEEPSEEK_PRICING_PROVENANCE.sourceUrl,
  retrievedAt: DEEPSEEK_PRICING_PROVENANCE.retrievedAt,
  note: DEEPSEEK_PRICING_PROVENANCE.note,
  timeOfDay: DEEPSEEK_PEAK_RULE,
  models: {
    // 页面直接命名的两个模型（model version 也来自页面）。
    'deepseek-flash': {
      ...FLASH_RATES,
      sourceKind: 'page',
      modelVersion: 'DeepSeek-V4.1-Flash',
    },
    'deepseek-v4-pro': {
      ...PRO_RATES,
      sourceKind: 'page',
      modelVersion: 'DeepSeek-V4-Pro-0813',
    },
    // 页面明确说"退役名，按 Flash 价计费"的两个名字。
    'deepseek-v4-flash': {
      ...FLASH_RATES,
      sourceKind: 'page',
      aliasOf: 'deepseek-flash',
      note: '页面：退役名，仍按 Flash 价计费',
    },
    'deepseek-v4-flash-vision-exp': {
      ...FLASH_RATES,
      sourceKind: 'page',
      aliasOf: 'deepseek-flash',
      note: '页面：退役名，仍按 Flash 价计费',
    },
    // 推导的别名：页面**没有**命名这两个 id。它们是本仓 custom-ds 网关用的名字，
    // `-openai` 是端点后缀。见 PRT-009 证据里对这一步的明示与保留。
    'deepseek-v4-flash-openai': {
      ...FLASH_RATES,
      sourceKind: 'derived',
      aliasOf: 'deepseek-v4-flash',
      note: '推导：-openai 为 OpenAI 兼容端点后缀，页面未直接命名；套用页面给 deepseek-v4-flash 的 Flash 价',
    },
    'deepseek-v4-pro-openai': {
      ...PRO_RATES,
      sourceKind: 'derived',
      aliasOf: 'deepseek-v4-pro',
      note: '推导：-openai 为 OpenAI 兼容端点后缀，页面未直接命名；套用 deepseek-v4-pro 的 Pro 价',
    },
  },
})

/**
 * 估算一次调用的费用。
 *
 * 永远返回同一个形状，用 `ok` 区分，**不用异常**：
 * 调用方（预算闸门、诊断面板、报表）需要的是把"不知道"和"为零"分开处理，
 * 而不是在 catch 里再拼一次。
 *
 * **默认取更贵的那一支**（peak + cache miss）。要用实际时段/缓存命中，
 * 必须由调用方显式传 `atMs` / `tokensInCacheHit`：
 *   · `atMs` —— 这一次调用发生的时刻（epoch ms）；有 peak 规则时据此选时段；
 *   · `tokensInCacheHit` —— `tokensIn` 里有多少是缓存命中（**子集**，不是另加）。
 * 两者都不传 = 拿到的是上界，不会低估。
 *
 * @returns {{
 *   ok: boolean, reason: string|null, message: string,
 *   amount: number|null, currency: string|null, billingUnit: string|null,
 *   priceTableVersion: string|null, effectiveAtMs: number|null,
 *   tokensIn: number|null, tokensOut: number|null,
 *   basis: object|null, priceSource: object|null
 * }}
 */
export function estimateCost({ priceTable, model, tokensIn, tokensOut, tokensInCacheHit = 0, atMs = null }) {
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
    basis: null, priceSource: null,
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
  if (!isNonNegFinite(tokensInCacheHit)) {
    return Object.freeze({
      ...base, ok: false, reason: 'TOKENS_UNKNOWN',
      message: `tokensInCacheHit=${JSON.stringify(tokensInCacheHit)} 不是非负有限数：` +
        '缓存命中数是 token 计数的一部分，不认识的值不得当成 0（那是"全 miss"，会高估）',
    })
  }
  if (tokensInCacheHit > base.tokensIn) {
    return Object.freeze({
      ...base, ok: false, reason: 'TOKENS_INCONSISTENT',
      message: `tokensInCacheHit=${tokensInCacheHit} 大于 tokensIn=${base.tokensIn}：` +
        '缓存命中是输入的**子集**，这个读数自相矛盾——按它算出的金额没有意义',
    })
  }

  const cacheRate = entry.perUnitInCacheHit
  // 表里没有 cache-hit 价 → 命中数只能忽略（全部按 miss 计）。这是保守方向。
  const hitTokens = cacheRate === undefined ? 0 : tokensInCacheHit
  const missTokens = base.tokensIn - hitTokens

  // 默认 peak（保守）。只有调用方显式给了时刻、且表里有 UTC 规则时才派生。
  let period = 'peak'
  let periodSource = entry.hasPeak ? 'default-peak' : 'flat-rate'
  if (entry.hasPeak && atMs !== null && priceTable.timeOfDay !== undefined) {
    const derived = timeOfDayAt(atMs, priceTable.timeOfDay)
    if (derived !== null) {
      period = derived
      periodSource = 'derived-from-timestamp'
    }
  }
  const usePeak = entry.hasPeak && period === 'peak'
  const inMissRate = usePeak ? entry.peak.perUnitIn : entry.perUnitIn
  const outRate = usePeak ? entry.peak.perUnitOut : entry.perUnitOut
  const inHitRate = cacheRate === undefined
    ? null
    : (usePeak ? (entry.peak.perUnitInCacheHit ?? cacheRate) : cacheRate)

  const unitsMiss = missTokens / entry.unitSize
  const unitsHit = hitTokens / entry.unitSize
  const unitsOut = base.tokensOut / entry.unitSize
  const amount = unitsMiss * inMissRate + unitsHit * (inHitRate ?? inMissRate) + unitsOut * outRate

  return Object.freeze({
    ...base,
    ok: true,
    reason: null,
    message: '',
    amount,
    billingUnit: entry.billingUnit,
    basis: Object.freeze({
      timeOfDay: entry.hasPeak ? period : 'flat',
      timeOfDaySource: periodSource,
      cacheHitTokens: hitTokens,
      cacheMissTokens: missTokens,
      cacheRateUsed: inHitRate !== null && hitTokens > 0,
      rates: Object.freeze({ inCacheHit: inHitRate, inMiss: inMissRate, out: outRate }),
    }),
    priceSource: Object.freeze({
      kind: entry.sourceKind,
      modelVersion: entry.modelVersion,
      aliasOf: entry.aliasOf,
    }),
  })
}

/**
 * 把估算结果压成**可落库**的冻结字段（PRT-511 的"冻结"）。
 *
 * `runtimeEstimate` 就是"运行时估算结果"本身：它带着算它时用的那张表的版本。
 * 落库之后，改价目表不影响这些数字——不是因为我们不去重算，
 * 而是因为**重算需要的那张表已经不存在了**（不可变，换价 = 换表），
 * 而这些字段记录了当时用的是哪一张。
 *
 * `basis` 与 `priceSource` 一起冻结：**用哪一支价算的**与**这个价是哪来的**
 * 都是事后解释一笔费用时不可缺的部分（一笔按 peak 算的钱与一笔按 off-peak
 * 算的钱相差 2 倍，而它们在库里长得一样，除非把 basis 写下来）。
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
    basis: estimate.basis ?? null,
    priceSource: estimate.priceSource ?? null,
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
 * 两侧用**同一个默认 basis** 比较（peak + miss），否则"更贵"可能只是
 * 一支取了 peak、另一支取了 off-peak——那会让这个判定反过来。
 *
 * @returns {{allowed: boolean, code: string, message: string,
 *            fromAmount: number|null, toAmount: number|null, currency: string|null}}
 */
export function canSwitchModel({ priceTable, from, to, tokensIn, tokensOut, tokensInCacheHit = 0, atMs = null, approved = false }) {
  const shared = { priceTable, tokensIn, tokensOut, tokensInCacheHit, atMs }
  const a = estimateCost({ ...shared, model: from })
  const b = estimateCost({ ...shared, model: to })
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

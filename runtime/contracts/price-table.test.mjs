// runtime/contracts/price-table.test.mjs
// ============================================================================
// 带版本的价目表（PRT-511）的用例
//
// 这一组问的核心是：「这条费用记录用的是哪版价？事后能不能解释？」
//
// 它的失败形态是**静默**的：
//   · 没有版本的价目表 → 事后无法回答"这是哪版价算的"；
//   · 未知模型返回 0 → "价格没配"看起来像"这次免费"，预算闸门永远放行；
//   · 可变价目表 → 某天有人让报表"更准"，三个月前的记录全变了，且无任何报错；
//   · 切到更贵模型不拦 → 成本上去了，日志里只有一行"已切换到备用模型"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEEPSEEK_PEAK_RULE,
  DEEPSEEK_PRICE_TABLE,
  DEEPSEEK_PRICING_PROVENANCE,
  ESTIMATE_UNKNOWN_REASONS,
  PRICE_ERRORS,
  PRICE_SOURCE_KINDS,
  PRICE_TABLE_UNSET,
  PriceError,
  TIME_OF_DAY_VALUES,
  canSwitchModel,
  createPriceTable,
  estimateCost,
  frozenEstimate,
  timeOfDayAt,
} from './price-table.mjs'

/** 张可用价目表：每百万 token 计价。 */
const TABLE = createPriceTable({
  version: '2026-09-A',
  currency: 'USD',
  effectiveAtMs: 1_700_000_000_000,
  models: {
    cheap: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 },
    dear: { billingUnit: 'per-mtok', perUnit: 10, unitSize: 1_000_000 },
  },
})

const TOK = { tokensIn: 500_000, tokensOut: 500_000 }

test('① 没有 version / currency / effectiveAtMs 的表**构造不出来**', () => {
  // 一个"当前价"这种无名对象无法被冻结进记录，也就无法被事后解释。
  for (const [spec, code] of [
    [{ currency: 'USD', effectiveAtMs: 0, models: {} }, PRICE_ERRORS.VERSION_REQUIRED],
    [{ version: 'v1', effectiveAtMs: 0, models: {} }, PRICE_ERRORS.CURRENCY_REQUIRED],
    [{ version: 'v1', currency: 'USD', models: {} }, PRICE_ERRORS.EFFECTIVE_AT_REQUIRED],
    [{ version: 'v1', currency: 'USD', effectiveAtMs: 0, models: [] }, PRICE_ERRORS.MODELS_NOT_OBJECT],
  ]) {
    assert.throws(() => createPriceTable(spec),
      (e) => e instanceof PriceError && e.code === code,
      `${JSON.stringify(spec)} 应被拒绝为 ${code}`)
  }
})

test('① 计价单位必填：只给价格不写单位，事后分不清每千还是每百万', () => {
  assert.throws(() => createPriceTable({
    version: 'v1', currency: 'USD', effectiveAtMs: 0,
    models: { m: { perUnit: 1 } },
  }), (e) => e.code === PRICE_ERRORS.BILLING_UNIT_REQUIRED)
  // 负数/非有限价格也不行
  for (const perUnit of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assert.throws(() => createPriceTable({
      version: 'v1', currency: 'USD', effectiveAtMs: 0,
      models: { m: { billingUnit: 'per-mtok', perUnit } },
    }), (e) => e.code === PRICE_ERRORS.MODEL_ENTRY_INVALID, `perUnit=${perUnit}`)
  }
})

test('① 单模型换币种被拒绝（混合币种无法相加，也无法判预算）', () => {
  assert.throws(() => createPriceTable({
    version: 'v1', currency: 'USD', effectiveAtMs: 0,
    models: { m: { billingUnit: 'per-mtok', perUnit: 1, currency: 'CNY' } },
  }), (e) => e.code === PRICE_ERRORS.MODEL_ENTRY_INVALID)
})

test('② 估算：按计价单位算，结果带上版本/币种/单位/生效时间', () => {
  const r = estimateCost({ priceTable: TABLE, model: 'cheap', ...TOK })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.amount, 1) // (0.5M + 0.5M) / 1M * 1
  assert.equal(r.currency, 'USD')
  assert.equal(r.billingUnit, 'per-mtok')
  assert.equal(r.priceTableVersion, '2026-09-A')
  assert.equal(r.effectiveAtMs, 1_700_000_000_000)
  // dear 贵 10 倍
  assert.equal(estimateCost({ priceTable: TABLE, model: 'dear', ...TOK }).amount, 10)
})

test('② **未知模型返回 unknown，绝不返回 0**', () => {
  // 返回 0 会让"价格没配"看起来像"这次免费"，于是预算闸门静默失效——
  // 一个看起来在工作、实际永远放行的安全检查比没有检查更危险。
  const r = estimateCost({ priceTable: TABLE, model: 'never-heard-of-it', ...TOK })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'MODEL_NOT_PRICED')
  assert.equal(r.amount, null, 'amount 必须是 null 而不是 0')
  assert.match(r.message, /不得当成 0 费用/)
  assert.match(r.message, /永远放行/)
})

test('② token 数未知时返回 unknown，不返回 0 也不抛', () => {
  for (const bad of [
    { tokensIn: null, tokensOut: 100 },
    { tokensIn: 100, tokensOut: undefined },
    { tokensIn: '100', tokensOut: 100 },
    { tokensIn: Number.NaN, tokensOut: 100 },
  ]) {
    const r = estimateCost({ priceTable: TABLE, model: 'cheap', ...bad })
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.equal(r.reason, 'TOKENS_UNKNOWN')
    assert.equal(r.amount, null)
    assert.match(r.message, /不得当成 0/)
  }
  // token 真的是 0 是合法输入（比如空响应），不是"未知"
  const zero = estimateCost({ priceTable: TABLE, model: 'cheap', tokensIn: 0, tokensOut: 0 })
  assert.equal(zero.ok, true, zero.message)
  assert.equal(zero.amount, 0)
})

test('② 未定价表的估算一律 unknown，且原因是封闭集合里的一员', () => {
  const r = estimateCost({ priceTable: PRICE_TABLE_UNSET, model: 'cheap', ...TOK })
  assert.equal(r.ok, false)
  assert.ok(ESTIMATE_UNKNOWN_REASONS.includes(r.reason), `未登记的原因：${r.reason}`)
  assert.equal(r.priceTableVersion, 'UNSET', '版本仍要如实给出——"未设定"本身是信息')
})

test('③ **估算单调**：token 不减，费用不减', () => {
  // 破坏之后"多花钱反而更便宜"会让预算判定在边界上给出反直觉的结论。
  let prev = -1
  for (const n of [0, 1, 1000, 500_000, 1_000_000, 5_000_000]) {
    const r = estimateCost({ priceTable: TABLE, model: 'cheap', tokensIn: n, tokensOut: n })
    assert.equal(r.ok, true)
    assert.ok(r.amount >= prev, `tokens=${n} 的费用 ${r.amount} 小于更少 token 的 ${prev}`)
    prev = r.amount
  }
})

test('③ 换价 = 换表：旧表算出的结果**不随新表改变**', () => {
  // spec：「后续价格表更新不得重算历史 usage_records」。
  // 这条不是靠"记得别重算"兑现，而是结构性的——旧表对象还在，它算出的数字
  // 带着自己的版本；新表是**另一个对象**，改不到旧记录。
  const older = createPriceTable({
    version: 'v1', currency: 'USD', effectiveAtMs: 1000,
    models: { m: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 } },
  })
  const before = frozenEstimate(estimateCost({ priceTable: older, model: 'm', ...TOK }))
  const newer = createPriceTable({
    version: 'v2', currency: 'USD', effectiveAtMs: 2000,
    models: { m: { billingUnit: 'per-mtok', perUnit: 99, unitSize: 1_000_000 } },
  })
  const after = frozenEstimate(estimateCost({ priceTable: newer, model: 'm', ...TOK }))
  // 旧表算出的冻结结果原封不动
  assert.equal(before.amount, 1)
  assert.equal(before.priceTableVersion, 'v1')
  assert.equal(before.effectiveAtMs, 1000)
  assert.equal(after.amount, 99)
  assert.equal(after.priceTableVersion, 'v2')
  // 新旧互不影响：再算一次旧表结果不变
  assert.deepEqual(frozenEstimate(estimateCost({ priceTable: older, model: 'm', ...TOK })), before)
})

test('③ 表是冻结的：试图改它不会生效（改价必须构造新表）', () => {
  assert.equal(Object.isFrozen(TABLE), true)
  assert.equal(Object.isFrozen(TABLE.models), true)
  assert.equal(Object.isFrozen(TABLE.models.cheap), true)
  assert.throws(() => { TABLE.version = 'tampered' }, TypeError)
  assert.throws(() => { TABLE.models.cheap.perUnit = 0 }, TypeError)
  assert.equal(estimateCost({ priceTable: TABLE, model: 'cheap', ...TOK }).amount, 1, '原表必须不受影响')
})

test('④ 冻结字段：未定价时 amount 保持 null（不把"没配价"固化成"免费"）', () => {
  const f = frozenEstimate(estimateCost({ priceTable: TABLE, model: 'nope', ...TOK }))
  assert.equal(f.ok, false)
  assert.equal(f.amount, null, '落库的 amount 必须是 null 而不是 0')
  assert.equal(f.reason, 'MODEL_NOT_PRICED')
  assert.equal(f.priceTableVersion, '2026-09-A')
  // 冻结结果自带全部五个必冻字段
  for (const k of ['priceTableVersion', 'currency', 'billingUnit', 'effectiveAtMs', 'amount']) {
    assert.ok(k in f, `冻结结果缺 ${k}`)
  }
})

test('④ 冻结字段的形状校验：不是估算结果就拒绝', () => {
  for (const bad of [null, undefined, {}, { ok: 'yes' }]) {
    assert.throws(() => frozenEstimate(bad), (e) => e.code === PRICE_ERRORS.TABLE_INVALID)
  }
  assert.throws(() => estimateCost({ priceTable: { version: 'v' }, model: 'm', ...TOK }),
    (e) => e.code === PRICE_ERRORS.TABLE_INVALID)
})

test('⑤ 切模型：同价或更便宜 → 允许（省钱不需要批准）', () => {
  const r = canSwitchModel({ priceTable: TABLE, from: 'dear', to: 'cheap', ...TOK })
  assert.equal(r.allowed, true)
  assert.equal(r.code, 'NOT_MORE_EXPENSIVE')
  assert.equal(r.fromAmount, 10)
  assert.equal(r.toAmount, 1)
  // 同价也算"不更贵"
  const same = canSwitchModel({ priceTable: TABLE, from: 'cheap', to: 'cheap', ...TOK })
  assert.equal(same.allowed, true)
})

test('⑤ 切到更贵模型：无批准 → 拒绝，并说清贵多少', () => {
  const r = canSwitchModel({ priceTable: TABLE, from: 'cheap', to: 'dear', ...TOK })
  assert.equal(r.allowed, false)
  assert.equal(r.code, 'MORE_EXPENSIVE_NEEDS_APPROVAL')
  assert.match(r.message, /更贵/)
  assert.match(r.message, /不得在未获用户批准时自动切换到更昂贵模型/)
  assert.match(r.message, /多 9/)
})

test('⑤ 切到更贵模型：有批准 → 允许（批准是唯一入口）', () => {
  const r = canSwitchModel({ priceTable: TABLE, from: 'cheap', to: 'dear', ...TOK, approved: true })
  assert.equal(r.allowed, true)
  assert.equal(r.code, 'APPROVED')
  assert.match(r.message, /已获批准/)
})

test('⑤ **任一侧未定价 → 拒绝**（不知道贵多少时放行等于把"查不清"当"没问题"）', () => {
  for (const [from, to] of [['cheap', 'unpriced'], ['unpriced', 'cheap'], ['unpriced', 'unpriced']]) {
    const r = canSwitchModel({ priceTable: TABLE, from, to, ...TOK })
    assert.equal(r.allowed, false, `${from} → ${to} 必须拒绝`)
    assert.equal(r.code, 'PRICE_UNKNOWN')
    assert.match(r.message, /正确动作是补价目表/)
  }
  // 即使给了 approved 也不行：批准的是"切到更贵"，不是"跳过定价"
  const r = canSwitchModel({ priceTable: TABLE, from: 'cheap', to: 'unpriced', ...TOK, approved: true })
  assert.equal(r.allowed, false, 'approval 不能替代定价')
})

test('⑤ 未定价表上任何切换都拒绝（空表放行的后果是全线静默）', () => {
  const r = canSwitchModel({ priceTable: PRICE_TABLE_UNSET, from: 'a', to: 'b', ...TOK })
  assert.equal(r.allowed, false)
  assert.equal(r.code, 'PRICE_UNKNOWN')
  assert.equal(r.fromAmount, null)
  assert.equal(r.toAmount, null)
})

test('⑥ 原因码与错误码都是封闭集合（新增必须显式登记）', () => {
  assert.equal(new Set(ESTIMATE_UNKNOWN_REASONS).size, ESTIMATE_UNKNOWN_REASONS.length, '原因码不得重复')
  assert.ok(ESTIMATE_UNKNOWN_REASONS.length >= 3)
  for (const c of Object.values(PRICE_ERRORS)) assert.equal(typeof c, 'string')
  assert.equal(new Set(Object.values(PRICE_ERRORS)).size, Object.values(PRICE_ERRORS).length, '错误码不得重复')
})

test('⑥ 空表是合法状态（不是错误）：isEmpty 如实标出', () => {
  assert.equal(PRICE_TABLE_UNSET.isEmpty, true)
  assert.equal(TABLE.isEmpty, false)
  assert.equal(PRICE_TABLE_UNSET.version, 'UNSET')
})

// ================================================================ ⑦ 输入 ≠ 输出
//
// 这一组针对的是一个**结构性缺陷**：第一版 entry 只有 `perUnit`，估算式写成
// `unitsIn * perUnit + unitsOut * perUnit`——一个价同时当输入价与输出价用。
// 真实价格里这两个数不一样（Flash：miss 输入 0.15、输出 0.60），所以那个形状
// **装不下**它本来要装的价格：按输入价算输出会低估、按输出价算输入会高估，
// 而两种都**不会报错**——缺陷的表现形式是一个看起来正常的数字。

/** 浮点比较：价格是二进制小数，"恰好相等"不是这条契约要表达的意思。 */
const near = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) < tolerance, `期望 ≈ ${expected}，实际 ${actual}`)
}

const SPLIT_TABLE = createPriceTable({
  version: 'split-v1',
  currency: 'USD',
  effectiveAtMs: 1_700_000_000_000,
  models: {
    flat: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 },
    split: { billingUnit: 'per-mtok', perUnitIn: 1, perUnitOut: 3, unitSize: 1_000_000 },
  },
})

test('⑦ 输入 ≠ 输出：同一个 token 量在两种形状下给出**不同**的数', () => {
  const flat = estimateCost({ priceTable: SPLIT_TABLE, model: 'flat', tokensIn: 1_000_000, tokensOut: 1_000_000 })
  const split = estimateCost({ priceTable: SPLIT_TABLE, model: 'split', tokensIn: 1_000_000, tokensOut: 1_000_000 })
  assert.equal(flat.ok, true, flat.message)
  assert.equal(split.ok, true, split.message)
  near(flat.amount, 2) // 一个价算两遍
  near(split.amount, 4) // 1 + 3
  // 若估算式仍把输入价当成两个方向用，split 会等于 2 而不是 4——
  // 这一条就是那个缺陷的守卫：它红了，说明"能表达输入≠输出"又退回去了。
  assert.notEqual(split.amount, flat.amount)
})

test('⑦ 方向价必须成对：缺一侧是"没写"，不是"同价"', () => {
  for (const entry of [
    { billingUnit: 'per-mtok', perUnitIn: 1 },
    { billingUnit: 'per-mtok', perUnitOut: 1 },
    { billingUnit: 'per-mtok', perUnit: 1, perUnitIn: 2, perUnitOut: 3 }, // 两种形状**不一致** → 没人知道哪个是真价
    { billingUnit: 'per-mtok' },
  ]) {
    assert.throws(() => createPriceTable({
      version: 'v', currency: 'USD', effectiveAtMs: 0, models: { m: entry },
    }), (e) => e.code === PRICE_ERRORS.MODEL_ENTRY_INVALID, JSON.stringify(entry))
  }
})

test('⑦ 未知字段被拒绝：拼错的 peak 会让"默认取更贵那一支"静默失效', () => {
  for (const entry of [
    { billingUnit: 'per-mtok', perUnit: 1, peek: { perUnitIn: 2, perUnitOut: 3 } },
    { billingUnit: 'per-mtok', perUnitIn: 1, perUnitOut: 2, peak: { perUnitin: 2, perUnitOut: 4 } },
  ]) {
    assert.throws(() => createPriceTable({
      version: 'v', currency: 'USD', effectiveAtMs: 0, models: { m: entry },
    }), (e) => e.code === PRICE_ERRORS.MODEL_ENTRY_INVALID, JSON.stringify(entry))
  }
})

test('⑦ 归一化是幂等的：表落库再取回（价目表登记处就这么做）不得构造失败', () => {
  // 归一化后的 entry 同时带着 perUnit 与 perUnitIn/perUnitOut；
  // 登记处把 models JSON 序列化后重新构造，所以"一致的三元组"必须放行。
  const serialized = JSON.parse(JSON.stringify(SPLIT_TABLE.models))
  const back = createPriceTable({
    version: SPLIT_TABLE.version,
    currency: SPLIT_TABLE.currency,
    effectiveAtMs: SPLIT_TABLE.effectiveAtMs,
    models: serialized,
  })
  assert.equal(back.models.flat.perUnit, 1)
  assert.equal(back.models.split.perUnitIn, 1)
  assert.equal(back.models.split.perUnitOut, 3)
  // 方向价在往返后仍然生效（不是被折回了单价的 2）
  near(estimateCost({ priceTable: back, model: 'split', tokensIn: 1_000_000, tokensOut: 1_000_000 }).amount, 4)
})

test('⑦ 老形状 perUnit 仍然可用（向后兼容不是口号，是一条用例）', () => {
  const r = estimateCost({ priceTable: SPLIT_TABLE, model: 'flat', tokensIn: 2_000_000, tokensOut: 500_000 })
  assert.equal(r.ok, true)
  assert.equal(r.billingUnit, 'per-mtok')
  assert.equal(SPLIT_TABLE.models.flat.perUnit, 1)
  // 输入输出都取 1
  near(r.amount, 2.5)
})

// ================================================================ ⑧ 缓存与时段
//
// 真实价格有两个轴：peak/off-peak（差 2 倍）与 cache hit/miss（差最高 50 倍）。
// 估算拿不到这两个读数时，默认取**更贵**的那一支——见模块头部与 §"★ 保守默认"。

const RECORDED = DEEPSEEK_PRICE_TABLE
const PEAK_MS = Date.UTC(2026, 8, 15, 2, 0, 0) // 周二 02:00 UTC → peak
const OFF_PEAK_MS = Date.UTC(2026, 8, 15, 12, 0, 0) // 周二 12:00 UTC → off-peak
const WEEKEND_MS = Date.UTC(2026, 8, 19, 2, 0, 0) // 周六 02:00 UTC → off-peak

test('⑧ timeOfDayAt：UTC 墙钟、周一至周五、[start, end) 边界', () => {
  assert.equal(timeOfDayAt(PEAK_MS, DEEPSEEK_PEAK_RULE), 'peak')
  assert.equal(timeOfDayAt(OFF_PEAK_MS, DEEPSEEK_PEAK_RULE), 'off-peak')
  assert.equal(timeOfDayAt(WEEKEND_MS, DEEPSEEK_PEAK_RULE), 'off-peak', '周末没有 peak')
  assert.equal(timeOfDayAt(Date.UTC(2026, 8, 15, 1, 0, 0), DEEPSEEK_PEAK_RULE), 'peak', '01:00 含')
  assert.equal(timeOfDayAt(Date.UTC(2026, 8, 15, 4, 0, 0), DEEPSEEK_PEAK_RULE), 'off-peak', '04:00 不含（半开区间）')
  assert.equal(timeOfDayAt(Date.UTC(2026, 8, 15, 6, 0, 0), DEEPSEEK_PEAK_RULE), 'peak')
  assert.equal(timeOfDayAt(Date.UTC(2026, 8, 15, 10, 0, 0), DEEPSEEK_PEAK_RULE), 'off-peak')
  // 判不出来时必须返回 null，**不是** off-peak——
  // 把"判不出来"默认成便宜时段，正是这条默认要避免的那种静默低估。
  assert.equal(timeOfDayAt(Number.NaN, DEEPSEEK_PEAK_RULE), null)
  assert.equal(timeOfDayAt(PEAK_MS, null), null)
  assert.equal(timeOfDayAt(PEAK_MS, { timezone: 'Asia/Shanghai' }), null)
})

test('⑧ peak 规则是数据且只接受 UTC：本地时间规则会被拒绝', () => {
  const mk = (timeOfDay) => () => createPriceTable({
    version: 'v', currency: 'USD', effectiveAtMs: 0, models: {}, timeOfDay,
  })
  assert.throws(mk({ timezone: 'Asia/Shanghai', peakWeekdays: [1], peakHourRanges: [[1, 4]] }),
    (e) => e.code === PRICE_ERRORS.TIME_OF_DAY_INVALID)
  assert.throws(mk({ timezone: 'UTC', peakWeekdays: [7], peakHourRanges: [[1, 4]] }),
    (e) => e.code === PRICE_ERRORS.TIME_OF_DAY_INVALID)
  assert.throws(mk({ timezone: 'UTC', peakWeekdays: [1], peakHourRanges: [[4, 4]] }),
    (e) => e.code === PRICE_ERRORS.TIME_OF_DAY_INVALID)
  assert.deepEqual(TIME_OF_DAY_VALUES, ['peak', 'off-peak', 'flat'])
})

test('⑧ peak 不得低于 base：保守默认靠的是"它真的更贵"', () => {
  assert.throws(() => createPriceTable({
    version: 'v', currency: 'USD', effectiveAtMs: 0,
    models: { m: { billingUnit: 'per-mtok', perUnitIn: 1, perUnitOut: 2, peak: { perUnitIn: 0.5, perUnitOut: 2 } } },
  }), (e) => e.code === PRICE_ERRORS.MODEL_ENTRY_INVALID)
  assert.throws(() => createPriceTable({
    version: 'v', currency: 'USD', effectiveAtMs: 0,
    models: { m: { billingUnit: 'per-mtok', perUnitIn: 1, perUnitOut: 2, peek: { perUnitIn: 2, perUnitOut: 4 } } },
  }), (e) => e.code === PRICE_ERRORS.MODEL_ENTRY_INVALID, '拼错的 peak 必须被拒绝，否则默认静默退回 base = 2 倍低估')
})

test('★ 保守默认：不给时刻与缓存读数时，按 peak + cache miss 算', () => {
  const r = estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 1_000_000 })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.basis.timeOfDay, 'peak')
  assert.equal(r.basis.timeOfDaySource, 'default-peak')
  assert.equal(r.basis.cacheRateUsed, false)
  assert.equal(r.basis.cacheHitTokens, 0)
  assert.equal(r.basis.cacheMissTokens, 1_000_000)
  near(r.amount, 1.5) // peak：输入 0.3 + 输出 1.2

  // 便宜的那一支（off-peak）恰好是一半。谁把默认静默换成它，上面两条立刻红。
  const off = estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 1_000_000, atMs: OFF_PEAK_MS })
  assert.equal(off.basis.timeOfDay, 'off-peak')
  assert.equal(off.basis.timeOfDaySource, 'derived-from-timestamp')
  near(off.amount, 0.75)
  assert.ok(r.amount > off.amount, '默认必须比便宜那一支贵——低估会让预算闸门静默放行')
})

test('★ 缓存默认 miss：给了 tokensInCacheHit 才用便宜的那一支', () => {
  const miss = estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0, atMs: OFF_PEAK_MS })
  near(miss.amount, 0.15)
  const hit = estimateCost({
    priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0, tokensInCacheHit: 1_000_000, atMs: OFF_PEAK_MS,
  })
  near(hit.amount, 0.003)
  assert.equal(hit.basis.cacheRateUsed, true)
  assert.equal(hit.basis.cacheHitTokens, 1_000_000)
  assert.ok(miss.amount > hit.amount)
  // 只声明一部分命中：拆成两段
  const half = estimateCost({
    priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0, tokensInCacheHit: 500_000, atMs: OFF_PEAK_MS,
  })
  near(half.amount, 0.5 * 0.15 + 0.5 * 0.003)
  assert.equal(half.basis.cacheMissTokens, 500_000)
})

test('⑧ 缓存命中数是输入的**子集**：大于输入数 → 未知，不按垃圾读数算钱', () => {
  const r = estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 100, tokensOut: 0, tokensInCacheHit: 101 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'TOKENS_INCONSISTENT')
  assert.equal(r.amount, null)
  assert.ok(ESTIMATE_UNKNOWN_REASONS.includes(r.reason))
})

test('⑧ **单调**：token 不减费用不减（peak 默认与缓存拆分两条路径都过）', () => {
  let prev = -1
  for (const n of [0, 1, 1000, 500_000, 1_000_000, 5_000_000]) {
    const r = estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: n, tokensOut: n })
    assert.equal(r.ok, true, r.message)
    assert.ok(r.amount >= prev, `tokens=${n}：${r.amount} < ${prev}`)
    prev = r.amount
    const split = estimateCost({
      priceTable: RECORDED, model: 'deepseek-flash', tokensIn: n, tokensOut: n, tokensInCacheHit: n, atMs: OFF_PEAK_MS,
    })
    assert.equal(split.ok, true)
    assert.ok(split.amount <= r.amount + 1e-12, '缓存拆分不得比全 miss 更贵')
  }
  let prevOut = -1
  for (const n of [0, 1000, 1_000_000]) {
    const r = estimateCost({ priceTable: RECORDED, model: 'deepseek-v4-pro', tokensIn: 0, tokensOut: n })
    assert.ok(r.amount >= prevOut)
    prevOut = r.amount
  }
})

// ================================================================ ⑨ 记录表的出处
//
// 一张没有出处的价目表与一张有出处的价目表，在"估算返回了一个数"这件事上
// 没有区别；区别只在事后对账时，那个数还能不能被追到一页纸。

test('⑨ 出处字段齐全：URL / 检索日期 / 币种 / 记账单位 / 页面声明', () => {
  assert.equal(RECORDED.version, 'deepseek-2026-09-15')
  assert.equal(RECORDED.currency, 'USD')
  assert.equal(RECORDED.sourceUrl, DEEPSEEK_PRICING_PROVENANCE.sourceUrl)
  assert.match(RECORDED.sourceUrl, /^https:\/\/api-docs\.deepseek\.com\//)
  assert.equal(RECORDED.retrievedAt, DEEPSEEK_PRICING_PROVENANCE.retrievedAt)
  assert.equal(RECORDED.retrievedAt, '2026-09-15')
  assert.equal(RECORDED.effectiveAtMs, Date.UTC(2026, 8, 15))
  assert.equal(DEEPSEEK_PRICING_PROVENANCE.handEntered, true, '是记录的常量，不是运行时抓取')
  assert.equal(DEEPSEEK_PRICING_PROVENANCE.pricingUnit, 'per 1M tokens')
  assert.match(DEEPSEEK_PRICING_PROVENANCE.vendorDisclaimer, /may vary/,
    '页面自己说价格可变——这句话就是"表必须带检索日期"的理由')
  // peak 规则是**数据**，不是散文
  assert.equal(RECORDED.timeOfDay.timezone, 'UTC')
  assert.deepEqual(RECORDED.timeOfDay.peakWeekdays, [1, 2, 3, 4, 5])
  assert.deepEqual(RECORDED.timeOfDay.peakHourRanges, [[1, 4], [6, 10]])
})

test('⑨ 页面直接命名的模型：数字、模型版本、off-peak = peak/2 都对得上', () => {
  const flash = RECORDED.models['deepseek-flash']
  assert.equal(flash.sourceKind, 'page')
  assert.equal(flash.modelVersion, 'DeepSeek-V4.1-Flash')
  assert.deepEqual([flash.perUnitInCacheHit, flash.perUnitIn, flash.perUnitOut], [0.003, 0.15, 0.6])
  assert.deepEqual([flash.peak.perUnitInCacheHit, flash.peak.perUnitIn, flash.peak.perUnitOut], [0.006, 0.3, 1.2])

  const pro = RECORDED.models['deepseek-v4-pro']
  assert.equal(pro.sourceKind, 'page')
  assert.equal(pro.modelVersion, 'DeepSeek-V4-Pro-0813')
  assert.deepEqual([pro.perUnitInCacheHit, pro.perUnitIn, pro.perUnitOut], [0.022, 0.66, 1.98])
  assert.deepEqual([pro.peak.perUnitInCacheHit, pro.peak.perUnitIn, pro.peak.perUnitOut], [0.044, 1.32, 3.96])

  for (const e of Object.values(RECORDED.models)) {
    near(e.peak.perUnitIn, e.perUnitIn * 2)
    near(e.peak.perUnitOut, e.perUnitOut * 2)
    near(e.peak.perUnitInCacheHit, e.perUnitInCacheHit * 2)
  }
})

test('★ 推导别名必须自报家门：页面没命名的 id 不得冒充"页面直接命名"', () => {
  // 这是这张表里唯一一处**推断**：custom-ds 网关的 `-openai` id 页面没有命名。
  // 它被允许进入这张表（否则 PRT-009 的基线结不清），但必须能被读的人一眼分出来。
  for (const model of ['deepseek-v4-flash-openai', 'deepseek-v4-pro-openai']) {
    const e = RECORDED.models[model]
    assert.ok(e, `${model} 应登记（PRT-009 的基线靠它结清）`)
    assert.equal(e.sourceKind, 'derived', `${model} 是推导别名，不得标成 page`)
    assert.ok(e.aliasOf, `${model} 必须写明它别名自谁`)
    assert.ok(PRICE_SOURCE_KINDS.includes(e.sourceKind))
  }
  const derived = estimateCost({ priceTable: RECORDED, model: 'deepseek-v4-flash-openai', tokensIn: 1_000_000, tokensOut: 0 })
  assert.equal(derived.priceSource.kind, 'derived')
  assert.equal(derived.priceSource.aliasOf, 'deepseek-v4-flash')
  const page = estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0 })
  assert.equal(page.priceSource.kind, 'page')
})

test('⑨ 页面说"退役名按 Flash 价"的两个名字，价与 Flash 逐项一致', () => {
  const flash = RECORDED.models['deepseek-flash']
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const e = RECORDED.models[model]
    assert.equal(e.sourceKind, 'page')
    assert.equal(e.aliasOf, 'deepseek-flash')
    assert.equal(e.perUnitIn, flash.perUnitIn)
    assert.equal(e.perUnitOut, flash.perUnitOut)
    assert.equal(e.perUnitInCacheHit, flash.perUnitInCacheHit)
    assert.equal(e.peak.perUnitIn, flash.peak.perUnitIn)
  }
})

test('★ 表里没有的模型 = 没有价：amount 为 null，永不 0，也不冒充某一档', () => {
  for (const model of ['gpt-5.6-sol', 'glm-5.3-flash', 'deepseek-v9', '', 'deepseek-flash ']) {
    const r = estimateCost({ priceTable: RECORDED, model, tokensIn: 1_000_000, tokensOut: 1_000_000 })
    assert.equal(r.ok, false, JSON.stringify(model))
    assert.equal(r.reason, 'MODEL_NOT_PRICED')
    assert.equal(r.amount, null, '不得返回 0')
    assert.match(r.message, /不得当成 0 费用/)
  }
})

test('⑨ 冻结结果带上 basis 与价源：事后能解释"按哪一支价、价是哪来的"', () => {
  const f = frozenEstimate(estimateCost({ priceTable: RECORDED, model: 'deepseek-flash', tokensIn: 1_000_000, tokensOut: 0 }))
  assert.equal(f.ok, true)
  assert.equal(f.basis.timeOfDay, 'peak')
  assert.equal(f.priceSource.kind, 'page')
  assert.equal(f.priceTableVersion, 'deepseek-2026-09-15')
  // 未定价时 basis/priceSource 如实为 null，而不是编一个默认
  const g = frozenEstimate(estimateCost({ priceTable: RECORDED, model: 'nope', tokensIn: 1, tokensOut: 1 }))
  assert.equal(g.amount, null)
  assert.equal(g.basis, null)
  assert.equal(g.priceSource, null)
})

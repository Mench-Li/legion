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
  ESTIMATE_UNKNOWN_REASONS,
  PRICE_ERRORS,
  PRICE_TABLE_UNSET,
  PriceError,
  canSwitchModel,
  createPriceTable,
  estimateCost,
  frozenEstimate,
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

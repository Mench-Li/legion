// runtime/adapters/dsh/usage.mjs
// ============================================================================
// 用量采集：模型、token、费用估算、耗时（PRT-207）
//
// ## 2026-09-15：费用估算从"没有价"迁到"有来源的价目表"
//
// 本模块原来的 `PRICING.asOf === 'UNSET'` 是一个**真实的**状态：当时没有任何
// 可核对的单价，所以 `estimateCostUsd` 一律返回 `null`。那不是占位符，是
// 这条纪律本身——返回 0 会让「价格未配置」看起来像「这次运行免费」。
//
// 现在有了有来源的单价（`DEEPSEEK_PRICE_TABLE`，来源 URL / 检索日期 / 模型版本
// 都记录在 `runtime/contracts/price-table.mjs`），于是：
//
//   · `PRICING` 不再是空表，而是那张记录下来的表；
//   · 估算**只有一处实现**——契约里的 `estimateCost`。本模块不再自己乘一遍：
//     两份实现迟早会漂移，而"按两份算术算出两个数"的失败形态是
//     预算闸门与报表各说各话，两者都看起来正常。
//   · **没变的**：表里没有的模型仍然返回 `null`，绝不返回 0。
//
// ## 估算默认取**更贵**的那一支（peak + cache miss）
//
// 真实价格按 UTC 墙钟分 peak / off-peak（差 2 倍），输入侧分 cache hit / miss
// （差最高 50 倍）。本模块拿不到"这次调用发生在什么时刻""输入里有多少命中缓存"，
// 所以默认取上界：预算闸门**少算**会让用户静默超支，**多算**只是提前拒绝、可见。
// 需要精确值的调用方显式传 `atMs` / `tokensInCacheHit`（见契约里的说明）。
//
// ## `estimatedCostUsd` 未定价时返回 null，绝不返回 0
//
// 这条与 `scripts/prt/baseline-measure.mjs` 的 `estimateCost()` 同源。
// `null` 强制调用方处理「不知道」这个状态。
// ============================================================================

import {
  DEEPSEEK_PRICE_TABLE,
  createPriceTable,
  estimateCost,
  isPriceTable,
} from '../../contracts/price-table.mjs'

/**
 * 价格表：**契约里的记录表**（`model -> entry`，输入/输出/缓存/peak 分列）。
 *
 * 空表不再是当前状态；没有来源的模型依然不报价。
 */
export const PRICING = DEEPSEEK_PRICE_TABLE

/** 用量字段的候选名（不同供应商/版本的命名不一致，按序取第一个存在的）。 */
export const USAGE_FIELD_ALIASES = Object.freeze({
  tokensIn: ['tokensIn', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'],
  tokensOut: ['tokensOut', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'],
})

function pick(obj, names) {
  if (obj === null || typeof obj !== 'object') return undefined
  for (const n of names) {
    const v = obj[n]
    // **必须是合法的计数**：非负、有限、安全整数。
    //
    // 第一版只查了 `Number.isFinite`，于是**负数被当成合法用量**：
    // `pick({ tokensOut: -3 })` 返回 `-3`，调用方据此认为"至少拿到了一个字段"，
    // 于是不再返回 `null`——**一个全是垃圾的 usage 被当成了有效读数**。
    // 负数 token 不是"少"，是一个不可能的值，只可能来自解析错误。
    if (typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0) return v
  }
  return undefined
}

/**
 * 从 DSH 结果对象抽取用量。
 *
 * 返回 `null` 表示**没有可用的用量信息**（而不是「用量为 0」）——
 * 这两个状态在预算与审计里的含义完全不同：前者要显式记录"缺失"，
 * 后者会被当成一次零成本运行累加进总账。
 *
 * ## 一侧未知时，另一侧**不能补 0**
 *
 * 第一版是 `const inTok = tokensIn ?? 0`。看起来无害，实际是在
 * **替引擎宣布一个它没报告的读数**：
 *
 *   · 引擎报了输入、没报输出 → 记成 `tokensOut: 0`
 *   · 而 `0` 是一个**测量结论**（"一个输出 token 都没花"），不是"不知道"
 *
 * 这个 0 会一路流进预算账本与审计；事后对账时它是一个
 * **看起来专业的错误数字**，而没有任何东西提示它是编出来的。
 *
 *   > 缺一个数就写 0，等于把一个未知数记成了一个已知的零。
 *
 * 所以未知的一侧是 `null`。
 */
export function collectUsage(result, options = {}) {
  const { pricing = PRICING, model = null } = options
  if (result === null || typeof result !== 'object') return null

  const usageNode = result.usage ?? result.tokenUsage ?? result.tokens ?? result
  const tokensIn = pick(usageNode, USAGE_FIELD_ALIASES.tokensIn)
  const tokensOut = pick(usageNode, USAGE_FIELD_ALIASES.tokensOut)

  // 两侧都拿不到 → 没有可用用量。**不返回全 0 的对象**。
  if (tokensIn === undefined && tokensOut === undefined) return null

  const inTok = tokensIn ?? null
  const outTok = tokensOut ?? null
  return {
    tokensIn: inTok,
    tokensOut: outTok,
    estimatedCostUsd: estimateCostUsd({ model, tokensIn: inTok, tokensOut: outTok, pricing }),
  }
}

/**
 * 把**老形状**的价格表折进契约价目表：
 * `{ asOf, currency, models: { m: { inPerMTok, outPerMTok } } }`。
 *
 * 这是给已有的调用方留的兼容入口，不是一个平行的算术实现——折好之后走的仍是
 * 契约里的 `estimateCost`。折不动（缺单价/形状不对）就返回 `null`，
 * 由 `estimateCostUsd` 变成"不知道"，而不是变成一个数。
 */
function legacyPricingToTable(pricing) {
  if (pricing === null || typeof pricing !== 'object') return null
  const models = pricing.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return null
  const spec = {}
  for (const [model, p] of Object.entries(models)) {
    if (p === null || typeof p !== 'object') return null
    spec[model] = {
      billingUnit: 'per-mtok',
      unitSize: 1_000_000,
      perUnitIn: p.inPerMTok,
      perUnitOut: p.outPerMTok,
      sourceKind: 'unspecified',
    }
  }
  try {
    return createPriceTable({
      version: typeof pricing.asOf === 'string' && pricing.asOf.trim() !== '' ? pricing.asOf.trim() : 'UNSET',
      currency: typeof pricing.currency === 'string' && pricing.currency.trim() !== ''
        ? pricing.currency.trim()
        : 'USD',
      effectiveAtMs: 0,
      models: spec,
    })
  } catch {
    // 形状坏掉 → 不知道。**不吞成一个数**。
    return null
  }
}

/** 接受契约价目表，或折得动就接受老形状；其余一律 `null`。 */
function asPriceTable(pricing) {
  if (isPriceTable(pricing)) return pricing
  return legacyPricingToTable(pricing)
}

/**
 * 费用估算。
 *
 * 任一前提不满足（没有价目表、模型无价格、token 数缺失）→ `null`。
 * 不抛错：费用是**可选**信息，缺它不该让一次成功的运行变成失败；
 * 但必须让「不知道」向上可见。
 *
 * 默认取**上界**（peak + cache miss）。`atMs` / `tokensInCacheHit` 是显式的
 * "我知道实际时段/缓存命中"，传了才会用便宜的那一支——见契约里的理由。
 */
export function estimateCostUsd({ model, tokensIn, tokensOut, pricing = PRICING, tokensInCacheHit = 0, atMs = null }) {
  const table = asPriceTable(pricing)
  // 没有价目表（老形状的 asOf 仍可能是 'UNSET'）→ 不知道，不是 0。
  if (table === null || table.version === 'UNSET' || table.isEmpty) return null
  if (typeof model !== 'string' || model === '') return null
  const est = estimateCost({ priceTable: table, model, tokensIn, tokensOut, tokensInCacheHit, atMs })
  if (!est.ok) return null
  // 四舍五入到 6 位：亚分精度对预算判定足够，且避免浮点尾数进审计
  return Math.round(est.amount * 1e6) / 1e6
}

/**
 * 耗时采集。
 *
 * 使用注入的时钟（默认 `Date.now`）而不是 `performance.now()`：
 * 适配器要能在测试里给定时间，否则「超时」这类断言只能靠真实等待，
 * 而那会把单测变成慢测试与 flaky 测试。
 */
export function createDurationTracker(now = () => Date.now()) {
  const started = new Map()
  return {
    start(key) {
      started.set(key, now())
      return started.get(key)
    },
    elapsedMs(key) {
      const t0 = started.get(key)
      if (t0 === undefined) return null
      return Math.max(0, now() - t0)
    },
    stop(key) {
      const ms = this.elapsedMs(key)
      started.delete(key)
      return ms
    },
    running() {
      return [...started.keys()]
    },
  }
}

/**
 * 预算检查：超出即返回违规原因（`null` 表示未超）。
 *
 * **无法判定时返回一个说明"无法判定"的违规，而不是 `null`。**
 *
 * `null` 的含义是"确认没超"。所以在**数据不足**时返回 `null`
 * 等于把"不知道"当成"没超"——与下面费用那一条的判据一致。
 *
 * `token-unknown` 这一条是补出来的：第一版写的是
 * `(usage.tokensIn ?? 0) + (usage.tokensOut ?? 0)`，于是引擎只报了一侧时，
 * 另一侧被补成 0，`used` 会**小于真实用量**——一次实际上超支的运行
 * 会被判成"未超"。**低估用量比不知道用量更危险**，因为它是错的却看起来是对的。
 *
 * 费用侧同理：`estimatedCostUsd` 是**上界**（peak + cache miss），所以
 * 它判出的"超支"可能提前——这方向是安全的；而 `null` 仍然是"无法判定"。
 */
export function checkBudget({ budget, usage }) {
  if (!budget || typeof budget !== 'object') return null
  if (!usage) return null
  if (typeof budget.maxTokens === 'number') {
    const inTok = usage.tokensIn
    const outTok = usage.tokensOut
    // 一侧缺失 → 总量不可知。不得用 0 补上，也不得据此宣称未超。
    if (typeof inTok !== 'number' || typeof outTok !== 'number') {
      return {
        kind: 'token-unknown',
        limit: budget.maxTokens,
        used: null,
        message: 'token 用量不完整（缺 tokensIn 或 tokensOut），无法确认是否超出预算（不得视为未超）',
      }
    }
    const used = inTok + outTok
    if (used > budget.maxTokens) {
      return { kind: 'tokens', limit: budget.maxTokens, used, message: `用量 ${used} 超出预算 ${budget.maxTokens} token` }
    }
  }
  if (typeof budget.maxCostUsd === 'number') {
    // 费用未知时**不能**判定为未超预算——那等于把「不知道」当成「没超」
    if (usage.estimatedCostUsd === null || usage.estimatedCostUsd === undefined) {
      return { kind: 'cost-unknown', limit: budget.maxCostUsd, used: null, message: '费用未知，无法确认是否超出预算（不得视为未超）' }
    }
    if (usage.estimatedCostUsd > budget.maxCostUsd) {
      return { kind: 'cost', limit: budget.maxCostUsd, used: usage.estimatedCostUsd, message: `费用 $${usage.estimatedCostUsd} 超出预算 $${budget.maxCostUsd}` }
    }
  }
  return null
}

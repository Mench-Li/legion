// runtime/adapters/dsh/usage.mjs
// ============================================================================
// 用量采集：模型、token、费用估算、耗时（PRT-207）
//
// ## `estimatedCostUsd` 未配置价格时返回 null，绝不返回 0
//
// 这条与 `scripts/prt/baseline-measure.mjs` 的 `estimateCost()` 同源：
// 返回 0 会让「价格未配置」看起来像「这次运行免费」，
// 于是预算闸门（PRT-503/PRT-510）静默失效——一个**看起来在工作**的安全检查
// 比没有检查更危险，因为它会让人停止人工核对。
// `null` 强制调用方处理「不知道」这个状态。
//
// ## 价格表带 `asOf`
//
// 价格会变。没有生效时间的价格表无法回答「这个估算用的是哪版价」，
// 事后对账时就成了不可解释的数字。`PRICING.asOf` 未设定时不得用于估算。
// ============================================================================

/**
 * 价格表：`model -> { inPerMTok, outPerMTok, currency }`。
 *
 * **空表是刻意的当前状态**：阶段 0～1 没有真实执行过，也就没有任何
 * 可核对的真实价格。填假价格比留空更糟——留空会得到 `null`，
 * 填假会得到一个看起来很专业的错误数字。
 */
export const PRICING = Object.freeze({
  asOf: 'UNSET',
  currency: 'USD',
  models: Object.freeze({}),
})

/** 用量字段的候选名（不同供应商/版本的命名不一致，按序取第一个存在的）。 */
export const USAGE_FIELD_ALIASES = Object.freeze({
  tokensIn: ['tokensIn', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'],
  tokensOut: ['tokensOut', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'],
})

function pick(obj, names) {
  if (obj === null || typeof obj !== 'object') return undefined
  for (const n of names) {
    const v = obj[n]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/**
 * 从 DSH 结果对象抽取用量。
 *
 * 返回 `null` 表示**没有可用的用量信息**（而不是「用量为 0」）——
 * 这两个状态在预算与审计里的含义完全不同：前者要显式记录"缺失"，
 * 后者会被当成一次零成本运行累加进总账。
 */
export function collectUsage(result, options = {}) {
  const { pricing = PRICING, model = null } = options
  if (result === null || typeof result !== 'object') return null

  const usageNode = result.usage ?? result.tokenUsage ?? result.tokens ?? result
  const tokensIn = pick(usageNode, USAGE_FIELD_ALIASES.tokensIn)
  const tokensOut = pick(usageNode, USAGE_FIELD_ALIASES.tokensOut)

  if (tokensIn === undefined && tokensOut === undefined) return null

  const inTok = tokensIn ?? 0
  const outTok = tokensOut ?? 0
  return {
    tokensIn: inTok,
    tokensOut: outTok,
    estimatedCostUsd: estimateCostUsd({ model, tokensIn: inTok, tokensOut: outTok, pricing }),
  }
}

/**
 * 费用估算。
 *
 * 任一前提不满足（价格表未生效、模型无价格、token 数缺失）→ `null`。
 * 不抛错：费用是**可选**信息，缺它不该让一次成功的运行变成失败；
 * 但必须让「不知道」向上可见。
 */
export function estimateCostUsd({ model, tokensIn, tokensOut, pricing = PRICING }) {
  if (pricing?.asOf === 'UNSET' || !pricing?.asOf) return null
  if (typeof model !== 'string' || model === '') return null
  const price = pricing.models?.[model]
  if (!price) return null
  const inRate = price.inPerMTok
  const outRate = price.outPerMTok
  if (typeof inRate !== 'number' || typeof outRate !== 'number') return null
  if (typeof tokensIn !== 'number' || typeof tokensOut !== 'number') return null
  const usd = (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate
  // 四舍五入到 6 位：亚分精度对预算判定足够，且避免浮点尾数进审计
  return Math.round(usd * 1e6) / 1e6
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

/** 预算检查：超出即返回违规原因（`null` 表示未超）。缺任一输入即无法判定 → 返回 `null` 而非放行。 */
export function checkBudget({ budget, usage }) {
  if (!budget || typeof budget !== 'object') return null
  if (!usage) return null
  if (typeof budget.maxTokens === 'number') {
    const used = (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0)
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

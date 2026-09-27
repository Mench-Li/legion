// runtime/contracts/harness-routing.mjs
// ============================================================================
// F-23 多 Harness 路由 —— **路由判定**（纯结构，不做 I/O）
//
// 业主裁决（2026-09-24，逐字）：「采取3，即2为主，1兜底」
//   · 2 = **结构化配置表为权威**：任务类型/角色 ⇒ harness 产品
//   · 1 = 自然语言建议作**兜底**：模型可以建议，但必须**在册**才算数
//
// ## 优先级（这是本文件唯一要守的东西）
//
//   ① **单次任务显式指定**  （source: explicit）
//   ② **配置表命中**        （source: table）
//   ③ **模型建议（兜底）**   （source: suggested）—— 必须在册
//   ④ **默认**              （source: default）—— 不指定就是它
//
// ## 两条不许让步的规矩
//
// 1. **指名一个不在册的 provider ⇒ 具名拒绝，绝不回落到默认。**
//    静默回落是最坏的一种：任务被送去别的 harness 跑完了，而调用方以为用的是自己指定的那个。
// 2. **建议不是权威**：模型建议只有在册时才被采纳，且**来源如实记账**（source）。
//    否则"这条任务当初为什么交给它"就没人说得清 —— 权威只能有一个。
//
// ## 错误分两种，位置不同
//
//   · **启动期**（构造即抛）：默认不在册、某条规则指向不在册的 provider。
//     一条指向不存在 provider 的规则，会在运行时把任务送去没人接的地方 ⇒ 挪到启动期。
//   · **运行期**（具名拒绝，返回 ok:false）：本次指定/建议不在册。
// ============================================================================

export const ROUTE_SOURCES = {
  EXPLICIT: 'explicit',
  TABLE: 'table',
  SUGGESTED: 'suggested',
  DEFAULT: 'default',
}

export const ROUTE_REJECT = {
  UNKNOWN_PROVIDER: 'unknown-provider',
  NO_DEFAULT: 'no-default',
}

const isStr = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * @param {object} deps
 * @param {Array<string>} deps.providers **在册**的 harness 产品名（权威清单）
 * @param {Array<{taskType: string, provider: string}>} [deps.rules] 配置表
 * @param {string} deps.defaultProvider 不指定时用它（产品默认是 DeepSeek Harness）
 */
export function createHarnessRouter({ providers, rules = [], defaultProvider } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) throw new TypeError('providers 必填：在册的 harness 清单')
  for (const p of providers) if (!isStr(p)) throw new TypeError('providers 里有空名')
  const registered = Object.freeze([...new Set(providers.map((p) => p.trim()))])
  const inList = (name) => registered.includes(name)

  if (!isStr(defaultProvider)) throw new TypeError('defaultProvider 必填')
  if (!inList(defaultProvider)) throw new Error('默认 provider 不在册：' + defaultProvider)

  const table = new Map()
  for (const r of rules) {
    if (r === null || typeof r !== 'object' || !isStr(r.taskType) || !isStr(r.provider)) {
      throw new Error('规则形状不对：' + JSON.stringify(r))
    }
    if (!inList(r.provider)) {
      // ★ 启动期就炸：指着不存在 provider 的规则，运行时会把任务送去没人接的地方。
      throw new Error('规则指向不在册的 provider：' + r.taskType + ' ⇒ ' + r.provider)
    }
    table.set(r.taskType.trim(), r.provider.trim())
  }

  return {
    /** 只读面：在册清单 + 表的快照 + 默认。 */
    describe() {
      return { providers: [...registered], rules: [...table.entries()].map(([taskType, provider]) => ({ taskType, provider })), defaultProvider }
    },

    /**
     * 定这次任务交给谁。
     * @param {{taskType?: string, requested?: string, suggested?: string}} req
     * @returns {{ok: true, provider: string, source: string} | {ok: false, reason: string, detail?: object}}
     */
    resolve({ taskType, requested, suggested } = {}) {
      if (isStr(requested)) {
        const want = requested.trim()
        // ★ 指名不在册 ⇒ 具名拒绝。**不回落**。
        if (!inList(want)) return { ok: false, reason: ROUTE_REJECT.UNKNOWN_PROVIDER, detail: { requested: want, stage: ROUTE_SOURCES.EXPLICIT } }
        return { ok: true, provider: want, source: ROUTE_SOURCES.EXPLICIT }
      }
      if (isStr(taskType) && table.has(taskType.trim())) {
        return { ok: true, provider: table.get(taskType.trim()), source: ROUTE_SOURCES.TABLE }
      }
      if (isStr(suggested)) {
        const want = suggested.trim()
        // ★ 建议也必须在册；不在册同样具名拒绝（建议不是权威，但也不能沉默地丢掉）。
        if (!inList(want)) return { ok: false, reason: ROUTE_REJECT.UNKNOWN_PROVIDER, detail: { suggested: want, stage: ROUTE_SOURCES.SUGGESTED } }
        return { ok: true, provider: want, source: ROUTE_SOURCES.SUGGESTED }
      }
      return { ok: true, provider: defaultProvider, source: ROUTE_SOURCES.DEFAULT }
    },
  }
}

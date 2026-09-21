// runtime/dsh-composition/usage-projection.mjs
// ============================================================================
// 一次 Run 的 token 用量：从 DSH 的**会话投影**里读，而不是从结果契约里要
//
// ## 为什么要有这个文件
//
// `usage-reporting` 是四项必需能力之一，而它长期是 `false`。根因不是"没人接线"，
// 是**引擎的一次性结果契约里根本没有用量字段**：
//
//   · `SubagentResult` 逐字读过（`packages/subagent/subagent/src/types.ts`）：
//     只有 `output` / `structured?` / `diagnostic?` / `stopReason` —— **无 usage**；
//   · 而 `runtime/adapters/dsh/usage.mjs` 的 `collectUsage()` 读的正是
//     `result.usage` / `result.tokenUsage` / `result.tokens` —— 三个都不存在；
//   · 所以 `collectUsage()` 在真结果上**恒返回 null**，预算闸门因此永远拿不到 token 数。
//
// 但**用量确实存在**，只是在另一条通道上：DSH 把每条 `assistant/message` 的
// provider 上报用量（`inputTokens` / `outputTokens` / `cacheReadTokens` ...）写进会话日志，
// 而 `ctx.sessionProjections` 是它的一等读面 —— 由框架在 `session/event` 上
// **急切驱动**纯折叠，注册方只提供 `init` / `apply`。
//
// ## 归因：怎么知道这段用量属于**哪一次 Run**
//
// 这是本模块唯一真正的设计问题。三条实测读数决定了它：
//
//   ① `SubagentRun.id` 是 `SessionId`（`types.ts` 的 `SubagentRun`）——
//      `startRun()` 的返回值上就有，无需新开字段；
//   ② 该 id 与会话转录的**目录名逐字相等**（151/151 实测），
//      也与 `records` 里 `type === 'session'` 那一条的 `id` 相等；
//   ③ 子代理会话**尾部一定有 `turn/end`**（95/95 实测），且在最后一条 usage 之后
//      ⇒ 结算时读不会漏掉最后一条。
//
// 所以归因**不是**"按时间猜"，而是：`run.id` → `ctx.sessions.get(id)` → `Session`
// → `sessionProjections.stateOf(session, KEY)`。全程进程内、无文件 I/O。
//
//   > 一个"按时间窗口对齐"的用量归因，与一个"按 SessionId 直取"的归因，
//   > 在只看总数的时候是同一个东西——只不过前者会在并发 Run 时把两次的用量
//   > 混在一起，而那个和看起来完全正常。
//
// ## 诚实的边界（不许越过的三条）
//
//   ① **读不到就是 `null`**，不是 `{tokensIn: 0, tokensOut: 0}`。
//      `usage.mjs` 的注释已经说过一次，这里再犯就是明知故犯：
//      0 是一个**测量结论**（"一个 token 都没花"），不是"不知道"。
//   ② **不估算费用**。本模块只累加 provider 上报的计数。费用由
//      `estimateCostUsd()` 用那张有来源的价目表算——两处各乘一遍迟早给出两个数。
//   ③ **不推断"这次用了哪个模型"**。用量是 per-message 的，模型要另说。
//
// ## 与 `scripts/prt/dsh-session-usage.mjs` 的关系
//
// 那个文件是**离线工具**（读 `.jsonl.zstd`，用于 PRT-009 的证据采集），
// 它踩过的两个坑本模块**继承其结论但不再踩**：
//   · 多帧 zstd：本模块走进程内投影，没有解码；
//   · `totalTokens ≠ input + output`（实测 `total = input + output + cacheRead`）：
//     本模块**只累加三个分量**，不碰 `totalTokens`——把 total 当 input+output
//     会低估约一个量级（GF-001 实测 input 68822 / output 50122，而 total 1682208）。
// ============================================================================

/** 投影键。取一个 Legion 自己的名字，不占用 DSH 的 `sessionStats`。 */
export const USAGE_PROJECTION_KEY = 'legionRunUsage'

/**
 * 折叠状态：**只放能直接累加的整数**，形状固定（投影契约要求纯 JSON）。
 *
 * `messages` 是"贡献过用量的 assistant 消息条数"——它不是用量本身，而是
 * 让"读到 0 条"与"读到 5 条但都是 0"分得开的那一格。
 */
export const EMPTY_USAGE_STATE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  messages: 0,
})

/**
 * 从一个会话事件里取出用量计数。
 *
 * 返回 `null` 表示**这条事件不带用量**（绝大多数事件都不带，不是错误）。
 *
 * ⚠️ 只接受**非负安全整数**：`usage.mjs` 的 `pick()` 已经因为"负数被当成合法用量"
 * 修过一次（一个全垃圾的 usage 会被当成有效读数）。这里沿用同一条判据。
 */
export function usageOf(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type !== 'assistant/message') return null
  const data = event.data
  if (data === null || typeof data !== 'object') return null
  const u = data.usage
  if (u === null || typeof u !== 'object') return null

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0 ? v : 0)
  const inputTokens = num(u.inputTokens)
  const outputTokens = num(u.outputTokens)
  const cacheReadTokens = num(u.cacheReadTokens)

  // ★ 三个分量**全**不是合法计数 ⇒ 这条 usage 不可用。
  //   不能返回一个全 0 的对象：那会让"引擎报了一条空 usage"与
  //   "引擎什么都没报"在累加之后变成同一个读数。
  const anyValid = [u.inputTokens, u.outputTokens, u.cacheReadTokens]
    .some((v) => typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0)
  if (!anyValid) return null

  return { inputTokens, outputTokens, cacheReadTokens }
}

/**
 * 纯折叠：状态 + 一条事件 → 新状态。
 *
 * **不关心的事件必须返回同一个引用**（投影契约的承重条款）：
 * 返回新对象会让框架在每个事件上都判"变了"，于是每次提交都产生下游工作。
 */
export function applyUsageEvent(state, event) {
  const u = usageOf(event)
  if (u === null) return state
  return {
    inputTokens: state.inputTokens + u.inputTokens,
    outputTokens: state.outputTokens + u.outputTokens,
    cacheReadTokens: state.cacheReadTokens + u.cacheReadTokens,
    messages: state.messages + 1,
  }
}

/**
 * 把投影状态翻译成契约的用量形状（`collectUsage()` 认的那几个字段名）。
 *
 * ★ 读不到用量（`messages === 0`）⇒ 返回 **`null`**，不是全 0 的对象。
 *   `usage.mjs` 的 `collectUsage()` 也是这个判据：`null` 的含义是
 *   "没有可用的用量信息"，而"用量为 0"是另一件事。
 */
export function usageFromState(state) {
  if (state === null || typeof state !== 'object') return null
  if (!Number.isSafeInteger(state.messages) || state.messages <= 0) return null
  return {
    tokensIn: state.inputTokens,
    tokensOut: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    messages: state.messages,
  }
}

/**
 * 造一个 `sessionProjections.register()` 能吃的**仅主机**投影定义。
 *
 * 仅主机（没有 `wire`）是有意的：这个投影是给 Legion 自己读的，
 * 不需要出现在客户端快照里。而 `register()` 的仅主机重载正为此存在。
 *
 * @returns 定义对象；调用方用自己的 `ctx` 注册。
 */
export function createUsageProjectionDefinition() {
  return {
    key: USAGE_PROJECTION_KEY,
    // 形状校验：一个坏掉的持久化行不该被前向折叠成垃圾。
    stateSchema: {
      parse(value) {
        if (value === null || typeof value !== 'object') throw new Error('usage 投影状态必须是对象')
        const out = {}
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'messages']) {
          const v = value[k]
          if (!Number.isSafeInteger(v) || v < 0) throw new Error(`usage 投影状态字段 ${k} 必须是非负安全整数`)
          out[k] = v
        }
        return out
      },
    },
    init: () => ({ ...EMPTY_USAGE_STATE }),
    apply: (state, event) => applyUsageEvent(state, event),
    // 折叠语义或字段变了就递增（本版为第 1 版）。
    stateVersion: 1,
  }
}

/**
 * 由 `SessionId` 读一次 Run 的用量。
 *
 * @param ctx - 现场 Cordis Context（要能 `ctx.get('sessions')` / `('sessionProjections')`）。
 * @param sessionId - `SubagentRun.id`。
 * @returns 用量对象，或 **`null`**（读不到就如实说读不到）。
 *
 * 三种"读不到"**各自有码**（见 `USAGE_READ_CODES`），因为它们要修的东西不同：
 * 服务缺席要人去挂，会话找不到要人去查归因，投影没注册要人去注册。
 * 合成一个 `null` 会让这三种处境在值班的人眼里变成同一种。
 */
export const USAGE_READ_CODES = Object.freeze({
  /** 现场没有 `sessions` 服务（进程形状不对）。 */
  NO_SESSIONS_SERVICE: 'LEGION_USAGE_NO_SESSIONS_SERVICE',
  /** 现场没有 `sessionProjections` 服务（DSH 组合层没挂那一行）。 */
  NO_PROJECTIONS_SERVICE: 'LEGION_USAGE_NO_PROJECTIONS_SERVICE',
  /** 这个 id 在当前进程的会话存储里找不到（归因键对不上，或会话已卸载）。 */
  SESSION_NOT_FOUND: 'LEGION_USAGE_SESSION_NOT_FOUND',
  /** 投影已注册，但这个会话还没有任何带用量的事件。 */
  NO_USAGE_EVENTS: 'LEGION_USAGE_NO_USAGE_EVENTS',
  /** 读到了。 */
  OK: 'LEGION_USAGE_OK',
})

export function readRunUsage(ctx, sessionId) {
  const fail = (code) => ({ ok: false, code, usage: null })

  if (typeof sessionId !== 'string' || sessionId === '') return fail(USAGE_READ_CODES.SESSION_NOT_FOUND)

  const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') {
    return fail(USAGE_READ_CODES.NO_SESSIONS_SERVICE)
  }
  const projections = ctx.get('sessionProjections')
  if (projections === undefined || projections === null || typeof projections.stateOf !== 'function') {
    return fail(USAGE_READ_CODES.NO_PROJECTIONS_SERVICE)
  }

  const session = sessions.get(sessionId)
  if (session === undefined || session === null) return fail(USAGE_READ_CODES.SESSION_NOT_FOUND)

  const state = projections.stateOf(session, USAGE_PROJECTION_KEY)
  // 投影没注册 ⇒ `stateOf` 返回 `undefined`（这是它的契约）。
  // ★ 这一格与"注册了但没数据"必须分开：前者要人去注册，后者是正常的早期状态。
  if (state === undefined || state === null) return fail(USAGE_READ_CODES.NO_PROJECTIONS_SERVICE)

  const usage = usageFromState(state)
  if (usage === null) return fail(USAGE_READ_CODES.NO_USAGE_EVENTS)

  return { ok: true, code: USAGE_READ_CODES.OK, usage }
}

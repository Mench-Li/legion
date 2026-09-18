// runtime/connectors/outcome-port.mjs
// ============================================================================
// F-21 / 第 19 条：**连接器熔断器的反馈面**——把"这次工具调用最后成没成"
// 变成 `createRegistry().recordOutcome()` 的输入。
//
// ## 为什么需要这个文件（它不是"顺手加的一层"）
//
// `runtime/connectors/registry.mjs` 的 `decide()` **读**熔断器状态：
//
//     :556  const circuit = circuits.get(id)
//     :565  if (circuit.state === 'open')        → deny  connector-circuit-open
//     :573  if (circuit.state === 'half-open')   → 只放行一次探针
//
// 而改那个状态的**只有一个入口**：`recordOutcome({connectorId, ok, error, atMs})`
// （`:607`；阈值 `CIRCUIT_FAILURE_THRESHOLD = 3`、冷却 `CIRCUIT_COOLDOWN_MS = 30_000`）。
//
// 在本次之前，`recordOutcome` 的**生产调用方是 0 处**（全仓 grep 只命中定义
// 与它自己的用例）。于是把 `decide()` 接进强制面会得到：
//
//   > 一个"接了连接器判定"的强制面，
//   > 与一个"接了一个**永远合闸**的熔断器"的强制面，在读数上是同一个东西——
//   > 而它的方向是**放行**。
//
// 而它比"没接线"**更难发现**：注册表建得起来、`decide()` 答得出来、用例全绿，
// 没有任何一行会说"反馈面没装"。所以本模块存在的理由不是"多一个功能"，
// 是**让第二半有一个能装的东西**。
//
// ## 接在哪一个钩子上：`tools/result`，不是 `tools/post-execute`
//
// DSH 有两个执行后的钩子（`packages/core/tools/src/index.ts`），语义**不同**：
//
//   · `:169 'tools/post-execute'` —— `@mode waterfall`，在**派发路径里**，
//     可以 accept / replace / block。它**改变**结果。
//   · `:191 'tools/result'`       —— `@mode emit`，原文：
//     "Observe the frozen, lossless-JSON final outcome.
//      **Listener failures are contained.**"
//
// 熔断器是**记录器**：它必须看见结果，但**绝不能**改变结果——一个"能拒绝工具调用"
// 的失败记录器，会在连接器抖动的第一次就把它自己的观测变成一次新的失败。
// 所以选 `tools/result`，理由有两条且都要写下来：
//
//   1. **方向**：记录器只观测（emit 没有返回值），所以它在结构上改不了这次调用；
//   2. **可见的是哪个结果**：emit 收的是**最终的**结果（policy / fallback 之后），
//      而那正是"这个连接器到底行不行"要数的东西。
//
//   > 一个挂在瀑布上的失败记录器，
//   > 与一个"连接器一抖就把工具调用也一起拒掉"的强制面，是同一个东西——
//   > 只不过前者的第一现场看起来像"工具自己失败了"。
//
// ## ★★ 本模块最要紧的一条：**"判不出来"必须是它自己的一个桶**
//
// DSH 的结果是一个**判别联合**（`:555` / `:568` / `:579`）：
//
//     interface ToolExecutionSuccess { readonly isError: false; value; content; … }
//     interface ToolExecutionFailure { readonly isError: true;  error: ToolFailure; content; … }
//     type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
//
// 判别子是 **`isError`**，而且两侧都是**必填字面量**。于是有三种输入，不是两种：
//
//   · `isError === false` ⇒ 成功
//   · `isError === true`  ⇒ 失败
//   · **其它一切**（字段缺失 / 不是布尔 / 整个 result 不是对象）⇒ **判不出来**
//
// 第三种**不许被折进前两种**，两个方向都是错的，且错法**不对称**：
//
//   · 折成成功 ⇒ `recordOutcome({ok:true})` 会**清零** `consecutiveFailures`
//     并把熔断器**合闸**（`:616-621`）⇒ 一个坏连接器**永远开不了路**；
//   · 折成失败 ⇒ 一次**我们读不懂**的输入会把一个**健康**的连接器推向开路。
//
//   > 一个"读不懂就当成成功"的读数，与一个"读不懂就当成失败"的读数，
//   > 在汇总表里都很干脆——只不过前者让坏连接器**隐身**，
//   > 后者让好连接器**被冤枉**。
//
// 所以本模块返回 `unclassifiable`，**并且一条都不记**，同时把它**计数**
// （见下面 `receipts().unclassifiable`）——一个"因为读不懂所以什么都没记"的状态，
// 与一个"确实没有失败"的状态，必须在读数上分得开。
//
// ## ★ 第二条：认不出**哪一条连接器**时也要如实缺席
//
// `recordOutcome` 对没注册过的 `connectorId` **抛**（`:609-611`）。这不是可以
// 绕过的细节——它意味着"这次调用属于哪个连接器"必须**有人知道**。
// 本模块把它交给注入的 `resolveConnectorId(projection)`：
//
//   · 返回一个字符串 ⇒ 记在该 id 上；
//   · 返回 `null` / `undefined` ⇒ **不记**，计入 `unattributed`。
//
// ★ **绝不"猜一个"**：把一次没有归属的失败记到某个连接器头上，会让一个
// **完全健康**的连接器因为别人的失败而开路。这与 `decide()` 那边
// "未知 connectorId ⇒ deny（`UNKNOWN_CONNECTOR`）"是同一个纪律的两侧：
// 判定侧不猜 ⇒ 拒绝；记录侧不猜 ⇒ 不记。
//
// ## ★ 第三条：**永不抛**
//
// `tools/result` 的契约说 listener 的失败会被兜住。本模块**不依赖那个兜底**：
//
//   > 一个"靠宿主兜住异常"的记录器，
//   > 与一个"每次工具失败都顺手把整条工具流水线炸掉"的记录器，是同一个东西——
//   > 只不过前者在别的宿主的版本里才会现形。
//
// 所以每一次记录都包在 try/catch 里，失败进 `receipts().recordFailed`。
// @module runtime/connectors/outcome-port
// ============================================================================

export const OUTCOME_PORT_VERSION = 'legion/connector-outcome-port@1'

/** 构造期与记录期的具名码。 */
export const OUTCOME_PORT_CODES = Object.freeze({
  /** 没给 registry，或者给的 registry 上没有 `recordOutcome`。 */
  NO_REGISTRY: 'connector-outcome-no-registry',
  /** 没给 `resolveConnectorId`，或者它不是函数。 */
  NO_RESOLVE: 'connector-outcome-no-resolve',
})

/**
 * 三种结论。★ **三种不是两种**——理由见文件头。
 *
 * @readonly
 * @enum {string}
 */
export const OUTCOME_KINDS = Object.freeze({
  /** `result.isError === false`：这次调用成功了。 */
  OK: 'ok',
  /** `result.isError === true`：这次调用失败了。 */
  FAILED: 'failed',
  /** 判别子不在 / 不是布尔 / 整个 result 不是对象 —— **不猜**。 */
  UNCLASSIFIABLE: 'unclassifiable',
})

function portError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 从 DSH 的 `ToolExecutionResult` 读出"成 / 败 / 判不出来"。
 *
 * ★ 只看**一个**字段：`isError`。不看 `content` 是不是空、不看有没有 `error` 对象、
 * 不看 `value` 在不在——那些都是**推导**，而推导出来的"失败"
 * 会在连接器返回一个合法的空结果时把它判成故障。
 *
 * @param {unknown} result DSH `tools/result` 的第二个参数
 * @returns {Readonly<{kind: string, error: string|null, why: string|null}>}
 */
export function classifyOutcome(result) {
  if (!isPlainObject(result)) {
    return Object.freeze({
      kind: OUTCOME_KINDS.UNCLASSIFIABLE,
      error: null,
      why: `结果不是对象（${result === null ? 'null' : typeof result}），读不出 isError`,
    })
  }
  // ★ 必须**是布尔**。`0` / `'false'` / `undefined` 都进 unclassifiable：
  //   一个"truthy 就当失败"的判据会把 `isError: 'false'` 读成失败。
  if (result.isError !== true && result.isError !== false) {
    return Object.freeze({
      kind: OUTCOME_KINDS.UNCLASSIFIABLE,
      error: null,
      why: `isError 既不是 true 也不是 false（${JSON.stringify(result.isError)?.slice(0, 40)}）`,
    })
  }
  if (result.isError === false) {
    return Object.freeze({ kind: OUTCOME_KINDS.OK, error: null, why: null })
  }
  // `ToolFailure = { message: string; info?: ToolErrorInfo }`（`:567` 一带）。
  // ★ 读不出来就给 `null`，**不编一句话**：一句编出来的错误消息会在排障时
  //   指向一个不存在的失败原因。
  const message = isPlainObject(result.error) && typeof result.error.message === 'string'
    ? result.error.message
    : null
  return Object.freeze({ kind: OUTCOME_KINDS.FAILED, error: message, why: null })
}

/**
 * 造一个可以直接交给 `ctx.on('tools/result', …)` 的监听器。
 *
 * @param {object} input
 * @param {object} input.registry `createRegistry()` 的返回值（要 `recordOutcome`）
 * @param {(projection: object|null, exec: object) => (string|null)} input.resolveConnectorId
 *   这次调用属于哪一条连接器。返回 `null` 表示**认不出** ⇒ 不记（见文件头）。
 * @param {(projection: object|null, exec: object) => (object|null)} [input.projectionFor=null]
 *   桥的 `projectionFor(exec)` 包装。给了就用它取投影（**与强制面看同一份**）；
 *   不给则 `resolveConnectorId` 只拿到 `exec`。
 * @param {(receipt: object) => void} [input.onRecord=null] 观测点，**不参与记录**。
 * @returns {(exec: object, result: unknown) => void} **永不抛**的监听器
 * @throws {Error} `NO_REGISTRY` / `NO_RESOLVE` —— 构造期就拒，不留一个空记录器
 */
export function createOutcomeListener({
  registry,
  resolveConnectorId,
  projectionFor = null,
  onRecord = null,
} = {}) {
  // ★ 构造期 fail closed：一个"没有注册表也能挂上"的监听器只能靠静默丢弃，
  //   而"挂了但什么都不记"与"从没挂过"在 `enforcementSurfaces()` 里同形。
  if (registry === null || typeof registry?.recordOutcome !== 'function') {
    throw portError(OUTCOME_PORT_CODES.NO_REGISTRY,
      'createOutcomeListener 需要 createRegistry() 的返回值（要 recordOutcome）')
  }
  if (typeof resolveConnectorId !== 'function') {
    throw portError(OUTCOME_PORT_CODES.NO_RESOLVE,
      'createOutcomeListener 需要 resolveConnectorId(projection, exec)。' +
      '**不给默认值**：一个"认不出就记在第一条连接器上"的默认值，' +
      '会让一条健康的连接器因为别人的失败而开路')
  }
  if (projectionFor !== null && typeof projectionFor !== 'function') {
    throw portError(OUTCOME_PORT_CODES.NO_RESOLVE,
      `projectionFor 要么不给，要么是函数（收到 ${typeof projectionFor}）`)
  }

  const counters = {
    seen: 0,
    recorded: 0,
    ok: 0,
    failed: 0,
    unclassifiable: 0,
    unattributed: 0,
    recordFailed: 0,
  }

  function note(receipt) {
    try {
      onRecord?.(receipt)
    } catch {
      // 观测点自己的异常**不许**影响记录（它与记录不是一件事）。
    }
  }

  function listener(exec, result) {
    counters.seen += 1
    const verdict = classifyOutcome(result)

    // ① **判不出来** ⇒ 一条都不记（两个方向都错，见文件头）。
    if (verdict.kind === OUTCOME_KINDS.UNCLASSIFIABLE) {
      counters.unclassifiable += 1
      note({ kind: 'unclassifiable', why: verdict.why, connectorId: null })
      return
    }

    // ② 取投影。★ 与强制面**同一份**（`projectionFor` 按 callId 记忆），
    //    否则两个点会看到两个不同的目标——那正是 `tool-request.mjs` 记过的坑。
    let projection = null
    if (projectionFor !== null) {
      try {
        const got = projectionFor(exec)
        if (got?.ok === true) projection = got.projection
      } catch {
        projection = null
      }
    }

    // ③ 认不出属于哪一条连接器 ⇒ 不记、单独计数。
    let connectorId = null
    try {
      const resolved = resolveConnectorId(projection, exec)
      if (typeof resolved === 'string' && resolved.trim() !== '') connectorId = resolved
    } catch {
      connectorId = null
    }
    if (connectorId === null) {
      counters.unattributed += 1
      note({ kind: 'unattributed', outcome: verdict.kind, connectorId: null })
      return
    }

    // ④ 记。★ 包在 try/catch 里：`recordOutcome` 对没注册的 id **抛**。
    const ok = verdict.kind === OUTCOME_KINDS.OK
    try {
      registry.recordOutcome({ connectorId, ok, error: verdict.error })
      counters.recorded += 1
      if (ok) counters.ok += 1
      else counters.failed += 1
      note({ kind: 'recorded', outcome: verdict.kind, connectorId, error: verdict.error })
    } catch (err) {
      counters.recordFailed += 1
      note({
        kind: 'record-failed',
        outcome: verdict.kind,
        connectorId,
        why: err?.code ?? err?.message ?? String(err),
      })
    }
  }

  // ★ 诊断用（**不可枚举**）：与 `createPreExecutePlugin` 同一条理由——
  //   让"实际闭包到了什么"可被断言，而不是让装配方对着自己传的参数断言。
  //   不可枚举：这是**活对象**，不该被 `JSON.stringify` 带出去。
  Object.defineProperty(listener, 'receipts', {
    value: () => Object.freeze({ ...counters, version: OUTCOME_PORT_VERSION }),
    enumerable: false,
  })
  // ★ 与 `decision-port.mjs` 对称：把 `registry` 也挂出来（不可枚举）。
  //
  //   理由很具体：判定面与反馈面**必须**共用同一份 registry，否则
  //   判定面读的熔断器永远合闸（没人写它），而反馈面写的那个没人读。
  //   那件事在读数上不可见——除非有人能问"你到底在写哪一本账"。
  //   挂在**监听器自己**上（而不是让组合方对着自己传的参数断言），
  //   与 `receipts` 是同一条理由。
  Object.defineProperty(listener, 'registry', { value: registry, enumerable: false })
  return listener
}

// ============================================================================
// runtime/connectors/decision-port.mjs
//
// 把 `runtime/connectors/registry.mjs` 的 `decide()` **织进**强制面桥的
// `decide` 端口 —— 也就是 F-21 的**判定面**那一半。
//
// 本文件与 `outcome-port.mjs` 是**同一个缺口的两侧**，两条纪律也一一对应：
//
//   判定侧（本文件）：认不出 ⇒ **不插话**，交给下游策略门；
//   记录侧（outcome-port）：认不出 ⇒ **不记**，谁都不冤。
//
// 两侧都不猜。而它们合起来才是一条**闭环**：判定面放行/拦截，记录面把
// 结果喂回熔断器，熔断器再影响下一次判定（见文件末尾"两半是一条环"）。
//
// ## ★★★ 第一条：连接器层的 `allow` **绝不许短路政策门**
//
// 本模块收到的 `inner` 才是**政策门**（`root.mjs` 的 `input.decide`，
// 真实实现由部署注入）。连接器层的 `allow` 只说明"这个连接器允许这个工具"，
// **一点也不能说明**"这次调用符合 legion 的政策"。
//
//   > 一个"连接器层 allow 就整体 allow"的组合，
//   > 与一个"每一次连接器调用都**跳过整个政策层**"的桥，是同一个东西——
//   > 只不过前者的读数看起来像"连接器策略生效了"。
//
// 所以合并是**格**（lattice）而不是短路：`deny > ask > allow`，**取更严的那个**。
//
// ## ★★★ 第二条：连接器层的 `ask` **也不许先于政策门返回**
//
// 这条比第一条更容易漏，因为它看起来像"多问了一句人，更安全"：
//
//   政策门明明说 `deny`，而连接器层说 `ask`（高风险 / 半开探针）。
//   如果先把 `ask` 返回出去，这次调用就**没有**被拒绝，
//   而是变成了"可以被人批准的一次调用"。
//
//   > 一个"连接器要问人，就让整条链变成 ask"的组合，
//   > 与一个"**政策层的拒绝被降级成一次可以批准的询问**"的桥，是同一个东西——
//   > 只不过前者看起来像"多问了一句"。
//
// 所以两侧**都要算出来**，再取严。
//
// ## ★★ 第三条：`allow` 在本仓库是"让路"，不是"定案"
//
// `plugins/pre-execute.mjs:110` 写着：`kind === 'allow'` ⇒ `next()`。
// 也就是 `allow` 会让**后面每一道门照常说话**，而 `deny` / `ask` 会**认领**
// （后面的门再也说不出话）。这与 `hard floor` 那条"guard 只有降级语义、
// 没有 allow 语义"是同一条原则。
//
// ⇒ 本模块在**只有一侧有话要说**时，必须返回那一侧的原话；
//   在两侧都放行时才返回 `allow`（让路）。**不许**把 `allow` 当成
//   "我说了算、后面的别管了"。
//
// ## ★★ 第四条：读不懂的 `kind` ⇒ **deny**，并且把原值写进理由
//
// `inner` 的契约是 `{kind:'allow'|'deny'|'ask'}`。它返回别的东西时：
//
//   · 折成 `allow` ⇒ 一个坏掉的政策门**静默放行一切**（最坏的一种）；
//   · 折成 `ask`  ⇒ 一个坏掉的政策门变成**一个审批提示**——
//     而"因为读不懂所以请你批"这种提示，被橡皮图章批准的概率极高；
//   · 折成 `deny`  ⇒ 立刻可见、立刻有人修。
//
//   > 一个"读不懂就放行"的读数，与一个"读不懂就问人"的读数，
//   > 在汇总表里都很干脆——只不过前者让坏掉的政策门隐身，
//   > 后者把它伪装成一次正常的审批。
//
// 所以取 `deny`，并把**读到的那个值**放进理由（排障时第一眼就知道是谁坏了）。
// 同时单独计数 `innerMalformed`——"因为读不懂所以拒"与"政策门就是要拒"
// 必须分得开。
//
// ## ★ 第五条：**永不抛**，且失败一律 **fail closed**
//
// 桥在 `tool-request.mjs:802` 直接 `await decide(got.projection)`，
// **没有** try/catch。所以本模块抛出去会让整条 pre-execute 瀑布炸掉。
//
//   > 一个"靠宿主兜住异常"的判定端口，
//   > 与一个"每次 decide 出错都把整条强制面炸掉"的端口，是同一个东西——
//   > 只不过前者在别的宿主版本里才现形。
//
// 而且 `registry.decide` 自己会抛（`recordOutcome` 对未注册 id 抛；
// `decide` 在 `connectors` 非法时构造期就抛）。所以：
//   · resolver 抛 ⇒ 当作**认不出** ⇒ 交给 inner（不是 allow，也不是 deny）；
//   · `registry.decide` 抛 ⇒ **deny**（一个读不出来的连接器策略不是"放行"）。
//
// ## ★ 第六条：**不许**返回 `arguments`
//
// `tool-request.mjs:810-817` 明确：`pre-execute` 只允许**拒绝**、不允许**改写**，
// 一旦 `decision.arguments !== undefined` 就**拒绝当前调用**。所以本模块
// 只返回 `{kind, reason}`，把 `arguments` 从读到的决定里**丢掉**。
//
//   > 一个"把上游决定原样透传"的端口，
//   > 与一个"顺手把连接器层的字段带进强制面、于是每一次调用都被拒"的端口，
//   > 是同一个东西——只不过后者会让每一条都报"试图改写参数"。
//
// @module runtime/connectors/decision-port
// ============================================================================

export const CONNECTOR_DECISION_PORT_VERSION = 'legion/connector-decision-port@1'

/** 构造期的具名码。 */
export const CONNECTOR_DECISION_PORT_CODES = Object.freeze({
  /** 没给 registry，或者给的 registry 上没有 `decide`。 */
  NO_REGISTRY: 'connector-decision-no-registry',
  /** 没给 `resolveConnectorId`，或者它不是函数。 */
  NO_RESOLVE: 'connector-decision-no-resolve',
  /** 给了 `inner` 但它不是函数（也不为 null）。 */
  BAD_INNER: 'connector-decision-bad-inner',
  /** 给了 `connectorShape`，而它不是函数（2026-09-24 §5 第 23 条新增的谓词端口）。 */
  BAD_SHAPE: 'connector-decision-bad-shape',
})

/** 三个决定词。与 `registry.mjs` 的 `CONNECTOR_DECISIONS` 同一套。 */
export const DECISION_KINDS = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask',
})

/**
 * 严格度排名：**大的更严**。合并取最大值。
 *
 * `deny > ask > allow` —— 这不是随手排的：
 * `ask` 是"由人定"，而人**可以**批准；`deny` 是"机器已经定了不许"。
 * 若把 `ask` 排在 `deny` 之上，一次政策拒绝就会被"要不要问一下人"盖掉。
 */
export const DECISION_RANK = Object.freeze({ allow: 0, ask: 1, deny: 2 })

function portError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/**
 * 把**桥那一侧**的决定规范化。契约字段是 **`kind`**
 * （`plugins/pre-execute.mjs:11`：`{kind:'allow'} | {kind:'deny',reason} | {kind:'ask',reason?}`）。
 *
 * @returns {{kind: string, malformed: boolean, raw: unknown}}
 */
export function normalizeBridgeDecision(value) {
  return normalizeByField(value, 'kind')
}

/**
 * 把**注册表那一侧**的决定规范化。契约字段是 **`decision`**
 * （`registry.mjs:531` 的 `decide()` 返回 `{decision, code, connectorId, toolName, risk, reason}`）。
 *
 * ★★★ 同一个概念，两个字段名 —— 这个仓库里就摆着这么一对。
 * 第一版本模块两边都用 `kind` 读，于是**每一次**归属成功的调用都被读成
 * "读不懂 ⇒ deny"：连接器注册表会把**所有**工具调用拒掉。
 *
 *   > 一个"两边都用 `kind` 读"的端口，
 *   > 与一个"连接器一配上就把每一次调用都拒掉"的强制面，是同一个东西——
 *   > 只不过它的读数看起来像"连接器策略很严"。
 *
 * ★ 而它**是被用例当场抓到的**（①/①a/②/④/⑤a/⑥/⑩ 一批同时红），
 * 不是被复核出来的。所以这里刻意**分成两个函数**而不是写一个宽松的
 * "`kind` 或 `decision` 都收"——那样会把两个词汇表的差异**藏起来**，
 * 下一次换字段名时同样静默。
 */
export function normalizeRegistryDecision(value) {
  return normalizeByField(value, 'decision')
}

function normalizeByField(value, field) {
  const got = value !== null && typeof value === 'object' ? value[field] : undefined
  if (got === DECISION_KINDS.ALLOW || got === DECISION_KINDS.DENY || got === DECISION_KINDS.ASK) {
    return Object.freeze({ kind: got, malformed: false, raw: got })
  }
  // ★ 读不懂 ⇒ deny（见文件头第四条）。`raw` 带着原值，供理由里写出来。
  return Object.freeze({
    kind: DECISION_KINDS.DENY,
    malformed: true,
    raw: value === null
      ? null
      : (typeof value === 'object'
        ? (got === undefined ? `(缺少 ${field} 字段)` : got)
        : typeof value),
  })
}

/**
 * 合并两侧的决定，**取更严的那个**（见文件头第一、二条）。
 *
 * @param {string} outerKind 连接器层的 `kind`
 * @param {string} innerKind 政策门的 `kind`
 * @returns {string}
 */
export function mergeDecisions(outerKind, innerKind) {
  const o = DECISION_RANK[outerKind]
  const i = DECISION_RANK[innerKind]
  if (o === undefined || i === undefined) {
    // ★ 两侧都**先**规范化过才走到这里；真走到这里说明规范化漏了。
    //   取 deny：一个"合并函数自己读不懂"的状态不许变成一个放行。
    return DECISION_KINDS.DENY
  }
  return o >= i ? outerKind : innerKind
}

/**
 * 造一个可以交给 `createEnforcementBridge({ decide })` 的判定端口。
 *
 * @param {object} input
 * @param {{decide: Function}} input.registry  `createRegistry()` 的产物。
 * @param {(projection: object) => (string|null|undefined)} input.resolveConnectorId
 *   这次调用属于哪一条连接器。返回 `null` / `undefined` / 空串 ⇒ **认不出**
 *   ⇒ 不插话，原样交给 `inner`（见文件头）。
 * @param {(projection: object) => (object|Promise<object>)|null} [input.inner=null]
 *   **政策门**（`root.mjs` 的 `input.decide`）。不给则只有连接器层的意见。
 * @param {(receipt: object) => void} [input.onDecision=null] 观测点，**不参与判定**。
 * @returns {(projection: object) => Promise<{kind: string, reason: string|null}>}
 */
export function createConnectorDecisionPort({
  registry,
  resolveConnectorId,
  connectorShape = null,
  inner = null,
  onDecision = null,
} = {}) {
  if (registry === null || typeof registry?.decide !== 'function') {
    throw portError(
      CONNECTOR_DECISION_PORT_CODES.NO_REGISTRY,
      'createConnectorDecisionPort 需要 registry（且必须有 decide 方法）。' +
      '**不给就是"连接器策略从来不生效"，而不是"没有连接器"**——' +
      '后者应当由调用方传一个空的 registry，让每一次判定都留下 UNKNOWN_CONNECTOR 的痕迹。',
    )
  }
  if (typeof resolveConnectorId !== 'function') {
    throw portError(
      CONNECTOR_DECISION_PORT_CODES.NO_RESOLVE,
      'createConnectorDecisionPort 需要 resolveConnectorId(projection)。' +
      '没有它就认不出"这次调用属于哪一条连接器"，而**猜一个**会让别人的策略管到你头上。',
    )
  }
  if (connectorShape !== null && typeof connectorShape !== 'function') {
    throw portError(
      CONNECTOR_DECISION_PORT_CODES.BAD_SHAPE,
      `connectorShape（2026-09-24 §5 第 23 条新增的谓词端口）必须是函数或 null，收到 `
      + `${connectorShape === null ? "null" : typeof connectorShape}`,
    )
  }
  if (inner !== null && typeof inner !== 'function') {
    throw portError(
      CONNECTOR_DECISION_PORT_CODES.BAD_INNER,
      `inner（政策门）必须是函数或 null，收到 ${inner === null ? 'null' : typeof inner}`,
    )
  }

  const counters = {
    seen: 0,
    /** 认出了连接器 ⇒ 连接器层真的参与了判定。 */
    attributed: 0,
    /** 认不出 ⇒ 原样交给 inner（**不是**放行）。 */
    unattributed: 0,
    /**
     * ★★★ **连接器形状、而命名空间不认识** ⇒ 已按 `deny` 具名拒掉（§5 第 23 条）。
     * ★ 它**不算** `unattributed`：这一条恰恰是"认出了它的形状、但登记表里没有
     *   这个命名空间"——记成"认不出"会让这条新端口在读数上与政策门兜底长得一样。
     */
    namespaceUnknown: 0,
    /** resolver 自己抛了 ⇒ 与"认不出"同一条路（见文件头第五条）。 */
    resolveFailed: 0,
    /** `connectorShape` 自己抛了 ⇒ 当作"不是连接器形状"（与 resolver 抛同一条路）。 */
    shapeFailed: 0,
    /** `registry.decide` 抛了 ⇒ 已按 `deny` 兜住。 */
    registryFailed: 0,
    /** inner 抛了 ⇒ 已按 `deny` 兜住。 */
    innerFailed: 0,
    /** inner 返回了三个词以外的东西 ⇒ 已按 `deny` 兜住，见文件头第四条。 */
    innerMalformed: 0,
    outerDeny: 0,
    outerAsk: 0,
    outerAllow: 0,
    innerDeny: 0,
    innerAsk: 0,
    innerAllow: 0,
    /** 合并后**更严的那一侧**是连接器层 ⇒ 连接器策略真的改了结果。 */
    connectorDecided: 0,
    /** 合并后更严的那一侧是 inner（或两侧相同）。 */
    innerDecided: 0,
  }

  function note(receipt) {
    try {
      onDecision?.(receipt)
    } catch {
      // 观测点自己的异常**不许**影响判定（它与判定不是一件事）。
    }
  }

  /** 只把三个词与一句话交出去：**丢掉** `arguments` 等一切上游字段（见文件头第六条）。 */
  function verdict(kind, reason) {
    return Object.freeze({ kind, reason: reason === null ? null : String(reason) })
  }

  /** 算政策门那一侧。抛 ⇒ deny 兜住，并单独计数。 */
  async function innerSide(projection) {
    if (inner === null) {
      // 没有政策门 ⇒ 这一侧**没有意见**。用 allow 参与格运算：它不会盖掉任何东西。
      return { kind: DECISION_KINDS.ALLOW, reason: null, failed: false }
    }
    try {
      const got = await inner(projection)
      const n = normalizeBridgeDecision(got)
      if (n.malformed) {
        counters.innerMalformed += 1
        // ★★★ 读不懂时**必须把读到的原值写进理由**。
        //
        //   第一版这里是 `got?.reason ?? null`：垃圾值上取不到 `reason`
        //   （或取到一个与本次故障无关的字符串），于是理由退化成调用处那句
        //   "政策门的判定是 deny"——**排障的人看不出是谁坏了**。
        //
        //     > 一个"读不懂就拒"但**不说读到了什么**的端口，
        //     > 与一个"读不懂就拒、且下一个接手的人只能靠猜"的端口，
        //     > 在"它确实拒绝了"这个读数上是同一个东西。
        const shown = typeof n.raw === 'string' ? `"${n.raw}"` : String(n.raw)
        return {
          kind: DECISION_KINDS.DENY,
          reason: `政策门返回了读不懂的决定（${shown}，既不是 allow / deny / ask），已按拒绝兜住`,
          failed: false,
          malformed: true,
          raw: n.raw,
        }
      }
      return { kind: n.kind, reason: got?.reason ?? null, failed: false, malformed: false, raw: n.raw }
    } catch (err) {
      counters.innerFailed += 1
      return {
        kind: DECISION_KINDS.DENY,
        reason: `政策门抛错，已按拒绝兜住：${err?.message ?? String(err)}`,
        failed: true,
      }
    }
  }

  async function decide(projection) {
    counters.seen += 1

    // ① 认这是哪一条连接器。★ 抛与认不出走同一条路：都不插话（见文件头第五条）。
    let connectorId = null
    try {
      const resolved = resolveConnectorId(projection)
      if (typeof resolved === 'string' && resolved.trim() !== '') connectorId = resolved.trim()
    } catch (err) {
      counters.resolveFailed += 1
      note({ kind: 'resolve-failed', why: err?.message ?? String(err), connectorId: null })
      connectorId = null
    }

    // ①b ★★★ 2026-09-24 业主裁决（§5 第 23 条采 ①）：**连接器形状、而命名空间不认识**
    //     ⇒ **具名拒绝**。落点是新加的 `connectorShape` **谓词**端口 ——
    //     `resolveConnectorId` 的值域是 `string|null`，装不下"拒"，
    //     所以在这条裁决之前，`mcp__evil__x`（一个没有任何已声明连接器占着的
    //     MCP 命名空间）**只能落给政策门**。
    //
    //     为什么"落给政策门"不等价于拒绝：政策门把它读成**未知工具**
    //     （`tool-capability.mjs`：`critical` + `requiresApproval: true`），
    //     而"要人批"是**可以被批的** ⇒ 一个没登记过的 MCP 服务器，只要有人点一次
    //     "批准"就能用。教义（`registry.mjs` 文件头①「未声明的工具必须拒绝」）
    //     在这一类名字上是**空的**。
    //
    //     > 一个"把未登记的 MCP 服务器交给审批"的接线，
    //     > 与一个"未登记的 MCP 服务器只要有人点一下就能用"的实现，
    //     > 在同一次调用的读数上是同一个 `ask` —— 只不过前者看起来像
    //     > 已经把它拦在门外了。
    //
    //     ★ 判据是**形状**而不是"拆命名空间"：`public-name.mjs` 文件头 ③ 逐字写着
    //     `mcp__a__b__tool` 的命名空间是 `a` 还是 `a__b` **不可判**，
    //     所以谓词只回答"它是不是 MCP 公开名形状 / 有没有已知命名空间与它匹配"，
    //     **绝不**按 `__` 拆名字（拆错会让拒绝指向一个不存在的连接器）。
    if (connectorId === null && typeof connectorShape === 'function') {
      let shape = null
      try {
        shape = connectorShape(projection)
      } catch (err) {
        counters.shapeFailed += 1
        note({ kind: 'shape-failed', why: err?.message ?? String(err), connectorId: null })
      }
      if (shape?.shaped === true) {
        counters.namespaceUnknown += 1
        const name = projection?.toolName ?? projection?.subject?.toolName ?? ''
        note({ kind: 'namespace-unknown', toolName: String(name), connectorId: null })
        return verdict(
          DECISION_KINDS.DENY,
          '工具名 ' + JSON.stringify(String(name)) + ' 是**连接器形状**（MCP 公开名 '
          + `mcp__<命名空间>__<工具>` + (shape.namespaceKnown === true
            ? '）而**它的命名空间已经声明过**、' + `resolveConnectorId` + ' 却没认出它'
              + '（接线不一致） ⇒ 拒绝。'
            : '）而**没有任何已声明连接器的命名空间与它匹配** ⇒ 拒绝。')
          + '★ 理由在**登记表**这一侧，不在政策门：政策门只会把它读成"未知工具"，'
          + '而未知工具是**可以被人批准**的 —— 于是一个没登记过的 MCP 服务器'
          + '只要有人点一次"批准"就能用。'
          + '⇒ 要么把这条连接器登记进声明表，要么检查 DSH 插件配置里的 serverName '
          + '与 Legion 的 connectorId 是否**逐字相同**（这是部署契约，本仓无法验证）',
        )
      }
    }

    // ② 认不出 ⇒ **不插话**，原样交给政策门。
    //
    //    ★ 这一步返回的必须**就是** inner 的原话。写成 `{kind:'allow'}` 会是
    //      "因为它不是连接器调用，所以整条链放行"——那正是第一条那个短路。
    if (connectorId === null) {
      counters.unattributed += 1
      const i = await innerSide(projection)
      if (i.kind === DECISION_KINDS.DENY) counters.innerDeny += 1
      else if (i.kind === DECISION_KINDS.ASK) counters.innerAsk += 1
      else counters.innerAllow += 1
      counters.innerDecided += 1
      note({ kind: 'unattributed', inner: i.kind, connectorId: null })
      return verdict(i.kind, i.reason)
    }
    counters.attributed += 1

    // ③ 连接器层判定。★ 抛 ⇒ deny（一个读不出来的连接器策略不是"放行"）。
    let outer = null
    try {
      const toolName = projection?.toolName ?? projection?.subject?.toolName ?? ''
      outer = registry.decide({ connectorId, toolName, toolRisk: null })
    } catch (err) {
      counters.registryFailed += 1
      note({ kind: 'registry-failed', why: err?.message ?? String(err), connectorId })
      return verdict(
        DECISION_KINDS.DENY,
        `连接器策略判定失败，已按拒绝兜住（${err?.code ?? ''}${err?.message ? `: ${err.message}` : ''}` +
        `${err?.code || err?.message ? '' : String(err)}）`,
      )
    }
    const o = normalizeRegistryDecision(outer)
    if (o.kind === DECISION_KINDS.DENY) counters.outerDeny += 1
    else if (o.kind === DECISION_KINDS.ASK) counters.outerAsk += 1
    else counters.outerAllow += 1

    // ④ **两侧都要算**（见文件头第二条）：即使连接器层已经 deny / ask，
    //    政策门那一侧仍要跑——不是为了改结论（取严之后它改不了），
    //    而是为了让"政策门到底说了什么"留在读数里。少算这一侧，
    //    "政策门是 deny 而连接器层是 ask"这种组合就永远看不见。
    const i = await innerSide(projection)
    if (i.kind === DECISION_KINDS.DENY) counters.innerDeny += 1
    else if (i.kind === DECISION_KINDS.ASK) counters.innerAsk += 1
    else counters.innerAllow += 1

    const merged = mergeDecisions(o.kind, i.kind)

    // ⑤ 更严的那一侧是谁？——这是"连接器策略有没有真的起作用"的**唯一**读数。
    if (DECISION_RANK[o.kind] > DECISION_RANK[i.kind]) counters.connectorDecided += 1
    else counters.innerDecided += 1

    // ⑥ 理由：**说出来的是更严的那一侧**。取严却报宽松那一侧的理由，
    //    会让读日志的人以为拦截来自政策门。
    const stricter = DECISION_RANK[o.kind] >= DECISION_RANK[i.kind] ? 'connector' : 'policy'
    const reason = stricter === 'connector'
      ? (outer?.reason ?? o.raw ?? null)
      : (i.reason ?? null)
    const reasonText = reason === null
      ? (stricter === 'connector' ? `连接器 ${connectorId} 的判定是 ${o.kind}` : `政策门的判定是 ${i.kind}`)
      : (stricter === 'connector' ? `[连接器 ${connectorId}] ${reason}` : `[政策门] ${reason}`)

    note({
      kind: 'decided',
      connectorId,
      outer: o.kind,
      inner: i.kind,
      merged,
      stricter,
      probe: outer?.probe === true,
    })
    return verdict(merged, reasonText)
  }

  // ★ 诊断用（**不可枚举**）：与 `createOutcomeListener` 同一条理由——
  //   让"实际闭包到了什么、实际判成了什么"可被断言。
  //   不可枚举：这是**活对象**，不该被 `JSON.stringify` 带出去。
  Object.defineProperty(decide, 'receipts', {
    value: () => Object.freeze({ ...counters, version: CONNECTOR_DECISION_PORT_VERSION }),
    enumerable: false,
  })
  Object.defineProperty(decide, 'registry', { value: registry, enumerable: false })
  Object.defineProperty(decide, 'inner', { value: inner, enumerable: false })

  return decide
}

// runtime/connectors/registry.mjs
// ============================================================================
// F-21 MCP / Connector Registry（spec §4.4）：
//
//   「server/tool 级策略、风险等级、SecretStore 和故障隔离。」
//
// 四件事，每一件都有一个"看起来能用、其实在撒谎"的写法：
//
// ---------------------------------------------------------------------------
// ★ ① 未声明的工具**必须拒绝**，而不是"不知道所以放行"
//
// 连接器是**外部**的：对方可以在它那一侧加一个工具，而控制面毫不知情。
// 于是最自然的写法
//
//     if (declared === undefined) return 'allow'   // 没见过，交给下游判断
//
// 的含义其实是"只要有人往 MCP server 上加一个工具，它自动获得授权"。
//
//   > 一个「没见过就放行」的登记表，
//   > 与一个「任何人在外部加一个工具就等于加一个后门」的登记表，
//   > 是同一个东西——只不过前者的代码看起来只是"不拦而已"。
//
// 所以本模块的方向恒为：**没被显式声明过的，一律拒绝**。
//
// ---------------------------------------------------------------------------
// ★ ② 风险只能往上抬，永远不能往下压
//
// 这与 `runtime/dsh-composition/tool-capability.mjs` 是同一条纪律（那里用
// `maxRisk` 实现）。一个连接器作者填 `declaredRisk: 'low'`，而它声明的能力
// 蕴含 `critical`（比如有外部副作用且不可撤销）时，生效值是 `critical`。
//
//   > 一个「作者说了算」的风险等级，
//   > 与一个「把最危险的那个工具标成 low 就全放行了」的登记表，是同一个东西。
//
// 另外：**不认识的风险等级不猜**。填了 `'moderate'`（不在词表里）时报错，
// 而不是当成 low、也不是当成 critical——猜两次都错的那种。
//
// ---------------------------------------------------------------------------
// ★ ③ 密钥只许"引用"，且引用必须能对上号
//
// 登记表会被导出、提交进 Git、贴进工单。所以它在**结构上**不能装下凭证值。
// 这一条在 F-19 的岗位包上已经做过一次（`FORBIDDEN_CONNECTOR_KEYS`）。
//
// 这一层额外做一件事：**引用要对得上号**。`secretRefs` 里写了一个
// SecretStore 里不存在的名字时要说出来，因为
//
//   > 一个「指向不存在的密钥」的引用，
//   > 与一个「密钥值恰好是空字符串」的引用，在调用时表现得一模一样——
//   > 而只有一个是可以修的。
//
// ---------------------------------------------------------------------------
// ★ ④ 故障隔离：熔断，且**开路必须有截止时间**
//
// 熔断器最容易写错的三处，每一处都写在对应代码旁边：
//   · 开路没有 `untilMs` ⇒ 一次临时故障变成**永久**停用，而它看起来是临时的
//   · 半开时放**所有**排队请求过去 ⇒ 探针那一步本身就是在打你正在保护的东西
//   · 一个连接器失败时**顺带**把别的标记成不健康 ⇒ 隔离失效，
//     而"隔离"正是这一节的标题
//
// 还有一条与全篇一致的：**没探过的健康状态是 `unknown`，不是 `healthy`**。
// ============================================================================

import { CAPABILITY_IDS, CAPABILITY_KINDS, RISK_RANK, riskFloorOf, maxRisk } from '../dsh-composition/tool-capability.mjs'

/** 登记表的形态版本。 */
export const CONNECTOR_REGISTRY_VERSION = 'legion/connector-registry@1'

/** 传输方式，封闭词表（与参考实现的 `mcp.yaml` 一致）。 */
export const CONNECTOR_TRANSPORTS = Object.freeze(['stdio', 'http', 'sse'])

/**
 * 策略判定结果，**封闭词表**。
 *
 * 只有三种。**刻意没有 `allow-*` 那一族**：那些是 F-10 在"一次具体调用"上
 * 的一次性状态（已经批过这一次），而登记表回答的是"这个工具属不属于这一类"。
 * 把两者混在一张表里，一次性批准就会变成永久策略。
 */
export const CONNECTOR_DECISIONS = Object.freeze(['allow', 'deny', 'ask'])

/** 熔断器状态，**封闭词表**。 */
export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half-open'])

export const CONNECTOR_CODES = Object.freeze({
  BAD_DECLARATION: 'connector-declaration-malformed',
  BAD_ID: 'connector-id-malformed',
  BAD_TRANSPORT: 'connector-transport-unknown',
  BAD_TRANSPORT_TARGET: 'connector-transport-target-missing',
  BAD_POLICY: 'connector-policy-unknown',
  BAD_RISK: 'connector-risk-unknown',
  NO_TOOLS: 'connector-no-declared-tools',
  BAD_CAPABILITY: 'connector-capability-unknown',
  TOOL_DUPLICATE: 'connector-tool-duplicate',
  UNKNOWN_TOOL: 'connector-tool-not-declared',
  UNKNOWN_CONNECTOR: 'connector-not-registered',
  SECRET_VALUE_INLINE: 'connector-secret-inline-value',
  SECRET_REF_MISSING: 'connector-secret-ref-missing',
  WILDCARD_TOOL: 'connector-tool-wildcard',
  CIRCUIT_OPEN: 'connector-circuit-open',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 不许出现在登记表里的键（凭证值）。
 *
 * 与 F-19 的 `FORBIDDEN_CONNECTOR_KEYS` 同源：登记表会被导出、提交进 Git、
 * 贴进工单，所以"凭证引用"与"凭证值"必须在**结构上**分开，而不是靠约定。
 */
export const FORBIDDEN_SECRET_KEYS = Object.freeze([
  'token', 'apikey', 'api_key', 'secret', 'password', 'passwd', 'credential',
  'credentials', 'clientsecret', 'client_secret', 'connectionstring',
  'connection_string', 'privatekey', 'private_key', 'authtoken', 'auth_token',
  'accesstoken', 'access_token', 'bearertoken', 'bearer_token',
])

/**
 * 工具名里的通配符。
 *
 * 与 `employee-manifest.mjs` 的 `assertNoWildcard` 同一条理由：
 * `'*'` 与"我认真列了每一条"在**判定结果**上完全一样，只在出事后才分得开。
 */
const WILDCARD_TOOL_NAMES = Object.freeze(['*', '**', 'any', 'all', 'everything'])

/** 一个工具声明。 */
function declareTool({ connectorId, tool }) {
  if (!isPlainObject(tool)) {
    throw fail(CONNECTOR_CODES.BAD_DECLARATION, `连接器 ${connectorId} 的工具声明必须是一个对象`)
  }
  const name = String(tool.name ?? '').trim()
  if (name === '') {
    throw fail(CONNECTOR_CODES.BAD_DECLARATION, `连接器 ${connectorId} 有一个工具没有 name`)
  }
  if (WILDCARD_TOOL_NAMES.includes(name.toLowerCase())) {
    throw fail(
      CONNECTOR_CODES.WILDCARD_TOOL,
      `连接器 ${connectorId} 的工具名是通配符 ${JSON.stringify(name)}。` +
      '*' + ` 与"我认真列了每一条"在判定结果上完全一样，只在出事后才分得开——` +
      '所以列出一条条真名，而不是一条能覆盖所有东西的',
    )
  }
  // ★ 能力必须显式声明：与 `describeTool` 一致，"没有能力"与"能力未知"
  //   在登记表上长得一样，而后者必须按最严处理。
  const raw = Array.isArray(tool.capabilities) ? tool.capabilities : []
  if (raw.length === 0) {
    throw fail(
      CONNECTOR_CODES.BAD_DECLARATION,
      `连接器 ${connectorId} 的工具「${name}」没有声明任何 capabilities。` +
      '一个"没有能力"的工具与一个"能力未知"的工具在登记表上长得一样，' +
      '而后者必须按最严处理',
    )
  }
  const declaredRisk = tool.declaredRisk === undefined || tool.declaredRisk === null
    ? null
    : String(tool.declaredRisk)
  if (declaredRisk !== null && RISK_RANK[declaredRisk] === undefined) {
    throw fail(
      CONNECTOR_CODES.BAD_RISK,
      `连接器 ${connectorId} 的工具「${name}」填了不认识的风险等级 ` +
      `${JSON.stringify(declaredRisk)}（已知：${Object.keys(RISK_RANK).join(' / ')}）。` +
      '**不猜**：当成 low 会放行，当成 critical 会让它永远动不了，两种猜法都会错',
    )
  }

  const capabilities = Object.freeze([...new Set(raw.map((c) => String(c).trim()))])
  // ★ 不认识的能力**在这里就拒**，而不是交给 `riskFloorOf` 兜底。
  //
  //   `riskFloorOf` 对不认识的能力会给出最严的下限（`critical`）——那看起来
  //   很安全，实际上是**最坏的一种处理**：连接器的每个工具都变成 critical，
  //   于是每一次调用都要人批，而**没有任何一处报错指出原因是拼错了能力名**。
  //   作者会看到"这个连接器怎么什么都要批"，然后去查权限配置——
  //   查一个根本没问题的东西。
  //
  //   > 一个「把拼错的能力名兜底成最严」的登记表，
  //   > 与一个「整个连接器莫名其妙全要人批」的登记表，是同一个东西——
  //   > 只不过前者的兜底逻辑看起来是负责任的安全实践。
  //
  //   既有约定也是拒（`tool-capability.mjs` 的 `describeTool` → `UNKNOWN_CAPABILITY`）。
  for (const id of capabilities) {
    if (CAPABILITY_KINDS[id] === undefined) {
      throw fail(
        CONNECTOR_CODES.BAD_CAPABILITY,
        `连接器 ${connectorId} 的工具「${name}」声明了不认识的能力 ${JSON.stringify(id)}。` +
        `已知的是：${CAPABILITY_IDS.join(', ')}。` +
        '**不兜底成最严**：那样整个连接器会莫名其妙全要人批，' +
        '而没有任何一处报错指出原因是能力名拼错了',
      )
    }
  }
  // ★ 只能往上抬（见文件头 ②）。
  const floor = riskFloorOf(capabilities)
  const effective = declaredRisk === null ? floor : maxRisk(declaredRisk, floor)
  const riskRaised = declaredRisk !== null && RISK_RANK[declaredRisk] < RISK_RANK[floor]

  const policy = String(tool.policy ?? 'allow').trim()
  if (!CONNECTOR_DECISIONS.includes(policy)) {
    throw fail(
      CONNECTOR_CODES.BAD_POLICY,
      `连接器 ${connectorId} 的工具「${name}」的策略 ${JSON.stringify(tool.policy)} ` +
      `不在词表里（${CONNECTOR_DECISIONS.join(' / ')}）`,
    )
  }

  return Object.freeze({
    name,
    capabilities,
    declaredRisk,
    risk: effective,
    riskFloor: floor,
    /** 作者填的建议值被抬高了——留痕，供自检报出来。 */
    riskRaised,
    policy,
  })
}

/**
 * 声明一个连接器（MCP server）。
 *
 * 返回冻结的声明对象。**校验全在这里**：未声明的工具在判定阶段会被拒，
 * 所以这里的每一条拒绝都是"少一个后门"。
 */
export function declareConnector(input = {}) {
  if (!isPlainObject(input)) {
    throw fail(CONNECTOR_CODES.BAD_DECLARATION, 'declareConnector 需要一个声明对象')
  }
  const {
    connectorId, transport, command = null, url = null,
    tools, secretRefs = [], policy = 'allow', description = null,
  } = input
  const id = String(connectorId ?? '').trim()
  if (id === '') {
    throw fail(CONNECTOR_CODES.BAD_ID, '连接器必须有 connectorId')
  }
  // id 进日志、进指标、进 URL，所以限制成安全字符：
  // 一个带 `/` 或空格的 id 会在某一层被静默改写，而那时"这条日志说的是谁"就答不上来。
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw fail(
      CONNECTOR_CODES.BAD_ID,
      `连接器 id ${JSON.stringify(id)} 只能包含字母、数字、点、下划线与减号。` +
      '它要进日志、指标与 URL，含分隔符的 id 会在某一层被静默改写',
    )
  }
  const tp = String(transport ?? '').trim()
  if (!CONNECTOR_TRANSPORTS.includes(tp)) {
    throw fail(
      CONNECTOR_CODES.BAD_TRANSPORT,
      `连接器 ${id} 的 transport ${JSON.stringify(transport)} 不在词表里（${CONNECTOR_TRANSPORTS.join(' / ')}）`,
    )
  }
  // 传输方式与目标必须配套：stdio 要 command，http/sse 要 url。
  // 缺一个时连接器会"注册成功但永远连不上"，而那与"连上了但没有工具"是两件事。
  if (tp === 'stdio' && String(command ?? '').trim() === '') {
    throw fail(CONNECTOR_CODES.BAD_TRANSPORT_TARGET, `连接器 ${id} 的 transport 是 stdio，必须给 command`)
  }
  if (tp !== 'stdio' && String(url ?? '').trim() === '') {
    throw fail(CONNECTOR_CODES.BAD_TRANSPORT_TARGET, `连接器 ${id} 的 transport 是 ${tp}，必须给 url`)
  }

  if (!Array.isArray(tools) || tools.length === 0) {
    // ★ 一个"没有工具"的连接器与一个"工具列表没读到"的连接器长得一样。
    //   前者没有意义，后者必须报警，所以直接拒绝。
    throw fail(
      CONNECTOR_CODES.NO_TOOLS,
      `连接器 ${id} 没有声明任何工具。一个"没有工具"的连接器与一个` +
      '"工具列表没读到"的连接器长得一样，而后者必须报警',
    )
  }
  const declared = tools.map((t) => declareTool({ connectorId: id, tool: t }))
  const names = declared.map((t) => t.name)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length > 0) {
    throw fail(
      CONNECTOR_CODES.TOOL_DUPLICATE,
      `连接器 ${id} 重复声明了工具 ${JSON.stringify([...new Set(dup)])}。` +
      '重复时后一条会**遮蔽**前一条，于是先写那条的 capabilities 与策略变成死配置',
    )
  }

  const serverPolicy = String(policy ?? 'allow').trim()
  if (!CONNECTOR_DECISIONS.includes(serverPolicy)) {
    throw fail(
      CONNECTOR_CODES.BAD_POLICY,
      `连接器 ${id} 的 server 级策略 ${JSON.stringify(policy)} 不在词表里`,
    )
  }

  // ★ 凭证值不许出现在声明里（见文件头 ③）。
  //
  // ★ 检查的是**整个入参**，不是我们解构出来的那几个字段。
  //   最初写的是 `assertNoInlineSecret({ value: { command, url, description } })`
  //   ——于是 `declareConnector({ ..., token: 'ghp_abc123' })` 里那个 `token`
  //   被解构**丢掉**、从未被检查过，用例当场抓到了它。
  //
  //   这一条的失败模式很具体：今天那个多出来的键被静默忽略，看起来无害；
  //   而某天有人"支持一下 token 直填"把它加进解构列表时，它就变成一条
  //   从来没有被任何检查拦过的凭证通道——**拦它的那个检查一直只看着
  //   command/url/description 三个字段**。
  //
  //   > 一个「只检查自己认识的那几个字段」的凭证检查，
  //   > 与一个「对没见过的字段完全无感」的检查，是同一个东西——
  //   > 只不过前者看起来在守着一道门。
  assertNoInlineSecret({ where: `连接器 ${id}`, value: input })

  const refs = (Array.isArray(secretRefs) ? secretRefs : []).map((r) => String(r).trim())
  if (refs.some((r) => r === '')) {
    throw fail(CONNECTOR_CODES.BAD_DECLARATION, `连接器 ${id} 的 secretRefs 里有空名字`)
  }

  return Object.freeze({
    version: CONNECTOR_REGISTRY_VERSION,
    connectorId: id,
    transport: tp,
    command: command === null ? null : String(command),
    url: url === null ? null : String(url),
    description: description === null ? null : String(description),
    policy: serverPolicy,
    tools: Object.freeze(declared),
    secretRefs: Object.freeze([...new Set(refs)]),
  })
}

/** 递归找凭证值。找到就抛——见文件头 ③。 */
function assertNoInlineSecret({ where, value, path = '$' }) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoInlineSecret({ where, value: v, path: `${path}[${i}]` }))
    return
  }
  if (!isPlainObject(value)) return
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).toLowerCase().replace(/[^a-z_]/g, '')
    if (FORBIDDEN_SECRET_KEYS.includes(key)) {
      throw fail(
        CONNECTOR_CODES.SECRET_VALUE_INLINE,
        `${where} 的 ${path}.${k} 像是在装凭证**值**。登记表会被导出、提交进 Git、` +
        '贴进工单，所以这里只许放**引用**（用 `secretRefs`）——' +
        '进了 Git 历史的东西删不掉',
      )
    }
    assertNoInlineSecret({ where, value: v, path: `${path}.${k}` })
  }
}

// ---------------------------------------------------------------------------
// 熔断器（故障隔离）
// ---------------------------------------------------------------------------

/** 连续失败多少次就开路。 */
export const CIRCUIT_FAILURE_THRESHOLD = 3
/** 开路之后等多久允许一次探针。 */
export const CIRCUIT_COOLDOWN_MS = 30_000

function freshCircuit() {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    /** 开路到什么时候（`state === 'open'` 时必有）。 */
    untilMs: null,
    openedAtMs: null,
    /** 半开时是否已经放过一次探针——见 `admit`。 */
    probeInFlight: false,
    /**
     * 那一次探针**什么时候**放出去的。
     *
     * ★★ 这个字段与 `untilMs` 是**同一条不变式**的两半（2026-09-18 补）：
     * `untilMs` 防的是"开路永远不结束"，它防的是"探针永远不回来"。
     *
     *   探针被 admit 成 `ask`（`:587`）而**没有任何结果回来**时
     *   （审批没批、调用没派发、进程在做别的事），`probeInFlight` 会一直是 `true`。
     *   而转半开之后 `state === 'open'` 那一支**再也不可达**，
     *   于是那个"开路带截止时间"的救援**永远进不去**——连接器被**永久**停用。
     *
     *   > 一个"探针出去了、结果永远不回来"的熔断器，
     *   > 与一个"这次调用确实该被拒绝"的熔断器，在 `decide()` 的读数上
     *   > 是同一个 `deny`——只不过前者的状态**再也不会变**，
     *   > 而它看起来在工作（它确实一直在拒绝）。
     *
     * 实测（`--probe-halfopen`）：冷却 30 s 之后第一次 ask 拿到探针，
     * 之后每再等 10 分钟都还是 `deny connector-circuit-open`，`state=half-open` 不变。
     */
    probeStartedAtMs: null,
    /** 从未探过 ⇒ `health === 'unknown'`，**不是** healthy。 */
    probed: false,
    lastOkAtMs: null,
    lastFailureAtMs: null,
    lastError: null,
  }
}

/**
 * 建一个登记表。
 *
 * `now` 可注入（测试与诊断用）。**没有**任何"从外部改策略"的接口——
 * 策略来自声明，声明是不可变的（见 `declareConnector` 的冻结返回值）。
 */
export function createRegistry({ connectors = [], now = () => Date.now(), resolveSecretRef = null } = {}) {
  if (!Array.isArray(connectors)) {
    throw fail(CONNECTOR_CODES.BAD_DECLARATION, 'connectors 必须是数组')
  }
  const byId = new Map()
  for (const c of connectors) {
    // 接受已经声明过的（`declareConnector` 的返回值）或原始输入。
    const decl = c?.version === CONNECTOR_REGISTRY_VERSION ? c : declareConnector(c)
    if (byId.has(decl.connectorId)) {
      throw fail(
        CONNECTOR_CODES.BAD_ID,
        `连接器 id ${decl.connectorId} 被声明了两次。重复时后一条会遮蔽前一条，` +
        '于是先写那条的策略与工具清单静默失效',
      )
    }
    byId.set(decl.connectorId, decl)
  }
  const circuits = new Map([...byId.keys()].map((id) => [id, freshCircuit()]))

  /**
   * 密钥引用是否对得上号（见文件头 ③）。
   *
   * 没传 `resolveSecretRef` 时**不假设**引用有效，也不假设无效——
   * 而是明说"这一层没查"，并把未知如实带出去。
   * 假设有效会把"密钥缺失"混进正常调用；假设无效会让每个连接器都不可用。
   */
  function checkSecretRefs(decl) {
    if (resolveSecretRef === null) {
      return Object.freeze({ checked: false, missing: Object.freeze([]), resolvable: null })
    }
    const missing = []
    for (const r of decl.secretRefs) {
      // ★ 解析器**只调一次**。调两次时，一个有状态的解析器
      //   （比如第一次查缓存、第二次查真源）会在两次之间给出不同答案，
      //   于是"这个引用到底缺不缺"取决于我们问了几遍。
      let ok
      try {
        ok = resolveSecretRef(r)
      } catch {
        // 解析器抛 ⇒ 按"拿不到"处理（fail closed）：把异常当成"有密钥"
        // 会让一次 SecretStore 故障静默地放行一批本该被拦下的调用。
        ok = false
      }
      if (ok !== true) missing.push(r)
    }
    return Object.freeze({ checked: true, missing: Object.freeze(missing), resolvable: missing.length === 0 })
  }

  const reg = {
    get version() { return CONNECTOR_REGISTRY_VERSION },

    /** 全部声明（冻结副本）。 */
    connectors() {
      return Object.freeze([...byId.values()])
    },

    /** 一个声明。不存在时 `null`（不是抛，也不是空壳）。 */
    connector(connectorId) {
      return byId.get(String(connectorId ?? '').trim()) ?? null
    },

    /** 全部已声明的工具名（`connectorId::tool`）。 */
    toolNames() {
      return Object.freeze([...byId.values()].flatMap(
        (c) => c.tools.map((t) => `${c.connectorId}::${t.name}`),
      ))
    },

    /** 某一个连接器的密钥引用状况。 */
    secretStatus(connectorId) {
      const decl = byId.get(String(connectorId ?? '').trim())
      if (decl === undefined) {
        throw fail(CONNECTOR_CODES.UNKNOWN_CONNECTOR, `连接器 ${connectorId} 未注册`)
      }
      return Object.freeze({ connectorId: decl.connectorId, refs: decl.secretRefs, ...checkSecretRefs(decl) })
    },

    /** 全部连接器的密钥引用状况（诊断用）。 */
    secretReport() {
      return Object.freeze([...byId.values()].map((d) => Object.freeze({
        connectorId: d.connectorId, refs: d.secretRefs, ...checkSecretRefs(d),
      })))
    },

    /**
     * 严格版：密钥引用对不上号就**抛**。
     *
     * 与上面那个"报告"版本的分工是刻意的：
     *   · `secretStatus` / `secretReport` 是**诊断**——它必须能在一批连接器
     *     里说出哪几个有问题，所以它不抛（抛了就只能报第一个）。
     *   · `assertSecretsResolvable` 是**闸门**——在真正要调用某个连接器之前
     *     用它，缺密钥就停下。
     *
     * 为什么闸门不能省：
     *   > 一个「指向不存在的密钥」的引用，
     *   > 与一个「密钥值恰好是空字符串」的引用，在调用时表现得一模一样——
     *   > 而只有一个是可以修的。
     *   没有这道闸门时，第二种会被当成连接器自己坏了，于是值班的人去查
     *   那个连接器（它没问题），而不是去补那个密钥。
     *
     * 没传 `resolveSecretRef` 时**不装作查过了**：这一层明说它不能判定，
     * 见 `checkSecretRefs`。所以这时它也不抛——因为"没查"不等于"缺"。
     */
    assertSecretsResolvable(connectorId) {
      const id = String(connectorId ?? '').trim()
      const decl = byId.get(id)
      if (decl === undefined) {
        throw fail(CONNECTOR_CODES.UNKNOWN_CONNECTOR, `连接器 ${id} 未注册`)
      }
      const status = checkSecretRefs(decl)
      if (status.checked && !status.resolvable) {
        throw fail(
          CONNECTOR_CODES.SECRET_REF_MISSING,
          `连接器 ${id} 的密钥引用拿不到：${JSON.stringify(status.missing)}。` +
          '**在调用之前停下**：这类失败如果放到调用里，会与"密钥值是空字符串"、' +
          '"连接器自己坏了"表现成同一件事，于是所有排查都会指向那个没问题的连接器',
        )
      }
      return status
    },

    /**
     * 判定一次调用。**这是本模块的核心**。
     *
     * 顺序是有意的，每一步都在挡一类具体的错：
     *   1. 连接器没注册 ⇒ 拒绝（不是"没有策略所以放行"）
     *   2. 工具没被这个连接器声明 ⇒ 拒绝（见文件头 ①）
     *   3. **工具级 deny 优先于 server 级 allow**（见下）
     *   4. 熔断开路 ⇒ 拒绝（而不是"再试一次"）
     *   5. 否则按风险决定 ask 还是 allow
     */
    decide({ connectorId, toolName, toolRisk = null } = {}) {
      const id = String(connectorId ?? '').trim()
      const decl = byId.get(id)
      if (decl === undefined) {
        return Object.freeze({
          decision: 'deny', code: CONNECTOR_CODES.UNKNOWN_CONNECTOR,
          connectorId: id, toolName: String(toolName ?? ''),
          risk: null, reason: `连接器 ${id} 未注册`,
        })
      }
      const name = String(toolName ?? '').trim()
      const tool = decl.tools.find((t) => t.name === name)
      if (tool === undefined) {
        // ★ 见文件头 ①：这里放行等于"对方加一个工具就等于加一个后门"。
        return Object.freeze({
          decision: 'deny', code: CONNECTOR_CODES.UNKNOWN_TOOL,
          connectorId: id, toolName: name, risk: null,
          reason: `连接器 ${id} 没有声明工具「${name}」。` +
            '**没见过就放行，等于任何人在外部加一个工具就等于加一个后门**',
        })
      }

      // ★ 工具级 deny **优先于** server 级 allow。
      //
      //   反过来写（"更具体的说了算"只在工具是 allow 时才看 server）时，
      //   一个人专门写下的那条 deny 会被 server 级的宽松默认静默盖掉——
      //   而他写那条 deny 正是为了拦住一样具体的东西。
      if (tool.policy === 'deny') {
        return Object.freeze({
          decision: 'deny', code: null, connectorId: id, toolName: name,
          risk: toolRisk === null ? tool.risk : maxRisk(tool.risk, toolRisk),
          reason: '工具级策略是 deny（工具级 deny 优先于 server 级策略）',
        })
      }
      if (decl.policy === 'deny') {
        return Object.freeze({
          decision: 'deny', code: null, connectorId: id, toolName: name,
          risk: toolRisk === null ? tool.risk : maxRisk(tool.risk, toolRisk),
          reason: `连接器 ${id} 的 server 级策略是 deny`,
        })
      }

      const risk = toolRisk === null ? tool.risk : maxRisk(tool.risk, toolRisk)

      // 熔断：开路期间一律拒绝。
      const circuit = circuits.get(id)
      const t = now()
      if (circuit.state === 'open') {
        if (circuit.untilMs !== null && t >= circuit.untilMs) {
          // 冷却到了 ⇒ 转半开，**只放一次**探针（见下面 `admit`）。
          circuit.state = 'half-open'
          circuit.probeInFlight = false
          circuit.probeStartedAtMs = null
        } else {
          return Object.freeze({
            decision: 'deny', code: CONNECTOR_CODES.CIRCUIT_OPEN,
            connectorId: id, toolName: name, risk,
            untilMs: circuit.untilMs,
            reason: `连接器 ${id} 的熔断器是开路的（到 ${circuit.untilMs}）。` +
              '**不重试**：开路本身就是"别再打了"的意思',
          })
        }
      }
      if (circuit.state === 'half-open') {
        if (circuit.probeInFlight) {
          // ★ 半开只放一个探针。
          //
          //   放所有排队请求过去时，探针这一步本身就在打你正在保护的那个东西
          //   ——而"熔断"的整个意义是减少对它的压力。
          //
          // ★★ 但"只放一个"**必须带一个期限**（2026-09-18 补，见 `probeStartedAtMs`）。
          //
          //   一个**永远不会回来**的探针（审批没批 / 没派发）与一个**正在飞**的探针，
          //   在 `probeInFlight` 上是同一个 `true`——于是这个 `return deny`
          //   会把连接器停到进程结束。而它不会有任何报错：它**一直在正常地拒绝**。
          //
          //   判据用**同一个冷却窗口**，不是新发明的一个数：
          //   一个 `CIRCUIT_COOLDOWN_MS` 之内回来的探针才有资格代表连接器；
          //   超过它的，我们**已经无法区分**"它还在飞"与"它丢了"，
          //   而在这两者之间继续拒绝是**赌**——赌一个可能永远不来的结果。
          //
          //   > 一个"等一个可能永远不来的结果"的熔断器，
          //   > 与一个"永久停用"的熔断器，是同一个东西——
          //   > 只不过前者每次被问到都答"正在探"。
          const probeAge = circuit.probeStartedAtMs === null ? null : t - circuit.probeStartedAtMs
          const probeLost = probeAge !== null && probeAge >= CIRCUIT_COOLDOWN_MS
          if (!probeLost) {
            return Object.freeze({
              decision: 'deny', code: CONNECTOR_CODES.CIRCUIT_OPEN,
              connectorId: id, toolName: name, risk, untilMs: circuit.untilMs,
              reason: '连接器正在半开探针中，只放一个探针过去',
            })
          }
          // 探针超期未归 ⇒ 当作丢了，**放一条新的**（下面共用同一段 admit）。
        }
        circuit.probeInFlight = true
        circuit.probeStartedAtMs = t
        return Object.freeze({
          decision: 'ask', code: null, connectorId: id, toolName: name, risk,
          probe: true,
          reason: '半开探针：这次调用用来判断连接器是否恢复',
        })
      }

      // 高风险一律要问人（与 `tool-capability` 的 `requiresApproval` 同源）。
      const needsHuman = RISK_RANK[risk] >= RISK_RANK.high
      return Object.freeze({
        decision: tool.policy === 'ask' || decl.policy === 'ask' || needsHuman ? 'ask' : 'allow',
        code: null, connectorId: id, toolName: name, risk,
        reason: needsHuman
          ? `风险等级 ${risk} ≥ high，要人批`
          : (tool.policy === 'ask' || decl.policy === 'ask' ? '策略是 ask' : '策略是 allow 且风险低于 high'),
      })
    },

    /**
     * 登记一次调用的结果。熔断**只**根据这一个连接器的结果推进。
     */
    recordOutcome({ connectorId, ok, error = null, atMs = null } = {}) {
      const id = String(connectorId ?? '').trim()
      const circuit = circuits.get(id)
      if (circuit === undefined) {
        throw fail(CONNECTOR_CODES.UNKNOWN_CONNECTOR, `连接器 ${id} 未注册`)
      }
      const t = atMs ?? now()
      if (ok) {
        circuit.probed = true
        circuit.lastOkAtMs = t
        circuit.consecutiveFailures = 0
        circuit.probeInFlight = false
        circuit.probeStartedAtMs = null
        circuit.untilMs = null
        circuit.openedAtMs = null
        circuit.state = 'closed'
        circuit.lastError = null
      } else {
        circuit.probed = true
        circuit.lastFailureAtMs = t
        circuit.lastError = error === null ? null : String(error)
        circuit.probeInFlight = false
        circuit.probeStartedAtMs = null
        circuit.consecutiveFailures += 1
        // 半开探针失败 ⇒ **立刻**回到开路并重新计时。
        // 不重新计时的话，冷却窗口会随着每次失败被"用掉"，
        // 于是探针会越来越密——正好与熔断的目的相反。
        if (circuit.state === 'half-open' || circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
          circuit.state = 'open'
          circuit.openedAtMs = t
          // ★ 开路**必须**带截止时间。
          //
          //   不带时，一次临时故障会把连接器**永久**停用——
          //   而"永久停用"与"临时熔断"在状态读数上长得一样，
          //   值班的人会一直等一个永远不会到来的恢复。
          circuit.untilMs = t + CIRCUIT_COOLDOWN_MS
        }
      }
      return Object.freeze({ ...circuit })
    },

    /** 一个连接器的熔断状态。 */
    circuit(connectorId) {
      const id = String(connectorId ?? '').trim()
      const c = circuits.get(id)
      if (c === undefined) {
        throw fail(CONNECTOR_CODES.UNKNOWN_CONNECTOR, `连接器 ${id} 未注册`)
      }
      return Object.freeze({ connectorId: id, ...c })
    },

    /**
     * 健康读数。
     *
     * ★ `unknown`（一次都没探过）**不是** healthy。两者在监控面板上
     *   一模一样，而"这个连接器从没成功过"与"这个连接器一直很好"是
     *   完全相反的两件事。
     *
     * ★★ `health` 与 `circuit` 是**两个不同的读数**，不能互相推导。
     *   最初写成 `circuit === 'closed' ? 'healthy' : 'unhealthy'`，
     *   于是**一个刚刚失败的连接器报 `healthy`**——因为熔断要连续失败
     *   三次才跳闸，而前两次失败时 circuit 还是 `closed`。用例抓到了它。
     *
     *   > 一个「刚失败过、但因为还没到阈值所以报健康」的连接器，
     *   > 与一个「一直很好」的连接器，在监控面板上是同一个绿点。
     *
     *   所以：`circuit` 回答"现在还放不放调用过去"，`health` 回答
     *   "最近观察到的状态好不好"。任何一次连续失败都算 unhealthy，
     *   哪怕熔断还没跳闸。
     */
    health() {
      const rows = [...byId.keys()].map((id) => {
        const c = circuits.get(id)
        const state = !c.probed
          ? 'unknown'
          : (c.consecutiveFailures > 0 ? 'unhealthy' : 'healthy')
        return Object.freeze({
          connectorId: id,
          health: state,
          // 单独给出：它回答的是"还放不放调用过去"，与 health 不同。
          circuit: c.state,
          consecutiveFailures: c.consecutiveFailures,
          lastOkAtMs: c.lastOkAtMs,
          lastFailureAtMs: c.lastFailureAtMs,
          lastError: c.lastError,
          untilMs: c.untilMs,
        })
      })
      const counts = { healthy: 0, unhealthy: 0, unknown: 0 }
      for (const r of rows) counts[r.health] += 1
      return Object.freeze({
        connectors: Object.freeze(rows),
        counts: Object.freeze(counts),
        // ★ 只要有一个 unknown，整体就**不能**报"全部健康"。
        allHealthy: counts.unhealthy === 0 && counts.unknown === 0,
        // ★ 故障隔离的读数：开路的是**哪几个**，而不是"有故障"这一个布尔。
        //   只给布尔时，一次隔离良好的单点故障与一次大面积故障长得一样。
        openCircuits: Object.freeze(rows.filter((r) => r.circuit === 'open').map((r) => r.connectorId)),
      })
    },
  }
  return Object.freeze(reg)
}

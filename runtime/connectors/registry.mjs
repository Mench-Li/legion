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
import { publicToolName } from './public-name.mjs'

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
 * 一条工具声明**允许**出现的键（封闭键集，见 `normalizeTool` 里那段守卫）。
 *
 * `declaredRisk` 是**输入**名，`risk` 是**输出**名 —— 两个名字指的是同一件事，
 * 但只有前者能写在声明里。把它们并成两个都收，会把"写错了字段名"这件事
 * 永远藏起来；而它藏起来的正是"作者已经把风险抬到 critical"这个事实。
 */
export const TOOL_DECLARATION_KEYS = Object.freeze(
  new Set(['name', 'capabilities', 'declaredRisk', 'policy']),
)

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
  // ★★★ 工具声明的键集是**封闭**的 —— 不认识的键在这里就拒。
  //
  //   起因是一个**只差一个字母的字段名**：
  //
  //     输入字段叫 `declaredRisk`（作者的建议值）
  //     输出字段叫 `risk`（`normalizeTool` 与 `decide()` 交出去的有效风险）
  //
  //   于是作者照着**输出**的样子写 `risk: 'critical'` 时，登记表**一声不响**
  //   地把它丢掉，`risk` 落回能力下限（`low`），`decide()` 接着答
  //   "策略是 allow 且风险低于 high" ⇒ 一个**作者明确标成 critical** 的工具
  //   被自动放行。既没有报错，也没有计数，`declaredRisk` 读数是 `null`。
  //
  //   > 一个"把作者写的最严风险静默丢掉"的登记表，
  //   > 与一个"作者根本没声明风险"的登记表，在 `decide()` 的读数上是
  //   > 同一个 `risk: 'low'`——只不过前者**有人明确写过 `critical`**。
  //
  //   ★ 而这**不是**"假设作者会写错"：`target-binding.test.mjs` 里就同时写着
  //     `declaredRisk: 'low', risk: null` —— 一个自己人写的、真实的混淆样本。
  //
  //   ★ 与上面那条 `declaredRisk: 'none'` ⇒ 拒（`BAD_RISK`）是同一条纪律：
  //     拼错的值要拒，**拼错的键名更要拒**——值拼错至少还有个值，
  //     键名拼错是整条声明**看起来生效、实际没生效**。
  for (const key of Object.keys(tool)) {
    if (TOOL_DECLARATION_KEYS.has(key)) continue
    // `risk` 值得单独说一句：它不是"多写了个无关字段"，它是**输出字段名**。
    const because = key === 'risk'
      ? '`risk` 是**输出**字段（`normalizeTool` / `decide()` 交出去的有效风险，' +
        '等于 `max(declaredRisk, 能力下限)`）。声明里要写的是 `declaredRisk`。' +
        '**写 `risk` 不会有任何效果**，而它的读数看起来像"作者没声明风险"'
      : `不认识的键 ${JSON.stringify(key)}（工具声明只认：${[...TOOL_DECLARATION_KEYS].join(' / ')}）`
    throw fail(
      CONNECTOR_CODES.BAD_DECLARATION,
      `连接器 ${connectorId} 的工具「${name}」声明里有不认识的字段：${because}。` +
      '**不静默忽略**：一个被静默丢掉的最严声明与一个没写过的声明，在读数是同一个东西',
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

  // ★★★ 2026-09-24 业主裁决（§5 第 22 条采 ①：「声明写**裸名**」）的**装配期那一半**：
  //   同一份声明里**既写裸名、又写它的公开名** ⇒ 直接拒。
  //
  //   理由不是"重复"这个词本身，而是**它们在判定期指向同一个工具**：
  //   `declaredToolNames` 把两者都认（第 18 轮修的那件事），
  //   于是两行声明会同时认领同一次调用 —— 而上一段只比 `t.name`，
  //   看不出这两个名字是一回事。
  //
  //   > 一个"只比对作者写下的那个字符串"的重复检查，
  //   > 与一个"比对**推导后**的名字"的重复检查，
  //   > 在作者只写一种写法的那些声明上是同一个东西 ——
  //   > 只不过前者会让"两种写法各写一遍"变成一个**没人看得见**的重复。
  const claim = new Map()
  const collide = []
  for (const t of declared) {
    for (const nm of declaredToolNames(id, t.name)) {
      const prev = claim.get(nm)
      if (prev !== undefined && prev !== t.name) collide.push(`${prev} / ${t.name} ⇒ ${nm}`)
      else claim.set(nm, t.name)
    }
  }
  if (collide.length > 0) {
    throw fail(
      CONNECTOR_CODES.TOOL_DUPLICATE,
      `连接器 ${id} 的工具在**推导后的名字**上撞了：${[...new Set(collide)].join('；')}。`
      + '裸名与它的公开名在判定期**指向同一个工具**（' + `declaredToolNames` + ' 两个都认），'
      + '于是两行声明会同时认领同一次调用。★ 按 2026-09-24 的约定**只写裸名**即可',
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
/**
 * 工具名 → 声明了它的连接器 id 们（**唯一一处**归属算法）。
 *
 * ★ 提成顶层导出，是因为它有两个调用方，而它们**必须**用同一份实现：
 *   · `createRegistry()` —— 判定时用；
 *   · `runtime/dsh-composition/connector-port.mjs` —— 装配期用它在
 *     环境里那份声明上**先算出重名**，再决定拒不拒。
 *
 *   两处各写一份的后果不是"其中一处会慢慢漂"，而是更糟的一种：
 *   装配期那份算出"没有重名"、判定期那份却按登记顺序挑了一个——
 *   于是**拒绝没触发，策略也已经用错了**，而两边的读数都是绿的。
 *
 * @param {Map<string, object>} byId 已经归一化过的声明（`declareConnector` 的产物）
 * @returns {Map<string, string[]>}
 */
/**
 * ★★★ 一条已声明的工具在**本进程**里被认得的**全部**名字。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它：声明的名字与线上来的名字**不是同一个字符串**
 *
 * 声明里写的是**连接器自己那一侧**的工具名（`list_issues`）。而 DSH 把 MCP 工具
 * 注册进 ToolRuntime 时用的是**公开名** `mcp__<serverName>__<rawName>`
 * （`packages/mcp/mcp-client/src/tools.ts`，逐字镜像在 `./public-name.mjs`）。
 * 于是桥上收到的是 `mcp__github__list_issues`，而声明里写着 `list_issues`。
 *
 *   > 一个"声明写裸名、判定按裸名比"的登记表，
 *   > 与一个"声明根本对不上任何一次真调用"的登记表，
 *   > 在**套件读数**上是同一片 ✔——只不过前者从来没验过
 *   > "DSH 真的会送来的那个名字"。
 *
 * 实测（`scripts/probes/_probe-mcp-namespace.mjs`）：`github` 声明 `list_issues` 时，
 * 调 `list_issues` ⇒ `allow`，调 `mcp__github__list_issues` ⇒ **`deny`**
 * 「没有声明工具」——一个**正确声明过**的工具在真进程里被拒。
 *
 * ---------------------------------------------------------------------------
 * ★★ 为什么是**算**出来的，而不是**存**在声明里
 *
 * 存一份 `wireName` 会让它变成"又一份记录"：命名规则一变（DSH 改了归一化、
 * 或 `serverName` 与 `connectorId` 的关系变了），声明里那一份就成了**过期的
 * 事实**，而它看起来像作者写下的内容。这与本文件头 ② 删掉 `risk` 是**同一条
 * 纪律**（推导值不落盘）。
 *
 * ★ 所以本函数**只算**，两个调用点（`toolOwnershipOf` 与 `decide`）都用它
 *   ——**一份**实现。两处各写一份的后果不是"慢慢漂"，而是"装配期算出归属、
 *   判定期却按另一个名字找不着"：*拒绝没触发，策略也已经用错了，
 *   而两边读数都是绿的*。
 *
 * ★ 两个名字都留：裸名兜住既有夹具与"连接器声明了一个 DSH 核心工具名"那一类，
 *   公开名兜住**真的 MCP 工具**。**不去猜哪个是"对的"**——一个名字在某些部署里
 *   对、在另一些里错，而删掉任一都会让一类合法声明静默失效。
 *
 * @param {string} connectorId 连接器 id（部署契约里等于 DSH 的 `serverName`）
 * @param {string} toolName 声明里写的名字
 * @returns {readonly string[]} 去重、冻结；顺序是 `[声明名, 公开名]`
 *
 * ★★★ **2026-09-24 业主裁决（§5 第 22 条采 ①）：声明按连接器自己那一侧的名字（裸名）写。**
 *   这是**写作约定**，不是新的功能约束 —— 两种写法在功能上都工作（本函数两个都认）。
 *   约定要消灭的是"每加一个连接器就多一次即兴选择"：
 *
 *   · **要写**：`list_issues`（可读，且**唯一总能写对** —— 公开名在归一化/截断时会被换成
 *     12 位 SHA-256 后缀，那时还原不出 rawName）；
 *   · **不许**为了"统一"删掉裸名那一半（它兜住"连接器声明一个 DSH 核心工具名"）；
 *   · **不许**在归属时"把命名空间剥掉"（同一条理由：还原不出来）。
 *
 *   ★ 装配期钉住的那一半：**同一份声明里既写裸名、又写它的公开名** ⇒ `declareConnector`
 *     直接拒（`CONNECTOR_CODES.TOOL_DUPLICATE`）—— 判定期它们指向同一个工具，
 *     而只比 `t.name` 的重复检查看不出来。
 */
export function declaredToolNames(connectorId, toolName) {
  const raw = String(toolName ?? '').trim()
  const id = String(connectorId ?? '').trim()
  if (raw === '') return Object.freeze([])
  // ★ 公开名算不出来时**不吞**成"只有裸名"也不抛：`publicToolName` 只在
  //   id/name 为空时抛，而上面已经挡掉了空名。留一条 try 是因为本函数
  //   被 `decide()`（决策路径）间接复用，那里的任何抛出都会变成一次
  //   被 `decision-port` 兜成 deny 的"登记表判定失败"——而那不是这里的真相。
  let wire = null
  try {
    wire = publicToolName(id, raw)
  } catch {
    wire = null
  }
  return Object.freeze(wire === null || wire === raw ? [raw] : [raw, wire])
}

/**
 * 工具名 ⇒ 声明了它的连接器（**一份**归属算法，`connector-port` 与 `createRegistry` 共用）。
 *
 * ★ 2026-09-18 第 18 轮：键从"只有声明名"扩到 `declaredToolNames`（声明名 + 公开名）。
 *   少了这一步，`mcp__github__list_issues` 这样一个**合法**的调用在归属期就
 *   认不出来 ⇒ 落到政策门，而政策门把它当**未知工具**（`direction: 'write'`）
 *   ⇒ 一个已声明的工具被拒。
 */
export function toolOwnershipOf(byId) {
  const owners = new Map()
  for (const [id, decl] of byId) {
    for (const tool of decl.tools) {
      for (const name of declaredToolNames(id, tool.name)) {
        if (!owners.has(name)) owners.set(name, [])
        const list = owners.get(name)
        // ★ 去重：同一个连接器可能**同时**以裸名与公开名声明同一条工具
        //   （比如它声明了 `x`，而 `mcp__github__x` 恰好是它另一条工具的字面名）。
        //   不去重会让 `attributeTool` 报 `ambiguous` 而候选是 `['github','github']`
        //   ——一句读起来像"两个连接器打架"、实际是"一个连接器两个名字"的话。
        if (!list.includes(id)) list.push(id)
      }
    }
  }
  return owners
}

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
   * 工具名 → 声明了它的连接器 id（见 `attributeTool`）。
   *
   * ★ 为什么这张表要**在登记时**建，而不是在判定时现扫一遍：
   *   判定路径上每一次调用都会问它，而"扫一遍所有连接器的所有工具"
   *   是 O(连接器数 × 工具数) 次字符串比较——那条路径在**每次**真调用上都跑。
   *
   * ★ 而更要紧的是第二件事：这张表让"**一个工具名被两个连接器声明**"
   *   成为一个**可以查**的事实（`ambiguousTools()`），而不是一个
   *   在判定时被"谁先谁赢"（`Map` 的插入顺序）静默决定的巧合。
   *
   *   > 一个"两个连接器都声明了同名工具、于是按登记顺序挑一个"的归属，
   *   > 与一个"按调用方身份挑对的"归属，在**任何单条**调用的读数上
   *   > 都可能看起来正常——只不过前者会把 A 的策略用在 B 的调用上。
   */
  const toolOwners = toolOwnershipOf(byId)

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
     * 把一次调用的**工具名**归属到连接器。
     *
     * ★ 这是"判定面要求一个 `resolveConnectorId(projection)`"那个端口
     *   在**本模块**这一侧的答案来源。之所以由登记表自己答，而不是让部署
     *   再配一份 `{工具名: 连接器 id}`：那份映射**已经在声明里了**
     *   （每个连接器都列了自己的工具），再配一份就是同一件事写两遍——
     *   而两份写法迟早会分叉，分叉那天表现为"策略按另一份生效"。
     *
     * ★★ 三种结果**必须分得开**，所以这里返回判别式而不是裸 id：
     *
     *   · `unique`    —— 恰好一个连接器声明了它 ⇒ 归属确定
     *   · `none`      —— 没有任何连接器声明它 ⇒ 本次调用**不归连接器层管**
     *   · `ambiguous` —— **两个及以上**连接器声明了同名工具
     *
     *   第三种最危险，因为它**看起来像**第二种：两者都"说不清是谁"，
     *   于是都很容易被折成"那就不归连接器管，交给策略门"。而它们的
     *   真实含义正相反——`none` 是真的不归它管，`ambiguous` 是
     *   **归它管但说不清归谁**，折成 `none` 就等于给那个工具名
     *   **静默地免掉了连接器层的全部策略**（只因为有人加了个重名工具）。
     *
     *   > 一个"重名工具静默绕过连接器策略"的登记表，
     *   > 与一个"从没声明过这个工具、所以不归它管"的登记表，
     *   > 在 `unattributed` 这一个读数上是同一个东西——
     *   > 只不过前者是被一次**新增声明**触发的。
     */
    attributeTool(toolName) {
      const name = String(toolName ?? '').trim()
      const owners = toolOwners.get(name) ?? []
      if (owners.length === 0) {
        return Object.freeze({
          state: 'none', toolName: name,
          connectorId: null, candidates: Object.freeze([]),
        })
      }
      if (owners.length > 1) {
        return Object.freeze({
          state: 'ambiguous', toolName: name,
          connectorId: null, candidates: Object.freeze([...owners]),
        })
      }
      return Object.freeze({
        state: 'unique', toolName: name,
        connectorId: owners[0], candidates: Object.freeze([...owners]),
      })
    },

    /**
     * 归属的唯一确定答案（`string | null`）——**就是**判定面那个端口要的形状。
     *
     * ★ `ambiguous` 与 `none` 在这里都折成 `null`。这是**有意的**，
     *   但它意味着这个函数的调用方**看不见**两者之别——所以要看得见时
     *   用 `attributeTool()`，用 `ambiguousTools()` 在装配期把它们全列出来。
     *   把判据写在函数名里（`connectorForTool`）而不是写在返回值的形状里，
     *   正是"折平"这件事容易藏起来的地方。
     */
    connectorForTool(toolName) {
      const owners = toolOwners.get(String(toolName ?? '').trim()) ?? []
      return owners.length === 1 ? owners[0] : null
    },

    /**
     * 被**两个及以上**连接器声明过的工具名（排序、冻结）。
     *
     * 存在的理由：上面那个 `ambiguous` 折平之后就没有别的读出了。
     * 装配期拿它做 fail-closed 拒绝，可以让一次重名**在装配时**就停下来，
     * 而不是变成"这几个工具悄悄地不走连接器策略"。
     */
    ambiguousTools() {
      return Object.freeze(
        [...toolOwners.entries()].filter(([, ids]) => ids.length > 1).map(([n]) => n).sort(),
      )
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
      // ★★★ 2026-09-18 第 18 轮：认的是 `declaredToolNames`（声明名**或**公开名），
      //     而不是 `t.name === name`。
      //
      //     线上来的是 DSH 的**公开名**（`mcp__<serverName>__<rawName>`），
      //     声明里写的是**连接器自己那一侧**的名字。逐字比对会让一个
      //     **正确声明过**的工具在这里被判"没有声明"——见 `declaredToolNames`
      //     的文档与 `scripts/probes/_probe-mcp-namespace.mjs` 的实测。
      const tool = decl.tools.find((t) => declaredToolNames(id, t.name).includes(name))
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

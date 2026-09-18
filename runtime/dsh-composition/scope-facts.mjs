// runtime/dsh-composition/scope-facts.mjs
// ============================================================================
// **一次调用"出去做事"的那几样事实**——命令 / 网络 / MCP / 外部 API。
//
// ## 它填的是哪个洞
//
// PRT-605（命令/网络/MCP）与 PRT-606（外部 API）的**判定器**早就写好了：
//
//   · `execution-scope.mjs` —— `checkCommand({argv,…})` / `checkNetwork({url, method,…})`
//     / `checkMcp({tool,…})`
//   · `external-api-scope.mjs` —— `checkExternalApi({request,…})`
//
// 而它们**都还没有端口**（`production-scope-wiring.test.mjs` ② 把这件事钉住了）。
// 缺端口的直接原因是缺**输入**：判定器要 `argv` / `url` / `method` / `tool`，
// 而投影里只有 `canonicalTarget` 一个字符串。
//
// ## ★★★ 为什么事实在**这里**算，而不是在端口里算
//
// `tool-request.mjs:378` 那条纪律是写给所有下游的：
//
//   > 它们**只摆放**，不再推导。任何在这里出现的 `arguments.path ?? arguments.file_path`
//   > 都是漂移的来源：一个「在适配器里顺手补一次字段兜底」的桥，
//   > 与一个「两个强制点看到两个不同目标」的桥，是同一个东西。
//
// 如果**端口**各自去 `arguments.command ?? arguments.cmd ?? arguments.argv`，
// 那么 `pathScope`、`executionScope`、`externalApiScope` 三处、以及
// `guard` 与 `pre-execute` 两个时点，就有**六份**彼此独立的兜底链。
// 它们今天会一致，因为写它们的是同一个人；它们明天会不会一致，没有任何读数能回答。
//
//   > 一个「六处各自推导、今天恰好一致」的组合，
//   > 与一个「一处推导、六处引用」的组合，在**今天的用例**上是同一片 ✔——
//   > 只不过前者的下一次不一致会表现为"某个强制点没拦住"，
//   > 而那个现象看起来像"那条规则没生效"。
//
// ⇒ 事实**只算一次**，在投影里，落成 `projection.scopeFacts`；
//   端口**只读**它（`executionScopePort` 读 `projection.scopeFacts`，不做任何兜底）。
//
// ## ★ 参数名表与投影自己的那张表**同源**
//
// `TARGET_ARGUMENTS`（`tool-request.mjs:115`）已经是"能力 → 目标参数名"的权威表。
// 本模块的 `SCOPE_FACT_ARGUMENTS` 是同一形状的**第二张**表（能力 → 事实参数名），
// 而它**不是**手抄的：`scope-facts.test.mjs` 会核对两张表在**共同拥有的能力**上
// 对同一件事给出同一个字段名。两张表可以不同（目标与事实本来就不是一回事），
// 但它们**不许在同一个字段上给出两个名字**。
//
// ## ★ 缺席与"空"是两件事
//
// 一次调用**没有**命令/网络/MCP 事实，与它的命令是**空字符串**，是两回事：
//
//   · 没有事实 ⇒ 那个能力不在这次调用的能力集里（普通文件工具就是这样）；
//   · `{kind:'command', argv: ''}` ⇒ 它**是**一条命令，而那条命令是空的——
//     这是必须拒绝的东西（`parseArgv` 会拒），不是"没有命令"。
//
// ⇒ 本模块用 `undefined`（没这个能力）与具体值区分，**不**用 `null` 两者兼表。
//
// @module runtime/dsh-composition/scope-facts
// ============================================================================

/** 版本号：端口与判据都按它对齐。 */
export const SCOPE_FACTS_VERSION = 'legion/scope-facts@1'

export const SCOPE_FACTS_CODES = Object.freeze({
  BAD_INPUT: 'scope-facts-bad-input',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 能力 → 承载**事实**的参数名（按下标优先）。
 *
 * ★ 与 `TARGET_ARGUMENTS` 同形状、同纪律：这是 capability → argument names 的表，
 *   **不是** tool name → argument names 的表。工具改名不影响它。
 *
 * ★★ 每一行**只列同义词**，不列"兜底"：`argv` 与 `command` 是同一件事的两种拼法，
 *   而不是"先看 A、没有再看 B"的两个来源。这两种写法在**恰好只给一个**时读数相同，
 *   而它们的区别只在"两个都给了"的那一天——那时按第一个取是**对的**，
 *   按"合并"取会造出一条谁也没写过的命令行。
 */
export const SCOPE_FACT_ARGUMENTS = Object.freeze({
  'command:exec': Object.freeze({ argv: Object.freeze(['argv', 'command', 'cmd']) }),
  'process:spawn': Object.freeze({ argv: Object.freeze(['argv', 'command', 'cmd']) }),
  'network:read': Object.freeze({
    url: Object.freeze(['url', 'endpoint']),
    method: Object.freeze(['method']),
  }),
  'network:write': Object.freeze({
    url: Object.freeze(['url', 'endpoint']),
    method: Object.freeze(['method']),
  }),
  'external-api:read': Object.freeze({
    url: Object.freeze(['url', 'endpoint', 'api']),
    method: Object.freeze(['method']),
    headers: Object.freeze(['headers']),
    query: Object.freeze(['query', 'params']),
    body: Object.freeze(['body', 'data']),
  }),
  'external-api:write': Object.freeze({
    url: Object.freeze(['url', 'endpoint', 'api']),
    method: Object.freeze(['method']),
    headers: Object.freeze(['headers']),
    query: Object.freeze(['query', 'params']),
    body: Object.freeze(['body', 'data']),
  }),
})

/** 四类事实：一条调用最多落进**一类**（下面有互斥判据）。 */
export const SCOPE_FACT_KINDS = Object.freeze(['command', 'network', 'mcp', 'external-api'])

/**
 * 能力 → 事实类别。**一张表**决定"这次调用是哪一类"。
 *
 * ★ 未列出的能力（`file:*` / `repo:*` / `credential:*` / `message:send` …）
 *   不产生执行面事实——它们由别的强制点管（路径范围、白名单、政策门）。
 */
export const SCOPE_FACT_CAPABILITY_KIND = Object.freeze({
  'command:exec': 'command',
  'process:spawn': 'command',
  'network:read': 'network',
  'network:write': 'network',
  'mcp:call': 'mcp',
  'external-api:read': 'external-api',
  'external-api:write': 'external-api',
})

/** 按 `SCOPE_FACT_ARGUMENTS` 的优先顺序取第一个**存在**的值。 */
function pick(args, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) {
      return { found: true, name, value: args[name] }
    }
  }
  return { found: false, name: null, value: undefined }
}

/**
 * ★★★ **未登记**工具的事实候选名。
 *
 * 与 `tool-request.mjs:158` 的 `GENERIC_TARGET_ARGUMENTS` **同一条纪律**：
 * 未登记工具＝"我不知道它会干什么"，所以**任何**已知的这类参数都算证据。
 *
 * ## 为什么这一条必须有（本批实测到的洞）
 *
 * 未登记工具的能力集是**空的**（`resolveTool` 对不认识的名字给
 * `capabilities: []`），于是按能力查表时 `kinds` 也是空的 ⇒ 事实为 `null`
 * ⇒ 执行面端口"无话可说"⇒ **放行**。
 *
 *   > 一个「按能力查表」的执行面检查，
 *   > 与一个「换一个没登记过的工具名就能起进程」的执行面检查，
 *   > 是同一个东西——只不过前者的代码里写着"我只检查我认识的能力"。
 *
 * 而这不是假想：`tool-request.mjs` 的 `resolveTool` 对未登记工具的处置是
 * **fail closed**（`direction: 'write'`、`requiresApproval: true`、`hardFloor: true`）
 * ——同一份投影里，政策门把它当成危险工具，而执行面却读成"与命令无关"。
 *
 * ## ★ 多个候选**同时成立**时，全部采用（与目标那一条**不同**）
 *
 * 目标那一条是"两个以上候选 ⇒ 抛（到底是文件还是 URL？不猜）"，因为**目标**
 * 是一个标量身份，猜错会算出一个错的授权哈希。而**事实**是一组检查，
 * 同时采用**更多**检查是严格更严的方向：
 *
 *   · `url` 出现 ⇒ 同时记 `network` **与** `external-api`
 *     ——因为从参数上看不出它要走哪张授权表。两张表**都**得过，
 *     这不会比"随便挑一张"更松，而随便挑一张就会松。
 *   · 一个工具同时给了 `command` 与 `url` ⇒ 两类都记，两条都要过。
 */
export const GENERIC_FACT_ARGUMENTS = Object.freeze({
  command: Object.freeze(['argv', 'command', 'cmd']),
  url: Object.freeze(['url', 'endpoint', 'api', 'host']),
  server: Object.freeze(['server']),
  tool: Object.freeze(['tool']),
})

/** 工具名本身就是 MCP 公开名（`mcp__<server>__<raw>`）——见 `../connectors/public-name.mjs`。 */
// ★★★ 用**已有的**判定函数，不在这里再写一遍 `/^mcp__/`。
//
//   第一版我在这里内联了一个正则——那正是本仓库反复记下的那种重复：
//   两份"什么算 MCP 公开名"的判据今天一致，而 `public-name.mjs` 那条是
//   对着 DSH 真实源码逐字核过的（18/18），我这条只是一个印象。
//
//   > 一个「对着真实源码核过的判据」与一个「照着印象写的判据」，
//   > 在所有**今天**的用例上是同一条绿——直到命名规则变一次。
//
//   ⚠️ 顺带把 `isMcpPublicName` 从"只有自己的用例在调"变成生产可达：
//      在此之前它是 `public-name.mjs` 里唯一一条零生产调用方的导出。
import { isMcpPublicName } from '../connectors/public-name.mjs'

/**
 * 计算一条调用的执行面事实。
 *
 * ★ 本函数**不抛**。它做的是"如实摆放"：`arguments` 里是什么就摆什么。
 *   合法性判定归各判定器（`parseArgv` 拒未分词的命令、`parseEgressUrl` 拒坏 URL）。
 *   在这里顺手做一次校验，会造出**第二套**判定——而两套判定的分歧
 *   只会在"一边拒一边放"的那一天被发现。
 *
 * @param {object} p
 * @param {readonly string[]} p.capabilities 这次调用的能力集（投影里现成的）
 * @param {object} p.args 冻结后的参数体（投影里现成的）
 * @param {string} p.toolName 工具名（`mcp:call` 那条要用）
 * @param {boolean} [p.known] 工具**是不是**登记过的（投影里现成的 `facts.known`）。
 *   缺省 `true`：一个"默认未知"的默认值会让**所有**调用都走通用识别那条路，
 *   而那条路比按能力查表**宽**——默认值必须选更严的那一边。
 * @returns {object|null} 冻结的事实对象；这次调用不出去做事时是 `null`
 */
export function deriveScopeFacts({ capabilities, args, toolName, known = true } = {}) {
  if (!Array.isArray(capabilities)) {
    throw fail(SCOPE_FACTS_CODES.BAD_INPUT, 'deriveScopeFacts 需要 capabilities 数组')
  }
  if (!isPlainObject(args)) {
    throw fail(SCOPE_FACTS_CODES.BAD_INPUT, 'deriveScopeFacts 需要 args 对象')
  }

  // 这次调用落在哪一类。**多个类别**是合法输入（一个工具可以同时能起进程又能出网），
  // 所以这里收集**全部**命中的类别，而不是挑一个。
  const kinds = []
  for (const cap of capabilities) {
    const kind = SCOPE_FACT_CAPABILITY_KIND[cap]
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind)
  }
  // ★★★ 未登记工具：能力集是空的，**不能**因此读成"与执行面无关"。
  //   按参数证据反推（见 `GENERIC_FACT_ARGUMENTS` 的文档）。
  //   ⚠️ 只在 `known === false` 时走这条路：登记过的工具以**声明**为准，
  //      参数只是它这次调用的输入。反过来的话，一个声明了 `file:read`
  //      的工具只要参数里带个 `url` 字段就会被拿去按网络表判——
  //      那是拿**输入**去改写**声明**。
  const generic = known === false
  if (generic) {
    if (pick(args, GENERIC_FACT_ARGUMENTS.command).found && !kinds.includes('command')) kinds.push('command')
    if (pick(args, GENERIC_FACT_ARGUMENTS.url).found) {
      if (!kinds.includes('network')) kinds.push('network')
      if (!kinds.includes('external-api')) kinds.push('external-api')
    }
    const hasServer = pick(args, GENERIC_FACT_ARGUMENTS.server).found
    const hasTool = pick(args, GENERIC_FACT_ARGUMENTS.tool).found
    if ((hasServer && hasTool || isMcpPublicName(toolName)) && !kinds.includes('mcp')) kinds.push('mcp')
  }
  if (kinds.length === 0) return null

  const facts = {
    version: SCOPE_FACTS_VERSION,
    kinds: Object.freeze(kinds.length === 1 ? [...kinds] : kinds),
    generic,
  }
  const sources = {}

  if (kinds.includes('command')) {
    const got = pick(args, SCOPE_FACT_ARGUMENTS['command:exec'].argv)
    // ★ 没给 ⇒ `argv` 是 `null`，而**不是** `undefined`：
    //   能力说"这是一个会起进程的工具"，那么"它这次没给命令"是一条
    //   必须被拒绝的事实（判定器会拒），而不是"这次调用与命令无关"。
    //   两者的区别就是 `command !== undefined` 与 `command === undefined`。
    facts.command = Object.freeze({
      argv: got.found ? got.value : null,
      from: got.name,
    })
    if (got.found) sources.argv = got.name
  }

  if (kinds.includes('network') || kinds.includes('external-api')) {
    const spec = SCOPE_FACT_ARGUMENTS[kinds.includes('network') ? 'network:read' : 'external-api:read']
    // ★ 未登记工具用**通用**候选名（`['url','endpoint','api','host']` ⊃ 声明工具那两个）：
    //   否则会出现一个自相矛盾的读数——上游按 `host` 认出"这是网络调用"，
    //   而这里按 `['url','endpoint']` 取不到值 ⇒ 事实里 `url: null`
    //   ⇒ 端口以 `NO_FACTS` 拒。方向是安全的，**理由是错的**：
    //   值班的人会去找"为什么没给 url"，而其实给了，只是叫 `host`。
    const urlNames = generic ? GENERIC_FACT_ARGUMENTS.url : spec.url
    const url = pick(args, urlNames)
    const method = pick(args, spec.method)
    const req = {
      url: url.found ? url.value : null,
      method: method.found ? method.value : null,
      from: Object.freeze({ url: url.name, method: method.name }),
    }
    // ★ `sources` 在**公共**那一段记：第一版把它写在 `network` 分支里，
    //   于是"只走外部 API 表"的调用 `sources.url` 是 `undefined`
    //   ——而 `sources` 的全部用途就是"值取自哪个同义名"。
    //   一个在最需要它的那条路上缺席的归因记录，比没有它更糟：
    //   它看起来像"这个字段没有来源"。
    if (url.found) sources.url = url.name
    if (method.found) sources.method = method.name
    if (kinds.includes('network')) {
      facts.network = Object.freeze(req)
    }
    if (kinds.includes('external-api')) {
      const headers = pick(args, SCOPE_FACT_ARGUMENTS['external-api:read'].headers)
      const query = pick(args, SCOPE_FACT_ARGUMENTS['external-api:read'].query)
      const body = pick(args, SCOPE_FACT_ARGUMENTS['external-api:read'].body)
      facts.externalApi = Object.freeze({
        ...req,
        headers: headers.found ? headers.value : null,
        query: query.found ? query.value : null,
        body: body.found ? body.value : null,
      })
      if (headers.found) sources.headers = headers.name
      if (query.found) sources.query = query.name
      if (body.found) sources.body = body.name
    }
  }

  if (kinds.includes('mcp')) {
    // ★ MCP 那条：事实就是**工具名本身**（授权表按 `server__tool` 对）。
    //   本模块**不拆**它——拆分归 `splitMcpTool`，它有一条"分隔符不恰好一个就拒"
    //   的判据，而那条判据必须只有一个执行点。
    facts.mcp = Object.freeze({
      tool: typeof toolName === 'string' && toolName.trim() !== '' ? toolName.trim() : null,
      from: 'toolName',
    })
  }

  return Object.freeze({ ...facts, sources: Object.freeze(sources) })
}

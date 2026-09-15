// ============================================================================
// PRT-601 工具能力描述与风险等级
//
// spec 阶段 6：「未批准高风险写操作为零；改变已批准操作的任一关键字段后无法继续执行。」
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **风险等级不能由工具作者说了算。**
//
// 一张"每个工具自己填一个风险等级"的登记表，失效方式是很具体的：
// 一个会删文件的工具把自己的等级填成 `low`，于是它被自动放行；
// 一个会往外部 API 写数据的工具填成 `low`，于是在无人值守的夜里被自动放行。
// 没有谁在撒谎——填表的人真的觉得"这就是个小工具"。
//
//   > 一个允许工具把自己的风险等级**填低**的登记表，
//   > 与一个"所有工具都是低风险"的登记表，是同一个东西。
//
// 所以声明分两层，而且**只有一层可以被填低**：
//
//   ① `capabilities` —— **结构化的事实**：这个工具会读文件、会执行命令、
//      会往外部写、会删东西。这一层不接受"我觉得"，它就是一组枚举。
//   ② `declaredRisk` —— 作者的建议值，**只能往上抬，不能往下压**。
//
// 有效风险 = `max(declaredRisk, 声明的能力所蕴含的最低风险)`。
// 声明与最低风险不一致时**不抛错、而是照最低风险执行并留一条诊断**——
// 抛错会让一个第一方工具在启动时把整个产品带崩，而这份不一致本身
// 并不危险（照最低风险走是安全的）；但它必须**可见**，否则没人会去改。
//
// ── 第二条纪律：不认识的工具必须**默认最严** ──
//
// 一个没在登记表里的工具名，是一个"我不知道它会干什么"的工具。
// 把它当成"没有风险声明"从而放行，与直接放行一切未知工具没有区别。
//
//   > 一个"没在登记表里"的工具被当成"没有风险声明"，
//   > 与一个"所有未知工具都自动放行"的强制面，是同一个东西。
//
// 所以 `resolveTool()` 对未登记的工具返回 `critical` + `requiresApproval: true`，
// 且明确标出 `known: false`——让调用方有机会去问，而不是静默放行。
// ============================================================================

// 硬底线那一组**不是在这里定义的**，也不是在控制面那一侧定义的：
// 它在 `./enforcement.mjs`——定义强制面的地方（`DEFAULT_HARD_FLOOR` 与真 guard
// 都在那里）。两个消费方因此取到的是**同一个数组对象**，而分层方向没有被反转
// （`team-hub/` → `runtime/` 是既有方向，`runtime/` → `team-hub/` 是 0 处）。
// 理由写在 `enforcement.mjs` 的 `HARD_FLOOR_CAPABILITIES` 上。
import { HARD_FLOOR_CAPABILITIES } from './enforcement.mjs'

/** 四档风险，**有序**。数值用于取最大值，不要单独使用名字做比较。 */
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical'])

/** 风险等级 → 序号。序号越大越严。 */
export const RISK_RANK = Object.freeze(
  Object.fromEntries(RISK_LEVELS.map((l, i) => [l, i])),
)

/** 未登记工具的兜底等级。**不是 `low`**——那是本模块要防的那个默认。 */
export const UNKNOWN_TOOL_RISK = 'critical'

/**
 * **能力种类**：结构化的事实，不接受"我觉得"。
 *
 * 每一项的第一行是它的**风险下限**：只要一个工具声明了这个能力，
 * 它的有效风险就不可能低于这一档。`hardFloor` 的能力连"问一下"都不够，
 * 它们永远不能被自动放行（与 `permission-engine` 的 `isHardFloor` 同一组动作名）。
 */
const RAW_CAPABILITY_KINDS = Object.freeze({
  'file:read': Object.freeze({
    riskFloor: 'low', direction: 'read', externalEffect: false, irreversible: false,
    userText: '读取文件',
  }),
  'file:write': Object.freeze({
    riskFloor: 'medium', direction: 'write', externalEffect: false, irreversible: false,
    userText: '写入或修改文件',
  }),
  'file:delete': Object.freeze({
    // 删掉的东西回不来，因此这是硬底线：不接受"自动放行"，只能人来批。
    riskFloor: 'critical', direction: 'write', externalEffect: false, irreversible: true,
    userText: '删除文件',
  }),
  'repo:read': Object.freeze({
    riskFloor: 'low', direction: 'read', externalEffect: false, irreversible: false,
    userText: '读取代码仓库',
  }),
  'repo:write': Object.freeze({
    riskFloor: 'high', direction: 'write', externalEffect: false, irreversible: false,
    userText: '修改代码仓库',
  }),
  'repo:push': Object.freeze({
    // 推上去之后**别人也看得到**，而且改不回来——一次强推能让队友的工作消失。
    riskFloor: 'critical', direction: 'write', externalEffect: true, irreversible: true,
    userText: '向远端仓库推送',
  }),
  'command:exec': Object.freeze({
    // 一条命令能做的事没有上界。它的下限只能是"高"，而不可能是"中"。
    riskFloor: 'high', direction: 'write', externalEffect: true, irreversible: false,
    userText: '执行命令',
  }),
  'process:spawn': Object.freeze({
    riskFloor: 'high', direction: 'write', externalEffect: true, irreversible: false,
    userText: '启动子进程',
  }),
  'network:read': Object.freeze({
    // 读网络：数据**进来**。它不改变外部世界，但会带进不受控的内容。
    riskFloor: 'medium', direction: 'read', externalEffect: true, irreversible: false,
    userText: '访问网络读取内容',
  }),
  'network:write': Object.freeze({
    riskFloor: 'high', direction: 'write', externalEffect: true, irreversible: false,
    userText: '向网络发送数据',
  }),
  'external-api:read': Object.freeze({
    riskFloor: 'medium', direction: 'read', externalEffect: true, irreversible: false,
    userText: '读取外部 API',
  }),
  'external-api:write': Object.freeze({
    // PRT-606 要区分的那一对。写外部 API 可能让别人真的付钱/发货/发消息，
    // 而且**这个动作在我们这边没有回滚**，所以它是可逆性上的风险点。
    riskFloor: 'critical', direction: 'write', externalEffect: true, irreversible: true,
    userText: '写入外部 API',
  }),
  'mcp:call': Object.freeze({
    // MCP 服务器的能力对我们是不透明的：我们只知道"它在那边干了点什么"。
    riskFloor: 'high', direction: 'write', externalEffect: true, irreversible: false,
    userText: '调用 MCP 服务器',
  }),
  'credential:read': Object.freeze({
    riskFloor: 'high', direction: 'read', externalEffect: false, irreversible: false,
    userText: '读取密钥',
  }),
  'credential:write': Object.freeze({
    riskFloor: 'critical', direction: 'write', externalEffect: false, irreversible: false,
    userText: '写入或删除密钥',
  }),
  'message:send': Object.freeze({
    // 发出去的话收不回来。
    riskFloor: 'high', direction: 'write', externalEffect: true, irreversible: true,
    userText: '对外发送消息',
  }),
})

/**
 * 编译后的能力表：**唯一**加上 `hardFloor` 这一步。
 *
 * 名单在 `./enforcement.mjs`（`HARD_FLOOR_CAPABILITIES`，与 `DEFAULT_HARD_FLOOR`
 * 和真 guard 放在一起），与控制面 `permission-engine.mjs` 的 `isHardFloor`
 * 是**同一个数组对象**。这里只做一次成员判定，于是"改名单"与"改能力表"
 * 不可能各改各的。
 */
export const CAPABILITY_KINDS = Object.freeze(Object.fromEntries(
  Object.entries(RAW_CAPABILITY_KINDS).map(([id, kind]) => [
    id,
    Object.freeze({ ...kind, hardFloor: HARD_FLOOR_CAPABILITIES.includes(id) }),
  ]),
))

/** 全部能力种类名，供校验与遍历。 */
export const CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITY_KINDS))

// 硬底线那一组**不是在这里定义的**：它就是 `./enforcement.mjs` 的
// `HARD_FLOOR_CAPABILITIES`（`team-hub/run-floor.mjs` 也只是把它转出去），
// 控制面 `permission-engine.mjs` 的 `isHardFloor` 用的是同一个数组对象。
// 这里**重导出**，不再从本表算第二份。
//
//   > 一份"两处名单今天恰好同名"的一致性，
//   > 与一份"它们来自同一个来源"的一致性，
//   > 在没有人只改一边的那些日子里是同一个东西——
//   > 只不过前者会在有人只改一边的第二天，让 spec §6.8 的两道闸安静地少掉一道。
export { HARD_FLOOR_CAPABILITIES }

/** 声明非法。工具作者就在现场，因此这是**抛错**而不是诊断。 */
export class CapabilityDeclarationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CapabilityDeclarationError'
    this.code = code
  }
}

export const CAPABILITY_ERRORS = Object.freeze({
  BAD_NAME: 'CAPABILITY_BAD_NAME',
  NO_CAPABILITIES: 'CAPABILITY_NONE_DECLARED',
  UNKNOWN_CAPABILITY: 'CAPABILITY_UNKNOWN_KIND',
  UNKNOWN_RISK: 'CAPABILITY_UNKNOWN_RISK',
  BAD_DECLARED_RISK: 'CAPABILITY_BAD_DECLARED_RISK',
})

/** 取两个风险里更严的那个。 */
export function maxRisk(a, b) {
  const ra = RISK_RANK[a]
  const rb = RISK_RANK[b]
  if (ra === undefined) return b
  if (rb === undefined) return a
  return ra >= rb ? a : b
}

/**
 * 一组能力所蕴含的**最低**风险。
 *
 * 空集合返回 `low` —— 但注意 `describeTool` 不允许空能力（见下），
 * 因为"什么也不做"的工具与"我们不知道它做什么"的工具在登记表上长得一样，
 * 而后者必须更严。
 */
export function riskFloorOf(capabilities = []) {
  let risk = 'low'
  for (const id of capabilities) {
    const kind = CAPABILITY_KINDS[id]
    // 不认识的能力**不能**被当成安全能力。走到这里说明调用方绕过了校验，
    // 因此直接判最严。
    if (kind === undefined) return 'critical'
    risk = maxRisk(risk, kind.riskFloor)
  }
  return risk
}

/** 能力集合的聚合事实。 */
export function capabilityFacts(capabilities = []) {
  const facts = {
    direction: 'read',
    externalEffect: false,
    irreversible: false,
    hardFloor: false,
    unknown: false,
  }
  for (const id of capabilities) {
    const kind = CAPABILITY_KINDS[id]
    if (kind === undefined) { facts.unknown = true; continue }
    if (kind.direction === 'write') facts.direction = 'write'
    if (kind.externalEffect === true) facts.externalEffect = true
    if (kind.irreversible === true) facts.irreversible = true
    if (kind.hardFloor === true) facts.hardFloor = true
  }
  return Object.freeze(facts)
}

/**
 * 规范化并校验一份工具声明。
 *
 * **有效风险 = max(declaredRisk, riskFloorOf(capabilities))**。
 * `declaredRisk` 只能往上抬。声明低于下限时**不抛**，而是照下限走并留一条
 * `riskRaised` 记录——理由见文件头：抛错会让整个产品在启动时崩，
 * 而这份不一致本身不危险；但它必须可见。
 */
export function describeTool(declaration = {}) {
  const name = String(declaration.name ?? '').trim()
  if (name === '') {
    throw new CapabilityDeclarationError(CAPABILITY_ERRORS.BAD_NAME, '工具声明必须有 name')
  }
  const raw = Array.isArray(declaration.capabilities) ? declaration.capabilities : []
  if (raw.length === 0) {
    // 「什么也不做」与「我们不知道它做什么」在登记表上长得一样。
    // 不允许空声明，逼作者把能力写出来。
    throw new CapabilityDeclarationError(
      CAPABILITY_ERRORS.NO_CAPABILITIES,
      `工具「${name}」必须至少声明一项能力：一个"没有能力"的工具与一个"能力未知"的`
      + '工具在登记表上长得一样，而后者必须按最严处理',
    )
  }
  const capabilities = Object.freeze([...new Set(raw.map((c) => String(c).trim()))])
  for (const id of capabilities) {
    if (CAPABILITY_KINDS[id] === undefined) {
      throw new CapabilityDeclarationError(
        CAPABILITY_ERRORS.UNKNOWN_CAPABILITY,
        `工具「${name}」声明了不认识的能力「${id}」。不认识的能力不能被当成安全能力——`
        + `已知的是：${CAPABILITY_IDS.join(', ')}`,
      )
    }
  }

  const floor = riskFloorOf(capabilities)
  const declared = declaration.declaredRisk === undefined || declaration.declaredRisk === null
    ? null
    : String(declaration.declaredRisk)
  if (declared !== null && RISK_RANK[declared] === undefined) {
    throw new CapabilityDeclarationError(
      CAPABILITY_ERRORS.UNKNOWN_RISK,
      `工具「${name}」的 declaredRisk「${declared}」不是已知等级（${RISK_LEVELS.join(' / ')}）`,
    )
  }

  // ★ 这里就是"只能往上抬"的实现。`Math.max` 是这个模块的核心。
  const effective = declared === null ? floor : maxRisk(declared, floor)
  const riskRaised = declared !== null && RISK_RANK[declared] < RISK_RANK[floor]
  const facts = capabilityFacts(capabilities)

  return Object.freeze({
    name,
    capabilities,
    /** 作者填的建议值（可能为 null＝没填）。 */
    declaredRisk: declared,
    /** **实际生效的**风险。永远不低于能力所蕴含的下限。 */
    risk: effective,
    riskFloor: floor,
    /** 声明被抬高了——留痕，供自检与诊断报出来。 */
    riskRaised,
    direction: facts.direction,
    externalEffectPossible: facts.externalEffect,
    irreversible: facts.irreversible,
    // 硬底线永远要人批；`high` 及以上也要。
    requiresApproval: facts.hardFloor || RISK_RANK[effective] >= RISK_RANK.high,
    hardFloor: facts.hardFloor,
    description: String(declaration.description ?? '').trim(),
  })
}

/**
 * 内置工具登记表。
 *
 * 每一条都必须能通过 `describeTool` 的校验，且**声明的风险不低于下限**——
 * 这由 `assertCatalogConsistent()` 在加载时检查。
 */
const RAW_CATALOG = Object.freeze([
  Object.freeze({
    name: 'read-file', capabilities: ['file:read'], declaredRisk: 'low',
    description: '读取工作目录内的一个文件',
  }),
  Object.freeze({
    name: 'write-file', capabilities: ['file:write'], declaredRisk: 'medium',
    description: '写入或修改工作目录内的一个文件',
  }),
  Object.freeze({
    name: 'delete-file', capabilities: ['file:delete'], declaredRisk: 'high',
    // ★ 这条**故意**声明得比下限低：它既证明"抬升"这条路径真的在工作，
    //   也让"作者会低估自己的工具"这件事在代码里留下一个可查的例子。
    description: '删除一个文件（故意声明为 high 以演示下限抬升）',
  }),
  Object.freeze({
    name: 'run-command', capabilities: ['command:exec', 'process:spawn'], declaredRisk: 'high',
    description: '执行一条命令并等待它结束',
  }),
  Object.freeze({
    name: 'fetch-url', capabilities: ['network:read'], declaredRisk: 'medium',
    description: '抓取一个 URL 的内容',
  }),
  Object.freeze({
    name: 'git-status', capabilities: ['repo:read'], declaredRisk: 'low',
    description: '读取仓库状态',
  }),
  Object.freeze({
    name: 'git-commit', capabilities: ['repo:write'], declaredRisk: 'high',
    description: '在本地仓库创建一个提交',
  }),
  Object.freeze({
    name: 'git-push', capabilities: ['repo:push'], declaredRisk: 'critical',
    description: '把本地提交推送到远端',
  }),
  Object.freeze({
    name: 'mcp-invoke', capabilities: ['mcp:call'], declaredRisk: 'high',
    description: '调用一个 MCP 服务器的工具',
  }),
  Object.freeze({
    name: 'read-secret', capabilities: ['credential:read'], declaredRisk: 'high',
    description: '从密钥库读取一个密钥',
  }),
  Object.freeze({
    name: 'write-secret', capabilities: ['credential:write'], declaredRisk: 'critical',
    description: '写入或轮换密钥库中的密钥',
  }),
  Object.freeze({
    name: 'send-message', capabilities: ['message:send'], declaredRisk: 'high',
    description: '对外发送一条消息',
  }),
  Object.freeze({
    name: 'call-external-api', capabilities: ['external-api:read'], declaredRisk: 'medium',
    description: '读取一个外部 API（只读）',
  }),
  Object.freeze({
    name: 'post-external-api', capabilities: ['external-api:write'], declaredRisk: 'high',
    // ★ 同样故意低于 `critical` 的下限，与 `delete-file` 一起构成抬升的正面证据。
    description: '向一个外部 API 写入（故意声明为 high 以演示下限抬升）',
  }),
])

/** 编译好的登记表：`name → 规范化后的声明`。 */
export const TOOL_CATALOG = Object.freeze(
  Object.fromEntries(RAW_CATALOG.map((d) => {
    const tool = describeTool(d)
    return [tool.name, tool]
  })),
)

/** 登记表里全部工具名。 */
export const KNOWN_TOOL_NAMES = Object.freeze(Object.keys(TOOL_CATALOG))

/**
 * 登记表一致性检查。**加载时执行**。
 *
 * 检查两件事：
 *   ① 每一条都能通过校验（`describeTool` 不抛）；
 *   ② 没有哪一条的 `risk` 低于它的能力下限——即有效风险确实是抬升过的那个值。
 *
 * ② 在"由 `describeTool` 生成"的前提下恒真。**但恒真的检查不是没有价值的**：
 * 它拦的是"有人把 `TOOL_CATALOG` 换成一份手写的、没走生成器的表"。
 *
 * 做成可注入的参数，是为了让用例能喂一份**故意填低**的表进来，
 * 验它真的会拦——一个只能对"当前恰好正确的那份输入"作答的校验，
 * 与一个恒真的校验，在"它能不能发现错误"上同形。
 */
export function assertCatalogConsistent(catalog = TOOL_CATALOG) {
  const problems = []
  for (const [name, tool] of Object.entries(catalog)) {
    if (tool === null || typeof tool !== 'object') {
      problems.push({ name, kind: 'not-an-object' })
      continue
    }
    const floor = riskFloorOf(tool.capabilities ?? [])
    if (RISK_RANK[tool.risk] === undefined) {
      problems.push({ name, kind: 'unknown-risk', risk: tool.risk })
      continue
    }
    if (RISK_RANK[tool.risk] < RISK_RANK[floor]) {
      problems.push({ name, kind: 'risk-below-floor', risk: tool.risk, floor })
    }
    if (tool.hardFloor === true && tool.requiresApproval !== true) {
      // 硬底线却不需要审批——这一条永远不该出现。
      problems.push({ name, kind: 'hard-floor-without-approval' })
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

/**
 * 查一个工具。**未登记的工具默认最严。**
 *
 * 返回的形状与 `TOOL_CATALOG` 里的条目一致，因此调用方不需要为"未知"写第二条分支
 * ——一条只为未知工具存在的分支，正是最容易忘记写的那一条。
 */
export function resolveTool(name) {
  const key = String(name ?? '').trim()
  const known = TOOL_CATALOG[key]
  if (known !== undefined) return Object.freeze({ ...known, known: true })
  return Object.freeze({
    name: key,
    capabilities: Object.freeze([]),
    declaredRisk: null,
    risk: UNKNOWN_TOOL_RISK,
    riskFloor: UNKNOWN_TOOL_RISK,
    riskRaised: false,
    direction: 'write',
    externalEffectPossible: true,
    irreversible: true,
    requiresApproval: true,
    hardFloor: true,
    description: '',
    known: false,
  })
}

/**
 * **高风险工具名单**（`risk >= high`）——`HIGH_RISK_TOOL_NAMES`。
 *
 * 为什么是"算出来的"而不是手写的九个名字：手写的那一份与登记表在
 * "没有人只改一边的那些日子里"完全一致，而它会在有人给登记表加一个
 * `read-secret` 之类的工具、或者把某个工具的 `declaredRisk` 抬上去的第二天
 * **安静地少一项**——少掉的那一项恰恰是小一号的 `denyTools`。
 *
 *   > 一份"今天恰好与登记表同名"的名单，
 *   > 与一份"登记表本身"的名单，在没人改登记表的日子里是同一个东西——
 *   > 只不过前者在下一次加工具时会让新工具**默认放行**。
 *
 * ⚠️ 这一组**不是** `hardFloor: true` 的那三个（`file:delete` / `repo:push` /
 * `credential:write` 的能力）。硬底线是"永远不能自动放行"，`high` 是
 * "需要人工批准、且发布前姿态下静态禁止"。spec §6.8 `:479` 说的是**高风险**，
 * 所以这一档是**九个**，不是三个。
 *
 * ## ★★ 名字空间：这一组**绝不能**被当成 `denyTools` 直接装
 *
 * 下面每一个名字都在 **Legion 的能力名空间**里（`read-secret` / `run-command` / …），
 * 而静态下限 `createHardFloorGuard()`（`enforcement.mjs`）比对的是
 * **执行面（DSH）的工具名**——它只看 `execution.name`（`write` / `read` / `pwsh` / …），
 * 中间**没有任何翻译**。两个名字空间**不相交**，结构上是这样分的：
 *
 *   · 九个里有**六个是宿主平面能力**，根本没有执行面的工具名
 *     （`delete-file` / `mcp-invoke` / `read-secret` / `write-secret` /
 *     `send-message` / `post-external-api`——见 `employee-preset.mjs` 的 `hosted: true`）；
 *   · 剩下三个（`run-command` / `git-commit` / `git-push`）都塌在**同一对**
 *     shell 工具名上，而**低风险**的 `git-status` 也用那一对——于是"按名字禁"连
 *     "禁高风险、放低风险"这个粒度都表达不出来。
 *
 * 两个空间之间的映射在 `employee-preset.mjs` 的 `LEGION_TOOL_ROUTING`（`dshTools`），
 * 读数由同文件的 `dshToolNamesOf()` 算出来：对**这一组九个**，它只返回 shell 那一对。
 *
 *   > 一个「把 Legion 能力名当 `denyTools` 装上去」的下限，
 *   > 与一个「名字空间对得上、于是真的拦住了高风险工具」的下限，
 *   > 在用例只喂 Legion 名字的那些日子里是同一个东西（手写的 probe 都能被拒）——
 *   > 只不过真工具名进来时，前者一个都拦不住，却在摘要里看起来在执行 §6.8:479。
 *
 * 所以：**作为数据**这一组是对的、也是单一来源（下面的单源说明）；**作为 `denyTools`**
 * 它是**空的**（`名单 ∩ 真工具名 = ∅`）。`run-floor.mjs` 的 `absent` 档因此选
 * "拒绝一切"——名字名单不是 fail closed 的，不在名单里的一律放行。
 *
 * 位置：必须放在 `TOOL_CATALOG` / `RISK_RANK` 之后——模块求值期 `const` 不可
 * 提前读取（TDZ），把它挪到 `resolveTool` 附近就得保证这几个名字已经算出来了。
 */
export const HIGH_RISK_TOOL_NAMES = Object.freeze(
  KNOWN_TOOL_NAMES.filter((n) => RISK_RANK[TOOL_CATALOG[n].risk] >= RISK_RANK.high),
)

/**
 * **发布前姿态**（spec §6.8 `:479`）的静态下限**形状**：高风险工具那一组。
 *
 * spec 的原文把这个姿态说得很清楚：「无人值守模式下，要求人工审批的操作默认拒绝或
 * 保持等待，不自动降级为允许。legacy 路径在完成 DSH 强制面接线前**禁止高风险工具**」。
 *
 * ⚠️★★ 这里有一个**容易读错**的地方，写在这里而不是留给下一个人踩：
 * **这个对象今天没有任何生产安装点**，而且它**不能**被直接当作 `denyTools` 装上去。
 * 它的 `denyTools` 是 `HIGH_RISK_TOOL_NAMES`——一组 **Legion 能力名**，而
 * `createHardFloorGuard()` 比对的是**执行面（DSH）的工具名**（见那一组的注释）。
 * 把它装进 guard，拒绝集是**空集**：六个高风险能力是宿主平面的（没有执行面名字），
 * 另外三个都塌在 shell 那一对上（低风险的 `git-status` 也共用）。
 *
 *   > 一个「装上这份下限、于是看起来在执行 §6.8:479」的实现，
 *   > 与一个「装上这份下限、而它一个真工具名都没命中」的实现，
 *   > 在用例只喂 Legion 名字的那些日子里是同一个东西——
 *   > 只不过真工具名进来时，前者是绿的，而这一档其实什么都没拦住。
 *
 * 所以"没给下限"（`run-floor.mjs` 的 `absent`）今天装的是**拒绝一切**：
 * §6.8:479 要的是禁止高风险工具，**过度禁止满足它**，而"看起来在禁、实际一个都没拦"
 * 不满足。这份常量留下是因为它作为**数据**是对的（单一来源、可断言），
 * 且接线完成（控制面派生→过线→`installed`）之后它才是名单的来源。
 *
 * ★ 形状与 `createHardFloorGuard()` 消费的那一份一致（`enforcement.mjs:167`）。
 * `denyPathPrefixes` **故意为空**，而且**不许有人"顺手"补一个 `cwd`**：
 * guard 只在**前缀非空**时才去读 `cwd` / `platform`（同文件 `:180`：
 * `if (typeof target === 'string' && denyPathPrefixes.length > 0)`）。
 * 前缀为空 ⇒ 路径那一支整段不进入 ⇒ 这份下限**不需要 cwd 也判得对**。
 * 补一个 `cwd` 只会制造一个"它看起来需要这台机器的现场"的假象。
 */
export const PRE_WIRING_HARD_FLOOR = Object.freeze({
  denyTools: HIGH_RISK_TOOL_NAMES,
  denyPathPrefixes: Object.freeze([]),
})

/** 给用户看的一句话：这个工具会做什么、风险多高、要不要批。 */
export function describeRiskText(tool) {
  const t = tool?.known === undefined ? resolveTool(tool?.name) : tool
  const what = t.capabilities.length > 0
    ? t.capabilities.map((c) => CAPABILITY_KINDS[c]?.userText ?? c).join('、')
    : '（能力未知）'
  const label = { low: '低', medium: '中', high: '高', critical: '极高' }[t.risk] ?? t.risk
  const parts = [`「${t.name}」：${what}`, `风险 ${label}`]
  if (t.known === false) parts.push('**未登记**，按最严处理')
  if (t.irreversible === true) parts.push('不可逆')
  if (t.externalEffectPossible === true) parts.push('会产生外部副作用')
  parts.push(t.requiresApproval === true ? '需要人工批准' : '可按策略自动放行')
  return parts.join('；')
}

/** 供 `--json` 诊断输出用的纯数据快照。 */
export function toolCatalogSnapshot() {
  return Object.freeze({
    version: 'legion/tool-capability@1',
    riskLevels: RISK_LEVELS,
    unknownToolRisk: UNKNOWN_TOOL_RISK,
    hardFloorCapabilities: HARD_FLOOR_CAPABILITIES,
    tools: Object.freeze(KNOWN_TOOL_NAMES.map((n) => {
      const t = TOOL_CATALOG[n]
      return Object.freeze({
        name: t.name, risk: t.risk, riskFloor: t.riskFloor,
        capabilities: t.capabilities, requiresApproval: t.requiresApproval,
        hardFloor: t.hardFloor, irreversible: t.irreversible,
        externalEffectPossible: t.externalEffectPossible,
      })
    })),
  })
}

// 加载即执行。**并把真正算出来的东西导出去当证据**。
//
// 只导出一个"通过 / 不通过"的结论是不够的：`ok: true` 与 `problems: []`
// 都是**随手就能写出来**的字面量，而能把它写成 `true` 的，恰恰就是那个
// 把自检删掉的改动——那样一来这段自检就成了"删掉也不会让任何用例变红"的判断。
// 所以这里连同**每个工具的实际下限**（由能力现算出来的）一起导出：
// 想让证据成立，就得真的把下限算出来。
export const TOOL_CATALOG_CHECKED = Object.freeze({
  ...assertCatalogConsistent(),
  checkedNames: KNOWN_TOOL_NAMES,
  floors: Object.freeze(Object.fromEntries(
    KNOWN_TOOL_NAMES.map((n) => [n, riskFloorOf(TOOL_CATALOG[n].capabilities)]),
  )),
})

// runtime/dsh-composition/connector-port.mjs
// ============================================================================
// F-21：把**部署环境里那份连接器声明**接到组合根上（第 19 条 §9.2 第 5 步）。
//
// 在此之前整条 F-21 的读数是这样分裂的：
//
//   · `runtime/connectors/registry.mjs` 的 `decide()` —— 判定面，**已建**
//   · `runtime/connectors/decision-port.mjs` —— 织进桥，**已建**
//   · `assemble.mjs` / `root.mjs` —— 两个参数（`connectorDeclarations`
//     + `resolveConnectorId`）**都收**，也**都成对校验**
//   · 而**生产入参里从来没有这两样东西** ⇒ `connectorJudgment` 恒为 `false`
//
// 这正是本仓最忌讳的那一种读数：能力齐全、用例全绿、而**生产调用方数为 0**。
// 本模块补的就是那个调用方——它与 `scope-port.mjs` 是**同一个形状**：
// 部署侧把数据放进 Runtime 子进程的环境，本模块在装配期读出来、校验、
// 变成一个可用的端口；**没配仍然是没配**（`null`），不补默认值。
//
// ---------------------------------------------------------------------------
// ★ ① 缺席 ≠ 空表（这一条是本模块存在的首要理由）
//
// 最自然的写法是
//
//     const declarations = JSON.parse(env[KEY] ?? '[]')   // 没配就当空表
//
// 而它的含义是"**装了一个零连接器的登记表**"。后果不是"什么都不管"，
// 而是一个很具体的**假接线**：
//
//   · `assemble.mjs` 只判 `connectorDeclarations === null`
//     ⇒ 传 `[]` 走的是"建了一份登记表"那条分支
//   · 于是 `enforcementSurfaces().connectorJudgment` 翻成 **true**
//   · 而零连接器意味着**任何工具都归属不到连接器** ⇒ 连接器层永远不说话
//   · ⇒ 那一格报"判定面装好了"，而它**一次判定都没做过**
//
//   > 一个"装了一份零连接器登记表"的组合根，
//   > 与一个"连接器层根本不存在"的组合根，在**行为上完全相同**——
//   > 只不过前者的 `enforcementSurfaces()` 看起来是接好的。
//
// 所以：缺席 ⇒ `declarations: null`（读数如实是 false）；显式给 `[]` ⇒ **拒绝**
// （见 ②）。两条路都不许出现"看起来接好了"。
//
// ★ ② 显式给 `[]` 要**响亮地拒绝**，不是静默接受
//
// 上面说了 `[]` 的行为等于"没有连接器层"，但它读起来是装好的。那是一种
// **两个方向都会骗人**的配置：写下它的人要么想表达"这个部署不许任何连接器工具"
// （那需要的是拒绝语义，不是空表），要么是生成配置的代码出了错。
// 两种情况下**静默接受**都让"我配了"与"我配错了"同形，所以这里具名拒绝，
// 并在理由里写清"想表达没有连接器就**别设这个键**"。
//
// ★ ③ 重名工具必须在**装配期**停下来（`none` ≠ `ambiguous`）
//
// 本模块用 `registry.mjs` 的 `toolOwnershipOf()`（**同一份**归属算法）
// 在装配期先算一遍：两个及以上连接器声明了同名工具时**具名拒绝**。
//
// 为什么不能等到判定时"折成不归它管"：`none`（真的没人声明）与
// `ambiguous`（有人声明但说不清是谁）在判定面那个 `string|null` 端口上
// **折成同一个 `null`**，而 `null` 的含义是"交给策略门"——也就是
// **连接器层对那个工具名不再有意见**。于是：
//
//   > 一次"新增了一个重名工具"的声明，
//   > 与一次"这些工具从来就不归连接器管"的配置，
//   > 在判定面的读数上是同一个 `unattributed`——
//   > 只不过前者的后果是那几个工具的连接器策略**被静默免掉**。
//
// 装配期拒绝把这件事变成一次**能看见的**启动失败。
//
// ★ ④ 与 `scope-port.mjs` 同一条纪律：配了却解释不通 ⇒ **抛**，不是"当作没配"
//
//   > 一个"读不出来就当作没配"的组合根，
//   > 与一个"这个部署确实没有连接器"的部署，在强制面读数上长得一样。
//
// ★ ⑤ 归属**不额外配一份表**
//
// `resolveConnectorId` 是**推导**出来的（`registry.connectorForTool`），
// 不是部署再配一遍 `{工具名: 连接器 id}`。那份映射已经在声明里了
// （每个连接器都列了自己的工具），再配一份就是同一件事写两遍——
// 而两份写法迟早会分叉，分叉那天表现为"策略按另一份生效"。
//
// ★ ⑥ 本模块**不**建 registry
//
// 它只做"读 + 校验 + 推导"，然后交回 `declarations`，由 `assemble.mjs`
// 建**那一份** registry（判定面与反馈面共用的那一份）。
// 在这里顺手建一个"只为了算重名"的 registry 会造出第二个对象，
// 而"两个 registry"正是 `assemble.mjs` 那段注释警告过的形状
// （判定面读的那本账没人写、反馈面写的那本账没人读）。
//
// ---------------------------------------------------------------------------
// ★★★ ⑦ 已知限度：**推导式归属让登记表的头号教义不可达**
//
// 这一条**曾经**是本模块最要紧的边界，而它在本批**被部分关闭了**。
// 关掉它的那条依据是 ⑧；这里把**关闭前**的形状与**仍未关**的部分一起留着，
// 因为读到"F-21 判定面已接线"的人最容易产生的两个误解正好分居两侧。
//
// `registry.mjs` 文件头 ① 的头号教义是：
//
//   「未声明的工具**必须拒绝** —— 没见过就放行，
//     等于任何人在外部加一个工具就等于加一个后门」
//
// ⑤ 那一版的 `resolveConnectorId` **只**按**工具名在不在某份声明里**归属。
// 于是一个**没被声明的**工具名归属不到任何连接器 ⇒
// `decision-port.mjs` 把它记成 `unattributed` ⇒ **登记表根本不会被问到**。
//
//   > 一个"要触发『未声明就拒绝』、得先把这个工具归属到某个连接器，
//   > 而归属本身要求它已经被声明"的接线，
//   > 与一个"从来没有那条教义"的接线，在每一次真调用的读数上
//   > 都是同一个 `unattributed`——只不过前者的文件头里**明确写着**不许这样。
//
// ★★★ 而它**不是**"净效果仍然是拒绝、所以不严重"。实测（`scratch/_probe-mcp-namespace.mjs`，
// 显式 `target`，策略门是**放行的桩**，好让"谁在说话"看得清楚）：
//
//   | 工具名 | ⑤ 版（只有声明推导） |
//   |---|---|
//   | `mcp__github__delete_repo`（`github` 是已知连接器，`delete_repo` 没声明） | **`allow`** |
//   | `list_issues`（逐字声明过） | `allow` + 理由「[连接器 github] 策略是 allow…」 |
//
//   第一行就是那个洞：命名空间**明明认得出来**，却因为名字没被逐字声明过而被
//   当作"不认识" ⇒ 登记表连问都没被问 ⇒ 一个**已登记的连接器的工具**被放过去了。
//
//   > 一个"命名空间明明认得出来、却因为名字没被逐字声明过而把它当作不认识"的归属，
//   > 与一个"根本没有连接器层"的归属，在这一次调用的读数上是同一个 `allow`——
//   > 只不过前者**刚好把一个已登记的连接器的工具放过去了**。
//
// ★ 今**仍未关**的部分（见 ⑧ 末段与人工介入清单）：命名空间**认不出来**的那一类
//   （`mcp__evil__x`：一个没有任何已知连接器占着的 MCP 命名空间）。
//   它今天仍然落到政策门。要按教义拒它，需要一个新的端口把
//   "连接器形状、但命名空间不认识"这件事表达出来——`resolveConnectorId` 的
//   值域是 `string|null`，装不下"拒"。这件事**没有**被本批偷偷做掉。
//
// 判据钉在 `plugins/root-row.test.mjs` 的「归属的**边界**」那一条上
// （它已被本批改成钉**新的**读数：命名空间已知 ⇒ 登记表被问到 ⇒ 拒）。
//
// ---------------------------------------------------------------------------
// ⑧ ★★★ 归属的**两条**依据：命名空间在前，声明推导在后
//
// 本模块的 `resolveConnectorId` 现在按这个顺序判：
//
//   ① `namespaceOf(已知 id, 工具名)` —— 认 `mcp__<id>__` 前缀。
//      ★ 它与"这个名字有没有被声明过"**无关**，这正是它能触发
//        「未声明就拒绝」的原因：归属先成立，登记表才**问得到**。
//   ② 声明推导（`owners`）—— 兜住"连接器声明了一个 **DSH 核心工具名**"
//      这一类。那种名字没有 `mcp__` 前缀 ⇒ ①认不出 ⇒ 落到这里。
//
//   ★ ② 保留下来了，而理由**不是**"向后兼容"：它是今天**唯一**能让
//     `connectorDecided` 计数动起来的路径（既有夹具全是这种形状）。
//     去掉它会让全部既有用例静默变成"连接器层从不插话"——一组
//     仍然全绿的用例，验的东西却少了一半。
//
//   ★ 顺序**不能**反过来：反过来的话，一个既带命名空间、又恰好被
//     声明推导认出的名字会走 ②，而那正是"未声明就会被 ② 漏掉"的老路。
//     两种顺序在**已声明的**名字上给出同一个 id——差别只在未声明的那一类。
//
// 名字契约来自 DSH 的源码，不在本仓：`packages/mcp/mcp-client/src/tools.ts`
// 的 `publicToolName`（`mcp__<serverName>__<rawName>` + 归一化/截断时的 12 位
// SHA-256 后缀）。逐字镜像在 `../connectors/public-name.mjs`，并有**一条对着
// DSH 真源码对跑**的用例（`public-name.test.mjs` ①a）。
//
// ★ `serverName`（DSH 插件配置里的命名空间）与 `connectorId`（Legion 声明里的 id）
//   是同一个字符串——这是**部署契约**，本仓**无法**验证它。不匹配的后果是
//   命名空间认不出 ⇒ ① 落空 ⇒ 交给政策门（**不是**"拒掉一切"）：
//
//   > 一个"认不出就拒掉一切"的实现，与一个"认不出就什么都不做"的实现，
//   > 在安全上是相反的，而在**可诊断性**上同样糟——
//   > 前者会把一次配置笔误表现成"所有连接器工具都坏了"。
//
// @module runtime/dsh-composition/connector-port
// ============================================================================

import { declareConnector, toolOwnershipOf } from '../connectors/registry.mjs'
import { namespaceOf } from '../connectors/public-name.mjs'

export const CONNECTOR_PORT_VERSION = 'legion/connector-port@1'

/**
 * 部署配置把连接器声明交给 Runtime 子进程用的环境键。
 *
 * ★ 走环境而不是补丁 YAML，与 `scope-port.mjs` 是**同一条理由**：
 *   `PatchOptions.config` 是**数据**，它装不下 `resolveConnectorId`
 *   那个函数（`pre-execute.mjs` 记的是同一条）。而且声明本身要经
 *   `declareConnector` 归一化与校验——装配期做这件事，读的人才拿得到
 *   具名拒绝而不是"某个字段恰好是 undefined"。
 *
 * ★ 与 `EXECUTION_PLANE_CONFIG_KEYS.CONNECTOR_TARGETS`（`runtime.connectorTargets`）
 *   是**两件事**，不能混：
 *   · 那个键给的是**连接目标**（连去哪儿：`command` / `url`）
 *   · 本键给的是**策略声明**（控制面 team-hub 的冻结记录：工具、能力、风险）
 *   两者由 `runtime/connectors/target-binding.mjs` 的 `bindConnectorTargets()`
 *   合起来——缺任何一半都被它具名拒（见那一侧的文件头）。
 */
export const CONNECTOR_PORT_ENV_KEY = 'LEGION_CONNECTOR_DECLARATIONS'

/**
 * 本模块从环境读取的键（**表**形态）。
 *
 * ★ 这张表是给 `scripts/config/config.test.mjs` 用的：那条判据要求
 *   `runtime/config-schema.mjs` 的 `fields` **恰好等于**源码里几张键名表的并集
 *   （不许多、不许少）。手抄一份进 schema 会在两个方向上撒谎——
 *   所以这里导出一张表，让判据从**源码**反查，而不是从我的记忆里。
 */
export const CONNECTOR_PORT_ENV_KEYS = Object.freeze([CONNECTOR_PORT_ENV_KEY])

export const CONNECTOR_PORT_CODES = Object.freeze({
  BAD_INPUT: 'connector-port-bad-input',
  /** 环境里那份文本不是合法 JSON。 */
  BAD_TEXT: 'connector-port-bad-text',
  /** 解析出来不是数组。 */
  NOT_A_LIST: 'connector-port-not-a-list',
  /** 显式给了空表——见文件头 ②。 */
  EMPTY_LIST: 'connector-port-empty-list',
  /** 一个工具名被两个及以上连接器声明——见文件头 ③。 */
  AMBIGUOUS_TOOLS: 'connector-port-ambiguous-tools',
  /** 某一条声明没通过 `declareConnector` 的校验。 */
  BAD_DECLARATION: 'connector-port-bad-declaration',
})

/** 与 `scope-port.mjs` / `product/execution-plane-config.mjs` 同一套状态词：缺席是一件事，不是一个空值。 */
export const CONNECTOR_PORT_STATES = Object.freeze({
  CONFIGURED: 'configured',
  ABSENT: 'absent',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 从环境里取那份连接器声明。
 *
 * @param {object} p
 * @param {object} p.env
 * @returns {{
 *   state: string,
 *   declarations: ReadonlyArray<object>|null,
 *   resolveConnectorId: Function|null,
 *   toolCount: number,
 *   reason: string|null,
 * }}
 */
export function connectorPortFromEnv({ env } = {}) {
  if (!isPlainObject(env)) {
    throw fail(CONNECTOR_PORT_CODES.BAD_INPUT, 'connectorPortFromEnv 需要一个环境对象')
  }

  const raw = env[CONNECTOR_PORT_ENV_KEY]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return Object.freeze({
      state: CONNECTOR_PORT_STATES.ABSENT,
      declarations: null,
      resolveConnectorId: null,
      toolCount: 0,
      reason: `环境里没有「${CONNECTOR_PORT_ENV_KEY}」。这**不是**"没有连接器策略"的等价物——`
        + '它是一个要由组合根显式处置的缺席：执行面在没有声明表时**不建**登记表，'
        + '于是 `enforcementSurfaces().connectorJudgment` 如实报 `false`',
    })
  }

  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch (err) {
      throw fail(
        CONNECTOR_PORT_CODES.BAD_TEXT,
        `「${CONNECTOR_PORT_ENV_KEY}」不是合法 JSON（${err?.message ?? err}）。`
        + '**不忽略这一段**：一个被静默丢掉的声明表，与一份"这个部署没有连接器"的配置，读数一样',
      )
    }
  }

  if (!Array.isArray(list)) {
    throw fail(
      CONNECTOR_PORT_CODES.NOT_A_LIST,
      `「${CONNECTOR_PORT_ENV_KEY}」必须是一个数组（每条一份连接器声明），`
      + `实际是 ${list === null ? 'null' : typeof list}`,
    )
  }

  // ★ 见文件头 ②：显式空表**具名拒绝**，因为它读起来是"接好了"而行为是"不存在"。
  if (list.length === 0) {
    throw fail(
      CONNECTOR_PORT_CODES.EMPTY_LIST,
      `「${CONNECTOR_PORT_ENV_KEY}」是一个**空**数组。不按"这个部署没有连接器"接受——`
      + '空表会让组合根建出一份**零连接器**的登记表，于是 `enforcementSurfaces().connectorJudgment`'
      + '报 `true`（"判定面装好了"），而任何工具都归属不到连接器 ⇒ 它**一次判定都不会做**。'
      + '想表达"这个部署没有连接器"，请**不要设这个键**（那时读数如实是 `false`）',
    )
  }

  const byId = new Map()
  const declarations = []
  for (const [i, entry] of list.entries()) {
    let decl
    try {
      // ★ 一律过 `declareConnector`，包括"看起来已经声明过"的那种：
      //   `createRegistry` 也会对 `version` 已匹配的输入跳过重新声明，
      //   但**装配期**是唯一一处可以承受"再验一遍"的地方。
      //   > 一个"因为对方看起来已经验过就跳过"的装配点，
      //   > 与一个"不信任上游、自己再验一遍"的装配点，
      //   > 在健康时的读数是同一个东西——只不过前者把**一处**校验错误
      //   > 变成了"某个字段恰好是 undefined"，而那个形状要调很久才看得出来。
      decl = declareConnector(entry)
    } catch (err) {
      // ★ 保留原判据的具名码（`connector-declaration-malformed` 等），只补上
      //   "是**第几条**"——不然一个三十条声明的部署只会得到一句"某处不对"。
      //   > 一个"报得出哪一条坏了"的装配错误，
      //   > 与一个"只报'声明不合法'"的装配错误，排查成本差一个数量级。
      throw fail(
        CONNECTOR_PORT_CODES.BAD_DECLARATION,
        `「${CONNECTOR_PORT_ENV_KEY}」第 ${i + 1} 条（${entry?.connectorId ?? '没有 connectorId'}）`
        + `没通过校验：${err?.message ?? err}。原判据码：${err?.code ?? '（无）'}`,
      )
    }
    if (byId.has(decl.connectorId)) {
      throw fail(
        CONNECTOR_PORT_CODES.BAD_DECLARATION,
        `「${CONNECTOR_PORT_ENV_KEY}」里连接器 id ${decl.connectorId} 出现了两次——`
        + '重复时后一条会遮蔽前一条，于是先写那条的策略与工具清单静默失效',
      )
    }
    byId.set(decl.connectorId, decl)
    declarations.push(decl)
  }

  // ★ 见文件头 ③：与 `createRegistry` 用**同一份**归属算法。
  const owners = toolOwnershipOf(byId)
  const ambiguous = [...owners.entries()].filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => `${name}（${ids.join(' / ')}）`).sort()
  if (ambiguous.length > 0) {
    throw fail(
      CONNECTOR_PORT_CODES.AMBIGUOUS_TOOLS,
      `有工具名被**两个及以上**连接器声明：${ambiguous.join('；')}。`
      + '不按"那就当它不归连接器管"处理——那会让这几个工具的连接器策略**静默失效**，'
      + '而读数与"从没声明过这个工具"完全一样。请改名，或让其中一个连接器不要声明它',
    )
  }

  const toolCount = [...owners.values()].reduce((n, ids) => n + ids.length, 0)
  const knownIds = [...byId.keys()]

  return Object.freeze({
    state: CONNECTOR_PORT_STATES.CONFIGURED,
    declarations: Object.freeze(declarations),
    // ★ 见文件头 ⑤：**推导**，不额外配一份映射表。
    //   ★ 而它必须**永不抛**：它落在桥的 `decide` 端口上，而那条路径
    //     （`tool-request.mjs` 的 `await decide(...)`）**没有 try/catch**。
    //     抛出去会炸掉整条 pre-execute 瀑布。取不到就返回 `null`
    //     （"认不出"），由 `decision-port.mjs` 折成"原样交给政策门"。
    //
    // ★★★ 两条依据，**命名空间在前**（见文件头 ⑧）。
    //
    //   ① **命名空间**（`mcp__<id>__`）：与"这个名字有没有被声明过"**无关**。
    //      这是 `registry.mjs` 那条「未声明的工具必须拒绝」在生产里**唯一**
    //      可达的路径：一个真 MCP 工具名一定带命名空间，于是它归属得到，
    //      于是登记表**会被问到**，于是它答"没声明" ⇒ **拒**。
    //
    //      ⚠️ 少了这一条，那个洞的形状是这样的（实测，见 `_probe-mcp-namespace.mjs`）：
    //        `mcp__github__delete_repo`（`github` **是**一个已知连接器，
    //        但 `delete_repo` 没在它声明里）⇒ **`allow`**。
    //        因为随后的推导式归属只认"逐字列在声明里的名字"——
    //        而登记表甚至**没被问过**。
    //
    //      > 一个"命名空间明明认得出来、却因为名字没被逐字声明过而把它
    //      > 当作不认识"的归属，与一个"根本没有连接器层"的归属，
    //      > 在这一次调用的读数上是同一个 `allow`——只不过前者
    //      > **刚好把一个已登记的连接器的工具放过去了**。
    //
    //   ② **声明推导**（`owners`）：兜住"连接器声明了一个 **DSH 核心工具名**"
    //      这一类（本仓今天的夹具全是这种：`github` 声明 `git-status`）。
    //      那种名字没有 `mcp__` 前缀 ⇒ ①认不出 ⇒ 落到这里。
    //      ★ 保留它**不是**为了兼容，是因为它是今天**唯一**能让
    //        `connectorDecided` 计数动起来的路径；去掉它会让全部既有用例
    //        静默变成"连接器层从不插话"。
    resolveConnectorId: (projection) => {
      try {
        const name = projection?.toolName
        if (typeof name !== 'string' || name.trim() === '') return null
        const trimmed = name.trim()
        const ns = namespaceOf(knownIds, trimmed)
        if (ns.state === 'matched') return ns.connectorId
        const id = owners.get(trimmed)
        return id !== undefined && id.length === 1 ? id[0] : null
      } catch {
        return null
      }
    },
    toolCount,
    reason: null,
  })
}

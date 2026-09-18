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
// 这一条**不是**待办，是一个必须写在最前面的边界。读到"F-21 判定面已接线"
// 的人，最容易产生的下一个误解就是"那条『未声明就拒绝』的教义在生产里生效了"。
// **它没有。**
//
// `registry.mjs` 文件头 ① 的头号教义是：
//
//   「未声明的工具**必须拒绝** —— 没见过就放行，
//     等于任何人在外部加一个工具就等于加一个后门」
//
// 而本模块的 `resolveConnectorId`（见 ⑤）是按**工具名在不在某份声明里**
// 来归属的。于是一个**没被声明的**工具名归属不到任何连接器 ⇒
// `decision-port.mjs` 把它记成 `unattributed` ⇒ **登记表根本不会被问到**。
//
//   > 一个"要触发『未声明就拒绝』、得先把这个工具归属到某个连接器，
//   > 而归属本身要求它已经被声明"的接线，
//   > 与一个"从来没有那条教义"的接线，在每一次真调用的读数上
//   > 都是同一个 `unattributed`——只不过前者的文件头里**明确写着**不许这样。
//
// 三点必须一起说清，否则这条边界会被读成两个极端（"没有洞"或"全完了"）：
//
//   (a) 教义**在模块层是好的**。`createRegistry(...).decide({connectorId,
//       toolName})` 对未声明的工具返回 `decision: 'deny'`、
//       `code: 'connector-tool-not-declared'`，用例覆盖着它。
//
//   (b) 用**显式**解析器（比如 `() => 'github'`）也能在生产路径上触发它——
//       `root.test.mjs` ⑨④ 就是这么测的。代价是部署侧必须自己知道
//       "这次调用归哪个连接器"；而**推导式**解析器把这个前提吃掉了。
//
//   (c) 净效果**今天仍然是拒绝**，但功劳在**政策门**：未知工具在
//       `tool-capability.mjs` 里 direction 是 `write`（fail closed）、
//       `requiresApproval` 为真，所以政策门不会放它过去。
//       ⇒ 真正剩下的洞是**一个名字撞上已知核心工具**的未声明连接器工具：
//         那种名字在本模块眼里"不在任何声明里"、在政策门眼里是已知的低风险
//         工具 ⇒ `allow`。要堵它，归属必须基于**来源**（这次调用是不是
//         走连接器发出去的），而不是基于名字——而那需要一条本仓**没有**的
//         来源信号（DSH 那一侧的 MCP 工具命名/路由）。这件事已列入
//         人工介入清单。
//
// 判据钉在 `plugins/root-row.test.mjs` 的「归属的**边界**」那一条上。
// @module runtime/dsh-composition/connector-port
// ============================================================================

import { declareConnector, toolOwnershipOf } from '../connectors/registry.mjs'

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

  return Object.freeze({
    state: CONNECTOR_PORT_STATES.CONFIGURED,
    declarations: Object.freeze(declarations),
    // ★ 见文件头 ⑤：**推导**，不额外配一份映射表。
    //   ★ 而它必须**永不抛**：它落在桥的 `decide` 端口上，而那条路径
    //     （`tool-request.mjs` 的 `await decide(...)`）**没有 try/catch**。
    //     抛出去会炸掉整条 pre-execute 瀑布。取不到就返回 `null`
    //     （"认不出"），由 `decision-port.mjs` 折成"原样交给政策门"。
    resolveConnectorId: (projection) => {
      try {
        const name = projection?.toolName
        if (typeof name !== 'string' || name.trim() === '') return null
        const id = owners.get(name.trim())
        return id !== undefined && id.length === 1 ? id[0] : null
      } catch {
        return null
      }
    },
    toolCount,
    reason: null,
  })
}

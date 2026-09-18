// runtime/connectors/public-name.mjs
// ============================================================================
// F-21：DSH 给 MCP 工具起的**公开名**——连接器层要能把一次调用**归属**到连接器。
//
// ---------------------------------------------------------------------------
// ★★★ ① 这一层存在的理由：让登记表那条「未声明就拒绝」**可达**
//
// `registry.mjs` 文件头 ① 的头号教义是：
//
//   「未声明的工具**必须拒绝**——没见过就放行，
//     等于任何人在外部加一个工具就等于加一个后门」
//
// 而在此之前那条教义在生产里**不可达**（会话报告 §10.46 记的就是这条）：
// 归属是按"工具名在不在某份声明里"推导的，于是一个**没被声明**的工具名
// 归属不到任何连接器 ⇒ 登记表**根本不会被问到**。
//
//   > 一个"要触发『未声明就拒绝』、得先把这个工具归属到某个连接器，
//   > 而归属本身要求它已经被声明"的接线，
//   > 与一个"从来没有那条教义"的接线，在每一次真调用的读数上
//   > 都是同一个 `unattributed`——只不过前者的文件头里**明确写着**不许这样。
//
// 本模块给出一条**与声明无关**的归属依据：**名字来自哪个命名空间**。
// 于是"未声明"这件事第一次可以被表达出来：
// 命名空间认得出来 ⇒ 归属得到 ⇒ 登记表被问到 ⇒ 它说"没声明" ⇒ **拒**。
//
// ---------------------------------------------------------------------------
// ★★ ② 规范来自 DSH，来自**读源码**，不是从名字猜的
//
// `packages/mcp/mcp-client/src/tools.ts`（本仓检出里逐字读过）：
//
//   ```ts
//   const joined = `mcp__${serverName}__${rawName}`
//   const normalized = joined.replace(INVALID_NAME_CHARS, '_')
//   if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
//   const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
//   return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
//   ```
//
// 常量：`MAX_PUBLIC_NAME_LENGTH = 64`、`INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g`、
// `HASH_LENGTH = 12`。
//
// ★★★ 那个 `normalized === joined` 的**合取**是最容易实现错的一处：
//   它是"**有没有发生过替换**"，而不是"名字长不长"。
//   于是 `mcp__github__list issues`（中间一个空格）**会**被加哈希——
//   哪怕它只有 24 个字符、远没到 64。
//
//   > 一个"看着像、按字符替换实现"的镜像，与一个"逐字镜像"的实现，
//   > 在**干净名字**上的读数是同一个字符串——
//   > 只不过前者对任何"需要归一化"的工具名算出一个**DSH 从来不会产生**的名字，
//   > 于是那个工具在登记表里**查不到** ⇒ 一个合法的工具被拒。
//
//   所以本模块的 `publicToolName` 必须与上面那段**逐字等价**，
//   而判据里有一条**对着 DSH 真实现**跑的一致性用例（见 `.test.mjs`）。
//
// ---------------------------------------------------------------------------
// ★★★ ③ 本模块**不**"解析"公开名（DSH 明令禁止，而且做不到）
//
// `tools.ts:9-10` 逐字写着：
//
//   「The raw name is only ever sent on the wire (`tools/call`);
//     **the public name is never parsed to recover it**.」
//
// 本模块**遵守**这条：它**不**从公开名反推 rawName。它做的是两件别的事：
//
//   · `publicToolName(id, raw)` —— **正向**算出公开名（声明那一侧用它）；
//   · `namespaceOf(ids, publicName)` —— 只取**命名空间**（`mcp__<id>__`
//     这个前缀），因为那是 DSH 自己文档化的"服务器限定命名空间"
//     （`tools.ts:100` 逐字："this server's `mcp__<serverName>__` namespace"）。
//
// 两者的区别是本模块的**中心设计**：
//
//   > 一个"从公开名里把 rawName 拆出来"的实现——
//   > 与一个"正向算出公开名再逐字比对"的实现，
//   > 在**干净名字**上的读数是同一个字符串；
//   > 只不过前者在 `rawName` 自己含 `__` 时会拆错
//   > （`mcp__github__a__b`：是 `github`/`a__b`？还是 `github__a`/`b`？），
//   > 而 DSH 的公开名**本来就不可逆**——所以那个实现在**猜**。
//
// ---------------------------------------------------------------------------
// ★★ ④ `serverName` 与 `connectorId` 是**部署契约**，不是我能验证的事
//
// 本模块假定 DSH 插件配置里的 `serverName` 与 Legion 连接器声明里的
// `connectorId` **是同一个字符串**。我**无法**从本仓验证这一点：
// 那两处配置分别由 DSH 侧与产品侧给出。
//
// ★ 所以不匹配时的后果被**有意**设计成"退回到今天的行为"：
//   前缀认不出 ⇒ 归属不到连接器 ⇒ 原样交给政策门（**不是**"拒掉一切"）。
//   精确定义见 `namespaceOf` 的返回契约。
//
//   > 一个"认不出就拒掉一切"的实现，与一个"认不出就什么都不做"的实现，
//   > 在"安全"上是相反的，而在**可诊断性**上同样糟：
//   > 前者会把一次配置笔误表现成"所有连接器工具都坏了"。
//
// @module runtime/connectors/public-name
// ============================================================================

import { createHash } from 'node:crypto'

export const PUBLIC_NAME_VERSION = 'legion/connector-public-name@1'

/**
 * DSH 的公开名契约（`packages/mcp/mcp-client/src/tools.ts`）。
 *
 * ★ 逐字镜像那三个常量：它们是 **DSH 的线协议常量，不是配置**
 *   （`tools.ts:45-46` 逐字写着 "Wire-protocol constant, not configuration"）。
 *   抄成"可配置"会让本模块在某天与 DSH 分叉，而分叉的后果是
 *   "文件名对不上 ⇒ 合法工具被拒"。
 */
export const PUBLIC_NAME_LIMITS = Object.freeze({
  MAX_LENGTH: 64,
  HASH_LENGTH: 12,
  /** 命名空间前缀：`mcp__`。 */
  PREFIX: 'mcp__',
  /** 命名空间分隔符：`__`。 */
  SEPARATOR: '__',
})

/** DSH 允许的字符集：`[A-Za-z0-9_-]`；其余一律替换成 `_`。 */
export const PUBLIC_NAME_INVALID_CHARS = /[^A-Za-z0-9_-]/g

export const PUBLIC_NAME_CODES = Object.freeze({
  BAD_INPUT: 'connector-public-name-bad-input',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * DSH 会给一个 MCP 工具起什么公开名。**与 `tools.ts` 的 `publicToolName` 逐字等价。**
 *
 * @param {string} serverName DSH 插件配置里的命名空间（本契约里等于 `connectorId`）
 * @param {string} rawName 连接器自己那一侧的工具名
 * @returns {string}
 */
export function publicToolName(serverName, rawName) {
  const server = String(serverName ?? '').trim()
  const raw = String(rawName ?? '').trim()
  if (server === '') {
    throw fail(PUBLIC_NAME_CODES.BAD_INPUT, 'publicToolName 需要 serverName（连接器的命名空间）')
  }
  if (raw === '') {
    throw fail(PUBLIC_NAME_CODES.BAD_INPUT, `连接器 ${server} 的工具名不能为空`)
  }

  const joined = `${PUBLIC_NAME_LIMITS.PREFIX}${server}${PUBLIC_NAME_LIMITS.SEPARATOR}${raw}`
  const normalized = joined.replace(PUBLIC_NAME_INVALID_CHARS, '_')
  // ★★★ 见文件头 ②：这里判的是"**有没有发生过替换**"，不是"名字长不长"。
  //   写成 `normalized.length <= MAX` 会漏掉"短名字但含非法字符"那一类，
  //   而那一类恰好是本仓最可能出现的（工具名里带空格/点/斜杠）。
  if (normalized === joined && normalized.length <= PUBLIC_NAME_LIMITS.MAX_LENGTH) {
    return normalized
  }
  const hash = createHash('sha256')
    .update(`${server}\0${raw}`)
    .digest('hex')
    .slice(0, PUBLIC_NAME_LIMITS.HASH_LENGTH)
  const keep = PUBLIC_NAME_LIMITS.MAX_LENGTH - PUBLIC_NAME_LIMITS.HASH_LENGTH - 1
  return `${normalized.slice(0, keep)}_${hash}`
}

/**
 * 一次调用属于哪个**命名空间**——也就是哪个连接器。
 *
 * 这是"与声明无关"的归属依据：只要公开名是 DSH 起的，命名空间就在名字里，
 * 而**不需要**这个名字被声明过。
 *
 * ★★ 返回判别式，三种结果**必须分得开**（与 `registry.attributeTool` 同一条纪律）：
 *
 *   · `{ state: 'matched', connectorId }`  —— 恰好一个已知 id 的前缀命中
 *   · `{ state: 'foreign', connectorId: null }` —— 有 `mcp__` 前缀，但**没有任何
 *      已知连接器**占着那个命名空间
 *   · `{ state: 'not-mcp', connectorId: null }` —— 根本没有 `mcp__` 前缀
 *     （DSH 自己的核心工具，例如 `git-status`）
 *
 *   `foreign` 与 `not-mcp` 在**行动**上一样（都归属不到 ⇒ 交给政策门），
 *   但读数必须分开：前者是"**有一个外部 MCP 服务器，而它不在我的登记表里**"
 *   （一次漏配，或一次**未经声明的挂载**），后者是"这不是 MCP 工具"。
 *
 *   > 一个把这两种折成同一个 `null` 的归属，与一个分得开它们的归属，
 *   > 在"多数调用"上是同一个读数——只不过前者让"有人挂了一个我没声明的
 *   > MCP 服务器"这件事，在本层的日志里与"一个普通的读工具"长得一样。
 *
 * ★ 多个命中时取**最长**的那个（`mcp__a__` 与 `mcp__a__b__` 同时命中
 *   `mcp__a__b__x` ⇒ 后者）。这不是"随便挑一个"：命名空间是**嵌套**的，
 *   最长的那个是唯一没有被截断的。
 *
 * ★ 永不抛：它落在没有 try/catch 的那条决策路径上（见 `connector-port.mjs` ④a）。
 *
 * @param {Iterable<string>} knownIds 已知的连接器 id（来自声明）
 * @param {string} publicName 投影里的工具名
 */
export function namespaceOf(knownIds, publicName) {
  const name = typeof publicName === 'string' ? publicName.trim() : ''
  if (!name.startsWith(PUBLIC_NAME_LIMITS.PREFIX)) {
    return Object.freeze({ state: 'not-mcp', connectorId: null, matchedLength: 0 })
  }
  let best = null
  let bestLength = 0
  try {
    for (const id of knownIds ?? []) {
      const key = String(id ?? '').trim()
      if (key === '') continue
      const prefix = `${PUBLIC_NAME_LIMITS.PREFIX}${key}${PUBLIC_NAME_LIMITS.SEPARATOR}`
      // ★ 只比**前缀**，不拆 `__`：见文件头 ③。
      if (name.startsWith(prefix) && prefix.length > bestLength) {
        best = key
        bestLength = prefix.length
      }
    }
  } catch {
    // 迭代器抛（坏输入）⇒ 当作认不出，**不**把决策路径炸掉。
    return Object.freeze({ state: 'foreign', connectorId: null, matchedLength: 0 })
  }
  if (best === null) {
    return Object.freeze({ state: 'foreign', connectorId: null, matchedLength: 0 })
  }
  return Object.freeze({ state: 'matched', connectorId: best, matchedLength: bestLength })
}

/** `mcp__<id>__` 这个前缀（`namespaceOf` 的匹配单元，导出给判据与文档用）。 */
export function namespacePrefix(connectorId) {
  const id = String(connectorId ?? '').trim()
  if (id === '') throw fail(PUBLIC_NAME_CODES.BAD_INPUT, 'namespacePrefix 需要 connectorId')
  return `${PUBLIC_NAME_LIMITS.PREFIX}${id}${PUBLIC_NAME_LIMITS.SEPARATOR}`
}

/** 一个公开名是不是 DSH 给 MCP 工具起的（**只**看前缀，不解释它）。 */
export function isMcpPublicName(name) {
  return typeof name === 'string' && name.trim().startsWith(PUBLIC_NAME_LIMITS.PREFIX)
}

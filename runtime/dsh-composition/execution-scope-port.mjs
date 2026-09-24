// runtime/dsh-composition/execution-scope-port.mjs
// ============================================================================
// **执行面授权表 → 命令/网络/MCP 端口**（PRT-605 的最后一根线）。
//
// ## 它填的是哪个洞
//
// `execution-scope.mjs` 的三个判定器（`checkCommand` / `checkNetwork` / `checkMcp`）
// 早就写好了，用例全绿——而**生产里没有它们的位置**：
// `production-scope-wiring.test.mjs` ② 把这件事钉住了（桥的参数表里没有
// `executionScope`，`enforcementSurfaces()` 的键集里也没有它）。
//
// 后果与 `pathScope` 那次**同形、但更重**：`pathScope` 至少还有一格
// `pathScope: false` 的读数能表达"它应该在这里而没接上"；这两道**连位置都没有**，
// 于是"没接"与"没有这道检查"在生产读数上是同一个东西。
//
//   > 一个「端口在、没人给它值」的强制面，
//   > 与一个「端口根本不存在」的强制面，在 `enforcementSurfaces()` 上是
//   > `false` 与**什么都没有**——而后者连"我该配点什么"都问不出来。
//
// ## ★ 本端口**不推导事实**——它只读 `projection.scopeFacts`
//
// 事实在投影里算一次（`scope-facts.mjs`），本模块**只读**。理由写在那份模块头上：
// 六处各自兜底"今天恰好一致"，而它们下一次不一致会表现为"某个强制点没拦住"。
//
// ## ★ 两个 fail-closed 决定
//
// ① **判定器抛异常 ⇒ 拒绝**（带码）。与 `scopeGuard` 同一条口径：
//    "检查本身出错"必须变成拒绝，不能把强制面炸掉——也不能变成放行。
// ② **能力说是这一类、而事实里没有 ⇒ 拒绝**。`scopeFacts.command` 存在而
//    `argv === null`，意思是"这是一个会起进程的工具，而它这次没给命令"——
//    那不是"与命令无关"，那是**证明不了它要起什么**。
//
// ## ★★★ ③ MCP：**2026-09-24 已裁** —— `mcp` 段降级为"本岗位允不允许调 MCP"一个布尔
//
// `execution-scope.mjs` 的 MCP 授权按 `server__tool` 对（`splitMcpTool` 要求
// `__` **恰好一个**）。而 DSH 送上来的公开名是 `mcp__<server>__<rawName>`
// ——它有**两个** `__`。于是：
//
//   · 把线上名字直接喂给 `splitMcpTool` ⇒ 它按 `MCP_AMBIGUOUS_NAME` **拒**。
//     方向是安全的（拒），而**理由是错的**，且后果是"每一个 MCP 调用都被拒"
//     ——一个"配置笔误"与"这道检查坏了"会表现成同一句话。
//   · 想修就得**拆开公开名**去还原 `(server, rawName)`。而 DSH 的公开名
//     在归一化/截断时会被替换成 12 位 SHA-256 后缀（见 `../connectors/public-name.mjs` ②），
//     那时**还原不出来**；`packages/mcp/mcp-client/src/tools.ts:9-10` 逐字写着
//     "the public name is never parsed to recover it"。
//
// ⇒ 而且**更根本**：谁决定"这个岗位能调哪些 MCP 工具"这件事，
//   生产里**已经有一个权威**——F-21 的连接器登记表（`connectors/registry.mjs`），
//   它经 `connectorJudgment` 接在**同一个** `preExecute` 上，而且它的
//   `declaredToolNames` 正是"声明名 + 公开名"两个都认。
//
//   > 一个「两道检查各自维护一份 MCP 授权表」的组合，
//   > 与一个「其中一道的表更新了、另一道没更新」的组合，是同一个东西——
//   > 只不过前者的读数看起来像"MCP 授权被检查了两次"。
//
// ★★★ **业主 2026-09-24 裁决（§5 第 25 条采 ①）**：**F-21 连接器登记表为权威**，
//   本端口这一段的 MCP 授权**降级为"本岗位允不允许调 MCP"一个布尔**。于是今天分**三种**：
//
//   · 授权表里**没有** `mcp` 段 ⇒ 拒绝，码用判定器的 `MCP_SERVER_DENIED`，
//     理由"这个岗位没有 MCP 授权"。这条**不需要**拆名字，所以它是**真的**在判。
//   · 授权表里**有** `mcp` 段、且**含工具级声明** ⇒ 拒绝，码
//     `MCP_TOOL_LEVEL_DEPRECATED`。理由**不是**"未接"，而是"那一段今天不会有任何效力，
//     请把它删掉" —— 留着它的读数正是这次裁决要消灭的那一种：**配了却没生效**。
//   · 授权表里**有** `mcp` 段、且**不含工具级声明** ⇒ **放行**（段的存在即"允许"），
//     "能调哪些工具"交给**连接器登记表**判 —— 它经 `connectorJudgment` 接在**同一个**
//     `preExecute` 上。
//
//   > 一个"配了工具清单、而那份清单没有任何效力"的授权表，
//   > 与一个"配了工具清单、而权威在另一处"的授权表，在**值班的人**眼里是同一个东西 ——
//   > 只不过前者会在某次事故里被当成"我们限制过 MCP 工具"。
//
// ⇒ 净效果：MCP **不会**被静默放行（没有段就拒），也**不会**被静默拒成"名字有歧义"（理由给错）。
//
// @module runtime/dsh-composition/execution-scope-port
// ============================================================================

import { EXEC_CODES, checkCommand, checkMcp, checkNetwork, normalizeGrant } from './execution-scope.mjs'

export const EXECUTION_SCOPE_PORT_VERSION = 'legion/execution-scope-port@1'

/**
 * 部署配置把执行面授权表交给 Runtime 子进程用的环境键。
 *
 * ★ 与 `LEGION_PATH_SCOPE` 同渠道（环境而不是补丁 YAML）：授权表要经
 *   `normalizeGrant` 归一化，而 `PatchOptions.config` 是**数据**，装不下
 *   归一化后的冻结结构（`scope-port.mjs:56` 记的是同一条理由）。
 */
export const EXECUTION_SCOPE_PORT_ENV_KEY = 'LEGION_EXECUTION_SCOPE'

/** 本模块从环境读取的键（给 `scripts/config/config.test.mjs` 反查 schema 用）。 */
export const EXECUTION_SCOPE_PORT_ENV_KEYS = Object.freeze([EXECUTION_SCOPE_PORT_ENV_KEY])

export const EXECUTION_SCOPE_PORT_CODES = Object.freeze({
  BAD_INPUT: 'execution-scope-port-bad-input',
  /** 环境里那份文本不是合法 JSON。 */
  BAD_TABLE_TEXT: 'execution-scope-port-bad-table-text',
  /** 能力说这一类、而事实里没有——证明不了它要做什么。 */
  NO_FACTS: 'execution-scope-port-no-facts',
  /**
   * ★★★ 授权表的 `mcp` 段里还写着**工具级**授权 —— 而"哪些 MCP 工具可用"的权威
   * **只**在连接器登记表（F-21，2026-09-24 裁决 ①）。这不是"不通过"，是
   * "**这一段今天不会有任何效力，请删掉它**"。
   */
  MCP_TOOL_LEVEL_DEPRECATED: 'execution-scope-port-mcp-tool-level-deprecated',
})

/** 与 `scope-port.mjs` / `product/execution-plane-config.mjs` 同一套状态词。 */
export const EXECUTION_SCOPE_PORT_STATES = Object.freeze({
  CONFIGURED: 'configured',
  ABSENT: 'absent',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const deny = (code, reason, extra = {}) => Object.freeze({
  allowed: false, code, reason, ...extra,
})

const allow = (kind) => Object.freeze({ allowed: true, code: null, reason: null, kind })

/**
 * 授权表 → 端口。
 *
 * @param {object} p
 * @param {object} p.grant 已归一化的执行面授权表（`normalizeGrant()` 的产物）
 * @param {string} [p.platform]
 * @returns {(projection: object) => {allowed: boolean, code: string|null, reason: string|null}}
 * @throws {Error} 授权表不合法时（`exec-scope-*`，**原样上抛**）——装配期就拒
 */
export function createExecutionScopePort({ grant, platform } = {}) {
  if (!isPlainObject(grant)) {
    throw fail(EXECUTION_SCOPE_PORT_CODES.BAD_INPUT, 'createExecutionScopePort 需要一份执行面授权表对象')
  }
  // ★ 装配期归一化：表不合法**现在**就抛，而不是等第一次工具调用。
  //   一个"第一次调用时才炸"的授权表，把错误推迟到**已经有副作用的那一刻**。
  const normalized = normalizeGrant(grant)
  const plat = platform ?? null

  return function executionScopePort(projection) {
    if (!isPlainObject(projection)) {
      return deny(EXECUTION_SCOPE_PORT_CODES.BAD_INPUT, '执行面范围检查收到一个不是对象的投影')
    }
    const facts = projection.scopeFacts
    // 这次调用不出去做事（`file:*` / `repo:*` / `credential:*` …）⇒ 本端口无话可说。
    // ★ 这是**唯一**的"放行"分支，而它放行的判据是"事实表说这次调用不属于这一类"，
    //   不是"我没看懂"。
    if (facts === null || facts === undefined) return allow(null)
    if (!isPlainObject(facts)) {
      return deny(EXECUTION_SCOPE_PORT_CODES.BAD_INPUT, '投影上的 scopeFacts 不是对象（接线坏了）')
    }

    const kinds = Array.isArray(facts.kinds) ? facts.kinds : []

    // ---- ① 命令 ----------------------------------------------------------
    if (kinds.includes('command')) {
      if (facts.command === undefined || facts.command === null) {
        return deny(EXECUTION_SCOPE_PORT_CODES.NO_FACTS,
          '这次调用的能力里有起进程，而事实里没有命令这一项——证明不了它要起什么')
      }
      let verdict
      try {
        verdict = checkCommand({ argv: facts.command.argv, grant: normalized, platform: plat })
      } catch (err) {
        return deny(err?.code ?? EXEC_CODES.BAD_ARGV,
          `命令范围检查本身出错：${err?.message ?? String(err)}`)
      }
      if (verdict.allowed !== true) {
        return deny(verdict.code ?? EXEC_CODES.BAD_ARGV, verdict.reason ?? '没有给出理由',
          { kind: 'command' })
      }
    }

    // ---- ② 网络 ----------------------------------------------------------
    if (kinds.includes('network')) {
      if (facts.network === undefined || facts.network === null) {
        return deny(EXECUTION_SCOPE_PORT_CODES.NO_FACTS,
          '这次调用的能力里有出网，而事实里没有网络这一项——证明不了它要访问哪')
      }
      let verdict
      try {
        // ★ 方法缺省给 `GET`（与 `checkNetwork` 的默认值**同一个**字面量）：
        //   一个"端口给 POST、判定器认为 GET"的分歧，会让一条写请求按读判定走。
        verdict = checkNetwork({
          url: facts.network.url,
          method: typeof facts.network.method === 'string' && facts.network.method.trim() !== ''
            ? facts.network.method
            : 'GET',
          grant: normalized,
          redirectFrom: null,
        })
      } catch (err) {
        return deny(err?.code ?? EXEC_CODES.BAD_URL,
          `网络范围检查本身出错：${err?.message ?? String(err)}`)
      }
      if (verdict.allowed !== true) {
        return deny(verdict.code ?? EXEC_CODES.SCHEME_DENIED, verdict.reason ?? '没有给出理由',
          { kind: 'network' })
      }
    }

    // ---- ③ MCP（★★★ 本批**未接**，见文件头 ③）----------------------------
    if (kinds.includes('mcp')) {
      if (normalized.mcp === null) {
        // 授权表里没有 `mcp` 段 ⇒ 这一条是**真的**在判，而且不需要拆名字。
        return deny(EXEC_CODES.MCP_SERVER_DENIED, '这个岗位没有 MCP 授权', { kind: 'mcp' })
      }
      // ★ 段**存在** ⇒ "本岗位允许调 MCP"；而"能调哪些"的权威是**连接器登记表**（F-21）。
      //   于是这一段的**工具级内容**不再有任何效力 —— 留着它只会得到"配了却没生效"。
      const toolLevel = normalized.mcp.servers.filter(
        (s) => Array.isArray(s?.tools) && s.tools.length > 0,
      )
      if (toolLevel.length === 0) {
        // 段在、且不含工具级声明 ⇒ 允许（段的存在即"本岗位允许调 MCP"）
        return allow(null)
      }
      return deny(
        EXECUTION_SCOPE_PORT_CODES.MCP_TOOL_LEVEL_DEPRECATED,
        '授权表的 mcp 段里还写着**工具级**授权（'
        + toolLevel.map((s) => `${s.server}: ${(s.tools ?? []).join('、')}`).join('；')
        + '），而"哪些 MCP 工具可用"的权威**只**在**连接器登记表**'
        + '（F-21，经 connectorJudgment 接在同一个 preExecute 上）。'
        + 'DSH 送上来的公开名是 `mcp__<server>__<rawName>`（两个 `__`），'
        + '而 `splitMcpTool` 要求恰好一个——把线上名字喂进去会以"名字有歧义"拒掉，'
        + '那个方向虽然安全，但理由是错的，且会让每一个 MCP 调用都读成同一句话。'
        + '★ 靠**拆开公开名**去还原 `(server, rawName)` 这条路是堵死的：'
        + 'DSH 在归一化/截断时会把名字换成 12 位 SHA-256 后缀，那时还原不出来，'
        + '而 `packages/mcp/mcp-client/src/tools.ts:9-10` 逐字写着'
        + '"the public name is never parsed to recover it"（公开名从不被反解）。'
        + '⇒ 请把那段工具清单从授权表里**删掉**（保留 mcp 段本身即表示"这个岗位允许调 MCP"），'
        + '把工具声明写在连接器登记表里（F-21）。',
        { kind: 'mcp' },
      )
    }

    // ---- ④ 外部 API：PRT-606 管，本端口不管 --------------------------------
    //   ★ 这里**不是**"放行"：`external-api:*` 的另一半端口（PRT-606）负责它。
    //     本端口对它的读数是"无话可说"，与对 `file:*` 的读数是同一句话。
    return allow(null)
  }
}

/**
 * 从 Runtime 子进程的环境里取那份执行面授权表。
 *
 * ★ 缺席**如实**记成 `absent`：没配不等于"没有限制"——端口为 `null` 时
 *   组合根报 `executionScope: false`（**没接就是没接**，不是"接了个空的"）。
 * ★ 配了却解释不通 ⇒ **抛**：那是配置错误，不是"没配"。
 *
 * @param {object} p
 * @param {object} p.env
 * @param {string} [p.platform]
 * @returns {{state: string, port: Function|null, grant: object|null, reason: string|null}}
 */
export function executionScopePortFromEnv({ env, platform } = {}) {
  if (!isPlainObject(env)) {
    throw fail(EXECUTION_SCOPE_PORT_CODES.BAD_INPUT, 'executionScopePortFromEnv 需要一个环境对象')
  }
  const raw = env[EXECUTION_SCOPE_PORT_ENV_KEY]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return Object.freeze({
      state: EXECUTION_SCOPE_PORT_STATES.ABSENT,
      port: null,
      grant: null,
      reason: `环境里没有「${EXECUTION_SCOPE_PORT_ENV_KEY}」。这**不是**"没有执行面限制"——`
        + '执行面在端口为 null 时是放行，所以这个缺席要由组合根显式处置',
    })
  }

  let declaration = raw
  if (typeof raw === 'string') {
    try {
      declaration = JSON.parse(raw)
    } catch (err) {
      throw fail(
        EXECUTION_SCOPE_PORT_CODES.BAD_TABLE_TEXT,
        `「${EXECUTION_SCOPE_PORT_ENV_KEY}」不是合法 JSON（${err?.message ?? err}）。`
        + '不忽略这一段：一个被静默丢掉的授权表，与一张"什么都没限制"的授权表，读数一样',
      )
    }
  }

  const normalized = normalizeGrant(declaration)
  return Object.freeze({
    state: EXECUTION_SCOPE_PORT_STATES.CONFIGURED,
    port: createExecutionScopePort({ grant: normalized, platform }),
    grant: normalized,
    reason: null,
  })
}

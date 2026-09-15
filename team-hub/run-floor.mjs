// team-hub/run-floor.mjs
// ============================================================================
// PRT-214 的缺口：Run 的**静态 hard floor** 派生（spec §6.8 line 437-440 / 456 / 479）
//
// spec 把控制面到执行面的那条线画成一句话：
//
//     EmployeeManifest + TeamPlan + UserPolicy + TaskContext
//       → 生成 Run 权限档位、**静态 hard floor** 和动态策略
//       → DshRuntimeAdapter 安装到目标 Agent/Session
//
// 「Run 权限档位」那一半早就有了（`RunRequest.permissions` 的 preset + tools）。
// 「静态 hard floor」那一半一直没有**生产者**：全仓库没有任何生产代码算出过
// `denyTools` / `denyPathPrefixes`，而 `createHardFloorGuard()` 消费的正是这两个字段。
// 于是 guard 那道闸挂上去了、拿到的却是空下限——**"挂了一道空闸"与"没有这道闸"，
// 在组合树与审计里是同一个读数**。
//
// ## 为什么"两处名单今天恰好同名"不算数
//
// 控制面判一次操作是不是硬底线，用 `permission-engine.mjs` 里那份**私有**名单
// （动作名）；DSH 侧判一个工具是不是硬底线，用 `tool-capability.mjs` 写在每条能力上的
// `hardFloor` 标记（工具名 → 能力）。两边今天恰好是同样三个名字，
// 而把这份一致性维持住的**只有一行注释**。
//
//   > 一份「两处名单今天恰好同名」的一致性，
//   > 与一份「它们来自同一个来源」的一致性，
//   > 在没有人只改一边的那些日子里是同一个东西——
//   > 只不过前者会在有人只改一边的第二天，让 spec §6.8 的两道闸安静地少掉一道。
//
// 所以 `HARD_FLOOR_CAPABILITIES` 是本模块里**唯一**的一份名单：
// `permission-engine.mjs` 的 `isHardFloor` 与 `tool-capability.mjs` 的能力标记
// 都从它派生，没有第二处字面量。
//
// ## 一个必须写下来的代价：这是本仓库第一处 `runtime/` → `team-hub/` 的 import
//
// `enforcement-mapping.mjs` 为一组跨层常量专门写过理由：`team-hub/` → `runtime/`
// 是既有分层方向，反向实测 0 处，「为了取一个常量而反转一条已经一致的方向，收益是零」。
// 本模块是那次权衡的**例外**，因为这里跨层的不是一份可以两边各声明一次再对拍的枚举，
// 而是**下限本身**：两边各声明一次，恰恰就是本节开头要消灭的那个形状。
//
// 代价由两件事钉住：
//
//   · 本模块是一个**叶子**：只 import `runtime/dsh-composition/enforcement.mjs`
//     与 node 内建。能力目录的解析口是**注入**的，本模块**绝不** import
//     `tool-capability.mjs`——否则 `tool-capability → run-floor → tool-capability`
//     就是一个真实的模块环，而它的表现是"强制面整段加载不上"，
//     正是本模块要防的那一类安静失效。
//   · 这条纪律由本模块的用例守着（源扫描：本模块的 import 里没有能力目录）。
//
// ## 不认识的工具：进下限，判**静态拒绝**（一个被点名的选择）
//
// 允许名单里出现一个能力目录不认识的工具名时，有三条路：
//
//   ① 静默跳过——直接违反 `tool-capability.mjs` 自己那条"不认识的工具默认最严"；
//   ② 只让它进审批——但那个模块对未登记工具的返回值是 `critical` +
//      `requiresApproval: true` + `hardFloor: true` + `known: false`，
//      而它自己写着「`hardFloor` 的能力连"问一下"都不够，它们永远不能被自动放行」；
//   ③ 进静态下限（**本模块的选择**）。
//
// 选 ③ 的 spec 依据有两条：§6.8 line 456 把「hard floor、禁止工具、禁止越界路径」
// 一起映射到「pre-execute 提前拒绝 + guard 最终复核」，即这些属于**静态**面；
// §6.8 line 479 要求强制面接线完成前禁止高风险工具，而一个我们说不出它会干什么的
// 工具，是这份目录里风险最高的那一个。
//
//   > 一个"我们不认识的工具被留给了审批"的下限，
//   > 与一个"我们不认识的工具从来没有进过下限"的下限，
//   > 在审计里是同一个读数——只不过前者会让人去等一个永远不会被问的问题。
//
// 判成拒绝**不是**把它当成已知的硬底线：决定记录里带着 `known: false` 与一条 notice，
// 修法是把这个工具登记进目录，而不是去改这份名单。
//
// ## 空下限与"从未派生"必须分得开
//
//   > 一个"派生出来的空下限"，
//   > 与一个"这次没有任何东西该被禁止"，
//   > 在空数组这个读数上是同一个东西——
//   > 只不过前者意味着强制面整段不在，而没有任何人会收到告警。
//
// 所以返回值有一个 `derived` 位，且**不可派生时 `floor` 是 `null`**：
// `createHardFloorGuard(null)` 当场抛，而不是安静地变成一道空闸。
// `assertFloorInstallable()` 是给装配点用的那一句显式断言。
//
// ## 路径前缀：安全由构造保证，不由"我记得规范化过"保证
//
// guard 拿到的每个前缀都会**被再规范化一次**（`createHardFloorGuard` 里
// 用 `canonicalizePath(p, { cwd: floor.cwd, platform: floor.platform })`）。所以本模块：
//
//   ① 用**同一个** `canonicalizePath` 算出存进去的那一份，并把 `cwd` / `platform`
//      一起放进下限——guard 再算一次得到的就是同一个值；
//   ② 存之前自检**幂等**：`canonicalizePath(存进去的值) === 存进去的值`。
//      这一条不是装饰：把声明原样放进去（尾反斜杠、大小写、`..`）会在这里当场
//      变成具名拒绝，而不是一个"存下去、下次越界时匹配不上"的字符串。
//
//   > 一个"没规范化过、于是永远匹配不上的前缀"，
//   > 与一个"这条禁令不存在"，
//   > 在下一次越界写入时是同一个东西。
//
// 相对路径是**具名拒绝**，不是"按 cwd 展开"：`cwd` 是这次 Run 的事实，
// 而声明里没有说它是相对谁的——猜一个基准，等于让一条禁令的作用范围
// 取决于某个恰好生效的工作目录。
// ============================================================================

import { HARD_FLOOR_CAPABILITIES, canonicalizePath } from '../runtime/dsh-composition/enforcement.mjs'

/** 下限形状或拒绝码变化时递增。 */
export const RUN_FLOOR_VERSION = 1

/**
 * 静态 hard floor 的名单**定义在强制面那一侧**
 * （`runtime/dsh-composition/enforcement.mjs`，与 `DEFAULT_HARD_FLOOR` 和
 * 真 guard 放在一起），这里只是把它转出去给控制面的消费方。
 *
 * 为什么不定义在这里：`team-hub/` → `runtime/` 是本仓库既有的分层方向，
 * 反之是 0 处。名单落在 `enforcement.mjs` 里之后，本模块与
 * `runtime/dsh-composition/tool-capability.mjs` 拿到的是**同一个数组对象**——
 * 一致性由引用保证，不需要一条对拍用例，也没有一条反向依赖。
 * 细节见那个文件里 `HARD_FLOOR_CAPABILITIES` 的注释。
 */
export { HARD_FLOOR_CAPABILITIES }

/**
 * 一条工具为什么（不）进下限。闭集：审计里出现闭集外的理由等于没写理由。
 *
 * 注意最后一条**是**一条决定而不是"没决定"：`approval-liftable` 的工具
 * （例如 `external-api:write`）风险同样是 `critical`，但目录说它的 `hardFloor`
 * 是 `false`——即审批可以解除。把这类也塞进静态下限，等于把"问一下"变成"永远不行"，
 * 那是另一个政策，不是这份下限。
 */
export const RUN_FLOOR_DECISION_REASONS = Object.freeze({
  /** 工具声称了某个 hard-floor 能力 → 静态禁止。 */
  HARD_FLOOR_CAPABILITY: 'hard-floor-capability',
  /** 能力目录不认识这个工具 → 静态禁止（理由见文件头「不认识的工具」）。 */
  UNKNOWN_TOOL: 'unknown-tool',
  /** 控制面显式禁止（`declaredDenyTools`）→ 静态禁止。 */
  POLICY_DECLARED: 'policy-declared',
  /** 认得出、且不带任何 hard-floor 能力 → 不进静态下限，留给定态策略与审批。 */
  APPROVAL_LIFTABLE: 'approval-liftable',
})

/**
 * 派生不了的输入，各自一个码。**闭集**：一个可以是任意字符串的 `code`
 * 会退化成一句"出错了"，而每一种拒绝的修法都不同。
 */
export const RUN_FLOOR_REFUSAL_CODES = Object.freeze({
  /** `permissions` 不是对象——Run 权限档位整个不在。 */
  PERMISSIONS_MISSING: 'run-floor-permissions-missing',
  /** `permissions.tools` 不是数组——"允许哪些工具"读不出来。 */
  TOOLS_NOT_A_LIST: 'run-floor-tools-not-a-list',
  /** 允许名单里有一条不是非空字符串。 */
  TOOL_NAME_INVALID: 'run-floor-tool-name-invalid',
  /** 有工具要判，却没有注入能力目录的解析口。 */
  RESOLVER_MISSING: 'run-floor-capability-resolver-missing',
  /** 解析口自己抛了。 */
  RESOLVER_THREW: 'run-floor-capability-resolver-threw',
  /** 解析口返回的东西不满足契约（不是对象 / 没有布尔 `known` / `capabilities` 不是数组）。 */
  RESOLVER_CONTRACT: 'run-floor-capability-resolver-contract',
  /** `declaredDenyTools` 不是数组，或其中一条不是非空字符串。 */
  DECLARED_DENY_TOOLS_INVALID: 'run-floor-declared-deny-tools-invalid',
  /** `declaredDenyPathPrefixes` 不是数组。 */
  DECLARED_PATH_PREFIXES_INVALID: 'run-floor-declared-path-prefixes-invalid',
  /** 前缀不是非空字符串。 */
  PATH_PREFIX_NOT_A_STRING: 'run-floor-path-prefix-not-a-string',
  /** 前缀是相对路径：没有基准可言，不猜。 */
  PATH_PREFIX_RELATIVE: 'run-floor-path-prefix-relative',
  /** 规范化那一步自己抛了（例如平台相关的非法形态）。 */
  PATH_PREFIX_UNNORMALIZABLE: 'run-floor-path-prefix-unnormalizable',
  /** 规范化**不幂等**：存进去的那一份不是 guard 再算一次会得到的值。 */
  PATH_PREFIX_UNNORMALIZED: 'run-floor-path-prefix-unnormalized',
})

/** 看到这条 notice 的人要做的动作是"把工具登记进能力目录"，不是改名单。 */
export const RUN_FLOOR_NOTICE_CODES = Object.freeze({
  UNKNOWN_TOOL_DENIED: 'run-floor-unknown-tool-denied',
})

/** 派生被拒时抛这个。**不是 `Error` 加一句话**：装配点要按码分流。 */
export class RunFloorRefusalError extends Error {
  constructor(refusals) {
    const list = Array.isArray(refusals) ? refusals : []
    const first = list[0]
    super(
      'Run 的静态 hard floor 无法派生：'
      + (first === undefined ? '（没有给出任何拒绝码——这是调用方的 bug）' : first.code + '：' + first.message)
      + '。**不安装**这份下限：一个"派生出来的空下限"与一个"这次没有任何东西该被禁止"'
      + '在空数组上是同一个读数，只不过前者意味着强制面整段不在。',
    )
    this.name = 'RunFloorRefusalError'
    this.code = first === undefined ? 'run-floor-not-derived' : first.code
    this.refusals = Object.freeze([...list])
  }
}

function refusal(code, message, detail) {
  return Object.freeze({ code, message, ...(detail === undefined ? {} : detail) })
}

function decision(tool, reason, detail) {
  return Object.freeze({ tool, deny: true, reason, ...detail })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 从控制面已声明的输入派生一次 Run 的静态 hard floor。**纯函数，零 IO。**
 *
 * @param {object} input
 * @param {{preset?: string, tools?: string[]}} input.permissions
 *   Run 权限档位（spec line 439 的产物，也就是 `RunRequest.permissions`）。
 *   `tools` 是**允许名单**：不在名单里的工具本来就走不到 guard，不需要进下限；
 *   空数组是合法的，意思是"这个员工不能用任何工具"。
 * @param {string[]} [input.declaredDenyTools]
 *   控制面（UserPolicy / EmployeeManifest）**显式禁止**的工具名。spec line 456 把
 *   「禁止工具」与 hard floor 并列映射到静态面，所以它们同样进下限。
 * @param {string[]} [input.declaredDenyPathPrefixes]
 *   控制面显式禁止的**绝对**路径前缀（spec line 456 的「禁止越界路径」）。
 *   注意：这里只承载**声明过的**禁令。guard 的形状是拒绝名单，
 *   表达不了"工作区之外全都不许"那种补集语义——见文件末尾的诚实边界。
 * @param {(name: string) => {known: boolean, capabilities: string[], requiresApproval?: boolean}} input.resolveTool
 *   能力目录的解析口，**由调用方注入**（真实实现是 `tool-capability.mjs` 的 `resolveTool`）。
 *   本模块不 import 它：那会造出一个真实的模块环（见文件头）。
 * @param {string} [input.cwd] 本次 Run 的工作目录。进下限，供 guard 规范化相对目标路径。
 * @param {string} [input.platform] 路径语义；默认 `process.platform`。与 `cwd` 一起进下限。
 * @param {string} [input.runId] 证据标签，原样回显。
 * @returns {Readonly<object>} `{version, runId, preset, derived, floor, entries, pathPrefixes, notices, refusals}`
 *   `floor` 是 `{denyTools, denyPathPrefixes, cwd, platform}`，`createHardFloorGuard()` 直接吃它；
 *   派生不出来时 `floor` 是 `null`（**不是**一个空对象）。
 */
export function deriveRunFloor({
  permissions,
  declaredDenyTools = [],
  declaredDenyPathPrefixes = [],
  resolveTool,
  cwd,
  platform = process.platform,
  runId = null,
} = {}) {
  const refusals = []
  const entries = []
  const pathPrefixes = []
  const notices = []

  // ── ① Run 权限档位 ────────────────────────────────────────────────────────
  const preset = isPlainObject(permissions) ? (permissions.preset ?? null) : null
  let allowlist = null
  if (!isPlainObject(permissions)) {
    refusals.push(refusal(
      RUN_FLOOR_REFUSAL_CODES.PERMISSIONS_MISSING,
      'permissions 不是对象：Run 的权限档位读不出来。缺席的档位不能被当成"没有任何工具"。',
      { received: permissions === null ? 'null' : typeof permissions },
    ))
  } else if (!Array.isArray(permissions.tools)) {
    refusals.push(refusal(
      RUN_FLOOR_REFUSAL_CODES.TOOLS_NOT_A_LIST,
      'permissions.tools 不是数组：允许名单读不出来。读不出来的名单与一份空名单是两件事——'
      + '后者是"这个员工不能用任何工具"，前者是"我们不知道他能用哪些"。',
      { received: typeof permissions.tools },
    ))
  } else {
    allowlist = []
    for (const raw of permissions.tools) {
      const name = nonEmptyString(raw)
      if (name === null) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.TOOL_NAME_INVALID,
          '允许名单里有一条不是非空字符串——这一条工具名读不出来，于是它该不该进下限也就判不了。',
          { tool: raw === undefined ? 'undefined' : String(raw).slice(0, 128) },
        ))
        continue
      }
      if (!allowlist.includes(name)) allowlist.push(name)
    }
  }

  // ── ② 工具 → 能力 → 是否进下限 ───────────────────────────────────────────
  if (allowlist !== null && allowlist.length > 0 && typeof resolveTool !== 'function') {
    refusals.push(refusal(
      RUN_FLOOR_REFUSAL_CODES.RESOLVER_MISSING,
      '有 ' + allowlist.length + ' 个工具要判，但没有注入能力目录的解析口（resolveTool）。'
      + '没有它就无法知道某个工具带不带 hard-floor 能力——'
      + '而"不知道"与"没有硬底线能力"在这份下限上会产出同一个空数组。',
      { tools: Object.freeze([...allowlist]) },
    ))
  }

  if (allowlist !== null && typeof resolveTool === 'function') {
    for (const name of allowlist) {
      let tool = null
      try {
        tool = resolveTool(name)
      } catch (err) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.RESOLVER_THREW,
          '能力目录解析「' + name + '」时自己抛了：' + (err?.message ?? String(err)),
          { tool: name },
        ))
        continue
      }
      if (!isPlainObject(tool) || typeof tool.known !== 'boolean' || !Array.isArray(tool.capabilities)) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.RESOLVER_CONTRACT,
          '能力目录对「' + name + '」的返回值不满足契约（需要 {known: boolean, capabilities: string[]}）。'
          + '一个形状不对的解析结果，与一个"这个工具没有能力"的解析结果，在下限上长得一样。',
          { tool: name },
        ))
        continue
      }

      if (tool.known !== true) {
        // 见文件头「不认识的工具」：进下限，判静态拒绝。
        entries.push(decision(name, RUN_FLOOR_DECISION_REASONS.UNKNOWN_TOOL, {
          known: false, capability: null, capabilities: Object.freeze([]),
        }))
        notices.push(Object.freeze({
          code: RUN_FLOOR_NOTICE_CODES.UNKNOWN_TOOL_DENIED,
          tool: name,
          message: '「' + name + '」不在能力目录里，已按最严处理并静态禁止。'
            + '修法是把工具登记进目录（`tool-capability.mjs` 的 RAW_CATALOG），不是放宽这份下限。',
        }))
        continue
      }

      const capability = HARD_FLOOR_CAPABILITIES.find((id) => tool.capabilities.includes(id)) ?? null
      if (capability !== null) {
        entries.push(decision(name, RUN_FLOOR_DECISION_REASONS.HARD_FLOOR_CAPABILITY, {
          known: true, capability, capabilities: Object.freeze([...tool.capabilities]),
        }))
      } else {
        entries.push(Object.freeze({
          tool: name,
          deny: false,
          reason: RUN_FLOOR_DECISION_REASONS.APPROVAL_LIFTABLE,
          known: true,
          capability: null,
          capabilities: Object.freeze([...tool.capabilities]),
          requiresApproval: tool.requiresApproval === true,
        }))
      }
    }
  }

  // ── ③ 控制面显式禁止的工具 ───────────────────────────────────────────────
  if (!Array.isArray(declaredDenyTools)) {
    refusals.push(refusal(
      RUN_FLOOR_REFUSAL_CODES.DECLARED_DENY_TOOLS_INVALID,
      'declaredDenyTools 不是数组：政策声明的禁用工具读不出来。',
      { received: typeof declaredDenyTools },
    ))
  } else {
    for (const raw of declaredDenyTools) {
      const name = nonEmptyString(raw)
      if (name === null) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.DECLARED_DENY_TOOLS_INVALID,
          'declaredDenyTools 里有一条不是非空字符串。',
          { tool: raw === undefined ? 'undefined' : String(raw).slice(0, 128) },
        ))
        continue
      }
      // 已知的禁用工具**不重算**它的能力：决定已经是拒绝，能力目录在这里
      // 只影响证据（`known`），不影响结论——所以解析失败不升级成拒绝。
      let known = null
      if (typeof resolveTool === 'function') {
        try {
          const tool = resolveTool(name)
          if (isPlainObject(tool) && typeof tool.known === 'boolean') known = tool.known
        } catch { known = null }
      }
      entries.push(decision(name, RUN_FLOOR_DECISION_REASONS.POLICY_DECLARED, {
        known, capability: null, capabilities: Object.freeze([]), declaredBy: 'declaredDenyTools',
      }))
    }
  }

  // ── ④ 路径前缀 ───────────────────────────────────────────────────────────
  if (!Array.isArray(declaredDenyPathPrefixes)) {
    refusals.push(refusal(
      RUN_FLOOR_REFUSAL_CODES.DECLARED_PATH_PREFIXES_INVALID,
      'declaredDenyPathPrefixes 不是数组：禁止路径前缀读不出来。',
      { received: typeof declaredDenyPathPrefixes },
    ))
  } else {
    for (const raw of declaredDenyPathPrefixes) {
      const declared = nonEmptyString(raw)
      if (declared === null) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.PATH_PREFIX_NOT_A_STRING,
          '禁止路径前缀里有一条不是非空字符串。',
        ))
        continue
      }

      // 绝对性判据**复用 guard 要用的那一个规范化函数**：相对路径在没有 cwd 时
      // 会让它抛。不自己写一条 startsWith('/') 的正则——两份判据会漂。
      try {
        canonicalizePath(declared, { platform })
      } catch (err) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.PATH_PREFIX_RELATIVE,
          '禁止路径前缀「' + declared + '」不是绝对路径（' + (err?.message ?? String(err)) + '）。'
          + '不按 cwd 展开：声明里没有说它是相对谁的，猜一个基准等于让禁令的作用范围'
          + '取决于某个恰好生效的工作目录。',
          { prefix: declared },
        ))
        continue
      }

      let normalized
      try {
        normalized = canonicalizePath(declared, { cwd, platform })
      } catch (err) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.PATH_PREFIX_UNNORMALIZABLE,
          '禁止路径前缀「' + declared + '」规范化失败：' + (err?.message ?? String(err)),
          { prefix: declared },
        ))
        continue
      }

      // ★ 幂等自检：存进去的必须是 guard 再算一次会得到的那个值。
      let again
      try {
        again = canonicalizePath(normalized, { cwd, platform })
      } catch (err) {
        again = null
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.PATH_PREFIX_UNNORMALIZED,
          '禁止路径前缀「' + declared + '」规范化后的值再也过不了规范化：' + (err?.message ?? String(err)),
          { prefix: declared },
        ))
        continue
      }
      if (again !== normalized) {
        refusals.push(refusal(
          RUN_FLOOR_REFUSAL_CODES.PATH_PREFIX_UNNORMALIZED,
          '禁止路径前缀「' + declared + '」规范化不幂等（'
          + JSON.stringify(normalized) + ' → ' + JSON.stringify(again) + '）。'
          + '一个"没规范化过、于是永远匹配不上"的前缀，与一条不存在的禁令，'
          + '在下一次越界写入时是同一个东西。',
          { prefix: declared },
        ))
        continue
      }

      pathPrefixes.push(Object.freeze({ declared, normalized }))
    }
  }

  // ── ⑤ 组装 ───────────────────────────────────────────────────────────────
  const denyTools = []
  for (const entry of entries) {
    if (entry.deny === true && !denyTools.includes(entry.tool)) denyTools.push(entry.tool)
  }
  const derived = refusals.length === 0
  const floor = derived
    ? Object.freeze({
      denyTools: Object.freeze(denyTools),
      denyPathPrefixes: Object.freeze(pathPrefixes.map((p) => p.normalized)),
      cwd,
      platform,
    })
    : null

  return Object.freeze({
    version: RUN_FLOOR_VERSION,
    runId,
    preset,
    derived,
    floor,
    entries: Object.freeze(entries),
    pathPrefixes: Object.freeze(pathPrefixes),
    notices: Object.freeze(notices),
    refusals: Object.freeze(refusals),
  })
}

/**
 * 装配点该用的那一句：拿不出一份**派生完成**的下限就抛。
 *
 * 存在的理由只有一个——`result.floor` 与 `result.derived` 是两处可读的东西，
 * 而 `createHardFloorGuard(result.floor ?? {})` 这种写法会把"从未派生"
 * 悄悄变成一道空闸。这里让它抛。
 *
 * @param {object} result `deriveRunFloor()` 的返回值
 * @returns {Readonly<{denyTools: string[], denyPathPrefixes: string[], cwd: string, platform: string}>}
 */
export function assertFloorInstallable(result) {
  if (!isPlainObject(result) || result.derived !== true || !isPlainObject(result.floor)) {
    throw new RunFloorRefusalError(Array.isArray(result?.refusals) ? result.refusals : [])
  }
  return result.floor
}

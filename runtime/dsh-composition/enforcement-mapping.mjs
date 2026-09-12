// runtime/dsh-composition/enforcement-mapping.mjs
// ============================================================================
// PRT-612：Legion 权限语义 → DSH 强制面的**固定映射**
//
// spec §6.6 line 445–454 给了一张六行的表（左列 Legion 语义、中列 DSH 强制点、
// 右列约束）。本模块把那张表**变成数据 + 判据**，并给出唯一一个把模式落到强制点的
// 函数 `mapPermissionMode`。
//
// ## 为什么"映射"需要一份代码，而不是一段文档
//
// 这张表里的每一行都对应**另一个模块里已有的一个原语**（`createPreExecutePolicy`、
// `createHardFloorGuard`、`createApprovalAnswerer`、`probeSandbox`、
// `reconcilePatchLayer`）。文档里的表与代码里的原语之间没有任何机制保证它们**同时**
// 是对的：
//
//   > 一份写着"ask → ctx.approval"的映射文档，
//   > 与一个"ask 其实在 pre-execute 就被放行了"的实现，是同一个东西——
//   > 只不过前者在评审时看起来是有约束的。
//
// 所以本模块做三件事：**声明**这张表、**查它**（原语是否真的存在、点是否覆盖齐全、
// 决策来源是否与审计口径一致）、以及**用它**（`mapPermissionMode` 是唯一的落点函数，
// 且它把"要不要问人"这件事委托给 PRT-607 的 `decideApproval`，不自己再判一遍）。
//
// ## 一个必须分清的区分：policy-gate 与 answerer 是两个阶段
//
// spec line 452 说无人值守时"**DSH 在 answerer waterfall 前拒绝**"。这句话的重点在
// **"前"**：拒绝发生在请求进入 waterfall **之前**。把这两件事混成"approval 这个点"
// 一个概念，就会得到一个最坏的实现：
//
//   > 一个「无人值守时仍然把请求送进 answerer waterfall」的映射，
//   > 与一个「去问一个不在场的人、然后一直等下去」的映射，是同一个东西。
//
// 所以 `approval` 点分成两个阶段：`policy-gate`（waterfall 之前的确定性判定）与
// `answerer`（waterfall 本身）。`mapPermissionMode` 的返回值里
// `answererInvoked` 是一个**显式**字段，且有一条不变量钉住它：
// **只有判定结果是 `ask` 时才 invoke answerer**。
// ============================================================================

import {
  APPROVAL_DECISIONS,
  decideApproval,
} from './approval-policy.mjs'
import {
  CANONICAL_OP_KEYS,
  ENFORCEMENT_SOURCES,
  canonicalOperationHash,
  createApprovalAnswerer,
  createHardFloorGuard,
  createPreExecutePolicy,
} from './enforcement.mjs'
import {
  LEGION_PERMISSION_PRESETS,
  PATCH_LAYER_ROWS,
  reconcilePatchLayer,
} from './patch-layer.mjs'

export const ENFORCEMENT_MAPPING_VERSION = 'legion/enforcement-mapping@1'

/**
 * 本模块自己的错误码。
 *
 * 每一条都对应一种**会安静地错**的写法——也就是"不报错、但强制面与声明的不是一回事"。
 * 这类缺陷的共性是：单看任何一个强制点都是绿的。
 */
export const MAPPING_CODES = Object.freeze({
  /** 路由表里没有这个模式。**不许兜底**（见 `routeForMode`）。 */
  MODE_UNROUTED: 'enforcement-mapping-mode-unrouted',
  /** 引用了不存在的强制点。 */
  POINT_UNKNOWN: 'enforcement-mapping-point-unknown',
  /** 一个 `config` 类点被当成了"决定来源"。 */
  CONFIG_AS_SOURCE: 'enforcement-mapping-config-as-decision-source',
  /** 决定来源集合与 `ENFORCEMENT_SOURCES`（审计口径）不一致。 */
  SOURCE_DRIFT: 'enforcement-mapping-source-drift',
  /** 声明了某个决定来源，却没有任何一行映射到它。 */
  POINT_UNREFERENCED: 'enforcement-mapping-point-unreferenced',
  /** 映射点名的补丁行在 `PATCH_LAYER_ROWS` 里不存在。 */
  PATCH_ROW_MISSING: 'enforcement-mapping-patch-row-missing',
  /** 映射点名的原语在该模块里不存在。 */
  PRIMITIVE_MISSING: 'enforcement-mapping-primitive-missing',
  /** 某条模式没有挂到任何强制点。 */
  MODE_WITHOUT_POINT: 'enforcement-mapping-mode-without-point',
  /** `allow-once` 被映射成了纯放行（绕开审批箱 ⇒ 票据永不消费）。 */
  ALLOW_ONCE_SHORTCUT: 'enforcement-mapping-allow-once-shortcut',
  /** 映射层对"无人值守"的判断与 `decideApproval` 不一致。 */
  UNATTENDED_DRIFT: 'enforcement-mapping-unattended-drift',
  /** ★ PRT-620：guard 拒绝了一次**已经放行**的调用（强制面配置错误）。 */
  GUARD_DENIED_APPROVED: 'enforcement-mapping-guard-denied-approved',
  /** guard 报出了 `allow` —— 它没有这个语义。 */
  GUARD_HAS_ALLOW_SEMANTICS: 'enforcement-mapping-guard-has-allow-semantics',
  /** 送进来的"判定对"本身畸形（判定不在闭集里）。 */
  PAIR_MALFORMED: 'enforcement-mapping-pair-malformed',
})

// ---------------------------------------------------------------------------
// 左列：Legion 语义
// ---------------------------------------------------------------------------

/**
 * F-02 的五种模式。
 *
 * **本模块不 import `team-hub/permission-engine.mjs`**。理由是方向而不是禁令：
 * `team-hub/` → `runtime/` 是本仓库既有的分层方向（`tool-call-log.mjs` 与
 * `permission-engine.canonical.test.mjs` 都 import `runtime/dsh-composition/enforcement.mjs`），
 * 而 `runtime/` → `team-hub/` 目前**一处都没有**（0/……，实测）。为了取一个常量
 * 而反转一条已经一致的方向，收益是零、代价是下一个人不知道该往哪边加依赖。
 *
 * 所以这里**声明**一份，由 `team-hub` 侧的一个用例去断言两份相等——
 * 那一侧同时看得见两边，这正是"跨模块一致性"该被检查的地方：
 *
 *   > 一个「本模块自己声明一份模式表」的实现，
 *   > 与一个「两份表迟早不一样」的实现，是同一个东西——
 *   > 只不过前者在任何单侧的用例里都是绿的。
 *
 * 断言在 `team-hub/permission-engine.canonical.test.mjs`（该文件已经在跨这两层）。
 * 名字与顺序都要一样，不只是集合相等——顺序决定不了行为，但它决定了
 * 排障时两个人读的是不是同一张表。
 */
export const LEGION_MODES = Object.freeze([
  'deny',
  'ask',
  'allow-once',
  'allow-for-task',
  'allow-by-policy',
])

/**
 * Legion 语义里**不属于**五种模式、但同样要落到强制点上的几种东西。
 *
 * 它们与模式分开列，因为它们的"输入"不是一次调用的 mode，而是一次装配/配置：
 * hard floor 来自工具目录，档位来自 preset，文件/子进程约束来自沙箱配置。
 * 混进 `LEGION_MODES` 会让"每一次调用都有一个 mode"这句前提悄悄失真。
 */
export const LEGION_NON_MODE_SEMANTICS = Object.freeze([
  'hard-floor',
  'deny-tool',
  'deny-path',
  'session-tier',
  'file-scope',
  'subprocess-scope',
])

// ---------------------------------------------------------------------------
// 中列：DSH 强制点
// ---------------------------------------------------------------------------

/**
 * spec line 449–454 中列的六个强制点，及其三个属性。
 *
 * `kind` 是**这张表里最要紧的一列**：
 *   · `decision` —— 这个点会针对**某一次调用**给出一个判定；
 *   · `config`   —— 这个点只是**绑定配置**（把沙箱模式与审批策略绑在一起），
 *                   它本身不判定任何一次调用。
 *
 * 这个区分不是分类癖：`team-hub/tool-calls` 审计的 `source` 列只接受
 * `ENFORCEMENT_SOURCES`（4 个），而 spec 的表有 6 行。如果把 `permissionPresets`
 * 也算成决定来源，审计里就会出现一个"决定了某次调用"的来源，而**它从来没有
 * 决定过任何一次调用**：
 *
 *   > 一个「把配置绑定点也算进决定来源」的审计，
 *   > 与一个「`source` 列上出现一个从不做判定的来源」的审计，是同一个东西。
 *
 * `stage` 只对 `approval` 有意义，且是必须的（见文件头那段说明）。
 */
export const DSH_ENFORCEMENT_POINTS = Object.freeze({
  'pre-execute': Object.freeze({
    id: 'pre-execute',
    kind: 'decision',
    context: "ctx.on('tools/pre-execute')",
    patchRow: 'legion-enforcement-pre-execute',
    primitive: Object.freeze({ module: 'enforcement.mjs', name: 'createPreExecutePolicy' }),
    purpose: '动态 allow / deny / ask；team-hub 不可达或策略异常时 deny（fail closed）',
  }),
  guard: Object.freeze({
    id: 'guard',
    kind: 'decision',
    context: 'ctx.tools.guard()',
    patchRow: 'legion-enforcement-hard-floor',
    primitive: Object.freeze({ module: 'enforcement.mjs', name: 'createHardFloorGuard' }),
    purpose: '静态 hard floor：同步、确定性、最终单调拒绝（**只有降级语义，没有 allow 语义**）',
  }),
  approval: Object.freeze({
    id: 'approval',
    kind: 'decision',
    context: 'ctx.approval',
    patchRow: 'legion-enforcement-approval-answerer',
    primitive: Object.freeze({ module: 'enforcement.mjs', name: 'createApprovalAnswerer' }),
    purpose: '把审批请求写入审批箱；只有 allowed-once 执行；双段超时 fail closed',
    stages: Object.freeze(['policy-gate', 'answerer']),
  }),
  sandbox: Object.freeze({
    id: 'sandbox',
    kind: 'decision',
    context: 'ctx.sandbox',
    // 沙箱**没有**自己的补丁行：它的模式由 `permissionPresets` 绑定，它的"是否真的
    // 生效"由启动自检探测。`patchRow: null` 不是缺失，是"它不由某一行挂载"。
    patchRow: null,
    primitive: Object.freeze({ module: 'selfcheck.mjs', name: 'probeSandbox' }),
    purpose: '文件和子进程约束；必须探测实际后端与 enforcement，仅有配置名不算生效',
  }),
  permissionPresets: Object.freeze({
    id: 'permissionPresets',
    kind: 'config',
    context: 'ctx.permissionPresets',
    patchRow: 'legion-enforcement-permission-presets',
    primitive: Object.freeze({ module: 'patch-layer.mjs', name: 'reconcilePatchLayer' }),
    purpose: '会话权限档位：绑定 sandbox mode 与 approval policy，并在 Run 快照中冻结',
  }),
  'canonical-operation': Object.freeze({
    id: 'canonical-operation',
    kind: 'config',
    context: '审批绑定的不可变操作哈希',
    patchRow: null,
    primitive: Object.freeze({ module: 'enforcement.mjs', name: 'canonicalOperationHash' }),
    purpose: '审批绑定不可变 ToolExecution 参数的 canonical 哈希；任一关键字段变化即失效',
  }),
})

/** `kind === 'decision'` 的点，按 id 排序（顺序稳定，供比对与留证）。 */
export function decisionPoints() {
  return Object.keys(DSH_ENFORCEMENT_POINTS)
    .filter((id) => DSH_ENFORCEMENT_POINTS[id].kind === 'decision')
    .sort()
}

/** `kind === 'config'` 的点，按 id 排序。 */
export function configPoints() {
  return Object.keys(DSH_ENFORCEMENT_POINTS)
    .filter((id) => DSH_ENFORCEMENT_POINTS[id].kind === 'config')
    .sort()
}

// ---------------------------------------------------------------------------
// 表本身：spec §6.6 line 449–454（逐行对应，不重排）
// ---------------------------------------------------------------------------

/**
 * spec line 447–454 的固定映射表。
 *
 * 数组顺序**故意与 spec 表格的行序一致**（449 → 454）。这不是审美：这张表是
 * 逐行对照 spec 评审的对象，重排一次就没人能一眼看出哪一行漏了。
 */
export const ENFORCEMENT_MAPPING = Object.freeze([
  Object.freeze({
    line: 449,
    semantics: Object.freeze(['hard-floor', 'deny-tool', 'deny-path']),
    points: Object.freeze(['pre-execute', 'guard']),
    constraint: 'Guard 只做同步、确定性拒绝；后续流程不可撤销',
  }),
  Object.freeze({
    line: 450,
    semantics: Object.freeze(['allow-by-policy', 'allow-for-task', 'deny']),
    points: Object.freeze(['pre-execute']),
    constraint: '调用 F-02 纯策略；team-hub 不可达或策略异常时 deny',
  }),
  Object.freeze({
    line: 451,
    semantics: Object.freeze(['ask', 'allow-once']),
    points: Object.freeze(['pre-execute', 'approval']),
    constraint: 'Legion answerer 把请求写入审批箱；只有 `allowed-once` 执行',
  }),
  Object.freeze({
    line: 452,
    semantics: Object.freeze(['ask', 'allow-once']),
    points: Object.freeze(['approval']),
    constraint: '无人值守禁止询问：DSH 在 answerer waterfall **前**拒绝（policy=never）',
    whenUnattended: true,
  }),
  Object.freeze({
    line: 453,
    semantics: Object.freeze(['session-tier']),
    points: Object.freeze(['permissionPresets']),
    constraint: '绑定 sandbox mode 与 approval policy，并在 Run 快照中冻结',
  }),
  Object.freeze({
    line: 454,
    semantics: Object.freeze(['file-scope', 'subprocess-scope']),
    points: Object.freeze(['sandbox']),
    constraint: '必须探测实际后端和 enforcement；仅有配置名不算生效',
  }),
])

// ---------------------------------------------------------------------------
// 模式 → 强制点：**唯一**的落点表
// ---------------------------------------------------------------------------

/**
 * 五种模式各自走哪些强制点，以及"这次调用由谁定案"。
 *
 * ★ `allow-once` 那一行是本表最容易写错的地方。
 *
 * 名字里带 "allow"，所以最自然的写法是把它映射成"pre-execute 放行"。那是错的：
 * spec line 451 把 `ask` 与 `allow-once` **并列**在同一个强制点（审批箱）下，
 * 并补了一句"只有 `allowed-once` 执行"——也就是说 `allow-once` 描述的**不是**
 * "这次调用已经安全"，而是"这次调用持有一张一次性票据，票据必须被消费"。
 *
 *   > 一个「把 `allow-once` 映射成 pre-execute 直接放行」的表，
 *   > 与一个「`allow-once` 的票据从来没被消费过、于是同一张票能放行任意多次」的表，
 *   > 是同一个东西——而它的方向是放行。
 *
 * 所以 `allow-once` 的 `viaApprovalBox` 必须是 `true`，且由
 * `assertMappingConsistent` 强制（§ ALLOW_ONCE_SHORTCUT）。
 *
 * ★ `deny` 走两个点（`pre-execute` + `guard`）不是冗余。
 *
 * `guard` 只有降级语义、**没有 allow 语义**（PRT-610 把这条直接编码进了
 * `SOURCE_DECISIONS`：`source=guard, decision=allow` 必须被拒）。也就是说
 * "早退"与"终审"这两件事只能分别由这两个点承担，谁也不能替谁。
 */
export const MODE_ROUTING = Object.freeze({
  deny: Object.freeze({
    mode: 'deny',
    points: Object.freeze(['pre-execute', 'guard']),
    decision: 'deny',
    decidedBy: 'pre-execute',
    viaApprovalBox: false,
  }),
  ask: Object.freeze({
    mode: 'ask',
    points: Object.freeze(['pre-execute', 'approval']),
    // `decision` 留 null：`ask` 的结局**不由本表决定**，由 `decideApproval` 决定
    // （有人值守 ⇒ ask；无人值守 ⇒ deny/hold）。写死一个值就等于把"无人值守怎么办"
    // 在映射层又实现了一遍。
    decision: null,
    decidedBy: 'approval',
    viaApprovalBox: true,
  }),
  'allow-once': Object.freeze({
    mode: 'allow-once',
    points: Object.freeze(['pre-execute', 'approval']),
    decision: null,
    decidedBy: 'approval',
    viaApprovalBox: true,
  }),
  'allow-for-task': Object.freeze({
    mode: 'allow-for-task',
    points: Object.freeze(['pre-execute']),
    decision: 'allow',
    decidedBy: 'pre-execute',
    viaApprovalBox: false,
  }),
  'allow-by-policy': Object.freeze({
    mode: 'allow-by-policy',
    points: Object.freeze(['pre-execute']),
    decision: 'allow',
    decidedBy: 'pre-execute',
    viaApprovalBox: false,
  }),
})

/**
 * 取一个模式的固定路由。**不认识就抛，绝不兜底。**
 *
 *   > 一个「不认识的 mode 就按 ask 处理」的兜底，
 *   > 与一个「拼错的 `deny` 被当成 `ask`、于是危险操作被送进审批箱等着被批」的兜底，
 *   > 是同一个东西。
 *
 * 与 PRT-607 的 `assertPolicy` 同一条纪律：兜底的方向决定它是不是安全网。
 * 这里的兜底方向是**放行**（ask 在有人值守下会变成一次人工批准，而它本意是拒绝），
 * 所以不允许兜底。
 */
export function routeForMode(mode) {
  if (typeof mode !== 'string' || mode.length === 0) {
    throw mappingError(MAPPING_CODES.MODE_UNROUTED, `模式必须是字符串（收到 ${typeof mode}）`)
  }
  const route = MODE_ROUTING[mode]
  if (route === undefined) {
    throw mappingError(
      MAPPING_CODES.MODE_UNROUTED,
      `模式 "${mode}" 不在固定映射表里（已知：${LEGION_MODES.join(' / ')}）；` +
      '本表不提供兜底——不认识的模式按 ask 处理会让一次本该拒绝的调用去等着被批准',
    )
  }
  return route
}

function mappingError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 落点函数：把一次调用映射到强制点计划
// ---------------------------------------------------------------------------

/**
 * 把一次调用（Legion 模式 + 审批策略现场）映射成一份**强制点计划**。
 *
 * 这是本模块唯一的"用"（另外两个是"声明"与"查"）。
 *
 * ## 它为什么不自己判断"无人值守怎么办"
 *
 * "无人值守不是'没人所以放行'"这条规则已经由 `approval-policy.mjs`
 * （PRT-607）实现了，含 14 条用例与 30 处破坏性验证。如果本函数再判一遍
 * （`attended ? 'ask' : 'deny'` 这种一行代码），就会有两份实现：
 *
 *   > 一个「在映射层自己再写一遍'无人值守怎么办'」的实现，
 *   > 与一个「两处对无人值守的判断迟早不一样」的实现，是同一个东西——
 *   > 只不过前者在只有映射层单测的时候看起来是对的。
 *
 * 所以 `ask` / `allow-once` 的结局**一律**来自 `decideApproval`，
 * 并原样放进 `approval` 字段（含 `code` 与 `reason`，审计要能复原现场）。
 * 有一条不变量（§ UNATTENDED_DRIFT）拿真实输入逐组比对两者。
 *
 * ## `answererInvoked`
 *
 * 只有判定结果是 `ask` 时才把请求送进 answerer waterfall。`deny`（无人值守）
 * 与 `hold` 都不送：
 *   · `deny` —— spec line 452 要求"在 waterfall **前**拒绝"；
 *   · `hold` —— 判定是"保持等待"，此时送进 waterfall 会去问一个还没到的人。
 *
 *   > 一个「hold 也送进 waterfall」的映射，
 *   > 与一个「无人值守时去问一个不在场的人、然后一直等下去」的映射，是同一个东西。
 *
 * @param {{mode: string, policy?: string, requirement?: string, attended?: boolean,
 *          highRisk?: boolean, preset?: string}} input
 */
export function mapPermissionMode(input = {}) {
  const { mode } = input
  const route = routeForMode(mode)

  // 不经过审批箱的两条路：结局由模式本身定死。
  if (!route.viaApprovalBox) {
    return Object.freeze({
      mode,
      version: ENFORCEMENT_MAPPING_VERSION,
      points: route.points,
      decision: route.decision,
      decidedBy: route.decidedBy,
      // 不经过审批箱，就没有"要不要 invoke answerer"这个问题——显式给 false，
      // 而不是留给调用方去读 `approval === null` 猜。
      answererInvoked: false,
      approval: null,
    })
  }

  // 经过审批箱：结局**全部**来自 PRT-607 的判定函数。
  const verdict = decideApproval({
    policy: input.policy,
    requirement: input.requirement,
    attended: input.attended,
    highRisk: input.highRisk,
    preset: input.preset,
  })

  if (!APPROVAL_DECISIONS.includes(verdict.decision)) {
    throw mappingError(
      MAPPING_CODES.UNATTENDED_DRIFT,
      `decideApproval 返回了已知集合之外的判定 "${verdict.decision}"（已知：${APPROVAL_DECISIONS.join(' / ')}）`,
    )
  }

  return Object.freeze({
    mode,
    version: ENFORCEMENT_MAPPING_VERSION,
    points: route.points,
    decision: verdict.decision,
    decidedBy: route.decidedBy,
    // ★ 只有 `ask` 才进 waterfall。
    answererInvoked: verdict.decision === 'ask',
    approval: verdict,
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 本模块能静态解析自己原语的模块（其余由调用方注入，见下）。 */
const STATIC_PRIMITIVES = Object.freeze({
  'enforcement.mjs': Object.freeze({
    createPreExecutePolicy,
    createHardFloorGuard,
    createApprovalAnswerer,
    canonicalOperationHash,
  }),
  'patch-layer.mjs': Object.freeze({ reconcilePatchLayer }),
})

/**
 * 一致性自检。**这是本模块"查"的那一半**。
 *
 * 它问的每一个问题都对应一种"声明与实现脱节"的形态：
 *
 *   ① 每个模式都有一条路由，且每条路由都有至少一个强制点（两个方向都查）；
 *   ② 路由与映射表引用的每个点都在 `DSH_ENFORCEMENT_POINTS` 里；
 *   ③ **决定来源集合恰等于** `ENFORCEMENT_SOURCES`（审计口径），
 *      且没有任何 `config` 类的点混进去；
 *   ④ 每个点声明的补丁行真的在 `PATCH_LAYER_ROWS` 里；
 *   ⑤ 每个点声明的原语真的存在（能静态解析的静态查，其余**记录下来**而不是跳过）；
 *   ⑥ `allow-once` 必须经过审批箱。
 *
 * ⑤ 的处置值得说明。`probeSandbox` 住在 `selfcheck.mjs`，而 `selfcheck.mjs`
 * **import 本模块**（启动自检要跑这一条）。在这里 import 回去会成环，所以
 * 那一条原语默认**查不到**。第一版的想法是"跳过它"——而那正好是坏事：
 *
 *   > 一个「自检说'所有原语都在'」的自检，
 *   > 与一个「其中一条原语从来没被查过」的自检，是同一个东西。
 *
 * 所以不跳过：解析不了的原语进入返回值里的 `unresolvedPrimitives`，调用方
 * （`startupSelfCheck`）把 `probeSandbox` 注进来再跑一次。两边合起来才是全查过；
 * 只跑得动静态那一半时，**返回值会明说还剩哪一条没查**。
 *
 * @param {{patchRows?: Array<{id: string}>, enforcementSources?: string[],
 *          primitives?: Record<string, Record<string, unknown>>,
 *          routing?: Record<string, object>, mappingRows?: Array<object>}} [deps]
 */
export function assertMappingConsistent(deps = {}) {
  const patchRows = deps.patchRows ?? PATCH_LAYER_ROWS
  const sources = deps.enforcementSources ?? ENFORCEMENT_SOURCES
  const resolvers = { ...STATIC_PRIMITIVES, ...(deps.primitives ?? {}) }
  // `routing` / `mappingRows` 可注入，理由与 PRT-607 把 preset 表改成可注入完全相同：
  // "每个决定来源都被引用"这条检查在**真实的两张表上恒为真**，
  // 于是它是一条**从不执行**的检查。
  //
  //   > 一个「检查一个不可能出现的值」的检查，
  //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
  //
  // 探针 ㊹① 第一次就是栽在这里：它把 spec line 449 那一行的 `guard` 去掉了，
  // 而没有任何用例变红——因为当时这条反向检查**根本不存在**。
  const routing = deps.routing ?? MODE_ROUTING
  const mappingRows = deps.mappingRows ?? ENFORCEMENT_MAPPING

  const problems = []
  const fail = (code, message) => problems.push({ code, message })

  // ① 两个方向都查：表里有的模式必须有路由；路由里的模式必须都在表里。
  const routed = Object.keys(routing)
  for (const mode of LEGION_MODES) {
    const route = routing[mode]
    if (route === undefined) {
      fail(MAPPING_CODES.MODE_UNROUTED, `模式 "${mode}" 不在 MODE_ROUTING 里`)
      continue
    }
    if (route.points.length === 0) {
      fail(MAPPING_CODES.MODE_WITHOUT_POINT, `模式 "${mode}" 没有挂到任何强制点`)
    }
  }
  for (const mode of routed) {
    if (!LEGION_MODES.includes(mode)) {
      fail(MAPPING_CODES.MODE_UNROUTED, `MODE_ROUTING 里有表外模式 "${mode}"（LEGION_MODES 没有它）`)
    }
  }

  // ② 所有被引用的点都得存在。
  const referenced = new Set()
  for (const route of Object.values(routing)) for (const p of route.points) referenced.add(p)
  for (const row of mappingRows) for (const p of row.points) referenced.add(p)
  for (const p of referenced) {
    if (DSH_ENFORCEMENT_POINTS[p] === undefined) {
      fail(MAPPING_CODES.POINT_UNKNOWN, `映射引用了不存在的强制点 "${p}"`)
    }
  }

  // ②b ★ 每个**决定来源**都必须被至少一行映射（或一条路由）引用。
  //
  // 只查"引用的点都存在"是不够的——反方向同样会安静地错：
  // 表里声明了 `guard` 是一个决定来源，而**没有任何一行要求它做任何事**。
  // 这时 `ENFORCEMENT_SOURCES` 里仍然有 `guard`（审计口径不变），
  // 启动自检照样全绿，而 hard floor 的"终审"实际上没人负责。
  //
  //   > 一个「声明了某个强制点、却没有任何一行映射到它」的表，
  //   > 与一个「这个点从来没被要求做过任何事」的表，是同一个东西——
  //   > 只不过前者在"点是否存在"的检查里是合格的。
  for (const point of decisionPoints()) {
    if (!referenced.has(point)) {
      fail(
        MAPPING_CODES.POINT_UNREFERENCED,
        `"${point}" 被声明为决定来源，但没有任何一行映射（或任何一条模式路由）引用它——` +
        '它在审计口径里存在，却从不被要求做任何事',
      )
    }
  }

  // ③ 决定来源恰等于审计口径，且没有 config 点混进来。
  const decisions = decisionPoints()
  const configs = configPoints()
  const sortedSources = [...sources].sort()
  if (decisions.join(',') !== sortedSources.join(',')) {
    fail(
      MAPPING_CODES.SOURCE_DRIFT,
      `映射的"决定来源"集合与 ENFORCEMENT_SOURCES 不一致：` +
      `映射=[${decisions.join(' ')}]，审计=[${sortedSources.join(' ')}]。` +
      '多出来的那个来源会在审计里声称它决定过一次调用，而它其实从不判定',
    )
  }
  for (const cfg of configs) {
    if (sortedSources.includes(cfg)) {
      fail(
        MAPPING_CODES.CONFIG_AS_SOURCE,
        `"${cfg}" 是 config 类点（只绑定配置、不判定调用），却出现在决定来源里`,
      )
    }
  }
  // 每条路由的 decidedBy 必须是 decision 类的点，且必须在它自己的 points 里。
  for (const route of Object.values(routing)) {
    if (route.decision === null) continue // 结局由 decideApproval 定，decidedBy 另查
    if (!route.points.includes(route.decidedBy)) {
      fail(MAPPING_CODES.POINT_UNKNOWN, `模式 "${route.mode}" 的 decidedBy "${route.decidedBy}" 不在它的 points 里`)
    }
    if (DSH_ENFORCEMENT_POINTS[route.decidedBy]?.kind !== 'decision') {
      fail(MAPPING_CODES.CONFIG_AS_SOURCE, `模式 "${route.mode}" 的定案点是 config 类点 "${route.decidedBy}"`)
    }
  }
  // 经过审批箱的模式，定案点必须是 approval。
  for (const route of Object.values(routing)) {
    if (route.viaApprovalBox && route.decidedBy !== 'approval') {
      fail(MAPPING_CODES.POINT_UNKNOWN, `模式 "${route.mode}" 经过审批箱，定案点却不是 approval（是 "${route.decidedBy}"）`)
    }
  }

  // ④ 补丁行必须真的存在。
  const rowIds = new Set(patchRows.map((r) => r.id))
  for (const point of Object.values(DSH_ENFORCEMENT_POINTS)) {
    if (point.patchRow === null) continue
    if (!rowIds.has(point.patchRow)) {
      fail(
        MAPPING_CODES.PATCH_ROW_MISSING,
        `强制点 "${point.id}" 声称由补丁行 "${point.patchRow}" 挂载，但 PATCH_LAYER_ROWS 里没有这一行`,
      )
    }
  }

  // ⑤ 原语必须存在。解析不了的记进 unresolved，不静默跳过。
  const unresolvedPrimitives = []
  for (const point of Object.values(DSH_ENFORCEMENT_POINTS)) {
    const { module, name } = point.primitive
    const table = resolvers[module]
    if (table === undefined) {
      unresolvedPrimitives.push({ point: point.id, module, name, why: '模块未注入（可能是 import 环）' })
      continue
    }
    if (typeof table[name] !== 'function') {
      fail(
        MAPPING_CODES.PRIMITIVE_MISSING,
        `强制点 "${point.id}" 声称由 ${module} 的 ${name}() 实现，但那里没有这个函数`,
      )
    }
  }

  // ⑥ allow-once 必须经过审批箱（票据必须被消费）。
  if (routing['allow-once'].viaApprovalBox !== true) {
    fail(
      MAPPING_CODES.ALLOW_ONCE_SHORTCUT,
      'allow-once 必须经过审批箱：把它映射成 pre-execute 直接放行，等于票据永不被消费、' +
      '同一张票能放行任意多次',
    )
  }

  return Object.freeze({
    version: ENFORCEMENT_MAPPING_VERSION,
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    // ★ 留证而不是布尔：调用方要能看出"这次到底查了哪几条"。
    checkedAt: 'load',
    modes: Object.freeze([...LEGION_MODES]),
    routedModes: Object.freeze([...routed].sort()),
    decisionPoints: Object.freeze(decisions),
    configPoints: Object.freeze(configs),
    auditSources: Object.freeze(sortedSources),
    mappingLines: Object.freeze(mappingRows.map((r) => r.line)),
    // 仍未解析的原语：空数组 = 全查过。
    unresolvedPrimitives: Object.freeze(unresolvedPrimitives),
  })
}

/**
 * 装载期自检。
 *
 * 它**不抛**：`ok === false` 时由启动自检（`startupSelfCheck`）把它变成一次
 * "强制面未生效"的判定，从而禁止自动执行——这与 `reconcilePatchLayer` 的处置一致。
 * 抛在 import 期只会让整个进程起不来，而"起不来"与"强制面没生效但还在跑"相比，
 * 后者才是这一层要防的东西。
 */
export const ENFORCEMENT_MAPPING_CHECKED = Object.freeze(assertMappingConsistent())

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

/**
 * 一次调用会落到哪些强制点、各阶段的预期（供 UI / 审计 / 用例直接读）。
 *
 * 与 `mapPermissionMode` 分开是因为它**不**调用 `decideApproval`：它是"这条模式
 * 的固定路径"的静态视图，用来回答"这个模式到底会不会经过审批箱"。
 */
export function enforcementPathOf(mode) {
  const route = routeForMode(mode)
  return Object.freeze(
    route.points.map((p) => {
      const point = DSH_ENFORCEMENT_POINTS[p]
      return Object.freeze({
        point: p,
        kind: point.kind,
        context: point.context,
        // approval 点展开成两个阶段：waterfall 之前 / waterfall 本身。
        // 这个展开就是 spec line 452 那个"**前**"字的落地。
        stages: point.stages === undefined ? Object.freeze([null]) : point.stages,
      })
    }),
  )
}

/**
 * 预设表 → 沙箱与审批策略的绑定（spec line 453）。
 *
 * 与 `approval-policy.mjs` 的 `assertPreset` 的区别：那边查的是"这个 preset
 * 合不合法"（无人值守不许降级沙箱），这边只是把绑定读出来给映射用。
 * 不重复实现检查。
 */
export function presetBinding(name) {
  const preset = LEGION_PERMISSION_PRESETS[name]
  if (preset === undefined) {
    throw mappingError(
      MAPPING_CODES.POINT_UNKNOWN,
      `未声明的 permission preset "${name}"（已知：${Object.keys(LEGION_PERMISSION_PRESETS).join(' / ')}）`,
    )
  }
  return Object.freeze({ name, sandbox: preset.sandbox, approval: preset.approval })
}

/**
 * 授权主体里**参与**哈希的键（spec line 470）。
 *
 * 直接取自 `enforcement.mjs` 的 `CANONICAL_OP_KEYS`，不另抄一份：
 *
 *   > 一个「在映射层再抄一份参与授权的键列表」的实现，
 *   > 与一个「映射说参与了、而哈希里没有它」的实现，是同一个东西。
 */
export function authorizationKeys() {
  return CANONICAL_OP_KEYS
}

// ---------------------------------------------------------------------------
// PRT-620：guard 只有降级语义 —— 放行过的调用不得被它拒绝
// ---------------------------------------------------------------------------

/**
 * 探针下限。**它不是生产下限**（生产下限来自工具目录与 manifest，而且可能是空的）。
 *
 * 这里用一个必然"拒绝点什么"的下限，是因为 `DEFAULT_HARD_FLOOR` 是空的：
 * 在空下限上，"pre-execute 放行 + guard 拒绝"永远不可能出现，
 * 那条不变量于是**永远不会被执行**——
 *
 *   > 一个「在不可能出错的输入上验证」的检查，
 *   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
 *
 * 探针样本因此必须同时包含"必被下限拦下"与"必不被拦下"两类
 * （工具名那一类与路径前缀那一类各一，否则两条下限分支里总有一条没被走到）。
 */
export const FLOOR_PROBE_FLOOR = Object.freeze({
  denyTools: Object.freeze(['shell.exec']),
  denyPathPrefixes: Object.freeze(['C:\\Work\\secrets']),
  cwd: 'C:\\Work',
  platform: 'win32',
})

/**
 * 探针样本：两个必被下限拦下，一个必不被拦下。
 *
 * 样本用 `name` 而不是 `toolName`：`createHardFloorGuard` 读的是 `execution.name`。
 * 换成另一个字段名之后，"按工具名拒绝"那一类下限会**静默不生效**——
 * 而它看起来与生效一模一样：样本全部通过、检查全绿、`throughCount` 还更大。
 */
export const FLOOR_PROBE_EXECUTIONS = Object.freeze([
  Object.freeze({ callId: 'probe-floor-deny-tool', name: 'shell.exec', arguments: Object.freeze({}) }),
  Object.freeze({ callId: 'probe-floor-deny-path', name: 'write', arguments: Object.freeze({ path: 'C:\\Work\\secrets\\k.txt' }) }),
  Object.freeze({ callId: 'probe-floor-pass', name: 'read', arguments: Object.freeze({ path: 'C:\\Work\\a.txt' }) }),
])

/**
 * 造出「同一次调用在两个强制点上的判定」对。
 *
 * `preExecuteFloor` 是 pre-execute 侧的静态下限投影，**默认就是同一个 guard 判定**。
 * 生产里这一投影由 `composePreExecuteFloor` 接到动态策略之前（spec line 437：
 * "静态禁令提前拒绝以避免无效询问"）；本函数只需要那份判定，因此直接复用同一个
 * `createHardFloorGuard` —— 再写一份"同样的比较"就等于给漂移留了位置。
 *
 * 它可以**注入**，正是为了让"两处下限不是同一份"这种配置错误能被造出来：
 * 注入一个缩水的投影（`() => undefined`），不变量必须立刻报出 `guard` 违规。
 */
export function guardApprovalPairs({ floor = FLOOR_PROBE_FLOOR, executions = FLOOR_PROBE_EXECUTIONS, preExecuteFloor } = {}) {
  const guard = createHardFloorGuard(floor)
  const atPreExecute = typeof preExecuteFloor === 'function' ? preExecuteFloor : guard
  return Object.freeze(executions.map((exec) => {
    const preReason = atPreExecute(exec)
    const guardReason = guard(exec)
    return Object.freeze({
      callId: exec.callId,
      toolName: exec.toolName ?? exec.name,
      preExecute: preReason === undefined
        ? Object.freeze({ kind: 'allow' })
        : Object.freeze({ kind: 'deny', reason: preReason }),
      // 静态下限这一路不问人：真正的 `ask` 由动态策略产生，那一路由用例送进来。
      approval: null,
      guard: Object.freeze({ reason: guardReason ?? null }),
    })
  }))
}

/**
 * ★ PRT-620 的不变量（spec §6.8 line 479）：
 *
 *   **任何已由 `tools/pre-execute` 放行、并取得 `allowed-once` 的调用，
 *     不得再被 `ctx.tools.guard()` 拒绝。**
 *
 * guard 只有降级语义、没有 allow 语义，所以"放行了又被 guard 拒"不是安全兜底，
 * 而是**强制面配置错误**：要么 pre-execute 没有把静态下限提前判（调用去问了人、
 * 人批了、guard 还是拒），要么两处的下限不是同一份。
 *
 * 违规必须**可定位到具体强制点**（line 479 的原话），所以每条违规都带
 * `point` / `auditSource`（后者取自审计口径）与 `callId`，可以直接拿去 filter
 * `tool_calls`。**修法文案不在这里**：`runtime/` → `team-hub/` 在仓库里是 0 处，
 * 方向不该为一个字符串反转；而本模块也 import 不了 `bootstrap.mjs`（会成环）。
 * 于是修法表由调用方**注入**（`repairActions`）——送不进来时 `repairAction` 为
 * `null`，而那本身就是一个信号：**这条违规没有对应的修复入口**。
 *
 * @param {Array<{callId?: string, toolName?: string, preExecute?: {kind: string},
 *                approval?: {outcome: string}|null, guard?: {decision?: string, reason?: string|null}}>} pairs
 * @param {{repairActions?: Record<string, {action?: string}>|null}} [options]
 */
export function checkApprovedCallsSurviveGuard(pairs = [], { repairActions = null } = {}) {
  const violations = []
  const rows = []
  // 修法按**检查项名**取。合规点（guard）与策略门点各有自己的入口；
  // 两者都缺时就承认"没有修法"，而不是编一个。
  const repairOf = (point) => {
    if (repairActions === null || typeof repairActions !== 'object') return null
    const candidates = point === 'guard'
      ? ['guard-approval-consistency', 'enforcement-mapping']
      : ['guard-approval-consistency', 'composition-patch-layer']
    for (const name of candidates) {
      const action = repairActions[name]?.action
      if (typeof action === 'string' && action !== '') return action
    }
    return null
  }
  const push = (pair, code, point, detail) => violations.push(Object.freeze({
    code,
    point,
    // 审计口径里这个点叫什么。`tool_calls.decisionSource` 就是按它写的。
    auditSource: point,
    // ★ 可执行的下一步。spec line 479 抱怨的是"审计里找不到该修哪里"——
    //   一条说得**出点名**的违规，与一条说得出去跑哪个修复入口的违规，
    //   对值班的人是两件不同的事。
    repairAction: repairOf(point),
    callId: pair?.callId ?? null,
    toolName: pair?.toolName ?? null,
    detail,
  }))

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const kind = pair?.preExecute?.kind
    if (kind !== 'allow' && kind !== 'deny' && kind !== 'ask') {
      push(pair, MAPPING_CODES.PAIR_MALFORMED, 'pre-execute',
        `pre-execute 判定 ${JSON.stringify(kind)} 不在闭集里：判不出来的对不能当作"没问题"`)
      rows.push(Object.freeze({ callId: pair?.callId ?? null, through: null, guard: null, pairing: 'malformed' }))
      continue
    }
    const outcome = pair?.approval?.outcome ?? null
    // 放行的两条路：pre-execute 直接 allow；或 ask 之后拿到一次 `allowed-once`。
    const through = kind === 'allow' || (kind === 'ask' && outcome === 'allowed-once')
    const guardDecision = pair?.guard?.decision ?? (pair?.guard?.reason == null ? 'pass' : 'deny')
    rows.push(Object.freeze({
      callId: pair?.callId ?? null,
      toolName: pair?.toolName ?? null,
      preExecute: kind,
      approval: outcome,
      through,
      guard: guardDecision,
    }))
    if (guardDecision !== 'pass' && guardDecision !== 'deny' && guardDecision !== 'allow') {
      push(pair, MAPPING_CODES.PAIR_MALFORMED, 'guard',
        `guard 判定 ${JSON.stringify(guardDecision)} 不在闭集里`)
      continue
    }
    // ① guard 报"allow"：它**没有**这个语义。
    if (guardDecision === 'allow') {
      push(pair, MAPPING_CODES.GUARD_HAS_ALLOW_SEMANTICS, 'guard',
        'guard 返回了 allow：它只有降级语义。'
        + '一个会放行的 guard，与一个"同步、确定性、最终单调拒绝"的 guard，不是同一个东西')
    }
    // ② ★ 这条不变量本身。
    if (through && guardDecision === 'deny') {
      push(pair, MAPPING_CODES.GUARD_DENIED_APPROVED, 'guard',
        `guard 拒绝了一次已经放行的调用（pre-execute=${kind}${outcome === null ? '' : `，approval=${outcome}`}）：`
        + `${pair?.guard?.reason ?? '(未给理由)'}。`
        + '这说明 pre-execute 的静态下限与 guard 的不是同一份——'
        + '一个「人批了之后仍然被 guard 拒绝」的强制面，'
        + '与一个「配置错了、但每个点单看都是绿的」的强制面，是同一个东西')
    }
  }

  return Object.freeze({
    version: ENFORCEMENT_MAPPING_VERSION,
    pairs: rows.length,
    throughCount: rows.filter((r) => r.through === true).length,
    guardDeniedCount: rows.filter((r) => r.guard === 'deny').length,
    violations: Object.freeze(violations),
    ok: violations.length === 0,
    // 违规定位到的强制点（去重排序）。空数组 = 这次没有任何点出问题。
    points: Object.freeze([...new Set(violations.map((v) => v.point))].sort()),
    rows: Object.freeze(rows),
  })
}

/**
 * 一致性自检（PRT-620）。
 *
 * `consistent` 走真实原语与探针下限；`tampered` 把 pre-execute 的静态下限换成
 * "什么都不拦"，违规**必须**出现，且必须点名 `guard`。
 *
 * 反向控制不能省：没有它，这条检查就只在一个"两处下限天然一致"的输入上跑过，
 * 与一条不存在的检查在"它到底拦住了什么"上是同一个东西。
 *
 * `repairActions` 注入进来之后，`tamperedCaught` 多一个条件：**每条违规都得说得出
 * 修复入口**。说不出来时这条检查照样报不通过——一条"点得出名、却没有下一步"的
 * 违规，正是 spec line 479 描述的那个状态。
 */
export function checkGuardApprovalConsistency(deps = {}) {
  const floor = deps.floor ?? FLOOR_PROBE_FLOOR
  const consistent = checkApprovedCallsSurviveGuard(guardApprovalPairs(deps), deps)
  const tampered = checkApprovedCallsSurviveGuard(
    guardApprovalPairs({ ...deps, preExecuteFloor: () => undefined }),
    deps,
  )
  const repairable = deps.repairActions == null
    ? null
    : tampered.violations.every((v) => typeof v.repairAction === 'string' && v.repairAction !== '')
  // ★ 这三条合起来才是"这条检查会红"：真实输入不误报、坏输入必须被拦、
  //   且拦下来说的是 `guard` 这个点（可定位）。
  const tamperedCaught = consistent.violations.length === 0
    && tampered.violations.length > 0
    && tampered.violations.every((v) => v.point === 'guard')
    && repairable !== false
  return Object.freeze({
    version: ENFORCEMENT_MAPPING_VERSION,
    probeFloor: Object.freeze({
      executions: consistent.rows.length,
      denyTools: (floor.denyTools ?? []).length,
      denyPathPrefixes: (floor.denyPathPrefixes ?? []).length,
    }),
    consistent,
    tampered,
    tamperedCaught,
    // 注入过修法表时，这里说明它是否真的覆盖了违规点（`null` = 没人注入）。
    repairable,
    // 反向控制红不了 ⇒ **这一条不许报"通过"**：它要么是探针没内容（空下限），
    // 要么是检查本身坏了。两种都不该被读成"没问题"。
    //
    //   > 一个「在不可能出错的输入上验证」的检查，
    //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
    ok: tamperedCaught,
    // 被拦下的调用里确实有"已经放行"的那些——否则它拦的不是这条不变量。
    tamperedThrough: tampered.throughCount,
  })
}

/** 装载期结论（计算值，不是 `ok` 布尔）。 */
export const GUARD_CONSISTENCY_CHECKED = Object.freeze(checkGuardApprovalConsistency())

// runtime/dsh-composition/tool-request.mjs
// ============================================================================
// PRT-602：DSH Enforcement Bridge 与**统一 ToolRequest 投影**
//
// spec §6.5 line 470：
//   「canonical operation 明确定义：Schema 版本、domain separator、固定键集合与顺序、
//     Unicode NFC、路径绝对化与分隔符、Windows 大小写规则、数字和空值表达。
//     授权主体包含 scope、actor、action、target、taskId、toolName、callId 和不可变
//     工具参数；attemptId、UI 文案、时间戳等观察 metadata **不参与**授权哈希。」
//
// spec §6.8 line 479：
//   「任何已由 `tools/pre-execute` 放行且获得 `allowed-once` 的调用，不得再被
//     `ctx.tools.guard()` 拒绝。guard 只有降级语义、没有 allow 语义，出现"人工已批准
//     但仍被 guard 拒绝"即视为强制面配置错误，**必须能由审计定位到具体强制点**。」
//
// ---------------------------------------------------------------------------
// 为什么需要一个**统一**投影：三个强制点各投影一次就会漂移
//
// 强制面有四个观察同一件事实的地方：`guard`、`tools/pre-execute`、approval answerer、
// 以及写入 `tool_calls` 的审计。它们拿到的原始输入各不相同（DSH 的 execution、
// answerer 的 request、F-02 的 operation、审计的行）。
//
// 最自然的写法是**每个点各自从原始输入里取它需要的字段**。它在每个点的用例里都是
// 绿的，因为每个点自己那一份推导是自洽的：
//
//     guard 看 `execution.arguments.path`
//     审批看 `execution.arguments.file_path`
//     审计把 `target` 记成工具名
//
// 于是"审批绑定的目标"与"guard 检查的目标"是两个各自算出来的字符串。
//
//   > 一个「每个强制点各自把自己那份输入投影一遍」的桥，
//   > 与一个「审批绑定了 A、而 guard 检查的是 B」的桥，是同一个东西——
//   > 只不过前者在任何单个强制点的用例里都是绿的。
//
// 所以本文件只提供**一个**投影函数 `projectToolRequest`，四个强制点都从它的**输出**
// 读取；四个"摄入适配器"（guard / pre-execute / approval / audit）只是把同一份投影
// 摆成各自的形状，**不得再做任何推导**。
//
// ---------------------------------------------------------------------------
// 第二件事：目标（target）必须**推导一次**，推导不出来就**拒绝**
//
// `target` 是授权主体的一个键，它决定"这次批准覆盖的是什么"。最安静的失效是
// **推不出来时用空串兜底**：
//
//   > 一个「有外部效果、但目标推导不出来时用空串兜底」的投影，
//   > 与一个「所有无法定位的写操作共用同一个身份」的投影，是同一个东西——
//   > 而它的方向是**放行**：一次批准覆盖了任意目标。
//
// 所以推导不出来就抛（拒绝当前调用），绝不兜底。
//
// 目标推导必须由**能力**驱动，不能由工具名驱动：
//
//   > 一个「按工具名查表得出目标字段」的投影，
//   > 与一个「工具改名之后目标静默变成 undefined」的投影，是同一个东西——
//   > 只不过后者的走向取决于下一个人写的是抛错还是兜底。
//
// ---------------------------------------------------------------------------
// 第三件事：观察 metadata 要**拒**，不是**滤**
//
//   > 一个「把观察 metadata 从哈希里滤掉、但允许它留在主体对象里」的投影，
//   > 与一个「它随时会被下一次重构重新算进去」的投影，是同一个东西。
//
// ---------------------------------------------------------------------------
// 第四件事：两种"冲突"必须分得开
//
// 审计里会出现两种看起来一样的现象：
//   · **投影漂移**：两个强制点为同一次调用算出了**不同**的哈希
//   · **强制点冲突**：同一个哈希上，pre-execute 放行而 guard 拒绝
//
//   > 一个「把'目标推导漂移'与'guard 与 pre-execute 冲突'报成同一条告警」的审计，
//   > 与一个「值班的人分不清该改哪一处配置」的审计，是同一个东西。
//
// 前者是**实现 bug**（该改投影），后者是**配置错误**（该改 hard floor 或策略）。
// 两条各有自己的码、各自的检查、各自的修复动作。
// ============================================================================

import {
  CANONICAL_OP_KEYS,
  CANONICAL_OP_SCHEMA_VERSION,
  DEFAULT_HARD_FLOOR,
  canonicalOperationHash,
  canonicalizePath,
  createApprovalAnswerer,
  createHardFloorGuard,
  createPreExecutePolicy,
  nfc,
} from './enforcement.mjs'
import { CAPABILITY_IDS, CAPABILITY_KINDS, resolveTool } from './tool-capability.mjs'
import { freezeToolArguments, resolvePreExecuteResult } from './tool-args.mjs'
// patch-layer 是纯数据模块（零 import），所以这一条依赖是单向的、不会成环。
import { PATCH_LAYER_ROWS } from './patch-layer.mjs'
// PRT-214 缺口②：身份覆盖的取用缝与叠加。单向依赖（它只 import contracts），不成环。
import { applyIdentityOverlay } from '../contracts/run-identity.mjs'
import { identityOverlayForExecution } from './run-identity.mjs'

export const TOOL_REQUEST_VERSION = 'legion/tool-request@1'

export const PROJECTION_CODES = Object.freeze({
  TARGET_MISSING: 'tool-request-target-missing',
  TARGET_AMBIGUOUS: 'tool-request-target-ambiguous',
  BAD_REQUEST: 'tool-request-malformed',
  NO_CALL_ID: 'tool-request-no-call-id',
  LEAKED_OBSERVATION_KEY: 'tool-request-observation-key-in-subject',
  PROJECTION_DRIFT: 'tool-request-projection-drift',
  GUARD_CONTRARY: 'tool-request-guard-contrary-to-pre-execute',
})

/**
 * 每个能力**可能**承载目标的参数名。
 *
 * 这是 capability → argument names 的表，**不是** tool name → argument name 的表。
 * 工具改名不影响它；新工具只要声明了能力就自动被覆盖。
 */
export const TARGET_ARGUMENTS = Object.freeze({
  'file:read': Object.freeze(['path', 'file_path', 'filePath']),
  'file:write': Object.freeze(['path', 'file_path', 'filePath']),
  'file:delete': Object.freeze(['path', 'file_path', 'filePath']),
  'repo:read': Object.freeze(['path', 'repo', 'cwd']),
  'repo:write': Object.freeze(['path', 'repo', 'cwd']),
  'repo:push': Object.freeze(['remote', 'repo', 'url']),
  'command:exec': Object.freeze(['command', 'cmd', 'argv']),
  'process:spawn': Object.freeze(['command', 'cmd', 'argv']),
  'network:read': Object.freeze(['url', 'endpoint', 'host']),
  'network:write': Object.freeze(['url', 'endpoint', 'host']),
  'external-api:read': Object.freeze(['url', 'endpoint', 'api']),
  'external-api:write': Object.freeze(['url', 'endpoint', 'api']),
  'mcp:call': Object.freeze(['server', 'tool', 'endpoint']),
  'credential:read': Object.freeze(['key', 'name', 'secret']),
  'credential:write': Object.freeze(['key', 'name', 'secret']),
  'message:send': Object.freeze(['to', 'channel', 'recipient']),
})

/**
 * 没有目标参数时，目标就是**这次调用发生的工作目录**的能力。
 *
 * 只有这些能力允许"无目标调用"，因为无目标调用的作用范围确实只由 cwd 界定。
 *
 * ⚠️ 这个集合**不能**包含任何有外部效果或不可逆的能力。否则 `fetch-url` 不带 url
 * 会被投影成"读取当前目录"并被批准一次：
 *
 *   > 一个「有外部效果的能力被放进'无目标'名单」的表，
 *   > 与一个「不带参数的网络调用被当成读本地文件」的表，是同一个东西——
 *   > 而它的方向是放行。
 *
 * 装载时 `assertTargetlessSafe` 会真的去查 `CAPABILITY_KINDS` 核对这一点。
 */
export const CONTEXT_SCOPED_CAPABILITIES = Object.freeze(['repo:read'])

/**
 * 未登记工具的目标候选名。
 *
 * 未登记工具＝"我不知道它会干什么"。所以**任何**已知的目标类参数都算候选：
 * 恰好一个非空候选 → 用它；一个都没有 → 抛（无法界定作用范围，不得批准）；
 * 两个以上不同候选 → 抛（到底是文件还是 URL？不猜）。
 */
export const GENERIC_TARGET_ARGUMENTS = Object.freeze([
  'path', 'file_path', 'filePath', 'repo', 'remote', 'url', 'endpoint', 'api',
  'host', 'command', 'cmd', 'argv', 'server', 'tool', 'key', 'secret', 'to', 'channel', 'recipient',
])

/** DSH 侧 execution 上 callId 的候选字段名。 */
export const CALL_ID_FIELDS = Object.freeze(['callId', 'call_id', 'id'])

/** 参与授权哈希的键，就是强制面那一份。**不复制**。 */
export const SUBJECT_KEYS = CANONICAL_OP_KEYS

/** 观察 metadata：出现在主体参数里时**拒绝**投影。 */
export const OBSERVATION_KEYS = Object.freeze([
  'attemptId', 'attempt_id', 'atText', 'at', 'ts', 'timestamp',
  'uiText', 'label', 'summary', 'elapsedMs', 'retryCount',
])

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

// ------------------------------------------------------------- 入站规范化

/**
 * 唯一一处"从 DSH 的执行对象取出请求"的地方。
 *
 * 它只做**字段改名**（DSH 用 `name`，我们用 `toolName`），不做任何推导——
 * 不改写参数、不补默认目标、不折叠路径。那些都在 `projectToolRequest` 里，
 * 只发生一次。
 */
export function requestFromExecution(execution) {
  if (execution === null || typeof execution !== 'object') {
    throw fail(PROJECTION_CODES.BAD_REQUEST, 'requestFromExecution 需要一个执行对象')
  }
  const toolName = execution.toolName ?? execution.name
  if (toolName === undefined || nfc(String(toolName)).trim() === '') {
    throw fail(PROJECTION_CODES.BAD_REQUEST, '执行对象缺少工具名（toolName / name）')
  }
  let callId
  for (const f of CALL_ID_FIELDS) {
    if (execution[f] !== undefined && nfc(String(execution[f])).trim() !== '') { callId = execution[f]; break }
  }
  if (callId === undefined) {
    throw fail(
      PROJECTION_CODES.NO_CALL_ID,
      `执行对象缺少 callId（试过 ${JSON.stringify(CALL_ID_FIELDS)}）。` +
      'callId 是授权主体的一个键（spec §6.5 line 470）：没有它，这次调用的身份不完整，' +
      '而"身份不完整就放行"与"不校验身份"是同一个东西',
    )
  }
  return {
    toolName,
    callId,
    // `null` 与 `undefined` 都当作"没有参数"：DSH 序列化空参数时两种都会出现。
    // 注意这只影响"有没有参数"，不影响目标推导——目标永远照样要推出来。
    arguments: execution.arguments === undefined || execution.arguments === null ? {} : execution.arguments,
    uiText: execution.uiText ?? null,
  }
}

// ------------------------------------------------------------------- 目标推导

/**
 * 从**能力**与本次调用的参数推导目标。推导不出来就抛，绝不兜底。
 */
export function deriveTarget({ capabilities, args, cwd, toolName, platform = process.platform } = {}) {
  const argObj = args ?? {}
  // 显式声明优先：工具可以说清"我的目标就是这个字段"。
  if (typeof argObj.target === 'string' && argObj.target.trim() !== '') {
    return { target: argObj.target, from: 'explicit', candidates: [argObj.target] }
  }

  const caps = Array.isArray(capabilities) ? capabilities : []
  const names = caps.length > 0
    ? [...new Set(caps.flatMap((c) => TARGET_ARGUMENTS[c] ?? []))]
    : [...GENERIC_TARGET_ARGUMENTS]

  const found = []
  for (const n of names) {
    const v = argObj[n]
    if (v === undefined || v === null) continue
    const s = Array.isArray(v) ? v.join(' ') : (typeof v === 'string' ? v : String(v))
    if (s.trim() === '') continue
    found.push({ name: n, value: s })
  }
  const distinct = [...new Set(found.map((f) => f.value))]

  if (distinct.length === 1) {
    return { target: distinct[0], from: `argument:${found[0].name}`, candidates: distinct }
  }
  if (distinct.length > 1) {
    throw fail(
      PROJECTION_CODES.TARGET_AMBIGUOUS,
      `工具 ${toolName} 的目标不唯一（候选 ${JSON.stringify(found.map((f) => f.name))} 给出了 `
      + `${distinct.length} 个不同的值）。不猜——`
      + '一个"两个候选里随便挑一个"的投影，与一个"审批绑定 A、guard 检查 B"的投影，是同一个东西。'
      + '请让工具用一个显式的 `target` 参数说明目标',
    )
  }

  // 一个候选都没有：只有"作用范围本来就只有工作目录"的能力可以继续。
  const scoped = caps.length > 0 && caps.every((c) => CONTEXT_SCOPED_CAPABILITIES.includes(c))
  if (scoped) {
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw fail(
        PROJECTION_CODES.TARGET_MISSING,
        `工具 ${toolName} 是无目标调用，但拿不到工作目录——无法证明它的作用范围。不猜工作目录`,
      )
    }
    return { target: cwd, from: 'cwd', candidates: [] }
  }

  throw fail(
    PROJECTION_CODES.TARGET_MISSING,
    `工具 ${toolName}（能力 ${JSON.stringify(caps)}）的目标推导不出来。拒绝投影：`
    + '一个"目标推导不出来时用空串兜底"的投影，与一个"所有无法定位的写操作共用同一个身份"的投影，'
    + '是同一个东西——而它的方向是放行',
  )
}

// --------------------------------------------------------------------- 投影

/**
 * 把一次原始工具请求投影成**唯一一份** `ToolExecution`。四个强制点读的都是它。
 *
 * @param {object} p
 * @param {object} p.request  DSH 侧原始请求：`{toolName, callId, arguments, uiText}`
 * @param {object} p.context  Legion 侧上下文：`{scope, actor, action, taskId, cwd, platform}`
 */
export function projectToolRequest({ request, context } = {}) {
  if (request === null || typeof request !== 'object') {
    throw fail(PROJECTION_CODES.BAD_REQUEST, 'projectToolRequest 需要一个原始请求对象')
  }
  if (context === null || typeof context !== 'object') {
    throw fail(PROJECTION_CODES.BAD_REQUEST, 'projectToolRequest 需要一个 Legion 上下文（scope/actor/action/taskId）')
  }

  const toolName = nfc(String(request.toolName ?? '')).trim()
  if (toolName === '') throw fail(PROJECTION_CODES.BAD_REQUEST, '原始请求缺少 toolName')
  const callId = nfc(String(request.callId ?? '')).trim()
  if (callId === '') throw fail(PROJECTION_CODES.NO_CALL_ID, `工具 ${toolName} 的原始请求缺少 callId`)

  const rawArgs = request.arguments === undefined || request.arguments === null ? {} : request.arguments
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw fail(PROJECTION_CODES.BAD_REQUEST, `工具 ${toolName} 的 arguments 必须是一个对象`)
  }

  const leaked = OBSERVATION_KEYS.filter((k) => rawArgs[k] !== undefined)
  if (leaked.length > 0) {
    throw fail(
      PROJECTION_CODES.LEAKED_OBSERVATION_KEY,
      `工具 ${toolName} 的参数里出现了观察 metadata ${JSON.stringify(leaked)}。`
      + 'spec §6.5 line 470：attemptId、UI 文案、时间戳不参与授权哈希——'
      + '滤掉是不够的，留在主体里就迟早会被下一次重构重新算进去',
    )
  }

  const facts = resolveTool(toolName)
  const capabilities = facts.capabilities
  const cwd = context.cwd
  const platform = context.platform ?? process.platform

  const derived = deriveTarget({ capabilities, args: rawArgs, cwd, toolName, platform })
  const canonicalTarget = canonicalizePath(derived.target, { cwd, platform })

  // 参数冻结交给 PRT-613。**同一份**冻结体给四个强制点，不做第二份。
  const frozenBody = freezeToolArguments({ toolName, args: rawArgs, summary: request.uiText ?? null })

  const subject = {}
  for (const key of SUBJECT_KEYS) {
    if (key === 'target') { subject[key] = derived.target; continue }
    if (key === 'toolName') { subject[key] = toolName; continue }
    if (key === 'callId') { subject[key] = callId; continue }
    if (key === 'arguments') { subject[key] = frozenBody.arguments; continue }
    const v = context[key]
    if (v === undefined) {
      throw fail(PROJECTION_CODES.BAD_REQUEST, `Legion 上下文缺少授权主体字段 ${key}`)
    }
    subject[key] = v
  }

  const ordered = {}
  for (const key of SUBJECT_KEYS) ordered[key] = subject[key]
  const canonicalHash = canonicalOperationHash(ordered, { cwd, platform })

  return Object.freeze({
    version: TOOL_REQUEST_VERSION,
    schemaVersion: CANONICAL_OP_SCHEMA_VERSION,
    toolName,
    callId,
    arguments: frozenBody.arguments,
    frozenBody,
    frozenHash: frozenBody.canonicalHash,
    subject: Object.freeze(ordered),
    canonicalHash,
    target: derived.target,
    canonicalTarget,
    targetFrom: derived.from,
    targetCandidates: Object.freeze(derived.candidates),
    capabilities: Object.freeze([...capabilities]),
    capabilityFacts: Object.freeze(Object.fromEntries(
      (capabilities.length > 0 ? capabilities : ['<unknown>']).map((c) => [c, CAPABILITY_KINDS[c] ?? null]),
    )),
    risk: facts.risk,
    direction: facts.direction,
    known: facts.known,
    // `unknown` 工具的方向是 `write`（fail closed），所以"是不是写"用
    // `direction !== 'read'`。用 `=== 'write'` 会让未登记工具被读成"不是写"。
    isWrite: facts.direction !== 'read',
    externalEffectPossible: facts.externalEffectPossible,
    irreversible: facts.irreversible,
    requiresApproval: facts.requiresApproval,
    hardFloor: facts.hardFloor,
    cwd: cwd ?? null,
    platform,
    summary: frozenBody.summary,
  })
}

// ------------------------------------------------------- 四个摄入适配器
//
// 它们**只摆放**，不再推导。任何在这里出现的 `arguments.path ?? arguments.file_path`
// 都是漂移的来源：
//
//   > 一个「在适配器里顺手补一次字段兜底」的桥，
//   > 与一个「两个强制点看到两个不同目标」的桥，是同一个东西。

/** guard 要吃的那一份（同步、只有降级语义）。 */
export function guardInputOf(projection) {
  return Object.freeze({
    name: projection.toolName,
    arguments: projection.arguments,
    // guard 的路径检查读这一个字段——就是投影算出来的那个，不是它自己再找一遍
    __legionTarget: projection.canonicalTarget,
    __legionCanonicalHash: projection.canonicalHash,
  })
}

/** `tools/pre-execute` 要吃的那一份。 */
export function preExecuteInputOf(projection) {
  return Object.freeze({
    toolName: projection.toolName,
    callId: projection.callId,
    arguments: projection.arguments,
    canonicalHash: projection.canonicalHash,
    target: projection.canonicalTarget,
    risk: projection.risk,
    isWrite: projection.isWrite,
  })
}

/** approval answerer 要吃的那一份。 */
export function approvalRequestOf(projection, { reason = '', signal = null } = {}) {
  return Object.freeze({
    toolName: projection.toolName,
    callId: projection.callId,
    reason,
    signal,
    canonicalHash: projection.canonicalHash,
    arguments: projection.arguments,
    target: projection.canonicalTarget,
  })
}

/** 写入 `tool_calls` 的那一份（PRT-610 的行形状）。 */
export function toolCallRowOf(projection, { decision, decisionSource, resultStatus = 'none', reason = null, runId = null, attemptId = null, atText = null } = {}) {
  return Object.freeze({
    callId: projection.callId,
    toolName: projection.toolName,
    decision,
    decisionSource,
    reason,
    rawInput: projection.arguments,
    canonicalInput: projection.arguments,
    canonicalHash: projection.canonicalHash,
    runId,
    attemptId,
    atText,
    resultStatus,
  })
}

/**
 * 四个摄入适配器必须报告**同一个**哈希，并且看到**同一份**参数。
 *
 * 这是"投影漂移"的检查——与"强制点冲突"（`assertNoContradiction`）分开。
 *
 * ⚠️ 它比较的是**真正调用四个适配器之后算出来的值**，不是四份声明。
 * PRT-611 的教训：比"名单"永远比得过，比"值"才拦得住。
 *
 *   > 一个「比对四个强制点各自声明的键列表」的自检，
 *   > 与一个「比对四个强制点实际产出的哈希」的自检，在「漂移能不能被拦下」上
 *   > 是同一个东西——只不过前者在任何一次真正的字段改名面前都是绿的。
 *
 * `adapters` 可注入：正确实现下 `agreed` 恒为真，那段断言永远不触发。
 */
export function assertProjectionAgrees({ projection, adapters = {} } = {}) {
  const g = adapters.guardInputOf ?? guardInputOf
  const p = adapters.preExecuteInputOf ?? preExecuteInputOf
  const a = adapters.approvalRequestOf ?? approvalRequestOf
  const r = adapters.toolCallRowOf ?? toolCallRowOf

  const gv = g(projection)
  const pv = p(projection)
  const av = a(projection)
  const rv = r(projection, { decision: 'allow', decisionSource: 'pre-execute' })
  const seen = [
    { surface: 'guard', hash: gv.__legionCanonicalHash, args: gv.arguments },
    { surface: 'pre-execute', hash: pv.canonicalHash, args: pv.arguments },
    { surface: 'approval', hash: av.canonicalHash, args: av.arguments },
    { surface: 'audit', hash: rv.canonicalHash, args: rv.canonicalInput },
  ]
  const hashes = [...new Set(seen.map((s) => s.hash))]
  const sameArguments = seen.every((s) => s.args === projection.arguments)
  return Object.freeze({
    agreed: hashes.length === 1 && sameArguments,
    code: hashes.length === 1 && sameArguments ? null : PROJECTION_CODES.PROJECTION_DRIFT,
    expected: projection.canonicalHash,
    perSurface: Object.freeze(seen.map((s) => Object.freeze({ surface: s.surface, canonicalHash: s.hash }))),
    sameArguments,
  })
}

export function assertNoProjectionDrift(evidence) {
  const e = evidence ?? assertProjectionAgrees({ projection: SAMPLE_PROJECTION })
  if (!e.agreed) {
    throw fail(
      e.code,
      `强制面之间投影不一致：期望 ${e.expected}，实际 `
      + `${JSON.stringify(e.perSurface.map((s) => `${s.surface}=${s.canonicalHash}`))}，同一份参数=${e.sameArguments}。`
      + '这是实现 bug（该改投影），不是配置错误（该改 hard floor）',
    )
  }
  return e
}

// ------------------------------------------------------------------- 桥

/**
 * 组装 Enforcement Bridge：三个强制点共用**同一份**投影，并把每个决定记进
 * 一本按哈希索引的账。
 *
 * 账是 §6.8 line 479 那句"必须能由审计定位到具体强制点"的落地：它让
 * "同一个哈希上 pre-execute 放行、guard 却拒绝"这件事**可查**。
 */
export function createEnforcementBridge({
  context,
  floor = DEFAULT_HARD_FLOOR,
  decide = null,
  requestApproval = null,
  /**
   * PRT-603 的岗位白名单：`(projection) => {allowed, rule, reason}`。
   *
   * ★ 它在**策略端口之前**跑，而且拒绝即定案。反过来的话，
   *
   *   > 一个「先问策略、策略说 allow 就放行」的桥，
   *   > 与一个「岗位清单只在策略也说不的时候才生效」的桥，是同一个东西。
   */
  whitelist = null,
  /**
   * PRT-604 的路径范围：`(projection) => {allowed, code, reason}`。
   *
   * ★ pre-execute 与 guard **两处都查**（spec §6.6 line 449）。
   * 只在一处查的写法在"只经过一个强制点"的用例里是绿的。
   */
  pathScope = null,
  /**
   * ★ PRT-214 缺口②：**按 Run** 取授权身份覆盖。
   *
   * `(execution) => overlay | undefined`。缺省就是
   * `run-identity.mjs` 的 `identityOverlayForExecution`——它按 `exec.agent`
   * 的对象身份查那张登记簿（装身份的是 `installRunIdentityIntoAgent`）。
   *
   * ## 为什么这是一个注入点，而不是在这里直接查
   *
   * 桥的用例要能在**不造 Agent** 的情况下验"两个 Run 各带各的身份"；
   * 而"覆盖从哪来"正是这条链上唯一需要替身的一段。把它做成参数，
   * 断言的仍然是**桥自己的行为**（它有没有把覆盖叠进投影），
   * 而不是替身的行为。
   *
   * ## 为什么默认可为空（`null` 就是不叠）
   *
   * 一个"必须注入身份源才能造桥"的签名会让所有既有调用点都得改一遍，
   * 而它们里的绝大多数（装配级用例、诊断页）验的**不是**身份。
   * 传 `null` 时行为与今天逐字相同：投影只用进程级上下文。
   *
   * ★ 而**缺省值就是生产那个**（`identityOverlayForExecution`）：
   * 生产装配（`assemble.mjs`）因此不必显式传参就已经是"按 Run 生效"的，
   * 少一处"某天有人加了一个新的 `createEnforcementBridge` 调用点、而它忘了传身份"
   * 的机会。要**关掉**覆盖才需要显式传 `null`——那在读代码时是看得见的。
   */
  identityFor = identityOverlayForExecution,
  /**
   * ★★ F-21 / 第 19 条：连接器熔断器的**反馈面**（2026-09-18 加）。
   *
   * 类型：`(exec, result) => void`——`runtime/connectors/outcome-port.mjs` 的
   * `createOutcomeListener()` 造出来的那个监听器，**由组合方挂到 DSH 的
   * `tools/result` 事件上**（桥自己不订阅事件——理由与 preExecute 那一行相同：
   * 事件的订阅属于"行"，判定与记录的逻辑属于桥）。
   *
   * ## 为什么桥必须**知道**它，而不是只让组合方自己拿着
   *
   * 因为 §10 量出来的那个缺口正是：**少装了什么都看不出来**。
   * `runtime/connectors/registry.mjs` 的 `decide()` 读熔断器，
   * 而改它的 `recordOutcome()` 生产调用方是 0 处——只接判定面会得到
   * **一个永远合闸、且一行错都不报**的熔断器。`enforcementSurfaces()`
   * 是"到底挂了几道"的**唯一**读数，所以反馈面必须在那一格里出现：
   *
   *   > 一个"接了连接器判定、但反馈面没装"的强制面，
   *   > 与一个"连接器从来不会因为失败而被拦下"的强制面，是同一个东西——
   *   > 只不过前者的 `enforcementSurfaces()` 看起来是接好的。
   *
   * ## 为什么默认可为空（`null` 就是不装）
   *
   * 与 `whitelist` / `pathScope` 同一条口径：既有调用点（装配级用例、
   * 诊断页）里绝大多数验的**不是**连接器，让签名变硬会把它们全改一遍。
   * 传 `null` 时行为与本批之前逐字相同。**但**它会在
   * `enforcementSurfaces().connectorFeedback` 上读成 `false`——
   * "没装"是**看得见**的，这正是本参数存在的意义。
   *
   * ★ 非 `null` 又不是函数 ⇒ **构造期抛**（见下面）：一个既不是端口
   * 也不是"没给"的值，只可能是接线写错了，而静默当成"没给"会让
   * `enforcementSurfaces()` 报 `false`——把一次**写错**读成一次**没配**。
   */
  connectorFeedback = null,
  connectTimeoutMs = 2000,
  responseTimeoutMs = 3000,
  approvalConnectTimeoutMs = 2000,
  approvalResponseTimeoutMs = 60_000,
  now = () => Date.now(),
  onDecision,
  onContradiction,
} = {}) {
  if (context === null || typeof context !== 'object') throw new Error('createEnforcementBridge 需要 Legion 上下文')
  // ★ 反馈面：要么不给，要么是函数。一个"既不是端口也不是没给"的值
  //   在 `enforcementSurfaces()` 上会读成 `false`——于是"接线写错了"
  //   与"这一道没配"变成同一个读数，而两者的修法完全不同。
  if (connectorFeedback !== null && typeof connectorFeedback !== 'function') {
    throw fail(PROJECTION_CODES.BAD_REQUEST,
      `connectorFeedback 要么不给（null），要么是 (exec, result) => void 的监听器` +
      `（收到 ${typeof connectorFeedback}）。**不静默当成"没给"**：` +
      '那会让"接线写错"与"这一道没配"在 enforcementSurfaces() 上同形')
  }

  const ledger = new Map()
  const contradictions = []
  /** 按 callId 记住投影：guard 在 pre-execute 之后跑，读的是**同一份**。 */
  const byCallId = new Map()

  /**
   * ★ PRT-214 缺口②：这次调用用的 Legion 上下文。
   *
   * 进程级那份是**基线**；这次 Run 若带了身份覆盖，就叠在它上面。
   * `actor` / `action` **永远**来自基线（见 `run-identity.mjs` 的文件头：
   * RunRequest 里没有能权威地assert"这次由别人负责"的字段，
   * 接受覆盖等于让审计归属由请求方自填）。
   */
  const contextFor = (execution) => {
    if (typeof identityFor !== 'function') return context
    let overlay
    try {
      overlay = identityFor(execution)
    } catch (err) {
      // ★ 取覆盖时抛错 ⇒ **不叠**，按进程级继续。这不是"吞掉错误"：
      //   `identityFor` 是装配方给的纯查表函数（WeakMap 读），会抛说明它坏了，
      //   而一个坏掉的查表函数**没有任何**能推导出"这次该用哪个身份"的信息。
      //   此时按进程级继续，是回落；`ask` 式的"问不到就拒绝"在这里用不上——
      //   身份缺失不会让强全面少一个面（见 run-identity.mjs 文件头那条差别）。
      overlay = undefined
    }
    if (overlay === undefined || overlay === null) return context
    return applyIdentityOverlay(context, overlay)
  }

  const project = (request, execution) => projectToolRequest({ request, context: contextFor(execution) })

  function record(hash, entry) {
    if (!ledger.has(hash)) ledger.set(hash, [])
    ledger.get(hash).push(Object.freeze(entry))
  }

  const guarded = createHardFloorGuard({ ...floor, cwd: context.cwd, platform: context.platform })

  /**
   * 取这一次调用的投影。**不抛**：返回一个判决对象，让调用点自己决定怎么处理。
   *
   * 投影失败时必须**拒绝**而不是"跳过检查"：
   *   > 一个「投影失败就跳过强制」的路径，
   *   > 与一个「强制面可以被一次畸形请求关掉」的路径，是同一个东西。
   */
  function projectionFor(execution) {
    let request
    try {
      request = requestFromExecution(execution)
    } catch (err) {
      return { ok: false, code: err?.code ?? PROJECTION_CODES.BAD_REQUEST, message: err?.message ?? String(err) }
    }
    const remembered = byCallId.get(request.callId)
    if (remembered !== undefined) return { ok: true, projection: remembered, remembered: true }
    try {
      const projection = project(request, execution)
      byCallId.set(request.callId, projection)
      return { ok: true, projection, remembered: false }
    } catch (err) {
      return { ok: false, code: err?.code ?? PROJECTION_CODES.BAD_REQUEST, message: err?.message ?? String(err) }
    }
  }

  /**
   * guard：同步、只有降级语义。
   *
   * ★ 它在拒绝之前会查账：若同一个哈希已被 pre-execute 放行（或已拿到
   * `allowed-once`），这**依然要拒绝**（hard floor 的语义是"最终单调"），
   * 但必须留下一条能定位到具体强制点的记录。
   */
  /**
   * 路径范围检查。**同一个函数**给 pre-execute 与 guard 两处用。
   *
   * 返回 `undefined`（放行）或一个理由字符串（拒绝）。返回理由时**不抛**：
   * 与 `projectionFor` 同理，"检查本身出错"必须变成拒绝，不能把强制面炸掉。
   */
  function scopeGuard(projection) {
    if (pathScope === null) return undefined
    let verdict
    try {
      verdict = pathScope(projection)
    } catch (err) {
      return `路径范围检查本身出错（${err?.code ?? 'unknown'}）：${err?.message ?? String(err)}。按拒绝处理`
    }
    if (verdict === null || typeof verdict !== 'object' || verdict.allowed !== true) {
      const code = verdict?.code ?? 'path-scope-unspecified'
      return `路径越界（${code}）：${verdict?.reason ?? '没有给出理由'}`
    }
    return undefined
  }

  function guard(execution) {
    const got = projectionFor(execution)
    if (!got.ok) {
      // 投影不了 → 无法证明这次调用不在禁止范围内 → 拒绝。理由带码，可归因。
      const reason = `hard floor：无法投影这次调用（${got.code}），无法证明它不在禁止范围内：${got.message}`
      record(null, { source: 'guard', decision: 'deny', reason, code: got.code, at: now() })
      return reason
    }
    const projection = got.projection
    // ★ spec §6.6 line 449：越界路径既要在 pre-execute 提前拒绝，**也要**在 guard
    // 最终复核（"Guard 只做同步、确定性拒绝；后续流程不可撤销"）。
    //
    //   > 一个「只在 pre-execute 查路径范围」的组合，
    //   > 与一个「guard 那一层已经换成了另一份范围表」的组合，是同一个东西——
    //   > 而 guard 正是"不可撤销"的那一道。
    const scopeReason = scopeGuard(got.projection)
    if (scopeReason !== undefined) {
      record(projection.canonicalHash, { source: 'guard', decision: 'deny', reason: scopeReason, at: now() })
      return scopeReason
    }
    const reason = guarded(guardInputOf(projection))
    const hash = projection.canonicalHash
    if (reason === undefined) {
      record(hash, { source: 'guard', decision: 'allow', reason: null, at: now() })
      return undefined
    }

    const prior = (ledger.get(hash) ?? []).filter((e) => e.decision === 'allow' || e.decision === 'allowed-once')
    record(hash, { source: 'guard', decision: 'deny', reason, at: now() })
    if (prior.length > 0) {
      const finding = Object.freeze({
        code: PROJECTION_CODES.GUARD_CONTRARY,
        canonicalHash: hash,
        toolName: projection.toolName,
        guardReason: reason,
        allowedBy: Object.freeze(prior.map((e) => Object.freeze({ source: e.source, at: e.at }))),
      })
      contradictions.push(finding)
      onContradiction?.(finding)
    }
    return reason
  }

  const preExecute = decide === null ? null : createPreExecutePolicy({
    connectTimeoutMs,
    responseTimeoutMs,
    now,
    decide: async (execution) => {
      const got = projectionFor(execution)
      if (!got.ok) {
        // 投影不了 = 拿不到这次调用的身份 = 拒绝（不是"放行但记不下来"）。
        return { kind: 'deny', reason: `无法投影这次调用（${got.code}）：${got.message}` }
      }
      // ★★ 静态 hard floor 在**这里**先判——PRT-214 缺口，实测补上。
      //
      // spec §6.8（`:456`）把「hard floor」映射到**两道闸**：
      // 「`tools/pre-execute` 提前拒绝」+「`ctx.tools.guard()` 最终复核」。
      // 在这之前，生产里**只有第二道**：guard 那一行（`plugins/hard-floor.mjs`）
      // 挂了，而 pre-execute 这一段从不跑下限判定。`composePreExecuteFloor()`
      // ——写出这道闸的那个函数——在全仓库**只有用例在调**。
      //
      // 它的文件头自己预言了后果，而那个预言是**可实测**的（本次就是这么测到的）：
      //
      //     一次 `delete-file`（下限里的名字）→ pre-execute 返回 `allow`
      //     → 策略门被调用 **1** 次（也就是**走进了审批箱**）
      //     → guard 返回「hard floor：工具 delete-file 被静态禁止（不可由审批解除）」
      //
      //   > 一个「hard floor 只在 guard 一处生效」的接线，
      //   > 与一个「人批了之后仍然被 guard 拒绝、而审计里找不到该修哪里」的接线，
      //   > 是同一个东西。
      //
      // 而这里的修法**不是**再写一份比较：`guarded` 就是 guard 那一行用的
      // **同一个** `createHardFloorGuard` 调用结果，`guardInputOf(projection)`
      // 也是同一份投影。两道闸问的是同一件事、拿到的是同一份下限，
      // 所以不存在"pre-execute 与 guard 之间漂移"的可能。
      //
      // ★ 顺序：在 `scopeGuard` / 白名单**之前**。理由不是随便排的——
      //   下限是"不可由审批解除"的那一类（删文件回不来、写密钥会让已录入的
      //   凭证无法恢复），而路径范围与岗位清单都可能有修复动作。
      //   两条同时命中时，先说那条**没有修复动作**的，值班的人才知道
      //   改哪里是白费力气。
      const floorReason = guarded(guardInputOf(got.projection))
      if (floorReason !== undefined) {
        return { kind: 'deny', reason: floorReason }
      }
      // ★ 路径范围在**白名单之前**：越界是 hard floor 的一部分（spec §6.6 line 449），
      // 而岗位清单是"这个岗位能干哪些事"，两者拒绝的理由不同、修复动作也不同。
      const outOfScope = scopeGuard(got.projection)
      if (outOfScope !== undefined) return { kind: 'deny', reason: outOfScope }

      // ★ 岗位白名单在**策略端口之前**跑，拒绝即定案（PRT-603）。
      //
      //   > 一个「先问策略、策略说 allow 就放行」的桥，
      //   > 与一个「岗位清单只在策略也说不的时候才生效」的桥，是同一个东西。
      //
      // 拒绝理由里带上 `rule`：岗位清单与策略规则是**两处不同的配置**，
      // 值班的人要能分清该改哪一个。
      if (whitelist !== null) {
        const verdict = whitelist(got.projection)
        if (verdict === null || typeof verdict !== 'object' || verdict.allowed !== true) {
          const rule = verdict?.rule ?? 'whitelist-unspecified'
          return {
            kind: 'deny',
            reason: `岗位白名单拒绝（${rule}）：${verdict?.reason ?? '没有给出理由'}`,
          }
        }
      }
      const decision = await decide(got.projection)
      // pre-execute **不允许改写工具参数**（PRT-613 / spec §6.5 line 468）。
      //
      // 检查必须在**这里**（返回之前），不能在 `onDecision` 里：`onDecision` 是事后的
      // 通知，那时决定已经作出去了，抛错只能把整条流水线炸掉、而不能把它变成一次拒绝。
      //
      //   > 一个「在事后通知里检查改写」的桥，
      //   > 与一个「改写已经被放行、只是顺手记了一条日志」的桥，是同一个东西。
      try {
        resolvePreExecuteResult({ frozen: got.projection.frozenBody, proposed: decision?.arguments ?? null })
      } catch (err) {
        return {
          kind: 'deny',
          reason: `策略门试图改写工具参数，已拒绝当前调用（spec §6.5 line 468 只允许拒绝、不允许改写）：${err?.message ?? String(err)}`,
        }
      }
      return decision
    },
    onDecision: (e) => {
      const got = projectionFor(e.execution)
      const hash = got.ok ? got.projection.canonicalHash : null
      record(hash, {
        source: 'pre-execute',
        decision: e.decision?.kind ?? 'unknown',
        reason: e.decision?.reason ?? e.reason ?? null,
        at: now(),
      })
      onDecision?.({ ...e, canonicalHash: hash, projection: got.ok ? got.projection : null })
    },
  })

  const innerAnswerer = requestApproval === null ? null : createApprovalAnswerer({
    connectTimeoutMs: approvalConnectTimeoutMs,
    responseTimeoutMs: approvalResponseTimeoutMs,
    now,
    // ⚠️ 这个端口收到的**只有** `{toolName, callId, reason, signal}` —— 没有 arguments。
    //
    // 第一版在这里调 `projectionFor(req)`，于是每次都因为"arguments 为空、目标推导不出来"
    // 而返回 `unavailable`，**每一次审批都问不到人**。用例 ④ 抓到了它。
    //
    //   > 一个「在下游端口上重新投影」的桥，
    //   > 与一个「上游已经算过、下游却因为拿不到输入而永远说不」的桥，是同一个东西。
    //
    // 正确做法：投影在**收到完整请求的那一层**做（下面的 wrapper），这里只按 callId 取。
    //
    // PRT-212 补记：`onConnected` / `signal` / `responseTimeoutMs` 也必须**透传**下去。
    //
    // 第一版只把 `projection` 交给 `requestApproval`，于是上面 `createApprovalAnswerer`
    // 那个 `onConnected` **一次都不会被调用**。后果不是"报错"，而是报**错的东西**：
    // `runWithPhaseDeadlines` 在连接窗口到期而端口没自报时，会退化成
    // `PHASE_UNREPORTED`（"阶段未自报"）而不是 `RESPONSE_TIMEOUT`。
    //
    //   > 一个"从不自报已连接"的审批桥，
    //   > 与一个"每次都连不上审批箱"的审批桥，在可用性报告上是同一个东西——
    //   > 只不过前者其实已经把申请放进审批箱了，而且很可能只是没人批。
    //
    // 而"连不上"与"等不到人"的排查方向完全相反：前者去看 hub 起没起，
    // 后者去看审批箱里积压了谁的申请。中间少传一个回调，这两件事就再也分不开了。
    request: async (short) => {
      const projection = byCallId.get(short?.callId)
      if (projection === undefined) {
        // 没有投影就不问：问不到 = 故障，不是"人说不"。
        return 'unavailable'
      }
      const outcome = await requestApproval(projection, {
        onConnected: short?.onConnected ?? null,
        signal: short?.signal ?? null,
        responseTimeoutMs: short?.responseTimeoutMs ?? null,
      })
      if (outcome === 'allowed-once') {
        record(projection.canonicalHash, { source: 'approval', decision: 'allowed-once', reason: 'granted', at: now() })
      }
      return outcome
    },
    onOutcome: ({ req, outcome, reason }) => {
      const got = projectionFor(req)
      if (got.ok && outcome !== 'allowed-once') {
        record(got.projection.canonicalHash, { source: 'approval', decision: outcome, reason, at: now() })
      }
    },
  })

  /**
   * bridge 对外的 answerer：先按 DSH 给的**完整**请求投影，再交给 answerer 本身。
   *
   * 投影不了就 `unavailable`——不是 `rejected`。把"问不到"伪装成"人说不"
   * 会让审计里出现一次从未发生过的拒绝。
   */
  async function answerer(req) {
    if (innerAnswerer === null) return 'unavailable'
    const got = projectionFor(req)
    if (!got.ok) return 'unavailable'
    return innerAnswerer(req)
  }

  /**
   * §6.8 line 479 的检查：**同一个哈希**上不得同时出现
   * 「pre-execute 放行 / approval allowed-once」与「guard 拒绝」。
   */
  function assertNoContradiction() {
    const found = []
    for (const [hash, entries] of ledger) {
      const allowed = entries.filter((e) => e.decision === 'allow' || e.decision === 'allowed-once')
      const denied = entries.find((e) => e.source === 'guard' && e.decision === 'deny')
      if (allowed.length > 0 && denied !== undefined) {
        found.push(Object.freeze({
          code: PROJECTION_CODES.GUARD_CONTRARY,
          canonicalHash: hash,
          guardReason: denied.reason,
          allowedBy: Object.freeze(allowed.map((e) => Object.freeze({ source: e.source, at: e.at }))),
        }))
      }
    }
    return Object.freeze(found)
  }

  return Object.freeze({
    version: TOOL_REQUEST_VERSION,
    context: Object.freeze({ ...context }),
    project,
    projectionFor,
    guard,
    preExecute,
    answerer,
    /** 账：哈希 → 强制点决定序列。审计读它，不读各自的局部变量。 */
    ledgerOf: (hash) => Object.freeze([...(ledger.get(hash) ?? [])]),
    ledgerHashes: () => Object.freeze([...ledger.keys()].filter((k) => k !== null)),
    contradictions: () => Object.freeze([...contradictions]),
    assertNoContradiction,
    /**
     * ★★ F-21 反馈面：组合方把这个监听器挂到 DSH 的 `tools/result` 上。
     *
     * `null` ⇒ 没装。**读得出 `null` 本身就是信息**——本批之前，
     * "反馈面没装"在整个桥的读数里**一格都没有**。
     */
    connectorFeedback,
    /**
     * 强制面到底挂了几道。**证据是"装上了什么"，不是"配置里写了什么"**——
     * PRT-604 的 pathScope 与 PRT-603 的 whitelist 都是可选端口，一个没接上的
     * 端口在运行时与"从不拒绝"无法区分。
     */
    enforcementSurfaces: () => Object.freeze({
      hardFloor: true,
      pathScope: pathScope !== null,
      whitelist: whitelist !== null,
      policy: decide !== null,
      approval: requestApproval !== null,
      /**
       * ★★ F-21 的**第二半**（2026-09-18 加）。原来这一格**不存在**。
       *
       * 为什么它必须在这里，而不是"组合方自己知道就行"：
       *
       *   > 一个"接了连接器判定、但反馈面没装"的强制面，
       *   > 与一个"连接器从来不会因为失败而被拦下"的强制面，是同一个东西——
       *   > 只不过前者的 `enforcementSurfaces()` 看起来是接好的。
       *
       * ⚠️ 这一格只回答"**监听器在不在**"，**不**回答
       * "它认不认得出连接器"（那个要让 `createOutcomeListener` 的
       * `receipts()` 去答）。一个装上了、但每次都记不上账的监听器
       * 在这一格里是 `true`——那是**有意的**：这一格报的是**装配**，
       * 不是**效果**，两者分开才查得动。
       */
      connectorFeedback: connectorFeedback !== null,
    }),
  })
}

// ---------------------------------------------------------------- 装载时自检

/**
 * `CONTEXT_SCOPED_CAPABILITIES` 里不得有任何"有外部效果 / 不可逆 / hard floor"的能力。
 */
export function assertTargetlessSafe({
  scoped = CONTEXT_SCOPED_CAPABILITIES,
  kinds = CAPABILITY_KINDS,
} = {}) {
  const unsafe = []
  const unknown = []
  for (const c of scoped) {
    const k = kinds[c]
    if (k === undefined) { unknown.push(c); continue }
    if (k.externalEffect || k.irreversible || k.hardFloor) unsafe.push(c)
  }
  if (unknown.length > 0 || unsafe.length > 0) {
    throw fail(
      PROJECTION_CODES.TARGET_MISSING,
      `"无目标"能力名单里出现了不该出现的项：未知 ${JSON.stringify(unknown)}，`
      + `有外部效果/不可逆/hard floor ${JSON.stringify(unsafe)}。`
      + '一个"有外部效果的能力被放进无目标名单"的表，与一个"不带参数的网络调用被当成读本地文件"的表，是同一个东西',
    )
  }
  return Object.freeze({ scoped: Object.freeze([...scoped]), unsafe: Object.freeze(unsafe), unknown: Object.freeze(unknown) })
}

/** `TARGET_ARGUMENTS` 必须覆盖每一个能力（两个方向都查）。 */
export function assertTargetArgumentsCoverAll({
  targetArguments = TARGET_ARGUMENTS,
  capabilityIds = CAPABILITY_IDS,
} = {}) {
  const declared = Object.keys(targetArguments)
  const missing = capabilityIds.filter((c) => !declared.includes(c))
  const orphan = declared.filter((c) => !capabilityIds.includes(c))
  if (missing.length > 0 || orphan.length > 0) {
    throw fail(
      PROJECTION_CODES.TARGET_MISSING,
      `目标参数表与能力种类不一致：缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(orphan)}。`
      + '缺的那一项意味着这个能力的调用目标推导不出来——而兜底兜出来的目标会让一次批准覆盖任意目标',
    )
  }
  return Object.freeze({ covered: Object.freeze([...capabilityIds]), missing: Object.freeze(missing), orphan: Object.freeze(orphan) })
}

/** `SUBJECT_KEYS` 必须**就是**强制面那一份，不是抄的一份。 */
export function assertSubjectKeysShared({ subjectKeys = SUBJECT_KEYS, canonicalKeys = CANONICAL_OP_KEYS } = {}) {
  const same = subjectKeys.length === canonicalKeys.length && subjectKeys.every((k, i) => k === canonicalKeys[i])
  if (!same) {
    throw fail(
      PROJECTION_CODES.PROJECTION_DRIFT,
      `授权主体键集合与强制面那一份不一致：${JSON.stringify(subjectKeys)} vs ${JSON.stringify(canonicalKeys)}。`
      + '抄一份的结果是两份迟早不一样，而漂移的那一次表现为"审批绑定的目标不是 guard 检查的目标"',
    )
  }
  return Object.freeze({ keys: Object.freeze([...subjectKeys]), shared: true })
}

/** 未登记工具的目标必须在**不猜**的前提下要么唯一、要么拒绝。 */
export function assertUnknownToolsFailClosed({ toolNames = ['totally-unknown-tool'], context: ctx = SAMPLE_CONTEXT } = {}) {
  const results = []
  for (const toolName of toolNames) {
    const probe = (args) => {
      try {
        return { ok: true, hash: projectToolRequest({ request: { toolName, callId: 'probe', arguments: args }, context: ctx }).canonicalHash }
      } catch (err) {
        return { ok: false, code: err?.code ?? null }
      }
    }
    results.push(Object.freeze({
      toolName,
      noTarget: probe({ mode: 'w' }),
      oneTarget: probe({ path: 'C:/work/a.txt' }),
      twoTargets: probe({ path: 'C:/work/a.txt', url: 'https://example.com' }),
    }))
  }
  return Object.freeze(results.map((r) => Object.freeze(r)))
}

/**
 * patch 层三行强制面各自注册的端口 → 桥里对应的那个方法。
 *
 * 那三行是**声明**，桥是**实现**。两者之间今天只有散文在维持：
 *
 *   > 一个「在文档里写着'三个强制点共用一个桥'」的组合，
 *   > 与一个「三行里有一行注册了桥根本没提供的方法」的组合，是同一个东西——
 *   > 只不过后者的表现是"那一行挂上了，但什么都没发生"。
 */
export const ENFORCEMENT_PORT_MAP = Object.freeze({
  'ctx.tools.guard': 'guard',
  "ctx.on('tools/pre-execute')": 'preExecute',
  "ctx.on('approval/request')": 'answerer',
})

/** 强制面那几行注册的端口，桥必须都提供。 */
export function assertBridgeProvidesPorts({ rows, bridge } = {}) {
  const all = (rows ?? []).flatMap((r) => (r.registrations ?? []).map((reg) => ({ row: r.id, registration: reg })))
  const enforcement = all.filter((x) => x.registration.startsWith('ctx.tools.guard')
    || x.registration.startsWith("ctx.on('tools/")
    || x.registration.startsWith("ctx.on('approval/"))
  if (enforcement.length === 0) {
    throw fail(PROJECTION_CODES.BAD_REQUEST, 'patch 层里找不到任何强制面端口行——那说明这一层的检查已经落空')
  }
  const wanted = enforcement.map((x) => Object.freeze({ ...x, method: ENFORCEMENT_PORT_MAP[x.registration] ?? null }))
  const missing = wanted.filter((w) => w.method === null || typeof bridge?.[w.method] !== 'function')
  if (missing.length > 0) {
    throw fail(
      PROJECTION_CODES.BAD_REQUEST,
      `patch 层的强制面行注册了桥不提供的端口：${JSON.stringify(missing.map((m) => `${m.row}:${m.registration}`))}。`
      + '那一行会挂上但不产生任何强制',
    )
  }
  return Object.freeze({
    ports: Object.freeze(wanted),
    unmapped: Object.freeze(wanted.filter((w) => w.method === null).map((w) => w.registration)),
  })
}

const SAMPLE_CONTEXT = Object.freeze({
  scope: 'legion',
  actor: 'employee-1',
  action: 'file.write',
  taskId: 'task-1',
  cwd: 'C:/work',
  platform: 'win32',
})

const SAMPLE_PROJECTION = projectToolRequest({
  request: { toolName: 'write-file', callId: 'call-1', arguments: { path: 'C:\\work\\a.txt', mode: 'w' } },
  context: SAMPLE_CONTEXT,
})

function observationInvariant() {
  const base = { toolName: 'fetch-url', callId: 'call-9', arguments: { url: 'https://example.com/x' } }
  // 这三样都是 spec line 470 点名的**观察 metadata**：attemptId、UI 文案、时间戳。
  // 它们出现在**请求**上（而不是参数里）时不得影响授权哈希。
  const plain = projectToolRequest({ request: { ...base }, context: SAMPLE_CONTEXT })
  const noisy = projectToolRequest({
    request: {
      ...base,
      attemptId: 'attempt-777',
      attempt_id: 'attempt-777',
      atText: '2026-12-31T23:59:59.999Z',
      ts: 1767225599999,
      timestamp: '2026-12-31T23:59:59.999Z',
      retryCount: 42,
      elapsedMs: 8123,
      uiText: '完全不同的 UI 文案，而且更长',
    },
    context: SAMPLE_CONTEXT,
  })
  return Object.freeze([plain.canonicalHash, noisy.canonicalHash])
}

/**
 * 同一个文件在 win32 下的两种写法。
 *
 * ★ 这里有两个**不同**的读数，必须分开记，因为它们证明的是不同的事：
 *
 *   · `canonicalTarget` **相同** —— 路径规范化（绝对化、分隔符、大小写）生效了
 *   · 授权哈希**不同** —— 因为 `arguments` 里那两个字符串本身不同
 *
 * 哈希不同是**有意的**，方向是**多问一次**（拒绝），不是少问一次：
 *
 *   > 一个「为了让两种写法得到同一个审批而把 arguments 也规范化一遍」的投影，
 *   > 与一个「执行时看到的参数不是被哈希的那一份」的投影，是同一个东西——
 *   > 而 spec §6.5 line 468 恰恰禁止改写参数。
 *
 * 把 arguments 规范化就意味着执行前要改写它；那正是这一批要禁掉的动作。
 * 代价是同一个文件的另一种写法会再问一次审批——宁可多问，不可少问。
 */
function caseInsensitivePaths() {
  const mk = (path) => projectToolRequest({
    request: { toolName: 'write-file', callId: 'call-1', arguments: { path, mode: 'w' } },
    context: SAMPLE_CONTEXT,
  })
  const a = mk('C:\\work\\a.txt')
  const b = mk('c:/WORK/A.TXT')
  return Object.freeze({
    targets: Object.freeze([a.canonicalTarget, b.canonicalTarget]),
    hashes: Object.freeze([a.canonicalHash, b.canonicalHash]),
  })
}

/**
 * 桥真的提供了 patch 层那几行注册的每一个端口。
 *
 * 用一个**真实装配起来的桥**去比，而不是比一份声明。
 */
function bridgePorts() {
  const bridge = createEnforcementBridge({
    context: SAMPLE_CONTEXT,
    floor: DEFAULT_HARD_FLOOR,
    decide: () => ({ kind: 'allow' }),
    requestApproval: async () => 'rejected',
  })
  return assertBridgeProvidesPorts({ rows: PATCH_LAYER_ROWS, bridge })
}

/**
 * `OBSERVATION_KEYS` 必须在**投影**这一步被拒，而不是被静默滤掉。
 *
 * 拿真的带 `attemptId` 的请求去投影，证明它抛了。正确实现下这一步永远抛——
 * 所以返回值留的是**逐个键实测的结果**，不是一个"我们知道它会抛"的声明。
 */
export function assertObservationKeysRejected({ keys = OBSERVATION_KEYS } = {}) {
  const rejected = []
  const accepted = []
  for (const k of keys) {
    const req = { toolName: 'write-file', callId: 'call-1', arguments: { path: 'C:/work/a.txt', mode: 'w', [k]: 'observation' } }
    try {
      projectToolRequest({ request: req, context: SAMPLE_CONTEXT })
      accepted.push(k)
    } catch (err) {
      rejected.push(Object.freeze({ key: k, code: err?.code ?? null }))
    }
  }
  return Object.freeze({
    observationKeysRejected: Object.freeze(rejected.map((r) => r.key)),
    observationKeysRejectedWith: Object.freeze(rejected),
    observationKeysAccepted: Object.freeze(accepted),
  })
}

// 装载即执行。导出的是**算出来的产物**，不是一个布尔 ok：
// 一个布尔可以被"删掉整段自检"的那一处补丁伪造。
export const TOOL_REQUEST_CHECKED = Object.freeze({
  version: TOOL_REQUEST_VERSION,
  subjectKeys: assertSubjectKeysShared().keys,
  targetless: assertTargetlessSafe(),
  targetArguments: assertTargetArgumentsCoverAll(),
  projection: assertNoProjectionDrift(assertProjectionAgrees({ projection: SAMPLE_PROJECTION })),
  sampleTarget: SAMPLE_PROJECTION.target,
  sampleCanonicalTarget: SAMPLE_PROJECTION.canonicalTarget,
  sampleCanonicalHash: SAMPLE_PROJECTION.canonicalHash,
  sampleTargetFrom: SAMPLE_PROJECTION.targetFrom,
  // 同一文件两种写法：目标规范化后相同，哈希不同（见 caseInsensitivePaths 的注释）
  caseInsensitive: caseInsensitivePaths(),
  // 观察 metadata 不进主体的证据：请求上挂满观察字段，哈希不变
  sampleObservationInvariant: observationInvariant(),
  // 未登记工具的三种情形：无目标/唯一目标/两义目标
  unknownTools: assertUnknownToolsFailClosed(),
  // patch 层那几行注册的端口，桥都真的提供（比的是真实装配出来的桥）
  bridgePorts: bridgePorts(),
  ...assertObservationKeysRejected(),
})

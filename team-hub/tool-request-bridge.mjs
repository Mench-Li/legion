// team-hub/tool-request-bridge.mjs
// ============================================================================
// PRT-611 补记的**接线半边**：把 `runtime/dsh-composition/tool-request.mjs`
// 投影出来的工具调用，翻成一个**完整的** Legion 侧 F-02 授权主体。
//
// ## 为什么这一层必须存在
//
// PRT-611 补记把 `toolName` / `callId` / `argsHash` 加进了 `OPERATION_KEYS`，
// 于是 F-02 指纹不再让两个不同工具互相冒充。但那次改动**只是引擎半边**：
// 仓库里没有任何生产调用方会填这三个字段（`server.mjs` 的 `checkPermission`
// 直接把 HTTP body 透传进来）。引擎变严了，而送进来的东西仍然不含工具主体。
//
//   > 一个「引擎已经把工具名算进授权主体」的修复，
//   > 与一个「送进来的主体里从来没有工具名」的修复，是同一个东西——
//   > 只不过前者的用例是绿的：引擎确实绑了，只是从来没人给它绑的东西。
//
// 所以缺的是**生产者**。而"半个主体"恰恰会在这一层发生：下一个接线的人
// 很容易只搬 `toolName`（它就在投影的顶层），而漏掉 `argsHash`。
//
// ## 这个模块做三件事
//
//   ① `legionOperationOf(projection)`：从投影造出**完整**的 F-02 操作；
//   ② 复核投影自带的 `frozenHash` 与**按它自己的参数重算**的结果一致——
//      一个携带哈希、参数却被换过的投影，是最坏的一种（见 PRT-613）；
//   ③ 工具主体三缺一就**抛**（fail closed），而不是安静地留 `null`。
//
// ## 为什么分层方向是 team-hub → runtime
//
// `permission-engine.mjs` 与 `tool-args.mjs` 都是本模块的依赖，而
// `team-hub/` → `runtime/dsh-composition/` 是本仓库既有的分层方向
// （`tool-call-log.mjs`、`permission-engine.mjs` 都已这样 import），
// 反向实测 0 处。所以桥只能建在 `team-hub/` 这一侧——`tool-request.mjs`
// **不能**反向 import `OPERATION_KEYS`，那会把一条已经一致的方向反转过来。
// ============================================================================

import { TOOL_SUBJECT_KEYS, argsHashOf } from './permission-engine.mjs'

/** 桥自身的版本。改动搬运规则时递增。 */
export const TOOL_REQUEST_BRIDGE_VERSION = 1

export const BRIDGE_CODES = Object.freeze({
  /** 投影不是对象（或为空）。 */
  PROJECTION_MISSING: 'tool-request-bridge-projection-missing',
  /** 投影里没有工具名——工具调用必须有。 */
  TOOL_NAME_MISSING: 'tool-request-bridge-tool-name-missing',
  /** 投影里没有 callId。 */
  CALL_ID_MISSING: 'tool-request-bridge-call-id-missing',
  /**
   * 投影自带的 `frozenHash` 与按它自己的 `arguments` 重算的结果**不一致**。
   * 这是最坏的一种：所有哈希比对都通过，而执行的是另一份参数。
   */
  FROZEN_HASH_DRIFT: 'tool-request-bridge-frozen-hash-drift',
  /** 造出来的主体不是完整工具主体。 */
  SUBJECT_INCOMPLETE: 'tool-request-bridge-subject-incomplete',
  /** 投影里没有能当 `target` / `action` 用的字段。 */
  SUBJECT_INPUT_MISSING: 'tool-request-bridge-subject-input-missing',
})

/** 无论哪个码，都需要带上这些字段才能定位。 */
function fail(code, message, extra = {}) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  Object.assign(err, extra)
  throw err
}

/**
 * 一个投影**是不是**工具调用。
 *
 * 判据是"有没有工具名"，而不是"有没有 `capabilities`"：后者在未登记工具上是空数组，
 * 而一个未登记的工具调用恰恰是最需要绑定的那一种。
 */
export function isToolProjection(projection) {
  return Boolean(projection) && typeof projection === 'object' &&
    typeof projection.toolName === 'string' && projection.toolName.trim() !== ''
}

/**
 * 把投影翻成 F-02 授权主体。
 *
 * @param {object} projection `runtime/dsh-composition/tool-request.mjs` 的投影
 * @param {{scope: string, actor: string, action?: string}} caller
 *   Legion 侧补充的身份：`scope`/`actor` 由团队与会话决定，投影里没有；
 *   `action` 缺省时用投影的 `toolName`（工具调用即动作）。
 * @returns {{operation: object, evidence: object}}
 */
export function legionOperationOf(projection, caller = {}) {
  if (!projection || typeof projection !== 'object') {
    fail(BRIDGE_CODES.PROJECTION_MISSING, 'legionOperationOf 需要一个投影对象')
  }
  if (!isToolProjection(projection)) {
    fail(BRIDGE_CODES.TOOL_NAME_MISSING, '投影里没有非空 toolName——工具调用必须有工具名')
  }
  const toolName = String(projection.toolName).trim()
  const callId = projection.callId == null ? null : String(projection.callId).trim() || null
  if (callId === null) {
    // 没有 callId 就没有"哪一次调用"的身份。DSH 的 `allowed-once` 是按 callId 的一次性
    // 授权（spec §6.8），缺了它就只能退化成"这个工具以后都能用"——那是一次**放行**方向的
    // 退化，所以这里抛，不降级。
    fail(BRIDGE_CODES.CALL_ID_MISSING, '投影里没有 callId——缺了它无法表达"只放行这一次"')
  }

  const args = projection.arguments ?? {}
  const argsHash = argsHashOf({ toolName, args })

  // ② 携带的哈希 vs 按携带的参数重算。两者不一致说明这个投影自相矛盾。
  //
  //    > 一个「携带的哈希与它携带的参数对不上、却照样被绑定」的授权主体，
  //    > 与一个「绑定的是一份没人执行过的参数」的授权主体，是同一个东西——
  //    > 只不过前者在每一个单独的哈希比对里都是通过的。
  const frozenHash = projection.frozenHash ?? projection.frozenBody?.canonicalHash ?? null
  if (frozenHash !== null && frozenHash !== argsHash) {
    fail(
      BRIDGE_CODES.FROZEN_HASH_DRIFT,
      `投影自带的 frozenHash(${frozenHash}) 与按它自己的 arguments 重算的 argsHash(${argsHash}) 不一致`,
      { frozenHash, recomputed: argsHash },
    )
  }

  const action = String(caller.action ?? toolName).trim()
  const target = String(
    caller.target ?? projection.canonicalTarget ?? projection.target ?? toolName,
  ).trim()
  if (action === '' || target === '') {
    fail(BRIDGE_CODES.SUBJECT_INPUT_MISSING, `action(${action}) 或 target(${target}) 为空`)
  }

  const operation = {
    scope: String(caller.scope ?? '').trim(),
    actor: String(caller.actor ?? '').trim(),
    action,
    target,
    taskId: caller.taskId == null ? null : String(caller.taskId).trim() || null,
    unattended: caller.unattended === true,
    metadata: caller.metadata && typeof caller.metadata === 'object' ? { ...caller.metadata } : {},
    toolName,
    callId,
    argsHash,
  }

  // ③ 三缺一就抛。这条检查**在真实输入上会触发**（下面的 `assertBridgeComplete`
  // 用一张缺字段的投影把它打出来），而不是一句"理论上应该齐"的注释。
  assertToolSubjectComplete(operation)

  return Object.freeze({
    operation: Object.freeze(operation),
    evidence: Object.freeze({
      version: TOOL_REQUEST_BRIDGE_VERSION,
      toolName,
      callId,
      argsHash,
      frozenHash,
      // 逐字段报"这个键是从哪来的"，而不是一个 ok 布尔——
      // 出问题时值班的人要能一眼看出是**哪一层**没给字段。
      keysFrom: Object.freeze(Object.fromEntries(TOOL_SUBJECT_KEYS.map((k) => [k, 'projection']))),
      subjectKeys: TOOL_SUBJECT_KEYS,
    }),
  })
}

/**
 * 工具主体必须三缺零。**导出**而不是内联，理由与 `assertMutationNotNoop` 那次相同：
 *
 * 桥自己造的主体**不可能**缺字段（三个都从投影算出来），所以内联时这条检查
 * 一次都不会触发——而"一个永远不会触发的复核，与没有复核，在'它到底拦不拦得住'
 * 上是同一个东西"。
 *
 * 导出之后，用例可以直接喂一个缺字段的主体把它打出来，于是这条检查从
 * "理论上存在的守卫"变成"被证明会拦的守卫"。
 *
 * 它真正的价值在**未来**：往 `TOOL_SUBJECT_KEYS` 加第四个字段而忘了在桥里填，
 * 装载期自检会当场崩，而不是让那个维度安静地不参与绑定。
 */
export function assertToolSubjectComplete(operation) {
  const missing = TOOL_SUBJECT_KEYS.filter((k) => operation?.[k] == null)
  if (missing.length > 0) {
    fail(BRIDGE_CODES.SUBJECT_INCOMPLETE, `工具授权主体缺 ${missing.join(' / ')}`, { missing })
  }
  return operation
}

/**
 * 装载期自检：对一张**真的**投影算一遍，并证明"缺字段会抛"。
 *
 * 这里留下的是算出来的值（工具名、callId、哈希）与两条**真的被触发过**的
 * 拒绝理由，而不是一个布尔。
 */
function assertBridgeComplete() {
  const projection = {
    toolName: 'file_write',
    callId: 'call-bridge-1',
    arguments: { path: 'repo/notes.txt', mode: 'w' },
    frozenHash: argsHashOf({ toolName: 'file_write', args: { path: 'repo/notes.txt', mode: 'w' } }),
    canonicalTarget: 'repo/notes.txt',
  }
  const { operation, evidence } = legionOperationOf(projection, { scope: 'team-alpha', actor: 'general' })

  const problems = []
  for (const k of TOOL_SUBJECT_KEYS) {
    if (operation[k] == null) problems.push(`${k} 没被填上`)
  }
  if (operation.toolName !== 'file_write') problems.push(`toolName 搬运错了：${operation.toolName}`)
  if (operation.callId !== 'call-bridge-1') problems.push(`callId 搬运错了：${operation.callId}`)
  if (operation.argsHash !== projection.frozenHash) problems.push('argsHash 与投影的 frozenHash 不等')

  // 两条拒绝理由必须**真的抛出来**，否则它们就是"从不执行的检查"。
  const mustThrow = [
    [BRIDGE_CODES.CALL_ID_MISSING, () => legionOperationOf({ ...projection, callId: null }, { scope: 's', actor: 'a' })],
    [BRIDGE_CODES.FROZEN_HASH_DRIFT, () => legionOperationOf({ ...projection, frozenHash: 'sha256:deadbeef' }, { scope: 's', actor: 'a' })],
    [BRIDGE_CODES.TOOL_NAME_MISSING, () => legionOperationOf({ ...projection, toolName: '  ' }, { scope: 's', actor: 'a' })],
    // `SUBJECT_INCOMPLETE` 在桥自己造的主体上**永远不会**触发（三个字段都从投影算出来），
    // 所以这里直接喂一个缺字段的主体——把"从不执行的检查"变成"被证明会拦的检查"。
    [BRIDGE_CODES.SUBJECT_INCOMPLETE, () => assertToolSubjectComplete({ ...operation, argsHash: null })],
  ]
  for (const [code, fn] of mustThrow) {
    let got = null
    try { fn() } catch (e) { got = e.code ?? null }
    if (got !== code) problems.push(`预期抛 ${code}，实际 ${got ?? '没有抛'}`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    sample: Object.freeze({
      toolName: operation.toolName,
      callId: operation.callId,
      argsHash: operation.argsHash,
      target: operation.target,
      action: operation.action,
    }),
    checkedRefusals: Object.freeze(mustThrow.map(([code]) => code)),
    evidence,
  })
}

/** 装载时算一次。`problems` 非空即模块自身的搬运规则不自洽。 */
export const TOOL_REQUEST_BRIDGE_CHECKED = assertBridgeComplete()

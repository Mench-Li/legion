// orchestrator/assignment/index.mjs
// ============================================================================
// 「软件流水线 × Agent 分配」的**纯**解析层。
//
// ## 为什么需要它
//
// 旧实现把两件事绑在了一起：目标发布时，只要存在 Agent 工作流配置（具名定义
// 或空间级 `space_runtime.review_workflow`），`createGoalChain` 就把**整条链**
// 换成工作流定义里的阶段列表。于是 T-212 的冻结链只有「需求 → 编码 → 审查」，
// 空间里明明启用了测试执行与部署，它们却没有进入这条链。
//
//   > 一个「阶段集合由编排定义决定」的实现，
//   > 与一个「阶段集合由流水线决定、编排只决定谁执行」的实现，
//   > 在编排定义恰好等于流水线的时候是同一个东西——
//   > 区别只在它们不一致的那次，而那次表现为「测试和部署凭空消失了」。
//
// 本模块只做决定，不做副作用：
//   - 阶段集合 = 编队 ∩ 流水线启用岗位（按 sort）；
//   - 分配 = 按岗位匹配的 Agent 工具 / 模型 / 节点 / testRunner，未配置即 DSH 默认；
//   - 审查闭环 = 三者都配了才生成，缺一个就拒绝（配置错误不静默降级）。
//
// 它返回一个**合成的线性工作流定义**，形状与 `workflowDefinitionForChain()`
// 的产物一致。于是 `resolveAgentReviewWorkflowSnapshot()` 与 worker 侧读取的
// `reviewWorkflow` 不需要认识一个新格式：它们看到的就是同一件事，只是这份
// 定义的阶段来自流水线而不是用户手画。
// ============================================================================

/** 分配来源（只用于诊断：为什么这一环是这个 Agent）。 */
export const ASSIGNMENT_SOURCES = Object.freeze({
  DEFINITION: 'definition',
  SPACE_REVIEW_WORKFLOW: 'space-review-workflow',
  SPACE_STAGE: 'space-stage',
  DSH_DEFAULT: 'dsh-default',
})

/** 计划错误码（发布目标时直接进 HTTP 400/409 的具名码）。 */
export const PLAN_CODES = Object.freeze({
  /** 编队有人、但流水线一个岗位都没启用：建出来的链没有认领方。 */
  PIPELINE_ROSTER_EMPTY: 'AGENT_PLAN_PIPELINE_EMPTY',
  /** 配了审查闭环，但三阶段里有一个不在流水线里（或已停用）。 */
  REVIEW_ROLE_MISSING: 'AGENT_PLAN_REVIEW_ROLE_MISSING',
  /** 配了审查闭环，但实现阶段没有独立 testRunner。 */
  IMPLEMENTATION_TEST_RUNNER_MISSING: 'AGENT_PLAN_TEST_RUNNER_MISSING',
  /** 不同阶段把链钉到了不同的执行节点（跨节点 workspace/Git 交接尚未实现）。 */
  NODE_CONFLICT: 'AGENT_NODE_WORKSPACE_MISMATCH',
})

/** 计划警告码（不拦发布，但要能在回执里看见）。 */
export const PLAN_WARNINGS = Object.freeze({
  /** 流水线的 next 与实际相邻岗位对不上（停用中间岗位时是正常现象）。 */
  PIPELINE_NEXT_MISMATCH: 'AGENT_PLAN_NEXT_MISMATCH',
  /** 分配模板里点名了流水线没有的岗位：忽略那一条。 */
  PROFILE_STAGE_UNKNOWN: 'AGENT_PLAN_PROFILE_STAGE_UNKNOWN',
  /** 同一个岗位在分配模板里出现多次：取拓扑序第一个。 */
  PROFILE_ROLE_DUPLICATED: 'AGENT_PLAN_PROFILE_ROLE_DUPLICATED',
})

const PLAN_MARKER = 'legion.goal-plan'

function planError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** 一个值是不是 `planGoal()` 的产物（`createGoalChain` 据此区分「计划」与「旧定义」）。 */
export function isGoalPlan(value) {
  return value !== null && typeof value === 'object' && value.kind === PLAN_MARKER
}

/**
 * 阶段集合：编队 ∩ 流水线启用岗位，按流水线 sort 排。
 *
 * `pipeline.stages` 已经是 `ORDER BY sort, role` 的结果，所以这里只做过滤，
 * 不再排序——重排会让「流水线里写的顺序」与「链上的顺序」出现第二份真相。
 */
export function resolvePipelineStages({ pipeline, roster } = {}) {
  const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : []
  const members = Array.isArray(roster) ? roster : []
  // 空间**根本没配流水线**（0 行）时退回全编队建链——这是既有合法态
  // （software 等历史空间、以及"先发目标后补流水线"的开通顺序）。
  // 与「配了流水线但一个都没启用」必须分开：后者建出的链没有认领方，要拦。
  if (stages.length === 0 && members.length > 0) {
    return deepFreeze({
      stages: members.map((member, index) => ({
        role: member.role,
        label: member.name ?? member.role,
        next: members[index + 1]?.role ?? null,
        gate: false,
        artifact: null,
        sort: index,
        agentToolConfig: null,
        modelConfig: null,
      })),
      warnings: [],
    })
  }
  const rosterRoles = new Set(members.map((item) => item?.role).filter((role) => typeof role === 'string' && role !== ''))
  const enabled = stages.filter((stage) => stage?.enabled !== false && rosterRoles.has(stage.role))
  if (enabled.length === 0 && members.length > 0) {
    const rosterText = members.map((item) => item.role).join('、') || '（空）'
    const stageText = stages.filter((stage) => stage?.enabled !== false).map((stage) => stage.role).join('、') || '（无）'
    throw planError(
      PLAN_CODES.PIPELINE_ROSTER_EMPTY,
      `空间 ${pipeline?.scope ?? '(未知)'} 编队与流水线没有交集（编队 ${rosterText}；流水线启用岗位 ${stageText}）` +
      '——请先为该空间配置流水线或调整编队',
    )
  }
  const warnings = []
  for (let index = 0; index < enabled.length; index += 1) {
    const stage = enabled[index]
    const next = stage.next ?? null
    if (next === null) continue
    const expected = index < enabled.length - 1 ? enabled[index + 1].role : null
    if (next !== expected) {
      // ★ 这不是错误：停用一个中间岗位会让前一个岗位的 next 指向一个不在链上的
      //   角色，而那种状态今天就是合法的（`pipelineWarnings` 只报 warn）。
      //   把它升级成 409 等于让「停用一个岗位」把整个空间的发布堵死。
      warnings.push({
        code: PLAN_WARNINGS.PIPELINE_NEXT_MISMATCH,
        message: `流水线岗位 ${stage.role} 的 next 是 ${next}，而链上的下一环是 ${expected ?? '（链尾）'}；`
          + '链顺序按 sort 执行，next 只作展示与一致性提示',
      })
    }
  }
  return deepFreeze({
    stages: enabled.map((stage) => ({
      role: stage.role,
      label: typeof stage.label === 'string' && stage.label.trim() !== '' ? stage.label : stage.role,
      next: stage.next ?? null,
      gate: stage.gate === true,
      artifact: stage.artifact ?? null,
      sort: Number.isFinite(stage.sort) ? stage.sort : 0,
      // 空间阶段自己也可以带工具/模型引用（既有数据面）。它不进「阶段集合」的判定，
      // 但在分配时是**低于**分配模板、**高于** DSH 默认的那一层。
      agentToolConfig: stage.agentToolConfig ?? null,
      modelConfig: stage.modelConfig ?? null,
    })),
    warnings,
  })
}

/**
 * 分配覆盖项：按岗位匹配的 Agent 工具 / 模型 / 节点 / testRunner。
 *
 * 优先级（后者覆盖前者）：
 *   1. DSH 默认（没有配置）
 *   2. `space_stages.agent_tool_config` / `model_config`（既有数据面）
 *   3. 分配模板（具名定义或空间级审查闭环）的 `stageTools[role]`
 *   4. 发布时显式覆盖（本版**未开放**，字段只做预留）
 *
 * ★ 「没配」与「没读到」必须分得开：未覆盖的岗位也显式记一条 `dsh-default`，
 *   而不是留 `undefined`。留空会让「这个岗位用了 DSH 默认」与「这个岗位的配置
 *   没被写进快照」在读数上长得一模一样。
 */
export function resolveAssignments({ stages, profile, profileSource = ASSIGNMENT_SOURCES.SPACE_REVIEW_WORKFLOW } = {}) {
  const list = Array.isArray(stages) ? stages : []
  const warnings = []
  const source = profileSource === ASSIGNMENT_SOURCES.DEFINITION
    ? ASSIGNMENT_SOURCES.DEFINITION
    : ASSIGNMENT_SOURCES.SPACE_REVIEW_WORKFLOW
  // 模板按 role 建表；同名角色出现多次时保留拓扑序第一个并告警。
  const byRole = new Map()
  for (const [role, tool] of Object.entries(profile?.stageTools ?? {})) {
    if (tool === null || typeof tool !== 'object') continue
    byRole.set(role, tool)
  }
  const knownRoles = new Set(list.map((stage) => stage.role))
  for (const role of byRole.keys()) {
    if (!knownRoles.has(role)) {
      warnings.push({
        code: PLAN_WARNINGS.PROFILE_STAGE_UNKNOWN,
        message: `分配模板里的岗位 ${role} 不在本空间流水线（或已停用），已忽略该条`,
      })
    }
  }
  const assignments = {}
  for (const stage of list) {
    const stageTool = byRole.get(stage.role)
    const agentRef = stageTool?.agentToolConfig ?? stage.agentToolConfig ?? null
    const modelRef = stageTool?.modelConfig ?? stage.modelConfig ?? null
    const nodeId = typeof stageTool?.nodeId === 'string' && stageTool.nodeId.trim() !== '' ? stageTool.nodeId.trim() : null
    const testRunner = stageTool?.testRunner ?? null
    const fromProfile = stageTool !== undefined
    const fromSpaceStage = !fromProfile && (stage.agentToolConfig != null || stage.modelConfig != null)
    assignments[stage.role] = {
      source: fromProfile ? source : fromSpaceStage ? ASSIGNMENT_SOURCES.SPACE_STAGE : ASSIGNMENT_SOURCES.DSH_DEFAULT,
      agentToolConfig: agentRef ?? null,
      modelConfig: modelRef ?? null,
      nodeId,
      testRunner,
    }
  }
  return deepFreeze({ assignments, warnings })
}

/**
 * 审查闭环：只有三个角色都在链上、且实现阶段有独立 testRunner 时才成立。
 *
 * 不在这里「推断」角色：`profile` 为空就说明用户没配审查闭环，链就是普通流水线。
 * 猜一组角色出来会制造一条**用户没要过**的 typed review 流程，而它在界面上
 * 看起来像「系统替我配好了」——那正是本仓反复修掉的同一类问题。
 */
export function resolveReviewPolicy({ stages, assignments, profile } = {}) {
  if (profile === null || profile === undefined) return deepFreeze({ review: null, warnings: [] })
  const list = Array.isArray(stages) ? stages : []
  const roles = new Set(list.map((stage) => stage.role))
  const wanted = {
    designRole: profile.designRole,
    implementationRole: profile.implementationRole,
    reviewRole: profile.reviewRole,
  }
  const missing = Object.entries(wanted)
    .filter(([, role]) => typeof role !== 'string' || role === '' || !roles.has(role))
    .map(([key]) => key)
  if (missing.length > 0) {
    const detail = Object.entries(wanted)
      .map(([key, role]) => `${key}=${typeof role === 'string' && role !== '' ? role : '（未配置）'}`)
      .join('、')
    throw planError(
      PLAN_CODES.REVIEW_ROLE_MISSING,
      `已配置审查闭环，但 ${missing.join('、')} 不在本空间流水线的启用岗位里（${detail}；`
      + `链上岗位：${[...roles].join('、') || '（空）'}）——请补齐岗位或关闭审查闭环`,
    )
  }
  const implementation = assignments?.[wanted.implementationRole]
  if (implementation === undefined || implementation.testRunner === null || implementation.testRunner === undefined) {
    throw planError(
      PLAN_CODES.IMPLEMENTATION_TEST_RUNNER_MISSING,
      `审查闭环的实现阶段 ${wanted.implementationRole} 没有独立 testRunner——`
      + '没有可核验的测试回执，实现阶段无法交回审查',
    )
  }
  const maxReworkRounds = Number.isSafeInteger(profile.maxReworkRounds) ? profile.maxReworkRounds : 2
  return deepFreeze({
    review: {
      designRole: wanted.designRole,
      implementationRole: wanted.implementationRole,
      reviewRole: wanted.reviewRole,
      maxReworkRounds,
    },
    warnings: [],
  })
}

/** 有效执行节点：目标级绑定 ∪ 各阶段配置，去重后至多一个。 */
export function resolveEffectiveNode({ assignments, agentNodeId } = {}) {
  const ids = new Set()
  const bound = typeof agentNodeId === 'string' && agentNodeId.trim() !== '' ? agentNodeId.trim() : null
  if (bound !== null) ids.add(bound)
  for (const assignment of Object.values(assignments ?? {})) {
    const id = assignment?.nodeId
    if (typeof id === 'string' && id.trim() !== '') ids.add(id.trim())
  }
  if (ids.size > 1) {
    throw planError(
      PLAN_CODES.NODE_CONFLICT,
      `不同阶段把链钉到了不同执行节点（${[...ids].join('、')}）；`
      + '跨节点 workspace/Git 交接尚未实现，请在「Agent 工作流」里统一成一个节点',
      409,
    )
  }
  return ids.size === 1 ? [...ids][0] : null
}

/**
 * 合成线性工作流定义（形状与 `workflowDefinitionForChain()` 一致）。
 *
 * 为什么要合成而不是让 worker 直接读流水线：跨 Agent 的独立 worktree、阶段检查点、
 * typed review 全部挂在 `tasks.agent_selection_snapshot.reviewWorkflow` 上。
 * 只给三个阶段挂它、其余阶段当普通任务，下游 `tester` 会从主分支开工，
 * 拿不到被审查的那份代码；而检查点模块要求上游每个阶段都有冻结提交。
 * 所以运行层统一成**一条流水线的实例**，配置层仍然是拆开的。
 */
export function buildPipelineWorkflow({ stages, assignments, review, pipelineVersion, profileRef = null } = {}) {
  if (review === null || review === undefined) return null
  const list = Array.isArray(stages) ? stages : []
  const stageIds = list.map((stage) => stage.role)
  const edges = []
  for (let index = 0; index < list.length - 1; index += 1) {
    edges.push({ from: list[index].role, to: list[index + 1].role })
  }
  const previousById = new Map(stageIds.map((id) => [id, []]))
  const nextById = new Map(stageIds.map((id) => [id, []]))
  for (const edge of edges) {
    previousById.get(edge.to).push(edge.from)
    nextById.get(edge.from).push(edge.to)
  }
  const definitionStages = list.map((stage) => {
    const assignment = assignments?.[stage.role] ?? {}
    return {
      id: stage.role,
      role: stage.role,
      label: stage.label,
      agentToolConfig: assignment.agentToolConfig ?? null,
      modelConfig: assignment.modelConfig ?? null,
      nodeId: assignment.nodeId ?? null,
      testRunner: assignment.testRunner ?? null,
      inputContract: null,
      outputContract: null,
    }
  })
  const stageDefinitionsById = Object.fromEntries(definitionStages.map((stage) => [stage.id, {
    id: stage.id,
    role: stage.role,
    label: stage.label,
    previousStageIds: previousById.get(stage.id),
    nextStageIds: nextById.get(stage.id),
    testRunner: stage.testRunner,
  }]))
  const stageToolsById = Object.fromEntries(definitionStages.map((stage) => [stage.id, {
    agentToolConfig: stage.agentToolConfig,
    modelConfig: stage.modelConfig,
    nodeId: stage.nodeId,
    testRunner: stage.testRunner,
  }]))
  return deepFreeze({
    // ★ `kind` 是运行期唯一的分流依据：pipeline 实例的返工只重建「目标 → 审查」这一段，
    //   custom-dag 实例才按定义拓扑重建整段下游（见 submitAgentWorkflowReview）。
    kind: 'pipeline',
    // 这不是用户发布的不可变定义，所以 `workflowDefinitionRef` 为 null：
    // 读的人要能一眼看出「阶段来自流水线」，而不是某个具名 DAG 版本。
    workflowDefinitionRef: null,
    // 但「这份分配从哪来的」仍然要能回答：具名定义 / 空间闭环配置 / 没有。
    profileRef,
    workflowDefinitionSnapshot: {
      id: `pipeline.${review.reviewRole}`,
      version: 1,
      name: '软件流水线（分配覆盖）',
      description: '阶段集合来自空间流水线；Agent 分配来自岗位覆盖项',
      stages: definitionStages,
      edges,
      entryStageIds: stageIds.slice(0, 1),
      terminalStageIds: stageIds.slice(-1),
      reviewStageId: review.reviewRole,
      reviewRoutes: { design: review.designRole, implementation: review.implementationRole },
      maxReworkRounds: review.maxReworkRounds,
    },
    designRole: review.designRole,
    implementationRole: review.implementationRole,
    reviewRole: review.reviewRole,
    designStageId: review.designRole,
    implementationStageId: review.implementationRole,
    reviewStageId: review.reviewRole,
    reviewRoutes: { design: review.designRole, implementation: review.implementationRole },
    maxReworkRounds: review.maxReworkRounds,
    stageIdByRole: Object.fromEntries(stageIds.map((id) => [id, id])),
    stageToolsById,
    stageDefinitionsById,
    topologicalStageIds: stageIds,
    pipelineVersion: pipelineVersion ?? null,
  })
}

/**
 * 一次解析出「要建哪些阶段、每个阶段谁执行、有没有审查闭环、钉在哪台机器」。
 *
 * @param {object} input
 * @param {object} input.pipeline  `readPipeline(scope)` 的视图
 * @param {Array}  input.roster    编队（`{role,name,...}`）
 * @param {object|null} input.profile 具名定义或空间级审查闭环；null = 没配
 * @param {'definition'|'space-review-workflow'} [input.profileSource]
 * @param {string|null} [input.agentNodeId] 发布弹窗选的节点
 */
export function planGoal({ pipeline, roster, profile = null, profileSource, agentNodeId = null } = {}) {
  const resolved = resolvePipelineStages({ pipeline, roster })
  const assignment = resolveAssignments({ stages: resolved.stages, profile, profileSource })
  const policy = resolveReviewPolicy({ stages: resolved.stages, assignments: assignment.assignments, profile })
  const effectiveNodeId = resolveEffectiveNode({ assignments: assignment.assignments, agentNodeId })
  const workflow = buildPipelineWorkflow({
    stages: resolved.stages,
    assignments: assignment.assignments,
    review: policy.review,
    pipelineVersion: pipeline?.version ?? null,
    profileRef: profile === null || profile === undefined
      ? null
      : {
        source: profileSource === ASSIGNMENT_SOURCES.DEFINITION ? ASSIGNMENT_SOURCES.DEFINITION : ASSIGNMENT_SOURCES.SPACE_REVIEW_WORKFLOW,
        id: typeof profile.id === 'string' ? profile.id : null,
        version: Number.isSafeInteger(profile.version) ? profile.version : null,
      },
  })
  return deepFreeze({
    kind: PLAN_MARKER,
    mode: workflow === null ? 'pipeline-plain' : 'pipeline-review',
    pipeline: {
      version: pipeline?.version ?? null,
      stages: resolved.stages,
    },
    assignments: assignment.assignments,
    review: policy.review,
    effectiveNodeId,
    workflow,
    warnings: [...resolved.warnings, ...assignment.warnings, ...policy.warnings],
  })
}

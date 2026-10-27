// workbench/src/goalPlanView.ts
// ============================================================================
// 发布目标前那张「计划预览」的**纯投影层**（T1.2 / T1.4）。
//
// ## 它解决什么
//
// 发布弹窗前只有三样东西：目标文案、一个「分配模板」下拉、执行节点。
// 用户按下"发布"之前，看不到这条链会有几个阶段、每一环由谁执行、为什么是它、
// 有没有哪一环根本没就绪。于是"发布成功、派工必失败"这件事总是在发布**之后**
// 才被发现——而那时用户已经在查"任务为什么不动"。
//
// 本模块只做一件事：把 `POST /api/goal/plan` 的返回投影成卡片，**不发明任何状态**。
//
// ## 三条判据（每一条都对应一种"看起来正常"的坏法）
//
// ① **"还没有读数" ≠ "已知不就绪"。** 后者附修法，前者只能说"还没探到"。
//    把前者画成灰/红，等于把"我们没问过"说成"它不行"。
//
// ② **每一行都要能回答"为什么是它"**（`source`）。没有这一列，用户改完
//    看不出生效没有——而"看起来生效了、其实被上层覆盖"是这类配置最常见的挫败。
//
// ③ **blockers 与 warnings 分开。** 前者让发布必然失败，后者只是要看见。
//    混在一起会让用户以为"这条提示不拦我"或"这条警告也拦我"。
// ============================================================================

/** 分配来源 → 用户能读懂的一句话（与 `orchestrator/assignment` 的 `ASSIGNMENT_SOURCES` 对齐）。 */
export const ASSIGNMENT_SOURCE_LABELS: Record<string, string> = {
  'publish-override': '本节点指定',
  'goal-agent': '继承目标级',
  definition: '分配模板',
  'space-review-workflow': '空间闭环配置',
  'space-stage': '空间阶段默认',
  'dsh-default': 'DSH 默认',
}

/** 三种就绪读数（判据①：三态必须分得开）。 */
export type StageReadiness =
  /** 有读数且就绪。 */
  | { state: 'ready'; detail: string }
  /** 有读数但**不就绪**：必须带原因与修法。 */
  | { state: 'not-ready'; detail: string }
  /** **还没有读数**——不等于不可用（自检约 10 分钟一轮，没跑到是常态）。 */
  | { state: 'unknown'; detail: string }

export interface PlanStageAssignment {
  source?: string
  agentToolConfig?: { id?: string; version?: number } | null
  modelConfig?: { id?: string; version?: number } | null
  nodeId?: string | null
  testRunner?: unknown
}

export interface PlanStage {
  role: string
  label: string
  gate?: boolean
  next?: string | null
  assignment?: PlanStageAssignment | null
}

export interface PlanBlocker {
  code: string
  message: string
  statusCode?: number
}

export interface GoalPlanResponse {
  ok?: boolean
  scope?: string
  orchestration?: string
  pipelineVersion?: string | null
  stages?: PlanStage[]
  review?: unknown
  effectiveNodeId?: string | null
  goalAgent?: unknown
  /**
   * 决策 #2：审查与实现同源时的自审标注（**不拦发布**）。
   * `null` = 不是自审，或还判断不了。
   */
  selfReview?: { same: string; note: string; roles?: Record<string, string> } | null
  warnings?: Array<{ code: string; message: string }>
  blockers?: PlanBlocker[]
  publishable?: boolean
}

export interface StageCard {
  role: string
  label: string
  gate: boolean
  /** Agent 展示名：界面今天只有「DSH / Claude Code / Codex」三分，不暴露 adapter。 */
  agent: string
  /** `id@version`；没有冻结工具时为空串（不编一个假 id）。 */
  agentRef: string
  /** 模型：仅 DSH 原生适用时给值，外部 Agent 显示「不适用」。 */
  model: string
  node: string
  /** 「为什么是它」——判据②。 */
  sourceLabel: string
  source: string
  /** 依赖说明用文字，不画连线（默认 pipeline 是线性链，画图会暗示并行）。 */
  waitingOn: string
}

export interface GoalPlanView {
  stages: StageCard[]
  blockers: PlanBlocker[]
  warnings: Array<{ code: string; message: string }>
  publishable: boolean
  /** 顶部一句话：这条链有几个阶段、什么编排。 */
  headline: string
  /** 目标级选择回显（没有就是空串）。 */
  goalAgentLabel: string
  /**
   * 自审提示（决策 #2）：`null` = 不是自审。非空时**只是提示，不拦发布**——
   * 拦了就等于否掉「整条目标一个 Agent」这个能力本身。
   */
  selfReviewNote: string | null
}

/** 把 `{id, version}` 渲染成 `id@version`，缺一个就不编另一个。 */
function refLabel(ref: { id?: string; version?: number } | null | undefined): string {
  if (ref === null || ref === undefined) return ''
  const id = typeof ref.id === 'string' && ref.id !== '' ? ref.id : ''
  if (id === '') return ''
  return typeof ref.version === 'number' ? `${id}@${ref.version}` : id
}

/**
 * Agent 展示名。
 *
 * ★ adapter（`dsh-native` / `dsh-subagent`）**不进主视图**：界面上今天没有这一档，
 *   突然加一列会让用户看到自己从未选择过的字段。它放在卡片的"技术详情"里。
 */
function agentLabel(assignment: PlanStageAssignment | null | undefined, configured: Record<string, string> | null): string {
  const ref = assignment?.agentToolConfig ?? null
  if (ref === null) return 'DSH 默认'
  const id = refLabel(ref)
  const known = configured?.[String(ref.id)]
  return known ? `${known}（${id}）` : id
}

/**
 * 把服务端计划投影成卡片。
 *
 * @param plan 接口返回；`null` = 还没拿到（渲染"读取中"，不是"没有阶段"）
 * @param configuredTools 工具配置 id → 展示名（例如 `tool.codex` → `Codex`）
 */
export function goalPlanView(plan: GoalPlanResponse | null, configuredTools: Record<string, string> | null = null): GoalPlanView | null {
  if (plan === null) return null
  const rawStages = Array.isArray(plan.stages) ? plan.stages : []
  const stages: StageCard[] = rawStages.map((stage, index) => {
    const assignment = stage.assignment ?? null
    const source = typeof assignment?.source === 'string' ? assignment.source : 'dsh-default'
    const modelRef = assignment?.modelConfig ?? null
    const agentIsNative = assignment?.agentToolConfig == null || configuredTools === null
      ? true
      : (configuredTools[String(assignment.agentToolConfig.id)] ?? '').startsWith('DSH')
    return {
      role: stage.role,
      label: typeof stage.label === 'string' && stage.label !== '' ? stage.label : stage.role,
      gate: stage.gate === true,
      agent: agentLabel(assignment, configuredTools),
      agentRef: refLabel(assignment?.agentToolConfig ?? null),
      // 外部 Agent 按各自原生模型跑，阶段级模型对它无效——显示「不适用」而不是留空。
      model: modelRef !== null ? refLabel(modelRef) : (agentIsNative ? '' : '不适用'),
      node: typeof assignment?.nodeId === 'string' && assignment.nodeId !== '' ? assignment.nodeId : '自动',
      sourceLabel: ASSIGNMENT_SOURCE_LABELS[source] ?? source,
      source,
      waitingOn: index === 0 ? '起点（无前置）' : `等待前 1 个阶段完成`,
    }
  })
  const blockers = Array.isArray(plan.blockers) ? plan.blockers : []
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : []
  const goalAgentRef = (() => {
    const goalAgent = plan.goalAgent as { agentToolConfig?: { id?: string; version?: number } } | null | undefined
    const ref = goalAgent?.agentToolConfig ?? null
    return ref === null ? '' : refLabel(ref)
  })()
  return {
    stages,
    blockers,
    warnings,
    // ★ 服务端给了就以它为准（它是同一段规划代码算出来的）；
    //   服务端没给时才按 blockers 退化判断——两处都要求"没有 blocker 才能发布"。
    publishable: typeof plan.publishable === 'boolean' ? plan.publishable : blockers.length === 0,
    headline: `${stages.length} 个阶段 · ${plan.orchestration === 'custom-dag' ? '按定义拓扑' : '按空间流水线'}` +
      (plan.pipelineVersion ? ` · 流水线 ${plan.pipelineVersion}` : ''),
    goalAgentLabel: goalAgentRef,
    // 决策 #2：服务端判定"审查与实现同源"时带一句提示；没有就是无提示。
    selfReviewNote: typeof plan.selfReview?.note === 'string' && plan.selfReview.note !== '' ? plan.selfReview.note : null,
  }
}

/**
 * 单张卡片的就绪读数。
 *
 * ★ 判据①：**没有读数**绝不能被画成"不可用"。这个项目里"还没探到"与
 *   "探过且不行"是两件事——provider 自检约 10 分钟一轮，刚装好的东西
 *   在下一轮之前本来就没有读数。
 */
export function stageReadiness(hasReadings: boolean | null, detail: string | null = null): StageReadiness {
  if (hasReadings === null) return { state: 'unknown', detail: '还没有读数（不代表不可用）' }
  if (hasReadings) return { state: 'ready', detail: detail ?? '就绪' }
  return { state: 'not-ready', detail: detail ?? '有读数但不就绪（需按提示修复）' }
}

/** 发布按钮该不该禁用 + 禁用原因（一处判据，避免按钮与文案各判一次）。 */
export function publishGate(view: GoalPlanView | null): { enabled: boolean; reason: string } {
  if (view === null) return { enabled: false, reason: '正在读取计划…' }
  if (view.blockers.length > 0) return { enabled: false, reason: view.blockers[0].message }
  if (view.stages.length === 0) return { enabled: true, reason: '该空间编队为空：发布后不会生成任务链（既有合法行为）' }
  return { enabled: true, reason: '' }
}

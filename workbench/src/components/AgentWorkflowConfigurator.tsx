import { useRef, useState } from 'react'
import { fetchAgentNodes, fetchAgentToolConfigs, fetchAgentWorkflowDefinitions, fetchAgentWorkflowHistory, fetchAgentWorkflowInstances, fetchMemberReadiness, fetchModelProfiles, fetchSpacePipeline, registerAgentNode, registerAgentToolConfig, registerAgentWorkflowDefinition, saveSpacePipeline, setGoalStatus } from '../api'
import type { AgentNodeRecord, AgentToolConfigRecord, AgentWorkflowDefinition, AgentWorkflowHistory, AgentWorkflowInstanceSummary, HubModelProfile, SpacePipelineConfig } from '../api'
import { formatCodexSystemProxyMode } from '../agentWorkflowView'
import {
  DEFAULT_NATIVE_PROVIDER,
  NATIVE_TOOL_DEFAULTS,
  defaultRoleFor,
  externalToolsChosen,
  nativeProviderCandidates,
  providerChoiceValidation,
  providerChoices,
  readinessSummary,
  scopeReadiness,
} from '../agentWorkflowDefaults'
import type { MemberReadinessLike, ProviderChoice, ProviderReadinessLike, ToolChoice, WorkflowRoleKey as RoleKey } from '../agentWorkflowDefaults'
import {
  ASSUMED_KEYS,
  ASSUMED_REASONS,
  DERIVED_KEYS,
  declaredFor,
  deriveNativeCapabilities,
} from '../nativeCapabilities'
import { bundleInstallRemedy } from '../dshRemedy'
import { toast } from './Toast'
import type { GoalStatus } from '../types'

interface Props { scope: string }
interface GraphStageDraft {
  id: string
  role: string
  label: string
  tool: ToolChoice
  toolConfigRef: { id: string; version: number } | null
  modelConfigRef: { id: string; version: number } | null
  nodeId: string
  inputArtifacts: string
  outputArtifacts: string
  testExecutable: string
  testArgs: string
  testTimeoutMs: number
}
interface GraphEdgeDraft { from: string; to: string }

const ROLE_LABEL: Record<RoleKey, string> = {
  designRole: '方案设计', implementationRole: '编码与测试', reviewRole: '代码审查',
}
const EXTERNAL_CAPABILITIES: AgentToolConfigRecord['capabilities'] = {
  textInput: true, textOutput: true, outputSchema: false, toolFilter: false,
  localAgent: false, sessionResume: false, cancellation: true,
}
/** 能力位的中文标签（界面与推导结果共用一套词，避免两处措辞漂移）。 */
const ABILITY_LABEL: Record<string, string> = {
  outputSchema: '支持结构化输出（outputSchema）',
  toolFilter: '支持工具过滤',
  cancellation: '支持取消执行',
  localAgent: '提供本地 Agent 拦截能力',
  sessionResume: '支持会话续接',
}

function observedPermissionModes(node: AgentNodeRecord): string {
  const providers = node.observedCapabilities?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return '权限模式未上报'
  const modes = Object.entries(providers as Record<string, { permissionMode?: unknown }>).map(([name, value]) =>
    `${name}: ${typeof value?.permissionMode === 'string' ? value.permissionMode : '未知'}`)
  return modes.length > 0 ? modes.join(', ') : '权限模式未上报'
}

function observedPermissionMode(node: AgentNodeRecord, providerName: string): string | null {
  const providers = node.observedCapabilities?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return null
  const provider = (providers as Record<string, { permissionMode?: unknown }>)[providerName]
  return typeof provider?.permissionMode === 'string' ? provider.permissionMode : null
}

function observedCodexSystemProxyMode(node: AgentNodeRecord): string | null {
  const providers = node.observedCapabilities?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return null
  const provider = (providers as Record<string, { systemProxyMode?: unknown }>).codex
  return typeof provider?.systemProxyMode === 'string' ? provider.systemProxyMode : null
}

// `defaultRole` 搬进了 agentWorkflowDefaults.ts（`defaultRoleFor`）——它现在有单测。

export function AgentWorkflowConfigurator({ scope }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [instancesLoading, setInstancesLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pipeline, setPipeline] = useState<SpacePipelineConfig | null>(null)
  const [configs, setConfigs] = useState<AgentToolConfigRecord[]>([])
  const [modelProfiles, setModelProfiles] = useState<HubModelProfile[]>([])
  /**
   * ★ 2026-10-13：本 scope 守护上报的 **provider 就绪度读数**。
   *
   * `null` = 还没读到（守护没上报过，或本地探测还没出结果）。
   * 这个状态与"读到了但不就绪"是**两件事**，界面必须分开说 ——
   * 把两者都说成"不可用"，会让用户去修一个其实没坏的东西。
   */
  const [readiness, setReadiness] = useState<{ member: string; providers: Record<string, ProviderReadinessLike>; profile: string | null } | null>(null)
  const [definitions, setDefinitions] = useState<AgentWorkflowDefinition[]>([])
  const [instances, setInstances] = useState<AgentWorkflowInstanceSummary[]>([])
  const [instanceTotal, setInstanceTotal] = useState(0)
  const [instanceOffset, setInstanceOffset] = useState(0)
  const [instanceStatus, setInstanceStatus] = useState('all')
  const [instanceSearch, setInstanceSearch] = useState('')
  const [selectedHistory, setSelectedHistory] = useState<AgentWorkflowHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [instanceActionId, setInstanceActionId] = useState<string | null>(null)
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<AgentNodeRecord[]>([])
  const [nodeIds, setNodeIds] = useState<Record<RoleKey, string>>({ designRole: '', implementationRole: '', reviewRole: '' })
  const [newNodeId, setNewNodeId] = useState('')
  const [newNodeLabel, setNewNodeLabel] = useState('')
  const [roles, setRoles] = useState<Record<RoleKey, string>>({ designRole: '', implementationRole: '', reviewRole: '' })
  // ★ 默认值 = **本地执行服务**（不是 Claude Code / Codex）。理由见 agentWorkflowDefaults.ts：
  //   原来的硬编码默认值预设了"这台机器装了三个外部产品"，而实测本环境一个都没有 ——
  //   于是面板一打开就是两条缺失告警 + 一个查不到的必填项，用户无从下手。
  const [tools, setTools] = useState<Record<RoleKey, ToolChoice>>({ ...NATIVE_TOOL_DEFAULTS })
  // ★ 默认填 DSH 注册的那个 provider 名（`plugins/src/index.ts` 的 config.provider 默认 'spawn'），
  //   不留空 —— 留空 + 发布时必填 = 用户必须先去读 DSH 源码才发得出去。
  const [dshProvider, setDshProvider] = useState<string>(DEFAULT_NATIVE_PROVIDER)
  const [maxReworkRounds, setMaxReworkRounds] = useState(2)
  const [definitionName, setDefinitionName] = useState('Claude Code → DeepSeek Harness → Codex')
  const [graphStages, setGraphStages] = useState<GraphStageDraft[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdgeDraft[]>([])
  const [definitionId, setDefinitionId] = useState(`workflow.${scope.replace(/[^A-Za-z0-9._:-]/g, '-')}.custom`)
  const [reviewStageId, setReviewStageId] = useState('review')
  const [reviewDesignRoute, setReviewDesignRoute] = useState('design')
  const [reviewImplementationRoute, setReviewImplementationRoute] = useState('implement')
  const [nativeToolFilter, setNativeToolFilter] = useState(true)
  const [nativeLocalAgent, setNativeLocalAgent] = useState(true)
  const [nativeSessionResume, setNativeSessionResume] = useState(false)
  const [nativeCancellation, setNativeCancellation] = useState(true)
  const instanceRequestId = useRef(0)

  const refreshInstances = async (offset = instanceOffset, status = instanceStatus, search = instanceSearch): Promise<void> => {
    const requestId = ++instanceRequestId.current
    setInstancesLoading(true)
    setError('')
    try {
      const page = await fetchAgentWorkflowInstances(scope, { limit: 20, offset, status, search })
      if (requestId !== instanceRequestId.current) return
      setInstances(page.instances)
      setInstanceTotal(page.total)
      setInstanceOffset(page.offset)
      setSelectedHistory(null)
      setCancelConfirmId(null)
    } catch (e) {
      if (requestId === instanceRequestId.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (requestId === instanceRequestId.current) setInstancesLoading(false)
    }
  }

  const load = async (): Promise<void> => {
    const instanceRequest = ++instanceRequestId.current
    setLoading(true)
    setInstancesLoading(true)
    setError('')
    try {
      // ★ 成员名册与就绪度**单独拉、单独失败**：它是诊断信息，读不到不该让整个面板打不开。
      //   （Promise.all 里任何一条挂了都会让下面全部 setState 不执行 —— 那正是"一个诊断字段
      //   拖垮主流程"的形状，与心跳那条纪律同一个道理。）
      const membersPromise: Promise<MemberReadinessLike[]> = fetchMemberReadiness()
        .then((rows) => rows as MemberReadinessLike[])
        .catch(() => [])
      const [nextPipeline, nextConfigs, nextNodes, nextDefinitions, nextModelProfiles, instancePage, members] = await Promise.all([
        fetchSpacePipeline(scope), fetchAgentToolConfigs(), fetchAgentNodes(scope), fetchAgentWorkflowDefinitions(scope), fetchModelProfiles(),
        fetchAgentWorkflowInstances(scope, { limit: 20, offset: 0, status: instanceStatus, search: instanceSearch }),
        membersPromise,
      ])
      setPipeline(nextPipeline)
      setConfigs(nextConfigs)
      setNodes(nextNodes)
      setDefinitions(nextDefinitions)
      setModelProfiles(nextModelProfiles)
      setReadiness(scopeReadiness(members, scope))
      if (instanceRequest === instanceRequestId.current) {
        setInstances(instancePage.instances)
        setInstanceTotal(instancePage.total)
        setInstanceOffset(instancePage.offset)
        setSelectedHistory(null)
        setCancelConfirmId(null)
      }
      const workflow = nextPipeline.workflow
      setRoles({
        designRole: workflow?.designRole ?? defaultRoleFor(nextPipeline.stages, 'designRole'),
        implementationRole: workflow?.implementationRole ?? defaultRoleFor(nextPipeline.stages, 'implementationRole'),
        reviewRole: workflow?.reviewRole ?? defaultRoleFor(nextPipeline.stages, 'reviewRole'),
      })
      setMaxReworkRounds(workflow?.maxReworkRounds ?? 2)
      const nextNodeIds = { designRole: '', implementationRole: '', reviewRole: '' } as Record<RoleKey, string>
      for (const key of Object.keys(ROLE_LABEL) as RoleKey[]) {
        const role = workflow?.[key] ?? defaultRoleFor(nextPipeline.stages, key)
        nextNodeIds[key] = workflow?.stageTools?.[role]?.nodeId ?? ''
      }
      setNodeIds(nextNodeIds)
      // ★★ 这里的初值决定"用户一点开看到什么"。原来是硬编码的
      //    `claude-code / dsh-native / codex` —— 即"这台机器装了三个外部产品"，
      //    而实测本环境：0 工具配置、0 执行节点、8 个流水线阶段的 agentToolConfig 全空。
      //    那份默认值**没有任何环境证据**，它只是把一个特定部署形态当成了默认。
      //    现在的规则：**先看环境** —— 流水线阶段已指定工具就用它，否则用本地执行服务。
      const nextTools = { ...NATIVE_TOOL_DEFAULTS } as Record<RoleKey, ToolChoice>
      for (const key of Object.keys(ROLE_LABEL) as RoleKey[]) {
        const role = workflow?.[key] ?? defaultRoleFor(nextPipeline.stages, key)
        const current = workflow?.stageTools?.[role]?.agentToolConfig
          ?? nextPipeline.stages.find(stage => stage.role === role)?.agentToolConfig
        const config = current ? nextConfigs.find(item => item.id === current.id && item.version === current.version) : undefined
        if (config?.adapter === 'dsh-subagent' && (config.providerName === 'codex' || config.providerName === 'claude-code')) {
          nextTools[key] = config.providerName
        } else if (config?.adapter === 'dsh-native') {
          nextTools[key] = 'dsh-native'
          setDshProvider(config.providerName)
          setNativeToolFilter(config.capabilities.toolFilter)
          setNativeLocalAgent(config.capabilities.localAgent)
          setNativeSessionResume(config.capabilities.sessionResume)
          setNativeCancellation(config.capabilities.cancellation)
        }
      }
      setTools(nextTools)
      setGraphStages([
        { id: 'design', role: workflow?.designRole ?? defaultRoleFor(nextPipeline.stages, 'designRole'), label: '方案设计', tool: nextTools.designRole, toolConfigRef: workflow?.stageTools?.[workflow.designRole]?.agentToolConfig ?? null, modelConfigRef: null, nodeId: nextNodeIds.designRole, inputArtifacts: '', outputArtifacts: 'design-bundle', testExecutable: '', testArgs: '[]', testTimeoutMs: 900000 },
        { id: 'implement', role: workflow?.implementationRole ?? defaultRoleFor(nextPipeline.stages, 'implementationRole'), label: '编码与测试', tool: nextTools.implementationRole, toolConfigRef: workflow?.stageTools?.[workflow.implementationRole]?.agentToolConfig ?? null, modelConfigRef: null, nodeId: nextNodeIds.implementationRole, inputArtifacts: 'design-bundle', outputArtifacts: 'implementation-commit, test-evidence', testExecutable: 'node', testArgs: '["--test"]', testTimeoutMs: 900000 },
        { id: 'review', role: workflow?.reviewRole ?? defaultRoleFor(nextPipeline.stages, 'reviewRole'), label: '代码审查', tool: nextTools.reviewRole, toolConfigRef: workflow?.stageTools?.[workflow.reviewRole]?.agentToolConfig ?? null, modelConfigRef: null, nodeId: nextNodeIds.reviewRole, inputArtifacts: 'design-bundle, implementation-commit, test-evidence', outputArtifacts: '', testExecutable: '', testArgs: '[]', testTimeoutMs: 900000 },
      ])
      setGraphEdges([{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }])
      setReviewStageId('review')
      setReviewDesignRoute('design')
      setReviewImplementationRoute('implement')
    } catch (e) {
      setPipeline(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (instanceRequest === instanceRequestId.current) setInstancesLoading(false)
      setLoading(false)
    }
  }

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && pipeline === null) void load()
  }

  const inspectInstance = async (instance: AgentWorkflowInstanceSummary): Promise<void> => {
    if (!instance.anchorTaskId) { setError('该工作流实例暂无可读取的阶段任务。'); return }
    setHistoryLoading(true)
    setError('')
    try { setSelectedHistory(await fetchAgentWorkflowHistory(instance.anchorTaskId, scope)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setSelectedHistory(null) }
    finally { setHistoryLoading(false) }
  }

  const changeInstanceStatus = async (instance: AgentWorkflowInstanceSummary, status: GoalStatus): Promise<void> => {
    if (status === 'canceled' && cancelConfirmId !== instance.id) {
      setCancelConfirmId(instance.id)
      return
    }
    setInstanceActionId(instance.id)
    setError('')
    try {
      const result = await setGoalStatus(scope, instance.goalId, status)
      setCancelConfirmId(null)
      const stranded = result.task?.strandedTasks ?? []
      await refreshInstances(instanceOffset)
      const label = status === 'paused' ? '目标已暂停' : status === 'active' ? '目标已恢复' : '目标已取消'
      toast('ok', stranded.length > 0
        ? `${label}；${stranded.length} 个在办任务已留痕并挂起：${stranded.join('、')}`
        : label)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      toast('err', message)
    } finally { setInstanceActionId(null) }
  }

  const createOrReuseConfig = async (choice: ToolChoice): Promise<{ id: string; version: number }> => {
    const providerName = choice === 'dsh-native' ? dshProvider.trim() : choice
    // 报错要说**下一步做什么**。原来只有一句"请填写 已注册的子 Agent provider 名称"——
    // 而用户既不知道去哪查、也不知道默认值是什么（现在默认已填 `spawn`，这句基本不会再出现）。
    if (!providerName) throw new Error(`请填写「本地执行服务 注册名」。不确定填什么就填 ${DEFAULT_NATIVE_PROVIDER}（Legion 守护自带的本地执行服务，无需额外安装）。`)
    const adapter = choice === 'dsh-native' ? 'dsh-native' : 'dsh-subagent'
    const permissionProfile = choice === 'codex' ? 'codex-workspace-write'
      : choice === 'claude-code' ? 'claude-code-acceptEdits' : `dsh-native:${providerName}`
    // ★★ 2026-10-13：能力位**从 provider 自报的读数推导**，不再整体由复选框决定。
    //    原来 `outputSchema` 是**硬编码 true**（连复选框都没有），而派工与认领都真的按它拒收 ——
    //    provider 不支持结构化输出时：UI 看不到、也改不了，**发布成功、每次派工都抛错**。
    //    现在能读到的按读数走，读不到的如实标成"声明"。推导规则见 nativeCapabilities.ts。
    const capabilities = choice === 'dsh-native'
      ? deriveNativeCapabilities(declaredFor(readiness, providerName), {
        toolFilter: nativeToolFilter, localAgent: nativeLocalAgent,
        sessionResume: nativeSessionResume, cancellation: nativeCancellation,
      }).capabilities
      : EXTERNAL_CAPABILITIES
    const compatible = configs.filter(item => item.enabled && item.providerName === providerName
      && item.adapter === adapter && item.permissionProfile === permissionProfile
      && JSON.stringify(item.capabilities) === JSON.stringify(capabilities)).sort((a, b) => b.version - a.version)[0]
    if (compatible) return { id: compatible.id, version: compatible.version }

    const idPart = providerName.replace(/[^A-Za-z0-9._:-]/g, '-')
    const id = `tool.${choice === 'dsh-native' ? `dsh-${idPart}` : choice}`
    const version = Math.max(0, ...configs.filter(item => item.id === id).map(item => item.version)) + 1
    const config: AgentToolConfigRecord = {
      id, version, providerName, adapter,
      permissionProfile,
      workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities,
      enabled: true,
    }
    await registerAgentToolConfig(config)
    setConfigs(previous => [...previous, config])
    return { id, version }
  }

  const createNode = async (): Promise<void> => {
    const id = newNodeId.trim()
    const label = newNodeLabel.trim()
    if (!id || !label) { setError('请填写节点 ID 和显示名称。'); return }
    setSaving(true)
    setError('')
    try {
      await registerAgentNode({ id, label, scope })
      setNodes(await fetchAgentNodes(scope))
      setNewNodeId('')
      setNewNodeLabel('')
      toast('ok', `节点 ${label} 已登记；请在对应 执行服务 配置相同 agentNodeId 并重启以开始心跳。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!pipeline) return
    const selected = [roles.designRole, roles.implementationRole, roles.reviewRole]
    if (selected.some(role => !role) || new Set(selected).size !== 3) {
      setError('请选择三个不同且已配置的阶段岗位。')
      return
    }
    if (selected.some(role => !pipeline.stages.some(stage => stage.role === role && stage.enabled))) {
      setError('三个岗位都必须存在于当前已启用阶段链中。')
      return
    }
    // ★ 用到了本地 Agent（或图阶段里也有）且读数明确说它不行 ⇒ 拦下。
    //   现在拦，是为了不让用户拿到一份"保存成功、每次派工都抛错"的配置。
    if (usesNativeTool() && nativeDerivation.blockers.length > 0) {
      setError(nativeDerivation.blockers.join(' '))
      return
    }
    setSaving(true)
    setError('')
    try {
      const choices: Record<RoleKey, ToolChoice> = tools
      const refs = {} as Record<RoleKey, { id: string; version: number }>
      for (const key of Object.keys(ROLE_LABEL) as RoleKey[]) refs[key] = await createOrReuseConfig(choices[key])
      const stageTools: Record<string, { agentToolConfig: { id: string; version: number }; modelConfig: null; nodeId: string | null }> = {
        [roles.designRole]: { agentToolConfig: refs.designRole, modelConfig: null, nodeId: nodeIds.designRole || null },
        [roles.implementationRole]: { agentToolConfig: refs.implementationRole, modelConfig: null, nodeId: nodeIds.implementationRole || null },
        [roles.reviewRole]: { agentToolConfig: refs.reviewRole, modelConfig: null, nodeId: nodeIds.reviewRole || null },
      }
      await saveSpacePipeline({
        scope,
        stages: pipeline.stages,
        runtime: pipeline.runtime,
        workflow: { ...roles, maxReworkRounds, stageTools },
      })
      const latest = await fetchSpacePipeline(scope)
      setPipeline(latest)
      setConfigs(await fetchAgentToolConfigs())
      toast('ok', '跨 Agent 工作流已保存：设计 → 实现/测试 → 审查')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const publishDefinition = async (): Promise<void> => {
    if (!pipeline) return
    if (graphStages.length < 2 || graphStages.some(stage => !stage.id.trim() || !stage.role
      || !pipeline.stages.some(item => item.role === stage.role && item.enabled))) {
      setError('每个工作流阶段都需要唯一 ID 和一个已启用的岗位；至少配置两个阶段。')
      return
    }
    if (new Set(graphStages.map(stage => stage.id.trim())).size !== graphStages.length) { setError('阶段 ID 不得重复。'); return }
    if (!definitionName.trim()) { setError('请填写工作流名称。'); return }
    if (!graphStages.some(stage => stage.id === reviewStageId)
      || !graphStages.some(stage => stage.id === reviewDesignRoute)
      || !graphStages.some(stage => stage.id === reviewImplementationRoute)) {
      setError('审查阶段及设计/实现返工目标必须指向现有阶段。'); return
    }
    // 同 save：读数明确说 provider 不行时，不让他发布一份"必然派工失败"的版本。
    if (usesNativeTool() && nativeDerivation.blockers.length > 0) {
      setError(nativeDerivation.blockers.join(' '))
      return
    }
    setSaving(true)
    setError('')
    try {
      const refs = new Map<string, { id: string; version: number }>()
      for (const stage of graphStages) {
        const existing = stage.toolConfigRef && configs.find(config => config.enabled
          && config.id === stage.toolConfigRef?.id && config.version === stage.toolConfigRef?.version)
        if (existing) refs.set(stage.id, { id: existing.id, version: existing.version })
        else refs.set(stage.id, await createOrReuseConfig(stage.tool))
      }
      const id = definitionId.trim()
      const version = Math.max(0, ...definitions.filter(item => item.id === id).map(item => item.version)) + 1
      const stages = graphStages.map(stage => {
        const artifacts = (value: string): string[] => value.split(',').map(item => item.trim()).filter(Boolean)
        const inputArtifacts = artifacts(stage.inputArtifacts)
        const outputArtifacts = artifacts(stage.outputArtifacts)
        let testRunner: { executable: string; args: string[]; timeoutMs: number } | null = null
        if (stage.id === reviewImplementationRoute) {
          let args: unknown
          try { args = JSON.parse(stage.testArgs) } catch { throw new Error(`阶段 ${stage.id} 的测试 argv 必须是 JSON 数组`) }
          if (typeof stage.testExecutable !== 'string' || !stage.testExecutable.trim() || !Array.isArray(args)
            || args.some(argument => typeof argument !== 'string')) {
            throw new Error(`阶段 ${stage.id} 必须配置独立测试 executable 和 argv 数组`)
          }
          testRunner = { executable: stage.testExecutable.trim(), args: args as string[], timeoutMs: stage.testTimeoutMs }
        }
        return {
          id: stage.id.trim(), role: stage.role, label: stage.label.trim() || stage.role,
          agentToolConfig: refs.get(stage.id)!, modelConfig: stage.modelConfigRef, nodeId: stage.nodeId || null,
          inputContract: inputArtifacts.length ? { artifacts: inputArtifacts } : null,
          outputContract: outputArtifacts.length ? { artifacts: outputArtifacts } : null,
          testRunner,
        }
      })
      const incoming = new Set(graphEdges.map(edge => edge.to))
      const outgoing = new Set(graphEdges.map(edge => edge.from))
      const entryStageIds = graphStages.filter(stage => !incoming.has(stage.id)).map(stage => stage.id)
      const terminalStageIds = graphStages.filter(stage => !outgoing.has(stage.id)).map(stage => stage.id)
      const definition = {
        id, version, name: definitionName.trim(), description: `由 ${scope} 空间配置生成的跨 Agent DAG 工作流。`,
        stages, edges: graphEdges,
        entryStageIds, terminalStageIds, reviewStageId,
        reviewRoutes: { design: reviewDesignRoute, implementation: reviewImplementationRoute }, maxReworkRounds,
      }
      await registerAgentWorkflowDefinition(scope, definition)
      setDefinitions(await fetchAgentWorkflowDefinitions(scope))
      setConfigs(await fetchAgentToolConfigs())
      toast('ok', `已发布可复用工作流 ${definition.name} · v${version}（${stages.length} 阶段 / ${graphEdges.length} 条依赖）；发布目标时可选择该版本。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const loadDefinitionDraft = (definition: AgentWorkflowDefinition): void => {
    setDefinitionId(definition.id)
    setDefinitionName(definition.name)
    setMaxReworkRounds(definition.maxReworkRounds)
    setReviewStageId(definition.reviewStageId)
    setReviewDesignRoute(definition.reviewRoutes.design)
    setReviewImplementationRoute(definition.reviewRoutes.implementation)
    setGraphEdges(definition.edges.map(edge => ({ ...edge })))
    setGraphStages(definition.stages.map(stage => {
      const config = configs.find(item => item.id === stage.agentToolConfig.id && item.version === stage.agentToolConfig.version)
      if (config?.adapter === 'dsh-native') {
        setDshProvider(config.providerName)
        setNativeToolFilter(config.capabilities.toolFilter)
        setNativeLocalAgent(config.capabilities.localAgent)
        setNativeSessionResume(config.capabilities.sessionResume)
        setNativeCancellation(config.capabilities.cancellation)
      }
      const tool: ToolChoice = config?.adapter === 'dsh-subagent' && config.providerName === 'codex' ? 'codex'
        : config?.adapter === 'dsh-subagent' && config.providerName === 'claude-code' ? 'claude-code' : 'dsh-native'
      return {
        id: stage.id, role: stage.role, label: stage.label, tool, toolConfigRef: stage.agentToolConfig, modelConfigRef: stage.modelConfig,
        nodeId: stage.nodeId ?? '',
        inputArtifacts: Array.isArray(stage.inputContract?.artifacts) ? (stage.inputContract.artifacts as string[]).join(', ') : '',
        outputArtifacts: Array.isArray(stage.outputContract?.artifacts) ? (stage.outputContract.artifacts as string[]).join(', ') : '',
        testExecutable: stage.testRunner?.executable ?? '',
        testArgs: JSON.stringify(stage.testRunner?.args ?? []),
        testTimeoutMs: stage.testRunner?.timeoutMs ?? 900000,
      }
    }))
  }

  const disable = async (): Promise<void> => {
    if (!pipeline) return
    setSaving(true)
    setError('')
    try {
      await saveSpacePipeline({ scope, stages: pipeline.stages, runtime: pipeline.runtime, workflow: null })
      setPipeline(await fetchSpacePipeline(scope))
      toast('ok', '跨 Agent 自动交接已关闭；阶段工具配置仍保留')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const rolesForSelect = pipeline?.stages.filter(stage => stage.enabled) ?? []
  /**
   * ★ 可选 provider 候选 = **本机读数** ∪ **节点心跳上报的** ∪ **已知默认值**。
   *
   * 三处合并而不是只取一处，是因为它们各自会**独立地迟到**：
   *   · 读数要等守护自检（TTL 10 分钟）；
   *   · 节点心跳要等 `agentNodeId` 配好（本环境 0 个节点 ⇒ 这一路是空的）；
   *   · 默认值永远在（它不需要安装）。
   * 只取任一条，都会出现"明明能用却选不到"。
   */
  const providerCandidates: ProviderChoice[] = providerChoices(readiness, nativeProviderCandidates(nodes))
  const providerNameValidation = providerChoiceValidation(dshProvider, providerCandidates)
  /**
   * ★ 当前注册名对应的能力位推导结果（2026-10-13）。
   *
   * 用途有两个，**顺序不能反**：
   *   ① 拦下"必然失败"的发布（读数明确说 provider 不支持结构化输出）；
   *   ② 把"哪几位是读数、哪几位只是声明"如实画给用户看。
   * 判据只有一条：**读数缺席不拦，读数说不行才拦**（理由见 nativeCapabilities.ts）。
   */
  const nativeDerivation = deriveNativeCapabilities(declaredFor(readiness, dshProvider.trim()), {
    toolFilter: nativeToolFilter, localAgent: nativeLocalAgent,
    sessionResume: nativeSessionResume, cancellation: nativeCancellation,
  })
  /** 这套配置里有没有用到本地 Agent（决定能力位推导的结果是否真的会被用到）。 */
  const usesNativeTool = (): boolean =>
    Object.values(tools).includes('dsh-native') || graphStages.some(stage => stage.tool === 'dsh-native')
  /** 读数里**不可用**的那些：用来给"为什么选不了/为什么没绿"一个解释。 */
  const notReadyChoices = providerCandidates.filter(c => c.state !== null && !c.ready)
  const providerRequirements = [
    ...Object.entries(tools).map(([role, tool]) => ({
      providerName: tool === 'dsh-native' ? dshProvider.trim() : tool,
      nodeId: nodeIds[role as RoleKey],
      expectedPermissionMode: tool === 'claude-code' ? 'acceptEdits' : tool === 'codex' ? 'approve-for-me' : null,
    })),
    ...graphStages.map(stage => ({
      providerName: stage.tool === 'dsh-native' ? dshProvider.trim() : stage.tool,
      nodeId: stage.nodeId,
      expectedPermissionMode: stage.tool === 'claude-code' ? 'acceptEdits' : stage.tool === 'codex' ? 'approve-for-me' : null,
    })),
  ].filter(requirement => requirement.providerName !== '')
  const providersWithoutReadyNode = providerRequirements.filter(requirement =>
    !nodes.some(node => node.status === 'ready'
      && (requirement.nodeId === '' || node.id === requirement.nodeId)
      && node.observedProviders.includes(requirement.providerName)))
  const missingProviderLabels = [...new Set(providersWithoutReadyNode.map(requirement =>
    requirement.nodeId ? `${requirement.providerName}（节点 ${requirement.nodeId}）` : requirement.providerName))]
  const readyProviderNames = [...new Set(providerRequirements
    .filter(requirement => !providersWithoutReadyNode.includes(requirement))
    .map(requirement => requirement.providerName))]
  const permissionModeMismatches = [...new Map(providerRequirements
    .filter(requirement => requirement.expectedPermissionMode !== null)
    .filter(requirement => nodes.some(node => node.status === 'ready'
      && (requirement.nodeId === '' || node.id === requirement.nodeId)
      && node.observedProviders.includes(requirement.providerName)))
    .filter(requirement => !nodes.some(node => node.status === 'ready'
      && (requirement.nodeId === '' || node.id === requirement.nodeId)
      && node.observedProviders.includes(requirement.providerName)
      && observedPermissionMode(node, requirement.providerName) === requirement.expectedPermissionMode))
    .map(requirement => [requirement.providerName, requirement.expectedPermissionMode] as const))]
  const permissionModePatch = permissionModeMismatches.map(([providerName, permissionMode]) =>
    `- id: subagent-${providerName}\n  config:\n    permissionMode: ${permissionMode}`)
    .join('\n')
  const missingAgentBundles = [...new Set(providersWithoutReadyNode
    .map(requirement => requirement.providerName)
    .filter(providerName => providerName === 'codex' || providerName === 'claude-code'))]
    .map(providerName => `@deepseek-ai/dsh-subagent-${providerName === 'codex' ? 'codex' : 'claude-code'}`)
  /**
   * ★ "装上缺的 bundle"这条修法（2026-10-13）。
   *
   * 原本这里直接拼了一句 `dsh plugin --profile <profile-name> add …` —— 看着能跑、其实跑不了
   * （占位符 + Desktop 独占 profile 命令行装不了）。现在交给纯模块判定：
   * **能粘才给命令**，否则说清该做什么。见 workbench/src/dshRemedy.ts。
   */
  const bundleRemedy = bundleInstallRemedy(readiness?.profile ?? null, missingAgentBundles)
  const rowStyle = { display: 'grid', gridTemplateColumns: '105px minmax(130px, 1fr) minmax(150px, 1.2fr) minmax(150px, 1fr)', gap: 8, alignItems: 'center', marginTop: 8 } as const
  return (
    <div className="field" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <button type="button" className="btn ghost" onClick={toggle} disabled={loading}>
        🧩 {open ? '收起' : '配置跨 Agent 闭环'}
      </button>
      {open && <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
        {loading ? <div>正在读取阶段链与工具配置…</div> : error && !pipeline ? <div style={{ color: 'var(--red)' }}>{error}</div> : pipeline && <>
            {/* ★★ 2026-10-13：先回答"我需要配吗"。原文只说"这是什么"（"独立定义跨 Agent 的
                设计 → 实现/测试 → 审查链…"），而用户的第一问题其实是**要不要动它** ——
                于是他在一个可选的高级面板前茫然，怕不填会坏事。实测：本环境 0 定义 /
                0 工具配置 / 0 节点，`pipeline.workflow` 为 null ⇒ 什么都没配，
                而流水线照常跑。把这句话写出来，是这一段存在的全部理由。 */}
            <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface-2)' }}>
              <b>先看这里：本页**可选**，不配也能正常跑。</b>
              <div style={{ marginTop: 4 }}>
                · 不配 = 空间按**已播种的流水线**（需求→方案→拆解→用例→编码→审查→测试→部署）逐环派工 ——
                这就是你现在在跑的方式，已有目标与任务都不受影响。
              </div>
              <div style={{ marginTop: 4 }}>· 只有想要下面三件事之一时才需要它：① 把某个阶段**换成别的 Agent 工具**跑（Claude Code / Codex）；
                ② 固定一条**自定义交接链**（阶段可并行或汇合，不按流水线顺序）；
                ③ 把一条链**冻结成版本**，以后发布目标时点名复用。</div>
              <div style={{ marginTop: 4 }}>· 最短路径：三行各选一个岗位（已按你的流水线预填）→ 工具保持「本地 Agent」→ 点「发布为可复用工作流版本」。</div>
              <div style={{ marginTop: 4 }}>· 想让任务**自动开跑**：设置 → <b>持续执行</b>。想让**写码阶段**动起来：任务详情 → <b>🤖 派 AI 执行</b>。这两件事都**不**在本页。</div>
            </div>
            <div style={{ color: 'var(--muted-2)', marginTop: 8 }}>
            本页只定义**交接链**，不会自动开启空间执行守护。发布目标时冻结工作流与工具版本；后续改动不改写已有目标。
            Claude Code 与 Codex 需要各自的 外部执行服务；本地执行服务 的注册名与能力必须与运行环境一致。
            </div>
            {/* ★★ 2026-10-13：本机 provider **就绪度**（只读）。
                这是"相当茫然"那个问题的正面回答：不再要求用户知道并提供 provider 名，
                而是把守护自检出来的读数摆出来 —— 装了没 / 登录了没 / 端点通不通，以及怎么修。
                它要说清三件**不同**的事（把三者挤成一句"不可用"会让人修错方向）：
                  ① 就绪           —— 现在就能选它；
                  ② 有读数但不就绪 —— 附修法；
                  ③ 还没有读数     —— **不代表不可用**，可能只是本轮自检还没跑到。 */}
            <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
              <b>本机 Agent 运行时（provider）就绪度</b>
              <div style={{ color: 'var(--muted-2)', marginTop: 4 }}>{readinessSummary(readiness)}</div>
              <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                {providerCandidates.map(choice => {
                  const mark = choice.ready ? '✅' : choice.state === null ? '·' : '⚠'
                  // ★ 2026-10-13：把**凭据模式**画出来。
                  //   "就绪（订阅登录）"与"就绪（API 模式）"是两种完全不同的配置，
                  //   而它们此前在界面上是同一行字 —— 对 API 模式的用户来说，
                  //   分不出来就意味着他可能会被"去 /login"这类建议带偏。
                  const authText = choice.authMode === null ? ''
                    : choice.authMode === 'api-settings' ? '（凭据：settings.json 的 API 模式）'
                      : choice.authMode === 'subscription' ? '（凭据：订阅态登录）'
                        : choice.authMode === 'env' ? '（凭据：环境变量）'
                          : choice.authMode === 'not-required' ? '（不需要凭据）'
                            : ''
                  const stateText = choice.state === null
                    ? '还没有读数（不代表不可用；本机自检约 10 分钟一轮）'
                    : choice.ready ? `就绪${authText}` : choice.state
                  return <div key={choice.name} style={{ color: choice.ready || choice.state === null ? 'var(--muted-2)' : 'var(--yellow)' }}>
                    {mark} <code>{choice.name}</code>
                    {choice.version === null ? '' : ` v${choice.version}`} —— {stateText}
                    {choice.endpointHost === null ? '' : ` · 端点 ${choice.endpointHost}`}
                    {choice.state !== null && !choice.ready && choice.reason !== null && <div style={{ marginLeft: 18 }}>修法：{choice.reason}</div>}
                  </div>
                })}
              </div>
              {notReadyChoices.length > 0 && <div style={{ color: 'var(--muted-2)', marginTop: 6 }}>
                判据来自守护的**本机探测**（只看存在性：CLI 在不在 PATH 上、登录态文件/变量在不在、端点通不通）。
                它**不读任何凭据内容**，也不含机器路径。
              </div>}
            </div>
            {/* 外部依赖告警的**唯一**门槛：只有用户真的选了外部工具才提示。
                原来这里是 `Object.values(tools).some(t => t !== 'dsh-native')`，
                配合硬编码的外部默认值 ⇒ 首次打开就满屏告警，而用户什么都还没选。 */}
            {externalToolsChosen([...Object.values(tools), ...graphStages.map(stage => stage.tool)]) && <div style={{ color: 'var(--yellow)', marginTop: 8 }}>
              外部 provider 心跳会报告 执行服务实例解析的原生权限模式；该值可核对配置是否匹配，但不证明文件访问边界已生效。真实验收请在可丢弃的系统账户或容器内检查读写边界、取消和清理。
            </div>}
            {permissionModeMismatches.length > 0 && <div style={{ color: 'var(--yellow)', marginTop: 8 }}>
              节点权限模式与工作流要求不匹配：{permissionModeMismatches.map(([providerName, mode]) => `${providerName}（需要 ${mode}）`).join('、')}。请在对应 执行服务配置 中应用以下配置并重启 worker，否则阶段不会派工。
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0', padding: 8, background: 'var(--surface-2)' }}>{permissionModePatch}</pre>
            </div>}
            {providerRequirements.length === 0
              ? <div style={{ color: 'var(--yellow)', marginTop: 8 }}>先填写实际的 本地执行服务 注册名，运行节点心跳后才能检查 provider 是否可用。</div>
              : missingProviderLabels.length > 0
              ? <div style={{ color: 'var(--yellow)', marginTop: 8 }}>
                尚无符合节点绑定的就绪心跳报告这些 provider：{missingProviderLabels.join('、')}。请在执行节点的 执行服务配置 安装对应的子 Agent provider bundle 并重启；认证状态仍需真实启动任务确认。
                {/* ★★ 2026-10-13：这里原来打印的是一句**看着能跑、其实跑不了**的命令：
                      `dsh plugin --profile <profile-name> add …`
                    两处问题（都在 DSH 源码里核对过）：
                      ① `<profile-name>` 是字面占位符，而 `--profile` 是 requiredOption
                         （apps/cli/src/args.ts:190）⇒ 粘了直接报错；
                      ② 就算填对，Desktop 独占的 profile 命令行**装不了**
                         （args.ts:83-87 rejectElectronProfile → 'managed exclusively by the
                         Electron application'；DSH 自己的用例 args.spec.ts:226 也钉着 exit 1）。
                    现在只在**真能粘贴**时给命令，否则说明该做什么 ——
                    判定与措辞全在 workbench/src/dshRemedy.ts。 */}
                {bundleRemedy.kind === 'pasteable'
                  ? <div style={{ marginTop: 6 }}>
                    <div>{bundleRemedy.explanation}</div>
                    <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0', padding: 8, background: 'var(--surface-2)' }}>{bundleRemedy.command}</pre>
                  </div>
                  : <div style={{ marginTop: 6 }}>
                    <div>{bundleRemedy.explanation}</div>
                    {bundleRemedy.steps.length > 0 && <div style={{ marginTop: 4, color: 'var(--muted-2)' }}>
                      {bundleRemedy.steps.map((step, index) => <div key={index}>· {step}</div>)}
                    </div>}
                  </div>}
              </div>
              : <div style={{ color: 'var(--muted-2)', marginTop: 8 }}>
                已从就绪节点心跳确认 provider 注册：{readyProviderNames.join('、')}。心跳不代表账号已认证，也不证明原生权限模式生效。
              </div>}
          {rolesForSelect.length < 3 ? <div style={{ color: 'var(--yellow)', marginTop: 8 }}>当前空间不足三个已启用阶段，请先配置三个可执行岗位。</div> : <>
            {(Object.keys(ROLE_LABEL) as RoleKey[]).map(key => <div key={key} style={rowStyle}>
              <b>{ROLE_LABEL[key]}</b>
              <select value={roles[key]} onChange={e => setRoles(prev => ({ ...prev, [key]: e.target.value }))}>
                {rolesForSelect.map(stage => <option key={stage.role} value={stage.role}>{stage.label} · {stage.role}</option>)}
              </select>
              <select value={tools[key]} onChange={e => setTools(prev => ({ ...prev, [key]: e.target.value as ToolChoice }))}>
                <option value="claude-code">Claude Code</option>
                <option value="dsh-native">本地 Agent</option>
                <option value="codex">Codex</option>
              </select>
              <select value={nodeIds[key]} onChange={e => setNodeIds(prev => ({ ...prev, [key]: e.target.value }))}>
                <option value="">自动选择在线节点</option>
                {nodes.map(node => <option key={node.id} value={node.id}>{node.label} · {node.status}</option>)}
              </select>
            </div>)}
            <div style={{ marginTop: 10, padding: 8, border: '1px solid var(--line)', borderRadius: 6 }}>
              <b>执行节点</b>
              {nodes.length === 0 ? <div style={{ color: 'var(--muted-2)' }}>尚未登记节点。留空时由任一在线 执行节点 认领。</div> : nodes.map(node => <div key={node.id} style={{ color: 'var(--muted-2)' }}>{node.label} · {node.id} · {node.status}{node.observedProviders.length ? ` · ${node.observedProviders.join(', ')}` : ''} · {observedPermissionModes(node)}</div>)}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <input value={newNodeId} onChange={e => setNewNodeId(e.target.value)} placeholder="节点 ID，如 workstation-a" />
                <input value={newNodeLabel} onChange={e => setNewNodeLabel(e.target.value)} placeholder="显示名称" />
                <button type="button" className="btn ghost" disabled={saving} onClick={() => void createNode()}>登记节点</button>
              </div>
              <div style={{ color: 'var(--muted-2)' }}>节点是运行 Legion worker 的 执行服务实例，不是 Claude/Codex 产品。Provider、能力和 生效权限模式由 daemon 心跳报告；外部阶段只有匹配冻结权限模式时才会派工。登记不会复制登录凭据。随后需在 daemon 配置中设置相同的 agentNodeId。</div>
              {nodes.some(node => node.providerNames.includes('codex')) && <div style={{ color: 'var(--muted-2)', marginTop: 6 }}>
                Codex 网络代理状态（逐节点）：{nodes.filter(node => node.providerNames.includes('codex')).map(node => `${node.label}：${formatCodexSystemProxyMode(observedCodexSystemProxyMode(node))}`).join('；')}。
              </div>}
            </div>
            {(Object.values(tools).includes('codex') || graphStages.some(stage => stage.tool === 'codex')) && <div style={{ color: 'var(--yellow)', marginTop: 10, padding: 8, border: '1px solid var(--line)', borderRadius: 6 }}>
              <b>Codex 网络代理设置（按执行节点配置）</b>
              <div>在执行节点的 Codex 子 Agent 配置中设置 `systemProxyMode`。`system` 会为 Codex 子进程启用系统代理；`inherit`（默认）沿用 Codex 原生配置和进程代理环境变量，不会强制开启系统代理。Codex CLI 仍将 `respect_system_proxy` 标为开发中；节点心跳只确认配置模式，不代表服务端已连通。启用 `system` 后，应在每个目标节点用该节点实际使用的兼容模型发起只读请求验收网络。修改后重启执行服务，并确认上方心跳模式；未上报表示 Codex 执行服务 版本较旧。</div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0', padding: 8, background: 'var(--surface-2)' }}>{'- id: subagent-codex\n  config:\n    systemProxyMode: system  # 或 inherit'}</pre>
            </div>}
            {Object.values(tools).includes('dsh-native') && <div style={{ marginTop: 10 }}>
              {/* ★ 这里原本只有一个纯文本输入框，提示语是"填写 ctx.subagents 中的 provider 名称"
                  —— 要求用户知道 DSH 的内部服务名，而**界面上没有任何地方能查到它**，
                  且发布时它是必填（留空直接抛"请填写 已注册的子 Agent provider 名称"）。
                  现在候选来自三处合并（本机读数 ∪ 节点心跳 ∪ 已知默认值），**仍然可以自由输入**
                  —— 用 datalist 而不是 select，是为了不让"读数还没到"变成"选不了"。 */}
              <label>本地执行服务 注册名
                <input list="agent-provider-candidates" value={dshProvider} onChange={e => setDshProvider(e.target.value)}
                  placeholder={`默认 ${DEFAULT_NATIVE_PROVIDER}（随 Legion 一起跑，不需要额外安装）`} />
              </label>
              <datalist id="agent-provider-candidates">
                {providerCandidates.map(choice => <option key={choice.name} value={choice.name}>
                  {choice.ready ? '就绪' : choice.state === null ? '还没有读数' : choice.state}
                </option>)}
              </datalist>
              <div style={{ color: 'var(--muted-2)' }}>
                默认 <code>{DEFAULT_NATIVE_PROVIDER}</code> 是 Legion 守护自带的本地执行服务，不需要额外安装；
                候选里的其他名字来自**本机自检读数**与节点心跳。填错时任务会派不出去，届时会在这里报出来。
              </div>
              {providerNameValidation.message !== null && <div style={{ color: providerNameValidation.ok ? 'var(--yellow)' : 'var(--red)' }}>
                {providerNameValidation.message}
              </div>}
              {/* ★★ 2026-10-13：能力位分成**读数**与**声明**两组显示。
                  原来 4 个复选框平铺，而 `outputSchema` 连复选框都没有（硬编码 true）——
                  于是"provider 不支持结构化输出"时用户既看不到也改不了，发布成功、每次派工都抛错。
                  现在：能读到的按读数走并**禁用复选框**，读不到的留着让用户声明并**说明为什么读不出来**。 */}
              <div style={{ marginTop: 8, padding: 8, background: 'var(--surface-2)', borderRadius: 5 }}>
                <b>能力声明</b>
                <div style={{ color: 'var(--muted-2)', marginTop: 4 }}>
                  {nativeDerivation.derived.length > 0
                    ? '前三项按本机读到的 provider 能力自动决定（执行时会逐位核对，对不上会拒绝派工）：'
                    : '本机没有这三个能力位的读数，下面三项**只是你的声明**（执行时会与真实 provider 逐位核对）：'}
                </div>
                {DERIVED_KEYS.map(key => <label key={key} style={{ display: 'block', color: nativeDerivation.derived.length > 0 ? 'var(--muted-2)' : undefined }}>
                  <input type="checkbox" disabled={nativeDerivation.derived.length > 0}
                    checked={nativeDerivation.capabilities[key]}
                    onChange={e => {
                      if (key === 'toolFilter') setNativeToolFilter(e.target.checked)
                      else if (key === 'cancellation') setNativeCancellation(e.target.checked)
                    }} />
                  {' '}{ABILITY_LABEL[key]}
                  {nativeDerivation.derived.length > 0 ? '（读数）' : '（声明）'}
                </label>)}
                <div style={{ color: 'var(--muted-2)', marginTop: 6 }}>
                  下列两项**本机读不出来**，需要你确认：
                </div>
                {ASSUMED_KEYS.map(key => <label key={key} style={{ display: 'block' }}>
                  <input type="checkbox"
                    checked={key === 'localAgent' ? nativeLocalAgent : nativeSessionResume}
                    onChange={e => { if (key === 'localAgent') setNativeLocalAgent(e.target.checked); else setNativeSessionResume(e.target.checked) }} />
                  {' '}{ABILITY_LABEL[key]}
                  <div style={{ marginLeft: 18, color: 'var(--muted-2)' }}>{ASSUMED_REASONS[key]}</div>
                </label>)}
              </div>
              {nativeDerivation.blockers.map((blocker, index) => <div key={index} style={{ color: 'var(--red)', marginTop: 6 }}>
                ⛔ {blocker}
              </div>)}
              {nativeDerivation.warnings.map((warning, index) => <div key={index} style={{ color: 'var(--yellow)', marginTop: 6 }}>
                {warning}
              </div>)}
            </div>}
            <div style={{ marginTop: 10 }}>
              <label>审查返工上限 <input type="number" min={0} max={20} value={maxReworkRounds} onChange={e => setMaxReworkRounds(Number(e.target.value))} style={{ width: 70 }} /> 轮</label>
              <div style={{ color: 'var(--muted-2)' }}>设计问题退回 Claude Code；实现问题退回编码岗位；混合问题先修订设计，再重新实现和审查。</div>
            </div>
            <section style={{ marginTop: 12, padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
              <b>可复用工作流 DAG</b>
              <div style={{ color: 'var(--muted-2)', marginTop: 4 }}>阶段可并行或汇合；同一岗位可以承担多个不同阶段。阶段 ID 是稳定标识，输入/输出契约填写逗号分隔的产物名。</div>
              {graphStages.map((stage, index) => <div key={`${stage.id}-${index}`} style={{ marginTop: 10, padding: 8, background: 'var(--surface-2)', borderRadius: 5 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(120px,1fr) minmax(120px,1fr) minmax(120px,1fr) auto', gap: 7, alignItems: 'center' }}>
                  <input aria-label={`阶段 ${index + 1} ID`} value={stage.id} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, id: event.target.value.trim() } : item))} placeholder="stage-id" />
                  <input aria-label={`阶段 ${index + 1} 名称`} value={stage.label} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, label: event.target.value } : item))} placeholder="阶段名称" />
                  <select aria-label={`阶段 ${index + 1} 岗位`} value={stage.role} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, role: event.target.value } : item))}>
                    {rolesForSelect.map(role => <option key={role.role} value={role.role}>{role.label} · {role.role}</option>)}
                  </select>
                  <select aria-label={`阶段 ${index + 1} Agent 工具`} value={stage.toolConfigRef ? `ref:${stage.toolConfigRef.id}@${stage.toolConfigRef.version}` : `new:${stage.tool}`} onChange={event => setGraphStages(current => current.map((item, at) => {
                    if (at !== index) return item
                    const selected = event.target.value
                    if (selected.startsWith('ref:')) {
                      const value = selected.slice(4)
                      const split = value.lastIndexOf('@')
                      const config = configs.find(candidate => candidate.id === value.slice(0, split) && candidate.version === Number(value.slice(split + 1)))
                      const tool: ToolChoice = config?.adapter === 'dsh-subagent' && config.providerName === 'codex' ? 'codex'
                        : config?.adapter === 'dsh-subagent' && config.providerName === 'claude-code' ? 'claude-code' : 'dsh-native'
                      return { ...item, tool, toolConfigRef: config ? { id: config.id, version: config.version } : null }
                    }
                    const tool = selected.slice(4) as ToolChoice
                    return { ...item, tool, toolConfigRef: null }
                  }))}>
                    <option value="new:claude-code">新增/复用 Claude Code 配置</option><option value="new:dsh-native">新增/复用 本地执行服务 配置</option><option value="new:codex">新增/复用 Codex 配置</option>
                    {configs.filter(config => config.enabled).map(config => <option key={`${config.id}@${config.version}`} value={`ref:${config.id}@${config.version}`}>{config.providerName} · {config.id} v{config.version}</option>)}
                  </select>
                  <button type="button" className="btn ghost" disabled={graphStages.length <= 2} aria-label={`删除阶段 ${stage.id}`} onClick={() => {
                    const next = graphStages.filter((_, at) => at !== index)
                    setGraphStages(next)
                    setGraphEdges(edges => edges.filter(edge => edge.from !== stage.id && edge.to !== stage.id))
                    if (reviewStageId === stage.id) setReviewStageId(next[0]?.id ?? '')
                    if (reviewDesignRoute === stage.id) setReviewDesignRoute(next[0]?.id ?? '')
                    if (reviewImplementationRoute === stage.id) setReviewImplementationRoute(next[0]?.id ?? '')
                  }}>删除</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(130px,1fr) minmax(130px,1fr) minmax(150px,1.2fr) minmax(130px,1fr)', gap: 7, marginTop: 7 }}>
                  <input aria-label={`${stage.id} 输入产物`} value={stage.inputArtifacts} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, inputArtifacts: event.target.value } : item))} placeholder="输入产物：design-bundle, ..." />
                  <input aria-label={`${stage.id} 输出产物`} value={stage.outputArtifacts} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, outputArtifacts: event.target.value } : item))} placeholder="输出产物：implementation-commit, ..." />
                  {stage.id === reviewImplementationRoute && <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                    <small>Legion 在实现 Agent 提交代码后，会按冻结的 executable + argv 直接启动测试（shell=false）。包管理器运行脚本时仍遵循其自身脚本语义；测试进程使用 worker 账户权限。Windows 下 npm 可用，pnpm/yarn shell shim 不支持。</small>
                    <input aria-label={`${stage.id} 独立测试 executable`} value={stage.testExecutable} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, testExecutable: event.target.value } : item))} placeholder="node / npm / pytest / go ..." />
                    <input aria-label={`${stage.id} 独立测试 argv JSON`} value={stage.testArgs} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, testArgs: event.target.value } : item))} placeholder='["--test"]' />
                    <input aria-label={`${stage.id} 独立测试超时毫秒`} type="number" min={1000} max={3600000} step={1000} value={stage.testTimeoutMs} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, testTimeoutMs: Number(event.target.value) } : item))} />
                  </div>}
                  <select aria-label={`${stage.id} 模型配置`} title="模型档案覆盖仅支持 本地 Agent 工具；Claude Code/Codex 使用其自身模型设置" disabled={stage.toolConfigRef
                    ? configs.find(config => config.id === stage.toolConfigRef?.id && config.version === stage.toolConfigRef?.version)?.adapter !== 'dsh-native'
                    : stage.tool !== 'dsh-native'} value={stage.modelConfigRef ? `${stage.modelConfigRef.id}@${stage.modelConfigRef.version}` : ''} onChange={event => {
                    const selected = event.target.value
                    const split = selected.lastIndexOf('@')
                    const id = selected.slice(0, split)
                    const version = selected.slice(split + 1)
                    const modelConfigRef = split > 0 && Number.isSafeInteger(Number(version)) ? { id, version: Number(version) } : null
                    setGraphStages(current => current.map((item, at) => at === index ? { ...item, modelConfigRef } : item))
                  }}>
                    <option value="">使用 Agent 工具默认模型</option>
                    {modelProfiles.filter(profile => Number.isSafeInteger(profile.version)).map(profile => <option key={`${profile.id}@${profile.version}`} value={`${profile.id}@${profile.version}`}>{profile.displayName} · {profile.provider}/{profile.model} v{profile.version}</option>)}
                  </select>
                  <select aria-label={`${stage.id} 执行节点`} value={stage.nodeId} onChange={event => setGraphStages(current => current.map((item, at) => at === index ? { ...item, nodeId: event.target.value } : item))}>
                    <option value="">自动选择节点</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.label} · {node.status}</option>)}
                  </select>
                </div>
              </div>)}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" className="btn ghost" onClick={() => {
                  const id = `stage-${graphStages.length + 1}`
                  setGraphStages(current => [...current, { id, role: rolesForSelect[0]?.role ?? '', label: `阶段 ${current.length + 1}`, tool: 'dsh-native', toolConfigRef: null, modelConfigRef: null, nodeId: '', inputArtifacts: '', outputArtifacts: '', testExecutable: '', testArgs: '[]', testTimeoutMs: 900000 }])
                }}>添加阶段</button>
                <button type="button" className="btn ghost" disabled={graphStages.length < 2} onClick={() => setGraphEdges(current => [...current, { from: graphStages[0].id, to: graphStages[1].id }])}>添加依赖边</button>
              </div>
              <div style={{ marginTop: 10 }}><b>成功路径依赖</b>
                {graphEdges.map((edge, index) => <div key={index} style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 6 }}>
                  <select aria-label={`依赖 ${index + 1} 起点`} value={edge.from} onChange={event => setGraphEdges(current => current.map((item, at) => at === index ? { ...item, from: event.target.value } : item))}>
                    {graphStages.map(stage => <option key={stage.id} value={stage.id}>{stage.id}</option>)}
                  </select><span>→</span>
                  <select aria-label={`依赖 ${index + 1} 终点`} value={edge.to} onChange={event => setGraphEdges(current => current.map((item, at) => at === index ? { ...item, to: event.target.value } : item))}>
                    {graphStages.map(stage => <option key={stage.id} value={stage.id}>{stage.id}</option>)}
                  </select>
                  <button type="button" className="btn ghost" aria-label={`删除依赖 ${index + 1}`} onClick={() => setGraphEdges(current => current.filter((_, at) => at !== index))}>移除边</button>
                </div>)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(120px,1fr))', gap: 7, marginTop: 10 }}>
                <label>审查阶段<select value={reviewStageId} onChange={event => setReviewStageId(event.target.value)}>{graphStages.map(stage => <option key={stage.id} value={stage.id}>{stage.id} · {stage.label}</option>)}</select></label>
                <label>设计问题退回<select value={reviewDesignRoute} onChange={event => setReviewDesignRoute(event.target.value)}>{graphStages.map(stage => <option key={stage.id} value={stage.id}>{stage.id} · {stage.label}</option>)}</select></label>
                <label>实现问题退回<select value={reviewImplementationRoute} onChange={event => setReviewImplementationRoute(event.target.value)}>{graphStages.map(stage => <option key={stage.id} value={stage.id}>{stage.id} · {stage.label}</option>)}</select></label>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <select aria-label="从已发布定义载入并续版" value="" onChange={event => {
                  const selected = definitions.find(item => `${item.id}@${item.version}` === event.target.value)
                  if (selected) loadDefinitionDraft(selected)
                }}>
                  <option value="">从已发布版本载入并创建新版本…</option>
                  {definitions.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · {item.id} v{item.version}</option>)}
                </select>
                <input value={definitionId} onChange={event => setDefinitionId(event.target.value)} placeholder="工作流 ID，如 workflow.team.custom" aria-label="工作流 ID" />
                <input value={definitionName} onChange={event => setDefinitionName(event.target.value)} placeholder="可复用工作流名称" aria-label="可复用工作流名称" />
                <button type="button" className="btn ghost" disabled={saving || loading || rolesForSelect.length === 0} onClick={() => void publishDefinition()}>{saving ? '发布中…' : '发布为可复用工作流版本'}</button>
                <span style={{ color: 'var(--muted-2)' }}>{definitions.length} 个已登记版本 · 阶段与依赖由服务端校验</span>
              </div>
            </section>
          </>}
          {error && <div style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
          <section style={{ marginTop: 14, padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
            <b>工作流运行实例</b>
            <div style={{ color: 'var(--muted-2)', margin: '4px 0 8px' }}>按目标保存的独立运行快照。选择实例可查看阶段任务、产物交接与审查返工记录。</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
              <input aria-label="搜索工作流实例" value={instanceSearch} onChange={event => setInstanceSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void refreshInstances(0) }} placeholder="按目标、定义 ID 或实例 ID 搜索" />
              <select aria-label="按状态筛选工作流实例" value={instanceStatus} onChange={event => { setInstanceStatus(event.target.value); void refreshInstances(0, event.target.value) }}>
                <option value="all">全部状态</option><option value="active">进行中</option><option value="done">已完成</option><option value="paused">已暂停</option><option value="canceled">已取消</option>
              </select>
              <button type="button" className="btn ghost" disabled={loading || instancesLoading} onClick={() => void refreshInstances(0)}>搜索</button>
            </div>
            {instances.length === 0 ? <div style={{ color: 'var(--muted-2)' }}>该空间还没有创建跨 Agent 工作流实例。</div> : <div style={{ display: 'grid', gap: 6 }}>
              {instances.map(instance => <div key={instance.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(130px,1fr) auto auto auto', gap: 8, alignItems: 'center', padding: 6, background: 'var(--surface-2)', borderRadius: 5 }}>
                <div><b>{instance.objective || instance.definitionName || instance.id}</b><div style={{ color: 'var(--muted-2)', fontSize: 10 }}>{instance.definitionId ? `${instance.definitionId} · v${instance.definitionVersion}` : '空间默认工作流'} · {instance.id}</div></div>
                <span>{workflowStatusLabel(instance.status)} · {instance.counts.done}/{instance.counts.total} 完成</span>
                <button type="button" className="btn ghost" disabled={historyLoading || !instance.anchorTaskId} onClick={() => void inspectInstance(instance)}>查看历史</button>
                {(instance.status === 'active' || instance.status === 'paused') && <div style={{ display: 'flex', gap: 5 }}>
                  {cancelConfirmId === instance.id ? <>
                    <button type="button" className="btn ghost danger confirming" disabled={instanceActionId !== null} onClick={() => void changeInstanceStatus(instance, 'canceled')}>{instanceActionId === instance.id ? '处理中…' : '确认取消'}</button>
                    <button type="button" className="btn ghost" disabled={instanceActionId !== null} onClick={() => setCancelConfirmId(null)}>保留</button>
                  </> : <>
                    <button type="button" className="btn ghost" disabled={instanceActionId !== null} onClick={() => void changeInstanceStatus(instance, instance.status === 'active' ? 'paused' : 'active')}>
                      {instanceActionId === instance.id ? '处理中…' : instance.status === 'active' ? '暂停' : '恢复'}
                    </button>
                    <button type="button" className="btn ghost" disabled={instanceActionId !== null} title="取消目标会取消未开工任务，并将在办任务留痕挂起" onClick={() => void changeInstanceStatus(instance, 'canceled')}>取消</button>
                  </>}
                </div>}
              </div>)}
            </div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 8 }}>
              <span style={{ color: 'var(--muted-2)' }}>{instanceTotal ? `${instanceOffset + 1}–${Math.min(instanceOffset + instances.length, instanceTotal)} / ${instanceTotal}` : '0 项'}</span>
              <button type="button" className="btn ghost" disabled={loading || instancesLoading || instanceOffset <= 0} onClick={() => void refreshInstances(Math.max(0, instanceOffset - 20))}>上一页</button>
              <button type="button" className="btn ghost" disabled={loading || instancesLoading || instanceOffset + instances.length >= instanceTotal} onClick={() => void refreshInstances(instanceOffset + 20)}>下一页</button>
            </div>
            {historyLoading && <div style={{ marginTop: 8, color: 'var(--muted-2)' }}>正在读取工作流历史…</div>}
            {selectedHistory && <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div><b>{selectedHistory.workflowId}</b> · {selectedHistory.instance?.status ? workflowStatusLabel(selectedHistory.instance.status) : '状态未知'} · {selectedHistory.reviews.length} 条审查/返工记录</div>
              <div style={{ display: 'grid', gap: 5, marginTop: 6 }}>
                {selectedHistory.tasks.map(task => <div key={task.id} style={{ padding: 6, background: 'var(--surface-2)', borderRadius: 4 }}>
                  <b>{task.workflowStageId ?? task.agentSelectionSnapshot?.workflowStageId ?? task.role ?? '阶段'}</b> · {task.title} · {task.status}
                  <div style={{ color: 'var(--muted-2)', fontSize: 10 }}>任务 {task.id} · 工具 {task.agentSelectionSnapshot?.agentToolConfig?.id ?? '未记录'} · 上游 {task.agentSelectionSnapshot?.workflowContext?.upstreamStages?.length ?? task.agentSelectionSnapshot?.workflowContext?.designArtifacts?.length ?? 0} 项</div>
                </div>)}
              </div>
              {selectedHistory.reviews.map((review, index) => <div key={`${review.sourceReviewTaskId}:${index}`} style={{ marginTop: 5, color: 'var(--muted-2)' }}>第 {review.round} 轮 · {review.kind} · 审查任务 {review.sourceReviewTaskId}{review.nextTaskId ? ` → ${review.nextTaskId}` : ''}</div>)}
            </div>}
          </section>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn primary" disabled={saving || loading || rolesForSelect.length < 3} onClick={() => void save()}>{saving ? '保存中…' : '保存闭环配置'}</button>
            {pipeline.workflow && <button type="button" className="btn ghost" disabled={saving} onClick={() => void disable()}>关闭自动交接</button>}
            <button type="button" className="btn ghost" disabled={saving} onClick={() => void load()}>刷新</button>
          </div>
          {pipeline.workflow && <div style={{ marginTop: 8, color: 'var(--green)' }}>当前已启用：{pipeline.workflow.designRole} → {pipeline.workflow.implementationRole} → {pipeline.workflow.reviewRole} · v{pipeline.version}</div>}
        </>}
      </div>}
    </div>
  )
}

function workflowStatusLabel(status: string): string {
  return ({ active: '进行中', done: '已完成', paused: '已暂停', canceled: '已取消' } as Record<string, string>)[status] ?? status
}

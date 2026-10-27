import { useEffect, useMemo, useState } from 'react'
import { fetchAgentNodes, fetchAgentToolConfigs, fetchAgentWorkflowDefinitions, previewGoalPlan, type AgentNodeRecord, type AgentToolConfigRecord, type AgentWorkflowDefinition, type AgentWorkflowDefinitionRef, type GoalAssignmentInput, type GoalPlanResponse } from '../api'
import { goalPlanView, publishGate } from '../goalPlanView'
import { defaultGoalWorkflowSelection, goalWorkflowOptions } from '../goalWorkflowOptions.mjs'
import { bindingWarning, crossNodeConflict, decideAutoNode, describeCrossNodeConflict, effectiveNodeId, scanNodes } from '../goalNodeChoice'
import { toast } from './Toast'

interface GoalModalProps {
  scope: string
  spaceName: string
  /** 目标数量提示（发布并存语义：每次发布都新建一个目标记录）。 */
  activeCount?: number
  onClose: () => void
  /**
   * 发布回调。`options` 携带编排模式与分配层（T1.3 / T1.5 / T1.6）——
   * 它们**只影响本次发布**，不改写空间配置。
   */
  onPublish: (scope: string, objective: string, workflowDefinition?: AgentWorkflowDefinitionRef, agentNodeId?: string, options?: GoalPublishExtras) => Promise<void>
}

export interface GoalPublishExtras {
  orchestration?: 'pipeline' | 'custom-dag'
  assignment?: GoalAssignmentInput
}

/** 当前编排模式：阶段从哪来。 */
type Orchestration = 'pipeline' | 'custom-dag'
/** 执行者粒度：整条目标一个 Agent，还是逐阶段指定。 */
type AssignMode = 'inherit' | 'goal-agent' | 'per-stage'

export function GoalModal({ scope, spaceName, activeCount = 0, onClose, onPublish }: GoalModalProps): React.JSX.Element {
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [definitions, setDefinitions] = useState<AgentWorkflowDefinition[]>([])
  const [selectedDefinition, setSelectedDefinition] = useState('')
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false)
  const [definitionsError, setDefinitionsError] = useState('')
  const [definitionsReload, setDefinitionsReload] = useState(0)
  // —— T1.3：编排模式。默认 pipeline（阶段来自流水线，定义只作分配模板）。——
  const [orchestration, setOrchestration] = useState<Orchestration>('pipeline')
  // —— T1.5 / T1.6：执行者粒度 ——
  const [assignMode, setAssignMode] = useState<AssignMode>('inherit')
  const [goalAgentId, setGoalAgentId] = useState('')
  const [stageOverrides, setStageOverrides] = useState<Record<string, string>>({})
  const [toolConfigs, setToolConfigs] = useState<AgentToolConfigRecord[]>([])
  /**
   * 执行节点扫描结果（2026-10-13）。`null` = 还没扫到。
   *
   * ★ 默认 **不绑定**（`chosenNode` 初始为 `''`）—— 这是刻意的，理由见 goalNodeChoice.ts：
   *   绑定是硬绑定，认领方必须带同一个 `agentNodeId`；对没配的守护来说绑定等于"一件都领不走"。
   */
  const [nodes, setNodes] = useState<AgentNodeRecord[] | null>(null)
  const [chosenNode, setChosenNode] = useState('')
  // —— T1.1 / T1.2：计划预览 ——
  const [planResponse, setPlanResponse] = useState<GoalPlanResponse | null>(null)
  const [planError, setPlanError] = useState('')
  const [planLoading, setPlanLoading] = useState(false)

  useEffect(() => {
    let active = true
    setDefinitionsLoaded(false)
    setDefinitionsError('')
    setSelectedDefinition('')
    void fetchAgentWorkflowDefinitions(scope)
      .then(value => {
        if (!active) return
        setDefinitions(value)
        setSelectedDefinition(defaultGoalWorkflowSelection(goalWorkflowOptions(value)))
      })
      .catch(error => {
        if (!active) return
        setDefinitions([])
        setDefinitionsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { if (active) setDefinitionsLoaded(true) })
    // 扫描执行节点：读失败就当"没登记"（与后端语义一致：不绑定也能跑）。
    void fetchAgentNodes(scope)
      .then(value => { if (active) setNodes(value) })
      .catch(() => { if (active) setNodes([]) })
    // T1.5：目标级/逐阶段选择需要工具配置候选。读失败就只剩「沿用空间设置」。
    void fetchAgentToolConfigs()
      .then(value => { if (active) setToolConfigs(value.filter(item => item.enabled !== false)) })
      .catch(() => { if (active) setToolConfigs([]) })
    return () => { active = false }
  }, [scope, definitionsReload])

  const workflowOptions = useMemo(() => goalWorkflowOptions(definitions), [definitions])
  const scan = useMemo(() => scanNodes(nodes), [nodes])
  /** 选中的具名定义（用于在发布前就查"工作流绑的节点 vs 我选的节点"是否冲突）。 */
  const selectedDefinitionRecord = useMemo(
    () => workflowOptions.find(option => option.value === selectedDefinition)?.definition ?? null,
    [workflowOptions, selectedDefinition],
  )
  const conflictText = useMemo(() => describeCrossNodeConflict(crossNodeConflict(
    (selectedDefinitionRecord?.stages ?? []).map(stage => stage.nodeId),
    chosenNode,
  )), [selectedDefinitionRecord, chosenNode])
  /**
   * ★ 自动决定（B 档）：用户没指定时，按"同机改派 / 跨机排队"自动判该不该绑、绑哪台。
   * 判据全在 `goalNodeChoice.ts` 的纯函数里（已带 26 条判据）。
   */
  const autoDecision = useMemo(() => decideAutoNode(nodes), [nodes])
  /** 真正要发出去的节点 id：**手动优先，否则自动**。 */
  const finalNodeId = useMemo(() => effectiveNodeId(chosenNode, autoDecision), [chosenNode, autoDecision])
  const nodeWarning = useMemo(() => bindingWarning(finalNodeId), [finalNodeId])

  /** 工具配置 id → 展示名（`tool.codex` → `Codex` 这类翻译只发生在展示层）。 */
  const configuredTools = useMemo(() => {
    const table: Record<string, string> = {}
    for (const config of toolConfigs) table[config.id] = providerLabelOf(config.providerName)
    return table
  }, [toolConfigs])

  /** 分配层：只有用户真的选了才发，免得把"没选"写成"选了空"。 */
  const assignment = useMemo((): GoalAssignmentInput | undefined => {
    if (assignMode === 'inherit') return undefined
    if (assignMode === 'goal-agent') {
      const ref = selectedToolRef(goalAgentId, toolConfigs)
      return ref ? { agentToolConfig: ref } : undefined
    }
    const overrides: NonNullable<GoalAssignmentInput['stageOverrides']> = {}
    for (const [role, value] of Object.entries(stageOverrides)) {
      const ref = selectedToolRef(value, toolConfigs)
      if (ref) overrides[role] = { agentToolConfig: ref }
    }
    return Object.keys(overrides).length > 0 ? { stageOverrides: overrides } : undefined
  }, [assignMode, goalAgentId, stageOverrides, toolConfigs])

  const selectedReference = useMemo(() => {
    const selected = workflowOptions.find(option => option.value === selectedDefinition)?.definition
    return selected ? { id: selected.id, version: selected.version } : undefined
  }, [workflowOptions, selectedDefinition])

  // —— T1.1：预览与发布走同一段参数；文本改动静默重算（防抖 250ms），不打扰输入 ——
  useEffect(() => {
    let active = true
    setPlanLoading(true)
    setPlanError('')
    const timer = setTimeout(() => {
      void previewGoalPlan(scope, objective.trim(), {
        workflowDefinition: selectedReference,
        agentNodeId: finalNodeId ?? undefined,
        orchestration,
        assignment: orchestration === 'custom-dag' ? undefined : assignment,
      })
        .then(value => { if (active) setPlanResponse(value) })
        .catch(error => {
          if (!active) return
          // ★ 预览失败必须**显式显示**：它既不等于"没有阶段"，也不等于"可以发布"。
          setPlanResponse(null)
          setPlanError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => { if (active) setPlanLoading(false) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [scope, objective, selectedReference, finalNodeId, orchestration, assignment])

  const planView = useMemo(() => goalPlanView(planResponse, configuredTools), [planResponse, configuredTools])
  const gate = useMemo(() => publishGate(planView), [planView])

  const submit = async (): Promise<void> => {
    const text = objective.trim()
    if (!text) return
    setBusy(true)
    try {
      await onPublish(scope, text, selectedReference, finalNodeId ?? undefined, {
        orchestration,
        assignment: orchestration === 'custom-dag' ? undefined : assignment,
      })
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `发布失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  const stageCards = planView?.stages ?? []
  const canPublish = gate.enabled && !busy && objective.trim().length > 0

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          🎯 发布目标 · {spaceName}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>目标文案 *（该目标的智能体任务链将围绕它推进）</label>
            <textarea
              value={objective}
              onChange={e => setObjective(e.target.value)}
              rows={3}
              placeholder="例如：完成 Shop 跨境电商总项目首周上架与合规验收"
              autoFocus
            />
          </div>

          {/* ── T1.3：编排模式（阶段从哪来）。它和执行者是**两件事**，所以是两个控件。 ── */}
          <div className="field">
            <label>编排模式（决定**阶段从哪来**，不决定谁执行）</label>
            <select
              aria-label="编排模式"
              value={orchestration}
              onChange={event => setOrchestration(event.target.value === 'custom-dag' ? 'custom-dag' : 'pipeline')}
              disabled={busy}
            >
              <option value="pipeline">按空间流水线（推荐）</option>
              <option value="custom-dag">按已发布工作流的拓扑（可并行/汇合）</option>
            </select>
            <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>
              {orchestration === 'pipeline'
                ? '阶段集合由空间流水线决定；下面选的工作流只当「分配模板」，不会增减阶段。'
                : '阶段集合来自所选工作流的**拓扑**（含并行/汇合）；必须选一个已发布版本。此模式下分配由定义本身决定。'}
            </span>
          </div>

          {/* ── T1.5 / T1.6：执行者粒度（谁执行）。 ── */}
          <div className="field">
            <label>执行者（决定**谁执行**，不改变阶段）</label>
            <select
              aria-label="执行者粒度"
              value={assignMode}
              onChange={event => setAssignMode(event.target.value as AssignMode)}
              disabled={busy || orchestration === 'custom-dag'}
            >
              <option value="inherit">沿用空间/模板配置</option>
              <option value="goal-agent">整条目标由一个 Agent 完成</option>
              <option value="per-stage">按阶段分别指定</option>
            </select>
            {orchestration === 'custom-dag'
              ? <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>按定义建链时，执行者由该工作流各阶段自己决定。</span>
              : null}
            {assignMode === 'goal-agent' && (
              <div style={{ marginTop: 4 }}>
                <select
                  aria-label="目标级 Agent"
                  value={goalAgentId}
                  onChange={event => setGoalAgentId(event.target.value)}
                  disabled={busy}
                >
                  <option value="">选择 Agent…</option>
                  {toolConfigs.map(config => (
                    <option key={`${config.id}@${config.version}`} value={`${config.id}@${config.version}`}>
                      {providerLabelOf(config.providerName)} · {config.id}@{config.version}{config.adapter === 'dsh-native' ? '（DSH 原生）' : '（外部 Agent）'}
                    </option>
                  ))}
                </select>
                <div style={{ color: 'var(--muted-2)', fontSize: 10 }}>
                  整条链都用它。<b>独立测试命令不受影响</b>（它属于验收契约，仍在「Agent 工作流」里配）。
                </div>
              </div>
            )}
            {assignMode === 'per-stage' && (
              <div style={{ marginTop: 4, color: 'var(--muted-2)', fontSize: 10 }}>
                把下面计划卡片里的「改为…」逐个选一遍；没选的阶段沿用空间/模板配置。
              </div>
            )}
          </div>

          {/* 分配模板：pipeline 下它是「按岗位的分配模板」，不改阶段集合。 */}
          {orchestration === 'pipeline' && (
            <div className="field">
              <label>Agent 分配模板（可选 · 不改变阶段）</label>
              <select value={selectedDefinition} onChange={event => setSelectedDefinition(event.target.value)} disabled={busy || !definitionsLoaded}>
                <option value="">沿用空间当前设置</option>
                {workflowOptions.map(option => <option key={option.value} value={option.value}>
                  {option.label}
                </option>)}
              </select>
              <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>
                {!definitionsLoaded
                  ? '正在读取可用工作流…'
                  : definitionsError
                    ? <>读取失败：{definitionsError} <button type="button" className="btn ghost" onClick={() => setDefinitionsReload(value => value + 1)}>重试</button></>
                    : workflowOptions.length > 0
                      ? '阶段集合由空间流水线决定，这里只选择各岗位由哪个 Agent 执行；未覆盖的岗位沿用 DSH 默认。'
                      : '当前空间还没有已发布的 Agent 工作流；可继续使用空间当前设置。'}
              </span>
            </div>
          )}
          {orchestration === 'custom-dag' && (
            <div className="field">
              <label>已发布工作流 *（按它的拓扑建链）</label>
              <select value={selectedDefinition} onChange={event => setSelectedDefinition(event.target.value)} disabled={busy || !definitionsLoaded}>
                <option value="">选择工作流…</option>
                {workflowOptions.map(option => <option key={option.value} value={option.value}>
                  {option.label}
                </option>)}
              </select>
              <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>
                不带拓扑的工作流无法建链；缺它会直接被拦下，不会发布出一个空目标。
              </span>
            </div>
          )}

          <div className="field">
            <label>执行节点</label>
            {/* ★★ 2026-10-13（B 档）：**自动选择**，不再要用户先做一次假选择。
                判据在 goalNodeChoice.ts 的 `decideAutoNode`（纯函数，五档）：
                  · 没有就绪节点 / 恰好一个 / 判不清 ⇒ **不绑定**（任一在线执行服务认领）
                  · 全在同一台机器 ⇒ **不绑定**（同机可改派，保持"谁空闲谁认领"）
                  · 跨机器 ⇒ **绑定**到最闲的那台（跨机必须排队，一条链不能横跨两台）
                用户仍可**手动覆盖** —— 自动是为了省事，不是为了夺走控制权。 */}
            <div style={{ color: 'var(--muted-2)', fontSize: 11 }}>
              {nodes === null ? '正在扫描本空间的执行节点…' : `🤖 ${autoDecision.reason}`}
            </div>
            <details style={{ marginTop: 4 }}>
              <summary style={{ color: 'var(--muted-2)', fontSize: 10, cursor: 'pointer' }}>
                手动指定节点（可选 · 覆盖上面的自动决定）
              </summary>
              <select
                aria-label="手动指定执行节点"
                value={chosenNode}
                onChange={event => setChosenNode(event.target.value)}
                disabled={busy || nodes === null}
                style={{ marginTop: 4 }}
              >
                <option value="">跟随自动决定{autoDecision.nodeId === null ? '（不绑定）' : `（${autoDecision.nodeId}）`}</option>
                {(scan.readyNodes.length > 0 ? scan.readyNodes : (nodes ?? [])).map(node => (
                  <option key={String(node.id)} value={String(node.id)}>
                    {node.label ?? node.id} · {node.id}
                    {node.status === 'ready' ? '' : `（${node.status ?? 'unknown'}）`}
                    {typeof node.busy === 'number' && typeof node.capacity === 'number' ? ` · 忙 ${node.busy}/${node.capacity}` : ''}
                  </option>
                ))}
              </select>
              <div style={{ color: 'var(--muted-2)', fontSize: 10, marginTop: 2 }}>
                {scan.headline}
                {finalNodeId === null ? ' 本条链**不绑定**节点。' : ` 本条链将绑定到 ${finalNodeId}。`}
              </div>
            </details>
            {nodeWarning !== null && <span style={{ color: 'var(--yellow)', fontSize: 10 }}>{nodeWarning}</span>}
            {conflictText !== null && <span style={{ color: 'var(--red)', fontSize: 10 }}>⛔ {conflictText}</span>}
          </div>

          {/* ── T1.2：计划预览。发布前就能看见阶段、执行者、来源与阻塞。 ── */}
          <div className="field">
            <label>
              计划预览
              {planLoading ? '（计算中…）' : planView ? ` · ${planView.headline}` : ''}
            </label>
            {planError !== ''
              ? <div style={{ color: 'var(--red)', fontSize: 11 }}>计划预览失败：{planError}</div>
              : planView === null
                ? <div style={{ color: 'var(--muted-2)', fontSize: 11 }}>正在读取计划…</div>
                : <>
                  {planView.goalAgentLabel !== '' && <div style={{ fontSize: 11, marginBottom: 4 }}>
                    整条目标由 <b>{planView.goalAgentLabel}</b> 执行
                  </div>}
                  {/* 决策 #2：自审提示——**只提示，不拦发布**（拦了就等于否掉"整目标一个 Agent"）。 */}
                  {planView.selfReviewNote !== null && <div style={{
                    fontSize: 11, marginBottom: 4, padding: '4px 6px', borderRadius: 4,
                    border: '1px solid var(--yellow)', color: 'var(--yellow)',
                  }}>
                    ⚠ 自审：{planView.selfReviewNote}
                  </div>}
                  <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
                    {stageCards.length === 0
                      ? <div style={{ padding: 8, color: 'var(--muted-2)', fontSize: 11 }}>该空间编队为空：发布后不会生成任务链。</div>
                      : stageCards.map(stage => (
                        <div key={stage.role} style={{ padding: '6px 8px', borderTop: '1px solid var(--line)' }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <b>{stage.label}</b>
                            <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>{stage.role}</span>
                            {stage.gate && <span style={{ color: 'var(--yellow)', fontSize: 10 }}>⏸ 闸门</span>}
                            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted-2)' }}>{stage.sourceLabel}</span>
                          </div>
                          <div style={{ fontSize: 11 }}>
                            执行：<b>{stage.agent}</b>
                            {stage.model !== '' && <> · 模型：{stage.model}</>}
                            {' · '}节点：{stage.node}
                          </div>
                          <div style={{ color: 'var(--muted-2)', fontSize: 10 }}>{stage.waitingOn}</div>
                          {assignMode === 'per-stage' && (
                            <select
                              aria-label={`覆盖 ${stage.role} 的执行者`}
                              value={stageOverrides[stage.role] ?? ''}
                              onChange={event => setStageOverrides(current => ({ ...current, [stage.role]: event.target.value }))}
                              disabled={busy}
                              style={{ marginTop: 2, fontSize: 11 }}
                            >
                              <option value="">沿用（不改这一环）</option>
                              {toolConfigs.map(config => (
                                <option key={`${config.id}@${config.version}`} value={`${config.id}@${config.version}`}>
                                  {providerLabelOf(config.providerName)} · {config.id}@{config.version}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ))}
                  </div>
                  {planView.blockers.length > 0 && <div style={{ marginTop: 4 }}>
                    {planView.blockers.map(blocker => <div key={blocker.code} style={{ color: 'var(--red)', fontSize: 11 }}>
                      ⛔ {blocker.message}
                    </div>)}
                  </div>}
                  {planView.warnings.length > 0 && <div style={{ marginTop: 4 }}>
                    {planView.warnings.map((warning, index) => <div key={`${warning.code}:${index}`} style={{ color: 'var(--yellow)', fontSize: 10 }}>
                      ⚠ {warning.message}
                    </div>)}
                  </div>}
                </>}
          </div>

          <div className="field">
            <label>
              <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>
                {activeCount > 0
                  ? `该空间已有 ${activeCount} 个目标在推进：本次发布会新建一个独立目标（自动生成自己的任务链），与既有目标并存、互不取消。`
                  : '发布后写入 team-hub（按空间存储），自动按编队生成该目标的阶段任务链；可随时再发布新目标，多个目标并发推进。'}
              </span>
            </label>
          </div>
        </div>
        <div className="modal-foot">
          {!gate.enabled && gate.reason !== '' && (
            <span style={{ color: 'var(--red)', fontSize: 10, marginRight: 'auto' }}>{gate.reason}</span>
          )}
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={!canPublish}>
            {busy ? '发布中…' : '🚀 发布目标'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 工具后端名 → 界面上叫得出来的产品名（与既有面板的措辞保持一致）。 */
function providerLabelOf(providerName: string | undefined): string {
  switch (providerName) {
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'Codex'
    default: return providerName === undefined || providerName === '' ? 'Agent' : `DSH（${providerName}）`
  }
}

/** `id@version` → 引用对象；格式不对时返回 null（宁可"没选"，也不发一个坏引用）。 */
function selectedToolRef(value: string, configs: AgentToolConfigRecord[]): AgentWorkflowDefinitionRef | null {
  if (typeof value !== 'string' || value === '') return null
  const at = value.lastIndexOf('@')
  if (at <= 0) return null
  const id = value.slice(0, at)
  const version = Number(value.slice(at + 1))
  if (!Number.isSafeInteger(version) || version < 1) return null
  // ★ 只在**候选表里真有这一条**时才发：手输/陈旧的值不该被当成有效选择。
  if (!configs.some(config => config.id === id && config.version === version)) return null
  return { id, version }
}

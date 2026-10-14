import { useEffect, useMemo, useState } from 'react'
import { fetchAgentNodes, fetchAgentWorkflowDefinitions, type AgentNodeRecord, type AgentWorkflowDefinition, type AgentWorkflowDefinitionRef } from '../api'
import { bindingWarning, crossNodeConflict, decideAutoNode, describeCrossNodeConflict, effectiveNodeId, scanNodes } from '../goalNodeChoice'
import { toast } from './Toast'

interface GoalModalProps {
  scope: string
  spaceName: string
  /** 目标数量提示（发布并存语义：每次发布都新建一个目标记录）。 */
  activeCount?: number
  onClose: () => void
  onPublish: (scope: string, objective: string, workflowDefinition?: AgentWorkflowDefinitionRef, agentNodeId?: string) => Promise<void>
}

export function GoalModal({ scope, spaceName, activeCount = 0, onClose, onPublish }: GoalModalProps): React.JSX.Element {
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [definitions, setDefinitions] = useState<AgentWorkflowDefinition[]>([])
  const [selectedDefinition, setSelectedDefinition] = useState('')
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false)
  /**
   * 执行节点扫描结果（2026-10-13）。`null` = 还没扫到。
   *
   * ★ 默认 **不绑定**（`chosenNode` 初始为 `''`）—— 这是刻意的，理由见 goalNodeChoice.ts：
   *   绑定是硬绑定，认领方必须带同一个 `agentNodeId`；对没配的守护来说绑定等于"一件都领不走"。
   */
  const [nodes, setNodes] = useState<AgentNodeRecord[] | null>(null)
  const [chosenNode, setChosenNode] = useState('')

  useEffect(() => {
    let active = true
    void fetchAgentWorkflowDefinitions(scope)
      .then(value => { if (active) setDefinitions(value) })
      .catch(() => { if (active) setDefinitions([]) })
      .finally(() => { if (active) setDefinitionsLoaded(true) })
    // 扫描执行节点：读失败就当"没登记"（与后端语义一致：不绑定也能跑）。
    void fetchAgentNodes(scope)
      .then(value => { if (active) setNodes(value) })
      .catch(() => { if (active) setNodes([]) })
    return () => { active = false }
  }, [scope])

  const runnableDefinitions = useMemo(() => definitions.filter(isRunnableClosedLoop), [definitions])
  const scan = useMemo(() => scanNodes(nodes), [nodes])
  /** 选中的具名定义（用于在发布前就查"工作流绑的节点 vs 我选的节点"是否冲突）。 */
  const selectedDefinitionRecord = useMemo(
    () => runnableDefinitions.find(item => `${item.id}@${item.version}` === selectedDefinition) ?? null,
    [runnableDefinitions, selectedDefinition],
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

  const submit = async (): Promise<void> => {
    const text = objective.trim()
    if (!text) return
    const selected = runnableDefinitions.find(item => `${item.id}@${item.version}` === selectedDefinition)
    const reference = selected ? { id: selected.id, version: selected.version } : undefined
    setBusy(true)
    try {
      await onPublish(scope, text, reference, finalNodeId ?? undefined)
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `发布失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

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
              rows={4}
              placeholder="例如：完成 Shop 跨境电商总项目首周上架与合规验收"
              autoFocus
            />
          </div>
          <div className="field">
            <label>跨 Agent 工作流</label>
            <select value={selectedDefinition} onChange={event => setSelectedDefinition(event.target.value)} disabled={busy}>
              <option value="">沿用空间当前设置</option>
              {runnableDefinitions.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>
                {item.name} · v{item.version}
              </option>)}
            </select>
            <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>
              {definitionsLoaded
                ? runnableDefinitions.length > 0
                  ? '选择后，本目标会冻结该工作流版本及各阶段工具配置。'
                  : '当前空间还没有可执行的命名闭环定义；可继续使用空间当前设置。'
                : '正在读取可用工作流…'}
            </span>
          </div>
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
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !objective.trim()}>
            {busy ? '发布中…' : '🚀 发布目标'}
          </button>
        </div>
      </div>
    </div>
  )
}

function isRunnableClosedLoop(definition: AgentWorkflowDefinition): boolean {
  if (definition.stages.length !== 3 || definition.entryStageIds.length !== 1 || definition.terminalStageIds.length !== 1) return false
  const [designId, implementationId, reviewId] = [definition.reviewRoutes.design, definition.reviewRoutes.implementation, definition.reviewStageId]
  if (new Set([designId, implementationId, reviewId]).size !== 3) return false
  if (definition.entryStageIds[0] !== designId || definition.terminalStageIds[0] !== reviewId) return false
  if (!definition.stages.some(stage => stage.id === designId)
    || !definition.stages.some(stage => stage.id === implementationId)
    || !definition.stages.some(stage => stage.id === reviewId)) return false
  const edges = new Set(definition.edges.map(edge => `${edge.from}\0${edge.to}`))
  return definition.edges.length === 2
    && edges.has(`${designId}\0${implementationId}`)
    && edges.has(`${implementationId}\0${reviewId}`)
}

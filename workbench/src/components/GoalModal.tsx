import { useEffect, useMemo, useState } from 'react'
import { fetchAgentNodes, fetchAgentWorkflowDefinitions, type AgentNodeRecord, type AgentWorkflowDefinition, type AgentWorkflowDefinitionRef } from '../api'
import { defaultGoalWorkflowSelection, goalWorkflowOptions } from '../goalWorkflowOptions.mjs'
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
  const [definitionsError, setDefinitionsError] = useState('')
  const [definitionsReload, setDefinitionsReload] = useState(0)
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

  const submit = async (): Promise<void> => {
    const text = objective.trim()
    if (!text) return
    const selected = workflowOptions.find(option => option.value === selectedDefinition)?.definition
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
            {/* ★ 2026-10-21：这个下拉框选的是**分配模板**，不是编排。
                选它会改「这些岗位由哪个 Agent 执行」，但链上仍然跑完整流水线；
                要按定义的并行/汇合拓扑建链，必须显式用 custom-dag（当前由 API 调用方指定）。 */}
            <label>Agent 分配模板（不改变阶段）</label>
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
                    ? '阶段集合由空间流水线决定，这里只选择各岗位由哪个 Agent 执行；未覆盖的岗位沿用 DSH 默认。工作流配置统一在「Agent 工作流」设置页维护；这里仅显示每条工作流最新发布的版本。新目标使用所选版本，已发布目标保留创建时的版本。'
                    : '当前空间还没有已发布的 Agent 工作流；可继续使用空间当前设置。'}
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

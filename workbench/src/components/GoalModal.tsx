import { useEffect, useMemo, useState } from 'react'
import { fetchAgentWorkflowDefinitions, type AgentWorkflowDefinition, type AgentWorkflowDefinitionRef } from '../api'
import { toast } from './Toast'

interface GoalModalProps {
  scope: string
  spaceName: string
  /** 目标数量提示（发布并存语义：每次发布都新建一个目标记录）。 */
  activeCount?: number
  onClose: () => void
  onPublish: (scope: string, objective: string, workflowDefinition?: AgentWorkflowDefinitionRef) => Promise<void>
}

export function GoalModal({ scope, spaceName, activeCount = 0, onClose, onPublish }: GoalModalProps): React.JSX.Element {
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [definitions, setDefinitions] = useState<AgentWorkflowDefinition[]>([])
  const [selectedDefinition, setSelectedDefinition] = useState('')
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false)

  useEffect(() => {
    let active = true
    void fetchAgentWorkflowDefinitions(scope)
      .then(value => { if (active) setDefinitions(value) })
      .catch(() => { if (active) setDefinitions([]) })
      .finally(() => { if (active) setDefinitionsLoaded(true) })
    return () => { active = false }
  }, [scope])

  const runnableDefinitions = useMemo(() => definitions.filter(isRunnableClosedLoop), [definitions])

  const submit = async (): Promise<void> => {
    const text = objective.trim()
    if (!text) return
    const selected = runnableDefinitions.find(item => `${item.id}@${item.version}` === selectedDefinition)
    const reference = selected ? { id: selected.id, version: selected.version } : undefined
    setBusy(true)
    try {
      await onPublish(scope, text, reference)
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

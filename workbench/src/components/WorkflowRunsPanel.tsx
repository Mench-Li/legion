import { useEffect, useRef, useState } from 'react'
import { fetchAgentWorkflowHistory, fetchAgentWorkflowInstances, setGoalStatus } from '../api'
import type { AgentWorkflowHistory, AgentWorkflowInstanceSummary } from '../api'
import type { GoalStatus } from '../types'
import { toast } from './Toast'

/**
 * 「工作流运行实例」——**只读的运行历史** + 暂停/恢复/取消目标。
 *
 * ★ 2026-10-13：从「Agent 工作流」配置面板里**搬出来**，成为设置里的独立一页。
 *   它原本渲染在那个配置面板的最底部，于是：
 *     ① 配置面板看起来"很复杂"，而这一块与"我要不要配工作流"**毫无关系**；
 *     ② 想看运行情况的人，得先展开一个配置面板才能翻到底部。
 *
 *   > 一块"只读的运行历史"，与一块"要用户填的配置"，
 *   > 在**它们挨在一起**的时候会让后者显得比实际复杂 ——
 *   > 而用户对面板复杂度的判断，只看它有多长。
 */
interface Props { scope: string }

export function WorkflowRunsPanel({ scope }: Props): React.JSX.Element {
  const [instances, setInstances] = useState<AgentWorkflowInstanceSummary[]>([])
  const [instanceTotal, setInstanceTotal] = useState(0)
  const [instanceOffset, setInstanceOffset] = useState(0)
  const [instanceStatus, setInstanceStatus] = useState('all')
  const [instanceSearch, setInstanceSearch] = useState('')
  const [instancesLoading, setInstancesLoading] = useState(false)
  const [selectedHistory, setSelectedHistory] = useState<AgentWorkflowHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [instanceActionId, setInstanceActionId] = useState<string | null>(null)
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null)
  const [error, setError] = useState('')
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

  // 首屏与切空间时各拉一次。★ 依赖里只有 scope：状态/搜索由用户操作触发，
  //   放进依赖会让"每次输入都重新拉一页"（原来在配置面板里是手动触发的）。
  useEffect(() => { void refreshInstances(0) /* eslint-disable-line react-hooks/exhaustive-deps */ }, [scope])

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

  return <div style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
    <b>工作流运行实例</b>
    <div style={{ color: 'var(--muted-2)', margin: '4px 0 8px' }}>按目标保存的独立运行快照。选择实例可查看阶段任务、产物交接与审查返工记录。</div>
    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
      <input aria-label="搜索工作流实例" value={instanceSearch} onChange={event => setInstanceSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void refreshInstances(0) }} placeholder="按目标、定义 ID 或实例 ID 搜索" />
      <select aria-label="按状态筛选工作流实例" value={instanceStatus} onChange={event => { setInstanceStatus(event.target.value); void refreshInstances(0, event.target.value) }}>
        <option value="all">全部状态</option><option value="active">进行中</option><option value="done">已完成</option><option value="paused">已暂停</option><option value="canceled">已取消</option>
      </select>
      <button type="button" className="btn ghost" disabled={instancesLoading} onClick={() => void refreshInstances(0)}>搜索</button>
    </div>
    {error !== '' && <div style={{ color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
    {instances.length === 0 ? <div style={{ color: 'var(--muted-2)' }}>{instancesLoading ? '正在读取…' : '该空间还没有创建跨 Agent 工作流实例。'}</div> : <div style={{ display: 'grid', gap: 6 }}>
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
      <button type="button" className="btn ghost" disabled={instancesLoading || instanceOffset <= 0} onClick={() => void refreshInstances(Math.max(0, instanceOffset - 20))}>上一页</button>
      <button type="button" className="btn ghost" disabled={instancesLoading || instanceOffset + instances.length >= instanceTotal} onClick={() => void refreshInstances(instanceOffset + 20)}>下一页</button>
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
  </div>
}

function workflowStatusLabel(status: string): string {
  return ({ active: '进行中', done: '已完成', paused: '已暂停', canceled: '已取消' } as Record<string, string>)[status] ?? status
}


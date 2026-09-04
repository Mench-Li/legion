import { useState } from 'react'
import type { CardStatus, Mission } from '../types'
import { TaskDetailModal } from './TaskDetailModal'

interface MissionPanelProps {
  missions: Mission[]
  scopeAware: boolean
  scope: string | null
  hubMode: boolean
  /** 任务详情里状态变更后通知刷新任务集。 */
  onDataChanged?: () => void
}

/** 单任务展示排序：进行中 → 待验收 → 受阻 → 待认领/待批准 → 已完成（组内按 id 稳定排序）。 */
const TASK_RANK: Record<CardStatus, number> = {
  in_progress: 0,
  in_review: 1,
  blocked: 2,
  todo: 3,
  backlog: 4,
  done: 5,
  canceled: 6,
}

function byStatus<T extends { status: CardStatus; id: string }>(a: T, b: T): number {
  return (TASK_RANK[a.status] ?? 9) - (TASK_RANK[b.status] ?? 9) || a.id.localeCompare(b.id, undefined, { numeric: true })
}

const STATUS_TEXT: Record<Mission['status'], string> = {
  running: '运行中',
  waiting: '等待中',
  blocked: '受阻',
  done: '已完成',
}

/** 单个任务的真实状态（区分「是否进行中」）。 */
const TASK_STATUS_TEXT: Record<CardStatus, string> = {
  backlog: '待批准',
  todo: '待认领',
  in_progress: '进行中',
  in_review: '待验收',
  blocked: '受阻',
  done: '已完成',
  canceled: '已取消',
}

/** 单个任务状态点颜色：绿=进行中，黄=待验收/待认领，红=受阻，灰=完成/取消。 */
const TASK_DOT: Record<CardStatus, string> = {
  in_progress: 'var(--green)',
  in_review: 'var(--yellow)',
  todo: 'var(--yellow)',
  backlog: 'var(--muted-2)',
  blocked: 'var(--red)',
  done: 'var(--muted-2)',
  canceled: 'var(--muted-2)',
}

export function MissionPanel({ missions, scopeAware, scope, hubMode, onDataChanged }: MissionPanelProps): React.JSX.Element {
  const [detailId, setDetailId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const active = missions.filter(m => m.status !== 'done')
  const activeCount = active.reduce((n, m) => n + m.inProgress + m.inReview, 0)
  const toggle = (role: string): void => setExpanded(prev => ({ ...prev, [role]: !prev[role] }))
  return (
    <div className="panel">
      <div className="panel-title">
        当前任务集
        <span className="badge">{active.length} 运行</span>
        {activeCount > 0 && <span className="badge" style={{ background: 'rgba(57,211,150,.15)', color: 'var(--green)' }}>{activeCount} 进行中</span>}
      </div>
      {scopeAware && hubMode && (
        <div style={{ padding: '8px 14px', fontSize: 10.5, color: 'var(--green)' }}>
          🟢 中枢 team-hub v2 · 真分区{scope ? `：仅「${scope}」空间任务` : '：全部空间'}
        </div>
      )}
      {!scopeAware && scope && (
        <div style={{ padding: '8px 14px', fontSize: 10.5, color: 'var(--yellow)' }}>
          ⓘ 空间「{scope}」：v1 文件模式无 scope 分区，显示全部任务（接入 team-hub v2 后启用真分区）
        </div>
      )}
      {missions.length === 0 && (
        <div style={{ padding: 14, color: 'var(--muted-2)', fontSize: 12 }}>暂无任务集（发布 goal 后自动生成）</div>
      )}
      {missions.map(m => (
        <div key={m.role} className="mission">
          <div className="mission-head">
            <span className="mission-name">{m.name}</span>
            <span className={`status-pill ${m.status}`}>{STATUS_TEXT[m.status]}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{m.percent}%</span>
          </div>
          <div className={`mission-bar${m.status === 'blocked' ? ' blocked' : ''}`}>
            <i style={{ width: `${m.percent}%` }} />
          </div>
          <div className="mission-meta">
            <span>
              {m.inProgress > 0 && `进行中 ${m.inProgress} · `}
              {m.inReview > 0 && `待验收 ${m.inReview} · `}
              {m.blocked > 0 && `受阻 ${m.blocked} · `}
              {m.waiting > 0 && `待命 ${m.waiting} · `}
              完成 {m.done}/{m.total}
            </span>
            <span>{m.role}</span>
          </div>
          {m.tasks.length > 0 && (() => {
            const sorted = [...m.tasks].sort(byStatus)
            const isOpen = !!expanded[m.role]
            const openCount = sorted.filter(t => t.status !== 'done' && t.status !== 'canceled').length
            return (
              <div className="mission-tasks">
                {!isOpen && sorted.slice(0, 3).map(t => (
                  <div key={t.id} className="mission-task clickable" onClick={() => setDetailId(t.id)} title={`查看 ${t.id} 详情 / AI 执行过程`}>
                    <span className="st-dot" style={{ background: TASK_DOT[t.status] }} title={TASK_STATUS_TEXT[t.status]} />
                    <span className="tid">{t.id}</span>
                    <span className="t">{t.title}</span>
                    <span className={`t-status ${t.status}`}>{TASK_STATUS_TEXT[t.status]}</span>
                  </div>
                ))}
                {m.tasks.length > 3 && (
                  <div
                    className="mission-more clickable"
                    onClick={() => toggle(m.role)}
                    title={isOpen ? '收起任务列表' : `查看该岗位全部 ${m.tasks.length} 个任务`}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', fontSize: 10.5, color: 'var(--accent, #6ea8fe)', userSelect: 'none' }}
                  >
                    <span>{isOpen ? '▴ 收起' : `▾ 展开全部 ${m.tasks.length} 个任务`}</span>
                    <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>（{openCount} 未完成）</span>
                  </div>
                )}
                {isOpen && (
                  <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 2 }}>
                    {sorted.map(t => (
                      <div key={t.id} className="mission-task clickable" onClick={() => setDetailId(t.id)} title={`查看 ${t.id} 详情 / AI 执行过程`}>
                        <span className="st-dot" style={{ background: TASK_DOT[t.status] }} title={TASK_STATUS_TEXT[t.status]} />
                        <span className="tid">{t.id}</span>
                        <span className="t">{t.title}</span>
                        <span className={`t-status ${t.status}`}>{TASK_STATUS_TEXT[t.status]}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      ))}
      {detailId && (
        <TaskDetailModal
          taskId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={onDataChanged}
        />
      )}
    </div>
  )
}

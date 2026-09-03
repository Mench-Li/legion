import { useEffect, useState } from 'react'
import { fetchAgentModels, fetchHubTasks, MODEL_OPTIONS } from '../api'
import type { CardStatus, HubTask, RosterAgent } from '../types'

interface AgentTasksModalProps {
  agent: RosterAgent
  onClose: () => void
  /** 点任务 → 由父级打开统一任务详情（返回后父级可重新打开本列表）。 */
  onOpenTask: (id: string) => void
}

const STATUS_GROUP: { key: string; label: string; statuses: CardStatus[] }[] = [
  { key: 'active', label: '🟢 运行中 / 进行中', statuses: ['in_progress', 'in_review', 'blocked'] },
  { key: 'todo', label: '⚪ 待办（待认领/待批准）', statuses: ['todo', 'backlog'] },
  { key: 'done', label: '✅ 已完成', statuses: ['done'] },
]

const TASK_STATUS_TEXT: Record<string, string> = {
  backlog: '待批准', todo: '待认领', in_progress: '进行中', in_review: '待验收', blocked: '受阻', done: '已完成', canceled: '已取消',
}

/** 士兵 ❓ 提问待将军确认：最后一条评论以 ❓ 开头（守护标记待答复），将军答复后消失。 */
function askOpen(t: HubTask): boolean {
  const cs = t.comments ?? []
  if (cs.length === 0) return false
  return (cs[cs.length - 1].text ?? '').startsWith('❓')
}

export function AgentTasksModal({ agent, onClose, onOpenTask }: AgentTasksModalProps): React.JSX.Element {
  const [tasks, setTasks] = useState<HubTask[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [modelLabel, setModelLabel] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const all = await fetchHubTasks(agent.scope ?? null)
        if (cancelled) return
        const mine = all.filter(
          t => t.status !== 'canceled' && ((t.soldier !== null && t.soldier === agent.role) || (t.soldier === null && t.role === agent.role)),
        )
        setTasks(mine)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.role, agent.scope])

  // 该角色的默认模型（配置了才显示）
  useEffect(() => {
    let cancelled = false
    void fetchAgentModels(agent.scope ?? null)
      .then(rows => {
        if (cancelled) return
        const hit = rows.find(r => r.role === agent.role)
        if (hit) {
          const opt = MODEL_OPTIONS.find(o => o.provider === hit.provider && o.model === hit.model)
          setModelLabel(opt ? opt.name : `${hit.provider}/${hit.model}`)
        }
      })
      .catch(() => undefined)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.role, agent.scope])

  // 拉取完成前先用 roster 实时投影兜底展示
  const quick: HubTask[] = (agent.tasks ?? []).map(t => ({
    id: t.id,
    title: t.title,
    description: '',
    acceptance: [],
    priority: 'medium',
    status: t.status,
    version: 1,
    soldier: agent.role,
    role: agent.role,
    scope: agent.scope,
    blocks: [],
    blockedBy: [],
    comments: [],
    evidence: [],
    patches: [],
  }))
  const shown: HubTask[] = tasks ?? quick

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal agent-tasks-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="agent-avatar" style={{ fontSize: 16 }}>{agent.avatar}</span>
          {agent.name} · 任务清单
          {modelLabel && (
            <span className="agent-model-badge" title="该智能体默认模型（⚙️ 模型配置可改）">⚙️ {modelLabel}</span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted-2)' }}>{agent.scope ?? ''} / {agent.role}</span>
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="agent-chips" style={{ marginBottom: 8 }}>
            {agent.chips.map((c, idx) => (
              <span key={idx} className={c.cls ? `chip ${c.cls}` : 'chip'}>{c.label}</span>
            ))}
          </div>
          {err && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>读取失败：{err}（当前显示编队投影数据）</div>}
          {shown.length === 0 && (
            <div style={{ color: 'var(--muted-2)', fontSize: 12, padding: '10px 0' }}>
              该智能体当前没有任务（发布目标后可自动为其分派阶段任务）。
            </div>
          )}
          {STATUS_GROUP.map(g => {
            const list = shown.filter(t => g.statuses.includes(t.status))
            if (list.length === 0) return null
            return (
              <div key={g.key} className="sched-group">
                <h5>{g.label} <span style={{ color: 'var(--muted-2)' }}>({list.length})</span></h5>
                {list.map(t => (
                  <div key={t.id} className="hub-card clickable" onClick={() => onOpenTask(t.id)} title={`查看 ${t.id} 详情 / AI 执行过程`}>
                    <div className="hub-head" style={{ cursor: 'pointer' }}>
                      <div className="t">
                        <div className="task-line">
                          <span className="tid">{t.id}</span>
                          <span className="tt">{t.title}</span>
                        </div>
                        <div className="meta">
                          {askOpen(t) ? '❓ 待将军确认' : (TASK_STATUS_TEXT[t.status] ?? t.status)} · v{t.version}
                          {t.blockedBy.length > 0 ? ` · 依赖 ${t.blockedBy.join(',')}` : ''}
                        </div>
                      </div>
                      <span className="detail-arrow">›</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
          <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 10, lineHeight: 1.6 }}>
            💡 点任务查看详情与 AI 执行过程；发布目标时该智能体会自动分到对应阶段任务。
          </div>
        </div>
      </div>
    </div>
  )
}

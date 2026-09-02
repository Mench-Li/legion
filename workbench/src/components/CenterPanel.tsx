import { lazy, Suspense, useState } from 'react'
import type { BoardData, CardStatus, GoalInfo, RosterAgent, SpaceInfo } from '../types'
import type { StatusCard } from '../missions'
import type { AgentPose } from './Scene3D'
import { AgentTasksModal } from './AgentTasksModal'
import { TaskDetailModal } from './TaskDetailModal'

const Scene3D = lazy(() => import('./Scene3D'))

interface AgentView {
  role: string
  name: string
  avatar: string
  mode: 'busy' | 'review' | 'blocked' | 'idle'
  chips: Array<{ label: string; cls: string }>
  tasks: Array<{ id: string; title: string; status: CardStatus }>
}

const AVATARS = ['🦊', '🐺', '🦉', '🐻', '🦅', '🐯', '🐸', '🐼']

function statusClass(status: CardStatus): string {
  return `st-dot st-${status}`
}

function agentViews(board: BoardData, labels: Record<string, string>): AgentView[] {
  const byRole = new Map<string, StatusCard[]>()
  for (const col of board.columns) {
    for (const card of col.cards) {
      const role = card.soldier ?? 'unassigned'
      const arr = byRole.get(role) ?? []
      arr.push({ card, status: col.id })
      byRole.set(role, arr)
    }
  }
  let i = 0
  return [...byRole.entries()].map(([role, tasks]) => {
    const active = tasks.filter(t => t.status !== 'done' && t.status !== 'canceled')
    const inProgress = tasks.filter(t => t.status === 'in_progress').length
    const inReview = tasks.filter(t => t.status === 'in_review').length
    const blocked = tasks.filter(t => t.status === 'blocked').length
    const mode: AgentView['mode'] = blocked > 0 ? 'blocked' : inReview > 0 ? 'review' : inProgress > 0 ? 'busy' : 'idle'
    const chips: Array<{ label: string; cls: string }> = []
    if (inProgress > 0) chips.push({ label: `进行中 ${inProgress}`, cls: 'chip green' })
    if (inReview > 0) chips.push({ label: `待验收 ${inReview}`, cls: 'chip yellow' })
    if (blocked > 0) chips.push({ label: `受阻 ${blocked}`, cls: 'chip red' })
    if (chips.length === 0) chips.push({ label: '待命', cls: 'chip' })
    const avatar = AVATARS[i % AVATARS.length]
    i += 1
    return { role, name: labels[role] ?? role, avatar, mode, chips, tasks: active.slice(0, 4).map(sc => ({ id: sc.card.id, title: sc.card.title, status: sc.status })) }
  })
}

interface CenterPanelProps {
  board: BoardData
  labels: Record<string, string>
  active: string
  /** 中枢模式下：当前空间专属编队（team-hub /api/roster）；null = v1 回退看板聚合 */
  rosterAgents?: RosterAgent[] | null
  scope?: string | null
  /** 工作空间列表（「全部空间」按空间分组标题用）。 */
  spaces?: SpaceInfo[]
  /** 中枢模式：当前空间目标（team-hub /api/goal）；null = 用 board.goal（v1）。 */
  goalInfo?: GoalInfo | null
}

/** 编队（服务端形状）→ 面板 AgentView。chips.cls 由服务端给 'green'/'yellow'/'red'/''，补 'chip' 前缀。 */
function fromRoster(a: RosterAgent): AgentView {
  return {
    role: a.role,
    name: a.name,
    avatar: a.avatar,
    mode: a.mode,
    chips: a.chips.map(c => ({ label: c.label, cls: c.cls ? `chip ${c.cls}` : 'chip' })),
    tasks: a.tasks,
  }
}

export function CenterPanel({ board, labels, active, rosterAgents, scope, spaces, goalInfo }: CenterPanelProps): React.JSX.Element {
  const isRoster = rosterAgents !== null && rosterAgents !== undefined
  // 中核对当前空间的兜底过滤：只保留属于本空间的智能体（杜绝「全部空间」数据泄漏/窜台）
  const currentRoster = scope
    ? (rosterAgents ?? []).filter(a => !a.scope || a.scope === scope)
    : (rosterAgents ?? [])
  // 中枢「全部空间」：显示全部分区（按空间分组），不把所有人堆进 3D
  const allMode = isRoster && !scope
  // 中枢模式：智能体 = 该空间专属编队（每空间不同职业）；v1：从看板聚合
  const agents = currentRoster.length > 0 ? currentRoster.map(fromRoster) : (isRoster ? [] : agentViews(board, labels))
  const goal = board.goal
  const poses: AgentPose[] = agents.map(a => ({
    id: a.role,
    name: a.name,
    mode: a.mode,
    tasks: a.tasks.length,
    avatar: a.avatar,
  }))
  // 「全部空间」按空间分组（用 roster 原始 scope 字段）
  const groups = allMode
    ? (() => {
        const m = new Map<string, RosterAgent[]>()
        for (const a of rosterAgents ?? []) {
          const key = a.scope ?? 'default'
          const arr = m.get(key) ?? []
          arr.push(a)
          m.set(key, arr)
        }
        return [...m.entries()]
      })()
    : []
  const spaceName = (id: string): string => spaces?.find(s => s.id === id)?.name ?? id

  // 点击智能体查看其任务（进行中/待办/待验收/完成），任务可再点进详情
  const [agentView, setAgentView] = useState<RosterAgent | null>(null)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const rosterById = new Map((rosterAgents ?? []).map(a => [a.role, a]))
  const openAgent = (role: string): void => {
    const hit = rosterById.get(role)
    if (hit) setAgentView(hit)
  }
  const openTaskFromAgent = (id: string): void => {
    setAgentView(null)
    setDetailTaskId(id)
  }

  return (
    <div className="center-col">
      <div className="panel goal-card">
        <div className="obj">
          <span className="tag">🎯 当前目标</span>
          {goalInfo
            ? (goalInfo.objective ?? `未发布目标（${scope ?? '该空间'}）· 点底部「发布目标」`)
            : goal.objective === '（未填写目标）' ? '未发布目标（用 taskctl goal 发布）' : goal.objective}
        </div>
        <div className="goal-bar-wrap">
          <div className="goal-bar">
            <i style={{ width: `${goalInfo ? goalInfo.percent : goal.progress.percent}%` }} />
          </div>
          <div className="goal-bar-meta">
            <span>
              {goalInfo ? `${goalInfo.done}/${goalInfo.total} 完成` : `${goal.progress.done}/${goal.progress.total} 完成`}
            </span>
            <span>{goalInfo ? goalInfo.percent : goal.progress.percent}%</span>
          </div>
        </div>
      </div>

      {active === 'agents' ? (
        <div className="panel" style={{ padding: 12, overflow: 'auto' }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 10 }}>
            🤖 智能体状态总览{isRoster ? ` · ${scope ?? '全部空间'} 专属编队` : ''}
            <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--muted-2)', fontWeight: 400 }}>
              {isRoster ? '来自 team-hub 编队（每空间不同职业）' : '状态来自看板实时投影'}
            </span>
          </div>
          <div className="agents-grid">
            {allMode
              ? groups.map(([gid, list]) => (
                  <div key={gid} className="agent-group">
                    <div className="agent-group-title">🗂 {spaceName(gid)} · {list.length} 岗</div>
                    {list.map(a => (
                      <div key={a.role} className={`panel agent-card ${a.mode} clickable`} onClick={() => openAgent(a.role)} title={`查看 ${a.name} 的任务`}>
                        <div className="agent-head">
                          <div className="agent-avatar">{a.avatar}</div>
                          <div>
                            <div className="agent-name">{a.name}</div>
                            <div className="agent-role">{a.role}</div>
                          </div>
                        </div>
                        <div className="agent-chips">
                          {a.chips.map((c, idx) => (
                            <span key={idx} className={c.cls ? `chip ${c.cls}` : 'chip'}>
                              {c.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              : agents.map(a => (
                  <div key={a.role} className={`panel agent-card ${a.mode} clickable`} onClick={() => openAgent(a.role)} title={`查看 ${a.name} 的任务（进行中/待办/完成）`}>
                    <div className="agent-head">
                      <div className="agent-avatar">{a.avatar}</div>
                      <div>
                        <div className="agent-name">{a.name}</div>
                        <div className="agent-role">{a.role}</div>
                      </div>
                    </div>
                    <div className="agent-chips">
                      {a.chips.map((c, idx) => (
                        <span key={idx} className={c.cls}>
                          {c.label}
                        </span>
                      ))}
                    </div>
                    {a.tasks.length > 0 && (
                      <div className="agent-tasks">
                        {a.tasks.map(t => (
                          <div key={t.id} className="agent-task">
                            <span className={statusClass(t.status)} />
                            <span>
                              {t.id} · {t.title}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            {agents.length === 0 && <div style={{ color: 'var(--muted-2)', fontSize: 12 }}>暂无智能体任务</div>}
          </div>
        </div>
      ) : allMode ? (
        <div className="scene-3d">
          <div className="scene-legend">
            <span className="legend-title">⚔ 全部空间 · 按分区查看编队</span>
            <span className="legend-hint">🖱 左侧选择具体工作空间，查看该空间的专属智能体编队</span>
          </div>
          <div className="scene-all-hint">
            <div className="scene-all-icon">🛰</div>
            <div className="scene-all-text">
              <b>当前在「全部空间」视图</b>
              <span>已收录 {groups.length} 个分区、{(rosterAgents ?? []).length} 名智能体。选择左侧任一工作空间即可看到它的专属编队（3D 场景 / 智能体总览）。</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="scene-3d">
          <div className="scene-legend">
            <span className="legend-title">⚔ {scope ?? '全局'}编队{isRoster ? ` · ${agents.length} 岗` : ''}</span>
            <span>
              <i className="dot busy" />
              进行中
            </span>
            <span>
              <i className="dot review" />
              待验收
            </span>
            <span>
              <i className="dot blocked" />
              受阻
            </span>
            <span>
              <i className="dot idle" />
              待命
            </span>
            <span className="legend-hint">🖱 拖动旋转 · 滚轮缩放 · 状态实时投影</span>
          </div>
          <Suspense fallback={<div className="scene-loading">⏳ 正在构建 3D 办公场景…</div>}>
            <Scene3D
              key={scope ?? 'all'}
              agents={poses}
              goalPercent={goal.progress.percent}
              onAgentClick={isRoster ? openAgent : undefined}
            />
          </Suspense>
        </div>
      )}
      {agentView && (
        <AgentTasksModal
          agent={agentView}
          onClose={() => setAgentView(null)}
          onOpenTask={openTaskFromAgent}
        />
      )}
      {detailTaskId && (
        <TaskDetailModal taskId={detailTaskId} onClose={() => setDetailTaskId(null)} />
      )}
    </div>
  )
}

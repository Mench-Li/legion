import { lazy, Suspense, useEffect, useState } from 'react'
import type { BoardData, CardStatus, GoalInfo, GoalStatus, HubActivity, HubGoal, RosterAgent, SpaceInfo } from '../types'
import type { StatusCard } from '../missions'
import type { AgentPose } from './Scene3D'
import { AgentTasksModal } from './AgentTasksModal'
import { TaskDetailModal } from './TaskDetailModal'
import { fetchHubActivity } from '../api'

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
  /** 中枢模式：当前空间全部目标（多目标：每目标带 status/version + 链进度）；null = 用 board.goal（v1）。 */
  goalInfo?: GoalInfo | null
  /** 中枢模式开关：开启时目标进度一律取 hub goal，禁止回退到 v1 board.goal 造成数字串台。 */
  hubActive?: boolean
  /** 目标状态迁移（暂停/恢复/取消；仅将军）。 */
  onGoalStatus?: (goalId: string, status: GoalStatus, label: string) => Promise<void>
  /** 保存目标上下文（仅将军；更新 bump contextVersion，守护下一派工对齐）。 */
  onSaveContext?: (goalId: string, text: string) => Promise<void>
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

const GOAL_STATUS_TEXT: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  canceled: '已取消',
}

/** 目标事件动作 → 短标签（per-goal 活动流渲染用；其余动作原样显示 action）。 */
const GOAL_ACT_TEXT: Record<string, string> = {
  'goal:publish': '🎯 目标发布',
  'goal:slices': '🔪 目标拆解',
  'goal:pause': '⏸ 目标暂停',
  'goal:resume': '▶ 目标恢复',
  'goal:done': '✅ 目标收尾',
  'goal:cancel': '✕ 目标取消',
  'goal:context': '📄 上下文更新',
  claim: '🟢 认领',
  'transition': '↔ 流转',
  advance: '✅ 完成推进',
  'test-report': '🧪 测试报告',
  'domain-block': '⛔ 文件域拦截',
  artifact: '📦 产物',
  patch: '🩹 代码提交',
  dispatch: '🚀 派工',
  aborted: '⚠ 中断',
  comment: '💬 评论',
}

function fmtGoalTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function GoalRow({ goal, busy, onPause, onResume, onCancel, onSaveContext }: {
  goal: HubGoal
  busy: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  /** 保存目标上下文（仅将军）；缺省 = 该角色不可编辑。 */
  onSaveContext?: (goalId: string, text: string) => Promise<void>
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.context)
  const [saving, setSaving] = useState(false)
  const [activity, setActivity] = useState<HubActivity[] | null>(null)
  const canAct = goal.status === 'active' || goal.status === 'paused'
  const canEdit = canAct && onSaveContext !== undefined
  const terminal = goal.status === 'done' || goal.status === 'canceled'
  // 展开目标行时按目标拉最近活动（C：将军 per-goal 视图，/api/activity?goalId=）
  useEffect(() => {
    if (!expanded) return
    let alive = true
    setActivity(null)
    fetchHubActivity({ goalId: goal.id, limit: 8 })
      .then(rows => { if (alive) setActivity(rows) })
      .catch(() => { if (alive) setActivity([]) })
    return () => { alive = false }
  }, [expanded, goal.id, goal.contextVersion])
  const save = async (): Promise<void> => {
    if (!onSaveContext) return
    setSaving(true)
    try {
      await onSaveContext(goal.id, draft.trim())
      setEditing(false)
      setDraft(draft.trim())
    } finally {
      setSaving(false)
    }
  }
  const startEdit = (): void => {
    setDraft(goal.context ?? '')
    setEditing(true)
  }
  return (
    <div className="goal-row-wrap">
      <div className="goal-row" role="button" tabIndex={0} onClick={() => setExpanded(x => !x)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(x => !x) } }} title="点击展开：目标上下文（同目标共享）与最近动态">
        <span className={`g-dot ${goal.status}`} title={GOAL_STATUS_TEXT[goal.status]} />
        <span className="obj" title={`${goal.objective}（${goal.id}）`}>
          {goal.objective}
        </span>
        <span className="goal-meta">
          <span className={`goal-status ${goal.status}`}>{GOAL_STATUS_TEXT[goal.status]}</span>
          <span className="goal-ver" title="目标乐观锁版本">v{goal.version}</span>
          <span className={`goal-ver ctx${goal.contextVersion > 0 ? ' has' : ''}`} title={`目标级共享上下文（版本 v${goal.contextVersion}；同目标任务派工共享，下一派工对齐）`}>
            {goal.contextVersion > 0 ? `📄ctx v${goal.contextVersion}` : '📄ctx'}
          </span>
          {goal.mode === 'slice' && <span className="goal-ver slice" title="切片流水线模式">切片</span>}
          <span className="goal-progress" title={`${goal.done}/${goal.total} 链任务完成`}>
            {goal.done}/{goal.total} · {goal.percent}%
          </span>
        </span>
        {canAct && (
          <span className="goal-actions" onClick={e => e.stopPropagation()}>
            {goal.status === 'active' && (
              <button className="btn icon ghost" disabled={busy} title="暂停该目标（链任务保留，暂停推进）" onClick={onPause}>⏸</button>
            )}
            {goal.status === 'paused' && (
              <button className="btn icon ghost" disabled={busy} title="恢复该目标推进" onClick={onResume}>▶</button>
            )}
            <button
              className={`btn icon ghost danger ${confirming ? 'confirming' : ''}`}
              disabled={busy}
              title="取消该目标（未开工的链任务一并取消）"
              onClick={() => { if (confirming) onCancel(); else setConfirming(true) }}
            >
              {confirming ? '✓确认取消' : '✕'}
            </button>
            {confirming && (
              <button className="btn icon ghost" disabled={busy} title="不取消了" onClick={() => setConfirming(false)}>↩</button>
            )}
          </span>
        )}
        <span className="goal-expand" title={expanded ? '收起' : '展开上下文/动态'}>{expanded ? '▾' : '▸'}</span>
      </div>
      <div className="goal-minibar" onClick={e => e.stopPropagation()}>
        <i style={{ width: `${goal.percent}%` }} />
      </div>
      {expanded && (
        <div className="goal-detail" onClick={e => e.stopPropagation()}>
          <div className="goal-ctx-head">
            <span className="goal-ctx-title">📄 目标上下文 <span className="goal-ver">v{goal.contextVersion}</span></span>
            <span className="goal-ctx-hint">
              {terminal
                ? '（目标已结束，上下文只读）'
                : '同目标所有衍生任务派工时共享此上下文；保存后「下一派工」按新版本对齐，正在执行的任务不打断。'}
            </span>
            {canEdit && !editing && (
              <button className="btn icon ghost" disabled={busy} title="编辑目标上下文（写 docs/goals/ 镜像只读副本由守护维护）" onClick={startEdit}>✏️ 编辑</button>
            )}
            {editing && (
              <>
                <button className="btn icon ghost" disabled={saving} title="保存并 bump 版本" onClick={() => void save()}>💾 保存</button>
                <button className="btn icon ghost" disabled={saving} title="放弃修改" onClick={() => setEditing(false)}>↩ 放弃</button>
              </>
            )}
          </div>
          {editing ? (
            <textarea
              className="goal-ctx-edit"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="写目标级共享上下文（markdown）：约束、口径、文件域地图、验收要点…任何同目标任务都应遵守的全局约定。留空 = 该目标暂无共享上下文。"
              rows={5}
            />
          ) : (
            <pre className="goal-ctx-body">
              {goal.context && goal.context.trim() !== ''
                ? goal.context
                : '（未填写目标上下文——派工仅携带各自任务描述；在此填写后，同目标并行任务即可共享统一口径，避免窜台。）'}
            </pre>
          )}
          <div className="goal-act-head">📜 本目标最近动态</div>
          <div className="goal-act-list">
            {activity === null && <div className="goal-act-empty">读取中…</div>}
            {activity !== null && activity.length === 0 && <div className="goal-act-empty">暂无本目标动态</div>}
            {activity !== null && activity.map(row => (
              <div key={row.seq} className="goal-act-row">
                <span className="goal-act-time">{fmtGoalTime(row.ts)}</span>
                <span className="goal-act-action">{GOAL_ACT_TEXT[row.action] ?? row.action}</span>
                <span className="goal-act-who">{row.member}</span>
                <span className="goal-act-txt">
                  {row.taskId ? `[${row.taskId}] ` : ''}
                  {typeof row.detail === 'object' && row.detail !== null && 'summary' in row.detail
                    ? String((row.detail as { summary?: unknown }).summary ?? row.detail)
                    : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function CenterPanel({ board, labels, active, rosterAgents, scope, spaces, goalInfo, hubActive = false, onGoalStatus, onSaveContext }: CenterPanelProps): React.JSX.Element {
  const isRoster = rosterAgents !== null && rosterAgents !== undefined
  // 多目标：进度 = 该空间未取消目标的任务合计（各目标各自链独立统计后加总）；未就绪显示占位，绝不回退 v1 board.goal
  const hubGoals = hubActive && goalInfo ? goalInfo.goals : []
  const countedGoals = hubGoals.filter(g => g.status !== 'canceled')
  const aggDone = countedGoals.reduce((a, g) => a + g.done, 0)
  const aggTotal = countedGoals.reduce((a, g) => a + g.total, 0)
  const aggPct = aggTotal > 0 ? Math.round((aggDone / aggTotal) * 100) : null
  const [busyGoal, setBusyGoal] = useState<string | null>(null)
  const goalStatus = (g: HubGoal, status: GoalStatus): void => {
    if (!onGoalStatus) return
    setBusyGoal(g.id)
    const label = status === 'paused' ? '⏸ 已暂停' : status === 'active' ? '▶ 已恢复' : status === 'canceled' ? '✕ 已取消' : '✅ 已收尾'
    void onGoalStatus(g.id, status, label).finally(() => setBusyGoal(null))
  }
  // 中核对当前空间的兜底过滤：只保留属于本空间的智能体（杜绝「全部空间」数据泄漏/窜台）
  const currentRoster = scope
    ? (rosterAgents ?? []).filter(a => !a.scope || a.scope === scope)
    : (rosterAgents ?? [])
  // 中枢「全部空间」：显示全部分区（按空间分组），不把所有人堆进 3D
  const allMode = isRoster && !scope
  // 中枢模式：智能体 = 该空间专属编队（每空间不同职业）；v1：从看板聚合
  const agents = currentRoster.length > 0 ? currentRoster.map(fromRoster) : (isRoster ? [] : agentViews(board, labels))
  const v1Goal = board.goal
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
      {hubActive ? (
        <div className="panel goal-card goals-card">
          <div className="goals-head">
            <span className="tag">🎯 目标{hubGoals.length > 0 ? `（${hubGoals.length} 个）` : ''}</span>
            {countedGoals.length > 0 && (
              <span className="goal-agg">
                <span className="goal-bar-wrap">
                  <span className="goal-bar">
                    <i style={{ width: `${aggPct ?? 0}%` }} />
                  </span>
                  <span className="goal-bar-meta">
                    <span>未取消目标合计 {aggDone}/{aggTotal} 完成</span>
                    <span>{aggPct === null ? '--' : `${aggPct}%`}</span>
                  </span>
                </span>
              </span>
            )}
            <span className="goals-hint">多个目标可并存推进，互不取消</span>
          </div>
          {hubGoals.length === 0 ? (
            <div className="obj empty">
              {hubActive && goalInfo === null
                ? '读取目标中…'
                : `尚未发布目标（${scope ?? '该空间'}）· 点底部「🎯 发布目标」新增，可同时发布多个目标并发推进`}
            </div>
          ) : (
            <div className="goals-list">
              {hubGoals.map(g => (
                <GoalRow
                  key={g.id}
                  goal={g}
                  busy={busyGoal === g.id}
                  onPause={() => goalStatus(g, 'paused')}
                  onResume={() => goalStatus(g, 'active')}
                  onCancel={() => goalStatus(g, 'canceled')}
                  onSaveContext={onSaveContext}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="panel goal-card">
          <div className="obj">
            <span className="tag">🎯 当前目标</span>
            {v1Goal.objective === '（未填写目标）' ? '未发布目标（用 taskctl goal 发布）' : v1Goal.objective}
          </div>
          <div className="goal-bar-wrap">
            <div className="goal-bar">
              <i style={{ width: `${v1Goal.progress.percent ?? 0}%` }} />
            </div>
            <div className="goal-bar-meta">
              <span>{v1Goal.progress.done}/{v1Goal.progress.total} 完成</span>
              <span>{v1Goal.progress.percent}%</span>
            </div>
          </div>
        </div>
      )}

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
              goalPercent={hubActive ? (aggPct ?? 0) : v1Goal.progress.percent}
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

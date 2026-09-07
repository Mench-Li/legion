/**
 * 目标看板（每空间目标管理，多目标并发）：
 *  - 横向卡片滑动：目标按状态分组（进行中/已暂停/已完成/已取消），每组一条横向滑动轨道；
 *  - 筛选：顶部按状态过滤（只显示某一状态轨道），已结束目标默认收纳在「已收尾/已取消」折叠区；
 *  - 详情：点卡片进入目标详情（弹层），含 目标上下文（查看/编辑）+ 本目标最近动态 + 链任务；
 *  - 穿透：详情里链任务同样按任务状态分组，点任务穿透到 TaskDetailModal（由上层渲染）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { CardStatus, GoalStatus, HubActivity, HubGoal, HubTask } from '../types'
import { fetchHubActivity, fetchHubTasks } from '../api'

export const GOAL_STATUS_TEXT: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  canceled: '已取消',
}

const GOAL_ORDER: GoalStatus[] = ['active', 'paused', 'done', 'canceled']

/** 目标建链模式短标签。 */
const MODE_TEXT: Record<string, string> = { slice: '切片流水线', chain: '阶段链' }

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
  transition: '↔ 流转',
  advance: '✅ 完成推进',
  'test-report': '🧪 测试报告',
  'domain-block': '⛔ 文件域拦截',
  artifact: '📦 产物',
  patch: '🩹 代码提交',
  dispatch: '🚀 派工',
  aborted: '⚠ 中断',
  comment: '💬 评论',
}

/** 链任务分组（详情内「任务穿透按状态划分」）：每组一个有序任务状态列表。 */
const TASK_GROUPS: Array<{ key: string; label: string; statuses: CardStatus[] }> = [
  { key: 'todo', label: '📋 待办', statuses: ['backlog', 'todo'] },
  { key: 'in_progress', label: '🟢 进行中', statuses: ['in_progress'] },
  { key: 'in_review', label: '🟡 待验收', statuses: ['in_review'] },
  { key: 'blocked', label: '⛔ 受阻', statuses: ['blocked'] },
  { key: 'done', label: '✅ 已完成', statuses: ['done'] },
  { key: 'canceled', label: '✕ 已取消', statuses: ['canceled'] },
]

const ROLE_SHORT: Record<string, string> = {
  requirement: '需求', researcher: '方案', breaker: '拆解', 'test-designer': '测试设计',
  coder: '编码', reviewer: '审查', tester: '测试', devops: '部署',
}

function fmtClock(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDay(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function roleShort(role?: string | null): string {
  if (!role) return ''
  return ROLE_SHORT[role] ?? role
}

interface GoalsBoardProps {
  goals: HubGoal[]
  /** 当前空间 id（空态文案用）。 */
  scope?: string | null
  /** 目标状态迁移（暂停/恢复/取消；仅将军）。缺省 = 无操作权限（只读看板）。 */
  onGoalStatus?: (goalId: string, status: GoalStatus, label: string) => Promise<void>
  /** 保存目标上下文（仅将军）。缺省 = 该角色不可编辑。 */
  onSaveContext?: (goalId: string, text: string) => Promise<void>
  /** 点链任务 → 穿透到任务详情（由上层渲染 TaskDetailModal）。 */
  onOpenTask?: (taskId: string) => void
}

/** 单个目标横向滑动卡片。 */
function GoalTile({ goal, onOpen }: { goal: HubGoal; onOpen: (g: HubGoal) => void }): React.JSX.Element {
  const ctxHas = goal.contextVersion > 0
  return (
    <div className={`goal-tile gt-${goal.status} clickable`} role="button" tabIndex={0}
      onClick={() => onOpen(goal)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(goal) } }}
      title={`查看目标详情与链任务（${GOAL_STATUS_TEXT[goal.status]} · ${goal.done}/${goal.total} 完成）`}>
      <div className="gt-head">
        <span className="gt-status-label">{GOAL_STATUS_TEXT[goal.status]}</span>
      </div>
      <div className="gt-obj">{goal.objective}</div>
      <div className="gt-meta">
        <span className="gt-chip mono">{goal.id}</span>
        <span className="gt-chip" title="目标乐观锁版本">v{goal.version}</span>
        <span className={`gt-chip ctx${ctxHas ? ' has' : ''}`} title="目标级共享上下文版本">{ctxHas ? `📄ctx v${goal.contextVersion}` : '📄ctx'}</span>
        {goal.mode && <span className="gt-chip mode" title="建链模式">{MODE_TEXT[goal.mode] ?? goal.mode}</span>}
      </div>
      <div className="gt-prog">
        <div className="gt-bar"><i style={{ width: `${goal.percent}%` }} /></div>
        <div className="gt-bar-meta">
          <span>{goal.done}/{goal.total} 完成</span>
          <span>{goal.percent}%</span>
        </div>
      </div>
      {goal.updatedAt && <div className="gt-foot">更新 {fmtDay(goal.updatedAt)}</div>}
    </div>
  )
}

/** 一个状态的横向滑动轨道。 */
function GoalRail({ status, goals, onOpen }: { status: GoalStatus; goals: HubGoal[]; onOpen: (g: HubGoal) => void }): React.JSX.Element {
  return (
    <div className={`goal-rail gr-${status}`}>
      <div className="goal-rail-title">
        <span className={`g-dot ${status}`} />
        <span className="grt-name">{GOAL_STATUS_TEXT[status]}</span>
        <span className="grt-count">{goals.length}</span>
      </div>
      <div className="goal-rail-track">
        {goals.map(g => <GoalTile key={g.id} goal={g} onOpen={onOpen} />)}
      </div>
    </div>
  )
}

/** 详情弹层里的链任务分组列表（穿透 TaskDetailModal）。 */
function GoalTasks({ goal, onOpenTask }: { goal: HubGoal; onOpenTask?: (id: string) => void }): React.JSX.Element {
  const [tasks, setTasks] = useState<HubTask[] | null>(null)
  useEffect(() => {
    let alive = true
    setTasks(null)
    fetchHubTasks(goal.scope)
      .then(all => {
        if (!alive) return
        // 链任务按 goalId 归属该目标（老库回填过 goalId；slice/fix 也沿目标反查挂接）
        setTasks(all.filter(t => t.goalId === goal.id))
      })
      .catch(() => { if (alive) setTasks([]) })
    return () => { alive = false }
  }, [goal.id, goal.scope])
  if (tasks === null) return <div className="goal-act-empty">读取链任务中…</div>
  if (tasks.length === 0) return <div className="goal-act-empty">该目标暂无链任务（发布目标后自动生成，或任务未挂接此目标）。</div>
  const groups = TASK_GROUPS
    .map(g => ({ ...g, list: tasks.filter(t => g.statuses.includes(t.status)) }))
    .filter(g => g.list.length > 0)
  return (
    <div className="gd-task-groups">
      {groups.map(g => (
        <div key={g.key} className={`gd-task-group tg-${g.key}`}>
          <div className="gd-task-group-head">
            <span>{g.label}</span>
            <span className="grt-count">{g.list.length}</span>
          </div>
          <div className="gd-task-list">
            {g.list.map(t => (
              <div key={t.id} className={`gd-task clickable${onOpenTask ? '' : ' no-open'}`}
                role="button" tabIndex={0}
                onClick={() => { if (onOpenTask) onOpenTask(t.id) }}
                onKeyDown={e => { if (onOpenTask && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpenTask(t.id) } }}
                title={onOpenTask ? `打开任务 ${t.id} 详情` : t.title}>
                <span className="gd-task-id mono">{t.id}</span>
                <span className="gd-task-title">{t.title}</span>
                <span className="gd-task-who">{(t.soldier ?? roleShort(t.role)) || ''}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 目标详情弹层：上下文（查看/编辑）+ 最近动态 + 链任务（按状态分组，可穿透任务详情）。 */
function GoalDetailOverlay({ goal, onClose, onGoalStatus, onSaveContext, onOpenTask }: {
  goal: HubGoal
  onClose: () => void
  onGoalStatus?: (goalId: string, status: GoalStatus, label: string) => Promise<void>
  onSaveContext?: (goalId: string, text: string) => Promise<void>
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  const canAct = goal.status === 'active' || goal.status === 'paused'
  const canEdit = canAct && onSaveContext !== undefined
  const terminal = goal.status === 'done' || goal.status === 'canceled'
  const [busy, setBusy] = useState<GoalStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.context ?? '')
  const [saving, setSaving] = useState(false)
  const [activity, setActivity] = useState<HubActivity[] | null>(null)

  // 最近动态：打开/上下文更新后刷新
  useEffect(() => {
    let alive = true
    setActivity(null)
    fetchHubActivity({ goalId: goal.id, limit: 10 })
      .then(rows => { if (alive) setActivity(rows) })
      .catch(() => { if (alive) setActivity([]) })
    return () => { alive = false }
  }, [goal.id, goal.contextVersion])

  const act = async (status: GoalStatus): Promise<void> => {
    if (!onGoalStatus) return
    setBusy(status)
    setConfirming(false)
    const label = status === 'paused' ? '⏸ 已暂停' : status === 'active' ? '▶ 已恢复' : '✕ 已取消'
    try { await onGoalStatus(goal.id, status, label) } finally { setBusy(null) }
  }
  const save = async (): Promise<void> => {
    if (!onSaveContext) return
    setSaving(true)
    try {
      await onSaveContext(goal.id, draft.trim())
      setEditing(false)
      setDraft(draft.trim())
    } finally { setSaving(false) }
  }
  const startEdit = (): void => { setDraft(goal.context ?? ''); setEditing(true) }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal goal-modal" onClick={e => e.stopPropagation()}>
        <div className="gd-head">
          <button className="btn icon ghost" title="返回目标看板" onClick={onClose}>←</button>
          <div className="gd-title-wrap">
            <div className="gd-title">{goal.objective}</div>
            <div className="gd-chips">
              <span className={`goal-status ${goal.status}`}>{GOAL_STATUS_TEXT[goal.status]}</span>
              <span className="goal-ver mono">{goal.id}</span>
              <span className="goal-ver" title="目标乐观锁版本">v{goal.version}</span>
              <span className={`goal-ver ctx${goal.contextVersion > 0 ? ' has' : ''}`} title="目标级共享上下文版本">{goal.contextVersion > 0 ? `📄ctx v${goal.contextVersion}` : '📄ctx'}</span>
              {goal.mode && <span className="goal-ver slice" title="建链模式">{MODE_TEXT[goal.mode] ?? goal.mode}</span>}
            </div>
          </div>
          <div className="gd-actions">
            {canAct && onGoalStatus && goal.status === 'active' && (
              <button className="btn icon ghost" disabled={busy !== null} title="暂停该目标（链任务保留，暂停推进）" onClick={() => void act('paused')}>⏸ 暂停</button>
            )}
            {canAct && onGoalStatus && goal.status === 'paused' && (
              <button className="btn icon ghost" disabled={busy !== null} title="恢复该目标推进" onClick={() => void act('active')}>▶ 恢复</button>
            )}
            {canAct && onGoalStatus && (
              <button
                className={`btn icon ghost danger${confirming ? ' confirming' : ''}`}
                disabled={busy !== null}
                title="取消该目标（未开工的链任务一并取消）"
                onClick={() => { if (confirming) void act('canceled'); else setConfirming(true) }}>
                {confirming ? '✓确认取消' : '✕ 取消'}
              </button>
            )}
            {confirming && (
              <button className="btn icon ghost" disabled={busy !== null} title="不取消了" onClick={() => setConfirming(false)}>↩</button>
            )}
            {canEdit && !editing && (
              <button className="btn icon ghost" disabled={busy !== null} title="编辑目标上下文" onClick={startEdit}>✏️ 编辑上下文</button>
            )}
            {editing && (
              <>
                <button className="btn icon ghost" disabled={saving} title="保存并 bump 版本" onClick={() => void save()}>💾 保存</button>
                <button className="btn icon ghost" disabled={saving} title="放弃修改" onClick={() => setEditing(false)}>↩ 放弃</button>
              </>
            )}
          </div>
        </div>
        <div className="modal-body gd-body">
          <div className="gd-main">
            <div className="gd-block-title">
              <span>🎯 链任务（按状态）</span>
              <span className="gd-block-sub">共 {goal.done}/{goal.total} 完成 · {goal.percent}% · 点任务可穿透查看详情</span>
              <div className="gd-agg">
                <div className="goal-bar"><i style={{ width: `${goal.percent}%` }} /></div>
              </div>
            </div>
            <GoalTasks goal={goal} onOpenTask={onOpenTask} />
          </div>
          <div className="gd-side">
            <div className="gd-block-title">📄 目标上下文 <span className="goal-ver">v{goal.contextVersion}</span></div>
            {editing ? (
              <textarea
                className="goal-ctx-edit"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="写目标级共享上下文（markdown）：约束、口径、文件域地图、验收要点…任何同目标任务都应遵守的全局约定。留空 = 该目标暂无共享上下文。"
                rows={6}
              />
            ) : (
              <pre className="goal-ctx-body gd-ctx-body">
                {goal.context && goal.context.trim() !== ''
                  ? goal.context
                  : `（未填写目标上下文——派工仅携带各自任务描述；在此填写后，同目标并行任务即可共享统一口径，避免窜台。${terminal ? ' 目标已结束，只读。' : ''}）`}
              </pre>
            )}
            <div className="gd-block-title">📜 最近动态</div>
            <div className="goal-act-list gd-act-list">
              {activity === null && <div className="goal-act-empty">读取中…</div>}
              {activity !== null && activity.length === 0 && <div className="goal-act-empty">暂无本目标动态</div>}
              {activity !== null && activity.map(row => (
                <div key={row.seq} className="goal-act-row">
                  <span className="goal-act-time">{fmtClock(row.ts)}</span>
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
        </div>
      </div>
    </div>
  )
}

/** 目标看板：按状态分组横向滑动卡片；筛选 + 已结束归档折叠；点卡片进详情。 */
export function GoalsBoard({ goals, scope, onGoalStatus, onSaveContext, onOpenTask }: GoalsBoardProps): React.JSX.Element {
  const [filter, setFilter] = useState<GoalStatus | 'all'>('all')
  const [archOpen, setArchOpen] = useState(false)
  const [selected, setSelected] = useState<HubGoal | null>(null)

  const byStatus = useMemo(() => {
    const m = new Map<GoalStatus, HubGoal[]>()
    for (const s of GOAL_ORDER) m.set(s, [])
    for (const g of goals) m.get(g.status)?.push(g)
    return m
  }, [goals])
  const counts = useMemo(() => {
    const c = new Map<GoalStatus, number>()
    for (const s of GOAL_ORDER) c.set(s, byStatus.get(s)?.length ?? 0)
    return c
  }, [byStatus])
  const archCount = counts.get('done')! + counts.get('canceled')!
  const liveSelected = selected ? (goals.find(g => g.id === selected.id) ?? selected) : null

  // 点状态筛选（已完成/已取消）时自动展开归档区
  useEffect(() => {
    if (filter === 'done' || filter === 'canceled') setArchOpen(true)
  }, [filter])

  if (goals.length === 0) {
    return <div className="obj empty">尚未发布目标（{scope ?? '该空间'}）· 点底部「🎯 发布目标」新增，可同时发布多个目标并发推进。</div>
  }
  const showRail = (s: GoalStatus): boolean => filter === 'all' || filter === s
  const activeRail = byStatus.get('active')!.length > 0 && showRail('active')
  const pausedRail = byStatus.get('paused')!.length > 0 && showRail('paused')
  const doneRail = byStatus.get('done')!.length > 0 && showRail('done')
  const cancelRail = byStatus.get('canceled')!.length > 0 && showRail('canceled')
  const openDetail = (g: HubGoal): void => setSelected(g)

  return (
    <div className="goals-rails">
      <div className="goals-filter">
        <span
          className={`gfilter-chip${filter === 'all' ? ' on' : ''}`}
          onClick={() => { setFilter('all'); if (filter === 'done' || filter === 'canceled') setArchOpen(false) }}>
          全部 {goals.length}
        </span>
        {GOAL_ORDER.map(s => (
          <span
            key={s}
            className={`gfilter-chip gfc-${s}${filter === s ? ' on' : ''}`}
            onClick={() => setFilter(filter === s ? 'all' : s)}>
            {GOAL_STATUS_TEXT[s]} {counts.get(s)}
          </span>
        ))}
        <span className="goals-filter-hint">🖱 点卡片查看详情与链任务 · 轨道可横向滑动</span>
      </div>

      {activeRail && <GoalRail status="active" goals={byStatus.get('active')!} onOpen={openDetail} />}
      {pausedRail && <GoalRail status="paused" goals={byStatus.get('paused')!} onOpen={openDetail} />}

      {filter === 'all' && archCount > 0 && (
        <div className="goal-arch-toggle" role="button" tabIndex={0}
          onClick={() => setArchOpen(x => !x)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setArchOpen(x => !x) } }}>
          <span>{archOpen ? '▾' : '▸'} 已收尾 / 已取消（{archCount}）</span>
          <span className="goal-arch-hint">{archOpen ? '点击折叠' : '点击展开查看'}</span>
        </div>
      )}
      {archOpen && doneRail && <GoalRail status="done" goals={byStatus.get('done')!} onOpen={openDetail} />}
      {archOpen && cancelRail && <GoalRail status="canceled" goals={byStatus.get('canceled')!} onOpen={openDetail} />}

      {filter !== 'all' && (byStatus.get(filter)?.length ?? 0) === 0 && (
        <div className="goal-act-empty">该状态暂无目标。</div>
      )}

      {liveSelected && (
        <GoalDetailOverlay
          goal={liveSelected}
          onClose={() => setSelected(null)}
          onGoalStatus={onGoalStatus}
          onSaveContext={onSaveContext}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  )
}

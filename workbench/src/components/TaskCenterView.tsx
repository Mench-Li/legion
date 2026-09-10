import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchBoard,
  fetchHubTasks,
  hubComment,
  hubTransition,
  openKanban,
  subscribeHubAudit,
} from '../api'
import type { Card, CardComment, CardStatus, HubTask, SpaceInfo } from '../types'
import { toast } from './Toast'
import { TaskDetailModal } from './TaskDetailModal'

/**
 * 任务中心（TaskCenterView）—— 把「Scrum 看板」与「总指挥部/指挥中心」融合进军团指挥台：
 *
 *  - 按工作空间（scope）查看 scrum 任务：中枢模式拉 team-hub v2 `/api/board?scope=`（真分区；
 *    scope=null = 全部空间聚合，卡片带空间名）；v1 文件模式回退 serve.mjs 看板（无分区，只读）。
 *  - 两种视图（Tab）随意切换：
 *      🖥 指挥总览  保留总指挥部「⚡ 工作中 / ⏳ 待我决定 / ⚪ 待办 / ✅ 已完成」的状态分组；
 *      📋 Scrum 看板  经典 Kanban 泳道（Backlog→Todo→进行中→待验收→受阻→完成），中枢模式支持
 *                     拖拽卡片跨列迁移状态（服务端状态机校验，非法迁移被拒并提示）。
 *  - 点击卡片 → 打开既有任务详情（TaskDetailModal：验收/打回/评论/转派/拦截/派 AI），状态变更后联动刷新。
 *
 * 实时性：hub 审计 SSE（/api/events）按 action 过滤任务类事件即时刷新 + 20s 轮询兜底。
 * 数据一律来自中枢/看板只读接口，本组件不持有业务状态（UI 不写库）。
 */

type TaskCenterMode = 'hq' | 'kanban'

interface TaskCenterViewProps {
  /** 当前工作空间（null = 全部空间）；与左侧栏选择联动，中枢模式下在面板内也可切换。 */
  scope: string | null
  hubMode: boolean
  /** 全部工作空间列表（面板内 workspace 下拉用；缺省时退化为文本）。 */
  spaces?: SpaceInfo[]
  /** 面板内切换工作空间（null = 全部空间；中枢模式下回写左侧栏）。 */
  onSelectScope?: (scope: string | null) => void
  /** 任务状态变更后通知外层刷新（右侧任务集等）。 */
  onDataChanged?: () => void
}

/** 服务端状态机允许的迁移（与 team-hub/server.mjs TRANSITIONS 同构，客户端预检用）。 */
const TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  backlog: ['todo', 'blocked', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'todo', 'blocked', 'canceled'],
  in_review: ['done', 'todo', 'in_progress', 'blocked', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  done: ['in_progress', 'canceled'],
  canceled: [],
}

/** Kanban 泳道顺序与中文标签（v1 COLUMN_LABEL 中文口径 + 调度台命名统一）。 */
const KANBAN_COLUMNS: Array<{ status: CardStatus; label: string; icon: string }> = [
  { status: 'backlog', label: '待批准', icon: '📥' },
  { status: 'todo', label: '待认领', icon: '⚪' },
  { status: 'in_progress', label: '进行中', icon: '🟢' },
  { status: 'in_review', label: '待验收', icon: '🟡' },
  { status: 'blocked', label: '受阻', icon: '🔴' },
  { status: 'done', label: '已完成', icon: '✅' },
]

/** 指挥总览的分组（总指挥部三列语义 + 待办补齐）：工作中 / 待我决定 / 待办 / 已完成。 */
const HQ_GROUPS: Array<{ id: string; label: string; icon: string; statuses: CardStatus[]; tone: string }> = [
  { id: 'busy', label: '工作中', icon: '⚡', statuses: ['in_progress'], tone: 'var(--blue)' },
  { id: 'decide', label: '待我决定', icon: '⏳', statuses: ['in_review', 'blocked'], tone: 'var(--yellow)' },
  { id: 'todo', label: '待办', icon: '⚪', statuses: ['backlog', 'todo'], tone: 'var(--muted)' },
  { id: 'done', label: '已完成', icon: '✅', statuses: ['done'], tone: 'var(--green)' },
]

const STATUS_TEXT: Record<CardStatus, string> = {
  backlog: '待批准',
  todo: '待认领',
  in_progress: '进行中',
  in_review: '待验收',
  blocked: '受阻',
  done: '已完成',
  canceled: '已取消',
}

/** 审计动作 → 触发任务中心刷新的集合（任务生命周期 + 目标/评论/证据；高频噪音不入列）。 */
const TASK_ACTIONS = new Set<string>([
  'create', 'claim', 'transition', 'advance', 'reassign', 'hold', 'unhold', 'comment',
  'evidence', 'patch', 'artifact', 'review-note', 'test-report', 'release-stale',
])
const isTaskEvent = (action: string): boolean =>
  TASK_ACTIONS.has(action) || action.startsWith('goal:') || action.startsWith('space:') || action.startsWith('exec:request')

/** 任务中心的轻量行模型（hub 与 v1 看板归一化，只保留展示/操作所需叶子字段）。 */
interface TcRow {
  id: string
  title: string
  status: CardStatus
  priority: string
  scope?: string
  role?: string
  soldier?: string
  goalId?: string
  hold: boolean
  version: number
  blocks: string[]
  blockedBy: string[]
  claimedAt?: string | null
  updatedAt?: string
  comments: CardComment[]
  evidenceCount: number
  patchesCount: number
  artifactsCount: number
}

function rowFromHub(t: HubTask): TcRow {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority ?? 'medium',
    scope: t.scope,
    role: t.role ?? undefined,
    soldier: t.soldier ?? undefined,
    goalId: t.goalId ?? undefined,
    hold: t.hold === true,
    version: t.version,
    blocks: t.blocks ?? [],
    blockedBy: t.blockedBy ?? [],
    claimedAt: t.claimedAt ?? null,
    updatedAt: t.updatedAt,
    comments: t.comments ?? [],
    evidenceCount: (t.evidence ?? []).length,
    patchesCount: (t.patches ?? []).length,
    artifactsCount: (t.artifacts ?? []).length,
  }
}

function rowFromCard(c: Card, status: CardStatus): TcRow {
  return {
    id: c.id,
    title: c.title,
    status,
    priority: c.priority ?? 'medium',
    role: undefined,
    soldier: c.soldier,
    hold: false,
    version: c.version,
    blocks: c.blocks ?? [],
    blockedBy: c.blockedBy ?? [],
    claimedAt: c.claimedAt ?? null,
    updatedAt: c.updatedAt,
    comments: c.comments ?? [],
    evidenceCount: c.evidence ?? 0,
    patchesCount: (c.patches ?? []).length,
    artifactsCount: (c.artifacts ?? []).length,
  }
}

function fmt(iso?: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

function fmtDur(ms: number | null | undefined): string {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚开工'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/** 任务绑定者（soldier ?? role），状态操作的服务端 by 与绑定时语义对齐。 */
function bindOf(r: TcRow): string {
  return r.soldier ?? r.role ?? 'general'
}

function askOpen(r: TcRow): boolean {
  const cs = r.comments ?? []
  if (cs.length === 0) return false
  return (cs[cs.length - 1].text ?? '').startsWith('❓')
}

function normId(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

export function TaskCenterView({ scope, hubMode, spaces = [], onSelectScope, onDataChanged }: TaskCenterViewProps): React.JSX.Element {
  const [mode, setMode] = useState<TaskCenterMode>(() => {
    const saved = localStorage.getItem('legion.taskcenter.mode')
    return saved === 'kanban' || saved === 'hq' ? saved : 'hq'
  })
  const [rows, setRows] = useState<TcRow[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<CardStatus | null>(null)
  const [busyDrop, setBusyDrop] = useState(false)

  const isAll = hubMode && scope === null

  const load = useCallback(async (): Promise<void> => {
    try {
      if (hubMode) {
        const list = await fetchHubTasks(scope)
        setRows(list.map(rowFromHub))
      } else {
        const board = await fetchBoard()
        const flat: TcRow[] = []
        for (const col of board.columns) {
          for (const card of col.cards) flat.push(rowFromCard(card, col.id))
        }
        setRows(flat)
      }
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [hubMode, scope])

  useEffect(() => {
    setRows(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubMode, scope])

  // hub 审计 SSE：任务生命周期/目标/派活事件即时刷新（+20s 轮询兜底，与指挥台其它面板同口径）
  useEffect(() => {
    let poll = 0
    let disposed = false
    let off: (() => void) | null = null
    const reload = (): void => {
      if (!disposed) void load()
    }
    if (hubMode) {
      try {
        off = subscribeHubAudit(ev => {
          if (isTaskEvent(ev.action)) reload()
        }, { scope: scope ?? undefined })
      } catch {
        off = null
      }
      poll = window.setInterval(reload, 20000)
    }
    return () => {
      disposed = true
      off?.()
      if (poll) window.clearInterval(poll)
    }
  }, [hubMode, load, scope])

  const switchMode = (next: TaskCenterMode): void => {
    setMode(next)
    localStorage.setItem('legion.taskcenter.mode', next)
  }

  const spaceName = useCallback(
    (id?: string): string => {
      if (!id) return '未分区'
      const s = spaces.find(x => x.id === id)
      return s ? s.name : id
    },
    [spaces],
  )

  const roles = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows ?? []) {
      const who = r.soldier ?? r.role
      if (who) set.add(who)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter(r => {
      if (r.status === 'canceled') return false
      if (roleFilter && (r.soldier ?? r.role) !== roleFilter) return false
      if (q && !r.id.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, roleFilter, query])

  const reload = (): void => {
    void load()
    onDataChanged?.()
  }

  const summary = useMemo(() => {
    const s: Record<string, number> = { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, canceled: 0 }
    for (const r of rows ?? []) s[r.status] += 1
    return s
  }, [rows])

  /** 拖拽迁移（中枢模式）：先按服务端状态机预检，语义特例（验收/打回/解阻）走确认/填因，再写 /api/transition。 */
  const moveTo = async (item: TcRow, to: CardStatus): Promise<void> => {
    if (!hubMode) {
      toast('info', 'v1 文件模式只读：请在中枢模式（team-hub v2）下拖拽迁移，或到经典看板页操作')
      return
    }
    if (item.status === to) return
    const allowed = TRANSITIONS[item.status] ?? []
    if (!allowed.includes(to)) {
      toast('err', `非法迁移 ${item.id}：${STATUS_TEXT[item.status]} → ${STATUS_TEXT[to]}（服务端状态机不允许）`)
      return
    }
    if (to === 'done') {
      if (!window.confirm(`验收通过 ${item.id}「${item.title}」？\n（in_review → done，仅将军可执行，验收后进入完成态）`)) return
    }
    if (to === 'todo' && item.status === 'in_review') {
      const reason = window.prompt(`打回 ${item.id} 的原因（将写评论并归还待办）`)
      if (reason === null) return
      try {
        await hubComment(item.id, `↩ 打回重做：${reason.trim() || '无理由'}`)
      } catch (e) {
        toast('err', e instanceof Error ? e.message : String(e))
        return
      }
    }
    setBusyDrop(true)
    try {
      const by = to === 'done' ? 'general' : bindOf(item)
      const force = to === 'in_progress' && item.status === 'blocked' ? true : undefined
      await hubTransition({ id: item.id, to, by, ifVersion: item.version, force })
      toast('ok', `${item.id} 已迁移：${STATUS_TEXT[item.status]} → ${STATUS_TEXT[to]}`)
      reload()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('乐观锁') ? `${msg}（已自动刷新看板，请重试）` : msg)
      void load()
    } finally {
      setBusyDrop(false)
    }
  }

  const openDetail = (id: string): void => {
    if (!hubMode) {
      toast('info', 'v1 文件模式只读：任务详情与迁移请用右上角「打开经典看板 ↗」')
      return
    }
    setDetailId(id)
  }

  const onDragStart = (e: React.DragEvent<HTMLDivElement>, id: string): void => {
    if (!hubMode) {
      e.preventDefault()
      return
    }
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }

  const onDragOverCol = (e: React.DragEvent<HTMLDivElement>, status: CardStatus): void => {
    if (!dragId || !hubMode) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropCol !== status) setDropCol(status)
  }

  const onDropCol = (e: React.DragEvent<HTMLDivElement>, status: CardStatus): void => {
    e.preventDefault()
    const id = dragId ?? e.dataTransfer.getData('text/plain')
    setDragId(null)
    setDropCol(null)
    if (!hubMode || !id) return
    const item = (rows ?? []).find(r => r.id === id)
    if (item) void moveTo(item, status)
  }

  const lanes = useMemo(
    () =>
      KANBAN_COLUMNS.map(col => ({
        ...col,
        items: visible
          .filter(r => r.status === col.status)
          .sort((a, b) => normId(a.id, b.id)),
      })),
    [visible],
  )

  const hqGroups = useMemo(
    () =>
      HQ_GROUPS.map(g => ({
        ...g,
        items: visible
          .filter(r => g.statuses.includes(r.status))
          .sort((a, b) => normId(a.id, b.id)),
      })),
    [visible],
  )

  const doneOpen = (r: TcRow): boolean => r.status !== 'done' && r.status !== 'canceled'

  const renderCard = (r: TcRow): React.JSX.Element => {
    const actor = r.soldier ?? r.role ?? '未指派'
    const chips: React.JSX.Element[] = []
    if (isAll && r.scope) {
      chips.push(
        <span key="scope" className="tc-chip tc-chip-scope" title={`工作空间：${spaceName(r.scope)}`}>
          🗂 {spaceName(r.scope)}
        </span>,
      )
    }
    if (actor !== '未指派') chips.push(<span key="who" className="tc-chip">{actor}</span>)
    if (r.goalId) chips.push(<span key="goal" className="tc-chip tc-chip-goal">🎯 {r.goalId}</span>)
    if (r.blockedBy.length > 0) chips.push(<span key="dep" className="tc-chip tc-chip-dep">🔗 {r.blockedBy.join(',')}</span>)
    if (r.priority !== 'medium') chips.push(<span key="prio" className={`tc-chip tc-prio-${r.priority}`}>{r.priority === 'high' ? 'P0' : 'P2'}</span>)
    if (r.hold) chips.push(<span key="hold" className="tc-chip tc-chip-hold">🖐 拦截</span>)
    if (askOpen(r)) chips.push(<span key="ask" className="tc-chip tc-chip-ask">❓ 待将军确认</span>)

    const meta: string[] = []
    if (r.status === 'in_progress' && r.claimedAt) meta.push(`⏱ ${fmtDur(Date.now() - new Date(r.claimedAt).getTime())}`)
    if (r.comments.length > 0) meta.push(`💬 ${r.comments.length}`)
    if (r.evidenceCount > 0) meta.push(`📦 ${r.evidenceCount}`)
    if (r.patchesCount > 0) meta.push(`🔧 ${r.patchesCount}`)
    if (r.artifactsCount > 0) meta.push(`📎 ${r.artifactsCount}`)
    meta.push(`v${r.version}`)

    const last = r.comments.length > 0 ? r.comments[r.comments.length - 1] : null

    return (
      <div
        key={r.id}
        className={`tc-card${hubMode ? ' clickable' : ''}`}
        draggable={hubMode && doneOpen(r)}
        data-id={r.id}
        onClick={() => openDetail(r.id)}
        onDragStart={e => onDragStart(e, r.id)}
        onDragEnd={() => { setDragId(null); setDropCol(null) }}
        title={`${r.id} · ${r.title}${hubMode ? '（点击查看详情/AI 执行过程' : ''}${hubMode && doneOpen(r) ? '；拖拽到其它列迁移状态' : ''}${hubMode ? '）' : '（v1 只读总览）'}`}
      >
        <div className="tc-card-title">
          <span className="tc-tid">{r.id}</span>
          <span className="tc-tt">{r.title}</span>
        </div>
        {chips.length > 0 && <div className="tc-chips">{chips}</div>}
        {last && (
          <div className="tc-preview" title={`${last.by}：${last.text}`}>
            {last.by}: {last.text}
          </div>
        )}
        <div className="tc-card-foot">
          <span className="tc-meta">{meta.join(' · ')}</span>
          {r.updatedAt && <span className="tc-time">{fmt(r.updatedAt).slice(5)}</span>}
        </div>
      </div>
    )
  }

  const renderLaneEmpty = (): React.JSX.Element => (
    <div className="tc-empty">暂无任务</div>
  )

  const groupHead = (label: string, icon: string, n: number, tone?: string): React.JSX.Element => (
    <div className="tc-lane-head">
      <span className="tc-lane-icon" style={tone ? { color: tone } : undefined}>{icon}</span>
      <span className="tc-lane-label">{label}</span>
      <span className="tc-lane-n">{n}</span>
    </div>
  )

  const roleOptions = roles.map(r => (
    <button
      key={r}
      className={`tc-pill${roleFilter === r ? ' on' : ''}`}
      onClick={() => setRoleFilter(roleFilter === r ? null : r)}
      title="按岗位/执行者过滤（再次点击取消）"
    >
      {r} <span className="tc-pill-cnt">{(rows ?? []).filter(x => (x.soldier ?? x.role) === r && x.status !== 'canceled').length}</span>
    </button>
  ))

  return (
    <div className="center-col">
      {/* 头部：视图 Tab + 工作空间下拉 + 数据源/入口 */}
      <div className="panel tc-head">
        <div className="tc-tabs" role="tablist">
          <button
            className={`tc-tab${mode === 'hq' ? ' on' : ''}`}
            onClick={() => switchMode('hq')}
            title="总指挥部风格：按「工作中 / 待我决定 / 待办 / 已完成」分组总览"
          >
            🖥 指挥总览
          </button>
          <button
            className={`tc-tab${mode === 'kanban' ? ' on' : ''}`}
            onClick={() => switchMode('kanban')}
            title="Scrum 看板：按状态泳道查看任务（中枢模式可拖拽迁移）"
          >
            📋 Scrum 看板
          </button>
        </div>
        <div className="tc-head-right">
          {hubMode && onSelectScope && (
            <select
              className="tc-scope-select"
              value={scope ?? ''}
              onChange={e => onSelectScope(e.target.value === '' ? null : e.target.value)}
              title="按工作空间查看 scrum 任务（与左侧工作空间选择联动）"
            >
              <option value="">🗂 全部空间</option>
              {spaces.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="tc-search"
            placeholder="🔍 搜任务 id / 标题…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {hubMode ? (
            <span className="tc-src" title="数据源：team-hub v2（SQLite，真分区）">🟢 中枢 {scope ? `「${scope}」` : '全部空间'}</span>
          ) : (
            <span className="tc-src" title="数据源：serve.mjs v1（文件模式，无 scope 分区）">🟡 v1 文件模式（只读）</span>
          )}
          <button className="btn ghost" onClick={openKanban} title="在新标签页打开经典看板（v1 页面）">
            打开经典看板 ↗
          </button>
        </div>
      </div>

      {/* 状态统计条 */}
      <div className="panel tc-summary">
        <span className="tc-sum-title">📊 状态</span>
        <span className="tc-sum-chip s-progress">🟢 进行中 {summary.in_progress}</span>
        <span className="tc-sum-chip s-decide">🟡 待我决定 {summary.in_review + summary.blocked}</span>
        <span className="tc-sum-chip s-todo">⚪ 待办 {summary.todo + summary.backlog}</span>
        <span className="tc-sum-chip s-blocked">🔴 受阻 {summary.blocked}</span>
        <span className="tc-sum-chip s-done">✅ 已完成 {summary.done}</span>
        <span className="tc-sum-chip s-canceled">⛔ 已取消 {summary.canceled}</span>
        <span className="tc-sum-total">共 {(rows ?? []).length} 任务{hubMode ? (isAll ? ' · 跨全部空间' : '') : ''}</span>
      </div>

      {/* 角色/岗位过滤条 */}
      {(roles.length > 0 || (visible.length === 0 && rows !== null)) && (
        <div className="panel tc-filter">
          <span className="tc-filter-label">👥 岗位/执行者</span>
          <div className="tc-pills">
            <button className={`tc-pill${roleFilter === null ? ' on' : ''}`} onClick={() => setRoleFilter(null)}>
              全部
            </button>
            {roleOptions}
          </div>
          {(query !== '' || roleFilter !== null) && (
            <span className="tc-filter-clear" onClick={() => { setQuery(''); setRoleFilter(null) }}>
              ✕ 清除过滤
            </span>
          )}
        </div>
      )}

      {loadErr && (
        <div className="panel" style={{ padding: 14, color: 'var(--red)', fontSize: 12 }}>
          读取失败：{loadErr}（请确认 team-hub v2（:8787）已启动并选中有效工作空间）
        </div>
      )}

      {rows === null && !loadErr && (
        <div className="panel" style={{ padding: 28, textAlign: 'center', color: 'var(--muted-2)', fontSize: 12 }}>
          ⏳ 正在加载任务…
        </div>
      )}

      {rows !== null && !loadErr && rows.length === 0 && (
        <div className="panel" style={{ padding: 28, textAlign: 'center', color: 'var(--muted-2)', fontSize: 12, lineHeight: 1.9 }}>
          当前{hubMode ? (scope ? `工作空间「${spaceName(scope)}」` : '工作空间（全部空间）') : '数据源'}暂无任务。
          <br />
          用底部「🎯 发布目标」自动生成阶段任务链，或「＋ 新建任务」开始。
        </div>
      )}

      {rows !== null && !loadErr && rows.length > 0 && mode === 'hq' && (
        <div className="panel tc-hq">
          {hqGroups.map(g => (
            <section key={g.id} className={`tc-lane tc-hq-${g.id}`}>
              {groupHead(g.label, g.icon, g.items.length, g.tone)}
              <div className="tc-cards">
                {g.items.length > 0 ? g.items.map(renderCard) : renderLaneEmpty()}
              </div>
            </section>
          ))}
        </div>
      )}

      {rows !== null && !loadErr && rows.length > 0 && mode === 'kanban' && (
        <div className="panel tc-board">
          {lanes.map(col => (
            <div
              key={col.status}
              className={`tc-col tc-col-${col.status}${dropCol === col.status ? ' drop' : ''}${busyDrop ? ' busy' : ''}`}
              onDragOver={e => onDragOverCol(e, col.status)}
              onDragLeave={() => setDropCol(prev => (prev === col.status ? null : prev))}
              onDrop={e => onDropCol(e, col.status)}
            >
              {groupHead(col.label, col.icon, col.items.length)}
              <div className="tc-cards">
                {col.items.length > 0 ? col.items.map(renderCard) : renderLaneEmpty()}
              </div>
            </div>
          ))}
        </div>
      )}

      {rows !== null && !loadErr && visible.length === 0 && (query !== '' || roleFilter !== null) && (
        <div className="panel" style={{ padding: 16, color: 'var(--muted-2)', fontSize: 12 }}>
          没有符合过滤条件的任务（清空搜索/过滤后查看全部）
        </div>
      )}

      {detailId && (
        <TaskDetailModal
          taskId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={reload}
        />
      )}
    </div>
  )
}

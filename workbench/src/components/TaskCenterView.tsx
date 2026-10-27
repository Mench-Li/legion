import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchHubTasks,
  hubTransition,
  subscribeHubAudit,
} from '../api'
import type { CardComment, CardStatus, HubGoal, HubTask, SpaceInfo } from '../types'
import { toast } from './Toast'
import { deliveryBadgeOf, schedulingBadgeOf } from '../deliveryBadge.ts'
import { planDrop } from '../reworkPlan.ts'
import { sortByMostRecent } from '../taskOrder.ts'
import { buildGoalFilter, goalFilterLabel, hasRealGoal, matchesGoalFilter, rankGoalOptions } from '../taskGoalFilter.ts'
import { isWaitingOnUser } from '../waitingOnUser'
import { ReworkModal } from './ReworkModal'
import { TaskDetailModal } from './TaskDetailModal'

/**
 * 任务中心（TaskCenterView）—— 「Scrum 看板」与「总指挥部/指挥中心」已合并为**单一视图**，以 Scrum 泳道为主体：
 *
 *  - 主体 = Kanban 泳道（待批准→待认领→进行中→待验收→受阻→已完成），支持拖拽卡片跨列迁移
 *    状态（服务端状态机校验，非法迁移被拒并提示）。
 *  - **往回拖**有两条各说各话的路（判定收在 `planDrop` 里，见 `../reworkPlan.ts`）：
 *      · 已验收 → 待认领/进行中/待验收 = **重做**（改动点必填）：旧链上这一环与下游一起作废、
 *        另发一个新目标承接重做链（本岗位 → 审查 → 测试 → 部署，`POST /api/rework`）；
 *      · 待验收 → 待认领/进行中 = **打回**（改动点必填）：同一目标内退回，评论即下一轮的输入。
 *    「已取消」是唯一拖不动的状态。
 *  - 「指挥总览」不再是第二个 Tab：它的将军视角分组语义（⚡ 工作中 / ⏳ 待我决定 / ⚪ 待办 / ✅ 已完成）
 *    并进泳道顶部的**视角过滤**——点选即按该语义筛卡片，泳道结构与拖拽目标始终完整可见，
 *    「待我决定」（in_review + blocked）仍是一眼可点的将军待办清单。
 *  - 按工作空间（scope）查看 scrum 任务：拉 team-hub v2 `/api/board?scope=`（真分区；
 *    scope=null = 全部空间聚合，卡片带空间名）。**唯一数据源就是中枢** ——
 *    从前还有一条"文件模式只读"的回退，随那条被取消的旧看板一起删掉了。
 *  - 过滤轴（面板内三条，叠加生效）：**🎯 目标**（下拉 + 输入模糊匹配）· 👥 岗位/执行者 ·
 *    🔍 id/标题搜索。目标那条轴收在 `../taskGoalFilter.ts`（纯函数）：计数取全量口径
 *    （不含已取消），顺序固定；模糊匹配打在**完整**目标文案与目标 id 上（子序列也算命中），
 *    「未挂目标」是列表里的显式一项。为什么是下拉而不是一排胶囊：目标会长到几十个，
 *    一排胶囊会把过滤区撑成好几行、把泳道挤下去。
 *    目标文案来自上层传入的 `goals`（「全部空间」模式读不到目标记录 ⇒ 如实退化成显示目标 id，不猜文案）。
 *  - 点击卡片 → 打开既有任务详情（TaskDetailModal：验收/打回/评论/转派/拦截/派 AI），状态变更后联动刷新。
 *
 * 实时性：hub 审计 SSE（/api/events）按 action 过滤任务类事件即时刷新 + 20s 轮询兜底。
 * 数据一律来自中枢只读接口，本组件不持有业务状态（UI 不写库）。
 */

/** 将军视角（原「指挥总览」的分组语义，并入看板后作为泳道过滤）。 */
type TcView = 'all' | 'busy' | 'decide' | 'todo' | 'done'

interface TaskCenterViewProps {
  /** 当前工作空间（null = 全部空间）；与左侧栏选择联动，中枢模式下在面板内也可切换。 */
  scope: string | null
  hubMode: boolean
  /** 全部工作空间列表（面板内 workspace 下拉用；缺省时退化为文本）。 */
  spaces?: SpaceInfo[]
  /**
   * 当前空间的目标记录（只用来把卡片上的 `goalId` 说成人能读的目标文案）。
   *
   * 缺省 = 读不到目标记录（如「全部空间」聚合模式：`/api/goal` 不给 scope 就是空列表），
   * 那时目标胶囊**只显示 id**，不猜文案。
   */
  goals?: HubGoal[]
  /** 面板内切换工作空间（null = 全部空间；中枢模式下回写左侧栏）。 */
  onSelectScope?: (scope: string | null) => void
  /** 任务状态变更后通知外层刷新（右侧任务集等）。 */
  onDataChanged?: () => void
  selectedView?: TcView
  onViewChange?: (view: TcView) => void
  onContactAgent?: (scope: string, role: string) => void
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

/** Kanban 泳道顺序与中文标签（与调度台命名统一）。 */
const KANBAN_COLUMNS: Array<{ status: CardStatus; label: string; icon: string }> = [
  { status: 'backlog', label: '待批准', icon: '📥' },
  { status: 'todo', label: '待认领', icon: '⚪' },
  { status: 'in_progress', label: '进行中', icon: '🟢' },
  { status: 'in_review', label: '待验收', icon: '🟡' },
  { status: 'blocked', label: '受阻', icon: '🔴' },
  { status: 'done', label: '已完成', icon: '✅' },
]

/** 泳道顶部的将军视角过滤（原指挥总览四组 + 全部）：只筛卡片，不改泳道结构。 */
const TC_VIEWS: Array<{ id: TcView; label: string; icon: string; statuses: CardStatus[]; tone: string }> = [
  { id: 'all', label: '全部', icon: '📊', statuses: [], tone: 'var(--text)' },
  { id: 'busy', label: '工作中', icon: '⚡', statuses: ['in_progress'], tone: 'var(--green)' },
  { id: 'decide', label: '待我决定', icon: '⏳', statuses: ['in_review', 'blocked'], tone: 'var(--yellow)' },
  { id: 'todo', label: '待办', icon: '⚪', statuses: ['backlog', 'todo'], tone: 'var(--accent)' },
  { id: 'done', label: '已完成', icon: '✅', statuses: ['done'], tone: 'var(--green-2)' },
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

/** 任务中心的轻量行模型（只保留展示/操作所需叶子字段）。 */
interface TcRow {
  id: string
  title: string
  status: CardStatus
  schedulingState?: string | null
  schedulingBlockedBy?: string | null
  schedulingBlockedPath?: string | null
  deliveryState?: string | null
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
  /** 排序兜底用（`updatedAt` 缺失时退到它）；界面不展示。 */
  createdAt?: string
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
    schedulingState: t.schedulingState ?? null,
    schedulingBlockedBy: t.schedulingBlockedBy ?? null,
    schedulingBlockedPath: t.schedulingBlockedPath ?? null,
    deliveryState: t.deliveryState ?? null,
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
    createdAt: t.createdAt,
    comments: t.comments ?? [],
    evidenceCount: (t.evidence ?? []).length,
    patchesCount: t.patchesCount ?? (t.patches ?? []).length,
    artifactsCount: (t.artifacts ?? []).length,
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
  // 判据只有一处（`waitingOnUser.ts`）：看板与任务详情必须对同一张卡给出同一结论。
  return isWaitingOnUser(r)
}

// ★ 原来这里有个 `normId(a,b)`，只服务于「按任务号升序」那一行（已换成 sortByMostRecent）。
//   删掉而不是留着，是因为留着它会让下一个人以为"号序"仍然是某种被判定的东西。
export function TaskCenterView({ scope, hubMode, spaces = [], goals = [], onSelectScope, onDataChanged, selectedView, onViewChange, onContactAgent }: TaskCenterViewProps): React.JSX.Element {
  /** 将军视角过滤（原「指挥总览」分组语义并入看板；默认「全部」= 经典泳道全貌）。 */
  const [view, setView] = useState<TcView>(() => {
    const saved = localStorage.getItem('legion.taskcenter.view')
    return TC_VIEWS.some(v => v.id === saved) ? (saved as TcView) : 'all'
  })
  const [rows, setRows] = useState<TcRow[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<string | null>(null)
  /** 🎯 目标过滤（键 = goalId 或「未挂目标」哨兵；null = 全部目标）。 */
  const [goalFilter, setGoalFilter] = useState<string | null>(null)
  /** 目标下拉的开合、搜索串与键盘游标（游标 = 列表项下标，-1 = 没动过）。 */
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalQuery, setGoalQuery] = useState('')
  const [goalCursor, setGoalCursor] = useState(-1)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<CardStatus | null>(null)
  const [busyDrop, setBusyDrop] = useState(false)
  /** 往回拖的待确认项：重做（发新目标 + 重建下游）或同一目标内打回；由 ReworkModal 收改动点。 */
  const [dropAsk, setDropAsk] = useState<{ item: TcRow; intent: 'rework' | 'return' } | null>(null)

  const isAll = hubMode && scope === null
  /** 泳道容器：切视角时把「第一个有匹配的列」滚进视野（受阻/已完成 默认在横向滚动区外侧）。 */
  const boardRef = useRef<HTMLDivElement | null>(null)
  /** 目标下拉的容器：点外面关掉它（不用遮罩：遮罩会把泳道的拖拽一起挡掉）。 */
  const goalPickerRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await fetchHubTasks(scope, { compact: true })
      setRows(list.map(rowFromHub))
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [scope])

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
    let reloadTimer = 0
    let reloadInFlight = false
    let reloadAgain = false
    const reload = (): void => {
      if (disposed || reloadTimer) return
      reloadTimer = window.setTimeout(() => {
        reloadTimer = 0
        if (disposed) return
        if (reloadInFlight) {
          reloadAgain = true
          return
        }
        reloadInFlight = true
        void load().finally(() => {
          reloadInFlight = false
          if (reloadAgain) {
            reloadAgain = false
            reload()
          }
        })
      }, 500)
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
      if (reloadTimer) window.clearTimeout(reloadTimer)
      off?.()
      if (poll) window.clearInterval(poll)
    }
  }, [hubMode, load, scope])

  const switchView = (next: TcView): void => {
    setView(next)
    onViewChange?.(next)
    localStorage.setItem('legion.taskcenter.view', next)
  }
  useEffect(() => { if (selectedView) setView(selectedView) }, [selectedView])

  /**
   * 目标下拉：点外面关掉。
   *
   * 不用全屏遮罩 —— 遮罩会盖住泳道，把"一边看卡片一边换目标"这件事变成两次点击。
   * 监听挂在 document 的 mousedown 上（不是 click）：按下就关，比等 click 更跟手。
   */
  useEffect(() => {
    if (!goalOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!goalPickerRef.current?.contains(e.target as Node)) setGoalOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setGoalOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [goalOpen])

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

  /**
   * 🎯 目标胶囊（口径与顺序收在 `../taskGoalFilter.ts`）。
   *
   * ★ 计数取自**全量 rows**（不含已取消），不是 `filtered`：胶囊上的数字要能当"这个目标
   *   还剩多少活"来读，而且点选后其余胶囊的数字与位置都不许跳——跳了就像任务被筛丢了。
   */
  const goalOptions = useMemo(() => buildGoalFilter(rows ?? [], goals), [rows, goals])

  /** goalId → 目标文案（卡片徽标的悬停说明用；读不到就没有这条说明，不猜）。 */
  const goalObjectiveById = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of goals) if (g.id && g.objective) m.set(g.id, g.objective)
    return m
  }, [goals])

  /** 「全部目标」右侧的数字 = 该范围内未被取消的任务数（与胶囊口径一致）。 */
  const goalTotal = useMemo(() => (rows ?? []).filter(r => r.status !== 'canceled').length, [rows])

  /** 下拉内容：空搜索 = 全量（顺序固定），输入 = 模糊匹配后按分数排序。 */
  const goalMenu = useMemo(() => rankGoalOptions(goalOptions, goalQuery, goalTotal), [goalOptions, goalQuery, goalTotal])

  /** 触发按钮上的说法：没筛 = 「全部目标」，筛着的那个目标显示**完整文案 + id**。 */
  const goalCurrent = useMemo(() => goalOptions.find(o => o.key === goalFilter) ?? null, [goalOptions, goalFilter])

  const chooseGoal = (key: string | null): void => {
    setGoalFilter(key)
    setGoalOpen(false)
    setGoalQuery('')
    setGoalCursor(-1)
  }

  /** 下拉里的键盘操作：↑↓ 移游标、Enter 选中、Esc 关闭（与原生 select 一致的手感）。 */
  const onGoalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const n = goalMenu.length
      if (n === 0) return
      setGoalCursor(prev => (prev < 0 ? (dir > 0 ? 0 : n - 1) : (prev + dir + n) % n))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = goalMenu[goalCursor] ?? goalMenu[0]
      if (hit) chooseGoal(hit.key)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setGoalOpen(false)
    }
  }

  /** 搜索 + 岗位 + 目标过滤后的任务（不含将军视角过滤）。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter(r => {
      if (r.status === 'canceled') return false
      if (roleFilter && (r.soldier ?? r.role) !== roleFilter) return false
      if (!matchesGoalFilter(r, goalFilter)) return false
      if (q && !r.id.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, roleFilter, goalFilter, query])

  const viewStatuses = useMemo(
    () => TC_VIEWS.find(v => v.id === view)?.statuses ?? [],
    [view],
  )

  const loaded = rows !== null

  // 切视角（含首次载入沿用上次视角）：把第一个匹配列滚进视野，省掉手动横向拖拽
  useEffect(() => {
    if (view === 'all' || !loaded) return
    const first = KANBAN_COLUMNS.find(c => viewStatuses.includes(c.status))
    if (!first) return
    const el = boardRef.current?.querySelector(`.tc-col-${first.status}`)
    el?.scrollIntoView({ block: 'nearest', inline: 'start' })
  }, [view, viewStatuses, loaded])

  /** 最终渲染集 = 搜索/岗位过滤 ∩ 将军视角过滤。 */
  const visible = useMemo(
    () => (view === 'all' ? filtered : filtered.filter(r => viewStatuses.includes(r.status))),
    [filtered, view, viewStatuses],
  )

  const reload = (): void => {
    void load()
    onDataChanged?.()
  }

  const summary = useMemo(() => {
    const s: Record<string, number> = { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, canceled: 0 }
    for (const r of rows ?? []) s[r.status] += 1
    return s
  }, [rows])

  /** 各视角任务数（全量口径，不受搜索/岗位过滤影响；四组之和 = 全部，不含已取消）。 */
  const viewCounts = useMemo<Record<TcView, number>>(() => ({
    all: summary.in_progress + summary.in_review + summary.blocked + summary.backlog + summary.todo + summary.done,
    busy: summary.in_progress,
    decide: summary.in_review + summary.blocked,
    todo: summary.backlog + summary.todo,
    done: summary.done,
  }), [summary])

  /**
   * 拖拽迁移：先按服务端状态机预检，语义特例（验收/重做/打回/解阻）走确认或填改动点，
   * 再写 `/api/transition`（重做走 `/api/rework`）。
   *
   * ★ 判定的**去向**收在 `planDrop` 这个纯函数里（见 `../reworkPlan.ts` 的文件头）：
   *   `done → todo` 这条边服务端状态机里没有，而 `done → in_progress` 有——
   *   只按状态机走的话，"验收不满意"会从一条**合法但静默**的回退里溜过去：
   *   卡片挪回去了、评论没写、下游一条都不重建，而界面看起来是成功的。
   */
  const moveTo = async (item: TcRow, to: CardStatus): Promise<void> => {
    const plan = planDrop(item.status, to, TRANSITIONS[item.status] ?? [])
    if (plan.kind === 'illegal') {
      toast('err', `非法迁移 ${item.id}：${STATUS_TEXT[item.status]} → ${STATUS_TEXT[to]}（${plan.hint}）`)
      return
    }
    // 重做 / 打回都要先给出改动点（必填）——由对话框收集后自己发请求，这里只负责把弹框叫起来
    if (plan.kind === 'rework' || plan.kind === 'return') {
      setDropAsk({ item, intent: plan.kind })
      return
    }
    if (to === 'done') {
      if (!window.confirm(`验收通过 ${item.id}「${item.title}」？\n（in_review → done，仅将军可执行，验收后进入完成态）`)) return
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

  /** 泳道 = 经典 Kanban 六列；视角过滤只减卡片，列本身始终保留（拖拽目标不消失）。 */
  const lanes = useMemo(
    () =>
      KANBAN_COLUMNS.map(col => {
        const inCol = sortByMostRecent(filtered.filter(r => r.status === col.status))
        const items = view === 'all' ? inCol : inCol.filter(r => viewStatuses.includes(r.status))
        return { ...col, items, hidden: inCol.length - items.length }
      }),
    [filtered, view, viewStatuses],
  )

  /**
   * 这张卡能不能拖。
   *
   * ★ 从前的判据是 `status !== 'done' && status !== 'canceled'` —— 也就是**已完成的任务拖不动**。
   *   那正是"验收不满意要重做"被挡在门外的地方：卡片根本没长拖拽手柄，
   *   而界面上没有任何东西说明为什么拖不动。
   *   现在只有「已取消」拖不动（终态，没有任何往回走的语义）。
   */
  const draggableCard = (r: TcRow): boolean => r.status !== 'canceled'

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
    if (r.goalId) {
      // 徽标仍是 id（短、可复制、与目标看板一致）；目标文案放悬停里，够看清又不撑卡片
      const obj = goalObjectiveById.get(r.goalId)
      chips.push(<span key="goal" className="tc-chip tc-chip-goal" title={obj ? `目标 ${r.goalId}：${obj}` : `目标 ${r.goalId}`}>🎯 {r.goalId}</span>)
    }
    if (r.blockedBy.length > 0) chips.push(<span key="dep" className="tc-chip tc-chip-dep">🔗 {r.blockedBy.join(',')}</span>)
    if (r.priority !== 'medium') chips.push(<span key="prio" className={`tc-chip tc-prio-${r.priority}`}>{r.priority === 'high' ? 'P0' : 'P2'}</span>)
    if (r.hold) chips.push(<span key="hold" className="tc-chip tc-chip-hold">🖐 拦截</span>)
    if (askOpen(r)) chips.push(<span key="ask" className="tc-chip tc-chip-ask">❓ 待将军确认</span>)
    const schedBadge = schedulingBadgeOf({ schedulingState: r.schedulingState, blockingTaskId: r.schedulingBlockedBy, blockingPath: r.schedulingBlockedPath })
    if (schedBadge) chips.push(<span key="sched" className={`tc-chip tc-chip-sched-${schedBadge.tone}`} title={schedBadge.title}>{schedBadge.label}</span>)
    const delBadge = deliveryBadgeOf({ deliveryState: r.deliveryState })
    if (delBadge) chips.push(<span key="delivery" className={`tc-chip tc-chip-del-${delBadge.tone}`} title={delBadge.title}>{delBadge.label}</span>)

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
        draggable={hubMode && draggableCard(r)}
        data-id={r.id}
        onClick={() => openDetail(r.id)}
        onDragStart={e => onDragStart(e, r.id)}
        onDragEnd={() => { setDragId(null); setDropCol(null) }}
        title={hubMode ? `${r.id} · ${r.title}（点击查看详情/AI 执行过程${draggableCard(r) ? '；拖拽到其它列迁移状态' : ''}）` : `${r.id} · ${r.title}`}
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

  const groupHead = (label: string, icon: string, n: number): React.JSX.Element => (
    <div className="tc-lane-head">
      <span className="tc-lane-icon">{icon}</span>
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

  /** 有任一过滤生效时才给的「清除过滤」；渲染位置见下面两条过滤条（谁在就挂在谁末尾）。 */
  const clearLink = query !== '' || roleFilter !== null || goalFilter !== null
    ? (
      <span
        className="tc-filter-clear"
        onClick={() => { setQuery(''); setRoleFilter(null); setGoalFilter(null) }}
        title="清空搜索 / 岗位 / 目标过滤，恢复完整泳道"
      >
        ✕ 清除过滤
      </span>
    )
    : null

  /** 筛着但选项读不到时（如切换空间后目标没了），空态要能念出筛的是哪个键。 */
  const goalFilterWording = goalFilterLabel(goalOptions, goalFilter)

  return (
    <div className="center-col">
      {/* 头部：标题 + 工作空间下拉 + 数据源（原「指挥总览 / Scrum 看板」双 Tab 已合并为单一泳道视图） */}
      <div className="panel tc-head">
        <span className="tc-head-title">📋 任务中心</span>
        <span className="tc-head-hint">
          Scrum 泳道 · 拖拽卡片跨列迁移状态（已完成/待验收往回拖 = 重做，会要求填写改动点）· 点卡片看详情与 AI 执行过程
        </span>
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
          {/* 🎯 目标下拉：一个真实目标都没有时整条不出现（那时唯一的选项是「未挂目标」，等于没得筛） */}
          {hasRealGoal(goalOptions) && (
          <div className="tc-goal-picker" ref={goalPickerRef}>
            <button
              type="button"
              className={`tc-goal-trigger${goalFilter ? ' on' : ''}`}
              onClick={() => { setGoalOpen(v => !v); setGoalCursor(-1) }}
              aria-haspopup="listbox"
              aria-expanded={goalOpen}
              title={goalCurrent
                ? `当前按目标筛选：${goalCurrent.title}（点开可换或取消）`
                : '按目标筛选任务（点开可搜目标名 / 目标 id）'}
            >
              {/* 「目标：」四个字常驻：只显示目标文案时，用户认不出这是哪条轴 */}
              🎯 目标：{goalCurrent ? goalCurrent.label : '全部'}
              {goalCurrent && <span className="tc-pill-cnt">{goalCurrent.count}</span>}
              <span className="tc-caret">▾</span>
            </button>
            {goalOpen && (
              <div className="tc-goal-menu">
                <input
                  className="tc-goal-search"
                  autoFocus
                  placeholder="输入目标名 / 目标 id 模糊匹配…"
                  value={goalQuery}
                  onChange={e => { setGoalQuery(e.target.value); setGoalCursor(0) }}
                  onKeyDown={onGoalKeyDown}
                  aria-label="搜索目标"
                />
                <div className="tc-goal-list" role="listbox" aria-label="目标列表">
                  {goalMenu.map((entry, i) => (
                    <button
                      type="button"
                      key={entry.key ?? '__all__'}
                      role="option"
                      aria-selected={goalFilter === entry.key}
                      className={`tc-goal-opt${goalFilter === entry.key ? ' on' : ''}${i === goalCursor ? ' cursor' : ''}`}
                      title={entry.title}
                      onClick={() => chooseGoal(entry.key)}
                      onMouseEnter={() => setGoalCursor(i)}
                    >
                      <span className="tc-goal-opt-label">{entry.label}</span>
                      <span className="tc-pill-cnt">{entry.count}</span>
                    </button>
                  ))}
                  {/* 目标一条都没匹配上时说清是"搜不到"，不是"这里什么都没有" */}
                  {goalMenu.length === 0 && <div className="tc-goal-none">没有匹配的目标</div>}
                </div>
              </div>
            )}
          </div>
          )}
          <input
            className="tc-search"
            placeholder="🔍 搜任务 id / 标题…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {hubMode && (
            <span className="tc-src" title="数据源：team-hub v2（SQLite，真分区）">🟢 中枢 {scope ? `「${scope}」` : '全部空间'}</span>
          )}
        </div>
      </div>

      {/* 将军视角条（原「指挥总览」分组语义并入看板：点选即过滤泳道卡片，不改变泳道结构） */}
      <div className="panel tc-summary">
        <span className="tc-sum-title">📊 视角</span>
        {TC_VIEWS.map(v => (
          <button
            key={v.id}
            className={`tc-sum-chip as-btn${view === v.id ? ' on' : ''}${v.id === 'decide' && viewCounts.decide > 0 ? ' alert' : ''}`}
            style={view === v.id ? { color: v.tone } : undefined}
            onClick={() => switchView(v.id)}
            title={v.id === 'all'
              ? '全部任务：完整泳道（六个状态列全展开）'
              : `只看「${v.label}」：${v.statuses.map(s => STATUS_TEXT[s]).join(' + ')}（再点一次「📊 全部」恢复）`}
          >
            {v.icon} {v.label} {viewCounts[v.id]}
          </button>
        ))}
        <span className="tc-sum-break">
          🟡 待验收 {summary.in_review} · 🔴 受阻 {summary.blocked} · ⛔ 已取消 {summary.canceled}
        </span>
        <span className="tc-sum-total">共 {(rows ?? []).length} 任务{hubMode ? (isAll ? ' · 跨全部空间' : '') : ''}</span>
      </div>

      {/* 角色/岗位过滤条 */}
      {(roles.length > 0 || clearLink !== null || (visible.length === 0 && rows !== null)) && (
        <div className="panel tc-filter">
          <span className="tc-filter-label">👥 岗位/执行者</span>
          <div className="tc-pills">
            <button className={`tc-pill${roleFilter === null ? ' on' : ''}`} onClick={() => setRoleFilter(null)}>
              全部
            </button>
            {roleOptions}
          </div>
          {clearLink}
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
          当前{scope ? `工作空间「${spaceName(scope)}」` : '工作空间（全部空间）'}暂无任务。
          <br />
          用底部「🎯 发布目标」自动生成阶段任务链，或「＋ 新建任务」开始。
        </div>
      )}

      {rows !== null && !loadErr && rows.length > 0 && (
        <div className="panel tc-board" ref={boardRef}>
          {lanes.map(col => (
            <div
              key={col.status}
              className={`tc-col tc-col-${col.status}${dropCol === col.status ? ' drop' : ''}${busyDrop ? ' busy' : ''}${view !== 'all' && col.items.length === 0 ? ' dim' : ''}`}
              onDragOver={e => onDragOverCol(e, col.status)}
              onDragLeave={() => setDropCol(prev => (prev === col.status ? null : prev))}
              onDrop={e => onDropCol(e, col.status)}
            >
              {groupHead(col.label, col.icon, col.items.length)}
              <div className="tc-cards">
                {col.items.length > 0
                  ? col.items.map(renderCard)
                  : col.hidden > 0
                    ? <div className="tc-empty">（{col.hidden} 个不在当前视角）</div>
                    : renderLaneEmpty()}
              </div>
            </div>
          ))}
        </div>
      )}

      {rows !== null && !loadErr && visible.length === 0 && (query !== '' || roleFilter !== null || goalFilter !== null || view !== 'all') && (
        <div className="panel" style={{ padding: 16, color: 'var(--muted-2)', fontSize: 12 }}>
          没有符合当前条件的任务
          {view !== 'all' ? `（视角：${TC_VIEWS.find(v => v.id === view)?.label ?? ''}）` : ''}
          {goalFilter ? `（目标：${goalFilterWording ?? goalFilter}）` : ''}
          {roleFilter ? `（岗位：${roleFilter}）` : ''}
          —— 清空搜索/岗位/目标过滤，或点「📊 全部」恢复完整泳道
        </div>
      )}

      {detailId && (
        <TaskDetailModal
          taskId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={reload}
          onContactAgent={onContactAgent}
        />
      )}

      {/* 往回拖（重做 / 打回）：改动点必填；收齐后由对话框调 /api/rework（重做）或 rejectTask（打回） */}
      {dropAsk && (
        <ReworkModal
          task={{ id: dropAsk.item.id, title: dropAsk.item.title, role: dropAsk.item.role }}
          intent={dropAsk.intent}
          scope={dropAsk.item.scope ?? scope}
          ifVersion={dropAsk.item.version}
          by={bindOf(dropAsk.item)}
          onClose={() => setDropAsk(null)}
          onDone={reload}
        />
      )}
    </div>
  )
}

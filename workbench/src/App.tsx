import { useCallback, useEffect, useRef, useState } from 'react'
import {
  countNotifyUnread,
  fetchExec,
  fetchGoal,
  fetchHubActivity,
  fetchHubMissions,
  fetchHubTasks,
  fetchChatHealth,
  fetchProvision,
  fetchRoster,
  fetchSpaces,
  hubBase,
  probeHub,
  publishGoal,
  setExec,
  setGoalContext,
  setGoalStatus,
  subscribeHubAudit,
} from './api'
import type { ProvisionCheck } from './api'
import { createSceneController } from './scene/sceneController'
import type { SceneCue, SceneFacts } from './scene/sceneState'
import { buildMissions } from './missions'
import { boardFromHubTasks } from './hubBoard'
import type { ActivityEvent, BoardData, GoalInfo, GoalStatus, Mission, RosterAgent, SpaceInfo } from './types'
import { WorkspaceNavigation } from './components/WorkspaceNavigation'
import { AgentWorkspace } from './components/AgentWorkspace'
import { WorkspaceSettings } from './components/WorkspaceSettings'
import { UiIcon } from './components/UiIcon'
import { agentKey, NAV_GROUPS, SUB_NAV } from './navigation'
import type { TaskViewId } from './navigation'
import { CenterPanel } from './components/CenterPanel'
import { SpaceOverview } from './components/SpaceOverview'
import { MissionPanel } from './components/MissionPanel'
import { ActivityFeed } from './components/ActivityFeed'
import { QuickTools } from './components/QuickTools'
import { CommandBar } from './components/CommandBar'
import { SkillsPanel } from './components/SkillsPanel'
import { RulesPanel } from './components/RulesPanel'
import { ChatView } from './components/ChatView'
import { FilesView } from './components/FilesView'
import { BrowserView } from './components/BrowserView'
import { CalendarView } from './components/CalendarView'
import { NotifyView } from './components/NotifyView'
import { SnapshotView } from './components/SnapshotView'
import { TaskCenterView } from './components/TaskCenterView'
import { NewSpaceModal } from './components/NewSpaceModal'
import { SpaceSettingsModal } from './components/SpaceSettingsModal'
import { ToastHost, toast } from './components/Toast'
import { LoginView, useIdentityGate } from './components/LoginView'
import { hasSession, setSessionExpiredHandler } from './identity'

type ConnState = 'connecting' | 'live' | 'error'

const MAX_ACTIVITY = 80

export default function App(): React.JSX.Element {
  // 账号会话的门。只在 Hub **要求**远程鉴权时才会拦（见 `useIdentityGate`）：
  // 本机单机部署时它恒为 false，指挥台与加登录墙之前逐字相同。
  const { status: identityStatus } = useIdentityGate()
  const [signedOut, setSignedOut] = useState(false)
  useEffect(() => {
    // 令牌过期且刷新失败时回到登录页。没有这条，一个开着页面过夜的人会
    // 拿到一片 401，而界面上**没有任何地方**能让他重新登录。
    setSessionExpiredHandler(() => setSignedOut(true))
    return () => setSessionExpiredHandler(null)
  }, [])

  const [board, setBoard] = useState<BoardData | null>(null)
  const [missions, setMissions] = useState<Mission[]>([])
  const [scopeAware, setScopeAware] = useState(false)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [scope, setScope] = useState<string | null>(null)
  const [hubMode, setHubMode] = useState(false)
  const [hubSpaces, setHubSpaces] = useState<SpaceInfo[]>([])
  const [roster, setRoster] = useState<RosterAgent[] | null>(null)
  const [sceneFacts, setSceneFacts] = useState<SceneFacts | null>(null)
  const [sceneCues, setSceneCues] = useState<SceneCue[]>([])
  const [sceneError, setSceneError] = useState('')
  const sceneRefreshRef = useRef<(() => Promise<void>) | null>(null)
  const [goalInfo, setGoalInfo] = useState<GoalInfo | null>(null)
  const [execEnabled, setExecEnabled] = useState(false)
  const [execDaemonOnline, setExecDaemonOnline] = useState(false)
  const [showNewSpace, setShowNewSpace] = useState(false)
  const [spaceSettings, setSpaceSettings] = useState<SpaceInfo | null>(null)
  const [conn, setConn] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [active, setActive] = useState(() => {
    try { const saved = localStorage.getItem('legion.workspace.page'); return saved && (saved === 'chat' || NAV_GROUPS.some(g => g.target === saved || SUB_NAV[g.id].some(n => n.id === saved))) ? saved : 'home' } catch { return 'home' }
  })
  const [selectedAgent, setSelectedAgent] = useState<RosterAgent | null>(null)
  const [taskView, setTaskView] = useState<TaskViewId>('all')
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** 通知未读徽标（S7 ← R-B2）：通知面板打开时由 NotifyView 实时上报，否则本组件低频刷新。 */
  const [notifyUnread, setNotifyUnread] = useState(0)
  const labelsRef = useRef<Record<string, string>>({})
  useEffect(() => { try { localStorage.setItem('legion.workspace.page', active) } catch { /* 存储不可用不影响导航 */ } }, [active])
  useEffect(() => {
    if (!hubMode) return
    let cancelled = false
    try {
      const saved = JSON.parse(localStorage.getItem('legion.workspace.agent') ?? 'null') as unknown
      if (Array.isArray(saved) && saved.length === 2 && saved.every(x => typeof x === 'string')) {
        void fetchRoster(saved[0]).then(rows => { if (!cancelled) setSelectedAgent(rows.agents.find(a => a.scope === saved[0] && a.role === saved[1]) ?? null) }).catch(() => { if (!cancelled) setSelectedAgent(null) })
      }
    } catch { /* 已损坏的缓存不选择 Agent */ }
    return () => { cancelled = true }
  }, [hubMode])

  /**
   * 任务集加载：**中枢（team-hub v2，真 scope 分区）是唯一数据源**。
   * v1 看板那条链路已整条取消，所以这里没有"探测不到就回退"的分支。
   */
  const loadMissions = useCallback(async (scopeValue: string | null): Promise<void> => {
    try {
      const resp = await fetchHubMissions(scopeValue)
      setMissions(resp.missions)
      setScopeAware(resp.scopeAware)
    } catch {
      // 服务端无该接口或中枢读取失败：清空服务端数据，由 missionsShown 回退客户端聚合
      setMissions([])
      setScopeAware(false)
    }
  }, [])

  useEffect(() => {
    let disposed = false

    const load = async (): Promise<void> => {
      try {
        // 中枢是**唯一**的数据源：探测不到就明确报「中枢不可达」。
        // 这里从前还有一段"回退到 v1 看板只读模式"的分支，已随那条被取消的链路一起删掉了 ——
        // 那种回退会把"中枢没起来"显示成"有一份任务的旧快照"，用户看到的是**假数据**。
        if (!(await probeHub())) {
          if (disposed) return
          setHubMode(false)
          setConn('error')
          setError(`未探测到中枢 ${hubBase()} 的响应`)
          return
        }
        const [tasks, spaces, hubActs] = await Promise.all([
          fetchHubTasks(null),
          fetchSpaces(),
          fetchHubActivity({ limit: MAX_ACTIVITY }),
        ])
        if (disposed) return
        setHubMode(true)
        setHubSpaces(spaces)
        // 首屏保持「全部空间」语义；用户切换空间时再按 scope 拉专属数据。
        setScope(null)
        setBoard(boardFromHubTasks(tasks))
        setActivity(hubActs.map(ev => ({ ts: ev.ts, kind: ev.action, taskId: ev.taskId ?? undefined, text: `${ev.member} · ${ev.action}` })))
        setConn('live')
        setError('')
        const hubMissions = await fetchHubMissions(null)
        setMissions(hubMissions.missions)
        setScopeAware(hubMissions.scopeAware)
      } catch (e) {
        if (disposed) return
        setConn('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    }

    void load()

    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 看板/中枢/空间变化时同步刷新任务集（顺带刷目标进度/自动收尾状态，多目标并发下随任务推进更新）
  useEffect(() => {
    if (conn === 'live' && board) {
      void loadMissions(scope)
      if (hubMode && scope) {
        void fetchGoal(scope)
          .then(info => setGoalInfo(info))
          .catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, scope, hubMode])

  // 中枢模式下按空间拉专属编队（每空间不同智能体；编队只来自 team-hub）
  useEffect(() => {
    if (!hubMode) {
      setRoster(null)
      return
    }
    let cancelled = false
    void fetchRoster(scope)
      .then(resp => {
        if (!cancelled) setRoster(resp.agents)
      })
      .catch(() => {
        if (!cancelled) setRoster(null)
      })
    return () => {
      cancelled = true
    }
  }, [hubMode, scope])

  useEffect(() => {
    setSceneFacts(null)
    setSceneCues([])
    setSceneError('')
    if (!hubMode || !scope || active !== 'team-scene') {
      sceneRefreshRef.current = null
      return
    }
    const controller = createSceneController({
      scope, subscribe: subscribeHubAudit, fetchRoster, fetchTasks: fetchHubTasks,
      onSnapshot: (facts, cues) => {
        setSceneFacts(facts)
        setSceneCues(cues)
        setRoster([...facts.roster])
      },
      onError: setSceneError,
      visible: () => document.visibilityState === 'visible',
    })
    controller.start()
    sceneRefreshRef.current = controller.refresh
    const onVisible = (): void => { if (document.visibilityState === 'visible') void controller.refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller.stop()
      document.removeEventListener('visibilitychange', onVisible)
      sceneRefreshRef.current = null
    }
  }, [hubMode, scope, active])

  // 中枢模式下按空间拉全部目标（多目标并发：每目标带 status/version + 各自链进度）
  useEffect(() => {
    if (!hubMode) {
      setGoalInfo(null)
      return
    }
    let cancelled = false
    void fetchGoal(scope)
      .then(info => {
        if (!cancelled) setGoalInfo(info)
      })
      .catch(() => {
        if (!cancelled) setGoalInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [hubMode, scope])

  // 中枢模式下按空间拉持续执行编排开关
  useEffect(() => {
    if (!hubMode || !scope) {
      setExecEnabled(false)
      setExecDaemonOnline(false)
      return
    }
    let cancelled = false
    void Promise.all([fetchExec(scope), fetchChatHealth(scope)])
      .then(([s, health]) => {
        if (!cancelled) {
          setExecEnabled(s.enabled)
          setExecDaemonOnline(health.online)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExecEnabled(false)
          setExecDaemonOnline(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [hubMode, scope])

  // 通知未读徽标（S7 ← R-B2 / TC-S7-01/07）：有具体空间即拉 hub audit 列表按白名单 + 本地已读游标计数
  // （与 NotifyView 面板共用 countNotifyUnread 口径，数据源同为 GET /api/activity，无第三数据源）；
  // 通知面板打开时由 NotifyView 实时上报未读数，本 effect 暂停自身刷新避免重复拉取
  useEffect(() => {
    if (!hubMode || !scope) {
      setNotifyUnread(0)
      return
    }
    if (active === 'notify') return
    let cancelled = false
    const refresh = (): void => {
      fetchHubActivity({ scope, limit: 200 })
        .then(rows => {
          if (!cancelled) setNotifyUnread(countNotifyUnread(rows, scope))
        })
        .catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 20000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubMode, scope, active])

  const handleToggleExec = useCallback((enabled: boolean): void => {
    if (!hubMode || !scope) return
    void setExec(scope, enabled)
      .then(() => {
        setExecEnabled(enabled)
        toast('ok', enabled ? '⚡ 持续执行已开启：分析类阶段任务将自动派给 AI 执行' : '⏸ 持续执行已关闭')
      })
      .catch((e: unknown) => toast('err', e instanceof Error ? e.message : String(e)))
  }, [hubMode, scope])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      // 中枢是唯一数据源（v1 看板那条取数分支已随那条被取消的链路一起删除）。
      const [tasks, acts, spaces] = await Promise.all([
        fetchHubTasks(scope),
        fetchHubActivity({ scope: scope ?? undefined, limit: MAX_ACTIVITY }),
        fetchSpaces(),
      ])
      setBoard(boardFromHubTasks(tasks))
      setActivity(acts.map(ev => ({ ts: ev.ts, kind: ev.action, taskId: ev.taskId ?? undefined, text: `${ev.member} · ${ev.action}` })))
      setHubSpaces(spaces)
      await sceneRefreshRef.current?.()
      await loadMissions(scope)
    } catch {
      /* 保持现有数据 */
    } finally {
      setRefreshing(false)
    }
  }

  const selectScope = useCallback((next: string | null): void => {
    setScope(next)
    void loadMissions(next)
  }, [loadMissions])
  const pickAgent = useCallback((agent: RosterAgent): void => {
    setSelectedAgent(agent)
    setActive('agents')
    try { localStorage.setItem('legion.workspace.agent', agentKey(agent.scope ?? '', agent.role)) } catch { /* 存储不可用不影响当前会话 */ }
  }, [])
  const refreshSelectedAgent = useCallback((agents: RosterAgent[]): void => {
    setSelectedAgent(previous => previous ? agents.find(a => agentKey(a.scope ?? '', a.role) === agentKey(previous.scope ?? '', previous.role)) ?? null : null)
  }, [])
  const contactAgent = useCallback((spaceId: string, role: string): void => {
    void fetchRoster(spaceId).then(rows => {
      const agent = rows.agents.find(a => a.scope === spaceId && a.role === role)
      if (agent) { selectScope(spaceId); pickAgent(agent) }
      else toast('info', '该执行者当前不在空间 Agent 编队中')
    }).catch(e => toast('err', e instanceof Error ? e.message : String(e)))
  }, [pickAgent, selectScope])

  const handleSpaceCreated = useCallback((spaceId: string): void => {
    setShowNewSpace(false)
    void fetchSpaces()
      .then(spaces => setHubSpaces(spaces))
      .catch(() => undefined)
    selectScope(spaceId)
  }, [selectScope])

  /** 空间设置保存后：关闭弹窗并从 team-hub 重拉空间列表（含仓库绑定）。 */
  const handleSpaceSaved = useCallback((): void => {
    setSpaceSettings(null)
    void fetchSpaces()
      .then(spaces => setHubSpaces(spaces))
      .catch(() => undefined)
  }, [])

  /** 空间删除成功后（R-3/S8，TC-S8-05/06）：关闭弹窗、重拉列表；若删的是当前激活空间则切回「全部空间」（scope=null）。 */
  const handleSpaceDeleted = useCallback((deletedId: string): void => {
    setSpaceSettings(null)
    void fetchSpaces()
      .then(spaces => setHubSpaces(spaces))
      .catch(() => undefined)
    if (scope === deletedId) {
      setScope(null)
      void loadMissions(null)
    }
  }, [scope, loadMissions])

  /** 发布目标：写 team-hub 后刷新目标列表。每次发布 = 新建一个目标（与既有目标并存，不取消旧链）。 */
  const handlePublishGoal = useCallback(async (scopeValue: string, objective: string, workflowDefinition?: { id: string; version: number }): Promise<void> => {
    // publishGoal 失败向上抛 → GoalModal 捕获并 toast（弹窗保留，可改后重试）
    await publishGoal(scopeValue, objective, undefined, workflowDefinition)
    try {
      const info = await fetchGoal(scopeValue)
      setGoalInfo(info)
    } catch {
      // 目标其实已发布，仅刷新失败：不阻塞关闭，提示手动刷新
      toast('info', '目标已发布，但刷新目标列表失败，请手动刷新页面')
    }

    // ★ BUG-016/A：发布之后**立刻**说清"这个空间现在到底会不会自动开工"。
    //
    //   实测（业主那台机器）：目标发布成功、8 条链任务也建对了，却因为
    //   「空间未开通执行 / 没有守护实例服务这个空间」静默停在 todo 十几个小时，
    //   而界面只说了一句「已发布目标」。将军能看到的只有"发布成功了"。
    //
    //   判定用服务端的**开通预检**（`GET /api/spaces/provision`）—— 那是权威口径，
    //   不在这里另写一套；两套判定迟早会给出不同答案，而将军只能看到其中一个。
    let blocked: ProvisionCheck[] = []
    try {
      const p = await fetchProvision(scopeValue)
      blocked = (p.checks ?? []).filter(c => c.level === 'error')
    } catch {
      // 预检拿不到**不吓唬人**：目标确实已经发布成功，这两件事要分开说。
      blocked = []
    }
    if (blocked.length > 0) {
      const first = blocked[0]
      const more = blocked.length > 1 ? `（另有 ${blocked.length - 1} 项）` : ''
      toast('info', `⚠ 目标已发布，但**这个空间现在不会自动开工**：${first.message}${more}`
        + (first.fix ? ` → 修复：${first.fix}` : '')
        + '（链任务已建好，开通执行 / 守护上线后会自动认领，不必重发）')
      return
    }
    toast('ok', '🎯 已发布目标（与既有目标并存，自动生成独立任务链）')
  }, [])

  /** 目标状态迁移（暂停/恢复/取消，仅将军）：成功后刷新目标列表并提示。
   *  取消目标时若该目标还有在办/待验收任务（不会被处决），服务端会逐条留痕 + 挂 hold，
   *  这里把数量与任务号一并提示——否则这类任务会静默躺在「待我决定」里没人知道要处理。 */
  const handleGoalStatus = useCallback(async (goalId: string, status: GoalStatus, label: string): Promise<void> => {
    if (!scope) return
    try {
      const r = await setGoalStatus(scope, goalId, status)
      const info = await fetchGoal(scope)
      setGoalInfo(info)
      const stranded = Array.isArray(r?.task?.strandedTasks) ? r.task.strandedTasks : []
      toast('ok', stranded.length > 0
        ? `${label}目标成功；${stranded.length} 个在办任务已留痕并挂起（${stranded.join('、')}）——请到任务详情裁决：验收 / 取消 / 转派`
        : `${label}目标成功`)
    } catch (e) {
      toast('err', e instanceof Error ? e.message : String(e))
    }
  }, [scope])

  /** 保存目标共享上下文（仅将军）：bump contextVersion，守护「下一派工」按新版本对齐；成功后刷新目标列表并提示。 */
  const handleGoalContext = useCallback(async (goalId: string, text: string): Promise<void> => {
    if (!scope) return
    await setGoalContext(scope, goalId, text)
    const info = await fetchGoal(scope)
    setGoalInfo(info)
    toast('ok', `📄 目标上下文已保存（v${info.goals.find(g => g.id === goalId)?.contextVersion ?? '?'}），下一派工对齐`)
  }, [scope])

  /** 打开新建空间弹窗；中枢不可达时先探测一次，失败则给出启动引导而非静默失败。 */
  const openNewSpace = useCallback((): void => {
    if (hubMode) {
      setShowNewSpace(true)
      return
    }
    void probeHub().then(ok => {
      if (ok) {
        setHubMode(true)
        void fetchSpaces()
          .then(spaces => setHubSpaces(spaces))
          .catch(() => undefined)
        setShowNewSpace(true)
      } else {
        toast('err', '新建空间需要 team-hub v2 中枢。请先启动 node team-hub/server.mjs（:8787），再点右上角「🧭 中枢」检查')
      }
    })
  }, [hubMode])

  // ── 会话门 ────────────────────────────────────────────────────────────────
  //
  // ★ 它必须排在下面那两个 `conn` 提前返回**之前**。
  //
  // 实测踩过：Hub 要求远程鉴权、而浏览器手上没有会话时，每一个请求都是 401，
  // `conn` 于是变成 `error`——界面显示「无法连接中枢 …，
  // 错误：401 Unauthorized」，外加一句"请去启动数据源"。**那是句错话**：中枢好好的，
  // 用户只是还没登录，而他会照着那句话去起一个本地的开发服务端。
  //
  //   > 一个把"你还没登录"说成"连不上、请去启动服务"的界面，
  //   > 会把人送去修一个没坏的东西——而真正该做的那一件事（登录）
  //   > 在屏幕上根本没有出现。
  //
  // 与手机端 `deriveConnectionState` 里那条「未登录 ≠ Hub 不可达」是同一族问题，
  // 修法也一样：把判据放在**更靠前**的位置，让更准确的结论先说话。
  const gateOn = identityStatus !== null
    && identityStatus.enabled === true
    && identityStatus.remoteAuthRequired === true
    && !hasSession()
  if (gateOn || signedOut) {
    return (
      <LoginView
        status={identityStatus ?? { ok: false, enabled: false, bootstrapped: true, remoteAuthRequired: true, registration: 'closed' }}
        onSignedIn={() => {
          // ★ 登录成功后**整页重载**，而不是就地复位状态。
          //
          // 本组件的数据 effect 全在挂载时跑过一遍，而那一遍是在**令牌还不存在**
          // 的时候跑的——它们全都拿到了 401。就地重跑意味着要挨个改十几个
          // effect 让它们依赖一个"会话版本号"，而**下一个**新加的 effect
          // 不会记得这件事，于是表现为"登录之后某一个面板永远是空的"。
          //
          // 登录是低频动作，一次整页重载买的是"每一个 effect 都必然带着新令牌
          // 重跑一遍"，这条保证比省下的那一次加载值钱。
          //
          // 也**不**在这里清会话：`LoginView` 刚刚把新令牌存进去，清掉就白登了。
          // 失效那条路上的清理由 `recoverSession` 负责。
          window.location.reload()
        }}
      />
    )
  }

  if (conn === 'connecting') {
    return (
      <div className="state-box">
        <div>⏳ 正在连接中枢 {hubBase()} …</div>
      </div>
    )
  }

  if (conn === 'error') {
    return (
      <div className="state-box">
        <div className="err">✕ 无法连接中枢 {hubBase()}</div>
        <div style={{ fontSize: 12 }}>错误：{error}</div>
        <div style={{ fontSize: 12, lineHeight: 1.9 }}>
          1. 确认中枢 team-hub v2 已启动，且本页的 <code>{hubBase()}</code> 指向它（默认走同源 <code>/hub</code> 反代）。
          <br />
          2. 中枢在别处时：在浏览器控制台执行
          <code>localStorage.setItem('legion.workbench.hub', 'http://127.0.0.1:8787')</code>
          后刷新页面。
          <br />
          说明：v1 看板那条数据源已**整条取消**，这里不再有任何回退 —— 中枢不可达就是「没有数据」，
          不会退回去显示一份过期快照。
        </div>
        <button className="btn primary" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    )
  }

  const labels = labelsRef.current
  const displayBoard = board ?? (hubMode ? boardFromHubTasks([]) : null)
  const missionsShown = missions.length > 0 ? missions : displayBoard ? buildMissions(displayBoard, labels) : []

  return (
    <div className="app workspace-app">
      <div className="workspace-shell">
          <WorkspaceNavigation
          active={active}
          scope={scope}
          hubMode={hubMode}
          spaces={hubSpaces}
          onNavigate={setActive}
          onSelectScope={selectScope}
          onNewSpace={openNewSpace}
          onSpaceSettings={s => setSpaceSettings(s)}
          notifyUnread={notifyUnread}
          selectedAgent={selectedAgent}
          onPickAgent={pickAgent}
          onAgentsRefreshed={refreshSelectedAgent}
          taskView={taskView}
          onTaskView={setTaskView}
          open={navigationOpen}
          onClose={() => setNavigationOpen(false)}
        />
        <section className="workspace-stage">
        <div className="mobile-workspace-toolbar"><button className="ui-icon-button" aria-label="打开侧栏导航" onClick={() => setNavigationOpen(true)}><UiIcon name="menu" /></button><span>Legion 协作台</span></div>
        <div className={`workspace-page${active === 'team-scene' && scope ? ' workspace-overview' : ''}`}>
        {displayBoard ? (
          active === 'home' || (active === 'team-scene' && !scope) ? (
            <SpaceOverview scope={scope} spaces={hubSpaces} hubMode={hubMode} scenePicker={active === 'team-scene'} onSelectSpace={selectScope} onNavigate={page => { if (page === 'agents') { setSelectedAgent(null); try { localStorage.removeItem('legion.workspace.agent') } catch { /* 当前导航不依赖持久化 */ } }; setActive(page) }} />
          ) : active === 'agents' ? (
            <AgentWorkspace key={selectedAgent ? agentKey(selectedAgent.scope ?? '', selectedAgent.role) : 'unselected'} agent={selectedAgent} hubMode={hubMode} spaces={hubSpaces} roster={roster} onContactAgent={contactAgent} onModelSettings={() => { if (selectedAgent?.scope) selectScope(selectedAgent.scope); setActive('settings-models') }} />
          ) : active.startsWith('settings-') ? (
            <WorkspaceSettings active={active} scope={scope} spaces={hubSpaces} roster={roster} hubMode={hubMode} execEnabled={execEnabled} execDaemonOnline={execDaemonOnline} onToggleExec={handleToggleExec} onNewSpace={openNewSpace} onSpaceSettings={s => setSpaceSettings(s)} />
          ) : active === 'activity-feed' ? (
            <div className="center-col workspace-activity"><ActivityFeed events={activity} /></div>
          ) : active === 'tasks' ? (
            <TaskCenterView
              scope={scope}
              hubMode={hubMode}
              spaces={hubSpaces}
              onSelectScope={selectScope}
              onDataChanged={() => void loadMissions(scope)}
              selectedView={taskView}
              onViewChange={setTaskView}
              onContactAgent={contactAgent}
            />
          ) : active === 'skills' ? (
            <SkillsPanel scope={scope} hubMode={hubMode} spaces={hubSpaces} />
          ) : active === 'rules' ? (
            <RulesPanel scope={scope} hubMode={hubMode} spaces={hubSpaces} onOpenFiles={() => setActive('files')} />
          ) : active === 'chat' ? (
            <ChatView scope={scope} hubMode={hubMode} spaces={hubSpaces} onPickScope={(s) => selectScope(s)} />
          ) : active === 'files' ? (
            <FilesView scope={scope} hubMode={hubMode} spaces={hubSpaces} onOpenSettings={s => setSpaceSettings(s)} />
          ) : active === 'browser' ? (
            <BrowserView scope={scope ?? ''} />
          ) : active === 'calendar' ? (
            <CalendarView scope={scope} hubMode={hubMode} onGoHome={() => setActive('home')} />
          ) : active === 'notify' ? (
            <NotifyView
              scope={scope}
              hubMode={hubMode}
              onUnreadChange={setNotifyUnread}
              onGoHome={() => setActive('home')}
            />
          ) : active === 'snapshots' ? (
            <SnapshotView scope={scope} hubMode={hubMode} />
          ) : (
            <CenterPanel board={displayBoard} labels={labels} active={active === 'goals' ? 'goals' : 'home'} rosterAgents={hubMode ? roster : null} scope={scope} spaces={hubSpaces} goalInfo={hubMode ? goalInfo : null} hubActive={hubMode} sceneFacts={sceneFacts?.scope === scope ? sceneFacts : null} sceneCues={sceneCues} sceneError={sceneError} onGoalStatus={hubMode ? handleGoalStatus : undefined} onSaveContext={hubMode ? handleGoalContext : undefined} onContactAgent={pickAgent} />
          )
        ) : (
          <div className="center-col" />
        )}
        {active === 'team-scene' && scope && <div className="right-col">
          <MissionPanel missions={missionsShown} scopeAware={scopeAware} scope={scope} hubMode={hubMode} onDataChanged={() => void loadMissions(scope)} />
          <ActivityFeed events={activity} />
          <QuickTools onRefresh={() => void refresh()} refreshing={refreshing} onOpenModule={setActive} />
        </div>}
        </div>
      {['goals', 'tasks'].includes(active) && <CommandBar
        board={displayBoard}
        activity={activity}
        labels={labels}
        scope={scope}
        hubMode={hubMode}
        goalCount={hubMode ? (goalInfo?.goals.filter(g => g.status === 'active' || g.status === 'paused').length ?? 0) : 0}
        spaceName={scope ? hubSpaces.find(s => s.id === scope)?.name ?? scope : undefined}
        onPublishGoal={hubMode ? handlePublishGoal : undefined}
        roster={hubMode ? roster : null}
        onOpenCalendar={() => setActive('calendar')}
      />}
      </section>
      </div>
      {showNewSpace && <NewSpaceModal onClose={() => setShowNewSpace(false)} onCreated={handleSpaceCreated} />}
      {spaceSettings && <SpaceSettingsModal space={spaceSettings} onClose={() => setSpaceSettings(null)} onSaved={handleSpaceSaved} onDeleted={handleSpaceDeleted} />}
      <ToastHost />
    </div>
  )
}

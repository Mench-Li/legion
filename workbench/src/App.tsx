import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiBase,
  countNotifyUnread,
  fetchActivity,
  fetchBoard,
  fetchConfig,
  fetchExec,
  fetchGoal,
  fetchHubActivity,
  fetchHubMissions,
  fetchHubTasks,
  fetchChatHealth,
  fetchMissions,
  fetchRoster,
  fetchSpaces,
  probeHub,
  publishGoal,
  setExec,
  setGoalContext,
  setGoalStatus,
  subscribeActivity,
  subscribeBoard,
  subscribeHubAudit,
} from './api'
import { createSceneController } from './scene/sceneController'
import type { SceneCue, SceneFacts } from './scene/sceneState'
import { buildMissions, labelsFromPipeline } from './missions'
import { boardFromHubTasks } from './hubBoard'
import { activityFingerprint } from './dedupe'
import type { ActivityEvent, ApiConfig, BoardData, GoalInfo, GoalStatus, Mission, RosterAgent, SpaceInfo } from './types'
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

type ConnState = 'connecting' | 'live' | 'error'

const MAX_ACTIVITY = 80

export default function App(): React.JSX.Element {
  const [board, setBoard] = useState<BoardData | null>(null)
  const [missions, setMissions] = useState<Mission[]>([])
  const [scopeAware, setScopeAware] = useState(false)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [paused, setPaused] = useState(false)
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
  const [, setConfig] = useState<ApiConfig | null>(null)
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
  const seenEvents = useRef<Set<string>>(new Set())
  const hubModeRef = useRef(false)
  hubModeRef.current = hubMode
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

  // v1 activity 事件内容指纹（P2-3 S6：实现统一在 ../dedupe.ts，供单测锁定与组件共用）
  const eventKey = (ev: ActivityEvent): string => activityFingerprint(ev)

  /**
   * 任务集加载：中枢（team-hub v2，真 scope 分区）优先，否则 serve.mjs v1（无分区）。
   * 中枢探测在挂载后异步进行，探测成功即切换（hubMode → 自动重载）。
   */
  const loadMissions = useCallback(async (scopeValue: string | null): Promise<void> => {
    try {
      const resp = hubMode ? await fetchHubMissions(scopeValue) : await fetchMissions(scopeValue)
      setMissions(resp.missions)
      setScopeAware(resp.scopeAware)
    } catch {
      // 服务端无该接口或探测失败：清空服务端数据，由 missionsShown 回退客户端聚合
      setMissions([])
      setScopeAware(false)
    }
  }, [hubMode])

  useEffect(() => {
    let disposed = false

    const load = async (): Promise<void> => {
      try {
        // v2 是主数据源：只要中枢可达，首屏不再依赖 4820 v1 看板。
        if (await probeHub()) {
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
          seenEvents.current = new Set()
          setConn('live')
          setError('')
          const hubMissions = await fetchHubMissions(null)
          setMissions(hubMissions.missions)
          setScopeAware(hubMissions.scopeAware)
          return
        }
        const [cfg, bd, acts] = await Promise.all([fetchConfig(), fetchBoard(), fetchActivity()])
        if (disposed) return
        setConfig(cfg)
        setPaused(cfg.paused === true)
        labelsRef.current = labelsFromPipeline(cfg.pipeline)
        setBoard(bd)
        seenEvents.current = new Set(acts.map(eventKey))
        setActivity(acts.slice(-MAX_ACTIVITY))
        setConn('live')
        setError('')
        await loadMissions(scope)
      } catch (e) {
        if (disposed) return
        setConn('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    }

    void load()

    const offBoard = subscribeBoard(next => {
      setBoard(next)
      setConn('live')
    })
    const offActivity = subscribeActivity(ev => {
      const key = eventKey(ev)
      if (seenEvents.current.has(key)) return
      seenEvents.current.add(key)
      setActivity(prev => [...prev.slice(-(MAX_ACTIVITY - 1)), ev])
    })

    // 轮询兜底：SSE 断线时看板仍能刷新（低频，开销可忽略）
    const poll = window.setInterval(() => {
      if (hubModeRef.current) return
      void fetchBoard()
        .then(bd => setBoard(bd))
        .catch(() => undefined)
    }, 15000)

    return () => {
      disposed = true
      offBoard()
      offActivity()
      window.clearInterval(poll)
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

  // 中枢模式下按空间拉专属编队（每空间不同智能体；v1 模式回退看板聚合）
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
      if (hubMode) {
        const [tasks, acts, spaces] = await Promise.all([
          fetchHubTasks(scope),
          fetchHubActivity({ scope: scope ?? undefined, limit: MAX_ACTIVITY }),
          fetchSpaces(),
        ])
        setBoard(boardFromHubTasks(tasks))
        setActivity(acts.map(ev => ({ ts: ev.ts, kind: ev.action, taskId: ev.taskId ?? undefined, text: `${ev.member} · ${ev.action}` })))
        setHubSpaces(spaces)
        await sceneRefreshRef.current?.()
      } else {
        const [bd, acts] = await Promise.all([fetchBoard(), fetchActivity()])
        setBoard(bd)
        seenEvents.current = new Set(acts.map(eventKey))
        setActivity(acts.slice(-MAX_ACTIVITY))
      }
      await loadMissions(scope)
    } catch {
      /* 保持现有数据 */
    } finally {
      setRefreshing(false)
    }
  }

  const refreshConfig = useCallback(async (): Promise<void> => {
    try {
      const cfg = await fetchConfig()
      setConfig(cfg)
      setPaused(cfg.paused === true)
    } catch {
      /* 保持现有状态 */
    }
  }, [])

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

  if (conn === 'connecting') {
    return (
      <div className="state-box">
        <div>⏳ 正在连接数据源 {apiBase()} …</div>
        <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
          需先启动 <code>node scrum/serve.mjs --port 4820</code>
        </div>
      </div>
    )
  }

  if (conn === 'error') {
    return (
      <div className="state-box">
        <div className="err">✕ 无法连接数据源 {apiBase()}</div>
        <div style={{ fontSize: 12 }}>错误：{error}</div>
        <div style={{ fontSize: 12, lineHeight: 1.9 }}>
          1. 启动看板服务：
          <code>cd D:\project\DSH\legion &amp;&amp; node scrum\serve.mjs --port 4820</code>
          <br />
          2. 换数据源：刷新页面后加 <code>?api=http://其他主机:4820</code>
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
            <WorkspaceSettings active={active} scope={scope} spaces={hubSpaces} roster={roster} hubMode={hubMode} execEnabled={execEnabled} execDaemonOnline={execDaemonOnline} paused={paused} onToggleExec={handleToggleExec} onPausedChange={() => void refreshConfig()} onNewSpace={openNewSpace} onSpaceSettings={s => setSpaceSettings(s)} />
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
        paused={paused}
        scope={scope}
        hubMode={hubMode}
        onPausedChange={() => void refreshConfig()}
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

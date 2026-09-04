import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiBase,
  fetchActivity,
  fetchBoard,
  fetchConfig,
  fetchExec,
  fetchGoal,
  fetchHubMissions,
  fetchHubScopes,
  fetchMissions,
  fetchRoster,
  fetchSpaces,
  hubBase,
  probeHub,
  publishGoal,
  setExec,
  subscribeActivity,
  subscribeBoard,
} from './api'
import { buildMissions, labelsFromPipeline } from './missions'
import type { ActivityEvent, ApiConfig, BoardData, GoalInfo, Mission, RosterAgent, SpaceInfo } from './types'
import { Sidebar } from './components/Sidebar'
import { KpiBar } from './components/KpiBar'
import { CenterPanel } from './components/CenterPanel'
import { MissionPanel } from './components/MissionPanel'
import { ActivityFeed } from './components/ActivityFeed'
import { QuickTools } from './components/QuickTools'
import { CommandBar } from './components/CommandBar'
import { SkillsPanel } from './components/SkillsPanel'
import { ChatView } from './components/ChatView'
import { FilesView } from './components/FilesView'
import { BrowserView } from './components/BrowserView'
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
  const [goalInfo, setGoalInfo] = useState<GoalInfo | null>(null)
  const [execEnabled, setExecEnabled] = useState(false)
  const [showNewSpace, setShowNewSpace] = useState(false)
  const [spaceSettings, setSpaceSettings] = useState<SpaceInfo | null>(null)
  const [, setConfig] = useState<ApiConfig | null>(null)
  const [conn, setConn] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [active, setActive] = useState('home')
  const [refreshing, setRefreshing] = useState(false)
  const labelsRef = useRef<Record<string, string>>({})
  const seenEvents = useRef<Set<string>>(new Set())

  const eventKey = (ev: ActivityEvent): string => `${ev.ts}|${ev.kind}|${ev.taskId ?? ''}|${ev.text}`

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

    // 中枢探测：team-hub v2 可达则开启真分区模式
    void probeHub().then(ok => {
      if (disposed || !ok) return
      setHubMode(true)
      void fetchHubScopes()
        .then(() => undefined)
        .catch(() => undefined)
      void fetchSpaces()
        .then(spaces => {
          if (!disposed) setHubSpaces(spaces)
        })
        .catch(() => undefined)
    })

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

  // 看板/中枢/空间变化时同步刷新任务集
  useEffect(() => {
    if (conn === 'live' && board) void loadMissions(scope)
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

  // 中枢模式下按空间拉当前目标（objective + 该空间任务进度）
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
      return
    }
    let cancelled = false
    void fetchExec(scope)
      .then(s => {
        if (!cancelled) setExecEnabled(s.enabled)
      })
      .catch(() => {
        if (!cancelled) setExecEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [hubMode, scope])

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
      const [bd, acts] = await Promise.all([fetchBoard(), fetchActivity()])
      setBoard(bd)
      seenEvents.current = new Set(acts.map(eventKey))
      setActivity(acts.slice(-MAX_ACTIVITY))
      if (hubMode) {
        void fetchSpaces()
          .then(spaces => setHubSpaces(spaces))
          .catch(() => undefined)
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

  /** 发布空间目标：写 team-hub 后刷新当前空间目标。 */
  const handlePublishGoal = useCallback(async (scopeValue: string, objective: string): Promise<void> => {
    await publishGoal(scopeValue, objective)
    const info = await fetchGoal(scopeValue)
    setGoalInfo(info)
  }, [])

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
  const missionsShown = missions.length > 0 ? missions : board ? buildMissions(board, labels) : []

  return (
    <div className="app">
      <KpiBar board={board} paused={paused} hubMode={hubMode} hubBase={hubBase()} staffCount={hubMode ? (roster?.length ?? 0) : null} />
      <div className="app-main">
        <Sidebar
          board={board}
          active={active}
          scope={scope}
          hubMode={hubMode}
          spaces={hubSpaces}
          onNavigate={setActive}
          onSelectScope={selectScope}
          onNewSpace={openNewSpace}
          onSpaceSettings={s => setSpaceSettings(s)}
          execEnabled={hubMode && scope ? execEnabled : false}
          execDaemonOnline={false}
          onToggleExec={handleToggleExec}
        />
        {board ? (
          active === 'skills' ? (
            <SkillsPanel scope={scope} hubMode={hubMode} />
          ) : active === 'chat' ? (
            <ChatView scope={scope} hubMode={hubMode} />
          ) : active === 'files' ? (
            <FilesView scope={scope} hubMode={hubMode} spaces={hubSpaces} onOpenSettings={s => setSpaceSettings(s)} />
          ) : active === 'browser' ? (
            <BrowserView />
          ) : (
            <CenterPanel board={board} labels={labels} active={active} rosterAgents={hubMode ? roster : null} scope={scope} spaces={hubSpaces} goalInfo={hubMode ? goalInfo : null} hubActive={hubMode} />
          )
        ) : (
          <div className="center-col" />
        )}
        <div className="right-col">
          <MissionPanel missions={missionsShown} scopeAware={scopeAware} scope={scope} hubMode={hubMode} onDataChanged={() => void loadMissions(scope)} />
          <ActivityFeed events={activity} />
          <QuickTools onRefresh={() => void refresh()} refreshing={refreshing} onOpenModule={setActive} />
        </div>
      </div>
      <CommandBar
        board={board}
        activity={activity}
        labels={labels}
        paused={paused}
        scope={scope}
        hubMode={hubMode}
        onPausedChange={() => void refreshConfig()}
        currentGoal={hubMode ? goalInfo?.objective ?? null : null}
        spaceName={scope ? hubSpaces.find(s => s.id === scope)?.name ?? scope : undefined}
        onPublishGoal={hubMode ? handlePublishGoal : undefined}
        roster={hubMode ? roster : null}
      />
      {showNewSpace && <NewSpaceModal onClose={() => setShowNewSpace(false)} onCreated={handleSpaceCreated} />}
      {spaceSettings && <SpaceSettingsModal space={spaceSettings} onClose={() => setSpaceSettings(null)} onSaved={handleSpaceSaved} />}
      <ToastHost />
    </div>
  )
}

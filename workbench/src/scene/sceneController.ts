import type { HubAuditEvent, HubTask, RosterResponse } from '../types'
import type { HubSseStatus } from '../api'
import { deriveSceneCues } from './sceneState.ts'
import type { SceneCue, SceneFacts } from './sceneState.ts'
import { deriveBoardVisits } from './sceneBoard.ts'
import type { SceneBoardVisit } from './sceneBoard.ts'

const SCENE_ACTIONS = new Set(['create', 'claim', 'transition', 'advance', 'reassign', 'goal:publish', 'agent:create', 'space:add-agents', 'space:remove-agent', 'space:update'])

interface Timers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (id: ReturnType<typeof setInterval>) => void
}

interface SceneControllerOptions {
  scope: string
  subscribe: (onEvent: (event: HubAuditEvent) => void, options: { scope: string; onStatus: (status: HubSseStatus) => void }) => () => void
  fetchRoster: (scope: string) => Promise<RosterResponse>
  fetchTasks: (scope: string) => Promise<HubTask[]>
  /**
   * 每次拿到新快照时回调。三个产物**一起**给，因为它们是同一次比较的结果：
   * `facts` 现状、`cues` 表演提示（庆祝/交接连线）、`visits` 谁现在该去走一趟看板。
   * 分成两次回调会让两批提示的时间窗对不齐（一次认领可能只演了其中一半）。
   */
  onSnapshot: (facts: SceneFacts, cues: SceneCue[], visits: SceneBoardVisit[]) => void
  onError: (message: string) => void
  visible?: () => boolean
  now?: () => number
  timers?: Timers
}

export function createSceneController(options: SceneControllerOptions): { start: () => void; refresh: () => Promise<void>; stop: () => void } {
  const timerHost = globalThis
  const timers = options.timers ?? {
    setTimeout: timerHost.setTimeout.bind(timerHost),
    clearTimeout: timerHost.clearTimeout.bind(timerHost),
    setInterval: timerHost.setInterval.bind(timerHost),
    clearInterval: timerHost.clearInterval.bind(timerHost),
  }
  const now = options.now ?? Date.now
  const visible = options.visible ?? (() => true)
  let running = false
  let epoch = 0
  let refreshVersion = 0
  let previous: SceneFacts | null = null
  let pendingEvents: HubAuditEvent[] = []
  let played = new Set<string>()
  let debounce: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  const refresh = async (): Promise<void> => {
    if (!running) return
    const startedEpoch = epoch
    const request = ++refreshVersion
    const candidates = [...pendingEvents]
    try {
      const [roster, tasks] = await Promise.all([options.fetchRoster(options.scope), options.fetchTasks(options.scope)])
      if (!running || startedEpoch !== epoch || request !== refreshVersion) return
      const current: SceneFacts = { scope: options.scope, roster: roster.agents, tasks }
      const nowMs = now()
      const canSee = visible()
      const cues = deriveSceneCues(previous, current, candidates, nowMs, canSee).filter(cue => {
        if (played.has(cue.id)) return false
        played.add(cue.id)
        return true
      })
      /**
       * ★ 走看板的提示与 `cues` **各自独立**派生（都用同一批事件、同一个时间窗）：
       *   去重只对 `cues` 做（它是"演一次就够"的），而"去取卡"是**动作**——
       *   同一次认领即使已经演过连线，人也还该去板前把卡取下来。
       */
      const visits = deriveBoardVisits(previous, current, candidates, nowMs, canSee)
      if (played.size > 500) played = new Set([...played].slice(-250))
      const consumed = new Set(candidates.map(event => event.seq))
      pendingEvents = pendingEvents.filter(event => !consumed.has(event.seq))
      previous = current
      options.onSnapshot(current, cues, visits)
      options.onError('')
    } catch (error) {
      if (!running || startedEpoch !== epoch || request !== refreshVersion) return
      options.onError(error instanceof Error ? error.message : String(error))
    }
  }

  const schedule = (): void => {
    if (debounce !== null) timers.clearTimeout(debounce)
    debounce = timers.setTimeout(() => { debounce = null; void refresh() }, 220)
  }

  const start = (): void => {
    if (running) return
    running = true
    epoch++
    unsubscribe = options.subscribe(event => {
      if (event.scope !== options.scope || !SCENE_ACTIONS.has(event.action)) return
      pendingEvents.push(event)
      if (pendingEvents.length > 300) pendingEvents = pendingEvents.slice(-300)
      schedule()
    }, { scope: options.scope, onStatus: status => {
      if (status.state === 'open' || status.state === 'reconnected') void refresh()
      else if (status.state === 'reconnecting') options.onError('实时连接中断，正在重连')
    } })
    interval = timers.setInterval(() => { if (visible()) void refresh() }, 20_000)
    void refresh()
  }

  const stop = (): void => {
    if (!running) return
    running = false
    epoch++
    if (debounce !== null) timers.clearTimeout(debounce)
    if (interval !== null) timers.clearInterval(interval)
    unsubscribe?.()
    debounce = null
    interval = null
    unsubscribe = null
  }

  return { start, refresh, stop }
}

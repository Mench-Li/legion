import type { HubAuditEvent, HubTask, RosterResponse } from '../types'
import type { HubSseStatus } from '../api'
import { deriveSceneCues } from './sceneState.ts'
import type { SceneCue, SceneFacts } from './sceneState.ts'

const SCENE_ACTIONS = new Set(['create', 'claim', 'transition', 'advance', 'goal:publish', 'agent:create', 'space:add-agents', 'space:remove-agent', 'space:update'])

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
  onSnapshot: (facts: SceneFacts, cues: SceneCue[]) => void
  onError: (message: string) => void
  visible?: () => boolean
  now?: () => number
  timers?: Timers
}

export function createSceneController(options: SceneControllerOptions): { start: () => void; refresh: () => Promise<void>; stop: () => void } {
  const timers = options.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval }
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
    const candidates = pendingEvents
    pendingEvents = []
    try {
      const [roster, tasks] = await Promise.all([options.fetchRoster(options.scope), options.fetchTasks(options.scope)])
      if (!running || startedEpoch !== epoch || request !== refreshVersion) return
      const current: SceneFacts = { scope: options.scope, roster: roster.agents, tasks }
      const cues = deriveSceneCues(previous, current, candidates, now(), visible()).filter(cue => {
        if (played.has(cue.id)) return false
        played.add(cue.id)
        return true
      })
      if (played.size > 500) played = new Set([...played].slice(-250))
      previous = current
      options.onSnapshot(current, cues)
      options.onError('')
    } catch (error) {
      if (!running || startedEpoch !== epoch || request !== refreshVersion) return
      pendingEvents = [...candidates, ...pendingEvents]
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

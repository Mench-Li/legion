import type { HubAuditEvent, HubTask, RosterAgent } from '../types'

export type SceneMode = 'idle' | 'busy' | 'review' | 'blocked'
export type SceneActivity = SceneMode | 'walk' | 'work' | 'celebrate'

export interface SceneAgent {
  key: string
  scope: string
  role: string
  name: string
  avatar: string
  external: boolean
  mode: SceneMode
  activity: SceneActivity
  taskIds: string[]
  focusTaskId: string | null
  stationId: string
  appearanceSeed: number
  taskCount: number
  focusTitle: string | null
}

export interface SceneCue {
  id: string
  scope: string
  kind: 'completed' | 'handoff'
  fromRole: string
  toRole?: string
  taskId: string
  eventSeq: number
  expiresAtMs: number
}

export interface SceneFacts {
  scope: string
  roster: readonly RosterAgent[]
  tasks: readonly HubTask[]
}

const rank: Record<string, number> = { blocked: 0, in_review: 1, in_progress: 2 }

export function identitySeed(key: string): number {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  return hash >>> 0
}

function owned(agent: Pick<RosterAgent, 'role' | 'external'>, task: Pick<HubTask, 'role' | 'soldier'>): boolean {
  return agent.external ? task.soldier === agent.role : (task.role ?? task.soldier) === agent.role
}

export function projectSceneAgents(scope: string, roster: readonly RosterAgent[], tasks: readonly HubTask[]): SceneAgent[] {
  return roster.filter(agent => !agent.scope || agent.scope === scope).map(agent => {
    const mine = tasks.filter(task => task.status !== 'canceled' && (!task.scope || task.scope === scope) && owned(agent, task))
    const focus = [...mine].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.id.localeCompare(b.id))[0]
    const mode: SceneMode = mine.some(task => task.status === 'blocked') ? 'blocked'
      : mine.some(task => task.status === 'in_review') ? 'review'
        : mine.some(task => task.status === 'in_progress') ? 'busy' : 'idle'
    const key = `${scope}\0${agent.role}`
    return {
      key, scope, role: agent.role, name: agent.name, avatar: agent.avatar, external: agent.external,
      mode, activity: mode === 'busy' ? 'work' : mode,
      taskIds: mine.map(task => task.id), focusTaskId: focus?.id ?? null,
      focusTitle: focus?.title ?? null, taskCount: mine.length,
      stationId: key, appearanceSeed: identitySeed(key),
    }
  })
}

function owner(task: HubTask, roster: readonly RosterAgent[]): string | null {
  const role = task.role ?? task.soldier
  if (role && roster.some(agent => agent.role === role && !agent.external)) return role
  if (task.soldier && roster.some(agent => agent.role === task.soldier && agent.external)) return task.soldier
  return null
}

export function deriveSceneCues(
  previous: SceneFacts | null,
  current: SceneFacts,
  events: readonly HubAuditEvent[],
  nowMs: number,
  visible: boolean,
): SceneCue[] {
  if (!previous || !visible || previous.scope !== current.scope) return []
  const old = new Map(previous.tasks.map(task => [task.id, task]))
  const fresh = new Map(current.tasks.map(task => [task.id, task]))
  const cues: SceneCue[] = []
  for (const event of events) {
    if (event.scope !== current.scope || !event.taskId || nowMs - Date.parse(event.ts) > 8000 || Date.parse(event.ts) > nowMs + 1000) continue
    const before = old.get(event.taskId)
    const after = fresh.get(event.taskId)
    if (!before || !after) continue
    const toRole = owner(after, current.roster)
    if (before.status !== 'done' && after.status === 'done' && toRole) {
      cues.push({ id: `${event.seq}:${after.id}:completed`, scope: current.scope, kind: 'completed', fromRole: toRole, taskId: after.id, eventSeq: event.seq, expiresAtMs: nowMs + 1800 })
    }
    if (event.action !== 'claim' || before.status === 'in_progress' || after.status !== 'in_progress' || !toRole) continue
    for (const predecessorId of after.blockedBy ?? []) {
      const predecessor = fresh.get(predecessorId)
      if (!predecessor || predecessor.status !== 'done' || predecessor.scope !== after.scope) continue
      if ((predecessor.goalId || after.goalId) && (!predecessor.goalId || predecessor.goalId !== after.goalId)) continue
      const fromRole = owner(predecessor, current.roster)
      if (!fromRole || fromRole === toRole) continue
      cues.push({ id: `${event.seq}:${after.id}:handoff`, scope: current.scope, kind: 'handoff', fromRole, toRole, taskId: after.id, eventSeq: event.seq, expiresAtMs: nowMs + 1800 })
      break
    }
  }
  return cues
}

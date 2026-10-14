import type { HubAuditEvent, HubGoal, HubTask, RosterAgent } from '../types'
import { tasksForRosterAgent, taskOwnerRole } from './agentOwnership.ts'
import { moodFor } from './sceneBoard.ts'
import type { AgentMood, SceneTaskChip } from './sceneBoard.ts'

/** Agent 的气色。★ 定义在 `sceneBoard.ts`（气泡与看板共用一份颜色契约），这里只是别名。 */
export type SceneMode = AgentMood
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
  /**
   * ★★ 2026-10-14：这个 Agent 名下的**全部任务**（含标题与状态），按"最要紧优先"排序。
   *
   * 在这之前场景里只有 `taskCount` 与 `focusTitle` —— 于是气泡悬浮时**没有东西可显示**，
   * 只能显示"3 项"。而将军要的是"悬浮看到他的所有任务"，那就必须把那份清单投影进来。
   *
   * ⚠ 只带三样（id / 标题 / 状态）：3D 场景不需要验收标准、评论、证据那些重字段。
   *   把它们拖进每一帧的 props 只会让场景变慢，而慢下来没人会归因到"气泡多带了字段"。
   */
  tasks: SceneTaskChip[]
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

const rank: Record<string, number> = { blocked: 0, in_review: 1, in_progress: 2, todo: 3, backlog: 4, done: 5 }

/** 当前场景目标只取进行中的目标，其次暂停目标；不把已完成历史目标显示成当前进度。 */
export function currentGoalProgress(goals: readonly Pick<HubGoal, 'status' | 'percent'>[]): number | null {
  return goals.find(goal => goal.status === 'active')?.percent
    ?? goals.find(goal => goal.status === 'paused')?.percent
    ?? null
}

export function identitySeed(key: string): number {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  return hash >>> 0
}

/**
 * 把一个 Agent 名下的任务排成"最要紧优先"，并投影成气泡/看板直接能用的最小形状。
 * 排序用 `rank`，气色判定用 `moodFor`（两条顺序是**同一条**，见 `sceneBoard.ts`）。
 */
function chipsOf(tasks: readonly HubTask[]): SceneTaskChip[] {
  return [...tasks]
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.id.localeCompare(b.id))
    .map(task => ({ id: task.id, title: task.title, status: task.status }))
}

export function projectSceneAgents(scope: string, roster: readonly RosterAgent[], tasks: readonly HubTask[]): SceneAgent[] {
  return roster.filter(agent => !agent.scope || agent.scope === scope).map(agent => {
    // ★ 归属只走 `agentOwnership` 那一份：这里原本另有一份私有 `owned()`，
    //   与 `tasksForRosterAgent` 是同一条规则的两个副本（迟早漂移）。
    const mine = tasksForRosterAgent(agent, tasks.filter(task => !task.scope || task.scope === scope), roster)
    const chips = chipsOf(mine)
    const mode: SceneMode = moodFor(chips)
    const key = `${scope}\0${agent.role}`
    return {
      key, scope, role: agent.role, name: agent.name, avatar: agent.avatar, external: agent.external,
      mode, activity: mode === 'busy' ? 'work' : mode,
      taskIds: chips.map(task => task.id), tasks: chips,
      focusTaskId: chips[0]?.id ?? null,
      focusTitle: chips[0]?.title ?? null, taskCount: chips.length,
      stationId: key, appearanceSeed: identitySeed(key),
    }
  })
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
    const toRole = taskOwnerRole(after, current.roster)
    const completedEvent = event.action === 'advance' || (event.action === 'transition' && event.payload?.to === 'done')
    if (completedEvent && before.status !== 'done' && after.status === 'done' && toRole) {
      cues.push({ id: `${event.seq}:${after.id}:completed`, scope: current.scope, kind: 'completed', fromRole: toRole, taskId: after.id, eventSeq: event.seq, expiresAtMs: nowMs + 1800 })
    }
    if (event.action !== 'claim' || event.payload?.soldier !== after.soldier || before.status === 'in_progress' || after.status !== 'in_progress' || !toRole) continue
    for (const predecessorId of after.blockedBy ?? []) {
      const predecessor = fresh.get(predecessorId)
      if (!predecessor || predecessor.status !== 'done' || predecessor.scope !== after.scope) continue
      if ((predecessor.goalId || after.goalId) && (!predecessor.goalId || predecessor.goalId !== after.goalId)) continue
      const fromRole = taskOwnerRole(predecessor, current.roster)
      if (!fromRole || fromRole === toRole) continue
      cues.push({ id: `${event.seq}:${after.id}:handoff`, scope: current.scope, kind: 'handoff', fromRole, toRole, taskId: after.id, eventSeq: event.seq, expiresAtMs: nowMs + 1800 })
      break
    }
  }
  return cues
}

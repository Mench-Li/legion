import type { HubTask, RosterAgent } from '../types'

/** Match the team-hub roster projection, including soldiers outside the roster. */
export function tasksForRosterAgent<T extends Pick<HubTask, 'role' | 'soldier' | 'status'>>(
  agent: Pick<RosterAgent, 'role' | 'external'>,
  tasks: readonly T[],
  roster: readonly Pick<RosterAgent, 'role' | 'external'>[] = [],
): T[] {
  const rosterRoles = new Set(roster.filter(member => !member.external).map(member => member.role))
  return tasks.filter(task => task.status !== 'canceled' && (agent.external
    ? task.soldier === agent.role && !rosterRoles.has(task.role ?? task.soldier ?? '')
    : (task.role ?? task.soldier) === agent.role))
}

/**
 * 一件任务**归谁**（返回岗位名；没人认领或归不到人 ⇒ `null`）。
 *
 * ★ 2026-10-14 从 `sceneState.ts` 提上来的：那边原本有个私有 `owner()`，
 *   而"谁去走这趟看板"要问同一个问题。留两份的后果是**同一个人在两处算出不同归属**
 *   ——表现出来就是"任务明明是他的，人却站着不动"，而且不报错。
 *
 * 优先级：正式编队岗位（任务的 `role`）优先；否则看是不是某个**未入编的外部执行者**
 * 按 `soldier` 认下的活。
 */
export function taskOwnerRole<T extends Pick<HubTask, 'role' | 'soldier'>>(
  task: T,
  roster: readonly Pick<RosterAgent, 'role' | 'external'>[],
): string | null {
  const role = task.role ?? task.soldier
  if (role && roster.some(member => member.role === role && !member.external)) return role
  if (task.soldier && roster.some(member => member.role === task.soldier && member.external)) return task.soldier
  return null
}

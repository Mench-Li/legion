import type { HubTask, RosterAgent } from '../types'

/** Match the team-hub roster projection, including soldiers outside the roster. */
export function tasksForRosterAgent<T extends Pick<HubTask, 'role' | 'soldier' | 'status'>>(
  agent: Pick<RosterAgent, 'role' | 'external'>,
  tasks: readonly T[],
): T[] {
  return tasks.filter(task => task.status !== 'canceled' && (agent.external
    ? task.soldier === agent.role
    : (task.role ?? task.soldier) === agent.role))
}

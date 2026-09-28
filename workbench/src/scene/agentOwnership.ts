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

import type { BoardData, Card, CardStatus, HubTask, SoldierStats } from './types'

const COLUMNS: Array<{ id: CardStatus; label: string }> = [
  { id: 'backlog', label: '待规划' },
  { id: 'todo', label: '待处理' },
  { id: 'in_progress', label: '进行中' },
  { id: 'in_review', label: '待验收' },
  { id: 'blocked', label: '受阻' },
  { id: 'done', label: '已完成' },
  { id: 'canceled', label: '已取消' },
]

function toCard(task: HubTask): Card {
  const evidence = Array.isArray(task.evidence) ? task.evidence : []
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
  const comments = Array.isArray(task.comments) ? task.comments : []
  const progress = task.status === 'done' ? 100 : task.status === 'in_review' ? 80 : task.status === 'in_progress' ? 50 : 0
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority === 'high' || task.priority === 'low' ? task.priority : 'medium',
    soldier: task.soldier ?? undefined,
    claimedAt: task.claimedAt ?? null,
    parent: task.parent ?? null,
    blocks: task.blocks ?? [],
    blockedBy: task.blockedBy ?? [],
    version: task.version,
    comments,
    latestComment: comments.length > 0 ? comments[comments.length - 1] : null,
    evidence: evidence.length,
    patches: artifacts.map(a => typeof a === 'string' ? a : a.path),
    artifacts: artifacts.map(a => typeof a === 'string' ? a : a.path),
    glow: task.status === 'blocked' ? 'red' : task.status === 'in_progress' ? 'green' : task.status === 'in_review' ? 'yellow' : 'blue',
    progress,
    updatedAt: task.updatedAt ?? task.createdAt ?? new Date(0).toISOString(),
  }
}

export function boardFromHubTasks(tasks: HubTask[]): BoardData {
  const safeTasks = Array.isArray(tasks) ? tasks : []
  const byStatus = new Map<CardStatus, Card[]>()
  for (const column of COLUMNS) byStatus.set(column.id, [])
  const roleStats = new Map<string, SoldierStats>()
  for (const task of safeTasks) {
    const card = toCard(task)
    const status = COLUMNS.some(c => c.id === task.status) ? task.status : 'backlog'
    byStatus.get(status)?.push(card)
    const role = task.role ?? task.soldier ?? 'unassigned'
    const current = roleStats.get(role) ?? { role, inProgress: 0, inReview: 0, done: 0, blocked: 0, total: 0 }
    current.total += 1
    if (status === 'in_progress') current.inProgress += 1
    if (status === 'in_review') current.inReview += 1
    if (status === 'done') current.done += 1
    if (status === 'blocked') current.blocked += 1
    roleStats.set(role, current)
  }
  const done = safeTasks.filter(t => t.status === 'done').length
  const canceled = safeTasks.filter(t => t.status === 'canceled').length
  const total = safeTasks.length
  return {
    generatedAt: new Date().toISOString(),
    goal: { objective: '', phase: '', roundsCompleted: 0, progress: { total, done, percent: total === 0 ? 0 : Math.round(done / total * 100) }, progressBar: '' },
    totals: { open: total - done - canceled, done, total, canceled },
    columns: COLUMNS.map(column => ({ ...column, cards: byStatus.get(column.id) ?? [] })),
    soldiers: [...roleStats.values()],
  }
}

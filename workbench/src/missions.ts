import type { BoardData, Card, CardStatus, Column, Mission, MissionTaskItem } from './types'

/**
 * 「任务集（Mission）」聚合逻辑（客户端兜底版本）。
 * 服务端优先：/api/missions 返回同构数据（role/name/计数/percent/status/tasks）；
 * 本模块在服务端没有该接口（旧版 serve.mjs）时兜底，从 board.json 按角色聚合。
 * 命名优先取 /api/config 的 pipeline 中文标签（如「编码实现」「代码审查」），
 * 未匹配的角色回退到原始 role id。
 */

export interface StatusCard {
  card: Card
  status: CardStatus
}

export function allCards(board: BoardData): StatusCard[] {
  const out: StatusCard[] = []
  for (const col of board.columns) {
    for (const card of col.cards) out.push({ card, status: col.id })
  }
  return out
}

export interface StatusCounts {
  backlog: number
  todo: number
  inProgress: number
  inReview: number
  blocked: number
  done: number
}

export function statusCounts(board: BoardData): StatusCounts {
  const c: StatusCounts = { backlog: 0, todo: 0, inProgress: 0, inReview: 0, blocked: 0, done: 0 }
  for (const col of board.columns) {
    for (const _card of col.cards) {
      if (col.id === 'backlog') c.backlog += 1
      else if (col.id === 'todo') c.todo += 1
      else if (col.id === 'in_progress') c.inProgress += 1
      else if (col.id === 'in_review') c.inReview += 1
      else if (col.id === 'blocked') c.blocked += 1
      else if (col.id === 'done') c.done += 1
    }
  }
  return c
}

function labelOf(role: string, labels: Record<string, string>): string {
  return labels[role] ?? role
}

function toItem(task: StatusCard): MissionTaskItem {
  return { id: task.card.id, title: task.card.title, status: task.status }
}

/** 客户端兜底聚合：与 serve.mjs /api/missions 输出同构。 */
export function buildMissions(board: BoardData, labels: Record<string, string>): Mission[] {
  const byRole = new Map<string, StatusCard[]>()
  for (const col of board.columns) {
    for (const card of col.cards) {
      const role = card.soldier ?? 'unassigned'
      const arr = byRole.get(role) ?? []
      arr.push({ card, status: col.id })
      byRole.set(role, arr)
    }
  }

  const missions: Mission[] = [...byRole.entries()].map(([role, tasks]) => {
    const active = tasks.filter(t => t.status !== 'canceled')
    const done = active.filter(t => t.status === 'done').length
    const inProgress = active.filter(t => t.status === 'in_progress').length
    const inReview = active.filter(t => t.status === 'in_review').length
    const blocked = active.filter(t => t.status === 'blocked').length
    const waiting = active.filter(t => t.status === 'todo' || t.status === 'backlog').length
    const total = active.length
    const percent = total === 0 ? 0 : Math.round((done / total) * 100)
    let status: Mission['status']
    if (blocked > 0) status = 'blocked'
    else if (done === total) status = 'done'
    else if (inProgress === 0 && inReview === 0) status = 'waiting'
    else status = 'running'
    return {
      role,
      name: labelOf(role, labels),
      total,
      done,
      inProgress,
      inReview,
      blocked,
      waiting,
      percent,
      status,
      tasks: active.map(toItem),
    }
  })

  const rank: Record<Mission['status'], number> = { running: 0, waiting: 1, blocked: 2, done: 3 }
  missions.sort((a, b) => rank[a.status] - rank[b.status] || b.percent - a.percent)
  return missions
}

/** 从 /api/config 的 pipeline 阶段构建 role → 中文标签表。 */
export function labelsFromPipeline(
  pipeline: { stages: Array<{ role: string; label: string }> } | null | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const stage of pipeline?.stages ?? []) labels[stage.role] = stage.label
  return labels
}

/** 进行中/待验收/受阻任务的汇总视图，供「任务调度」使用。 */
export function inflightTasks(board: BoardData): StatusCard[] {
  const wanted = new Set<CardStatus>(['todo', 'in_progress', 'in_review', 'blocked'])
  return allCards(board).filter(sc => wanted.has(sc.status))
}

export function columnById(board: BoardData, id: CardStatus): Column | undefined {
  return board.columns.find(col => col.id === id)
}

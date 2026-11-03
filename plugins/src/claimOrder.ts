// plugins/src/claimOrder.ts
// ============================================================================
// F6 · 认领顺序（设计稿 §8.1 / M8 排序层，守护侧）
//
// 配额只在"准入"上生效还不够：**谁先跑**同样决定公平。
// 一个 12 片的大目标即使受配额限制，只要它永远排在小目标前面，
// 小目标就只能等大目标的分片间隙——那仍然不是公平。
//
// ★ 与 team-hub 的 `goal-share.mjs` 同源（配额公式 / 权重 / 缺口定义）。
//   为什么不共享：两个包之间没有运行时依赖（DEC-2：守护只经 HTTP 说话）。
//   两份规则各有判据表，变更时**两张表一起改**——这是刻意付出的重复代价。
//
// ★ 默认不启用（由 `LEGION_GOAL_SHARE=1` 打开）：排序改变"谁先跑"，
//   影响面比准入大，必须能被一键退回。
// ============================================================================

export interface GoalShareConfig {
  default: number
  weights: Record<string, number>
  borrowTtlSec: number
}

export interface OrderableTask {
  id: string
  goalId?: string | null
  priority?: string | null
  createdAt?: string | null
}

const DEFAULT_CONFIG: GoalShareConfig = { default: 0.5, weights: {}, borrowTtlSec: 600 }
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** 单目标配额：向上取整、至少 1（与 team-hub 一致）。 */
export function goalQuotaOf({ goalId = null, maxWorkers = 1, config = DEFAULT_CONFIG }: {
  goalId?: string | null
  maxWorkers?: number
  config?: GoalShareConfig
}): number {
  const workers = Math.max(1, Math.round(Number(maxWorkers) || 1))
  const share = clamp01(Number(config?.default ?? DEFAULT_CONFIG.default))
  const weight = goalId !== null && goalId !== undefined && config?.weights?.[String(goalId)] !== undefined
    ? Math.max(1, Math.round(Number(config.weights[String(goalId)])))
    : 1
  return Math.max(1, Math.ceil(workers * share * weight))
}

/** 缺口 = 配额 − 在跑数（越大越"该给它槽"）。 */
export function goalDeficitOf({ goalId = null, maxWorkers = 1, config = DEFAULT_CONFIG, activeByGoal = {} }: {
  goalId?: string | null
  maxWorkers?: number
  config?: GoalShareConfig
  activeByGoal?: Record<string, number>
}): number {
  const quota = goalQuotaOf({ goalId, maxWorkers, config })
  const active = Number(activeByGoal[String(goalId)] ?? 0)
  return quota - active
}

/**
 * 重排 todo 候选：缺口大的目标优先 → priority → createdAt。
 * **只重排、不筛除**：任何任务都不会因为排序而消失。
 */
export function orderTodoCandidates<T extends OrderableTask>(
  tasks: T[],
  { maxWorkers = 1, config = DEFAULT_CONFIG, activeByGoal = {} }: {
    maxWorkers?: number
    config?: GoalShareConfig
    activeByGoal?: Record<string, number>
  } = {},
): T[] {
  const list = Array.isArray(tasks) ? [...tasks] : []
  const deficit = (task: T): number => goalDeficitOf({ goalId: task?.goalId ?? null, maxWorkers, config, activeByGoal })
  return list.sort((a, b) => {
    const byDeficit = deficit(b) - deficit(a)
    if (byDeficit !== 0) return byDeficit
    const byPriority = (PRIORITY_RANK[String(a?.priority ?? 'medium')] ?? 1) - (PRIORITY_RANK[String(b?.priority ?? 'medium')] ?? 1)
    if (byPriority !== 0) return byPriority
    return String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''))
  })
}

/** 统计每个目标当前的活跃数（in_progress 即"占着槽"）。 */
export function activeByGoalOf(tasks: Array<OrderableTask & { status?: string }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (String(task?.status ?? '') !== 'in_progress') continue
    const key = String(task?.goalId ?? '')
    if (key === '') continue
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

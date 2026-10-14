// workbench/src/taskGoalFilter.ts
// ============================================================================
// 任务中心「🎯 按目标筛选」：目标这条轴上的**唯一判据**（纯函数，DOM-free）。
//
// ## 为什么单独一个模块，而不是组件里的一行 filter
//
// ① 「哪条任务属于哪个目标」看起来只是一次字符串比较，但**空值有四种写法**
//    （`null` / `undefined` / `''` / `'   '`），而它们指的是同一件事：这条任务没有挂目标。
//    判据留在组件里，下一个渲染面（手机看板）就会自己再判一遍——
//    两端都不会报错，只会各筛各的（同 `taskOrder.ts` / `deliveryBadge.ts` 的处置）。
//
// ② 胶囊的**计数**与**顺序**必须是全量口径：
//      · 计数取自「未被取消的全部任务」，不是「当前筛选后的任务」——
//        否则点一个目标，其余胶囊的数字一起变，读起来像任务被筛丢了；
//      · 顺序固定（进行中 → 已暂停 → 未知 → 已完成 → 已取消 → 未挂目标，
//        同档按任务数、再按 id），所以点选前后**位置不跳**，刚才点的那一个还在原处。
//
// ③ 没有目标的任务**不许被筛没**：它们在筛选器里是显式的一项（「未挂目标」），
//    而不是"不在任何胶囊下"——一条不在任何胶囊下出现的任务，用户只会认为它消失了。
//
// 运行：node --experimental-strip-types workbench/scripts/task-goal-filter.test.mjs
// ============================================================================

/** 「没有挂目标」在筛选器里的键。真实 goalId 形如 `G-mujfc9vi-1`，不会撞上这个哨兵。 */
export const NO_GOAL_KEY = '__no_goal__'

/** 目标状态 → 胶囊顺序档位（越小越靠前）。未知状态排在「已暂停」与「已完成」之间。 */
const STATUS_RANK: Record<string, number> = Object.freeze({ active: 0, paused: 1, done: 3, canceled: 4 })

/** 非空字符串归一化：其余一律是 null（"没读到"就是没读到，不发明空串）。 */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v === '' ? null : v
}

/** 目标 id 归一化：空串/空白/null/undefined 是**同一件事**（这条任务没有挂目标）。 */
export function normalizeGoalId(value: unknown): string | null {
  return text(value)
}

/** 任务 → 筛选键（真实 goalId 或 NO_GOAL_KEY）。 */
export function goalFilterKey(task: { goalId?: string | null } | null | undefined): string {
  return normalizeGoalId(task?.goalId) ?? NO_GOAL_KEY
}

/** 目标文案压成一行并截断（胶囊是单行小控件，长文案会把它撑成两行）。 */
export function shortenObjective(objective: string | null | undefined, max = 18): string {
  const one = String(objective ?? '').replace(/\s+/g, ' ').trim()
  if (one === '') return ''
  return one.length > max ? `${one.slice(0, max)}…` : one
}

function rankOf(status: string | null, key: string): number {
  if (key === NO_GOAL_KEY) return 9 // 「未挂目标」永远排最后：它不是目标
  return STATUS_RANK[status ?? ''] ?? 2
}

/** 参与目标筛选的最小任务形状（TcRow / HubTask / 手机端的裸对象都能满足）。 */
export interface GoalFilterTask {
  goalId?: string | null
  status?: string | null
}

/** 目标元信息（team-hub `GET /api/goal` 的 HubGoal 子集）：只为把 id 说成人能读的文案。 */
export interface GoalFilterGoal {
  id?: string | null
  objective?: string | null
  status?: string | null
}

export interface GoalFilterOption {
  /** 点选用的键：真实 goalId，或 NO_GOAL_KEY。 */
  key: string
  /** 真实目标 id；「未挂目标」为 null。 */
  goalId: string | null
  /** 目标状态（读不到目标记录时为 null——不猜）。 */
  status: string | null
  /** 该目标下**未被取消**的任务数（全量口径，不随当前筛选变化）。 */
  count: number
  /** 胶囊文案（长文案截断；「未挂目标」= 未挂目标）。 */
  label: string
  /** 悬停全文：目标 id + 完整文案 + 任务数。 */
  title: string
}

/**
 * 生成目标筛选胶囊：只列**当前任务集里真的有任务**的目标（已取消的任务不计，
 * 与岗位胶囊同一口径），顺序固定。
 *
 * `goals` 缺省（或读不到）时退化为只显示目标 id —— 「全部空间」模式拿不到目标文案，
 * 那时**不猜**文案，只如实显示 id。
 */
export function buildGoalFilter(
  tasks: readonly GoalFilterTask[] | null | undefined,
  goals: readonly GoalFilterGoal[] | null | undefined = [],
  opts: { maxObjective?: number } = {},
): GoalFilterOption[] {
  const meta = new Map<string, GoalFilterGoal>()
  for (const g of goals ?? []) {
    const id = normalizeGoalId(g?.id)
    if (id && !meta.has(id)) meta.set(id, g)
  }

  const counts = new Map<string, number>()
  for (const t of tasks ?? []) {
    if (t?.status === 'canceled') continue // 已取消的任务不进展板，也不进筛选器
    const key = goalFilterKey(t)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const max = opts.maxObjective ?? 18
  const out: GoalFilterOption[] = []
  for (const [key, count] of counts) {
    if (key === NO_GOAL_KEY) {
      out.push({
        key,
        goalId: null,
        status: null,
        count,
        label: '未挂目标',
        title: `未挂目标的手工任务（${count} 个）`,
      })
      continue
    }
    const g = meta.get(key)
    const objective = text(g?.objective)
    out.push({
      key,
      goalId: key,
      status: text(g?.status),
      count,
      // 文案读不到时退到 id：让用户至少能按 id 找到那一组，而不是看到一个空胶囊
      label: shortenObjective(objective ?? key, max),
      title: `${key} · ${objective ?? '（未读到目标文案）'} · ${count} 个任务`,
    })
  }

  out.sort((a, b) => {
    const ra = rankOf(a.status, a.key)
    const rb = rankOf(b.status, b.key)
    if (ra !== rb) return ra - rb
    if (a.count !== b.count) return b.count - a.count
    return a.key.localeCompare(b.key)
  })
  return out
}

/** 单条任务是否命中当前目标筛选（`filterKey` 为空 = 不筛）。 */
export function matchesGoalFilter(
  task: { goalId?: string | null } | null | undefined,
  filterKey: string | null | undefined,
): boolean {
  if (!filterKey) return true
  return goalFilterKey(task) === filterKey
}

/**
 * 当前筛选在界面上的说法（无筛选 = null）。
 * 找不到对应胶囊时**回落到键本身**——一个筛着的条件不许在文案里消失。
 */
export function goalFilterLabel(
  options: readonly GoalFilterOption[] | null | undefined,
  filterKey: string | null | undefined,
): string | null {
  if (!filterKey) return null
  return (options ?? []).find(o => o.key === filterKey)?.label ?? filterKey
}

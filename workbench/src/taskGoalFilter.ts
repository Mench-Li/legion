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
// ② 计数的**口径**必须是全量：取自「未被取消的全部任务」，不是「当前筛选后的任务」——
//    否则选一个目标，其余项的数字一起变，读起来像任务被筛丢了。
//
// ③ 没有目标的任务**不许被筛没**：它们在筛选器里是显式的一项（「未挂目标」），
//    而不是"不在任何选项下"——一条不在任何选项下出现的任务，用户只会认为它消失了。
//
// ④ ★ 界面是**下拉 + 输入模糊匹配**，不是一排胶囊：目标数会长（几十个），
//    一排胶囊会把过滤区撑成好几行、把泳道挤下去。这条轴的样子收在这里，
//    组件只渲染 `rankGoalOptions` 给的列表 —— 判据与样子分开之后，
//    "搜不到"与"没有这个目标"才不会被混成同一个空列表。
//
// 运行：node --experimental-strip-types workbench/scripts/task-goal-filter.test.mjs
// ============================================================================

/** 「没有挂目标」在筛选器里的键。真实 goalId 形如 `G-mujfc9vi-1`，不会撞上这个哨兵。 */
export const NO_GOAL_KEY = '__no_goal__'

/** 目标状态 → 列表顺序档位（越小越靠前）。未知状态排在「已暂停」与「已完成」之间。 */
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

/** 目标文案压成一行并截断（下拉里每项是一行，长文案会把行撑成两行或被裁掉）。 */
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
  /** 下拉里那一行的文案（长文案截断；「未挂目标」= 未挂目标）。 */
  label: string
  /**
   * **完整**目标文案（不截断）。
   *
   * ★ 模糊匹配必须打在完整文案上：`label` 被截到 18 字，用户输的是文案后半段时，
   *   拿截断后的 label 去比会"搜不到"，而界面上那一项明明就在列表里。
   */
  objective: string | null
  /** 悬停全文：目标 id + 完整文案 + 任务数。 */
  title: string
}

/**
 * 生成目标选项：只列**当前任务集里真的有任务**的目标（已取消的任务不计，
 * 与岗位过滤同一口径），顺序固定（进行中 → 已暂停 → 未知 → 已完成 → 已取消 → 未挂目标，
 * 同档按任务数、再按 id），所以**下拉打开时列表不跳**。
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
        objective: null,
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
      // 文案读不到时退到 id：让用户至少能按 id 找到那一组，而不是看到一个空项
      label: shortenObjective(objective ?? key, max),
      objective,
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

/**
 * 这条轴值不值得出现在界面上：至少有一个**真实目标**。
 *
 * 一个空间里只有手工任务（没有挂任何目标）时，下拉里唯一的内容是「未挂目标」——
 * 那是个按钮占位，不是一条筛选轴。宁可整条不出现，而不是给一个点不点都一样的控件。
 *
 * ★ 判据放在这里而不是组件里：组件一旦自己判 `goalId !== null`，
 *   哨兵 `NO_GOAL_KEY` 的语义就漏到渲染层了（而哨兵只许活在本模块里）。
 */
export function hasRealGoal(options: readonly GoalFilterOption[] | null | undefined): boolean {
  return (options ?? []).some(o => o.goalId !== null && o.goalId !== undefined)
}

/** 单条任务是否命中当前目标筛选（`filterKey` 为空 = 不筛）。 */export function matchesGoalFilter(
  task: { goalId?: string | null } | null | undefined,
  filterKey: string | null | undefined,
): boolean {
  if (!filterKey) return true
  return goalFilterKey(task) === filterKey
}

/**
 * 当前筛选在界面上的说法（无筛选 = null）。
 * 找不到对应选项时**回落到键本身**——一个筛着的条件不许在文案里消失。
 */
export function goalFilterLabel(
  options: readonly GoalFilterOption[] | null | undefined,
  filterKey: string | null | undefined,
): string | null {
  if (!filterKey) return null
  return (options ?? []).find(o => o.key === filterKey)?.label ?? filterKey
}

// ============================================================================
// 下拉里的**模糊匹配**
//
// ## 为什么不是 `includes`
//
// 目标是长句（「手机端任务串空间…」「头像黑边…」），用户记得的是其中几个字，
// 而且常常**不连续**（输 `手机空间` 想找「手机端任务串空间」）。只做子串匹配的话，
// 这种输入会回一个空列表 —— 而"没匹配上"与"没有这个目标"在空列表里长得一样。
//
// 打分档位（越小越靠前），四条判据各有各的理由：
//   0  完全相同     —— 粘贴一个目标 id 进来，它就排第一
//   1  前缀命中     —— 从头打字，逐个字符往下缩范围时列表不会跳
//   2  子串命中     —— 记得中间一段
//   10 子序列命中   —— 记得几个字但不连续；**跨度越小越靠前**（越连贯越像它）
//
// ★ 大小写与首尾空白一律不敏感：`G-MUJFC9VI-1` 与 `g-mujfc9vi-1` 是同一个目标。
// ============================================================================

/** 模糊匹配打分；不命中回 null（**不是**一个很大的数——调用方要能分辨"没命中"）。 */
export function fuzzyScore(text: string | null | undefined, query: string | null | undefined): number | null {
  const t = String(text ?? '').trim().toLowerCase()
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return 0
  if (t === '') return null
  if (t === q) return 0
  if (t.startsWith(q)) return 1
  const at = t.indexOf(q)
  if (at >= 0) return 2 + at / 1000
  // 子序列：query 的每个字符按序出现在 text 里
  let cursor = 0
  let first = -1
  let last = -1
  for (const ch of q) {
    const hit = t.indexOf(ch, cursor)
    if (hit < 0) return null
    if (first < 0) first = hit
    last = hit
    cursor = hit + 1
  }
  return 10 + (last - first) / 1000
}

/** 取多个候选里最好的那个分数（完整文案 / 目标 id / 别名）。 */
function bestScore(candidates: readonly string[], query: string): number | null {
  if (String(query ?? '').trim() === '') return 0
  let best: number | null = null
  for (const c of candidates) {
    const s = fuzzyScore(c, query)
    if (s === null) continue
    if (best === null || s < best) best = s
  }
  return best
}

/** 下拉列表里的**一条**：`key === null` 是「全部目标」（清除筛选那一项）。 */
export interface GoalMenuEntry {
  /** 选中它时写入的筛选键；null = 清除目标筛选。 */
  key: string | null
  /** 真实目标 id；「全部目标」与「未挂目标」都是 null。 */
  goalId: string | null
  label: string
  count: number
  /** 悬停全文。 */
  title: string
}

/** 「全部目标」那一项：它是**出口**（点它回到不筛），所以永远在列表里，不参与被筛掉。 */
export const ALL_GOALS_ENTRY: GoalMenuEntry = Object.freeze({
  key: null,
  goalId: null,
  label: '全部目标',
  count: 0,
  title: '不按目标筛：显示该范围内全部任务',
})

/** 每一项参与模糊匹配的候选串（完整文案优先，其次是 id / 口语别名）。 */
function candidatesOf(o: GoalFilterOption): string[] {
  if (o.key === NO_GOAL_KEY) return [o.label, '未挂目标', '手工', 'no-goal', NO_GOAL_KEY]
  // ★ 用 objective（完整）而不是 label（截断到 18 字）——见 GoalFilterOption.objective 的注释
  return [o.objective ?? '', o.goalId ?? '', o.label]
}

/**
 * 下拉列表的最终内容与顺序。
 *
 * 空查询 = 全量（「全部目标」在最前，其余沿用 `buildGoalFilter` 的固定次序，
 * 所以**打开下拉时列表不跳**）；有查询 = 只留命中的，按分数升序，同分保持原相对次序。
 *
 * `allCount` = 该范围内的全部任务数（「全部目标」右侧的数字）。
 */
export function rankGoalOptions(
  options: readonly GoalFilterOption[] | null | undefined,
  query: string | null | undefined,
  allCount = 0,
): GoalMenuEntry[] {
  const rows: Array<{ entry: GoalMenuEntry; candidates: string[] }> = [
    {
      entry: { ...ALL_GOALS_ENTRY, count: allCount },
      candidates: [ALL_GOALS_ENTRY.label, '全部', '所有', 'all', 'clear'],
    },
    ...(options ?? []).map(o => ({
      entry: { key: o.key, goalId: o.goalId, label: o.label, count: o.count, title: o.title },
      candidates: candidatesOf(o),
    })),
  ]
  const q = String(query ?? '').trim()
  if (q === '') return rows.map(r => r.entry)

  const scored: Array<{ entry: GoalMenuEntry; score: number; at: number }> = []
  rows.forEach((row, at) => {
    const score = bestScore(row.candidates, q)
    if (score !== null) scored.push({ entry: row.entry, score, at })
  })
  // ★ 同分按**原次序**（stable）：列表顺序在用户眼皮底下跳来跳去比排得不够聪明更难受
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.at - b.at))
  return scored.map(s => s.entry)
}


// workbench/src/taskOrder.ts
// ============================================================================
// 任务卡的**展示顺序**：按时间，最新的在最上面。
//
// ## 为什么需要单独一条规则（原来那一行错在哪）
//
// 泳道里原来排的是 `normId(a.id, b.id)` —— 也就是**按任务号升序**。
// 在"任务号随时间递增"的世界里它看起来等价于按时间排，于是它一直没被怀疑过。
//
// 但那是**假设**，不是规则，而且今天被证伪了：T-199 是 2026-10-12 才重做完成的
// （10-10 建的单子、10-12 重新完成），它的号**比 T-200/T-201/T-202 小**，
// 于是按号排它被压在三条更早完成的任务**上面**，而真正最新的那条沉在下面。
//
//     按号排（原状）：… T-198, T-199, T-200, T-201, T-202
//     按时间排（本规则）：T-199(10-12), T-202(10-10), T-201, T-200, T-198 …
//
//   > 一个"任务号越大就越新"的假设，与一个"任务会被重做"的事实，
//   > 在**没有重做发生**的时候是同一个读数 ——
//   > 而重做这条路是**同一天**刚打开的（验收不满意就拖回去重做）。
//
// ## 用哪个时间
//
// 优先级 `updatedAt` → `createdAt` → `claimedAt`，取第一个能解析的。
//
//   · 完成列要的是"什么时候完成的"，而库里**没有** `completedAt` ——
//     `updatedAt` 是最接近的可用信号（任务被改成 done 的那一刻它就被刷新了）。
//   · 已知偏差：**完成之后又被评论/改动的老任务会往上浮**。
//     这个偏差是**故意留着**的：它比"沉在几百条下面找不到"要好得多。
//   · 三者都没有（或时间串坏掉）⇒ 退到按号降序，保证**顺序仍然确定**，
//     而不是随数据库返回顺序抖动。
//
// ## 与手机端的关系
//
// 手机端是独立静态根、import 不到 TS，所以 `workbench/mobile/board.mjs` 有一份**镜像**。
// 两端的顺序由 `task-order.test.mjs` 逐项比对（同一个 fixture 必须排出同一个序）——
// 沿用本仓 slots/avatar 的"镜像 + parity"惯例：只改一端 = 手机与桌面看到两个不同的队列。

/** 参与排序的最小形状（TcRow / HubTask / 手机端的裸对象都能满足）。 */
export interface TaskLike {
  id?: string | null
  updatedAt?: string | null
  createdAt?: string | null
  claimedAt?: string | null
}

/** 时间字段的优先级：先用"最后一次动过"，再退到"创建"，最后"被领取"。 */
const TIME_FIELDS = ['updatedAt', 'createdAt', 'claimedAt'] as const

/**
 * 取一个任务的排序时间（毫秒）。**没有任何可用时间时返回 null**（不是 0）。
 *
 * 返回 null 与返回 0 的区别很重要：0 会被当成"1970 年"，于是一个没有时间的任务
 * 会被排到**最下面**并被当成"很旧"，而真相是"我们不知道它什么时候动的"。
 * 分开表达之后，调用方可以决定"不知道的放哪"，而不是被 0 悄悄决定。
 */
export function taskTimeMs(t: TaskLike | null | undefined): number | null {
  if (t === null || t === undefined) return null
  for (const k of TIME_FIELDS) {
    const v = t[k]
    if (typeof v !== 'string' || v === '') continue
    const ms = Date.parse(v)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/** 任务号比较：**数字感知**（`T-9` < `T-10`，不是字典序的 `T-10` < `T-9`）。 */
export function compareTaskId(a: string, b: string): number {
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * 展示顺序的比较器：**新的在前**。
 *
 * 平局（同一毫秒 / 都没有时间）用**任务号降序**兜底 —— 于是顺序**总是确定的**，
 * 不依赖 `Array.prototype.sort` 的稳定性，也不依赖数据库返回顺序。
 */
export function compareByMostRecent(a: TaskLike, b: TaskLike): number {
  const ta = taskTimeMs(a)
  const tb = taskTimeMs(b)
  if (ta !== null && tb !== null) {
    if (ta !== tb) return tb - ta
  } else if (ta !== null) {
    return -1 // 有时间的一律排在"不知道时间"的前面
  } else if (tb !== null) {
    return 1
  }
  return compareTaskId(String(b.id ?? ''), String(a.id ?? ''))
}

/** 不改原数组：返回按"最新在前"排好的**新**数组。 */
export function sortByMostRecent<T extends TaskLike>(tasks: readonly T[] | null | undefined): T[] {
  return [...(tasks ?? [])].sort(compareByMostRecent)
}

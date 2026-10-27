// workbench/src/timelineSummary.ts
// ============================================================================
// 任务时间线的**摘要与增量合并**（T2.2）。
//
// ## 两个问题
//
// ① **太长。** 一条跑过几轮的任务，时间线有几百条：进度心跳、每次评论、
//    每次状态变更各占一行。用户要的是"这个任务经历了什么"，不是流水账。
//
// ② **不动。** 弹层只在挂载/打开时拉一次，之后再也不变。于是"我点了派工、
//    它开始跑了"这件事，用户必须手动关掉再打开才看得见——而"刷新才更新"
//    在没有变化时会让人以为卡住了，在刚好变化时会让人不信自己看到的。
//
// ## 判据
//
// · **关键事件一条不丢。** 摘要可以让"20 次进度心跳"变成一行，但不能让
//   一次返工路由消失——那正是用户回来看时间线的原因。
// · **同一 seq 只显示一次。** 首次拉取与 SSE 增量会各带一份重叠段，
//   不去重就会出现两条一模一样的事件，而那看起来像"它做了两次"。
// · **增量不能把时间线弄乱。** 追加后必须仍按 seq 有序；乱序的时间线
//   会让人怀疑"是不是顺序错了"。
// ============================================================================

import type { HubActivity } from './types'

/** 事件分级：`critical` 一条都不折叠，`minor` 允许压成计数。 */
const CRITICAL_ACTIONS = new Set([
  'goal:publish',
  'goal:done',
  'goal:cancel',
  'transition',
  'advance',
  'rework',
  'rework:chain',
  'agent-workflow:review-rework',
  'agent-workflow:attempt-reconciliation',
  'hold',
  'unhold',
  'reassign',
  'runtime:validation',
  'write-intent:confirm-stopped',
  'comment',
  'review-note',
])

/**
 * 可折叠的杂项：同一 action 在相邻位置出现时合并成"×N"。
 *
 * ★ 只折叠这几类。把 `comment` 也折起来会让"两个人各说了三句"变成
 *   "评论 ×6"——而评论的内容恰恰是要读的。
 */
const FOLDABLE_ACTIONS = new Set(['progress'])

export interface TimelineEntry {
  seq: number
  action: string
  member: string
  ts: string
  /** 原始事件（保留给渲染层取 detail，例如 transition 的目标状态）。 */
  raw: HubActivity
  /** 折叠条数；`1` = 未折叠。 */
  repeat: number
  /** 被折叠掉的那几条的 seq（供"展开"用；不展开时为空数组）。 */
  foldedSeqs: number[]
}

/** `seq` 缺失或非法时给一个稳定的兜底值（不伪造为 0——0 看起来像"第一条"）。 */
function seqOf(event: HubActivity): number {
  const value = (event as { seq?: unknown }).seq
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

/**
 * 按 `seq` 去重 + 升序。
 *
 * 同一个 seq 出现两次时**保留先来的那份**：首次拉取是权威历史，
 * SSE 增量只是"我可能还没看到这一条"。
 */
export function mergeTimeline(existing: HubActivity[], incoming: HubActivity[]): HubActivity[] {
  const bySeq = new Map<number, HubActivity>()
  const withoutSeq: HubActivity[] = []
  for (const event of [...existing, ...incoming]) {
    const seq = seqOf(event)
    if (Number.isNaN(seq)) { withoutSeq.push(event); continue }
    if (!bySeq.has(seq)) bySeq.set(seq, event)
  }
  const ordered = [...bySeq.values()].sort((a, b) => seqOf(a) - seqOf(b))
  // 没有 seq 的老数据放在最前面（无法定位，但也不该丢）。
  return [...withoutSeq, ...ordered]
}

/** 一条事件是否属于这个任务（SSE 是 scope 级流，弹层只关心自己的）。 */
export function belongsToTask(event: HubActivity, taskId: string): boolean {
  const owner = (event as { taskId?: unknown }).taskId
  return typeof owner === 'string' && owner === taskId
}

/**
 * 把事件压成可读的时间线。
 *
 * @param events `fetchHubActivity({ taskId })` 的结果（已按 seq 升序）
 * @param limit 最多保留多少条**关键**条目（`null` = 不截断）
 */
export function summarizeTimeline(events: HubActivity[], limit: number | null = null): TimelineEntry[] {
  const out: TimelineEntry[] = []
  for (const event of events) {
    const action = typeof event.action === 'string' ? event.action : '(未知动作)'
    const seq = seqOf(event)
    const previous = out[out.length - 1]
    // 折叠：只有相邻同 action 才合并（隔开的两次进度是两件事，不是"×2"）。
    if (previous !== undefined && FOLDABLE_ACTIONS.has(action) && previous.action === action) {
      previous.repeat += 1
      previous.foldedSeqs.push(seq)
      previous.ts = typeof event.ts === 'string' ? event.ts : previous.ts
      previous.raw = event
      continue
    }
    out.push({
      seq,
      action,
      member: typeof event.member === 'string' ? event.member : '',
      ts: typeof event.ts === 'string' ? event.ts : '',
      raw: event,
      repeat: 1,
      foldedSeqs: [],
    })
  }
  if (limit === null || out.length <= limit) return out
  // ★ 截断只砍**可折叠**的条目：关键事件一条都不许因为条数上限消失。
  const kept: TimelineEntry[] = []
  let budget = limit
  // 先从尾部保留（最近的最重要），再按原顺序输出。
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const entry = out[index]
    if (CRITICAL_ACTIONS.has(entry.action)) { kept.unshift(entry); continue }
    if (budget > 0) { kept.unshift(entry); budget -= 1 }
  }
  return kept
}

/** 时间线头部的一句话：多少条、几次返工、几次验证判词。 */
export function timelineHeadline(entries: TimelineEntry[]): string {
  if (entries.length === 0) return '暂无记录'
  const count = (action: string): number => entries.filter((entry) => entry.action === action).length
  const parts = [`${entries.length} 条`]
  const reworks = count('rework') + count('rework:chain') + count('agent-workflow:review-rework')
  if (reworks > 0) parts.push(`返工 ${reworks} 次`)
  const validations = count('runtime:validation')
  if (validations > 0) parts.push(`验证 ${validations} 次`)
  const folded = entries.reduce((sum, entry) => sum + (entry.repeat > 1 ? entry.repeat - 1 : 0), 0)
  if (folded > 0) parts.push(`已折叠 ${folded} 条杂项`)
  return parts.join(' · ')
}

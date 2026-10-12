import type { CardStatus } from './types'

/**
 * 看板**往回拖**（重做 / 打回）的语义判定 —— 纯函数，与 React、与网络都无关。
 *
 * ## 为什么这件事需要一个独立的纯函数
 *
 * 「拖到哪一列」与「这一拖到底要发生什么」在别处是**同一件事**：`onDrop` 拿到列名，
 * 直接发一条 `transition`。加进"重做"之后它们分开了，而分开的地方正是最容易错的一处：
 *
 *   · `done → todo` 在服务端状态机里**没有这条边**（`TRANSITIONS.done = [in_progress, canceled]`），
 *     因为回退到待认领对一条普通任务没有意义；但对"已验收又被打回"的任务，它恰恰是**唯一**的入口。
 *   · `done → in_progress` **有**这条边——于是它就成了一条**静默**的回退：改了状态、没有评论、
 *     下游一条都不重建。而"我验收不满意，打回去重做"这个动作会看起来**成功了**。
 *
 *   > 一条"合法但语义不对"的路，比一条被拒的路危险得多：被拒的会报错，
 *   > 而它会安安静静地把卡片挪回去，让所有人以为重做已经安排上了。
 *
 * 所以判定收敛到这一个函数里，并由用例逐条钉住（`workbench/scripts/rework-plan.test.mjs`）。
 */

/** 从「已完成」往回拖的落点：它们都表示"这段链的产出不要了，重做"。 */
export const REWORK_TARGETS: readonly CardStatus[] = ['todo', 'in_progress', 'in_review'] as const

/** 待验收往回拖的落点：同一目标内的打回重做（不发新目标）。 */
export const RETURN_TARGETS: readonly CardStatus[] = ['todo', 'in_progress'] as const

export type DropPlan =
  /** 常规流转：照旧直接写 `/api/transition`。 */
  | { kind: 'plain' }
  /** 同一目标内打回：必填改动点 + 评论 + `transition → todo`。 */
  | { kind: 'return'; reasonLabel: string }
  /** 验收不满意重做：必填改动点 + `/api/rework`（作废旧链 + 发新目标 + 重建下游）。 */
  | { kind: 'rework'; reasonLabel: string }
  /** 状态机不允许（或原地放下）：给出人话理由。 */
  | { kind: 'illegal'; hint: string }

/**
 * 判定一次拖动该走哪条路。
 *
 * @param from     卡片当前状态
 * @param to       放下的列
 * @param allowed  服务端状态机允许的迁移（客户端预检用；与 hub 的 `TRANSITIONS` 同构）
 */
export function planDrop(from: CardStatus, to: CardStatus, allowed: readonly CardStatus[]): DropPlan {
  if (from === to) return { kind: 'illegal', hint: '目标列与当前列相同' }
  // ① 已验收的卡片往回拖 = 重做。**故意排在状态机预检之前**：`done → todo` 本就没有那条边，
  //    而它正是"验收不满意"的落点；先问状态机的话，这个动作会被自己判成非法。
  if (from === 'done' && REWORK_TARGETS.includes(to)) {
    return { kind: 'rework', reasonLabel: '改动点（必填）' }
  }
  // ② 待验收往回拖 = 同一目标内打回重做。改动点必填：空着等于让执行者按原样再交一次，
  //    而"又交了一遍同样的东西"与"根本没重做"在下一轮验收时看不出区别。
  if (from === 'in_review' && RETURN_TARGETS.includes(to)) {
    return { kind: 'return', reasonLabel: '打回原因（必填）' }
  }
  if (allowed.includes(to)) return { kind: 'plain' }
  return { kind: 'illegal', hint: `状态机不允许 ${from} → ${to}` }
}

/** 改动点是否够用（去空白后非空）。`''` 与 `'   '` 不够用；**只管"是不是空的"**——
 *  写得够不够具体不是机器能判的，这里不假装能判（否则会逼出"aaaa"这种凑数输入）。 */
export function isUsableReason(text: unknown): boolean {
  return typeof text === 'string' && text.trim().length > 0
}

/** `/api/rework` 的回执（扁平报告；字段都可缺，调用方可能拿到老中枢的响应）。 */
export interface ReworkReceipt {
  reworked?: { id?: string; title?: string; fromStatus?: string } | null
  goal?: { id?: string; objective?: string } | null
  created?: Array<{ id?: string; role?: string; label?: string }> | null
  superseded?: string[] | null
}

/**
 * 重做成功后的回执文案：把**新链念清楚**（谁作废了、新目标是哪个、重建了哪几环）。
 *
 * 只说一句"重做成功"是不够的：人会立刻要问"那下游呢？测试和部署要不要重跑？"
 * ——而这正是这次操作最容易被误解的地方（旧链作废 ⇒ 下游真的会重跑）。
 */
export function reworkToast(receipt: unknown): string {
  const r = (receipt ?? {}) as ReworkReceipt
  const oldId = r.reworked?.id ?? ''
  const chain = (r.created ?? [])
    .map(c => (c?.id ? (c.label ? `${c.id}（${c.label}）` : String(c.id)) : ''))
    .filter(s => s.length > 0)
  const head = oldId ? `${oldId} 及其下游已作废` : '旧链已作废'
  const goal = r.goal?.id ? `新目标 ${r.goal.id}` : '新目标'
  if (chain.length === 0) return `${head}；重做已发起（${goal}）`
  return `${head}；${goal} 承接重做：${chain.join(' → ')}`
}

/** 打回成功后的回执文案（同一目标内，不发新目标）。 */
export function returnToast(taskId: string): string {
  return `${taskId} 已打回待办——改动点已写进评论，守护下一轮带着它重做`
}

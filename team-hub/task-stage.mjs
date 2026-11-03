// team-hub/task-stage.mjs
// ============================================================================
// F2 · 派生阶段（设计稿 §3 F2）
//
// 阶段不是"存在列里的一个值"，而是**从事实推出来的结论**：有没有未答问题、
// 任务当前状态、上一次报告说了什么。加列会多一份要维护的真相，而且它会漂移。
//
// 「首次匹配即胜」的顺序（与 superagent 的 ticket stage 同构）：
//   ① 有未答问题            → awaiting_answer（在等人拍板）
//   ② blocked 但没有问题    → stuck（真卡住）
//   ③ 报告过 dropped        → dropped（无需处理）
//   ④ 其它                  → 原样返回 status
// ============================================================================

export const STAGE_VALUES = Object.freeze(['awaiting_answer', 'stuck', 'dropped', 'unknown'])

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 由事实推导阶段。纯函数：同样的输入永远同样的结论。
 *
 * @param task  任务行（用 status / report_state）
 * @param opts.openQuestionCount 该任务当前未答问题数（由子查询算好传进来）
 * @returns {{ stage: string, reason: string }}
 */
export function deriveStage(task, { openQuestionCount = 0 } = {}) {
  if (task === null || task === undefined || typeof task !== 'object') {
    return Object.freeze({ stage: 'unknown', reason: 'no-task' })
  }
  if (Number(openQuestionCount) > 0) {
    return Object.freeze({ stage: 'awaiting_answer', reason: 'open-question' })
  }
  const status = text(task.status)
  if (status === '') return Object.freeze({ stage: 'unknown', reason: 'no-status' })
  if (text(task.report_state) === 'dropped') {
    return Object.freeze({ stage: 'dropped', reason: 'dropped-report' })
  }
  if (status === 'blocked') {
    return Object.freeze({ stage: 'stuck', reason: 'blocked-without-question' })
  }
  return Object.freeze({ stage: status, reason: 'task-status' })
}

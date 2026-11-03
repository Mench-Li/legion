// team-hub/task-resume.mjs
// ============================================================================
// F2 · 回答之后把任务放回可派工（设计稿 §3 F2「回答 → 回 todo」）
//
// 为什么需要它：`answer_question` 只把问题标成 answered，任务还停在 `blocked`；
// 而 F2 的派工闸看的是 `status='todo'`。于是"人答了，活还是不跑"——
// 一个把闸装上、却没装放行开关的系统，比不装闸更糟（它会静默停摆）。
//
// ★ 四条护栏
//   ① 还有**任何**未答问题就不放行（答一个不能放行全部）
//   ② 不在 blocked 的任务不动（不越权改别人的状态）
//   ③ done / canceled 不动（终态不可复活）
//   ④ 走乐观锁（version+1），不是裸改
// ============================================================================

export const TASK_RESUME_ERRORS = Object.freeze({
  TASK_NOT_FOUND: 'TASK_RESUME_NOT_FOUND',
})

export class TaskResumeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'TaskResumeError'
    this.code = code
    this.statusCode = code === TASK_RESUME_ERRORS.TASK_NOT_FOUND ? 404 : 400
  }
}

const TERMINAL = new Set(['done', 'canceled'])

/**
 * 回答后尝试放行任务。
 *
 * @param db
 * @param input.taskId 任务 id
 * @param input.actor  回答者（写进审计）
 * @param input.at     时间
 * @param input.audit  (member, scope, action, taskId, detail) => void（可选）
 * @returns {{ resumed: boolean, reason: string, from?: string, to?: string }}
 */
export function resumeAfterAnswer(db, { taskId, actor = 'system', at = null, audit = null } = {}) {
  const task = db.prepare('SELECT id, scope, status FROM tasks WHERE id=?').get(taskId)
  if (!task) throw new TaskResumeError(TASK_RESUME_ERRORS.TASK_NOT_FOUND, `任务不存在: ${taskId}`)

  if (TERMINAL.has(task.status)) return { resumed: false, reason: 'terminal' }
  if (task.status !== 'blocked') return { resumed: false, reason: 'not-blocked' }

  const open = db.prepare("SELECT COUNT(*) AS c FROM agent_questions WHERE task_id=? AND status='open'").get(taskId)
  if (Number(open?.c ?? 0) > 0) return { resumed: false, reason: 'open-question' }

  const now = at ?? new Date().toISOString()
  db.prepare("UPDATE tasks SET status='todo', version=version+1, updatedAt=? WHERE id=? AND status='blocked'")
    .run(now, taskId)
  if (typeof audit === 'function') {
    audit(actor, task.scope ?? 'default', 'answer_resume', taskId, JSON.stringify({ from: 'blocked', to: 'todo' }))
  }
  return { resumed: true, reason: 'resumed', from: task.status, to: 'todo' }
}

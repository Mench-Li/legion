// team-hub/claim-admission.mjs
// ============================================================================
// F6 + F7 · 认领准入（设计稿 §8.1 / §8.2 接线点）
//
// 保留槽（F7）与目标配额（F6）都在回答同一个问题：**这一轮该不该把这个槽给它？**
// 所以合成一个判定，而不是两个各判一次——两处各写一遍的规则，迟早给出相反结论。
//
// ★ 默认关闭（enabled=false）：开关全关 = 今天的行为（白皮书 A9）。
//   没被验证过的配额/保留槽规则不该在默认路径上影响真实派工。
//
// 判定顺序（先硬后软）：
//   ① 保留槽：只剩保留槽时，后台活必须让开（I-7.3）
//   ② 目标配额：超配额且别的目标在等 ⇒ 让位（I-6.1）；无人在等 ⇒ 借槽（带 TTL）
// ============================================================================

import { normalizeGoalShare, quotaFor } from './goal-share.mjs'
import { reserveSlotDecision, normalizePreemption, PREEMPTION_ERRORS } from './preemption.mjs'

export const ADMISSION_ERRORS = Object.freeze({
  RESERVED_FOR_HUMAN: PREEMPTION_ERRORS.RESERVED_FOR_HUMAN,
  OVER_GOAL_QUOTA: 'ADMISSION_OVER_GOAL_QUOTA',
  TASK_NOT_FOUND: 'ADMISSION_TASK_NOT_FOUND',
})

const HUMAN_KINDS = Object.freeze(['user', 'general', 'human'])
const looksHuman = (by) => HUMAN_KINDS.includes(String(by ?? '').toLowerCase()) || !String(by ?? '').startsWith('agent:')

const safeJson = (value) => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return null }
}

/**
 * 认领准入。
 *
 * @param db
 * @param input.taskId / input.by / input.scope
 * @param opts.enabled     开关（默认 false = 今天的行为）
 * @param opts.now         当前时间
 */
export function admitClaim(db, { taskId, by = null, scope = 'default' } = {}, { enabled = false, now = null } = {}) {
  if (enabled !== true) {
    return Object.freeze({ allowed: true, reason: 'admission-disabled', code: null, userText: '', borrowed: false, borrowUntil: null })
  }

  const task = db.prepare('SELECT id, scope, goalId FROM tasks WHERE id=?').get(String(taskId))
  if (!task) {
    return Object.freeze({ allowed: false, reason: 'task-not-found', code: ADMISSION_ERRORS.TASK_NOT_FOUND, userText: `未知任务 ${taskId}`, borrowed: false, borrowUntil: null })
  }
  const at = now ?? new Date().toISOString()
  const runtime = (() => {
    try {
      return db.prepare('SELECT maxWorkers, reserved_slots, goal_share FROM space_runtime WHERE scope=?').get(String(scope)) ?? null
    } catch { return null }
  })()
  const maxWorkers = Number(runtime?.maxWorkers ?? 1)
  const reservedSlots = Number(runtime?.reserved_slots ?? 1)
  const activeSlots = (() => {
    try { return Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope=? AND status='in_progress'").get(String(scope))?.c ?? 0) }
    catch { return 0 }
  })()

  // ① 保留槽（I-7.3）
  const slot = reserveSlotDecision({
    totalSlots: maxWorkers, activeSlots, humanRequest: looksHuman(by) === true,
    reservedSlots: normalizePreemption({ reservedSlots }).reservedSlots,
  })
  if (slot.allowed !== true) {
    return Object.freeze({ allowed: false, reason: 'reserved-slot', code: slot.code, userText: slot.userText, borrowed: false, borrowUntil: null })
  }

  // ② 目标配额（I-6.1）
  const goalId = task.goalId ?? null
  if (goalId === null) {
    return Object.freeze({ allowed: true, reason: 'no-goal', code: null, userText: '', borrowed: false, borrowUntil: null })
  }
  const config = normalizeGoalShare(safeJson(runtime?.goal_share) ?? undefined)
  const weight = config.weights[String(goalId)] ?? 1
  const quota = quotaFor({ maxWorkers, share: config.default, weight })
  const activeForGoal = (() => {
    try {
      return Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope=? AND status='in_progress' AND goalId=?")
        .get(String(scope), String(goalId))?.c ?? 0)
    } catch { return 0 }
  })()

  if (activeForGoal >= quota) {
    const othersWaiting = (() => {
      try {
        return Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope=? AND status='todo' AND (goalId IS NULL OR goalId<>?)")
          .get(String(scope), String(goalId))?.c ?? 0)
      } catch { return 0 }
    })()
    if (othersWaiting > 0) {
      return Object.freeze({
        allowed: false, reason: 'over-goal-quota', code: ADMISSION_ERRORS.OVER_GOAL_QUOTA,
        userText: `目标 ${goalId} 已占 ${activeForGoal}/${quota} 个槽位，先让位给其它在等的目标`,
        borrowed: false, borrowUntil: null,
      })
    }
    // I-6.1 例外：没人在等 ⇒ 借槽，带 TTL
    const until = new Date(new Date(at).getTime() + config.borrowTtlSec * 1000).toISOString()
    return Object.freeze({ allowed: true, reason: 'borrowed', code: null, userText: '', borrowed: true, borrowUntil: until })
  }

  return Object.freeze({ allowed: true, reason: 'within-quota', code: null, userText: '', borrowed: false, borrowUntil: null })
}

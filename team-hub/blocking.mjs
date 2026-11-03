// team-hub/blocking.mjs
// ============================================================================
// F8 · 并发可解释（设计稿 §8.3 / M10，D3）
//
// 目标：任一排队任务，一眼看出「我被什么挡住」。
//
// 这个接口最容易做坏的方式是"返回一段自由文本"——那样每个消费方都要自己解析，
// 「被什么挡住」又变成猜。所以：
//   · `reason` 是**枚举**（I-8.1），且与 gate 一一对应：
//     `hold` ← not-held ／ `question` ← no-open-question ／ 其余是调度侧的阻塞源
//   · 接口**只读**（I-8.2）——它只回答"为什么"，不改变任何状态
//
// 判定顺序 = 调度器实际的拦截顺序（先天的、再后天的）：
//   hold → question → dependency → fileDomain → lease → slot
// 顺序错了，返回的就不是"第一个真正挡住它的东西"，人就会去解一个不存在的阻塞。
// ============================================================================

export const BLOCKING_REASONS = Object.freeze(['hold', 'question', 'dependency', 'fileDomain', 'lease', 'slot'])

const asArray = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}

const ms = (value) => {
  const t = new Date(String(value ?? '')).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * 解释一条任务为什么没在跑。
 *
 * @param db
 * @param opts.taskId            任务
 * @param opts.now               当前时间（测试用）
 * @param opts.reservations      活跃写入预约 [{taskId, holder, paths, expiresAt, state}]
 * @param opts.totalSlots / activeSlots / reservedSlots   槽位情况
 * @returns {{ blocked: boolean|null, reason: string|null, since: string|null,
 *             blocker: object|null, waitedSec: number|null, error?: string }}
 */
export function explainBlocking(db, {
  taskId, now = null, reservations = [], totalSlots = null, activeSlots = 0, reservedSlots = 1,
} = {}) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(String(taskId))
  if (!task) {
    // `blocked: null` 而不是 `false`：**不知道**与**没被挡**是两件事。
    return Object.freeze({ blocked: null, reason: null, since: null, blocker: null, waitedSec: null, error: 'TASK_NOT_FOUND' })
  }

  const at = now === null || now === undefined ? Date.now() : (ms(now) ?? Date.now())
  const since = task.claimedAt ?? task.updatedAt ?? null
  const waitedSec = (() => {
    const start = ms(since)
    return start === null ? null : Math.max(0, Math.round((at - start) / 1000))
  })()
  const blockedSince = (reason, blocker = null) => Object.freeze({
    blocked: true, reason, since, blocker, waitedSec,
  })

  // ① 将军拦下（对应 gate `not-held`）
  if (Number(task.hold ?? 0) !== 0) return blockedSince('hold')

  // ② 有未答问题（对应 gate `no-open-question`）
  const question = db.prepare("SELECT id, body FROM agent_questions WHERE task_id=? AND status='open' ORDER BY rowid DESC").get(String(taskId))
  if (question) return blockedSince('question', { questionId: question.id, body: question.body ?? null })

  // ③ 依赖未完成
  for (const depId of asArray(task.blockedBy)) {
    const dep = db.prepare('SELECT id, status FROM tasks WHERE id=?').get(String(depId))
    if (!dep || (dep.status !== 'done' && dep.status !== 'canceled')) {
      return blockedSince('dependency', { taskId: String(depId), status: dep?.status ?? null })
    }
  }

  // ④ 文件域被别的任务占着
  const mine = reservations.filter((r) => String(r?.taskId) !== String(taskId))
  if (mine.length > 0) {
    const holder = mine[0]
    return blockedSince('fileDomain', {
      taskId: holder.taskId ?? null,
      holder: holder.holder ?? null,
      expiresAt: holder.expiresAt ?? null,
      paths: asArray(holder.paths),
    })
  }

  // ⑤ 上一次写入还没确认停止（lease 冻结）
  const frozen = reservations.find((r) => String(r?.taskId) === String(taskId) && r?.state === 'reconciling')
  if (frozen) return blockedSince('lease', { taskId: taskId, state: 'reconciling' })

  // ⑥ 槽位：保留槽不算"给后台活的空闲槽"
  if (totalSlots !== null && totalSlots !== undefined) {
    const total = Math.max(1, Number(totalSlots) || 1)
    const active = Math.max(0, Number(activeSlots) || 0)
    const reserved = Math.min(total, Math.max(0, Number(reservedSlots) || 0))
    if (total - active - reserved <= 0) return blockedSince('slot', { active, total, reserved })
  }

  return Object.freeze({ blocked: false, reason: null, since, blocker: null, waitedSec })
}

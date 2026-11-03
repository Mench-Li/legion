// team-hub/preemption.mjs
// ============================================================================
// F7 · 抢占与人优先槽（设计稿 §8.2 / M9，D2）
//
// 目标：满负荷时人还能立刻插话，紧急活能让槽。
//
// 但"能让槽"是四个闸一起兜住的，少一道就变成"谁的请求都能把别人的活踢掉"——
// 那比排队更糟：任务永远开不了工，谁都不敢接活。
//
//   ① 只有**人**能发起（I-7.3）
//   ② 只有 **explicit** 强度的请求能抢（I-7.1：推断/机器人不许踢人）
//   ③ 已跑够 `minRunSec` 才可抢（防抖：刚开工就被踢 = 永远开不了工）
//   ④ 同一任务窗口内被抢次数有上限（I-7.4 防活锁）
//
// ★ 拒绝必须"可被看见"：`alert: true` 让调用方有机会告警，而不是静默不抢。
// ============================================================================

export const DEFAULT_PREEMPTION = Object.freeze({
  reservedSlots: 1,
  minRunSec: 60,
  lockWindowSec: 600,
  maxPreemptionsInWindow: 2,
})

export const PREEMPTION_ERRORS = Object.freeze({
  NOT_HUMAN: 'PREEMPT_NOT_HUMAN',
  NEEDS_EXPLICIT: 'PREEMPT_NEEDS_EXPLICIT',
  TOO_EARLY: 'PREEMPT_TOO_EARLY',
  LOOP_GUARD: 'PREEMPT_LOOP_GUARD',
  RESERVED_FOR_HUMAN: 'SLOT_RESERVED_FOR_HUMAN',
})

const intAtLeast = (value, min, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.round(n)) : fallback
}

/** 归一化配置（脏配置不该决定"谁被踢掉"）。 */
export function normalizePreemption(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    reservedSlots: intAtLeast(source.reservedSlots, 0, DEFAULT_PREEMPTION.reservedSlots),
    // 防抖下限写死 60 秒：比这更短等于没有防抖
    minRunSec: intAtLeast(source.minRunSec, DEFAULT_PREEMPTION.minRunSec, DEFAULT_PREEMPTION.minRunSec),
    lockWindowSec: intAtLeast(source.lockWindowSec, 60, DEFAULT_PREEMPTION.lockWindowSec),
    maxPreemptionsInWindow: intAtLeast(source.maxPreemptionsInWindow, 1, DEFAULT_PREEMPTION.maxPreemptionsInWindow),
  }
}

const HUMAN_KINDS = Object.freeze(['user', 'general', 'human'])

/**
 * 能不能抢占这条正在执行的任务。
 *
 * @returns {{ allowed: boolean, code: string|null, userText: string, alert: boolean }}
 */
export function canPreempt({
  requester = {}, task = {}, recentPreemptions = [], now = null, config = DEFAULT_PREEMPTION,
} = {}) {
  const cfg = normalizePreemption(config)
  const at = now === null || now === undefined ? Date.now() : new Date(String(now)).getTime()

  const deny = (code, userText, alert = false) => Object.freeze({ allowed: false, code, userText, alert })

  if (!HUMAN_KINDS.includes(String(requester?.kind ?? '').toLowerCase())) {
    return deny(PREEMPTION_ERRORS.NOT_HUMAN, '只有人能抢占（机器人/自动流程请排队）')
  }
  if (String(requester?.strength ?? '') !== 'explicit') {
    return deny(PREEMPTION_ERRORS.NEEDS_EXPLICIT, '只有明确请求（explicit）能抢占；推断出来的需求请排队')
  }
  if (String(task?.status ?? '') !== 'in_progress') {
    return deny(PREEMPTION_ERRORS.TOO_EARLY, '只有正在执行的任务谈得上"让槽"')
  }

  const claimedAt = task?.claimedAt ? new Date(String(task.claimedAt)).getTime() : null
  if (claimedAt !== null && Number.isFinite(claimedAt) && at - claimedAt < cfg.minRunSec * 1000) {
    const waited = Math.max(0, Math.round((at - claimedAt) / 1000))
    return deny(PREEMPTION_ERRORS.TOO_EARLY, `任务才跑了 ${waited} 秒（至少 ${cfg.minRunSec} 秒才允许抢占）`)
  }

  const windowStart = at - cfg.lockWindowSec * 1000
  const recent = (Array.isArray(recentPreemptions) ? recentPreemptions : [])
    .map((t) => new Date(String(t)).getTime())
    .filter((t) => Number.isFinite(t) && t >= windowStart && t <= at)
  if (recent.length >= cfg.maxPreemptionsInWindow) {
    return deny(PREEMPTION_ERRORS.LOOP_GUARD,
      `该任务在 ${Math.round(cfg.lockWindowSec / 60)} 分钟内已被抢占 ${recent.length} 次，暂停抢占并告警（防活锁）`, true)
  }

  return Object.freeze({ allowed: true, code: null, userText: '', alert: false })
}

/**
 * 保留槽判定（I-7.3）：保留槽只给人；后台活只有在**不占用保留槽**时才能进。
 *
 * @returns {{ allowed: boolean, code: string|null, userText: string }}
 */
export function reserveSlotDecision({ totalSlots = 1, activeSlots = 0, humanRequest = false, reservedSlots = 1 } = {}) {
  const total = Math.max(1, Math.round(Number(totalSlots) || 1))
  const active = Math.max(0, Math.round(Number(activeSlots) || 0))
  const reserved = Math.min(total, Math.max(0, Math.round(Number(reservedSlots) || 0)))
  const free = Math.max(0, total - active)

  if (humanRequest === true) {
    return Object.freeze({ allowed: free > 0, code: free > 0 ? null : PREEMPTION_ERRORS.RESERVED_FOR_HUMAN, userText: free > 0 ? '' : '没有空闲槽位' })
  }
  // 后台活只能用"非保留"的那部分空闲
  const freeForBackground = Math.max(0, free - reserved)
  if (freeForBackground > 0) return Object.freeze({ allowed: true, code: null, userText: '' })
  return Object.freeze({
    allowed: false,
    code: PREEMPTION_ERRORS.RESERVED_FOR_HUMAN,
    userText: `只剩 ${reserved} 个保留槽（只给人发起的活），后台任务请排队`,
  })
}

/** 抢占说明（I-7.2：被谁 · 因何 · 之后会带你回来）。写进 task_input。 */
export function preemptionNote({ by = 'general', reason = '紧急任务', at = null } = {}) {
  const when = at ?? new Date().toISOString()
  return `⏸ 被 ${by} 因「${reason}」抢占（${when}）；改动已保留，槽位释放后会带你续跑（resume）。`
}

// ── 抢占台账 ────────────────────────────────────────────────────────────────
// I-7.4 的防活锁要有账可查：没有台账，"10 分钟内被抢 2 次"就只能靠记忆。

/** 建表（幂等）。 */
export function ensurePreemptionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preemptions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      by TEXT NOT NULL,
      reason TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_preempt_task ON preemptions(task_id, at);
  `)
}

/** 记一次抢占。 */
export function recordPreemption(db, { taskId, scope = 'default', by = 'general', reason = '', at = null } = {}) {
  const id = `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const when = at ?? new Date().toISOString()
  db.prepare('INSERT INTO preemptions (id, task_id, scope, by, reason, at) VALUES (?,?,?,?,?,?)')
    .run(id, String(taskId), String(scope), String(by), String(reason ?? ''), when)
  return { id, taskId: String(taskId), scope: String(scope), by: String(by), reason: String(reason ?? ''), at: when }
}

/** 某任务在窗口内的抢占时间点（给 canPreempt 用）。 */
export function recentPreemptionsFor(db, taskId, { windowSec = 600, now = null } = {}) {
  const at = now === null || now === undefined ? new Date() : new Date(String(now))
  const from = new Date(at.getTime() - Math.max(0, Number(windowSec) || 0) * 1000).toISOString()
  try {
    return db.prepare('SELECT at FROM preemptions WHERE task_id=? AND at >= ? AND at <= ? ORDER BY at ASC')
      .all(String(taskId), from, at.toISOString()).map((r) => r.at)
  } catch { return [] }
}

// ── 执行面：真正让出槽位 ────────────────────────────────────────────────────
// 判定层只回答"能不能抢"。这里做四步，顺序不能乱：
//   ① 台账  ② 时间线说明（I-7.2）  ③ 回到 todo（可被重新认领 = 可 resume）
//   ④ 尽力通知持有者停手 —— **通知失败不回滚**：任务已释放是事实，通知没发出去是另一个问题，
//      把两者绑在一起会让"人已经抢到了"因为一条消息发不出去而撤销。
export const PREEMPTION_ERRORS_EXTRA = Object.freeze({ TASK_NOT_FOUND: 'PREEMPT_TASK_NOT_FOUND' })

/**
 * 应用一次抢占（判定已通过之后）。
 *
 * @param deps.transitionTask (id, to, by) => void   状态机迁移（权威）
 * @param deps.commandFn      (input) => any         通知持有者停手（可失败）
 * @param deps.appendInput    (db, spec, opts) =>    写时间线
 * @param deps.audit          (member, scope, action, taskId, detail) => void
 */
export function applyPreemption(db, { taskId, by = 'general', reason = '', at = null } = {}, {
  transitionTask = null, commandFn = null, appendInput = null, audit = null,
} = {}) {
  const task = db.prepare('SELECT id, scope, status, soldier FROM tasks WHERE id=?').get(String(taskId))
  if (!task) {
    throw Object.assign(new Error(`未知任务 ${taskId}`), {
      code: PREEMPTION_ERRORS.TASK_NOT_FOUND, statusCode: 404,
    })
  }
  const when = at ?? new Date().toISOString()

  // ① 台账
  const preemption = recordPreemption(db, { taskId, scope: task.scope ?? 'default', by, reason, at: when })

  // ② 时间线说明
  const note = preemptionNote({ by, reason, at: when })
  if (typeof appendInput === 'function') {
    try {
      appendInput(db, {
        taskId, kind: 'comment', actor: by, actorKind: 'user',
        body: note, at: when, channel: 'preempt', meta: { preemptionId: preemption.id },
      }, { inTransaction: false })
    } catch { /* 任务已不可写：台账仍然有效 */ }
  }

  // ③ 回到 todo（只有真的在执行才动状态；不越权改别人的状态）
  let transitioned = false
  if (String(task.status) === 'in_progress' && typeof transitionTask === 'function') {
    transitionTask(taskId, 'todo', by)
    transitioned = true
  }

  // ④ 尽力通知持有者停手（失败只降级为 notified:false）
  let notified = false
  if (typeof commandFn === 'function') {
    try {
      commandFn({ taskId, scope: task.scope ?? 'default', type: 'stop_run', by, reason })
      notified = true
    } catch { notified = false }
  }

  if (typeof audit === 'function') {
    audit(by, task.scope ?? 'default', 'preempt', taskId,
      JSON.stringify({ reason, preemptionId: preemption.id, transitioned, notified }))
  }
  return { applied: true, preemption, note, transitioned, notified }
}
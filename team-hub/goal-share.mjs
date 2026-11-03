// team-hub/goal-share.mjs
// ============================================================================
// F6 · 目标级配额与公平（设计稿 §8.1 / M8，D1）
//
// 要解决的问题只有一个：**一个大目标不能把槽位吃干，小目标不能饿死。**
//
// 配额很容易做错，两个典型错法：
//   · 把它做进 `TASK_GATES` ⇒ 变成"资格判定"，于是空载时大目标也被挡住（把公平做成闲置）；
//   · 不做借槽 ⇒ 配额上限成为硬顶，空载时仍有一半槽位空转。
// 所以这里的边界写死：
//   · 只影响**认领顺序与准入**，不动 gate（I-6.3）
//   · 超配额但**没有别的目标在等** ⇒ 借槽，且带 TTL（I-6.1 / I-6.2）
// ============================================================================

export const DEFAULT_GOAL_SHARE = Object.freeze({ default: 0.5, weights: Object.freeze({}), borrowTtlSec: 600 })
export const BORROW_TTL_MIN_SEC = 60

const clamp01 = (n) => Math.min(1, Math.max(0, n))

/** 归一化空间配置。任何非法值都回默认——配额算错的代价是"活干不完"，不该由脏配置决定。 */
export function normalizeGoalShare(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const share = Number(source.default)
  const ttl = Number(source.borrowTtlSec)
  const weights = {}
  if (source.weights !== null && typeof source.weights === 'object') {
    for (const [goalId, value] of Object.entries(source.weights)) {
      const weight = Number(value)
      if (Number.isFinite(weight) && weight > 0) weights[String(goalId)] = Math.round(weight)
    }
  }
  return {
    default: Number.isFinite(share) ? clamp01(share) : DEFAULT_GOAL_SHARE.default,
    weights,
    // 下限是**夹住**而不是回默认：配置想填 5 秒，正确反应是"至少 60 秒"，
    // 而不是悄悄变成 10 分钟——后者会让"我明明配了 5 秒"永远查不出原因。
    borrowTtlSec: Number.isFinite(ttl) ? Math.max(BORROW_TTL_MIN_SEC, Math.round(ttl)) : DEFAULT_GOAL_SHARE.borrowTtlSec,
  }
}

/** 单目标配额：向上取整，且**至少 1**（否则小目标永远排不进）。 */
export function quotaFor({ maxWorkers = 1, share = 0.5, weight = 1 } = {}) {
  const workers = Math.max(1, Math.round(Number(maxWorkers) || 1))
  const sized = workers * clamp01(Number(share)) * Math.max(1, Math.round(Number(weight) || 1))
  return Math.max(1, Math.ceil(sized))
}

/**
 * 这条候选该不该进槽。
 *
 * @returns {{ admit: boolean, reason: string, borrowUntil: string|null, userText: string }}
 */
export function admitCandidate({
  goalId = null, activeForGoal = 0, maxWorkers = 1, config = DEFAULT_GOAL_SHARE,
  otherGoalsWaiting = 0, now = null,
} = {}) {
  const cfg = normalizeGoalShare(config)
  const weight = goalId !== null && cfg.weights[String(goalId)] !== undefined ? cfg.weights[String(goalId)] : 1
  const quota = quotaFor({ maxWorkers, share: cfg.default, weight })

  if (Number(activeForGoal) < quota) {
    return Object.freeze({ admit: true, reason: 'within-quota', borrowUntil: null, quota, userText: '' })
  }
  // I-6.1 的例外：没有别的目标在等时，允许借槽把机器用满（否则配额=闲置）
  if (Number(otherGoalsWaiting) <= 0) {
    const base = now === null || now === undefined ? new Date() : new Date(String(now))
    const until = new Date(base.getTime() + cfg.borrowTtlSec * 1000).toISOString()
    return Object.freeze({ admit: true, reason: 'borrowed', borrowUntil: until, quota, userText: '' })
  }
  return Object.freeze({
    admit: false, reason: 'over-quota', borrowUntil: null, quota,
    userText: `目标 ${goalId ?? '（无目标）'} 已占 ${activeForGoal}/${quota} 个槽位，先让位给其它在等的目标`,
  })
}

const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 })
/**
 * 排序：缺口大的目标优先 → priority 高的优先 → 先来的优先。
 * **不改候选集合**，只改顺序（I-6.3）。
 */
export function orderCandidates(candidates, { activeByGoal = {}, config = DEFAULT_GOAL_SHARE, maxWorkers = 1 } = {}) {
  const cfg = normalizeGoalShare(config)
  const list = Array.isArray(candidates) ? [...candidates] : []

  const deficitOf = (goalId) => {
    const weight = goalId !== null && cfg.weights[String(goalId)] !== undefined ? cfg.weights[String(goalId)] : 1
    const quota = quotaFor({ maxWorkers, share: cfg.default, weight })
    const active = Number(activeByGoal[String(goalId)] ?? 0)
    return quota - active
  }

  return list.sort((a, b) => {
    const deficitDiff = deficitOf(b.goalId ?? null) - deficitOf(a.goalId ?? null)
    if (deficitDiff !== 0) return deficitDiff
    const rankDiff = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
    if (rankDiff !== 0) return rankDiff
    return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
  })
}

// ── 借槽台账 ────────────────────────────────────────────────────────────────
// 借槽是配额能"空载时吃满"的原因，也是最容易变成**永久占用**的地方：
// 借出去不收回，第二次借就成了白送，配额名存实亡。所以借槽必须自带 TTL 与释放记录。

/** 建借槽表（幂等）。 */
export function ensureBorrowSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_borrows (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      task_id TEXT,
      scope TEXT NOT NULL DEFAULT 'default',
      granted_at TEXT NOT NULL,
      until TEXT NOT NULL,
      released_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_borrow_until ON goal_borrows(released_at, until);
  `)
}

/** 记一笔借槽。 */
export function recordBorrow(db, { goalId, taskId = null, scope = 'default', grantedAt = null, ttlSec = null } = {}) {
  const cfg = normalizeGoalShare({ borrowTtlSec: ttlSec ?? undefined })
  const start = grantedAt ?? new Date().toISOString()
  const until = new Date(new Date(start).getTime() + cfg.borrowTtlSec * 1000).toISOString()
  const id = `br-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  db.prepare('INSERT INTO goal_borrows (id, goal_id, task_id, scope, granted_at, until) VALUES (?,?,?,?,?,?)')
    .run(id, String(goalId), taskId ?? null, String(scope), start, until)
  return db.prepare('SELECT * FROM goal_borrows WHERE id=?').get(id)
}

/** 还没释放的借槽。 */
export function activeBorrows(db, { goalId = null } = {}) {
  return goalId === null || goalId === undefined
    ? db.prepare('SELECT * FROM goal_borrows WHERE released_at IS NULL ORDER BY until ASC').all()
    : db.prepare('SELECT * FROM goal_borrows WHERE released_at IS NULL AND goal_id=? ORDER BY until ASC').all(String(goalId))
}

/**
 * 释放到期借槽，并给每一笔写一条 `share_release` 审计（I-6.2）。
 * 幂等：已释放的不会再被选中，所以重跑不会刷审计。
 */
export function releaseExpiredBorrows(db, { now = null, audit = null } = {}) {
  const at = now ?? new Date().toISOString()
  const expired = db.prepare('SELECT * FROM goal_borrows WHERE released_at IS NULL AND until <= ? ORDER BY until ASC')
    .all(String(at))
  const goals = []
  // 没注入 audit 时**自己写**——释放动作必须留痕（I-6.2）：
  // 不能因为调用方忘了传回调，就静默变成"借了不还也没人知道"。
  const emit = typeof audit === 'function' ? audit : (member, scope, action, taskId, detail) => {
    try {
      db.prepare('INSERT INTO audit (ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?)')
        .run(at, member, scope, action, taskId, detail)
    } catch { /* 没有 audit 表：忽略，仍完成释放 */ }
  }
  for (const borrow of expired) {
    db.prepare('UPDATE goal_borrows SET released_at=? WHERE id=? AND released_at IS NULL').run(at, borrow.id)
    if (!goals.includes(borrow.goal_id)) goals.push(borrow.goal_id)
    emit('system', borrow.scope ?? 'default', 'share_release', borrow.task_id ?? null,
      JSON.stringify({ goalId: borrow.goal_id, borrowId: borrow.id, until: borrow.until }))
  }
  return { released: expired.length, goals, at }
}
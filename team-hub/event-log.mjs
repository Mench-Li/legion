// team-hub/event-log.mjs
// ============================================================================
// F5 · 事件流与对账（设计稿 §3 F5 / M6）
//
// 事件流的唯一职责是**回答"为什么"**。它**不驱动**任何业务动作——
// 尤其不得触发派工（I-5.2）。把这条写成判据，比写在文档里有用：
// 任何一次"顺手在消费器里推进一下任务"都会让 event-log.test.mjs ⑥ 变红。
//
// ★ 四条纪律
//   ① `event_id = hash(kind, subject, version)`：可重算 ⇒ 可去重、可对账（I-5.4）
//   ② 事件与状态写入**同事务**：调用方在自己的 `withTx` 里先写状态、再 `stampEvent`
//   ③ `event_cursor.seq` 单调，回退被拒：重启续读、不重放（I-5.3）
//   ④ 对账**只读**：差异只报不修（I-5.5）
// ============================================================================

import { createHash } from 'node:crypto'
import { ensureColumn } from './schema-util.mjs'

export const EVENT_SCHEMA_ID = 'legion/events@1'

/** 审计行的四种"人味"标记：谁、说给谁、是不是人（决定能不能授权）。 */
export const ACTOR_KINDS = Object.freeze(['user', 'general', 'soldier', 'ci', 'bot', 'system'])
export const ADDRESSED_KINDS = Object.freeze(['mention', 'direct', 'none'])

/** 建列 / 建表（幂等；并发安全由 ensureColumn 保证）。 */
export function ensureEventSchema(db) {
  ensureColumn(db, 'audit', 'actor_kind', 'TEXT')
  ensureColumn(db, 'audit', 'addressed', 'TEXT')
  ensureColumn(db, 'audit', 'human', 'INTEGER')
  ensureColumn(db, 'audit', 'event_id', 'TEXT')
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_event ON audit(event_id) WHERE event_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS event_cursor (
      consumer TEXT PRIMARY KEY, seq INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  ensureColumn(db, 'tasks', 'watches', "JSON DEFAULT '[]'")
}

/** 事件 id：由 (kind, subject, version) 决定，可重算。 */
export function eventIdFor({ kind, subject, version }) {
  const digest = createHash('sha1')
    .update(`${String(kind)}\u0000${String(subject)}\u0000${String(version)}`)
    .digest('hex')
  return `ev-${digest.slice(0, 24)}`
}

/**
 * 给一条既有审计行盖上事件章。
 *
 * 为什么是"给既有行盖章"而不是再插一行：状态写入与事件追加必须同事务（I-5.1），
 * 而审计行本来就是那次写入的产物。再造一张表等于逼业务写两次。
 *
 * @returns {{ seq: number, eventId: string, duplicate: boolean }}
 */
export function stampEvent(db, { seq, kind, subject, version, actorKind = null, addressed = null, human = null, payload = null } = {}) {
  const eventId = eventIdFor({ kind, subject, version })
  const existing = db.prepare('SELECT seq FROM audit WHERE event_id=?').get(eventId)
  if (existing) return { seq: Number(existing.seq), eventId, duplicate: true }

  // ★ 不改 `action`：既有读取方（看板 / 审计页）按 action 分派，
  // 把 `transition` 改写成 `task_status` 会让它们静默失配。kind 只在 event_id 里。
  db.prepare(`UPDATE audit SET event_id=?, actor_kind=?, addressed=?, human=? WHERE seq=?`).run(
    eventId,
    actorKind, addressed,
    human === null || human === undefined ? null : (human ? 1 : 0),
    Number(seq),
  )
  // payload 存进 detail 的旁路列不存在，就把它拼进 detail 保持可读（不新增列）。
  if (payload !== null && payload !== undefined) {
    const row = db.prepare('SELECT detail FROM audit WHERE seq=?').get(Number(seq))
    const merged = JSON.stringify({ detail: row?.detail ?? null, payload })
    db.prepare('UPDATE audit SET detail=? WHERE seq=?').run(merged, Number(seq))
  }
  return { seq: Number(seq), eventId, duplicate: false }
}

/** 只读事件流（按 seq 升序）。 */
export function readEvents(db, { since = 0, limit = 200 } = {}) {
  return db.prepare(`SELECT seq, ts, member, scope, action, taskId, detail, event_id AS eventId,
      actor_kind AS actorKind, addressed, human
    FROM audit WHERE event_id IS NOT NULL AND seq > ? ORDER BY seq ASC LIMIT ?`)
    .all(Number(since) || 0, Math.max(1, Number(limit) || 200))
}

/** 消费者游标（单调、不重放）。 */
export function createCursorStore(db) {
  return {
    get(consumer) {
      const row = db.prepare('SELECT seq FROM event_cursor WHERE consumer=?').get(String(consumer))
      return row ? Number(row.seq) : 0
    },
    /** 前进到 seq；回退被忽略（I-5.3）。 */
    advance(consumer, seq) {
      const current = this.get(consumer)
      const next = Math.max(current, Number(seq) || 0)
      if (next === current && current !== 0) return current
      db.prepare(`INSERT INTO event_cursor (consumer, seq, updated_at) VALUES (?,?,?)
        ON CONFLICT(consumer) DO UPDATE SET seq=excluded.seq, updated_at=excluded.updated_at`)
        .run(String(consumer), next, new Date().toISOString())
      return next
    },
    /** 取游标之后的事件并前进游标。**只读事件，不改任何业务状态**（I-5.2）。 */
    poll(consumer, { limit = 200 } = {}) {
      const cursor = this.get(consumer)
      const events = readEvents(db, { since: cursor, limit })
      const next = events.length > 0 ? Number(events[events.length - 1].seq) : cursor
      this.advance(consumer, next)
      return { events, cursor: next }
    },
  }
}

/**
 * 对账：把 `task_status` 事件重放到状态表，找差异。**只读**，不修复（I-5.5）。
 *
 * @returns {{ checked: number, mismatched: Array<{taskId, expected, actual}> }}
 */
export function reconcileEvents(db, { untilSeq = null, scope = null } = {}) {
  const params = []
  let sql = `SELECT taskId, detail FROM audit
    WHERE event_id IS NOT NULL AND action='task_status' AND taskId IS NOT NULL`
  if (untilSeq !== null && untilSeq !== undefined) { sql += ' AND seq <= ?'; params.push(Number(untilSeq)) }
  sql += ' ORDER BY seq ASC'

  const expected = new Map()
  for (const row of db.prepare(sql).all(...params)) {
    const to = extractTo(row.detail)
    if (to !== null) expected.set(String(row.taskId), to)
  }

  const mismatched = []
  for (const [taskId, want] of expected) {
    const task = db.prepare('SELECT id, status, scope FROM tasks WHERE id=?').get(taskId)
    if (!task) { mismatched.push({ taskId, expected: want, actual: null }); continue }
    if (scope !== null && scope !== undefined && task.scope !== scope) continue
    if (task.status !== want) mismatched.push({ taskId, expected: want, actual: task.status })
  }
  return { checked: expected.size, mismatched }
}

function extractTo(detail) {
  if (detail === null || detail === undefined) return null
  try {
    const parsed = typeof detail === 'string' ? JSON.parse(detail) : detail
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.to === 'string') return parsed.to
      if (parsed.payload && typeof parsed.payload.to === 'string') return parsed.payload.to
    }
  } catch { /* 非 JSON detail：没有可重放的状态 */ }
  return null
}

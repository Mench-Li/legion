// team-hub/write-intent-store.mjs
// ============================================================================
// 写入意图与预约事务（并行任务文件冲突治理 S2 / R-2 · R-3 服务端）
//
// 设计 §4/§5：team-hub SQLite 是唯一调度事实源。本模块落地
//   · task_write_intents —— 任务**计划**写入的范围（是 tasks.fileDomain 的子集）；
//   · write_reservations  —— 实际**占用**（活跃 reservation 之间同仓库两两不相交）；
//   · BEGIN IMMEDIATE 事务 —— 认领时 Attempt lease 与首次 reservation 一次性授予，
//     任一步失败整体回滚（不出现「已认领但没有写入资格」的半状态）。
//
// 关键纪律：
//   · 路径判定**只**用 packages/shared/src/path-domain.mjs（AC-R1-6，禁止第二份前缀判定）；
//   · 冲突返回结构化 FILE_CONTENTION { code, paths, holderTaskId }，等待不算执行失败；
//   · 释放核对 Attempt 与 epoch（epoch fencing）：过期 epoch 一律拒绝并回报真实 epoch；
//   · 租约过期且未确认进程退出 → reservation=reconciling，而不是立即释放；
//   · 非 Git（capability=degraded）时同仓库只允许一个写入任务。
//
// 本模块不自建连接：db 由调用方注入（与 run-store.mjs 立场相同）。零第三方依赖。
// ============================================================================
import { toEntryList, intersectingPaths, normalizeRepoPath } from '../packages/shared/src/path-domain.mjs'

export const INTENT_STATES = Object.freeze(['proposed', 'reserved', 'released'])
export const RESERVATION_STATES = Object.freeze(['unplanned', 'waiting-file', 'reserved', 'reconciling', 'released'])
export const ACTIVE_RESERVATION_STATES = Object.freeze(['reserved', 'reconciling'])

export const WRITE_INTENT_ERRORS = Object.freeze({
  FILE_CONTENTION: 'FILE_CONTENTION',
  INVALID_PATHS: 'INVALID_PATHS',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  EPOCH_STALE: 'EPOCH_STALE',
  NO_ACTIVE_RESERVATION: 'NO_ACTIVE_RESERVATION',
  SINGLE_WRITER_REQUIRED: 'SINGLE_WRITER_REQUIRED',
})

/** 建表（幂等、可从旧库启动）。 */
export function ensureWriteIntentSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_write_intents (
    task_id TEXT PRIMARY KEY,
    attempt_id TEXT,
    repo_id TEXT NOT NULL,
    target_ref TEXT,
    paths_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'planner',
    state TEXT NOT NULL DEFAULT 'proposed',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS write_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    lease_epoch INTEGER NOT NULL,
    paths_json TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS write_intent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    wait_ms INTEGER,
    detail_json TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_write_intents_repo ON task_write_intents(repo_id, state)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_write_reservations_repo_state ON write_reservations(repo_id, state)')
  return true
}

const ACTIVE_SQL = "state IN ('reserved','reconciling')"

function parsePaths(json) {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function toReservation(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    repoId: row.repo_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    leaseEpoch: row.lease_epoch,
    paths: Object.freeze(parsePaths(row.paths_json)),
    state: row.state,
    reason: row.reason ?? null,
    expiresAtMs: row.expires_at_ms ?? null,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  })
}

function toIntent(row) {
  if (!row) return null
  return Object.freeze({
    taskId: row.task_id,
    attemptId: row.attempt_id ?? null,
    repoId: row.repo_id,
    targetRef: row.target_ref ?? null,
    paths: Object.freeze(parsePaths(row.paths_json)),
    revision: row.revision,
    source: row.source,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  })
}

function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw err
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?:()=>number, caseInsensitive?:boolean}} [options]
 */
export function createWriteIntentStore(db, { now = () => Date.now(), caseInsensitive = false } = {}) {
  const opts = { caseInsensitive }

  const activeRows = (repoId) => db.prepare(
    `SELECT * FROM write_reservations WHERE repo_id = ? AND ${ACTIVE_SQL} ORDER BY id ASC`,
  ).all(repoId)

  const intentRow = (taskId) => db.prepare('SELECT * FROM task_write_intents WHERE task_id = ?').get(taskId)

  /** 只追加事件：metrics 与审计读它，不靠猜。 */
  function appendEvent({ repoId, taskId, attemptId = null, kind, atMs = now(), waitMs = null, detail = null }) {
    db.prepare(`INSERT INTO write_intent_events (repo_id, task_id, attempt_id, kind, at_ms, wait_ms, detail_json)
      VALUES (?,?,?,?,?,?,?)`).run(repoId, taskId, attemptId, kind, atMs, waitMs, detail === null ? null : JSON.stringify(detail))
  }

  /** 成功预约时补记等待时长：取同任务最近一条尚无 wait_ms 的 CONTENTION。 */
  function closeContentionWait({ repoId, taskId, atMs }) {
    const prior = db.prepare(
      "SELECT id, at_ms FROM write_intent_events WHERE repo_id = ? AND task_id = ? AND kind = 'FILE_CONTENTION' AND wait_ms IS NULL ORDER BY id DESC LIMIT 1",
    ).get(repoId, taskId)
    if (prior) db.prepare('UPDATE write_intent_events SET wait_ms = ? WHERE id = ?').run(Math.max(0, atMs - prior.at_ms), prior.id)
  }

  /** 请求路径 ∩ 活跃预约路径：返回结构化冲突列表。 */
  function findConflicts(repoId, entries, { ignoreTaskId = null, ignoreAttemptId = null } = {}) {
    const out = []
    for (const row of activeRows(repoId)) {
      if (ignoreTaskId !== null && row.task_id === ignoreTaskId
        && (ignoreAttemptId === null || row.attempt_id === ignoreAttemptId)) continue
      const holder = parsePaths(row.paths_json).map((p) => (typeof p === 'string' ? { path: p, type: 'file' } : p))
      const pairs = intersectingPaths(entries, holder, opts)
      for (const pair of pairs) out.push(Object.freeze({
        path: pair.a,
        holderPath: pair.b,
        holderTaskId: row.task_id,
        holderAttemptId: row.attempt_id ?? null,
        holderState: row.state,
      }))
    }
    return out
  }

  function uniqueConflictPaths(conflicts) {
    const seen = new Set()
    const paths = []
    for (const c of conflicts) {
      if (!seen.has(c.path)) { seen.add(c.path); paths.push(c.path) }
    }
    return paths
  }

  function contention(conflicts) {
    return Object.freeze({
      ok: false,
      code: WRITE_INTENT_ERRORS.FILE_CONTENTION,
      reason: `文件被任务 ${conflicts[0].holderTaskId} 占用：${uniqueConflictPaths(conflicts).join(', ')}`,
      paths: Object.freeze(uniqueConflictPaths(conflicts)),
      holderTaskId: conflicts[0].holderTaskId,
      holderAttemptId: conflicts[0].holderAttemptId,
      conflicts: Object.freeze(conflicts),
    })
  }

  function upsertIntentRow({ repoId, taskId, attemptId, targetRef, paths, source, state, expectedRevision = null }) {
    const existing = intentRow(taskId)
    if (existing && expectedRevision !== null && Number(existing.revision) !== Number(expectedRevision)) {
      return { conflict: Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.REVISION_CONFLICT, currentRevision: existing.revision, reason: 'intent revision 已过期' }) }
    }
    const ts = now()
    if (!existing) {
      db.prepare(`INSERT INTO task_write_intents
        (task_id, attempt_id, repo_id, target_ref, paths_json, revision, source, state, created_at_ms, updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        taskId, attemptId ?? null, repoId, targetRef ?? null, JSON.stringify(paths), 1, source ?? 'planner', state ?? 'proposed', ts, ts)
    } else {
      db.prepare(`UPDATE task_write_intents
        SET attempt_id = ?, repo_id = ?, target_ref = ?, paths_json = ?, revision = ?, source = ?, state = ?, updated_at_ms = ?
        WHERE task_id = ?`).run(
        attemptId ?? existing.attempt_id ?? null, repoId, targetRef ?? existing.target_ref ?? null,
        JSON.stringify(paths), Number(existing.revision) + 1, source ?? existing.source, state ?? existing.state, ts, taskId)
    }
    return { intent: toIntent(intentRow(taskId)) }
  }

  return {
    /** 规划期/执行期登记写入意图（revision CAS）。 */
    upsertIntent({ repoId, taskId, attemptId = null, targetRef = null, paths, source = 'planner', state = 'proposed', expectedRevision = null }) {
      const set = toEntryList(paths, opts)
      if (set.rejected.length > 0) {
        return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.INVALID_PATHS, reason: set.rejected[0].reason, rejected: set.rejected })
      }
      return withTx(db, () => {
        const r = upsertIntentRow({ repoId, taskId, attemptId, targetRef, paths: set.entries, source, state, expectedRevision })
        if (r.conflict) return r.conflict
        return Object.freeze({ ok: true, intent: r.intent })
      })
    },

    getIntent(taskId) { return toIntent(intentRow(taskId)) },
    listActiveReservations(repoId) { return Object.freeze(activeRows(repoId).map(toReservation)) },
    listWriteIntentEvents(repoId = null) {
      const rows = repoId === null
        ? db.prepare('SELECT * FROM write_intent_events ORDER BY id ASC').all()
        : db.prepare('SELECT * FROM write_intent_events WHERE repo_id = ? ORDER BY id ASC').all(repoId)
      return Object.freeze(rows)
    },

    /**
     * 申请写入资格（预约）。同仓库相交路径只允许一个赢家。
     */
    reserve({ repoId, taskId, attemptId = null, epoch, paths, targetRef = null, source = 'orchestrator', leaseMs = null, expectedRevision = null, capability = 'git' }) {
      const set = toEntryList(paths, opts)
      if (set.rejected.length > 0) {
        return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.INVALID_PATHS, reason: set.rejected[0].reason, rejected: set.rejected })
      }
      const entries = set.entries
      return withTx(db, () => {
        const others = activeRows(repoId).filter((row) => !(row.task_id === taskId && (attemptId === null || row.attempt_id === attemptId)))
        if (capability !== 'git' && others.length > 0) {
          return Object.freeze({
            ok: false,
            code: WRITE_INTENT_ERRORS.SINGLE_WRITER_REQUIRED,
            reason: '该仓库不是 Git 工作区：首版只允许一个写入任务，请等待当前写入任务结束',
            holderTaskId: others[0].task_id,
          })
        }
        const conflicts = findConflicts(repoId, entries, { ignoreTaskId: taskId, ignoreAttemptId: attemptId })
        if (conflicts.length > 0) {
          appendEvent({ repoId, taskId, attemptId, kind: 'FILE_CONTENTION', detail: { paths: uniqueConflictPaths(conflicts), holderTaskId: conflicts[0].holderTaskId } })
          return contention(conflicts)
        }

        const ts = now()
        closeContentionWait({ repoId, taskId, atMs: ts })
        appendEvent({ repoId, taskId, attemptId, kind: 'RESERVED', atMs: ts })
        const expires = leaseMs === null || leaseMs === undefined ? null : ts + Number(leaseMs)
        const json = JSON.stringify(entries)
        const own = db.prepare(
          `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
        ).get(repoId, taskId)
        if (own && (attemptId === null || own.attempt_id === attemptId)) {
          db.prepare('UPDATE write_reservations SET attempt_id=?, lease_epoch=?, paths_json=?, state=?, expires_at_ms=?, updated_at_ms=? WHERE id=?')
            .run(attemptId ?? own.attempt_id, epoch, json, 'reserved', expires, ts, own.id)
        } else {
          db.prepare(`INSERT INTO write_reservations
            (repo_id, task_id, attempt_id, lease_epoch, paths_json, state, reason, expires_at_ms, created_at_ms, updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            repoId, taskId, attemptId, epoch, json, 'reserved', null, expires, ts, ts)
        }
        const r = upsertIntentRow({ repoId, taskId, attemptId, targetRef, paths: entries, source, state: 'reserved', expectedRevision })
        if (r.conflict) throw Object.assign(new Error('intent revision conflict'), { code: r.conflict.code, payload: r.conflict })
        const row = db.prepare('SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1').get(repoId, taskId)
        return Object.freeze({ ok: true, reservation: toReservation(row), intent: r.intent })
      })
    },

    /** 释放预约：必须核对 Attempt 与 epoch。 */
    release({ repoId, taskId, attemptId = null, epoch }) {
      const row = db.prepare(
        `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
      ).get(repoId, taskId)
      if (!row) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.NO_ACTIVE_RESERVATION, reason: '没有活跃的写入预约' })
      if (Number(row.lease_epoch) !== Number(epoch)) {
        return Object.freeze({
          ok: false,
          code: WRITE_INTENT_ERRORS.EPOCH_STALE,
          reason: `epoch 已过期：当前真实 epoch 为 ${row.lease_epoch}`,
          currentEpoch: row.lease_epoch,
        })
      }
      return withTx(db, () => {
        const ts = now()
        db.prepare('UPDATE write_reservations SET state=?, updated_at_ms=? WHERE id=?').run('released', ts, row.id)
        const intent = intentRow(taskId)
        if (intent) db.prepare('UPDATE task_write_intents SET state=?, updated_at_ms=? WHERE task_id=?').run('released', ts, taskId)
        return Object.freeze({ ok: true, reservation: toReservation({ ...row, state: 'released', updated_at_ms: ts }) })
      })
    },

    /** 进程未确认退出：冻结为 reconciling，而不是立即释放。 */
    markReconciling({ repoId, taskId, attemptId = null, epoch, reason = 'lease-expired' }) {
      const row = db.prepare(
        `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
      ).get(repoId, taskId)
      if (!row) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.NO_ACTIVE_RESERVATION })
      if (Number(row.lease_epoch) !== Number(epoch)) {
        return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.EPOCH_STALE, currentEpoch: row.lease_epoch })
      }
      const ts = now()
      db.prepare('UPDATE write_reservations SET state=?, reason=?, updated_at_ms=? WHERE id=?').run('reconciling', reason, ts, row.id)
      return Object.freeze({ ok: true, reservation: toReservation({ ...row, state: 'reconciling', reason, updated_at_ms: ts }) })
    },

    /** 扫描过期租约：冻结为 reconciling（需要人工/对账确认才真正释放）。 */
    sweepExpiredLeases({ repoId = null, nowMs = now() } = {}) {
      const rows = repoId === null
        ? db.prepare(`SELECT * FROM write_reservations WHERE ${ACTIVE_SQL} AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`).all(nowMs)
        : db.prepare(`SELECT * FROM write_reservations WHERE repo_id = ? AND ${ACTIVE_SQL} AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`).all(repoId, nowMs)
      const frozen = []
      for (const row of rows) {
        db.prepare('UPDATE write_reservations SET state=?, reason=?, updated_at_ms=? WHERE id=?').run('reconciling', 'lease-expired', nowMs, row.id)
        frozen.push(toReservation({ ...row, state: 'reconciling', reason: 'lease-expired', updated_at_ms: nowMs }))
      }
      return Object.freeze(frozen)
    },

    /** 动态扩域：事务内检查新增范围是否撞上其他活跃预约。 */
    expandIntent({ repoId, taskId, attemptId = null, epoch, addPaths, expectedRevision = null }) {
      const set = toEntryList(addPaths, opts)
      if (set.rejected.length > 0) {
        return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.INVALID_PATHS, rejected: set.rejected })
      }
      return withTx(db, () => {
        const intent = intentRow(taskId)
        if (!intent) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.NO_ACTIVE_RESERVATION, reason: '没有写入意图' })
        if (expectedRevision !== null && Number(intent.revision) !== Number(expectedRevision)) {
          return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.REVISION_CONFLICT, currentRevision: intent.revision })
        }
        const conflicts = findConflicts(repoId, set.entries, { ignoreTaskId: taskId, ignoreAttemptId: attemptId })
        if (conflicts.length > 0) return contention(conflicts)
        const merged = []
        const seen = new Set()
        for (const e of [...parsePaths(intent.paths_json).map((p) => (typeof p === 'string' ? { path: p, type: 'file' } : p)), ...set.entries]) {
          const n = normalizeRepoPath(e.path, opts)
          if (!n.ok) continue
          const key = n.path + '|' + (e.type || 'file')
          if (seen.has(key)) continue
          seen.add(key)
          merged.push({ path: n.path, type: e.type || 'file' })
        }
        const ts = now()
        db.prepare('UPDATE task_write_intents SET paths_json=?, revision=?, updated_at_ms=? WHERE task_id=?')
          .run(JSON.stringify(merged), Number(intent.revision) + 1, ts, taskId)
        const row = db.prepare(
          `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
        ).get(repoId, taskId)
        if (row) db.prepare('UPDATE write_reservations SET paths_json=?, updated_at_ms=? WHERE id=?').run(JSON.stringify(merged), ts, row.id)
        return Object.freeze({ ok: true, revision: Number(intent.revision) + 1, paths: Object.freeze(merged) })
      })
    },

    /**
     * claim 事务：Attempt 创建与首次 reservation 在同一 BEGIN IMMEDIATE 内完成；
     * createAttempt 抛错或预约冲突都整体回滚（无半状态）。
     */
    claimWithReservation({ repoId, taskId, attemptId, epoch, paths, targetRef = null, source = 'claim', capability = 'git', leaseMs = null, createAttempt }) {
      const set = toEntryList(paths, opts)
      if (set.rejected.length > 0) {
        return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.INVALID_PATHS, rejected: set.rejected })
      }
      return withTx(db, () => {
        const attempt = typeof createAttempt === 'function' ? createAttempt() : null
        const others = activeRows(repoId).filter((row) => row.task_id !== taskId)
        if (capability !== 'git' && others.length > 0) {
          throw Object.assign(new Error('single-writer-required'), { code: WRITE_INTENT_ERRORS.SINGLE_WRITER_REQUIRED })
        }
        const conflicts = findConflicts(repoId, set.entries)
        if (conflicts.length > 0) {
          throw Object.assign(new Error('file-contention'), { code: WRITE_INTENT_ERRORS.FILE_CONTENTION, payload: contention(conflicts) })
        }
        const ts = now()
        const expires = leaseMs === null || leaseMs === undefined ? null : ts + Number(leaseMs)
        db.prepare(`INSERT INTO write_reservations
          (repo_id, task_id, attempt_id, lease_epoch, paths_json, state, reason, expires_at_ms, created_at_ms, updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(repoId, taskId, attemptId, epoch, JSON.stringify(set.entries), 'reserved', null, expires, ts, ts)
        const r = upsertIntentRow({ repoId, taskId, attemptId, targetRef, paths: set.entries, source, state: 'reserved' })
        const row = db.prepare('SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1').get(repoId, taskId)
        return Object.freeze({ ok: true, attempt, reservation: toReservation(row), intent: r.intent })
      })
    },

    /** 全库扫描：同仓库活跃预约两两不相交（不变量自检）。 */
    assertNoActiveOverlap(repoId) {
      const rows = activeRows(repoId)
      const conflicts = []
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const a = parsePaths(rows[i].paths_json).map((p) => (typeof p === 'string' ? { path: p, type: 'file' } : p))
          const b = parsePaths(rows[j].paths_json).map((p) => (typeof p === 'string' ? { path: p, type: 'file' } : p))
          const pairs = intersectingPaths(a, b, opts)
          if (pairs.length > 0) conflicts.push(Object.freeze({ a: rows[i].task_id, b: rows[j].task_id, paths: pairs }))
        }
      }
      return Object.freeze({ ok: conflicts.length === 0, conflicts: Object.freeze(conflicts) })
    },
  }
}

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
import { ensureColumn } from './schema-util.mjs'

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
    exclusive INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    reason TEXT,
    expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`)
  ensureColumn(db, 'write_reservations', 'exclusive', 'INTEGER NOT NULL DEFAULT 0')
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
    exclusive: Number(row.exclusive ?? 0) === 1,
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

let savepointSerial = 0
function withTx(db, fn) {
  const nested = db.isTransaction === true
  const savepoint = `write_intent_${++savepointSerial}`
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
    return out
  } catch (err) {
    try {
      if (nested) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`) }
      else db.exec('ROLLBACK')
    } catch { /* 已回滚 */ }
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
  function findConflicts(repoId, entries, { ignoreTaskId = null, ignoreAttemptId = null, exclusive = false } = {}) {
    const out = []
    for (const row of activeRows(repoId)) {
      if (ignoreTaskId !== null && row.task_id === ignoreTaskId
        && (ignoreAttemptId === null || row.attempt_id === ignoreAttemptId)) continue
      const holder = parsePaths(row.paths_json).map((p) => (typeof p === 'string' ? { path: p, type: 'file' } : p))
      const pairs = (exclusive || Number(row.exclusive ?? 0) === 1)
        ? [{ a: entries[0]?.path ?? '(whole repository)', b: holder[0]?.path ?? '(whole repository)' }]
        : intersectingPaths(entries, holder, opts)
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
        const active = db.prepare(`SELECT id FROM write_reservations WHERE task_id=? AND ${ACTIVE_SQL} LIMIT 1`).get(taskId)
        if (active) return Object.freeze({ ok: false, code: 'RESERVATION_ACTIVE', reason: '执行中的范围只能走扩域事务修改' })
        const r = upsertIntentRow({ repoId, taskId, attemptId, targetRef, paths: set.entries, source, state, expectedRevision })
        if (r.conflict) return r.conflict
        return Object.freeze({ ok: true, intent: r.intent })
      })
    },

    getIntent(taskId) { return toIntent(intentRow(taskId)) },

    /**
     * 「这个任务打算写哪些路径」的**唯一**取法 —— 认领 / 预约 / 过渡 / 诊断**四处共用**。
     *
     * 优先级（既有语义，本次不改）：active write-intent 优先于 `tasks.fileDomain`；
     * 两者都没有 ⇒ 空数组，调用方据此按**整仓独占**处理（`exclusive: paths.length === 0`）。
     *
     * ★ 为什么必须是一个函数而不是各写一遍（这是 BUG-006 的根因）：
     *   诊断端点 `GET /api/tasks/:id/contention` 曾经自己写成 `intent?.paths ?? []` —— **不看
     *   fileDomain**。于是同一个任务在诊断里被当成"未申报 ⇒ 整仓独占"，而认领路径却用它自己的
     *   fileDomain 正常认领。实测（2026-10-05）：T-178 声明了 5 个目录、确实在跑，诊断却报
     *   「文件被任务 T-177 占用：(whole repository)」—— 将军据此去查了一个**不存在的文件冲突**
     *   （真相是它只是排在并发槽位后面）。
     *   这正是该端点注释里写的 "no duplicate UI path algorithm" 要防的事：同一件事两处各解释一次，
     *   迟早漂移；而漂移出来的是**读数**，比缺一个功能更贵 —— 它会让排障的人修不存在的问题。
     *
     * `from` 让调用方不必再自己判断一遍"路径是哪来的"（原先每个调用点各写一次三元表达式，
     * 那也是同一类分叉的温床）；调用方只需把 'intent' 映射成自己的 source 文案。
     *
     * @param {string} taskId
     * @param {{ intent?: object|null }} [pre] 调用方**已经读过**的 intent（避免二次读库导致两次判断不一致）
     * @returns {{ paths: ReadonlyArray<unknown>, from: 'intent'|'file-domain-fallback'|'unplanned-exclusive' }}
     *   `from === 'intent'` 时 `paths` 是 intent 里**原样**的条目（`upsertIntent` 写入时已归一化成
     *   `{ok,path,type}`；历史行可能是裸字符串）。这与修改前各调用点的行为一致
     *   （`intent?.paths ?? …` 不做二次规范化），`reserve()`/`inspectContention()` 自己会再归一。
     *   本次只统一**取法**，不顺手改形状。
     *   `from === 'file-domain-fallback'` 时是 `{path,type:'dir'}`（因为列里存的是字符串）。
     */
    resolvePlannedPaths(taskId, pre = {}) {
      const intent = pre.intent === undefined ? toIntent(intentRow(taskId)) : pre.intent
      const asDirEntries = (list) => (Array.isArray(list)
        ? list.map((p) => (typeof p === 'string' ? { path: p, type: 'dir' } : p))
        : [])
      // 与原来逐字一致的取法：intent?.paths ?? fileDomain（注意 `??` 只在 null/undefined 时回落，
      // intent 存在但 paths 为 [] 时**不**回落 —— 那是"申报了零个路径"的显式意图，不是没申报）。
      const fallback = asDirEntries(parsePaths(db.prepare('SELECT fileDomain FROM tasks WHERE id=?').get(taskId)?.fileDomain))
      const paths = intent?.paths ?? fallback
      return Object.freeze({
        paths: Object.freeze(paths),
        from: intent ? 'intent' : paths.length > 0 ? 'file-domain-fallback' : 'unplanned-exclusive',
      })
    },
    listActiveReservations(repoId) { return Object.freeze(activeRows(repoId).map(toReservation)) },
    inspectContention({ repoId, taskId, paths = [], exclusive = false }) {
      const set = toEntryList(paths, opts)
      if (set.rejected.length > 0) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.INVALID_PATHS, rejected: set.rejected })
      const conflicts = findConflicts(repoId, set.entries, { ignoreTaskId: taskId, exclusive })
      return conflicts.length > 0 ? contention(conflicts) : Object.freeze({ ok: true, conflicts: Object.freeze([]) })
    },
    listWriteIntentEvents(repoId = null) {
      const rows = repoId === null
        ? db.prepare('SELECT * FROM write_intent_events ORDER BY id ASC').all()
        : db.prepare('SELECT * FROM write_intent_events WHERE repo_id = ? ORDER BY id ASC').all(repoId)
      return Object.freeze(rows)
    },

    /**
     * 申请写入资格（预约）。同仓库相交路径只允许一个赢家。
     */
    reserve({ repoId, taskId, attemptId = null, epoch, paths, targetRef = null, source = 'orchestrator', leaseMs = null, expectedRevision = null, capability = 'git', exclusive = false }) {
      const set = toEntryList(paths, opts)
      if (set.rejected.length > 0) {
        return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.INVALID_PATHS, reason: set.rejected[0].reason, rejected: set.rejected })
      }
      const entries = set.entries
      return withTx(db, () => {
        const own = db.prepare(
          `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
        ).get(repoId, taskId)
        if (own?.state === 'reconciling') return Object.freeze({ ok: false, code: 'RECONCILING', reason: '上一轮执行尚未确认停止' })
        if (own && Number(epoch) < Number(own.lease_epoch)) {
          return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.EPOCH_STALE, currentEpoch: own.lease_epoch })
        }
        if (own && attemptId !== null && own.attempt_id !== null && own.attempt_id !== attemptId) {
          return Object.freeze({ ok: false, code: 'ATTEMPT_MISMATCH', reason: '上一轮执行仍持有预约' })
        }
        // A running attempt may only replay its original request. Scope changes must
        // use expandIntent, which checks the new paths and never shrinks the lock.
        if (own) {
          const same = Number(epoch) === Number(own.lease_epoch)
            && own.attempt_id === attemptId
            && Number(own.exclusive ?? 0) === (exclusive ? 1 : 0)
            && JSON.stringify(parsePaths(own.paths_json)) === JSON.stringify(entries)
          if (!same) return Object.freeze({ ok: false, code: 'RESERVATION_ACTIVE', reason: '执行中的预约不能覆盖范围或 epoch；扩域请使用扩域事务' })
          return Object.freeze({ ok: true, reservation: toReservation(own), intent: toIntent(intentRow(taskId)) })
        }
        const others = activeRows(repoId).filter((row) => !(row.task_id === taskId && (attemptId === null || row.attempt_id === attemptId)))
        if (capability !== 'git' && others.length > 0) {
          return Object.freeze({
            ok: false,
            code: WRITE_INTENT_ERRORS.SINGLE_WRITER_REQUIRED,
            reason: '该仓库不是 Git 工作区：首版只允许一个写入任务，请等待当前写入任务结束',
            holderTaskId: others[0].task_id,
          })
        }
        const conflicts = findConflicts(repoId, entries, { ignoreTaskId: taskId, ignoreAttemptId: attemptId, exclusive })
        if (conflicts.length > 0) {
          appendEvent({ repoId, taskId, attemptId, kind: 'FILE_CONTENTION', detail: { paths: uniqueConflictPaths(conflicts), holderTaskId: conflicts[0].holderTaskId } })
          return contention(conflicts)
        }

        const ts = now()
        closeContentionWait({ repoId, taskId, atMs: ts })
        appendEvent({ repoId, taskId, attemptId, kind: 'RESERVED', atMs: ts })
        const expires = leaseMs === null || leaseMs === undefined ? null : ts + Number(leaseMs)
        const json = JSON.stringify(entries)
        {
          db.prepare(`INSERT INTO write_reservations
            (repo_id, task_id, attempt_id, lease_epoch, paths_json, exclusive, state, reason, expires_at_ms, created_at_ms, updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
            repoId, taskId, attemptId, epoch, json, exclusive ? 1 : 0, 'reserved', null, expires, ts, ts)
        }
        const r = upsertIntentRow({ repoId, taskId, attemptId, targetRef, paths: entries, source, state: 'reserved', expectedRevision })
        if (r.conflict) throw Object.assign(new Error('intent revision conflict'), { code: r.conflict.code, payload: r.conflict })
        const row = db.prepare('SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1').get(repoId, taskId)
        return Object.freeze({ ok: true, reservation: toReservation(row), intent: r.intent })
      })
    },

    /** A reviewed attempt has stopped; keep the same path lock while binding it to its retry. */
    rebindForRetry({ repoId, taskId, oldAttemptId, newAttemptId, epoch }) {
      return withTx(db, () => {
        const row = db.prepare(`SELECT * FROM write_reservations WHERE repo_id=? AND task_id=? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`).get(repoId, taskId)
        if (!row || row.state !== 'reserved' || row.attempt_id !== oldAttemptId) return Object.freeze({ ok: false, code: 'RETRY_RESERVATION_MISSING' })
        if (!Number.isInteger(epoch) || epoch <= Number(row.lease_epoch)) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.EPOCH_STALE, currentEpoch: row.lease_epoch })
        const ts = now()
        db.prepare('UPDATE write_reservations SET attempt_id=?, lease_epoch=?, updated_at_ms=? WHERE id=?').run(newAttemptId, epoch, ts, row.id)
        db.prepare('UPDATE task_write_intents SET attempt_id=?, revision=revision+1, updated_at_ms=? WHERE task_id=?').run(newAttemptId, ts, taskId)
        appendEvent({ repoId, taskId, attemptId: newAttemptId, kind: 'REBOUND_FOR_RETRY', atMs: ts, detail: { oldAttemptId, epoch } })
        return Object.freeze({ ok: true, reservation: toReservation(db.prepare('SELECT * FROM write_reservations WHERE id=?').get(row.id)) })
      })
    },

    /** 释放预约：必须核对 Attempt 与 epoch。 */
    release({ repoId, taskId, attemptId = null, epoch }) {
      return withTx(db, () => {
        const row = db.prepare(
          `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
        ).get(repoId, taskId)
        if (!row) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.NO_ACTIVE_RESERVATION, reason: '没有活跃的写入预约' })
        if (Number(row.lease_epoch) !== Number(epoch)) {
          return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.EPOCH_STALE, reason: `epoch 已过期：当前真实 epoch 为 ${row.lease_epoch}`, currentEpoch: row.lease_epoch })
        }
        if (attemptId !== null && row.attempt_id !== attemptId) return Object.freeze({ ok: false, code: 'ATTEMPT_MISMATCH', reason: '预约属于另一运行尝试' })
        const ts = now()
        db.prepare('UPDATE write_reservations SET state=?, updated_at_ms=? WHERE id=?').run('released', ts, row.id)
        const intent = intentRow(taskId)
        if (intent) db.prepare('UPDATE task_write_intents SET state=?, updated_at_ms=? WHERE task_id=?').run('released', ts, taskId)
        return Object.freeze({ ok: true, reservation: toReservation({ ...row, state: 'released', updated_at_ms: ts }) })
      })
    },

    /** 进程未确认退出：冻结为 reconciling，而不是立即释放。 */
    markReconciling({ repoId, taskId, attemptId = null, epoch, reason = 'lease-expired' }) {
      return withTx(db, () => {
        const row = db.prepare(
          `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
        ).get(repoId, taskId)
        if (!row) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.NO_ACTIVE_RESERVATION })
        if (Number(row.lease_epoch) !== Number(epoch)) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.EPOCH_STALE, currentEpoch: row.lease_epoch })
        if (attemptId !== null && row.attempt_id !== attemptId) return Object.freeze({ ok: false, code: 'ATTEMPT_MISMATCH' })
        const ts = now()
        db.prepare('UPDATE write_reservations SET state=?, reason=?, updated_at_ms=? WHERE id=?').run('reconciling', reason, ts, row.id)
        return Object.freeze({ ok: true, reservation: toReservation({ ...row, state: 'reconciling', reason, updated_at_ms: ts }) })
      })
    },

    /** 扫描过期租约：冻结为 reconciling（需要人工/对账确认才真正释放）。 */
    sweepExpiredLeases({ repoId = null, nowMs = now() } = {}) {
      return withTx(db, () => {
        const rows = repoId === null
          ? db.prepare(`SELECT * FROM write_reservations WHERE state='reserved' AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`).all(nowMs)
          : db.prepare(`SELECT * FROM write_reservations WHERE repo_id = ? AND state='reserved' AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`).all(repoId, nowMs)
        const frozen = []
        for (const row of rows) {
          db.prepare('UPDATE write_reservations SET state=?, reason=?, updated_at_ms=? WHERE id=?').run('reconciling', 'lease-expired', nowMs, row.id)
          frozen.push(toReservation({ ...row, state: 'reconciling', reason: 'lease-expired', updated_at_ms: nowMs }))
        }
        return Object.freeze(frozen)
      })
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
        const row = db.prepare(
          `SELECT * FROM write_reservations WHERE repo_id = ? AND task_id = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
        ).get(repoId, taskId)
        if (!row) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.NO_ACTIVE_RESERVATION })
        if (Number(row.lease_epoch) !== Number(epoch)) return Object.freeze({ ok: false, code: WRITE_INTENT_ERRORS.EPOCH_STALE, currentEpoch: row.lease_epoch })
        if (attemptId !== null && row.attempt_id !== attemptId) return Object.freeze({ ok: false, code: 'ATTEMPT_MISMATCH' })
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
        if (row) db.prepare('UPDATE write_reservations SET paths_json=?, updated_at_ms=? WHERE id=?').run(JSON.stringify(merged), ts, row.id)
        return Object.freeze({ ok: true, revision: Number(intent.revision) + 1, paths: Object.freeze(merged) })
      })
    },

    /**
     * claim 事务：Attempt 创建与首次 reservation 在同一 BEGIN IMMEDIATE 内完成；
     * createAttempt 抛错或预约冲突都整体回滚（无半状态）。
     */
    claimWithReservation({ repoId, taskId, attemptId, epoch, paths, targetRef = null, source = 'claim', capability = 'git', leaseMs = null, exclusive = false, createAttempt }) {
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
        const conflicts = findConflicts(repoId, set.entries, { exclusive })
        if (conflicts.length > 0) {
          throw Object.assign(new Error('file-contention'), { code: WRITE_INTENT_ERRORS.FILE_CONTENTION, payload: contention(conflicts) })
        }
        const ts = now()
        const expires = leaseMs === null || leaseMs === undefined ? null : ts + Number(leaseMs)
        db.prepare(`INSERT INTO write_reservations
          (repo_id, task_id, attempt_id, lease_epoch, paths_json, exclusive, state, reason, expires_at_ms, created_at_ms, updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(repoId, taskId, attemptId, epoch, JSON.stringify(set.entries), exclusive ? 1 : 0, 'reserved', null, expires, ts, ts)
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
          const pairs = (Number(rows[i].exclusive ?? 0) === 1 || Number(rows[j].exclusive ?? 0) === 1)
            ? [{ a: '(whole repository)', b: '(whole repository)' }]
            : intersectingPaths(a, b, opts)
          if (pairs.length > 0) conflicts.push(Object.freeze({ a: rows[i].task_id, b: rows[j].task_id, paths: pairs }))
        }
      }
      return Object.freeze({ ok: conflicts.length === 0, conflicts: Object.freeze(conflicts) })
    },
  }
}

// team-hub/context-store.mjs
// ============================================================================
// RunContextSnapshot 的持久化与查看（PRT-409，spec §6.5）
//
// 表：`run_context_snapshots(attempt_id PRIMARY KEY, ...)`。
//
// 阶段 4 的完成标准是「任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因」。
// 在写入这张表之前，那份快照只存在于一次函数调用的栈上——**没有持久化就等于
// 无法查看任何快照**，于是完成标准无法达成，无论装配器做得多对。
//
// ## 一次写入 = 一次 Attempt 的上下文，且**不可变**
//
// spec §6.5：快照在 `BuildingContext` 完成、Attempt 进入 `Running` **之前**冻结，
// 之后不可修改。所以这里**没有 update**：只有 `record` 与读。重复 record 同一
// `attemptId` 时：
//
//   · 内容哈希相同 → 幂等成功（重试写同一次运行的同一份快照是合法的）；
//   · 内容哈希不同 → **拒绝**（同一 Attempt 的上下文不可能有两个版本，
//     出现两个说明有一次写入是错的，而"后写的赢"会让那一次错的那份成为事实）。
//
// 这条规则和别处的墓碑/CAS 是同一纪律：**冲突时报冲突，不替用户决定用哪一版。**
//
// ## 存的是**全文**，不只是哈希
//
// 只存哈希的"审计"无法回答"模型当时到底看到了什么"——而那正是本表的目的。
// 所以 `final_text` 原样存。代价是库会长大；收益是"还原"这个词有了字面意义。
// 需要控制体积时应当在**保留策略**上做（按时间/按任务清理），
// 而不是在**记录内容**上省——省掉的是这个功能唯一的产出。
// ============================================================================

import { verifySnapshotHash } from '../runtime/contracts/context.mjs'
import { describeAssembly } from '../runtime/context/assembler.mjs'

export const CONTEXT_STORE_ERRORS = Object.freeze({
  ATTEMPT_REQUIRED: 'CONTEXT_ATTEMPT_REQUIRED',
  NOT_FOUND: 'CONTEXT_NOT_FOUND',
  CONFLICT: 'CONTEXT_SNAPSHOT_CONFLICT',
  INVALID_SNAPSHOT: 'CONTEXT_SNAPSHOT_INVALID',
  BAD_PAYLOAD: 'CONTEXT_BAD_PAYLOAD',
})

export class ContextStoreError extends Error {
  constructor(code, message, { statusCode = 400, ...extra } = {}) {
    super(message)
    this.name = 'ContextStoreError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

export function ensureContextSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_context_snapshots (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      scope TEXT,
      goal_id TEXT,
      task_id TEXT,
      employee_id TEXT,
      team_plan_id TEXT,
      frozen_at_ms INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      snapshot_hash TEXT NOT NULL,
      final_text TEXT NOT NULL,
      tokens_kind TEXT NOT NULL,
      tokens_count INTEGER NOT NULL,
      max_tokens INTEGER,
      budget_trimmed INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL,
      included_count INTEGER NOT NULL,
      excluded_count INTEGER NOT NULL,
      truncation_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_run ON run_context_snapshots (run_id, frozen_at_ms)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_context_scope ON run_context_snapshots (scope, frozen_at_ms)')
}

function rowToSummary(r) {
  return Object.freeze({
    attemptId: r.attempt_id,
    runId: r.run_id,
    scope: r.scope,
    associations: {
      goalId: r.goal_id, taskId: r.task_id, employeeId: r.employee_id, teamPlanId: r.team_plan_id,
    },
    frozenAtMs: r.frozen_at_ms,
    recordedAtMs: r.recorded_at_ms,
    snapshotHash: r.snapshot_hash,
    tokens: { kind: r.tokens_kind, tokens: r.tokens_count },
    maxTokens: r.max_tokens,
    budgetTrimmed: r.budget_trimmed === 1,
    candidateCount: r.candidate_count,
    includedCount: r.included_count,
    excludedCount: r.excluded_count,
    truncationCount: r.truncation_count,
  })
}

/** 把 payload_json 读回来。坏掉的 JSON **不能**当成"空快照"——那会让一份损坏的记录看起来正常。 */
function parsePayload(text, attemptId) {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new ContextStoreError(CONTEXT_STORE_ERRORS.BAD_PAYLOAD,
      `快照 ${attemptId} 的记录损坏（payload 不是合法 JSON）：${e instanceof Error ? e.message : String(e)}`,
      { statusCode: 500 })
  }
}

export function createContextStore({ db, clock = () => Date.now(), writeAudit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createContextStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createContextStore 的 clock 必须是函数')
  ensureContextSchema(db)

  function audit(payload) {
    if (typeof writeAudit === 'function') writeAudit(payload)
  }

  /**
   * 记下一份快照。**只增不改**。
   *
   * @param {object} snapshot 装配器产出的快照（必须自带 `snapshotHash`）
   * @param {{scope?: string, actor?: string}} [opts]
   */
  function record(snapshot, { scope = null, actor = null } = {}) {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new ContextStoreError(CONTEXT_STORE_ERRORS.INVALID_SNAPSHOT, '快照必须是对象')
    }
    const attemptId = snapshot.attemptId
    if (typeof attemptId !== 'string' || attemptId.trim() === '') {
      throw new ContextStoreError(CONTEXT_STORE_ERRORS.ATTEMPT_REQUIRED, '快照必须带 attemptId（它是主键）')
    }

    // **落库前重算一遍哈希。** 一个哈希对不上的快照被存进去，会让往后每一次
    // "还原"都建立在一份被改过的记录上，而且没有任何东西会说话。
    if (verifySnapshotHash(snapshot) !== true) {
      throw new ContextStoreError(CONTEXT_STORE_ERRORS.INVALID_SNAPSHOT,
        `快照 ${attemptId} 的哈希与内容不符：它被改过，或不是由装配器产出的。拒绝落库。`,
        { statusCode: 400, attemptId })
    }

    const existing = db.prepare('SELECT snapshot_hash FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    if (existing !== undefined && existing.snapshot_hash === snapshot.snapshotHash) {
      // 幂等：同一次运行的同一份快照写两次是合法的（重试）。
      //
      // **这条路径也要写审计。** 第一版在幂等分支**直接 return**，而审计写在后面——
      // 于是"第一次写成功但审计抛错 → 客户端看到 400 → 重试命中幂等分支 → 200"
      // 这串动作的结果是：快照在库里、审计**永远缺失**，而客户端最后看到的是成功。
      // 每一次"我们记下了这次运行"都该留下痕迹，包括重试带来的那一次。
      audit({
        action: 'context.record', attemptId, runId: snapshot.runId, actor,
        detail: { snapshotHash: snapshot.snapshotHash, idempotent: true },
      })
      return Object.freeze({ ok: true, attemptId, idempotent: true, snapshotHash: snapshot.snapshotHash })
    }
    if (existing !== undefined) {
      // 同一 Attempt 的上下文不可能有两个版本。报冲突，而不是"后写的赢"。
      throw new ContextStoreError(CONTEXT_STORE_ERRORS.CONFLICT,
        `Attempt ${attemptId} 已有一份不同的上下文快照（已存 ${existing.snapshot_hash.slice(0, 19)}…，` +
        `本次 ${snapshot.snapshotHash.slice(0, 19)}…）。同一次运行的上下文不可能有两个版本。`,
        { statusCode: 409, attemptId, existingHash: existing.snapshot_hash, incomingHash: snapshot.snapshotHash })
    }

    const nowMs = clock()
    const a = snapshot.associations ?? {}
    db.prepare(
      `INSERT INTO run_context_snapshots
        (attempt_id, run_id, scope, goal_id, task_id, employee_id, team_plan_id,
         frozen_at_ms, recorded_at_ms, schema_version, snapshot_hash, final_text,
         tokens_kind, tokens_count, max_tokens, budget_trimmed,
         candidate_count, included_count, excluded_count, truncation_count, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attemptId, snapshot.runId, scope, a.goalId ?? null, a.taskId ?? null, a.employeeId ?? null, a.teamPlanId ?? null,
      snapshot.frozenAtMs, nowMs, snapshot.schemaVersion, snapshot.snapshotHash, snapshot.finalText ?? '',
      snapshot.tokens.kind, snapshot.tokens.tokens, snapshot.budget?.maxTokens ?? null, snapshot.budget?.trimmed ? 1 : 0,
      snapshot.candidateCount, snapshot.sources.length, snapshot.excluded.length,
      Array.isArray(snapshot.truncations) ? snapshot.truncations.length : 0,
      JSON.stringify(snapshot),
    )

    // 复读确认：写进去的与算出来的一致，否则"记录成功"是假的。
    const after = db.prepare('SELECT snapshot_hash, included_count, excluded_count FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    if (after === undefined || after.snapshot_hash !== snapshot.snapshotHash
      || after.included_count !== snapshot.sources.length || after.excluded_count !== snapshot.excluded.length) {
      throw new ContextStoreError(CONTEXT_STORE_ERRORS.INVALID_SNAPSHOT,
        '快照写入后复读不一致：记录没有生效', { statusCode: 500, attemptId })
    }

    audit({
      action: 'context.record', attemptId, runId: snapshot.runId, actor,
      detail: {
        snapshotHash: snapshot.snapshotHash,
        idempotent: false,
        includedCount: snapshot.sources.length,
        excludedCount: snapshot.excluded.length,
        truncationCount: Array.isArray(snapshot.truncations) ? snapshot.truncations.length : 0,
        tokens: snapshot.tokens.tokens,
        tokensKind: snapshot.tokens.kind,
      },
    })
    return Object.freeze({ ok: true, attemptId, idempotent: false, snapshotHash: snapshot.snapshotHash })
  }

  /** 列表（摘要，不含正文）。默认按冻结时间倒序。 */
  function list({ runId = null, scope = null, limit = 100, offset = 0 } = {}) {
    const where = []
    const args = []
    if (runId !== null) { where.push('run_id = ?'); args.push(runId) }
    if (scope !== null) { where.push('scope = ?'); args.push(scope) }
    const sql = `SELECT * FROM run_context_snapshots${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY frozen_at_ms DESC, attempt_id ASC LIMIT ? OFFSET ?`
    return db.prepare(sql).all(...args, limit, offset).map(rowToSummary)
  }

  /** 取一条**完整**的快照（含正文、分段与两个账本）。 */
  function get(attemptId) {
    const r = db.prepare('SELECT * FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    if (r === undefined) return null
    const payload = parsePayload(r.payload_json, attemptId)
    return Object.freeze({ ...rowToSummary(r), snapshot: payload, summary: describeAssembly(payload) })
  }

  /** 读回时**再验一次哈希**：库里的记录可能被外部改过。 */
  function verify(attemptId) {
    const r = db.prepare('SELECT snapshot_hash, payload_json FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    if (r === undefined) {
      throw new ContextStoreError(CONTEXT_STORE_ERRORS.NOT_FOUND, `没有这份上下文快照：${attemptId}`, { statusCode: 404 })
    }
    const payload = parsePayload(r.payload_json, attemptId)
    const ok = verifySnapshotHash(payload) === true && payload.snapshotHash === r.snapshot_hash
    return Object.freeze({ ok, attemptId, storedHash: r.snapshot_hash, recomputedHash: payload.snapshotHash ?? null })
  }

  function count() {
    return db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n
  }

  return Object.freeze({ record, list, get, verify, count })
}

// team-hub/delivery-store.mjs
// ============================================================================
// 交付子状态与集成 job store（并行任务文件冲突治理 S3 / R-4）
//
// 设计 §3.2 的交付子状态七值词表（awaiting-acceptance / ready / preparing /
// validating / needs-review / integrated / abandoned）与写入调度五值词表**互相独立**，
// 不拿交付状态代替文件占用状态。integrated 与 abandoned 是终态，重做必须产生
// 新 Attempt 和新 delivery（本模块不覆盖旧行）。
//
// 设计 §4：同仓库同 target ref 同时至多一个活跃 integration job（epoch 租约）；
// integration_events 只追加；崩溃恢复靠 journal + Git SHA 对账。
//
// 全部状态更新走 version CAS：过期页面提交返回 VERSION_CONFLICT（HTTP 层映射 409）。
// ============================================================================
import { intersectingPaths } from '../packages/shared/src/path-domain.mjs'

export const DELIVERY_STATES = Object.freeze([
  'awaiting-acceptance', 'ready', 'preparing', 'validating', 'needs-review', 'integrated', 'abandoned',
])
export const TERMINAL_DELIVERY_STATES = Object.freeze(['integrated', 'abandoned'])
export const SCHEDULING_STATES = Object.freeze(['unplanned', 'waiting-file', 'reserved', 'reconciling', 'released'])
export const INTEGRATION_JOB_STATES = Object.freeze(['leased', 'applying', 'ref-updated', 'finalized', 'paused', 'failed'])
export const ACTIVE_JOB_STATES = Object.freeze(['leased', 'applying', 'ref-updated'])
export const INTEGRATION_JOURNAL_PHASES = Object.freeze(['prepared', 'applying', 'ref-updated', 'finalized'])
export const DELIVERY_DECISIONS = Object.freeze(['adopt-a', 'adopt-b', 'rework', 'abandon'])

const TRANSITIONS = Object.freeze({
  'awaiting-acceptance': Object.freeze(['ready', 'needs-review', 'abandoned']),
  ready: Object.freeze(['preparing', 'needs-review', 'abandoned']),
  preparing: Object.freeze(['validating', 'needs-review', 'abandoned']),
  validating: Object.freeze(['integrated', 'needs-review', 'abandoned']),
  'needs-review': Object.freeze(['ready', 'abandoned']),
  integrated: Object.freeze([]),
  abandoned: Object.freeze([]),
})

export const DELIVERY_ERRORS = Object.freeze({
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TERMINAL_STATE: 'TERMINAL_STATE',
  ENQUEUE_GATE: 'ENQUEUE_GATE',
  JOB_CONTENTION: 'JOB_CONTENTION',
  EPOCH_STALE: 'EPOCH_STALE',
  NOT_FOUND: 'NOT_FOUND',
})

export function ensureDeliverySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_deliveries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    source_commit TEXT NOT NULL,
    base_commit TEXT,
    target_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    validation_id TEXT,
    integrated_commit TEXT,
    decision_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS integration_jobs (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    delivery_id TEXT,
    expected_head TEXT,
    prepared_commit TEXT,
    journal_phase TEXT,
    state TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL,
    owner TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS integration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    delivery_id TEXT,
    actor TEXT,
    at_ms INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT,
    git_sha TEXT,
    error_code TEXT,
    validation_summary TEXT,
    detail_json TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_deliveries_task ON task_deliveries(task_id, created_at_ms)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_integration_jobs_active ON integration_jobs(repo_id, target_ref, state)')
  return true
}

/**
 * 入队门禁（纯函数）。任一条不过就不允许进入 ready。
 */
export function checkEnqueueGates({
  finalDiffPaths = [], fileDomain = null, intentPaths = null,
  acceptanceEvidence = null, humanApprovalRequired = false, humanApproved = false,
  caseInsensitive = false,
} = {}) {
  const reasons = []
  const diff = [...finalDiffPaths].map((p) => ({ path: p, type: 'file' }))
  if (Array.isArray(fileDomain) && fileDomain.length > 0) {
    for (const p of finalDiffPaths) {
      const covered = fileDomain.some((d) => intersectingPaths([{ path: p, type: 'file' }], [typeof d === 'string' ? { path: d, type: 'dir' } : d], { caseInsensitive }).length > 0)
      if (!covered) reasons.push({ code: 'out-of-domain-diff', message: `最终 diff 越出 tasks.fileDomain：${p}`, path: p })
    }
  }
  if (Array.isArray(intentPaths) && intentPaths.length > 0) {
    for (const p of finalDiffPaths) {
      const covered = intentPaths.some((d) => intersectingPaths([{ path: p, type: 'file' }], [typeof d === 'string' ? { path: d, type: 'dir' } : d], { caseInsensitive }).length > 0)
      if (!covered) reasons.push({ code: 'beyond-write-intent', message: `最终 diff 越出本次写入意图：${p}`, path: p })
    }
  } else if (diff.length > 0 && intentPaths !== null) {
    reasons.push({ code: 'beyond-write-intent', message: '缺少写入意图，不得入队' })
  }
  if (acceptanceEvidence === null || acceptanceEvidence === undefined || acceptanceEvidence.passed !== true) {
    reasons.push({ code: 'acceptance-evidence-missing', message: '验收证据缺失或未通过' })
  }
  if (humanApprovalRequired === true && humanApproved !== true) {
    reasons.push({ code: 'human-review-unapproved', message: '人审岗位尚未批准' })
  }
  return Object.freeze({ ok: reasons.length === 0, reasons: Object.freeze(reasons) })
}

function toDelivery(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id, taskId: row.task_id, attemptId: row.attempt_id ?? null,
    sourceCommit: row.source_commit, baseCommit: row.base_commit ?? null,
    targetRef: row.target_ref, state: row.state, validationId: row.validation_id ?? null,
    integratedCommit: row.integrated_commit ?? null, decisionId: row.decision_id ?? null,
    version: row.version, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms,
  })
}
function toJob(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id, repoId: row.repo_id, targetRef: row.target_ref, deliveryId: row.delivery_id ?? null,
    expectedHead: row.expected_head ?? null, preparedCommit: row.prepared_commit ?? null,
    journalPhase: row.journal_phase ?? null, state: row.state, leaseEpoch: row.lease_epoch,
    owner: row.owner ?? null, attempts: row.attempts, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms,
  })
}

export function createDeliveryStore(db, { now = () => Date.now(), idFactory = defaultId } = {}) {
  const deliveryRow = (id) => db.prepare('SELECT * FROM task_deliveries WHERE id = ?').get(id)
  const jobRow = (id) => db.prepare('SELECT * FROM integration_jobs WHERE id = ?').get(id)

  function appendEvent({ jobId = null, deliveryId = null, actor = null, fromState = null, toState = null, gitSha = null, errorCode = null, validationSummary = null, detail = null }) {
    db.prepare(`INSERT INTO integration_events
      (job_id, delivery_id, actor, at_ms, from_state, to_state, git_sha, error_code, validation_summary, detail_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      jobId, deliveryId, actor, now(), fromState, toState, gitSha, errorCode, validationSummary, detail === null ? null : JSON.stringify(detail))
  }

  return {
    /** 创建一条新交付（一次交付唯一；同任务重做会产生新行）。 */
    createDelivery({ taskId, attemptId = null, sourceCommit, baseCommit = null, targetRef, actor = null }) {
      if (!taskId || !sourceCommit || !targetRef) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.NOT_FOUND, reason: 'taskId/sourceCommit/targetRef 必填' })
      }
      const id = idFactory()
      const ts = now()
      db.prepare(`INSERT INTO task_deliveries
        (id, task_id, attempt_id, source_commit, base_commit, target_ref, state, version, created_at_ms, updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, taskId, attemptId, sourceCommit, baseCommit, targetRef, 'awaiting-acceptance', 1, ts, ts)
      appendEvent({ deliveryId: id, actor, fromState: null, toState: 'awaiting-acceptance' })
      return Object.freeze({ ok: true, delivery: toDelivery(deliveryRow(id)) })
    },

    getDelivery(id) { return toDelivery(deliveryRow(id)) },
    getDeliveryByTask(taskId) {
      return toDelivery(db.prepare('SELECT * FROM task_deliveries WHERE task_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1').get(taskId))
    },
    listDeliveries() { return Object.freeze(db.prepare('SELECT * FROM task_deliveries ORDER BY created_at_ms ASC').all().map(toDelivery)) },

    /** 入队门禁通过才可从 awaiting-acceptance 进入 ready。 */
    enqueueDelivery({ id, version = null, gates = {}, actor = null }) {
      const row = deliveryRow(id)
      if (!row) return Object.freeze({ ok: false, code: DELIVERY_ERRORS.NOT_FOUND })
      if (version !== null && Number(row.version) !== Number(version)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.VERSION_CONFLICT, currentVersion: row.version })
      }
      if (row.state !== 'awaiting-acceptance' && row.state !== 'needs-review') {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.INVALID_TRANSITION, reason: `${row.state} 不能进入 ready` })
      }
      const gate = checkEnqueueGates(gates)
      if (!gate.ok) {
        appendEvent({ deliveryId: id, actor, fromState: row.state, toState: row.state, errorCode: DELIVERY_ERRORS.ENQUEUE_GATE, detail: gate.reasons })
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.ENQUEUE_GATE, reasons: gate.reasons })
      }
      const ts = now()
      db.prepare('UPDATE task_deliveries SET state=?, version=?, updated_at_ms=? WHERE id=?').run('ready', Number(row.version) + 1, ts, id)
      appendEvent({ deliveryId: id, actor, fromState: row.state, toState: 'ready' })
      return Object.freeze({ ok: true, delivery: toDelivery(deliveryRow(id)) })
    },

    /** 状态迁移：version CAS + 显式状态机；终态不可再迁。 */
    transitionDelivery({ id, version = null, to, actor = null, gitSha = null, validationId = null, integratedCommit = null, detail = null }) {
      const row = deliveryRow(id)
      if (!row) return Object.freeze({ ok: false, code: DELIVERY_ERRORS.NOT_FOUND })
      if (TERMINAL_DELIVERY_STATES.includes(row.state)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.TERMINAL_STATE, currentState: row.state })
      }
      if (version !== null && Number(row.version) !== Number(version)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.VERSION_CONFLICT, currentVersion: row.version })
      }
      if (!(TRANSITIONS[row.state] ?? []).includes(to)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.INVALID_TRANSITION, from: row.state, to })
      }
      const ts = now()
      db.prepare(`UPDATE task_deliveries SET state=?, version=?, validation_id=COALESCE(?, validation_id),
        integrated_commit=COALESCE(?, integrated_commit), updated_at_ms=? WHERE id=?`).run(
        to, Number(row.version) + 1, validationId, integratedCommit, ts, id)
      appendEvent({ deliveryId: id, actor, fromState: row.state, toState: to, gitSha, validationSummary: validationId, detail })
      return Object.freeze({ ok: true, delivery: toDelivery(deliveryRow(id)) })
    },

    /** 待裁决：用户在 version CAS 下做决定（采用 A／采用 B／要求重新修改／放弃）。 */
    requestDecision({ id, version = null, decision, decider = null, reason = null }) {
      const row = deliveryRow(id)
      if (!row) return Object.freeze({ ok: false, code: DELIVERY_ERRORS.NOT_FOUND })
      if (version !== null && Number(row.version) !== Number(version)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.VERSION_CONFLICT, currentVersion: row.version })
      }
      if (!DELIVERY_DECISIONS.includes(decision)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.INVALID_TRANSITION, reason: '不认识的裁决：' + decision })
      }
      if (row.state !== 'needs-review' && row.state !== 'awaiting-acceptance') {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.INVALID_TRANSITION, from: row.state, to: decision })
      }
      const to = decision === 'abandon' ? 'abandoned' : 'ready'
      const decisionId = idFactory()
      const ts = now()
      db.prepare('UPDATE task_deliveries SET state=?, version=?, decision_id=?, updated_at_ms=? WHERE id=?').run(
        to, Number(row.version) + 1, decisionId, ts, id)
      appendEvent({
        deliveryId: id, actor: decider, fromState: row.state, toState: to, errorCode: null,
        detail: { decision, reason, decider, decisionId, atMs: ts },
      })
      return Object.freeze({ ok: true, delivery: toDelivery(deliveryRow(id)), decisionId })
    },

    /** 认领集成 job：同仓库同 target ref 至多一个活跃 job。 */
    claimIntegrationJob({ repoId, targetRef, deliveryId = null, owner = null, expectedHead = null, leaseEpoch = 1, jobId = null }) {
      const active = db.prepare(
        "SELECT * FROM integration_jobs WHERE repo_id = ? AND target_ref = ? AND state IN ('leased','applying','ref-updated') ORDER BY created_at_ms DESC LIMIT 1",
      ).get(repoId, targetRef)
      if (active) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.JOB_CONTENTION, holder: toJob(active) })
      }
      const id = jobId ?? idFactory()
      const ts = now()
      db.prepare(`INSERT INTO integration_jobs
        (id, repo_id, target_ref, delivery_id, expected_head, prepared_commit, journal_phase, state, lease_epoch, owner, attempts, created_at_ms, updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, repoId, targetRef, deliveryId, expectedHead, null, 'prepared', 'leased', leaseEpoch, owner, 0, ts, ts)
      appendEvent({ jobId: id, deliveryId, actor: owner, fromState: null, toState: 'leased', detail: { expectedHead } })
      return Object.freeze({ ok: true, job: toJob(jobRow(id)) })
    },

    getIntegrationJob(id) { return toJob(jobRow(id)) },
    listIntegrationJobs(repoId = null) {
      const rows = repoId === null
        ? db.prepare('SELECT * FROM integration_jobs ORDER BY created_at_ms ASC').all()
        : db.prepare('SELECT * FROM integration_jobs WHERE repo_id = ? ORDER BY created_at_ms ASC').all(repoId)
      return Object.freeze(rows.map(toJob))
    },

    /** job 状态/阶段推进：必须携带当前 lease epoch（fencing）。 */
    transitionIntegrationJob({ id, leaseEpoch = null, to = null, phase = null, preparedCommit = null, expectedHead = null, gitSha = null, actor = null, errorCode = null, detail = null }) {
      const row = jobRow(id)
      if (!row) return Object.freeze({ ok: false, code: DELIVERY_ERRORS.NOT_FOUND })
      if (leaseEpoch !== null && Number(row.lease_epoch) !== Number(leaseEpoch)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.EPOCH_STALE, currentEpoch: row.lease_epoch })
      }
      if (phase !== null && !INTEGRATION_JOURNAL_PHASES.includes(phase)) {
        return Object.freeze({ ok: false, code: DELIVERY_ERRORS.INVALID_TRANSITION, reason: '未知 journal 阶段：' + phase })
      }
      const ts = now()
      db.prepare(`UPDATE integration_jobs SET state=COALESCE(?, state), journal_phase=COALESCE(?, journal_phase),
        prepared_commit=COALESCE(?, prepared_commit), expected_head=COALESCE(?, expected_head), attempts=attempts+1, updated_at_ms=?
        WHERE id=?`).run(to, phase, preparedCommit, expectedHead, ts, id)
      appendEvent({ jobId: id, deliveryId: row.delivery_id, actor, fromState: row.state, toState: to ?? row.state, gitSha, errorCode, detail })
      return Object.freeze({ ok: true, job: toJob(jobRow(id)) })
    },

    /** 恢复时读取只追加事件（审计与对账）。 */
    listIntegrationEvents({ jobId = null, deliveryId = null } = {}) {
      if (jobId !== null) return Object.freeze(db.prepare('SELECT * FROM integration_events WHERE job_id = ? ORDER BY id ASC').all(jobId))
      if (deliveryId !== null) return Object.freeze(db.prepare('SELECT * FROM integration_events WHERE delivery_id = ? ORDER BY id ASC').all(deliveryId))
      return Object.freeze(db.prepare('SELECT * FROM integration_events ORDER BY id ASC').all())
    },

    appendIntegrationEvent(event) {
      appendEvent(event)
      return Object.freeze({ ok: true, count: db.prepare('SELECT COUNT(*) AS n FROM integration_events').get().n })
    },

    /**
     * 历史 done 不倒推：返回已 done 但没有 delivery 记录的任务，标 legacy-unknown。
     * **不写任何 task_deliveries 行**，避免制造假的成功证据。
     */
    listLegacyUnknownTasks() {
      return Object.freeze(db.prepare(`SELECT t.id AS task_id FROM tasks t
        WHERE t.status = 'done'
          AND NOT EXISTS (SELECT 1 FROM task_deliveries d WHERE d.task_id = t.id)
        ORDER BY t.id ASC`).all().map((r) => Object.freeze({ taskId: r.task_id, deliveryState: 'legacy-unknown' })))
    },
  }
}

let seq = 0
function defaultId() {
  seq += 1
  return 'id-' + Date.now().toString(36) + '-' + seq.toString(36)
}

/** 交付徽标映射（供 Workbench 与测试共用，避免两处各写一份）。 */
export function deliveryBadgeOf({ deliveryState = null, schedulingState = null, readOnly = false } = {}) {
  if (readOnly) return '只读探索'
  if (schedulingState === 'waiting-file') return '等待文件'
  switch (deliveryState) {
    case 'awaiting-acceptance': return '待验收'
    case 'ready': return '排队集成'
    case 'preparing': case 'validating': return '集成验证中'
    case 'needs-review': return '待裁决'
    case 'integrated': return '已交付'
    case 'legacy-unknown': return '历史（未验证集成）'
    case 'abandoned': return '已放弃'
    default: return '执行中'
  }
}

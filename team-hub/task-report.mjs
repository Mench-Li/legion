// team-hub/task-report.mjs
// ============================================================================
// F2 · 士兵报告的**唯一写口**（设计稿 §3 F2 / M3 剩余，DEC-2）
//
// DEC-2 定下：守护"只决定、不落盘"。于是「任务状态 + 待答问题 + 审计事件」
// 必须由 team-hub 在**一个事务**里一起写 —— 拆开写一定会出现半截：
// 问题写进去了、状态没变（守护以为还在跑），或者状态变了、问题没落（人永远看不到）。
//
// ★ 三条纪律
//   ① 一个任务**同时只允许一个未答问题**：先查后插，并由 DB 部分唯一索引兜底；
//      已有未答问题时再报新问题 ⇒ 409 + 既有问题 id（**不静默覆盖**：覆盖会让"我问过什么"消失）
//   ② 幂等按 `reportId`：重投只回既有结果，不再建问题、不再记审计
//   ③ 被拒的报告不留半截：校验全部发生在写之前
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

export const REPORT_STATUSES = Object.freeze(['done', 'waiting', 'blocked', 'dropped'])
export const WAIT_FOR_REASONS = Object.freeze([
  'external-review', 'upstream-merge', 'human-decision', 'ci-result', 'dependency',
])

export const REPORT_ERRORS = Object.freeze({
  UNKNOWN_STATUS: 'REPORT_UNKNOWN_STATUS',
  WAIT_FOR_REQUIRED: 'REPORT_WAIT_FOR_REQUIRED',
  WAIT_FOR_UNKNOWN: 'REPORT_WAIT_FOR_UNKNOWN',
  TASK_NOT_FOUND: 'REPORT_TASK_NOT_FOUND',
  QUESTION_ALREADY_OPEN: 'REPORT_QUESTION_ALREADY_OPEN',
  QUESTION_BODY_REQUIRED: 'REPORT_QUESTION_BODY_REQUIRED',
  REPORT_ID_REQUIRED: 'REPORT_ID_REQUIRED',
})

export class TaskReportError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`)
    this.name = 'TaskReportError'
    this.code = code
    // HTTP 层的语义：找不到 = 404，已存在问题 = 409，其余校验失败 = 400。
    this.statusCode = code === REPORT_ERRORS.TASK_NOT_FOUND ? 404
      : code === REPORT_ERRORS.QUESTION_ALREADY_OPEN ? 409
        : 400
    Object.assign(this, extra)
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** 建本层需要的列与回执表。可重复执行（并发安全由 ensureColumn 保证）。 */
export function ensureReportSchema(db) {
  ensureColumn(db, 'tasks', 'report_state', 'TEXT')
  ensureColumn(db, 'tasks', 'wait_for', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_receipts (
      report_id TEXT PRIMARY KEY,
      task_id   TEXT NOT NULL,
      question_id TEXT,
      audit_seq INTEGER,
      at        TEXT NOT NULL
    );
  `)
}

/**
 * HTTP body → `submitReport()` 入参。**字段名映射只此一处**（camel 与 snake 都收）。
 * `reportId` 必填：没有幂等键就无法回答"这条报告是不是重投"。
 */
export function reportsRouteBody(taskId, body = {}, by = 'system') {
  const reportId = text(body.reportId ?? body.report_id)
  if (!reportId) throw new TaskReportError(REPORT_ERRORS.REPORT_ID_REQUIRED, '缺少 reportId（回报幂等键）')
  return {
    taskId,
    reportId,
    status: body.status,
    waitFor: body.waitFor ?? body.wait_for,
    summary: body.summary,
    evidence: body.evidence,
    actor: by,
    question: body.question ?? undefined,
    // 守护只发一次请求就能把状态一起推进（否则"状态"和"问题"会被拆成两次写）。
    applyTransition: body.applyTransition === true,
  }
}

/**
 * 状态机迁移表**镜像**（来源：`scrum/taskctl.mjs` 的 `TRANSITIONS`）。
 * 拷一份而不是 import，是因为 taskctl 是 CLI 入口（带 main 副作用）。
 * 漂移风险由 `task-report.test.mjs` ⑫ 的"非法迁移不硬来"用例兜住：这里多放一个
 * 不该有的目标，那条用例就会红。
 */
const TRANSITIONS = Object.freeze({
  backlog: ['todo', 'blocked', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'todo', 'blocked', 'canceled'],
  in_review: ['done', 'todo', 'in_progress', 'blocked', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  done: ['in_progress', 'canceled'],
  canceled: [],
})

/**
 * 提交一条报告。
 *
 * @param db
 * @param input.taskId     任务 id（必填）
 * @param input.reportId   幂等键（必填；同值重投不产生第二次副作用）
 * @param input.status     REPORT_STATUSES 之一
 * @param input.waitFor    status='waiting' 时必填
 * @param input.question   status='blocked' 时的结构化问题 {body, options?}
 * @param input.actor      报告者（写进审计的 member）
 * @param deps.withTx      (fn) => 事务包装（缺省自带 BEGIN IMMEDIATE）
 * @param deps.audit       (member, scope, action, taskId, detail) => seq
 * @param deps.clock       () => ISO 时间
 * @returns {{ task: object, question: object|null, auditSeq: number|null, duplicated: boolean }}
 */
export function submitReport(db, input = {}, deps = {}) {
  const { withTx, audit, clock = () => new Date().toISOString(), newId = null } = deps
  const taskId = text(input.taskId)
  const reportId = text(input.reportId)
  const status = text(input.status)
  const waitFor = text(input.waitFor ?? input.wait_for)
  const questionBody = text(input.question?.body)
  const options = Array.isArray(input.question?.options) ? input.question.options : []

  // ── 校验全部在写之前：被拒的报告不能留下半截 ──
  if (!REPORT_STATUSES.includes(status)) {
    throw new TaskReportError(REPORT_ERRORS.UNKNOWN_STATUS, `未知报告状态 ${JSON.stringify(input.status)}`)
  }
  if (status === 'waiting') {
    if (!waitFor) throw new TaskReportError(REPORT_ERRORS.WAIT_FOR_REQUIRED, 'waiting 必须带 waitFor')
    if (!WAIT_FOR_REASONS.includes(waitFor)) throw new TaskReportError(REPORT_ERRORS.WAIT_FOR_UNKNOWN, `未知 waitFor ${waitFor}`)
  }
  if (input.question !== undefined && input.question !== null && status !== 'blocked') {
    throw new TaskReportError(REPORT_ERRORS.UNKNOWN_STATUS, '只有 blocked 报告可以带 question')
  }
  if (status === 'blocked' && input.question != null && !questionBody) {
    throw new TaskReportError(REPORT_ERRORS.QUESTION_BODY_REQUIRED, 'question.body 必须非空')
  }

  const work = () => {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)
    if (!task) throw new TaskReportError(REPORT_ERRORS.TASK_NOT_FOUND, `任务不存在: ${taskId}`, { taskId })

    const now = clock()
    // ② 幂等：同 reportId 只算一次
    const receipt = reportId ? db.prepare('SELECT * FROM report_receipts WHERE report_id=?').get(reportId) : null
    if (receipt) {
      const kept = receipt.question_id
        ? db.prepare('SELECT * FROM agent_questions WHERE id=?').get(receipt.question_id)
        : null
      return { task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId), question: kept ?? null, auditSeq: receipt.audit_seq, duplicated: true }
    }

    let question = null
    if (status === 'blocked' && input.question != null) {
      // ① 一个任务同时只允许一个未答问题：先查（给出可读 409），再由唯一索引兜底
      const open = db.prepare("SELECT id FROM agent_questions WHERE task_id=? AND status='open'").get(taskId)
      if (open) {
        throw new TaskReportError(REPORT_ERRORS.QUESTION_ALREADY_OPEN,
          `任务 ${taskId} 已有未答问题 ${open.id}`, { existingQuestionId: open.id })
      }
      const questionId = newId ? newId('question') : `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      // `agent_id` 要能与 `agent_registry` 对上：回答走 `send()` 时会用
      // `(scope, agent_id, task_id)` 三元组查问题，写岗位名（如 'coder'）就会查不到。
      const role = task.role ?? task.soldier ?? null
      let agentId = role ?? 'agent'
      if (role) {
        try {
          const row = db.prepare('SELECT agent_id FROM agent_registry WHERE scope=? AND role=?').get(task.scope ?? 'default', role)
          if (row?.agent_id) agentId = row.agent_id
        } catch { /* 极简夹具可能没有 agent_registry：退回岗位名 */ }
      }
      db.prepare(`INSERT INTO agent_questions
        (id, scope, agent_id, task_id, body, options_json, status, version)
        VALUES (?,?,?,?,?,?,'open',1)`)
        .run(questionId, task.scope ?? 'default', agentId, taskId, questionBody, JSON.stringify(options))
      question = db.prepare('SELECT * FROM agent_questions WHERE id=?').get(questionId)
    }

    const action = status === 'dropped' ? 'drop' : 'report'
    const detail = JSON.stringify({
      reportId, status, waitFor: waitFor || null,
      summary: text(input.summary), evidence: text(input.evidence),
      questionId: question?.id ?? null,
    })
    let auditSeq = null
    if (typeof audit === 'function') auditSeq = audit(input.actor ?? 'system', task.scope ?? 'default', action, taskId, detail) ?? null

    db.prepare('UPDATE tasks SET report_state=?, wait_for=?, version=version+1, updatedAt=? WHERE id=?')
      .run(status, status === 'waiting' ? waitFor : null, now, taskId)

    // 可选：顺手把任务状态推进（守护只发一次请求，避免"状态与问题分两次写"的缝）。
    //   blocked → blocked、dropped → canceled；done/waiting 交给守护自己的既有流程。
    let transition = null
    let transitionSkipped = null
    if (input.applyTransition === true) {
      const target = status === 'dropped' ? 'canceled' : status === 'blocked' ? 'blocked' : null
      if (target === null) {
        transitionSkipped = `no-transition-for-${status}`
      } else if (!(TRANSITIONS[task.status] ?? []).includes(target)) {
        // 非法迁移不硬来：报告照记，状态不动，并说清为什么（终态不可复活等）。
        transitionSkipped = `illegal-from-${task.status}`
      } else {
        db.prepare('UPDATE tasks SET status=?, version=version+1, updatedAt=? WHERE id=?').run(target, now, taskId)
        transition = target
      }
    }

    if (reportId) {
      db.prepare('INSERT INTO report_receipts (report_id, task_id, question_id, audit_seq, at) VALUES (?,?,?,?,?)')
        .run(reportId, taskId, question?.id ?? null, auditSeq, now)
    }

    return {
      task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),
      question, auditSeq, duplicated: false, transition, transitionSkipped,
    }
  }

  if (typeof withTx === 'function') return withTx(work)
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = work()
    db.exec('COMMIT')
    return out
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw error
  }
}

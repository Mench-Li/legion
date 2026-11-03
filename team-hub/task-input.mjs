// team-hub/task-input.mjs
// ============================================================================
// F0 · 输入行化（白皮书 §2.17 / 设计稿 §3 F0，DEC-3）
//
// 现状：评论 / 证据 / 用户反馈是 `tasks` 上的三个 **JSON 数组列**，
// 每次追加都 read-modify-write 整列。这样列既是真相又是载体，于是：
//   · 一条评论没有自己的身份 ⇒ 无法幂等、无法标记"已消费"、无法"被取代"
//   · 想按时间回放只能靠 audit，想取当前全集只能读列 —— 两份真相
//   · 同一列有多个写点（appendTaskNote、reassignTask 内联 push）
//
// 本层把它拆成两层：
//   行表 `task_input` = **唯一真相**（append-only、有身份、可消费、可取代）
//   列                = 行的**投影**（过渡期同事务同步；DEC-3 让读取点零改动）
//
// ★ 三条纪律
//   ① 行是真相，列只是投影 —— 任何时候列被改坏，对账能查出，但不自动修复
//   ② superseded 只置位不删行 —— "我说过这句话"必须可证明
//   ③ consumed_at 单调 —— 一条输入只被消费一次，晚的覆盖早的，早的不回退
// ============================================================================
import { createHash } from 'node:crypto'

export const TASK_INPUT_VERSION = 'legion/task-input@1'

/** 输入种类。`order` / `answer` 复用 comments 列（@ 语义，见设计稿 F3）。 */
export const TASK_INPUT_KINDS = Object.freeze(['comment', 'evidence', 'feedback', 'order', 'answer'])

/** 种类 → `tasks` 上的投影列。order/answer 都是"对话"，落 comments。 */
export const FIELD_BY_KIND = Object.freeze({
  comment: 'comments', order: 'comments', answer: 'comments',
  evidence: 'evidence', feedback: 'feedback',
})

export const TASK_INPUT_ERRORS = Object.freeze({
  NOT_TEXT_BODY: 'TASK_INPUT_NOT_TEXT_BODY',
  UNKNOWN_KIND: 'TASK_INPUT_UNKNOWN_KIND',
  TASK_NOT_FOUND: 'TASK_INPUT_TASK_NOT_FOUND',
  INPUT_NOT_FOUND: 'TASK_INPUT_NOT_FOUND',
  BAD_TASK_ID: 'TASK_INPUT_BAD_TASK_ID',
})

const fail = (code, message) => {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

const text = value => typeof value === 'string' && value.trim().length > 0

/** 建行表与索引。可重复执行。 */
export function ensureTaskInputSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_input (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL,
      scope        TEXT NOT NULL,
      kind         TEXT NOT NULL,
      actor        TEXT NOT NULL,
      actor_kind   TEXT NOT NULL DEFAULT 'user',
      body         TEXT NOT NULL,
      meta         TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL,
      consumed_at  TEXT,
      consumed_by  TEXT,
      superseded   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_input_task ON task_input(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_input_scope ON task_input(scope, created_at);
  `)
}

/**
 * 确定性输入 id：同一 (task, channel, at, by, body) 恒等。
 * `channel` 用于区分同一时刻同内容的多个来源（api/comment、agent-messages、reconcile…）。
 */
export function inputIdFor({ taskId, channel = 'api/comment', at = '', by = '', body = '' }) {
  const digest = createHash('sha1')
    .update(JSON.stringify([TASK_INPUT_VERSION, taskId, channel, at, by, body]))
    .digest('hex')
  return `inp-${digest.slice(0, 24)}`
}

function inTx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw error
  }
}

const parseArray = value => {
  try {
    const parsed = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/**
 * 追加一条输入。
 *
 * @param db            node:sqlite 连接
 * @param spec.taskId   任务 id（必填）
 * @param spec.kind     TASK_INPUT_KINDS 之一
 * @param spec.body     非空文本
 * @param spec.actor    发起者（成员名 / soldier-* / system）
 * @param spec.actorKind user|general|soldier|ci|system
 * @param spec.at       ISO 时间（缺省用调用方给的时间；本层不取时钟以保证可测）
 * @param spec.meta     额外结构（reply_to / mention_role / addressed…）
 * @param options.inTransaction 调用方已开事务时置 true（避免嵌套 BEGIN）
 * @returns {{ input: object, inserted: boolean }}
 */
export function appendInput(db, spec = {}, options = {}) {
  const { taskId, kind = 'comment', actor = 'system', actorKind = 'user', meta = {} } = spec
  if (typeof taskId !== 'string' || taskId.length === 0) fail(TASK_INPUT_ERRORS.BAD_TASK_ID, '缺少 taskId')
  if (!TASK_INPUT_KINDS.includes(kind)) fail(TASK_INPUT_ERRORS.UNKNOWN_KIND, `未知 kind: ${kind}`)
  if (!text(spec.body)) fail(TASK_INPUT_ERRORS.NOT_TEXT_BODY, 'body 必须是非空文本')

  const body = spec.body.trim()
  const at = spec.at ?? new Date(0).toISOString()
  const id = spec.id ?? inputIdFor({ taskId, channel: spec.channel, at, by: actor, body })

  const existing = db.prepare('SELECT * FROM task_input WHERE id=?').get(id)
  if (existing) return { input: existing, inserted: false }

  const task = db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId)
  if (!task) fail(TASK_INPUT_ERRORS.TASK_NOT_FOUND, `任务不存在: ${taskId}`)
  // scope 是团队库里的标准列；极简库（迁移工具/测试夹具）可能没有它 —— 缺列就按 default，
  // 不让"少一个可选列"变成"一条都搬不了"。
  let scope = spec.scope
  if (!scope) {
    try { scope = db.prepare('SELECT scope FROM tasks WHERE id=?').get(taskId)?.scope } catch { scope = undefined }
  }
  scope = scope ?? 'default'

  const work = () => {
    db.prepare(`INSERT INTO task_input
      (id, task_id, scope, kind, actor, actor_kind, body, meta, created_at, superseded)
      VALUES (?,?,?,?,?,?,?,?,?,0)`)
      .run(id, taskId, scope, kind, actor, actorKind, body, JSON.stringify(meta), at)
    syncField(db, taskId, FIELD_BY_KIND[kind], at)
    return { input: db.prepare('SELECT * FROM task_input WHERE id=?').get(id), inserted: true }
  }
  return options.inTransaction ? work() : inTx(db, work)
}

/** 某任务的输入列表（默认不含被取代的）。 */
export function listInputs(db, taskId, { kind, includeSuperseded = false } = {}) {
  const where = ['task_id = ?']
  const params = [taskId]
  if (kind) { where.push('kind = ?'); params.push(kind) }
  if (!includeSuperseded) where.push('COALESCE(superseded,0) = 0')
  return db.prepare(`SELECT * FROM task_input WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`).all(...params)
}

/** 列的投影（只由行算出来；不含被取代的输入）。 */
export function projectField(db, taskId, field) {
  const kinds = Object.keys(FIELD_BY_KIND).filter(kind => FIELD_BY_KIND[kind] === field)
  const rows = db.prepare(
    `SELECT actor, body, created_at FROM task_input
      WHERE task_id=? AND COALESCE(superseded,0)=0 AND kind IN (${kinds.map(() => '?').join(',')})
      ORDER BY created_at, rowid`).all(taskId, ...kinds)
  return JSON.stringify(rows.map(row => ({ by: row.actor, at: row.created_at, text: row.body })))
}

/** 把某一列重新同步成投影。返回是否发生变化。 */
export function syncField(db, taskId, field, at = null) {
  const next = projectField(db, taskId, field)
  const row = db.prepare(`SELECT ${field} AS value FROM tasks WHERE id=?`).get(taskId)
  if (!row || row.value === next) return false
  db.prepare(`UPDATE tasks SET ${field}=?, version=version+1, updatedAt=? WHERE id=?`)
    .run(next, at ?? new Date(0).toISOString(), taskId)
  return true
}

/**
 * 标记输入被消费。晚的覆盖早的，早的不回退（I-0.3）。
 * @returns 是否发生了写入
 */
export function markConsumed(db, inputId, { by = 'system', attemptId = null, at = new Date(0).toISOString() } = {}) {
  const row = db.prepare('SELECT * FROM task_input WHERE id=?').get(inputId)
  if (!row) fail(TASK_INPUT_ERRORS.INPUT_NOT_FOUND, `输入不存在: ${inputId}`)
  if (row.consumed_at && row.consumed_at >= at) return false
  db.prepare('UPDATE task_input SET consumed_at=?, consumed_by=? WHERE id=?')
    .run(at, attemptId ?? by, inputId)
  return true
}

/** 置位 superseded（不删行），并把投影列同步掉（I-0.4）。 */
export function supersedeInput(db, inputId, { at = new Date(0).toISOString() } = {}) {
  const row = db.prepare('SELECT * FROM task_input WHERE id=?').get(inputId)
  if (!row) fail(TASK_INPUT_ERRORS.INPUT_NOT_FOUND, `输入不存在: ${inputId}`)
  if (row.superseded) return false
  const work = () => {
    db.prepare('UPDATE task_input SET superseded=1 WHERE id=?').run(inputId)
    syncField(db, row.task_id, FIELD_BY_KIND[row.kind] ?? 'comments', at)
    return true
  }
  return inTx(db, work)
}

/**
 * A 段迁移：把历史 `tasks.comments / evidence / feedback` 的数组回填成输入行。
 *
 * ★ 只写行，**不改列**：迁移完成后列必须仍与投影逐字相同（对账 0 差异）。
 * ★ 幂等：id 由 (task, channel='migration', at, by, body) 决定，重跑只会报 duplicated。
 * ★ dryRun：只报「会搬多少条 / 跳过多少条」，不落库。
 *
 * @returns {{ dryRun: boolean, scanned: number, planned: number, inserted: number, duplicated: number, skipped: number }}
 */
export function migrateLegacyNotes(db, { dryRun = false, channel = 'migration' } = {}) {
  const tasks = db.prepare('SELECT id, comments, evidence, feedback FROM tasks').all()
  const columns = [['comments', 'comment'], ['evidence', 'evidence'], ['feedback', 'feedback']]
  const report = { dryRun, scanned: tasks.length, planned: 0, inserted: 0, duplicated: 0, skipped: 0 }

  const work = () => {
    for (const task of tasks) {
      for (const [field, kind] of columns) {
        for (const entry of parseArray(task[field])) {
          // 坏条目（字符串、缺 text、纯空格）不搬，但要计数——静默丢弃等于伪造历史。
          if (!entry || typeof entry !== 'object' || !text(entry.text)) { report.skipped += 1; continue }
          report.planned += 1
          if (dryRun) continue
          const at = text(entry.at) ? entry.at : ''
          const by = text(entry.by) ? entry.by : 'unknown'
          const { inserted } = appendInput(db, {
            taskId: task.id, kind, actor: by, actorKind: 'user', body: entry.text, at, channel,
          }, { inTransaction: true })
          if (inserted) report.inserted += 1
          else report.duplicated += 1
        }
      }
    }
  }

  if (dryRun) work()
  else inTx(db, work)
  return report
}

/**
 * 对账：列 vs 行表。**只读**，不修复（修复会把错误固化）。
 * @returns {{ tasks: number, mismatched: Array<{taskId: string, field: string, rows: number}> }}
 */
export function reconcileInputs(db, { scope } = {}) {
  const tasks = scope
    ? db.prepare('SELECT id, comments, evidence, feedback FROM tasks WHERE scope=?').all(scope)
    : db.prepare('SELECT id, comments, evidence, feedback FROM tasks').all()
  const mismatched = []
  for (const task of tasks) {
    for (const field of ['comments', 'evidence', 'feedback']) {
      const actual = JSON.stringify(parseArray(task[field]))
      const expected = projectField(db, task.id, field)
      if (actual !== expected) {
        mismatched.push({ taskId: task.id, field, rows: JSON.parse(expected).length })
      }
    }
  }
  return { tasks: tasks.length, mismatched }
}

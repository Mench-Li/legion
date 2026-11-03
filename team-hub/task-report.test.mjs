// team-hub/task-report.test.mjs
// ============================================================================
// F2 · `POST /api/tasks/:id/report` 的落盘面（设计稿 §3 F2 / M3 剩余）
//
// 为什么需要这个写口：DEC-2 定下「守护只决定、不落盘」，于是「状态 + 问题 + 事件」
// 必须在 **team-hub 的一个事务里**一起写。分散写就会出现"问题写了、状态没写"这种半截。
//
// 判据：
//   ① blocked + question ⇒ 一个事务里写三样：tasks.report_state / agent_questions / audit
//   ② 同一 reportId 重投 ⇒ 幂等（不重复建问题、不重复记审计）
//   ③ 已有未答问题时再报一个新问题 ⇒ 409，并给出既有问题 id（不是静默覆盖）
//   ④ waiting 缺 waitFor / 未知状态 ⇒ 拒收
//   ⑤ dropped ⇒ 不建问题、audit 动作为 drop
//   ⑥ done ⇒ audit 动作为 report，report_state=done
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureReportSchema, submitReport, REPORT_STATUSES, REPORT_ERRORS } from './task-report.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', role TEXT, soldier TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress', version INTEGER NOT NULL DEFAULT 1,
      hold INTEGER NOT NULL DEFAULT 0, updatedAt TEXT
    );
    CREATE TABLE agent_questions (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'agent-x',
      task_id TEXT NOT NULL, attempt_id TEXT, body TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]',
      status TEXT DEFAULT 'open', version INTEGER DEFAULT 1, answer TEXT, answered_by TEXT, source_message_id INTEGER
    );
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT
    );
  `)
  ensureReportSchema(db)
  db.prepare('INSERT INTO tasks (id, role, soldier, status, updatedAt) VALUES (?,?,?,?,?)')
    .run('T-1', 'coder', 'soldier-coder', 'in_progress', '2026-11-03T00:00:00.000Z')
  return db
}

const auditSink = () => {
  const rows = []
  const fn = (member, scope, action, taskId, detail) => {
    rows.push({ member, scope, action, taskId, detail })
    return rows.length
  }
  fn.rows = rows
  return fn
}
const openQuestions = (db, taskId = 'T-1') =>
  db.prepare("SELECT id, body FROM agent_questions WHERE task_id=? AND status='open'").all(taskId)
const stateOf = (db, taskId = 'T-1') =>
  db.prepare('SELECT report_state, wait_for FROM tasks WHERE id=?').get(taskId)

test('① blocked + question：三样东西一个事务里落盘', () => {
  const db = makeDb()
  const audit = auditSink()

  const out = submitReport(db, {
    taskId: 'T-1', reportId: 'r-1', status: 'blocked', summary: '卡在口径',
    evidence: '跑了两轮', question: { body: '验收口径 A 还是 B？', options: ['A', 'B'] },
    actor: 'soldier-coder',
  }, { audit })

  assert.equal(out.duplicated, false)
  assert.ok(out.question?.id, '必须建出问题行')
  assert.equal(openQuestions(db).length, 1)
  assert.deepEqual(JSON.parse(db.prepare('SELECT options_json FROM agent_questions WHERE id=?').get(out.question.id).options_json), ['A', 'B'])
  assert.equal(stateOf(db).report_state, 'blocked')
  assert.equal(audit.rows.length, 1)
  assert.equal(audit.rows[0].action, 'report')
  assert.equal(audit.rows[0].taskId, 'T-1')
})

test('② 同一 reportId 重投 ⇒ 幂等（不重复建问题、不重复记审计）', () => {
  const db = makeDb()
  const audit = auditSink()
  const input = {
    taskId: 'T-1', reportId: 'r-1', status: 'blocked', summary: '卡在口径',
    question: { body: '口径？' }, actor: 'soldier-coder',
  }
  const first = submitReport(db, input, { audit })
  const second = submitReport(db, input, { audit })

  assert.equal(second.duplicated, true)
  assert.equal(second.question?.id, first.question.id, '幂等要回同一个问题')
  assert.equal(openQuestions(db).length, 1)
  assert.equal(audit.rows.length, 1, '★ 重投不得再记一条审计')
})

test('③ 已有未答问题时再报新问题 ⇒ 409 并给出既有问题 id', () => {
  const db = makeDb()
  const audit = auditSink()
  const first = submitReport(db, {
    taskId: 'T-1', reportId: 'r-1', status: 'blocked', question: { body: '第一个问题' }, actor: 's',
  }, { audit })

  let error = null
  try {
    submitReport(db, {
      taskId: 'T-1', reportId: 'r-2', status: 'blocked', question: { body: '第二个问题' }, actor: 's',
    }, { audit })
  } catch (e) { error = e }

  assert.ok(error, '必须拒绝')
  assert.equal(error.code, REPORT_ERRORS.QUESTION_ALREADY_OPEN)
  assert.equal(error.existingQuestionId, first.question.id)
  assert.equal(openQuestions(db).length, 1, '旧问题不被覆盖')
})

test('④ waiting 缺 waitFor / 未知状态 ⇒ 拒收', () => {
  const db = makeDb()
  const audit = auditSink()
  assert.throws(() => submitReport(db, { taskId: 'T-1', reportId: 'r-1', status: 'waiting', actor: 's' }, { audit }),
    (e) => e.code === REPORT_ERRORS.WAIT_FOR_REQUIRED)
  assert.throws(() => submitReport(db, { taskId: 'T-1', reportId: 'r-2', status: 'ready', actor: 's' }, { audit }),
    (e) => e.code === REPORT_ERRORS.UNKNOWN_STATUS)
  assert.equal(audit.rows.length, 0, '被拒的报告不留下半截审计')
})

test('⑤ dropped：不建问题、audit 动作为 drop、状态落 dropped', () => {
  const db = makeDb()
  const audit = auditSink()
  const out = submitReport(db, {
    taskId: 'T-1', reportId: 'r-1', status: 'dropped',
    summary: '需求已被 T-9 覆盖', actor: 's',
  }, { audit })

  assert.equal(out.question, null)
  assert.equal(openQuestions(db).length, 0)
  assert.equal(stateOf(db).report_state, 'dropped')
  assert.equal(audit.rows[0].action, 'drop')
})

test('⑥ done：audit 动作为 report、状态落 done、不建问题', () => {
  const db = makeDb()
  const audit = auditSink()
  submitReport(db, { taskId: 'T-1', reportId: 'r-1', status: 'done', summary: '改完了', actor: 's' }, { audit })
  assert.equal(stateOf(db).report_state, 'done')
  assert.equal(audit.rows[0].action, 'report')
  assert.equal(openQuestions(db).length, 0)
})

test('⑦ 未知任务 ⇒ 404 语义（TASK_NOT_FOUND）', () => {
  const db = makeDb()
  assert.throws(() => submitReport(db, { taskId: 'T-nope', reportId: 'r-1', status: 'done', actor: 's' }, { audit: auditSink() }),
    (e) => e.code === REPORT_ERRORS.TASK_NOT_FOUND)
})

test('⑧ 契约常量固定', () => {
  assert.deepEqual([...REPORT_STATUSES], ['done', 'waiting', 'blocked', 'dropped'])
})

test('⑨ 问题的 agent_id 解析到 agent_registry（否则回答会查不到问题）', () => {
  const db = makeDb()
  db.exec(`CREATE TABLE agent_registry (agent_id TEXT PRIMARY KEY, scope TEXT NOT NULL, role TEXT NOT NULL,
    name TEXT, avatar TEXT, archived INTEGER NOT NULL DEFAULT 0, UNIQUE(scope, role))`)
  db.prepare("INSERT INTO agent_registry (agent_id, scope, role, name) VALUES ('agent-coder-7','default','coder','编码兵')").run()

  const out = submitReport(db, {
    taskId: 'T-1', reportId: 'r-9', status: 'blocked', question: { body: '口径？' }, actor: 's',
  }, { audit: auditSink() })

  assert.equal(out.question.agent_id, 'agent-coder-7', '★ 必须对得上 registry，回答链路才找得到')
})

test('⑩ applyTransition：blocked 顺手把任务状态推进（一次调用，不留两次写的缝）', () => {
  const db = makeDb()
  const out = submitReport(db, {
    taskId: 'T-1', reportId: 'r-10', status: 'blocked', question: { body: '口径？' },
    actor: 's', applyTransition: true,
  }, { audit: auditSink() })

  assert.equal(out.transition, 'blocked')
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get('T-1').status, 'blocked')
})

test('⑪ applyTransition + dropped ⇒ canceled（无需处理 = 取消，不是 done）', () => {
  const db = makeDb()
  const out = submitReport(db, {
    taskId: 'T-1', reportId: 'r-11', status: 'dropped', summary: '已被 T-9 覆盖',
    actor: 's', applyTransition: true,
  }, { audit: auditSink() })

  assert.equal(out.transition, 'canceled')
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get('T-1').status, 'canceled')
})

test('⑫ 非法迁移不硬来：报告照记，状态不动，并说明为什么没迁', () => {
  const db = makeDb()
  db.prepare("UPDATE tasks SET status='done' WHERE id='T-1'").run()
  const out = submitReport(db, {
    taskId: 'T-1', reportId: 'r-12', status: 'blocked', question: { body: '还能改吗？' },
    actor: 's', applyTransition: true,
  }, { audit: auditSink() })

  assert.equal(out.transition, null)
  assert.equal(out.transitionSkipped, 'illegal-from-done')
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get('T-1').status, 'done', '终态不动')
  assert.equal(stateOf(db).report_state, 'blocked', '报告本身仍要落盘')
})

// team-hub/claim-policy-question-gate.test.mjs
// ============================================================================
// F2 · 派工闸「有未答问题就不派工」（设计稿 §3 F2 / M3，DEC-4 归并前置）
//
// 病灶：士兵在等人拍板时只能靠 `❓` 文本 + blocked 混着表达；守护照样会
// 在下一轮把它当"可认领"再派一次，于是同一件事被反复打扰。
//
// 本族加一条**任务级资格**（与 status-todo / not-held 同一组）：
//   有 `agent_questions(open)` 的任务不进候选 SQL，也不被 `holds()` 放行。
//
// 钉住的判据：
//   ① 有未答问题 ⇒ 两条候选路径都查不到它（SQL 层，不是守护层兜）
//   ② 回答后（status='answered'）⇒ 自动可领
//   ③ SQL 与 `holds()` 纯函数镜像**同义**（说明书与做法必须一致）
//   ④ `isTaskEligible()` 给出专门的拒绝码，不混进「不在 todo」
//   ⑤ 快照里能看到这条闸（诊断面同步）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  TASK_GATES,
  buildClaimableTaskSql,
  buildQueuedCandidateSql,
  assertTaskGatesShared,
  isTaskEligible,
  claimPolicySnapshot,
  CLAIM_REJECTIONS,
} from './claim-policy.mjs'

/** 最小夹具：候选 SQL 只碰 tasks / run_attempts / agent_questions 三张表。 */
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT, acceptance TEXT DEFAULT '[]'
    );
    CREATE TABLE run_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'Queued', created_at_ms INTEGER, next_attempt_at_ms INTEGER
    );
    CREATE TABLE agent_questions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      body TEXT, version INTEGER NOT NULL DEFAULT 1
    );
  `)
  return db
}

function insertTask(db, { id = 'T-1', status = 'todo', hold = 0 } = {}) {
  db.prepare('INSERT INTO tasks (id, title, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(id, `任务 ${id}`, status, 'default', hold, '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z')
}
function ask(db, { id = 'q1', taskId = 'T-1', status = 'open' } = {}) {
  db.prepare('INSERT INTO agent_questions (id, task_id, status, body) VALUES (?,?,?,?)')
    .run(id, taskId, status, '验收口径 A 还是 B？')
}
const claimable = (db) => db.prepare(buildClaimableTaskSql().replace('{scope}', '')).all().map((r) => r.id)

test('① 有未答问题的任务不进候选（SQL 层拦）', () => {
  const db = makeDb()
  insertTask(db, { id: 'T-free' })
  insertTask(db, { id: 'T-asking' })
  ask(db, { id: 'q1', taskId: 'T-asking', status: 'open' })

  assert.deepEqual(claimable(db), ['T-free'], '★ 有 open 问题的任务不该被派工')
})

test('② 回答后自动恢复可领', () => {
  const db = makeDb()
  insertTask(db, { id: 'T-1' })
  ask(db, { id: 'q1', taskId: 'T-1', status: 'open' })
  assert.deepEqual(claimable(db), [], '先确认它在等人')

  db.prepare("UPDATE agent_questions SET status='answered' WHERE id='q1'").run()
  assert.deepEqual(claimable(db), ['T-1'], '★ 答完就该能继续派工')
})

test('③ SQL 与 holds() 镜像同义（同样的三行给出同样的判定）', () => {
  const gate = TASK_GATES.find((g) => g.id === 'no-open-question')
  assert.ok(gate, '闸必须存在')

  const db = makeDb()
  insertTask(db, { id: 'T-a' })
  insertTask(db, { id: 'T-b' })
  ask(db, { id: 'q', taskId: 'T-b', status: 'open' })
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM agent_questions q WHERE q.task_id=t.id AND q.status='open') AS openQuestionCount
    FROM tasks t ORDER BY t.id`).all()

  const sqlOk = claimable(db)
  const fnOk = rows.filter((r) => gate.holds(r)).map((r) => r.id)
  assert.deepEqual(fnOk, sqlOk, '★ 纯函数镜像与 SQL 必须一致，否则诊断会说反话')
})

test('④ 两条候选路径都带这条闸（防有人绕过生成器手写 SQL）', () => {
  const a = buildClaimableTaskSql()
  const b = buildQueuedCandidateSql()
  const gate = TASK_GATES.find((g) => g.id === 'no-open-question')
  assert.ok(a.includes(gate.sql), '可入队任务路径缺闸')
  assert.ok(b.includes(gate.sql), '排队尝试路径缺闸')
  assert.equal(assertTaskGatesShared(a, b).ok, true)
})

test('⑤ isTaskEligible 给出专门的拒绝码（不混进「不在 todo」）', () => {
  const verdict = isTaskEligible({
    id: 'T-1', status: 'todo', hold: 0, scope: 'default', openQuestionCount: 1,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, CLAIM_REJECTIONS.TASK_HAS_OPEN_QUESTION)
  assert.equal(verdict.gate, 'no-open-question')
  assert.match(String(verdict.userText), /问题|拍板|回答/)

  const free = isTaskEligible({ id: 'T-2', status: 'todo', hold: 0, scope: 'default', openQuestionCount: 0 })
  assert.equal(free.ok, true)
})

test('⑥ 策略快照能看到这条闸（诊断面同步）', () => {
  const snap = claimPolicySnapshot()
  assert.ok(snap.taskGates.some((g) => g.id === 'no-open-question'))
  assert.equal(snap.rejections.TASK_HAS_OPEN_QUESTION, CLAIM_REJECTIONS.TASK_HAS_OPEN_QUESTION)
})

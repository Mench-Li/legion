// team-hub/task-resume.test.mjs
// ============================================================================
// F2 · 回答之后把任务**放回可派工**（设计稿 §3 F2「回答 → 回 todo」）
//
// 病灶：`answer_question` 只是把问题标成 answered；任务还停在 `blocked`，
// 于是 F2 的闸（status='todo'）继续拦着它——人答了，活还是不跑。
//
// 判据：
//   ① blocked 且已无未答问题 ⇒ 回 todo，version+1，留审计
//   ② 还有未答问题 ⇒ **不动**（防"答一个就放行"的半开）
//   ③ 不在 blocked ⇒ 不动（不越权改别人的状态）
//   ④ done / canceled ⇒ 不动（终态不可复活）
//   ⑤ 未知任务 ⇒ 抛 TASK_NOT_FOUND
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { resumeAfterAnswer, TASK_RESUME_ERRORS } from './task-resume.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL DEFAULT 'todo',
      version INTEGER NOT NULL DEFAULT 1, held INTEGER DEFAULT 0, updatedAt TEXT
    );
    CREATE TABLE agent_questions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
    );
  `)
  return db
}
const insert = (db, id, status) =>
  db.prepare('INSERT INTO tasks (id, status, updatedAt) VALUES (?,?,?)').run(id, status, '2026-11-03T00:00:00.000Z')
const state = (db) => db.prepare('SELECT status, version FROM tasks WHERE id=?').get('T-1')

test('① blocked 且已无未答问题 ⇒ 回 todo + version+1 + 审计', () => {
  const db = makeDb()
  insert(db, 'T-1', 'blocked')
  const audits = []

  const out = resumeAfterAnswer(db, {
    taskId: 'T-1', actor: 'general', at: '2026-11-03T01:00:00.000Z',
    audit: (...args) => audits.push(args),
  })

  assert.equal(out.resumed, true)
  assert.equal(out.from, 'blocked')
  assert.equal(out.to, 'todo')
  assert.equal(state(db).status, 'todo')
  assert.equal(state(db).version, 2, '★ 必须走乐观锁的版本递增，不是裸改')
  assert.equal(audits.length, 1)
  assert.equal(audits[0][2], 'answer_resume')
})

test('② 还有未答问题 ⇒ 不动（答一个不能放行全部）', () => {
  const db = makeDb()
  insert(db, 'T-1', 'blocked')
  db.prepare("INSERT INTO agent_questions (id, task_id, status) VALUES ('q1','T-1','open')").run()

  const out = resumeAfterAnswer(db, { taskId: 'T-1', actor: 'general', at: '2026-11-03T01:00:00.000Z' })
  assert.equal(out.resumed, false)
  assert.equal(out.reason, 'open-question')
  assert.equal(state(db).status, 'blocked')
})

test('③ 不在 blocked ⇒ 不动（不越权改别人的状态）', () => {
  const db = makeDb()
  insert(db, 'T-1', 'in_progress')
  const out = resumeAfterAnswer(db, { taskId: 'T-1', actor: 'general', at: '2026-11-03T01:00:00.000Z' })
  assert.equal(out.resumed, false)
  assert.equal(out.reason, 'not-blocked')
  assert.equal(state(db).status, 'in_progress')
})

test('④ 终态不可复活', () => {
  const db = makeDb()
  insert(db, 'T-1', 'canceled')
  const out = resumeAfterAnswer(db, { taskId: 'T-1', actor: 'general', at: '2026-11-03T01:00:00.000Z' })
  assert.equal(out.resumed, false)
  assert.equal(out.reason, 'terminal')
  assert.equal(state(db).status, 'canceled')
})

test('⑤ 未知任务 ⇒ 抛 TASK_NOT_FOUND', () => {
  const db = makeDb()
  assert.throws(
    () => resumeAfterAnswer(db, { taskId: 'T-nope', actor: 'general', at: '2026-11-03T01:00:00.000Z' }),
    (e) => e.code === TASK_RESUME_ERRORS.TASK_NOT_FOUND,
  )
})

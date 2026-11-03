// team-hub/blocking.test.mjs
// ============================================================================
// F8 · 并发可解释（设计稿 §8.3 / M10，D3）
//
// 目标：任一排队任务，一眼看出「我被什么挡住」。
// 这个接口最容易做坏的方式是"返回一段自由文本"——那样每个消费方都要自己解析，
// 于是"被什么挡住"又变成猜。所以 reason 是**枚举**，且与 gate 一一对应（I-8.1）。
//
// 判据：
//   ① 没被挡：blocked=false、reason=null
//   ② hold（将军拦下）⇒ reason='hold'
//   ③ 有未答问题 ⇒ reason='question'（对应 F2 的 no-open-question gate）
//   ④ 依赖未完成 ⇒ reason='dependency'，blocker 指到那条依赖
//   ⑤ 文件域被占 ⇒ reason='fileDomain'，blocker 指到持有者
//   ⑥ 没有空闲槽 ⇒ reason='slot'
//   ⑦ waitedSec 从 since 算得出来
//   ⑧ 只读（I-8.2）：跑完任务行一字未变
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { BLOCKING_REASONS, explainBlocking } from './blocking.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL DEFAULT 'todo',
      hold INTEGER NOT NULL DEFAULT 0, blockedBy TEXT DEFAULT '[]', soldier TEXT,
      claimedAt TEXT, updatedAt TEXT, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_questions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', body TEXT
    );
  `)
  return db
}
const insertTask = (db, id, over = {}) => {
  const row = { status: 'todo', hold: 0, blockedBy: '[]', updatedAt: '2026-11-03T00:00:00.000Z', ...over }
  db.prepare('INSERT INTO tasks (id, status, hold, blockedBy, soldier, claimedAt, updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(id, row.status, row.hold, row.blockedBy, row.soldier ?? null, row.claimedAt ?? null, row.updatedAt)
}

test('① 枚举固定（I-8.1：不允许自由文本）', () => {
  assert.deepEqual([...BLOCKING_REASONS].sort(),
    ['dependency', 'fileDomain', 'hold', 'lease', 'question', 'slot'])
})

test('② 没被挡：blocked=false、reason=null', () => {
  const db = makeDb()
  insertTask(db, 'T-1')
  const out = explainBlocking(db, { taskId: 'T-1' })
  assert.equal(out.blocked, false)
  assert.equal(out.reason, null)
})

test('③ hold ⇒ reason=hold', () => {
  const db = makeDb()
  insertTask(db, 'T-1', { hold: 1 })
  const out = explainBlocking(db, { taskId: 'T-1' })
  assert.equal(out.blocked, true)
  assert.equal(out.reason, 'hold')
})

test('④ 有未答问题 ⇒ reason=question，blocker 指到那条问题', () => {
  const db = makeDb()
  insertTask(db, 'T-1')
  db.prepare("INSERT INTO agent_questions (id, task_id, status, body) VALUES ('q1','T-1','open','口径？')").run()
  const out = explainBlocking(db, { taskId: 'T-1' })
  assert.equal(out.reason, 'question')
  assert.equal(out.blocker.questionId, 'q1')
})

test('⑤ 依赖未完成 ⇒ reason=dependency，blocker 指到依赖任务', () => {
  const db = makeDb()
  insertTask(db, 'T-up', { status: 'in_progress' })
  insertTask(db, 'T-1', { blockedBy: JSON.stringify(['T-up']) })
  const out = explainBlocking(db, { taskId: 'T-1' })
  assert.equal(out.reason, 'dependency')
  assert.equal(out.blocker.taskId, 'T-up')
  assert.equal(out.blocker.status, 'in_progress')
})

test('⑥ 文件域被占 ⇒ reason=fileDomain，blocker 指到持有者', () => {
  const db = makeDb()
  insertTask(db, 'T-1')
  const out = explainBlocking(db, {
    taskId: 'T-1',
    reservations: [{ taskId: 'T-118', holder: 'soldier-coder', paths: ['team-hub/x.mjs'], expiresAt: '2026-11-03T02:00:00.000Z' }],
  })
  assert.equal(out.reason, 'fileDomain')
  assert.equal(out.blocker.taskId, 'T-118')
  assert.equal(out.blocker.holder, 'soldier-coder')
  assert.equal(out.blocker.expiresAt, '2026-11-03T02:00:00.000Z')
})

test('⑦ 没有空闲槽 ⇒ reason=slot（保留槽不算空闲）', () => {
  const db = makeDb()
  insertTask(db, 'T-1')
  const out = explainBlocking(db, { taskId: 'T-1', totalSlots: 2, activeSlots: 2, reservedSlots: 1 })
  assert.equal(out.reason, 'slot')
})

test('⑧ waitedSec 从 since 算得出来；只读（I-8.2）', () => {
  const db = makeDb()
  insertTask(db, 'T-1', { hold: 1, updatedAt: '2026-11-03T00:00:00.000Z' })
  const before = db.prepare('SELECT * FROM tasks WHERE id=?').get('T-1')

  const out = explainBlocking(db, { taskId: 'T-1', now: '2026-11-03T00:14:02.000Z' })
  assert.equal(out.since, '2026-11-03T00:00:00.000Z')
  assert.equal(out.waitedSec, 842, '★ 挡了多久要能答')

  const after = db.prepare('SELECT * FROM tasks WHERE id=?').get('T-1')
  assert.deepEqual(after, before, '★ 只读接口不得改状态')
})

test('⑨ 未知任务 ⇒ 明确报出来，而不是返回"没被挡"', () => {
  const db = makeDb()
  const out = explainBlocking(db, { taskId: 'T-nope' })
  assert.equal(out.blocked, null, '★ null = 不知道，false = 没被挡')
  assert.equal(out.error, 'TASK_NOT_FOUND')
})

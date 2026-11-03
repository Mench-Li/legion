// team-hub/task-input.test.mjs
// ============================================================================
// F0（白皮书 §2.17 / 设计稿 §3 F0）：**输入行化**的判据。
//
// 这一层只做一件事：把"评论/证据/反馈"从 `tasks.<列>` 的 JSON 数组，
// 变成有独立身份、可幂等、可消费、可取代的 append-only 行；
// 列在过渡期**同事务同步**（DEC-3），读取点零改动。
//
// 四条主线（每条都对应一条不变量）：
//   I-0.1 同输入重复提交只产生一行（id 幂等）
//   I-0.2 列由行同步产生（列 = 行的投影），不允许两套真相
//   I-0.3 consumed_at 单调递增，只由执行器写
//   I-0.4 superseded 只由显式动作置位，行不删
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  TASK_INPUT_ERRORS, TASK_INPUT_KINDS, TASK_INPUT_VERSION,
  appendInput, ensureTaskInputSchema, inputIdFor, listInputs,
  markConsumed, projectField, reconcileInputs, supersedeInput,
} from './task-input.mjs'

function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      scope TEXT DEFAULT 'default',
      comments TEXT DEFAULT '[]',
      evidence TEXT DEFAULT '[]',
      feedback TEXT DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      updatedAt TEXT
    )
  `)
  ensureTaskInputSchema(db)
  db.prepare('INSERT INTO tasks (id, scope, updatedAt) VALUES (?,?,?)').run('T-1', 'default', '2026-11-03T00:00:00.000Z')
  db.prepare('INSERT INTO tasks (id, scope, updatedAt) VALUES (?,?,?)').run('T-2', 'other', '2026-11-03T00:00:00.000Z')
  return db
}

const input = (over = {}) => ({
  taskId: 'T-1', scope: 'default', kind: 'comment',
  actor: 'general', actorKind: 'general', body: '改成滑动窗口', at: '2026-11-03T01:00:00.000Z',
  ...over,
})

function rowsOf(db, taskId = 'T-1') {
  return db.prepare('SELECT * FROM task_input WHERE task_id=? ORDER BY created_at, rowid').all(taskId)
}

test('契约：kind 白名单与版本号固定', () => {
  assert.deepEqual([...TASK_INPUT_KINDS].sort(), ['answer', 'comment', 'evidence', 'feedback', 'order'])
  assert.equal(TASK_INPUT_VERSION, 'legion/task-input@1')
  assert.equal(typeof TASK_INPUT_ERRORS.NOT_TEXT_BODY, 'string')
})

test('I-0.1 同一输入重复提交只产生一行（幂等）', () => {
  const db = freshDb()
  const first = appendInput(db, input())
  const second = appendInput(db, input())

  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(second.input.id, first.input.id, '幂等要返回同一条，而不是报错')
  assert.equal(rowsOf(db).length, 1)
})

test('I-0.2 列 = 行投影：同事务同步，且保持原有形状', () => {
  const db = freshDb()
  appendInput(db, input())
  appendInput(db, input({ body: '再加一条', at: '2026-11-03T02:00:00.000Z' }))

  const projected = JSON.parse(projectField(db, 'T-1', 'comments'))
  assert.equal(projected.length, 2)
  assert.deepEqual(Object.keys(projected[0]).sort(), ['at', 'by', 'text'], '列里的元素保持 {by,at,text}')
  assert.equal(projected[1].text, '再加一条')

  const stored = JSON.parse(db.prepare('SELECT comments FROM tasks WHERE id=?').get('T-1').comments)
  assert.deepEqual(stored, projected, '列必须与投影逐字一致')
})

test('不同 kind 落入不同列（comment/order/answer → comments，evidence/feedback 各自一列）', () => {
  const db = freshDb()
  appendInput(db, input({ kind: 'evidence', body: 'build 通过' }))
  appendInput(db, input({ kind: 'feedback', body: '体验不错' }))
  appendInput(db, input({ kind: 'order', body: '追加：滑动窗口' }))

  const t = db.prepare('SELECT comments, evidence, feedback FROM tasks WHERE id=?').get('T-1')
  assert.equal(JSON.parse(t.evidence).length, 1)
  assert.equal(JSON.parse(t.feedback).length, 1)
  assert.equal(JSON.parse(t.comments).length, 1)
  assert.equal(JSON.parse(t.comments)[0].text, '追加：滑动窗口')
})

test('I-0.3 consumed_at 只写一次且单调（早于已记录时间的写被忽略）', () => {
  const db = freshDb()
  const { input: row } = appendInput(db, input())

  markConsumed(db, row.id, { by: 'soldier-coder', attemptId: 'att-2', at: '2026-11-03T05:00:00.000Z' })
  markConsumed(db, row.id, { by: 'soldier-coder', attemptId: 'att-1', at: '2026-11-03T04:00:00.000Z' })

  const after = rowsOf(db)[0]
  assert.equal(after.consumed_at, '2026-11-03T05:00:00.000Z', '晚的时间保留，早的不得回退')
  assert.equal(after.consumed_by, 'att-2')
})

test('I-0.4 superseded 只置位不删行，默认列表不含', () => {
  const db = freshDb()
  const { input: first } = appendInput(db, input({ body: '问：A 还是 B？' }))
  const { input: second } = appendInput(db, input({ body: '问：C 还是 D？', at: '2026-11-03T03:00:00.000Z' }))

  supersedeInput(db, first.id, { at: '2026-11-03T03:30:00.000Z' })

  assert.equal(rowsOf(db).length, 2, '行不删')
  assert.equal(rowsOf(db).find(r => r.id === first.id).superseded, 1)

  const visible = listInputs(db, 'T-1')
  assert.deepEqual(visible.map(r => r.id), [second.id], '默认不含被取代的')
  assert.equal(listInputs(db, 'T-1', { includeSuperseded: true }).length, 2)
})

test('空/非文本 body 被拒（不给"空评论"开门）', () => {
  const db = freshDb()
  for (const body of ['', '   ', null, 42]) {
    assert.throws(() => appendInput(db, input({ body })), /TEXT_BODY|text/i, `body=${JSON.stringify(body)}`)
  }
  assert.equal(rowsOf(db).length, 0)
})

test('对账：列被外部改坏时能被检出（不自动修复）', () => {
  const db = freshDb()
  appendInput(db, input())
  db.prepare('UPDATE tasks SET comments=? WHERE id=?').run('[]', 'T-1')

  const report = reconcileInputs(db)
  assert.equal(report.mismatched.length, 1)
  assert.equal(report.mismatched[0].taskId, 'T-1')
  assert.equal(db.prepare('SELECT comments FROM tasks WHERE id=?').get('T-1').comments, '[]',
    '对账只读，不得自动修复')
})

test('id 确定性：同 (task, channel, at, by, body) 得同 id；任一变化得新 id', () => {
  const base = { taskId: 'T-1', channel: 'api/comment', at: '2026-11-03T01:00:00.000Z', by: 'general', body: 'x' }
  assert.equal(inputIdFor(base), inputIdFor({ ...base }))
  assert.notEqual(inputIdFor(base), inputIdFor({ ...base, body: 'y' }))
  assert.notEqual(inputIdFor(base), inputIdFor({ ...base, at: '2026-11-03T01:00:01.000Z' }))
})

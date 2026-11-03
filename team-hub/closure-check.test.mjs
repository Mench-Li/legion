// team-hub/closure-check.test.mjs
// ============================================================================
// I-9.3 · 「P0 失败必须有 active 回归用例才算闭环」（设计稿 §8.4 不变量）
//
// 这条口径的意义：回归集不是"攒着好看"的，它要对**已经踩过的坑**有覆盖。
// 所以周报必须能答出："这周有几条 P0 失败还没有对应用例？"
//
// 判据：
//   ① 没有 P0 ⇒ 闭环（不制造假问题）
//   ② 有 P0 且无任何 active 用例覆盖 ⇒ 不闭环，指出是哪几条任务
//   ③ P0 任务有 active 用例（source_task 命中）⇒ 闭环
//   ④ draft 不算覆盖（只有人晋升过的才算，呼应 I-9.1）
//   ⑤ 时间窗生效
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureDecisionSchema, recordDecision } from './decisions.mjs'
import { ensureEventSchema } from './event-log.mjs'
import { ensureRegressionSchema, saveDraft, draftCaseFor, promoteCase } from './regression-store.mjs'
import { weeklyReport } from './weekly-report.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'default', status TEXT DEFAULT 'todo',
      version INTEGER DEFAULT 1, updatedAt TEXT, mandate JSON);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT);
  `)
  ensureDecisionSchema(db)
  ensureEventSchema(db)
  ensureRegressionSchema(db)
  return db
}
const p0 = (db, taskId, kind = 'stop') => recordDecision(db, {
  subject: `task:${taskId}`, kind, by: 'general', at: '2026-11-03T00:00:00.000Z',
  matchedRuleIds: [], reason: 'MISSING_BASIS',
})
const caseFor = (db, taskId, state = 'active') => {
  const draft = saveDraft(db, draftCaseFor({ clusterKey: `coder:R-2:`, count: 1, samples: [taskId], reason: 'x' }, { at: '2026-11-03T01:00:00.000Z' }))
  if (state === 'active') promoteCase(db, { id: draft.id, by: 'general' })
  return draft
}

test('① 没有 P0 ⇒ 闭环', () => {
  const db = makeDb()
  const report = weeklyReport(db, { since: null })
  assert.equal(report.support.closure.p0Total, 0)
  assert.equal(report.support.closure.ok, true)
})

test('② 有 P0 且无覆盖 ⇒ 不闭环，并指出任务', () => {
  const db = makeDb()
  p0(db, 'T-1')
  p0(db, 'T-2', 'unavailable')
  const closure = weeklyReport(db, { since: null }).support.closure
  assert.equal(closure.p0Total, 2)
  assert.equal(closure.ok, false)
  assert.deepEqual([...closure.uncoveredTasks].sort(), ['T-1', 'T-2'])
})

test('③ P0 任务有 active 用例 ⇒ 闭环', () => {
  const db = makeDb()
  p0(db, 'T-1')
  caseFor(db, 'T-1')
  const closure = weeklyReport(db, { since: null }).support.closure
  assert.equal(closure.p0Total, 1)
  assert.equal(closure.ok, true)
  assert.deepEqual(closure.uncoveredTasks, [])
})

test('④ draft 不算覆盖（只有人晋升过的才算）', () => {
  const db = makeDb()
  p0(db, 'T-1')
  caseFor(db, 'T-1', 'draft')
  const closure = weeklyReport(db, { since: null }).support.closure
  assert.equal(closure.ok, false, '★ 草稿还没被确认，不能算作覆盖')
})

test('⑤ 时间窗生效', () => {
  const db = makeDb()
  recordDecision(db, {
    subject: 'task:T-old', kind: 'stop', by: 'general', at: '2026-10-01T00:00:00.000Z',
    matchedRuleIds: [], reason: 'MISSING_BASIS',
  })
  assert.equal(weeklyReport(db, { since: '2026-11-01T00:00:00.000Z' }).support.closure.p0Total, 0)
  assert.equal(weeklyReport(db, { since: null }).support.closure.p0Total, 1)
})

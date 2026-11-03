// team-hub/weekly-report.test.mjs
// ============================================================================
// F5 · 周报六个数（设计稿 §3 F5 观测 / M6-4）
//
// 一张周报的价值不在"数很多"，而在**每一格都答得出为什么**：
//   受理了几个 / 拦了几个 / 本来能做但没排上的有几个 /
//   依赖不可用的几个 / 有多少任务根本没有授权记录 / 事件积压多深
//
// 判据：
//   ① 六个数都在，且口径与 decisions 表一致
//   ② 时间窗生效（since 之前的决策不算）
//   ③ mandate_missing_ratio = 无授权在途任务 / 在途任务（没有在途任务时算 0）
//   ④ 事件积压 = 事件总数 − 最大游标
//   ⑤ 只读：跑完周报不动任何业务状态
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureDecisionSchema, recordDecision } from './decisions.mjs'
import { ensureEventSchema, stampEvent } from './event-log.mjs'
import { weeklyReport, WEEKLY_METRICS } from './weekly-report.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL DEFAULT 'todo',
      version INTEGER NOT NULL DEFAULT 1, updatedAt TEXT, mandate JSON
    );
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT
    );
  `)
  ensureDecisionSchema(db)
  ensureEventSchema(db)
  return db
}

test('① 六个数都在，口径与 decisions 一致', () => {
  const db = makeDb()
  recordDecision(db, { subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: ['R-2'] })
  recordDecision(db, { subject: 'task:T-2', kind: 'stop', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: [], reason: '无依据' })
  recordDecision(db, { subject: 'task:T-3', kind: 'ignore', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: [], wouldAccept: true, reason: '容量满' })

  const report = weeklyReport(db, { since: '2026-11-01T00:00:00.000Z' })
  assert.deepEqual([...WEEKLY_METRICS].sort(), Object.keys(report.metrics).sort(), '★ 六个数一个不多一个不少')
  assert.equal(report.metrics.accepted, 1)
  assert.equal(report.metrics.stopped, 1)
  assert.equal(report.metrics.ignored, 1)
  assert.equal(report.metrics.unavailable, 0)
  assert.equal(report.metrics.wouldAccept, 1)
})

test('② 时间窗生效：since 之前的决策不算', () => {
  const db = makeDb()
  recordDecision(db, { subject: 'task:old', kind: 'accept', by: 'general', at: '2026-10-01T00:00:00.000Z', matchedRuleIds: ['R-2'] })
  recordDecision(db, { subject: 'task:new', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: ['R-2'] })

  assert.equal(weeklyReport(db, { since: '2026-11-01T00:00:00.000Z' }).metrics.accepted, 1)
  assert.equal(weeklyReport(db, { since: null }).metrics.accepted, 2)
})

test('③ mandate_missing_ratio：无授权在途任务 / 在途任务', () => {
  const db = makeDb()
  db.prepare("INSERT INTO tasks (id, status, updatedAt) VALUES ('A','todo','2026-11-03T00:00:00.000Z')").run()
  db.prepare("INSERT INTO tasks (id, status, updatedAt) VALUES ('B','in_progress','2026-11-03T00:00:00.000Z')").run()
  db.prepare("INSERT INTO tasks (id, status, mandate, updatedAt) VALUES ('C','in_review',?, '2026-11-03T00:00:00.000Z')").run(JSON.stringify({ version: 1 }))
  db.prepare("INSERT INTO tasks (id, status, updatedAt) VALUES ('D','done','2026-11-03T00:00:00.000Z')").run()

  const report = weeklyReport(db, { since: null })
  assert.equal(report.support.inFlightTasks, 3, 'todo / in_progress / in_review 都算在途')
  assert.equal(report.support.mandateMissing, 2)
  assert.equal(report.metrics.mandateMissingRatio, Number((2 / 3).toFixed(4)))
})

test('④ 事件积压 = 事件总数 − 最大游标', () => {
  const db = makeDb()
  for (const version of [1, 2, 3]) {
    const seq = db.prepare("INSERT INTO audit (ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?)")
      .run('2026-11-03T00:00:00.000Z', 'general', 'default', 'transition', 'T-1', JSON.stringify({ to: 'blocked' })).lastInsertRowid
    stampEvent(db, { seq: Number(seq), kind: 'task_status', subject: `task:T-${version}`, version })
  }
  db.prepare("INSERT INTO event_cursor (consumer, seq, updated_at) VALUES ('report', 1, '2026-11-03T00:00:00.000Z')").run()

  const report = weeklyReport(db, { since: null })
  assert.equal(report.support.events, 3)
  assert.equal(report.support.eventBacklog, 2, '★ 读得比写得慢多少，要能看见')
})

test('⑤ 只读：跑完周报不改任何状态', () => {
  const db = makeDb()
  db.prepare("INSERT INTO tasks (id, status, updatedAt) VALUES ('A','todo','2026-11-03T00:00:00.000Z')").run()
  const before = db.prepare('SELECT * FROM tasks').all()
  weeklyReport(db, { since: null })
  assert.deepEqual(db.prepare('SELECT * FROM tasks').all(), before)
})

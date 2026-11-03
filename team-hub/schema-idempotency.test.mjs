// team-hub/schema-idempotency.test.mjs
// ============================================================================
// 全局约束 · 「启动期迁移必须幂等」（设计稿 §0 第 2 条 / 白皮书全局约束）
//
// 为什么值得单独一组判据：server 启动会**把所有** ensure*Schema 跑一遍，
// 而两个进程可能同时启动（8787 独立进程 + 宿主外壳）。一个不幂等的迁移
// 在单测里看不出问题，在真实部署里表现为"其中一个进程启动即崩"。
//
// 判据：
//   ① 每个 ensure* 函数在**同一个库上跑两次**都不抛
//   ② 第二次不改变列集合（确属幂等，而不是"恰好没报错"）
//   ③ 建出来的列确实存在（不是空跑成功）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureTaskInputSchema } from './task-input.mjs'
import { ensureReportSchema } from './task-report.mjs'
import { ensureDecisionSchema } from './decisions.mjs'
import { ensureEventSchema } from './event-log.mjs'
import { ensureAcceptanceSchema } from './acceptance.mjs'
import { ensureRegressionSchema } from './regression-store.mjs'
import { ensureBorrowSchema } from './goal-share.mjs'
import { ensurePreemptionSchema } from './preemption.mjs'
import { ensureShadowSchema } from './shadow-report.mjs'
import { ensureBaselineSchema } from './regression-gate.mjs'
import { ensureOpenQuestionIndex } from './scripts/merge-open-questions.mjs'

/** 一个"够用"的基础库：所有 ensure* 都要求 tasks / audit / agent_questions 先存在。 */
function baseDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'todo', version INTEGER NOT NULL DEFAULT 1, updatedAt TEXT);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT);
    CREATE TABLE agent_questions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
  `)
  return db
}
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort()

const MIGRATIONS = [
  ['task-input', ensureTaskInputSchema, 'tasks'],
  ['task-report', ensureReportSchema, 'tasks'],
  ['acceptance', ensureAcceptanceSchema, 'tasks'],
  ['event-log', ensureEventSchema, 'audit'],
  ['decisions', ensureDecisionSchema, 'decisions'],
  ['regression-store', ensureRegressionSchema, 'regression_cases'],
  ['goal-share/borrow', ensureBorrowSchema, 'goal_borrows'],
  ['preemption', ensurePreemptionSchema, 'preemptions'],
  ['shadow-report', ensureShadowSchema, 'decision_history', 'view'],
  ['regression-gate', ensureBaselineSchema, 'metric_baseline'],
]

for (const [name, migrate, table, kind] of MIGRATIONS) {
  test(`${name}.ensure* 幂等：跑两次不抛、结构不变、确实建了东西`, () => {
    const db = baseDb()
    assert.doesNotThrow(() => migrate(db), '第一次就该成功')

    // 视图没有 table_info，用 sqlite_master 判存在；表则额外比列集合
    const exists = () => db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)
    assert.ok(exists(), `${table} 应当被建出来`)
    const first = kind === 'view' ? [] : columnsOf(db, table)
    if (kind !== 'view') assert.ok(first.length > 0, `${table} 应当有列`)

    assert.doesNotThrow(() => migrate(db), '★ 第二次不得抛（启动会跑两遍）')
    if (kind !== 'view') assert.deepEqual(columnsOf(db, table), first, '★ 幂等：列集合不得变化')
    assert.ok(exists(), '结构应当仍在')
  })
}

test('open-question 唯一索引幂等（M3-0 的收尾动作）', () => {
  const db = baseDb()
  assert.doesNotThrow(() => ensureOpenQuestionIndex(db))
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_question_open'").get()
  assert.ok(before, '索引要建出来')
  assert.doesNotThrow(() => ensureOpenQuestionIndex(db), '★ 再跑一次不得抛')
})

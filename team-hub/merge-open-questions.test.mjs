// team-hub/merge-open-questions.test.mjs
// ============================================================================
// F2 · M3-0：**同任务多开问题**的归并与唯一索引（设计稿 §3 F2 / DEC-4）
//
// 为什么要先归并：`agent_questions` 要加一条部分唯一索引 `(task_id) WHERE status='open'`，
// 保证「一个任务同时只有一个未答问题」。历史数据里若已有双开，索引直接建不起来，
// 迁移就卡在第一步。所以顺序是：**查重 → 归并（保留最新、其余 superseded + 审计）→ 建索引**。
//
// 判据：
//   ① 无重复 ⇒ merged 0，索引可建；
//   ② 有重复 ⇒ dry-run 只报数；真跑保留**最新**、其余 `superseded`，并留审计；
//   ③ 幂等：再跑一次 merged 0；
//   ④ 索引真的挡住第二次 open（不是靠提示词）；
//   ⑤ 已回答的问题不动。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { mergeOpenQuestions, ensureOpenQuestionIndex } from './scripts/merge-open-questions.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE agent_questions (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'a',
      task_id TEXT NOT NULL, attempt_id TEXT, body TEXT NOT NULL, options_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'open', version INTEGER DEFAULT 1, answer TEXT, answered_by TEXT, source_message_id INTEGER
    );
  `)
  return db
}
const ask = (db, id, taskId, status = 'open') =>
  db.prepare('INSERT INTO agent_questions (id, task_id, body, status) VALUES (?,?,?,?)').run(id, taskId, `问题 ${id}`, status)
const openOf = (db, taskId) =>
  db.prepare("SELECT id FROM agent_questions WHERE task_id=? AND status='open' ORDER BY rowid").all(taskId).map((r) => r.id)

test('① 无重复：merged 0，索引可建', () => {
  const db = makeDb()
  ask(db, 'q1', 'T-1')
  ask(db, 'q2', 'T-2')

  const report = mergeOpenQuestions(db)
  assert.equal(report.merged, 0)
  assert.equal(report.tasks, 0)
  assert.doesNotThrow(() => ensureOpenQuestionIndex(db))
})

test('② 有重复：dry-run 只报，不落库', () => {
  const db = makeDb()
  ask(db, 'q1', 'T-1')
  ask(db, 'q2', 'T-1')

  const dry = mergeOpenQuestions(db, { dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.tasks, 1, '一张任务有双开')
  assert.equal(dry.planned, 1, '会归并掉 1 条')
  assert.deepEqual(openOf(db, 'T-1'), ['q1', 'q2'], 'dry-run 不得改动数据')
})

test('③ 真跑：保留最新，其余 superseded，并留审计', () => {
  const db = makeDb()
  ask(db, 'q1', 'T-1')
  ask(db, 'q2', 'T-1')
  ask(db, 'q3', 'T-1')
  const audits = []

  const report = mergeOpenQuestions(db, { audit: (entry) => audits.push(entry) })
  assert.equal(report.tasks, 1)
  assert.equal(report.merged, 2)
  assert.deepEqual(openOf(db, 'T-1'), ['q3'], '★ 保留最新那一条')
  assert.equal(db.prepare("SELECT status FROM agent_questions WHERE id='q1'").get().status, 'superseded')
  assert.equal(audits.length, 1, '归并动作本身要留痕')
  assert.equal(audits[0].kind, 'question_merge')
  assert.equal(audits[0].taskId, 'T-1')
  assert.equal(audits[0].kept, 'q3')
})

test('④ 幂等：再跑一次 merged 0，索引已可建', () => {
  const db = makeDb()
  ask(db, 'q1', 'T-1')
  ask(db, 'q2', 'T-1')
  mergeOpenQuestions(db)
  ensureOpenQuestionIndex(db)

  const again = mergeOpenQuestions(db)
  assert.equal(again.merged, 0)
  assert.equal(again.tasks, 0)
})

test('⑤ 索引真的挡住第二次 open（不是靠应用层自觉）', () => {
  const db = makeDb()
  ask(db, 'q1', 'T-1')
  ensureOpenQuestionIndex(db)
  assert.throws(() => ask(db, 'q2', 'T-1'), /UNIQUE|constraint/i, '★ 唯一索引必须在 DB 层拦住')

  // answered 的不受约束：答完再问是正常流程
  db.prepare("UPDATE agent_questions SET status='answered' WHERE id='q1'").run()
  assert.doesNotThrow(() => ask(db, 'q2', 'T-1'))
})

test('⑥ 已回答的问题不动（归并只碰 open）', () => {
  const db = makeDb()
  ask(db, 'q-old', 'T-1', 'answered')
  ask(db, 'q1', 'T-1')
  ask(db, 'q2', 'T-1')

  const report = mergeOpenQuestions(db)
  assert.equal(report.merged, 1)
  assert.equal(db.prepare("SELECT status FROM agent_questions WHERE id='q-old'").get().status, 'answered')
})

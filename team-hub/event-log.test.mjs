// team-hub/event-log.test.mjs
// ============================================================================
// F5 · 事件流与对账（设计稿 §3 F5 / M6）
//
// 全局约束：**状态写入与事件追加必须同事务**；事件流只供"回答为什么"，
// 消费方**不得触发派工**。这套判据就是这两条的实现证明。
//
// 判据：
//   ① event_id 由 (kind, subject, version) 决定 ⇒ 可重算、可去重
//   ② 同一 event_id 重复写入 ⇒ 忽略（不报错、不重编号，I-5.4）
//   ③ cursor 单调，回退的 advance 被拒（I-5.3：重启续读、不重放）
//   ④ poll 只给游标之后的事件；再 poll 为空
//   ⑤ 对账：一致 ⇒ 差异 0；被外部改坏 ⇒ 报出来且**不自动修复**（I-5.5）
//   ⑥ 消费事件不改任务状态（I-5.2：事件不触发派工）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  ensureEventSchema,
  eventIdFor,
  stampEvent,
  readEvents,
  createCursorStore,
  reconcileEvents,
} from './event-log.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'todo', version INTEGER NOT NULL DEFAULT 1, updatedAt TEXT
    );
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, thread_id TEXT, trigger_id TEXT,
      kind TEXT NOT NULL, matched_rule_ids TEXT DEFAULT '[]', would_accept INTEGER NOT NULL DEFAULT 0,
      reason TEXT, by TEXT NOT NULL, at TEXT NOT NULL, policy_version TEXT NOT NULL
    );
  `)
  ensureEventSchema(db)
  db.prepare("INSERT INTO tasks (id, status, updatedAt) VALUES ('T-1','todo','2026-11-03T00:00:00.000Z')").run()
  return db
}
/** 写一条审计行并盖上事件章（真实调用方就是这个形状：先 audit、再 stamp）。 */
function emit(db, { kind, subject, version, to = null, actorKind = 'soldier', addressed = 'none', human = 0 }) {
  const seq = db.prepare('INSERT INTO audit (ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?)')
    .run('2026-11-03T00:00:00.000Z', 'soldier-coder', 'default', kind, subject.replace(/^task:/, ''), null).lastInsertRowid
  return stampEvent(db, { seq, kind, subject, version, actorKind, addressed, human, payload: to === null ? null : { to } })
}

test('① event_id 由 (kind, subject, version) 决定', () => {
  const a = eventIdFor({ kind: 'task_status', subject: 'task:T-1', version: 2 })
  const b = eventIdFor({ kind: 'task_status', subject: 'task:T-1', version: 2 })
  const c = eventIdFor({ kind: 'task_status', subject: 'task:T-1', version: 3 })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^ev-[0-9a-f]{24}$/)
})

test('② 同一 event_id 重复写入 ⇒ 忽略（I-5.4）', () => {
  const db = makeDb()
  const first = emit(db, { kind: 'task_status', subject: 'task:T-1', version: 2, to: 'in_progress' })
  assert.equal(first.duplicate, false)

  const again = emit(db, { kind: 'task_status', subject: 'task:T-1', version: 2, to: 'in_progress' })
  assert.equal(again.duplicate, true, '★ 重复事件不该报错，也不该重编号')
  assert.equal(again.seq, first.seq, '幂等返回第一次的 seq')

  const rows = db.prepare('SELECT event_id FROM audit WHERE event_id IS NOT NULL').all()
  assert.equal(rows.length, 1, '唯一索引 + 幂等 = 库里只有一条')
})

test('③ cursor 单调：回退的 advance 被拒（I-5.3）', () => {
  const db = makeDb()
  const store = createCursorStore(db)
  store.advance('report', 5)
  assert.equal(store.get('report'), 5)
  store.advance('report', 3)
  assert.equal(store.get('report'), 5, '★ 游标不倒退')
})

test('④ poll 只给游标之后的事件，再 poll 为空（不重放）', () => {
  const db = makeDb()
  const one = emit(db, { kind: 'task_status', subject: 'task:T-1', version: 2, to: 'in_progress' })
  const two = emit(db, { kind: 'task_status', subject: 'task:T-1', version: 3, to: 'in_review' })

  const store = createCursorStore(db)
  const first = store.poll('report', { limit: 10 })
  assert.deepEqual(first.events.map((e) => e.seq), [one.seq, two.seq])
  assert.equal(first.cursor, two.seq)

  const second = store.poll('report', { limit: 10 })
  assert.deepEqual(second.events, [], '★ 同一批事件不会被读第二遍')
  assert.equal(second.cursor, two.seq)
})

test('⑤ 对账：事件与状态表必须对得上；被改坏 ⇒ 报出来且不修复（I-5.5）', () => {
  const db = makeDb()
  emit(db, { kind: 'task_status', subject: 'task:T-1', version: 2, to: 'in_progress' })

  // 事件说 in_progress，而状态表还是 todo（真实业务里两者同事务写入，所以这属于不一致）
  const drift = reconcileEvents(db)
  assert.equal(drift.mismatched.length, 1, '★ 只写一半要能查出来')
  assert.equal(drift.mismatched[0].expected, 'in_progress')
  assert.equal(drift.mismatched[0].actual, 'todo')

  // 让状态表追上事件
  db.prepare("UPDATE tasks SET status='in_progress' WHERE id='T-1'").run()
  assert.deepEqual(reconcileEvents(db).mismatched, [], '一致时不得有噪声')

  // 外部把状态改坏
  db.prepare("UPDATE tasks SET status='done' WHERE id='T-1'").run()
  const dirty = reconcileEvents(db)
  assert.equal(dirty.mismatched.length, 1)
  assert.equal(dirty.mismatched[0].taskId, 'T-1')
  assert.equal(dirty.mismatched[0].expected, 'in_progress')
  assert.equal(dirty.mismatched[0].actual, 'done')
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='T-1'").get().status, 'done', '★ 对账只读')
})

test('⑥ 消费事件不改任务状态（I-5.2：事件不触发派工）', () => {
  const db = makeDb()
  emit(db, { kind: 'task_status', subject: 'task:T-1', version: 2, to: 'in_progress' })
  const before = db.prepare('SELECT status, version FROM tasks WHERE id=?').get('T-1')

  const store = createCursorStore(db)
  store.poll('report', { limit: 10 })
  reconcileEvents(db)

  const after = db.prepare('SELECT status, version FROM tasks WHERE id=?').get('T-1')
  assert.deepEqual(after, before, '★ 读事件不得改动任务')
  assert.equal(readEvents(db).length, 1)
})

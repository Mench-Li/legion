// team-hub/schema-util.test.mjs
// ============================================================================
// 判据：启动期迁移的最小工具（PRT-314 / PRT-316）
//
// 这个模块只有两个函数，但它们是**唯一**允许自己写 ALTER 的地方：
// 本仓库的部署形态是两个进程并发打开同一个库、并发跑同一批迁移，
// 所以「检查 + 变更」必须原子。这一点由 `scripts/ci/dual-write-smoke.test.mjs`
// 的第三个锚点按**源码**守着（生产代码不许自己写 ALTER）。
//
// 本文件守的是另一半：`ensureColumn` 自己的**两种调用形态**——
// 顶层（自己开事务）与**已在事务里**（不能再开一个）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { columnExists, ensureColumn } from './schema-util.mjs'

function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)')
  return db
}

test('① 表不存在时 columnExists 返回 false（"该加"的语义）', () => {
  const db = freshDb()
  assert.equal(columnExists(db, 't', 'a'), true)
  assert.equal(columnExists(db, 't', 'b'), false)
  assert.equal(columnExists(db, 'nonexistent_table', 'x'), false)
  db.close()
})

test('② ensureColumn 补列、返回 true；已存在返回 false 且不动手', () => {
  const db = freshDb()
  assert.equal(ensureColumn(db, 't', 'b', 'TEXT'), true)
  assert.equal(columnExists(db, 't', 'b'), true)
  // 第二次：已经是目标状态，不开事务、不 ALTER
  assert.equal(ensureColumn(db, 't', 'b', 'TEXT'), false)
  // 已有列 a 也走"不开事务"那条
  assert.equal(ensureColumn(db, 't', 'a', 'TEXT'), false)
  db.close()
})

test('③ ★★★ 已经在事务里时不能再开一个事务（否则报的错与补列毫无关系）', () => {
  //   > 一个「在事务里也要自己开事务的」原语，
  //   > 与一个「调用方一旦把它放进事务、它就在完全不相关的地方炸掉」的原语，
  //   > 是同一个东西——只不过前者在单测里（没人在事务里调它）看起来是对的。
  //
  // 真实现场：运行面仓储的 `createApproval` 端口在它自己的 `BEGIN IMMEDIATE` 里
  // 被调用，端口内部要补审批表的列 → `ensureColumn` 又发一次 BEGIN IMMEDIATE →
  // `Error: cannot start a transaction within a transaction`。
  // 而三条本来就绿的状态机用例同时变红，报的是一句 SQLite 事务错误。
  const db = freshDb()
  db.exec('BEGIN IMMEDIATE')
  assert.equal(db.isTransaction, true, '夹具前提：确实在事务里')
  // 旧实现会在这里抛 cannot start a transaction
  assert.doesNotThrow(
    () => ensureColumn(db, 't', 'b', 'TEXT'),
    '已在事务里时不该再开一个事务——调用方本来就持有写锁，检查+变更已经是原子的',
  )
  assert.equal(columnExists(db, 't', 'b'), true)
  // 事务仍然健康，且我们补的列在这个事务里可见
  assert.equal(db.isTransaction, true)
  db.exec('COMMIT')
  assert.equal(db.isTransaction, false)
  assert.equal(columnExists(db, 't', 'b'), true)
  db.close()
})

test('③ ★★ 事务内补列失败要照抛，不能吞掉（真失败会让调用方回滚）', () => {
  // 嵌套分支仍然做「重读确认」而不是无条件吞异常：
  // 真失败（磁盘满 / 表被锁 / SQL 写错）照样抛。
  const db = freshDb()
  db.exec('BEGIN IMMEDIATE')
  // DDL 语法错 ⇒ 不是"列已存在"，必须抛（旧实现里"表名不存在"也是这一类）
  assert.throws(() => ensureColumn(db, 't', 'b', 'TEXT NOT NULL DEFAULT'), /.*/)
  // 表不存在：ALTER 抛 "no such table"，而 columnExists 也是 false ⇒ 照抛
  assert.throws(() => ensureColumn(db, 'no_such_table', 'b', 'TEXT'))
  db.exec('ROLLBACK')
  db.close()
})

test('④ ★★ 事务内嵌套两次补不同的列都生效', () => {
  const db = freshDb()
  db.exec('BEGIN IMMEDIATE')
  assert.equal(ensureColumn(db, 't', 'b', 'TEXT'), true)
  assert.equal(ensureColumn(db, 't', 'c', 'INTEGER DEFAULT 0'), true)
  assert.equal(ensureColumn(db, 't', 'b', 'TEXT'), false)
  db.exec('COMMIT')
  const cols = db.prepare('PRAGMA table_info(t)').all().map((x) => x.name)
  assert.deepEqual(cols.sort(), ['a', 'b', 'c', 'id'])
  // 默认值确实生效（不是只加了个空列）
  db.prepare('INSERT INTO t (id, c) VALUES (1, 7)').run()
  assert.equal(db.prepare('SELECT c FROM t WHERE id = 1').get().c, 7)
  db.close()
})

test('⑤ ★ 顶层分支回滚后不留下半个事务（异常路径不污染连接）', () => {
  const db = freshDb()
  assert.throws(() => ensureColumn(db, 'no_such_table', 'b', 'TEXT'))
  assert.equal(db.isTransaction, false, '失败后连接不该停在事务里')
  // 连接仍然可用
  assert.equal(ensureColumn(db, 't', 'b', 'TEXT'), true)
  db.close()
})

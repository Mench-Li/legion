// team-hub/node-context.test.mjs
// 远程 Agent 通道 S-D：派发前的上下文冻结。
//
// 这组用例守的是"远端能不能合法进入 `Running`"。而它同时也是**反作弊**的：
// 用真实的装配器与真实仓储，于是"冻结了一份真快照"与"塞了一行假记录"
// 在断言上分得开（假记录过不了 `contextStore.record` 的哈希校验）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createContextStore } from './context-store.mjs'
import { createNodeContextPreparer, NODE_CONTEXT_CODES, conservativeTokenizer } from './node-context.mjs'

/** 一张最小的 tasks 表；字段名与真实 server.mjs 建的那张一致（用到哪几列就建哪几列）。 */
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'todo', role TEXT, soldier TEXT, goalId TEXT,
      comments TEXT, artifacts TEXT, feedback TEXT, version INTEGER NOT NULL DEFAULT 1,
      hold INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE goals (
      id TEXT PRIMARY KEY, scope TEXT, title TEXT, status TEXT, summary TEXT,
      acceptance TEXT, contextVersion INTEGER, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE agent_feedback (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
      message_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, superseded INTEGER DEFAULT 0);
  `)
  return db
}

function seed(db, { taskId = 'T-1', scope = 'software', goalId = null, comments = [], artifacts = [], feedback = [] } = {}) {
  const now = new Date().toISOString()
  db.prepare('INSERT INTO tasks (id,scope,title,description,status,role,goalId,comments,artifacts,version,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(taskId, scope, '示例任务', '把这件事做完', 'todo', 'general', goalId, JSON.stringify(comments), JSON.stringify(artifacts), 2, now, now)
  if (goalId !== null) {
    db.prepare('INSERT INTO goals (id,scope,title,status,summary,contextVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(goalId, scope, '示例目标', 'active', '把军团跑通', 1, now, now)
  }
  for (const f of feedback) {
    db.prepare('INSERT INTO agent_feedback (id,scope,agent_id,task_id,message_id,body,created_at,superseded) VALUES (?,?,?,?,?,?,?,0)')
      .run(f.id, scope, 'agent-1', taskId, 1, f.body, now)
  }
  return taskId
}

function makePreparer(db) {
  const store = createContextStore({ db })
  return { store, prepare: createNodeContextPreparer({ db, contextStore: store }) }
}

const SNAPSHOT_ROWS = (db, attemptId) => db
  .prepare('SELECT * FROM run_context_snapshots WHERE attempt_id=?').all(attemptId)

// ── 正路 ────────────────────────────────────────────────────────────────────

test('冻结出一份**真**快照：任务/目标/评论/反馈/产物都进了来源', async () => {
  const db = makeDb()
  seed(db, {
    goalId: 'G-1',
    comments: [{ by: 'general', at: '2026-01-01T00:00:00.000Z', text: '注意别动生产库' }],
    // 产物必须能回答"当时是哪一版"：真实登记带内容 sha256，装配器也用不接受没有版本的产物。
    artifacts: [{ kind: 'file', path: 'reports/out.md', sha256: 'a'.repeat(64), bytes: 128 }],
    feedback: [{ id: 'fb-1', body: '请把日志级别降下来' }],
  })
  const { store, prepare } = makePreparer(db)
  const r = await prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software' })

  assert.equal(typeof r.snapshotHash, 'string')
  const rows = SNAPSHOT_ROWS(db, 'att:T-1:1')
  assert.equal(rows.length, 1, '快照必须落库（闸门看的就是这张表）')
  const payload = JSON.parse(rows[0].payload_json)
  const types = payload.sources.map((s) => s.type)
  for (const t of ['task', 'goal-context', 'comment', 'user-feedback', 'artifact']) {
    assert.ok(types.includes(t), `来源里应含 ${t}；实际：${types.join(',')}`)
  }
  // 内容是真的（不是占位符）。
  const serialized = JSON.stringify(payload)
  assert.match(serialized, /注意别动生产库/)
  assert.match(serialized, /请把日志级别降下来/)
  assert.match(serialized, /示例目标/)
  assert.equal(store.get('att:T-1:1').snapshotHash, r.snapshotHash, '仓储里读回来的哈希应与返回值一致')
})

test('没有目标/评论/反馈/产物时仍然冻结一份合法快照（"看了 0 个来源"是可回答的）', async () => {
  const db = makeDb()
  seed(db)
  const { prepare } = makePreparer(db)
  const r = await prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software' })
  assert.equal(typeof r.snapshotHash, 'string')
  const payload = JSON.parse(SNAPSHOT_ROWS(db, 'att:T-1:1')[0].payload_json)
  // 缺席的来源**不静默消失**：装配器会产出"缺失候选"，于是快照里能读到
  // "这次运行本该看团队计划，但系统里没有"，而不是看起来完整。
  const ids = payload.sources.map((s) => s.id)
  assert.ok(ids.some((id) => String(id).startsWith('task:T-1')), '任务本身必须在')
  assert.ok(Array.isArray(payload.excluded), '排除账本必须存在（哪些来源没进上下文要能回答）')
})

test('产物缺版本时**具名拒绝**——"当时是哪一版"答不出来就不该冻结', async () => {
  const db = makeDb()
  seed(db, { artifacts: [{ kind: 'file', path: 'reports/out.md' }] })
  const { prepare } = makePreparer(db)
  // 装配器的这条拒绝是对的：没有版本的来源无法回答"当时是哪一版"，
  // 而版本正是快照要固定的东西。本模块把它如实转成具名失败，不吞掉、也不替它编一个。
  await assert.rejects(
    () => prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software' }),
    (e) => e.code === NODE_CONTEXT_CODES.SOURCES_UNAVAILABLE && /版本/.test(e.message),
  )
  assert.equal(SNAPSHOT_ROWS(db, 'att:T-1:1').length, 0)
})

test('冻结是幂等的：同一 attempt 再来一次不产生第二行、也不报错', async () => {
  const db = makeDb()
  seed(db)
  const { prepare } = makePreparer(db)
  const a = await prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software' })
  const b = await prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software' })
  assert.equal(SNAPSHOT_ROWS(db, 'att:T-1:1').length, 1, 'attempt_id 是主键，重复冻结不该新增行')
  assert.equal(typeof b.snapshotHash, 'string')
  assert.ok(a.snapshotHash.length > 0)
})

test('只收本空间的数据（跨空间的任务读不到）', async () => {
  const db = makeDb()
  seed(db, { taskId: 'T-1', scope: 'software' })
  const { prepare } = makePreparer(db)
  // 用别的空间去冻结 → 具名拒绝，而不是拼出一份空上下文。
  await assert.rejects(
    () => prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'other-space' }),
    (e) => e.code === NODE_CONTEXT_CODES.TASK_UNAVAILABLE,
  )
  assert.equal(SNAPSHOT_ROWS(db, 'att:T-1:1').length, 0, '失败时不该留下任何快照行')
})

// ── 失败路径 ────────────────────────────────────────────────────────────────

test('任务不存在时具名失败（不降级成空上下文）', async () => {
  const db = makeDb()
  const { prepare } = makePreparer(db)
  await assert.rejects(
    () => prepare({ attemptId: 'att:x', taskId: 'NOPE', scope: 'software' }),
    (e) => e.code === NODE_CONTEXT_CODES.TASK_UNAVAILABLE,
  )
})

test('缺 attemptId/taskId/scope 时是**接线错误**（与运行期状况分开）', async () => {
  const db = makeDb()
  seed(db)
  const { prepare } = makePreparer(db)
  for (const bad of [{ taskId: 'T-1', scope: 's' }, { attemptId: 'a', scope: 's' }, { attemptId: 'a', taskId: 'T-1' }]) {
    await assert.rejects(() => prepare(bad), (e) => e.code === NODE_CONTEXT_CODES.BAD_WIRING)
  }
})

test('仓储拒绝落库时抛 PERSIST_FAILED（绝不能带着"没快照"继续）', async () => {
  const db = makeDb()
  seed(db)
  const brokenStore = { record: () => { throw new Error('磁盘满了') } }
  const prepare = createNodeContextPreparer({ db, contextStore: brokenStore })
  await assert.rejects(
    () => prepare({ attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software' }),
    (e) => e.code === NODE_CONTEXT_CODES.PERSIST_FAILED,
  )
})

test('构造期就要求 contextStore（缺了是编程错误，不是运行期状况）', () => {
  const db = makeDb()
  assert.throws(() => createNodeContextPreparer({ db }), (e) => e.code === NODE_CONTEXT_CODES.BAD_WIRING)
  assert.throws(() => createNodeContextPreparer({ db, contextStore: {} }), /record/)
  assert.throws(() => createNodeContextPreparer({ contextStore: { record: () => {} } }), /需要 db/)
})

test('快照哈希由装配器算出：手工塞一行假记录过不了校验', async () => {
  const db = makeDb()
  seed(db)
  const store = createContextStore({ db })
  // 伪造一条"看起来像快照"的记录。
  assert.throws(
    () => store.record({ attemptId: 'att-fake', snapshotHash: 'deadbeef', candidates: [] }),
    (e) => /哈希|hash/i.test(e.message),
  )
  assert.equal(SNAPSHOT_ROWS(db, 'att-fake').length, 0)
})

test('保守估算器只高估（tokens ≥ 码点数）且标明自己是估算', () => {
  const tok = conservativeTokenizer()
  assert.equal(tok.count('abcd'), 4)
  assert.ok(tok.kind.includes('estimate') || tok.kind.includes('conservative'))
  assert.ok(tok.note.length > 0)
})

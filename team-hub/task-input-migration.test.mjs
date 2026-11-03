// team-hub/task-input-migration.test.mjs
// ============================================================================
// F0 · A 段迁移：把历史 `tasks.comments / evidence / feedback` 三列的数组
// 回填成 `task_input` 行（设计稿 §3 F0「迁移」、M1-4）。
//
// 三条硬要求：
//   ① **幂等**：跑两次不会翻倍（id = hash(taskId, channel, at, by, body)）
//   ② **不改列**：迁移只写行；列在迁移后仍是同一份投影（差异 0）
//   ③ **可预演**：`--dry-run` 不落库，只报"会搬多少条、跳过多少条"
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureTaskInputSchema, migrateLegacyNotes, projectField, reconcileInputs } from './task-input.mjs'

function legacyDb() {
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
  const legacy = {
    comments: [
      { by: 'general', at: '2026-10-01T01:00:00.000Z', text: '历史批注一' },
      { by: 'soldier-coder', at: '2026-10-01T02:00:00.000Z', text: '历史批注二' },
    ],
    evidence: [{ by: 'soldier-coder', at: '2026-10-01T03:00:00.000Z', text: 'build 通过' }],
    feedback: [{ by: 'user', at: '2026-10-01T04:00:00.000Z', text: '体验不错' }],
  }
  db.prepare('INSERT INTO tasks (id, scope, comments, evidence, feedback, updatedAt) VALUES (?,?,?,?,?,?)')
    .run('T-legacy', 'default', JSON.stringify(legacy.comments), JSON.stringify(legacy.evidence), JSON.stringify(legacy.feedback), '2026-10-01T04:00:00.000Z')
  db.prepare('INSERT INTO tasks (id, scope, updatedAt) VALUES (?,?,?)').run('T-empty', 'default', '2026-10-01T00:00:00.000Z')
  return { db, legacy }
}

test('① 回填：三列历史数组 → 行，种类正确、顺序保持', () => {
  const { db } = legacyDb()
  const report = migrateLegacyNotes(db)

  assert.equal(report.inserted, 4)
  assert.equal(report.scanned, 2, '扫了两张任务（含空的那张）')

  const rows = db.prepare('SELECT kind, body, created_at FROM task_input WHERE task_id=? ORDER BY created_at, rowid').all('T-legacy')
  assert.deepEqual(rows.map(r => r.body), ['历史批注一', '历史批注二', 'build 通过', '体验不错'])
  assert.deepEqual(rows.map(r => r.kind), ['comment', 'comment', 'evidence', 'feedback'])
})

test('② 迁移后列 = 投影（差异 0）——迁移不得改动历史内容', () => {
  const { db, legacy } = legacyDb()
  migrateLegacyNotes(db)

  assert.deepEqual(JSON.parse(projectField(db, 'T-legacy', 'comments')), legacy.comments)
  assert.deepEqual(JSON.parse(projectField(db, 'T-legacy', 'evidence')), legacy.evidence)
  assert.deepEqual(JSON.parse(projectField(db, 'T-legacy', 'feedback')), legacy.feedback)
  assert.deepEqual(reconcileInputs(db).mismatched, [], '迁移完成后对账必须干净')
})

test('③ 幂等：再跑一次不新增行', () => {
  const { db } = legacyDb()
  migrateLegacyNotes(db)
  const first = db.prepare('SELECT COUNT(*) c FROM task_input').get().c

  const second = migrateLegacyNotes(db)
  assert.equal(second.inserted, 0, '第二次不得再插')
  assert.equal(second.duplicated, 4, '应报出"这 4 条已存在"')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_input').get().c, first)
})

test('④ dry-run：只报数，不落库', () => {
  const { db } = legacyDb()
  const report = migrateLegacyNotes(db, { dryRun: true })

  assert.equal(report.dryRun, true)
  assert.equal(report.inserted, 0)
  assert.equal(report.planned, 4, '预演要给出"会搬多少条"')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM task_input').get().c, 0)
})

test('⑤ 空文本/坏条目不搬，计入 skipped', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'default',
    comments TEXT DEFAULT '[]', evidence TEXT DEFAULT '[]', feedback TEXT DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1, updatedAt TEXT)`)
  ensureTaskInputSchema(db)
  const dirty = [{ by: 'general', at: '2026-10-02T00:00:00.000Z', text: '   ' }, { by: 'general' }, 'not-an-object']
  db.prepare('INSERT INTO tasks (id, comments, updatedAt) VALUES (?,?,?)').run('T-dirty', JSON.stringify(dirty), '2026-10-02T00:00:00.000Z')

  const report = migrateLegacyNotes(db)
  assert.equal(report.inserted, 0)
  assert.equal(report.skipped, 3)
})

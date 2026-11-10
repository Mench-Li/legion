// team-hub/audit-archive.test.mjs
// ============================================================================
// 审计归档：把"什么都没发生"的历史挪走，但不破坏审计的**可用性**
//
// 背景（真实库 2026-11-09）：audit 136,476 行里 132,198 行是 `release-stale`，
// 其中 84,253 行载荷是 `{"released":[],"quarantined":[]}` —— 97% 的审计在记"无事发生"。
//
// 归档比删除危险的地方在于三条不变量，任何一条破了都比噪音更糟：
//   ① **seq 单调性**：`audit.seq = MAX(seq)+1`，把最大的那行删掉会让 seq 回退 ⇒ 游标重放。
//   ② **可追溯**：被挪走的行必须还能查（归档表），而不是消失。
//   ③ **幂等**：重复跑不能重复归档或多删。
//
// 判据：
//   ① 空载荷识别：`{released:[],quarantined:[]}` 算空；有内容的不算；detail 为 null/坏 JSON **不算空**
//   ② plan 只读（不写库）
//   ③ apply：行进归档表、从 audit 消失
//   ④ **seq 单调性**：归档后新写的审计 seq 必须大于归档前的最大值
//   ⑤ 永不归档当前最大 seq 那一行（keepNewest 兜底）
//   ⑥ 幂等：再跑一次归档 0 行
//   ⑦ 非目标 action / 非空载荷 一律不动
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureArchiveSchema, isEmptyDetail, planArchive, applyArchive } from './audit-archive.mjs'

/** 最小 audit 夹具（列与真实表一致）。 */
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE audit (
    seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, member TEXT, scope TEXT, action TEXT NOT NULL,
    taskId TEXT, detail TEXT, actor_kind TEXT, addressed INTEGER, human INTEGER, event_id TEXT, goalId TEXT)`)
  ensureArchiveSchema(db)
  return db
}

const addAudit = (db, seq, action, detail, ts = '2026-11-01T00:00:00.000Z') => db.prepare(
  'INSERT INTO audit (seq, ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?,?)',
).run(seq, ts, 'soldier', 'default', action, '*', JSON.stringify(detail))

const EMPTY = { released: [], quarantined: [] }

test('① 空载荷识别', () => {
  assert.equal(isEmptyDetail(EMPTY), true)
  assert.equal(isEmptyDetail({ released: ['T-1'], quarantined: [] }), false, '有回收 → 不是空')
  assert.equal(isEmptyDetail({ released: [], quarantined: ['T-2'] }), false, '有挂起 → 不是空')
  assert.equal(isEmptyDetail(null), false, '读不出载荷 ⇒ 保守：不当空')
  assert.equal(isEmptyDetail('{坏 JSON'), false)
  assert.equal(isEmptyDetail({}), false, '缺字段 ⇒ 不当空')
})

test('② plan 只读', () => {
  const db = makeDb()
  addAudit(db, 1, 'release-stale', EMPTY)
  addAudit(db, 2, 'release-stale', { released: ['T-9'], quarantined: [] })
  const before = db.prepare('SELECT COUNT(*) c FROM audit').get().c
  const plan = planArchive(db, { action: 'release-stale' })
  assert.equal(plan.count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit').get().c, before, '★ 规划不能动库')
  db.close()
})

test('③ apply：进归档表、从 audit 消失', () => {
  const db = makeDb()
  addAudit(db, 1, 'release-stale', EMPTY)
  addAudit(db, 2, 'release-stale', EMPTY)
  addAudit(db, 3, 'claim', { soldier: 'coder' })
  const out = applyArchive(db, { action: 'release-stale' })
  assert.equal(out.archived, 2)
  assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM audit').get().c), 1, 'audit 只剩非目标行')
  const rows = db.prepare('SELECT seq, action FROM audit_archive ORDER BY seq').all()
  assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2], '★ 挪走的行必须还能查')
  assert.equal(rows.every((r) => r.action === 'release-stale'), true)
  db.close()
})

test('④ seq 单调性：归档后新写审计的 seq 仍递增', () => {
  const db = makeDb()
  for (let i = 1; i <= 5; i++) addAudit(db, i, 'release-stale', EMPTY)
  const maxBefore = Number(db.prepare('SELECT MAX(seq) m FROM audit').get().m)
  applyArchive(db, { action: 'release-stale' })
  const maxAfter = Number(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM audit').get().m)
  assert.equal(maxAfter, maxBefore, '★ 归档不许把 SEQ 天花板削低（否则游标会重放）')
  // 模拟 audit() 的分配方式
  const next = maxAfter + 1
  db.prepare('INSERT INTO audit (seq, ts, action, detail) VALUES (?,?,?,?)').run(next, '2026-11-09T00:00:00.000Z', 'claim', '{}')
  assert.ok(next > maxBefore, '新行必须排在归档前的历史之后')
  db.close()
})

test('⑤ 永不归档当前最大 seq 那一行', () => {
  const db = makeDb()
  addAudit(db, 1, 'release-stale', EMPTY)
  addAudit(db, 2, 'release-stale', EMPTY) // 这是当前最大
  const out = applyArchive(db, { action: 'release-stale' })
  assert.equal(out.archived, 1, '只归档第 1 行')
  assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM audit WHERE seq=2').get().c), 1, '★ 天花板必须留在库里')
  db.close()
})

test('⑥ 幂等：再跑一次归档 0 行', () => {
  const db = makeDb()
  addAudit(db, 1, 'release-stale', EMPTY)
  addAudit(db, 2, 'release-stale', EMPTY)
  const first = applyArchive(db, { action: 'release-stale' })
  const second = applyArchive(db, { action: 'release-stale' })
  assert.equal(first.archived, 1)
  assert.equal(second.archived, 0)
  assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM audit_archive').get().c), 1)
  db.close()
})

test('⑦ 非目标 action 与非空载荷一律不动', () => {
  const db = makeDb()
  addAudit(db, 1, 'claim', {})
  addAudit(db, 2, 'release-stale', { released: ['T-1'], quarantined: [] })
  addAudit(db, 3, 'release-stale', EMPTY)
  // 4 是当前最大 seq：因为 keepNewest=1，天花板那一行永远不归档
  addAudit(db, 4, 'claim', {})
  const out = applyArchive(db, { action: 'release-stale' })
  assert.equal(out.archived, 1)
  assert.deepEqual(db.prepare('SELECT seq FROM audit ORDER BY seq').all().map((r) => Number(r.seq)), [1, 2, 4])
  db.close()
})

test('⑨ limit：分批归档每次只搬 N 行（避免长时间独占写锁）', () => {
  const db = makeDb()
  for (let i = 1; i <= 10; i++) addAudit(db, i, 'release-stale', EMPTY)
  addAudit(db, 11, 'claim', {})
  const first = applyArchive(db, { action: 'release-stale', limit: 3 })
  assert.equal(first.archived, 3)
  const second = applyArchive(db, { action: 'release-stale', limit: 3 })
  assert.equal(second.archived, 3)
  db.close()
})
test('⑧ before 截止时间生效（只归档更早的历史）', () => {
  const db = makeDb()
  addAudit(db, 1, 'release-stale', EMPTY, '2026-10-01T00:00:00.000Z')
  addAudit(db, 2, 'release-stale', EMPTY, '2026-11-09T00:00:00.000Z')
  addAudit(db, 3, 'claim', {}, '2026-11-09T01:00:00.000Z')
  const out = applyArchive(db, { action: 'release-stale', before: '2026-11-01T00:00:00.000Z' })
  assert.equal(out.archived, 1)
  assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM audit WHERE seq=1').get().c), 0)
  assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM audit WHERE seq=2').get().c), 1)
  db.close()
})

// team-hub/goal-borrow.test.mjs
// ============================================================================
// F6 · 借槽与到期释放（设计稿 §8.1 / I-6.2）
//
// 借槽是配额能"空载时吃满"的原因，也是最容易变成**永久占用**的地方：
// 一旦借出去不收回，第二次借就成了白送，配额名存实亡。
//
// 判据：
//   ① 记录借槽：带 granted_at / until，可按 goal 查
//   ② 未到期不释放
//   ③ 到期释放：写 released_at，并留一条 `share_release` 审计
//   ④ 幂等：同一笔借槽不会重复审计（重跑释放器不刷屏）
//   ⑤ 释放只动过期的那几笔，其它借槽不受影响
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  ensureBorrowSchema,
  recordBorrow,
  activeBorrows,
  releaseExpiredBorrows,
} from './goal-share.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
    action TEXT, taskId TEXT, detail TEXT);`)
  ensureBorrowSchema(db)
  return db
}
const auditsOf = (db, action) =>
  db.prepare('SELECT taskId, detail FROM audit WHERE action=?').all(action)

test('① 记录借槽：带 until，可按 goal 查', () => {
  const db = makeDb()
  const borrow = recordBorrow(db, {
    goalId: 'G-1', taskId: 'T-1', scope: 'default',
    grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 600,
  })
  assert.equal(borrow.goal_id, 'G-1')
  assert.equal(borrow.until, '2026-11-03T00:10:00.000Z')
  assert.equal(activeBorrows(db, { goalId: 'G-1' }).length, 1)
  assert.equal(activeBorrows(db, { goalId: 'G-2' }).length, 0)
})

test('② 未到期不释放', () => {
  const db = makeDb()
  recordBorrow(db, { goalId: 'G-1', taskId: 'T-1', grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 600 })
  const out = releaseExpiredBorrows(db, { now: '2026-11-03T00:05:00.000Z' })
  assert.equal(out.released, 0)
  assert.equal(activeBorrows(db).length, 1)
})

test('③ 到期释放并留 share_release 审计（I-6.2）', () => {
  const db = makeDb()
  recordBorrow(db, { goalId: 'G-1', taskId: 'T-1', grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 600 })

  const out = releaseExpiredBorrows(db, { now: '2026-11-03T00:11:00.000Z' })
  assert.equal(out.released, 1)
  assert.deepEqual(out.goals, ['G-1'])
  assert.equal(activeBorrows(db).length, 0, '★ 释放后不再是活跃借槽')

  const audits = auditsOf(db, 'share_release')
  assert.equal(audits.length, 1)
  assert.match(String(audits[0].detail), /G-1/)
})

test('④ 幂等：重跑释放器不重复审计', () => {
  const db = makeDb()
  recordBorrow(db, { goalId: 'G-1', taskId: 'T-1', grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 600 })
  releaseExpiredBorrows(db, { now: '2026-11-03T00:11:00.000Z' })
  const again = releaseExpiredBorrows(db, { now: '2026-11-03T00:20:00.000Z' })

  assert.equal(again.released, 0)
  assert.equal(auditsOf(db, 'share_release').length, 1, '★ 同一笔只审计一次')
})

test('⑤ 只动过期的那几笔', () => {
  const db = makeDb()
  recordBorrow(db, { goalId: 'G-old', taskId: 'T-1', grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 600 })
  recordBorrow(db, { goalId: 'G-new', taskId: 'T-2', grantedAt: '2026-11-03T00:30:00.000Z', ttlSec: 600 })

  const out = releaseExpiredBorrows(db, { now: '2026-11-03T00:35:00.000Z' })
  assert.equal(out.released, 1)
  assert.deepEqual(activeBorrows(db).map((b) => b.goal_id), ['G-new'], '★ 未过期的不受影响')
})

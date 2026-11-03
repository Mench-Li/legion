// team-hub/claim-admission.test.mjs
// ============================================================================
// F6 + F7 · 认领准入：保留槽与目标配额（设计稿 §8.1 / §8.2 接线点）
//
// 这两条规则都属于"谁先拿到槽"，所以放在**同一个准入判定**里，避免各写一遍、结论打架。
//
// ★ 默认关闭（`enabled=false`）：开关全关 = 今天的行为（白皮书 A9）。
//   一个没被验证过的排序/配额规则，不该在默认路径上影响真实派工。
//
// 判据：
//   ① 关闭时一律放行（今天的行为）
//   ② 开启 + 只剩保留槽 + 后台请求 ⇒ 拒（I-7.3）
//   ③ 开启 + 只剩保留槽 + 人请求 ⇒ 放行
//   ④ 开启 + 超目标配额 + 别的目标在等 ⇒ 拒（I-6.1）
//   ⑤ 开启 + 超目标配额 + 无人在等 ⇒ 借槽放行（带 borrowUntil）
//   ⑥ 拒绝必须给可读理由（调用方要能把它显示给人看）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ADMISSION_ERRORS, admitClaim } from './claim-admission.mjs'

/**
 * 两个夹具分别压不同的闸：
 *   `maxWorkers=2` ⇒ 只剩保留槽（压 I-7.3）
 *   `maxWorkers=10 + share=0.1` ⇒ 单目标配额只有 1（压 I-6.1）
 * 用一个夹具同时压两条闸，会永远先撞到保留槽，测不到配额。
 */
function makeDb({ maxWorkers = 2, share = 0.5, running = 1 } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'todo', goalId TEXT, role TEXT, updatedAt TEXT);
    CREATE TABLE space_runtime (scope TEXT PRIMARY KEY, maxWorkers INTEGER DEFAULT 1, reserved_slots INTEGER DEFAULT 1,
      goal_share TEXT);
  `)
  db.prepare("INSERT INTO space_runtime (scope, maxWorkers, reserved_slots, goal_share) VALUES ('default', ?, 1, ?)")
    .run(maxWorkers, JSON.stringify({ default: share, weights: {}, borrowTtlSec: 600 }))
  db.prepare("INSERT INTO tasks (id, status, goalId) VALUES ('T-run','in_progress','G-big')").run()
  for (let i = 1; i < running; i += 1) {
    db.prepare('INSERT INTO tasks (id, status, goalId) VALUES (?,?,?)').run(`T-run${i}`, 'in_progress', 'G-big')
  }
  db.prepare("INSERT INTO tasks (id, status, goalId) VALUES ('T-wait','todo','G-big')").run()
  db.prepare("INSERT INTO tasks (id, status, goalId) VALUES ('T-small','todo','G-small')").run()
  return db
}
const opts = (over = {}) => ({ enabled: true, now: '2026-11-03T00:10:00.000Z', ...over })

test('① 关闭时一律放行（今天的行为）', () => {
  const db = makeDb()
  const out = admitClaim(db, { taskId: 'T-small', by: 'agent:coder', scope: 'default' }, { enabled: false })
  assert.equal(out.allowed, true)
  assert.equal(out.reason, 'admission-disabled')
})

test('② 只剩保留槽 + 后台请求 ⇒ 拒（I-7.3）', () => {
  const db = makeDb()
  // maxWorkers=2、已有 1 个在跑、保留槽 1 ⇒ 后台只剩 0 个可用
  const out = admitClaim(db, { taskId: 'T-small', by: 'agent:coder', scope: 'default' }, opts())
  assert.equal(out.allowed, false)
  assert.equal(out.code, ADMISSION_ERRORS.RESERVED_FOR_HUMAN)
})

test('③ 只剩保留槽 + 人请求 ⇒ 放行', () => {
  const db = makeDb()
  const out = admitClaim(db, { taskId: 'T-small', by: 'general', scope: 'default' }, opts())
  assert.equal(out.allowed, true)
})

test('④ 超目标配额 + 别的目标在等 ⇒ 拒（I-6.1）', () => {
  // 配额 = ceil(10 × 0.1) = 1，而 G-big 已有 1 条在跑 ⇒ 超配额
  const db = makeDb({ maxWorkers: 10, share: 0.1 })
  // T-small 属于另一个目标且在排队 ⇒ 有别的目标在等
  const out = admitClaim(db, { taskId: 'T-wait', by: 'general', scope: 'default' }, opts())
  assert.equal(out.allowed, false)
  assert.equal(out.code, ADMISSION_ERRORS.OVER_GOAL_QUOTA)
})

test('⑤ 超目标配额 + 无人在等 ⇒ 借槽放行（带 borrowUntil）', () => {
  const db = makeDb({ maxWorkers: 10, share: 0.1 })
  // 把唯一在等的小目标也变成本目标的排队任务 ⇒ 没有别的目标在等
  db.prepare("UPDATE tasks SET goalId='G-big' WHERE id='T-small'").run()

  const out = admitClaim(db, { taskId: 'T-wait', by: 'general', scope: 'default' }, opts())
  assert.equal(out.allowed, true)
  assert.equal(out.borrowed, true)
  assert.equal(typeof out.borrowUntil, 'string')
})

test('⑥ 拒绝必须给可读理由', () => {
  const db = makeDb()
  const out = admitClaim(db, { taskId: 'T-small', by: 'agent:coder', scope: 'default' }, opts())
  assert.equal(out.allowed, false)
  assert.ok(String(out.userText).length > 0, '★ 说不出理由的拒绝，等于让人干等')
})

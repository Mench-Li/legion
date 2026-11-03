// team-hub/goal-share-routes.test.mjs
// ============================================================================
// F6 · 目标份额的 HTTP 面（设计稿 §8.1 / M8）
//
//   GET  /api/spaces/:scope/goal-share      只读：当前配置（未配置时给默认值）
//   POST /api/spaces/:scope/goal-share      写入（归一化后落 space_runtime.goal_share）
//   POST /api/goal-borrows/release          释放到期借槽（写 share_release 审计）
//
// 判据：
//   ① 未配置 ⇒ 返回默认 0.5 / TTL 600（不是 null：调用方不该自己补默认值）
//   ② 写入后被归一化（份额夹 0..1、TTL 夹下限、非法权重丢弃）
//   ③ 释放接口：到期借槽被释放并留审计
//   ④ 释放接口幂等：再调一次不再新增审计
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const req = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-goalshare-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 未配置 ⇒ 默认份额 0.5 / TTL 600', async () => {
  const r = await req('GET', '/api/spaces/default/goal-share')
  assert.equal(r.status, 200)
  assert.equal(r.body.scope, 'default')
  assert.equal(r.body.config.default, 0.5)
  assert.equal(r.body.config.borrowTtlSec, 600)
  assert.deepEqual(r.body.config.weights, {})
})

test('② 写入被归一化（份额夹 0..1、TTL 夹下限、非法权重丢弃）', async () => {
  const r = await req('POST', '/api/spaces/default/goal-share', {
    by: 'general',
    config: { default: 3, weights: { 'G-1': 2.4, 'G-2': 'x' }, borrowTtlSec: 10 },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.config.default, 1, '★ 份额夹到 1')
  assert.equal(r.body.config.weights['G-1'], 2)
  assert.equal(r.body.config.weights['G-2'], undefined)
  assert.equal(r.body.config.borrowTtlSec, 60, '★ TTL 夹到下限 60')

  const again = await req('GET', '/api/spaces/default/goal-share')
  assert.equal(again.body.config.default, 1, '写入后读得回来')
})

test('③ 释放到期借槽并留 share_release 审计', async () => {
  const { ensureBorrowSchema, recordBorrow } = await import('./goal-share.mjs')
  ensureBorrowSchema(mod.db)
  recordBorrow(mod.db, { goalId: 'G-old', taskId: 'T-1', grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 600 })

  const r = await req('POST', '/api/goal-borrows/release', { by: 'general', now: '2026-11-03T01:00:00.000Z' })
  assert.equal(r.status, 200)
  assert.equal(r.body.released, 1)
  assert.deepEqual(r.body.goals, ['G-old'])
  const audits = mod.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='share_release'").get().c
  assert.equal(Number(audits), 1)
})

test('④ 释放接口幂等：再调一次不新增审计', async () => {
  const r = await req('POST', '/api/goal-borrows/release', { by: 'general', now: '2026-11-03T02:00:00.000Z' })
  assert.equal(r.body.released, 0)
  const audits = mod.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='share_release'").get().c
  assert.equal(Number(audits), 1, '★ 重跑不刷屏')
})

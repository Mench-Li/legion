// team-hub/goal-borrow-routes.test.mjs
// ============================================================================
// F6 · 借槽的**演练/运维入口**（补齐"造一笔借槽 → 到期释放 → 留痕"闭环）
//
// 之前只有 `release` 端点，却没有"造出借槽"的路径 ⇒ 演练只能验一半。
// 这里补 `POST /api/goal-borrows`（明确标注为演练/运维用，不是业务主路径）。
//
// 判据：
//   ① 造借槽：200，返回 until = grantedAt + ttl（TTL 有下限）
//   ② 到期释放：released=1，并且**留一条 share_release 审计**（I-6.2）
//   ③ 幂等：再释放一次 released=0，不新增审计
//   ④ 缺 goalId ⇒ 400（不允许"无名借槽"，那会让审计对不上人/目标）
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
  dbDir = mkdtempSync(join(tmpdir(), 'legion-borrow-routes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 造借槽：until = grantedAt + ttl（TTL 有下限）', async () => {
  const r = await req('POST', '/api/goal-borrows', {
    by: 'general', goalId: 'G-drill', taskId: 'T-drill',
    grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 5,
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.borrow.goal_id, 'G-drill')
  // 5 秒被夹到下限 60 秒
  assert.equal(r.body.borrow.until, '2026-11-03T00:01:00.000Z')
})

test('② 到期释放并留 share_release 审计（I-6.2）', async () => {
  const r = await req('POST', '/api/goal-borrows/release', { by: 'general', now: '2026-11-03T01:00:00.000Z' })
  assert.equal(r.status, 200)
  assert.equal(r.body.released, 1)
  assert.deepEqual(r.body.goals, ['G-drill'])
  const audits = mod.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='share_release'").get().c
  assert.equal(Number(audits), 1, '★ 借了不还也要有人知道，还了必须留痕')
})

test('③ 幂等：再释放一次不新增审计', async () => {
  const r = await req('POST', '/api/goal-borrows/release', { by: 'general', now: '2026-11-03T02:00:00.000Z' })
  assert.equal(r.body.released, 0)
  const audits = mod.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='share_release'").get().c
  assert.equal(Number(audits), 1)
})

test('④ 缺 goalId ⇒ 400（无名借槽会让审计对不上目标）', async () => {
  const r = await req('POST', '/api/goal-borrows', { by: 'general', taskId: 'T-x' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /goalId/)
})

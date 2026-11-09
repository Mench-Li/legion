// team-hub/release-stale-audit.test.mjs
// ============================================================================
// 回收器审计：**什么都没释放时不要写审计**
//
// 现场（2026-11-09 F1 真机演练）：守护每跳一次（5s）就调一次 `/api/release-stale`，
// 10 分钟写进 **149 行** `release-stale` 审计，内容几乎全是 `{"released":[],"quarantined":[]}`。
//
// 为什么这不是"小事"：审计表是排查与 F5 事件流的底座，
// 让它被空载荷刷满，等于把"有没有发生回收"这件事**淹没在噪音里**——
// 真出事时需要的是"哪几件事被回收了"，而不是"一共跳了多少次"。
//
// 判据：
//   ① 无可回收任务 ⇒ 不写审计（返回体仍是 {released:[],quarantined:[]}，调用方不受影响）
//   ② 真的回收了 ⇒ 写审计，且载荷里带着被回收的 id
//   ③ 连跳两次空转 ⇒ 审计不增长（这是刷屏的直接复现）
//   ④ 有回收的那次之后再来一次空转 ⇒ 审计停在 1 行
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

const auditCount = (action) => Number(mod.db.prepare('SELECT COUNT(*) AS c FROM audit WHERE action=?').get(action)?.c ?? 0)

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-stale-audit-'))
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

test('① 无可回收任务 ⇒ 不写审计', async () => {
  const before = auditCount('release-stale')
  const r = await req('POST', '/api/release-stale', { by: 'general', scope: 'default', olderThan: 60 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.task.released, [])
  assert.deepEqual(r.body.task.quarantined, [])
  assert.equal(auditCount('release-stale'), before, '★ 空转不该留痕')
})

test('③ 连跳两次空转 ⇒ 审计不增长', async () => {
  const before = auditCount('release-stale')
  await req('POST', '/api/release-stale', { by: 'general', scope: 'default', olderThan: 60 })
  await req('POST', '/api/release-stale', { by: 'general', scope: 'default', olderThan: 60 })
  assert.equal(auditCount('release-stale'), before, '★ 守护每跳一次都会调它，这是刷屏的直接复现')
})

test('② 真的回收了 ⇒ 写审计且带 id', async () => {
  const created = await req('POST', '/api/create', { title: 'stale-task', by: 'general' })
  const id = created.body.task.id
  mod.db.prepare("UPDATE tasks SET status='in_progress', soldier='s', claimedAt=?, updatedAt=? WHERE id=?")
    .run(new Date(Date.now() - 30 * 60_000).toISOString(), new Date(Date.now() - 30 * 60_000).toISOString(), id)

  const before = auditCount('release-stale')
  const r = await req('POST', '/api/release-stale', { by: 'general', scope: 'default', olderThan: 5 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.task.released, [id])
  const after = auditCount('release-stale')
  assert.equal(after, before + 1, '真回收必须留痕')
  const row = mod.db.prepare("SELECT detail FROM audit WHERE action='release-stale' ORDER BY seq DESC LIMIT 1").get()
  assert.match(String(row.detail), new RegExp(id), '载荷里要能看出回收了谁')
})

test('④ 回收之后再空转 ⇒ 审计停在原地', async () => {
  const before = auditCount('release-stale')
  await req('POST', '/api/release-stale', { by: 'general', scope: 'default', olderThan: 5 })
  assert.equal(auditCount('release-stale'), before)
})

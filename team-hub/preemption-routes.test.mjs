// team-hub/preemption-routes.test.mjs
// ============================================================================
// F7 · 抢占的 HTTP 面（设计稿 §8.2 / M9）
//
//   POST /api/tasks/:id/preempt  { by, reason, strength, kind, now }
//
// 判据：
//   ① 人 + explicit + 已跑够 ⇒ 200：台账记一笔、任务里留一条"被谁因何抢占"（I-7.2）
//   ② bot 发起 ⇒ 422（I-7.3）
//   ③ inferred 强度 ⇒ 422（I-7.1）
//   ④ 不足 60s ⇒ 422（防抖）
//   ⑤ 窗口内已抢 2 次 ⇒ 422 + alert（I-7.4）
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
const mkTask = async () => (await req('POST', '/api/create', { title: '抢占宿主', by: 'general' })).body.task.id
/** 把任务摆成"正在执行且已跑够 5 分钟"（免去真的跑一次 worker）。 */
const markRunning = (id, claimedAt = '2026-11-03T00:00:00.000Z') => {
  mod.db.prepare("UPDATE tasks SET status='in_progress', soldier='soldier-coder', claimedAt=? WHERE id=?").run(claimedAt, id)
}
const preempt = (id, body = {}) => req('POST', `/api/tasks/${id}/preempt`, {
  by: 'general', kind: 'general', strength: 'explicit', reason: '线上故障', now: '2026-11-03T00:10:00.000Z', ...body,
})

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-preempt-'))
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

test('① 允许抢占：记台账 + 留说明（I-7.2）', async () => {
  const id = await mkTask()
  markRunning(id)
  const r = await preempt(id)

  assert.equal(r.status, 200)
  assert.equal(r.body.allowed, true)
  assert.ok(r.body.preemption?.id, '台账要记一笔')
  assert.match(String(r.body.note), /线上故障/)

  const inputs = (await req('GET', `/api/tasks/${id}/inputs`)).body.inputs
  assert.ok(inputs.some((i) => String(i.body).includes('线上故障')), '★ 任务里要看得见"被谁因何抢占"')
})

test('② bot 发起 ⇒ 422（I-7.3）', async () => {
  const id = await mkTask()
  markRunning(id)
  const r = await preempt(id, { kind: 'bot' })
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'PREEMPT_NOT_HUMAN')
})

test('③ inferred 强度 ⇒ 422（I-7.1）', async () => {
  const id = await mkTask()
  markRunning(id)
  const r = await preempt(id, { strength: 'inferred' })
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'PREEMPT_NEEDS_EXPLICIT')
})

test('④ 不足 60s ⇒ 422（防抖）', async () => {
  const id = await mkTask()
  markRunning(id, '2026-11-03T00:09:40.000Z')
  const r = await preempt(id)
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'PREEMPT_TOO_EARLY')
})

test('⑤ 窗口内已抢 2 次 ⇒ 422 + alert（I-7.4）', async () => {
  const id = await mkTask()
  markRunning(id)
  assert.equal((await preempt(id, { now: '2026-11-03T00:03:00.000Z' })).status, 200)
  // 抢占成功后任务回到 todo（执行面生效）；它被重新认领后会再次变成 in_progress
  markRunning(id)
  assert.equal((await preempt(id, { now: '2026-11-03T00:07:00.000Z' })).status, 200)
  markRunning(id)

  const third = await preempt(id, { now: '2026-11-03T00:10:00.000Z' })
  assert.equal(third.status, 422)
  assert.equal(third.body.code, 'PREEMPT_LOOP_GUARD')
  assert.equal(third.body.alert, true, '★ 拒绝要能被看见')
})

test('⑥ 执行面：抢占成功后任务回到 todo（可被重新认领 = 可 resume）', async () => {
  const id = await mkTask()
  markRunning(id)
  const r = await preempt(id)
  assert.equal(r.status, 200)
  assert.equal(r.body.transitioned, true, '★ 真的让了槽')
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'todo',
    '★ 回到 todo 才能被重新认领，否则"抢占"只是把人踢下线')
})

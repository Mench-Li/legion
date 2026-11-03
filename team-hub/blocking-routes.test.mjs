// team-hub/blocking-routes.test.mjs
// ============================================================================
// F8 · `GET /api/tasks/:id/blocking`（设计稿 §8.3 / M10）
//
// 判据：
//   ① 正常任务：blocked=false、reason=null
//   ② hold 任务：reason='hold'
//   ③ 有未答问题：reason='question'
//   ④ 槽位：maxWorkers=1 且已有 1 个在跑、reserved_slots=1 ⇒ reason='slot'
//   ⑤ reason 恒为枚举值或 null（不允许自由文本，I-8.1）
//   ⑥ 只读：调用前后任务行不变（I-8.2）
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const get = async (path) => {
  const res = await fetch(`${base}${path}`, { agent: false })
  let body = null
  try { body = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body }
}
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', agent: false, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'general', ...body }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const mkTask = async (title = '阻塞宿主') => (await post('/api/create', { title })).body.task.id

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-blocking-'))
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

test('① 正常任务：blocked=false', async () => {
  const id = await mkTask()
  const r = await get(`/api/tasks/${id}/blocking`)
  assert.equal(r.status, 200)
  assert.equal(r.body.blocked, false)
  assert.equal(r.body.reason, null)
})

test('② hold ⇒ reason=hold', async () => {
  const id = await mkTask()
  mod.db.prepare('UPDATE tasks SET hold=1 WHERE id=?').run(id)
  const r = await get(`/api/tasks/${id}/blocking`)
  assert.equal(r.body.blocked, true)
  assert.equal(r.body.reason, 'hold')
})

test('③ 未答问题 ⇒ reason=question', async () => {
  const id = await mkTask()
  await post(`/api/tasks/${id}/report`, {
    reportId: `blk-${id}`, status: 'blocked', question: { body: '谁来决定？' },
  })
  const r = await get(`/api/tasks/${id}/blocking`)
  assert.equal(r.body.reason, 'question')
  assert.ok(r.body.blocker?.questionId)
})

test('④ 槽位用尽（maxWorkers=1、已有 1 个在跑、保留槽 1）⇒ reason=slot', async () => {
  const running = await mkTask('占槽任务')
  const queued = await mkTask('排队任务')
  mod.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(running)
  mod.db.prepare(`INSERT INTO space_runtime (scope, enabled, maxWorkers, isolate, reserved_slots)
    VALUES ('default',1,1,1,1) ON CONFLICT(scope) DO UPDATE SET maxWorkers=1, reserved_slots=1`).run()

  const r = await get(`/api/tasks/${queued}/blocking`)
  assert.equal(r.body.reason, 'slot')
  assert.equal(r.body.blocker.total, 1)
})

test('⑤ reason 恒为枚举值或 null（I-8.1）', async () => {
  const { BLOCKING_REASONS } = await import('./blocking.mjs')
  const id = await mkTask()
  const r = await get(`/api/tasks/${id}/blocking`)
  assert.ok(r.body.reason === null || BLOCKING_REASONS.includes(r.body.reason), `非法 reason: ${r.body.reason}`)
})

test('⑥ 只读（I-8.2）：调用前后任务行不变', async () => {
  const id = await mkTask()
  mod.db.prepare('UPDATE tasks SET hold=1 WHERE id=?').run(id)
  const before = mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
  await get(`/api/tasks/${id}/blocking`)
  const after = mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
  assert.deepEqual(after, before)
})

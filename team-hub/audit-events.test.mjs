// team-hub/audit-events.test.mjs
// ============================================================================
// F5 · 事件章由 `audit()` 统一盖（设计稿 §3 F5 接线点 / I-5.1）
//
// 为什么集中在 audit()：状态写入与事件追加必须同事务，而审计行本来就是那次写入的产物。
// 让每个路由各盖一遍，等于逼每个写点重复同样的判断——也一定会有人漏。
//
// 判据：
//   ① 迁移留下带 `event_id` 的审计行，**action 仍是 transition**（既有读取方不失配）
//   ② actor_kind / human 能区分人、将军、士兵（决定"能不能授权"）
//   ③ 同一事件重复盖章 ⇒ 忽略（不报错、不覆盖）
//   ④ 盖完之后对账一致（差异 0）
//   ⑤ 事件章失败不得让业务写入失败（事件是证据，不是前置条件）
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
const mkTask = async () => (await req('POST', '/api/create', { title: '事件章宿主', by: 'general' })).body.task.id

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-auditevents-'))
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

test('① 迁移盖章：event_id 有值，action 仍是 transition', async () => {
  const id = await mkTask()
  await req('POST', '/api/transition', { id, to: 'blocked', by: 'general' })

  const row = mod.db.prepare("SELECT action, event_id, actor_kind FROM audit WHERE taskId=? AND action='transition' ORDER BY seq DESC").get(id)
  assert.ok(row, '迁移必须留审计')
  assert.ok(row.event_id?.startsWith('ev-'), '★ 事件章要盖在审计行上')
  assert.equal(row.action, 'transition', '★ action 不被改写（既有读取方按它分派）')
  assert.equal(row.actor_kind, 'general')
})

test('② actor_kind / human 区分人、士兵', async () => {
  const id = await mkTask()
  await req('POST', '/api/transition', { id, to: 'blocked', by: 'general' })
  await req('POST', '/api/comment', { id, text: '一句评论', by: 'soldier-coder' })

  const general = mod.db.prepare("SELECT actor_kind, human FROM audit WHERE taskId=? AND action='transition' ORDER BY seq DESC").get(id)
  assert.equal(general.actor_kind, 'general')
  assert.equal(Number(general.human), 1, '将军是人 ⇒ 可授权')

  const soldier = mod.db.prepare("SELECT actor_kind, human, event_id FROM audit WHERE taskId=? AND action='comment' ORDER BY seq DESC").get(id)
  assert.equal(soldier.actor_kind, 'soldier')
  assert.equal(Number(soldier.human), 0, '★ 士兵不是"人"⇒ 不能替人授权')
  assert.ok(soldier.event_id, '评论也是可重放的事件')
})

test('③ 同一事件重复盖章 ⇒ 忽略，不新增行', async () => {
  const id = await mkTask()
  await req('POST', '/api/transition', { id, to: 'blocked', by: 'general' })
  const before = mod.db.prepare('SELECT COUNT(*) c FROM audit WHERE event_id IS NOT NULL').get().c

  const { stampEvent, eventIdFor } = await import('./event-log.mjs')
  const row = mod.db.prepare("SELECT seq, detail FROM audit WHERE taskId=? AND action='transition' ORDER BY seq DESC").get(id)
  const version = JSON.parse(row.detail)?.version ?? row.seq
  const again = stampEvent(mod.db, { seq: row.seq, kind: 'task_status', subject: `task:${id}`, version })

  assert.equal(again.duplicate, true)
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM audit WHERE event_id IS NOT NULL').get().c, before, '★ 不新增')
  assert.equal(eventIdFor({ kind: 'task_status', subject: `task:${id}`, version }), again.eventId)
})

test('④ 盖完章之后对账一致（差异 0）', async () => {
  const id = await mkTask()
  await req('POST', '/api/transition', { id, to: 'blocked', by: 'general' })
  await req('POST', '/api/transition', { id, to: 'todo', by: 'general' })

  const r = await req('GET', '/api/reconcile')
  const hit = r.body.mismatched.find((m) => m.taskId === id)
  assert.equal(hit, undefined, '★ 同事务写入的事件与状态必须对得上')
})

test('⑤ 事件章失败不影响业务写入（事件是证据，不是前置条件）', async () => {
  const id = await mkTask()
  // 把唯一索引拿掉再塞一条重复 event_id，模拟"盖章路径出了岔子"
  const { eventIdFor } = await import('./event-log.mjs')
  mod.db.exec('DROP INDEX IF EXISTS ux_audit_event')
  mod.db.prepare("INSERT INTO audit (ts, member, scope, action, taskId, detail, event_id) VALUES (?,?,?,?,?,?,?)")
    .run('2026-11-03T00:00:00.000Z', 'general', 'default', 'transition', id, JSON.stringify({ to: 'blocked' }),
      eventIdFor({ kind: 'task_status', subject: `task:${id}`, version: 1 }))

  const r = await req('POST', '/api/transition', { id, to: 'blocked', by: 'general' })
  assert.equal(r.status, 200, '★ 盖章冲突不能让迁移失败')
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'blocked')

  // 复原索引，避免影响同文件后续用例
  mod.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_event ON audit(event_id) WHERE event_id IS NOT NULL')
})

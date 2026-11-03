// team-hub/accept-mode.test.mjs
// ============================================================================
// F4 · 空间级受理模式（设计稿 §3 F4 / DEC-5）
//
// `accept_mode` 的真值在**空间设置**（space_runtime），任务上只留冗余快照便于审计。
// 三种模式的差别只在"推断受理能不能进队"：
//   auto   推断受理可以进
//   manual 只受理人明确要的（默认）
//   off    一律不受理
//
// 判据：
//   ① 空间默认 manual，任务迁移到 todo 时快照到 tasks.accept_mode
//   ② 空间设成 auto ⇒ 快照跟着变
//   ③ 未知 scope ⇒ 兜底 manual（不因为查不到就放开）
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
  dbDir = mkdtempSync(join(tmpdir(), 'legion-acceptmode-'))
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

const makeTaskOnTodo = async () => {
  const r = await req('POST', '/api/create', { title: '受理模式宿主', by: 'general' })
  const id = r.body.task.id
  await req('POST', '/api/transition', { id, to: 'blocked', by: 'general' })
  await req('POST', '/api/transition', { id, to: 'todo', by: 'general' })
  return id
}

test('① 空间默认 manual，迁移到 todo 时快照落盘', async () => {
  const id = await makeTaskOnTodo()
  const row = mod.db.prepare('SELECT accept_mode FROM tasks WHERE id=?').get(id)
  assert.equal(row.accept_mode, 'manual')
})

test('② 空间设成 auto ⇒ 快照跟着变', async () => {
  mod.db.prepare(`INSERT INTO space_runtime (scope, enabled, maxWorkers, isolate, accept_mode)
    VALUES ('default', 1, 2, 1, 'auto')
    ON CONFLICT(scope) DO UPDATE SET accept_mode='auto'`).run()

  const id = await makeTaskOnTodo()
  const row = mod.db.prepare('SELECT accept_mode FROM tasks WHERE id=?').get(id)
  assert.equal(row.accept_mode, 'auto', '★ 快照要与空间真值一致')
})

test('③ 没有空间行时兜底 manual（不因为查不到就放开）', async () => {
  mod.db.prepare("DELETE FROM space_runtime WHERE scope='default'").run()
  const id = await makeTaskOnTodo()
  assert.equal(mod.db.prepare('SELECT accept_mode FROM tasks WHERE id=?').get(id).accept_mode, 'manual')
})

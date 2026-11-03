// team-hub/task-input-routes.test.mjs
// ============================================================================
// F0 的**只读面**：`GET /api/tasks/:id/inputs` 与 `GET /api/reconcile/inputs`。
//
// 为什么这两个端点值得存在：
//   · 输入行已经是唯一真相（设计稿 §3 F0），但调用方（守护 / 看板 / 评估）
//     需要一个**稳定的读端口**，而不是各自去拼 task_input 的 SQL；
//   · 对账必须在 HTTP 面上可调用 —— 否则"列与行是否一致"只有写测试的人知道。
//
// 钉住的四件事：
//   ① 形状稳定（字段名与行表一一对应，snake → camel 只此一处）
//   ② 未知任务 404，不返回空数组冒充"存在但没输入"
//   ③ 默认隐藏 superseded，显式 `includeSuperseded=1` 才给
//   ④ 对账**只读**：发现不一致时不修复
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { supersedeInput } from './task-input.mjs'

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
const mkTask = async (title = '输入宿主') =>
  (await req('POST', '/api/create', { title, by: 'general' })).body.task.id
const note = (id, text) => req('POST', '/api/comment', { id, text, by: 'general' })

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-inputroutes-'))
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

test('① 输入列表：形状稳定、按时间排序、consumedAt 初值 null', async () => {
  const id = await mkTask()
  await note(id, '第一条')
  await note(id, '第二条')

  const r = await req('GET', `/api/tasks/${id}/inputs`)
  assert.equal(r.status, 200)
  assert.equal(r.body.taskId, id)
  assert.equal(r.body.count, 2)
  assert.deepEqual(r.body.inputs.map((i) => i.body), ['第一条', '第二条'])
  assert.deepEqual(
    Object.keys(r.body.inputs[0]).sort(),
    ['actor', 'actorKind', 'body', 'consumedAt', 'consumedBy', 'createdAt', 'id', 'kind', 'meta', 'superseded'],
    '★ 字段名固定，调用方不必猜行表的列名',
  )
  assert.equal(r.body.inputs[0].kind, 'comment')
  assert.equal(r.body.inputs[0].consumedAt, null)
  assert.equal(r.body.inputs[0].superseded, 0)
})

test('② 未知任务 404（不拿空数组冒充"存在但没输入"）', async () => {
  const r = await req('GET', '/api/tasks/T-nope/inputs')
  assert.equal(r.status, 404)
  assert.match(String(r.body?.error ?? ''), /任务|not.?found/i)
})

test('③ 默认隐藏 superseded，显式 includeSuperseded=1 才给', async () => {
  const id = await mkTask('被取代的输入')
  await note(id, '旧问题')
  await note(id, '新问题')
  const rows = mod.db.prepare('SELECT id FROM task_input WHERE task_id=? ORDER BY created_at, rowid').all(id)
  supersedeInput(mod.db, rows[0].id, { at: '2026-11-03T00:00:00.000Z' })

  const hidden = await req('GET', `/api/tasks/${id}/inputs`)
  assert.deepEqual(hidden.body.inputs.map((i) => i.body), ['新问题'])

  const all = await req('GET', `/api/tasks/${id}/inputs?includeSuperseded=1`)
  assert.deepEqual(all.body.inputs.map((i) => i.body), ['旧问题', '新问题'])
})

test('④ 任务隔离：两个任务的输入不混', async () => {
  const a = await mkTask('隔离 A')
  const b = await mkTask('隔离 B')
  await note(a, 'A 的话')
  await note(b, 'B 的话')

  const ra = await req('GET', `/api/tasks/${a}/inputs`)
  const rb = await req('GET', `/api/tasks/${b}/inputs`)
  assert.deepEqual(ra.body.inputs.map((i) => i.body), ['A 的话'])
  assert.deepEqual(rb.body.inputs.map((i) => i.body), ['B 的话'])
})

test('⑤ 对账：一致时为空；列被改坏时报出来，且**不自动修复**', async () => {
  const id = await mkTask('对账宿主')
  await note(id, '一条批注')

  const clean = await req('GET', '/api/reconcile/inputs')
  assert.equal(clean.status, 200)
  assert.deepEqual(clean.body.mismatched, [], '一致时不得有噪声')

  mod.db.prepare('UPDATE tasks SET comments=? WHERE id=?').run('[]', id)
  const dirty = await req('GET', '/api/reconcile/inputs')
  const hit = dirty.body.mismatched.find((m) => m.taskId === id)
  assert.ok(hit, '必须报出被改坏的那张任务')
  assert.equal(hit.field, 'comments')
  assert.equal(mod.db.prepare('SELECT comments FROM tasks WHERE id=?').get(id).comments, '[]',
    '★ 对账只读：修复会把错误固化')
})

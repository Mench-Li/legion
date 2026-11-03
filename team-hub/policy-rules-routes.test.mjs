// team-hub/policy-rules-routes.test.mjs
// ============================================================================
// F4 · 规则集 HTTP 面（设计稿 §3 F4 / M5）
//
// 判据：
//   ① GET 空库：rules=[]，version 形如 legion/policy@1.<指纹>
//   ② POST 新建 ⇒ created=true，version 变
//   ③ POST 同 id ⇒ created=false，数量不变
//   ④ 非法 kind ⇒ 422 + code
//   ⑤ GET ?enabled=1 过滤停用规则
//   ⑥ 变更写进审计（policy_changed），且**不改任何任务状态**（I-4.4）
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
  dbDir = mkdtempSync(join(tmpdir(), 'legion-policy-'))
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

test('① 空库：rules=[]，version 有指纹', async () => {
  const r = await req('GET', '/api/policy-rules')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.rules, [])
  assert.match(r.body.version, /^legion\/policy@1\.[0-9a-f]{8}$/)
})

test('② 新建 ⇒ created=true，version 变化', async () => {
  const before = (await req('GET', '/api/policy-rules')).body.version
  const r = await req('POST', '/api/policy-rules', { id: 'R-2', kind: 'always', text: '改动要带测试', by: 'general' })
  assert.equal(r.status, 200)
  assert.equal(r.body.created, true)
  assert.equal(r.body.rule.id, 'R-2')
  assert.notEqual(r.body.version, before, '★ 规则一变，版本就变')
})

test('③ 同 id 更新 ⇒ created=false，数量不变', async () => {
  await req('POST', '/api/policy-rules', { id: 'R-2', kind: 'always', text: '改动要带测试与证据', by: 'general' })
  const list = await req('GET', '/api/policy-rules')
  assert.equal(list.body.count, 1)
  assert.equal(list.body.rules[0].text, '改动要带测试与证据')
})

test('④ 非法 kind ⇒ 422 + code', async () => {
  const r = await req('POST', '/api/policy-rules', { id: 'R-9', kind: 'sometimes', text: 'x', by: 'general' })
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'POLICY_UNKNOWN_KIND')
})

test('⑤ ?enabled=1 过滤停用规则', async () => {
  await req('POST', '/api/policy-rules', { id: 'R-3', kind: 'never', text: '停用的一条', enabled: false, by: 'general' })
  const on = await req('GET', '/api/policy-rules?enabled=1')
  assert.deepEqual(on.body.rules.map((r) => r.id), ['R-2'])
  const all = await req('GET', '/api/policy-rules')
  assert.deepEqual(all.body.rules.map((r) => r.id).sort(), ['R-2', 'R-3'])
})

test('⑥ 变更写审计；不撤销在途任务（I-4.4）', async () => {
  const created = await req('POST', '/api/create', { title: '在途任务', by: 'general' })
  const taskId = created.body.task.id

  await req('POST', '/api/policy-rules', { id: 'R-4', kind: 'when', text: '另一条', by: 'general' })

  const audit = mod.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='policy_changed'").get().c
  assert.ok(audit >= 3, '★ 每次变更都留一条事件')
  const task = mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)
  assert.equal(task.status, 'backlog', '★ 规则变更不得动任务状态')
})

// team-hub/decisions-routes.test.mjs
// ============================================================================
// F4 · 台账的**可查性**（设计稿 §3 F4 / M5）
//
// 判据（都是"事后能不能答"）：
//   ① `GET /api/decisions` 返回落库的决策，`matched_rule_ids` 已解析成数组
//   ② 按 kind / wouldAccept 过滤
//   ③ `GET /api/tasks/:id/mandate` 未知任务 404；无授权时 mandate=null、versions=[]
//   ④ 有授权时返回当前版本；`all=1` 带上审计里的历史版本
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
const mkTask = async () => {
  const res = await fetch(`${base}/api/create`, {
    method: 'POST', agent: false, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '台账宿主', by: 'general' }),
  })
  return (await res.json()).task.id
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-decisions-'))
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

test('① 台账可查：matched_rule_ids 已解析成数组', async () => {
  const { recordDecision } = await import('./decisions.mjs')
  recordDecision(mod.db, { subject: 'task:T-x', kind: 'accept', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: ['R-2', 'R-5'] })

  const r = await get('/api/decisions')
  assert.equal(r.status, 200)
  const row = r.body.decisions.find((d) => d.subject === 'task:T-x')
  assert.ok(row, '必须能查到')
  assert.deepEqual(row.matched_rule_ids, ['R-2', 'R-5'], '★ 查询方不必自己再 JSON.parse')
})

test('② 过滤：kind 与 wouldAccept', async () => {
  const { recordDecision } = await import('./decisions.mjs')
  recordDecision(mod.db, { subject: 'task:T-y', kind: 'ignore', by: 'general', at: '2026-11-03T02:00:00.000Z', matchedRuleIds: [], wouldAccept: true, reason: '容量满' })

  const byKind = await get('/api/decisions?kind=ignore')
  assert.ok(byKind.body.decisions.every((d) => d.kind === 'ignore'))
  assert.ok(byKind.body.decisions.some((d) => d.subject === 'task:T-y'))

  const byWould = await get('/api/decisions?wouldAccept=1')
  assert.ok(byWould.body.decisions.every((d) => d.would_accept === 1))
})

test('③ 未知任务的授权查询 ⇒ 404', async () => {
  const r = await get('/api/tasks/T-nope/mandate')
  assert.equal(r.status, 404)
})

test('④ 无授权 ⇒ mandate=null、versions=[]', async () => {
  const id = await mkTask()
  const r = await get(`/api/tasks/${id}/mandate`)
  assert.equal(r.status, 200)
  assert.equal(r.body.mandate, null)
  assert.deepEqual(r.body.versions, [])
})

test('⑤ 有授权时返回当前版本；all=1 带上审计里的历史版本', async () => {
  const id = await mkTask()
  const { buildMandate } = await import('./mandate-policy.mjs')
  const v1 = buildMandate({ basisRuleIds: ['R-2'], scope: { fileDomain: ['team-hub/'], stages: ['coder'] }, grantedAt: '2026-11-03T00:00:00.000Z' })
  const v2 = buildMandate({ basisRuleIds: ['R-2'], scope: { fileDomain: ['team-hub/', 'scrum/'], stages: ['coder'] }, version: 2, supersedes: 1, grantedAt: '2026-11-03T03:00:00.000Z' })
  mod.db.prepare('UPDATE tasks SET mandate=? WHERE id=?').run(JSON.stringify(v2), id)
  mod.db.prepare('INSERT INTO audit (ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?)')
    .run('2026-11-03T03:00:00.000Z', 'general', 'default', 'mandate', id, JSON.stringify(v1))

  const plain = await get(`/api/tasks/${id}/mandate`)
  assert.equal(plain.body.mandate.version, 2)
  assert.deepEqual(plain.body.versions.map((v) => v.version), [2])

  const all = await get(`/api/tasks/${id}/mandate?all=1`)
  assert.deepEqual(all.body.versions.map((v) => v.version), [2, 1], '★ 版本链要能追溯')
})

test('⑥ 真的走一次 `→ todo`：授权与台账由状态迁移自己写（DEC-1）', async () => {
  const id = await mkTask()
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', agent: false, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'general', ...body }),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  // todo → blocked → todo：这条链不需要仓库绑定
  assert.equal((await post('/api/transition', { id, to: 'blocked' })).status, 200)
  assert.equal((await post('/api/transition', { id, to: 'todo' })).status, 200)

  const mandate = await get(`/api/tasks/${id}/mandate`)
  assert.ok(mandate.body.mandate, '★ 迁移到 todo 时就该留下授权')
  assert.equal(mandate.body.mandate.manual, true, '人放行的任务 = 人工受理')
  assert.equal(mandate.body.acceptMode, 'manual')

  const decisions = await get(`/api/decisions?subject=task:${id}`)
  assert.ok(decisions.body.decisions.length >= 1, '★ 台账要跟着写')
})

test('⑦ 对账接口：只读，一致时 ok=true', async () => {
  const r = await get('/api/reconcile')
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.checked, 'number')
  assert.deepEqual(r.body.mismatched, [], '没有事件就没有差异')
  assert.equal(r.body.ok, true)
})

test('⑧ 对账能报出"只写了一半"（事件说 in_progress，状态表还是 todo）', async () => {
  const id = await mkTask()
  // 手工造一条 task_status 事件，但不改状态表 —— 正是"只写一半"的形状
  const seq = mod.db.prepare("INSERT INTO audit (ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?)")
    .run('2026-11-03T05:00:00.000Z', 'soldier-coder', 'default', 'task_status', id, JSON.stringify({ to: 'in_progress' })).lastInsertRowid
  const { stampEvent } = await import('./event-log.mjs')
  stampEvent(mod.db, { seq: Number(seq), kind: 'task_status', subject: `task:${id}`, version: 1, actorKind: 'soldier', addressed: 'none', human: 0 })

  const r = await get(`/api/reconcile?scope=default`)
  const hit = r.body.mismatched.find((m) => m.taskId === id)
  assert.ok(hit, '★ 半截写入必须被查出来')
  assert.equal(hit.expected, 'in_progress')
  assert.equal(r.body.ok, false)
  // 只读：状态表不得被"修好"
  assert.notEqual(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'in_progress')
})

test('⑨ 周报六个数可出（只读出口）', async () => {
  const r = await get('/api/report/weekly')
  assert.equal(r.status, 200)
  const keys = Object.keys(r.body.metrics).sort()
  assert.deepEqual(keys, ['accepted', 'ignored', 'mandateMissingRatio', 'stopped', 'unavailable', 'wouldAccept'])
  for (const key of keys) assert.equal(typeof r.body.metrics[key], 'number', `${key} 必须是数`)
  assert.ok(r.body.support && typeof r.body.support.eventBacklog === 'number')
})

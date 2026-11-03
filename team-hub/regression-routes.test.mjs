// team-hub/regression-routes.test.mjs
// ============================================================================
// F9 · 回归用例 HTTP 面（设计稿 §8.4 / M7-2）
//
// 判据：
//   ① 空库：count=0，byState 三态齐全
//   ② 生成候选：由失败簇落 draft（同一个簇重复生成不翻倍）
//   ③ 晋升：人（general）可通过，草稿变 active
//   ④ 晋升：agent 被拒（I-9.1），且状态不变
//   ⑤ 列表可按 state 过滤
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
  dbDir = mkdtempSync(join(tmpdir(), 'legion-regression-'))
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

test('① 空库：count=0，三态齐全', async () => {
  const r = await req('GET', '/api/regression-cases')
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 0)
  assert.deepEqual(r.body.byState, { draft: 0, active: 0, retired: 0 })
})

test('② 生成候选：失败簇 → draft（重复生成不翻倍）', async () => {
  const { recordDecision } = await import('./decisions.mjs')
  recordDecision(mod.db, {
    subject: 'task:T-r1', kind: 'stop', by: 'general',
    at: '2026-11-03T00:00:00.000Z', matchedRuleIds: ['R-2'], reason: '越域 team-hub/routes/',
  })

  const first = await req('POST', '/api/regression-cases/candidates', { by: 'general', top: 5 })
  assert.equal(first.status, 200)
  assert.ok(first.body.drafts.length >= 1)
  assert.equal(first.body.drafts[0].state, 'draft', '★ 只能生成草稿')

  const second = await req('POST', '/api/regression-cases/candidates', { by: 'general', top: 5 })
  assert.equal(second.body.drafts[0].id, first.body.drafts[0].id, '★ 同簇同 id')
  const list = await req('GET', '/api/regression-cases')
  assert.equal(list.body.count, 1, '★ 不翻倍')
})

test('③ 晋升：人可通过，草稿变 active', async () => {
  const list = await req('GET', '/api/regression-cases?state=draft')
  const id = list.body.cases[0].id
  const r = await req('POST', `/api/regression-cases/${id}/promote`, { by: 'general' })
  assert.equal(r.status, 200)
  assert.equal(r.body.case.state, 'active')
  assert.equal(r.body.case.promoted_by, 'general')
})

test('④ 晋升：agent 被拒（I-9.1）', async () => {
  const { recordDecision } = await import('./decisions.mjs')
  recordDecision(mod.db, {
    subject: 'task:T-r2', kind: 'unavailable', by: 'general',
    at: '2026-11-03T01:00:00.000Z', matchedRuleIds: [], reason: '上游没就绪',
  })
  await req('POST', '/api/regression-cases/candidates', { by: 'general', top: 5 })
  const drafts = await req('GET', '/api/regression-cases?state=draft')
  const id = drafts.body.cases[0].id

  const r = await req('POST', `/api/regression-cases/${id}/promote`, { by: 'agent:coder' })
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'REGRESSION_HUMAN_REQUIRED')
  const still = await req('GET', '/api/regression-cases?state=draft')
  assert.ok(still.body.cases.some((c) => c.id === id), '★ 状态不变')
})

test('⑤ 列表按 state 过滤', async () => {
  const active = await req('GET', '/api/regression-cases?state=active')
  assert.ok(active.body.cases.every((c) => c.state === 'active'))
  assert.ok(active.body.cases.length >= 1)
})

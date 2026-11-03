// team-hub/shadow-report-routes.test.mjs
// ============================================================================
// F10 · `GET /api/shadow-report`（设计稿 §8.5 / M11）
//
// 判据：
//   ① 200：给出 n / same / flips / flipRate
//   ② 候选规则不存在 ⇒ 404（不给假的"零差异"）
//   ③ 只读（I-10.1）：decisions 与 tasks 计数不变
//   ④ 翻转率超阈值 ⇒ needsReview=true（I-10.2）
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

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-shadow-'))
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

test('① 200：给出 n / same / flips', async () => {
  await post('/api/policy-rules', { id: 'R-SH', kind: 'always', text: '候选：一切都要有依据' })
  const { recordDecision } = await import('./decisions.mjs')
  recordDecision(mod.db, {
    subject: 'task:T-sh1', kind: 'stop', by: 'general',
    at: '2026-11-03T00:00:00.000Z', matchedRuleIds: [], reason: 'MISSING_BASIS',
  })

  const r = await get('/api/shadow-report?candidateRuleId=R-SH')
  assert.equal(r.status, 200)
  assert.equal(r.body.n, 1)
  assert.equal(r.body.flipToAccept, 1)
  assert.equal(r.body.flips[0].subject, 'task:T-sh1')
})

test('② 候选规则不存在 ⇒ 404', async () => {
  const r = await get('/api/shadow-report?candidateRuleId=R-nope')
  assert.equal(r.status, 404)
  assert.equal(r.body.code, 'SHADOW_RULE_NOT_FOUND')
})

test('③ 只读（I-10.1）：decisions 与 tasks 计数不变', async () => {
  const before = {
    decisions: mod.db.prepare('SELECT COUNT(*) c FROM decisions').get().c,
    tasks: mod.db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
  }
  await get('/api/shadow-report?candidateRuleId=R-SH')
  const after = {
    decisions: mod.db.prepare('SELECT COUNT(*) c FROM decisions').get().c,
    tasks: mod.db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
  }
  assert.deepEqual(after, before)
})

test('④ 翻转率超阈值 ⇒ needsReview=true（I-10.2）', async () => {
  const r = await get('/api/shadow-report?candidateRuleId=R-SH&threshold=0.2')
  assert.equal(r.body.flipRate, 1)
  assert.equal(r.body.needsReview, true)
})

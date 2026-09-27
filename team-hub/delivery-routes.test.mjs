// team-hub/delivery-routes.test.mjs —— S4（R-4 · R-5 · R-6 HTTP 面）
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dir
const SHA = 'a'.repeat(40)

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'legion-t170-droutes-'))
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* noop */ }
  try { mod?.server?.close?.() } catch { /* noop */ }
  try { mod?.db?.close?.() } catch { /* noop */ }
  rmSync(dir, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), agent: false,
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
const post = (p, b) => call('POST', p, b)

test('TC-S4-07 创建交付（带门禁入队）→ ready；非法 targetRef/sourceCommit 400', async () => {
  const badRef = await post('/api/deliveries', { by: 'w', taskId: 'T-d1', sourceCommit: SHA, targetRef: 'main' })
  assert.equal(badRef.status, 400)
  assert.equal(badRef.body.code, 'INVALID_TARGET_REF')
  const badSha = await post('/api/deliveries', { by: 'w', taskId: 'T-d1', sourceCommit: 'not-a-sha', targetRef: 'refs/heads/main' })
  assert.equal(badSha.status, 400)
  const ok = await post('/api/deliveries', {
    by: 'w', taskId: 'T-d1', attemptId: 'A1', sourceCommit: SHA, baseCommit: 'b'.repeat(40), targetRef: 'refs/heads/main',
    gates: { finalDiffPaths: ['src/a.mjs'], fileDomain: ['src'], intentPaths: ['src/a.mjs'], acceptanceEvidence: { passed: true } },
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.delivery.state, 'ready')
})

test('TC-S4-08 权限负例：无裁决职责的岗位 403，且不落裁决', async () => {
  const d = await post('/api/deliveries', { by: 'w', taskId: 'T-d2', sourceCommit: 'c'.repeat(40), targetRef: 'refs/heads/main' })
  assert.equal(d.status, 200)
  const id = d.body.delivery.id
  const forbidden = await post('/api/deliveries/' + id + '/decision', { by: 'viewer', role: 'viewer', version: 1, decision: 'rework', reason: 'x' })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.body.code, 'FORBIDDEN')
  const got = await call('GET', '/api/deliveries/' + id)
  assert.equal(got.body.delivery.state, 'awaiting-acceptance', '403 不得改变交付状态')
  assert.equal(got.body.delivery.decisionId, null)
})

test('TC-S4-09 并发裁决：同一 version 的第二页 409 且内容不落库', async () => {
  const d = await post('/api/deliveries', { by: 'w', taskId: 'T-d3', sourceCommit: 'd'.repeat(40), targetRef: 'refs/heads/main' })
  const id = d.body.delivery.id
  const first = await post('/api/deliveries/' + id + '/decision', { by: 'general', role: 'general', version: 1, decision: 'rework', reason: '先改' })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.delivery.state, 'ready')
  const decisionId = first.body.decisionId
  const second = await post('/api/deliveries/' + id + '/decision', { by: 'general', role: 'general', version: 1, decision: 'abandon', reason: '后到' })
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'VERSION_CONFLICT')
  assert.equal(second.body.currentVersion, 2)
  const got = await call('GET', '/api/deliveries/' + id)
  assert.equal(got.body.delivery.decisionId, decisionId, '过期页面的裁决不得覆盖已生效裁决')
  assert.equal(got.body.delivery.state, 'ready')
  assert.ok(!JSON.stringify(got.body).includes('后到'), '过期内容不得持久化')
})

test('TC-S4-10 同仓库同 ref 至多一个活跃集成 job；epoch fencing', async () => {
  const d1 = await post('/api/deliveries', { by: 'w', taskId: 'T-d4', sourceCommit: 'e'.repeat(40), targetRef: 'refs/heads/main' })
  const d2 = await post('/api/deliveries', { by: 'w', taskId: 'T-d5', sourceCommit: 'f'.repeat(40), targetRef: 'refs/heads/main' })
  const c1 = await post('/api/integration/claim', { by: 'w1', repoId: 'repo-x', targetRef: 'refs/heads/main', deliveryId: d1.body.delivery.id, expectedHead: '1'.repeat(40), leaseEpoch: 1 })
  assert.equal(c1.status, 200, JSON.stringify(c1.body))
  assert.equal(c1.body.job.state, 'leased')
  const c2 = await post('/api/integration/claim', { by: 'w2', repoId: 'repo-x', targetRef: 'refs/heads/main', deliveryId: d2.body.delivery.id, expectedHead: '1'.repeat(40), leaseEpoch: 1 })
  assert.equal(c2.status, 409)
  assert.equal(c2.body.code, 'JOB_CONTENTION')
  assert.equal(c2.body.holder.deliveryId, d1.body.delivery.id)
  const stale = await post('/api/integration/transition', { by: 'w1', jobId: c1.body.job.id, leaseEpoch: 99, to: 'applying', phase: 'applying' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'EPOCH_STALE')
  const good = await post('/api/integration/transition', { by: 'w1', jobId: c1.body.job.id, leaseEpoch: 1, to: 'applying', phase: 'applying' })
  assert.equal(good.status, 200)
  assert.equal(good.body.job.journalPhase, 'applying')
})

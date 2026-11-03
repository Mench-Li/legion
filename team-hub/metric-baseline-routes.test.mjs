// team-hub/metric-baseline-routes.test.mjs
// ============================================================================
// F11 · 基线的 HTTP 写入口（补齐"设定 → 退化 → 拦 → 更新 → 放行"闭环）
//
// 之前只有模块与检查 CLI，没有 HTTP 写入口 ⇒ 演练只能验一半。这里补上，并钉住：
//   ① 人能写（200），`set_by` 记到人
//   ② agent / system 写 ⇒ 422（I-11.1：不能给自己判卷）
//   ③ 未知指标 ⇒ 422
//   ④ GET 能读回（演练与看板要看得到当前基线）
//   ⑤ 写完基线后，同样的指标再算一次就能被判退化（闭环）
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
  dbDir = mkdtempSync(join(tmpdir(), 'legion-baseline-'))
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

test('① 人能写基线', async () => {
  const r = await req('POST', '/api/metric-baseline', { by: 'general', metric: 'mandateMissingRatio', scope: 'default', value: 0 })
  assert.equal(r.status, 200)
  assert.equal(r.body.baseline.metric, 'mandateMissingRatio')
  assert.equal(r.body.baseline.value, 0)
  assert.equal(r.body.baseline.set_by, 'general')
})

test('② agent / system 写 ⇒ 422（I-11.1）', async () => {
  for (const by of ['agent:coder', 'system']) {
    const r = await req('POST', '/api/metric-baseline', { by, metric: 'accepted', scope: 'default', value: 99 })
    assert.equal(r.status, 422, `${by} 不该能改及格线`)
    assert.equal(r.body.code, 'BASELINE_HUMAN_REQUIRED')
  }
})

test('③ 未知指标 ⇒ 422', async () => {
  const r = await req('POST', '/api/metric-baseline', { by: 'general', metric: 'vibes', value: 1 })
  assert.equal(r.status, 422)
  assert.equal(r.body.code, 'BASELINE_UNKNOWN_METRIC')
})

test('④ GET 能读回当前基线', async () => {
  const r = await req('GET', '/api/metric-baseline?scope=default')
  assert.equal(r.status, 200)
  const hit = r.body.baselines.find((b) => b.metric === 'mandateMissingRatio')
  assert.ok(hit, '刚写的基线要能读回')
  assert.equal(hit.value, 0)
})

test('⑤ 闭环：写入基线后，指标变差即被判退化', async () => {
  const { recordDecision } = await import('./decisions.mjs')
  // 让 mandateMissingRatio 变差：在途任务里有 1 条没有 mandate
  mod.db.prepare("INSERT INTO tasks (id, title, status, scope, updatedAt) VALUES ('T-nomandate','无授权任务','todo','default','2026-11-03T00:00:00.000Z')").run()
  recordDecision(mod.db, { subject: 'task:T-nomandate', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: ['R-2'] })

  const weekly = await req('GET', '/api/report/weekly')
  assert.ok(weekly.body.metrics.mandateMissingRatio > 0, '缺授权比例应 > 0')

  const { ensureBaselineSchema, checkGate } = await import('./regression-gate.mjs')
  ensureBaselineSchema(mod.db)
  const gate = checkGate(mod.db, { metrics: weekly.body.metrics, scope: 'default' })
  assert.equal(gate.ok, false, '★ 基线 0 → 当前 > 0，应当被拦')
  assert.ok(gate.violations.some((v) => v.metric === 'mandateMissingRatio'))
})

// team-hub/read-open-loopback.test.mjs — P2-2 回环模式不回退回归（HTTP 级）。
//
// 模拟「本地回环 + 已配 token」开发部署：TEAM_HUB_HOST=127.0.0.1 / TEAM_HUB_TOKEN=tk-loop-1。
// 断言：读面保持开放（读/SSE/config 无 token 均 200），写面仍按 token 门禁（无 token 401），
// OPTIONS 放行、未知路径 404 —— 证明 P2-2 只影响远程监听，本地开发体验不回退。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'hub-loopauth-'))
process.env.TEAM_HUB_HOST = '127.0.0.1'
process.env.TEAM_HUB_TOKEN = 'tk-loop-1'
process.env.TEAM_HUB_DB = join(TMP, 'hub.db')

const mod = await import('./server.mjs')

let server = null
let base = ''

before(async () => {
  server = mod.server
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  base = 'http://127.0.0.1:' + server.address().port
})

after(() => {
  try { mod.db?.close() } catch { /* 已关闭 */ }
  try { if (server) server.close() } catch { /* 已关闭 */ }
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('team-hub 本地回环 + 已配 token：读面不回退、写面仍门禁', () => {
  it('GET /api/board 无 token → 200（读开放）', async () => {
    const res = await fetch(base + '/api/board')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(await res.json()))
  })

  it('SSE GET /api/events 无 token → 200 text/event-stream（读开放）', async () => {
    const res = await fetch(base + '/api/events')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    await res.body?.cancel()
  })

  it('GET /api/config 无 token → 200 且 auth:true', async () => {
    const res = await fetch(base + '/api/config')
    assert.equal(res.status, 200)
    const cfg = await res.json()
    assert.equal(cfg.auth, true)
  })

  it('POST 写接口无 token → 401（写面 token 门禁不因回环放宽）', async () => {
    const res = await fetch(base + '/api/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', by: 'general' }),
    })
    assert.equal(res.status, 401)
  })

  it('POST 写接口带 token 且参数合法 → 200（回环部署仍可正常写入）', async () => {
    const res = await fetch(base + '/api/create', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer tk-loop-1' },
      body: JSON.stringify({ title: '回环任务', by: 'general' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.task.title, '回环任务')
  })

  it('OPTIONS 预检 204；未知路径 → 404（无门禁语义）', async () => {
    assert.equal((await fetch(base + '/api/board', { method: 'OPTIONS' })).status, 204)
    assert.equal((await fetch(base + '/api/no-such')).status, 404)
  })
})

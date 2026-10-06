// team-hub/read-auth.test.mjs — P2-2 远程监听读面鉴权门禁（HTTP 级矩阵）。
//
// 模拟「非回环监听 + 已配 token」部署：TEAM_HUB_HOST=0.0.0.0 / TEAM_HUB_TOKEN=tk-remote-1
// （必须在 import server.mjs 之前设置，模块顶部读取）。与 security.test.mjs（纯函数决策）
// 互补：本文件验证门禁在真实 HTTP 面上生效——读/SSE/写统一 401、config 能力探测放行、
// 两种 token 携带方式（Bearer / x-dsh-token）可读；**查询串里的令牌不再接受**
// （SSE 改用一次性票据 `?ticket=`，见 remote-auth.mjs 的 QUERY_TICKET_PATHS）。
// 运行：node --test team-hub/read-auth.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get as httpGet } from 'node:http'

const TMP = mkdtempSync(join(tmpdir(), 'hub-readauth-'))
process.env.TEAM_HUB_HOST = '0.0.0.0' // 模拟远程监听（LAN/公网绑定）
process.env.TEAM_HUB_TOKEN = 'tk-remote-1'
process.env.TEAM_HUB_DB = join(TMP, 'hub.db')

const mod = await import('./server.mjs')
const TK = 'tk-remote-1'

async function getJson(path, token) {
  const headers = token !== undefined ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(base + path, { headers })
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, ct: res.headers.get('content-type'), data }
}

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

describe('team-hub 远程监听读面鉴权（TEAM_HUB_HOST=0.0.0.0 + token）', () => {
  it('GET /api/board：无 token → 401；错误 token → 401；正确 token → 200', async () => {
    const anon = await getJson('/api/board')
    assert.equal(anon.status, 401)
    assert.match(anon.data.error, /未授权/)
    const bad = await getJson('/api/board', 'wrong-token')
    assert.equal(bad.status, 401)
    const ok = await getJson('/api/board', TK)
    assert.equal(ok.status, 200)
    assert.ok(Array.isArray(ok.data))
  })

  it('读接口只认头：Bearer / x-dsh-token；★ 查询串里的令牌**不再**接受', async () => {
    const header = await fetch(base + '/api/board', { headers: { 'x-dsh-token': TK } })
    assert.equal(header.status, 200)
    // 查询串会进访问日志/浏览器历史/Referer。原来这里收 `?token=`（注释写的理由是
    // "供 EventSource 等无法自定 header 的读订阅"），而那个理由现在由**一次性票据**
    // 承担（见 remote-auth.mjs 的 QUERY_TICKET_PATHS）——票据只用一次、只活 60 秒、
    // 只对订阅有效，而令牌是 15 分钟、覆盖全部 API。
    const query = await fetch(base + '/api/board?scope=default&token=' + TK)
    assert.equal(query.status, 401, '查询串里的令牌必须不再放行')
  })

  it('GET /api/activity：审计读同样受门禁（无 token 401）', async () => {
    const anon = await getJson('/api/activity')
    assert.equal(anon.status, 401)
    const ok = await getJson('/api/activity?limit=5', TK)
    assert.equal(ok.status, 200)
    assert.ok(Array.isArray(ok.data))
  })

  it('GET /api/config：能力探测放行（无 token 200，auth:true）', async () => {
    const r = await getJson('/api/config')
    assert.equal(r.status, 200)
    assert.equal(r.data.auth, true)
  })

  it('SSE GET /api/events：无凭据 → 401；头里带机器令牌 → 200 text/event-stream', async () => {
    const anonRes = await fetch(base + '/api/events')
    assert.equal(anonRes.status, 401)
    // 用**请求头**（浏览器里的 EventSource 做不到，所以它走一次性票据；
    // 而这个用例验的是服务端本身接不接受头里的机器令牌）。
    const status = await new Promise((resolve, reject) => {
      const req = httpGet(base + '/api/events', { headers: { authorization: `Bearer ${TK}` } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.setTimeout(5000, () => { req.destroy(new Error('sse timeout')) })
    })
    assert.equal(status, 200)
  })

  it('POST 写接口：无 token → 401（既有写面不回退）；带 token 且缺 by → 400', async () => {
    const anon = await fetch(base + '/api/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    })
    assert.equal(anon.status, 401)
    const noBy = await fetch(base + '/api/create', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${TK}` },
      body: JSON.stringify({ title: 'x' }),
    })
    assert.equal(noBy.status, 400)
    assert.match((await noBy.json()).error, /缺少操作者身份 by/)
  })

  it('OPTIONS 预检放行（204，含 x-dsh-token allow-headers）', async () => {
    const res = await fetch(base + '/api/board', { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /x-dsh-token/)
  })

  it('未知路径：无 token → 401（不泄露端点存在性）；带 token → 404', async () => {
    assert.equal((await getJson('/api/no-such')).status, 401)
    assert.equal((await getJson('/api/no-such', TK)).status, 404)
  })
})

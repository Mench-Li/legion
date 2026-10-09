// workbench/scripts/dsh-models-connect.test.mjs
// ============================================================================
// BUG-014 第二层（凭证）：「供应商与模型」在地址修对之后拿到的是 **401**，
// 因为宿主 `/api/*` 只认它**自己的浏览器会话**，而桥接层转发的是浏览器自己的 cookie
// ——普通浏览器里没有那条 cookie。
//
// 修法（设计 A，将军 2026-10-09 裁决）：**让用户的浏览器登一次**。
//   · 宿主进程里的 legion-services 从 `ctx.connection.authenticatedUrl()` 铸出带 `?token=`
//     的操作员登录 URL，注入 `DSH_MODELS_LOGIN_URL`（services-plugin 侧另有判据）；
//   · 指挥台暴露 `GET /api/dsh-models/connect`：**302** 把浏览器顶层导航到那条 URL，
//     宿主随即种下会话 cookie（cookie 按主机存放、不按端口隔离 ⇒ 同一浏览器的
//     `:5173` 与 `:19387` 共享它）。
//
// 这一组守四件事，每一条都是"错了不会报错、只会继续 401"的类型：
//   ① 有登录 URL ⇒ 302 + Location 原样带上令牌；
//   ② 302 必须带 no-store / no-referrer（带令牌的 URL 不许被缓存或随 Referer 泄漏）；
//   ③ 宿主没注入 ⇒ **503 且说得清**（"这是凭证缺、不是地址错"），不许回一个空 Location；
//   ④ 配了 token 时，这条路由**必须**要求 Bearer —— 它发出去的是一个操作员凭证。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOGIN = 'http://127.0.0.1:19387/?token=OP-TOKEN-abc123'

/** 以给定配置在进程内起 serve.mjs（isMain 守卫保证不自动占端口）。 */
async function startServe({ loginUrl, token }) {
  process.env.DSH_MODELS_LOGIN_URL = loginUrl
  process.env.DSH_WORKBENCH_TOKEN = token
  const mod = await import(pathToFileURL(join(HERE, 'serve.mjs')).href + `?connect=${encodeURIComponent(loginUrl)}|${token}`)
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  return { server: mod.server, port: mod.server.address().port }
}

/** 发一个**不自动跟随重定向**的请求，拿原始状态行与响应头。 */
function raw(port, { method = 'GET', path = '/api/dsh-models/connect', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('BUG-014 第二层：让浏览器登一次（顶层导航到宿主登录 URL）', () => {
  let withUrl = null
  let withoutUrl = null
  let withToken = null
  let withUrlPort = 0
  let withoutUrlPort = 0
  let withTokenPort = 0

  before(async () => {
    withUrl = await startServe({ loginUrl: LOGIN, token: '' })
    withUrlPort = withUrl.port
    withoutUrl = await startServe({ loginUrl: '', token: '' })
    withoutUrlPort = withoutUrl.port
    withToken = await startServe({ loginUrl: LOGIN, token: 'SECRET-W' })
    withTokenPort = withToken.port
  })

  after(() => {
    for (const s of [withUrl, withoutUrl, withToken]) { try { s.server.close() } catch { /* ignore */ } }
    delete process.env.DSH_MODELS_LOGIN_URL
    delete process.env.DSH_WORKBENCH_TOKEN
  })

  it('① 有登录地址 ⇒ 302，Location 原样带上令牌（顶层导航才能种下 cookie）', async () => {
    const res = await raw(withUrlPort, { headers: { origin: `http://127.0.0.1:${withUrlPort}` } })
    assert.equal(res.status, 302, `期望 302，实测 ${res.status} ${res.body.slice(0, 160)}`)
    assert.equal(res.headers.location, LOGIN, 'Location 必须是宿主那条带 token 的 URL，且一字不改')
    assert.match(res.headers.location, /token=OP-TOKEN-abc123/, '令牌必须在里面 —— 没有它浏览器只会到宿主的 401 页')
  })

  it('② 302 必须 no-store + no-referrer（带令牌的 URL 不许被缓存或随 Referer 泄漏）', async () => {
    const res = await raw(withUrlPort, { headers: { origin: `http://127.0.0.1:${withUrlPort}` } })
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
  })

  it('③ 宿主没注入 ⇒ 503 且明说"这是凭证缺、不是地址错"，绝不回空 Location', async () => {
    const res = await raw(withoutUrlPort, { headers: { origin: `http://127.0.0.1:${withoutUrlPort}` } })
    assert.equal(res.status, 503)
    assert.equal(res.headers.location, undefined, '不许用一个空的 Location 把浏览器送去错误的地方')
    assert.match(decodeURIComponent(res.body), /登录地址/, '必须点名缺的是登录地址')
    assert.match(decodeURIComponent(res.body), /凭证|地址错/, '必须把"重试也不会好"说清楚')
  })

  it('④ 配了 token ⇒ 这条路由必须要求 Bearer（它发出去的是一个操作员凭证）', async () => {
    const denied = await raw(withTokenPort, { headers: { origin: `http://127.0.0.1:${withTokenPort}` } })
    assert.equal(denied.status, 401, '没有 Bearer 不许把登录 URL 交出去')
    assert.equal(denied.headers.location, undefined, '被拒的响应不许带 Location')
    const allowed = await raw(withTokenPort, {
      headers: { origin: `http://127.0.0.1:${withTokenPort}`, authorization: 'Bearer SECRET-W' },
    })
    assert.equal(allowed.status, 302)
    assert.equal(allowed.headers.location, LOGIN)
  })

  it('⑤ 非 GET 不许（这条路由是"把人送过去"，不是通用入口）', async () => {
    const res = await raw(withUrlPort, { method: 'POST', headers: { origin: `http://127.0.0.1:${withUrlPort}` } })
    assert.equal(res.status, 405)
  })

  it('⑥ 跨源不许（与 /api/dsh-models 同一道同源闸门）', async () => {
    const res = await raw(withUrlPort, { headers: { origin: 'http://evil.example' } })
    assert.equal(res.status, 403)
    assert.equal(res.headers.location, undefined)
  })
})

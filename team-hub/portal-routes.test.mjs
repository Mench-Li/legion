// team-hub/portal-routes.test.mjs
// Hub 的门口（`GET /`）。守的是"**第一次**打开这个地址的人看到什么"。
//
// 在这之前，把刚部署好的地址发给人，他看到的是
// `{"error":"缺少访问令牌","code":"REMOTE_AUTH_MISSING"}` ——
// 一句对机器说的话，没告诉他这是什么、能做什么、该去哪儿。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPortalRoutes, renderPortal } from './routes/portal.mjs'

/** 用假的 req/res 走一次真实 dispatch。 */
async function fetchPortal(routes, { method = 'GET', path = '/' } = {}) {
  const chunks = []
  const headers = {}
  const res = {
    writeHead(status, h) { this.status = status; Object.assign(headers, h) },
    end(body) { if (body !== undefined) chunks.push(Buffer.from(body)) },
  }
  const handled = await routes.dispatch({ method, url: path }, res, { path })
  return { handled, status: res.status, headers, body: Buffer.concat(chunks).toString('utf8') }
}

// ── 内容 ────────────────────────────────────────────────────────────────────

test('它说得出自己是什么，并给出手机端入口', () => {
  const html = renderPortal({ registration: 'open' })
  assert.match(html, /Legion/)
  assert.match(html, /Agent/)
  // 手机端是主入口（账号体系与看板都在那儿）。
  assert.match(html, /href="\/mobile\/"/)
})

test('下载地址留空时**如实说尚未发布**，不给一个点开 404 的假链接', () => {
  // 一个假的下载按钮比没有按钮更坏：用户会以为是自己网络或浏览器的问题，
  // 然后反复试。
  const html = renderPortal({ downloadUrl: '' })
  assert.match(html, /尚未发布/)
  assert.doesNotMatch(html, /<a[^>]+href="[^"]*"[^>]*>\s*<strong>下载电脑版/)
})

test('配了下载地址就出链接，并带上版本号', () => {
  const html = renderPortal({ downloadUrl: 'https://dl.example.com/legion.exe', version: '1.2.3' })
  assert.match(html, /href="https:\/\/dl\.example\.com\/legion\.exe"/)
  assert.match(html, /v1\.2\.3/)
  assert.doesNotMatch(html, /尚未发布/)
})

test('注册策略如实写在门口：closed 与 open 的措辞不同', () => {
  assert.match(renderPortal({ registration: 'closed' }), /未开放自助注册/)
  assert.match(renderPortal({ registration: 'open' }), /开放注册/)
  // invite 模式要提"需要邀请码"，否则用户会以为没码也能注册。
  const invite = renderPortal({ registration: 'invite' })
  assert.match(invite, /开放注册/)
  assert.match(invite, /邀请码/)
})

test('所有插值都转义：配置里的引号与标签不会变成注入', () => {
  // 本页所有插值都来自配置，而配置是可以被写坏的。门口贴的牌子不该能执行东西。
  const html = renderPortal({ downloadUrl: 'https://x/" onload="alert(1)', version: '<script>bad()</script>' })
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/)
  assert.doesNotMatch(html, /" onload="alert\(1\)/)
  assert.match(html, /&quot;|&lt;/)
})

test('**不**把任何用户/空间数据念出来（门口不是数据面）', () => {
  const html = renderPortal({ registration: 'open', version: '9.9.9' })
  // 只应有名字、一句话、三个入口与策略说明；没有用户名、没有空间名、
  // 没有任务或设备读数。
  for (const forbidden of ['legion', 'default', 'hub_users', '设备在线']) {
    if (forbidden === 'legion') continue // 产品名里本来就有
    assert.doesNotMatch(html, new RegExp(forbidden), `门口不该出现「${forbidden}」`)
  }
})

// ── 路由行为 ────────────────────────────────────────────────────────────────

test('GET / 返回 HTML，且不缓存（配置改了要立刻看到）', async () => {
  const routes = createPortalRoutes({ registration: 'open' })
  const r = await fetchPortal(routes)
  assert.equal(r.handled, true)
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.match(r.body, /Legion/)
})

test('HEAD 有同样的头但没有正文', async () => {
  const routes = createPortalRoutes({})
  const r = await fetchPortal(routes, { method: 'HEAD' })
  assert.equal(r.status, 200)
  assert.equal(r.body, '')
  assert.ok(Number(r.headers['content-length']) > 0, 'content-length 仍应给出真实长度')
})

test('其它路径与方法不由本族接管（否则会把 API 全吞掉）', async () => {
  const routes = createPortalRoutes({})
  assert.equal((await fetchPortal(routes, { path: '/api/board' })).handled, false)
  assert.equal((await fetchPortal(routes, { path: '/mobile/' })).handled, false)
  assert.equal((await fetchPortal(routes, { method: 'POST', path: '/' })).handled, false)
})

// ── 发布之后，门口页必须立刻改口 ─────────────────────────────────────────────
//
// 2026-10-07 实测的事故：往发布目录里传了一份新版本，首页**仍然**指向上一版 ——
// 因为整页 HTML 是在**服务启动时**渲染成常量的，"最新的一份"被冻在了那一刻。
// 重启之后就对了，而"要重启"这件事没有任何一处写得出来：
// 症状是"发了新版，用户下到的还是旧版"，**没有一个地方会报错**。

test('★ 建路由之后再发一份新的：页面**当次请求**就改口（无需重启）', async () => {
  let url = '/legion/releases/r-2026-10-06_0.1.0/Legion-Setup-win-x64.exe'
  const routes = createPortalRoutes({ downloadUrl: () => url, registration: 'open' })

  const before = await fetchPortal(routes)
  assert.match(before.body, /r-2026-10-06_0\.1\.0/, '前提：建路由时指向旧版')

  // 运营者上传了一份新的（`latestInstaller` 按 mtime 取最新，这里直接模拟它的返回值）
  url = '/legion/releases/r-2026-10-07_0.1.0/Legion-Setup-win-x64.exe'

  const after = await fetchPortal(routes)
  assert.match(after.body, /r-2026-10-07_0\.1\.0/, '换了之后必须立刻改口')
  assert.doesNotMatch(after.body, /r-2026-10-06_0\.1\.0/, '旧版不该还留在页面上')
})

test('★ 函数返回空串 = 尚未发布：如实说没发布，不给假链接', async () => {
  // 发布目录被清空 / 还没有任何发布时，`latestInstaller` 返回 null，
  // server.mjs 把它转成空串 —— 这条路也要走通，不能残留上一次的链接。
  let url = '/legion/releases/r-2026-10-06_0.1.0/Legion-Setup-win-x64.exe'
  const routes = createPortalRoutes({ downloadUrl: () => url })
  assert.match((await fetchPortal(routes)).body, /r-2026-10-06/)
  url = ''
  const r = await fetchPortal(routes)
  assert.match(r.body, /尚未发布/)
  assert.doesNotMatch(r.body, /r-2026-10-06/, '发布没了，旧链接也必须跟着消失')
})

test('传字符串仍然照旧（显式配置那条路不变）', async () => {
  const routes = createPortalRoutes({ downloadUrl: 'https://example.test/a.exe' })
  assert.match((await fetchPortal(routes)).body, /https:\/\/example\.test\/a\.exe/)
})

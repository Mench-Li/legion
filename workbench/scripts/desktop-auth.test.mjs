import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'

test('desktop Workbench protects reads, writes, Host, Origin and proxy credentials', async () => {
  const upstream = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer private-hub-token') { res.writeHead(401); res.end(); return }
    res.setHeader('content-type', 'application/json'); res.end('{"port":8787}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  process.env.LEGION_DESKTOP_MODE = '1'
  process.env.DSH_WORKBENCH_TOKEN = 'private-desktop-token'
  process.env.TEAM_HUB_TOKEN = 'private-hub-token'
  process.env.DSH_HUB_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
  const { server } = await import('./serve.mjs?desktop-auth')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: 'Bearer private-desktop-token', origin: base }
  try {
    assert.equal((await fetch(`${base}/api/fs/home`)).status, 401)
    assert.equal((await fetch(`${base}/api/fs/inspect`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401)
    const badHost = await new Promise(resolve => {
      const req = request(`${base}/api/fs/home`, { headers: { ...headers, host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode) })
      req.end()
    })
    assert.equal(badHost, 403)
    assert.equal((await fetch(`${base}/api/fs/home`, { headers: { ...headers, origin: 'https://evil.test' } })).status, 403)
    assert.equal((await fetch(`${base}/api/fs/home`, { headers })).status, 200)
    assert.equal((await fetch(`${base}/hub/api/config`, { headers })).status, 200)
    const navigate = site => new Promise((accept, reject) => {
      const req = request(`${base}/`, { headers: {
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': site,
      } }, res => { res.resume(); res.once('end', () => accept(res.headers['set-cookie']?.[0]?.split(';')[0])) })
      req.on('error', reject); req.end()
    })
    const cookie = await navigate('none')
    assert.ok(cookie, 'direct browser navigation must establish its own session')
    assert.equal((await fetch(`${base}/api/fs/home`, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${base}/hub/api/config`, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${base}/api/fs/home`, { headers: { cookie, origin: 'https://evil.test' } })).status, 403)
    assert.equal(await navigate('cross-site'), undefined)
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    for (const key of ['LEGION_DESKTOP_MODE', 'DSH_WORKBENCH_TOKEN', 'TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) delete process.env[key]
  }
})

// ★★ 非 desktop 部署：中转的 `/hub` 代理也必须带上中枢的机器令牌。
//
// 实测路径（2026-10-10）：为了手机远程访问给中枢设了 token ⇒ **桌面面板当场读不出任何数据**，
// 因为 `/hub` 代理只在 desktopMode 下才附 `Authorization`，而本机 `desktopMode=false`。
// 表面上"两边各自都对"：中枢做了它该做的鉴权，代理在它的分支里也做了它该做的转发。
//
//   > 一个"配了令牌才能远程访问"的开关，
//   > 与一个"一配令牌就把本地面板弄坏"的开关，是同一个开关。
test('non-desktop Workbench still forwards the hub machine token through /hub', async () => {
  const upstream = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer private-hub-token') { res.writeHead(401); res.end(); return }
    res.setHeader('content-type', 'application/json'); res.end('{"port":8787}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  // ★ desktopMode **不开**（就是本机现状），但中枢配了令牌
  process.env.TEAM_HUB_TOKEN = 'private-hub-token'
  process.env.DSH_HUB_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
  const { server } = await import('./serve.mjs?non-desktop-hub-auth')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const r = await fetch(`${base}/hub/api/config`)
    assert.equal(r.status, 200,
      '★ 代理必须自己附上中枢令牌 —— 否则"给中枢设了 token"会让面板静默读不出数据')
    // 浏览器带了一把**别的**令牌（比如 workbench 自己的）时，以代理知道的中枢令牌为准
    const wrong = await fetch(`${base}/hub/api/config`, { headers: { authorization: 'Bearer some-other-token' } })
    assert.equal(wrong.status, 200, '调用方带的不是中枢令牌时，代理仍应换成中枢令牌（两者不是同一个东西）')
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    for (const key of ['TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) delete process.env[key]
  }
})

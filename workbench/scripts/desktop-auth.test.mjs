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

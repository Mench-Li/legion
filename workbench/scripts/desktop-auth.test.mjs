import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// ★★ 非 desktop 部署：中转的 `/hub` 代理也必须能让**未登录**的本机调用方工作。
//
// 实测路径（2026-10-10）：为了手机远程访问给中枢设了 token ⇒ **桌面面板当场读不出任何数据**，
// 因为 `/hub` 代理只在 desktopMode 下才附 `Authorization`，而本机 `desktopMode=false`。
//
//   > 一个"配了令牌才能远程访问"的开关，
//   > 与一个"一配令牌就把本地面板弄坏"的开关，是同一个开关。
test('non-desktop Workbench forwards the hub machine token for unauthenticated callers', async () => {
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
      '★ 未登录的本机调用方也要能用 —— 否则"给中枢设了 token"会让面板静默读不出数据')
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    for (const key of ['TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) delete process.env[key]
  }
})

// ★★★ 优先级：**用户会话 > 机器令牌**。代理不许把已登录的人降级成机器。
//
// 这一条是补出来的，因为上一版把规则写反了 —— 我让代理"始终"附上机器令牌，于是它**覆盖**了
// 浏览器带来的用户访问令牌：中枢把机器令牌当用户令牌去解，回 `IDENTITY_TOKEN_MALFORMED`，
// 前端启动时那次 `/hub/api/identity/me` 就此失败 ⇒ **整个页面卡在登录门**。
// 实测（同一个令牌、同一条路径）：直连中枢 200、走代理 401。
//
//   > 一个"替调用方决定它该用哪个身份"的代理，
//   > 与一个"把用户令牌换成机器令牌"的代理，区别只在有没有人登录过——
//   > 而那恰好是最难复现的那种坏。
test('hub proxy never overwrites a caller-supplied Authorization (user session wins)', async () => {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '(none)')
    // 造一个"只认用户令牌"的上游：与中枢的身份端点同形（机器令牌会被它当成坏令牌）
    if (req.headers.authorization === 'Bearer user-access-token') {
      res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return
    }
    res.writeHead(401); res.end('{"code":"IDENTITY_TOKEN_MALFORMED"}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  process.env.TEAM_HUB_TOKEN = 'private-hub-token'
  process.env.DSH_HUB_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
  const { server } = await import('./serve.mjs?hub-auth-precedence')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const withUser = await fetch(`${base}/hub/api/identity/me`, { headers: { authorization: 'Bearer user-access-token' } })
    assert.equal(withUser.status, 200, '★ 用户令牌必须**原样透传**（被换成机器令牌 ⇒ 页面卡在登录门）')
    assert.equal(seen.at(-1), 'Bearer user-access-token', '上游收到的就是调用方那把令牌')

    await fetch(`${base}/hub/api/config`)
    assert.equal(seen.at(-1), 'Bearer private-hub-token', '★ 没有 Authorization 时才轮到机器令牌兜底')
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    for (const key of ['TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) delete process.env[key]
  }
})

// ★★★ 第三条规则：调用方带的是 **workbench 自己的令牌**时，必须**换成**中枢令牌。
//
// 那把令牌是**本服务**的凭据（`DSH_WORKBENCH_TOKEN`），对中枢毫无意义 —— 原样透传会让中枢 401。
// 它与"用户访问令牌"长得一样（都是 `Bearer …`），所以判据只能靠**值与 workbench 自己的令牌相等**。
// 这一条是原有用例（desktop 模式）在暴露的：我一开始写成"调用方带了就一律透传"，它立刻红了。
test('hub proxy replaces the *workbench* credential with the hub machine token', async () => {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '(none)')
    if (req.headers.authorization === 'Bearer private-hub-token') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return }
    res.writeHead(401); res.end('{}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  process.env.LEGION_DESKTOP_MODE = '1'
  process.env.DSH_WORKBENCH_TOKEN = 'private-desktop-token'
  process.env.TEAM_HUB_TOKEN = 'private-hub-token'
  process.env.DSH_HUB_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
  const { server } = await import('./serve.mjs?hub-auth-workbench-credential')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const r = await fetch(`${base}/hub/api/config`, { headers: { authorization: 'Bearer private-desktop-token', origin: base } })
    assert.equal(r.status, 200, '★ workbench 自己的令牌对中枢无效，代理要把它换成中枢令牌')
    assert.equal(seen.at(-1), 'Bearer private-hub-token', '上游收到的必须是中枢令牌')
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
    for (const key of ['LEGION_DESKTOP_MODE', 'DSH_WORKBENCH_TOKEN', 'TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) delete process.env[key]
  }
})

// ★★★★ 第四条规则：文件中心那条**内部**调用也要带令牌。
//
// 「scope → 空间 local_dir」走的是**中枢直连**（`GET /api/spaces`），不是 `/hub` 代理，
// 所以上面三条规矩一条都替它兜不住底：代理替调用方附令牌，直连不会。
// 漏掉令牌的症状与"中枢没启动"**逐字相同**——都是那句 `无法从 team-hub 读取工作空间列表（HTTP 401）`，
// 而正确的修法一个在凭证、一个在进程，方向相反。
//
// 实测（2026-10，中枢启用远程门禁 `LEGION_REMOTE_AUTH=1` 后）：`/api/files/*` 全部 400，
// 界面提示"请先启动中枢"，而中枢一直在跑（进程在、`/api/config` 200）——排障被这句错话带偏。
test('file-center scope resolution sends the hub machine token to /api/spaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-spaces-auth-'))
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '(none)')
    if (String(req.url ?? '').startsWith('/api/spaces')) {
      // 与真实中枢同形：远程门禁没拿到令牌 → 401 + `REMOTE_AUTH_MISSING`（不是 404、也不是空列表）
      if (req.headers.authorization !== 'Bearer private-hub-token') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"缺少访问令牌","code":"REMOTE_AUTH_MISSING"}')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ spaces: [{ id: 'fx', name: '夹具空间', private: false, localDir: root }] }))
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  process.env.DSH_HUB_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
  delete process.env.DSH_WORKBENCH_SPACES_JSON // 强制走中枢（注入 JSON 是测试捷径，不是被测路径）
  try {
    // ① 没有机器令牌：必须报"凭证被拒"，且**不许**再把它说成"中枢没启动"
    delete process.env.TEAM_HUB_TOKEN
    const noToken = await import('./serve.mjs?spaces-no-token')
    await assert.rejects(() => noToken.resolveScopeLocalDir('fx'), (e) => {
      assert.match(e.message, /HTTP 401/)
      assert.match(e.message, /TEAM_HUB_TOKEN/, '缺令牌时要说清是凭证问题')
      assert.doesNotMatch(e.message, /请先启动中枢/, '★ 中枢在跑却被报成没启动，就是这次事故本身')
      return true
    })

    // ② 有机器令牌：解析出该空间的 local_dir，且上游确实收到了这把令牌
    seen.length = 0
    process.env.TEAM_HUB_TOKEN = 'private-hub-token'
    const withToken = await import('./serve.mjs?spaces-with-token')
    assert.equal(await withToken.resolveScopeLocalDir('fx'), realpathSync(root))
    assert.equal(seen.at(-1), 'Bearer private-hub-token', '★ 直连中枢的读接口必须自己带机器令牌')
  } finally {
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    rmSync(root, { recursive: true, force: true })
    for (const key of ['TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) delete process.env[key]
  }
})

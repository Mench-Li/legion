// team-hub/workbench-routes.test.mjs
// ============================================================================
// 桌面工作台交给 Hub 托管之后的两件事：
//   ① 静态资源（路径安全 / 缓存头 / **裸挂载点重定向**）；
//   ② `/hub/*` 前缀改写 —— 工作台前端打的是 `/hub/api/…`。
//
// ② 是这一族**最容易假绿**的地方：静态页面能打开、看起来一切正常，
// 而每一次 API 调用都 404，界面表现为"连不上中枢"。所以它必须在**真实的
// server.mjs** 上验证，而不是对着一个不认识 `/hub` 的替身。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWorkbenchRoutes } from './routes/workbench.mjs'

const DIST = fileURLToPath(new URL('../workbench/dist', import.meta.url))
const HAS_DIST = existsSync(join(DIST, 'index.html'))

async function serveWith(root, mount = '/workbench') {
  const family = createWorkbenchRoutes({ root, mount })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    family.dispatch(req, res, { path: url.pathname, url }).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('unhandled') }
    }).catch(() => { res.writeHead(500); res.end('boom') })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
  }
}

// ── ① 静态资源 ─────────────────────────────────────────────────────────────

test('真实产物：入口、脚本、样式、图标都能取到且类型正确', { skip: !HAS_DIST && 'workbench/dist 尚未构建' }, async () => {
  const s = await serveWith(DIST)
  try {
    const html = await (await fetch(s.base + '/workbench/')).text()
    // 从入口里**读出**资源名，而不是猜 —— 带内容哈希的名字每次构建都变。
    const js = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
    const css = html.match(/href="\.\/(assets\/[^"]+\.css)"/)?.[1]
    assert.ok(js, `入口里应当有一个相对路径的 script，实际：${html.slice(0, 200)}`)
    assert.ok(css, '入口里应当有一个相对路径的 stylesheet')

    for (const [path, type] of [
      ['/workbench/', 'text/html'],
      ['/workbench/index.html', 'text/html'],
      [`/workbench/${js}`, 'text/javascript'],
      [`/workbench/${css}`, 'text/css'],
      ['/workbench/legion-icon.png', 'image/png'],
    ]) {
      const res = await fetch(s.base + path)
      assert.equal(res.status, 200, `${path} 应 200`)
      assert.ok(res.headers.get('content-type').startsWith(type),
        `${path} 类型应为 ${type}，实际 ${res.headers.get('content-type')}`)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.ok((await res.arrayBuffer()).byteLength > 0, `${path} 不应为空`)
    }
  } finally { await s.close() }
})

test('★★★ 产品的资源引用必须是**相对**的（一份产物两个宿主的前提）', { skip: !HAS_DIST && 'dist 未构建' }, () => {
  // ★ 这条是"同一份 dist 既能挂 `/`（serve.mjs）又能挂 `/workbench/`（Hub）"的
  //   全部依据。一旦有人把 vite 的 `base` 改回绝对路径，Hub 那份还能用，
  //   **而本地/桌面端那份会白屏** —— 那是一个只有真的在本机打开才会发现的回归。
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  assert.doesNotMatch(html, /(?:src|href)="\/[^"]*\.(?:js|css|png)"/,
    `入口里出现了根绝对路径的资源引用，两个宿主就不能共用一份产物了：${html.slice(0, 300)}`)
  assert.match(html, /src="\.\/assets\//, '入口的 script 应当是相对路径')
})

test('★ 入口不缓存、带哈希的资源永久缓存、图标一天', { skip: !HAS_DIST && 'dist 未构建' }, async () => {
  const s = await serveWith(DIST)
  try {
    const html = await fetch(s.base + '/workbench/index.html')
    // ★ `no-store` 是必须的：缓存了入口会让"更新了但浏览器还是旧的"
    //   变成一个需要清缓存才能解决的问题。
    assert.equal(html.headers.get('cache-control'), 'no-store')

    const body = await (await fetch(s.base + '/workbench/')).text()
    const js = body.match(/src="\.\/(assets\/[^"]+\.js)"/)[1]
    const asset = await fetch(`${s.base}/workbench/${js}`)
    // 带内容哈希 ⇒ 改内容就换文件名 ⇒ 可以永久缓存。
    assert.match(asset.headers.get('cache-control'), /max-age=31536000.*immutable/)

    const icon = await fetch(s.base + '/workbench/legion-icon.png')
    assert.match(icon.headers.get('cache-control'), /max-age=86400/)
  } finally { await s.close() }
})

test('★★★ 裸挂载点 /workbench 必须 301 到 /workbench/', async () => {
  // ★ 实测过的坑：`/mobile` 返回 200 且不重定向，而页面里是 `./app.mjs`，
  //   浏览器在无尾斜杠的路径下会把它解析成 `/app.mjs` ——
  //   **页面加载出来但资源全 404**。
  //   工作台用相对 base（见上面那条），踩的是同一个坑。
  const s = await serveWith(DIST)
  try {
    const res = await fetch(s.base + '/workbench', { redirect: 'manual' })
    assert.equal(res.status, 301, '裸挂载点必须重定向，否则页面里的相对引用会解析到根上')
    assert.equal(res.headers.get('location'), '/workbench/')
    await res.arrayBuffer()
  } finally { await s.close() }
})

test('★ HEAD 返回同样的头但没有正文', { skip: !HAS_DIST && 'dist 未构建' }, async () => {
  const s = await serveWith(DIST)
  try {
    const res = await fetch(s.base + '/workbench/index.html', { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.ok(Number(res.headers.get('content-length')) > 0)
    assert.equal((await res.arrayBuffer()).byteLength, 0)
  } finally { await s.close() }
})

test('★★ sourcemap 与私密文件一律 404（白名单不含 .map）', async () => {
  // `.map` 被**刻意**排除：产物默认不带 sourcemap，而万一带上了，
  // 公开出去等于把源码随静态托管一起发布。
  const dir = mkdtempSync(join(tmpdir(), 'legion-wb-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<html>ok</html>')
    writeFileSync(join(dir, 'app.js.map'), '{"sources":["../src/App.tsx"]}')
    writeFileSync(join(dir, 'secret.key'), 'PRIVATE')
    writeFileSync(join(dir, '.env'), 'TOKEN=abc')
    writeFileSync(join(dir, 'config.json'), '{}')
    const s = await serveWith(dir)
    try {
      assert.equal((await fetch(s.base + '/workbench/index.html')).status, 200)
      assert.equal((await fetch(s.base + '/workbench/app.js.map')).status, 404, '.map 不该被发出去')
      assert.equal((await fetch(s.base + '/workbench/secret.key')).status, 404)
      assert.equal((await fetch(s.base + '/workbench/.env')).status, 404)
    } finally { await s.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★★ 目录穿越被拦下（含编码形式与**前缀相同**的兄弟目录）', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'legion-wb-'))
  const dir = join(parent, 'workbench')
  mkdirSync(dir)
  writeFileSync(join(dir, 'index.html'), '<html>ok</html>')
  writeFileSync(join(parent, 'outside.html'), 'OUTSIDE')
  // 与根目录**前缀相同**的兄弟目录：只按字符串前缀比会误放行它。
  mkdirSync(join(parent, 'workbench-evil'))
  writeFileSync(join(parent, 'workbench-evil', 'x.html'), 'EVIL')
  const s = await serveWith(dir)
  try {
    for (const attempt of [
      '/workbench/../outside.html',
      '/workbench/%2e%2e/outside.html',
      '/workbench/..%2foutside.html',
      '/workbench/../workbench-evil/x.html',
    ]) {
      const res = await fetch(s.base + attempt, { redirect: 'manual' })
      const body = await res.text()
      assert.notEqual(body, 'OUTSIDE', `${attempt} 不应读到根外文件`)
      assert.notEqual(body, 'EVIL', `${attempt} 不应读到前缀相同的兄弟目录`)
      assert.ok(res.status === 403 || res.status === 404, `${attempt} 应 403/404，实际 ${res.status}`)
    }
    const nul = await fetch(`${s.base}/workbench/index.html%00.png`)
    assert.ok([400, 404].includes(nul.status))
  } finally { await s.close() }
})

test('★ 挂载前缀之外的路径不由本族接管', async () => {
  const family = createWorkbenchRoutes({ root: DIST })
  const res = { writeHead: () => {}, end: () => {} }
  const calls = []
  for (const path of ['/api/board', '/workbenchish/x', '/mobile/x', '/', '/workbenchx']) {
    const handled = await family.dispatch({ method: 'GET', url: path, headers: {} }, res, { path, url: new URL(path, 'http://x') })
    calls.push([path, handled])
  }
  // `/workbenchish/x` 不该被吃掉——把前缀比较写成 `startsWith('/workbench')` 就会误吞。
  assert.deepEqual(calls, [
    ['/api/board', false], ['/workbenchish/x', false], ['/mobile/x', false], ['/', false], ['/workbenchx', false],
  ])
})

test('★ 非 GET/HEAD 方法不由本族接管', async () => {
  const family = createWorkbenchRoutes({ root: DIST })
  const handled = await family.dispatch(
    { method: 'POST', url: '/workbench/x', headers: {} }, {},
    { path: '/workbench/x', url: new URL('http://x/workbench/x') },
  )
  assert.equal(handled, false)
})

test('★ 自定义挂载点可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-wb-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<html>ok</html>')
    const s = await serveWith(dir, '/app')
    try {
      assert.equal((await fetch(s.base + '/app/index.html')).status, 200)
      assert.equal((await fetch(s.base + '/workbench/index.html')).status, 404)
    } finally { await s.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ② `/hub/*` 前缀改写（对着**真实 server.mjs**）───────────────────────────
//
// 工作台前端（`workbench/src/api.ts` 的 `hubBase()`）默认打到 `/hub`。
// 本地由 `serve.mjs` 反代；交给 Hub 托管之后那层代理不在，必须由中枢自己接住。

let mod
let base
let dbDir

const call = async (path) => {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' })
  let payload = null
  try { payload = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, body: payload }
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-wbroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  process.env.TEAM_HUB_TOKEN = 'workbench-routes-token'
  process.env.LEGION_REMOTE_AUTH = '1'
  // ★ **必须设**：身份面（`/api/identity/*`）与远程门禁这两族、以及门口页路由，
  //   都只在身份密钥存在时才注册。不设它们的话，本文件会"验证"一堆 404 ——
  //   而那是**没开门**，不是"改写没生效"。实测踩到：不设时 `/hub/api/identity/status`
  //   与 `/hub` 都是 404，看起来像是前缀改写坏了。
  process.env.LEGION_IDENTITY_KEY = 'workbench-routes-identity-key-0123456789'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('★★★ /hub/api/config 与 /api/config 返回**同一份**能力发现', async () => {
  // 改写正确的判据：两条路径给出同一个 body。只断言"200"是不够的 ——
  // 通用 404 之外还有别的路径也可能 200，而**内容不同**就说明没接对。
  const direct = await call('/api/config')
  const viaHub = await call('/hub/api/config')
  assert.equal(direct.status, 200, '/api/config 应当免鉴权可达')
  assert.equal(viaHub.status, 200, '/hub/api/config 必须被改写到中枢自己的 /api/config')
  assert.deepEqual(viaHub.body, direct.body, '两条路径必须给出同一份能力发现')
})

test('★★ 工作台的登录门探测点经 /hub 可达（否则页面永远卡在登录门）', async () => {
  const r = await call('/hub/api/identity/status')
  assert.equal(r.status, 200, '/api/identity/status 在公开名单里，经 /hub 也必须可达')
  assert.equal(r.body?.ok, true)
  assert.equal(typeof r.body?.remoteAuthRequired, 'boolean')
})

test('★★ 未知路径经 /hub 仍然 401（门禁按改写后的路径判）', async () => {
  // 改写若发生在门禁**之后**，`/hub/api/<未知>` 就会绕过门禁。
  // 这条钉住顺序：门禁看到的是 `/api/…`，于是与直接访问同样处置。
  const viaHub = await call('/hub/api/definitely-not-a-route')
  assert.equal(viaHub.status, 401, `应当由门禁拦下（401），实际 ${viaHub.status}`)
})

test('★ /hub（裸）改写到 /，落到门口页而不是 404', async () => {
  const res = await fetch(`${base}/hub`, { redirect: 'manual' })
  await res.arrayBuffer()
  assert.ok([200, 301, 302].includes(res.status), `/hub 应落到门口页，实际 ${res.status}`)
})

test('★ 前缀改写不吞掉别的命名空间', async () => {
  // `/hubbish` 不该被当成 `/hub` 的前缀。
  const res = await fetch(`${base}/hubbish/x`, { redirect: 'manual' })
  await res.arrayBuffer()
  assert.ok([401, 404].includes(res.status), `实际 ${res.status}`)
})

// team-hub/mobile-routes.test.mjs
// 远程 Agent 通道 S-F：手机端静态资源的**路径安全**与缓存头。
//
// 重点不是"能取到文件"，而是"取不到不该取的文件"。一个只能服务正确路径、
// 但能被穿越到目录外的静态服务，比没有静态服务更糟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMobileRoutes } from './routes/mobile.mjs'

const MIGRATED = fileURLToPath(new URL('../workbench/mobile', import.meta.url))

async function serveWith(root, mount = '/mobile') {
  const family = createMobileRoutes({ root, mount })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const ctx = { path: url.pathname, url }
    family.dispatch(req, res, ctx).then((handled) => {
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

test('真实 PWA 目录：入口、脚本、manifest、图标都能取到且类型正确', async () => {
  const s = await serveWith(MIGRATED)
  try {
    const cases = [
      ['/mobile/', 'text/html', '.html'],
      ['/mobile/index.html', 'text/html', '.html'],
      ['/mobile/app.mjs', 'text/javascript', '.mjs'],
      ['/mobile/timeline.mjs', 'text/javascript', '.mjs'],
      ['/mobile/sw.js', 'text/javascript', '.js'],
      ['/mobile/manifest.webmanifest', 'application/manifest+json', '.webmanifest'],
      ['/mobile/icon-192.png', 'image/png', '.png'],
    ]
    for (const [path, type] of cases) {
      const res = await fetch(s.base + path)
      assert.equal(res.status, 200, `${path} 应 200`)
      assert.ok(res.headers.get('content-type').startsWith(type), `${path} 类型应为 ${type}，实际 ${res.headers.get('content-type')}`)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      const body = await res.arrayBuffer()
      assert.ok(body.byteLength > 0, `${path} 不应为空`)
    }
  } finally { await s.close() }
})

test('入口与脚本不缓存，图标可缓存（发新版后手机能拿到新代码）', async () => {
  const s = await serveWith(MIGRATED)
  try {
    const html = await fetch(s.base + '/mobile/index.html')
    // ★ `no-store` 是必须的：缓存了 index.html 会让"更新了但手机上还是旧的"
    //   变成一个需要清缓存才能解决的问题。
    assert.equal(html.headers.get('cache-control'), 'no-store')
    const sw = await fetch(s.base + '/mobile/sw.js')
    assert.equal(sw.headers.get('cache-control'), 'no-store')
    const icon = await fetch(s.base + '/mobile/icon-192.png')
    assert.match(icon.headers.get('cache-control'), /max-age=86400/)
  } finally { await s.close() }
})

test('Service-Worker-Allowed 指向挂载点（否则 SW 的 scope 会被限制在自己的目录）', async () => {
  const s = await serveWith(MIGRATED)
  try {
    const res = await fetch(s.base + '/mobile/sw.js')
    assert.equal(res.headers.get('service-worker-allowed'), '/mobile/')
  } finally { await s.close() }
})

test('HEAD 返回同样的头但没有正文', async () => {
  const s = await serveWith(MIGRATED)
  try {
    const res = await fetch(s.base + '/mobile/app.mjs', { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.ok(Number(res.headers.get('content-length')) > 0)
    assert.equal((await res.arrayBuffer()).byteLength, 0)
  } finally { await s.close() }
})

test('白名单外的扩展名一律 404（黑名单会漏，白名单不会）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-mobile-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<html>ok</html>')
    writeFileSync(join(dir, 'secret.key'), 'PRIVATE')
    writeFileSync(join(dir, '.env'), 'TOKEN=abc')
    writeFileSync(join(dir, 'config.json'), '{}')
    const s = await serveWith(dir)
    try {
      assert.equal((await fetch(s.base + '/mobile/index.html')).status, 200)
      // `.json` 在 MIME 表里（为 manifest 之类留着），但 `.key` / `.env` 不在。
      assert.equal((await fetch(s.base + '/mobile/secret.key')).status, 404)
      assert.equal((await fetch(s.base + '/mobile/.env')).status, 404)
    } finally { await s.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('目录穿越被拦下（含编码形式与符号前缀）', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'legion-mobile-'))
  const dir = join(parent, 'mobile')
  mkdirSync(dir)
  writeFileSync(join(dir, 'index.html'), '<html>ok</html>')
  writeFileSync(join(parent, 'outside.html'), 'OUTSIDE')
  // 与根目录**前缀相同**的兄弟目录：只按字符串前缀比会误放行它。
  mkdirSync(join(parent, 'mobile-evil'))
  writeFileSync(join(parent, 'mobile-evil', 'x.html'), 'EVIL')
  const s = await serveWith(dir)
  try {
    for (const attempt of [
      '/mobile/../outside.html',
      '/mobile/%2e%2e/outside.html',
      '/mobile/..%2foutside.html',
      '/mobile/../mobile-evil/x.html',
    ]) {
      const res = await fetch(s.base + attempt, { redirect: 'manual' })
      const body = await res.text()
      assert.notEqual(body, 'OUTSIDE', `${attempt} 不应读到根外文件`)
      assert.notEqual(body, 'EVIL', `${attempt} 不应读到前缀相同的兄弟目录`)
      assert.ok(res.status === 403 || res.status === 404, `${attempt} 应 403/404，实际 ${res.status}`)
    }
    // 空字节
    const nul = await fetch(`${s.base}/mobile/index.html%00.png`)
    assert.ok([400, 404].includes(nul.status))
  } finally { await s.close() }
})

test('挂载前缀之外的路径不由本族接管（返回未处理）', async () => {
  const family = createMobileRoutes({ root: MIGRATED })
  const calls = []
  const res = { writeHead: () => {}, end: () => {} }
  for (const path of ['/api/board', '/mobileish/x', '/']) {
    const handled = await family.dispatch({ method: 'GET', url: path, headers: {} }, res, { path, url: new URL(path, 'http://x') })
    calls.push([path, handled])
  }
  // `/mobileish/x` 与 `/api/board` 都不该被本族吃掉——把前缀比较写成
  // `startsWith('/mobile')` 就会把前者误吞。
  assert.deepEqual(calls, [['/api/board', false], ['/mobileish/x', false], ['/', false]])
})

test('非 GET/HEAD 方法不由本族接管', async () => {
  const family = createMobileRoutes({ root: MIGRATED })
  const handled = await family.dispatch({ method: 'POST', url: '/mobile/x', headers: {} }, {}, { path: '/mobile/x', url: new URL('http://x/mobile/x') })
  assert.equal(handled, false)
})

test('自定义挂载点可用', async () => {
  const s = await serveWith(MIGRATED, '/pwa')
  try {
    assert.equal((await fetch(s.base + '/pwa/index.html')).status, 200)
    assert.equal((await fetch(s.base + '/mobile/index.html')).status, 404)
  } finally { await s.close() }
})

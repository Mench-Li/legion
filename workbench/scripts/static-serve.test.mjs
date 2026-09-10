// static-serve.test.mjs — 静态托管契约（serve.mjs 的 SPA 入口/404 分支）。
//
// 回归来源：P3-1 验证时在**新建 worktree**（未跑 vite build，无 dist/）里跑 CI smoke，
// chat-s2-smoke 的 S2-A 报 `fetch failed`——真实原因是静态处理器**先发 200 头再读文件**，
// 读失败时头已发出只能 destroy()，客户端看到「连接被意外关闭」而不是可读原因。
// 现要求：产物缺失 → 404 + 可行动指引（提示先 vite build），绝不发 200 再断流。
//
// 用 DSH_WORKBENCH_ROOT 指向临时目录来构造「有产物 / 无产物」两种静态根（不依赖真实 dist）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let emptyRoot = ''
let builtRoot = ''
let serveEmpty = null
let serveBuilt = null
let emptyPort = 0
let builtPort = 0

/** 以指定静态根在进程内起 serve.mjs 真路由（isMain 守卫保证不自动占端口） */
async function startWithRoot(root) {
  process.env.DSH_WORKBENCH_ROOT = root
  const mod = await import(pathToFileURL(join(HERE, 'serve.mjs')).href + '?root=' + encodeURIComponent(root))
  const server = mod.server
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

describe('静态托管：产物缺失时给出可读 404（回归：曾 200 后断流）', () => {
  before(async () => {
    emptyRoot = mkdtempSync(join(tmpdir(), 'wb-static-empty-'))
    builtRoot = mkdtempSync(join(tmpdir(), 'wb-static-built-'))
    mkdirSync(join(builtRoot, 'assets'), { recursive: true })
    writeFileSync(join(builtRoot, 'index.html'), '<!doctype html><html><body><div id="app">built</div></body></html>')
    writeFileSync(join(builtRoot, 'assets', 'index-abc.js'), 'console.log("built asset")')
    const a = await startWithRoot(emptyRoot)
    serveEmpty = a.server
    emptyPort = a.port
    const b = await startWithRoot(builtRoot)
    serveBuilt = b.server
    builtPort = b.port
  })

  after(async () => {
    for (const s of [serveEmpty, serveBuilt]) {
      try { if (s && s.listening) s.close() } catch { /* */ }
    }
    delete process.env.DSH_WORKBENCH_ROOT
    for (const d of [emptyRoot, builtRoot]) {
      try { if (d) rmSync(d, { recursive: true, force: true }) } catch { /* */ }
    }
  })

  it('无产物：GET / → 404 且说明「请先 vite build」（而不是连接被断开）', async () => {
    const r = await fetch(`http://127.0.0.1:${emptyPort}/`)
    assert.equal(r.status, 404, '不得以 200 + 断流替代（客户端会看到 fetch failed）')
    const body = await r.text()
    assert.match(body, /vite build/, `错误体应给出可行动指引，实际：${body.slice(0, 200)}`)
    assert.match(body, /前端产物缺失/)
  })

  it('无产物：GET /index.html 与缺失资源同样是 404（不发 200 再断流）', async () => {
    for (const p of ['/index.html', '/assets/index-abc.js']) {
      const r = await fetch(`http://127.0.0.1:${emptyPort}${p}`)
      assert.equal(r.status, 404, `${p} 应为 404`)
      await r.text()
    }
  })

  it('无产物：进程存活且 API 路由仍可用（静态缺失不拖垮整个服务）', async () => {
    const r = await fetch(`http://127.0.0.1:${emptyPort}/api/web/meta`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(typeof body.ok, 'boolean')
  })

  it('有产物：GET / 与 /index.html → 200 html，资源按 MIME 返回', async () => {
    const root = await fetch(`http://127.0.0.1:${builtPort}/`)
    assert.equal(root.status, 200)
    assert.match(root.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await root.text(), /id="app"/)

    const asset = await fetch(`http://127.0.0.1:${builtPort}/assets/index-abc.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /javascript/)
    assert.match(await asset.text(), /built asset/)
  })

  it('有产物：未知路径回落 SPA 入口（既有行为，锁定不回归）', async () => {
    const r = await fetch(`http://127.0.0.1:${builtPort}/some/spa/route`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /id="app"/)
  })

  it('路径穿越被拦（编码式 403；明文式由 URL 解析归一化，均不泄露根外文件）', async () => {
    // 必须用**原始请求**：fetch/undici 会在客户端把 /../ 归一化掉，测不到服务端校验。
    const raw = (rawPath) => new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: builtPort, path: rawPath, method: 'GET' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', () => resolve({ status: 0, body: '' }))
      req.end()
    })

    // ① 编码式穿越绕过 URL 解析的归一化 → 必须由 file.startsWith(ROOT) 拦下
    const encoded = await raw('/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd')
    assert.equal(encoded.status, 403, `编码式穿越应被 403 拦下，实际 ${encoded.status}`)

    // ② 明文穿越会被服务端 URL 解析归一化（落到 ROOT 内），安全属性是「绝不泄露根外内容」
    const plain = await raw('/../../../etc/passwd')
    assert.ok(plain.status === 200 || plain.status === 404, `明文穿越应被归一化处理，实际 ${plain.status}`)
    assert.ok(!/root:.*:0:0:/.test(plain.body), `响应不得包含根外文件内容：${plain.body.slice(0, 120)}`)
    assert.ok(!plain.body.includes('/bin/bash'), '响应不得包含 /etc/passwd 内容')

    // ③ 双重编码（%252e）不得被二次解码成穿越
    const doubleEncoded = await raw('/%252e%252e%252f%252e%252e%252fetc/passwd')
    assert.ok(!/root:.*:0:0:/.test(doubleEncoded.body), '双重编码不得泄露根外文件')
  })
})

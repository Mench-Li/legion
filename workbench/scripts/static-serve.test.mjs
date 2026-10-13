// static-serve.test.mjs — 静态托管契约（serve.mjs 的 SPA 入口/404 分支/资源与导航的区分）。
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

// 纯判定函数直接静态导入（与下面的 `startWithRoot` 动态导入互不影响：模块级副作用只有配置解析）。
const { staticRequestKind } = await import(pathToFileURL(join(HERE, 'serve.mjs')).href + '?kind=1')

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
    // 非 `.html`、也不在 `/assets/` 下 ⇒ 走"一天"那一档（三档策略的第③档）。
    // ⚠ 刻意**不用** `favicon.ico`：下面那条 404 判据把它当"缺失资源"的样本，建了会互相打脸。
    writeFileSync(join(builtRoot, 'robots.txt'), 'User-agent: *')
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

  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 2026-10-13：**静态文件必须带缓存策略**（从前后端产物只有 `content-type`）
  //
  // 实测事故：vite 每次构建都换产物名并删掉旧文件（`index-DxpVJAXj.js` →
  // `index-o7z2j4Q6.js`）。而这个处理器发的 `index.html` **一个缓存头都没有**
  // ⇒ 浏览器有资格长期留着旧壳 ⇒ 旧壳去要那个已被删掉的 JS ⇒ **404**
  // ⇒ 单页应用整页死（界面框架在、里面什么都没有）：
  //
  //   用户原话：「模型加载不出来，任务也加载不出来」
  //   ——而每一层的报错都指不到这一处（服务端全 200、产物也在）。
  //
  //   > 一份"永远不过期"的旧壳，与一份"其实是最新的"旧壳，
  //   > 在用户眼里是同一块白屏 —— 而重建产物的人以为自己只是改了个按钮。
  //
  // 三档与**中枢那一侧同一条口径**（`team-hub/routes/static-tree.mjs` 的
  // `cacheControlFor`）：`.html` → no-store；`/assets/` → 永久 + immutable；其余 → 一天。
  // ⚠ 中枢那边记着一个坑：`immutablePrefix` 比的是**树内相对路径**，
  //   写成完整 URL 路径（`/workbench/assets/…`）就永远不匹配 —— 这里同样按相对路径比。
  // ══════════════════════════════════════════════════════════════════════════
  it('★★★ 有产物：入口必须 `no-store`（否则发新版后用户一直拿旧壳 ⇒ 整页白屏）', async () => {
    for (const p of ['/', '/index.html']) {
      const r = await fetch(`http://127.0.0.1:${builtPort}${p}`)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('cache-control'), 'no-store',
        `${p} 是入口，必须每次回源；实测事故就是它没有缓存头，旧壳引用了已被删掉的产物`)
      await r.text()
    }
  })

  it('★★★ 有产物：SPA 回退发的也是入口 ⇒ 同样 `no-store`（不能只在 `/` 上是对的）', async () => {
    const r = await fetch(`http://127.0.0.1:${builtPort}/tasks/abc/def`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(r.headers.get('cache-control'), 'no-store', '深链回落的也是 index.html，同一个问题')
    await r.text()
  })

  it('★★★ 有产物：`/assets/` 下（文件名带内容哈希）⇒ 永久 + immutable', async () => {
    const r = await fetch(`http://127.0.0.1:${builtPort}/assets/index-abc.js`)
    assert.equal(r.status, 200)
    const cc = r.headers.get('cache-control') ?? ''
    assert.match(cc, /max-age=31536000/, `哈希产物应当永久缓存，实际：${cc}`)
    assert.match(cc, /immutable/, `少了 immutable 会让浏览器每次回源校验，实际：${cc}`)
    await r.text()
  })

  it('★ 有产物：其余文件 ⇒ 一天（既不是永久，也不是每次都回源）', async () => {
    const r = await fetch(`http://127.0.0.1:${builtPort}/robots.txt`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400')
    await r.text()
  })

  // ── 候选 #8：未知**静态资源**必须 404，不得被 SPA 回退伪装成 200 HTML ──
  // 旧行为：`/assets/index-missing.js` 回 200 + text/html，浏览器只报「MIME 类型不对」，
  // `fetch()` 取缺失 JSON 时只报「解析失败」——「资源不存在」这个事实被藏起来。
  it('有产物：缺失的静态资源按扩展名判定 → 404（不是 200 HTML）', async () => {
    for (const p of ['/assets/index-missing.js', '/assets/app-missing.css', '/data/missing.json', '/favicon.ico', '/assets/deep/nested/missing.map']) {
      const r = await fetch(`http://127.0.0.1:${builtPort}${p}`)
      assert.equal(r.status, 404, `${p} 应为 404（旧行为是 200 + text/html）`)
      const ct = r.headers.get('content-type') ?? ''
      assert.ok(!/text\/html/.test(ct), `${p} 的 404 不得以 HTML 承载（会诱导浏览器按文档解析）：${ct}`)
      const body = await r.text()
      assert.match(body, /未找到静态资源/, `${p} 的错误体应说清是资源不存在：${body.slice(0, 160)}`)
    }
  })

  it('有产物：缺失资源仍**不**影响真实资源与 SPA 深链（两边界都还在）', async () => {
    // ① 真实存在的资源照常 200
    const ok = await fetch(`http://127.0.0.1:${builtPort}/assets/index-abc.js`)
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-type') ?? '', /javascript/)
    // ② 无扩展名的深链仍回 SPA 入口
    const deep = await fetch(`http://127.0.0.1:${builtPort}/tasks/abc/def`)
    assert.equal(deep.status, 200)
    assert.match(deep.headers.get('content-type') ?? '', /text\/html/)
    // ③ 带点的深链：**浏览器导航**（Accept: text/html）仍回 SPA 入口——不能被兜底误伤
    const dottedNav = await fetch(`http://127.0.0.1:${builtPort}/report.v2`, { headers: { accept: 'text/html,application/xhtml+xml' } })
    assert.equal(dottedNav.status, 200)
    assert.match(await dottedNav.text(), /id="app"/)
    // ④ 同一个带点路径，**子资源**请求（不带 text/html）→ 404，说明 #8 没有被这条出口重新藏回去
    const dottedAsset = await fetch(`http://127.0.0.1:${builtPort}/report.v2`, { headers: { accept: '*/*' } })
    assert.equal(dottedAsset.status, 404)
    assert.match(await dottedAsset.text(), /未找到静态资源/)
  })

  it('有产物：目录请求（存在但无 index.html）仍回 SPA 入口，不算资源缺失', async () => {
    const r = await fetch(`http://127.0.0.1:${builtPort}/assets`)
    assert.equal(r.status, 200, '目录路径无扩展名 → 导航语义，仍走 SPA 回退')
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

// ── 候选 #8 的判定规则本身（纯函数，不需起服务；边界比端到端更快更全）──
describe('静态托管：导航 vs 静态资源判定（staticRequestKind）', () => {
  const withAccept = (accept) => ({ headers: accept === undefined ? {} : { accept } })

  it('无扩展名的路径段 → 导航（SPA 深链照旧可用）', () => {
    for (const p of ['/', '/tasks', '/tasks/abc/def', '/a/b/c']) {
      assert.equal(staticRequestKind(withAccept('*/*'), p), 'navigation', p)
    }
  })

  it('.html / .htm → 导航（显式要文档）', () => {
    assert.equal(staticRequestKind(withAccept('*/*'), '/index.html'), 'navigation')
    assert.equal(staticRequestKind(withAccept('*/*'), '/legacy.htm'), 'navigation')
    assert.equal(staticRequestKind(withAccept('*/*'), '/dir/PAGE.HTML'), 'navigation', '大小写不敏感')
  })

  it('其它扩展名 + 子资源请求头 → 资源（缺失即 404）', () => {
    for (const p of ['/assets/index-abc.js', '/a.css', '/data.json', '/favicon.ico', '/x/a.map', '/img/logo.png', '/font.woff2']) {
      assert.equal(staticRequestKind(withAccept('*/*'), p), 'resource', p)
    }
    assert.equal(staticRequestKind(withAccept('text/css,*/*;q=0.1'), '/a.css'), 'resource', 'CSS 请求不带 text/html')
    assert.equal(staticRequestKind(withAccept(undefined), '/a.js'), 'resource', '无 Accept 头时按资源处理（更安全：不伪装成 HTML）')
  })

  it('带点的路径 + 导航请求头（Accept: text/html）→ 导航（浏览器地址栏访问不被误伤）', () => {
    assert.equal(staticRequestKind(withAccept('text/html'), '/report.v2'), 'navigation')
    assert.equal(staticRequestKind(withAccept('text/html,application/xhtml+xml,application/xml;q=0.9'), '/a.b.c'), 'navigation')
    assert.equal(staticRequestKind(withAccept('TEXT/HTML'), '/x.js'), 'navigation', 'Accept 匹配大小写不敏感')
  })

  it('目录形路径（尾斜杠）→ 导航', () => {
    assert.equal(staticRequestKind(withAccept('*/*'), '/assets/'), 'navigation')
  })

  it('非法/畸形入参不抛错（顶层兜底之外的第二道保险）', () => {
    assert.equal(staticRequestKind(null, '/a.js'), 'resource')
    assert.equal(staticRequestKind({}, '/a.js'), 'resource')
    assert.equal(staticRequestKind({ headers: { accept: 123 } }, '/a.js'), 'resource', '非字符串 Accept 不得抛错')
    assert.equal(staticRequestKind(withAccept('*/*'), undefined), 'navigation')
    assert.equal(staticRequestKind(withAccept('*/*'), ''), 'navigation')
  })

  it('**负向锚定**：静态资源判定与「旧行为」相反（旧行为一律 navigation → 200 HTML）', () => {
    // 这条把 #8 的缺陷本身写成断言：若哪天有人把 resource 分支去掉，这里立即红。
    const p = '/assets/index-missing.js'
    assert.equal(staticRequestKind(withAccept('*/*'), p), 'resource',
      '缺失的 .js 必须判为资源（旧行为是导航 → SPA 200 HTML → 只报 MIME 错，找不到真因）')
  })
})

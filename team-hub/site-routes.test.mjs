// team-hub/site-routes.test.mjs
// ============================================================================
// 官网路由族（`GET /`、`GET /en`、`GET /site/*`）。
//
// 用例写法照 `portal-routes.test.mjs` / `releases-routes.test.mjs`：直接调
// `routes.dispatch`，用手搓的假 req/res；静态资源那条路会 `pipe`，所以假 res
// 要带上 `write/on/once/emit`，并在读完后等一小会儿。
//
// 大部分断言是**负向**的——钉住"什么东西**不**能出去"：
// 不吞 API、不发模板本身、不给假下载链接、不放过越界路径。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSiteRoutes, injectLiveBlocks, renderLiveBlocks } from './routes/site.mjs'

const MARKER_CTA = '<!-- legion:cta -->'
const MARKER_DOWNLOAD = '<!-- legion:download -->'
const MARKER_HUB = '<!-- legion:hub-line -->'

/** 一份最小的模板：带三个标记、样式表链接，与足以断言语言的东西。 */
function template(lang) {
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head><title>${lang}</title>
<link rel="stylesheet" href="/site/assets/site.css">
</head>
<body>
<nav><a href="${lang === 'zh' ? '/en' : '/'}">switch</a></nav>
${MARKER_CTA}
${MARKER_HUB}
<section id="download">${MARKER_DOWNLOAD}</section>
</body>
</html>
`
}

/** 造一个站点目录。返回它的绝对路径。 */
function makeSite(t, { zh = template('zh'), en = template('en'), css = 'body{}' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-site-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'en'), { recursive: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), zh)
  writeFileSync(join(root, 'en', 'index.html'), en)
  writeFileSync(join(root, 'assets', 'site.css'), css)
  return root
}

/** 手搓假 res：够 `writeHead/end`，也够 `createReadStream().pipe()`。 */
async function call(routes, { method = 'GET', path = '/' } = {}) {
  const chunks = []
  const headers = {}
  const res = {
    writeHead(status, h) { this.status = status; Object.assign(headers, h) },
    write(c) { chunks.push(Buffer.from(c)); return true },
    end(c) { if (c !== undefined) chunks.push(Buffer.from(c)); this.ended = true },
    on() { return this }, once() { return this }, emit() { return true },
  }
  const handled = await routes.dispatch({ method, url: path, headers: {} }, res, { path })
  if (!res.ended) await new Promise((r) => setTimeout(r, 60))
  return { handled, status: res.status, headers, body: Buffer.concat(chunks).toString('utf8') }
}

const FIXED = () => ({ url: '/legion/releases/r-1/Legion-Setup-win-x64.exe', sizeBytes: 104857600, at: Date.UTC(2026, 9, 6), version: '0.1.0' })

describe('官网：入口页', () => {
  test('① `GET /` 发中文页，`GET /en` 与 `/en/` 发英文页（语言是真的，不是客户端换的）', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const zh = await call(routes, { path: '/' })
    assert.equal(zh.status, 200)
    assert.match(zh.headers['content-type'], /text\/html/)
    assert.match(zh.body, /<html lang="zh-CN"/)
    for (const p of ['/en', '/en/']) {
      const en = await call(routes, { path: p })
      assert.equal(en.status, 200, p)
      assert.match(en.body, /<html lang="en"/, p)
    }
  })

  test('② 入口页**不缓存**（它带着当次算出的下载地址）', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
  })

  test('③ HEAD 有同样的头但没有正文', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const get = await call(routes, { path: '/' })
    const head = await call(routes, { method: 'HEAD', path: '/' })
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
    assert.equal(head.headers['content-type'], get.headers['content-type'])
    assert.equal(head.headers['content-length'], get.headers['content-length'])
  })

  test('④ 切换器互指，当前语言标 aria-current', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const zh = (await call(routes, { path: '/' })).body
    const en = (await call(routes, { path: '/en' })).body
    assert.match(zh, /href="\/en"/)
    assert.match(en, /href="\/"/)
  })

  test('★ 模板不存在 = 这个部署没有官网：返回 false 让 `/` 落到门口页', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'legion-site-empty-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const routes = createSiteRoutes({ root, readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    assert.equal(r.handled, false, '答不了的时候必须让路，而不是发一个空 200')
    assert.equal((await call(routes, { path: '/en' })).handled, false)
  })

  test('`root` 缺失就吵，不静默降级', () => {
    assert.throws(() => createSiteRoutes({}), TypeError)
  })
})

describe('官网：下载区诚实地缺席', () => {
  test('★ 没有安装包时如实说「尚未发布」，且**不含**任何发布链接', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '' }) })
    const zh = await call(routes, { path: '/' })
    assert.match(zh.body, /尚未发布/)
    assert.doesNotMatch(zh.body, /\/legion\/releases\//, '没有链接可给时，一个字符的链接都不能有')
    assert.doesNotMatch(zh.body, /<a[^>]+download/, '不该出现下载锚点')
  })

  test('★ 有安装包时给出链接、版本、体积与日期', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    assert.match(r.body, /href="\/legion\/releases\/r-1\/Legion-Setup-win-x64\.exe"/)
    assert.match(r.body, /v0\.1\.0/)
    assert.match(r.body, /100\.0 MB/)
    assert.match(r.body, /2026-10-06/)
  })

  test('★ 建路由之后再发一份新的：**当次请求**就改口（无需重启）', async (t) => {
    let rel = FIXED()
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => rel })
    assert.match((await call(routes, { path: '/' })).body, /r-1\//)
    rel = { ...rel, url: '/legion/releases/r-2/Legion-Setup-win-x64.exe' }
    const after = await call(routes, { path: '/' })
    assert.match(after.body, /r-2\//, '换了之后必须立刻改口')
    assert.doesNotMatch(after.body, /r-1\//, '旧链接不该还留在页面上')
  })

  test('★ 发布没了：旧链接必须跟着消失', async (t) => {
    let rel = FIXED()
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => rel })
    assert.match((await call(routes, { path: '/' })).body, /r-1/)
    rel = { url: '' }
    const r = await call(routes, { path: '/' })
    assert.match(r.body, /尚未发布/)
    assert.doesNotMatch(r.body, /r-1/)
  })

  test('★ 不给 `/legion/` 这类**目录**链接（那一族只发文件，目录一律 404）', async (t) => {
    // 这条是上线后实测补的：曾经有过一行「全部历史版本 → /legion/」，
    // 而 `/legion/` 是 404 —— 发布目录那族从不列目录。守卫当时测的是
    // "安装包来自发布目录"（为真），而不是"那个路径下有可读的东西"（为假）。
    // 所以现在无论发布是否配置，站上都不出现任何目录链接。
    const fromReleases = await call(createSiteRoutes({ root: makeSite(t), readRelease: FIXED }), { path: '/' })
    assert.doesNotMatch(fromReleases.body, /href="\/legion\/"/, '不能指向发布目录本身')
    assert.doesNotMatch(fromReleases.body, /全部历史版本/, '不该承诺一个不存在的历史版本页')

    const explicit = await call(
      createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: 'https://cdn.test/a.exe' }) }), { path: '/' },
    )
    assert.doesNotMatch(explicit.body, /href="\/legion\/"/)
    assert.match(explicit.body, /https:\/\/cdn\.test\/a\.exe/, '显式配置那条路照旧')
  })

  test('★ 下载卡片里**没有**「本次更新」那一块（业主看过之后要求撤掉）', async (t) => {
    // 那张卡片已经承载了下载、版本/体积/日期、未签名说明与摘要校验。
    // 再挂四段更新条目就不是"一张卡片"而是一页文档了 —— 超过上限之后
    // **每一段都变便宜了**。
    const routes = createSiteRoutes({
      root: makeSite(t),
      readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: ['把**正文**送到电脑端'], changesEn: [] }),
    })
    for (const path of ['/', '/en']) {
      const r = await call(routes, { path })
      assert.doesNotMatch(r.body, /class="updates"/, `${path} 不该有更新块`)
      assert.doesNotMatch(r.body, /本次更新/, `${path} 不该有更新标题`)
      assert.doesNotMatch(r.body, /送到电脑端/, `${path} 不该出现更新条目正文`)
      assert.doesNotMatch(r.body, /\*\*/, `${path} 不该出现未消化的粗体标记`)
    }
  })

  test('★ 下载卡片里只有一个按钮，且不是「查看协作界面」', async (t) => {
    // 2026-10-08 业主报"下载按钮没有文字"。真因是 `.deploy-item a`（0,1,1）比
    // `.primary`（0,1,0）更具体，把按钮文字染成了 `--accent` —— 而按钮底色也是
    // `--accent`，青绿字压青绿底。CSS 权重那种事只有真看渲染才算数，
    // 这里钉住"只有一个按钮"，权重那条由下面 `真实模板不漂移` 里的源码断言守着。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '/legion/releases/r-1/x.exe' }) })
    const r = await call(routes, { path: '/' })
    const from = r.body.indexOf('class="dl-actions"')
    const actions = r.body.slice(from, r.body.indexOf('</div>', from))
    assert.equal((actions.match(/<a /g) || []).length, 1, '下载卡片里只该有一个链接按钮')
    assert.match(actions, /下载电脑版/)
    assert.doesNotMatch(actions, /查看协作界面/)
  })

  test('★ 入口页引用的样式表**带版本串**（否则边缘缓存会把新 HTML 配上旧 CSS）', async (t) => {
    // 2026-10-08 线上实测：`site.css` 无内容哈希、无 ETag，却发 `max-age=86400`。
    // 隧道经 Cloudflare，边缘缓存 24 小时；入口页是 `no-store`。于是重新部署后
    // 访问者拿到**新 HTML + 旧 CSS** —— 实测症状是 `.sha` 那段塌成行内、摘要溢出，
    // 而服务器上那份 CSS 明明是对的。版本串把它变成新 URL，问题消失。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    assert.match(r.body, /href="\/site\/assets\/site\.css\?v=[^"]+"/, '样式表必须带版本串')
    assert.doesNotMatch(r.body, /href="\/site\/assets\/site\.css"/, '不该出现没版本的无参形态')
    // 两页都要，不能只顾中文页。
    assert.match((await call(routes, { path: '/en' })).body, /site\.css\?v=/)
  })

  test('★ 改了样式表 ⇒ 版本串跟着变（否则新 CSS 会被长缓存挡在门外）', async (t) => {
    const root = makeSite(t)
    const routes = createSiteRoutes({ root, readRelease: FIXED })
    const first = (await call(routes, { path: '/' })).body.match(/site\.css\?v=([^"]+)/)[1]
    const p = join(root, 'assets', 'site.css')
    writeFileSync(p, 'body{color:red}')
    const t2 = Date.now() / 1000 + 5
    utimesSync(p, t2, t2)
    const second = (await call(routes, { path: '/' })).body.match(/site\.css\?v=([^"]+)/)[1]
    assert.notEqual(first, second, '样式表变了，版本串必须变')
  })

  test('静态资源的缓存策略：CSS 长缓存、图片短缓存、其余 no-store', async (t) => {
    const root = makeSite(t)
    writeFileSync(join(root, 'assets', 'icon.png'), 'x')
    const routes = createSiteRoutes({ root })
    assert.match((await call(routes, { path: '/site/assets/site.css' })).headers['cache-control'], /immutable/)
    assert.match((await call(routes, { path: '/site/assets/icon.png' })).headers['cache-control'], /max-age=3600/)
  })

  test('注册策略三种取值措辞互不相同', async (t) => {
    const one = async (registration) => (await call(
      createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '' }), registration }), { path: '/' },
    )).body
    const closed = await one('closed')
    const invite = await one('invite')
    const open = await one('open')
    assert.notEqual(closed, invite)
    assert.notEqual(invite, open)
    assert.match(open, /开放注册/)
    assert.match(closed, /未开放自助注册/)
  })

  test('★ 所有插值都转义：恶意下载地址进不来可执行标记', async (t) => {
    const evil = '"><script>alert(1)</script>'
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: evil, version: '<img onerror=x>' }) })
    const r = await call(routes, { path: '/' })
    // 关键不是"字符串里没有 onerror"，而是**没有能成形的标签**：
    // 尖括号已被转义成 &lt;/&gt;，所以 `&lt;img …&gt;` 只是文本，不是标签。
    assert.doesNotMatch(r.body, /<script>/)
    assert.doesNotMatch(r.body, /<img/)
    assert.match(r.body, /&lt;img/, '应当是被转义（而非被丢弃）')
    // 引号也被转义 ⇒ 逃不出 href 这个属性。
    assert.doesNotMatch(r.body, /href=""><script/)
  })

  test('纯函数：没发布的语言各自诚实', () => {
    const zh = renderLiveBlocks({ lang: 'zh', downloadUrl: '' })
    const en = renderLiveBlocks({ lang: 'en', downloadUrl: '' })
    // 诚实的话在**部署卡片**里（hero 退回设计稿原本的那一对动作，不给死按钮）。
    assert.match(zh.download, /还没上传到这台 Hub/)
    assert.match(en.download, /No desktop installer has been uploaded/)
    assert.doesNotMatch(zh.download, /href="\/legion\/releases\//, '没发布就没有任何发布链接')
    assert.doesNotMatch(zh.download, /<a class="btn primary"/, '没发布就不该有可点的下载按钮')
    // hero 的两个动作退回稿子原本的那一对，且都指向站内锚点。
    assert.match(zh.cta, /查看协作界面/)
    assert.match(en.cta, /See the interface/)
    assert.doesNotMatch(zh.cta, /href="\/legion\//)
  })

  test('纯函数：注入用 split/join，替换串里的 `$&` 不会被当成替换模式吃掉', () => {
    const out = injectLiveBlocks(`A${MARKER_CTA}B`, { cta: 'x$&y', download: '', hub: '' })
    assert.equal(out, 'Ax$&yB')
  })
})

describe('官网：静态资源', () => {
  test('① 白名单内的类型正常发，带长缓存', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t) })
    const r = await call(routes, { path: '/site/assets/site.css' })
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /text\/css/)
    assert.match(r.headers['cache-control'], /max-age=86400/)
    assert.equal(r.body, 'body{}')
  })

  test('★ `/site/index.html` 必须 404：入口页只能经 `/` 与 `/en` 出来', async (t) => {
    // 白名单里没有 `.html`。若放行，拿到的就是**没被替换过的模板**——
    // 页面上少掉下载链接与手机端入口，而 HTTP 是 200，什么也不报。
    const routes = createSiteRoutes({ root: makeSite(t) })
    const r = await call(routes, { path: '/site/index.html' })
    assert.equal(r.status, 404)
    assert.equal(r.body, 'TYPE_NOT_SERVED')
    assert.doesNotMatch(r.body, /legion:cta/)
    assert.equal((await call(routes, { path: '/site/en/index.html' })).status, 404)
  })

  test('白名单之外的类型一律 404，不猜', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t) })
    for (const p of ['/site/secret.env', '/site/x.mjs', '/site/x.json', '/site/x.key']) {
      const r = await call(routes, { path: p })
      assert.equal(r.status, 404, p)
      assert.equal(r.body, 'TYPE_NOT_SERVED', p)
    }
  })

  test('② 路径穿越拦得住：**读不到根外的东西**（含编码形式与空字节）', async (t) => {
    const root = makeSite(t)
    // 在站点根**旁边**放一个金丝雀。任何一次穿越成功，都会把它的内容带出来 ——
    // 这比断言某个状态码更接近要保的性质：状态码可以是 403 也可以是 404，
    // 而"内容没出来"只有一种。
    const sibling = `${root}-sibling`
    mkdirSync(sibling, { recursive: true })
    t.after(() => rmSync(sibling, { recursive: true, force: true }))
    writeFileSync(join(sibling, 'canary.css'), 'CANARY-SECRET')

    const routes = createSiteRoutes({ root })
    const attacks = [
      '/site/../canary.css',
      '/site/..%2f..%2fcanary.css',
      '/site/%2e%2e/%2e%2e/canary.css',
      `/site/${'../'.repeat(10)}etc/passwd`,
      '/site/....//canary.css',
    ]
    for (const p of attacks) {
      const r = await call(routes, { path: p })
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`)
      assert.doesNotMatch(r.body, /CANARY-SECRET/, p)
      assert.doesNotMatch(r.body, /root:x:/, p)
    }
    const nul = await call(routes, { path: '/site/a%00.css' })
    assert.ok(nul.status === 400 || nul.status === 404, `空字节必须被拦：${nul.status}`)
  })

  test('★ 前缀比对带分隔符：`/siteofsomething` 不被吞掉', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t) })
    assert.equal((await call(routes, { path: '/siteofsomething/x.css' })).handled, false)
  })

  test('★ 目录内的符号链接指向根外时被拒（prefix 比对拦不住它）', async (t) => {
    const root = makeSite(t)
    const outside = mkdtempSync(join(tmpdir(), 'legion-outside-'))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(outside, 'leak.css'), 'SECRET')
    let linked = true
    try {
      symlinkSync(join(outside, 'leak.css'), join(root, 'assets', 'leak.css'), 'file')
    } catch { linked = false }   // Windows 上没权限建链接就跳过这条
    if (!linked) return
    const r = await call(createSiteRoutes({ root }), { path: '/site/assets/leak.css' })
    assert.equal(r.status, 403, '符号链接指向根外必须被拒')
    assert.doesNotMatch(r.body, /SECRET/)
  })

  test('③ 模板缓存按 mtime 失效：改文案不必重启', async (t) => {
    const root = makeSite(t)
    const routes = createSiteRoutes({ root, readRelease: FIXED })
    assert.match((await call(routes, { path: '/' })).body, /<title>zh<\/title>/)
    const p = join(root, 'index.html')
    writeFileSync(p, template('zh').replace('<title>zh</title>', '<title>改过</title>'))
    const t2 = Date.now() / 1000 + 5
    utimesSync(p, t2, t2)
    assert.match((await call(routes, { path: '/' })).body, /<title>改过<\/title>/)
  })
})

describe('官网：真实模板不漂移', () => {
  // 这一组看着与上面的 fixture 用例重复，其实抓的是**另一类**失败：
  // 上面用的模板是测试自己造的，所以"有人改 `site/index.html` 时删掉了一个标记"
  // 不会被任何用例发现——症状是页面上少掉下载区或手机端入口，而 HTTP 是 200，
  // **什么也不报**。这里直接读真实模板，把漂移钉在 CI 里。
  const siteRoot = fileURLToPath(new URL('../site/', import.meta.url))
  const read = (p) => readFileSync(join(siteRoot, p), 'utf8')

  test('★ 两种语言的真实模板都恰好各带一个标记，且一个都不少', () => {
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      for (const m of [MARKER_CTA, MARKER_DOWNLOAD, MARKER_HUB]) {
        const n = html.split(m).length - 1
        assert.equal(n, 1, `${p} 里 ${m} 应恰好出现 1 次，实际 ${n} 次`)
      }
    }
  })

  test('★ 两种语言的锚点集合一致（新增一节只加了一种语言会被这条抓出来）', () => {
    const ids = (html) => (html.match(/id="([^"]+)"/g) ?? []).sort().join(' ')
    const zh = ids(read('index.html'))
    const en = ids(read(join('en', 'index.html')))
    assert.equal(zh, en, '中英两页的 id 集合必须一致')
    assert.ok(zh.includes('"deploy"'), '部署/下载锚点必须在')
  })

  test('★ 品牌标记用**产品图标**，不是自绘的近似图形', () => {
    // 2026-10-08 业主指出：左上角那个图标不对。之前这里放的是一段自绘的内联 SVG
    // （六边形近似图），而产品指定图标是 `legion-icon-64.png`（三叶结）。
    //   > 一个"看起来像 Logo"的图形与"产品自己的标记"，在没人逐像素对比过的时候，
    //   > 是同一个东西 —— 但它会在每一个并排放着真 Logo 的场合露出来。
    // 演示页也是对外发布的页面，一并纳入。
    for (const p of ['index.html', join('en', 'index.html'), join('demo', 'index.html')]) {
      const html = read(p)
      assert.match(html, /class="mark" src="\/site\/assets\/legion-icon-64\.png"/, `${p} 的标记必须是产品图标`)
      assert.doesNotMatch(html, /<svg class="mark"/, `${p} 不该再有自绘的内联 SVG 标记`)
      assert.doesNotMatch(html, /viewBox="0 0 512 512"/, `${p} 里不该残留自绘标记的 path`)
    }
  })

  test('★ 模板里没有装饰性箭头（↗ / ↓ / →）', () => {
    // 业主指出箭头用多了。装饰箭头一律去掉。允许保留 `→` 的只有两种情形，
    // 都在**内容**里而不是装饰里：
    //   · 服务端渲染的 Windows 提示 —— "更多信息 → 仍要运行"（真实菜单路径）；
    //   · 演示页的示例正文 —— "缺失键 → en → 原键名"（描述真实回退路径）。
    // 所以这里只扫两个落地页模板；演示页单独由下面那条只看装饰位置。
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      for (const ch of ['↗', '↓', '→']) {
        assert.equal(html.includes(ch), false, `${p} 里不该出现「${ch}」`)
      }
    }
  })

  test('★ `/demo` 已**收起**：路由不认它，请求落到通用 404', async (t) => {
    // 业主 2026-10-09：先把产品演示注释掉。模板 `site/demo/index.html` **没有删**，
    // 恢复就是把 `routes` 表与 `dispatch` 里那两处注释解开。这条用例钉住"现在确实关着"。
    const root = makeSite(t)
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'index.html'), '<!doctype html><html lang="zh-CN"><body>产品演示</body></html>')
    const routes = createSiteRoutes({ root, readRelease: FIXED })
    assert.equal((await call(routes, { path: '/demo' })).handled, false, '收起时不该认领 /demo')
    assert.equal((await call(routes, { path: '/demo/' })).handled, false)
  })

  test('★ 落地页里不许再有指向 `/demo` 的链接（收起要收干净）', () => {
    // 一条"指向已被注释掉的路由"的链接，与一条 404 的死链是同一个东西 ——
    // 而且它比死链更坏：它在**导航栏**上。
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      // 注释掉的残留是允许的（业主就是要"注释掉"），但**活着的**链接不许有。
      const live = html.replace(/<!--[\s\S]*?-->/g, '')
      assert.equal(live.includes('href="/demo"'), false, `${p} 里还有活的 /demo 链接`)
      assert.equal(live.includes('产品演示'), false, `${p} 里还有"产品演示"入口`)
    }
  })

  test('★ 演示页必须**标明是示例数据**（一个看起来像真产品的演示会骗人）', () => {
    // 只读演示的整个价值在于：它看起来像产品，所以**必须**在显眼处说清它是示例、
    // 是静态快照、不连任何实例。少了这一句，演示就变成了一次误导。
    const html = read(join('demo', 'index.html'))
    assert.match(html, /示例数据/, '必须写明是示例数据')
    assert.match(html, /静态快照/, '必须写明是静态快照')
    assert.match(html, /不连接任何在线实例/, '必须写明不连实例')
    assert.match(html, /name="robots" content="noindex"/, '演示页不该被索引（它是样本数据，不是内容）')
    // 与落地页一样要挂版本串的样式表。
    assert.match(html, /href="\/site\/assets\/site\.css"/)
  })

  test('★ 演示页可点：八个阶段、三个证据种类都得在', () => {
    // 演示的主张是"看证据，再确认交付"，所以证据必须是可看的内容，
    // 不能是一句"已完成"。三种证据（文档 / 补丁 / 用例清单）都要有样本。
    const html = read(join('demo', 'index.html'))
    const data = JSON.parse(html.slice(html.indexOf('<script type="application/json"'), html.indexOf('</script>', html.indexOf('<script type="application/json"'))).replace(/^[^>]*>/, ''))
    assert.equal(data.stages.length, 8, '八个阶段')
    assert.equal(data.goal.total, 8)
    const kinds = new Set(data.stages.map((s) => s.evidence.kind))
    for (const k of ['doc', 'diff', 'list']) assert.ok(kinds.has(k), `缺证据种类 ${k}`)
    // 一处在等待人工决定 —— 演示的重点就是"需要你决定"这件事。
    assert.equal(data.stages.filter((s) => s.status === 'human').length, 1, '应恰好有一处人工闸门')
    for (const s of data.stages) {
      assert.ok(s.desc && s.acceptance.length > 0, `${s.id} 缺描述或验收标准`)
    }
  })

  test('★ 演示页的示例数据里没有真实项目数据，编号也一眼是假的', () => {
    // 演示数据是**编的**。这两条防的是两件事：
    //   ① 顺手把真任务/真路径粘进去 —— 那会让一个标着"示例数据"的页面成为内部信息出口；
    //   ② 用了**看起来像真实编号**的 ID（`T-101`）—— 访客分不清它和 Hub 里真任务的区别。
    //      所以演示编号统一带 `demo` 段（`T-demo-01`），一眼看得出是编的。
    const html = read(join('demo', 'index.html'))
    for (const re of [/[A-Za-z]:[\\/]/, /superpowers/, /team\.db/, /docs\/STATUS/, /\/api\//]) {
      assert.doesNotMatch(html, re, `演示页不该命中 ${re}`)
    }
    for (const id of html.match(/\bT-[A-Za-z0-9-]+/g) ?? []) {
      assert.match(id, /^T-demo-/, `${id} 这个编号看起来像真任务号，演示里必须一眼是假的`)
    }
  })

  test('★ 数字人一节：用**真实 3D 场景**，四个状态色与 `Employee3D.tsx` 对得上', () => {
    // 业主 2026-10-09：这一节应当取 3D 场景，更直观。所以视觉是**真实截图**
    // （`team-scene.png`，等距办公室 + 八个岗位各有其位），四个状态改成一条图例。
    //   ① 四个状态一个都不能少（少一个就不是体系了）；
    //   ② 四个色值必须与工作台 3D 场景的实现一致 —— 它们是与产品界面一一对应的
    //      标识，抄错了就与实物对不上（`workbench/src/components/Employee3D.tsx` 的 STATUS）。
    const css = readFileSync(fileURLToPath(new URL('../site/assets/site.css', import.meta.url)), 'utf8')
    for (const key of ['idle', 'busy', 'review', 'blocked']) {
      assert.match(css, new RegExp(`\\.l-${key}\\s*\\{`), `CSS 里缺 .l-${key}`)
    }
    // 深色主题下必须回到实现里的原值（浅色另取可读的同色相值）。
    for (const [key, hex] of [['busy', '#40ffa0'], ['review', '#ffd54a'], ['blocked', '#ff5c5c'], ['idle', '#5b8cff']]) {
      assert.match(css, new RegExp(`html\\[data-theme=dark\\] \\.legend \\.l-${key} \\{ --state-color: ${hex}\\b`), `深色下 .l-${key} 应为 ${hex}`)
    }
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      assert.match(html, /id="crew"/, `${p} 缺数字人一节`)
      assert.equal((html.match(/class="l-(idle|busy|review|blocked)"/g) || []).length, 4, `${p} 应有四条状态图例`)
      assert.match(html, /shots\/team-scene\.png/, `${p} 这一节要用真实 3D 场景图`)
      assert.doesNotMatch(html, /class="state s-/, `${p} 不该再有自绘的 2D 形象`)
    }
    // 场景图必须真的在仓库里（引用了不存在的文件 = 一张破图）。
    const img = readFileSync(fileURLToPath(new URL('../site/assets/shots/team-scene.png', import.meta.url)))
    assert.ok(img.length > 50000, '场景图应当是真实截图，不是占位')
    assert.equal(img.readUInt32BE(16), 1764, '场景图宽度')
  })

  test('★ 同一张截图不许出现在两处（重复会造成审美疲劳）', () => {
    // 2026-10-09 业主报"任务中心和 Agent 沟通的图变成一样的了，且同一张用了两次"。
    // 每张图只该有一个家：首屏轮两张（目标详情 / 任务中心），Agent 对话归 02 段落。
    const html = read('index.html')
    const refs = html.match(/\/site\/assets\/shots\/[a-z-]+\.png/g) ?? []
    const counts = refs.reduce((m, r) => { m[r] = (m[r] || 0) + 1; return m }, {})
    // hero 的 `img src` + shots 映射里的 `src:` = 同一张图两处出现是**预期**的
    //（一处是初始渲染，一处是切换用的配置）。真正要禁的是"两张不同的图指向同一文件"
    // 或者"同一张图被两个**展示位**引用"。
    const heroTabSrcs = [...html.matchAll(/data-shot="(\w+)"/g)].map((m) => m[1])
    assert.equal(heroTabSrcs.length, 2, '首屏只该有两个标签页（Agent 对话不再重复出现在这里）')
    assert.ok(!heroTabSrcs.includes('chat'), 'Agent 对话不该作为首屏标签（它归 02 段落）')
    assert.equal(counts['/site/assets/shots/agent-conversation.png'], 1, 'Agent 对话图只该在 02 段落出现一次')
  })

  test('★ 演示页叫「产品演示」，不叫「在线试用」', () => {
    // 业主指出：它既然是静态样本，就不该叫"在线试用"——那个名字承诺了一件它不做的事。
    const html = read(join('demo', 'index.html'))
    assert.match(html, /<title>Legion — 产品演示<\/title>/)
    assert.match(html, />产品演示</)
    assert.doesNotMatch(html, /在线试用/)
    assert.match(html, /PRODUCT DEMO/)
  })

  test('★ 部署卡：Web 一路指向仓库，Windows 一路只有徽标 + 一个按钮', async (t) => {
    // 业主 2026-10-09 定的形态：
    //   · Web：**本地启动**（不是托管在 hub 上），并从这里**直达仓库**；
    //   · Windows：打一个「内部验证 · 未签名」徽标就够了，不再展开三条处理说明、
    //     不再显示 sha256 —— 那些字比它们解决的问题更长。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })

    // Web 那一路：指向真实仓库，且开在新窗口时不留 opener 隐患。
    assert.match(r.body, /href="https:\/\/github\.com\/Mench-Li\/legion"/, 'Web 卡必须直达仓库')
    assert.match(r.body, /rel="noopener"/, '外链要带 rel=noopener')

    // Windows 那一路：卡片里不再有 ①② 说明、sha256 与更新条目。
    // （徽标是**模板**里的静态内容，由 `真实模板不漂移` 那条守。）
    assert.doesNotMatch(r.body, /Smart App Control/, '三条处理说明已撤')
    assert.doesNotMatch(r.body, /sha256/, '摘要已撤')
    assert.doesNotMatch(r.body, /本次更新/, '更新条目已撤')
    // 下载链接出现**两处**是设计要的：首屏第一个动作 + 部署卡里那一个按钮。
    // 多出来就是有人又加了一个入口。
    assert.equal((r.body.match(/Legion-Setup-win-x64\.exe/g) || []).length, 2, '下载链接只该有两处（首屏 + 部署卡）')

    const en = await call(routes, { path: '/en' })
    assert.match(en.body, /href="https:\/\/github\.com\/Mench-Li\/legion"/)
    assert.doesNotMatch(en.body, /sha256/)
  })

  test('★ 部署卡：Windows 一路只有徽标——签名状态由它承担，不再展开三条处理说明', () => {
    // 业主 2026-10-09：那些字比它们解决的问题更长。徽标是**模板**里的静态内容。
    for (const [p, badge] of [['index.html', /内部验证 · 未签名/], [join('en', 'index.html'), /Internal build · unsigned/]]) {
      const html = read(p)
      assert.match(html, /class="label human"/, `${p} 的徽标要保留`)
      assert.match(html, badge, `${p} 的徽标文案`)
      // 卡片里不该再有那三条处理说明或摘要。
      assert.doesNotMatch(html, /Smart App Control/, `${p} 不该再有 Smart App Control 说明`)
      assert.doesNotMatch(html, /未知发布者/, `${p} 不该再有"未知发布者"说明`)
    }
  })

  test('★ 产品窗口与文字左右对齐（不许突破文字列）', () => {
    // 业主否掉了"让产品窗口满宽多吃宽度"的做法：产品窗口必须和文字左右对齐、留白相同。
    // 这条守的是**布局边界**，不是审美 —— 一旦有人再加一次满宽 hack，就红。
    const css = readFileSync(fileURLToPath(new URL('../site/assets/site.css', import.meta.url)), 'utf8')
    assert.doesNotMatch(css, /translateX\(-50%\)[\s\S]{0,120}\.product/, '不该用位移把窗口撑出列宽')
    assert.doesNotMatch(css, /\.product,\s*\.live-shot-frame\s*\{/, '不该给产品窗口单独放宽')
  })

  test('★ `.deploy-item a` 必须是 `:not(.btn)` 作用域', () => {
    // 2026-10-08 的线上故障：`.deploy-item a { color: var(--accent) }` 权重 0,1,1，
    // 压过了 `.primary` 的 0,1,0 —— 下载按钮的文字被染成青绿，而底色也是青绿，
    // **按钮上的字整块看不见**。修法就是把它限定在非按钮链接上。
    const css = readFileSync(fileURLToPath(new URL('../site/assets/site.css', import.meta.url)), 'utf8')
    assert.match(css, /\.deploy-item a:not\(\.btn\)/, '必须限定为 :not(.btn)')
    assert.doesNotMatch(css, /^\.deploy-item a \{/m, '不该存在无限定的 .deploy-item a 规则')
  })

  test('★ 真实模板里不含任何真实项目数据（门口那条纪律）', () => {
    // 自绘示意图里的示例数据是允许的（`T-001`/`T-002` 一眼是假的）；
    // 不允许的是**真实**任务号、本机绝对路径、内部文档名。真实任务号一旦漏进模板，
    // 就等于把"屋里的事"写在了门口牌子上。
    const SAMPLE_TASK_IDS = new Set(['T-001', 'T-002'])
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      for (const id of html.match(/\bT-\d+\b/g) ?? []) {
        assert.ok(SAMPLE_TASK_IDS.has(id), `${p} 出现了非示例任务号：${id}`)
      }
      for (const re of [/[A-Za-z]:[\\/]/, /superpowers/, /team\.db/, /docs\/STATUS/]) {
        assert.doesNotMatch(html, re, `${p} 命中 ${re}`)
      }
    }
  })
})

describe('官网：不越界（这些路径必须原样落给别人）', () => {
  test('① 不吞 API / 手机端 / 发布目录 / 健康检查', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t) })
    for (const p of ['/api/board', '/mobile/', '/legion/x', '/healthz', '/index.html', '/favicon.ico']) {
      assert.equal((await call(routes, { path: p })).handled, false, p)
    }
  })

  test('② 非 GET/HEAD 一律不接管', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t) })
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal((await call(routes, { method: m, path: '/' })).handled, false, m)
      assert.equal((await call(routes, { method: m, path: '/site/assets/site.css' })).handled, false, m)
    }
  })

  test('③ 自定义挂载点可用（挂载前缀与 root 一一对应）', async (t) => {
    const root = makeSite(t)
    writeFileSync(join(root, 'mount.css'), 'x{}')
    const routes = createSiteRoutes({ root, mount: '/assets' })
    assert.equal((await call(routes, { path: '/assets/mount.css' })).status, 200)
    assert.equal((await call(routes, { path: '/assets/assets/site.css' })).status, 200)
    assert.equal((await call(routes, { path: '/site/assets/site.css' })).handled, false)
  })
})

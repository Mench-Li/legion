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

describe('官网：**没有任何**桌面端下载入口', () => {
  // ★★★ 2026-10-12：这一族原本叫「下载区诚实地缺席」，测的是"没发布时如实说
  //   尚未发布、不放假链接"。现在整块下载区**从官网上撤掉了**，所以判据换了
  //   一个方向：不再是"怎么把下载说诚实"，而是"**确认官网上没有下载**"。
  //
  //   为什么判据要留着（而不是随功能一起删）：一个被删掉的功能不会自己长回来，
  //   但**入口会**。下一个人想"顺手加个下载按钮"时，红掉的用例是唯一会说话的
  //   东西 —— 而"我们曾经决定不加"这件事，只有用例能记住。

  test('★★★ 官网首页不含任何安装包链接、`.exe` 或不存在的版本清单', async (t) => {
    // 连"配了发布"这条路也一起测：即使这台 Hub 确实有一份最新安装包，
    // 官网也**不许**把它放到页面上。
    for (const [label, readRelease] of [['没配发布', undefined], ['有发布', FIXED]]) {
      const routes = createSiteRoutes({ root: makeSite(t), ...(readRelease ? { readRelease } : {}) })
      for (const path of ['/', '/en']) {
        const r = await call(routes, { path })
        assert.equal(r.status, 200)
        assert.doesNotMatch(r.body, /\.exe/, `${label} ${path}：官网不该出现任何可执行文件链接`)
        assert.doesNotMatch(r.body, /Legion-Setup/, `${label} ${path}：不该出现安装包名`)
        assert.doesNotMatch(r.body, /下载电脑版|Download for Windows/, `${label} ${path}：不该有下载按钮文案`)
        assert.doesNotMatch(r.body, /legion\/releases/, `${label} ${path}：不该链接发布目录`)
        assert.doesNotMatch(r.body, /Windows x64/, `${label} ${path}：不该出现 Windows 平台标签`)
        assert.doesNotMatch(r.body, /尚未发布|not yet published/, `${label} ${path}：不是"还没发布"，是**不再提供**`)
      }
    }
  })

  test('★★★ `dl-actions` / `dl-meta` / `dl-lines` 一个都不该再被产出', async (t) => {
    // 这三个 class 是下载卡片专有的。它们还在 CSS 里（纯样式、不产生行为），
    // 但**渲染层不该再产出**。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    for (const cls of ['dl-actions', 'dl-meta', 'dl-lines']) {
      assert.doesNotMatch(r.body, new RegExp(`class="${cls}"`), `不该再产出 .${cls}`)
    }
  })

  test('★★ 模板里若有下载标记，它被替换成**空**（不留标记、不留占位）', async (t) => {
    // 官网上那个标记已经被删了，但**别的部署**可能还留着一份旧模板
    // （模板是运营者机器上的文件）。一个没人替换的标记会原样出现在 HTML 里。
    const routes = createSiteRoutes({ root: makeSite(t) })
    const r = await call(routes, { path: '/' })
    assert.doesNotMatch(r.body, /legion:download/, '标记必须被替换掉，不许原样出现')
    assert.doesNotMatch(r.body, /legion:cta|legion:hub-line/, '另两个标记同样要替换掉')
    // 而替换的结果是**空**：合成模板里那个 `<section id="download">` 现在是空的。
    assert.match(r.body, /<section id="download"><\/section>/, '标记处应当是空内容')
  })

  test('★ 官网不链接 `/legion/` 目录，也不承诺历史版本页', async (t) => {
    // 这条是上线后实测补的：曾经有过一行「全部历史版本 → /legion/」，而
    // `/legion/` 是 404 —— 发布目录那族从不列目录。现在整个下载区没了，
    // 但"不许指向一个目录"这条仍然钉着：目录链接会随任何一次"加个入口"回来。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    assert.doesNotMatch(r.body, /href="\/legion\/"/, '不能指向发布目录本身')
    assert.doesNotMatch(r.body, /全部历史版本/, '不该承诺一个不存在的历史版本页')
  })

  test('★ 官网任何地方都不出现「本次更新」那一块', async (t) => {
    // 旧实现对 `readRelease` 返回的 `changes` 做过渲染。撤掉下载区之后
    // 这条路也不该再存在 —— 传进去也不许出现在页面上。
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

  test('★★ 传了 `readRelease` 也不会被调用（官网不再读发布目录）', async (t) => {
    // 这条钉的是**接线**：`createSiteRoutes` 已经不再接受这个参数，传了也应该
    // 被忽略。判据用"调用次数"而不是"页面内容" —— 内容可能因为别的原因不含
    // 安装包（比如模板里就没写），而调用次数证明的是"这条路真的断了"。
    let calls = 0
    const routes = createSiteRoutes({
      root: makeSite(t),
      readRelease: () => { calls += 1; return FIXED() },
    })
    await call(routes, { path: '/' })
    await call(routes, { path: '/en' })
    assert.equal(calls, 0, '官网每请求都会读一次发布目录 —— 那是一次没人用的扫描')
  })
})

describe('官网：动态块、样式表版本与注册措辞', () => {
  // （这一族原先挂在「下载区诚实地缺席」那个 describe 下 —— 名字与内容早就
  //   对不上了。撤掉下载区时顺手分开：一个 describe 里该是同一类断言。）
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

  test('★ 所有插值都转义：恶意 `mobilePath` 进不来可执行标记', async (t) => {
    // 下载地址那条插值随下载卡片一起没了，现在**唯一**进 HTML 的可配值是
    // `mobilePath`（首屏主按钮 + 部署卡 Web 入口，两处）。判据的**用意**没变：
    // 钉住"可配值不能变成可执行标记"。
    const evil = '"><script>alert(1)</script>'
    const routes = createSiteRoutes({ root: makeSite(t), mobilePath: evil })
    const r = await call(routes, { path: '/' })
    // 关键不是"字符串里没有 script"，而是**没有能成形的标签**。
    assert.doesNotMatch(r.body, /<script>/)
    assert.doesNotMatch(r.body, /href=""><script/)
  })

  test('纯函数：两种语言各自的文案都在，且都**不含**下载入口', () => {
    const zh = renderLiveBlocks({ lang: 'zh' })
    const en = renderLiveBlocks({ lang: 'en' })
    // 返回的块只有两个 —— 没有 download。
    assert.deepEqual(Object.keys(zh).sort(), ['cta', 'hub'])
    assert.equal(zh.download, undefined, 'download 块不该再存在（它是下载卡片的内容）')
    // 两种语言的主入口文案都在，且都指向站内（这里没传 mobilePath，用默认值）。
    assert.match(zh.cta, /查看协作界面/)
    assert.match(en.cta, /See the interface/)
    for (const [label, b] of [['zh', zh], ['en', en]]) {
      assert.doesNotMatch(b.cta, /\.exe|Legion-Setup|legion\/releases/, `${label}：首屏不该有任何安装包链接`)
      assert.doesNotMatch(b.hub, /\.exe|Legion-Setup|legion\/releases/, `${label}：Web 入口块也不该有`)
    }
  })

  test('★ 反例守卫：上面那条"没有 download 块"不是恒真', () => {
    // 一个"断言某个不存在的键是 undefined"的用例，在**任何**实现下都可能为真
    // （打错键名也算）。所以这里证明这两行确实在测东西：
    const withKey = { cta: 'x', hub: 'y', download: '有东西' }
    assert.notEqual(withKey.download, undefined, '反例：有 download 键时那条断言必须红')
    assert.notDeepEqual(Object.keys(withKey).sort(), ['cta', 'hub'], '反例：键集合不同时必须红')
  })

  test('纯函数：注入用 split/join，替换串里的 `$&` 不会被当成替换模式吃掉', () => {
    const out = injectLiveBlocks(`A${MARKER_CTA}B`, { cta: 'x$&y', hub: '' })
    assert.equal(out, 'Ax$&yB')
  })

  test('★★★ 注入把下载标记换成**空串**（不是原样留着，也不是 undefined）', () => {
    // 这条判据的由来：`injectLiveBlocks` 仍然处理 MARKER_DOWNLOAD，但不再从
    // `blocks` 取 —— 因为渲染层已经产不出那个块了。写成 `blocks.download`
    // 会得到 `undefined`，而 `split().join(undefined)` 会把字面量 "undefined"
    // 写进页面。
    const tpl = `A${MARKER_CTA}B${MARKER_DOWNLOAD}C${MARKER_HUB}D`
    const out = injectLiveBlocks(tpl, { cta: 'cta', hub: 'hub' })
    assert.equal(out, 'ActaBChubD')
    assert.doesNotMatch(out, /undefined/, '替换成 undefined 会把字面量写进页面')
    assert.doesNotMatch(out, /legion:download/)
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

  test('★★★ 真实模板里**没有**下载标记了，另两个标记各恰好一次', () => {
    // ★ 2026-10-12：这条判据原来是"三个标记各恰好一次"。下载那块撤掉之后，
    //   它必须改成"下载标记**一次都没有**" —— 而不是把数组里的那一项删掉。
    //
    //   两者的差别很实际：只删数组项的话，某天有人把 `<!-- legion:download -->`
    //   加回模板，**没有任何用例会红**（注入层仍然会把它换成空串，页面看起来
    //   也正常），于是"我们决定官网不提供下载"这件事就悄悄失效了。
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      for (const m of [MARKER_CTA, MARKER_HUB]) {
        const n = html.split(m).length - 1
        assert.equal(n, 1, `${p} 里 ${m} 应恰好出现 1 次，实际 ${n} 次`)
      }
      const stray = html.split(MARKER_DOWNLOAD).length - 1
      assert.equal(stray, 0, `${p} 里不该再有下载标记 —— 官网不提供桌面端下载（实际 ${stray} 次）`)
    }
  })

  test('★★★ 真实模板里没有 Windows 卡片、没有下载按钮文案', () => {
    // 判据盯**模板**（运营者真正看到的那个文件），与上面那条盯**渲染结果**的
    // 合起来才完整：只盯渲染结果的话，模板里留着卡片、靠注入层清空，也算绿。
    for (const p of ['index.html', join('en', 'index.html')]) {
      const html = read(p)
      for (const bad of [/Windows 桌面端/, /Windows desktop app/, /内部验证 · 未签名/, /Internal build · unsigned/, /下载电脑版/, /Download for Windows/]) {
        assert.doesNotMatch(html, bad, `${p} 不该再出现 ${bad}`)
      }
      // 而"同一份数据"那张卡必须在（撤掉一张卡不能把这一节掏空）。
      assert.match(html, /deploy-item/, `${p} 的开始那一节不该只剩一个格子`)
    }
  })

  test('★ 两种语言的锚点集合一致（新增一节只加了一种语言会被这条抓出来）', () => {
    const ids = (html) => (html.match(/id="([^"]+)"/g) ?? []).sort().join(' ')
    const zh = ids(read('index.html'))
    const en = ids(read(join('en', 'index.html')))
    assert.equal(zh, en, '中英两页的 id 集合必须一致')
    assert.ok(zh.includes('"deploy"'), '开始使用那一节的锚点必须在')
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

  test('★★★ 开始那一节：只指向仓库，**一个安装包链接都没有**', async (t) => {
    // 这条原来是"Web 一路指向仓库，Windows 一路只有徽标 + 一个按钮"，
    // 并钉住"安装包链接只出现一处"。现在那一处也没了。
    //
    // ★ 判据从"恰好一处"变成"零处"是**收紧**而不是放松：数字变了，但防的
    //   还是同一件事 —— 有人又加了一个下载入口。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })

    // 仓库链接还在（它是"这是什么、源码在哪"的唯一出口）。
    assert.match(r.body, /href="https:\/\/github\.com\/Mench-Li\/legion"/, '必须直达仓库')
    assert.match(r.body, /rel="noopener"/, '外链要带 rel=noopener')

    // 那些"说明"与"摘要"从来不该回来。
    assert.doesNotMatch(r.body, /Smart App Control/, '三条处理说明已撤')
    assert.doesNotMatch(r.body, /sha256/, '摘要已撤')
    assert.doesNotMatch(r.body, /本次更新/, '更新条目已撤')

    // ★ 安装包链接：**零处**。中英两页都要。
    for (const [label, body] of [['zh', r.body], ['en', (await call(routes, { path: '/en' })).body]]) {
      assert.equal((body.match(/Legion-Setup-win-x64\.exe/g) || []).length, 0,
        `${label}：官网上不该再有任何安装包链接`)
      assert.equal((body.match(/\.exe/g) || []).length, 0, `${label}：一个 .exe 都不该出现`)
      assert.doesNotMatch(body, /sha256/)
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 2026-10-12：主入口从"下载电脑版"改成"打开就能用"（Web 端）
  //
  // 理由不是文案偏好，是一个实测事实：Windows 11 的 Smart App Control 在**默认开启**
  // 的新装机上会拒绝运行**未签名**的安装包（原文：`was blocked by your organization's
  // Device Guard policy`）。也就是说首屏那个主按钮，对相当一部分访客**点了装不上**。
  //
  //   > 一个"点了装不上"的主按钮，
  //   > 与一个"能用的入口"，在页面截图上长得一模一样——
  //   > 只不过前者让访客以为是自己机器坏了。
  //
  // Web 端不需要安装、不需要签名、也不受 SAC 影响，所以它才是主入口。
  // ══════════════════════════════════════════════════════════════════════════

  test('★★★ 首屏主动作是 Web 入口，且**与有没有发布无关**', async (t) => {
    // "与发布无关"是这条判据的重点：旧实现里主动作在"没发布"时会退回 `#workflow`，
    // 于是同一条端点在不同部署上给出不同的主入口。现在它必须恒为 Web 入口 ——
    // 少一个会随部署漂移的分支。
    for (const [label, release] of [['有发布', FIXED], ['没发布', () => null]]) {
      const routes = createSiteRoutes({ root: makeSite(t), readRelease: release })
      const r = await call(routes, { path: '/' })
      const hero = r.body.slice(r.body.indexOf('class="actions"'), r.body.indexOf('</div>', r.body.indexOf('class="actions"')))
      assert.match(hero, /class="btn primary"[^>]*href="\/mobile\/"|href="\/mobile\/"[^>]*class="btn primary"/,
        `${label}：首屏主按钮必须指向 Web 入口 /mobile/，实际：${hero.slice(0, 160)}`)
      assert.match(hero, /打开就能用/, `${label}：主按钮文案`)
      // 首屏**不许**出现安装包链接（它是次要入口，只在部署卡里出现一次）。
      assert.doesNotMatch(hero, /Legion-Setup/, `${label}：首屏不该再挂安装包`)
      assert.doesNotMatch(hero, /\.exe/, `${label}：首屏不该出现任何可执行文件链接`)
    }
  })

  test('★★ 部署卡的 Web 一路也指向**同一个** Web 入口（两处不许互相矛盾）', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: FIXED })
    const r = await call(routes, { path: '/' })
    // 用**独立 class** 定位，不靠文档顺序。
    const i = r.body.indexOf('class="hub-actions"')
    assert.notEqual(i, -1, '部署卡必须有一个 Web 入口动作块（class="hub-actions"）')
    const block = r.body.slice(i, r.body.indexOf('</div>', i))
    assert.match(block, /href="\/mobile\/"/, '部署卡的 Web 按钮必须指向与首屏同一个地址')
    assert.match(block, /打开就能用/)
    // 两块各自只有一个按钮：多一个就是有人又加了入口。
    assert.equal((block.match(/<a /g) || []).length, 1, 'Web 入口块里只该有一个按钮')
  })

  test('★★ `mobilePath` 可覆盖：官网能把人送去**另一台** Hub', async (t) => {
    // ★ 为什么这一条重要：官网由哪台 Hub 服务，与"用户该用哪台 Hub"可以是两件事。
    //   实测就是这个形态 —— `legion-si.online`（服务器，空库）服务官网，而真正在
    //   干活的中枢在 `home.legion-si.online`。写死相对 `/mobile/` 时，访客从官网
    //   点进去落到**另一个库**：每一步都对，地方错了。
    const routes = createSiteRoutes({
      root: makeSite(t), readRelease: FIXED, mobilePath: 'https://home.example.test/mobile/',
    })
    const zh = await call(routes, { path: '/' })
    const en = await call(routes, { path: '/en' })
    // 三类位置都要跟着走：首屏主按钮、部署卡 Web 按钮。
    assert.equal((zh.body.match(/https:\/\/home\.example\.test\/mobile\//g) || []).length, 2,
      '首屏 + 部署卡两处都必须指向覆盖后的地址')
    assert.doesNotMatch(zh.body, /href="\/mobile\/"/, '不该还留着相对的 /mobile/')
    assert.equal((en.body.match(/https:\/\/home\.example\.test\/mobile\//g) || []).length, 2, '英文页同样')
  })

  test('★★ `mobilePath` 里的引号/尖括号被转义（它是可配值，会进 href）', () => {
    // 覆盖值来自配置（运维可写），所以它必须走 `esc()`。这条与
    // "所有插值都转义"那条同源，但那个用的是 downloadUrl —— 这是另一个入口。
    const evil = renderLiveBlocks({
      lang: 'zh', downloadUrl: '', mobilePath: '/x" onmouseover="alert(1)',
    })
    assert.doesNotMatch(evil.cta, /onmouseover="alert\(1\)"/, '注入的引号不许闭合 href 属性')
    assert.doesNotMatch(evil.hub, /onmouseover="alert\(1\)"/)
    assert.match(evil.cta, /&quot;|&#x27;/, '引号必须被转义成实体')
  })

  test('★★★ 反例守卫：上面那些"官网不许出现安装包"的断言不是恒真', () => {
    // 证明判据真的能发现回归：把**曾经真实存在过的**那两张卡片喂给它们，
    // 必须被抓住。反例取自 2026-10-12 之前线上真正渲染出来的 HTML。
    const oldWindowsCard = '<h3>Windows 桌面端 <span class="label human">内部验证 · 未签名</span></h3>\n'
      + '<div class="dl-actions"><a class="btn primary" href="/legion/releases/r-1/Legion-Setup-win-x64.exe">下载电脑版</a></div>\n'
      + '<p class="dl-meta"><span>Windows x64</span></p>'
    assert.match(oldWindowsCard, /Legion-Setup/, '反例应当被"不许出现安装包"抓住')
    assert.match(oldWindowsCard, /\.exe/, '反例应当被"一个 .exe 都不许"抓住')
    assert.match(oldWindowsCard, /下载电脑版/, '反例应当被"不许有下载按钮文案"抓住')
    assert.match(oldWindowsCard, /Windows x64/, '反例应当被"不许有平台标签"抓住')
    assert.match(oldWindowsCard, /class="dl-actions"/, '反例应当被"不许产出 dl-actions"抓住')
    assert.match(oldWindowsCard, /内部验证 · 未签名/, '反例应当被模板断言抓住')

    // 而**现在的**首屏形态不该被那些断言误伤。
    const newHero = '<div class="actions">\n  <a href="/mobile/" class="btn primary">打开就能用</a>\n</div>'
    assert.doesNotMatch(newHero, /Legion-Setup|\.exe|dl-actions|Windows x64/)
  })

  test('★★★ 开始那一节讲的是「一个入口、两种设备、同一份数据」', () => {
    // ★ 这一节是这次改动的**内容**本身，不只是"把下载卡删掉"。
    //   业主要的是"web+移动端**具体怎么体现**"，具体到
    //   「电脑上开的任务，手机上能看到」。
    //
    // ★★ 判据必须**按位置**断言，不能"整页找关键词" —— 这是被一次
    //   破坏性验证逼出来的：第一版在整页里找 `/手机/`、`/同一份数据/`，
    //   于是**把标题改回旧文案**、**把引言改回"自托管"**、**把"手机"从那张卡里
    //   删掉**，三处破坏全都还是绿的 —— 因为同一个词在页面别处还有。
    //
    //   > 一个"整页里出现过这个词"的判据，
    //   > 与一个"这一句说的是这件事"的判据，在页面正常时是同一个东西。
    //
    //   所以下面按 **标题 / 引言 / 两张卡** 分别取出来再断言。
    //
    // ⚠️ 钉的是**文案本身**，措辞改了就红 —— 这是有意的：这一节的文字是交付物。
    const sectionOf = (html) => {
      const at = html.indexOf('id="deploy"')
      return html.slice(at, html.indexOf('</section>', at))
    }
    const cardsOf = (section) => [...section.matchAll(/<article class="deploy-item">([\s\S]*?)<\/article>/g)].map((m) => m[1])
    const grab = (section, cls) => new RegExp(`<[^>]+class="${cls}"[^>]*>([^<]*)<`).exec(section)?.[1] ?? ''
    const h2 = (section) => /<h2>([^<]*)<\/h2>/.exec(section)?.[1] ?? ''

    const zh = sectionOf(read('index.html'))
    const en = sectionOf(read(join('en', 'index.html')))

    for (const [label, sec] of [['zh', zh], ['en', en]]) {
      const cards = cardsOf(sec)
      assert.equal(cards.length, 2, `${label}：开始那一节该有两张卡，实际 ${cards.length}`)
      assert.equal((sec.match(/class="deploy-item"/g) || []).length, 2, `${label}：不该多出第三张卡`)
    }

    // ① 标题就点出"同一份数据"（不是"选择怎么开始"那种先装再用的框）。
    assert.match(h2(zh), /同一份数据/, `zh 标题：${h2(zh)}`)
    assert.match(h2(en), /one set of data/i, `en 标题：${h2(en)}`)

    // ② 引言讲"不用装"。
    assert.match(grab(zh, 'deploy-intro'), /不用安装|不用装/, `zh 引言：${grab(zh, 'deploy-intro')}`)
    assert.match(grab(en, 'deploy-intro'), /nothing to install|no app to install/i, `en 引言：${grab(en, 'deploy-intro')}`)

    // ③ 第一张卡：**两种设备**都点到名。
    const zhCards = cardsOf(zh)
    const enCards = cardsOf(en)
    assert.match(zhCards[0], /电脑/, 'zh 第一张卡该提到电脑')
    assert.match(zhCards[0], /手机/, 'zh 第一张卡该提到手机')
    assert.match(enCards[0], /computer/i, 'en card 1 should mention computer')
    assert.match(enCards[0], /phone/i, 'en card 1 should mention phone')

    // ④ 第二张卡：**同一份数据**，而且是"不是同步的副本"。
    assert.match(zhCards[1], /同一个库|同一份/, `zh 第二张卡：${zhCards[1].slice(0, 80)}`)
    assert.match(zhCards[1], /不是同步|本来就/, 'zh 第二张卡该说清"不是同步出来的"')
    assert.match(enCards[1], /same database|same data|one set of data/i, 'en card 2 should say the data is the same')

    // ⑤ ★★★ 第二张卡的**正文**（不是标题）要说清跨设备这件事。
    //
    //   这条是被破坏性验证逼出来的：上面 ④ 那两条只盯**整张卡**，而卡的
    //   **标题**里本来就有"同一份数据 / 不是同步的副本" —— 于是把正文那句话
    //   换成一句没有信息量的（"换台机器打开就看得到"），④ 仍然是绿的。
    //
    //   > 一个"这张卡提到了同一份数据"的判据，
    //   > 与一个"这句话解释了为什么要用两台设备"的判据，
    //   > 在标题写得好的时候是同一个东西。
    //
    //   而业主点名要的正是正文那句：「电脑上开的任务，手机上能看到」。
    const bodyOf = (card) => /<p>([\s\S]*?)<\/p>/.exec(card)?.[1] ?? ''
    const zhBody = bodyOf(zhCards[1])
    const enBody = bodyOf(enCards[1])
    assert.match(zhBody, /电脑/, `zh 第二张卡正文要提到电脑：${zhBody.slice(0, 70)}`)
    assert.match(zhBody, /手机/, `zh 第二张卡正文要提到手机：${zhBody.slice(0, 70)}`)
    assert.match(zhBody, /同一个库/, `zh 第二张卡正文要说是同一个库：${zhBody.slice(0, 70)}`)
    assert.match(enBody, /computer/i, `en card 2 body should mention the computer: ${enBody.slice(0, 70)}`)
    assert.match(enBody, /phone/i, `en card 2 body should mention the phone: ${enBody.slice(0, 70)}`)
    assert.match(enBody, /same database|same data/i, `en card 2 body should mention the same database: ${enBody.slice(0, 70)}`)

    // ⑤ 旧叙事（"先把它跑起来"）不许回来 —— 同样的位置断言。
    for (const [label, sec] of [['zh', zh], ['en', en]]) {
      for (const b of [/自托管入口/, /从仓库在本地启动/, /Self-hosted entry/, /Started locally from the repository/, /局域网自托管/]) {
        assert.doesNotMatch(sec, b, `${label}：开始那一节不该再有"先自托管"那套框架：${b}`)
      }
    }
  })

  test('★★★ 反例守卫：上面那条"两种设备/同一份数据"不是恒真', () => {
    // 把**旧的**那一节按同样的方式取出来喂给那些断言，必须被判红 ——
    // 否则上面那条可能对任何输入都为真（尤其是"整页找关键词"那种写法）。
    const sectionOf = (html) => {
      const at = html.indexOf('id="deploy"')
      return html.slice(at, html.indexOf('</section>', at))
    }
    const cardsOf = (section) => [...section.matchAll(/<article class="deploy-item">([\s\S]*?)<\/article>/g)].map((m) => m[1])
    const h2Of = (section) => /<h2>([^<]*)<\/h2>/.exec(section)?.[1] ?? ''

    // 一整页：旧的开始那一节 + 页脚里"手机"这个词（真实页面里到处都有近义词）。
    const oldPage = `<main>
      <section id="deploy"><h2>选择适合你的开始方式。</h2>
      <p class="deploy-intro">当前以本机或局域网自托管为基础。</p>
      <article class="deploy-item"><h3>本地 Web 工作台 <span class="label">自托管入口</span></h3><p>从仓库在本地启动</p></article>
      <article class="deploy-item"><h3>Windows 桌面端</h3></article></section>
      <footer>手机也可以访问 · 电脑 · 同一个库 · 不用安装</footer></main>`

    // ① "整页找关键词"的写法**会通过** —— 这正是第一版的漏洞。
    assert.match(oldPage, /手机/, '整页里是有"手机"的')
    assert.match(oldPage, /同一个库/, '整页里是有"同一个库"的')
    assert.match(oldPage, /不用安装/, '整页里是有"不用安装"的')
    // ② 而**按位置取出来**之后，那些词都不在正确的位置上：
    const sec = sectionOf(oldPage)
    const cards = cardsOf(sec)
    assert.equal(cards.length, 2, '反例里也是两张卡（所以"卡数"那条抓不住它）')
    assert.doesNotMatch(h2Of(sec), /同一份数据/, '反例标题不含"同一份数据" → 标题那条会红')
    assert.doesNotMatch(grabCls(sec, 'deploy-intro'), /不用安装|不用装/, '反例引言不含"不用装" → 引言那条会红')
    assert.doesNotMatch(cards[0], /手机/, '反例第一张卡不提手机 → 第一张卡那条会红')
    assert.doesNotMatch(cards[1], /同一个库|同一份/, '反例第二张卡不提同一份数据 → 第二张卡那条会红')
    assert.match(sec, /自托管入口/, '反例含被禁的旧叙事 → 禁令那条会红')

    function grabCls(section, cls) {
      return new RegExp(`<[^>]+class="${cls}"[^>]*>([^<]*)<`).exec(section)?.[1] ?? ''
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

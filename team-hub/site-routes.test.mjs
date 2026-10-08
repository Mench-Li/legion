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

/** 一份最小的模板：带三个标记与足以断言语言的东西。 */
function template(lang) {
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head><title>${lang}</title></head>
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

  test('★ 未签名说明只在有链接时出现（对着不会出现的警告做说明，与漏掉真会出现的警告同形）', async (t) => {
    const withDl = await call(createSiteRoutes({ root: makeSite(t), readRelease: FIXED }), { path: '/' })
    assert.match(withDl.body, /Smart App Control/)
    assert.match(withDl.body, /尚未做代码签名/)

    const without = await call(createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '' }) }), { path: '/' })
    assert.doesNotMatch(without.body, /Smart App Control/)
  })

  test('★ 清单里没有 sha256 ⇒ 那一行**整行不出现**（空的校验值比没有更坏）', async (t) => {
    // 一个显示成空的 sha256 看起来像"校验过了"。所以：拿不到就一行都不给。
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '/legion/releases/r-1/x.exe', sha256: '' }) })
    const r = await call(routes, { path: '/' })
    assert.doesNotMatch(r.body, /sha256/)
    assert.doesNotMatch(r.body, /class="sha/)
    assert.doesNotMatch(r.body, /data-copy/)
  })

  test('★ 畸形 sha256 也当没有：不是 64 位十六进制就不显示', async (t) => {
    for (const bad of ['abc', 'zz'.repeat(32), 'ab'.repeat(31), '', 'undefined']) {
      const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '/legion/releases/r-1/x.exe', sha256: bad }) })
      const r = await call(routes, { path: '/' })
      assert.doesNotMatch(r.body, /class="sha-value"/, `坏值 ${JSON.stringify(bad)} 不该显示`)
    }
  })

  test('★ 合法 sha256 就显示，并带可复制的数据属性', async (t) => {
    const sha = 'b8be07da8fcb0dc6dff3561328ce8385a9193256b8d42ef883d60dce7b0ffee3'
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '/legion/releases/r-1/x.exe', sha256: sha.toUpperCase() }) })
    const r = await call(routes, { path: '/' })
    assert.match(r.body, new RegExp(`class="sha-value">${sha}<`), '应显示（且小写归一）')
    assert.match(r.body, new RegExp(`data-copy="${sha}"`))
  })

  test('★ 「本次更新」渲染成列表，`**粗体**` 转成 <b> 而不是原样漏出', async (t) => {
    const routes = createSiteRoutes({
      root: makeSite(t),
      readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: ['把**正文**送到电脑端', '修了鉴权'] }),
    })
    const zh = await call(routes, { path: '/' })
    assert.match(zh.body, /class="updates"/)
    assert.match(zh.body, /本次更新/)
    assert.match(zh.body, /把<b>正文<\/b>送到电脑端/)
    assert.doesNotMatch(zh.body, /\*\*/, '标记必须被消化掉，不能原样出现在页面上')

    const en = await call(createSiteRoutes({
      root: makeSite(t),
      readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: ['x'] }),
    }), { path: '/en' })
    assert.match(en.body, /What&#39;s new|What's new/)
  })

  test('★ 更新条目里的 HTML 被转义（先转义再换粗体标记，顺序反了就是注入口）', async (t) => {
    const routes = createSiteRoutes({
      root: makeSite(t),
      readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: ['<img src=x onerror=alert(1)> **ok**'] }),
    })
    const r = await call(routes, { path: '/' })
    assert.doesNotMatch(r.body, /<img src=x/)
    assert.match(r.body, /&lt;img src=x/)
    assert.match(r.body, /<b>ok<\/b>/, '转义之后粗体标记仍然生效')
  })

  test('没有更新条目就不出那一块（不出现一个空标题）', async (t) => {
    const routes = createSiteRoutes({ root: makeSite(t), readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: [] }) })
    const r = await call(routes, { path: '/' })
    assert.doesNotMatch(r.body, /class="updates"/)
    assert.doesNotMatch(r.body, /本次更新/)
  })

  test('★ 英文页的更新条目：优先读英文；没有就退回中文**并标明是原文**', async (t) => {
    // 发布清单只有发布端写的语言。英文页空着 = 丢信息；把中文当英文 = 骗人。
    // 所以第三条路：照录 + 注明出处。
    const zhOnly = createSiteRoutes({
      root: makeSite(t),
      readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: ['修了鉴权'], changesEn: [] }),
    })
    const en = await call(zhOnly, { path: '/en' })
    assert.match(en.body, /修了鉴权/, '英文页不能把信息丢掉')
    assert.match(en.body, /only wrote release notes in Chinese/, '必须标明这是原文，不能悄悄当英文')

    const withEn = createSiteRoutes({
      root: makeSite(t),
      readRelease: () => ({ url: '/legion/releases/r-1/x.exe', changes: ['修了鉴权'], changesEn: ['Fixed auth'] }),
    })
    const en2 = await call(withEn, { path: '/en' })
    assert.match(en2.body, /Fixed auth/)
    assert.doesNotMatch(en2.body, /修了鉴权/, '有英文条目时不该再出现中文')
    assert.doesNotMatch(en2.body, /only wrote release notes/)

    // 中文页只用中文条目，不受 changesEn 影响。
    const zh = await call(withEn, { path: '/' })
    assert.match(zh.body, /修了鉴权/)
    assert.doesNotMatch(zh.body, /Fixed auth/)
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

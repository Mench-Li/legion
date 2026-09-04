// workbench/scripts/web.test.mjs — 浏览器助手 fetch 代理契约测试（对齐 docs/TEST_CASES.md TC-S6-01..16）。
// 运行：node workbench/scripts/web.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test）
// 禁网说明：抓取目标一律用本进程内 mock HTTP 服务（127.0.0.1）；SSRF 守卫的测试注入口
// DSH_WEB_FETCH_ALLOW_PRIVATE=1 只在本测试内使用，生产默认关闭（见 serve.mjs 注释与 TEST_CASES §8.1）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const serveUrl = pathToFileURL(require.resolve('./serve.mjs')).href + '?web=' + Date.now()
const m = await import(serveUrl)

const htmlPage = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>测试标题</title>
<style>.x{}</style><script>window.x=1</script></head><body>
<h1>一级标题</h1><p>这是正文关键句：中文内容验证。</p><p>第二段文字。</p>
<a href="/rel">相对链接</a><a href="https://example.com/abs">绝对链接</a><a href="javascript:void(0)">js</a>
</body></html>`
const spaShell = `<!doctype html><html><head><title></title></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>`
const binBody = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]) // %PDF-1.

let hits = 0
const mock = createServer((req, res) => {
  hits += 1
  const u = new URL(req.url ?? '/', 'http://x')
  if (u.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(htmlPage) }
  else if (u.pathname === '/spa') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(spaShell) }
  else if (u.pathname === '/max') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('a'.repeat(2048)) }
  else if (u.pathname === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('slow done') }, 3000) }
  else if (u.pathname === '/fast') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fast done') }, 80) }
  else if (u.pathname === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(binBody) }
  else if (u.pathname === '/404') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<p>not found page</p>') }
  else if (u.pathname === '/500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom') }
  else if (u.pathname === '/r1') { res.writeHead(302, { location: '/r2' }); res.end() }
  else if (u.pathname === '/r2') { res.writeHead(302, { location: '/page' }); res.end() }
  else if (u.pathname === '/loop') { res.writeHead(302, { location: '/loop' }); res.end() }
  else if (u.pathname === '/tofile') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end() }
  // P0-3 回归：延迟重定向链 c1(700ms)→c2(700ms)→/page（每跳都短于总超时，整链更长）
  else if (u.pathname === '/c1') { setTimeout(() => { res.writeHead(302, { location: '/c2' }); res.end() }, 700) }
  else if (u.pathname === '/c2') { setTimeout(() => { res.writeHead(302, { location: '/page' }); res.end() }, 700) }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('ok') }
})

let port = 0
let base = ''
before(async () => {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', () => { port = mock.address().port; base = 'http://127.0.0.1:' + port; resolve() }))
})
after(() => {
  mock.close()
  delete process.env.DSH_WEB_FETCH_ALLOW_PRIVATE
})

describe('TC-S6-01/02 正文抽取（HTML + UTF-8 中文）', () => {
  it('提取 title/正文/链接，中文无乱码；返回结构无原始 HTML', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1' // 仅测试用：目标为本地 mock
    const r = await m.webFetch({ url: base + '/page' })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.ok(r.contentType.includes('text/html'))
    assert.equal(r.title, '测试标题')
    assert.ok(r.text.includes('正文关键句：中文内容验证'), '正文含关键句且中文无乱码：' + JSON.stringify(r.text.slice(0, 80)))
    assert.ok(r.text.includes('一级标题'))
    assert.ok(r.excerpt.length > 0)
    const links = r.links
    assert.ok(links.includes(base + '/rel'), '相对链接已绝对化')
    assert.ok(links.includes('https://example.com/abs'), '绝对链接保留')
    assert.ok(!links.some(l => l.startsWith('javascript:')), 'javascript: 链接不出现')
    const blob = JSON.stringify(r)
    assert.ok(!blob.includes('<script>'), '无原始 HTML/脚本透传（TC-S6-10）')
    assert.ok(!('html' in r))
  })
})

describe('TC-S6-03 SPA 空壳', () => {
  it('JS 渲染页 → 可理解提示且不伪造正文', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const r = await m.webFetch({ url: base + '/spa' })
    assert.equal(r.ok, true)
    assert.equal(r.text, '')
    assert.equal(r.title, '')
    assert.ok((r.error ?? '').includes('无法抽取') || (r.error ?? '').includes('JS 渲染'), 'error 说明 JS 渲染/SPA 边界')
    assert.equal(r.code, 'empty_content')
  })
})

describe('TC-S6-04 协议白名单', () => {
  it('file/ftp/data/javascript 等协议一律 protocol_blocked', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,hi', 'javascript:alert(1)', 'gopher://x/1']) {
      await assert.rejects(() => m.webFetch({ url: u }), (e) => e.code === 'protocol_blocked' && /协议白名单|仅支持 http/.test(e.message), u)
    }
  })
  it('缺 url → invalid_url', async () => {
    await assert.rejects(() => m.webFetch({}), (e) => e.code === 'invalid_url')
  })
})

describe('TC-S6-05 私网/回环矩阵（含混淆）→ ssrf_blocked，mock 零命中', () => {
  it('默认策略（无注入口）拒绝全部私网目标', async () => {
    delete process.env.DSH_WEB_FETCH_ALLOW_PRIVATE
    const hitsBefore = hits
    const targets = [
      'http://127.0.0.1:' + port + '/page',
      'http://127.1/page',
      'http://localhost:' + port + '/page',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://172.31.255.1/',
      'http://192.168.1.1/',
      'http://169.254.1.1/',
      'http://0.0.0.0/',
      'http://[::1]:' + port + '/page',
      'http://[fc00::1]/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://017700000001/',
    ]
    for (const t of targets) {
      await assert.rejects(() => m.webFetch({ url: t }), (e) => e.code === 'ssrf_blocked', 'target: ' + t)
    }
    // 解析失败的域名 → dns_error 而非裸异常
    await assert.rejects(() => m.webFetch({ url: 'http://no-such-host-zzz.invalid/' }), (e) => e.code === 'dns_error')
    assert.equal(hits, hitsBefore, 'SSRF 阻断后无任何到 mock 的外呼')
  })
})

describe('TC-S6-06 重定向链（逐跳校验 + 上限 + 协议再检）', () => {
  it('302 链跟随到最终页并抽取；跳数超限 → too_many_redirects；重定向到 file:// → ssrf_blocked', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const r = await m.webFetch({ url: base + '/r1' })
    assert.equal(r.ok, true)
    assert.equal(r.title, '测试标题')
    assert.equal(r.finalUrl, base + '/page')
    const loop = await m.webFetch({ url: base + '/loop' }).catch(e => e)
    assert.equal(loop.code, 'too_many_redirects')
    const toFile = await m.webFetch({ url: base + '/tofile' }).catch(e => e)
    assert.equal(toFile.code, 'ssrf_blocked')
  })
})

describe('TC-S6-08/09 maxBytes / timeoutMs 三值注入', () => {
  it('maxBytes=2048 ok；maxBytes=1024 → too_large', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const ok = await m.webFetch({ url: base + '/max', maxBytes: 2048 })
    assert.equal(ok.ok, true)
    assert.ok(ok.text.length >= 2040, '长文本不截断字段（全量入 text 受 MAX_TEXT 保护）')
    const big = await m.webFetch({ url: base + '/max', maxBytes: 1024 }).catch(e => e)
    assert.equal(big.code, 'too_large')
  })
  it('慢响应 timeoutMs=200 → timeout；快响应同超时 → ok（超时后连接被取消）', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const slow = await m.webFetch({ url: base + '/slow', timeoutMs: 200 }).catch(e => e)
    assert.equal(slow.code, 'timeout')
    const fast = await m.webFetch({ url: base + '/fast', timeoutMs: 2000 })
    assert.equal(fast.ok, true)
    assert.equal(fast.text, 'fast done')
  })
})

describe('TC-S6-09b（P0-3 回归）重定向链总超时 = 共享 deadline，非每跳重置', () => {
  it('每跳均短于总超时但整链更长 → code=timeout，总耗时 ≈ timeoutMs（修复前 ok:true 于 ~2× 后返回）', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const t0 = Date.now()
    const e = await m.webFetch({ url: base + '/c1', timeoutMs: 1000 }).catch(e => e)
    const elapsed = Date.now() - t0
    assert.equal(e.code, 'timeout', '整链累计超时必须在总超时处截止（P0-3：此前每跳重开计时）')
    assert.ok(elapsed >= 800 && elapsed < 3000, '总耗时落在单次预算区间而非 每跳×N（实际 ' + elapsed + 'ms）')
  })
  it('同链在充足总超时下正常跟随到底并抽取终页（共享 deadline 不误伤合法链）', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const r = await m.webFetch({ url: base + '/c1', timeoutMs: 4000 })
    assert.equal(r.ok, true)
    assert.equal(r.finalUrl, base + '/page')
    assert.equal(r.title, '测试标题')
  })
})

describe('TC-S6-11/12 非文本降级与上游 4xx/5xx', () => {
  it('application/pdf → ok:true + code=unsupported，不读体不抽取', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const r = await m.webFetch({ url: base + '/pdf' })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'unsupported')
    assert.equal(r.text, '')
  })
  it('404/500 → ok:false + code=http_404/http_500 且可读说明', async () => {
    process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
    const nf = await m.webFetch({ url: base + '/404' })
    assert.equal(nf.ok, false)
    assert.equal(nf.code, 'http_404')
    assert.ok(nf.error.includes('not found page'))
    const ise = await m.webFetch({ url: base + '/500' })
    assert.equal(ise.ok, false)
    assert.equal(ise.code, 'http_500')
  })
})
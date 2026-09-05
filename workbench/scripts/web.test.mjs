// workbench/scripts/web.test.mjs — 浏览器助手 fetch 代理契约测试（对齐 docs/TEST_CASES.md TC-S6-01..16）。
// S2（R-A3/R-A4/G-11）：文末追加 审计留痕（真实 HTTP）/容量轮转/body stall 归类/错误码枚举表收口 用例（serve.mjs data 目录）。
// 运行：node workbench/scripts/web.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test）
// 禁网说明：抓取目标一律用本进程内 mock HTTP 服务（127.0.0.1）；SSRF 守卫的测试注入口
// DSH_WEB_FETCH_ALLOW_PRIVATE=1 只在本测试内使用，生产默认关闭（见 serve.mjs 注释与 TEST_CASES §8.1）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'

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
  // S2/R-A4：body stall 夹具——headers 已回（200 text/plain）、body 写一段后挂起不再 end
  else if (u.pathname === '/stall') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial body, never ends') }
  // TC-S2-06：5xx body stall 夹具——writeHead(500) 后写 partial、永不 end（错误分类与状态码无关，body 未读完即超时 → timeout）
  else if (u.pathname === '/stall5xx') { res.writeHead(500, { 'content-type': 'text/html' }); res.write('<p>partial 5xx body, never ends') }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('ok') }
})

let port = 0
let base = ''
before(async () => {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', () => { port = mock.address().port; base = 'http://127.0.0.1:' + port; resolve() }))
})
after(() => {
  mock.close()
  try { if (m.server.listening) m.server.close() } catch { /* 未起/已关 */ }
  delete process.env.DSH_WEB_FETCH_ALLOW_PRIVATE
  delete process.env.DSH_WEB_AUDIT_FILE
  delete process.env.DSH_WEB_AUDIT_MAX_BYTES
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

// ─────────────────── S2（R-A3/R-A4/G-11）：抓取审计留痕 + body stall 归类 + 错误码枚举收口 ───────────────────
// 说明：审计/枚举经「真实 HTTP POST /api/web/fetch」验证——serve.mjs 导出 server（isMain 守卫不占端口），
// 测试进程内监听；审计文件与轮转上限经 DSH_WEB_AUDIT_FILE / DSH_WEB_AUDIT_MAX_BYTES 注入到临时 data 文件。
let auditSeq = 0
function tmpAuditFile() {
  auditSeq += 1
  return join(dirname(require.resolve('./serve.mjs')), '..', 'data', 'web-audit.s2.' + process.pid + '.' + auditSeq + '.jsonl')
}
function rmQuiet(fp) { try { if (fp) unlinkSync(fp) } catch { /* 不存在/占用忽略 */ } }
function readAuditLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}
let webBase = ''
/** 经 serve.mjs 真实 HTTP 层发一次抓取；env（审计路径/轮转上限/私网放行）在请求处理期间生效，返回 200-envelope JSON。 */
async function postWebFetch(payload, { auditFile = null, auditMax = null, allowPrivate = true } = {}) {
  if (auditFile) process.env.DSH_WEB_AUDIT_FILE = auditFile
  else delete process.env.DSH_WEB_AUDIT_FILE
  if (auditMax) process.env.DSH_WEB_AUDIT_MAX_BYTES = String(auditMax)
  else delete process.env.DSH_WEB_AUDIT_MAX_BYTES
  if (allowPrivate) process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
  else delete process.env.DSH_WEB_FETCH_ALLOW_PRIVATE
  try {
    const resp = await fetch(webBase + '/api/web/fetch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return await resp.json()
  } finally {
    delete process.env.DSH_WEB_AUDIT_FILE
    delete process.env.DSH_WEB_AUDIT_MAX_BYTES
    delete process.env.DSH_WEB_FETCH_ALLOW_PRIVATE
  }
}
async function startServe() {
  if (!m.server.listening) await new Promise((resolve) => m.server.listen(0, '127.0.0.1', () => resolve()))
  webBase = 'http://127.0.0.1:' + m.server.address().port
}

describe('S2-R-A3 抓取审计留痕（真实 HTTP /api/web/fetch 集成）', () => {
  before(startServe)
  after(() => { try { if (m.server.listening) m.server.close() } catch { /* */ } })

  it('成功抓取留痕：追加一行含 url/finalUrl/status/耗时 ms/by=general', async () => {
    const file = tmpAuditFile()
    try {
      const r = await postWebFetch({ url: base + '/page' }, { auditFile: file })
      assert.equal(r.ok, true)
      const lines = readAuditLines(file)
      assert.equal(lines.length, 1, '一次抓取恰一行审计')
      const a = lines[0]
      assert.equal(a.by, 'general')
      assert.equal(a.url, base + '/page')
      assert.equal(a.finalUrl, base + '/page')
      assert.equal(a.status, 200)
      assert.equal(a.ok, true)
      assert.ok(a.ms !== undefined && Number.isFinite(a.ms) && a.ms >= 0, '耗时 ms 数值：' + a.ms)
      assert.ok(a.ts && a.ts.length > 0, '带时间戳 ts')
    } finally { rmQuiet(file) }
  })

  it('失败留痕：http_404/http_500 各一行（url/finalUrl/status=上游码/code=http_<n>）', async () => {
    const file = tmpAuditFile()
    try {
      const nf = await postWebFetch({ url: base + '/404' }, { auditFile: file })
      assert.equal(nf.ok, false)
      assert.equal(nf.code, 'http_404')
      const ise = await postWebFetch({ url: base + '/500' }, { auditFile: file })
      assert.equal(ise.code, 'http_500')
      const lines = readAuditLines(file)
      assert.equal(lines.length, 2)
      assert.equal(lines[0].code, 'http_404'); assert.equal(lines[0].status, 404); assert.equal(lines[0].ok, false)
      assert.equal(lines[0].url, base + '/404'); assert.equal(lines[0].finalUrl, base + '/404')
      assert.equal(lines[1].code, 'http_500'); assert.equal(lines[1].status, 500)
    } finally { rmQuiet(file) }
  })

  it('拦截亦留痕：ssrf_blocked 一行含目标 URL（ok=false, by=general）', async () => {
    const file = tmpAuditFile()
    try {
      const target = 'http://10.0.0.1/private-path'
      const r = await postWebFetch({ url: target }, { auditFile: file, allowPrivate: false })
      assert.equal(r.ok, false)
      assert.equal(r.code, m.WEB_ERR.SSRF_BLOCKED)
      const a = readAuditLines(file)[0]
      assert.equal(a.code, m.WEB_ERR.SSRF_BLOCKED)
      assert.equal(a.url, target, 'SSRF 拦截留痕含目标 URL')
      assert.equal(a.ok, false)
      assert.equal(a.by, 'general')
    } finally { rmQuiet(file) }
  })

  it('失败留痕：timeout（headers 未回 /slow）与 too_large 各一行，code 取枚举表值', async () => {
    const file = tmpAuditFile()
    try {
      const slow = await postWebFetch({ url: base + '/slow', timeoutMs: 200 }, { auditFile: file })
      assert.equal(slow.ok, false)
      assert.equal(slow.code, m.WEB_ERR.TIMEOUT)
      const big = await postWebFetch({ url: base + '/max', maxBytes: 1024 }, { auditFile: file })
      assert.equal(big.code, m.WEB_ERR.TOO_LARGE)
      const lines = readAuditLines(file)
      assert.equal(lines.length, 2)
      assert.equal(lines[0].code, m.WEB_ERR.TIMEOUT); assert.equal(lines[0].url, base + '/slow'); assert.equal(lines[0].status, null)
      assert.equal(lines[1].code, m.WEB_ERR.TOO_LARGE); assert.equal(lines[1].url, base + '/max')
    } finally { rmQuiet(file) }
  })
})

describe('S2-R-A4 body stall 归类（headers 已回、body 挂起）与整链超时同码', () => {
  before(startServe)
  after(() => { try { if (m.server.listening) m.server.close() } catch { /* */ } })

  it('body stall 夹具 → {ok:false, code:timeout}（非 web_error/undefined），审计同码', async () => {
    const file = tmpAuditFile()
    try {
      const t0 = Date.now()
      const r = await postWebFetch({ url: base + '/stall', timeoutMs: 500 }, { auditFile: file })
      const elapsed = Date.now() - t0
      assert.equal(r.ok, false)
      assert.equal(r.code, m.WEB_ERR.TIMEOUT, 'body stall 归类 timeout（修复前误归类 web_error/code=undefined）')
      assert.ok(elapsed >= 250 && elapsed < 5000, '在超时窗内截止（实际 ' + elapsed + 'ms）')
      const a = readAuditLines(file)[0]
      assert.equal(a.code, m.WEB_ERR.TIMEOUT)
      assert.equal(a.finalUrl, base + '/stall')
      assert.equal(a.url, base + '/stall')
    } finally { rmQuiet(file) }
  })

  it('TC-S2-06：5xx body stall（/stall5xx）→ 同样 {ok:false, code:timeout}（修复前误归类 http_500），审计保留实际上游 status=500', async () => {
    const file = tmpAuditFile()
    try {
      const t0 = Date.now()
      const r = await postWebFetch({ url: base + '/stall5xx', timeoutMs: 500 }, { auditFile: file })
      const elapsed = Date.now() - t0
      assert.equal(r.ok, false)
      assert.equal(r.code, m.WEB_ERR.TIMEOUT, '5xx body stall 归类 timeout（错误分类以 body 未读完即超时为唯一判据，与状态码无关）')
      assert.ok(elapsed >= 250 && elapsed < 5000, '在超时窗内截止（实际 ' + elapsed + 'ms）')
      const a = readAuditLines(file)[0]
      assert.equal(a.code, m.WEB_ERR.TIMEOUT)
      assert.equal(a.status, 500, '审计保留实际上游状态码供定位')
      assert.equal(a.finalUrl, base + '/stall5xx')
      assert.equal(a.url, base + '/stall5xx')
    } finally { rmQuiet(file) }
  })

  it('整链超时（重定向链累计）HTTP 层同样返回 code=timeout（同码收口）', async () => {
    const file = tmpAuditFile()
    try {
      const r = await postWebFetch({ url: base + '/c1', timeoutMs: 1000 }, { auditFile: file })
      assert.equal(r.ok, false)
      assert.equal(r.code, m.WEB_ERR.TIMEOUT, '整链超时与 body stall 同码 timeout')
      const a = readAuditLines(file)[0]
      assert.equal(a.code, m.WEB_ERR.TIMEOUT)
      assert.equal(a.finalUrl, base + '/c2', '审计 finalUrl = 失败一跳')
      assert.ok(a.ms >= 700, 'ms 反映整链累计耗时：' + a.ms)
    } finally { rmQuiet(file) }
  })
})

describe('S2-R-A3c（TC-S2-10）参数级失败（url 缺失/非字符串/解析失败）不产生审计行', () => {
  // 与 TC-S2-02「发起后拦截须留痕」（ssrf_blocked 等）分界：参数级失败未构成一次抓取（无 url 可请求），
  // 不落审计行；判据「未发起实际抓取不产生审计行」（R-A3 边界；OQ-7）。
  before(startServe)
  after(() => { try { if (m.server.listening) m.server.close() } catch { /* */ } })

  it('url="" 与 url=123 → 200-envelope {ok:false, code:invalid_url}，审计文件零新增（修复前各落一行）', async () => {
    const file = tmpAuditFile()
    try {
      const empty = await postWebFetch({ url: '' }, { auditFile: file })
      assert.equal(empty.ok, false)
      assert.equal(empty.code, m.WEB_ERR.INVALID_URL)
      const num = await postWebFetch({ url: 123 }, { auditFile: file })
      assert.equal(num.ok, false)
      assert.equal(num.code, m.WEB_ERR.INVALID_URL)
      assert.ok(!existsSync(file), '参数级失败不产生审计行（文件不应被创建/追加）')
    } finally { rmQuiet(file) }
  })

  it('解析失败（http://）同样不落审计行；同路径下真实抓取/拦截仍留痕（机制未被误伤）', async () => {
    const file = tmpAuditFile()
    try {
      const bad = await postWebFetch({ url: 'http://' }, { auditFile: file })
      assert.equal(bad.code, m.WEB_ERR.INVALID_URL)
      assert.ok(!existsSync(file), '解析失败不产生审计行')
      const ok = await postWebFetch({ url: base + '/page' }, { auditFile: file })
      assert.equal(ok.ok, true)
      const blocked = await postWebFetch({ url: 'http://10.1.2.3/x' }, { auditFile: file, allowPrivate: false })
      assert.equal(blocked.code, m.WEB_ERR.SSRF_BLOCKED)
      const lines = readAuditLines(file)
      assert.equal(lines.length, 2, '随后真实抓取 + 拦截各留痕一行（共 2）')
      assert.equal(lines[0].code, 'ok')
      assert.equal(lines[1].code, m.WEB_ERR.SSRF_BLOCKED)
    } finally { rmQuiet(file) }
  })
})

describe('S2-R-A3b 审计文件默认位置（静态 ROOT 之外）与容量轮转；workbench/.gitignore', () => {
  it('web-audit.jsonl 默认位于 ROOT（workbench/dist）之外，且 .gitignore 含 data/ 条目', () => {
    const scriptsDir = dirname(require.resolve('./serve.mjs'))
    const root = join(scriptsDir, '..', 'dist')
    const def = m.WEB_AUDIT.DEFAULT_FILE
    assert.equal(def, join(scriptsDir, '..', 'data', 'web-audit.jsonl'))
    assert.ok(!(def === root || def.startsWith(root + sep)), '审计文件必须位于静态 ROOT 之外（ROOT=' + root + '，DEFAULT_FILE=' + def + '）')
    assert.equal(m.WEB_AUDIT.BY, 'general')
    const gi = readFileSync(join(scriptsDir, '..', '.gitignore'), 'utf8')
    assert.ok(gi.split(/\r?\n/).some((l) => l.trim() === 'data/'), 'workbench/.gitignore 含 data/ 条目')
  })

  it('容量轮转：主文件超上限 → 归档 .1 保留历史，新行继续落到有界的主文件', async () => {
    await startServe()
    const file = tmpAuditFile()
    const cap = 700
    try {
      for (let i = 0; i < 12; i += 1) {
        const r = await postWebFetch({ url: base + '/page' }, { auditFile: file, auditMax: cap })
        assert.equal(r.ok, true, '轮转期间抓取不受影响（第 ' + i + ' 次）')
      }
      const last = JSON.parse(readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).pop())
      assert.equal(last.url, base + '/page', '轮转后最新行仍落到主文件')
      const size = statSync(file).size
      assert.ok(size <= cap + 500, '主文件大小有界（size=' + size + '，cap=' + cap + '）')
      assert.ok(existsSync(file + '.1'), '发生容量轮转：归档 ' + file + '.1 存在')
      assert.ok(statSync(file + '.1').size > 0, '归档非空')
    } finally {
      rmQuiet(file)
      rmQuiet(file + '.1')
    }
  })
})

describe('S2-G-11 错误码枚举常量表收口', () => {
  it('WEB_ERR 枚举含 timeout/ssrf_blocked/too_large 等全部规范码；http_<n> 为动态格式不入表', async () => {
    const values = Object.values(m.WEB_ERR)
    for (const c of ['invalid_url', 'protocol_blocked', 'ssrf_blocked', 'dns_error', 'too_many_redirects', 'timeout', 'too_large', 'fetch_error', 'unsupported', 'empty_content', 'web_error']) {
      assert.ok(values.includes(c), 'WEB_ERR 缺枚举码：' + c)
    }
    assert.equal(m.WEB_ERR.TIMEOUT, 'timeout')
    assert.equal(m.WEB_ERR.TOO_LARGE, 'too_large')
    assert.equal(m.WEB_ERR.SSRF_BLOCKED, 'ssrf_blocked')
    assert.equal(m.WEB_ERR.UNSUPPORTED, 'unsupported')
    assert.equal(m.WEB_ERR.EMPTY_CONTENT, 'empty_content')
    assert.ok(/^http_\d{3}$/.test('http_404') && /^http_\d{3}$/.test('http_500'), 'http_<n> 动态码格式 /^http_\d{3}$/')
    assert.ok(!values.includes('http_404'), 'http_<n> 动态不入表（表内无 http_404）')
  })
})

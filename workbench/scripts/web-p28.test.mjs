// P2-8 浏览器助手增强（后端契约）：① 抓取缓存 ② Readability-lite 抽取 ③ 可选截图 ④ 限流与配额
//
// 全部走**进程内 serve.mjs 真路由**（与 web.test.mjs 同款 startServe 方式），不 mock 内部函数：
//   - ② 抽取：导航/页脚噪声不入正文、标题层级与列表/代码块保留、质量元数据齐全、无 HTML 透传
//   - ① 缓存：新鲜命中不发网络请求（mock 命中计数不增长）、304 条件请求复用缓存、截断结果不入缓存、
//        缓存键含 maxBytes
//   - ④ 配额：空间 RPM / 并发 / 每日字节 / host RPM 超限 → 429 + Retry-After；**无 scope 不限流**；快照可读
//   - ③ 截图：默认关闭 → shot_disabled；开启但无浏览器 → shot_unavailable；用假浏览器脚本打通成功路径
//   - 历史：hub 未运行 → 如实报不可用（不假装空历史）；有 hub → 回写并按空间可读（集成见 team-hub/web-history.test.mjs）
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const m = await import(pathToFileURL(join(HERE, 'serve.mjs')).href)

process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1' // mock 目标是本机回环

// ── mock 站点：含导航/页脚噪声 + 正文容器，支持 ETag/Last-Modified 条件请求与命中计数 ──
const articleHtml = `<!doctype html><html><head><title>抽取质量测试页</title></head><body>
<nav class="main-nav"><a href="/a">首页</a><a href="/b">产品</a><a href="/c">价格</a><a href="/d">文档</a></nav>
<header class="site-header"><h1>站点名</h1><p>欢迎来到本站，这里有很长的站点头部描述文字用来混淆抽取。</p></header>
<article>
  <h1>正文一级标题</h1>
  <p>这是正文的第一段关键句：P2-8 抽取应保留段落结构，并且不含导航噪声。</p>
  <h2>小节标题</h2>
  <ul><li>列表项一</li><li>列表项二</li></ul>
  <pre><code>const a = 1;\nconsole.log(a)</code></pre>
  <blockquote>引用内容</blockquote>
  <p>最后一段，用于确保文本长度超过候选阈值，同时验证多段落保留。</p>
</article>
<footer class="site-footer"><p>版权所有 站点页脚文字不应出现在正文中</p></footer>
<form><input name="q"><button>搜索</button></form>
</body></html>`

let pageHits = 0
let bodyTransfers = 0 // 仅统计真正传了 body 的 200 响应（304 不算）
let cond304 = false
const mock = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  if (u.pathname === '/article') {
    pageHits += 1
    const etag = '"v1"'
    if (cond304 && req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return }
    bodyTransfers += 1
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag, 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' })
    res.end(articleHtml)
    return
  }
  if (u.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    // 超过 WEB_LIMITS.MAX_TEXT（300k）→ 抽取应标记 truncated（该标记同时用于「截断结果不入缓存」）
    res.end(`<html><body><article><p>${'内容很长的一段正文。'.repeat(40000)}</p></article></body></html>`)
    return
  }
  if (u.pathname === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>慢</p>') }, 1200); return }
  if (u.pathname === '/noscript-page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><main><p>纯文本正文内容足够长以通过候选阈值检查，用于并发测试。</p></main></body></html>'); return }
  if (u.pathname === '/short-article') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>短页</title></head><body><nav><a href="/x">导航</a></nav><article><p>短正文。</p></article><footer>页脚文字</footer></body></html>'); return }
  if (u.pathname === '/bad-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  // 未知路径 404（既有的失败留痕/统计断言依赖真实 404，不能一律 200）
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('<p>not found</p>')
})

let port = 0
let base = ''
const post = async (path, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（如截图 PNG） */ }
  return { status: r.status, json, text, headers: r.headers }
}
const get = async (path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`)
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* */ }
  return { status: r.status, json, text, headers: r.headers }
}

let tmpDir = ''
before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'legion-p28-'))
  process.env.DSH_WEB_AUDIT_FILE = join(tmpDir, 'audit.jsonl')
  process.env.DSH_WEB_CACHE_TTL_MS = '60000'
  await mock.listen(0, '127.0.0.1') && null
  await new Promise((resolve) => mock.once('listening', resolve))
  port = mock.address().port
  base = `http://127.0.0.1:${port}`
  await new Promise((resolve) => m.server.listen(0, '127.0.0.1', resolve))
  port = m.server.address().port
})
after(() => {
  mock.close()
  try { if (m.server.listening) m.server.close() } catch { /* */ }
  delete process.env.DSH_WEB_FETCH_ALLOW_PRIVATE
  delete process.env.DSH_WEB_AUDIT_FILE
  delete process.env.DSH_WEB_CACHE_TTL_MS
  delete process.env.DSH_WEB_SHOT_ENABLE
  delete process.env.DSH_WEB_SHOT_BROWSER
  delete process.env.DSH_WEB_SHOT_DIR
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
})

describe('P2-8② Readability-lite 正文抽取', () => {
  it('正文只取内容容器：导航/页脚/表单噪声不入正文，标题层级与列表/代码/引用保留', async () => {
    const r = await m.webFetch({ url: base + '/article' })
    assert.equal(r.ok, true)
    assert.equal(r.title, '抽取质量测试页')
    // 正文关键句在
    assert.ok(r.text.includes('正文的第一段关键句'), '正文段落保留')
    // 噪声标签的文本不入正文（这是 v1 的主要缺陷）
    assert.ok(!r.text.includes('首页'), '导航链接文本不入正文：' + JSON.stringify(r.text.slice(0, 120)))
    assert.ok(!r.text.includes('站点页脚文字'), '页脚文本不入正文')
    assert.ok(!r.text.includes('站点名'), '站点头部不入正文')
    assert.ok(!r.text.includes('搜索'), '表单不入正文')
    // 结构信号保留
    assert.ok(/^# 正文一级标题$/m.test(r.text), 'h1 → Markdown 一级标题')
    assert.ok(/^## 小节标题$/m.test(r.text), 'h2 → 二级标题')
    assert.ok(/^- 列表项一$/m.test(r.text), 'li → 列表项')
    assert.ok(/```/.test(r.text), 'pre/code → 代码围栏')
    assert.ok(/^> 引用内容$/m.test(r.text), 'blockquote → 引用')
    // 质量元数据
    const q = r.quality
    assert.equal(q.strategy, 'article', '语义容器（article）被选中')
    assert.ok(q.chars > 40, '字数统计：' + q.chars)
    assert.ok(q.headings >= 2, '标题计数')
    assert.ok(q.listItems >= 2, '列表项计数')
    assert.equal(q.droppedBlocks >= 3, true, '剔除块数应包含 nav/header/footer/form：' + q.droppedBlocks)
    assert.ok(q.candidates >= 1, '候选块数')
    assert.equal(q.markdown, true, '标记为已结构化（含 markdown 信号）')
    assert.equal(q.truncated, false)
    assert.equal(q.shortContent, false, '正常长文不标记短内容')
  })

  it('短页面：正文低于阈值时仍选显式语义容器（article）而非整页回退，并标记 shortContent', async () => {
    const r = await m.webFetch({ url: base + '/short-article' })
    assert.equal(r.ok, true)
    assert.equal(r.quality.strategy, 'article', '显式 <article> 优先于 body-fallback')
    assert.ok(r.text.includes('短正文'), '正文可读')
    assert.ok(!r.text.includes('导航'), '导航仍被剔除')
    assert.ok(!r.text.includes('页脚文字'), '页脚仍被剔除')
    assert.equal(r.quality.shortContent, true, '低于阈值 → 标记短内容，供界面提示')
    assert.equal(r.quality.droppedBlocks >= 2, true, 'nav/footer 计入剔除：' + r.quality.droppedBlocks)
  })

  it('无候选容器时回退 body，且仍返回可读文本（不抛错）', async () => {
    const r = await m.webFetch({ url: base + '/noscript-page' })
    assert.equal(r.ok, true)
    assert.ok(r.text.includes('纯文本正文'), '正文可读')
    assert.ok(['main', 'density', 'body-fallback'].includes(r.quality.strategy), '策略值在枚举内：' + r.quality.strategy)
    // 该夹具 main 只有 ~28 字（低于阈值 40）→ 按语义容器抽取并标记 shortContent（判定口径见 WEB_EXTRACT）
    assert.equal(r.quality.shortContent, true, '低于候选阈值应标记 shortContent')
    assert.ok(r.quality.chars < m.WEB_EXTRACT.MIN_CANDIDATE_CHARS, '夹具确实短于阈值：' + r.quality.chars)
  })

  it('抽取结果不含原始 HTML/脚本（TC-S6-10 不回归）', async () => {
    const r = await m.webFetch({ url: base + '/article' })
    const blob = JSON.stringify(r)
    for (const bad of ['<script', '<nav', '<footer', '</p>', '<article']) {
      assert.ok(!blob.includes(bad), '不得透传原始标签：' + bad)
    }
  })

  it('quality.truncated 在超长正文被截断时为 true（供缓存拒绝缓存截断结果）', async () => {
    const r = await m.webFetch({ url: base + '/big' })
    assert.equal(r.ok, true)
    assert.equal(r.quality.truncated, true, '超过 MAX_TEXT 应标记截断')
  })
})

describe('P2-8① 抓取缓存（新鲜命中 / 304 复用 / 不缓存截断结果）', () => {
  it('第一次真实抓取，第二次命中新鲜缓存（不再请求上游，mock 命中数不增长）', async () => {
    m.webCacheClear()
    const before = pageHits
    const r1 = await post('/api/web/fetch', { url: base + '/article', scope: 'p28-cache' })
    assert.equal(r1.status, 200)
    assert.equal(r1.json.cached, false)
    const afterFirst = pageHits
    assert.equal(afterFirst, before + 1, '第一次应真实请求上游')
    const r2 = await post('/api/web/fetch', { url: base + '/article', scope: 'p28-cache' })
    assert.equal(r2.json.cached, true, '第二次命中缓存')
    assert.equal(pageHits, afterFirst, '缓存命中不得再请求上游')
    assert.ok(r2.json.cacheAgeMs >= 0, '回传缓存年龄')
    assert.equal(r2.json.text, r1.json.text, '内容一致')
  })

  it('TTL 过期后带 ETag 条件请求：上游 304 → 复用缓存并标记 revalidated', async () => {
    m.webCacheClear()
    const now = Date.now()
    m.webCachePut('p28-304', base + '/article', 2 * 1024 * 1024, { ok: true, text: 'X', quality: {} }, { etag: '"v1"' }, now - 10 * 60 * 1000)
    assert.equal(m.webCacheGet('p28-304', base + '/article', 2 * 1024 * 1024, now), null, '过期 → 新鲜读返回 null')
    const stale = m.webCacheGetStale('p28-304', base + '/article', 2 * 1024 * 1024)
    assert.ok(stale, '过期条目仍可用于条件请求')
    assert.equal(stale.etag, '"v1"', '校验器被保留')
    // 真路由：带与缓存一致的 ETag 再抓一次 → mock 返回 304 → 结果标记 revalidated 且内容来自缓存
    cond304 = true
    const hitsBefore = pageHits
    const bodyBefore = bodyTransfers
    const r = await post('/api/web/fetch', { url: base + '/article', scope: 'p28-304' })
    cond304 = false
    assert.equal(r.status, 200)
    assert.equal(r.json.cached, true, '304 后按缓存命中返回')
    assert.equal(r.json.revalidated, true, '标记为条件请求复用')
    assert.equal(r.json.text, 'X', '内容来自缓存条目（未重新抓取上游 body）')
    assert.equal(pageHits, hitsBefore + 1, '条件请求本身仍会发一次（这正是「重新验证」）')
    assert.equal(bodyTransfers, bodyBefore, '304 不传输新 body（省流量，且证明走的是条件请求）')
  })

  it('缓存键含空间：A 空间的缓存不会被 B 空间命中（否则 B 既串内容又绕过配额）', async () => {
    m.webCacheClear()
    const r1 = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-spaceA' })
    assert.equal(r1.json.cached, false)
    const r2 = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-spaceB' })
    assert.equal(r2.json.cached, false, '不同空间不共享缓存')
    const r3 = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-spaceA' })
    assert.equal(r3.json.cached, true, '同空间同 URL 命中')
  })

  it('缓存键含 maxBytes：不同上限不复用同一缓存', async () => {
    m.webCacheClear()
    const r1 = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-key' })
    assert.equal(r1.json.cached, false)
    const r2 = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-key', maxBytes: 4096 })
    assert.equal(r2.json.cached, false, '不同 maxBytes 视作不同条目')
    const r3 = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-key' })
    assert.equal(r3.json.cached, true, '原 maxBytes 仍命中')
  })

  it('截断结果不入缓存（避免调大 maxBytes 后仍拿旧截断内容）', async () => {
    m.webCacheClear()
    const now = Date.now()
    const key = ['p28-trunc', base + '/big', 1024]
    m.webCachePut(...key, { ok: true, text: 'T', quality: { truncated: true } }, {}, now)
    assert.equal(m.webCacheGet(...key, now), null, 'truncated 结果不得入缓存')
    m.webCachePut(...key, { ok: true, text: 'T', quality: { truncated: false } }, {}, now)
    assert.ok(m.webCacheGet(...key, now), '未截断结果正常入缓存')
  })
})

describe('P2-8④ 限流与配额（空间 + host 两级）', () => {
  it('空间 RPM 超限 → 429 + Retry-After；无 scope 的调用不限流', async () => {
    m.webQuotaReset()
    let limited = null
    for (let i = 0; i < 500 && !limited; i += 1) {
      try { m.webQuotaBegin('p28-rpm', 'host.test'); m.webQuotaEnd('p28-rpm') } catch (e) { limited = e }
    }
    assert.ok(limited, '持续请求必然触发限流')
    assert.equal(limited.code, 'rate_limited')
    assert.match(limited.message, /每分钟抓取次数超限/)
    assert.ok(limited.retryAfterSec >= 1, '带回 Retry-After 秒数')
    // 无 scope：不限流（自测/脚本/运维调用只落审计）
    for (let i = 0; i < 500; i += 1) m.webQuotaBegin('', 'host.test')

    // host 级限制：每次用**新空间**（各自全新 RPM 桶）打同一站点，直到触发站点级限制
    m.webQuotaReset()
    let hostLimited = null
    for (let i = 0; i < 500 && !hostLimited; i += 1) {
      const sc = 'p28-host-' + i
      try { m.webQuotaBegin(sc, 'same.host'); m.webQuotaEnd(sc) } catch (e) { hostLimited = e }
    }
    assert.ok(hostLimited, '同一站点高频请求应被限制（即使换空间）')
    assert.equal(hostLimited.code, 'rate_limited')
    assert.match(hostLimited.message, /目标站点/, '错误信息说明是站点级限制')
  })

  it('空间并发超限 → concurrency_limited（在途未结束时再发起）', async () => {
    m.webQuotaReset()
    const held = []
    let limited = null
    for (let i = 0; i < 100; i += 1) {
      try { m.webQuotaBegin('p28-conc', 'h' + i + '.test'); held.push(i) } catch (e) { limited = e; break }
    }
    assert.ok(limited, '并发额度应为有限值')
    assert.equal(limited.code, 'concurrency_limited')
    assert.equal(held.length, m.WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY, '在途数恰好等于并发上限')
    // 释放一个后可再进一个（额度回收，不泄漏）
    m.webQuotaEnd('p28-conc')
    m.webQuotaBegin('p28-conc', 'released.test')
    assert.equal(m.webQuotaSnapshot('p28-conc').concurrency.inflight, m.WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY, '补进后仍在途等于上限')
    for (let i = 0; i < held.length - 1; i += 1) m.webQuotaEnd('p28-conc') // 释放除刚补进的那个之外的全部
    assert.equal(m.webQuotaSnapshot('p28-conc').concurrency.inflight, 1, '仅剩刚进入的那个在途')
    m.webQuotaEnd('p28-conc')
    assert.equal(m.webQuotaSnapshot('p28-conc').concurrency.inflight, 0, '全部释放后归零')
  })

  it('每日字节配额：记账后达上限 → daily_quota_exceeded；快照反映已用与剩余', async () => {
    m.webQuotaReset()
    const snap0 = m.webQuotaSnapshot('p28-bytes')
    assert.equal(snap0.dailyBytes.used, 0)
    assert.equal(snap0.dailyBytes.remaining, snap0.dailyBytes.limit)
    m.webQuotaRecordBytes('p28-bytes', 1234)
    const snap1 = m.webQuotaSnapshot('p28-bytes')
    assert.equal(snap1.dailyBytes.used, 1234, '按空间记账')
    assert.equal(snap1.dailyBytes.remaining, snap1.dailyBytes.limit - 1234)
    assert.equal(m.webQuotaSnapshot('other-scope').dailyBytes.used, 0, '空间隔离')
    // 直接把当日用量记满 → 下一次准入抛 daily_quota_exceeded
    m.webQuotaRecordBytes('p28-full', m.WEB_QUOTA_DEFAULTS.DAILY_BYTES)
    let e2 = null
    try { m.webQuotaBegin('p28-full', 'x.test') } catch (e) { e2 = e }
    assert.equal(e2?.code, 'daily_quota_exceeded')
    assert.match(e2.message, /流量配额已用完/)
  })

  it('真路由：超限时 HTTP 429 + Retry-After 头（不是 200 里的软失败）', async () => {
    m.webQuotaReset()
    m.webCacheClear() // 排除缓存命中（缓存命中不消耗配额，会掩盖限流）
    // 用并发占满空间额度：手工占用 N 个在途，再发起真抓取 → 429
    for (let i = 0; i < m.WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY; i += 1) m.webQuotaBegin('p28-http', 'h' + i + '.test')
    const r = await post('/api/web/fetch', { url: base + '/article', scope: 'p28-http' })
    assert.equal(r.status, 429, '并发超限 → 429：' + JSON.stringify(r.json))
    assert.ok(r.headers.get('retry-after'), '带 Retry-After 头：' + r.headers.get('retry-after'))
    assert.equal(r.json.code, 'concurrency_limited')
    // 释放后恢复正常（限流不是永久封锁）
    m.webQuotaReset()
    const ok = await post('/api/web/fetch', { url: base + '/noscript-page', scope: 'p28-http' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    m.webQuotaReset()
  })

  it('GET /api/web/meta 返回配额快照与截图状态（缺 scope 时 quota 为 null）', async () => {
    const r = await get('/api/web/meta?scope=p28-meta')
    assert.equal(r.status, 200)
    assert.equal(r.json.quota.scope, 'p28-meta')
    assert.equal(r.json.quota.rpm.limit, m.WEB_QUOTA_DEFAULTS.SPACE_RPM)
    assert.equal(r.json.quota.dailyBytes.limit, m.WEB_QUOTA_DEFAULTS.DAILY_BYTES)
    assert.equal(typeof r.json.shot.enabled, 'boolean')
    assert.equal(typeof r.json.shot.available, 'boolean')
    assert.ok(r.json.cache.max >= 1)
    const r2 = await get('/api/web/meta')
    assert.equal(r2.json.quota, null)
  })
})

describe('P2-8③ 可选截图（默认关闭 / 未找到浏览器 / 假浏览器打通成功路径）', () => {
  it('默认关闭：返回 shot_disabled 与开启指引（HTTP 409，不静默失败）', async () => {
    delete process.env.DSH_WEB_SHOT_ENABLE
    const st = m.shotStatus()
    assert.equal(st.enabled, false)
    assert.match(st.hint, /DSH_WEB_SHOT_ENABLE=1/)
    const r = await post('/api/web/shot', { url: base + '/article', scope: 'p28-shot' })
    assert.equal(r.status, 409)
    assert.match(r.json.error, /未启用/)
    const direct = await m.webScreenshot({ url: base + '/article' }).catch(e => e)
    assert.equal(direct.code, 'shot_disabled')
    assert.equal(direct.paramLevel, true, '参数级失败：未发起浏览器进程，不落审计')
  })

  it('开启但找不到浏览器：shot_unavailable（并给出 DSH_WEB_SHOT_BROWSER 指引）', async () => {
    process.env.DSH_WEB_SHOT_ENABLE = '1'
    process.env.DSH_WEB_SHOT_BROWSER = join(tmpDir, 'definitely-not-a-browser.exe')
    const st = m.shotStatus()
    assert.equal(st.enabled, true)
    assert.equal(st.available, false)
    assert.match(st.hint, /DSH_WEB_SHOT_BROWSER/)
    const r = await post('/api/web/shot', { url: base + '/article', scope: 'p28-shot' })
    assert.equal(r.status, 409)
    assert.match(r.json.error, /未找到/)
    delete process.env.DSH_WEB_SHOT_BROWSER
  })

  it('假浏览器（脚本）打通成功路径：产出 PNG → 可读回 → 计入配额；SSRF 目标仍被拦', async () => {
    // 用 node 脚本冒充浏览器（.mjs 会被 serve.mjs 以当前 node 执行——Windows 上不 shell 调 .cmd）：
    // 解析 --screenshot=<file> 并写出一个合法 PNG 头
    const fake = join(tmpDir, 'fake-browser.mjs')
    writeFileSync(fake, [
      "import { writeFileSync } from 'node:fs'",
      "const target = process.argv.find(a => a.startsWith('--screenshot='))",
      "if (!target) process.exit(2)",
      "writeFileSync(target.slice('--screenshot='.length), Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]))",
    ].join('\n'), 'utf8')
    process.env.DSH_WEB_SHOT_ENABLE = '1'
    process.env.DSH_WEB_SHOT_BROWSER = fake
    process.env.DSH_WEB_SHOT_DIR = join(tmpDir, 'shots')
    const st = m.shotStatus()
    assert.equal(st.available, true, '假浏览器应被探测到')
    assert.equal(st.browser, 'fake-browser.mjs')

    m.webQuotaReset()
    const r = await post('/api/web/shot', { url: base + '/article', scope: 'p28-shot' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.ok, true)
    assert.match(r.json.file, /^shot_[0-9a-f]{8,}\.png$/)
    assert.ok(r.json.bytes >= 12, '回传字节数')
    assert.ok(existsSync(join(tmpDir, 'shots', 'p28-shot', r.json.file)), 'PNG 落在空间子目录')
    assert.equal(m.webQuotaSnapshot('p28-shot').dailyBytes.used, r.json.bytes, '截图字节计入空间配额')

    // 读回：真路由返回 PNG
    const img = await fetch(`http://127.0.0.1:${port}/api/web/shot?scope=p28-shot&name=${r.json.file}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    const buf = Buffer.from(await img.arrayBuffer())
    assert.equal(buf[0], 0x89, 'PNG 魔数')
    // 目录穿越与非法名被拒
    assert.equal((await get('/api/web/shot?scope=p28-shot&name=../../../team-hub/team.db')).status, 404)
    assert.equal((await get('/api/web/shot?scope=p28-shot&name=not-a-shot.txt')).status, 404)
    assert.equal((await get('/api/web/shot?scope=p28-shot&name=shot_ffffffffffffffff.png')).status, 404, '不存在的截图')
    // 清单
    const list = await get('/api/web/shots?scope=p28-shot')
    assert.equal(list.json.items.length, 1)
    assert.equal(list.json.items[0].name, r.json.file)
    // 截图也必须过 SSRF（不因为是截图就放开私网/协议限制）
    const blocked = await m.webScreenshot({ url: 'file:///etc/passwd', scope: 'p28-shot' }).catch(e => e)
    assert.equal(blocked.code, 'protocol_blocked')
    delete process.env.DSH_WEB_SHOT_BROWSER
    delete process.env.DSH_WEB_SHOT_DIR
    delete process.env.DSH_WEB_SHOT_ENABLE
  })
})

describe('P2-8① 历史读取（hub 不在时如实报不可用）', () => {
  it('hub 未运行 → ok:false 且给出原因，不假装空历史', async () => {
    const before = process.env.DSH_HUB_UPSTREAM
    process.env.DSH_HUB_UPSTREAM = 'http://127.0.0.1:1' // 必然连不上
    const r = await get('/api/web/history?scope=p28-offline')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.deepEqual(r.json.items, [])
    assert.match(r.json.error, /team-hub/, '说明依赖 team-hub')
    if (before === undefined) delete process.env.DSH_HUB_UPSTREAM
    else process.env.DSH_HUB_UPSTREAM = before
  })

  it('缺 scope → 明确拒绝（不返回全库历史）', async () => {
    const r = await get('/api/web/history')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /scope/)
  })

  it('未知 /api/web/* 路径 → 404（路由收口，不吞）', async () => {
    const r = await get('/api/web/nope')
    assert.equal(r.status, 404)
  })
})

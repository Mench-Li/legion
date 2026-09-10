// P2-8① 端到端验证脚本：serve.mjs 抓取 → 回写 team-hub → 按空间读回历史
//
// 为什么单独放这里而不是 CI 测试：它要**真实拉起 team-hub 子进程**（独立端口 + 临时 DB）。
// 单测已分别覆盖两侧（workbench/scripts/web-p28.test.mjs 覆盖「hub 不在时如实降级」、
// team-hub/web-history.test.mjs 覆盖 hub 侧的写入/累加/隔离/清理），本脚本只验证两者之间的接缝：
// 抓取一次是否真的在 hub 里留下按空间可读的记录。
//
// 用法（Windows/Linux 均可）：
//   node docs/P2-8-evidence/e2e-history.mjs
// 退出码 0 = 全部通过；1 = 有断言失败（输出里会打印失败项）。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail })
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''))
}

const freePort = () => new Promise((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

const tmp = mkdtempSync(join(tmpdir(), 'p28-e2e-'))
const hubDb = join(tmp, 'team.db')
let hub = null
let mock = null
let serveServer = null

try {
  // 1) 真拉起 team-hub（独立端口 + 临时 DB）
  const hubPort = await freePort()
  hub = spawn(process.execPath, [join(ROOT, 'team-hub', 'server.mjs')], {
    // 注意：team-hub 的端口/DB 是 TEAM_HUB_PORT / TEAM_HUB_DB（不是 PORT）——
    // 用错变量名会让它回落到默认 8787/3080 而抢占生产实例，这里必须与 server.mjs L72/L78 一致。
    env: { ...process.env, TEAM_HUB_PORT: String(hubPort), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: hubDb },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let hubLog = ''
  hub.stdout.on('data', d => { hubLog += String(d) })
  hub.stderr.on('data', d => { hubLog += String(d) })
  const hubUp = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        // team-hub 没有 /api/health：直接用 P2-8 自己的读路由探活（顺带验证路由已注册）
        const r = await fetch(`http://127.0.0.1:${hubPort}/api/web/history?scope=__probe__`)
        if (r.ok) return true
      } catch { /* 还没起来 */ }
      await new Promise(r => setTimeout(r, 250))
    }
    return false
  })()
  check('team-hub 已启动（独立端口，临时 DB）且 P2-8 历史路由可读', hubUp, hubUp ? `:${hubPort}` : hubLog.slice(-300))
  if (!hubUp) throw new Error('hub 未启动')

  // 2) 起一个 mock 页面站点（抓取目标；未知路径返回 404，用于验证失败也留痕）
  mock = createServer((req, res) => {
    if (req.url && req.url.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>E2E 目标页</title></head><body><article><h1>标题</h1><p>端到端验证用正文，长度足够通过候选阈值检查，这里再加一句让候选块稳定超过阈值。</p></article></body></html>')
      return
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<p>not found</p>')
  })
  await new Promise(r => mock.listen(0, '127.0.0.1', r))
  const sitePort = mock.address().port

  // 3) 进程内起 serve.mjs 路由，并把历史回写指向真 hub
  process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1'
  process.env.DSH_HUB_UPSTREAM = `http://127.0.0.1:${hubPort}`
  process.env.DSH_WEB_AUDIT_FILE = join(tmp, 'audit.jsonl')
  const m = await import(pathToFileURL(join(ROOT, 'workbench', 'scripts', 'serve.mjs')).href)
  await new Promise(r => m.server.listen(0, '127.0.0.1', r))
  serveServer = m.server
  const servePort = serveServer.address().port
  const post = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${servePort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  const get = async (path) => {
    const r = await fetch(`http://127.0.0.1:${servePort}${path}`)
    return { status: r.status, json: await r.json().catch(() => null) }
  }

  // 4) 带 scope 抓取一次（应真实抓取并回写历史）
  const url = `http://127.0.0.1:${sitePort}/page`
  const f1 = await post('/api/web/fetch', { url, scope: 'e2e-space' })
  check('抓取成功且带抽取质量元数据', f1.status === 200 && f1.json?.ok === true && f1.json?.quality?.strategy, `strategy=${f1.json?.quality?.strategy} chars=${f1.json?.quality?.chars}`)
  check('第一次为实时抓取（未命中缓存）', f1.json?.cached === false || f1.json?.cached === undefined)

  // 5) 回写是 fire-and-forget：给它一点时间落库
  await new Promise(r => setTimeout(r, 800))

  // 6) 通过 serve 代理读回历史（这条路验证 serve → hub 读链路）
  const h1 = await get('/api/web/history?scope=e2e-space')
  check('serve 代理读历史 ok', h1.json?.ok === true, h1.json?.error ?? '')
  const row = h1.json?.items?.[0]
  check('历史里出现刚抓的地址', row?.url === url, JSON.stringify(row?.url))
  check('历史保存标题与主机', row?.title === 'E2E 目标页' && row?.host === `127.0.0.1:${sitePort}`, `title=${row?.title} host=${row?.host}`)
  check('历史统计正确（1 条、0 失败）', h1.json?.stats?.total === 1 && h1.json?.stats?.failed === 0, JSON.stringify(h1.json?.stats))
  check('历史累计字节 > 0（用于配额展示）', (h1.json?.stats?.bytes ?? 0) > 0, String(h1.json?.stats?.bytes))

  // 7) 缓存命中：第二次抓取应命中同空间缓存，且不新增历史行（hits 累加）
  const f2 = await post('/api/web/fetch', { url, scope: 'e2e-space' })
  check('第二次抓取命中缓存（cached=true）', f2.json?.cached === true, JSON.stringify({ cached: f2.json?.cached, cacheAgeMs: f2.json?.cacheAgeMs }))
  await new Promise(r => setTimeout(r, 800))
  const h2 = await get('/api/web/history?scope=e2e-space')
  check('同地址仍只有 1 行且 hits 累加为 2', h2.json?.items?.length === 1 && h2.json?.items?.[0]?.hits === 2, `rows=${h2.json?.items?.length} hits=${h2.json?.items?.[0]?.hits}`)
  check('缓存命中同样被记录（cached 标记）', h2.json?.items?.[0]?.cached === true || h2.json?.items?.[0]?.cached === 1, String(h2.json?.items?.[0]?.cached))

  // 8) 空间隔离：另一个空间读不到本空间的历史
  const other = await get('/api/web/history?scope=other-space')
  check('空间隔离：另一空间历史为空', (other.json?.items?.length ?? 0) === 0 && other.json?.stats?.total === 0)

  // 9) 失败抓取也留痕（错误码入历史，便于排查）
  const bad = await post('/api/web/fetch', { url: `http://127.0.0.1:${sitePort}/nope-not-exists`, scope: 'e2e-space' })
  await new Promise(r => setTimeout(r, 800))
  const h3 = await get('/api/web/history?scope=e2e-space')
  const failed = h3.json?.items?.find(i => i.errorCode)
  check('失败抓取留下错误码记录', !!failed, `errorCode=${failed?.errorCode} status=${failed?.status}`)
  check('失败计入 stats.failed', (h3.json?.stats?.failed ?? 0) >= 1, JSON.stringify(h3.json?.stats))
  check('404 走 http_4xx 语义（不误判为成功）', bad.json?.ok === false || bad.json?.code === 'http_404', `code=${bad.json?.code}`)

  // 10) 配额快照与截图状态可读（前端首屏数据源）
  const meta = await get('/api/web/meta?scope=e2e-space')
  check('元信息含配额快照', meta.json?.quota?.dailyBytes?.used > 0, JSON.stringify(meta.json?.quota?.dailyBytes))
  check('元信息含截图状态（默认关闭）', meta.json?.shot?.enabled === false, JSON.stringify(meta.json?.shot))
} catch (e) {
  check('端到端脚本无异常', false, e?.stack ?? String(e))
} finally {
  try { if (serveServer?.listening) serveServer.close() } catch { /* */ }
  try { mock?.close() } catch { /* */ }
  try { hub?.kill() } catch { /* */ }
  // 清理临时目录（含 hub 的 DB / WAL）
  try { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
}

const failedItems = results.filter(r => !r.ok)
console.log(`\n端到端结果：${results.length - failedItems.length}/${results.length} 通过`)
process.exit(failedItems.length === 0 ? 0 : 1)

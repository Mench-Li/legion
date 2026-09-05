// docs/T094-evidence/l1-s2-regress.mjs — TC-S2-06 / TC-S2-10 复现·回归探针（serve.mjs /api/web/fetch 真实 HTTP 层）
// 语义对齐 T-080 报告的 L1 探针（03-l1-probes.txt / 05-l1-realclient.txt）：
//   P1（TC-S2-06） POST /api/web/fetch {url:<mock>/stall5xx, timeoutMs:300}（writeHead(500)+partial 后 body 挂起）
//         → 必须 {ok:false, code:'timeout'}（非 http_500/web_error）；审计行 code=timeout、status=500
//   P2（TC-S2-10） POST {"url":""} 与 {"url":123} → 200-envelope {ok:false, code:invalid_url}，且不新增审计行
//   CTRL          随后正常抓取 mock /ok → 审计仍留痕（审计机制未被误伤）
// 用法：
//   node docs/T094-evidence/l1-s2-regress.mjs inproc   # 进程内：import serve.mjs 并 listen（L1 进程内面）
//   node docs/T094-evidence/l1-s2-regress.mjs client   # 真实进程面：WB_BASE=<运行中 serve.mjs 地址>
// 注入（两组模式均需）：DSH_WEB_FETCH_ALLOW_PRIVATE=1；DSH_WEB_AUDIT_FILE=<审计文件>
import { createServer } from 'node:http'
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const mode = process.argv[2] ?? 'inproc'
if (mode !== 'inproc' && mode !== 'client') { console.error('usage: node l1-s2-regress.mjs inproc|client'); process.exit(2) }

let auditFile = process.env.DSH_WEB_AUDIT_FILE || ''
const auditsDir = join(HERE, 'tmp-audit')
if (!auditFile) { mkdirSync(auditsDir, { recursive: true }); auditFile = join(auditsDir, 'l1-s2.' + process.pid + '.jsonl') }
try { unlinkSync(auditFile) } catch { /* 尚无 */ }
process.env.DSH_WEB_AUDIT_FILE = auditFile // serve.mjs 每次写时现读 env
process.env.DSH_WEB_FETCH_ALLOW_PRIVATE = '1' // 测试注入口：目标为本地 mock

// ── mock：stall5xx（500 头 + partial + 永不 end）/ stall2xx / ok / 500 / page ──
const mock = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  if (u.pathname === '/stall5xx') { res.writeHead(500, { 'content-type': 'text/html' }); res.write('<p>partial 5xx body, never ends') }
  else if (u.pathname === '/stall2xx') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial 2xx body, never ends') }
  else if (u.pathname === '/500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom') }
  else if (u.pathname === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>ok-page</title></head><body><p>fine</p></body></html>') }
  else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope') }
})

function auditCount() {
  if (!existsSync(auditFile)) return 0
  return readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).length
}
function auditRowsFrom(start) {
  if (!existsSync(auditFile)) return []
  return readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(start).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
async function post(payload) {
  const r = await fetch(BASE + '/api/web/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const txt = await r.text()
  let j = null
  try { j = JSON.parse(txt) } catch { j = txt }
  return { http: r.status, body: j }
}

let BASE = ''
let failures = 0
let serveMod = null
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures += 1
}

if (mode === 'inproc') {
  const serveUrl = pathToFileURL(require.resolve(join(HERE, '..', '..', 'workbench', 'scripts', 'serve.mjs'))).href + '?s2regress=' + Date.now()
  serveMod = await import(serveUrl)
  await new Promise((resolve) => serveMod.server.listen(0, '127.0.0.1', resolve))
  BASE = 'http://127.0.0.1:' + serveMod.server.address().port
} else {
  BASE = process.env.WB_BASE || ''
  if (!BASE) { console.error('client mode 需要 WB_BASE=<运行中 serve.mjs>'); process.exit(2) }
}
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const MBASE = 'http://127.0.0.1:' + mock.address().port

console.log('mode=' + mode + ' base=' + BASE + ' mock=' + MBASE + ' audit=' + auditFile)

// ── P1 TC-S2-06：5xx body stall → 必须 timeout ──
{
  const c0 = auditCount()
  const t0 = Date.now()
  const { http, body } = await post({ url: MBASE + '/stall5xx', timeoutMs: 300 })
  const ms = Date.now() - t0
  const rows = auditRowsFrom(c0)
  const envCode = body && typeof body === 'object' ? body.code : '(非JSON)'
  const envOk = body && typeof body === 'object' ? body.ok : null
  const auditCode = rows.length ? rows[rows.length - 1].code : '(无审计行)'
  const auditStatus = rows.length ? rows[rows.length - 1].status : null
  console.log('P1 resp http=' + http + ' ms=' + ms + ' envelope=' + JSON.stringify(body))
  console.log('P1 audit +' + rows.length + ' 行 code=' + auditCode + ' status=' + auditStatus)
  check('P1 stall5xx → code=timeout', http === 200 && envOk === false && envCode === 'timeout', '实际 envelope code=' + envCode)
  check('P1 审计留痕 code=timeout/status=500', rows.length === 1 && auditCode === 'timeout' && auditStatus === 500, '实际 code=' + auditCode + ' status=' + auditStatus + ' 行数=' + rows.length)
}

// ── P2 TC-S2-10：参数级 invalid_url（url="" / url=123）不得产生审计行 ──
{
  const c0 = auditCount()
  const r1 = await post({ url: '' })
  const r2 = await post({ url: 123 })
  const delta = auditCount() - c0
  console.log('P2 envelope1=' + JSON.stringify(r1.body) + ' envelope2=' + JSON.stringify(r2.body))
  console.log('P2 审计增量=' + delta + ' 行')
  check('P2 两 POST 均 200-envelope invalid_url', r1.http === 200 && r1.body && r1.body.ok === false && r1.body.code === 'invalid_url' && r2.body && r2.body.ok === false && r2.body.code === 'invalid_url', '实际 codes=' + (r1.body && r1.body.code) + ',' + (r2.body && r2.body.code))
  check('P2 参数级失败不产生审计行', delta === 0, '实际增量 ' + delta + '（修复前=2）')
}

// ── CTRL：正常抓取仍留痕（审计机制未被误伤）──
{
  const c0 = auditCount()
  const { http, body } = await post({ url: MBASE + '/ok' })
  const rows = auditRowsFrom(c0)
  check('CTRL /ok 抓取正常且留痕', http === 200 && body && body.ok === true && rows.length === 1 && rows[0].code === 'ok', '实际 http=' + http + ' 审计+' + rows.length)
}

// 收尾：强制关闭挂起/stall 连接与 keep-alive 复用 socket，避免 libuv 断言（Windows async.c）干扰退出码
try { if (typeof mock.closeAllConnections === 'function') mock.closeAllConnections() } catch { /* */ }
await new Promise((resolve) => { try { mock.close(() => resolve()) } catch { resolve() } })
if (serveMod) {
  try { if (typeof serveMod.server.closeAllConnections === 'function') serveMod.server.closeAllConnections() } catch { /* */ }
  try { serveMod.server.close() } catch { /* */ }
}
// 给 undici 收尾留一拍：未决句柄清空后再退
await new Promise((resolve) => setTimeout(resolve, 150))
console.log('RESULT failures=' + failures)
process.exit(failures === 0 ? 0 : 1)

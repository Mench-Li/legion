#!/usr/bin/env node
/**
 * s2-probes.mjs — S2 对话中心（ChatView + 接线）边界/安全探针（真实双服务）。
 * 目标：为 TC-S2-09（XSS 数据面存储原样）、TC-S2-10（空/超长/并发边界）、
 *       TC-S2-07（失败路径数据面）、TC-S2-11（markdown/未知 kind 存读）、TC-S2-08（单一 /api/events）提供命令级证据。
 * 断言失败退出码非 0；零第三方依赖；子进程 stdio:ignore（沙箱允许）。
 */
import { spawn } from 'node:child_process'
import * as httpMod from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-s2-probe-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}
async function postJson(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => null)
  return { status: r.status, data }
}
async function startHub() {
  for (let a = 0; a < 6; a += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const dbFile = join(tmpRoot, 'hub-' + port + '.db')
    const child = spawn(process.execPath, [join(REPO, 'team-hub', 'server.mjs')], { cwd: REPO, env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' }, stdio: 'ignore' })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/api/config'); if (r.ok && (await r.json()).db === dbFile) return { child, base } } catch { /* */ }
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('team-hub 未就绪')
}
async function startHost(hubBase) {
  for (let a = 0; a < 6; a += 1) {
    const port = 30000 + Math.floor(Math.random() * 15000)
    const child = spawn(process.execPath, [join(REPO, 'workbench', 'scripts', 'serve.mjs'), '--port', String(port)], { cwd: join(REPO, 'workbench'), env: { ...process.env, DSH_HUB_UPSTREAM: hubBase, DSH_WORKBENCH_PORT: String(port) }, stdio: 'ignore' })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/hub/api/config'); if (r.ok) return { child, base } } catch { /* */ }
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('serve.mjs 未就绪')
}
function sseCollector(base) { const seen = []; let closed = false; const req = httpMod.get(base + '/api/events', (res) => { let buf = ''; res.on('data', (d) => { buf += d.toString(); const frames = buf.split('\n\n'); buf = frames.pop(); for (const f of frames) { const m = /^data: (.+)$/m.exec(f); if (!m) continue; try { const ev = JSON.parse(m[1]); if (ev && typeof ev.action === 'string' && ev.action.startsWith('chat:')) seen.push(ev) } catch { /* */ } } }) }); req.on('error', () => { closed = true }); return { seen, waitMsg(msgId, timeoutMs = 5000) { const t0 = Date.now(); return new Promise((resolve) => { const timer = setInterval(() => { const hit = seen.find(e => e.action === 'chat:message' && Number(e.detail?.msg) === msgId); if (hit) { clearInterval(timer); resolve(hit); return } if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(null) } }, 60) }) }, close() { if (!closed) { try { req.destroy() } catch { /* */ } } } } }

const hub = await startHub()
const host = await startHost(hub.base)
const children = [hub.child, host.child]
let exitCode = 0
try {
  const H = host.base + '/hub'
  const c = await postJson(H, '/api/chat/conversations', { scope: 'software', title: 'S2 探针会话', kind: 'space', by: 'general' })
  const convId = c.data?.task?.id
  check('P0 前置：建会话 ok', c.status === 200 && typeof convId === 'number', 'conv=' + convId)

  // TC-S2-09：XSS 三个载荷作为普通文本消息存储——GET 原样返回（数据面不吞/不转义；渲染安全由 React 文本节点保证，见静态证据）
  const xss = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '[x](javascript:alert(1))']
  const xssIds = []
  let xssOk = true
  let detail = ''
  for (const p of xss) {
    const m = await postJson(H, '/api/chat/messages', { conv: convId, body: p, kind: 'text', by: 'general' })
    if (m.status !== 200 || m.data?.task?.body !== p) { xssOk = false; detail += 'sent=' + p + ' got=' + (m.data?.task?.body ?? 'ERR' + m.status) + '; ' }
    xssIds.push(m.data?.task?.id)
  }
  check('P-XSS POST 三个 XSS 载荷 → 200 且 body 原样存储', xssOk, detail)
  const got = (await (await fetch(H + '/api/chat/messages?conv=' + convId)).json()).messages
  const roundtrip = xss.every(p => got.some(m => m.body === p))
  check('P-XSS GET 消息 → 三个载荷原样返回（React 文本节点渲染→不执行）', roundtrip, 'msgs=' + got.length)

  // TC-S2-10 ①②和 S2 AC6：空正文 / 超长（>8000）/ 恰界 8000 / 非法 kind / 标题超长
  const empty = await postJson(H, '/api/chat/messages', { conv: convId, body: '   ', kind: 'text', by: 'general' })
  check('P-B1 空正文 → 400 拒绝', empty.status === 400, 'status=' + empty.status)
  const over = await postJson(H, '/api/chat/messages', { conv: convId, body: 'x'.repeat(8001), kind: 'text', by: 'general' })
  check('P-B2 正文 8001 字符 → 400（MAX_CHAT_BODY）', over.status === 400, 'status=' + over.status)
  const exact = await postJson(H, '/api/chat/messages', { conv: convId, body: 'x'.repeat(8000), kind: 'text', by: 'general' })
  check('P-B3 正文恰好 8000 字符 → 200（边界通过）', exact.status === 200, 'status=' + exact.status)
  const badkind = await postJson(H, '/api/chat/messages', { conv: convId, body: 'hi', kind: 'html', by: 'general' })
  check('P-B4 非法 kind=html → 400（kind 白名单）', badkind.status === 400, 'status=' + badkind.status)
  const longtitle = await postJson(H, '/api/chat/conversations', { scope: 'software', title: 't'.repeat(201), kind: 'space', by: 'general' })
  check('P-B5 会话标题 201 字符 → 400（≤200）', longtitle.status === 400, 'status=' + longtitle.status)

  // TC-S2-11 / X-1 前置：合法 kind=markdown 消息存读（前端对未知 kind 按文本兜底——静态证据 ChatView 渲染 m.body 文本节点）
  const mdBody = ['# Markdown 语法原样', '- a', '- b'].join(String.fromCharCode(10))
  const md = await postJson(H, '/api/chat/messages', { conv: convId, body: mdBody, kind: 'markdown', by: 'general' })
  const mdMsg = md.data?.task
  const mdGot = (await (await fetch(H + '/api/chat/messages?conv=' + convId)).json()).messages.find(m => m.id === mdMsg?.id)
  check('P-MD kind=markdown 消息 → 200 且 body 原样返回（前端按纯文本渲染）', md.status === 200 && mdGot?.body === mdBody && mdGot?.kind === 'markdown', 'kind=' + mdGot?.kind)

  // TC-S2-08 / I8：单一 /api/events（经 /hub 代理）——一个连接收 chat:message，action=chat:、scope/member 形状
  const sub = sseCollector(H)
  await sleep(400)
  const live = await postJson(H, '/api/chat/messages', { conv: convId, body: 'SSE 单源探针 live', kind: 'text', by: 'general' })
  const liveId = live.data?.task?.id
  const gotEv = liveId !== undefined ? await sub.waitMsg(liveId, 5000) : null
  check('P-SSE 单一 /api/events 连接收到 chat:message（action=chat:, scope, member=by）', !!gotEv && gotEv.action === 'chat:message' && gotEv.scope === 'software' && gotEv.member === 'general' && Number(gotEv.detail.msg) === liveId, 'ev=' + JSON.stringify(gotEv))
  sub.close()

  const failed = results.filter(r => !r.ok)
  console.log('')
  console.log('S2 边界/安全探针汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过' + (failed.length ? '，失败：' + failed.map(f => f.name).join('；') : ''))
  exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('S2 探针异常中断：', e)
  exitCode = 2
} finally {
  for (const c of children) { try { c.kill() } catch { /* */ } }
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ }
}
process.exit(exitCode)

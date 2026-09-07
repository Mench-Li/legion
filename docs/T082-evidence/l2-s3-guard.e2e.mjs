#!/usr/bin/env node
/**
 * l2-s3-guard.e2e.mjs — T-082 切片 S3「ChatView 会话/空间身份守卫（R-A5）」L2 行为级 E2E（真实浏览器）。
 *
 * 环境：本沙箱禁下载/无 GUI，但本机有 headless Chrome + workbench/dist（已 pnpm build 产物）；
 * 守卫为前端竞态逻辑，故用「真 hub + 真静态站点 + 延迟代理 + headless Chrome（CDP 纯内置驱动）」实测
 * docs/TEST_CASES.md TC-S3-02/03/04/05 的可执行部分。零第三方依赖（node:http/child_process/fs + 全局 fetch/WebSocket）。
 *
 * 拓扑：
 *   Chrome ──(:15173 静态 dist)── serve.mjs（静态托管，仅壳）
 *   Chrome ──?hub=:PROXY── 延迟代理 ──▶ team-hub/server.mjs（真实进程，临时 TEAM_HUB_DB）
 *   代理规则：GET /api/chat/messages 且带 before=（loadOlder 翻页）→ 延迟 DELAY_MS；
 *            POST /api/chat/messages（发送）→ 延迟 DELAY_MS；其余（含 SSE /api/events、conv 切换拉页）直通。
 *   延迟制造「在途请求在用户切走后才返回」的竞态窗口，验证守卫丢弃旧会话/旧空间写回。
 *
 * 场景（对照 TEST_CASES §4.3）：
 *   PRE  主路径冒烟：hub 可达 → 选空间 → 会话列表/消息/发送气泡/分页按钮就绪（TC-S3-05 前件）
 *   S1   TC-S3-02 loadOlder 竞态：A 点「加载更早」在途 → 立即切 B → 返回后 B 视图零污染、草稿在；切回 A 数据完整
 *   S2   TC-S3-03 send 竞态：A 发送在途 → 立即切 B 并输入草稿 → 返回后 B 无 A 气泡、B 草稿未被误清；切回 A 消息已入库可见
 *   S3   TC-S3-04 跨空间竞态：software A 点「加载更早」在途 → 立即切 marketing 空间 → 返回后 marketing 视图零污染；切回 software 数据仍在
 *   S4   TC-S3-05 实时/主路径：双标签同会话 SSE ≤15s 收到新消息；刷新后历史仍在（R-A5 验收 3 回归）
 *
 * 输出：逐项 PASS/FAIL + 汇总行；任一 FAIL exit 1。脚本不改任何被测代码。
 */
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DELAY_MS = Number(process.env.S3_DELAY_MS || 2600)
const CDP_PORT = Number(process.env.S3_CDP_PORT || 9333)
const APP_PORT = Number(process.env.S3_APP_PORT || 15173)
const HUB_PORT = Number(process.env.S3_HUB_PORT || 18873)
const PROXY_PORT = Number(process.env.S3_PROXY_PORT || 18874)
const tmpRoot = mkdtempSync(join(tmpdir(), 't082-s3-l2-'))
const results = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}

function post(base, path, body, token) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function startHub() {
  const dbFile = join(tmpRoot, 'hub.db')
  const child = spawn(process.execPath, ['team-hub/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(HUB_PORT) },
    stdio: 'ignore',
  })
  const base = 'http://127.0.0.1:' + HUB_PORT
  for (let i = 0; i < 150; i += 1) {
    try {
      const r = await fetch(base + '/api/config')
      if (r.ok && (await r.json()).db === dbFile) return { child, base }
    } catch { /* not ready */ }
    await sleep(100)
  }
  child.kill()
  throw new Error('hub 未就绪')
}

/** 延迟代理：只延迟 loadOlder(GET+before) 与 send(POST /api/chat/messages)，其余直通。 */
async function startProxy(hubBase) {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const isLoadOlder = req.method === 'GET' && u.pathname === '/api/chat/messages' && u.searchParams.has('before')
    const isSend = req.method === 'POST' && u.pathname === '/api/chat/messages'
    const delay = (isLoadOlder || isSend) ? DELAY_MS : 0
    const outReq = httpRequest(hubBase + u.pathname + u.search, {
      method: req.method,
      headers: (() => { const h = { ...req.headers }; delete h.host; delete h.connection; return h })(),
    }, (outRes) => {
      res.writeHead(outRes.statusCode, outRes.headers)
      outRes.pipe(res)
    })
    outReq.on('error', (e) => { try { res.writeHead(502); res.end('proxy error: ' + e.message) } catch { /* ignore */ } })
    req.on('error', () => outReq.destroy())
    const go = () => {
      if (req.method === 'POST' || req.method === 'PUT') req.pipe(outReq)
      else outReq.end()
    }
    if (delay > 0) setTimeout(go, delay)
    else go()
  })
  await new Promise(r => srv.listen(PROXY_PORT, '127.0.0.1', r))
  return srv
}

async function startStatic() {
  const child = spawn(process.execPath, ['workbench/scripts/serve.mjs', '--port', String(APP_PORT), '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore',
  })
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch('http://127.0.0.1:' + APP_PORT + '/'); if (r.ok) return child } catch { /* retry */ }
    await sleep(100)
  }
  child.kill()
  throw new Error('静态站未就绪')
}

let chromeProc = null
let staticProc = null
async function startChrome() {
  const userDir = join(tmpRoot, 'chrome')
  chromeProc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
    '--user-data-dir=' + userDir, '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 150; i += 1) {
    try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version'); if (r.ok) return } catch { /* retry */ }
    await sleep(100)
  }
  throw new Error('Chrome CDP 未就绪')
}

async function newTarget(url) {
  const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  return r.json()
}

/** 极简 CDP 客户端（全局 WebSocket，纯内置）。 */
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id)
      pend.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  })
  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pend.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { open, send, close: () => ws.close() }
}

async function main() {
  if (!existsSync(join(ROOT, 'workbench', 'dist', 'index.html'))) throw new Error('workbench/dist 缺失：需先 pnpm build（tsc --noEmit && vite build）')
  console.log('# 拓扑就绪检查（dist / chrome / node ' + process.version + '）')
  const hub = await startHub()
  console.log('# hub 已起:', hub.base)
  for (const sp of [{ id: 'software', name: '软件部空间' }, { id: 'marketing', name: '市场部空间' }]) {
    const r = await (await post(hub.base, '/api/spaces', { ...sp, private: false, by: 'general' })).json()
    if (!r.ok) throw new Error('注册空间失败: ' + JSON.stringify(r))
  }
  async function mkConv(scope, title, n, prefix) {
    const c = await (await post(hub.base, '/api/chat/conversations', { scope, title, kind: 'space', by: 'general' })).json()
    if (!c.ok || !c.task || !c.task.id) throw new Error('创建会话失败: ' + JSON.stringify(c))
    const convId = c.task.id
    for (let i = 1; i <= n; i += 1) {
      const r = await (await post(hub.base, '/api/chat/messages', { conv: convId, body: prefix + i, kind: 'text', by: 'general' })).json()
      if (!r.ok) throw new Error('种消息失败: ' + JSON.stringify(r))
    }
    return convId
  }
  const convA = await mkConv('software', 'A-会话', 60, 'A-msg-')
  await mkConv('software', 'B-会话', 3, 'B-msg-')
  await mkConv('software', 'C-会话', 60, 'C-msg-')
  await mkConv('marketing', 'M-会话', 3, 'M-msg-')
  {
    const c = await (await post(hub.base, '/api/chat/conversations', { scope: 'software', title: 'E-会话', kind: 'space', by: 'general' })).json()
    if (!c.ok || !c.task || !c.task.id) throw new Error('E conv fail: ' + JSON.stringify(c))
    const xssBody = '<img src=x onerror=window.__xss=1><scr' + 'ipt>window.__xss=2</scr' + 'ipt>[x](javascript:alert(3))'
    const r = await (await post(hub.base, '/api/chat/messages', { conv: c.task.id, body: xssBody, kind: 'text', by: 'general' })).json()
    if (!r.ok) throw new Error('E seed msg fail: ' + JSON.stringify(r))
  }
  console.log('# 种子完成: convA=' + convA + '（software: A60/B3/C60, marketing: M3）')

  const proxy = await startProxy(hub.base)
  console.log('# 延迟代理已起 :' + PROXY_PORT + ' → ' + HUB_PORT + '（loadOlder/send 延迟 ' + DELAY_MS + 'ms）')
  staticProc = await startStatic()
  console.log('# 静态站已起 :' + APP_PORT)
  await startChrome()
  console.log('# Chrome headless CDP :' + CDP_PORT)

  const appUrl = 'http://127.0.0.1:' + APP_PORT + '/?hub=http://127.0.0.1:' + PROXY_PORT
  const t1 = await newTarget(appUrl)
  const c1 = cdpConnect(t1.webSocketDebuggerUrl)
  await c1.open
  await c1.send('Runtime.enable')
  const evalJs = async (expr) => {
    const r = await c1.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) + '\n' + expr.slice(0, 200))
    return r.result?.value
  }
  const waitFor = async (expr, timeoutMs, desc) => {
    const t0 = Date.now()
    for (;;) {
      const v = await evalJs(expr)
      if (v) return v
      if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时(' + timeoutMs + 'ms): ' + desc + ' :: ' + expr)
      await sleep(80)
    }
  }
  const clickNav = (txt) => evalJs('(()=>{const el=[...document.querySelectorAll(\'.nav-item\')].find(e=>e.textContent.includes(' + JSON.stringify(txt) + '));if(!el)return false;el.click();return true})()')
  const bubbleTexts = () => evalJs('[...document.querySelectorAll(\'.chat-bubble\')].map(b=>b.textContent)')
  const convNames = () => evalJs('[...document.querySelectorAll(\'.chat-conv-name\')].map(b=>b.textContent)')
  const typeComposer = (v) => evalJs('(()=>{const el=document.querySelector(\'.chat-composer textarea\');if(!el)return false;const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,\'value\').set;set.call(el,' + JSON.stringify(v) + ');el.dispatchEvent(new Event(\'input\',{bubbles:true}));return true})()')

  await waitFor('document.querySelectorAll(\'.nav-item\').length>0 && [...document.querySelectorAll(\'.nav-item\')].some(e=>e.textContent.includes(\'对话中心\'))', 30000, '侧栏模块渲染')
  check('PRE-0 应用壳加载（hubMode 侧栏含「对话中心」）', true)

  await clickNav('对话中心')
  await waitFor('[...document.querySelectorAll(\'.nav-item\')].some(e=>e.textContent.includes(\'软件部空间\'))', 15000, 'software 空间出现在工作空间列表')
  await clickNav('软件部空间')
  await waitFor('document.querySelectorAll(\'.chat-conv\').length>=2', 20000, 'software 会话列表 ≥2')
  check('PRE-1 进入 software 空间，会话列表就绪', true)
  const names0 = await convNames()
  check('PRE-2 会话名含 A/B/C（scope 隔离，无 M 会话）', names0.some(n => n.includes('A-会话')) && names0.some(n => n.includes('B-会话')) && names0.some(n => n.includes('C-会话')) && !names0.some(n => n.includes('M-会话')), JSON.stringify(names0))

  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length===50 && [...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===\'A-msg-60\')', 20000, 'A 首屏 50 条含 A-msg-60')
  const hasOlderBtn = await evalJs('[...document.querySelectorAll(\'button\')].some(b=>b.textContent.includes(\'加载更早\'))')
  check('PRE-3 A 首屏=50 条且出现「加载更早」（分页前件）', hasOlderBtn)

  // ============ S1 = TC-S3-02 loadOlder 竞态：在途翻页 → 切 B ============
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'button\')].find(b=>b.textContent.includes(\'加载更早\'));if(!el)return false;el.click();return true})()')
  await sleep(400)
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'B-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length===3', 10000, 'B 三条消息加载')
  await sleep(DELAY_MS + 1200)
  const s1b = await bubbleTexts()
  const s1bOk = s1b.length === 3 && s1b.every(t => t.startsWith('B-msg-')) && !s1b.some(t => t.startsWith('A-msg-'))
  check('S1(TC-S3-02) A 翻页在途切 B → B 视图零污染（无 A-msg 混入）', s1bOk, JSON.stringify(s1b.slice(0, 8)))
  const s1olderBtnGone = !(await evalJs('[...document.querySelectorAll(\'button\')].some(b=>b.textContent.includes(\'加载更早\'))'))
  check('S1(TC-S3-02) B 无「加载更早」（无 A 旧页状态残留）', s1olderBtnGone)
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length===50 && [...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===\'A-msg-60\')', 15000, '切回 A 首屏 50')
  const s1back = await bubbleTexts()
  check('S1(TC-S3-02) 切回 A 数据完整、无 B 串显', s1back.length === 50 && s1back.every(t => t.startsWith('A-msg-')) && !s1back.some(t => t.startsWith('B-msg-')))

  // ============ S2 = TC-S3-03 send 竞态：A 发送在途 → 切 B（带草稿）============
  await typeComposer('RACE-SEND-9')
  await evalJs('(()=>{const b=[...document.querySelectorAll(\'.chat-composer-bar button\')].find(x=>x.textContent.includes(\'发送\'));if(!b)return false;b.click();return true})()')
  await sleep(400)
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'B-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length===3', 10000, 'B 就绪')
  await typeComposer('B-草稿保留')
  await sleep(DELAY_MS + 1500)
  const s2draft = await evalJs('(document.querySelector(\'.chat-composer textarea\')||{}).value')
  check('S2(TC-S3-03) A 发送在途切 B → B 草稿未被误清', s2draft === 'B-草稿保留', 'draft=' + JSON.stringify(s2draft))
  const s2b = await bubbleTexts()
  check('S2(TC-S3-03) B 无 A 消息气泡混入', s2b.length === 3 && s2b.every(t => t.startsWith('B-msg-')) && !s2b.some(t => t.includes('RACE-SEND-9')))
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('[...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===\'RACE-SEND-9\')', 15000, 'A 显示已入库的 RACE-SEND-9')
  const s2aOk = (await bubbleTexts()).filter(t => t === 'RACE-SEND-9').length === 1
  check('S2(TC-S3-03) 切回 A 消息气泡恰好 1 条（归属发起会话）', s2aOk)

  // ============ S3 = TC-S3-04 跨空间竞态：software 翻页在途 → 切 marketing ============
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length>=50', 15000, '回到 A')
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'button\')].find(b=>b.textContent.includes(\'加载更早\'));if(!el)return false;el.click();return true})()')
  await sleep(400)
  await clickNav('市场部空间')
  await waitFor('[...document.querySelectorAll(\'.chat-conv-name\')].some(n=>n.textContent.includes(\'M-会话\')) && document.querySelectorAll(\'.chat-bubble\').length===3', 20000, 'marketing M 会话视图')
  await sleep(DELAY_MS + 1200)
  const s3m = await bubbleTexts()
  check('S3(TC-S3-04) software 翻页在途切 marketing → marketing 零污染', s3m.length === 3 && s3m.every(t => t.startsWith('M-msg-')) && !s3m.some(t => t.startsWith('A-msg-') || t.startsWith('B-msg-')), JSON.stringify(s3m))
  await clickNav('软件部空间')
  await waitFor('[...document.querySelectorAll(\'.chat-conv-name\')].some(n=>n.textContent.includes(\'A-会话\')) && ![...document.querySelectorAll(\'.chat-conv-name\')].some(n=>n.textContent.includes(\'M-会话\'))', 20000, '切回 software 无 M 会话')
  const s3names = await convNames()
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length>=50', 15000, 'software A 消息仍在')
  const s3back = await bubbleTexts()
  check('S3(TC-S3-04) 切回 software A 数据仍在（无跨空间串显）', s3back.some(t => t.startsWith('A-msg-')) && !s3back.some(t => t.startsWith('M-msg-')), 'names=' + JSON.stringify(s3names))

  // ============ S5 = TC-S3-05 新建会话 → 发消息 → 气泡出现（主路径） ============
  await evalJs('(()=>{const b=[...document.querySelectorAll(\'button\')].find(x=>x.textContent.includes(\'＋ 新会话\'));if(!b)return false;b.click();return true})()')
  await waitFor('document.querySelector(\'.modal input\')!==null', 8000, '新建会话弹窗')
  await evalJs('(()=>{const el=document.querySelector(\'.modal input\');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,\'value\').set;set.call(el,\'D-会话\');el.dispatchEvent(new Event(\'input\',{bubbles:true}));return true})()')
  await evalJs('(()=>{const b=[...document.querySelectorAll(\'.modal button\')].find(x=>x.textContent.includes(\'创建会话\'));if(!b)return false;b.click();return true})()')
  await waitFor('[...document.querySelectorAll(\'.chat-conv-name\')].some(n=>n.textContent.includes(\'D-会话\'))', 15000, 'D-会话出现在列表')
  await typeComposer('D-first-msg')
  await evalJs('(()=>{const b=[...document.querySelectorAll(\'.chat-composer-bar button\')].find(x=>x.textContent.includes(\'发送\'));if(!b)return false;b.click();return true})()')
  await waitFor('[...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===\'D-first-msg\')', DELAY_MS + 15000, 'D 首条消息气泡出现')
  check('S5(TC-S3-05) 新建会话 → 发消息 → 气泡出现（创建主路径无回归）', true)

  // ============ S4 = TC-S3-05 实时（第二标签 ≤15s）+ 主路径回归 ============
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'C-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length===50', 15000, 'C 首屏 50')
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'button\')].find(b=>b.textContent.includes(\'加载更早\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length===60 && [...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===\'C-msg-1\')', DELAY_MS + 15000, 'C 正常翻页合并到 60')
  check('S4(TC-S3-05) 无切换时「加载更早」正常合并（正向控制，守卫不过度拦截）', true)
  const t2 = await newTarget(appUrl)
  const c2 = cdpConnect(t2.webSocketDebuggerUrl)
  await c2.open
  await c2.send('Runtime.enable')
  const evalJs2 = async (expr) => {
    const r = await c2.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('tab2 eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result?.value
  }
  const waitFor2 = async (expr, timeoutMs, desc) => {
    const t0 = Date.now()
    for (;;) { const v = await evalJs2(expr); if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error('tab2 waitFor 超时: ' + desc); await sleep(80) }
  }
  await waitFor2('document.querySelectorAll(\'.nav-item\').length>0', 30000, 'tab2 壳')
  await evalJs2('(()=>{const el=[...document.querySelectorAll(\'.nav-item\')].find(e=>e.textContent.includes(\'对话中心\'));if(!el)return false;el.click();return true})()')
  await waitFor2('[...document.querySelectorAll(\'.nav-item\')].some(e=>e.textContent.includes(\'软件部空间\'))', 15000, 'tab2 software 空间')
  await evalJs2('(()=>{const el=[...document.querySelectorAll(\'.nav-item\')].find(e=>e.textContent.includes(\'软件部空间\'));if(!el)return false;el.click();return true})()')
  await waitFor2('[...document.querySelectorAll(\'.chat-conv-name\')].some(n=>n.textContent.includes(\'A-会话\'))', 20000, 'tab2 A 会话')
  await evalJs2('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor2('document.querySelectorAll(\'.chat-bubble\').length>=50', 20000, 'tab2 A 消息')
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('document.querySelectorAll(\'.chat-bubble\').length>=50', 15000, 'tab1 回 A')
  const rtBody = 'RT-msg-' + Date.now()
  await typeComposer(rtBody)
  await evalJs('(()=>{const b=[...document.querySelectorAll(\'.chat-composer-bar button\')].find(x=>x.textContent.includes(\'发送\'));if(!b)return false;b.click();return true})()')
  const tStart = Date.now()
  await waitFor2('[...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===' + JSON.stringify(rtBody) + ')', 15000, 'tab2 ≤15s SSE 收到 RT 消息')
  const rtMs = Date.now() - tStart
  check('S4(TC-S3-05) 第二标签 ≤15s 实时收到新消息（SSE 无回归）', rtMs <= 15000, rtMs + 'ms')
  await c2.send('Page.reload')
  await waitFor2('document.querySelectorAll(\'.nav-item\').length>0', 30000, 'tab2 刷新')
  await evalJs2('(()=>{const el=[...document.querySelectorAll(\'.nav-item\')].find(e=>e.textContent.includes(\'对话中心\'));if(!el)return false;el.click();return true})()')
  await waitFor2('[...document.querySelectorAll(\'.nav-item\')].some(e=>e.textContent.includes(\'软件部空间\'))', 15000, 'tab2 刷新后空间')
  await evalJs2('(()=>{const el=[...document.querySelectorAll(\'.nav-item\')].find(e=>e.textContent.includes(\'软件部空间\'));if(!el)return false;el.click();return true})()')
  await waitFor2('[...document.querySelectorAll(\'.chat-conv-name\')].some(n=>n.textContent.includes(\'A-会话\'))', 20000, 'tab2 刷新后 A 会话')
  await evalJs2('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'A-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor2('[...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent===' + JSON.stringify(rtBody) + ')', 20000, 'tab2 刷新后历史含 RT 消息')
  check('S4(TC-S3-05) 刷新后历史完整（RT 消息仍在）', true)

  // ============ S6 = TC-S3-08 渲染安全：恶意样本按纯文本显示、不执行 ============
  await evalJs('(()=>{const el=[...document.querySelectorAll(\'.chat-conv\')].find(e=>e.textContent.includes(\'E-会话\'));if(!el)return false;el.click();return true})()')
  await waitFor('[...document.querySelectorAll(\'.chat-bubble\')].some(b=>b.textContent.includes(\'<img src=x onerror=\'))', 15000, 'E XSS 样本以文本呈现')
  const s6x = await evalJs('({ imgs: document.querySelectorAll(\'.chat-msgs img\').length, fired: window.__xss, bubbles: [...document.querySelectorAll(\'.chat-bubble\')].map(b=>b.textContent) })')
  check('S6(TC-S3-08) 恶意样本纯文本渲染（无 img 元素注入、onerror/script 未执行）', s6x.imgs === 0 && s6x.fired === undefined && s6x.bubbles.some(t => t.includes('<img src=x onerror=') && t.includes('javascript:')), JSON.stringify(s6x).slice(0, 400))

  const fails = results.filter(r => !r.ok)
  console.log('\n==== L2 S3 E2E 汇总：' + (results.length - fails.length) + '/' + results.length + ' 通过；失败 ' + fails.length + ' ====')
  if (fails.length) { for (const f of fails) console.log('FAIL 项:', f.name) }
  c1.close(); c2.close()
  return fails.length === 0 ? 0 : 1
}

let exitCode = 2
try {
  exitCode = await main()
} catch (e) {
  console.log('FATAL | ' + (e && e.stack ? e.stack : String(e)))
  exitCode = 2
}
try {
  if (chromeProc) chromeProc.kill()
  if (staticProc) staticProc.kill()
  rmSync(tmpRoot, { recursive: true, force: true })
} catch { /* ignore */ }
process.exit(exitCode)

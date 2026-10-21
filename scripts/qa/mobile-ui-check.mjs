// scripts/qa/mobile-ui-check.mjs
// ============================================================================
// **界面级**活体检查：手机端 PWA 在真实浏览器 + 真实触屏事件下到底长什么样。
//
// 为什么需要它（与本仓既有三层证据的分工）：
//   · `workbench/mobile/*.test.mjs` —— 纯决策，Node 里跑，**看不见界面**；
//   · `sw-shell.test.mjs` / `mobile-board-parity.test.mjs` —— 源码级契约；
//   · `mobile-live-check.mjs` —— **线上**首页/通知/语言那几条（不登录、没有看板）。
//
//   而本目标改的恰恰是"一屏一列、左右滑、卡片点开、输入区不被键盘挡"——
//   这些在**投影层**全绿时仍然可能是坏的（需求 RK-4：假绿）。所以这里补最后一层：
//   起一个**桩 Hub**（同样的 /api 契约，返回固定任务），把 `workbench/mobile/`
//   原样托管，然后在移动仿真的真 Chrome 里按真手指的方式操作。
//
// 它检查的每一条都对应需求文档的一个验收口径：
//   A. 7 个验收宽度下**没有横向溢出**（R-01 / AC-01）；
//   B. 可交互元素的**有效命中区 ≥ 44×44**（R-04 / AC-04）；
//   C. 看板一屏一列、页数 = 非空状态列、**N 条任务 = N 张卡**（R-05 / AC-05）；
//   D. **横向滑动**切列、纵向滑动不切列、边缘 20px 不接手势（R-05 / §7.3）；
//   E. 点卡片 200ms 内出详情层、Esc 关闭、焦点回到卡片（R-07 / AC-07）；
//   F. 向上读历史时新消息**不拽到底**、出现「N 条新消息」（R-08 / AC-08）。
//
// 用法：`node scripts/qa/mobile-ui-check.mjs`（默认跑全部检查）
//       `node scripts/qa/mobile-ui-check.mjs --keep`（保留截图目录，便于人工复核）
//
// 退出码：0 全绿；1 有检查失败；2 本机没有可用浏览器（**skip，不等于通过**）。
//
// ★ 为什么这个文件自带一个 CDP 客户端，而不是用 `scripts/e2e/cdp.mjs`：
//   那边的启动方式是"从子进程的 stderr 里读 DevTools 地址"，而**在受限沙箱里
//   给子进程开管道会 EPERM**（实测：`spawn(..., { stdio: 'pipe' })` 抛 EPERM，
//   而 `stdio: 'ignore'` 正常）。所以这里改成"先用 `--remote-debugging-port`
//   钉死端口，再轮询 `/json/version` 拿 WebSocket 地址"—— 不需要读子进程输出，
//   在没有管道权限的环境里也能跑。
// ============================================================================
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOBILE = resolve(ROOT, 'workbench', 'mobile')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')

/** 常见安装位置（可用 `DSH_E2E_BROWSER` 覆盖，与 `scripts/e2e/cdp.mjs` 同一套约定）。 */
function findBrowser() {
  const fromEnv = process.env.DSH_E2E_BROWSER || process.env.DSH_WEB_SHOT_BROWSER
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null
  const pf = process.env.ProgramFiles || 'C:\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const list = process.platform === 'win32'
    ? [
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium']
  return list.filter(Boolean).find((p) => existsSync(p)) ?? null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 取一个空闲端口（绑一下再放掉，避免撞上别人的 DevTools 端口）。 */
async function freePort() {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

/**
 * 启动浏览器（`stdio: 'ignore'`，不碰管道）并连上它的 CDP。
 *
 * 移动仿真与 `scripts/e2e/cdp.mjs` 的 `MOBILE_DEVICE` 同一档：
 * 390×844 / DPR 3 / 5 触点 / Android 版 Mobile UA —— 断言"手机上能用"这件事，
 * 必须让浏览器按**移动视口**解析 meta viewport 并投递真 touch 事件。
 */
async function launchChrome() {
  const exe = findBrowser()
  if (!exe) return null
  const port = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'legion-mobile-ui-profile-'))
  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=390,844',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let wsUrl = null
  for (let i = 0; i < 200 && wsUrl === null; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl ?? null
    } catch { /* 还没起来 */ }
    if (wsUrl === null) await sleep(100)
  }
  if (wsUrl === null) {
    try { child.kill() } catch { /* already gone */ }
    return null
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 15000)
    ws.addEventListener('open', () => { clearTimeout(timer); res() })
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP 连接失败')) })
  })

  const pending = new Map()
  const listeners = new Map()
  let nextId = 1
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method} 失败：${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method
    for (const fn of listeners.get(key) ?? []) fn(msg.params)
  })
  const send = (method, params = {}, { sessionId, timeoutMs = 20000 } = {}) => new Promise((res, rej) => {
    const id = nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)) }, timeoutMs)
    pending.set(id, {
      method,
      resolve: (v) => { clearTimeout(timer); res(v) },
      reject: (e) => { clearTimeout(timer); rej(e) },
    })
    ws.send(JSON.stringify(payload))
  })
  const on = (method, fn, { sessionId } = {}) => {
    const key = sessionId ? `${sessionId}:${method}` : method
    if (!listeners.has(key)) listeners.set(key, [])
    listeners.get(key).push(fn)
  }

  return {
    async newPage() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      const page = makePage({ send, on, sessionId })
      await page._init()
      return page
    },
    async close() {
      try { ws.close() } catch { /* already closed */ }
      try { child.kill() } catch { /* already gone */ }
      await sleep(200)
      for (let i = 0; i < 5; i += 1) {
        try { await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break } catch { await sleep(150) }
      }
    },
  }
}

/** 一页：移动仿真 + 真实输入（触屏/键盘）+ 求值/等待/截图。 */
function makePage({ send: rawSend, on: rawOn, sessionId }) {
  const send = (method, params = {}, o = {}) => rawSend(method, params, { ...o, sessionId })
  const on = (method, fn) => rawOn(method, fn, { sessionId })
  const page = {
    width: 390,
    height: 844,
    consoleErrors: [],
    pageErrors: [],
    async _init() {
      await send('Page.enable')
      await send('Runtime.enable')
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
          + 'Chrome/131.0.0.0 Mobile Safari/537.36',
      })
      on('Runtime.consoleAPICalled', (p) => {
        if (p.type === 'error') {
          page.consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '))
        }
      })
      on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails ?? {}
        page.pageErrors.push(d.exception?.description ?? d.text ?? 'unknown exception')
      })
    },
    async goto(url, { timeoutMs = 30000 } = {}) {
      const loaded = new Promise((r) => on('Page.loadEventFired', r))
      await send('Page.navigate', { url })
      let timer
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('页面加载超时：' + url)), timeoutMs) })
      try { await Promise.race([loaded, timeout]) } finally { clearTimeout(timer) }
      return page
    },
    async evaluate(fn, ...args) {
      const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
      if (r.exceptionDetails) throw new Error('页面求值抛错：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r.result?.value
    },
    async waitFor(fn, { timeoutMs = 8000, intervalMs = 60, label = 'waitFor' } = {}) {
      const t0 = Date.now()
      let last
      for (;;) {
        last = await page.evaluate(fn)
        if (last) return last
        if (Date.now() - t0 > timeoutMs) throw new Error(`${label} 超时（${timeoutMs}ms）；最后一次取值=${JSON.stringify(last)}`)
        await sleep(intervalMs)
      }
    },
    async centerOf(selector) {
      const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
      }, selector)
      if (!box) throw new Error(`选择器无匹配元素：${selector}`)
      if (box.w === 0 || box.h === 0) throw new Error(`元素不可见（尺寸为 0）：${selector}`)
      return box
    },
    /** 真实触屏轻点（`Input.dispatchTouchEvent`，不是合成 click）。 */
    async tap(selector) {
      const c = await page.centerOf(selector)
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1, radiusX: 14, radiusY: 14, force: .5 }] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return c
    },
    async tapFill(selector, text) {
      await page.tap(selector)
      await page.evaluate((sel) => { const el = document.querySelector(sel); if (el && el.select) el.select() }, selector)
      await send('Input.insertText', { text })
    },
    async press(key) {
      const map = {
        Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
        Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
        Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
      }
      const k = map[key] ?? { key, code: key }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined })
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(file, Buffer.from(data, 'base64'))
      return file
    },
    send,
  }
  return page
}

// ── 桩 Hub：把 /api 的返回固定下来，任务清单可控 ─────────────────────────────
//
// ★ 固定返回而不是"连真 Hub"：这条检查要断言的是**界面**（分页/滑动/抽屉），
//   而真 Hub 的数据每天都在变 —— 一份会变的 fixture 让"第 2/5 页"这种断言
//   变成看运气的事。真数据由 `mobile-logged-in-check.mjs` 负责（N=N 那条）。
const TASKS = [
  { id: 'T-901', title: '一条受阻的任务用来看看状态色', status: 'blocked', role: 'coder', priority: 'high' },
  { id: 'T-902', title: '待验收的任务', status: 'in_review', role: 'coder' },
  { id: 'T-903', title: '正在执行的任务', status: 'in_progress', role: 'reviewer', attempt: { state: 'Running' } },
  { id: 'T-904', title: '待办任务一', status: 'todo', role: 'coder' },
  { id: 'T-905', title: '待办任务二（等电脑领取）', status: 'todo', role: 'coder' },
  { id: 'T-906', title: '未排期的任务', status: 'backlog', role: 'coder' },
  { id: 'T-907', title: '已完成的任务', status: 'done', role: 'coder' },
  // 未知状态：这条同时验证"不认识的状态不丢、单列一页、原文标注"。
  { id: 'T-908', title: '状态机新增的未知状态', status: 'weird_new_state', role: 'coder' },
]
// 非空状态列 = 受阻/待验收/进行中/待办/未排期/已完成 + 未知 = 7 页。
const PAGE_COUNT = 7
const messages = [
  { id: 1, seq: 1, role: 'agent', author: 'Coder', body: '第一条消息', createdAt: new Date().toISOString() },
  { id: 2, seq: 2, role: 'user', author: '将军', body: '收到', createdAt: new Date().toISOString() },
]
let messageSeq = messages.length

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  // ── 控制面（只在本脚本里用）──
  if (p === '/__ctl/messages') {
    const n = Number(url.searchParams.get('n') ?? 1)
    for (let i = 0; i < n; i += 1) {
      messageSeq += 1
      messages.push({ id: messageSeq, seq: messageSeq, role: 'agent', author: 'Coder', body: `新消息 #${messageSeq}`, createdAt: new Date().toISOString() })
    }
    return json(res, { ok: true, total: messages.length })
  }

  // ── 桩 API（与真 Hub 的契约同形；只保留这条界面路径会读到的字段）──
  if (p === '/api/identity/status') return json(res, { bootstrapped: true, registration: 'closed' })
  if (p === '/api/identity/login') return json(res, { ok: true, accessToken: 'stub-access', refreshToken: 'stub-refresh', userId: 'u-1', name: '将军' })
  if (p === '/api/identity/refresh') return json(res, { ok: true, accessToken: 'stub-access', refreshToken: 'stub-refresh' })
  if (p === '/api/identity/me') return json(res, { ok: true, user: { userId: 'u-1', name: '将军' }, roles: [{ space: 'default', role: 'general' }] })
  if (p === '/api/board') return json(res, TASKS)
  if (p === '/api/agents') return json(res, { agents: [{ agentId: 'a-1', name: 'Coder', role: 'coder', avatar: 'human:s01', tasks: [] }] })
  if (p === '/api/devices/presence') return json(res, { presence: [] })
  if (p === '/api/activity') return json(res, [])
  if (p === '/api/agent-conversations') return json(res, { convId: 1 })
  if (p === '/api/chat/messages') return json(res, { messages })
  if (p === '/api/events/ticket') return json(res, { ticket: 'stub-ticket' })
  if (p === '/api/events') {
    // SSE：开个头就挂着（这条检查不依赖事件流，只要 EventSource 不把页面搞崩）。
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': stub\n\n')
    return undefined
  }
  if (p.startsWith('/api/')) return json(res, { ok: true })

  // ── 静态资源（workbench/mobile，原样托管）──
  let rel = p.replace(/^\/mobile\//, '').replace(/^\//, '')
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  const file = normalize(join(MOBILE, rel))
  // 目录穿越守卫：静态根之外的路径一律 404。
  if (!file.startsWith(MOBILE + sep) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return undefined }
  try {
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch {
    res.writeHead(500); res.end('read error')
  }
  return undefined
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}/mobile/`

// ── 检查脚手架 ───────────────────────────────────────────────────────────────
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failed += 1
}
const shotDir = await mkdtemp(join(tmpdir(), 'legion-mobile-ui-'))
const browser = await launchChrome()
if (browser === null) {
  server.close()
  // ★ 两种"没有浏览器"必须分开说：一种是本机真没装（那就装或指路径），
  //   另一种是**找到了但起不来**（限制性沙箱常拒绝 spawn / 拒绝监听 DevTools 端口）。
  //   合成一句话会让人去装一个已经装好的浏览器。
  if (findBrowser() === null) {
    console.log('  [skip] 本机没有 Edge/Chrome（可用 DSH_E2E_BROWSER=<路径> 指定）。')
  } else {
    console.log('  [skip] 找到了浏览器但**启动失败**（沙箱可能拒绝了子进程或 DevTools 端口）；已探测到：' + findBrowser())
  }
  process.exit(2)
}

/** 改视口（移动仿真下 meta viewport 会按这个宽度解析）。 */
async function setViewport(page, width, height = 844) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true })
  page.width = width
  page.height = height
  await sleep(140)
}

/** A. 横向溢出：scrollWidth 不许超过可视宽度 1px 以上。 */
const overflow = (page) => page.evaluate(() => ({
  inner: window.innerWidth,
  scroll: document.documentElement.scrollWidth,
}))

/** B. 可交互元素的有效命中区。视觉可以更小，但**矩形**必须 ≥ 44×44。 */
const smallTargets = (page) => page.evaluate(() => {
  const sel = 'button, a, input, select, textarea, [role="button"]'
  const bad = []
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (r.width < 44 || r.height < 44) {
      bad.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) })
    }
  }
  return bad
})

try {
  const page = await browser.newPage()
  await page.goto(BASE, { timeoutMs: 30000 })
  await page.waitFor(() => document.body.dataset.screen === 'login' || document.body.dataset.screen === 'app',
    { timeoutMs: 20000, label: 'screen decided' })
  console.log(`  url: ${BASE}`)
  check('首屏落在登录页（未登录时不该闪主界面）', await page.evaluate(() => document.body.dataset.screen) === 'login')

  // ── A. 七个验收宽度：登录页不横向溢出 ──────────────────────────────────────
  const widths = [320, 360, 390, 414, 430, 768, 1024]
  const loginOverflow = []
  for (const w of widths) {
    await setViewport(page, w)
    const o = await overflow(page)
    if (o.scroll > o.inner + 1) loginOverflow.push({ w, ...o })
    await page.screenshot(join(shotDir, `login-${w}.png`))
  }
  check('★ 登录页在 320/360/390/414/430/768/1024 下都没有**横向溢出**',
    loginOverflow.length === 0, JSON.stringify(loginOverflow))

  // ── B. 登录页的命中区 ─────────────────────────────────────────────────────
  await setViewport(page, 390)
  const loginSmall = await smallTargets(page)
  check('★ 登录页可交互元素的有效命中区都 ≥ 44×44',
    loginSmall.length === 0, JSON.stringify(loginSmall.slice(0, 6)))

  // ── 登录（真实触屏点击 + 真实输入）────────────────────────────────────────
  await page.tapFill('#login-name', 'general')
  await page.tapFill('#login-password', 'stub-password')
  await page.tap('#btn-login')
  await page.waitFor(() => document.body.dataset.screen === 'app', { timeoutMs: 20000, label: 'entered app' })
  check('登录后落到主界面（Agent 页签）',
    await page.evaluate(() => document.getElementById('tab-chat').getAttribute('aria-selected')) === 'true')

  // ── C. 看板：一屏一列、页数、N=N ──────────────────────────────────────────
  await page.tap('#tab-tasks')
  await page.waitFor(() => document.getElementById('board-track') !== null, { timeoutMs: 15000, label: 'board rendered' })
  const board = await page.evaluate(() => ({
    pages: document.querySelectorAll('.board-page').length,
    current: Number(document.querySelector('.board-page[aria-hidden="false"]')?.dataset.page ?? -1),
    cards: document.querySelectorAll('.task').length,
    indicator: document.getElementById('page-indicator')?.textContent ?? '',
    navVisible: !document.getElementById('board-nav').classList.contains('hidden'),
    trackTransform: getComputedStyle(document.getElementById('board-track')).transform,
    columnTones: [...document.querySelectorAll('.task')].map((c) => c.dataset.tone),
  }))
  check(`★ 看板一屏一列：页数 = 非空状态列（期望 ${PAGE_COUNT}）`, board.pages === PAGE_COUNT, `pages=${board.pages}`)
  check('★ 接口 8 条任务 = 页面 8 张卡（N=N，未知状态不丢）', board.cards === TASKS.length, `cards=${board.cards}`)
  check('★ 首屏停在第 1 页（轨道没有被推到别处）',
    board.current === 0 && /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(board.trackTransform), board.trackTransform)
  check('★ 有页码指示与左右替代按钮（滑动的可见替代）',
    board.navVisible && /第 1\/7 页/.test(board.indicator), board.indicator)
  check('★ 状态色按 tone 落在卡片上（颜色 + 文字双重编码）',
    board.columnTones.includes('warn') && board.columnTones.includes('busy') && board.columnTones.includes('ok'),
    JSON.stringify([...new Set(board.columnTones)]))
  await page.screenshot(join(shotDir, 'tasks-390.png'))

  // ── D. 手势：横向切列 / 纵向不切 / 边缘不接 ───────────────────────────────
  const swipe = async (x1, y1, x2, y2) => {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1, radiusX: 12, radiusY: 12, force: .5 }] })
    for (let i = 1; i <= 6; i += 1) {
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6, id: 1, radiusX: 12, radiusY: 12, force: .5 }],
      })
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(420)
  }
  const currentPage = () => page.evaluate(() => Number(document.querySelector('.board-page[aria-hidden="false"]')?.dataset.page ?? -1))

  await swipe(320, 500, 160, 505)
  const afterLeft = await currentPage()
  check('★ 左滑 160px 切到第 2 页', afterLeft === 1, `page=${afterLeft}`)

  await swipe(160, 500, 320, 505)
  const afterRight = await currentPage()
  check('★ 右滑回第 1 页（不循环、不跳页）', afterRight === 0, `page=${afterRight}`)

  await swipe(200, 620, 205, 380)
  const afterVertical = await currentPage()
  check('★★★ 纵向滑动**不切列**（滚动优先）', afterVertical === 0, `page=${afterVertical}`)

  await swipe(6, 500, 170, 505)
  const afterEdge = await currentPage()
  check('★★ 起点在左边缘 20px 内不接手势（让系统返回手势通过）', afterEdge === 0, `page=${afterEdge}`)

  await page.tap('#board-next')
  const afterNext = await currentPage()
  check('★ 左右按钮同样能切列（滑动的替代路径）', afterNext === 1, `page=${afterNext}`)
  await page.tap('#board-prev')

  // ── E. 卡片 → 详情层 ─────────────────────────────────────────────────────
  const t0 = Date.now()
  await page.tap('#card-T-901')
  await page.waitFor(() => !document.getElementById('task-sheet').classList.contains('hidden'), { timeoutMs: 2000, label: 'sheet open' })
  const openMs = Date.now() - t0
  const sheet = await page.evaluate(() => ({
    title: document.getElementById('sheet-title').textContent,
    status: document.getElementById('sheet-status').textContent,
    where: document.getElementById('sheet-where').textContent,
    acts: [...document.querySelectorAll('#sheet-acts button')].map((b) => b.textContent),
    focused: document.activeElement?.id ?? null,
  }))
  check('★★ 点卡片 200ms 内出详情层（含一次往返的余量）', openMs <= 260, `openMs=${openMs}`)
  check('★ 详情层显示任务号+标题、状态一句话、所属列/视角',
    sheet.title.startsWith('T-901') && sheet.status.length > 0 && sheet.where.includes('受阻') && sheet.where.includes('全部'),
    JSON.stringify([sheet.title, sheet.status, sheet.where]))
  check('★ 详情层只有现有动作（追加要求 / 问这个 Agent）',
    sheet.acts.length === 2 && sheet.acts.includes('追加要求') && sheet.acts.includes('问这个 Agent'),
    JSON.stringify(sheet.acts))
  check('★ 打开后焦点进入详情层（关闭按钮）', sheet.focused === 'sheet-close', String(sheet.focused))
  await page.screenshot(join(shotDir, 'sheet-390.png'))
  await page.press('Escape')
  await page.waitFor(() => document.getElementById('task-sheet').classList.contains('hidden'), { timeoutMs: 2000, label: 'sheet closed' })
  const back = await page.evaluate(() => document.activeElement?.id ?? null)
  check('★ Esc 关闭详情层，焦点回到触发卡片', back === 'card-T-901', String(back))

  // ── F. 对话：向上读历史时不被拽到底 ───────────────────────────────────────
  await page.tap('#tab-chat')
  await page.waitFor(() => document.querySelectorAll('#timeline .msg').length >= 2, { timeoutMs: 10000, label: 'timeline rendered' })
  await page.evaluate(() => { document.getElementById('main').scrollTop = 0 })
  await sleep(120)
  // 桩 Hub 多条新消息 + 点刷新（= 一次 SSE/轮询刷新）。
  await fetch(`${BASE.replace('/mobile/', '')}__ctl/messages?n=5`)
  await page.tap('#btn-refresh')
  await sleep(1000)
  const timeline = await page.evaluate(() => {
    const m = document.getElementById('main')
    return {
      scrollTop: Math.round(m.scrollTop),
      pillVisible: !document.getElementById('new-msg-pill').classList.contains('hidden'),
      pillText: document.getElementById('new-msg-jump').textContent,
      msgs: document.querySelectorAll('#timeline .msg').length,
    }
  })
  check('★★ 距底 >40px 时刷新**不**把视图拽到底（scrollTop 仍在 0 附近）',
    timeline.scrollTop <= 4 && timeline.msgs >= 7, `scrollTop=${timeline.scrollTop} msgs=${timeline.msgs}`)
  check('★ 出现「N 条新消息」入口', timeline.pillVisible && /新消息/.test(timeline.pillText), timeline.pillText)
  await page.tap('#new-msg-jump')
  await sleep(350)
  const jumped = await page.evaluate(() => {
    const m = document.getElementById('main')
    return {
      distance: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      hidden: document.getElementById('new-msg-pill').classList.contains('hidden'),
    }
  })
  check('★ 点「新消息」回到底部并清零', jumped.distance <= 4 && jumped.hidden, JSON.stringify(jumped))

  // ── A（续）/ B（续）：主界面在七个宽度下同样不溢出、命中区达标 ─────────────
  await page.tap('#tab-tasks')
  await sleep(350)
  const appOverflow = []
  const appSmall = []
  for (const w of widths) {
    await setViewport(page, w)
    const o = await overflow(page)
    if (o.scroll > o.inner + 1) appOverflow.push({ w, ...o })
    const small = await smallTargets(page)
    if (small.length > 0) appSmall.push({ w, small: small.slice(0, 4) })
    await page.screenshot(join(shotDir, `tasks-${w}.png`))
  }
  check('★ 主界面在七个验收宽度下都没有横向溢出', appOverflow.length === 0, JSON.stringify(appOverflow))
  check('★ 主界面（卡片、分页按钮、视角 chip、头部按钮）命中区都 ≥ 44×44',
    appSmall.length === 0, JSON.stringify(appSmall))

  await setViewport(page, 390)
  check('★ 主路径 0 个未捕获异常 / console.error',
    (page.pageErrors ?? []).length === 0 && (page.consoleErrors ?? []).length === 0,
    [...(page.pageErrors ?? []), ...(page.consoleErrors ?? [])].slice(0, 3).join(' | '))
  console.log(`  截图：${shotDir}`)
} finally {
  await browser.close?.()
  server.close()
  if (!KEEP && failed === 0) await rm(shotDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n  ${failed === 0 ? 'ALL UI CHECKS PASSED' : failed + ' UI CHECK(S) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)

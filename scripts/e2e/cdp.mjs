/**
 * cdp.mjs — 零依赖浏览器自动化基座（P4-1）。
 *
 * 为什么是 CDP 而不是 Playwright/Puppeteer：
 *   · 本仓库对前端只有「判定层纯函数测试 + 静态契约测试」，DOM 行为不自动断言（REMAINING-TASKS #6）；
 *     要补的就是**真实浏览器里的真实事件与真实渲染结果**，而不是再多一层 JS API 抽象；
 *   · 本机已有 Edge/Chrome（`workbench/scripts/serve.mjs` 的截图能力已经在用同一个二进制），
 *     Node 24 自带 `WebSocket` 与 `fetch` —— 直连 CDP 既不需要新增依赖，也不引入版本矩阵；
 *   · 少一层依赖 = CI 里少一类「装不上/下不来浏览器」的失败面（本仓库 CI 是单命令、无网络假设）。
 *
 * 能力边界（够用即止，不做「通用自动化框架」）：
 *   导航 / 求值 / 等待 / 真实鼠标点击与拖拽 / 真实触屏轻点 / 键盘输入 /
 *   控制台与页面错误收集 / 截图 / **移动端设备仿真**（见下）。
 *   **不做**：多标签页编排、网络拦截、文件下载、隔离世界。
 *
 * 移动端仿真（T-195 补；此前本文件明写「不做」）：
 *   `launchBrowser({ mobile: true })` 或 `newPage({ mobile: true })` 会打开
 *   `Emulation.setDeviceMetricsOverride(mobile:true)` + `setTouchEmulationEnabled`
 *   + 移动 UA，并提供 `page.tap()`（走 `Input.dispatchTouchEvent`，真触屏事件）。
 *
 *   为什么这件事值得单独写清楚：一个用**桌面视口 + 合成 click**打开的页面，
 *   与一个用**移动视口 + 真实触屏事件**打开的页面，在断言「手机上能用」这件事上
 *   不是同一个东西——只不过前者在一份"移动端 E2E 全绿"的报告里看起来是一样的。
 *   ⚠️ 它仍然**不是真机**：这是桌面 Chrome 的设备仿真，触摸 / UA / 视口 / DPR 相似而非相同。
 *
 * 纪律：
 *   · 每次运行使用**临时 user-data-dir**，用后删除 —— 绝不碰用户真实浏览器配置（Cookie/登录态）；
 *   · 找不到浏览器时抛 `BrowserUnavailableError`，由测试侧转成**显式 SKIP**，绝不伪造通过；
 *   · 页面报错（未捕获异常 / console.error）默认收集，用例可断言「主路径无报错」；
 *   · `mobile` 默认 `false`：既有桌面套件的挂载参数与行为**逐字节不变**（仿真只在显式要求时开）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 找不到可用浏览器（测试侧应转成 skip，而不是 fail 或假绿）。 */
export class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

/**
 * 移动端仿真的默认设备档。
 *
 * 取值理由（不是随手挑的）：
 *   · `390×844 / DPR 3` 是一台中端现代手机的**逻辑视口**（iPhone 12/13/14 一档），
 *     也是本仓库 `workbench/mobile/` 布局按「一列、单手可达」设计的目标宽度；
 *   · `maxTouchPoints: 5` 是移动 Chrome 的常见读数——多点触控能力**存在**，
 *     免得把「只用单指」实现出来的 bug 伪装成「这台设备不支持多指」；
 *   · UA 保留 `Mobile` 与 `Android` 两个标记：`app.mjs`/`sw.js` 若按 UA 分支，
 *     这里必须命中手机分支，否则测的就不是手机那条路。
 */
export const MOBILE_DEVICE = Object.freeze({
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  maxTouchPoints: 5,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Mobile Safari/537.36',
})

/** 常见安装位置（可用 DSH_E2E_BROWSER / DSH_WEB_SHOT_BROWSER 覆盖）。 */
function candidatePaths() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const list = []
  if (process.platform === 'win32') {
    list.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    )
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    list.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    )
  }
  return list.filter(Boolean)
}

/** 探测可用浏览器；找不到返回 null（不抛）。环境变量优先。 */
export function findBrowser() {
  const fromEnv = process.env.DSH_E2E_BROWSER || process.env.DSH_WEB_SHOT_BROWSER
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null
  for (const p of candidatePaths()) if (existsSync(p)) return p
  return null
}

/** 探测并给出**可执行**的结论（供 CI/文档打印）：找到什么、试过哪些路径。 */
export function browserProbe() {
  const exe = findBrowser()
  return { available: exe !== null, exe, tried: candidatePaths(), envHint: 'DSH_E2E_BROWSER=<可执行文件路径>' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 一个 CDP 连接：请求/响应配对 + 事件订阅。
 * 支持「扁平化会话」：命令可带 `sessionId` 下发到某个 target，事件按 `sessionId` 路由回来
 * （`Target.attachToTarget({flatten:true})` 的语义）—— 这是能用**一条** WebSocket 同时
 * 驱动浏览器与页面两个域的关键。
 */
class CDPSession {
  constructor(ws, label = 'browser') {
    this.ws = ws
    this.label = label
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${p.method} 失败：${msg.error.message}`))
        else p.resolve(msg.result)
        return
      }
      // 事件：扁平化会话的事件带 sessionId，必须按会话路由（否则页面事件会被当成浏览器事件）
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method
      for (const fn of this.listeners.get(key) ?? []) fn(msg.params)
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method} 失败：CDP 连接已关闭`))
      this.pending.clear()
    })
  }

  send(method, params = {}, { timeoutMs = 20000, sessionId } = {}) {
    if (this.ws.readyState !== 1) return Promise.reject(new Error('CDP 连接不可用（readyState=' + this.ws.readyState + '）'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify(payload))
    })
  }

  on(method, fn, { sessionId } = {}) {
    const key = sessionId ? `${sessionId}:${method}` : method
    if (!this.listeners.has(key)) this.listeners.set(key, [])
    this.listeners.get(key).push(fn)
    return () => {
      const arr = this.listeners.get(key) ?? []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  }
}

/**
 * 启动一个真实浏览器并连上它的 CDP。
 * @param {{ headless?: boolean, width?: number, height?: number, timeoutMs?: number, extraArgs?: string[],
 *           mobile?: boolean, deviceScaleFactor?: number, maxTouchPoints?: number, userAgent?: string }} [opts]
 *   `mobile:true` 时，未显式给出的视口 / DPR / UA / 触点数取 {@link MOBILE_DEVICE} 的默认档。
 * @returns {Promise<Browser>}
 */
export async function launchBrowser(opts = {}) {
  const exe = findBrowser()
  if (!exe) {
    throw new BrowserUnavailableError(
      '未找到 Edge/Chrome（试过：' + candidatePaths().join(', ') + '）；可用 DSH_E2E_BROWSER=<路径> 指定',
    )
  }
  const headless = opts.headless !== false
  // 移动仿真档：显式选项 > MOBILE_DEVICE 默认 > 桌面默认。`mobile:false` 时完全走旧路径。
  const mobile = opts.mobile === true
  const device = mobile ? MOBILE_DEVICE : null
  const width = opts.width ?? device?.width ?? 900
  const height = opts.height ?? device?.height ?? 640
  const deviceScaleFactor = opts.deviceScaleFactor ?? device?.deviceScaleFactor ?? 1
  const maxTouchPoints = opts.maxTouchPoints ?? device?.maxTouchPoints ?? 1
  const userAgent = opts.userAgent ?? device?.userAgent ?? null
  const profileDir = mkdtempSync(join(tmpdir(), 'legion-e2e-profile-'))

  const argv = [
    // headless=new：真实渲染管线（旧 headless 对 canvas/字体差异更大）
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0', // 端口由浏览器自选，从 DevTools 行读出（避免端口冲突）
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
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
    ...(opts.extraArgs ?? []),
  ]

  const child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stdout.setEncoding('utf8')
  child.stderr.on('data', (d) => { stderr += d })
  child.stdout.on('data', (d) => { stderr += d })

  const timeoutMs = opts.timeoutMs ?? 30000
  const wsUrl = await (async () => {
    const t0 = Date.now()
    for (;;) {
      const m = /ws:\/\/[^\s]+/.exec(stderr)
      if (m) return m[0]
      if (child.exitCode !== null) {
        throw new BrowserUnavailableError(`浏览器进程提前退出（code=${child.exitCode}）：${stderr.slice(-400)}`)
      }
      if (Date.now() - t0 > timeoutMs) {
        try { child.kill('SIGKILL') } catch { /* gone */ }
        throw new BrowserUnavailableError('等待 DevTools 端口超时：' + stderr.slice(-400))
      }
      await sleep(50)
    }
  })()

  const browser = new Browser({
    child, wsUrl, profileDir, exe,
    defaults: { width, height, mobile, deviceScaleFactor, maxTouchPoints, userAgent },
  })
  await browser._connect(timeoutMs)
  return browser
}

/** 浏览器：连接、开页、关闭。 */
class Browser {
  constructor({ child, wsUrl, profileDir, exe, defaults = {} }) {
    this.child = child
    this.wsUrl = wsUrl
    this.profileDir = profileDir
    this.exe = exe
    // 每个新页都继承这一组仿真参数（`newPage()` 可逐页覆盖）。
    this.defaults = defaults
    this.closed = false
  }

  async _connect(timeoutMs) {
    this.session = await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      const timer = setTimeout(() => reject(new BrowserUnavailableError('CDP 连接超时：' + this.wsUrl)), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CDPSession(ws)) })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new BrowserUnavailableError('CDP 连接失败：' + this.wsUrl)) })
    })
    // 记录浏览器版本：证据与排障时「到底跑在哪个浏览器/协议版本上」必须可复述（拿不到不影响使用）
    try {
      this.versionInfo = await this.session.send('Browser.getVersion', {}, { timeoutMs: 5000 })
    } catch {
      this.versionInfo = null
    }
  }

  /** 浏览器版本信息（`Browser.getVersion`；不可用时退化为可执行文件路径）。 */
  version() {
    return this.versionInfo ? { ...this.versionInfo } : { product: null, exe: this.exe }
  }

  /**
   * 新开一页并完成初始化（收集 console/页面错误，启用 Page/Runtime/Input）。
   * @param {{ width?: number, height?: number, mobile?: boolean, deviceScaleFactor?: number,
   *           maxTouchPoints?: number, userAgent?: string|null }} [opts]
   *   不给则继承 `launchBrowser` 的仿真档。
   * @returns {Promise<Page>}
   */
  async newPage(opts = {}) {
    const spec = { ...this.defaults, ...opts }
    const { targetId } = await this.session.send('Target.createTarget', { url: 'about:blank' })
    const page = new Page(this, targetId, spec)
    await page._attach()
    return page
  }

  /** 关闭浏览器并删除临时 profile（幂等）。 */
  async close() {
    if (this.closed) return
    this.closed = true
    try { this.session.ws.close() } catch { /* already closed */ }
    try { this.child.kill() } catch { /* already gone */ }
    await sleep(150)
    if (this.child.exitCode === null) { try { this.child.kill('SIGKILL') } catch { /* gone */ } }
    for (let i = 0; i < 6; i += 1) {
      try { rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break } catch { await sleep(150) }
    }
  }
}

/** 页面：导航、求值、等待、真实输入（鼠标 / 触屏）。 */
class Page {
  constructor(browser, targetId, {
    width = 900, height = 640, mobile = false,
    deviceScaleFactor = 1, maxTouchPoints = 1, userAgent = null,
  } = {}) {
    this.browser = browser
    this.targetId = targetId
    this.width = width
    this.height = height
    this.mobile = mobile === true
    this.deviceScaleFactor = deviceScaleFactor
    this.maxTouchPoints = maxTouchPoints
    this.userAgent = userAgent
    this.consoleErrors = []
    this.pageErrors = []
    this.consoleLogs = []
  }

  async _attach() {
    const { sessionId } = await this.browser.session.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    this.sessionId = sessionId
    this.session = this.browser.session
    const send = (method, params = {}, o = {}) => this.session.send(method, params, { ...o, sessionId })
    const on = (method, fn) => this.session.on(method, fn, { sessionId })
    this.send = send
    this.on = on

    await send('Page.enable')
    await send('Runtime.enable')
    if (this.width && this.height) {
      // `mobile:true` 会让渲染器按移动视口处理（含 meta viewport 的解析与缩放）。
      // 它与触摸仿真**必须成对**：只改视口的页面仍然收不到 touch 事件，
      // 只开触摸的页面仍是桌面布局——两种半开状态都会让「手机上能用」的结论失真。
      await send('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: this.deviceScaleFactor,
        mobile: this.mobile,
      })
    }
    if (this.mobile) {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: this.maxTouchPoints })
      if (this.userAgent) await send('Emulation.setUserAgentOverride', { userAgent: this.userAgent })
    } else if (this.userAgent) {
      await send('Emulation.setUserAgentOverride', { userAgent: this.userAgent })
    }
    on('Runtime.consoleAPICalled', (p) => {
      const line = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      this.consoleLogs.push({ type: p.type, line })
      if (p.type === 'error') this.consoleErrors.push(line)
    })
    on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {}
      this.pageErrors.push(d.exception?.description ?? d.text ?? 'unknown exception')
    })
  }

  /** 导航并等待 load 事件（相对地址按 baseUrl 解析）。 */
  async goto(url, { timeoutMs = 20000 } = {}) {
    const loaded = new Promise((resolve) => this.on('Page.loadEventFired', resolve))
    await this.send('Page.navigate', { url })
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('页面加载超时：' + url)), timeoutMs)
    })
    try {
      await Promise.race([loaded, timeout])
    } finally {
      clearTimeout(timer)
    }
    return this
  }

  /** 在页面里求值（函数会被序列化执行；返回 JSON 可序列化的值）。 */
  async evaluate(fn, ...args) {
    const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面求值抛错：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    }
    return r.result?.value
  }

  /** 轮询直到页面内 predicate 为真；超时抛错并带上最后一次取值。 */
  async waitFor(fn, { timeoutMs = 5000, intervalMs = 50, label = 'waitFor' } = {}) {
    const t0 = Date.now()
    let last
    for (;;) {
      last = await this.evaluate(fn)
      if (last) return last
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`${label} 超时（${timeoutMs}ms）；最后一次取值=${JSON.stringify(last)}`)
      }
      await sleep(intervalMs)
    }
  }

  /** 元素盒模型中心点（视口坐标）；元素不存在或不可见时抛错。 */
  async centerOf(selector) {
    const box = await this.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    }, selector)
    if (!box) throw new Error(`选择器无匹配元素：${selector}`)
    if (box.w === 0 || box.h === 0) throw new Error(`元素不可见（尺寸为 0）：${selector}`)
    return box
  }

  // ---------- 真实输入（Input 域 → 浏览器生成事件，而不是页内合成事件对象） ----------
  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  }

  async mouseDown(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount,
    })
  }

  async mouseUp(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, buttons: 0, clickCount,
    })
  }

  /** 点击元素中心（真实鼠标事件）。 */
  async click(selector) {
    const c = await this.centerOf(selector)
    await this.mouseMove(c.x, c.y)
    await this.mouseDown(c.x, c.y)
    await this.mouseUp(c.x, c.y)
    return c
  }

  // ---------- 真实触屏（移动仿真下用；Input.dispatchTouchEvent） ----------

  /**
   * 向某坐标发一次真实触屏轻点（`touchStart` → `touchEnd`）。
   *
   * 为什么不用 `click()` 冒充：在 `mobile:true` 的设备仿真下，浏览器按**触屏**规则
   * 处理输入——`pointerdown` 的 `pointerType` 是 `touch`、`matchMedia('(pointer:coarse)')`
   * 为真，且 `touchstart` 监听器会被触发，而合成鼠标事件**不会**触发 `touchstart`。
   * 只测 click 的实现会在真机上第一次触摸就露馅，而仿真里始终是绿的。
   *
   * @param {number} x 视口坐标
   * @param {number} y 视口坐标
   * @param {{ touchPoints?: number, id?: number }} [opts]
   */
  async tapAt(x, y, { touchPoints = 1, id = 1 } = {}) {
    const points = Array.from({ length: touchPoints }, (_, i) => ({
      x, y, radiusX: 12, radiusY: 12, force: 0.5, id: id + i,
    }))
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points })
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  /** 轻点元素中心（真实触屏事件）。元素不可见即抛错，不静默点空。 */
  async tap(selector, opts) {
    const c = await this.centerOf(selector)
    await this.tapAt(c.x, c.y, opts)
    return c
  }

  /**
   * 触屏输入文本：先轻点聚焦，再用 `Input.insertText`。
   * 移动端软键盘不上屏，所以「聚焦 + 插字」是这条链上唯一可自动化的等价动作。
   */
  async tapFill(selector, text) {
    await this.tap(selector)
    await this.evaluate((sel) => { const el = document.querySelector(sel); if (el && el.select) el.select() }, selector)
    await this.send('Input.insertText', { text })
  }

  /** 拖拽（按下 → 若干中间点 → 松开）；steps 越多越接近人手轨迹。 */
  async drag(from, to, { steps = 6 } = {}) {
    await this.mouseMove(from.x, from.y)
    await this.mouseDown(from.x, from.y)
    for (let i = 1; i <= steps; i += 1) {
      await this.mouseMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    }
    await this.mouseUp(to.x, to.y)
  }

  /** 聚焦某元素后输入文本（先全选覆盖）。 */
  async fill(selector, text) {
    await this.click(selector)
    await this.evaluate((sel) => { const el = document.querySelector(sel); if (el && el.select) el.select() }, selector)
    await this.send('Input.insertText', { text })
  }

  /** 键盘按键（Enter / Tab / Escape 等）。 */
  async press(key) {
    const map = {
      Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
      Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
      Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
    }
    const k = map[key] ?? { key, code: key }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined })
  }

  /** 截图到文件（PNG）。 */
  async screenshot(file, { fullPage = false } = {}) {
    const params = { format: 'png' }
    if (!fullPage && this.width && this.height) {
      params.clip = { x: 0, y: 0, width: this.width, height: this.height, scale: 1 }
    }
    const { data } = await this.send('Page.captureScreenshot', params)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  /** 常用读数的快捷方式。 */
  text(selector) {
    return this.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selector)
  }

  async close() {
    try { await this.browser.session.send('Target.closeTarget', { targetId: this.targetId }) } catch { /* already gone */ }
  }
}

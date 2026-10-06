import { randomUUID } from 'node:crypto'
import { createLineDecoder, MAX_LINE_BYTES, parseRequest } from '../product/launcher/desktop-protocol.mjs'

export function workbenchTarget(payload) {
  if (payload?.state !== 'ready' && payload?.state !== 'degraded') return null
  const value = payload.workbenchUrl
  return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(value) ? value : null
}

export function canNavigate(target, { startup, origin }) {
  if (target === startup) return true
  if (!origin) return false
  try {
    const url = new URL(target)
    return url.protocol === 'http:' && url.origin === origin && url.username === '' && url.password === ''
  } catch { return false }
}

export function externalUrl(target) {
  try {
    const url = new URL(target)
    if (url.protocol === 'https:' && url.username === '' && url.password === '') return target
    if (url.protocol === 'mailto:' && url.pathname !== '') return target
  } catch {}
  return null
}

export function closeAction({ quitting, closeToTray }) {
  return !quitting && closeToTray ? 'hide' : 'close'
}

/**
 * 「桌面可交互」的一次性标记（设计 §6 line 132）。
 *
 * > 启动达到桌面可交互状态后延迟 30～90 秒首次检查；之后以 6 小时为基准、
 * > ±20% 抖动检查。
 *
 * ## ★★★ 为什么需要这个工厂，而不是一个布尔量
 *
 * 原来的写法是：
 *
 * ```js
 * let marked = false
 * function markUpdateInteractive() {
 *   if (marked) return
 *   marked = true                      // ← 先置位
 *   try { updateRuntime?.markInteractive?.() } catch {}   // ← 再投递
 * }
 * ```
 *
 * ★ 而 `updateRuntime` 在启动那一刻**是 `null`**：`app.whenReady()` 里的顺序是
 *
 * ```js
 * createWindow()        // 注册 ready-to-show
 * createTray()
 * startUpdateRuntime()  // async，**没有 await**
 * ```
 *
 * `ready-to-show` 与 `resolveUpdateRuntime()` 都要等异步，**谁先到不确定**。
 * 于是"窗口先画出来"那一次调用会走进上面那段代码：`marked` 被置为 `true`，
 * 而 `updateRuntime?.markInteractive?.()` 是一个**空操作**（可选链把 null 吃掉）。
 * 之后运行时装载完成，**再也没有人来标记**——
 *
 * > 一次**被空操作消费掉**的一次性标记，与一次从来没发生过的标记，
 * > 在用户那一端是同一件事：**自动检查永远不会开始**。
 *
 * 而且它是竞态：开发模式下窗口加载慢（Vite dev server）就正常，打包之后
 * 本地文件加载快就可能失效——**同一份代码，两种行为**。
 *
 * ## 判据
 *
 * **标记只在投递成功时才被消费。** 投递失败（运行时还没好、`ok !== true`、
 * 或者 `markInteractive` 抛错）⇒ 返回 `delivered: false`，下一次调用**还会再试**。
 *
 * @param {object} args
 * @param {Function} args.readRuntime 读当前运行时（可能返回 null）
 */
export function createInteractiveMarker({ readRuntime }) {
  if (typeof readRuntime !== 'function') throw new Error('createInteractiveMarker 需要 readRuntime')
  let delivered = false
  /**
   * @returns {{delivered: boolean, alreadyDelivered: boolean, reason: string|null}}
   */
  return function markInteractive() {
    if (delivered) {
      return Object.freeze({ delivered: true, alreadyDelivered: true, reason: null })
    }
    const runtime = readRuntime()
    if (runtime === null || runtime === undefined) {
      return Object.freeze({ delivered: false, alreadyDelivered: false, reason: '更新运行时还未装载' })
    }
    if (runtime.ok !== true) {
      return Object.freeze({
        delivered: false, alreadyDelivered: false,
        reason: `更新运行时不可用：${runtime.reason ?? '（没有给出原因）'}`,
      })
    }
    if (typeof runtime.markInteractive !== 'function') {
      return Object.freeze({
        delivered: false, alreadyDelivered: false,
        reason: '更新运行时没有 markInteractive —— 首次检查不会被安排',
      })
    }
    try {
      runtime.markInteractive()
    } catch (error) {
      // ★ 投递抛错同样**不消费**标记：下一次（面板打开、或运行时装载完成后的
      //   那一次补投）还会再试。一次抛错不该让自动检查永久失效。
      return Object.freeze({
        delivered: false, alreadyDelivered: false,
        reason: `标记可交互时抛错：${error?.message ?? error}`,
      })
    }
    delivered = true
    return Object.freeze({ delivered: true, alreadyDelivered: false, reason: null })
  }
}

export function desktopRequestHeaders(details, { origin, token, webContentsId }) {
  const headers = { ...details.requestHeaders }
  if (!origin || !token || details.webContentsId !== webContentsId || details.frame?.parent !== null
    || details.resourceType === 'subFrame' || !canNavigate(details.url, { origin })) return headers
  if (details.resourceType !== 'mainFrame' && !canNavigate(details.frame.url, { origin })) return headers
  const suppliedOrigin = Object.entries(headers).find(([key]) => key.toLowerCase() === 'origin')?.[1]
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) return headers
  for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key]
  headers.Authorization = `Bearer ${token}`
  return headers
}

const PORT_PROCESS_KEYS = new Set(['team-hub', 'workbench', 'runtime', 'whiteboard'])

/**
 * 造一个"后台拒绝了这次请求"的错误。
 *
 * ★ `reason` 必须带上。后台的拒绝**一直**带着一句中文说明（
 *   `desktop-bridge.mjs` 每个 `ok: false` 的 payload 里都有 `reason`），
 *   而这里此前只取 `code`，把那句话丢掉了——于是用户看到的是一串大写的
 *   内部码，而写那句话的人本来是为了让他看懂。
 *
 *   > 一条被丢掉的错误解释，与一条从来没写过的错误解释，
 *   > 在用户那一端是同一个东西。
 */
function clientError(code, { portConflict = null, reason = null } = {}) {
  const detail = typeof reason === 'string' && reason !== '' ? `：${reason}` : ''
  const error = Object.assign(new Error(`${code}${detail}`), { code })
  if (typeof reason === 'string' && reason !== '') error.reason = reason
  if (portConflict && typeof portConflict === 'object' && PORT_PROCESS_KEYS.has(portConflict.process)
    && Number.isInteger(portConflict.port) && portConflict.port > 0 && portConflict.port <= 65535
    && typeof portConflict.listening === 'boolean') {
    error.portConflict = Object.freeze({ process: portConflict.process, port: portConflict.port, listening: portConflict.listening })
  }
  return error
}

/**
 * 每个命令的等待上限。
 *
 * ★★ 这张表**必须覆盖协议里的每一个类型**，因为取值的写法是
 *   `deadlines[type] ?? BRIDGE_DEADLINES[type]`，而 `undefined` 传给
 *   `setTimeout` 是 **0 毫秒**——不是在"没有上限"和"用默认值"之间选，而是
 *   **立刻超时**。一个新命令忘了登记在这张表里，表现是它永远返回
 *   `BRIDGE_TIMEOUT`，而原因看起来像"Launcher 卡住了"。
 *
 *   `desktop/main.test.mjs` 有一条判据拿协议的类型表逐个问这张表，
 *   就是为了让"新加一个命令"这件事不能只改一半。
 */
export const BRIDGE_DEADLINES = Object.freeze({
  status: 10_000, detach: 10_000, start: 720_000, restart: 780_000, stop: 90_000,
  // 停止认领要等 `orchestrator` 进程体面退出（Launcher 侧给 5s 宽限，加上
  // 进程树回收），所以比 `stop` 再宽松一档；恢复认领只是拉起一个进程。
  'stop-claiming': 120_000, 'resume-claiming': 60_000,
  'prepare-runtime': 600_000, 'configure-workspace': 30_000,
  'configure-identity': 30_000, 'configure-model': 45_000,
  // 在途任务读数是**读**命令（走的是本地 HTTP），给一个短上限即可。
  tasks: 15_000,
})

export function createBridgeClient(child, {
  onEvent = () => {}, deadlines = BRIDGE_DEADLINES, maxPending = 16, exitTimeoutMs = 15_000,
} = {}) {
  const pending = new Map()
  let exited = false
  let closing = false
  let failure = null
  let exitFailure = null
  let observeExit
  const actualExit = new Promise(resolve => { observeExit = resolve })
  const failAll = (code) => {
    failure ??= code
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(clientError(code))
    }
    pending.clear()
  }
  const decoder = createLineDecoder((line) => {
    if (failure) return
    if (typeof line !== 'string') { failAll('BRIDGE_PROTOCOL_ERROR'); return }
    let message
    try { message = JSON.parse(line) } catch { failAll('BRIDGE_PROTOCOL_ERROR'); return }
    if (message?.version !== 1) { failAll('BRIDGE_PROTOCOL_ERROR'); return }
    if (message.type !== 'result') { onEvent(message); return }
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    clearTimeout(slot.timer)
    if (message.ok === true) slot.resolve(message.payload)
    else slot.reject(clientError(message.payload?.code ?? 'BRIDGE_FAILED', { portConflict: message.payload?.portConflict, reason: message.payload?.reason }))
  })
  child.stdout.on('data', (chunk) => decoder.push(chunk))
  child.on('exit', (code, signal) => {
    exited = true
    if (code !== 0 || signal) exitFailure = 'BRIDGE_EXIT_FAILED'
    failAll('BRIDGE_EXITED')
    observeExit()
  })
  child.on('error', () => {
    failAll('BRIDGE_EXITED')
    // A failed spawn has no process whose exit we can observe.
    if (!child.pid) { exited = true; exitFailure = 'BRIDGE_EXIT_FAILED'; observeExit() }
  })
  child.stdin.on('error', () => failAll('BRIDGE_WRITE_FAILED'))
  return {
    request(type, payload = {}) {
      if (closing) return Promise.reject(clientError('BRIDGE_CLOSING'))
      if (failure) return Promise.reject(clientError(failure))
      if (pending.size >= maxPending) return Promise.reject(clientError('BRIDGE_BUSY'))
      const id = randomUUID()
      let wire
      try {
        wire = `${JSON.stringify({ version: 1, id, type, payload })}\n`
        if (Buffer.byteLength(wire) - 1 > MAX_LINE_BYTES) throw clientError('LINE_TOO_LARGE')
        parseRequest(wire)
      } catch (error) { return Promise.reject(clientError(error.code ?? 'BAD_PAYLOAD')) }
      return new Promise((resolve, reject) => {
        const timeoutMs = deadlines[type] ?? BRIDGE_DEADLINES[type]
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(clientError('BRIDGE_TIMEOUT'))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        const writeFailed = () => {
          clearTimeout(timer)
          if (pending.delete(id)) reject(clientError('BRIDGE_WRITE_FAILED'))
        }
        try { child.stdin.write(wire, error => { if (error) writeFailed() }) } catch { writeFailed() }
      })
    },
    async close({ detach = false } = {}) {
      if (!closing) {
        closing = true
        if (!exited) child.stdin.end()
      }
      if (detach) {
        child.stdout.destroy()
        child.stderr?.destroy()
        child.stdin.destroy()
        child.unref?.()
        return
      }
      let timer
      try {
        await Promise.race([actualExit, new Promise((_, reject) => {
          timer = setTimeout(() => reject(clientError('BRIDGE_EXIT_TIMEOUT')), exitTimeoutMs)
        })])
        if (exitFailure) throw clientError(exitFailure)
      } finally { clearTimeout(timer) }
    },
  }
}

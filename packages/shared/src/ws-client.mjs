// packages/shared/src/ws-client.mjs
// ============================================================================
// 零依赖 RFC6455 WebSocket **客户端**（远程 Agent 通道 S-A 的另一半）
//
// 为什么需要它：`whiteboard/apps/server/src/ws.mjs` 是服务端实现，它的
// `encodeFrame` 恒发**未掩码**帧。一个发未掩码帧的客户端会被合规服务端按协议
// 错误断开——而且是在**握手成功之后**断开，表现出来像"连上了又掉线"。
// 所以客户端不是"服务端反过来用"，它有一个方向上的硬约束（RFC6455 §5.3）。
//
// 与 `ws-frames.mjs` 的分工：那边是**线格式**（怎么把字节解成帧），这边是
// **连接生命周期**（握手、重连前的关闭、ping/pong、错误怎么交给调用方）。
// 分开之后，"帧解错了"可以在没有网络的情况下复现。
//
// ## 关闭语义
//
// 任何失败都**只**通过 `close` 事件交付（带 `code` / `reason`），不抛到调用栈上。
// 理由：这条连接会被 Hub 主动断开（协议错误、令牌撤销、版本不兼容），
// 而那些都是**预期内**的事件。把它们做成需要 try/catch 的异常，会诱使调用方
// 在 catch 里静默吞掉——包括吞掉真正该重连的那一类。
// ============================================================================
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'

import {
  WS_CLOSE,
  WS_OPCODE,
  acceptKey as computeAcceptKey,
  buildHandshakeRequest,
  constantTimeEqual,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
  encodeText,
  parseClosePayload,
  randomKey,
} from './ws-frames.mjs'

/** 连接结果的具名原因。调用方按它决定"要不要重连、隔多久重连"。 */
export const WS_CLIENT_CODES = Object.freeze({
  HANDSHAKE_REJECTED: 'WS_CLIENT_HANDSHAKE_REJECTED',
  HANDSHAKE_MALFORMED: 'WS_CLIENT_HANDSHAKE_MALFORMED',
  ACCEPT_MISMATCH: 'WS_CLIENT_ACCEPT_MISMATCH',
  SOCKET_ERROR: 'WS_CLIENT_SOCKET_ERROR',
  PROTOCOL_ERROR: 'WS_CLIENT_PROTOCOL_ERROR',
  TIMEOUT: 'WS_CLIENT_TIMEOUT',
  CLOSED: 'WS_CLIENT_CLOSED',
})

/**
 * 连一条 WebSocket。
 *
 * 返回一个 `EventEmitter`，事件：
 *   · `open`   —— 握手完成，可以 `send`
 *   · `message`(text, { opcode, payload })
 *   · `close`({ code, reason, willReconnectHint })
 *   · `error`(err) —— **仅**用于诊断（`close` 一定也会到）。不要在这里改状态。
 *
 * `headers` 用于携带 `Authorization`（设备令牌）与协商子协议。
 */
export function connectWebSocket({
  url,
  headers = {},
  protocol = null,
  timeoutMs = 15_000,
  maxMessageBytes = 1024 * 1024,
  pingIntervalMs = 0,
  random = null,
  now = Date.now,
} = {}) {
  const emitter = new EventEmitter()
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('connectWebSocket 需要 url')

  let parsed
  try { parsed = new URL(url) } catch (e) { throw new TypeError(`url 无法解析：${e.message}`) }
  const secure = parsed.protocol === 'wss:'
  if (!secure && parsed.protocol !== 'ws:') throw new TypeError(`不支持的协议 ${parsed.protocol}（只支持 ws: / wss:）`)

  const key = randomKey(random ?? undefined)
  const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  const requestText = buildHandshakeRequest({
    path: `${parsed.pathname}${parsed.search}`,
    host: hostHeader,
    key,
    protocol,
    extraHeaders: headers,
  })

  // 手写请求头而不用 `http.request` 的 headers 选项：`Connection`/`Upgrade` 是
  // Node 会「帮你规范化」的那一类，而规范化之后的取值不总是我们写下的那一个。
  // 这里要的是逐字的握手请求。
  const lines = requestText.slice(0, requestText.indexOf('\r\n\r\n')).split('\r\n')
  const requestHeaders = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    requestHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }

  const transport = secure ? https : http
  let socket = null
  let settled = false
  let closed = false
  const startedAt = now()

  const finish = (code, reason, extra = {}) => {
    if (closed) return
    closed = true
    clearTimers()
    try { socket?.destroy() } catch { /* 已断开 */ }
    emitter.emit('close', { code, reason, elapsedMs: now() - startedAt, ...extra })
  }

  const timers = new Set()
  const addTimer = (fn, ms, repeat = false) => {
    const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms)
    if (typeof t.unref === 'function') t.unref()
    timers.add(t)
    return t
  }
  const clearTimers = () => { for (const t of timers) { clearTimeout(t); clearInterval(t) } timers.clear() }

  const req = transport.request({
    host: parsed.hostname,
    port: parsed.port || (secure ? 443 : 80),
    method: 'GET',
    path: `${parsed.pathname}${parsed.search}`,
    headers: requestHeaders,
    // ★ 不跟随重定向：一次 302 到登录页如果被静默跟随，会得到一个"连上了
    //   但对面是网页"的状态，而 `Sec-WebSocket-Accept` 校验恰好能抓住它——
    //   前提是我们真的走到了那个校验。
    agent: false,
  })

  // ★ 握手超时必须在握手**成功**时取消，而不是只在收尾时。
  //
  // 只在 `finish()` 里清（原实现）会让这个定时器在连上之后继续倒计时，
  // 到点就把一条完全正常的连接关掉——症状是"每 N 秒掉线重连一次"，
  // 而两端日志都写着连接正常。默认 15s，所以只有长连接会暴露它。
  // Hub 侧的 hello 定时器有过一模一样的缺陷（见 node-gateway.mjs）。
  let handshakeTimer = addTimer(
    () => finish(WS_CLOSE.NORMAL, WS_CLIENT_CODES.TIMEOUT, { timedOut: true }), timeoutMs)
  const clearHandshakeTimer = () => {
    if (handshakeTimer === null) return
    clearTimeout(handshakeTimer)
    timers.delete(handshakeTimer)
    handshakeTimer = null
  }

  // 服务端用 HTTP 状态码拒绝握手（401/403/426/429/503）时走这里，不是 `upgrade`。
  req.on('response', (res) => {
    const chunks = []
    res.on('data', (d) => chunks.push(d))
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      emitter.emit('handshakeRejected', {
        status: res.statusCode,
        headers: res.headers,
        body: body.slice(0, 512),
      })
      finish(WS_CLOSE.POLICY_VIOLATION, WS_CLIENT_CODES.HANDSHAKE_REJECTED, { status: res.statusCode })
    })
  })

  req.on('error', (e) => {
    emitter.emit('error', e)
    // `reason` 是**具名类别**（调用方按它决定要不要重连），原始 errno 单独放
    // `errorCode`。把 errno 当 reason 会让调用方被迫枚举 `ECONNRESET`/`ETIMEDOUT`/
    // `ENOTFOUND`/`ECONNREFUSED`… 去判断"这是不是网络问题"——而那正是分类该做的事。
    finish(WS_CLOSE.PROTOCOL_ERROR, WS_CLIENT_CODES.SOCKET_ERROR, { error: e, errorCode: e?.code ?? null })
  })

  req.on('upgrade', (res, sock, head) => {
    // `upgrade` 事件不带状态行，所以按 §4.1 用「101 + 校验 accept」重建判定。
    if (res.statusCode !== 101) {
      finish(WS_CLOSE.POLICY_VIOLATION, WS_CLIENT_CODES.HANDSHAKE_REJECTED, { status: res.statusCode })
      return
    }
    const expected = computeAcceptKey(key)
    if (!constantTimeEqual(String(res.headers['sec-websocket-accept'] ?? ''), expected)) {
      // ★ 不校验 accept 的后果不是"安全性差一点"，而是**把任意 HTTP 响应当成
      //   一次成功握手**，之后每一次解析都在处理 HTML。
      emitter.emit('handshakeRejected', { status: res.statusCode, headers: res.headers, body: '', reason: 'accept-mismatch' })
      finish(WS_CLOSE.PROTOCOL_ERROR, WS_CLIENT_CODES.ACCEPT_MISMATCH)
      return
    }
    socket = sock
    settled = true
    clearHandshakeTimer()

    const decoder = createFrameDecoder({ maxBytes: maxMessageBytes, expectMasked: false })
    socket.on('data', (chunk) => {
      const { messages, error } = decoder.push(chunk)
      if (error) {
        emitter.emit('error', Object.assign(new Error(error.message), { code: error.code }))
        // 协议错误要**按协议**关闭：发一个 close 帧带上码，而不是直接 destroy。
        // 直接 destroy 会让对面只看到"连接断了"，分不清正常收尾与协议错误。
        sendClose(error.closeCode ?? WS_CLOSE.PROTOCOL_ERROR, error.code)
        finish(error.closeCode ?? WS_CLOSE.PROTOCOL_ERROR, WS_CLIENT_CODES.PROTOCOL_ERROR, { protocolCode: error.code })
        return
      }
      for (const m of messages) {
        if (m.opcode === WS_OPCODE.PING) { sendRaw(encodeFrame(WS_OPCODE.PONG, m.payload, { mask: true, random })); continue }
        if (m.opcode === WS_OPCODE.PONG) { emitter.emit('pong', { atMs: now() }); continue }
        if (m.opcode === WS_OPCODE.CLOSE) {
          const parsedClose = parseClosePayload(m.payload)
          // 对等方发起关闭：回一个 close 帧再收尾（§7.1.2）。
          sendClose(parsedClose.code ?? WS_CLOSE.NORMAL, '', { echo: true })
          finish(parsedClose.code ?? WS_CLOSE.NORMAL, WS_CLIENT_CODES.CLOSED, { remote: true, reason: parsedClose.reason })
          return
        }
        if (m.error) {
          emitter.emit('error', Object.assign(new Error(m.error.message), { code: m.error.code }))
          continue
        }
        if (m.opcode === WS_OPCODE.TEXT) emitter.emit('message', m.text, { opcode: m.opcode, payload: m.payload })
        else if (m.opcode === WS_OPCODE.BINARY) emitter.emit('binary', m.payload)
      }
    })
    socket.on('error', (e) => { emitter.emit('error', e) })
    socket.on('close', () => finish(WS_CLOSE.NORMAL, WS_CLIENT_CODES.CLOSED, { abrupt: true }))
    // 握手的响应体残留（`head`）里可能已经有帧了（服务端 101 之后立刻发 hello）。
    if (head && head.length > 0) socket.unshift(head)

    if (pingIntervalMs > 0) addTimer(() => sendRaw(encodeFrame(WS_OPCODE.PING, Buffer.alloc(0), { mask: true, random })), pingIntervalMs, true)
    emitter.emit('open', { protocol: res.headers['sec-websocket-protocol'] ?? null, headers: res.headers })
  })

  function sendRaw(buf) {
    if (closed || socket === null) return false
    try { socket.write(buf); return true } catch { return false }
  }

  function sendClose(code, reason = '', { echo = false } = {}) {
    if (socket === null) return false
    return sendRaw(encodeClose(echo ? null : code, reason, { mask: true, random }))
  }

  req.end()

  const api = {
    on: (...args) => { emitter.on(...args); return api },
    once: (...args) => { emitter.once(...args); return api },
    off: (...args) => { emitter.off(...args); return api },
    /** 发送一个文本帧。未连上或已关闭时返回 `false`（调用方据此判定"没发出去"）。 */
    send(text) {
      if (closed || socket === null) return false
      return sendRaw(encodeText(typeof text === 'string' ? text : JSON.stringify(text), { mask: true, random }))
    },
    /** 主动、**正常**地关闭（会先发 close 帧）。 */
    close(code = WS_CLOSE.NORMAL, reason = '') {
      if (closed) return
      sendClose(code, reason)
      // 给对方一点时间处理 close 帧，然后强制收尾；否则一个不回 close 的对端
      // 会让这条连接的 socket 一直挂着。
      const t = setTimeout(() => finish(code, WS_CLIENT_CODES.CLOSED, { local: true }), 250)
      if (typeof t.unref === 'function') t.unref()
    },
    get isOpen() { return socket !== null && !closed },
    get handshakeSent() { return settled },
    get socket() { return socket },
  }
  return api
}

// packages/shared/src/ws-frames.mjs
// ============================================================================
// RFC6455 帧编解码 + 握手（远程 Agent 通道 S-A）
//
// 设计依据：`docs/superpowers/specs/2026-10-02-legion-server-pc-mobile-agent-architecture.md`
// §7.2 —— Hub 与电脑 Node 之间的通道要独立于任务 RPC 的任意路径，协议帧必须自带
// 身份、版本与幂等键。本模块只负责**线格式**：握手与帧。协议语义（版本协商、
// 幂等、序号）在 `node-protocol.mjs`，两者分开，于是「帧解错了」与「帧对了但
// 语义拒了」是两条能分别复现的路径。
//
// ## 为什么要自己实现而不是引 `ws`
//
// 仓库现状：Hub 侧全部依赖是 `node:` 内建加仓库内相对模块，零第三方包；已有
// `whiteboard/apps/server/src/ws.mjs` 一份零依赖服务端实现。引入 `ws` 会把这
// 条通道变成第一个需要联网装包才能启动的部分，而它恰恰是**必须在服务器上跑
// 起来**的部分。帧编解码是有限且有明确测试的协议，适合自己实现并受测。
//
// ## 单向掩码：这不是风格问题
//
// RFC6455 §5.3 规定**客户端→服务端必须掩码，服务端→客户端禁止掩码**。已有的
// whiteboard 实现只管服务端方向（`encodeFrame` 恒发未掩码帧），所以它**不能**
// 直接拿来当客户端用：一个发未掩码帧的客户端会被合规服务端按协议错误断开，
// 而那个断开发生在握手成功之后，看起来像"连上了又掉线"。
// 因此本模块把掩码做成**显式入参**，默认值按方向给出，并在解码时可选地强制要求。
//
// ## 错误表达：返回具名结果，不抛
//
// 解码发生在 socket 的 data 事件里。抛出会把一次"收到坏帧"升级成进程级异常，
// 于是唯一的处置变成崩溃——而正确处置是**按协议关闭这一条连接**（关闭码 1002/1009），
// 其余连接不受影响。所以解码返回 `{ error: { code, message } }`。
// ============================================================================
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

/** RFC6455 §1.3 的固定 GUID。 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 协议版本（§4.2.1）。只支持 13。 */
export const WS_VERSION = '13'

export const WS_OPCODE = Object.freeze({
  CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa,
})

/** 单条消息的默认上限。与 `node-protocol.mjs` 的消息上限是两回事：这个防的是**帧层**的撑爆内存。 */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024

/** 控制帧载荷上限（§5.5）：125 字节，且不得分片。 */
export const CONTROL_FRAME_MAX_BYTES = 125

/** 关闭码（§7.4.1）。只登记本模块自己会产生的那几个。 */
export const WS_CLOSE = Object.freeze({
  NORMAL: 1000,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
})

const CONTROL_OPCODES = new Set([WS_OPCODE.CLOSE, WS_OPCODE.PING, WS_OPCODE.PONG])
const DATA_OPCODES = new Set([WS_OPCODE.TEXT, WS_OPCODE.BINARY])

/** 具名解码错误 → 应当用来关闭连接的关闭码。 */
const CLOSE_CODE_OF = Object.freeze({
  WS_RESERVED_BITS: WS_CLOSE.PROTOCOL_ERROR,
  WS_INVALID_LENGTH: WS_CLOSE.PROTOCOL_ERROR,
  WS_FRAGMENTED_CONTROL: WS_CLOSE.PROTOCOL_ERROR,
  WS_CONTROL_TOO_LONG: WS_CLOSE.PROTOCOL_ERROR,
  WS_UNEXPECTED_CONTINUATION: WS_CLOSE.PROTOCOL_ERROR,
  WS_MASK_REQUIRED: WS_CLOSE.PROTOCOL_ERROR,
  WS_MASK_FORBIDDEN: WS_CLOSE.PROTOCOL_ERROR,
  WS_UNKNOWN_OPCODE: WS_CLOSE.PROTOCOL_ERROR,
  WS_MESSAGE_TOO_BIG: WS_CLOSE.MESSAGE_TOO_BIG,
  WS_INVALID_TEXT: WS_CLOSE.INVALID_PAYLOAD,
})

const fail = (code, message) => ({ code, message, closeCode: CLOSE_CODE_OF[code] ?? WS_CLOSE.PROTOCOL_ERROR })

// ── 握手 ────────────────────────────────────────────────────────────────────

/** `Sec-WebSocket-Accept` = base64(sha1(key + GUID))。 */
export function acceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64')
}

/** 常量时间比较，用于令牌与 accept 值。长度不同直接 false（不泄露长度差异以外的信息）。 */
export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length === 0 || x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

const headerValue = (headers, name) => {
  if (headers === null || headers === undefined) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === lower) return Array.isArray(v) ? v.join(', ') : String(v ?? '')
  return ''
}

/**
 * 服务端：这个请求是不是一次合法的 WebSocket 升级。
 *
 * `sec-websocket-key` 必须是 16 字节的 base64（§4.1）——不校验长度就接受，
 * 会让 `acceptKey` 对一个任意字符串算出 accept 值，于是"握手成功"这件事
 * 不再对应任何真实的协议意图。
 *
 * 返回 `null` 或 `{ status, code, reason }`。
 */
export function validateUpgradeRequest(req) {
  const upgrade = headerValue(req?.headers, 'upgrade').trim().toLowerCase()
  if (upgrade !== 'websocket') return { status: 400, code: 'WS_UPGRADE_REQUIRED', reason: 'Upgrade: websocket 缺失' }
  const connection = headerValue(req?.headers, 'connection').toLowerCase()
  if (!connection.split(',').map(s => s.trim()).includes('upgrade')) {
    return { status: 400, code: 'WS_CONNECTION_UPGRADE_REQUIRED', reason: 'Connection: Upgrade 缺失' }
  }
  const version = headerValue(req?.headers, 'sec-websocket-version').trim()
  if (version !== WS_VERSION) {
    // §4.4：版本不符时回 `Sec-WebSocket-Version: 13`，且**不握手**。
    return { status: 426, code: 'WS_VERSION_UNSUPPORTED', reason: `只支持 Sec-WebSocket-Version: ${WS_VERSION}`, headers: { 'Sec-WebSocket-Version': WS_VERSION } }
  }
  const key = headerValue(req?.headers, 'sec-websocket-key').trim()
  let decoded = null
  try { decoded = Buffer.from(key, 'base64') } catch { decoded = null }
  if (decoded === null || decoded.length !== 16) {
    return { status: 400, code: 'WS_KEY_INVALID', reason: 'Sec-WebSocket-Key 必须是 16 字节的 base64' }
  }
  return null
}

/** 服务端：成功握手的响应头（不含终止空行的 CRLF 序列单独给出，调用方拼 socket.write）。 */
export function buildHandshakeResponse(key, { protocol = null } = {}) {
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ]
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)
  return lines.join('\r\n') + '\r\n\r\n'
}

/** 服务端：拒绝握手的响应（握手前的失败要用 HTTP 状态码说清楚，不能静默 destroy）。 */
export function buildHandshakeFailure(status, reason) {
  const text = REASON_TEXT[status] ?? 'Forbidden'
  const body = String(reason ?? text)
  return `HTTP/1.1 ${status} ${text}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + '\r\n' + body
}

const REASON_TEXT = Object.freeze({
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  409: 'Conflict', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable',
})

/**
 * 客户端：生成握手请求文本。
 *
 * `key` 必须由调用方给出（用 `randomKey()`），不在这里偷偷随机——握手 key 是
 * 一次连接的**证据**，客户端要在收到响应后拿它回验；藏在函数内部就等于把
 * 回验需要的东西丢了。
 */
export function buildHandshakeRequest({ path = '/', host, key, protocol = null, extraHeaders = {} }) {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('buildHandshakeRequest 需要 key')
  if (typeof host !== 'string' || host.length === 0) throw new TypeError('buildHandshakeRequest 需要 host')
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: ${WS_VERSION}`,
  ]
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)
  for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`)
  return lines.join('\r\n') + '\r\n\r\n'
}

/** 客户端：生成 16 字节随机 key（base64）。`random` 可注入，便于受测。 */
export function randomKey(random = defaultRandomBytes) {
  return Buffer.from(random(16)).toString('base64')
}

/**
 * 随机源。默认是 `node:crypto.randomBytes`；`setRandomBytesSource` 让**本模块
 * 自己**产生的掩码 key 也能被测试替换（`encodeFrame` 的 `maskKey` 入参只覆盖
 * 调用方显式传 key 的那条路径，覆盖不到默认路径）。
 */
let randomBytesSource = (n) => nodeRandomBytes(n)

function defaultRandomBytes(n) {
  return randomBytesSource(n)
}

/** 替换随机源（测试用）。传 `null` 恢复默认。 */
export function setRandomBytesSource(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('setRandomBytesSource 需要函数或 null')
  randomBytesSource = fn === null ? (n) => nodeRandomBytes(n) : fn
}

/**
 * 客户端：解析握手响应。
 *
 * 回验 `Sec-WebSocket-Accept` 不是可选项：不验的话，一个普通的 HTTP 404 页面
 * （内容里恰好没有换行）会被当成握手成功，之后的每一次 `push` 都在解析 HTML。
 */
export function parseHandshakeResponse(head, expectedKey) {
  const text = String(head ?? '')
  const end = text.indexOf('\r\n\r\n')
  if (end === -1) return { ok: false, code: 'WS_HANDSHAKE_INCOMPLETE', message: '响应头未接收完整' }
  const lines = text.slice(0, end).split('\r\n')
  const statusLine = lines.shift() ?? ''
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine)
  if (!m) return { ok: false, code: 'WS_HANDSHAKE_MALFORMED', message: `无法解析状态行：${statusLine}` }
  const status = Number(m[1])
  const headers = {}
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i === -1) continue
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  if (status !== 101) {
    return { ok: false, code: 'WS_HANDSHAKE_REJECTED', status, message: headers['sec-websocket-protocol'] ?? `服务端返回 ${status}`, headers }
  }
  if (String(headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    return { ok: false, code: 'WS_HANDSHAKE_MALFORMED', message: 'Upgrade 响应头不是 websocket', headers }
  }
  const accept = headers['sec-websocket-accept'] ?? ''
  if (expectedKey === undefined || expectedKey === null) {
    return { ok: false, code: 'WS_ACCEPT_UNVERIFIED', message: '调用方未提供期望的 key，无法回验 Sec-WebSocket-Accept', headers }
  }
  if (!constantTimeEqual(accept, acceptKey(expectedKey))) {
    return { ok: false, code: 'WS_ACCEPT_MISMATCH', message: 'Sec-WebSocket-Accept 与请求 key 不匹配', headers }
  }
  return { ok: true, status, protocol: headers['sec-websocket-protocol'] ?? null, headers, rest: text.slice(end + 4) }
}

// ── 帧编码 ──────────────────────────────────────────────────────────────────

/**
 * 编码一帧。
 *
 * `mask` 默认 `false`（服务端方向）。客户端**必须**传 `true`——见文件头那段
 * 「单向掩码」。`maskKey` 可注入以便受测；不传则取随机。
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true, maskKey = null, random = null } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  if (CONTROL_OPCODES.has(opcode)) {
    if (!fin) throw new TypeError('控制帧不得分片（RFC6455 §5.5）')
    if (data.length > CONTROL_FRAME_MAX_BYTES) throw new TypeError(`控制帧载荷不得超过 ${CONTROL_FRAME_MAX_BYTES} 字节`)
  }
  const len = data.length
  const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8
  const header = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0))
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  let offset = 2
  if (lenBytes === 0) header[1] = len
  else if (lenBytes === 2) { header[1] = 126; header.writeUInt16BE(len, 2); offset = 4 }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); offset = 10 }
  let body = data
  if (mask) {
    header[1] |= 0x80
    const key = maskKey === null ? Buffer.from((random ?? defaultRandomBytes)(4)) : Buffer.from(maskKey)
    if (key.length !== 4) throw new TypeError('maskKey 必须是 4 字节')
    key.copy(header, offset)
    body = Buffer.from(data)
    for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4]
  }
  return Buffer.concat([header, body])
}

/** 便捷封装：文本帧。 */
export function encodeText(text, options) {
  return encodeFrame(WS_OPCODE.TEXT, Buffer.from(String(text), 'utf8'), options)
}

/** 便捷封装：关闭帧（带 2 字节关闭码，或空载荷）。 */
export function encodeClose(code = WS_CLOSE.NORMAL, reason = '', options = {}) {
  if (code === null) return encodeFrame(WS_OPCODE.CLOSE, Buffer.alloc(0), options)
  const reasonBuf = Buffer.from(String(reason), 'utf8')
  const payload = Buffer.alloc(2 + Math.min(reasonBuf.length, CONTROL_FRAME_MAX_BYTES - 2))
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2, 0, payload.length - 2)
  return encodeFrame(WS_OPCODE.CLOSE, payload, options)
}

// ── 帧解码 ──────────────────────────────────────────────────────────────────

/**
 * 尝试从 `buf` 头部解出一帧。
 *
 * 返回：
 *   · `null`                      —— 缓冲区还不完整，调用方继续等数据
 *   · `{ error }`                 —— 协议错误，调用方应据此关闭连接
 *   · `{ fin, opcode, masked, payload, consumed }`
 *
 * `expectMasked` 三态：`true` 强制要求掩码（服务端收客户端帧）、`false` 强制
 * 禁止（客户端收服务端帧）、`null` 不检查。默认 `null`，由调用方按自己的角色给。
 */
export function parseFrame(buf, { maxBytes = DEFAULT_MAX_MESSAGE_BYTES, expectMasked = null } = {}) {
  if (!Buffer.isBuffer(buf)) return { error: fail('WS_INVALID_LENGTH', '待解数据必须是 Buffer') }
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  if ((b0 & 0x70) !== 0) return { error: fail('WS_RESERVED_BITS', 'RSV1/2/3 必须为 0（未协商任何扩展）') }
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  if (!CONTROL_OPCODES.has(opcode) && !DATA_OPCODES.has(opcode) && opcode !== WS_OPCODE.CONT) {
    return { error: fail('WS_UNKNOWN_OPCODE', `未登记的 opcode 0x${opcode.toString(16)}`) }
  }
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    // 最高位必须为 0（§5.2）。为 1 时是"用 64 位长度字段编码了一个非法值"，
    // 不是"一个很大的数"——按上限拒绝会把它和"真的超长"混成同一个读数。
    if ((big & (1n << 63n)) !== 0n) return { error: fail('WS_INVALID_LENGTH', '64 位长度字段最高位必须为 0') }
    len = Number(big)
    offset = 10
  }
  if (CONTROL_OPCODES.has(opcode)) {
    if (!fin) return { error: fail('WS_FRAGMENTED_CONTROL', '控制帧不得分片') }
    if (len > CONTROL_FRAME_MAX_BYTES) return { error: fail('WS_CONTROL_TOO_LONG', `控制帧载荷 ${len} 字节超过 ${CONTROL_FRAME_MAX_BYTES}`) }
  }
  if (len > maxBytes) return { error: fail('WS_MESSAGE_TOO_BIG', `帧载荷 ${len} 字节超过上限 ${maxBytes}`) }
  if (expectMasked === true && !masked) return { error: fail('WS_MASK_REQUIRED', '客户端帧必须掩码（RFC6455 §5.3）') }
  if (expectMasked === false && masked) return { error: fail('WS_MASK_FORBIDDEN', '服务端帧不得掩码（RFC6455 §5.3）') }
  let maskKey = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  const payload = Buffer.from(buf.subarray(offset, offset + len))
  if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
  return { fin, opcode, masked, payload, consumed: offset + len }
}

/**
 * 增量解码器：喂字节流，拿完整的**消息**（分片已重组）。
 *
 * 分片重组放在这里而不是调用方，是因为"一条消息跨了几个帧"是线格式的事实，
 * 而调用方关心的是消息。放错层会让每个调用方各自实现一遍重组，并各自漏掉
 * "控制帧可以插在分片中间"这一条——那正是 ping 在长消息传输途中出现时的情形。
 *
 * 控制帧（ping/pong/close）**不参与重组**，随数据帧一起按序返回，调用方按序处理。
 */
export function createFrameDecoder({ maxBytes = DEFAULT_MAX_MESSAGE_BYTES, expectMasked = null } = {}) {
  let buffer = Buffer.alloc(0)
  let fragmentOpcode = 0
  let fragments = []
  let fragmentBytes = 0
  let poisoned = null

  return {
    /** 当前还没被解成帧的字节数（诊断用）。 */
    get bufferedBytes() { return buffer.length },
    /** 已因协议错误而失效；此后每次 push 都返回同一个错误。 */
    get error() { return poisoned },
    /**
     * 喂入一段字节，返回 `{ messages, error }`。
     * `messages` 元素形如 `{ opcode, payload, text? }`；`text` 仅对 TEXT 消息且解码成功时存在。
     */
    push(chunk) {
      if (poisoned !== null) return { messages: [], error: poisoned }
      const messages = []
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
      for (;;) {
        const frame = parseFrame(buffer, { maxBytes, expectMasked })
        if (frame === null) break
        if (frame.error) {
          // 一旦坏帧出现，后面的字节边界已经不可信；毒化而不是继续猜。
          poisoned = frame.error
          buffer = Buffer.alloc(0)
          fragments = []
          return { messages, error: poisoned }
        }
        buffer = buffer.subarray(frame.consumed)
        if (frame.opcode === WS_OPCODE.CONT) {
          if (fragmentOpcode === 0) {
            poisoned = fail('WS_UNEXPECTED_CONTINUATION', '没有正在进行的分片消息，却收到了延续帧')
            buffer = Buffer.alloc(0)
            return { messages, error: poisoned }
          }
          fragmentBytes += frame.payload.length
          if (fragmentBytes > maxBytes) {
            poisoned = fail('WS_MESSAGE_TOO_BIG', `分片消息累计 ${fragmentBytes} 字节超过上限 ${maxBytes}`)
            buffer = Buffer.alloc(0)
            fragments = []
            return { messages, error: poisoned }
          }
          fragments.push(frame.payload)
          if (frame.fin) {
            const payload = Buffer.concat(fragments)
            messages.push(materialize(fragmentOpcode, payload))
            fragmentOpcode = 0
            fragments = []
            fragmentBytes = 0
          }
          continue
        }
        if (CONTROL_OPCODES.has(frame.opcode)) {
          // 控制帧可以插在分片序列中间，且不影响重组状态。
          messages.push(materialize(frame.opcode, frame.payload))
          continue
        }
        if (!frame.fin) {
          if (fragmentOpcode !== 0) {
            poisoned = fail('WS_UNEXPECTED_CONTINUATION', '上一条分片消息尚未结束，又收到新的数据帧')
            buffer = Buffer.alloc(0)
            fragments = []
            return { messages, error: poisoned }
          }
          fragmentOpcode = frame.opcode
          fragments = [frame.payload]
          fragmentBytes = frame.payload.length
          if (fragmentBytes > maxBytes) {
            poisoned = fail('WS_MESSAGE_TOO_BIG', `分片消息累计 ${fragmentBytes} 字节超过上限 ${maxBytes}`)
            buffer = Buffer.alloc(0)
            fragments = []
            return { messages, error: poisoned }
          }
          continue
        }
        messages.push(materialize(frame.opcode, frame.payload))
      }
      return { messages, error: null }
    },
  }
}

function materialize(opcode, payload) {
  if (opcode === WS_OPCODE.TEXT) {
    // 用 fatal 解码：非法 UTF-8 的"文本帧"按协议是 1007，而不是替换字符后照常处理。
    try {
      return { opcode, payload, text: new TextDecoder('utf-8', { fatal: true }).decode(payload) }
    } catch {
      return { opcode, payload, error: fail('WS_INVALID_TEXT', '文本帧不是合法 UTF-8') }
    }
  }
  if (opcode === WS_OPCODE.CLOSE) return { opcode, payload, close: parseClosePayload(payload) }
  return { opcode, payload }
}

/** 解析关闭帧载荷（§5.5.1）。空载荷合法（= 无关闭码）。 */
export function parseClosePayload(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  if (buf.length === 0) return { code: null, reason: '' }
  if (buf.length === 1) return { code: null, reason: '', invalid: true }
  return { code: buf.readUInt16BE(0), reason: buf.subarray(2).toString('utf8') }
}

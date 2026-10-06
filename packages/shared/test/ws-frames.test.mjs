// packages/shared/test/ws-frames.test.mjs
// 远程 Agent 通道 S-A：帧编解码与握手的契约。
//
// 这些用例守的是**线格式**的事实，不是实现细节：每条断言都能对应到 RFC6455 的
// 某一节，或者在注释里说明"这一条不满足会在真实连接上表现成什么"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTROL_FRAME_MAX_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  WS_CLOSE,
  WS_OPCODE,
  acceptKey,
  buildHandshakeFailure,
  buildHandshakeRequest,
  buildHandshakeResponse,
  constantTimeEqual,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
  encodeText,
  parseClosePayload,
  parseFrame,
  parseHandshakeResponse,
  randomKey,
  setRandomBytesSource,
  validateUpgradeRequest,
} from '../src/ws-frames.mjs'

const fixedRandom = (n) => Uint8Array.from({ length: n }, (_, i) => i + 1)

/** 服务端视角收客户端帧：要求掩码。 */
const serverDecoder = (opts = {}) => createFrameDecoder({ expectMasked: true, ...opts })
/** 客户端视角收服务端帧：要求不掩码。 */
const clientDecoder = (opts = {}) => createFrameDecoder({ expectMasked: false, ...opts })

// ── 握手 ────────────────────────────────────────────────────────────────────

test('acceptKey 按 RFC6455 §1.3 的示例取值', () => {
  // RFC 给的样例：key 为 dGhlIHNhbXBsZSBub25jZQ== 时 accept 应为 s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('validateUpgradeRequest 接受合法升级请求', () => {
  const req = { headers: {
    upgrade: 'WebSocket', connection: 'keep-alive, Upgrade',
    'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
    'sec-websocket-version': '13',
  } }
  assert.equal(validateUpgradeRequest(req), null)
})

test('validateUpgradeRequest 对每个缺失的握手条件给出各自的具名理由', () => {
  const base = {
    upgrade: 'websocket', connection: 'Upgrade',
    'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
    'sec-websocket-version': '13',
  }
  // 缺 Upgrade / 缺 Connection: Upgrade / 版本不是 13 / key 不是 16 字节 —— 四种分开断言。
  // 合成一个"非法请求"断言会让"哪一条不满足"在排障时不可知。
  assert.equal(validateUpgradeRequest({ headers: { ...base, upgrade: '' } }).code, 'WS_UPGRADE_REQUIRED')
  assert.equal(validateUpgradeRequest({ headers: { ...base, connection: 'keep-alive' } }).code, 'WS_CONNECTION_UPGRADE_REQUIRED')
  const wrongVersion = validateUpgradeRequest({ headers: { ...base, 'sec-websocket-version': '8' } })
  assert.equal(wrongVersion.code, 'WS_VERSION_UNSUPPORTED')
  // §4.4：版本不符要回 426 且带上自己支持的版本，否则客户端不知道往哪降。
  assert.equal(wrongVersion.status, 426)
  assert.equal(wrongVersion.headers['Sec-WebSocket-Version'], '13')
  assert.equal(validateUpgradeRequest({ headers: { ...base, 'sec-websocket-key': 'short' } }).code, 'WS_KEY_INVALID')
})

test('握手往返：服务端响应能被客户端用同一 key 验签通过', () => {
  const key = randomKey(fixedRandom)
  const response = buildHandshakeResponse(key)
  const parsed = parseHandshakeResponse(response, key)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.status, 101)
  assert.equal(parsed.rest, '')
})

test('parseHandshakeResponse 拒绝非 101 与不匹配的 accept', () => {
  const key = randomKey(fixedRandom)
  const other = randomKey(() => new Uint8Array(16).fill(9))
  const rejected = parseHandshakeResponse('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n', key)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'WS_HANDSHAKE_REJECTED')
  // ★ 这一条是"为什么必须回验 accept"的用例：一个内容合法的 101，但 accept 是
  //   另一把 key 算出来的 —— 那意味着对面并不是在响应我们这次握手。
  const mismatch = parseHandshakeResponse(buildHandshakeResponse(other), key)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'WS_ACCEPT_MISMATCH')
  // 未提供期望 key 时不得静默放行。
  assert.equal(parseHandshakeResponse(buildHandshakeResponse(key), null).code, 'WS_ACCEPT_UNVERIFIED')
})

test('parseHandshakeResponse 对不完整响应返回 incomplete 而不是当成空响应', () => {
  const r = parseHandshakeResponse('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WS_HANDSHAKE_INCOMPLETE')
})

test('buildHandshakeRequest 带上必需头，并在给了子协议时带上子协议', () => {
  const text = buildHandshakeRequest({ path: '/node', host: 'hub.example:443', key: 'K', protocol: 'legion-node-v1' })
  for (const line of ['GET /node HTTP/1.1', 'Host: hub.example:443', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: K', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: legion-node-v1']) {
    assert.ok(text.includes(line), `握手请求缺少：${line}`)
  }
  assert.ok(text.endsWith('\r\n\r\n'))
})

test('buildHandshakeFailure 带上 Content-Length，避免客户端读到挂起', () => {
  const text = buildHandshakeFailure(401, '设备令牌无效')
  assert.ok(text.startsWith('HTTP/1.1 401 Unauthorized\r\n'))
  assert.ok(text.includes(`Content-Length: ${Buffer.byteLength('设备令牌无效')}\r\n`))
  assert.ok(text.endsWith('\r\n\r\n设备令牌无效'))
})

test('constantTimeEqual 对长度不同与空串都返回 false', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('abc', 'abd'), false)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
  assert.equal(constantTimeEqual('', ''), false)
})

// ── 编码 / 解码往返 ─────────────────────────────────────────────────────────

test('文本帧以三种长度编码都能原样解回', () => {
  const samples = [
    'short',                                  // <126：1 字节长度
    'x'.repeat(200),                          // <65536：2 字节长度
    'y'.repeat(70000),                        // 更大：8 字节长度
  ]
  for (const s of samples) {
    const frame = encodeFrame(WS_OPCODE.TEXT, Buffer.from(s), { mask: true, maskKey: Buffer.from([1, 2, 3, 4]), fin: true })
    const decoded = parseFrame(frame, { expectMasked: true })
    assert.equal(decoded.error, undefined)
    assert.equal(decoded.opcode, WS_OPCODE.TEXT)
    assert.equal(decoded.payload.toString('utf8'), s)
    assert.equal(decoded.consumed, frame.length)
  }
})

test('掩码是双向的：客户端帧必须掩码，服务端帧必须不掩码', () => {
  const masked = encodeFrame(WS_OPCODE.TEXT, 'hi', { mask: true, maskKey: Buffer.from([9, 9, 9, 9]) })
  const plain = encodeFrame(WS_OPCODE.TEXT, 'hi', { mask: false })
  // 服务端收到未掩码的客户端帧 → 协议错误（这正是"客户端发未掩码帧会被断开"那一节）。
  assert.equal(parseFrame(plain, { expectMasked: true }).error.code, 'WS_MASK_REQUIRED')
  // 客户端收到掩码的服务端帧 → 同样非法。
  assert.equal(parseFrame(masked, { expectMasked: false }).error.code, 'WS_MASK_FORBIDDEN')
  // expectMasked: null 时不检查（用于测试与自检工具）。
  assert.equal(parseFrame(masked).error, undefined)
  assert.equal(parseFrame(plain).error, undefined)
})

test('掩码后的载荷确实与原文不同（防止"忘了 XOR"被往返用例掩盖）', () => {
  const payload = Buffer.from('abcdefgh')
  const frame = encodeFrame(WS_OPCODE.TEXT, payload, { mask: true, maskKey: Buffer.from([0xff, 0xff, 0xff, 0xff]) })
  // 帧头 2 字节 + 掩码 key 4 字节之后就是载荷。
  assert.notDeepEqual(frame.subarray(6), payload)
})

test('解析不完整缓冲返回 null，不抛错、不当作空帧', () => {
  const frame = encodeText('hello', { mask: true, maskKey: Buffer.from([1, 2, 3, 4]) })
  for (let cut = 1; cut < frame.length; cut += 1) {
    assert.equal(parseFrame(frame.subarray(0, cut), { expectMasked: true }), null, `截断到 ${cut} 字节时应返回 null`)
  }
})

test('坏帧按各自的具名错误拒绝，并给出对应的关闭码', () => {
  // RSV 位被置
  const rsv = Buffer.from([0xa1, 0x00])
  assert.equal(parseFrame(rsv).error.code, 'WS_RESERVED_BITS')
  assert.equal(parseFrame(rsv).error.closeCode, WS_CLOSE.PROTOCOL_ERROR)
  // 未登记的 opcode（0x3 是保留的）
  assert.equal(parseFrame(Buffer.from([0x83, 0x00])).error.code, 'WS_UNKNOWN_OPCODE')
  // 64 位长度字段最高位为 1：这是非法值，不是"一个很大的数"
  const highBit = Buffer.from([0x82, 0x7f, 0x80, 0, 0, 0, 0, 0, 0, 1])
  assert.equal(parseFrame(highBit).error.code, 'WS_INVALID_LENGTH')
})

test('控制帧的分片与超长按协议拒绝', () => {
  // ping 且 fin=0
  assert.equal(parseFrame(Buffer.from([0x09, 0x00])).error.code, 'WS_FRAGMENTED_CONTROL')
  // ping 载荷 126 字节
  const long = Buffer.alloc(4 + 126)
  long[0] = 0x89; long[1] = 126; long.writeUInt16BE(126, 2)
  const err = parseFrame(long).error
  assert.equal(err.code, 'WS_CONTROL_TOO_LONG')
  assert.equal(CONTROL_FRAME_MAX_BYTES, 125)
  // 合法上限内的 ping 正常解出
  const okPing = encodeFrame(WS_OPCODE.PING, Buffer.alloc(125))
  assert.equal(parseFrame(okPing).payload.length, 125)
})

test('超过 maxBytes 的帧被拒（帧层的内存保护）', () => {
  const big = encodeText('z'.repeat(2000), { mask: true, maskKey: Buffer.from([1, 2, 3, 4]) })
  const err = parseFrame(big, { expectMasked: true, maxBytes: 1000 }).error
  assert.equal(err.code, 'WS_MESSAGE_TOO_BIG')
  assert.equal(err.closeCode, WS_CLOSE.MESSAGE_TOO_BIG)
  assert.equal(DEFAULT_MAX_MESSAGE_BYTES, 1024 * 1024)
})

// ── 增量解码器 ──────────────────────────────────────────────────────────────

test('解码器按字节喂入也能拼出完整消息', () => {
  const decoder = serverDecoder()
  const frame = encodeText('分片喂入', { mask: true, maskKey: Buffer.from([5, 6, 7, 8]) })
  const seen = []
  for (const byte of frame) {
    const { messages, error } = decoder.push(Buffer.from([byte]))
    assert.equal(error, null)
    seen.push(...messages)
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, '分片喂入')
})

test('解码器重组分片消息，且允许控制帧插在分片中间', () => {
  const decoder = serverDecoder()
  const mask = { mask: true, maskKey: Buffer.from([1, 1, 1, 1]) }
  const head = encodeFrame(WS_OPCODE.TEXT, 'AB', { ...mask, fin: false })
  const ping = encodeFrame(WS_OPCODE.PING, 'p', mask)
  const tail = encodeFrame(WS_OPCODE.CONT, 'CD', { ...mask, fin: true })
  const { messages, error } = decoder.push(Buffer.concat([head, ping, tail]))
  assert.equal(error, null)
  // ★ 顺序即事实：ping 在两条数据分片之间被解出，而不是被并进消息内容。
  assert.deepEqual(messages.map(m => m.opcode), [WS_OPCODE.PING, WS_OPCODE.TEXT])
  assert.equal(messages[1].text, 'ABCD')
})

test('没有起始数据帧的延续帧被拒', () => {
  const decoder = serverDecoder()
  const cont = encodeFrame(WS_OPCODE.CONT, 'x', { mask: true, maskKey: Buffer.from([1, 1, 1, 1]), fin: true })
  assert.equal(decoder.push(cont).error.code, 'WS_UNEXPECTED_CONTINUATION')
})

test('分片累计超过上限时被拒（单帧不超但总量超）', () => {
  const decoder = serverDecoder({ maxBytes: 100 })
  const mask = { mask: true, maskKey: Buffer.from([1, 1, 1, 1]) }
  const first = encodeFrame(WS_OPCODE.TEXT, 'a'.repeat(60), { ...mask, fin: false })
  assert.equal(decoder.push(first).error, null)
  const second = encodeFrame(WS_OPCODE.CONT, 'b'.repeat(60), { ...mask, fin: true })
  assert.equal(decoder.push(second).error.code, 'WS_MESSAGE_TOO_BIG')
})

test('解码器一旦遇到坏帧就毒化，不再继续猜字节边界', () => {
  const decoder = serverDecoder()
  const bad = Buffer.from([0xa1, 0x00])              // RSV 位被置
  const good = encodeText('after', { mask: true, maskKey: Buffer.from([1, 2, 3, 4]) })
  const first = decoder.push(Buffer.concat([bad, good]))
  assert.equal(first.error.code, 'WS_RESERVED_BITS')
  // 毒化之后即使喂入合法帧也只返回同一个错误 —— 继续解析等于按错误偏移切字节。
  assert.equal(decoder.error.code, 'WS_RESERVED_BITS')
  const second = decoder.push(good)
  assert.equal(second.error.code, 'WS_RESERVED_BITS')
  assert.deepEqual(second.messages, [])
})

test('非法 UTF-8 的文本帧按 1007 处理，而不是替换字符后照常收下', () => {
  const decoder = serverDecoder()
  const frame = encodeFrame(WS_OPCODE.TEXT, Buffer.from([0xff, 0xfe]), { mask: true, maskKey: Buffer.from([1, 2, 3, 4]) })
  const { messages } = decoder.push(frame)
  assert.equal(messages[0].error.code, 'WS_INVALID_TEXT')
  assert.equal(messages[0].error.closeCode, WS_CLOSE.INVALID_PAYLOAD)
})

test('二进制帧不带 text 字段，按二进制交付', () => {
  const decoder = serverDecoder()
  const frame = encodeFrame(WS_OPCODE.BINARY, Buffer.from([0, 1, 2]), { mask: true, maskKey: Buffer.from([3, 3, 3, 3]) })
  const { messages } = decoder.push(frame)
  assert.deepEqual([...messages[0].payload], [0, 1, 2])
  assert.equal(messages[0].text, undefined)
})

// ── 关闭帧 ──────────────────────────────────────────────────────────────────

test('关闭帧往返：带码与理由、空载荷两种都合法', () => {
  const withCode = encodeClose(WS_CLOSE.POLICY_VIOLATION, '令牌已撤销', { mask: true, maskKey: Buffer.from([1, 2, 3, 4]) })
  const parsed = parseFrame(withCode, { expectMasked: true })
  const close = parseClosePayload(parsed.payload)
  assert.equal(close.code, WS_CLOSE.POLICY_VIOLATION)
  assert.equal(close.reason, '令牌已撤销')

  const empty = encodeClose(null)
  assert.equal(parseClosePayload(parseFrame(empty).payload).code, null)
  // 1 字节载荷是协议禁止的（§5.5.1），标成 invalid 而不是当成"没有码"。
  assert.equal(parseClosePayload(Buffer.from([1])).invalid, true)
})

test('encodeFrame 拒绝不符合协议的控制帧（在编码侧就拦住）', () => {
  assert.throws(() => encodeFrame(WS_OPCODE.PING, Buffer.alloc(0), { fin: false }), /控制帧不得分片/)
  assert.throws(() => encodeFrame(WS_OPCODE.PING, Buffer.alloc(126)), /不得超过 125/)
})

test('randomKey 使用注入的随机源（受测可控）', () => {
  assert.equal(randomKey(() => new Uint8Array(16).fill(0)), Buffer.alloc(16).toString('base64'))
})

test('setRandomBytesSource 影响默认路径的掩码 key', () => {
  setRandomBytesSource(() => Uint8Array.from([7, 7, 7, 7]))
  try {
    const a = encodeFrame(WS_OPCODE.TEXT, 'same', { mask: true })
    const b = encodeFrame(WS_OPCODE.TEXT, 'same', { mask: true })
    // 默认路径同源 → 同掩码 → 逐字节相同；这证明注入确实生效（随机源默认不会这样）。
    assert.deepEqual(a, b)
  } finally {
    setRandomBytesSource(null)
  }
})

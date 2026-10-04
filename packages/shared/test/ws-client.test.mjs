// packages/shared/test/ws-client.test.mjs
// 远程 Agent 通道 S-A：WebSocket 客户端的**独有**路径。
//
// 网关那组用例走的是真实连接，已经覆盖了"连上之后怎么收发"。这里只覆盖网关
// 那组**碰不到**的失败路径——它们全都发生在握手完成之前，或者需要一个
// 故意做错事的服务端（错 accept、只发掩码帧、不回 close）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'

import { WS_CLOSE, WS_OPCODE, acceptKey, createFrameDecoder, encodeFrame, encodeText, parseClosePayload } from '../src/ws-frames.mjs'
import { WS_CLIENT_CODES, connectWebSocket } from '../src/ws-client.mjs'

/**
 * 一个**故意能做错事**的极简服务端：拿到握手请求后按 `respond` 决定怎么回。
 * 之后按 `onFrameText` 决定是否回帧。
 */
async function rawServer(respond, { onOpen = null } = {}) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buf = Buffer.alloc(0)
    let upgraded = false
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (upgraded) return
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buf.subarray(0, end).toString('utf8')
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? ''
      buf = buf.subarray(end + 4)
      upgraded = true
      const reply = respond({ head, key })
      if (reply === null) { socket.destroy(); return }
      socket.write(reply)
      onOpen?.(socket, key)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    close: () => { for (const s of sockets) s.destroy(); server.close() },
  }
}

const okReply = ({ key }) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`

test('服务端用 HTTP 状态码拒绝时，客户端报 handshakeRejected 而不是当成连上', async () => {
  const server = await rawServer(() => 'HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\n\r\nDENIED')
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 2000 })
    ws.on('error', () => {})
    let rejected = null
    ws.on('handshakeRejected', (r) => { rejected = r })
    const info = await new Promise((r) => ws.on('close', r))
    assert.equal(info.reason, WS_CLIENT_CODES.HANDSHAKE_REJECTED)
    assert.equal(rejected.status, 403)
    assert.equal(rejected.body, 'DENIED')
  } finally { server.close() }
})

test('Sec-WebSocket-Accept 不匹配时**绝不**当成握手成功', async () => {
  // ★ 这是最重要的一条：不校验 accept 的实现会把任意 101 当成成功握手，
  //   之后每一次解析都在处理对面的 HTML（或者更糟，在处理别人的响应）。
  const server = await rawServer(() => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n`)
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 2000 })
    ws.on('error', () => {})
    let opened = false
    ws.on('open', () => { opened = true })
    const info = await new Promise((r) => ws.on('close', r))
    assert.equal(opened, false)
    assert.equal(info.reason, WS_CLIENT_CODES.ACCEPT_MISMATCH)
  } finally { server.close() }
})

test('连接超时被报成 TIMEOUT（而不是永远挂着）', async () => {
  // 一个接受连接但什么都不回的服务端（**不**关闭连接：关闭会先触发 socket error，
  // 那测的就是另一条路径了）。
  const server = await rawServer(() => '')
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 120 })
    ws.on('error', () => {})
    const info = await new Promise((r) => ws.on('close', r))
    assert.equal(info.reason, WS_CLIENT_CODES.TIMEOUT)
    assert.equal(info.timedOut, true)
  } finally { server.close() }
})

test('对端发掩码帧时客户端按协议错误关闭（服务端帧不得掩码）', async () => {
  const server = await rawServer(okReply, {
    onOpen: (socket) => {
      // 故意发一个**掩码**帧——服务端方向不该有掩码。
      socket.write(encodeText('bad', { mask: true, maskKey: Buffer.from([1, 2, 3, 4]) }))
    },
  })
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 2000 })
    ws.on('error', () => {})
    const info = await new Promise((r) => ws.on('close', r))
    assert.equal(info.reason, WS_CLIENT_CODES.PROTOCOL_ERROR)
    assert.equal(info.protocolCode, 'WS_MASK_FORBIDDEN')
  } finally { server.close() }
})

test('客户端发出的帧**必须**带掩码（否则合规服务端会断开）', async () => {
  const received = []
  const server = await rawServer(okReply, {
    onOpen: (socket) => {
      socket.on('data', (chunk) => received.push(chunk))
    },
  })
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 2000 })
    ws.on('error', () => {})
    await new Promise((r) => ws.on('open', r))
    ws.send('hello')
    await new Promise((r) => setTimeout(r, 80))
    const frame = Buffer.concat(received)
    assert.ok(frame.length > 6)
    // 第二字节的最高位 = MASK 位。
    assert.equal((frame[1] & 0x80) !== 0, true, '客户端帧必须置掩码位')
  } finally { server.close() }
})

test('自动回 pong，且对端 close 会被回报（不静默丢弃）', async () => {
  const decoder = createFrameDecoder({ expectMasked: true })
  const fromClient = []
  const server = await rawServer(okReply, {
    onOpen: (socket) => {
      socket.on('data', (chunk) => { for (const m of decoder.push(chunk).messages) fromClient.push(m) })
      // 先 ping，再 close。
      socket.write(encodeFrame(WS_OPCODE.PING, Buffer.from('p'), { mask: false }))
      setTimeout(() => socket.write(encodeFrame(WS_OPCODE.CLOSE, Buffer.from([0x03, 0xe8]), { mask: false })), 40)
    },
  })
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 2000 })
    ws.on('error', () => {})
    const info = await new Promise((r) => ws.on('close', r))
    assert.equal(info.remote, true)
    assert.equal(info.code, WS_CLOSE.NORMAL)
    // 客户端对 ping 的回帧是 PONG（按帧解析，而不是在字节流里搜一个可能是载荷的值）。
    assert.deepEqual(fromClient.map((m) => m.opcode), [WS_OPCODE.PONG])
    assert.equal(fromClient[0].payload.toString('utf8'), 'p')
  } finally { server.close() }
})

test('未连上或已关闭时 send 返回 false（调用方据此判定没发出去）', async () => {
  const server = await rawServer(okReply)
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${server.port}/node`, timeoutMs: 2000 })
    ws.on('error', () => {})
    // 握手还没完成。
    assert.equal(ws.send('too-early'), false)
    await new Promise((r) => ws.on('open', r))
    assert.equal(ws.send('ok'), true)
    ws.close()
    await new Promise((r) => ws.on('close', r))
    assert.equal(ws.send('after-close'), false)
    assert.equal(ws.isOpen, false)
  } finally { server.close() }
})

test('close 帧载荷解析：带码与空载荷都能读', () => {
  assert.deepEqual(parseClosePayload(Buffer.from([0x03, 0xe8])), { code: 1000, reason: '' })
  assert.deepEqual(parseClosePayload(Buffer.alloc(0)), { code: null, reason: '' })
})

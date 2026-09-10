// ws.mjs — 零依赖 RFC6455 WebSocket 服务端（S3 / 单进程 Node/ws 的等价实现）。
// 覆盖：HTTP Upgrade 握手、文本/二进制帧、分片、ping/pong、close。客户端帧按需解掩码。

import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const WS_OPCODE = { CONT: OP_CONT, TEXT: OP_TEXT, BINARY: OP_BINARY, CLOSE: OP_CLOSE, PING: OP_PING, PONG: OP_PONG };

export function authorizedUpgrade(req, token = '') {
  if (!token) return true;
  const url = new URL(req.url || '/', 'http://localhost');
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 计算 Sec-WebSocket-Accept */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** 编码一帧（FIN=1，unmasked，服务端→客户端） */
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * 解析缓冲区中的首帧。返回 { fin, opcode, masked, payload, consumed }；
 * 缓冲区不完整返回 null；超过 maxLen 返回 { error }。
 */
export function parseFrame(buf, maxLen = 1024 * 1024) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(maxLen)) return { error: 'payload too large' };
    len = Number(big);
    offset = 10;
  }
  if (len > maxLen) return { error: 'payload too large' };
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.slice(offset, offset + len));
  if (masked) {
    for (let i = 0; i < len; i++) payload[i] = payload[i] ^ maskKey[i % 4];
  }
  return { fin, opcode, masked, payload, consumed: offset + len };
}

/** 单条连接：收发帧、分片重组、ping/pong/close */
export class WsConnection extends EventEmitter {
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.maxLen = opts.maxLen ?? 1024 * 1024;
    this.buffer = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragments = [];
    this.closed = false;
    this._closeEmitted = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._terminate());
    socket.on('close', () => this._terminate());
  }

  send(text) {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(OP_TEXT, text)); } catch { /* ignore */ }
  }

  sendBinary(buf) {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(OP_BINARY, buf)); } catch { /* ignore */ }
  }

  ping() {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0))); } catch { /* ignore */ }
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try { this.socket.write(encodeFrame(OP_CLOSE, payload)); } catch { /* ignore */ }
    try { this.socket.end(); } catch { /* ignore */ }
    this._terminate();
  }

  _terminate() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = parseFrame(this.buffer, this.maxLen);
      if (!frame) break;
      if (frame.error) { this.close(1009); return; }
      this.buffer = this.buffer.slice(frame.consumed);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    if (opcode === OP_PING) { try { this.socket.write(encodeFrame(OP_PONG, payload)); } catch { /* ignore */ } return; }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) { this.close(); return; }
    if (opcode === OP_CONT) {
      this.fragments.push(payload);
      if (fin) {
        const data = Buffer.concat(this.fragments);
        const op = this.fragOpcode;
        this.fragments = [];
        this.fragOpcode = 0;
        if (op === OP_TEXT) this.emit('message', data.toString('utf8'));
        else if (op === OP_BINARY) this.emit('binary', data);
      }
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (fin) {
        if (opcode === OP_TEXT) this.emit('message', payload.toString('utf8'));
        else this.emit('binary', payload);
      } else {
        this.fragOpcode = opcode;
        this.fragments = [payload];
      }
      return;
    }
    // 未知 opcode 忽略
  }
}

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

/**
 * 挂在 http.Server 上，把 /ws 升级请求转为 WsConnection。
 * P3-1：新增 `gate(req)` 钩子——在握手**之前**做房间解析、鉴权与连接数准入；
 *   返回 { ok:false, status, reason } 时以该状态码拒绝（503=连接数超限、401=未授权、400=房间 ID 非法），
 *   请求被拒不会建立 ws 连接；成功时返回的 { ok:true, roomId, role, ip } 挂到 `conn.gate` 供上层使用。
 * 未提供 gate 时行为与 P0 完全一致（仅按 token 判权，`authorizedUpgrade` 语义不变）。
 */
export class WebSocketServer extends EventEmitter {
  constructor({ server, path = '/ws', maxLen, token = '', gate = null } = {}) {
    super();
    this.clients = new Set();
    server.on('upgrade', (req, socket) => {
      const url = (req.url || '').split('?')[0];
      if (url !== path) { socket.destroy(); return; }
      let accepted = null;
      if (gate) {
        let verdict;
        try { verdict = gate(req); } catch { verdict = { ok: false, status: 400, reason: 'gate_error' }; }
        if (!verdict || verdict.ok !== true) {
          const status = verdict?.status ?? 401;
          const text = STATUS_TEXT[status] ?? 'Forbidden';
          try {
            socket.write(
              `HTTP/1.1 ${status} ${text}\r\n` +
              'Connection: close\r\n' +
              'Content-Type: text/plain; charset=utf-8\r\n' +
              `\r\n${verdict?.reason ?? 'denied'}\n`
            );
          } catch { /* ignore */ }
          socket.destroy();
          return;
        }
        accepted = verdict;
      } else if (!authorizedUpgrade(req, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy(); return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      const accept = acceptKey(key);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
      );
      const conn = new WsConnection(socket, { maxLen });
      if (accepted) conn.gate = accepted;
      this.clients.add(conn);
      conn.on('close', () => this.clients.delete(conn));
      this.emit('connection', conn, req);
    });
  }

  /** 按房间广播（P3-1）：只发给同房间连接，可选排除一个连接。 */
  broadcastToRoom(roomId, text, except = null) {
    for (const c of this.clients) {
      if (c === except) continue;
      if (c.gate?.roomId !== roomId) continue;
      c.send(text);
    }
  }

  /** 某房间的在线连接数 */
  countRoom(roomId) {
    let n = 0;
    for (const c of this.clients) if (c.gate?.roomId === roomId) n += 1;
    return n;
  }

  broadcast(text) {
    for (const c of this.clients) c.send(text);
  }

  close() {
    for (const c of [...this.clients]) c.close();
    this.clients.clear();
  }
}

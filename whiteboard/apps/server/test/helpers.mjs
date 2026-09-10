// helpers.mjs — P3-1 测试共用夹具：真起服务进程 + ws 客户端包装 + 原始 Upgrade 探测。
// 注意：本文件不是测试文件（不出现在 package.json 的 test 清单里），仅供 *.test.mjs 引入。

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(__dirname, '..', 'src', 'index.js');

/** 起一个真实服务进程（内存房间，随机端口），返回 { port, child, stop } */
export async function startServer(env = {}, { waitMs = 8000 } = {}) {
  const port = 19000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: ':memory:',
      WB_IN_MEMORY: '1',
      TTL_MS: '3000',
      WB_AUDIT_DIR: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) break;
    } catch { /* retry */ }
    if (Date.now() - t0 > waitMs) {
      child.kill('SIGKILL');
      throw new Error('server start timeout: ' + log.join(''));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    port,
    child,
    log,
    async stop() {
      if (!child.killed) child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 30));
    },
  };
}

/**
 * 连接 ws 并**等到 welcome**；记录所有收到的消息与关闭码。
 * 等 welcome 而非仅等 onopen：welcome 是「房间已打开、可以画了」的唯一信号，
 * 只等 onopen 会让测试与尚未完成房间初始化的服务端竞态（曾导致 welcome 读成 null）。
 * @returns {Promise<{ws, welcome, inbox, errors, sends, closeCode, send, close, waitFor}>}
 */
export function connect(port, { room = null, token = null, timeout = 3000 } = {}) {
  const qs = [];
  if (room !== null) qs.push(`room=${encodeURIComponent(room)}`);
  if (token !== null) qs.push(`token=${encodeURIComponent(token)}`);
  const url = `ws://127.0.0.1:${port}/ws${qs.length ? '?' + qs.join('&') : ''}`;
  const state = { ws: new WebSocket(url), welcome: null, inbox: [], errors: [], sends: 0, closeCode: null, closeReason: '' };
  const ws = state.ws;
  state.send = (obj) => { state.sends += 1; ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  state.close = () => { try { ws.close(); } catch { /* ignore */ } };
  state.waitFor = async (pred, ms = timeout) => {
    const t0 = Date.now();
    for (;;) {
      const v = pred(state);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout; inbox=' + JSON.stringify(state.inbox.slice(-5)));
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), timeout);
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'welcome') {
        state.welcome = m;
        clearTimeout(timer);
        resolve(state);
        return;
      }
      state.inbox.push(m);
    };
    ws.onclose = (e) => {
      state.closeCode = e.code;
      state.closeReason = e.reason || '';
      // 未拿到 welcome 就被关闭（鉴权/限流/房间不可用）：立即失败，避免测试干等到超时
      if (!state.welcome) {
        clearTimeout(timer);
        reject(new Error(`ws closed before welcome (code=${e.code} reason=${e.reason || ''})`));
      }
    };
    ws.onerror = () => { /* onclose 会跟上 */ };
  });
}

/** 等待连接关闭，返回关闭码 */
export async function waitClose(state, ms = 3000) {
  await state.waitFor((s) => s.closeCode !== null, ms);
  return state.closeCode;
}

/**
 * 原始 HTTP Upgrade 探测：用来断言握手**之前**被拒绝的状态码
 * （浏览器/undici 的 WebSocket 不暴露失败响应的状态码）。
 */
export function rawUpgrade(port, requestPath, { headers = {}, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: '' }); });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => { body += String(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

export async function json(port, requestPath) {
  const r = await fetch(`http://127.0.0.1:${port}${requestPath}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}

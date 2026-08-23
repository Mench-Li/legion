// e2e.test.mjs — 端到端冒烟：起真实服务，多个 WebSocket 客户端同步收敛 + healthz + 加入态恢复。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDoc,
  applyOp,
  applyOps,
  docState,
  stateHash,
  makeAdd,
  sampleElement,
  deserializeDoc,
} from '../../../packages/shared/src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/index.js');

const PORT = 18000 + Math.floor(Math.random() * 1000);

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const state = { ws, inbox: [], welcome: null };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'welcome') state.welcome = m;
      else state.inbox.push(m);
    };
    ws.onopen = () => resolve(state);
    ws.onerror = (e) => reject(new Error('ws connect error'));
  });
}

async function waitFor(pred, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timeout');
}

async function waitHealthz(port, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return r; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('healthz timeout');
}

describe('端到端（真实 ws 服务）', () => {
  let child;
  before(async () => {
    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: ':memory:', TTL_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealthz(PORT);
  });

  after(() => {
    if (child) child.kill('SIGKILL');
  });

  it('/healthz 返回 200 且含 ok', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
  });

  it('两个客户端同步收敛：A 画 → B 可见（TC-S3-01）', async () => {
    const A = await connect(PORT);
    const B = await connect(PORT);
    await waitFor(() => A.welcome && B.welcome);

    const docA = createDoc();
    const docB = createDoc();

    const els = ['x1', 'x2', 'x3'].map((id) => sampleElement('rect', { id, geom: { x: 0, y: 0, w: 40, h: 40 } }));
    for (const el of els) {
      const op = makeAdd(docA, el, A.welcome.clientId);
      applyOp(docA, op);
      A.ws.send(JSON.stringify({ type: 'op', ops: [op] }));
    }

    await waitFor(() => B.inbox.filter((m) => m.type === 'op').length >= 3);
    for (const m of B.inbox) {
      if (m.type === 'op') applyOps(docB, m.ops);
    }

    assert.equal(docState(docB).length, 3);
    assert.equal(stateHash(docState(docA)), stateHash(docState(docB)));
    A.ws.close();
    B.ws.close();
  });

  it('新客户端加入 → welcome.doc 含完整状态（TC-S10-01 刷新恢复）', async () => {
    const stamp = Date.now().toString(36);
    const A = await connect(PORT);
    await waitFor(() => A.welcome);
    const docA = createDoc();
    const ids = [`w${stamp}-1`, `w${stamp}-2`];
    for (const id of ids) {
      const op = makeAdd(docA, sampleElement('rect', { id, geom: { x: 0, y: 0, w: 30, h: 30 } }), A.welcome.clientId);
      applyOp(docA, op);
      A.ws.send(JSON.stringify({ type: 'op', ops: [op] }));
    }
    await new Promise((r) => setTimeout(r, 300)); // 等服务端应用

    const C = await connect(PORT);
    await waitFor(() => C.welcome);
    const docC = deserializeDoc(C.welcome.doc);
    const idsC = docState(docC).map((e) => e.id);
    assert.ok(ids.every((id) => idsC.includes(id)), `welcome.doc 应含 ${ids}，实际 ${idsC.join(',')}`);
    A.ws.close();
    C.ws.close();
  });

  it('presence：A 更新光标 → B 互见（TC-S4-01）', async () => {
    const A = await connect(PORT);
    const B = await connect(PORT);
    await waitFor(() => A.welcome && B.welcome);

    A.ws.send(JSON.stringify({ type: 'presence', state: { name: 'alice', color: '#ff0000', x: 12, y: 34 } }));
    const msg = await waitFor(() => B.inbox.find((m) => m.type === 'presence'));
    assert.equal(msg.from, A.welcome.clientId);
    assert.equal(msg.state.name, 'alice');
    assert.equal(msg.state.x, 12);
    A.ws.close();
    B.ws.close();
  });

  it('presence 正常断开 → 他人立即收到 leave（TC-S4-04）', async () => {
    const A = await connect(PORT);
    const B = await connect(PORT);
    await waitFor(() => A.welcome && B.welcome);
    A.ws.send(JSON.stringify({ type: 'presence', state: { name: 'alice', color: '#000', x: 0, y: 0 } }));
    await waitFor(() => B.inbox.some((m) => m.type === 'presence'));
    A.ws.close();
    const leave = await waitFor(() => B.inbox.find((m) => m.type === 'leave'));
    assert.equal(leave.clientId, A.welcome.clientId);
    B.ws.close();
  });

  it('畸形消息不崩溃（TC-S3-05）', async () => {
    const A = await connect(PORT);
    await waitFor(() => A.welcome);
    A.ws.send('not-json');
    A.ws.send(JSON.stringify({ type: 'op', ops: [{ t: 'bogus' }] }));
    A.ws.send(JSON.stringify({ type: 'op', ops: [null] }));
    await new Promise((r) => setTimeout(r, 150));
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(r.status, 200);
    A.ws.close();
  });
});

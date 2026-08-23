// bench.mjs — 并发/收敛压测冒烟（S12 / §6.2）。
// 起真实服务，N 个 ws 客户端互发 add op，测量 op→远端可见延迟 P95 与全副本收敛耗时。
// 用法：node scripts/bench/bench.mjs [clients] [opsPerClient]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDoc, applyOps, docState, stateHash, sampleElement,
} from '../../packages/shared/src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', '..', 'apps', 'server', 'src', 'index.js');

const N = Number(process.argv[2] || process.env.BENCH_CLIENTS || 20);
const M = Number(process.argv[3] || process.env.BENCH_OPS || 20);
const PORT = 19000 + Math.floor(Math.random() * 500);

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, doc: createDoc(), inbox: [], welcome: null, latencies: [] };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'welcome') c.welcome = m;
      else if (m.type === 'op') {
        const now = Date.now();
        for (const op of m.ops) {
          if (typeof op.ts === 'number') c.latencies.push(now - op.ts);
          c.inbox.push(op);
          applyOps(c.doc, [op]);
        }
      }
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error('ws connect error'));
  });
}

async function waitHealthz(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('healthz timeout');
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: ':memory:' },
  stdio: 'ignore',
});

await waitHealthz(PORT);

const clients = [];
for (let i = 0; i < N; i++) clients.push(await connect(PORT));
await new Promise((r) => setTimeout(r, 100));

const t0 = Date.now();
let sent = 0;
for (let ci = 0; ci < N; ci++) {
  const c = clients[ci];
  for (let k = 0; k < M; k++) {
    const el = sampleElement('rect', { id: `${c.welcome.clientId}-${k}`, geom: { x: k * 10, y: k * 10, w: 20, h: 20 } });
    const op = { t: 'add', id: el.id, el, c: c.welcome.clientId, v: c.doc.clock + 1, ts: Date.now() };
    c.doc.clock += 1;
    applyOps(c.doc, [op]);
    c.ws.send(JSON.stringify({ type: 'op', ops: [op] }));
    sent++;
  }
}

// 等所有 op 到达其余副本（每个客户端应收到 sent - M 条）
const expectInbox = sent - M;
const tSend = Date.now();
await new Promise((r) => setTimeout(r, 1500));

// 收敛判定：全副本 stateHash 一致
const hashes = new Set();
let convergedAt = null;
const t1 = Date.now();
for (let tries = 0; tries < 50; tries++) {
  hashes.clear();
  for (const c of clients) hashes.add(stateHash(docState(c.doc)));
  if (hashes.size === 1) { convergedAt = Date.now(); break; }
  await new Promise((r) => setTimeout(r, 100));
}

const allLat = clients.flatMap((c) => c.latencies).sort((a, b) => a - b);
const p95 = allLat.length ? allLat[Math.floor(allLat.length * 0.95)] : 0;
const counts = clients.map((c) => docState(c.doc).length);

console.log('=== 压测冒烟 ===');
console.log(`clients=${N} ops/client=${M} totalOps=${sent}`);
console.log(`副本元素数: ${Math.min(...counts)}..${Math.max(...counts)}（期望 ${sent}）`);
console.log(`收敛: ${hashes.size === 1 ? 'OK' : 'FAIL'}，耗时 ${convergedAt ? convergedAt - t1 : 'N/A'}ms（判定窗口 ${Date.now() - t1}ms）`);
console.log(`op→远端可见 P95: ${p95}ms（样本 ${allLat.length}）`);
console.log(`吞吐: ${(sent / ((Date.now() - t0) / 1000)).toFixed(0)} ops/s`);

child.kill('SIGKILL');

if (hashes.size !== 1 || Math.min(...counts) !== sent) {
  console.error('BENCH FAIL');
  process.exit(1);
}
console.log('BENCH PASS');

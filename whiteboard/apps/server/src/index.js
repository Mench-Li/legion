// index.js — 服务端入口：单进程 Node http + 自研 ws relay + 静态前端 + /healthz。
// 部署形态（ADR-0005）：单实例、单进程，显式不承诺横向扩展。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from './ws.mjs';
import { Room } from './room.mjs';
import { createStorage } from './storage.mjs';
import { serializeDoc } from '../../../packages/shared/src/crdt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'whiteboard.db');
const TTL_MS = Number(process.env.TTL_MS || 10000);
const WEB_ROOT = path.resolve(__dirname, '..', '..', 'web', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(WEB_ROOT, urlPath));
  if (!filePath.startsWith(WEB_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function main() {
  const storage = createStorage(DB_PATH);
  const room = new Room({ storage, ttlMs: TTL_MS, snapshotEveryMs: 1000 });
  await room.init();

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/healthz/') {
      const healthy = storage.isHealthy ? storage.isHealthy() : true;
      const body = JSON.stringify({ ok: healthy, storage: storage.constructor.name, ts: Date.now() });
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxLen: 1024 * 1024 });

  wss.on('connection', (conn) => {
    const connId = crypto.randomUUID();
    const welcome = {
      type: 'welcome',
      clientId: connId,
      doc: serializeDoc(room.doc),
      peers: room.peers(),
    };
    conn.send(JSON.stringify(welcome));

    conn.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'op') {
        room.applyOpsFrom(connId, msg.ops).then((accepted) => {
          if (accepted.length === 0) return;
          const out = JSON.stringify({ type: 'op', ops: accepted, from: connId });
          for (const c of wss.clients) {
            if (c !== conn) c.send(out);
          }
        }).catch(() => { /* ignore persist error */ });
      } else if (msg.type === 'presence') {
        const s = room.setPresence(connId, msg.state);
        const out = JSON.stringify({ type: 'presence', from: connId, state: s });
        for (const c of wss.clients) {
          if (c !== conn) c.send(out);
        }
      }
    });

    conn.on('close', () => {
      if (room.removePresence(connId)) {
        const out = JSON.stringify({ type: 'leave', clientId: connId });
        for (const c of wss.clients) {
          if (c !== conn) c.send(out);
        }
      }
    });
  });

  const tick = setInterval(() => {
    const expired = room.tick();
    for (const id of expired) {
      const out = JSON.stringify({ type: 'leave', clientId: id });
      for (const c of wss.clients) c.send(out);
    }
    for (const c of wss.clients) c.ping();
  }, Math.min(1000, TTL_MS / 2));

  server.listen(PORT, HOST, () => {
    console.log(`[whiteboard] listening on http://${HOST}:${PORT} (db=${DB_PATH}, ttl=${TTL_MS}ms)`);
  });

  const shutdown = () => {
    clearInterval(tick);
    wss.close();
    room.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[whiteboard] fatal:', e);
  process.exit(1);
});

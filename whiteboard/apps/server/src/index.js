// index.js — 服务端入口：单进程 Node http + 自研 ws relay + 静态前端 + 治理（P3-1）。
//
// 部署形态（ADR-0005 / ADR-0008）：单实例、单进程，显式不承诺横向扩展。
// P3-1 新增：多房间（每房间独立 SQLite 文件）、房间级 token/角色、连接与消息限流、
//           /metrics 指标、/api/rooms 与 /api/rooms/:id/audit 审计、/readyz 深度探活。
//
// 关键不变量（与既有契约兼容）：
//   - `/ws` 不带 `?room=` → 默认房间 `default`（既有 e2e/bench 无缝继续工作）；
//   - `/healthz` 仍返回 200 + `{"ok":true,...}`（CI 冒烟断言 `"ok":true` 与 200）；
//   - 房间之间**完全隔离**：文档、presence、广播、存储文件都不共享。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from './ws.mjs';
import {
  validateSecurityConfig, parseRoomConfig, authorizeRoom, extractToken, extractRoomId,
} from './security.mjs';
import { RoomRegistry, resolveRoomConfig, DEFAULT_ROOM_ID } from './rooms.mjs';
import {
  ConnectionLimiter, MessageRateLimiter, checkPayload, checkMessage, resolveLimitConfig, LIMIT_DEFAULTS,
} from './limits.mjs';
import { Metrics } from './metrics.mjs';
import { AuditLog, AUDIT_SOURCES } from './audit.mjs';
import { describeHolder, lockPathFor } from './dirLock.mjs';
import { serializeDoc } from '../../../packages/shared/src/crdt.mjs';
import { loadConfig } from '../../../packages/shared/src/config.mjs';
import { SCHEMA as CONFIG_SCHEMA } from './config-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P3-2 统一配置：核心项（host/port/token/DB 路径）经统一引擎解析（优先级 CLI > env > 默认，
// 类型/范围校验，非法值报错退出）。其余 WB_* 限流键仍由 limits.mjs/rooms.mjs 自己读取
//（已在 config-schema.mjs 中声明，scan --check 强制；默认值由单测做漂移比对）。
const CFG = loadConfig(CONFIG_SCHEMA, { env: process.env, argv: process.argv.slice(2) });
if (CFG.errors.length) {
  for (const e of CFG.errors) console.error(`[config] whiteboard 配置错误：${e.message}`);
  console.error('[config] 用 `node scripts/config/check.mjs --process=whiteboard` 查看完整配置面');
  // 与 team-hub / workbench 一致：仅当本模块是入口时才 exit；被 import 时抛错，
  // 避免一处配置错误直接杀掉导入方进程（本文件底部 isMain 用同一判定）。
  const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  if (isEntry) process.exit(1);
  throw new Error(`whiteboard 配置无效：${CFG.errors.map((e) => e.message).join('；')}`);
}
for (const w of CFG.warnings) console.error(`[config] whiteboard 配置告警：${w.message}`);

/**
 * P4-5：把一批已接受的 op 压成**结构性摘要**（如 `{ add: 2, del: 1 }`），只用于审计。
 * 刻意不记录元素内容 / 坐标 / 颜色（审计是治理工具，不是内容归档；画布内容留在房间库里）。
 */
function auditOpKinds(ops) {
  const kinds = {};
  for (const op of Array.isArray(ops) ? ops : []) {
    const k = typeof op?.t === 'string' ? op.t : 'unknown';
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return kinds;
}

const PORT = CFG.values.port;
const HOST = CFG.values.host;
// 语义与改造前一致：显式提供时按原样使用，未提供才回退到白板目录下的默认库路径。
const DB_PATH = CFG.sources.dbPath === 'default'
  ? path.join(__dirname, '..', 'data', 'whiteboard.db')
  : String(CFG.values.dbPath);
const TTL_MS = CFG.values.ttlMs;
const WEB_ROOT = path.resolve(__dirname, '..', '..', 'web', 'public');
const WHITEBOARD_TOKEN = CFG.values.token;
const ROOMS_DIR = process.env.WB_ROOMS_DIR || path.join(__dirname, '..', 'data', 'rooms');
const AUDIT_DIR = process.env.WB_AUDIT_DIR || path.join(__dirname, '..', 'data');
// 兼容既有部署：DB_PATH=':memory:'（bench/CI 冒烟）→ 房间也走内存，不落盘
const IN_MEMORY_ROOMS = DB_PATH === ':memory:' || process.env.WB_IN_MEMORY === '1';
// 指标与控制面端点默认仅回环可访问（暴露治理信息需要显式开启）
const CONTROL_OPEN = process.env.WB_CONTROL_OPEN === '1';

/** 启动时打印的脱敏配置摘要（token 只显示是否设置；路径显示实际生效值）。 */
export function configSummaryLine() {
  return `${CFG.summary} roomsDir=${ROOMS_DIR} auditDir=${AUDIT_DIR}`;
}

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

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** 远程地址归一（不信任 X-Forwarded-For：本服务默认直连回环；如需反代请自行在边界处理） */
function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function isLoopback(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export async function createApp(options = {}) {
  const cfg = {
    port: PORT, host: HOST,
    globalToken: WHITEBOARD_TOKEN,
    roomsDir: ROOMS_DIR,
    auditDir: AUDIT_DIR,
    inMemoryRooms: IN_MEMORY_ROOMS,
    controlOpen: CONTROL_OPEN,
    ...options,
  };
  validateSecurityConfig({ host: cfg.host, token: cfg.globalToken });

  const { rooms: roomConfig, errors: roomConfigErrors } = parseRoomConfig(cfg.roomConfigRaw ?? process.env.WHITEBOARD_ROOMS ?? '');
  for (const err of roomConfigErrors) console.warn(`[whiteboard] 房间配置告警: ${err}`);

  const limits = resolveLimitConfig(process.env, cfg.limits ?? {});
  const roomCfg = resolveRoomConfig(process.env, { TTL_MS, ...(cfg.roomConfig ?? {}) });

  const metrics = new Metrics();
  const audit = new AuditLog({ dir: cfg.auditDir, enabled: cfg.auditEnabled !== false });
  const registry = new RoomRegistry({
    dir: cfg.roomsDir, inMemory: cfg.inMemoryRooms, config: roomCfg, audit, metrics,
    lockPort: cfg.port, lockHost: cfg.host,
  });
  const limiter = new ConnectionLimiter(limits);

  // P4-6（候选 #5）：目录锁拿不到时**启动即报**——这是本切片的核心目的：
  // 把「两个实例共享一个房间目录 → 静默数据分裂」变成一条明确的、带处置建议的启动错误。
  // 与配置错误的处置一致：入口时 exit(1)，被 import 时抛错（不杀导入方进程）。
  if (registry.lockFailure) {
    const h = registry.lockFailure.holder;
    const msg = `[whiteboard] 房间目录已被另一个白板实例占用：${cfg.roomsDir}（占用者 ${describeHolder(h)}）\n`
      + '  白板是单实例设计（ADR-0008 决策 1）：两个实例共享同一 WB_ROOMS_DIR 会**静默分裂数据**\n'
      + '  （各自一份内存 doc，且落快照时会删掉对方尚未读到的 op）。\n'
      + '  处置：① 停掉那个实例；② 或为本实例指定独立的 WB_ROOMS_DIR；'
      + '③ 若确认那个进程已不存在，删除锁文件后重启：' + lockPathFor(cfg.roomsDir);
    if (registry.lockFailure.reason === 'unwritable') {
      console.error(`[whiteboard] 房间目录不可写：${cfg.roomsDir}（${registry.lockFailure.error ?? ''}）`);
    } else {
      console.error(msg);
    }
    const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
    if (isEntry) process.exit(1);
    throw new Error(msg);
  }
  if (registry.lock?.staleTakeover) {
    console.error(`[whiteboard] 接管了陈旧目录锁（上一个进程未优雅退出）：${registry.lock.path ?? cfg.roomsDir}`);
  }

  // 仪表盘：实时读数（房间数、在线数、限流状态）——纯数据，供 /metrics
  metrics.gauges = () => {
    const rooms = registry.list();
    return {
      rooms: { open: registry.size(), closedTotal: registry.closedCount, detail: rooms },
      peers: rooms.reduce((n, r) => n + r.peers, 0),
      connections: limiter.snapshot(),
      // P4-6：把「谁独占着房间目录」暴露出来——运维查 /metrics 就能确认单实例约束当前成立
      dirLock: registry.lockStatus(),
      audit: {
        ...audit.counts(),
        // P4-5：把「能回溯多久」一并暴露——只看 fileBytes 无法判断历史是否已被轮转掉。
        // resource: 进程内环形缓冲（重启归零）；archive: 磁盘 JSONL（跨重启）。
        retention: audit.retention(),
      },
      limits: {
        maxConnections: limits.MAX_CONNECTIONS,
        maxConnectionsPerRoom: limits.MAX_CONNECTIONS_PER_ROOM,
        maxConnectionsPerIp: limits.MAX_CONNECTIONS_PER_IP,
        maxMessageBytes: limits.MAX_MESSAGE_BYTES,
        maxOpsPerMessage: limits.MAX_OPS_PER_MESSAGE,
        messageRatePerSec: limits.MESSAGE_RATE_PER_SEC,
        messageBurst: limits.MESSAGE_BURST,
      },
    };
  };

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath === '/healthz' || urlPath === '/healthz/') {
      // 浅探活：进程存活 + 存储可读（既有契约：ok/ storage / ts 字段保留）
      const healthy = storageHealthOk();
      sendJson(res, healthy ? 200 : 503, {
        ok: healthy,
        storage: cfg.inMemoryRooms ? 'MemoryProvider' : 'SqliteProvider',
        // P4-6：既有字段全部保留（ok/storage/ts 契约不变），只**新增** dirLock 供运维确认单实例约束。
        // 拿不到锁时进程根本不会起来（见启动期检查），所以这里出现 denied 只可能是逃生阀场景。
        dirLock: registry.lockStatus().mode,
        rooms: registry.size(),
        peers: metrics.gauges().peers,
        uptimeMs: metrics.snapshot().uptimeMs,
        ts: Date.now(),
      });
      return;
    }

    if (urlPath === '/readyz' || urlPath === '/readyz/') {
      // 深探活：逐房间存储健康 + 心跳新鲜度（tick 停摆可被感知）
      if (!controlAllowed(req, res, cfg)) return;
      const heartbeatAgeMs = Date.now() - lastTickAt;
      const roomHealth = registry.list().map((r) => {
        const room = registry.get(r.id);
        return { ...r, healthy: room?.storage?.isHealthy ? !!room.storage.isHealthy() : true };
      });
      const ok = roomHealth.every((r) => r.healthy) && heartbeatAgeMs < Math.max(5000, roomCfg.TTL_MS * 2);
      sendJson(res, ok ? 200 : 503, {
        ok,
        heartbeatAgeMs,
        // P4-6：深探活应能回答「单实例约束是否仍成立」——这是数据完整性的前提
        dirLock: registry.lockStatus(),
        rooms: roomHealth,
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    if (urlPath === '/metrics' || urlPath === '/metrics/') {
      if (!controlAllowed(req, res, cfg)) return;
      sendJson(res, 200, metrics.snapshot());
      return;
    }

    if (urlPath === '/api/rooms' || urlPath === '/api/rooms/') {
      if (!controlAllowed(req, res, cfg)) return;
      sendJson(res, 200, {
        ok: true,
        rooms: registry.list(),
        declared: [...roomConfig.entries()].map(([id, c]) => ({ id, role: c.role, protected: !!c.token })),
        configErrors: roomConfigErrors,
        limits,
      });
      return;
    }

    const auditMatch = /^\/api\/rooms\/([a-z0-9][a-z0-9_-]{0,63})\/audit\/?$/.exec(urlPath);
    if (auditMatch) {
      if (!controlAllowed(req, res, cfg)) return;
      const roomId = auditMatch[1];
      const url = new URL(req.url || '/', 'http://localhost');
      const limit = Number(url.searchParams.get('limit') || 100);
      const type = url.searchParams.get('type') || null;
      // P4-5（候选 #7）：`source` 决定查哪里——process（默认，仅本进程，行为与 P3-1 一致）/ archive
      // （磁盘 JSONL，**重启后仍可查**）/ all（合并去重）。拼错的值显式 400，不静默当成默认值
      // （否则「我明明传了 archive 却只拿到进程内 0 条」会变成新的误导）。
      const source = url.searchParams.get('source') || 'process';
      if (!AUDIT_SOURCES.includes(source)) {
        sendJson(res, 400, { ok: false, error: 'bad_source', source, allowed: [...AUDIT_SOURCES] });
        return;
      }
      const result = audit.query({ room: roomId, type, limit, source });
      const retention = audit.retention();
      // 默认查询为空但磁盘有历史时，把「下一步该怎么做」直接写进响应里——
      // 这正是候选 #7 的原始症状：重启后 API 说「没有事件」，而归档其实躺着完整历史。
      const hint = result.items.length === 0 && retention.fileCount > 0 && source !== 'archive'
        ? `进程内暂无事件；磁盘归档有 ${retention.fileCount} 个文件（最早 ${retention.oldestTs === null ? '未知' : new Date(retention.oldestTs).toISOString()}），`
          + '用 source=archive 或 source=all 查询历史事件'
        : null;
      sendJson(res, 200, { ok: true, room: roomId, ...result, retention, ...(hint ? { hint } : {}) });
      return;
    }

    const roomMatch = /^\/api\/rooms\/([a-z0-9][a-z0-9_-]{0,63})\/?$/.exec(urlPath);
    if (roomMatch) {
      if (!controlAllowed(req, res, cfg)) return;
      const roomId = roomMatch[1];
      const room = registry.get(roomId);
      if (!room) { sendJson(res, 404, { ok: false, error: 'room_not_open', room: roomId }); return; }
      sendJson(res, 200, { ok: true, ...room.summary() });
      return;
    }

    serveStatic(req, res);
  });

  function storageHealthOk() {
    try {
      for (const r of registry.list()) {
        const room = registry.get(r.id);
        if (room?.storage?.isHealthy && !room.storage.isHealthy()) return false;
      }
      return true;
    } catch { return false; }
  }

  /** 控制面端点（/metrics、/readyz、/api/rooms*）：默认仅回环；非回环需 token 或显式开启 */
  function controlAllowed(req, res, cfg) {
    if (cfg.controlOpen || isLoopback(req)) return true;
    const supplied = extractToken(req);
    if (cfg.globalToken && supplied === cfg.globalToken) return true;
    sendJson(res, 403, { ok: false, error: 'control_plane_forbidden', hint: '控制面默认仅回环可访问；远程访问需 Bearer token 或 WB_CONTROL_OPEN=1' });
    return false;
  }

  let lastTickAt = Date.now();

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxLen: Math.max(limits.MAX_MESSAGE_BYTES, 64 * 1024), // 帧上限 ≥ 应用消息上限（超限由应用层给 1009）
    // 房间解析 → 鉴权 → 连接数准入，全部在握手前完成
    gate: (req) => gateUpgrade(req),
  });

  function gateUpgrade(req) {
    const roomId = extractRoomId(req);
    const ip = clientIp(req);
    if (roomId === null) {
      metrics.reject('bad_room');
      metrics.inc('upgradesBadRoom');
      return { ok: false, status: 400, reason: 'bad_room' };
    }
    const auth = authorizeRoom({
      roomId,
      suppliedToken: extractToken(req),
      globalToken: cfg.globalToken,
      roomConfig,
    });
    if (!auth.ok) {
      metrics.reject('unauthorized');
      metrics.inc('upgradesUnauthorized');
      audit.record({ type: 'deny', room: roomId, ip, reason: 'unauthorized' });
      return { ok: false, status: 401, reason: 'unauthorized' };
    }
    const admit = limiter.acquire(ip, roomId);
    if (!admit.ok) {
      metrics.reject(admit.reason);
      audit.record({ type: 'reject', room: roomId, ip, reason: admit.reason, connections: limiter.snapshot().total });
      return { ok: false, status: 503, reason: admit.reason };
    }
    return { ok: true, roomId, role: auth.role, ip };
  }

  wss.on('connection', (conn, req) => {
    const { roomId, role, ip } = conn.gate ?? { roomId: DEFAULT_ROOM_ID, role: 'rw', ip: clientIp(req ?? {}) };
    const connId = crypto.randomUUID();
    conn.connId = connId;
    conn.roomId = roomId;
    conn.role = role;
    conn.ip = ip;
    conn.rate = new MessageRateLimiter(limits);
    metrics.inc('connectionsTotal');
    audit.record({ type: 'connect', room: roomId, clientId: connId, ip, role });

    // 房间惰性打开（存储可能打不开：此时拒绝该连接而不是让它对着空房间画）
    registry.open(roomId).then((r) => {
      if (!r.ok) {
        conn.send(JSON.stringify({ type: 'error', code: r.reason, message: '房间不可用' }));
        conn.close(1011);
        return;
      }
      const room = r.room;
      room.setRole(connId, role);
      conn.room = room;
      room.setPresence(connId, { name: `user-${connId.slice(0, 4)}`, color: '#888888', x: 0, y: 0 });
      conn.send(JSON.stringify({
        type: 'welcome',
        clientId: connId,
        room: roomId,
        role,
        doc: serializeDoc(room.doc),
        peers: room.peers(),
        limits: {
          maxMessageBytes: limits.MAX_MESSAGE_BYTES,
          maxOpsPerMessage: limits.MAX_OPS_PER_MESSAGE,
          messageRatePerSec: limits.MESSAGE_RATE_PER_SEC,
        },
      }));
    }).catch(() => { conn.close(1011); });

    conn.on('message', (text) => {
      registry.touch(roomId);
      metrics.inc('messagesIn');
      metrics.inc('bytesIn', Buffer.byteLength(text, 'utf8'));

      const rate = conn.rate.allow();
      if (!rate.ok) {
        metrics.inc('rateLimitDrops');
        audit.record({ type: 'rate_limit', room: roomId, clientId: connId, ip, dropCount: rate.dropCount });
        if (rate.shouldClose) {
          metrics.inc('rateLimitCloses');
          conn.send(JSON.stringify({ type: 'error', code: 'rate_limited', message: '消息频率持续超限，连接将被关闭' }));
          conn.close(1008);
          return;
        }
        if (rate.warn) {
          send(conn, { type: 'error', code: 'rate_limited', retryAfterMs: rate.retryAfterMs, message: '消息过于频繁，已丢弃本条' });
        }
        return;
      }

      const size = checkPayload(text, limits);
      if (!size.ok) return policyClose(conn, size);
      let msg;
      try { msg = JSON.parse(text); } catch {
        return policyClose(conn, { code: 'malformed_message', closeCode: 1008, reason: 'JSON 解析失败' });
      }
      const shape = checkMessage(msg, limits);
      if (!shape.ok) return policyClose(conn, shape);

      if (msg.type === 'op') {
        const room = conn.room;
        if (!room) return; // 房间尚未打开：丢弃（welcome 会带上完整状态）
        // 只读角色：先拒后写（Room 内部也拒绝，这里给出明确回执与审计）
        if (room.roleOf(connId) === 'ro') {
          room.stats.opsDeniedReadonly += Array.isArray(msg.ops) ? msg.ops.length : 0;
          metrics.inc('opsDeniedReadonly', Array.isArray(msg.ops) ? msg.ops.length : 0);
          audit.record({ type: 'op_denied', room: roomId, clientId: connId, count: Array.isArray(msg.ops) ? msg.ops.length : 0 });
          send(conn, { type: 'error', code: 'op_denied', message: '当前为只读角色，无法写入' });
          return;
        }
        room.applyOpsFrom(connId, msg.ops).then((accepted) => {
          if (accepted.length === 0) return;
          metrics.inc('opsAccepted', accepted.length);
          // P4-5：`ops` 一直是 AUDIT_TYPES 里**声明了却从未写入**的类型——于是审计只记录
          // 「谁进来了/谁被拒了」，恰恰缺了「谁画了什么」。事后取证时这是最要紧的一条：
          // 归档里有 connect 却没有 ops，等于只知道有人来过，不知道他改了什么。
          // 只记**结构性事实**（条数 + 类型分布），不记画布内容（与 audit.mjs 的设计一致）。
          audit.record({
            type: 'ops',
            room: roomId,
            clientId: connId,
            ip,
            count: accepted.length,
            kinds: auditOpKinds(accepted),
          });
          const out = JSON.stringify({ type: 'op', ops: accepted, from: connId });
          metrics.inc('messagesOut');
          wss.broadcastToRoom(roomId, out, conn);
        }).catch(() => { /* 落库失败不阻断其他客户端 */ });
      } else if (msg.type === 'presence') {
        const room = conn.room;
        if (!room) return;
        const s = room.setPresence(connId, msg.state);
        metrics.inc('presenceUpdates');
        // P4-5：presence 是**高频临态**（前端在 mousemove 上发，room.mjs 明确它是「绝不写 doc/存储」的临态）。
        // 逐条写审计等于把一次鼠标移动变成一次同步 appendFileSync——而审计写文件是同步的（P3-1 的设计）。
        // 实测后果：治理用例「频率超限」发 260 条 presence，多出的 240 次同步落盘把处置时间从
        // 百毫秒级拉到秒级，令牌桶趁机回填（120/s），本该被丢弃的消息不再被丢 → 收不到限流告警。
        // 因此只在**首次**（该连接第一次发 presence）记一条，条数上界 = 连接数，与鼠标移动次数无关。
        // 取证价值仍在：能回答「这个连接在房间里活跃过」；逐次移动属于行为画像，不该进审计。
        if (conn.presenceAudited !== true) {
          conn.presenceAudited = true;
          audit.record({ type: 'presence', room: roomId, clientId: connId, ip, active: true, first: true });
        }
        const out = JSON.stringify({ type: 'presence', from: connId, state: s });
        metrics.inc('messagesOut');
        wss.broadcastToRoom(roomId, out, conn);
      } else if (msg.type === 'ping') {
        send(conn, { type: 'pong', ts: Date.now() });
      }
      // 未知 type：忽略（向后兼容既有客户端）
    });

    conn.on('close', () => {
      limiter.release(ip, roomId);
      const room = conn.room;
      if (room) {
        const had = room.removePresence(connId);
        if (had) {
          const out = JSON.stringify({ type: 'leave', clientId: connId });
          metrics.inc('messagesOut');
          wss.broadcastToRoom(roomId, out, conn);
        }
      }
      audit.record({ type: 'disconnect', room: roomId, clientId: connId, ip });
    });
  });

  function send(conn, obj) {
    conn.send(JSON.stringify(obj));
  }

  function policyClose(conn, verdict) {
    metrics.inc('policyCloses');
    audit.record({ type: 'policy_close', room: conn.roomId, clientId: conn.connId, ip: conn.ip, code: verdict.code, reason: verdict.reason });
    send(conn, { type: 'error', code: verdict.code, message: verdict.reason });
    conn.close(verdict.closeCode ?? 1008);
  }

  // 周期维护：presence TTL + 房间空闲关闭 + 心跳；同时记录 tick 时间供 /readyz 判定
  const tickMs = Math.min(1000, roomCfg.TTL_MS / 2);
  const tick = setInterval(() => {
    lastTickAt = Date.now();
    registry.tick().then(({ expired }) => {
      for (const { roomId, clientIds } of expired) {
        for (const id of clientIds) {
          metrics.inc('messagesOut');
          wss.broadcastToRoom(roomId, JSON.stringify({ type: 'leave', clientId: id }));
        }
      }
    }).catch(() => {});
    for (const c of wss.clients) c.ping();
  }, tickMs);

  return {
    server, wss, registry, metrics, audit, limiter, limits, roomConfig, roomConfigErrors,
    async listen(port = cfg.port, host = cfg.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      console.log(`[whiteboard] listening on http://${host}:${port} (rooms=${cfg.inMemoryRooms ? ':memory:' : cfg.roomsDir}, ttl=${roomCfg.TTL_MS}ms, maxConn=${limits.MAX_CONNECTIONS})`);
      return server.address();
    },
    async close() {
      clearInterval(tick);
      wss.close();
      await registry.closeAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  console.log(configSummaryLine()); // P3-2：启动即打印脱敏后的最终配置
  const app = await createApp();
  await app.listen();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[whiteboard] shutting down…');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 仅在直接运行时启动（被 import 时不自动监听，便于测试进程内起服务）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    console.error('[whiteboard] fatal:', e);
    process.exit(1);
  });
}

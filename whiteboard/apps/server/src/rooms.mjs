// rooms.mjs — P3-1 房间注册表：房间 ID 校验 + 每房间独立 SQLite 文件 + 惰性打开/空闲关闭。
//
// 存储形态（P3-1 决策 A）：每个房间一个独立 DB 文件 `<root>/<roomId>.db`。
//   - 隔离好：删房间 = 删文件；单房间损坏不影响他人；
//   - 代价：跨房间聚合需逐库读取（本模块的 stats() 只做轻量读，不扫全量 op）。
// 房间生命周期：首个连接时惰性打开；空闲超过 idleMs 且无在线用户时关闭（关闭前落一次快照）。
// 单实例声明（ADR-0008）：本模块假设**唯一进程**持有这些文件；多进程共享同一目录会各自持锁竞争。

import fs from 'node:fs';
import path from 'node:path';

import { Room } from './room.mjs';
import { createStorage } from './storage.mjs';

/** 房间 ID 规则：小写字母/数字开头，其后允许小写字母、数字、`-`、`_`，长度 1..64。
 *  故意排除大写与点号——避免大小写不敏感文件系统上的歧义与路径穿越（`..`）。*/
export const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_ROOM_ID = 'default';

export function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id);
}

/** 从查询串/URL 解析房间 ID（缺省 → DEFAULT_ROOM_ID）；非法返回 { ok:false } */
export function parseRoomId(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, roomId: DEFAULT_ROOM_ID };
  if (!isValidRoomId(raw)) return { ok: false, reason: 'bad_room', roomId: null };
  return { ok: true, roomId: raw };
}

export const ROOM_DEFAULTS = Object.freeze({
  IDLE_MS: 5 * 60 * 1000, // 空闲多久关闭房间存储
  MAX_ROOMS: 50, // 同时打开的房间数上限（防止磁盘/句柄被拖垮）
  TTL_MS: 10000,
  SNAPSHOT_EVERY_MS: 1000,
});

export function resolveRoomConfig(env = process.env, overrides = {}) {
  const num = (key, fallback) => {
    const n = Number(env[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    IDLE_MS: num('WB_ROOM_IDLE_MS', ROOM_DEFAULTS.IDLE_MS),
    MAX_ROOMS: num('WB_MAX_ROOMS', ROOM_DEFAULTS.MAX_ROOMS),
    TTL_MS: num('TTL_MS', ROOM_DEFAULTS.TTL_MS),
    SNAPSHOT_EVERY_MS: ROOM_DEFAULTS.SNAPSHOT_EVERY_MS,
    ...overrides,
  };
}

export class RoomRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.dir      房间 DB 目录（每个房间 <dir>/<roomId>.db）
   * @param {boolean} [opts.inMemory]  true 时使用内存存储（测试/压测），不落盘
   */
  constructor({ dir, inMemory = false, config = {}, audit = null, metrics = null, now = () => Date.now() } = {}) {
    this.cfg = { ...ROOM_DEFAULTS, ...config };
    this.dir = dir;
    this.inMemory = inMemory;
    this.audit = audit;
    this.metrics = metrics;
    this.now = now;
    this.rooms = new Map(); // roomId -> { room, lastActive, openedAt }
    this.closedCount = 0;
  }

  /** 已打开房间的只读概况（供 /healthz、/readyz、/metrics、/api/rooms） */
  list() {
    return [...this.rooms.entries()].map(([id, e]) => ({
      id,
      peers: e.room.peers().length,
      elements: e.room.state().length,
      openedAt: new Date(e.openedAt).toISOString(),
      idleMs: this.now() - e.lastActive,
      db: this.inMemory ? ':memory:' : path.join(this.dir ?? '', `${id}.db`),
    }));
  }

  get(roomId) {
    return this.rooms.get(roomId)?.room ?? null;
  }

  isOpen(roomId) {
    return this.rooms.has(roomId);
  }

  size() {
    return this.rooms.size;
  }

  /**
   * 取得（必要时打开）房间。打开失败（目录不可写、房间数超限）返回 { ok:false, reason }。
   * 注意：房间数超限时**不**淘汰已有房间——淘汰会把在线用户的画布踢掉，宁可拒绝新房间。
   */
  async open(roomId) {
    if (!isValidRoomId(roomId)) return { ok: false, reason: 'bad_room' };
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.lastActive = this.now();
      return { ok: true, room: existing.room, created: false };
    }
    if (this.rooms.size >= this.cfg.MAX_ROOMS) return { ok: false, reason: 'max_rooms' };

    let storage;
    if (this.inMemory) {
      storage = createStorage(':memory:');
    } else {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        storage = createStorage(path.join(this.dir, `${roomId}.db`));
      } catch (e) {
        return { ok: false, reason: 'storage_open_failed', error: String(e && e.message) };
      }
    }
    const room = new Room({ storage, ttlMs: this.cfg.TTL_MS, snapshotEveryMs: this.cfg.SNAPSHOT_EVERY_MS, roomId });
    try {
      await room.init();
    } catch (e) {
      await room.close().catch(() => {});
      return { ok: false, reason: 'storage_load_failed', error: String(e && e.message) };
    }
    const now = this.now();
    this.rooms.set(roomId, { room, lastActive: now, openedAt: now });
    this.metrics?.inc('roomsOpened');
    this.audit?.record({ type: 'room_open', room: roomId, elements: room.state().length, db: this.inMemory ? ':memory:' : path.join(this.dir ?? '', `${roomId}.db`) });
    return { ok: true, room, created: true };
  }

  /** 标记房间有活动（消息/连接），用于空闲判定 */
  touch(roomId) {
    const e = this.rooms.get(roomId);
    if (e) e.lastActive = this.now();
  }

  /**
   * 周期维护：所有已打开房间的 presence TTL + 快照，并关闭空闲房间。
   * 返回 { expired: [{roomId, clientIds}], closedRooms: string[] }
   */
  async tick(now = this.now()) {
    const expired = [];
    const closedRooms = [];
    for (const [roomId, e] of [...this.rooms.entries()]) {
      const ids = e.room.tick(now);
      if (ids.length) expired.push({ roomId, clientIds: ids });
      const idle = now - e.lastActive > this.cfg.IDLE_MS;
      if (idle && e.room.peers().length === 0) {
        // 空闲且无在线用户 → 关闭存储（关闭前 Room.close() 会落快照）
        await this.close(roomId, 'room_idle_close').catch(() => {});
        closedRooms.push(roomId);
      }
    }
    return { expired, closedRooms };
  }

  async close(roomId, auditType = 'room_idle_close') {
    const e = this.rooms.get(roomId);
    if (!e) return false;
    this.rooms.delete(roomId);
    this.closedCount += 1;
    this.metrics?.inc('roomsClosed');
    this.audit?.record({ type: auditType, room: roomId, elements: e.room.state().length });
    await e.room.close().catch(() => {});
    return true;
  }

  /** 全部关闭（进程退出） */
  async closeAll() {
    for (const roomId of [...this.rooms.keys()]) {
      await this.close(roomId, 'room_idle_close').catch(() => {});
    }
  }
}

// room.mjs — 房间（单实例）：文档状态 + presence 聚合 + 持久化挂接（S3/S4/S10/S11）。
// 纯逻辑，不依赖 ws，便于进程内集成测试；ws 适配在 index.js。

import {
  createDoc,
  applyOp,
  applyOps,
  docState,
  serializeDoc,
  deserializeDoc,
  validateElement,
} from '../../../packages/shared/src/index.mjs';

const PATCH_PATHS = new Set(['type', 'geom', 'stroke', 'fill', 'strokeWidth']);

function isValidOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (!['add', 'patch', 'del'].includes(op.t)) return false;
  if (typeof op.id !== 'string' || op.id.length === 0) return false;
  if (typeof op.c !== 'string' || op.c.length === 0) return false;
  if (typeof op.v !== 'number' || !Number.isFinite(op.v)) return false;
  if (op.t === 'add') {
    return validateElement(op.el).ok;
  }
  if (op.t === 'patch') {
    return PATCH_PATHS.has(op.path) && op.value !== undefined;
  }
  return true; // del
}

/** 过滤/校验一批 op，返回合法 op 列表 */
export function sanitizeOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.filter(isValidOp);
}

export class Room {
  constructor({ storage, ttlMs = 10000, snapshotEveryMs = 1000 } = {}) {
    this.storage = storage;
    this.ttlMs = ttlMs;
    this.snapshotEveryMs = snapshotEveryMs;
    this.doc = createDoc();
    this.presence = new Map(); // clientId -> { state, lastSeen }
    this.loaded = false;
    this._lastSnapshot = 0;
    this._snapshotPending = false;
  }

  async init() {
    const { snapshot, ops } = await this.storage.load();
    if (snapshot) this.doc = deserializeDoc(snapshot);
    applyOps(this.doc, ops);
    this.loaded = true;
    return docState(this.doc).length;
  }

  /** 当前持久态（图形元素，不含 presence） */
  state() {
    return docState(this.doc);
  }

  /** 在线列表（presence，绝不入文档） */
  peers() {
    return [...this.presence.entries()].map(([id, e]) => ({ id, ...e.state }));
  }

  /** 应用并持久化一批 op；返回被接受的 op（用于广播） */
  async applyOpsFrom(clientId, ops) {
    const good = sanitizeOps(ops);
    if (good.length === 0) return [];
    applyOps(this.doc, good);
    await this.storage.append(good);
    this._maybeSnapshot(Date.now());
    return good;
  }

  /** 更新 presence（临态，绝不写 doc/存储） */
  setPresence(clientId, state) {
    const s = {
      name: typeof state?.name === 'string' ? state.name.slice(0, 32) : 'anonymous',
      color: typeof state?.color === 'string' ? state.color.slice(0, 16) : '#888888',
      x: Number.isFinite(state?.x) ? state.x : 0,
      y: Number.isFinite(state?.y) ? state.y : 0,
    };
    this.presence.set(clientId, { state: s, lastSeen: Date.now() });
    return s;
  }

  removePresence(clientId) {
    const had = this.presence.delete(clientId);
    return had;
  }

  /** 周期：陈旧 presence 按 TTL 清理（非正常断开） */
  tick(now = Date.now()) {
    const expired = [];
    for (const [id, e] of this.presence) {
      if (now - e.lastSeen > this.ttlMs) {
        this.presence.delete(id);
        expired.push(id);
      }
    }
    this._maybeSnapshot(now);
    return expired;
  }

  _maybeSnapshot(now) {
    if (this._snapshotPending) return;
    if (now - this._lastSnapshot < this.snapshotEveryMs) return;
    this._snapshotPending = true;
    this._lastSnapshot = now;
    const state = serializeDoc(this.doc);
    this.storage.snapshot(state).finally(() => { this._snapshotPending = false; });
  }

  async close() {
    if (this._snapshotPending) {
      await this.storage.snapshot(serializeDoc(this.doc));
    }
    await this.storage.close();
  }
}

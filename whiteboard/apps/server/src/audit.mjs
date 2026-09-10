// audit.mjs — P3-1 审计：内存环形缓冲（供 API 实时查询）+ JSONL 文件（供事后取证，按大小轮转）。
// 与 workbench web 审计同思路：单文件追加、超过上限即改名归档（保留最近 N 个），不做自研压缩。
// 记录内容刻意保持「结构性事实」——谁（连接/IP）、在哪个房间、做了什么、结果如何，不记录画布内容。

import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_DEFAULTS = Object.freeze({
  RING_MAX: 500, // 内存环形缓冲条数（GET /api/rooms/:id/audit 的上限来源）
  FILE_MAX_BYTES: 8 * 1024 * 1024, // 单个 JSONL 文件上限，超过轮转
  KEEP_FILES: 3, // 保留的归档文件数（audit.jsonl.1 ... .N）
  ENABLED: true,
});

/** 事件类型（固定枚举，便于检索与断言） */
export const AUDIT_TYPES = Object.freeze([
  'connect', 'disconnect', 'deny', 'reject', // 连接生命周期
  'ops', 'op_denied', 'presence', // 写入
  'rate_limit', 'policy_close', // 治理
  'room_open', 'room_idle_close', // 房间生命周期
]);

export class AuditLog {
  constructor({ dir = null, config = {}, now = () => Date.now() } = {}) {
    this.cfg = { ...AUDIT_DEFAULTS, ...config };
    this.dir = dir;
    this.now = now;
    this.ring = []; // { ts, type, room, clientId, ip, ... }
    this.filePath = dir ? path.join(dir, 'audit.jsonl') : null;
    this.bytes = 0;
    this.dropped = 0; // 文件不可写时只记在内存，不抛
    if (this.filePath) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.bytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      } catch { this.filePath = null; }
    }
  }

  /** 记录一条审计。返回落地的条目（便于测试断言）。 */
  record(entry) {
    const item = { ts: this.now(), ...entry };
    if (!AUDIT_TYPES.includes(item.type)) item.type = 'unknown';
    this.ring.push(item);
    if (this.ring.length > this.cfg.RING_MAX) this.ring.splice(0, this.ring.length - this.cfg.RING_MAX);
    this._append(item);
    return item;
  }

  _append(item) {
    if (!this.cfg.ENABLED || !this.filePath) return;
    let line;
    try { line = JSON.stringify(item) + '\n'; } catch { this.dropped += 1; return; }
    const size = Buffer.byteLength(line, 'utf8');
    try {
      if (this.bytes + size > this.cfg.FILE_MAX_BYTES) this._rotate();
      fs.appendFileSync(this.filePath, line);
      this.bytes += size;
    } catch { this.dropped += 1; }
  }

  /** 轮转：audit.jsonl → audit.jsonl.1 → … 最多保留 KEEP_FILES 个 */
  _rotate() {
    try {
      for (let i = this.cfg.KEEP_FILES - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
      }
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
      this.bytes = 0;
    } catch { /* 轮转失败不阻塞主流程 */ }
  }

  /** 查询：按房间过滤 + 可选类型 + limit（倒序取最近） */
  query({ room = null, type = null, limit = 100 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 100, this.cfg.RING_MAX));
    const items = this.ring.filter((e) => (room === null || e.room === room) && (type === null || e.type === type));
    return { total: items.length, items: items.slice(-n) };
  }

  /** 全房间汇总计数（供指标） */
  counts() {
    const byType = {};
    for (const e of this.ring) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return { ringSize: this.ring.length, byType, fileDropped: this.dropped, fileBytes: this.bytes };
  }
}

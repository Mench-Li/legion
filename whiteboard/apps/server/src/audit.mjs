// audit.mjs — P3-1 审计：内存环形缓冲（供 API 实时查询）+ JSONL 文件（供事后取证，按大小轮转）。
// 与 workbench web 审计同思路：单文件追加、超过上限即改名归档（保留最近 N 个），不做自研压缩。
// 记录内容刻意保持「结构性事实」——谁（连接/IP）、在哪个房间、做了什么、结果如何，不记录画布内容。
//
// P4-5（候选 #7）：**归档现在可读**。此前 JSONL 只写不读——`query()` 只看内存环形缓冲，
// 于是「事后取证」只能靠人工 parse 文件，而且**进程一重启，API 就再也查不到任何历史**
// （环形缓冲是空的，磁盘上却躺着完整归档）。现在：
//   · 每条记录带进程**跨重启单调递增**的 `auditSeq`（启动时从归档尾部播种）；
//   · `query({ source })` 支持 process（默认，行为不变）/ archive / all；
//   · `retention()` 如实回答「我能回溯多久」（文件、字节、最旧/最新时间、本进程轮转次数）。

import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_DEFAULTS = Object.freeze({
  RING_MAX: 500, // 内存环形缓冲条数（GET /api/rooms/:id/audit 的上限来源）
  FILE_MAX_BYTES: 8 * 1024 * 1024, // 单个 JSONL 文件上限，超过轮转
  KEEP_FILES: 3, // 保留的归档文件数（audit.jsonl.1 ... .N）
  ENABLED: true,
  ARCHIVE_MAX_LIMIT: 1000, // 单次归档查询最多返回条数（防一次请求扫爆全档）
  ARCHIVE_MAX_BYTES: 32 * 1024 * 1024, // 单次归档查询最多读取字节（到上限即停并标 truncated）
  RETENTION_TTL_MS: 2000, // retention() 结果缓存时长（/metrics 会被轮询）
});

/** 事件类型（固定枚举，便于检索与断言） */
export const AUDIT_TYPES = Object.freeze([
  'connect', 'disconnect', 'deny', 'reject', // 连接生命周期
  'ops', 'op_denied', 'presence', // 写入
  'rate_limit', 'policy_close', // 治理
  'room_open', 'room_idle_close', // 房间生命周期
]);

/** 归档查询的取值（HTTP 层据此校验，避免拼错被静默当成默认值） */
export const AUDIT_SOURCES = Object.freeze(['process', 'archive', 'all']);

/**
 * 读文件**开头**至多 maxBytes，返回第一行可解析的 JSON 对象（取最早时间用）。
 * 只读到首个完整行为止；半行/损坏行跳过。
 */
function readHeadItem(file, maxBytes = 4096) {
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return null;
    const len = Math.min(maxBytes, st.size);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, 0);
      for (const line of buf.subarray(0, got).toString('utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const o = JSON.parse(line);
          if (o && typeof o === 'object') return o;
        } catch { /* 损坏/截断行：继续往后找 */ }
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/**
 * 读文件**末尾**至多 maxBytes，返回最后一条可解析的 JSON 对象（取最新时间/播种 auditSeq 用）。
 * 从后往前找第一个可解析行——进程被强杀时最后一行可能是半行，不能因此丢掉整个归档。
 */
function readTailItem(file, maxBytes = 4096) {
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return null;
    const len = Math.min(maxBytes, st.size);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.subarray(0, got).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length === 0) continue;
        try {
          const o = JSON.parse(lines[i]);
          if (o && typeof o === 'object') return o;
        } catch { /* 半行：继续往前找 */ }
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

export class AuditLog {
  constructor({ dir = null, config = {}, now = () => Date.now() } = {}) {
    this.cfg = { ...AUDIT_DEFAULTS, ...config };
    this.dir = dir;
    this.now = now;
    this.ring = []; // { auditSeq, ts, type, room, clientId, ip, ... }
    this.filePath = dir ? path.join(dir, 'audit.jsonl') : null;
    this.bytes = 0;
    this.dropped = 0; // 文件不可写时只记在内存，不抛
    this.rotations = 0; // 本进程发生的轮转次数（= 有多少历史被滚出保留窗口）
    this.auditSeq = 0;
    this._retCache = null;
    if (this.filePath) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.bytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      } catch { this.filePath = null; }
      // auditSeq 跨重启单调：从**最新归档文件**的尾部播种，避免重启后序号回绕
      // （回绕会让「查 seq > N 之后的事件」这类取证用法产生歧义）。
      if (this.filePath) {
        const files = this.archiveFiles();
        const tail = files.length > 0 ? readTailItem(files[files.length - 1].path) : null;
        if (tail && Number.isInteger(tail.auditSeq) && tail.auditSeq > 0) this.auditSeq = tail.auditSeq;
      }
    }
  }

  /** 记录一条审计。返回落地的条目（便于测试断言）。 */
  record(entry) {
    // auditSeq 由服务端**最后**写入：调用方传同名字段也无法覆盖（序号完整性是服务端不变量）
    const item = { ts: this.now(), ...entry, auditSeq: ++this.auditSeq };
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
      this.rotations += 1;
      this._retCache = null; // 归档布局变了，留存读数缓存作废
    } catch { /* 轮转失败不阻塞主流程 */ }
  }

  /** 归档文件列表，**由旧到新**：audit.jsonl.N … audit.jsonl.1 … audit.jsonl */
  archiveFiles() {
    if (!this.filePath) return [];
    const out = [];
    for (let i = this.cfg.KEEP_FILES; i >= 1; i--) {
      const p = `${this.filePath}.${i}`;
      if (fs.existsSync(p)) out.push({ path: p, name: path.basename(p), level: i });
    }
    if (fs.existsSync(this.filePath)) out.push({ path: this.filePath, name: path.basename(this.filePath), level: 0 });
    return out;
  }

  /**
   * 留存事实：**如实回答「我能回溯多久」**，而不只是「我写过多少字节」。
   * 时间跨度取归档里最早/最新一条的 ts（每文件只读首尾各 ≤4KB，不整读）；
   * `rotationsThisProcess` 说明有多少历史已被滚出保留窗口（>0 即「更早的数据已经不在了」）。
   * 结果按 RETENTION_TTL_MS 缓存——`/metrics` 会被轮询，不该每次都去 stat 一堆文件。
   */
  retention({ force = false } = {}) {
    const now = this.now();
    if (!force && this._retCache && now - this._retCache.at < this.cfg.RETENTION_TTL_MS) return this._retCache.value;
    const files = this.archiveFiles().map((f) => {
      let bytes = 0;
      try { bytes = fs.statSync(f.path).size; } catch { /* 读不到按 0 */ }
      const head = readHeadItem(f.path);
      const tail = readTailItem(f.path);
      return {
        name: f.name,
        level: f.level,
        bytes,
        oldestTs: head && typeof head.ts === 'number' ? head.ts : null,
        newestTs: tail && typeof tail.ts === 'number' ? tail.ts : null,
        newestAuditSeq: tail && Number.isInteger(tail.auditSeq) ? tail.auditSeq : null,
      };
    });
    const withOldest = files.filter((f) => f.oldestTs !== null);
    const withNewest = files.filter((f) => f.newestTs !== null);
    const oldestTs = withOldest.length > 0 ? Math.min(...withOldest.map((f) => f.oldestTs)) : null;
    const newestTs = withNewest.length > 0 ? Math.max(...withNewest.map((f) => f.newestTs)) : null;
    const value = {
      enabled: !!this.filePath && this.cfg.ENABLED !== false,
      dir: this.dir,
      files,
      fileCount: files.length,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      oldestTs,
      newestTs,
      spanMs: oldestTs !== null && newestTs !== null ? Math.max(0, newestTs - oldestTs) : 0,
      maxBytesPerFile: this.cfg.FILE_MAX_BYTES,
      keepFiles: this.cfg.KEEP_FILES,
      rotationsThisProcess: this.rotations,
      unwritableDropped: this.dropped,
      /** true = 本进程已轮转过，说明**更早的历史已被滚出保留窗口**（不是「从来没有过」） */
      historyTruncated: this.rotations > 0,
    };
    this._retCache = { at: now, value };
    return value;
  }

  /** 按条件过滤一条归档记录 */
  _match(item, room, type) {
    if (!item || typeof item !== 'object') return false;
    if (room !== null && item.room !== room) return false;
    if (type !== null && item.type !== type) return false;
    return true;
  }

  /**
   * 查询**磁盘归档**（跨重启可用）。语义：返回**最近的** limit 条匹配记录。
   * 从最新文件往前扫，凑够 limit 即停（典型情况只需读当前文件，不必碰 8MB×3 的归档）。
   * `truncated: true` 表示「窗口被 limit/字节上限截断，更早的可能还有」——调用方据此加大 limit，
   * 而不是误以为「这就是全部」。
   */
  queryArchive({ room = null, type = null, limit = 100 } = {}) {
    const want = Math.max(1, Math.min(Number(limit) || 100, this.cfg.ARCHIVE_MAX_LIMIT));
    const files = this.archiveFiles();
    const collected = []; // 新→旧
    let filesRead = 0;
    let scanned = 0;
    let malformed = 0;
    let bytesRead = 0;
    let hitByteCap = false;
    for (let i = files.length - 1; i >= 0; i--) {
      if (collected.length >= want) break;
      if (bytesRead >= this.cfg.ARCHIVE_MAX_BYTES) { hitByteCap = true; break; }
      let text;
      try { text = fs.readFileSync(files[i].path, 'utf8'); } catch { continue; }
      filesRead += 1;
      bytesRead += Buffer.byteLength(text, 'utf8');
      const lines = text.split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j];
        if (line.trim().length === 0) continue;
        scanned += 1;
        let item;
        try { item = JSON.parse(line); } catch { malformed += 1; continue; } // 半行/损坏行：跳过并计数，不中断
        if (!this._match(item, room, type)) continue;
        collected.push(item);
        if (collected.length >= want) break;
      }
    }
    const items = collected.reverse(); // 恢复时间顺序（旧→新），与环形缓冲查询一致
    return {
      total: items.length, // 归档语义下 total = 本次返回条数（真实匹配总数需全档扫描，见 truncated）
      items,
      source: 'archive',
      truncated: items.length >= want || hitByteCap,
      archive: { fileCount: files.length, filesRead, scanned, malformed, bytesRead, byteCapReached: hitByteCap },
    };
  }

  /** 进程内环形缓冲查询（**既有语义不变**）：total = 匹配总数，items = 最近 limit 条 */
  queryRing({ room = null, type = null, limit = 100 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 100, this.cfg.RING_MAX));
    const items = this.ring.filter((e) => this._match(e, room, type));
    return { total: items.length, items: items.slice(-n), source: 'process', truncated: items.length > n };
  }

  /**
   * 合并查询：归档（磁盘，跨重启）+ 环形缓冲（进程内，最新且必落盘）。
   * 去重键优先用 `auditSeq`（服务端写入的单调序号，精确且与内容无关）；
   * 老版本写下的无 `auditSeq` 行退化为按整行 JSON 去重——它们只会出现在升级前的归档里。
   */
  queryAll({ room = null, type = null, limit = 100 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 100, this.cfg.ARCHIVE_MAX_LIMIT));
    const arch = this.queryArchive({ room, type, limit: n });
    const seen = new Set();
    const keyOf = (e) => (Number.isInteger(e.auditSeq) ? 's' + e.auditSeq : 'j' + JSON.stringify(e));
    const merged = [];
    for (const e of arch.items) {
      const k = keyOf(e);
      if (!seen.has(k)) { seen.add(k); merged.push(e); }
    }
    for (const e of this.ring) {
      if (!this._match(e, room, type)) continue;
      const k = keyOf(e);
      if (!seen.has(k)) { seen.add(k); merged.push(e); }
    }
    merged.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.auditSeq ?? 0) - (b.auditSeq ?? 0));
    return {
      total: merged.length,
      items: merged.slice(-n),
      source: 'all',
      truncated: arch.truncated || merged.length > n,
      archive: arch.archive,
    };
  }

  /**
   * 统一入口。`source`：
   *   · `process`（默认，行为与 P3-1 一致）——只看本进程环形缓冲；
   *   · `archive`——只看磁盘归档（**重启后仍可查**）；
   *   · `all`——两者合并去重。
   * 默认保持 `process` 是为了不改变既有调用方的语义与开销；HTTP 响应里永远附 `retention`，
   * 因此即使默认查询为空，调用方也能立刻知道「磁盘上还有多少历史、怎么取」。
   */
  query({ room = null, type = null, limit = 100, source = 'process' } = {}) {
    if (source === 'archive') return this.queryArchive({ room, type, limit });
    if (source === 'all') return this.queryAll({ room, type, limit });
    return this.queryRing({ room, type, limit });
  }

  /** 全房间汇总计数（供指标） */
  counts() {
    const byType = {};
    for (const e of this.ring) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return {
      ringSize: this.ring.length,
      byType,
      fileDropped: this.dropped,
      fileBytes: this.bytes,
      rotations: this.rotations,
      lastAuditSeq: this.auditSeq,
    };
  }
}

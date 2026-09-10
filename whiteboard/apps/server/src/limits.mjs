// limits.mjs — P3-1 连接治理：连接数上限、消息大小与条数上限、消息频率限流。
//
// 全部为**纯逻辑 + 可注入时钟**，不依赖 ws/http，便于逐条单测（与 room.mjs 同风格）。
// 分级处理策略（P3-1 决策）：
//   - 连接数超限 → 升级阶段直接拒绝（HTTP 503，不建立 ws）；
//   - 消息过大 / op 条数过多 / 畸形 → 立即断开（1009 / 1008）：这类客户端不值得继续服务；
//   - 频率超限 → 先丢弃并回一条 warning（`rate_limited`），在窗口内累计「警告次数」超阈值才断开，
//     避免网络抖动导致误伤，同时对持续冲击的客户端仍有刚置。

/** 默认配置（可用环境变量覆盖；集中一处便于文档与测试引用）。 */
export const LIMIT_DEFAULTS = Object.freeze({
  MAX_CONNECTIONS: 200, // 全服连接数上限
  MAX_CONNECTIONS_PER_ROOM: 50, // 单房间连接数上限（对齐 ADR-0005/ADR-0008 的 50 并发 soak 界）
  // 单 IP 上限同样取 50，**不取更小值**：本产品定位单实例自托管，真实用户常来自同一 NAT/公司出口；
  // 初版设为 10 时，仓库自带的 bench（20 客户端同 IP）与同一出口的第 11 个正常用户都会被直接拒。
  MAX_CONNECTIONS_PER_IP: 50,
  MAX_MESSAGE_BYTES: 256 * 1024, // 单条 JSON 消息上限（ws 帧上限另为 1MiB）
  MAX_OPS_PER_MESSAGE: 200, // 单条消息内 op 条数上限
  MESSAGE_RATE_PER_SEC: 120, // 每个连接每秒允许的消息数（令牌桶补充速率）
  MESSAGE_BURST: 240, // 令牌桶容量（允许的瞬时突发）
  RATE_WARN_MIN_INTERVAL_MS: 1000, // 同一连接「频率告警」最小间隔（避免放大攻击面）
  RATE_STRIKES: 20, // 窗口内累计丢弃次数达到此值 → 断开（持续超限才断，抖动不断）
  RATE_STRIKE_WINDOW_MS: 20_000, // 丢弃计数的统计窗口
})

/** 从环境变量/显式配置解析限流配置（缺省用 LIMIT_DEFAULTS）。 */
export function resolveLimitConfig(env = process.env, overrides = {}) {
  const num = (key, fallback) => {
    const raw = env[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    MAX_CONNECTIONS: num('WB_MAX_CONNECTIONS', LIMIT_DEFAULTS.MAX_CONNECTIONS),
    MAX_CONNECTIONS_PER_ROOM: num('WB_MAX_CONNECTIONS_PER_ROOM', LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_ROOM),
    MAX_CONNECTIONS_PER_IP: num('WB_MAX_CONNECTIONS_PER_IP', LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_IP),
    MAX_MESSAGE_BYTES: num('WB_MAX_MESSAGE_BYTES', LIMIT_DEFAULTS.MAX_MESSAGE_BYTES),
    MAX_OPS_PER_MESSAGE: num('WB_MAX_OPS_PER_MESSAGE', LIMIT_DEFAULTS.MAX_OPS_PER_MESSAGE),
    MESSAGE_RATE_PER_SEC: num('WB_MESSAGE_RATE_PER_SEC', LIMIT_DEFAULTS.MESSAGE_RATE_PER_SEC),
    MESSAGE_BURST: num('WB_MESSAGE_BURST', LIMIT_DEFAULTS.MESSAGE_BURST),
    RATE_WARN_MIN_INTERVAL_MS: LIMIT_DEFAULTS.RATE_WARN_MIN_INTERVAL_MS,
    RATE_STRIKES: num('WB_RATE_STRIKES', LIMIT_DEFAULTS.RATE_STRIKES),
    RATE_STRIKE_WINDOW_MS: LIMIT_DEFAULTS.RATE_STRIKE_WINDOW_MS,
    ...overrides,
  };
}

/**
 * 连接数准入：按「全服 / 单房间 / 单 IP」三档计数。
 * acquire() 返回 { ok, reason? }；release(ip, room) 必须与成功的 acquire 配对（否则计数泄漏）。
 */
export class ConnectionLimiter {
  constructor(config = LIMIT_DEFAULTS) {
    this.cfg = { ...LIMIT_DEFAULTS, ...config };
    this.total = 0;
    this.byRoom = new Map();
    this.byIp = new Map();
  }

  /** 只读预检（不改变计数），供测试与指标展示 */
  check(ip, room) {
    if (this.total >= this.cfg.MAX_CONNECTIONS) return { ok: false, reason: 'max_connections' };
    if ((this.byRoom.get(room) ?? 0) >= this.cfg.MAX_CONNECTIONS_PER_ROOM) return { ok: false, reason: 'max_connections_per_room' };
    if ((this.byIp.get(ip) ?? 0) >= this.cfg.MAX_CONNECTIONS_PER_IP) return { ok: false, reason: 'max_connections_per_ip' };
    return { ok: true };
  }

  acquire(ip, room) {
    const pre = this.check(ip, room);
    if (!pre.ok) return pre;
    this.total += 1;
    this.byRoom.set(room, (this.byRoom.get(room) ?? 0) + 1);
    this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1);
    return { ok: true };
  }

  release(ip, room) {
    this.total = Math.max(0, this.total - 1);
    const r = (this.byRoom.get(room) ?? 0) - 1;
    if (r <= 0) this.byRoom.delete(room); else this.byRoom.set(room, r);
    const i = (this.byIp.get(ip) ?? 0) - 1;
    if (i <= 0) this.byIp.delete(ip); else this.byIp.set(ip, i);
  }

  snapshot() {
    return { total: this.total, byRoom: Object.fromEntries(this.byRoom), ipCount: this.byIp.size };
  }
}

/**
 * 每连接消息频率限流（令牌桶）。
 * allow(now) → { ok:true } | { ok:false, retryAfterMs, dropCount, shouldClose }
 * shouldClose 在「窗口内丢弃次数 ≥ RATE_STRIKES」时为 true（分级处理的第二级）。
 */
export class MessageRateLimiter {
  constructor(config = LIMIT_DEFAULTS, now = Date.now()) {
    this.cfg = { ...LIMIT_DEFAULTS, ...config };
    this.tokens = this.cfg.MESSAGE_BURST;
    this.last = now;
    this.dropped = 0;
    this.windowStart = now;
    // -Infinity：让「从未告警」与「恰在 t=0 告警过」可区分——否则 t=0 的超限会被节流静默吞掉
    this.lastWarnAt = Number.NEGATIVE_INFINITY;
  }

  allow(now = Date.now()) {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.cfg.MESSAGE_BURST, this.tokens + elapsed * this.cfg.MESSAGE_RATE_PER_SEC);
    if (now - this.windowStart > this.cfg.RATE_STRIKE_WINDOW_MS) {
      this.windowStart = now;
      this.dropped = 0;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    this.dropped += 1;
    const retryAfterMs = Math.ceil(((1 - this.tokens) / this.cfg.MESSAGE_RATE_PER_SEC) * 1000);
    const warnNow = now - this.lastWarnAt >= this.cfg.RATE_WARN_MIN_INTERVAL_MS;
    if (warnNow) this.lastWarnAt = now;
    return {
      ok: false,
      retryAfterMs,
      dropCount: this.dropped,
      warn: warnNow,
      shouldClose: this.dropped >= this.cfg.RATE_STRIKES,
    };
  }
}

/**
 * 消息级校验（在 JSON.parse 之前/之后各一段）：
 *   checkPayload(text) → 按 UTF-8 字节数判大小；
 *   checkMessage(msg)  → 类型与 op 条数。
 * 返回 { ok:true } 或 { ok:false, code, closeCode, reason }。
 */
export function checkPayload(text, cfg = LIMIT_DEFAULTS) {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
  if (bytes > cfg.MAX_MESSAGE_BYTES) {
    return { ok: false, code: 'message_too_large', closeCode: 1009, bytes, reason: `消息 ${bytes} 字节超过上限 ${cfg.MAX_MESSAGE_BYTES}` };
  }
  return { ok: true, bytes };
}

export function checkMessage(msg, cfg = LIMIT_DEFAULTS) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, code: 'malformed_message', closeCode: 1008, reason: '消息不是对象' };
  }
  if (typeof msg.type !== 'string' || msg.type.length === 0) {
    return { ok: false, code: 'malformed_message', closeCode: 1008, reason: '缺少 type' };
  }
  if (msg.type === 'op') {
    if (!Array.isArray(msg.ops)) {
      return { ok: false, code: 'malformed_message', closeCode: 1008, reason: 'op 消息缺少 ops 数组' };
    }
    if (msg.ops.length > cfg.MAX_OPS_PER_MESSAGE) {
      return { ok: false, code: 'too_many_ops', closeCode: 1008, ops: msg.ops.length, reason: `单条消息 ${msg.ops.length} 个 op 超过上限 ${cfg.MAX_OPS_PER_MESSAGE}` };
    }
  }
  if (msg.type === 'presence' && (msg.state === null || typeof msg.state !== 'object')) {
    return { ok: false, code: 'malformed_message', closeCode: 1008, reason: 'presence 缺少 state' };
  }
  return { ok: true };
}

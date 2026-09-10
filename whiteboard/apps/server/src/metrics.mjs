// metrics.mjs — P3-1 指标：零依赖计数器/仪表盘，供 GET /metrics 暴露。
// 设计：只维护「本进程」的运行时指标（重启归零），数值均为 number/bool/string，可直接 JSON 序列化。

/** 固定计数器键（新增键时同步文档与证据） */
export const COUNTER_KEYS = Object.freeze([
  'connectionsTotal', // 成功建立的 ws 连接数
  'connectionsRejected', // 被拒绝的升级请求数
  'upgradesUnauthorized', // token 不匹配被拒
  'upgradesBadRoom', // 房间 ID 非法被拒
  'messagesIn', // 收到的文本消息数（含被限流丢弃的）
  'messagesOut', // 发出的消息数
  'bytesIn',
  'bytesOut',
  'opsAccepted', // 通过校验并落库的 op
  'opsRejected', // 被 sanitize 过滤掉的 op
  'opsDeniedReadonly', // 只读角色尝试写被拒
  'presenceUpdates',
  'rateLimitDrops', // 因频率超限被丢弃的消息
  'rateLimitCloses', // 因持续超限被断开
  'policyCloses', // 因消息过大/畸形/条数过多被断开
  'roomsOpened', // 房间首次打开（惰性创建存储）
  'roomsClosed', // 房间空闲关闭
  'auditEntries', // 写入审计的条目数
])

export const REJECT_REASONS = Object.freeze([
  'max_connections', 'max_connections_per_room', 'max_connections_per_ip',
  'unauthorized', 'bad_room',
])

export class Metrics {
  constructor() {
    this.counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
    this.rejections = Object.fromEntries(REJECT_REASONS.map((k) => [k, 0]));
    this.closesByCode = new Map(); // ws close code -> count
    this.startedAt = Date.now();
    /** 由 index.js 注入的实时读数（房间数、在线数等），返回纯数据 */
    this.gauges = () => ({});
  }

  inc(key, n = 1) {
    if (!(key in this.counters)) this.counters[key] = 0;
    this.counters[key] += n;
    return this.counters[key];
  }

  reject(reason) {
    this.inc('connectionsRejected');
    if (!(reason in this.rejections)) this.rejections[reason] = 0;
    this.rejections[reason] += 1;
  }

  closeCode(code) {
    const n = (this.closesByCode.get(code) ?? 0) + 1;
    this.closesByCode.set(code, n);
  }

  /** 快照：纯数据，可直接 JSON.stringify */
  snapshot(now = Date.now()) {
    return {
      uptimeMs: now - this.startedAt,
      startedAt: new Date(this.startedAt).toISOString(),
      counters: { ...this.counters },
      connectionsRejectedByReason: { ...this.rejections },
      closesByCode: Object.fromEntries(this.closesByCode),
      ...this.gauges(),
    };
  }
}

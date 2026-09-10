// limits.test.mjs — P3-1 连接治理纯逻辑：连接数准入、频率限流（令牌桶 + 分级断开）、消息校验。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionLimiter, MessageRateLimiter, checkPayload, checkMessage, resolveLimitConfig, LIMIT_DEFAULTS,
} from '../src/limits.mjs';

describe('ConnectionLimiter', () => {
  const cfg = { MAX_CONNECTIONS: 3, MAX_CONNECTIONS_PER_ROOM: 2, MAX_CONNECTIONS_PER_IP: 2 };

  it('三档上限各自生效，且拒绝原因可区分', () => {
    // 单 IP 上限
    const ipLimit = new ConnectionLimiter({ MAX_CONNECTIONS: 10, MAX_CONNECTIONS_PER_ROOM: 10, MAX_CONNECTIONS_PER_IP: 2 });
    assert.deepEqual(ipLimit.acquire('10.0.0.1', 'a'), { ok: true });
    assert.deepEqual(ipLimit.acquire('10.0.0.1', 'b'), { ok: true });
    assert.deepEqual(ipLimit.acquire('10.0.0.1', 'c'), { ok: false, reason: 'max_connections_per_ip' });

    // 单房间上限（换 IP 也拦）
    const roomLimit = new ConnectionLimiter({ MAX_CONNECTIONS: 10, MAX_CONNECTIONS_PER_ROOM: 2, MAX_CONNECTIONS_PER_IP: 10 });
    assert.deepEqual(roomLimit.acquire('10.0.0.1', 'a'), { ok: true });
    assert.deepEqual(roomLimit.acquire('10.0.0.2', 'a'), { ok: true });
    assert.deepEqual(roomLimit.acquire('10.0.0.3', 'a'), { ok: false, reason: 'max_connections_per_room' });
    assert.deepEqual(roomLimit.acquire('10.0.0.3', 'b'), { ok: true });

    // 全局上限（新 IP 新房间也拦）
    const globalLimit = new ConnectionLimiter({ MAX_CONNECTIONS: 2, MAX_CONNECTIONS_PER_ROOM: 10, MAX_CONNECTIONS_PER_IP: 10 });
    assert.deepEqual(globalLimit.acquire('10.0.0.1', 'a'), { ok: true });
    assert.deepEqual(globalLimit.acquire('10.0.0.2', 'b'), { ok: true });
    assert.deepEqual(globalLimit.acquire('10.0.0.3', 'c'), { ok: false, reason: 'max_connections' });
  });

  it('多档同时超限时按 全局 → 房间 → 单IP 的优先级报因（锁定判定顺序）', () => {
    const l = new ConnectionLimiter({ MAX_CONNECTIONS: 1, MAX_CONNECTIONS_PER_ROOM: 1, MAX_CONNECTIONS_PER_IP: 1 });
    l.acquire('10.0.0.1', 'a');
    assert.equal(l.acquire('10.0.0.1', 'a').reason, 'max_connections', '三档都超时优先报全局');
    const l2 = new ConnectionLimiter({ MAX_CONNECTIONS: 5, MAX_CONNECTIONS_PER_ROOM: 1, MAX_CONNECTIONS_PER_IP: 1 });
    l2.acquire('10.0.0.1', 'a');
    assert.equal(l2.acquire('10.0.0.1', 'a').reason, 'max_connections_per_room', '房间与 IP 都超时优先报房间');
  });

  it('释放后可重新准入，计数不泄漏', () => {
    const l = new ConnectionLimiter(cfg);
    l.acquire('10.0.0.1', 'a');
    l.acquire('10.0.0.1', 'b');
    l.release('10.0.0.1', 'a');
    l.release('10.0.0.1', 'b');
    const snap = l.snapshot();
    assert.equal(snap.total, 0);
    assert.deepEqual(snap.byRoom, {});
    assert.equal(l.acquire('10.0.0.9', 'z').ok, true);
  });

  it('check 为只读预检：不改变计数', () => {
    const l = new ConnectionLimiter(cfg);
    assert.equal(l.check('1.1.1.1', 'r').ok, true);
    assert.equal(l.snapshot().total, 0);
  });

  it('环境变量覆盖默认值，非法值回落默认', () => {
    const r = resolveLimitConfig({ WB_MAX_CONNECTIONS: '7', WB_MESSAGE_BURST: 'abc' });
    assert.equal(r.MAX_CONNECTIONS, 7);
    assert.equal(r.MESSAGE_BURST, LIMIT_DEFAULTS.MESSAGE_BURST);
  });

  it('默认值必须容得下产品自身的并发承诺（回归：初版单 IP=10 会拒掉 bench 与同 NAT 用户）', () => {
    // 依据 ADR-0005/ADR-0008：单实例以 50 并发 soak 为界
    assert.ok(LIMIT_DEFAULTS.MAX_CONNECTIONS >= 50, '全局上限应 ≥ 50 并发承诺');
    assert.ok(LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_ROOM >= 50, '单房间上限应 ≥ 50 并发承诺');
    assert.ok(LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_IP >= 50, '单 IP 上限应 ≥ 50：同一 NAT 出口的合法用户不得被误拒');
    assert.ok(LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_IP >= LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_ROOM,
      '单 IP 上限不应小于单房间上限（否则「同一出口的多位用户」先于「房间满」被拒）');
    assert.ok(LIMIT_DEFAULTS.MAX_CONNECTIONS >= LIMIT_DEFAULTS.MAX_CONNECTIONS_PER_ROOM);
  });

  it('默认配置下 20 个同 IP 连接全部可准入（对齐仓库 bench 的 20 客户端）', () => {
    const l = new ConnectionLimiter(LIMIT_DEFAULTS);
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(l.acquire('127.0.0.1', 'default'), { ok: true }, `第 ${i + 1} 个连接应被接纳`);
    }
    assert.equal(l.snapshot().total, 20);
  });
});

describe('MessageRateLimiter', () => {
  const cfg = { MESSAGE_RATE_PER_SEC: 10, MESSAGE_BURST: 3, RATE_STRIKES: 2, RATE_STRIKE_WINDOW_MS: 1000, RATE_WARN_MIN_INTERVAL_MS: 100 };

  it('突发容量内放行，超出即丢弃并附重试提示', () => {
    const r = new MessageRateLimiter(cfg, 0);
    for (let i = 0; i < 3; i++) assert.equal(r.allow(0).ok, true, `第 ${i + 1} 条应放行`);
    const denied = r.allow(0);
    assert.equal(denied.ok, false);
    assert.ok(denied.retryAfterMs >= 100, `retryAfterMs=${denied.retryAfterMs}`);
    assert.equal(denied.shouldClose, false, '首次丢弃不应断开');
  });

  it('按速率补充令牌：等待后有额度', () => {
    const r = new MessageRateLimiter(cfg, 0);
    for (let i = 0; i < 3; i++) r.allow(0);
    assert.equal(r.allow(0).ok, false);
    assert.equal(r.allow(100).ok, true, '100ms @10/s → 补 1 个令牌');
  });

  it('持续超限达到阈值才建议断开（抖动不断）', () => {
    const r = new MessageRateLimiter(cfg, 0);
    for (let i = 0; i < 3; i++) r.allow(0);
    const d1 = r.allow(0);
    const d2 = r.allow(0);
    assert.equal(d1.shouldClose, false);
    assert.equal(d2.shouldClose, true, '窗口内第 2 次丢弃（RATE_STRIKES=2）→ 断开');
    assert.equal(d2.dropCount, 2);
  });

  it('告警按最小间隔节流（不放大攻击面）', () => {
    const r = new MessageRateLimiter(cfg, 0);
    for (let i = 0; i < 3; i++) r.allow(0);
    const d1 = r.allow(0);
    const d2 = r.allow(0);
    assert.equal(d1.warn, true);
    assert.equal(d2.warn, false, '100ms 内的第二条丢弃不再告警');
  });

  it('跨窗口后丢弃计数归零（历史超限不累积成永久封禁）', () => {
    const r = new MessageRateLimiter(cfg, 0);
    for (let i = 0; i < 3; i++) r.allow(0);
    assert.equal(r.allow(0).dropCount, 1);
    assert.equal(r.allow(0).dropCount, 2);
    // 越过统计窗口：令牌补满，放行恢复正常
    const later = r.allow(2000);
    assert.equal(later.ok, true);
    r.allow(2000);
    r.allow(2000);
    const drop = r.allow(2000);
    assert.equal(drop.dropCount, 1, '新窗口重新计数');
    assert.equal(drop.shouldClose, false, '旧窗口的丢弃不得导致本次断开');
  });
});

describe('消息级校验', () => {
  it('按 UTF-8 字节数判大小（中文逐字 3 字节）', () => {
    const cfg = { MAX_MESSAGE_BYTES: 10 };
    assert.equal(checkPayload('1234567890', cfg).ok, true);
    const big = checkPayload('中文中文', cfg); // 12 字节
    assert.equal(big.ok, false);
    assert.equal(big.code, 'message_too_large');
    assert.equal(big.closeCode, 1009);
  });

  it('畸形消息 / 缺 type 被拒（1008）', () => {
    for (const bad of [null, 'x', 42, [], {}]) {
      const v = checkMessage(bad, LIMIT_DEFAULTS);
      assert.equal(v.ok, false, `${JSON.stringify(bad)} 应被拒`);
      assert.equal(v.closeCode, 1008);
    }
  });

  it('op 条数上限与 ops 数组缺失分别报错', () => {
    assert.equal(checkMessage({ type: 'op', ops: 'x' }, LIMIT_DEFAULTS).code, 'malformed_message');
    const v = checkMessage({ type: 'op', ops: new Array(201).fill({}) }, LIMIT_DEFAULTS);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'too_many_ops');
    assert.equal(v.ops, 201);
    assert.equal(checkMessage({ type: 'op', ops: [] }, LIMIT_DEFAULTS).ok, true);
  });

  it('presence 必须带 state 对象', () => {
    assert.equal(checkMessage({ type: 'presence', state: null }, LIMIT_DEFAULTS).ok, false);
    assert.equal(checkMessage({ type: 'presence', state: { x: 1 } }, LIMIT_DEFAULTS).ok, true);
  });

  it('未知 type 透传（向后兼容既有客户端）', () => {
    assert.equal(checkMessage({ type: 'whatever' }, LIMIT_DEFAULTS).ok, true);
  });
});

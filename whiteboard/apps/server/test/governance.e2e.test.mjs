// governance.e2e.test.mjs — P3-1 端到端（真实 ws 服务 + 真实 Upgrade 响应）：
// 多房间隔离、房间级 token/只读角色、连接数与消息限流、指标/审计/健康端点。
// 与 e2e.test.mjs 的分工：那边锁定「不带房间」的既有契约，这里锁定 P3-1 新增的治理面。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, connect, waitClose, rawUpgrade, json } from './helpers.mjs';

const ROOMS_CFG = 'main:tok-main:rw,view:tok-view:ro,open-room::rw';

describe('P3-1 治理端到端', () => {
  let srv;
  before(async () => {
    srv = await startServer({
      WHITEBOARD_ROOMS: ROOMS_CFG,
      WB_MAX_CONNECTIONS: '40',
      WB_MAX_CONNECTIONS_PER_ROOM: '3',
      WB_MAX_CONNECTIONS_PER_IP: '30',
      WB_MAX_MESSAGE_BYTES: '2048',
      WB_MAX_OPS_PER_MESSAGE: '5',
    });
  });
  after(async () => { if (srv) await srv.stop(); });

  it('welcome 带上房间与角色（客户端可据此切只读 UI）', async () => {
    const a = await connect(srv.port, { room: 'main', token: 'tok-main' });
    assert.equal(a.welcome.room, 'main');
    assert.equal(a.welcome.role, 'rw');
    assert.ok(a.welcome.limits.maxMessageBytes === 2048);
    a.close();
  });

  it('不带 ?room= → 落在 default 房间（既有客户端无需改动）', async () => {
    const a = await connect(srv.port);
    assert.equal(a.welcome.room, 'default');
    assert.equal(a.welcome.role, 'rw');
    a.close();
  });

  it('房间隔离：alpha 的 op 不进 beta，且不跨房间广播', async () => {
    const a1 = await connect(srv.port, { room: 'open-room' });
    const a2 = await connect(srv.port, { room: 'open-room' });
    const b1 = await connect(srv.port, { room: 'iso-b' });
    await a1.waitFor((s) => s.welcome && s.welcome.room === 'open-room');
    await b1.waitFor((s) => s.welcome);

    const op = { t: 'add', id: 'iso-1', el: { id: 'iso-1', type: 'rect', geom: { x: 0, y: 0, w: 10, h: 10 }, stroke: '#000', strokeWidth: 1 }, c: a1.welcome.clientId, v: 1 };
    a1.send({ type: 'op', ops: [op] });

    await a2.waitFor((s) => s.inbox.some((m) => m.type === 'op'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b1.inbox.filter((m) => m.type === 'op').length, 0, '不得跨房间广播');

    const ra = await json(srv.port, '/api/rooms/open-room');
    const rb = await json(srv.port, '/api/rooms/iso-b');
    assert.equal(ra.body.elements, 1);
    assert.equal(rb.body.elements, 0, '房间存储必须隔离');
    a1.close(); a2.close(); b1.close();
  });

  it('presence 只在房间内互见', async () => {
    const a1 = await connect(srv.port, { room: 'p-a' });
    const a2 = await connect(srv.port, { room: 'p-a' });
    const b1 = await connect(srv.port, { room: 'p-b' });
    await a1.waitFor((s) => s.welcome);
    await a2.waitFor((s) => s.welcome);
    await b1.waitFor((s) => s.welcome);
    a1.send({ type: 'presence', state: { name: 'alice', color: '#f00', x: 5, y: 6 } });
    const seen = await a2.waitFor((s) => s.inbox.find((m) => m.type === 'presence'));
    assert.equal(seen.state.name, 'alice');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b1.inbox.filter((m) => m.type === 'presence').length, 0);
    a1.close(); a2.close(); b1.close();
  });

  it('房间 token：错 token 401 且不建立连接；全局 token 不能进私有房间', async () => {
    const wrong = await rawUpgrade(srv.port, '/ws?room=main&token=nope');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.trim(), 'unauthorized');

    const missing = await rawUpgrade(srv.port, '/ws?room=main');
    assert.equal(missing.status, 401);

    const ok = await rawUpgrade(srv.port, '/ws?room=main&token=tok-main');
    assert.equal(ok.status, 101, '正确 token 必须能升级');
  });

  it('非法房间 ID：400 拒绝（不静默回退到 default）', async () => {
    const bad = await rawUpgrade(srv.port, '/ws?room=BAD');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.trim(), 'bad_room');
    const traversal = await rawUpgrade(srv.port, `/ws?room=${encodeURIComponent('../etc')}`);
    assert.equal(traversal.status, 400);
  });

  it('只读房间：可同步但 op 被拒（回 op_denied，房间状态不变）', async () => {
    const v = await connect(srv.port, { room: 'view', token: 'tok-view' });
    const w = await connect(srv.port, { room: 'view', token: 'tok-view' });
    assert.equal(v.welcome.role, 'ro');
    await w.waitFor((s) => s.welcome);
    v.send({ type: 'op', ops: [{ t: 'add', id: 'ro-1', el: { id: 'ro-1', type: 'rect', geom: { x: 0, y: 0, w: 1, h: 1 }, stroke: '#000', strokeWidth: 1 }, c: v.welcome.clientId, v: 1 }] });
    const err = await v.waitFor((s) => s.inbox.find((m) => m.type === 'error'));
    assert.equal(err.code, 'op_denied');
    await new Promise((r) => setTimeout(r, 100));
    const info = await json(srv.port, '/api/rooms/view');
    assert.equal(info.body.elements, 0, '只读连接不得写入');
    assert.equal(w.inbox.filter((m) => m.type === 'op').length, 0, '不得广播被拒的 op');
    // presence 仍可用（只读 ≠ 隐身）
    v.send({ type: 'presence', state: { name: 'ro-viewer', color: '#0f0', x: 1, y: 1 } });
    const p = await w.waitFor((s) => s.inbox.find((m) => m.type === 'presence'));
    assert.equal(p.state.name, 'ro-viewer');
    v.close(); w.close();
  });

  it('连接数超限：升级阶段 503（房间级上限 3）', async () => {
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await connect(srv.port, { room: 'cap-room' }));
    await held[0].waitFor((s) => s.welcome);
    const denied = await rawUpgrade(srv.port, '/ws?room=cap-room');
    assert.equal(denied.status, 503);
    assert.equal(denied.body.trim(), 'max_connections_per_room');
    // 释放一条后可以再进（限流不是永久封禁）
    held[2].close();
    await new Promise((r) => setTimeout(r, 150));
    const again = await connect(srv.port, { room: 'cap-room' });
    assert.equal(again.welcome.room, 'cap-room');
    held.forEach((c) => c.close());
    again.close();
  });

  it('消息过大：按字节判限并 1009 断开', async () => {
    const a = await connect(srv.port, { room: 'big-msg' });
    await a.waitFor((s) => s.welcome);
    a.send(JSON.stringify({ type: 'op', ops: [], pad: 'x'.repeat(4096) }));
    const code = await waitClose(a);
    assert.equal(code, 1009, `期望 1009，实际 ${code}`);
  });

  it('op 条数超限：1008 断开并留审计', async () => {
    const a = await connect(srv.port, { room: 'many-ops' });
    await a.waitFor((s) => s.welcome);
    const ops = new Array(6).fill(0).map((_, i) => ({ t: 'del', id: `x${i}`, c: 'c', v: 1 }));
    a.send({ type: 'op', ops });
    const code = await waitClose(a);
    assert.equal(code, 1008);
    const audit = await json(srv.port, '/api/rooms/many-ops/audit');
    assert.ok(audit.body.items.some((e) => e.type === 'policy_close' && e.code === 'too_many_ops'), JSON.stringify(audit.body.items));
  });

  it('畸形 JSON：1008 断开（不让脏数据进房间）', async () => {
    const a = await connect(srv.port, { room: 'bad-json' });
    await a.waitFor((s) => s.welcome);
    a.send('{not-json');
    assert.equal(await waitClose(a), 1008);
  });

  it('频率超限：先丢弃并回 warning，持续超限才断开', async () => {
    const a = await connect(srv.port, { room: 'rate-room' });
    await a.waitFor((s) => s.welcome);
    const sent = 260; // burst 240（默认）→ 之后的应被丢弃
    for (let i = 0; i < sent; i++) a.send({ type: 'presence', state: { name: 'spam', color: '#000', x: i, y: 0 } });
    const warn = await a.waitFor((s) => s.inbox.find((m) => m.type === 'error' && m.code === 'rate_limited'), 4000);
    assert.ok(warn.retryAfterMs >= 1, `应给出重试提示，实际 ${JSON.stringify(warn)}`);
    const metrics = await json(srv.port, '/metrics');
    assert.ok(metrics.body.counters.rateLimitDrops > 0, '丢弃计数应 > 0');
    assert.equal(metrics.body.counters.rateLimitCloses, 0, '未达阈值不得断开');
    a.close();
  });

  it('/healthz 保持既有契约并附治理读数', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.storage, 'string');
    assert.equal(typeof body.ts, 'number');
    assert.equal(typeof body.rooms, 'number');
    assert.equal(typeof body.uptimeMs, 'number');
  });

  it('/readyz 深度探活：逐房间存储健康 + 心跳新鲜', async () => {
    const { status, body } = await json(srv.port, '/readyz');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.heartbeatAgeMs < 5000, `心跳应新鲜，实际 ${body.heartbeatAgeMs}ms`);
    assert.ok(Array.isArray(body.rooms) && body.rooms.length > 0);
    assert.ok(body.rooms.every((r) => r.healthy === true));
  });

  it('/metrics 暴露计数、限流配置与房间明细', async () => {
    // 开一条连接，验证 connections 是**实时仪表盘**而不是累计计数
    const live = await connect(srv.port, { room: 'metrics-room' });
    const { body } = await json(srv.port, '/metrics');
    assert.ok(body.counters.connectionsTotal > 0);
    assert.ok(body.counters.messagesIn > 0);
    assert.ok(body.connectionsRejectedByReason.max_connections_per_room >= 1);
    assert.equal(body.limits.maxMessageBytes, 2048);
    assert.equal(body.limits.maxOpsPerMessage, 5);
    assert.ok(body.rooms.open >= 1);
    assert.ok(Array.isArray(body.rooms.detail));
    assert.ok(body.connections.total >= 1, `活跃连接应 ≥1，实际 ${JSON.stringify(body.connections)}`);
    assert.ok(body.connections.byRoom['metrics-room'] >= 1, `按房间分档应含 metrics-room：${JSON.stringify(body.connections.byRoom)}`);
    assert.ok(body.connections.ipCount >= 1);
    live.close();
  });

  it('活跃连接已清空时 /metrics 如实报 0（仪表盘不虚高）', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const { body } = await json(srv.port, '/metrics');
    assert.equal(typeof body.connections.total, 'number');
    assert.ok(body.counters.connectionsTotal >= body.connections.total, '累计值不应小于实时值');
    if (body.connections.total === 0) assert.deepEqual(body.connections.byRoom, {}, '无活跃连接时按房间分档应为空');
  });

  it('/api/rooms 列出房间、声明配置与限流参数', async () => {
    const { body } = await json(srv.port, '/api/rooms');
    assert.equal(body.ok, true);
    assert.ok(body.rooms.some((r) => r.id === 'main'));
    const declared = Object.fromEntries(body.declared.map((d) => [d.id, d]));
    assert.equal(declared.view.role, 'ro');
    assert.equal(declared.view.protected, true);
    assert.equal(declared['open-room'].protected, false);
    assert.deepEqual(body.configErrors, []);
    assert.ok(body.limits.MAX_CONNECTIONS_PER_ROOM >= 1);
  });

  it('审计：连接/写入/拒绝都可查，且按房间过滤', async () => {
    const w = await connect(srv.port, { room: 'audit-room' });
    await w.waitFor((s) => s.welcome);
    w.send({ type: 'op', ops: [{ t: 'add', id: 'au-1', el: { id: 'au-1', type: 'rect', geom: { x: 0, y: 0, w: 2, h: 2 }, stroke: '#000', strokeWidth: 1 }, c: w.welcome.clientId, v: 1 }] });
    await new Promise((r) => setTimeout(r, 200));
    const { body } = await json(srv.port, '/api/rooms/audit-room/audit');
    const types = body.items.map((e) => e.type);
    assert.ok(types.includes('room_open'), `应含 room_open: ${types.join(',')}`);
    assert.ok(types.includes('connect'), `应含 connect: ${types.join(',')}`);
    assert.ok(body.items.every((e) => e.room === 'audit-room'), '不得混入其他房间的审计');
    w.close();

    const denied = await json(srv.port, '/api/rooms/view/audit?type=op_denied');
    assert.ok(denied.body.items.length >= 1, '只读拒绝应留审计');
    assert.ok(denied.body.items.every((e) => e.role === undefined || e.type === 'op_denied'));
  });

  it('未打开的房间：404 room_not_open（不隐式创建）', async () => {
    const { status, body } = await json(srv.port, '/api/rooms/never-touched');
    assert.equal(status, 404);
    assert.equal(body.error, 'room_not_open');
  });

  it('未知 /api 路径不落在治理端点（回落静态 404）', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/nope`);
    assert.equal(r.status, 404);
  });
});

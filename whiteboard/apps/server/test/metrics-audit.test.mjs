// metrics-audit.test.mjs — P3-1 可观测性：指标计数器/仪表盘快照 + 审计环形缓冲与 JSONL 轮转。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Metrics, COUNTER_KEYS, REJECT_REASONS } from '../src/metrics.mjs';
import { AuditLog, AUDIT_TYPES, AUDIT_DEFAULTS } from '../src/audit.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-audit-'));
}

describe('Metrics', () => {
  it('计数器可累加，snapshot 为纯数据（可 JSON 序列化）', () => {
    const m = new Metrics();
    m.inc('connectionsTotal');
    m.inc('opsAccepted', 3);
    m.inc('messagesIn', 5);
    const snap = m.snapshot();
    assert.equal(snap.counters.connectionsTotal, 1);
    assert.equal(snap.counters.opsAccepted, 3);
    assert.equal(snap.counters.messagesIn, 5);
    assert.ok(snap.uptimeMs >= 0);
    assert.ok(snap.startedAt.endsWith('Z'));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)), '指标必须可 JSON 序列化');
  });

  it('初始状态：全部已知计数器为 0（防止新增指标漏初始化）', () => {
    const snap = new Metrics().snapshot();
    for (const k of COUNTER_KEYS) assert.equal(snap.counters[k], 0, `${k} 未初始化`);
    for (const r of REJECT_REASONS) assert.equal(snap.connectionsRejectedByReason[r], 0, `${r} 未初始化`);
  });

  it('拒绝原因分别计数 + 汇总计数', () => {
    const m = new Metrics();
    m.reject('max_connections');
    m.reject('max_connections');
    m.reject('unauthorized');
    const snap = m.snapshot();
    assert.equal(snap.connectionsRejectedByReason.max_connections, 2);
    assert.equal(snap.connectionsRejectedByReason.unauthorized, 1);
    assert.equal(snap.counters.connectionsRejected, 3);
  });

  it('关闭码分布统计', () => {
    const m = new Metrics();
    m.closeCode(1008);
    m.closeCode(1008);
    m.closeCode(1009);
    assert.deepEqual(m.snapshot().closesByCode, { 1008: 2, 1009: 1 });
  });

  it('gauges 注入实时读数并合并进快照', () => {
    const m = new Metrics();
    m.gauges = () => ({ rooms: { open: 2 }, peers: 7 });
    const snap = m.snapshot();
    assert.equal(snap.rooms.open, 2);
    assert.equal(snap.peers, 7);
    assert.equal(snap.counters.connectionsTotal, 0, '仪表盘与计数器共存');
  });
});

describe('AuditLog', () => {
  it('环形缓冲：按房间与类型过滤，limit 截断最近 N 条', () => {
    const a = new AuditLog();
    a.record({ type: 'connect', room: 'alpha', clientId: 'c1' });
    a.record({ type: 'ops', room: 'alpha', clientId: 'c1', count: 2 });
    a.record({ type: 'connect', room: 'beta', clientId: 'c2' });
    assert.equal(a.query({ room: 'alpha' }).total, 2);
    assert.equal(a.query({ room: 'beta' }).total, 1);
    assert.equal(a.query({ type: 'connect' }).total, 2);
    assert.equal(a.query({ room: 'alpha', type: 'ops' }).total, 1);
    const recent = a.query({ limit: 1 });
    assert.equal(recent.items.length, 1);
    assert.equal(recent.items[0].room, 'beta', 'limit 取最近');
  });

  it('未知类型归一为 unknown（不让脏类型污染检索）', () => {
    const a = new AuditLog();
    const item = a.record({ type: 'not-a-real-type', room: 'alpha' });
    assert.equal(item.type, 'unknown');
    assert.equal(a.query({ type: 'unknown' }).total, 1);
  });

  it('记录带时间戳，且全部类型都在白名单内（防止文档与实现漂移）', () => {
    const a = new AuditLog({ now: () => 12345 });
    for (const t of AUDIT_TYPES) a.record({ type: t, room: 'r' });
    assert.equal(a.ring.length, AUDIT_TYPES.length);
    assert.ok(a.ring.every((e) => e.ts === 12345));
    assert.ok(!AUDIT_TYPES.includes('unknown'), 'unknown 是兜底值，不应列入白名单');
  });

  it('环形缓冲上限：超出丢弃最旧', () => {
    const a = new AuditLog({ config: { RING_MAX: 3 } });
    for (let i = 0; i < 5; i++) a.record({ type: 'connect', room: 'r', seq: i });
    assert.equal(a.ring.length, 3);
    assert.deepEqual(a.ring.map((e) => e.seq), [2, 3, 4]);
    assert.equal(a.query({ limit: 999 }).items.length, 3, 'limit 受环形缓冲上限约束');
  });

  it('JSONL 落盘：写入指定目录并可读回（含已存在文件的字节续算）', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir });
    a.record({ type: 'connect', room: 'alpha', clientId: 'c1', ip: '127.0.0.1' });
    a.record({ type: 'ops', room: 'alpha', count: 1 });
    const file = path.join(dir, 'audit.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, 'connect');
    assert.equal(lines[0].room, 'alpha');
    assert.equal(lines[1].count, 1);
    assert.ok(a.counts().fileBytes > 0);

    // 追加式：新实例应续算已有字节而不清空
    const b = new AuditLog({ dir });
    b.record({ type: 'disconnect', room: 'alpha', clientId: 'c1' });
    const lines2 = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines2.length, 3, '既有审计行不被覆盖');
  });

  it('文件超过上限时轮转归档，且保留 KEEP_FILES 个', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir, config: { FILE_MAX_BYTES: 200, KEEP_FILES: 2 } });
    for (let i = 0; i < 40; i++) a.record({ type: 'ops', room: 'alpha', seq: i, pad: 'x'.repeat(40) });
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.includes('audit.jsonl'), `实际文件: ${files.join(',')}`);
    assert.ok(files.includes('audit.jsonl.1'), `实际文件: ${files.join(',')}`);
    assert.ok(!files.includes('audit.jsonl.3'), '不应保留超过 KEEP_FILES 个归档');
    // 归档里必须是完整 JSON 行（轮转不得截断记录）
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')) {
        if (!line) continue;
        assert.doesNotThrow(() => JSON.parse(line), `${f} 中断行不是完整 JSON`);
      }
    }
  });

  it('未指定目录：只进环形缓冲，不落盘也不抛错', () => {
    const a = new AuditLog();
    assert.doesNotThrow(() => a.record({ type: 'connect', room: 'r' }));
    assert.equal(a.filePath, null);
    assert.equal(a.counts().fileBytes, 0);
  });

  it('默认上限合理（文档与实现一致）', () => {
    assert.equal(AUDIT_DEFAULTS.RING_MAX, 500);
    assert.ok(AUDIT_DEFAULTS.KEEP_FILES >= 1);
  });
});

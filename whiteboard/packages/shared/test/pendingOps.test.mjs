// pendingOps.test.mjs — 待发队列的语义单测（候选 #10 / P4-3）。
//
// 这些语义是「不丢用户东西」的全部依据，所以逐条锁死：FIFO 顺序、有界丢弃最旧、drain/clear 的区别、
// 以及补发必须按服务端单条消息上限分块（超限会被服务端以 1008 关连接，而不是拒一条消息）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingOps, chunkOps, sendInChunks, MAX_PENDING_OPS } from '../src/pendingOps.mjs';

describe('P4-3 · 断线窗口待发队列（纯函数）', () => {
  it('默认有界且为空队列的初始状态一致', () => {
    const q = createPendingOps();
    assert.equal(q.size, 0);
    assert.equal(q.max, MAX_PENDING_OPS);
    assert.deepEqual(q.drain(), []);
  });

  it('push 保持 FIFO 顺序（补发顺序 = 用户操作顺序，CRDT 语义依赖它）', () => {
    const q = createPendingOps();
    q.push([{ id: 'a' }]);
    q.push([{ id: 'b' }, { id: 'c' }]);
    assert.equal(q.size, 3);
    assert.deepEqual(q.drain().map((o) => o.id), ['a', 'b', 'c']);
    assert.equal(q.size, 0, 'drain 必须清空（否则会重复补发）');
  });

  it('drain 取出的是**同一批对象**且清空后再次 drain 为空（不重复发送）', () => {
    const q = createPendingOps();
    const op = { id: 'x' };
    q.push([op]);
    const first = q.drain();
    assert.equal(first[0], op, '应原样取出，不做拷贝/改写（op 的 stamp 必须保持）');
    assert.deepEqual(q.drain(), []);
  });

  it('超过上限丢**最旧**的，并如实报告丢弃条数（最近的意图更值钱）', () => {
    const q = createPendingOps({ max: 3 });
    const r1 = q.push([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.deepEqual(r1, { size: 3, dropped: 0 });
    const r2 = q.push([{ id: 'd' }, { id: 'e' }]);
    assert.deepEqual(r2, { size: 3, dropped: 2 }, '应报告丢弃了 2 条');
    assert.deepEqual(q.drain().map((o) => o.id), ['c', 'd', 'e'], '留下的必须是最新的 3 条');
  });

  it('一次 push 超过上限自身时也只保留最后 max 条', () => {
    const q = createPendingOps({ max: 2 });
    const r = q.push([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    assert.deepEqual(r, { size: 2, dropped: 2 });
    assert.deepEqual(q.drain().map((o) => o.id), ['c', 'd']);
  });

  it('clear 返回被丢弃条数（切房间时用于如实提示，而不是静默清空）', () => {
    const q = createPendingOps();
    q.push([{ id: 'a' }, { id: 'b' }]);
    assert.equal(q.clear(), 2);
    assert.equal(q.size, 0);
    assert.equal(q.clear(), 0, '空队列 clear 返回 0（调用方据此不提示）');
  });

  it('非法参数退化到安全语义（max<=0 / 非数字 → 用默认上限；push 非数组 → 忽略）', () => {
    const q0 = createPendingOps({ max: 0 });
    assert.equal(q0.max, MAX_PENDING_OPS);
    const q1 = createPendingOps({ max: Number.NaN });
    assert.equal(q1.max, MAX_PENDING_OPS);
    const q = createPendingOps({ max: 2 });
    assert.deepEqual(q.push(null), { size: 0, dropped: 0 });
    assert.deepEqual(q.push(undefined), { size: 0, dropped: 0 });
  });
});

describe('P4-3 · 补发分块（服务端单条消息上限是硬门槛）', () => {
  it('按上限切块且不丢不重', () => {
    const ops = Array.from({ length: 7 }, (_, i) => ({ id: 'op-' + i }));
    const parts = chunkOps(ops, 3);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts.map((p) => p.length), [3, 3, 1]);
    assert.deepEqual(parts.flat().map((o) => o.id), ops.map((o) => o.id), '拼回来必须与输入一致');
  });

  it('上限 >= 长度时只发一块；空输入不发（避免空 op 消息被服务端当畸形消息）', () => {
    assert.deepEqual(chunkOps([{ id: 'a' }], 200).map((p) => p.length), [1]);
    assert.deepEqual(chunkOps([], 200), []);
  });

  it('上限非法/缺失时整块返回（不静默丢任何一条）', () => {
    const ops = [{ id: 'a' }, { id: 'b' }];
    assert.deepEqual(chunkOps(ops, 0).map((p) => p.length), [2]);
    assert.deepEqual(chunkOps(ops, Number.NaN).map((p) => p.length), [2]);
    assert.deepEqual(chunkOps(ops, undefined).map((p) => p.length), [2]);
    assert.deepEqual(chunkOps(null, 2), []);
  });

  it('切块返回的是**浅拷贝切片**：改写切片不影响原数组', () => {
    const ops = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const parts = chunkOps(ops, 2);
    parts[0].push({ id: 'injected' });
    assert.equal(ops.length, 3);
  });
});

describe('P4-3 · 补发的成功回报与未发送部分的回队（真实竞态）', () => {
  it('全部写成功：sent 是全部、remaining 为空', () => {
    const ops = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const chunks = [];
    const r = sendInChunks(ops, 2, (part) => { chunks.push(part.map((o) => o.id)); return true; });
    assert.deepEqual(chunks, [['a', 'b'], ['c']]);
    assert.deepEqual(r.sent.map((o) => o.id), ['a', 'b', 'c']);
    assert.deepEqual(r.remaining, []);
    assert.equal(r.failedChunkSize, 0);
  });

  it('**第一块就写不进去**：sent 为空、remaining 是全部（调用方据此整批回队，一条都不能丢）', () => {
    const ops = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    let calls = 0;
    const r = sendInChunks(ops, 2, () => { calls += 1; return false; });
    assert.equal(calls, 1, '第一块失败后不得继续尝试后续块');
    assert.deepEqual(r.sent, []);
    assert.deepEqual(r.remaining.map((o) => o.id), ['a', 'b', 'c']);
    assert.equal(r.failedChunkSize, 2);
  });

  it('**中途失败**：已成功的前缀算发出去，剩下的原样回队（顺序不变）', () => {
    const ops = Array.from({ length: 5 }, (_, i) => ({ id: 'op-' + i }));
    let calls = 0;
    const r = sendInChunks(ops, 2, () => { calls += 1; return calls <= 2; }); // 前两块成功，第三块失败
    assert.deepEqual(r.sent.map((o) => o.id), ['op-0', 'op-1', 'op-2', 'op-3']);
    assert.deepEqual(r.remaining.map((o) => o.id), ['op-4']);
  });

  it('写入**抛错**按「没发出去」处理（绝不能当成功而丢掉这批 op）', () => {
    const ops = [{ id: 'a' }, { id: 'b' }];
    const r = sendInChunks(ops, 1, () => { throw new Error('socket 已经关了'); });
    assert.deepEqual(r.sent, []);
    assert.deepEqual(r.remaining.map((o) => o.id), ['a', 'b']);
  });

  it('只有 `true` 算成功：返回 undefined / 真值但非 true 都不算', () => {
    const ops = [{ id: 'a' }];
    assert.deepEqual(sendInChunks(ops, 1, () => undefined).sent, [], 'undefined 不算成功');
    assert.deepEqual(sendInChunks(ops, 1, () => 1).sent, [], '1 不算成功（契约是布尔）');
    assert.deepEqual(sendInChunks(ops, 1, () => true).sent.length, 1);
  });

  it('空输入不调用 send（避免发空 op 消息把连接搞挂）', () => {
    let calls = 0;
    const r = sendInChunks([], 200, () => { calls += 1; return true; });
    assert.equal(calls, 0);
    assert.deepEqual(r, { sent: [], remaining: [], failedChunkSize: 0 });
  });
});

describe('P4-3 · 未发送部分回队（unshift）', () => {
  it('回队后保持相对顺序，且与后续新操作拼接顺序正确', () => {
    const q = createPendingOps();
    q.push([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const drained = q.drain();
    q.unshift(drained.slice(2)); // 只发出去前两个，第三个回队
    q.push([{ id: 'd' }]);
    assert.deepEqual(q.drain().map((o) => o.id), ['c', 'd'], '回队的老操作应在新操作之前（按用户操作顺序补发）');
  });

  it('回队空数组是 no-op；回队后有界不变量仍成立', () => {
    const q = createPendingOps({ max: 3 });
    q.push([{ id: 'a' }]);
    assert.deepEqual(q.unshift([]), { size: 1, dropped: 0 });
    const r = q.unshift([{ id: 'x' }, { id: 'y' }]);
    assert.deepEqual(r, { size: 3, dropped: 0 });
    assert.deepEqual(q.drain().map((o) => o.id), ['x', 'y', 'a']);
  });
});

// crdt.test.mjs — CRDT 收敛/幂等/墓碑/字段级合并（S3 / TC-S3-01..04 / FR-5）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoc,
  applyOp,
  applyOps,
  docState,
  getElement,
  makeAdd,
  makePatch,
  makeDel,
  sampleElement,
  stateHash,
} from '../src/index.mjs';

const A = 'client-A';
const B = 'client-B';

function addRect(doc, client, id, geom = { x: 0, y: 0, w: 100, h: 60 }) {
  const el = sampleElement('rect', { id, geom, stroke: '#0000ff' });
  const op = makeAdd(doc, el, client);
  applyOp(doc, op);
  return op;
}

function addAll(doc, client, ids) {
  const ops = [];
  for (const id of ids) {
    const el = sampleElement('rect', { id, geom: { x: 0, y: 0, w: 100, h: 60 } });
    const op = makeAdd(doc, el, client);
    applyOp(doc, op);
    ops.push(op);
  }
  return ops;
}

describe('CRDT 基本语义', () => {
  it('add → docState 含元素；patch 改字段；del 墓碑', () => {
    const doc = createDoc();
    addRect(doc, A, 'e1');
    assert.equal(docState(doc).length, 1);
    assert.equal(docState(doc)[0].stroke, '#0000ff');

    const p = makePatch(doc, 'e1', 'stroke', '#ff0000', '#0000ff', A);
    applyOp(doc, p);
    assert.equal(getElement(doc, 'e1').stroke, '#ff0000');

    const d = makeDel(doc, 'e1', getElement(doc, 'e1'), A);
    applyOp(doc, d);
    assert.equal(docState(doc).length, 0);
    assert.equal(getElement(doc, 'e1'), null);
  });

  it('delete 后重连/重放不复活（墓碑）', () => {
    const doc = createDoc();
    addRect(doc, A, 'e1');
    const el = getElement(doc, 'e1');
    const d = makeDel(doc, 'e1', el, A);
    applyOp(doc, d);
    // 重放 add（旧时钟）不应复活
    const oldAdd = { t: 'add', id: 'e1', el, c: A, v: 1 };
    applyOp(doc, oldAdd);
    assert.equal(docState(doc).length, 0);
  });

  it('字段级局部更新：改色与改线宽互不覆盖', () => {
    const doc = createDoc();
    addRect(doc, A, 'e1');
    applyOp(doc, makePatch(doc, 'e1', 'stroke', '#00ff00', '#0000ff', A));
    applyOp(doc, makePatch(doc, 'e1', 'strokeWidth', 6, 2, B));
    const el = getElement(doc, 'e1');
    assert.equal(el.stroke, '#00ff00');
    assert.equal(el.strokeWidth, 6);
    assert.equal(el.geom.x, 0);
  });
});

describe('CRDT 收敛', () => {
  it('同一 op 集乱序应用 → 状态哈希一致（交换律）', () => {
    const opsA = addAll(createDoc(), A, ['e1', 'e2', 'e3']);
    const opsB = [makePatch(createDoc(), 'e2', 'stroke', '#ff0000', '#000000', B)];
    const opsC = [makeDel(createDoc(), 'e1', sampleElement('rect', { id: 'e1' }), B)];
    const all = [...opsA, ...opsB, ...opsC];

    const d1 = createDoc(); applyOps(d1, all);
    const d2 = createDoc(); applyOps(d2, [...all].reverse());
    const d3 = createDoc();
    for (let i = 0; i < 50; i++) {
      applyOp(d3, all[(i * 7) % all.length]);
      applyOp(d3, all[(i * 13 + 1) % all.length]);
    }
    applyOps(d3, all);

    assert.equal(stateHash(docState(d1)), stateHash(docState(d2)));
    assert.equal(stateHash(docState(d1)), stateHash(docState(d3)));
    assert.equal(docState(d1).length, 2); // e1 被删，剩 e2/e3
  });

  it('重复注入同一 op 幂等（无重复元素）', () => {
    const ops = addAll(createDoc(), A, ['e1']);
    const d1 = createDoc(); applyOps(d1, ops);
    const d2 = createDoc(); applyOps(d2, [...ops, ...ops, ...ops]);
    assert.equal(stateHash(docState(d1)), stateHash(docState(d2)));
    assert.equal(docState(d2).length, 1);
  });

  it('并发不同字段 patch 结合（结合律）', () => {
    const a = createDoc(); const b = createDoc();
    addRect(a, A, 'e1'); addRect(b, A, 'e1');
    const p1 = makePatch(a, 'e1', 'stroke', '#123456', '#0000ff', A);
    const p2 = makePatch(b, 'e1', 'strokeWidth', 9, 2, B);
    applyOp(a, p1); applyOp(b, p2);
    applyOp(a, p2); applyOp(b, p1);
    assert.equal(stateHash(docState(a)), stateHash(docState(b)));
    assert.equal(getElement(a, 'e1').stroke, '#123456');
    assert.equal(getElement(a, 'e1').strokeWidth, 9);
  });

  it('同字段并发 patch → LWW 取较大 (v,c)，双方收敛', () => {
    const a = createDoc(); const b = createDoc();
    addRect(a, A, 'e1'); addRect(b, A, 'e1');
    // 双方时钟不同步：A 的 patch v=2，B 的 patch v=2（各自第二拍），B 的 clientId 更大
    const pA = makePatch(a, 'e1', 'stroke', '#aaaaaa', '#0000ff', A);
    const pB = makePatch(b, 'e1', 'stroke', '#bbbbbb', '#0000ff', B);
    applyOp(a, pA); applyOp(b, pB);
    applyOp(a, pB); applyOp(b, pA);
    const sA = getElement(a, 'e1').stroke;
    const sB = getElement(b, 'e1').stroke;
    assert.equal(sA, sB);
    // B 的 clientId 字典序更大 → 平局时 B 胜
    assert.equal(sA, '#bbbbbb');
  });

  it('1000 元素收敛性能（单次命中 <1ms 级别的快速收敛）', () => {
    const ops = [];
    const tmp = createDoc();
    for (let i = 0; i < 1000; i++) ops.push(makeAdd(tmp, sampleElement('rect', { id: `e${i}` }), A));
    const d = createDoc();
    const t0 = process.hrtime.bigint();
    applyOps(d, ops);
    const t1 = process.hrtime.bigint();
    assert.equal(docState(d).length, 1000);
    const ms = Number(t1 - t0) / 1e6;
    assert.ok(ms < 1000, `1000 元素应用耗时 ${ms}ms 应 <1s`);
  });
});

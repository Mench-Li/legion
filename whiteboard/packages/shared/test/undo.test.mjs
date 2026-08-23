// undo.test.mjs — 每用户局部撤销/重做（S9 / FR-7 / TC-S9-01..07 / TC-S7-07）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoc,
  applyOp,
  getElement,
  docState,
  makeAdd,
  makePatch,
  makeDel,
  sampleElement,
  stateHash,
  createUndoManager,
} from '../src/index.mjs';

const A = 'client-A';
const B = 'client-B';

function rectEl(id, stroke = '#0000ff') {
  return sampleElement('rect', { id, geom: { x: 0, y: 0, w: 100, h: 60 }, stroke });
}

// 模拟「一次手势 = 一个事务」的本地 op 生成 + 应用 + 记录
function gesture(doc, um, client, fn) {
  um.begin();
  const ops = fn();
  for (const op of ops) { applyOp(doc, op); um.add(op); }
  um.commit();
  return ops;
}

function addGesture(doc, um, client, id) {
  return gesture(doc, um, client, () => [makeAdd(doc, rectEl(id), client)]);
}

function delGesture(doc, um, client, id) {
  const old = getElement(doc, id);
  return gesture(doc, um, client, () => [makeDel(doc, id, old, client)]);
}

describe('每用户局部撤销', () => {
  it('一次手势 = 一步 undo（TC-S7-07）', () => {
    const doc = createDoc();
    const um = createUndoManager(doc, A);
    addGesture(doc, um, A, 'e1');
    // 一次拖拽产生 N 个 patch，但同一事务只算一步
    const geom = { x: 0, y: 0, w: 100, h: 60 };
    um.begin();
    const ops = [
      makePatch(doc, 'e1', 'geom', { ...geom, x: 1 }, geom, A),
      makePatch(doc, 'e1', 'geom', { ...geom, x: 2 }, { ...geom, x: 1 }, A),
      makePatch(doc, 'e1', 'geom', { ...geom, x: 3 }, { ...geom, x: 2 }, A),
    ];
    for (const op of ops) { applyOp(doc, op); um.add(op); }
    um.commit();
    assert.equal(um.undoDepth(), 2);
    um.undo();
    assert.equal(getElement(doc, 'e1').geom.x, 0); // 一步回拖拽前
    um.undo();
    assert.equal(docState(doc).length, 0); // 再一步回空板
  });

  it('A 撤销只撤自己，不撤销 B 的 op（TC-S9-01/07）', () => {
    const doc = createDoc();
    const umA = createUndoManager(doc, A);
    addGesture(doc, umA, A, 'eA');
    // B 加自己的元素（不经 A 的 undo 管理器）
    const opB = makeAdd(doc, rectEl('eB', '#ff0000'), B);
    applyOp(doc, opB);
    assert.equal(docState(doc).length, 2);
    umA.undo();
    assert.equal(docState(doc).length, 1);
    assert.equal(docState(doc)[0].id, 'eB'); // B 的元素保留
  });

  it('删除墓碑可撤销（undo del = re-add）（TC-S7-05）', () => {
    const doc = createDoc();
    const um = createUndoManager(doc, A);
    addGesture(doc, um, A, 'e1');
    delGesture(doc, um, A, 'e1');
    assert.equal(docState(doc).length, 0);
    um.undo();
    assert.equal(docState(doc).length, 1);
    assert.equal(getElement(doc, 'e1').id, 'e1');
  });

  it('undo 后 redo 恢复（TC-S9-03）', () => {
    const doc = createDoc();
    const um = createUndoManager(doc, A);
    addGesture(doc, um, A, 'e1');
    um.undo();
    assert.equal(docState(doc).length, 0);
    um.redo();
    assert.equal(docState(doc).length, 1);
  });

  it('undo 深度 ≥100 步（TC-S9-02）', () => {
    const doc = createDoc();
    const um = createUndoManager(doc, A);
    for (let i = 0; i < 150; i++) addGesture(doc, um, A, `e${i}`);
    assert.equal(docState(doc).length, 150);
    assert.ok(um.undoDepth() >= 100);
    for (let i = 0; i < 150; i++) um.undo();
    assert.equal(docState(doc).length, 0); // 回基线
    assert.equal(um.undo().length, 0); // 到底后无效果
  });

  it('clear-on-remote：撤销后远端 op → redo 清空（TC-S9-05）', () => {
    const doc = createDoc();
    const um = createUndoManager(doc, A, { variant: 'clear-on-remote' });
    addGesture(doc, um, A, 'e1');
    um.undo();
    assert.equal(um.canRedo(), true);
    // 远端 B 的 op 落进来
    applyOp(doc, makeAdd(doc, rectEl('eB'), B));
    um.onRemote();
    assert.equal(um.canRedo(), false);
    assert.equal(um.redo().length, 0);
  });

  it('keep-replay：撤销后远端 op 不干扰 redo（TC-S9-06）', () => {
    const doc = createDoc();
    const um = createUndoManager(doc, A, { variant: 'keep-replay' });
    addGesture(doc, um, A, 'e1');
    um.undo();
    applyOp(doc, makeAdd(doc, rectEl('eB'), B));
    um.onRemote();
    assert.equal(um.canRedo(), true);
    const ops = um.redo();
    assert.ok(ops.length > 0);
    assert.equal(docState(doc).some((e) => e.id === 'e1'), true);
  });
});

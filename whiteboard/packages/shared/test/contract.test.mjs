// contract.test.mjs — 共享契约行为测试（对应 tests/contract 的纯逻辑口径）。
// 运行：node --test whiteboard/packages/shared/test/contract.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEMENT_TYPES,
  HEX_COLOR_RE,
  validateElement,
  sampleElement,
  stateHash,
  distPointSegment,
  hitTestRect,
  hitTestEllipse,
  hitTestLine,
  hitTestFreehand,
  hitTestText,
  hitTestElement,
  validateViewport,
  worldToScreen,
  screenToWorld,
  createThrottle,
  createHistory,
  escapeHtml,
  createPresence,
} from '../src/index.mjs';

describe('schema', () => {
  it('五类元素合法样例全部通过', () => {
    for (const type of ELEMENT_TYPES) {
      assert.equal(validateElement(sampleElement(type)).ok, true, type);
    }
  });
  it('非法 type / 缺失字段 / NaN / 坏色值 拒绝', () => {
    assert.equal(validateElement({ id: 'a', type: 'circle', geom: {}, stroke: '#000', strokeWidth: 1 }).ok, false);
    assert.equal(validateElement({ type: 'rect', geom: { x: 0, y: 0, w: 1, h: 1 } }).ok, false);
    assert.equal(validateElement(sampleElement('rect', { geom: { x: NaN, y: 0, w: 1, h: 1 } })).ok, false);
    assert.equal(validateElement(sampleElement('rect', { stroke: 'red' })).ok, false);
    assert.equal(validateElement(sampleElement('rect', { strokeWidth: 0 })).ok, false);
  });
  it('未知字段 lenient 忽略', () => {
    assert.equal(validateElement(sampleElement('rect', { extra: 'x' })).ok, true);
  });
  it('HEX_COLOR_RE 仅 #rgb/#rrggbb', () => {
    assert.equal(HEX_COLOR_RE.test('#fff'), true);
    assert.equal(HEX_COLOR_RE.test('#a1B2c3'), true);
    assert.equal(HEX_COLOR_RE.test('#abcd'), false);
  });
});

describe('stateHash', () => {
  const a = sampleElement('rect', { id: 'r1' });
  const b = sampleElement('ellipse', { id: 'e1' });
  const c = sampleElement('text', { id: 't1' });
  it('顺序无关 + 三输入形态一致', () => {
    assert.equal(stateHash([a, b, c]), stateHash([c, a, b]));
    assert.equal(stateHash([a, b, c]), stateHash(new Map([[a.id, a], [b.id, b], [c.id, c]])));
  });
  it('字段差异 / points 顺序差异 → 哈希不同', () => {
    assert.notEqual(stateHash([a]), stateHash([sampleElement('rect', { id: 'r1', stroke: '#123456' })]));
    const f1 = sampleElement('freehand', { id: 'f', geom: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } });
    const f2 = sampleElement('freehand', { id: 'f', geom: { points: [{ x: 1, y: 1 }, { x: 0, y: 0 }] } });
    assert.notEqual(stateHash([f1]), stateHash([f2]));
  });
  it('空集合哈希稳定', () => {
    assert.equal(stateHash([]), stateHash(new Map()));
  });
});

describe('hitTest', () => {
  it('rect 命中边界 + tolerance', () => {
    const g = { x: 10, y: 10, w: 100, h: 60 };
    assert.equal(hitTestRect(g, 50, 40, 0), true);
    assert.equal(hitTestRect(g, 0, 0, 0), false);
    assert.equal(hitTestRect(g, 9, 10, 1), true);
  });
  it('ellipse 中心命中、bbox 角点未命中', () => {
    assert.equal(hitTestEllipse({ x: 0, y: 0, w: 100, h: 60 }, 50, 30, 0), true);
    assert.equal(hitTestEllipse({ x: 0, y: 0, w: 100, h: 60 }, 0, 0, 0), false);
  });
  it('line 线段非射线', () => {
    const g = { x1: 0, y1: 0, x2: 100, y2: 0 };
    assert.equal(hitTestLine(g, 50, 0.9, 1), true);
    assert.equal(hitTestLine(g, 150, 0, 1), false);
  });
  it('freehand 折线 / 单点退化', () => {
    assert.equal(hitTestFreehand({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, 5, 0.5, 1), true);
    assert.equal(hitTestFreehand({ points: [{ x: 0, y: 0 }] }, 0, 0.5, 1), true);
  });
  it('text 包围盒命中', () => {
    const g = { x: 0, y: 20, text: 'hello' };
    assert.equal(hitTestText(g, 20, 12, { fontSize: 16, measure: () => 40 }, 0), true);
    assert.equal(hitTestText(g, 20, 0, { fontSize: 16, measure: () => 40 }, 0), false);
  });
  it('重叠元素取最上层（数组末尾）', () => {
    const bottom = sampleElement('rect', { id: 'bottom', geom: { x: 0, y: 0, w: 100, h: 100 } });
    const top = sampleElement('rect', { id: 'top', geom: { x: 0, y: 0, w: 100, h: 100 } });
    assert.equal(hitTestElement([bottom, top], 50, 50), 'top');
  });
  it('空点击返回 null', () => {
    assert.equal(hitTestElement([], 0, 0), null);
  });
  it('distPointSegment 退化', () => {
    assert.equal(distPointSegment(3, 4, 0, 0, 0, 0), 5);
  });
});

describe('viewport', () => {
  it('往返一致', () => {
    const vp = { scale: 1.5, tx: 120, ty: -40 };
    const back = screenToWorld(worldToScreen({ x: 33, y: -17 }, vp), vp);
    assert.ok(Math.abs(back.x - 33) < 1e-9);
  });
  it('非法 viewport 抛错', () => {
    assert.throws(() => worldToScreen({ x: 1, y: 1 }, { scale: 0, tx: 0, ty: 0 }), /invalid viewport/);
    assert.equal(validateViewport({ scale: 1, tx: 0, ty: 0 }), true);
  });
});

describe('throttle', () => {
  it('20Hz：首帧即时放行一次', () => {
    const t = createThrottle(20);
    assert.equal(t(0), true);
    assert.equal(t(0), false);
  });
  it('20Hz：之后 1s 窗口发送 ≤20 条', () => {
    const t = createThrottle(20);
    let n = 0;
    for (let now = 0; now <= 1000; now += 1) if (t(now)) n++;
    assert.equal(n, 21); // 首帧 + 20 条
  });
  it('rateHz ≤ 0 抛错', () => {
    assert.throws(() => createThrottle(0));
  });
});

describe('history (redo 语义)', () => {
  it('clear-on-remote：撤销后远端 op → redo 清空', () => {
    const h = createHistory('clear-on-remote');
    h.record({ id: 'op1' });
    assert.equal(h.undo()?.id, 'op1');
    assert.equal(h.canRedo(), true);
    h.onRemoteOp();
    assert.equal(h.canRedo(), false);
  });
  it('keep-replay：保留 redo', () => {
    const h = createHistory('keep-replay');
    h.record({ id: 'op1' });
    h.undo();
    h.onRemoteOp();
    assert.equal(h.canRedo(), true);
    assert.equal(h.redo()?.id, 'op1');
  });
});

describe('escapeHtml', () => {
  it('XSS 转义', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    assert.equal(out.includes('<'), false);
    assert.ok(out.includes('&lt;img'));
  });
  it('五种敏感字符', () => {
    assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('presence', () => {
  it('正常断开立即移除；TTL 边界保留', () => {
    const p = createPresence(10000);
    p.touch('a', 0);
    p.leave('a');
    assert.equal(p.has('a'), false);
    p.touch('b', 0);
    p.sweep(10000);
    assert.equal(p.has('b'), true);
    p.sweep(10001);
    assert.equal(p.has('b'), false);
  });
  it('多端计数', () => {
    const p = createPresence(10000);
    p.touch('a', 0); p.touch('b', 0); p.touch('c', 0);
    assert.equal(p.size(), 3);
    p.leave('b');
    assert.equal(p.size(), 2);
  });
});

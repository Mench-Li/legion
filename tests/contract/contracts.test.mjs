// tests/contract/contracts.test.mjs
// 契约测试：把 REQUIREMENTS/RESEARCH/TASK_BREAKDOWN 中的纯逻辑契约固化为可运行断言。
// 运行：node --test tests/contract/   （零第三方依赖，Node 内置 node:test）
// 每个 describe 块顶部标注对应 TC 编号（docs/TEST_CASES.md）与下游子任务（S#）。

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
  hitTestBox,
  hitTestText,
  hitTestElement,
  validateViewport,
  worldToScreen,
  screenToWorld,
  createThrottle,
  createHistory,
  escapeHtml,
  createPresence,
} from './contracts.mjs';

// ============================================================
// TC-S2-01..06 元素 schema 校验
// ============================================================

describe('validateElement — schema 契约 (S2, FR-2, ADR-0003)', () => {
  it('TC-S2-01 五类元素合法样例全部通过', () => {
    for (const type of ELEMENT_TYPES) {
      const el = sampleElement(type);
      const r = validateElement(el);
      assert.equal(r.ok, true, `${type} should be valid, got ${JSON.stringify(r.errors)}`);
    }
  });

  it('TC-S2-01 rect/ellipse 带合法 fill 通过', () => {
    const el = sampleElement('rect', { fill: '#ff0000' });
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-01 line 无 arrow（缺省）通过', () => {
    const el = sampleElement('line');
    delete el.geom.arrow;
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-02 边界：w/h = 0 合法（退化元素）', () => {
    const el = sampleElement('rect', { geom: { x: 0, y: 0, w: 0, h: 0 } });
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-02 边界：负坐标合法（无限画布）', () => {
    const el = sampleElement('rect', { geom: { x: -500, y: -300, w: 10, h: 10 } });
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-02 边界：text 空字符串合法', () => {
    const el = sampleElement('text', { geom: { x: 0, y: 0, text: '' } });
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-02 边界：freehand 单点合法（一个点=点状笔迹）', () => {
    const el = sampleElement('freehand', { geom: { points: [{ x: 1, y: 2 }] } });
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-02 边界：fill 空串（无填充）合法', () => {
    const el = sampleElement('ellipse', { fill: '' });
    assert.equal(validateElement(el).ok, true);
  });

  it('TC-S2-03 异常：非法 type 拒绝', () => {
    const r = validateElement({ id: 'a', type: 'circle', geom: {}, stroke: '#000', strokeWidth: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('type')));
  });

  it('TC-S2-04 异常：缺失 id / geom / stroke / strokeWidth 拒绝', () => {
    const r = validateElement({ type: 'rect', geom: { x: 0, y: 0, w: 1, h: 1 } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('id')));
    assert.ok(r.errors.some((e) => e.includes('stroke')));
    assert.ok(r.errors.some((e) => e.includes('strokeWidth')));
  });

  it('TC-S2-04 异常：非对象元素拒绝', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      const r = validateElement(bad);
      assert.equal(r.ok, false, `input ${JSON.stringify(bad)} should fail`);
    }
  });

  it('TC-S2-05 异常：字段类型错误拒绝（NaN/Infinity/字符串坐标/负线宽）', () => {
    const bad = [
      sampleElement('rect', { geom: { x: NaN, y: 0, w: 1, h: 1 } }),
      sampleElement('rect', { geom: { x: 0, y: 0, w: Infinity, h: 1 } }),
      sampleElement('line', { geom: { x1: '0', y1: 0, x2: 1, y2: 1 } }),
      sampleElement('rect', { strokeWidth: 0 }),
      sampleElement('rect', { strokeWidth: -2 }),
      sampleElement('rect', { strokeWidth: '2' }),
    ];
    for (const el of bad) {
      assert.equal(validateElement(el).ok, false, JSON.stringify(el));
    }
  });

  it('TC-S2-05 异常：stroke 非十六进制拒绝', () => {
    for (const stroke of ['red', '#zzz', '#00000', '000000', '#0000000']) {
      const r = validateElement(sampleElement('rect', { stroke }));
      assert.equal(r.ok, false, `stroke=${stroke}`);
    }
  });

  it('TC-S2-05 异常：freehand points 非法项拒绝', () => {
    const r = validateElement(sampleElement('freehand', { geom: { points: [{ x: 0, y: 0 }, { x: 1 }] } }));
    assert.equal(r.ok, false);
    const r2 = validateElement(sampleElement('freehand', { geom: { points: [] } }));
    assert.equal(r2.ok, false);
  });

  it('TC-S2-05 异常：line arrow 非布尔拒绝', () => {
    const r = validateElement(sampleElement('line', { geom: { x1: 0, y1: 0, x2: 1, y2: 1, arrow: 'yes' } }));
    assert.equal(r.ok, false);
  });

  it('TC-S2-06 边界：未知字段被忽略（lenient），不使校验失败', () => {
    const el = sampleElement('rect', { extraField: 'x', nested: { a: 1 } });
    const r = validateElement(el);
    assert.equal(r.ok, true);
  });

  it('HEX_COLOR_RE 仅接受 #rgb/#rrggbb', () => {
    assert.equal(HEX_COLOR_RE.test('#fff'), true);
    assert.equal(HEX_COLOR_RE.test('#a1B2c3'), true);
    assert.equal(HEX_COLOR_RE.test('#abcd'), false);
    assert.equal(HEX_COLOR_RE.test('#aabbccdd'), false);
  });
});

// ============================================================
// TC-S2-08/09 确定性状态哈希
// ============================================================

describe('stateHash — 确定性哈希 (S2, 收敛断言口径)', () => {
  const a = sampleElement('rect', { id: 'r1' });
  const b = sampleElement('ellipse', { id: 'e1' });
  const c = sampleElement('text', { id: 't1' });

  it('TC-S2-08 相同元素集、不同插入顺序 → 相同哈希', () => {
    const h1 = stateHash(new Map([[a.id, a], [b.id, b], [c.id, c]]));
    const h2 = stateHash(new Map([[c.id, c], [a.id, a], [b.id, b]]));
    assert.equal(h1, h2);
  });

  it('TC-S2-08 Map/数组/对象 三种输入同内容 → 相同哈希', () => {
    const arr = [a, b, c];
    const obj = { [a.id]: a, [b.id]: b, [c.id]: c };
    const m = new Map([[a.id, a], [b.id, b], [c.id, c]]);
    assert.equal(stateHash(arr), stateHash(obj));
    assert.equal(stateHash(arr), stateHash(m));
  });

  it('TC-S2-09 任一字段差异 → 哈希不同', () => {
    const base = stateHash([a, b, c]);
    const changed = sampleElement('rect', { stroke: '#123456' });
    assert.notEqual(stateHash([changed, b, c]), base);
  });

  it('TC-S2-09 键顺序无关：geom 键乱序 → 相同哈希', () => {
    const g1 = { x: 1, y: 2, w: 3, h: 4 };
    const g2 = { h: 4, w: 3, y: 2, x: 1 };
    const e1 = sampleElement('rect', { geom: g1 });
    const e2 = sampleElement('rect', { geom: g2 });
    assert.equal(stateHash([e1]), stateHash([e2]));
  });

  it('TC-S2-09 freehand points 顺序有意义 → 顺序不同哈希不同', () => {
    const f1 = sampleElement('freehand', { geom: { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] } });
    const f2 = sampleElement('freehand', { geom: { points: [{ x: 10, y: 10 }, { x: 0, y: 0 }] } });
    assert.notEqual(stateHash([f1]), stateHash([f2]));
  });

  it('TC-S2-09 空集合哈希稳定（基线）', () => {
    assert.equal(stateHash([]), stateHash(new Map()));
    assert.equal(typeof stateHash([]), 'string');
  });
});

// ============================================================
// TC-S6-01..09 几何命中检测
// ============================================================

describe('hitTest — 几何命中 (S6, FR-2/FR-3)', () => {
  it('TC-S6-01 rect：内部命中 / 外部未命中 / 边界含 tolerance', () => {
    const g = { x: 10, y: 10, w: 100, h: 60 };
    assert.equal(hitTestRect(g, 50, 40, 0), true);
    assert.equal(hitTestRect(g, 0, 0, 0), false);
    assert.equal(hitTestRect(g, 10, 10, 0), true);      // 边界含
    assert.equal(hitTestRect(g, 9, 10, 0), false);       // 边界外
    assert.equal(hitTestRect(g, 9, 10, 1), true);        // tolerance 外扩
  });

  it('TC-S6-01 ellipse：中心命中 / bbox 角点（椭圆外）未命中', () => {
    const g = { x: 0, y: 0, w: 100, h: 60 };
    assert.equal(hitTestEllipse(g, 50, 30, 0), true);   // 中心
    assert.equal(hitTestEllipse(g, 0, 0, 0), false);    // bbox 角点，在椭圆外
  });

  it('TC-S6-01 ellipse：退化（w=0 或 h=0）永不命中', () => {
    assert.equal(hitTestEllipse({ x: 0, y: 0, w: 0, h: 10 }, 0, 5, 0), false);
    assert.equal(hitTestEllipse({ x: 0, y: 0, w: 10, h: 0 }, 5, 0, 0), false);
  });

  it('TC-S6-03 line：线上命中 / 容差内命中 / 远处未命中 / 端点外未命中', () => {
    const g = { x1: 0, y1: 0, x2: 100, y2: 0 };
    assert.equal(hitTestLine(g, 50, 0, 1), true);
    assert.equal(hitTestLine(g, 50, 0.9, 1), true);
    assert.equal(hitTestLine(g, 50, 2, 1), false);
    assert.equal(hitTestLine(g, 150, 0, 1), false);   // 端点外（线段非射线）
  });

  it('TC-S6-04 freehand：折线段附近命中 / 单点退化', () => {
    const g = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    assert.equal(hitTestFreehand(g, 5, 0.5, 1), true);
    assert.equal(hitTestFreehand(g, 5, 5, 1), false);
    assert.equal(hitTestFreehand({ points: [{ x: 0, y: 0 }] }, 0, 0.5, 1), true);
  });

  it('TC-S6-05 text：bbox 内命中（显式 measure）', () => {
    const g = { x: 0, y: 20, text: 'hello' };
    const opts = { fontSize: 16, measure: () => 40 };
    assert.equal(hitTestText(g, 20, 12, opts, 0), true);   // bbox [0,4]x[40,16]
    assert.equal(hitTestText(g, 20, 0, opts, 0), false);   // 基线之上（box 外）
    assert.equal(hitTestText(g, 50, 12, opts, 0), false);  // 右侧超出
  });

  it('TC-S6-06 边界：空元素集 → null；未命中 → null', () => {
    assert.equal(hitTestElement([], 0, 0), null);
    assert.equal(hitTestElement([sampleElement('rect')], 9999, 9999), null);
  });

  it('TC-S6-07 边界：重叠元素取最上层（数组末尾）', () => {
    const bottom = sampleElement('rect', { id: 'bottom', geom: { x: 0, y: 0, w: 100, h: 100 } });
    const top = sampleElement('rect', { id: 'top', geom: { x: 0, y: 0, w: 100, h: 100 } });
    assert.equal(hitTestElement([bottom, top], 50, 50), 'top');
    assert.equal(hitTestElement([top, bottom], 50, 50), 'bottom'); // 顺序决定 Z 序
  });

  it('TC-S6-08 边界：线宽容差恰在阈值上命中、阈值外未命中', () => {
    const el = sampleElement('line', { strokeWidth: 2, geom: { x1: 0, y1: 0, x2: 100, y2: 0 } });
    // tol = 2/2 + 0 = 1
    assert.equal(hitTestElement([el], 50, 1, {}), 'seed');
    assert.equal(hitTestElement([el], 50, 1.01, {}), null);
  });

  it('distPointSegment：线段退化（端点重合）退化为点距离', () => {
    assert.equal(distPointSegment(3, 4, 0, 0, 0, 0), 5);
    assert.equal(distPointSegment(0, 0, 0, 0, 10, 0), 0);
    assert.equal(distPointSegment(5, 5, 0, 0, 10, 0), 5);
  });
});

// ============================================================
// TC-S8-01..05 视口变换
// ============================================================

describe('viewport — 世界/屏幕坐标变换 (S8, FR-4)', () => {
  it('TC-S8-01 world→screen→world 往返一致', () => {
    const vp = { scale: 1.5, tx: 120, ty: -40 };
    const w = { x: 33, y: -17 };
    const s = worldToScreen(w, vp);
    const back = screenToWorld(s, vp);
    assert.ok(Math.abs(back.x - w.x) < 1e-9);
    assert.ok(Math.abs(back.y - w.y) < 1e-9);
  });

  it('TC-S8-01 平移与缩放正确作用', () => {
    const vp = { scale: 2, tx: 10, ty: 20 };
    assert.deepEqual(worldToScreen({ x: 5, y: 6 }, vp), { x: 20, y: 32 });
    assert.deepEqual(screenToWorld({ x: 20, y: 32 }, vp), { x: 5, y: 6 });
  });

  it('TC-S8-03 边界：极端缩放（0.01x / 100x）往返一致', () => {
    for (const scale of [0.01, 100]) {
      const vp = { scale, tx: 0, ty: 0 };
      const back = screenToWorld(worldToScreen({ x: 123.456, y: -78.9 }, vp), vp);
      assert.ok(Math.abs(back.x - 123.456) < 1e-6);
      assert.ok(Math.abs(back.y + 78.9) < 1e-6);
    }
  });

  it('TC-S8-04 异常：非法 viewport（scale=0/负数/NaN、tx/ty 非数）抛错', () => {
    for (const vp of [
      { scale: 0, tx: 0, ty: 0 },
      { scale: -1, tx: 0, ty: 0 },
      { scale: NaN, tx: 0, ty: 0 },
      { scale: 1, tx: NaN, ty: 0 },
      null,
    ]) {
      assert.throws(() => worldToScreen({ x: 1, y: 1 }, vp), /invalid viewport/);
    }
  });

  it('validateViewport 合法/非法判定', () => {
    assert.equal(validateViewport({ scale: 1, tx: 0, ty: 0 }), true);
    assert.equal(validateViewport({ scale: 0, tx: 0, ty: 0 }), false);
  });
});

// ============================================================
// TC-S4-03 光标 20Hz 节流
// ============================================================

describe('createThrottle — 20Hz 节流 (S4, §6.2 光标节流)', () => {
  it('TC-S4-03 首帧即时放行一次', () => {
    const t = createThrottle(20);
    assert.equal(t(0), true);
    assert.equal(t(0), false);   // 同一时刻重复调用被压掉
  });

  it('TC-S4-03 之后发送间隔 ≥ 50ms（20Hz）', () => {
    const t = createThrottle(20);
    const sends = [];
    for (let now = 0; now <= 2000; now += 1) {
      if (t(now)) sends.push(now);
    }
    assert.equal(sends[0], 0);
    for (let i = 1; i < sends.length; i++) {
      assert.equal(sends[i] - sends[i - 1], 50, `gap at ${sends[i]}`);
    }
  });

  it('TC-S4-03 首帧除外的 1s 窗口内发送 ≤20 条', () => {
    const t = createThrottle(20);
    let total = 0;
    let afterFirst = 0;
    for (let now = 0; now <= 1000; now += 1) {
      const ok = t(now);
      if (ok) {
        total++;
        if (now > 0) afterFirst++;
      }
    }
    assert.equal(total, 21);     // 首帧 + 20 条
    assert.equal(afterFirst, 20);
  });

  it('异常：rateHz ≤ 0 抛错', () => {
    assert.throws(() => createThrottle(0));
    assert.throws(() => createThrottle(-20));
  });
});

// ============================================================
// TC-S9-05/06 redo 并发语义（双分支）
// ============================================================

describe('createHistory — redo 并发语义 (S9, ADR-0006, §5.3)', () => {
  it('TC-S9-05 默认 clear-on-remote：撤销后远端 op 落 → redo 清空', () => {
    const h = createHistory('clear-on-remote');
    h.record({ id: 'op1', origin: 'local' });
    assert.equal(h.undo()?.id, 'op1');
    assert.equal(h.canRedo(), true);
    h.onRemoteOp();                       // 远端并发 op 落进本人历史作用域
    assert.equal(h.canRedo(), false);
    assert.equal(h.redo(), null);         // redo 无操作
  });

  it('TC-S9-06 keep-replay：撤销后远端 op 不干扰，redo 重放本人 op', () => {
    const h = createHistory('keep-replay');
    h.record({ id: 'op1', origin: 'local' });
    assert.equal(h.undo()?.id, 'op1');
    h.onRemoteOp();
    assert.equal(h.canRedo(), true);
    assert.equal(h.redo()?.id, 'op1');    // 仍能重放本人 op
  });

  it('TC-S9-04 边界：undo 到底后继续 undo 返回 null 且不破坏 redo', () => {
    const h = createHistory('clear-on-remote');
    assert.equal(h.undo(), null);
    h.record({ id: 'a' });
    h.undo();
    assert.equal(h.undo(), null);
    assert.equal(h.redo()?.id, 'a');
  });

  it('undo/redo 往返一致', () => {
    const h = createHistory('clear-on-remote');
    h.record({ id: 'a' });
    h.record({ id: 'b' });
    assert.equal(h.undo()?.id, 'b');
    assert.equal(h.undo()?.id, 'a');
    assert.equal(h.redo()?.id, 'a');
    assert.equal(h.redo()?.id, 'b');
    assert.equal(h.canUndo(), true);
  });

  it('未知 variant 抛错', () => {
    assert.throws(() => createHistory('bogus'));
  });
});

// ============================================================
// TC-S5-02 文本 XSS 门禁
// ============================================================

describe('escapeHtml — XSS 门禁 (S5, FR-11)', () => {
  it('TC-S5-02 恶意 HTML/脚本被转义为纯文本', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const out = escapeHtml(evil);
    assert.equal(out.includes('<'), false);
    assert.equal(out.includes('>'), false);
    assert.ok(out.includes('&lt;img'));
  });

  it('TC-S5-02 脚本标签被转义', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('TC-S5-02 五种敏感字符全部转义', () => {
    assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('TC-S5-02 正常文本不被破坏', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
    assert.equal(escapeHtml('中文文本 123'), '中文文本 123');
  });

  it('TC-S5-02 非字符串输入被安全字符串化', () => {
    assert.equal(escapeHtml(123), '123');
    assert.equal(escapeHtml(null), 'null');
  });
});

// ============================================================
// TC-S4-04/05 presence TTL
// ============================================================

describe('createPresence — 在线列表与 TTL (S4/S11, §6.2 TTL)', () => {
  it('TC-S4-04 正常断开立即移除（与 TTL 无关）', () => {
    const p = createPresence(10000);
    p.touch('a', 0);
    p.leave('a');
    assert.equal(p.has('a'), false);
    assert.equal(p.size(), 0);
  });

  it('TC-S4-05 非正常断开：TTL 边界内保留、超过 TTL 移除', () => {
    const ttl = 10000;
    const p = createPresence(ttl);
    p.touch('a', 0);
    p.sweep(0 + ttl);        // 恰好 ttl（边界）
    assert.equal(p.has('a'), true, 'at ttl boundary still present');
    p.sweep(0 + ttl + 1);    // 超过 ttl
    assert.equal(p.has('a'), false, 'past ttl removed');
  });

  it('TC-S4-05 心跳刷新后 TTL 重新起算', () => {
    const p = createPresence(10000);
    p.touch('a', 0);
    p.touch('a', 5000);
    p.sweep(10000);          // 距最近心跳 5000 < ttl
    assert.equal(p.has('a'), true);
  });

  it('TC-S4-02 多端在线列表聚合计数正确', () => {
    const p = createPresence(10000);
    p.touch('a', 0);
    p.touch('b', 0);
    p.touch('c', 0);
    assert.equal(p.size(), 3);
    p.leave('b');
    assert.equal(p.size(), 2);
  });
});

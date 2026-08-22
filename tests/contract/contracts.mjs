// tests/contract/contracts.mjs
// ============================================================================
// 可执行参考契约（Executable Reference Spec）—— 供 test-designer 阶段落盘、coder
// 阶段直接移植或对照实现的「规格即测试」模块。
//
// 本模块只依赖 Node 内置能力（node:crypto / 无第三方依赖），用于把 REQUIREMENTS
// §3.2 元素数据模型、§3.3 presence 模型、§6.2 量化口径中的「纯逻辑」部分固化为
// 可运行、可断言的契约。它**不是**生产实现，而是 coder 必须满足的行为边界；
// 生产实现（packages/shared 等）可与本模块逐字节一致，也可另行实现，但必须通过
// 同目录 contracts.test.mjs 的全部断言。
//
// 对应下游：
//   validateElement / stateHash  -> packages/shared/src/{schema,hash}.ts   (S2)
//   hitTest* / distPointSegment  -> apps/web/src/interaction/hitTest.ts     (S6)
//   worldToScreen/screenToWorld  -> apps/web/src/viewport/*                (S8)
//   createThrottle               -> apps/web/src/presence/* (20Hz)         (S4)
//   createHistory (redo 语义)     -> apps/web/src/history/*                 (S9)
//   escapeHtml                   -> apps/web/src/render/* (XSS 门禁)        (S5)
//   createPresence (TTL)          -> apps/web/src/presence/* / server       (S4/S11)
// ============================================================================

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// S2：元素 schema 契约（REQUIREMENTS §3.2）
// ---------------------------------------------------------------------------

export const ELEMENT_TYPES = ['rect', 'ellipse', 'line', 'freehand', 'text'];

/** 十六进制颜色：#rgb / #rrggbb（v1 仅这两种） */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
const isFinitePoint = (p) =>
  p !== null && typeof p === 'object' && isFiniteNumber(p.x) && isFiniteNumber(p.y);

/**
 * 校验单个元素，返回 { ok, value } 或 { ok:false, errors[] }。
 * 契约要点（与 REQUIREMENTS §3.2 对齐）：
 *  - id: 非空字符串（v1 用 crypto.randomUUID 生成，此处只校验非空，格式由 coder 生成器保证）
 *  - type: 五选一
 *  - geom: 按 type 变化（rect/ellipse={x,y,w,h}; line={x1,y1,x2,y2,arrow}; freehand={points[]}; text={x,y,text}）
 *  - stroke: 必填十六进制；fill: 可选（空串=无填充），仅 rect/ellipse 语义上使用
 *  - strokeWidth: 必填正有限数
 *  - 未知字段：忽略（lenient），不使校验失败、不抛异常（见测试 TC-S2-06）
 */
export function validateElement(el) {
  const errors = [];
  if (el === null || typeof el !== 'object' || Array.isArray(el)) {
    return { ok: false, errors: ['element: must be a plain object'] };
  }
  if (typeof el.id !== 'string' || el.id.length === 0) {
    errors.push('id: non-empty string required');
  }
  if (!ELEMENT_TYPES.includes(el.type)) {
    errors.push(`type: must be one of ${ELEMENT_TYPES.join('|')}`);
  }

  const g = el.geom;
  if (g === null || typeof g !== 'object' || Array.isArray(g)) {
    errors.push('geom: object required');
  } else {
    switch (el.type) {
      case 'rect':
      case 'ellipse': {
        for (const k of ['x', 'y', 'w', 'h']) {
          if (!isFiniteNumber(g[k])) errors.push(`geom.${k}: finite number required`);
        }
        if (isFiniteNumber(g.w) && g.w < 0) errors.push('geom.w: must be >= 0');
        if (isFiniteNumber(g.h) && g.h < 0) errors.push('geom.h: must be >= 0');
        break;
      }
      case 'line': {
        for (const k of ['x1', 'y1', 'x2', 'y2']) {
          if (!isFiniteNumber(g[k])) errors.push(`geom.${k}: finite number required`);
        }
        if (g.arrow !== undefined && typeof g.arrow !== 'boolean') {
          errors.push('geom.arrow: boolean required when present');
        }
        break;
      }
      case 'freehand': {
        if (!Array.isArray(g.points) || g.points.length < 1) {
          errors.push('geom.points: non-empty array of {x,y} required');
        } else {
          g.points.forEach((p, i) => {
            if (!isFinitePoint(p)) errors.push(`geom.points[${i}]: {x,y} finite numbers required`);
          });
        }
        break;
      }
      case 'text': {
        for (const k of ['x', 'y']) {
          if (!isFiniteNumber(g[k])) errors.push(`geom.${k}: finite number required`);
        }
        if (typeof g.text !== 'string') errors.push('geom.text: string required');
        break;
      }
      default:
        // type 错误已在上方记录，避免重复报 geom 错误
        break;
    }
  }

  if (typeof el.stroke !== 'string' || !HEX_COLOR_RE.test(el.stroke)) {
    errors.push('stroke: hex color (#rgb or #rrggbb) required');
  }
  if (el.fill !== undefined && el.fill !== null && el.fill !== '') {
    if (typeof el.fill !== 'string' || !HEX_COLOR_RE.test(el.fill)) {
      errors.push('fill: hex color or empty string');
    }
  }
  if (!isFiniteNumber(el.strokeWidth) || el.strokeWidth <= 0) {
    errors.push('strokeWidth: positive finite number required');
  }

  return errors.length === 0 ? { ok: true, value: el } : { ok: false, errors };
}

/** 按 5 类元素生成合法样例（供测试/种子脚本复用） */
export function sampleElement(type, overrides = {}) {
  const base = { id: 'seed', type, stroke: '#000000', strokeWidth: 2 };
  switch (type) {
    case 'rect': return { ...base, geom: { x: 10, y: 20, w: 100, h: 60 }, ...overrides };
    case 'ellipse': return { ...base, geom: { x: 10, y: 20, w: 100, h: 60 }, ...overrides };
    case 'line': return { ...base, geom: { x1: 0, y1: 0, x2: 80, y2: 40, arrow: true }, ...overrides };
    case 'freehand': return { ...base, geom: { points: [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }] }, ...overrides };
    case 'text': return { ...base, geom: { x: 5, y: 30, text: 'hello' }, ...overrides };
    default: throw new Error(`unknown type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// S2：确定性状态哈希（供「收敛」断言，REQUIREMENTS §6.2 收敛口径）
// ---------------------------------------------------------------------------

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

/**
 * 对「元素集合」求确定性哈希。输入支持 Map<id,el> / 数组 / 普通对象。
 * 关键性质（测试 TC-S2-08/09 断言）：
 *  1) 相同元素集（同 id 同字段）→ 相同哈希，与插入顺序无关；
 *  2) 任一字段差异 → 哈希不同；
 *  3) freehand points 的**顺序**是有意义的（折线顺序），顺序不同 → 哈希不同。
 * 实现：对每个元素做「键排序后的 JSON」规范化，再按 id 排序后拼接，做 SHA-256。
 * 长度前缀用于消除 id 与 JSON 边界歧义（不依赖任何特殊分隔符）。
 */
export function stateHash(elements) {
  let entries;
  if (elements instanceof Map) entries = [...elements.entries()];
  else if (Array.isArray(elements)) entries = elements.map((e) => [e.id, e]);
  else entries = Object.entries(elements);

  const rows = entries.map(([, el]) => {
    const id = el.id;
    const canon = JSON.stringify(canonicalize(el));
    return `${id.length}:${id}${canon.length}:${canon}`;
  }).sort();

  const h = createHash('sha256');
  for (const r of rows) h.update(r);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// S6：几何命中检测（REQUIREMENTS FR-2/FR-3；TASK_BREAKDOWN S6「命中 <1ms」）
// ---------------------------------------------------------------------------

/** 点到线段的最近距离（线段退化时退化为到点距离） */
export function distPointSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** rect：包含 interior + tolerance 外扩（填充语义） */
export function hitTestRect(geom, px, py, tol = 0) {
  return (
    px >= geom.x - tol && px <= geom.x + geom.w + tol &&
    py >= geom.y - tol && py <= geom.y + geom.h + tol
  );
}

/** ellipse：内切于 bbox 的椭圆；tolerance 通过放大半轴近似（契约口径，见 README） */
export function hitTestEllipse(geom, px, py, tol = 0) {
  const cx = geom.x + geom.w / 2;
  const cy = geom.y + geom.h / 2;
  const rx = Math.max(geom.w / 2, 0);
  const ry = Math.max(geom.h / 2, 0);
  if (rx === 0 || ry === 0) return false;
  const nx = (px - cx) / (rx + tol);
  const ny = (py - cy) / (ry + tol);
  return nx * nx + ny * ny <= 1;
}

/** line（含箭头）：点到线段距离 ≤ tolerance */
export function hitTestLine(geom, px, py, tol = 0) {
  return distPointSegment(px, py, geom.x1, geom.y1, geom.x2, geom.y2) <= tol;
}

/** freehand：折线最近距离 ≤ tolerance（单点退化为到点距离） */
export function hitTestFreehand(geom, px, py, tol = 0) {
  const pts = geom.points;
  if (pts.length === 1) return Math.hypot(px - pts[0].x, py - pts[0].y) <= tol;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distPointSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tol) return true;
  }
  return false;
}

/** 通用包围盒命中（text 用：bbox = [x, y-h, w, h]，基线在 y） */
export function hitTestBox(px, py, x, y, w, h, tol = 0) {
  return px >= x - tol && px <= x + w + tol && py >= y - tol && py <= y + h + tol;
}

/**
 * text 命中：文本度量由渲染层提供（v1 单行纯文本，字体度量确定性由 opts.measure 注入）。
 * 默认近似：w = text.length * fontSize * 0.6，h = fontSize，基线在 geom.y。
 */
export function hitTestText(geom, px, py, opts = {}, tol = 0) {
  const fontSize = opts.fontSize ?? 16;
  const w = typeof opts.measure === 'function'
    ? opts.measure(geom.text, fontSize)
    : geom.text.length * fontSize * 0.6;
  return hitTestBox(px, py, geom.x, geom.y - fontSize, w, fontSize, tol);
}

/**
 * 元素集命中调度：从最上层（数组末尾）向下层遍历，返回命中的最上层元素 id，无则 null。
 * tolerance = strokeWidth/2 + slop（slop 默认 0；UI 可传 ~4px 提升点选手感）。
 */
export function hitTestElement(elements, px, py, opts = {}) {
  const slop = opts.slop ?? 0;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const tol = ((el.strokeWidth ?? 1) / 2) + slop;
    let hit = false;
    switch (el.type) {
      case 'rect': hit = hitTestRect(el.geom, px, py, tol); break;
      case 'ellipse': hit = hitTestEllipse(el.geom, px, py, tol); break;
      case 'line': hit = hitTestLine(el.geom, px, py, tol); break;
      case 'freehand': hit = hitTestFreehand(el.geom, px, py, tol); break;
      case 'text': hit = hitTestText(el.geom, px, py, opts, tol); break;
      default: hit = false;
    }
    if (hit) return el.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// S8：无限画布视口变换（世界坐标 ↔ 屏幕坐标；REQUIREMENTS FR-4）
// ---------------------------------------------------------------------------

export function validateViewport(vp) {
  return !!vp &&
    isFiniteNumber(vp.scale) && vp.scale > 0 &&
    isFiniteNumber(vp.tx) && isFiniteNumber(vp.ty);
}

/** screen = world * scale + t */
export function worldToScreen(p, vp) {
  if (!validateViewport(vp)) throw new Error('invalid viewport');
  return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
}

/** world = (screen - t) / scale */
export function screenToWorld(p, vp) {
  if (!validateViewport(vp)) throw new Error('invalid viewport');
  return { x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale };
}

// ---------------------------------------------------------------------------
// S4：presence 光标 20Hz 节流（REQUIREMENTS §6.2 光标节流口径）
// ---------------------------------------------------------------------------

/**
 * 返回 shouldSend(nowMs)。首帧即时放行一次；此后相邻两次放行间隔 ≥ 1000/rateHz。
 * 不变量（测试 TC-S4-03 断言）：首帧 true；之后发送间隔 ≥ 1/rateHz 秒。
 */
export function createThrottle(rateHz) {
  if (!(rateHz > 0)) throw new Error('rateHz must be > 0');
  const interval = 1000 / rateHz;
  let last = -Infinity;
  let first = true;
  return function shouldSend(nowMs) {
    if (first) {
      first = false;
      last = nowMs;
      return true;
    }
    if (nowMs - last >= interval - 1e-9) {
      last = nowMs;
      return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// S9：redo 并发语义状态机（REQUIREMENTS §5.3；默认「清空 redo」= 6/8 方案）
// ---------------------------------------------------------------------------

/**
 * 极简本地历史模型，用于固化 redo 语义契约（不替代 Y.UndoManager，而是声明其
 * 在并发下的可断言行为）。variant:
 *   'clear-on-remote'（默认，6/8）：撤销后一旦有远端 op 落进本人历史作用域 → redo 栈清空。
 *   'keep-replay'（少数方）：保留 redo，redo 仅重放本人 op（redo 条目本就是本人撤销产生的）。
 */
export function createHistory(variant = 'clear-on-remote') {
  if (variant !== 'clear-on-remote' && variant !== 'keep-replay') {
    throw new Error(`unknown variant: ${variant}`);
  }
  const undo = [];
  const redo = [];
  return {
    variant,
    get undoStack() { return undo; },
    get redoStack() { return redo; },
    record(op) { undo.push(op); },          // 本人一次手势 = 一条记录
    undo() {
      const op = undo.pop();
      if (op !== undefined) redo.push(op);
      return op ?? null;
    },
    redo() {
      const op = redo.pop();
      if (op !== undefined) undo.push(op);
      return op ?? null;
    },
    onRemoteOp() {
      if (variant === 'clear-on-remote') redo.length = 0;
      // keep-replay：保留 redo（条目均为本人 undo 产生），由 CRDT 独立收敛
    },
    canRedo() { return redo.length > 0; },
    canUndo() { return undo.length > 0; },
  };
}

// ---------------------------------------------------------------------------
// S5：文本纯文本渲染 / XSS 门禁（REQUIREMENTS FR-11）
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 把文本转为不可执行的纯文本（任何可能落到 DOM 的路径都先经过此函数）。 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ---------------------------------------------------------------------------
// S4/S11：presence 陈旧光标 TTL + 正常断开即时移除（REQUIREMENTS §6.2 TTL 口径）
// ---------------------------------------------------------------------------

/**
 * presence 聚合模型（供契约测试；生产由 y-protocols/awareness 承担）。
 *  - leave(id)：正常断开 → 立即移除（与 TTL 无关）。
 *  - sweep(now)：非正常断开 → 超过 ttlMs 未心跳才移除。
 * 门禁不变量（NFR-6）：presence 只在本模型/awareness 通道流转，绝不写入 Y.Doc。
 */
export function createPresence(ttlMs = 10000) {
  const peers = new Map();
  return {
    ttlMs,
    touch(id, now) { peers.set(id, { lastSeen: now }); },
    leave(id) { peers.delete(id); },
    sweep(now) {
      for (const [id, e] of peers) {
        if (now - e.lastSeen > ttlMs) peers.delete(id);
      }
    },
    has(id) { return peers.has(id); },
    size() { return peers.size; },
  };
}

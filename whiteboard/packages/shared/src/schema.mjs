// schema.mjs — v1 元素数据契约（REQUIREMENTS §3.2 / TASK_BREAKDOWN S2 / ADR-0003）
// 零依赖。行为与 tests/contract/contracts.mjs 的 validateElement / sampleElement 一致。

/** v1 元素类型：矩形/椭圆/直线(含箭头)/自由手绘/单行纯文本 */
export const ELEMENT_TYPES = ['rect', 'ellipse', 'line', 'freehand', 'text'];

/** 十六进制颜色：#rgb / #rrggbb（v1 仅这两种） */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
const isFinitePoint = (p) =>
  p !== null && typeof p === 'object' && isFiniteNumber(p.x) && isFiniteNumber(p.y);

/**
 * 校验单个元素，返回 { ok, value } 或 { ok:false, errors[] }。
 * 要点：lenient（未知字段忽略）、必填字段缺失/类型错误/非法枚举拒绝。
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

/** 生成唯一元素 id（v1 用 crypto.randomUUID） */
export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // 兜底（极老环境）
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

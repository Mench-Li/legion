// hitTest.mjs — 几何命中检测（S6 / FR-2/FR-3 / TC-S6-01..09）
// tolerance = strokeWidth/2 + slop；从最上层（数组末尾）向下遍历。

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

/** ellipse：内切于 bbox 的椭圆；tolerance 通过放大半轴近似 */
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
 * text 命中：文本度量由渲染层提供（v1 单行纯文本）。
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

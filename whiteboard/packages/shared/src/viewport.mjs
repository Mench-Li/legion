// viewport.mjs — 无限画布视口变换（S8 / FR-4 / TC-S8-01..04）
// screen = world * scale + t；scale 必须 >0 且有限，否则抛错。

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

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

// renderer.mjs — Canvas 2D 渲染器：形状+笔迹统一渲染 + 独立透明 presence overlay（S5 / ADR-0002）。
// 文本在 Canvas 上以 fillText 纯文本渲染（不执行 HTML，天然防 XSS）。

const FONT_SIZE = 16;

/** 元素世界坐标包围盒（选择/缩放手柄用） */
export function elementBounds(el) {
  const g = el.geom;
  switch (el.type) {
    case 'rect':
    case 'ellipse':
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    case 'line':
      return { x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) };
    case 'freehand': {
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const p of g.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'text':
      return { x: g.x, y: g.y - FONT_SIZE, w: g.text.length * FONT_SIZE * 0.6, h: FONT_SIZE };
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

/** 选中元素的手柄（世界坐标）。rect/ellipse 8 向；line 2 端点；text/freehand 无。 */
export function selectionHandles(el) {
  const b = elementBounds(el);
  const pad = 4;
  if (el.type === 'line') {
    return [
      { id: 'p1', x: el.geom.x1, y: el.geom.y1 },
      { id: 'p2', x: el.geom.x2, y: el.geom.y2 },
    ];
  }
  if (el.type === 'rect' || el.type === 'ellipse') {
    return [
      { id: 'nw', x: b.x - pad, y: b.y - pad },
      { id: 'n', x: b.x + b.w / 2, y: b.y - pad },
      { id: 'ne', x: b.x + b.w + pad, y: b.y - pad },
      { id: 'e', x: b.x + b.w + pad, y: b.y + b.h / 2 },
      { id: 'se', x: b.x + b.w + pad, y: b.y + b.h + pad },
      { id: 's', x: b.x + b.w / 2, y: b.y + b.h + pad },
      { id: 'sw', x: b.x - pad, y: b.y + b.h + pad },
      { id: 'w', x: b.x - pad, y: b.y + b.h / 2 },
    ];
  }
  return [];
}

export class Renderer {
  constructor(boardCanvas, overlayCanvas) {
    this.board = boardCanvas;
    this.overlay = overlayCanvas;
    this.bctx = boardCanvas.getContext('2d');
    this.octx = overlayCanvas.getContext('2d');
    this.dpr = 1;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.board.clientWidth;
    const h = this.board.clientHeight;
    this.board.width = Math.max(1, Math.round(w * dpr));
    this.board.height = Math.max(1, Math.round(h * dpr));
    this.overlay.width = this.board.width;
    this.overlay.height = this.board.height;
    this.dpr = dpr;
  }

  /** 渲染主画布（元素 + 选中态）与 presence overlay（远程光标） */
  render(state, vp, selection, cursors) {
    const dpr = this.dpr;
    const b = this.bctx;
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.clearRect(0, 0, this.board.width, this.board.height);
    b.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.tx, dpr * vp.ty);
    for (const el of state) this._drawElement(b, el);
    if (selection) this._drawSelection(b, selection);

    const o = this.octx;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    for (const c of cursors) this._drawCursor(o, c, vp);
  }

  _drawElement(ctx, el) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = el.stroke;
    ctx.fillStyle = el.fill || 'transparent';
    ctx.lineWidth = el.strokeWidth;
    ctx.font = `${FONT_SIZE}px system-ui, sans-serif`;
    const g = el.geom;

    switch (el.type) {
      case 'rect': {
        if (el.fill) ctx.fillRect(g.x, g.y, g.w, g.h);
        ctx.strokeRect(g.x, g.y, g.w, g.h);
        break;
      }
      case 'ellipse': {
        ctx.beginPath();
        ctx.ellipse(g.x + g.w / 2, g.y + g.h / 2, Math.max(g.w / 2, 0), Math.max(g.h / 2, 0), 0, 0, Math.PI * 2);
        if (el.fill) ctx.fill();
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x2, g.y2);
        ctx.stroke();
        if (g.arrow) this._drawArrow(ctx, g.x1, g.y1, g.x2, g.y2, el.strokeWidth);
        break;
      }
      case 'freehand': {
        const pts = g.points;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        break;
      }
      case 'text': {
        ctx.fillStyle = el.stroke;
        ctx.fillText(g.text, g.x, g.y);
        break;
      }
      default:
        break;
    }
  }

  _drawArrow(ctx, x1, y1, x2, y2, lw) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const s = Math.max(10, lw * 3);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang - Math.PI / 6), y2 - s * Math.sin(ang - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang + Math.PI / 6), y2 - s * Math.sin(ang + Math.PI / 6));
    ctx.stroke();
  }

  _drawSelection(ctx, el) {
    const b = elementBounds(el);
    const pad = 4;
    ctx.save();
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    for (const h of selectionHandles(el)) {
      ctx.beginPath();
      ctx.rect(h.x - 4, h.y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCursor(ctx, c, vp) {
    const sx = c.x * vp.scale + vp.tx;
    const sy = c.y * vp.scale + vp.ty;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = c.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(12, 4);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(7.5, 14);
    ctx.lineTo(4, 10);
    ctx.lineTo(0, 15);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    const label = c.name || '';
    const w = ctx.measureText(label).width;
    ctx.fillStyle = c.color;
    ctx.fillRect(10, 14, w + 10, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, 15, 26);
    ctx.restore();
  }
}

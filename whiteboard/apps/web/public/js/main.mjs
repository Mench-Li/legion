// main.mjs — 前端引导：状态 + 撤销 + 网络 + 交互 + presence + 渲染循环。
// 视口(pan/zoom)只影响本地渲染，绝不入文档/undo/同步（I4 / TC-S8-06）。

import {
  createDoc,
  applyOp,
  applyOps,
  docState,
  makeAdd,
  makePatch,
  makeDel,
  getElement,
  deserializeDoc,
} from '../shared/crdt.mjs';
import { createUndoManager } from '../shared/undo.mjs';
import { validateElement, newId } from '../shared/schema.mjs';
import { hitTestElement } from '../shared/hitTest.mjs';
import { screenToWorld, worldToScreen } from '../shared/viewport.mjs';
import { createThrottle } from '../shared/throttle.mjs';
import { Renderer, selectionHandles } from './renderer.mjs';

// ---------- 身份（localStorage 复用，TC-S4-07） ----------
const LS_KEY = 'wb.identity';
const COLORS = ['#e53935', '#8e24aa', '#3949ab', '#1e88e5', '#00897b', '#43a047', '#f4511e', '#6d4c41', '#546e7a', '#d81b60'];
function loadIdentity() {
  let id = null;
  try { id = JSON.parse(localStorage.getItem(LS_KEY)); } catch { /* ignore */ }
  if (!id || !id.clientId) {
    id = {
      clientId: newId(),
      name: `用户-${Math.random().toString(36).slice(2, 6)}`,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(id)); } catch { /* ignore */ }
  }
  return id;
}
const identity = loadIdentity();

// ---------- 状态 ----------
let doc = createDoc();
let um = createUndoManager(doc, identity.clientId, { variant: 'clear-on-remote' });
const viewport = { scale: 1, tx: 0, ty: 0 };
let selection = null;
let tool = 'select';
let peers = new Map(); // connId -> { id, name, color, x, y }
let draft = null;
let drag = null;
let spaceDown = false;

// ---------- DOM ----------
const stage = document.getElementById('stage');
const renderer = new Renderer(document.getElementById('board'), document.getElementById('overlay'));
const connDot = document.getElementById('conn');
const onlineEl = document.getElementById('online');
const peersEl = document.getElementById('peers');

// ---------- 样式（来自工具栏） ----------
function readStyle() {
  const stroke = document.getElementById('color').value;
  const strokeWidth = Number(document.getElementById('width').value);
  const fillOn = document.getElementById('fill').checked;
  const arrow = document.getElementById('arrow').checked;
  return { stroke, strokeWidth, fill: fillOn ? stroke : '', arrow };
}
let style = readStyle();

// ---------- 工具函数 ----------
const clone = (v) => JSON.parse(JSON.stringify(v));
const geomEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function screenPoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function worldPoint(e) {
  return screenToWorld(screenPoint(e), viewport);
}

function translateGeom(type, geom, dx, dy) {
  switch (type) {
    case 'rect':
    case 'ellipse':
      return { ...geom, x: geom.x + dx, y: geom.y + dy };
    case 'line':
      return { ...geom, x1: geom.x1 + dx, y1: geom.y1 + dy, x2: geom.x2 + dx, y2: geom.y2 + dy };
    case 'freehand':
      return { points: geom.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case 'text':
      return { ...geom, x: geom.x + dx, y: geom.y + dy };
    default:
      return geom;
  }
}

function resizeGeom(el, handle, geom, dx, dy) {
  if (el.type === 'line') {
    if (handle === 'p1') return { ...geom, x1: geom.x1 + dx, y1: geom.y1 + dy };
    if (handle === 'p2') return { ...geom, x2: geom.x2 + dx, y2: geom.y2 + dy };
    return geom;
  }
  let { x, y, w, h } = geom;
  if (handle.includes('e')) w += dx;
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('s')) h += dy;
  if (handle.includes('n')) { y += dy; h -= dy; }
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function makeDraftShape(type, start, cur) {
  const geom = type === 'line'
    ? { x1: start.x, y1: start.y, x2: cur.x, y2: cur.y, arrow: style.arrow }
    : { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) };
  const el = { id: 'draft', type, geom, stroke: style.stroke, strokeWidth: style.strokeWidth };
  if (type === 'rect' || type === 'ellipse') el.fill = style.fill;
  return el;
}

function draftValid(d) {
  if (!d) return false;
  if (d.type === 'rect' || d.type === 'ellipse') return d.geom.w >= 0.5 || d.geom.h >= 0.5;
  if (d.type === 'line') return Math.hypot(d.geom.x2 - d.geom.x1, d.geom.y2 - d.geom.y1) >= 1;
  if (d.type === 'freehand') return d.geom.points.length >= 2;
  return true;
}

// ---------- 网络（断线重连，TC-S11） ----------
let ws = null;
let retryDelay = 1000;

function setConn(on) {
  connDot.className = 'dot ' + (on ? 'on' : 'off');
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setConn(true);
    retryDelay = 1000;
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handleMessage(m);
  };
  ws.onclose = () => {
    setConn(false);
    peers.clear();
    updatePeers();
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 10000);
  };
  ws.onerror = () => { /* 交给 onclose 处理 */ };
}

function handleMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'welcome') {
    doc = deserializeDoc(m.doc);
    um = createUndoManager(doc, identity.clientId, { variant: 'clear-on-remote' });
    peers = new Map((m.peers || []).map((p) => [p.id, p]));
    selection = null;
    updatePeers();
    return;
  }
  if (m.type === 'op') {
    applyOps(doc, m.ops);
    um.onRemote();
    return;
  }
  if (m.type === 'presence') {
    peers.set(m.from, { id: m.from, ...m.state });
    updatePeers();
    return;
  }
  if (m.type === 'leave') {
    peers.delete(m.clientId);
    updatePeers();
    return;
  }
}

function updatePeers() {
  onlineEl.textContent = `在线: ${peers.size + (ws && ws.readyState === WebSocket.OPEN ? 1 : 0)}`;
  peersEl.innerHTML = '';
  for (const p of peers.values()) {
    const span = document.createElement('span');
    span.className = 'peer';
    span.style.background = p.color;
    span.textContent = p.name;
    peersEl.appendChild(span);
  }
}

// ---------- presence（20Hz 节流，TC-S4-03） ----------
const presenceThrottle = createThrottle(20);
let lastCursor = { x: 0, y: 0 };
function sendPresence(x, y) {
  lastCursor = { x, y };
  if (presenceThrottle(Date.now())) {
    send({ type: 'presence', state: { name: identity.name, color: identity.color, x, y } });
  }
}

// ---------- op 提交 ----------
function patchGeom(id, value, prev) {
  const op = makePatch(doc, id, 'geom', value, prev, identity.clientId);
  applyOp(doc, op);
  um.add(op);
  send({ type: 'op', ops: [op] });
}

function undo() {
  const ops = um.undo();
  if (ops.length) send({ type: 'op', ops });
}

function redo() {
  const ops = um.redo();
  if (ops.length) send({ type: 'op', ops });
}

function deleteSelection() {
  if (!selection) return;
  const el = getElement(doc, selection);
  if (!el) return;
  const op = makeDel(doc, selection, el, identity.clientId);
  um.begin();
  applyOp(doc, op);
  um.add(op);
  um.commit();
  send({ type: 'op', ops: [op] });
  selection = null;
}

function applyStyleToSelection() {
  if (!selection) return;
  const el = getElement(doc, selection);
  if (!el) return;
  const ops = [];
  if (el.stroke !== style.stroke) ops.push(makePatch(doc, selection, 'stroke', style.stroke, el.stroke, identity.clientId));
  if (el.strokeWidth !== style.strokeWidth) ops.push(makePatch(doc, selection, 'strokeWidth', style.strokeWidth, el.strokeWidth, identity.clientId));
  if ((el.type === 'rect' || el.type === 'ellipse') && (el.fill || '') !== style.fill) {
    ops.push(makePatch(doc, selection, 'fill', style.fill, el.fill || '', identity.clientId));
  }
  if (el.type === 'line' && !!el.geom.arrow !== !!style.arrow) {
    ops.push(makePatch(doc, selection, 'geom', { ...el.geom, arrow: style.arrow }, el.geom, identity.clientId));
  }
  if (ops.length) {
    um.begin();
    for (const op of ops) { applyOp(doc, op); um.add(op); }
    um.commit();
    send({ type: 'op', ops });
  }
}

// ---------- 交互 ----------
function hitHandle(el, sp) {
  for (const h of selectionHandles(el)) {
    const s = worldToScreen({ x: h.x, y: h.y }, viewport);
    if (Math.hypot(s.x - sp.x, s.y - sp.y) <= 8) return h.id;
  }
  return null;
}

stage.addEventListener('mousedown', (e) => {
  const sp = screenPoint(e);
  const wp = worldPoint(e);

  if (spaceDown || e.button === 1) {
    drag = { kind: 'pan', startX: sp.x, startY: sp.y, startVp: { ...viewport } };
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  if (tool === 'select') {
    if (selection) {
      const sel = getElement(doc, selection);
      if (sel) {
        const handle = hitHandle(sel, sp);
        if (handle) {
          um.begin();
          drag = { kind: 'resize', id: selection, handle, startGeom: clone(sel.geom), startWorld: wp, lastGeom: clone(sel.geom) };
          return;
        }
      }
    }
    const hitId = hitTestElement(docState(doc), wp.x, wp.y, { slop: 4 });
    if (hitId) {
      selection = hitId;
      const sel = getElement(doc, hitId);
      um.begin();
      drag = { kind: 'move', id: hitId, startGeom: clone(sel.geom), startWorld: wp, lastGeom: clone(sel.geom) };
    } else {
      selection = null;
    }
    return;
  }

  selection = null;
  if (tool === 'text') {
    const text = prompt('输入单行文本：');
    if (text != null && text.length) {
      const el = { id: newId(), type: 'text', geom: { x: wp.x, y: wp.y, text }, stroke: style.stroke, strokeWidth: style.strokeWidth };
      if (validateElement(el).ok) {
        const op = makeAdd(doc, el, identity.clientId);
        um.begin();
        applyOp(doc, op);
        um.add(op);
        um.commit();
        send({ type: 'op', ops: [op] });
      }
    }
    return;
  }

  um.begin();
  drag = { kind: 'draw', startWorld: wp, type: tool };
  if (tool === 'freehand') {
    draft = { id: 'draft', type: 'freehand', geom: { points: [wp] }, stroke: style.stroke, strokeWidth: style.strokeWidth };
  } else {
    draft = makeDraftShape(tool, wp, wp);
  }
});

stage.addEventListener('mousemove', (e) => {
  const sp = screenPoint(e);
  const wp = worldPoint(e);
  sendPresence(wp.x, wp.y);
  if (!drag) return;

  if (drag.kind === 'pan') {
    viewport.tx = drag.startVp.tx + (sp.x - drag.startX);
    viewport.ty = drag.startVp.ty + (sp.y - drag.startY);
    return;
  }
  if (drag.kind === 'move') {
    const dx = wp.x - drag.startWorld.x;
    const dy = wp.y - drag.startWorld.y;
    const el = getElement(doc, drag.id);
    const newGeom = translateGeom(el.type, drag.startGeom, dx, dy);
    if (!geomEq(newGeom, drag.lastGeom)) { patchGeom(drag.id, newGeom, drag.lastGeom); drag.lastGeom = newGeom; }
    return;
  }
  if (drag.kind === 'resize') {
    const dx = wp.x - drag.startWorld.x;
    const dy = wp.y - drag.startWorld.y;
    const el = getElement(doc, drag.id);
    const newGeom = resizeGeom(el, drag.handle, drag.startGeom, dx, dy);
    if (!geomEq(newGeom, drag.lastGeom)) { patchGeom(drag.id, newGeom, drag.lastGeom); drag.lastGeom = newGeom; }
    return;
  }
  if (drag.kind === 'draw') {
    if (tool === 'freehand') {
      draft.geom.points.push(wp);
    } else {
      draft = makeDraftShape(tool, drag.startWorld, wp);
    }
  }
});

stage.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.kind === 'draw') {
    if (draftValid(draft)) {
      const el = { ...draft, id: newId() };
      if (validateElement(el).ok) {
        const op = makeAdd(doc, el, identity.clientId);
        applyOp(doc, op);
        um.add(op);
        send({ type: 'op', ops: [op] });
      }
    }
    draft = null;
  }
  um.commit();
  drag = null;
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const sp = screenPoint(e);
  const worldBefore = screenToWorld(sp, viewport);
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const scale = Math.min(100, Math.max(0.01, viewport.scale * factor));
  viewport.scale = scale;
  viewport.tx = sp.x - worldBefore.x * scale;
  viewport.ty = sp.y - worldBefore.y * scale;
}, { passive: false });

// ---------- 键盘 ----------
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  const t = { v: 'select', r: 'rect', e: 'ellipse', l: 'line', p: 'freehand', t: 'text' }[e.key.toLowerCase()];
  if (t && !e.ctrlKey && !e.metaKey) setTool(t);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

// ---------- 工具栏 ----------
function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}

function wireToolbar() {
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);
  document.getElementById('del').addEventListener('click', deleteSelection);
  document.getElementById('color').addEventListener('input', () => { style = readStyle(); applyStyleToSelection(); });
  document.getElementById('width').addEventListener('input', () => { style = readStyle(); applyStyleToSelection(); });
  document.getElementById('fill').addEventListener('change', () => { style = readStyle(); applyStyleToSelection(); });
  document.getElementById('arrow').addEventListener('change', () => { style = readStyle(); applyStyleToSelection(); });
}

// ---------- 渲染循环 ----------
function loop() {
  const state = docState(doc);
  if (draft) state.push(draft);
  const selEl = selection ? getElement(doc, selection) : null;
  renderer.render(state, viewport, selEl, [...peers.values()]);
  requestAnimationFrame(loop);
}

function resizeCanvas() { renderer.resize(); }
window.addEventListener('resize', resizeCanvas);

// ---------- 启动 ----------
wireToolbar();
resizeCanvas();
connect();
requestAnimationFrame(loop);

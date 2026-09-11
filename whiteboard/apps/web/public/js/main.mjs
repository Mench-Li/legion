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
import { createPendingOps, chunkOps } from '../shared/pendingOps.mjs';
import { resolveNotice, NOTICE_POLICY, NOTICE_CONN } from '../shared/notice.mjs';
import {
  parseRoomFromSearch, buildSwitchUrl, tokenStorageKey, canWrite, errorText, isValidRoomId, roomShareUrl, DEFAULT_ROOM_ID,
} from '../shared/room.mjs';
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

// ---------- 房间与角色（P3-1） ----------
// token 优先取 URL（分享链接场景），否则从 localStorage 按房间取；URL 里的 token 会被记住，
// 但切换房间时**不写回 URL**（避免 token 留在浏览器历史/截图里）。
function readStoredToken(roomId) {
  try { return localStorage.getItem(tokenStorageKey(roomId)) || ''; } catch { return ''; }
}
const initialRoom = parseRoomFromSearch(location.search, { storedToken: null });
let roomId = initialRoom.roomId;
let roomToken = initialRoom.token || readStoredToken(roomId);
if (initialRoom.token) {
  try { localStorage.setItem(tokenStorageKey(roomId), initialRoom.token); } catch { /* ignore */ }
}
let role = 'rw'; // 由 welcome 下发；ro = 只读
let serverLimits = null;
let notice = initialRoom.notice || '';

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
const roomLabelEl = document.getElementById('room-label');
const roleEl = document.getElementById('role');
const limitEl = document.getElementById('limit');
const roomInputEl = document.getElementById('room-input');
const roomGoEl = document.getElementById('room-go');
const roomCopyEl = document.getElementById('room-copy');

// ---------- 房间/角色/治理提示的界面同步 ----------
// 提示条只有一条，所以要有优先级规则（纯逻辑在 shared/notice.mjs，细则见那里的注释）：
// **治理类**（限流/只读/服务端关闭/房间非法/旧房间操作未发送）是「可行动的说明」，优先级 1；
// **连接状态类**（暂存中/已补发）优先级 0，不得把它们顶掉。
// 真实回归（被既有 e2e 限流用例抓到）：连接被限流关闭后，后续绘制入队，队列提示把「操作过于频繁」
// 顶掉了 —— 用户看到的是「已暂存 2 个操作」，而真正该看到的是「你发得太快了」。
let noticeState = { text: '', priority: 0 };

function setNotice(text, priority = NOTICE_CONN) {
  const next = resolveNotice(noticeState, text, priority);
  if (!next.applied) return;
  notice = next.text;
  noticeState = { text: next.text, priority: next.priority };
  if (!limitEl) return;
  limitEl.textContent = notice;
  limitEl.style.display = notice ? '' : 'none';
}

function applyRoleToUi() {
  const writable = canWrite(role);
  document.body.classList.toggle('readonly', !writable);
  if (roleEl) {
    roleEl.textContent = writable ? '可编辑' : '只读';
    roleEl.className = `role ${writable ? 'rw' : 'ro'}`;
  }
  for (const el of document.querySelectorAll('.tool, #undo, #redo, #del, #color, #width, #fill, #arrow')) {
    el.disabled = !writable;
  }
  if (!writable) showHint('只读房间：可查看与移动光标，但无法绘制（服务端同样会拒绝写入）');
}

function showHint(text) {
  const hintEl = document.getElementById('hint');
  if (!hintEl) return;
  hintEl.textContent = text;
}

function syncRoomUi() {
  if (roomLabelEl) roomLabelEl.textContent = roomId;
  if (roomInputEl && document.activeElement !== roomInputEl) roomInputEl.value = roomId;
  document.title = `协作白板 · ${roomId}`;
}

/** 切换房间：改 URL（不带 token）→ 重连 → 清空本地文档态（避免把上个房间的画面留在屏上） */
function switchRoom(nextRoomId, nextToken = null) {
  if (!isValidRoomId(nextRoomId)) { setNotice(`房间 ID "${nextRoomId}" 非法（仅小写字母/数字/-/_）`, NOTICE_POLICY); return; }
  if (nextRoomId === roomId) { setNotice(''); return; }
  if (nextToken !== null) {
    roomToken = nextToken;
    try { localStorage.setItem(tokenStorageKey(nextRoomId), nextToken); } catch { /* ignore */ }
  } else {
    roomToken = readStoredToken(nextRoomId);
  }
  roomId = nextRoomId;
  history.replaceState(null, '', buildSwitchUrl(location.href, roomId));
  // 切房间要把**上一个房间**的暂存操作一起丢掉：它们属于旧房间，不可能在新区补发。
  // 但必须说出来 —— 「切房间后东西没了」正是候选 #10 报告的那种静默丢失。
  const droppedFromPrevRoom = pending.clear();
  doc = createDoc();
  um = createUndoManager(doc, identity.clientId, { variant: 'clear-on-remote' });
  selection = null;
  peers.clear();
  updatePeers();
  syncRoomUi();
  setNotice(droppedFromPrevRoom > 0
    ? `已切换房间：上一个房间有 ${droppedFromPrevRoom} 个操作未能发送（该房间连接已断开）`
    : '', NOTICE_POLICY);
  pendingNoticeText = '';
  if (ws) { try { ws.close(); } catch { /* ignore */ } }
  connect();
}

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

// ---------- 网络（断线重连，TC-S11；补发窗口见候选 #10 / P4-3） ----------
let ws = null;
let retryDelay = 1000;
// 连接未就绪（首次加载 / 断线重连 / 切房间后的新连接尚未 welcome）时，op 不能静默丢：
// 入队，welcome 后补发（见 flushPendingOps）。有界 + 可见提示，语义在 shared/pendingOps.mjs 里单测锁定。
const pending = createPendingOps();
let pendingNoticeText = '';

function setConn(on) {
  connDot.className = 'dot ' + (on ? 'on' : 'off');
}

/** 真正把消息写进 socket；返回是否写成功（false = 连接未就绪，调用方需自行决定入队或丢弃） */
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }
  return false;
}

/** 未就绪时的写入：入队 + 让用户看得见「还没发出去」，而不是静默丢弃。 */
function queueOps(ops) {
  const { size, dropped } = pending.push(ops);
  pendingNoticeText = dropped > 0
    ? `连接未就绪：已暂存 ${size} 个操作（超过上限，最早的 ${dropped} 个已丢弃）`
    : `连接未就绪：已暂存 ${size} 个操作，连上后自动补发`;
  setNotice(pendingNoticeText);
  return false;
}

/** 清掉「暂存中」提示；只清自己写的，不覆盖限流/只读等其它提示。 */
function clearPendingNotice() {
  if (pendingNoticeText && notice === pendingNoticeText) setNotice('');
  pendingNoticeText = '';
}

/**
 * welcome 之后补发暂存的操作（P4-3）。三件事都要做，少一件仍会丢用户的东西：
 *   1. 按 `maxOpsPerMessage` 分块发送——超限会被服务端以 1008 **关连接**（不是拒一条消息）；
 *   2. 在本地 doc 上**重新应用**一次：welcome 刚把 doc 换成服务端文档，而服务端不会把 op
 *      回显给发送者（index.js 的 broadcastToRoom 带 `except`），不重放就只剩服务端有、屏上没有；
 *   3. 只读角色不发（服务端会拒），但要如实提示，而不是悄悄丢掉。
 * @returns {number} 实际补发的 op 条数
 */
function flushPendingOps() {
  if (pending.size === 0) { clearPendingNotice(); return 0; }
  const ops = pending.drain();
  if (!canWrite(role)) {
    setNotice(`连接恢复前的 ${ops.length} 个操作未发送（只读房间不允许写入）`, NOTICE_POLICY);
    pendingNoticeText = '';
    return 0;
  }
  for (const op of ops) applyOp(doc, op);
  um.begin();
  for (const op of ops) um.add(op);
  um.commit();
  const maxPerMessage = serverLimits?.maxOpsPerMessage || ops.length;
  for (const part of chunkOps(ops, maxPerMessage)) send({ type: 'op', ops: part });
  clearPendingNotice();
  setNotice(`已补发连接中断期间的 ${ops.length} 个操作`);
  return ops.length;
}

/** 写入前的前端闸门（服务端另有强制）：只读角色不发 op，并给出明确提示而不是静默丢弃 */
function sendOps(ops) {
  if (!canWrite(role)) { setNotice(errorText('op_denied'), NOTICE_POLICY); return false; }
  if (send({ type: 'op', ops })) return true;
  return queueOps(ops);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = new URLSearchParams({ room: roomId });
  if (roomToken) qs.set('token', roomToken);
  ws = new WebSocket(`${proto}://${location.host}/ws?${qs.toString()}`);
  ws.onopen = () => {
    setConn(true);
    retryDelay = 1000;
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handleMessage(m);
  };
  ws.onclose = (e) => {
    setConn(false);
    peers.clear();
    updatePeers();
    // 1000/1001 多为服务端主动关闭（鉴权/限流/超限）；给出可行动提示，避免「莫名其妙掉线」
    if (e && e.code === 1008) setNotice('连接被服务端关闭（消息频率或格式超限）', NOTICE_POLICY);
    else if (e && e.code === 1009) setNotice(errorText('message_too_large'), NOTICE_POLICY);
    else if (e && e.code === 1011) setNotice('连接被关闭（服务端无法打开该房间的存储）', NOTICE_POLICY);
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
    role = m.role === 'ro' ? 'ro' : 'rw';
    serverLimits = m.limits || null;
    if (m.room && m.room !== roomId) { roomId = m.room; syncRoomUi(); }
    applyRoleToUi();
    updatePeers();
    // 房间已打开、角色/限额已下发 —— 此刻才可能补发（服务端在房间未打开时会丢弃 op）。
    flushPendingOps();
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
  if (m.type === 'error') {
    setNotice(errorText(m.code, { ...m, max: serverLimits?.maxOpsPerMessage }), NOTICE_POLICY);
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
    // 光标是瞬时状态：断线期间**不入队**（重连后由下一次移动自然补上），补发队列只装 op。
    send({ type: 'presence', state: { name: identity.name, color: identity.color, x, y } });
  }
}

// ---------- op 提交 ----------
function patchGeom(id, value, prev) {
  const op = makePatch(doc, id, 'geom', value, prev, identity.clientId);
  applyOp(doc, op);
  um.add(op);
  sendOps([op]);
}

function undo() {
  const ops = um.undo();
  if (ops.length) sendOps(ops);
}

function redo() {
  const ops = um.redo();
  if (ops.length) sendOps(ops);
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
  sendOps([op]);
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
    sendOps(ops);
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
        sendOps([op]);
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
        sendOps([op]);
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

// ---------- 房间工具栏（P3-1） ----------
function wireRoomBar() {
  if (roomGoEl) {
    roomGoEl.addEventListener('click', () => switchRoom((roomInputEl?.value || '').trim() || DEFAULT_ROOM_ID));
  }
  if (roomInputEl) {
    roomInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') switchRoom((roomInputEl.value || '').trim() || DEFAULT_ROOM_ID);
    });
  }
  if (roomCopyEl) {
    roomCopyEl.addEventListener('click', async () => {
      const url = roomShareUrl(location.href, roomId, roomToken);
      try {
        await navigator.clipboard.writeText(url);
        setNotice(`已复制房间链接（房间 ${roomId}）`);
      } catch {
        // 剪贴板不可用（非 https / 权限拒绝）→ 退回提示，不假装成功
        setNotice(`复制失败，请手动复制：${url}`);
      }
    });
  }
  // 浏览器前进/后退改 URL 时跟随切换
  window.addEventListener('popstate', () => {
    const next = parseRoomFromSearch(location.search).roomId;
    if (next !== roomId) switchRoom(next);
  });
}

// ---------- 启动 ----------
wireToolbar();
wireRoomBar();
syncRoomUi();
// URL 解析出的提示（房间号非法/无权限等）是可行动说明，按治理优先级占位，
// 不会被随后「暂存中」这类连接状态提示顶掉。
if (notice) setNotice(notice, NOTICE_POLICY);
applyRoleToUi();
resizeCanvas();
connect();
requestAnimationFrame(loop);

// security.mjs — 安全配置：全局监听安全默认值（P0）+ 房间级 token/角色（P3-1）。
//
// P0（既有契约，测试锁定）：非回环监听必须设置 WHITEBOARD_TOKEN，否则拒绝启动。
// P3-1 新增：房间级 token + 角色声明。配置形如
//   WHITEBOARD_ROOMS="main:tokA:rw, standup:tokB:ro, open-room::rw"
//   roomId:token:role   —— token 允许为空（表示该房间显式声明为开放），role ∈ {rw, ro}
// 规则（决定谁能进、进去能做什么）：
//   1) 房间**未**出现在配置里 → 沿用全局语义：设了 WHITEBOARD_TOKEN 就要带它，没设则开放（回环开发）；
//   2) 房间在配置里且 token 为空 → 开放进入（显式声明），角色按声明；
//   3) 房间在配置里且 token 非空 → 必须带匹配 token（Bearer 或 ?token=），角色按声明；
//   4) 角色 ro（只读）→ 可接收同步与 presence，但 op 写入被拒（回 `op_denied`）。
// 未声明角色时默认 rw。比较使用 timingSafeEqual（长度不等直接失败）。

import { timingSafeEqual } from 'node:crypto';

export const ROLES = Object.freeze(['rw', 'ro']);

export function validateSecurityConfig({ host = '127.0.0.1', token = '' } = {}) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !token) throw new Error('WHITEBOARD_TOKEN must be set when HOST is not loopback');
  return true;
}

/** 常量时间字符串比较（两侧都为空视为匹配） */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  if (ba.length === 0) return true;
  return timingSafeEqual(ba, bb);
}

/**
 * 解析 WHITEBOARD_ROOMS 配置串。
 * 返回 { rooms: Map<roomId, {token, role}>, errors: string[] }
 * 非法项**不静默忽略**：记入 errors，由调用方启动时打印（配置错误应当被看见）。
 */
export function parseRoomConfig(raw = '') {
  const rooms = new Map();
  const errors = [];
  const text = String(raw ?? '').trim();
  if (!text) return { rooms, errors };
  for (const chunk of text.split(',')) {
    const item = chunk.trim();
    if (!item) continue;
    const parts = item.split(':');
    if (parts.length < 2 || parts.length > 3) {
      errors.push(`无法解析房间项 "${item}"（期望 roomId:token[:role]）`);
      continue;
    }
    const [roomId, token, roleRaw] = parts;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(roomId)) {
      errors.push(`房间 ID 非法 "${roomId}"（仅允许小写字母/数字/-/_，1..64 位）`);
      continue;
    }
    const role = (roleRaw ?? 'rw').trim() || 'rw';
    if (!ROLES.includes(role)) {
      errors.push(`房间 "${roomId}" 角色非法 "${roleRaw}"（仅允许 ${ROLES.join('/')}）`);
      continue;
    }
    if (rooms.has(roomId)) {
      errors.push(`房间 "${roomId}" 重复声明`);
      continue;
    }
    rooms.set(roomId, { token: (token ?? '').trim(), role });
  }
  return { rooms, errors };
}

/**
 * 房间鉴权裁决。
 * @returns {{ok:true, role:'rw'|'ro'}|{ok:false, reason:'unauthorized'}}
 */
export function authorizeRoom({ roomId, suppliedToken = '', globalToken = '', roomConfig = new Map() } = {}) {
  const declared = roomConfig.get(roomId);
  if (!declared) {
    if (!globalToken) return { ok: true, role: 'rw' };
    return safeEqual(suppliedToken, globalToken) ? { ok: true, role: 'rw' } : { ok: false, reason: 'unauthorized' };
  }
  if (declared.token && !safeEqual(suppliedToken, declared.token)) return { ok: false, reason: 'unauthorized' };
  return { ok: true, role: declared.role };
}

/** 从 http 请求提取 token（Authorization: Bearer / ?token=） */
export function extractToken(req) {
  const bearer = req.headers?.authorization?.replace(/^Bearer\s+/i, '') || '';
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return bearer || url.searchParams.get('token') || '';
  } catch {
    return bearer;
  }
}

/** 从 http 请求提取房间 ID（?room=；缺省 default）。非法返回 null 由调用方拒绝。 */
export function extractRoomId(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const raw = url.searchParams.get('room');
    if (raw === null || raw === '') return 'default';
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw) ? raw : null;
  } catch {
    return 'default';
  }
}

// room.mjs — 房间与角色的前端纯逻辑（P3-1）。
// 放在 packages/shared 而非 apps/web：与 schema/hitTest 一样是**可在 Node 直接单测**的纯函数，
// 由 scripts/build.mjs 自动拷贝到 apps/web/public/shared/ 供浏览器加载（无构建步骤）。

/** 房间 ID 规则：与服务端 rooms.mjs 保持一致（小写字母/数字开头，允许 - 与 _，1..64 位）。 */
export const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_ROOM_ID = 'default';

export function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id);
}

/**
 * 从 URL 查询串解析房间与 token。
 * 规则：
 *   - `?room=` 缺失或非法 → 回落到 default **并给出提示原因**（不静默改房间）；
 *   - `?token=` 出现在 URL 里 → 作为该房间的 token 返回（调用方可选择记住它）；
 *   - 未给 token 时由调用方从存储补。
 * @returns {{ roomId, token, remembered, notice? }}
 */
export function parseRoomFromSearch(search, { storedToken = null } = {}) {
  const params = new URLSearchParams(String(search ?? ''));
  const rawRoom = params.get('room');
  const rawToken = params.get('token');
  const out = { roomId: DEFAULT_ROOM_ID, token: rawToken ?? storedToken ?? '', remembered: false, notice: undefined };
  if (rawRoom === null || rawRoom === '') return out;
  if (!isValidRoomId(rawRoom)) {
    out.notice = `房间 ID "${rawRoom}" 非法（仅允许小写字母/数字/-/_），已回到默认房间`;
    return out;
  }
  out.roomId = rawRoom;
  return out;
}

/** 切换房间时构造新的查询串（保留 token 与否由调用方决定；token 不写进 URL，避免留在浏览器历史里） */
export function buildSwitchUrl(currentHref, roomId) {
  const url = new URL(String(currentHref), 'http://localhost');
  url.searchParams.set('room', roomId);
  url.searchParams.delete('token');
  return `${url.pathname}${url.search}`;
}

/** token 存取键（按房间隔离：同一浏览器可同时持有多个房间的 token） */
export function tokenStorageKey(roomId) {
  return `wb.token.${roomId}`;
}

/**
 * 角色能力判定：只读角色不能写，但仍可看、可发 presence（只读 ≠ 隐身）。
 * 返回的前端用来禁用按钮/拦截操作，服务端另有强制（双层）。
 */
export function canWrite(role) {
  return role !== 'ro';
}

/** 错误帧 → 用户可读文案（与服务端 WEB_ERR 风格的 code 对齐） */
export function errorText(code, extra = {}) {
  switch (code) {
    case 'op_denied': return '当前为只读角色，无法绘制（可查看与移动光标）';
    case 'rate_limited':
      return extra.retryAfterMs
        ? `操作过于频繁，本条已丢弃（约 ${Math.max(1, Math.round(extra.retryAfterMs))}ms 后可重试）`
        : '消息频率超限，连接即将关闭';
    case 'message_too_large': return '单条消息过大，连接已关闭（减少一次操作的图形数量）';
    case 'too_many_ops': return `一次提交的操作过多（上限 ${extra.max ?? '?'}），连接已关闭`;
    case 'malformed_message': return '消息格式错误，连接已关闭';
    case 'max_rooms': return '服务器房间数已达上限，暂时无法进入新房间';
    case 'storage_open_failed':
    case 'storage_load_failed': return '房间存储不可用，无法进入该房间';
    default: return extra.message ? String(extra.message) : `未知错误：${code}`;
  }
}

/** 生成房间链接（分享用；含 token 时才附 token——由调用方决定是否分享） */
export function roomShareUrl(href, roomId, token = '') {
  const url = new URL(String(href), 'http://localhost');
  url.searchParams.set('room', roomId);
  if (token) url.searchParams.set('token', token); else url.searchParams.delete('token');
  return url.toString();
}

// workbench/src/accountProfile.ts
// ============================================================================
// 账号管理（P0）的**纯函数**：显示名校验、账号摘要/计数、时间投影。
//
// 为什么单独一个文件：指挥台没有组件测试环境（无 jsdom），而这些规则
// （trim、1–64、拒绝 C0 控制字符、活跃会话/执行设备的计数口径）恰恰是
// 最容易写错、也最值得逐条钉住的部分。抽出来之后用 node --test 直接跑 TS
// 源码（ts.transpileModule），零新增依赖。
//
// 口径以服务端为准：`validateDisplayName` 与 team-hub/user-store.mjs 的同名
// 函数使用同一批输入必须得到同一结论（parity 用例见 account-profile.test.mjs）。
// ============================================================================
import type { DeviceRow, MeInfo, SessionRow } from './identity'

/** 显示名校验结果：成功带 trim 后的最终值，失败带可读中文。 */
export type DisplayNameResult =
  | { ok: true; value: string }
  | { ok: false; message: string }

/** 长度上限 = 用户名上限（String.length，UTF-16 code unit）。 */
export const DISPLAY_NAME_MAX = 64

/**
 * 与团队中枢**同一套**规则（服务端为准）：
 *   1. 必须是字符串；
 *   2. **先**拒绝 C0 控制字符（U+0000–U+001F、U+007F，含换行）——必须在 trim 之前，
 *      否则 "Ali\nce" 这种内部换行会被 trim 放行；
 *   3. 再 trim；trim 后长度 1–64。
 *
 * 不要求唯一：显示名是展示属性，唯一性交给登录用户名。
 */
export function validateDisplayName(input: unknown): DisplayNameResult {
  if (typeof input !== 'string') return { ok: false, message: '显示名必须是字符串' }
  if (/[\u0000-\u001F\u007F]/.test(input)) {
    return { ok: false, message: '显示名不能包含控制字符或换行' }
  }
  const value = input.trim()
  if (value.length === 0) return { ok: false, message: '显示名不能为空' }
  if (value.length > DISPLAY_NAME_MAX) return { ok: false, message: `显示名不超过 ${DISPLAY_NAME_MAX} 个字符` }
  return { ok: true, value }
}

export type SessionInput =
  | SessionRow[]
  | { rows?: SessionRow[]; currentId?: string | null }
  | null
  | undefined

export interface AccountSummary {
  /** 未撤销的登录会话（按服务端顺序）。 */
  activeSessions: SessionRow[]
  /** 活跃会话数 = 未撤销会话数；**不含**已撤销/已过期（过期是 P1 展示态）。 */
  activeSessionCount: number
  /** 本用户的未撤销执行设备。 */
  activeDevices: DeviceRow[]
  /** 执行设备数 = 未撤销且归属本人的设备数（管理员会拿到全部设备）。 */
  deviceCount: number
  /** 当前会话（若在活跃列表里）。 */
  currentSession: SessionRow | null
}

function sessionRows(input: SessionInput): SessionRow[] {
  if (Array.isArray(input)) return input
  if (input === null || input === undefined) return []
  return Array.isArray(input.rows) ? input.rows : []
}

/**
 * 账号信息区/摘要的**计数口径**（R-03）。
 *
 * ★ 两个数字来自两份独立数据，不能用其中一个冒充另一个：
 *   · 活跃会话数：/api/identity/sessions 里 revoked !== true 的行数；
 *   · 执行设备数：/api/devices 里 revoked !== true **且 userId === 本人** 的行数。
 *
 * 第二条的 `userId` 过滤不是防御性代码：管理员调用 /api/devices 会拿到**全部**
 * 设备（routes/identity.mjs），直接 `.length` 会让管理员的"我的设备"虚高。
 */
export function accountSummary(
  me: Pick<MeInfo, 'userId'> | null | undefined,
  sessions: SessionInput,
  devices: DeviceRow[] | null | undefined,
): AccountSummary {
  const rows = sessionRows(sessions)
  const activeSessions = rows.filter((s) => s.revoked !== true)
  const currentId = !Array.isArray(sessions) && sessions !== null && sessions !== undefined ? sessions.currentId ?? null : null
  const currentSession = currentId === null ? null : activeSessions.find((s) => s.sessionId === currentId) ?? null
  const allDevices = Array.isArray(devices) ? devices : []
  const userId = me?.userId ?? null
  const activeDevices = userId === null
    ? []
    : allDevices.filter((d) => d.revoked !== true && (d.userId === undefined || d.userId === userId))
  return {
    activeSessions,
    activeSessionCount: activeSessions.length,
    activeDevices,
    deviceCount: activeDevices.length,
    currentSession,
  }
}

/**
 * 注册时间的展示投影：合法 ISO → 本地时间文本；缺失/非法 → 「—」（不抛错）。
 *
 * 原始 ISO 值仍保留在 MeInfo.createdAt 里，供调试/测试断言。
 */
export function formatCreatedAt(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.trim().length === 0) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

/** 无头像（P0）时的中性占位：显示名首字符；空值回落「?」。 */
export function displayNameInitial(displayName: string | null | undefined): string {
  const value = typeof displayName === 'string' ? displayName.trim() : ''
  return value.length > 0 ? Array.from(value)[0] : '?'
}

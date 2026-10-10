// team-hub/agent-avatars.mjs
// 编队成员头像令牌的服务端口径 —— 与 workbench/src/avatar/slots.ts 的 25 个内置岗位 key 对齐。
//
// 令牌 = `human:<key>`：内置岗位 key = role（跨空间恒同，AC-R5-1）；自建/空间专属 role
// 由 allocateAvatarToken() 按该空间最小未占用备用 key sNN 分配（构造性不重复，AC-R3-3）。
// 旧 emoji / 非法字符串一律**不落库**，只落合法令牌（AC-R3-1、将军裁决 #2）。
export const BUILTIN_ROLE_KEYS = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
]

/** 合法令牌：human:<小写字母/数字开头，可含连字符>。 */
export const AVATAR_TOKEN_RE = /^human:[a-z0-9][a-z0-9-]*$/

export function isAvatarToken(value) {
  return typeof value === 'string' && AVATAR_TOKEN_RE.test(value.trim())
}

/** 内置岗位 → 令牌；非内置返回 null（调用方走备用池）。 */
export function builtinAvatarFor(role) {
  return BUILTIN_ROLE_KEYS.includes(role) ? 'human:' + role : null
}

/** 该 scope 内未被占用的最小备用 key sNN（s01..s99）；池满时确定性地退回 human:<role>。 */
export function allocateAvatarToken(db, scope, role) {
  const builtin = builtinAvatarFor(role)
  if (builtin) return builtin
  const used = new Set(
    db.prepare("SELECT avatar FROM roster WHERE scope = ? AND avatar LIKE 'human:s%'").all(scope)
      .map(row => row.avatar),
  )
  for (let i = 1; i <= 99; i += 1) {
    const token = 'human:s' + String(i).padStart(2, '0')
    if (!used.has(token)) return token
  }
  return 'human:' + role
}

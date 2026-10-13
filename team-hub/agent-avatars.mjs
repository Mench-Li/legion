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

/**
 * **纯计算**：编队里哪些行还不是合法令牌、各自该拿到哪个令牌（不写库）。
 *
 * ★ 预演与真跑**必须**出自同一个函数：一份"看起来会这么改"的预演，
 *   与一份"其实那样改"的执行，是两件事——而它们分头实现时，
 *   分歧只会在**有人照着预演做决定之后**才暴露。
 *
 * 分配规则：
 *   · 内置岗位 → `human:<role>`（跨空间恒同，AC-R5-1）；
 *   · 自建/空间专属 role → 该空间**最小未占用**备位 `human:sNN`（AC-R3-3）；
 *   · **已经合法**的行跳过，但它占用的 sNN 要计入（否则新分配会撞上已有的）。
 *
 * @returns {Array<{scope: string, role: string, from: string|null, to: string}>}
 */
export function planRosterAvatarMigration(db, { scope = null } = {}) {
  const rows = scope === null || scope === undefined
    ? db.prepare('SELECT scope, role, avatar FROM roster ORDER BY scope, role').all()
    : db.prepare('SELECT scope, role, avatar FROM roster WHERE scope = ? ORDER BY scope, role').all(scope)
  const usedByScope = new Map()
  for (const row of rows) {
    if (!isAvatarToken(row.avatar)) continue
    const token = String(row.avatar).trim()
    if (!token.startsWith('human:s')) continue
    if (!usedByScope.has(row.scope)) usedByScope.set(row.scope, new Set())
    usedByScope.get(row.scope).add(token)
  }
  const plan = []
  for (const row of rows) {
    if (isAvatarToken(row.avatar)) continue
    const builtin = builtinAvatarFor(row.role)
    let token = builtin
    if (token === null) {
      if (!usedByScope.has(row.scope)) usedByScope.set(row.scope, new Set())
      const used = usedByScope.get(row.scope)
      let i = 1
      while (i <= 99 && used.has('human:s' + String(i).padStart(2, '0'))) i += 1
      token = i <= 99 ? 'human:s' + String(i).padStart(2, '0') : 'human:' + row.role
      used.add(token)
    }
    plan.push({ scope: row.scope, role: row.role, from: row.avatar ?? null, to: token })
  }
  return plan
}

/**
 * 把编队里**还不是令牌**的头像就地迁成合法令牌（幂等）。
 *
 * ## 为什么必须有这一步（否则整套头像功能等于没做）
 *
 * 渲染器的判据只有一条：`human:<key>` 能查到 40 个位面之一，否则落到**同一个灰阶占位人形**。
 * 而功能上线时库里那些行存的还是**旧 emoji**（🧭🔍💻🚀…）—— 实测 software 空间 8 行、
 * 全库 24 行**无一**是合法令牌，于是它们全部渲染成同一个灰色剪影，
 * **界面上看起来就像"这个功能根本没做"**。
 *
 * T-199 的实现口径把这件事写成「回退只是渲染态，**不写回 roster**」：
 * 那是**对**的（渲染不该偷偷改数据），但它同时意味着**没有任何东西会自愈**——
 * 必须有人显式跑一次迁移。
 *
 *   > 一个"渲染时优雅回退"的设计，与一个"数据永远不迁移"的设计，
 *   > 在**第一次打开界面**时是同一张灰色剪影——
 *   > 只不过前者以为自己已经做完了。
 *
 * ## 与 `seed-roster.mjs` 的分工
 *
 *   · `seed-roster` 负责 5 个内置空间的**名字 + 头像**（两段式展示名），只覆盖 25 个内置岗位，
 *     并且会 `INSERT` 出那 5 个空间；
 *   · 本函数只管**头像能不能解析**，覆盖**所有** scope、**只改已有的行** ——
 *     自建/空间专属 role（ozon 的 `soldier-*`、gf001 的 `implementer`）不在种子名单里，
 *     由 `planRosterAvatarMigration()` 按该空间最小未占用备用位面分配。
 *
 * 两者都幂等；用户自定义过的合法令牌原样保留（AC-R10-1）。
 *
 * @param {{prepare: Function}} db better-sqlite3 / node:sqlite 风格的库
 * @param {{scope?: string|null, plan?: Array}} [opts] 只迁某个空间；`plan` 可直接喂预演结果
 * @returns {{scanned: number, migrated: Array<{scope: string, role: string, from: string|null, to: string}>}}
 */
export function migrateRosterAvatars(db, { scope = null, plan = null } = {}) {
  const rows = scope === null || scope === undefined
    ? db.prepare('SELECT scope, role, avatar FROM roster ORDER BY scope, role').all()
    : db.prepare('SELECT scope, role, avatar FROM roster WHERE scope = ? ORDER BY scope, role').all(scope)
  const planned = Array.isArray(plan) ? plan : planRosterAvatarMigration(db, { scope })
  const update = db.prepare('UPDATE roster SET avatar = ? WHERE scope = ? AND role = ?')
  const migrated = []
  for (const item of planned) {
    // 按 plan 写库。写前**再确认一次**这一行现在仍不是合法令牌 ——
    // 预演与执行之间可能有人动过库，而照着过期计划覆盖别人刚设好的头像是最糟的结果。
    const cur = rows.find(r => r.scope === item.scope && r.role === item.role)
    if (cur && isAvatarToken(cur.avatar)) continue
    update.run(item.to, item.scope, item.role)
    migrated.push({ scope: item.scope, role: item.role, from: item.from ?? null, to: item.to })
  }
  return { scanned: rows.length, migrated }
}

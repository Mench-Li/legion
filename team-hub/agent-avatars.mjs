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

/**
 * **外部执行者**（未入编队、由 `tasks.soldier` 合成的伪成员）的冻结令牌表。
 *
 * 为什么是一张**静态表**而不是哈希派生：这张表可以**逐条断言**（构造性唯一，
 * AC-R4-1/AC-R4-2），而哈希只能给"大概率不撞"；静态表还让同一个名字跨请求、
 * 跨重启、跨两端恒定（AC-R5-1），不受"当前占用集合"变化影响。
 * 未登记的名字才走确定性兜底（见 `externalAvatarFor`）。
 *
 * 位面 key 取空闲备用池 s11..s15：不与 25 个内置岗位 key 撞，也不与 software
 * 8 个内编岗位当前使用的 key 撞（AC-R3-3/AC-R4-2）。本表与 workbench 端
 * `workbench/src/avatar/external-agents.ts` 由 parity 套件逐项 deepEqual 锁死。
 */
export const EXTERNAL_AVATAR_TOKENS = {
  general: 'human:s11',
  'soldier-a': 'human:s12',
  'soldier-b': 'human:s13',
  'soldier-auto': 'human:s14',
  'soldier-market': 'human:s15',
}

/** 冻结令牌占用的备用 key：兜底分配必须避开它们（已点名身份永不漂移）。 */
const EXTERNAL_FROZEN_TOKENS = new Set(Object.values(EXTERNAL_AVATAR_TOKENS))

/** FNV-1a 32 位（零依赖、确定性；与 workbench/src/scene/sceneState.ts 同一算法）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * **纯函数**：外部执行者身份名 → 头像令牌（RESEARCH §6.5）。
 *
 *   ① 冻结表命中 ⇒ 恒返回表里的令牌（与 usedTokens / 传入顺序无关，AC-R5-1）；
 *   ② 未命中 ⇒ 在**未被占用的空闲备用位面**（s01..s10，s11..s15 被冻结表保留）
 *      里按 `FNV-1a(name) % candidates.length` 确定性选一个；
 *   ③ 池满 / 空名 / 非字符串 ⇒ 返回空串 `''`（占位语义；**绝不**返回 emoji
 *      或非法字符串，AC-R7-1/AC-R7-2）。
 *
 * ★ 分配路径不含随机数 / 时钟 / 网络（纯函数，AC-R5-3）。
 *
 * @param {unknown} name 外部执行者身份名（`tasks.soldier`）
 * @param {Iterable<string>|null|undefined} usedTokens 已占用的令牌（roster 头像 + 本次已分配）
 * @returns {string} `human:<key>` 或 `''`
 */
export function externalAvatarFor(name, usedTokens = []) {
  if (typeof name !== 'string') return ''
  const key = name.trim()
  if (!key) return ''
  const frozen = EXTERNAL_AVATAR_TOKENS[key]
  if (frozen) return frozen
  const used = new Set()
  if (usedTokens) for (const token of usedTokens) if (isAvatarToken(token)) used.add(token.trim())
  const candidates = []
  for (let i = 1; i <= 15; i += 1) {
    const token = 'human:s' + String(i).padStart(2, '0')
    if (EXTERNAL_FROZEN_TOKENS.has(token) || used.has(token)) continue
    candidates.push(token)
  }
  if (candidates.length === 0) return ''
  return candidates[fnv1a(key) % candidates.length]
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

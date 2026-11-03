// team-hub/mentions.mjs
// ============================================================================
// F3 · `@` 的三种语义（设计稿 §3 F3 / M4）
//
// 一条评论因为「@ 了谁」而分流：
//   无 @          → comment   普通批注 / 打回（今天的行为）
//   @<其他角色>    → order     追加续跑（"做过的地方再补一点"）
//   @general     → escalate  升级为提问（人要拍板，不是顺手活）
//
// ★ 四条护栏（设计稿 I-3.1 ~ I-3.5）
//   ① 只认 **scope 成员**：@ 一个不在编队里的角色不算提及（但记为 unknown，便于诊断）
//   ② 只在**可续跑状态**（in_progress / awaiting_answer）才投递；其它状态只写输入
//   ③ **自己 @ 自己忽略**：记进 ignoredSelf，不静默吞掉
//   ④ 幂等：重复 @ 同一个人只算一次；`@` 只把强度提到 explicit，**永不绕过闸**
//
// ★ 为什么解析要抽成纯函数
//   守护、路由、看板三处都要判"这句话是对谁说的"。三份正则必然漂移，
//   而漂移的表现是"同一个 @ 在不同层被理解成不同的事"——最难查的一类不一致。
// ============================================================================

export const MENTION_EFFECTS = Object.freeze(['comment', 'order', 'escalate'])

/** 只有这些状态才谈得上"续跑"（设计稿 I-3.2）。 */
export const DELIVERABLE_STATUSES = Object.freeze(['in_progress', 'awaiting_answer'])

/**
 * `@role` 的边界正则。
 *
 * 关键在**前面不能是单词字符或 @**：`me@example.com`、`foo@coder` 都不是提及。
 * 角色名允许小写字母 / 数字 / 连字符 / 下划线（与 agent_registry.role 一致）。
 */
const MENTION_RE = /(^|[^\w@.\-])@([a-z0-9][a-z0-9_-]*)/gi

/**
 * 解析文本里的提及。纯函数。
 *
 * @param text
 * @param opts.roles      当前 scope 的成员角色（不在其中的记为 unknown）
 * @param opts.selfRole   评论者自己的角色（用于自 @ 忽略）
 * @returns {{ mentions: Array<{role: string, isSelf: boolean, known: boolean}>,
 *             addresses: string[], ignoredSelf: string[], unknownRoles: string[] }}
 */
export function parseMentions(text, { roles = [], selfRole = null } = {}) {
  const source = typeof text === 'string' ? text : ''
  const known = new Set((Array.isArray(roles) ? roles : []).map((r) => String(r).toLowerCase()))
  const self = typeof selfRole === 'string' ? selfRole.toLowerCase() : null

  const mentions = []
  const seen = new Set()
  MENTION_RE.lastIndex = 0
  let match
  while ((match = MENTION_RE.exec(source)) !== null) {
    const role = String(match[2]).toLowerCase()
    if (seen.has(role)) continue // 幂等：同一个人只算一次
    seen.add(role)
    mentions.push({ role, isSelf: self !== null && role === self, known: known.size === 0 || known.has(role) })
  }

  const addresses = []
  const ignoredSelf = []
  const unknownRoles = []
  for (const m of mentions) {
    if (m.isSelf) { ignoredSelf.push(m.role); continue }
    if (!m.known) { unknownRoles.push(m.role); continue }
    addresses.push(m.role)
  }
  return { mentions, addresses, ignoredSelf, unknownRoles }
}

/**
 * 把一条评论分流成语义。
 *
 * @param input.text        评论正文
 * @param input.author      评论者（成员名）
 * @param input.soldier     任务当前士兵（用于自 @ 判定）
 * @param input.status      任务状态
 * @param input.scopeRoles  该 scope 的成员角色
 * @returns {{ effect: 'comment'|'order'|'escalate', addressedTo: string[],
 *             ignoredSelf: string[], unknownRoles: string[],
 *             deliverable: boolean, reason: string }}
 */
export function classifyComment({ text, author = null, soldier = null, status = null, scopeRoles = [] } = {}) {
  const selfRole = author !== null && soldier !== null && String(author) === String(soldier) ? String(author) : null
  const parsed = parseMentions(text, { roles: scopeRoles, selfRole })
  const addressedTo = parsed.addresses

  let effect = 'comment'
  if (addressedTo.length > 0) {
    // escalate 优先：人要拍板的事，不能因为顺手 @ 了执行者也降级成 order。
    effect = addressedTo.includes('general') ? 'escalate' : 'order'
  }

  const deliverableStates = DELIVERABLE_STATUSES.includes(String(status))
  const deliverable = effect !== 'comment' && deliverableStates
  let reason = 'no-mention'
  if (effect === 'escalate') reason = 'mention-general'
  else if (effect === 'order') reason = 'mention-role'
  if (effect !== 'comment' && !deliverableStates) reason = 'status-not-deliverable'

  return {
    effect,
    addressedTo: [...addressedTo],
    ignoredSelf: [...parsed.ignoredSelf],
    unknownRoles: [...parsed.unknownRoles],
    deliverable,
    reason,
  }
}

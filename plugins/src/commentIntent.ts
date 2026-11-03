// plugins/src/commentIntent.ts
// ============================================================================
// F3 · 守护侧：一条「他人评论」是**打回**还是**追加**（设计稿 §3 F3）
//
// 今天两者走同一条路（都当"退回纠错"）。于是：
//   · 「顺手再加个日志」被当成失败，退避计数跟着涨；
//   · 士兵 `@general` 请人拍板，守护却把它当打回、继续派工，
//     和 F2 的派工闸顶牛（人还没答，活又被派下去了）。
//
// ★ 与 team-hub 的 `mentions.mjs` 规则同源（边界正则 / 只认成员 / 自 @ 忽略 / 幂等）。
//   为什么不共享代码：两个包之间没有运行时依赖（守护只经 HTTP 与中枢说话，DEC-2）。
//   两边各有一份判据表，规则变更时**两张表一起改**——这是刻意付出的重复代价。
// ============================================================================

export const MENTION_INTENTS = Object.freeze(['rework', 'order', 'escalate'] as const)
export type MentionIntent = (typeof MENTION_INTENTS)[number]

export interface FeedbackIntent {
  intent: MentionIntent
  addressedTo: string[]
  ignoredSelf: string[]
  unknownRoles: string[]
  /** `false` 表示守护这轮应当**停手**（例如已升级为提问，等人拍板）。 */
  deliverable: boolean
}

/** 与 team-hub 相同的边界规则：前一个字符不能是单词字符 / `@` / 点 / 连字符。 */
const MENTION_RE = /(^|[^\w@.\-])@([a-z0-9][a-z0-9_-]*)/gi

function parse(text: string, roles: string[]): { addresses: string[]; ignoredSelf: string[]; unknownRoles: string[] } {
  const known = new Set(roles.map((r) => r.toLowerCase()))
  const seen = new Set<string>()
  const found: string[] = []
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(text)) !== null) {
    const role = m[2].toLowerCase()
    if (seen.has(role)) continue
    seen.add(role)
    found.push(role)
  }
  return { addresses: found, ignoredSelf: [], unknownRoles: [] }
}

/**
 * 判定一批反馈文本的意图。**只看最后一条非空评论**：旧评论里的 `@` 不该复活。
 */
export function classifyFeedback(input: {
  texts: string[]
  author?: string | null
  soldier?: string | null
  roles?: string[]
}): FeedbackIntent {
  const roles = (input.roles ?? []).map((r) => r.toLowerCase())
  const texts = (input.texts ?? []).filter((t) => typeof t === 'string' && t.trim() !== '')
  const latest = texts.length > 0 ? texts[texts.length - 1] : ''
  if (latest === '') {
    return { intent: 'rework', addressedTo: [], ignoredSelf: [], unknownRoles: [], deliverable: false }
  }

  const self = input.author !== null && input.author !== undefined
    && input.soldier !== null && input.soldier !== undefined
    && String(input.author) === String(input.soldier)
    ? String(input.author).toLowerCase()
    : null

  const known = new Set(roles.length > 0 ? roles : [])
  const parsed = parse(latest, roles)
  const addressedTo: string[] = []
  const ignoredSelf: string[] = []
  const unknownRoles: string[] = []
  for (const role of parsed.addresses) {
    if (self !== null && role === self) { ignoredSelf.push(role); continue }
    // roles 为空时不当作"没有编队信息"：宽松放行（守护侧拿不到 roster 时不该让 @ 全部失效）
    if (known.size > 0 && !known.has(role)) { unknownRoles.push(role); continue }
    addressedTo.push(role)
  }

  if (addressedTo.length === 0) {
    return { intent: 'rework', addressedTo, ignoredSelf, unknownRoles, deliverable: true }
  }
  if (addressedTo.includes('general')) {
    // 升级为提问：守护停手，等人拍板（与 team-hub 的 escalate 语义一致）
    return { intent: 'escalate', addressedTo, ignoredSelf, unknownRoles, deliverable: false }
  }
  return { intent: 'order', addressedTo, ignoredSelf, unknownRoles, deliverable: true }
}

/**
 * 对话 AI 回复（R-4，S10 + R-2/R-3，S5）纯函数：提示词拼装与回复方身份解析。
 *
 * 纪律（对齐 docs/TEST_CASES.md TC-S10-01..06 / TC-S5-01..12 与决策 D1）：
 *   - 回复方身份默认 <scope>-assistant，可被空间 settings.identity 覆盖（chatIdentityFor）；
 *   - 提示词 = 空间对话助手 + systemHint +（可选）工作空间只读上下文块 +（可选）本次随消息上传的文件块
 *     + 会话历史（含提问本身）+ 收尾提问；纯文本、无仓库工具；
 *   - S5（决策 D1）：spaceDigest / attachments 注入为独立块（角色 → 行为约束 → systemHint → 摘要 → 附件 → 历史 → 提问），
 *     缺省（undefined）不产块（向后兼容 TC-S5-04）；null / 空摘要（未绑定/读取失败）产明示降级占位（AC-R2-4，TC-S5-06）；
 *     附件读取失败 → 「（附件 <name> 读取失败：原因）」占位，不含假内容（AC-R4-5，TC-S5-07）；
 *   - 预算（AC-R4-1，TC-S5-05）：合计外部上下文正文默认 ≤ CHAT_CTX_BUDGET_CHARS(8000)，
 *     单附件 ≤ CHAT_CTX_FILE_CAP_CHARS(4000)；超预算先裁摘要、后裁最旧附件、保留最新附件并带「已截断」标记；
 *   - 注入安全（TC-S5-09）：会话历史/摘要/附件/systemHint 等外部文本一律替换 '<'（防 HTML/提示词注入面）；
 *   - 只处理作者 ≠ 回复方身份的 awaiting 消息（防自我触发死循环，防注入冒名）。
 * 纯函数、无 I/O；node --test 直接单测。
 */

export interface ChatCtxMsg {
  id: number
  author: string
  body: string
}

/** S5：空间摘要（R-2/C1；未绑定/读取失败由调用方以 null 或空 text + unavailable 表达降级）。 */
export interface ChatCtxDigest {
  text: string
  /** 来源说明（如「取自绑定仓库」）。 */
  sourceNote?: string
  /** 摘要生成时间。 */
  generatedAt?: string
  /** 内容不可用原因（仅 text 为空时展示；无则用固定降级文案）。 */
  unavailable?: string
}

/** S5：随消息上传的附件引用 + 内容（content 为 null 且带 readError → 失败占位，不冒充）。 */
export interface ChatCtxAttachment {
  id: number
  fileName: string
  size: number
  content: string | null
  readError?: string
  truncated?: boolean
}

export interface ChatAnswerInput {
  scope: string
  convTitle?: string
  /** 空间设置里的 systemHint（无则省略）。 */
  systemHint?: string | null
  /** 会话历史（不含提问本身之外的更早上下文由服务端聚合好）。 */
  context: ChatCtxMsg[]
  /** 本空间回复方身份。 */
  identity: string
  /** S5：空间摘要（undefined = 未启用不产块；null/空 = 降级占位）。 */
  spaceDigest?: ChatCtxDigest | null
  /** S5：本次随消息上传的附件。 */
  attachments?: ChatCtxAttachment[]
  /** S5：外部上下文总预算（默认读 CHAT_CTX_BUDGET_CHARS，8000）。 */
  contextBudgetChars?: number
}

/** 单块注入上限（默认读 CHAT_CTX_FILE_CAP_CHARS，4000；与 S4 口径一致）。 */
function fileCapChars(): number {
  const n = Number(process.env.CHAT_CTX_FILE_CAP_CHARS || 4000)
  return Number.isFinite(n) && n > 0 ? n : 4000
}

function contextBudgetChars(input: ChatAnswerInput): number {
  if (Number.isFinite(input?.contextBudgetChars) && Number(input.contextBudgetChars) > 0) return Number(input.contextBudgetChars)
  const n = Number(process.env.CHAT_CTX_BUDGET_CHARS || 8000)
  return Number.isFinite(n) && n > 0 ? n : 8000
}

/** 注入文本安全化：剔除控制符并把 '<' 换成全角（防 HTML/标签注入原样进入提示词，TC-S5-09）。 */
function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/</g, '＜')
}

/** 回复方身份（D-15/G-R4-2）：默认 <scope>-assistant；settings.identity 覆盖。 */
export function chatIdentityFor(scope: string, identityOverride?: string | null): string {
  const sc = (scope || '').trim()
  if (identityOverride && identityOverride.trim().length > 0) return identityOverride.trim()
  return sc.length > 0 ? sc + '-assistant' : 'assistant'
}

/** 工作空间摘要块的降级占位（AC-R2-4 / AC-R4-5，TC-S5-06）。 */
function digestPlaceholder(d: ChatCtxDigest | null): string {
  if (d && d.unavailable && d.unavailable.trim().length > 0) {
    return '（当前空间内容不可用：' + sanitizeText(d.unavailable.trim()) + '）'
  }
  return '（当前空间未绑定可读本地仓库，无法提供工作空间内容上下文）'
}

/** 截断工具：超 limit 时裁到 limit-marker 长度并加「已截断」标记；limit ≤0 → 空串。 */
function cutTo(s: string, limit: number, marker = '…（已截断）'): string {
  if (limit <= 0) return ''
  if (s.length <= limit) return s
  return s.slice(0, Math.max(0, limit - marker.length)) + marker
}

interface BudgetedCtx {
  digestText: string
  atts: ChatCtxAttachment[]
  truncated: boolean
}

/**
 * 预算分配（AC-R4-1，TC-S5-05，正文级拟合，确定性）：
 *   1) 每个附件正文先按单文件上限（fileCap）截断；
 *   2) 摘要正文可裁（digestReducible=true 时）——降级占位（不可裁）恒保留；
 *   3) 附件合计仍超剩余预算 → 自最旧开始丢弃，至少保留最新一条（单条仍超 → 截到剩余预算内）。
 */
function fitContextBudget(digestText: string, atts: ChatCtxAttachment[], budget: number, digestReducible: boolean): BudgetedCtx {
  const cap = fileCapChars()
  const len = (a: ChatCtxAttachment) => (typeof a.content === 'string' ? a.content.length : 0)
  const total = (arr: ChatCtxAttachment[]) => arr.reduce((s, a) => s + len(a), 0)
  const capped = atts.map((a) => (typeof a.content === 'string' && a.content.length > cap ? { ...a, content: cutTo(a.content, cap), truncated: true } : a))
  // 摘要固定时附件只能分到剩余预算
  const attBudget = Math.max(0, budget - (digestReducible ? 0 : digestText.length))
  let kept = capped.slice()
  while (kept.length > 1 && total(kept) > attBudget) kept = kept.slice(1) // 自最旧开始丢
  if (kept.length === 1 && total(kept) > attBudget) {
    const newest = kept[0]
    const c = newest.content ?? ''
    kept = [{ ...newest, content: cutTo(c, attBudget), truncated: c.length > attBudget }]
  }
  const keptTotal = total(kept)
  // 可裁摘要 → 在附件保留后裁到剩余预算
  let dText = digestText
  if (digestReducible && dText.length > 0 && dText.length + keptTotal > budget) {
    dText = cutTo(dText, Math.max(0, budget - keptTotal))
  }
  // 极端兜底：摘要裁尽后附件仍超 → 把最新一条裁到预算内
  if (kept.length > 0 && dText.length + total(kept) > budget) {
    const newest = kept[kept.length - 1]
    const c = newest.content ?? ''
    const rest = Math.max(0, budget - dText.length)
    kept[kept.length - 1] = { ...newest, content: cutTo(c, rest), truncated: c.length > rest }
  }
  const truncated = dText !== digestText || kept.length < capped.length || kept.some((a) => a.truncated)
  return { digestText: dText, atts: kept, truncated }
}

/** 拼装轻量子代理直答提示词（纯文本；不含任何工具/文件访问授权）。 */
export function buildChatAnswerPrompt(input: ChatAnswerInput): string {
  const roleLine = `你是工作空间「${sanitizeText(input.scope)}」的对话助手（${sanitizeText(input.identity)}）。`
  const title = input.convTitle ? `当前会话：${sanitizeText(input.convTitle)}` : ''
  const hint = input.systemHint && input.systemHint.trim().length > 0
    ? `助手设定（空间系统提示）：\n${sanitizeText(input.systemHint.trim())}`
    : ''
  const history = input.context
    .map((m) => `[${sanitizeText(m.author)}（消息 ${m.id}）] ${sanitizeText(m.body)}`)
    .join('\n\n')
  const budget = contextBudgetChars(input)

  // S5：摘要块（undefined 不产块；null/空 text → 降级占位恒保留不可裁）
  let digestHead = ''
  let digestBody = ''
  let digestReducible = false
  if (input.spaceDigest !== undefined) {
    const d = input.spaceDigest
    if (d !== null && d.text && d.text.trim().length > 0) {
      const bits: string[] = []
      if (d.sourceNote && d.sourceNote.trim().length > 0) bits.push('来源：' + sanitizeText(d.sourceNote.trim()))
      if (d.generatedAt && d.generatedAt.trim().length > 0) bits.push('生成于 ' + sanitizeText(d.generatedAt.trim()))
      digestHead = bits.length > 0 ? `工作空间只读上下文（${bits.join('；')}）：` : '工作空间只读上下文：'
      digestBody = sanitizeText(d.text)
      digestReducible = true
    } else {
      digestHead = '工作空间只读上下文：'
      digestBody = digestPlaceholder(d)
    }
  }
  const rawAtts = Array.isArray(input.attachments) ? input.attachments : []
  const fit = fitContextBudget(digestBody, rawAtts, budget, digestReducible)
  const digestLine = digestHead.length > 0 ? [digestHead, ...(fit.digestText.length > 0 ? fit.digestText.split('\n') : [])] : []

  const attLines: string[] = []
  for (const a of fit.atts) {
    if (a.content === null || a.content === undefined) {
      const why = a.readError && a.readError.trim().length > 0 ? a.readError.trim() : '未知原因'
      attLines.push(`（附件 ${sanitizeText(a.fileName)} 读取失败：${sanitizeText(why)}）`)
    } else {
      attLines.push(`- 附件 ${sanitizeText(a.fileName)}（${a.size} 字节）：\n${sanitizeText(a.content)}`)
    }
  }
  const fileLines = attLines.length > 0 ? ['本次随消息上传的文件：', ...attLines] : []

  const lines: string[] = [
    roleLine,
    '你只负责回答用户问题，不做任何工具调用、不访问文件或网络。',
    title,
    hint,
    digestLine.join('\n'),
    fileLines.join('\n'),
    '会话历史：',
    history.length > 0 ? history : '（无更早消息）',
    '',
    '请直接给出有帮助、简洁、面向该工作空间上下文的回答。回答以纯文本输出，不要用代码块包裹整篇回答，不要编造历史中没有的事实。',
    '如果问题超出可回答范围（无关/信息不足/需更高权限操作），如实说明无法回答并简述原因。',
  ]
  return lines.filter((l) => l.length > 0).join('\n')
}

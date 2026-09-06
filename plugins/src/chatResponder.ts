/**
 * 对话 AI 回复（R-4，S10）纯函数：提示词拼装与回复方身份解析。
 *
 * 纪律（对齐 docs/TEST_CASES.md TC-S10-01..06 / AC-R4-1..4 / D-14/D-15）：
 *   - 回复方身份默认 <scope>-assistant，可被空间 settings.identity 覆盖（chatIdentityFor）；
 *   - 提示词 = 空间对话助手 + settings.systemHint + 会话历史（含提问本身，纯文本、无仓库工具）；
 *   - 只处理作者 ≠ 回复方身份的 awaiting 消息（防自我触发死循环，防注入冒名）。
 * 纯函数、无 I/O；node --test 直接单测。
 */

export interface ChatCtxMsg {
  id: number
  author: string
  body: string
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
}

/** 回复方身份（D-15/G-R4-2）：默认 <scope>-assistant；settings.identity 覆盖。 */
export function chatIdentityFor(scope: string, identityOverride?: string | null): string {
  const sc = (scope || '').trim()
  if (identityOverride && identityOverride.trim().length > 0) return identityOverride.trim()
  return sc.length > 0 ? `${sc}-assistant` : 'assistant'
}

/** 拼装轻量子代理直答提示词（纯文本；不含任何工具/文件访问授权）。 */
export function buildChatAnswerPrompt(input: ChatAnswerInput): string {
  const roleLine = `你是工作空间「${input.scope}」的对话助手（${input.identity}）。`
  const title = input.convTitle ? `当前会话：${input.convTitle}` : ''
  const hint = input.systemHint && input.systemHint.trim().length > 0 ? `助手设定（空间系统提示）：
${input.systemHint.trim()}` : ''
  const history = input.context
    .map((m) => `[${m.author}（消息 ${m.id}）] ${m.body}`)
    .join('\n\n')
  const lines: string[] = [
    roleLine,
    '你只负责回答用户问题，不做任何工具调用、不访问文件或网络。',
    title.length > 0 ? title : '',
    hint.length > 0 ? hint : '',
    '会话历史：',
    history.length > 0 ? history : '（无更早消息）',
    '',
    '请直接给出有帮助、简洁、面向该工作空间上下文的回答。回答以纯文本输出，不要用代码块包裹整篇回答，不要编造历史中没有的事实。',
    '如果问题超出可回答范围（无关/信息不足/需更高权限操作），如实说明无法回答并简述原因。',
  ]
  return lines.filter((l) => l.length > 0).join('\n')
}

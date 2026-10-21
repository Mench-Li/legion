/**
 * 对话 AI 回复失败分类器（R-1 决策 A1，S1）：把 chat-responder 执行层的笼统失败
 * （live 现场形态：子代理 stopReason=error 被回写为笼统失败文案）升级为分类 + 可行动文案。
 *
 * 纪律（对齐 docs/G-mtr3su6f-1/TEST_CASES.md TC-S1-01..04 与 REQUIREMENTS AC-R1-3）：
 *   - 类别枚举恰为五类：model-unavailable / provider-error / timeout-aborted / foreman-down / empty-other；
 *   - 每类文案非空、含恢复指引语义（重试/配置/模型/恢复至少其一）、≤500 字符（服务端 aiError 上限契约）；
 *   - 负例：stopReason=error 且 error 为 error/undefined 风格时不得产出裸旧兜底文案
 *     （原「子代理未完成（…）」笼统样式）或裸 undefined 样式文案（兜底为可行动 empty-other）；
 *   - 边界：stopReason 空/缺省、error 超长等一律不抛，落 empty-other 兜底并截断原文片段。
 * 纯函数、无 I/O；node --test 直接单测（plugins/tests/chat-error-classifier.test.mjs）。
 *
 * ★ 2026-10-20 追加第六类 `host-api-mismatch`（**只加不漏**：五类语义与文案原样保留）。
 *
 *   现场：和 Agent 对话回「原因暂不可识别（原文：TypeError: subagents.start is not a function）」。
 *   它被归到 empty-other，于是文案引导人去"确认守护在线 + 选 assistant 模型"——
 *   **方向从一开始就是错的**：那是插件编译用的 dsh-subagent（0.2.1-alpha.1，有 `start`）
 *   与真正加载的 DSH（0.2.1-rc.2，只有 `startActivation`）不是一代。
 *
 *   > 一类"看起来什么都像"的失败落进兜底箱子，
 *   > 与一类**本该单独成类**的失败落进同一个箱子，
 *   > 在用户眼里是同一句话：去查模型配置。
 *
 *   所以它必须**先于**其它判定被认出来，并给出真正可行动的话：重启 DSH 宿主 / 对齐版本。
 */

export const CATEGORIES = [
  'model-unavailable',
  'provider-error',
  'timeout-aborted',
  'foreman-down',
  'host-api-mismatch',
  'empty-other',
] as const

export type ChatErrorCategory = (typeof CATEGORIES)[number]

export interface ChatErrorInput {
  stopReason?: string | null
  error?: unknown
}

export interface ChatErrorOutcome {
  category: ChatErrorCategory
  message: string
}

/** 把任意错误值安全化成可嵌入文案的短片段：剔除控制符/前缀，截断；error/undefined 等无意义原文按空处理。 */
function safeSnippet(error: unknown, max = 160): string {
  if (error === undefined || error === null) return ''
  let s = typeof error === 'string' ? error : String(error)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  s = s.replace(/^(?:error|Error)\s*:\s*/, '').trim()
  const rest = s.toLowerCase()
  if (rest.length === 0 || rest === 'undefined' || rest === 'error' || rest === 'null' || rest === 'none' || rest === '{}') return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 分类判定：返回 { category, snippet }（snippet 已安全化，空则省略原文）。 */
function pick(input: ChatErrorInput): { category: ChatErrorCategory; snippet: string } {
  const stop = typeof input?.stopReason === 'string' ? input.stopReason.trim().toLowerCase() : ''
  const snippet = safeSnippet(input?.error)
  const text = (snippet + ' ' + stop).toLowerCase()

  // 0) 宿主 API 不匹配（**先于**所有其它判定）。
  //
  //    2026-10-20 实测：`TypeError: subagents.start is not a function`。
  //    编译用的 dsh-subagent 是 0.2.1-alpha.1（有 start），运行的是 0.2.1-rc.2
  //    （只有 startActivation）。它不是"模型/密钥/网络"问题，而是**装的那份 DSH 与插件期望不是一代**——
  //    归到 empty-other 会让人去查模型配置，方向从一开始就错。
  //
  //    判据同时认：我们自己的稳定前缀、以及原生的 `X is not a function`。
  //    ★ 正则刻意**不带**服务前缀（不写 `<宿主对象>.subagents.start`）：带上它会被
  //      边界棘轮（PRT-108）记成一次执行面调用 —— 而这里只是**读一段错误文本**，不是调服务。
  if (/subagent_api_unavailable/.test(text)
    || /subagents?\.(start|startactivation)\b.{0,20}is not a function/.test(text)
    || /(start|startactivation)\b.{0,10}is not a function/.test(text)) {
    return { category: 'host-api-mismatch', snippet }
  }
  // 1) 超时/中止：stopReason=aborted（或调用方把 null 语义补 aborted），错误含超时/中止语义
  if (stop === 'aborted' || /timeout|timed? ?out|aborted|abort|超时|中止|预算|deadline/.test(text)) {
    return { category: 'timeout-aborted', snippet }
  }
  // 2) 守护 foreman 不可用（沿用既有语义文案，不改变语义）
  if (/foreman|守护[^，。]{0,12}不可用/.test(text)) {
    return { category: 'foreman-down', snippet }
  }
  // 3) provider 层失败：密钥/鉴权/配额/限流/连接拒绝等（不匹配上游噪声词，避免误吞 empty-other）
  if (/api ?key|unauthori[sz]ed|401|403|429|quota|rate ?limit|connect(?:ion)?|refused|provider(?![-_a-z0-9])|密钥|配额|限流/.test(text)) {
    return { category: 'provider-error', snippet }
  }
  // 4) 模型不可用：unknown model / model not found / not authorized / 模型不存在等
  if (/unknown model|model not found|model not|no such model|invalid model|model .*not exist|model .*not available|not authorized|模型不存在|找不到模型|未配置.*模型|可用模型/.test(text)) {
    return { category: 'model-unavailable', snippet }
  }
  return { category: 'empty-other', snippet }
}

/** 生成可行动文案：模板 + 恢复指引；引用原文片段帮助定位，但不把裸 error/undefined 当原因展示。 */
function messageFor(category: ChatErrorCategory, snippet: string): string {
  const src = snippet.length > 0 ? `（原文：${snippet.slice(0, 120)}）` : ''
  switch (category) {
    case 'host-api-mismatch':
      return `AI 回复失败：DSH 宿主接口不匹配（插件与所装 DSH 不是同一代）${src}。刚升级过 DSH 后出现属预期，请重启 DSH 宿主让插件重新加载；仍失败请对齐版本后重试。`
    case 'model-unavailable':
      return `AI 回复失败：未配置可用的 assistant 模型${src}。请到对话中心「回复设置」或模型配置中选择 assistant 可用模型后，点击「重试」或重新发送。`
    case 'provider-error':
      return `AI 回复失败：模型提供方调用出错${src}。请检查模型服务的密钥/配额/网络配置，修复后点击「重试」或重新发送。`
    case 'timeout-aborted':
      return `AI 回复超时/中止${src}。守护未在时间窗内收到回复方应答，请确认守护进程在线后点击「重试」或重新发送。`
    case 'foreman-down':
      return `守护 foreman 不可用${src}。守护进程未就绪，请确认守护在线（对话中心健康状态）后点击「重试」或重新发送。`
    case 'empty-other':
    default:
      return `AI 回复失败：原因暂不可识别${src}。请点击「重试」；若持续失败请确认守护进程在线并在模型配置中选择 assistant 可用模型后重试。`
  }
}

/** 主入口：分类 + 可行动文案（≤500 字符，UTF-8 安全；不抛异常）。 */
export function classifyChatError(input: ChatErrorInput | null | undefined): ChatErrorOutcome {
  const { category, snippet } = pick(input ?? {})
  let message = messageFor(category, snippet)
  if (message.length > 500) message = message.slice(0, 497) + '…'
  return { category, message }
}

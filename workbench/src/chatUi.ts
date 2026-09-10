/**
 * chatUi.ts — 对话中心前端纯函数与类型（P2-6：从 ChatView.tsx 抽出，便于 node:test 直测）。
 *
 * 设计约束：**无 DOM、无 React、无 IO**——只做状态判定、文案生成、列表合并与缺口判据，
 * 可被 Node（--experimental-strip-types）直接导入测试；组件从这里取用。
 *
 * 覆盖 P2-6 关心的问题（docs/REMAINING-TASKS.md P2-6）：
 *   - 「模型不可用、超时、守护离线」的完整 UI 判定与**可行动文案**（`chatHealthView` / `aiStateView`）；
 *   - 「awaiting → replied/failed 的前端合并」（`mergeChatMessages`：同 id 覆盖，AI 三态是同一条源消息的 meta 更新）；
 *   - 「断线恢复」（`shouldRefillChat` / `chatSseLabel`：复用 P2-4 的 seq 水位缺口判据与连接状态语义）。
 *
 * 导出纪律：**只导出有生产接线或明确语义价值的函数**——抽取后未接线的导出会给「测试全绿但
 * 生产未用」的假象（本项目已明确不接受的坏味道）。

/** 前端消息（后端 chat_messages 行的前端视图子集；meta 承载 AI 三态）。 */
export interface ChatMsgLite {
  id: number
  convId?: number
  author: string
  body: string
  createdAt?: string
  meta?: ChatAiMeta | null
  kind?: string
  attachments?: unknown
}

/** AI 回复态（服务端写在源消息 meta 上；awaiting → replied/failed）。 */
export interface ChatAiMeta {
  aiStatus?: 'awaiting' | 'replied' | 'failed' | string
  aiError?: string | null
  aiModel?: string | null
  aiReplyId?: number | null
  /** 服务端实际字段名：回复消息 id（postAiReply 写 `replyMsg`）。 */
  replyMsg?: number | null
  /** 服务端实际字段名：回复时间（postAiReply 写 `repliedAt`）。 */
  repliedAt?: string | null
  failedAt?: string | null
  attachments?: unknown
}

/**
 * 解析「这次回复用的是哪个模型」。
 *
 * 服务端把模型名写在**回复行**的 meta（`{replyTo, aiModel}`）上，源消息 meta 只有
 * `aiStatus/repliedAt/replyMsg`（见 team-hub/server.mjs postAiReply）。
 * 所以仅读源消息 meta.aiModel 永远取不到值——必须按 `meta.replyMsg` 回到列表里找那条回复。
 * 兼容旧数据：源消息自带 aiModel 时直接采用。
 */
export function replyModelOf(msg: ChatMsgLite, list: ChatMsgLite[] | null | undefined): string | null {
  const direct = msg.meta?.aiModel
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim()
  const replyId = msg.meta?.replyMsg ?? msg.meta?.aiReplyId
  if (!Number.isInteger(replyId) || !Array.isArray(list)) return null
  const row = list.find(x => x.id === replyId)
  const model = row?.meta?.aiModel
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null
}

/** 对话健康（GET /api/chat/health 的响应子集）。 */
export interface ChatHealthLite {
  online?: boolean
  enabled?: boolean
  modelResolved?: boolean
  model?: { provider?: string; model?: string; source?: string } | null
  daemon?: { member?: string; kind?: string; lastSeenAt?: string } | null
  lastFail?: { aiError?: string; at?: string; messageId?: number | null } | null
  honestNote?: string
}

/** AI 三态取值（非三态一律 null，UI 不显示 AI 状态条）。 */
export function aiStatusOf(msg: ChatMsgLite): 'awaiting' | 'replied' | 'failed' | null {
  const s = msg.meta?.aiStatus
  return s === 'awaiting' || s === 'replied' || s === 'failed' ? s : null
}

/** 是否我方（人类）消息：AI 状态条只挂在自己的消息上（author = 当前操作者）。 */
export function isMine(msg: ChatMsgLite, me: string | null): boolean {
  return me !== null && msg.author === me
}

/**
 * 健康状态视图（P2-6 第 3 项核心）：
 *   灰 = 端点缺失/未知（**不误导**）；红 = 最近失败（可行动：重试/检查模型）；
 *   黄 = 前提缺失（守护离线 / 开关关闭 / 模型未配置，逐条给出修复动作）；绿 = 就绪。
 * 判定优先级：未知 → 未加载 → 最近失败 → 前提缺失 → 就绪（与既有 ChatView 行为一致，抽函数不改语义）。
 */
export function chatHealthView(health: ChatHealthLite | null, healthNote = ''): { color: string; label: string; title: string } {
  if (healthNote) return { color: 'var(--muted-2)', label: '健康状态未知', title: healthNote }
  if (!health) return { color: 'var(--muted-2)', label: '检测中…', title: '正在获取对话健康状态…' }
  if (health.lastFail) {
    const err = health.lastFail.aiError ?? '未知原因'
    return {
      color: 'var(--red)',
      label: '最近回复失败',
      title: '最近一条 AI 回复失败：' + err + '。请在对应 ❌ 消息点击「↻ 重试」，或检查模型配置后重发。',
    }
  }
  const notes: string[] = []
  if (!health.online) notes.push('守护离线：请启动守护进程（scrum-worker）后重试')
  if (!health.enabled) notes.push('AI 回复未开启：点「⚙ 回复设置」打开开关')
  if (!health.modelResolved) notes.push('模型未配置：在「⚙ 回复设置」或模型配置中选择 assistant 可用模型')
  if (notes.length > 0) return { color: 'var(--yellow)', label: 'AI 回复待处理', title: notes.join('；') }
  return {
    color: 'var(--green)',
    label: 'AI 回复就绪',
    title: '守护在线 · 回复已开启 · 模型已解析。已解析不代表 provider 实际可用，以最近一次回复/失败为准。',
  }
}

/**
 * AI 态栏位视图（awaiting / failed / replied 三态；replied 可显示模型名）。
 * 返回 null = 不显示状态条（不是三态、或不是自己的消息）。
 * `list` 用于解析回复模型（模型在回复行上，见 replyModelOf）。
 */
export function aiStateView(
  msg: ChatMsgLite,
  me: string | null,
  list?: ChatMsgLite[] | null,
): { state: 'awaiting' | 'replied' | 'failed'; text: string; retryable: boolean } | null {
  if (!isMine(msg, me)) return null
  const st = aiStatusOf(msg)
  if (st === null) return null
  if (st === 'awaiting') return { state: 'awaiting', text: '等待 AI 回复…', retryable: false }
  if (st === 'failed') {
    const reason = msg.meta?.aiError && String(msg.meta.aiError).trim().length > 0 ? String(msg.meta.aiError) : '原因未知'
    return { state: 'failed', text: '回复失败：' + reason, retryable: true }
  }
  const model = replyModelOf(msg, list)
  return { state: 'replied', text: '已回复' + (model ? ' · ' + model : ''), retryable: false }
}

/**
 * 消息列表合并的**对话语义**说明（实现即 `dedupe.mergeById`，ChatView 直接调用它）：
 * 同一 id 以**最新版本覆盖**、新消息按 id 升序追加、更早历史保留在前。
 *
 * 为什么这是 P2-6 的关键：AI 三态是**同一条源消息的 meta 更新**（awaiting→replied/failed），
 * 只「追加新 id」会让气泡永远停在「等待回复」。
 * 此处不另设包装函数——单一实现，语义断言放在 chat-ui 测试里对 `mergeById` 直接锚定。
 */

/**
 * 缺口判据（P2-6 第 2 项「断线恢复」，与 P2-4 通知中心同一口径）：
 * 以**未过滤全量事件流**的 seq 水位判断是否漏帧——audit seq 全局单调递增，收到跳变即说明中间有丢帧，
 * 此时必须立即重拉列表补齐（不能只等 15s 轮询）。首帧（prevMaxSeq<=0）只建立基线，不误报。
 */
export function shouldRefillChat(prevMaxSeq: number, incomingSeqs: number[]): boolean {
  if (prevMaxSeq <= 0) return false
  for (const s of incomingSeqs) {
    if (Number.isFinite(s) && s > prevMaxSeq + 1) return true
  }
  return false
}

/** 事件 seq 水位（取最大；非法值忽略）。 */
export function maxSeqOf(seqs: number[]): number {
  let max = 0
  for (const s of seqs) if (Number.isFinite(s) && s > max) max = Math.floor(s)
  return max
}

/**
 * SSE 连接状态文案（P2-6 断线恢复可观测性）：open 首次 / reconnected 重连成功（触发补齐）/
 * reconnecting 正在重连 / closed 已断开。
 */
export function chatSseLabel(state: 'open' | 'reconnected' | 'reconnecting' | 'closed', opens = 1): { text: string; color: string } {
  switch (state) {
    case 'open':
      return { text: '实时已连接', color: 'var(--green)' }
    case 'reconnected':
      return { text: '实时已重连（第 ' + String(opens) + ' 次）', color: 'var(--yellow)' }
    case 'reconnecting':
      return { text: '实时连接中断，重连中…', color: 'var(--yellow)' }
    default:
      return { text: '实时连接已断开（仍可手动刷新）', color: 'var(--red)' }
  }
}

/** 草稿是否可发送（空正文 + 无附件 → 不可发；纯空白也算空）。 */
export function canSend(body: string, attachmentCount: number): boolean {
  return body.trim().length > 0 || attachmentCount > 0
}

/** 发送失败文案（草稿保留语义下，提示必须给出「重试/重发」指引而不是清空）。 */
export function sendFailText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  // 401/403 本身就是未授权语义（api.ts 的 fetch 封装只带状态码，如 'chat messages 401'），
  // 故按状态码独立判定，不要求同时出现 token 字样；\b 边界避免把 1401 之类误判。
  if (/\b40[13]\b/.test(m)) return '发送失败：未授权（请在设置中填写中枢 token）——草稿已保留，修好后可直接重发'
  if (/fetch|network|Failed to fetch|ECONNREFUSED|timeout/i.test(m)) return '发送失败：中枢不可达——草稿已保留，等中枢恢复后重发'
  return '发送失败：' + m + '——草稿已保留，可重发'
}

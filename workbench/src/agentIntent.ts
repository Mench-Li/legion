/**
 * 岗位对话的**发送路由**（C2 的纯逻辑核心，与 React 无关 ⇒ 可直接单测）。
 *
 * 为什么值得单独抽出来：一次岗位对话的发送有**两条**通道，选错不是"样式不对"，而是
 * 消息去了错的地方或根本发不出去：
 *
 *   · `/api/chat/messages`（via='chat'）—— 人说人话，支持附件，走 AI 回复管道；
 *   · `/api/agent-messages`（via='agent'）—— 带意图的结构化消息，**只有它**能做
 *     追加要求（写 feedback，下一轮生效）、新建任务、回答待决策问题（消解 question）。
 *     代价：**不接受附件**（服务端 send() 不读 attachmentIds）。
 *
 * 三条护栏都是服务端会拒、但在这里先说清楚的（早说是为了不让用户白等一次往返）：
 *   ① 结构化意图 + 附件 ⇒ 拒绝（服务端没有这个参数，静默丢附件比报错更坏）；
 *   ② 追加要求必须选具体任务（服务端 TARGET_AMBIGUOUS）；
 *   ③ 回答待决策必须带 questionId/questionVersion（服务端 QUESTION_RESOLVED 会按版本拒）。
 */
import type { AgentIntent } from './api'

export type SendPlan =
  | { ok: true; via: 'chat'; body: string; attachmentIds: number[] }
  | {
    ok: true
    via: 'agent'
    body: string
    intent: AgentIntent
    targetTaskId: string | null
    questionId?: string
    questionVersion?: number
  }
  | { ok: false; reason: string }

export interface SendPlanInput {
  /** 用户在输入区选的意图。 */
  intent: AgentIntent
  body: string
  /** 本轮已就绪（上传成功）的附件 id。 */
  attachmentIds: number[]
  /** 「追加要求」选中的任务 id（空串 = 没选）。 */
  targetTaskId: string
  /** 正在回答的待决策问题；非 null 时**优先于** intent（界面也是这样把它锁住的）。 */
  pendingQuestion: { id: string; version: number; taskId: string } | null
}

/** 结构化意图 = 必须走 `/api/agent-messages` 的那些（`ask` 不在其中：它走聊天通道）。 */
export function isStructuredIntent(intent: AgentIntent, pendingQuestion: unknown): boolean {
  return pendingQuestion !== null && pendingQuestion !== undefined ? true : intent !== 'ask'
}

export function planAgentSend(input: SendPlanInput): SendPlan {
  const body = input.body.trim()
  if (body.length === 0) return { ok: false, reason: '消息不能为空。' }

  // 正在回答待决策：意图被它锁定，且必须带问题身份（服务端按 version 做并发保护）。
  if (input.pendingQuestion !== null) {
    if (input.attachmentIds.length > 0) {
      return { ok: false, reason: '「回答待决策」是结构化指令，不能带附件；请先移除附件或改用「询问」。' }
    }
    return {
      ok: true, via: 'agent', body, intent: 'answer_question',
      targetTaskId: input.pendingQuestion.taskId,
      questionId: input.pendingQuestion.id,
      questionVersion: input.pendingQuestion.version,
    }
  }

  if (input.intent === 'ask') {
    // 询问走聊天通道：附件、AI 回复管道都在那边（附件原样带下去，不能被这里吞掉）。
    return { ok: true, via: 'chat', body, attachmentIds: input.attachmentIds }
  }

  if (input.attachmentIds.length > 0) {
    return { ok: false, reason: '「追加要求 / 新建任务」是结构化指令，不能带附件；请先移除附件或改用「询问」。' }
  }

  if (input.intent === 'feedback') {
    if (input.targetTaskId === '') return { ok: false, reason: '「追加要求」必须选择具体任务。' }
    return { ok: true, via: 'agent', body, intent: 'feedback', targetTaskId: input.targetTaskId }
  }

  // create_task：正文即标题，不需要目标。
  return { ok: true, via: 'agent', body, intent: input.intent, targetTaskId: null }
}

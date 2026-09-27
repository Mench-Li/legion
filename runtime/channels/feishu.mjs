// F-25 渠道适配器：飞书（业主指定最先接）。按飞书**事件 v2** 信封翻译。
// ★ 不可识别的信封一律 **reject**（fail closed），不做"猜字段"式兼容：
//   猜错会把外部 id 当成 Legion 身份放进去，而身份面正是这一刀要守的东西。
export function createFeishuChannel(id = 'feishu') {
  return {
    id,
    parse(raw) {
      if (raw === null || typeof raw !== 'object') return { reject: true }
      const header = raw.header
      const event = raw.event
      if (header === null || typeof header !== 'object') return { reject: true }
      if (event === null || typeof event !== 'object') return { reject: true }
      const rawId = header.event_id
      const externalUserId = event?.sender?.sender_id?.open_id
      if (typeof rawId !== 'string' || typeof externalUserId !== 'string') return { reject: true }
      let text = ''
      const content = event?.message?.content
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content)
          text = typeof parsed?.text === 'string' ? parsed.text : ''
        } catch {
          return { reject: true }   // content 声称是 JSON 却不是 ⇒ 不猜，直接拒
        }
      }
      const chatId = event?.message?.chat_id
      const createTime = header.create_time
      return {
        externalUserId,
        text,
        rawId,
        receivedAtMs: typeof createTime === 'string' ? Number(createTime) || 0 : 0,
        ...(typeof chatId === 'string' ? { threadRef: chatId } : {}),
      }
    },
  }
}

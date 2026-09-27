// F-25 渠道适配器：邮件（业主给的地址 1115043055@qq.com 属**配置**，不硬编码；
// 授权码属**秘密**，只进 DPAPI 秘密库，永远不经过本模块的入参以外的地方）。
export function createEmailChannel(id = 'email') {
  return {
    id,
    parse(raw) {
      if (raw === null || typeof raw !== 'object') return { reject: true }
      const rawId = raw.messageId
      const externalUserId = raw.from
      if (typeof rawId !== 'string' || typeof externalUserId !== 'string') return { reject: true }
      const text = typeof raw.text === 'string' && raw.text !== ''
        ? raw.text
        : (typeof raw.subject === 'string' ? raw.subject : '')
      return {
        externalUserId,
        text,
        rawId,
        receivedAtMs: 0,
        ...(typeof raw.inReplyTo === 'string' ? { threadRef: raw.inReplyTo } : {}),
      }
    },
  }
}

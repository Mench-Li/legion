// F-25 渠道适配器：公开 REST API（不需第三方账号 ⇒ 先接它便于端到端出证据）。
// ★ 只做"翻译"：把 HTTP 侧的载荷规范化成 ChannelEvent；判定（身份/幂等/放行）全在
//   `runtime/contracts/channel-contract.mjs` 的闸门里 —— 这是"新渠道不改核心"的前提。
export function createRestChannel(id = 'rest') {
  return {
    id,
    parse(raw) {
      if (raw === null || typeof raw !== 'object') return { reject: true }
      const externalUserId = raw.userId ?? raw.externalUserId
      const rawId = raw.eventId ?? raw.rawId
      if (typeof externalUserId !== 'string' || typeof rawId !== 'string') return { reject: true }
      return {
        externalUserId,
        text: typeof raw.text === 'string' ? raw.text : '',
        rawId,
        receivedAtMs: typeof raw.receivedAtMs === 'number' ? raw.receivedAtMs : 0,
      }
    },
  }
}

/** 出站：传输是**注入**的（本模块不碰网络、不读凭据）。 */
export function createRestSender({ id = 'rest', post } = {}) {
  if (typeof post !== 'function') throw new TypeError('createRestSender 需要注入 post')
  return {
    id,
    async send(targetRef, text) {
      const r = await post({ targetRef, text })
      return { ok: r?.ok === true, detail: r?.detail ?? null }
    },
  }
}

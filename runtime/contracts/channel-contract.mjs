// ★ F-25 第一刀（业主 2026-09-24 裁：三渠道都要、飞书最先、单租户多用户、第一刀＝渠道入口契约）。
//
// 为什么先立契约、不是先接飞书：
//   接一个渠道一天就能看到效果，但它会把**那一个渠道的偶然形状**钉进核心 —— 先来的渠道会成为
//   事实标准（§2 对 F-23 的警告同理）。⇒ 第一刀的判据是：**接入第二个渠道时核心零 diff**。
//
// 本模块是**纯结构**：不做 I/O、不读环境、不碰凭据（与 `runtime/contracts/config-bundle.mjs` 同一条纪律）。
// 渠道只负责"翻译"，判定（身份、幂等、放不放行）全在这里。

export const CHANNEL_IDS = ['feishu', 'rest', 'email']

export const REJECT = {
  UNKNOWN_CHANNEL: 'unknown-channel',
  MALFORMED: 'malformed',
  UNMAPPED_USER: 'unmapped-user',
  DUPLICATE: 'duplicate',
}

/** 渠道注册表：核心只认这个形状，不认识任何具体渠道。 */
export function createChannelRegistry() {
  const channels = new Map()
  return {
    register(channel) {
      if (channel === null || typeof channel !== 'object') throw new TypeError('channel 必须是对象')
      if (typeof channel.id !== 'string' || channel.id === '') throw new TypeError('channel.id 必填')
      if (typeof channel.parse !== 'function') throw new TypeError('channel.parse 必填')
      channels.set(channel.id, channel)
      return channel
    },
    has: (id) => channels.has(id),
    get: (id) => channels.get(id),
    ids: () => [...channels.keys()],
  }
}

/**
 * 入站闸门：三条不许让步的判据都在这里。
 *   ① 身份**不来自渠道**：`externalUserId` 只用于映射；缺映射 ⇒ 拒绝并记账（**不得**默认匿名放行）
 *   ② 幂等：同一条外部消息重复投递 ⇒ 只产生一个 Run（键 = channelId + 渠道侧 rawId）
 *   ③ 与渠道无关：闸门不认识 `feishu`/`rest`/`email`，新增渠道不需要动本文件
 */
export function createInboundGate({ registry, identityMap } = {}) {
  if (registry === undefined || typeof registry.get !== 'function') throw new TypeError('registry 必填')
  if (!(identityMap instanceof Map)) throw new TypeError('identityMap 必须是 Map')
  const runs = new Map()   // `channelId:rawId` → runKey
  let seq = 0
  return {
    accept(channelId, raw) {
      const channel = registry.get(channelId)
      if (channel === undefined) {
        return { ok: false, reason: REJECT.UNKNOWN_CHANNEL, audit: { channelId } }
      }
      let ev
      try {
        ev = channel.parse(raw)
      } catch (e) {
        return { ok: false, reason: REJECT.MALFORMED, audit: { channelId, detail: String(e) } }
      }
      if (ev === null || typeof ev !== 'object' || ev.reject === true) {
        return { ok: false, reason: REJECT.MALFORMED, audit: { channelId } }
      }
      const userId = identityMap.get(channelId + ':' + ev.externalUserId)
      if (userId === undefined) {
        return { ok: false, reason: REJECT.UNMAPPED_USER, audit: { channelId, externalUserId: ev.externalUserId } }
      }
      const key = channelId + ':' + ev.rawId
      const existing = runs.get(key)
      if (existing !== undefined) {
        return { ok: false, reason: REJECT.DUPLICATE, runKey: existing, audit: { channelId, rawId: ev.rawId } }
      }
      seq += 1
      const runKey = 'run-' + seq
      runs.set(key, runKey)
      return { ok: true, runKey, event: { ...ev, channelId, userId, runKey } }
    },
    runCount: () => runs.size,
  }
}

/** 回声渠道：接判据套件用的**夹具**，不是产品渠道（它只把已规范化的东西照抄一遍）。 */
export function createEchoChannel(id) {
  if (typeof id !== 'string' || id === '') throw new TypeError('echo 渠道需要 id')
  return {
    id,
    parse(raw) {
      if (raw === null || typeof raw !== 'object') return { reject: true }
      const { externalUserId, text, rawId } = raw
      if (typeof externalUserId !== 'string' || typeof rawId !== 'string') return { reject: true }
      return { externalUserId, text: typeof text === 'string' ? text : '', rawId, receivedAtMs: 0 }
    },
  }
}

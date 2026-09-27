// team-hub/routes/channels.mjs
// ============================================================================
// 路由层新族：**渠道**（F-25 渠道入口契约的生产消费者）
//
// 四条路：
//   POST /api/channels/inbound   渠道入站：翻译 → 定身份 → 幂等 →（准入则）落待办
//   POST /api/channels/identity  绑定 / 解绑（业主裁决 A：用户自行绑定，`action:'unbind'` 解绑）
//   GET  /api/channels/identity  列出已绑定
//   GET  /api/channels/inbox     列出待办（业主裁决 B：准入后落待办，不建 Task）
//
// ## 边界（写清楚，免得被读成"渠道全接完了"）
//
// 本族只做**入口判定 + 落待办**。它**不建 Task、不动运行面** —— 准入之后的语义
// （带什么 role/scope/goal）是产品决定，等那一刀。
//
// ## ★ 生产默认失败关闭
//
// 映射取自**存储的活视图**；一张表都没绑时 ⇒ 任何入站都以 `unmapped-user` 具名拒绝、
// `runCount()===0`。**一条都不放行**是刻意的默认值。
// ============================================================================

import { createChannelRegistry, createInboundGate, REJECT } from '../../runtime/contracts/channel-contract.mjs'
import { createRestChannel } from '../../runtime/channels/rest.mjs'
import { createFeishuChannel } from '../../runtime/channels/feishu.mjs'
import { createEmailChannel } from '../../runtime/channels/email.mjs'
import { LiveIdentityMap } from '../channel-store.mjs'

/**
 * 造渠道族路由。
 *
 * @param {object} deps 依赖由 `server.mjs` 注入
 * @param {object} deps.channelStore 身份映射 + 待办队列（`team-hub/channel-store.mjs`）
 * @param {Map} [deps.identityMap] 覆盖映射来源（判据用；生产走 store 的活视图）
 */
export function createChannelRoutes({
  json,
  handleWrite,
  channelStore,
  identityMap,
}) {
  const deps = { json, handleWrite, channelStore }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createChannelRoutes 缺注入项：${k}`)
  }

  const registry = createChannelRegistry()
  // ★ 三个渠道注册进**同一个**闸门：新增渠道不需要动契约、也不需要动本族的判定逻辑。
  registry.register(createRestChannel())
  registry.register(createFeishuChannel())
  registry.register(createEmailChannel())

  // ★ 映射取自**活视图**：绑定发生在闸门构造之后也照样生效。
  const identitySource = identityMap ?? new LiveIdentityMap(() => channelStore.toMap())
  const gate = createInboundGate({ registry, identityMap: identitySource })

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/channels/inbound',
      async run(req, res) {
        await handleWrite(req, res, (body) => {
          const channelId = body?.channel
          if (typeof channelId !== 'string') throw new Error('缺少参数 channel')
          const decision = gate.accept(channelId, body?.payload)
          if (decision.ok) {
            // B：准入后**只落待办**，不建 Task、不动运行面 —— 由编排或人来认领。
            const queued = channelStore.enqueue({
              channelId,
              rawId: decision.event.rawId,
              userId: decision.event.userId,
              runKey: decision.runKey,
              text: decision.event.text,
              receivedAtMs: decision.event.receivedAtMs,
            })
            return { accepted: true, channelId, runKey: decision.runKey, userId: decision.event.userId, inboxId: queued.id }
          }
          // ★ 幂等命中**不是错误**：它必须指回同一个 runKey（且不重复入队）。
          if (decision.reason === REJECT.DUPLICATE) {
            return { accepted: true, duplicate: true, channelId, runKey: decision.runKey }
          }
          throw new Error(`渠道入站被拒：${decision.reason}`)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/channels/identity',
      async run(req, res) {
        await handleWrite(req, res, (body) => {
          if (body?.action === 'unbind') {
            return channelStore.unbind({ channelId: body?.channel, externalUserId: body?.externalUserId })
          }
          return channelStore.bind({ channelId: body?.channel, externalUserId: body?.externalUserId, userId: body?.userId })
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/channels/identity',
      async run(req, res) { json(res, 200, { identities: channelStore.list() }) },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/channels/inbox',
      async run(req, res) {
        const limit = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? 50)
        json(res, 200, { pending: channelStore.pending({ limit }) })
      },
    },
  ]

  const matches = (r, path) => {
    if (r.match === 'exact') return path === r.path
    if (r.match === 'prefix') return path.startsWith(r.path)
    if (r.match === 'prefix+suffix') return path.startsWith(r.path) && path.endsWith(r.suffix)
    return false
  }

  return {
    id: 'channels',
    routes,
    /** 给判据与运维看的只读面：闸门本身（含 runCount 与账）。 */
    gate,
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

/**
 * **纯解析器**：把一份 JSON 文本解析成身份映射表（`${channelId}:${externalUserId}` → Legion userId）。
 *
 * ★ 它只做解析与形状校验，**不决定这份表从哪来** —— 生产走的是 `channelStore`（用户自行绑定）；
 *   本函数留给**批量导入**用（要一个显式的文本，没有默认位置、没有兜底表）。
 *
 * ★ 形状不对**当场抛**：一张"看着像映射表、其实键写错了"的表，与一张空表，
 *   在"每条入站都被拒"这个读数上是同一个东西 —— 于是人们会去查渠道，而问题在那张表。
 */
export function parseIdentityMap(text) {
  if (typeof text !== 'string') throw new TypeError('parseIdentityMap 需要文本')
  let obj
  try { obj = JSON.parse(text) } catch (e) { throw new Error(`身份映射不是合法 JSON：${e.message}`) }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('身份映射必须是对象：{"渠道:外部id":"Legion用户id"}')
  const map = new Map()
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || v === '') throw new Error(`身份映射的值为空：${k}`)
    if (!k.includes(':')) throw new Error(`身份映射的键必须形如 渠道:外部id：${k}`)
    map.set(k, v)
  }
  return map
}

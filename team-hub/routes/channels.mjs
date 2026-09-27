// team-hub/routes/channels.mjs
// ============================================================================
// 路由层新族：**渠道入站**（F-25 渠道入口契约的第一个生产消费者）
//
// ## 这一族为什么住在这里
//
// `runtime/contracts/channel-contract.mjs` 是**契约**（渠道怎么翻译、身份怎么定、
// 幂等怎么算），`runtime/channels/rest.mjs` 是**适配器**（把 HTTP 侧载荷规范化）。
// 两者此前**没有任何生产 import 者** ⇒ 可达性门禁把 rest.mjs 记作 `gap`。
// 接进 hub 的真实入口之后，它们从"没人调用的模块"变成"被生产入口走到的模块"。
//
// ## 本族的边界（写清楚，免得被读成"渠道全接完了"）
//
// 本族**只做入口判定**：翻译 → 定身份 → 幂等 → 给出结论与 `runKey`。
// **它不创建 Run** —— `runKey` 是"这条外部消息对应哪个 Run 键"的**保留票**，
// 真正的 Run 创建是下一刀（要动运行面，属另一族）。
//
// ## ★ 生产默认是失败关闭
//
// 不注入 `identityMap` 时映射表是**空**的 ⇒ **任何**入站都以 `UNMAPPED_USER`
// 具名拒绝并记账，**一个都不放行**。这不是"没接好"，是这一刀刻意的姿态：
// *外部身份 → Legion 用户 的映射该由谁定、从哪读，是**产品决定**，不是顺手能定的。
// 在它定下来之前，正确的默认是"接进来了，但一条都进不去"，而不是"先放行再说"。*
// ============================================================================

import { createChannelRegistry, createInboundGate, REJECT } from '../../runtime/contracts/channel-contract.mjs'
import { createRestChannel } from '../../runtime/channels/rest.mjs'
import { createFeishuChannel } from '../../runtime/channels/feishu.mjs'
import { createEmailChannel } from '../../runtime/channels/email.mjs'

/**
 * 造渠道入站族路由。
 *
 * @param {object} deps 依赖由 `server.mjs` 注入
 * @param {object} [deps.identityMap] `${channelId}:${externalUserId}` → Legion userId；
 *   **不传 ⇒ 空映射 ⇒ 一律 `UNMAPPED_USER`**（失败关闭）
 */
export function createChannelRoutes({
  json,
  handleWrite,
  identityMap,
}) {
  const deps = { json, handleWrite }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createChannelRoutes 缺注入项：${k}`)
  }

  const registry = createChannelRegistry()
  // ★ 三个渠道都注册进**同一个**闸门：新增渠道不需要动契约、也不需要动本族的判定逻辑。
  registry.register(createRestChannel())
  registry.register(createFeishuChannel())
  registry.register(createEmailChannel())
  const gate = createInboundGate({ registry, identityMap: identityMap ?? new Map() })

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
            return { accepted: true, channelId, runKey: decision.runKey, userId: decision.event.userId }
          }
          // ★ 幂等命中**不是错误**：它必须指回同一个 runKey，调用方据此知道"这条已经进过了"。
          if (decision.reason === REJECT.DUPLICATE) {
            return { accepted: true, duplicate: true, channelId, runKey: decision.runKey }
          }
          // 其余一律以具名理由拒绝（handleWrite 会把抛出转成 4xx，理由随体返回）。
          throw new Error(`渠道入站被拒：${decision.reason}`)
        })
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
 * ★ 它只做解析与形状校验，**不决定这份表从哪来** —— "外部身份 → Legion 用户"的来源是
 *   **产品决定**（Workbench 里配？hub 里存一张表？），在这里不能靠默认值替它决定。
 *   因此本函数要一个**显式的 path 或文本**，没有默认位置、没有内置兜底表。
 *
 * ★ 形状不对**当场抛**，不静默忽略：一张"看着像映射表、其实键写错了"的表，
 *   与一张空表，在"每条入站都被拒"这个读数上是同一个东西 —— 于是人们会去查渠道，
 *   而问题在那张表。
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

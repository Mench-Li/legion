// product/heartbeat-transport.mjs
// ============================================================================
// PRT-713 收尾：**真实的发送通道**
//
// ## 为什么这一条不能只靠在用例里注入一个 `async (payload) => any`
//
// 原来的诚实边界里写着：「没有真实的 transport——它是注入的，
// 所以这个产品目前**发不出去任何心跳**」。那句话是对的，而且它比听起来更重：
//
//   注入式 transport 让**所有**关于心跳的用例都能跑绿——脱敏、开关、
//   代际、同意检查，一个都不少。于是整套测试守住了"什么不许发出去"，
//   而**没有任何一条**碰到"发出去"这件事本身。
//
//   > 一个"所有闸门都被测过、但门后没有路"的心跳，
//   > 与一个"真的能发出去"的心跳，在测试报告上是同一个读数——
//   > 只不过前者永远不会因为网络、超时、证书而失败，
//   > 所以它**也不会**因为那些原因被修好。
//
// ## 这一层要守住的三件事
//
// ① **`timeoutMs` 必须真的生效。** 原来那一栏挂着没实现（"超时该由注入的
//    transport 负责，产品自己并没有实现超时"）。一个不做超时的发送，
//    会让"每 6 小时一次"变成"每 6 小时加一个无限期挂着的请求"——
//    而定时器是 `unref` 的，所以它不会拦住进程退出，只会**悄悄堆积**。
//
// ② **不重试。** 与 `createHeartbeat` 的纪律一致（"不会重试，等下一个周期"）。
//    这里再做一次重试的话，"关掉"之后在路上的重试就会成为一个新的泄漏口。
//
// ③ **`https` 是这一层自己判的**，而不是只靠策略校验。
//    策略校验在**构造时**跑一次；而端点是可以被后来的代码改掉的
//    （`createHeartbeat` 拿到的是 `effective` 快照，但调用方完全可以
//    用别的依赖组合出这个 transport）。一道依赖"前面某个校验已经跑过"的闸，
//    在有人把那行校验挪走的那个下午就失效了。
//
// ## 关于两个"没有调用方"的码
//
// PRT-713 的行里写着：`HEARTBEAT_INVALID_ENDPOINT` 与
// `HEARTBEAT_PAYLOAD_REJECTED` **目前没有调用方会产生**，
// 并明确说"不要读成已经支持了"。这一层就是它们的调用方。
//
// ============================================================================

import { HEARTBEAT_CODES } from './heartbeat.mjs'

/**
 * 载荷字节上限。
 *
 * 允许名单已经限定了载荷的形状（十来个叶子值），所以一份合法心跳远远到不了 1KB。
 * 这个上限的作用不是"防止大载荷"，而是**在允许名单被加宽时立刻失败**——
 * 一个悄悄变大的心跳载荷，正是"有人往上游加了个自由文本字段"的形状。
 *
 *   > 一个"载荷变大了但看不出来"的上报通道，
 *   > 与一个会把新字段发出去的通道，在"下一次谁忘了"上是同一个东西。
 */
export const MAX_PAYLOAD_BYTES = 4096

/** 默认超时，与 `DEFAULT_HEARTBEAT_POLICY.timeoutMs` 一致。 */
const DEFAULT_TIMEOUT_MS = 10 * 1000

/** 造一个带码的错误。`createHeartbeat` 会**保留这个码**，不把它压成 SEND_FAILED。 */
function transportError(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

/**
 * 判定一个端点是不是这一层能用的。
 *
 * 只认 `https:`：心跳链路上有队列深度/错误率/可用率，合起来足以推断
 * 一台机器在干什么。
 *
 * @returns {{ok: true, url: URL} | {ok: false, code: string, message: string}}
 */
export function checkEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint === '') {
    return { ok: false, code: HEARTBEAT_CODES.INVALID_ENDPOINT, message: '没有端点：不发' }
  }
  let u = null
  try {
    u = new URL(endpoint)
  } catch {
    return { ok: false, code: HEARTBEAT_CODES.INVALID_ENDPOINT, message: `端点不是一个合法 URL，不发` }
  }
  if (u.protocol !== 'https:') {
    return {
      ok: false, code: HEARTBEAT_CODES.INVALID_ENDPOINT,
      message: `端点必须是 https（收到 ${u.protocol}）：明文出去等于没有保护`,
    }
  }
  return { ok: true, url: u }
}

/**
 * 判定载荷能不能发出去。
 *
 * 三条：是普通对象、能序列化、字节数在限内。
 * 返回**字节**而不是对象——序列化只做一次，发出去的就是校验过的那一份。
 *
 * ★ 这一点不是洁癖：先校验对象、再另外序列化一次，中间那段代码
 *   （比如一个 getter）有第二次机会改内容。**校验的和发出去的必须是同一串字节。**
 */
export function checkPayload(payload, maxBytes = MAX_PAYLOAD_BYTES) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: HEARTBEAT_CODES.PAYLOAD_REJECTED, message: '载荷必须是一个普通对象' }
  }
  let body = null
  try {
    body = JSON.stringify(payload)
  } catch (e) {
    return {
      ok: false, code: HEARTBEAT_CODES.PAYLOAD_REJECTED,
      message: `载荷序列化失败：${e instanceof Error ? e.message : e}`,
    }
  }
  if (typeof body !== 'string') {
    // `JSON.stringify(undefined)` / 循环引用被 toJSON 吃掉等
    return { ok: false, code: HEARTBEAT_CODES.PAYLOAD_REJECTED, message: '载荷序列化后不是一个字符串' }
  }
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > maxBytes) {
    return {
      ok: false, code: HEARTBEAT_CODES.PAYLOAD_REJECTED,
      message: `载荷 ${bytes} 字节超过了 ${maxBytes} 字节上限：`
        + '合法心跳远到不了这个数，超了说明允许名单被加宽了',
    }
  }
  return { ok: true, body, bytes }
}

/**
 * 造一个真实的 HTTPS 发送通道。
 *
 * @param {object} deps
 * @param {object} deps.policy      `validateHeartbeatPolicy` 的结果里的 `policy`，
 *                                  或者任何带 `endpoint`/`timeoutMs` 的对象
 * @param {Function} [deps.requestImpl]  注入点，默认 `node:https.request`
 * @param {number}  [deps.maxPayloadBytes]
 * @param {Function} [deps.logger]
 *
 * @returns {(payload: object) => Promise<{ok: true, status: number, bytes: number}>}
 *   **失败时抛错**（带 `code`），因为 `createHeartbeat` 的 catch 就是它的失败路径。
 */
export function createHttpTransport(deps = {}) {
  const {
    policy = {},
    requestImpl = null,
    maxPayloadBytes = MAX_PAYLOAD_BYTES,
    logger = null,
  } = deps

  const endpoint = policy.endpoint ?? null
  const timeoutMs = Number.isInteger(policy.timeoutMs) && policy.timeoutMs > 0
    ? policy.timeoutMs
    : DEFAULT_TIMEOUT_MS

  let impl = requestImpl
  let implResolved = requestImpl !== null

  return async function transport(payload) {
    // ── ① 端点：这一层自己判，不假设调用方已经校验过 ──
    const ep = checkEndpoint(endpoint)
    if (ep.ok !== true) throw transportError(ep.code, ep.message)

    // ── ② 载荷：校验得到的**那一串字节**就是发出去的字节 ──
    const pl = checkPayload(payload, maxPayloadBytes)
    if (pl.ok !== true) throw transportError(pl.code, pl.message)

    // ── ③ 拿到 request 实现（懒加载：没开心跳的进程不该因为 import 就碰到 https） ──
    if (!implResolved) {
      const mod = await import('node:https')
      impl = mod.request
      implResolved = true
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }

      let req = null
      try {
        req = impl({
          method: 'POST',
          protocol: ep.url.protocol,
          hostname: ep.url.hostname,
          port: ep.url.port === '' ? 443 : Number(ep.url.port),
          path: `${ep.url.pathname}${ep.url.search}`,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(pl.body, 'utf8'),
            'user-agent': 'legion-heartbeat/1',
          },
        })
      } catch (e) {
        // 连 `request()` 都起不来（比如实现被换掉、或者参数形状不对）
        done(reject, transportError(HEARTBEAT_CODES.SEND_FAILED,
          `无法发起请求：${e instanceof Error ? e.message : e}`))
        return
      }

      // ── 超时：这是 `timeoutMs` **唯一**真正生效的地方 ──
      //
      // 用 `setTimeout` 而不是 `req.setTimeout`：后者的语义是"套接字空闲超时"，
      // 一个**连上了但一直不收响应体**的服务端可以让它永远不触发。
      // 这里要的是"这一次发送最多花多久"，所以按墙钟算。
      const timer = setTimeout(() => {
        // 先 destroy 再 reject：不 destroy 的话套接字会一直挂到进程退出，
        // 而"每 6 小时一次"会因此变成一堆僵尸连接。
        try { req?.destroy?.() } catch { /* 已经坏了就算了 */ }
        done(reject, transportError(HEARTBEAT_CODES.SEND_FAILED,
          `发送超时（${timeoutMs}ms）：不会重试，等下一个周期`, { timeoutMs }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      const finish = (fn, arg) => {
        clearTimeout(timer)
        done(fn, arg)
      }

      req.on?.('error', (e) => {
        finish(reject, transportError(HEARTBEAT_CODES.SEND_FAILED,
          `发送失败（不会重试，等下一个周期）：${e?.message ?? e}`))
      })
      req.on?.('response', (res) => {
        const status = res.statusCode ?? 0
        // 响应体必须**排空**：不排空的话连接不会释放，
        // 而且一个不读响应的客户端在某些服务端上会被直接断掉。
        try { res.resume?.() } catch { /* 排空失败不影响"发过没发过"这件事 */ }
        res.on?.('error', (e) => {
          finish(reject, transportError(HEARTBEAT_CODES.SEND_FAILED,
            `读取响应失败：${e?.message ?? e}`))
        })
        res.on?.('end', () => {
          if (status >= 200 && status < 300) {
            finish(resolve, Object.freeze({ ok: true, status, bytes: pl.bytes }))
          } else {
            finish(reject, transportError(HEARTBEAT_CODES.SEND_FAILED,
              `服务端返回 ${status}（不会重试，等下一个周期）`, { status }))
          }
        })
      })

      try {
        req.write(pl.body)
        req.end()
      } catch (e) {
        finish(reject, transportError(HEARTBEAT_CODES.SEND_FAILED,
          `写入请求失败：${e instanceof Error ? e.message : e}`))
      }

      if (typeof logger === 'function') logger(`[heartbeat] 已发出（${pl.bytes} 字节，超时 ${timeoutMs}ms）`)
    })
  }
}

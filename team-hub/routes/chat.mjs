// team-hub/routes/chat.mjs
// ============================================================================
// 路由层第三族：**对话中心（chat）** —— PRT-316 切片 3
//
// 缝在 `team-hub/router.mjs`（切片 1 立的），本文件是搬进那个家的第三族。
//
// ## 本文件是**生成**的，不是手抄的
//
// 生成器：`.worktrees/_prt-handoff/gen-chat-routes.mjs`（读 `server.mjs` 的 chat 段，
// 逐条搬函数体、去掉末尾的 `return`、整体 +2 缩进）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// 切片 1/2 的手抄靠事后的逐字对拍兜底；这一族直接用生成器搬，
// 于是"抄错一个字"在结构上不可能发生——`pair-routes.mjs` 随后独立复核它。
//
// ## 为什么整段搬（13 条 / 5 个小节）而不是再切碎
//
// 原文这一段自己就分了 5 个小节（会话与消息 / 附件 / 健康 / AI 回复），
// 但它们的路径前缀是同一个 `/api/chat/`。搬完这一片之后，
// **整个 `/api/chat/*` 命名空间都住在模块里**，`server.mjs` 里不再有 chat 路由。
//
//   > 一个"把某前缀的路由搬走一半"的切片，与一个"搬完整个前缀"的切片，
//   > 在只搬了一半的那些天里是同一个东西——只不过前者会让下一个读代码的人
//   > 在两个地方各找一遍同一条路由。
//
// ## 零注入改写
//
// 13 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
//
// ★ 切片 3/4 当时把它换成了上面那行"已提取到 …"的指针，于是这段说明只留在
//   git 历史里。对拍只比**函数体**，而理由从来不在函数体里 —— 于是它能一路
//   绿着把理由丢掉。切片 6 起由生成器保证一起搬走；这里是把历史欠账补上。
//
//   > 一个"搬走了代码、留下了指针"的提取，与一个"搬走了理由、留下了结论"的提取，
//   > 在用例全绿、对拍逐字节相同的时候是同一个东西。
// ============================================================================
// ── 对话中心（chat）：会话 / 消息 REST（scope 分区 + by 写纪律；审计/SSE 在 DAO 内统一留痕）──

/**
 * 造对话中心族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 * @param {Function} deps.json
 * @param {Function} deps.handleWrite
 * @param {Function} deps.authorized
 * @param {Function} deps.readRawBody
 * @param {number}   deps.CHAT_ATTACH_MAX_BYTES
 * @param {Function} deps.createConversation
 * @param {Function} deps.listConversations
 * @param {Function} deps.postMessage
 * @param {Function} deps.listMessages
 * @param {Function} deps.cleanupChatAttachments
 * @param {Function} deps.uploadChatAttachment
 * @param {Function} deps.readChatAttachmentContent
 * @param {Function} deps.chatHealth
 * @param {Function} deps.getReplySettings
 * @param {Function} deps.saveReplySettings
 * @param {Function} deps.listAwaitingReplies
 * @param {Function} deps.postAiReply
 * @param {Function} deps.failAiReply
 * @param {Function} deps.retryAiReply
 */
export function createChatRoutes({
  json, handleWrite, authorized, readRawBody, CHAT_ATTACH_MAX_BYTES,
  createConversation, listConversations, postMessage, listMessages,
  cleanupChatAttachments, uploadChatAttachment, readChatAttachmentContent, chatHealth,
  getReplySettings, saveReplySettings, listAwaitingReplies, postAiReply,
  failAiReply, retryAiReply,
  // 按**账号**的用量配额（`requireAccountQuota`，见 server.mjs）。
  // 未注入时**不做判定** —— 与 `requireSpace` 在本机部署下的既有语义一致。
  requireQuota = null,
}) {
  const deps = {
    json, handleWrite, authorized, readRawBody,
    createConversation, listConversations, postMessage, listMessages,
    cleanupChatAttachments, uploadChatAttachment, readChatAttachmentContent, chatHealth,
    getReplySettings, saveReplySettings, listAwaitingReplies, postAiReply,
    failAiReply, retryAiReply,
  }
  for (const [name, fn] of Object.entries(deps)) {
    if (typeof fn !== 'function') throw new TypeError(`createChatRoutes 缺注入项：${name}`)
  }
  if (!Number.isFinite(CHAT_ATTACH_MAX_BYTES)) throw new TypeError('createChatRoutes 缺注入项：CHAT_ATTACH_MAX_BYTES')

  /**
   * 过一遍按账号的用量配额。**已经答复了就返回 true**，调用方直接 return。
   *
   * 抽成一个小函数是因为这个文件里**有两条**消息写入路径
   * （`POST /api/chat/messages` 与 `POST /api/chat/ai-replies`），
   * 而两处抄一遍判断必然漂 —— 漏掉的那一条就是攻击者会走的那一条。
   */
  function quotaBlocked(req, res, resource) {
    if (typeof requireQuota !== 'function') return false
    try {
      requireQuota(req, resource)
      return false
    } catch (e) {
      // ★ `Retry-After` 是 HTTP 语义的一部分：客户端应当照它退避。
      //   丢了它就等于让用户自己猜一个间隔，而猜的结果通常是**反复重试** ——
      //   那正好把窗口一直占住，是配额最不希望看到的反应。
      if (Number.isFinite(e?.retryAfterSec) && e.retryAfterSec > 0) {
        try { res.setHeader('retry-after', String(e.retryAfterSec)) } catch { /* 适配层没有 setHeader */ }
      }
      const status = Number(e?.status) >= 400 ? Number(e.status) : 400
      json(res, status, {
        ok: false,
        code: e?.code ?? 'CHAT_REQUEST_FAILED',
        error: e instanceof Error ? e.message : String(e),
        ...(Number.isFinite(e?.retryAfterSec) ? { retryAfterSec: e.retryAfterSec } : {}),
      })
      return true
    }
  }

  const routes = [
    {
      method: 'POST',
      path: '/api/chat/conversations',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => createConversation({ ...body, by }))
      },
    },
    {
      method: 'GET',
      path: '/api/chat/conversations',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? undefined
          json(res, 200, { scope: scopeParam ?? null, conversations: listConversations({ scope: scopeParam }) })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/chat/messages',
      async run(req, res) {
        // ★ 配额在**最前面**：在解析 body、查库之前。放在后面的话，
        //   被拒的请求仍然会付出一次正文解析与一次会话查找。
        if (quotaBlocked(req, res, 'message')) return
        await handleWrite(req, res, (body, by) => postMessage({ ...body, by }))
      },
    },
    {
      method: 'GET',
      path: '/api/chat/messages',
      async run(req, res, { url }) {
        try {
          const conv = url.searchParams.get('conv')
          if (!conv) throw new Error('缺少参数 conv')
          const limitRaw = url.searchParams.get('limit')
          const beforeRaw = url.searchParams.get('before')
          const messages = listMessages({
            conv: Number(conv),
            limit: limitRaw === null ? 50 : Number(limitRaw),
            before: beforeRaw === null ? undefined : Number(beforeRaw),
          })
          json(res, 200, { conv: Number(conv), messages })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'PUT',
      path: '/api/chat/attachments',
      async run(req, res, { url }) {
        try {
          if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
          const scopeParam = (url.searchParams.get('scope') ?? '').trim()
          const byParam = (url.searchParams.get('by') ?? '').trim()
          const fileName = (url.searchParams.get('fileName') ?? '').trim()
          if (!byParam) throw new Error('缺少操作者身份 by')
          cleanupChatAttachments({ scope: scopeParam }) // 顺带孤儿/过期清理（hub 周期宿主之一）
          const buf = await readRawBody(req, CHAT_ATTACH_MAX_BYTES)
          const att = uploadChatAttachment({ scope: scopeParam, fileName, content: buf, by: byParam })
          json(res, 200, att)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          const code = e && typeof e === 'object' && 'statusCode' in e ? e.statusCode : 400
          json(res, code >= 400 && code < 500 ? code : 400, { error: message })
        }
      },
    },
    {
      method: 'GET',
      path: '/api/chat/attachments/content',
      async run(req, res, { url }) {
        try {
          const scopeParam = (url.searchParams.get('scope') ?? '').trim()
          const byParam = (url.searchParams.get('by') ?? '').trim()
          const out = readChatAttachmentContent({ id: url.searchParams.get('id'), conv: url.searchParams.get('conv'), scope: scopeParam, by: byParam })
          json(res, 200, out)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          const status = /不属于该会话|越权|跨会话/.test(message) ? 403 : /不存在|附件文件/.test(message) ? 404 : 400
          json(res, status, { error: message })
        }
      },
    },
    {
      method: 'GET',
      path: '/api/chat/health',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? ''
          json(res, 200, chatHealth(scopeParam))
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'GET',
      path: '/api/chat/reply-settings',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? 'default'
          if (typeof scopeParam !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scopeParam.trim())) throw new Error('scope 非法：小写字母/数字开头的空间 id（≤64 字符）')
          json(res, 200, getReplySettings(scopeParam.trim()))
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/chat/reply-settings',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => saveReplySettings({ ...body, by }))
      },
    },
    {
      method: 'GET',
      path: '/api/chat/replies',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope')
          if (!scopeParam || scopeParam.trim().length === 0) throw new Error('缺少参数 scope')
          const sinceRaw = url.searchParams.get('sinceMsgId')
          const limitRaw = url.searchParams.get('limit')
          const since = sinceRaw === null ? 0 : Number(sinceRaw)
          if (!Number.isInteger(since) || since < 0) throw new Error('sinceMsgId 必须是 ≥0 的整数')
          const lim = limitRaw === null ? 20 : Number(limitRaw)
          if (!Number.isInteger(lim) || lim <= 0) throw new Error('limit 必须是正整数')
          const convRaw = url.searchParams.get('conv')
          const convFilter = convRaw === null ? null : Number(convRaw)
          if (convFilter !== null && (!Number.isInteger(convFilter) || convFilter <= 0)) throw new Error('conv 必须是会话 id')
          let messages = listAwaitingReplies({ scope: scopeParam.trim(), sinceMsgId: since, limit: lim })
          if (convFilter !== null) messages = messages.filter(m => m.convId === convFilter)
          json(res, 200, { scope: scopeParam.trim(), sinceMsgId: since, limit: lim, messages })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/chat/replies/answer',
      async run(req, res) {
        // 回复方应答：body { msgId, body, model?, kind? }；by 须为回复方身份（author=by 防冒名在 DAO 内绑定）。
        //
        // ★ 这里**刻意不过**消息配额，理由是它**已经被配额间接约束**了：
        //   `postAiReply` 开头就判 `meta2.aiStatus !== 'awaiting'` 并直接返回
        //   `{skipped:true}` —— 一条待回复的用户消息**最多只能产生一条回复**。
        //   用户消息的条数已经被 `POST /api/chat/messages` 那一层限住，
        //   所以回复的条数 ≤ 用户消息的条数。
        //
        //   在这里再扣一次会变成**双重计数**：用户发一条消息被扣一次，
        //   系统替它自动回复又被扣一次 —— 于是"我一小时只发了 150 条，
        //   为什么说满了"变成了一个没人能解释的现象。
        //
        //   > 一个把"用户做的事"与"系统对它的反应"记进同一份配额的账本，
        //   > 会让配额的实际含义变成"用户看到的动作数"——
        //   > 而那不是一个用户能自己数清楚、也不该由他承担的数目。
        await handleWrite(req, res, (body, by) => postAiReply({ ...body, by }))
      },
    },
    {
      method: 'POST',
      path: '/api/chat/replies/fail',
      async run(req, res) {
        // 守护 chat-responder 显式失败回写（body: msgId + error + by；CAS awaiting→failed，幂等）。
        await handleWrite(req, res, (body, by) => failAiReply({ ...body, by }))
      },
    },
    {
      method: 'POST',
      path: '/api/chat/replies/retry',
      async run(req, res) {
        // UI 失败重试：把 failed 的 awaiting 源消息重置回 awaiting。
        await handleWrite(req, res, (body, by) => retryAiReply({ ...body, by }))
      },
    },
  ]

  return {
    id: 'chat',
    routes,
    /** 13 条全是等值匹配；顺序与 `handle` 里原来那 13 条 `if` 相同。 */
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || ctx.path !== r.path) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

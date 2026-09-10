/**
 * p26-chat-e2e.mjs — P2-6 真实守护与模型通道端到端探针（用户已授权：生产 software 空间 1 条消息）。
 *
 * 链路：创建探针会话 → 发一条消息（服务端据开关标 meta.aiStatus=awaiting）→ 轮询守望守护
 * （真实 worker 进程每轮节拍 30s 拉 /api/chat/replies → ctx.subagents.start 真实模型 → 回写
 * /api/chat/replies/answer）→ 断言状态从 awaiting 流转到 replied/failed，并记录模型与耗时。
 *
 * 纪律：
 * - 只发 1 条消息、只创建 1 个探针会话；不做任何删除操作（留痕可复查）。
 * - 全程只读轮询，失败也不改写服务端状态（避免干扰生产库）。
 * - 输出结构化结论，供 docs/P2-6-evidence/ 留痕。
 */
const HUB = process.env.P26_HUB || 'http://127.0.0.1:8787'
const SCOPE = 'software'
const AUTHOR = 'p26-probe'
const TIMEOUT_MS = Number(process.env.P26_TIMEOUT_MS || 240000)

const jpost = (p, b) => fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
const jget = (p) => fetch(HUB + p)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读一条消息（从会话消息列表中按 id 找），返回 {id, aiStatus, aiError, aiModel, aiReplyId} 等。 */
async function readMsg(convId, msgId) {
  const r = await jget('/api/chat/messages?conv=' + String(convId) + '&limit=50')
  if (!r.ok) return null
  const data = await r.json()
  const list = data.messages ?? data
  const m = (Array.isArray(list) ? list : []).find((x) => x.id === msgId)
  if (!m) return null
  const meta = m.meta ?? {}
  return { id: m.id, body: m.body, author: m.author, aiStatus: meta.aiStatus ?? null, aiError: meta.aiError ?? null, aiModel: meta.aiModel ?? null, aiReplyId: meta.aiReplyId ?? null, raw: meta }
}

const t0 = Date.now()
const timeline = []
const log = (s) => { timeline.push(`[+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${s}`); console.log(timeline[timeline.length - 1]) }

try {
  // 0) 前置：健康 + 开关（真实环境是否具备 E2E 条件）
  const h = await (await jget('/api/chat/health?scope=' + SCOPE)).json()
  log('health: online=' + String(h.online) + ' enabled=' + String(h.enabled) + ' modelResolved=' + String(h.modelResolved) + ' model=' + JSON.stringify(h.model))
  if (!h.online || !h.enabled) { console.log('PRECONDITION-FAIL: 守护离线或回复开关关闭，无法做真实 E2E'); process.exit(2) }

  // 1) 创建探针会话
  const cr = await jpost('/api/chat/conversations', { scope: SCOPE, title: 'P2-6 真实模型通道探针（可留痕）', kind: 'space', by: AUTHOR })
  if (!cr.ok) { console.log('CREATE-FAIL: ' + String(cr.status) + ' ' + (await cr.text()).slice(0, 200)); process.exit(3) }
  const conv = (await cr.json()).task
  log('创建探针会话 conv=' + String(conv.id) + ' title=' + conv.title)

  // 2) 发 1 条消息（服务端应标 awaiting）
  const body = '这是 P2-6 真实模型通道端到端探针（自动发送，仅一条）。请用一句话确认你已收到，并说明你是哪个模型。'
  const sr = await jpost('/api/chat/messages', { conv: conv.id, scope: SCOPE, kind: 'text', body, by: AUTHOR })
  if (!sr.ok) { console.log('SEND-FAIL: ' + String(sr.status) + ' ' + (await sr.text()).slice(0, 200)); process.exit(4) }
  const msg = (await sr.json()).task
  log('发送消息 id=' + String(msg.id) + ' author=' + msg.author)

  const first = await readMsg(conv.id, msg.id)
  log('发送后状态: aiStatus=' + String(first?.aiStatus) + '（期望 awaiting）')

  // 3) 守望守护回复（轮询，直到 replied/failed/超时）
  const polls = []
  let final = first
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(4000)
    const cur = await readMsg(conv.id, msg.id)
    if (cur === null) continue
    polls.push(cur.aiStatus)
    if (cur.aiStatus !== first?.aiStatus) {
      log('状态变化: ' + String(first?.aiStatus) + ' → ' + String(cur.aiStatus))
      final = cur
      break
    }
    final = cur
  }

  // 4) 读取守护回复气泡（会话里应有一条 author=<scope>-assistant 的回复）
  const after = await (await jget('/api/chat/messages?conv=' + String(conv.id) + '&limit=50')).json()
  const all = Array.isArray(after.messages) ? after.messages : []
  const reply = all.find((m) => m.author !== AUTHOR && m.author !== 'general' && m.id !== msg.id)
  log('会话消息数=' + String(all.length) + ' 回复条数=' + String(all.filter(m => m.author !== AUTHOR).length))

  console.log('\n===== 结论 =====')
  console.log('状态流转: ' + String(first?.aiStatus) + ' → ' + String(final?.aiStatus))
  console.log('轮询观测序列: ' + JSON.stringify(polls.slice(0, 20)))
  console.log('回复者: ' + String(reply?.author ?? '（无）'))
  console.log('回复正文: ' + String(reply?.body ?? '（无）').slice(0, 300))
  console.log('meta: ' + JSON.stringify(reply?.meta ?? final?.raw ?? {}).slice(0, 300))
  console.log('耗时: ' + String(Math.round((Date.now() - t0) / 1000)) + 's')
  console.log('conv=' + String(conv.id) + ' msg=' + String(msg.id) + ' scope=' + SCOPE)
  const ok = final?.aiStatus === 'replied' && reply !== undefined
  console.log(ok ? 'E2E-PASS: 真实守护已用真实模型回复并回写' : ('E2E-' + (final?.aiStatus === 'failed' ? 'FAILED-REPLY' : 'TIMEOUT') + ': aiStatus=' + String(final?.aiStatus)))
  console.log('\n===== 时间线 =====')
  for (const t of timeline) console.log(t)
  process.exit(ok ? 0 : 5)
} catch (e) {
  console.log('EXCEPTION: ' + String(e))
  process.exit(6)
}

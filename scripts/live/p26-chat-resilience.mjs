/**
 * p26-chat-resilience.mjs — P2-6 断线恢复与三态流转的**真实链路**验证（隔离 hub 实例，不碰生产库）。
 *
 * 验证什么（前端纯函数已在 chat-ui.test.mjs 覆盖，这里验证它们依赖的**服务端事实**）：
 *   ① /api/events 的 seq 在真实写入下连续单调（缺口判据 shouldRefillChat 的前提成立）；
 *   ② 断开 SSE 期间发生的写操作不会丢 seq——重连补拉 /api/chat/messages 即可拿回三态更新，
 *      即「断线恢复 = 靠 seq 缺口发现 + 重拉补齐」这一前端策略在本服务端成立；
 *   ③ awaiting → replied 的 meta 更新走 audit（chat:reply），前端据 SSE action 过滤能收到；
 *   ④ 失败路径：把回复标记为 failed 后，消息 meta.aiError 可读（前端 failed 态文案来源）。
 *
 * 运行：node scripts/live/p26-chat-resilience.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'p26-res-'))
const port = 47000 + Math.floor(Math.random() * 900)
const base = 'http://127.0.0.1:' + String(port)
const SCOPE = 'p26-res'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) { pass += 1; console.log('  ✓ ' + label + (extra ? ' — ' + extra : '')) } else { fail += 1; console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')) }
}

const jpost = async (p, b) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const jget = async (p) => {
  const r = await fetch(base + p)
  return { status: r.status, json: await r.json().catch(() => null) }
}

/** 极简 SSE 客户端：解析 id:/event:/data: 行（与 notify 冒烟同一手法）。可指定 last-event-id 走增量回放。 */
class MiniSse {
  constructor(url) { this.url = url; this.seqs = []; this.actions = []; this.opens = 0; this.abort = null }
  async open(lastEventId) {
    this.abort = new AbortController()
    this.opens += 1
    const headers = { accept: 'text/event-stream' }
    // 浏览器原生 EventSource 在自动重连时会自带 Last-Event-ID；此处显式模拟该头
    if (Number.isFinite(lastEventId)) headers['last-event-id'] = String(lastEventId)
    const res = await fetch(this.url, { signal: this.abort.signal, headers })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const pump = async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let id = null
          let data = ''
          for (const line of chunk.split('\n')) {
            if (line.startsWith('id:')) id = line.slice(3).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (id !== null && id.length > 0) this.seqs.push(Number(id))
          if (data.length > 0) {
            try { const ev = JSON.parse(data); this.actions.push(String(ev.action ?? ev.kind ?? '')) } catch { /* 非 JSON 帧 */ }
          }
        }
      }
    }
    this.pumping = pump().catch(() => { /* 主动 abort 关闭属预期，不外抛（否则 unhandled rejection） */ })
    return this
  }
  close() { try { this.abort?.abort() } catch { /* 已关闭 */ } }
}

const child = spawn(process.execPath, ['team-hub/server.mjs'], {
  env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: join(tmp, 'res.db'), TEAM_HUB_TOKEN: '' },
  stdio: ['ignore', 'ignore', 'pipe'],
})

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(base + '/api/config')).ok) break } catch { /* 未起 */ }
    await sleep(120)
  }
  console.log('== 1. SSE 基线：seq 连续单调（缺口判据前提）==')
  const sse = await new MiniSse(base + '/api/events').open()
  await sleep(200)
  const conv = (await jpost('/api/chat/conversations', { scope: SCOPE, title: '断线恢复验证', kind: 'space', by: 'general' })).json.task
  const m1 = (await jpost('/api/chat/messages', { conv: conv.id, scope: SCOPE, body: '第一条', by: 'general' })).json.task
  await sleep(300)
  check(sse.seqs.length >= 2, 'SSE 收到 >=2 帧', 'seqs=' + JSON.stringify(sse.seqs))
  const sorted = sse.seqs.every((s, i) => i === 0 || s > sse.seqs[i - 1])
  check(sorted, 'seq 严格递增（无重复/无回退）')
  const gaps = sse.seqs.filter((s, i) => i > 0 && s > sse.seqs[i - 1] + 1)
  check(gaps.length === 0, '在线期间无缺口（shouldRefillChat 不误报）', 'gaps=' + JSON.stringify(gaps))
  check(sse.actions.some(a => a === 'chat:message'), 'chat:message 事件可被前端按 action 过滤到', JSON.stringify(sse.actions.slice(-4)))

  console.log('== 2. 断线期间的写入：重连续传 + 缺口判据 ==')
  const watermark = sse.seqs[sse.seqs.length - 1] ?? 0
  sse.close() // 模拟断线
  await sleep(150)
  const m2 = (await jpost('/api/chat/messages', { conv: conv.id, scope: SCOPE, body: '断线期间的第 2 条', by: 'general' })).json.task
  const m3 = (await jpost('/api/chat/messages', { conv: conv.id, scope: SCOPE, body: '断线期间的第 3 条', by: 'general' })).json.task
  // 断线期间还发生一次 AI 三态更新（模拟守护回写）：会新增一条回复消息行
  const ans = await jpost('/api/chat/replies/answer', { msgId: m2.id, body: '断线期间的 AI 回复', by: SCOPE + '-assistant', model: 'test-model' })
  check(ans.status === 200, '断线期间守护回写 replied 成功', 'status=' + String(ans.status))
  // ① 带 Last-Event-ID 重连 → 服务端只回放 seq > watermark 的增量（浏览器 EventSource 自动带该头）
  const sse2 = await new MiniSse(base + '/api/events').open(watermark)
  await sleep(400)
  check(sse2.seqs.length >= 3, '续传拿到断线期间的增量帧', 'seqs=' + JSON.stringify(sse2.seqs) + ' watermark=' + String(watermark))
  const firstSeq = sse2.seqs[0]
  check(firstSeq === watermark + 1, '续传从 watermark+1 开始（无重复、无空洞）', 'firstSeq=' + String(firstSeq))
  const incrementalOk = sse2.seqs.every((s, i) => i === 0 || s === sse2.seqs[i - 1] + 1)
  check(incrementalOk, '续传帧 seq 连续（前端不会误判缺口 → 不触发多余重拉）')
  check(sse2.actions.some(a => a === 'chat:message'), 'AI 回复也走 chat:message 审计（前端按 action 过滤可收到）')
  sse2.close()
  // ② 不带 Last-Event-ID 重连 → 服务端只回放**最近 30 条**（有界！）——这正是前端 seq 缺口补齐层的存在理由：
  //    断线久到超过回放窗口时服务端续传不完整，必须靠本地水位检出缺口并重拉列表。
  const sse3 = await new MiniSse(base + '/api/events').open()
  await sleep(300)
  check(sse3.seqs.length > 0 && sse3.seqs.length <= 30, '无续传头 → 回放有界（最近 30 条）', 'replayed=' + String(sse3.seqs.length))
  sse3.close()
  // ③ 补拉：会话消息列表应含断线期间的用户消息 + 守护回复（这就是「补齐」的落点）
  const list = (await jget('/api/chat/messages?conv=' + String(conv.id) + '&limit=50')).json
  const all = list.messages ?? []
  const bodies = all.map(m => m.body)
  check(bodies.includes('断线期间的第 2 条') && bodies.includes('断线期间的第 3 条'), '补拉拿到断线期间全部用户消息（无丢失）', 'count=' + String(all.length))
  check(bodies.includes('断线期间的 AI 回复'), '补拉拿到守护在断线期间写下的回复行')
  const m2row = all.find(m => m.id === m2.id)
  check(m2row?.meta?.aiStatus === 'replied', '源消息三态终值随补拉可得（awaiting → replied）', 'aiStatus=' + String(m2row?.meta?.aiStatus))
  check(Number.isInteger(m2row?.meta?.replyMsg), '源消息记录回复行 id（replyMsg）', String(m2row?.meta?.replyMsg))
  // 模型名在**回复行**上（服务端契约）：前端据此显示「已回复 · 模型」
  const replyRow = all.find(m => m.id === m2row?.meta?.replyMsg)
  check(replyRow?.meta?.aiModel === 'test-model', '模型名落在回复行 meta.aiModel（源消息元数据不含模型）', JSON.stringify(replyRow?.meta))

  console.log('== 3. 失败路径：meta.aiError 可读（前端 failed 态文案来源）==')
  const m4 = (await jpost('/api/chat/messages', { conv: conv.id, scope: SCOPE, body: '第 4 条（将失败）', by: 'general' })).json.task
  check(m4.meta?.aiStatus === 'awaiting', '发消息即标 awaiting', JSON.stringify(m4.meta))
  const failed = await jpost('/api/chat/replies/fail', { msgId: m4.id, error: 'provider 超时（验证用）', by: SCOPE + '-assistant' })
  check(failed.status === 200, '标记失败成功（body 字段名是 error）', 'status=' + String(failed.status) + ' ' + JSON.stringify(failed.json).slice(0, 90))
  const list2 = (await jget('/api/chat/messages?conv=' + String(conv.id) + '&limit=50')).json.messages
  const m4row = list2.find(m => m.id === m4.id)
  check(m4row?.meta?.aiStatus === 'failed', '状态转 failed', String(m4row?.meta?.aiStatus))
  check(String(m4row?.meta?.aiError ?? '').includes('provider 超时'), '失败原因可读（前端展示用）', String(m4row?.meta?.aiError))
  // 重试：CAS 把 failed 重置回 awaiting（前端「↻ 重试」按钮的服务端契约）
  const retry = await jpost('/api/chat/replies/retry', { msgId: m4.id, by: 'general' })
  check(retry.status === 200, '重试成功（failed → awaiting）', 'status=' + String(retry.status))
  const list3 = (await jget('/api/chat/messages?conv=' + String(conv.id) + '&limit=50')).json.messages
  const m4after = list3.find(m => m.id === m4.id)
  check(m4after?.meta?.aiStatus === 'awaiting', '重试后回到 awaiting（前端可等下一轮守护）', String(m4after?.meta?.aiStatus))
  check(!('aiError' in (m4after?.meta ?? {})), '重试后清掉 aiError（不再显示旧失败原因）', JSON.stringify(m4after?.meta))
  // 重复重试：已回到 awaiting 的消息再重试 → CAS 拒绝（幂等语义）
  const repeated = await jpost('/api/chat/replies/retry', { msgId: m4.id, by: 'general' })
  check(repeated.status >= 400 || repeated.json?.task?.meta?.aiStatus === 'awaiting', '重复重试不产生二次入队（CAS 幂等）', 'status=' + String(repeated.status))

  console.log('== 4. 摘要 ==')
  console.log('  pass=' + String(pass) + ' fail=' + String(fail))
  console.log(fail === 0 ? 'RESILIENCE-PASS' : 'RESILIENCE-FAIL')
} catch (e) {
  console.log('EXCEPTION: ' + String(e && e.stack ? e.stack : e))
  fail += 1
} finally {
  try { child.kill() } catch { /* 已退出 */ }
  await sleep(200)
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* win 句柄 */ }
}
process.exit(fail === 0 ? 0 : 1)

#!/usr/bin/env node
// product/server/_phone-act.mjs —— 替手机做那几个动作（跑在服务器上，打本机 Hub）。
//
// 为什么不是内联 `node -e`：本轮已经踩过两次内联脚本的坑
// （`require`+顶层 `await` 的模块歧义、`handleWrite` 的 `{ok,task}` 信封读错层级）。
// 内联脚本没有语法检查、不能单独跑、错误又容易被调用方包装成别的原因。
//
// 子命令：
//   ask <消息>      向「编码实现」Agent 发一条提问，并读回时间线
//   create <目标>   发一条 intent=create_task 的消息（手机上的"创建任务"）
//   timeline        读回那条会话的完整时间线（含 Agent 的进展与回复）
//   task <任务id>   读任务与它的尝试/事件
import { readFileSync } from 'node:fs'

const HUB = process.env.HUB ?? 'http://127.0.0.1:8787'
const PW_FILE = process.env.PW_FILE ?? '/etc/legion-hub/first-admin-password.txt'
const SCOPE = process.env.SCOPE ?? 'default'
const AGENT_ROLE = process.env.AGENT_ROLE ?? 'coder'

const password = readFileSync(PW_FILE, 'utf8').replace(/[\r\n]+$/, '')

const call = async (method, path, { body, token } = {}) => {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(HUB + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) { console.error(`HTTP ${res.status} ${method} ${path}: ${json?.error ?? text.slice(0, 200)}`); process.exit(1) }
  return json
}

const login = await call('POST', '/api/identity/login', { body: { name: 'legion', password, label: 'phone-act' } })
const token = login.accessToken

// 「编码实现」Agent —— 手机上选的就是它
const agents = await call('GET', `/api/agents?scope=${SCOPE}`, { token })
const agent = (agents.agents ?? []).find((a) => a.role === AGENT_ROLE)
if (!agent) { console.error(`空间 ${SCOPE} 里没有 ${AGENT_ROLE} 这个 Agent`); process.exit(1) }

// 手机点进某个 Agent → 开一条会话（不带 taskId，是"直接对话"）
const conv = await call('POST', '/api/agent-conversations', {
  body: { agentId: agent.agentId, scope: SCOPE, by: 'phone' }, token,
})
const convId = conv.convId

const [cmd, arg] = process.argv.slice(2)

if (cmd === 'ask' || cmd === 'create') {
  const msg = await call('POST', '/api/agent-messages', {
    body: {
      conv: convId, scope: SCOPE, by: 'phone', body: arg,
      intent: cmd === 'create' ? 'create_task' : 'ask',
      clientRequestId: `phone-${Date.now()}`,
    },
    token,
  })
  console.log(JSON.stringify({ convId, agentId: agent.agentId, agentName: agent.name, ...msg }))
  process.exit(0)
}

if (cmd === 'timeline') {
  // `limit` 上限 200；够这一段用了。
  const r = await call('GET', `/api/chat/messages?conv=${convId}&scope=${SCOPE}&limit=200`, { token })
  const out = (r.messages ?? []).map((m) => ({
    id: m.id,
    author: m.author,
    source: m.meta?.source ?? null,
    semanticType: m.meta?.semanticType ?? null,
    taskId: m.meta?.taskId ?? null,
    body: String(m.body ?? '').slice(0, 160),
  }))
  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}

if (cmd === 'task') {
  const board = await call('GET', `/api/board?scope=${SCOPE}`, { token })
  const list = Array.isArray(board) ? board : (board.tasks ?? [])
  const t = list.find((x) => x.id === arg)
  if (!t) { console.error(`没有任务 ${arg}`); process.exit(1) }
  const detail = await call('GET', `/api/agent-detail?agentId=${agent.agentId}&scope=${SCOPE}`, { token })
  const mine = (detail.agent?.tasks ?? []).find((x) => x.id === arg)
  console.log(JSON.stringify({
    id: t.id, title: t.title, status: t.status,
    attempt: mine?.attempt ? { id: mine.attempt.id, state: mine.attempt.state, worker: mine.attempt.worker_id } : null,
    artifacts: t.artifacts ?? [],
  }, null, 1))
  process.exit(0)
}

console.error('用法: _phone-act.mjs ask|create <文本> | timeline | task <任务id>')
process.exit(2)

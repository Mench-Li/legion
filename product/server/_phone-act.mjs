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
//
// ★ 参数可以带 `--b64` 前缀，表示**后面的每个参数都是 base64 编码的**。
//
//   这是为了穿**两层 shell**：`verify-experience.sh` 把命令拼成一个字符串交给
//   `ssh <host> "<命令>"`，远端再交给一个 shell 去分词。带空格的参数（比如
//   「端到端验收：请写一个 greet 函数并跑一次测试」）会在那里被切成好几段，
//   而本脚本的 `argv.slice(2)` 只取前两个 —— 于是**消息在第一个空格处被截断**，
//   任务标题变成「端到端验收：请写一个」。
//
//   那个缺陷**不会报错**：任务照建、照跑、照完成，只是目标少了一半。
//   实测就是这么发现的——看板上留下的标题就是截断后的样子。
//
//     > 一个"参数在传输层被悄悄切开"的脚本，
//     > 与一个"用户只写了半句话"的脚本，在日志里是同一个东西——|
//     > 只不过前者永远修不好，因为没有人会去怀疑自己的参数。
import { readFileSync } from 'node:fs'

const HUB = process.env.HUB ?? 'http://127.0.0.1:8787'
const PW_FILE = process.env.PW_FILE ?? '/etc/legion-hub/first-admin-password.txt'
const SCOPE = process.env.SCOPE ?? 'default'
const AGENT_ROLE = process.env.AGENT_ROLE ?? 'coder'

// ★ 参数在**任何网络调用之前**解出来。
//
//   原先这一行排在登录、找 Agent、开会话之后——于是"参数是坏的"这件事要等
//   跑完两三个 HTTP 往返才被发现，而那几趟的失败会把真正的原因盖住
//   （实测：本地用坏参数试，报的是 `fetch failed`，而参数本身压根没问题）。
//
//   参数校验属于"输入"，输入该在做事之前判——跑一趟网络再告诉你参数不对，
//   与先校验再动手，在用户那边是"慢且看不懂"与"当场就懂"的差别。
const [cmd, arg] = decodeArgs(process.argv.slice(2))

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

/**
 * 解参数：`--b64` 之后每个参数都是 base64。见文件头「穿两层 shell」那段。
 *
 * 解不开就**具名退出**，不静默当成原文——把一段 base64 当消息发出去，
 * 与把一条截断的消息发出去，是同一种坏法（都不报错）。
 */
function decodeArgs(argv) {
  if (argv[0] !== '--b64') return argv
  return argv.slice(1).map((a, i) => {
    const s = Buffer.from(a, 'base64').toString('utf8')
    // base64 解出来可能是乱码（截断/非法）。中文消息一定含多字节，空串也不合法。
    if (s.length === 0) { console.error(`--b64 的第 ${i + 1} 个参数解出来是空的`); process.exit(2) }
    return s
  })
}

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

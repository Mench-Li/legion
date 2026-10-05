#!/usr/bin/env node
// product/server/verify-phone.mjs
// ============================================================================
// 「手机端会经历的那一串」——**照着 app.mjs 的顺序**，打**公网域名**。
//
// 与 `mobile-api-contract.test.mjs` 的分工：那个在临时库上验接口形状；
// 这个在**真实部署**上验同一串，于是它同时覆盖了 TLS 终止、隧道、nginx、
// 真实用户与真实空间角色。两者都要：形状对但链路不通，与链路通但字段改名，
// 是两种不同的坏法。
//
// 口令从文件读、令牌只在本进程内存里——**都不打印**。
// 用法（在服务器上）：node product/server/verify-phone.mjs [baseUrl]
// ============================================================================
import { readCredentials } from './read-credentials.mjs'

const BASE = process.argv[2] ?? 'https://legion-si.online'
// 口令来源：`LEGION_PW_FILE` 指到哪就用哪。`.json` 结尾按**纯 JSON** 解析
// （`{ user_name, password }`），其余按纯文本。
//
// ★ 用 `readCredentials` 而不是自己 `readFileSync().trim()`：
//   实测踩过——人写的「新口令：<值>」那一行在冒号后带了**两个不可见字符**，
//   按行解析把它读成了口令的一部分，表现是"口令不正确"，而人看到的是一串方块。
//   那条路径现在会被**具名拒绝**（`CREDENTIALS_UNPRINTABLE`），
//   而不是等到登录失败才发现。
const PW_FILE = process.env.LEGION_PW_FILE ?? '/etc/legion-hub/first-admin-password.txt'
const creds = readCredentials(PW_FILE)
const USER = process.env.LEGION_ADMIN_NAME ?? creds.userName ?? 'legion'
const SPACE = process.env.LEGION_SPACE ?? 'default'
const password = creds.password

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function call(method, path, { body, token } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

const pad = (s, n) => String(s).padEnd(n)

console.log(`基址：${BASE}`)
console.log('')

// ① 能力发现（登录页靠它决定显示什么）
{
  const r = await call('GET', '/api/identity/status')
  check('① 能力发现', r.status === 200 && r.json?.bootstrapped === true,
    `${r.status} bootstrapped=${r.json?.bootstrapped}`)
}

// ② 登录
let access = null
let refresh = null
{
  const r = await call('POST', '/api/identity/login', { body: { name: USER, password, label: 'phone-verify' } })
  const ok = r.status === 200 && typeof r.json?.accessToken === 'string'
  check('② 登录', ok, ok ? '（口令正确、签发了访问令牌）' : `${r.status} ${String(r.text).slice(0, 120)}`)
  if (ok) { access = r.json.accessToken; refresh = r.json.refreshToken }
}
if (access === null) { console.log('\n无法继续：登录失败'); process.exit(1) }

// ③ 我的身份（挑默认空间）
{
  const r = await call('GET', '/api/identity/me', { token: access })
  const ok = r.status === 200 && Array.isArray(r.json?.roles)
  check('③ 我的身份', ok, `${r.status} roles=${JSON.stringify(r.json?.roles ?? null)}`)
}

// ④ Agent 列表（手机上那一列）—— **曾经 401 的那一条**
{
  const r = await call('GET', `/api/agents?scope=${SPACE}`, { token: access })
  const ok = r.status === 200 && Array.isArray(r.json?.agents)
  check('④ Agent 列表', ok, `${pad(r.status, 4)} agents=${r.json?.agents?.length ?? '-'}${ok ? '' : ` ${String(r.text).slice(0, 120)}`}`)
  if (ok && r.json.agents.length > 0) globalThis.__agentId = r.json.agents[0].agentId
}

// ⑤ 空间级授权（不该读到的要 403）
{
  const r = await call('GET', '/api/agents?scope=not-my-space', { token: access })
  check('⑤ 空间级授权', r.status === 403 && r.json?.code === 'SPACE_FORBIDDEN', `${r.status} code=${r.json?.code}`)
}

// ⑥–⑧ 会话 → 发消息 → 读时间线
{
  const a = globalThis.__agentId
  if (a === undefined) {
    check('⑥ 开会话', false, '上一步没拿到 agentId')
  } else {
    const c = await call('POST', '/api/agent-conversations', { body: { agentId: a, scope: SPACE, by: 'phone-verify' }, token: access })
    const okConv = c.status === 200 && typeof c.json?.convId === 'number'
    check('⑥ 开会话', okConv, `${c.status} convId=${c.json?.convId}`)
    if (okConv) {
      const key = `verify-${Date.now()}`
      const m = await call('POST', '/api/agent-messages', {
        body: { conv: c.json.convId, scope: SPACE, by: 'phone-verify', body: '这是一条来自验收脚本的消息', intent: 'ask', clientRequestId: key },
        token: access,
      })
      check('⑦ 发消息', m.status === 200 && typeof m.json?.messageId === 'number', `${m.status} messageId=${m.json?.messageId}`)

      const again = await call('POST', '/api/agent-messages', {
        body: { conv: c.json.convId, scope: SPACE, by: 'phone-verify', body: '这是一条来自验收脚本的消息', intent: 'ask', clientRequestId: key },
        token: access,
      })
      check('⑦′ 幂等重发不产生第二条', again.json?.messageId === m.json?.messageId,
        `${again.json?.messageId} vs ${m.json?.messageId}`)

      const t = await call('GET', `/api/chat/messages?conv=${c.json.convId}&scope=${SPACE}&limit=50`, { token: access })
      const list = Array.isArray(t.json?.messages) ? t.json.messages : []
      const mine = list.find((x) => x.id === m.json?.messageId)
      check('⑧ 读时间线', mine !== undefined && typeof mine.meta === 'object',
        `${t.status} 共 ${list.length} 条；meta 是 ${typeof mine?.meta}`)
      if (mine !== undefined) {
        check('⑧′ meta.source 可判定来源', mine.meta?.source === 'user', `source=${mine.meta?.source}`)
      }
    }
  }
}

// ⑨ Agent 详情（任务页）
{
  const a = globalThis.__agentId
  const r = a === undefined ? { status: 0, json: null } : await call('GET', `/api/agent-detail?agentId=${a}&scope=${SPACE}`, { token: access })
  check('⑨ Agent 详情', r.status === 200 && Array.isArray(r.json?.agent?.tasks), `${r.status} tasks=${r.json?.agent?.tasks?.length ?? '-'}`)
}

// ⑩ 设备在线状态（顶部状态条）
{
  const r = await call('GET', '/api/devices/presence', { token: access })
  check('⑩ 设备在线状态', r.status === 200 && Array.isArray(r.json?.presence), `${r.status} presence=${r.json?.presence?.length ?? '-'}`)
}

// ⑪ SSE（进展流）
{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let first = ''
  let status = 0
  try {
    const res = await fetch(`${BASE}/api/events?scope=${SPACE}&kind=phone-verify&token=${encodeURIComponent(access)}`, { signal: controller.signal })
    status = res.status
    const reader = res.body.getReader()
    const { value } = await reader.read()
    first = Buffer.from(value ?? []).toString('utf8')
    await reader.cancel().catch(() => {})
  } catch { /* 超时即视为被缓冲 */ } finally { clearTimeout(timer) }
  check('⑪ 事件流未被缓冲', status === 200 && first.length > 0, `status=${status} 首帧=${JSON.stringify(first.slice(0, 24))}`)
}

// ⑫ 刷新凭据
{
  const r = await call('POST', '/api/identity/refresh', { body: { refreshToken: refresh } })
  check('⑫ 刷新凭据', r.status === 200 && typeof r.json?.accessToken === 'string' && r.json?.refreshToken !== refresh, `${r.status}`)
}

console.log('')
const failed = results.filter((x) => !x.ok)
console.log(failed.length === 0
  ? `✔ 手机端全流程通过（${results.length} 项）—— 手机上会经历的就是这一串`
  : `✖ ${failed.length} 项失败：${failed.map((x) => x.label).join('、')}`)
process.exit(failed.length === 0 ? 0 : 1)

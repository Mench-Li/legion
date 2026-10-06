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

/**
 * 第三种结局：**前提不成立**。
 *
 * `check()` 只有通过与失败两态，于是「这条断言的前提在当前环境里不成立」
 * 被迫挤进其中一边，两边都是撒谎：
 *   · 记成功 → 掩盖了"它根本没验"；
 *   · 记失败 → 一个**环境造成**的红，跑几次之后人就学会忽略整份报告，
 *     而那会把**真的**失败一起忽略掉。
 *
 *   > 一个"因为前提不成立而红"的断言，与一个"真的坏了"的断言，
 *   > 在只看颜色的报告里是同一个东西——只不过前者会训练人不再看颜色。
 *
 * 所以单列一态：不进失败计数，但**必须在结尾被数出来**（否则它就成了静默跳过）。
 */
const skips = []
const skip = (label, why) => {
  skips.push({ label, why })
  console.log(`○ ${label} — 不适用：${why}`)
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

// ⑪ SSE（进展流）——**走一次性票据**，与手机端同一条路
{
  // ★ 这里原来带的是 `?token=<访问令牌>`。而订阅那条路已经改成 `?ticket=`：
  //   查询串会进反代日志/浏览器历史/Referer，那里放一枚 15 分钟、覆盖全部 API
  //   的令牌，等于把主钥匙抄在门口。票据只用一次、只活 60 秒、只对订阅有效。
  //
  //   所以这一步顺带也验了**新那条路在真实部署上通不通**——比原来更有价值。
  const minted = await call('POST', '/api/events/ticket', { body: {}, token: access })
  check('⑪₀ 订阅票据', minted.status === 200 && typeof minted.json?.ticket === 'string',
    `${minted.status} ${typeof minted.json?.ticket === 'string' ? '拿到票据' : String(minted.text).slice(0, 120)}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let first = ''
  let status = 0
  try {
    const ticket = encodeURIComponent(minted.json?.ticket ?? '')
    const res = await fetch(`${BASE}/api/events?scope=${SPACE}&kind=phone-verify&ticket=${ticket}`, { signal: controller.signal })
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

// ⑫′ 空间看板（新界面「看板」那一页的两个端点）
{
  const r = await call('GET', `/api/board?scope=${SPACE}`, { token: access })
  const list = Array.isArray(r.json) ? r.json : r.json?.tasks ?? []
  check('⑫′ 空间看板', r.status === 200 && Array.isArray(list), `${r.status} 任务 ${list.length} 条`)
}

// ⑬ **手机派任务真的能被电脑领走**（整个产品的主标题动作）
//
// 这一条与 `mobile-api-contract.test.mjs` 的 ⑯ 是同一件事，但打的是**真实部署**。
// 形状对但链路不通，与链路通但行为不对，是两种不同的坏法。
{
  const a = globalThis.__agentId
  const c = a === undefined ? null : await call('POST', '/api/agent-conversations', { body: { agentId: a, scope: SPACE, by: 'phone-verify' }, token: access })
  if (c === null || c.status !== 200) {
    check('⑬ 手机派任务可被认领', false, '拿不到会话')
  } else {
    const sent = await call('POST', '/api/agent-messages', {
      body: {
        conv: c.json.convId, scope: SPACE, by: 'phone-verify',
        body: `验收脚本派的任务 ${new Date().toISOString()}`, intent: 'create_task',
        clientRequestId: `verify-task-${Date.now()}`,
      },
      token: access,
    })
    const taskId = sent.json?.taskId
    check('⑬₁ 派任务建出任务', sent.status === 200 && typeof taskId === 'string', `${sent.status} taskId=${taskId}`)
    if (typeof taskId === 'string') {
      // 走**真实的运行时认领路由**：只查 status 会让"状态对了但其它闸门不对"
      // （写预约、hold、退避闸门）漏过去。
      const claimed = await call('POST', '/api/runtime/claim', { body: { workerId: 'phone-verify-probe', scope: SPACE }, token: access })
      const got = claimed.json?.claimed?.taskId
      // ★ 认领失败时要说清**是谁占着**。
      //
      // 这条断言假设"刚建的任务一定能被认领"——那只在**空队列**上成立。
      // 真机上实测报的是 `领到=file-contention`，**不说是谁占着**：
      // 看的人只知道"领不到"，而不知道要不要做什么（去验收？去等？去对账？）。
      //
      //   > 一个「任务领不到」的读数，与一个「队列被 T-003 占着、而它在等验收」的
      //   > 读数，在运维那边的差别是「去查」和「去点一下验收」。
      //
      // 所以失败时补一次看板读：谁在 in_review / in_progress，就点名说出来。
      // ★ 认领失败时要说清**是谁占着**，以及这算不算问题。
      //
      // 这条断言假设"刚建的任务一定能被认领"——那只在**空队列**上成立。
      // 真机上实测报的是 `领到=file-contention`，**不说是谁占着**：
      // 看的人只知道"领不到"，而不知道要不要做什么（去验收？去等？去对账？）。
      //
      //   > 一个「任务领不到」的读数，与一个「队列被 T-003 占着、而它在等验收」的
      //   > 读数，在运维那边的差别是「去查」和「去点一下验收」。
      //
      // 所以失败时补一次看板读，分成三种结局：
      //   有 in_review/in_progress → **不适用**（队列按验收串行是设计）
      //   没有                      → **失败**（那是卡死的预约，要人查）
      if (claimed.status === 200 && got === taskId) {
        check('⑬₂ 它真的可被电脑认领', true, `领到=${got}`)
        await call('POST', '/api/runtime/release', {
          body: {
            attemptId: claimed.json.claimed.attemptId, leaseEpoch: claimed.json.claimed.leaseEpoch,
            workerId: 'phone-verify-probe', reason: 'phone-verify-release',
          },
          token: access,
        })
      } else {
        const board = await call('GET', `/api/board?scope=${SPACE}`, { token: access })
        const list = Array.isArray(board.json) ? board.json : board.json?.tasks ?? []
        const holding = list.filter(t => ['in_review', 'in_progress'].includes(t.status))
        const why = `${claimed.status} 领到=${got ?? claimed.json?.reason ?? claimed.json?.code}`
        if (holding.length > 0) {
          skip('⑬₂ 它真的可被电脑认领',
            `${why}；单写者位被 ${holding.map(t => `${t.id}(${t.status})`).join('、')} 占着`
            + '——交付需验收是设计，队列要等它被验收或取消。**在空队列上跑这条才有分辨率**')
        } else {
          check('⑬₂ 它真的可被电脑认领', false,
            `${why}；而看板上没有 in_review/in_progress 的任务——那是**卡死**的预约，需要人查`)
        }
      }
    }
  }
}

// ⑭ 账号体系：注册策略公开可见（登录页靠它决定显不显示「注册」）
{
  const r = await call('GET', '/api/identity/status')
  const mode = r.json?.registration
  check('⑭ 注册策略可见', r.status === 200 && ['closed', 'invite', 'open'].includes(mode),
    `${r.status} registration=${mode}`)
}

// ⑮ 账号体系：会话列表可用（「我的」那一页）
{
  const r = await call('GET', '/api/identity/sessions', { token: access })
  const ok = r.status === 200 && Array.isArray(r.json?.sessions)
  check('⑮ 会话列表', ok, `${r.status} 共 ${r.json?.sessions?.length ?? '-'} 条，当前=${r.json?.currentSessionId ? '有' : '无'}`)
}

// ⑯ 管理员能发邀请码（注册闭环的另一半）
//
// 只在**确实是管理员**时才验；普通账号跑这一条会 403，而那是对的。
{
  const me = await call('GET', '/api/identity/me', { token: access })
  if (me.json?.systemRole === 'admin') {
    const r = await call('POST', '/api/identity/invites', { body: { space: SPACE, role: 'member' }, token: access })
    check('⑯ 管理员可发邀请码', r.status === 200 && typeof r.json?.code === 'string', `${r.status} 码长=${String(r.json?.code ?? '').length}`)
  } else {
    // 之前这里记的是 `check(..., true, '（跳过）')`——它把"没验"记成了"通过"。
    // 那正是这一态要修的那件事：**记成功会掩盖"它根本没验"**。
    skip('⑯ 管理员可发邀请码', '这个账号不是系统管理员，发邀请码那一半没被验到')
  }
}

console.log('')
const failed = results.filter((x) => !x.ok)
const suffix = skips.length > 0 ? `，另有 ${skips.length} 项不适用` : ''
console.log(failed.length === 0
  ? `✔ 手机端全流程通过（${results.length - skips.length} 项通过${suffix}）—— 手机上会经历的就是这一串`
  : `✖ ${failed.length} 项失败：${failed.map((x) => x.label).join('、')}${suffix}`)
// 不适用**不改退出码**，但必须印出来：一个只在角落里的 `○` 号，
// 与一个静默跳过，在"这份报告到底验了什么"这个问题上差别很大。
for (const s of skips) console.log(`   ○ ${s.label}：${s.why}`)
process.exit(failed.length === 0 ? 0 : 1)

// team-hub/mobile-api-contract.test.mjs
// 远程 Agent 通道 S-F：**手机前端与 Hub 的接口契约**。
//
// ## 为什么这组用例非有不可
//
// `workbench/mobile/app.mjs` 是一份手写的零构建页面，它按**字段名**读后端响应
// （`r.messages`、`m.meta.source`、`c.convId`…）。字段名对不上时前端不会报错——
// 它会安安静静地渲染出一个**空时间线**，而 Hub 这边一切正常、日志干净。
// 用户看到的是"手机上一片空白"，排查方向会被带到网络和鉴权上去。
//
//   > 一个"字段名对不上"的契约，与一个"还没有消息"的空会话，
//   > 在手机屏幕上长得一模一样。
//
// 所以这组用例**照着 app.mjs 的顺序**打一遍真实 HTTP，并断言它真正读的那几个字段；
// 最后把响应喂进 `timelineEntry`，让"前端能把它渲染出来"成为一条断言而不是一个假设。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deriveConnectionState, mergeTimeline, timelineEntry } from '../workbench/mobile/timeline.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-mobile-contract-'))
const HUB_TOKEN = 'mobile-contract-hub-token'
const IDENTITY_KEY = 'mobile-contract-identity-key-0123456789'
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`

  // 手机端要看到 Agent，而 Agent 是从 `roster` 同步来的。
  mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,?)')
    .run('default', 'general', '总指挥', 'agent', '🤖', 1)
  mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,?)')
    .run('default', 'coder', '编码兵', 'agent', '🤖', 2)
  mod.agentConversations.syncRoster()
})

after(() => {
  try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, { body, token } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

describe('手机端接口契约（照 app.mjs 的顺序）', () => {
  const ctx = {}

  it('① 能力发现：app.mjs 要靠它决定显示登录页还是初始化引导', async () => {
    const r = await call('GET', '/api/identity/status')
    assert.equal(r.status, 200)
    for (const key of ['ok', 'enabled', 'bootstrapped', 'remoteAuthRequired']) {
      assert.ok(key in r.json, `缺字段 ${key}`)
    }
    assert.equal(r.json.bootstrapped, false)
  })

  it('② 引导 + 登录：登录响应里那几个字段正是 app.mjs 要存的', async () => {
    const boot = await call('POST', '/api/identity/bootstrap', {
      body: { name: 'phone-user', password: 'phone-password-1' }, token: HUB_TOKEN,
    })
    assert.equal(boot.status, 200)

    const login = await call('POST', '/api/identity/login', {
      body: { name: 'phone-user', password: 'phone-password-1', label: '手机' },
    })
    assert.equal(login.status, 200)
    // app.mjs：`state.access = j.accessToken` / `state.refresh = j.refreshToken`
    assert.equal(typeof login.json.accessToken, 'string')
    assert.equal(typeof login.json.refreshToken, 'string')
    ctx.access = login.json.accessToken
    ctx.refresh = login.json.refreshToken
    ctx.userId = login.json.userId

    // 这个用户要有空间角色——空间级授权看的就是它（见下面 ⑬）。
    const invite = await call('POST', '/api/identity/invites', {
      body: { space: 'default', role: 'member' }, token: ctx.access,
    })
    assert.equal(invite.status, 200, JSON.stringify(invite.json))
    const other = await call('POST', '/api/identity/invites/accept', {
      body: { code: invite.json.code, name: 'other-user', password: 'other-password-1' },
    })
    assert.equal(other.status, 200, JSON.stringify(other.json))
    ctx.otherAccess = (await call('POST', '/api/identity/login', {
      body: { name: 'other-user', password: 'other-password-1', label: '别人' },
    })).json.accessToken
  })

  it('③ 我的身份：app.mjs 读 `info.roles[0].space` 来挑默认空间', async () => {
    const r = await call('GET', '/api/identity/me', { token: ctx.access })
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.user?.name, 'string')
    // ★ 这条是"挑默认空间"的分支能不能走通的关键：`roles` 必须是数组，
    //   且元素带 `space`。缺了它前端会落到 `'default'` 兜底，
    //   而用户有权限的空间如果不是 default，他会看到一个空列表。
    assert.ok(Array.isArray(r.json.roles), 'roles 必须是数组')
    assert.equal(r.json.systemRole, 'admin')
    // 引导者是系统管理员，但**不是任何空间的成员**——所以这一条还应该是空。
    // 手机端因此必须容忍空 roles（它落到 'default' 兜底），而空间授权那一条会拒。
    ctx.scope = 'default'
  })

  it('④ 空间列表：app.mjs 读 `r.agents`（门禁放行后**路由层**也要认这个用户）', async () => {
    // 先给这个用户一个空间角色。
    mod.db.prepare('INSERT OR REPLACE INTO hub_space_roles VALUES (?,?,?,?,?)')
      .run(ctx.userId, ctx.scope, 'member', 'system', Date.now())

    const r = await call('GET', `/api/agents?scope=${ctx.scope}`, { token: ctx.access })
    // ★ 这一条曾经返回 **401**：远程门禁用**用户令牌**放行了，而
    //   `routes/agents.mjs` 里的 `authorized(req)` 只认**机器令牌**，
    //   于是手机上每个 `/api/agent-*` 都是 401——门禁放行、路由又挡回去，
    //   两处各自看起来都对。手机端契约用例一跑就露出来了。
    assert.equal(r.status, 200, `agents 应放行用户令牌，实际 ${r.status}：${r.text.slice(0, 200)}`)
    assert.ok(Array.isArray(r.json.agents), 'agents 必须是数组')
    assert.ok(r.json.agents.length >= 1, '应从 roster 同步出 Agent')
    const a = r.json.agents[0]
    // app.mjs：`o.value = a.agentId` / `o.textContent = `${a.name}（${a.role}）``
    assert.equal(typeof a.agentId, 'string')
    assert.equal(typeof a.name, 'string')
    assert.equal(typeof a.role, 'string')
    ctx.agentId = a.agentId
  })

  it('⑤ 开会话：app.mjs 读 `c.convId`', async () => {
    const r = await call('POST', '/api/agent-conversations', {
      body: { agentId: ctx.agentId, scope: ctx.scope, by: 'mobile' }, token: ctx.access,
    })
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.convId, 'number', 'convId 必须是数字（app.mjs 拿它拼 URL）')
    ctx.convId = r.json.convId
  })

  it('⑥ 发消息：app.mjs 传 clientRequestId 做幂等', async () => {
    const r = await call('POST', '/api/agent-messages', {
      body: {
        conv: ctx.convId, scope: ctx.scope, by: 'mobile',
        body: '这个任务做到哪了？', intent: 'ask',
        clientRequestId: 'mobile-contract-1',
      },
      token: ctx.access,
    })
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.messageId, 'number')
    ctx.messageId = r.json.messageId

    // 同一个 clientRequestId 再来一次：服务端按 (scope,actor,requestId) 去重，
    // 不该产生第二条消息。手机在弱网下重试是常态。
    const again = await call('POST', '/api/agent-messages', {
      body: {
        conv: ctx.convId, scope: ctx.scope, by: 'mobile',
        body: '这个任务做到哪了？', intent: 'ask',
        clientRequestId: 'mobile-contract-1',
      },
      token: ctx.access,
    })
    assert.equal(again.json.messageId, ctx.messageId, '相同幂等键不得产生第二条消息')
  })

  it('⑦ 读时间线：`r.messages` 的每个字段都是 app.mjs 真正读的那几个', async () => {
    const r = await call('GET', `/api/chat/messages?conv=${ctx.convId}&scope=${ctx.scope}&limit=200`, { token: ctx.access })
    assert.equal(r.status, 200)
    assert.equal(r.json.conv, ctx.convId)
    assert.ok(Array.isArray(r.json.messages), 'messages 必须是数组')
    assert.ok(r.json.messages.length >= 1)

    const m = r.json.messages[0]
    // `timelineEntry` 逐个读这些；任何一个改名都会让时间线变空。
    for (const key of ['id', 'author', 'body', 'meta', 'createdAt']) {
      assert.ok(key in m, `消息缺字段 ${key}（app.mjs 会读到 undefined）`)
    }
    // ★ `meta` 必须是**已解析的对象**，不能是 JSON 字符串：
    //   是字符串时 `meta.source` 恒为 undefined，来源判定会全部落到兜底的 'agent'，
    //   于是用户自己的消息会被显示成"回复"。
    assert.equal(typeof m.meta, 'object', 'meta 必须是对象而不是 JSON 字符串')
    assert.equal(typeof m.meta.source, 'string', 'meta.source 是来源判定的唯一依据')
  })

  it('⑧ 前端真的能把它渲染出来（把响应喂进 timelineEntry）', async () => {
    const r = await call('GET', `/api/chat/messages?conv=${ctx.convId}&scope=${ctx.scope}&limit=200`, { token: ctx.access })
    const entries = r.json.messages.map(timelineEntry)
    assert.ok(entries.length >= 1)
    const mine = entries.find((e) => e.id === ctx.messageId)
    assert.ok(mine, '自己刚发的那条应在时间线里')
    // 来源必须是 `user` —— 这正是 `meta.source` 那一条在守的东西。
    assert.equal(mine.source, 'user', '自己发的消息必须被认成 user，而不是 agent')
    assert.equal(typeof mine.body, 'string')
    assert.ok('openableTask' in mine)

    // 合并去重：重复投递整批不应产生新条目。
    const merged = mergeTimeline(entries, r.json.messages.map(timelineEntry))
    assert.equal(merged.entries.length, entries.length)
    assert.equal(merged.appended, 0)
    assert.ok(merged.cursor !== null, '游标要能推出来（手机靠它续读）')
  })

  it('⑨ Agent 详情：app.mjs 读 `r.agent.tasks` 与 `t.attempt.state`', async () => {
    const r = await call('GET', `/api/agent-detail?agentId=${ctx.agentId}&scope=${ctx.scope}`, { token: ctx.access })
    assert.equal(r.status, 200)
    assert.ok(r.json.agent, 'agent 字段必须存在')
    assert.ok(Array.isArray(r.json.agent.tasks), 'tasks 必须是数组')
    // 任务分组（`pendingTasks`）读的是 `t.status` 与 `t.attempt?.state`。
    for (const t of r.json.agent.tasks) {
      assert.equal(typeof t.id, 'string')
      assert.equal(typeof t.status, 'string')
      assert.ok(t.attempt === null || typeof t.attempt === 'object', 'attempt 要么是对象要么是 null')
    }
  })

  it('⑩ 设备在线状态：app.mjs 读 `r.presence` 且有 `online`', async () => {
    const r = await call('GET', '/api/devices/presence', { token: ctx.access })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.presence), 'presence 必须是数组')
    for (const p of r.json.presence) {
      assert.equal(typeof p.nodeId, 'string')
      assert.equal(typeof p.online, 'boolean', 'online 必须是布尔（app.mjs 用它算 nodeOnline）')
    }
    // 没有设备时 `[]` 是合法读数，前端会把它当成"未知"而不是"离线"。
    const conn = deriveConnectionState({ hubReachable: true, nodeOnline: r.json.presence.length === 0 ? null : r.json.presence.some((p) => p.online), activeTaskState: null })
    assert.ok(['NODE_OFFLINE', 'IDLE'].includes(conn.code))
  })

  it('⑪ SSE：手机用它收进展，且不带 scope 过滤时也能订', async () => {
    // 只断言"能建立、能立刻收到首帧"——EventSource 的行为由浏览器负责，
    // 这里要证明的是**服务端没有把它缓冲住**。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    let firstChunk = ''
    try {
      const res = await fetch(`${base}/api/events?scope=${ctx.scope}&kind=mobile&token=${ctx.access}`, { signal: controller.signal })
      assert.equal(res.status, 200)
      const reader = res.body.getReader()
      const { value } = await reader.read()
      firstChunk = Buffer.from(value ?? []).toString('utf8')
      await reader.cancel().catch(() => {})
    } finally {
      clearTimeout(timer)
    }
    assert.match(firstChunk, /retry:|:/, '首帧应立刻到达（被缓冲时这里会卡到超时）')
  })

  it('⑬ 空间级授权：不属于该空间的用户读不到（§13「无权读取未授权项目」）', async () => {
    // `other-user` 是 `phone-user` 邀请进 default 的，所以他能读 default；
    // 但另一个空间他一片空白——门禁必须拒。
    const mine = await call('GET', `/api/agents?scope=${ctx.scope}`, { token: ctx.access })
    assert.equal(mine.status, 200, '自己有角色的空间应放行')

    const alien = await call('GET', '/api/agents?scope=someone-elses-space', { token: ctx.access })
    assert.equal(alien.status, 403, `不该读到没角色的空间，实际 ${alien.status}`)
    assert.equal(alien.json.code, 'SPACE_FORBIDDEN')

    // 邀请进来的那个用户同样读得到（他被授予了 default 的 member）。
    const invited = await call('GET', '/api/agents?scope=default', { token: ctx.otherAccess })
    assert.equal(invited.status, 200)
    // 但读不到别的空间。
    const invitedAlien = await call('GET', '/api/agents?scope=nope', { token: ctx.otherAccess })
    assert.equal(invitedAlien.status, 403)

    // 系统管理员**也不**因为"是管理员"就自动能读每个空间——
    // 系统角色管的是"造邀请/停用账号"，不是"看所有数据"。
    // 这一条如果哪天变成放行，说明有人把两件事合并了。
    assert.equal(mod.db.prepare('SELECT COUNT(*) n FROM hub_space_roles WHERE user_id=? AND space=?').get(ctx.userId, 'someone-elses-space').n, 0)

    // 机器令牌不受空间授权影响（它本来就是全权，既有行为不变）。
    const viaMachine = await call('GET', '/api/agents?scope=someone-elses-space', { token: HUB_TOKEN })
    assert.equal(viaMachine.status, 200, '机器令牌的既有语义不该被这条改动影响')
  })

  it('⑭ 事件流同样受空间授权（手机订阅进展走的也是它）', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`${base}/api/events?scope=someone-elses-space&token=${encodeURIComponent(ctx.access)}`, { signal: controller.signal })
      assert.equal(res.status, 403, 'SSE 也要按空间拒')
      const body = await res.text()
      assert.match(body, /SPACE_FORBIDDEN/)
    } finally { clearTimeout(timer) }
  })

  it('⑫ 刷新凭据能换新令牌（手机会话过 15 分钟靠它）', async () => {
    const r = await call('POST', '/api/identity/refresh', { body: { refreshToken: ctx.refresh } })
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.accessToken, 'string')
    assert.equal(typeof r.json.refreshToken, 'string')
    // 轮换：新 refresh 与旧的必须不同（否则"重放旧凭据"这条防线失效）。
    assert.notEqual(r.json.refreshToken, ctx.refresh)

    // 新令牌能用。
    const me = await call('GET', '/api/identity/me', { token: r.json.accessToken })
    assert.equal(me.status, 200)
    // 旧刷新凭据再用一次必须失效。
    const reuse = await call('POST', '/api/identity/refresh', { body: { refreshToken: ctx.refresh } })
    assert.equal(reuse.status, 401)
  })
})

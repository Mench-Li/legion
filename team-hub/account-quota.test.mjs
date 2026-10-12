// team-hub/account-quota.test.mjs
// ============================================================================
// 按**账号**的用量配额（HTTP 端到端）。
//
// 纯决策的边界由 `rate-limit.test.mjs` 钉住；这一族问的是**接线**：
//
//   > 一个"算得对但没接上"的配额，与一个完全不限量的端点，
//   > 在库被灌满之前是同一个东西。
//
// 这里刻意打**真 HTTP**（真用户令牌、真 SQLite、真路由表），并只从状态码、
// 响应头与库里读结论。
//
// ## 这一族最要紧的两条（其余都是它们的展开）
//
//   ① **按账号隔离** —— 一个账号打满不该影响别人。
//   ② **只管人，不管 Agent** —— Agent 自己的汇报走内部写入，
//      不经过用户身份那一层。把 Agent 也算进去会在它最忙的时候把用户锁住，
//      而那正是用户最需要看到进展的时候。
//
// 上限压到 3：够验"过了线就拒"，又不用在用例里循环几百次。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-quota-'))
const HUB_TOKEN = 'quota-hub-machine-token'
const IDENTITY_KEY = 'quota-identity-key-0123456789'
/** ★ 每个账号每小时只能建 3 条消息。 */
const MAX = 3
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  process.env.LEGION_REGISTRATION = 'invite'
  process.env.LEGION_QUOTA_MESSAGES_PER_HOUR = String(MAX)
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`

  // 手机上要看到 Agent，而 Agent 从 `roster` 同步来。
  mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,?)')
    .run('default', 'general', '总指挥', 'agent', '🤖', 1)
  mod.agentConversations.syncRoster()
})

after(() => {
  try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
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
  return { status: res.status, json, text, retryAfter: res.headers.get('retry-after') }
}
const post = (p, b, o) => call('POST', p, { body: b, ...o })
const get = (p, o) => call('GET', p, o)

const ctx = {}

describe('按账号的用量配额（HTTP 端到端）', () => {
  it('① 准备：两个账号 + 各自的会话', async () => {
    const boot = await post('/api/identity/bootstrap', { name: 'owner', password: 'owner-password-1' }, { token: HUB_TOKEN })
    assert.equal(boot.status, 200, boot.text.slice(0, 200))
    const login = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1', label: '测试' })
    assert.equal(login.status, 200)
    ctx.a = login.json.accessToken
    ctx.aId = login.json.userId

    // 第二个账号：邀请 → 接受 → 登录。用来验"配额按账号隔离"。
    const invite = await post('/api/identity/invites', { space: 'default', role: 'member' }, { token: ctx.a })
    assert.equal(invite.status, 200, invite.text.slice(0, 200))
    const other = await post('/api/identity/invites/accept', {
      code: invite.json.code, name: 'other-user', password: 'other-password-1',
    })
    assert.equal(other.status, 200, other.text.slice(0, 200))
    const login2 = await post('/api/identity/login', { name: 'other-user', password: 'other-password-1', label: '测试2' })
    assert.equal(login2.status, 200)
    ctx.b = login2.json.accessToken
    ctx.bId = login2.json.userId
    assert.notEqual(ctx.aId, ctx.bId, '两个令牌必须属于不同账号')

    // 两个账号都要有空间角色，否则 `/api/agent-messages` 那条会被空间授权先挡掉。
    for (const id of [ctx.aId, ctx.bId]) {
      mod.db.prepare('INSERT OR REPLACE INTO hub_space_roles VALUES (?,?,?,?,?)')
        .run(id, 'default', 'member', 'system', Date.now())
    }

    // 各自的会话（两条路径都要一个 conv）。
    const agents = await get('/api/agents?scope=default', { token: ctx.a })
    assert.equal(agents.status, 200, agents.text.slice(0, 200))
    ctx.agentId = agents.json.agents[0].agentId
    for (const key of ['a', 'b']) {
      const c = await post('/api/agent-conversations', { agentId: ctx.agentId, scope: 'default', by: 'quota-' + key }, { token: ctx[key] })
      assert.equal(c.status, 200, c.text.slice(0, 200))
      ctx['conv_' + key] = c.json.convId
    }
    // `/api/chat/messages` 那条需要一个普通聊天会话。
    // ⚠️ `createConversation` 要 `by` 与 `title` 两个必填项，且返回的是**会话对象**
    //    （`.id`），不是 `{convId}` —— `/api/agent-conversations` 那条返回的是 `convId`。
    //    两个入口的字段名不一样，我在这里踩过一次（拿到 `undefined` 之后
    //    错误表现为后面的用例"缺少参数 conv"）。
    const chatConv = mod.createConversation({ scope: 'default', title: '配额用例', by: 'quota-setup' })
    assert.equal(typeof chatConv?.id, 'number', 'createConversation 应当返回带数字 id 的会话对象')
    ctx.chatConv = chatConv.id
  })

  it('★★★ 打满之后 `/api/agent-messages` 返回 429，带 `Retry-After` 与具名错误码', async () => {
    for (let i = 0; i < MAX; i += 1) {
      const r = await post('/api/agent-messages', {
        conv: ctx.conv_a, scope: 'default', by: 'quota-a', body: 'msg-' + i, intent: 'ask',
        clientRequestId: `quota-a-${i}`,
      }, { token: ctx.a })
      assert.equal(r.status, 200, `第 ${i + 1} 条应当通过（上限 ${MAX}）：${r.text.slice(0, 200)}`)
    }
    const over = await post('/api/agent-messages', {
      conv: ctx.conv_a, scope: 'default', by: 'quota-a', body: 'one-too-many', intent: 'ask',
      clientRequestId: 'quota-a-over',
    }, { token: ctx.a })
    assert.equal(over.status, 429, over.text.slice(0, 200))
    assert.equal(over.json.code, 'ACCOUNT_QUOTA_EXCEEDED', '要用**配额**那个码，不是限速那个')
    assert.notEqual(over.retryAfter, null, '必须带 Retry-After 头')
    assert.ok(Number(over.retryAfter) >= 1, `Retry-After 至少 1 秒，实际 ${over.retryAfter}`)
    assert.ok(Number.isFinite(over.json.retryAfterSec), '响应体里也要有秒数（有的客户端只读 body）')
    // 消息必须说清是**账号自己的容量上限**。
    assert.match(over.json.error, /上限/)
    assert.match(over.json.error, /容量保护/)
    assert.equal(over.json.error.includes('换一个网络'), false,
      '配额消息**不许**建议换网络 —— 换网络对账号配额无效，那是一句谎话')
  })

  it('★★★ 被拒的那条**没有**落库（不是"先写后拒"）', async () => {
    const n = mod.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'one-too-many'").get().n
    assert.equal(n, 0, '被配额拒掉的消息不许留在库里')
  })

  it('★★★ 按账号隔离：A 打满不影响 B', async () => {
    const r = await post('/api/agent-messages', {
      conv: ctx.conv_b, scope: 'default', by: 'quota-b', body: 'b-msg', intent: 'ask',
      clientRequestId: 'quota-b-1',
    }, { token: ctx.b })
    assert.equal(r.status, 200, `另一个账号不该被连坐：${r.text.slice(0, 200)}`)
  })

  it('★★★ 第二条路径 `/api/chat/messages` 也受同一个配额管', async () => {
    // ★ 这条是"两条路径都要接"的存在理由：只接一条的实现，
    //   攻击者换一条路径就绕过去了，而两条路径在代码里隔得很远。
    const r = await post('/api/chat/messages', {
      conv: ctx.chatConv, scope: 'default', by: 'quota-a', body: 'via-chat-route',
    }, { token: ctx.a })
    assert.equal(r.status, 429, `A 已经打满，走聊天那条路径也必须被拒：${r.text.slice(0, 200)}`)
    assert.equal(r.json.code, 'ACCOUNT_QUOTA_EXCEEDED')
    assert.notEqual(r.retryAfter, null, '这条路径也要带 Retry-After')
    assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'via-chat-route'").get().n, 0,
      '被拒的消息不许落库（说明配额在写之前，不是写之后）')
  })

  it('★★★ 两条路径**共用**同一份计数（不是各记一份）', async () => {
    // B 现在用了 1 条（上限 3）。再用**聊天路径**发 2 条应当刚好用满，
    // 第 4 条（任一路径）必须被拒 —— 若两条路径各自计数，这里就还能再发 3 条。
    const r1 = await post('/api/chat/messages', { conv: ctx.chatConv, scope: 'default', by: 'quota-b', body: 'b-2' }, { token: ctx.b })
    assert.equal(r1.status, 200, r1.text.slice(0, 200))
    const r2 = await post('/api/chat/messages', { conv: ctx.chatConv, scope: 'default', by: 'quota-b', body: 'b-3' }, { token: ctx.b })
    assert.equal(r2.status, 200, r2.text.slice(0, 200))
    const r3 = await post('/api/agent-messages', {
      conv: ctx.conv_b, scope: 'default', by: 'quota-b', body: 'b-4', intent: 'ask', clientRequestId: 'quota-b-4',
    }, { token: ctx.b })
    assert.equal(r3.status, 429,
      'B 已经用了 3 条（1 条 agent + 2 条 chat），第 4 条必须被拒 —— '
      + '两条路径若各记一份，这里就还能继续发，而配额等于翻倍')
  })

  it('★★★ 机器令牌（守护的身份）**不**受配额限制', async () => {
    // ★ 这是本族最重要的一条。守护用的是机器令牌，它没有 `req.__legionUser`，
    //   所以这一层对它不适用。把 Agent 也算进用户配额，会在 Agent 干活最忙的
    //   时候把用户锁住 —— 而那正是他最需要看到进展的时候。
    //
    //   这里用机器令牌连发 5 条（> 上限 3），必须条条通过。
    for (let i = 0; i < MAX + 2; i += 1) {
      const r = await post('/api/agent-messages', {
        conv: ctx.conv_a, scope: 'default', by: 'machine', body: 'machine-' + i, intent: 'ask',
        clientRequestId: `machine-${i}`,
      }, { token: HUB_TOKEN })
      assert.equal(r.status, 200,
        `机器令牌（守护）不该被按账号配额挡住，第 ${i + 1} 条得到 ${r.status}：${r.text.slice(0, 200)}`)
    }
  })

  it('★★★ 进程内的写入（Agent 汇报那条路）也不受配额限制', async () => {
    // 守护的汇报是**进程内**调用 `insertMessage`，根本不经过 HTTP 路由。
    // 这条证明"配额在路由层"这个设计选择是有效的：DAO 那一层没有配额，
    // 所以任何内部写入都不会被用户配额连坐。
    const before = mod.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    mod.postMessage({ conv: ctx.chatConv, body: '内部写入', by: 'internal-agent' })
    const after = mod.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    assert.equal(after, before + 1, '进程内写入应当照常落库（DAO 层没有配额）')
  })

  it('★★★ 被拒的尝试**不记入流水**（否则窗口无限延长，永远解不开）', async () => {
    // ★ 破坏性验证抓出来的洞：把 `if (decision.allowed) noteRate(...)` 改成
    //   "无论允许与否都记"，**10 条判据全绿** —— 因为没有任何一条问过
    //   "被拒之后窗口里多了几行"。
    //
    //   那个 bug 的症状很特别：用户被拒之后**反复重试**（人的自然反应），
    //   每试一次窗口就往后推一次，于是他永远等不到配额恢复 ——
    //   而界面每次都说"请约 X 分钟后继续"，X 还一直是满的。
    //
    //   > 一个"被拒也记账"的配额，会把用户的每一次重试变成一次自我加刑。
    const rowsFor = (userId) => mod.db.prepare(
      "SELECT COUNT(*) AS n FROM hub_rate_events WHERE bucket='quota:message' AND key=?",
    ).get('user:' + userId).n

    // A 此时已经打满（前面的用例）。记下现在的行数，然后**再被拒几次**。
    const before = rowsFor(ctx.aId)
    assert.equal(before, MAX, `A 的流水应当恰好是 ${MAX} 行（每次被**允许**的写入一行），实际 ${before}`)
    for (let i = 0; i < 4; i += 1) {
      const r = await post('/api/agent-messages', {
        conv: ctx.conv_a, scope: 'default', by: 'quota-a', body: 'retry-' + i, intent: 'ask',
        clientRequestId: `quota-a-retry-${i}`,
      }, { token: ctx.a })
      assert.equal(r.status, 429, `第 ${i + 1} 次重试必须仍被拒（实际 ${r.status}）`)
    }
    assert.equal(rowsFor(ctx.aId), before,
      '被拒的尝试**不许**写入流水 —— 否则每一次重试都把窗口往后推，用户永远等不到恢复')
  })

  it('★★★ 窗口外的旧流水不计入（否则配额永不恢复）', async () => {
    // ★ 第二个洞：把窗口过滤（`at_ms > ?`）去掉，**10 条判据也全绿** ——
    //   因为一个用例跑完的时间远小于窗口，过滤与不过滤结果一样。
    //   而那正是它危险的地方：**只有在配额该恢复的时候才看得出来**，
    //   也就是在生产上跑了半小时之后，而不是在测试里。
    const victim = ctx.bId
    const before = mod.db.prepare(
      "SELECT COUNT(*) AS n FROM hub_rate_events WHERE bucket='quota:message' AND key=?",
    ).get('user:' + victim).n

    // 把 B 现有的流水全部推到**窗口外**（一小时零一秒之前）。
    mod.db.prepare("UPDATE hub_rate_events SET at_ms = ? WHERE bucket='quota:message' AND key=?")
      .run(Date.now() - (60 * 60 * 1000) - 1000, 'user:' + victim)

    // 于是 B 的配额应当已经恢复 —— 尽管那些行还在表里。
    const r = await post('/api/chat/messages', {
      conv: ctx.chatConv, scope: 'default', by: 'quota-b', body: 'after-window',
    }, { token: ctx.b })
    assert.equal(r.status, 200,
      `窗口外的流水不该计入：B 明明已经用满过（${before} 行），但那是一小时前的事了。实际 ${r.status}：${r.text.slice(0, 200)}`)
    assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'after-window'").get().n, 1,
      '恢复之后那条应当真的落库了')
  })

  it('★★ 诊断端点如实报出配额上限（运维要能读到"到底配了多少"）', async () => {
    const r = await get('/api/identity/rate-limits', { token: HUB_TOKEN })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    const q = r.json.rateLimit?.quotas
    assert.ok(q !== undefined, '诊断里必须能读到配额，否则"以为配了"没人能拆穿')
    assert.equal(q.message, MAX, `消息配额应当报成 ${MAX}`)
    assert.ok(Number.isFinite(r.json.rateLimit.quotaWindowSec) && r.json.rateLimit.quotaWindowSec > 0,
      '窗口也要报出来 —— 只说上限不说窗口，运维算不出速率')
  })

  it('★★ 配额与来源限速是**两套**读数（别混成一件）', async () => {
    const r = await get('/api/identity/rate-limits', { token: HUB_TOKEN })
    const rl = r.json.rateLimit
    // 来源限速那一组键仍然在（它问的是"这个来源试了多少次"）。
    assert.ok(rl.max !== undefined && rl.max.login !== undefined, '来源限速的上限仍在')
    // 而配额是另一组键（它问的是"这个账号建了多少资源"）。
    assert.ok(rl.quotas !== undefined && rl.quotas.message !== undefined, '配额是独立的一组')
    assert.notEqual(rl.max.message, rl.quotas.message, '两组必须各自独立，不能是同一个字段')
  })
})

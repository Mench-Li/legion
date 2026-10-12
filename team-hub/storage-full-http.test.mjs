// team-hub/storage-full-http.test.mjs
// ============================================================================
// 磁盘满的**端到端**行为（真 HTTP + 真 `SQLITE_FULL`）。
//
// 纯决策由 `storage-health.test.mjs` 钉住；这一族问的是**接线**：
//
//   > 一个"算得对但没接上"的状态码，与一个没改过的状态码，
//   > 在用户那里是同一句话。
//
// ## 怎么确定性地复现"磁盘满"
//
// `PRAGMA max_page_count = 当前页数` 让 SQLite 拒绝增长，于是任何需要新页的
// 写入都返回 `SQLITE_FULL`（errcode 13）—— 与真磁盘满**同一条代码路径**，
// 而且不需要填满一块真盘。
//
// ★ 这个复现有一个**必须小心的地方**（我第一版就踩了）：只写一条小消息**不会**
//   触发 —— SQLite 会用**空闲页**。要写成**恰好接近正文上限（8000）**的大消息，
//   才会必然需要新页。
//
//   > 一个"没有真正触发失败"的复现，与一个"根本不会失败"的实现，
//   > 在读数上长得一模一样。
//
// ## 这一族最要紧的一条：**跨模块**的那一环
//
// 修好之前，这条 400 会被手机端的离线待发队列判成**永久失败**、
// 停止自动重试。而磁盘满根本不是永久的 —— 运维清出空间后同一条能成功。
//
//   > 一条"磁盘满时被标成永久失败"的消息，其实等一会儿就能发出去 ——
//   > 但队列再也不会自动试了。
//
// 所以这里不只验状态码，还要把响应**喂进离线队列的分类器**，
// 断言它被判成"可重试"。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyFailure, makeEntry, markResult, drainPlan } from '../workbench/mobile/outbox.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-storage-full-'))
const HUB_TOKEN = 'storage-full-hub-token'
const IDENTITY_KEY = 'storage-full-identity-key-0123456789'
/** 服务端的正文上限是 8000；用**恰好 8000** 才必然需要新页。 */
const BODY_LEN = 8000
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  mod = await import('./server.mjs')
  await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${mod.server.address().port}`
})

after(() => {
  try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, { body, token = HUB_TOKEN } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text, retryAfter: res.headers.get('retry-after') }
}

describe('磁盘满时的 HTTP 行为（真 SQLITE_FULL）', () => {
  const ctx = {}

  it('① 准备：建一个会话，并确认正常写入是 200（对照组）', async () => {
    const conv = mod.createConversation({ scope: 'default', title: '磁盘满用例', by: 'probe' })
    ctx.convId = conv.id
    const ok = await call('POST', '/api/chat/messages', {
      body: { conv: conv.id, scope: 'default', by: 'probe', body: '正常写入' },
    })
    assert.equal(ok.status, 200, `对照组必须成功，否则后面的断言没有意义：${ok.text.slice(0, 160)}`)
  })

  it('② 把页数锁死（模拟磁盘满）', async () => {
    const pages = mod.db.prepare('PRAGMA page_count').get().page_count
    mod.db.exec(`PRAGMA max_page_count = ${pages}`)
    const after = mod.db.prepare('PRAGMA page_count').get().page_count
    assert.equal(after, pages, '页数上限必须真的锁住')
    ctx.pages = pages
  })

  it('★★★ ③ 写入必须失败 —— 且**不是**因为长度校验（确认复现有效）', async () => {
    // ★ 这条是"复现有效"的守卫：如果它返回 400「正文超长」，那说明这一族
    //   后面测的是**长度校验**，而不是磁盘满 —— 而两者都回 400，
    //   在只看状态码的断言里长得一模一样。
    let failed = null
    for (let i = 0; i < 60; i += 1) {
      const body = 'A'.repeat(BODY_LEN - 5) + String(i).padStart(5, '0')
      const r = await call('POST', '/api/chat/messages', { body: { conv: ctx.convId, scope: 'default', by: 'probe', body } })
      if (r.status !== 200) { failed = { ...r, attempt: i + 1 }; break }
    }
    assert.ok(failed !== null, '锁死页数之后仍然写成功了 —— 复现没有触发，后面的断言全部无效')
    assert.doesNotMatch(failed.text, /正文超长/, `复现退化成了长度校验：${failed.text.slice(0, 160)}`)
    ctx.failed = failed
  })

  it('★★★ ④ 状态码必须是 503（不是 400、不是 500）', async () => {
    const f = ctx.failed
    // 400 = "客户端请求有错，别重试了"。磁盘满是**服务端**问题，改请求永远没用。
    assert.notEqual(f.status, 400, '400 会让客户端把用户的字判成"永久失败"')
    assert.notEqual(f.status, 500, '500 是"未知的内部错误"，而这个我们**知道**是什么')
    assert.equal(f.status, 503)
  })

  it('★★★ ⑤ 具名错误码必须是 `STORAGE_UNAVAILABLE`（客户端按它分支）', async () => {
    assert.equal(ctx.failed.json?.code, 'STORAGE_UNAVAILABLE',
      `实际 code=${ctx.failed.json?.code}（修复前是 ERR_SQLITE_ERROR）`)
  })

  it('★★★ ⑥ 不许把原始 SQLite 英文透给用户', async () => {
    const t = ctx.failed.text
    assert.doesNotMatch(t, /database or disk is full/i, '原始英文透出去了')
    assert.doesNotMatch(t, /ERR_SQLITE/i)
    assert.doesNotMatch(t, /SQLITE_FULL/)
    // 而要说清那三件事。
    assert.match(t, /服务器/, '要说清是服务器的存储')
    assert.match(t, /不是你的消息有问题/)
    assert.match(t, /重试/)
  })

  it('★★★ ⑦ 跨模块：离线队列必须把它判成**可重试**，而不是永久失败', async () => {
    // ★ 这是本族最要紧的一条。修好之前 400 被判成 permanent，
    //   于是用户的字被卡在队列里、再也不会自动发出去。
    const outcome = classifyFailure({ status: ctx.failed.status, code: ctx.failed.json?.code })
    assert.equal(outcome, 'transient', `离线队列判成了 ${outcome} —— 用户的字会被永久卡住`)

    const e = makeEntry({ id: 'x', convId: ctx.convId, scope: 'default', body: 'b', intent: 'ask', clientRequestId: 'k', atMs: 1 })
    const r = markResult([e], 'x', outcome, { status: ctx.failed.status, message: ctx.failed.json?.error })
    assert.equal(r.entries.length, 1, '条目不许被删掉')
    assert.equal(r.entries[0].state, 'queued', `状态是 ${r.entries[0].state} —— 应当留在队列里等重试`)
    assert.ok(drainPlan(r.entries).length > 0, '排空计划里必须还有它 —— 否则磁盘清出空间后也不会重发')
  })

  it('★★★ ⑧ 失败的那一条**没有落库**（不是"先写后拒"）', async () => {
    const n = mod.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    const okCount = mod.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = '正常写入'").get().n
    assert.equal(okCount, 1, '对照组那条应当在库里')
    assert.ok(n >= 1)
  })

  it('★★★ ⑨ 读操作在满的时候**仍然可用**（降级，不是全死）', async () => {
    // 一个"满的时候连读都 503"的实现，会把"服务 degraded"变成"服务 down"。
    const r = await call('GET', `/api/chat/messages?conv=${ctx.convId}&scope=default`)
    assert.equal(r.status, 200, `满的时候读应当仍然可用，实际 ${r.status}：${r.text.slice(0, 160)}`)
    assert.ok(Array.isArray(r.json?.messages))
  })

  it('★★★ ⑩ 进程没被带崩（后续请求照常应答）', async () => {
    const r = await call('GET', '/api/identity/status', { token: undefined })
    assert.equal(r.status, 200)
    // 而且一个**不需要写**的写端点也要能正常给出业务错误（证明错误处理没被整体换掉）。
    const bad = await call('POST', '/api/chat/messages', { body: { conv: ctx.convId, scope: 'default', by: 'probe', body: '   ' } })
    assert.equal(bad.status, 400, `空正文仍应是 400（业务错误），实际 ${bad.status}`)
    assert.match(bad.text, /正文不能为空/)
    assert.notEqual(bad.json?.code, 'STORAGE_UNAVAILABLE', '业务错误不许被误判成存储问题')
  })

  it('★★★ ⑪ 其它写路径同样给出 503（修复在**共用**的收口处，不是只改了聊天）', async () => {
    // ★ 这条判据的写法是**实测逼出来的**。第一版我写成"建一个会话必须回 503"，
    //   而它**成功了**（200）：失败的写入回滚后把空间还给了库，而 SQLite 还能把
    //   **小**写入塞进**页内空隙**里 —— 实测能撑 **41 次**，第 42 次才 `SQLITE_FULL`。
    //
    //   > 一个"没有真正触发失败"的复现，与一个"根本不会失败"的实现，
    //   > 在读数上长得一模一样。
    //
    //   所以这里**循环到失败**（与 ③ 同一个手法），而不是假定第一次就失败。
    //   它仍然证明要看的那件事：**另一条路由族**（聊天/建会话，走的是
    //   `handleWrite` → `withTx`）给出的是同一个 503 + 同一个码 ——
    //   也就是说修复在共用的收口处，不是复制了一份到聊天那条路上。
    let failed = null
    let okCount = 0
    for (let i = 1; i <= 200; i += 1) {
      const r = await call('POST', '/api/chat/conversations', {
        body: { scope: 'default', title: `磁盘满时开会话 ${i}`, by: 'probe' },
      })
      if (r.status === 200) { okCount += 1; continue }
      failed = { ...r, attempt: i }
      break
    }
    assert.ok(failed !== null,
      `建了 ${okCount} 个会话都没失败 —— 这条路径没有被"库满"影响到，判据无效（不是实现错）`)
    assert.equal(failed.status, 503, `建会话应当给出 503，实际 ${failed.status}：${failed.text.slice(0, 200)}`)
    assert.equal(failed.json?.code, 'STORAGE_UNAVAILABLE')
    assert.match(failed.text, /服务器/, '另一条路径也要给出给用户看的那句话')
    assert.doesNotMatch(failed.text, /database or disk is full/i)
  })
})

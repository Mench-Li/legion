// team-hub/event-delivery-wiring.test.mjs
// ============================================================================
// F-05 投递状态机的**接线**判据：真 hub 进程 + 真 SSE 订阅者 + 真 HTTP。
//
// `event-delivery.test.mjs` 验的是仓储本身（单进程内，直接调函数）。
// 本文件验的是另一件事，而它才是 F-05 真正缺的那一半：
//
//   > 一个"投递状态机能记六种态"的模块，与一个"部署里真的在记"的模块，
//   > 在只看它自己的用例时是同一个东西——只不过前者的用例是绿的，
//   > 而那句静默的 `continue` 还在 `broadcastAudit` 里。
//
// 所以三条判据都对着**真的 HTTP 面**：
//
//   ① 真的连一个 `/api/events`，再真的写一条审计 ⇒ 该订阅者有一行 `delivered`；
//   ② 连一个 `scope=software` 的订阅者，写一条 `scope=ozon` 的审计 ⇒
//      那个订阅者有一行 **`suppressed` + `scope-mismatch`**（不是"什么都没有"）；
//   ③ 把 socket **打断**再写一条 ⇒ 那个订阅者要么有一行 **`failed` 且带原因**，
//      要么一行都不新增。**唯一不许出现的结局是"新增了一行 delivered"**——
//      那正是改动前的行为：`res.write` 的返回值被丢掉，异常被事件循环吞掉，
//      读数是"发过了"。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-deliv-wire-'))
let mod
let base = ''
const TOKEN = 'deliv-e2e-token'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

const auth = { authorization: `Bearer ${TOKEN}` }

async function getJson(path) {
  const r = await fetch(base + path, { headers: auth })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/**
 * 连一个真 SSE 订阅者，等到响应头回来（也就是服务端**已经把它登记进去**了）。
 *
 * 为什么不能只 `fetch()` 就开始写审计：`/api/events` 在 `writeHead` 之后才
 * `eventClients.add()`，而 `fetch` 的 promise 在**收到响应头**时才 resolve。
 * 所以 `await fetch` 返回时登记已经发生——这一点决定了本文件所有用例的
 * 时序都是确定的，不需要 sleep。
 *
 * `AbortController` 用来制造 ③ 的"连接断了"。
 */
async function connect({ scope = null, clientId = null, kind = 'workbench' } = {}) {
  const qs = new URLSearchParams()
  if (scope !== null) qs.set('scope', scope)
  if (clientId !== null) qs.set('clientId', clientId)
  if (kind !== null) qs.set('kind', kind)
  const ac = new AbortController()
  const res = await fetch(`${base}/api/events?${qs.toString()}`, { headers: auth, signal: ac.signal })
  assert.equal(res.status, 200, 'SSE 订阅应返回 200')
  const reader = res.body.getReader()
  const frames = []
  let closed = false
  // 后台读帧：既让 socket 真的被消费（否则背压会改变写作行为），
  // 也让我们能断言"帧真的到了"。
  const pump = (async () => {
    try {
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) break
        frames.push(dec.decode(value))
      }
    } catch { /* 被 abort 或连接关闭 */ } finally { closed = true }
  })()
  void pump
  return {
    controller: ac,
    frames,
    isClosed: () => closed,
    /** 收帧的设备无关等待：轮询到条件成立或超时（有上界，绝不无限等）。 */
    waitFor: async (pred, { timeoutMs = 4000, label = '条件' } = {}) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (pred(frames.join(''))) return true
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`等待${label}超时（${timeoutMs}ms），已收帧：${frames.join('').slice(0, 400)}`)
    },
    close: () => { try { ac.abort() } catch { /* 已关 */ } },
  }
}

/**
 * 造一条审计事件。走**真的** HTTP 写路径（与生产同一个入口）：
 * `POST /api/comment` 内部调 `audit(...)`，而审计的 `scope` 来自
 * `handleWrite` → `readScope(body)`，也就是 **body 里的 `scope`**（缺省 `'default'`）。
 *
 * ★ 这个细节是本文件第一次跑才量出来的：我原本以为 scope 会从**任务那一行**取，
 *   于是在 `software` 空间建了任务、comment 却没传 `scope`。结果是每条审计都落在
 *   `default` 上，订阅 `scope=software` 的连接**一条帧都收不到**——
 *   而"① 收到帧"红、"② 不匹配不收到"绿，**两条用例给出的是同一个读数**。
 *
 *   > 一个"测试造出来的数据落在哪个空间"被弄错的用例，
 *   > 与一个"订阅关系根本就没接上"的用例，在只看红绿的时候是同一个东西——
 *   > 只不过前者会让第二条（反向对照）**因为错误的原因而通过**。
 *
 * 所以下面显式传 `scope`，并且任务也建在同一个空间：两处一致，
 * "这条审计属于哪个空间"就只剩一个答案。
 */
let taskSeq = 0
async function writeAudit({ scope, action, member = 'e2e' }) {
  taskSeq += 1
  const id = `T-DELIV-${taskSeq}`
  mod.db.prepare(
    'INSERT OR REPLACE INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,0,?,?)',
  ).run(id, id, 'medium', 'todo', scope, new Date().toISOString(), new Date().toISOString())
  const r = await fetch(`${base}/api/comment`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ id, text: `delivery-probe-${action}`, by: member, scope }),
  })
  const body = await r.json().catch(() => null)
  assert.equal(r.status, 200, `写审计失败（${r.status}）：${JSON.stringify(body)}`)
  // 反向断言：这条审计真的落在预期的空间里。少了它，上面那个错误会
  // 以"① 红、② 因为错误的原因绿"的形式重现，而两处都不是它真正的位置。
  const row = mod.db.prepare('SELECT scope FROM audit WHERE seq = (SELECT MAX(seq) FROM audit)').get()
  assert.equal(row.scope, scope, `审计没有落在 ${scope} 空间（实际 ${row.scope}）——测试夹具自己错了`)
  return { id, body, seq: mod.db.prepare('SELECT MAX(seq) AS m FROM audit').get().m }
}

async function deliveryOf(subscriberId) {
  return getJson(`/api/event-delivery?subscriberId=${encodeURIComponent(subscriberId)}`)
}

// ---------------------------------------------------------------- ① delivered

test('① 真订阅者 + 真审计 ⇒ 有一行 `delivered`，并且帧真的到了', async () => {
  const sub = 'workbench:software:c-delivered'
  const conn = await connect({ scope: 'software', clientId: 'c-delivered' })
  try {
    const wrote = await writeAudit({ scope: 'software', action: 'deliver-a' })
    // 等帧时按 **seq** 而不是按正文：`/api/comment` 写审计时 detail 是 `{}`
    // （评论正文在任务的批注列里，不在审计载荷里）。按正文等会永远等不到，
    // 而失败信息看起来像"帧没到"——它是一个**探针写错**造成的假红。
    await conn.waitFor((s) => s.includes(`id: ${wrote.seq}\n`), { label: `seq=${wrote.seq} 的帧` })
    const r = await deliveryOf(sub)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.subscriber.exists, true, '订阅者没有被登记进投递仓储')
    assert.ok(r.body.subscriber.counts.delivered >= 1,
      `投递仓储里没有 delivered 行：${JSON.stringify(r.body.subscriber.counts)}`)
    // ★ fanout 必须是真实写过的连接数（1），而不是编出来的默认值。
    const row = r.body.rows.find((x) => x.state === 'delivered')
    assert.equal(row.fanout, 1)
    assert.equal(typeof row.deliveredAtMs, 'number')
    // 游标必须已经推进到那一条，否则下次重连会把整段历史重投。
    assert.ok(r.body.subscriber.cursorSeq >= row.seq, '投递成功但游标没推进')
    assert.ok(r.body.subscriber.cursorSeq >= wrote.seq, '游标没推进到刚投出去的那一条')
  } finally { conn.close() }
})

// ---------------------------------------------------------------- ② suppressed

test('② scope 不匹配 ⇒ 落 `suppressed` + `scope-mismatch`，而不是"什么都没有"', async () => {
  const sub = 'workbench:software:c-suppressed'
  const conn = await connect({ scope: 'software', clientId: 'c-suppressed' })
  try {
    // 写一条**不属于**这个订阅者的审计。
    await writeAudit({ scope: 'ozon', action: 'deliver-b' })
    // 等一小段：广播是同步发生的，"没收到"这件事没有事件可等。
    await new Promise((r) => setTimeout(r, 250))
    const r = await deliveryOf(sub)
    assert.equal(r.body.subscriber.exists, true)
    const sup = r.body.rows.filter((x) => x.state === 'suppressed')
    assert.ok(sup.length >= 1,
      'scope 不匹配的帧**没有留下任何记录** —— 静默 continue 又回来了：'
      + JSON.stringify(r.body.subscriber.counts))
    assert.equal(sup[0].reason, 'scope-mismatch')
    // ★ 反向对照，两条缺一不可：
    //   ① 那条不匹配的审计**确实**存在（否则 suppressed 行可能是别的东西造成的）；
    //   ② 订阅者**没有**收到它。
    const ozonAudit = mod.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE scope = 'ozon'").get()
    assert.ok(ozonAudit.n >= 1, 'ozon 空间里根本没有审计行 —— 这条反向对照是空的')
    assert.equal(conn.frames.join('').includes('delivery-probe-deliver-b'), false,
      'scope 不匹配的帧被投给了这个订阅者')
  } finally { conn.close() }
})

// ---------------------------------------------------------------- ③ failed

test('③ 连接被打断 ⇒ 要么 `failed` 带原因，要么不新增行；**绝不新增 delivered**', async () => {
  const sub = 'workbench:software:c-failed'
  const conn = await connect({ scope: 'software', clientId: 'c-failed' })
  // 等它真的被登记进去（`connect` 已经 await 了响应头，登记在它之前完成）。
  const first = await deliveryOf(sub)
  assert.equal(first.body.subscriber.exists, true)

  // 打断连接。**注意服务端不一定立刻从 `eventClients` 里把这条移除**——
  // `req.on('close')` 要等一次事件循环。所以下面那条审计可能写到一条
  // 已经死掉的 socket 上——那正是要测的场景。
  conn.close()
  // 给服务端一个机会先处理 close（如果它处理了，这条审计就不会写给这个订阅者，
  // 那时本用例退化成"没有新增行"——同样是**不静默**的证据）。
  await new Promise((r) => setTimeout(r, 150))

  const deliveredBefore = first.body.subscriber.counts.delivered
  await writeAudit({ scope: 'software', action: 'deliver-c' })
  await new Promise((r) => setTimeout(r, 250))

  const second = await deliveryOf(sub)
  const failed = second.body.rows.filter((x) => x.state === 'failed')
  const deliveredAfter = second.body.subscriber.counts.delivered
  if (failed.length >= 1) {
    assert.ok(typeof failed[0].lastError === 'string' && failed[0].lastError.length > 0,
      'failed 行没有错误原因 —— 一条不说原因的失败与一条不存在的失败，在事后读起来是同一个东西')
  } else {
    assert.equal(deliveredAfter, deliveredBefore,
      '连接已经断了，投递仓储里却新增了 delivered 行 —— 那正是"发不出去也说发过了"：'
      + JSON.stringify(second.body.subscriber.counts))
  }
})

// ---------------------------------------------------------------- ④ 记账失败可见

test('④ 记账失败在 `/api/config` 上看得见（旁路失败不许完全无声）', async () => {
  const r = await getJson('/api/config')
  assert.equal(r.status, 200)
  assert.equal(r.body.eventDelivery.subscribers, true, '能力发现位丢了')
  assert.equal(typeof r.body.eventDelivery.bookkeepingFailures, 'number',
    '记账失败计数器不在能力发现位上 —— 一个被刻意设计成"不影响主流程"的失败会永远没人知道')
  assert.equal(r.body.eventDelivery.bookkeepingFailures, 0, '正常路径上不该有记账失败')
  assert.ok(r.body.eventDelivery.liveConnections >= 0)
})

// ---------------------------------------------------------------- ⑤ 匿名订阅者不共用游标

test('⑤ 不传 clientId 的连接是**独立**订阅者，不冒用别人的游标', async () => {
  const a = await connect({ scope: 'software' })
  const b = await connect({ scope: 'software' })
  try {
    const sa = await getJson('/api/event-delivery')
    assert.equal(sa.status, 200)
    const anon = sa.body.subscribers.filter((s) => s.subscriberId.startsWith('anonymous:'))
    assert.ok(anon.length >= 2,
      '两个匿名连接被合成同一个订阅者 —— 一个不声称自己是谁的连接冒用了别人的游标，'
      + `那会让真正的订阅者的游标被一次匿名连接带偏：${JSON.stringify(sa.body.subscribers.map((s) => s.subscriberId))}`)
    const ids = new Set(anon.map((s) => s.subscriberId))
    assert.equal(ids.size, anon.length, '匿名订阅者 id 有重复')
  } finally { a.close(); b.close() }
})

// ---------------------------------------------------------------- ⑥ 六态汇总 + 回收

test('⑥ 汇总端点给出六态计数与过期租约数；`?recover=1` 是**显式**动作', async () => {
  const r = await getJson('/api/event-delivery')
  assert.equal(r.status, 200)
  for (const s of ['pending', 'delivering', 'delivered', 'suppressed', 'failed', 'unknown']) {
    assert.equal(typeof r.body.counts[s], 'number', `汇总里缺 ${s}`)
  }
  assert.equal(typeof r.body.expiredLeases, 'number')
  assert.ok(Array.isArray(r.body.subscribers))
  // 不带 `recover=1` 时 `recovered` 必须是空的（回收是写操作，不该藏在 GET 里）。
  assert.deepEqual(r.body.recovered, [])
  const withRecover = await getJson('/api/event-delivery?recover=1')
  assert.equal(withRecover.status, 200)
  assert.ok(Array.isArray(withRecover.body.recovered))
})

test('⑦ 未知订阅者返回 404 + 具名码（不是空读数冒充"投完了"）', async () => {
  const r = await getJson('/api/event-delivery?subscriberId=nope%3Asoftware%3Azzz')
  assert.equal(r.status, 404)
  assert.equal(r.body.code, 'SUBSCRIBER_NOT_FOUND')
})

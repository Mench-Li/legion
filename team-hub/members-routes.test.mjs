// ============================================================================
// PRT-316 切片 23：`GET /api/members`（成员名册）
//
// ★ 本族在搬走之前**一把判据都没有** —— `survey-judges2` 对它报"强判据 0 套"。
//   也就是说这个端点（8 行、1 条路由）从来没有被任何用例看过一眼，
//   而它算的东西（"谁还在线"）是**会随时间自己变**的。
//
// 形状全部是量出来的（`probe23-members.mjs`）：
//   · 回执是**裸数组**（不是 `{ok, members}`）
//   · 每行恰好 5 个键：`member / scope / kind / lastSeenAt / online`
//   · `member` 取的是库里的 `id`（不是 scope）
//   · 顺序 `lastSeenAt DESC`，`lastSeenAt` 为 `null` 的排最后
//   · `online` = `Date.now() - new Date(lastSeenAt ?? 0).getTime() < 60000`
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir
let ins

const get = async (path = '/api/members', method = 'GET') => {
  const res = await fetch(base + path, { method, agent: false })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const seed = (id, scope, kind, msAgo) => ins.run(id, scope, kind, msAgo === null ? null : iso(msAgo), 'm')
const ids = (rows) => rows.map((r) => r.member)

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-membersroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  ins = mod.db.prepare('INSERT INTO members (id, scope, kind, lastSeenAt, online, model) VALUES (?, ?, ?, ?, 1, ?)')
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 一个成员都没有时返回**裸空数组**（不是 `{ok, members:[]}`）', async () => {
  const r = await get()
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body), `回执必须是数组，实际是 ${typeof r.body}`)
  assert.deepEqual(r.body, [])
})

test('② 每行恰好 5 个键，`member` 取的是库里的 id', async () => {
  seed('m-shape', 'sp-shape', 'agent', 1000)
  const rows = (await get()).body
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['kind', 'lastSeenAt', 'member', 'online', 'scope'],
    '★ 键集变了就是**接口变了** —— 前端按这 5 个键画名册')
  assert.equal(rows[0].member, 'm-shape', '★ 拿 scope 当成员名的话，前端会画出两个同名的"人"')
  assert.equal(rows[0].scope, 'sp-shape')
  assert.equal(rows[0].kind, 'agent')
})

test('③ 顺序是 `lastSeenAt DESC`（最近出现的排最前，null 排最后）', async () => {
  mod.db.prepare('DELETE FROM members').run()
  seed('m-old', 's', 'agent', 500000)
  seed('m-new', 's', 'agent', 1000)
  seed('m-mid', 's', 'agent', 60000)
  seed('m-null', 's', 'agent', null)
  assert.deepEqual(ids((await get()).body), ['m-new', 'm-mid', 'm-old', 'm-null'],
    '★ 不排序的话，"谁最近上线"这件事只能靠调用方自己再排一遍')
})

test('④ ★ `online` 的 60 秒窗口（两边各留 1 秒余量）', async () => {
  mod.db.prepare('DELETE FROM members').run()
  // ⚠️ 第一版我用 59999/60000/60001 毫秒做边界 —— 跑出来四条全是 false：
  //    一次 HTTP 往返就要十几毫秒，等我读到它时**四条都已经过了 60 秒**。
  //    （*一个"正好卡在边界上"的夹具，与一个"边界在到达断言之前就已经被时间推过去了"的事实，
  //      在我把余量留成零的时候是同一个东西。*）
  seed('m-59s', 's', 'agent', 59000)
  seed('m-61s', 's', 'agent', 61000)
  const rows = (await get()).body
  const by = Object.fromEntries(rows.map((r) => [r.member, r.online]))
  assert.equal(by['m-59s'], true, '59 秒前出现过的人是在线的')
  assert.equal(by['m-61s'], false, '★ 61 秒前出现过的人**不**在线 —— 恒 true 会让离线的人也显示在线')
})

test('⑤ `lastSeenAt` 是 null 的人：`online` 为 false，且不抛', async () => {
  mod.db.prepare('DELETE FROM members').run()
  seed('m-never', 's', 'agent', null)
  const rows = (await get()).body
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lastSeenAt, null, 'null 要原样透出，不能变成 1970 或空串')
  assert.equal(rows[0].online, false,
    '★ `new Date(null ?? 0)` = 1970 ⇒ 不算在线。少了 `?? 0` 会得到 Invalid Date，' +
    '而 `NaN < 60000` 恰好也是 false —— 所以这一格真正守的是"不抛异常"')
})

test('⑥ ★ 未来时间戳（时钟偏了）算在线', async () => {
  mod.db.prepare('DELETE FROM members').run()
  seed('m-future', 's', 'agent', -5000)
  const rows = (await get()).body
  assert.equal(rows[0].online, true,
    '年龄是负数 ⇒ 小于 60000 ⇒ 在线。这一格钉住"用减法而不是用区间判断"这件事')
})

test('⑦ 名册跨范围（这条端点**不**按 scope 过滤）', async () => {
  mod.db.prepare('DELETE FROM members').run()
  seed('m-a', 'sp-a', 'agent', 1000)
  seed('m-b', 'sp-b', 'agent', 2000)
  assert.deepEqual(ids((await get()).body).sort(), ['m-a', 'm-b'],
    '★ 这是**全局**名册：传 ?scope= 也不过滤 —— 与 /api/board 那种按 scope 过滤的端点不是一回事')
  assert.deepEqual(ids((await get('/api/members?scope=sp-a')).body).sort(), ['m-a', 'm-b'])
})

test('⑧ 只有 GET 认这条路径', async () => {
  for (const m of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await get('/api/members', m)).status, 404, `${m} /api/members 应当 404`)
  }
})

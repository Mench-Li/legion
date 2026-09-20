// ============================================================================
// PRT-316 切片 31：单次运行预算账本（`/api/runtime/run-budget` 六条）
//
// ★ 本片**不是**为了"补一套判据"才写的 —— 这一族**已经有强判据**
//   （`team-hub/budget-routes.test.mjs`，23 例 / 31 个真 HTTP 请求点）。
//   本文件是**破验量出来的三个缺口**的补丁：把那三条**可观测但没人看**的差别
//   各钉一格，然后拿反方向破验证明它们真的会因修复/破坏而变红。
//
//   > 一个"这一族有 23 例守着"的印象，与一个"其中三条差别**没有任何一格在看**"的事实，
//   > 在我没有把它们**逐条改坏一次、看谁变红**的时候是同一个东西。
//
// 量出来的三个缺口（都不是猜的，是改坏之后**不红**的那三条）：
//
//   ⑫ `GET /api/runtime/run-budget?state=` 的**状态过滤**
//      不带 = 3 条 ｜ `?state=settled` = 1 条 ｜ `?state=reserved` = 2 条
//      —— 把 `state` 从 `list()` 的参数里去掉，原来那套**一条都不红**。
//
//   ⑬ `GET /api/runtime/run-budget?scope=` 的 **`held` 归属**
//      `?scope=default` → `held=[{USD,100}]` ｜ `?scope=other` → `[{USD,7}]` ｜ `?scope=nope` → `[]`
//      —— 把 `heldAmount(scope)` 写成 `heldAmount('default')`（常量），原来那套**一条都不红**。
//
//   ⑭ `match:'exact'` 对**多余后缀**的拒绝
//      `POST /api/runtime/run-budget/reserveX` 现在是 **404**；
//      改成 `prefix` 就会落进 `reserve` 的体里（变成 400 `ATTEMPT_REQUIRED`）。
//      —— 原来那套**一条都不红**。
//
// 另有两条**可证等价**（不是缺口，写在这里免得下次再查一遍）：
//   · `budget: body.budget ?? null` —— `reserve()` 第一句就是
//     `if (budget === null || budget === undefined)`，两种写法**同一条分支**。
//   · `locked: r.locked === true` —— `settle()` **两条出口都显式给布尔**
//     （锁定时 `locked: true`、结算时 `locked: false`），永远不是 `undefined`。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PT = {
  version: 'rb-routes-pt', currency: 'USD', effectiveAtMs: 1_700_000_000_000,
  models: { cheap: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 } },
}

let mod
let base = ''
const dbDir = mkdtempSync(join(tmpdir(), 'legion-rbroutes-'))

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, agent: false,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
mod = await import('./server.mjs')
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + mod.server.address().port

const pub = await call('POST', '/api/price-tables', { actor: 'ops', ...PT })
assert.equal(pub.status, 200, '价目表没发布成功 ⇒ 后面全是空夹具，会静默假绿')

/** 夹具：default 两笔（一笔结算掉）+ other 一笔。 */
const seed = async () => {
  mod.db.exec('DELETE FROM budget_reservations')
  const mk = (attemptId, scope, maxCost) => call('POST', '/api/runtime/run-budget/reserve', {
    attemptId, scope, modelProfileId: 'cheap',
    budget: { currency: 'USD', maxCost }, priceTableVersion: PT.version,
  })
  assert.equal((await mk('att:A:1', 'default', 100)).status, 200)
  assert.equal((await mk('att:A:2', 'default', 5)).status, 200)
  assert.equal((await mk('att:B:1', 'other', 7)).status, 200)
  const done = await call('POST', '/api/runtime/run-budget/settle', {
    attemptId: 'att:A:2', actor: 'ops', outcome: 'known', tokensIn: 1, tokensOut: 1,
  })
  assert.equal(done.status, 200)
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── ⑫ `state` 过滤 ────────────────────────────────────────────────────────
test('⑫ ★★★ `?state=` 真的在过滤（不带 3 条 / settled 1 条 / reserved 2 条）', async () => {
  await seed()
  const all = await call('GET', '/api/runtime/run-budget')
  const settled = await call('GET', '/api/runtime/run-budget?state=settled')
  const reserved = await call('GET', '/api/runtime/run-budget?state=reserved')

  assert.equal(all.status, 200)
  assert.equal(all.body.reservations.length, 3, '不带 state ⇒ 全都要')
  assert.equal(settled.body.reservations.length, 1, '★ 只说 settled 就只给 settled')
  assert.equal(reserved.body.reservations.length, 2, '★ 只说 reserved 就只给 reserved')
  assert.ok(settled.body.reservations.every((r) => r.state === 'settled'))
  assert.ok(reserved.body.reservations.every((r) => r.state === 'reserved'))
  // 去掉 `state` 之后这里会变成 3 / 3 / 3 —— ⑫ 就是钉这个的
})

test('⑬ ★★ 认不出的 `state` 给空列表（不是悄悄退化成"全都要"）', async () => {
  await seed()
  const r = await call('GET', '/api/runtime/run-budget?state=nope')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.reservations, [],
    '★ 参数不认识时**回空**，而不是把过滤悄悄丢掉 —— 静默退化会让"筛了但没筛"看不出来')
})

test('⑬b ★★ `state` 与 `scope` 同时给，两个都在生效', async () => {
  await seed()
  const r = await call('GET', '/api/runtime/run-budget?scope=default&state=settled')
  assert.equal(r.body.reservations.length, 1)
  assert.equal(r.body.reservations[0].attemptId, 'att:A:2')
})

// ── ⑭ `held` 的归属 ──────────────────────────────────────────────────────
test('⑭ ★★★ `held` 跟着 `scope` 走（default 100 / other 7 / nope 空）', async () => {
  await seed()
  const d = await call('GET', '/api/runtime/run-budget?scope=default')
  const o = await call('GET', '/api/runtime/run-budget?scope=other')
  const n = await call('GET', '/api/runtime/run-budget?scope=nope')

  assert.deepEqual(d.body.held, [{ currency: 'USD', held: 100 }],
    'default 只有 att:A:1 还在占用（att:A:2 已结算、释放）')
  assert.deepEqual(o.body.held, [{ currency: 'USD', held: 7 }], '★ other 的占用不能算到 default 头上')
  assert.deepEqual(n.body.held, [], '★ 没占用过的空间回**空数组**，不是 [{currency:null,held:0}]')
  // 把 `heldAmount(scope)` 写成常量 `'default'` 之后，上面第 2、3 条会红 —— ⑭ 就是钉这个的
})

test('⑭b ★★ 不带 `scope` 时 `held` 是**全空间合计**（18 = 100 + 5 之外只剩未结算的）', async () => {
  await seed()
  const all = await call('GET', '/api/runtime/run-budget')
  // 占用状态：att:A:1 reserved 100、att:B:1 reserved 7；att:A:2 已 settled ⇒ 不占
  assert.deepEqual(all.body.held, [{ currency: 'USD', held: 107 }])
})

// ── ⑮ `match: 'exact'` 对多余后缀的拒绝 ───────────────────────────────────
test('⑮ ★★★ 多一个字符就不是这条路（`reserveX` 必须 404，不能落进 reserve 的体）', async () => {
  await seed()
  const r = await call('POST', '/api/runtime/run-budget/reserveX', { attemptId: 'att:X:1' })
  assert.equal(r.status, 404,
    '★ 若这里变成 400 `ATTEMPT_REQUIRED`，说明 `match` 从 exact 松成了 prefix —— ' +
    '那会让任何 `/api/runtime/run-budget/reserve…` 都被当成预留')
  assert.match(String(r.body.error), /not found/)
})

test('⑮b ★★ 单条读那条**是** prefix 的（`/api/runtime/run-budget/<attemptId>` 要能读）', async () => {
  await seed()
  const r = await call('GET', '/api/runtime/run-budget/att%3AA%3A1')
  assert.equal(r.status, 200, '★ 与 ⑮ 成对：一条是 exact、一条是 prefix，不能一起松也不能一起紧')
  assert.equal(r.body.reservation.attemptId, 'att:A:1')
  assert.deepEqual(r.body.usage, r.body.usage, 'usage 字段在')
  assert.ok('usage' in r.body)
})

test('⑮c ★★ 前缀那条不认多段路径（`a/b` 应当 404 而不是当成 id 含 `/`）', async () => {
  await seed()
  const r = await call('GET', '/api/runtime/run-budget/att%3AA%3A1%2Fextra')
  assert.equal(r.status, 404, '★ 解码出来是 `att:A:1/extra`，账本里没有这个键')
})

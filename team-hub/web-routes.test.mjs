// ============================================================================
// PRT-316 切片 27：浏览器助手抓取历史（`/api/web` 三条）
//   POST /api/web/history        入表 / 累加
//   GET  /api/web/history        读一版 + 统计
//   POST /api/web/history/clear  清一个（给 id）或清一空间（不给 id）
//
// ★ 本族搬走之前**一把判据都没有**（`survey-judges2` 对三个路径全报"强判据 0 套"）。
//   形状全部是先量出来的（`probe27-web.mjs` + `probe27b-web.mjs`）：
//     · 本族**自己**读体（`readBody`），**不走 `handleWrite`** ⇒ 没有 `{ok, task}` 信封、
//       也**不需要 `body.by`**（整族三条都没有操作者那道门）
//     · 写是 `{ok, id, hits, updated, trimmed}` —— ★ **只有新建那条路有 `trimmed`**
//     · 读是 `{scope, items, stats{total,failed,bytes,shown}}`
//     · `?q=` 只筛 `items`，`stats` 仍然是**全空间**的
//
// ★★★ 本族钉住两处**已验证的真缺陷**（都只钉现状、不修）：
//   ① `?limit=2.7` → **500 `datatype mismatch`**！
//      `Math.min(Number('2.7') || 30, 200)` 是 **2.7**，直接进了 SQL 的 `LIMIT ?`。
//      这与切片 22 在 `/api/team-plans` 上量到的**一模一样** —— 而且我又量了第三处：
//      `/api/activity`（**还在 `server.mjs` 里**，L6381 那个形状）同样是 500。
//      ⇒ 这不是三处巧合，是**一个形状**：`Math.min(Number(param) || D, CAP)` 喂给 `LIMIT ?`。
//   ② `status`/`bytes`/`ms` 的归一里，**`null` 与"没给"落成两个不同的值**：
//      `Number(undefined)` 是 `NaN` ⇒ 落 `null`；而 `Number(null)`、`Number('')`、
//      `Number(false)` **都是 0** ⇒ 落 `0`。于是显式传 `{"status": null}` 的客户端
//      拿到的是 `status: 0`（看着像"HTTP 0"），而**省略**这个键拿到的是 `null`。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, agent: false,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const put = (body) => call('POST', '/api/web/history', body)
const read = (qs) => call('GET', '/api/web/history?' + qs)
const clear = (body) => call('POST', '/api/web/history/clear', body)

/** 直接批量落库造行（走 HTTP 造 2000 行太慢）。 */
const seedRows = (scope, n) => {
  const ins = mod.db.prepare(`INSERT INTO web_fetch_history
    (id, scope, url, finalUrl, host, title, excerpt, status, bytes, ms, errorCode, cached, hits, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, ?, ?)`)
  const t = new Date().toISOString()
  mod.db.exec('BEGIN')
  try {
    for (let i = 0; i < n; i++) ins.run(`seed_${scope}_${i}`, scope, `https://seed/${scope}/${i}`, t, t)
    mod.db.exec('COMMIT')
  } catch (e) { mod.db.exec('ROLLBACK'); throw e }
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-webroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── 入表 / 累加 ───────────────────────────────────────────────────────────
test('① 入表：新行回执 `{ok, id, hits:1, updated:false, trimmed:0}`', async () => {
  const r = await put({ scope: 'w1', url: 'https://example.com/a', title: '甲', status: 200, bytes: 12, ms: 3 })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.hits, 1)
  assert.equal(r.body.updated, false)
  assert.equal(r.body.trimmed, 0)
  assert.match(String(r.body.id), /^wh_/)
})

test('② 同 `(scope, url)` 再来是**累加**，不是新行', async () => {
  const a = await put({ scope: 'w2', url: 'https://example.com/x' })
  const b = await put({ scope: 'w2', url: 'https://example.com/x' })
  const c = await put({ scope: 'w2', url: 'https://example.com/x' })
  assert.equal(b.body.id, a.body.id, '同一个地址要复用同一行 —— 历史是"抓过哪些地址"，不是逐次流水')
  assert.deepEqual([a.body.hits, b.body.hits, c.body.hits], [1, 2, 3])
  assert.ok(b.body.updated && c.body.updated)
  assert.equal((await read('scope=w2')).body.stats.total, 1)
})

test('③ ★ 回执的信封**两条路不一样**：更新那条没有 `trimmed`', async () => {
  const a = await put({ scope: 'w3', url: 'https://example.com/y' })
  const b = await put({ scope: 'w3', url: 'https://example.com/y' })
  assert.deepEqual(Object.keys(a.body).sort(), ['hits', 'id', 'ok', 'trimmed', 'updated'])
  assert.deepEqual(Object.keys(b.body).sort(), ['hits', 'id', 'ok', 'updated'],
    '★ 更新这条路**不回 `trimmed`** —— `trimmed` 只在新行那条路上算得出来' +
    '（容量裁剪只发生在新建时）。照新建那条去解更新那条就会多断言一格。')
})

test('④ ★★ 本族**不需要 `body.by`**（它自己 `readBody`，不走 `handleWrite`）', async () => {
  const r = await put({ scope: 'w4', url: 'https://example.com/z' })
  assert.equal(r.status, 200, '★ 与 `/api/models`、`/api/exec` 那些走 handleWrite 的族**相反**，这里没有操作者那道门')
  assert.equal(r.body.ok, true)
})

test('⑤ 缺参数：`scope`/`url` 缺或全空白都 400', async () => {
  const cases = [
    [{ url: 'https://a/' }, /scope/],
    [{ scope: 'w5' }, /url/],
    [{ scope: '   ', url: 'https://a/' }, /scope/],
    [{ scope: 'w5', url: '   ' }, /url/],
    [{}, /scope/],
  ]
  for (const [body, re] of cases) {
    const r = await put(body)
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应当被拒`)
    assert.match(String(r.body.error), re)
  }
})

test('⑥ `host` 从 URL 取；**非法 URL 也照记**（错误码本身就是历史的一部分）', async () => {
  await put({ scope: 'w6', url: 'https://sub.example.com:8443/p?q=1' })
  await put({ scope: 'w6', url: '这不是一个合法 URL' })
  const items = (await read('scope=w6')).body.items
  const byUrl = Object.fromEntries(items.map((x) => [x.url, x.host]))
  assert.equal(byUrl['https://sub.example.com:8443/p?q=1'], 'sub.example.com:8443', '带端口的 host 要原样留着')
  assert.equal(byUrl['这不是一个合法 URL'], '', '★ 非法 URL 不该被拒 —— 抓失败这件事本身也要留痕，host 落空串')
})

test('⑦ `title` 截到 300、`excerpt` 截到 500（边界两侧都量）', async () => {
  await put({ scope: 'w7', url: 'https://t/300', title: 'x'.repeat(300), excerpt: 'y'.repeat(500) })
  await put({ scope: 'w7', url: 'https://t/301', title: 'x'.repeat(301), excerpt: 'y'.repeat(501) })
  const items = Object.fromEntries((await read('scope=w7')).body.items.map((x) => [x.url, x]))
  assert.equal(items['https://t/300'].title.length, 300, '正好 300 要留下')
  assert.equal(items['https://t/300'].excerpt.length, 500, '正好 500 要留下')
  assert.equal(items['https://t/301'].title.length, 300, '301 要截到 300')
  assert.equal(items['https://t/301'].excerpt.length, 500, '501 要截到 500')
})

// ── ★★ 数值归一的真缺陷 ───────────────────────────────────────────────────
test('⑧ ★★ `status`/`bytes`/`ms`：**`null` 落成 0，而"没给"落成 `null`** —— 钉住现状', async () => {
  await put({ scope: 'n-absent', url: 'https://n/1' })
  await put({ scope: 'n-null', url: 'https://n/1', status: null, bytes: null, ms: null })
  await put({ scope: 'n-empty', url: 'https://n/1', status: '', bytes: '', ms: '' })
  await put({ scope: 'n-bad', url: 'https://n/1', status: 'abc', bytes: 'xyz', ms: 'zzz' })
  const one = async (s) => (await read('scope=' + s)).body.items[0]

  const absent = await one('n-absent')
  assert.equal(absent.status, null, '省略 ⇒ `Number(undefined)` 是 NaN ⇒ 落 null')
  assert.equal(absent.bytes, null)
  assert.equal(absent.ms, null)

  const explicitNull = await one('n-null')
  assert.equal(explicitNull.status, 0, '★ 显式传 `null` ⇒ `Number(null)` 是 **0**（有限！）⇒ 落 0')
  assert.equal(explicitNull.bytes, 0)
  assert.equal(explicitNull.ms, 0)
  // ★ 若这条红了：说明有人把 `null` 与"没给"归一成同一个值了 —— 那是**修对了**，
  //   请把断言改成与 `absent` 一致（三格都是 null），并把标题里的"真缺陷"去掉。
  assert.notDeepEqual(
    [explicitNull.status, explicitNull.bytes, explicitNull.ms],
    [absent.status, absent.bytes, absent.ms],
    '★ 现状就是"显式 null"与"省略"给出**不同**的读数（一个 0、一个 null）')

  const empty = await one('n-empty')
  assert.equal(empty.status, 0, '空串同理：`Number(\'\')` 是 0')
  const bad = await one('n-bad')
  assert.equal(bad.status, null, '只有**非数字串**（NaN）才落到 null')

  // ★★ 这一格是**分辨"归一"与"不归一"的唯一地方**：
  //   `NaN` 与 `±Infinity` 经 `JSON.stringify` 都变成 `null`，所以**回执里看不出来**；
  //   但 `Infinity` 在 SQLite 里**存得下**（REAL Inf），而 `stats.bytes` 是 `SUM(bytes)` ——
  //   于是"没归一"会把求和结果污染成 Inf（再序列化成 null），"归一了"则是干净的 0。
  await put({ scope: 'n-inf', url: 'https://n/1', bytes: 'Infinity', status: 'Infinity', ms: 'Infinity' })
  const inf = await one('n-inf')
  assert.equal(inf.bytes, null, '回执里它还是 null（JSON 的锅）——所以只看回执分辨不出来')
  assert.equal((await read('scope=n-inf')).body.stats.bytes, 0,
    '★ 但求和必须是 0：`Number.isFinite` 那道关口把它拦在库外了。' +
    '若这条红了（变成 null/Infinity），说明那道 `Number.isFinite` 被去掉了 —— ' +
    'NaN 看不出来，Infinity 会。')
})

test('⑨ `cached` 是按**真值**归一（`body.cached ? 1 : 0`）', async () => {
  await put({ scope: 'c1', url: 'https://c/1', cached: false })
  await put({ scope: 'c2', url: 'https://c/1', cached: 0 })
  await put({ scope: 'c3', url: 'https://c/1', cached: 'no' })
  await put({ scope: 'c4', url: 'https://c/1', cached: 'false' })
  const one = async (s) => (await read('scope=' + s)).body.items[0]
  assert.equal((await one('c1')).cached, false)
  assert.equal((await one('c2')).cached, false)
  assert.equal((await one('c3')).cached, true, '★ `\'no\'` 是真值 ⇒ true（不是"否"）')
  assert.equal((await one('c4')).cached, true, '★ 字符串 `\'false\'` 也是真值 ⇒ true')
})

// ── 读 ────────────────────────────────────────────────────────────────────
test('⑩ 读：`{scope, items, stats}`，items 是 14 格', async () => {
  await put({ scope: 'r1', url: 'https://r/1', title: '甲', status: 200, bytes: 5, ms: 1 })
  const r = await read('scope=r1')
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['items', 'scope', 'stats'])
  assert.deepEqual(Object.keys(r.body.items[0]).sort(),
    ['bytes', 'cached', 'createdAt', 'errorCode', 'excerpt', 'finalUrl', 'hits', 'host', 'id', 'ms', 'status', 'title', 'updatedAt', 'url'])
  assert.deepEqual(Object.keys(r.body.stats).sort(), ['bytes', 'failed', 'shown', 'total'])
})

test('⑪ 读：缺 `scope` ⇒ 400；未知空间 ⇒ 200 空（**不 404**）', async () => {
  const miss = await call('GET', '/api/web/history')
  assert.equal(miss.status, 400)
  assert.match(String(miss.body.error), /scope/)
  const none = await read('scope=从来没抓过')
  assert.equal(none.status, 200)
  assert.deepEqual(none.body.items, [])
  assert.deepEqual(none.body.stats, { total: 0, failed: 0, bytes: 0, shown: 0 })
})

test('⑫ ★ `stats.failed` 数的是 `errorCode IS NOT NULL` —— 所以**空串也算失败**', async () => {
  await put({ scope: 'f1', url: 'https://ok/', status: 200 })
  await put({ scope: 'f1', url: 'https://bad/', errorCode: 'TIMEOUT' })
  await put({ scope: 'f1', url: 'https://bad2/', errorCode: '' })
  const st = (await read('scope=f1')).body.stats
  assert.equal(st.total, 3)
  // ★ 我第一版在这里写的是 `failed === 1`（以为空串 ≈ 没给）—— 红了，**是我错了**。
  //   入库那步是 `body.errorCode == null ? null : String(body.errorCode)`：
  //   `''` 不是 `null`/`undefined` ⇒ 走 `String('')` ⇒ 存的是**空串**，不是 NULL；
  //   而统计那步判的是 `errorCode IS NOT NULL` ⇒ 空串**算失败**。
  assert.equal(st.failed, 2,
    '★ 现状：`errorCode: ""`（"没有错误码"的写法之一）会被算成**一次失败**。' +
    '若这条红了说明有人把空串归一成 NULL 了 —— 那是**修对了**，请把这里改成 1。')
  assert.equal((await read('scope=f1')).body.items.filter((x) => x.errorCode === null).length, 1,
    '只有**完全没给** errorCode 的那一行，回执里才是 null')
})

test('⑬ ★★★ 已知缺陷：`?limit=2.7` ⇒ **500 `datatype mismatch`**（与切片 22 同一形状）', async () => {
  const r = await read('scope=r1&limit=2.7')
  assert.equal(r.status, 500,
    '★ 现状是 500。若这条红了：说明有人给 limit 加了取整 —— 那是**修对了**，' +
    '请把断言改成 200 并检查 `Math.min(Number(...) || D, CAP)` 这个形状的**另两处**' +
    '（`/api/team-plans`、以及还在 `server.mjs` 里的 `/api/activity`）。')
  assert.match(String(r.body?.error ?? ''), /datatype mismatch/,
    '★ 错误指纹就是这个 —— 非整数进了 SQL 的 `LIMIT ?`')
})

test('⑭ `limit` 的其余读数：默认 30 · 0 落回 30 · 负数=不限 · 非数字落回 30 · 夹到 200', async () => {
  const scope = 'lim'
  for (let i = 0; i < 12; i++) await put({ scope, url: 'https://l/' + String(i).padStart(2, '0') })
  assert.equal((await read(`scope=${scope}`)).body.stats.shown, 12, '默认 30 ⇒ 全给')
  assert.equal((await read(`scope=${scope}&limit=1`)).body.stats.shown, 1)
  assert.equal((await read(`scope=${scope}&limit=5`)).body.stats.shown, 5)
  assert.equal((await read(`scope=${scope}&limit=0`)).body.stats.shown, 12, '★ `0 || 30` 是 30 —— 0 **不是**"一条都不要"')
  assert.equal((await read(`scope=${scope}&limit=abc`)).body.stats.shown, 12, 'NaN 落回 30')
  assert.equal((await read(`scope=${scope}&limit=-5`)).body.stats.shown, 12,
    '★ `Math.min(-5, 200)` 是 -5；SQLite 的**负 LIMIT = 不限** ⇒ 负数把上限整个绕过去了')
  assert.equal((await read(`scope=${scope}&limit=99999`)).body.stats.shown, 12, '夹到 200，但只有 12 行')
  const cap = await read(`scope=${scope}&limit=99999`)
  assert.equal(cap.body.items.length, 12)
  assert.equal(cap.body.stats.total, 12, '★ `total` 是**全空间**计数，不随 limit 变 —— 只有 `shown` 跟着 items 走')
})

test('⑮ `?q=` 大小写不敏感、匹配 url 与 title，且只筛 items', async () => {
  const scope = 'q1'
  await put({ scope, url: 'https://find-me/1' })
  for (let i = 0; i < 4; i++) await put({ scope, url: 'https://other/' + i })
  await put({ scope, url: 'https://x/2', title: '独特的标题' })

  const upper = await read(`scope=${scope}&q=FIND-ME`)
  assert.deepEqual(upper.body.items.map((x) => x.url), ['https://find-me/1'], '★ 大小写不敏感')
  const byTitle = await read(`scope=${scope}&q=${encodeURIComponent('独特的标题')}`)
  assert.deepEqual(byTitle.body.items.map((x) => x.url), ['https://x/2'], 'title 也参与匹配')

  assert.equal(upper.body.stats.total, 6, '★ `stats` 仍是**全空间**的，不随 q 变')
  assert.equal(upper.body.stats.shown, 1, '只有 `shown` 跟着筛完的 items 走')
  assert.deepEqual((await read(`scope=${scope}&q=没有这种东西`)).body.items, [])
})

// ── clear ─────────────────────────────────────────────────────────────────
test('⑯ clear：缺 `scope` ⇒ 400；给 `id` 清一个；不给 `id` 清一空间', async () => {
  assert.equal((await clear({})).status, 400)
  const r = await read('scope=r1')
  const id = r.body.items[0].id
  assert.deepEqual((await clear({ scope: 'r1', id })).body, { ok: true, removed: 1 })
  assert.equal((await read('scope=r1')).body.stats.total, 0)
  assert.deepEqual((await clear({ scope: 'r1', id: 'wh_不存在' })).body, { ok: true, removed: 0 },
    '★ 清一个不存在的 id 是 200 + removed:0，不是 404')
})

test('⑯b ★★★ 给 `id` 时**只删那一条**（"删一条"不能变成"删一空间"）', async () => {
  // ★ 这一格必须让那个空间**有两条以上**才看得出来：
  //   只有一条时，"删这条"与"删整个空间"的 `removed` 与结果**完全一样**。
  //   > 一个"我测过按 id 删了"的印象，与一个"那个空间当时恰好只有一行、
  //   > 于是'删一条'和'删一空间'给出同一个读数"的事实，
  //   > 在我没有让它有第二条的时候是同一个东西。
  const scope = 'clr-by-id'
  await put({ scope, url: 'https://keep/' })
  await put({ scope, url: 'https://drop/' })
  const items = (await read('scope=' + scope)).body.items
  assert.equal(items.length, 2)
  const dropId = items.find((x) => x.url === 'https://drop/').id
  assert.deepEqual((await clear({ scope, id: dropId })).body, { ok: true, removed: 1 })
  const left = (await read('scope=' + scope)).body
  assert.equal(left.stats.total, 1, '★ 删一条就只该少一条')
  assert.deepEqual(left.items.map((x) => x.url), ['https://keep/'], '留下的是另一条')
})

test('⑰ clear：**幂等**，且**只动自己那个空间**', async () => {
  await put({ scope: 'ca', url: 'https://ca/1' })
  await put({ scope: 'ca', url: 'https://ca/2' })
  await put({ scope: 'cb', url: 'https://cb/1' })
  assert.deepEqual((await clear({ scope: 'ca' })).body, { ok: true, removed: 2 })
  assert.deepEqual((await clear({ scope: 'ca' })).body, { ok: true, removed: 0 }, '再清一次是 0，不是错')
  assert.equal((await read('scope=cb')).body.stats.total, 1, '★ 清一个空间不能误伤别的空间')
})

// ── 容量上限 ──────────────────────────────────────────────────────────────
test('⑱ `maxPerScope`：满了就裁掉**最旧的**（按 updatedAt 升序）', async () => {
  for (let i = 0; i < 5; i++) await put({ scope: 'cap', url: 'https://cap/' + i, maxPerScope: 3 })
  const r = await read('scope=cap')
  assert.equal(r.body.stats.total, 3)
  assert.deepEqual(r.body.items.map((x) => x.url).sort(),
    ['https://cap/2', 'https://cap/3', 'https://cap/4'],
    '★ 留最近 3 条（裁掉 /0 与 /1）—— 反了的话历史里全是陈的')
})

test('⑲ `maxPerScope` 非法/超上限：0 与负数落回 200，超过 2000 夹到 2000', async () => {
  for (const v of [0, -1, 'abc', null]) {
    const r = await put({ scope: 'cap' + v, url: 'https://c/1', maxPerScope: v })
    assert.equal(r.status, 200)
    assert.equal(r.body.trimmed, 0, `maxPerScope=${JSON.stringify(v)} 应当落回默认 200（不裁）`)
  }
  const big = await put({ scope: 'capbig', url: 'https://c/2', maxPerScope: 99999 })
  assert.equal(big.body.trimmed, 0, '夹到 2000，只有 1 行 ⇒ 不裁')
})

test('㉑ ★★ `limit` 的上限**真的夹住了 200** —— 这要 >200 行才看得见', async () => {
  // ★ 我第一版只写了"limit=99999 → shown=12"，而那个空间当时只有 12 行 ——
  //   于是"夹到 200"与"根本不夹"给出**同一个读数**，破验里 M16 因此没咬住。
  //   > 一个"我测过上限"的印象，与一个"我测的那个空间**装不到上限**、
  //   > 于是有没有夹完全看不出来"的事实，在我没有把行数造过上限的时候是同一个东西。
  seedRows('big-limit', 260)
  assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope='big-limit'").get().n, 260)
  const capped = await read('scope=big-limit&limit=99999')
  assert.equal(capped.body.items.length, 200, '★ 夹到 200，而不是把 99999 原样交给 SQL')
  assert.equal(capped.body.stats.shown, 200)
  assert.equal(capped.body.stats.total, 260, '★ `total` 仍然是全量 260 —— 上限只影响这一页')
})

test('㉒ ★★ `maxPerScope` 的上限**真的夹住了 2000** —— 这要 >2000 行才看得见', async () => {
  seedRows('big-cap', 2001)
  assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope='big-cap'").get().n, 2001)
  // 新行（url 没出现过）⇒ 走容量裁剪那条路
  const w = await put({ scope: 'big-cap', url: 'https://brand-new/', maxPerScope: 99999 })
  assert.equal(w.status, 200)
  assert.equal(w.body.trimmed, 2, '★ 2001 + 1 = 2002，夹到 2000 ⇒ 裁掉 2')
  assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope='big-cap'").get().n, 2000)
})

test('⑳ 方法位：每条路径只认自己那个方法', async () => {
  for (const [m, p] of [['GET', '/api/web/history/clear'], ['PUT', '/api/web/history'], ['DELETE', '/api/web/history'], ['DELETE', '/api/web/history/clear']]) {
    assert.equal((await call(m, p)).status, 404, `${m} ${p} 应当 404`)
  }
  // POST /api/web/history 无体是**命中**了的（不是 404），只是缺 scope
  assert.equal((await call('POST', '/api/web/history')).status, 400)
})

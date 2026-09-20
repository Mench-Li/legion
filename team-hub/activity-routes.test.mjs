// ============================================================================
// PRT-316 切片 50：活动流水 —— 1 条，`exact`
//   GET /api/activity?goalId=&taskId=&scope=&limit=
//
// ★★★ 这一族的语义**几乎全在分支顺序和一个算式里**，而两处都容易看漏：
//
//   ① 四个分支有**优先级**：`goalId` > `taskId` > `scope` > 全量。
//      顺序即语义 —— 换一下顺序，同一条请求读到的是**另一批**行，却**都返回 200**。
//
//   ② `limit` 的算式 `Math.min(Number(v ?? 50) || 50, 500)` 里那个 `|| 50`：
//      `0` 是 falsy ⇒ `limit=0` 拿到的是 **50 条**，不是 0 条。
//      负数不会被 `Math.min` 夹住 ⇒ `limit=-5` 原样进 SQL，而 SQLite 的
//      `LIMIT -5` 意思是**不限制**。
//      ⇒ 两处都"看着像做了校验"，其实都没有。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createActivityRoutes } from './routes/activity.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-activity-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (q) => {
  const res = await fetch(base + '/api/activity' + (q ? '?' + q : ''))
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const reset = () => {
  mod.db.prepare('DELETE FROM audit').run()
  mod.db.prepare('DELETE FROM tasks').run()
}
let SEQ = 0
/** 插一条审计行；返回它的 seq。★ `goalId` 是迁移加上去的列，可以写。 */
const ev = (over = {}) => {
  const r = mod.db.prepare('INSERT INTO audit (ts, member, scope, action, taskId, goalId, detail) VALUES (?,?,?,?,?,?,?)')
    .run(over.ts ?? `t${++SEQ}`, over.member ?? 'm', over.scope ?? 'S', over.action ?? 'act',
      over.taskId ?? null, over.goalId ?? null, over.detail ?? '{}')
  return Number(r.lastInsertRowid)
}
const seedTask = (id, goalId) => {
  mod.db.prepare('INSERT INTO tasks (id, title, scope, goalId) VALUES (?,?,?,?)').run(id, id, 'S', goalId)
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ 形状 ══════════════════════

test('① ★★ 200 且是**数组**（不是 `{ok,rows}`）；元素带 `auditEvent` 那套字段', async () => {
  reset(); ev()
  const r = await get('')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body), '★★ 顶层就是数组 —— 不是 `{ok:true, rows:[…]}`')
  assert.equal(r.body.length, 1)
  const e = r.body[0]
  for (const k of ['seq', 'ts', 'scope', 'action', 'taskId', 'member', 'goalId', 'id', 'payload']) {
    assert.ok(k in e, `★★ 缺字段 ${k}：${JSON.stringify(e)}`)
  }
  assert.equal(e.event, e.action, '★ `event` 与 `action` 同值（两个名字都留着）')
  assert.equal(e.id, e.seq, '★ `id` 就是 `seq`（SSE 的 Last-Event-ID 用它）')
})

test('② ★★ 空库 ⇒ 200 + 空数组（不是 404）', async () => {
  reset()
  const r = await get('')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, [], '★★ 没有事件是"空",不是"找不到"')
})

test('③ ★★★ 四个分支的**优先级**：goalId > taskId > scope > 全量', async () => {
  reset()
  const all = ev({ scope: 'S', action: 'A-all' })
  const byScope = ev({ scope: 'S', action: 'A-scope' })
  const byTask = ev({ scope: 'S', taskId: 'T1', action: 'A-task' })
  const byGoal = ev({ scope: 'S', goalId: 'G1', action: 'A-goal' })
  const other = ev({ scope: 'OTHER', action: 'A-other' })

  const acts = (b) => b.map((x) => x.action).sort()

  // 全量
  assert.deepEqual(acts((await get('')).body).length, 5, '★ 不带参数 ⇒ 全部 5 条')
  // 只给 scope
  assert.deepEqual(acts((await get('scope=S')).body), ['A-all', 'A-goal', 'A-scope', 'A-task'], '★ scope 分支')
  // 只给 taskId ⇒ **只看 taskId**，不再按 scope 过滤
  assert.deepEqual(acts((await get('taskId=T1')).body), ['A-task'], '★ taskId 分支')
  // 只给 goalId ⇒ goal 事件
  assert.deepEqual(acts((await get('goalId=G1')).body), ['A-goal'], '★ goalId 分支')
  // ★★★ 两个都给：**goalId 赢**
  assert.deepEqual(acts((await get('goalId=G1&taskId=T1')).body), ['A-goal'],
    '★★★ goalId 与 taskId 同时给 ⇒ 走 **goalId**（顺序即语义）')
  // ★★★ 三个都给：还是 goalId 赢
  assert.deepEqual(acts((await get('goalId=G1&taskId=T1&scope=OTHER')).body), ['A-goal'],
    '★★★ 三个都给 ⇒ 仍是 **goalId** 赢（不是 scope）')
  // ★ taskId 赢过 scope
  assert.deepEqual(acts((await get('taskId=T1&scope=OTHER')).body), ['A-task'],
    '★★★ taskId 与 scope 同时给 ⇒ 走 **taskId**（哪怕 scope 对不上）')
  void all; void byScope; void byTask; void byGoal; void other
})

test('④ ★★★ goalId 分支**还要反查**该目标链任务的事件', async () => {
  reset()
  seedTask('T9', 'G1')
  ev({ scope: 'S', goalId: 'G1', action: 'A-goal' })
  ev({ scope: 'S', taskId: 'T9', action: 'A-task-of-goal' })   // ← 靠反查进来
  ev({ scope: 'S', taskId: 'T8', action: 'A-other-task' })
  const acts = (await get('goalId=G1')).body.map((x) => x.action).sort()
  assert.deepEqual(acts, ['A-goal', 'A-task-of-goal'],
    '★★★ goalId 分支 = `goalId = ?` **或** `taskId ∈ (该目标下的任务)` —— 反查那一半不能少')
})

// ══════════════════════ limit 那个算式 ══════════════════════

const seedN = (n, scope = 'S') => { for (let i = 0; i < n; i++) ev({ scope, action: `A${i}` }) }

test('⑤ ★★★★★ `limit=0` 拿到的是 **50** 条 —— `0 || 50` 里的 `0` 是 falsy', async () => {
  reset(); seedN(60)
  const r = await get('scope=S&limit=0')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 50,
    '★★★★★ `limit=0` **不是**"要 0 条" —— 算式里的 `|| 50` 把 0 当成"没给"')
  // ★ 对照：默认（不给 limit）也是 50
  assert.equal((await get('scope=S')).body.length, 50, '★ 不给 limit 也是 50（同一个默认值）')
})

test('⑥ ★★★★ `limit=abc` / `limit=` 都回落到 50', async () => {
  reset(); seedN(60)
  for (const v of ['abc', '', '%20', 'NaN']) {
    const r = await get(`scope=S&limit=${v}`)
    assert.equal(r.status, 200, `★ limit=${JSON.stringify(v)}`)
    assert.equal(r.body.length, 50, `★★★ limit=${JSON.stringify(v)} ⇒ 50（算式里的 \`NaN || 50\`）`)
  }
})

test('⑦ ★★★★★ `limit=-5` **不会**被夹住 ⇒ 原样进 SQL ⇒ SQLite 的 `LIMIT -5` 是**不限制**', async () => {
  reset(); seedN(60)
  const r = await get('scope=S&limit=-5')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 60,
    '★★★★★ 负数没有下界 ⇒ `Math.min(-5,500) = -5`，而 SQLite 里负的 LIMIT 表示**不限制** '
    + '—— 于是"我只要 5 条"变成了"给我全部"')
})

test('⑧ ★★★ 上界 500 真的夹住了', async () => {
  reset(); seedN(510)
  assert.equal((await get('scope=S&limit=501')).body.length, 500, '★ 501 ⇒ 500')
  assert.equal((await get('scope=S&limit=99999')).body.length, 500, '★ 99999 ⇒ 500（不是 510）')
  assert.equal((await get('scope=S&limit=500')).body.length, 500, '★ 边界 500 本身可以')
})

test('⑨ ★★★★★ `limit=2.7` ⇒ **500** —— 真缺陷（SQLite 不接受浮点 LIMIT），钉住', async () => {
  reset(); seedN(10)
  // ★★★ 这是本片**量出来的一条真缺陷**，不是我的判据写错了：
  //   `Math.min(2.7, 500)` 是 **2.7**（没有取整），而这个值**原样**绑定进
  //   `LIMIT ?` ⇒ SQLite 抛错 ⇒ 整个 `handle()` 的兜底把它变成 **500**。
  //
  //   影响面不止是"少给几条"：**一个查询参数能把只读接口打成 500**。
  //   ★ 只读接口本该是"给什么参数都回 200"，而这里 `limit=2.7` 就崩了。
  //
  //   > 一个「`Math.min(x, 500)` 已经把 limit 夹在合理范围里了」的印象，
  //   > 与一个「它夹的是**上界**，下界和整数性都没管，而 SQLite 会因此抛错」的事实，
  //   > 在我把 `2.7` 真的发一次之前是同一个东西。
  for (const v of ['2.7', '1.5', '0.5']) {
    const r = await get(`scope=S&limit=${encodeURIComponent(v)}`)
    assert.equal(r.status, 500, `★★★★★ limit=${v} ⇒ **500**（浮点进了 LIMIT）`)
    assert.notEqual(r.status, 200, '★★★ 不是"少返回几条"，是**整个请求失败**')
  }
  // ★ 对照：整数就没事（说明只有"非整数值"这一条路坏）
  //   ★ `10.0e0` 也在这一组 —— 它**解析出来就是整数 10**（我第一版把它误放进浮点那组，
  //     判据当场报 `actual: 200`）。"写法像浮点"与"值是浮点"不是一回事。
  for (const v of ['2', '1', '0', '-1', '10.0e0']) {
    assert.equal((await get(`scope=S&limit=${v}`)).status, 200, `★ 整数值 limit=${v} 正常`)
  }
  // ★★ 反自检：算式**确实**没有取整 —— 免得日后有人"修"了算式而判据还钉着 500
  const srv = await import('node:fs').then((m) => m.readFileSync('team-hub/routes/activity.mjs', 'utf8'))
  // ★ 正则要允许参数里**自己带括号**（`get('limit')`）—— 第一版我写 `[^)]*`，
  //   它在 `get(` 的那个 `)` 处就停了，于是永远匹配不上、判据报"缺陷被修了"。
  assert.match(srv, /Math\.min\(Number\(.*?\)\s*\|\|\s*50,\s*500\)/,
    '★★★ 若这条算式被改成取整了，说明缺陷被修了 —— 那时该把上面几条改成断言 200')
})

// ══════════════════════ 排序 ══════════════════════

test('⑩ ★★★ 三条分支按 `seq DESC`（新的在前），**taskId 那条是 `seq` 升序**', async () => {
  reset()
  const s1 = ev({ scope: 'S', action: 'first' })
  const s2 = ev({ scope: 'S', action: 'second' })
  const s3 = ev({ scope: 'S', taskId: 'T1', action: 'third' })
  const d = (await get('scope=S')).body.map((x) => x.seq)
  assert.deepEqual(d, [s3, s2, s1], '★★ scope 分支：新的在前（DESC）')
  assert.deepEqual((await get('')).body.map((x) => x.seq), [s3, s2, s1], '★★ 全量分支也是 DESC')
  assert.deepEqual((await get('goalId=G?')).body, [], '★ goalId 查不到就是空')
  // ★ taskId 分支**升序**（与另外三条相反）
  assert.deepEqual((await get('taskId=T1')).body.map((x) => x.seq), [s3],
    '★ taskId 分支是 `ORDER BY seq`（升序）')
  const t = ev({ scope: 'S', taskId: 'T1', action: 'fourth' })
  assert.deepEqual((await get('taskId=T1')).body.map((x) => x.seq), [s3, t],
    '★★ taskId 分支**升序** —— 与 scope/全量/（goalId 的 DESC）相反，这个不对称是照搬的')
})

test('⑪ ★★ `taskId` 分支**没有 LIMIT**（返回该任务全部事件）', async () => {
  reset(); for (let i = 0; i < 60; i++) ev({ scope: 'S', taskId: 'T1', action: `x${i}` })
  const r = await get('taskId=T1&limit=5')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 60,
    '★★ 即使给了 `limit=5`，taskId 分支也不看它 —— 这条 SQL 里根本没有 LIMIT')
})

test('⑫ ★★ 读不到别的空间的行（scope 分支是等值匹配）', async () => {
  reset()
  ev({ scope: 'A', action: 'inA' })
  ev({ scope: 'B', action: 'inB' })
  assert.deepEqual((await get('scope=A')).body.map((x) => x.action), ['inA'])
  assert.deepEqual((await get('scope=B')).body.map((x) => x.action), ['inB'])
  assert.deepEqual((await get('scope=C')).body, [], '★ 没有的空间 ⇒ 空数组')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createActivityRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  db: { prepare: () => ({ all: () => [] }) },
  auditEvent: (r) => ({ seq: r.seq }),
  ...over,
})

test('⑬ ★★★ dispatch 契约：只认 `GET /api/activity`，`exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/activity')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/activityX')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/activities')), false)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/audit')), false)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/activity')), false, '★ 只认 GET')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), ['GET exact /api/activity'])
  assert.equal(router.id, 'activity')
})

test('⑭ ★★★ 四条 SQL **逐条对得上分支**（用 SQL 文本认，不靠行数）', async () => {
  const seen = []
  const router = stub({
    db: { prepare: (sql) => { seen.push(sql); return { all: () => [] } } },
  })
  const call = (q) => router.routes[0].run({ method: 'GET' }, {}, { url: new URL('http://x/api/activity' + q) })
  await call('?goalId=G1'); await call('?taskId=T1'); await call('?scope=S'); await call('')
  assert.equal(seen.length, 4, '★ 四次请求 ⇒ 四条 SQL')
  assert.match(seen[0], /goalId = \?/, '★★★ 第 1 条是 goalId 分支')
  assert.match(seen[0], /taskId IN \(SELECT id FROM tasks WHERE goalId = \?\)/, '★★★ goalId 分支必须带反查')
  assert.match(seen[1], /taskId = \?/, '★★ 第 2 条是 taskId 分支')
  assert.ok(!/LIMIT/.test(seen[1]), '★★★ taskId 那条**没有 LIMIT**')
  assert.match(seen[2], /scope = \?[\s\S]*LIMIT \?/, '★★ 第 3 条是 scope 分支且带 LIMIT')
  assert.ok(!/WHERE/.test(seen[3]), '★★★ 第 4 条是**全量**，没有 WHERE')
  assert.match(seen[3], /LIMIT \?/)
  // ★ 分支顺序：goalId 分支里出现的顺序必须是 goalId→taskId→scope→全量
  assert.match(seen[0], /ORDER BY seq DESC/, '★ goalId 分支是 DESC')
  assert.match(seen[1], /ORDER BY seq(?! DESC)/, '★★ taskId 分支是**升序**（没有 DESC）')
})

test('⑮ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = { json: () => {}, db: { prepare: () => ({}) }, auditEvent: (r) => r }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createActivityRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})

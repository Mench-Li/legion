// ============================================================================
// PRT-316 切片 47：团队计划的读面 —— 1 条，`exact`
//   GET /api/team-plan?scope=&id=&version=&goalId=
//
// ★★★ 这一族最要紧的语义是**缺席的形状**：一律 **404**（不是 200 带 null）。
//   装配器把 404 翻成 `null`，再由 `sources.mjs` 产出一条**带原因**的 `missing` 候选；
//   若这里回 200 + null，"读到了、它是空的"与"读不到"就分不开了 ——
//   而那正是整个装载器要防的事。
//
// ★★ 第二要紧的是 404 的**文案要说清是哪一种缺席**：
//   没有这个 id、还是没有这个目标下的计划（修复动作不同：建一份计划 vs 把目标接上计划）。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTeamPlanReadRoutes } from './routes/team-plan-read.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-team-plan-read-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (q) => {
  const res = await fetch(base + '/api/team-plan' + (q === undefined ? '' : '?' + q))
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const reset = () => {
  mod.db.prepare('DELETE FROM team_plans').run()
  mod.db.prepare('DELETE FROM audit').run()
}
const planRows = () => mod.db.prepare('SELECT * FROM team_plans ORDER BY scope, id, version').all()

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ 参数校验 ══════════════════════

test('① ★★★ `scope` 必填 —— 缺 / 空白都 400 `MISSING_PARAM`', async () => {
  reset()
  for (const q of ['', 'scope=', 'scope=%20%20', 'id=p1']) {
    const r = await get(q)
    assert.equal(r.status, 400, `★★ q=${JSON.stringify(q)}`)
    assert.equal(r.body.code, 'MISSING_PARAM', '★★★ 代码要可判（不是只有文案）')
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /缺少 scope/)
  }
  assert.equal((await get('scope=default')).status, 404, '★ 给了 scope 就往下走（这里是 404 而不是 400）')
})

test('② ★★★ `version` 必须是 >= 1 的整数 —— 0 / 负 / 小数 / 非数字都 400 `BAD_VERSION`', async () => {
  reset()
  for (const v of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity']) {
    const r = await get('scope=default&version=' + encodeURIComponent(v))
    assert.equal(r.status, 400, `★★ version=${JSON.stringify(v)}`)
    assert.equal(r.body.code, 'BAD_VERSION')
    assert.match(String(r.body.error), /version 必须是 >= 1 的整数/)
  }
  // ★ 空白 / 缺省 ⇒ **当没给**（不是 400）
  for (const q of ['scope=default', 'scope=default&version=', 'scope=default&version=%20']) {
    assert.equal((await get(q)).status, 404, `★ ${JSON.stringify(q)} ⇒ 没给 version，走"最新版"`)
  }
  assert.equal((await get('scope=default&version=1')).status, 404, '★ 1 是合法的（这里只是没有这个计划）')
})

test('③ ★★ 校验顺序：先 scope 后 version', async () => {
  reset()
  const r = await get('version=0')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MISSING_PARAM', '★★ 两个都错时报的是 **scope** 那条')
})

// ══════════════════════ 缺席的形状 ══════════════════════

test('④ ★★★ 读不到一律 **404**，**绝不是 200 带 null**', async () => {
  reset()
  const r = await get('scope=ghost&id=nope')
  assert.equal(r.status, 404, '★★★ 缺席必须是 404')
  assert.notEqual(r.status, 200, '★★★ 200 + null 会让"读到空的"与"读不到"分不开')
  assert.equal(r.body.ok, false)
  assert.ok(!('plan' in r.body), '★★ 404 里不该带 plan 字段')
})

test('⑤ ★★★★★ 404 里**根本没有 `code` 字段** —— 源码写的是一个不存在的键（真缺陷，钉住）', async () => {
  reset()
  const r = await get('scope=ghost&id=nope')
  // ★★★ 这一条是**量出来的真缺陷**，不是我写错了判据：
  //   路由里写 `code: CONTEXT_PLAN_ERRORS.TEAM_PLAN_NOT_FOUND`，
  //   而 `CONTEXT_PLAN_ERRORS` 的键是
  //     PLAN_NOT_FOUND / PLAN_INVALID / PLAN_FROZEN / MANIFEST_NOT_FOUND /
  //     MANIFEST_INVALID / PLAINTEXT_SECRET / SCOPE_UNKNOWN
  //   —— **没有 `TEAM_PLAN_NOT_FOUND` 这个键**，所以取出来是 `undefined`，
  //   而 `JSON.stringify` 会把 undefined 的字段**整个丢掉**。
  //
  //   > 一个「404 里带着 `code: 'TEAM_PLAN_NOT_FOUND'`，装配器照着它翻成
  //   > "有原因的 missing"」的印象，
  //   > 与一个「那个对象上从来没有这个键，于是这一格是**空的**」的事实，
  //   > 在我把 `CONTEXT_PLAN_ERRORS` 的键逐个列出来之前是同一个东西。
  //
  //   ★ 影响面正好是这一族存在的理由：`sources-loader.mjs` 要把 404 翻成
  //     `null` + 带原因的 `missing` 候选，而**机器可判的那一格不见了**。
  //   ★ 已核对：搬之前（e9ae706）与搬之后逐字相同 ⇒ **是搬之前就有的缺陷**，
  //     本片只是把它**原样**搬了过来（对拍要求如此），没有顺手改。
  assert.equal(r.status, 404)
  assert.equal(r.body.code, undefined, '★★★ 实测就是 undefined')
  assert.ok(!('code' in r.body), '★★★ `code` 这一格**不在响应里**（JSON 把 undefined 丢了）')
  assert.equal(r.body.ok, false, '★ 只有 `ok:false` 这一格是可判的')
  assert.match(String(r.body.error), /没有团队计划/, '★ 只剩人读的文案')
  // ★ 仍然要带服务器时间
  assert.equal(typeof r.body.serverTimeMs, 'number', '★ 带服务器时间（判据要用它对齐）')
  assert.ok(Math.abs(Date.now() - r.body.serverTimeMs) < 60_000, '★★ 得是**刚刚**，不能是常量')
  // ★ 反自检：这个键**真的**不在错误枚举里 —— 免得日后有人把判据改松来"修绿"
  const enumKeys = mod.CONTEXT_PLAN_ERRORS ? Object.keys(mod.CONTEXT_PLAN_ERRORS) : null
  if (enumKeys) {
    assert.ok(!enumKeys.includes('TEAM_PLAN_NOT_FOUND'),
      '★★★ 若这个键哪天出现了，说明缺陷被修了 —— 那时该把上面几条改成断言它**存在**')
  }
})

test('⑥ ★★★ 两种缺席的**文案要分开** —— 没有这个 id vs 没有挂在这个目标下的计划', async () => {
  reset()
  const byId = await get('scope=S&id=p1')
  assert.match(String(byId.body.error), /没有团队计划 p1/,
    '★★★ 按 id 找：文案说的是"没有团队计划 <id>"')
  const byGoal = await get('scope=S&goalId=g1')
  assert.match(String(byGoal.body.error), /没有挂在目标 g1 下的团队计划/,
    '★★★ 按目标找：文案说的是"没有挂在目标 <goalId> 下的" —— 两种缺法的**修复动作不同**')
  // ★ 文案要带空间名
  assert.match(String(byId.body.error), /S/, '★ 文案里要说清是哪个空间')
})

test('⑦ ★★ 按 id + version 缺席时，文案带上「的第 N 版」', async () => {
  reset()
  const r = await get('scope=S&id=p1&version=7')
  assert.equal(r.status, 404)
  assert.match(String(r.body.error), /的第 7 版/, '★★ 说了版本就要在文案里体现')
  // ★ 不带 version 时**不该**出现"的第…版"
  const noV = await get('scope=S&id=p1')
  assert.ok(!/的第/.test(String(noV.body.error)), '★★ 没说版本就不要提版本')
})

test('⑧ ★★ 只给 goalId、不给 id 时走"按目标取"那条路', async () => {
  reset()
  // 既没 id 也没 goalId ⇒ 域层返回 null ⇒ 404；文案走 goal 那支
  const r = await get('scope=S')
  assert.equal(r.status, 404)
  assert.match(String(r.body.error), /挂在目标 null 下/, '★★ 两个都没给时，文案仍然走 goal 分支（把实参如实写出）')
})

// ══════════════════════ 真读得到 ══════════════════════

const seed = async (scope, id, version, goalId, extra = {}) => {
  const at = Date.now()
  // ★ 真表结构（第一版我按 `updated_at_ms` + `payload_json` 猜的 —— 都不存在）：
  //   (scope, id, version, goal_id, title, objective, stages_json, note, created_at_ms)
  mod.db.prepare(`INSERT INTO team_plans
    (scope, id, version, goal_id, title, objective, stages_json, note, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, id, version, goalId, extra.title ?? `${id}@v${version}`, extra.objective ?? '',
      JSON.stringify(extra.stages ?? []), extra.note ?? '', at)
}

test('⑨ ★★★ 读得到 ⇒ 200 `{ok:true, plan, serverTimeMs}`，且 `ok` 为真', async () => {
  reset()
  await seed('S', 'p1', 1, 'g1')
  const r = await get('scope=S&id=p1')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true, '★★ 成功路径 `ok` 必须是 true（与 404 的 false 成对）')
  assert.ok(r.body.plan, '★★ 要带 plan')
  assert.equal(typeof r.body.serverTimeMs, 'number')
})

test('⑩ ★★★ 只给 id 时取**最新版**', async () => {
  reset()
  await seed('S', 'p1', 1, null)
  await seed('S', 'p1', 2, null)
  await seed('S', 'p1', 3, null)
  const r = await get('scope=S&id=p1')
  assert.equal(r.status, 200)
  assert.equal(r.body.plan.version, 3, '★★★ 不给 version ⇒ 取最新版（不是第一版）')
})

test('⑪ ★★★ 给了 version 就取**那一版**（哪怕有更新的）', async () => {
  reset()
  await seed('S', 'p1', 1, null); await seed('S', 'p1', 2, null); await seed('S', 'p1', 3, null)
  for (const [v, want] of [[1, 1], [2, 2], [3, 3]]) {
    const r = await get(`scope=S&id=p1&version=${v}`)
    assert.equal(r.status, 200, `v=${v}`)
    assert.equal(r.body.plan.version, want, `★★★ version=${v} 必须取第 ${want} 版`)
  }
  // ★ 不存在的版本 ⇒ 404
  const miss = await get('scope=S&id=p1&version=9')
  assert.equal(miss.status, 404, '★ 版本不存在也是"缺席"')
})

test('⑫ ★★★ 按 goalId 取时**必须取最新版**', async () => {
  reset()
  await seed('S', 'pA', 1, 'g1'); await seed('S', 'pB', 2, 'g1'); await seed('S', 'pC', 3, 'other')
  const r = await get('scope=S&goalId=g1')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.plan.version, 2, '★★★ 目标是 g1 的两版里取最大的那版（v2，不是 v1）')
  assert.equal(r.body.plan.id, 'pB')
})

test('⑬ ★★ 读的只能是自己那个空间的计划（跨空间隔离）', async () => {
  reset()
  await seed('A', 'p1', 1, null)
  await seed('B', 'p1', 1, null, { note: 'B 的' })
  const a = await get('scope=A&id=p1')
  const b = await get('scope=B&id=p1')
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.equal(a.body.plan.scope, 'A', '★★ 空间 A 读到的是 A 的')
  assert.equal(b.body.plan.scope, 'B', '★★ 空间 B 读到的是 B 的')
  assert.notDeepEqual(a.body.plan, b.body.plan, '★★ 两者不能是同一份')
  // ★ 第三个空间读到的是 404
  assert.equal((await get('scope=C&id=p1')).status, 404, '★★ 别人的空间里没有就是没有')
})

test('⑭ ★★ `id` 优先于 `goalId`（两个都给时按 id 走）', async () => {
  reset()
  await seed('S', 'pA', 1, 'g1')
  await seed('S', 'pB', 5, 'g1')          // 目标下的最新版是 pB
  const r = await get('scope=S&id=pA&goalId=g1')
  assert.equal(r.status, 200)
  assert.equal(r.body.plan.id, 'pA', '★★★ 两个都给 ⇒ 按 **id** 走（不是按目标的最新版）')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createTeamPlanReadRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  contextPlanStore: () => ({ readTeamPlan: () => null }),
  CONTEXT_PLAN_ERRORS: { TEAM_PLAN_NOT_FOUND: 'TEAM_PLAN_NOT_FOUND' },
  ...over,
})

test('⑮ ★★★ dispatch 契约：只认 `GET /api/team-plan`，`exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/team-plan')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/team-planX')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/team-plans')), false,
    '★★★ 兄弟 `/api/team-plans`（复数）是**另一族**的，本族不许越界认领')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/team-plan')), false, '★ 只认 GET')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), ['GET exact /api/team-plan'])
  assert.equal(router.id, 'team-plan-read')
})

test('⑯ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, contextPlanStore: () => ({}),
    CONTEXT_PLAN_ERRORS: { TEAM_PLAN_NOT_FOUND: 'x' },
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createTeamPlanReadRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})

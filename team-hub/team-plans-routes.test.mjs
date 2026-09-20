// ============================================================================
// PRT-316 切片 22：`/api/team-plans`（团队计划：读一版 / 冻结一版）
//
// 本族有**两条**路由共用同一个 path（GET 读、POST 写），而既有判据**只有一把**
// （`orchestrator/worker/sources-loader.test.mjs`，58 例、7 个请求点）。
// 破验 17 处里 **8 处没人管**：limit 的两个钳位、`serverTimeMs`、
// 「直接给 body」那种写法、`actor` 落审计、回执的 `idempotent`、
// 以及接缝那条（不 await 写门面）。
//
// ★ 所有形状都是量出来的（`probe22-team-plans.mjs` / `22b` / `22c`）：
//   · 读回执 = `{ok, plans, count, serverTimeMs}`，**plans 里的条目就是计划本身**
//     （没有 `{plan: …}` 外壳）—— 与写回执的 `{ok, plan, idempotent}` 不一样
//   · 有效计划 = `{id: 非空串, version: ≥1 整数, stages: 非空串或 {role} 的数组}`
//   · `actor` 不进计划，而是落进审计的 `member`（`action: 'team-plan.freeze'`）
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const req = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const thePlan = (id, extra) => ({ id, version: 1, title: 'T-' + id, stages: ['coder'], ...extra })
const freeze = (id, scope, extra) => req('POST', '/api/team-plans', { plan: thePlan(id, extra), scope })
const list = (scope, qs = '') => req('GET', `/api/team-plans?scope=${scope}${qs}`)

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-tproutes-'))
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

test('① 读面空范围：`{ok, plans:[], count:0, serverTimeMs}`', async () => {
  const r = await list('tp-empty')
  assert.equal(r.status, 200)
  assert.deepEqual([...r.body.plans], [])
  assert.equal(r.body.count, 0)
  assert.equal(r.body.ok, true)
  assert.equal(typeof r.body.serverTimeMs, 'number',
    '★ `serverTimeMs` 是前端"这份数据多新"的唯一来源，掉了没人会发现')
})

test('② 冻结一版：回执是 `{ok, plan, idempotent:false}`，plan 里带 id/scope/version', async () => {
  const r = await freeze('F1', 'tp-basic')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.idempotent, false, '第一次冻结不是幂等的')
  assert.equal(r.body.plan.id, 'F1')
  assert.equal(r.body.plan.scope, 'tp-basic', '★ 计划必须记住它属于哪个范围')
  assert.equal(r.body.plan.version, 1)
  assert.deepEqual(r.body.plan.stages.map((s) => s.role), ['coder'],
    '★ 字符串形式的 stage 会被归一成 `{role}`')
})

test('③ 同一版再冻结 → `idempotent:true`（调用方靠它分清新写与早已存在）', async () => {
  await freeze('F2', 'tp-idem')
  const again = await freeze('F2', 'tp-idem')
  assert.equal(again.status, 200)
  assert.equal(again.body.idempotent, true,
    '★ 恒为 false 的话，重复提交看起来像每次都在新建 —— 而"冻结"这个词的全部意义就是它不该新建')
  assert.equal(again.body.plan.id, 'F2')
})

test('④ 同 id 换 version：列表里该 id 只留一条、且是新版本', async () => {
  await freeze('F3', 'tp-ver')
  await freeze('F3', 'tp-ver', { version: 2 })
  const r = await list('tp-ver')
  const same = r.body.plans.filter((p) => p.id === 'F3')
  assert.equal(same.length, 1, '★ 一个 id 在列表里出现两次，前端会画成两份计划')
  assert.equal(same[0].version, 2, '留下的是新版本')
})

test('⑤ 两种写法都认：`{plan: …}` 和**直接给 body**', async () => {
  const wrapped = await req('POST', '/api/team-plans', { plan: thePlan('W1'), scope: 'tp-shape' })
  assert.equal(wrapped.status, 200, '裹一层 plan')
  const flat = await req('POST', '/api/team-plans', { id: 'W2', version: 1, stages: ['x'], scope: 'tp-shape' })
  assert.equal(flat.status, 200,
    '★ 直接给 body 也要认 —— 只认 `body.plan` 的话，另一种调用方会拿到 400，而它看起来像"计划不合法"')
  assert.equal(flat.body.plan.id, 'W2')
})

test('⑥ 范围隔离：只读得到自己范围内的计划', async () => {
  await freeze('S1', 'tp-s1')
  await freeze('S2', 'tp-s2')
  assert.deepEqual((await list('tp-s1')).body.plans.map((p) => p.id), ['S1'])
  assert.deepEqual((await list('tp-s2')).body.plans.map((p) => p.id), ['S2'])
  assert.equal((await list('tp-nope')).body.count, 0)
})

test('⑦ ★ 审计里的 `actor`：`actor` → `by` → `null` 三级兜底', async () => {
  const freezeAs = (id, scope, who) =>
    req('POST', '/api/team-plans', { plan: thePlan(id), scope, ...who })
  const memberOf = async (scope, id) => {
    const rows = (await req('GET', '/api/activity?scope=' + scope)).body ?? []
    return rows.find((e) => e.action === 'team-plan.freeze' && e.payload?.id === id)
  }

  // ★ 我先入为主地写了"缺省兜到 by"——量出来是 `null`：
  //   `actor: body.actor ?? body.by ?? null` 里的 `by` 是**调用方给的 `by`**，
  //   不是"缺省叫 by 的那个东西"。*一个"没传就兜到某个默认身份"的判据，
  //   与一个"没传就是没有身份"的事实，在我没分别把三种情况各跑一次的时候是同一个东西。*
  await freezeAs('AC0', 'tp-act0', {})
  assert.equal((await memberOf('tp-act0', 'AC0')).member, null, '两个都没给 → 没有身份')

  await freezeAs('AC1', 'tp-act1', { by: 'general' })
  assert.equal((await memberOf('tp-act1', 'AC1')).member, 'general',
    '★ 只给 `by` 时要兜到它 —— 少了这一层，走 `by` 的调用方在审计里全变成"没有身份"')

  await freezeAs('AC2', 'tp-act2', { actor: 'soldier-7' })
  const e2 = await memberOf('tp-act2', 'AC2')
  assert.equal(e2.member, 'soldier-7', '★ 给了 `actor` 就用它（优先级高于 `by`）')
  assert.equal(e2.taskId, '*', '★ 计划不是任务，审计挂在 `*` 上')
})

test('⑧ `count` 必须等于 `plans.length`（分页的"共几条"）', async () => {
  const r = await list('tp-ver')
  assert.equal(r.body.count, r.body.plans.length)
  assert.ok(r.body.count > 0, '这个范围里本来就有东西，0 == 0 会假绿')
})

test('⑨ ★ limit 的三个边界：默认 100、下钳位 1、上钳位 500', async () => {
  // 观测上钳位必须有 >500 条；501 次 POST 实测约 7.4 秒，是这条断言的全部成本。
  const scope = 'tp-cap'
  for (let i = 0; i < 501; i++) {
    await freeze(`C${String(i).padStart(3, '0')}`, scope)
  }
  const noLimit = await list(scope)
  assert.equal(noLimit.body.count, 100, '★ 不传 limit 时是 100（不是 0、也不该是全量）')

  const capped = await list(scope, '&limit=9999')
  assert.equal(capped.body.count, 500,
    '★ 上钳位 500 —— 没有它，一个 limit=999999 的请求会把整个范围拖出来')

  const atCap = await list(scope, '&limit=500')
  assert.equal(atCap.body.count, 500)

  for (const v of ['0', '-5', 'abc']) {
    assert.equal((await list(scope, `&limit=${encodeURIComponent(v)}`)).body.count, 1,
      `★ limit=${v} 要落到下钳位 1 —— 落到 0 的话调用方会拿到"空列表"，` +
      '而那与"这个范围里没有计划"是**看起来一样**的两种东西')
  }
})

test('⑩ ★ 已知缺陷：`limit=2.7` 返回 500（小数一路走到 SQLite 的 LIMIT）', async () => {
  // 量出来的既有行为，**不是**本片引入的：`Math.min(Math.max(Number('2.7') || 0, 1), 500)` = 2.7，
  // 小数交给 SQLite 的 `LIMIT` 会抛 ⇒ 500。
  //
  // 这里**把现状钉住**而不是假装它是对的：既有的三条边界（默认/下钳位/上钳位）都有人管之后，
  // 只剩"非整数"这一格是空的。钉住它，是为了**将来某次修好它时这条断言会红**，
  // 而不是让一个 500 永久藏在没人走过的那一格后面。
  const r = await list('tp-cap', '&limit=2.7')
  assert.equal(r.status, 500,
    '现状是 500。若这条红了：说明有人把非整数 limit 修成了别的行为 —— ' +
    '请把它改成断言**新行为**，并顺手把 ⑨ 那条边界补上"非整数"这一格。')
})

test('⑪ 只有 GET 与 POST 认这条路径', async () => {
  for (const m of ['PUT', 'DELETE']) {
    assert.equal((await req(m, '/api/team-plans')).status, 404, `${m} 应当 404`)
  }
})

test('⑫ ★★★ 写门面炸了必须**向调用方抛出**，不能变成没人管的 promise', async () => {
  // 与切片 20/21 同一条：happy path 上有没有 `await` 看起来一样，
  // 差别只在 `handleRun` 的 catch 块里那句 `json(...)` 也抛的时候（比如客户端已断开）——
  // 那时没有 await 就是**未处理的 promise**，Node 15+ 默认直接杀掉进程。
  const routes = await import('./routes/team-plans.mjs')
  const built = routes.createTeamPlansRoutes({
    json: () => {},
    contextPlanStore: () => ({ putTeamPlan: () => ({ plan: { id: 'X' }, idempotent: false }) }),
    handleRun: async () => { throw new Error('写门面炸了') },
  })
  await assert.rejects(
    () => built.dispatch({ method: 'POST' }, {}, { path: '/api/team-plans', url: new URL('http://127.0.0.1/api/team-plans') }),
    /写门面炸了/,
    '写门面的异常必须传给调用方，而不是逃逸成未处理的 promise')
})

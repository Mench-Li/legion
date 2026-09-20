// ============================================================================
// PRT-316 切片 38：机器验收与交接（PRT-307）—— 6 条，全 `exact`
//   写面 2：POST validate（验收一条）· POST handoff（交接一条）
//   读面 4：GET validations / handoffs / run-results / run-events
//
// ★★ 这一族的判据也不薄（6 条路径全有判据，40 个请求点，6 套套件）。
//   破验无我方判据时 **12/19，真缺口 7**，与切片 37 是**同一批类别**：
//     · 两条写面**都不结算目标**（副作用，没人看过）
//     · `validate` 的 `actor` 必填没人试过
//     · dispatch 不看方法 / 认领了却回 false / `exact` 退化成 `startsWith` / 缺注入不再 fail closed
//
//   > 一个「这个前缀下的两段都已经搬完了」的印象，
//   > 与一个「两段各自都有 7 条没人看的行，而且**是同一批**」的事实，
//   > 在我把两族的破验结果并排看之前是同一个东西。
//
// ★★★ 本片的**区间上界不是接缝**，而是一条**被明文点名"别搬"**的路由：
//   `POST /api/runtime/run-budget/may-switch-model`（属 run-budget 族）。
//   下面第 ⑥ 组判据就是钉这件事的 —— 包括"本族不许吃掉它"。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntimeVerificationRoutes } from './routes/runtime-verification.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-runtime-verif-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = (p, b) => call('POST', p, b)
const get = (p) => call('GET', p)

mod.db.prepare('INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,hold,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)')
  .run('rv-1', 'rv-1', 'medium', 'todo', 'default', 0, new Date().toISOString(), new Date().toISOString())

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 1. 四条读面的闸门与信封 ─────────────────────────────────────────────
const READS = [
  ['validations', 'validations'], ['handoffs', 'handoffs'],
  ['run-results', 'runResults'], ['run-events', 'events'],
]

test('① ★★★ 四条读面缺 `attemptId` ⇒ 400 `MISSING_PARAM`', async () => {
  for (const [slug] of READS) {
    const r = await get(`/api/runtime/${slug}`)
    assert.equal(r.status, 400, `${slug} 应当 400`)
    assert.equal(r.body.ok, false)
    assert.equal(r.body.code, 'MISSING_PARAM', `★ ${slug}：${JSON.stringify(r.body)}`)
    assert.equal(r.body.error, '缺少 attemptId')
  }
})

test('①b ★★ 四条读面的信封各自不同（键名 + `ok` + `serverTimeMs`）', async () => {
  // ★ 实测的设计事实：**不存在的 attemptId 回 200 带空数组**，不是 404 ——
  //   "这条尝试没有任何验收记录"与"这条尝试不存在"在这里是**同一个答案**。
  for (const [slug, key] of READS) {
    const r = await get(`/api/runtime/${slug}?attemptId=att:nope:1`)
    assert.equal(r.status, 200, `${slug} 应当 200`)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.attemptId, 'att:nope:1')
    assert.deepEqual(r.body[key], [], `★★ ${slug} 的键必须是 \`${key}\`（改名就没人找得到）`)
    assert.equal(typeof r.body.serverTimeMs, 'number')
  }
})

test('② ★★★ `run-events` 有**两个分支**：`counts=1` 给计数，否则给原始事件', async () => {
  const counts = await get('/api/runtime/run-events?attemptId=att:nope:1&counts=1')
  assert.equal(counts.status, 200)
  for (const k of ['byType', 'total', 'unknownTypeCount']) {
    assert.ok(k in counts.body, `★★ counts 分支缺 ${k}`)
  }
  assert.ok(!('events' in counts.body), '★ counts 分支不该同时给 events')
  const raw = await get('/api/runtime/run-events?attemptId=att:nope:1')
  assert.ok(Array.isArray(raw.body.events), '★ 默认分支必须给 events 数组')
  assert.ok(!('byType' in raw.body), '★ 默认分支不该给 byType')
  // ★ `counts` 只认字符串 '1'（不是任何真值）
  const zero = await get('/api/runtime/run-events?attemptId=att:nope:1&counts=0')
  assert.ok(Array.isArray(zero.body.events), "★ 只有 counts=1 才走计数分支 —— '0' 不算")
  // type / limit 两个参数要被吃下
  const typed = await get('/api/runtime/run-events?attemptId=att:nope:1&type=Leased&limit=1')
  assert.equal(typed.status, 200)
  assert.ok(Array.isArray(typed.body.events))
})

test('②b ★★ 带**真** attemptId 也拿得到（读面不挑 attempt 是否存在）', async () => {
  const c = await post('/api/runtime/claim', { workerId: 'w1' })
  const att = c.body.claimed.attemptId
  for (const [slug, key] of READS) {
    const r = await get(`/api/runtime/${slug}?attemptId=${encodeURIComponent(att)}`)
    assert.equal(r.status, 200, `${slug} 应当 200`)
    assert.equal(r.body.attemptId, att)
    if (key !== 'events') assert.ok(Array.isArray(r.body[key]), `${slug} 的 ${key} 应当是数组`)
  }
})

// ── 2. ★★★ 写面的必填参数 ──────────────────────────────────────────────
test('③ ★★★ `validate` / `handoff` 缺 `attemptId`、缺 `actor` 各 ⇒ 400 `MISSING_PARAM`', async () => {
  for (const slug of ['validate', 'handoff']) {
    const noAtt = await post(`/api/runtime/${slug}`, {})
    assert.equal(noAtt.status, 400, `${slug} 空 body 应当 400`)
    assert.equal(noAtt.body.code, 'MISSING_PARAM')
    assert.match(String(noAtt.body.error), /attemptId/)
    // ★★★ M15：这一条既有的 40 个请求点里**没人试过** ——
    //   去掉 `actor: requireString(body,'actor')` 之后，缺 actor 会一路掉到域层、报成别的码。
    const noActor = await post(`/api/runtime/${slug}`, { attemptId: 'att:nope:1' })
    assert.equal(noActor.status, 400, `${slug} 缺 actor 应当 400`)
    assert.equal(noActor.body.code, 'MISSING_PARAM', `★★ ${slug} 缺 actor 必须是 MISSING_PARAM`)
    assert.match(String(noActor.body.error), /actor/, '★★ 必须**明说是 actor**，不能让调用方去猜')
  }
})

// ── 3. ★★★ 两条写面都要结算目标（M8 / M9）────────────────────────────
const mkRouter = (over = {}) => createRuntimeVerificationRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  runStore: {
    recordValidation: () => ({ ok: true, attemptId: 'a1' }),
    handoff: () => ({ ok: true, attemptId: 'a1' }),
    getAttempt: () => ({ taskId: 'rv-goal' }),
    validationsOf: () => [], handoffsOf: () => [], runResultsOf: () => [], runEventCountsOf: () => ({}),
  },
  handleRun: async (req, res, fn) => { res.sent = { code: 200, payload: await fn({ attemptId: 'a1', actor: 'g' }) } },
  requireString: (o, k) => (typeof o[k] === 'string' && o[k].length > 0 ? o[k] : (() => { throw new TypeError(`缺少参数 ${k}`) })()),
  getTask: (id) => { assert.equal(id, 'rv-goal', '★ 必须用这次尝试所属的任务去找作用域'); return { scope: 'sc-8' } },
  settleGoalsOfScope: () => {},
  ...over,
})

test('④ ★★★ `validate` 成功后按该尝试所属任务的作用域结算目标', async () => {
  // ★★★ M8/M9：这两句**整块删掉**，既有的 40 个请求点一条都不会红 ——
  //   因为目标结算只在所有任务都 done 时才可见，而走到那一步要上下文冻结证据。
  const settled = []
  const router = mkRouter({ settleGoalsOfScope: (s) => { settled.push(s) } })
  const res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/runtime/validate', url: new URL('http://x/') }), true)
  assert.deepEqual(settled, ['sc-8'], '★★★ 没有这一条，`validate` 里的结算整句删掉也没人知道')
})

test('④b ★★★ `handoff` 成功后同样要结算目标（而且它写在一个 try 里）', async () => {
  const settled = []
  const router = mkRouter({ settleGoalsOfScope: (s) => { settled.push(s) } })
  const res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/runtime/handoff', url: new URL('http://x/') }), true)
  assert.deepEqual(settled, ['sc-8'], '★★★ `handoff` 那一处同样没人看着')
})

test('④c ★★ 结算失败**不许**把已经成功的验收/交接带崩', async () => {
  // ★ handoff 那处写的是 try/catch —— 目标是"结算尽力而为，别影响主结果"。
  const router = mkRouter({
    getTask: () => { throw new Error('任务不存在') },
    settleGoalsOfScope: () => {},
  })
  const res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/runtime/handoff', url: new URL('http://x/') }), true)
  assert.equal(res.sent.code, 200, '★ 结算炸了不该把这次交接变成失败')
})

// ── 4. ★★★ 接缝契约（M16–M19）──────────────────────────────────────────
test('⑤ ★★★ dispatch 契约：看方法、命中回 true、不命中回 false', async () => {
  const router = mkRouter()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })

  // ★ M16：不看方法的话，GET 到写面也会被接住
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/validate')), false, '★★ `/validate` 只认 POST')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/validations')), false, '★★ `/validations` 只认 GET')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/nope')), false)
  // 命中 ⇒ true（★ M17：回 false 会让外层再答复一次）
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/validate')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/validations')), true)

  // ★★★ M18：`exact` 必须逐字相等 —— 退化成 `startsWith` 之后
  //   本族会把**切片 37 那 9 条**和 **may-switch-model** 一起吃掉：
  //   `/api/runtime/validate` 是 `/api/runtime/validations` 的前缀（反过来也一样有风险），
  //   而更宽的是 `/api/runtime/run-` 家族。
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/validationsX')), false, '★★ 吞掉 /validationsX')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/validateX')), false, '★★ 吞掉 /validateX')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), [
    'POST exact /api/runtime/validate',
    'GET exact /api/runtime/validations',
    'POST exact /api/runtime/handoff',
    'GET exact /api/runtime/handoffs',
    'GET exact /api/runtime/run-results',
    'GET exact /api/runtime/run-events',
  ])
  assert.equal(router.id, 'runtime-verification')
})

test('⑥ ★★★ 本族**不许**吃掉同前缀下的两类东西', async () => {
  const router = mkRouter()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  // ① 切片 37 的运行面 9 条
  for (const [m, p] of [
    ['POST', '/api/runtime/claim'], ['POST', '/api/runtime/heartbeat'], ['POST', '/api/runtime/transition'],
    ['POST', '/api/runtime/release'], ['POST', '/api/runtime/recover'], ['GET', '/api/runtime/status'],
    ['POST', '/api/runtime/fail'], ['GET', '/api/runtime/held'], ['POST', '/api/runtime/resolve'],
  ]) {
    assert.equal(await router.dispatch({ method: m }, {}, ctx(p)), false, `★★★ 本族不许吃掉 ${m} ${p}`)
  }
  // ② ★★★ 那条**被明文点名"别顺手搬走"**的路由（属 run-budget 族）
  assert.equal(
    await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/run-budget/may-switch-model')), false,
    '★★★ may-switch-model 属 run-budget 族，run-budget 的接缝明文警告过别搬 —— 本族也不许吃',
  )
  // ③ 同前缀的其它已知命名空间
  for (const p of ['/api/runtime/run-budget', '/api/runtime/run-budget/reserve', '/api/runtime/run-budget/observe']) {
    assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx(p)), false, `★★ 本族不许吃掉 ${p}`)
  }
})

test('⑥b ★★ 缺注入项 ⇒ **构造时**就抛（fail closed，不是运行时 ReferenceError）', async () => {
  const full = {
    json: () => {}, handleRun: async () => {}, runStore: {}, requireString: () => {},
    getTask: () => {}, settleGoalsOfScope: () => {},
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createRuntimeVerificationRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})

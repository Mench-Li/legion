// ============================================================================
// PRT-316 切片 37：运行面（PRT-302/303/313）—— 9 条，全 `exact`
//   写面 7：claim / heartbeat / transition / release / recover / fail / resolve
//   读面 2：status / held
//
// ★★ 这一族的判据**很厚**：9 条路径全有判据，请求点合计 **74**（7 套套件）。
//   破验说明"厚"不等于"这些行有人看"：23 条变异里 **17** 条已会被咬住，
//   剩下 **6** 条没人看 —— 本文件补的就是这 6 条：
//     · `resolve` 的 `decision` 传个非法值（域层会拒，但**没人试过**）
//     · 一次成功的 transition 之后**目标被结算**（副作用，没人看过）
//     · dispatch 不看方法 / 认领了却回 false / `exact` 退化成 `startsWith` / 缺注入不再 fail closed
//
//   > 一个「这一族有 74 个请求点守着」的印象，
//   > 与一个「它从没把一条 run 走到过 `Completed`」的事实，
//   > 在我没有去看那 74 个请求点**走到哪一步**的时候是同一个东西。
//
// ★★★ M15 的**根因**（探针量出来的）：从 `Running` 再往前走要 `contextSnapshot` 证据
//   （`BuildingContext → Running` 缺证据会回 409 `EVIDENCE_MISSING`），
//   而走完整条路要先冻结上下文 —— 既有的 74 个请求点**没有一条走到底**。
//   所以 `settleGoalsOfScope` 这一段**从来没被观察过**。
//   本文件用**注入 spy** 直接把这条契约钉住（不必真的走到 Completed）。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntimeLeaseRoutes } from './routes/runtime-lease.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-runtime-lease-'))
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
const insertTask = (id, scope = 'default') => mod.db.prepare(
  'INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,hold,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
).run(id, id, 'medium', 'todo', scope, 0, new Date().toISOString(), new Date().toISOString())

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 1. 领取与只读两条 ────────────────────────────────────────────────────
test('① ★★ `claim` 返回 attemptId / leaseEpoch / 服务端算出的到期时间', async () => {
  insertTask('rl-1')
  const r = await post('/api/runtime/claim', { workerId: 'w1' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.claimed.taskId, 'rl-1')
  assert.equal(r.body.claimed.state, 'Leased')
  assert.equal(r.body.claimed.leaseEpoch, 1)
  assert.equal(r.body.claimed.leaseExpiresAtMs > r.body.claimed.serverTimeMs, true,
    '★ 到期时间必须由服务端时钟算出（worker 自己的钟不算数）')
})

test('② ★★★ `status` 的 `ok` 与 13 项 `byState`（少了 `ok` 调用方就分不清真假）', async () => {
  const r = await get('/api/runtime/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true, '★★ M19：少了这个字段，读到的 `byState` 与一次失败的答复长得一样')
  assert.equal(typeof r.body.byState, 'object')
  // 状态机的 13 项必须**一项不少**：少一项 = 那一类尝试在统计里静默消失
  for (const s of ['Queued', 'Leased', 'PreparingWorkspace', 'BuildingContext', 'Running',
    'AwaitingApproval', 'Validating', 'HandingOff', 'Completed', 'RetryableFailure',
    'UnknownOutcome', 'Cancelled', 'DeadLetter']) {
    assert.equal(typeof r.body.byState[s], 'number', `★ byState 缺 ${s}`)
  }
})

test('③ ★★ `held` 的信封与两个查询参数（等人工处置的清单不能静默消失）', async () => {
  const r = await get('/api/runtime/held')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  for (const k of ['serverTimeMs', 'total', 'actionable', 'items']) {
    assert.ok(k in r.body, `★ held 缺 ${k}`)
  }
  assert.ok(Array.isArray(r.body.items))
  // 两个查询参数都要能吃下（`?limit=` 与 `?scope=`）
  const r2 = await get('/api/runtime/held?limit=1&scope=no-such-scope')
  assert.equal(r2.status, 200)
  assert.equal(r2.body.total, 0)
})

// ── 2. 必填参数：`requireString`（M10/M11/M12）──────────────────────────
test('④ ★★★ 五个写面的必填参数各缺一次 ⇒ 400 `MISSING_PARAM`（不是 500）', async () => {
  for (const [label, r] of [
    ['heartbeat 缺 attemptId', await post('/api/runtime/heartbeat', { leaseEpoch: 1 })],
    ['release 缺 attemptId', await post('/api/runtime/release', { leaseEpoch: 1 })],
    ['fail 缺 workerId', await post('/api/runtime/fail', { attemptId: 'x', leaseEpoch: 1 })],
    ['resolve 缺 attemptId', await post('/api/runtime/resolve', { decision: 'cancel', actor: 'g' })],
  ]) {
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.equal(r.body.code, 'MISSING_PARAM', `★★ ${label} 的码：${JSON.stringify(r.body)}`)
    assert.match(String(r.body.error), /缺少参数/)
  }
})

test('④b ★★★ `resolve` 的 `decision`：缺了是 MISSING_PARAM，**值非法是 BAD_DECISION**', async () => {
  // ★★★ M11：这两个是**不同的事实** —— "你没说要怎么办" vs "你说的这个处置我不认识"。
  //   把 `requireString(body,'decision')` 换成 `body.decision`，
  //   缺参就会一路掉到域层、报成 BAD_DECISION，于是调用方以为是自己**拼错了词**。
  const missing = await post('/api/runtime/resolve', { attemptId: 'x', actor: 'g' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'MISSING_PARAM', '★ 缺参必须是 MISSING_PARAM')
  const bad = await post('/api/runtime/resolve', { attemptId: 'x', decision: 'nope', actor: 'g' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'BAD_DECISION', '★ 非法值必须是 BAD_DECISION')
  // 四个合法取值都要被列出来（四个取值对应四个**不同的事实**，缺一不可）
  for (const d of ['external-effect-happened', 'external-effect-absent', 'dead-letter', 'cancel']) {
    assert.ok(String(bad.body.error).includes(d), `★★ 错误里没列出可选值 ${d}`)
  }
  // 缺 actor
  const noActor = await post('/api/runtime/resolve', { attemptId: 'x', decision: 'cancel' })
  assert.equal(noActor.status, 400)
  assert.equal(noActor.body.code, 'MISSING_PARAM')
  assert.match(String(noActor.body.error), /缺少参数 actor/)
})

// ── 3. 两条"不能猜"的闸门（M17）─────────────────────────────────────────
test('⑤ ★★★ `recover` 的 `from` 不能猜：缺 / 空 / 非数组 ⇒ 400 `EXTERNAL_EFFECT_UNKNOWN`', async () => {
  for (const [label, r] of [
    ['缺 from', await post('/api/runtime/recover', {})],
    ['from 空数组', await post('/api/runtime/recover', { from: [] })],
    ['from 非数组', await post('/api/runtime/recover', { from: 'x' })],
  ]) {
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.equal(r.body.code, 'EXTERNAL_EFFECT_UNKNOWN', `★★ ${label}：判成"可重试"会在已发生外部副作用时重复执行`)
    assert.match(String(r.body.error), /不能猜/)
  }
})

test('⑤b ★★ `transition` 指向不存在的尝试 ⇒ 404 `ATTEMPT_NOT_FOUND`（顺序：先找尝试）', async () => {
  // ★ 实测的顺序事实：`to` 的必填校验**在尝试查找之后**，
  //   所以"尝试不存在"优先于"参数不全"报出来。
  const r = await post('/api/runtime/transition', { attemptId: 'att:nope:1', leaseEpoch: 1, workerId: 'w1' })
  assert.equal(r.status, 404)
  assert.equal(r.body.code, 'ATTEMPT_NOT_FOUND')
  assert.match(String(r.body.error), /运行尝试不存在/)
})

// ── 4. ★★★ M15：transition 之后必须结算目标（副作用，没人看过）──────────
test('⑥ ★★★ 一次成功的 `transition` 之后，目标按**该尝试所属任务的作用域**结算', async () => {
  // ★★★ M15：`try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch {}`
  //   整句删掉，既有的 74 个请求点**一条都不会红** ——
  //   因为没有一条 run 走到过 `Completed`（要 `contextSnapshot` 证据），
  //   而目标结算**只在所有任务都 done 时**才有可见后果。
  //   这里用注入的 spy 把这条契约直接钉住。
  const settled = []
  const router = createRuntimeLeaseRoutes({
    json: (res, code, p) => { res.sent = { code, payload: p } },
    runStore: {
      transition: () => ({ ok: true, attempt: { taskId: 'rl-goal' } }),
      heartbeat: () => ({}), claim: () => ({}), release: () => ({}),
      recoverExpired: () => ({}), failAndRetry: () => ({}),
      stats: () => ({}), listHeld: () => ({}), resolveAttempt: () => ({ attempt: { taskId: 'rl-goal' } }),
    },
    handleRun: async (req, res, fn) => { res.sent = { code: 200, payload: await fn({ attemptId: 'a1', leaseEpoch: 1, context: {}, actor: 'g', workerId: 'w' }) } },
    requireString: (o, k) => { const v = o[k]; if (typeof v !== 'string' || v.length === 0) throw new TypeError(`缺少参数 ${k}`); return v },
    getTask: (id) => { assert.equal(id, 'rl-goal', '★ 必须用**这次尝试所属的任务**去找作用域'); return { scope: 'sc-9' } },
    settleGoalsOfScope: (scope) => { settled.push(scope) },
    recordRunEventsBestEffort: () => ({ written: 1 }),
  })
  const res = {}
  const ok = await router.dispatch({ method: 'POST' }, res, { path: '/api/runtime/transition', url: new URL('http://x/') })
  assert.equal(ok, true)
  assert.deepEqual(settled, ['sc-9'],
    '★★★ 没有这一条，`settleGoalsOfScope` 整句删掉也没人知道 —— 目标会**永远停在 active**')
})

test('⑥b ★★ `transition` 与 `fail` 都要把 `runEvents` 带回回执里', async () => {
  // ★ M13/M14：既有的判据会咬住这两条（破验已证明），这里钉住**形状**
  const STORE = {
    transition: () => ({ ok: true, attempt: { taskId: 't' } }),
    failAndRetry: () => ({ ok: true, attempt: { taskId: 't' }, action: 'retry-new-attempt' }),
    heartbeat: () => ({}), claim: () => ({}), release: () => ({}), recoverExpired: () => ({}),
    stats: () => ({}), listHeld: () => ({}), resolveAttempt: () => ({ attempt: { taskId: 't' } }),
  }
  const mk = () => createRuntimeLeaseRoutes({
    json: (res, code, p) => { res.sent = { code, payload: p } },
    runStore: STORE,
    handleRun: async (req, res, fn) => { res.sent = { code: 200, payload: await fn({ attemptId: 'a1', leaseEpoch: 1, context: {}, actor: 'g', workerId: 'w' }) } },
    requireString: (o, k) => (typeof o[k] === 'string' && o[k].length > 0 ? o[k] : (() => { throw new TypeError(`缺少参数 ${k}`) })()),
    getTask: () => ({ scope: 's' }),
    settleGoalsOfScope: () => {},
    recordRunEventsBestEffort: () => ({ written: 2 }),
  })
  const t = {}
  await mk().dispatch({ method: 'POST' }, t, { path: '/api/runtime/transition', url: new URL('http://x/') })
  assert.deepEqual(t.sent.payload.runEvents, { written: 2 }, '★★ transition 的回执少了 `runEvents`')
  const f = {}
  await mk().dispatch({ method: 'POST' }, f, { path: '/api/runtime/fail', url: new URL('http://x/') })
  assert.deepEqual(f.sent.payload.runEvents, { written: 2 }, '★★ fail 的回执少了 `runEvents`')
})

// ── 5. ★★★ 接缝契约（M21/M22/M23/M24）──────────────────────────────────
const stubRouter = (over = {}) => createRuntimeLeaseRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  runStore: {
    stats: () => ({ byState: { Leased: 1 } }), listHeld: () => ({ total: 0, actionable: 0, items: [] }),
    claim: () => ({ taskId: 't' }), heartbeat: () => ({}), transition: () => ({ attempt: { taskId: 't' } }),
    release: () => ({}), recoverExpired: () => ({}), failAndRetry: () => ({ attempt: { taskId: 't' } }),
    resolveAttempt: () => ({ attempt: { taskId: 't' } }),
  },
  handleRun: async (req, res, fn) => { res.sent = { code: 200, payload: await fn({ attemptId: 'a1', leaseEpoch: 1, context: {}, actor: 'g', workerId: 'w' }) } },
  requireString: (o, k) => (typeof o[k] === 'string' && o[k].length > 0 ? o[k] : (() => { throw new TypeError(`缺少参数 ${k}`) })()),
  getTask: () => ({ scope: 's' }),
  settleGoalsOfScope: () => {},
  recordRunEventsBestEffort: () => ({}),
  ...over,
})

test('⑦ ★★★ dispatch 契约：看方法、命中回 true、不命中回 false', async () => {
  const router = stubRouter()
  const ctx = (path) => ({ path, url: new URL('http://x' + path) })

  // ★ M21：不看方法的话，POST 到只读的 `/status` 也会被接住
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/status')), false,
    '★★ `/status` 只认 GET —— 不看方法就会被 POST 接住')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/claim')), false,
    '★★ `/claim` 只认 POST')
  // 不命中
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/nope')), false)
  // 命中 ⇒ true（★ M22：回 false 会让外层再答复一次）
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/status')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/claim')), true)

  // ★★★ M23：`exact` 必须**逐字相等**。
  //   退化成 `startsWith` 之后 `/api/runtime/statusX`、`/api/runtime/claim-anything`
  //   都会被这九条里的某一条吃掉 —— 而它们分别属于**切片 38 的那一段**。
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/runtime/statusX')), false,
    '★★ `exact` 退化成 `startsWith` 就会吞掉 `/statusX`')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/claimX')), false,
    '★★ 同上：`/claimX`')
  // ★ 同前缀的第二段（切片 38 那 7 条）**一条都不许**被本族吃掉
  for (const p of ['/api/runtime/validate', '/api/runtime/validations', '/api/runtime/handoff',
    '/api/runtime/handoffs', '/api/runtime/run-results', '/api/runtime/run-events',
    '/api/runtime/run-budget/may-switch-model']) {
    assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx(p)), false, `★★★ 本族不许吃掉 ${p}`)
  }

  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), [
    'POST exact /api/runtime/claim', 'POST exact /api/runtime/heartbeat', 'POST exact /api/runtime/transition',
    'POST exact /api/runtime/release', 'POST exact /api/runtime/recover', 'GET exact /api/runtime/status',
    'POST exact /api/runtime/fail', 'GET exact /api/runtime/held', 'POST exact /api/runtime/resolve',
  ])
  assert.equal(router.id, 'runtime-lease')
})

test('⑦b ★★ 缺注入项 ⇒ **构造时**就抛（fail closed，不是运行时 ReferenceError）', async () => {
  // ★ M24：`if (false) throw` 之后，少给一个注入项会变成运行时的
  //   `undefined is not a function`（或者更糟：静默走另一条分支）。
  const full = {
    json: () => {}, handleRun: async () => {}, runStore: {}, requireString: () => {},
    getTask: () => {}, settleGoalsOfScope: () => {}, recordRunEventsBestEffort: () => {},
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createRuntimeLeaseRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})

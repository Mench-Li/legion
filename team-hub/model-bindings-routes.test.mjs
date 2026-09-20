// ============================================================================
// PRT-316 切片 35：岗位模型绑定与 fallback（3 条，全 `exact`）
//   `GET /api/model-bindings` · `POST /api/model-bindings` · `GET /api/model-bindings/resolve`
//
// ★★ 与切片 34 **正好相反**：这一族的判据本来就很厚 —— survey 量出
//   `/api/model-bindings` 有 **2 套 / 24 个请求点**、`/api/model-bindings/resolve`
//   有 **1 套 / 9 个请求点**（都在 `binding-routes.test.mjs`）。
//   所以本片要问的不是"有没有人在看"，而是"**看的是不是这些**"。
//   破验答了：24 条变异里 **16 条**已经会被咬住，剩下 **8 条**没人看 ——
//   本文件补的就是这 8 条。
//
//   > 一个"这一族有两套判据守着、很稳"的印象，
//   > 与一个"其中**两道缺参闸门**、**两个默认值**、**一个 ok 字段**、
//   > 一条 dispatch 契约没有任何一条用例在看"的事实，
//   > 在我没有把这一族逐条改坏一次、看谁变红的时候是同一个东西。
//
// 夹具：临时库 + 真实 listen(0)；绑定表由仓储**懒建**，所以先写一次再看。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModelBindingsRoutes } from './routes/model-bindings.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-mbroutes-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m,
    headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text()
  let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)
const BIND = 'employee_model_bindings'
const rows = () => mod.db.prepare(`SELECT * FROM ${BIND} ORDER BY scope, employee_role`).all()

// 造一个能解析的主档案（`primaryProfile` 在**写入时**就要能解析）
for (const c of mod.db.prepare('PRAGMA table_info(model_profiles)').all()) { /* 读列名 */ }
{
  const cols = mod.db.prepare('PRAGMA table_info(model_profiles)').all()
  const want = { id: 'prof-a', display_name: '档案甲', runtime_type: 'http', provider: 'openai', model: 'm-1', created_at_ms: 1, updated_at_ms: 1 }
  const use = cols.map((c) => c.name).filter((n) => n in want)
  mod.db.prepare(`INSERT OR REPLACE INTO model_profiles (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`)
    .run(...use.map((n) => want[n]))
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 1. 列清单 ────────────────────────────────────────────────────────────
test('① ★★ `GET /api/model-bindings`：`ok: true` + `bindings` 是数组', async () => {
  const r = await get('/api/model-bindings')
  assert.equal(r.status, 200)
  // ★ M5 缺口：这一族的既有 24 个请求点里，**没有一个**看这个 `ok`
  assert.equal(r.body.ok, true, '★ 把 ok 改成 false，24 个请求点里没有一个会红')
  assert.ok(Array.isArray(r.body.bindings), '★ 形状必须是 bindings 而不是裸数组')
  assert.equal(typeof r.body.serverTimeMs, 'number')
})

test('①b ★★ 列表认 `scope`：给了就只回那个空间的', async () => {
  await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'r1', primaryProfile: 'prof-a', actor: 'general' })
  await post('/api/model-bindings', { scope: 'sc-b', employeeRole: 'r1', primaryProfile: 'prof-a', actor: 'general' })
  const a = await get('/api/model-bindings?scope=sc-a')
  assert.equal(a.body.bindings.length, 1)
  assert.equal(a.body.bindings[0].scope, 'sc-a')
  const b = await get('/api/model-bindings?scope=sc-b')
  assert.equal(b.body.bindings[0].scope, 'sc-b')
  // ★ 不给 scope = 全量（不是空）
  const all = await get('/api/model-bindings')
  assert.ok(all.body.bindings.length >= 2, '★ 不给 scope 时不该按空串过滤')
})

// ── 2. 写入 ──────────────────────────────────────────────────────────────
test('② ★★★ `POST` 缺 `actor` ⇒ 400 ACTOR_REQUIRED（谁改的必须留痕）', async () => {
  const r = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'noactor', primaryProfile: 'prof-a' })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'ACTOR_REQUIRED', '★ 去掉 handleRun 的那道闸，改绑定就没有留痕了')
  assert.match(String(r.body.error), /actor/)
})

test('②b ★★★ 两个字段的**默认值**：`fallbackProfiles` ⇒ `[]`，`perRunBudget` ⇒ `null`', async () => {
  // ★★ M7 / M8 缺口：既有的 24 个请求点里没有一个在看不给这两个字段时落下来的是什么
  const r = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'defaults', primaryProfile: 'prof-a', actor: 'general' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.binding.fallbackProfiles, [], '★★ 去掉 `?? []` 的话这里是 undefined，而库列是 JSON 文本')
  assert.equal(r.body.binding.perRunBudget, null, '★★ 去掉 `?? null` 的话这里会变成 undefined')

  const row = rows().find((x) => x.employee_role === 'defaults')
  assert.equal(row.fallback_profiles_json, '[]', '★★ 库里必须是字符串 "[]"，不是 null/undefined')
  assert.equal(row.per_run_budget_json, null)
  // ★ 仓储还额外回两个"读不出来"的标志位 —— 它们是**默认值 vs 坏数据**的区分手段
  assert.equal(r.body.binding.fallbackProfilesUnreadable, false)
  assert.equal(r.body.binding.perRunBudgetUnreadable, false)
})

test('②c ★★★ `perRunBudget` 要的是**对象**，且**只接受三个字段**（拼错的字段被拒，不是被忽略）', async () => {
  const bad = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'budget', primaryProfile: 'prof-a', perRunBudget: 5, actor: 'general' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'BUDGET_INVALID')
  // ★★ 这一条是我**先写成 `{ maxUsd: 5 }` 才发现的**：本字段的判据不是"是不是对象"，
  //   而是"**只接受 maxCost / maxTokens / currency**"。`maxUsd` 这种"看起来很像"的拼法
  //   被**明确拒绝**，而不是忽略 —— 因为"拼错的字段被忽略"等于"没有上限"，
  //   那是一次**静默失去预算保护**的写入。
  //   > 一个「给个像样的对象就行」的印象，
  //   > 与一个「字段名拼错会被拒、因为忽略它等于没有上限」的事实，
  //   > 在我没有试过一个**看起来很像**的字段名之前是同一个东西。
  const typo = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'budget', primaryProfile: 'prof-a', perRunBudget: { maxUsd: 5 }, actor: 'general' })
  assert.equal(typo.status, 400, '★★ 拼错的字段必须**拒绝**，忽略它等于没有上限')
  assert.equal(typo.body.code, 'BUDGET_INVALID')
  assert.match(String(typo.body.error), /maxCost/)
  // ★★★ 第二条也是**我先写错才发现的**：`maxCost` **必须与 `currency` 一起给** ——
  //   「金额脱离币种不构成上限」。只给金额会被**拒**，因为"5"到底是多少钱没人知道。
  //   > 一个「给了上限字段就等于设了上限」的印象，
  //   > 与一个「没有币种的金额**不构成上限**、所以被拒」的事实，
  //   > 在我没有分开试过"只给金额"和"金额+币种"之前是同一个东西。
  const noCurrency = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'budget', primaryProfile: 'prof-a', perRunBudget: { maxCost: 5 }, actor: 'general' })
  assert.equal(noCurrency.status, 400, '★★ 没有币种的金额不构成上限，必须拒')
  assert.equal(noCurrency.body.code, 'BUDGET_INVALID')
  assert.match(String(noCurrency.body.error), /currency/)
  const ok = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'budget', primaryProfile: 'prof-a', perRunBudget: { maxCost: 5, currency: 'USD' }, actor: 'general' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(ok.body.binding.perRunBudget, { maxCost: 5, currency: 'USD' })
})

test('②d ★★ 回执键名是 `binding`（不是裸对象）', async () => {
  const r = await post('/api/model-bindings', { scope: 'sc-a', employeeRole: 'shape', primaryProfile: 'prof-a', actor: 'general' })
  assert.deepEqual(Object.keys(r.body).sort(), ['binding', 'ok'])
  assert.equal(r.body.ok, true)
  assert.equal(r.body.binding.employeeRole, 'shape', '★★ 把 employeeRole 读成 body.role 的话这里是 undefined')
  assert.equal(r.body.binding.primaryProfile, 'prof-a')
})

// ── 3. resolve 的两道闸门（M12 / M14 / M15 / M16）────────────────────────
test('③ ★★★ resolve：缺 scope / scope 空串 / scope 全空白 ⇒ 400 **MISSING_PARAM**', async () => {
  // ★ 这三种在既有 9 个请求点里**一个都没被走过**
  for (const [label, q] of [['完全不给', ''], ['空串', '?scope=&role=coder'], ['全空白', '?scope=%20%20&role=coder']]) {
    const r = await get('/api/model-bindings/resolve' + q)
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.equal(r.body.code, 'MISSING_PARAM', `★★ ${label} 的码必须是 MISSING_PARAM`)
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /scope/)
  }
  // ★★ 去掉 `|| scope.trim() === ''` 那半边（只判 null），后两种会掉进仓储、逃成 500
  const blank = await get('/api/model-bindings/resolve?scope=%20%20&role=coder')
  assert.equal(blank.status, 400, '★★ 只判 `=== null` 的话，全空白会漏过去（仓储抛 ROLE_REQUIRED ⇒ 500）')
})

test('③b ★★★ resolve：有 scope 但 role 缺/空/全空白 ⇒ 400 **ROLE_REQUIRED**', async () => {
  for (const [label, q] of [['缺 role', '?scope=sc-a'], ['空串', '?scope=sc-a&role='], ['全空白', '?scope=sc-a&role=%20%20']]) {
    const r = await get('/api/model-bindings/resolve' + q)
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.equal(r.body.code, 'ROLE_REQUIRED', `★★ ${label} 的码必须是 ROLE_REQUIRED，不是 MISSING_PARAM`)
    assert.match(String(r.body.error), /role/)
  }
})

test('③c ★★★ 两个码**不许对调**（scope 缺 ⇒ MISSING_PARAM，role 缺 ⇒ ROLE_REQUIRED）', async () => {
  const noScope = await get('/api/model-bindings/resolve?role=coder')
  const noRole = await get('/api/model-bindings/resolve?scope=sc-a')
  assert.equal(noScope.body.code, 'MISSING_PARAM')
  assert.equal(noRole.body.code, 'ROLE_REQUIRED')
  assert.notEqual(noScope.body.code, noRole.body.code, '★★ 两个码对调的话，调用方就分不清该补哪一个参数')
  // ★ 两条的 `error` 文案也要各自指向**自己**那个参数
  assert.match(String(noScope.body.error), /scope/)
  assert.match(String(noRole.body.error), /role/)
})

// ── 4. resolve 的 200 / 404 ──────────────────────────────────────────────
test('④ ★★★ resolve：绑定不存在 ⇒ 404 BINDING_NOT_FOUND（**不是** 200 带空链）', async () => {
  const r = await get('/api/model-bindings/resolve?scope=nope&role=nope')
  assert.equal(r.status, 404, '★★ 换成 200 的话，调用方会把"没有绑定"读成"链是空的"')
  assert.equal(r.body.code, 'BINDING_NOT_FOUND')
  assert.equal(r.body.ok, false)
  assert.ok(!('resolution' in r.body))
})

test('④b ★★★ resolve：存在 ⇒ 200，且回的是 `resolution`（链里主档案在第一位）', async () => {
  await post('/api/model-bindings', { scope: 'sc-r', employeeRole: 'coder', primaryProfile: 'prof-a', fallbackProfiles: [], actor: 'general' })
  const r = await get('/api/model-bindings/resolve?scope=sc-r&role=coder')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.ok('resolution' in r.body, '★ 回的是 `resolution`，不是裸对象')
  const res = r.body.resolution
  assert.equal(res.ok, true)
  assert.equal(res.employeeRole, 'coder', '★★ 把 scope/role 传反的话这里会是空间名')
  assert.ok(Array.isArray(res.chain))
  assert.equal(res.chain[0].role, 'primary', '★ 链首是主档案')
  assert.equal(res.chain[0].id, 'prof-a')
  assert.equal(typeof r.body.serverTimeMs, 'number')
})

// ── 5. 同名不同法的**块内**邻居（本片不搬，但必须没被抢走）──────────────
test('⑤ ★★★ `/api/model-bindings/<scope>/<role>` 那两条仍在原处工作（本片只搬扁平 3 条）', async () => {
  // ★ 块内那条是 `path.startsWith('/api/model-bindings/')`，而 `/resolve` **也**满足它 ——
  //   所以顺序是契约：本族的 dispatch 必须排在块内守卫**之前**。
  const one = await get('/api/model-bindings/sc-r/coder')
  assert.equal(one.status, 200, '★ 块内那条被本族抢走的话这里不会是 200')
  assert.equal(one.body.binding.employeeRole, 'coder')
  const missing = await get('/api/model-bindings/sc-r/nope')
  assert.equal(missing.status, 404)
  const badShape = await get('/api/model-bindings/sc-r')
  assert.equal(badShape.status, 400, '★ 段数不对要走块内那条的 MISSING_PARAM')
})

// ── 6. 接缝契约 ──────────────────────────────────────────────────────────
test('⑥ ★★★ dispatch 契约：命中 ⇒ 恰好一次并回 true；不命中 ⇒ false', async () => {
  const ran = []
  const json = (res, code, payload) => { res.sent = { code, payload } }
  const router = createModelBindingsRoutes({
    json,
    bindingStore: { list: () => { ran.push('list'); return [] }, upsert: () => ({}), resolve: () => ({ ok: true }) },
    handleRun: async (req, res, run) => { ran.push('handleRun'); res.sent = { code: 200, payload: await run({}, 'general') } },
    BINDING_STORE_ERRORS: { BINDING_NOT_FOUND: 'BINDING_NOT_FOUND' },
  })

  // 不命中
  let res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, { path: '/api/nope', url: new URL('http://x/nope') }), false)
  assert.equal(ran.length, 0)

  // ★★ 方法不符必须 false：`/api/model-bindings` 同时挂着 GET 与 POST
  res = {}
  assert.equal(await router.dispatch({ method: 'DELETE' }, res, { path: '/api/model-bindings', url: new URL('http://x/api/model-bindings') }), false,
    '★ 不看方法的话，DELETE 会被这一族接住')
  assert.equal(ran.length, 0)

  // 命中 ⇒ 恰好一次、回 true
  res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, { path: '/api/model-bindings', url: new URL('http://x/api/model-bindings') }), true)
  assert.deepEqual(ran, ['list'], '★★ 回 false 会让外层再答复一次（双写响应头）')

  // POST 走 handleRun
  ran.length = 0
  res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/model-bindings', url: new URL('http://x/api/model-bindings') }), true)
  assert.deepEqual(ran, ['handleRun'])

  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), [
    'GET exact /api/model-bindings',
    'POST exact /api/model-bindings',
    'GET exact /api/model-bindings/resolve',
  ])
  assert.equal(router.id, 'model-bindings')
})

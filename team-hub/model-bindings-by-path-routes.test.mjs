// ============================================================================
// PRT-316 切片 36：岗位模型绑定（按路径读/删）—— 2 条，全 `prefix`
//   `GET /api/model-bindings/<scope>/<role>` · `DELETE /api/model-bindings/<scope>/<role>`
//
// ★★ 这一族的判据**本来就很厚**（`/api/model-bindings/` 有 2 套 / 25 个请求点）。
//   破验说明"厚"不等于"这些行有人看"：19 条变异里 **16** 条已会被咬住，
//   剩下 **3** 条没人看 —— 本文件补的就是这 3 条：
//     · 坏 URL 编码（两个方法**都**不拦）
//     · 坏编码与"段数不对"**合流**（两种错给同一个码）
//     · dispatch 认领了却回 `false`
//
//   > 一个「这一族有 25 个请求点守着」的印象，
//   > 与一个「它从没试过一次**坏编码**」的事实，
//   > 在我没有去看那 25 个请求点**请求的都是什么 URL** 的时候是同一个东西。
//
// ★★★ 本族是**第一族带块前言**的：源文件里那层
//   `if (path.startsWith('/api/model-bindings/')) {` 里声明了共享局部
//   `BINDING_PREFIX` 与 `parts()`，两条路由都在用。生成器为此修了两处
//   （`proAllowed` 是死代码；`declared` 把嵌套作用域摊平了），见证据文档 §3、§5。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModelBindingsByPathRoutes } from './routes/model-bindings-by-path.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-mbpath-'))
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
const del = (p, b) => call('DELETE', p, b)
const BIND = 'employee_model_bindings'
const rows = () => mod.db.prepare(`SELECT * FROM ${BIND}`).all()

// 造一个能解析的主档案（写入时会验主档案能否解析）
{
  const cols = mod.db.prepare('PRAGMA table_info(model_profiles)').all()
  const want = { id: 'prof-a', display_name: '甲', runtime_type: 'http', provider: 'openai', model: 'm-1', created_at_ms: 1, updated_at_ms: 1 }
  const use = cols.map((c) => c.name).filter((n) => n in want)
  mod.db.prepare(`INSERT OR REPLACE INTO model_profiles (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`)
    .run(...use.map((n) => want[n]))
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 1. 读 ────────────────────────────────────────────────────────────────
test('① ★★ `GET /api/model-bindings/<scope>/<role>` 读一个绑定', async () => {
  await call('POST', '/api/model-bindings', { scope: 'p-a', employeeRole: 'coder', primaryProfile: 'prof-a', actor: 'general' })
  const r = await get('/api/model-bindings/p-a/coder')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  // ★ M16 缺口：回执键名是 `binding`
  assert.equal(r.body.binding.scope, 'p-a')
  assert.equal(r.body.binding.employeeRole, 'coder', '★★ `get` 两个参数传反的话这里会是 scope')
  assert.equal(r.body.binding.primaryProfile, 'prof-a')
  assert.equal(typeof r.body.serverTimeMs, 'number')
})

test('①b ★★ 绑定不存在 ⇒ 404 BINDING_NOT_FOUND（不是 200 带 null）', async () => {
  const r = await get('/api/model-bindings/p-a/nope')
  assert.equal(r.status, 404)
  assert.equal(r.body.code, 'BINDING_NOT_FOUND')
  assert.equal(r.body.ok, false)
  assert.ok(!('binding' in r.body))
  assert.match(String(r.body.error), /p-a\/nope/)
})

// ── 2. ★★★ 坏编码（M8 / M10 缺口）──────────────────────────────────────
test('② ★★★ 坏 URL 编码 ⇒ 400 **BAD_ID_ENCODING** —— 两个方法都要拦', async () => {
  // ★★★ 这就是 M10：既有的 25 个请求点里**一次坏编码都没试过**
  for (const [label, r] of [
    ['GET scope 段', await get('/api/model-bindings/%zz/coder')],
    ['GET role 段', await get('/api/model-bindings/p-a/%zz')],
    ['DELETE scope 段', await del('/api/model-bindings/%zz/coder', { actor: 'general' })],
    ['DELETE role 段', await del('/api/model-bindings/p-a/%zz', { actor: 'general' })],
  ]) {
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.equal(r.body.code, 'BAD_ID_ENCODING', `★★ ${label} 的码必须是 BAD_ID_ENCODING`)
    assert.equal(r.body.ok, false)
  }
})

test('②b ★★★ 坏编码与"段数不对"**不许合流**（两种错给两个码）', async () => {
  // ★★ 这就是 M8：把 `return 'BAD_ENCODING'` 改成 `return null` 之后，
  //   "编码坏了"会被报成"路径形状不对" —— 调用方会去改路径，而真正该改的是编码。
  const badEnc = await get('/api/model-bindings/%zz/coder')
  const badShape = await get('/api/model-bindings/only-one')
  assert.equal(badEnc.body.code, 'BAD_ID_ENCODING')
  assert.equal(badShape.body.code, 'MISSING_PARAM')
  assert.notEqual(badEnc.body.code, badShape.body.code, '★★ 两种错必须给两个不同的码')
  assert.match(String(badEnc.body.error), /编码/)
  assert.match(String(badShape.body.error), /scope.*role/)
})

// ── 3. 段数（M6 / M11 缺口）─────────────────────────────────────────────
test('③ ★★★ 段数不是 2 ⇒ 400 MISSING_PARAM（空 / 一段 / 三段）', async () => {
  for (const [label, p] of [['空（0 段）', '/api/model-bindings/'], ['一段', '/api/model-bindings/a'], ['三段', '/api/model-bindings/a/b/c']]) {
    const r = await get(p)
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.equal(r.body.code, 'MISSING_PARAM', `★★ ${label} 没被段数校验拦住`)
    assert.match(String(r.body.error), /<scope>\/<role>/)
  }
  // ★ 删除侧同一道闸
  const d = await del('/api/model-bindings/a', { actor: 'general' })
  assert.equal(d.status, 400)
  assert.equal(d.body.code, 'MISSING_PARAM')
})

test('③b ★★ 两段是**各自单独**解码的（scope 里的 `%20` 解成空格）', async () => {
  // ★ 单段解码：`%20` 只在它自己那一段里解，不会把 scope 里的 `/` 也解出来
  const r = await get('/api/model-bindings/p%20a/coder')
  assert.equal(r.status, 404, '形状对、绑定不存在 ⇒ 应当是 404 而不是 400')
  assert.equal(r.body.code, 'BINDING_NOT_FOUND')
  assert.match(String(r.body.error), /p a\/coder/, '★★ 没解码的话这里会是 `p%20a/coder`')
})

// ── 4. ★★★ 两个族共享一个命名空间：顺序即契约 ──────────────────────────
test('④ ★★★ `/resolve` 归扁平族；`/resolve/<x>` 归本族（两族的边界）', async () => {
  // ★ `/api/model-bindings/resolve` 同时满足本族的 `prefix` 前缀，
  //   所以**扁平族必须排在前面**。这条判据同时守着那个装配顺序。
  const exact = await get('/api/model-bindings/resolve?scope=p-a&role=coder')
  assert.equal(exact.status, 200, '★ 顺序反了的话 /resolve 会被本族当成 scope=resolve')
  assert.ok('resolution' in exact.body, '★ 必须走扁平族的 resolve 分支')
  // ★ 而 `/resolve/<x>` **不是** `/resolve`：它会落到本族，被当成 scope=`resolve`
  const twoSeg = await get('/api/model-bindings/resolve/coder')
  assert.equal(twoSeg.status, 404, '★ 三段路径应当落到本族的 <scope>/<role>')
  assert.equal(twoSeg.body.code, 'BINDING_NOT_FOUND')
  assert.match(String(twoSeg.body.error), /resolve\/coder/, '★ 它把 resolve 当成了 scope —— 这是**实测**的边界，不是猜的')
  // ★ 扁平族的列表也必须没被本族抢走
  const list = await get('/api/model-bindings')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body.bindings))
})

// ── 5. 删除 ──────────────────────────────────────────────────────────────
test('⑤ ★★★ `DELETE` 的回执是 `{deleted:true}`（与 GET 的信封**不同**），且真的删掉', async () => {
  await call('POST', '/api/model-bindings', { scope: 'p-d', employeeRole: 'coder', primaryProfile: 'prof-a', actor: 'general' })
  assert.equal(rows().filter((r) => r.scope === 'p-d').length, 1)
  const r = await del('/api/model-bindings/p-d/coder', { actor: 'general' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  // ★ GET 回 `{binding}`；DELETE 回的是**另一套**字段 —— 这一族两个方法的信封不一样
  assert.deepEqual(Object.keys(r.body).sort(), ['deleted', 'employeeRole', 'ok', 'scope'])
  assert.equal(r.body.deleted, true)
  assert.equal(r.body.scope, 'p-d')
  assert.equal(r.body.employeeRole, 'coder')
  assert.equal(rows().filter((r2) => r2.scope === 'p-d').length, 0, '★★ 回执说删了，库里就得真没了')
  // 删完再读
  const again = await get('/api/model-bindings/p-d/coder')
  assert.equal(again.status, 404)
})

test('⑤b ★★ `DELETE` 也要 `actor`（谁删的必须留痕）', async () => {
  await call('POST', '/api/model-bindings', { scope: 'p-e', employeeRole: 'coder', primaryProfile: 'prof-a', actor: 'general' })
  const r = await del('/api/model-bindings/p-e/coder', {})
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'ACTOR_REQUIRED', '★★ 去掉 handleRun 那道闸，删绑定就没有留痕了')
  assert.equal(rows().filter((x) => x.scope === 'p-e').length, 1, '★ 被拒的删除不许真的删掉')
})

// ── 6. 接缝契约 ──────────────────────────────────────────────────────────
test('⑥ ★★★ dispatch 契约：命中 ⇒ 恰好一次并回 true；不命中/方法不符 ⇒ false', async () => {
  const ran = []
  const json = (res, code, payload) => { res.sent = { code, payload } }
  const router = createModelBindingsByPathRoutes({
    json,
    bindingStore: { get: () => null, remove: () => ({ deleted: true }) },
    handleRun: async (req, res, run) => { ran.push('handleRun'); res.sent = { code: 200, payload: await run({ actor: 'g' }) } },
    BINDING_STORE_ERRORS: { BINDING_NOT_FOUND: 'BINDING_NOT_FOUND' },
  })
  const ctx = (path) => ({ path, url: new URL('http://x' + path) })

  // 不命中
  let res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, ctx('/api/nope')), false)
  assert.equal(ran.length, 0)

  // ★★★ M19：不看方法的话 POST 会被本族接住
  res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, ctx('/api/model-bindings/a/b')), false,
    '★ 不看方法的话，POST 到这条路径也会被当成读/删')
  assert.equal(ran.length, 0)

  // 命中（GET）⇒ 恰好一次、回 true
  res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, ctx('/api/model-bindings/a/b')), true)
  assert.equal(ran.length, 0, '★ GET 分支不走 handleRun')

  // 命中（DELETE）⇒ 走 handleRun
  ran.length = 0
  res = {}
  assert.equal(await router.dispatch({ method: 'DELETE' }, res, ctx('/api/model-bindings/a/b')), true)
  assert.deepEqual(ran, ['handleRun'], '★★ 回 false 会让外层再答复一次（双写响应头）')

  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), [
    'GET prefix /api/model-bindings/',
    'DELETE prefix /api/model-bindings/',
  ])
  assert.equal(router.id, 'model-bindings-by-path')
})

test('⑥b ★★★ 块前言契约：`parts()` 由前言提供，两条路由都拿得到', async () => {
  // ★★ M18：前言不回传 `parts` 的话，`parts()` 会 ReferenceError
  //   （`node --check` 看不见 —— 语法完全合法）。这里用一个**可控的** ctx 直接验。
  let seen = null
  const router = createModelBindingsByPathRoutes({
    json: (res, code, payload) => { res.sent = { code, payload } },
    bindingStore: { get: (s, r) => { seen = [s, r]; return null }, remove: () => ({ deleted: true }) },
    handleRun: async () => {},
    BINDING_STORE_ERRORS: { BINDING_NOT_FOUND: 'BINDING_NOT_FOUND' },
  })
  const res = {}
  // `/api/model-bindings/sc%20x/co%2Fder` —— 两段**各自**解码
  await router.dispatch({ method: 'GET' }, res, { path: '/api/model-bindings/sc%20x/co%2Fder', url: new URL('http://x/') })
  assert.deepEqual(seen, ['sc x', 'co/der'],
    '★★★ 两段各自解码：scope 里的空格解出来、role 里的 %2F 解成 `/` 而**不被**当成段分隔')
})

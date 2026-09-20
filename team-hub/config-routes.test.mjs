// ============================================================================
// PRT-316 切片 19：`/api/config`（能力发现，免鉴权探测）
//
// 这一族是**第一族走"活绑定"**的，所以本套件有两件事要守：
//   ① 这条端点对外的**契约**（谁都能读、读到的每一栏是什么）；
//   ② ★★★ **机制本身** —— 它依赖的 `deliveryBookkeepingFailures` 在宿主里是 `let`，
//      三处 `+= 1`。按值注入只会拿到"接线那一刻"的 0，而这类错误
//      `node --check`、逐字对拍、自由标识符判据**全部看不见** ——
//      只有"改一下那个值、再读一次、看它跟不跟着动"的行为判据看得见。
//      ⇒ 下面最后一条用例就是那个判据。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const call = async (method, path) => {
  const res = await fetch(`${base}${path}`, { method, agent: false })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-configroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  // ★ 故意**设一个 token**：这条端点必须免鉴权（它是升级了一半的部署用来
  //   判断"对面到底支不支持某能力"的探测点，读它不该需要凭证）。
  process.env.TEAM_HUB_TOKEN = 'slice19-token'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① 配了 token 也**不需要**凭证就能读（它是能力探测点，不是数据端点）', async () => {
  const r = await call('GET', '/api/config')
  assert.equal(r.status, 200, '免鉴权是这条端点的存在理由：worker 靠它判断对面支不支持某能力')
  assert.equal(r.body.ok, undefined, '这条端点的回执**没有** ok 字段，别凭空加一个')
})

test('② 每一栏都在，且 `auth` 是布尔而不是 token 本身', async () => {
  const r = await call('GET', '/api/config')
  assert.equal(typeof r.body.auth, 'boolean', 'auth 必须是布尔 —— 它一旦泄漏成字符串就是凭据泄漏')
  assert.equal(r.body.auth, true, '这一轮设了 token，所以 auth 应为 true')
  assert.equal(typeof r.body.db, 'string')
  assert.equal(typeof r.body.port, 'number')
  assert.equal(r.body.runPlane, true, 'runPlane 是 PRT-301 起的能力发现位：没有它，升级了一半的部署会让 worker 收到无法归因的 404')
})

test('③ `tokenizer` 是现场读数（"配了目录"与"真的用上了"是两件事）', async () => {
  // ★ 形状是**量出来的**（`probe-config-tokenizer.mjs`），不是我想的：
  //   我第一版照 `server.mjs` 注释里的 `tokens.kind` 写了个 `kind` 字段 ——
  //   而那是**汇编器**的读数，不是这个 status 的。实际是：
  //     { dir, loaded, count, models, error }
  //   （*一个"我知道这一栏长什么样"的判据，与一个"我记得的是**另一个**模块的同名字段"
  //     的事实，在我不去把它打出来看一眼的时候是同一个东西。*）
  const r = await call('GET', '/api/config')
  const tk = r.body.tokenizer
  assert.ok(tk && typeof tk === 'object', 'tokenizer 要有一栏读数')
  assert.equal(tk.dir, null, '没配目录时 dir 是 null')
  assert.equal(tk.loaded, false, '★ "配了目录"与"真的用上了"由 dir 与 loaded 两栏分开——' +
    '这正是它被加进来的理由：那个区别只在超限时才有人去看，所以这里把它变成可探测的')
  assert.equal(typeof tk.count, 'number')
  assert.deepEqual([...tk.models], [])
  assert.equal(tk.error, null, '`status()` 不读盘、不抛错，所以这个免鉴权探测点不会因坏词表目录而 500')
})

test('④ `eventDelivery` 三栏齐全，且 liveConnections 是当场数出来的', async () => {
  const r = await call('GET', '/api/config')
  const d = r.body.eventDelivery
  assert.ok(d && typeof d === 'object')
  assert.equal(d.subscribers, true, '能力发现位：老客户端不认识它就不传 clientId，退化成匿名订阅者')
  assert.equal(typeof d.bookkeepingFailures, 'number')
  assert.equal(typeof d.liveConnections, 'number')
  // 没有 SSE 连接时应当是 0 —— 这条同时证明它是**读** `eventClients.size` 而不是写死
  assert.equal(d.liveConnections, 0, '此刻没有任何 SSE 订阅者')
})

test('⑤ ★★★ 活绑定：宿主里那个计数涨了，这条端点必须跟着涨', async () => {
  // 直接调工厂（不走 HTTP）—— 因为要让那个 `let` 变化，最干净的办法是喂一个会变的 `live`。
  const routes = await import('./routes/config.mjs')
  let failures = 0
  let built
  const seen = []
  built = routes.createConfigRoutes({
    json: (_res, status, body) => seen.push({ status, body }),
    TOKEN: '', DB_FILE: '/tmp/slice19.db', PORT: 1,
    tokenizerRegistryStatus: () => ({ kind: 'none', source: 'slice19' }),
    eventClients: new Set(),
    live: () => ({ deliveryBookkeepingFailures: failures }),
  })
  const req = { method: 'GET' }
  const ctx = { path: '/api/config', url: new URL('http://127.0.0.1/api/config') }

  await built.dispatch(req, {}, ctx)
  assert.equal(seen.at(-1).body.eventDelivery.bookkeepingFailures, 0, '第一次：0')

  failures = 7                      // ★ 宿主那边涨了
  await built.dispatch(req, {}, ctx)
  assert.equal(seen.at(-1).body.eventDelivery.bookkeepingFailures, 7,
    '这个计数在宿主里会被 `+= 1`。按值注入会把它**永远冻在接线那一刻的值**，' +
    '于是"投递记账失败了几次"这个读数永远是 0 —— 而一个被刻意设计成"不影响主流程"的失败，' +
    '若连这个读数也是坏的，就再没有任何地方能看见它了。')

  failures = 8
  await built.dispatch(req, {}, ctx)
  assert.equal(seen.at(-1).body.eventDelivery.bookkeepingFailures, 8, '第三次：跟着变')
})

test('⑥ ★ `live()` 少给一个名字时**当场抛**，而不是静默变成 undefined', async () => {
  const routes = await import('./routes/config.mjs')
  const built = routes.createConfigRoutes({
    json: () => {}, TOKEN: '', DB_FILE: '/tmp/slice19.db', PORT: 1,
    tokenizerRegistryStatus: () => ({ kind: 'none' }),
    eventClients: new Set(),
    live: () => ({}),                       // ← 故意什么都不给
  })
  await assert.rejects(
    () => built.dispatch({ method: 'GET' }, {}, { path: '/api/config', url: new URL('http://127.0.0.1/api/config') }),
    /没给 deliveryBookkeepingFailures/,
    '静默变成 undefined 会让读数变成 undefined 而不是报错 —— 宁可响亮地坏')
})

test('⑦ ★ 缺 `live` 本身也当场抛（可变绑定的族不允许按值接线）', async () => {
  const routes = await import('./routes/config.mjs')
  assert.throws(() => routes.createConfigRoutes({
    json: () => {}, TOKEN: '', DB_FILE: '/tmp/slice19.db', PORT: 1,
    tokenizerRegistryStatus: () => ({ kind: 'none' }), eventClients: new Set(),
  }), /缺注入项：live/)
})

// ────────────────────────────────────────────────────────────────────────────
// 下面三条是**破验逼出来的**（切片 19 第一轮 13/17）：
//   M16（dispatch 不看方法）、M9（port 恒报 0）、M14（liveConnections 恒报 0）
//   三条各自揭示一种"套件结构上看不见"：
//     · M16 —— 只发 GET 的套件看不见方法位漏了；
//     · M9  —— 只断言 `typeof === 'number'` 的套件看不见它恒为 0；
//     · M14 —— 只断言"空闲时是 0"的套件看不见它**恒**为 0。
//        > 一个"这个读数在空闲时是对的"的判据，与一个"这个读数是常数"的实现，是同一个东西。
// ────────────────────────────────────────────────────────────────────────────

test('⑧ ★ 只有 GET 认这条端点（写方法应当 404，没人认领）', async () => {
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const r = await call(m, '/api/config')
    assert.equal(r.status, 404, `${m} /api/config 应当 404`)
  }
})

test('⑨ ★ `port` 报的是配置里的端口（不能是 0）', async () => {
  const r = await call('GET', '/api/config')
  assert.ok(Number.isInteger(r.body.port) && r.body.port > 0,
    `port 恒报 0 会让"对面在哪个端口"这个读数变成谎话（实际 ${r.body.port}）`)
})

test('⑩ ★★★ `liveConnections` 是当场数出来的：开一条订阅就得跟着变', async () => {
  const before = (await call('GET', '/api/config')).body.eventDelivery.liveConnections
  const ac = new AbortController()
  const res = await fetch(`${base}/api/events?clientId=slice19-probe`, {
    headers: { accept: 'text/event-stream', 'x-team-hub-token': 'slice19-token' },
    signal: ac.signal, agent: false,
  })
  assert.equal(res.status, 200, 'SSE 订阅本身要连得上')
  void res.body?.getReader?.().read?.().catch(() => {})
  await new Promise((r) => setTimeout(r, 300))
  const during = (await call('GET', '/api/config')).body.eventDelivery.liveConnections
  assert.equal(during, before + 1, `开一条订阅后应当 +1（前 ${before}，后 ${during}）`)
  ac.abort()
  await new Promise((r) => setTimeout(r, 300))
  const after = (await call('GET', '/api/config')).body.eventDelivery.liveConnections
  assert.equal(after, before, '断开后要回到原值 —— 否则这个读数是只增不减的')
})

test('⑪ ★★★ 结构不变式：同步必须排在**任何读取之前**（这条让"初始值"不可观测）', async () => {
  // 破验的 M3（把初始值冻成 0）**咬不住**，而且要如实说清楚**为什么**：
  //   `syncLive()` 是 `dispatch` 的第一句，而那个变量只在路由体里被读 ——
  //   路由体只能经由 `dispatch` 到达。⇒ 初始值在**唯一**的读取点之前必被覆盖，
  //   它是一个 dead store，M3 与原文**可证等价**，不是缺口。
  //
  // 但这个"可证"依赖一个顺序，而顺序是会被改动的 —— 所以把它钉在这里：
  // 一旦有人把 `syncLive()` 挪到循环之后、或挪进某条路由，这条用例立刻红。
  const src = readFileSync(new URL('./routes/config.mjs', import.meta.url), 'utf8')
  const dispatch = /async dispatch\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\},/.exec(src)
  assert.ok(dispatch, '读不出 dispatch 的体')
  const stmts = dispatch[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
  assert.equal(stmts[0], 'syncLive()',
    'syncLive() 必须是 dispatch 的第一句 —— 它排在读之前，"初始值不可观测"才成立')

  // 顺带把顺序本身也做一次**行为**验证：构造时给 42，建好之后改成 43，
  // 第一次请求必须读到 43（现场值），而不是 42（构造时的值）。
  const routes = await import('./routes/config.mjs')
  let failures = 42
  const seen = []
  const built = routes.createConfigRoutes({
    json: (_res, _st, body) => seen.push(body), TOKEN: '', DB_FILE: '/tmp/slice19.db', PORT: 1,
    tokenizerRegistryStatus: () => ({ dir: null, loaded: false, count: 0, models: [], error: null }),
    eventClients: new Set(),
    live: () => ({ deliveryBookkeepingFailures: failures }),
  })
  failures = 43
  await built.dispatch({ method: 'GET' }, {}, { path: '/api/config', url: new URL('http://127.0.0.1/api/config') })
  assert.equal(seen.at(-1).eventDelivery.bookkeepingFailures, 43,
    '第一次请求必须读**现场值**（43），不是构造时的 42')
})

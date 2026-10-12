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
  // ★ 2026-10-12：`db`（绝对路径）→ `dbFingerprint`（路径的 sha256 前 16 位）。
  //   这一栏的用途是**实例识别**（免鉴权时回答"我连到的是不是我自己的实例"），
  //   指纹一样答得出，而部署布局不再外泄。详见本文件末尾那三条判据与
  //   `routes/config.mjs` 的文件头。
  assert.equal(typeof r.body.dbFingerprint, 'string')
  assert.equal('db' in r.body, false, '旧的绝对路径字段不该再出现')
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

// ════════════════════════════════════════════════════════════════════════════
// ★★★ 免鉴权端点**不许泄露部署布局**
//
// 这个端点任何人都能读（它是能力发现 —— 探测发生在拿到令牌**之前**，所以它必须
// 免鉴权）。它原先回的是数据库的**绝对路径**（`/var/lib/legion-hub/team.db` 这样），
// 等于把部署布局与运行账户名告诉任何能发 HTTP 的人。
//
//   > 一个"任何人都能读、而且顺手告诉你文件住哪"的端点，
//   > 与一个"只回答能力问题"的端点，在功能上完全一样——
//   > 只不过前者把服务器的目录结构当成了公开信息。
//
// 但那个字段**有真实用途**：多个脚本用它做实例识别 ——
// `(await r.json()).db === dbFile` 回答的是"我连到的是不是我自己刚起的那个实例，
// 而不是随机端口上恰好占着的别的服务"。所以修法是**换值**而不是**删掉能力**。
//
// ⚠️ 不能用 Host 头区分"公开请求 / 本地探测"：Host 是**攻击者可控**的，
//   伪造 `Host: 127.0.0.1` 就能把这个端点重新变成泄露源。所以只能换值，不能加条件。
// ════════════════════════════════════════════════════════════════════════════

test('★★★ /api/config 不泄露绝对路径，但保留实例识别能力', async () => {
  const { dbFingerprintOf } = await import('./routes/config.mjs')
  const r = await call('GET', '/api/config')
  assert.equal(r.status, 200)

  // ① 旧的泄漏字段必须消失。
  assert.equal('db' in r.body, false, '`db`（数据库绝对路径）不该再出现在免鉴权响应里')

  // ② 整个响应体里**不许**出现绝对路径形状的字符串（含 Windows 与 POSIX）。
  //    这一条比"检查某个字段名"强：将来有人加回一个 `dbPath` / `dataDir` 也会被抓住。
  const raw = JSON.stringify(r.body)
  assert.doesNotMatch(raw, /"[A-Za-z]:[\\/]/, `响应里出现了 Windows 绝对路径：${raw.slice(0, 200)}`)
  assert.doesNotMatch(raw, /"\/(?:var|etc|home|root|srv|tmp|usr|opt)\//,
    `响应里出现了 POSIX 绝对路径：${raw.slice(0, 200)}`)

  // ③ 实例识别能力必须**仍在**。
  assert.match(String(r.body.dbFingerprint), /^[0-9a-f]{16}$/,
    `dbFingerprint 形状不对：${JSON.stringify(r.body.dbFingerprint)}`)
  assert.equal(r.body.dbFingerprint, dbFingerprintOf(process.env.TEAM_HUB_DB),
    'dbFingerprint 必须由**本实例的** db 路径算出（否则实例识别会给出错误答案）')
})

test('★★ 指纹：同路径稳定、不同路径不同、且不可反推路径', async () => {
  const { dbFingerprintOf } = await import('./routes/config.mjs')
  const a = dbFingerprintOf('/srv/a/team.db')
  const b = dbFingerprintOf('/srv/a/team.db')
  const c = dbFingerprintOf('/srv/b/team.db')

  assert.equal(a, b, '同一个路径必须算出同一个指纹（否则实例识别会随机失败）')
  assert.notEqual(a, c, '不同路径必须算出不同指纹（否则"这到底是不是我的实例"答不出来）')
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(a.includes('srv'), false, '指纹里不许含有原路径的片段')
  assert.equal(a.includes('team'), false)
  // 空串/null 是硬错误：放行空串会让两个"没配 db"的实例看起来是同一个。
  assert.throws(() => dbFingerprintOf(''), TypeError)
  assert.throws(() => dbFingerprintOf(null), TypeError)
})

test('★ 反例守卫：上面那两条路径判据真的能发现泄漏', () => {
  // 证明第 ② 条不是恒真 —— 否则它什么都没在测。
  const win = JSON.stringify({ auth: true, db: 'D:\\project\\DSH\\legion\\team-hub\\team.db', port: 8787 })
  assert.match(win, /"[A-Za-z]:[\\/]/, '反例本身应当被 Windows 路径判据抓住')
  const posix = JSON.stringify({ auth: true, db: '/var/lib/legion-hub/team.db', port: 8787 })
  assert.match(posix, /"\/(?:var|etc|home|root|srv|tmp|usr|opt)\//,
    '反例本身应当被 POSIX 路径判据抓住')
})

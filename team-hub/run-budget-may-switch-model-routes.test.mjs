// ============================================================================
// PRT-316 切片 49：换模型前的费用闸 —— 1 条，`exact`
//   POST /api/runtime/run-budget/may-switch-model
//
// ★★★ 这一族的形状与别族不同：它用的是 **`handleRun`**（不是 `handleWrite`）。
//   - `handleWrite` 收 `(body, by, scope)`；
//   - `handleRun` 只收 `(body)`，而且把回调的返回值包成 `{ok:true, ...result}`。
//
// ★★★ 所以它有**两条**响应路径：
//   ① 回调**自己**写 409（缺价目表）然后 `return`；
//   ② 否则由 `handleRun` 统一包 200。
//   `handleRun` 里那句 `if (!res.headersSent)` 正是为 ① 准备的 ——
//   如果把它去掉，① 会被再写一次响应 ⇒ `ERR_HTTP_HEADERS_SENT`。
//
// ★★★ 还有一道**故意的 fail closed**：缺价目表时**不能**因为"查不清"就放行，
//   所以是 409（请求没错，缺的是一张表），**不是** 400，更不是 200/allowed。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRunBudgetMaySwitchModelRoutes } from './routes/run-budget-may-switch-model.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-mayswitch-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

const URL_ = '/api/runtime/run-budget/may-switch-model'

// ══════════════════════ 真 hub：409 那条 fail-closed 路径 ══════════════════════

test('① ★★★★★ 缺价目表 ⇒ **409**（不是 400、不是 200），且 `code` 可判', async () => {
  const r = await post(URL_, { priceTableVersion: '不存在的版本', from: 'a', to: 'b' })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.ok, false, '★★ 绝不能是 ok:true —— 这正是要防的"查不清就放行"')
  assert.equal(r.body.code, 'PRICE_TABLE_GONE', '★★★ 代码要可判（worker 靠它决定下一步）')
  assert.notEqual(r.body.status, 200)
})

test('② ★★★ 409 的文案说明**为什么不能放行**（fail closed 的理由），且带 `serverTimeMs`', async () => {
  const r = await post(URL_, { priceTableVersion: 'v-none', from: 'a', to: 'b' })
  assert.equal(r.status, 409)
  const msg = String(r.body.error)
  assert.match(msg, /没有价目表版本/, '★ 说清缺的是哪张表')
  assert.match(msg, /不得在未获用户批准时自动切换到更昂贵模型/,
    '★★★ 要把**被守住的那条规矩**写在话里 —— 否则下一个人只看到"缺张表"，看不出这是安全闸')
  assert.match(msg, /不能靠"查不清"来满足/, '★★ 明确拒绝"查不清就当没事"这条捷径')
  assert.equal(typeof r.body.serverTimeMs, 'number', '★ 带服务器时间')
  assert.ok(Math.abs(Date.now() - r.body.serverTimeMs) < 60_000, '★★ 得是**刚刚**的')
})

test('③ ★★★ 缺价目表时**根本没走到域层**（不能在"没表"的情况下判 allowed）', async () => {
  // 用一个**会抛**的 args 探针不行（域层在 server.mjs 里），
  // 但可以反证：若走到了域层，缺 priceTable 会让 maySwitchModel 自己抛 ⇒ 变成 400。
  const r = await post(URL_, { priceTableVersion: 'missing-xyz' })
  assert.equal(r.status, 409, '★★ 必须**在路由这一层**就拦住 ⇒ 409；走到域层会是 400')
  assert.notEqual(r.status, 400, '★★★ 400 说明"缺表"被当成了"请求有错"，这会把安全闸说成参数问题')
  assert.equal(r.body.code, 'PRICE_TABLE_GONE', '★ 不是域层抛出来的码')
})

test('④ ★★ 版本号缺失 / null / 数字都走同一条 409（`JSON.stringify` 如实写进文案）', async () => {
  for (const v of [undefined, null, 12345, 'v0.0.0-nope']) {
    const r = await post(URL_, { priceTableVersion: v })
    assert.equal(r.status, 409, `★★ priceTableVersion=${JSON.stringify(v)}`)
    assert.equal(r.body.code, 'PRICE_TABLE_GONE')
    assert.ok(String(r.body.error).includes(JSON.stringify(v)),
      `★★ 文案里要出现 ${JSON.stringify(v)}（用 JSON.stringify 写，undefined 也在话里）`)
  }
})

test('⑤ ★★ 未授权 ⇒ 401（`handleRun` 的第一道闸）—— 但空 token 配置下鉴权是关的', async () => {
  // ★ 这里不能靠 process.env 临时改（server 已经把 TOKEN 读进闭包了），
  //   所以改为验"空 token 放行"这一条的**反面**。
  // ★★ 用 ASCII token：`fetch` 的 header 值必须是 ByteString，
  //   中文会抛 `Cannot convert argument to a ByteString`（我第一次就是这么写错的）。
  const res = await fetch(base + URL_, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-not-it' },
    body: JSON.stringify({ priceTableVersion: 'x' }),
  })
  // ★ 空 TOKEN 时 `authorized` 恒真 ⇒ 带错 token 也放行。**这是量出来的行为，钉住**：
  //   `TEAM_HUB_TOKEN=''` 的部署下鉴权是关闭的。
  assert.equal(res.status, 409, '★★ 空 token 配置下鉴权关闭 ⇒ 错 token 也走到 409（不是 401）')
})

// ══════════════════════ 接缝契约（stub） ══════════════════════

const TABLE = { id: 'pt', models: {} }
// ★★★ 域层返回的**不止路由投影出去的那五个** —— `budget-ledger.mjs` 里
//   内部用的是 `d.message`（L834 把它塞进 `BudgetError`），也就是 `d` 至少还带 `message`。
//   第一版我的桩**只**返回那五个，于是"返回里多带域层内部字段"这个变异
//   （`return { ...d }`）**无法被区分** —— 破验报 M18「没咬住」。
//
//   > 一个「我断言了返回的键集合，所以多带字段会被抓住」的印象，
//   > 与一个「我的桩**恰好**只造那五个键，于是 `{...d}` 与显式投影在这个桩下
//   > 逐字节相同」的事实，在破验把 M18 投进来之前是同一个东西。
//
//   ⇒ 桩要**带一个真实存在、但路由不该投影出去的字段**，判据才有区分力。
const okLedger = (d) => ({
  allowed: d.allowed === true, code: d.code ?? 'OK',
  fromAmount: 1, toAmount: 2, currency: 'USD',
  // ★ 下面两个是**域层内部**的：路由**不许**把它们漏给调用方
  message: '模型切换的判据说明',
  reason: 'internal-reason',
})
const stub = (over = {}) => createRunBudgetMaySwitchModelRoutes({
  // ★★★ 写响应**必须**顺带把 `headersSent` 立起来 —— 否则 `handleRun` 那层
  //   会以为还没写过，把回调刚写的 409 **覆盖成 200**。
  //   第一版我漏了这一句，于是在 ⑪ 里**就地**打了个补丁（给那一条单独换个 json），
  //   而 ⑩ 仍然踩坑报 `actual: 200, expected: 409`。
  //   > 一个「桩已经把 json 模拟好了」的印象，
  //   > 与一个「它少了一个副作用，于是"谁先写过响应"这件事在桩里根本不成立」的事实，
  //   > 在我第二次被同一个坑绊到之前是同一个东西。
  json: (res, code, p) => { res.headersSent = true; res.sent = { code, payload: p } },
  // ★★ 桩要从 **`req.body`** 取（`run(req,res)` 只往 `handleRun` 递两个形参，
  //   所以 body 只能挂在 req 上）。第一版我写成 `run({})`，
  //   于是 ⑧⑨⑩ 三条里域层收到的全是空对象 —— 判据当场报 `actual: undefined`。
  handleRun: async (req, res, run) => {
    const out = await run(req.body ?? {})
    if (!res.headersSent) { res.headersSent = true; res.sent = { code: 200, payload: { ok: true, ...out } } }
  },
  budgetPriceTables: { get: () => TABLE },
  budgetLedger: { maySwitchModel: okLedger },
  BUDGET_ERRORS: { PRICE_TABLE_GONE: 'PRICE_TABLE_GONE' },
  ...over,
})

test('⑥ ★★★ dispatch 契约：只认 `POST /api/runtime/run-budget/may-switch-model`，`exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx(URL_)), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx(URL_ + 'X')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx(URL_)), false, '★ 只认 POST')
  // ★★ 同前缀的兄弟：`/api/runtime/run-budget/**` 下的结算/账本路由**不属本族**
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/run-budget/settle')), false,
    '★★ 不许越界认领 /api/runtime/run-budget/ 下的兄弟')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/runtime/run-budget')), false)
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`),
    ['POST exact /api/runtime/run-budget/may-switch-model'])
  assert.equal(router.id, 'run-budget-may-switch-model')
})

test('⑦ ★★★ 成功时只回**五个**字段，且 `handleRun` 外面再包一层 `{ok:true}`', async () => {
  const router = stub()
  const res = {}
  await router.dispatch({ method: 'POST' }, res, { path: URL_, url: new URL('http://x' + URL_) })
  assert.equal(res.sent.code, 200)
  assert.equal(res.sent.payload.ok, true, '★ handleRun 那一层')
  assert.deepEqual(Object.keys(res.sent.payload).sort(),
    ['allowed', 'code', 'currency', 'fromAmount', 'ok', 'toAmount'],
    '★★★ 域层多给的字段**不许**漏出去（`...d` 会把 `message`/`reason` 一起泄出去）')
  assert.equal('message' in res.sent.payload, false, '★★★ 域层的 `message` 不该出现在响应里')
  assert.equal('reason' in res.sent.payload, false, '★★★ 域层的 `reason` 不该出现在响应里')
})

test('⑧ ★★★ `approved` 是**严格真值**：只有 `=== true` 才算批准', async () => {
  let seen = null
  const r = stub({ budgetLedger: { maySwitchModel: (d) => { seen = d; return okLedger(d) } } })
  const body = (b) => r.routes[0].run({ method: 'POST', body: b }, {})
  for (const v of [true, 'true', 1, 'yes', undefined]) {
    await body({ priceTableVersion: 'x', approved: v })
    assert.equal(seen.approved, v === true,
      `★★★ approved=${JSON.stringify(v)} ⇒ 域层应看到 ${v === true}（"字符串 true" **不算**批准）`)
  }
})

test('⑨ ★★ 六个入参逐字递给域层（少一个都变成 undefined）', async () => {
  let seen = null
  const r = stub({ budgetLedger: { maySwitchModel: (d) => { seen = d; return okLedger(d) } } })
  await r.routes[0].run({ method: 'POST', body: {
    priceTableVersion: 'v1', from: 'F', to: 'T', tokensIn: 11, tokensOut: 22, approved: true,
  } }, {})
  assert.equal(seen.from, 'F'); assert.equal(seen.to, 'T')
  assert.equal(seen.tokensIn, 11); assert.equal(seen.tokensOut, 22)
  assert.equal(seen.approved, true)
  assert.equal(seen.priceTable, TABLE, '★★★ `priceTable` 递的是**查出来的那张表**，不是版本号')
})

test('⑩ ★★★ 查表用的是 `body.priceTableVersion`（拼错一个字母 ⇒ 查不到 ⇒ 409 而不是 400）', async () => {
  let askedFor = null
  const r = stub({ budgetPriceTables: { get: (v) => { askedFor = v; return TABLE } } })
  await r.routes[0].run({ method: 'POST', body: { priceTableVersion: 'vX' } }, {})
  assert.equal(askedFor, 'vX', '★★★ 必须用 `priceTableVersion` 这个键名')
  // ★ 而写错键名（`priceTable`）会取到 undefined ⇒ 注册表找不到 ⇒ 409
  let seen2
  const r2 = stub({
    budgetPriceTables: { get: (v) => { seen2 = v; return v === undefined ? null : TABLE } },
  })
  const res2 = {}
  await r2.routes[0].run({ method: 'POST', body: { priceTable: 'vX' } }, res2)
  assert.equal(seen2, undefined, '★ 拼错时查到的是 undefined')
  assert.equal(res2.sent.code, 409, '★★ 拼错键名的表现是 **409**（"缺表"），不是 400 —— 排错时要认得出')
})

test('⑪ ★★★ 回调自己写过响应之后，路由**不能再写一次**（`headersSent` 那条）', async () => {
  // 一个**如实**模拟 `handleRun` 的桩：它只在 `!res.headersSent` 时才包 200。
  let writes = 0
  const router = stub({
    json: (res, code, p) => { writes++; res.headersSent = true; res.sent = { code, payload: p } },
    budgetPriceTables: { get: () => null },
    handleRun: async (req, res, run) => {
      const out = await run({ priceTableVersion: 'gone' })
      if (!res.headersSent) { writes++; res.sent = { code: 200, payload: { ok: true, ...out } } }
    },
  })
  const res = { headersSent: false }
  await router.dispatch({ method: 'POST' }, res, { path: URL_, url: new URL('http://x' + URL_) })
  assert.equal(writes, 1, '★★★ 409 那条路上**只能写一次**响应')
  assert.equal(res.sent.code, 409)
  assert.equal(res.sent.payload.ok, false)
})

test('⑫ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, handleRun: async () => {},
    budgetPriceTables: { get: () => null }, budgetLedger: { maySwitchModel: () => ({}) },
    BUDGET_ERRORS: { PRICE_TABLE_GONE: 'x' },
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createRunBudgetMaySwitchModelRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})

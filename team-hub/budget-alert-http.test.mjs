// team-hub/budget-alert-http.test.mjs
// ============================================================================
// F-15 告警/降级的**接线**判据：真 hub 进程 + 真 HTTP。
//
// `budget-alert.test.mjs` 的 20 例验的是求值语义。它全绿也可能
// **没有任何 HTTP 面能走到那个函数**——本仓反复记过的那个形状。
//
// 本组只钉四件只有真接线才有的事：
//
//   ① `GET /api/usage/alert` 真的读到了**库里那份账**（不是参数回显）；
//   ② 缺 `limit` ⇒ **400 + 具名码**，而**不是**按 0/无上限处理
//      ——"没配上限所以按 0 处理"会让每一道预算告警在没配的时候报绿；
//   ③ 那 7 条"金额未知"的账在真 HTTP 上**必须**让 `allClear` 变 false，
//      而 `level` 仍然是 `ok`（两件事分开报，且都能在响应里看到）；
//   ④ 没有写路径：`POST` 同一个地址不是 200。
//
// ★ 与本文件同一批的一条**接口设计选择**也在这里被钉住：
//   本接口**不**读模型绑定里的 `perRunBudget`。夹具里**故意**放了一条
//   带 `perRunBudget` 的绑定，然后断言响应**与它无关**——
//   因为那是单次运行的天花板，而本接口比的是时间窗的累计花费。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-budget-alert-http-'))
let mod
let base = ''
const TOKEN = 'budget-alert-e2e-token'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  seed()
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

const auth = { authorization: `Bearer ${TOKEN}` }
async function get(path) {
  const r = await fetch(base + path, { headers: auth })
  return { status: r.status, body: await r.json().catch(() => null) }
}

function seed() {
  const db = mod.db
  db.prepare("INSERT INTO tasks (id, title, role, scope, goalId, status) VALUES ('T-1','a','soldier','software','G-1','Done')").run()
  db.prepare(
    `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms)
     VALUES ('A-1','T-1','software',1,'Succeeded',0,1000,2000)`,
  ).run()
  const ins = db.prepare(
    `INSERT INTO usage_records
       (attempt_id, scope, task_id, model_profile_id, currency, billing_unit, price_table_version,
        effective_at_ms, tokens_in, tokens_out, estimated_amount, actual_amount, estimate_ok,
        runtime_estimate_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  // 一笔**有价**的：3 元。制造出"报表说 3 元，看起来离上限很远"的那个假象。
  ins.run('A-1', 'software', 'T-1', 'm-a', 'USD', 'per-1k-tokens', 'v1', 1000, 100, 50, 3, null, 1, '{}', 1000)
  // 7 笔**没价**的（`estimate_ok = 0` ⇒ 金额 NULL）。它们才是这条用例的主角。
  for (let i = 0; i < 7; i += 1) {
    ins.run('A-1', 'software', 'T-1', 'unpriced', 'USD', 'per-1k-tokens', 'v1', 1000,
      10, 5, null, null, 0, '{}', 1100 + i)
  }
  // ★ 故意放一条带 `perRunBudget` 的模型绑定：本接口**必须**与它无关。
  //   若哪天有人"顺手"把它接上去当上限，下面的 ④b 会红。
  if (typeof mod.bindingStore?.upsert === 'function') {
    mod.bindingStore.upsert({
      scope: 'software', employeeRole: 'soldier', primaryProfile: 'm-a',
      fallbackProfiles: [], perRunBudget: { maxCost: 0.01, currency: 'USD' },
    }, { actor: 'fixture' })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ① 真 HTTP 上把"库里的账"读出来
// ══════════════════════════════════════════════════════════════════════════

test('① 真 HTTP：响应里的 records / unknownRecords 来自库，不是参数回显', async () => {
  const { status, body } = await get('/api/usage/alert?limit=100&warn=0.5&degrade=0.8&block=1&degradeTo=cheap')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.records, 8, '库里是 8 条用量行（1 条有价 + 7 条没价）')
  assert.equal(body.spent, 3, '`SUM` 把 7 条 NULL 当 0 加进去了 —— 这就是那个"看起来正常"的 3')
  assert.equal(body.unknownRecords, 7)
})

test('①b 认证：不带 token ⇒ 401（与其余只读端点一致）', async () => {
  const r = await fetch(base + '/api/usage/alert?limit=100')
  assert.equal(r.status, 401)
})

// ══════════════════════════════════════════════════════════════════════════
// ② 缺上限 ⇒ 400，绝不落回默认值
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 缺 limit ⇒ 400 + LIMIT_REQUIRED，而不是"按 0 处理"或"无上限"', async () => {
  const { status, body } = await get('/api/usage/alert?warn=0.5')
  assert.equal(status, 400,
    '缺上限时返回了 200。★ 一个"没配上限所以按 0 处理"的实现，'
    + '会让每一道预算告警在**没配**的时候报绿——而那正是最需要它红的时候')
  assert.equal(body.code, 'LIMIT_REQUIRED')
  assert.match(body.error, /不.*发明上限|刻意不读/)
  // 具名码 + 可选值，调用方不必翻源码
  assert.ok(Array.isArray(body.levels) && body.levels.length === 4)
  assert.ok(Array.isArray(body.rungs) && body.rungs.length === 3)

  // 上限非法（0 / 非数）也必须是 4xx + 具名码，不是 500
  for (const bad of ['0', 'abc', '-5']) {
    const r = await get(`/api/usage/alert?limit=${bad}&warn=0.5`)
    assert.ok(r.status === 400, `limit=${bad} 返回了 ${r.status}`)
    assert.ok(typeof r.body.code === 'string' && r.body.code.length > 0,
      `limit=${bad} 的错误里没有具名码`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 核心：7 条未知账在真 HTTP 上不许被读成"没事"
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★★ 真 HTTP：报表明明是 3 元 / 上限 100，而 allClear 必须是 false', async () => {
  const { body } = await get('/api/usage/alert?limit=100&warn=0.5&degrade=0.8&block=1&degradeTo=cheap')
  assert.equal(body.limit, 100)
  assert.equal(body.ratio, 0.03, '已知金额这一维确实离上限很远')
  assert.equal(body.level, 'ok', '★ level 只由**已知金额**算 —— 这里确实是 ok')
  assert.equal(body.confidence, 'partial', '知道 1 条、不知道 7 条 ⇒ partial')
  assert.equal(body.allClear, false,
    '★★★ 有 7 条账目不知道多少钱，而接口报了"一切正常"。'
    + '只看 `spent / limit` 的实现会在这里报绿——而它连那 7 笔里'
    + '有没有已经超了上限都不知道')
  assert.equal(body.action, 'review')
  assert.ok(body.reasons.includes('SPEND_PARTIAL'))
})

test('③b ★ 反向对照：同一份账，把上限放大 + 未知项补上价 ⇒ 必须真的能报绿', async () => {
  // 这一条防的是"实现永远说不可信"。先确认当前是 partial，
  // 再把那 7 条改成有价，然后**同一个端点**必须给出 allClear: true。
  const before = await get('/api/usage/alert?limit=3000&warn=0.5&degrade=0.8&block=1')
  assert.equal(before.body.allClear, false)
  assert.equal(before.body.confidence, 'partial')

  mod.db.prepare('UPDATE usage_records SET estimated_amount = 200, estimate_ok = 1 WHERE estimate_ok = 0').run()
  const after = await get('/api/usage/alert?limit=3000&warn=0.5&degrade=0.8&block=1')
  assert.equal(after.body.confidence, 'exact')
  assert.equal(after.body.allClear, true,
    '账目补齐之后仍然报"不可信"。★ 一个永远说"不可信"的实现，'
    + '与一个永远说"没事"的实现在这件事上是同一种坏——'
    + '而前者更难被发现，因为它看起来像"很谨慎"')
  assert.equal(after.body.amount ?? after.body.spent, 1403)

  // 还原，免得后面的用例读到被改过的库
  mod.db.prepare('UPDATE usage_records SET estimated_amount = NULL, estimate_ok = 0 WHERE model_profile_id = ?')
    .run('unpriced')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 阈值：没配就是没配；而 perRunBudget 不许被顺手接上来
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 不配阈值 ⇒ 200 但 `configured:false` 且 `allClear:false`（"没配告警"不是"一切正常"）', async () => {
  const { status, body } = await get('/api/usage/alert?limit=100')
  assert.equal(status, 200, '这不是调用方的错——那是一个要被**看见**的状态')
  assert.equal(body.configured, false)
  assert.equal(body.allClear, false,
    '★ 没配阈值却报了"一切正常"。一个不报的告警与一个没有的告警，'
    + '在"它有没有救过我"这件事上是同一个回答')
  assert.ok(body.reasons.includes('NOT_CONFIGURED'))
})

test('④b ★★★ 阈值非法 ⇒ 400 + 具名码（含"不认识的阈值名"这一条）', async () => {
  // ★★★ 不认识的阈值名：静默忽略会让"我配了它"与"没配"在读数上同形。
  //
  // 这一条**第一版是红的**，而它抓到的是接缝上的一个真缺陷：
  // 路由第一版只把**认识的那三个** rung 名从查询串里挑出来交给求值函数，
  // 于是 `warning` 这个键**根本没进到** `normalizeThresholds()`——
  // 那个守卫**在，但它看不见这个键**，接口照旧返回 200。
  //
  //   > 一个把不合格的输入**过滤掉**、再交给守卫的适配层，
  //   > 与一个根本没有守卫的实现，是同一个东西——
  //   > 只不过前者的守卫**在源码里看起来是有的**。
  //
  // 修法是把参数集变成**封闭**的（见 `server.mjs` 的 `ALLOWED_PARAMS`）。
  const typo = await get('/api/usage/alert?limit=100&warning=0.5')
  assert.equal(typo.status, 400,
    '`warning`（多了个 ing）被静默忽略了 —— 配置者以为自己配了告警，而系统里没有它')
  assert.equal(typo.body.code, 'THRESHOLDS_INVALID')
  // 报错必须**指出正确的名字**，否则调用方只能去翻源码
  assert.match(typo.body.error, /warning/)
  assert.ok(Array.isArray(typo.body.rungs) && typo.body.rungs.includes('warn'),
    '错误里没有列出正确的阈值名 ⇒ 调用方只能去翻源码')
  // 其他参数拼错也一样（同一个后果：以为配了，实际没配）
  const otherTypo = await get('/api/usage/alert?limit=100&since=1000')
  assert.equal(otherTypo.status, 400)

  const unordered = await get('/api/usage/alert?limit=100&warn=0.8&degrade=0.5')
  assert.equal(unordered.status, 400)
  assert.equal(unordered.body.code, 'THRESHOLDS_UNORDERED')

  const outOfRange = await get('/api/usage/alert?limit=100&warn=0')
  assert.equal(outOfRange.status, 400)
  assert.equal(outOfRange.body.code, 'THRESHOLD_OUT_OF_RANGE')

  const ccy = await get('/api/usage/alert?limit=100&currency=CNY&warn=0.5')
  assert.equal(ccy.status, 400)
  assert.equal(ccy.body.code, 'CURRENCY_MISMATCH')
})

test('④c ★★★ 上限与模型绑定里的 `perRunBudget` **无关**（刻意的接口设计）', async () => {
  // 夹具里那条绑定的 `perRunBudget.maxCost = 0.01`。若有人把它接上来当上限，
  // 那么 limit 给 100 时算出来的 ratio 会是 3 / 0.01 = 300 ⇒ block。
  const { body } = await get('/api/usage/alert?limit=100&warn=0.5&degrade=0.8&block=1')
  assert.equal(body.limit, 100, '上限被换成了别的东西（很可能是 perRunBudget.maxCost）')
  assert.equal(body.ratio, 0.03,
    '★ 比值不是 3/100。一个"时间窗累计花费 / 单次运行上限"的比值**算得出来**、'
    + '通常落在 0 到 1 之间、看起来完全正常——但它没有意义：'
    + '窗里有 30 次运行时，"累计花费超过单次上限"是**必然**的，与超支无关。'
    + '一个"算得出来、落在合理区间、而且没有意义"的比值，与一个正确的比值，'
    + '在仪表盘上是同一个东西')
  assert.notEqual(body.level, 'block')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 只读：没有写路径
// ══════════════════════════════════════════════════════════════════════════

test('⑤ 只读：POST /api/usage/alert 不是 200（没有"手工改一笔告警"的后门）', async () => {
  const r = await fetch(base + '/api/usage/alert?limit=100', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}',
  })
  assert.notEqual(r.status, 200,
    '同一地址接受 POST。★ 本接口读的是已经记下的账，'
    + '"记一笔账"是 budget-ledger 的 reserve/observe/settle——'
    + '那条链是闸门，不该有一条后门')
  // 库里的行数没变
  const { body } = await get('/api/usage/alert?limit=100&warn=0.5')
  assert.equal(body.records, 8, 'POST 之后库里的用量行变了')
})
// ============================================================================
// PRT-316 切片 14 · 契约块 —— 告警接口的"输入面"读数
//
// 同样是被破验逼出来的：④b 已经钉住了"不认识的参数 ⇒ 400"，
// 但**没人断言过那个 400 里到底列了哪些可选参数** —— 少列一项，
// 调用方就会以为那一项不存在（等于把"我配了它"变成"我没配"）。
// ============================================================================
test('⑥ ★ 不认识的参数 400 里，`allowedParams` 必须**逐个**列全（含三个阈值名）', async () => {
  const r = await get('/api/usage/alert?limit=100&bogus=1')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'THRESHOLDS_INVALID')
  assert.deepEqual(r.body.allowedParams,
    ['limit', 'currency', 'degradeTo', 'scope', 'sinceMs', 'untilMs', 'warn', 'degrade', 'block'],
    '三个阈值名必须在里面 —— 少了它们，调用方看到"参数不认识"却看不到正确的名字')
  assert.deepEqual(r.body.rungs, ['warn', 'degrade', 'block'])
})

test('⑦ ★ `degradeTo` 原样透传；没给就是 `null`（不发明一个默认降级目标）', async () => {
  const withIt = await get('/api/usage/alert?limit=100&degradeTo=cheap')
  assert.equal(withIt.status, 200)
  assert.equal(withIt.body.degradeTo, 'cheap')
  const without = await get('/api/usage/alert?limit=100')
  assert.equal(without.status, 200)
  assert.equal(without.body.degradeTo, null, '没给就是 null —— 默认目标会让降级动作指向一个没人选过的档位')
})

test('⑧ ★★★ 空串阈值 `warn=` 是"**没配**"，不是"配了 0"', async () => {
  // ★ 一个"没配所以按 0 处理"的实现，会让每一道预算告警在**没配**的时候报绿。
  //   空库上量到的真行为：configured:false + thresholds:{} + reasons:['NOT_CONFIGURED']。
  const r = await get('/api/usage/alert?limit=100&warn=')
  assert.equal(r.status, 200)
  assert.equal(r.body.configured, false, '空串必须仍然算"没配"')
  assert.deepEqual(r.body.thresholds, {}, '不得把空串变成 0 塞进阈值')
  // ★ 只断言"含 NOT_CONFIGURED"，**不**断言 reasons 恰好等于它：
  //   本套件的夹具里有 7 条金额未知的账，所以还会带上 SPEND_PARTIAL。
  //   （第一版写死了恰好相等 ⇒ 红的是**我的断言**，不是产品。）
  assert.ok(r.body.reasons.includes('NOT_CONFIGURED'),
    `reasons 里必须有 NOT_CONFIGURED，实际 ${JSON.stringify(r.body.reasons)}`)
})

test('⑨ ★ 阈值非法的 400 里 `levels`/`rungs` 必须列全（不只给一个码）', async () => {
  const r = await get('/api/usage/alert?limit=100&warn=0.90&degrade=0.80&block=0.70')
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'THRESHOLDS_UNORDERED')
  assert.deepEqual(r.body.levels, ['ok', 'warn', 'degrade', 'block'])
  assert.deepEqual(r.body.rungs, ['warn', 'degrade', 'block'])
})

test('⑩ 缝级：求值抛**无 code** 的错时兜底码是 `BUDGET_ALERT_FAILED`，且 `levels`/`rungs` 仍在', async () => {
  // 真 HTTP 走不到这条路：`evaluateBudgetAlert` 抛的每个错都带具名码。
  const { createUsageRoutes } = await import('./routes/usage.mjs')
  const res = {}
  let called = 0
  const fam = createUsageRoutes({
    json: (_res, status, body) => { _res.status = status; _res.body = body },
    authorized: () => true,
    db: {},
    optionalIntParam: () => undefined,
    ROLLUP_DIMENSIONS: ['scope'],
    BUDGET_ALERT_CODES: { THRESHOLDS_INVALID: 'THRESHOLDS_INVALID' },
    BUDGET_ALERT_LEVELS: ['ok', 'warn', 'degrade', 'block'],
    BUDGET_ALERT_RUNGS: ['warn', 'degrade', 'block'],
    usageRollup: { usageTotals: () => ({}), rollupBy: () => ({}) },
    evaluateBudgetAlert: () => { called++; throw new Error('没有 code 的错') },
  })
  const url = new URL('http://x/api/usage/alert?limit=100')
  const hit = await fam.dispatch({ method: 'GET' }, res, { path: '/api/usage/alert', url })
  assert.equal(hit, true)
  assert.equal(called, 1, '桩必须真的被调用过')
  assert.equal(res.status, 400)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'BUDGET_ALERT_FAILED')
  assert.deepEqual(res.body.levels, ['ok', 'warn', 'degrade', 'block'])
  assert.deepEqual(res.body.rungs, ['warn', 'degrade', 'block'])
})

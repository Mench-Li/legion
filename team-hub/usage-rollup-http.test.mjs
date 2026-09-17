// team-hub/usage-rollup-http.test.mjs
// ============================================================================
// F-15 汇总的**接线**判据：真 hub 进程 + 真 HTTP。
//
// `usage-rollup.test.mjs` 的 12 例验的是汇总语义。它全绿也可能
// **没有任何 HTTP 面能走到那两个函数**——本仓反复记过的那个形状。
//
// 本组只钉三件只有真接线才有的事：
//   ① 两个只读端点走真 HTTP，且**没有写路径**（"手工记一笔"的后门会把
//      账本里的钱与实际花掉的钱脱钩，而两者看起来一样）；
//   ② 未知维度 → 400 + 具名码 + **可选值清单**（只说"不认识的维度"
//      会让调用方去翻源码）；
//   ③ 空库返回全 0 且 `complete: true` —— 0 在这里是真的 0（它数的是未知条数）。
//
// 夹具**直接往 `usage_records` / `run_attempts` / `tasks` 里写**，
// 不走 `POST /api/budget/*`：那几个端点的入参是"预留/观测/结算"，
// 要造出一条已结算的用量行需要真实的价目表与 attempt 生命周期。
// 本组验的是**读**，所以直接把被读的行放进去；写路径的行为由
// `budget-ledger.test.mjs` / `budget-routes.test.mjs` 各自负责。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-usage-http-'))
let mod
let base = ''
const TOKEN = 'usage-e2e-token'

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
  db.prepare("INSERT INTO tasks (id, title, role, scope, goalId, status) VALUES ('T-1','a','soldier','software','G-1','running')").run()
  db.prepare("INSERT INTO tasks (id, title, role, scope, goalId, status) VALUES ('T-2','b','reviewer','software','G-1','running')").run()
  db.prepare("INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms, finished_at_ms) VALUES ('a1','T-1','software',1,'Validating',1,1000,5000,5000)").run()
  db.prepare("INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms, finished_at_ms) VALUES ('a2','T-2','software',1,'Running',1,1000,6000,NULL)").run()
  const ins = db.prepare(
    `INSERT INTO usage_records
       (attempt_id, scope, task_id, model_profile_id, currency, billing_unit, price_table_version,
        effective_at_ms, tokens_in, tokens_out, estimated_amount, actual_amount, estimate_ok,
        runtime_estimate_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  // a1：两笔（模拟 reserve + settle），模型 m-a，已知金额。
  ins.run('a1', 'software', 'T-1', 'm-a', 'USD', 'per-1k-tokens', 'v1', 1000, 100, 50, 1.0, null, 1, '{}', 1000)
  ins.run('a1', 'software', 'T-1', 'm-a', 'USD', 'per-1k-tokens', 'v1', 1000, 120, 60, null, 1.5, 1, '{}', 5000)
  // a2：一笔，模型**空串**、token 未知（NULL）——"不知道"的那两条。
  //
  // ★ 这里必须是 `''` 而不是 `NULL`：真实 schema 的
  //   `usage_records.model_profile_id` 是 **NOT NULL**（见 `budget-ledger.mjs`），
  //   所以生产上"没记模型"只可能是一个空串。
  //   夹具若写成 `NULL`，它就比生产**更宽松**，用例覆盖的是一个
  //   生产上产生不出来的形状——而"未归属"的判据在真实数据上从未被验过。
  ins.run('a2', 'software', 'T-2', '', 'USD', 'per-1k-tokens', 'v1', 1000, null, null, null, null, 1, '{}', 5000)
  // 一条任务行不存在的用量（T-404）——goal / employee 未知。
  ins.run('a1', 'software', 'T-404', 'm-b', 'USD', 'per-1k-tokens', 'v1', 1000, 10, 5, 0.5, null, 1, '{}', 7000)
}

test('① ★ totals 走真 HTTP：读到五个量的同时读到"不知道的有几条"', async () => {
  const r = await get('/api/usage/totals')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.records, 4)
  assert.equal(r.body.tokensIn, 230, '100+120+10（NULL 那条按 0 加）')
  assert.equal(r.body.tokensOut, 115)
  // ★ 三个"不知道"的邻居必须都在。
  assert.equal(r.body.tokensUnknownRecords, 1, '"没采集到 token"与"用了 0 个"必须分得开')
  // a2 那一笔在**两个轴上都**不知道：没记模型 ⇒ 没价 ⇒ 没金额。
  // 这不是夹具偷懒，而是生产上的因果——`model_profile_id` 空串时
  // `estimateCost` 拿不到价，`estimated_amount` 必然是 NULL。
  // 于是"金额未知条数"与"token 未知条数"在这里必然同时为 1，
  // 而它们**仍然是两个独立的读数**：修法不同（一个查价目表、一个查采集）。
  assert.equal(r.body.amountUnknownRecords, 1, '缺价的那笔没有被数出来')
  assert.equal(typeof r.body.amount, 'number')
  // 逐维度未归属：T-404 那条让 goal/employee 各多一条；model 的 NULL 让 model 多一条。
  assert.equal(r.body.unattributed.model, 1)
  assert.equal(r.body.unattributed.goal, 1)
  assert.equal(r.body.unattributed.employee, 1)
  assert.equal(r.body.unattributed.task, 0)
  // 耗时：只有 a1 结束了（5000-1000=4000）；a2 在跑。
  assert.equal(r.body.attempts, 2)
  assert.equal(r.body.finishedAttempts, 1)
  assert.equal(r.body.inFlightAttempts, 1)
  assert.equal(r.body.durationMs, 4000, '未结束的 Attempt 被算进了耗时')
  assert.equal(r.body.complete, false)
  assert.equal(r.body.mixedCurrency, false)
  assert.equal(r.body.currency, 'USD')
})

test('② ★ rollup 五个维度都通，且各桶金额之和等于总额（没有静默丢弃）', async () => {
  const totals = (await get('/api/usage/totals')).body
  for (const dim of ['scope', 'goal', 'task', 'employee', 'model']) {
    const r = await get(`/api/usage/rollup?dimension=${dim}`)
    assert.equal(r.status, 200, `${dim}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.dimension, dim)
    const sum = r.body.buckets.reduce((a, b) => a + b.amount, 0)
    assert.equal(sum, totals.amount,
      `${dim}：各桶之和 ${sum} ≠ 总额 ${totals.amount} —— 有行掉进了缝里`)
    const recs = r.body.buckets.reduce((a, b) => a + b.records, 0)
    assert.equal(recs, totals.records, `${dim}：笔数之和不等于总笔数`)
    // 未归属桶必须带 attributed:false。
    for (const b of r.body.buckets) {
      assert.equal(b.attributed, b.bucket !== '(未归属)')
    }
  }
  // 具体取值：employee 维度应有 soldier / reviewer / 未归属 三桶。
  const emp = (await get('/api/usage/rollup?dimension=employee')).body
  assert.deepEqual(emp.buckets.map((b) => b.bucket).sort(), ['(未归属)', 'reviewer', 'soldier'])
  // 未归属桶里的那 0.5 与被删任务行对应。
  assert.equal(emp.buckets.find((b) => b.bucket === '(未归属)').amount, 0.5)
  assert.equal(emp.buckets.find((b) => b.bucket === '(未归属)').attributed, false)
  // model 维度的未归属桶装的是"没记模型"的那一笔。
  const mdl = (await get('/api/usage/rollup?dimension=model')).body
  assert.deepEqual(mdl.buckets.map((b) => b.bucket).sort(), ['(未归属)', 'm-a', 'm-b'])
})

test('③ ★ 未知维度 → 400 + 具名码 + 可选值清单（不许只回一句"不认识"）', async () => {
  const r = await get('/api/usage/rollup?dimension=employeeName')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'BAD_ROLLUP_DIMENSION')
  assert.deepEqual(r.body.dimensions, ['scope', 'goal', 'task', 'employee', 'model'],
    '未知维度没有回可选值 —— 调用方只能去翻源码')
  // 缺 dimension 也是同一个码（而不是静默按某个默认维度汇总）。
  const missing = await get('/api/usage/rollup')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'BAD_ROLLUP_DIMENSION')
})

test('④ 时间窗与 scope 过滤走真 HTTP；非法值**不折叠成 0**', async () => {
  const all = (await get('/api/usage/totals')).body
  assert.equal(all.records, 4)
  // T-404 那条的 created_at_ms 是 7000。
  const since = (await get('/api/usage/totals?sinceMs=6000')).body
  assert.equal(since.records, 1)
  const until = (await get('/api/usage/totals?untilMs=6000')).body
  assert.equal(until.records, 3)
  // ★ 非法值 ⇒ 不设限（而不是 sinceMs=0"从纪元开始"这个**合法且极端**的取值）。
  //   两者在结果上恰好都是 4 条，所以判据要看**它是不是被当成了 0**：
  //   传一个不可能有数据的荒谬值，结果必须为空——那说明滤器真的生效了。
  const huge = (await get('/api/usage/totals?sinceMs=999999999999')).body
  assert.equal(huge.records, 0, 'sinceMs 没有被当成过滤条件')
  const bogus = (await get('/api/usage/totals?sinceMs=abc')).body
  assert.equal(bogus.records, 4, '非法值被折叠成了别的取值（应当=不设限）')
  // scope 过滤。
  assert.equal((await get('/api/usage/totals?scope=software')).body.records, 4)
  assert.equal((await get('/api/usage/totals?scope=nope')).body.records, 0)
  const scoped = await get('/api/usage/rollup?dimension=model&scope=nope')
  assert.equal(scoped.body.buckets.length, 0)
})

test('⑤ ★ 只读：两个端点都没有写路径，且响应里没有"记一笔"的后门', async () => {
  for (const p of ['/api/usage/totals', '/api/usage/rollup?dimension=scope']) {
    const r = await fetch(base + p, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })
    assert.ok(r.status === 404 || r.status === 405,
      `${p} 接受了 POST（${r.status}）—— 一条"手工记一笔"的后门会让账本里的钱`
      + '与实际花掉的钱脱钩，而两者看起来一样')
  }
  // 结构级对照：本模块本身也没有任何写路径。
  const src = readFileSync(join(HERE, 'usage-rollup.mjs'), 'utf8')
  for (const forbidden of ['INSERT ', 'UPDATE ', 'DELETE ', 'db.exec']) {
    assert.equal(src.includes(forbidden), false, `usage-rollup.mjs 里出现了 ${forbidden}`)
  }
  // 未授权一律 401。
  for (const p of ['/api/usage/totals', '/api/usage/rollup?dimension=scope']) {
    assert.equal((await fetch(base + p)).status, 401, `${p} 没有鉴权`)
  }
})

test('⑥ 空库：全 0 且 complete:true（0 在这里是真的 0）', async () => {
  // 用一个不存在的 scope 造出"空"的读数——不删数据，避免影响上面的用例。
  const r = await get('/api/usage/totals?scope=空的空间')
  assert.equal(r.status, 200)
  assert.equal(r.body.records, 0)
  assert.equal(r.body.tokensUnknownRecords, 0)
  assert.equal(r.body.amountUnknownRecords, 0)
  assert.equal(r.body.complete, true,
    '空库被报成"数据不完整"—— 那会让第一次打开报表的人以为系统出错了')
  assert.equal(r.body.attempts, 0)
  assert.equal(r.body.inFlightAttempts, 0)
  const roll = await get('/api/usage/rollup?dimension=goal&scope=空的空间')
  assert.equal(roll.body.buckets.length, 0)
  assert.deepEqual([...roll.body.mixedCurrencyBuckets], [])
})

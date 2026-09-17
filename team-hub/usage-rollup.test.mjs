// team-hub/usage-rollup.test.mjs
// ============================================================================
// F-15 汇总的判据：**五个维度 × 四个量，而且每一个数字都有"不知道"的邻居**。
//
// 这一组验的不是"能不能求和"——那是 SQL 的事。它验的是**每一个会把
// "不知道"写成 0 的地方**都被挡住了：
//
//   ① NULL token 不是 0（`SUM` 会把它当 0 加进去）
//   ② 缺价的金额不是 0（算进去会**低估**总成本，而报表看着正常）
//   ③ 未结束的 Attempt 没有耗时（用 now-created 顶替会把"卡住"画成"在跑"）
//   ④ 未归属维度进显式桶且 `attributed:false`（丢掉它们会让各维度之和不等于总额）
//   ⑤ 混币种的金额之和**没有意义**，必须报出来而不是替调用方换算
//   ⑥ 耗时不许多算：一条 Attempt 有 N 条用量记录时仍只算一次
//      —— 这是本模块第一版真的写错的地方，用例把它钉住
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROLLUP_DIMENSIONS,
  UNATTRIBUTED,
  rollupBy,
  usageTotals,
} from './usage-rollup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 夹具刻意手写两张最小表，而**不**去 import `budget-ledger` / `run-store`：
 * 那两个模块各自建十几张表，而且它们的 schema 会随版本变。
 * 本模块只认识这几列，夹具照抄自己需要的那几列，改动面最小。
 */
function makeEnv() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, role TEXT, scope TEXT DEFAULT 'default', goalId TEXT
    )
  `)
  db.exec(`
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL, scope TEXT NOT NULL, task_id TEXT NOT NULL,
      -- model_profile_id 是 NOT NULL，与真实 schema 一致（见 budget-ledger.mjs
      -- 的建表语句）。夹具若把它写成可空，就比生产更宽松：那份用例会覆盖一个
      -- 生产上产生不出来的形状（NULL 模型），而真实数据里"没记模型"的样子
      -- 其实是一个空串——两者要靠同一个判据兜住。
      model_profile_id TEXT NOT NULL, currency TEXT NOT NULL,
      tokens_in INTEGER, tokens_out INTEGER,
      estimated_amount REAL, actual_amount REAL,
      estimate_ok INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE run_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default',
      state TEXT NOT NULL DEFAULT 'Running', created_at_ms INTEGER NOT NULL, finished_at_ms INTEGER
    )
  `)
  let uid = 0
  const usage = ({ attemptId = `a${uid}`, scope = 'software', taskId = 'T-1', model = 'm-1', currency = 'USD', tokensIn = 100, tokensOut = 50, estimatedAmount = 1, actualAmount = null, createdAtMs = 1000 } = {}) => {
    uid += 1
    db.prepare(
      `INSERT INTO usage_records
         (attempt_id, scope, task_id, model_profile_id, currency, tokens_in, tokens_out,
          estimated_amount, actual_amount, estimate_ok, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(attemptId, scope, taskId, model, currency, tokensIn, tokensOut, estimatedAmount, actualAmount, 1, createdAtMs)
  }
  const attempt = ({ id, taskId = 'T-1', scope = 'software', createdAtMs = 1000, finishedAtMs = 2000 }) => {
    db.prepare('INSERT INTO run_attempts (id, task_id, scope, state, created_at_ms, finished_at_ms) VALUES (?,?,?,?,?,?)')
      .run(id, taskId, scope, finishedAtMs === null ? 'Running' : 'Validating', createdAtMs, finishedAtMs)
  }
  const task = ({ id, role = 'soldier', scope = 'software', goalId = 'G-1' }) => {
    db.prepare('INSERT INTO tasks (id, role, scope, goalId) VALUES (?,?,?,?)').run(id, role, scope, goalId)
  }
  return { db, usage, attempt, task, dispose: () => { try { db.close() } catch { /* 已关 */ } } }
}

// ---------------------------------------------------------------- ① 维度

test('① 五个维度都认；不认识的维度名**具名拒绝**（不落进一个永远为空的桶）', () => {
  assert.deepEqual([...ROLLUP_DIMENSIONS], ['scope', 'goal', 'task', 'employee', 'model'])
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    env.usage({})
    for (const d of ROLLUP_DIMENSIONS) {
      const r = rollupBy({ db: env.db, dimension: d })
      assert.equal(r.buckets.length, 1, `${d} 维度没有取到那一格`)
    }
    assert.throws(() => rollupBy({ db: env.db, dimension: 'employeeName' }),
      (e) => e.code === 'BAD_ROLLUP_DIMENSION',
      '不认识的维度名被接受了 —— 报表会显示成功，而那一格永远是空的')
  } finally { env.dispose() }
})

test('② 五个维度各自取到正确的值（scope/goal/task/employee/model）', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1', role: 'reviewer', goalId: 'G-7' })
    env.task({ id: 'T-2', role: 'soldier', goalId: 'G-7' })
    env.usage({ taskId: 'T-1', scope: 'software', model: 'm-a' })
    env.usage({ taskId: 'T-2', scope: 'software', model: 'm-b' })
    const pick = (d) => rollupBy({ db: env.db, dimension: d }).buckets.map((b) => b.bucket).sort()
    assert.deepEqual(pick('scope'), ['software'])
    assert.deepEqual(pick('goal'), ['G-7'])
    assert.deepEqual(pick('task'), ['T-1', 'T-2'])
    assert.deepEqual(pick('employee'), ['reviewer', 'soldier'])
    assert.deepEqual(pick('model'), ['m-a', 'm-b'])
  } finally { env.dispose() }
})

test('③ ★ 未归属进显式桶且 attributed:false（丢掉会让各维度之和不等于总额）', () => {
  const env = makeEnv()
  try {
    // T-1 有归属；T-9 的任务行**不存在**（被删了或从来没建过）。
    env.task({ id: 'T-1', role: 'soldier', goalId: 'G-1' })
    env.usage({ taskId: 'T-1', estimatedAmount: 3 })
    env.usage({ taskId: 'T-9', estimatedAmount: 7 })
    for (const d of ['goal', 'employee']) {
      const r = rollupBy({ db: env.db, dimension: d })
      const un = r.buckets.find((b) => b.bucket === UNATTRIBUTED)
      assert.ok(un !== undefined, `${d} 维度下未归属的行被静默丢掉了`)
      assert.equal(un.attributed, false, `${d}：未归属桶没有 attributed:false`)
      assert.equal(un.amount, 7)
      // 各桶之和必须等于总额——这是"没有静默丢弃"的算术判据。
      const sum = r.buckets.reduce((a, b) => a + b.amount, 0)
      assert.equal(sum, 10, `${d}：各桶之和 ${sum} ≠ 总额 10，说明有行掉进了缝里`)
    }
    // scope 维度上 T-9 那一行是**有**归属的（scope 来自 usage_records 自己）。
    const sc = rollupBy({ db: env.db, dimension: 'scope' })
    assert.equal(sc.buckets.length, 1)
    assert.equal(sc.buckets[0].amount, 10)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ② NULL 不是 0

test('④ ★ NULL token 不是 0：未知条数被单独数出来', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    env.usage({ tokensIn: 100, tokensOut: 50 })
    env.usage({ tokensIn: null, tokensOut: null })   // 没采集到
    const b = rollupBy({ db: env.db, dimension: 'model' }).buckets[0]
    assert.equal(b.tokensIn, 100, 'SUM 把 NULL 当 0 加是对的，但……')
    assert.equal(b.tokensOut, 50)
    // ……必须同时告诉你"有 1 行不知道"。
    // 口径是**记账行数**：一条行里 tokens_in / tokens_out 任一为 NULL 就算
    // 这一行的 token 不知道。第一版 rollupBy 数的是**列数**（2），
    // 而 usageTotals 数的是行数（1）——同一个字段名在两个入口差一倍，
    // 而两个数各自都是对的。
    assert.equal(b.tokensUnknownRecords, 1,
      '未知 token 条数没有报出来 —— "没采集到"与"用了 0 个"在报表上同形')
    assert.equal(b.records, 2)
    const t = usageTotals({ db: env.db })
    assert.equal(t.tokensUnknownRecords, 1, '两个入口的行数口径必须一致')
    assert.equal(t.complete, false, '有一项不知道，complete 必须为 false')
  } finally { env.dispose() }
})

test('⑤ ★ 缺价的金额不是 0：算进去会低估总成本，而报表看着正常', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    env.usage({ estimatedAmount: 2, actualAmount: 3 })
    env.usage({ estimatedAmount: null, actualAmount: null })   // 价目表里没有这个模型
    const b = rollupBy({ db: env.db, dimension: 'model' }).buckets[0]
    assert.equal(b.amount, 3, '有实际金额时取实际金额')
    assert.equal(b.amountUnknownRecords, 1, '缺价的那条没有被数出来 —— 总成本会被低估而看不出来')
    const t = usageTotals({ db: env.db })
    assert.equal(t.amount, 3)
    assert.equal(t.amountUnknownRecords, 1)
    assert.equal(t.complete, false)
    // 反向对照：全部已知时 complete 为 true。
    const env2 = makeEnv()
    try {
      env2.task({ id: 'T-1' })
      env2.usage({ estimatedAmount: 2 })
      assert.equal(usageTotals({ db: env2.db }).complete, true)
      assert.equal(usageTotals({ db: env2.db }).tokensUnknownRecords, 0)
    } finally { env2.dispose() }
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ③ 耗时

test('⑥ ★ 未结束的 Attempt 没有耗时：inFlight 单独数，**不与已结束的相加**', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    env.usage({ attemptId: 'a1' })
    env.usage({ attemptId: 'a2' })
    env.attempt({ id: 'a1', createdAtMs: 1000, finishedAtMs: 4000 })   // 3s
    env.attempt({ id: 'a2', createdAtMs: 1000, finishedAtMs: null })   // 还在跑
    const b = rollupBy({ db: env.db, dimension: 'scope' }).buckets[0]
    assert.equal(b.finishedAttempts, 1)
    assert.equal(b.inFlightAttempts, 1,
      '未结束的 Attempt 没有被单独数出来 —— 用 now-created 顶替会把它画成"正在跑的长耗时"')
    assert.equal(b.durationMs, 3000, '耗时把未结束的那条也算进去了')
    const t = usageTotals({ db: env.db })
    assert.equal(t.attempts, 2)
    assert.equal(t.finishedAttempts, 1)
    assert.equal(t.inFlightAttempts, 1)
    assert.equal(t.durationMs, 3000)
  } finally { env.dispose() }
})

test('⑦ ★★ 耗时不许按"记账次数"重复计算（一条 Attempt 有 N 条用量记录仍只算一次）', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    // 同一条 Attempt 记了 3 笔账（reserve / observe / settle 各一笔——
    // 那是 `budget-ledger.mjs` 的真实行为）。
    env.usage({ attemptId: 'a1', estimatedAmount: 1 })
    env.usage({ attemptId: 'a1', estimatedAmount: 1 })
    env.usage({ attemptId: 'a1', estimatedAmount: 1 })
    env.attempt({ id: 'a1', createdAtMs: 1000, finishedAtMs: 5000 })   // 4s
    const b = rollupBy({ db: env.db, dimension: 'scope' }).buckets[0]
    assert.equal(b.records, 3, '用量笔数应该是 3')
    assert.equal(b.finishedAttempts, 1, 'Attempt 数应该是 1')
    assert.equal(b.durationMs, 4000,
      `耗时是 ${b.durationMs} 而不是 4000 —— JOIN 到 usage_records 之后每条尝试被算了 3 遍。`
      + '这个错误在"每条尝试恰好只记一笔"的时候完全看不出来')
    assert.equal(usageTotals({ db: env.db }).durationMs, 4000)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ④ 币种

test('⑧ ★ 混币种时金额之和没有意义：必须报出来，不许替调用方换算', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    env.usage({ currency: 'USD', estimatedAmount: 1 })
    env.usage({ currency: 'CNY', estimatedAmount: 100 })
    const b = rollupBy({ db: env.db, dimension: 'scope' }).buckets[0]
    assert.equal(b.mixedCurrency, true)
    assert.equal(b.currency, null, '混币种时报了一个币种 —— 读的人会把 101 当成 101 美元')
    const r = rollupBy({ db: env.db, dimension: 'scope' })
    assert.deepEqual([...r.mixedCurrencyBuckets], ['software'],
      '哪几格混了币种必须能被一眼看见（它是读这张表之前的前置条件）')
    const t = usageTotals({ db: env.db })
    assert.equal(t.mixedCurrency, true)
    assert.equal(t.complete, false, '混币种时 complete 必须为 false')
    // 反向对照：单一币种时不报。
    const env2 = makeEnv()
    try {
      env2.task({ id: 'T-1' })
      env2.usage({ currency: 'USD', estimatedAmount: 1 })
      env2.usage({ currency: 'USD', estimatedAmount: 2 })
      const b2 = rollupBy({ db: env2.db, dimension: 'scope' }).buckets[0]
      assert.equal(b2.mixedCurrency, false)
      assert.equal(b2.currency, 'USD')
      assert.equal(b2.amount, 3)
    } finally { env2.dispose() }
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ⑤ 过滤与总账

test('⑨ 时间窗与 scope 过滤：窗口用**记账时刻**，不是任务创建时刻', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1' })
    env.task({ id: 'T-2' })
    env.usage({ taskId: 'T-1', scope: 'software', createdAtMs: 1000, estimatedAmount: 1 })
    env.usage({ taskId: 'T-2', scope: 'ozon', createdAtMs: 5000, estimatedAmount: 2 })
    assert.equal(usageTotals({ db: env.db }).records, 2)
    assert.equal(usageTotals({ db: env.db, sinceMs: 2000 }).records, 1)
    assert.equal(usageTotals({ db: env.db, untilMs: 2000 }).records, 1)
    assert.equal(usageTotals({ db: env.db, scope: 'ozon' }).amount, 2)
    assert.equal(rollupBy({ db: env.db, dimension: 'scope' }).buckets.length, 2)
    assert.equal(rollupBy({ db: env.db, dimension: 'scope', scope: 'ozon' }).buckets.length, 1)
  } finally { env.dispose() }
})

test('⑩ usageTotals 逐维度报未归属条数（一个模型未知不代表员工也未知）', () => {
  const env = makeEnv()
  try {
    env.task({ id: 'T-1', role: 'soldier', goalId: 'G-1' })
    // 两行：任务存在、员工已知，但**模型是空串**（生产上模型未知只有这一种写法，
    // 因为那一列是 NOT NULL）。
    env.usage({ taskId: 'T-1', model: '' })
    env.usage({ taskId: 'T-1', model: '' })
    // 一行：模型已知，但任务行不存在 ⇒ employee / goal 不知道。
    env.usage({ taskId: 'T-404', model: 'm-1' })
    const t = usageTotals({ db: env.db })
    assert.equal(t.unattributed.model, 2, 'model 维度下应有两条未归属')
    assert.equal(t.unattributed.employee, 1, 'employee 维度下应有一条未归属')
    assert.equal(t.unattributed.goal, 1)
    assert.equal(t.unattributed.task, 0, 'task_id 是 usage_records 自己的列，不该有未归属')
    assert.equal(t.unattributed.scope, 0)
    // ★ 必须**逐维度分开数**。合成一个"未归属条数"（这里是 3）会让
    //   "模型没记"与"任务行不在"互相掩盖——两者的修法完全不同。
    assert.notEqual(t.unattributed.model, t.unattributed.employee)
    // 反向对照：空串确实落进了未归属桶（而不是一个叫 "" 的桶）。
    const r = rollupBy({ db: env.db, dimension: 'model' })
    assert.equal(r.buckets.some((b) => b.bucket === ''), false, '出现了一个叫空串的桶')
    const un = r.buckets.find((b) => b.bucket === UNATTRIBUTED)
    assert.equal(un.attributed, false)
    assert.equal(un.records, 2)
  } finally { env.dispose() }
})

test('⑪ 空库：全是 0 且 complete 为 true（0 在这里是**真的 0**，它数的是未知条数）', () => {
  const env = makeEnv()
  try {
    const t = usageTotals({ db: env.db })
    assert.equal(t.records, 0)
    assert.equal(t.tokensUnknownRecords, 0)
    assert.equal(t.amountUnknownRecords, 0)
    assert.equal(t.complete, true, '空库不该被报成"数据不完整"——那会让第一次打开报表的人以为出错了')
    assert.equal(rollupBy({ db: env.db, dimension: 'model' }).buckets.length, 0)
  } finally { env.dispose() }
})

test('⑫ 结构级对照：耗时查询**不许**复用用量的 WHERE / JOIN（那是重复计算的写法）', () => {
  const src = readFileSync(join(HERE, 'usage-rollup.mjs'), 'utf8')
  // 耗时那一段必须用 `a.` 前缀的参数与独立的 attemptArgs。
  const durStart = src.indexOf('const durationRows')
  const durEnd = src.indexOf('const durationOf')
  const dur = src.slice(durStart, durEnd)
  assert.ok(dur.length > 0)
  assert.match(dur, /attemptArgs/, '耗时查询没有用自己的参数集')
  assert.equal(/JOIN\s+usage_records\s+u\s+ON/.test(dur), false,
    '耗时查询 JOIN 到了 usage_records —— 一条 Attempt 记 N 笔账就会被算 N 次，'
    + '而"每条恰好记一笔"的时候完全看不出来')
  assert.equal(/\$\{whereSql\}/.test(dur), false, '耗时查询复用了用量的 WHERE')
  // 而用量那一段必须 LEFT JOIN tasks（丢了任务行也不能让钱从账上消失）。
  const useStart = src.indexOf('const groupRows')
  const useEnd = src.indexOf('// ── 耗时')
  assert.match(src.slice(useStart, useEnd), /LEFT JOIN tasks/, '用量查询没有 LEFT JOIN tasks')
})

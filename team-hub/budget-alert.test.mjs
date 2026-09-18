// team-hub/budget-alert.test.mjs
// ============================================================================
// F-15 告警 / 降级那一半的判据。
//
// 这一组验的**不是**"数字比大小"——那是 `>=` 的事。它验的是
// **每一处会把"不知道"读成"没事"的地方都被挡住了**：
//
//   ① 已知花费 0 元 + 7 条账目金额未知 ⇒ 不许报"一切正常"
//   ② 没配阈值 ⇒ 不许报"一切正常"（"没配告警"与"一切正常"必须分得开）
//   ③ 没给上限 ⇒ **抛**，不许落回默认值
//   ④ 混币种的金额之和没有意义 ⇒ `confidence: unknown`，且**不**换算
//   ⑤ 不认识的阈值名 ⇒ 抛（静默忽略会让"配了"与"没配"同形）
//   ⑥ 阈值不递增 ⇒ 抛（顺序反了时降级那级永远不被观察到）
//   ⑦ 恰好等于阈值 ⇒ **触发**（配置者最想它动作的就是那一次）
//
// ★ 并且要能证伪：把上面任何一条的守卫拆掉，都有一条用例会红。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUDGET_ALERT_ACTIONS,
  BUDGET_ALERT_CODES,
  BUDGET_ALERT_CONFIDENCE,
  BUDGET_ALERT_LEVELS,
  BUDGET_ALERT_REASONS,
  BUDGET_ALERT_RUNGS,
  evaluateBudgetAlert,
  selfCheckBudgetAlert,
} from './budget-alert.mjs'
import { usageTotals } from './usage-rollup.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一份"什么都不知道"都没有的 totals。各用例只覆盖自己关心的那一项。 */
const clean = (amount, extra = {}) => ({
  amount,
  records: 1,
  amountUnknownRecords: 0,
  mixedCurrency: false,
  currency: 'USD',
  ...extra,
})

const LIMIT = Object.freeze({ amount: 100, currency: 'USD' })
const TH = Object.freeze({ warn: 0.5, degrade: 0.8, block: 1.0 })

const ev = (amount, extra = {}, over = {}) => evaluateBudgetAlert({
  totals: clean(amount, extra), limit: LIMIT, thresholds: TH, degradeTo: 'cheap-model', ...over,
})

// ══════════════════════════════════════════════════════════════════════════
// ① 正对照：四级**每一级都到得了**
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 四个等级各由一个样本到达（正对照：这个判据不是恒绿）', () => {
  const seen = {
    ok: ev(10).level,
    warn: ev(60).level,
    degrade: ev(85).level,
    block: ev(120).level,
  }
  assert.deepEqual(seen, { ok: 'ok', warn: 'warn', degrade: 'degrade', block: 'block' },
    '四级没有各到达一次。★ 一个只会返回 ok 的实现在这组用例里看起来完全正常——'
    + '而它的表现恰好是**预算告警从来不响**')
  // 每一级的动作也必须逐级变严
  assert.equal(ev(10).action, 'none')
  assert.equal(ev(60).action, 'review')
  assert.equal(ev(85).action, 'degrade-model')
  assert.equal(ev(120).action, 'block-new-runs')
})

test('①b ★★★ 反向对照：金额**一个字节都没动**，只有"不知道"变了 ⇒ allClear 必须翻', () => {
  // 这是本模块存在的全部理由。两个样本的 `amount` 都是 0（离上限 100 很远），
  // 唯一差别是"有几条账目金额未知"。
  const exact = ev(0, { records: 7, amountUnknownRecords: 0 })
  const blind = ev(0, { records: 7, amountUnknownRecords: 7 })

  assert.equal(exact.allClear, true, '前提对照：账目齐全、花费为 0 ⇒ 应当放行')
  assert.equal(blind.allClear, false,
    '★ 有 7 条账目金额未知时仍然报"一切正常"。'
    + '一个"离上限还远"的绿，与一个"有 7 笔账不知道多少钱"的绿，是一模一样的绿——'
    + '只不过前者的绿是真的')
  // ★ 并且要说清它**为什么**不是绿的：level 仍然是 ok（已知金额确实是 0），
  //   翻的是 confidence 与 action。这正是把两件事分开报的意义。
  assert.equal(blind.level, 'ok', 'level 只由**已知金额**算 —— 这里确实是 0')
  assert.equal(blind.confidence, 'unknown', '全部账目都未知 ⇒ unknown，不是 partial')
  assert.notEqual(blind.action, 'none',
    '★ 规则 1：confidence 不是 exact 时，action **永远不许是 none**')
  assert.ok(blind.reasons.includes('SPEND_UNKNOWN'))
})

test('①c ★★★ 反向对照：把阈值拿掉 ⇒ level 仍是 ok，而 allClear 必须变成 false', () => {
  const noTh = evaluateBudgetAlert({ totals: clean(0), limit: LIMIT, thresholds: null })
  assert.equal(noTh.configured, false)
  assert.equal(noTh.level, 'ok', '没有阈值可跨 ⇒ 已知花费这一维确实是 ok')
  assert.equal(noTh.allClear, false,
    '★ "没配告警"与"一切正常"被读成了同一个东西。'
    + '一个不报的告警与一个没有的告警，在"它有没有救过我"这件事上是同一个回答')
  assert.ok(noTh.reasons.includes('NOT_CONFIGURED'))
  assert.notEqual(noTh.action, 'none')
})

test('①d partial：知道一部分时是 partial，而不是 unknown、也不是 exact', () => {
  const r = ev(30, { records: 10, amountUnknownRecords: 3 })
  assert.equal(r.confidence, 'partial')
  assert.equal(r.allClear, false)
  assert.equal(r.unknownRecords, 3)
  assert.ok(r.reasons.includes('SPEND_PARTIAL'))
  // 三个值必须**互不相同**：把它们合并成一个"够不够准"的布尔，
  // 就等于把"完全不知道"与"差三条"读成同一件事。
  assert.equal(new Set(BUDGET_ALERT_CONFIDENCE).size, 3)
})

// ══════════════════════════════════════════════════════════════════════════
// ② 不发明上限
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 没给上限 ⇒ **抛**，不许落回任何默认值', () => {
  for (const bad of [undefined, null]) {
    assert.throws(() => evaluateBudgetAlert({ totals: clean(1), limit: bad, thresholds: TH }),
      (e) => e.code === BUDGET_ALERT_CODES.LIMIT_REQUIRED,
      `limit=${JSON.stringify(bad)} 没有抛 LIMIT_REQUIRED。`
      + '一个"没配上限所以按 0 处理"的实现，会让每一道预算告警在没配的时候报绿')
  }
  // ★ 而出错的那一下**不许**返回一个看起来正常的读数
  assert.throws(() => evaluateBudgetAlert({ totals: clean(1), thresholds: TH }))
})

test('②b 上限金额非法（0 / 负 / NaN / 字符串）⇒ 抛 LIMIT_INVALID', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
    assert.throws(
      () => evaluateBudgetAlert({ totals: clean(1), limit: { amount: bad, currency: 'USD' }, thresholds: TH }),
      (e) => e.code === BUDGET_ALERT_CODES.LIMIT_INVALID,
      `上限 ${JSON.stringify(bad)} 没有被拒。`
      + '0 会让**每一次**求值都跨线（比任何比例都大）；NaN 会让所有比较为假 ⇒ 永远 ok')
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 阈值的三条拒绝 + 边界
// ══════════════════════════════════════════════════════════════════════════

test('③ ★ 不认识的阈值名 ⇒ 抛（静默忽略会让"我配了它"与"没配"同形）', () => {
  assert.throws(
    () => evaluateBudgetAlert({ totals: clean(1), limit: LIMIT, thresholds: { warning: 0.5 } }),
    (e) => e.code === BUDGET_ALERT_CODES.THRESHOLDS_INVALID,
    '`warning`（多了个 ing）被静默忽略了 —— 于是配置者以为自己配了告警，而系统里没有它')
})

test('③b 比例越界（0 / >1 / 非数）⇒ 抛 THRESHOLD_OUT_OF_RANGE / THRESHOLDS_INVALID', () => {
  assert.throws(
    () => evaluateBudgetAlert({ totals: clean(1), limit: LIMIT, thresholds: { warn: 0 } }),
    (e) => e.code === BUDGET_ALERT_CODES.THRESHOLD_OUT_OF_RANGE,
    '0 会让每一次求值都触发')
  assert.throws(
    () => evaluateBudgetAlert({ totals: clean(1), limit: LIMIT, thresholds: { warn: 1.5 } }),
    (e) => e.code === BUDGET_ALERT_CODES.THRESHOLD_OUT_OF_RANGE,
    '> 1 会让这一级**永远不触发**——而一个永远不触发的告警与没有它是一样的')
  assert.throws(
    () => evaluateBudgetAlert({ totals: clean(1), limit: LIMIT, thresholds: { warn: '0.5' } }),
    (e) => e.code === BUDGET_ALERT_CODES.THRESHOLDS_INVALID)
})

test('③c ★ 阈值不严格递增 ⇒ 抛（顺序反了时降级那级永远不被观察到）', () => {
  assert.throws(
    () => evaluateBudgetAlert({ totals: clean(1), limit: LIMIT, thresholds: { warn: 0.8, degrade: 0.5 } }),
    (e) => e.code === BUDGET_ALERT_CODES.THRESHOLDS_UNORDERED)
  assert.throws(
    () => evaluateBudgetAlert({ totals: clean(1), limit: LIMIT, thresholds: { warn: 0.5, degrade: 0.5 } }),
    (e) => e.code === BUDGET_ALERT_CODES.THRESHOLDS_UNORDERED,
    '相等也要拒：两级的边界重合时，"降级"永远不会是那个被观察到的等级')
  // 只配一级是**合法**的（不是所有部署都要三级），不能被上面的规则误伤
  const only = evaluateBudgetAlert({ totals: clean(90), limit: LIMIT, thresholds: { block: 0.5 } })
  assert.equal(only.configured, true)
  assert.equal(only.level, 'block')
})

test('③d ★ 恰好等于阈值 ⇒ **触发**（`>=` 而不是 `>`）', () => {
  const r = ev(50) // warn = 0.5，恰好等于
  assert.equal(r.ratio, 0.5)
  assert.equal(r.level, 'warn',
    '恰好等于阈值时没有触发。★ 阈值就是"到这条线就开始动作"，'
    + '用 `>` 会让恰好等于的那一次不动作——而那是配置者最想它动作的一次')
  assert.equal(ev(80).level, 'degrade', 'degrade = 0.8，恰好等于')
  assert.equal(ev(100).level, 'block', 'block = 1.0，恰好等于')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 币种：不换算
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 混币种 ⇒ confidence unknown（金额之和没有意义），且**不**换算', () => {
  const r = ev(30, { mixedCurrency: true, currency: null })
  assert.equal(r.confidence, 'unknown')
  assert.equal(r.allClear, false)
  assert.ok(r.reasons.includes('MIXED_CURRENCY'))
  // ★ 关键：不许出现任何"换算后"的字段。出现了就说明有人在偷偷引入汇率。
  const keys = Object.keys(r).join(' ')
  for (const forbidden of ['fx', 'rate', 'converted', 'normalized']) {
    assert.ok(!keys.includes(forbidden),
      `读数里出现了 ${forbidden} 字段 ⇒ 有人在替调用方换算。`
      + '汇率是一个会随时间变的外部事实，告警不该偷偷引入它')
  }
})

test('④b 币种对不上 ⇒ 抛 CURRENCY_MISMATCH', () => {
  assert.throws(
    () => evaluateBudgetAlert({
      totals: clean(1, { currency: 'CNY' }), limit: { amount: 100, currency: 'USD' }, thresholds: TH,
    }),
    (e) => e.code === BUDGET_ALERT_CODES.CURRENCY_MISMATCH,
    '拿 USD 的上限去比 CNY 的花费，比出来的比例没有任何意义')
  // 上限不写币种是允许的（那就用用量那边的币种）
  const noCcy = evaluateBudgetAlert({ totals: clean(10), limit: { amount: 100 }, thresholds: TH })
  assert.equal(noCcy.currency, 'USD')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 降级目标：不发明
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★ 降级那级触发了而没人给目标 ⇒ 具名报出，而不是替调用方挑一个便宜的', () => {
  const noTarget = evaluateBudgetAlert({
    totals: clean(85), limit: LIMIT, thresholds: TH, degradeTo: null,
  })
  assert.equal(noTarget.action, 'degrade-model')
  assert.equal(noTarget.degradeTo, null)
  assert.ok(noTarget.reasons.includes('DEGRADE_TARGET_UNSET'),
    '说了要降级、却没说降到哪 —— 这件事必须显式报出来。'
    + '★ 一个"说了降级但没人知道降到哪"的告警，与一个没有降级配置的告警，'
    + '在读数上是同一个东西，只不过前者看起来已经处理过了')
  // 给了目标就原样回传，本模块不校验它（那是模型档案那边的事）
  assert.equal(ev(85).degradeTo, 'cheap-model')
  assert.ok(!ev(85).reasons.includes('DEGRADE_TARGET_UNSET'))
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ direction：只报，不防抖
// ══════════════════════════════════════════════════════════════════════════

test('⑥ 方向：只报读数，不在这里做防抖（防抖是有状态的事）', () => {
  assert.equal(ev(85, {}, { previousLevel: 'warn' }).direction, 'escalating')
  assert.equal(ev(60, {}, { previousLevel: 'degrade' }).direction, 'de-escalating')
  assert.equal(ev(60, {}, { previousLevel: 'warn' }).direction, 'steady')
  assert.equal(ev(60).direction, 'unknown', '没给上一次 ⇒ 方向就是"不知道"，不许猜成 steady')
  assert.throws(
    () => ev(60, {}, { previousLevel: 'critical' }),
    (e) => e.code === BUDGET_ALERT_CODES.PREVIOUS_LEVEL_INVALID)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 形状纪律：封闭集合、纯函数、不写库、不读环境
// ══════════════════════════════════════════════════════════════════════════

test('⑦ reasons 里的每一个都在封闭集合里（不许出现临时拼的理由串）', () => {
  const samples = [
    ev(10), ev(60), ev(85), ev(120),
    ev(0, { records: 7, amountUnknownRecords: 7 }),
    ev(30, { records: 3, amountUnknownRecords: 1 }),
    ev(30, { mixedCurrency: true, currency: null }),
    evaluateBudgetAlert({ totals: clean(0), limit: LIMIT, thresholds: null }),
    evaluateBudgetAlert({ totals: clean(85), limit: LIMIT, thresholds: TH, degradeTo: null }),
  ]
  for (const s of samples) {
    for (const r of s.reasons) {
      assert.ok(BUDGET_ALERT_REASONS.includes(r),
        `理由 ${JSON.stringify(r)} 不在 BUDGET_ALERT_REASONS 里 ⇒ 读的人无法据此分支`)
    }
  }
  // 并且封闭集合里的每一条都**真的出现过**——否则它是一条死条目，
  // 而"有 9 种理由"这个数与实际能发生的理由是两回事。
  const seen = new Set(samples.flatMap((s) => s.reasons))
  for (const r of BUDGET_ALERT_REASONS) {
    assert.ok(seen.has(r), `理由 ${r} 声明了却从来没有样本能触发它 ⇒ 它是一条没人验证过的分支`)
  }
})

test('⑦b 纯函数：除时间戳外可重复；源码里不写库、不读环境', () => {
  const a = ev(85)
  const b = ev(85)
  const strip = (r) => JSON.stringify({ ...r, serverTimeMs: 0 })
  assert.equal(strip(a), strip(b), '同样的输入给出不同的读数 ⇒ 这一层有隐藏状态')

  const src = readFileSync(resolve(ROOT, 'team-hub', 'budget-alert.mjs'), 'utf8')
  for (const forbidden of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'process.env', 'Date.now()']) {
    // `serverTimeMs: Date.now()` 是唯一的例外（它就是"读数是什么时候取的"）
    if (forbidden === 'Date.now()') continue
    assert.ok(!src.includes(forbidden),
      `源码里出现了 ${JSON.stringify(forbidden)}。`
      + '★ 这一层刻意**只**消费 `usageTotals()` 给的数：告警与报表必须看同一份数，'
      + '否则"报表说 3 元、告警说 5 元"是迟早的事；读 env 则会让"上限从哪来"出现第二个答案')
  }
  // 返回的对象是冻结的（防止调用方就地改一个字段之后交给下一个人）
  assert.ok(Object.isFrozen(a))
  assert.ok(Object.isFrozen(a.reasons))
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 形成期自检
// ══════════════════════════════════════════════════════════════════════════

test('⑧ ★★ 自检：四级全可达 + 两处"不许报绿"的反向对照都在', () => {
  const sc = selfCheckBudgetAlert()
  assert.equal(sc.everyLevelReachable, true,
    '自检里四级没有各到达一次 ⇒ 有一个等级是够不到的，而"够不到"与"没触发"在读数上同形')
  assert.deepEqual(sc.levelsSeen, [...BUDGET_ALERT_LEVELS])
  // 两处反向对照：自检必须**自己**证明这两件事，而不是让调用方去信
  assert.equal(sc.blindAllClear, false)
  assert.equal(sc.unconfiguredAllClear, false)
  assert.notEqual(sc.blindAction, 'none')
  assert.notEqual(sc.unconfiguredAction, 'none')
})

test('⑧b ★★★ `level` 与 `allClear` **不是**同一件事（本模块的核心立场）', () => {
  // 找一个 level === 'ok' 而 allClear === false 的样本，并且**两处不同的原因各一个**
  const byUnknown = ev(0, { records: 5, amountUnknownRecords: 5 })
  const byUnconfigured = evaluateBudgetAlert({ totals: clean(0), limit: LIMIT, thresholds: {} })

  assert.equal(byUnknown.level, 'ok')
  assert.equal(byUnknown.allClear, false)
  assert.equal(byUnconfigured.level, 'ok')
  assert.equal(byUnconfigured.allClear, false)

  // ★ 反过来也要成立：level 不是 ok 时 allClear 一定是 false
  for (const amount of [0, 60, 85, 120]) {
    for (const extra of [{}, { records: 5, amountUnknownRecords: 5 }, { mixedCurrency: true, currency: null }]) {
      const r = ev(amount, extra)
      if (r.level !== 'ok' || r.confidence !== 'exact' || !r.configured) {
        assert.equal(r.allClear, false, `level=${r.level} confidence=${r.confidence} 时 allClear 仍为 true`)
      }
    }
  }
  // 而 allClear 为 true 时，三件事必须同时成立
  const clear = ev(10)
  assert.equal(clear.allClear, true)
  assert.ok(clear.configured && clear.level === 'ok' && clear.confidence === 'exact')
})

test('⑧c 常量表的顺序就是严重度顺序（判据依赖它，所以钉住）', () => {
  assert.deepEqual([...BUDGET_ALERT_LEVELS], ['ok', 'warn', 'degrade', 'block'])
  assert.deepEqual([...BUDGET_ALERT_ACTIONS], ['none', 'review', 'degrade-model', 'block-new-runs'])
  assert.deepEqual([...BUDGET_ALERT_RUNGS], ['warn', 'degrade', 'block'])
  // 每一级都要有一个动作（缺键会让 ACTION_FOR_LEVEL[x] 是 undefined，
  // 而 undefined 会被 strictestAction 当成"最小"，静默降级成放行）
  for (const lv of BUDGET_ALERT_LEVELS) {
    assert.ok(BUDGET_ALERT_ACTIONS.includes(selfCheckBudgetAlert() && ev(
      { ok: 10, warn: 60, degrade: 85, block: 120 }[lv]).action),
    `${lv} 的动作不在 BUDGET_ALERT_ACTIONS 里`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 与 usageTotals() 的真实对接（真 SQLite，不是手捏对象）
// ══════════════════════════════════════════════════════════════════════════

test('⑨ ★★★ 拿 usageTotals() 的**真实返回值**求值：报表明明是 0，而告警不许报绿', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, role TEXT, scope TEXT DEFAULT 'default', goalId TEXT)`)
  db.exec(`
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL, scope TEXT NOT NULL, task_id TEXT NOT NULL,
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
  // 7 条账目：金额**全都是 NULL**（价目表里没这个模型 ⇒ estimate_ok = 0），
  // 而这正是生产里"缺价"的真实形状。
  for (let i = 0; i < 7; i += 1) {
    db.prepare(`INSERT INTO usage_records
      (attempt_id, scope, task_id, model_profile_id, currency, tokens_in, tokens_out,
       estimated_amount, actual_amount, estimate_ok, created_at_ms)
      VALUES (?, 'default', 't1', 'unpriced-model', 'USD', 100, 50, NULL, NULL, 0, ?)`)
      .run(`a${i}`, 1000 + i)
  }
  // 再加一条**有价**的，于是 confidence 应当是 partial 而不是 unknown
  db.prepare(`INSERT INTO usage_records
    (attempt_id, scope, task_id, model_profile_id, currency, tokens_in, tokens_out,
     estimated_amount, actual_amount, estimate_ok, created_at_ms)
    VALUES ('a9', 'default', 't1', 'priced-model', 'USD', 10, 5, 3, NULL, 1, 2000)`).run()

  const totals = usageTotals({ db })
  // 先钉住报表那一侧的真实读数
  assert.equal(totals.records, 8)
  assert.equal(totals.amountUnknownRecords, 7)
  assert.equal(totals.amount, 3, '`SUM` 把 7 条 NULL 当 0 加进去了 —— 这就是那个"看起来正常"的 3')
  assert.equal(totals.complete, false)

  const verdict = evaluateBudgetAlert({
    totals, limit: { amount: 100, currency: 'USD' }, thresholds: TH, degradeTo: 'cheap-model',
  })
  assert.equal(verdict.level, 'ok', '已知金额 3 / 上限 100 ⇒ 这一维确实是 ok')
  assert.equal(verdict.confidence, 'partial')
  assert.equal(verdict.allClear, false,
    '★ 报表说 3 元、离上限 100 元很远，而**有 7 条账目不知道多少钱**。'
    + '只看 `spent / limit` 的实现会在这里报"一切正常"——而它连那 7 笔里'
    + '有没有已经超了上限都不知道')
  assert.equal(verdict.action, 'review')
  assert.ok(verdict.reasons.includes('SPEND_PARTIAL'))

  // 反向：把 7 条未知的补上价（每条 200）⇒ 同一份账目、同一个判据必须能报绿。
  // ★ 上限取 3000（而不是刚好卡在余额上）：`1403 / 3000 = 0.468` 在 warn(0.5) 之下，
  //   所以这一条验的是"能不能报 ok"。第一版我写了 1400 ——
  //   而 `1403 > 1400` 恰好跨过 block 线，于是正对照自己变成了 block，
  //   看上去像"实现永远不肯报绿"。**正对照的上限本身也是一个会被跨过的数。**
  db.prepare(`UPDATE usage_records SET estimated_amount = 200 WHERE estimate_ok = 0`).run()
  const totals2 = usageTotals({ db })
  const verdict2 = evaluateBudgetAlert({
    totals: totals2, limit: { amount: 3000, currency: 'USD' }, thresholds: TH, degradeTo: 'cheap-model',
  })
  assert.equal(verdict2.confidence, 'exact')
  assert.equal(verdict2.allClear, true,
    '★ 正对照：账目补齐之后必须**真的能**报绿。'
    + '一个永远说"不可信"的实现与一个永远说"没事"的实现在这件事上是同一种坏')
  assert.equal(totals2.amount, 1403)

  db.close()
})

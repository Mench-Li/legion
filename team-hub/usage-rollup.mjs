// team-hub/usage-rollup.mjs
// ============================================================================
// F-15 用量/成本汇总（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.4）
//
// spec 那一行是：
//
//   > **F-15 用量/成本/预算**：按 scope、goal、task、employee、model 记录
//   > token、调用次数、耗时和成本，支持告警、降级、暂停和硬阻止。
//
// 五个维度 × 四个量。落地层面：
//   · **硬阻止 / 暂停 / 降级** —— `budget-ledger.mjs` 已实现（PRT-503/510/511），
//     `reserve → observe → settle` 那条链是闸门，不是报表。
//   · **本文补的是另外一半：把已经记下来的事实按五个维度读出来。**
//
// ## 为什么"读出来"要单独做一块，而不是 SELECT 一下
//
// 因为这张报表里**每一个数字都有一个"不知道"的邻居**，而把两者合并成同一个
// 读数是这类报表最典型的失效：
//
//   · `usage_records.tokens_in` 是 **NULL** 时，那不是 0。
//     `SUM()` 会把它当 0 加进去，于是"这次运行没有采集到 token"
//     与"这次运行确实用了 0 个 token"在同一格里。
//   · `estimate_ok = 0` 的行（价目表里没有这个模型 / 缺价）金额是 NULL。
//     把它们算进 `SUM(estimated_amount)` 会**低估总成本**，
//     而报表上那个数字看起来完全正常。
//   · 一条 Attempt 还没结束（`finished_at_ms IS NULL`）时，耗时**还不存在**。
//     用 `now - created_at` 顶替，等于把"正在跑"报成一个会一直长的耗时，
//     于是"耗时在涨"与"有个任务卡住了"在图上长得一样。
//   · `tasks` 那一行被删掉时（`LEFT JOIN` 无匹配），goal / employee 是**未知**，
//     不是空串。把它们折进一个 `''` 桶会让"没归属"与"归属叫空字符串的桶"
//     合并——而后者不该存在。
//
//   > 一张把"不知道"写成 0 的成本报表，与一张准确的成本报表，
//   > 在总额**恰好**都是 0 的那一天是同一个东西——只不过前者的 0 会
//   > 在某次"模型调用没记账"之后继续显示 0。
//
// ## 三条纪律
//
// ① **`SUM` 只作用在已知值上，未知值单独计数**。每一行都带
//    `unknownTokens` / `unknownCost`（"这一格里有多少条是不知道的"）。
//    一条都没有时它们是 0——**而 0 在这里是真的 0**，因为它数的是"未知条数"，
//    不是"未知的量"。
// ② **未归属维度进显式的 `(未归属)` 桶**，且该桶带 `attributed: false`。
//    静默丢掉它们会让"总成本"小于各维度之和，而差值没有任何地方能解释。
// ③ **耗时只统计已结束的 Attempt**，未结束的单列 `inFlight` 计数。
//    两者**不相加**：把它们相加得到的"平均耗时"会把一个刚起跑的任务
//    算成 0 秒，于是"平均耗时下降"可能是"任务刚开始"。
// ============================================================================

/** 五个维度。名字就是 spec 里那五个词。 */
export const ROLLUP_DIMENSIONS = Object.freeze(['scope', 'goal', 'task', 'employee', 'model'])

/**
 * "这一格归属不明"的桶名。
 *
 * **用一对全角括号包住**：一个真实的 goalId 或 role 不太可能长这样，
 * 而用一个空串会让"没归属"在 JSON 里看起来像一个合法的空维度值。
 */
export const UNATTRIBUTED = '(未归属)'

export const isRollupDimension = (d) => ROLLUP_DIMENSIONS.includes(d)

function fail(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

/**
 * 哪一列表示哪个维度。
 *
 * `goal` 与 `employee` 住在 `tasks` 上（`goalId` / `role`），不在
 * `usage_records` 上——`usage_records` 是记账那一刻写的，而它只认识
 * `scope` / `task_id` / `model_profile_id`。**必须 LEFT JOIN**：
 * 一条用量记录的任务行不见了时，那笔钱**已经花了**，
 * 从报表里把它删掉等于让账目消失。
 */
const DIMENSION_EXPR = Object.freeze({
  scope: "COALESCE(NULLIF(u.scope, ''), NULL)",
  goal: 't.goalId',
  task: 'u.task_id',
  employee: 't.role',
  model: 'u.model_profile_id',
})

/** 这一格是不是"归属不明"。空白字符串与 NULL 都算。 */
const unattributedCases = (expr) => `(${expr} IS NULL OR TRIM(CAST(${expr} AS TEXT)) = '')`

/**
 * 按一个维度汇总。
 *
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.db
 * @param {'scope'|'goal'|'task'|'employee'|'model'} args.dimension
 * @param {number|null} args.sinceMs   只看这个时刻之后写入的用量行（含）
 * @param {number|null} args.untilMs   只看这个时刻之前写入的用量行（不含）
 * @param {string|null} args.scope     限定空间（不是分组维度，是过滤器）
 */
export function rollupBy({ db, dimension, sinceMs = null, untilMs = null, scope = null } = {}) {
  if (!isRollupDimension(dimension)) {
    throw fail('BAD_ROLLUP_DIMENSION',
      `不认识的汇总维度：${JSON.stringify(dimension)}。可选 ${ROLLUP_DIMENSIONS.join(' / ')}——`
      + '自由文本的维度名会让"按员工看"落到一个永远为空的桶里，而报表仍然显示成功')
  }
  const expr = DIMENSION_EXPR[dimension]
  const where = []
  const args = []
  if (Number.isSafeInteger(sinceMs)) { where.push('u.created_at_ms >= ?'); args.push(sinceMs) }
  if (Number.isSafeInteger(untilMs)) { where.push('u.created_at_ms < ?'); args.push(untilMs) }
  if (typeof scope === 'string' && scope !== '') { where.push('u.scope = ?'); args.push(scope) }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  // ── 分组查询 ────────────────────────────────────────────────────────
  //
  // `tokens_in` / `tokens_out` / `estimated_amount` / `actual_amount` 四列
  // 各自的"未知条数"都单独数出来。把它们合成一个 `unknownCount` 会丢失
  // "哪一项不知道"——而修法完全不同（缺 token 是采集问题，
  // 缺金额是价目表问题）。
  const groupRows = db.prepare(`
    SELECT
      CASE WHEN ${unattributedCases(expr)} THEN NULL ELSE ${expr} END AS bucket,
      COUNT(*)                                                        AS records,
      COALESCE(SUM(u.tokens_in), 0)                                   AS tokens_in_known,
      COALESCE(SUM(u.tokens_out), 0)                                  AS tokens_out_known,
      SUM(CASE WHEN u.tokens_in IS NULL OR u.tokens_out IS NULL THEN 1 ELSE 0 END) AS tokens_unknown,
      COALESCE(SUM(COALESCE(u.actual_amount, u.estimated_amount)), 0) AS amount_known,
      SUM(CASE WHEN COALESCE(u.actual_amount, u.estimated_amount) IS NULL THEN 1 ELSE 0 END) AS amount_unknown,
      MIN(u.currency)                                                 AS currency,
      COUNT(DISTINCT u.currency)                                      AS currency_count
    FROM usage_records u
    LEFT JOIN tasks t ON t.id = u.task_id
    ${whereSql}
    GROUP BY bucket
    ORDER BY bucket IS NULL, amount_known DESC, bucket
  `).all(...args)

  // ── 耗时：**只统计已结束的 Attempt** ────────────────────────────────
  //
  // 与用量分开查，而且**必须用一套自己的 WHERE 参数**。
  //
  // 第一版这里图省事，从 `run_attempts` JOIN 到 `usage_records` 再复用
  // 用量那条 `WHERE u.…`。那是一个会**静默把耗时算 N 倍**的写法：
  // 一条 Attempt 若有 3 条用量记录，JOIN 就产生 3 行，
  // `SUM(finished_at_ms - created_at_ms)` 于是把它算了三遍。
  //
  //   > 一个"每条尝试算一次"的耗时报表，与一个"每次记账算一次"的耗时报表，
  //   > 在每条尝试恰好只记一笔的那个月里是同一个东西——
  //   > 而那个月恰好是这套东西刚上线、调用最少的时候。
  //
  // 所以耗时按 `run_attempts` 自己的行来算，时间过滤也换成 `a.` 前缀。
  // `model` 维度对 Attempt 而言是**派生**的（一次 Attempt 可能先后用过不同模型）：
  // 取它最后一条用量记录的模型，并把这条口径写在这里而不是让读的人去猜。
  const ATTEMPT_DIMENSION_EXPR = Object.freeze({
    scope: 'a.scope',
    goal: 't.goalId',
    task: 'a.task_id',
    employee: 't.role',
    model: '(SELECT u2.model_profile_id FROM usage_records u2 WHERE u2.attempt_id = a.id ORDER BY u2.id DESC LIMIT 1)',
  })
  const attemptWhere = []
  const attemptArgs = []
  if (Number.isSafeInteger(sinceMs)) { attemptWhere.push('a.created_at_ms >= ?'); attemptArgs.push(sinceMs) }
  if (Number.isSafeInteger(untilMs)) { attemptWhere.push('a.created_at_ms < ?'); attemptArgs.push(untilMs) }
  if (typeof scope === 'string' && scope !== '') { attemptWhere.push('a.scope = ?'); attemptArgs.push(scope) }
  const attemptWhereSql = attemptWhere.length > 0 ? `WHERE ${attemptWhere.join(' AND ')}` : ''
  const aExpr = ATTEMPT_DIMENSION_EXPR[dimension]
  const durationRows = db.prepare(`
    SELECT
      CASE WHEN ${unattributedCases(aExpr)} THEN NULL ELSE ${aExpr} END AS bucket,
      SUM(CASE WHEN a.finished_at_ms IS NOT NULL THEN 1 ELSE 0 END)   AS finished,
      SUM(CASE WHEN a.finished_at_ms IS NULL THEN 1 ELSE 0 END)       AS in_flight,
      COALESCE(SUM(CASE WHEN a.finished_at_ms IS NOT NULL
                        THEN a.finished_at_ms - a.created_at_ms END), 0) AS duration_known_ms
    FROM run_attempts a
    LEFT JOIN tasks t ON t.id = a.task_id
    ${attemptWhereSql}
    GROUP BY bucket
  `).all(...attemptArgs)
  const durationOf = new Map()
  for (const r of durationRows) durationOf.set(r.bucket ?? null, r)

  const buckets = groupRows.map((r) => {
    const d = durationOf.get(r.bucket ?? null)
    const finished = d === undefined ? 0 : Number(d.finished)
    const inFlight = d === undefined ? 0 : Number(d.in_flight)
    const durationKnownMs = d === undefined ? 0 : Number(d.duration_known_ms)
    const currencyCount = Number(r.currency_count)
    return Object.freeze({
      bucket: r.bucket ?? UNATTRIBUTED,
      // `attributed: false` 让读的人不必靠字符串比对来判断"这是不是未归属桶"。
      attributed: r.bucket !== null,
      // ── 四个量 ──
      // token / 金额 / 耗时各自都带一个"不知道有多少条"的邻居。
      tokensIn: Number(r.tokens_in_known),
      tokensOut: Number(r.tokens_out_known),
      // ★ 口径是**记账行数**，不是列数：一条行只要 `tokens_in` 或 `tokens_out`
      //   任意一项为 NULL 就算"这一行的 token 不知道"。
      //   第一版这里写的是 `tokens_in_unknown + tokens_out_unknown`（列数），
      //   而 `usageTotals()` 用的是行数——同一个字段名在两个入口给出
      //   相差一倍的读数，而两个数**各自都是对的**。这正是"口径必须写在一处"
      //   的那件事：两条 SQL 各写一遍判据，漂移是迟早的。
      tokensUnknownRecords: Number(r.tokens_unknown),
      amount: Number(r.amount_known),
      amountUnknownRecords: Number(r.amount_unknown),
      // **调用次数**：记了多少条用量行。它不是"调了几次模型"，
      // 而是"记了几笔账"——两者相等的前提是每一次调用都记一笔，
      // 而那正是 `tokensUnknownRecords` 要暴露的事。
      records: Number(r.records),
      durationMs: durationKnownMs,
      finishedAttempts: finished,
      inFlightAttempts: inFlight,
      // `> 1` 时这一格里混了币种，金额之和**没有意义**。
      // 报出来而不是替调用方换算——换算需要汇率，而汇率是一个
      // 会随时间变的外部事实，报表不该偷偷引入它。
      mixedCurrency: currencyCount > 1,
      currency: currencyCount === 1 ? r.currency : null,
    })
  })

  return Object.freeze({
    dimension,
    unattributedBucket: UNATTRIBUTED,
    buckets: Object.freeze(buckets),
    // 「有几格里混了币种」是**读这张表之前必须先看**的一件事。
    mixedCurrencyBuckets: Object.freeze(buckets.filter((b) => b.mixedCurrency).map((b) => b.bucket)),
    serverTimeMs: Date.now(),
  })
}

/**
 * 总账：不分组，只把五个维度各自的"未归属条数"报出来。
 *
 * 为什么需要一个单独的入口：只看 `rollupBy('model')` 时，
 * "有些用量根本没有 model_profile_id"这件事根本不会进入视野——
 * 它在 model 维度下就是一个叫 `(未归属)` 的桶，看起来像另一种模型。
 */
export function usageTotals({ db, sinceMs = null, untilMs = null, scope = null } = {}) {
  const where = []
  const args = []
  if (Number.isSafeInteger(sinceMs)) { where.push('u.created_at_ms >= ?'); args.push(sinceMs) }
  if (Number.isSafeInteger(untilMs)) { where.push('u.created_at_ms < ?'); args.push(untilMs) }
  if (typeof scope === 'string' && scope !== '') { where.push('u.scope = ?'); args.push(scope) }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                              AS records,
      COALESCE(SUM(u.tokens_in), 0)                          AS tokens_in,
      COALESCE(SUM(u.tokens_out), 0)                         AS tokens_out,
      SUM(CASE WHEN u.tokens_in IS NULL OR u.tokens_out IS NULL THEN 1 ELSE 0 END) AS tokens_unknown,
      COALESCE(SUM(COALESCE(u.actual_amount, u.estimated_amount)), 0) AS amount,
      SUM(CASE WHEN COALESCE(u.actual_amount, u.estimated_amount) IS NULL THEN 1 ELSE 0 END) AS amount_unknown,
      COUNT(DISTINCT u.currency)                            AS currency_count,
      MIN(u.currency)                                       AS currency
    FROM usage_records u
    ${whereSql}
  `).get(...args)

  // 每个维度各有几条未归属。**逐个维度分开数**：一条用量行可能
  // employee 未知而 model 已知——合成一个"未归属条数"会让两件事互相掩盖。
  const unattributed = {}
  for (const dim of ROLLUP_DIMENSIONS) {
    const expr = DIMENSION_EXPR[dim]
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM usage_records u
      LEFT JOIN tasks t ON t.id = u.task_id
      ${whereSql}${whereSql === '' ? 'WHERE' : 'AND'} ${unattributedCases(expr)}
    `).get(...args)
    unattributed[dim] = Number(r.n)
  }

  // 耗时总账。与用量分开（同 `rollupBy` 的理由）。
  const dur = db.prepare(`
    SELECT
      COUNT(*) AS attempts,
      SUM(CASE WHEN a.finished_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS finished,
      SUM(CASE WHEN a.finished_at_ms IS NULL THEN 1 ELSE 0 END)     AS in_flight,
      COALESCE(SUM(CASE WHEN a.finished_at_ms IS NOT NULL
                        THEN a.finished_at_ms - a.created_at_ms END), 0) AS duration_known_ms
    FROM run_attempts a
    ${whereSql.replace(/\bu\./g, 'a.')}
  `).get(...args)

  const currencyCount = Number(totals.currency_count)
  return Object.freeze({
    records: Number(totals.records),
    tokensIn: Number(totals.tokens_in),
    tokensOut: Number(totals.tokens_out),
    // ★ 这两个数**不是 0 的同义词**：它们数的是"不知道的有几条"。
    //   把 `tokensIn` 单独展示而不带这一项，就是让"没采集到"
    //   与"用了 0 个"在报表上同形。
    tokensUnknownRecords: Number(totals.tokens_unknown),
    amount: Number(totals.amount),
    amountUnknownRecords: Number(totals.amount_unknown),
    mixedCurrency: currencyCount > 1,
    currency: currencyCount === 1 ? totals.currency : null,
    unattributed,
    attempts: Number(dur.attempts),
    finishedAttempts: Number(dur.finished),
    inFlightAttempts: Number(dur.in_flight),
    durationMs: Number(dur.duration_known_ms),
    // 「这张报表能不能用来做判断」的一个总口径：
    // 有任何一项不知道，或混了币种，就不算完整。
    // **与 event-delivery 的 `settled` 同一条纪律**——一个只说"有数据"
    // 的读数，在一半数据缺失时看起来和完整时一样。
    complete: Number(totals.tokens_unknown) === 0
      && Number(totals.amount_unknown) === 0
      && currencyCount <= 1,
    serverTimeMs: Date.now(),
  })
}

// team-hub/routes/usage.mjs
// ============================================================================
// 路由层第 14 族：**用量汇总与预算告警（F-15 / 第 23 轮）** —— PRT-316 切片 14
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 14 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 8f80a68:team-hub/server.mjs` 的 `/api/usage` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 3 条的形态分布（生成器算的，不是抄的）
//
//   ×  3  `path === '…'`
//   ×  0  `path.startsWith('…')`
//   ×  0  `path.startsWith('…') && path.endsWith('…')`
//
// 生成器在切片 5 修正过一次**静默漏取**：切片 4 的版本只认等值那一种，
// 会静默跳过另外 48 条（旧自检只为"一条都没取到"准备，所以不会响）。
//
//   > 一个"按前缀取族、却只认一种写法"的生成器，
//   > 与一个"把这一族搬走一半"的提交，在 `node --check` 通过时是同一个东西。
//
// 生成器在切片 6 修正过第二次：ctx 成员**按体逐条绑定**（旧版一律允许
// `path`/`url`、却只解构 `url` ⇒ 体里用 `path` 的族会拿到 `undefined`）。
//
//   > 一个"把名字登记成可用"的白名单，与一个"真的把它绑进来"的解构，
//   > 在没人用那个名字的时候是同一个东西。
//
// ## 零注入改写
//
// 3 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 6 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── F-15 用量汇总 ──────────────────────────────────────────────────
//
// 两条只读路由。**刻意没有写路径**：这张报表读的是已经记下的账，
// 而"记一笔账"是 `budget-ledger` 的 `reserve/observe/settle`——
// 那条链是闸门，需要 attemptId + leaseEpoch，不该有一条"手工记一笔"
// 的后门（那会让账本里的钱与实际花掉的钱脱钩，而两者看起来一样）。


/**
 * 造用量汇总与预算告警（F-15 / 第 23 轮）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createUsageRoutes({
  json,
  authorized, usageRollup, optionalIntParam,
  db, ROLLUP_DIMENSIONS, evaluateBudgetAlert,
  BUDGET_ALERT_CODES, BUDGET_ALERT_LEVELS, BUDGET_ALERT_RUNGS,
}) {
  const deps = { json,
    authorized, usageRollup, optionalIntParam,
    db, ROLLUP_DIMENSIONS, evaluateBudgetAlert,
    BUDGET_ALERT_CODES, BUDGET_ALERT_LEVELS, BUDGET_ALERT_RUNGS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createUsageRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/usage/totals',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        json(res, 200, {
          ok: true,
          ...usageRollup.usageTotals({
            db,
            sinceMs: optionalIntParam(url, 'sinceMs'),
            untilMs: optionalIntParam(url, 'untilMs'),
            scope: url.searchParams.get('scope'),
          }),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/usage/rollup',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const dimension = url.searchParams.get('dimension')
        try {
          json(res, 200, {
            ok: true,
            ...usageRollup.rollupBy({
              db,
              dimension,
              sinceMs: optionalIntParam(url, 'sinceMs'),
              untilMs: optionalIntParam(url, 'untilMs'),
              scope: url.searchParams.get('scope'),
            }),
          })
        } catch (e) {
          // 未知维度是**调用方的错**，所以 400 + 具名码，并把可选值列出来——
          // 只说"不认识的维度"会让调用方去翻源码。
          json(res, Number(e?.statusCode) || 400, {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            code: e?.code ?? 'ROLLUP_FAILED',
            dimensions: ROLLUP_DIMENSIONS,
          })
        }
      },
    },
    // ============================================================================
    // 原文的子段说明（25 行，逐字搬来、未改写）
    // ============================================================================
    // ── F-15 告警与降级（第 23 轮）───────────────────────────────────────
    //
    // `GET /api/usage/alert` —— 把「这一段时间花了多少」与「上限是多少」
    // 合成一个**可以据以动作**的读数：等级 / 可信度 / 该做什么 / 能不能放行。
    //
    // ## ★★★ 它**故意不**去读模型绑定里的 `perRunBudget`
    //
    // 那是本接口唯一一处需要解释的设计选择。`bindingStore` 里确实有一个
    // `perRunBudget: { maxCost, maxTokens, currency }`，看起来正是"上限"。
    // 但它是**单次运行**的天花板，而本接口比的是**一个时间窗内的累计花费**。
    //
    //   一个时间窗的累计花费 / 一次运行的上限
    //
    // 这个比值**算得出来**，而且通常落在 0 到 1 之间，看起来完全正常——
    // 但它没有任何意义：窗里有 30 次运行，那么"累计花费超过单次上限"
    // 是**必然**的，与"超支了"无关。反过来窗里只有一次运行没花完，
    // 它就报绿，而那个员工可能已经把**月度**预算花光了。
    //
    //   > 一个"算得出来、落在合理区间、而且没有意义"的比值，
    //   > 与一个正确的比值，在仪表盘上是同一个东西——
    //   > 只不过前者会在**每一次**告警里都显得很有道理。
    //
    // ⇒ 上限由**调用方**给（仪表盘/运维知道哪个预算对应哪个窗口）。
    //   本接口不发明上限、不发明阈值、不发明降级目标——见
    //   `team-hub/budget-alert.mjs` 文件头的三条。
    {
      method: 'GET',
      match: 'exact',
      path: '/api/usage/alert',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const limitRaw = url.searchParams.get('limit')
        if (limitRaw === null || limitRaw === '') {
          json(res, 400, {
            ok: false,
            // ★ 400 而不是"按 0 处理"：一个"没配上限所以按 0 处理"的实现，
            //   会让每一道预算告警在**没配**的时候报绿。
            code: BUDGET_ALERT_CODES.LIMIT_REQUIRED,
            error: '缺少 limit（预算上限的金额）。本接口**不**发明上限：'
              + '它刻意不读模型绑定里的 `perRunBudget`（那是单次运行的天花板，'
              + '而这里比的是时间窗内的累计花费——那个比值算得出来，但没有意义）。'
              + '上限由调用方给，因为只有调用方知道哪个预算对应哪个窗口。',
            levels: BUDGET_ALERT_LEVELS,
            rungs: BUDGET_ALERT_RUNGS,
          })
          return
        }
        const limitAmount = Number(limitRaw)
        // ★★★ 参数集是**封闭**的。这一段是本轮用例 ④b 逼出来的：
        //
        // 第一版只把**认识的那三个** rung 名从查询串里挑出来交给
        // `evaluateBudgetAlert()`，于是 `?warning=0.5`（拼错了 warn）
        // **根本没进到** `normalizeThresholds()` 里——那个"不认识的阈值名 ⇒ 抛"
        // 的守卫**在，但它看不见这个键**。接口照旧返回 200。
        //
        //   > 一个把不合格的输入**过滤掉**再交给守卫的适配层，
        //   > 与一个根本没有守卫的实现，是同一个东西——
        //   > 只不过前者的守卫**在源码里看起来是有的**。
        //
        // ⇒ 认不出的参数一律拒，并把可选值列全。它同时覆盖了"阈值名拼错"
        //   与"其他参数拼错"两种情形，而两者的后果是同一个：**用户以为配了，实际没配**。
        const ALLOWED_PARAMS = new Set([
          'limit', 'currency', 'degradeTo', 'scope', 'sinceMs', 'untilMs',
          ...BUDGET_ALERT_RUNGS,
        ])
        const unknownParams = [...new Set([...url.searchParams.keys()])]
          .filter((k) => !ALLOWED_PARAMS.has(k))
        if (unknownParams.length > 0) {
          json(res, 400, {
            ok: false,
            code: BUDGET_ALERT_CODES.THRESHOLDS_INVALID,
            error: `不认识的查询参数 ${JSON.stringify(unknownParams)}。`
              + '★ 不静默忽略：一个拼错的阈值名被忽略之后，'
              + '配置者以为自己配了告警，而系统里没有它——'
              + '那与"没配"在读数上是同一个东西，只不过前者看起来已经配过了。',
            allowedParams: [...ALLOWED_PARAMS],
            rungs: BUDGET_ALERT_RUNGS,
          })
          return
        }
        // 比例阈值一律从查询串取，**不给默认值**：没给就是"没配告警"，
        // 那是一个要能被看见的状态（`configured:false`），不是"一切正常"。
        const ratio = (name) => {
          const v = url.searchParams.get(name)
          if (v === null || v === '') return undefined
          const n = Number(v)
          return Number.isFinite(n) ? n : v
        }
        const thresholds = {}
        for (const rung of BUDGET_ALERT_RUNGS) {
          const v = ratio(rung)
          if (v !== undefined) thresholds[rung] = v
        }
        try {
          json(res, 200, {
            ok: true,
            ...evaluateBudgetAlert({
              totals: usageRollup.usageTotals({
                db,
                sinceMs: optionalIntParam(url, 'sinceMs'),
                untilMs: optionalIntParam(url, 'untilMs'),
                scope: url.searchParams.get('scope'),
              }),
              limit: { amount: limitAmount, currency: url.searchParams.get('currency') },
              thresholds: Object.keys(thresholds).length > 0 ? thresholds : null,
              degradeTo: url.searchParams.get('degradeTo'),
            }),
          })
        } catch (e) {
          // 未知阈值名 / 越界 / 不递增 / 币种对不上 / 上限非法：都是**调用方的错**，
          // 所以 400 + 具名码 + 可选值，而不是 500。只说"参数错误"会让调用方去翻源码。
          json(res, Number(e?.statusCode) || 400, {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            code: e?.code ?? 'BUDGET_ALERT_FAILED',
            levels: BUDGET_ALERT_LEVELS,
            rungs: BUDGET_ALERT_RUNGS,
          })
        }
      },
    },
  ]

  const matches = (r, path) => {
    if (r.match === 'exact') return path === r.path
    if (r.match === 'prefix') return path.startsWith(r.path)
    if (r.match === 'prefix+suffix') return path.startsWith(r.path) && path.endsWith(r.suffix)
    return false
  }

  return {
    id: 'usage',
    routes,
    /** 3 条；顺序与 `handle` 里原来那 3 条 `if` 相同。 */
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

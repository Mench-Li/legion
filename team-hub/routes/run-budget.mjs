// team-hub/routes/run-budget.mjs
// ============================================================================
// 路由层第 29 族：**单次运行预算账本与价目表（PRT-503 / PRT-510 / PRT-511，spec §6.6）** —— PRT-316 切片 31
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 29 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 430d3dc:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 6 条的形态分布（生成器算的，不是抄的）
//
//   ×  5  `path === '…'`
//   ×  1  `path.startsWith('…')`
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
// 6 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 8 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 单次运行预算账本与价目表（PRT-503 / PRT-510 / PRT-511，spec §6.6） ──
//
// 这是全仓唯一一处"花的是真钱"的接口面。它的错误都比别处贵：
// 预留漏了 → 超支；预留重复 → 余额被占两次；结算两次 → 余额释放两次；
// 锁定被结算 → 结果未知的那笔钱被当成已结清。
//
// 因此这里的原则是**宁可拒绝，不可猜**：状态码要能让调用方分辨
// 「参数不对（400）」「状态不符（409）」「根本没有这笔预留（404）」。


/**
 * 造单次运行预算账本与价目表（PRT-503 / PRT-510 / PRT-511，spec §6.6）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createRunBudgetRoutes({
  json,
  budgetLedger, budgetPriceTables, BUDGET_ERRORS,
  handleRun,
}) {
  const deps = { json,
    budgetLedger, budgetPriceTables, BUDGET_ERRORS,
    handleRun,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createRunBudgetRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/run-budget/reserve',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          // ── 参数校验**必须**排在状态检查之前 ──
          //
          // 顺序错了会把"你没传 attemptId"（400，改请求）报成
          // "没有价目表版本 undefined"（409，去发布一张表）——
          // 调用方会去修一个不存在的问题。
          if (typeof body.attemptId !== 'string' || body.attemptId.trim() === '') {
            json(res, 400, {
              ok: false, code: BUDGET_ERRORS.ATTEMPT_REQUIRED,
              error: '缺少 attemptId：账本的键是一次 Attempt，没有它无法定位预留',
              serverTimeMs: Date.now(),
            })
            return
          }
          // 没有预算 = 显式 unbounded，此时**不需要**价目表（不预留就不用算钱）。
          // 有预算但价目表取不到时给一条运维看得懂的错，而不是把
          // `createPriceTable` 的开发者断言漏出去。
          const needsPrice = body.budget !== null && body.budget !== undefined
          const priceTable = needsPrice ? budgetPriceTables.get(body.priceTableVersion) : null
          if (needsPrice && priceTable === null) {
            json(res, 409, {
              ok: false, code: BUDGET_ERRORS.PRICE_TABLE_GONE,
              error: `没有价目表版本 ${JSON.stringify(body.priceTableVersion)}：` +
                '有预算就必须有价目表——否则"上限"没有办法换算成钱，预留也就无从谈起',
              serverTimeMs: Date.now(),
            })
            return
          }
          const r = budgetLedger.reserve({
            attemptId: body.attemptId, scope: body.scope, taskId: body.taskId,
            modelProfileId: body.modelProfileId,
            budget: body.budget ?? null,
            priceTable,
            tokensIn: body.tokensIn, tokensOut: body.tokensOut,
          })
          return { reservation: r.reservation, budgetState: r.budgetState }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/run-budget/observe',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = budgetLedger.observe({
            attemptId: body.attemptId,
            tokensIn: body.tokensIn, tokensOut: body.tokensOut,
            modelProfileId: body.modelProfileId,
          })
          return {
            cancel: r.cancel, kind: r.kind, used: r.used, limit: r.limit,
            currency: r.currency, message: r.message, estimateOk: r.estimateOk,
          }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/run-budget/settle',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = budgetLedger.settle({
            attemptId: body.attemptId, tokensIn: body.tokensIn, tokensOut: body.tokensOut,
            outcome: body.outcome, actor: body.actor,
            modelProfileId: body.modelProfileId, reason: body.reason,
          })
          return { reservation: r.reservation, locked: r.locked === true, overrun: r.overrun ?? null }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/run-budget/resolve',
      async run(req, res) {
        // 人工处置 / 恢复：解开 locked 的**唯一**出口。
        await handleRun(req, res, (body) => budgetLedger.resolveLocked({
          attemptId: body.attemptId,
          disposition: body.disposition,
          actor: body.actor,
          tokensIn: body.tokensIn, tokensOut: body.tokensOut,
          reason: body.reason,
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/run-budget',
      async run(req, res, { url }) {
        const r = budgetLedger.list({ scope: url.searchParams.get('scope'), state: url.searchParams.get('state') })
        json(res, 200, {
          ok: true, reservations: r, held: budgetLedger.heldAmount(url.searchParams.get('scope')),
          serverTimeMs: Date.now(),
        })
      },
    },
    {
      method: 'GET',
      match: 'prefix',
      path: '/api/runtime/run-budget/',
      async run(req, res, { path }) {
        // `/api/runtime/run-budget/<attemptId>`：Attempt id 形如 `att:T-1:1`，
        // 含冒号，因此必须百分号编码。这里**整段解码**（不像绑定那样按段切）——
        // 路径里只有一段。
        const BUDGET_PREFIX = '/api/runtime/run-budget/'
        const rawId = path.slice(BUDGET_PREFIX.length)
        let attemptId = null
        try {
          attemptId = decodeURIComponent(rawId)
        } catch {
          json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: '预算路径不是合法的 URL 编码' })
          return
        }
        if (attemptId.trim() === '') {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/runtime/run-budget/<attemptId>' })
          return
        }
        const reservation = budgetLedger.get(attemptId)
        if (reservation === null) {
          json(res, 404, {
            ok: false, code: BUDGET_ERRORS.RESERVATION_NOT_FOUND,
            error: `Attempt ${attemptId} 没有预算预留（未配置预算的运行不会留下预留——那是显式的 unbounded，不是遗漏）`,
            serverTimeMs: Date.now(),
          })
          return
        }
        json(res, 200, { ok: true, reservation, usage: budgetLedger.usageOf(attemptId), serverTimeMs: Date.now() })
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
    id: 'run-budget',
    routes,
    /** 6 条；顺序与 `handle` 里原来那 6 条 `if` 相同。 */
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

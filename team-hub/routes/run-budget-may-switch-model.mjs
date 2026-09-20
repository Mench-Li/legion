// team-hub/routes/run-budget-may-switch-model.mjs
// ============================================================================
// 路由层第 47 族：**换模型前的费用闸（缺价目表 409、其余交域层判 allowed）** —— PRT-316 切片 49
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 47 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 06fe8ac:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 1 条的形态分布（生成器算的，不是抄的）
//
//   ×  1  `path === '…'`
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
// 1 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造换模型前的费用闸（缺价目表 409、其余交域层判 allowed）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createRunBudgetMaySwitchModelRoutes({
  json,
  handleRun, budgetPriceTables, budgetLedger,
  BUDGET_ERRORS,
}) {
  const deps = { json,
    handleRun, budgetPriceTables, budgetLedger,
    BUDGET_ERRORS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createRunBudgetMaySwitchModelRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/run-budget/may-switch-model',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const priceTable = budgetPriceTables.get(body.priceTableVersion)
          if (priceTable === null) {
            // 没有价目表就**无法比较**贵不贵，因此无法批准——这是 409 而不是 400：
            // 请求本身没错，是缺一张表。而且绝不能因为"查不清"就放行。
            json(res, 409, {
              ok: false, code: BUDGET_ERRORS.PRICE_TABLE_GONE,
              error: `没有价目表版本 ${JSON.stringify(body.priceTableVersion)}：` +
                '不比较费用就无法判断是否更贵，而"不得在未获用户批准时自动切换到更昂贵模型"' +
                '不能靠"查不清"来满足',
              serverTimeMs: Date.now(),
            })
            return
          }
          const d = budgetLedger.maySwitchModel({
            from: body.from, to: body.to, priceTable,
            tokensIn: body.tokensIn, tokensOut: body.tokensOut, approved: body.approved === true,
          })
          return { allowed: d.allowed, code: d.code, fromAmount: d.fromAmount, toAmount: d.toAmount, currency: d.currency }
        })
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
    id: 'run-budget-may-switch-model',
    routes,
    /** 1 条；顺序与 `handle` 里原来那 1 条 `if` 相同。 */
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

// team-hub/routes/price-tables.mjs
// ============================================================================
// 路由层第 17 族：**价目表（PRT-503 / PRT-510，spec §6.6）** —— PRT-316 切片 18
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 17 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 6bf4522:team-hub/server.mjs` 的 `/api/price-tables` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 3 条的形态分布（生成器算的，不是抄的）
//
//   ×  2  `path === '…'`
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
// 3 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造价目表（PRT-503 / PRT-510，spec §6.6）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createPriceTablesRoutes({
  json,
  budgetPriceTables, createPriceTable, BUDGET_ERRORS,
  handleRun,
}) {
  const deps = { json,
    budgetPriceTables, createPriceTable, BUDGET_ERRORS,
    handleRun,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createPriceTablesRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/price-tables',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          // 版本只增不改：同版本再发布是 409，不是 200 覆盖。
          const table = createPriceTable({
            version: body.version, currency: body.currency,
            effectiveAtMs: body.effectiveAtMs, models: body.models ?? {},
          })
          const saved = budgetPriceTables.publish(table, { actor: body.actor })
          return { priceTable: { version: saved.version, currency: saved.currency, effectiveAtMs: saved.effectiveAtMs, models: Object.keys(saved.models) } }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/price-tables',
      async run(req, res) {
        json(res, 200, { ok: true, priceTables: budgetPriceTables.list(), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'GET',
      match: 'prefix',
      path: '/api/price-tables/',
      async run(req, res, { path }) {
        const version = path.slice('/api/price-tables/'.length)
        if (version.trim() === '') {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/price-tables/<version>' })
          return
        }
        const table = budgetPriceTables.get(version)
        if (table === null) {
          json(res, 404, { ok: false, code: BUDGET_ERRORS.PRICE_TABLE_GONE, error: `没有价目表版本 ${version}` })
          return
        }
        // 只回结构与单价，**不回**任何与密钥相关的东西（价目表本来就没有，但保持同一条纪律）
        json(res, 200, {
          ok: true,
          priceTable: {
            version: table.version, currency: table.currency,
            effectiveAtMs: table.effectiveAtMs, models: table.models,
          },
          serverTimeMs: Date.now(),
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
    id: 'price-tables',
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

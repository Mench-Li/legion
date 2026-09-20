// team-hub/routes/team-plans.mjs
// ============================================================================
// 路由层第 21 族：**团队计划（读：列出一版；写：冻结一版，PRT-402 的写一半）** —— PRT-316 切片 22
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 21 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show ba8dce6:team-hub/server.mjs` 的 `/api/team-plans` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 2 条的形态分布（生成器算的，不是抄的）
//
//   ×  2  `path === '…'`
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
// 2 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造团队计划（读：列出一版；写：冻结一版，PRT-402 的写一半）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createTeamPlansRoutes({
  json,
  contextPlanStore, handleRun,
}) {
  const deps = { json,
    contextPlanStore, handleRun,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createTeamPlansRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/team-plans',
      async run(req, res, { url }) {
        const scope = url.searchParams.get('scope')
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
        const items = contextPlanStore().listTeamPlans({ scope, limit })
        json(res, 200, { ok: true, plans: items, count: items.length, serverTimeMs: Date.now() })
      },
    },
    // ============================================================================
    // 原文的子段说明（4 行，逐字搬来、未改写）
    // ============================================================================
    // 冻结一版团队计划（PRT-402 的**写**一半）。
    //
    // 没有这条路由，读面永远返回 404，而"读面做好了"与"库里永远为空"
    // 在用户那里是同一件事（与 PRT-505 的 `store.put` 零调用方同源）。
    {
      method: 'POST',
      match: 'exact',
      path: '/api/team-plans',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = contextPlanStore().putTeamPlan(body.plan ?? body, {
            scope: body.scope, actor: body.actor ?? body.by ?? null,
          })
          return { plan: r.plan, idempotent: r.idempotent }
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
    id: 'team-plans',
    routes,
    /** 2 条；顺序与 `handle` 里原来那 2 条 `if` 相同。 */
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

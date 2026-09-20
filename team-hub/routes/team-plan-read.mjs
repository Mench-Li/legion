// team-hub/routes/team-plan-read.mjs
// ============================================================================
// 路由层第 45 族：**团队计划的读面（缺席一律 404、两种缺席分开报、version 可选）** —— PRT-316 切片 47
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 45 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show e9ae706:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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

// ============================================================================
// 以下 14 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── PRT-402：TeamPlan 与 EmployeeManifest 的读面 ────────────────────────
//
// 这两条来源在 `runtime/context/sources.mjs` 里都是 `required: true`，
// 而 hub 一直没有读端点，于是 `sources-loader.mjs` 只能传 `null`——
// **每次运行**都产出两条 `missing` 候选。那两条不是"世界就是这样"，
// 是"产品的这一块还没做"；而两者在账本上长得一模一样。
//
//    > 一个"每次运行都缺两条必需来源"的产品，
//    > 与一个"这次运行确实没有团队计划"的运行，在快照上长得一模一样——
//    > 只不过前者的那两条缺失**永远**不会消失，于是没有人会去看它们。
//
// 缺席一律 **404**（不是 200 带 null）：装配器把 404 翻成 `null`，
// 再由 `sources.mjs` 产出一条**带原因**的 `missing` 候选。若这里回 200 + null，
// "读到了、它是空的"与"读不到"就分不开了——而那正是整个装载器要防的事。


/**
 * 造团队计划的读面（缺席一律 404、两种缺席分开报、version 可选）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createTeamPlanReadRoutes({
  json,
  contextPlanStore, CONTEXT_PLAN_ERRORS,
}) {
  const deps = { json,
    contextPlanStore, CONTEXT_PLAN_ERRORS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createTeamPlanReadRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/team-plan',
      async run(req, res, { url }) {
        const scope = url.searchParams.get('scope')
        if (scope === null || scope.trim() === '') {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少 scope：计划是挂在空间上的' })
          return
        }
        const versionRaw = url.searchParams.get('version')
        let version = null
        if (versionRaw !== null && versionRaw.trim() !== '') {
          version = Number(versionRaw)
          if (!Number.isInteger(version) || version < 1) {
            json(res, 400, { ok: false, code: 'BAD_VERSION', error: 'version 必须是 >= 1 的整数' })
            return
          }
        }
        const plan = contextPlanStore().readTeamPlan(
          url.searchParams.get('id'),
          { scope, version, goalId: url.searchParams.get('goalId') },
        )
        if (plan === null) {
          // 说清是**哪一种**缺席：没有这个 id，还是没有这个目标下的计划。
          // 两者的修复动作不同（建一份计划 vs 把目标接上计划）。
          const askId = url.searchParams.get('id')
          const askGoal = url.searchParams.get('goalId')
          json(res, 404, {
            ok: false,
            code: CONTEXT_PLAN_ERRORS.TEAM_PLAN_NOT_FOUND,
            error: askId !== null && askId.trim() !== ''
              ? `空间 ${scope} 里没有团队计划 ${askId}${version === null ? '' : ` 的第 ${version} 版`}`
              : `空间 ${scope} 里没有挂在目标 ${askGoal} 下的团队计划`,
            serverTimeMs: Date.now(),
          })
          return
        }
        json(res, 200, { ok: true, plan, serverTimeMs: Date.now() })
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
    id: 'team-plan-read',
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

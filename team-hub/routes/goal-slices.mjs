// team-hub/routes/goal-slices.mjs
// ============================================================================
// 路由层第 46 族：**切片展开（testDesignerTaskId 必填，其余交给 expandGoalSlices）** —— PRT-316 切片 48
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 46 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 56608c5:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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
 * 造切片展开（testDesignerTaskId 必填，其余交给 expandGoalSlices）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createGoalSlicesRoutes({
  json,
  handleWrite, expandGoalSlices,
}) {
  const deps = { json,
    handleWrite, expandGoalSlices,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createGoalSlicesRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/goal/slices',
      async run(req, res) {
        // 切片展开：守护在 test-designer done 后解析 TASK_BREAKDOWN.md 并注册切片（见 ORCHESTRATION-V3）。
        await handleWrite(req, res, (body, by, scope) => {
          const testDesignerTaskId = body.testDesignerTaskId
          if (typeof testDesignerTaskId !== 'string' || testDesignerTaskId.length === 0) throw new Error('缺少参数 testDesignerTaskId')
          return expandGoalSlices({ testDesignerTaskId, slices: body.slices, by })
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
    id: 'goal-slices',
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

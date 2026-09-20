// team-hub/routes/create.mjs
// ============================================================================
// 路由层第 19 族：**建任务（写接口：title 必填、其余字段透传，落审计）** —— PRT-316 切片 20
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 19 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show b952854:team-hub/server.mjs` 的 `/api/create` 段落。
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
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// 写接口


/**
 * 造建任务（写接口：title 必填、其余字段透传，落审计）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createCreateRoutes({
  json,
  createTask, audit, handleWrite,
}) {
  const deps = { json,
    createTask, audit, handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createCreateRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/create',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const title = body.title
          if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
          const task = createTask({
            title: title.trim(), description: body.description, acceptance: body.acceptance, boundary: body.boundary,
            priority: body.priority, status: body.status, parent: body.parent, role: body.role,
            scope, ordersVersion: body.ordersVersion,
            blockedBy: body.blockedBy, slice: body.slice, sliceIdx: body.sliceIdx, fixOf: body.fixOf, fixCount: body.fixCount,
            goalId: body.goalId, fileDomain: body.fileDomain, docSync: body.docSync === true,
          })
          audit(by, scope, 'create', task.id, { title: task.title }, task.goalId)
          return task
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
    id: 'create',
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

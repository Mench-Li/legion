// team-hub/routes/model-migration.mjs
// ============================================================================
// 路由层第 27 族：**迁移老的非敏感模型配置（算一份计划 / 按确认过的指纹执行）** —— PRT-316 切片 28
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 27 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 9071278:team-hub/server.mjs` 的 `/api/model-migration` 段落。
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

// ============================================================================
// 以下 6 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── PRT-506：迁移老的非敏感模型配置 ──
//
// 计划与执行**分开**，而且执行时**服务端重新算一遍**再比对用户确认过的指纹。
// 理由：客户端送回来的计划可能已经过期（别的窗口改了配置、上次跑过一半），
// 而服务端自己重算又会让"用户确认的"和"实际执行的"变成两件事。
// 所以两者必须逐字节一致才动手。


/**
 * 造迁移老的非敏感模型配置（算一份计划 / 按确认过的指纹执行）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createModelMigrationRoutes({
  json,
  db, modelStore, bindingStore,
  planModelMigration, describeMigration, applyModelMigration,
  handleRun,
}) {
  const deps = { json,
    db, modelStore, bindingStore,
    planModelMigration, describeMigration, applyModelMigration,
    handleRun,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createModelMigrationRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-migration/plan',
      async run(req, res, { url }) {
        // runtimeType 不在查询串里时**不报 400**：这是一个只读的"报告"，
        // 而"必须选一种协议"正是报告要告诉用户的第一件事。返回 200 + 计划本身，
        // 前端才能据此渲染一个选择器，而不是先撞一个错误再猜该传什么。
        const runtimeType = (url.searchParams.get('runtimeType') ?? '').trim()
        const legacyRows = db.prepare('SELECT scope, role, provider, model FROM agent_models').all()
        const plan = planModelMigration({
          legacyRows,
          runtimeType,
          existingProfiles: modelStore.list().map((x) => x.id),
          existingBindings: bindingStore.list(null),
        })
        // 顶层刻意**不放** `ok`：计划自己有一个 `ok`，两个 `ok` 在不同层级上
        // 是真正会读错的东西（一个说"这次查询成功了"，一个说"这份计划能不能执行"）。
        json(res, 200, { plan, summary: describeMigration(plan), legacyRowCount: legacyRows.length, serverTimeMs: Date.now() })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/model-migration/apply',
      async run(req, res) {
        await handleRun(req, res, async (body) => {
          const legacyRows = db.prepare('SELECT scope, role, provider, model FROM agent_models').all()
          const plan = planModelMigration({
            legacyRows,
            runtimeType: body.runtimeType,
            existingProfiles: modelStore.list().map((x) => x.id),
            existingBindings: bindingStore.list(null),
            actor: body.actor,
          })
          if (plan.ok !== true) {
            const err = new Error(plan.message ?? '这份迁移计划不可执行')
            // 409：请求本身没问题，是**当前状态**不允许执行（比如没给协议、源里有密钥）。
            err.statusCode = 409
            err.code = plan.code
            err.plan = plan
            throw err
          }
          const result = await applyModelMigration(plan, {
            modelStore, bindingStore, actor: body.actor, expectedDigest: body.expectedDigest ?? null,
          })
          if (result.ok !== true) {
            const err = new Error(result.message ?? '迁移未完成')
            err.statusCode = 409
            err.code = result.code
            err.migration = result
            throw err
          }
          return { migration: result, plan }
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
    id: 'model-migration',
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

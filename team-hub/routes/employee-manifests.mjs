// team-hub/routes/employee-manifests.mjs
// ============================================================================
// 路由层第 23 族：**岗位清单（读一份 / 列一版 / 存一版）** —— PRT-316 切片 24
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 23 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show df698a6:team-hub/server.mjs` 的 `/api/employee-manifest` 段落。
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

/**
 * 造岗位清单（读一份 / 列一版 / 存一版）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createEmployeeManifestsRoutes({
  json,
  contextPlanStore, CONTEXT_PLAN_ERRORS, handleRun,
}) {
  const deps = { json,
    contextPlanStore, CONTEXT_PLAN_ERRORS, handleRun,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createEmployeeManifestsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/employee-manifest',
      async run(req, res, { url }) {
        const scope = url.searchParams.get('scope')
        if (scope === null || scope.trim() === '') {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少 scope：岗位边界是按空间定的' })
          return
        }
        const role = url.searchParams.get('role')
        const employeeId = url.searchParams.get('employeeId')
        if ((role === null || role.trim() === '') && (employeeId === null || employeeId.trim() === '')) {
          // 两个都不给就**不猜**：返回"任意一份清单"会让模型读到别人的边界，
          // 而它看起来完全正常。
          json(res, 400, {
            ok: false, code: 'MISSING_PARAM',
            error: '缺少 role 或 employeeId：不指定身份就取不到"我的边界"，'
              + '而随便给一份会让模型照着一个不是它的岗位约束干活',
          })
          return
        }
        const manifest = contextPlanStore().readEmployeeManifest({ scope, role, employeeId })
        if (manifest === null) {
          json(res, 404, {
            ok: false, code: CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND,
            error: `空间 ${scope} 里没有 ${role ?? employeeId} 的岗位清单`,
            serverTimeMs: Date.now(),
          })
          return
        }
        json(res, 200, { ok: true, manifest, serverTimeMs: Date.now() })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/employee-manifests',
      async run(req, res, { url }) {
        const scope = url.searchParams.get('scope')
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
        const items = contextPlanStore().listEmployeeManifests({ scope, limit })
        json(res, 200, { ok: true, manifests: items, count: items.length, serverTimeMs: Date.now() })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/employee-manifests',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = contextPlanStore().putEmployeeManifest(body.manifest ?? body, {
            scope: body.scope, actor: body.actor ?? body.by ?? null,
          })
          return { manifest: r.manifest, created: r.created }
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
    id: 'employee-manifests',
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

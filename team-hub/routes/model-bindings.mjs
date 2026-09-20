// team-hub/routes/model-bindings.mjs
// ============================================================================
// 路由层第 33 族：**岗位模型绑定与 fallback（PRT-502，spec §6.6）** —— PRT-316 切片 35
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 33 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 87a8091:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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
// 以下 8 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 岗位模型绑定与 fallback（PRT-502，spec §6.6） ──
//
// 键是 (scope, employee_role)：同一条流水线里编码岗与审查岗可以绑不同模型，
// 不同空间也可以各绑各的。
//
// **写入时就要验主档案能解析**：等到运行时才发现 `primaryProfile` 打错了，
// 那次运行已经认领了任务、烧掉一次尝试，而错误出现在运行日志里——
// 不是在"保存配置"这个动作上，后者才是真正能改的地方。


/**
 * 造岗位模型绑定与 fallback（PRT-502，spec §6.6）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createModelBindingsRoutes({
  json,
  bindingStore, handleRun, BINDING_STORE_ERRORS,
}) {
  const deps = { json,
    bindingStore, handleRun, BINDING_STORE_ERRORS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createModelBindingsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-bindings',
      async run(req, res, { url }) {
        const scope = url.searchParams.get('scope')
        json(res, 200, { ok: true, bindings: bindingStore.list(scope), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/model-bindings',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const b = bindingStore.upsert({
            scope: body.scope,
            employeeRole: body.employeeRole,
            primaryProfile: body.primaryProfile,
            fallbackProfiles: body.fallbackProfiles ?? [],
            perRunBudget: body.perRunBudget ?? null,
          }, { actor: body.actor })
          return { binding: b }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-bindings/resolve',
      async run(req, res, { url }) {
        // 「这个岗位现在该依次用哪些模型，为什么」。
        // 绑定不存在时 404 而不是 200 带空链：空链会被下游读成"没有可用的模型"，
        // 而真实情况是"没有绑定"——前者要人去建档案，后者要人去建绑定。
        const scope = url.searchParams.get('scope')
        const role = url.searchParams.get('role')
        // 显式验参数，**不靠异常决定状态码**：`bindingStore.resolve` 在缺 role 时
        // 会抛 ROLE_REQUIRED，而这个分支没有包在 `handleRun` 里——异常逃到外层
        // 兜底处理器就变成 500。于是"调用方少传一个参数"报成了"服务端出错"，
        // 运维会去查服务端日志，而真正要做的是补上参数。
        if (scope === null || scope.trim() === '') {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少 scope（绑定是 (scope, role) 二元的）' })
          return
        }
        if (role === null || role.trim() === '') {
          json(res, 400, { ok: false, code: 'ROLE_REQUIRED', error: '缺少 role：没有岗位就没有"该用哪个模型"的主语' })
          return
        }
        const r = bindingStore.resolve(scope, role)
        if (r.code === BINDING_STORE_ERRORS.BINDING_NOT_FOUND) {
          json(res, 404, { ok: false, code: r.code, error: r.message, serverTimeMs: Date.now() })
          return
        }
        json(res, 200, { ok: true, resolution: r, serverTimeMs: Date.now() })
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
    id: 'model-bindings',
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

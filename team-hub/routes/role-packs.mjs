// team-hub/routes/role-packs.mjs
// ============================================================================
// 路由层第 10 族：**冻结的岗位包（role-packs）：只追加的版本化冻结 —— 冻结一版/列版本/审阅文本导出** —— PRT-316 切片 10
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 10 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show cf46468:team-hub/server.mjs` 的 `/api/role-packs` 段落。
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
// 以下 13 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── F-19 冻结的岗位包 ──────────────────────────────────────────────
//
// 三条路由，围绕着**只追加的版本化冻结**：
//   · `POST /api/role-packs`            冻结一版（幂等或 409，没有第三种）
//   · `GET  /api/role-packs`            列各版本 / 取一版（不传 version = 最新）
//   · `GET  /api/role-packs/export`     导出成可提交进 Git 的审阅文本
//
// ★ **刻意没有"改一版"或"删一版"的路由**：冻结的全部含义就是"当时是哪一版"，
// 而一条改/删的路由会让那个问题在**写的那一刻**失去答案。
// 确实改了内容就再冻一版——`freezeRolePack` 会拒绝"同版本换内容"。
//
// 与 F-20 那组的分工：那一组存的是**能力包**的安装事实（装了什么），
// 这一组存的是**岗位**的冻结描述（这个岗位当时是哪一版）。两者都不做推导。


/**
 * 造冻结的岗位包（role-packs）：只追加的版本化冻结 —— 冻结一版/列版本/审阅文本导出族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createRolePacksRoutes({
  json,
  authorized, handleRun, freezeRolePack,
  listRolePacks, optionalIntParam, getRolePack,
  rolePackCounts, exportRolePacks, db,
}) {
  const deps = { json,
    authorized, handleRun, freezeRolePack,
    listRolePacks, optionalIntParam, getRolePack,
    rolePackCounts, exportRolePacks, db,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createRolePacksRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/role-packs',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = freezeRolePack({
            db,
            scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
            record: {
              // `pack` 原样收下（见 `role-pack-store.mjs` 文件头 ③）：
              // 控制面不挑字段、不重排、不补默认值——挑字段就是一份多余的转写。
              pack: body.pack,
              frozenAtMs: body.frozenAtMs,
              frozenBy: body.frozenBy ?? null,
            },
          })
          return {
            ok: true,
            frozen: r.frozen,
            // `created:false` 是**幂等重放**，不是"已经有一模一样的了所以不算数"。
            // 调用方需要能分清"我冻了新的一版"与"这一版早就冻过"。
            created: r.created,
            rolePackId: r.record.projected.rolePackId,
            version: r.record.projected.version,
            contentHash: r.record.projected.contentHash,
            frozenAtMs: r.record.frozenAtMs,
          }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/role-packs',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const rolePackId = url.searchParams.get('rolePackId')
        const version = url.searchParams.get('version')
        const role = url.searchParams.get('role')
        const scope = url.searchParams.get('scope') ?? 'default'
        // ★ **形状不随查询参数变**：永远是 `records`（一个清单）+ `latest`（可能是 null）。
        //
        //   早先的写法是"给了 rolePackId 就返回单条 `record`，否则返回 `records`"——
        //   于是调用方必须知道"我刚才给没给 rolePackId"才知道该读哪个字段，
        //   而一份"读哪个字段取决于我传了什么参数"的响应，与一份随机的响应
        //   在调用方代码里是同一个东西（它只能两个都试一遍）。
        //
        //   `version` 只是**过滤**这个清单，不改变它的形状。
        const all = listRolePacks({ db, role, rolePackId, scope, limit: optionalIntParam(url, 'limit') })
        const records = version === null || version === ''
          ? all
          : all.filter((r) => r.pack?.version === version)
        json(res, 200, {
          ok: true,
          records,
          // "这个 id 现在该用哪一版"是另一个问题，同一个请求一并回答——
          // 但它按 `frozen_at_ms DESC, version DESC` 定序，**不依赖数组顺序**。
          latest: rolePackId === null || rolePackId === ''
            ? null
            : getRolePack({ db, rolePackId, scope }),
          counts: rolePackCounts({ db, scope }),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/role-packs/export',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        const text = exportRolePacks({ db, scope })
        // 与包事实的导出同一条理由：返回**文本**，因为这份东西的用途是进 diff。
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="legion-role-packs-frozen.json"',
        })
        res.end(text)
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
    id: 'role-packs',
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

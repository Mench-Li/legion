// team-hub/routes/agent-intake.mjs
// ============================================================================
// 路由层第 44 族：**智能体登记（含 PRT-402 编队与岗位清单同事务）与选人入编（prefix+suffix 形状）** —— PRT-316 切片 46
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 44 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show fe83dd1:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 2 条的形态分布（生成器算的，不是抄的）
//
//   ×  1  `path === '…'`
//   ×  0  `path.startsWith('…')`
//   ×  1  `path.startsWith('…') && path.endsWith('…')`
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
 * 造智能体登记（含 PRT-402 编队与岗位清单同事务）与选人入编（prefix+suffix 形状）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createAgentIntakeRoutes({
  json,
  db, handleWrite, withTx,
  audit, contextPlanStore,
}) {
  const deps = { json,
    db, handleWrite, withTx,
    audit, contextPlanStore,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createAgentIntakeRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/agents',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const role = body.role
          const name = body.name
          if (typeof role !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(role)) throw new Error('智能体 role 非法：小写字母/数字开头，可含连字符，≤64 字符')
          if (typeof name !== 'string' || name.trim().length === 0) throw new Error('缺少参数 name')
          const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope

          // ★ PRT-402：编队那一行与岗位清单必须**一起成或一起不成**。
          //
          // 这是用例 `★ 边界内容里带明文密钥 → 拒绝，且编队那一行也不该被写进去`
          // **量出来的**：第一版没有包事务，于是清单写失败时编队那一行**已经落库**了，
          // 结果是"编队里有这个人、但他的清单没有"——而那种状态看起来一切正常
          // （列表里有他、任务照样派给他），只是他的岗位边界永远是 `missing`。
          //
          //   > 一个"先写编队再写清单、失败就报错"的接口，
          //   > 与一个"两件事在同一个事务里"的接口，在清单从不失败的时候是同一个东西——
          //   > 只不过前者会在清单失败的那一次留下一个**半成品**，
          //   > 而调用方从错误响应里看不出编队已经被改了。
          return withTx(() => {
          const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM roster WHERE scope = ?').get(targetScope).s
          db.prepare(`INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar`)
            .run(targetScope, role.trim(), name.trim(),
              typeof body.kind === 'string' ? body.kind : '',
              typeof body.avatar === 'string' && body.avatar.trim() ? body.avatar.trim() : '🤖', sort)
          audit(by, targetScope, 'agent:create', null, { role: role.trim(), name: name.trim() })

          // ── PRT-402：编队变更时同步写一份岗位清单 ───────────────────────
          //
          // 这是 EmployeeManifest 的**生产触发点**：在此之前的实情是"表有了、
          // 读端点了、装载器会读了，但没有任何地方写"——与 `TeamPlan` 那半边同源。
          //
          // ★ **只有在调用方真的给了边界内容时才写。** 编队记录本来只有
          //   role/name/kind/avatar，没有"允许用什么工具、要不要审批"。
          //   此时若替它写一份**空**清单，`allowedTools: []` 会被模型读成
          //   "这个岗位不允许使用任何工具"——那是一条**假规则**。
          //
          //   > 一个"没配置就写一份空清单"的实现，与一个"没配置就不写"的实现，
          //   > 在界面上都显示"没有"——只不过前者会让模型读到一条它自己
          //   > 编出来的岗位规则，而那句话会**改变它的行为**。
          //
          //   不写，装载器就产出一条带原因的 `missing`（"这次运行没有关联任何
          //   员工清单"），那才是实话。
          //
          // ★ `employeeId` 是**岗位在这个空间里的地址**，不是一个人。
          //   hub 的编队是按 role 的（`roster(scope, role)`），没有"某个员工"
          //   这个实体；写一个凭空的个人 id 比写这个可读地址更坏。
          //   调用方要给真身份就显式传 `employeeId`。
          const boundary = {
            responsibilities: body.responsibilities,
            allowedTools: body.allowedTools,
            deniedTools: body.deniedTools,
            approvalPolicy: body.approvalPolicy,
            limits: body.limits,
          }
          const hasBoundary = Object.values(boundary).some((v) => v !== undefined && v !== null)
          let manifestRef = null
          if (hasBoundary) {
            const written = contextPlanStore().putEmployeeManifest({
              role: role.trim(),
              employeeId: typeof body.employeeId === 'string' && body.employeeId.trim() !== ''
                ? body.employeeId.trim()
                : `${targetScope}/${role.trim()}`,
              displayName: name.trim(),
              responsibilities: boundary.responsibilities ?? [],
              allowedTools: boundary.allowedTools ?? [],
              deniedTools: boundary.deniedTools ?? [],
              approvalPolicy: boundary.approvalPolicy ?? null,
              limits: boundary.limits ?? {},
            }, { scope: targetScope, actor: by })
            manifestRef = { role: written.manifest.role, version: written.manifest.version, created: written.created }
          }

          return { scope: targetScope, role: role.trim(), name: name.trim(), employeeManifest: manifestRef }
          })
        })
      },
    },
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: '/api/spaces/',
      suffix: '/agents',
      async run(req, res, { path }) {
        // 选人入编：把全局目录中的若干智能体（按 role）复制进该空间编队。
        await handleWrite(req, res, (body, by, scope) => {
          const id = decodeURIComponent(path.slice('/api/spaces/'.length, -'/agents'.length))
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法')
          if (!Array.isArray(body.roles) || body.roles.length === 0) throw new Error('缺少参数 roles（智能体 role 数组）')
          const roles = [...new Set(body.roles.map(String))]
          const placeholders = roles.map(() => '?').join(',')
          const rows = db.prepare(`SELECT role, name, kind, avatar FROM roster WHERE role IN (${placeholders})`).all(...roles)
          const byRole = new Map()
          for (const r of rows) if (!byRole.has(r.role)) byRole.set(r.role, r)
          const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM roster WHERE scope = ?').get(id).s
          let added = 0
          for (const role of roles) {
            const src = byRole.get(role)
            if (!src) continue
            db.prepare(`INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar`)
              .run(id, src.role, src.name, src.kind, src.avatar, sort + added)
            added += 1
          }
          audit(by, id, 'space:add-agents', null, { roles })
          return { space: id, added, roles }
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
    id: 'agent-intake',
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

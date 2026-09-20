// team-hub/routes/read-models.mjs
// ============================================================================
// 路由层第 31 族：**读接口** —— PRT-316 切片 33
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 31 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show e392793:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 8 条的形态分布（生成器算的，不是抄的）
//
//   ×  8  `path === '…'`
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
// 8 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// 读接口


/**
 * 造读接口族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createReadModelsRoutes({
  json,
  db, listTasks, rowToTask,
  pipelineLabels, now, settleGoalsOfScope,
  listGoals, goalView, SCOPE_KEY_RE,
  readPipeline,
}) {
  const deps = { json,
    db, listTasks, rowToTask,
    pipelineLabels, now, settleGoalsOfScope,
    listGoals, goalView, SCOPE_KEY_RE,
    readPipeline,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createReadModelsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/board',
      async run(req, res, { url }) {
        json(res, 200, listTasks({
          status: url.searchParams.get('status') ?? undefined,
          soldier: url.searchParams.get('soldier') ?? undefined,
          role: url.searchParams.get('role') ?? undefined,
          scope: url.searchParams.get('scope') ?? undefined,
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/task',
      async run(req, res, { url }) {
        // 单任务详情（任务详情视图数据源）。
        const id = url.searchParams.get('id')
        if (!id) { json(res, 400, { error: '缺少参数 id' }); return }
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
        if (!row) { json(res, 404, { error: `未知任务 ${id}` }); return }
        json(res, 200, rowToTask(row))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/missions',
      async run(req, res, { url }) {
        // 真 scope 分区：按 tasks.scope 过滤聚合（与 serve.mjs /api/missions 响应同构，scopeAware=true）。
        const scopeParam = url.searchParams.get('scope') ?? undefined
        const rows = listTasks({ scope: scopeParam })
        const labels = pipelineLabels()
        const byRole = new Map()
        for (const t of rows) {
          if (t.status === 'canceled') continue
          const role = t.role ?? t.soldier ?? 'unassigned'
          const arr = byRole.get(role) ?? []
          arr.push(t)
          byRole.set(role, arr)
        }
        const missions = [...byRole.entries()].map(([role, list]) => {
          const done = list.filter(t => t.status === 'done').length
          const inProgress = list.filter(t => t.status === 'in_progress').length
          const inReview = list.filter(t => t.status === 'in_review').length
          const blocked = list.filter(t => t.status === 'blocked').length
          const waiting = list.filter(t => t.status === 'todo' || t.status === 'backlog').length
          const total = list.length
          const percent = total === 0 ? 0 : Math.round((done / total) * 100)
          let status = 'running'
          if (blocked > 0) status = 'blocked'
          else if (done === total) status = 'done'
          else if (inProgress === 0 && inReview === 0) status = 'waiting'
          return {
            role,
            name: labels[role] ?? role,
            total,
            done,
            inProgress,
            inReview,
            blocked,
            waiting,
            percent,
            status,
            tasks: list.map(t => ({ id: t.id, title: t.title, status: t.status })),
          }
        })
        const rank = { running: 0, waiting: 1, blocked: 2, done: 3 }
        missions.sort((a, b) => rank[a.status] - rank[b.status] || b.percent - a.percent)
        json(res, 200, { generatedAt: now(), scope: scopeParam ?? null, scopeAware: true, missions })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/scopes',
      async run(req, res) {
        // 真实存在的分区：任务 + 成员表中的 distinct scope。
        const fromTasks = db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all()
        const fromMembers = db.prepare("SELECT DISTINCT scope FROM members WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all()
        const scopes = [...new Set([...fromTasks, ...fromMembers].map(r => r.scope))]
        json(res, 200, { scopes })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/spaces',
      async run(req, res) {
        // 工作空间列表：spaces 表注册名 + 未注册的既有 scope（roster/tasks）推导合并。
        const known = db.prepare('SELECT * FROM spaces ORDER BY id').all()
        const fromRoster = db.prepare("SELECT DISTINCT scope FROM roster WHERE scope != '' ORDER BY scope").all().map(r => r.scope)
        const fromTasks = db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all().map(r => r.scope)
        const byId = new Map(known.map(k => [k.id, k]))
        const ids = [...new Set([...byId.keys(), ...fromRoster, ...fromTasks])]
        const countStmt = db.prepare('SELECT COUNT(*) AS c FROM roster WHERE scope = ?')
        const spaces = ids.map(id => {
          const k = byId.get(id)
          return {
            id, name: k?.name ?? id, private: !!k?.private,
            localDir: k?.local_dir ?? '', remoteUrl: k?.remote_url ?? '',
            agentCount: countStmt.get(id).c,
          }
        })
        json(res, 200, { spaces })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/goal',
      async run(req, res, { url }) {
        // 目标列表（多目标并发模型）：scope 全部目标，每行 = 目标记录 + 按该目标链任务（goalId）实时算的进度。
        // objective/done/total/percent = 汇总兼容字段（未取消目标的任务合计；objective = 最新 active 目标文案）。
        const scopeParam = url.searchParams.get('scope') ?? ''
        if (scopeParam) settleGoalsOfScope(scopeParam) // 链全部完成 → 目标自动 done（幂等，只有状态变化才写）
        const goals = scopeParam ? listGoals(scopeParam).map(goalView) : []
        const counted = goals.filter(g => g.status !== 'canceled')
        const done = counted.reduce((a, g) => a + g.done, 0)
        const total = counted.reduce((a, g) => a + g.total, 0)
        const latestActive = goals.find(g => g.status === 'active') ?? null
        json(res, 200, {
          scope: scopeParam,
          goals,
          objective: latestActive?.objective ?? null,
          done, total,
          percent: total > 0 ? Math.round((done / total) * 100) : 0,
          updatedAt: latestActive?.updatedAt ?? null,
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/pipeline',
      async run(req, res, { url }) {
        // SP-P0：空间流水线（数据面单源）。守护每轮扫单读这里（hub 优先，部署面 rolesFile 兜底）；
        // 指挥台用它渲染岗位契约。version = 内容指纹：未变化时守护零成本跳过重建。
        const scopeParam = (url.searchParams.get('scope') ?? '').trim()
        if (!SCOPE_KEY_RE.test(scopeParam)) { json(res, 400, { error: 'scope 非法（字母/数字/下划线/连字符，≤64 字符）' }); return }
        const includeDisabled = (url.searchParams.get('include') ?? '') !== 'active'
        json(res, 200, readPipeline(scopeParam, { includeDisabled }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/agents',
      async run(req, res) {
        // 全局智能体目录：所有空间编队的并集（按 role 去重，标注来源空间），供选人入编。
        const rows = db.prepare('SELECT scope, role, name, kind, avatar FROM roster ORDER BY role, scope').all()
        const byRole = new Map()
        for (const r of rows) {
          const e = byRole.get(r.role) ?? { role: r.role, name: r.name, kind: r.kind, avatar: r.avatar, scopes: [] }
          e.scopes.push(r.scope)
          byRole.set(r.role, e)
        }
        json(res, 200, { agents: [...byRole.values()] })
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
    id: 'read-models',
    routes,
    /** 8 条；顺序与 `handle` 里原来那 8 条 `if` 相同。 */
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

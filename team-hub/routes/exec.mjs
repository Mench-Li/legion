// team-hub/routes/exec.mjs
// ============================================================================
// 路由层第 24 族：**自动执行开关与请求队列（开关读/写 + 待执行队列 + 请求登记/查看）** —— PRT-316 切片 25
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 24 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show cc04471:team-hub/server.mjs` 的 `/api/exec` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 5 条的形态分布（生成器算的，不是抄的）
//
//   ×  5  `path === '…'`
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
// 5 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造自动执行开关与请求队列（开关读/写 + 待执行队列 + 请求登记/查看）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createExecRoutes({
  json,
  db, audit, now,
  listTasks, NON_AUTO_ROLES, handleWrite,
}) {
  const deps = { json,
    db, audit, now,
    listTasks, NON_AUTO_ROLES, handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createExecRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/exec',
      async run(req, res, { url }) {
        const scopeParam = url.searchParams.get('scope') ?? ''
        const hit = scopeParam ? db.prepare('SELECT * FROM exec_state WHERE scope = ?').get(scopeParam) : undefined
        json(res, 200, { scope: scopeParam, enabled: !!hit?.enabled, updatedAt: hit?.updatedAt ?? null })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/exec',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
          const enabled = body.enabled === true
          db.prepare('INSERT INTO exec_state (scope, enabled, updatedAt) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled, updatedAt=excluded.updatedAt')
            .run(targetScope, enabled ? 1 : 0, now())
          audit(by, targetScope, 'exec:toggle', null, { enabled })
          return { scope: targetScope, enabled }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/exec/queue',
      async run(req, res, { url }) {
        // 应由编排自动执行的任务：自动目标链中「非写码角色」的待办/进行中任务。
        const scopeParam = url.searchParams.get('scope') ?? undefined
        const rows = listTasks({ scope: scopeParam }).filter(t =>
          (t.status === 'todo' || t.status === 'in_progress') &&
          String(t.description ?? '').includes('[auto-goal]') &&
          !NON_AUTO_ROLES.has(t.role ?? ''),
        )
        const pending = new Set(db.prepare("SELECT taskId FROM exec_requests WHERE status='pending'").all().map(r => r.taskId))
        json(res, 200, { scope: scopeParam ?? 'all', tasks: rows.filter(t => !pending.has(t.id)) })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/exec/request',
      async run(req, res) {
        // 用户点「派 AI 执行」：记录请求（含写码类任务），由执行守护消费。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.taskId
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 taskId')
          const t = db.prepare('SELECT scope FROM tasks WHERE id = ?').get(id)
          if (!t) throw new Error(`未知任务 ${id}`)
          db.prepare('INSERT INTO exec_requests (taskId, scope, status, createdAt) VALUES (?, ?, \'pending\', ?) ON CONFLICT(taskId) DO UPDATE SET status=\'pending\'')
            .run(id, t.scope, now())
          audit(by, t.scope, 'exec:request', id, {})
          return { taskId: id, scope: t.scope, status: 'pending' }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/exec/requests',
      async run(req, res) {
        const rows = db.prepare("SELECT * FROM exec_requests WHERE status='pending' ORDER BY createdAt").all()
        json(res, 200, rows.map(r => ({ taskId: r.taskId, scope: r.scope, createdAt: r.createdAt })))
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
    id: 'exec',
    routes,
    /** 5 条；顺序与 `handle` 里原来那 5 条 `if` 相同。 */
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

// team-hub/routes/activity.mjs
// ============================================================================
// 路由层第 48 族：**活动流水（四个分支按 goalId > taskId > scope > 全量排优先级）** —— PRT-316 切片 50
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 48 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 84a2293:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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
 * 造活动流水（四个分支按 goalId > taskId > scope > 全量排优先级）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createActivityRoutes({
  json,
  db, auditEvent,
}) {
  const deps = { json,
    db, auditEvent,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createActivityRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/activity',
      async run(req, res, { url }) {
        // ★★★★★ 2026-09-20 修（当初原样搬过来时**钉住未修**的第 21 条缺陷）：
        //   原式 `Math.min(Number(v ?? 50) || 50, 500)` 只夹了**上界**，于是：
        //     · `limit=2.7` ⇒ 值是 2.7（没取整）⇒ 原样进 `LIMIT ?` ⇒ **SQLite 抛错**
        //       ⇒ `handle()` 的兜底把它变成 **500**。一个查询参数能把**只读**接口打成 500。
        //     · `limit=-5` ⇒ `Math.min(-5, 500) = -5`，而 SQLite 的**负** `LIMIT` 意思是
        //       **不限制** ⇒ "我只要 5 条"变成"给我全部"。
        //   ⇒ 先 `Math.trunc` 取整（消灭 500），再夹到 `[1, 500]`（消灭负数那个洞）。
        //   ★ 语义**保持不变**的两处：`limit=0` 与 `limit=abc` 仍回落到 50
        //     —— `|| 50` 在 `Math.trunc` **之前**，所以 `0` 仍然是 falsy。
        const n = Math.trunc(Number(url.searchParams.get('limit') ?? 50) || 50)
        const limit = Math.min(Math.max(n, 1), 500)
        const scopeParam = url.searchParams.get('scope')
        const taskIdParam = url.searchParams.get('taskId')
        const goalIdParam = url.searchParams.get('goalId')
        let rows
        if (goalIdParam) {
          // per-goal 活动视图：goal 事件（audit.goalId）+ 该目标链任务的 task 事件（反查 tasks.goalId）。
          rows = db.prepare(`SELECT * FROM audit WHERE goalId = ? OR (taskId IN (SELECT id FROM tasks WHERE goalId = ?)) ORDER BY seq DESC LIMIT ?`)
            .all(goalIdParam, goalIdParam, limit)
        } else if (taskIdParam) {
          rows = db.prepare('SELECT * FROM audit WHERE taskId = ? ORDER BY seq').all(taskIdParam)
        } else if (scopeParam) {
          rows = db.prepare('SELECT * FROM audit WHERE scope = ? ORDER BY seq DESC LIMIT ?').all(scopeParam, limit)
        } else {
          rows = db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
        }
        json(res, 200, rows.map(auditEvent))
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
    id: 'activity',
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

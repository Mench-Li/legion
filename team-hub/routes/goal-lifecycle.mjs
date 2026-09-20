// team-hub/routes/goal-lifecycle.mjs
// ============================================================================
// 路由层第 38 族：**目标的发布与生命周期：发布（含阶段任务链）/ 读取目标上下文 / 暂停·恢复·取消** —— PRT-316 切片 40
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 38 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show f6be274:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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
 * 造目标的发布与生命周期：发布（含阶段任务链）/ 读取目标上下文 / 暂停·恢复·取消族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createGoalLifecycleRoutes({
  json,
  handleWrite, publishGoalRecord, setGoalContext,
  setGoalState,
}) {
  const deps = { json,
    handleWrite, publishGoalRecord, setGoalContext,
    setGoalState,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createGoalLifecycleRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/goal',
      async run(req, res) {
        // 发布目标（多目标并发）：每次都**新建**一个目标记录（G-xxx，status=active，version=1），
        // 并为其生成独立阶段任务链（链任务全部挂 goalId）。**不取消**该空间既有目标/旧链任务——
        // 多个目标可并存、各自的链由守护并行推进；将军可对单个目标 暂停/恢复/取消（/api/goal/status）。
        await handleWrite(req, res, (body, by, scope) => {
          const objective = body.objective
          if (typeof objective !== 'string' || objective.trim().length === 0) throw new Error('缺少参数 objective')
          const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
          // RC-2：body.docSync / body.feature=true → 目标级 docSync 声明（链上 coder 任务承接，见 createGoalChain）
          const docSync = body.docSync === true || body.feature === true
          return publishGoalRecord(targetScope, objective, body.mode === 'slice' ? 'slice' : 'chain', by, docSync)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/goal/context',
      async run(req, res) {
        // 目标级上下文（同目标共享上下文）：仅将军；bump contextVersion；审计 + SSE。
        // 语义 = 下一派工对齐：正在跑的 worker 不打断，下一次派工注入最新 context/版本（守护写镜像 docs/goals/<id>.md）。
        await handleWrite(req, res, (body, by) => setGoalContext(body.id, body.text, by, body.forceGeneral === true))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/goal/status',
      async run(req, res) {
        // 目标状态生命周期（仅将军）：active ↔ paused；done/canceled 终态（见 setGoalState）。
        await handleWrite(req, res, (body, by) => setGoalState(body.id, body.status, by, body.forceGeneral === true))
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
    id: 'goal-lifecycle',
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

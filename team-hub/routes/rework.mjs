// team-hub/routes/rework.mjs
// ============================================================================
// 路由层：**重做（验收不满意 → 打回重做 + 重建下游链）** —— 1 条，`exact`
//
//   POST /api/rework
//
// ## 为什么它是一条独立的路由，而不是 `/api/transition` 的一个参数
//
// 它在**一个事务里做四件事**：作废旧链（本环 + 下游）→ 发一个新目标承接重做链 →
// 把重做链按 `blockedBy` 串好建出来 → 把改动点回填成评论（旧任务指向新任务、新任务带改动点）。
//
// 把这件事塞进 `transition` 的代价是：`transition` 的语义会变成"有时候只是改个状态、
// 有时候会新建一个目标并在另一个目标下建出整条链"，而**调用方看不出是哪种**——
// 它拿到的是同一个 `{ok, task}`。看板拖拽、手机端、脚本三处调用方需要的东西也不同：
// 前者要新链的 id 去刷新泳道，后两者只需要一句"成了"。
//
// ## 与 `advancePipeline`（守护的自动流转）的分工
//
// 守护那条路是"任务 done → 补建下一环"（**同目标**、只补下一环、不存在的环才补）。
// 本路由是"人判定已验收的产出不合格 → 整条下游一起重来"（**新目标**、一次建全链）。
// 两者都会建任务，但触发者与范围都不同；这里**不**去掉守护的逻辑——
// 正常推进仍然走它，本路由只在人被明确否决时介入。
// ============================================================================

/**
 * 造重做路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createReworkRoutes({
  json,
  handleWrite, reworkTask, audit,
}) {
  const deps = { json, handleWrite, reworkTask, audit }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createReworkRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/rework',
      async run(req, res) {
        // 响应形状是**展平**的（`envelope: null`）：这次写的结果不是"那个任务"，
        // 而是一份重做报告（新目标 + 建出来的链 + 被作废的旧任务）。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          // scope 只在**显式给出**时参与校验：`readScope` 的缺省是 'default'，
          // 拿它去比会让 software 空间的任务全部撞 SCOPE_MISMATCH。
          const result = reworkTask({
            id,
            by,
            reason: body.reason,
            ifVersion: body.ifVersion,
            scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : undefined,
          })
          audit(by, scope, 'rework:chain', id, {
            newGoalId: result.goal.id,
            created: result.created.map(c => c.id),
            superseded: result.superseded,
          }, result.goal.id)
          return result
        }, { envelope: null })
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
    id: 'rework',
    routes,
    /** 1 条；与前缀族/等值族的匹配规则一致（本族只有等值）。 */
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

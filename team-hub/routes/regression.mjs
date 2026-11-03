// team-hub/routes/regression.mjs
// ============================================================================
// F9 · 回归用例的 HTTP 面（设计稿 §8.4 / M7-2）
//
//   GET  /api/regression-cases?state=            只读：草稿/在用集
//   POST /api/regression-cases/candidates        由失败簇生成 draft（幂等）
//   POST /api/regression-cases/:id/promote       draft → active（**只有人**，I-9.1）
//
// 为什么晋升要单开一个端点而不是"生成时直接 active"：
// 自动晋升的回归集会迅速长出一堆永远红的用例，然后所有人学会忽略它。
// 门必须握在人手里，而且是**显式的一次动作**。
// ============================================================================

const PREFIX = '/api/regression-cases/'
const PROMOTE_SUFFIX = '/promote'

export function createRegressionRoutes({
  json, db, handleWrite,
  listCases, promoteCase, clusterFailures, draftCaseFor, saveDraft,
}) {
  for (const [key, value] of Object.entries({ json, db, handleWrite, listCases, promoteCase, clusterFailures, draftCaseFor, saveDraft })) {
    if (value === undefined || value === null) throw new TypeError(`createRegressionRoutes 缺注入项：${key}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/regression-cases',
      async run(req, res, ctx) {
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const cases = listCases(db, { state: q.get('state') })
        const byState = { draft: 0, active: 0, retired: 0 }
        for (const c of cases) byState[c.state] = (byState[c.state] ?? 0) + 1
        return json(res, 200, { count: cases.length, byState, cases })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/regression-cases/candidates',
      async run(req, res) {
        await handleWrite(req, res, async (body) => {
          const clusters = clusterFailures(db, { since: body?.since ?? null, limit: body?.limit ?? 500 })
            .slice(0, Math.max(1, Number(body?.top ?? 5)))
          const drafts = clusters.map((cluster) => {
            const saved = saveDraft(db, draftCaseFor(cluster))
            return { id: saved.id, clusterKey: saved.cluster_key, state: saved.state }
          })
          return { clusters: clusters.length, drafts }
        }, { envelope: null })
      },
    },
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: PROMOTE_SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -PROMOTE_SUFFIX.length)
        if (!raw) return json(res, 400, { error: '缺少用例 id' })
        const id = decodeURIComponent(raw)
        await handleWrite(req, res, async (body, by) => {
          const promoted = promoteCase(db, { id, by })
          return { case: promoted }
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
    id: 'regression',
    routes,
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

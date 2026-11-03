// team-hub/routes/shadow.mjs
// ============================================================================
// F10 · `GET /api/shadow-report`（设计稿 §8.5 / M11）
//
// 纯只读（I-10.1）：它回答"新规则会让历史决策翻转多少"，不产生任务、不写台账。
// ============================================================================
import { shadowReport as defaultShadow, SHADOW_ERRORS, ShadowError } from '../shadow-report.mjs'

export function createShadowRoutes({ json, db, shadowReport = defaultShadow }) {
  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/shadow-report',
      async run(req, res, ctx) {
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        try {
          const report = shadowReport(db, {
            candidateRuleId: q.get('candidateRuleId'),
            from: q.get('from'),
            to: q.get('to'),
            threshold: q.get('threshold') === null ? undefined : Number(q.get('threshold')),
          })
          return json(res, 200, report)
        } catch (error) {
          if (error instanceof ShadowError) {
            return json(res, error.statusCode ?? 422, { error: error.message, code: error.code })
          }
          throw error
        }
      },
    },
  ]

  return {
    id: 'shadow',
    routes,
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || ctx.path !== r.path) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

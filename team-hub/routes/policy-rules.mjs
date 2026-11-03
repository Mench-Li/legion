// team-hub/routes/policy-rules.mjs
// ============================================================================
// F4 · 规则集的读写面（设计稿 §3 F4 / M5）
//
//   GET  /api/policy-rules[?enabled=1&scope=]   只读：规则 + 当前策略版本
//   POST /api/policy-rules                      维护（走 handleWrite：by 必填 + audit + 事件）
//
// 只读面带 `version`：调用方（看板 / 守护）要能回答"这条 mandate 是按哪版规则签的"。
// 写入面**只写事件、不撤销在途任务**（I-4.4）——规则变了不等于已有任务作废。
// ============================================================================
import { listPolicyRules as defaultList, upsertPolicyRule as defaultUpsert, policyVersion as defaultVersion } from '../policy-rules.mjs'

export function createPolicyRulesRoutes({ json, db, handleWrite, audit, listPolicyRules = defaultList, upsertPolicyRule = defaultUpsert, policyVersion = defaultVersion }) {
  for (const [key, value] of Object.entries({ json, db, handleWrite })) {
    if (value === undefined || value === null) throw new TypeError(`createPolicyRulesRoutes 缺注入项：${key}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/policy-rules',
      async run(req, res, ctx) {
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const rules = listPolicyRules(db, {
          enabledOnly: q.get('enabled') === '1',
          scope: q.get('scope'),
        })
        return json(res, 200, { count: rules.length, version: policyVersion(db), rules })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/policy-rules',
      async run(req, res) {
        await handleWrite(req, res, async (body, by) => {
          const out = upsertPolicyRule(db, {
            id: body.id, kind: body.kind, text: body.text,
            scope: body.scope, enabled: body.enabled, ruleRef: body.ruleRef ?? body.rule_ref,
          }, { by, audit })
          return { rule: out.rule, created: out.created, version: out.version }
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
    id: 'policy-rules',
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

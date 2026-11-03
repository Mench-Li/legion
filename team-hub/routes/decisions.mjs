// team-hub/routes/decisions.mjs
// ============================================================================
// F4 · 受理台账的只读面（设计稿 §3 F4 / M5）
//
//   GET /api/decisions?kind=&wouldAccept=&subject=&from=&to=&limit=&offset=
//   GET /api/tasks/:id/mandate[?all=1]
//
// 为什么只读先落地：台账的价值全在"事后能答"，写入口（transitionTask 里写 mandate
// 与 decision，DEC-1）要动状态机，等到同一轮的另一半再上；先把"能查"这件事做实，
// 后面写进去的东西才有人看得见。
// ============================================================================

const TASK_PREFIX = '/api/tasks/'
const TASK_SUFFIX = '/mandate'

/**
 * @param deps.json / deps.db / deps.listDecisions
 */
export function createDecisionRoutes({
  json, db, listDecisions, reconcileEvents = null, weeklyReport = null,
  handleWrite = null, setBaseline = null, listBaselines = null,
}) {
  for (const [key, value] of Object.entries({ json, db, listDecisions })) {
    if (value === undefined || value === null) throw new TypeError(`createDecisionRoutes 缺注入项：${key}`)
  }

  const routes = [
    {
      // F11（设计稿 §8.6 / I-11.1）：基线只读面。
      method: 'GET',
      match: 'exact',
      path: '/api/metric-baseline',
      async run(req, res, ctx) {
        if (typeof listBaselines !== 'function') return json(res, 503, { error: '基线未接线' })
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const rows = listBaselines(db, { scope: q.get('scope') })
        return json(res, 200, { count: rows.length, baselines: rows })
      },
    },
    {
      // F11：基线写入口。**只有人能写**——校验在 setBaseline 里，这里只透传错误码。
      method: 'POST',
      match: 'exact',
      path: '/api/metric-baseline',
      async run(req, res) {
        if (typeof handleWrite !== 'function' || typeof setBaseline !== 'function') {
          return json(res, 503, { error: '基线写入口未接线' })
        }
        await handleWrite(req, res, async (body, by) => {
          const baseline = setBaseline(db, {
            metric: body.metric, scope: body.scope ?? 'default', value: body.value, by,
            at: body.at ?? null,
          })
          return { baseline }
        }, { envelope: null })
      },
    },
    {
      // F5（设计稿 §3 F5 观测）：周报六个数的只读出口。
      method: 'GET',
      match: 'exact',
      path: '/api/report/weekly',
      async run(req, res, ctx) {
        if (typeof weeklyReport !== 'function') return json(res, 503, { error: '周报未接线' })
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const report = weeklyReport(db, { since: q.get('since'), now: q.get('now') })
        return json(res, 200, { ...report, at: new Date().toISOString() })
      },
    },
    {
      // F5（设计稿 §3 F5）：**只读**对账。差异只报不修——自动修复会把一次性的
      // 写入错误固化成永久的"一致"。
      method: 'GET',
      match: 'exact',
      path: '/api/reconcile',
      async run(req, res, ctx) {
        if (typeof reconcileEvents !== 'function') return json(res, 503, { error: '对账未接线' })
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const report = reconcileEvents(db, {
          untilSeq: q.get('untilSeq') === null ? null : Number(q.get('untilSeq')),
          scope: q.get('scope') ?? null,
        })
        return json(res, 200, { ...report, ok: report.mismatched.length === 0, at: new Date().toISOString() })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/decisions',
      async run(req, res, ctx) {
        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const rows = listDecisions(db, {
          kind: q.get('kind') ?? null,
          wouldAccept: q.get('wouldAccept') === null ? null : q.get('wouldAccept') === '1',
          subject: q.get('subject') ?? null,
          from: q.get('from') ?? null,
          to: q.get('to') ?? null,
          limit: Number(q.get('limit') ?? 200),
          offset: Number(q.get('offset') ?? 0),
        })
        return json(res, 200, {
          count: rows.length,
          decisions: rows.map((r) => ({ ...r, matched_rule_ids: safeJson(r.matched_rule_ids) })),
        })
      },
    },
    {
      method: 'GET',
      match: 'prefix+suffix',
      path: TASK_PREFIX,
      suffix: TASK_SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(TASK_PREFIX.length, -TASK_SUFFIX.length)
        if (!raw) return json(res, 400, { error: '缺少任务 id' })
        const id = decodeURIComponent(raw)
        const task = db.prepare('SELECT id, mandate, accept_mode FROM tasks WHERE id=?').get(id)
        if (!task) return json(res, 404, { error: `未知任务 ${id}` })

        const q = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const current = safeJson(task.mandate)
        // `all=1` 目前返回"当前版本 + 审计里的历史版本"；写入方就位后这里自然变长。
        const versions = current === null ? [] : [current]
        if (q.get('all') === '1') {
          const history = db.prepare(
            "SELECT detail, ts FROM audit WHERE taskId=? AND action='mandate' ORDER BY seq ASC",
          ).all(id)
          for (const row of history) {
            const parsed = safeJson(row.detail)
            if (parsed !== null) versions.push(parsed)
          }
        }
        return json(res, 200, { taskId: id, mandate: current, acceptMode: task.accept_mode ?? null, versions })
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
    id: 'decisions',
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

function safeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return null }
}

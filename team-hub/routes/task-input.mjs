// team-hub/routes/task-input.mjs
// ============================================================================
// 路由层 F0 只读面：**输入行**的两个读端口（PRT 风格：一族一文件、依赖注入）。
//
//   GET /api/tasks/:id/inputs[?includeSuperseded=1]   某任务的输入行
//   GET /api/reconcile/inputs[?scope=]                列 vs 行表的对账（只读）
//
// 为什么需要它们（设计稿 §3 F0）：
//   · 输入行已是唯一真相，但**真相要有稳定读端口**——否则每个消费方各拼一遍 SQL，
//     字段名一念之差就是"两个真相"；
//   · 对账必须能在 HTTP 面调用，否则"列与行是否一致"只有写测试的人知道；
//   · 对账**只读**：自动修复会把一次性的错误固化成永久的一致。
// ============================================================================

/** 行表 snake_case → 对外 camelCase。转换只此一处，避免调用方各自猜列名。 */
function toView(row) {
  let meta = {}
  try { meta = JSON.parse(row.meta ?? '{}') } catch { /* 坏 meta 当空对象 */ }
  return {
    id: row.id,
    kind: row.kind,
    actor: row.actor,
    actorKind: row.actor_kind,
    body: row.body,
    meta,
    createdAt: row.created_at,
    consumedAt: row.consumed_at ?? null,
    consumedBy: row.consumed_by ?? null,
    superseded: row.superseded ? 1 : 0,
  }
}

/**
 * 造输入行读端口族。
 *
 * @param {object} deps.json / deps.db / deps.listInputs / deps.reconcileInputs 全部由 server.mjs 注入
 */
export function createTaskInputRoutes({ json, db, listInputs, reconcileInputs }) {
  const deps = { json, db, listInputs, reconcileInputs }
  for (const [key, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`createTaskInputRoutes 缺注入项：${key}`)
  }

  const PREFIX = '/api/tasks/'
  const SUFFIX = '/inputs'

  const routes = [
    {
      method: 'GET',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -SUFFIX.length)
        // 后缀判等已经保证形状；这里再挡一次空 id，避免 `/api/tasks//inputs` 落进查库。
        if (!raw) return json(res, 400, { error: '缺少任务 id' })
        const id = decodeURIComponent(raw)
        const task = db.prepare('SELECT id FROM tasks WHERE id=?').get(id)
        // 不拿空数组冒充"存在但没输入"：调用方靠 404 区分两种情形。
        if (!task) return json(res, 404, { error: `未知任务 ${id}` })

        const query = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const includeSuperseded = query.get('includeSuperseded') === '1'
        const rows = listInputs(db, id, { includeSuperseded })
        return json(res, 200, { taskId: id, count: rows.length, inputs: rows.map(toView) })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/reconcile/inputs',
      async run(req, res, ctx) {
        const query = new URL(String(ctx.url ?? ctx.path), 'http://127.0.0.1').searchParams
        const scope = query.get('scope') ?? undefined
        const report = reconcileInputs(db, { scope })
        return json(res, 200, { ...report, at: new Date().toISOString() })
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
    id: 'task-input',
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

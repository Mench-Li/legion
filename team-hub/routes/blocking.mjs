// team-hub/routes/blocking.mjs
// ============================================================================
// F8 · `GET /api/tasks/:id/blocking`（设计稿 §8.3 / M10）
//
// 纯只读（I-8.2）：它回答"我被什么挡住"，不改变任何状态。
// 槽位数据取自空间配置（`space_runtime.maxWorkers` / `reserved_slots`），
// 在跑数取自任务表——**不新增任何计数列**，避免又多一份要维护的真相。
// ============================================================================
import { explainBlocking as defaultExplain } from '../blocking.mjs'

const PREFIX = '/api/tasks/'
const SUFFIX = '/blocking'

export function createBlockingRoutes({ json, db, explainBlocking = defaultExplain, reservationsOf = null }) {
  for (const [key, value] of Object.entries({ json, db })) {
    if (value === undefined || value === null) throw new TypeError(`createBlockingRoutes 缺注入项：${key}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -SUFFIX.length)
        if (!raw) return json(res, 400, { error: '缺少任务 id' })
        const taskId = decodeURIComponent(raw)
        const task = db.prepare('SELECT id, scope FROM tasks WHERE id=?').get(taskId)

        const runtime = (() => {
          try {
            return db.prepare('SELECT maxWorkers, reserved_slots FROM space_runtime WHERE scope=?')
              .get(task?.scope ?? 'default') ?? null
          } catch { return null }
        })()
        const activeSlots = (() => {
          try {
            return Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope=? AND status='in_progress'")
              .get(task?.scope ?? 'default')?.c ?? 0)
          } catch { return 0 }
        })()
        const reservations = typeof reservationsOf === 'function' ? (reservationsOf(task?.scope ?? 'default') ?? []) : []

        const report = explainBlocking(db, {
          taskId,
          reservations,
          totalSlots: runtime?.maxWorkers ?? null,
          activeSlots,
          reservedSlots: runtime?.reserved_slots ?? 1,
        })
        if (report.error === 'TASK_NOT_FOUND') return json(res, 404, { error: `未知任务 ${taskId}`, ...report })
        return json(res, 200, report)
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
    id: 'blocking',
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

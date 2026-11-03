// team-hub/routes/task-report.mjs
// ============================================================================
// F2 · `POST /api/tasks/:id/report` —— 守护回报的**唯一 HTTP 写口**（设计稿 §3 F2 / DEC-2）。
//
// 形态与其它写路由一致：走 `handleWrite`（鉴权 + 读 body + 取 by/scope + 错误信封），
// 落盘交给 `submitReport()`（一个事务里写状态 + 问题 + 审计）。
//
// 为什么不让守护直连库（DEC-2）：两个连接各自的 `withTx` 互不原子，
// 「状态写了、问题没写」这种半截在直连形态下无法避免；HTTP 请求天然是事务边界。
// ============================================================================
import { reportsRouteBody } from '../task-report.mjs'

const PREFIX = '/api/tasks/'
const SUFFIX = '/report'

/**
 * @param deps.json / deps.handleWrite / deps.submitReport / deps.db / deps.withTx / deps.audit
 */
export function createTaskReportRoutes({ json, handleWrite, submitReport, db, withTx, audit }) {
  const deps = { json, handleWrite, submitReport, db, withTx }
  for (const [key, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`createTaskReportRoutes 缺注入项：${key}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -SUFFIX.length)
        const taskId = decodeURIComponent(raw)
        await handleWrite(req, res, async (body, by) => {
          const input = reportsRouteBody(taskId, body, by)
          const out = submitReport(db, input, { withTx, audit })
          return {
            task: out.task,
            question: out.question ?? null,
            auditSeq: out.auditSeq ?? null,
            duplicated: out.duplicated === true,
            transition: out.transition ?? null,
            transitionSkipped: out.transitionSkipped ?? null,
          }
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
    id: 'task-report',
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

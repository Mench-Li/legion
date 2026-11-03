// team-hub/routes/goal-share.mjs
// ============================================================================
// F6 · 目标份额的 HTTP 面（设计稿 §8.1 / M8）
//
//   GET  /api/spaces/:scope/goal-share    只读：当前配置（未配置给默认值）
//   POST /api/spaces/:scope/goal-share    写入（**归一化后**落 space_runtime.goal_share）
//   POST /api/goal-borrows/release        释放到期借槽（写 share_release 审计）
//
// 为什么读要返回"默认值"而不是 null：调用方（守护 / 看板 / CLI）不该各自补一遍默认，
// 否则三处的默认迟早不一样——那时候"配额到底是多少"就没人说得清了。
// ============================================================================
import { normalizeGoalShare as defaultNormalize } from '../goal-share.mjs'

const PREFIX = '/api/spaces/'
const SUFFIX = '/goal-share'

export function createGoalShareRoutes({
  json, db, handleWrite,
  normalizeGoalShare = defaultNormalize,
  releaseExpiredBorrows,
  activeBorrows,
  recordBorrow = null,
}) {
  for (const [key, value] of Object.entries({ json, db, handleWrite })) {
    if (value === undefined || value === null) throw new TypeError(`createGoalShareRoutes 缺注入项：${key}`)
  }

  const readConfig = (scope) => {
    const row = db.prepare('SELECT goal_share FROM space_runtime WHERE scope=?').get(String(scope))
    const raw = row?.goal_share ? safeJson(row.goal_share) : null
    return normalizeGoalShare(raw ?? undefined)
  }

  const routes = [
    {
      method: 'GET',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -SUFFIX.length)
        if (!raw) return json(res, 400, { error: '缺少空间 scope' })
        const scope = decodeURIComponent(raw)
        return json(res, 200, {
          scope,
          config: readConfig(scope),
          activeBorrows: typeof activeBorrows === 'function' ? activeBorrows(db).length : 0,
        })
      },
    },
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -SUFFIX.length)
        if (!raw) return json(res, 400, { error: '缺少空间 scope' })
        const scope = decodeURIComponent(raw)
        await handleWrite(req, res, async (body) => {
          const config = normalizeGoalShare(body?.config ?? body ?? {})
          // 空间行不存在就建：配置本来就该能先于该空间的第一个任务存在
          db.prepare(`INSERT INTO space_runtime (scope, goal_share, updatedAt) VALUES (?,?,?)
            ON CONFLICT(scope) DO UPDATE SET goal_share=excluded.goal_share, updatedAt=excluded.updatedAt`)
            .run(scope, JSON.stringify(config), new Date().toISOString())
          return { scope, config }
        }, { envelope: null })
      },
    },
    {
      // 演练/运维用：造一笔借槽，才能验"到期释放 + 留痕"这条闭环。
      // **不是业务主路径**——业务里的借槽由认领准入（claim-admission）自然产生。
      method: 'POST',
      match: 'exact',
      path: '/api/goal-borrows',
      async run(req, res) {
        if (typeof recordBorrow !== 'function') return json(res, 503, { error: '借槽造数未接线' })
        await handleWrite(req, res, async (body) => {
          const goalId = String(body?.goalId ?? '').trim()
          // 不允许"无名借槽"：审计里对不上目标，等于白借
          if (goalId === '') throw Object.assign(new Error('缺少 goalId'), { statusCode: 400 })
          const borrow = recordBorrow(db, {
            goalId,
            taskId: body?.taskId ?? null,
            scope: body?.scope ?? 'default',
            grantedAt: body?.grantedAt ?? null,
            ttlSec: body?.ttlSec ?? null,
          })
          return { borrow }
        }, { envelope: null })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/goal-borrows/release',
      async run(req, res) {
        await handleWrite(req, res, async (body) => {
          if (typeof releaseExpiredBorrows !== 'function') return { released: 0, goals: [], at: null }
          const out = releaseExpiredBorrows(db, { now: body?.now ?? null })
          return out
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
    id: 'goal-share',
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

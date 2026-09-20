// team-hub/routes/calendar.mjs
// ============================================================================
// 路由层第 4 族：**日程日历（calendar）：事件 REST + 冲突检测 + 关联查询** —— PRT-316 切片 4
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 4 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`（用法 `node gen-family.mjs calendar`，
// 源头是 `git show 993853a:team-hub/server.mjs` 的 `/api/calendar/` 前缀段落）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// 生成器有两道**生成期**自检（切片 4 新加，切片 3 的教训）：
//
//   ① 按**路径前缀**取族，不按注释文本——切片 3 用注释文本定位，
//      而 `// ── 对话中心（chat）` 在本文件出现 3 次，第一版取到建表段，
//      生成一个 0 条路由的空模块，而 `node --check` 照样通过。
//   ② **函数体里每个被调用的名字都必须登记**，否则生成器直接失败。
//
//      > 一个"忘了一个注入项"的模块，与一个"注入项齐全"的模块，
//      > 在 `node --check` 通过时是同一个东西——直到那条路由第一次被调用。
//
// ## 零注入改写
//
// 6 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造日程日历（calendar）：事件 REST + 冲突检测 + 关联查询族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 * @param {Function} deps.json
 * @param {Function} deps.handleWrite
 * @param {Function} deps.listCalendarEvents
 * @param {Function} deps.findCalendarConflicts
 * @param {Function} deps.listCalendarEventsByLink
 * @param {Function} deps.createCalendarEvent
 * @param {Function} deps.updateCalendarEvent
 * @param {Function} deps.deleteCalendarEvent
 */
export function createCalendarRoutes({
  json, handleWrite,
  listCalendarEvents, findCalendarConflicts, listCalendarEventsByLink,
  createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
}) {
  const deps = { json, handleWrite,
    listCalendarEvents, findCalendarConflicts, listCalendarEventsByLink,
    createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  }
  for (const [k, fn] of Object.entries(deps)) {
    if (typeof fn !== 'function') throw new TypeError(`createCalendarRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      path: '/api/calendar/events',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? undefined
          const from = url.searchParams.get('from') ?? undefined
          const to = url.searchParams.get('to') ?? undefined
          json(res, 200, { scope: scopeParam ?? null, events: listCalendarEvents({ scope: scopeParam, from, to }) })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'GET',
      path: '/api/calendar/conflicts',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope')
          if (!scopeParam || scopeParam.trim().length === 0) throw new Error('缺少参数 scope')
          const conflicts = findCalendarConflicts({
            scope: scopeParam.trim(),
            start: url.searchParams.get('start'),
            end: url.searchParams.get('end'),
            allDay: url.searchParams.get('allDay') === '1' || url.searchParams.get('allDay') === 'true',
            excludeId: url.searchParams.get('excludeId'),
          })
          json(res, 200, { scope: scopeParam.trim(), conflicts })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'GET',
      path: '/api/calendar/events/by-link',
      async run(req, res, { url }) {
        try {
          const events = listCalendarEventsByLink({
            taskId: url.searchParams.get('taskId'),
            goalId: url.searchParams.get('goalId'),
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
          })
          json(res, 200, { taskId: url.searchParams.get('taskId') ?? null, goalId: url.searchParams.get('goalId') ?? null, events })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/calendar/events',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => createCalendarEvent({ ...body, by }))
      },
    },
    {
      method: 'POST',
      path: '/api/calendar/events/update',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => updateCalendarEvent({ ...body, by }))
      },
    },
    {
      method: 'POST',
      path: '/api/calendar/events/delete',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => deleteCalendarEvent({ ...body, by }))
      },
    },
  ]

  return {
    id: 'calendar',
    routes,
    /** 6 条全是等值匹配；顺序与 `handle` 里原来那 6 条 `if` 相同。 */
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

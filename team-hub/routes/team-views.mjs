// team-hub/routes/team-views.mjs
// ============================================================================
// 路由层第 40 族：**编队投影与改动重叠审计（两条只读视图：空间里每个智能体的状态 / 改到同一文件的任务）** —— PRT-316 切片 42
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 40 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 50a6dd8:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 2 条的形态分布（生成器算的，不是抄的）
//
//   ×  2  `path === '…'`
//   ×  0  `path.startsWith('…')`
//   ×  0  `path.startsWith('…') && path.endsWith('…')`
//
// 生成器在切片 5 修正过一次**静默漏取**：切片 4 的版本只认等值那一种，
// 会静默跳过另外 48 条（旧自检只为"一条都没取到"准备，所以不会响）。
//
//   > 一个"按前缀取族、却只认一种写法"的生成器，
//   > 与一个"把这一族搬走一半"的提交，在 `node --check` 通过时是同一个东西。
//
// 生成器在切片 6 修正过第二次：ctx 成员**按体逐条绑定**（旧版一律允许
// `path`/`url`、却只解构 `url` ⇒ 体里用 `path` 的族会拿到 `undefined`）。
//
//   > 一个"把名字登记成可用"的白名单，与一个"真的把它绑进来"的解构，
//   > 在没人用那个名字的时候是同一个东西。
//
// ## 零注入改写
//
// 2 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造编队投影与改动重叠审计（两条只读视图：空间里每个智能体的状态 / 改到同一文件的任务）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createTeamViewsRoutes({
  json,
  db, listTasks,
}) {
  const deps = { json,
    db, listTasks,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createTeamViewsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/roster',
      async run(req, res, { url }) {
        // 工作空间专属编队：scope 的智能体队伍 + 每人当前状态/任务（按该空间任务实时投影）。
        // 合流：编队岗位（roster.role 匹配任务的 role/soldier）之外，未入编队但认领了该空间
        // 任务的执行者（如旧士兵名）也一并返回，避免切换空间后信息丢失。
        // scope 缺省(或空)= 聚合全部空间（供「全部空间」视图），每个智能体带 scope 标注。
        const scopeParam = (url.searchParams.get('scope') ?? '').trim()
        const scopes = scopeParam
          ? [scopeParam]
          : [...new Set([
              ...db.prepare("SELECT DISTINCT scope FROM roster WHERE scope != '' ORDER BY scope").all().map(r => r.scope),
              ...db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all().map(r => r.scope),
            ])]
        const agents = []
        for (const scope of scopes) {
          const roster = db.prepare('SELECT * FROM roster WHERE scope = ? ORDER BY sort, role').all(scope)
          const rosterRoles = new Set(roster.map(r => r.role))
          const tasks = listTasks({ scope })
          const bySoldier = new Map()
          for (const t of tasks) {
            if (t.status === 'canceled' || !t.soldier) continue
            if (rosterRoles.has(t.role ?? t.soldier)) continue
            const arr = bySoldier.get(t.soldier) ?? []
            arr.push(t)
            bySoldier.set(t.soldier, arr)
          }
          const summarize = (id, label, list, kind = '', avatar = '🤖', external = false) => {
            const mine = list.filter(t => t.status !== 'done')
            const done = list.filter(t => t.status === 'done').length
            const inProgress = mine.filter(t => t.status === 'in_progress').length
            const inReview = mine.filter(t => t.status === 'in_review').length
            const blocked = mine.filter(t => t.status === 'blocked').length
            const waiting = mine.filter(t => t.status === 'todo' || t.status === 'backlog').length
            let mode = 'idle'
            if (blocked > 0) mode = 'blocked'
            else if (inReview > 0) mode = 'review'
            else if (inProgress > 0) mode = 'busy'
            const chips = []
            if (inProgress > 0) chips.push({ label: `进行中 ${inProgress}`, cls: 'green' })
            if (inReview > 0) chips.push({ label: `待验收 ${inReview}`, cls: 'yellow' })
            if (blocked > 0) chips.push({ label: `受阻 ${blocked}`, cls: 'red' })
            if (waiting > 0) chips.push({ label: `待命 ${waiting}`, cls: '' })
            if (chips.length === 0) {
              // 无在办任务：有历史则「已完成 N」，否则「待命」
              if (done > 0) chips.push({ label: `已完成 ${done}`, cls: '' })
              else chips.push({ label: '待命', cls: '' })
            }
            return {
              role: id, name: label, kind, avatar, mode, chips, done, total: list.length,
              external, scope,
              tasks: mine.map(t => ({ id: t.id, title: t.title, status: t.status })),
            }
          }
          // 编队岗位优先，再追加未入编队的活跃执行者
          for (const r of roster) {
            const mine = tasks.filter(t => t.status !== 'canceled' && (t.role ?? t.soldier) === r.role)
            agents.push(summarize(r.role, r.name, mine, r.kind, r.avatar, false))
          }
          for (const [soldier, list] of bySoldier) {
            agents.push(summarize(soldier, `${soldier} · 执行中`, list, '', '⚙️', true))
          }
        }
        json(res, 200, { scope: scopeParam || 'all', agents })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/overlaps',
      async run(req, res, { url }) {
        // L3 跨任务改动重叠审计：扫描空间内所有有补丁记录的任务，按「改到同一文件」分组。
        // 8 波次并行合入场景下，两个任务改同一文件 = 潜在冲突/语义重叠，供将军决定验收与合入顺序。
        const scopeParam = url.searchParams.get('scope')
        const only = url.searchParams.get('id')
        const minTasks = Math.max(2, Number(url.searchParams.get('min') ?? 2) || 2)
        const tasks = listTasks(scopeParam ? { scope: scopeParam } : {}).filter(t => t.status !== 'canceled')
        const updatedAt = new Map(tasks.map(t => [t.id, t.updatedAt ?? t.createdAt ?? '']))
        const patchFilesOf = (p) => {
          if (!p) return []
          if (typeof p === 'string') return [p] // 旧库：纯文件名条目
          if (Array.isArray(p.files)) return p.files.map(f => (f && typeof f.path === 'string' ? f.path : '')).filter(Boolean)
          if (typeof p.files === 'string') return p.files.split(',').map(s => s.trim()).filter(Boolean)
          return []
        }
        const byFile = new Map()
        for (const t of tasks) {
          const set = new Set()
          for (const p of t.patches ?? []) for (const f of patchFilesOf(p)) set.add(f)
          if (set.size === 0) continue
          for (const f of set) {
            const arr = byFile.get(f) ?? []
            arr.push({ id: t.id, title: t.title, status: t.status, updatedAt: updatedAt.get(t.id) ?? '' })
            byFile.set(f, arr)
          }
        }
        let groups = [...byFile].map(([file, list]) => ({
          file,
          tasks: list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
        })).filter(g => g.tasks.length >= minTasks)
        if (only) groups = groups.filter(g => g.tasks.some(x => x.id === only))
        groups.sort((a, b) => {
          const ra = Math.max(...a.tasks.map(t => new Date(t.updatedAt || 0).getTime()))
          const rb = Math.max(...b.tasks.map(t => new Date(t.updatedAt || 0).getTime()))
          return rb - ra || a.file.localeCompare(b.file)
        })
        json(res, 200, { scope: scopeParam || 'all', groups })
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
    id: 'team-views',
    routes,
    /** 2 条；顺序与 `handle` 里原来那 2 条 `if` 相同。 */
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

// team-hub/routes/content-reads.mjs
// ============================================================================
// 路由层第 41 族：**两个只读视图：技能目录（含 pending 收口）/ 显式文档读（PRT-406）** —— PRT-316 切片 43
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 41 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 559cc72:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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
 * 造两个只读视图：技能目录（含 pending 收口）/ 显式文档读（PRT-406）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createContentReadsRoutes({
  json,
  getSkill, listSkills, listDocuments,
}) {
  const deps = { json,
    getSkill, listSkills, listDocuments,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createContentReadsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/skills',
      async run(req, res, { url }) {
        // include=pending 收口（AC-R1-7）：仅 member=general（复审身份）可看 pending/rejected 及其 prompt；
        // 其余任何查询（含 scope/member 全缺省的「全部空间」视图）一律只返回 published，草稿不外泄。
        const reviewerView = url.searchParams.get('member') === 'general'
        const wantPending = reviewerView && url.searchParams.get('include') === 'pending'
        const skillId = url.searchParams.get('id')
        if (skillId) {
          try {
            const s = getSkill(skillId)
            // 未发布且非复审视角 → 对普通成员按「不存在」处理，不泄露待审内容
            if (s.status !== 'published' && !wantPending) {
              json(res, 404, { error: `skill_not_found: ${skillId}` })
              return
            }
            json(res, 200, s)
          } catch (e) {
            json(res, 404, { error: e instanceof Error ? e.message : String(e) })
          }
          return
        }
        json(res, 200, listSkills({
          scope: url.searchParams.get('scope') ?? undefined,
          member: url.searchParams.get('member') ?? undefined,
          includePending: wantPending,
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/documents',
      async run(req, res, { url }) {
        // ★ PRT-406：显式文档读端点（`document` 来源族的唯一出处）。
        //
        //   形状与 `/api/skills` **刻意不同**：技能返回 `prompt`（会被当指令执行的
        //   那一段），文档返回 `body`（参考资料）。两者都带 `origin`，于是装配侧
        //   可以**逐条**判可信性，而不是整批一刀切。
        //
        //   ⚠️ `origin` 是**服务端写死**的字段（见 registerDocument / installDocument），
        //   客户端改不动——这正是它能被用来做判定前提的原因。
        //
        //   与 `/api/skills` 的另一个不同：**没有 status 过滤**。文档不走向导机
        //   （理由见 listDocuments 的注释）。
        json(res, 200, listDocuments({
          scope: url.searchParams.get('scope') ?? undefined,
          id: url.searchParams.get('id') ?? undefined,
        }))
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
    id: 'content-reads',
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

// team-hub/routes/skill-source.mjs
// ============================================================================
// 路由层第 28 族：**每个空间绑定的团队技能仓库（github url + 分支，供一键拉取同步）** —— PRT-316 切片 29
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 28 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 476ffab:team-hub/server.mjs` 的 `/api/skill-source` 段落。
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

// ============================================================================
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 技能来源（skill-source）：每个空间绑定的团队技能仓库（github url + 分支，供一键拉取同步）──


/**
 * 造每个空间绑定的团队技能仓库（github url + 分支，供一键拉取同步）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createSkillSourceRoutes({
  json,
  getSkillSource, setSkillSource, handleWrite,
}) {
  const deps = { json,
    getSkillSource, setSkillSource, handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createSkillSourceRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/skill-source',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? 'default'
          json(res, 200, { ok: true, source: getSkillSource(scopeParam) })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/skill-source',
      async run(req, res, { url }) {
        // 写入走统一 handleWrite（by 必填 + 审计 + SSE）；不设 general 门禁（只是 URL 配置，拉取时另行白名单校验）。
        await handleWrite(req, res, (body, by) => setSkillSource({ scope: body.scope, url: body.url, branch: body.branch }))
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
    id: 'skill-source',
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

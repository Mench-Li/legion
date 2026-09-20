// team-hub/routes/comment.mjs
// ============================================================================
// 路由层第 20 族：**追加批注（评论 / 证据 / 用户反馈三条路径共用一个写入口）** —— PRT-316 切片 21
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 20 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show a0ae72d:team-hub/server.mjs` 的 `/api/comment` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 1 条的形态分布（生成器算的，不是抄的）
//
//   ×  1  `path === '…'`
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
// 1 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造追加批注（评论 / 证据 / 用户反馈三条路径共用一个写入口）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createCommentRoutes({
  json,
  appendTaskNote, audit, handleWrite,
}) {
  const deps = { json,
    appendTaskNote, audit, handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createCommentRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/comment',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          const text = body.text
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof text !== 'string' || text.trim().length === 0) throw new Error('缺少参数 text')
          // PRT-404：`kind: 'feedback'` 写的是**用户反馈**列，与评论、证据分开存。
          // 三条路径共用一个写入口是有意的：它们都是"往任务的某个批注列追加一条"，
          // 分成三个路由只会把同一段校验抄三遍。
          const kind = body.kind === 'feedback' ? 'feedback' : body.isEvidence === true ? 'evidence' : 'comments'
          const task = appendTaskNote(id, by, text.trim(), kind)
          audit(by, scope, kind === 'evidence' ? 'evidence' : kind === 'feedback' ? 'feedback' : 'comment', id, {}, task.goalId)
          return task
        })
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
    id: 'comment',
    routes,
    /** 1 条；顺序与 `handle` 里原来那 1 条 `if` 相同。 */
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

// team-hub/routes/packs.mjs
// ============================================================================
// 路由层第 9 族：**能力包安装事实（packs）：只追加的账 —— 追加/读账/整本账/审阅文本导出** —— PRT-316 切片 9
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 9 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show ccdfa68:team-hub/server.mjs` 的 `/api/packs` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 4 条的形态分布（生成器算的，不是抄的）
//
//   ×  4  `path === '…'`
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
// 4 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 12 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── F-20 能力包安装事实 ────────────────────────────────────────────
//
// 四条路由，围绕着**一本只追加的账**：
//   · `POST /api/packs/facts`          追加一条记录（seq 由 CAS 算出来）
//   · `GET  /api/packs/facts`          读账（可按包 / 按 seq 增量）
//   · `GET  /api/packs/account`        整本账，形态直接喂给 `createPackStore`
//   · `GET  /api/packs/export`         导出成可提交进 Git 的文本
//
// **刻意没有"改一条记录"或"删一条记录"的路由**：账是"只追加、记录不可变"的，
// 而一次"顺手修正"会让"这条记录是谁改的"永远无法回答。
// 写路径只有一条，且它不接受"当前状态"这种入参——那条状态是**推导**出来的，
// 由 hub 存一份就等于有第二份真相。


/**
 * 造能力包安装事实（packs）：只追加的账 —— 追加/读账/整本账/审阅文本导出族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createPacksRoutes({
  json,
  authorized, handleRun, appendPackFact,
  packFacts, optionalIntParam, packFactCounts,
  packAccount, exportPackFacts, db,
}) {
  const deps = { json,
    authorized, handleRun, appendPackFact,
    packFacts, optionalIntParam, packFactCounts,
    packAccount, exportPackFacts, db,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createPacksRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/packs/facts',
      async run(req, res) {
        await handleRun(req, res, (body) => ({
          ok: true,
          ...appendPackFact({
            db,
            record: {
              at: body.at,
              kind: body.kind,
              packId: body.packId,
              version: body.version,
              packType: body.packType ?? null,
              packProtocolVersion: body.packProtocolVersion ?? null,
              contentHash: body.contentHash ?? null,
              declaredContentHash: body.declaredContentHash ?? null,
              trust: body.trust ?? null,
              fromVersion: body.fromVersion ?? null,
              fromContentHash: body.fromContentHash ?? null,
              preflightVersion: body.preflightVersion ?? null,
              verdictCodes: body.verdictCodes ?? [],
            },
          }),
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/packs/facts',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const packId = url.searchParams.get('packId')
        json(res, 200, {
          ok: true,
          packId: packId === null || packId.length === 0 ? null : packId,
          records: packFacts({
            db,
            packId,
            sinceSeq: optionalIntParam(url, 'sinceSeq') ?? 0,
            limit: optionalIntParam(url, 'limit'),
          }),
          counts: packFactCounts({ db }),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/packs/account',
      async run(req, res) {
        // 这一条的形状**就是** `createPackStore({ history })` 认的那个：
        // 重启之后控制面不必自己再推一遍状态，而"两份推导"是这一层最想避免的事。
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        json(res, 200, { ok: true, ...packAccount({ db }) })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/packs/export',
      async run(req, res) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const { text } = exportPackFacts({ db })
        // 返回**文本**而不是 JSON 对象：这份东西的用途是进 diff、被人审阅，
        // 而一个被包在 HTTP JSON 里的对象到了调用方手里又要被 `JSON.stringify`
        // 一次——那一次与这一份的缩进、键序都可能不同，于是"审阅的是哪一份"就成了问题。
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="legion-pack-install-facts.json"',
        })
        res.end(text)
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
    id: 'packs',
    routes,
    /** 4 条；顺序与 `handle` 里原来那 4 条 `if` 相同。 */
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

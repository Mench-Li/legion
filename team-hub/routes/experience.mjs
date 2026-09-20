// team-hub/routes/experience.mjs
// ============================================================================
// 路由层第 8 族：**经验图谱（experience）：记录流追加/读 + 整本账 + 草稿处置 + 审阅文本导出** —— PRT-316 切片 8
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 8 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 5288a14:team-hub/server.mjs` 的 `/api/experience` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 5 条的形态分布（生成器算的，不是抄的）
//
//   ×  4  `path === '…'`
//   ×  0  `path.startsWith('…')`
//   ×  1  `path.startsWith('…') && path.endsWith('…')`
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
// 5 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 17 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ⚠ **生成器核实**：下面这段原文写的路由条数与实测不符 ——
//   原文说「四条路由」，本族实测 **5** 条（按 `/api/experience` 取族、形态无关地数）。
//   数字**照原文保留**（零改写是纪律），但读的时候以实测为准；
//   这也是"逐字保真"必须配一道**交叉核对**的原因：
//
//   > 一个"逐字保真"的搬运，与一个"把原件的笔误一起保真"的搬运，
//   > 在原文对的时候是同一个东西。
// ============================================================================
// ── F-18 经验图谱 / 摩擦学习 ────────────────────────────────────────
//
// 四条路由，全部围绕**一本只追加的记录流**：
//   · `POST /api/experience/records`  追加一条（node/edge/retract/draft）
//   · `GET  /api/experience/records`  读流（可按草稿/边/种类、支持 sinceSeq）
//   · `POST /api/experience/drafts/:id/settle`  处置一条草稿（promote/discard）
//   · `GET  /api/experience/export`   导出成可提交进 Git 的审阅文本
//   · `GET  /api/experience/account`  整本账（重启后供控制面重建）
//
// ★ **刻意没有"改一条记录"或"删一条记录"的路由**，也**没有**"保存整张图"
//   的路由：记录是唯一的真相，"图现在长什么样"与"这条草稿现在是什么状态"
//   都是从记录流**推导**出来的。存一份推导出来的状态，就等于有第二份真相，
//   而它与记录流不一致时**没有任何东西能判定谁对**。
//
// ★ 处置单独一条路由（而不是往记录流里 POST 一条 `promote`）：
//   那个检查是"这条草稿现在是不是还没被处置"，而它必须**在同一处**完成，
//   否则调用方要先读一次再写一次，两步之间另一个进程可以插进来。


/**
 * 造经验图谱（experience）：记录流追加/读 + 整本账 + 草稿处置 + 审阅文本导出族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createExperienceRoutes({
  json,
  authorized, handleRun, appendExperienceRecord,
  experienceRecords, draftCounts, optionalIntParam,
  experienceAccount, settleDraft, exportExperience,
  db,
}) {
  const deps = { json,
    authorized, handleRun, appendExperienceRecord,
    experienceRecords, draftCounts, optionalIntParam,
    experienceAccount, settleDraft, exportExperience,
    db,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createExperienceRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/experience/records',
      async run(req, res) {
        await handleRun(req, res, (body) => ({
          ok: true,
          ...appendExperienceRecord({
            db,
            scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
            record: {
              kind: body.kind,
              atMs: body.atMs,
              draftId: body.draftId,
              subject: body.subject ?? null,
              score: body.score ?? null,
              payload: body.payload ?? null,
              edgeId: body.edgeId,
              from: body.from,
              to: body.to,
              edgeKind: body.edgeKind,
              source: body.source,
              by: body.by,
              reason: body.reason ?? null,
              nodeKind: body.nodeKind,
              id: body.id,
            },
          }),
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/experience/records',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        const records = experienceRecords({
          db,
          scope,
          draftId: url.searchParams.get('draftId'),
          edgeId: url.searchParams.get('edgeId'),
          kind: url.searchParams.get('kind'),
          sinceSeq: optionalIntParam(url, 'sinceSeq') ?? 0,
          limit: optionalIntParam(url, 'limit'),
        })
        json(res, 200, { ok: true, records, counts: draftCounts({ db, scope }) })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/experience/account',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        json(res, 200, { ok: true, ...experienceAccount({ db, scope }) })
      },
    },
    // `/api/experience/drafts/<id>/settle`
    // ★ 形状刻意与 PRT-507 的 `/api/model-profiles/<id>/probe` 一致：
    //   `startsWith` + `endsWith` 配**字面量**，而不是一个正则守卫。
    //   原因不是风格：`scripts/prt/baseline-snapshot.mjs` 的抽取器只认
    //   字面量（`path === '…'` / `path.startsWith('…')`），而它用
    //   `findOpaqueRouteGuards` **主动拒绝**用常量做守卫的写法。
    //   一个正则守卫两条都躲得过——于是这条路由会**悄悄**不进平台契约，
    //   而 `--record` 会写下一份"看起来正常、少了一条端点"的基线。
    //   这正是本仓库记过的最贵的一条：**一道看不见某类改动的闸门，
    //   比没有闸门更危险**——它给人"已经守住了"的错觉。
    //   所以这里按既有约定写成字面量 + startsWith/endsWith。
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: '/api/experience/drafts/',
      suffix: '/settle',
      async run(req, res, { path }) {
        const rawId = path.slice('/api/experience/drafts/'.length, path.length - '/settle'.length)
        // 中间那段必须是**一段** id，不能为空、也不能再带 `/`：
        // 否则 `/api/experience/drafts/a/b/settle` 会被当成一个合法 id，
        // 而那个 id 永远不会有对应的草稿——报出来的是"来源丢了"，
        // 而不是"你的路径写错了"，于是调用方会去查一条根本不存在的草稿。
        if (rawId === '' || rawId.includes('/')) {
          json(res, 400, {
            error: `草稿 id 必须是一段路径（收到 ${JSON.stringify(rawId)}），` +
              '带 `/` 的 id 永远不会对应到一条草稿',
            code: 'EXPERIENCE_RECORD_MALFORMED',
          })
          return
        }
        const draftId = decodeURIComponent(rawId)
        await handleRun(req, res, (body) => ({
          ok: true,
          ...settleDraft({
            db,
            scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
            draftId,
            action: body.action,
            // 理由原样交给下面的层去校验封闭词表：在这里再存一份词表
            // 就是第二份会各自漂移的词表。
            by: body.by,
            reason: body.reason,
            atMs: Number.isInteger(body.atMs) ? body.atMs : Date.now(),
          }),
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/experience/export',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        const { text } = exportExperience({ db, scope })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="legion-experience.json"',
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
    id: 'experience',
    routes,
    /** 5 条；顺序与 `handle` 里原来那 5 条 `if` 相同。 */
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

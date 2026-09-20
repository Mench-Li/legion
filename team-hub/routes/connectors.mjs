// team-hub/routes/connectors.mjs
// ============================================================================
// 路由层第 12 族：**连接器登记表（connectors）：按内容哈希冻结的声明 + 点名的熔断事件** —— PRT-316 切片 12
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 12 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 51082a8:team-hub/server.mjs` 的 `/api/connectors` 段落。
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
// 以下 16 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ⚠ **生成器核实**：下面这段原文写的路由条数与实测不符 ——
//   原文说「四条路由」，本族实测 **5** 条（按 `/api/connectors` 取族、形态无关地数）。
//   数字**照原文保留**（零改写是纪律），但读的时候以实测为准；
//   这也是"逐字保真"必须配一道**交叉核对**的原因：
//
//   > 一个"逐字保真"的搬运，与一个"把原件的笔误一起保真"的搬运，
//   > 在原文对的时候是同一个东西。
// ============================================================================
// ── F-21 连接器登记表 ──────────────────────────────────────────────
//
// 四条路由，围绕**按内容哈希冻结的声明** + **点名的故障事件**：
//   · `POST /api/connectors`             冻结一份声明（幂等或 409，没有第三种）
//   · `GET  /api/connectors`             列登记（可按 connectorId / sinceSeq）
//   · `GET  /api/connectors/incidents`   读熔断事件（点名是哪一个连接器）
//   · `GET  /api/connectors/export`      导出成可提交进 Git 的审阅文本
//
// ★ **刻意没有"改一份声明"或"删一个连接器"的路由**：连接器声明说的是
//   "一个外部进程能拿到什么权限"，而一条改/删的路由会让"当时放行了哪些工具"
//   在**写的那一刻**失去答案。确实改了内容就递增版本号再冻一版——
//   `freezeDeclaration` 会拒绝"同版本换内容"。
//
// ★ 事件路由的 `connectorId` 是**必填**的：只记"某处发生了故障"时，
//   一次隔离良好的单点故障与一次大面积故障长得一样。这一层不做默认值
//   填充（填一个 'default' 会让"忘了传"与"就是那个连接器"同形）。


/**
 * 造连接器登记表（connectors）：按内容哈希冻结的声明 + 点名的熔断事件族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createConnectorsRoutes({
  json,
  authorized, handleRun, freezeDeclaration,
  connectorRegistrations, optionalIntParam, getDeclaration,
  connectorCounts, connectorIncidents, exportConnectors,
  appendIncident, db,
}) {
  const deps = { json,
    authorized, handleRun, freezeDeclaration,
    connectorRegistrations, optionalIntParam, getDeclaration,
    connectorCounts, connectorIncidents, exportConnectors,
    appendIncident, db,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createConnectorsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/connectors',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = freezeDeclaration({
            db,
            scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
            // `declaration` 原样收下（与 F-19 的 `pack` 同一条理由）：
            // 控制面不挑字段、不重排、不补默认值——挑字段就是一份多余的转写，
            // 而转写会漂移，漂移之后"当时声明的是什么"就没有唯一的答案了。
            declaration: body.declaration,
            version: body.version,
            frozenAtMs: Number.isInteger(body.frozenAtMs) ? body.frozenAtMs : Date.now(),
            frozenBy: body.frozenBy ?? null,
          })
          return {
            ok: true,
            frozen: r.frozen,
            // `created:false` 是**幂等重放**，不是"已经有一模一样的了所以不算数"。
            created: r.created,
            connectorId: r.connectorId,
            version: r.version,
            contentHash: r.contentHash,
            toolCount: r.toolCount,
            frozenAtMs: r.frozenAtMs,
          }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/connectors',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        const connectorId = url.searchParams.get('connectorId')
        const version = url.searchParams.get('version')
        const sinceSeq = optionalIntParam(url, 'sinceSeq') ?? 0
        // ★ 形状不随查询参数变（与 F-19 同一条）：永远是 `records` + `registration`
        //   + `counts`。一份"读哪个字段取决于我传了什么参数"的响应，
        //   与一份随机的响应在调用方代码里是同一个东西。
        //
        // ★★ `version` **必须真的被用上**。第一版收了这个参数却只把它丢在一边
        //   （`getDeclaration` 没收到它），于是"不传 version = 最新"这条默认
        //   静默地覆盖了每一次带版本的查询：调用方问"1.0.0 当时放行了哪些工具"，
        //   拿回的是 2.0.0 的工具清单——**答案来自另一版，而响应里没有任何地方
        //   提示这件事**。这个坑比"不支持 version"深得多：不支持时会报错或者
        //   返回 null，而静默忽略会给出一个看起来完全正常的答案。
        const filtered = version === null
          ? connectorRegistrations({ db, scope, connectorId, sinceSeq })
          : connectorRegistrations({ db, scope, connectorId, sinceSeq }).filter((r) => r.version === version)
        json(res, 200, {
          ok: true,
          scope,
          records: filtered,
          // 不传 connectorId 或那一版还没冻过时是 null——而"还没冻过"与"这行坏了"
          // 是两件事，所以 `readable` 一并带出去。
          registration: connectorId === null ? null : getDeclaration({ db, connectorId, version, scope }),
          counts: connectorCounts({ db, scope }),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/connectors/incidents',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        const connectorId = url.searchParams.get('connectorId')
        const sinceSeq = optionalIntParam(url, 'sinceSeq') ?? 0
        json(res, 200, {
          ok: true,
          scope,
          records: connectorIncidents({ db, scope, connectorId, sinceSeq }),
          counts: connectorCounts({ db, scope }),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/connectors/export',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope') ?? 'default'
        const { text } = exportConnectors({ db, scope })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="legion-connectors.json"',
        })
        res.end(text)
      },
    },
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: '/api/connectors/',
      suffix: '/incidents',
      async run(req, res, { path }) {
        const rawId = path.slice('/api/connectors/'.length, path.length - '/incidents'.length)
        // 中间那段必须是**一段** id（同 F-18 的 settle）：否则
        // `/api/connectors/a/b/incidents` 会被当成一个合法 id，
        // 而那个 id 永远不会有对应的连接器。
        if (rawId === '' || rawId.includes('/')) {
          json(res, 400, {
            error: `连接器 id 必须是一段路径（收到 ${JSON.stringify(rawId)}），` +
              '带 `/` 的 id 永远不会对应到一个连接器',
            code: 'CONNECTOR_EVENT_MALFORMED',
          })
          return
        }
        const connectorId = decodeURIComponent(rawId)
        await handleRun(req, res, (body) => ({
          ok: true,
          ...appendIncident({
            db,
            scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
            connectorId,
            kind: body.kind,
            circuitState: body.circuitState,
            // `atMs` 必填且必须是整数：`undefined` 与"当时就是 0"同形。
            atMs: body.atMs,
            reason: body.reason ?? null,
            actor: body.actor ?? null,
          }),
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
    id: 'connectors',
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

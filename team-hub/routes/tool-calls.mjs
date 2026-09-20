// team-hub/routes/tool-calls.mjs
// ============================================================================
// 路由层第 11 族：**工具调用账（tool-calls）：**三条只读路由** —— 按来源分组统计 + 就绪判据产出点 + 修复动作** —— PRT-316 切片 11
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 11 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 77711ba:team-hub/server.mjs` 的 `/api/tool-calls` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 3 条的形态分布（生成器算的，不是抄的）
//
//   ×  3  `path === '…'`
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
// 3 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 20 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── PRT-610 工具调用账（`tool_calls`）───────────────────────────────
//
// spec §6.8 line 480：「`tool_calls` 必须记录决定来源；否则事后无法区分
// 策略拒绝与沙箱兜底拒绝，而这两类的**修复动作不同**。」
//
// 三条路由，形状与只读统计面一致：
//   · `GET  /api/tool-calls`              按来源分组统计（"两类拒绝"的最直接读法）
//   · `GET  /api/tool-calls/evidence`     ★ 就绪判据 `decisionSourceRecorded` 的**产出点**
//   · `GET  /api/tool-calls/repair`       拿一条拒绝，直接读出"该去改哪里"
//
// ★★ **刻意没有写路径。** 与 F-15 的用量路由同一个理由，而且这里更硬：
// 一次工具调用的账要记「原始输入 + canonical 输入 + 哈希 + 决定来源 + 结果状态」，
// 其中 `rawInput`/`canonicalInput` 必须来自**那一次真实的执行**（它们要被对起来，
// 见 `assertCanonicalMatchesRaw`）。放一条"手工记一笔"的 HTTP 写口，等于允许
// 控制面凭空造出一条"执行过"的记录——
//
//   > 一个「可以由外部直接写入」的执行账，
//   > 与一个「审计里的执行历史可以是任意值」的账，是同一个东西。
//
// 所以写侧只有一个入口：执行面调 `recordToolCall`。本进程只提供**读**与建表。


/**
 * 造工具调用账（tool-calls）：**三条只读路由** —— 按来源分组统计 + 就绪判据产出点 + 修复动作族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createToolCallsRoutes({
  json,
  authorized, TOOL_CALL_TABLE, DECISION_SOURCES,
  SOURCE_DECISIONS, SOURCE_REPAIR_ACTIONS, countBySource,
  toolCallLogEvidence, readToolCall, toolCallIdempotencyKey,
  explainRejection, db,
}) {
  const deps = { json,
    authorized, TOOL_CALL_TABLE, DECISION_SOURCES,
    SOURCE_DECISIONS, SOURCE_REPAIR_ACTIONS, countBySource,
    toolCallLogEvidence, readToolCall, toolCallIdempotencyKey,
    explainRejection, db,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createToolCallsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/tool-calls',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        // `decision` 可筛（只看拒绝），但**不**给"按 runId 筛"——那需要给
        // `countBySource` 加一个它今天没有的参数，而加参数就会引入"两个地方各算一遍"。
        const decision = url.searchParams.get('decision')
        json(res, 200, {
          ok: true,
          table: TOOL_CALL_TABLE,
          // 每个来源各自可能的决定（审计口径）：让人能看出"这一栏里缺少哪一类"
          sourceDecisions: Object.fromEntries(
            DECISION_SOURCES.map((s) => [s, [...SOURCE_DECISIONS[s]]]),
          ),
          // 每个来源该去改哪里——§6.8 line 480 那句"修复动作不同"的落地
          sourceRepairActions: Object.fromEntries(
            DECISION_SOURCES.map((s) => [s, SOURCE_REPAIR_ACTIONS[s]]),
          ),
          counts: countBySource({ db, decision: decision === null || decision === '' ? null : decision }),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/tool-calls/evidence',
      async run(req, res) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const ev = toolCallLogEvidence({ db })
        json(res, 200, {
          ok: true,
          ...ev,
          // 就绪判据直接吃这个字段。★ 严格布尔比较（不是 truthy）：
          // `'false'` 这个字符串是 truthy，而这正是"把没记录读成记录"的形状。
          decisionSourceRecorded: ev.recorded === true,
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/tool-calls/repair',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const callId = url.searchParams.get('callId')
        if (callId === null || callId.trim() === '') {
          json(res, 400, {
            error: 'repair 需要 callId——一条拒绝的修复动作由**它的来源**决定，'
              + '没有 callId 就只能靠猜，而猜错的修复动作会把人指向错误的文件',
            code: 'TOOL_CALL_REPAIR_NEEDS_CALL_ID',
          })
          return
        }
        // ★ 键是 `callId`（§6.5 line 478：执行身份是"这一次调用"，不是内容哈希）。
        //   这里复用 `toolCallIdempotencyKey` 而不是自己 trim：两处各归一化一次
        //   就会出现"用 A 的键写、用 B 的键读"——而那样查不到与没记录过长得一样。
        const row = readToolCall({ db, idempotencyKey: toolCallIdempotencyKey({ callId }) })
        if (row === null) {
          json(res, 404, {
            error: `没有 callId=${JSON.stringify(callId)} 的记录`,
            code: 'TOOL_CALL_NOT_FOUND',
          })
          return
        }
        // `explainRejection` 对非拒绝行返回 ok:false 而不是抛——照原样透出去。
        json(res, 200, { ok: true, call: row, repair: explainRejection(row) })
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
    id: 'tool-calls',
    routes,
    /** 3 条；顺序与 `handle` 里原来那 3 条 `if` 相同。 */
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

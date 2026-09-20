// team-hub/routes/runtime-verification.mjs
// ============================================================================
// 路由层第 36 族：**机器验收与交接（PRT-307）：验收一条 / 列验收 / 交接一条 / 列交接 + 运行产物读取（结果 / 事件计数）** —— PRT-316 切片 38
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 36 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 2eb88ec:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 6 条的形态分布（生成器算的，不是抄的）
//
//   ×  6  `path === '…'`
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
// 6 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造机器验收与交接（PRT-307）：验收一条 / 列验收 / 交接一条 / 列交接 + 运行产物读取（结果 / 事件计数）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createRuntimeVerificationRoutes({
  json,
  handleRun, runStore, requireString,
  getTask, settleGoalsOfScope,
}) {
  const deps = { json,
    handleRun, runStore, requireString,
    getTask, settleGoalsOfScope,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createRuntimeVerificationRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/validate',
      async run(req, res) {
        // 机器验收（PRT-307）：执行成功之后的**独立关卡**。
        //
        // `criteria` 是可选覆盖：不传时按任务契约（`tasks.acceptance`）判，
        // 传了则以传入的为准（人工复审给出机器判据的场景）。覆盖是**显式**的，
        // 因为"当时按什么验的"必须能从事后记录里读回来（结论与判据一起落库）。
        //
        // `hasNextPost` 不在这里给默认值：它决定验收通过后是 Completed 还是 HandingOff，
        // 而这两个方向猜错的后果（静默掐断任务链 / 创建没有承接方的任务）都不报错。
        // 状态机与仓储都会在缺它时拒绝，这里只负责**不替调用方做主**。
        await handleRun(req, res, (body) => {
          const r = runStore.recordValidation({
            attemptId: requireString(body, 'attemptId'),
            leaseEpoch: body.leaseEpoch ?? null,
            actor: requireString(body, 'actor'),
            runResult: body.runResult,
            criteria: body.criteria ?? null,
            hasNextPost: body.hasNextPost,
            nextPost: body.nextPost ?? null,
            reason: body.reason ?? null,
          })
          try { settleGoalsOfScope(getTask(runStore.getAttempt(body.attemptId).taskId).scope) } catch { /* 任务不存在时不结算 */ }
          return r
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/validations',
      async run(req, res, { url }) {
        // 验收结论与**当时用的判据**一起读回来。
        // 只回结论是不够的：判据可以被人工复审覆盖，因此"不通过"到底是
        // 按契约判的还是按复审判的，不看判据就分不清。
        const attemptId = url.searchParams.get('attemptId')
        if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, attemptId, validations: runStore.validationsOf(attemptId), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/handoff',
      async run(req, res) {
        // 交接（PRT-308，spec 第 333 行）：当前 Task 收口并**原子创建**下一岗位任务。
        //
        // `prevSummary` 是上一阶段的收口结论（一行）；缺它时交接描述里会明说
        // 「上一阶段未留下收口结论」，而不是省略整行——省略会让下一岗位以为
        // 交接没发生过，于是它不会去问"上一环到底做完了什么"。
        //
        // 这里**不**接受调用方指定下一岗位：下一岗位由流水线决定。
        // 让调用方指定等于让执行者自己决定流水线怎么走。
        await handleRun(req, res, (body) => {
          const r = runStore.handoff({
            attemptId: requireString(body, 'attemptId'),
            leaseEpoch: body.leaseEpoch ?? null,
            actor: requireString(body, 'actor'),
            prevSummary: body.prevSummary ?? null,
            reason: body.reason ?? null,
          })
          try {
            const scope = getTask(runStore.getAttempt(body.attemptId).taskId).scope
            settleGoalsOfScope(scope)
          } catch { /* 任务不存在时不结算 */ }
          return r
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/handoffs',
      async run(req, res, { url }) {
        // 交接记录（只读）：后继是谁、谁交的、什么时候。
        // 这条记录同时是 `HandingOff → Completed` 要的证据，因此排查
        // 「为什么收不了口」时要能直接看到它。
        const attemptId = url.searchParams.get('attemptId')
        if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, attemptId, handoffs: runStore.handoffsOf(attemptId), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/run-results',
      async run(req, res, { url }) {
        // 运行结果（只读）：这次运行**产出了什么**。
        //
        // 它同时是 `Running → Validating / RetryableFailure / UnknownOutcome` 要的证据，
        // 因此排查"为什么它推不动 / 当初到底跑出了什么"时要能直接看到。
        //
        // `source` 必须透出去：`'engine'`（有引擎产出的原文）与
        // `'report-only'`（没有引擎产出，只有"谁报的、结局是什么"，`result` 为 null）
        // 是**两个不同的事实**，读成同一个会让人以为"引擎当时输出了 null"。
        const attemptId = url.searchParams.get('attemptId')
        if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, attemptId, runResults: runStore.runResultsOf(attemptId), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/run-events',
      async run(req, res, { url }) {
        // F-05 前半的读面：**运行明细**（13 种 RunEvent，按契约序号升序）。
        //
        // 这条路由存在的理由与 `/api/runtime/run-results` 完全相同，只是粒度更细：
        // `run_results` 回答"这次运行**结局**是什么"，`run_events` 回答
        // "这次运行**过程**里发生了什么"——用了哪个模型、请求了哪些工具、
        // 工具是成了还是败了、模型说了什么。
        //
        // 两条只读参数：
        //   · `type`  —— 只看某一类（"这次调了哪些工具"用 `tool.requested`）；
        //   · `counts=1` —— 只要按类型的计数（13 种事件逐个数），不要正文。
        //
        // `known` 必须透出去：`known: false` 的行说明**上游产生了一种本控制面
        // 不认识的事件**。那是一个要被看见的信号；过滤掉它会让"上游新增了事件
        // 但我们不记"与"上游什么都没产生"长得一样。
        const attemptId = url.searchParams.get('attemptId')
        if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
        if (url.searchParams.get('counts') === '1') {
          json(res, 200, { ok: true, ...runStore.runEventCountsOf(attemptId), serverTimeMs: Date.now() })
          return
        }
        const type = url.searchParams.get('type')
        const limitRaw = url.searchParams.get('limit')
        json(res, 200, {
          ok: true,
          attemptId,
          events: runStore.runEventsOf(attemptId, {
            type: type === null || type.length === 0 ? null : type,
            limit: limitRaw === null ? 1000 : Number(limitRaw),
          }),
          serverTimeMs: Date.now(),
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
    id: 'runtime-verification',
    routes,
    /** 6 条；顺序与 `handle` 里原来那 6 条 `if` 相同。 */
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

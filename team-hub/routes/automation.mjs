// team-hub/routes/automation.mjs
// ============================================================================
// 路由层第 7 族：**自动化计划（automation）：计划清单/建改 + 运行历史 + 汇总 + 日历投影 + 显式 tick** —— PRT-316 切片 7
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 7 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show ef0b7e6:team-hub/server.mjs` 的 `/api/automation` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 7 条的形态分布（生成器算的，不是抄的）
//
//   ×  7  `path === '…'`
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
// 7 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 10 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ⚠ **生成器核实**：下面这段原文写的路由条数与实测不符 ——
//   原文说「五条路由」，本族实测 **7** 条（按 `/api/automation` 取族、形态无关地数）。
//   数字**照原文保留**（零改写是纪律），但读的时候以实测为准；
//   这也是"逐字保真"必须配一道**交叉核对**的原因：
//
//   > 一个"逐字保真"的搬运，与一个"把原件的笔误一起保真"的搬运，
//   > 在原文对的时候是同一个东西。
// ============================================================================
// ── F-16 自动化计划 / 运行历史 ──────────────────────────────────────
//
// 五条路由，刻意把**写**与**投影**分开：
//   · `GET  /api/automation/calendar`  纯投影，不写任何行（"日历只做投影"）
//   · `GET  /api/automation/schedules` 计划清单
//   · `POST /api/automation/schedules` 建计划
//   · `POST /api/automation/schedules/update` 改计划（含启停）
//   · `POST /api/automation/tick`      显式物化（与生产定时器共用同一个函数）
//   · `GET  /api/automation/runs`      运行历史
//   · `GET  /api/automation/summary`   汇总


/**
 * 造自动化计划（automation）：计划清单/建改 + 运行历史 + 汇总 + 日历投影 + 显式 tick族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createAutomationRoutes({
  json,
  authorized, handleRun, requireString,
  automationStore, projectOccurrences, automationTick,
  AUTOMATION_ERRORS,
}) {
  const deps = { json,
    authorized, handleRun, requireString,
    automationStore, projectOccurrences, automationTick,
    AUTOMATION_ERRORS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createAutomationRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/automation/summary',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope')
        json(res, 200, { ok: true, ...automationStore.summary({ scope: scope !== null && scope.length > 0 ? scope : null }) })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/automation/schedules',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scope = url.searchParams.get('scope')
        const enabledRaw = url.searchParams.get('enabled')
        const limitRaw = url.searchParams.get('limit')
        json(res, 200, {
          ok: true,
          schedules: automationStore.listSchedules({
            scope: scope !== null && scope.length > 0 ? scope : null,
            enabled: enabledRaw === null ? null : enabledRaw === '1' || enabledRaw === 'true',
            limit: limitRaw === null ? 200 : Number(limitRaw),
          }),
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/automation/schedules',
      async run(req, res) {
        await handleRun(req, res, (body) => ({
          ok: true,
          schedule: automationStore.createSchedule({
            id: requireString(body, 'id'),
            scope: requireString(body, 'scope'),
            name: requireString(body, 'name'),
            spec: body.spec,
            timezone: requireString(body, 'timezone'),
            enabled: body.enabled !== false,
            overlapPolicy: body.overlapPolicy ?? 'skip',
            catchUpPolicy: body.catchUpPolicy ?? 'once',
            createdBy: body.by ?? null,
            note: body.note ?? null,
            // 任务模板：给了就"到点建一张可领的任务卡"，省略就只物化运行。
            // **不写成 `body.payload ?? null`** —— 那会把"没给"与"显式给 null"
            // 折成同一个值，而它们在建计划时语义相同（都不建任务），
            // 到了 `update` 那一侧就必须分开（见 `updateSchedule` 的三态说明）。
            ...(body.payload === undefined ? {} : { payload: body.payload }),
          }),
        }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/automation/schedules/update',
      async run(req, res) {
        await handleRun(req, res, (body) => ({
          ok: true,
          schedule: automationStore.updateSchedule({
            id: requireString(body, 'id'),
            enabled: body.enabled === undefined ? null : body.enabled === true,
            overlapPolicy: body.overlapPolicy ?? null,
            catchUpPolicy: body.catchUpPolicy ?? null,
            spec: body.spec ?? null,
            timezone: body.timezone ?? null,
            name: body.name ?? null,
            note: body.note ?? null,
            // 三态：不传 = 不改 / `null` = 显式清掉（此后不再建任务）/ 对象 = 换掉。
            // 用 `body.payload ?? null` 会让"清掉"与"不改"同形——用户想把
            // 一条计划从"建任务"改成"只提醒"，调用返回成功，而计划继续建任务。
            ...(body.payload === undefined ? {} : { payload: body.payload }),
          }),
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/automation/calendar',
      async run(req, res, { url }) {
        // ★ **纯投影**：这条路由是一段只读计算，库里一行都不会多。
        //
        // 参数里没有 `persist` / `materialize` 这种开关，是刻意的：
        // 一个"顺手把投影落库"的选项，会在某一次翻页之后让运行历史里
        // 多出一批**因为有人看了一眼**而产生的行。
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const id = url.searchParams.get('id')
        if (id === null || id.length === 0) { json(res, 400, { ok: false, error: '缺少 id', code: 'MISSING_PARAM' }); return }
        const sched = automationStore.scheduleOf(id)
        if (sched === null) { json(res, 404, { ok: false, error: `没有这条计划：${id}`, code: AUTOMATION_ERRORS.SCHEDULE_NOT_FOUND }); return }
        const fromRaw = Number(url.searchParams.get('fromMs'))
        const toRaw = Number(url.searchParams.get('toMs'))
        const fromMs = Number.isSafeInteger(fromRaw) ? fromRaw : Date.now()
        const toMs = Number.isSafeInteger(toRaw) ? toRaw : fromMs + 7 * 24 * 3600 * 1000
        const capRaw = Number(url.searchParams.get('max'))
        try {
          json(res, 200, {
            ok: true,
            scheduleId: id,
            // `projected: true` 是一个**能力发现位**：读的人要能一眼看出
            // 这些时刻不是运行记录，而是算出来的。
            projected: true,
            occurrences: projectOccurrences(sched, {
              fromMs, toMs,
              maxOccurrences: Number.isSafeInteger(capRaw) && capRaw > 0 ? Math.min(capRaw, 2000) : 500,
            }),
            serverTimeMs: Date.now(),
          })
        } catch (e) {
          json(res, Number(e?.statusCode) || 400, { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code ?? AUTOMATION_ERRORS.BAD_WINDOW })
        }
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/automation/runs',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scheduleId = url.searchParams.get('scheduleId')
        const scope = url.searchParams.get('scope')
        const state = url.searchParams.get('state')
        const limitRaw = url.searchParams.get('limit')
        json(res, 200, {
          ok: true,
          runs: automationStore.runsOf({
            scheduleId: scheduleId !== null && scheduleId.length > 0 ? scheduleId : null,
            scope: scope !== null && scope.length > 0 ? scope : null,
            state: state !== null && state.length > 0 ? state : null,
            limit: limitRaw === null ? 200 : Number(limitRaw),
          }),
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/automation/tick',
      async run(req, res) {
        // 显式 tick。与生产定时器**共用 `automationTick`**——两条实现漂移的
        // 表现是"手动 tick 对、自动 tick 错"，而后者只在生产上发生。
        await handleRun(req, res, (body) => automationTick({
          scope: typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : null,
          nowMs: body.nowMs ?? null,
          limit: body.limit ?? null,
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
    id: 'automation',
    routes,
    /** 7 条；顺序与 `handle` 里原来那 7 条 `if` 相同。 */
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

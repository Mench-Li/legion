// team-hub/routes/task-lifecycle.mjs
// ============================================================================
// 路由层第 32 族：**任务交接与运行时读数（claim / transition / advance / reassign / hold / release-stale + runtime 三条只读 + inbox）** —— PRT-316 切片 34
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 32 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 54c254d:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 11 条的形态分布（生成器算的，不是抄的）
//
//   × 11  `path === '…'`
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
// 11 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造任务交接与运行时读数（claim / transition / advance / reassign / hold / release-stale + runtime 三条只读 + inbox）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createTaskLifecycleRoutes({
  json,
  runStore, db, readPipeline,
  resolveNextPost, claimTask, audit,
  transitionTask, settleGoalsOfScope, advanceTask,
  reassignTask, now, getTask,
  releaseStaleTasks, inboxCount, handleWrite,
}) {
  const deps = { json,
    runStore, db, readPipeline,
    resolveNextPost, claimTask, audit,
    transitionTask, settleGoalsOfScope, advanceTask,
    reassignTask, now, getTask,
    releaseStaleTasks, inboxCount, handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createTaskLifecycleRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/reconciliations',
      async run(req, res, { url }) {
        // 对账记录（只读）：这条尝试被谁、以什么决定、按哪种结论处置过。
        //
        // 这条记录同时是 `UnknownOutcome` 四条出边要的证据，因此排查
        // 「为什么它推进不了 / 当初是谁把它判成'写成功了'」时要能直接看到它——
        // 而不是去打开数据库文件。
        //
        // 与 `/api/runtime/handoffs`、`/api/runtime/validations` 同一个形状：
        // 一份只写不读的证据，与一份没写的证据，在"事后能不能回答谁判的"上
        // 是同一个东西——只不过前者占了一张表。
        const attemptId = url.searchParams.get('attemptId')
        if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, attemptId, reconciliations: runStore.reconciliationsOf(attemptId), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/next-post',
      async run(req, res, { url }) {
        // 「这条任务后面还有没有岗位、是谁」——验收前要能先看到，
        // 否则调用方只能靠猜来决定 `hasNextPost`。
        // 链断/岗位不存在时返回 ok:false + 具名码，而**不是** hasNext:false。
        const taskId = url.searchParams.get('taskId')
        if (taskId === null || taskId.length === 0) { json(res, 400, { ok: false, error: '缺少 taskId', code: 'MISSING_PARAM' }); return }
        // 直接查两列而不是 `getTask`：后者对不存在的任务**抛异常**，
        // 于是"任务不存在"会变成 500，而它明明是 404（调用方给错了 id）。
        // 用异常做正常流程控制会让状态码失去意义。
        const task = db.prepare('SELECT id, scope, role FROM tasks WHERE id = ?').get(taskId)
        if (task === undefined) { json(res, 404, { ok: false, error: `任务不存在：${taskId}`, code: 'TASK_NOT_FOUND' }); return }
        const resolved = resolveNextPost({ stages: readPipeline(task.scope ?? 'default').stages, role: task.role ?? null })
        if (resolved.ok !== true) {
          json(res, 409, { ok: false, error: resolved.message, code: resolved.code, brokenEdge: resolved.brokenEdge ?? null, serverTimeMs: Date.now() })
          return
        }
        json(res, 200, {
          ok: true, taskId, role: task.role ?? null,
          hasNextPost: resolved.hasNext, nextRole: resolved.nextRole, nextLabel: resolved.nextLabel,
          reason: resolved.reason, serverTimeMs: Date.now(),
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/budget',
      async run(req, res, { url }) {
        // 重试额度读数：界面上要能回答"这条任务还能自动重试几次、下次什么时候"。
        // 答不出来时用户看到的只是"它又失败了"，而无法判断该不该干预。
        //
        // **注意：这条路径归"重试预算"，不归"费用预算"。** PRT-503 新增费用账本时
        // 一度也用了 `/api/runtime/budget`，于是这条成为不可达的死代码，而
        // `prt-007-baseline.json` 因为路由清单是 Set 去重的，**看不出任何变化**。
        // 费用账本因此改用 `/api/runtime/run-budget`——两个"budget"在 URL 上必须分开，
        // 否则后写的静默遮蔽先写的，而遮蔽的表现是"界面上那个读数的字段名变了"。
        const taskId = url.searchParams.get('taskId')
        if (taskId === null || taskId.length === 0) { json(res, 400, { ok: false, error: '缺少 taskId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, budget: runStore.retryBudgetOf(taskId), serverTimeMs: Date.now() })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/attempt',
      async run(req, res, { url }) {
        // 诊断用只读端点：一条尝试 + 它所属任务的全部历史 + 事件流。
        // 「试过几次、每次错在哪」如果只能靠翻日志，那它实际上是不可查的。
        const attemptId = url.searchParams.get('attemptId')
        const taskId = url.searchParams.get('taskId')
        if (attemptId) {
          const attempt = runStore.getAttempt(attemptId)
          if (attempt === null) { json(res, 404, { ok: false, error: `运行尝试不存在：${attemptId}` }); return }
          json(res, 200, { ok: true, attempt, history: runStore.historyOf(attempt.taskId), events: runStore.eventsOf(attemptId) })
          return
        }
        if (taskId) {
          json(res, 200, { ok: true, taskId, history: runStore.historyOf(taskId) })
          return
        }
        json(res, 400, { ok: false, error: '缺少参数 attemptId 或 taskId' })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/claim',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const soldier = typeof body.soldier === 'string' && body.soldier.length > 0 ? body.soldier : by
          const ttl = typeof body.ttlMinutes === 'number' && Number.isInteger(body.ttlMinutes) && body.ttlMinutes > 0 ? body.ttlMinutes : undefined
          const task = claimTask(id, soldier, body.ifVersion, body.force === true, body.round, body.requestId, ttl)
          audit(by, scope, 'claim', id, { soldier }, task.goalId)
          return task
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/transition',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          const to = body.to
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof to !== 'string' || to.length === 0) throw new Error('缺少参数 to')
          const task = transitionTask(id, to, by, body.ifVersion, body.force === true)
          audit(by, scope, 'transition', id, { to }, task.goalId)
          if (task.goalId || task.status === 'done' || task.status === 'canceled') settleGoalsOfScope(task.scope) // 链收尾 → 目标自动 done
          return task
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/advance',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const task = advanceTask(id, by, body.ifVersion)
          audit(by, scope, 'advance', id, {}, task.goalId)
          settleGoalsOfScope(task.scope) // 推进 done → 目标自动收尾
          return task
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/reassign',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          const soldier = body.soldier
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof soldier !== 'string' || soldier.trim().length === 0) throw new Error('缺少参数 soldier')
          const task = reassignTask(id, soldier.trim(), by)
          audit(by, scope, 'reassign', id, { soldier: soldier.trim() }, task.goalId)
          return task
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/hold',
      async run(req, res) {
        // 将军逐任务拦截/放行：hold=true 时守护不得自动认领执行（claimTask 拒绝），
        // 将军放行后恢复自动交接。done/canceled 不可再改。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const hold = body.hold === true
          const t = db.prepare('SELECT status, goalId FROM tasks WHERE id = ?').get(id)
          if (!t) throw new Error(`未知任务 ${id}`)
          if (t.status === 'done' || t.status === 'canceled') throw new Error(`任务 ${id} 已 ${t.status}，不可拦截/放行`)
          db.prepare('UPDATE tasks SET hold=?, version=version+1, updatedAt=? WHERE id=?').run(hold ? 1 : 0, now(), id)
          audit(by, scope, hold ? 'hold' : 'unhold', id, {}, t.goalId)
          return getTask(id)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/release-stale',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : undefined
          const minutes = Number(body.olderThan ?? 60)
          if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('olderThan 必须是正整数分钟数')
          const released = releaseStaleTasks(minutes, by, ids)
          audit(by, scope, 'release-stale', '*', { released })
          return { released }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/inbox',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? undefined
          const role = url.searchParams.get('role') ?? undefined
          const soldier = url.searchParams.get('soldier') ?? undefined
          if (role === undefined && soldier === undefined) throw new Error('inbox 需要 role 或 soldier 参数')
          json(res, 200, inboxCount({ role, soldier, scope: scopeParam }))
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
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
    id: 'task-lifecycle',
    routes,
    /** 11 条；顺序与 `handle` 里原来那 11 条 `if` 相同。 */
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

// team-hub/routes/runtime-lease.mjs
// ============================================================================
// 路由层第 35 族：**运行面（PRT-302/303/313）：带权威时间与 leaseEpoch 的领取 / 续租 / 提交 / 放弃 / 恢复 / 失败 / 挂起 / 决议** —— PRT-316 切片 37
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 35 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 9953da5:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 9 条的形态分布（生成器算的，不是抄的）
//
//   ×  9  `path === '…'`
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
// 9 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 4 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 运行面（PRT-302/303/313）：带权威时间与 leaseEpoch 的领取/续租/提交/放弃 ──
// 与上面 /api/claim 等**看板**写操作并存而不是替换：看板操作的主体是人（成员 `by`），
// 运行操作的主体是 worker。两者的失败语义不同——看板冲突要提示用户重试，
// 运行面的 epoch 冲突要求 worker **停手**，因此不能共用一条路径。


/**
 * 造运行面（PRT-302/303/313）：带权威时间与 leaseEpoch 的领取 / 续租 / 提交 / 放弃 / 恢复 / 失败 / 挂起 / 决议族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createRuntimeLeaseRoutes({
  json,
  handleRun, runStore, requireString,
  getTask, settleGoalsOfScope, recordRunEventsBestEffort,
}) {
  const deps = { json,
    handleRun, runStore, requireString,
    getTask, settleGoalsOfScope, recordRunEventsBestEffort,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createRuntimeLeaseRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/claim',
      async run(req, res) {
        await handleRun(req, res, (body) => runStore.claim({
          workerId: body.workerId,
          scope: typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : null,
          leaseTtlMs: body.leaseTtlMs ?? null,
          nowMs: body.nowMs ?? null,
        }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/heartbeat',
      async run(req, res) {
        await handleRun(req, res, (body) => runStore.heartbeat({
          attemptId: requireString(body, 'attemptId'),
          leaseEpoch: body.leaseEpoch,
          workerId: body.workerId,
          leaseTtlMs: body.leaseTtlMs ?? null,
          nowMs: body.nowMs ?? null,
        }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/transition',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const attemptId = requireString(body, 'attemptId')
          // F-05 前半：终态迁移与事件明细**同一个请求**。
          //
          // ★ 顺序是**明细先写、迁移后做**，这个顺序是实质的：
          //   明细带 `leaseEpoch`，而迁移会把 epoch 推进（终态之后这条租约就不再有效）。
          //   反过来写在失败路径上是**必然**的：`failAndRetry` 会推进 epoch，
          //   于是"用同一个 epoch 写明细"会被 epoch 闸门拒掉——
          //   而那个拒绝看起来像"明细功能坏了"，实际是"探针/顺序错了"。
          //
          //   明细属于**这次运行**，所以它必须用**这次运行**的 epoch 去写。
          //
          // 它**不**参与迁移判定：明细写失败不该让一次已经成功的终态回滚——
          // 那会把"复盘材料缺了一点"升级成"这次运行的结果不成立"，
          // 接着会被重试（真的再花一次钱）。方向是反的。
          // 但失败**要被看见**：读数放进返回值。
          const evOutcome = recordRunEventsBestEffort({ attemptId, context: body.context, leaseEpoch: body.leaseEpoch })
          const r = runStore.transition({
            attemptId,
            leaseEpoch: body.leaseEpoch,
            workerId: body.workerId,
            to: body.to ?? null,
            outcome: body.outcome ?? null,
            context: body.context ?? {},
            reason: body.reason ?? null,
            nowMs: body.nowMs ?? null,
          })
          // 状态迁移后可能收尾目标链（与看板 /api/transition 的行为对齐，
          // 否则运行面完成的任务与看板完成的任务对目标的结算不一致）
          try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
          // ★ 键**恒在**（没带明细时是 `null`）：`undefined` 在 JSON 里会被丢掉，
          //   于是"这次请求没带明细"与"这个字段还没上线"在响应上长得一样。
          return { ...r, runEvents: evOutcome }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/release',
      async run(req, res) {
        await handleRun(req, res, (body) => runStore.release({
          attemptId: requireString(body, 'attemptId'),
          leaseEpoch: body.leaseEpoch,
          workerId: body.workerId,
          reason: body.reason ?? 'released',
        }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/recover',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          // 「哪些状态已越过外部写边界」必须由调用方给。给不出就拒绝回收——
          // 猜错的方向是「把一个可能已经付过费的任务重跑一遍」。
          const from = body.externalEffectPossibleStates
          if (!Array.isArray(from) || from.length === 0) {
            throw Object.assign(new Error(
              '缺少 externalEffectPossibleStates（已越过外部写边界的尝试状态数组）。' +
              '这一条不能猜：判成「可重试」会在已发生外部副作用时重复执行，' +
              '判成「未知」会让本可自动恢复的任务挂起'),
            { code: 'EXTERNAL_EFFECT_UNKNOWN', statusCode: 400 })
          }
          const set = new Set(from)
          const r = runStore.recoverExpired({
            externalEffectPossible: (attempt) => set.has(attempt.state),
            scope: typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : null,
            limit: Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 500) : 50,
          })
          return { ...r, externalEffectPossibleStates: [...set] }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/status',
      async run(req, res) {
        json(res, 200, { ok: true, ...runStore.stats() })
      },
    },
    // ============================================================================
    // 原文的子段说明（1 行，逐字搬来、未改写）
    // ============================================================================
    // ── 运行面（PRT-309/310/311）：失败结算、等人工清单、人工处置 ──
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/fail',
      async run(req, res) {
        // worker 报告失败的**唯一**入口。为什么不让 worker 自己发
        // `transition({to:'RetryableFailure'})` 再另外排重试：分成两步时，
        // 漏掉第二步的后果是任务永远停在 RetryableFailure——它既没有可领的队列，
        // 也不在等人工列表里，从任何界面看都只是"失败了"，而没有人会去处理它。
        await handleRun(req, res, (body) => {
          const attemptId = requireString(body, 'attemptId')
          // F-05 前半：**失败路径的明细最要紧**——"它在炸之前做了什么"。
          //
          // ★ 必须先于 `failAndRetry` 写：那一步会推进 `lease_epoch`，
          //   而明细用**这次运行**的 epoch 写。反过来写会被 epoch 闸门拒掉，
          //   而那个拒绝看起来像"明细功能坏了"。
          //
          // 明细放在 body 顶层（不是 `context` 里）：`fail` 与 `transition`
          // 的 body 形状本就不同，让两处共用一个嵌套键只会诱使下一个调用方去猜。
          const evOutcome = recordRunEventsBestEffort({
            attemptId,
            context: { runEvents: body.runEvents, runEventsTruncated: body.runEventsTruncated },
            leaseEpoch: body.leaseEpoch ?? null,
          })
          const r = runStore.failAndRetry({
            attemptId,
            leaseEpoch: body.leaseEpoch ?? null,
            actor: requireString(body, 'workerId'),
            failureCode: body.failureCode ?? null,
            detail: body.detail ?? null,
            reason: body.reason ?? 'failure-reported',
            // `Running → RetryableFailure` 声明了 `requiresPersist: ['attempt','runResult']`。
            // 引擎**抛错**时调用方手里没有结果（`executor.mjs` 的 catch 路径），
            // 那就只能由仓储从失败事实合成一行；引擎若正常返回了失败终态，
            // 调用方可以把 `result` 一起带上，那一行就是**真凭据**。
            // 两种来源在库里分得开（`run_results.source`）。
            runResult: body.runResult ?? null,
            nowMs: body.nowMs ?? null,
          })
          try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
          // 与 `transition` 同形：键恒在。
          return { ...r, runEvents: evOutcome }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/runtime/held',
      async run(req, res, { url }) {
        // 「等人工处置」清单：UnknownOutcome（结果不可确认）与 DeadLetter（额度耗尽）。
        // 这两类必须能从界面上看到并逐个结掉，否则状态机保证的"不会静默重跑"
        // 会变成"静默消失"——队列看起来只是没有任务。
        const scope = url.searchParams.get('scope')
        const limitRaw = url.searchParams.get('limit')
        json(res, 200, runStore.listHeld({
          scope: scope !== null && scope.length > 0 ? scope : null,
          limit: limitRaw === null ? 100 : Number(limitRaw),
        }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/runtime/resolve',
      async run(req, res) {
        // 人工处置：对账结论是**输入**，不是可以默认的东西。
        // 四个决定各自对应一个不同的事实（已发生 / 未发生 / 放弃 / 取消），
        // 没有"默认当成没发生"这种便利入口——那正是重复付费的来源。
        await handleRun(req, res, (body) => {
          const r = runStore.resolveAttempt({
            attemptId: requireString(body, 'attemptId'),
            decision: requireString(body, 'decision'),
            actor: requireString(body, 'actor'),
            note: body.note ?? null,
            nowMs: body.nowMs ?? null,
          })
          try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
          return r
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
    id: 'runtime-lease',
    routes,
    /** 9 条；顺序与 `handle` 里原来那 9 条 `if` 相同。 */
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

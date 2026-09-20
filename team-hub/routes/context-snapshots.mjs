// team-hub/routes/context-snapshots.mjs
// ============================================================================
// 路由层第 15 族：**上下文快照（PRT-407 / PRT-409，spec §6.5）** —— PRT-316 切片 16
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 15 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 4ed55ec:team-hub/server.mjs` 的 `/api/context-snapshots` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 6 条的形态分布（生成器算的，不是抄的）
//
//   ×  5  `path === '…'`
//   ×  1  `path.startsWith('…')`
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

// ============================================================================
// 以下 4 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 上下文快照（PRT-407 / PRT-409，spec §6.5）──
//
// 读面是重点：spec §6.5 要求「还原其实际输入、来源版本、过滤和裁剪原因」，
// 而这句话只有在**存下来并能读回来**之后才有意义。


/**
 * 造上下文快照（PRT-407 / PRT-409，spec §6.5）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createContextSnapshotsRoutes({
  json,
  contextStore, handleRun, assembleContext,
  describeAssembly, collectCandidates, createContextSource,
  createConservativeTokenizer, tokenizerForProfile, planSnapshotRetention,
  buildSnapshotExport, verifySnapshotExport, CONTEXT_EXPORT_CODES,
  ContextExportError, SourceError, TOKENIZER_REGISTRY,
}) {
  const deps = { json,
    contextStore, handleRun, assembleContext,
    describeAssembly, collectCandidates, createContextSource,
    createConservativeTokenizer, tokenizerForProfile, planSnapshotRetention,
    buildSnapshotExport, verifySnapshotExport, CONTEXT_EXPORT_CODES,
    ContextExportError, SourceError, TOKENIZER_REGISTRY,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createContextSnapshotsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/context-snapshots',
      async run(req, res, { url }) {
        const runId = url.searchParams.get('runId')
        const scope = url.searchParams.get('scope')
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
        const items = contextStore().list({ runId, scope, limit })
        json(res, 200, { ok: true, snapshots: items, count: contextStore().count(), serverTimeMs: Date.now() })
      },
    },
    // ============================================================================
    // 原文的子段说明（5 行，逐字搬来、未改写）
    // ============================================================================
    // ── 快照保留策略：**先看计划，再决定清不清**（PRT-409 收尾，spec line 748） ──
    //
    // 这条是**只读**的：它算一份计划，什么都不删。
    // 把"看计划"与"执行"拆成两条路由，是因为清理证据是不可撤回的，
    // 而一个"调用即删除"的接口没有让人反悔的地方。
    {
      method: 'GET',
      match: 'exact',
      path: '/api/context-snapshots/retention',
      async run(req, res, { url }) {
        const q = url.searchParams
        // 两个参数都**必须显式给**（值可以是 `null` 表示不设上限）。
        // 不给就用默认值会让"我这次想不设上限"与"我忘了传"变成同一个请求。
        const ageRaw = q.get('maxAgeDays')
        const bytesRaw = q.get('maxBytes')
        if (ageRaw === null || bytesRaw === null) {
          json(res, 400, {
            ok: false, code: 'RETENTION_POLICY_REQUIRED',
            error: '必须显式给出 maxAgeDays 与 maxBytes（不设上限写 null）：'
              + '"这次不设上限"与"我忘了传"必须能区分——后者会让一次查询悄悄变成一次全清',
            serverTimeMs: Date.now(),
          })
          return
        }
        const policy = {
          maxAgeDays: ageRaw === 'null' ? null : Number(ageRaw),
          maxBytes: bytesRaw === 'null' ? null : Number(bytesRaw),
        }
        if ((policy.maxAgeDays !== null && !(Number.isInteger(policy.maxAgeDays) && policy.maxAgeDays > 0))
          || (policy.maxBytes !== null && !(Number.isInteger(policy.maxBytes) && policy.maxBytes > 0))) {
          json(res, 400, {
            ok: false, code: 'RETENTION_POLICY_INVALID',
            error: `maxAgeDays/maxBytes 只能是正整数或 null，收到 ${JSON.stringify(policy)}`,
            serverTimeMs: Date.now(),
          })
          return
        }
        // 仍在跑的 Run 的 id 由调用方给：hub 的 **Run 状态**是 run-store 的事，
        // 快照账本不知道"谁还在跑"。这里不猜、不高估——猜错的方向是删掉活着的证据。
        const activeRunIds = q.getAll('activeRunId')
        const plan = planSnapshotRetention({
          rows: contextStore().retentionRows(), policy, nowMs: Date.now(), activeRunIds,
        })
        json(res, 200, {
          ok: true,
          // 只回计划，不回正文：预览一份计划不需要看到证据内容。
          policy,
          usage: plan.usage,
          cap: plan.cap,
          purge: plan.purge,
          findings: plan.findings,
          keepCount: plan.keep.length,
          versions: { retention: plan.version },
          serverTimeMs: Date.now(),
        })
      },
    },
    // ============================================================================
    // 原文的子段说明（5 行，逐字搬来、未改写）
    // ============================================================================
    // ── 执行清理。**必须显式 `dryRun:false`**，且必须给 actor 与 reason ──
    //
    // 校验失败一律**抛**（带 statusCode + code），不是 `return {ok:false}`：
    // `handleRun` 会把回调的返回值展开成 **HTTP 200**，
    // 于是"缺 actor"会变成一次成功的响应——调用方以为清理发生了。
    {
      method: 'POST',
      match: 'exact',
      path: '/api/context-snapshots/purge',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const bad = (code, message) => Object.assign(new Error(message), { statusCode: 400, code })
          // `dryRun` 没有默认值。一个"没传就真的删了"的清理接口，
          // 与一个"手滑就删掉审计证据"的清理接口，是同一个东西——
          // 而 `dryRun` 默认 `true` 也好不到哪去：它会让调用方以为自己删了，
          // 于是真正该删的时候删不掉，而报错里没有一个字解释为什么。
          if (typeof body.dryRun !== 'boolean') {
            throw bad('RETENTION_DRYRUN_REQUIRED',
              '必须显式给出布尔 dryRun。不给默认值：'
              + '"没传就是预演"会让真的清理静默失效，"没传就是执行"会让一次查询删掉证据')
          }
          if (typeof body.actor !== 'string' || body.actor.trim() === '') {
            throw bad('RETENTION_ACTOR_REQUIRED', '必须给出 actor：清掉审计证据必须能定位到人')
          }
          if (typeof body.reason !== 'string' || body.reason.trim() === '') {
            throw bad('RETENTION_REASON_REQUIRED', '必须给出 reason：墓碑要能回答"以什么理由清的"')
          }
          const policy = body.policy ?? {}
          if (!Object.hasOwn(policy, 'maxAgeDays') || !Object.hasOwn(policy, 'maxBytes')) {
            throw bad('RETENTION_POLICY_REQUIRED',
              '策略必须显式给出 maxAgeDays 与 maxBytes（不设上限写 null）')
          }
          const nowMs = Number.isInteger(body.nowMs) ? body.nowMs : Date.now()
          const plan = planSnapshotRetention({
            rows: contextStore().retentionRows(),
            policy,
            nowMs,
            activeRunIds: Array.isArray(body.activeRunIds) ? body.activeRunIds : [],
          })
          if (body.dryRun === true) {
            // 预演**什么都不做**，包括不写墓碑——预演不是一次"差点发生的事故"。
            return {
              dryRun: true,
              wouldPurge: plan.purge.length,
              wouldFreeBytes: plan.usage.purgeBytes,
              purge: plan.purge,
              findings: plan.findings,
              usage: plan.usage,
              cap: plan.cap,
            }
          }
          if (plan.purge.length === 0) {
            return { dryRun: false, purged: 0, note: '没有可清理的快照', findings: plan.findings }
          }
          // 一次一个 attemptId，各自一个事务。**不做一次大事务**：
          // 中途失败时要能说清"已经清了哪几份"，而一个回滚掉的大事务
          // 会把"清了一半"与"什么都没清"变成同一个结果。
          const purged = []
          for (const e of plan.purge) {
            const r = contextStore().purge(e.attemptId, {
              reason: body.reason.trim(), actor: body.actor.trim(), nowMs,
            })
            purged.push({ attemptId: e.attemptId, bytes: e.bytes, alreadyPurged: r.alreadyPurged })
          }
          return {
            dryRun: false,
            purged: purged.length,
            freedBytes: purged.reduce((a, e) => a + e.bytes, 0),
            attempted: plan.purge.length,
            findings: plan.findings,
            counts: contextStore().counts(),
          }
        })
      },
    },
    // ============================================================================
    // 原文的子段说明（1 行，逐字搬来、未改写）
    // ============================================================================
    // ── 墓碑清单（"丢过什么、谁清的、为什么"） ──
    {
      method: 'GET',
      match: 'exact',
      path: '/api/context-snapshots/tombstones',
      async run(req, res, { url }) {
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
        json(res, 200, {
          ok: true,
          tombstones: contextStore().listTombstones({ limit }),
          counts: contextStore().counts(),
          serverTimeMs: Date.now(),
        })
      },
    },
    // ============================================================================
    // 原文的子段说明（4 行，逐字搬来、未改写）
    // ============================================================================
    // 服务端装配（PRT-407）。这条路由的存在有两层意义：
    //   ① 装配器有了**真实调用方**（此前它只有用例）；
    //   ② 装配与持久化在同一个请求里完成，于是"冻结在 Running 之前"
    //      不是一条靠人记住的约定。
    {
      method: 'POST',
      match: 'exact',
      path: '/api/context-snapshots/assemble',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const scope = body.scope ?? 'default'

          // **先校验配置，再看状态**：缺字段是调用方写错了请求，不是运行状态的问题。
          //
          // 这三项此前会一路走到 `assembleContext` 才炸，结果是 `code: null` 的 400——
          // 消息能读、但客户端**无从程序化判断**。而 `CONTEXT_PERMISSION_REQUIRED`
          // 那条就在这里返回了带码的 400：同一个路由上两种风格并存，
          // 调用方只能靠匹配错误文本，那是会随文案变更而碎的判据。
          for (const [key, why] of [
            ['attemptId', '快照以 attemptId 为主键——没有它无法回答"这是哪一次尝试的输入"'],
            ['runId', '快照要按 run 归档，并且密钥轮换只影响轮换后创建的 Run'],
          ]) {
            if (typeof body[key] !== 'string' || body[key].trim() === '') {
              json(res, 400, {
                ok: false, code: 'CONTEXT_BAD_REQUEST',
                error: `${key} 必须是非空字符串：${why}`,
                serverTimeMs: Date.now(),
              })
              return
            }
          }
          if (!Number.isInteger(body.frozenAtMs)) {
            json(res, 400, {
              ok: false, code: 'CONTEXT_BAD_REQUEST',
              error: 'frozenAtMs 必须是整数毫秒：冻结时刻是快照哈希的一部分，缺了它两次装配无法判定"是不是同一份"。',
              serverTimeMs: Date.now(),
            })
            return
          }

          // **权限判定必须由调用方给出，路由不替它决定。**
          // 不写就默认放行，是这一段里最危险的一种默认值：一次漏传会让
          // 越权来源静默进入上下文，而快照上看不出任何异常。
          const allowAll = body.canReadAll === true
          const allowIds = Array.isArray(body.canReadIds) ? body.canReadIds : null
          if (!allowAll && allowIds === null) {
            json(res, 400, {
              ok: false, code: 'CONTEXT_PERMISSION_REQUIRED',
              error: '必须显式给出 canReadIds（可读来源 id 列表）或 canReadAll: true。路由不替调用方决定权限——默认放行会让越权来源静默进入上下文。',
              serverTimeMs: Date.now(),
            })
            return
          }
          const allowed = new Set(allowIds ?? [])
          const canRead = (meta) => (allowAll ? true : allowed.has(meta.id))

          if (!Array.isArray(body.candidates) && body.sources === undefined) {
            json(res, 400, {
              ok: false, code: 'CONTEXT_BAD_CANDIDATE',
              error: '必须给出 candidates（现成的候选数组）或 sources（高层输入：teamPlan/employeeManifest/goal/task/comments/…）。'
                + '没有来源时给 candidates: []。',
            })
            return
          }
          if (!Array.isArray(body.candidates) && Array.isArray(body.sources)) {
            json(res, 400, {
              ok: false, code: 'CONTEXT_BAD_CANDIDATE',
              error: 'sources 是对象（各来源的输入），不是数组。数组形式请用 candidates。',
            })
            return
          }

          // 两条入口：
          //   · `sources`   —— 高层输入，由 PRT-402~406 归一成候选（系统里的东西走这条）
          //   · `candidates`—— 现成的候选（调用方自己装配，或来自别处）
          // 两条都收敛到同一个装配器，所以形状约束与账本规则不会分叉。
          let rawCandidates
          if (Array.isArray(body.candidates)) {
            rawCandidates = body.candidates
          } else {
            try {
              rawCandidates = collectCandidates({
                ...body.sources,
                // scope 以路由上的为准：调用方不该能通过 sources.scope
                // 把来源放进另一个空间——那正是"不可信内容改变作用域"的入口。
                scope: body.scope,
              })
            } catch (e) {
              if (e instanceof SourceError) {
                json(res, 400, { ok: false, code: 'CONTEXT_BAD_SOURCE', error: e.message, serverTimeMs: Date.now() })
                return
              }
              throw e
            }
          }

          // 用 `createContextSource` 构造来源：于是来源的**形状约束**
          //（默认不可信、不许带权威字段、未知字段拒绝）在这一层同样生效，
          // 而不是只在用例里生效。
          //
          // **这里必须自己接住并给具名码。** `createContextSource` 抛的是普通
          // `Error`（没有 `code`），而 `handleRun` 对没有码的异常一律发
          // `code: null` 的 400。于是这条路由上**最要紧的一次拒绝**——
          // "不可信内容想携带 `grants`" ——与"别的什么 400"在响应里长得一模一样，
          // 调用方只能去匹配错误文案，而文案会随措辞变更而碎。
          //
          // 与 `CONTEXT_PERMISSION_REQUIRED` 同一条口径：拒绝必须是**可程序化判断**的。
          // 复用 `CONTEXT_BAD_SOURCE` 而不是新造一个码，让"来源本身不合法"
          // 在这条路由上只有一个名字，不管它来自 `collectCandidates` 还是这里。
          const candidates = rawCandidates.map((c, i) => {
            if (c === null || typeof c !== 'object' || c.source === null || typeof c.source !== 'object') {
              throw Object.assign(new Error(`candidates[${i}] 必须是 { source } 形状`), { statusCode: 400, code: 'CONTEXT_BAD_CANDIDATE' })
            }
            let source
            try {
              source = createContextSource(c.source)
            } catch (e) {
              throw Object.assign(
                new Error(`candidates[${i}].source 被拒绝：${e.message}`),
                { statusCode: 400, code: 'CONTEXT_BAD_SOURCE' },
              )
            }
            return {
              source,
              scope: c.scope ?? undefined,
              required: c.required === true,
              allowTruncate: c.allowTruncate === true,
              supersededBy: c.supersededBy ?? undefined,
              // `missing`：调用方**试着取过**但产物不在。没有这条通路时，
              // "我取不到"唯一能做的事就是不提这个候选，而快照会看起来完整。
              missing: c.missing === true,
              missingReason: c.missingReason ?? undefined,
            }
          })

          // tokenizer：能按模型找到精确的就用精确的，否则**明说**是估算。
          // 注册表默认为空——本项目零依赖，拿不到任何供应商的词表。
          const tokenizer = body.model === undefined
            ? createConservativeTokenizer()
            : tokenizerForProfile({ model: body.model }, TOKENIZER_REGISTRY)

          const snapshot = assembleContext({
            attemptId: body.attemptId,
            runId: body.runId,
            frozenAtMs: body.frozenAtMs,
            associations: body.associations ?? {},
            candidates,
            policy: { scope, canRead, priority: body.priority, maxTokens: body.maxTokens ?? null },
            tokenizer,
          })
          const rec = contextStore().record(snapshot, { scope, actor: body.actor ?? null })
          return { recorded: rec, summary: describeAssembly(snapshot), snapshotHash: snapshot.snapshotHash }
        })
      },
    },
    // ============================================================================
    // 原文的子段说明（15 行，逐字搬来、未改写）
    // ============================================================================
    // ── 导出一次 Attempt 的上下文快照（PRT-409 右半部分：spec line 897「导出」） ──
    //
    // ★ 导出与"读一条快照"共用**同一个** `path.startsWith('/api/context-snapshots/')`
    //   守卫，而不是各写一条。第一版是两条独立的路由，于是：
    //
    //   ① 基线快照的"同一条路由不得被写两次"检查报了
    //      `GET /api/context-snapshots/ ×2`——抽取器按**路径字面量**计数，
    //      两条守卫用了同一个字面量，于是看起来是后者遮蔽了前者；
    //   ② 真正的风险是**顺序**：如果 `/export` 那条写在通配那条**之后**，
    //      通配那条会把含 `/` 的 id 判成 400 `MISSING_PARAM`，
    //      导出路由**永远走不到**——而它看起来像"路由写好了"。
    //
    //   合并成一条守卫同时消掉这两件事：只有一条路由被声明，
    //   也就不存在"谁在前面"这个问题。这也是 `duplicate route` 那条检查
    //   真正想说的是：**同一段路径不该被判断两次。**
    {
      method: 'GET',
      match: 'prefix',
      path: '/api/context-snapshots/',
      async run(req, res, { path, url }) {
        const PREFIX = '/api/context-snapshots/'

        if (path.endsWith('/export')) {
          let exportAttemptId
          try {
            exportAttemptId = decodeURIComponent(path.slice(PREFIX.length, -'/export'.length))
          } catch {
            json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: 'attemptId 不是合法的 URL 编码' })
            return
          }
          if (exportAttemptId === '' || exportAttemptId.includes('/')) {
            json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/context-snapshots/<attemptId>/export' })
            return
          }
          // 导出人必须有名字，导出时刻必须**显式给**。
          //
          // 不拿"现在"当 exportedAtMs 的默认值：一个没写时间的导出会被读成
          // "就是刚导的"，而那是一次无法复核的猜测——而导出存在的意义正是可复核。
          const by = url.searchParams.get('by')
          const atMsRaw = url.searchParams.get('atMs')
          if (by === null || by.trim() === '') {
            json(res, 400, {
              ok: false, code: 'EXPORT_BY_REQUIRED',
              error: '缺少 by：导出必须记下**是谁导的**。一个无名的导出与一份匿名证据是同一种东西',
              serverTimeMs: Date.now(),
            })
            return
          }
          const atMs = atMsRaw === null ? NaN : Number(atMsRaw)
          if (!Number.isInteger(atMs)) {
            json(res, 400, {
              ok: false, code: 'EXPORT_AT_REQUIRED',
              error: '缺少整数毫秒 atMs：不拿"现在"当默认值——导出时间是要被复核的',
              serverTimeMs: Date.now(),
            })
            return
          }
          const rec = contextStore().get(exportAttemptId)
          if (rec === null) {
            // 404 而不是一份"空的但格式正确"的导出：后者会被下游当成有效证据。
            json(res, 404, {
              ok: false, code: 'CONTEXT_NOT_FOUND', error: `没有这份上下文快照：${exportAttemptId}`,
              serverTimeMs: Date.now(),
            })
            return
          }
          try {
            const exported = buildSnapshotExport(rec, {
              exportedBy: by,
              exportedAtMs: atMs,
              exportedReason: url.searchParams.get('reason'),
            })
            json(res, 200, {
              ok: true,
              export: exported,
              // 顺手把验证结论也带上：调用方不必自己再实现一遍哈希。
              verification: verifySnapshotExport(exported),
              serverTimeMs: Date.now(),
            })
          } catch (e) {
            if (e instanceof ContextExportError) {
              json(res, e.code === CONTEXT_EXPORT_CODES.RECORD_NOT_VERIFIED
                || e.code === CONTEXT_EXPORT_CODES.STORE_HASH_MISMATCH ? 409 : 400, {
                ok: false, code: e.code, error: e.message, serverTimeMs: Date.now(),
              })
              return
            }
            throw e
          }
          return
        }

        let attemptId
        try {
          attemptId = decodeURIComponent(path.slice(PREFIX.length))
        } catch {
          json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: 'attemptId 不是合法的 URL 编码' })
          return
        }
        if (attemptId === '' || attemptId.includes('/')) {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/context-snapshots/<attemptId>' })
          return
        }
        const found = contextStore().get(attemptId)
        if (found === null) {
          // ★ 三种状态，不是两种。
          //
          //   `get()` 的 `null` 把两件完全不同的事压成了同一个：
          //   "从来没存在过"与"被保留策略清掉了"。
          //
          //     > 一份"被策略清掉"的快照，与一份"从来没有过"的快照，
          //     > 在只看 `get()` 的代码里是同一个 `null`——
          //     > 只不过前者意味着"这次的输入我们已经丢掉了"，
          //     > 而后者意味着"你查错了 id"。
          //
          //   对一个以"可还原"为卖点的产品，这两件事的差别就是全部意义。
          //   所以这里给 **410 Gone**（它曾经在，现在不在了）而不是 404，
          //   并把墓碑一并返回——审计要说得出"丢了什么、谁清的、为什么"。
          const spot = contextStore().locate(attemptId)
          if (spot.kind === 'purged') {
            json(res, 410, {
              ok: false,
              code: 'CONTEXT_SNAPSHOT_PURGED',
              error: `快照 ${attemptId} 存在过，已被保留策略清理（${spot.tombstone.reason}）——`
                + '正文没有了，但这次运行确实发生过',
              tombstone: spot.tombstone,
              serverTimeMs: Date.now(),
            })
            return
          }
          json(res, 404, { ok: false, code: 'CONTEXT_NOT_FOUND', error: `没有这份上下文快照：${attemptId}` })
          return
        }
        // `?verify=1`：读回时**再验一次哈希**。库里的记录可能被外部改过，
        // 而一份被改过的记录会让往后每一次"还原"都建立在假前提上。
        const withVerify = url.searchParams.get('verify') === '1'
        json(res, 200, {
          ok: true,
          ...found,
          ...(withVerify ? { verification: contextStore().verify(attemptId) } : {}),
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
    id: 'context-snapshots',
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

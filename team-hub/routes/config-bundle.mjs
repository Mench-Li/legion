// team-hub/routes/config-bundle.mjs
// ============================================================================
// 路由层第 16 族：**配置包导出/导入（PRT-5xx，spec §6.6）** —— PRT-316 切片 17
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 16 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 11cb851:team-hub/server.mjs` 的 `/api/config-bundle` 段落。
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
// 以下 12 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 配置导入导出（PRT-508，spec §6.6 第 403 行「导出不包含密钥」） ──
//
// 三条产品纪律：
//   ① **导出永远不含密钥，也不含 `secretRef`**（契约层强制，这里不再放宽）。
//      导出物带 `credentialRequired` 说明"这条档案需要凭证"，但不说
//      "从哪台机器的哪个槽位取"——后者跨机器没有意义。
//   ② 导入是**两段式**：先 `plan`（dry run，什么都不写），再 `apply`。
//      理由是导入会改变"哪条任务用哪个模型"，而那同时改变成本、质量与
//      数据去了哪。一次性静默应用意味着这三件事都在无人看到的情况下变了。
//   ③ `apply` 只做计划里 `create`/`update` 的那些；**不删除**包里没有的
//      档案。否则一份不完整的包会清空整台机器的配置，而"不完整"是常态
//      （比如只导出一条模型做灰度）。


/**
 * 造配置包导出/导入（PRT-5xx，spec §6.6）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createConfigBundleRoutes({
  json,
  bindingStore, modelStore, buildBundle,
  planImport, validateBundle, assertApplicable,
  BUNDLE_ERRORS, BundleError, handleRun,
}) {
  const deps = { json,
    bindingStore, modelStore, buildBundle,
    planImport, validateBundle, assertApplicable,
    BUNDLE_ERRORS, BundleError, handleRun,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createConfigBundleRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/config-bundle',
      async run(req, res, { url }) {
        const kind = url.searchParams.get('kind') ?? 'full'
        try {
          // `modelStore.list()` 给的是 descriptor（含 `hasCredential`，**不含**
          // `secretRef`）——正好是导出需要的形态：凭证"要不要"是档案的属性，
          // "从哪取"是本机的属性。`hasCredential` 转成 `credentialRequired`。
          const profiles = kind === 'model-bindings' ? [] : modelStore.list().map((d) => ({
            id: d.id,
            displayName: d.displayName,
            runtimeType: d.runtimeType,
            provider: d.provider,
            model: d.model,
            endpoint: d.endpoint,
            reasoningEffort: d.reasoningEffort,
            limits: d.limits,
            credentialRequired: d.hasCredential === true,
          }))
          const bindings = kind === 'model-profiles' ? [] : bindingStore.list()
          const bundle = buildBundle({
            profiles,
            bindings,
            kind,
            exportedAtMs: Date.now(),
            exportedBy: url.searchParams.get('actor'),
            note: url.searchParams.get('note'),
          })
          json(res, 200, { ok: true, bundle })
        } catch (e) {
          // 出口门禁触发（配置里混进了密钥形态的东西）。这不是"服务端出错"，
          // 而是**配置本身有问题**，所以要 400 + 一个能让人找到那条档案的码。
          if (e instanceof BundleError) {
            json(res, 400, { ok: false, code: e.code, error: e.message, hits: e.hits ?? null, serverTimeMs: Date.now() })
            return
          }
          throw e
        }
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/config-bundle/plan',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const plan = planImport({
            bundle: body.bundle,
            existingProfiles: modelStore.list(),
            existingBindings: bindingStore.list(),
            conflictPolicy: body.conflictPolicy ?? 'fail',
            actor: body.actor ?? null,
          })
          if (plan.ok !== false) {
            // 计划本身合法时，同时告诉调用方**能不能直接应用**——
            // 否则前端要自己重算一遍"有没有冲突/悬空引用"，而两份判定必然漂移。
            return { plan, applicable: assertApplicable(plan) }
          }
          return { plan, applicable: null }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/config-bundle/apply',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const validated = validateBundle(body.bundle)
          if (!validated.ok) {
            json(res, 400, {
              ok: false,
              code: BUNDLE_ERRORS.PROFILE_INVALID,
              error: `导入包不合法：${validated.errors.join('；')}`,
              errors: validated.errors,
              serverTimeMs: Date.now(),
            })
            return
          }
          const plan = planImport({
            bundle: body.bundle,
            existingProfiles: modelStore.list(),
            existingBindings: bindingStore.list(),
            conflictPolicy: body.conflictPolicy ?? 'fail',
            actor: body.actor ?? null,
          })
          const gate = assertApplicable(plan)
          if (gate.ok !== true) {
            // 冲突与悬空引用都是**"应用了会坏"**而不是"应用了会不完整"，
            // 所以拒绝而不是尽力而为。409 而不是 400：请求本身没写错，
            // 是当前状态不允许——调用方要做的是选一个冲突策略或先建档案。
            json(res, 409, {
              ok: false, code: gate.code, error: gate.reason,
              plan, serverTimeMs: Date.now(),
            })
            return
          }
          if (typeof body.actor !== 'string' || body.actor.trim() === '') {
            json(res, 400, {
              ok: false, code: BUNDLE_ERRORS.ACTOR_REQUIRED,
              error: '缺少 actor：导入会改变哪条任务用哪个模型，必须记下是谁做的',
              serverTimeMs: Date.now(),
            })
            return
          }

          const incomingProfiles = new Map(validated.value.profiles.map((p) => [p.id, p]))
          const incomingBindings = new Map(
            validated.value.bindings.map((b) => [`${b.scope}\u0000${b.employeeRole}`, b]))

          const written = { profiles: [], bindings: [] }
          for (const action of plan.actions) {
            if (action.action !== 'create' && action.action !== 'update') continue
            if (action.kind === 'profile') {
              const p = incomingProfiles.get(action.id)
              if (p === undefined) continue
              // `credentialRequired` 是导出附加字段，模型档案契约不认识它，写库前摘掉。
              const { credentialRequired, ...profileInput } = p
              if (action.action === 'create') {
                modelStore.create(profileInput, { actor: body.actor })
              } else {
                // CAS：用计划里读到的那个版本，不用"现在最新"的版本。
                // 中间被别人改过就应当冲突失败，而不是把别人的改动盖掉。
                modelStore.update(action.id, profileInput, { actor: body.actor, version: action.currentVersion })
              }
              written.profiles.push({ id: action.id, action: action.action, credentialRequired: credentialRequired === true })
            } else {
              const b = incomingBindings.get(action.id.replace('/', '\u0000'))
              if (b === undefined) continue
              bindingStore.upsert({
                scope: b.scope,
                employeeRole: b.employeeRole,
                primaryProfile: b.primaryProfile,
                fallbackProfiles: b.fallbackProfiles,
                perRunBudget: b.perRunBudget,
              }, { actor: body.actor })
              written.bindings.push({ id: action.id, action: action.action })
            }
          }

          return {
            applied: true,
            written,
            // 导入方要知道**还得去密钥库补哪些引用**：导出包里没有引用名，
            // 所以这些档案导入后是"需要凭证但没有引用"的状态。
            // 不说清楚的话，用户会以为导入完就能跑，然后第一次运行才失败。
            needsCredential: written.profiles.filter((p) => p.credentialRequired).map((p) => p.id),
            // 策略 `keep` 下"包里有、但因为内容不同而没进去"的条数。
            // 单独报出来是因为 `keep` 会把冲突转成 `skip`，于是
            // `conflicts` 变成 0——只报 `conflicts` 会让回执看起来是成功的，
            // 而包里那些改动一处都没进去。
            keptLocal: plan.summary.keptLocal,
          }
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
    id: 'config-bundle',
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

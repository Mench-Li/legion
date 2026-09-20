// team-hub/routes/model-profiles.mjs
// ============================================================================
// 路由层第 13 族：**模型档案（spec §6.6）** —— PRT-316 切片 13
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 13 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 4c31df5:team-hub/server.mjs` 的 `/api/model-profiles` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 7 条的形态分布（生成器算的，不是抄的）
//
//   ×  2  `path === '…'`
//   ×  4  `path.startsWith('…')`
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
// 7 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 8 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 模型档案（PRT-501，spec §6.6） ──
//
// 这些路由**不接受**任何密钥字段：`validateProfile` 会拒绝未知字段与明文
// 密钥形态（含 endpoint 内嵌凭证）。API 层不重复校验——重复的后果不是
// 多一道防线，而是两处判据会漂移，而漂移的那一次就是把密钥写进库的那一次。
//
// `actor` 必填：谁改的模型配置必须留痕。审计里**只有** provider/model/
// 字段名清单/「引用变了没有」，没有任何值——包括引用名本身。


/**
 * 造模型档案（spec §6.6）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createModelProfilesRoutes({
  json,
  handleRun, modelStore, probeService,
  MODEL_ERRORS,
}) {
  const deps = { json,
    handleRun, modelStore, probeService,
    MODEL_ERRORS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createModelProfilesRoutes 缺注入项：${k}`)
  }

  // ── 块前言（切片 13）：原文里这几条路由**共用**这一段
  //
  //   `server.mjs` 原文把它们裹在一个裸块里；块内声明的共享局部：
  //     MODEL_PREFIX、modelId
  //   包住本族 5/7 条路由。
  //
  //   ★ 它逐字引用 `path` —— 原文里那是 `handle()` 的局部。所以这里把它
  //   **包成接收 ctx 的函数**、按请求求值，而不是平铺进工厂体：
  //   平铺会 ReferenceError，而 `node --check` 看不见（语法完全合法）。
  //   前言与路由体都**逐字**未改，改的只是这一层生成的壳。
  const prologue = ({ path }) => {
    // `/api/model-profiles/<id>` 的三件事（读/改/删）。
    //
    // 写成 `req.method === '…' && path.startsWith('…')` 这个**同一行**的形态，
    // 不是风格洁癖：`scripts/prt/baseline-snapshot.mjs` 的抽取规则只认这一种
    // 与 `path === '…'`。把 method 判断嵌进块里（或改用正则 exec）会让这条
    // 路由对**契约基线不可见**，于是它能不经评审地增删——平台契约里少一条，
    // 而没有任何门禁会说话。
    const MODEL_PREFIX = '/api/model-profiles/'
    // 解 id；不是合法编码时回 null，空串时回 ''
    const modelId = () => {
      try {
        return decodeURIComponent(path.slice(MODEL_PREFIX.length))
      } catch {
        return null
      }
    }
    return { MODEL_PREFIX, modelId }
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-profiles',
      async run(req, res, { url }) {
        // 默认只给未删除的。要连墓碑一起看必须显式 `?includeDeleted=1`：
        // 默认带上会让界面上出现"已经被删掉的模型"，而它其实选不了。
        const includeDeleted = url.searchParams.get('includeDeleted') === '1'
        json(res, 200, {
          ok: true,
          profiles: modelStore.list({ includeDeleted }),
          serverTimeMs: Date.now(),
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/model-profiles',
      async run(req, res) {
        await handleRun(req, res, (body) => modelStore.create(body.profile ?? body, { actor: body.actor }))
      },
    },
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: '/api/model-profiles/',
      suffix: '/probe',
      async run(req, res, { path }) {
          const rawId = path.slice('/api/model-profiles/'.length, path.length - '/probe'.length)
          if (rawId === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
          let probeId
          try {
            probeId = decodeURIComponent(rawId)
          } catch {
            json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
          }
          if (probeId.includes('/')) {
            // 多段路径不是 id：明确拒绝，不去猜用户想要哪一个档案。
            json(res, 400, { ok: false, error: '模型档案 id 不能包含斜杠', code: 'BAD_ID_ENCODING' }); return
          }
          await handleRun(req, res, async (body) => {
            const profile = modelStore.get(probeId)
            if (profile === null) {
              const hist = modelStore.resolveForHistory(probeId)
              if (hist !== null) {
                const err = new Error('模型档案 ' + probeId + ' 已被删除')
                err.statusCode = 409
                err.code = MODEL_ERRORS.PROFILE_DELETED
                throw err
              }
              const err = new Error('没有这个模型档案：' + probeId)
              err.statusCode = 404
              err.code = MODEL_ERRORS.PROFILE_NOT_FOUND
              throw err
            }
            // force 默认为 **true**：这是用户主动按下的按钮。
            // 按钮按下去若只回一个缓存里的旧结论，用户会以为“刚才那次点击验证了现在”。
            // 缓存的价值在于**自动**重复检查（后台巡检），不在于回应一次点击。
            const force = body.force !== false
            const requiredCapabilities = Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities : []
            const verdict = await probeService().probeModelProfile(profile, { requiredCapabilities, force })
            // 「没探测过」用 **503**：它不是客户端错误（用户没做错），也不是 200
            // （那会让前端把它当成一个判定）。503 = 现在没法提供这项服务。
            if (verdict.unavailable === true) {
              const err = new Error(verdict.message)
              err.statusCode = 503
              err.code = verdict.code
              throw err
            }
            return { probe: verdict, profileId: probeId }
          })
      },
    },
    {
      method: 'GET',
      match: 'prefix',
      path: '/api/model-profiles/',
      async run(req, res, { modelId }) {
          const id = modelId()
          if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
          if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
          const p = modelStore.get(id)
          if (p === null) {
            // 墓碑与"从没存在过"分开报：混成一个 404 会让
            // 「删掉再用同名建」看起来像一次干净的首次创建。
            const hist = modelStore.resolveForHistory(id)
            if (hist !== null) {
              json(res, 409, {
                ok: false, code: MODEL_ERRORS.PROFILE_DELETED,
                error: `模型档案 ${id} 已被删除`,
                deletedAtMs: hist.deletedAtMs, serverTimeMs: Date.now(),
              })
              return
            }
            json(res, 404, { ok: false, code: MODEL_ERRORS.PROFILE_NOT_FOUND, error: `没有这个模型档案：${id}` })
            return
          }
          json(res, 200, { ok: true, profile: p, serverTimeMs: Date.now() })
      },
    },
    {
      method: 'PATCH',
      match: 'prefix',
      path: '/api/model-profiles/',
      async run(req, res, { modelId }) {
          const id = modelId()
          if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
          if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
          await handleRun(req, res, (body) =>
            modelStore.update(id, body.profile ?? body, { actor: body.actor, version: body.version }))
      },
    },
    {
      method: 'PUT',
      match: 'prefix',
      path: '/api/model-profiles/',
      async run(req, res, { modelId }) {
          const id = modelId()
          if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
          if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
          await handleRun(req, res, (body) =>
            modelStore.update(id, body.profile ?? body, { actor: body.actor, version: body.version }))
      },
    },
    {
      method: 'DELETE',
      match: 'prefix',
      path: '/api/model-profiles/',
      async run(req, res, { modelId }) {
          const id = modelId()
          if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
          if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
          await handleRun(req, res, (body) => modelStore.remove(id, { actor: body.actor, version: body.version }))
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
    id: 'model-profiles',
    routes,
    /** 7 条；顺序与 `handle` 里原来那 7 条 `if` 相同。 */
    async dispatch(req, res, ctx) {
      const pro = prologue(ctx)
      const full = { ...ctx, ...pro }
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, full)
        return true
      }
      return false
    },
  }
}

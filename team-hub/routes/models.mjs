// team-hub/routes/models.mjs
// ============================================================================
// 路由层第 25 族：**智能体默认模型配置（按空间×角色读一版 / 配一个 / 清一个）** —— PRT-316 切片 26
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 25 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show f889921:team-hub/server.mjs` 的 `/api/models` 段落。
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
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// 智能体默认模型配置


/**
 * 造智能体默认模型配置（按空间×角色读一版 / 配一个 / 清一个）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createModelsRoutes({
  json,
  db, audit, now,
  modelStore, validateAgentModelSelection, modelConfigErrorFor,
  handleWrite,
}) {
  const deps = { json,
    db, audit, now,
    modelStore, validateAgentModelSelection, modelConfigErrorFor,
    handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createModelsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/models',
      async run(req, res, { url }) {
        const scopeParam = url.searchParams.get('scope') ?? undefined
        const rows = scopeParam
          ? db.prepare('SELECT scope, role, provider, model FROM agent_models WHERE scope = ?').all(scopeParam)
          : db.prepare('SELECT scope, role, provider, model FROM agent_models').all()
        json(res, 200, rows)
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/models',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const role = typeof body.role === 'string' ? body.role.trim() : ''
          if (!role) throw new Error('缺少参数 role')
          const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
          const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          if (!provider || !model) throw new Error('缺少 provider 或 model')
          // 产品化校验（PRT-252）：**配置错误必须在配置的那一刻、用用户能看懂的话说出来**。
          // 校验不过 → 400 + 结构化字段（code/field/hint/candidates），前端据此落到具体输入框。
          //
          // 顺带说明为什么这里**不**降级成"只警告"：写出一个跑不起来的绑定，
          // 代价是用户在一次真实运行失败之后才回头怀疑配置；而拒绝的代价
          // 只是他改一下下拉框。两者不对称，所以拒绝。
          const verdict = validateAgentModelSelection({ provider, model, profiles: modelStore.list() })
          if (verdict.ok !== true) throw modelConfigErrorFor(verdict)
          db.prepare('INSERT INTO agent_models (scope, role, provider, model, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, role) DO UPDATE SET provider=excluded.provider, model=excluded.model, updatedAt=excluded.updatedAt')
            .run(targetScope, role, provider, model, now())
          audit(by, targetScope, 'model:set', null, { role, provider, model })
          return { scope: targetScope, role, provider, model }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/models/clear',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const role = typeof body.role === 'string' ? body.role.trim() : ''
          if (!role) throw new Error('缺少参数 role')
          const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
          db.prepare('DELETE FROM agent_models WHERE scope = ? AND role = ?').run(targetScope, role)
          audit(by, targetScope, 'model:clear', null, { role })
          return { scope: targetScope, role }
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
    id: 'models',
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

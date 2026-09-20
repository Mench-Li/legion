// team-hub/routes/model-bindings-by-path.mjs
// ============================================================================
// 路由层第 34 族：**岗位模型绑定（GET 读一个绑定 / DELETE 删一个绑定）** —— PRT-316 切片 36
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 34 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show df9902c:team-hub/server.mjs` 的 `/api/model-bindings/` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 2 条的形态分布（生成器算的，不是抄的）
//
//   ×  0  `path === '…'`
//   ×  2  `path.startsWith('…')`
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
// 2 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造岗位模型绑定（GET 读一个绑定 / DELETE 删一个绑定）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createModelBindingsByPathRoutes({
  json,
  bindingStore, handleRun, BINDING_STORE_ERRORS,
}) {
  const deps = { json,
    bindingStore, handleRun, BINDING_STORE_ERRORS,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createModelBindingsByPathRoutes 缺注入项：${k}`)
  }

  // ── 块前言（切片 13）：原文里这几条路由**共用**这一段
  //
  //   `server.mjs` 原文把它们裹在一个裸块里；块内声明的共享局部：
  //     BINDING_PREFIX、parts
  //   包住本族 2/2 条路由。
  //
  //   ★ 它逐字引用 `path` —— 原文里那是 `handle()` 的局部。所以这里把它
  //   **包成接收 ctx 的函数**、按请求求值，而不是平铺进工厂体：
  //   平铺会 ReferenceError，而 `node --check` 看不见（语法完全合法）。
  //   前言与路由体都**逐字**未改，改的只是这一层生成的壳。
  const prologue = ({ path }) => {
    const BINDING_PREFIX = '/api/model-bindings/'
    const parts = () => {
      // `/api/model-bindings/<scope>/<role>`：两段都允许被百分号编码，
      // 各自单独解码（整段解码会把 scope 里的 `/` 也解出来，于是切错位置）。
      const raw = path.slice(BINDING_PREFIX.length)
      const segs = raw.split('/')
      if (segs.length !== 2) return null
      try {
        return [decodeURIComponent(segs[0]), decodeURIComponent(segs[1])]
      } catch {
        return 'BAD_ENCODING'
      }
    }
    return { BINDING_PREFIX, parts }
  }

  const routes = [
    {
      method: 'GET',
      match: 'prefix',
      path: '/api/model-bindings/',
      async run(req, res, { parts }) {
          const segs = parts()
          if (segs === 'BAD_ENCODING') { json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: '绑定路径不是合法的 URL 编码' }); return }
          if (segs === null) { json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/model-bindings/<scope>/<role>' }); return }
          const b = bindingStore.get(segs[0], segs[1])
          if (b === null) {
            json(res, 404, { ok: false, code: BINDING_STORE_ERRORS.BINDING_NOT_FOUND, error: `没有这个岗位绑定：${segs[0]}/${segs[1]}` })
            return
          }
          json(res, 200, { ok: true, binding: b, serverTimeMs: Date.now() })
      },
    },
    {
      method: 'DELETE',
      match: 'prefix',
      path: '/api/model-bindings/',
      async run(req, res, { parts }) {
          const segs = parts()
          if (segs === 'BAD_ENCODING') { json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: '绑定路径不是合法的 URL 编码' }); return }
          if (segs === null) { json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/model-bindings/<scope>/<role>' }); return }
          await handleRun(req, res, (body) => bindingStore.remove(segs[0], segs[1], { actor: body.actor }))
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
    id: 'model-bindings-by-path',
    routes,
    /** 2 条；顺序与 `handle` 里原来那 2 条 `if` 相同。 */
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

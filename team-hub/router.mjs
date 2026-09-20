// team-hub/router.mjs
// ============================================================================
// 路由层的**缝** —— PRT-316 第一片的一半
//
// ## 为什么先立缝，而不是先搬最大的一族
//
// `team-hub/server.mjs` 里 `handle()` 是**一个 4222 行的函数**（L4927-9148），
// 193 条路由条件全在它里面。PRT-316 要的是把这个路由层**提取出来**，
// 而理由在 `docs/PRT-212-evidence/verify-evidence.md:122` 逐字写着：
//
//   > 真实审批箱接线 —— 需要 PRT-316 先把 team-hub 的**路由层**提取出来；
//   > 现在直连会把新代码**焊死在 `server.mjs`** 上。
//
// 所以这一片的交付物**不是**"少了两条路由"，而是**这个文件**：
// 一族路由可以住在自己的模块里、由 `server.mjs` 注入依赖，
// 并把"这个请求归我管"作为一个**布尔值**回给它。
//
//   > 一个"把路由搬走一半"的提取，与一个"给路由留下一个能搬进去的家"的提取，
//   > 在没有下一族路由要接的时候是同一个东西——
//   > 只不过前者在第二族路由到来时，会再抄一遍同一套 if 链。
//
// ## 语义上与原来的 if 链**逐条等价**（不是"差不多"）
//
// `handle` 里的形状是：`if (方法 === X && path === Y) { …; return }`。
// 本模块 `dispatch()` 的顺序语义与之一一对应：
//
//   ① 按 `families` 的**注册顺序**、族内按 `routes` 的**声明顺序**匹配；
//   ② 命中即 `await run(...)`，然后返回 `true`（调用方据此 `return`）；
//   ③ 一律不命中返回 `false`（调用方继续往下走既有的 if 链）。
//
// ★ 三条都是**需要**的，不是风格：同一条路径上 GET 与 POST 的顺序、
//   以及"命中之后还能不能落到后面的路由"，都是可观测行为。
//   把 ③ 写成"抛错"会让一个未知路径从 404 变成 500。
//
// ## 这一片**不碰**什么
//
// 不建任何连接、不读任何配置、不碰 db —— 全部由调用方注入。
// 与 `run-store.mjs` 的立场相同（那边第 25-27 行：「本模块不自建连接：
// db 由调用方注入」）。
// ============================================================================

/**
 * 把若干**路由族**合成一个可派发的路由层。
 *
 * @param {Array<{id: string, routes: Array, dispatch: Function}>} families
 *   路由族。每个族由自己的模块（如 `./routes/rules.mjs`）造出来，
 *   依赖由调用方注入；本模块不认识任何具体族。
 * @returns {{families: Array, list: Array, dispatch: Function}}
 */
export function createRouter(families) {
  if (!Array.isArray(families)) throw new TypeError('createRouter 需要一族路由的数组')

  const seen = new Set()
  for (const f of families) {
    if (f === null || typeof f !== 'object') throw new TypeError('路由族必须是对象')
    if (typeof f.id !== 'string' || f.id.length === 0) throw new TypeError('路由族需要一个非空字符串 id')
    if (typeof f.dispatch !== 'function') throw new TypeError(`路由族 ${f.id} 缺 dispatch()`)
    if (seen.has(f.id)) throw new Error(`路由族 id 重复：${f.id}`)
    seen.add(f.id)
  }

  // `list` 是**只读的汇总**，给判据用（"哪些方法+路径归路由层管"）。
  // 它不参与派发 —— 派发一律走各族的 dispatch，免得两处各有一套匹配规则。
  const list = families.flatMap((f) => (Array.isArray(f.routes) ? f.routes : [])
    .map((r) => Object.freeze({ family: f.id, method: r.method, path: r.path })))

  return {
    families,
    list,
    /**
     * @returns {Promise<boolean>} 是否已由路由层应答（true ⇒ 调用方必须 return）
     */
    async dispatch(req, res, ctx) {
      for (const f of families) {
        // 逐族问"归你管吗"：族自己知道自己的匹配规则（等值 / 前缀 / 别的），
        // 本模块**不**替它猜。一条路径前缀路由（如 `/api/permissions/rules/<id>`）
        // 用等值表表达不出来，硬套就会在下一族身上出问题。
        if (await f.dispatch(req, res, ctx)) return true
      }
      return false
    },
  }
}

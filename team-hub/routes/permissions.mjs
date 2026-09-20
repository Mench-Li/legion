// team-hub/routes/permissions.mjs
// ============================================================================
// 路由层第二族：**权限治理 / 审批箱（F-02）** —— PRT-316 切片 2
//
// 缝在 `team-hub/router.mjs`（切片 1 立的），本文件是搬进那个家的第二族。
//
// ## 为什么第二族挑它，而不是挑"更小的那个"
//
// 因为这一族正是 PRT-316 **存在的原因**。`docs/PRT-212-evidence/verify-evidence.md:122`
// 逐字写着：
//
//   > 真实审批箱接线 —— 需要 PRT-316 先把 team-hub 的**路由层**提取出来；
//   > 现在直连会把新代码**焊死在 `server.mjs`** 上。
//
// 而「审批箱」的读写两端就是本族的 `GET /api/permissions/inbox` 与
// `POST /api/permissions/decide`。挑更小的一族只是少搬几行；
// 挑这一族才让 PRT-212 下一步有地方落脚。
//
// ## 判据同样**不用新写**：既有两个套件按真实 HTTP 打这一族
//
// - `team-hub/approval-port.test.mjs`（23 例，真 `fetch` + `listen(0)`）——
//   四个端点全打：`check` / `inbox` / `decide` / `rules`；
// - `team-hub/approval-registrar-row.test.mjs`（6 例）—— `check` + `inbox`。
//
// ⚠️ **`team-hub/permissions.test.mjs` 不能当本片的判据**：它 `import('./server.mjs')`
// 之后**直接调 DAO**（`mod.upsertPermissionRule(...)`），全文没有一处
// `/api/permissions` 字符串。也就是说它测的是域逻辑，**路由接线错了它照样绿**。
//
//   > 一个"直接调 DAO"的套件，与一个"打 HTTP 端点"的套件，在同一批函数上
//   > 可以都是绿的——只不过前者对"这条路由还在不在"一个字都没说。
//
// ## 逐字保留：**零注入改写**
//
// 五条路由的函数体与 `server.mjs` 原文（切片 1 之后的 L8223-8248）逐字节相同
// （仅缩进不同）。`json` / `handleWrite` / `authorized` / `readBody` / `requireMember` /
// `listPermissionInbox` / `decidePermission` / `upsertPermissionRule` /
// `deletePermissionRule` 以及 `url`、`path` 全部从注入参数或 `ctx` 到达**同名**绑定。
//
// ## 一条前缀路由，正好验了缝的设计
//
// 第 5 条是 `path.startsWith('/api/permissions/rules/')`（带 id 的删除），
// 而第 4 条是 `path === '/api/permissions/rules'`（等值）。两者只差一个尾斜杠。
// 这正是 `router.mjs` 让**每一族自己**判"归不归我管"、而不是由缝替它猜匹配规则的理由：
//
//   > 一张"方法+路径"的等值表，与一张能表达前缀的表，在只有等值路由的那些天里
//   > 是同一个东西——只不过前者遇到第一条带 id 的路由时，会静默地一条也不匹配。
// ============================================================================

/**
 * 造权限治理 / 审批箱族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入（本模块不 import 任何 hub 内部件）
 * @param {Function} deps.json
 * @param {Function} deps.handleWrite
 * @param {Function} deps.authorized
 * @param {Function} deps.readBody
 * @param {Function} deps.requireMember
 * @param {Function} deps.listPermissionInbox
 * @param {Function} deps.decidePermission
 * @param {Function} deps.checkPermission
 * @param {Function} deps.upsertPermissionRule
 * @param {Function} deps.deletePermissionRule
 */
export function createPermissionsRoutes({
  json, handleWrite, authorized, readBody, requireMember,
  listPermissionInbox, decidePermission, checkPermission,
  upsertPermissionRule, deletePermissionRule,
}) {
  const deps = {
    json, handleWrite, authorized, readBody, requireMember,
    listPermissionInbox, decidePermission, checkPermission,
    upsertPermissionRule, deletePermissionRule,
  }
  for (const [name, fn] of Object.entries(deps)) {
    if (typeof fn !== 'function') throw new TypeError(`createPermissionsRoutes 缺注入项：${name}`)
  }

  // ── 权限治理（F-02）：策略、检查与审批箱 ──
  const routes = [
    {
      method: 'POST',
      path: '/api/permissions/check',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => checkPermission({ ...body, actor: body.actor ?? by }))
      },
    },
    {
      method: 'GET',
      path: '/api/permissions/inbox',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        json(res, 200, { ok: true, requests: listPermissionInbox(url.searchParams.get('scope') || null) })
      },
    },
    {
      method: 'POST',
      path: '/api/permissions/decide',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => decidePermission({ ...body, by }))
      },
    },
    {
      method: 'POST',
      path: '/api/permissions/rules',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => upsertPermissionRule({ ...body, by }))
      },
    },
    {
      method: 'DELETE',
      path: '/api/permissions/rules/',
      // ★ 前缀路由：`ctx.path.startsWith('/api/permissions/rules/')`。
      //   声明里那个路径**带尾斜杠**，与"4 号那条等值路由"因此不会互相遮蔽。
      prefix: true,
      async run(req, res, { path }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const body = await readBody(req)
        const by = requireMember(body)
        try { json(res, 200, { ok: true, rule: deletePermissionRule(path.slice('/api/permissions/rules/'.length), by) }) }
        catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }) }
      },
    },
  ]

  return {
    id: 'permissions',
    routes,
    /**
     * 前四条等值、最后一条前缀；顺序与 `handle` 里原来那五条 `if` 相同。
     */
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method) continue
        if (r.prefix === true ? !ctx.path.startsWith(r.path) : ctx.path !== r.path) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

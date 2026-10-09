// team-hub/routes/model-providers.mjs
// ============================================================================
// 路由族：**模型供应商目录**（docs/DECISION-legion-owns-model-config.md 的 P1）
//
// 两条路由，各自对应 P1 的一半：
//
//   `GET  /api/model-providers`          只读：Legion 侧现在认为的供应商目录
//   `POST /api/model-providers/import`   写入：把一份快照收进来（幂等、不删除）
//
// ## 为什么导入是一个**具名端点**，而不是"启动时顺手同步"
//
// 方向是单向的：Legion 是真相、DSH 是派生物（DECISION §3）。
// 因此 `DSH → Legion` 这条路只允许出现在两个地方：**一次性导入**与**影子对账**。
// 如果让守护每轮都拿 DSH 的现状覆盖 Legion，那么"有人手改了 DSH"就会静默变成
// "Legion 也跟着改了"——那时 Legion 就不再是真相，而**没有任何读数会说话**。
//
// 所以这个端点必须被**显式**调用；调用方（legion-services 的引导导入）只在
// 目录为空时调一次，见 `services-plugin/index.js` 的 `maybeBootstrapProviderImport`。
//
// ## 幂等的读数是接口的一部分
//
// 响应里 `created` / `updated` / `unchanged` 三个数就是 P1 的验收读数：
// 同一份快照导入两次，第二次必须是 `created=0 updated=0 unchanged=N`。
// 把这三个数**返回**而不是只写日志，是为了让判据能直接断言它，
// 而不是去读日志里的一句话。
//
// ## GET 的鉴权：与本仓既有读路径一致（不要求令牌）
//
// 与同目录的 `/api/model-profiles` GET 同一口径：读路径在 `handleRun` 之外、
// 不校验 Bearer。这一条**是有意的**，不是遗漏——写路径全部走 `handleRun`（要令牌），
// 而 hub 部署本身可以用 `TEAM_HUB_TOKEN` 关掉鉴权（本机单机部署就是关的）。
// 若哪一天要收紧，应当**整族一起收**（读也一样），而不是只给这一族加。
// ============================================================================

/**
 * @param json         写 JSON 响应的注入件（属于 server.mjs）
 * @param handleRun    带鉴权与错误映射的写包装（属于 server.mjs）
 * @param providerStore `createProviderStore(...)` 的返回值
 */
export function createModelProvidersRoutes({ json, handleRun, providerStore }) {
  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-providers',
      async run(req, res) {
        json(res, 200, { ok: true, providers: providerStore.list(), empty: providerStore.isEmpty() })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/model-providers/import',
      async run(req, res) {
        await handleRun(req, res, (body) => providerStore.importSnapshot(body.providers ?? [], {
          actor: body.actor, source: body.source ?? 'dsh-import',
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
    id: 'model-providers',
    routes,
    /** 2 条。 */
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

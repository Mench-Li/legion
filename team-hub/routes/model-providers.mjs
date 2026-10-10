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

import { ModelError, MODEL_ERRORS } from '../model-store.mjs'

/**
 * @param json         写 JSON 响应的注入件（属于 server.mjs）
 * @param handleRun    带鉴权与错误映射的写包装（属于 server.mjs）
 * @param providerStore `createProviderStore(...)` 的返回值
 * @param discoverModels `({baseURL, apiKey}) => Promise<string[]>`（可注入；见 `discoverProviderModels`）
 */
export function createModelProvidersRoutes({ json, handleRun, providerStore, discoverModels = discoverProviderModels }) {
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
      path: '/api/model-providers',
      async run(req, res) {
        // 建一条：面板的"保存"。`source` 固定为 `legion`（**用户表达意图**），
        // 不接受调用方指定成 `dsh-import` —— 那会把"我建的"伪装成"从 DSH 抄来的"。
        //
        // ★ 同名墓碑会**复活**（不是 409）：删掉一个从 DSH 导入的供应商、再加回来，
        //   是用户的正常动作；拒绝只会逼他发明 `xxx-1` 这种与 DSH 配置 id 不一致的别名。
        //   响应里带 `revived`，好让面板说"已恢复"而不是"已创建"。
        await handleRun(req, res, (body) => {
          const r = providerStore.create(body.provider ?? body, { actor: body.actor })
          return { ...r.provider, revived: r.revived }
        })
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
    {
      method: 'POST',
      match: 'exact',
      path: '/api/model-providers/discover',
      async run(req, res) {
        // 读供应商的模型目录。**与 DSH 无关**：Legion 自己按 OpenAI 兼容约定去问一次，
        // 于是"自动读取模型列表"这个能力不再需要绕道 DSH 的 `llm/discoverModels`。
        await handleRun(req, res, async (body) => {
          const ids = await discoverModels({
            baseURL: body.baseURL, apiKey: body.apiKey ?? null, fetchImpl: fetch,
          })
          return { models: ids.map((id) => ({ id })) }
        })
      },
    },
    // ★ 下面两条必须排在 `/discover` 之后（它也是 prefix 下的路径，顺序反了会被当成 id="discover"）。
    {
      method: 'POST',
      match: 'prefix',
      path: '/api/model-providers/',
      async run(req, res, { path }) {
        const id = decodeURIComponent(path.slice('/api/model-providers/'.length))
        if (id === '') { json(res, 400, { ok: false, error: '缺少供应商 id', code: 'MISSING_PARAM' }); return }
        await handleRun(req, res, (body) => providerStore.update(id, body.provider ?? body, { actor: body.actor, version: body.version }))
      },
    },
    {
      method: 'DELETE',
      match: 'prefix',
      path: '/api/model-providers/',
      async run(req, res, { path }) {
        const id = decodeURIComponent(path.slice('/api/model-providers/'.length))
        if (id === '') { json(res, 400, { ok: false, error: '缺少供应商 id', code: 'MISSING_PARAM' }); return }
        await handleRun(req, res, (body) => providerStore.remove(id, { actor: body.actor, version: body.version }))
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
    /** 6 条；顺序与上面一致（`/discover` 在前，通配 id 在后）。 */
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

/**
 * 按 **OpenAI 兼容约定**读一次模型目录：`GET {baseURL}/models`，带 `Authorization: Bearer <key>`。
 *
 * 为什么不复用 DSH 的 `llm/discoverModels`：那是引擎的能力，
 * 而"用户在这一页点一下读取列表"是**Legion 自己的功能** —— 绕道引擎就又把产品表面接回引擎了
 * （这正是 BUG-014 两版修错的地方）。
 *
 * 三条纪律：
 *   · 只认 `http(s)`，且**不允许内嵌账号密码**（与 `provider-store` 的 baseURL 校验同口径）；
 *   · 超时 8 秒（供应商不回话时不许把请求挂住）；
 *   · 非 2xx 或形状不对 ⇒ **具名报错**，不返回空数组 ——
 *     "它没返回模型"与"我没问成"在界面上是同一种空白，而修法完全不同。
 */
export async function discoverProviderModels({ baseURL, apiKey = null, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, '读取模型目录需要 API 地址', { statusCode: 400 })
  }
  let url
  try { url = new URL(baseURL.trim()) } catch {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, `API 地址不是合法 URL：${baseURL.slice(0, 120)}`, { statusCode: 400 })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, 'API 地址只能是 http(s)', { statusCode: 400 })
  }
  if (url.username || url.password) {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, 'API 地址不能内嵌账号密码', { statusCode: 400 })
  }
  const target = `${url.origin}${url.pathname.replace(/\/+$/, '')}/models`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(target, {
      method: 'GET',
      headers: { accept: 'application/json', ...(typeof apiKey === 'string' && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE,
      `读模型目录失败：连不上 ${url.host}（${e instanceof Error ? e.message : String(e)}）`, { statusCode: 502 })
  } finally { clearTimeout(timer) }

  if (!res.ok) {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE,
      `读模型目录失败：${url.host} 返回 HTTP ${res.status}`, { statusCode: 502 })
  }
  let body = null
  try { body = JSON.parse(await res.text()) } catch {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE,
      `读模型目录失败：${url.host} 的响应不是 JSON（可能不是 OpenAI 兼容接口）`, { statusCode: 502 })
  }
  const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : null)
  if (list === null) {
    throw new ModelError(MODEL_ERRORS.INVALID_PROFILE,
      `读模型目录失败：${url.host} 的响应里没有 data/models 数组`, { statusCode: 502 })
  }
  return [...new Set(list.map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string' && id !== ''))]
}

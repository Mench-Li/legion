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
import { describeDerivation, matchProviderModels, planProfileDerivation } from '../profile-derivation.mjs'
import { profileIdFor } from '../model-migration.mjs'

/**
 * @param json         写 JSON 响应的注入件（属于 server.mjs）
 * @param handleRun    带鉴权与错误映射的写包装（属于 server.mjs）
 * @param providerStore `createProviderStore(...)` 的返回值
 * @param discoverModels `({baseURL, apiKey}) => Promise<string[]>`（可注入；见 `discoverProviderModels`）
 */
export function createModelProvidersRoutes({
  json, handleRun, providerStore, discoverModels = discoverProviderModels,
  // ★ 真实凭证核验（BUG-023 的收敛）：`credentialStatus` 由 server.mjs 注入
  //   （它问的是**本机密钥库**，不是 `credential_configured` 那个从 DSH 导入的标记）。
  //   省略时行为与从前逐字相同（响应里没有 `credential` 字段）——但那会让面板
  //   重新有资格说"已配置凭证"。
  credentialStatus = null,
  // ★ 从供应商派生档案（"我还有必要新建档案嘛"）：需要读档案表以判断
  //   "哪些模型还没有档案"。省略时那一列不出现、派生端点回 503（**不猜**）。
  modelStore = null,
}) {
  /** 读一次档案表（含墓碑：id 占用判定要用）。读不出来 ⇒ null（**不是**空表）。 */
  const profilesSnapshot = () => {
    if (modelStore === null || typeof modelStore.list !== 'function') return null
    try { return modelStore.list({ includeDeleted: true }) } catch { return null }
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-providers',
      async run(req, res) {
        const providers = providerStore.list()
        // ★ 一次列表只问密钥库**一遍**（20 个供应商不该产生 20 次 DPAPI 打开）。
        let snapshot = null
        if (credentialStatus !== null && typeof credentialStatus.snapshot === 'function') {
          snapshot = await credentialStatus.snapshot()
        }
        // 档案对账也**只读一遍**，然后每个供应商各算各的。
        // 读不出来时**不给这一列**：一个"还有 0 个模型没有档案"的读数会让用户
        // 以为都已经建好了，而真相是我们没读到档案表。
        const profiles = profilesSnapshot()
        // `credential` 是**核验结果**；`credentialConfigured` 保留原样（它是 P1 导入的标记，
        // 别的消费者还在用）。界面必须读前者 —— 两者在"钥匙其实不在库里"时说的不是一回事。
        const enriched = providers.map((p) => {
          const out = { ...p }
          if (snapshot !== null) out.credential = snapshot.of(p.secretRef)
          if (profiles !== null) {
            const m = matchProviderModels({ provider: p, profiles })
            out.profiles = Object.freeze({ existing: m.existing.length, missing: m.missing.length, orphaned: m.orphaned.length })
          }
          return out
        })
        json(res, 200, { ok: true, providers: enriched, empty: providerStore.isEmpty() })
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
    // ★★ 从供应商派生模型档案（"我还有必要新建档案嘛，直接来源于模型与供应商才对啊"）。
    //
    // 为什么是一个**具名端点**而不是"保存供应商时顺手建"：与 `/import` 同一条理由 ——
    // 供应商该不该自动长出一堆档案，是一次**用户的决定**，不是一个副作用。
    // 顺手的后果是"我改了一下模型的显示名，怎么多了三条档案"，而没有任何读数说话。
    //
    // ★ 位置：必须排在下面那批通配 `prefix` 之前 —— 否则
    //   `/api/model-providers/fjd-ds/derive-profiles` 会被当成 id=`fjd-ds/derive-profiles`
    //   去 update，然后以一个方向完全错误的 404/409 结束（`/discover` 踩过同一个坑）。
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: '/api/model-providers/',
      suffix: '/derive-profiles',
      async run(req, res, { path }) {
        const raw = path.slice('/api/model-providers/'.length, path.length - '/derive-profiles'.length)
        let id = null
        try { id = decodeURIComponent(raw) } catch {
          json(res, 400, { ok: false, error: '供应商 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
        }
        if (id === '') { json(res, 400, { ok: false, error: '缺少供应商 id', code: 'MISSING_PARAM' }); return }
        if (id.includes('/')) { json(res, 400, { ok: false, error: '供应商 id 不能包含斜杠', code: 'BAD_ID_ENCODING' }); return }
        await handleRun(req, res, async (body) => {
          if (modelStore === null) {
            const err = new Error('这个中枢没有接档案表，因此无法派生模型档案（**什么都没改**）。')
            err.statusCode = 503
            err.code = 'DERIVE_UNAVAILABLE'
            throw err
          }
          const provider = providerStore.get(id)
          if (provider === null) {
            const err = new Error('没有这个模型供应商：' + id)
            err.statusCode = 404
            err.code = MODEL_ERRORS.PROFILE_NOT_FOUND
            throw err
          }
          const profiles = modelStore.list({ includeDeleted: true })
          const plan = planProfileDerivation({
            provider, profiles, runtimeType: body.runtimeType, profileIdOf: profileIdFor,
          })
          if (plan.ok !== true) {
            // 「没算出计划」不能被表示成「建了 0 条」：那是两件不同的事。
            const err = new Error(plan.message)
            err.statusCode = 400
            err.code = plan.code
            throw err
          }
          // 只算不写（面板先展示"将要建 N 条"）——与 P3 物化同一套"先看计划再落笔"。
          if (body.dryRun === true) {
            return { dryRun: true, providerId: id, summary: describeDerivation(plan), plan }
          }
          const created = []
          const failed = []
          for (const input of plan.create) {
            try {
              modelStore.create(input, { actor: body.actor })
              created.push(input.id)
            } catch (e) {
              // 部分失败要**逐条记账**：一条撞了不该把已经建好的说成没建。
              failed.push({ id: input.id, code: e?.code ?? null, message: e?.message ?? String(e) })
            }
          }
          return {
            providerId: id,
            created,
            failed,
            existing: plan.existing.map((e) => e.profileId),
            conflicts: plan.conflicts,
            orphaned: plan.orphaned,
            // 读数按**实际写成的**算（`created` 是逐条 append 的），措辞仍走
            // `describeDerivation` —— 面板/日志/这里只有一份口径。
            summary: describeDerivation({
              ok: true, create: created, existing: plan.existing, conflicts: plan.conflicts, orphaned: plan.orphaned,
            }),
          }
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

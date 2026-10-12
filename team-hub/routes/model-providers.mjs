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
import { toProviderInput, resolveCredentialRef } from '../provider-store.mjs'
// `profileIdFor` 与判定同住一个模块（它 2026-10-12 从已拆除的 `model-migration.mjs` 搬来）。
import { describeDerivation, matchProviderModels, planProfileDerivation, profileIdFor, resolveRuntimeType } from '../profile-derivation.mjs'
import { SUPPORTED_RUNTIME_TYPES } from '../../runtime/contracts/model.mjs'

/**
 * 这次请求能不能读到**引用名**（BUG-028 的两读口径）。
 *
 * 默认**不能**（`wantRefs !== true` 时连判定都不做）；要读就必须通过传进来的
 * `authorized`（那个部署的机器令牌校验）。
 *
 * 为什么不是"读路径一律公开"：`GET /api/model-providers` **故意不校验令牌**
 * （见文件头那段：与同目录其它读路径同口径，单机部署根本没有令牌）。
 * 而引用名是"密钥库的槽位清单"—— 它不该因为"这一族是读路径"就跟着公开。
 * 于是这里做了本族此前没有的一件事：给一个参数**单独**要求鉴权。
 *
 *   > 一个"谁都能读、顺手也能读到槽位名"的读端点，
 *   > 与一个"谁都能读、但槽位名要令牌"的读端点，在**没设令牌的部署**上是同一个东西
 *   > —— 而那种部署本来就把整个中枢开放着，所以这不是新的泄漏面。
 *
 * 没给 `authorized`（老部署 / 别处直接构造）⇒ **拒绝**：无法证明调用方有权限时，
 * 默认给"没有名字"的那一份，而不是"反正大概没事"。
 *
 * 写成模块级导出函数而不是闭包里的私有件：它是一条**判定**，必须能在不起 hub 的
 * 情况下被逐种输入测到（见 `model-providers-routes.test.mjs` 的 ⑱ 那一组）。
 *
 * @returns {{ok: boolean, include: boolean, code?: string, message?: string}}
 */
export function mayReadSecretRefs({ wantRefs, authorized = null, req = null } = {}) {
  if (wantRefs !== true) return { ok: true, include: false }
  if (typeof authorized !== 'function') {
    return {
      ok: false, include: false, code: 'SECRET_REFS_REQUIRE_TOKEN',
      message: '这个部署没有可用的鉴权注入，因此不能读引用名（拒绝，而不是"大概没事"）',
    }
  }
  if (authorized(req) !== true) {
    return {
      ok: false, include: false, code: 'SECRET_REFS_REQUIRE_TOKEN',
      message: '读引用名需要令牌：那是密钥库的槽位清单，不是公开只读数据',
    }
  }
  return { ok: true, include: true }
}

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
  // ★★ 2026-10-12（BUG-028）：写凭证的**唯一**入口。
  //
  //   读侧不再返回引用名之后，客户端就**没有名字**能拿去调 `POST /api/secrets`
  //   （那正是要藏起来的东西）。于是"用户填的那把新密钥写进哪个槽位"由**服务端**决定：
  //   请求体带 `credentialValue`（明文值），服务端用那一行**已有的**引用名；
  //   它为空时用 `defaultSecretRefFor(id)`。
  //
  //   省略时（老部署）带 `credentialValue` 的请求被**具名拒掉**，而不是静默忽略 ——
  //   静默忽略的表现是"面板说保存成功、钥匙其实没写进去"，而那要到第一次跑模型才发现。
  secretAdmin = null,
  // ★★ 一个参数的**单独**鉴权（`?includeSecretRefs=1`）：见 `mayReadSecretRefs`。
  //   省略 ⇒ 那条参数被**具名拒绝**（403），而不是"没有 authorized 就放行"。
  authorized = null,
}) {
  /** 读一次档案表（含墓碑：id 占用判定要用）。读不出来 ⇒ null（**不是**空表）。 */
  const profilesSnapshot = () => {
    if (modelStore === null || typeof modelStore.list !== 'function') return null
    try { return modelStore.list({ includeDeleted: true }) } catch { return null }
  }

  /**
   * ★★ 一条供应商落库之后，**立刻**把它清单里的模型补成档案。
   *
   * 将军："档案必然由供应商与模型来，且**添加完自动生成**。"
   * 上一版把这件事做成了一个按钮 —— 那还是把机器已经知道的事交给用户点。
   *
   * ## 为什么落在**写路径之后**，而不是"保存供应商时顺手校验一下"
   *
   * 派生要读刚写下去的那一行（`runtimeType` 在它身上），所以顺序是
   * **先写供应商、再派生**。于是就有"供应商写成功、派生失败"这个中间态 ——
   * 它**不被隐藏**：返回值里带 `profilesDerived`（`ok` / `summary` / `code`），
   * 面板据此照实说，而不是让用户以为都好了。
   *
   *   > 一个"保存成功后安静地什么也没生成"的按钮，
   *   > 与一个"保存成功且生成完成"的按钮，在用户按下后的那一秒是同一个东西 ——
   *   > 只不过前者的差别要在第一次派工时才出现。
   *
   * @returns `{ok, summary, created?…}`；不可派生时 `ok:false` + `code` + `message`（**不抛**）
   */
  const deriveForProvider = (providerId, { actor, requestedRuntimeType = null } = {}) => {
    if (modelStore === null || typeof modelStore.list !== 'function') {
      return { ok: false, code: 'DERIVE_UNAVAILABLE', message: '这个中枢没有接档案表，因此没有自动生成模型档案（**什么都没改**）。' }
    }
    const provider = providerStore.get(providerId)
    if (provider === null) {
      return { ok: false, code: 'PROFILE_NOT_FOUND', message: `供应商 ${providerId} 不在目录里（刚删除？），因此没有生成档案。` }
    }
    const resolved = resolveRuntimeType({
      providerRuntimeType: provider.runtimeType,
      requested: requestedRuntimeType,
      supported: SUPPORTED_RUNTIME_TYPES,
    })
    if (resolved.ok !== true) return { ok: false, code: resolved.code, message: resolved.message }

    const profiles = modelStore.list({ includeDeleted: true })
    const plan = planProfileDerivation({
      provider, profiles, runtimeType: resolved.runtimeType, profileIdOf: profileIdFor,
    })
    if (plan.ok !== true) return { ok: false, code: plan.code, message: plan.message }

    const created = []
    const failed = []
    for (const input of plan.create) {
      try {
        modelStore.create(input, { actor })
        created.push(input.id)
      } catch (e) {
        // 逐条记账：一条撞了不该把已经建好的说成没建。
        failed.push({ id: input.id, code: e?.code ?? null, message: e?.message ?? String(e) })
      }
    }
    return {
      ok: true,
      runtimeType: resolved.runtimeType,
      runtimeTypeFrom: resolved.from,
      created,
      failed,
      existing: plan.existing.map((e) => e.profileId),
      conflicts: plan.conflicts,
      orphaned: plan.orphaned,
      summary: describeDerivation({
        ok: true, create: created, existing: plan.existing, conflicts: plan.conflicts, orphaned: plan.orphaned,
      }),
    }
  }

  /**
   * 把请求里的 `runtimeType` 定下来，**在写库之前**。
   *
   * 为什么要在写之前：定不下来时（比如将来有多个能跑的运行时、而用户没选）
   * 应当是**整次保存被拒**，而不是"供应商写进去了、档案没生成"——
   * 后者会让目录与档案就此不一致，而用户看到的是"保存成功"。
   */
  const resolveIncomingRuntimeType = (input) => resolveRuntimeType({
    providerRuntimeType: input?.runtimeType,
    supported: SUPPORTED_RUNTIME_TYPES,
  })

  /**
   * 把"定不下运行时"变成一次**具名 400**（而不是一个 500 或一句"保存失败"）。
   *
   * 用 `INVALID_PROFILE` 那个既有码：调用方要区分的是「我这次请求有问题」与
   * 「服务器崩了」，而 `code` 字段已经把具体原因（`DERIVE_RUNTIME_TYPE_AMBIGUOUS`）
   * 单独带出来了 —— 两件事各占一个字段，不挤在一个字符串里。
   */
  const invalidInput = (code, message) => {
    const err = new ModelError(MODEL_ERRORS.INVALID_PROFILE, message, { statusCode: 400 })
    err.code = code ?? err.code
    return err
  }

  /**
   * 出站**唯一**的供应商形状：**抹掉引用名**（BUG-028）。
   *
   * 本族的每个响应（列表 / 创建 / 更新 / 导入 / 发现）都必须过这里。
   * "每个端点各自记得抹掉"与"有一个统一的出口"不是同一件事 ——
   * 前者在**新加一个端点**的那天就失效了，而失效的表现是"引用名悄悄又发出去了"。
   *
   *   实测抓到它的那条判据（`config-bundle-routes.test.mjs` 用例 ④）在**原始字节**上
   *   找引用名：档案那一族曾把 `credential.ref` 一并发出，供应商这一族则一直整行原样返回。
   *   两处的规矩都写在 `model-store.mjs` 的文件头：
   *   **读出去的东西不含 `secretRef`；引用名也是可枚举的攻击面。**
   *
   * 客户端因此**不需要**这个名字：写凭证时由服务端决定槽位（见下面的 `credentialIntent`）。
   * 要表达"缺哪把钥匙"用 `credential.hasRef` + `credentialRequired`，不说它叫什么。
   *
   * ★ 但有一个**内部**消费者确实需要它：物化 / 影子对账要拿 Legion 侧的引用名与 DSH 的
   *   `apiKeyEnv` 对齐（`services-plugin/materialize-plan.mjs` 的 `secretRef ↔ apiKeyEnv`）。
   *   所以还有一条**带鉴权**的读法（`?includeSecretRefs=1`，判定见 `mayReadSecretRefs`）——
   *   这正是 `model-store.mjs` 那个 `get` / `internalGet` 两读口径在 HTTP 层的对应物。
   */
  const publicProvider = (p) => {
    const { secretRef, ...rest } = p
    return { ...rest, credentialRequired: secretRef !== null && secretRef !== undefined }
  }

  /**
   * 把一次写请求里的**凭证意图**落成 `secretRef`（必要时先把钥匙写进密钥库）。
   *
   * 三种意图，必须分得开（BUG-028）：
   *   · `credentialValue` 是非空字符串 —— 用户填了新钥匙：**先写密钥库、再写引用名**；
   *   · `clearCredential === true` —— 用户要撤掉引用：`secretRef = null`
   *     （`null` 是显式的，所以 `provider-store` 的"没给 = 保留"不会吞掉它）；
   *   · 两者都没有 —— **不动这一项**（返回的补丁里**不含** `secretRef` 键，
   *     于是仓储按"没给"处理 ⇒ 保留原值）。
   *
   * 槽位名的取法：**已有的优先**（可能是 DSH 导进来的 `apiKeyEnv`，两侧靠它对齐），
   * 没有才用 `defaultSecretRefFor(id)`。客户端从头到尾看不到这个名字。
   *
   * 顺序（先钥匙、后引用）与旧面板的纪律一致：反过来的话，"供应商写成功、钥匙写失败"
   * 会留下一条**声称有钥匙、其实没有**的配置。
   */
  const credentialIntent = async (body, id, existing) => {
    const value = typeof body?.credentialValue === 'string' ? body.credentialValue : ''
    if (body?.clearCredential === true) return { patch: { secretRef: null, credentialConfigured: false } }
    if (value.trim() === '') return { patch: {} }
    if (secretAdmin === null || typeof secretAdmin !== 'function') {
      throw invalidInput('SECRET_STORE_NOT_WIRED',
        '这个部署没有接密钥库，因此不能通过界面写凭证（请求里的 credentialValue 没有被忽略）')
    }
    // ★ 校验交给密钥库自己（`assertSecretRef` 是唯一判据），这里只决定用哪个名字。
    const slot = resolveCredentialRef({ existingRef: existing?.secretRef ?? null, id })
    if (slot.ok !== true) throw invalidInput(slot.code, slot.message)
    const ref = slot.ref
    const r = await secretAdmin().put({ ref, value, purpose: `模型供应商 ${id}` })
    return { patch: { secretRef: r?.meta?.ref ?? ref, credentialConfigured: true }, ref }
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/model-providers',      async run(req, res, ctx) {
        // ★ 两读口径：默认那一份**没有引用名**；带 `?includeSecretRefs=1` 且过了令牌校验
        //   才给（内部消费者只有一个：物化 / 影子对账）。
        const vis = mayReadSecretRefs({ wantRefs: ctx?.url?.searchParams?.get('includeSecretRefs') === '1', authorized, req })
        if (vis.ok !== true) {
          json(res, 403, { ok: false, code: vis.code, error: vis.message })
          return
        }
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
          const out = vis.include ? { ...p, credentialRequired: p.secretRef !== null && p.secretRef !== undefined } : publicProvider(p)
          if (snapshot !== null) {
            const verified = snapshot.of(p.secretRef)
            out.credential = { state: verified.state, hasRef: verified.ref !== null, detail: verified.detail }
          }
          if (profiles !== null) {
            const m = matchProviderModels({ provider: p, profiles })
            out.profiles = Object.freeze({ existing: m.existing.length, missing: m.missing.length, orphaned: m.orphaned.length })
          }
          return out
        })
        json(res, 200, {
          ok: true,
          providers: enriched,
          empty: providerStore.isEmpty(),
          // ★ 面板的"运行时"下拉从这里取选项，而不是自己写死一个 `dsh`：
          //   写死的那一份在**加上第二个适配器的那天**会静默落后，
          //   而它的表现是"新运行时永远选不到"（看起来像没做这个功能）。
          runtimeTypes: SUPPORTED_RUNTIME_TYPES.map((id) => ({
            id,
            label: id === 'dsh' ? 'dsh（Legion 原生的运行时）' : id,
          })),
        })
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
        await handleRun(req, res, async (body) => {
          const input = body.provider ?? body
          const id = typeof input.id === 'string' ? input.id : ''
          // ★ 先把 `runtimeType` 定下来（写库之前）：定不下来就整次拒，不留"供应商在、档案没生成"的中间态。
          const rt = resolveIncomingRuntimeType(input)
          if (rt.ok !== true) throw invalidInput(rt.code, rt.message)
          // ★ 凭证意图：新建没有"已有的引用名"，所以槽位名由派生规则定。
          //   ⚠ 必须在 `create` **之前**写钥匙（见 `credentialIntent` 的顺序理由）。
          const cred = await credentialIntent(body, id, null)
          const r = providerStore.create({ ...input, ...cred.patch, runtimeType: rt.runtimeType }, { actor: body.actor })
          // ★★ 添加完**立刻自动生成**模型档案（将军："添加完自动生成供应商档案"）。
          const profilesDerived = deriveForProvider(r.provider.id, { actor: body.actor, requestedRuntimeType: rt.runtimeType })
          return { ...publicProvider(r.provider), revived: r.revived, profilesDerived }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/model-providers/import',
      async run(req, res) {
        await handleRun(req, res, (body) => {
          const r = providerStore.importSnapshot(body.providers ?? [], {
            actor: body.actor, source: body.source ?? 'dsh-import',
          })
          // ★ 导入也是一次"添加"：从 DSH 收进来的供应商同样要长出档案来。
          //   否则引导导入之后目录里有一堆供应商、而档案是空的 —— 那正是将军看到的那一幕。
          //   对**全部**供应商跑一遍（而不是只跑刚变的那几条）：派生本身是幂等的，
          //   只建缺的；而"只跑变化的那几条"会让一次失败的派生永远修不回来。
          const derived = r.providers.map((p) => ({
            providerId: p.id,
            ...deriveForProvider(p.id, { actor: body.actor, requestedRuntimeType: body.runtimeType ?? null }),
          }))
          return { ...r, providers: (r.providers ?? []).map(publicProvider), profilesDerived: derived }
        })
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
    // ★★ 从供应商派生模型档案 —— **现在是"补齐/修复"那条路**，不再是正常流程。
    //
    // 2026-10-10 改了定位（将军："档案必然由供应商与模型来，且添加完**自动生成**供应商档案，
    // 而不是：1.需要手工点生成"）：保存/导入供应商时已经**自动**派生了（见上面的
    // `deriveForProvider`），所以这个端点剩下两个正当用途：
    //   · **补历史**：本次改动之前建的供应商还没有档案（它们的那次保存没有这段逻辑）；
    //   · **修复**：某一次派生部分失败（`failed` 非空），或中枢当时没接档案表。
    // 它保持幂等（只建缺的），所以"多点一次"没有代价。
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
          // `runtimeType` 缺省时走**供应商自己的**（保存时已经写进去了），
          // 再退到"唯一能跑的那个"。与自动派生用**同一个** `resolveRuntimeType`。
          const resolved = resolveRuntimeType({
            providerRuntimeType: provider.runtimeType,
            requested: body.runtimeType,
            supported: SUPPORTED_RUNTIME_TYPES,
          })
          if (resolved.ok !== true) throw invalidInput(resolved.code, resolved.message)
          // ★ 补齐历史供应商时把定下来的运行时**写回那一行**。
          //
          //   为什么值得多写一次：这一行是老数据（补列时是 NULL），而"NULL 就用唯一能跑的那个"
          //   这个判定**只在'唯一'成立时**才对。今天只有 `dsh`，所以它成立；
          //   加上第二个适配器的那一天，这一行就会突然变成"说不清"——
          //   而现在写下它，那一天来临时这些行已经是明确的。
          //
          //   > 一个"每次读的时候重新推断同一个结论"的实现，
          //   > 与一个"推断一次并记下来"的实现，在推断规则不变时是同一个东西 ——
          //   > 只不过规则变的那一天，前者会让一批老行同时失去答案。
          if (provider.runtimeType === null && body.dryRun !== true) {
            providerStore.update(id, { ...toProviderInput(provider), runtimeType: resolved.runtimeType },
              { actor: body.actor, version: provider.version })
          }
          const plan = planProfileDerivation({
            provider, profiles, runtimeType: resolved.runtimeType, profileIdOf: profileIdFor,
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
        await handleRun(req, res, async (body) => {
          const input = body.provider ?? body
          // 改的时候没给 `runtimeType` ⇒ **保留原来那个**（老行上它可能是 NULL）。
          // 这一条与 `providerStore.update` 里的 `?? existing.runtimeType` 是同一条规则，
          // 在这里再取一次是为了让"定不下来的运行时"能在**写库之前**被拒。
          const existing = providerStore.get(id)
          const rt = existing === null
            ? resolveIncomingRuntimeType(input)
            : (() => {
                const r = resolveRuntimeType({
                  providerRuntimeType: input.runtimeType ?? existing.runtimeType,
                  supported: SUPPORTED_RUNTIME_TYPES,
                })
                return r
              })()
          if (rt.ok !== true) throw invalidInput(rt.code, rt.message)
          // ★ 凭证意图：更新时**已有的引用名优先**（面板没有名字可回传，见 BUG-028）。
          const cred = await credentialIntent(body, id, existing)
          const updated = providerStore.update(id, { ...input, ...cred.patch, runtimeType: rt.runtimeType }, { actor: body.actor, version: body.version })
          // ★ 改了清单（比如加了一个模型）⇒ 新模型**立刻**有档案；去掉的模型只**报**不删。
          const profilesDerived = deriveForProvider(id, { actor: body.actor, requestedRuntimeType: rt.runtimeType })
          return { ...publicProvider(updated), profilesDerived }
        })
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

// team-hub/provider-store.mjs
// ============================================================================
// 模型**供应商目录** —— Legion 侧的真相表（docs/DECISION-legion-owns-model-config.md 的 P1）
//
// ## 为什么需要一张新表，而不是继续用 `model_profiles`
//
// `model_profiles` 是 **(provider, model) 粒度**：一个型号一行（BUG-004 登记了 fjd-ds 的三个型号）。
// 而 DSH 的 `llm-pi-ai.providers.<id>` 是**一个供应商实体**，带 `api` / `baseURL` / `models[]`。
// 把"每行都写一遍 api 与 baseURL"当成真相，等于让同组各行可以互不一致，
// 而**没有任何东西会发现**——直到某一次物化把它们写回 DSH，那时谁对谁错已经无从判断。
//
//   > provider 是实体，model 是它的成员。把成员当成实体来存，
//   > 与把实体存下来，在只有一个型号的供应商上是同一个东西。
//
// ## 方向
//
//   DSH 活配置 --导入(P1)--> 本表（`source='dsh-import'`）--物化(P3)--> DSH 活配置
//
// P1 阶段**不反向写回 DSH**：本表是唯一真相的起点，写回在 P3 才接上。
//
// ## 两条不变量（各有用例钉住）
//
// ① **导入是幂等的**：同一份快照导入两次，第二次写 0 行（`unchanged` 计满、`updated`/`created` 为 0）。
//    这一条**就是 P1 的验收本身**——一个"每次启动都重写一遍"的导入器，
//    与一个"只在真变了才写"的导入器，在只启动一次的部署里是同一个东西；
//    而前者会把 `version` 与 `updated_at_ms` 每轮都推进，于是 P2 的影子 diff
//    永远显示"刚改过"，把真正的变化淹掉。
//
// ② **导入绝不删除**：快照里没有的行原样留着。
//    P1 的方向是"把现状收进来"，不是"让 DSH 决定 Legion 里该有什么"——
//    后者会让"DSH 里被人手删掉一行"变成"Legion 里也永久没了"，
//    而这正是 P2（影子对账）要先看见的那件事。
//
// ## 密钥纪律
//
// 本表只存**引用名**（`secretRef`）与"DSH 说它配没配"（`credentialConfigured`），**永不存值**。
// 未知字段**一律拒绝**（不是忽略）：忽略会让一个带 `apiKey` 的请求看起来完全成功，
// 而那个值就落进了一张普通 SQLite 表——那张表会被备份、被复制
// （BUG-013 里刚见过 34 MB 的 `.bak` 差点被打进公开安装包）。
// 审计载荷复用 `model-store.mjs` 的 `assertAuditClean`：**同一道守卫，不是抄一遍**。
// ============================================================================

import { assertAuditClean, ModelError, MODEL_ERRORS } from './model-store.mjs'

/** 供应商的来源：`legion` = 用户在指挥台里建的；`dsh-import` = 从 DSH 活配置收进来的。 */
export const PROVIDER_SOURCES = Object.freeze(['legion', 'dsh-import'])

/** 一条供应商允许出现的字段。**枚举**而不是透传：见文件头的密钥纪律。 */
const PROVIDER_FIELDS = Object.freeze(['id', 'displayName', 'api', 'baseURL', 'secretRef', 'credentialConfigured', 'models'])

/**
 * 型号条目里允许保留的字段。
 *
 * 为什么是白名单 + **报告被丢掉的字段名**，而不是原样存：
 * 原样存会把 DSH 目录里任何未来的字段（含将来可能出现的凭证类字段）搬进 Legion 的库；
 * 而静默丢弃会让 P3 物化时**少写**一些字段，且没有人知道少了什么。
 * 两个都坏，所以丢的时候要把名字报出来。
 */
const MODEL_FIELDS = Object.freeze(['id', 'name', 'description', 'contextWindow', 'maxTokens', 'input', 'reasoning'])

export function ensureProviderSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      api TEXT,
      base_url TEXT,
      secret_ref TEXT,
      credential_configured INTEGER NOT NULL DEFAULT 0,
      models_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'legion',
      version INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      deleted_at_ms INTEGER
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_model_providers_live ON model_providers(deleted_at_ms)')
}

/** provider id：与 DSH 的路由键同形（小写字母开头，允许数字/横线/下划线）。 */
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/
/** 凭证引用名：DSH `refs` 空间是 POSIX 标识符（见 security/secrets/credential-materializer.mjs 的键空间说明）。 */
const SECRET_REF_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function invalid(detail) {
  throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, `供应商不合法：${detail}`, { statusCode: 400, errors: [detail] })
}

/** 只接受 http(s) 且不内嵌账号密码（与指挥台编辑表单同一条口径）。 */
function normalizeBaseUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') invalid('baseURL 必须是字符串')
  let url
  try { url = new URL(raw.trim()) } catch { invalid(`baseURL 不是合法 URL：${String(raw).slice(0, 120)}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid('baseURL 只能是 http(s)')
  if (url.username || url.password) invalid('baseURL 不能内嵌账号密码')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function normalizeModels(raw, dropped) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) invalid('models 必须是数组')
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) invalid('models 的每一项必须是对象')
    for (const key of Object.keys(entry)) {
      if (!MODEL_FIELDS.includes(key)) dropped.add(key)
    }
    const id = entry.id
    if (typeof id !== 'string' || id.trim() === '') invalid('models 的每一项都需要非空的 id')
    const key = id.trim()
    if (seen.has(key)) continue
    seen.add(key)
    const model = { id: key }
    if (typeof entry.name === 'string' && entry.name !== '') model.name = entry.name
    if (typeof entry.description === 'string' && entry.description !== '') model.description = entry.description
    if (Number.isInteger(entry.contextWindow) && entry.contextWindow > 0) model.contextWindow = entry.contextWindow
    if (Number.isInteger(entry.maxTokens) && entry.maxTokens > 0) model.maxTokens = entry.maxTokens
    if (Array.isArray(entry.input) && entry.input.every((m) => typeof m === 'string')) model.input = [...entry.input]
    if (entry.reasoning !== null && typeof entry.reasoning === 'object' && !Array.isArray(entry.reasoning)) model.reasoning = entry.reasoning
    out.push(model)
  }
  return out
}

/**
 * 把一条输入归一化成一个**键序固定**的对象。
 *
 * 固定键序是幂等判定的前提：指纹用的是 `JSON.stringify`，而键序变了就得到不同指纹，
 * 于是"内容没变"会被读成"变了"。这一条不会报错，只会让 ① 那条约定的保证静默失效。
 */
function normalizeProvider(input, dropped) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('供应商必须是对象')
  const unknown = Object.keys(input).filter((k) => !PROVIDER_FIELDS.includes(k))
  if (unknown.length > 0) {
    invalid(`未知字段：${unknown.join(', ')}（**拒绝而不是忽略**：忽略会让带密钥字段的请求看起来成功了）`)
  }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!ID_RE.test(id)) invalid(`id 不合法：${JSON.stringify(String(input.id).slice(0, 64))}（期望小写字母开头，允许数字/横线/下划线，≤64）`)
  const displayName = typeof input.displayName === 'string' && input.displayName.trim() !== ''
    ? input.displayName.trim().slice(0, 120)
    : id
  const api = input.api === undefined || input.api === null || input.api === '' ? null
    : (typeof input.api === 'string' && input.api.trim().length <= 64 ? input.api.trim() : invalid('api 必须是不超过 64 字符的字符串'))
  const baseURL = normalizeBaseUrl(input.baseURL)
  let secretRef = null
  if (input.secretRef !== undefined && input.secretRef !== null && input.secretRef !== '') {
    if (typeof input.secretRef !== 'string' || !SECRET_REF_RE.test(input.secretRef)) {
      invalid(`secretRef 必须是凭证**引用名**（POSIX 标识符），不是密钥本身：${String(input.secretRef).slice(0, 40)}`)
    }
    secretRef = input.secretRef
  }
  return {
    id,
    displayName,
    api,
    baseURL,
    secretRef,
    credentialConfigured: input.credentialConfigured === true,
    models: normalizeModels(input.models, dropped),
  }
}

function fingerprint(p) {
  return JSON.stringify([p.id, p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured, p.models])
}

function rowToProvider(r) {
  if (r === undefined || r === null) return null
  let models = []
  try {
    const parsed = JSON.parse(r.models_json)
    if (Array.isArray(parsed)) models = parsed
  } catch { /* 坏掉的 JSON 当空数组：它会被下一次导入覆盖，而抛错会让整张表读不出来 */ }
  return {
    id: r.id,
    displayName: r.display_name,
    api: r.api ?? null,
    baseURL: r.base_url ?? null,
    secretRef: r.secret_ref ?? null,
    credentialConfigured: Number(r.credential_configured) === 1,
    models,
    source: r.source,
    version: Number(r.version),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    deletedAtMs: r.deleted_at_ms === null || r.deleted_at_ms === undefined ? null : Number(r.deleted_at_ms),
  }
}

/**
 * 建一个供应商目录仓储。
 *
 * `writeAudit({ action, id, detail, actor })` 由调用方注入（审计表属于 server.mjs）——
 * 与 `createModelStore` 同一条边界。
 */
export function createProviderStore({ db, clock = () => Date.now(), writeAudit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createProviderStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createProviderStore 的 clock 必须是函数')
  ensureProviderSchema(db)

  function audit({ action, id, detail, actor }) {
    assertAuditClean({ action, id, detail })
    if (typeof writeAudit !== 'function') return
    writeAudit({ action, id, detail, actor })
  }

  function list({ includeDeleted = false, source = null } = {}) {
    const rows = includeDeleted
      ? db.prepare('SELECT * FROM model_providers ORDER BY id').all()
      : db.prepare('SELECT * FROM model_providers WHERE deleted_at_ms IS NULL ORDER BY id').all()
    return Object.freeze(rows.map(rowToProvider)
      .filter((p) => source === null || p.source === source)
      .map((p) => Object.freeze(p)))
  }

  function get(id) {
    const p = rowToProvider(db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id))
    if (p === null || p.deletedAtMs !== null) return null
    return Object.freeze(p)
  }

  /** 目录是否为空（含墓碑）—— 导入器用它决定"要不要做这次引导导入"。 */
  function isEmpty() {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM model_providers').get().n) === 0
  }

  /**
   * 从一份快照导入（幂等、**不删除**）。
   *
   * @returns `{ created, updated, unchanged, droppedFields, providers }`
   *   —— `unchanged` 是"内容与库里已有一致、因此**一行都没写**"的条数；
   *   它是 P1 的验收读数（第二次导入应当 `created=0 updated=0 unchanged=N`）。
   */
  function importSnapshot(snapshot, { actor, source = 'dsh-import' } = {}) {
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new ModelError(MODEL_ERRORS.ACTOR_REQUIRED,
        '缺少 actor：谁把 DSH 的现状导进来的必须留痕（审计里没有密钥，但必须有人）')
    }
    if (!PROVIDER_SOURCES.includes(source)) {
      throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, `未知的 source：${String(source)}`, { statusCode: 400 })
    }
    if (!Array.isArray(snapshot)) invalid('providers 必须是数组')

    const dropped = new Set()
    const seenIds = new Set()
    const normalized = []
    for (const raw of snapshot) {
      const p = normalizeProvider(raw, dropped)
      if (seenIds.has(p.id)) invalid(`快照里出现了重复的 provider id：${p.id}`)
      seenIds.add(p.id)
      normalized.push(p)
    }

    let created = 0
    let updated = 0
    let unchanged = 0
    const nowMs = clock()
    for (const p of normalized) {
      const existing = rowToProvider(db.prepare('SELECT * FROM model_providers WHERE id = ?').get(p.id))
      const next = fingerprint(p)
      if (existing !== null && existing.deletedAtMs === null) {
        if (fingerprint(existing) === next) { unchanged += 1; continue }
        // ★ 只有**内容真的变了**才推进 version。漂移一次就推进一版，
        //   会让 P2 的影子 diff 每轮都报"有人改过"，把真变化淹掉。
        db.prepare(
          `UPDATE model_providers SET display_name=?, api=?, base_url=?, secret_ref=?, credential_configured=?,
             models_json=?, source=?, version=version+1, updated_at_ms=? WHERE id=?`,
        ).run(p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured ? 1 : 0,
          JSON.stringify(p.models), source, nowMs, p.id)
        updated += 1
        continue
      }
      if (existing !== null && existing.deletedAtMs !== null) {
        // 墓碑行重见：**复活**并留痕。删除后再导入同名，是"它又回来了"，
        // 不是"新建"——把两者混起来会让审计里出现两条 created 而中间那次删除消失。
        db.prepare(
          `UPDATE model_providers SET display_name=?, api=?, base_url=?, secret_ref=?, credential_configured=?,
             models_json=?, source=?, version=version+1, updated_at_ms=?, deleted_at_ms=NULL WHERE id=?`,
        ).run(p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured ? 1 : 0,
          JSON.stringify(p.models), source, nowMs, p.id)
        updated += 1
        continue
      }
      db.prepare(
        `INSERT INTO model_providers
           (id, display_name, api, base_url, secret_ref, credential_configured, models_json, source, version, created_at_ms, updated_at_ms, deleted_at_ms)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,NULL)`,
      ).run(p.id, p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured ? 1 : 0,
        JSON.stringify(p.models), source, nowMs, nowMs)
      created += 1
    }

    // 审计只记**数量与 id 清单**：不记 baseURL 全文（可能含内网主机名）、不记任何引用名的值。
    audit({
      action: 'model-provider.import', id: '*', actor,
      detail: { source, created, updated, unchanged, ids: normalized.map((p) => p.id) },
    })
    return Object.freeze({
      created, updated, unchanged,
      droppedFields: Object.freeze([...dropped].sort()),
      providers: list(),
    })
  }

  // ── 目常写入（面板用）────────────────────────────────────────────────────
  //
  // 与 `importSnapshot` 的区别不只是"一条 vs 一批"：导入是**把 DSH 的现状收进来**
  // （source='dsh-import'），而这里是**用户在指挥台里表达意图**（source='legion'）。
  // 两者混起来会让"这条是我建的"与"这条是从 DSH 抄来的"分不开，
  // 而 P2 的对账正是靠这个区分来判断"Legion 里没有 = 用户删了"。

  function requireActor(actor) {
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new ModelError(MODEL_ERRORS.ACTOR_REQUIRED,
        '缺少 actor：谁改的模型配置必须留痕（审计里没有密钥，但必须有人）')
    }
    return actor
  }

  /** 单条归一化（复用导入那条同一个 `normalizeProvider`，所以字段纪律完全一致）。 */
  function normalizeOne(input) {
    const dropped = new Set()
    const p = normalizeProvider(input, dropped)
    return { p, dropped: Object.freeze([...dropped].sort()) }
  }

  /**
   * 新增；**同名墓碑 ⇒ 复活**（不是拒绝）。
   *
   * ## 为什么这里曾经是拒绝的，以及为什么那是错的（2026-10-09，业主实测）
   *
   * 初版对"删过的同名"一律 409 `PROFILE_DELETED`，理由是"历史里那个引用会指向另一个供应商"。
   * 而**同一个文件里的导入路径对墓碑是复活**（`importSnapshot`：'墓碑行重见：复活并留痕'）——
   * 同一件事，两条路给出相反答案：
   *
   *   > 一个"从 DSH 抄回来的同名会复活、而我自己点出来的同名被拒绝"的规则，
   *   > 对用户来说不是规则，是运气。
   *
   * 实测后果（业主那台机器）：`svea-ds` 被删（墓碑）⇒ 想加回来被拒 ⇒ 只好建成 `svea-ds-1`。
   * 于是同一台机器上出现了一个**与 DSH 配置 id 不一致的别名**，而这个名字还会被物化进 DSH
   * —— 拒绝换来的不是安全，是一个更难收拾的状态。
   *
   * ## 复活仍然留痕（原来那条保护换了个地方实现）
   *
   * 历史引用的顾虑并没有消失，所以它不再靠"拒绝"实现，而是靠**审计说清这是复活**：
   * `model-provider.revive` 带上 `previousVersion`。于是"它又回来了"与"它第一次出现"
   * 在审计里是两件事，而用户不必为此发明新 id。
   *
   * @returns `{ provider, revived }` —— `revived` 让调用方（面板）能说"已恢复"而不是"已创建"。
   */
  function create(input, { actor, source = 'legion' } = {}) {
    requireActor(actor)
    if (!PROVIDER_SOURCES.includes(source)) {
      throw new ModelError(MODEL_ERRORS.INVALID_PROFILE, `未知的 source：${String(source)}`, { statusCode: 400 })
    }
    const { p, dropped } = normalizeOne(input)
    const existing = rowToProvider(db.prepare('SELECT * FROM model_providers WHERE id = ?').get(p.id))
    if (existing !== null && existing.deletedAtMs === null) {
      // 活着的同名才是真冲突：那不是"想建"，而是"想改"，两条路的修法不同。
      throw new ModelError(MODEL_ERRORS.PROFILE_EXISTS,
        `供应商已存在：${p.id}；要修改请从列表里编辑（更新需要 version 做并发保护）`,
        { statusCode: 409 })
    }
    const nowMs = clock()
    if (existing !== null) {
      // ── 墓碑 ⇒ 复活 ──
      db.prepare(
        `UPDATE model_providers SET display_name=?, api=?, base_url=?, secret_ref=?, credential_configured=?,
           models_json=?, source=?, version=version+1, updated_at_ms=?, deleted_at_ms=NULL WHERE id=?`,
      ).run(p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured ? 1 : 0,
        JSON.stringify(p.models), source, nowMs, p.id)
      audit({
        action: 'model-provider.revive', id: p.id, actor,
        detail: { source, previousVersion: existing.version, api: p.api, modelCount: p.models.length, hasCredential: p.secretRef !== null, droppedFields: dropped },
      })
      return { provider: get(p.id), revived: true }
    }
    db.prepare(
      `INSERT INTO model_providers
         (id, display_name, api, base_url, secret_ref, credential_configured, models_json, source, version, created_at_ms, updated_at_ms, deleted_at_ms)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,NULL)`,
    ).run(p.id, p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured ? 1 : 0,
      JSON.stringify(p.models), source, nowMs, nowMs)
    audit({ action: 'model-provider.create', id: p.id, actor, detail: { source, api: p.api, modelCount: p.models.length, hasCredential: p.secretRef !== null, droppedFields: dropped } })
    return { provider: get(p.id), revived: false }
  }

  /**
   * 整体替换一条（CAS）。
   *
   * 需要调用方给 `version`：不给就报错，**不默认成"最后一个版本"** ——
   * 默认成最后一版时，两个界面同时保存会静默覆盖，而两边都显示成功
   * （与 `model-store.update` 同一条纪律）。
   */
  function update(id, input, { actor, version, source = 'legion' } = {}) {
    requireActor(actor)
    if (!Number.isInteger(version)) {
      throw new ModelError(MODEL_ERRORS.VERSION_REQUIRED,
        '缺少 version：并发保存必须带版本，否则两个界面同时保存会静默覆盖', { statusCode: 400 })
    }
    const existing = rowToProvider(db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id))
    if (existing === null) {
      throw new ModelError(MODEL_ERRORS.PROFILE_NOT_FOUND, `没有这个供应商：${id}`, { statusCode: 404 })
    }
    if (existing.deletedAtMs !== null) {
      // ★ 与"不存在"分开报，并**告诉用户怎么恢复**：删除之后想改回来，
      //   正确的动作是"用同名重新创建"（那会复活它），而不是"编辑一个已经不存在的东西"。
      throw new ModelError(MODEL_ERRORS.PROFILE_DELETED,
        `供应商 ${id} 已被删除，不能直接编辑；用同名重新创建即可**恢复**它（那份历史会留在审计里）`,
        { statusCode: 409, deletedAtMs: existing.deletedAtMs })
    }
    if (existing.version !== version) {
      throw new ModelError(MODEL_ERRORS.VERSION_CONFLICT,
        `供应商 ${id} 已被别人改过（当前 v${existing.version}，你手上是 v${version}）→ 请刷新后重试`,
        { statusCode: 409, currentVersion: existing.version })
    }
    const { p, dropped } = normalizeOne({ ...input, id })
    const nowMs = clock()
    const changed = []
    for (const [col, next, prev] of [
      ['display_name', p.displayName, existing.displayName],
      ['api', p.api, existing.api],
      ['base_url', p.baseURL, existing.baseURL],
      ['secret_ref', p.secretRef, existing.secretRef],
      ['models_json', JSON.stringify(p.models), JSON.stringify(existing.models)],
    ]) { if (next !== prev) changed.push(col) }
    db.prepare(
      `UPDATE model_providers SET display_name=?, api=?, base_url=?, secret_ref=?, credential_configured=?,
         models_json=?, source=?, version=version+1, updated_at_ms=? WHERE id=?`,
    ).run(p.displayName, p.api, p.baseURL, p.secretRef, p.credentialConfigured ? 1 : 0,
      JSON.stringify(p.models), source, nowMs, id)
    audit({ action: 'model-provider.update', id, actor, detail: { fields: changed, modelCount: p.models.length, droppedFields: dropped } })
    return get(id)
  }

  /**
   * 删除 = **立墓碑**（不是 DELETE 掉那一行）。
   *
   * 与 `model-store.remove` 同一条理由：一次 Run / 一条历史可能还记着这个引用，
   * 而"删掉再建同名"会让历史指向另一个供应商。墓碑让"它被下线了"与"它从来不存在"分得开。
   */
  function remove(id, { actor, version } = {}) {
    requireActor(actor)
    const existing = rowToProvider(db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id))
    if (existing === null) {
      throw new ModelError(MODEL_ERRORS.PROFILE_NOT_FOUND, `没有这个供应商：${id}`, { statusCode: 404 })
    }
    if (existing.deletedAtMs !== null) {
      throw new ModelError(MODEL_ERRORS.PROFILE_DELETED, `供应商 ${id} 已经被删除过了`, { statusCode: 409 })
    }
    if (version !== undefined && existing.version !== version) {
      throw new ModelError(MODEL_ERRORS.VERSION_CONFLICT,
        `供应商 ${id} 已被别人改过（当前 v${existing.version}，你手上是 v${version}）→ 请刷新后重试`,
        { statusCode: 409, currentVersion: existing.version })
    }
    const nowMs = clock()
    db.prepare('UPDATE model_providers SET deleted_at_ms=?, updated_at_ms=?, version=version+1 WHERE id=?')
      .run(nowMs, nowMs, id)
    audit({ action: 'model-provider.remove', id, actor, detail: { source: existing.source } })
    return Object.freeze({ id, deletedAtMs: nowMs, version: existing.version + 1 })
  }

  return { list, get, isEmpty, importSnapshot, create, update, remove }
}

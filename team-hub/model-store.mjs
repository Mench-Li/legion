// team-hub/model-store.mjs
// ============================================================================
// ModelProfile 数据模型与 API 的存储层（PRT-501）
//
// spec §6.6：Workbench 提供统一模型配置，屏蔽 DSH 内部配置格式。
// spec §6.7：team-hub **只保存 `secretRef`，不保存明文**。
//
// 本模块的每一条设计都对着上面那两句话：
//
//   ① **校验只有一处**。写入路径复用 `runtime/contracts/model.mjs` 的
//      `validateProfile`（PRT-102 就在那里，含"拒绝未知字段 + 拒绝明文密钥
//      + 拒绝 endpoint 内嵌凭证"）。API 层再写一遍校验的后果不是重复劳动，
//      而是**两处判据会漂移**——而漂移的那一次就是把明文密钥写进库的那一次。
//
//   ② **读出去的东西不含 `secretRef`**。`toModelDescriptor` 连引用名都不给
//      （只给 `hasCredential`）。引用名也是可枚举的攻击面：知道引用名就离
//      猜到密钥库里的条目更近一步，而它没有必要出现在界面上。
//
//   ③ **删除是墓碑，不是物理删除**。一次 Run 会记下 `modelProfileRef`；
//      硬删除会让历史记录指向一个查不到的东西——"当时用的哪个模型"就永远
//      答不上来了。这与 §6.6「后续价格表更新不得重算历史 usage_records」
//      是同一条纪律。墓碑同时挡住"删掉再用同名建一个"这种更隐蔽的替换。
//
//   ④ **审计记录本身拒绝含密文的载荷**。写审计的那一步用与写入路径**同一个**
//      `findPlaintextSecrets` 再查一次，命中就**拒绝写这条审计**（fail closed），
//      而不是"脱敏后照写"。照写需要脱敏逻辑，而脱敏逻辑正是最容易漏的那一环。
//
//   ⑤ **更新用 `version` 做 CAS**。两个界面同时改同一个档案时，后写的会静默
//      覆盖前一个的改动（lost update），而两边都显示"保存成功"。配置类的
//      lost update 尤其难查：用户会发现"我改的东西自己变回去了"。
// ============================================================================

import { findPlaintextSecrets, toModelDescriptor, validateProfile } from '../runtime/contracts/model.mjs'

/** 本模块的具名错误码。错误码与状态码分开：`code` 是给程序看的，状态码是给调用方看的。 */
export const MODEL_ERRORS = Object.freeze({
  INVALID_PROFILE: 'INVALID_PROFILE',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_EXISTS: 'PROFILE_EXISTS',
  PROFILE_DELETED: 'PROFILE_DELETED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  VERSION_REQUIRED: 'VERSION_REQUIRED',
  ACTOR_REQUIRED: 'ACTOR_REQUIRED',
  AUDIT_WOULD_LEAK: 'AUDIT_WOULD_LEAK',
})

export class ModelError extends Error {
  constructor(code, message, { statusCode = 400, ...extra } = {}) {
    super(message)
    this.name = 'ModelError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

/** 建表。幂等，与 team-hub 其它表同样的纪律（老库自动补建，零迁移脚本）。 */
export function ensureModelSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      endpoint TEXT,
      secret_ref TEXT,
      reasoning_effort TEXT NOT NULL DEFAULT 'medium',
      limits_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      deleted_at_ms INTEGER
    )
  `)
  // 可用档案的查询几乎总是"排除墓碑"，因此这个部分索引直接对上它。
  db.exec('CREATE INDEX IF NOT EXISTS idx_model_profiles_live ON model_profiles(deleted_at_ms)')
}

/**
 * 数据库行 → 内部档案对象（**含 secretRef**，仅仓储内部使用）。
 *
 * 行里既有 ModelProfile 的字段，也有 `version` / `created_at_ms` 这类**簿记**
 * 字段。两者必须分开放：`toModelDescriptor` 会（正确地）把簿记字段当成
 * 未知字段拒绝，于是把整行直接递过去会抛
 * `无法转换非法 ModelProfile：未知字段 version`。
 * 这是 PRT-102 的严格校验在起作用，不是它的缺陷——`profileOf` 负责切出
 * 真正属于 ModelProfile 的那一部分。
 */
function profileOf(p) {
  return {
    id: p.id,
    displayName: p.displayName,
    runtimeType: p.runtimeType,
    provider: p.provider,
    model: p.model,
    endpoint: p.endpoint,
    secretRef: p.secretRef,
    reasoningEffort: p.reasoningEffort,
    limits: p.limits,
  }
}

function rowToProfile(r) {
  if (r === undefined) return null
  return {
    id: r.id,
    displayName: r.display_name,
    runtimeType: r.runtime_type,
    provider: r.provider,
    model: r.model,
    endpoint: r.endpoint ?? null,
    secretRef: r.secret_ref ?? null,
    reasoningEffort: r.reasoning_effort,
    limits: safeParse(r.limits_json),
    version: Number(r.version),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    deletedAtMs: r.deleted_at_ms === null || r.deleted_at_ms === undefined ? null : Number(r.deleted_at_ms),
  }
}

function safeParse(text) {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    // 读不出来时不当作 `{}` 然后继续——坏掉的限流配置会让预算判定失去依据。
    // 交给上层：`limitsUnreadable` 会被如实报出来。
    return { __unreadable: true }
  }
}

/**
 * 审计载荷守卫：**含疑似明文密钥就拒绝写**。
 *
 * 这是本模块唯一一处"宁可什么都不记"的地方，理由是另一条路更坏：
 * 写一条脱敏后的审计需要脱敏逻辑正确，而脱敏逻辑漏一处就等于把密钥
 * 永久留在库里。拒绝写入是 fail closed，且失败本身立刻可见。
 *
 * 导出是为了能被**直接**验：走公开 API 时它不可达（`validateProfile`
 * 已经把所有密钥形态挡在门外），因此只能直接调它才能证明它确实会拒。
 * 一条永远走不到、也从没被验过的防线，和没有这条防线是一样的。
 */
export function assertAuditClean(payload) {
  const hits = findPlaintextSecrets(payload)
  if (hits.length > 0) {
    throw new ModelError(MODEL_ERRORS.AUDIT_WOULD_LEAK,
      `拒绝写入含疑似明文密钥的审计记录：${hits.join(', ')}。` +
      '**不脱敏后照写**：脱敏逻辑漏一处就等于把密钥永久留在库里；拒绝是 fail closed，且立刻可见',
      { statusCode: 500, hits })
  }
}

/**
 * 建一个 ModelProfile 仓储。
 *
 * `writeAudit({ action, id, detail, actor })` 由调用方注入：审计表属于
 * server.mjs，而本模块不该认识它的形状。
 */
export function createModelStore({ db, clock = () => Date.now(), writeAudit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createModelStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createModelStore 的 clock 必须是函数')
  // 与 `createRunStore` 同样的纪律：仓储自己保证 schema 就绪。
  // 交给调用方记得调一次的话，漏掉的那次会在**第一次写入**时才炸，
  // 而那时错误看起来像"表不存在"，不像"初始化漏了一步"。
  ensureModelSchema(db)

  /** 审计：调注入的写入器，但**先**过脱敏守卫。 */
  function audit({ action, id, detail, actor }) {
    assertAuditClean({ action, id, detail })
    if (typeof writeAudit !== 'function') return
    writeAudit({ action, id, detail, actor })
  }

  /** 列表：默认只给未删除的，且**一定是 descriptor**（不含 secretRef）。 */
  function list({ includeDeleted = false } = {}) {
    const rows = includeDeleted
      ? db.prepare('SELECT * FROM model_profiles ORDER BY id').all()
      : db.prepare('SELECT * FROM model_profiles WHERE deleted_at_ms IS NULL ORDER BY id').all()
    return Object.freeze(rows.map((r) => {
      const p = rowToProfile(r)
      const d = toModelDescriptor(profileOf(p))
      return Object.freeze({ ...d, version: p.version, deleted: p.deletedAtMs !== null, updatedAtMs: p.updatedAtMs })
    }))
  }

  /** 内部读取（含 secretRef）。**只在需要真的用凭证时调用**（如 PRT-504 连通性测试）。 */
  function internalGet(id) {
    return rowToProfile(db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id))
  }

  /** 对外的单条读取：descriptor，不含 secretRef。 */
  function get(id) {
    const p = internalGet(id)
    if (p === null || p.deletedAtMs !== null) return null
    return Object.freeze({
      ...toModelDescriptor(profileOf(p)), version: p.version, deleted: false,
      createdAtMs: p.createdAtMs, updatedAtMs: p.updatedAtMs,
    })
  }

  /** 必须存在且未删除，否则抛。返回内部对象（含 secretRef）。 */
  function requireLive(id) {
    const p = internalGet(id)
    if (p === null) {
      throw new ModelError(MODEL_ERRORS.PROFILE_NOT_FOUND, `没有这个模型档案：${id}`, { statusCode: 404 })
    }
    if (p.deletedAtMs !== null) {
      // 与"不存在"分开报：墓碑存在这件事本身是信息（有人删过它），
      // 而混成 404 会让"删掉再用同名建"看起来像一次干净的首次创建。
      throw new ModelError(MODEL_ERRORS.PROFILE_DELETED,
        `模型档案 ${id} 已被删除（${new Date(p.deletedAtMs).toISOString()}）。` +
        '墓碑不是"不存在"：一次 Run 可能还记着这个引用，而删掉再建同名档案会让历史指向另一个模型',
        { statusCode: 409, deletedAtMs: p.deletedAtMs })
    }
    return p
  }

  function requireActor(actor) {
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new ModelError(MODEL_ERRORS.ACTOR_REQUIRED,
        '缺少 actor：谁改的模型配置必须留痕（审计记录里没有密文，但必须有人）')
    }
    return actor
  }

  /**
   * 新增。**校验走 PRT-102 的同一个 `validateProfile`**。
   *
   * `input` 里带 `version` 时忽略——版本由仓储分配。让调用方能指定版本
   * 等于让它们能伪造 CAS 的基线。
   */
  function create(input, { actor } = {}) {
    requireActor(actor)
    const res = validateProfile(input)
    if (!res.ok) {
      throw new ModelError(MODEL_ERRORS.INVALID_PROFILE,
        `模型档案不合法：${res.errors.join('；')}`, { statusCode: 400, errors: res.errors })
    }
    const p = res.value
    const existing = internalGet(p.id)
    if (existing !== null) {
      // 墓碑同样挡住：删掉再建同名会让"历史里那个 id 指向的模型"被悄悄换掉。
      throw new ModelError(existing.deletedAtMs !== null ? MODEL_ERRORS.PROFILE_DELETED : MODEL_ERRORS.PROFILE_EXISTS,
        existing.deletedAtMs !== null
          ? `模型档案 ${p.id} 曾被删除，不能重用同名 id（历史记录里那个引用会指向另一个模型）`
          : `模型档案已存在：${p.id}；要修改请用 update（它需要 version 做并发保护）`,
        { statusCode: 409 })
    }
    const nowMs = clock()
    db.prepare(
      `INSERT INTO model_profiles
        (id, display_name, runtime_type, provider, model, endpoint, secret_ref, reasoning_effort, limits_json, version, created_at_ms, updated_at_ms, deleted_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,NULL)`,
    ).run(p.id, p.displayName, p.runtimeType, p.provider, p.model, p.endpoint, p.secretRef,
      p.reasoningEffort, JSON.stringify(p.limits), nowMs, nowMs)
    // 审计只记**非敏感**事实：改了哪个 id、有没有凭证、字段名清单。
    // 不记 endpoint 全文（可能含内网主机名）与任何值。
    audit({
      action: 'model-profile.create', id: p.id, actor,
      detail: { provider: p.provider, model: p.model, hasCredential: p.secretRef !== null, fields: Object.keys(input) },
    })
    return get(p.id)
  }

  /**
   * 更新（整体替换，CAS）。
   *
   * 要求调用方给 `version`：不给就报错，**不默认成"最后一个版本"**。
   * 默认成最后一版时，两个界面同时保存会静默覆盖，而两边都显示成功。
   */
  function update(id, input, { actor, version } = {}) {
    requireActor(actor)
    if (!Number.isInteger(version)) {
      throw new ModelError(MODEL_ERRORS.VERSION_REQUIRED,
        'update 需要 version（整数）：不给就默认成最后一版时，两个界面同时保存会静默覆盖，而两边都显示成功',
        { statusCode: 400 })
    }
    const current = requireLive(id)
    if (current.version !== version) {
      throw new ModelError(MODEL_ERRORS.VERSION_CONFLICT,
        `版本不符：请求 ${version}，当前 ${current.version}——拒绝写入（另有并发修改，请重新读取后再改）`,
        { statusCode: 409, currentVersion: current.version })
    }
    // `id` 不允许通过 update 改（那是"建一个新的"）：让它必须与 URL 一致。
    const res = validateProfile({ ...input, id })
    if (!res.ok) {
      throw new ModelError(MODEL_ERRORS.INVALID_PROFILE,
        `模型档案不合法：${res.errors.join('；')}`, { statusCode: 400, errors: res.errors })
    }
    const p = res.value
    const nowMs = clock()
    db.prepare(
      `UPDATE model_profiles SET display_name=?, runtime_type=?, provider=?, model=?, endpoint=?, secret_ref=?,
        reasoning_effort=?, limits_json=?, version=version+1, updated_at_ms=?
       WHERE id=? AND version=?`,
    ).run(p.displayName, p.runtimeType, p.provider, p.model, p.endpoint, p.secretRef,
      p.reasoningEffort, JSON.stringify(p.limits), nowMs, id, version)
    // 复读确认：`WHERE version=?` 没匹配到时 run() 不报错（改动 0 行）。
    // 不看这一眼的话，一次没生效的更新会返回"成功"。
    const after = requireLive(id)
    if (after.version !== version + 1) {
      throw new ModelError(MODEL_ERRORS.VERSION_CONFLICT,
        `更新没有生效（期望版本 ${version + 1}，实际 ${after.version}）：并发写入抢先了`,
        { statusCode: 409, currentVersion: after.version })
    }
    // 审计里**只记字段名与"引用是否变化"**，不记 secretRef 的值或引用名。
    audit({
      action: 'model-profile.update', id, actor,
      detail: {
        provider: p.provider, model: p.model,
        credentialChanged: current.secretRef !== p.secretRef,
        hasCredential: p.secretRef !== null,
        fields: Object.keys(input),
      },
    })
    return get(id)
  }

  /**
   * 删除 = 立墓碑。**不是物理删除。**
   *
   * 一次 Run 会记下 `modelProfileRef`；硬删除会让历史记录指向一个查不到的
   * 东西（"当时用的哪个模型"永远答不上来）。这与 §6.6「后续价格表更新不得
   * 重算历史 usage_records」是同一条纪律。
   */
  function remove(id, { actor, version } = {}) {
    requireActor(actor)
    if (!Number.isInteger(version)) {
      throw new ModelError(MODEL_ERRORS.VERSION_REQUIRED, 'remove 需要 version（整数）', { statusCode: 400 })
    }
    const current = requireLive(id)
    if (current.version !== version) {
      throw new ModelError(MODEL_ERRORS.VERSION_CONFLICT,
        `版本不符：请求 ${version}，当前 ${current.version}`,
        { statusCode: 409, currentVersion: current.version })
    }
    const nowMs = clock()
    db.prepare('UPDATE model_profiles SET deleted_at_ms=?, version=version+1, updated_at_ms=? WHERE id=? AND version=?')
      .run(nowMs, nowMs, id, version)
    const after = internalGet(id)
    if (after === null || after.deletedAtMs === null) {
      throw new ModelError(MODEL_ERRORS.VERSION_CONFLICT,
        `删除没有生效（并发写入抢先了）`, { statusCode: 409 })
    }
    audit({ action: 'model-profile.delete', id, actor, detail: { tombstone: true, version: after.version } })
    return Object.freeze({ ok: true, id, deleted: true, version: after.version, deletedAtMs: nowMs })
  }

  /** 历史解析：给一个可能已被删除的 id，回答"它当时是什么"。 */
  function resolveForHistory(id) {
    const p = internalGet(id)
    if (p === null) return null
    return Object.freeze({
      ...toModelDescriptor(profileOf(p)), version: p.version,
      deleted: p.deletedAtMs !== null, deletedAtMs: p.deletedAtMs,
    })
  }

  return Object.freeze({ list, get, internalGet, create, update, remove, resolveForHistory })
}

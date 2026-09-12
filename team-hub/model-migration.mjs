// team-hub/model-migration.mjs
// ============================================================================
// PRT-506：迁移现有非敏感模型配置
//
// ## 源是什么
//
// 产品化之前，"哪个岗位用哪个模型"存在两张老地方：
//   ① `agent_models` 表（PRT-501 之前就在用）：`(scope, role) → (provider, model)`
//   ② DSH 侧 `settings.yaml` 的 `model`（单条，全局）
//
// 目标形态是 `model_profiles`（档案）+ `model_bindings`（岗位绑定）。
//
// ## 这次迁移**搬不动**的东西，以及为什么不猜
//
// 老数据每条只有 `(scope, role, provider, model)` 四个字段。而一个能真正跑起来的
// 档案还需要两样：
//
//   * `runtimeType`（必填）—— 老数据里**没有**；
//   * `endpoint`（可选）—— 老数据里**也没有**；
//
// 还有一个不在档案里、但决定"能不能跑"的东西：**凭证**。
//
// 三样都可以"按供应商名字猜一个大概"——而**三样都不许猜**：
//
//   猜 runtimeType  → 猜错会让请求以错误的协议发出去，报一个与配置无关的错；
//   猜 endpoint     → 猜错会让档案看起来"配好了"，直到第一次运行才炸，
//                     而那时用户早就忘了它是迁移来的；
//   猜"凭证大概有"  → 迁移完的界面显示一切就绪，而运行会失败。
//
// 三种猜法的共同后果是**同一个**：产出一份**看起来可用**的配置。
// 所以本模块产出的是「**确定的部分 + 待补清单**」，而不是"迁移完成"。
//
// ## 另一个容易被忽略的失败：id 归一化会**撞车**
//
// 档案 id 有字符集限制（`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`），而供应商名与模型名
// 里可能有别的字符，需要归一化。归一化**可能把两个不同的模型压成同一个 id**——
// 那是一次**静默合并**：两个岗位被绑到同一个档案上，而其中一个的模型名已经消失。
//
// 所以这里主动检查撞车并**拒绝整个计划**，而不是"先建的赢"。
// ============================================================================

import { validateProfile } from '../runtime/contracts/model.mjs'

export const MIGRATION_CODES = Object.freeze({
  OK: 'MIGRATION_OK',
  /** 调用方没给 runtimeType——不给就猜，猜错会以错误的协议发请求 */
  RUNTIME_TYPE_REQUIRED: 'MIGRATION_RUNTIME_TYPE_REQUIRED',
  /** 归一化后的 id 撞车：两个不同的模型被压成同一个 id */
  ID_COLLISION: 'MIGRATION_ID_COLLISION',
  /** 源数据里有疑似明文密钥 */
  SECRET_IN_SOURCE: 'MIGRATION_SECRET_IN_SOURCE',
  /** 源数据不是数组 */
  BAD_SOURCE: 'MIGRATION_BAD_SOURCE',
  /** 用户确认的计划与服务端现在算出来的不一致 */
  PLAN_STALE: 'MIGRATION_PLAN_STALE',
})

/** 归一化后 id 的最大长度（契约是 64，这里留出几个字符给消歧后缀）。 */
const MAX_ID_LEN = 60

/**
 * 把一个 `(provider, model)` 归一化成合法档案 id。
 *
 * 只做**字符集折叠**，不做任何"聪明"的缩写：`custom-ds` + `deepseek-v4-pro` →
 * `custom-ds.deepseek-v4-pro`。折叠掉非 `[a-zA-Z0-9._-]` 的字符为 `-`。
 *
 * **它可能撞车**，所以调用方必须配合 `ID_COLLISION` 检查使用。
 */
export function profileIdFor(provider, model) {
  const raw = `${String(provider ?? '').trim()}.${String(model ?? '').trim()}`
  const folded = raw.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '')
  if (folded.length <= MAX_ID_LEN) return folded
  // 截断会**必然**制造撞车（长名的前缀往往相同），所以截断时附加一个短哈希，
  // 让"截断后仍然不同"这件事成立。
  let hash = 0
  for (let i = 0; i < folded.length; i += 1) {
    hash = (hash * 31 + folded.charCodeAt(i)) >>> 0
  }
  return `${folded.slice(0, MAX_ID_LEN - 7)}-${hash.toString(36).slice(0, 6)}`
}

/** 老数据行里绝不该出现的键（出现就说明有人在往里塞密钥）。 */
const SECRET_ISH_KEYS = Object.freeze(['apikey', 'api_key', 'key', 'token', 'secret', 'password', 'authorization', 'credential'])

function looksLikeSecretValue(v) {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (/^sk-[A-Za-z0-9_-]{8,}$/.test(s)) return true
  if (/^(Bearer|Basic)\s+\S+/i.test(s)) return true
  return s.length >= 32 && /^[A-Za-z0-9_\-+/=]+$/.test(s)
}

/**
 * 制定迁移计划。**纯函数、无 I/O、不写库**——先看清楚要做什么，再决定做不做。
 *
 * @param {object} input
 * @param {Array}  input.legacyRows 老数据：`{scope, role, provider, model}`
 * @param {string} input.runtimeType **必填**。这批模型按哪种协议说话。
 * @param {Array}  [input.existingProfiles] 现有档案的 id 列表（幂等用）
 * @param {Array}  [input.existingBindings] 现有绑定的 `{scope, employeeRole}` 列表
 * @param {string} [input.actor] 迁移者（审计留痕）
 */
export function planModelMigration({
  legacyRows,
  runtimeType,
  existingProfiles = [],
  existingBindings = [],
  actor = null,
} = {}) {
  const base = { toCreate: [], toBind: [], needsAttention: [], skipped: [], refused: [], conflicts: [] }

  if (!Array.isArray(legacyRows)) {
    return finish(base, MIGRATION_CODES.BAD_SOURCE, 'legacyRows 必须是数组（没有可迁移的数据时应传空数组）')
  }
  // runtimeType **必填**：它是"这批模型按哪种协议说话"，猜错会以错误的协议发请求。
  // 注意这里不提供默认值——提供一个默认值就等于替用户做了这个判断。
  if (typeof runtimeType !== 'string' || runtimeType.trim() === '') {
    return finish(base, MIGRATION_CODES.RUNTIME_TYPE_REQUIRED,
      '必须显式给出 runtimeType（这批模型按哪种协议说话）。' +
      '老数据里没有这个字段，而**猜它以错误的协议发请求，比拒绝迁移坏得多**。')
  }
  const rt = runtimeType.trim()

  const knownProfileIds = new Set(existingProfiles.map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean))
  const knownBindings = new Set(existingBindings.map((b) => `${b?.scope ?? ''}\u0000${b?.employeeRole ?? b?.role ?? ''}`))

  /** id → 产生它的 (provider, model)；用来检测归一化撞车。 */
  const idOwner = new Map()
  /** 已经计划创建的 profile，避免同一对 (provider, model) 被计划两次。 */
  const planned = new Map()

  for (const [i, row] of legacyRows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      base.refused.push({ index: i, code: MIGRATION_CODES.BAD_SOURCE, reason: '这一行不是对象' })
      continue
    }

    // ① 密钥门禁：源数据里**不该**有任何密钥。出现就拒绝这一行并报出来，
    //    不要"跳过它继续"——那会让一次泄漏看起来像一次成功的迁移。
    const badKeys = Object.keys(row).filter((k) => SECRET_ISH_KEYS.includes(k.toLowerCase()))
    const badValues = Object.entries(row).filter(([k, v]) => !SECRET_ISH_KEYS.includes(k.toLowerCase()) && looksLikeSecretValue(v))
    if (badKeys.length > 0 || badValues.length > 0) {
      base.refused.push({
        index: i,
        code: MIGRATION_CODES.SECRET_IN_SOURCE,
        reason: badKeys.length > 0
          ? `这一行带了疑似密钥字段：${badKeys.join(', ')}。非敏感配置迁移不该看到这些字段`
          : `这一行的 ${badValues.map(([k]) => k).join(', ')} 看起来是密钥值。迁移只搬非敏感配置`,
      })
      continue
    }

    const scope = typeof row.scope === 'string' && row.scope.trim() !== '' ? row.scope.trim() : null
    const role = typeof row.role === 'string' && row.role.trim() !== '' ? row.role.trim() : null
    const provider = typeof row.provider === 'string' && row.provider.trim() !== '' ? row.provider.trim() : null
    const model = typeof row.model === 'string' && row.model.trim() !== '' ? row.model.trim() : null

    if (provider === null || model === null) {
      // 老数据允许 provider/model 为空（列上没 NOT NULL），那是"没配过"而不是"配错了"。
      base.skipped.push({ index: i, scope, role, reason: '这一行没有完整的 provider/model，按"未配置"跳过' })
      continue
    }

    const id = profileIdFor(provider, model)
    // ② 撞车检测必须在"已计划"和"已存在"之间一起做。
    const owner = `${provider}\u0000${model}`
    const prev = idOwner.get(id)
    if (prev !== undefined && prev !== owner) {
      const [p1, m1] = prev.split('\u0000')
      const [p2, m2] = owner.split('\u0000')
      base.conflicts.push({
        id, a: { provider: p1, model: m1 }, b: { provider: p2, model: m2 },
      })
      continue
    }
    idOwner.set(id, owner)

    if (!planned.has(id) && !knownProfileIds.has(id)) {
      planned.set(id, { provider, model })
      // 用**权威校验器**构造与校验，而不是在这里再写一份规则。
      const candidate = { id, displayName: `${provider} / ${model}`, runtimeType: rt, provider, model }
      const res = validateProfile(candidate)
      if (!res.ok) {
        base.refused.push({ index: i, code: 'MIGRATION_INVALID_PROFILE', reason: res.errors.join('；') })
        planned.delete(id)
        continue
      }
      base.toCreate.push(res.value)
      // ③ endpoint 与凭证**都不猜**：它们必须由用户补，这里只说清楚缺什么。
      base.needsAttention.push({
        id,
        missing: ['endpoint', 'credential'],
        why: '老数据里没有 endpoint，也没有凭证引用。迁移**不猜**这两个——' +
          '猜出来的档案会看起来可用，直到第一次运行才失败。',
      })
    } else if (knownProfileIds.has(id)) {
      base.skipped.push({ index: i, scope, role, id, reason: '同 id 的档案已存在，不覆盖（迁移不修改既有配置）' })
    }

    // ④ 岗位绑定：这才是"哪个岗位用哪个模型"的载体。
    if (scope !== null && role !== null) {
      const bkey = `${scope}\u0000${role}`
      if (knownBindings.has(bkey)) {
        base.skipped.push({ index: i, scope, role, reason: '这个 (scope, 岗位) 已有绑定，不覆盖' })
      } else if (!base.toBind.some((b) => `${b.scope}\u0000${b.employeeRole}` === bkey)) {
        base.toBind.push({ scope, employeeRole: role, primaryProfile: id, fallbackProfiles: [] })
      }
    } else {
      base.skipped.push({ index: i, scope, role, reason: '这一行没有 scope 或岗位，无法形成岗位绑定' })
    }
  }

  // 撞车不是"少建一个"，而是**两个不同的模型被合并**：必须拒绝整个计划。
  if (base.conflicts.length > 0) {
    return finish(base, MIGRATION_CODES.ID_COLLISION,
      '归一化后有多个不同的模型落到了同一个档案 id 上。这是一次**静默合并**——' +
      '两个岗位会被绑到同一个档案，而其中一个的模型名会消失。请先给其中一个显式指定 id。')
  }
  if (base.refused.some((r) => r.code === MIGRATION_CODES.SECRET_IN_SOURCE)) {
    return finish(base, MIGRATION_CODES.SECRET_IN_SOURCE,
      '源数据里出现了疑似密钥。非敏感配置迁移不该看到密钥——请先查清它是怎么进去的。')
  }
  return finish(base, MIGRATION_CODES.OK, null)
}

function finish(acc, code, message) {
  const ok = code === MIGRATION_CODES.OK
  const plan = {
    ok,
    code,
    message,
    toCreate: Object.freeze(acc.toCreate),
    toBind: Object.freeze(acc.toBind),
    needsAttention: Object.freeze(acc.needsAttention),
    skipped: Object.freeze(acc.skipped),
    refused: Object.freeze(acc.refused),
    conflicts: Object.freeze(acc.conflicts),
    /** 计划里没有任何写入动作——调用方据此避免弹一个"确认"给用户。 */
    empty: acc.toCreate.length === 0 && acc.toBind.length === 0,
    /** 有待补项时必须让用户看见，否则他会以为迁移完就配好了。 */
    hasAttention: acc.needsAttention.length > 0,
  }
  return Object.freeze({ ...plan, digest: digestOf(plan) })
}

/**
 * 计划指纹。
 *
 * ## 为什么必须有它
 *
 * 用户在界面上看了一份计划，点了确认，然后服务端才去执行。这中间**源数据可能变了**
 * （另一个窗口又配了一个岗位、上次迁移已经跑过一半）。这时有两种错法：
 *
 *   * 按**客户端送回来的**计划执行 → 那份计划可能是过期的，甚至是伪造的；
 *   * 按**服务端重新算的**计划执行 → 用户确认的和他实际得到的**不是同一件事**。
 *
 * 两种都不行。所以：**服务端重算，然后要求它与用户确认的那一份逐字节相同**；
 * 不同就拒绝并让用户重新看一眼。这与本仓库别处的 CAS 是同一个纪律
 * （版本不符时报冲突，而不是"替你决定用哪一版"）。
 *
 * 指纹只覆盖**会造成写入的内容**：要建哪些档案、要建哪些绑定。
 */
export function digestOf(plan) {
  if (plan === null || typeof plan !== 'object') return 'invalid'
  const creates = (plan.toCreate ?? []).map((p) => String(p?.id ?? '')).sort()
  const binds = (plan.toBind ?? []).map((b) => `${b?.scope ?? ''}\u0000${b?.employeeRole ?? ''}\u0000${b?.primaryProfile ?? ''}`).sort()
  const payload = JSON.stringify({ creates, binds })
  // 简易 FNV-1a：这里要的是"不同内容给不同指纹"，不是密码学强度。
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${creates.length}.${binds.length}.${h.toString(16).padStart(8, '0')}`
}

/** 一句给人看的总述。**不允许出现"迁移完成"这种会掩盖待补项的措辞。** */
export function describeMigration(plan) {
  if (plan === null || typeof plan !== 'object') return '没有迁移计划。'
  if (plan.ok !== true) return `迁移计划不可执行（${plan.code}）：${plan.message ?? ''}`
  if (plan.empty) return '没有需要迁移的模型配置。'
  const parts = [
    `将新建 ${plan.toCreate.length} 个模型档案`,
    `建立 ${plan.toBind.length} 个岗位绑定`,
  ]
  if (plan.needsAttention.length > 0) {
    parts.push(`${plan.needsAttention.length} 个档案需要补 endpoint 与凭证**才能运行**`)
  }
  if (plan.skipped.length > 0) parts.push(`${plan.skipped.length} 项按原样保留`)
  return `${parts.join('，')}。`
}

/**
 * 执行迁移。
 *
 * 纪律：
 *   * **只增不改**——已存在的档案与绑定一律跳过（迁移不是"把老的盖掉"）；
 *   * **绝不删除源**——源数据保留到用户显式确认之后；
 *   * **必须对齐用户确认过的那一份**（`expectedDigest`）；
 *   * 中途失败时**把已完成的写清楚**，而不是假装什么都没发生
 *     （用户需要知道"迁移到一半"，否则会重复跑）。
 *
 * @param {object} plan 服务端**重新计算**的计划（不是客户端送回来的那份）
 * @param {object} opts
 * @param {string} [opts.expectedDigest] 用户在界面上看到并确认的计划的指纹
 */
export async function applyModelMigration(plan, { modelStore, bindingStore, actor, expectedDigest = null } = {}) {
  if (plan?.ok !== true) {
    return { ok: false, code: plan?.code ?? MIGRATION_CODES.BAD_SOURCE, message: plan?.message ?? '没有可执行的计划', created: [], bound: [], failed: null }
  }
  // 用户确认的那一份与服务端现在算出来的这一份必须**逐字节相同**。
  // 不同就意味着这中间源数据变了——此时按哪一份执行都是错的：
  //   按客户端的 → 那份可能已经过期；
  //   按服务端的 → 用户确认的和他得到的是两件事。
  if (expectedDigest !== null && expectedDigest !== '' && expectedDigest !== plan.digest) {
    return {
      ok: false,
      code: MIGRATION_CODES.PLAN_STALE,
      message: '这份计划在确认之后已经变了（源数据被改过，或上次迁移已经跑过一半）。' +
        '为避免执行一份你没看过的计划，这里**不继续**——请重新看一眼再确认。',
      created: [], bound: [], failed: null,
      expectedDigest, actualDigest: plan.digest,
    }
  }
  const created = []
  const bound = []
  try {
    for (const profile of plan.toCreate) {
      modelStore.create(profile, { actor })
      created.push(profile.id)
    }
    for (const b of plan.toBind) {
      bindingStore.upsert({ ...b, perRunBudget: null }, { actor })
      bound.push(`${b.scope}/${b.employeeRole}`)
    }
  } catch (e) {
    // 半途失败必须**如实报告已写入的部分**：报成"整体失败"会让用户重跑，
    // 而重跑会因为"已存在"而跳过——于是他永远不知道第一次到底做成了什么。
    return {
      ok: false,
      code: e?.code ?? 'MIGRATION_PARTIAL',
      message: `迁移中途失败：${e?.message ?? String(e)}`,
      created, bound, failed: { created: created.length, bound: bound.length },
    }
  }
  return { ok: true, code: MIGRATION_CODES.OK, message: null, created, bound, failed: null }
}

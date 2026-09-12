// team-hub/binding-store.mjs
// ============================================================================
// 岗位模型绑定的存储与解析（PRT-502，spec §6.6）
//
// 表：`employee_model_bindings(scope, employee_role, ...)` —— 键是
// **(scope, employee_role)**，因为"编码岗在这个空间用哪个模型"与
// "编码岗在另一个空间用哪个模型"是两条独立的配置。
//
// 判定逻辑全在 `orchestrator/model-binding/index.mjs`（纯函数，可单独验）。
// 本模块只做三件事：读、写、把档案喂给那个纯函数。
//
// ── 三条设计 ──
//
//   ① **解析时读的是"现在的档案"，落库的是"当时的顺序"。**
//      spec §6.7「密钥轮换只影响轮换后创建的 Run」在这里的对应物是：
//      一次 Run 启动时把 `chainSnapshot` 记进它的证据里。拿现在的配置去反推
//      三个月前那次运行用了什么模型，答案一定是错的。
//
//   ② **解析不缓存。** 每次解析都重读档案。缓存会让"档案下线了但解析还在
//      返回它"持续存在，而这一段的时长取决于缓存策略——一个"改了配置但不生效、
//      过一会儿又生效"的现象。这条路径不在热路上（每次 Run 开始解析一次）。
//
//   ③ **删除绑定是物理删除，档案删除是墓碑。** 两者不对称是**有意的**：
//      档案会被历史 Run 引用（所以要留墓碑），绑定不会——绑定只是"现在
//      该用哪个"，历史 Run 记的是解析出来的顺序快照，不是绑定本身。
// ============================================================================

import { resolveModelChain, validatePerRunBudget, BINDING_ERRORS, BindingError } from '../orchestrator/model-binding/index.mjs'

export const BINDING_STORE_ERRORS = Object.freeze({
  BINDING_NOT_FOUND: 'BINDING_NOT_FOUND',
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  SCOPE_REQUIRED: 'SCOPE_REQUIRED',
  BINDING_EXISTS: 'BINDING_EXISTS',
  ACTOR_REQUIRED: 'ACTOR_REQUIRED',
  PRIMARY_UNRESOLVED: 'PRIMARY_UNRESOLVED',
  UNKNOWN_PROFILE: 'UNKNOWN_PROFILE',
})

export class BindingStoreError extends Error {
  constructor(code, message, { statusCode = 400, ...extra } = {}) {
    super(message)
    this.name = 'BindingStoreError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

export function ensureBindingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_model_bindings (
      scope TEXT NOT NULL,
      employee_role TEXT NOT NULL,
      primary_profile TEXT NOT NULL,
      fallback_profiles_json TEXT NOT NULL DEFAULT '[]',
      per_run_budget_json TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, employee_role)
    )
  `)
}

function safeArray(text) {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch {
    // 坏掉的 fallback 列表**不能**当成"没有备用"：那会让容错余量静默归零。
    // 交给上层如实报出来（`unreadableFallbacks`）。
    return null
  }
}

function safeBudget(text) {
  if (text === null || text === undefined || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return undefined // 哨兵：读不出来
  }
}

function rowToBinding(r) {
  if (r === undefined) return null
  const fallbacks = safeArray(r.fallback_profiles_json)
  const budget = safeBudget(r.per_run_budget_json)
  return {
    scope: r.scope,
    employeeRole: r.employee_role,
    primaryProfile: r.primary_profile,
    fallbackProfiles: fallbacks ?? [],
    perRunBudget: budget === undefined ? null : budget,
    updatedAtMs: Number(r.updated_at_ms),
    // 读不出来的东西必须**可见**，不能假装它不存在
    fallbackProfilesUnreadable: fallbacks === null,
    perRunBudgetUnreadable: budget === undefined,
  }
}

/**
 * 建绑定仓储。
 *
 * `readProfiles` 由调用方注入（返回档案描述数组，**含墓碑**）。
 * 注入而不是让本模块 import `model-store.mjs`：档案的存储形状属于那边，
 * 而本模块只想要"一批可用的档案描述"。
 */
export function createBindingStore({ db, clock = () => Date.now(), readProfiles, writeAudit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createBindingStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createBindingStore 的 clock 必须是函数')
  if (typeof readProfiles !== 'function') {
    throw new TypeError('createBindingStore 需要 readProfiles：没有档案来源时解析只能凭空猜')
  }
  ensureBindingSchema(db)

  function audit(payload) {
    if (typeof writeAudit === 'function') writeAudit(payload)
  }

  function requireActor(actor) {
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new BindingStoreError(BINDING_STORE_ERRORS.ACTOR_REQUIRED,
        '缺少 actor：谁改了岗位的模型绑定必须留痕')
    }
    return actor.trim()
  }

  function requireKey({ scope, employeeRole }) {
    if (typeof scope !== 'string' || scope.trim() === '') {
      throw new BindingStoreError(BINDING_STORE_ERRORS.SCOPE_REQUIRED, '缺少 scope')
    }
    if (typeof employeeRole !== 'string' || employeeRole.trim() === '') {
      throw new BindingStoreError(BINDING_STORE_ERRORS.ROLE_REQUIRED,
        '缺少 employeeRole：绑定是"某个岗位用哪个模型"，没有岗位就没有主语')
    }
    return { scope: scope.trim(), employeeRole: employeeRole.trim() }
  }

  function list(scope = null) {
    const rows = scope === null
      ? db.prepare('SELECT * FROM employee_model_bindings ORDER BY scope, employee_role').all()
      : db.prepare('SELECT * FROM employee_model_bindings WHERE scope = ? ORDER BY employee_role').all(scope)
    return Object.freeze(rows.map(rowToBinding))
  }

  function get(scope, employeeRole) {
    const key = requireKey({ scope, employeeRole })
    return rowToBinding(
      db.prepare('SELECT * FROM employee_model_bindings WHERE scope = ? AND employee_role = ?').get(key.scope, key.employeeRole),
    )
  }

  /**
   * 写入绑定（建或整体替换）。
   *
   * **写入时就要验主档案能解析**。等到运行时才发现 `primaryProfile` 打错了，
   * 那次运行已经认领了任务、烧掉了一次尝试；而且错误会出现在运行日志里，
   * 而不是出现在"保存配置"这个动作上——后者才是真正能改的地方。
   */
  function upsert(input, { actor } = {}) {
    requireActor(actor)
    const key = requireKey(input)
    const fallbacks = input.fallbackProfiles ?? []
    if (!Array.isArray(fallbacks)) {
      throw new BindingStoreError(BINDING_ERRORS.FALLBACKS_NOT_ARRAY,
        'fallbackProfiles 必须是数组')
    }
    const budget = validatePerRunBudget(input.perRunBudget ?? null)
    if (!budget.ok) {
      throw new BindingStoreError(BINDING_ERRORS.BUDGET_INVALID,
        `perRunBudget 不合法：${budget.errors.join('；')}`, { errors: budget.errors })
    }

    // 先按"现在的档案"试解析一次。主档案不可用就直接拒——不把一条跑不起来的
    // 绑定存进库，等到某次运行才发现。
    const profiles = readProfiles()
    const probe = resolveModelChain({
      binding: {
        employeeRole: key.employeeRole,
        primaryProfile: input.primaryProfile,
        fallbackProfiles: fallbacks,
        perRunBudget: budget.value,
      },
      profiles,
    })
    if (!probe.ok) {
      throw new BindingStoreError(BINDING_STORE_ERRORS.PRIMARY_UNRESOLVED, probe.message, {
        statusCode: 409, // 引用的档案状态与请求不符 → 冲突，而不是"参数格式错"
        skipped: probe.skipped,
        errors: probe.errors,
      })
    }

    const nowMs = clock()
    const existing = get(key.scope, key.employeeRole)
    db.prepare(
      `INSERT INTO employee_model_bindings
        (scope, employee_role, primary_profile, fallback_profiles_json, per_run_budget_json, updated_at_ms)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(scope, employee_role) DO UPDATE SET
         primary_profile = excluded.primary_profile,
         fallback_profiles_json = excluded.fallback_profiles_json,
         per_run_budget_json = excluded.per_run_budget_json,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(
      key.scope, key.employeeRole, probe.chain[0].id,
      JSON.stringify(fallbacks),
      budget.value === null ? null : JSON.stringify(budget.value),
      nowMs,
    )
    // 复读确认：写进去的与解析出来的必须一致，否则"保存成功"是假的。
    const after = get(key.scope, key.employeeRole)
    if (after === null || after.primaryProfile !== probe.chain[0].id) {
      throw new BindingStoreError(BINDING_STORE_ERRORS.BINDING_NOT_FOUND,
        '绑定写入后复读不一致：保存没有生效', { statusCode: 500 })
    }
    audit({
      action: existing === null ? 'model-binding.create' : 'model-binding.update',
      scope: key.scope, employeeRole: key.employeeRole, actor,
      detail: {
        primaryProfile: probe.chain[0].id,
        // 只记**被跳过的**备用（配置问题要留痕），不记每个备用的完整值
        fallbackCount: fallbacks.length,
        skippedFallbacks: probe.skipped.filter((s) => s.role === 'fallback').map((s) => ({ id: s.id, code: s.code })),
        hasBudget: budget.value !== null,
      },
    })
    return after
  }

  function remove(scope, employeeRole, { actor } = {}) {
    requireActor(actor)
    const key = requireKey({ scope, employeeRole })
    const existing = get(key.scope, key.employeeRole)
    if (existing === null) {
      throw new BindingStoreError(BINDING_STORE_ERRORS.BINDING_NOT_FOUND,
        `没有这个岗位绑定：${key.scope}/${key.employeeRole}`, { statusCode: 404 })
    }
    // 物理删除（与档案的墓碑不对称，见模块头 ③）：绑定只是"现在该用哪个"，
    // 历史 Run 记的是解析出来的顺序快照，不是绑定本身。
    db.prepare('DELETE FROM employee_model_bindings WHERE scope = ? AND employee_role = ?')
      .run(key.scope, key.employeeRole)
    audit({
      action: 'model-binding.delete', scope: key.scope, employeeRole: key.employeeRole, actor,
      detail: { primaryProfile: existing.primaryProfile, fallbackCount: existing.fallbackProfiles.length },
    })
    return Object.freeze({ ok: true, scope: key.scope, employeeRole: key.employeeRole, deleted: true })
  }

  /**
   * 解析某岗位此刻该依次尝试哪些模型。
   *
   * 每次重读档案（见模块头 ②）。绑定不存在时**不是**错误：那表示这个岗位
   * 用平台默认，由调用方决定默认是什么——本模块不替它编一个。
   */
  function resolve(scope, employeeRole) {
    const key = requireKey({ scope, employeeRole })
    const b = get(key.scope, key.employeeRole)
    if (b === null) {
      return Object.freeze({
        ok: false,
        code: BINDING_STORE_ERRORS.BINDING_NOT_FOUND,
        message: `岗位 ${key.scope}/${key.employeeRole} 没有模型绑定（用平台默认还是报错由调用方决定）`,
        employeeRole: key.employeeRole, scope: key.scope,
        chain: Object.freeze([]), skipped: Object.freeze([]),
        perRunBudget: null, errors: Object.freeze([]),
      })
    }
    // 坏掉的持久化数据必须**先**报出来：`fallbackProfilesUnreadable` 表示
    // 存进去的 JSON 已经读不回来了，此时把它当成"没有备用"会让容错余量静默归零。
    if (b.fallbackProfilesUnreadable || b.perRunBudgetUnreadable) {
      return Object.freeze({
        ok: false,
        code: BINDING_STORE_ERRORS.BINDING_EXISTS, // 数据坏了：需要人工处置
        message: `岗位 ${key.scope}/${key.employeeRole} 的绑定数据读不出来` +
          `${b.fallbackProfilesUnreadable ? '（fallbackProfiles）' : ''}` +
          `${b.perRunBudgetUnreadable ? '（perRunBudget）' : ''}：` +
          '不能当成"没有备用"继续——那会让容错余量静默归零',
        employeeRole: key.employeeRole, scope: key.scope,
        chain: Object.freeze([]), skipped: Object.freeze([]),
        perRunBudget: null, errors: Object.freeze(['绑定数据已损坏']),
      })
    }
    const r = resolveModelChain({
      binding: {
        employeeRole: b.employeeRole,
        primaryProfile: b.primaryProfile,
        fallbackProfiles: b.fallbackProfiles,
        perRunBudget: b.perRunBudget,
      },
      profiles: readProfiles(),
    })
    return Object.freeze({ ...r, scope: key.scope })
  }

  return Object.freeze({ list, get, upsert, remove, resolve })
}

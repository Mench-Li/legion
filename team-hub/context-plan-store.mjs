// team-hub/context-plan-store.mjs
// ============================================================================
// TeamPlan 与 EmployeeManifest 的存储与读面（PRT-402 的数据面）
//
// ## 为什么这个模块现在才出现
//
// `runtime/context/sources.mjs` 的两个来源函数（`teamPlanSource` /
// `employeeManifestSource`）从 PRT-402 那批起就**做全了**，而且两条都是
// `required: true`。但 hub 没有它们的读端点，于是 `sources-loader.mjs` 只能
// 传 `null`，装配器于是**每次运行**都产出两条 `missing` 候选：
//
//     team-plan:missing        这次运行没有关联任何团队计划
//     employee-manifest:missing 这次运行没有关联任何员工清单
//
// 那两条不是"世界就是这样"，是"产品的这一块还没做"。两者的区别在账本上
// 看不出来——除非有人把 `UNSERVED_SOURCE_FAMILIES` 列出来。本模块把那两条
// 从"还没做"变成"有了"，于是剩下的 `missing` 才真的表示"这次确实没有"。
//
//   > 一个"每次运行都缺两条必需来源"的产品，
//   > 与一个"这次运行确实没有团队计划"的运行，在快照上长得一模一样——
//   > 只不过前者的那两条缺失**永远**不会消失，于是没有人会去看它们。
//
// ## 三条设计
//
// ### ① TeamPlan 是**冻结**的：按 (scope, id, version) 追加，同版重写必须逐字相同
//
// spec 第 7 行的术语把 TeamPlan 定义为「目标创建时**冻结**的团队、岗位、流水线
// 和能力包组合快照」。冻结不是"我们打算不改"，是**结构上改不了**：
//
//   · 同一个 `(scope, id, version)` 再写一次，内容逐字相同 → 幂等成功；
//   · 内容不同 → `PLAN_FROZEN`（409），要改就发新版本。
//
// 于是"当时那次运行看到的是哪一版计划"永远答得出来——快照里记了 version，
// 而那一版还在。若允许原地改写，历史记录指向的就会是**今天的**计划，
// 而它看起来完全正常。（与 PRT-511 价目表"发布不可覆盖"同一条纪律。）
//
// ### ② EmployeeManifest 是**活的**：更新原地生效，但 `version` 必须递增
//
// 岗位边界是会变的（新工具、新审批策略）。所以它不做追加冻结。
// 但 `version` **由服务端递增**，不接受调用方指定：
//
//   `sources.mjs` 用 `manifest.version ?? manifest.updatedAtMs` 当来源版本，
//   于是"边界变过没有"直接决定快照哈希。让调用方随便填 version 的后果是
//   一次边界变更**不改变**快照哈希——两份内容不同的上下文被认成同一份。
//
// ### ③ 写入前用**同一个** `findPlaintextSecrets` 查一遍，命中就拒收（fail closed）
//
// 这两张表里的内容会**逐字进模型上下文**（`sources.mjs` 把 manifest
// `stableRecord` 成文本塞进 `content`）。所以一个写进 manifest 的明文密钥
// 不是"存在本地库里"，而是**被发给供应商**——比日志里出现密钥严重一级
// （日志还在本机、能删能轮换；发出去撤不回来）。
//
// 拒绝而不是脱敏：脱敏是过滤器，只能拦下它认得的形态，而模式表是有限的。
// 这与 model-store 第 ④ 条是同一套判据——两处用**同一个函数**，
// 免得"哪一份模式表更新了"变成一个要记住的问题。
// ============================================================================

import { findPlaintextSecrets } from '../runtime/contracts/model.mjs'

/** 本模块的具名错误码。`code` 给程序看，`statusCode` 给调用方看。 */
export const CONTEXT_PLAN_ERRORS = Object.freeze({
  PLAN_NOT_FOUND: 'TEAM_PLAN_NOT_FOUND',
  PLAN_INVALID: 'TEAM_PLAN_INVALID',
  /** 同一版本想改成别的样子——冻结的东西不能被改写。 */
  PLAN_FROZEN: 'TEAM_PLAN_FROZEN',
  MANIFEST_NOT_FOUND: 'EMPLOYEE_MANIFEST_NOT_FOUND',
  MANIFEST_INVALID: 'EMPLOYEE_MANIFEST_INVALID',
  /** 载荷里出现疑似明文密钥。 */
  PLAINTEXT_SECRET: 'CONTEXT_SOURCE_PLAINTEXT_SECRET',
  SCOPE_UNKNOWN: 'CONTEXT_SOURCE_SCOPE_UNKNOWN',
})

export class ContextPlanError extends Error {
  constructor(code, message, { statusCode = 400, ...extra } = {}) {
    super(message)
    this.name = 'ContextPlanError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

/**
 * 建表。**表结构与"什么算一条合法记录"是同一份知识**，所以它住在这里，
 * 由 `server.mjs` 与夹具调用——不在生产里建一份、夹具里抄一份。
 */
export function ensureContextPlanSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_plans (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      goal_id TEXT,
      title TEXT DEFAULT '',
      objective TEXT DEFAULT '',
      stages_json TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, id, version)
    )
  `)
  // 按 goalId 取"这次运行该用哪一版"是热路径（每次装配一次），
  // 而 `(scope, id, version)` 那个主键对它是**用不上**的。
  db.exec('CREATE INDEX IF NOT EXISTS idx_team_plans_goal ON team_plans (scope, goal_id, version)')

  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_manifests (
      scope TEXT NOT NULL,
      role TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      responsibilities_json TEXT NOT NULL DEFAULT '[]',
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      denied_tools_json TEXT NOT NULL DEFAULT '[]',
      approval_policy TEXT,
      limits_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, role)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_employee_manifests_emp ON employee_manifests (scope, employee_id)')
}

// ---------------------------------------------------------------- 形状工具

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 必填的非空字符串。 */
function requireString(v, field, code, what) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ContextPlanError(code, `${what} 的 \`${field}\` 必须是非空字符串`, { field })
  }
  return v.trim()
}

/** 可选的字符串；给了空串按"没给"处理。 */
function optionalString(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** 字符串数组。**不是数组就报错**，不把单值悄悄包成数组。 */
function stringArray(v, field, code, what, { fallback = [] } = {}) {
  if (v === null || v === undefined) return [...fallback]
  if (!Array.isArray(v)) {
    throw new ContextPlanError(code, `${what} 的 \`${field}\` 必须是数组`, { field })
  }
  const out = []
  for (const x of v) {
    if (typeof x !== 'string' || x.trim() === '') {
      throw new ContextPlanError(code, `${what} 的 \`${field}\` 里每一项都必须是非空字符串`, { field })
    }
    out.push(x.trim())
  }
  return out
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

/**
 * 拒绝疑似明文密钥（fail closed）。理由见文件头 ③。
 *
 * ★ 调用点**两处都要查**：`raw`（归一化**之前**的原始输入）与 `normalized`。
 *
 * 只查归一化后的对象是不够的，这是写测试时量出来的：
 * `normalizeTeamPlan` 会**丢掉未知字段**，于是一个被塞进
 * `plan.apiKey` 的明文密钥在归一化后就不见了——检查什么都看不到。
 *
 * 丢掉当然比存下来安全，但**静默丢掉**是这里最坏的处置：调用方提交了一个
 * 密钥、收到 200、以为它存下了。而它真正该收到的是一句"你在往计划里塞密钥"。
 *
 *   > 一个"归一化后再查明文密钥"的检查，
 *   > 与一个"归一化前也查"的检查，在用户规规矩矩填 `note` 时是同一个东西——
 *   > 只不过前者会把"往 payload 里塞了一个密钥"这件事**静默地做成一次无害的丢弃**，
 *   > 而调用方从响应里看不出任何异常。
 */
function assertNoPlaintextSecrets(raw, normalized, what) {
  for (const [label, value] of [['提交的载荷', raw], ['归一化后的内容', normalized]]) {
    const hits = findPlaintextSecrets(value)
    if (Array.isArray(hits) && hits.length > 0) {
      throw new ContextPlanError(
        CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
        `${what} 的${label}里出现疑似明文密钥（${hits.join('、')}）：`
        + '这段内容会**逐字进模型上下文**并被发给供应商，不是"存在本地库里"。'
        + '密钥只能以引用（`secretRef`）的形式出现。',
        { fields: hits },
      )
    }
  }
}

// ---------------------------------------------------------------- 行映射

function rowToPlan(r) {
  if (r === undefined || r === null) return null
  return Object.freeze({
    id: r.id,
    scope: r.scope,
    version: Number(r.version),
    goalId: r.goal_id ?? null,
    title: r.title ?? '',
    objective: r.objective ?? '',
    stages: Object.freeze(parseJson(r.stages_json, [])),
    note: r.note ?? '',
    createdAtMs: Number(r.created_at_ms),
  })
}

function rowToManifest(r) {
  if (r === undefined || r === null) return null
  return Object.freeze({
    employeeId: r.employee_id,
    role: r.role,
    scope: r.scope,
    displayName: r.display_name ?? '',
    responsibilities: Object.freeze(parseJson(r.responsibilities_json, [])),
    allowedTools: Object.freeze(parseJson(r.allowed_tools_json, [])),
    deniedTools: Object.freeze(parseJson(r.denied_tools_json, [])),
    approvalPolicy: r.approval_policy ?? null,
    limits: Object.freeze(parseJson(r.limits_json, {})),
    version: Number(r.version),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
  })
}

/**
 * 归一化 TeamPlan 输入。
 *
 * `stages` 必须显式给出：一份"团队计划"没有岗位序列就不是计划，
 * 而一个默认成 `[]` 的字段会让"忘了填"看起来像"这个计划没有阶段"。
 */
export function normalizeTeamPlan(input) {
  if (!isPlainObject(input)) {
    throw new ContextPlanError(CONTEXT_PLAN_ERRORS.PLAN_INVALID, 'TeamPlan 必须是对象')
  }
  const id = requireString(input.id ?? input.planId, 'id', CONTEXT_PLAN_ERRORS.PLAN_INVALID, 'TeamPlan')
  const rawVersion = input.version
  if (!Number.isInteger(rawVersion) || rawVersion < 1) {
    throw new ContextPlanError(
      CONTEXT_PLAN_ERRORS.PLAN_INVALID,
      'TeamPlan 的 `version` 必须是 >= 1 的整数：'
      + '冻结是按版本冻结的，没有版本就没有"冻结的是哪一份"',
      { field: 'version' },
    )
  }
  if (!Array.isArray(input.stages)) {
    throw new ContextPlanError(
      CONTEXT_PLAN_ERRORS.PLAN_INVALID,
      'TeamPlan 的 `stages` 必须是数组（岗位序列是这份计划的主干）',
      { field: 'stages' },
    )
  }
  return Object.freeze({
    id,
    version: rawVersion,
    goalId: optionalString(input.goalId),
    title: optionalString(input.title) ?? '',
    objective: optionalString(input.objective) ?? '',
    stages: Object.freeze(input.stages.map((s, i) => {
      if (typeof s === 'string') {
        if (s.trim() === '') {
          throw new ContextPlanError(CONTEXT_PLAN_ERRORS.PLAN_INVALID, `TeamPlan 的 stages[${i}] 是空字符串`, { field: 'stages' })
        }
        return Object.freeze({ role: s.trim() })
      }
      if (!isPlainObject(s)) {
        throw new ContextPlanError(CONTEXT_PLAN_ERRORS.PLAN_INVALID, `TeamPlan 的 stages[${i}] 必须是字符串或对象`, { field: 'stages' })
      }
      // `field` 一律报顶层那个要改的字段（`stages`），不是嵌套的 `role`。
      // 调用方拿 `field` 是要知道**该去改哪儿**，而它手上只有一份 stages 数组；
      // 报 `role` 会让它去找一个顶层不存在的字段。细节在 `message` 里。
      if (typeof s.role !== 'string' || s.role.trim() === '') {
        throw new ContextPlanError(
          CONTEXT_PLAN_ERRORS.PLAN_INVALID,
          `TeamPlan 的 stages[${i}].role 必须是非空字符串`, { field: 'stages' },
        )
      }
      return Object.freeze({ ...s, role: s.role.trim() })
    })),
    note: optionalString(input.note) ?? '',
  })
}

/**
 * 归一化 EmployeeManifest 输入。
 *
 * `employeeId` **必须显式给**，不从 `role` 兜底。理由不是洁癖：它会进快照的
 * `associations.employeeId`，而那是"这次运行是谁在干"的答案。
 *
 *   > 一个"没给 employeeId 就替你填上 role"的写入路径，
 *   > 与一个"要求显式给出身份"的写入路径，在只有一种岗位的时候是同一个东西——
 *   > 只不过前者会把一个**猜测**写进快照，而那个字段是给人看的。
 */
export function normalizeEmployeeManifest(input) {
  if (!isPlainObject(input)) {
    throw new ContextPlanError(CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest 必须是对象')
  }
  const role = requireString(input.role, 'role', CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest')
  const employeeId = requireString(
    input.employeeId, 'employeeId', CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest',
  )
  const limits = input.limits === null || input.limits === undefined ? {} : input.limits
  if (!isPlainObject(limits)) {
    throw new ContextPlanError(CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest 的 `limits` 必须是对象', { field: 'limits' })
  }
  return Object.freeze({
    role,
    employeeId,
    displayName: optionalString(input.displayName) ?? '',
    responsibilities: Object.freeze(stringArray(
      input.responsibilities, 'responsibilities', CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest',
    )),
    allowedTools: Object.freeze(stringArray(
      input.allowedTools, 'allowedTools', CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest',
    )),
    deniedTools: Object.freeze(stringArray(
      input.deniedTools, 'deniedTools', CONTEXT_PLAN_ERRORS.MANIFEST_INVALID, 'EmployeeManifest',
    )),
    approvalPolicy: optionalString(input.approvalPolicy),
    limits: Object.freeze({ ...limits }),
  })
}

// ---------------------------------------------------------------- store

/**
 * 创建存储。
 *
 * @param {object} deps
 * @param {object} deps.db 已调用过 {@link ensureContextPlanSchema} 的库
 * @param {() => number} [deps.clock]
 * @param {(payload: object) => void} [deps.writeAudit] 对象形态的审计写入（同 modelStore）
 */
export function createContextPlanStore({ db, clock = () => Date.now(), writeAudit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createContextPlanStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createContextPlanStore 的 clock 必须是函数')

  function audit(payload) {
    if (typeof writeAudit !== 'function') return
    // 审计载荷也过一遍明文检查：与写入路径**同一个**判据。
    // 照写需要脱敏逻辑，而脱敏逻辑正是最容易漏的那一环。
    assertNoPlaintextSecrets(payload, null, '审计载荷')
    writeAudit(payload)
  }

  // ── TeamPlan ────────────────────────────────────────────────────────────

  /**
   * 冻结一版团队计划。
   *
   * 幂等：同一 `(scope, id, version)` 且内容逐字相同 → `{ ok:true, idempotent:true }`。
   * 同版不同内容 → `PLAN_FROZEN`。
   */
  function putTeamPlan(input, { scope, actor = null } = {}) {
    const scopeStr = requireString(scope, 'scope', CONTEXT_PLAN_ERRORS.SCOPE_UNKNOWN, 'TeamPlan 写入')
    // ★ **一次调用查两样**：`(raw, normalized)`。第三遍查 raw 是多余的吗？
    //   是——探针⑦量出来的：我第一版在这里写了两行，而第二行的第一个参数
    //   就是 raw，于是第一行**永远不会改变任何结果**。
    //
    //   > 一行"查了原始输入"的调用，与一行"查了原始输入、但紧接着又查了一次
    //   > 同样的东西"的调用，在行为上是同一个东西——只不过后者会让
    //   > "把 raw 那一遍拿掉"的断验证探针**咬不住**，于是那条性质看起来受到了保护。
    const plan = normalizeTeamPlan(input)
    assertNoPlaintextSecrets(input, plan, 'TeamPlan')

    const existing = db.prepare(
      'SELECT * FROM team_plans WHERE scope = ? AND id = ? AND version = ?',
    ).get(scopeStr, plan.id, plan.version)

    if (existing !== undefined && existing !== null) {
      const prev = rowToPlan(existing)
      // 逐字比较**归一化后**的形状：字段的插入顺序不该让"同一份计划"变成两份。
      const same = JSON.stringify({
        goalId: prev.goalId, title: prev.title, objective: prev.objective,
        stages: prev.stages, note: prev.note,
      }) === JSON.stringify({
        goalId: plan.goalId, title: plan.title, objective: plan.objective,
        stages: plan.stages, note: plan.note,
      })
      if (same) {
        return Object.freeze({ ok: true, idempotent: true, plan: prev })
      }
      throw new ContextPlanError(
        CONTEXT_PLAN_ERRORS.PLAN_FROZEN,
        `团队计划 ${plan.id} 的第 ${plan.version} 版已经冻结，且内容与这次提交不同。`
        + '冻结是结构性的：要改就发一个**新版本**，这样历史运行指向的那一版还在。'
        + '原地改写会让三个月前那次运行指向今天的计划，而它看起来完全正常。',
        { statusCode: 409, id: plan.id, version: plan.version },
      )
    }

    const atMs = clock()
    db.prepare(
      `INSERT INTO team_plans
         (scope, id, version, goal_id, title, objective, stages_json, note, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scopeStr, plan.id, plan.version, plan.goalId, plan.title, plan.objective,
      JSON.stringify(plan.stages), plan.note, atMs,
    )
    audit({
      action: 'team-plan.freeze', actor, scope: scopeStr,
      detail: { id: plan.id, version: plan.version, goalId: plan.goalId, stages: plan.stages.length },
    })
    return Object.freeze({ ok: true, idempotent: false, plan: readTeamPlan(plan.id, { scope: scopeStr, version: plan.version }) })
  }

  /**
   * 读一版团队计划。不给 `version` 就取**最新的一版**。
   *
   * `goalId` 是另一条取法：目标创建时冻结的计划，按目标取。
   * 两者都给时 `id` 优先——`id` 是主语，`goalId` 是它挂在哪。
   */
  function readTeamPlan(id, { scope, version = null, goalId = null } = {}) {
    const scopeStr = requireString(scope, 'scope', CONTEXT_PLAN_ERRORS.SCOPE_UNKNOWN, 'TeamPlan 读取')
    if (id !== null && id !== undefined && String(id).trim() !== '') {
      const row = Number.isInteger(version)
        ? db.prepare('SELECT * FROM team_plans WHERE scope = ? AND id = ? AND version = ?').get(scopeStr, String(id).trim(), version)
        : db.prepare('SELECT * FROM team_plans WHERE scope = ? AND id = ? ORDER BY version DESC LIMIT 1').get(scopeStr, String(id).trim())
      return rowToPlan(row)
    }
    if (goalId !== null && goalId !== undefined && String(goalId).trim() !== '') {
      // 按目标取时**必须**取最新版：一次运行该看的是"现在有效的计划"，
      // 而历史版本由快照里的 version 去取（那条路走 `id` + `version`）。
      const row = db.prepare(
        'SELECT * FROM team_plans WHERE scope = ? AND goal_id = ? ORDER BY version DESC LIMIT 1',
      ).get(scopeStr, String(goalId).trim())
      return rowToPlan(row)
    }
    return null
  }

  /** 某个空间里的全部计划（每个 id 只给最新一版），供界面列出。 */
  function listTeamPlans({ scope = null, limit = 100 } = {}) {
    const rows = scope === null
      ? db.prepare(`
          SELECT t.* FROM team_plans t
          JOIN (SELECT scope, id, MAX(version) AS v FROM team_plans GROUP BY scope, id) m
            ON m.scope = t.scope AND m.id = t.id AND m.v = t.version
          ORDER BY t.created_at_ms DESC LIMIT ?
        `).all(limit)
      : db.prepare(`
          SELECT t.* FROM team_plans t
          JOIN (SELECT scope, id, MAX(version) AS v FROM team_plans WHERE scope = ? GROUP BY scope, id) m
            ON m.scope = t.scope AND m.id = t.id AND m.v = t.version
          ORDER BY t.created_at_ms DESC LIMIT ?
        `).all(scope, limit)
    return Object.freeze(rows.map(rowToPlan))
  }

  /** 某个 id 有哪几版（冻结的证据）。 */
  function teamPlanVersions(id, { scope } = {}) {
    const scopeStr = requireString(scope, 'scope', CONTEXT_PLAN_ERRORS.SCOPE_UNKNOWN, 'TeamPlan 版本列表')
    const rows = db.prepare(
      'SELECT version, created_at_ms FROM team_plans WHERE scope = ? AND id = ? ORDER BY version ASC',
    ).all(scopeStr, String(id).trim())
    return Object.freeze(rows.map((r) => Number(r.version)))
  }

  // ── EmployeeManifest ────────────────────────────────────────────────────

  /**
   * 写入或更新一份岗位清单。
   *
   * `version` **由服务端递增**，不接受调用方指定（理由见文件头 ②）。
   */
  function putEmployeeManifest(input, { scope, actor = null } = {}) {
    const scopeStr = requireString(scope, 'scope', CONTEXT_PLAN_ERRORS.SCOPE_UNKNOWN, 'EmployeeManifest 写入')
    // 同上：一次调用查 raw 与归一化结果两样。
    const m = normalizeEmployeeManifest(input)
    assertNoPlaintextSecrets(input, m, 'EmployeeManifest')

    const existing = db.prepare(
      'SELECT * FROM employee_manifests WHERE scope = ? AND role = ?',
    ).get(scopeStr, m.role)

    const atMs = clock()
    if (existing === undefined || existing === null) {
      db.prepare(
        `INSERT INTO employee_manifests
           (scope, role, employee_id, display_name, responsibilities_json, allowed_tools_json,
            denied_tools_json, approval_policy, limits_json, version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        scopeStr, m.role, m.employeeId, m.displayName, JSON.stringify(m.responsibilities),
        JSON.stringify(m.allowedTools), JSON.stringify(m.deniedTools), m.approvalPolicy,
        JSON.stringify(m.limits), atMs, atMs,
      )
      audit({ action: 'employee-manifest.create', actor, scope: scopeStr, detail: { role: m.role, employeeId: m.employeeId } })
      return Object.freeze({ ok: true, created: true, manifest: readEmployeeManifest({ scope: scopeStr, role: m.role }) })
    }

    const nextVersion = Number(existing.version) + 1
    db.prepare(
      `UPDATE employee_manifests
          SET employee_id = ?, display_name = ?, responsibilities_json = ?, allowed_tools_json = ?,
              denied_tools_json = ?, approval_policy = ?, limits_json = ?, version = ?, updated_at_ms = ?
        WHERE scope = ? AND role = ?`,
    ).run(
      m.employeeId, m.displayName, JSON.stringify(m.responsibilities),
      JSON.stringify(m.allowedTools), JSON.stringify(m.deniedTools), m.approvalPolicy,
      JSON.stringify(m.limits), nextVersion, atMs, scopeStr, m.role,
    )
    audit({
      action: 'employee-manifest.update', actor, scope: scopeStr,
      detail: { role: m.role, employeeId: m.employeeId, version: nextVersion },
    })
    return Object.freeze({
      ok: true, created: false, version: nextVersion,
      manifest: readEmployeeManifest({ scope: scopeStr, role: m.role }),
    })
  }

  /**
   * 读一份岗位清单。`role` 优先，其次 `employeeId`。
   *
   * 两者都不给返回 `null` —— 由路由翻成 404，再由装配器翻成一条
   * `missing` 候选。这正是本模块存在要修的那件事：缺**必须**能被说出来。
   */
  function readEmployeeManifest({ scope, role = null, employeeId = null } = {}) {
    const scopeStr = requireString(scope, 'scope', CONTEXT_PLAN_ERRORS.SCOPE_UNKNOWN, 'EmployeeManifest 读取')
    if (role !== null && role !== undefined && String(role).trim() !== '') {
      return rowToManifest(
        db.prepare('SELECT * FROM employee_manifests WHERE scope = ? AND role = ?').get(scopeStr, String(role).trim()),
      )
    }
    if (employeeId !== null && employeeId !== undefined && String(employeeId).trim() !== '') {
      return rowToManifest(
        db.prepare('SELECT * FROM employee_manifests WHERE scope = ? AND employee_id = ? LIMIT 1').get(scopeStr, String(employeeId).trim()),
      )
    }
    return null
  }

  function listEmployeeManifests({ scope = null, limit = 100 } = {}) {
    const rows = scope === null
      ? db.prepare('SELECT * FROM employee_manifests ORDER BY scope, role LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM employee_manifests WHERE scope = ? ORDER BY role LIMIT ?').all(scope, limit)
    return Object.freeze(rows.map(rowToManifest))
  }

  return Object.freeze({
    putTeamPlan, readTeamPlan, listTeamPlans, teamPlanVersions,
    putEmployeeManifest, readEmployeeManifest, listEmployeeManifests,
    /** 两张表各有多少行（冒烟与界面用）。 */
    counts() {
      const p = db.prepare('SELECT COUNT(*) AS n FROM team_plans').get()
      const m = db.prepare('SELECT COUNT(*) AS n FROM employee_manifests').get()
      return Object.freeze({
        teamPlans: Number(p?.n ?? 0),
        teamPlanVersions: Number(p?.n ?? 0),
        employeeManifests: Number(m?.n ?? 0),
      })
    },
  })
}

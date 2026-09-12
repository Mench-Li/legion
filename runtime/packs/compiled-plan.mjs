// runtime/packs/compiled-plan.mjs
// ============================================================================
// PRT-1004：不可变 CompiledTeamPlan 与**运行中版本固定**。
//
// spec §6.13 line 570：
//   「解析成功后生成不可变 `CompiledTeamPlan`。运行中的目标始终使用**创建时快照**，
//     能力包升级只影响之后创建的目标。」
//
// spec §6.5 line 344：RunContextSnapshot 的第一行就是「Compiled TeamPlan 快照」——
// 也就是说这份计划会**进入**每一个运行中目标的上下文快照，于是它的不可变性
// 不是"设计品味"，而是上游那条"快照冻结后不可修改"的前提。
//
// ---------------------------------------------------------------------------
// ① 「不可变」这件事，`Object.isFrozen` 证明不了
//
// 最自然的写法是 `return Object.freeze(plan)`，再来一条 `assert.ok(Object.isFrozen(plan))`。
// 它通过，因为最外层确实冻住了。而"哪个员工在被派活"在**第二层**：
//
//   > 一个「只冻结了最外层的 CompiledTeamPlan」的实现，
//   > 与一个「`plan.employees.push(...)` 能成功、于是运行中的团队被改了」的实现，
//   > 是同一个东西——只不过前者会通过 `Object.isFrozen()` 的检查。
//
// 本仓库在 PRT-613（`tool-args.mjs`）上被这件事咬过一次，那里的结论是
// 「留证要留**算出来的路径列表**，不是一个布尔」。这里照做：冻结用共享的
// `deepFreeze`，证据用 `assertDeepFrozen(...).frozenPaths`——一条**算出来的**路径列表，
// 以及 `mutablePathsOf()` 给出的"还有哪些地方没冻住"（红的时候直接指出要修哪里）。
//
// ---------------------------------------------------------------------------
// ② 版本固定必须是**查得到两个方向**的
//
// "升级不影响运行中的目标"这句话，用一个"目标版本没变"的断言是证明不了的：
//
//   > 一个「升级之后运行中目标的版本没变」的断言，
//   > 与一个「升级根本没发生」的断言，在"版本固定到底有没有生效"上是同一个东西。
//
// 所以 `createPlanRegistry` 同时暴露 `latestPlanOf(packId)` 与 `planOf(targetId)`：
// 用例必须**同时**断言"最新版已经是 2.0.0"与"运行中的目标仍然报 1.0.0"。
// 只断言后者时，一个把 `publish` 写成空函数的实现照样全绿。
//
// 另一半是**目标一旦建出来就不再重绑**：`createTarget` 对同一个 targetId
// 第二次调用直接拒绝，而不是"用新的 planId 覆盖"。
//
//   > 一个「允许把运行中目标重新指向新版本」的 registry，
//   > 与一个「升级即改运行中目标」的 registry，是同一个东西——
//   > 只不过前者的入口看起来像一个无害的"修正一下绑定"。
// ============================================================================

import { domainSeparatedHash, nfc } from '../contracts/canonical.mjs'
import { normalizeManifest } from '../dsh-composition/employee-manifest.mjs'
import { assertDeepFrozen, deepFreeze } from '../dsh-composition/tool-args.mjs'
import {
  PACK_MANIFEST_VERSION,
  PACK_PROTOCOL_VERSION,
  contentHashOfEntries,
  normalizePackManifest,
  normalizePayload,
  readPackTeam,
} from './manifest.mjs'

/** 编译后团队方案的形态版本。 */
export const COMPILED_TEAM_PLAN_VERSION = 'legion/compiled-team-plan@1'

/** 计划哈希的 domain separator。与审批、快照、内容哈希都不同。 */
export const PLAN_DOMAIN = 'legion.compiled-team-plan.v1'

/** 计划 schema 版本。 */
export const PLAN_SCHEMA_VERSION = 1

/** 流水线每一段必须给的字段。 */
export const PIPELINE_STAGE_FIELDS = Object.freeze(['stage', 'role', 'handoffTo'])

/** 计划体里**不参与**哈希的字段（哈希自己不能进自己被哈希的内容）。 */
export const PLAN_HASH_EXCLUDED = Object.freeze(['planHash'])

export const PLAN_CODES = Object.freeze({
  /** 只有 `team` 类型的包能被编译成团队方案。 */
  NOT_A_TEAM_PACK: 'compiled-plan-not-a-team-pack',
  /** 团队包里一个员工也没有。 */
  EMPLOYEES_EMPTY: 'compiled-plan-employees-empty',
  /** 入口缺失 / 不成形状。 */
  TEAM_SOURCE_MISSING: 'compiled-plan-team-source-missing',
  /** 员工清单本身不合法（PRT-603 的归一化拒绝了它）。 */
  BAD_EMPLOYEE: 'compiled-plan-bad-employee',
  /** 员工重复。 */
  EMPLOYEE_DUPLICATE: 'compiled-plan-employee-duplicate',
  /** 流水线为空。 */
  PIPELINE_EMPTY: 'compiled-plan-pipeline-empty',
  /** 流水线段缺字段或字段不合法。 */
  BAD_STAGE: 'compiled-plan-bad-stage',
  /** 流水线指向一个不存在的岗位。 */
  UNKNOWN_ROLE: 'compiled-plan-unknown-role',
  /** 交接指向自己：那不是一次交接。 */
  SELF_HANDOFF: 'compiled-plan-self-handoff',
  /** 有员工从头到尾没被派过活。 */
  ROLE_NOT_IN_PIPELINE: 'compiled-plan-role-not-in-pipeline',
  /** 交接链成环。 */
  HANDOFF_CYCLE: 'compiled-plan-handoff-cycle',
  /** 冻结校验不通过——存在没被冻住的地方。 */
  NOT_DEEPLY_FROZEN: 'compiled-plan-not-deeply-frozen',
  /** 计划被改过（哈希对不上）。 */
  PLAN_TAMPERED: 'compiled-plan-tampered',
  /** 计划不存在。 */
  PLAN_UNKNOWN: 'compiled-plan-unknown',
  /** 目标不存在。 */
  TARGET_UNKNOWN: 'compiled-plan-target-unknown',
  /** 同一个 targetId 已经绑过计划——**不许重绑**。 */
  TARGET_EXISTS: 'compiled-plan-target-exists',
})

function planError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 不可变性
// ---------------------------------------------------------------------------

function joinPath(path, key) {
  if (path === '') return String(key)
  return /^\d+$/.test(String(key)) ? `${path}[${key}]` : `${path}.${key}`
}

/**
 * 列出**所有没被冻住**的对象 / 数组路径。
 *
 * 它与共享的 `assertDeepFrozen` 不是同一件事：后者答"全都冻住了吗"
 * （碰到第一个没冻的就抛），前者答"**还有哪些地方没冻住**"。
 * 红的时候要的是后者——一句"没冻住"不能告诉你去改哪一行。
 */
export function mutablePathsOf(value, path = '', depth = 0) {
  if (depth > 64) return [`${path || '<root>'}<过深>`]
  if (value === null || typeof value !== 'object') return []
  const out = []
  if (!Object.isFrozen(value)) out.push(path === '' ? '<root>' : path)
  for (const key of Object.keys(value)) out.push(...mutablePathsOf(value[key], joinPath(path, key), depth + 1))
  return out
}

/**
 * 证明一份计划是**深**冻结的，并留下算出来的路径列表。
 *
 * `plan` 可注入是为了让"浅冻结"这件事能被**真的构造出来**——正确实现下
 * `mutablePaths` 恒为空数组，那一段拒绝永远不触发：
 *
 *   > 一段永远不会触发的断言，与一段不存在的断言，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 */
export function assertPlanImmutable({ plan, mutablePaths = null } = {}) {
  if (plan === null || typeof plan !== 'object') {
    throw planError(PLAN_CODES.PLAN_UNKNOWN, 'assertPlanImmutable 需要一份计划对象')
  }
  const mutable = Object.freeze(mutablePaths ?? mutablePathsOf(plan))
  if (mutable.length > 0) {
    throw planError(
      PLAN_CODES.NOT_DEEPLY_FROZEN,
      `CompiledTeamPlan 有 ${mutable.length} 处没有冻结：${JSON.stringify(mutable.slice(0, 8))}。` +
      '浅冻结在 `Object.isFrozen()` 上看不出来，而"哪个员工在被派活"在第二层——' +
      '一份冻结了外层、内层数组可变的计划，与一份可变计划是同一个东西',
    )
  }
  let frozen
  try {
    frozen = assertDeepFrozen(plan)
  } catch (err) {
    // `assertDeepFrozen` 属于 PRT-613，它的报错文案说的是工具参数。
    // 这里补上"这次查的是一份团队方案"，同时**保留**它给出的那一层路径。
    throw planError(
      PLAN_CODES.NOT_DEEPLY_FROZEN,
      `CompiledTeamPlan 的深冻结校验未通过：${err?.message ?? String(err)}`,
    )
  }
  return Object.freeze({
    frozenPaths: frozen.frozenPaths,
    mutablePaths: mutable,
    frozenPathCount: frozen.frozenPaths.length,
  })
}

// ---------------------------------------------------------------------------
// 编译
// ---------------------------------------------------------------------------

function compilePipeline({ pipeline, roles }) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw planError(PLAN_CODES.PIPELINE_EMPTY, '流水线是空的——一个不派活给任何人的团队方案，与没有团队方案是同一件事')
  }
  const stages = []
  const seenStages = new Set()
  // 一个岗位在流水线里只能有一个位置。两个位置指向同一个岗位时，
  // "交接给这个岗位"落在哪一段上取决于顺序——而顺序不该决定谁干活。
  const stagedRoles = new Map()
  for (const raw of pipeline) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw planError(PLAN_CODES.BAD_STAGE, `流水线的每一段必须是对象：${JSON.stringify(raw)}`)
    }
    const keys = Object.keys(raw)
    const unknown = keys.filter((k) => !PIPELINE_STAGE_FIELDS.includes(k))
    const missing = PIPELINE_STAGE_FIELDS.filter((k) => !keys.includes(k))
    if (unknown.length > 0 || missing.length > 0) {
      throw planError(
        PLAN_CODES.BAD_STAGE,
        `流水线段字段必须恰好是 ${JSON.stringify(PIPELINE_STAGE_FIELDS)}：缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(unknown)}。` +
        '不忽略多出来的字段——一个被静默丢掉的字段会让作者以为它生效了',
      )
    }
    const stage = nfc(String(raw.stage)).trim()
    if (stage === '') throw planError(PLAN_CODES.BAD_STAGE, '流水线段缺少 stage 名')
    if (seenStages.has(stage)) throw planError(PLAN_CODES.BAD_STAGE, `流水线段名重复：${stage}`)
    seenStages.add(stage)
    const role = nfc(String(raw.role)).trim()
    if (!roles.has(role)) {
      throw planError(
        PLAN_CODES.UNKNOWN_ROLE,
        `流水线段 ${stage} 指向岗位 ${JSON.stringify(raw.role)}，而团队里没有这个岗位（有 ${[...roles].join(' / ')}）`,
      )
    }
    if (stagedRoles.has(role)) {
      throw planError(
        PLAN_CODES.BAD_STAGE,
        `岗位 ${role} 同时出现在流水线段 ${stagedRoles.get(role)} 与 ${stage}——` +
        '两个位置指向同一个岗位时，"交接给这个岗位"落在哪一段上取决于顺序',
      )
    }
    stagedRoles.set(role, stage)
    const handoffTo = raw.handoffTo === null || raw.handoffTo === undefined ? null : nfc(String(raw.handoffTo)).trim()
    if (handoffTo !== null) {
      if (handoffTo === role) {
        throw planError(PLAN_CODES.SELF_HANDOFF, `流水线段 ${stage} 把工作交接给自己（${role}）——那不是一次交接`)
      }
      if (!roles.has(handoffTo)) {
        throw planError(
          PLAN_CODES.UNKNOWN_ROLE,
          `流水线段 ${stage} 要交接给 ${JSON.stringify(handoffTo)}，而团队里没有这个岗位`,
        )
      }
    }
    stages.push(Object.freeze({ stage, role, handoffTo }))
  }

  // 每个岗位都得被派过活。写了员工却没进流水线，与"这个人从来没被派过活"
  // 在团队方案上长得一样，而在交付上差一个人。
  const staged = new Set(stages.map((s) => s.role))
  const idle = [...roles].filter((r) => !staged.has(r))
  if (idle.length > 0) {
    throw planError(
      PLAN_CODES.ROLE_NOT_IN_PIPELINE,
      `岗位 ${JSON.stringify(idle)} 在团队里但不在流水线里——他们会永远不被派活`,
    )
  }

  // 交接链必须能走到底。成环时"最后一段"不存在，于是没有任何一段是终点。
  const next = new Map(stages.map((s) => [s.role, s.handoffTo]))
  for (const s of stages) {
    let cur = s.role
    const walked = new Set()
    while (cur !== null) {
      if (walked.has(cur)) {
        throw planError(
          PLAN_CODES.HANDOFF_CYCLE,
          `交接链在岗位 ${cur} 处成环（从段 ${s.stage} 出发）——成环意味着这个团队没有终点，` +
          '于是没有哪一段能回答"这次交付完成了吗"',
        )
      }
      walked.add(cur)
      cur = next.get(cur) ?? null
    }
  }
  return Object.freeze(stages)
}

/**
 * 把一份能力包编译成不可变的 CompiledTeamPlan。
 *
 * 它**不做**预检（那是 `authority.mjs` 的 `preflightPack`），也不写账
 * （那是 `store.mjs`）。它只做一件不能被推迟的事：把包内容固定成一份
 * 之后不再改变、且**进上下文快照哈希**的计划。
 */
export function compileTeamPlan({ manifest, files, compiledAtMs } = {}) {
  if (!Number.isInteger(compiledAtMs)) {
    throw planError(PLAN_CODES.TEAM_SOURCE_MISSING, 'compileTeamPlan 需要整数 compiledAtMs（计划是不能不带时点的）')
  }
  const m = manifest?.manifestVersion === PACK_MANIFEST_VERSION ? manifest : normalizePackManifest(manifest)
  if (m.packType !== 'team') {
    throw planError(
      PLAN_CODES.NOT_A_TEAM_PACK,
      `能力包 ${m.packId} 的类型是 ${m.packType}，不能被编译成 CompiledTeamPlan——` +
      '一个 overlay 包没有团队方案，把它编译成一份"空团队"会让空团队看起来像一个团队',
    )
  }

  let source
  try {
    source = readPackTeam({ manifest: m, files })
  } catch (err) {
    throw planError(err?.code ?? PLAN_CODES.TEAM_SOURCE_MISSING, err?.message ?? String(err))
  }
  if (source.employees.length === 0) {
    throw planError(
      PLAN_CODES.EMPLOYEES_EMPTY,
      `团队包 ${m.packId} 的入口里一个员工也没有——` +
      '一个没有员工的团队方案与"没有方案"在界面上长得一样，而在派活时是两种失败',
    )
  }

  const employees = []
  const roles = new Set()
  const ids = new Set()
  for (const raw of source.employees) {
    let e
    try {
      e = normalizeManifest(raw)
    } catch (err) {
      throw planError(PLAN_CODES.BAD_EMPLOYEE, `团队包 ${m.packId} 里的员工清单不合法：${err?.message ?? String(err)}`)
    }
    if (ids.has(e.employeeId)) {
      throw planError(PLAN_CODES.EMPLOYEE_DUPLICATE, `员工 ${e.employeeId} 在团队包里出现了两次`)
    }
    if (roles.has(e.role)) {
      throw planError(
        PLAN_CODES.EMPLOYEE_DUPLICATE,
        `岗位 ${e.role} 在团队包里有两个员工（${[...employees.filter((x) => x.role === e.role).map((x) => x.employeeId), e.employeeId].join(' / ')}）。` +
        '按岗位派活时，两个同岗位员工里的哪一个被执行取决于顺序——那正是"谁干活"不该由顺序决定的地方',
      )
    }
    ids.add(e.employeeId)
    roles.add(e.role)
    employees.push(Object.freeze({
      employeeId: e.employeeId,
      role: e.role,
      displayName: e.displayName,
      allowedTools: e.allowedTools,
      allowedCapabilities: e.allowedCapabilities,
      maxRisk: e.maxRisk,
      workspaceRoot: e.workspaceRoot,
      unattended: e.unattended,
    }))
  }

  const pipeline = compilePipeline({ pipeline: source.pipeline, roles })

  const body = {
    planVersion: COMPILED_TEAM_PLAN_VERSION,
    schemaVersion: PLAN_SCHEMA_VERSION,
    packId: m.packId,
    packVersion: m.version,
    packProtocolVersion: m.packProtocolVersion,
    packManifestVersion: m.manifestVersion,
    // ★ 计划绑的是**内容**，不只是版本号：同一个版本号换一份内容，
    //   在版本比较里看不出来，而运行中目标看到的东西已经变了。
    contentHash: m.contentHash,
    teamPlanPath: source.planPath,
    compiledAtMs,
    employees: Object.freeze([...employees]),
    pipeline,
  }
  const planHash = domainSeparatedHash(PLAN_DOMAIN, PLAN_SCHEMA_VERSION, body)
  const plan = deepFreeze({ ...body, planHash })
  // 编译的最后一步就是**证明**它冻住了。一份没冻住的计划宁可编译失败——
  // 它会在下一次快照里被"顺手改一下"，而那时没人知道是谁改的。
  assertPlanImmutable({ plan })
  return plan
}

/** 计划的稳定标识。同一个包的同一个版本只该有一个。 */
export function planIdOf(plan) {
  return `${plan.packId}@${plan.packVersion}`
}

/** 重算计划的哈希（校验它有没有被改过）。 */
export function computePlanHash(plan) {
  const body = {}
  for (const [k, v] of Object.entries(plan)) {
    if (PLAN_HASH_EXCLUDED.includes(k)) continue
    body[k] = v
  }
  return domainSeparatedHash(PLAN_DOMAIN, body.schemaVersion ?? PLAN_SCHEMA_VERSION, body)
}

/**
 * 核验一份计划：哈希对得上，且它绑的内容哈希等于当初那份载荷的内容哈希。
 *
 * 第二个条件是关键的一半：哈希自洽只能证明"这份计划没被改过"，
 * 证明不了"这份计划对应的是那份包内容"。
 */
export function verifyPlan({ plan, files = null } = {}) {
  if (plan === null || typeof plan !== 'object') {
    throw planError(PLAN_CODES.PLAN_UNKNOWN, 'verifyPlan 需要一份计划')
  }
  const recomputed = computePlanHash(plan)
  if (recomputed !== plan.planHash) {
    return Object.freeze({
      ok: false, code: PLAN_CODES.PLAN_TAMPERED,
      planHash: plan.planHash, recomputed, contentHash: plan.contentHash, recomputedContentHash: null,
      message: `计划哈希对不上：计划里写着 ${plan.planHash}，重算是 ${recomputed}`,
    })
  }
  if (files === null) {
    return Object.freeze({
      ok: true, code: null, planHash: plan.planHash, recomputed,
      contentHash: plan.contentHash, recomputedContentHash: null, message: null,
    })
  }
  const recomputedContentHash = contentHashOfEntries(normalizePayload(files))
  const ok = recomputedContentHash === plan.contentHash
  return Object.freeze({
    ok,
    code: ok ? null : PLAN_CODES.PLAN_TAMPERED,
    planHash: plan.planHash,
    recomputed,
    contentHash: plan.contentHash,
    recomputedContentHash,
    message: ok ? null : `计划绑的内容哈希 ${plan.contentHash} 与这份载荷的 ${recomputedContentHash} 不一致`,
  })
}

// ---------------------------------------------------------------------------
// 版本固定
// ---------------------------------------------------------------------------

/**
 * 计划注册表：发布版本、创建目标、把目标**钉**在创建时的计划上。
 *
 * 它是 PRT-1004 全部意义的落点：`publish` 只在 `latest` 里动，
 * 而每一个目标只认自己创建时那个 `planId`。
 */
export function createPlanRegistry({ now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw planError(PLAN_CODES.PLAN_UNKNOWN, 'now 必须是函数')
  const plans = new Map()
  const latest = new Map()
  const targets = new Map()

  const publish = (plan) => {
    if (plan === null || typeof plan !== 'object' || typeof plan.planHash !== 'string') {
      throw planError(PLAN_CODES.PLAN_UNKNOWN, 'publish 需要一份编译好的计划')
    }
    const planId = planIdOf(plan)
    const known = plans.get(planId)
    if (known !== undefined && known.planHash !== plan.planHash) {
      throw planError(
        PLAN_CODES.PLAN_TAMPERED,
        `同一个计划标识 ${planId} 出现了两份不同的内容哈希——版本号相同而内容不同，` +
        '那么"1.0.0 是这个计划"这句话就没有意义',
      )
    }
    plans.set(planId, plan)
    latest.set(plan.packId, planId)
    return plan
  }

  return Object.freeze({
    version: COMPILED_TEAM_PLAN_VERSION,
    publish,
    compileAndPublish: ({ manifest, files, compiledAtMs }) =>
      publish(compileTeamPlan({ manifest, files, compiledAtMs })),
    planById: (planId) => {
      const plan = plans.get(String(planId ?? ''))
      if (plan === undefined) throw planError(PLAN_CODES.PLAN_UNKNOWN, `没有这个计划：${JSON.stringify(planId)}`)
      return plan
    },
    /** 这个包**最新发布**的计划。升级的可见性靠它。 */
    latestPlanOf: (packId) => {
      const planId = latest.get(String(packId ?? ''))
      if (planId === undefined) throw planError(PLAN_CODES.PLAN_UNKNOWN, `能力包 ${JSON.stringify(packId)} 没有发布过计划`)
      return plans.get(planId)
    },
    publishedPlanIds: () => Object.freeze([...plans.keys()].sort()),

    /**
     * 创建一个目标，并把它**钉**在 `planId` 上。
     *
     * 同一个 targetId 第二次调用直接拒绝：如果这里允许覆盖，
     * "运行中目标使用创建时快照"就只剩下一句注释。
     */
    createTarget({ targetId, planId } = {}) {
      const id = nfc(String(targetId ?? '')).trim()
      if (id === '') throw planError(PLAN_CODES.TARGET_UNKNOWN, 'createTarget 需要非空 targetId')
      if (targets.has(id)) {
        throw planError(
          PLAN_CODES.TARGET_EXISTS,
          `目标 ${id} 已经绑定了计划 ${targets.get(id).planId}，不允许重绑到 ${JSON.stringify(planId)}。` +
          '一个允许重绑的注册表，与一个"升级即改运行中目标"的注册表，是同一个东西',
        )
      }
      const pid = nfc(String(planId ?? '')).trim()
      const plan = plans.get(pid)
      if (plan === undefined) {
        throw planError(PLAN_CODES.PLAN_UNKNOWN, `目标 ${id} 要绑的计划 ${JSON.stringify(planId)} 不存在`)
      }
      const target = Object.freeze({
        targetId: id,
        planId: pid,
        packId: plan.packId,
        packVersion: plan.packVersion,
        planHash: plan.planHash,
        contentHash: plan.contentHash,
        pinnedAtMs: now(),
      })
      targets.set(id, target)
      return target
    },

    targetOf: (targetId) => {
      const t = targets.get(nfc(String(targetId ?? '')).trim())
      if (t === undefined) throw planError(PLAN_CODES.TARGET_UNKNOWN, `没有这个目标：${JSON.stringify(targetId)}`)
      return t
    },

    /**
     * 这个目标**实际在用的**计划。
     *
     * ★ 它只按目标自己钉住的 `planId` 查，**绝不**回落到 `latest`：
     *
     *   > 一个「目标找不到自己的计划就回落到最新版」的查询，
     *   > 与一个「在升级的那一刻，所有运行中的目标一起换了计划」的查询，
     *   > 是同一个东西——只不过前者只在"计划被清理过"的时候发生。
     */
    planOf: (targetId) => {
      const t = targets.get(nfc(String(targetId ?? '')).trim())
      if (t === undefined) throw planError(PLAN_CODES.TARGET_UNKNOWN, `没有这个目标：${JSON.stringify(targetId)}`)
      return plans.get(t.planId)
    },

    /** 运行中目标自报的版本三元组（用例与审计读它，不读 `latest`）。 */
    versionOf: (targetId) => {
      const t = targets.get(nfc(String(targetId ?? '')).trim())
      if (t === undefined) throw planError(PLAN_CODES.TARGET_UNKNOWN, `没有这个目标：${JSON.stringify(targetId)}`)
      return Object.freeze({ packId: t.packId, packVersion: t.packVersion, planId: t.planId, planHash: t.planHash })
    },

    targetsOf: (packId) => Object.freeze(
      [...targets.values()].filter((t) => t.packId === String(packId ?? '')).map((t) => t.targetId).sort(),
    ),
    targetCount: () => targets.size,
  })
}

// ---------------------------------------------------------------------------
// 装载时自检
// ---------------------------------------------------------------------------

/**
 * 自检与用例共用的样例团队：两个岗位，一条两段的流水线。
 *
 * 它是**导出**的，因为 authority 的越权检查也必须在一个"真的像团队"的输入上跑：
 * 一个只有空数组的夹具会让"员工申请得比包声明的多"这条检查永远没有拦点。
 */
export const SAMPLE_TEAM = Object.freeze({
  employees: Object.freeze([
    Object.freeze({
      employeeId: 'sample-planner', role: 'planner', displayName: '规划',
      allowedTools: ['read-file', 'git-status'], allowedCapabilities: ['file:read', 'repo:read'],
      maxRisk: 'low', workspaceRoot: 'C:/work/sample', unattended: true,
      notes: '样例岗位：只读',
    }),
    Object.freeze({
      employeeId: 'sample-verifier', role: 'verifier', displayName: '验证',
      allowedTools: ['read-file', 'run-command'], allowedCapabilities: ['file:read', 'repo:read', 'command:exec'],
      maxRisk: 'high', workspaceRoot: 'C:/work/sample', unattended: true,
      notes: '样例岗位：能跑命令',
    }),
  ]),
  pipeline: Object.freeze([
    Object.freeze({ stage: 'plan', role: 'planner', handoffTo: 'verifier' }),
    Object.freeze({ stage: 'verify', role: 'verifier', handoffTo: null }),
  ]),
})

/**
 * 构造一个自检 / 用例共用的样例团队包。
 *
 * `version` 与 `notes` 可注入，让"升一次级"这件事能被真的构造出来。
 */
export function sampleTeamPack({ packId = 'legion.sample-team', version = '1.0.0', note = '样例' } = {}) {
  const files = [
    { path: 'team/team-plan.json', text: JSON.stringify({ ...SAMPLE_TEAM, note }) },
    { path: 'docs/README.md', text: `# ${packId}\n` },
  ]
  const entries = normalizePayload(files)
  const manifest = {    manifestVersion: PACK_MANIFEST_VERSION,
    packId,
    packType: 'team',
    version,
    packProtocolVersion: PACK_PROTOCOL_VERSION,
    contentHash: contentHashOfEntries(entries),
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    entrypoints: { teamPlan: 'team/team-plan.json' },
    dependsOn: [],
    compatibility: {
      product: '^1.0.0',
      packProtocolVersion: PACK_PROTOCOL_VERSION,
      dshCompositionPatchVersion: '^1.0.0',
    },
    requestedPermissions: {
      capabilities: ['file:read', 'repo:read', 'command:exec'],
      tools: ['read-file', 'git-status', 'run-command'],
      maxRisk: 'high',
      workspaceRoot: 'C:/work/sample',
    },
    dataDependencies: [{ id: 'workspace', kind: 'workspace-state' }],
    provenance: null,
    containsSecrets: false,
  }
  return Object.freeze({ manifest, files, note })
}

function codeOf(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

/** 抛出的错误的**类型名**（冻结对象的写入在严格模式下抛 TypeError）。 */
function throwNameOf(fn) {
  try {
    fn()
    return 'no-throw'
  } catch (err) {
    return err?.constructor?.name ?? 'Error'
  }
}

/**
 * 装载期自检。**不抛，留值。**
 *
 * 三组读数：深冻结的**路径列表**、浅冻结被拒的**具体可变路径**、
 * 以及升级前后"最新版 / 运行中目标版"这一对值。
 */
export function assertCompiledPlanSemantics() {
  const problems = []
  const samples = {}

  const pack = sampleTeamPack()
  const plan = compileTeamPlan({ manifest: pack.manifest, files: pack.files, compiledAtMs: 0 })

  const immutable = assertPlanImmutable({ plan })
  samples.frozenPathCount = immutable.frozenPathCount
  samples.frozenPathsHead = Object.freeze(immutable.frozenPaths.slice(0, 6))
  samples.mutablePaths = immutable.mutablePaths
  if (immutable.mutablePaths.length !== 0) problems.push('样例计划存在没被冻结的地方')
  // ★ 路径列表必须**真的覆盖到第二层**：只报一个 `<root>` 等于什么都没证明。
  //
  // ⚠️ 两套路径记法的来源不同，这里两种都接受：共享的 `assertDeepFrozen`（PRT-613）
  // 把数组下标写成 `employees.0.role`，本模块的 `mutablePathsOf` 写成 `employees[0].role`。
  // 不统一它们是有意的——前者是"叶子清单"（给哈希核验用），后者是"哪里没冻住"
  // （给人修代码用）。改 PRT-613 的路径记法会动到它自己的用例，代价与收益不成比例。
  if (!immutable.frozenPaths.some((p) => /^employees[.[]0[.\]]/.test(p))) {
    problems.push('冻结路径列表没有覆盖到 employees 的第二层')
  }

  // 浅冻结：外层冻住、内层数组没冻 → 必须被拒，且**指出是哪一条路径**
  const shallow = Object.freeze({ employees: [{ role: 'planner' }], pipeline: [] })
  samples.shallowFreezeCode = codeOf(() => assertPlanImmutable({ plan: shallow }))
  samples.shallowFreezeMutablePaths = Object.freeze(mutablePathsOf(shallow))
  if (samples.shallowFreezeCode !== PLAN_CODES.NOT_DEEPLY_FROZEN) {
    problems.push(`浅冻结的计划没有被拒（${samples.shallowFreezeCode}）`)
  }
  if (samples.shallowFreezeMutablePaths.length === 0) {
    problems.push('浅冻结的可变路径列表是空的——那这条检查就没有拦点')
  }

  // 真的去改一下：内层数组与内层对象都必须抛（ESM 是严格模式，写冻结对象抛 TypeError）
  samples.mutationRejections = Object.freeze([
    throwNameOf(() => { plan.employees.push({ role: 'x' }) }),
    throwNameOf(() => { plan.employees[0].maxRisk = 'critical' }),
    throwNameOf(() => { plan.pipeline[0].role = 'other' }),
    throwNameOf(() => { plan.planHash = 'sha256:00' }),
    // 第二层再往下一层：`allowedTools` 是员工对象里的数组
    throwNameOf(() => { plan.employees[0].allowedTools.push('delete-file') }),
  ])
  if (samples.mutationRejections.includes('no-throw')) {
    problems.push(`深冻结的计划仍然可以被改：${JSON.stringify(samples.mutationRejections)}`)
  }

  // 哈希自洽 + 换一份载荷就自洽不了
  samples.verifyOk = verifyPlan({ plan, files: pack.files }).ok
  samples.verifyOtherFilesCode = verifyPlan({ plan, files: [{ path: 'other.txt', text: 'x' }] }).code
  if (samples.verifyOk !== true) problems.push('样例计划的哈希核验没通过')
  if (samples.verifyOtherFilesCode !== PLAN_CODES.PLAN_TAMPERED) {
    problems.push(`计划换一份载荷后没有被判成不一致（${samples.verifyOtherFilesCode}）`)
  }

  // ★ 版本固定：升级**真的发生了**（最新版变了），而目标**没有动**。
  const registry = createPlanRegistry({ now: () => 0 })
  const v1 = registry.compileAndPublish({ manifest: pack.manifest, files: pack.files, compiledAtMs: 0 })
  const target = registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v1) })
  const v2Pack = sampleTeamPack({ version: '2.0.0', note: '第二版' })
  const v2 = registry.compileAndPublish({ manifest: v2Pack.manifest, files: v2Pack.files, compiledAtMs: 1 })
  samples.upgrade = Object.freeze({
    latestAfterUpgrade: registry.latestPlanOf(pack.manifest.packId).packVersion,
    targetVersionAfterUpgrade: registry.versionOf(target.targetId).packVersion,
    targetStillSamePlan: registry.planOf(target.targetId) === v1,
    latestIsTheNewPlan: registry.latestPlanOf(pack.manifest.packId) === v2,
    rebindCode: codeOf(() => registry.createTarget({ targetId: 'goal-1', planId: planIdOf(v2) })),
  })
  if (samples.upgrade.latestAfterUpgrade !== '2.0.0') {
    problems.push('升级之后最新版没有变——那"运行中目标没变"这条断言证明不了任何东西')
  }
  if (samples.upgrade.targetVersionAfterUpgrade !== '1.0.0' || samples.upgrade.targetStillSamePlan !== true) {
    problems.push('升级改变了运行中目标')
  }
  if (samples.upgrade.rebindCode !== PLAN_CODES.TARGET_EXISTS) {
    problems.push(`运行中的目标可以被重绑（${samples.upgrade.rebindCode}）`)
  }

  // 拒绝路径也要真的能响：空流水线、未知岗位
  samples.emptyPipelineCode = codeOf(() => {
    const broken = sampleTeamPackWith({ pipeline: [] })
    compileTeamPlan({ manifest: broken.manifest, files: broken.files, compiledAtMs: 0 })
  })
  samples.unknownRoleCode = codeOf(() => {
    const broken = sampleTeamPackWith({ pipeline: [{ stage: 'a', role: 'nobody', handoffTo: null }] })
    compileTeamPlan({ manifest: broken.manifest, files: broken.files, compiledAtMs: 0 })
  })
  samples.handoffCycleCode = codeOf(() => {
    const broken = sampleTeamPackWith({
      pipeline: [
        { stage: 'plan', role: 'planner', handoffTo: 'verifier' },
        { stage: 'verify', role: 'verifier', handoffTo: 'planner' },
      ],
    })
    compileTeamPlan({ manifest: broken.manifest, files: broken.files, compiledAtMs: 0 })
  })
  for (const [k, want] of [
    ['emptyPipelineCode', PLAN_CODES.PIPELINE_EMPTY],
    ['unknownRoleCode', PLAN_CODES.UNKNOWN_ROLE],
    ['handoffCycleCode', PLAN_CODES.HANDOFF_CYCLE],
  ]) {
    if (samples[k] !== want) problems.push(`${k} 得到 ${JSON.stringify(samples[k])}，期望 ${want}`)
  }

  return Object.freeze({ problems: Object.freeze(problems), samples: Object.freeze(samples) })
}

/**
 * 造一个"团队方案被改坏 / 被改窄"的包。
 *
 * 它返回一份**形状完整**的 manifest（哈希与内容表都跟着重算了），
 * 这样被拒的原因只可能是团队方案本身——否则"它被拒了"这句话证明不了
 * 我们想证明的那一条：一条被别的原因顺带拦下的检查，与一条不存在的检查，
 * 在"它到底拦不拦得住"上是同一个东西。
 *
 * 导出的理由与 `SAMPLE_TEAM` 相同：authority 的越权检查必须能在
 * "员工自己改了清单"这种输入上被真的问到。
 */
export function sampleTeamPackWith({
  pipeline = SAMPLE_TEAM.pipeline,
  employees = SAMPLE_TEAM.employees,
  packId = 'legion.sample-team',
  version = '1.0.0',
} = {}) {
  const good = sampleTeamPack({ packId, version })
  const files = good.files.map((f) => (
    f.path === 'team/team-plan.json'
      ? { path: f.path, text: JSON.stringify({ employees, pipeline }) }
      : f
  ))
  const entries = normalizePayload(files)
  return Object.freeze({
    manifest: {
      ...good.manifest,
      contentHash: contentHashOfEntries(entries),
      contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    },
    files,
  })
}

// 装载即执行。导出的是**算出来的路径列表与那一对版本读数**，不是一个布尔 ok。
export const COMPILED_PLAN_CHECKED = Object.freeze({
  version: COMPILED_TEAM_PLAN_VERSION,
  planDomain: PLAN_DOMAIN,
  planSchemaVersion: PLAN_SCHEMA_VERSION,
  ...assertCompiledPlanSemantics(),
})

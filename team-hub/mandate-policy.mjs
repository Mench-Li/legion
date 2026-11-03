// team-hub/mandate-policy.mjs
// ============================================================================
// F4 · 授权台账：`mandate` + 确定性准入（设计稿 §3 F4 / M5，DEC-1）
//
// 要回答的问题只有一个：**这条任务凭什么开工？**
// 所以 mandate 是**不可变**的授权记录（变宽 = 新版本），准入是一组**确定性的**闸门。
//
// 形态照抄 `claim-policy.mjs`（那里已经证明这种写法能拦住"有人绕过生成器手写 SQL"）：
//   · `MANDATE_GATES`：每条闸 = { id, sql（可选）, holds(), userText }
//   · `mandateAllows()`：首次不通过即返回，带 `failedGate`，诊断能直接指到那一条
//
// ★ 四条纪律
//   ① 没有依据（既无 basisRuleIds 又非 manual）⇒ 拒：不能"什么都没说就开工"
//   ② `inferred` 且空间 `accept_mode ≠ auto` ⇒ **只写 would_accept**，不入队（I-4.5）
//   ③ `fileDomain` 为空 ⇒ 什么都不许改（fail-closed）；超出域 ⇒ OUT_OF_MANDATE
//   ④ `revoked`（授权撤回）与 `hold`（调度拦截）**不共用字段**（I-4.3）
// ============================================================================

export const MANDATE_SCHEMA_ID = 'legion/mandate@1'
export const MANDATE_POLICY_VERSION = 'legion/policy@1'

/** 任务被受理的"强度"：explicit = 人明确要的；inferred = 从上下文推断出来的。 */
export const STRENGTHS = Object.freeze(['explicit', 'inferred'])
/** 空间级受理模式（DEC-5：真值在空间设置，任务上只留冗余快照）。 */
export const ACCEPT_MODES = Object.freeze(['auto', 'manual', 'off'])

export const MANDATE_ERRORS = Object.freeze({
  MISSING_BASIS: 'MISSING_BASIS',
  INFERRED_NEEDS_AUTO: 'INFERRED_NEEDS_AUTO',
  OUT_OF_MANDATE: 'OUT_OF_MANDATE',
  REVOKED: 'REVOKED',
})

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const asArray = (v) => (Array.isArray(v) ? v : [])

/** 路径是否落在某个目录前缀下（归一化分隔符与大小写差异）。 */
function pathInDomain(path, domain) {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  return asArray(domain).some((prefix) => {
    const d = String(prefix ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (d === '') return false
    return p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`)
  })
}

/**
 * 准入闸门。每条闸的 `holds(mandate, ctx)` 是**纯函数镜像**——诊断与 dry-run 用它，
 * 而不必真的去跑 SQL。加新闸时这里与任何 `mandateAllows` 的消费方一起改。
 */
export const MANDATE_GATES = Object.freeze([
  Object.freeze({
    id: 'has-basis',
    // 「凭什么」：要么引用规则集，要么是人手动受理的
    holds: (mandate) => asArray(mandate?.basisRuleIds).length > 0 || mandate?.manual === true,
    userText: '没有受理依据（既无 basisRuleIds，也不是人工受理）',
  }),
  Object.freeze({
    id: 'strength-visible',
    // inferred 只在空间允许自动受理时才有效（I-4.5）
    holds: (mandate, ctx = {}) => text(mandate?.strength) === 'explicit' || text(ctx.acceptMode) === 'auto',
    userText: '这条任务是推断受理的，而当前空间不允许自动受理',
  }),
  Object.freeze({
    id: 'in-scope',
    // 期望路径必须落在授权目录内；空域一律拒
    holds: (mandate, ctx = {}) => {
      const paths = asArray(ctx.paths)
      if (paths.length === 0) return true // 没声明路径 = 没有越域可言
      const domain = asArray(mandate?.scope?.fileDomain)
      if (domain.length === 0) return false // fail-closed
      return paths.every((p) => pathInDomain(p, domain))
    },
    userText: '期望改动超出授权目录（fileDomain）',
  }),
  Object.freeze({
    id: 'not-revoked',
    holds: (mandate) => mandate?.revoked !== true,
    userText: '授权已被撤回（revoke）',
  }),
])

const GATE_ERROR = Object.freeze({
  'has-basis': MANDATE_ERRORS.MISSING_BASIS,
  'strength-visible': MANDATE_ERRORS.INFERRED_NEEDS_AUTO,
  'in-scope': MANDATE_ERRORS.OUT_OF_MANDATE,
  'not-revoked': MANDATE_ERRORS.REVOKED,
})

/**
 * 这条 mandate 是否放行。
 *
 * @param mandate
 * @param ctx.paths      期望改动的路径
 * @param ctx.acceptMode 任务所在空间的受理模式
 * @returns {{ ok: boolean, code: string|null, failedGate: string|null, userText: string|null, wouldAcceptOnly: boolean }}
 */
export function mandateAllows(mandate, { paths = [], acceptMode = 'manual' } = {}) {
  if (mandate === null || mandate === undefined) {
    return Object.freeze({
      ok: false, code: MANDATE_ERRORS.MISSING_BASIS, failedGate: 'has-basis',
      userText: '没有授权记录', wouldAcceptOnly: false,
    })
  }
  for (const gate of MANDATE_GATES) {
    if (gate.holds(mandate, { paths, acceptMode }) === true) continue
    const code = GATE_ERROR[gate.id] ?? `MANDATE_${gate.id.toUpperCase()}`
    return Object.freeze({
      ok: false,
      code,
      failedGate: gate.id,
      userText: gate.userText,
      // I-4.5：推断受理但空间不允许 ⇒ 不是"拒绝"，是"记一笔 would_accept"
      wouldAcceptOnly: gate.id === 'strength-visible',
    })
  }
  return Object.freeze({ ok: true, code: null, failedGate: null, userText: null, wouldAcceptOnly: false })
}

/**
 * 构造一条 mandate（不可变）。版本从 1 开始，`supersedes` 指向被取代的版本号。
 */
export function buildMandate(input = {}) {
  const fileDomain = asArray(input?.scope?.fileDomain).map((p) => String(p))
  const stages = asArray(input?.scope?.stages).map((s) => String(s))
  const mandate = {
    schema: MANDATE_SCHEMA_ID,
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    policyVersion: text(input.policyVersion) || MANDATE_POLICY_VERSION,
    strength: STRENGTHS.includes(input.strength) ? input.strength : 'explicit',
    requestedBy: { kind: text(input?.requestedBy?.kind) || 'user', id: text(input?.requestedBy?.id) || 'unknown' },
    grantedBy: { kind: text(input?.grantedBy?.kind) || 'general', id: text(input?.grantedBy?.id) || 'general' },
    basisRuleIds: asArray(input.basisRuleIds).map((r) => String(r)),
    manual: input.manual === true,
    scope: { fileDomain, stages },
    grantedAt: text(input.grantedAt) || new Date().toISOString(),
    supersedes: Number.isInteger(input.supersedes) ? input.supersedes : null,
    // `revoked` 与调度 `hold` 是两件事：授权撤回 ≠ 暂时拦住不派工（I-4.3）
    revoked: input.revoked === true,
    ...(input.revoked === true ? { revokedAt: text(input.revokedAt) || new Date().toISOString() } : {}),
  }
  // 深冻结：mandate 是"记录"，不是"可变配置"（I-4.2）
  Object.freeze(mandate.requestedBy)
  Object.freeze(mandate.grantedBy)
  Object.freeze(mandate.scope.fileDomain)
  Object.freeze(mandate.scope.stages)
  Object.freeze(mandate.scope)
  Object.freeze(mandate.basisRuleIds)
  return Object.freeze(mandate)
}

/**
 * 变宽 / 变更授权 ⇒ **新版本**（旧版本保留可读）。纯函数：不改入参。
 */
export function widenMandate(previous, patch = {}, { at = null } = {}) {
  const base = previous ?? {}
  const nextScope = {
    fileDomain: patch?.scope?.fileDomain !== undefined ? asArray(patch.scope.fileDomain) : asArray(base?.scope?.fileDomain),
    stages: patch?.scope?.stages !== undefined ? asArray(patch.scope.stages) : asArray(base?.scope?.stages),
  }
  return buildMandate({
    ...base,
    ...patch,
    scope: nextScope,
    version: (Number(base.version) || 1) + 1,
    supersedes: Number(base.version) || 1,
    grantedAt: at ?? new Date().toISOString(),
  })
}

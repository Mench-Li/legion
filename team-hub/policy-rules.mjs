// team-hub/policy-rules.mjs
// ============================================================================
// F4 · 规则集维护（设计稿 §3 F4 / M5）
//
// `policy_rules` 是"凭什么开工"的来源之一：mandate.basisRuleIds 指的就是这里的 id。
// 规则若能随手改又不留痕，台账就退化成"事后编理由"。
//
// ★ 三条纪律
//   ① 每次变更都**递增 POLICY_VERSION**（mandate 上记的就是它，便于回溯"当时按哪版规则"）
//   ② 每次变更写**一条** `policy_changed` 审计（I-4.4：只记事件，**不撤销**在途任务）
//   ③ 停用的规则保留可读（enabled=0），不删——删掉会让历史 mandate 的 basisRuleIds 变成悬空引用
// ============================================================================

import { createHash } from 'node:crypto'

export const RULE_KINDS = Object.freeze(['always', 'when', 'never'])

export const POLICY_ERRORS = Object.freeze({
  UNKNOWN_KIND: 'POLICY_UNKNOWN_KIND',
  EMPTY_TEXT: 'POLICY_EMPTY_TEXT',
  BAD_ID: 'POLICY_BAD_ID',
})

export class PolicyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'PolicyError'
    this.code = code
    this.statusCode = 422
  }
}

const BASE_VERSION = 'legion/policy@1'
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

/** 只读列表。 */
export function listPolicyRules(db, { enabledOnly = false, scope = null } = {}) {
  const where = []
  const params = []
  if (enabledOnly) where.push('enabled = 1')
  if (scope !== null && scope !== undefined) { where.push('(scope IS NULL OR scope = ?)'); params.push(String(scope)) }
  const sql = `SELECT id, kind, text, scope, enabled, rule_ref FROM policy_rules${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`
  return db.prepare(sql).all(...params).map((r) => ({ ...r, enabled: r.enabled ? 1 : 0 }))
}

/**
 * 当前策略版本：`legion/policy@1.<内容指纹>`。
 *
 * 为什么用**内容指纹**而不是计数器：
 *   · 不新增计数器（全局约束 6：复用既有事实）；
 *   · 同样的一组规则永远得到同样的版本 ⇒ 可重算、可对账；
 *   · 不依赖"审计到底有没有落库"——回调式的 audit 在某些路径上只是收集器。
 */
export function policyVersion(db) {
  const rules = listPolicyRules(db, {}).map((r) => [r.id, r.kind, r.text, r.scope ?? '', r.enabled ? 1 : 0])
  const digest = createHash('sha1').update(JSON.stringify(rules)).digest('hex').slice(0, 8)
  return `${BASE_VERSION}.${digest}`
}

/**
 * 新增或更新一条规则（同 id = 更新）。
 *
 * @returns {{ rule: object, created: boolean, version: string }}
 */
export function upsertPolicyRule(db, input = {}, { by = 'system', at = null, audit = null } = {}) {
  const id = String(input.id ?? '').trim()
  if (!ID_RE.test(id)) throw new PolicyError(POLICY_ERRORS.BAD_ID, `规则 id 不合法：${JSON.stringify(input.id)}`)

  const kind = String(input.kind ?? '').trim()
  if (!RULE_KINDS.includes(kind)) throw new PolicyError(POLICY_ERRORS.UNKNOWN_KIND, `未知规则类型 ${JSON.stringify(input.kind)}`)

  const ruleText = String(input.text ?? '').trim()
  if (ruleText === '') throw new PolicyError(POLICY_ERRORS.EMPTY_TEXT, '规则正文不能为空')

  const scope = input.scope === undefined || input.scope === null ? null : String(input.scope)
  const enabled = input.enabled === false ? 0 : 1
  const ruleRef = input.ruleRef === undefined || input.ruleRef === null ? null : String(input.ruleRef)

  const existing = db.prepare('SELECT id FROM policy_rules WHERE id=?').get(id)
  if (existing) {
    db.prepare('UPDATE policy_rules SET kind=?, text=?, scope=?, enabled=?, rule_ref=? WHERE id=?')
      .run(kind, ruleText, scope, enabled, ruleRef, id)
  } else {
    db.prepare('INSERT INTO policy_rules (id, kind, text, scope, enabled, rule_ref) VALUES (?,?,?,?,?,?)')
      .run(id, kind, ruleText, scope, enabled, ruleRef)
  }

  const now = at ?? new Date().toISOString()
  const version = policyVersion(db)
  if (typeof audit === 'function') {
    // I-4.4：只写一条事件；不撤销任何在途任务
    audit(by, scope ?? 'default', 'policy_changed', null,
      JSON.stringify({ id, kind, enabled, created: existing === undefined, version }))
  }
  return {
    rule: { id, kind, text: ruleText, scope, enabled, rule_ref: ruleRef },
    created: existing === undefined,
    version: policyVersion(db),
  }
}

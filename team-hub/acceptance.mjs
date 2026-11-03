// team-hub/acceptance.mjs
// ============================================================================
// F4 · 「→ todo 时写授权与台账」（设计稿 §3 F4 / DEC-1）
//
// DEC-1：mandate **只在 `transitionTask()` 里写**，不在路由层散落。
// 但上线第一天就强制要求 mandate，会把所有在途任务一次性卡死——它们都没有 mandate。
// 所以分两步走：
//   strict=false（默认）：**先记账**——能开工就写 manual mandate + accept 决策；
//   strict=true        ：**再强制**——无依据的系统受理会被 OUT_OF_MANDATE 拒掉。
//
// ★ 为什么"记账"本身就有价值
//   台账的意义是"事后答得出凭什么"。哪怕今天不拦，从这一刻起每条开工的任务
//   都留下了依据；等 strict 打开时，历史数据已经齐了。
// ============================================================================

import { buildMandate, MANDATE_ERRORS } from './mandate-policy.mjs'
import { decideForCandidate, recordDecision } from './decisions.mjs'
import { ensureColumn } from './schema-util.mjs'

export const ACCEPTANCE_ERRORS = Object.freeze({
  OUT_OF_MANDATE: MANDATE_ERRORS.OUT_OF_MANDATE,
  TASK_NOT_FOUND: 'ACCEPTANCE_TASK_NOT_FOUND',
})

export class AcceptanceError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`)
    this.name = 'AcceptanceError'
    this.code = code
    this.statusCode = code === ACCEPTANCE_ERRORS.TASK_NOT_FOUND ? 404 : 422
    Object.assign(this, extra)
  }
}

/** 建本层需要的列（并发安全由 ensureColumn 保证）。 */
export function ensureAcceptanceSchema(db) {
  ensureColumn(db, 'tasks', 'mandate', 'JSON')
  ensureColumn(db, 'tasks', 'accept_mode', 'TEXT')
}

const text = (v) => (typeof v === 'string' ? v.trim() : '')

/** 这台"人"是不是人（而不是守护/系统）：`daemon` / `system` / `agent:*` 不算。 */
function looksHuman(by) {
  const who = text(by).toLowerCase()
  if (who === '') return false
  if (who.startsWith('agent:')) return false
  if (['daemon', 'system', 'worker', 'bot', '守护'].includes(who)) return false
  return true
}

/** 生效的规则 id（enabled=1 且 scope 为空或与本任务同域）。 */
function matchedRuleIds(db, scope) {
  try {
    const rows = db.prepare('SELECT id FROM policy_rules WHERE enabled=1 AND (scope IS NULL OR scope=? or scope=\'\') ORDER BY id').all(scope ?? 'default')
    return rows.map((r) => String(r.id))
  } catch {
    return [] // 台账表还没建（极简夹具）⇒ 没有规则可命中
  }
}

/**
 * 在 `→ todo` 时写授权与台账。
 *
 * @param db
 * @param input.taskId / input.by / input.at
 * @param deps.audit       (member, scope, action, taskId, detail) => seq
 * @param deps.strict      true ⇒ 无依据即拒（默认 false：先记账）
 * @param deps.acceptMode  空间级受理模式（真值在空间设置，任务上只留快照）
 * @param deps.strength    'explicit' | 'inferred'
 * @param deps.paths       期望改动路径（用于 fileDomain 判定）
 */
export function acceptOnTodo(db, { taskId, by = 'system', at = null, paths = [] } = {}, {
  audit = null, strict = false, acceptMode = 'manual', strength = 'explicit',
} = {}) {
  const task = db.prepare('SELECT id, scope, mandate FROM tasks WHERE id=?').get(taskId)
  if (!task) throw new AcceptanceError(ACCEPTANCE_ERRORS.TASK_NOT_FOUND, `任务不存在: ${taskId}`)
  const now = at ?? new Date().toISOString()
  const scope = task.scope ?? 'default'

  const human = looksHuman(by)
  const ruleIds = matchedRuleIds(db, scope)
  const existing = task.mandate ? safeJson(task.mandate) : null

  // ① 已写过同版本授权 ⇒ 幂等返回（不叠加 audit、不叠加决策）
  if (existing !== null && existing.grantedAt !== undefined && existing.manual === human && (existing.basisRuleIds ?? []).length === ruleIds.length) {
    const out = { mandate: existing, decision: { kind: 'accept', wouldAccept: false, reason: '已有授权（幂等）' }, duplicated: true }
    if (acceptMode) db.prepare('UPDATE tasks SET accept_mode=? WHERE id=?').run(acceptMode, taskId)
    return out
  }

  const mandate = buildMandate({
    strength,
    requestedBy: { kind: human ? 'user' : 'system', id: by },
    grantedBy: { kind: human ? 'human' : 'system', id: by },
    basisRuleIds: ruleIds,
    manual: human,
    scope: { fileDomain: Array.isArray(paths) && paths.length > 0 ? awaitDomains(paths) : [], stages: [] },
    grantedAt: now,
    version: existing !== null ? (Number(existing.version) || 1) + 1 : 1,
    supersedes: existing !== null ? (Number(existing.version) || 1) : null,
  })

  const decision = decideForCandidate({ mandate, ctx: { paths, acceptMode }, hasRoom: true })

  // ② strict 下拒绝：不写授权，但**必须**留下 stop 台账
  if (strict && decision.kind !== 'accept') {
    recordDecision(db, {
      subject: `task:${taskId}`, kind: 'stop', by, at: now,
      matchedRuleIds: ruleIds, reason: decision.reason, policyVersion: mandate.policyVersion,
    })
    throw new AcceptanceError(ACCEPTANCE_ERRORS.OUT_OF_MANDATE, decision.reason, { decision })
  }

  // ③ 记账：mandate 落盘 + 决策 + audit
  db.prepare('UPDATE tasks SET mandate=?, accept_mode=? WHERE id=?')
    .run(JSON.stringify(mandate), acceptMode, taskId)
  recordDecision(db, {
    subject: `task:${taskId}`, kind: decision.kind, by, at: now,
    matchedRuleIds: ruleIds, manual: mandate.manual === true,
    wouldAccept: decision.wouldAccept === true,
    reason: decision.reason, policyVersion: mandate.policyVersion,
  })
  if (typeof audit === 'function') {
    audit(by, scope, 'mandate', taskId, JSON.stringify({ version: mandate.version, basisRuleIds: ruleIds, manual: mandate.manual }))
  }
  // strict=false 时"按规则不该受理"也会放行，但台账里照样记 stop ——
  // 记录真实判定，比记一个好看的结果有用得多。
  return { mandate, decision, duplicated: false, proceed: true }
}

/** 期望路径 ⇒ 目录前缀（"改了这些文件，就等于授权了这些目录"）。 */
function awaitDomains(paths) {
  const dirs = new Set()
  for (const p of paths) {
    const norm = String(p ?? '').replace(/\\/g, '/')
    const idx = norm.lastIndexOf('/')
    dirs.add(idx >= 0 ? norm.slice(0, idx + 1) : norm)
  }
  return [...dirs]
}

function safeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return null }
}

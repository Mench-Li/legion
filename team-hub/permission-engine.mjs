const MODES = new Set(['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy'])
const REQUIRED = ['scope', 'actor', 'action', 'target']

export function normalizeOperation(input = {}) {
  const operation = {
    scope: String(input.scope ?? '').trim(),
    actor: String(input.actor ?? '').trim(),
    action: String(input.action ?? '').trim(),
    target: String(input.target ?? '').trim(),
    taskId: input.taskId == null ? null : String(input.taskId).trim() || null,
    unattended: input.unattended === true,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? { ...input.metadata } : {},
  }
  for (const field of REQUIRED) if (!operation[field]) throw new Error(`${field} required`)
  return operation
}

function specificity(rule) {
  return ['scope', 'actor', 'action', 'target'].reduce((n, key) => n + (rule[key] ? 1 : 0), 0)
}

export function matchRule(operationInput, rules = [], now = Date.now()) {
  const operation = normalizeOperation(operationInput)
  return rules
    .filter(rule => MODES.has(rule.mode))
    .filter(rule => !rule.expiresAt || Number(rule.expiresAt) > now)
    .filter(rule => ['scope', 'actor', 'action', 'target'].every(key => !rule[key] || String(rule[key]) === operation[key]))
    .filter(rule => !rule.taskId || rule.taskId === operation.taskId)
    .sort((a, b) => specificity(b) - specificity(a) || Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))[0] || null
}

function isHardFloor(operation) {
  return operation.metadata.irreversible === true || ['file:delete', 'repo:push', 'credential:write'].includes(operation.action)
}

export function evaluatePermission(operationInput, rules = [], context = {}) {
  const operation = normalizeOperation(operationInput)
  const now = Number(context.now || Date.now())
  if (isHardFloor(operation)) return { operation, allowed: false, decision: 'deny', mode: 'deny', reason: 'hard-floor', matchedRule: null, status: 'denied' }
  const rule = matchRule(operation, rules, now)
  const mode = rule?.mode || (operation.unattended ? 'deny' : 'ask')
  if (!MODES.has(mode)) return { operation, allowed: false, decision: 'deny', mode: 'deny', reason: 'invalid-mode', matchedRule: rule, status: 'denied' }
  if (mode === 'allow-by-policy') return { operation, allowed: true, decision: 'allow', mode, reason: 'policy', matchedRule: rule, status: 'approved' }
  if (mode === 'allow-for-task' && operation.taskId) return { operation, allowed: true, decision: 'allow', mode, reason: 'task-policy', matchedRule: rule, status: 'approved' }
  if (mode === 'allow-once') return { operation, allowed: false, decision: 'allow-once', mode, reason: 'approval-required', matchedRule: rule, status: 'pending' }
  if (mode === 'ask') return { operation, allowed: false, decision: 'ask', mode, reason: 'approval-required', matchedRule: rule, status: 'pending' }
  return { operation, allowed: false, decision: 'deny', mode, reason: mode === 'deny' ? 'policy' : 'invalid-task', matchedRule: rule, status: 'denied' }
}

export function consumeDecision(decision, operationInput) {
  const operation = normalizeOperation(operationInput)
  if (decision?.status !== 'approved') throw new Error('decision not consumable')
  if (decision.operation && JSON.stringify(decision.operation) !== JSON.stringify(operation)) throw new Error('operation mismatch')
  return { ...decision, operation, status: 'consumed', consumedAt: Date.now() }
}

export { MODES }

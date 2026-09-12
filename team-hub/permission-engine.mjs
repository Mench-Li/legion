// ============================================================================
// F-02 权限内核（team-hub 侧策略核心）
//
// PRT-611 扩展了它的 canonical operation。在此之前，F-02 判"这次调用是不是我
// 批准的那一次"用的是 `JSON.stringify(a) === JSON.stringify(b)`。
// 它坏在两个**方向不同**的地方，而只有一个方向会有人来报 bug：
//
// **① 键的书写顺序被当成了操作身份的一部分。**
// `JSON.stringify` 按插入顺序输出；`{a,b}` 与 `{b,a}` 是**同一个对象**，
// 却得到不同的字符串。顶层因为 `normalizeOperation` 固定了字段顺序而侥幸没事，
// 但 `metadata` 是 `{ ...input.metadata }`——它的键序由调用方决定。
// 于是一次 `{path, mode}` 的批准，遇到 `{mode, path}` 的再次调用就会被拒。
//
//   > 一个把「键的书写顺序」当成「操作的身份」的一部分的审批绑定，
//   > 与一个"每次执行都要重新问一遍"的审批绑定，
//   > 在"用户会不会觉得这个审批按钮没用"上是同一个东西。
//
// 这个方向是**拒绝**，也就是 fail-closed。它不造成任何危险，所以没人为它报 bug
// ——这才是它值得写下来的原因。
//
// **② 规范化丢掉的字段，等于审批没有绑定到它。**
// 这个方向是**放行**，才是真正危险的那一个。`normalizeOperation` 收的是一组写死的
// 字段，任何新加的、没被列进去的字段都会被静默丢掉：审批绑定的于是成了
// "前若干个字段恰好相同"，而不是"这次操作相同"。
//
//   > 一个"忘了把新字段放进规范化集合"的哈希，
//   > 与一个"只绑定到前六个字段"的哈希，是同一个东西——
//   > 而它的方向是**放行**。
//
// 所以 PRT-611 做三件事：
//   ① 指纹用**规范化 JSON**（键排序、NFC、-0 归一）算，键序不再影响身份；
//   ② 指纹带 domain separator，与 DSH 侧的 `canonicalOperationHash`
//      **在构造上**不可互换（§6.5：「两者使用不同的 Schema 和 domain separator」）；
//   ③ 一条**加载时**自检：`OPERATION_KEYS` 必须与 `normalizeOperation` 真正产出的
//      字段**逐个对齐**。加字段却忘了同步名单，启动就崩。
// ============================================================================

import { canonicalJson, domainSeparatedHash, nfc } from '../runtime/contracts/canonical.mjs'

const MODES = new Set(['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy'])
const REQUIRED = ['scope', 'actor', 'action', 'target']

/**
 * F-02 操作对象的**闭合**字段集合。授权判定与审批绑定都只看这些字段。
 *
 * 「闭合」是重点：这个名单之外的字段**不参与**审批身份，因此往里加字段
 * 而不改这个名单，等于让那个字段可以被随便改。加载时的自检就是为了拦这件事。
 */
export const OPERATION_KEYS = Object.freeze([
  'scope', 'actor', 'action', 'target', 'taskId', 'unattended', 'metadata',
])

/** 申请批准时用的 domain。与 DSH 侧的 `CANONICAL_OP_DOMAIN` **不同**。 */
export const OPERATION_DOMAIN = 'legion.permission.operation.v1'
export const OPERATION_SCHEMA_VERSION = 1

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

/**
 * 收进 canonical operation：**只有** `OPERATION_KEYS` 里的字段参与，
 * 每个字符串过 NFC，可选字段补成规范默认值。
 *
 * 返回对象按 `OPERATION_KEYS` 的顺序构造。顺序本身不影响指纹
 * （`canonicalJson` 会排序），这样做只是为了让 `deepEqual` 与诊断输出稳定。
 */
export function canonicalOperation(operationInput = {}) {
  const operation = normalizeOperation(operationInput)
  const out = {}
  for (const key of OPERATION_KEYS) out[key] = operation[key]
  out.scope = nfc(out.scope)
  out.actor = nfc(out.actor)
  out.action = nfc(out.action)
  out.target = nfc(out.target)
  if (out.taskId !== null) out.taskId = nfc(out.taskId)
  return Object.freeze(out)
}

/**
 * 一次 F-02 操作的指纹：`sha256(domain \u0000 schemaVersion \u0000 canonicalJson(op))`。
 *
 * 键序无关（`canonicalJson` 排序）、`-0` 与 `0` 同值、组合字符与预组合字符同字
 * （NFC）。因此"同一个操作"在任何书写方式下都得到同一个指纹。
 */
export function operationFingerprint(operationInput = {}) {
  return domainSeparatedHash(OPERATION_DOMAIN, OPERATION_SCHEMA_VERSION, canonicalOperation(operationInput))
}

/** canonical 文本，仅供诊断。**不用于比较**——比较一律走指纹。 */
export function operationCanonicalText(operationInput = {}) {
  return canonicalJson(canonicalOperation(operationInput))
}

/**
 * 两次调用是不是**同一个操作**。
 *
 * 这是 `JSON.stringify(a) === JSON.stringify(b)` 的替代品。用指纹而不是文本比较，
 * 是因为文本比较会把键序算进去。
 *
 * 它**不**做部分匹配：少一个字段的 `other` 会走 `normalizeOperation` 的默认值，
 * 因此 `{scope,actor,action,target}` 与同一组字段加 `taskId: null` 是同一个操作
 * （`null` 就是 `taskId` 的默认值），而 `taskId: 'x'` 不是。这是有意的——
 * 默认值相同的两次调用本来就该是同一个操作。
 */
export function sameOperation(a, b) {
  try {
    return operationFingerprint(a) === operationFingerprint(b)
  } catch {
    // 任一侧无法规范化（缺必需字段、metadata 里塞了不能表达的值）→ **判不同**。
    // 判"相同"会让一次来路不明的调用继承别人的批准。
    return false
  }
}

/**
 * 自检：`OPERATION_KEYS` 必须与 `normalizeOperation` 真正产出的字段**逐个对齐**。
 *
 * **为什么需要它**：`canonicalOperation` 只取 `OPERATION_KEYS` 里的字段。
 * 谁往 `normalizeOperation` 里加了一个字段（比如 `runId`）却忘了加进名单，
 * 那个字段就不会进入指纹——**改了它，审批照样通过**。
 * 而这个错误在代码里完全看不出来：`normalizeOperation` 的输出里有它，
 * 所有既有用例也都还是绿的。
 *
 * 把样本做成参数，是为了让用例能喂一对**故意错位**的名单进来，验它真的会拦：
 * 一个只能对"当前恰好正确的那份输入"作答的校验，与一个恒真的校验，同形。
 */
export function assertOperationKeysAligned(
  keys = OPERATION_KEYS,
  sample = SAMPLE_OPERATION,
) {
  const produced = Object.keys(normalizeOperation(sample))
  const declared = [...keys]
  // 产出了却没进名单 → 这个字段改了也不会让审批失效（**危险方向**）
  const missing = produced.filter((k) => !declared.includes(k))
  // 名单里有但产出里没有 → 指纹里恒为 undefined，规范化在这里静默丢字段
  const extra = declared.filter((k) => !produced.includes(k))
  return Object.freeze({
    ok: missing.length === 0 && extra.length === 0,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
  })
}

/** 自检样本：**每个可选字段都填上**，这样"漏列"才看得出来。 */
const SAMPLE_OPERATION = Object.freeze({
  scope: 's', actor: 'a', action: 'act', target: 't',
  taskId: 'k', unattended: true, metadata: { z: 1 },
})

// 加载即执行，并留下**真正算出来的**证据（产出的字段名）。
// 不导出一个布尔"通过"标记：`ok: true` 是随手就能写出来的字面量，
// 而能把它写成 true 的，恰恰就是那个把自检删掉的改动。
export const OPERATION_KEYS_CHECKED = Object.freeze({
  ...assertOperationKeysAligned(),
  producedKeys: Object.freeze(Object.keys(normalizeOperation(SAMPLE_OPERATION))),
})

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
  // PRT-611：原来这里是 `JSON.stringify(decision.operation) !== JSON.stringify(operation)`。
  // 改成指纹比较，键序不再影响身份。
  if (decision.operation && !sameOperation(decision.operation, operation)) throw new Error('operation mismatch')
  return { ...decision, operation, status: 'consumed', consumedAt: Date.now() }
}

export { MODES }

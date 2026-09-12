// team-hub/tool-call-log.mjs
// ============================================================================
// PRT-610：持久化工具调用、决定与**决定来源**、结果和幂等键
//
// spec §6.8 line 480：
//   「`tool_calls` 必须记录决定来源（pre-execute / guard / approval / sandbox 兜底）；
//     否则事后无法区分策略拒绝与沙箱兜底拒绝，而这两类的**修复动作不同**。」
//
// spec §6.8 line 479：
//   「guard 只有降级语义、**没有 allow 语义**，出现"人工已批准但仍被 guard 拒绝"
//     即视为强制面配置错误，必须能由审计定位到具体强制点。」
//
// spec §6.8 line 470：
//   「**原始输入和 canonical 输入同时保存**，执行只使用与哈希一致的不可变参数。」
//
// spec §6.5 line 478：
//   「F-02 的 `allow-once` 是按 canonical operation 哈希的一次性决定，
//     DSH 的 `allowed-once` 是按 `callId` 的一次性授权。**两者不是一回事**。」
//
// ---------------------------------------------------------------------------
// 这一批的四个判据，各自对应一个安静的失效
//
// **① 来源列必须闭合，且要与强制点的语义一致。**
// 一个"什么都接受"的来源列，与一个"来源永远是 unknown"的来源列，在"事后能不能
// 区分策略拒绝与沙箱兜底拒绝"上是同一个东西——只不过前者看起来有数据。
//
//   > 一个「接受 `source='guard', decision='allow'` 的表」，
//   > 与一个「来源列永远说得通」的表，是同一个东西——
//   > 只不过前者让你在审计里看到一次"hard floor 批准了这个操作"。
//
// **② 原始输入与 canonical 输入都要存。**
// 只存 canonical，事后回答不了"模型当初到底要它做什么"（UI 与审计需要回答）；
// 只存原始输入，执行时就得**按当前规则重新推导** canonical —— 那意味着
// 一次审批的含义由"你执行它的那一刻的代码"决定。
//
//   > 一个「执行时按当前规则重新推导 canonical 输入」的实现，
//   > 与一个「审批的含义由你执行它的那一刻的代码决定」的实现，是同一个东西。
//
// **③ 幂等键必须按 callId，不能按 canonical 哈希。**
// 两者不是一回事（§6.5 line 478）。授权身份是**内容**（同一 Attempt 内同一哈希
// 只放行一次，PRT-616），执行身份是**这一次调用**。用错键的两个方向：
//   · 拿内容当执行键 → 一次崩溃后的合法重试被永久读成"已经执行过了"（拒绝方向）
//   · 拿 callId 当授权键 → PRT-616 那个"同一操作放行两次"的洞（放行方向）
//
//   > 一个「把授权账本的键拿来当执行幂等键」的表，
//   > 与一个「一次合法重试永远做不了、而另一个操作却能做两次」的表，是同一个东西。
//
// **④ 结果必须能表达"已派发但结果未知"。**
// 只有"成功/失败"两态时，一个崩在派发之后的写操作会被读成"没执行过"，
// 于是重试 → 同一个外部写做两遍。
//
//   > 一个只有「成功/失败」两态的结果列，
//   > 与一个「把崩在中途的写操作读成『没执行过』」的结果列，是同一个东西——
//   > 而它的表现是重试一次外部写操作。
// ============================================================================

import { createHash } from 'node:crypto'

import { nfc } from '../runtime/contracts/canonical.mjs'
import { ENFORCEMENT_SOURCES } from '../runtime/dsh-composition/enforcement.mjs'

export const TOOL_CALL_LOG_VERSION = 'legion/tool-call-log@1'

export const TOOL_CALL_TABLE = 'tool_calls'

/**
 * 决定来源。**引用**强制面那一份，不在这里另抄一份。
 *
 *   > 一个「把来源列表抄一份」的表，
 *   > 与一个「两份列表迟早不一样」的表，是同一个东西——
 *   > 而它的表现是「新的强制点在审计里根本不存在」。
 */
export const DECISION_SOURCES = ENFORCEMENT_SOURCES

/** 沙箱兜底：**不是**策略决定，是"策略没给确定答案时环境替你拒绝了"。 */
export const SANDBOX_FALLBACK_SOURCE = 'sandbox'

/**
 * 每个来源**可能**产出的决定。
 *
 * 这不是"多写的校验"，而是 §6.8 line 479 的直接编码：guard **只有降级语义**。
 * 一条 `{source:'guard', decision:'allow'}` 的记录在语义上是不可能的，
 * 而接受它会让"这次到底是谁放行的"永远查不出来。
 *
 *   > 一个「来源与决定可以任意组合」的表，
 *   > 与一个「来源列可以被填成任何东西」的表，是同一个东西。
 */
export const SOURCE_DECISIONS = Object.freeze({
  'pre-execute': Object.freeze(['allow', 'deny', 'ask']),
  // §6.8 line 479：guard 只有降级语义、没有 allow 语义
  guard: Object.freeze(['deny']),
  approval: Object.freeze(['allow', 'deny']),
  // 沙箱兜底只会拒绝：它没有"允许"这条路
  sandbox: Object.freeze(['deny']),
})

/**
 * 来源 → 修复动作。这张表就是 §6.8 line 480 那句"两类的修复动作不同"的落地。
 *
 * 它必须是一张**查得到**的表，而不是文档里的一句话：值班的人拿到一条拒绝记录时，
 * 要能直接读出"该去改哪里"。
 */
export const SOURCE_REPAIR_ACTIONS = Object.freeze({
  'pre-execute': '改策略规则（permission_rules / 策略门端口）',
  guard: '改 hard floor 或工具声明（静态下限不接受审批影响）',
  approval: '改审批链（answerer / 审批箱 / 无人值守策略）',
  sandbox: '改沙箱配置（这不是策略问题，改策略不会有任何效果）',
})

/**
 * 结果状态。**四态**，而且第四态不可省。
 *
 * `unknown` = "已经派发出去了，但结果没有回来"（进程被杀、超时、连接断）。
 * 它**必须**与 `none`（确定没派发过）分开：合成一态就意味着一次重试可能把
 * 一个已经生效的外部写操作再做一遍。
 */
export const RESULT_STATUSES = Object.freeze({
  NONE: 'none',
  OK: 'ok',
  ERROR: 'error',
  UNKNOWN: 'unknown',
})

/**
 * 自动重试的安全性。
 *
 * `none`  → 确定没派发过，可重试
 * `ok`    → 已经做完了，**不重试**（重试会返回缓存结果，见 `assertRetryable`）
 * `error` → 只有工具被声明为幂等时才可重试：外部写可能"部分生效"
 * `unknown` → **永不可自动重试**，必须由人或探针先把状态弄清楚
 */
export const RETRY_SAFETY = Object.freeze({
  none: 'safe',
  ok: 'already-done',
  error: 'needs-idempotent-tool',
  unknown: 'must-resolve-first',
})

const TOOL_CALL_COLUMNS = Object.freeze([
  'idempotencyKey', 'callId', 'attemptId', 'runId', 'scope', 'taskId', 'toolName',
  'decision', 'decisionSource', 'reason',
  'rawInput', 'canonicalInput', 'canonicalHash',
  'resultStatus', 'result', 'attempts',
  'firstSeenAt', 'updatedAt', 'dispatchedAt', 'settledAt',
])

// ----------------------------------------------------------------------- schema

export function ensureToolCallSchema(db) {
  if (db === null || typeof db !== 'object' || typeof db.exec !== 'function') {
    throw new TypeError('ensureToolCallSchema 需要 db（且必须有 exec）')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TOOL_CALL_TABLE} (
      idempotencyKey TEXT PRIMARY KEY,
      callId TEXT NOT NULL,
      attemptId TEXT,
      runId TEXT,
      scope TEXT,
      taskId TEXT,
      toolName TEXT NOT NULL,
      decision TEXT NOT NULL,
      decisionSource TEXT NOT NULL,
      reason TEXT,
      rawInput TEXT NOT NULL,
      canonicalInput TEXT NOT NULL,
      canonicalHash TEXT NOT NULL,
      resultStatus TEXT NOT NULL DEFAULT 'none',
      result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      firstSeenAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      dispatchedAt TEXT,
      settledAt TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_call ON ${TOOL_CALL_TABLE} (callId)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_attempt ON ${TOOL_CALL_TABLE} (attemptId)`)
  // 按来源统计是"事后区分两类拒绝"的最常见动作（§6.8 line 480）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_source ON ${TOOL_CALL_TABLE} (decisionSource, decision)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_hash ON ${TOOL_CALL_TABLE} (canonicalHash)`)
  return true
}

// ------------------------------------------------------------------ idempotency

/**
 * 幂等键。
 *
 * 按 `callId`，**不按** canonical 哈希（§6.5 line 478：两者不是一回事）。
 *
 * 也**不**包含时间戳、attemptId、重试次数：包含它们就等于给每次重试发一个新键，
 * 而"重试"恰恰是幂等键存在的理由。
 *
 *   > 一个「把时间戳算进幂等键」的幂等键，
 *   > 与一个「每次重试都是全新调用」的幂等键，是同一个东西——
 *   > 只不过它坏在"重试"这条路径上。
 */
export function toolCallIdempotencyKey({ callId } = {}) {
  const id = callId === null || callId === undefined ? '' : nfc(String(callId)).trim()
  if (id === '') {
    throw new TypeError(
      'toolCallIdempotencyKey 需要非空 callId：'
      + '没有 callId 就没有"这一次调用"的身份，用它做幂等键的后果是'
      + '要么放过重复执行、要么把两次不同的调用并成一次',
    )
  }
  return id
}

// ------------------------------------------------------------------- 写入校验

/** 校验 (source, decision) 组合合法。返回规范化后的来源。 */
export function assertSourceDecision(source, decision) {
  const s = source === null || source === undefined ? '' : String(source)
  if (!DECISION_SOURCES.includes(s)) {
    throw new Error(
      `未知的决定来源 ${JSON.stringify(source)}（合法值：${DECISION_SOURCES.join(' / ')}）——`
      + '来源写错会让这条记录在"事后区分两类拒绝"时归错类，而分类错的修复动作是错的',
    )
  }
  const allowed = SOURCE_DECISIONS[s]
  if (!allowed.includes(decision)) {
    throw new Error(
      `决定来源 ${s} 不可能产出 decision=${JSON.stringify(decision)}（该来源只可能：${allowed.join(' / ')}）——`
      + (s === 'guard'
        ? 'guard 只有降级语义、没有 allow 语义（spec §6.8）'
        : s === 'sandbox'
          ? '沙箱兜底只会拒绝，它没有"允许"这条路'
          : '这条记录会掩盖"到底是谁做的这个决定"'),
    )
  }
  return s
}

export function assertResultStatus(status) {
  const s = status === null || status === undefined ? '' : String(status)
  if (!Object.values(RESULT_STATUSES).includes(s)) {
    throw new Error(
      `未知的结果状态 ${JSON.stringify(status)}（合法值：${Object.values(RESULT_STATUSES).join(' / ')}）`,
    )
  }
  return s
}

/**
 * 复核 canonical 输入**确实**是原始输入的投影。
 *
 * 两个都存的意义就在于它们能被对起来。若可以随便存两份不一致的东西，
 * "同时保存"退化成了"存两份"——
 *
 *   > 一个「两份输入都可能对、也可能不对」的表，
 *   > 与一个「只有一份输入」的表，在「事后能不能证明执行的是被批准的那次」上
 *   > 是同一个东西。
 *
 * `project` 可注入，理由与前几批一样：正确实现下这份不一致**永远为假**，
 * 那段断言永远不触发——
 *
 *   > 一段永远不会触发的断言，与一段不存在的断言，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 */
export function assertCanonicalMatchesRaw({ rawInput, canonicalInput, project } = {}) {
  if (typeof project !== 'function') {
    throw new Error('assertCanonicalMatchesRaw 需要 project（怎么从原始输入算出 canonical 输入）')
  }
  const expected = project(rawInput)
  const got = canonicalInput
  const a = JSON.stringify(expected)
  const b = JSON.stringify(got)
  if (a !== b) {
    throw new Error(
      'canonical 输入与它由原始输入算出的结果不一致——'
      + `存的 canonical=${b}，由 raw 算出的=${a}。`
      + '这会让"执行的是被批准的那次"无法被证明（要么执行时按当前规则重推，要么审计里看到的是另一份输入）',
    )
  }
  return Object.freeze({ ok: true, canonicalText: b })
}

// --------------------------------------------------------------------- 最终写入

function keyOf(row) {
  return createHash('sha256').update(String(row)).digest('hex').slice(0, 32)
}

/**
 * 记一次工具调用。
 *
 * 幂等：同一个 `callId` 再进来一次**不会**新增一行，而是把 `attempts` 加一。
 *
 *   > 一个「同一个调用被写了两次」的表，
 *   > 与一个「事后数不出到底调用过几次」的表，是同一个东西。
 *
 * 但同一个 callId 带着**不同的工具名**回来是一次错误（或一次伪装），必须抛：
 *
 *   > 一个「同一个 callId 第二次带着不同的工具名进来、被当成同一次调用」的表，
 *   > 与一个「审计里的工具名可以是任意值」的表，是同一个东西。
 */
export function recordToolCall({
  db,
  callId,
  toolName,
  decision,
  decisionSource,
  reason = null,
  rawInput,
  canonicalInput,
  canonicalHash,
  attemptId = null,
  runId = null,
  scope = null,
  taskId = null,
  atText,
} = {}) {
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new TypeError('recordToolCall 需要 db')
  }
  const source = assertSourceDecision(decisionSource, decision)
  const name = nfc(String(toolName ?? '')).trim()
  if (name === '') throw new Error('recordToolCall 需要非空 toolName')
  const key = toolCallIdempotencyKey({ callId })
  const at = String(atText ?? '')

  const existing = db.prepare(`SELECT * FROM ${TOOL_CALL_TABLE} WHERE idempotencyKey=?`).get(key)
  if (existing !== undefined && existing !== null) {
    if (existing.toolName !== name) {
      throw new Error(
        `同一个 callId（${key}）第二次带着不同的工具名进来：`
        + `第一次是 ${JSON.stringify(existing.toolName)}，这次是 ${JSON.stringify(name)}——`
        + '把这两次当成同一次调用，等于让审计里的工具名变成任意值',
      )
    }
    if (existing.canonicalHash !== canonicalHash) {
      throw new Error(
        `同一个 callId（${key}）第二次带着不同的 canonical 哈希进来：`
        + '重试必须是**同一次调用**的重试，参数变了就是另一次调用（spec §6.5：不得静默改写）',
      )
    }
    db.prepare(`UPDATE ${TOOL_CALL_TABLE} SET attempts = attempts + 1, updatedAt = ? WHERE idempotencyKey = ?`).run(at, key)
    return Object.freeze({ outcome: 'duplicate', idempotencyKey: key, attempts: Number(existing.attempts) + 1 })
  }

  db.prepare(`INSERT INTO ${TOOL_CALL_TABLE} (${TOOL_CALL_COLUMNS.join(',')})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    key, key, attemptId, runId, scope, taskId, name,
    String(decision), source, reason === null ? null : String(reason),
    JSON.stringify(rawInput ?? null), JSON.stringify(canonicalInput ?? null), String(canonicalHash),
    RESULT_STATUSES.NONE, null, 0,
    at, at, null, null,
  )
  return Object.freeze({ outcome: 'recorded', idempotencyKey: key, attempts: 0 })
}

/**
 * 标记"已经派发出去了"。
 *
 * 这一步**必须**先落库再真的派发。反过来的话，一个崩在派发之后的进程会留下
 * 一行 `resultStatus='none'` —— 而那正是"确定没执行过"的意思，
 * 于是重试会把外部写做两遍。
 *
 *   > 一个「先派发再记账」的顺序，
 *   > 与一个「把已经发生的副作用记成『还没发生』」的顺序，是同一个东西。
 */
export function markDispatched({ db, idempotencyKey, atText } = {}) {
  const at = String(atText ?? '')
  const res = db.prepare(
    `UPDATE ${TOOL_CALL_TABLE} SET resultStatus=?, dispatchedAt=?,
       updatedAt=? WHERE idempotencyKey=? AND resultStatus=?`,
  ).run(RESULT_STATUSES.UNKNOWN, at, at, String(idempotencyKey), RESULT_STATUSES.NONE)
  if (Number(res.changes) !== 1) {
    throw new Error(
      `不能把 ${idempotencyKey} 标记为"已派发"：它不在 none 状态`
      + '（要么已经派发过、要么已经有结果）——重复派发是外部写做两遍的直接原因',
    )
  }
  return Object.freeze({ outcome: 'dispatched', idempotencyKey: String(idempotencyKey) })
}

/** 记结果。只有"已派发"的行能落结果，且 `unknown` 可以被真实结果覆盖。 */
export function recordResult({ db, idempotencyKey, status, result = null, atText } = {}) {
  const s = assertResultStatus(status)
  const at = String(atText ?? '')
  const res = db.prepare(
    `UPDATE ${TOOL_CALL_TABLE} SET resultStatus=?, result=?, settledAt=?, updatedAt=?
     WHERE idempotencyKey=? AND dispatchedAt IS NOT NULL`,
  ).run(s, result === null ? null : JSON.stringify(result), at, at, String(idempotencyKey))
  if (Number(res.changes) !== 1) {
    throw new Error(
      `不能给 ${idempotencyKey} 落结果：它没有"已派发"记录。`
      + '先派发再记账的顺序是可重试性的全部依据（否则会把"没执行过"和"结果未知"混起来）',
    )
  }
  return Object.freeze({ outcome: 'settled', idempotencyKey: String(idempotencyKey), status: s })
}

/** 读一行（**只读叶字段**，不返回行对象本身）。 */
export function readToolCall({ db, idempotencyKey } = {}) {
  const row = db.prepare(`SELECT * FROM ${TOOL_CALL_TABLE} WHERE idempotencyKey=?`).get(String(idempotencyKey))
  if (row === null || row === undefined) return null
  return Object.freeze({
    idempotencyKey: row.idempotencyKey,
    callId: row.callId,
    attemptId: row.attemptId ?? null,
    runId: row.runId ?? null,
    toolName: row.toolName,
    decision: row.decision,
    decisionSource: row.decisionSource,
    reason: row.reason ?? null,
    rawInput: JSON.parse(row.rawInput),
    canonicalInput: JSON.parse(row.canonicalInput),
    canonicalHash: row.canonicalHash,
    resultStatus: row.resultStatus,
    result: row.result === null ? null : JSON.parse(row.result),
    attempts: Number(row.attempts),
    dispatchedAt: row.dispatchedAt ?? null,
    settledAt: row.settledAt ?? null,
  })
}

/**
 * 这次调用现在能不能自动重试。
 *
 * 判据见 `RETRY_SAFETY`。**`unknown` 永远不自动重试**：那意味着已经有一个
 * 副作用可能发生了，而我们对它一无所知。
 */
export function assertRetryable(row, { toolIsIdempotent = false } = {}) {
  if (row === null || row === undefined) {
    return Object.freeze({ retryable: true, safety: 'safe', reason: '无记录：确定没调用过' })
  }
  const safety = RETRY_SAFETY[row.resultStatus] ?? 'must-resolve-first'
  if (row.resultStatus === RESULT_STATUSES.NONE) {
    return Object.freeze({ retryable: true, safety, reason: '确定没有派发过' })
  }
  if (row.resultStatus === RESULT_STATUSES.OK) {
    return Object.freeze({ retryable: false, safety, reason: '已经做完了：应当返回缓存结果，不是重做' })
  }
  if (row.resultStatus === RESULT_STATUSES.ERROR) {
    return Object.freeze({
      retryable: toolIsIdempotent === true,
      safety,
      reason: toolIsIdempotent === true
        ? '上次明确失败，且该工具声明为幂等'
        : '上次明确失败，但该工具未声明幂等：外部写可能"部分生效"，重试要人先确认',
    })
  }
  // unknown
  return Object.freeze({
    retryable: false,
    safety,
    reason: '已派发但结果未知：再执行一次就可能把同一个外部写做第二遍，必须先由人或探针查清状态',
  })
}

/**
 * "这条拒绝该去哪里修" —— §6.8 line 480 那句"两类的修复动作不同"的落地。
 *
 * 它把 `decisionSource` 从"一个记录下来的字段"变成"一个能照着做的动作"。
 * 一个只记录来源、却不给出动作的日志，与一个没有来源的日志，
 * 在"值班的人拿到它之后做了什么"上是同一个东西。
 */
export function explainRejection(row) {
  if (row === null || row === undefined) throw new Error('explainRejection 需要一行记录')
  if (row.decision !== 'deny') {
    return Object.freeze({
      denied: false,
      decision: row.decision,
      decisionSource: row.decisionSource,
      repairAction: null,
      isSandboxFallback: false,
    })
  }
  const action = SOURCE_REPAIR_ACTIONS[row.decisionSource]
  if (action === undefined) throw new Error(`未知的决定来源 ${JSON.stringify(row.decisionSource)}`)
  return Object.freeze({
    denied: true,
    decision: row.decision,
    decisionSource: row.decisionSource,
    reason: row.reason ?? null,
    repairAction: action,
    isSandboxFallback: row.decisionSource === SANDBOX_FALLBACK_SOURCE,
  })
}

/** 按来源分组统计（"事后区分两类拒绝"的最直接读法）。 */
export function countBySource({ db, decision = null } = {}) {
  const rows = decision === null
    ? db.prepare(`SELECT decisionSource, decision, COUNT(*) AS n FROM ${TOOL_CALL_TABLE} GROUP BY decisionSource, decision`).all()
    : db.prepare(`SELECT decisionSource, decision, COUNT(*) AS n FROM ${TOOL_CALL_TABLE} WHERE decision=? GROUP BY decisionSource, decision`).all(decision)
  return rows.map((r) => Object.freeze({
    decisionSource: r.decisionSource, decision: r.decision, count: Number(r.n),
  }))
}

// ---------------------------------------------------------------- 装载时自检

/**
 * 自检：`SOURCE_DECISIONS` / `SOURCE_REPAIR_ACTIONS` 必须与 `DECISION_SOURCES`
 * **逐个对齐**。
 *
 * 加一个来源却忘了给它一张修复动作表，代码里完全看不出来：新来源照样能写进库，
 * 只是在值班的人查它的时候 `explainRejection` 抛一个 `未知的决定来源`——
 * 而那时离事故已经很久了。
 *
 *   > 一个「来源名单加了、动作表没加」的修复动作表，
 *   > 与一个「新来源的拒绝永远无人能修」的修复动作表，是同一个东西。
 *
 * `sources` / `decisions` / `actions` 可注入，让"漏了一个"能被真的构造出来。
 */
export function assertSourcesCovered({
  sources = DECISION_SOURCES,
  decisions = SOURCE_DECISIONS,
  actions = SOURCE_REPAIR_ACTIONS,
} = {}) {
  const missingDecisions = sources.filter((s) => !Array.isArray(decisions[s]) || decisions[s].length === 0)
  const missingActions = sources.filter((s) => typeof actions[s] !== 'string' || actions[s].trim() === '')
  // 反向：动作表里留着一个已经不存在的来源 → 那份动作永远不会被读到
  const orphanActions = Object.keys(actions).filter((s) => !sources.includes(s))
  const orphanDecisions = Object.keys(decisions).filter((s) => !sources.includes(s))
  // 每个来源至少有一个"拒绝"形态：否则 explainRejection 对它永远走不到
  const noDeny = sources.filter((s) => !(decisions[s] ?? []).includes('deny'))
  return Object.freeze({
    sources: Object.freeze([...sources]),
    missingDecisions: Object.freeze(missingDecisions),
    missingActions: Object.freeze(missingActions),
    orphanActions: Object.freeze(orphanActions),
    orphanDecisions: Object.freeze(orphanDecisions),
    noDeny: Object.freeze(noDeny),
  })
}

export function assertSourcesAligned(evidence = assertSourcesCovered()) {
  if (evidence.missingDecisions.length > 0) {
    throw new Error(`内部错误（PRT-610）：来源 ${evidence.missingDecisions.join('、')} 没有声明可能的决定`)
  }
  if (evidence.missingActions.length > 0) {
    throw new Error(
      `内部错误（PRT-610）：来源 ${evidence.missingActions.join('、')} 没有修复动作——`
      + '它在审计里存在，但拿到它的人不知道该去哪里修（spec §6.8 要求两类拒绝的修复动作可区分）',
    )
  }
  if (evidence.orphanActions.length > 0) {
    throw new Error(`内部错误（PRT-610）：修复动作表里有已不存在的来源 ${evidence.orphanActions.join('、')}`)
  }
  if (evidence.orphanDecisions.length > 0) {
    throw new Error(`内部错误（PRT-610）：决定表里有已不存在的来源 ${evidence.orphanDecisions.join('、')}`)
  }
  if (evidence.noDeny.length > 0) {
    throw new Error(`内部错误（PRT-610）：来源 ${evidence.noDeny.join('、')} 永远不会产出 deny——它的修复动作不会被读到`)
  }
  return evidence
}

// 装载即执行。导出的是**逐个来源算出来的覆盖情况**，不是布尔标记。
export const TOOL_CALL_LOG_CHECKED = Object.freeze({
  version: TOOL_CALL_LOG_VERSION,
  table: TOOL_CALL_TABLE,
  ...assertSourcesAligned(),
  // 一份**算出来的**样例幂等键，让"键里混进了时间戳/attemptId"这件事能被比对
  sampleIdempotencyKey: toolCallIdempotencyKey({ callId: 'call-1' }),
  // 同一个 callId 配上**不同的观察 metadata**（另一次 Attempt、另一个时点、第 7 次重试），
  // 键必须相同。两次调用都写成一模一样的参数是证明不了任何事的——
  //
  //   > 一个「把同一件事写两遍」的对比，
  //   > 与一个「没做对比」的对比，在「它到底证明了什么」上是同一个东西。
  keyIgnoresObservation: Object.freeze([
    toolCallIdempotencyKey({ callId: 'call-1' }),
    toolCallIdempotencyKey({
      callId: 'call-1', attemptId: 'att-9', atText: '2026-09-12T00:00:00.000Z', retryCount: 7, elapsedMs: 8123,
    }),
  ]),
})

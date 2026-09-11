// runtime/contracts/run.mjs
// ============================================================================
// RunRequest / RunEvent / RunResult 与终态契约（PRT-103）
//
// 纯模块，不依赖 Cordis/DSH。
//
// 本模块承载 spec §6.1 中三条最容易在实现里走样的语义，并把它们变成可测函数：
//   1. `execute()` 的事件流**必须**以一个终态事件结束，且终态事件携带/引用 RunResult。
//   2. 取消与完成并发时，**首个成功提交的终态为准**；迟到事件只能作诊断记录。
//   3. `cancel()` 幂等。
// 这三条如果只写在文档里，实现者会在各自的 Adapter 里各解释一遍。
// ============================================================================
import { createHash } from 'node:crypto'

/** 全部 RunEvent 类型（spec §6.1，共 13 种）。 */
export const RUN_EVENT_TYPES = Object.freeze([
  'run.started',
  'model.selected',
  'message.delta',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'usage.updated',
  'artifact.produced',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.outcome_unknown',
])

/** 终态事件类型。事件流必须以其中之一结束，且只出现一次。 */
export const TERMINAL_EVENT_TYPES = Object.freeze([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.outcome_unknown',
])

const EVENT_TYPE_SET = new Set(RUN_EVENT_TYPES)
const TERMINAL_SET = new Set(TERMINAL_EVENT_TYPES)

/** 终态事件 → RunResult.outcome 的固定映射。 */
export const TERMINAL_TO_OUTCOME = Object.freeze({
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
  'run.outcome_unknown': 'outcome_unknown',
})

export function isKnownEventType(type) {
  return EVENT_TYPE_SET.has(type)
}

export function isTerminalEventType(type) {
  return TERMINAL_SET.has(type)
}

/** 仅供测试与 Adapter 复用的单调序号分配器。 */
export function createSeqAllocator(start = 1) {
  let n = start
  return () => n++
}

/** RunRequest 必填字段。契约只校验**存在性与形态**，不解释业务语义。 */
export const RUN_REQUEST_REQUIRED = Object.freeze([
  'runId',
  'attemptId',
  'idempotencyKey',
  'workspaceId',
  'goalId',
  'taskId',
  'employeeId',
  'teamPlanRef',
  'contextSnapshotRef',
  'modelProfileRef',
  'budget',
  'timeoutMs',
  'workdir',
  'permissions',
  'expectedOutput',
])

/**
 * 校验 RunRequest。
 *
 * 注意 `permissions` 与 `expectedOutput` 也在必填之列：spec §4.4 要求「每次员工执行
 * 都有确定的输入快照、输出产物、工具记录」，一个缺工具权限或验收契约的 RunRequest
 * 无法产生可审计的执行，应当拒收而不是补默认值。
 *
 * @param {object} req
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 */
export function validateRunRequest(req) {
  const errors = []
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return { ok: false, errors: ['RunRequest 必须是对象'], value: null }
  }
  for (const field of RUN_REQUEST_REQUIRED) {
    const v = req[field]
    if (v === undefined || v === null || v === '') {
      errors.push(`${field} 必填`)
    }
  }
  const str = (k) => (typeof req[k] === 'string' ? req[k].trim() : '')
  for (const k of ['runId', 'attemptId', 'workspaceId', 'goalId', 'taskId', 'employeeId']) {
    if (req[k] !== undefined && typeof req[k] !== 'string') errors.push(`${k} 必须是字符串`)
  }
  if (req.timeoutMs !== undefined && (typeof req.timeoutMs !== 'number' || !Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0)) {
    errors.push('timeoutMs 必须是正的有限数')
  }
  // 预算：只校验形态。语义（预留/结算/取消返还）属 PRT-510。
  if (req.budget !== undefined && req.budget !== null) {
    if (typeof req.budget !== 'object' || Array.isArray(req.budget)) {
      errors.push('budget 必须是对象')
    } else if (req.budget.maxCostUsd !== undefined) {
      const v = req.budget.maxCostUsd
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errors.push('budget.maxCostUsd 必须是正的有限数')
    }
  }
  // 权限档位：preset 名 + 工具白名单。空白名单是合法的（该员工不能用任何工具）。
  if (req.permissions !== undefined && req.permissions !== null) {
    const p = req.permissions
    if (typeof p !== 'object' || Array.isArray(p)) {
      errors.push('permissions 必须是对象')
    } else {
      if (typeof p.preset !== 'string' || p.preset.trim() === '') errors.push('permissions.preset 必须是字符串')
      if (!Array.isArray(p.tools)) errors.push('permissions.tools 必须是数组')
      else if (p.tools.some((t) => typeof t !== 'string')) errors.push('permissions.tools 只能包含字符串')
    }
  }
  // 预期输出契约：schema 与验收提示必须同时给出
  if (req.expectedOutput !== undefined && req.expectedOutput !== null) {
    const e = req.expectedOutput
    if (typeof e !== 'object' || Array.isArray(e)) {
      errors.push('expectedOutput 必须是对象')
    } else {
      if (e.schema === undefined || e.schema === null) errors.push('expectedOutput.schema 必填')
      if (typeof e.acceptance !== 'string' || e.acceptance.trim() === '') {
        errors.push('expectedOutput.acceptance 必填（验收提示不能为空）')
      }
    }
  }
  // 环境变量必须是白名单数组（spec §6.1「环境变量白名单」）
  if (req.env !== undefined && req.env !== null) {
    if (!Array.isArray(req.env)) errors.push('env 必须是数组（白名单）')
    else if (req.env.some((k) => typeof k !== 'string')) errors.push('env 只能包含字符串')
  }
  if (errors.length > 0) return { ok: false, errors, value: null }

  const value = { ...req }
  for (const k of ['runId', 'attemptId', 'workspaceId', 'goalId', 'taskId', 'employeeId']) value[k] = str(k)
  value.env = Array.isArray(req.env) ? [...req.env] : []
  return { ok: true, errors: [], value }
}

/**
 * 校验单个 RunEvent。`seq` 必须为正整数且严格递增（由调用方保证顺序，这里只判形态）。
 *
 * @param {object} event
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRunEvent(event) {
  const errors = []
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['RunEvent 必须是对象'] }
  }
  if (!EVENT_TYPE_SET.has(event.type)) {
    errors.push(`未知事件类型：${String(event.type)}`)
  }
  if (typeof event.runId !== 'string' || event.runId.trim() === '') errors.push('runId 必填')
  if (typeof event.seq !== 'number' || !Number.isInteger(event.seq) || event.seq < 1) {
    errors.push('seq 必须是 >=1 的整数')
  }
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) errors.push('at 必须是时间戳')
  if (TERMINAL_SET.has(event.type) && event.result === undefined) {
    // spec §6.1：终态事件必须携带或引用 RunResult
    errors.push(`终态事件 ${event.type} 必须携带或引用 RunResult`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 断言事件流满足终态契约。
 *
 * @param {object[]} events
 * @returns {{ok: boolean, errors: string[], terminal: object|null, outcome: string|null}}
 */
export function assertTerminalContract(events) {
  const errors = []
  if (!Array.isArray(events)) return { ok: false, errors: ['事件流必须是数组'], terminal: null, outcome: null }
  const terminals = events.filter((e) => e && TERMINAL_SET.has(e.type))
  if (terminals.length === 0) {
    errors.push('事件流缺少终态事件：execute() 必须且只能以一个终态事件结束')
  } else if (terminals.length > 1) {
    errors.push(`事件流出现 ${terminals.length} 个终态事件：只允许一个`)
  } else if (events[events.length - 1] !== terminals[0]) {
    errors.push('终态事件不是事件流的最后一个：终态之后不得再有事件')
  }
  // seq 必须严格递增
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1]
    const cur = events[i]
    if (prev && cur && typeof prev.seq === 'number' && typeof cur.seq === 'number' && cur.seq <= prev.seq) {
      errors.push(`seq 必须严格递增：${prev.seq} -> ${cur.seq}（下标 ${i - 1} -> ${i}）`)
      break
    }
  }
  const terminal = terminals.length === 1 ? terminals[0] : null
  return {
    ok: errors.length === 0,
    errors,
    terminal,
    outcome: terminal === null ? null : TERMINAL_TO_OUTCOME[terminal.type],
  }
}

/**
 * 终态仲裁器：实现「取消与完成并发时，首个成功提交的终态为准」。
 *
 * Adapter 与服务端都可能观察到迟到事件；迟到的终态不得改写已提交结论，
 * 只能作为诊断记录（spec §6.1）。把这条规则做成一个对象，是为了让
 * 「谁先提交」这件事有唯一实现，而不是每个调用点各写一遍判断。
 */
export function createTerminalArbiter() {
  /** @type {Map<string, {event: object, outcome: string, committedAt: number}>} */
  const committed = new Map()
  /** @type {Array<{runId: string, event: object, reason: string}>} */
  const diagnostics = []

  return {
    /**
     * 提交一个终态事件。
     * @returns {{committed: boolean, outcome: string|null, reason: string}}
     */
    commit(event, at = Date.now()) {
      if (!event || !TERMINAL_SET.has(event.type)) {
        return { committed: false, outcome: null, reason: '不是终态事件' }
      }
      const runId = String(event.runId ?? '')
      if (runId === '') return { committed: false, outcome: null, reason: 'runId 为空' }
      const existing = committed.get(runId)
      if (existing) {
        diagnostics.push({ runId, event, reason: `已提交终态 ${existing.event.type}` })
        return { committed: false, outcome: existing.outcome, reason: `已提交终态 ${existing.event.type}，迟到事件仅作诊断` }
      }
      const outcome = TERMINAL_TO_OUTCOME[event.type]
      committed.set(runId, { event, outcome, committedAt: at })
      return { committed: true, outcome, reason: '首个终态已提交' }
    },

    /** 已提交的终态；未提交返回 null。 */
    get(runId) {
      return committed.get(String(runId)) ?? null
    },

    isTerminal(runId) {
      return committed.has(String(runId))
    },

    /** 被拒绝的迟到事件（诊断用，不参与状态推导）。 */
    diagnostics() {
      return [...diagnostics]
    },
  }
}

/**
 * Legion 生成外部写操作幂等键（spec §8.3）。
 *
 * 关键性质：同一 Attempt 的同一 Call 重放得到相同键；新 Attempt 得到新键。
 * 因此 attemptId 必须在输入里——否则「重试」会命中上一次的键，被外部系统
 * 当成重复请求而静默丢弃，任务看起来成功但什么都没写。
 *
 * 分隔符用 `\0` 而不是 `|`：`|` 是合法业务字符，`a|b` + `c` 与 `a` + `b|c`
 * 会撞成同一个键。spec §8.3 写作 `||`，此处按可安全拼接实现。
 *
 * @param {object} input
 * @returns {string} 十六进制摘要
 */
export function deriveToolEffectIdempotencyKey(input) {
  const { workspaceId, taskId, attemptId, callId, canonicalOperationHash } = input ?? {}
  const parts = [workspaceId, taskId, attemptId, callId, canonicalOperationHash]
  const names = ['workspaceId', 'taskId', 'attemptId', 'callId', 'canonicalOperationHash']
  parts.forEach((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`deriveToolEffectIdempotencyKey 缺少 ${names[i]}`)
    }
  })
  const h = createHash('sha256')
  h.update('legion-tool-effect-v1\0', 'utf8')
  for (const part of parts) {
    h.update(part, 'utf8')
    h.update('\0', 'utf8')
  }
  return h.digest('hex')
}

/** CancelResult 构造：`cancel` 幂等，重复取消返回同一结论。 */
export function cancelResult({ runId, alreadyTerminal, terminalType = null }) {
  return Object.freeze({
    runId: String(runId),
    accepted: true,
    alreadyTerminal: alreadyTerminal === true,
    terminalType,
  })
}

/** RecoveryResult 构造：只表达恢复判断，**不修改** Task 状态（spec §6.1）。 */
export function recoveryResult({ runId, decision, reason, resumable = false }) {
  const allowed = ['retry-new-attempt', 'resume-same-run', 'outcome-unknown', 'already-terminal']
  if (!allowed.includes(decision)) {
    throw new Error(`未知恢复判断：${String(decision)}（只允许 ${allowed.join(' / ')}）`)
  }
  return Object.freeze({
    runId: String(runId),
    decision,
    reason: String(reason ?? ''),
    resumable: resumable === true,
    // 显式声明本结果不携带 Task 状态变更，Orchestrator 需自行按 leaseEpoch 提交
    mutatesTaskState: false,
  })
}

// team-hub/run-store.mjs
// ============================================================================
// 运行实体仓储：Attempt、Lease、权威时间与 epoch 拒写（PRT-302 / PRT-303 / PRT-313）
//
// spec §6.4 的持久化实现，也是阶段 3 完成标准的落点：
// **「强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。」**
//
// 三条设计决定。每一条都对应一种「不会报错」的故障，因此都不是风格偏好：
//
// ① **时间只认服务端时钟。** 请求里带的 `nowMs` / `leaseExpiresAtMs` 一律忽略，
//    并在响应里如实回报 `ignoredClientFields`。理由：租期的含义是「多久之后可以认为
//    持有者已经死了」。如果租期由持有者自己申报，一个时钟偏慢（或干脆坏掉）的 worker
//    可以把租期延长到无限——于是它的任务永远不会被回收，而外部看不出任何异常，
//    只看到「有一条任务一直没人做，但它的 worker 说还活着」。
//
// ② **领取必须是「条件更新 + 看 changes」，不能是「先读后写」。** 两个 worker 在两个
//    进程里各自 BEGIN IMMEDIATE 时，第二个事务的 WHERE 不会命中（第一个已改了行），
//    `changes === 0` 于是它拿不到这条任务。先读后写会两个都读到、两个都认领，
//    结果**同一条任务被两个 worker 各执行一遍**——对已发生的付费/推送就是重复副作用。
//
// ③ **epoch 不符一律拒写，并且要把「当前 epoch 是多少」告诉调用方。** 只说「拒绝」
//    会让一个过期 worker 无限重试；告诉它真实 epoch，它才可能判断出「我已经不是
//    持有者了，我该停手」。返回值里带 `currentEpoch` 而不是文档里写一句「请忽略」。
//
// 本模块不自建连接：db 由调用方注入（server.mjs 传它自己的 DatabaseSync 实例），
// `clock` 也可注入——「租期到期」这件事必须能在测试里**确定性地跨过去**，
// 而不是 sleep 真实时间。
// ============================================================================

import {
  ATTEMPT_STATES,
  DEFAULT_BACKOFF,
  isKnownAttemptState,
  recoveryDecision,
  retryDelayMs,
  taskStatusOf,
  transitionPlan,
} from '../orchestrator/state-machine/index.mjs'
import { ensureColumn as ensureColumnImpl } from './schema-util.mjs'
import { AcceptanceError, acceptanceTarget, evaluateAcceptance } from '../orchestrator/acceptance/index.mjs'
import { buildHandoffTask, resolveNextPost } from '../orchestrator/pipeline/index.mjs'

/** 默认租期。短到「崩溃后能被较快回收」，长到「一次正常执行不会被误判为死亡」。 */
export const DEFAULT_LEASE_TTL_MS = 120000

/** 租期上限：防止调用方配出一个「永远不过期」的租期，那等于没有租约。 */
export const MAX_LEASE_TTL_MS = 3600000

/**
 * 默认最大尝试次数（含首次）。第 5 次失败即进 Dead Letter 等人工。
 *
 * 上限**必须存在**：没有它时「重试」就是无限循环，而这不会报任何错——
 * 它只是安静地一直跑，把模型配额、日志量和外部系统的调用次数一起吃掉。
 * 数字取 5 是因为典型失败（网络抖动、上游 5xx、临时锁）在前几次就会自愈，
 * 而把额度开到很大只是在推迟「这条任务其实需要人看一眼」这个结论。
 */
export const DEFAULT_MAX_ATTEMPTS = 5

/** 本仓储的具名错误码。笼统的「400」无法被 metrics 分类，也无法告诉调用方下一步。 */
export const RUN_ERRORS = Object.freeze({
  TASK_NOT_CLAIMABLE: 'TASK_NOT_CLAIMABLE',
  ATTEMPT_NOT_FOUND: 'ATTEMPT_NOT_FOUND',
  LEASE_EPOCH_STALE: 'LEASE_EPOCH_STALE',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  LEASE_NOT_HELD: 'LEASE_NOT_HELD',
  EPOCH_REQUIRED: 'EPOCH_REQUIRED',
  WORKER_REQUIRED: 'WORKER_REQUIRED',
  BAD_LEASE_TTL: 'BAD_LEASE_TTL',
  BAD_MAX_ATTEMPTS: 'BAD_MAX_ATTEMPTS',
  UNKNOWN_STATE: 'UNKNOWN_ATTEMPT_STATE',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  TRANSITION_REJECTED: 'TRANSITION_REJECTED',
  SCOPE_REQUIRED: 'SCOPE_REQUIRED',
  // 「这条尝试当前不处于需要人工处置的状态」——与「租约不是你的」是两件事，
  // 合成一个码会让运维分不清「有人点错了按钮」与「另一个 worker 正在跑它」。
  NOT_HELD: 'NOT_HELD',
  // 「这次迁移声明要先落库的证据不存在」。状态机为每条边声明了 `requiresPersist`，
  // 那是契约；不核验它就只是一段 JSON——任务可以带着"从未被验收过"的事实进 Completed。
  EVIDENCE_MISSING: 'EVIDENCE_MISSING',
  // 任务的 acceptance 列不是合法 JSON 数组。这是**数据问题**，不是"没有判据"：
  // 当成空判据会让它静默走人工审批，而真正的原因（那一行坏了）没人知道。
  BAD_ACCEPTANCE_CRITERIA: 'BAD_ACCEPTANCE_CRITERIA',
  // 「这条尝试不在可验收的状态上」：验收只对 Validating 有意义。
  NOT_VALIDATING: 'NOT_VALIDATING',
  // PRT-308 交接：只在 HandingOff 上能交接；链断/岗位不存在/两处判断不一致时拒绝。
  NOT_HANDING_OFF: 'NOT_HANDING_OFF',
  HANDOFF_REJECTED: 'HANDOFF_REJECTED',
  // 交接没有接线（缺 createTask / readPipeline）。**不降级**成"没有下一岗位"：
  // 那会让交接在静默中变成收口，任务链断在第一环而没人知道。
  HANDOFF_NOT_WIRED: 'HANDOFF_NOT_WIRED',
})

/** 允许的人工处置决定。逐个列出，未登记的一律拒绝而不是猜一个默认值。 */
export const RESOLUTION_DECISIONS = Object.freeze([
  'external-effect-happened',
  'external-effect-absent',
  'dead-letter',
  'cancel',
])

/**
 * 带具名错误码的异常。
 *
 * `code` 永远是**本仓储自己的** `RUN_ERRORS.*`：调用方（路由、metrics、告警）依赖的
 * 是一套稳定的词汇表。状态机给出的更具体的码放在 `stateMachineCode` 里，
 * 两个字段各有各的读者，谁也不会盖掉谁。
 *
 * 这里刻意**不使用 `Object.assign(this, extra)`**：那会让 `extra.code` 静默覆盖
 * `this.code`，于是「仓储错误码」变成「有时候是状态机码」——
 * 而测试之所以能发现它，只是因为断言恰好写了另一个名字。
 * 一个会被自己的附加数据改写的错误码，等于没有错误码。
 */
export class RunError extends Error {
  constructor(code, message, { statusCode = 409, stateMachineCode = null, ...extra } = {}) {
    super(message)
    this.name = 'RunError'
    this.code = code
    this.statusCode = statusCode
    this.stateMachineCode = stateMachineCode
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'code' || k === 'message' || k === 'statusCode' || k === 'stateMachineCode') continue
      this[k] = v
    }
  }
}

class ContractError extends RunError {
  constructor(code, message, extra = {}) {
    super(code, message, { ...extra, statusCode: 400 })
    this.contract = true
  }
}

function fail(code, message, extra = {}, statusCode = 409) {
  return new RunError(code, message, { ...extra, statusCode })
}

/** 尝试状态 → team-hub 任务状态（走状态机的穷尽映射，这里不重写一份）。 */
function projectTaskStatus(attemptState, ctx = {}) {
  const r = taskStatusOf(attemptState, ctx)
  return r.ok === true ? r.status : null
}

// ---------------------------------------------------------------- 建表

/**
 * 给已存在的表补一列（幂等 + **并发安全**）。
 *
 * 为什么需要它：`CREATE TABLE IF NOT EXISTS` 对**已经存在**的表是空操作——
 * 表建好了，新列一列都不会加上。上一版（PRT-302/303/313）已经推上远程，
 * 也就是说线上可能有一个没有新列的库；只改 `CREATE TABLE` 的后果是
 * **老部署在第一条 claim 上就报 `no such column`**，而新部署一切正常。
 * 这种「新旧部署行为不同」的缺陷在单机开发里永远看不到。
 *
 * 为什么不是在这里自己写一遍：本仓库的部署形态是**两进程同时打开同一个库**
 * （8787 独立进程 + 3080 宿主 v2 外壳），两者启动时都会跑到这里。
 * 「先 PRAGMA 再 ALTER」在并发下两个进程都会读到「列不存在」，
 * 于是都执行 ALTER，后者拿到 `duplicate column name` 并在**模块加载期**崩溃——
 * 表现为其中一个进程起不来，与迁移毫无关系。
 * 因此这一段的实现只有一份（`schema-util.mjs`，BEGIN IMMEDIATE 内重读）。
 */
function ensureColumn(db, table, column, ddl) {
  return ensureColumnImpl(db, table, column, ddl)
}

/**
 * 建运行实体表。幂等（`IF NOT EXISTS` + `ensureColumn`），老库自动补齐，不需要迁移脚本。
 *
 * 与 `tasks` 的关系：`tasks` 是**看板实体**（人看的那份），
 * `run_attempts` 是**执行实体**（一次具体的执行尝试）。二者不是同一件事：
 * 一条看板任务可以有很多次尝试，而「试过几次、每次错在哪」必须能查——
 * 覆盖式更新会让这段历史永久消失（PRT-303 的「不可覆盖」就是这个意思）。
 */
export function ensureRunSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      attempt_no INTEGER NOT NULL,
      state TEXT NOT NULL,
      worker_id TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      lease_expires_at_ms INTEGER,
      return_to TEXT,
      outcome TEXT,
      failure_code TEXT,
      detail TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      UNIQUE (task_id, attempt_no)
    )
  `)
  // ── PRT-309/310/311 新增列（对老库用 ALTER TABLE 补齐）──
  // 幂等键：**跨尝试稳定**，外部系统据此去重。刻意不含 attempt_no——含了就等于没有：
  // 每次重试都是一个新键，外部系统无法判断"这是同一次操作的重试"。
  ensureColumn(db, 'run_attempts', 'idempotency_key', 'TEXT')
  // 退避闸门：排队中的尝试在这个时刻之前不可被领取（PRT-309 的"退避"要真的生效，
  // 否则 retryDelayMs 只是一段没人用的纯函数）。
  ensureColumn(db, 'run_attempts', 'next_attempt_at_ms', 'INTEGER')
  // 外部副作用的对账结论：null=未对账 / 'confirmed'=已发生 / 'absent'=确认未发生。
  // 用三态而不是布尔：布尔无法区分"确认没发生"与"还没人问过"，
  // 而这两者一个可以安全重试、一个必须继续等人工。
  ensureColumn(db, 'run_attempts', 'external_effect', 'TEXT')
  // 人工处置留痕：谁在什么时候以什么理由把它结掉的。
  ensureColumn(db, 'run_attempts', 'resolved_by', 'TEXT')
  ensureColumn(db, 'run_attempts', 'resolved_note', 'TEXT')

  // 领取查询走这个索引：按状态挑最早的排队尝试。
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_state ON run_attempts(state, created_at_ms)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_task ON run_attempts(task_id, attempt_no)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_lease ON run_attempts(lease_expires_at_ms)')
  // 退避闸门与「等人工」列表都按这两列筛。
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_ready ON run_attempts(state, next_attempt_at_ms)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_idem ON run_attempts(task_id, idempotency_key)')

  // 迁移事件流：**只追加**。本模块不提供任何 UPDATE/DELETE 这两个表的代码路径——
  // 「不可覆盖历史」如果只是文档里的约定，下一个人为了修一个显示问题就会去改它。
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_attempt_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT,
      lease_epoch INTEGER,
      reason TEXT,
      requires_persist TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempt_events_attempt ON run_attempt_events(attempt_id, seq)')

  // ── PRT-307 机器验收记录：**只追加** ──
  //
  // 为什么验收结论要落库，而不是在内存里判断完就丢掉：
  // 状态机为 `Validating → Completed` / `Validating → HandingOff` 声明了
  // `requiresPersist: ['attempt', 'validation']`。如果验收结论不落库，那条声明
  // 就只是事件表里的一段 JSON——一条任务可以带着"从未被验收过"的事实进入
  // `Completed`，而所有代码看起来都是对的。这正是"伪装成功"。
  //
  // 与 `run_attempt_events` 同样的纪律：只追加，不提供任何 UPDATE/DELETE 路径。
  // 一次尝试可以被验收多次（人工复审、驳回后重验），因此主键是自增 seq 而不是 attempt_id。
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_validations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      gate_json TEXT,
      results_json TEXT,
      run_json TEXT,
      criteria_json TEXT,
      actor TEXT NOT NULL,
      lease_epoch INTEGER,
      at_ms INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_validations_attempt ON run_validations(attempt_id, seq)')

  // ── PRT-308 交接记录：**只追加** ──
  //
  // 状态机为 `HandingOff → Completed` 声明了 `requiresPersist: ['attempt','handoff']`。
  // 这条表让那句声明真的能被核验：「交接发生了」的证据是**后继任务真的被创建了**，
  // 而不是调用方说"我交接了"。缺它时 `HandingOff → Completed` 会被 409 拒绝。
  //
  // `successor_id` 同时也是幂等的依据：重放交接时先查这个表（在同一个事务里），
  // 已有后继就直接返回，不再建第二条。
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_handoffs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      successor_id TEXT NOT NULL,
      successor_role TEXT NOT NULL,
      actor TEXT NOT NULL,
      lease_epoch INTEGER,
      reason TEXT,
      at_ms INTEGER NOT NULL
    )
  `)
  // 一个后继只能被交接一次：这条唯一约束是"同一条任务的同一个下一岗位不会出现两条"
  // 在**数据库层面**的保证。只在应用层查重时，两个并发进程会各查一次、各建一条——
  // 与 ensureColumn 那次的失败模式一样。
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_run_handoffs_successor ON run_handoffs(successor_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_handoffs_attempt ON run_handoffs(attempt_id, seq)')
}

// ---------------------------------------------------------------- 内部工具

function rowOf(db, attemptId) {
  return db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(attemptId) ?? null
}

function appendEvent(db, { attempt, from, to, actor, epoch, reason, requiresPersist, atMs }) {
  db.prepare(
    `INSERT INTO run_attempt_events (attempt_id, task_id, at_ms, from_state, to_state, actor, lease_epoch, reason, requires_persist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attempt.id, attempt.task_id, atMs, from ?? null, to, actor ?? null,
    Number.isInteger(epoch) ? epoch : null, reason ?? null,
    requiresPersist === undefined || requiresPersist === null ? null : JSON.stringify(requiresPersist),
  )
}

/** 一次尝试的验收记录（按 seq 升序，只读）。 */
function validationRows(db, attemptId) {
  return db.prepare('SELECT * FROM run_validations WHERE attempt_id = ? ORDER BY seq').all(attemptId)
}

/**
 * 已实现核验的「必须落库的证据」。
 *
 * 状态机为每条迁移边声明了 `requiresPersist`（例如 `Validating → Completed` 要求
 * `['attempt', 'validation']`）。把那条声明**真的核验掉**，是这个映射存在的全部意义：
 * 只记录不核验时，一条任务可以带着"从未被验收过"的事实进入 `Completed`，
 * 而事件流里那句 `requires_persist: ["attempt","validation"]` 看起来像是在保证它。
 *
 * 只登记**已经能查**的证据。未登记的（`runResult` / `context` / `handoff` /
 * `approval` / `reconciliation` …）目前既不阻塞也不假装核验过——它们各自属于
 * 尚未交付的任务（PRT-306/308/401 等）。这里刻意**不**给未登记项一个宽松的默认实现：
 * 一个"总是通过"的核验比没有核验更糟，因为它让上面那句话看起来是被保证的。
 */
const EVIDENCE_CHECKS = Object.freeze({
  attempt: (db, attemptId) => rowOf(db, attemptId) !== null,
  validation: (db, attemptId) => validationRows(db, attemptId).length > 0,
  // 「交接发生了」= 真的有一条后继任务被创建（PRT-308）。
  // 否则 `HandingOff → Completed` 会在**没有后继**的情况下收口：
  // 任务链静默断在这里，而事件流里 `requires_persist: ['attempt','handoff']`
  // 看起来像是在保证下一岗位已经建好了。
  handoff: (db, attemptId) =>
    db.prepare('SELECT COUNT(*) AS n FROM run_handoffs WHERE attempt_id = ?').get(attemptId).n > 0,
})

/**
 * 核验一次迁移声明要落库的证据是否真的存在。
 *
 * 返回 `{ checked, missing }`。`missing` 非空时调用方必须拒绝这次迁移——
 * 拒绝而不是"记一条警告然后继续"：一条没通过验收的任务进入 `Completed`
 * 之后，下游依赖它的人不会知道。
 */
function checkEvidence(db, attemptId, requiresPersist) {
  const names = Array.isArray(requiresPersist) ? requiresPersist : []
  const checked = []
  const missing = []
  for (const name of names) {
    const probe = EVIDENCE_CHECKS[name]
    if (probe === undefined) continue // 尚未实现核验的证据种类：见 EVIDENCE_CHECKS 的说明
    checked.push(name)
    if (probe(db, attemptId) !== true) missing.push(name)
  }
  return Object.freeze({ checked: Object.freeze(checked), missing: Object.freeze(missing) })
}

/** 证据缺失时的统一错误。把「缺哪一项」说清楚，否则排查只能去看状态机源码。 */
function evidenceError(attemptId, state, to, missing) {
  // 409 而不是 400：请求本身完全合法，是**当前状态**不允许这一步
  // （缺的是这一步的前提）。与 LEASE_EPOCH_STALE / TRANSITION_REJECTED 同一类。
  return fail(RUN_ERRORS.EVIDENCE_MISSING,
    `迁移 ${state} → ${to} 声明要先落库的证据不存在：${missing.join('、')}。` +
    `这不是"数据还没写好"的时序问题，而是"这一步的结论没有依据"——` +
    `例如一条没有验收记录的尝试进入 Completed，等于把"没人验收过"写成"已验收"`,
    { attemptId, from: state, to, missing: Object.freeze([...missing]) }, 409)
}

/** 任务状态投影：只有「有运行尝试的任务」才被投影，避免影响纯看板任务。 */
function projectToTask(db, attempt, attemptState, atMs, { hasNextPost, approvalFrom } = {}) {
  const status = projectTaskStatus(attemptState, {
    retryBudgetRemaining: true,
    approvalFrom: approvalFrom ?? (attemptState === 'AwaitingApproval' ? 'Running' : undefined),
  })
  if (status === null) return null
  const has = db.prepare('SELECT id FROM tasks WHERE id = ?').get(attempt.task_id)
  if (has === undefined) return null
  db.prepare('UPDATE tasks SET status = ?, version = version + 1, updatedAt = ? WHERE id = ?')
    .run(status, new Date(atMs).toISOString(), attempt.task_id)
  return status
}

function shapeAttempt(row) {
  if (row === null) return null
  return Object.freeze({
    attemptId: row.id,
    taskId: row.task_id,
    scope: row.scope,
    attemptNo: row.attempt_no,
    state: row.state,
    workerId: row.worker_id,
    leaseEpoch: row.lease_epoch,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    // 幂等键交给执行方，由它在外部写请求里带上（PRT-311）。
    // 同一任务的所有尝试共用同一个键：这正是"重试不会造成第二次副作用"的实现基础。
    idempotencyKey: row.idempotency_key ?? null,
    nextAttemptAtMs: row.next_attempt_at_ms ?? null,
    externalEffect: row.external_effect ?? null,
    returnTo: row.return_to,
    outcome: row.outcome,
    failureCode: row.failure_code,
    detail: row.detail,
    resolvedBy: row.resolved_by ?? null,
    resolvedNote: row.resolved_note ?? null,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    finishedAtMs: row.finished_at_ms,
  })
}

function requireWorker(workerId) {
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new ContractError(RUN_ERRORS.WORKER_REQUIRED,
      '缺少 workerId：运行实体的每一次写入都必须能归因到具体 worker。' +
      '没有它，出现「两个 worker 同时写同一条任务」时无法判断谁是谁')
  }
  return workerId.trim()
}

function requireEpoch(leaseEpoch) {
  if (!Number.isInteger(leaseEpoch) || leaseEpoch < 0) {
    throw new ContractError(RUN_ERRORS.EPOCH_REQUIRED,
      `缺少合法的 leaseEpoch（收到 ${JSON.stringify(leaseEpoch)}）：` +
      '不带 epoch 的写入无法证明「我还是持有者」，必须拒绝')
  }
  return leaseEpoch
}

function resolveTtl(rawTtlMs) {
  if (rawTtlMs === undefined || rawTtlMs === null) return DEFAULT_LEASE_TTL_MS
  if (!Number.isInteger(rawTtlMs) || rawTtlMs <= 0) {
    throw new ContractError(RUN_ERRORS.BAD_LEASE_TTL, `leaseTtlMs 必须是正整数毫秒（收到 ${JSON.stringify(rawTtlMs)}）`)
  }
  if (rawTtlMs > MAX_LEASE_TTL_MS) {
    throw new ContractError(RUN_ERRORS.BAD_LEASE_TTL,
      `leaseTtlMs 超过上限 ${MAX_LEASE_TTL_MS}ms（收到 ${rawTtlMs}）：` +
      '过长的租期等于没有租约——崩溃的 worker 会一直占着任务，而外部只看到「队列不动」')
  }
  return rawTtlMs
}

/**
 * 校验最大尝试次数。
 *
 * 至少要 1（只做首次、不重试是合法配置）。`0` 与负数必须拒绝而不是"当成不重试"：
 * `0` 更像是一个占位符或算错了的值，悄悄按"不重试"执行会让一次配置错误表现为
 * "任务全都只试一次就进 Dead Letter"，而没人会想到去查这个配置项。
 */
function resolveMaxAttempts(raw) {
  if (raw === null || raw === undefined) return DEFAULT_MAX_ATTEMPTS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new ContractError(RUN_ERRORS.BAD_MAX_ATTEMPTS,
      `maxAttempts 必须是 >= 1 的整数（收到 ${JSON.stringify(raw)}）：` +
      '它决定「第几次失败之后进 Dead Letter」。取值非法时不得默认——' +
      '按 0 或 NaN 继续会让额度判定变成永不成立或永远成立，两种都不会报错')
  }
  return n
}

/**
 * 领取候选：排队中的尝试（同一任务只取编号最大的那一次，更早的都已终结）。
 *
 * 「同一任务只取最新的」是必要的：历史尝试会永久留在库里，
 * 若不加这条，一条任务的历史尝试会被反复领取。
 *
 * 同样必须带上任务本身的 `status`/`hold` 条件：一条 Queued 尝试只说明
 * 「这份工作被排进了队列」，**不说明它现在该被执行**。少了这两个条件时，
 * 一条被将军 `hold` 住、或者被人手动标成 done 的任务，只要还留着一条 Queued 尝试，
 * 就会照常被 worker 领走执行——「将军拦截优先于队列」这句话就失效了，
 * 而且失效得毫无痕迹。让两条候选路径共用同一组任务级条件，
 * 是因为它们的差别只在「从哪一侧找这条任务」，而不是「谁有资格被执行」。
 *
 * `next_attempt_at_ms` 是 PRT-309 的退避闸门：只有在**到点之后**才能被领取。
 * 这一条如果漏掉，退避就只是一段没人调用的纯函数——
 * 一个持续失败的引擎会被立刻反复重试，把配额和日志一起打满，
 * 而所有代码看起来都是对的。
 */
const QUEUED_CANDIDATE_SQL = `
  SELECT a.* FROM run_attempts a
  JOIN tasks t ON t.id = a.task_id
  WHERE a.state = 'Queued'
    AND t.status = 'todo' AND COALESCE(t.hold, 0) = 0
    AND (a.next_attempt_at_ms IS NULL OR a.next_attempt_at_ms <= ?)
    AND a.attempt_no = (SELECT MAX(b.attempt_no) FROM run_attempts b WHERE b.task_id = a.task_id)
    {scope}
  ORDER BY a.created_at_ms ASC, a.attempt_no ASC
  LIMIT 1
`

/** 可入队的看板任务：todo、未被将军拦截、且当前没有活跃尝试。 */
const CLAIMABLE_TASK_SQL = `
  SELECT t.id, t.scope FROM tasks t
  WHERE t.status = 'todo' AND COALESCE(t.hold, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM run_attempts a
      WHERE a.task_id = t.id AND a.state NOT IN ('Completed', 'Cancelled', 'DeadLetter')
    )
    {scope}
  ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.createdAt ASC
  LIMIT 1
`

/**
 * 把 `{scope}` 替换成 scope 过滤，返回 `{ sql, params }`。
 *
 * scope 是**值**而不是标识符，因此走 `?` 绑定参数；列名来自调用方传入的字面常量
 * （`a.scope` / `t.scope`），不是用户输入。替换前断言占位串确实存在——
 * 如果哪天有人把 `{scope}` 从 SQL 里删掉，分空间领取会静默变成「跨空间领取」，
 * 那是最难在生产里认出来的一类越权。
 */
function scopedSql(sql, scope, column) {
  if (!sql.includes('{scope}')) {
    throw new Error('内部错误：这条 SQL 缺少 {scope} 占位符，分空间过滤会静默失效')
  }
  if (scope === null || scope === undefined) return { sql: sql.replace('{scope}', ''), params: [] }
  return { sql: sql.replace('{scope}', `AND ${column} = ?`), params: [scope] }
}

// ---------------------------------------------------------------- 仓储

/**
 * 建一个仓储句柄。
 *
 * `db` 必须是一个已打开的 `node:sqlite` DatabaseSync（WAL 模式由 server 负责）。
 * `clock` 返回毫秒时间戳；**所有**判定用它，调用方给的时间一律不参与判定。
 */
export function createRunStore({
  db,
  clock = () => Date.now(),
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoff = DEFAULT_BACKOFF,
  random,
  // PRT-308 交接要把下一岗位的任务**建出来**，而那张表（30 个列）属于 server.mjs；
  // 流水线同理（`space_stages`）。两者由调用方注入，本仓储不认识它们的 schema。
  // 注入的实现会被在**本仓储的事务里**调用（同一个连接），因此三者是原子的。
  createTask = null,
  readPipeline = null,
} = {}) {
  if (db === undefined || db === null) throw new TypeError('createRunStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createRunStore 的 clock 必须是函数')
  const defaultTtl = resolveTtl(leaseTtlMs)
  const attemptLimit = resolveMaxAttempts(maxAttempts)
  const backoffPolicy = Object.freeze({ ...DEFAULT_BACKOFF, ...(backoff ?? {}) })
  ensureRunSchema(db)

  let txDepth = 0
  /**
   * 事务包装。用 `BEGIN IMMEDIATE`：领取要在**读之前**就拿到写锁，
   * 否则两个 worker 都能读到同一行、都能认领（见文件头 ②）。
   */
  function withTx(mutate) {
    const nested = txDepth > 0
    const name = `tx_run_${txDepth + 1}`
    if (nested) db.exec(`SAVEPOINT ${name}`)
    else db.exec('BEGIN IMMEDIATE')
    txDepth += 1
    try {
      const result = mutate()
      if (nested) db.exec(`RELEASE ${name}`)
      else db.exec('COMMIT')
      txDepth -= 1
      return result
    } catch (e) {
      txDepth -= 1
      try {
        if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`) }
        else db.exec('ROLLBACK')
      } catch { /* 回滚失败时保留原始异常，它更有诊断价值 */ }
      throw e
    }
  }

  /**
   * 新建一次尝试（编号 = 同任务最大值 + 1）。这是「重试不覆盖历史」的唯一入口。
   *
   * 同时决定两件跨尝试的事（PRT-309/311）：
   *
   * ① **幂等键跨尝试稳定**：`idem:{taskId}`（可由调用方用 `context.idempotencyKey` 覆盖）。
   *    刻意**不含 attempt_no**——含了就等于没有幂等键：每次重试都是一个新键，
   *    外部系统无法判断"这是同一次操作的重试"，于是重复付费/重复推送照旧发生。
   *    这是整个「不重复执行已确认的外部写操作」里唯一需要外部系统配合的一环，
   *    因此它必须是一个**能拿去用**的稳定值，而不是一个每次执行都变的本地编号。
   *
   * ② **退避闸门**：新尝试带上 `next_attempt_at_ms`，在那之前领取查询不会选中它。
   *    没有这一条时 `retryDelayMs` 只是一段没人调用的纯函数：
   *    一个持续失败的引擎会被立刻反复重试，把配额和日志一起打满。
   */
  function createAttempt({ taskId, scope, state = 'Queued', atMs, actor = null, returnTo = null, idempotencyKey = null, nextAttemptAtMs = null }) {
    const maxRow = db.prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM run_attempts WHERE task_id = ?').get(taskId)
    const attemptNo = Number(maxRow.n) + 1
    const id = `att:${taskId}:${attemptNo}`
    const idem = idempotencyKey !== null && idempotencyKey !== undefined
      ? String(idempotencyKey)
      : `idem:${taskId}`
    db.prepare(
      `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, worker_id, lease_epoch, lease_expires_at_ms, return_to, idempotency_key, next_attempt_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, taskId, scope, attemptNo, state, returnTo, idem, nextAttemptAtMs, atMs, atMs)
    const row = rowOf(db, id)
    appendEvent(db, { attempt: row, from: null, to: state, actor, epoch: 0, reason: 'attempt-created', atMs })
    return row
  }

  /**
   * 还有没有重试额度。
   *
   * 用 `attempt_no` 而不是"已经失败过几次"：尝试编号是**唯一不会漂**的计数
   * （每次重试都 +1，且历史不可覆盖），而"失败次数"要靠遍历历史去数，
   * 一旦有人补写了一条事件就会算错。
   */
  function retryBudgetRemaining(attemptNo) {
    return attemptNo < attemptLimit
  }

  /**
   * 退避时长（第 N 次尝试失败后到下一次可领取之间的等待）。
   *
   * `random` 由仓储注入而不是各调用点自己取随机数：jitter 若用 `Math.random`，
   * 测试就只能断言"大约在某个区间"，而**退避算错**这件事恰好只会表现为
   * "重试得太快"——一个只有在生产里才看得见的缺陷。
   */
  function backoffFor(attemptNo) {
    const r = retryDelayMs(attemptNo, {
      baseMs: backoffPolicy.baseMs,
      factor: backoffPolicy.factor,
      maxMs: backoffPolicy.maxMs,
      jitter: backoffPolicy.jitter,
      random,
    })
    if (r.ok !== true) throw new ContractError(r.code, r.message)
    return r.delayMs
  }

  /**
   * 终结当前尝试并排队一次新尝试（重试的唯一实现）。
   *
   * 三件事必须在**同一个事务**里完成：
   *   ① 终结当前尝试（`viaState`，默认就是它当时的来源状态）；
   *   ② **推进它的 `lease_epoch`**；
   *   ③ 新建一次排队尝试。
   *
   * ②是最容易被漏掉的一条。不推进 epoch 的话，那条已经终结的尝试的 epoch
   * 与旧持有者手里的一模一样：旧持有者醒过来提交结果时，epoch 校验会**通过**，
   * 然后被状态机以「RetryableFailure → Validating 不是合法迁移」拒绝。
   * 它确实没写进去，但它收到的信息是错的——它会以为「我写错了状态」，
   * 而不是「我已经不是持有者了，我该停手」。让它继续重试是安全的，
   * 让它继续**执行**（工具调用）就不安全了。
   * 推进 epoch 之后，同样的写入会得到 `LEASE_EPOCH_STALE` + 真实 epoch，
   * 也就是它真正需要的那个信号。
   *
   * 拆成两个可分别调用的公开方法同样不行：只终结不新建 → 任务卡死没人能领；
   * 只新建不终结 → 同一任务两条活跃尝试被两个 worker 同时领走。两者都不报错。
   */
  function openNextAttempt(row, { atMs, actor, reason, closing, failureCode = null, detail = null, nextAttemptAtMs = null, createNext = true, finalize = null }) {
    if (!isKnownAttemptState(closing)) {
      throw new ContractError(RUN_ERRORS.UNKNOWN_STATE, `closing「${closing}」不是已登记状态`)
    }
    // 终结状态同样要过状态机，而不是由调用方直接写进去：
    // `Leased → RetryableFailure` 合法，但「合法」这件事必须被**验证**而不是被假定。
    // 假定它合法的写法在回收路径上尤其危险——回收是无人值守的，
    // 一个非法终结状态会安静地留在库里，直到有人去看板为止。
    const closingPlan = transitionPlan(row.state, closing, { retryBudgetRemaining: true })
    if (closingPlan.ok !== true) {
      throw fail(RUN_ERRORS.TRANSITION_REJECTED,
        `回收/重试要把 ${row.state} 终结为 ${closing}，但状态机不允许：${closingPlan.message}`,
        { stateMachineCode: closingPlan.code, from: row.state, to: closing })
    }
    const invalidatedEpoch = Number(row.lease_epoch) + 1
    db.prepare(
      `UPDATE run_attempts SET state = ?, lease_epoch = ?, updated_at_ms = ?, finished_at_ms = ?,
         failure_code = COALESCE(?, failure_code), detail = COALESCE(?, detail)
       WHERE id = ? AND lease_epoch = ?`,
    ).run(closing, invalidatedEpoch, atMs, atMs, failureCode ?? null, detail ?? null, row.id, row.lease_epoch)
    const closed = rowOf(db, row.id)
    appendEvent(db, { attempt: closed, from: row.state, to: closing, actor, epoch: row.lease_epoch, reason, atMs })
    appendEvent(db, {
      attempt: closed, from: closing, to: closing, actor, epoch: invalidatedEpoch,
      reason: `${reason}:lease-invalidated`, atMs,
    })
    appendEvent(db, { attempt: closed, from: closing, to: closing, actor, epoch: invalidatedEpoch, reason: `${reason}:resolved`, atMs })

    // 额度用完时还要再走一步：`RetryableFailure → DeadLetter`。
    // 不能直接把 `Running` 之类的状态写成 `DeadLetter`——那两步之间隔着一次
    // "它是一次失败"的判定，而 `Running → DeadLetter` 在状态机里根本不是合法边。
    // 分两步写还有一个好处：历史里能看出「它先失败、后因额度耗尽被丢弃」。
    if (finalize !== null && finalize !== undefined) {
      const finalizePlan = transitionPlan(closed.state, finalize, {})
      if (finalizePlan.ok !== true) {
        throw fail(RUN_ERRORS.TRANSITION_REJECTED,
          `${closed.state} → ${finalize} 被拒绝：${finalizePlan.message}`,
          { stateMachineCode: finalizePlan.code, from: closed.state, to: finalize })
      }
      db.prepare('UPDATE run_attempts SET state = ?, updated_at_ms = ? WHERE id = ?')
        .run(finalize, atMs, closed.id)
      const finalized = rowOf(db, closed.id)
      appendEvent(db, { attempt: finalized, from: closed.state, to: finalize, actor, epoch: invalidatedEpoch, reason: `${reason}:finalize(${finalize})`, atMs })
    }

    const settled = rowOf(db, row.id)
    if (createNext !== true) return settled

    const fresh = createAttempt({
      taskId: row.task_id, scope: row.scope, state: 'Queued', atMs, actor,
      idempotencyKey: row.idempotency_key ?? null,
      nextAttemptAtMs: nextAttemptAtMs ?? null,
    })
    appendEvent(db, { attempt: fresh, from: settled.state, to: 'Queued', actor, epoch: 0, reason: `${reason}:new-attempt`, atMs })
    return fresh
  }

  /**
   * 「这次失败之后该怎么办」的**唯一**决策点（PRT-309）。
   *
   * 三种去向，且只有这三种：
   *   - 还有重试额度 → 终结当前尝试为 `RetryableFailure`，按退避排一次新尝试；
   *   - 额度用完 → 终结为 **`DeadLetter`**（终态），并把它留在"等人工"列表里；
   *   - 已越过外部写边界 → 不走这里（由调用方先判 `UnknownOutcome`）。
   *
   * 为什么必须合成一个函数：把「重试」与「放弃」分成两处调用时，
   * 漏掉"额度用完"那条分支的后果是**无限重试**——而无限重试不会报错，
   * 它只是安静地永远跑下去，把配额、日志和外部系统的调用次数一起吃掉。
   *
   * 退避是**真的生效**（写进 `next_attempt_at_ms`，领取查询会过滤），
   * 不是只算一个没人用的数字。
   */
  function scheduleRetry(row, { atMs, actor, reason, failureCode = null, detail = null, delayMs = null }) {
    const budget = retryBudgetRemaining(Number(row.attempt_no))
    // `delayMs` 显式覆盖退避策略。唯一的使用者是**租约过期回收**：
    // 那种情况下"等待"已经由租期本身（默认 120s）付过了，
    // 再加一段退避只会推迟一条本来可能完全正常的任务。
    // 退避策略要防的是"对已知失败的依赖快速重试"，而租约过期是**未知原因**的中断
    // （机器重启、OOM、被强杀），它的等待已经足够长。
    // 额度判定则必须保留——否则"每次快失败就被杀"的任务会永远重试下去。
    const delay = delayMs === null || delayMs === undefined ? backoffFor(Number(row.attempt_no)) : Math.max(0, Number(delayMs))
    const nextAtMs = budget && delay > 0 ? atMs + delay : null
    const settled = openNextAttempt(row, {
      atMs, actor,
      // 无论有没有额度，**先**终结为 RetryableFailure（这是「它失败了一次」这个事实），
      // 没额度时再走一步 `RetryableFailure → DeadLetter`（这是「我们决定不再重试」这个决定）。
      closing: 'RetryableFailure',
      finalize: budget ? null : 'DeadLetter',
      reason: budget ? reason : `${reason}:retry-budget-exhausted(${attemptLimit})`,
      failureCode, detail,
      nextAttemptAtMs: nextAtMs,
      createNext: budget,
    })
    if (budget) {
      return Object.freeze({
        action: 'retry-new-attempt',
        attempt: shapeAttempt(settled),
        nextAttemptAtMs: nextAtMs,
        attemptsUsed: Number(row.attempt_no),
        maxAttempts: attemptLimit,
      })
    }
    return Object.freeze({
      action: 'dead-letter',
      attempt: shapeAttempt(settled),
      nextAttemptAtMs: null,
      attemptsUsed: Number(row.attempt_no),
      maxAttempts: attemptLimit,
      reason: `重试额度已用完（已尝试 ${row.attempt_no} 次，上限 ${attemptLimit}）：不再自动重试，进 Dead Letter 等人工处置`,
    })
  }

  /**
   * 领取一条可执行的任务。
   *
   * 返回 `{ ok: true, claimed: {...} | null, serverTimeMs }`。
   * `claimed: null` 是正常结果（队列空），不是错误——把「没事可做」表达成异常，
   * 会逼着调用方用 catch 来做正常流程控制。
   */
  function claim({ workerId, scope = null, leaseTtlMs: rawTtl = null, nowMs = null } = {}) {
    const worker = requireWorker(workerId)
    const ttl = resolveTtl(rawTtl ?? undefined)
    const ignoredClientFields = []
    if (nowMs !== null && nowMs !== undefined) ignoredClientFields.push('nowMs')
    return withTx(() => {
      const atMs = clock()
      const queued = scopedSql(QUEUED_CANDIDATE_SQL, scope, 'a.scope')
      // 第一个参数是退避闸门（服务端时钟），第二个才是可选的 scope——
      // 顺序反了会让 scope 被当成时间比较，于是"永远领取不到任何任务"。
      let candidate = db.prepare(queued.sql).get(atMs, ...queued.params)

      if (candidate === undefined || candidate === null) {
        // 没有排队尝试 → 把一个可入队的看板任务变成第 1 次尝试
        const claimable = scopedSql(CLAIMABLE_TASK_SQL, scope, 't.scope')
        const task = db.prepare(claimable.sql).get(...claimable.params)
        if (task === undefined || task === null) {
          return Object.freeze({ ok: true, claimed: null, reason: 'queue-empty', serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields) })
        }
        candidate = createAttempt({ taskId: task.id, scope: task.scope, state: 'Queued', atMs, returnTo: null })
      }

      const nextEpoch = Number(candidate.lease_epoch) + 1
      const expiresAtMs = atMs + ttl
      // **条件更新 + 看 changes**：并发下唯一能保证「同一条任务只被领一次」的写法。
      const res = db.prepare(
        `UPDATE run_attempts
            SET state = 'Leased', worker_id = ?, lease_epoch = ?, lease_expires_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'Queued'`,
      ).run(worker, nextEpoch, expiresAtMs, atMs, candidate.id)
      if (Number(res.changes) !== 1) {
        // 另一个 worker 抢先改了这一行。**不能**换一条重试：那会让一次 claim
        // 的语义变成「尽量领一条」，而调用方以为拿到的是它看到的那个任务。
        return Object.freeze({
          ok: true,
          claimed: null,
          reason: 'lost-race',
          serverTimeMs: atMs,
          ignoredClientFields: Object.freeze(ignoredClientFields),
        })
      }
      const row = rowOf(db, candidate.id)
      const claimPlan = transitionPlan('Queued', 'Leased', {})
      appendEvent(db, {
        attempt: row, from: 'Queued', to: 'Leased', actor: worker, epoch: nextEpoch,
        reason: 'claim', requiresPersist: claimPlan.requiresPersist, atMs,
      })
      projectToTask(db, row, 'Leased', atMs)
      return Object.freeze({
        ok: true,
        claimed: Object.freeze({
          attemptId: row.id,
          taskId: row.task_id,
          attemptNo: row.attempt_no,
          leaseEpoch: row.lease_epoch,
          leaseExpiresAtMs: row.lease_expires_at_ms,
          state: row.state,
          serverTimeMs: atMs,
        }),
        serverTimeMs: atMs,
        ignoredClientFields: Object.freeze(ignoredClientFields),
      })
    })
  }

  /**
   * 心跳续租。只在「epoch 相符 **且** 租期未过」时续，两种情况分别报具名错误码：
   *   - epoch 不符 → `LEASE_EPOCH_STALE`（已经有人接管了，你该停手）
   *   - 租期已过 → `LEASE_EXPIRED`（你还是持有者，但已经超过了自己承诺的时间窗）
   * 合并成一个错误会让调用方无法区分「我该放弃」与「我该加快」。
   */
  function heartbeat({ attemptId, leaseEpoch, workerId, leaseTtlMs: rawTtl = null, nowMs = null } = {}) {
    const worker = requireWorker(workerId)
    const epoch = requireEpoch(leaseEpoch)
    const ttl = resolveTtl(rawTtl ?? undefined)
    const ignoredClientFields = nowMs === null || nowMs === undefined ? [] : ['nowMs']
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw fail(RUN_ERRORS.ATTEMPT_NOT_FOUND, `运行尝试不存在：${attemptId}`, { attemptId }, 404)
      if (row.lease_epoch !== epoch) {
        throw fail(RUN_ERRORS.LEASE_EPOCH_STALE,
          `leaseEpoch 不符：请求 ${epoch}，实际 ${row.lease_epoch}。` +
          '这条尝试已被其他人接管（或已被回收），请立即停手——继续执行并提交会让结果被拒，' +
          '而如果服务端不校验 epoch，那就是覆盖了别人的结果',
          { currentEpoch: row.lease_epoch, currentWorkerId: row.worker_id })
      }
      if (row.worker_id !== worker) {
        throw fail(RUN_ERRORS.LEASE_NOT_HELD,
          `这条尝试由 ${row.worker_id} 持有，${worker} 不是持有者（epoch 相同但 worker 不同，说明状态被外部改过）`,
          { currentWorkerId: row.worker_id })
      }
      if (row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= atMs) {
        throw fail(RUN_ERRORS.LEASE_EXPIRED,
          `租期已过（到期于 ${row.lease_expires_at_ms}，服务端现在是 ${atMs}）：` +
          '这条尝试随时可能被回收并交给别人，立即停止副作用并等待回收',
          { leaseExpiresAtMs: row.lease_expires_at_ms, serverTimeMs: atMs })
      }
      const expiresAtMs = atMs + ttl
      db.prepare("UPDATE run_attempts SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND lease_epoch = ? AND state = 'Leased'")
        .run(expiresAtMs, atMs, attemptId, epoch)
      return Object.freeze({ ok: true, attemptId, leaseEpoch: epoch, leaseExpiresAtMs: expiresAtMs, serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields) })
    })
  }

  /**
   * 状态迁移（带 epoch CAS）。
   *
   * 合法性判定交给状态机（`transitionPlan`），本模块不重写一份迁移表：
   * 两份表一定会漂移，而漂移的那一天没人会知道哪一份是对的。
   */
  function transition({ attemptId, leaseEpoch, workerId, to = null, outcome = null, context = {}, reason = null, nowMs = null } = {}) {
    const worker = requireWorker(workerId)
    const epoch = requireEpoch(leaseEpoch)
    const ignoredClientFields = []
    if (nowMs !== null && nowMs !== undefined) ignoredClientFields.push('nowMs')
    if (context?.nowMs !== undefined) ignoredClientFields.push('context.nowMs')
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw fail(RUN_ERRORS.ATTEMPT_NOT_FOUND, `运行尝试不存在：${attemptId}`, { attemptId }, 404)
      if (!isKnownAttemptState(row.state)) {
        throw fail(RUN_ERRORS.UNKNOWN_STATE,
          `库里的尝试状态「${row.state}」不是已登记状态之一（已登记：${ATTEMPT_STATES.join(', ')}）。` +
          '这通常意味着有人手工改过库或降级了版本；不要猜测怎么继续，先查清它怎么来的',
          { state: row.state }, 500)
      }
      if (row.lease_epoch !== epoch) {
        throw fail(RUN_ERRORS.LEASE_EPOCH_STALE,
          `leaseEpoch 不符：请求 ${epoch}，实际 ${row.lease_epoch}——写入被拒绝（过期的 worker 不得改写别人的结果）`,
          { currentEpoch: row.lease_epoch, currentWorkerId: row.worker_id })
      }

      const target = to ?? mapOutcomeToState(outcome)
      if (target === null) {
        // 与上面「库里的状态未登记」是**两件事**，因此用两个码：
        // 那一件说明数据/版本有问题（5xx，要查怎么来的）；这一件说明**请求**给了
        // 一个不认识的结果名义（4xx，调用方改一下就行）。合成一个码会让运维
        // 在「有人在乱传参数」与「库被改坏了」之间无法区分。
        throw new ContractError(RUN_ERRORS.UNKNOWN_OUTCOME,
          `无法确定目标状态：to 未给出，且 outcome「${outcome}」不是已知的执行结果名义` +
          '（completed / failed / outcome_unknown / cancelled）。**不做默认**——' +
          '猜错的方向是「把失败记成完成」')
      }
      const plan = transitionPlan(row.state, target, {
        returnTo: context?.returnTo ?? row.return_to ?? undefined,
        hasNextPost: context?.hasNextPost,
        retryBudgetRemaining: context?.retryBudgetRemaining,
        externalEffectConfirmed: context?.externalEffectConfirmed,
      })
      if (plan.ok !== true) {
        throw fail(RUN_ERRORS.TRANSITION_REJECTED, plan.message, { stateMachineCode: plan.code, from: row.state, to: target })
      }
      if (plan.idempotent === true) {
        // 重放同一次迁移是正常路径（worker 写完后崩溃再重放），不是错误，也不再追加事件
        return Object.freeze({ ok: true, idempotent: true, attempt: shapeAttempt(row), serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields) })
      }

      // `RetryableFailure → Queued` 在状态机里声明了 `createsNewAttempt: true`。
      // 这里必须**真的**新建一次尝试：把同一行改回 Queued 会让同一条尝试被重跑，
      // 于是「第 3 次尝试做过什么」与「第 3 次重跑做过什么」混进同一行，历史不再可信。
      if (plan.createsNewAttempt === true) {
        const fresh = openNextAttempt(row, { atMs, actor: worker, reason: reason ?? 'retry', closing: row.state })
        return Object.freeze({
          ok: true,
          attempt: shapeAttempt(fresh),
          createsNewAttempt: true,
          previousAttemptId: row.id,
          requiresPersist: plan.requiresPersist,
          taskStatus: projectToTask(db, fresh, 'Queued', atMs),
          serverTimeMs: atMs,
          ignoredClientFields: Object.freeze(ignoredClientFields),
        })
      }

      // **证据闸门**：状态机为这条边声明了 `requiresPersist`。声明必须在**落库之前**
      // 被核验，否则它只是一段 JSON——`Validating → Completed` 声明要求
      // `['attempt','validation']`，但只记录不核验时，一条从未被验收过的尝试
      // 照样能进 `Completed`，而事件流里那句话看起来像是在保证它。
      //
      // 放在 UPDATE 之前（而不是之后）：之后发现就只能回滚，而"已经写进去过"
      // 这件事本身会留下痕迹，回滚不掉的告警与外部副作用同理。
      const evidence = checkEvidence(db, attemptId, plan.requiresPersist)
      if (evidence.missing.length > 0) {
        throw evidenceError(attemptId, row.state, target, evidence.missing)
      }

      const finishedAtMs = ['Completed', 'Cancelled', 'DeadLetter'].includes(target) ? atMs : null
      const returnTo = target === 'AwaitingApproval' ? (context?.returnTo ?? 'Running') : null
      db.prepare(
        `UPDATE run_attempts
            SET state = ?, updated_at_ms = ?, finished_at_ms = COALESCE(?, finished_at_ms), return_to = ?,
                outcome = COALESCE(?, outcome), failure_code = COALESCE(?, failure_code), detail = COALESCE(?, detail)
          WHERE id = ? AND lease_epoch = ?`,
      ).run(target, atMs, finishedAtMs, returnTo, outcome, context?.failureCode ?? null, context?.detail ?? null, attemptId, epoch)

      const updated = rowOf(db, attemptId)
      appendEvent(db, {
        attempt: updated, from: row.state, to: target, actor: worker, epoch,
        reason: reason ?? (outcome === null ? null : `outcome:${outcome}`),
        requiresPersist: plan.requiresPersist, atMs,
      })
      // `approvalFrom` 必须来自**刚写进这一行的 `returnTo`**，而不是这条边的
      // `plan.taskStatusHint`。两者含义不同：
      //   - `returnTo` 回答「批准后回到哪一步」，同一状态有两个入口；
      //   - `plan.taskStatusHint` 描述的是**同一条边**，而进入 `AwaitingApproval`
      //     的两个入口（运行中的工具请求 / 验收后的交付审批）走的是**不同的边**
      //     （`Running → AwaitingApproval` 与 `Validating → AwaitingApproval`）。
      //
      // 曾经这里读的是 hint，于是 `Validating → AwaitingApproval` 落成 `in_progress`：
      // 一条**等着交付审批**的任务在看板上显示为"进行中"，审批人以为活还在干，
      // 于是它既不在待办里也没人在跑。而这一行上明明白白写着 `return_to='Validating'`，
      // 状态机也早就把 `AWAITING_APPROVAL_TASK_STATUS.Validating` 映射成 `in_review`
      // ——两处口径不一致时，以**已落库的事实**为准。
      const approvalFrom = target === 'AwaitingApproval' ? returnTo : undefined
      const status = projectToTask(db, updated, target, atMs, { approvalFrom })
      return Object.freeze({
        ok: true,
        attempt: shapeAttempt(updated),
        requiresPersist: plan.requiresPersist,
        createsNewAttempt: plan.createsNewAttempt,
        taskStatus: status,
        serverTimeMs: atMs,
        ignoredClientFields: Object.freeze(ignoredClientFields),
      })
    })
  }

  /**
   * 主动放弃租约（优雅停止时调用）。
   *
   * 两件事都要做，缺一不可：
   *   ① 把当前尝试终结为 `RetryableFailure`（而不是直接回 `Queued`：
   *      直接回 `Queued` 会让**同一次**尝试被重跑，于是「第 3 次尝试做过什么」
   *      与「第 3 次重跑做过什么」混在一行里，历史不再可信）；
   *   ② **再排队一次新尝试**（`RetryableFailure → Queued` 的 `createsNewAttempt`）。
   *
   * ②是集成测试抓到的：只做①时，释放之后**没有任何 Queued 尝试**，
   * 于是没有队列能领这条任务——调用方刚说完「我不做了，让别人接」，
   * 任务却要一直等到 `lease_expires_at_ms` 过期、被恢复扫描捡起来为止。
   * 而释放的全部意义就是**不等租期自然过期**：
   * 如果释放后还要等，那 `SIGTERM` 时释放与不释放没有区别。
   * （更糟的是任务看起来是「空闲」的，没有任何错误信息。）
   *
   * 重试次数的上限（什么情况下该进 Dead Letter 而不是无限排队）属于 PRT-309，
   * 这里不做预算判断：每次尝试都留在历史里，次数与原因可查。
   */
  function release({ attemptId, leaseEpoch, workerId, reason = 'released' } = {}) {
    const worker = requireWorker(workerId)
    const epoch = requireEpoch(leaseEpoch)
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw fail(RUN_ERRORS.ATTEMPT_NOT_FOUND, `运行尝试不存在：${attemptId}`, { attemptId }, 404)
      if (row.lease_epoch !== epoch) {
        throw fail(RUN_ERRORS.LEASE_EPOCH_STALE, `leaseEpoch 不符：请求 ${epoch}，实际 ${row.lease_epoch}——拒绝释放别人的租约`,
          { currentEpoch: row.lease_epoch, currentWorkerId: row.worker_id })
      }
      if (['Completed', 'Cancelled', 'DeadLetter'].includes(row.state)) {
        // 终态不需要释放。返回 ok 而不是报错：worker 在停止路径上多发一次是正常竞态。
        return Object.freeze({ ok: true, alreadyFinished: true, attempt: shapeAttempt(row), serverTimeMs: atMs })
      }
      // 释放同样要推进 epoch：释放之后这个 worker 已经**不是**持有者了，
      // 而它可能还有一个正在跑的 executor。不推进 epoch，那个 executor 结束后
      // 提交的结果会被状态机当成一次合法迁移接受——即「先释放再提交」成功了。
      // `openNextAttempt` 负责①：终结为 RetryableFailure、作废 epoch、并排队新尝试。
      const fresh = openNextAttempt(row, { atMs, actor: worker, reason, closing: 'RetryableFailure' })
      projectToTask(db, fresh, 'Queued', atMs)
      const closed = rowOf(db, attemptId)
      return Object.freeze({
        ok: true,
        released: true,
        attempt: shapeAttempt(closed),
        nextAttemptId: fresh.id,
        attemptNo: fresh.attempt_no,
        serverTimeMs: atMs,
      })
    })
  }

  /**
   * 回收过期租约（PRT-310 的核心）。
   *
   * `externalEffectPossible(kind)` 由调用方给出：它知道「哪些状态已经越过外部写边界」。
   * **缺这个判据就拒绝回收**——猜错的方向是「把一个可能已经付过费的任务重跑一遍」。
   * 本函数因此收的是一个判定函数或一个明确的布尔，而不是一个默认值。
   */
  function recoverExpired({ externalEffectPossible, scope = null, limit = 50, reason = 'lease-expired' } = {}) {
    if (typeof externalEffectPossible !== 'function' && typeof externalEffectPossible !== 'boolean') {
      throw new ContractError('EXTERNAL_EFFECT_UNKNOWN',
        'recoverExpired 需要 externalEffectPossible（布尔或 (attempt) => 布尔）。' +
        '这一条不能猜：判成「可重试」会在已发生外部副作用时重复执行，判成「未知」会让本可自动恢复的任务挂起')
    }
    const decide = typeof externalEffectPossible === 'function' ? externalEffectPossible : () => externalEffectPossible
    return withTx(() => {
      const atMs = clock()
      const rows = scope === null
        ? db.prepare(
          `SELECT * FROM run_attempts
            WHERE state IN ('Leased','PreparingWorkspace','BuildingContext','Running','Validating','HandingOff','AwaitingApproval')
              AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
            ORDER BY lease_expires_at_ms ASC LIMIT ?`).all(atMs, limit)
        : db.prepare(
          `SELECT * FROM run_attempts
            WHERE scope = ? AND state IN ('Leased','PreparingWorkspace','BuildingContext','Running','Validating','HandingOff','AwaitingApproval')
              AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
            ORDER BY lease_expires_at_ms ASC LIMIT ?`).all(scope, atMs, limit)
      const recovered = []
      for (const row of rows) {
        const attempt = shapeAttempt(row)
        const decision = recoveryDecision({
          attemptState: row.state,
          leaseValid: false,
          externalEffectPossible: decide(attempt),
        })
        if (decision.ok !== true) throw new ContractError('EXTERNAL_EFFECT_UNKNOWN', decision.message)
        if (decision.action === 'retry-new-attempt') {
          // 安全：未越过外部写边界。终结当前尝试并按**额度 + 退避**排队下次（历史保留）。
          //
          // 这里必须走 scheduleRetry 而不是直接 openNextAttempt：
          // 「每次快要失败时就被杀掉」是最难查的一种故障（没有失败上报、没有错误日志，
          // 只有租约一次次过期）。若回收路径不查额度，这种任务会**永远重试下去**，
          // 而正常失败路径上的额度上限完全不起作用——两条产生新尝试的路径
          // 必须共用同一个额度判定，否则等于没有上限。
          const outcome = scheduleRetry(row, { atMs, actor: 'recovery', reason, failureCode: 'lease-expired', delayMs: 0 })
          const settled = rowOf(db, row.id)
          const taskStatus = projectToTask(db, settled, settled.state, atMs, { retryBudgetRemaining: outcome.action === 'retry-new-attempt' })
          recovered.push(Object.freeze({
            attemptId: row.id,
            action: outcome.action,
            newAttemptId: outcome.attempt?.attemptId ?? null,
            nextAttemptAtMs: outcome.nextAttemptAtMs,
            attemptsUsed: outcome.attemptsUsed,
            maxAttempts: outcome.maxAttempts,
            taskStatus,
            reason: decision.reason,
          }))
        } else if (decision.action === 'mark-unknown-outcome') {
          // 危险：可能已经写过外部系统。挂起等人工，绝不自动重试。
          db.prepare("UPDATE run_attempts SET state = 'UnknownOutcome', updated_at_ms = ? WHERE id = ? AND lease_epoch = ?")
            .run(atMs, row.id, row.lease_epoch)
          const held = rowOf(db, row.id)
          appendEvent(db, { attempt: held, from: row.state, to: 'UnknownOutcome', actor: 'recovery', epoch: row.lease_epoch, reason, atMs })
          projectToTask(db, held, 'UnknownOutcome', atMs)
          recovered.push(Object.freeze({ attemptId: row.id, action: 'mark-unknown-outcome', reason: decision.reason }))
        } else {
          recovered.push(Object.freeze({ attemptId: row.id, action: decision.action, reason: decision.reason }))
        }
      }
      return Object.freeze({ ok: true, scanned: rows.length, recovered: Object.freeze(recovered), serverTimeMs: atMs })
    })
  }

  // ---------------------------------------------------------------- 只读

  function getAttempt(attemptId) {
    return shapeAttempt(rowOf(db, attemptId))
  }

  /** 一条任务的尝试历史（**只读**，供诊断页与「试过几次、每次错在哪」）。 */
  function historyOf(taskId) {
    const rows = db.prepare('SELECT * FROM run_attempts WHERE task_id = ? ORDER BY attempt_no ASC').all(taskId)
    return Object.freeze(rows.map((r) => shapeAttempt(r)))
  }

  /** 一条尝试的迁移事件流（append-only 的那张表）。 */
  function eventsOf(attemptId) {
    const rows = db.prepare('SELECT * FROM run_attempt_events WHERE attempt_id = ? ORDER BY seq ASC').all(attemptId)
    return Object.freeze(rows.map((r) => Object.freeze({
      seq: r.seq, atMs: r.at_ms, fromState: r.from_state, toState: r.to_state,
      actor: r.actor, leaseEpoch: r.lease_epoch, reason: r.reason,
      requiresPersist: r.requires_persist === null ? null : JSON.parse(r.requires_persist),
    })))
  }

  /** 运行面总览：每个状态有多少条尝试，以及有多少租约已过期。 */
  /**
   * 「这次执行失败了，按策略处置」——worker 报告失败时调用的**唯一**入口（PRT-309）。
   *
   * 为什么不让调用方自己 `transition({to:'RetryableFailure'})` 之后再单独排重试：
   * 分成两步时，漏掉第二步的后果是**任务永远停在 RetryableFailure**——
   * 它既没有新尝试可领（队列里没有 Queued），也不在等人工列表里（因为它不是
   * DeadLetter/UnknownOutcome），于是从任何界面看它都只是"失败了"，
   * 而没有任何人会去处理它。这类缺陷不会报错，只会让任务安静地停在那里。
   *
   * `leaseEpoch` 可选：worker 报告时必须给（否则它可能是在替别人报失败）；
   * 系统侧（回收、对账）用自己的 CAS 语义，不给 epoch。
   */
  function failAndRetry({ attemptId, leaseEpoch = null, actor, failureCode = null, detail = null, reason = 'failure-reported', nowMs = null } = {}) {
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new ContractError(RUN_ERRORS.WORKER_REQUIRED, 'failAndRetry 需要 actor（谁报告的失败）')
    }
    const ignoredClientFields = []
    if (nowMs !== null && nowMs !== undefined) ignoredClientFields.push('nowMs')
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw fail(RUN_ERRORS.ATTEMPT_NOT_FOUND, `运行尝试不存在：${attemptId}`, { attemptId }, 404)
      if (!isKnownAttemptState(row.state)) {
        throw fail(RUN_ERRORS.UNKNOWN_STATE, `库里的尝试状态「${row.state}」不是已登记状态之一`, { state: row.state }, 500)
      }
      if (leaseEpoch !== null && leaseEpoch !== undefined) {
        const epoch = requireEpoch(leaseEpoch)
        if (row.lease_epoch !== epoch) {
          throw fail(RUN_ERRORS.LEASE_EPOCH_STALE,
            `leaseEpoch 不符：请求 ${epoch}，实际 ${row.lease_epoch}——不能替别人报失败`,
            { currentEpoch: row.lease_epoch, currentWorkerId: row.worker_id })
        }
      }
      if (['Completed', 'Cancelled', 'DeadLetter'].includes(row.state)) {
        // 已经终结的尝试不再改变去向（重复上报是正常竞态，不是错误）
        return Object.freeze({ ok: true, alreadySettled: true, action: 'noop', attempt: shapeAttempt(row), serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields) })
      }
      if (row.state === 'RetryableFailure' || row.state === 'UnknownOutcome') {
        // 这条尝试**已经结算过**了：
        //   · `RetryableFailure` = 它已被判为失败，而那次失败排出的新尝试已经存在；
        //   · `UnknownOutcome`   = 它在等人工对账，绝不能因为"又报了一次失败"就重试
        //     （那正是 Unknown Outcome 存在的全部意义）。
        // 这里必须是 no-op。若继续往下走，`RetryableFailure` 会再触发一次
        // `RetryableFailure → Queued`，于是**一次失败被结算两次**、产生两条排队尝试，
        // 之后同一条任务会被两个 worker 各领一条——重复副作用，而没有任何报错。
        return Object.freeze({
          ok: true, alreadySettled: true, action: 'noop',
          attempt: shapeAttempt(row),
          reason: row.state === 'UnknownOutcome' ? 'awaiting-human-reconciliation' : 'already-settled',
          serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields),
        })
      }
      // 先落到 `RetryableFailure`（如果还不是），再统一走重试/额度判定。
      const toRetryable = row.state === 'RetryableFailure' ? null : 'RetryableFailure'
      if (toRetryable !== null) {
        const plan = transitionPlan(row.state, toRetryable, {})
        if (plan.ok !== true) {
          throw fail(RUN_ERRORS.TRANSITION_REJECTED, `${row.state} → RetryableFailure 被拒绝：${plan.message}`,
            { stateMachineCode: plan.code, from: row.state, to: toRetryable })
        }
        db.prepare('UPDATE run_attempts SET state = ?, updated_at_ms = ? WHERE id = ?')
          .run(toRetryable, atMs, attemptId)
        const mid = rowOf(db, attemptId)
        appendEvent(db, {
          attempt: mid, from: row.state, to: toRetryable, actor, epoch: row.lease_epoch,
          reason, requiresPersist: plan.requiresPersist, atMs,
        })
      }
      const settled = rowOf(db, attemptId)
      const outcome = scheduleRetry(settled, { atMs, actor, reason, failureCode, detail })
      // 投影按**最终**状态算：额度用完时是 DeadLetter（任务进 blocked），
      // 用中间态 RetryableFailure 投影会让任务短暂显示成"待办"
      const finalRow = rowOf(db, attemptId)
      const taskStatus = projectToTask(db, finalRow, finalRow.state, atMs, { retryBudgetRemaining: outcome.action === 'retry-new-attempt' })
      return Object.freeze({
        ok: true,
        action: outcome.action,
        attempt: shapeAttempt(finalRow),
        nextAttempt: outcome.attempt,
        nextAttemptAtMs: outcome.nextAttemptAtMs,
        attemptsUsed: outcome.attemptsUsed,
        maxAttempts: outcome.maxAttempts,
        reason: outcome.reason ?? null,
        taskStatus,
        serverTimeMs: atMs,
        ignoredClientFields: Object.freeze(ignoredClientFields),
      })
    })
  }

  /**
   * 「等人工处置」清单（PRT-310）：`UnknownOutcome`（外部写结果不可确认）
   * 与 `DeadLetter`（重试额度用完）两类。
   *
   * 这两类**必须**能从界面上看到并逐个结掉，否则：
   *   - `UnknownOutcome` 挂着的任务没人知道，队列看起来只是"没有任务"；
   *   - `DeadLetter` 只是历史里的一条记录，用户以为它还在跑。
   * 因此这个列表是"不丢任务"在**运维意义上**的落点：状态机保证不会静默重跑，
   * 这个列表保证不会静默消失。
   */
  function listHeld({ scope = null, limit = 100, nowMs = null } = {}) {
    const ignoredClientFields = []
    if (nowMs !== null && nowMs !== undefined) ignoredClientFields.push('nowMs')
    const atMs = clock()
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100
    const rows = scope === null
      ? db.prepare(
        `SELECT * FROM run_attempts WHERE state IN ('UnknownOutcome','DeadLetter')
          ORDER BY updated_at_ms DESC LIMIT ?`).all(cap)
      : db.prepare(
        `SELECT * FROM run_attempts WHERE state IN ('UnknownOutcome','DeadLetter') AND scope = ?
          ORDER BY updated_at_ms DESC LIMIT ?`).all(scope, cap)
    const items = rows.map((row) => {
      // 只看这一条任务**最新**的尝试是否就是这一条：历史里的 DeadLetter 不该继续出现在待办列表上，
      // 否则每次重试都会让列表变长，人工要处理的清单里混进一堆早已被替代的条目。
      const latest = db.prepare('SELECT MAX(attempt_no) AS n FROM run_attempts WHERE task_id = ?').get(row.task_id)
      return Object.freeze({
        ...shapeAttempt(row),
        isLatest: Number(row.attempt_no) === Number(latest.n),
        taskStatus: (db.prepare('SELECT status FROM tasks WHERE id = ?').get(row.task_id) ?? {}).status ?? null,
      })
    })
    const actionable = items.filter((i) => i.isLatest)
    return Object.freeze({
      ok: true,
      serverTimeMs: atMs,
      total: items.length,
      actionable: actionable.length,
      // `actionable` 才是需要人处理的；全部历史条目一并返回供追溯
      items: Object.freeze(items),
      ignoredClientFields: Object.freeze(ignoredClientFields),
    })
  }

  /**
   * 人工处置一次「结果不可确认」或「已进 Dead Letter」的尝试（PRT-310/311）。
   *
   * `decision` 的四个取值各自对应一个**不同的事实**，缺一不可：
   *
   * | decision | 事实 | 去向 |
   * | --- | --- | --- |
   * | `external-effect-happened` | 对账确认外部写已生效 | UnknownOutcome → Validating（按成功走验收，**不重跑**） |
   * | `external-effect-absent` | 对账确认外部写未生效 | UnknownOutcome → RetryableFailure → 重试/额度判定 |
   * | `dead-letter` | 查不清 / 决定人工兜底 | → DeadLetter |
   * | `cancel` | 决定不做 | → Cancelled |
   *
   * 「对账确认」这件事没有自动等价物，因此它必须由人（或一个真正做过对账的探测）
   * 显式说出来。这里不提供"默认当成没发生"的便利入口：那正是重复付费的来源。
   */
  function resolveAttempt({ attemptId, decision, actor, note = null, nowMs = null } = {}) {
    if (!RESOLUTION_DECISIONS.includes(decision)) {
      throw new ContractError('BAD_DECISION',
        `未知的处置决定「${decision}」。可选：${RESOLUTION_DECISIONS.join(' / ')}（缺省不做任何默认处置——` +
        '猜错的两种结果分别是"重复执行一次已生效的外部写"与"静默丢弃一次已完成的交付"）')
    }
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new ContractError(RUN_ERRORS.WORKER_REQUIRED, 'resolveAttempt 需要 actor（谁做的决定，要留痕）')
    }
    const ignoredClientFields = []
    if (nowMs !== null && nowMs !== undefined) ignoredClientFields.push('nowMs')
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw fail(RUN_ERRORS.ATTEMPT_NOT_FOUND, `运行尝试不存在：${attemptId}`, { attemptId }, 404)
      if (!isKnownAttemptState(row.state)) {
        throw fail(RUN_ERRORS.UNKNOWN_STATE, `库里的尝试状态「${row.state}」不是已登记状态之一`, { state: row.state }, 500)
      }
      if (!['UnknownOutcome', 'DeadLetter', 'RetryableFailure'].includes(row.state)) {
        throw fail(RUN_ERRORS.NOT_HELD,
          `这条尝试的状态是 ${row.state}，不需要人工处置（只有 UnknownOutcome / DeadLetter / RetryableFailure 需要）`,
          { state: row.state })
      }

      const setVerdict = (verdict) => {
        db.prepare('UPDATE run_attempts SET external_effect = ?, resolved_by = ?, resolved_note = ?, updated_at_ms = ? WHERE id = ?')
          .run(verdict, actor, note, atMs, attemptId)
      }
      // 状态迁移仍然过状态机：人工处置不是"绕过规则的后门"，
      // 它只是提供了规则要求的那个输入（对账结论）。
      const move = (to, ctx = {}) => {
        const current = rowOf(db, attemptId)
        const plan = transitionPlan(current.state, to, ctx)
        if (plan.ok !== true) {
          throw fail(RUN_ERRORS.TRANSITION_REJECTED, plan.message, { stateMachineCode: plan.code, from: current.state, to })
        }
        if (plan.idempotent === true) return current
        const finishedAtMs = ['Completed', 'Cancelled', 'DeadLetter'].includes(to) ? atMs : null
        db.prepare('UPDATE run_attempts SET state = ?, updated_at_ms = ?, finished_at_ms = COALESCE(?, finished_at_ms) WHERE id = ?')
          .run(to, atMs, finishedAtMs, attemptId)
        const next = rowOf(db, attemptId)
        appendEvent(db, {
          attempt: next, from: current.state, to, actor, epoch: current.lease_epoch,
          reason: `human-resolution:${decision}`, requiresPersist: plan.requiresPersist, atMs,
        })
        return next
      }

      if (decision === 'cancel') {
        const next = move('Cancelled')
        projectToTask(db, next, 'Cancelled', atMs)
        return Object.freeze({ ok: true, decision, attempt: shapeAttempt(next), action: 'cancelled', serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields) })
      }
      if (decision === 'dead-letter') {
        setVerdict(row.external_effect ?? null)
        // `UnknownOutcome → DeadLetter` 与 `RetryableFailure → DeadLetter` 都是合法边
        const next = move('DeadLetter')
        projectToTask(db, next, 'DeadLetter', atMs, { retryBudgetRemaining: false })
        return Object.freeze({ ok: true, decision, attempt: shapeAttempt(next), action: 'dead-letter', serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields) })
      }
      if (decision === 'external-effect-happened') {
        setVerdict('confirmed')
        const next = move('Validating', { externalEffectConfirmed: true })
        const taskStatus = projectToTask(db, next, 'Validating', atMs)
        return Object.freeze({
          ok: true, decision, attempt: shapeAttempt(next), action: 'continue-validation', taskStatus,
          serverTimeMs: atMs, ignoredClientFields: Object.freeze(ignoredClientFields),
        })
      }
      // external-effect-absent / retry：确认没发生 → 降级为可重试失败，再走额度判定
      setVerdict('absent')
      let current = row
      if (current.state === 'UnknownOutcome') {
        current = move('RetryableFailure', { externalEffectConfirmed: false })
      } else if (current.state === 'DeadLetter' || current.state === 'RetryableFailure') {
        // 已经从 DeadLetter 恢复：人工可以显式要求再试一次。
        // 这是唯一允许离开 DeadLetter 的路径，且必然产生**新的一次尝试**（历史保留）。
        if (current.state === 'DeadLetter') {
          throw fail(RUN_ERRORS.NOT_HELD,
            'DeadLetter 是终态：人工确认外部写未发生后，请新建任务或显式重新打开（不要在终态上重试）',
            { state: current.state })
        }
      }
      const outcome = scheduleRetry(current, { atMs, actor, reason: `human-resolution:${decision}`, failureCode: 'reconciled-no-external-effect', detail: note })
      const finalRow = rowOf(db, attemptId)
      const taskStatus = projectToTask(db, finalRow, finalRow.state, atMs, { retryBudgetRemaining: outcome.action === 'retry-new-attempt' })
      return Object.freeze({
        ok: true,
        decision,
        attempt: shapeAttempt(finalRow),
        action: outcome.action === 'retry-new-attempt' ? 'retry-new-attempt' : 'dead-letter',
        nextAttempt: outcome.attempt,
        nextAttemptAtMs: outcome.nextAttemptAtMs,
        attemptsUsed: outcome.attemptsUsed,
        maxAttempts: outcome.maxAttempts,
        taskStatus,
        serverTimeMs: atMs,
        ignoredClientFields: Object.freeze(ignoredClientFields),
      })
    })
  }

  /** 重试额度读数（诊断与界面用）。 */
  function retryBudgetOf(taskId) {
    const latest = db.prepare('SELECT * FROM run_attempts WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1').get(taskId)
    if (latest === undefined) return Object.freeze({ taskId, attemptsUsed: 0, maxAttempts: attemptLimit, remaining: attemptLimit })
    return Object.freeze({
      taskId,
      attemptsUsed: Number(latest.attempt_no),
      maxAttempts: attemptLimit,
      remaining: Math.max(0, attemptLimit - Number(latest.attempt_no)),
      nextAttemptAtMs: latest.next_attempt_at_ms ?? null,
      idempotencyKey: latest.idempotency_key ?? null,
    })
  }

  /**
   * 一条任务的**验收判据**（从看板实体读，不是从调用方拿）。
   *
   * 为什么由服务端读而不是让 worker 传进来：判据是任务的契约（`tasks.acceptance`），
   * 而 spec §5 定的是「team-hub 是任务与团队状态的事实源，DSH/worker 不是」。
   * 让 worker 报判据等于让执行者自己出考卷。
   */
  function criteriaOf(taskId) {
    const row = db.prepare('SELECT acceptance FROM tasks WHERE id = ?').get(taskId)
    const raw = row?.acceptance
    if (raw === null || raw === undefined || raw === '') return Object.freeze([])
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      // 不是"没有判据"：那一行的数据坏了。当成空判据会让它静默走人工审批，
      // 而真正的原因（数据坏了、没人能修）永远不出现。
      // 500 而不是 400：请求完全合法，是**库里的数据**有问题——
      // 与「调用方传错参数」必须能区分开，否则运维会去查错地方。
      throw fail(RUN_ERRORS.BAD_ACCEPTANCE_CRITERIA,
        `任务 ${taskId} 的 acceptance 不是合法 JSON：${e.message}。这是数据问题而不是"没有判据"——` +
        '当成空判据会让它静默挂到人工审批上，而没人知道那一行坏了',
        { taskId, raw: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw }, 500)
    }
    if (!Array.isArray(parsed)) {
      throw fail(RUN_ERRORS.BAD_ACCEPTANCE_CRITERIA,
        `任务 ${taskId} 的 acceptance 是 ${typeof parsed} 而不是数组：判据必须是一个列表，不得猜`,
        { taskId, actualType: typeof parsed }, 500)
    }
    return Object.freeze(parsed)
  }

  /** 一次尝试的验收记录（只读，按时间升序）。 */
  function validationsOf(attemptId) {
    return Object.freeze(validationRows(db, attemptId).map((r) => Object.freeze({
      seq: Number(r.seq),
      attemptId: r.attempt_id,
      taskId: r.task_id,
      decision: r.decision,
      reason: r.reason,
      gate: r.gate_json === null ? null : JSON.parse(r.gate_json),
      results: r.results_json === null ? Object.freeze([]) : Object.freeze(JSON.parse(r.results_json)),
      run: r.run_json === null ? null : JSON.parse(r.run_json),
      // 实际用过的判据必须能被读回来，否则事后无法回答"当时按什么验的"——
      // 而人工复审覆盖过判据时，这一点尤其重要（契约里的判据与当时用的不是同一份）。
      criteria: r.criteria_json === null ? Object.freeze([]) : Object.freeze(JSON.parse(r.criteria_json)),
      actor: r.actor,
      leaseEpoch: r.lease_epoch === null ? null : Number(r.lease_epoch),
      atMs: Number(r.at_ms),
    })))
  }

  /**
   * 机器验收（PRT-307）：对 `Validating` 上的尝试跑一次验收，落库结论并推进状态。
   *
   * 这是**唯一**的验收入口。它一次做完三件必须一起发生的事：
   *   ① 按任务声明的判据核验运行结果（`evaluateAcceptance`）；
   *   ② 把结论落库（**先落库**，因为下面的迁移边声明了 `validation` 证据）；
   *   ③ 按结论推进状态，并在验收通过时要求调用方明确回答 `hasNextPost`。
   *
   * 分三次调用（记结论 / 改状态 / 决定去向）会让"结论与状态不一致"成为可能：
   * 崩在中间时，一条被判为 rejected 的尝试会留在 Validating，而重扫会再跑一次验收——
   * 于是同一次运行被验收两次，第二次的结论覆盖了第一次的含义（虽然记录都在）。
   *
   * `criteria` 可以由调用方覆盖（人工复审用），缺省时读任务的 `acceptance`。
   * 覆盖是显式的：**不传**时才知道用的是任务契约里的判据。
   */
  function recordValidation({
    attemptId, leaseEpoch = null, actor, runResult,
    criteria = null, hasNextPost = undefined, nextPost = null, reason = null,
  }) {
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new ContractError(RUN_ERRORS.WORKER_REQUIRED, 'recordValidation 需要 actor：谁做的验收决定必须留痕')
    }
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw new ContractError(RUN_ERRORS.ATTEMPT_NOT_FOUND, `没有这条尝试：${attemptId}`)
      // 传了 epoch 就必须对得上（过期的 worker 不得改写别人的结果）；
      // 不传表示这是**服务端发起**的验收（人工复审），此时没有持有者可言。
      if (leaseEpoch !== null && leaseEpoch !== undefined && row.lease_epoch !== leaseEpoch) {
        throw fail(RUN_ERRORS.LEASE_EPOCH_STALE,
          `leaseEpoch 不符：请求 ${leaseEpoch}，实际 ${row.lease_epoch}——拒绝写入过期的验收结论`,
          { currentEpoch: row.lease_epoch, currentWorkerId: row.worker_id })
      }
      if (row.state !== 'Validating') {
        // 409：请求合法，是**当前状态**不该被验收。
        throw fail(RUN_ERRORS.NOT_VALIDATING,
          `验收只对 Validating 上的尝试有意义，当前是 ${row.state}。` +
          '在别的状态上验收等于给一个还没跑完（或已经结束）的尝试出一份结论',
          { attemptId, state: row.state }, 409)
      }

      const effectiveCriteria = criteria ?? criteriaOf(row.task_id)
      let verdict
      try {
        verdict = evaluateAcceptance({ runResult, criteria: effectiveCriteria })
      } catch (e) {
        if (e instanceof AcceptanceError) {
          // 契约错误（runResult 形状不对）**不落库**：它不是一次验收结论，
          // 而是调用方给错了东西。落一条 rejected 会让一条本来能通过的任务被打回。
          throw new ContractError(e.code, e.message)
        }
        throw e
      }

      db.prepare(
        `INSERT INTO run_validations
           (attempt_id, task_id, decision, reason, gate_json, results_json, run_json, criteria_json, actor, lease_epoch, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attemptId, row.task_id, verdict.decision, reason ?? verdict.reason,
        JSON.stringify(verdict.gate),
        // 只存判定所需的叶子字段：判据原文与逐条结论，不存整个 runResult
        // （它可能含产物内容或漏脱敏的东西，而验收记录要长期保存）
        JSON.stringify(verdict.results.map((r) => ({ criterion: r.criterion, ok: r.ok, unverifiable: r.unverifiable, reason: r.reason }))),
        JSON.stringify(verdict.run),
        JSON.stringify(effectiveCriteria),
        actor, Number.isInteger(row.lease_epoch) ? row.lease_epoch : null, atMs,
      )

      const target = acceptanceTarget(verdict.decision, { hasNextPost })
      if (target.ok !== true) {
        // 去向定不下来时**整笔回滚**（withTx 抛出即 ROLLBACK）：验收记录也就不会被留下。
        // 留一条没有对应状态迁移的验收记录，会让下一次调用看到"已经验收过了"
        // 而不知道它有没有生效。
        throw new ContractError(target.code === 'UNKNOWN_DECISION' ? RUN_ERRORS.TRANSITION_REJECTED : target.code, target.message)
      }

      // ── 打回：**不**先 transition，交给 scheduleRetry ──
      //
      // `scheduleRetry` 自己会把这条尝试终结为 `RetryableFailure`（再按额度决定
      // 是新建下一次尝试还是进 DeadLetter）。若这里先 transition 到 RetryableFailure，
      // 它会拿着已经是 RetryableFailure 的行再走一遍 `RetryableFailure → RetryableFailure`
      // —— 而那条边在状态机里不存在。
      //
      // 「还有没有额度」只有 scheduleRetry 一处判断。在这里自己也判一次，迟早
      // 会出现一处漏掉额度检查，而那种漏掉的后果是**无限重试且不报错**。
      if (verdict.decision === 'rejected') {
        const settled = scheduleRetry(row, {
          atMs, actor, reason: 'validation-rejected',
          failureCode: 'acceptance-rejected', detail: verdict.reason,
        })
        return Object.freeze({
          ok: true,
          decision: verdict.decision,
          reason: reason ?? verdict.reason,
          gate: verdict.gate,
          results: verdict.results,
          run: verdict.run,
          criteria: effectiveCriteria,
          // taskStatus 由 scheduleRetry 的结果决定：重试 → 回队列；额度耗尽 → blocked
          taskStatus: projectToTask(db, rowOf(db, attemptId),
            settled.action === 'dead-letter' ? 'DeadLetter' : 'RetryableFailure', atMs),
          settlement: settled,
          serverTimeMs: atMs,
        })
      }

      // ── 通过 / 交人工：走状态机（它会核 `requiresPersist`，也就是上面刚写进去的验收记录）
      const applied = transition({
        attemptId,
        // 用**行上当前的** epoch，而不是调用方传进来的那个：验收结论已经核过 epoch 了，
        // 而状态机是唯一真正写入的路径，它必须自己再核一次（不能指望调用方替它把关）。
        leaseEpoch: Number(row.lease_epoch),
        workerId: actor,
        to: target.to,
        context: { ...target.context, hasNextPost, detail: verdict.reason },
        reason: `validation:${verdict.decision}`,
      })

      return Object.freeze({
        ok: true,
        decision: verdict.decision,
        reason: reason ?? verdict.reason,
        gate: verdict.gate,
        results: verdict.results,
        run: verdict.run,
        criteria: effectiveCriteria,
        attempt: applied.attempt,
        nextPost,
        taskStatus: applied.taskStatus,
        requiresPersist: applied.requiresPersist,
        serverTimeMs: atMs,
      })
    })
  }

  /** 一次尝试的交接记录（只读）。 */
  function handoffsOf(attemptId) {
    return Object.freeze(db.prepare('SELECT * FROM run_handoffs WHERE attempt_id = ? ORDER BY seq').all(attemptId)
      .map((r) => Object.freeze({
        seq: Number(r.seq),
        attemptId: r.attempt_id,
        taskId: r.task_id,
        successorId: r.successor_id,
        successorRole: r.successor_role,
        actor: r.actor,
        leaseEpoch: r.lease_epoch === null ? null : Number(r.lease_epoch),
        reason: r.reason,
        atMs: Number(r.at_ms),
      })))
  }

  /**
   * 交接（PRT-308，spec 第 333 行）：当前 Task 收口并**原子创建**下一岗位任务。
   *
   * 一次事务里做完三件事：建后继任务 → 记交接记录 → 把本尝试终结为 `Completed`。
   * 分成两步（先建任务、再改状态）在崩在中间时会留下一条孤儿后继：
   * 本任务还在 `HandingOff`，而下一岗位已经在跑了——重扫时会**再建一条**。
   *
   * 幂等靠两处，且都在同一个事务里：
   *   ① 先查 `run_handoffs` 有没有这条尝试的记录 → 有就直接返回它的 `successorId`；
   *   ② `run_handoffs.successor_id` 上有**唯一索引**——这是数据库层面的保证。
   * 只在应用层查重时，两个并发进程会各查一次、各建一条（与 `ensureColumn`
   * 那次的失败模式一样）。
   *
   * `createTask` / `readPipeline` 由调用方注入：
   *   - `createTask(payload) → {id}`：建任务要写 30 个列，而那张表属于 server.mjs。
   *     注入而不是让 run-store 去认识 tasks 的 schema——但它**必须**在同一个事务里
   *     被调用（同一个连接），否则原子性就没了。
   *   - `readPipeline(scope) → stages`：`space_stages` 同样不属于运行仓储。
   * 两者缺失时报具名错误（`HANDOFF_NOT_WIRED`），**不降级**成"没有下一岗位"。
   */
  function handoff({ attemptId, leaseEpoch = null, actor, prevSummary = null, reason = null } = {}) {
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new ContractError(RUN_ERRORS.WORKER_REQUIRED, 'handoff 需要 actor：谁做的交接决定必须留痕')
    }
    if (typeof createTask !== 'function' || typeof readPipeline !== 'function') {
      throw fail(RUN_ERRORS.HANDOFF_NOT_WIRED,
        `交接没有接线（createTask=${typeof createTask}，readPipeline=${typeof readPipeline}）。` +
        '**不降级**成"没有下一岗位"：那会让交接在静默中变成收口，任务链断在第一环而没人知道',
        {}, 500)
    }
    return withTx(() => {
      const atMs = clock()
      const row = rowOf(db, attemptId)
      if (row === null) throw new ContractError(RUN_ERRORS.ATTEMPT_NOT_FOUND, `没有这条尝试：${attemptId}`)
      if (leaseEpoch !== null && leaseEpoch !== undefined && row.lease_epoch !== leaseEpoch) {
        throw fail(RUN_ERRORS.LEASE_EPOCH_STALE,
          `leaseEpoch 不符：请求 ${leaseEpoch}，实际 ${row.lease_epoch}——拒绝写入过期的交接`,
          { currentEpoch: row.lease_epoch, currentWorkerId: row.worker_id })
      }

      // ── 幂等：已经交接过了就直接返回那条后继，不再建第二条 ──
      // 这一句必须在最前面（在任何写之前）：崩后重扫、租约过期回收、人工重放
      // 都会走到这里，而"同一环出现两条下一岗位的任务"会让下一环被做两遍。
      const existing = db.prepare('SELECT * FROM run_handoffs WHERE attempt_id = ? ORDER BY seq').get(attemptId)
      if (existing !== undefined) {
        return Object.freeze({
          ok: true, action: 'already-handed-off',
          successorId: existing.successor_id, successorRole: existing.successor_role,
          attempt: shapeAttempt(row), taskStatus: projectToTask(db, row, row.state, atMs),
          reason: '这条尝试已经交接过了（重放是正常路径：崩后重扫会重放同一次交接）',
          serverTimeMs: atMs,
        })
      }

      if (row.state !== 'HandingOff') {
        throw fail(RUN_ERRORS.NOT_HANDING_OFF,
          `交接只对 HandingOff 上的尝试有意义，当前是 ${row.state}。` +
          '从别处交接等于跳过"验收通过"这一步——下一岗位会在上一环还没被接受时就开始做',
          { attemptId, state: row.state }, 409)
      }

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id)
      if (task === undefined) {
        throw new ContractError(RUN_ERRORS.ATTEMPT_NOT_FOUND, `任务不存在：${row.task_id}`)
      }

      const stages = readPipeline(task.scope ?? 'default')
      const resolved = resolveNextPost({ stages, role: task.role ?? null })
      if (resolved.ok !== true) {
        // 链断 / 岗位不存在 / 任务没记岗位。**不报成链尾**，也不自动收口：
        // 收口会让任务链静默断在这里，直到整个目标停住才被发现。
        throw fail(RUN_ERRORS.HANDOFF_REJECTED, resolved.message,
          { attemptId, role: task.role ?? null, pipelineCode: resolved.code, brokenEdge: resolved.brokenEdge }, 409)
      }
      if (resolved.hasNext !== true) {
        // 走到了 HandingOff，而流水线说这是链尾——**两处判断不一致**必须报出来。
        // 自动收口成 Completed 会把这份不一致藏掉，而藏掉之后没人会去查
        // 到底是验收时判错了，还是流水线在这中间被改过。
        throw fail(RUN_ERRORS.HANDOFF_REJECTED,
          `这条任务在 HandingOff，但流水线说岗位「${task.role}」是链尾（${resolved.reason}）。` +
          '两处判断不一致：不自动收口，否则这条不一致永远不会有人看见',
          { attemptId, role: task.role ?? null }, 409)
      }

      const { task: payload } = buildHandoffTask({
        prevTask: { ...task, goalId: task.goalId ?? null },
        nextStage: resolved.nextStage,
        stages,
        prevSummary,
      })
      const created = createTask(payload)
      const successorId = created?.id
      if (typeof successorId !== 'string' || successorId === '') {
        // 建任务没有返回 id：此时**不能**当成功。没有 id 就没有后继可指，
        // 而记一条空的交接等于把"下一岗位已建好"写成事实。
        throw fail(RUN_ERRORS.HANDOFF_REJECTED,
          `createTask 没有返回后继任务 id（收到 ${JSON.stringify(created)}）：无法确认后继真的被创建了`,
          { attemptId }, 500)
      }

      db.prepare(
        `INSERT INTO run_handoffs (attempt_id, task_id, successor_id, successor_role, actor, lease_epoch, reason, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(attemptId, row.task_id, successorId, resolved.nextRole, actor,
        Number.isInteger(row.lease_epoch) ? row.lease_epoch : null, reason, atMs)

      // 收口：`HandingOff → Completed`。这一步会过 PRT-307 的证据闸门，
      // 而上面刚写进去的交接记录正是它要的证据——"交接发生了"的证据是
      // **后继任务真的被创建了**，不是调用方说"我交接了"。
      const settled = transition({
        attemptId, leaseEpoch: Number(row.lease_epoch), workerId: actor, to: 'Completed',
        context: { hasNextPost: false }, reason: reason ?? `handoff:${resolved.nextRole}`,
      })

      return Object.freeze({
        ok: true,
        action: 'handed-off',
        successorId,
        successorRole: resolved.nextRole,
        attempt: settled.attempt,
        taskStatus: settled.taskStatus,
        requiresPersist: settled.requiresPersist,
        serverTimeMs: atMs,
      })
    })
  }

  function stats() {
    // 只用服务端时钟。「有多少租约已过期」是一个**判定**而不是一次查询参数：
    // 允许调用方传时间，就等于允许它把「全都过期」或「一个都没过期」说出来。
    const atMs = clock()
    const byState = {}
    for (const s of ATTEMPT_STATES) byState[s] = 0
    for (const r of db.prepare('SELECT state, COUNT(*) AS n FROM run_attempts GROUP BY state').all()) {
      if (Object.prototype.hasOwnProperty.call(byState, r.state)) byState[r.state] = Number(r.n)
      else byState[r.state] = Number(r.n) // 未登记状态照样报出来，不吞
    }
    const expired = Number(db.prepare(
      `SELECT COUNT(*) AS n FROM run_attempts
        WHERE state IN ('Leased','PreparingWorkspace','BuildingContext','Running','Validating','HandingOff','AwaitingApproval')
          AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?`).get(atMs).n)
    return Object.freeze({ byState: Object.freeze(byState), expiredLeases: expired, serverTimeMs: atMs })
  }

  return Object.freeze({
    claim, heartbeat, transition, release, recoverExpired,
    // PRT-309：失败结算的唯一入口（重试 / 退避 / 额度耗尽 → Dead Letter）
    failAndRetry, scheduleRetry, retryBudgetOf,
    // PRT-310/311：等人工清单与人工处置
    listHeld, resolveAttempt,
    // PRT-307：机器验收的唯一入口（核判据 → 落库 → 按结论推进状态）
    recordValidation, validationsOf, criteriaOf,
    // PRT-308：交接（原子创建下一岗位任务 + 收口）
    handoff, handoffsOf,
    getAttempt, historyOf, eventsOf, stats,
    withTx,
    /** 供测试与诊断：当前生效的默认租期。 */
    defaultLeaseTtlMs: defaultTtl,
    /** 供测试与诊断：当前生效的最大尝试次数与退避策略。 */
    maxAttempts: attemptLimit,
    backoffPolicy,
  })
}

/**
 * 执行结果名义 → Attempt 目标状态。
 *
 * `completed → Validating` 而不是 `Completed`：执行完成**不等于**交付被接受。
 * 直接把执行成功写成 `Completed` 会让「机器验收没通过」的任务显示为已完成——
 * 这正是 spec 要求把验收建模成独立一步的原因。
 */
export function mapOutcomeToState(outcome) {
  switch (outcome) {
    case 'completed': return 'Validating'
    case 'failed': return 'RetryableFailure'
    case 'outcome_unknown': return 'UnknownOutcome'
    case 'cancelled': return 'Cancelled'
    case null:
    case undefined: return null
    default: return null
  }
}

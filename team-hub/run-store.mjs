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
  isKnownAttemptState,
  recoveryDecision,
  taskStatusOf,
  transitionPlan,
} from '../orchestrator/state-machine/index.mjs'

/** 默认租期。短到「崩溃后能被较快回收」，长到「一次正常执行不会被误判为死亡」。 */
export const DEFAULT_LEASE_TTL_MS = 120000

/** 租期上限：防止调用方配出一个「永远不过期」的租期，那等于没有租约。 */
export const MAX_LEASE_TTL_MS = 3600000

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
  UNKNOWN_STATE: 'UNKNOWN_ATTEMPT_STATE',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  TRANSITION_REJECTED: 'TRANSITION_REJECTED',
  SCOPE_REQUIRED: 'SCOPE_REQUIRED',
})

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
 * 建运行实体表。幂等（`IF NOT EXISTS`），老库自动补建，不需要迁移脚本。
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
  // 领取查询走这个索引：按状态挑最早的排队尝试。
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_state ON run_attempts(state, created_at_ms)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_task ON run_attempts(task_id, attempt_no)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_attempts_lease ON run_attempts(lease_expires_at_ms)')

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
    returnTo: row.return_to,
    outcome: row.outcome,
    failureCode: row.failure_code,
    detail: row.detail,
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
 */
const QUEUED_CANDIDATE_SQL = `
  SELECT a.* FROM run_attempts a
  JOIN tasks t ON t.id = a.task_id
  WHERE a.state = 'Queued'
    AND t.status = 'todo' AND COALESCE(t.hold, 0) = 0
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
export function createRunStore({ db, clock = () => Date.now(), leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  if (db === undefined || db === null) throw new TypeError('createRunStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createRunStore 的 clock 必须是函数')
  const defaultTtl = resolveTtl(leaseTtlMs)
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

  /** 新建一次尝试（编号 = 同任务最大值 + 1）。这是「重试不覆盖历史」的唯一入口。 */
  function createAttempt({ taskId, scope, state = 'Queued', atMs, actor = null, returnTo = null }) {
    const maxRow = db.prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM run_attempts WHERE task_id = ?').get(taskId)
    const attemptNo = Number(maxRow.n) + 1
    const id = `att:${taskId}:${attemptNo}`
    db.prepare(
      `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, worker_id, lease_epoch, lease_expires_at_ms, return_to, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?)`,
    ).run(id, taskId, scope, attemptNo, state, returnTo, atMs, atMs)
    const row = rowOf(db, id)
    appendEvent(db, { attempt: row, from: null, to: state, actor, epoch: 0, reason: 'attempt-created', atMs })
    return row
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
  function openNextAttempt(row, { atMs, actor, reason, closing }) {
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
    db.prepare('UPDATE run_attempts SET state = ?, lease_epoch = ?, updated_at_ms = ?, finished_at_ms = ? WHERE id = ? AND lease_epoch = ?')
      .run(closing, invalidatedEpoch, atMs, atMs, row.id, row.lease_epoch)
    const closed = rowOf(db, row.id)
    appendEvent(db, { attempt: closed, from: row.state, to: closing, actor, epoch: row.lease_epoch, reason, atMs })
    appendEvent(db, {
      attempt: closed, from: closing, to: closing, actor, epoch: invalidatedEpoch,
      reason: `${reason}:lease-invalidated`, atMs,
    })
    const fresh = createAttempt({ taskId: row.task_id, scope: row.scope, state: 'Queued', atMs, actor })
    appendEvent(db, { attempt: fresh, from: closing, to: 'Queued', actor, epoch: 0, reason: `${reason}:new-attempt`, atMs })
    return fresh
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
      let candidate = db.prepare(queued.sql).get(...queued.params)

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
      const status = projectToTask(db, updated, target, atMs, { approvalFrom: plan.taskStatusHint === 'in_review' ? 'Validating' : undefined })
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
          // 安全：未越过外部写边界。终结当前尝试并排队一次新尝试（历史保留）。
          const fresh = openNextAttempt(row, { atMs, actor: 'recovery', reason, closing: 'RetryableFailure' })
          projectToTask(db, fresh, 'Queued', atMs)
          recovered.push(Object.freeze({ attemptId: row.id, action: 'retry-new-attempt', newAttemptId: fresh.id, reason: decision.reason }))
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
    getAttempt, historyOf, eventsOf, stats,
    withTx,
    /** 供测试与诊断：当前生效的默认租期。 */
    defaultLeaseTtlMs: defaultTtl,
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

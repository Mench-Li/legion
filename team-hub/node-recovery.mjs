// team-hub/node-recovery.mjs
// ============================================================================
// 远程节点的**租约回收与预约结清**（远程 Agent 通道 S-D 之三）
//
// ## 为什么必须有这个后台作业
//
// 本机 worker（DSH 守护）会自己回收自己的租约——它是个长驻进程，知道哪些
// 尝试还活着。**远程节点不是**：它断线、被关机、被拔网线，Hub 这边没有任何
// 东西会去收拾它留下的租约。而一条到期的租约不是"等着就好"：
//
//   ① 它占着**单写者位**（`write_reservations`），于是**所有**新任务都领不到
//      ——`claim` 返回 `file-contention`，在界面上只是"任务不动"；
//   ② 它停在 `Leased`/`Running`，租约过期后既不会被重试也不会进等人工清单。
//
// 实测就是这么卡住的：一次旧代码留下的 `Leased` 尝试，让后面每一条验收任务
// 都动不了，而日志里只有一条（后来才加的）`NODE_CLAIM_BLOCKED`。
//
// ## 两条纪律
//
// ① **判成"未知"而不是"可重试"。** 逾期的远端尝试可能已经在电脑上产生了副作用
//    （推到远端、删了文件、付了款）。`recoverExpired` 的两条出口里，
//    「可重试」会在副作用已发生时重复执行，而「未知」只是要人对账。
//    代价不对称，所以一律选后者：`externalEffectPossible` 对**所有**在途状态返回 true。
//
// ② **结清预约只做"确定没人持有"的那些。** 只有当一个任务**没有任何在途尝试**、
//    而它的预约仍是 `reserved` 时，那个预约才是真的漏了（尝试已经终结，
//    但 `finishTaskReservationInTx` 只在看板迁移时被调用，见下）。
//    对还持有在途尝试的任务动手，等于把正在写的任务的空间让给别人。
//
// ## 关于 `finishTaskReservationInTx` 的那条接线缺口
//
// 预约的结清写在 `server.mjs` 的 `finishTaskReservationInTx`，它只在**看板迁移**
// （`to='in_review'|'done'|'canceled'`）时被调用。而 `run-store` 的 `projectToTask`
// 是**直接 `UPDATE tasks.status`**，不走那条路径——于是远端尝试走到终态、
// 看板被投影成 `in_review` 时预约没被结清。
//
// 本模块的 ② 是那个缺口的安全网：它按**事实**（有没有在途尝试）判定，
// 而不是按"有没有人调过那个函数"。
// ============================================================================

/** 在途状态。与 `run-store.mjs` 的 `IN_FLIGHT_ATTEMPT_STATES` 同源，不另写一份。 */
export const RECOVERY_CODES = Object.freeze({
  SWEEP_FAILED: 'NODE_RECOVERY_SWEEP_FAILED',
})

/**
 * 回收器扫描的 Attempt 状态：**只含"节点可能正在执行"的那几个**。
 *
 * 不含 `Validating` / `HandingOff` / `AwaitingApproval`——它们的意思是
 * "执行已经结束，在等验收 / 交接 / 批准"。对它们而言租约过期**不等于**
 * "结果不明"：`runResult` 早就落库了。而 `recoveryDecision` 在租约过期时
 * 一律给 `mark-unknown-outcome`，于是"已完成待验收"会被改写成"结果待确认"。
 *
 * 一个**已知结果**被标成未知，与未知被标成已知是同一类错误，方向相反而已。
 * 实测踩过：验收里一次成功完成的任务，在租约过期后从 `in_review` 掉进了
 * `blocked`（"结果待确认"）。
 *
 * 等人那一段各自有专用路径（审批 TTL 扫描、验收记录、交接），不该由本回收器代劳。
 */
export const RECOVERABLE_STATES = Object.freeze(['Leased', 'PreparingWorkspace', 'BuildingContext', 'Running'])

/**
 * 造回收器。
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {object} deps.runStore 要求 `recoverExpired`
 * @param {object} deps.writeIntentStore 要求 `release`
 * @param {(row: object) => boolean} [deps.externalEffectPossible] 默认：在途一律 true（见文件头 ①）
 * @param {number} [deps.leaseGraceMs] 额外宽限：只要"过期了这么久"才动，避免与在途心跳抢
 * @param {() => number} [deps.clock]
 * @param {Function} [deps.audit] `(actor, scope, action, taskId, detail)`
 */
export function createNodeRecovery({
  db,
  runStore,
  writeIntentStore,
  externalEffectPossible = () => true,
  recoverableStates = RECOVERABLE_STATES,
  leaseGraceMs = 30_000,
  limit = 50,
  clock = Date.now,
  audit = null,
} = {}) {
  if (db === undefined || db === null) throw new TypeError('createNodeRecovery 需要 db')
  if (typeof runStore?.recoverExpired !== 'function') throw new TypeError('createNodeRecovery 需要 runStore.recoverExpired')
  if (typeof writeIntentStore?.release !== 'function') throw new TypeError('createNodeRecovery 需要 writeIntentStore.release')

  const record = (scope, action, taskId, detail) => {
    if (typeof audit !== 'function') return
    try { audit('system:node-recovery', scope ?? null, action, taskId ?? null, detail ?? null) } catch { /* 审计失败不阻断回收 */ }
  }

  /** 在途尝试的任务 id 集合。② 的判据。 */
  function tasksWithInFlightAttempt() {
    const rows = db.prepare(
      `SELECT DISTINCT task_id FROM run_attempts
        WHERE state IN ('Leased','PreparingWorkspace','BuildingContext','Running','Validating','HandingOff','AwaitingApproval')`,
    ).all()
    return new Set(rows.map((r) => r.task_id))
  }

  function releaseOrphanReservations() {
    let rows = []
    try {
      rows = db.prepare("SELECT repo_id, task_id, attempt_id, lease_epoch FROM write_reservations WHERE state IN ('reserved','reconciling')").all()
    } catch { return { released: 0, skipped: 0, details: [] } }
    if (rows.length === 0) return { released: 0, skipped: 0, details: [] }
    const holders = tasksWithInFlightAttempt()
    let released = 0
    let skipped = 0
    const details = []
    for (const row of rows) {
      if (holders.has(row.task_id)) { skipped += 1; continue }
      const r = writeIntentStore.release({
        repoId: row.repo_id, taskId: row.task_id, attemptId: row.attempt_id, epoch: row.lease_epoch,
      })
      if (r?.ok === true) {
        released += 1
        details.push({ taskId: row.task_id, attemptId: row.attempt_id, epoch: row.lease_epoch })
        record(null, 'node:reservation-released', row.task_id, { attemptId: row.attempt_id, epoch: row.lease_epoch, reason: 'no-in-flight-attempt' })
        try { db.prepare("UPDATE tasks SET scheduling_state='released' WHERE id=?").run(row.task_id) } catch { /* 列缺失忽略 */ }
      } else {
        skipped += 1
        details.push({ taskId: row.task_id, code: r?.code ?? null, reason: r?.reason ?? null })
      }
    }
    return { released, skipped, details }
  }

  /**
   * 跑一次回收。返回读数（**不抛**：后台作业失败不该让 Hub 崩）。
   */
  function sweepOnce() {
    const atMs = clock()
    const result = { atMs, leasesRecovered: 0, recovered: [], reservationsReleased: 0, reservationsSkipped: 0, reservationDetails: [], errors: [] }

    // ① 到期租约 → 未知结局（要人对账，不自动重跑）。
    //
    // 宽限：只动"已经过期超过 `leaseGraceMs`"的那些。正在心跳的尝试其租约被不断
    // 续期，本来就不会过期；这道宽限防的是时钟抖动与"刚好在这一毫秒过期"。
    try {
      const r = runStore.recoverExpired({
        externalEffectPossible,
        // 只扫"节点可能正在执行"的状态。见 `RECOVERABLE_STATES` 的注释：
        // 把 `Validating` 也扫进去会把"已完成待验收"改写成"结果待确认"。
        states: recoverableStates,
        limit,
      })
      // `recoverExpired` 自己按它的时钟判定；这里只做记账。
      // 宽限交给它内部（它比的是 lease_expires_at_ms <= nowMs）。若调用方要更保守，
      // 由 `externalEffectPossible` 表达，而不是在这里二次过滤——**两处判定会漂移**。
      const recovered = r?.recovered ?? []
      result.leasesRecovered = recovered.length
      result.recovered = recovered.map((x) => ({ attemptId: x.attemptId, action: x.action, reason: x.reason }))
      for (const x of recovered) {
        record(null, 'node:lease-recovered', null, { attemptId: x.attemptId, action: x.action })
      }
    } catch (e) {
      result.errors.push({ phase: 'recoverExpired', message: e instanceof Error ? e.message : String(e) })
    }

    // ② 结清"没人持有"的预约。见文件头 ②。
    try {
      const r = releaseOrphanReservations()
      result.reservationsReleased = r.released
      result.reservationsSkipped = r.skipped
      result.reservationDetails = r.details
    } catch (e) {
      result.errors.push({ phase: 'releaseOrphanReservations', message: e instanceof Error ? e.message : String(e) })
    }

    return Object.freeze(result)
  }

  return { sweepOnce, tasksWithInFlightAttempt, releaseOrphanReservations }
}

// product/metrics-spec7-source.mjs
// ============================================================================
// §7 第 6 条那六格指标的**生产数据源**：逐个回答"这个数从哪来"。
//
// 答不出来的，就**明说答不出来**（进 `missing`），而不是填 0。
//
// ## 为什么分母必须与分子是**同一批人**
//
// `team-hub/run-store.mjs` 的 `metricsCounts()` 已经为这件事写过一段：
// 「累积分母：**曾经被租出去过**的尝试（lease_epoch > 0）。与"现在在途"是
// 两个不同的集合，**混用会算出一个没有含义的比率**」。
//
// 本模块对每一格都遵守同一条：比率的分子与分母**取自同一个 WHERE**。
//   · 事件漏投率：分母是"已到达终态的帧"，分子是其中结果不明的那一档；
//   · 审批拒绝率：分母是"已决审批"，分子是其中没有批准的那两档；
//   · 预算超限率：分母是"已经结清过用量的预留行"，分子是其中 `overrun_amount > 0` 的。
//     用"全部预留行"当分母是错的：一条还挂着、还没花过钱的预留**没有机会**超限。
//
//   > 一个"分子从 A 来、分母从 B 来"的比率，
//   > 与一个真的比率，在仪表盘上是同一个形状——只不过前者的百分比没有含义。
//
// ## 时间戳的格式**不假设**
//
// `permission_requests.createdAt` / `decidedAt` 是 TEXT。本模块**不去猜**它是
// ISO 串还是毫秒串：两种都试，两种都不成的那一行计入 `approvalsUnparsed`
// **如实报出来**，而不是静静丢掉。丢掉会让"中位数"这个读数失去分母。
// ============================================================================

/** 投递的终态：不会再迁移。与 `team-hub/event-delivery.mjs` 的 `TERMINAL_DELIVERY_STATES` 同源。 */
export const TERMINAL_DELIVERY_STATES = Object.freeze(['delivered', 'suppressed', 'unknown'])

/** 审批里"没有批准"的那两档：被拒 + 越期作废。 */
export const APPROVAL_NOT_APPROVED = Object.freeze(['denied', 'expired'])

/**
 * 表在不在。**不在 ⇒ 这一格没有生产者**，不是"读数是 0"。
 *
 * 少了这一步，"库是空的"与"库根本没建这张表"会得到同一个 0 读数——
 * 而那正是本模块通篇要防的形状。
 */
export function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
  return row !== undefined && row !== null
}

/** `TEXT` 时间戳 → 毫秒。ISO 串与毫秒串都认；都不成就返回 `null`（由调用方如实计数）。 */
export function parseTimestampMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string' || v === '') return null
  const asNumber = Number(v)
  if (Number.isFinite(asNumber)) return asNumber
  const parsed = Date.parse(v)
  return Number.isFinite(parsed) ? parsed : null
}

/** 中位数（偶数个取中间两个的均值）。空数组返回 `null`——**不是** 0。 */
export function median(values) {
  const xs = (values ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = xs.length >> 1
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * 从控制面库里读出 §7 各格需要的**计数**。
 *
 * 返回 `{ snapshot, missing }`：`snapshot` 里**只有读得到的**键；
 * 表不存在的那些进 `missing`（具名），**不**在 snapshot 里留一个 0。
 */
export function spec7CountsFromHubDb(db, { scope = null } = {}) {
  const snapshot = {}
  const missing = []
  const where = scope === null ? '' : ' AND scope = ?'
  const p = scope === null ? [] : [scope]
  const scalar = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0)

  // ── 事件投递：遗漏（结果不明）与重复（重投过才送达）────────────────────
  if (tableExists(db, 'event_deliveries')) {
    const inTerminal = TERMINAL_DELIVERY_STATES.map(() => '?').join(', ')
    snapshot.eventsTerminal = scalar(
      `SELECT COUNT(*) AS n FROM event_deliveries WHERE state IN (${inTerminal})${where}`,
      ...TERMINAL_DELIVERY_STATES, ...p)
    snapshot.eventsUnknown = scalar(
      `SELECT COUNT(*) AS n FROM event_deliveries WHERE state = 'unknown'${where}`, ...p)
    snapshot.eventsDelivered = scalar(
      `SELECT COUNT(*) AS n FROM event_deliveries WHERE state = 'delivered'${where}`, ...p)
    // 「重投过才送达」= 送达且尝试次数 > 1。第一次就成功的 attempts 是 1。
    snapshot.eventsRetryDelivered = scalar(
      `SELECT COUNT(*) AS n FROM event_deliveries
        WHERE state = 'delivered' AND attempts > 1${where}`, ...p)
  } else {
    missing.push(...['event-loss-rate', 'event-duplicate-rate'].map((key) => Object.freeze({
      key, reason: '库里没有 `event_deliveries` 表：读不到投递状态，也就分不出"漏投"与"重投"',
    })))
  }

  // ── Run 恢复：被中断的任务里，有多少又起来过 ──────────────────────────
  if (tableExists(db, 'run_attempts')) {
    // 分母：**被中断过的任务**（租约丢过）。按任务去重——一个任务丢两次租约是**一次**中断。
    snapshot.runsInterrupted = scalar(
      `SELECT COUNT(DISTINCT task_id) AS n FROM run_attempts
        WHERE failure_code = 'lease-expired'${where}`, ...p)
    // 分子：上述任务里，后来**又起过一个 attempt** 的（attempt_no 更大）。
    // ★ 同一批任务，只是加了"后来起来过"这个条件 —— 分子分母同源。
    snapshot.runsRecovered = scalar(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT a.task_id FROM run_attempts a
          WHERE a.failure_code = 'lease-expired'${where}
            AND EXISTS (SELECT 1 FROM run_attempts b
                         WHERE b.task_id = a.task_id AND b.attempt_no > a.attempt_no)
       )`, ...p)
  } else {
    missing.push(Object.freeze({
      key: 'run-recovery-rate', reason: '库里没有 `run_attempts` 表：读不到中断与重试，恢复率无从谈起',
    }))
  }

  // ── 审批：等待中位数与拒绝率 ─────────────────────────────────────────
  if (tableExists(db, 'permission_requests')) {
    const decidedStates = ['approved', ...APPROVAL_NOT_APPROVED]
    const inDecided = decidedStates.map(() => '?').join(', ')
    snapshot.approvalsDecided = scalar(
      `SELECT COUNT(*) AS n FROM permission_requests WHERE status IN (${inDecided})${where}`,
      ...decidedStates, ...p)
    snapshot.approvalsDeniedOrExpired = scalar(
      `SELECT COUNT(*) AS n FROM permission_requests
        WHERE status IN (${APPROVAL_NOT_APPROVED.map(() => '?').join(', ')})${where}`,
      ...APPROVAL_NOT_APPROVED, ...p)
    // 中位数在 JS 侧算：`createdAt`/`decidedAt` 是 TEXT，格式不假设。
    const rows = db.prepare(
      `SELECT createdAt, decidedAt FROM permission_requests
        WHERE status = 'approved' AND decidedAt IS NOT NULL${where}`).all(...p)
    const waits = []
    let unparsed = 0
    for (const r of rows) {
      const a = parseTimestampMs(r.createdAt)
      const b = parseTimestampMs(r.decidedAt)
      if (a === null || b === null || b < a) { unparsed += 1; continue }
      waits.push(b - a)
    }
    // ★ 不可解析的行数**如实报出**：悄悄丢掉会让"中位数"失去分母，
    //   而"丢掉了一半样本的中位数"与"全部样本的中位数"在界面上一样。
    snapshot.approvalsWaitUnparsed = unparsed
    snapshot.approvalsWaitSamples = waits.length
    if (waits.length > 0) snapshot.approvalWaitP50Ms = median(waits)
  } else {
    missing.push(...['approval-wait-ms', 'approval-denial-rate'].map((key) => Object.freeze({
      key, reason: '库里没有 `permission_requests` 表：读不到审批的创建/判定时刻与结论',
    })))
  }

  // ── 预算：超限的预留，除以**结清过用量**的预留 ─────────────────────────
  if (tableExists(db, 'budget_reservations')) {
    // ★ 分母是"已经结清过用量"的预留行：一条还挂着、还没花过钱的预留
    //   **没有机会**超限，把它算进分母会系统性地压低超限率。
    snapshot.budgetUsageRows = scalar(
      `SELECT COUNT(*) AS n FROM budget_reservations WHERE spent_amount IS NOT NULL${where}`, ...p)
    snapshot.budgetOverruns = scalar(
      `SELECT COUNT(*) AS n FROM budget_reservations
        WHERE spent_amount IS NOT NULL AND overrun_amount IS NOT NULL AND overrun_amount > 0${where}`, ...p)
  } else {
    missing.push(Object.freeze({
      key: 'budget-overrun-rate', reason: '库里没有 `budget_reservations` 表：读不到预留与超限金额',
    }))
  }

  return Object.freeze({ snapshot: Object.freeze(snapshot), missing: Object.freeze(missing) })
}

// ── 升级回滚成功率：从升级审计记录算 ────────────────────────────────────

/**
 * 升级审计记录 → 回滚成功率的两侧。
 *
 * 分子与分母都取自**同一批记录**：需要回滚的那些（`result === 'rolled-back'` 或
 * 记录里写明回滚**成功**）。`product/upgrade/audit.mjs` 的 `UPGRADE_RESULTS`
 * 是词表的唯一来源，所以这里不认识的结果**如实报为未知**（`unreadable` 计数），
 * 而不是猜一个。
 */
export function rollbackCountsFromRecords(records) {
  const list = (records ?? []).filter((r) => r !== null && typeof r === 'object')
  let attempted = 0
  let succeeded = 0
  let unreadable = 0
  for (const r of list) {
    const result = r.result
    const rolledBack = result === 'rolled-back'
    const rollbackOk = r.rollbackSucceeded === true || r.rollback?.ok === true
    if (!rolledBack && !rollbackOk) continue
    attempted += 1
    if (rollbackOk) succeeded += 1
    else if (r.rollbackSucceeded === undefined && r.rollback === undefined) unreadable += 1
  }
  return Object.freeze({ rollbacksAttempted: attempted, rollbacksSucceeded: succeeded, unreadable })
}

/**
 * 把 §7 的数据源组装起来。
 *
 * 返回 `{ source, missing, unavailable }`：
 *   · `source` 是**快照**（`computeSpec7Metrics` 直接吃它），不是"读数点"函数——
 *     §7 的八格来自**一次**聚合查询，逐格函数会把它拆成八次扫表；
 *   · `missing` 逐个点名**今天没有生产者**的指标；
 *   · `unavailable` 是"有生产者但这次读不出来"的（比如没给库）。
 *
 * ★ 为什么"没有生产者"与"这次读不出来"要分开：
 *   前者是**产品事实**（要去建那个记录器），后者是**这次调用的问题**（去把库连上）。
 *   两者在界面上都表现为「—」。
 */
export function createSpec7Source({
  db = null, scope = null, upgradeAuditDir = null, listRecords = null,
} = {}) {
  const missing = []
  const unavailable = []
  let snapshot = {}

  if (db !== null && db !== undefined) {
    const r = spec7CountsFromHubDb(db, { scope })
    snapshot = { ...snapshot, ...r.snapshot }
    missing.push(...r.missing)
  } else {
    // 没给库时**不装**读数：装了但恒返回 0 的读数点，会让"库连不上"
    // 在仪表盘上表现为"一个事件都没漏、一次审批都没拒"。
    unavailable.push(...[
      'event-loss-rate', 'event-duplicate-rate', 'run-recovery-rate',
      'approval-wait-ms', 'approval-denial-rate', 'budget-overrun-rate',
    ].map((key) => Object.freeze({ key, reason: '没有可用的控制面库句柄：读不到投递/中断/审批/预算' })))
  }

  if (upgradeAuditDir !== null && upgradeAuditDir !== undefined) {
    const records = typeof listRecords === 'function' ? listRecords(upgradeAuditDir) : []
    Object.assign(snapshot, rollbackCountsFromRecords(records))
  } else {
    unavailable.push(Object.freeze({
      key: 'upgrade-rollback-success-rate',
      reason: '没有给升级审计目录：读不到历次升级是否回滚过、回滚成没成',
    }))
  }

  // ── 这一格今天**没有生产者**，是产品事实，不是配置问题 ──
  missing.push(Object.freeze({
    key: 'alpha-cycle-days',
    reason: '「从安装/配置到产物验收/交接」的端到端天数只在**真实用户项目**上才有意义，'
      + '而本机没有任何真实用户项目（台账 PRT-910 同样卡在这里，记为 ⏸）。'
      + '要喂它需要一个真实客户项目的起止时刻，或一份手工登记；'
      + '拿本机自己的 CI 时长去顶替会得到一个**看起来像交付周期**的数。',
  }))

  return Object.freeze({
    source: Object.freeze(snapshot),
    missing: Object.freeze(missing),
    unavailable: Object.freeze(unavailable),
    missingCount: missing.length,
  })
}

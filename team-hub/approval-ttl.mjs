// team-hub/approval-ttl.mjs
// ============================================================================
// PRT-615 审批 TTL、过期自动拒绝，以及与 lease/heartbeat 的交互（spec §6.4）
//
// spec 把两种退化都点名为**不可接受**，而它们的方向相反：
//
//   ① 审批等待期**停止 heartbeat** → lease 到期 → 被另一个 worker 领走 →
//      **同一个 Task 被重复执行**，直接违背 §15「已确认外部写操作的重复执行为零」。
//
//        > 一个「审批等待期间停止心跳」的暂停，
//        > 与一个「把同一件已经做过一半的外部写操作再交给第二个人做一遍」的暂停，
//        > 是同一个东西。
//
//   ② **无限续期** → 一个无人处理的审批永久占用 lease，与 §6.3「已有 lease 不延长为
//      无限期」冲突。
//
//        > 一个「无人处理的审批可以无限续租」的暂停，
//        > 与一个「永远不会被回收的租约」的暂停，是同一个东西。
//
// 本模块存在的理由是**第三条**，它比上面两条都难发现，因为两条规则**各自**看起来都对：
//
//   ③ 租约的上界与自动拒绝的时点必须是**同一个时刻**。
//
//      如果租约续到 TTL **之前**（例如续租 TTL 用的是普通 lease TTL，而审批 TTL 更长），
//      那么 lease 会先到期、被另一个 worker 领走——退化成 ①。
//      如果租约续到 TTL **之后**，那么自动拒绝已经把 Attempt 判为 `blocked` 了，
//      而 lease 还在别人手里——退化成 ② 的变体。
//
//        > 一个「自动拒绝在 TTL 触发、而租约按另一个时间续」的系统，
//        > 与一个「两块表各走各的时钟」的系统，是同一个东西——
//        > 只不过它表现出来是「任务已经进了待人工处置，可它还占着租约」。
//
// 所以：**一个截止时刻，两处共用**。`approvalDeadlineMs` 是唯一的事实来源，
// 租约续期被它封顶，自动拒绝在它触发，而两者由**同一个函数**算出。
// 一个靠"记得同时改两处"来保持一致的实现，与一个已经不一致的实现，在"下一次谁忘了"上
// 是同一个东西。
// ============================================================================

import { nfc } from '../runtime/contracts/canonical.mjs'

/** 策略版本。进审计，用来回答「这条审批是按哪一版规则过期的」。 */
export const APPROVAL_TTL_VERSION = 'legion/approval-ttl@1'

/** 默认审批 TTL：15 分钟。与 F-02 既有的 `expiresAt` 语义对齐（spec §6.4）。 */
export const APPROVAL_TTL_DEFAULT_MS = 15 * 60 * 1000

/**
 * TTL 的可接受区间。
 *
 * 下界不是 1ms 而是 1s：一个比一次网络往返还短的 TTL，与一个「所有审批都立即过期」
 * 的 TTL，在用户眼里是同一个东西。上界是 24h：TTL 的作用是给"无人值守"一个结束时刻，
 * 而以「天」为单位的等待已经不是审批而是**搁置**——那种情况应当取消任务而不是继续占租约。
 */
export const APPROVAL_TTL_MIN_MS = 1000
export const APPROVAL_TTL_MAX_MS = 24 * 60 * 60 * 1000

/** 审批行的状态。与 `approval-binding.mjs` 的 `APPROVAL_STATES` 一致（同一张表）。 */
export const OPEN_APPROVAL_STATES = Object.freeze(['pending', 'approved'])

/** 校验/处置的拒绝码。每一个都是一件不同的事。 */
export const APPROVAL_TTL_CODES = Object.freeze({
  BAD_TTL: 'approval-ttl-bad-value',
  SWEEP_BAD_INPUT: 'approval-ttl-sweep-bad-input',
})

/**
 * 解析 TTL 配置值。
 *
 * **非法值抛错，不静默回落默认值。** 一条写错的 `LEGION_APPROVAL_TTL_MS`（比如
 * `'15m'` 或 `0`）如果被静默换回默认值，表现是"配置改了但没生效"，而这类问题的
 * 排查方向完全错误——运维会去看配置有没有被加载，而不是看那个值本身。
 *
 *   > 一个「配置写错了就用默认值继续」的解析，
 *   > 与一个「配置项根本没接线」的解析，在「改了到底有没有用」上是同一个东西。
 */
export function resolveApprovalTtlMs(raw, { defaultMs = APPROVAL_TTL_DEFAULT_MS } = {}) {
  if (raw === undefined || raw === null || raw === '') return defaultMs
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n)) {
    throw new Error(`内部错误（PRT-615）：${APPROVAL_TTL_CODES.BAD_TTL}——审批 TTL 必须是整数毫秒，收到 ${JSON.stringify(raw)}`)
  }
  if (n < APPROVAL_TTL_MIN_MS || n > APPROVAL_TTL_MAX_MS) {
    throw new Error(
      `内部错误（PRT-615）：${APPROVAL_TTL_CODES.BAD_TTL}——审批 TTL 必须在 `
      + `${APPROVAL_TTL_MIN_MS}..${APPROVAL_TTL_MAX_MS} 毫秒之间，收到 ${n}。`
      + '不接受更短的值：比一次往返还短的 TTL 与「所有审批都立即过期」同形；'
      + '不接受更长的值：以「天」为单位的等待不是审批而是搁置，那种情况应当取消任务而不是继续占租约',
    )
  }
  return n
}

/**
 * 一条审批的截止时刻。**唯一的事实来源。**
 *
 * 优先读审批行自己写下的 `expiresAt`（那就是"批准/发起的那一刻 + TTL"）；
 * 只有在它缺失时才用 `createdAtMs + ttlMs` 兜底——而兜底本身也要能被看出来，
 * 所以返回值里带 `derived` 标记。
 */
export function approvalDeadlineMs({ row = null, createdAtMs = null, ttlMs = APPROVAL_TTL_DEFAULT_MS } = {}) {
  const stored = row === null ? null : Number(row.expiresAtMs ?? row.expiresAt)
  if (Number.isFinite(stored) && stored > 0) {
    return Object.freeze({ deadlineMs: stored, derived: false, source: 'row.expiresAt' })
  }
  // ⚠️ `createdAtMs` 单独传了就用它，没传就从**行里**读。
  //
  // 这个兜底不是可有可无的：`evaluateApprovalExpiry` 与 `evaluateApprovalHeartbeat`
  // 都只拿到 `row`，它们把 `row.createdAtMs` 传进来。如果这里**只**认单独的那个参数，
  // 那么两条调用路径对同一行会得出不同结论——一边算得出截止时刻、一边算不出。
  //
  //   > 一个「两条调用路径对同一行得出不同截止时刻」的算法，
  //   > 与一个「两块表各走各的时钟」的系统，是同一个东西。
  const raw = createdAtMs ?? row?.createdAtMs ?? null
  // ⚠️ `Number(null)` 是 **0**，而 0 是有限的——不显式排掉 `null`/`''`/空白的话，
  // 一个"没有 createdAt"的行会得到一个 **1970 年**的截止时刻，于是它被判成"早就过期"。
  // 方向是 fail-closed（安全），但**理由是错的**：日志会写 `deadline-passed`
  // 而真相是 `no-deadline`，值班的人会去问用户"你为什么不响应"。
  const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')
  const created = blank ? NaN : Number(raw)
  if (!Number.isFinite(created)) {
    return Object.freeze({ deadlineMs: null, derived: true, source: 'unavailable' })
  }
  return Object.freeze({ deadlineMs: created + resolveApprovalTtlMs(ttlMs), derived: true, source: 'createdAt+ttl' })
}

/**
 * 审批等待期的租约续期上界：**续到截止时刻，绝不超过它**。
 *
 * 返回的是"这一次 heartbeat 允许把租约续多长"。worker 请求一个更短的 TTL 时尊重它
 * （不延长），请求更长时**截断**。
 *
 * 已经越过截止时刻时返回 `0`——调用方据此**拒绝续期**而不是续一个 0 长度的租约。
 * 返 0 而不是返负数或 null：三种"没有可续时间"的表达里，只有 0 能被直接拿去比较，
 * 而一个 null 会被 `??` 兜底成默认值——那正是本模块要防的"偷偷续上"。
 */
export function leaseRenewalBoundMs({ nowMs, deadlineMs }) {
  const now = Number(nowMs)
  const deadline = Number(deadlineMs)
  if (!Number.isFinite(now) || !Number.isFinite(deadline)) return 0
  return Math.max(0, deadline - now)
}

/**
 * 一次审批等待期 heartbeat 的完整结论。
 *
 * `action` 只有两种，而且两种都必须被调用方区别对待：
 *   · `renew`  —— 把租约续到 `expiresAtMs`（它必然 <= deadline）
 *   · `expire` —— **不要续**，这条审批已经到点了，交给自动拒绝去处置
 *
 * 刻意不返回"要不要顺便把审批标过期"的布尔：那会让 heartbeat 与 sweep 两条路径
 * 各自去改同一行状态，于是两处 CAS 竞争同一行——`renew` 路径**只续租、不判状态**。
 */
export function evaluateApprovalHeartbeat({ row = null, nowMs, requestedTtlMs = null, ttlMs = APPROVAL_TTL_DEFAULT_MS } = {}) {
  const { deadlineMs, derived, source } = approvalDeadlineMs({ row, ttlMs })
  const now = Number(nowMs)
  if (!Number.isFinite(deadlineMs)) {
    // 连截止时刻都算不出来（没有 expiresAt 也没有 createdAt）。
    // **不续期**：一个不知道何时该结束的等待，续下去就是无限期。
    return Object.freeze({
      action: 'expire', reason: 'no-deadline', deadlineMs: null, derived, source,
      expiresAtMs: null, boundMs: 0,
    })
  }
  if (now >= deadlineMs) {
    return Object.freeze({
      action: 'expire', reason: 'deadline-passed', deadlineMs, derived, source,
      expiresAtMs: null, boundMs: 0,
    })
  }
  const bound = leaseRenewalBoundMs({ nowMs: now, deadlineMs })
  const wanted = requestedTtlMs === null || requestedTtlMs === undefined
    ? bound
    : Math.min(bound, resolveApprovalTtlMs(requestedTtlMs, { defaultMs: bound }))
  return Object.freeze({
    action: 'renew', reason: null, deadlineMs, derived, source,
    expiresAtMs: now + wanted, boundMs: wanted,
  })
}

/**
 * 一次审批是否应该被自动拒绝。
 *
 * `reason` 把两种"到点了"分开：
 *   · `deadline-passed` —— 正常的 TTL 到期
 *   · `no-deadline`     —— 这一行算不出截止时刻（数据问题）
 *
 * 分成两个理由而不是一个"过期"：它们的处置动作相同，但**排查方向相反**。
 * 前者是"用户没在 15 分钟内回应"，后者是"这一行缺字段"，值班的人看到"过期"
 * 会去问用户，而真正该做的是查那一行怎么写出来的。
 */
export function evaluateApprovalExpiry({ row = null, nowMs, ttlMs = APPROVAL_TTL_DEFAULT_MS } = {}) {
  const status = row === null ? null : String(row.status ?? '')
  if (row === null || row === undefined) {
    return Object.freeze({ expired: false, reason: 'no-row', status, deadlineMs: null })
  }
  if (!OPEN_APPROVAL_STATES.includes(status)) {
    // `consumed` / `expired` / `denied` 都已经结清了。
    // 对它们再判一次过期，会把"这次审批用户拒绝了"改写成"过期了"——
    // 两条都进终态，但用户在界面上看到的原因不一样。
    return Object.freeze({ expired: false, reason: `status-${status}`, status, deadlineMs: null })
  }
  const { deadlineMs, derived, source } = approvalDeadlineMs({ row, ttlMs })
  if (!Number.isFinite(deadlineMs)) {
    // 算不出截止时刻的**开放**审批：这是数据问题，但它的方向是"永远不会过期"，
    // 也就是"一个无人处理的审批可以无限占着租约"——所以它必须过期，理由单独记。
    return Object.freeze({ expired: true, reason: 'no-deadline', status, deadlineMs: null, derived, source })
  }
  if (Number(nowMs) >= deadlineMs) {
    return Object.freeze({ expired: true, reason: 'deadline-passed', status, deadlineMs, derived, source })
  }
  return Object.freeze({ expired: false, reason: 'before-deadline', status, deadlineMs, derived, source })
}

// ---------------------------------------------------------------------------
// 加载时自检：租约上界与自动拒绝时点必须落在**同一个时刻**。
//
// 这是本模块存在的理由（见文件头 ③）。一个"两处各自算、靠注释保持一致"的实现，
// 与一个已经不一致的实现，在"下一次谁忘了改另一处"上是同一个东西。
//
// 刻意**不**导出一个布尔 `ok`——`ok: true` 是随手就能写出来的字面量。
// 导出的是**算出来的那一对时刻**：想伪造它，就得让 `evaluateApprovalHeartbeat`
// 真的续出一个晚于截止时刻的租约。
// ---------------------------------------------------------------------------

const TTL_SAMPLE_ROW = Object.freeze({ status: 'pending', expiresAtMs: 1_800_000_000_000 })
const TTL_SAMPLE_NOW = 1_799_999_000_000

/**
 * 自检：租约的上界与自动拒绝的时点必须落在**同一个时刻**。
 *
 * 做成带参数的函数，是为了让用例能喂一对**故意漂移**的输入进来验它真的会拦。
 * 一个只能对"当前恰好正确的那份输入"作答的校验，与一个恒真的校验，同形——
 * 只读模块级的两个值然后比一下，那条 `if` 永远只在"已经出事了"的时候才跑。
 *
 * `beat` 与 `expiry` 可注入，正是为了让"两份时钟各走各的"这件事可以被**构造出来**：
 * 否则 `beat.expiresAtMs > beat.deadlineMs` 在正确的实现上恒为假，
 * 就是一段**不可观测的死代码**——而一段永远不会触发断言，
 * 与一段不存在的断言，在"它到底拦不拦得住"上是同一个东西。
 */
export function assertDeadlineShared({
  nowMs = TTL_SAMPLE_NOW,
  row = TTL_SAMPLE_ROW,
  beat = evaluateApprovalHeartbeat({ row, nowMs }),
  expiry = evaluateApprovalExpiry({ row, nowMs }),
} = {}) {
  if (beat.action !== 'renew') {
    throw new Error(`内部错误（PRT-615）：截止时刻之前的心跳被判成 ${beat.action}（理由 ${beat.reason}）`)
  }
  if (expiry.expired) {
    throw new Error(`内部错误（PRT-615）：截止时刻之前的审批被判成已过期（理由 ${expiry.reason}）`)
  }
  // ★ 注入的截止时刻必须与**从行里推导出来的**一致。
  //
  // 没有这一条时，`beat.expiresAtMs > beat.deadlineMs` 是可以被绕过的：下面的
  // `afterBeat` 是**从 `row` 重新算**的，不是从注入的 `beat` 推出来的——
  // 于是只要伪造一个 `deadlineMs`，那道"两份时钟各走各的"的断言就被架空了。
  //
  //   > 一个「自称在检查两份时钟是否一致、而真正的比较用的是第三方时钟」的校验，
  //   > 与一个「从不检查时钟一致性」的校验，是同一个东西。
  const derivedDeadline = approvalDeadlineMs({ row, ttlMs: APPROVAL_TTL_DEFAULT_MS }).deadlineMs
  if (beat.deadlineMs !== derivedDeadline) {
    throw new Error(
      `内部错误（PRT-615）：心跳报告的截止时刻 ${beat.deadlineMs} 与行里推导出的 ${derivedDeadline} 不一致——`
      + '两块表各走各的时钟，最终会出现「续着租约的已过期审批」或「没续租约的未过期审批」',
    )
  }
  if (beat.expiresAtMs > beat.deadlineMs) {
    throw new Error(
      `内部错误（PRT-615）：租约被续到了 ${beat.expiresAtMs}，晚于审批截止时刻 ${beat.deadlineMs}——`
      + '自动拒绝会先把 Attempt 判为 blocked，而租约还在手上（spec §6.3/§6.4）',
    )
  }
  // 越过截止时刻之后，两条路径必须**同时**转向：心跳拒绝续期、审批判为过期。
  const afterBeat = evaluateApprovalHeartbeat({ row, nowMs: beat.deadlineMs })
  const afterExpiry = evaluateApprovalExpiry({ row, nowMs: beat.deadlineMs })
  if (afterBeat.action !== 'expire' || !afterExpiry.expired) {
    throw new Error(
      `内部错误（PRT-615）：越过截止时刻后心跳=${afterBeat.action}、过期=${afterExpiry.expired}——`
      + '两者必须在同一个时刻转向，否则会出现「续着租约的已过期审批」或'
      + '「没续租约的未过期审批」（后者会被另一个 worker 领走，重复执行）',
    )
  }
  return Object.freeze({
    nowMs,
    deadlineMs: beat.deadlineMs,
    leaseExpiresAtMs: beat.expiresAtMs,
    leaseWithinDeadline: beat.expiresAtMs <= beat.deadlineMs,
    turnAtMs: beat.deadlineMs,
    beforeTurn: Object.freeze({ heartbeat: beat.action, expired: expiry.expired }),
    atTurn: Object.freeze({ heartbeat: afterBeat.action, expired: afterExpiry.expired }),
  })
}

export const APPROVAL_TTL_CHECKED = Object.freeze({
  version: APPROVAL_TTL_VERSION,
  defaultTtlMs: APPROVAL_TTL_DEFAULT_MS,
  minMs: APPROVAL_TTL_MIN_MS,
  maxMs: APPROVAL_TTL_MAX_MS,
  ...assertDeadlineShared(),
})

/**
 * 顺序无关的审计文本。
 *
 * 审计里出现的**用户可见字符串**一律走这里：`nfc()` 与应用层一致，
 * 否则两条看起来相同的记录会因为组合字符而在按字符串分组时分成两组。
 */
export function auditReasonText(text) {
  return nfc(String(text ?? '')).trim()
}

/** 把一条开放审批标记为过期时的结果。 */
export const EXPIRE_OUTCOMES = Object.freeze({
  EXPIRED: 'expired',
  LOST_RACE: 'lost-race',
})

/** 开放状态的字面量，供 SQL 的 `IN (...)` 用。**从 `OPEN_APPROVAL_STATES` 生成**，
 *  不手写第二份——一份必须靠人记得同步的状态清单，与一份迟早会不同步的清单，
 *  在「新的开放状态能不能被自动拒绝」上是同一个东西。 */
export const OPEN_APPROVAL_STATUS_SQL = OPEN_APPROVAL_STATES.map((s) => `'${s}'`).join(',')

/**
 * 把一条**开放**审批原子地标记为过期。返回 `{outcome, changes}`。
 *
 * `WHERE` 里带状态条件不是多余的：一次到期扫描与用户点击"批准"可能**并发**发生。
 * 不带条件时，扫描会把用户刚刚写下的 `approved` 改写成 `expired`——
 * 两条都进终态，但用户在界面上看到的原因完全不同（"我批了" vs "它过期了"）。
 *
 *   > 一个「与用户点击并发时会把用户的批准改写成过期」的扫描，
 *   > 与一个「随机丢弃用户决定」的扫描，是同一个东西。
 *
 * **单独导出**是为了让"没抢到"这条路径可以被**真的走到**：它只在并发时发生，
 * 而一个只能靠时序触发的分支，与一个不存在的分支，在"它到底拦不拦得住"上同形。
 */
export function markApprovalExpired({ db, requestId, reason, table = 'permission_requests' }) {
  const res = db
    .prepare(`UPDATE ${table} SET status='expired', reason=? WHERE requestId=? AND status IN (${OPEN_APPROVAL_STATUS_SQL})`)
    .run(reason, requestId)
  const changes = Number(res.changes)
  return Object.freeze({
    outcome: changes === 1 ? EXPIRE_OUTCOMES.EXPIRED : EXPIRE_OUTCOMES.LOST_RACE,
    changes,
  })
}

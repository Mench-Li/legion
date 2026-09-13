// team-hub/approval-port.mjs
// ============================================================================
// PRT-212 的**生产者半边**：把一次工具调用的投影，真的送进 team-hub 的审批箱，
// 并把它带回来的人的决定翻成 DSH `approval answerer` 要的那个闭集里的一个值。
//
// ## 缺的是什么
//
// `runtime/dsh-composition/enforcement.mjs` 的 `createApprovalAnswerer` 早已写好：
// 它有阶段期限、有 `unavailable` vs `rejected` 的区分、有闭集外的值不当作放行。
// `runtime/dsh-composition/tool-request.mjs` 也早已把它接在 `requestApproval` 端口后面。
// `team-hub/tool-request-bridge.mjs` 甚至已经把投影翻成了完整的 F-02 授权主体。
//
// 三块都在，**而中间那条线不存在**：`requestApproval` 在全仓库只有两种取值——
// `null`（默认），或测试里的 `async () => 'rejected'`。于是：
//
//   > 一个"answerer 写得对、端口处处留好、而从来没有人填过它"的审批，
//   > 与一个"根本没有审批"的审批，在运行时的表现是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 这个模块就是那条线。
//
// ## 它做的四件事
//
//   ① `legionOperationOf(projection)` 造出**完整**的 F-02 主体（复用桥，不另算一份）；
//   ② `POST /api/permissions/check` —— 要么当场判定，要么落一条待批准行；
//   ③ 待批准时轮询 `GET /api/permissions/inbox`，直到有结局或到期；
//   ④ 把结局翻成 `APPROVAL_OUTCOMES` 里的一个值，**并留下凭据**
//      （`requestId` + `bindingHash`），因为批准之后还有"消费"那一步。
//
// ---------------------------------------------------------------------------
// ## 三个不显眼但必须做对的判断
// ---------------------------------------------------------------------------
//
// ### 一、`onConnected` 只能在 hub **真的答了**之后自报
//
// 审批箱是**两阶段**的（`ENFORCEMENT_PHASES = ['connect','response']`）：
// 连不上是故障，连上了而没人批是"还在等"。两者的排查方向完全相反。
//
// 如果一进函数就自报已连接，那么一次**连不上**会被记成"响应阶段超时"——
// 值班的人会去翻审批箱有没有积压，而真正的问题是 hub 根本没起来。
//
//   > 一个"一进门就自报已连接"的审批端口，
//   > 与一个"永远连不上、但每次都报告响应阶段超时"的端口，是同一个东西。
//
// 所以自报点**只有一个**：`check` 返回了合法响应之后。
//
// ### 二、**不在审批箱里的那一行**，不等于"还没人批"
//
// `checkPermission` 是在 `withTx(...)` 里写那一行的，**返回之前就已经提交**。
// 所以 `check` 一回来，那一行就必须在库里。
//
// 查不到只有几种可能：请求打到了**另一个 hub 实例**、行被删了、空间过滤把它排除了。
// 这几种都不是"继续等人"，而是**接线/一致性缺陷**。
//
//   > 一个"查不到就安静地继续轮询到超时"的实现，
//   > 与一个"这份申请根本不存在"的实现，在屏幕上都是"等了一会儿然后超时"——
//   > 只不过前者的理由是"没人处理"，后者是"你查错了地方"。
//
// 所以查不到就**当场**报 `ROW_VANISHED`。
//
// 另外：查自己的行时**不带 `scope` 过滤**（`/api/permissions/inbox` 支持按空间过滤，
// 而这里刻意不用）。带过滤就把"空间参数传错了"变成了"这行不存在"，
// 两个完全不同的缺陷会长成同一条日志。
//
// ### 三、`approved` 有两种，**不能长得一样**
//
// hub 的 `checkPermission` 在两种情况下都返回 `status: 'approved'`：
//   · 策略直接放行（`allow-by-policy` / `allow-for-task`）—— **没有人类参与**，
//     也不会落任何待批准行；
//   · 人批了（`pending` 那一行变成 `approved`）—— 有 `decidedBy`。
//
// 两者对"谁批准了这次写入"是**两个答案**。凭据里必须带上 `mode` 与 `decidedBy`，
// 否则审计看到的都是"已批准"，而其中一个从来没有出现过人。
//
// 同理，到期（`expired`）**不是** `rejected`：那是"没人回答"，不是"人说不"。
// `enforcement.mjs` 的文件头已经把这条纪律写死了，这里只是照着执行。
// ============================================================================

import { legionOperationOf, BRIDGE_CODES } from './tool-request-bridge.mjs'

/** 改动搬运/轮询规则时递增。 */
export const APPROVAL_PORT_VERSION = 1

export const APPROVAL_PORT_CODES = Object.freeze({
  /** 端口缺 `read`/`write` 其中之一。 */
  BAD_WIRING: 'APPROVAL_PORT_BAD_WIRING',
  /** 轮询间隔不是正整数。 */
  BAD_POLL_INTERVAL: 'APPROVAL_PORT_BAD_POLL_INTERVAL',
  /** 投影造不出合法主体（透传桥的码，便于定位到底是哪一层缺字段）。 */
  BAD_OPERATION: 'APPROVAL_PORT_BAD_OPERATION',
  /** `POST /api/permissions/check` 失败。 */
  CHECK_FAILED: 'APPROVAL_PORT_CHECK_FAILED',
  /** `GET /api/permissions/inbox` 失败。 */
  INBOX_FAILED: 'APPROVAL_PORT_INBOX_FAILED',
  /** `check` 返回了闭集外的 status。 */
  UNKNOWN_STATUS: 'APPROVAL_PORT_UNKNOWN_STATUS',
  /** `check` 说待批准，却没给 `requestId`——拿不到它就永远消费不了。 */
  REQUEST_ID_MISSING: 'APPROVAL_PORT_REQUEST_ID_MISSING',
  /** 说好待批准的行，在审批箱里查不到（见文件头 §二）。 */
  ROW_VANISHED: 'APPROVAL_PORT_ROW_VANISHED',
  /** 审批箱里的行不是对象 / 没有可用的 status。 */
  ROW_MALFORMED: 'APPROVAL_PORT_ROW_MALFORMED',
  /** 到期了还是没人处理。 */
  TTL_NOT_ANSWERED: 'APPROVAL_PORT_TTL_NOT_ANSWERED',
  /** 调用方主动撤回。 */
  ABORTED: 'APPROVAL_PORT_ABORTED',
})

/** 端口自己的失败一律是**故障**，不是"人说不"——所以默认结局全是 `unavailable`。 */
export function approvalPortError(code, message, extra = {}) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  Object.assign(err, extra)
  return err
}

/**
 * hub 的审批状态 → `APPROVAL_OUTCOMES` 里的一个值。
 *
 * 这张表是**唯一的**映射处。第二处映射与"没有映射"是同一个东西：
 * 两处会在某一天给出不同的答案，而那时没人知道哪一处是权威。
 *
 * ⚠️ `approved` **不在这张表里** —— 见下面 `outcomeOfRow` 的说明。
 * 两个来源不同的 `approved` 必须由**行的凭据**来分，不能由状态串来分。
 */
const STATUS_MAP = Object.freeze({
  // 策略拒绝 / 人拒绝：都是**决定**。
  denied: Object.freeze({ outcome: 'rejected', human: false, reason: 'hub 策略拒绝' }),
  // 到期：**没人回答**，不是"人说不"。
  expired: Object.freeze({ outcome: 'unavailable', human: false, reason: '审批到期，始终没有人处理' }),
  // 已消费：这张票已经用掉了。
  consumed: Object.freeze({ outcome: 'allowed-once', human: true, reason: '这条批准已被消费' }),
})

export const APPROVAL_STATUS_MAP = STATUS_MAP

/** 待批准行的三个终局：`pending` 之外的一切。 */
export function statusOf(row) {
  if (row === null || typeof row !== 'object') return null
  const s = row.status
  return typeof s === 'string' && s !== '' ? s : null
}

/** 这一行有没有**决定者**（谁批的/谁拒的）。空串与 null 都算没有。 */
export function deciderOf(row) {
  const v = row?.decidedBy ?? row?.decided_by ?? null
  return v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()
}

/**
 * 一条审批行 → 结局 + 理由 + 是否有人参与。
 *
 * 未知的 status **不当作放行**，也不当作拒绝：它是"这个端口现在不可信"。
 *
 * ## ★ 为什么 `approved` 必须看 `decidedBy`，而不能只看状态串
 *
 * hub 有**两个**都叫 `approved` 的东西：
 *
 *   · `checkPermission` 当场按策略放行（`allow-by-policy` / `allow-for-task`）——
 *     **不落任何行**，没有人类参与；
 *   · `decidePermission` 把一条待批准行改成 `approved` —— 有 `decidedBy`/`decidedAt`。
 *
 * 第一版把 `status: 'approved'` 一律映射成"策略直接放行、human:false"。
 * 探针立刻打出一张**自相矛盾**的凭据：
 *
 *     outcome=allowed-once  human=false  reason="hub 策略直接放行"  decidedBy="general"
 *
 * ——它一边说"没有人类参与"，一边记着是谁批的。
 *
 *   > 一个"报告说没有人参与、却带着决定者"的凭据，
 *   > 与一个"报告说某人批准了这次写入"的凭据，对审计是同一个东西——
 *   > 只不过前者会让一次**人工批准的越权操作**看起来像一次策略放行，
 *   > 于是没有人需要为它负责。
 *
 * 所以判据是**行自己的凭据**：有 `decidedBy` 就是有人批的。
 */
export function outcomeOfRow(row) {
  const status = statusOf(row)
  if (status === null) {
    return Object.freeze({
      outcome: 'unavailable', human: false,
      code: APPROVAL_PORT_CODES.ROW_MALFORMED,
      reason: '审批箱返回的行没有 status',
    })
  }
  if (status === 'pending') return null // 不是结局

  const by = deciderOf(row)

  // ★ `approved` 两分：有决定者 = 人批的；没有 = 策略放行。
  if (status === 'approved') {
    return Object.freeze({
      outcome: 'allowed-once',
      human: by !== null,
      code: null,
      reason: by !== null ? `已批准（by=${by}）` : 'hub 策略直接放行（没有任何人参与）',
      decidedBy: by,
      decisionReason: row.reason == null ? '' : String(row.reason),
    })
  }

  const m = STATUS_MAP[status]
  if (m === undefined) {
    return Object.freeze({
      outcome: 'unavailable', human: false,
      code: APPROVAL_PORT_CODES.UNKNOWN_STATUS,
      reason: `审批箱返回了未知状态 ${JSON.stringify(status)}——不能当作放行，也不能当作拒绝`,
    })
  }
  // ★ `denied` 同理两分：有决定者 = 人拒的；没有 = 策略拒的。
  const human = status === 'denied' ? by !== null : m.human
  const reason = human && status === 'denied' ? `已拒绝（by=${by}）` : m.reason
  return Object.freeze({
    outcome: m.outcome,
    human,
    code: null,
    reason,
    decidedBy: by,
    decisionReason: row.reason == null ? '' : String(row.reason),
  })
}


/** 默认轮询间隔。够快让人感觉是实时的，又不至于把 hub 打满。 */
export const DEFAULT_POLL_INTERVAL_MS = 250

/** 默认的响应阶段预算，与 `createApprovalAnswerer` 的默认值一致。 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 造一个**接在 team-hub 审批箱上**的 `requestApproval` 端口。
 *
 * @param {object} cfg
 * @param {{read: (path: string) => Promise<object>, write: (path: string, body: object) => Promise<object>}} cfg.hub
 *   两个端口都必需。**不给默认值**：一个不存在的 hub 客户端如果被兜成"都放行"，
 *   那是把"没接线"变成了"批准"。
 * @param {{scope: string, actor: string, action?: string, taskId?: string|null,
 *          unattended?: boolean, metadata?: object}} cfg.caller
 *   Legion 侧的身份（投影里没有）。
 * @param {string|null} [cfg.attemptId] 哪个 Attempt 在等这份审批（PRT-616）。
 * @param {number} [cfg.pollIntervalMs]
 * @param {(ms: number) => Promise<void>} [cfg.sleep] 注入出来是为了让用例不必真的等。
 * @param {() => number} [cfg.now]
 * @param {(e: object) => void} [cfg.onPoll] 每次轮询后回调（观测用，不参与判定）。
 */
export function createHubApprovalPort({
  hub,
  caller = {},
  attemptId = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = defaultSleep,
  now = () => Date.now(),
  onPoll = null,
} = {}) {
  if (hub === null || typeof hub !== 'object'
    || typeof hub.read !== 'function' || typeof hub.write !== 'function') {
    throw approvalPortError(
      APPROVAL_PORT_CODES.BAD_WIRING,
      'createHubApprovalPort 需要 { read, write } 两个都有的 hub 客户端。' +
      '故意不给兜底：一个"没有 hub 也能用"的审批端口只能靠编或者靠放行，而两者都是静默降级',
    )
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw approvalPortError(APPROVAL_PORT_CODES.BAD_POLL_INTERVAL,
      `pollIntervalMs 必须是正整数，收到 ${JSON.stringify(pollIntervalMs)}`)
  }

  /** 每次交换留下的凭据。按 callId 存，最后一个也单独留一份。 */
  const tickets = new Map()
  let lastTicket = null

  const record = (ticket) => {
    if (ticket.callId !== null && ticket.callId !== undefined) tickets.set(ticket.callId, ticket)
    lastTicket = ticket
    return ticket
  }

  /**
   * 送一次申请，并等到结局。
   *
   * 返回值是 `APPROVAL_OUTCOMES` 里的一个字符串——`tool-request.mjs` 的
   * `requestApproval` 端口就长这样。**但结局不是全部信息**：请用
   * `ticketFor(callId)` / `lastTicket` 拿 `requestId` 与 `bindingHash`，
   * 否则批准之后那一步"消费"没有凭据可用。
   */
  async function requestApproval(projection, {
    onConnected = null, signal = null, responseTimeoutMs = null,
  } = {}) {
    const startedAt = now()
    // ① 造主体。桥会 fail closed（缺 callId / 缺 toolName / 携带哈希漂移都抛），
    //    而我们**不吞**它的码——定位时要能一眼看出是哪一层缺字段。
    let operation
    try {
      const built = legionOperationOf(projection, caller)
      operation = built.operation
    } catch (err) {
      return finish({
        projection, startedAt, outcome: 'unavailable',
        code: err?.code ?? BRIDGE_CODES.PROJECTION_MISSING,
        reason: `主体造不出来：${err?.message ?? String(err)}`,
      })
    }

    const callId = operation.callId
    const base = { callId, toolName: operation.toolName, target: operation.target, action: operation.action }

    if (signal?.aborted === true) {
      return finish({
        ...base, projection, startedAt, outcome: 'cancelled',
        code: APPROVAL_PORT_CODES.ABORTED, reason: '调用方在送审之前就撤回了',
      })
    }

    // ② 送审。**成功后**才自报已连接（见文件头 §一）。
    //
    // ★ 两条实测出来的形状（起真 hub 才知道，读代码看不出来）：
    //
    //   · `by` **必须带**。`handleWrite` 的第一件事是 `requireMember(body)`，
    //     缺了它整个请求 400「缺少操作者身份 by」——于是**每一次审批都送不出去**，
    //     而端口会把它记成"审批箱不可达"。那是把一次**参数缺失**报成了**基础设施故障**，
    //     排查方向完全相反。
    //   · 响应的判定体在 **`task`** 下面（`{ok:true, task:result}`），不在顶层。
    //     从顶层读 `status` 会永远读到 `undefined` → `UNKNOWN_STATUS` →
    //     "这个端口现在不可信"，而实际上审批箱答得好好的。
    //
    //     > 一个"从错误的层级读判定"的端口，
    //     > 与一个"审批箱每次都返回无法理解的东西"的端口，是同一个东西——
    //     > 只不过前者其实拿到了完整的答案。
    let envelope
    try {
      envelope = await hub.write('/api/permissions/check', {
        ...operation,
        // `handleWrite` 用它做审计主体。与 operation.actor 同源，不另编一个值。
        by: operation.actor,
        ...(attemptId === null ? {} : { attemptId }),
      })
    } catch (err) {
      return finish({
        ...base, projection, startedAt, outcome: 'unavailable',
        code: APPROVAL_PORT_CODES.CHECK_FAILED,
        reason: `送审失败（审批箱不可达）：${err?.message ?? String(err)}`,
      })
    }

    // ★ 自报点。到这一行才说明"审批箱答了话"。
    onConnected?.()

    const decision = envelope !== null && typeof envelope === 'object' && envelope.task !== undefined
      ? envelope.task
      : envelope

    const status = statusOf(decision)
    if (status === null) {
      return finish({
        ...base, projection, startedAt, outcome: 'unavailable',
        code: APPROVAL_PORT_CODES.UNKNOWN_STATUS,
        reason: '审批箱的 check 响应没有 status',
      })
    }

    if (status !== 'pending') {
      // 当场就有结局：策略放行或策略拒绝，没有人类参与，也没有待批准行。
      const got = outcomeOfRow({ ...decision, status })
      return finish({ ...base, projection, startedAt, ...got, requestId: null, bindingHash: decision.bindingHash ?? null })
    }

    // ③ 待批准。拿不到 requestId 就没有"消费那一张票"的凭据。
    const requestId = decision.requestId == null ? null : String(decision.requestId).trim() || null
    if (requestId === null) {
      return finish({
        ...base, projection, startedAt, outcome: 'unavailable',
        code: APPROVAL_PORT_CODES.REQUEST_ID_MISSING,
        reason: '审批箱说需要批准却没给 requestId——没有它，批准之后那一步无法消费这张票，' +
          '调用方只会在执行时被拒（"我明明批了，它说操作不匹配"）',
      })
    }

    const ticket = { ...base, requestId, bindingHash: decision.bindingHash ?? null }

    // ④ 轮询。预算**优先用调用方给的** `responseTimeoutMs`（answerer 算过它的窗口），
    //    缺了才落到本模块的默认值。
    //
    //    这一层预算不是装饰：轮询循环如果比 answerer 的期限活得久，那么
    //    「Run 的期限约束」就只剩下 answerer 那一道，而这里的每 250ms 一次
    //    的 inbox 请求会在 Run 早已被判超时之后继续打 hub。
    //
    //       > 一个"自己有期限、却不等调用方期限"的轮询，
    //       > 与一个"把 Run 的期限交给下游模块自己猜"的轮询，是同一个东西——
    //       > 只不过前者的注释说它考虑过期限。
    const requestedBudget = Number(responseTimeoutMs)
    const budgetMs = Number.isFinite(requestedBudget) && requestedBudget > 0
      ? requestedBudget
      : DEFAULT_RESPONSE_TIMEOUT_MS
    const deadlineMs = startedAt + budgetMs

    for (;;) {
      if (signal?.aborted === true) {
        return finish({ ...ticket, projection, startedAt, outcome: 'cancelled', code: APPROVAL_PORT_CODES.ABORTED, reason: '调用方在等待期间撤回了' })
      }
      if (now() >= deadlineMs) {
        return finish({
          ...ticket, projection, startedAt, outcome: 'unavailable',
          code: APPROVAL_PORT_CODES.TTL_NOT_ANSWERED,
          reason: `等满了 ${budgetMs}ms 仍然没有人处理这份申请（申请本身是好的，只是没人批）`,
        })
      }

      let inbox
      try {
        // ★ 刻意**不带** `scope` 过滤：把"空间参数传错"与"这行不存在"分开。
        inbox = await hub.read('/api/permissions/inbox')
      } catch (err) {
        return finish({
          ...ticket, projection, startedAt, outcome: 'unavailable',
          code: APPROVAL_PORT_CODES.INBOX_FAILED,
          reason: `读审批箱失败：${err?.message ?? String(err)}`,
        })
      }

      const rows = Array.isArray(inbox?.requests) ? inbox.requests : null
      if (rows === null) {
        return finish({
          ...ticket, projection, startedAt, outcome: 'unavailable',
          code: APPROVAL_PORT_CODES.INBOX_FAILED,
          reason: '审批箱的 inbox 响应里没有 requests 数组',
        })
      }
      const row = rows.find((r) => r !== null && typeof r === 'object' && String(r.requestId) === requestId)
      onPoll?.({ requestId, found: row !== undefined, atMs: now() })

      if (row === undefined) {
        // ★ 见文件头 §二。这是**接线/一致性缺陷**，不是"还在等"。
        return finish({
          ...ticket, projection, startedAt, outcome: 'unavailable',
          code: APPROVAL_PORT_CODES.ROW_VANISHED,
          reason: `刚创建（或复用）的审批行 ${requestId} 在审批箱里查不到。` +
            'check 是提交之后才返回的，所以这一行本该在——查不到说明这次请求打到了别的 hub 实例、' +
            '行被清理了，或者查询方式不对。**不是"还没人批"**，所以不继续等',
        })
      }

      const got = outcomeOfRow(row)
      if (got !== null) {
        return finish({
          ...ticket, projection, startedAt, ...got,
          bindingHash: row.bindingHash ?? ticket.bindingHash,
        })
      }

      await sleep(pollIntervalMs)
    }
  }

  function finish(t) {
    const ticket = record(Object.freeze({
      version: APPROVAL_PORT_VERSION,
      callId: t.callId ?? null,
      toolName: t.toolName ?? null,
      action: t.action ?? null,
      target: t.target ?? null,
      requestId: t.requestId ?? null,
      bindingHash: t.bindingHash ?? null,
      outcome: t.outcome,
      human: t.human === true,
      code: t.code ?? null,
      reason: t.reason ?? null,
      decidedBy: t.decidedBy ?? null,
      decisionReason: t.decisionReason ?? '',
      elapsedMs: now() - t.startedAt,
    }))
    return ticket.outcome
  }

  return Object.freeze({
    /** 给 `createEnforcementBridge({ requestApproval })` 用的端口。 */
    requestApproval,
    /** 某次调用留下的凭据（含 `requestId`/`bindingHash`）。 */
    ticketFor: (callId) => tickets.get(callId) ?? null,
    /** 全部凭据的快照。 */
    tickets: () => Object.freeze([...tickets.values()]),
    /** 最近一次交换的凭据。 */
    lastTicket: () => lastTicket,
  })
}

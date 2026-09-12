// orchestrator/state-machine/transitions.mjs
// ============================================================================
// 持久化运行状态机：迁移表、守卫与 CAS 应用（PRT-301，spec §6.4）
//
// 纯模块。三条设计决定，每一条都对应一种**不会报错的**故障：
//
// ① **迁移必须声明来源（CAS）。** `applyTransition` 要求调用方给出它**以为**的当前状态，
//    与真实状态不符时返回 `STALE_STATE` 而不是照写。没有这一条，一个 lease 已过期、
//    以为自己还在跑的 worker 可以在新 worker 把任务做完之后把状态写回 `Running`——
//    用户看到「已完成」又变回「进行中」，而所有日志都正常。
//
// ② **不许跳状态。** `Queued → Running` 必须非法。跳过 `PreparingWorkspace` /
//    `BuildingContext` 的执行没有工作区、没有上下文快照，产物会落在错误目录、
//    审计里没有来源哈希，而它在状态层面与正常执行**完全一致**。
//
// ③ **`UnknownOutcome` 不得回到队列。** 这是本文件最重要的一条。
//    外部写操作的结果无法确认时自动重试 = 可能重复付费/重复下单/重复推送。
//    因此 `UnknownOutcome → Queued` 永远非法，且违反时返回**具名**错误码
//    `UNKNOWN_OUTCOME_NOT_RETRYABLE`，而不是笼统的 ILLEGAL_TRANSITION——
//    具名才能被 metrics 单独统计与告警。
//
//    但"不许自动重试"不等于"只能放弃"。人在对账之后能得出两个确定结论，
//    状态机必须能把它们记下来，否则：
//      · 确认已发生 → 只能进 DeadLetter（把做好的交付当失败重做）或 Cancelled（静默丢弃）；
//      · 确认未发生 → 只能挂在那儿，一个本可安全重试的任务永远等人工。
//    因此另有 `Validating`（已发生）与 `RetryableFailure`（未发生）两条边，
//    两者都要求显式的 `externalEffectConfirmed`。见 `UnknownOutcome` 的注释。
// ============================================================================

import { ATTEMPT_STATES, isKnownAttemptState, isTerminalAttemptState } from './states.mjs'

/**
 * 迁移表。每一条边声明三件事：
 *
 * - `requiresPersist`：**执行下一步副作用之前**必须先落库的东西（spec §6.4）。
 *   它让「先持久化意图，再做副作用」这句话成为可断言的事实，而不是一句原则。
 * - `createsNewAttempt`：重试不得覆盖历史 attempt（spec §6.4）。
 * - `guard`：这条边在什么条件下才成立。守卫不通过时返回具名错误码。
 */
export const TRANSITIONS = Object.freeze({
  Queued: Object.freeze({
    Leased: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'lease']),
      createsNewAttempt: false,
      guard: null,
      note: '领取必须用 team-hub 事务与 team-hub 时钟（PRT-302/313），worker 不得自报权威时间',
    }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  Leased: Object.freeze({
    PreparingWorkspace: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
    RetryableFailure: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  PreparingWorkspace: Object.freeze({
    BuildingContext: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'workspace']), createsNewAttempt: false, guard: null }),
    RetryableFailure: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  BuildingContext: Object.freeze({
    Running: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'contextSnapshot']), createsNewAttempt: false, guard: null }),
    RetryableFailure: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  Running: Object.freeze({
    AwaitingApproval: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'approval']),
      createsNewAttempt: false,
      guard: 'approvalOrigin',
      note: '工具级暂停；必须记下 returnTo，否则批准后不知道回到哪一步',
    }),
    Validating: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'runResult']), createsNewAttempt: false, guard: null }),
    RetryableFailure: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'runResult']), createsNewAttempt: false, guard: null }),
    UnknownOutcome: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'runResult']),
      createsNewAttempt: false,
      guard: 'confirmsNoExternalEffect',
      note: '只有在**无法确认**外部结果时才允许进入；能确认未执行应走 RetryableFailure',
    }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  AwaitingApproval: Object.freeze({
    // 目标状态不是固定的：批准后回到进入暂停时记下的那一步。
    __returnTo: true,
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
    RetryableFailure: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'approval']),
      createsNewAttempt: false,
      guard: null,
      note: '审批被拒或被 TTL 自动 deny；有无重试额度决定任务回到 todo 还是 blocked',
    }),
  }),
  Validating: Object.freeze({
    HandingOff: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'validation']),
      createsNewAttempt: false,
      guard: 'hasNextPost',
      note: '必须是 true：还有下一岗位要交接',
    }),
    Completed: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'validation']),
      createsNewAttempt: false,
      guard: 'noNextPost',
      note: '必须是 true：链尾任务，没有下一岗位',
    }),
    AwaitingApproval: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'approval']),
      createsNewAttempt: false,
      guard: 'approvalOrigin',
    }),
    RetryableFailure: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'validation']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  HandingOff: Object.freeze({
    Completed: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'handoff']), createsNewAttempt: false, guard: null }),
    RetryableFailure: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'handoff']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  RetryableFailure: Object.freeze({
    Queued: Object.freeze({
      requiresPersist: Object.freeze(['attempt']),
      createsNewAttempt: true,
      guard: 'hasRetryBudget',
      note: '重试必须新建 attempt；覆盖历史 attempt 会让「试过几次、每次错在哪」永久丢失',
    }),
    DeadLetter: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt']), createsNewAttempt: false, guard: null }),
  }),
  // UnknownOutcome 的出边。见文件头 ③。
  //
  // 原来只有 `DeadLetter`/`Cancelled`。加了这两条之后，"人工处置"才有完整的三种去向，
  // 而且每一种都对应一个**不同的事实**：
  //
  //   - 外部写**确实发生了** → `Validating`：按成功继续走验收。
  //     缺这条边时，一个已经真的交付了的结果只能进 DeadLetter（当失败重做，可能重复付费）
  //     或 Cancelled（当没做过，交付静默消失）。两种都不报错，两种都错。
  //   - 外部写**确认没发生** → `RetryableFailure`：它已经不是"未知"了，而是普通的可重试失败，
  //     于是回到既有的重试/额度判定上（有额度 → 新 attempt；没额度 → DeadLetter）。
  //     注意不是直接回 `Queued`：`UnknownOutcome → Queued` 仍然非法，
  //     因为"未知"与"确认没发生"必须是两个状态，否则那条最关键的禁令会自己失效。
  //   - 查不清/放弃 → `DeadLetter`：保持原样，人工兜底。
  //
  // 两条新边都要求调用方**显式给出** `externalEffectConfirmed` 布尔值（不给默认）：
  // 缺省成任何一个方向都会造成损失，而两种损失（重复执行 / 静默丢弃）都不会报错。
  UnknownOutcome: Object.freeze({
    Validating: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'reconciliation']),
      createsNewAttempt: false,
      guard: 'externalEffectHappened',
      note: '人工/对账确认外部写已发生：按成功继续验收，**不得重跑**',
    }),
    RetryableFailure: Object.freeze({
      requiresPersist: Object.freeze(['attempt', 'reconciliation']),
      createsNewAttempt: false,
      guard: 'externalEffectDidNotHappen',
      note: '人工/对账确认外部写未发生：降级为普通可重试失败，走重试额度判定',
    }),
    DeadLetter: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'reconciliation']), createsNewAttempt: false, guard: null }),
    Cancelled: Object.freeze({ requiresPersist: Object.freeze(['attempt', 'reconciliation']), createsNewAttempt: false, guard: null }),
  }),
  Completed: Object.freeze({}),
  Cancelled: Object.freeze({}),
  DeadLetter: Object.freeze({}),
})

/** 具名错误码。笼统的「非法迁移」无法被 metrics 单独统计，也无法告诉人该做什么。 */
export const TRANSITION_ERRORS = Object.freeze({
  UNKNOWN_FROM: 'UNKNOWN_FROM_STATE',
  UNKNOWN_TO: 'UNKNOWN_TO_STATE',
  TERMINAL: 'TRANSITION_FROM_TERMINAL',
  ILLEGAL: 'ILLEGAL_TRANSITION',
  STALE: 'STALE_STATE',
  UNKNOWN_OUTCOME_NOT_RETRYABLE: 'UNKNOWN_OUTCOME_NOT_RETRYABLE',
  MISSING_GUARD_INPUT: 'MISSING_GUARD_INPUT',
  GUARD_FAILED: 'TRANSITION_GUARD_FAILED',
  RETURN_TO_REQUIRED: 'RETURN_TO_REQUIRED',
})

/** 守卫求值：返回 `{ ok, code, message }`。 */
function evaluateGuard(guard, to, ctx) {
  if (guard === null) return { ok: true }
  switch (guard) {
    case 'hasRetryBudget': {
      if (typeof ctx.retryBudgetRemaining !== 'boolean') {
        return {
          ok: false,
          code: TRANSITION_ERRORS.MISSING_GUARD_INPUT,
          message: 'RetryableFailure → Queued 需要 retryBudgetRemaining：' +
            '缺它就无法区分「还能自动重试」与「额度已用完」，而这两者一个回 todo、一个进 DeadLetter',
        }
      }
      return ctx.retryBudgetRemaining
        ? { ok: true }
        : { ok: false, code: TRANSITION_ERRORS.GUARD_FAILED, message: '重试额度已用完：只能进 DeadLetter（或 Cancelled），不能回到队列' }
    }
    case 'hasNextPost': {
      if (ctx.hasNextPost !== true) {
        return {
          ok: false,
          code: TRANSITION_ERRORS.GUARD_FAILED,
          message: 'Validating → HandingOff 需要 hasNextPost === true。' +
            '任务确实没有下一岗位时应走 Validating → Completed；用交接来表达链尾会创建一个没有承接方的任务',
        }
      }
      return { ok: true }
    }
    case 'noNextPost': {
      if (ctx.hasNextPost !== false) {
        return {
          ok: false,
          code: TRANSITION_ERRORS.GUARD_FAILED,
          message: 'Validating → Completed 需要 hasNextPost === false。' +
            '缺这个输入时不得默认「没有下一岗位」——那会静默掐断任务链，直到目标停住才被发现',
        }
      }
      return { ok: true }
    }
    case 'approvalOrigin': {
      if (ctx.returnTo === undefined || ctx.returnTo === null) {
        return {
          ok: false,
          code: TRANSITION_ERRORS.MISSING_GUARD_INPUT,
          message: '进入 AwaitingApproval 必须记下 returnTo（批准后回到哪一步）。' +
            '不记的话批准后只能猜，而猜错的两种结果（跳过验收 / 把工具级暂停当成交付审批）都不会报错',
        }
      }
      if (to === 'AwaitingApproval') {
        if (!['Running', 'Validating'].includes(ctx.returnTo)) {
          return {
            ok: false,
            code: TRANSITION_ERRORS.GUARD_FAILED,
            message: `returnTo 只能是 Running（工具级暂停）或 Validating（交付级审批），收到 ${JSON.stringify(ctx.returnTo)}`,
          }
        }
        return { ok: true }
      }
      return { ok: true }
    }
    case 'externalEffectHappened': {
      // 确认"外部写已经发生了"。要求显式 `true`——缺省必须报错，不能默认。
      // 默认成"发生了"会把一次没做成的交付当成功推进验收；
      // 默认成"没发生"会重复执行一次已经生效的外部写。两种都不报错。
      if (ctx.externalEffectConfirmed !== true) {
        const reason = ctx.externalEffectConfirmed === false
          ? '收到 false：外部写确认未发生时应走 UnknownOutcome → RetryableFailure（安全重试），而不是当成成功'
          : '缺这个输入时不得默认：默认成「已发生」会把没做成的交付当成功推进验收'
        return {
          ok: false,
          code: typeof ctx.externalEffectConfirmed === 'boolean'
            ? TRANSITION_ERRORS.GUARD_FAILED
            : TRANSITION_ERRORS.MISSING_GUARD_INPUT,
          message: `UnknownOutcome → Validating 需要 externalEffectConfirmed === true（对账确认外部写已发生）。${reason}`,
        }
      }
      return { ok: true }
    }
    case 'externalEffectDidNotHappen': {
      // 确认"外部写没有发生"，于是它可以安全重试。同样要求显式 `false`。
      if (ctx.externalEffectConfirmed !== false) {
        return {
          ok: false,
          code: typeof ctx.externalEffectConfirmed === 'boolean'
            ? TRANSITION_ERRORS.GUARD_FAILED
            : TRANSITION_ERRORS.MISSING_GUARD_INPUT,
          message: 'UnknownOutcome → RetryableFailure 需要 externalEffectConfirmed === false（对账确认外部写未发生）。' +
            (ctx.externalEffectConfirmed === true
              ? '收到 true：外部写已发生时应走 UnknownOutcome → Validating，重试会造成重复副作用（重复付费/重复推送）'
              : '缺这个输入时不得默认：默认成「未发生」会重复执行一次可能已经生效的外部写'),
        }
      }
      return { ok: true }
    }
    case 'confirmsNoExternalEffect': {
      // 反向守卫：进入 UnknownOutcome 之前必须**确认无法确认**。
      // 如果调用方知道外部副作用没有发生，正确去向是 RetryableFailure——
      // 走 UnknownOutcome 会让一个可以安全重试的任务被挂起等人工。
      if (ctx.externalEffectConfirmed === true) {
        return {
          ok: false,
          code: TRANSITION_ERRORS.GUARD_FAILED,
          message: '已知外部副作用未发生时应走 Running → RetryableFailure，而不是 UnknownOutcome——' +
            '后者要求人工处置，把一个可自动重试的任务挂起来',
        }
      }
      return { ok: true }
    }
    default:
      return { ok: false, code: TRANSITION_ERRORS.GUARD_FAILED, message: `未实现的守卫「${guard}」` }
  }
}

/**
 * 判定一次迁移（不落库）。
 *
 * 返回 `{ ok, code, message, to, requiresPersist, createsNewAttempt, taskStatusHint }`。
 * 幂等：`current === to` 时返回 `{ ok: true, idempotent: true }`——
 * worker 在写入后崩溃、重启后重放同一次迁移是正常路径，不是错误。
 */
export function transitionPlan(current, to, ctx = {}) {
  if (!isKnownAttemptState(current)) {
    return Object.freeze({ ok: false, code: TRANSITION_ERRORS.UNKNOWN_FROM, message: `未登记的当前状态「${current}」` })
  }
  if (!isKnownAttemptState(to)) {
    return Object.freeze({ ok: false, code: TRANSITION_ERRORS.UNKNOWN_TO, message: `未登记的目标状态「${to}」` })
  }
  if (current === to) {
    return Object.freeze({
      ok: true,
      idempotent: true,
      from: current,
      to,
      requiresPersist: Object.freeze([]),
      createsNewAttempt: false,
      note: '重复应用同一次迁移：视为已生效（worker 写入后崩溃再重放的正常路径）',
    })
  }
  if (isTerminalAttemptState(current)) {
    return Object.freeze({
      ok: false,
      code: TRANSITION_ERRORS.TERMINAL,
      message: `${current} 是终态：迟到的结果只能作为诊断记录写入 audit，不得改写已提交终态（spec §6.1）`,
    })
  }
  const table = TRANSITIONS[current]

  // AwaitingApproval 的批准出边是动态的：目标是进入暂停时记下的 returnTo。
  if (table.__returnTo === true) {
    const guard = evaluateGuard('approvalOrigin', to, ctx)
    const isApprovedReturn = ctx.returnTo === to && ['Running', 'Validating'].includes(to)
    if (isApprovedReturn) {
      if (to === 'Validating') {
        // 回到验收：仍然需要交付审批的收口信息，由 Validating 的守卫在下一步兜住。
        return Object.freeze({
          ok: true,
          from: current,
          to,
          requiresPersist: Object.freeze(['attempt', 'approval']),
          createsNewAttempt: false,
          taskStatusHint: 'in_review',
          note: '交付级审批通过 → 回到验收收口',
        })
      }
      return Object.freeze({
        ok: true,
        from: current,
        to,
        requiresPersist: Object.freeze(['attempt', 'approval']),
        createsNewAttempt: false,
        taskStatusHint: 'in_progress',
        note: '工具级审批通过 → 回到运行',
      })
    }
    const explicit = table[to]
    if (explicit === undefined) {
      return Object.freeze({
        ok: false,
        code: TRANSITION_ERRORS.RETURN_TO_REQUIRED,
        message: `AwaitingApproval 只能回到进入暂停时记下的 returnTo（当前 returnTo=${JSON.stringify(ctx.returnTo ?? null)}），` +
          `或转 RetryableFailure / Cancelled。收到目标「${to}」`,
      })
    }
    if (guard.ok !== true) return Object.freeze({ ok: false, ...guard })
    return Object.freeze({
      ok: true,
      from: current,
      to,
      requiresPersist: explicit.requiresPersist,
      createsNewAttempt: explicit.createsNewAttempt,
      taskStatusHint: null,
      note: explicit.note ?? null,
    })
  }

  const edge = table[to]
  if (edge === undefined) {
    // UnknownOutcome 的违规单独具名：它对应的后果是**重复的外部副作用**，
    // 需要能被单独告警，而不是混在「有人写了个非法迁移」里。
    if (current === 'UnknownOutcome') {
      return Object.freeze({
        ok: false,
        code: TRANSITION_ERRORS.UNKNOWN_OUTCOME_NOT_RETRYABLE,
        message: `UnknownOutcome → ${to} 被拒绝：外部结果无法确认时自动重试可能造成重复副作用` +
          '（重复付费 / 重复推送 / 重复下单）。只能进 DeadLetter 或 Cancelled，等人工确认后再新建 attempt',
      })
    }
    return Object.freeze({
      ok: false,
      code: TRANSITION_ERRORS.ILLEGAL,
      message: `${current} → ${to} 不是合法迁移。允许的目标：${Object.keys(table).filter((k) => k !== '__returnTo').join(', ') || '（无，终态）'}`,
    })
  }

  const guard = evaluateGuard(edge.guard, to, ctx)
  if (guard.ok !== true) return Object.freeze({ ok: false, ...guard })

  return Object.freeze({
    ok: true,
    from: current,
    to,
    requiresPersist: edge.requiresPersist,
    createsNewAttempt: edge.createsNewAttempt,
    note: edge.note ?? null,
  })
}

/**
 * 以 **CAS 语义**应用一次迁移。
 *
 * `expectedFrom` 是调用方**以为**的当前状态（通常来自它领取时读到的那一行）。
 * 与 `current` 不符时返回 `STALE_STATE`：
 * 这就是「过期 worker 拒写」在纯逻辑层的形态（数据库层的 epoch 判定见 PRT-313）。
 */
export function applyTransition({ current, expectedFrom = undefined, to, context = {} } = {}) {
  if (expectedFrom !== undefined && expectedFrom !== current) {
    return Object.freeze({
      ok: false,
      code: TRANSITION_ERRORS.STALE,
      message: `状态已被他人改写：调用方以为当前是 ${expectedFrom}，实际是 ${current}。` +
        '拒绝写入（过期的 worker 不得改写别人的结果）',
      current,
      expectedFrom,
    })
  }
  return transitionPlan(current, to, context)
}

/** 某个状态的合法目标（供文档、诊断与「为什么不允许」的文案使用）。 */
export function allowedTargets(state, ctx = {}) {
  if (!isKnownAttemptState(state)) return Object.freeze([])
  if (isTerminalAttemptState(state)) return Object.freeze([])
  const table = TRANSITIONS[state]
  const keys = Object.keys(table).filter((k) => k !== '__returnTo')
  if (table.__returnTo === true && ctx.returnTo !== undefined) {
    return Object.freeze([...new Set([...keys, ctx.returnTo])].sort())
  }
  return Object.freeze(keys.sort())
}

/** 全部合法迁移边（供覆盖度断言：每条边都要有一条用例走过）。 */
export function allTransitionEdges() {
  const edges = []
  for (const from of ATTEMPT_STATES) {
    const table = TRANSITIONS[from]
    for (const to of Object.keys(table)) {
      if (to === '__returnTo') continue
      edges.push(Object.freeze({ from, to, guard: table[to].guard }))
    }
    if (table.__returnTo === true) {
      for (const to of ['Running', 'Validating']) edges.push(Object.freeze({ from, to, guard: 'approvalOrigin', viaReturnTo: true }))
    }
  }
  return Object.freeze(edges)
}

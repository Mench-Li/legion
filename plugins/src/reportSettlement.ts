// plugins/src/reportSettlement.ts
// ============================================================================
// F1 · Report 四态（白皮书 §2.11 / 设计稿 §3 F1，M2）
//
// 病灶：`WorkerReport.status` 原本只有 `done | blocked`。于是士兵只有两条路：
//   「这活不值得做 / 已不必要」→ 报 done（**假完成**，污染验收）
//   「在等外部条件 / 等人」    → 报 blocked（**假受阻**，制造噪音）
//
// 本模块把两件事拆开：
//   · **意图**（intent）：done / waiting / blocked / dropped —— 士兵说什么
//   · **结算**（settlement）：意图 → 任务状态 / 是否发消息 / 审计动作 —— 守护做什么
//
// ★ 三条纪律
//   ① `waiting` 必须带结构化的 `wait_for`，否则它会退化成第二种 blocked
//   ② 未支持的状态（例如 `ready`）**明确拒收**，不静默当 done —— 静默等同伪造报告
//   ③ `dropped` 不发消息，但**要留审计**：不打扰 ≠ 不留痕
// ============================================================================

/** 士兵报告的四种意图。`progress` 暂不支持（它与"沉默"冲突）。 */
export const REPORT_STATES = Object.freeze(['done', 'waiting', 'blocked', 'dropped'] as const)
export type ReportState = (typeof REPORT_STATES)[number]

/** `waiting` 的结构化原因。禁止自由文本：从自由文本推断状态是不可靠的。 */
export const WAIT_FOR_REASONS = Object.freeze([
  'external-review', 'upstream-merge', 'human-decision', 'ci-result', 'dependency',
] as const)
export type WaitForReason = (typeof WAIT_FOR_REASONS)[number]

export const REPORT_SETTLEMENT_ERRORS = Object.freeze({
  UNKNOWN_STATUS: 'REPORT_UNKNOWN_STATUS',
  WAIT_FOR_REQUIRED: 'REPORT_WAIT_FOR_REQUIRED',
  WAIT_FOR_UNKNOWN: 'REPORT_WAIT_FOR_UNKNOWN',
})

export class ReportSettlementError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ReportSettlementError'
    this.code = code
  }
}

/** 归一化后的报告：只保留结算需要的字段，`wait_for` 转成 camelCase 一次。 */
export interface NormalizedReport {
  status: ReportState
  waitFor?: WaitForReason
  summary: string
  blocker: string
}

/** 结算计划：纯数据，调用方据此改状态、决定发不发消息、写哪条审计。 */
export interface ReportSettlement {
  taskStatus: 'in_review' | 'in_progress' | 'blocked' | 'canceled'
  reportState: ReportState
  /** `true` 表示"无需处理"：看板显示 no-action，而不是普通完成。 */
  noAction: boolean
  /** 是否允许给外部发消息（dropped / waiting 一律 false）。 */
  emitsMessage: boolean
  /** 审计动作名：`report` 或 `drop`。 */
  auditAction: 'report' | 'drop'
  waitFor?: WaitForReason
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * 校验并归一化一条士兵报告。
 * @throws ReportSettlementError 状态未知、或 `waiting` 缺/错 `wait_for`
 */
export function normalizeReport(input: {
  status?: unknown
  wait_for?: unknown
  waitFor?: unknown
  summary?: unknown
  blocker?: unknown
}): NormalizedReport {
  const status = asText(input?.status) as ReportState
  if (!REPORT_STATES.includes(status)) {
    throw new ReportSettlementError(
      REPORT_SETTLEMENT_ERRORS.UNKNOWN_STATUS,
      `未知报告状态 ${JSON.stringify(input?.status)}；只接受 ${REPORT_STATES.join(' / ')}`,
    )
  }

  const rawWait = asText(input?.wait_for ?? input?.waitFor)
  if (status === 'waiting') {
    if (!rawWait) {
      throw new ReportSettlementError(
        REPORT_SETTLEMENT_ERRORS.WAIT_FOR_REQUIRED,
        `waiting 必须带 wait_for（${WAIT_FOR_REASONS.join(' / ')}）——否则它只是另一种 blocked`,
      )
    }
    if (!WAIT_FOR_REASONS.includes(rawWait as WaitForReason)) {
      throw new ReportSettlementError(
        REPORT_SETTLEMENT_ERRORS.WAIT_FOR_UNKNOWN,
        `未知 wait_for ${JSON.stringify(rawWait)}；只接受 ${WAIT_FOR_REASONS.join(' / ')}`,
      )
    }
    return { status, waitFor: rawWait as WaitForReason, summary: asText(input?.summary), blocker: asText(input?.blocker) }
  }

  return { status, summary: asText(input?.summary), blocker: asText(input?.blocker) }
}

/**
 * 意图 → 结算计划。纯函数：同样的报告永远得到同样的计划。
 *
 * | 意图 | 任务状态 | 发消息 | 审计 | 备注 |
 * | --- | --- | --- | --- | --- |
 * | done | in_review | ✅ | report | 与今天一致 |
 * | waiting | in_progress | ❌ | report | 派生为 idle，不发进度噪音 |
 * | blocked | blocked | ✅ | report | 与今天一致 |
 * | dropped | done | ❌ | **drop** | 标 no-action；不打扰但留痕 |
 */
export function settlementFor(report: NormalizedReport): ReportSettlement {
  switch (report.status) {
    case 'done':
      return { taskStatus: 'in_review', reportState: 'done', noAction: false, emitsMessage: true, auditAction: 'report' }
    case 'waiting':
      return { taskStatus: 'in_progress', reportState: 'waiting', noAction: false, emitsMessage: false, auditAction: 'report', waitFor: report.waitFor }
    case 'blocked':
      return { taskStatus: 'blocked', reportState: 'blocked', noAction: false, emitsMessage: true, auditAction: 'report' }
    case 'dropped':
      // dropped 优先：即使 blocker 里还残留一句话，也不能把「无需处理」变成「受阻」。
      // 落 `canceled` 而不是 `done`：Legion 的 done 只有将军在用户接受后才能写
      // （taskctl：「只有将军能在用户接受后把任务移到 done」），而「无需处理」在执行面等价于取消。
      return { taskStatus: 'canceled', reportState: 'dropped', noAction: true, emitsMessage: false, auditAction: 'drop' }
    default: {
      const never: never = report.status
      throw new ReportSettlementError(REPORT_SETTLEMENT_ERRORS.UNKNOWN_STATUS, `未覆盖的状态 ${String(never)}`)
    }
  }
}

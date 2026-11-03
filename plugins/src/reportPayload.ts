// plugins/src/reportPayload.ts
// ============================================================================
// F2 · 守护侧「回报请求」的形状（设计稿 §3 F2 / DEC-2）
//
// 守护不再自己拼一条 `❓` 评论、再单独发一次 transition —— 那是两次写，
// 中间任何一步失败都会留下半截（状态没变但评论已发 / 问题登记了但状态没动）。
//
// 现在它只发**一次** `POST /api/tasks/:id/report`，由 team-hub 在一个事务里
// 落盘「状态 + 待答问题 + 审计」。本模块负责那次请求长什么样，因此它必须是
// 纯函数、可被判据钉住（见 tests/report-payload.test.mjs）。
//
// ★ 两条容易做错的细节
//   ① 幂等键 `blocked:<taskId>:<version>`：守护重试不能造出第二个问题
//   ② 空 blocker **不得**退化成把 summary 当问题——「真卡住」与「在等人」
//      必须能被区分开（前者会被派生成 stuck，后者是 awaiting_answer）
// ============================================================================

export const REPORT_PATH_PREFIX = '/api/tasks/'
export const REPORT_PATH_SUFFIX = '/report'
export const QUESTION_MAX_CHARS = 800

export interface BlockedReportInput {
  taskId: string
  /** 任务当前版本：它进幂等键，保证同一版本只登记一次。 */
  version: number
  /** 回报者（写进审计的 member）。 */
  role: string
  scope: string
  summary: string
  evidence: string
  /** 士兵报告里的 blocker：非空才构成"待将军拍板的问题"。 */
  blocker: string
  /** worktree 提示：并入 evidence，不额外制造评论。 */
  worktreeHint?: string
}

export interface ReportRequest {
  path: string
  body: Record<string, unknown>
}

/** 拼出 blocked 回报请求。纯函数：同样的输入永远同样的请求。 */
export function blockedReportPayload(input: BlockedReportInput): ReportRequest {
  const question = (input.blocker ?? '').trim()
  const evidence = `${input.evidence ?? ''}${input.worktreeHint ?? ''}`.trim()
  const body: Record<string, unknown> = {
    by: input.role,
    scope: input.scope,
    // 幂等键：同任务同版本只登记一次
    reportId: `blocked:${input.taskId}:${input.version}`,
    status: 'blocked',
    summary: input.summary ?? '',
    evidence,
    // 一次请求落盘：状态与问题同事务，不留两次写的缝
    applyTransition: true,
  }
  if (question !== '') {
    body.question = { body: question.slice(0, QUESTION_MAX_CHARS) }
  }
  return {
    // 任务 id 必须转义：id 里出现 `/` 时不能拼出另一条路由
    path: `${REPORT_PATH_PREFIX}${encodeURIComponent(input.taskId)}${REPORT_PATH_SUFFIX}`,
    body,
  }
}

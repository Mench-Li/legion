// team-hub/handoff-settle-run.mjs
// ============================================================================
// 接手结算的**执行层**：把"跑冻结验证 → 写回执/证据 → 置状态"串起来。
//
// 判定在 `handoff-settle.mjs`（纯函数、有单测），路由在 `routes/handoff.mjs`
// （只搬参数）。这里只做一件事：按判定结果**落地**，且失败时绝不静默。
//
// ## 为什么要依赖注入
//
// 这条路径要碰 git（准备 worktree）、spawn（跑 runner）、SQLite（写 attempt/证据）。
// 直接把这些写死，就只能靠一台真机器验证——而这里最容易出错的恰恰是**分支选择**
// （passed/failed/unknown 三条路的落点不同）。注入之后，三条路都能在没有 git 和
// 数据库的情况下断言；真跑命令那一层由 runner 自己的测试守着。
// ============================================================================

import { buildImplementationEvidence, buildSettleAttempt, buildSettleCheckpoint, decideSettlement, runnerMatchesReceipt } from './handoff-settle.mjs'

/**
 * @param {{taskId: string, by: string}} input
 * @param {{
 *   loadTask: (id: string) => any,
 *   assertSettleable: (task: any) => void,
 *   prepareWorktree: (task: any) => Promise<string>,
 *   runRunner: (args: {runner: any, cwd: string}) => Promise<any>,
 *   saveAttempt: (attempt: any) => void,
 *   appendEvidence: (taskId: string, text: string, by: string) => void,
 *   setStatus: (taskId: string, status: string, comment?: string) => void,
 *   now?: () => number,
 * }} deps
 */
export async function settleHandoff({ taskId, by }, deps) {
  // 只校验必需的注入项：调用方可能顺带挂别的字段（比如测试里的 calls 收集器），
  // 按"所有键都必须是函数"来判会把它们误判成缺注入项。
  for (const k of ['loadTask', 'assertSettleable', 'prepareWorktree', 'runRunner', 'saveAttempt', 'appendEvidence', 'setStatus']) {
    if (typeof deps[k] !== 'function') throw new TypeError(`settleHandoff 缺注入项：${k}`)
  }
  const now = deps.now ?? Date.now
  const task = deps.loadTask(taskId)
  deps.assertSettleable(task)          // 不是实现阶段 / 状态不对 → 抛（带 code）

  const adopt = task.agentSelectionSnapshot?.adopt
  const sourceCommit = adopt?.commit
  const stage = task.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitionsById?.[
    task.agentSelectionSnapshot?.workflowStageId ?? task.agentSelectionSnapshot?.implementationStageId
  ] ?? null
  const runner = stage?.testRunner ?? null
  if (runner === null || runner === undefined) {
    throw Object.assign(new Error(`任务 ${taskId} 的冻结阶段没有 testRunner：接手的独立验证无处可跑`), {
      code: 'HANDOFF_NO_RUNNER', statusCode: 409,
    })
  }

  const worktree = await deps.prepareWorktree(task)
  const startedAtMs = now()
  const receipt = await deps.runRunner({ runner, cwd: worktree })
  const finishedAtMs = now()

  if (!runnerMatchesReceipt(runner, receipt)) {
    // 回执与冻结配置不一致时**不能**落库：hub 的交接校验会因此 409，而报错文案
    // 完全跑偏（"缺少带 SHA-256 摘要的设计产物"），现场根本看不出是这个原因。
    throw Object.assign(new Error('独立验证回执与冻结 runner 配置不一致，拒绝结算'), {
      code: 'HANDOFF_RECEIPT_MISMATCH', statusCode: 409,
    })
  }

  const settlement = decideSettlement(receipt)
  const summary = settlement.ok
    ? `接手 ${sourceCommit?.slice(0, 12)} 的实现：独立验证通过（${[receipt.executable, ...(receipt.args ?? [])].join(' ')}）`
    : `接手 ${sourceCommit?.slice(0, 12)} 的实现：${settlement.reason}`
  const testCommand = [receipt.executable, ...(receipt.args ?? [])].join(' ')
  const testEvidence = String(receipt.outputExcerpt ?? '').slice(-4000)

  const attempt = buildSettleAttempt({
    attemptId: `wfa-handoff-${now()}`, stageId: task.agentSelectionSnapshot?.workflowStageId ?? task.role,
    providerName: task.agentSelectionSnapshot?.agentToolConfig?.providerName ?? 'spawn',
    receipt, sourceCommit, summary, evidence: testEvidence, startedAtMs, finishedAtMs,
  })
  deps.saveAttempt(attempt)

  if (!settlement.ok) {
    // 失败/未知都停在 in_review，并把原因写成人能读的一句话（含退出码/超时秒数）。
    deps.setStatus(taskId, 'in_review', `⚠ ${settlement.reason}。工作现场保留在接手基线上，人工核对后可重新结算。`)
    return { ok: false, settlement, attempt, sourceCommit }
  }

  deps.appendEvidence(taskId, buildSettleCheckpoint({
    stageId: attempt.stageId, sourceCommit, artifactPaths: [], acceptedBy: by,
  }), by)
  deps.appendEvidence(taskId, buildImplementationEvidence({
    passed: true, sourceCommit, stageAttemptId: attempt.id, providerRunId: attempt.providerRunId,
    receipt, testCommand, testSummary: summary, testEvidence,
  }), by)
  deps.setStatus(taskId, 'done', `✅ 接手结算：${summary}。未派 agent，回执由独立 runner 产出。`)
  return { ok: true, settlement, attempt, sourceCommit }
}

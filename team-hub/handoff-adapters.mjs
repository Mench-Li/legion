// team-hub/handoff-adapters.mjs
// ============================================================================
// 把 hub 的内部能力**接成** `settleHandoff` 需要的 7 个注入项。
//
// 分层理由（与仓库其余部分一致）：
//   · `handoff-settle.mjs`     —— 判定（纯函数，9 条断言）
//   · `handoff-settle-run.mjs` —— 落点（注入式，6 条断言）
//   · 本文件                    —— **接线**：把"读任务/置状态/写评论/git/spawn/SQL"
//                                 包成上面那一层认识的形状
//   · `routes/handoff.mjs`     —— HTTP 形状（6 条断言）
//
// 本文件刻意**不**直接 import 数据库或 git：它只认注入进来的原语。这样接线错位
// （比如把 `in_review` 写成 `done`）可以在没有真库的情况下被断言住，而 hub 里
// `server.mjs` 的那一处注册变成 10 行以内的声明。
// ============================================================================

/**
 * 判定一个任务能不能被"接手结算"。
 *
 * 三条硬边界，缺一条都该拒绝而不是勉强继续：
 *   ① 必须是跨 Agent 工作流的**实现阶段**（别的环有自己的证据契约）；
 *   ② 必须带 `adopt` 基线（没有基线就没有"接谁的"）；
 *   ③ 状态只能是 `todo` / `in_review`（`in_progress` 说明有人正在写同一份工作区）。
 */
export function assertSettleable(task, { implementationStageId = null } = {}) {
  const reject = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
  if (task === null || task === undefined) throw reject('HANDOFF_TASK_MISSING', '找不到要结算的任务', 404)
  const snapshot = task.agentSelectionSnapshot ?? null
  if (snapshot === null) throw reject('HANDOFF_NOT_WORKFLOW_TASK', `任务 ${task.id} 没有冻结快照：不是工作流链上的任务`)
  const stageId = snapshot.workflowStageId ?? null
  if (implementationStageId !== null && stageId !== implementationStageId) {
    throw reject('HANDOFF_NOT_IMPLEMENTATION', `任务 ${task.id} 处在阶段 ${stageId ?? '（未知）'}，只有实现阶段能接手结算`)
  }
  const adopt = snapshot.adopt ?? null
  if (adopt === null || typeof adopt.commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(adopt.commit)) {
    throw reject('HANDOFF_NO_ADOPT_BASELINE', `任务 ${task.id} 没有继承基线：先按 adoptFrom 发布，再结算`)
  }
  if (!['todo', 'in_review'].includes(task.status)) {
    throw reject('HANDOFF_BAD_STATUS', `任务 ${task.id} 当前 ${task.status}：只有 todo / in_review 能接手结算（in_progress 说明有人正在写）`)
  }
  return { adopt, stageId }
}

/** 接手结算用的 worktree 目录名（固定、可预测，便于排查）。 */
export function handoffWorktreeDir(repoRoot, taskId) {
  return `${String(repoRoot).replace(/[\\/]+$/, '')}/.legion-worktrees/handoff-${taskId}`
}

/**
 * 造 `settleHandoff` 的注入项。
 *
 * @param {{
 *   loadTask: (id: string) => any,
 *   setStatus: (id: string, status: string, comment: string) => void,
 *   appendComment: (id: string, text: string, by: string, opts?: {evidence?: boolean}) => void,
 *   saveAttempt: (attempt: any) => void,
 *   prepareWorktree: (task: any) => Promise<string>,
 *   runRunner: (args: {runner: any, cwd: string}) => Promise<any>,
 *   implementationStageId?: string|null,
 * }} deps
 */
export function createHandoffAdapters(deps) {
  for (const k of ['loadTask', 'setStatus', 'appendComment', 'saveAttempt', 'prepareWorktree', 'runRunner']) {
    if (typeof deps[k] !== 'function') throw new TypeError(`createHandoffAdapters 缺注入项：${k}`)
  }
  return {
    loadTask: (id) => deps.loadTask(id),
    assertSettleable: (task) => assertSettleable(task, { implementationStageId: deps.implementationStageId ?? null }),
    prepareWorktree: (task) => deps.prepareWorktree(task),
    runRunner: (args) => deps.runRunner(args),
    saveAttempt: (attempt) => deps.saveAttempt(attempt),
    appendEvidence: (id, text, by) => deps.appendComment(id, text, by, { evidence: true }),
    setStatus: (id, status, comment) => deps.setStatus(id, status, comment),
  }
}

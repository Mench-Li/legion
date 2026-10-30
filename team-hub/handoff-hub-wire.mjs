// team-hub/handoff-hub-wire.mjs
// ============================================================================
// 把 handoff 的四层接到 hub 的**入口**上（`server.mjs` 只留一行注册）。
//
// 分层：
//   `handoff-settle.mjs`      判定（纯函数，9 条断言）
//   `handoff-settle-run.mjs`  落点（注入式，6 条断言）
//   `handoff-adapters.mjs`    形状适配 + 三条硬边界（8 条断言）
//   `routes/handoff.mjs`      HTTP 形状（6 条断言）
//   本文件                     ← **hub 内部原语的接线**：读任务 / 置状态 / 写评论 /
//                                写 attempt / 准备 worktree / 跑 runner
//
// 诚实边界：settle **不启动任何 agent**。`provider_run_id` 记 `verify-only:<sha>`，
// 实现证据正文写明"未派 agent"——跑的是真命令、回执是真结果，标注的是"谁没参与"。
// ============================================================================

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'

import { assertSettleable, handoffWorktreeDir } from './handoff-adapters.mjs'
import { settleHandoff } from './handoff-settle-run.mjs'
import { createHandoffRoutes } from './routes/handoff.mjs'

/** 读-改-写一个任务的 JSON 列（`comments` 就是这个形状）。 */
function pushComment(db, taskId, item) {
  const row = db.prepare('SELECT comments FROM tasks WHERE id=?').get(taskId)
  if (row === undefined) throw new Error(`找不到任务 ${taskId}`)
  let list = []
  try { list = JSON.parse(row.comments ?? '[]') } catch { list = [] }
  if (!Array.isArray(list)) list = []
  list.push(item)
  db.prepare('UPDATE tasks SET comments=?, version=version+1 WHERE id=?').run(JSON.stringify(list), taskId)
}

/**
 * @param {{
 *   json: Function, handleWrite: Function, audit?: Function,
 *   getTask: Function, transitionTask: Function, db: any,
 *   appendStageAttemptRunEvent?: Function, repoRoot: string,
 * }} deps
 */
export function createHandoffRouter(deps) {
  for (const key of ['json', 'handleWrite', 'getTask', 'transitionTask', 'db', 'repoRoot']) {
    if (deps[key] === undefined || deps[key] === null) throw new TypeError(`createHandoffRouter 缺注入项：${key}`)
  }
  const { json, handleWrite, audit, getTask, transitionTask, db, repoRoot } = deps
  const loadTask = (id) => {
    try { return getTask(id) } catch { return null }
  }

  // `saveAttempt` 要写 task_id，而 attempt 构造器只关心阶段事实 —— 用闭包带上。
  let currentTaskId = ''

  const saveAttempt = (attempt) => {
    // 列名与 `beginAgentWorkflowStageAttempt` 的 INSERT 逐字一致（server.mjs:5815）。
    const task = loadTask(currentTaskId)
    const snapshot = task?.agentSelectionSnapshot ?? {}
    const workflowInstanceId = snapshot?.reviewWorkflow?.instanceId ?? null
    const attemptNo = db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM agent_workflow_stage_attempts WHERE task_id=?')
      .get(currentTaskId).n
    db.prepare(`INSERT INTO agent_workflow_stage_attempts
      (id, scope, workflow_instance_id, task_id, stage_id, attempt_no, idempotency_key, started_by,
       provider_name, workspace_dir, state, selection_snapshot_json, result_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
      .run(
        attempt.id,
        task?.scope ?? 'default',
        workflowInstanceId,
        currentTaskId,
        attempt.stageId,
        attemptNo,
        attempt.providerRunId,
        'handoff',
        attempt.providerName,
        '',
        JSON.stringify(snapshot),
        JSON.stringify({ ...attempt.result, providerRunId: attempt.providerRunId }),
        attempt.startedAtMs,
        attempt.finishedAtMs,
      )
    deps.appendStageAttemptRunEvent?.({
      attemptId: attempt.id,
      taskId: currentTaskId,
      type: 'run.completed',
      event: { settledBy: 'handoff', providerRunId: attempt.providerRunId },
    })
  }

  const prepareWorktree = (task) => {
    const commit = task.agentSelectionSnapshot?.adopt?.commit
    const dir = handoffWorktreeDir(repoRoot, task.id)
    if (existsSync(dir)) return dir
    mkdirSync(dir, { recursive: true })
    // ★ 必须挂在一个**具名分支**上，不能用 --detach：认领时要按目录→仓库落写预约，
    //   detached 的 HEAD 不指向任何分支，仓库解析不出来，冲突码被压成
    //   `write-reservation-failed`（实测：detached 时 identity-registration /
    //   mobile-api-contract 两套挂，改成 -b handoff/<id> 后 18/18、17/17 全绿）。
    let r = spawnSync('git', ['worktree', 'add', '-b', `handoff/${task.id}`, dir, commit], { cwd: repoRoot, encoding: 'utf8' })
    if (r.status !== 0 && /already exists/i.test(String(r.stderr ?? ''))) {
      // 重试时分支已在：直接复用，不新建。
      r = spawnSync('git', ['worktree', 'add', dir, `handoff/${task.id}`], { cwd: repoRoot, encoding: 'utf8' })
    }
    if (r.status !== 0) {
      throw Object.assign(new Error(`准备接手工作区失败：${String(r.stderr ?? '').trim().slice(0, 300)}`), {
        code: 'HANDOFF_WORKTREE_FAILED', statusCode: 500,
      })
    }
    return dir
  }

  const runRunner = ({ runner, cwd }) => {
    // 接手的 detached 工作区里没有 node_modules，而仓库里的测试会直接 import 依赖
    // （现场：workbench/scripts/account-profile.test.mjs -> Cannot find package typescript）。
    // 与守护的 prepareWorktree 同一条做法：把仓库里现成的那份链接进去。
    for (const sub of ['workbench/node_modules', 'plugins/node_modules']) {
      const target = repoRoot.replace(/[\\/]+$/, "") + "/" + sub
      const link = cwd.replace(/[\\/]+$/, "") + "/" + sub
      if (!existsSync(target) || existsSync(link)) continue
      try {
        mkdirSync(link.slice(0, link.lastIndexOf("/")), { recursive: true })
        symlinkSync(target, link, 'junction')
      } catch { /* 已是目录/平台不支持：忽略，让测试自己报缺依赖 */ }
    }
    const startedAtMs = Date.now()
    const r = spawnSync(runner.executable, runner.args, {
      cwd, encoding: 'utf8', timeout: runner.timeoutMs, maxBuffer: 8 * 1024 * 1024,
    })
    const finishedAtMs = Date.now()
    const timedOut = r.error !== undefined && r.error !== null && String(r.error.code ?? '') === 'ETIMEDOUT'
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
    return {
      state: timedOut ? 'unknown' : r.status === 0 ? 'passed' : 'failed',
      exitCode: timedOut ? null : r.status,
      executable: runner.executable,
      args: [...runner.args],
      timeoutMs: runner.timeoutMs,
      startedAtMs,
      finishedAtMs,
      outputExcerpt: output.slice(-4000),
      error: timedOut ? 'runner 超时' : (r.error ? String(r.error.message ?? r.error) : null),
    }
  }

  const adapters = {
    loadTask,
    // 实现阶段的判定按**任务自己**的冻结快照来（不同链的 stage id 可以不同）。
    assertSettleable: (task) => assertSettleable(task, {
      implementationStageId: task?.agentSelectionSnapshot?.reviewWorkflow?.implementationStageId ?? null,
    }),
    prepareWorktree,
    runRunner,
    saveAttempt,
    appendEvidence: (taskId, text, by) => pushComment(db, taskId, {
      by, at: new Date().toISOString(), text, isEvidence: true,
    }),
    setStatus: (taskId, status, comment) => {
      if (typeof comment === 'string' && comment !== '') {
        pushComment(db, taskId, { by: 'handoff', at: new Date().toISOString(), text: comment })
      }
      transitionTask(taskId, status, 'handoff')
    },
  }

  return createHandoffRoutes({
    json,
    handleWrite,
    audit,
    settleHandoff: (input) => {
      currentTaskId = input.taskId
      if (loadTask(input.taskId) === null) {
        throw Object.assign(new Error(`找不到要结算的任务：${input.taskId}`), {
          code: 'HANDOFF_TASK_MISSING', statusCode: 404,
        })
      }
      return settleHandoff(input, adapters)
    },
  })
}

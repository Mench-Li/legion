// team-hub/handoff-hub-wire.mjs
// ============================================================================
// 把 handoff 的四层接到 hub 的**入口**上（`server.mjs` 只留一行注册）。
//
// 分层：
//   `handoff-settle.mjs`      判定（纯函数）
//   `handoff-settle-run.mjs`  落点（注入式）
//   `handoff-adapters.mjs`    形状适配 + 三条硬边界
//   `routes/handoff.mjs`      HTTP 形状
//   本文件                     ← **hub 内部原语的接线**：读任务 / 置状态 / 写证据 /
//                                写 attempt / 准备 worktree / 跑 runner
//
// 诚实边界：settle **不启动任何 agent**。`provider_run_id` 记 `verify-only:<sha>:<n>`，
// 实现证据正文写明"未派 agent"——跑的是真命令、回执是真结果，标注的是"谁没参与"。
//
// 这一版把 2026-10-30 现场手工补过的四件事落成代码（否则每次接手都要再手补一遍）：
//   ① 跑验证时**清空环境**（否则继承 hub 的 TEAM_HUB_DB，测试会去写线上库）；
//   ② 冻结 args 里的脚本可能在接手提交里还不存在 ⇒ 回退到仓库根下的同一路径；
//   ③ attempt 要写 `provider_run_id`（审查环按它比对）；
//   ④ 证据写进任务的 **evidence 列**（hub 从那一列读），不是 comments。
// ============================================================================

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { assertSettleable, handoffWorktreeDir } from './handoff-adapters.mjs'
import { settleHandoff } from './handoff-settle-run.mjs'
import { createHandoffRoutes } from './routes/handoff.mjs'

/** 读-改-写任务的某个 JSON 列。 */
function pushJsonColumn(db, taskId, column, item) {
  const row = db.prepare(`SELECT ${column} FROM tasks WHERE id=?`).get(taskId)
  if (row === undefined) throw new Error(`找不到任务 ${taskId}`)
  let list = []
  try { list = JSON.parse(row[column] ?? '[]') } catch { list = [] }
  if (!Array.isArray(list)) list = []
  list.push(item)
  db.prepare(`UPDATE tasks SET ${column}=?, version=version+1 WHERE id=?`).run(JSON.stringify(list), taskId)
}

/** 把冻结 argv 里的相对脚本路径解析成**真实存在**的绝对路径。 */
export function resolveRunnerArgs(args, { cwd, repoRoot }) {
  if (!Array.isArray(args) || args.length === 0) return args
  const [first, ...rest] = args
  if (isAbsolute(first)) return args
  const inWorktree = join(cwd, first)
  if (existsSync(inWorktree)) return [inWorktree, ...rest]
  // 验证脚本属于**现在的工具链**，不属于被接手的那个提交 —— 接手时它常常还不存在。
  const inRepo = join(repoRoot, first)
  if (existsSync(inRepo)) return [inRepo, ...rest]
  return args
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

  let currentTaskId = ''
  let currentBy = 'handoff'

  const saveAttempt = (attempt) => {
    // 列名与 `beginAgentWorkflowStageAttempt` 的 INSERT 逐字一致（server.mjs）。
    const task = loadTask(currentTaskId)
    const snapshot = task?.agentSelectionSnapshot ?? {}
    const workflowInstanceId = snapshot?.reviewWorkflow?.instanceId ?? null
    const attemptNo = db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM agent_workflow_stage_attempts WHERE task_id=?')
      .get(currentTaskId).n
    db.prepare(`INSERT INTO agent_workflow_stage_attempts
      (id, scope, workflow_instance_id, task_id, stage_id, attempt_no, idempotency_key, started_by,
       provider_name, provider_run_id, workspace_dir, state, selection_snapshot_json, result_json,
       created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
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
        attempt.providerRunId,
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
    // ★ 必须挂在**具名分支**上，不能用 --detach：认领时要按目录→仓库落写预约，
    //   detached 的 HEAD 不指向任何分支，仓库解析不出来（实测两套测试因此挂）。
    let r = spawnSync('git', ['worktree', 'add', '-b', `handoff/${task.id}`, dir, commit], { cwd: repoRoot, encoding: 'utf8' })
    if (r.status !== 0 && /already exists/i.test(String(r.stderr ?? ''))) {
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
    // 接手的 detached 工作区里没有 node_modules，而仓库里的测试会直接 import 依赖。
    for (const sub of ['workbench/node_modules', 'plugins/node_modules']) {
      const target = join(repoRoot, sub)
      const link = join(cwd, sub)
      if (!existsSync(target) || existsSync(link)) continue
      try {
        mkdirSync(join(cwd, sub.split('/')[0]), { recursive: true })
        symlinkSync(target, link, 'junction')
      } catch { /* 已是目录/平台不支持：忽略，让测试自己报缺依赖 */ }
    }
    // ★ 必须**清干净环境**再跑：hub 进程的 env 里带着 TEAM_HUB_DB（它靠它启动），
    //   继承下去会让测试写**线上真库**，表现为认领预约与线上任务打架。
    const env = { CI: '1' }
    for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'USERPROFILE']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    const args = resolveRunnerArgs(runner.args, { cwd, repoRoot })
    const startedAtMs = Date.now()
    const r = spawnSync(runner.executable, args, {
      cwd, encoding: 'utf8', timeout: runner.timeoutMs, maxBuffer: 8 * 1024 * 1024, env,
    })
    const finishedAtMs = Date.now()
    const timedOut = r.error !== undefined && r.error !== null && String(r.error.code ?? '') === 'ETIMEDOUT'
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
    return {
      state: timedOut ? 'unknown' : r.status === 0 ? 'passed' : 'failed',
      exitCode: timedOut ? null : r.status,
      executable: runner.executable,
      // 回执里的 argv 必须是**冻结的那一份**，否则 runnerMatchesReceipt 判不一致。
      args: [...runner.args],
      timeoutMs: runner.timeoutMs,
      startedAtMs,
      finishedAtMs,
      outputExcerpt: output.slice(-4000),
      // 审查环的回执校验要求 64 位十六进制摘要；缺了它 checkedEvidence 直接判无效。
      outputDigest: createHash('sha256').update(output).digest('hex'),
      // 校验要求 outputTruncated 是布尔值（缺它整份回执判无效）。
      outputTruncated: output.length > 4000,
      runnerNodeId: 'desktop-software',
      error: timedOut ? 'runner 超时' : (r.error ? String(r.error.message ?? r.error) : null),
    }
  }

  const appendEvidence = (taskId, text, by) => {
    // ★ 证据进 **evidence 列**：hub 的交接解析读的是 `implementationTask.evidence`。
    pushJsonColumn(db, taskId, 'evidence', { by, at: new Date().toISOString(), text })
  }

  const adapters = {
    loadTask,
    assertSettleable: (task) => assertSettleable(task, {
      implementationStageId: task?.agentSelectionSnapshot?.reviewWorkflow?.implementationStageId ?? null,
    }),
    prepareWorktree,
    runRunner,
    saveAttempt,
    appendEvidence,
    setStatus: (taskId, status, comment) => {
      if (typeof comment === 'string' && comment !== '') {
        pushJsonColumn(db, taskId, 'comments', { by: 'handoff', at: new Date().toISOString(), text: comment })
      }
      // 状态机：todo/in_progress 都不能直接 done（todo→done、in_progress→done 都是非法迁移）。
      // 成功结算的合规路径是 …→in_review→done；done 由 general 触发，走人工验收的收口逻辑。
      const current = loadTask(taskId)?.status
      if (status === 'done') {
        // 状态机允许的路径：todo → in_progress → in_review → done。
        // todo 直接写 in_review 会被拒（现场 400 非法迁移 todo → in_review）。
        if (current === 'todo') transitionTask(taskId, 'in_progress', currentBy)
        if (current === 'todo' || current === 'in_progress') transitionTask(taskId, 'in_review', currentBy)
      }
      // ★ done 只有将军（by=general）能按：用请求里的操作者，不要写死 handoff。
      transitionTask(taskId, status, currentBy)
    },
  }

  return createHandoffRoutes({
    json,
    handleWrite,
    audit,
    settleHandoff: (input) => {
      currentTaskId = input.taskId
      currentBy = input.by ?? 'handoff'
      if (loadTask(input.taskId) === null) {
        throw Object.assign(new Error(`找不到要结算的任务：${input.taskId}`), {
          code: 'HANDOFF_TASK_MISSING', statusCode: 404,
        })
      }
      return settleHandoff(input, adapters)
    },
  })
}

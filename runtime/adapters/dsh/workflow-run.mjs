// Wait for a DSH run while propagating a user-canceled workflow task to its
// AbortSignal. Cancellation is only confirmed by the provider's terminal result.
function safeFailureType(error) {
  try {
    const name = error instanceof Error ? error.name : 'NonErrorRejection'
    return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? name : 'Error'
  } catch {
    return 'Error'
  }
}

/**
 * BUG-043：把「没有可确认终态」拆成可归因的 stop_reason。
 *
 * 从前这类结果一律记成 `outcome-unknown`，于是「超时」「启动失败」「provider 拒绝」
 * 在库里长得一模一样 —— T-224 跑了 56.9 分钟、超过配置上限也没被砍，事后却无法
 * 从 Attempt 里判断到底是哪条路径。这个映射保持纯函数，才能用断言钉住。
 */
export function workflowUnknownStopReason({ timedOut = false, taskCanceled = false, failureType = null } = {}) {
  if (taskCanceled) return 'canceled-race'
  if (timedOut) return 'timeout'
  if (failureType !== null && failureType !== undefined && failureType !== '') return 'provider-rejected'
  return 'outcome-unknown'
}

export async function waitForWorkflowAgentRun({
  run,
  taskId,
  getTask,
  controller,
  timeoutMs,
  pollIntervalMs = 1000,
  onPollError = () => {},
} = {}) {
  if (!run || !run.result || typeof run.result.then !== 'function') throw new TypeError('run.result must be a Promise')
  if (typeof taskId !== 'string' || taskId.trim() === '') throw new TypeError('taskId is required')
  if (typeof getTask !== 'function') throw new TypeError('getTask must be a function')
  if (!controller || typeof controller.abort !== 'function') throw new TypeError('AbortController is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new TypeError('pollIntervalMs must be positive')

  let taskCanceled = false
  let resultSettled = false
  let finished = false
  let pollInFlight = false
  let failureType
  let resolveResult
  const resultPromise = new Promise((resolve) => { resolveResult = resolve })
  Promise.resolve(run.result).then(
    (result) => { resultSettled = true; resolveResult({ kind: 'result', result }) },
    (error) => { resultSettled = true; failureType = safeFailureType(error); resolveResult({ kind: 'failed', result: null }) },
  )

  const inspectTask = async (force = false) => {
    if (finished || taskCanceled || (resultSettled && !force) || (pollInFlight && !force)) return
    pollInFlight = true
    try {
      const task = await getTask(taskId)
      if (!finished && (task?.status === 'canceled' || task?.goalStatus === 'canceled')) {
        taskCanceled = true
        controller.abort(new Error('Legion workflow task canceled'))
      }
    } catch (error) {
      try { onPollError(error) } catch { /* logging must not affect provider settlement */ }
    } finally {
      pollInFlight = false
    }
  }
  await inspectTask()
  const pollTimer = setInterval(() => { void inspectTask() }, pollIntervalMs)
  let timeoutTimer
  const timeoutPromise = new Promise((resolve) => {
    timeoutTimer = setTimeout(() => {
      controller.abort(new Error('Legion workflow provider timed out'))
      resolve({ kind: 'timeout', result: null })
    }, timeoutMs)
  })
  try {
    const outcome = await Promise.race([resultPromise, timeoutPromise])
    await inspectTask(true)
    return Object.freeze({
      result: outcome.result,
      taskCanceled,
      timedOut: outcome.kind === 'timeout',
      ...(outcome.kind === 'failed' ? { failureType: failureType ?? 'Error' } : {}),
    })
  } finally {
    finished = true
    clearInterval(pollTimer)
    clearTimeout(timeoutTimer)
  }
}

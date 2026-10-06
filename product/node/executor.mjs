// product/node/executor.mjs
// ============================================================================
// 本地执行器接缝（远程 Agent 通道 S-E 之三）
//
// ## 为什么先只有"跑一条本地命令"这一种
//
// 设计文档 §8.2 写得很清楚：「目前 DSH runtime 不是可假定独立存在的通用 Linux
// daemon……将其抽取为通用 daemon 属于单独的解耦工作，不能在本方案中视为零成本
// 部署配置」。
//
// 所以这里**不**假装已经能调 DSH。这里的执行器是一个**明确的接缝**：一个子进程，
// 任务以 JSON 从 stdin 进去，进展/结果以 JSON 行从 stdout 出来。DSH adapter 是
// 这个接缝的**下一个实现**，而不是这里的假设。这样做的好处是：接缝本身现在
// 就能被完整测到（含取消、超时、崩溃），而换执行器不需要改协议层和网关。
//
// ## 子进程输出：只认 JSON 行，其余进本地日志
//
// 未识别为 TODO 的行**不**出境（见 `egress.mjs`）。它们留在本地，
// 供人在电脑上排障。这不是限制，是分工：出境的只有结构化进展。
// ============================================================================
import { spawn } from 'node:child_process'

/** 子进程在 stdout 上认识的帧类型。 */
export const EXECUTOR_FRAMES = Object.freeze(['progress', 'result'])

export const EXECUTOR_CODES = Object.freeze({
  EXIT_NONZERO: 'EXECUTOR_EXIT_NONZERO',
  NO_RESULT: 'EXECUTOR_NO_RESULT',
  BAD_RESULT: 'EXECUTOR_BAD_RESULT',
  TIMEOUT: 'EXECUTOR_TIMEOUT',
  SPAWN_FAILED: 'EXECUTOR_SPAWN_FAILED',
  CANCELLED: 'EXECUTOR_CANCELLED',
  OUTPUT_TOO_LARGE: 'EXECUTOR_OUTPUT_TOO_LARGE',
})

export const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000
/** 单行长度的上限。一行 10MB 的 JSON 会让解析器成为攻击面，也会撑爆内存。 */
export const MAX_LINE_BYTES = 512 * 1024
/** 本地保留的原始日志行数上限（**不**出境）。 */
export const MAX_LOCAL_LOG_LINES = 500

const VALID_OUTCOMES = new Set(['completed', 'failed', 'outcome_unknown', 'cancelled'])

/**
 * 造"跑一条本地命令"的执行器。
 *
 * @param {object} config
 * @param {string} config.command
 * @param {string[]} [config.args]
 * @param {string} [config.cwd]
 * @param {Record<string,string>} [config.env] 额外环境变量（**不会**出境）
 * @param {number} [config.timeoutMs]
 * @param {(line: string) => void} [config.onLocalLog] 未识别的行往哪去
 * @param {Function} [config.spawnFn] 便于受测的接缝
 */
export function createCommandExecutor({
  command,
  args = [],
  cwd = null,
  env = {},
  timeoutMs = DEFAULT_EXECUTOR_TIMEOUT_MS,
  onLocalLog = null,
  spawnFn = spawn,
} = {}) {
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('createCommandExecutor 需要 command')

  return async function runTask({ task, attempt, workspace, onProgress, signal }) {
    const localLog = []
    const pushLog = (line) => {
      if (localLog.length < MAX_LOCAL_LOG_LINES) localLog.push(line)
      if (typeof onLocalLog === 'function') { try { onLocalLog(line) } catch { /* 日志回调失败不影响执行 */ } }
    }

    const child = spawnFn(command, args, {
      cwd: workspace?.path ?? cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let settled = false
    let cancelled = false
    let timedOut = false
    let result = null
    let stdoutBuf = ''
    let overflow = false

    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const onAbort = () => { cancelled = true; kill() }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    function kill() {
      try { child.kill('SIGKILL') } catch { try { child.kill() } catch { /* 已退出 */ } }
    }

    function handleLine(line) {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      if (!trimmed.startsWith('{')) { pushLog(trimmed); return }
      let frame
      try { frame = JSON.parse(trimmed) } catch { pushLog(trimmed); return }
      if (frame === null || typeof frame !== 'object' || !EXECUTOR_FRAMES.includes(frame.type)) {
        pushLog(trimmed)
        return
      }
      if (frame.type === 'progress') {
        // 只把**结构化**的进展交出去。`kind`/`summary` 的合法性由协议层再校验一次
        // ——这里不替它判断，因为"哪些 kind 合法"是协议的事，不是执行器的事。
        if (typeof frame.summary === 'string' && frame.summary.length > 0) {
          onProgress?.({ kind: typeof frame.kind === 'string' ? frame.kind : 'step', summary: frame.summary, detail: frame.detail })
        }
        return
      }
      // result：只认第一条。第二条之后按本地噪音处理——一个执行器报两次结果，
      // 采用哪一条都是猜，而"猜错了"的代价是把失败记成完成。
      if (result === null) {
        if (!VALID_OUTCOMES.has(frame.outcome)) {
          result = { outcome: 'failed', summary: `执行器返回了未登记的 outcome：${JSON.stringify(frame.outcome)}`, artifacts: [], code: EXECUTOR_CODES.BAD_RESULT }
        } else {
          result = {
            outcome: frame.outcome,
            summary: typeof frame.summary === 'string' ? frame.summary : '',
            artifacts: Array.isArray(frame.artifacts) ? frame.artifacts : [],
          }
        }
      } else {
        pushLog(`[忽略] 执行器重复上报结果：${trimmed}`)
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk
      // 单行过长时不解析、直接按本地日志丢下：继续拼接会让内存随输出线性增长。
      if (Buffer.byteLength(stdoutBuf, 'utf8') > MAX_LINE_BYTES) {
        overflow = true
        pushLog('[忽略] 输出行超过上限，未解析')
        stdoutBuf = ''
        return
      }
      let idx = stdoutBuf.indexOf('\n')
      while (idx >= 0) {
        handleLine(stdoutBuf.slice(0, idx))
        stdoutBuf = stdoutBuf.slice(idx + 1)
        idx = stdoutBuf.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim().length > 0) pushLog(line)
    })

// 任务以 JSON 从 stdin 进去。结束 stdin 是**必要的**：不关的话，
    // 一个读 stdin 到 EOF 的执行器会一直等，而超时是 30 分钟。
    //
    // ★ `brief` 与 `task` **并列**给出，而不是塞进 `task` 里。
    //
    //   理由与"为什么 dispatch 帧里 brief 是独立字段"同一条：把新东西塞进一个
    //   既有结构，会让那个结构在两种版本里形状不同——而读的人无从知道手上这份
    //   有没有它。并列的字段可以**缺席**（老执行器读不到就用自己的默认），
    //   而塞进去的字段做不到同样的事。
    //
    //   `brief` 就是"做这件事需要知道的全部"：目标、描述、验收标准、边界。
    //   在它之前，执行器能拿到的只有 `task.title`——而手机建的任务里，
    //   那是**用户消息截断到 200 字**。
    try {
      child.stdin.write(JSON.stringify({
        task,
        brief: task?.brief ?? null,
        attempt,
        workspace: workspace === undefined || workspace === null ? null : { scope: workspace.scope },
      }))
      child.stdin.end()
    } catch { /* 子进程可能已经退出 */ }

    const exit = await new Promise((resolve) => {
      child.on('error', (e) => resolve({ error: e }))
      child.on('close', (code, sig) => resolve({ code, sig }))
    })
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    settled = true

    const base = { localLog: [...localLog], cancelled, timedOut, overflow, exit }
    if (cancelled) return { outcome: 'cancelled', summary: '已按取消请求停止执行', artifacts: [], code: EXECUTOR_CODES.CANCELLED, ...base }
    if (timedOut) return { outcome: 'outcome_unknown', summary: `执行超过 ${timeoutMs}ms 被终止，外部副作用是否发生未知`, artifacts: [], code: EXECUTOR_CODES.TIMEOUT, ...base }
    if (exit.error !== undefined) return { outcome: 'failed', summary: `无法启动执行器：${exit.error.message}`, artifacts: [], code: EXECUTOR_CODES.SPAWN_FAILED, ...base }
    if (result !== null) {
      // ★ 有结果帧时**以结果帧为准**，即使退出码非 0：执行器可能已经完成了工作、
      //   在收尾时因为无关原因退出非零。反过来（有非零退出码就改判失败）会把
      //   一次成功的交付记成失败，而那是"任务被莫名重跑"的来源。
      return { ...result, ...base }
    }
    if (exit.code !== 0) {
      return {
        outcome: 'failed',
        summary: `执行器以退出码 ${exit.code ?? exit.sig} 结束，且没有上报结果`,
        artifacts: [], code: EXECUTOR_CODES.EXIT_NONZERO, ...base,
      }
    }
    // 退出码 0 但没有结果帧：**不**当成完成。退出码只说明进程正常结束，
    // 不说明它做完了任务。这里报"结果未知"而不是"失败"，因为这两者的
    // 后续处置不同：未知要人对账，失败可以按既有重试策略走。
    return {
      outcome: 'outcome_unknown',
      summary: '执行器正常退出但没有上报结果，无法判断任务是否完成',
      artifacts: [], code: EXECUTOR_CODES.NO_RESULT, ...base,
    }
  }
}

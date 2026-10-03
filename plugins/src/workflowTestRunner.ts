import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const EXECUTABLES = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pytest', 'go', 'cargo', 'dotnet'])
const SAFE_ARG = /^[A-Za-z0-9_./:@+=,-]+$/
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const MAX_OUTPUT_BYTES = 256 * 1024
const OUTPUT_EXCERPT_BYTES = 12 * 1024

export interface WorkflowTestRunnerConfig {
  executable: string
  args: string[]
  timeoutMs: number
}

export interface WorkflowTestRunReceipt {
  id: string
  state: 'passed' | 'failed' | 'unknown'
  executable: string
  args: string[]
  timeoutMs: number
  exitCode: number | null
  startedAtMs: number
  finishedAtMs: number
  outputDigest: string
  outputExcerpt: string
  outputTruncated: boolean
  error: string | null
}

export function validateWorkflowTestRunner(runner: WorkflowTestRunnerConfig): string | null {
  if (runner === null || typeof runner !== 'object' || !EXECUTABLES.has(runner.executable)) return 'runner executable 不受支持'
  if (!Array.isArray(runner.args) || runner.args.length === 0 || runner.args.length > 128
    || runner.args.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.length > 512 || !SAFE_ARG.test(arg))) {
    return 'runner argv 不符合无 shell 参数契约'
  }
  if (!Number.isSafeInteger(runner.timeoutMs) || runner.timeoutMs < 1000 || runner.timeoutMs > MAX_TIMEOUT_MS) return 'runner timeoutMs 超出允许范围'
  return null
}

function runnerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1' }
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (source[key]) env[key] = source[key]
  }
  return env
}

function redactOutput(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

async function terminateTree(child: ReturnType<typeof spawn>, spawnImpl: typeof spawn): Promise<void> {
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise<void>((resolve) => {
      const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
    return
  }
  try { if (Number.isInteger(child.pid)) process.kill(-child.pid!, 'SIGKILL') } catch { /* exited */ }
}

function resolveRunnerCommand(executable: string): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: executable, args: [] }
  if (executable === 'npm') {
    const searchDirs = [...new Set([
      dirname(process.execPath),
      ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    ])]
    const npmCli = searchDirs
      .map((directory) => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
      .find(existsSync)
    if (npmCli === undefined) throw new Error('Windows npm runner 找不到 npm-cli.js；请检查 npm 与 Node 安装')
    return { file: process.execPath, args: [npmCli] }
  }
  if (executable === 'pnpm' || executable === 'yarn') {
    throw new Error(`Windows ${executable} shim 需要 shell 启动，独立测试 runner 不允许 shell；请使用 npm 或原生 executable`)
  }
  return { file: executable, args: [] }
}

/** Run only a workflow-frozen executable/argv, in the implementation worktree, without a shell. */
export async function runWorkflowTestCommand({
  runner,
  cwd,
  id = `wft-${randomUUID()}`,
  spawnImpl = spawn,
  now = Date.now,
}: {
  runner: WorkflowTestRunnerConfig
  cwd: string
  id?: string
  spawnImpl?: typeof spawn
  now?: () => number
}): Promise<WorkflowTestRunReceipt> {
  const invalid = validateWorkflowTestRunner(runner)
  if (invalid) throw new TypeError(invalid)
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new TypeError('独立测试 runner 缺少 worktree cwd')
  if (!/^wft-[0-9a-f-]{36}$/i.test(id)) throw new TypeError('testRunId 必须是 wft- 前缀的 UUID')

  const startedAtMs = now()
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let outputBytes = 0
  let totalOutputBytes = 0
  let exitCode: number | null = null
  let spawnError: Error | null = null
  let timedOut = false
  let child: ReturnType<typeof spawn>
  try {
    const command = resolveRunnerCommand(runner.executable)
    child = spawnImpl(command.file, [...command.args, ...runner.args], {
      cwd,
      env: runnerEnvironment(process.env),
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const collect = (part: Buffer | string): void => {
      const bytes = Buffer.from(part)
      hash.update(bytes)
      totalOutputBytes += bytes.length
      if (outputBytes < MAX_OUTPUT_BYTES) {
        const kept = bytes.subarray(0, MAX_OUTPUT_BYTES - outputBytes)
        chunks.push(kept)
        outputBytes += kept.length
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const finished = new Promise<number | null>((resolve) => {
      child.once('error', (error) => { spawnError = error; resolve(null) })
      child.once('close', (code) => { exitCode = code; resolve(code) })
    })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null) }, runner.timeoutMs) })
    await Promise.race([finished, timeout])
    clearTimeout(timer)
    if (timedOut && child.exitCode === null && child.signalCode === null) {
      await terminateTree(child, spawnImpl)
      await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
    if (timedOut) exitCode = null
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error))
  }

  const output = redactOutput(Buffer.concat(chunks).toString('utf8'))
  const state = timedOut ? 'unknown' : spawnError || exitCode !== 0 ? 'failed' : 'passed'
  return {
    id,
    state,
    executable: runner.executable,
    args: [...runner.args],
    timeoutMs: runner.timeoutMs,
    exitCode,
    startedAtMs,
    finishedAtMs: now(),
    outputDigest: hash.digest('hex'),
    outputExcerpt: output.slice(-OUTPUT_EXCERPT_BYTES),
    outputTruncated: totalOutputBytes > MAX_OUTPUT_BYTES,
    error: spawnError ? redactOutput(String(spawnError)).slice(0, 1000) : null,
  }
}

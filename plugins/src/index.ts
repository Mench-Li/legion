/**
 * @dsh-external/dsh-scrum-worker — 军团士兵轮询守护（daemon-loop 形态）。
 *
 * 每 intervalMs 扫一次任务看板（legion/scrum/tasks.json 权威库，经 taskctl 访问）：
 *   1. todo 任务 → 认领（互斥由状态机保证）→ 派一次性 worker subagent
 *      （携带任务完整上下文：标题/描述/验收/评论/依赖）→ 完成后提交 in_review。
 *   2. in_progress 且属于本角色、认领之后有他人评论的任务 → 视为被将军退回，
 *      派纠错 worker（提示词附最新退回评论）。
 *   3. blocked 且属于本角色、依赖已全部解除的任务 → 解阻认领 → 派 worker 续做。
 *
 * done 永远由用户在拖拽中决定：本守护最多把任务提交到 in_review。
 * worker 是一次性 subagent（spawn-in-process），父为启动时惰性创建的 foreman agent，
 * 工作目录 = 仓库根。worker 只做实现并回报 {status, summary, evidence, blocker}，
 * 状态迁移一律由守护经 taskctl 完成（taskctl 是唯一变更入口，乐观锁/角色纪律服务端强制）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-default-model'

type AppContext = Context & {
  subagents: SubagentRuntime
  setInterval(fn: () => void, ms: number): any
}

export const name = '@dsh-external/dsh-scrum-worker'
export const inject = ['timer', 'agents', 'subagents', 'agentDefaultModel']

export interface Config {
  /** 守护士兵身份：认领与提交验收时使用的角色名。 */
  role: string
  /** 扫单间隔（毫秒）。 */
  intervalMs: number
  /** 并发 worker 上限。 */
  maxWorkers: number
  /** 单个 worker 超时（毫秒），超时后中止并留待下一轮。 */
  workerTimeoutMs: number
  /** ctx.subagents 上注册的 provider 名（spawn-in-process 默认注册为 spawn）。 */
  provider: string
  /** legion/scrum 目录（taskctl.mjs 所在）。 */
  scrumDir: string
  /** worker 工作目录（仓库根）。 */
  workspace: string
  logFile: string
}

export const Config = z.object({
  role: z.string().default('soldier-auto'),
  intervalMs: z.number().min(5000).default(30000),
  maxWorkers: z.number().min(1).max(8).default(1),
  workerTimeoutMs: z.number().min(60000).default(600000),
  provider: z.string().default('spawn'),
  scrumDir: z.string().default('D:/project/dsh/legion/scrum'),
  workspace: z.string().default('D:/project/dsh'),
  logFile: z.string().default(''),
})

/** 任务记录（taskctl 输出的字段子集，按需扩展）。 */
interface Task {
  id: string
  title: string
  description: string
  acceptance: string[]
  priority: string
  status: string
  version: number
  soldier: string | null
  claimedAt: string | null
  blockedBy: string[]
  comments: Array<{ by: string; at: string; text: string }>
}

/** worker 结构回报。 */
interface WorkerReport {
  status: 'done' | 'blocked'
  summary: string
  evidence: string
  blocker: string
}

const WORKER_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence'],
  additionalProperties: false,
}

/** 以子进程方式执行 taskctl 命令，成功解析 stdout JSON。 */
function runTaskctl(scrumDir: string, argv: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(scrumDir, 'taskctl.mjs'), ...argv], { cwd: join(scrumDir, '..') })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', e => reject(e))
    proc.on('close', code => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out))
        } catch {
          reject(new Error(`taskctl 输出不是 JSON：${out.slice(0, 200)}`))
        }
      } else {
        reject(new Error(err.trim() || `taskctl 退出码 ${code}`))
      }
    })
  })
}

export function apply(ctx: AppContext, config: Config): void {
  const SHORT = 'dsh-scrum-worker'
  const logFile = config.logFile || join(homedir(), '.dsh', 'super-injector', SHORT + '.log')
  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  let foreman: Agent | undefined
  let disposeForeman: (() => Promise<void>) | undefined
  const inflight = new Set<string>()
  const controllers = new Set<AbortController>()
  let sweeping = false

  const listTasks = () => runTaskctl(config.scrumDir, ['list']) as Promise<Task[]>
  const getTask = (id: string) => runTaskctl(config.scrumDir, ['get', id]) as Promise<Task>

  /** 惰性创建 foreman agent：worker subagent 的父（提供工作区、谱系与模型路由）。 */
  async function ensureForeman(): Promise<void> {
    if (foreman !== undefined) return
    try {
      const selection = ctx.agentDefaultModel.currentSelection()
      const handle = await ctx.agents.create({
        sessionId: SessionId('scrum-worker-foreman'),
        meta: { cwd: config.workspace },
        agentOptions: { provider: selection.provider, model: selection.model },
      })
      foreman = handle.agent
      disposeForeman = () => handle.dispose()
      log(`foreman 就绪：${handle.agent.session.id}（cwd=${config.workspace}，model=${selection.provider}/${selection.model}）`)
    } catch (e) {
      log(`foreman 创建失败（本轮跳过派工）：${String(e)}`)
    }
  }

  /** 带乐观锁的状态迁移：先重读任务取最新 version。 */
  async function transitionTo(id: string, to: string): Promise<void> {
    const t = await getTask(id)
    await runTaskctl(config.scrumDir, ['transition', id, '--to', to, '--by', config.role, '--if-version', String(t.version)])
  }

  /** 追加评论（失败不抛出，避免污染主流程）。 */
  async function safeComment(id: string, text: string): Promise<void> {
    try {
      await runTaskctl(config.scrumDir, ['comment', id, '--by', config.role, '--text', text.slice(0, 800)])
    } catch (e) {
      log(`comment ${id} 失败：${String(e)}`)
    }
  }

  function buildWorkerPrompt(t: Task, feedback: Task['comments']): string {
    const lines = [
      `你是军团士兵 ${config.role}（守护循环派发的临时 worker），任务 ${t.id} 由你独立完成。`,
      '',
      `工作目录（仓库根）：${config.workspace}`,
      `任务看板：${config.scrumDir}（taskctl 是唯一变更入口，但你不要调用它）`,
      '',
      `任务：${t.title}`,
      t.description ? `描述：${t.description}` : '描述：（无）',
      '验收标准（必须逐条真实满足，并在证据中对应说明）：',
      ...(t.acceptance.length > 0 ? t.acceptance.map(a => `- ${a}`) : ['- （未填写，请自行判断合理的完成标准并写明）']),
      t.blockedBy.length > 0 ? `依赖（应已完成）：${t.blockedBy.join(', ')}` : '',
      '',
      '历史评论（含将军的退回反馈，必须处理）：',
      ...(t.comments.length > 0
        ? t.comments.map(c => `- @${c.by}（${c.at}）: ${c.text}`)
        : ['- （无）']),
      '',
      '纪律：',
      '1. 只做实现与验证；不要调用任何 taskctl / task_* / 看板写接口——状态迁移由守护负责，你只负责把代码和验证做好。',
      '2. 完成标准 = 验收标准逐条真实满足：跑真实命令验证（typecheck / build / test），给出证据。',
      '3. 改动落在工作目录内；如需更新 legion 文档一并更新。',
      '4. 最终回复只输出 JSON 报告，不要额外叙述：',
      '   {"status":"done","summary":"一句话总结","evidence":"验证证据（命令与输出要点）","blocker":""}',
      '   或 {"status":"blocked","summary":"已完成的部分","evidence":"","blocker":"卡在哪个文件/命令/什么报错（必须具体）"}',
      '',
    ]
    return lines.filter(l => l.length > 0).join('\n')
  }

  /** 派一个 worker 处理任务（认领已完成或任务本身可开工）。 */
  async function runWorker(t: Task, feedback: Task['comments']): Promise<void> {
    await ensureForeman()
    if (foreman === undefined) {
      log(`${t.id} 跳过：foreman 不可用`)
      return
    }
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), config.workerTimeoutMs)
    const run = await (async () => {
      try {
        return await ctx.subagents.start(config.provider, {
          label: `scrum:${t.id}`,
          prompt: [{ type: 'text', text: buildWorkerPrompt(t, feedback) }],
          parent: foreman,
          signal: controller.signal,
          outputSchema: WORKER_SCHEMA,
        })
      } catch (e) {
        log(`${t.id} 派工失败：${String(e)}`)
        await safeComment(t.id, `⚠ 派工失败：${String(e).slice(0, 200)}`)
        return undefined
      } finally {
        clearTimeout(timer)
        controllers.delete(controller)
      }
    })()
    if (run === undefined) return
    const result = await run.result
    await run.dispose()
    if (result.stopReason !== 'completed' || result.structured === undefined) {
      log(`${t.id} worker 未完成（${result.stopReason}）`)
      await safeComment(t.id, `⚠ worker 未完成（${result.stopReason}），任务保留在 in_progress，等待人工处理或下一轮重试`)
      return
    }
    const report = result.structured as WorkerReport
    if (report.status === 'done') {
      await transitionTo(t.id, 'in_review')
      await safeComment(t.id, `✓ 完成并提交验收：${report.summary}\n证据：${report.evidence}`)
      log(`${t.id} → in_review（${report.summary}）`)
    } else {
      await safeComment(t.id, `⚠ 受阻：${report.blocker || report.summary}`)
      await transitionTo(t.id, 'blocked')
      log(`${t.id} → blocked（${report.blocker || report.summary}）`)
    }
  }

  /** 认领 todo 并派工。 */
  async function workTodo(t: Task): Promise<void> {
    try {
      await runTaskctl(config.scrumDir, ['claim', t.id, '--soldier', config.role])
    } catch (e) {
      log(`${t.id} 认领失败（可能已被他人认领）：${String(e)}`)
      return
    }
    await runWorker(t, [])
  }

  /** 处理被退回/解阻的任务。 */
  async function workReturned(t: Task, feedback: Task['comments']): Promise<void> {
    await runWorker(t, feedback)
  }

  /** 一轮扫单：todo 认领派工；本角色的退回任务纠错；依赖解除的 blocked 续做。 */
  async function sweep(): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      await ensureForeman()
      let tasks: Task[]
      try {
        tasks = await listTasks()
      } catch (e) {
        log(`list 失败：${String(e)}`)
        return
      }
      const byId = new Map(tasks.map(t => [t.id, t]))
      const room = () => inflight.size < config.maxWorkers

      // 1. todo：认领（互斥）→ 派工
      for (const t of tasks.filter(t => t.status === 'todo')) {
        if (!room() || inflight.has(t.id)) continue
        inflight.add(t.id)
        void workTodo(t).finally(() => inflight.delete(t.id))
      }
      // 2. blocked 且本角色、依赖已全部解除：解阻续做
      for (const t of tasks.filter(t => t.status === 'blocked' && t.soldier === config.role)) {
        if (!room() || inflight.has(t.id)) continue
        const open = t.blockedBy.filter(depId => {
          const dep = byId.get(depId)
          return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
        })
        if (open.length > 0) continue
        inflight.add(t.id)
        void workReturned(t, []).finally(() => inflight.delete(t.id))
      }
      // 3. in_progress 且本角色、认领后有他人评论：视为退回，附反馈纠错
      for (const t of tasks.filter(t => t.status === 'in_progress' && t.soldier === config.role)) {
        if (!room() || inflight.has(t.id)) continue
        const feedback = t.comments.filter(c =>
          c.by !== config.role && (t.claimedAt === null || new Date(c.at) > new Date(t.claimedAt)))
        if (feedback.length === 0) continue
        inflight.add(t.id)
        void workReturned(t, feedback).finally(() => inflight.delete(t.id))
      }
    } finally {
      sweeping = false
    }
  }

  ctx.setInterval(() => {
    void sweep().catch(e => log(`sweep 异常：${String(e)}`))
  }, config.intervalMs)

  ctx.effect(() => () => {
    for (const c of controllers) c.abort()
    if (disposeForeman !== undefined) {
      void disposeForeman().catch(e => log(`foreman 释放失败：${String(e)}`))
      disposeForeman = undefined
    }
  }, `${name}: teardown`)

  ctx.logger?.info?.(`[${name}] 士兵守护启动（角色=${config.role}，每 ${config.intervalMs}ms 扫单，并发=${config.maxWorkers}，看板=${config.scrumDir}）`)
}

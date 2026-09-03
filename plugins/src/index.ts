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
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'

type AppContext = Context & {
  subagents: SubagentRuntime
  agentPresets: AgentPresets
  setInterval(fn: () => void, ms: number): any
}

export const name = '@dsh-external/dsh-scrum-worker'
export const inject = ['timer', 'agents', 'subagents', 'agentDefaultModel', 'agentPresets']

export interface Config {
  /** 守护士兵身份：认领与提交验收时使用的角色名。 */
  role: string
  /** 扫单间隔（毫秒）。 */
  intervalMs: number
  /** 并发 worker 上限。 */
  maxWorkers: number
  /** 单个 worker 超时（毫秒），超时后中止并留待下一轮。 */
  workerTimeoutMs: number
  /** 认领租约：in_progress 认领超过该分钟数无进展则由守护释放回 todo（须 > workerTimeoutMs/60000）。 */
  staleMinutes: number
  /** 任务级 TTL（分钟）：认领后超时未完成即由守护释放回 todo（0 = 不设 TTL，靠 staleMinutes 兜底）。 */
  taskTtlMinutes: number
  /** ctx.subagents 上注册的 provider 名（spawn-in-process 默认注册为 spawn）。 */
  provider: string
  /** foreman 使用的 agent preset；worker 子 agent 会继承其工具与提示词。 */
  agentPreset: string
  /** legion/scrum 目录（taskctl.mjs 所在）。 */
  scrumDir: string
  /** worker 工作目录（仓库根，isolate=false 时使用）。 */
  workspace: string
  /** 是否用 git worktree 隔离每个任务的改动（需 repoRoot 是 git 仓库；promote 显式）。 */
  isolate: boolean
  /** worktree 隔离所用的 git 仓库根（legion 仓库）。 */
  repoRoot: string
  /** worktree 目录根（默认 repoRoot/.legion-worktrees）。 */
  worktreeRoot: string
  /** worker 禁用的全局工具名（toolFilter.deny 只认全局工具；web_search/web_fetch 是本地工具无法过滤，断网靠提示词纪律）。 */
  denyTools: string[]
  /** 多角色流水线定义文件（默认 repoRoot/roles.json；存在则进入流水线模式）。 */
  rolesFile: string
  logFile: string
  /** team-hub 地址（如 http://127.0.0.1:3080/team-hub）；非空则任务池读写走 hub（带身份 + scope）。 */
  hubUrl: string
  /** hub Bearer token（hub 开启鉴权时必填）。 */
  hubToken: string
  /** 守护负责的项目 scope（默认 default；goal 发布目标时默认用 roles.json 的 name）。 */
  scope: string
}

export const Config = z.object({
  role: z.string().default('soldier-auto'),
  intervalMs: z.number().min(5000).default(30000),
  maxWorkers: z.number().min(1).max(8).default(1),
  workerTimeoutMs: z.number().min(60000).default(600000),
  staleMinutes: z.number().min(5).default(30),
  taskTtlMinutes: z.number().min(0).default(0),
  provider: z.string().default('spawn'),
  agentPreset: z.string().default('code'),
  scrumDir: z.string().default('D:/project/dsh/legion/scrum'),
  workspace: z.string().default('D:/project/dsh'),
  isolate: z.boolean().default(true),
  repoRoot: z.string().default('D:/project/dsh/legion'),
  worktreeRoot: z.string().default(''),
  denyTools: z.array(z.string()).default([]),
  rolesFile: z.string().default(''),
  logFile: z.string().default(''),
  hubUrl: z.string().default(''),
  hubToken: z.string().default(''),
  scope: z.string().default('default'),
})

/** 任务记录（taskctl 输出的字段子集，按需扩展）。 */
interface Task {
  id: string
  title: string
  description: string
  acceptance: string[]
  /** 边界（做什么/不做什么，team-hub 生成任务时自动注入；file 模式可能缺失）。 */
  boundary?: { do: string[]; dont: string[] }
  priority: string
  status: string
  version: number
  soldier: string | null
  claimedAt: string | null
  parent: string | null
  role: string | null
  scope?: string
  /** 将军逐任务拦截（hold=true 时本守护不得自动认领/执行）。 */
  hold?: boolean
  blockedBy: string[]
  comments: Array<{ by: string; at: string; text: string }>
}

/** 多角色流水线中的一个阶段（角色）。 */
interface StageDef {
  role: string
  label: string
  prompt: string
  next: string | null
}

/** 需求讨论配置：哪些角色参与群聊 + 最多讨论几轮。 */
interface DiscussionDef {
  maxRounds: number
  roles: string[]
}

interface PipelineDef {
  name: string
  discussion?: DiscussionDef
  stages: StageDef[]
}

/** worker 结构回报。 */
interface WorkerReport {
  status: 'done' | 'blocked'
  summary: string
  evidence: string
  blocker: string
  artifact: WorkerArtifact | null
}

/** worker 产物（借鉴 dsh-worktable 的 widget-result.json 握手：html 看板 iframe 预览、file 链接、url 跳转）。 */
interface WorkerArtifact {
  kind: 'html' | 'file' | 'url'
  path: string
  title: string
}

/** 讨论发言（陈述）的结构化回报。 */
interface SpeakerReport {
  position: string
  concerns: string
  suggestions: string
}

/** 头脑风暴交锋（回应他人观点）的结构化回报。 */
interface ReplyReport {
  challenges: string
  insights: string
}

/** 将军（主持人）收敛判断 + 点名矛盾的结构化回报。 */
interface ModeratorReport {
  converged: boolean
  final_direction: string
  remaining_conflicts: string[]
  next_focus: string
}

const WORKER_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'string' },
    blocker: { type: 'string' },
    artifact: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['html', 'file', 'url'] },
        path: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['kind', 'path'],
      additionalProperties: false,
    },
  },
  required: ['status', 'summary', 'evidence'],
  additionalProperties: false,
}

const SPEAKER_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    position: { type: 'string' },
    concerns: { type: 'string' },
    suggestions: { type: 'string' },
  },
  required: ['position'],
  additionalProperties: false,
}

const REPLY_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    challenges: { type: 'string' },
    insights: { type: 'string' },
  },
  required: ['challenges', 'insights'],
  additionalProperties: false,
}

const MODERATOR_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    converged: { type: 'boolean' },
    final_direction: { type: 'string' },
    remaining_conflicts: { type: 'array', items: { type: 'string' } },
    next_focus: { type: 'string' },
  },
  required: ['converged', 'final_direction'],
  additionalProperties: false,
}

/** 以子进程方式执行 taskctl 命令，成功解析 stdout JSON。 */
function runTaskctl(scrumDir: string, argv: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(scrumDir, 'taskctl.mjs'), ...argv], {
      cwd: join(scrumDir, '..'),
      // Electron 里 process.execPath 是 DSH Desktop.exe（不是 node）；
      // ELECTRON_RUN_AS_NODE=1 让它当 node 用。普通 node 进程里该变量是 no-op，双环境通用。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
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

/** 短字符串哈希（用于按 cwd 生成稳定的 foreman sessionId）。 */
function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return String(Math.abs(h))
}

/** 以子进程方式执行 git（worktree 隔离用），返回 { code, out, err }。 */
function runGit(repoRoot: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const proc = spawn('git', args, { cwd: repoRoot })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', () => resolve({ code: -1, out, err: 'git 不可用' }))
    proc.on('close', code => resolve({ code: code ?? -1, out, err }))
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

  /** 看板动态事件流：追加结构化事件到 scrum/activity.jsonl（serve.mjs 经 SSE 推给看板）。 */
  const activityFile = join(config.scrumDir, 'activity.jsonl')
  const activity = (kind: string, taskId: string, text: string): void => {
    try {
      mkdirSync(dirname(activityFile), { recursive: true })
      appendFileSync(activityFile, `${JSON.stringify({ ts: new Date().toISOString(), kind, taskId, text })}\n`)
    } catch { /* 动态写入失败静默，不影响派工 */ }
  }

  const foremen = new Map<string, { agent: Agent; dispose: () => Promise<void> }>()
  /** foreman 创建中的 promise 去重：同 cwd 并发请求只创建一次（isolate=false 且 maxWorkers>1 时多个 worker 同 cwd 的竞态防护） */
  const foremanPending = new Map<string, Promise<Agent | undefined>>()
  /** 中止类重试的退避时间戳：taskId → 上次「worker 未完成/派工失败」重试时间（防故障期热循环） */
  const abortRetryAt = new Map<string, number>()
  const inflight = new Set<string>()
  const controllers = new Set<AbortController>()
  let sweeping = false
  /** 暂停提示节流：避免每轮扫单都打日志。 */
  let lastPausedNotice = 0

  let hubUrl = config.hubUrl.replace(/\/+$/, '')
  let useHub = hubUrl !== ''

  /** 探测默认 hub（未显式配置 hubUrl 时）：同机 DSH web 端口的 /team-hub，或 v2 独立服务 8787。 */
  async function detectHub(): Promise<void> {
    if (useHub) return
    const candidates = ['http://127.0.0.1:8787', 'http://127.0.0.1:3080/team-hub']
    for (const url of candidates) {
      try {
        const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          hubUrl = url
          useHub = true
          log(`探测到 team-hub：${url}，任务池读写走 hub（scope=${scope}）`)
          return
        }
      } catch { /* 探测失败继续下一个 */ }
    }
  }

  /** hub 写调用（POST，带 token；body 里带 by + scope）。 */
  async function hubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.hubToken !== '' ? { authorization: `Bearer ${config.hubToken}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `hub ${path} 失败（${res.status}）`))
    return data.task ?? data
  }

  /** hub 读任务列表（按 scope 过滤）。 */
  async function hubList(): Promise<Task[]> {
    const res = await fetch(`${hubUrl}/api/board?scope=${encodeURIComponent(scope)}`)
    if (!res.ok) throw new Error(`hub board 失败（${res.status}）`)
    return res.json() as Promise<Task[]>
  }

  /** 团队共享技能：从 hub 拉取本 scope + 授权给本角色的技能（缓存在内存，随 sweep 刷新）。 */
  let sharedSkills: Array<{ id: string; name: string; prompt: string }> = []
  async function fetchSkills(): Promise<void> {
    if (!useHub) return
    try {
      const res = await fetch(`${hubUrl}/api/skills?scope=${encodeURIComponent(scope)}&member=${encodeURIComponent(config.role)}`)
      if (!res.ok) return
      const skills = await res.json() as Array<{ id: string; name: string; prompt: string }>
      if (sharedSkills.length !== skills.length) {
        sharedSkills = skills
        log(`团队技能同步：${skills.map(s => s.id).join(', ') || '（无）'}（scope=${scope}）`)
      }
    } catch { /* 技能拉取失败不影响派工 */ }
  }

  const listTasks = (): Promise<Task[]> => useHub ? hubList() : (runTaskctl(config.scrumDir, ['list']) as Promise<Task[]>)
  const getTask = async (id: string): Promise<Task> => {
    if (useHub) {
      const t = (await hubList()).find(x => x.id === id)
      if (t === undefined) throw new Error(`未知任务 ${id}`)
      return t
    }
    return runTaskctl(config.scrumDir, ['get', id]) as Promise<Task>
  }

  /** 多角色流水线：读 roles.json，存在则进入流水线模式（按角色派工 + done 自动流转）。 */
  const rolesFilePath = config.rolesFile || join(config.repoRoot, 'roles.json')
  function readPipeline(): PipelineDef | null {
    try {
      if (!existsSync(rolesFilePath)) return null
      const raw = JSON.parse(readFileSync(rolesFilePath, 'utf8'))
      if (!Array.isArray(raw.stages) || raw.stages.length === 0) return null
      return raw as PipelineDef
    } catch (e) {
      log(`roles.json 读取失败（按单角色模式运行）：${String(e)}`)
      return null
    }
  }
  const pipeline = readPipeline()
  const stageByRole = new Map<string, StageDef>((pipeline?.stages ?? []).map(s => [s.role, s]))
  const isPipeline = pipeline !== null
  // 需求讨论群聊：讨论配置缺省时用全部流水线角色，最多 3 轮。
  const discussion = pipeline?.discussion
  const discussionMembers: StageDef[] = (discussion?.roles ?? (pipeline?.stages ?? []).map(s => s.role))
    .map(r => stageByRole.get(r))
    .filter((s): s is StageDef => s !== undefined)
  const discussionMaxRounds = discussion?.maxRounds ?? 3
  const isDiscussion = discussion !== undefined && discussionMembers.length > 0
  // 项目 scope：显式配置优先，否则用 roles.json 的 name（软件流水线 = software），再否则 default。
  const scope = config.scope !== 'default' ? config.scope : (pipeline?.name ?? 'default')

  // ── 空间仓库绑定：每个工作空间可配置自己的「本地文件夹 + 远程仓库」（team-hub /api/spaces，
  //    军团指挥台「空间设置」维护——选文件夹而非手填，自动识别该 git 仓库的远程）。
  //    守护在 hub 模式下每轮扫单刷新本 scope 的绑定：
  //    命中 localDir 时，worker 工作目录 = 该文件夹；隔离仓库根（worktree/pre-push 守卫/LEGION.md/自动 promote）
  //    = 该文件夹所属的 git 仓库根（文件夹本身就是仓库根时二者相同；子目录则向上取 toplevel）。
  //    remoteUrl 只作登记与提示——push 纪律不变（w/* 分支一律禁止 push，本地/私有空间 remoteUrl 为空 = 不进共享仓库）。
  //    未绑定 / hub 不可达时全部回退注入配置（repoRoot/workspace/worktreeRoot）。
  let spaceBinding: { localDir: string; repoRoot: string; remoteUrl: string } | null = null

  async function refreshSpaceBinding(): Promise<void> {
    if (!useHub) return
    try {
      const res = await fetch(`${hubUrl}/api/spaces`)
      if (!res.ok) return
      const data = await res.json() as { spaces?: Array<{ id: string; localDir?: string; remoteUrl?: string }> }
      const hit = (data.spaces ?? []).find(x => x.id === scope)
      let next: { localDir: string; repoRoot: string; remoteUrl: string } | null = null
      if (hit && typeof hit.localDir === 'string' && hit.localDir.trim() !== '') {
        const localDir = hit.localDir.trim()
        // 选中的目录可能在某 git 仓库内部：隔离仓库根取所属仓库根（toplevel），worker 目录仍用所选目录。
        let repoRoot = localDir
        try {
          const r = await runGit(localDir, ['rev-parse', '--show-toplevel'])
          if (r.code === 0 && r.out.trim().length > 0) repoRoot = r.out.trim()
        } catch { /* 非仓库目录沿用所选目录 */ }
        next = { localDir, repoRoot, remoteUrl: typeof hit.remoteUrl === 'string' ? hit.remoteUrl.trim() : '' }
      }
      if ((next?.localDir ?? '') !== (spaceBinding?.localDir ?? '') || (next?.repoRoot ?? '') !== (spaceBinding?.repoRoot ?? '')) {
        spaceBinding = next
        log(next
          ? `空间仓库绑定：scope=${scope} → 本地文件夹=${next.localDir}（隔离仓库根=${next.repoRoot === next.localDir ? next.localDir : next.repoRoot}；远程=${next.remoteUrl || '仅本地 / 不进共享仓库'}）`
          : `空间仓库绑定：scope=${scope} 未配置，沿用注入默认仓库（repoRoot=${config.repoRoot}）`)
      }
    } catch (e) {
      log(`空间仓库绑定刷新失败（沿用注入默认）：${String(e)}`)
    }
  }

  /** 该 scope 实际使用的隔离 git 仓库根（空间绑定仓库根优先，注入配置兜底）。 */
  function repoRootFor(): string { return spaceBinding?.repoRoot || config.repoRoot }
  /** 该 scope 实际使用的 worker 工作目录（isolate=false / worktree 不可用 / 讨论时；= 绑定的本地文件夹）。 */
  function workspaceFor(): string { return spaceBinding?.localDir || config.workspace }
  /** 该 scope 实际使用的 worktree 目录根。 */
  function worktreeRootFor(): string { return config.worktreeRoot || join(repoRootFor(), '.legion-worktrees') }

  // ── 全局暂停开关：serve.mjs 的 POST /api/pause 写 scrum/control.json {paused:true}。
  // 独立小文件而非 daemon.json 字段，避免守护每轮重写 daemon.json 与暂停写入互相覆盖。
  const controlFile = join(config.scrumDir, 'control.json')
  function readControlPaused(): boolean {
    try {
      const raw = readFileSync(controlFile, 'utf8')
      return (JSON.parse(raw) as { paused?: boolean }).paused === true
    } catch {
      return false
    }
  }

  // ── 守护能力自述：daemon.json 心跳（借鉴 agent-network 的宿主 daemon 能力上报）──
  const daemonStartedAt = Date.now()
  const daemonStatusFile = join(config.scrumDir, 'daemon.json')
  function writeDaemonStatus(inboxCount: number): void {
    try {
      const selection = ctx.agentDefaultModel.currentSelection()
      const status = {
        role: config.role,
        provider: config.provider,
        maxWorkers: config.maxWorkers,
        isolate: config.isolate,
        intervalMs: config.intervalMs,
        workerTimeoutMs: config.workerTimeoutMs,
        staleMinutes: config.staleMinutes,
        taskTtlMinutes: config.taskTtlMinutes,
        scope,
        paused: readControlPaused(),
        pipeline: pipeline ? { name: pipeline.name, stages: pipeline.stages.map(s => s.role) } : null,
        inbox: inboxCount,
        lastSweepAt: new Date().toISOString(),
        uptimeMs: Date.now() - daemonStartedAt,
        model: { provider: selection.provider, model: selection.model },
        repo: {
          root: repoRootFor(),
          binding: spaceBinding ? `space:${scope}` : 'default',
          localDir: spaceBinding?.localDir ?? '',
          remoteUrl: spaceBinding?.remoteUrl ?? '',
        },
      }
      mkdirSync(dirname(daemonStatusFile), { recursive: true })
      writeFileSync(daemonStatusFile, `${JSON.stringify(status, null, 2)}\n`)
    } catch (e) {
      log(`daemon.json 写入失败：${String(e)}`)
    }
  }
  writeDaemonStatus(0)

  /** 惰性创建 foreman agent：worker subagent 的父（按工作目录缓存；worktree 隔离时每个 worktree 一个）。 */
  async function ensureForeman(cwd: string): Promise<Agent | undefined> {
    const existing = foremen.get(cwd)
    if (existing !== undefined) return existing.agent
    const pending = foremanPending.get(cwd)
    if (pending !== undefined) return pending
    const creating = (async () => {
      try {
        const selection = ctx.agentDefaultModel.currentSelection()
        const handle = await ctx.agents.create({
          sessionId: SessionId(`scrum-worker-foreman-${hashStr(cwd)}`),
          meta: { cwd },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, config.agentPreset),
        })
        foremen.set(cwd, { agent: handle.agent, dispose: () => handle.dispose() })
        log(`foreman 就绪：${handle.agent.session.id}（cwd=${cwd}，model=${selection.provider}/${selection.model}）`)
        return handle.agent
      } catch (e) {
        log(`foreman 创建失败（本轮跳过派工，cwd=${cwd}）：${String(e)}`)
        return undefined
      } finally {
        foremanPending.delete(cwd)
      }
    })()
    foremanPending.set(cwd, creating)
    return creating
  }

  /**
   * 带乐观锁的状态迁移：先重读任务取最新 version。
   * by 默认取任务当前认领者（soldier）——流水线模式下认领者 = 阶段角色（如 devops），
   * in_review 提交校验要求 by === soldier，若硬编码 config.role 会在最终阶段被 taskctl 拒绝。
   */
  async function transitionTo(id: string, to: string): Promise<void> {
    const t = await getTask(id)
    const by = t.soldier ?? config.role
    if (useHub) {
      await hubPost('/api/transition', { id, to, by, ifVersion: t.version, scope: scope })
      return
    }
    await runTaskctl(config.scrumDir, ['transition', id, '--to', to, '--by', by, '--if-version', String(t.version)])
  }

  /** 流水线自动推进：in_progress/in_review → done（推进者=任务角色，将军已授权整条流水线）。 */
  async function advanceTo(id: string, by: string): Promise<void> {
    const t = await getTask(id)
    if (useHub) {
      await hubPost('/api/advance', { id, by, ifVersion: t.version, scope: scope })
      return
    }
    await runTaskctl(config.scrumDir, ['advance', id, '--by', by, '--if-version', String(t.version)])
  }

  /** 追加评论（失败不抛出，避免污染主流程）。 */
  async function safeComment(id: string, text: string): Promise<void> {
    try {
      if (useHub) {
        await hubPost('/api/comment', { id, by: config.role, text: text.slice(0, 800), scope: scope })
      } else {
        await runTaskctl(config.scrumDir, ['comment', id, '--by', config.role, '--text', text.slice(0, 800)])
      }
    } catch (e) {
      log(`comment ${id} 失败：${String(e)}`)
    }
  }

  /** 进度心跳（遥测）：本地走 taskctl progress，hub 走 /api/progress。失败不抛，避免污染派工主流程。 */
  async function reportProgress(id: string, percent: number, note: string): Promise<void> {
    try {
      if (useHub) {
        await hubPost('/api/progress', { id, by: config.role, percent, note, scope: scope })
      } else {
        await runTaskctl(config.scrumDir, ['progress', id, '--by', config.role, '--percent', String(percent), '--note', note])
      }
    } catch (e) {
      log(`progress ${id} 失败：${String(e)}`)
    }
  }

  /** 认领任务（hub 或本地）。带幂等 request-id（同守护同任务稳定），可选 TTL。 */
  async function claimTask(id: string, soldier: string): Promise<void> {
    const requestId = `daemon:${config.role}:${id}`
    if (useHub) {
      await hubPost('/api/claim', {
        id, soldier, by: config.role, scope: scope, requestId,
        ...(config.taskTtlMinutes > 0 ? { ttlMinutes: config.taskTtlMinutes } : {}),
      })
    } else {
      const argv = ['claim', id, '--soldier', soldier, '--request-id', requestId]
      if (config.taskTtlMinutes > 0) argv.push('--ttl-minutes', String(config.taskTtlMinutes))
      await runTaskctl(config.scrumDir, argv)
    }
    await reportProgress(id, 0, '认领开工')
    abortRetryAt.delete(id) // 新一轮认领（含解阻续做）重置中止退避
  }

  /**
   * worktree 隔离：为任务建独立分支 worktree（w/<taskId>）。失败返回 null 由调用方回退。
   * 复用优先：同任务已有 worktree（blocked 解阻 / 退回纠错续做）直接复用，不删除上一轮部分改动；
   * worktree 被清理但分支仍在（blocked 时已提交 WIP）则从分支重新挂载。
   */
  async function prepareWorktree(taskId: string): Promise<string | null> {
    const root = worktreeRootFor()
    const dir = join(root, taskId)
    try {
      await ensurePrePushGuard()
      if (existsSync(dir)) {
        if (existsSync(join(dir, '.git'))) {
          // 既有 worktree：直接复用（保留未提交/已提交改动）
          activity('worktree', taskId, `复用既有 worktree：${dir}（分支 w/${taskId}）`)
          log(`${taskId} 复用既有 worktree：${dir}`)
          return dir
        }
        // 残留空目录/非 worktree 壳（daemon 自有路径），清理后重建
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败继续 */ }
      }
      const branchExists = (await runGit(repoRootFor(), ['rev-parse', '--verify', `w/${taskId}`])).code === 0
      if (branchExists) {
        // 分支还在（上轮已提交 WIP/成果）：从分支挂载续做
        const add = await runGit(repoRootFor(), ['worktree', 'add', dir, `w/${taskId}`])
        if (add.code !== 0) {
          log(`${taskId} 从分支 w/${taskId} 挂载 worktree 失败：${(add.err || add.out).trim()}`)
          return null
        }
        activity('worktree', taskId, `复用分支 w/${taskId}：${dir}`)
        return dir
      }
      const add = await runGit(repoRootFor(), ['worktree', 'add', '-b', `w/${taskId}`, dir, 'HEAD'])
      if (add.code !== 0) {
        log(`${taskId} worktree 创建失败：${(add.err || add.out).trim()}`)
        return null
      }
      activity('worktree', taskId, `隔离 worktree 就绪：${dir}（分支 w/${taskId}）`)
      return dir
    } catch (e) {
      log(`${taskId} prepareWorktree 异常：${String(e)}`)
      return null
    }
  }

  /**
   * 安装公共 pre-push 守卫：worktree 的钩子走公共 hooks 目录（无每-worktree 独立钩子），
   * 故用一个通用钩子拦截所有 w/*（worktree 分支）push，放行普通分支。幂等，不覆盖已有自定义钩子。
   */
  async function ensurePrePushGuard(): Promise<void> {
    const hooksDir = join(repoRootFor(), '.git', 'hooks')
    const hook = join(hooksDir, 'pre-push')
    const marker = 'legion worktree guard'
    const script = `#!/bin/sh
# ${marker}：禁止 push worktree 分支（w/*）；普通分支放行
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in
    refs/heads/w/*) echo "legion: worktree 分支 w/* 禁止 push（须经 promote 合并回主分支）" >&2; exit 1 ;;
  esac
done
exit 0
`
    try {
      mkdirSync(hooksDir, { recursive: true })
      if (existsSync(hook)) {
        if (readFileSync(hook, 'utf8').includes(marker)) return // 已装
        log('检测到已有自定义 pre-push 钩子，跳过安装守卫（请自行确保 w/* 分支不被 push）')
        return
      }
      writeFileSync(hook, script, { mode: 0o755 })
      log('已安装 pre-push 守卫（拦截 w/* 分支 push）')
    } catch (e) {
      log(`pre-push 守卫安装失败：${String(e)}`)
    }
  }

  /** 把 worktree 里的改动提交到 w/<taskId> 分支（done 时调用；blocked 保留未提交改动）。 */
  async function commitWorktree(taskId: string, dir: string, summary: string): Promise<boolean> {
    const add = await runGit(dir, ['add', '-A'])
    if (add.code !== 0) { log(`${taskId} git add 失败：${add.err.trim()}`); return false }
    const commit = await runGit(dir, ['commit', '-m', `${taskId}：${summary}`])
    if (commit.code !== 0) { log(`${taskId} git commit 失败：${(commit.err || commit.out).trim()}`); return false }
    return true
  }

  /** 读取仓库规则（LEGION.md 优先，其次 AGENTS.md），注入派工提示词。 */
  function readRepoRules(): string {
    const candidates = [
      join(repoRootFor(), 'LEGION.md'),
      join(repoRootFor(), 'AGENTS.md'),
      join(config.scrumDir, 'LEGION.md'),
    ]
    for (const f of candidates) {
      try {
        if (existsSync(f)) return readFileSync(f, 'utf8').slice(0, 4000)
      } catch { /* 读取失败跳过 */ }
    }
    return ''
  }

  /** 捕获 worktree 的改动 diff 并记录到任务（taskctl patch）。非隔离模式跳过。 */
  async function recordPatch(taskId: string, dir: string | null, summary: string): Promise<void> {
    if (dir === null) return
    try {
      const show = await runGit(dir, ['show', '--format=', 'HEAD'])
      if (show.code !== 0 || show.out.trim().length === 0) return
      const names = await runGit(dir, ['diff', '--name-only', 'HEAD~1', 'HEAD'])
      const files = names.out.split('\n').map(s => s.trim()).filter(Boolean).join(',')
      const tmp = join(dir, `.legion-${taskId}.patch`)
      writeFileSync(tmp, show.out, 'utf8')
      try {
        await runTaskctl(config.scrumDir, ['patch', taskId, '--by', config.role, '--summary', summary, '--diff', tmp, '--files', files])
      } finally {
        try { rmSync(tmp) } catch { /* 清理失败静默 */ }
      }
    } catch (e) {
      log(`${taskId} 记录 diff 失败：${String(e)}`)
    }
  }

  /**
   * 登记 worker 产物（借鉴 dsh-worktable 的 widget-result.json 握手）：
   * html → 看板 iframe 预览；file → 看板链接；url → 跳转。相对路径按 worktree 解析；文件不存在则跳过并记录。
   */
  async function recordArtifact(taskId: string, a: WorkerArtifact, worktreeDir: string | null): Promise<void> {
    try {
      let path = a.path
      if (a.kind !== 'url') {
        const base = worktreeDir ?? workspaceFor()
        const resolved = isAbsolute(path) ? path : join(base, path)
        if (!existsSync(resolved)) {
          log(`${taskId} 产物不存在，跳过登记：${resolved}`)
          await safeComment(taskId, `⚠ 产物路径不存在（未登记预览）：${resolved}`)
          return
        }
        path = resolved
      }
      const argv = ['artifact', taskId, '--by', config.role, '--kind', a.kind, '--path', path]
      if (a.title && a.title.length > 0) argv.push('--title', a.title.slice(0, 120))
      if (useHub) {
        await hubPost('/api/artifact', { id: taskId, kind: a.kind, path, title: a.title ?? '', by: config.role, scope: scope })
      } else {
        await runTaskctl(config.scrumDir, argv)
      }
      activity('artifact', taskId, `产物已登记：${a.title || path}`)
    } catch (e) {
      log(`${taskId} 登记产物失败：${String(e)}`)
    }
  }

  /**
   * 流水线中间阶段自动合入：merge w/<id> → 当前分支并清理 worktree，让下一角色基于最新主分支工作。
   * 成功返回 true；失败返回 false 且保留 worktree 与分支（改动不丢，供人工合入或重试）。
   */
  async function autoPromote(taskId: string, dir: string): Promise<boolean> {
    try {
      const merge = await runGit(repoRootFor(), ['merge', '--no-ff', `w/${taskId}`, '-m', `promote ${taskId}`])
      if (merge.code !== 0) {
        log(`${taskId} 自动合入失败：${(merge.err || merge.out).trim()}`)
        return false
      }
      await runGit(repoRootFor(), ['worktree', 'remove', '--force', dir])
      await runGit(repoRootFor(), ['branch', '-D', `w/${taskId}`])
      log(`${taskId} 已自动合入主分支并清理 worktree`)
      return true
    } catch (e) {
      log(`${taskId} 自动合入异常：${String(e)}`)
      return false
    }
  }

  /** 流水线流转：done 任务所属角色有 next 且尚无后继时，创建下一角色任务（todo）。 */
  async function advancePipeline(doneTask: Task): Promise<void> {
    if (pipeline === null) return
    const stage = stageByRole.get(doneTask.role ?? '')
    if (!stage || !stage.next) return
    const nextStage = stageByRole.get(stage.next)
    if (!nextStage) return
    const all = await listTasks()
    // 后继已存在则跳过：advance 补建的任务以 parent 链识别，createGoalChain 预建的全链任务以
    // 「同 scope 同 role 且 blockedBy 含已完成任务」识别（parent 为空）——两者任一存在即不重复建。
    const isOpen = (s?: string) => !!s && s !== 'done' && s !== 'canceled'
    const hasSuccessor = all.some(t =>
      t.scope === scope && t.role === nextStage.role && isOpen(t.status) &&
      (t.parent === doneTask.id || (Array.isArray(t.blockedBy) && t.blockedBy.includes(doneTask.id))),
    )
    if (hasSuccessor) return
    const doneSummary = doneTask.comments
      .filter(c => c.text.startsWith('✓'))
      .map(c => c.text.replace(/\n.*$/s, ''))
      .slice(-1)[0] ?? doneTask.title
    const base = (doneTask.description ?? '').replace(/\n\n\[本阶段\].*$/s, '')
    const description = [
      base,
      `[前序阶段] ${stage.label}（${stage.role}）已完成：${doneSummary}`,
      `[本阶段] ${nextStage.label}（${nextStage.role}）`,
    ].filter(s => s.trim().length > 0).join('\n\n')
    // 标题沿用上一环但把「【阶段标签】」换成下一环的，避免重复建任务时标题仍旧是前序阶段
    const title = doneTask.title.replace(/^【[^】]*】/, `【${nextStage.label}】`)
    try {
      let res: { id?: string }
      if (useHub) {
        res = await hubPost('/api/create', {
          title, description, role: nextStage.role,
          parent: doneTask.id, priority: doneTask.priority, status: 'todo',
          by: config.role, scope: scope,
        }) as { id?: string }
      } else {
        res = await runTaskctl(config.scrumDir, [
          'create', '--title', title, '--description', description,
          '--role', nextStage.role, '--parent', doneTask.id, '--priority', doneTask.priority, '--status', 'todo',
        ]) as { id?: string }
      }
      log(`${doneTask.id} 流水线流转：${stage.role} → ${nextStage.role}（新任务 ${res?.id ?? ''}）`)
      activity('dispatch', doneTask.id, `流水线流转 ${stage.label} → ${nextStage.label}`)
    } catch (e) {
      log(`${doneTask.id} 流转失败：${String(e)}`)
    }
  }

  function buildWorkerPrompt(t: Task, feedback: Task['comments'], cwd: string, isolated: boolean, stage?: StageDef): string {
    const repoRules = readRepoRules()
    const lines = [
      stage
        ? `你是军团士兵，当前角色「${stage.label}」（${stage.role}）。任务 ${t.id} 由你独立完成。`
        : `你是军团士兵 ${config.role}（守护循环派发的临时 worker），任务 ${t.id} 由你独立完成。`,
      '',
      ...(stage ? [`角色职责（必须遵守）：${stage.prompt}`, ''] : []),
      `工作目录：${cwd}`,
      isolated ? `隔离模式：你在独立 git worktree（分支 w/${t.id}）中工作；不要 push（pre-push 已拦截）；改动只留在本 worktree，由将军验收后 promote 合并。若 w/${t.id} 已存在上一轮的部分改动（WIP 提交），请在其基础上继续完成，不要删除既有内容。` : '',
      `任务看板：${config.scrumDir}（taskctl 是唯一变更入口，但你不要调用它）`,
      '',
      `任务：${t.title}`,
      t.description ? `描述：${t.description}` : '描述：（无）',
      '验收标准（必须逐条真实满足，并在证据中对应说明）：',
      ...(t.acceptance.length > 0 ? t.acceptance.map(a => `- ${a}`) : ['- （未填写，请自行判断合理的完成标准并写明）']),
      ...(t.boundary && (t.boundary.do.length > 0 || t.boundary.dont.length > 0)
        ? [
            '边界（只做 / 不做，必须遵守）：',
            ...(t.boundary.do ?? []).map(x => `- ✅ 做：${x}`),
            ...(t.boundary.dont ?? []).map(x => `- 🚫 不做：${x}`),
          ]
        : []),
      t.blockedBy.length > 0 ? `依赖（应已完成）：${t.blockedBy.join(', ')}` : '',
      '',
      '历史评论（含将军的退回反馈，必须处理）：',
      ...(t.comments.length > 0
        ? t.comments.map(c => `- @${c.by}（${c.at}）: ${c.text}`)
        : ['- （无）']),
      ...(repoRules !== ''
        ? ['', '仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）：', repoRules]
        : []),
      ...(sharedSkills.length > 0
        ? ['', '团队共享技能（必须遵守，来自 team-hub）：', ...sharedSkills.map(s => `【${s.name}】${s.prompt}`)]
        : []),
      ...(spaceBinding !== null
        ? ['', `空间仓库绑定（本工作空间）：本地文件夹 = ${spaceBinding.localDir}${spaceBinding.remoteUrl ? `；远程仓库 = ${spaceBinding.remoteUrl}` : '（仅本地，不进共享仓库）'}`]
        : []),
      '',
      '纪律：',
      '1. 只做实现与验证；状态迁移一律由守护负责。唯一允许调用的 taskctl 命令是 `taskctl progress <id> --by <角色> --percent <0-100> --note <一句话>`（上报进度遥测，不迁移状态）；其余 taskctl / task_* / 看板写接口一律禁止。',
      '2. 完成标准 = 验收标准逐条真实满足：跑真实命令验证（typecheck / build / test），给出证据。',
      '3. 改动落在工作目录内；如需更新 legion 文档一并更新。',
      '4. 禁止联网与任何 push（pre-push 已拦截 w/* 分支）；外部依赖若缺失，在证据里说明而非擅自下载。',
      '5. 最终回复只输出 JSON 报告，不要额外叙述：',
      '   {"status":"done","summary":"一句话总结","evidence":"验证证据（命令与输出要点）","blocker":"","artifact":null}',
      '   "artifact" 可选（无产物必须为 null）：{"kind":"html|file|url","path":"产物绝对路径（工作目录内）","title":"一句话标题"}——html 会进看板 iframe 预览，file/url 变成看板链接。',
      '   或 {"status":"blocked","summary":"已完成的部分","evidence":"","blocker":"卡在哪个文件/命令/什么报错（必须具体）","artifact":null}',
      '',
    ]
    return lines.filter(l => l.length > 0).join('\n')
  }

  /** 派一个 worker 处理任务（认领已完成或任务本身可开工）。 */
  async function runWorker(t: Task, feedback: Task['comments'], stage?: StageDef): Promise<void> {
    // 决定工作目录：isolate 时建 worktree（分支 w/<id>），失败回退工作目录（可能为空间绑定的本地文件夹）
    let cwd = workspaceFor()
    let worktreeDir: string | null = null
    if (config.isolate) {
      worktreeDir = await prepareWorktree(t.id)
      if (worktreeDir !== null) cwd = worktreeDir
      else log(`${t.id} worktree 不可用，回退到 workspace 直接工作`)
    }
    const parent = await ensureForeman(cwd)
    if (parent === undefined) {
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
          prompt: [{ type: 'text', text: buildWorkerPrompt(t, feedback, cwd, worktreeDir !== null, stage) }],
          parent,
          signal: controller.signal,
          outputSchema: WORKER_SCHEMA,
          ...(config.denyTools.length > 0 ? { toolFilter: { deny: config.denyTools } } : {}),
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
    activity('dispatch', t.id, 'worker 已派工，开始实现')
    await reportProgress(t.id, 10, '已派工')
    const result = await run.result
    await run.dispose()
    if (result.stopReason !== 'completed' || result.structured === undefined) {
      log(`${t.id} worker 未完成（${result.stopReason}）`)
      await safeComment(t.id, `⚠ worker 未完成（${result.stopReason}），任务保留在 in_progress，等待人工处理或下一轮重试`)
      activity('aborted', t.id, `worker 未完成（${result.stopReason}），保留 in_progress 待租约回收`)
      return
    }
    const report = result.structured as WorkerReport
    if (report.status === 'done') {
      // worktree 隔离：先提交到 w/<id> 分支再记录 diff
      if (worktreeDir !== null) await commitWorktree(t.id, worktreeDir, report.summary)
      await recordPatch(t.id, worktreeDir, report.summary)
      if (report.artifact && report.artifact.path) await recordArtifact(t.id, report.artifact, worktreeDir)
      if (isPipeline && stage && stage.next) {
        // 流水线中间阶段：自动合入主分支 → done → 流转下一角色；合入失败转 in_review 等人工，不静默丢产出
        const merged = worktreeDir !== null ? await autoPromote(t.id, worktreeDir) : true
        if (!merged) {
          await safeComment(t.id, `⚠ ${stage.label}完成，但自动合入主分支失败（可能冲突），改动保留在分支 w/${t.id}。请人工合入并推进：git -C ${repoRootFor()} merge --no-ff w/${t.id} 解决冲突 → git -C ${repoRootFor()} worktree remove --force ${worktreeDir} → git -C ${repoRootFor()} branch -D w/${t.id} → 将军把任务 transition 到 done`)
          await transitionTo(t.id, 'in_review')
          activity('blocked', t.id, `${stage.label}完成但自动合入失败，转 in_review 等待人工合入`)
          log(`${t.id} → in_review（中间阶段自动合入失败，等待人工处理）`)
          return
        }
        await advanceTo(t.id, stage.role)
        await safeComment(t.id, `✓ ${stage.label}完成：${report.summary}\n证据：${report.evidence}`)
        activity('done', t.id, `${stage.label}完成：${report.summary}`)
        log(`${t.id} → done（${stage.label}），流转下一角色`)
        await advancePipeline(t)
      } else {
        // 最终阶段或单角色模式：进 in_review 供将军验收
        await transitionTo(t.id, 'in_review')
        const promoteHint = worktreeDir !== null
          ? `\n[worktree] 改动在分支 w/${t.id}。验收通过后 promote：git -C ${repoRootFor()} merge --no-ff w/${t.id}；放弃：git -C ${repoRootFor()} worktree remove --force ${worktreeDir} && git -C ${repoRootFor()} branch -D w/${t.id}`
          : ''
        await safeComment(t.id, `✓ 完成并提交验收：${report.summary}\n证据：${report.evidence}${promoteHint}`)
        activity('done', t.id, `完成：${report.summary}${worktreeDir !== null ? `（worktree 分支 w/${t.id} 待 promote）` : ''}`)
        log(`${t.id} → in_review（${report.summary}）`)
      }
    } else {
      // blocked：把部分改动提交到 w/<id>（WIP），解阻/纠错续做时 prepareWorktree 复用，不丢上一轮成果
      if (worktreeDir !== null) {
        const status = await runGit(worktreeDir, ['status', '--porcelain'])
        if (status.code === 0 && status.out.trim().length > 0) {
          await commitWorktree(t.id, worktreeDir, `WIP：${report.summary}`)
        }
      }
      const wtHint = worktreeDir !== null
        ? `\n[worktree] 部分改动已提交到分支 w/${t.id}（${worktreeDir}），解阻后续做会自动复用`
        : ''
      await safeComment(t.id, `⚠ 受阻：${report.blocker || report.summary}${wtHint}`)
      await transitionTo(t.id, 'blocked')
      activity('blocked', t.id, `受阻：${report.blocker || report.summary}`)
      log(`${t.id} → blocked（${report.blocker || report.summary}）`)
    }
  }

  /** 认领 todo 并派工（流水线模式按任务角色认领 + 用角色提示词）。 */
  async function workTodo(t: Task, stage?: StageDef): Promise<void> {
    try {
      await claimTask(t.id, stage ? stage.role : config.role)
    } catch (e) {
      log(`${t.id} 认领失败（可能已被他人认领）：${String(e)}`)
      return
    }
    activity('claim', t.id, stage ? `${stage.label}（${stage.role}）认领开工` : '认领开工')
    await runWorker(t, [], stage)
  }

  /** 处理被退回/解阻的任务。 */
  async function workReturned(t: Task, feedback: Task['comments'], stage?: StageDef): Promise<void> {
    activity('redispatch', t.id, '被退回/解阻，重新派工')
    await runWorker(t, feedback, stage)
  }

  /** 派发一个一次性子 agent，返回结构化结果；失败返回 null（不抛，讨论/流水线容错继续）。 */
  async function startOneShot<T>(label: string, promptText: string, schema: ObjectJsonSchema, cwd: string): Promise<T | null> {
    const parent = await ensureForeman(cwd)
    if (parent === undefined) return null
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), config.workerTimeoutMs)
    try {
      const run = await ctx.subagents.start(config.provider, {
        label,
        prompt: [{ type: 'text', text: promptText }],
        parent,
        signal: controller.signal,
        outputSchema: schema,
      })
      const result = await run.result
      await run.dispose()
      if (result.stopReason !== 'completed' || result.structured === undefined) {
        log(`${label} 未完成（${result.stopReason}）`)
        return null
      }
      return result.structured as T
    } catch (e) {
      log(`${label} 派发失败：${String(e)}`)
      return null
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }

  /** 一名角色士兵在需求讨论群聊中做头脑风暴式陈述（只输出意见，不写文件）。 */
  async function dispatchSpeaker(t: Task, stage: StageDef, discussionText: string, focus: string, cwd: string): Promise<SpeakerReport | null> {
    const prompt = [
      `你是军团士兵，正在「需求讨论群聊」头脑风暴中，以「${stage.label}」（${stage.role}）身份陈述观点。`,
      `讨论目标：${t.title}`,
      t.description ? `目标描述：${t.description}` : '',
      focus ? `将军点名的交锋焦点：${focus}` : '',
      '',
      '当前讨论记录：',
      '```',
      discussionText,
      '```',
      '',
      `请以「${stage.label}」的专业视角做头脑风暴式陈述（你的观点随后会被其他角色挑战，要经得起反驳）：`,
      '- position：你的立场与总体判断（明确、可被反驳）',
      '- concerns：你发现的矛盾点、模糊点、风险、缺失的边界或验收口径（无则空字符串）',
      '- suggestions：你的具体建议——可以大胆、反直觉，鼓励打开新思路（无则空字符串）',
    ].filter(s => s !== '').join('\n')
    return startOneShot<SpeakerReport>(`discuss:${t.id}:${stage.role}`, prompt, SPEAKER_SCHEMA, cwd)
  }

  /** 一名角色士兵针对本轮他人陈述做头脑风暴交锋（点名反驳 + 打开新思路）。 */
  async function dispatchReplier(t: Task, stage: StageDef, roundStatements: string, focus: string, cwd: string): Promise<ReplyReport | null> {
    const prompt = [
      `你是军团士兵「${stage.label}」（${stage.role}），正在「需求讨论群聊」的头脑风暴交锋环节。`,
      '不要复述自己的立场，专门针对**其他角色**的陈述做交锋。',
      focus ? `将军点名的交锋焦点：${focus}` : '',
      '',
      '本轮各角色的陈述：',
      '```',
      roundStatements,
      '```',
      '',
      '请做头脑风暴式交锋：',
      '- challenges：点名 1-2 个你最不同意/最怀疑的其他角色观点（写清目标角色 + 对方观点 + 你的反驳理由）；',
      '- insights：提出一个别人都没想到但重要的角度，或把某个你赞同的观点往前推一步（打开新思路）。',
      '要具体到人、到点，不要泛泛而谈。',
    ].filter(s => s !== '').join('\n')
    return startOneShot<ReplyReport>(`debate:${t.id}:${stage.role}`, prompt, REPLY_SCHEMA, cwd)
  }

  /** 将军（主持人）判断收敛 + 点名矛盾 + 给下一轮交锋焦点。 */
  async function dispatchModerator(t: Task, discussionText: string, cwd: string): Promise<ModeratorReport | null> {
    const prompt = [
      `你是将军（讨论主持人 + 头脑风暴引导者）。以下是「${t.title}」的需求讨论群聊记录：`,
      '```',
      discussionText,
      '```',
      '',
      '请：1) 判断讨论是否已收敛（主要矛盾已澄清、方向明确、可开工）；2) 识别最尖锐的对立点（哪两个角色在哪点上对立）；3) 未收敛时给出下一轮交锋焦点（让谁和谁正面 PK 什么问题）。',
      '- converged：是否收敛（true/false）',
      '- final_direction：最终需求方向总结（明确、可验收、无歧义；未收敛时给出当前倾向与待决点）',
      '- remaining_conflicts：未收敛时列出仍需澄清的问题（收敛时给空数组）',
      '- next_focus：未收敛时下一轮交锋的具体焦点（点名角色与问题；收敛时给空字符串）',
    ].join('\n')
    return startOneShot<ModeratorReport>(`moderate:${t.id}`, prompt, MODERATOR_SCHEMA, cwd)
  }

  /** 讨论收敛后：创建流水线首阶段任务（role = 首 stage，parent = 讨论任务，描述带最终方向）。 */
  async function launchPipeline(discussionTask: Task, finalDirection: string): Promise<void> {
    if (pipeline === null) return
    const first = pipeline.stages[0]
    if (!first) return
    const base = (discussionTask.description ?? '').replace(/\n\n\[讨论\].*$/s, '')
    const description = [
      base,
      `[需求方向] ${finalDirection}`,
      `[本阶段] ${first.label}（${first.role}）`,
    ].filter(s => s.trim().length > 0).join('\n\n')
    try {
      let res: { id?: string }
      if (useHub) {
        res = await hubPost('/api/create', {
          title: discussionTask.title, description, role: first.role,
          parent: discussionTask.id, priority: discussionTask.priority, status: 'todo',
          by: config.role, scope: scope,
        }) as { id?: string }
      } else {
        res = await runTaskctl(config.scrumDir, [
          'create', '--title', discussionTask.title, '--description', description,
          '--role', first.role, '--parent', discussionTask.id, '--priority', discussionTask.priority, '--status', 'todo',
        ]) as { id?: string }
      }
      log(`${discussionTask.id} 讨论收敛 → 启动流水线首阶段 ${first.role}（新任务 ${res?.id ?? ''}）`)
      activity('dispatch', discussionTask.id, `讨论收敛 → 启动流水线 ${first.label}`)
    } catch (e) {
      log(`${discussionTask.id} 启动流水线失败：${String(e)}`)
    }
  }

  /** 需求讨论群聊：各角色士兵逐轮并发发言，将军收敛方向，然后启动流水线。 */
  async function runDiscussion(t: Task): Promise<void> {
    try {
      await claimTask(t.id, 'discussion')
    } catch (e) {
      log(`${t.id} 讨论任务认领失败：${String(e)}`)
      return
    }
    activity('claim', t.id, '进入需求讨论群聊（将军 + 各角色士兵）')
    const cwd = workspaceFor()
    const docPath = join(config.scrumDir, 'discussion', `${t.id}.md`)
    mkdirSync(dirname(docPath), { recursive: true })
    let text = `# 需求讨论：${t.title}\n\n> 目标：${t.description}\n`
    let finalDirection = ''
    let converged = false
    let lastFocus = ''
    for (let round = 1; round <= discussionMaxRounds; round++) {
      text += `\n## 第 ${round} 轮\n`
      const focus = lastFocus
      // 1. 陈述：各角色并发头脑风暴式陈述
      activity('dispatch', t.id, `讨论第 ${round} 轮：${discussionMembers.length} 名士兵并发陈述`)
      const speeches = await Promise.all(discussionMembers.map(stage => dispatchSpeaker(t, stage, text, focus, cwd).then(report => ({ stage, report }))))
      text += '\n### 陈述\n'
      let roundStatements = ''
      for (const { stage, report } of speeches) {
        if (report === null) {
          const miss = `\n#### @${stage.role}（${stage.label}）\n（本轮未发言）\n`
          text += miss
          roundStatements += miss
          continue
        }
        const block = `\n#### @${stage.role}（${stage.label}）\n- 立场：${report.position}\n` + (report.concerns ? `- 矛盾/风险：${report.concerns}\n` : '') + (report.suggestions ? `- 建议：${report.suggestions}\n` : '')
        text += block
        roundStatements += block
        await safeComment(t.id, `💬 [第${round}轮] @${stage.role}（${stage.label}）：${report.position}${report.concerns ? `\n⚠ 顾虑：${report.concerns}` : ''}`)
      }
      // 2. 交锋：各角色针对本轮他人陈述点名反驳 + 打开新思路
      activity('dispatch', t.id, `讨论第 ${round} 轮交锋：${discussionMembers.length} 名士兵互相反驳`)
      const replies = await Promise.all(discussionMembers.map(stage => dispatchReplier(t, stage, roundStatements, focus, cwd).then(report => ({ stage, report }))))
      text += '\n### 交锋\n'
      for (const { stage, report } of replies) {
        if (report === null) {
          text += `\n#### @${stage.role}（${stage.label}）\n（本轮未交锋）\n`
          continue
        }
        text += `\n#### @${stage.role}（${stage.label}）\n- 反驳/挑战：${report.challenges}\n- 新思路：${report.insights}\n`
        await safeComment(t.id, `⚔ [第${round}轮交锋] @${stage.role}：${report.challenges}${report.insights ? ` | 💡 新思路：${report.insights}` : ''}`)
      }
      // 3. 将军主持：收敛判断 + 点名矛盾 + 给下一轮交锋焦点
      const mod = await dispatchModerator(t, text, cwd)
      if (mod === null) {
        text += '\n### 将军（主持人）\n（本轮未给出收敛判断）\n'
        continue
      }
      if (mod.converged) {
        converged = true
        finalDirection = mod.final_direction
        text += `\n### 将军（主持人）✅ 收敛\n${mod.final_direction}\n`
        await safeComment(t.id, `✅ 将军判定收敛：${mod.final_direction}`)
        break
      }
      finalDirection = mod.final_direction || finalDirection
      lastFocus = mod.next_focus || lastFocus
      text += `\n### 将军（主持人）\n未收敛，仍需澄清：${(mod.remaining_conflicts ?? []).join('、') || '（未说明）'}\n下一轮焦点：${mod.next_focus || '（未指定）'}\n`
      await safeComment(t.id, `🔄 第${round}轮未收敛：${(mod.remaining_conflicts ?? []).join('、') || '（未说明）'}${mod.next_focus ? `\n🎯 下一轮交锋焦点：${mod.next_focus}` : ''}`)
    }
    writeFileSync(docPath, text, 'utf8')
    if (!converged) {
      await safeComment(t.id, '⚠ 达到讨论轮数上限，按当前讨论方向启动流水线')
      log(`${t.id} 讨论达到轮数上限（${discussionMaxRounds}），按当前方向启动流水线`)
    }
    const direction = finalDirection || '（讨论未收敛，按各角色建议综合执行，详见讨论记录）'
    await launchPipeline(t, direction)
    await advanceTo(t.id, 'discussion')
    await safeComment(t.id, `📋 讨论结束，已启动流水线：${direction}`)
    activity('done', t.id, `讨论结束 → 流水线启动：${direction}`)
    log(`${t.id} → done（讨论收敛），流水线已启动`)
  }

  /** 一轮扫单：todo 认领派工；本角色的退回任务纠错；依赖解除的 blocked 续做。 */
  async function sweep(): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      // 全局暂停：serve.mjs POST /api/pause 置 control.json paused=true，暂停期间跳过认领/派工但保留心跳。
      if (readControlPaused()) {
        if (Date.now() - lastPausedNotice > Math.max(60000, config.intervalMs * 2)) {
          lastPausedNotice = Date.now()
          log('⏸ 全局暂停：control.json paused=true，本轮跳过扫单（serve.mjs POST /api/resume 解除）')
        }
        writeDaemonStatus(0)
        return
      }
      // 刷新本 scope 的空间仓库绑定（hub 模式：/api/spaces；命中 localDir → 本空间工作/隔离仓库）
      await refreshSpaceBinding()
      await ensureForeman(workspaceFor())
      await fetchSkills()
      let tasks: Task[]
      try {
        tasks = await listTasks()
      } catch (e) {
        log(`list 失败：${String(e)}`)
        return
      }
      const byId = new Map(tasks.map(t => [t.id, t]))
      const room = () => inflight.size < config.maxWorkers
      // 流水线模式：守护按任务角色认领/派工；单角色模式：只认 config.role 的任务
      const self = (t: Task) => (isPipeline ? (t.role ?? config.role) : config.role)
      const isOurs = (t: Task) => (isPipeline ? (t.role !== null && stageByRole.has(t.role)) : t.soldier === config.role)
      const stageOf = (t: Task) => (isPipeline ? stageByRole.get(t.role ?? '') : undefined)
      const runDetached = (taskId: string, job: Promise<void>): void => {
        void job
          .catch(e => log(`${taskId} 后台派工异常：${String(e)}`))
          .finally(() => inflight.delete(taskId))
      }

      // 离线 inbox 计数：本守护名下待认领（todo/blocked 未认领）任务，每轮汇报一次（将军拦截的除外）
      const isOurInbox = (t: Task) => (isPipeline ? (t.role !== null && stageByRole.has(t.role)) : true)
      const inboxIds = tasks.filter(t => (t.status === 'todo' || t.status === 'blocked') && (t.soldier === null || t.soldier === undefined) && !t.hold && isOurInbox(t))
      if (inboxIds.length > 0) log(`inbox=${inboxIds.length}（${inboxIds.map(t => t.id).join(', ')}）`)

      // 0. 认领租约回收：释放超过 staleMinutes 无进展（距最近 progress 起算）或过 TTL 的 in_progress 任务。
      //    hub 模式走 hub 的 /api/release-stale（守护不直连本地库，多存储部署下避免误碰其他任务池）；本地模式带 --scope 限定本守护 scope。
      try {
        const res = useHub
          ? await hubPost('/api/release-stale', { by: config.role, scope, olderThan: config.staleMinutes }) as { released?: string[] }
          : await runTaskctl(config.scrumDir, ['release-stale', '--older-than', String(config.staleMinutes), '--by', config.role, '--scope', scope]) as { released?: string[] }
        for (const id of res.released ?? []) activity('released', id, `距最近进展超过 ${config.staleMinutes} 分钟或过 TTL，自动释放回 todo`)
      } catch (e) {
        log(`release-stale 失败：${String(e)}`)
      }

      // 依赖未解除（链上后段在上一环 done 前保持待命，不空转抢认领）
      const openDeps = (t: Task): boolean =>
        (t.blockedBy ?? []).some(depId => {
          const dep = byId.get(depId)
          return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
        })

      // 1. todo：认领（互斥）→ 派工（流水线模式按任务角色；讨论任务走群聊）。
      //    自动交接纪律：被将军拦截（hold）的任务不认领；依赖未解除的任务待上一环 done 后由下轮认领。
      for (const t of tasks.filter(t => t.status === 'todo')) {
        if (!room() || inflight.has(t.id)) continue
        if (isPipeline && stageOf(t) === undefined && t.role !== 'discussion') continue // 流水线模式跳过无角色/未知角色任务
        if (t.hold) continue // 将军拦截：等放行
        if (openDeps(t)) continue // 链上后段：上一环 done 后自动交接
        inflight.add(t.id)
        const job = t.role === 'discussion' ? runDiscussion(t) : workTodo(t, stageOf(t))
        runDetached(t.id, job)
      }
      // 2. blocked 且本角色、依赖已全部解除：解阻续做（同样遵守拦截）
      for (const t of tasks.filter(t => t.status === 'blocked' && isOurs(t))) {
        if (!room() || inflight.has(t.id)) continue
        if (t.hold) continue
        if (openDeps(t)) continue
        inflight.add(t.id)
        runDetached(t.id, workTodo(t, stageOf(t)))
      }
      // 3. in_progress 且本角色、认领后有他人评论：视为退回，附反馈纠错；
      //    守护自己的「worker 未完成 / 派工失败」评论也触发重试（单角色模式 self=config.role 会把它过滤掉，
      //    导致中止的 worker 只能等 stale 释放），带 ≥4 个扫单周期的退避，避免故障期间热循环
      for (const t of tasks.filter(t => t.status === 'in_progress' && isOurs(t))) {
        if (!room() || inflight.has(t.id)) continue
        if (t.hold) continue // 将军拦截进行中任务：不自动纠错续跑
        const since = t.claimedAt === null ? 0 : new Date(t.claimedAt).getTime()
        const feedback = t.comments.filter(c => new Date(c.at).getTime() > since && c.by !== self(t))
        const abortDriven = feedback.length === 0 && t.comments.some(c =>
          new Date(c.at).getTime() > since && (c.text.startsWith('⚠ worker 未完成') || c.text.startsWith('⚠ 派工失败')))
        if (feedback.length === 0 && !abortDriven) continue
        if (abortDriven && (abortRetryAt.get(t.id) ?? 0) + config.intervalMs * 4 > Date.now()) continue
        if (abortDriven) abortRetryAt.set(t.id, Date.now())
        inflight.add(t.id)
        runDetached(t.id, workReturned(t, feedback, stageOf(t)))
      }
      // 4. 流水线 done 补流转：将军人工合入/验收后手动 done 的中间阶段任务 → 创建下一角色任务（幂等：已有后继则跳过）
      if (isPipeline) {
        for (const t of tasks.filter(x => x.status === 'done' && stageOf(x) !== undefined)) {
          await advancePipeline(t)
        }
      }
      writeDaemonStatus(inboxIds.length)
    } finally {
      sweeping = false
    }
  }

  ctx.setInterval(() => {
    void sweep().catch(e => log(`sweep 异常：${String(e)}`))
  }, config.intervalMs)

  // 启动即探测 hub（探测成功则后续 sweep 走 hub 模式）
  void detectHub()

  ctx.effect(() => () => {
    for (const c of controllers) c.abort()
    for (const [, f] of foremen) {
      void f.dispose().catch(e => log(`foreman 释放失败：${String(e)}`))
    }
    foremen.clear()
  }, `${name}: teardown`)

  ctx.logger?.info?.(`[${name}] 士兵守护启动（角色=${config.role}，每 ${config.intervalMs}ms 扫单，并发=${config.maxWorkers}，看板=${config.scrumDir}）`)
}

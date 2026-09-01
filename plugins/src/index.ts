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
  /** 认领租约：in_progress 认领超过该分钟数无进展则由守护释放回 todo（须 > workerTimeoutMs/60000）。 */
  staleMinutes: number
  /** 任务级 TTL（分钟）：认领后超时未完成即由守护释放回 todo（0 = 不设 TTL，靠 staleMinutes 兜底）。 */
  taskTtlMinutes: number
  /** ctx.subagents 上注册的 provider 名（spawn-in-process 默认注册为 spawn）。 */
  provider: string
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
  priority: string
  status: string
  version: number
  soldier: string | null
  claimedAt: string | null
  parent: string | null
  role: string | null
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
  const inflight = new Set<string>()
  const controllers = new Set<AbortController>()
  let sweeping = false

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

  /** 惰性创建 foreman agent：worker subagent 的父（按工作目录缓存；worktree 隔离时每个 worktree 一个）。 */
  async function ensureForeman(cwd: string): Promise<Agent | undefined> {
    const existing = foremen.get(cwd)
    if (existing !== undefined) return existing.agent
    try {
      const selection = ctx.agentDefaultModel.currentSelection()
      const handle = await ctx.agents.create({
        sessionId: SessionId(`scrum-worker-foreman-${hashStr(cwd)}`),
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
      })
      foremen.set(cwd, { agent: handle.agent, dispose: () => handle.dispose() })
      log(`foreman 就绪：${handle.agent.session.id}（cwd=${cwd}，model=${selection.provider}/${selection.model}）`)
      return handle.agent
    } catch (e) {
      log(`foreman 创建失败（本轮跳过派工，cwd=${cwd}）：${String(e)}`)
      return undefined
    }
  }

  /** 带乐观锁的状态迁移：先重读任务取最新 version。 */
  async function transitionTo(id: string, to: string): Promise<void> {
    const t = await getTask(id)
    if (useHub) {
      await hubPost('/api/transition', { id, to, by: config.role, ifVersion: t.version, scope: scope })
      return
    }
    await runTaskctl(config.scrumDir, ['transition', id, '--to', to, '--by', config.role, '--if-version', String(t.version)])
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
  }

  /** worktree 隔离：为任务建独立分支 worktree（w/<taskId>）。失败返回 null 由调用方回退。 */
  async function prepareWorktree(taskId: string): Promise<string | null> {
    const root = config.worktreeRoot || join(config.repoRoot, '.legion-worktrees')
    const dir = join(root, taskId)
    try {
      await ensurePrePushGuard()
      // 清残留（同 id 重派）：先移除 worktree 再删分支
      await runGit(config.repoRoot, ['worktree', 'remove', '--force', dir])
      await runGit(config.repoRoot, ['branch', '-D', `w/${taskId}`])
      const add = await runGit(config.repoRoot, ['worktree', 'add', '-b', `w/${taskId}`, dir, 'HEAD'])
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
    const hooksDir = join(config.repoRoot, '.git', 'hooks')
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
      join(config.repoRoot, 'LEGION.md'),
      join(config.repoRoot, 'AGENTS.md'),
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

  /** 流水线中间阶段自动合入：merge w/<id> → 当前分支并清理 worktree，让下一角色基于最新主分支工作。 */
  async function autoPromote(taskId: string, dir: string): Promise<void> {
    try {
      const merge = await runGit(config.repoRoot, ['merge', '--no-ff', `w/${taskId}`, '-m', `promote ${taskId}`])
      if (merge.code !== 0) {
        log(`${taskId} 自动合入失败：${(merge.err || merge.out).trim()}`)
        return
      }
      await runGit(config.repoRoot, ['worktree', 'remove', '--force', dir])
      await runGit(config.repoRoot, ['branch', '-D', `w/${taskId}`])
      log(`${taskId} 已自动合入主分支并清理 worktree`)
    } catch (e) {
      log(`${taskId} 自动合入异常：${String(e)}`)
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
    if (all.some(t => t.parent === doneTask.id)) return
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
    try {
      let res: { id?: string }
      if (useHub) {
        res = await hubPost('/api/create', {
          title: doneTask.title, description, role: nextStage.role,
          parent: doneTask.id, priority: doneTask.priority, status: 'todo',
          by: config.role, scope: scope,
        }) as { id?: string }
      } else {
        res = await runTaskctl(config.scrumDir, [
          'create', '--title', doneTask.title, '--description', description,
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
      isolated ? `隔离模式：你在独立 git worktree（分支 w/${t.id}）中工作；不要 push（pre-push 已拦截）；改动只留在本 worktree，由将军验收后 promote 合并。` : '',
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
      ...(repoRules !== ''
        ? ['', '仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）：', repoRules]
        : []),
      ...(sharedSkills.length > 0
        ? ['', '团队共享技能（必须遵守，来自 team-hub）：', ...sharedSkills.map(s => `【${s.name}】${s.prompt}`)]
        : []),
      '',
      '纪律：',
      '1. 只做实现与验证；不要调用任何 taskctl / task_* / 看板写接口——状态迁移由守护负责，你只负责把代码和验证做好。',
      '2. 完成标准 = 验收标准逐条真实满足：跑真实命令验证（typecheck / build / test），给出证据。',
      '3. 改动落在工作目录内；如需更新 legion 文档一并更新。',
      '4. 禁止联网与任何 push（pre-push 已拦截 w/* 分支）；外部依赖若缺失，在证据里说明而非擅自下载。',
      '5. 最终回复只输出 JSON 报告，不要额外叙述：',
      '   {"status":"done","summary":"一句话总结","evidence":"验证证据（命令与输出要点）","blocker":""}',
      '   或 {"status":"blocked","summary":"已完成的部分","evidence":"","blocker":"卡在哪个文件/命令/什么报错（必须具体）"}',
      '',
    ]
    return lines.filter(l => l.length > 0).join('\n')
  }

  /** 派一个 worker 处理任务（认领已完成或任务本身可开工）。 */
  async function runWorker(t: Task, feedback: Task['comments'], stage?: StageDef): Promise<void> {
    // 决定工作目录：isolate 时建 worktree（分支 w/<id>），失败回退 workspace
    let cwd = config.workspace
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
      if (isPipeline && stage && stage.next) {
        // 流水线中间阶段：自动合入主分支 → done → 流转下一角色
        if (worktreeDir !== null) await autoPromote(t.id, worktreeDir)
        await advanceTo(t.id, stage.role)
        await safeComment(t.id, `✓ ${stage.label}完成：${report.summary}\n证据：${report.evidence}`)
        activity('done', t.id, `${stage.label}完成：${report.summary}`)
        log(`${t.id} → done（${stage.label}），流转下一角色`)
        await advancePipeline(t)
      } else {
        // 最终阶段或单角色模式：进 in_review 供将军验收
        await transitionTo(t.id, 'in_review')
        const promoteHint = worktreeDir !== null
          ? `\n[worktree] 改动在分支 w/${t.id}。验收通过后 promote：git -C ${config.repoRoot} merge --no-ff w/${t.id}；放弃：git -C ${config.repoRoot} worktree remove --force ${worktreeDir} && git -C ${config.repoRoot} branch -D w/${t.id}`
          : ''
        await safeComment(t.id, `✓ 完成并提交验收：${report.summary}\n证据：${report.evidence}${promoteHint}`)
        activity('done', t.id, `完成：${report.summary}${worktreeDir !== null ? `（worktree 分支 w/${t.id} 待 promote）` : ''}`)
        log(`${t.id} → in_review（${report.summary}）`)
      }
    } else {
      const wtHint = worktreeDir !== null ? `\n[worktree] 部分改动在 ${worktreeDir}（分支 w/${t.id}，未提交）` : ''
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
    const cwd = config.workspace
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
      await ensureForeman(config.workspace)
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

      // 离线 inbox 计数：本守护名下待认领（todo/blocked 未认领）任务，每轮汇报一次
      const isOurInbox = (t: Task) => (isPipeline ? (t.role !== null && stageByRole.has(t.role)) : true)
      const inboxIds = tasks.filter(t => (t.status === 'todo' || t.status === 'blocked') && (t.soldier === null || t.soldier === undefined) && isOurInbox(t))
      if (inboxIds.length > 0) log(`inbox=${inboxIds.length}（${inboxIds.map(t => t.id).join(', ')}）`)

      // 0. 认领租约回收：释放超过 staleMinutes 无进展的 in_progress 任务（下一轮再认领）
      try {
        const res = await runTaskctl(config.scrumDir, ['release-stale', '--older-than', String(config.staleMinutes), '--by', 'daemon']) as { released?: string[] }
        for (const id of res.released ?? []) activity('released', id, `认领超过 ${config.staleMinutes} 分钟无进展，自动释放回 todo`)
      } catch (e) {
        log(`release-stale 失败：${String(e)}`)
      }

      // 1. todo：认领（互斥）→ 派工（流水线模式按任务角色；讨论任务走群聊）
      for (const t of tasks.filter(t => t.status === 'todo')) {
        if (!room() || inflight.has(t.id)) continue
        if (isPipeline && stageOf(t) === undefined && t.role !== 'discussion') continue // 流水线模式跳过无角色/未知角色任务
        inflight.add(t.id)
        const job = t.role === 'discussion' ? runDiscussion(t) : workTodo(t, stageOf(t))
        void job.finally(() => inflight.delete(t.id))
      }
      // 2. blocked 且本角色、依赖已全部解除：解阻续做
      for (const t of tasks.filter(t => t.status === 'blocked' && isOurs(t))) {
        if (!room() || inflight.has(t.id)) continue
        const open = t.blockedBy.filter(depId => {
          const dep = byId.get(depId)
          return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
        })
        if (open.length > 0) continue
        inflight.add(t.id)
        void workReturned(t, [], stageOf(t)).finally(() => inflight.delete(t.id))
      }
      // 3. in_progress 且本角色、认领后有他人评论：视为退回，附反馈纠错
      for (const t of tasks.filter(t => t.status === 'in_progress' && isOurs(t))) {
        if (!room() || inflight.has(t.id)) continue
        const feedback = t.comments.filter(c =>
          c.by !== self(t) && (t.claimedAt === null || new Date(c.at) > new Date(t.claimedAt)))
        if (feedback.length === 0) continue
        inflight.add(t.id)
        void workReturned(t, feedback, stageOf(t)).finally(() => inflight.delete(t.id))
      }
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

/**
 * @dsh-external/dsh-scrum-worker — 军团士兵轮询守护（daemon-loop 形态）。
 *
 * 每 intervalMs 扫一次任务看板（legion/scrum/tasks.json 权威库，经 taskctl 访问）：
 *   1. todo 任务 → 认领（互斥由状态机保证）→ 派一次性 worker subagent
 *      （携带任务完整上下文：标题/描述/验收/评论/依赖）→ 完成后按岗位结算：
 *      流水线中间阶段自动合入并推进 done；**流水线最终阶段（如 devops 链尾）自动合入并收官 done**
 *      （部署不需将军验收，2026-09-08 T-126 现场裁决：将军已授权整条流水线，终态自检通过即放行）；
 *      人工闸门岗（gate，如 requirement/researcher）与人工派活的非流水线单角色任务 → 停 in_review 等将军。
 *   2. in_progress 且属于本角色、认领之后有他人评论的任务 → 视为被将军退回，
 *      派纠错 worker（提示词附最新退回评论）。
 *   3. blocked 且属于本角色、依赖已全部解除的任务 → 解阻认领 → 派 worker 续做。
 *
 * done 的两种入口：将军拖拽验收（gate/单角色/异常在 in_review 的任务），
 * 或守护自动收官（流水线中间与最终阶段，将军已授权整条流水线）。
 * worker 是一次性 subagent（spawn-in-process），父为启动时惰性创建的 foreman agent，
 * 工作目录 = 仓库根。worker 只做实现并回报 {status, summary, evidence, blocker}，
 * 状态迁移一律由守护经 taskctl 完成（taskctl 是唯一变更入口，乐观锁/角色纪律服务端强制）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { isSupervisor } from './proc.js'
export { isSupervisor } from './proc.js'
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldSubagentDescriptor, type SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { formatSkill, skillsChanged, type SkillRef } from './skillsCache.js'
import { runWorkflowTestCommand, type WorkflowTestRunReceipt } from './workflowTestRunner.js'
import { buildNormSections, type NormFile } from './norms.js'
import { buildChatAnswerPrompt, chatIdentityFor, type ChatCtxMsg } from './chatResponder.js'
import { classifyChatError } from './chatErrorClassifier.js'
import { gatherChatContext, type AttachmentRef, type ChatContextBundle } from './chatContext.js'
import { pluginConfigLogLines } from './config.js'
import {
  parseDraftState, renderFrontmatter, replaceFrontmatter,
  skillIdForTask, buildPromotePrompt,
  resolveKind, buildLearningPrompt, renderLearningFile, fallbackLearning, learningIdForTask,
} from './experienceVotes.js'
import {
  parseTombstones, applyTombstones, type RuleDoctorReport,
} from './ruleAssets.js'
import {
  pickRecall, renderRecallSection, countableRefs, type RecallDoc,
} from './experienceRecall.js'
// 阶段 3 PRT-315：领域类型与合入调解各自成模块（第 1 个切片，见 ./mediation.ts 文件头）。
export type { StageDef, Task } from './types.js'
import type { AgentReviewWorkflow, DiscussionDef, StageDef, Task } from './types.js'
// ★ PRT-1007「编排提取」片 1：岗位文档契约纯函数已搬去 `./docContract.js`，
//   下面**原样再导出**同名符号 ⇒ 公开面（`lib/index.js`）零差异，消费者一条都不用改。
//   六个函数体逐字未动；`DiscussionDef` 同时搬进 `types.ts`（它成了跨模块类型）。
import {
  stageContractDocs,
  resolveStageDocPaths,
  resolveStageDocPathsWithDocSync,
  fileDigest,
  resolveDiscussion,
  stagesFromHubPayload,
} from './docContract.js'
// 再导出**带 `from`**：读者不必往上翻就知道这些名字从哪来。
// （裸 `export { … }` 靠上一个 import 也能工作，但"这个符号的出处"就变成了要推断的事；
//  `probe-slice-verbatim.mjs` 的 ③ 把"带 `from` 的再导出"作为契约固定下来。）
export {
  stageContractDocs,
  resolveStageDocPaths,
  resolveStageDocPathsWithDocSync,
  fileDigest,
  resolveDiscussion,
  stagesFromHubPayload,
} from './docContract.js'
import { createMergeMediation } from './mediation.js'
import { decideIntegrationPath, resolveIntegrationMode } from './legacyConvergence.js'
import { createReclamation, type BootReconcileState } from './reclamation.js'
import { createStateMachine } from './stateMachine.js'
import { createWorkspace, type SpaceBinding } from './workspace.js'
import { createAcceptance } from './acceptance.js'
import { createHandoff, isSliceTesterTask } from './handoff.js'
import { createSliceOrchestration } from './sliceOrchestration.js'
import { decideProductionTool, type GrantedWrite } from './productionWriteGuard.js'
import { planTimeoutSettlement, planTimeoutTransitionFailure, workerStoppedWithin, TIMEOUT_SETTLE_GRACE_MS } from './timeoutSettlement.js'
import { branchOwnChangesRefspec } from './branchScope.js'
import { resolveStaleMinutes } from './configSanity.js'
import { parseExternalWorkerReport } from '../../runtime/adapters/dsh/external-agent.mjs'
// PRT-108 棘轮：provider 目录读取与外部 Agent 接线一律经适配层，插件不再直接依赖执行面服务。
// 见 runtime/adapters/dsh/subagent-client.mjs 的文件头（为什么这 5 个调用点必须下沉）。
import {
  executeExternalAgentInContext,
  listSubagentProviders,
  subagentProvider,
  subagentProviderCapabilities,
  subagentProviderPermissionMode,
} from '../../runtime/adapters/dsh/subagent-client.mjs'
import { waitForWorkflowAgentRun } from '../../runtime/adapters/dsh/workflow-run.mjs'
import { materializeWorkflowCheckpoints, WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX } from '../../runtime/contracts/agent-workflow-checkpoints.mjs'
import { validateAgentWorkflowTestReport } from '../../runtime/contracts/agent-workflow.mjs'
import { expectedExternalPermissionMode } from '../../runtime/contracts/agent-provider-policy.mjs'
import { agentOptionsForFrozenModel } from '../../runtime/contracts/agent-model-selection.mjs'

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
  /** 可选执行节点身份；登记后会上报实际 provider 与能力。 */
  agentNodeId: string
  /** 切片流水线类型化槽位：并发 coder 上限（fix 任务占 coder 槽）。 */
  sliceCoderSlots: number
  /** 切片流水线类型化槽位：并发 tester 上限。 */
  sliceTesterSlots: number
  /** 单目标进行中的切片任务（coder+tester）上限。 */
  perGoalSliceCap: number
  /** 单个切片的修复回炉预算（fix 任务轮数上限，超限升级将军）。 */
  maxFixPerSlice: number
  /** 实例模式：worker=派工流水线 + 本空间调解；mediator=纯公共调解（跨所有空间，不派工）。 */
  mode: 'worker' | 'mediator'
  /** worker 模式是否内嵌本空间合入调解（公共 mediator 部署时置 false，避免双调解）。 */
  mediateMergeFails: boolean
  /** P1-4.5 技能桥目标目录（默认 ~/.dsh/skills —— DSH 原生扫描 + teamai 同步目标；空串 = 关闭桥）。 */
  dshSkillsDir: string
  /**
   * SP-P1 多空间编排：本实例接管的 space id 列表；`'auto'` = hub 里全部**已开通执行**的空间；
   * `'off'`（默认）= 单空间模式，行为与 P1 之前完全一致（`scope` 即唯一空间）。
   */
  scopes: string[] | 'auto' | 'off'
  /**
   * 内部字段（P1）：由监督者下发的「主 scope」= 负责维护 daemon.json 兼容文件的那个空间。
   * 空串 = 本实例自己就是主（单空间部署与 P1 之前行为一致）。
   */
  primaryScope: string
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
  scope: z.string().default(''),
  agentNodeId: z.string().default(''),
  sliceCoderSlots: z.number().min(0).max(8).default(2),
  sliceTesterSlots: z.number().min(0).max(8).default(2),
  perGoalSliceCap: z.number().min(0).max(16).default(4),
  maxFixPerSlice: z.number().min(0).max(5).default(2),
  mode: z.union([z.const('worker'), z.const('mediator')]).default('worker'),
  mediateMergeFails: z.boolean().default(true),
  dshSkillsDir: z.string().default(''),
  // SP-P1：多空间监督者（'off' = 单空间，行为不变）
  scopes: z.union([z.const('auto'), z.const('off'), z.array(z.string())]).default('off'),
  primaryScope: z.string().default(''),
})


/** 目标上下文（同目标共享上下文，守护派工时注入 + 写镜像供士兵读文件）。 */
interface GoalCtx {
  id: string
  scope: string
  objective: string
  status: string
  mode?: string
  /** 目标级分析文档目录（相对仓库根，如 'docs/G-x'）：NULL/缺省 = 遗留目标沿用根 docs/ 固定槽位。 */
  docsDir?: string | null
  context: string
  contextVersion: number
}


/** 需求讨论配置：哪些角色参与群聊 + 最多讨论几轮。
 *  ★ PRT-1007 片 1 已搬去 `types.ts`（`docContract.ts` 要按它定签名，两边得共用同一个类型）。 */

interface PipelineDef {
  name: string
  discussion?: DiscussionDef
  workflow?: AgentReviewWorkflow | null
  stages: StageDef[]
}

function parseAgentReviewWorkflow(raw: unknown): AgentReviewWorkflow | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hub workflow 配置形状无效')
  const value = raw as Record<string, unknown>
  const roles = [value.designRole, value.implementationRole, value.reviewRole]
  if (!roles.every(role => typeof role === 'string' && role.trim() !== '')
    || new Set(roles).size !== 3
    || !Number.isSafeInteger(value.maxReworkRounds)
    || (value.maxReworkRounds as number) < 0 || (value.maxReworkRounds as number) > 20) {
    throw new Error('hub workflow 缺少合法的角色或返工上限')
  }
  return {
    designRole: (value.designRole as string).trim(),
    implementationRole: (value.implementationRole as string).trim(),
    reviewRole: (value.reviewRole as string).trim(),
    maxReworkRounds: value.maxReworkRounds as number,
  }
}

function workflowStageIdFor(workflow: NonNullable<NonNullable<Task['agentSelectionSnapshot']>['reviewWorkflow']>, key: 'design' | 'implementation' | 'review'): string {
  const stageId = key === 'design' ? workflow.designStageId
    : key === 'implementation' ? workflow.implementationStageId : workflow.reviewStageId
  if (typeof stageId === 'string' && stageId.trim() !== '') return stageId
  const role = key === 'design' ? workflow.designRole
    : key === 'implementation' ? workflow.implementationRole : workflow.reviewRole
  return workflow.stageIdByRole?.[role] ?? role
}

function isWorkflowStage(task: Task, stage: StageDef | undefined, key: 'design' | 'implementation' | 'review'): boolean {
  const workflow = task.agentSelectionSnapshot?.reviewWorkflow
  if (workflow === null || workflow === undefined || stage === undefined) return false
  const selectedStageId = task.agentSelectionSnapshot?.workflowStageId ?? stage.workflowStageId ?? stage.id ?? stage.role
  return selectedStageId === workflowStageIdFor(workflow, key)
}

function workflowHasForwardEdges(task: Task, stage: StageDef | undefined): boolean {
  const workflow = task.agentSelectionSnapshot?.reviewWorkflow
  if (workflow === null || workflow === undefined || stage === undefined) return stage?.next != null
  const stageId = task.agentSelectionSnapshot?.workflowStageId ?? stage.workflowStageId ?? stage.id
  const frozen = stageId ? workflow.stageDefinitionsById?.[stageId] : undefined
  if (Array.isArray(frozen?.nextStageIds)) return frozen.nextStageIds.length > 0
  return stage.next !== null
}

/** worker 结构回报。 */
interface WorkerReport {
  status: 'done' | 'blocked'
  summary: string
  evidence: string
  blocker: string
  artifact: WorkerArtifact | null
  /** 仅切片测试士兵（tester，D7' 机器闸门）回报：结构化测试结果。 */
  testReport?: { passed: boolean; command?: string; summary?: string; evidence?: string; failures?: Array<{ name: string; log: string; repro: string }> } | null
  /** Legion 独立测试执行器生成并绑定到实现提交的回执。 */
  testVerification?: {
    id: string; state: 'passed' | 'failed' | 'unknown'; sourceCommit: string; stageAttemptId: string
    providerRunId: string | null; runnerNodeId: string | null; executable: string; args: string[]
    timeoutMs: number; exitCode: number | null; startedAtMs: number; finishedAtMs: number
    outputDigest: string; outputExcerpt: string; outputTruncated: boolean; error: string | null
  } | null
  /** 可选：执行时所依据的目标上下文（goalId + contextVersion，守护据此核对"下一派工对齐"语义）。 */
  goalRef?: { goalId?: string; contextVersion?: number } | null
  /** reviewStage 专用：无 findings 才可 passed；问题按设计/实现分类。 */
  review?: { passed: boolean; findings: Array<{ kind: 'implementation' | 'design'; summary: string; evidence?: string }> }
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
    review: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['implementation', 'design'] },
              summary: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['kind', 'summary'],
            additionalProperties: false,
          },
        },
      },
      required: ['passed', 'findings'],
      additionalProperties: false,
    },
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
    testReport: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        command: { type: 'string' },
        summary: { type: 'string' },
        evidence: { type: 'string' },
        failures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              log: { type: 'string' },
              repro: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['passed'],
      additionalProperties: false,
    },
    goalRef: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        contextVersion: { type: 'number' },
      },
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

// ── 岗位文档契约纯函数（R-1/S1）★ PRT-1007 片 1：已整体搬去 `./docContract.js` ──────────────
// 本处**只留这条路标**，不再留实现。六个函数（`stageContractDocs` / `resolveStageDocPaths` /
// `resolveStageDocPathsWithDocSync` / `fileDigest` / `resolveDiscussion` / `stagesFromHubPayload`）
// 由上面的 `from './docContract.js'` **原样再导出** ⇒ `lib/index.js` 的公开面对消费者零差异。
// 为什么第一刀挑它们、以及"行为零变化"怎么证明，写在 `plugins/src/docContract.ts` 的文件头。

export function apply(ctx: AppContext, config: Config): void {
  // SP-P1：`scopes` 非 'off' → 本实例是**多空间监督者**（自己不做派工，只为每个空间挂一个子实例）；
  // 'off'（默认）→ 单空间工作实例（P1 之前的既有行为，逐字不变）。
  if (isSupervisor(config)) superviseSpaces(ctx, config)
  else spaceWorker(ctx, config)
}

/** 是否为多空间监督者实例（缺省/未校验的手工配置一律按单空间处理）。 */
// ★★ PRT-1007 片 3（T2，2026-09-24）：本函数已逐字搬到 **`./proc.ts`**。
//   回引写在这里（**删除点原位置**）：要改它，改 `plugins/src/proc.ts`；
//   本文件通过下面那两行（import / export）继续使用同一个实现。

/**
 * P3-4：把生效配置写进守护日志——**每进程只写一次**。
 *
 * 配置是进程级的（`plugins/src/config.ts` 在模块加载期解析一次），而多空间监督者会按空间 mount 多个
 * spaceWorker 实例；逐实例重复同一份摘要只会把日志淹掉。日志写失败由调用方的 log() 自行吞掉。
 */
let configSummaryLogged = false
function logConfigOnce(log: (msg: string) => void): void {
  if (configSummaryLogged) return
  configSummaryLogged = true
  for (const line of pluginConfigLogLines()) log(line)
}

/**
 * SP-P1：单个空间的士兵守护（P1 之前 apply() 的全部行为）。
 *
 * 由 `apply` 直接调用（单空间），或由监督者按空间 mount（多空间）。整个函数体是**同一个空间的闭包状态**
 * （pipeline / control / inflight / foremen / 日志…），因此「多空间 = 多个实例」而不需要把 3000 行状态改成 Map。
 */
function spaceWorker(ctx: AppContext, config: Config): void {
  const SHORT = 'dsh-scrum-worker'
  const logFile = config.logFile || join(homedir(), '.dsh', 'super-injector', SHORT + '.log')
  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  // P3-4：把本进程生效的配置写进守护日志（脱敏摘要 + 校验结论 + schema 规则告警）。
  // 与三进程的启动摘要同一口径（docs/CONFIG.md）：配置非法时这里会多出「已回退默认值」的错误行，
  // 而不是让守护带着一个它自己都不知道的预算继续跑。
  logConfigOnce(log)

  // ── BUG-009-b：staleMinutes 必须 > workerTimeoutMs/60000 ──────────────────────────
  // 这条关系原先只是字段注释、schema 没有任何强制。不满足时的症状很远：回收器在 worker
  // **还活着**的时候把任务释放回 todo ⇒ 另一个 worker 认领 ⇒ 两个写者改同一片文件。
  // 处置：启动时校正 + **打印一行**（静默改配置比不校正更坏），并把校正后的值贯穿两个消费者
  // （心跳 writeDaemonStatus 与 createReclamation 的 release-stale）。
  const staleVerdict = resolveStaleMinutes({
    workerTimeoutMs: config.workerTimeoutMs,
    staleMinutes: config.staleMinutes,
  })
  if (staleVerdict.adjusted) {
    log(`★ 配置自洽校正（BUG-009-b）：staleMinutes ${config.staleMinutes} → ${staleVerdict.staleMinutes}`
      + `（必须 > workerTimeoutMs/60000 = ${staleVerdict.needed - 1}；原值会让租约回收器在 worker`
      + ` 超时之前就把它释放回 todo，于是同一个任务可能有两个写者）`)
  }
  const effectiveConfig: Config = staleVerdict.adjusted
    ? { ...config, staleMinutes: staleVerdict.staleMinutes }
    : config

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
  /**
   * foreman **持久**失败登记：cwd → { reason, since, attempts }（非空 = 该 cwd 的 worker 父级建不起来）。
   *
   * 为什么需要它：旧实现把**任何**异常都当「本轮瞬时失败」处理（记一行日志、返回 undefined、下轮重试）。
   * 但 sessionId 由 cwd 派生、是确定性常量，而 agent 会话是**持久化**的（session-persistence）——
   * 上一个进程未优雅退出时残留的 foreman 会话，会让此后每一次 foreman 会话创建都以
   * SessionAlreadyExistsError 失败，于是守护每 20s 打一行同样的日志、**永久**跳过该 cwd 的 foreman。
   * 现场（2026-09-11）：ozon 661 次 / software 399 次撞同一个 id，对话回复与 /api/rewrite 静默中断。
   * 现在：撞名即改用唯一 id 自愈，并把失败态写进 daemon-<scope>.json，让看板/健康页看得见。
   *
   * ⚠️ 合并说明（2026-09-16）：上面这一句原写作「每一次 foreman 会话创建（以该方法名写出）」，
   * 是随 `main` 那笔 foreman 修复一起进来的。本次合并把那个方法名改成了自然语言表述——
   * **不是因为注释不该提它，而是因为 `dsh-boundary` 棘轮的口径是词法的**：
   * 注释与字符串里的记号同样计数（`scripts/ci/dsh-boundary.mjs:182`），
   * 而它自己写明了正确的做法是「让适配层的注释不要出现真实记号」。
   *
   *   > 于是这里有一个真实的选择：把基线从 1 抬到 2，还是把注释里那个词换掉。
   *   > 前者会让棘轮**永久**多出一个名额——而那一个名额在将来会静静地放进一次
   *   > 真的执行面新增依赖；后者只改一个词，含义一字未变。
   *   > 抬高上限来容纳一次"其实不算"的计数，与放宽这条棘轮，是同一个东西。
   */
  const foremanDown = new Map<string, { reason: string; since: string; attempts: number }>()
  /** 本插件实例的短标识：撞名后据此派生一个全新 foreman 会话 id（每进程唯一 → 必定可创建）。 */
  const foremanRunId = Math.random().toString(36).slice(2, 8)
  /** 判定「会话 id 已被占」：session-persistence 的 SessionAlreadyExistsError（按 name/文案判定，不跨包耦合错误类）。 */
  const isSessionExistsError = (e: unknown): boolean => {
    if ((e as { name?: unknown } | null)?.name === 'SessionAlreadyExistsError') return true
    const msg = e instanceof Error ? e.message : String(e)
    return msg.includes('SessionAlreadyExistsError') || /session "[^"]*" already exists/.test(msg)
  }
  /** 中止类重试的退避时间戳：taskId → 上次「worker 未完成/派工失败」重试时间（防故障期热循环） */
  const abortRetryAt = new Map<string, number>()
  /** 切片展开重试退避：tdId → 上次「TASK_BREAKDOWN.md 未就绪/注册失败」时间（防每轮空转重试） */
  const expandRetryAt = new Map<string, number>()
  const inflight = new Set<string>()
  /** 本轮扫单的任务快照（runWorker 组装"目标下并行任务表"用；sweep 每次成功拉取后刷新）。 */
  let lastTasks: Task[] = []
  /** 目标级上下文缓存（每轮 sweep 从 hub /api/goal 刷新；拉取失败保留上轮）。 */
  const goalCtxById = new Map<string, GoalCtx>()
  /** 目标上下文镜像目录（相对仓库根）：守护派工时写入，供士兵以文件方式读取目标上下文。 */
  const GOAL_MIRROR_DIR = 'docs/goals'

  // ── 目标级分析文档命名空间（docs/<goalId>/）──
  // 遗留惯例：各分析阶段把产物写进仓库根固定槽位（docs/REQUIREMENTS.md 等）→ 跨目标并行时互相覆盖/合入冲突。
  // 目标化后：目标记录带 docsDir（如 'docs/G-x'），这些阶段文档改写到该目标自己的目录（与切片文件域隔离同一思想），
  // 不同目标写不同目录 → 分析前缀阶段跨目标安全并行。docsDir 为空的遗留目标/无目标任务保持原根 docs/ 行为不变。
  const GOAL_DOC_NAMES = ['REQUIREMENTS.md', 'RESEARCH.md', 'TASK_BREAKDOWN.md', 'TEST_CASES.md', 'TEST_REPORT.md', 'DEPLOY.md']
  /** 把遗留槽位文档路径解析为该目标文档目录下的路径（无目标/无 docsDir → 原样遗留路径）。 */
  const goalDocPath = (goal: GoalCtx | null | undefined, legacyPath: string | null | undefined): string => {
    if (!legacyPath) return ''
    const base = legacyPath.split('/').pop() || legacyPath
    return goal?.docsDir ? `${goal.docsDir}/${base}` : legacyPath
  }
  /** 把角色提示词里出现的遗留 docs/X.md 槽位改写为该目标文档目录版本（无 docsDir 原样保留）。 */
  const goalizePrompt = (text: string, goal: GoalCtx | null | undefined): string => {
    if (!goal?.docsDir) return text
    let out = text
    for (const name of GOAL_DOC_NAMES) out = out.split(`docs/${name}`).join(`${goal.docsDir}/${name}`)
    return out
  }
  /** 把单条契约文档路径按目标 docsDir goalize（与 goalizePrompt 同源语义：仅改写 GOAL_DOC_NAMES 槽位，
   *  docs/review/... 等多级/其他命名路径原样保留）——登记/判缺路径必须与工人实际产出目录一致（M1）。
   *  即有 docsDir 的目标其 `docs/REQUIREMENTS.md` → `docs/<goalId>/REQUIREMENTS.md`，其余不变。 */
  const goalizeContractPath = (goal: GoalCtx | null | undefined, p: string): string => {
    if (!goal?.docsDir) return p
    let out = p
    for (const name of GOAL_DOC_NAMES) out = out.split(`docs/${name}`).join(`${goal.docsDir}/${name}`)
    return out
  }
  const controllers = new Set<AbortController>()
  /** 合入调解中（in_review merge-fail 自动处理）：同一时刻只允许一个调解，避免主仓库 git 合并态互相踩踏。 */
  const mediating = new Set<string>()
  /** 调解重试退避：taskId → 上次调解失败时间（失败后 ≥6 个扫单周期再试，最多 maxMediateAttempts 次）。 */
  const mediateRetryAt = new Map<string, number>()
  /** 调解失败次数（达上限后留给将军人工处理）。 */
  const mediateAttempts = new Map<string, number>()
  const maxMediateAttempts = 2
  /** worker 连续「未完成/派工失败」重试上限：超过后置 blocked + 🛑 留将军，打断故障期热循环（镜像调解员 give-up 语义）。
   *  仅统计同一认领（claimedAt 之后）的连续失败，将军/他人评论会重置计数。 */
  const maxWorkerRetry = 3
  /** 守护进程启动后第一轮扫单已做过孤儿回收（重启前进程的在办 worker 已随进程消失，需释放回 todo 重新认领）。
   *  阶段 3 PRT-315 切片 2：已从闭包 `let` 提升为 ./reclamation.ts 读写的显式状态对象，
   *  仍是**每 spaceWorker 实例一份**——多空间监督者在同进程 mount 多个实例，模块级标志会串台（见该模块文件头）。 */
  const bootReconcile: BootReconcileState = { done: false }
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

  /**
   * hub 读请求的鉴权头。**读与写一样需要它。**
   *
   * ## 为什么这一行必须存在（实测）
   *
   * 此前全插件的**读**路径（`/api/board`、`/api/skills`、`/api/goal`、
   * `/api/pipeline`、`/api/rules`）都**不带任何鉴权头**，只有写路径
   * （`hubPost`）带了。
   *
   * 这个不对称在**回环 + 门禁关着**的本机部署上侥幸能用——`readAuthRequired()`
   * 只对非回环生效。但一旦 hub 那边开了 `LEGION_REMOTE_AUTH`（远程门禁），
   * 门禁对**所有**非公开路径要求令牌，回环也一样。于是 worker 每 30 秒
   * 打一行 `list 失败：hub board 失败（401）`，**而它看起来只是"hub 拒绝了"**。
   *
   *   > 一个"读路径不带令牌、写路径带"的客户端，
   *   > 与一个"鉴权完全不工作"的客户端，在只测过写的环境里是同一个东西——
   *   > 只不过前者只在**换了一个 hub 之后**才现形。
   *
   * 远程 Agent 通道把 hub 从"本机回环"搬到了"公网 + 门禁"，这条不对称
   * 因此从"侥幸"变成了"必然失败"：手机派的单永远到不了电脑。
   *
   * 空 token 时不发这个头（无鉴权部署仍照常工作）。
   */
  function hubHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return config.hubToken !== ''
      ? { ...extra, authorization: `Bearer ${config.hubToken}` }
      : extra
  }

  /** hub 写调用（POST，带 token；body 里带 by + scope）。 */
  async function hubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: hubHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `hub ${path} 失败（${res.status}）`))
    return data.task ?? data
  }

  /** hub 读任务列表（按 scope 过滤；公共调解员模式按传入 scope 跨空间拉取）。 */
  async function hubList(scopeFor: string = scope): Promise<Task[]> {
    const res = await fetch(`${hubUrl}/api/board?scope=${encodeURIComponent(scopeFor)}`, { headers: hubHeaders() })
    if (!res.ok) throw new Error(`hub board 失败（${res.status}）`)
    return res.json() as Promise<Task[]>
  }

  /** 团队共享技能：从 hub 拉取本 scope + 授权给本角色的技能（缓存在内存，随 sweep 刷新）。 */
  /** 指纹刷新（S3/R-1）：以 (id, version, contentHash) 序列判定内容/成员变化（skillsCache.ts 纯函数）。 */
  let sharedSkills: SkillRef[] = []
  async function fetchSkills(): Promise<void> {
    if (!useHub) return
    try {
      const res = await fetch(`${hubUrl}/api/skills?scope=${encodeURIComponent(scope)}&member=${encodeURIComponent(config.role)}`, { headers: hubHeaders() })
      if (!res.ok) return // 拉取失败：保留旧缓存（TC-S3-05）
      const skills = await res.json() as SkillRef[]
      if (skillsChanged(sharedSkills, skills)) {
        const prev = sharedSkills
        sharedSkills = skills
        log(`团队技能同步：${skills.map(s => s.id).join(', ') || '（无）'}（scope=${scope}，刷新前 ${prev.length} → 刷新后 ${skills.length}）`)
      }
    } catch { /* 技能拉取失败不影响派工（缓存不清，TC-S3-05） */ }
  }

  // 4.5a 技能桥（published skills → DSH 原生技能目录）已拆到 ./acceptance.ts（验收边界）；
  // 原始注释（收敛协议、tombstone 语义、幂等口径）随代码搬入该模块。

  const listTasks = (scopeFor: string = scope): Promise<Task[]> => useHub ? hubList(scopeFor) : (runTaskctl(config.scrumDir, ['list']) as Promise<Task[]>)
  const getTask = async (id: string, scopeFor: string = scope): Promise<Task> => {
    if (useHub) {
      const t = (await hubList(scopeFor)).find(x => x.id === id)
      if (t === undefined) throw new Error(`未知任务 ${id}`)
      return t
    }
    return runTaskctl(config.scrumDir, ['get', id]) as Promise<Task>
  }
  const getWorkflowCancellationState = async (id: string): Promise<Task & { goalStatus?: string | null }> => {
    const task = await getTask(id, scope)
    if (!useHub || !task.goalId) return task
    const response = await fetch(`${hubUrl}/api/goal?scope=${encodeURIComponent(scope)}`, { headers: hubHeaders(), signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`hub goal status failed (${response.status})`)
    const data = await response.json() as { goals?: Array<{ id?: string; status?: string }> }
    const goal = data.goals?.find(item => item.id === task.goalId)
    if (!goal || typeof goal.status !== 'string') throw new Error(`hub goal status missing for workflow task ${id}`)
    return { ...task, goalStatus: goal.status }
  }

  /** 多角色流水线：读 roles.json，存在则进入流水线模式（按角色派工 + done 自动流转）。 */
  const rolesFilePath = config.rolesFile || join(config.repoRoot, 'roles.json')
  function readPipeline(): PipelineDef | null {
    try {
      if (!existsSync(rolesFilePath)) return null
      const raw = JSON.parse(readFileSync(rolesFilePath, 'utf8'))
      if (!Array.isArray(raw.stages) || raw.stages.length === 0) return null
      return { ...raw, workflow: parseAgentReviewWorkflow(raw.workflow) } as PipelineDef
    } catch (e) {
      log(`roles.json 读取失败（按单角色模式运行）：${String(e)}`)
      return null
    }
  }
  const filePipeline = readPipeline()
  /**
   * SP-P0：流水线改为**数据面优先**（hub GET /api/pipeline），部署面 roles.json 作离线兜底。
   *
   * 动机（T-127 现场）：阶段定义原本只存在于宿主部署配置（rolesFile），与空间编队（hub 数据面）是两份
   * 必须手工对齐的数据；新增空间一旦漏配，目标链会静默停在 todo。搬进数据面后，配置单源 = hub，
   * 守护每轮扫单按 version 指纹增量刷新（内容未变则零成本）。
   */
  type PipelineSource = 'hub' | 'file' | 'none'
  let pipeline: PipelineDef | null = filePipeline
  let pipelineSource: PipelineSource = filePipeline !== null ? 'file' : 'none'
  let hubPipelineVersion = ''
  let stageByRole = new Map<string, StageDef>((pipeline?.stages ?? []).map(s => [s.role, s]))
  let isPipeline = pipeline !== null
  // 需求讨论群聊：讨论配置缺省时用全部流水线角色，最多 3 轮。
  let discussion = pipeline?.discussion
  let discussionMembers: StageDef[] = []
  let discussionMaxRounds = discussion?.maxRounds ?? 3
  let isDiscussion = false

  /** 重算流水线派生状态（唯一出口：任何来源切换都必须经过这里，避免半更新态）。 */
  function applyPipeline(next: PipelineDef | null, source: PipelineSource): void {
    pipeline = next
    pipelineSource = source
    stageByRole = new Map<string, StageDef>((next?.stages ?? []).map(s => [s.role, s]))
    isPipeline = next !== null
    // 需求讨论群聊（SP-P0）：数据面尚未承载 discussion（属 P1），故 hub 来源缺省时回落到部署面文件配置，
    // 避免「切到 hub 流水线后讨论功能静默消失」——行为保持：文件里怎么配的，切源后照旧。
    discussion = resolveDiscussion(next, filePipeline)
    discussionMembers = (discussion?.roles ?? (next?.stages ?? []).map(s => s.role))
      .map(r => stageByRole.get(r))
      .filter((s): s is StageDef => s !== undefined)
    discussionMaxRounds = discussion?.maxRounds ?? 3
    isDiscussion = discussion !== undefined && discussionMembers.length > 0
  }
  applyPipeline(filePipeline, pipelineSource)

  /**
   * hub 流水线载荷 → StageDef[]（防御式解析见模块级 stagesFromHubPayload；此处仅做调用点收敛）。
   */
  async function refreshPipelineFromHub(): Promise<void> {
    if (!useHub || config.mode === 'mediator') return
    try {
      const res = await fetch(`${hubUrl}/api/pipeline?scope=${encodeURIComponent(scope)}&include=active`, { headers: hubHeaders() })
      if (!res.ok) return // hub 不可达/4xx：沿用当前来源（含部署面兜底），不降级为单角色
      const data = await res.json() as { version?: unknown; stages?: unknown; workflow?: unknown }
      const stages = stagesFromHubPayload(data.stages)
      if (stages.length === 0) {
        // 该空间未在数据面配置流水线 → 回退部署面 rolesFile（既有空间零影响）。
        if (pipelineSource === 'hub') {
          applyPipeline(filePipeline, filePipeline !== null ? 'file' : 'none')
          hubPipelineVersion = ''
          log(`空间流水线已清空（scope=${scope}）→ 回退${filePipeline !== null ? `部署面 ${rolesFilePath}` : '单角色模式'}`)
        }
        return
      }
      const version = typeof data.version === 'string' ? data.version : String(data.version ?? '')
      if (pipelineSource === 'hub' && version === hubPipelineVersion) return // 内容指纹未变：零成本
      const workflow = parseAgentReviewWorkflow(data.workflow)
      hubPipelineVersion = version
      const changed = pipelineSource !== 'hub' || isPipeline === false
      applyPipeline({ name: scope, stages, workflow }, 'hub')
      log(`空间流水线来源=hub（scope=${scope}，version=${version}，${stages.length} 环：${stages.map(s => s.role).join(' → ')}）`
        + (changed ? '' : '（内容已更新）'))
    } catch (e) {
      log(`空间流水线读取失败（沿用${pipelineSource === 'hub' ? '上次数据面流水线' : '部署面 rolesFile'}）：${String(e)}`)
    }
  }

  // 项目 scope：显式配置优先，否则用部署面 roles.json 的 name（软件流水线 = software），再否则 default。
  // 注意：scope 在数据面流水线加载之前就需要确定（它是拉取 key），因此这里刻意只看部署面文件。
  //
  // ★ 哨兵值从 `'default'` 改成 `''`（2026-10-06 实测）。
  //
  //   原来写的是 `config.scope !== 'default' ? …`，也就是说**字符串 `'default'`
  //   同时表示"一个叫 default 的空间"和"没配"**。这两个意思撞在一起时，
  //   后者赢——而用户看到的是"我明明把 scope 配成了 default，它却跑在别的空间上"。
  //
  //   > 一个把"没配"编码成一个**合法取值**的哨兵，
  //   > 与一个"这个配置项根本不生效"的哨兵，在用户那边是同一个东西——
  //   > 只不过前者只在有人想用那个取值时才现形。
  //
  //   实测场景：远端 Hub 上的空间就叫 `default`（`first-space.pack.json` 建的），
  //   而本机 `roles.json` 的 name 是 `software` ⇒ worker 永远在 `software` 上扫单，
  //   手机在 `default` 里派的单**永远到不了电脑**，而两端日志都"正常"。
  const scope = config.scope !== '' ? config.scope : (filePipeline?.name ?? 'default')

  const activeWriteGuards = new Map<string, GrantedWrite>()
  const childTaskIds = new Map<string, string>()
  async function fetchWriteGrant(taskId: string, worktree: string): Promise<GrantedWrite | null> {
    if (!useHub) return null
    try {
      const res = await fetch(`${hubUrl}/api/tasks/${encodeURIComponent(taskId)}/reservation`, {
        headers: hubHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      const data = await res.json() as {
        reservation?: { state?: string, attemptId?: string, leaseEpoch?: number, paths?: GrantedWrite['paths'], exclusive?: boolean }
        intent?: { revision?: number, attemptId?: string }
      }
      const r = data.reservation
      if (r?.state !== 'reserved' || !r.attemptId || !Number.isInteger(r.leaseEpoch)
        || !Number.isInteger(data.intent?.revision) || data.intent?.attemptId !== r.attemptId || !Array.isArray(r.paths)) return null
      return { attemptId: r.attemptId, epoch: r.leaseEpoch!, revision: data.intent.revision!, workspace: worktree, paths: r.paths, exclusive: r.exclusive === true }
    } catch { return null }
  }
  if (resolveIntegrationMode(process.env) === 'integration') {
    if (typeof ctx.on !== 'function') throw new Error('集成模式要求工具执行前拦截接口')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'subagent/descriptor') return
      const label = foldSubagentDescriptor([event])?.label
      if (label?.startsWith('scrum:')) {
        const taskId = label.slice('scrum:'.length)
        if (activeWriteGuards.has(taskId)) childTaskIds.set(session.id, taskId)
      }
    }, { global: true })
    ctx.on('tools/pre-execute', async (exec, next) => {
      const taskId = exec.agent ? childTaskIds.get(exec.agent.id) : undefined
      if (!taskId || resolveIntegrationMode(process.env) !== 'integration') return next()
      const granted = activeWriteGuards.get(taskId)
      if (!granted) return { kind: 'deny', reason: '任务没有有效的写入授权快照' }
      const policy = exec.agent?.ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session })
      const sameRoot = policy?.workspaceRoot && (process.platform === 'win32'
        ? resolve(policy.workspaceRoot).toLowerCase() === resolve(granted.workspace).toLowerCase()
        : resolve(policy.workspaceRoot) === resolve(granted.workspace))
      if (policy?.mode !== 'workspace-write' || !sameRoot) {
        return { kind: 'deny', reason: '集成模式要求文件沙箱限定在该任务的独立工作区' }
      }
      const current = exec.name === 'run_code' ? null : await fetchWriteGrant(taskId, granted.workspace)
      const decision = decideProductionTool({ toolName: exec.name, args: exec.arguments, granted, current })
      return decision.allow ? next() : { kind: 'deny', reason: `${decision.code}: ${decision.message}` }
    }, { global: true })
  }

  // ── 切片流水线（v3 slice 模式，见 docs/ORCHESTRATION-V3.md）──
  // slice-mode 目标：分析前缀任务（…→test-designer）描述带 [slice-mode] 标记；切片束任务带 slice 键。
  const SLICE_ANALYSIS_TAIL = 'test-designer'
  const isSliceGoalTask = (t: Task): boolean => (t.description ?? '').includes('[slice-mode]')
  /** slice 键 → 目标级键：'T-004:S2' → 'T-004'；devops 尾 slice=T-004 → 'T-004'。 */
  const sliceGoalKey = (s: string | null | undefined): string | null => {
    if (!s) return null
    const m = /^(.+?):S\d+$/.exec(s)
    return m ? m[1] : s
  }
  /** 是否为切片束任务（coder/tester/devops 且带 slice 键）。 */
  const isSliceBeam = (t: Task): boolean => t.slice != null && t.role != null && (t.role === 'coder' || t.role === 'tester' || t.role === 'devops')

  // ── 阶段 3 PRT-315 切片 7：`parseSlices()` 已搬到 ./sliceOrchestration.ts（切片流水线编排边界）──
  // 它此前是本闭包里的函数声明，全仓**只有编排一个读者**，且是纯函数（不碰闭包/hub/git），
  // 故随边界一起搬；`TASK_BREAKDOWN.md` 的机器可读格式契约与本界同址，改格式时一处就能看到。

  // ── 空间仓库绑定：每个工作空间可配置自己的「本地文件夹 + 远程仓库」（team-hub /api/spaces，
  //    军团指挥台「空间设置」维护；命中 localDir → worker 工作目录 = 该文件夹、隔离仓库根 = 所属仓库根
  //    toplevel；未绑定 / hub 不可达时回退注入配置）。解析逻辑随 refreshSpaceBinding 搬到 ./workspace.ts，
  //    原始注释一并搬入；绑定值本身仍由本实例闭包持有——writeDaemonStatus / worker 提示词 / chat 上下文
  //    三处**非 workspace 边界**的读者直接读它（理由见该模块文件头）。
  let spaceBinding: SpaceBinding | null = null
  // ── 阶段 3 PRT-315 切片 4：workspace（worktree 隔离）已拆到 ./workspace.ts，这里只做**接线** ──
  // `useHub` / `hubUrl` 传**取值函数**（`detectHub()` 探测成功后两个 `let` 都被改写）；`binding` 传
  // **访问器**——绑定是运行期会被重新赋值的东西，传值 = 模块看着一份冻结的旧快照（症状：配了 hub 却
  // 一直走注入默认仓库），且它必须**每实例一份**（superviseSpaces 在同一进程里 mount 多个空间实例）。
  const workspace = createWorkspace({
    config, log, runGit, scope, activity,
    useHub: () => useHub,
    hubUrl: () => hubUrl,
    binding: { get: () => spaceBinding, set: b => { spaceBinding = b } },
  })

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
  // worker 与公共调解员是同进程不同实例，各自写独立状态文件避免互相覆盖：
  // worker → daemon.json；mediator → daemon-mediator.json（看板/健康页只认 daemon.json，调解员不冒充 worker）。
  const daemonStartedAt = Date.now()
  // S2/R-1（决策 B2）：chat 状态旁证（lastReplyAt/lastFailAt/lastFailReason）随 writeDaemonStatus 写出；
  // answerChatMessage/markChatFailed 只更新本对象字段，不直接写文件（每轮 sweep 统一落盘一次）。
  const daemonChatState: { lastReplyAt: string | null; lastFailAt: string | null; lastFailReason: string } = {
    lastReplyAt: null,
    lastFailAt: null,
    lastFailReason: '',
  }
  // SP-P1：多空间实例各写自己的 per-scope 状态文件；主 scope 额外维护 daemon.json（看板/健康页只认它）。
  const daemonStatusFiles = config.mode === 'mediator'
    ? [join(config.scrumDir, 'daemon-mediator.json')]
    : statusFileNames(config.scope, config.primaryScope).map(f => join(config.scrumDir, f))
  /** P1-4.4 最近一次规则 doctor 报告（daemon.json rulesDoctor 字段数据源；声明前置避免启动 TDZ）。 */
  let lastRuleDoctor: RuleDoctorReport | null = null
  function writeDaemonStatus(inboxCount: number): void {
    try {
      const selection = ctx.agentDefaultModel.currentSelection()
      const status = {
        mode: config.mode,
        role: config.role,
        provider: config.provider,
        maxWorkers: config.maxWorkers,
        isolate: config.isolate,
        intervalMs: config.intervalMs,
        workerTimeoutMs: config.workerTimeoutMs,
        staleMinutes: effectiveConfig.staleMinutes,
        taskTtlMinutes: config.taskTtlMinutes,
        scope,
        paused: readControlPaused(),
        pipeline: pipeline ? { name: pipeline.name, source: pipelineSource, version: hubPipelineVersion, stages: pipeline.stages.map(s => s.role) } : null,
        inbox: inboxCount,
        lastSweepAt: new Date().toISOString(),
        uptimeMs: Date.now() - daemonStartedAt,
        model: { provider: selection.provider, model: selection.model },
        repo: config.mode === 'mediator'
          ? { mode: 'mediator', spaces: mediation.spaceIds().sort() }
          : {
            root: workspace.repoRootFor(),
            binding: spaceBinding ? `space:${scope}` : 'default',
            localDir: spaceBinding?.localDir ?? '',
            remoteUrl: spaceBinding?.remoteUrl ?? '',
          },
        // T-123 对话中心：daemon 运行状态（在线/心跳）透出给 UI 健康条
        chat: { ...daemonChatState },
        // foreman 可用性：非空 = 该 cwd 的 worker 父级建不起来（会话 id 残留自愈后仍失败），
        // 此时对话回复/改写不可用；isolate 下派工走各自 worktree cwd，通常不受影响。
        foreman: {
          ok: foremanDown.size === 0,
          down: [...foremanDown.entries()].map(([cwd, v]) => ({ cwd, reason: v.reason, since: v.since, attempts: v.attempts })),
        },
        // P1-4.4 规则资产 doctor：desired 规则单元 vs 实际注入产物（false = 有规则没进提示词）
        rulesDoctor: lastRuleDoctor === null
          ? null
          : {
            ok: lastRuleDoctor.ok,
            truncated: lastRuleDoctor.truncated,
            removedSources: lastRuleDoctor.removedSources,
            total: lastRuleDoctor.items.length,
            present: lastRuleDoctor.items.filter(i => i.present).length,
            missing: lastRuleDoctor.items.filter(i => !i.present).map(i => `${i.source}#${i.title}`),
            checkedAt: new Date().toISOString(),
          },
      }
      for (const file of daemonStatusFiles) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`)
      }
    } catch (e) {
      log(`daemon.json 写入失败：${String(e)}`)
    }
  }
  writeDaemonStatus(0)

  // ── P0-2 经验沉淀：done 结算 → friction 打分 → 经验草稿落盘（docs/experience/drafts/）──
  // 方案：docs/research/teamai-cli-review.md §4.2。结算逻辑（friction 打分、幂等两道闸门、
  // 草稿渲染）已拆到 ./acceptance.ts（验收边界）；草稿/learnings 目录解析仍留此处——
  // recallCorpus（召回注入）与 promoteDraft（晋升落盘）两处**非验收边界**的读者也用它。
  const expDraftDir = (): string => join(workspace.repoRootFor(), 'docs', 'experience', 'drafts')
  /** P2-① 陈述性经验出口：docs/experience/learnings/（declarative promote 落盘，带溯源 frontmatter）。 */
  const expLearningDir = (): string => join(workspace.repoRootFor(), 'docs', 'experience', 'learnings')

  // ── P0-3 置信度晋升管线：草稿票务更新（recalled/upvoted/衰减）→ promote/prune 已拆到
  // ./acceptance.ts（验收边界）。原始注释（事件识别口径、幂等记账、promote 四门槛）随代码
  // 搬入该模块；promote 的**执行**仍留在下方 `promoteDraft`（要用 ctx 的执行面能力），
  // 由构造点作为兄弟能力注入。下面两个每实例状态由 `promoteDraft` 读写，故留在本闭包。
  const expPromoting = new Set<string>()
  const expPromoteRetryAt = new Map<string, number>()
  // taskScanText / collectVoteEvents（任务文本 → recalled/upvoted 事件）随票务扫单搬入该模块。

  // ── P2-③ 派工自动召回：buildWorkerPrompt 前把相关经验草稿/learnings 注入士兵提示词，
  //  并在本轮 sweep 按「注入 = 一次真实召回」给草稿记 recalled（喂回 P0-3 晋升管线）。
  //  corpus 每轮重建（读 drafts + learnings 目录）；注入结果写入 pendingRecallRefs
  //  （taskId→[draftTaskId]），sweepExperienceVotes 消费（applyVote 天然去重：recalledBy 已含则跳过）。
  const pendingRecallRefs = new Map<string, string[]>()
  let recallCorpusCache: RecallDoc[] | null = null
  /** 每轮 sweep 构建一次召回语料（派工/结算间隙不变，避免每 worker 重读目录）。 */
  function recallSectionCache(t: Task): string | null {
    if (recallCorpusCache === null) recallCorpusCache = recallCorpus()
    return recallForTask(t, recallCorpusCache)
  }
  /** 读经验草稿/learnings 成召回语料（drafts: docs/experience/drafts/*.md；learnings: docs/experience/learnings/*.md）。 */
  function recallCorpus(): RecallDoc[] {
    const docs: RecallDoc[] = []
    try {
      const dir = expDraftDir()
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
          try {
            const raw = readFileSync(join(dir, f), 'utf8')
            const st = parseDraftState(raw)
            // stale/promoted 草稿不进召回面：promoted 的精华已晋升为 skill（sharedSkills 注入）
            // 或 learning 资产（learnings 目录进 corpus），草稿再进会造成与正式资产重复注入。
            if (st.status === 'stale' || st.status === 'promoted') continue
            const titleM = /^# 经验草稿：\S+\s+(.+)$/m.exec(raw)
            // 召回正文 = 将军评语/evidence 段（剥 frontmatter/标题/自动生成元信息/待晋升清单）
            const body = raw
              .replace(/^---\n[\s\S]*?\n---\n?/, '')
              .replace(/^# 经验草稿：.*(?:\n|$)/m, '')
              .replace(/^> 自动生成.*(?:\n|$)/m, '')
              .replace(/^> 未经复审。.*(?:\n|$)/m, '')
              .replace(/^## 待晋升[\s\S]*$/m, '')
              .trim()
              .slice(0, 4000)
            docs.push({
              taskId: st.taskId || f.replace(/\.md$/, ''),
              kind: 'draft',
              title: titleM?.[1]?.trim()?.slice(0, 60) ?? f.replace(/\.md$/, ''),
              body,
              goalId: st.goalId || undefined,
            })
          } catch { /* 单个草稿读取失败跳过 */ }
        }
      }
    } catch { /* drafts 目录不可读 */ }
    try {
      const dir = expLearningDir()
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
          try {
            const raw = readFileSync(join(dir, f), 'utf8')
            const taskM = /^taskId:\s*(T-\d+)/m.exec(raw)
            const goalM = /^goalId:\s*(\S+)/m.exec(raw)
            const titleM = /^##\s+(.+)$/m.exec(raw.replace(/^---\n[\s\S]*?\n---\n?/, ''))
            docs.push({
              taskId: taskM?.[1] ?? f.replace(/\.md$/, ''),
              kind: 'learning',
              title: titleM?.[1]?.trim()?.slice(0, 60) ?? f.replace(/\.md$/, ''),
              body: raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim().slice(0, 4000),
              goalId: goalM?.[1] || undefined,
            })
          } catch { /* 单条 learning 读取失败跳过 */ }
        }
      }
    } catch { /* learnings 目录不可读 */ }
    return docs
  }
  /** 计算任务的召回注入段；若命中则登记 pendingRecallRefs（消费在 sweepExperienceVotes）。
   *  上票纪律（P2-③ 防模板噪音）：注入段含全部命中（士兵可见参考），但 recalled 计数走
   *  countableRefs——同目标兄弟任务只注入不计数（流水线常态，非真实跨上下文复用）。 */
  function recallForTask(t: Task, corpus: RecallDoc[]): string | null {
    if (corpus.length === 0) return null
    const taskText = [t.title ?? '', t.description ?? '', ...(t.acceptance ?? [])].join('\n')
    const picks = pickRecall(taskText, corpus)
    if (picks.length === 0) return null
    // 登记：countableRefs（跨目标命中）记 recalled；同目标/自引用只注入不计数
    const refs = pendingRecallRefs.get(t.id) ?? []
    for (const p of countableRefs(picks, t.id, t.goalId)) {
      if (!refs.includes(p.doc.taskId)) refs.push(p.doc.taskId)
    }
    if (refs.length > 0) pendingRecallRefs.set(t.id, refs)
    return renderRecallSection(picks)
  }
  /** 单草稿 promote 动作（P0-3 + P2-① 形态分流）：
   *  resolveKind(草稿 frontmatter kind / 启发式) → procedure：AI 改写 skill → register（pending）；
   *  declarative：AI 改写陈述性条目 → 落盘 docs/experience/learnings/<taskId>.md（带溯源）。
   *  两种出口都在草稿原件记 status:promoted + promotedTo/promotedAt。失败退避下轮。 */
  async function promoteDraft(draftTaskId: string, body: string): Promise<void> {
    if (expPromoting.has(draftTaskId)) return
    const lastFail = expPromoteRetryAt.get(draftTaskId) ?? 0
    if (Date.now() - lastFail < config.intervalMs * 30) return // 退避（默认 30s×30=15min）
    expPromoting.add(draftTaskId)
    try {
      const parent = await ensureForeman(workspace.workspaceFor())
      if (parent === undefined) throw new Error('foreman 不可用，无法 AI 改写')
      // 草稿 scope/kind/role/goalId 从文件 frontmatter 读（无则继承守护 scope / 启发式判定）
      let draftScope = scope
      let draftKind = '' as '' | 'procedure' | 'declarative'
      let draftRole = ''
      let draftGoalId = ''
      try {
        const file = join(expDraftDir(), `${draftTaskId}.md`)
        if (existsSync(file)) {
          const st = parseDraftState(readFileSync(file, 'utf8'))
          draftScope = st.scope || scope
          draftKind = st.kind
          draftRole = st.role ?? ''
          draftGoalId = st.goalId ?? ''
        }
      } catch { /* 读不到用守护默认 */ }
      const kind = resolveKind({ kind: draftKind }, body)
      const promotedTo = kind === 'declarative' ? learningIdForTask(draftTaskId) : skillIdForTask(draftTaskId)
      const isSkill = kind === 'procedure'
      const prompt = isSkill
        ? buildPromotePrompt(draftTaskId, body)
        : buildLearningPrompt(draftTaskId, body)
      const run = await ctx.subagents.start(config.provider, {
        label: `exp:${draftTaskId}:${isSkill ? 'skill' : 'learning'}`,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: AbortSignal.timeout(90000),
        outputSchema: isSkill
          ? { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, main: { type: 'string' }, cases: { type: 'array', items: { type: 'string' } } }, required: ['name', 'description', 'main'], additionalProperties: false }
          : { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
      })
      const result = await run.result
      await run.dispose().catch(() => undefined)
      if (result?.stopReason !== 'completed' || result.structured === undefined) throw new Error(`AI 改写未完成（${result?.stopReason ?? '无结果'}）`)
      if (isSkill) {
        const out = result.structured as { name: string; description: string; main: string; cases?: string[] }
        if (!out.name?.trim() || !out.main?.trim()) throw new Error('AI 改写输出缺 name/main')
        // register 不设 general 门禁（D-2，任意成员可提交 pending）；scope 继承草稿
        await hubPost('/api/skills/register', {
          id: promotedTo, name: out.name.trim(), description: (out.description ?? '').trim(),
          main: out.main, cases: Array.isArray(out.cases) ? out.cases : [],
          scope: draftScope, by: config.role,
        })
      } else {
        // P2-① declarative：不 register skill，落盘 learnings 条目（带溯源 frontmatter，进统一检索面）
        const out = result.structured as { body?: string }
        const mdBody = out?.body?.trim() || fallbackLearning(draftTaskId, body)
        const file = join(expLearningDir(), `${draftTaskId}.md`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, renderLearningFile({
          taskId: draftTaskId, scope: draftScope, role: draftRole, goalId: draftGoalId,
          createdAt: new Date().toISOString(), promotedAt: new Date().toISOString(), body: mdBody,
        }), 'utf8')
      }
      // 草稿溯源：status=promoted + promotedTo/promotedAt（原件不删，正文已有 source 段）
      const file = join(expDraftDir(), `${draftTaskId}.md`)
      if (existsSync(file)) {
        const cur = parseDraftState(readFileSync(file, 'utf8'))
        const promoted = { ...cur, status: 'promoted' as const, promotedTo, promotedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }
        writeFileSync(file, replaceFrontmatter(readFileSync(file, 'utf8'), renderFrontmatter(promoted)), 'utf8')
      }
      const label = isSkill ? `skill:${promotedTo}（pending，待将军 review publish）` : `learning:${promotedTo}（docs/experience/learnings/）`
      activity('experience', draftTaskId, `经验草稿已晋升：${label}`)
      log(`${draftTaskId} → 经验草稿晋升为 ${label}`)
      expPromoteRetryAt.delete(draftTaskId)
    } catch (e) {
      expPromoteRetryAt.set(draftTaskId, Date.now())
      log(`${draftTaskId} 经验草稿 promote 失败（${String(e).slice(0, 200)}），退避后下轮重试`)
    } finally {
      expPromoting.delete(draftTaskId)
    }
  }
  // sweepExperienceVotes（草稿票务更新 → promote/prune 判定）已拆到 ./acceptance.ts（验收边界）；
  // 它的 promote **动作**由本文件 `promoteDraft` 作为兄弟能力注入，原始注释随代码搬入该模块。

  /** 惰性创建 foreman agent：worker subagent 的父（按工作目录缓存；worktree 隔离时每个 worktree 一个）。 */
  async function ensureForeman(cwd: string): Promise<Agent | undefined> {
    const existing = foremen.get(cwd)
    if (existing !== undefined) return existing.agent
    const pending = foremanPending.get(cwd)
    if (pending !== undefined) return pending
    const creating = (async () => {
      try {
        const selection = ctx.agentDefaultModel.currentSelection()
        const base = `${config.mode === 'mediator' ? 'scrum-mediator' : 'scrum-worker'}-foreman-${hashStr(cwd)}`
        // 首选稳定 id（保留「按 cwd 稳定」的原意）；若它已被占（= 上一个进程残留的持久化会话，
        // 见 foremanDown 注释），改写带本实例标识的唯一 id 重建——否则会以同一个确定性错误永久失败。
        const candidates = [base, `${base}-${foremanRunId}`]
        let lastErr: unknown
        for (const sessionId of candidates) {
          try {
            const handle = await ctx.agents.create({
              sessionId: SessionId(sessionId),
              meta: { cwd },
              agentOptions: { provider: selection.provider, model: selection.model },
              setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, config.agentPreset),
            })
            foremen.set(cwd, { agent: handle.agent, dispose: () => handle.dispose() })
            if (foremanDown.delete(cwd)) {
              log(`foreman 恢复：${handle.agent.session.id}（cwd=${cwd}）——此前会话 id 残留导致不可用`)
            } else {
              log(`foreman 就绪：${handle.agent.session.id}（cwd=${cwd}，model=${selection.provider}/${selection.model}）`)
            }
            return handle.agent
          } catch (e) {
            lastErr = e
            // 只有「稳定 id 撞名」才值得换唯一 id 重试；其他错误维持原语义（本轮跳过）
            if (!isSessionExistsError(e) || sessionId !== base) break
            log(`foreman 会话 id 已被占用（${sessionId}，多为此前进程未释放的持久化会话）→ 换唯一 id 重建`)
          }
        }
        // 换唯一 id 仍失败（或非撞名错误）：登记持久失败，并**只在该 cwd 首次失败时**记日志，
        // 避免每轮重复刷屏掩盖真实问题；失败态同时进 daemon 状态供看板/健康页读取。
        const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
        if (!foremanDown.has(cwd)) log(`foreman 创建失败（本轮跳过派工，cwd=${cwd}）：${reason}`)
        const prev = foremanDown.get(cwd)
        foremanDown.set(cwd, {
          reason,
          since: prev?.since ?? new Date().toISOString(),
          attempts: (prev?.attempts ?? 0) + 1,
        })
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
   * scopeFor：跨空间操作（公共调解员）时传任务所属 scope；默认本实例 scope。
   */
  async function transitionTo(id: string, to: string, scopeFor: string = scope, confirmedStopped = false): Promise<void> {
    const t = await getTask(id, scopeFor)
    const by = t.soldier ?? config.role
    if (useHub) {
      await hubPost('/api/transition', { id, to, by, ifVersion: t.version, scope: scopeFor, confirmedStopped })
      return
    }
    await runTaskctl(config.scrumDir, ['transition', id, '--to', to, '--by', by, '--if-version', String(t.version)])
  }

  /** 流水线自动推进：in_progress/in_review → done（推进者=任务角色，将军已授权整条流水线）。 */
  async function advanceTo(id: string, by: string, scopeFor: string = scope): Promise<void> {
    const t = await getTask(id, scopeFor)
    if (useHub) {
      await hubPost('/api/advance', { id, by, ifVersion: t.version, scope: scopeFor })
      return
    }
    await runTaskctl(config.scrumDir, ['advance', id, '--by', by, '--if-version', String(t.version)])
  }

  /** 追加评论（失败不抛出，避免污染主流程）。 */
  async function safeComment(id: string, text: string, scopeFor: string = scope): Promise<void> {
    try {
      if (useHub) {
        await hubPost('/api/comment', { id, by: config.role, text: text.slice(0, 800), scope: scopeFor })
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
    await claimTaskWithResult(id, soldier)
  }

  async function claimTaskWithResult(id: string, soldier: string): Promise<Task | null> {
    const requestId = `daemon:${config.role}:${id}`
    let claimed: Task | null = null
    if (useHub) {
      claimed = await hubPost('/api/claim', {
        id, soldier, by: config.role, scope: scope, requestId,
        ...(config.taskTtlMinutes > 0 ? { ttlMinutes: config.taskTtlMinutes } : {}),
        ...((config.agentNodeId ?? '').trim() !== '' ? { agentNodeId: (config.agentNodeId ?? '').trim() } : {}),
      }) as Task
    } else {
      const argv = ['claim', id, '--soldier', soldier, '--request-id', requestId]
      if (config.taskTtlMinutes > 0) argv.push('--ttl-minutes', String(config.taskTtlMinutes))
      await runTaskctl(config.scrumDir, argv)
    }
    await reportProgress(id, 0, '认领开工')
    abortRetryAt.delete(id) // 新一轮认领（含解阻续做）重置中止退避
    return claimed
  }

  // prepareWorktree / ensurePrePushGuard / commitWorktree 随 workspace 边界搬到 ./workspace.ts，
  // 原始注释（复用优先、残留空壳清理、pre-push 守卫为何走公共 hooks）随代码搬入该模块。

  // ── 分层项目规范（R-2，S5）：全局层（hub rules scope=global，缓存随 sweep 刷新）+ 空间层文件族 ──
  /** 全局层规范文本缓存（拉取失败保留旧值 → 降级只用空间层，不阻塞派工，TC-S5-08；刷新策略与 fetchSkills 同族）。 */
  let normsGlobalText = ''
  async function refreshNorms(): Promise<void> {
    if (!useHub) return
    try {
      const res = await fetch(`${hubUrl}/api/rules?scope=global`, { headers: hubHeaders() })
      if (!res.ok) return // 保留旧缓存
      const data = await res.json() as { rules?: { content?: string } }
      normsGlobalText = typeof data.rules?.content === 'string' ? data.rules.content : ''
    } catch { /* 拉取失败沿用旧值，不阻塞派工 */ }
  }
  /** 空间层文件族：repoRoot 下按固定序 LEGION.md → AGENTS.md → agent.md 读全部存在者；
   *  根部无文件时回退 scrumDir/LEGION.md（现状语义兜底）。 */
  const REPO_NORM_FILES = ['LEGION.md', 'AGENTS.md', 'agent.md']
  /** 规范 tombstone 文件（P1-4.4，对齐 teamai `<type>/.removed`）：仓库根 `.legion-norms-removed`，
   *  每行一个注入源文件名（# 注释/空行跳过）。停用某注入源 = 保留 git 文件但不再注入。 */
  const NORMS_TOMBSTONE_FILE = '.legion-norms-removed'
  /** tombstone 内容缓存（含 mtime 校验；文件未变不重读）。 */
  let normsRemovedCache = { mtimeMs: -1, set: new Set<string>() }
  function readNormsTombstones(): Set<string> {
    try {
      const p = join(workspace.repoRootFor(), NORMS_TOMBSTONE_FILE)
      if (!existsSync(p)) return new Set<string>()
      const st = statSync(p)
      if (st.mtimeMs === normsRemovedCache.mtimeMs) return normsRemovedCache.set
      const set = parseTombstones(readFileSync(p, 'utf8'))
      normsRemovedCache = { mtimeMs: st.mtimeMs, set }
      return set
    } catch { return normsRemovedCache.set }
  }
  function readRepoNormsFiles(): NormFile[] {
    const root = workspace.repoRootFor()
    const files: NormFile[] = []
    for (const name of REPO_NORM_FILES) {
      try {
        const p = join(root, name)
        if (existsSync(p)) files.push({ label: name, content: readFileSync(p, 'utf8') })
      } catch { /* 单文件读取失败跳过 */ }
    }
    if (files.length === 0) {
      try {
        const p = join(config.scrumDir, 'LEGION.md')
        if (existsSync(p)) files.push({ label: 'LEGION.md', content: readFileSync(p, 'utf8') })
      } catch { /* 回退失败 */ }
    }
    // P1-4.4 tombstone 收敛：被将军停用的注入源不进 desired-set（不注入、不误报）
    return applyTombstones(files, readNormsTombstones())
  }
  /** 分层合并（纯函数在 norms.ts，本处喂实时输入）：返回注入 sections（[] = 无规范段）。 */
  function readNormsSync(): { sections: string[]; truncated: boolean } {
    return buildNormSections({ globalText: normsGlobalText, files: readRepoNormsFiles() })
  }

  // ── P1-4.4 规则资产 doctor 已拆到 ./acceptance.ts（验收边界）：desired 规则单元逐条对照最近
  // 真实注入产物，回答"将军的规则是否真的进了士兵提示词"。原始注释（desired-set 口径、状态变化
  // 才 log 的理由）随代码搬入该模块；norms 读取（readRepoNormsFiles / readNormsTombstones /
  // readNormsSync）属规范注入边界，仍留此处由构造点注入。

  /** 归一化相对路径（\\ → /，去 ./，去空白）。 */
  const normRelPath = (p: string): string => String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim()

  /** 所有目标/任务都可写的"共享域"前缀（守护写目标镜像 docs/goals/；其余改动必须落在任务声明文件域内）。 */
  const SHARED_WRITE_PREFIXES = ['docs/goals/']

  /** 本轮目标缓存的并行任务行（同目标、非本任务、未取消；含切片键与文件域）。 */
  function goalSiblingLines(goalId: string, selfId: string): string[] {
    const out: string[] = []
    for (const s of lastTasks) {
      if (s.goalId !== goalId || s.id === selfId || s.status === 'canceled') continue
      const dom = Array.isArray(s.fileDomain) && s.fileDomain.length > 0 ? `（文件域：${s.fileDomain.join(', ')}）` : ''
      out.push(`- ${s.id}｜${s.role ?? s.soldier ?? '?'}｜${s.status}${s.slice ? `｜${s.slice}` : ''}${dom}`)
      if (out.length >= 60) break
    }
    return out
  }

  /** 把 docs/goals/ 加入仓库本地忽略（公共 .git/info/exclude）：镜像 = 运行期产物，绝不能被 worker 的 git add -A 带进提交/合入。 */
  async function ignoreGoalMirrorDir(cwd: string): Promise<void> {
    try {
      // ⚠ 不能拼 `<top>/.git/info/exclude`：隔离 worktree 里 `.git` 是**文件**（`gitdir: …/.git/worktrees/<id>`），
      // 该路径必然 ENOTDIR，异常又被本函数 catch 吞掉 —— 规则于是一次都没装上，镜像被 worker 的 git add -A
      // 带进分支提交，合入时与主干撞成真冲突（T-170 现场：docs/goals/G-mujfc9vi-1.md 冲突）。
      // `rev-parse --git-path info/exclude` 在 worktree 下解析到**公共目录**（主仓库 .git/info/exclude），
      // 而公共目录正是所有 worktree 共读的那一份；返回值可能是相对 cwd 的路径，故此处再绝对化。
      const p = await runGit(cwd, ['rev-parse', '--git-path', 'info/exclude'])
      const raw = p.code === 0 ? p.out.trim() : ''
      if (raw === '') return
      const exclude = isAbsolute(raw) ? raw : join(cwd, raw)
      mkdirSync(dirname(exclude), { recursive: true })
      const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (existing.includes('docs/goals/')) return
      writeFileSync(exclude, `${existing.replace(/\s*$/, '')}\n# legion 目标上下文镜像（运行期产物，不入库）\ndocs/goals/\n`, 'utf8')
    } catch { /* 非 git 目录或不可写：忽略失败，镜像仍写出供阅读 */ }
  }

  /** 把目标上下文镜像写入 worker 工作目录 docs/goals/<goalId>.md（权威源 = hub，此文件供士兵以文件读取，勿手改）。 */
  async function writeGoalContextMirror(goal: GoalCtx, cwd: string): Promise<string | null> {
    try {
      const file = join(cwd, GOAL_MIRROR_DIR, `${goal.id}.md`)
      const body = typeof goal.context === 'string' ? goal.context : ''
      const sib = goalSiblingLines(goal.id, '')
      const lines = [
        `# 目标 ${goal.id} 共享上下文（版本 v${goal.contextVersion ?? 0}）`,
        '',
        `- scope：${goal.scope}`,
        `- objective：${goal.objective}`,
        `- status：${goal.status} · mode：${goal.mode ?? 'chain'}`,
        '',
        '> 本文件是守护派工时的镜像（权威源 = team-hub /api/goal）。士兵只读；将军更新上下文请走指挥台/端点，勿直接改本文件。',
        '',
      ]
      if (body !== '') lines.push('## 目标上下文', '', body, '')
      if (sib.length > 0) lines.push('## 目标下并行任务快照（派工时刻）', '', ...sib, '')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, lines.join('\n'), 'utf8')
      await ignoreGoalMirrorDir(cwd)
      return file
    } catch (e) {
      log(`目标上下文镜像写入失败（${goal.id}）：${String(e)}`)
      return null
    }
  }

  /** 从 hub 拉取本 scope 的目标列表（含 context/contextVersion），刷新 goalCtxById 缓存。失败保留上轮缓存。 */
  async function fetchGoals(): Promise<void> {
    if (!useHub) return
    try {
      const res = await fetch(`${hubUrl}/api/goal?scope=${encodeURIComponent(scope)}`, { headers: hubHeaders() })
      if (!res.ok) return
      const data = await res.json().catch(() => null) as { goals?: GoalCtx[] } | null
      if (!data || !Array.isArray(data.goals)) return
      goalCtxById.clear()
      for (const g of data.goals) goalCtxById.set(g.id, g)
      if (goalCtxById.size > 0) log(`目标上下文同步：${[...goalCtxById.keys()].join(', ')}（${goalCtxById.size} 个）`)
    } catch (e) {
      log(`目标上下文拉取失败（保留上轮缓存）：${String(e)}`)
    }
  }

  /**
   * 权威回查单个目标（缓存缺失时的兜底）。
   * 失败返回 undefined，由调用方决定保守策略——本函数不抛，避免单点查询失败打断派工主流程。
   */
  async function fetchGoalById(goalId: string): Promise<GoalCtx | undefined> {
    if (!useHub) return undefined
    try {
      const res = await fetch(`${hubUrl}/api/goal?scope=${encodeURIComponent(scope)}`, { headers: hubHeaders() })
      if (!res.ok) return undefined
      const data = await res.json().catch(() => null) as { goals?: GoalCtx[] } | null
      const hit = data?.goals?.find(x => x.id === goalId)
      if (hit !== undefined) {
        goalCtxById.set(hit.id, hit) // 顺带回填缓存，后续轮次不再回查
        log(`目标 ${goalId} 状态回查命中：${hit.status}`)
      }
      return hit
    } catch (e) {
      log(`目标 ${goalId} 状态回查失败：${String(e)}`)
      return undefined
    }
  }

  /**
   * 任务分支 w/<id> **自己改的**文件清单（merge 前越域校验用）。
   *
   * ★ BUG-008：这里必须用**三点** diff（`A...B` = merge-base(A,B)..B），不能用两点 `A..B`。
   *
   * 两点法是"两棵树当前的差异"，它会把**主分支在切片跑的过程中新增/修改的文件也算成切片的改动**。
   * 实测（2026-10-05）：`w/T-178` 自己只改了 11 个文件（全在它声明的域内），但两点法给出 13 个 ——
   * 多出来的 2 个是别人在切片飞行期间合进 main 的 `docs/bugs/BUG-006-*.md` / `BUG-006-live-ab.mjs`；
   * 闸门据此判定"越域"，**把一次完全合规的交付拦在了门外**。`w/T-179` 更极端：它一个提交都没有
   * （分支 HEAD 就是自己的基线），两点法却报出 14 个"越域文件" —— 全是 main 新增的。
   *
   * 为什么这个错误方向特别坏：它**随主分支的活动量增加而更容易触发**，即"越多人正常干活，
   * 越容易有人被误拦"，而拦截的代价是交付停在 in_review 等人工。真实越域（切片自己改了域外文件）
   * 三点法一样能抓到 —— 所以修它不会放过任何一个该拦的。
   */
  async function changedFilesOfBranch(t: Task): Promise<string[]> {
    const root = workspace.repoRootFor()
    const headRef = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'HEAD'
    // refspec 由 branchScope 决定（**三点**）——理由与实测见 ./branchScope.ts 的文件头。
    const diff = await runGit(root, ['diff', '--name-only', branchOwnChangesRefspec(headRef, `w/${t.id}`)])
    return diff.out.split('\n').map(s => normRelPath(s)).filter(Boolean)
  }

  /** 越域文件判定：改动文件必须在任务声明的文件域（含其目录前缀）或共享域内。 */
  function outsideDomainFiles(t: Task, changed: string[]): string[] {
    const domain = (t.fileDomain ?? []).map(normRelPath).filter(Boolean)
    if (domain.length === 0) return []
    const allowed = new Set<string>()
    for (const d of domain) { allowed.add(d); allowed.add(d.endsWith('/') ? d : `${d}/`) }
    const ok = (f: string): boolean =>
      SHARED_WRITE_PREFIXES.some(p => f === p || f.startsWith(p)) ||
      [...allowed].some(a => f === a || f.startsWith(a))
    return changed.filter(f => !ok(f))
  }

  /** 解析 git numstat/name-status → 审计用结构化文件清单 [{path,status,add,del}]。 */
  function parseDiffFiles(numstatText: string, nameStatusText: string): Array<{ path: string; status: string; add: number; del: number }> {
    const stat = new Map<string, { add: number; del: number }>()
    for (const line of numstatText.split('\n')) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const add = Number(parts[0]); const del = Number(parts[1])
      if (!Number.isFinite(add) || !Number.isFinite(del)) continue
      stat.set(parts[2].trim(), { add: Math.max(0, add), del: Math.max(0, del) })
    }
    const out: Array<{ path: string; status: string; add: number; del: number }> = []
    const seen = new Set<string>()
    for (const line of nameStatusText.split('\n')) {
      const parts = line.split('\t')
      if (parts.length < 2) continue
      const meta = parts[0].trim()
      const m = meta.match(/^([AMDRCUX])\d*/)
      if (!m) continue
      const status = m[1]
      // 重命名/复制：两列路径，取新路径
      const path = (parts.length > 2 ? parts[2] : parts[1]).trim()
      if (!path || seen.has(path)) continue
      seen.add(path)
      const s = stat.get(path) ?? { add: 0, del: 0 }
      out.push({ path, status, add: s.add, del: s.del })
    }
    // 未出现在 name-status（异常）但 numstat 有 → 兜底 M
    for (const [path, s] of stat) {
      if (!seen.has(path)) { seen.add(path); out.push({ path, status: 'M', add: s.add, del: s.del }) }
    }
    return out
  }

  /** 捕获 worktree 的改动 diff 并记录到任务（taskctl patch / hub patch）。非隔离模式跳过。 */
  async function recordPatch(taskId: string, dir: string | null, summary: string): Promise<void> {
    if (dir === null) return
    try {
      const show = await runGit(dir, ['show', '--format=', 'HEAD'])
      if (show.code !== 0 || show.out.trim().length === 0) return
      const numstat = await runGit(dir, ['diff', '--numstat', 'HEAD~1', 'HEAD'])
      const nameStatus = await runGit(dir, ['diff', '--name-status', 'HEAD~1', 'HEAD'])
      const fileStats = parseDiffFiles(numstat.code === 0 ? numstat.out : '', nameStatus.code === 0 ? nameStatus.out : '')
      if (fileStats.length === 0) {
        const names = await runGit(dir, ['diff', '--name-only', 'HEAD~1', 'HEAD'])
        for (const p of names.out.split('\n').map(s => s.trim()).filter(Boolean)) fileStats.push({ path: p, status: 'M', add: 0, del: 0 })
      }
      if (useHub) {
        await hubPost('/api/patch', { id: taskId, by: config.role, scope, summary, diff: show.out, files: fileStats })
      } else {
        const tmp = join(dir, `.legion-${taskId}.patch`)
        writeFileSync(tmp, show.out, 'utf8')
        try {
          await runTaskctl(config.scrumDir, ['patch', taskId, '--by', config.role, '--summary', summary, '--diff', tmp, '--files', fileStats.map(f => f.path).join(',')])
        } finally {
          try { rmSync(tmp) } catch { /* 清理失败静默 */ }
        }
      }
    } catch (e) {
      log(`${taskId} 记录 diff 失败：${String(e)}`)
    }
  }

  /**
   * 登记 worker 产物（借鉴 dsh-worktable 的 widget-result.json 握手）：
   * html → 看板 iframe 预览；file → 看板链接；url → 跳转。相对路径按 worktree 解析；文件不存在则跳过并记录。
   * - 存储路径统一规整为「仓库相对路径」（剥掉 repoRoot 与 .legion-worktrees/<task> 前缀）：
   *   绝对路径在工作树合并/清理后失效、不可移植、详情里显示难懂（T-111 现场：绝对 worktree 路径已不存在）。
   *   读端 resolveArtifactReadTarget 已支持相对路径（worktree 优先 / 主仓兜底 + 越界拒读）。
   */
  async function recordArtifact(taskId: string, a: WorkerArtifact, worktreeDir: string | null, workflowVersioned = false): Promise<void> {
    try {
      let path = a.path
      let digest: string | undefined
      if (a.kind !== 'url') {
        const base = worktreeDir ?? workspace.workspaceFor()
        const resolved = isAbsolute(path) ? path : join(base, path)
        if (!existsSync(resolved)) {
          log(`${taskId} 产物不存在，跳过登记：${resolved}`)
          await safeComment(taskId, `⚠ 产物路径不存在（未登记预览）：${resolved}`)
          return
        }
        // 独立 workflow worktree 可位于仓库根目录之外，workflow 产物必须相对其冻结 worktree 登记。
        // 普通任务继续相对 repoRoot，并剥掉 .legion-worktrees/<task>/ 分支态前缀以保持兼容。
        const repo = resolve(workspace.repoRootFor())
        const artifactBase = workflowVersioned && worktreeDir ? resolve(worktreeDir) : repo
        let rel = relative(artifactBase, resolve(resolved)).replace(/\\/g, '/')
        if (rel === '' || rel.startsWith('..')) {
          path = resolved // 越出仓库根/根路径本身：保留绝对路径（读端 K10 兼容）
        } else {
          rel = rel.replace(/^\.\//, '')
          const wtPrefix = `.legion-worktrees/${taskId}/`
          if (!(workflowVersioned && worktreeDir) && rel.startsWith(wtPrefix)) rel = rel.slice(wtPrefix.length)
          path = rel
        }
        digest = workflowVersioned ? workflowArtifactDigest(resolved) : fileDigest(resolved)
      }
      const argv = ['artifact', taskId, '--by', config.role, '--kind', a.kind, '--path', path]
      if (a.title && a.title.length > 0) argv.push('--title', a.title.slice(0, 120))
      if (useHub) {
        await hubPost('/api/artifact', { id: taskId, kind: a.kind, path, title: a.title ?? '', ...(digest ? { digest } : {}), by: config.role, scope: scope })
      } else {
        await runTaskctl(config.scrumDir, argv)
      }
      activity('artifact', taskId, `产物已登记：${a.title || path}`)
    } catch (e) {
      log(`${taskId} 登记产物失败：${String(e)}`)
    }
  }

  /**
   * S2 契约文档自动登记：done 结算时（commitWorktree 后、autoPromote 前）按岗位文档契约逐条登记。
   * - 登记路径 = 仓库相对路径（可含 .legion-worktrees 分支态前缀解析交给读端）；kind=file、by=守护；
   * - 幂等：同任务同 path 且与上一条登记条目 digest（sha256）一致 → 跳过（防打回刷屏，AC-R2-3 多轮倒序数据源）；
   * - 双写：hub 可用 → POST /api/artifact（带 digest 供后续幂等比对）；否则走既有 taskctl artifact 路径；
   * - 返回 {registered, missing}：missing 供软门禁判定（契约文档缺失 → 停 in_review，G-R2 缺才停）。
   */
  async function registerContractDocs(t: Task, stage: StageDef, worktreeDir: string | null, goal: GoalCtx | null | undefined): Promise<{ registered: string[]; missing: string[] }> {
    const baseDir = worktreeDir ?? workspace.repoRootFor()
    // docSync 任务契约 = 岗位契约 + docs/FEATURES.md + README.md（纯函数固化，见 resolveStageDocPathsWithDocSync）
    const rawPaths = resolveStageDocPathsWithDocSync(stage, t.id, t.docSync)
    const registered: string[] = []
    const missing: string[] = []
    for (const rawRel of rawPaths) {
      // M1：登记/判缺路径先按目标 docsDir goalize（与 gate 校验 goalDocPath、goalizePrompt 同源语义），
      // 否则 docsDir 目标的产出文档（docs/<goalId>/REQUIREMENTS.md 等）在根 docs/ 检不到 → 误判缺失停 in_review
      // 且登记错根槽位路径（T-111 现场：登记 docs/REQUIREMENTS.md，详情既不正确定位也不预览目标文档）。
      const rel = goalizeContractPath(goal, rawRel)
      const abs = join(baseDir, rel)
      let digest = ''
      try {
        if (!existsSync(abs)) {
          missing.push(rel)
          continue
        }
        digest = t.agentSelectionSnapshot?.source === 'goal-agent-workflow'
          ? workflowArtifactDigest(abs)
          : fileDigest(abs)
        const prev = (t.artifacts ?? []).filter(a => a.kind === 'file' && typeof a.path === 'string' && a.path.split('\\').join('/') === rel).slice(-1)[0]
        if (prev && typeof prev.digest === 'string' && prev.digest === digest) continue // 字节未变幂等跳过
        const argv = ['artifact', t.id, '--by', config.role, '--kind', 'file', '--path', rel]
        if (useHub) {
          await hubPost('/api/artifact', { id: t.id, kind: 'file', path: rel, title: `${stage.label}产出文档`, digest, by: config.role, scope })
        } else {
          await runTaskctl(config.scrumDir, argv)
        }
        registered.push(rel)
      } catch (e) {
        // M2：登记「写入失败」≠ 文档缺失——绝不并入 missing。missing 是软门禁停 in_review 的依据，
        // 写入失败并入会把「文档真实存在、仅记录条目写不进去」误判成「契约产出文档缺失」并错误停闸+错误归因。
        // 这里记录日志：文档在库，缺的只是任务记录上的条目，后续重跑/人工可补，不影响流转。
        log(`${t.id} 契约产物登记失败（${rel}）：${String(e)}`)
      }
    }
    if (registered.length > 0) activity('artifact', t.id, `契约产物登记：${registered.join('、')}`)
    return { registered, missing }
  }

  /** 契约登记/缺失摘要（完成评论用；仅在有登记或有缺失时输出，不刷屏）。 */
  function contractDocSummary(reg: { registered: string[]; missing: string[] } | null): string {
    if (!reg) return ''
    const parts: string[] = []
    if (reg.registered.length > 0) parts.push(`已登记产出文档：${reg.registered.join('、')}`)
    if (reg.missing.length > 0) parts.push(`缺失产出文档：${reg.missing.join('、')}`)
    return parts.length > 0 ? `\n产出文档清单（${reg.registered.length + reg.missing.length} 项）：${parts.join('；')}` : ''
  }

  /**
   * 流水线中间阶段自动合入：merge w/<id> → 当前分支并清理 worktree，让下一角色基于最新主分支工作。
   * 成功返回 true；失败返回 false 且保留 worktree 与分支（改动不丢，供人工合入或重试）。
   */
  async function autoPromote(taskId: string, dir: string): Promise<boolean> {
    try {
      // S6/R-6：集成阶段启用后，旧的 direct merge 通道必须拒绝，改走唯一集成 worker。
      const integrationDecision = decideIntegrationPath({ mode: resolveIntegrationMode(process.env), source: 'autoPromote', taskId })
      if (integrationDecision.action === 'refuse-legacy') {
        if (!useHub) {
          log(`${taskId} 集成服务不可用：请连接 team-hub 后重试交付`)
          return false
        }
        const source = await runGit(workspace.repoRootFor(), ['rev-parse', '--verify', `w/${taskId}`])
        if (source.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(source.out.trim())) {
          log(`${taskId} 任务分支没有可交付提交：${source.err || source.out}`)
          return false
        }
        const result = await hubPost('/api/deliveries/submit', {
          by: config.role, scope, taskId, sourceCommit: source.out.trim(),
        }) as { ok?: boolean, delivery?: { state?: string }, code?: string }
        if (result.ok !== true || result.delivery?.state !== 'integrated') {
          log(`${taskId} 集成未完成：${result.code ?? result.delivery?.state ?? 'unknown'}`)
          return false
        }
        const removed = await runGit(workspace.repoRootFor(), ['worktree', 'remove', '--force', dir])
        if (removed.code !== 0) log(`${taskId} 已交付，工作区清理稍后重试：${removed.err || removed.out}`)
        else await runGit(workspace.repoRootFor(), ['branch', '-D', `w/${taskId}`])
        log(`${taskId} 已通过集成验证并合入目标分支`)
        return true
      }
      // 防御：上一次合入失败可能遗留冲突态（MERGE_HEAD/未合并文件），会挡住后续所有 merge —— 先清一次
      const staleAbort = await runGit(workspace.repoRootFor(), ['merge', '--abort'])
      if (staleAbort.code === 0) log(`${taskId} 清理了上次遗留的合入冲突态（merge --abort）`)
      const merge = await runGit(workspace.repoRootFor(), ['merge', '--no-ff', `w/${taskId}`, '-m', `promote ${taskId}`])
      if (merge.code !== 0) {
        log(`${taskId} 自动合入失败：${(merge.err || merge.out).trim()}`)
        // 关键：失败立即 abort，绝不让主仓库停在冲突态毒化后续合入；改动仍在 w/<taskId> 分支与 worktree，可人工合入或后续重试
        await runGit(workspace.repoRootFor(), ['merge', '--abort'])
        return false
      }
      await runGit(workspace.repoRootFor(), ['worktree', 'remove', '--force', dir])
      await runGit(workspace.repoRootFor(), ['branch', '-D', `w/${taskId}`])
      log(`${taskId} 已自动合入主分支并清理 worktree`)
      return true
    } catch (e) {
      log(`${taskId} 自动合入异常：${String(e)}`)
      return false
    }
  }

  // 流水线阶段交接（`advancePipeline`）已拆到 ./handoff.ts（交接边界）；原始注释（切片/fix/
  // 分析前缀尾为何不走 next 流转、"后继已存在"的两条识别口径）随代码搬入该模块。D7' 机器闸门
  // 的**绕行谓词** `isSliceTesterTask` 是那里的**纯函数导出**（本文件两个读点共用它）；闸门的
  // **动作** `settleSliceTest` 仍留本文件（要用 hub / worktree / ctx 的执行面能力）。接线见
  // 下方 `const handoff = createHandoff({...})`。

  /** P1-4.4 doctor 用：最近一次 buildWorkerPrompt 的真实注入产物（sections 拼接 + 截断标志）。
   *  守护每轮派工至少一次 → 该缓存反映"最近一个士兵实际看到的规则文本"。 */
  let lastInjectedNorms = { text: '', truncated: false }
  function buildWorkerPrompt(t: Task, feedback: Task['comments'], cwd: string, isolated: boolean, stage?: StageDef, goal?: GoalCtx | null, goalMirror?: string | null): string {
    const norms = readNormsSync() // 分层规范（R-2/S5）：全局层段 + 空间层段，顺序稳定
    lastInjectedNorms = { text: norms.sections.join('\n'), truncated: norms.truncated }
    // P2-③ 经验自动召回：相关经验草稿/learnings 段（在规范之后、共享技能之前注入；
    // 命中即登记 pendingRecallRefs，本轮 sweep 消费为 recalled 事件）。
    const recallSection = recallSectionCache(t)
    // 目标级共享上下文段：同目标所有衍生任务共享（objective + context vN + 并行任务快照），
    // 语义 = 下一派工对齐（派工时刻拉取的最新版本；正在跑的 worker 不打断）。
    const goalLines: string[] = []
    if (goal !== null && goal !== undefined) {
      const ctxBody = typeof goal.context === 'string' ? goal.context.trim() : ''
      goalLines.push(
        '',
        `所属目标：${goal.id}（${goal.scope} · ${goal.status}${goal.mode ? ` · ${goal.mode}` : ''}）—— 本任务是该目标下的一个环节，与同目标其他任务共享下列目标上下文；不得把其他目标/其他任务的口径当作本任务的依据。`,
        `目标（objective）：${goal.objective}`,
        `目标上下文（contextVersion v${goal.contextVersion ?? 0}）：${ctxBody !== '' ? ctxBody.slice(0, 4000) : '（未填写）'}`,
        `目标上下文镜像（全文按文件阅读，只读勿改）：${goalMirror ?? `docs/goals/${goal.id}.md`}`,
      )
      // 目标级分析文档目录：阶段产物文档按目标隔离（不同目标写各自目录，可跨目标并行）。有 docsDir 才注入。
      if (goal.docsDir) {
        goalLines.push(
          `本目标分析文档目录：${goal.docsDir}/ —— 阶段产物链 REQUIREMENTS.md（需求）→ RESEARCH.md（方案）→ TASK_BREAKDOWN.md（拆解）→ TEST_CASES.md（用例）→ TEST_REPORT.md（测试报告）→ DEPLOY.md（部署），**只认本目录版本**。`,
          '本阶段产出文档写入该目录，上游依据文档也从该目录读取；禁止读写仓库根 docs/ 或其他目标目录下的同名阶段文档（会与他人合入冲突）。REVIEW 意见不受此影响，仍写 docs/review/<任务ID>-REVIEW.md。',
        )
      }
      const sib = goalSiblingLines(t.goalId ?? goal.id, t.id)
      if (sib.length > 0) goalLines.push('目标下并行任务快照（同目标任务并行推进，只处理与本任务衔接，不越界替别人干活）：', ...sib)
    }
    // 文件域约束段：切片任务声明文件域，改动越域会被 merge 前机器闸门拦截（B 层防窜台）。
    const domLines: string[] = []
    if (t.fileDomain !== null && t.fileDomain !== undefined && t.fileDomain.length > 0) {
      domLines.push(
        '',
        '文件域约束（机器校验）：只允许改动以下声明文件/目录（及其子路径），外加 docs/goals/ 镜像目录；',
        ...t.fileDomain.map(f => `- ${f}`),
      )
    }
    const reviewWorkflow = t.agentSelectionSnapshot?.reviewWorkflow
    const workflowContext = t.agentSelectionSnapshot?.workflowContext
    const externalProviderStage = t.agentSelectionSnapshot?.agentToolConfig?.adapter === 'dsh-subagent'
    const externalDesignStage = externalProviderStage && isWorkflowStage(t, stage, 'design')
    const externalReviewStage = externalProviderStage && isWorkflowStage(t, stage, 'review')
    const handoffLines: string[] = []
    for (const artifact of workflowContext?.designArtifacts ?? []) {
      handoffLines.push(`冻结设计版本：task=${artifact.taskId} path=${artifact.path} sha256=${artifact.digest}（UTF-8 文本按 LF 规范化后计算，CRLF 与 LF 等价）；必须以该文件内容为本阶段设计输入，不要用工作树原始字节哈希与此摘要比较。`)
    }
    if (workflowContext?.implementation !== null && workflowContext?.implementation !== undefined) {
      handoffLines.push(`冻结实现版本：task=${workflowContext.implementation.taskId} commit=${workflowContext.implementation.sourceCommit} stageAttempt=${workflowContext.implementation.stageAttemptId} providerRun=${workflowContext.implementation.providerRunId ?? '(provider未提供)'}`)
      handoffLines.push(`测试命令：${workflowContext.implementation.testCommand}\n测试结果：${workflowContext.implementation.testSummary}\n测试证据：${workflowContext.implementation.testEvidence}`)
      const verification = workflowContext.implementation.testVerification
      if (verification) {
        handoffLines.push(`Legion 独立测试回执：testRun=${verification.id} state=${verification.state} commit=${verification.sourceCommit} stageAttempt=${verification.stageAttemptId} providerRun=${verification.providerRunId ?? '(provider未提供)'} runnerNode=${verification.runnerNodeId ?? '(unknown)'} argv=${JSON.stringify([verification.executable, ...verification.args])} exitCode=${verification.exitCode} outputSHA256=${verification.outputDigest}\n独立测试输出摘录：${verification.outputExcerpt}`)
      }
    }
    for (const upstream of workflowContext?.upstreamStages ?? []) {
      if (upstream.artifacts.length > 0) {
        handoffLines.push(`上游阶段 ${upstream.stageId ?? upstream.role}（task=${upstream.taskId}）产物：${upstream.artifacts.map((artifact) => `${artifact.path}${artifact.digest ? ` sha256=${artifact.digest}` : ''}`).join(', ')}`)
      }
      const evidence = upstream.evidence.map((item) => item.text).filter((text) => typeof text === 'string' && text.trim() !== '')
      if (evidence.length > 0) handoffLines.push(`上游阶段 ${upstream.stageId ?? upstream.role} 证据（task=${upstream.taskId}）：${evidence.join('\n')}`)
    }
    const frozenStage = t.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitionsById?.[t.agentSelectionSnapshot.workflowStageId ?? '']
      ?? t.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitions?.[t.role ?? '']
    if (frozenStage?.inputContract || frozenStage?.outputContract) {
      handoffLines.push(`冻结阶段 ${frozenStage.id ?? frozenStage.role} 输入契约：${JSON.stringify(frozenStage.inputContract ?? {})}`)
      handoffLines.push(`冻结阶段 ${frozenStage.id ?? frozenStage.role} 输出契约：${JSON.stringify(frozenStage.outputContract ?? {})}`)
    }
    const lines = [
      stage
        ? `你是军团士兵，当前角色「${stage.label}」（${stage.role}）。任务 ${t.id} 由你独立完成。`
        : `你是军团士兵 ${config.role}（守护循环派发的临时 worker），任务 ${t.id} 由你独立完成。`,
      '',
      ...(stage ? [`角色职责（必须遵守）：${goalizePrompt(stage.prompt, goal)}`, ''] : []),
      ...(isWorkflowStage(t, stage, 'review')
        ? [
            '本阶段是 Codex 风格的独立审查。只审查，不修改代码或设计产物；逐条给出可复现依据。',
            '最终只输出一个完整 WorkerReport JSON 对象；review 必须是顶层字段，与 status、summary、evidence、blocker、artifact 同级，不能把 review JSON 写进 evidence/summary，也不能写成 review= 前缀。通过示例：{"status":"done","summary":"审查通过","evidence":"核对了设计、实现与测试","blocker":"","artifact":null,"review":{"passed":true,"findings":[]}}。发现问题示例：{"status":"done","summary":"发现实现问题","evidence":"src/example.js:12 与设计不一致","blocker":"","artifact":null,"review":{"passed":false,"findings":[{"kind":"implementation","summary":"问题","evidence":"文件/行号/可复现依据"}]}}。finding.kind 只能是 implementation 或 design。',
            `实现问题回到 ${reviewWorkflow?.implementationRole ?? '实现阶段'}；设计问题回到 ${reviewWorkflow?.designRole ?? '设计阶段'}；混合问题必须同时分类，系统会优先退回设计。返工上限：${reviewWorkflow?.maxReworkRounds ?? 0} 轮。`,
            '无法归类、证据不足或结论矛盾时不要声称通过；写入 blocker 并停在待澄清状态。',
            '',
          ]
        : []),
      ...(isWorkflowStage(t, stage, 'design')
        ? [
            '本阶段必须产出可提交到仓库的设计文件，并在最终 JSON 的 artifact 中登记 kind=file、仓库相对 path 和标题；没有带 SHA-256 的文件版本不得完成设计阶段。',
            '设计文件必须包含接口/数据结构、实施步骤、验收标准与风险；后续实现只消费系统冻结的该版本。',
            '',
          ]
        : []),
      ...(externalDesignStage
        ? [
            '外部设计 Agent 权限与收尾约束：只使用冻结权限模式已允许的工具；不要请求交互式人工审批，也不要调用 Bash、PowerShell、终端、网络或包管理器。设计文件写完后由 Legion 计算并登记 SHA-256，无需自行运行 git/hash 命令；完成后立即输出下方严格 JSON，不再调用额外工具。若在此权限范围内无法完成，返回 status=blocked 并说明具体原因。',
            '',
          ]
        : []),
      ...(externalReviewStage
        ? [
            '外部审查 Agent 权限约束：这是只读审查，必须实际查看隔离 worktree 中的设计、实现、测试和 git diff；允许使用只读文件查看与只读终端命令（例如 git status/diff/show、rg、sed、cat）。禁止编辑、创建、删除、格式化文件，禁止 git checkout/reset/commit/push，禁止网络访问和包管理器，也不要请求人工审批。引用具体文件与行号或可复现证据；无法读取材料时返回 status=blocked 并说清限制。',
            '',
          ]
        : []),
      ...(isWorkflowStage(t, stage, 'implementation')
        ? [
            '本阶段必须基于提示中列出的冻结设计文件实现，并运行相关测试。最终 JSON 必须包含 testReport：passed=true、command 为实际执行的测试命令、summary 非空、evidence 为实际测试输出或结果摘录、failures 为空；没有真实通过证据时不得报告 done。',
            'Git 提交由 Legion 在 Agent 返回后于宿主侧创建，供独立测试与后续审查绑定准确提交；不要运行 git add、git commit 或其他 Git 写操作。完成实现和测试后直接返回 done 报告，不要因沙箱拒绝访问 worktree 外的公共 .git 目录而改报 blocked。',
            '',
          ]
        : []),
      ...(handoffLines.length > 0 ? ['不可变上游交接证据（派工前已校验摘要，禁止以其他版本替代）：', ...handoffLines, ''] : []),
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
      ...(t.docSync === true
        ? [
            '',
            '文档同步（doc-sync，R-4/D3）**必须**：本任务是「用户可见行为变更」——请同步更新功能手册 `docs/FEATURES.md` 对应小节 + §4 功能索引（F-xx 行）+ README 引导段（模块导航互链）。若该功能手册尚无对应小节，请新增并登记进功能索引。',
          ]
        : []),
      t.blockedBy.length > 0 ? `依赖（应已完成）：${t.blockedBy.join(', ')}` : '',
      ...(stage?.role === 'tester' && t.testReport
        ? [
            '',
            '上一轮测试报告（对照检查；本轮必须重新运行并输出**新的** testReport）：',
            `- passed=${t.testReport.passed}`,
            ...(t.testReport.failures ?? []).map(f => `- 失败用例 ${f.name}：${f.log ?? ''}${f.repro ? `（复现：${f.repro}）` : ''}`),
            ...(t.testReport.summary ? [`- 小结：${t.testReport.summary}`] : []),
          ]
        : []),
      ...(t.fixOf
        ? [
            '',
            '本任务是**修复任务**（针对失败测试回炉）：按任务描述中的失败用例定位根因并修复。',
            '修复纪律：',
            '- 不得通过修改测试用例 / 验收预期来掩盖失败；',
            '- 修复后必须跑真实命令回归验证（复现 → 修复 → 复测），evidence 写清命令与输出要点；',
            '- 若修复需要改动本切片文件域之外的代码，在 evidence 说明理由。',
          ]
        : []),
      '',
      '历史评论（含将军的退回反馈，必须处理）：',
      ...(t.comments.length > 0
        ? t.comments.map(c => `- @${c.by}（${c.at}）: ${c.text}`)
        : ['- （无）']),
      ...(norms.sections.length > 0 ? ['', ...norms.sections] : []),
      ...(recallSection ? ['', recallSection] : []),
      ...(sharedSkills.length > 0
        ? ['', '团队共享技能（必须遵守，来自 team-hub）：', ...sharedSkills.map(s => formatSkill(s))]
        : []),
      ...(spaceBinding !== null
        ? ['', `空间仓库绑定（本工作空间）：本地文件夹 = ${spaceBinding.localDir}${spaceBinding.remoteUrl ? `；远程仓库 = ${spaceBinding.remoteUrl}` : '（仅本地，不进共享仓库）'}`]
        : []),
      ...(domLines),
      ...(goalLines),
      '',
      '纪律：',
      '1. 只做实现与验证；状态迁移一律由守护负责。唯一允许调用的 taskctl 命令是 `taskctl progress <id> --by <角色> --percent <0-100> --note <一句话>`（上报进度遥测，不迁移状态）；其余 taskctl / task_* / 看板写接口一律禁止。',
      externalDesignStage
        ? '2. 完成标准 = 验收标准逐条真实满足；设计阶段按上方权限边界工作，不要求运行 shell 命令，给出基于实际读取内容与检查的证据。'
        : externalReviewStage
          ? '2. 完成标准 = 验收标准逐条真实满足；审查阶段必须按上方约束只读查看文件与差异，不得修改工作区，给出逐项审查证据。'
          : '2. 完成标准 = 验收标准逐条真实满足：跑真实命令验证（typecheck / build / test），给出证据。',
      '3. 改动落在工作目录内；如需更新 legion 文档一并更新。',
      '4. 禁止联网与任何 push（pre-push 已拦截 w/* 分支）；外部依赖若缺失，在证据里说明而非擅自下载。',
      '4b. 遇到**必须将军拍板**的疑问（关键歧义无法自行消解 / 取舍超出本角色职权 / 关键输入缺失等）：不要臆断硬做，也不要悄悄绕过——把疑问逐条写进报告 blocker（每条以「❓ 待将军确认」开头，附你的倾向与依据），走 status=blocked；任务会醒目提示将军，将军评论答复后你会带着答复继续。能自行合理决策的小问题自己定，在 evidence 里写明假设。',
      '5. 最终回复只输出 JSON 报告，不要额外叙述：',
      ...(externalDesignStage || externalReviewStage
        ? ['严格遵循上方冻结阶段提示中的 WorkerReport 字段与结果约束，只输出一个最终报告对象；不要复述 schema 或附加其他 JSON 示例。']
        : [
            '   {"status":"done","summary":"一句话总结","evidence":"验证证据（命令与输出要点）","blocker":"","artifact":null}',
            '   "artifact" 可选（无产物必须为 null）：{"kind":"html|file|url","path":"产物绝对路径（工作目录内）","title":"一句话标题"}——html 会进看板 iframe 预览，file/url 变成看板链接。',
            '   或 {"status":"blocked","summary":"已完成的部分","evidence":"","blocker":"卡在哪个文件/命令/什么报错（必须具体）","artifact":null}',
          ]),
      ...(goal !== null && goal !== undefined && !externalDesignStage && !externalReviewStage
        ? ['   若上方含「所属目标」，报告 JSON 请再追加 "goalRef":{"goalId":"<目标ID>","contextVersion":<执行时依据的版本整数>}（仅用于版本对账，不改变报告语义）。']
        : []),
      ...(isSliceTesterTask(stage, t)
        ? [
            '',
            '**测试士兵纪律（切片验收岗，D7\' 机器闸门）**：只测不修——绝不改动被测代码/测试用例来"通过"。',
            '运行测试用例并给出真实证据；最终报告 JSON 必须带 testReport 字段：',
            '   {"status":"done","summary":"一句话","evidence":"运行了什么命令、输出要点","blocker":"","artifact":null,',
            '    "testReport":{"passed":false,"summary":"一句话小结","failures":[{"name":"用例名","log":"失败日志要点","repro":"复现命令"}]}}',
            '   passed=true 才会自动验收 done；有任何失败必须 passed=false 并逐条列进 failures。',
          ]
        : []),
      '',
    ]
    return lines.filter(l => l.length > 0).join('\n')
  }

  /**
   * D7' 机器闸门：切片测试士兵的结算（只测不修）。
   * 报告 testReport.passed=true → 自动 done（advanceTo by=tester，服务器放行 in_review→done by 岗位）；
   * 失败 → in_review + 登记报告 + 按预算创建 fix 回炉任务（role coder, fixOf=本 tester, blockedBy=[]，
   *   创建由守护条件闸门而非依赖链把关，避免 openDeps 死锁）；预算用尽 → ❓ 升级将军人工处理。
   * 切片功能依赖 hub 端点（/api/test-report、/api/create 扩展字段）；非 hub 退化为普通人工验收。
   */
  async function settleSliceTest(t: Task, worktreeDir: string | null, report: WorkerReport): Promise<void> {
    if (!useHub) {
      await transitionTo(t.id, 'in_review')
      await safeComment(t.id, `✓ 切片测试完成（hub 不可用，机器闸门退化为人工验收）：${report.summary}\n证据：${report.evidence}`)
      activity('done', t.id, `切片测试完成（hub 不可用）：${report.summary}`)
      log(`${t.id} → in_review（切片测试，hub 不可用，等将军验收）`)
      return
    }
    if (worktreeDir !== null) await workspace.commitWorktree(t.id, worktreeDir, report.summary) // 测试通常无改动；有则留档
    await recordPatch(t.id, worktreeDir, report.summary)
    if (report.artifact && report.artifact.path) await recordArtifact(t.id, report.artifact, worktreeDir)
    const rp = report.testReport && typeof report.testReport === 'object' ? report.testReport : null
    const passed = rp?.passed === true
    try {
      await hubPost('/api/test-report', {
        id: t.id, by: 'tester', scope,
        passed, failures: rp?.failures ?? [], summary: rp?.summary ?? report.summary,
      })
    } catch (e) {
      log(`${t.id} test-report 登记失败：${String(e)}`)
      await safeComment(t.id, `⚠ test-report 登记失败：${String(e).slice(0, 200)}`)
    }
    const failLines = (rp?.failures ?? []).map(f =>
      `- ${f?.name ?? '（未命名用例）'}${f?.log ? `：${f.log}` : ''}${f?.repro ? `（复现：${f.repro}）` : ''}`)
    const failText = failLines.length > 0 ? failLines.join('\n') : '（无失败明细）'
    if (passed) {
      await advanceTo(t.id, 'tester')
      await safeComment(t.id, `✅ 切片测试通过（机器闸门自动 done）：${rp?.summary ?? report.summary}\n证据：${report.evidence}`)
      activity('done', t.id, `切片测试通过：${report.summary}`)
      log(`${t.id} → done（D7' 机器闸门通过）`)
      return
    }
    // 失败：in_review + 修复预算裁决
    await transitionTo(t.id, 'in_review')
    await safeComment(t.id, `❌ 切片测试未通过（testReport 已登记）：\n${failText}\n机器闸门：修复完成、重测通过后才自动 done。`)
    activity('test-fail', t.id, `切片测试失败：${(rp?.summary ?? report.summary).slice(0, 120)}`)
    const all = await listTasks()
    const fixes = all.filter(f => f.role === 'coder' && f.fixOf === t.id && f.status !== 'canceled')
    const used = fixes.length
    const openFix = fixes.find(f => f.status !== 'done')
    if (openFix) {
      log(`${t.id} 已有在途修复任务 ${openFix.id}，跳过重复创建`)
      return
    }
    if (used >= config.maxFixPerSlice) {
      await safeComment(t.id, `❓ 修复预算已用尽（maxFixPerSlice=${config.maxFixPerSlice}，已回炉 ${used} 轮仍未通过）。请将军人工介入：检查失败用例、修正验收口径或手动安排修复。`)
      activity('escalate', t.id, `切片测试 ${used} 轮未通过，预算用尽，升级将军`)
      log(`${t.id} fix 预算用尽（${used}/${config.maxFixPerSlice}），升级将军人工处理`)
      return
    }
    const round = used + 1
    const sliceNo = t.sliceIdx ?? ''
    const baseTitle = (t.title ?? '').replace(/^【[^】]*】/, '').slice(0, 30)
    try {
      const res = await hubPost('/api/create', {
        title: `【切片 S${sliceNo} 修复·第${round}轮】${baseTitle}`,
        description: `[auto-goal]\n[fix]\n目标：修复「${t.id}」切片测试失败（第 ${round} 轮回炉）。\n失败用例：\n${failText}\n\n修复纪律：定位根因修复，禁止改测试预期掩盖失败；完成后跑真实命令回归并给出证据。`,
        role: 'coder', status: 'todo', priority: 'high',
        parent: t.id, blockedBy: [], slice: t.slice, sliceIdx: t.sliceIdx, fixOf: t.id,
        goalId: t.goalId ?? undefined, fileDomain: t.fileDomain ?? undefined,
        acceptance: [
          `复现并定位「${t.id}」报告中每个失败用例的根因`,
          '修复根因（不得通过修改测试用例 / 验收预期掩盖失败）',
          '跑真实命令回归（复现 → 修复 → 复测），evidence 给出命令与输出要点',
        ],
        boundary: {
          do: [`只改动本切片文件域（${t.slice}）内的实现`],
          dont: ['修改测试用例与验收预期来掩盖失败', '改动本切片文件域之外的代码（除非 evidence 说明必要理由）'],
        },
        by: config.role, scope,
      }) as { id?: string }
      const fixId = res.id ?? ''
      if (fixId !== '') {
        await safeComment(t.id, `🛠 已派发修复任务 ${fixId}（第 ${round} 轮，预算 ${used + 1}/${config.maxFixPerSlice}）；修复完成合入后本任务自动重开重测。`)
        activity('fix', t.id, `派发修复任务 ${fixId}（第 ${round} 轮回炉）`)
        log(`${t.id} → in_review，已派发修复任务 ${fixId}（第 ${round}/${config.maxFixPerSlice} 轮）`)
      }
    } catch (e) {
      log(`${t.id} 修复任务创建失败：${String(e)}`)
      await safeComment(t.id, `⚠ 修复任务创建失败：${String(e).slice(0, 200)}（请将军人工安排修复）`)
    }
  }

  /**
   * Workflow handoffs identify text artifacts independent of Git's Windows CRLF checkout conversion.
   * Keep the ordinary space-pipeline byte digest unchanged; workflow artifacts use canonical LF text.
   */
  function workflowArtifactDigest(file: string): string {
    const bytes = readFileSync(file)
    if (bytes.includes(0)) return createHash('sha256').update(bytes).digest('hex')
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) return createHash('sha256').update(bytes).digest('hex')
    return createHash('sha256').update(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'), 'utf8').digest('hex')
  }

  function stageContractArtifacts(stage: StageDef | undefined, direction: 'input' | 'output'): string[] {
    const contract = direction === 'input' ? stage?.inputContract : stage?.outputContract
    const value = contract?.artifacts
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new Error(`阶段 ${stage?.workflowStageId ?? stage?.id ?? stage?.role ?? '(unknown)'} 的 ${direction}Contract.artifacts 格式无效`)
    }
    return value.map((item) => item.trim())
  }

  function artifactLabels(items: Array<{ path?: string; title?: string }>): Set<string> {
    const labels = new Set<string>()
    for (const item of items) {
      if (typeof item.path === 'string') {
        labels.add(item.path.trim().toLowerCase())
        labels.add(basename(item.path.replaceAll('\\', '/')).trim().toLowerCase())
      }
      if (typeof item.title === 'string') labels.add(item.title.trim().toLowerCase())
    }
    return labels
  }

  async function verifyAgentWorkflowInputs(t: Task, stage: StageDef | undefined, cwd: string): Promise<void> {
    const workflow = t.agentSelectionSnapshot?.reviewWorkflow
    if (workflow === null || workflow === undefined || stage === undefined) return
    if (!useHub) throw new Error('阶段 Agent 工作流需要 team-hub 持久化工具快照与交接证据')
    const context = t.agentSelectionSnapshot?.workflowContext
    const needsDesign = isWorkflowStage(t, stage, 'implementation') || isWorkflowStage(t, stage, 'review')
    if (needsDesign && (!Array.isArray(context?.designArtifacts) || context.designArtifacts.length === 0)) {
      throw new Error(`阶段 ${stage.role} 缺少冻结设计产物版本`)
    }
    for (const artifact of context?.designArtifacts ?? []) {
      if (typeof artifact.path !== 'string' || artifact.path.trim() === '' || isAbsolute(artifact.path)
        || !/^[0-9a-f]{64}$/.test(artifact.digest)) {
        throw new Error(`设计产物版本引用格式无效：${artifact.path ?? '(missing)'}`)
      }
      const target = resolve(cwd, artifact.path)
      const fromRoot = relative(resolve(cwd), target)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || !existsSync(target)) {
        throw new Error(`冻结设计产物不存在或越出工作区：${artifact.path}`)
      }
      if (fileDigest(target) !== artifact.digest && workflowArtifactDigest(target) !== artifact.digest) {
        throw new Error(`冻结设计产物摘要已变化：${artifact.path}（期望 ${artifact.digest}）`)
      }
    }
    for (const upstream of context?.upstreamStages ?? []) {
      for (const artifact of upstream.artifacts) {
        if (artifact.kind !== 'file' || typeof artifact.path !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.digest ?? '')) continue
        if (isAbsolute(artifact.path)) throw new Error(`上游阶段产物路径必须相对工作区：${artifact.path}`)
        const target = resolve(cwd, artifact.path)
        const fromRoot = relative(resolve(cwd), target)
        if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || !existsSync(target)) {
          throw new Error(`上游阶段产物不存在或越出工作区：${artifact.path}`)
        }
        if (fileDigest(target) !== artifact.digest && workflowArtifactDigest(target) !== artifact.digest) {
          throw new Error(`上游阶段产物摘要已变化：${artifact.path}（期望 ${artifact.digest}）`)
        }
      }
    }
    const requiredInputs = stageContractArtifacts(stage, 'input')
    const upstreamArtifacts = (context?.upstreamStages ?? []).flatMap((upstream) => upstream.artifacts)
    const availableInputs = artifactLabels(upstreamArtifacts)
    if ((context?.implementation?.sourceCommit ?? '') !== '') availableInputs.add('commit')
    if ((context?.implementation?.testEvidence ?? '').trim() !== '') availableInputs.add('test-evidence')
    if ((context?.implementation?.testSummary ?? '').trim() !== '') availableInputs.add('test-results')
    const missingInputs = requiredInputs.filter((name) => !availableInputs.has(name.toLowerCase()))
    if (missingInputs.length > 0) {
      throw new Error(`阶段 ${t.agentSelectionSnapshot?.workflowStageId ?? stage.role} 缺少契约要求的上游产物：${missingInputs.join(', ')}`)
    }
    if (isWorkflowStage(t, stage, 'review')) {
      const implementation = context?.implementation
      if (implementation === null || implementation === undefined
        || !/^[0-9a-f]{40,64}$/i.test(implementation.sourceCommit)
        || implementation.testSummary.trim() === '' || implementation.testCommand.trim() === ''
        || implementation.testEvidence.trim() === '') {
        throw new Error('审查阶段缺少实现提交或测试证据')
      }
      const commit = await runGit(cwd, ['cat-file', '-e', `${implementation.sourceCommit}^{commit}`])
      if (commit.code !== 0) throw new Error(`审查提交不存在于当前工作区历史：${implementation.sourceCommit}`)
      const ancestor = await runGit(cwd, ['merge-base', '--is-ancestor', implementation.sourceCommit, 'HEAD'])
      if (ancestor.code !== 0) throw new Error(`当前审查工作区不包含待审实现提交：${implementation.sourceCommit}`)
    }
  }

  /** 派一个 worker 处理任务（认领已完成或任务本身可开工）。 */
  async function runWorker(t: Task, feedback: Task['comments'], stage?: StageDef): Promise<void> {
    // 跨 Agent 目标的阶段定义与拓扑在目标发布时冻结；不能因空间普通阶段被重排、停用或删除而换岗。
    const frozenStage = t.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitionsById?.[t.agentSelectionSnapshot.workflowStageId ?? '']
      ?? t.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitions?.[t.role ?? '']
    if (frozenStage?.role === t.role) stage = frozenStage
    // 决定工作目录：isolate 时建 worktree（分支 w/<id>），失败回退工作目录（可能为空间绑定的本地文件夹）
    let cwd = workspace.workspaceFor()
    let worktreeDir: string | null = null
    let workflowReviewBaseCommit: string | null = null
    let workflowImplementationBaseCommit: string | null = null
    if (config.isolate) {
      worktreeDir = await workspace.prepareWorktree(t.id)
      if (worktreeDir !== null) cwd = worktreeDir
      else log(`${t.id} worktree 不可用，回退到 workspace 直接工作`)
    }
    if (resolveIntegrationMode(process.env) === 'integration' && worktreeDir === null) {
      await safeComment(t.id, '⛔ 集成模式要求独立工作区；本次未获得独立工作区，已停止写入派工。请修复工作区后重试。')
      await transitionTo(t.id, 'blocked', scope, true)
      return
    }
    if (resolveIntegrationMode(process.env) === 'integration' && worktreeDir !== null) {
      const target = await runGit(workspace.repoRootFor(), ['symbolic-ref', '-q', 'HEAD'])
      const status = await runGit(worktreeDir, ['status', '--porcelain=v1', '--untracked-files=all'])
      if (target.code !== 0 || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(target.out.trim()) || status.code !== 0 || status.out.trim()) {
        await safeComment(t.id, '⛔ 隔离工作区有未提交改动，或目标分支无法确认；请先保存现场，随后重试派工。')
        await transitionTo(t.id, 'blocked', scope, true)
        return
      }
      const fresh = await runGit(worktreeDir, ['merge-base', '--is-ancestor', target.out.trim(), 'HEAD'])
      if (fresh.code !== 0) {
        const rebase = await runGit(worktreeDir, ['rebase', target.out.trim()])
        if (rebase.code !== 0) {
          const aborted = await runGit(worktreeDir, ['rebase', '--abort'])
          await safeComment(t.id, `⛔ 续做前无法把既有成果对齐到最新目标版本，已暂停派工。${aborted.code === 0 ? '原有提交已保留。' : '自动撤销失败，请检查隔离工作区。'} 原因：${(rebase.err || rebase.out).slice(0, 300)}`)
          await transitionTo(t.id, 'blocked', scope, true)
          return
        }
      }
    }
    try {
      if (t.agentSelectionSnapshot?.reviewWorkflow !== null && t.agentSelectionSnapshot?.reviewWorkflow !== undefined && worktreeDir === null) {
        throw new Error('阶段 Agent 工作流必须使用本任务独立 worktree')
      }
      if (t.agentSelectionSnapshot?.source === 'goal-agent-workflow' && worktreeDir !== null) {
        const imported = await materializeWorkflowCheckpoints({
          workflowContext: t.agentSelectionSnapshot.workflowContext,
          workdir: worktreeDir,
          runGit,
        })
        if (imported.length > 0) activity('handoff', t.id, `已将 ${imported.length} 个上游阶段冻结提交合并到隔离分支`)
      }
      await verifyAgentWorkflowInputs(t, stage, worktreeDir ?? cwd)
      if (t.agentSelectionSnapshot?.source === 'goal-agent-workflow'
        && isWorkflowStage(t, stage, 'review') && worktreeDir !== null) {
        const base = await runGit(worktreeDir, ['rev-parse', '--verify', 'HEAD'])
        if (base.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(base.out.trim())) {
          throw new Error('无法冻结审查开始前的 Git 提交')
        }
        workflowReviewBaseCommit = base.out.trim()
      }
      if (t.agentSelectionSnapshot?.reviewWorkflow !== null
        && t.agentSelectionSnapshot?.reviewWorkflow !== undefined
        && isWorkflowStage(t, stage, 'implementation') && worktreeDir !== null) {
        const base = await runGit(worktreeDir, ['rev-parse', '--verify', 'HEAD'])
        if (base.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(base.out.trim())) {
          throw new Error('无法冻结实现阶段开始前的 Git 提交')
        }
        workflowImplementationBaseCommit = base.out.trim()
      }
    } catch (error) {
      await safeComment(t.id, `⛔ 工作流上游版本核验失败，已停止自动派工：${String(error).slice(0, 400)}`, scope)
      await transitionTo(t.id, 'in_review')
      activity('gate', t.id, '工作流交接物版本核验失败，等待人工处理')
      return
    }
    const parent = await ensureForeman(cwd)
    if (parent === undefined) {
      log(`${t.id} 跳过：foreman 不可用`)
      return
    }
    if (resolveIntegrationMode(process.env) === 'integration' && worktreeDir !== null) {
      const grant = await fetchWriteGrant(t.id, worktreeDir)
      if (!grant) {
        await safeComment(t.id, '⛔ 写入预约或范围版本不可用，已停止派工。请检查任务范围和服务连接。')
        await transitionTo(t.id, 'blocked', scope, true)
        return
      }
      activeWriteGuards.set(t.id, grant)
    }
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), config.workerTimeoutMs)
    // 目标级上下文（同一目标共享上下文）：派工时刻取最新缓存（sweep 已刷新），
    // 写镜像 docs/goals/<goalId>.md 到 worker 工作目录供士兵读文件，并把摘要内联进提示词。
    const goal = t.goalId && t.goalId.length > 0 ? goalCtxById.get(t.goalId) ?? null : null
    let goalMirror: string | null = null
    if (goal !== null) goalMirror = await writeGoalContextMirror(goal, cwd)
    const isWorkflowTask = t.agentSelectionSnapshot?.reviewWorkflow !== null
      && t.agentSelectionSnapshot?.reviewWorkflow !== undefined
    const isIndependentWorkflowTask = t.agentSelectionSnapshot?.source === 'goal-agent-workflow'
    let providerRunId: string | null = null
    let workflowStageAttemptId: string | null = null
    const reportWorkflowStageAttempt = async (input: {
      state: 'running' | 'completed' | 'failed' | 'unknown' | 'canceled'
      providerRunId?: string | null
      stopReason?: string
      error?: string
      result?: unknown
    }): Promise<void> => {
      if (workflowStageAttemptId === null) return
      if (!useHub) throw new Error('持久化工作流阶段 Attempt 需要 team-hub')
      await hubPost('/api/agent-workflow/stage-attempts/report', {
        attemptId: workflowStageAttemptId,
        ...input,
        by: t.soldier ?? config.role,
        scope,
      })
    }
    const quarantineUnknownWorkflowResult = async (reason: string, preserveCanceledTask = false): Promise<boolean> => {
      if (!isWorkflowTask) return false
      const providerName = t.agentSelectionSnapshot?.agentToolConfig?.providerName ?? config.provider
      const stageId = t.agentSelectionSnapshot?.workflowStageId ?? t.role ?? 'unknown'
      const runRef = providerRunId === null ? '' : `，providerRunId=${providerRunId}`
      await reportWorkflowStageAttempt({ state: 'unknown', providerRunId, stopReason: 'outcome-unknown', error: reason })
        .catch(error => log(`${t.id} 阶段 Attempt 未能登记未知结果：${String(error)}`))
      await safeComment(t.id, preserveCanceledTask
        ? `⛔ 工作流阶段结果未知（stage=${stageId}, provider=${providerName}${runRef}）：${reason}。任务保持取消状态，工作区已保留并等待人工核对；不会自动推进或重派。`
        : `⛔ 工作流阶段结果未知（stage=${stageId}, provider=${providerName}${runRef}）：${reason}。任务已隔离并等待人工核对；确认外部执行未产生副作用前不会自动重试。`, scope)
      if (preserveCanceledTask) {
        activity('gate', t.id, `用户已取消工作流任务，但 provider 终态未知；保留取消状态和工作区，等待人工核对（${stageId}）`)
        return true
      }
      try {
        if (useHub) {
          await hubPost('/api/hold', { id: t.id, hold: true, by: t.soldier ?? config.role, scope })
        } else {
          await runTaskctl(config.scrumDir, ['hold', t.id, '--by', t.soldier ?? config.role])
        }
        await transitionTo(t.id, 'in_review', scope)
        activity('gate', t.id, `工作流阶段结果未知，已隔离等待人工核对（${stageId}）`)
      } catch (error) {
        // Keep the lease held in in_progress when possible. Hub boot recovery also
        // quarantines workflow orphans, so a failed transition cannot trigger a retry.
        log(`${t.id} 工作流未知结果隔离迁移失败：${String(error)}`)
        activity('gate', t.id, `工作流阶段结果未知，隔离迁移失败，需人工核对（${stageId}）`)
      }
      return true
    }
    const run = await (async () => {
      try {
        const frozenConfig = t.agentSelectionSnapshot?.agentToolConfig ?? null
        const stageRef = stage?.agentToolConfig ?? null
        const selectionSnapshot = t.agentSelectionSnapshot
        if (selectionSnapshot !== null && selectionSnapshot !== undefined
          && (!['space-pipeline', 'goal-agent-workflow'].includes(selectionSnapshot.source)
            || typeof selectionSnapshot.pipelineVersion !== 'string'
            || selectionSnapshot.pipelineVersion === ''
            || selectionSnapshot.stageRole !== stage?.role)) {
          throw new Error('阶段角色与任务首次认领时的冻结快照不匹配；拒绝按实时流水线配置派工')
        }
        if (stageRef !== null && frozenConfig === null) {
          throw new Error('阶段 Agent 工具配置缺少任务首次认领时的冻结快照；拒绝按实时流水线配置派工')
        }
        const modelRef = t.agentSelectionSnapshot?.modelConfig ?? null
        const resolvedModel = t.agentSelectionSnapshot?.resolvedModelConfig ?? null
        if (modelRef !== null && (resolvedModel === null || resolvedModel.id !== modelRef.id || resolvedModel.version !== modelRef.version)) {
          throw new Error('该任务的模型档案引用没有匹配的冻结版本；拒绝静默忽略模型选择')
        }
        if (modelRef === null && resolvedModel !== null) throw new Error('任务包含未绑定引用的模型快照；拒绝使用未追溯的模型')
        const hasFrozenTool = frozenConfig !== null
        const selectedProvider = hasFrozenTool ? frozenConfig.providerName : config.provider
        if (resolvedModel !== null && frozenConfig?.adapter !== 'dsh-native') {
          throw new Error('模型档案覆盖只支持具备 agentOptions 能力的 DSH 原生 Agent provider')
        }
        let nativeProviderCapabilities: { agentOptions?: boolean } | null = null
        const promptText = buildWorkerPrompt(t, feedback, cwd, worktreeDir !== null, stage, goal, goalMirror)
        const beginWorkflowStageAttempt = async (providerName: string): Promise<void> => {
          if (!isWorkflowTask) return
          if (!useHub) throw new Error('跨 Agent 工作流阶段必须由 team-hub 保存 Attempt 事实后才能派工')
          const stageId = t.agentSelectionSnapshot?.workflowStageId ?? t.role
          if (typeof stageId !== 'string' || stageId.length === 0) throw new Error('工作流任务缺少冻结 stageId')
          const record = await hubPost('/api/agent-workflow/stage-attempts/start', {
            taskId: t.id,
            stageId,
            providerName,
            workspaceDir: worktreeDir ?? cwd,
            idempotencyKey: randomUUID(),
            by: t.soldier ?? config.role,
            scope,
          }) as { id?: unknown }
          if (typeof record.id !== 'string' || record.id.length === 0) throw new Error('team-hub 未返回持久化阶段 Attempt id')
          workflowStageAttemptId = record.id
          activity('dispatch', t.id, `已创建阶段 Attempt ${record.id}（provider=${providerName}）`)
        }
        let started
        if (hasFrozenTool && frozenConfig.adapter === 'dsh-subagent') {
          const expectedPermissionMode = expectedExternalPermissionMode(frozenConfig)
          if (frozenConfig.enabled !== true || frozenConfig.workspacePolicy !== 'attempt-worktree-parent-cwd'
            || expectedPermissionMode === null) {
            throw new Error('外部 Agent 必须使用受支持的 Codex/Claude 工作区权限档与独立 worktree 策略')
          }
          if (worktreeDir === null) throw new Error('外部 Agent 必须运行在本任务独立 worktree 中')
          const runtimePermissionMode = subagentProviderPermissionMode(ctx, selectedProvider)
          if (runtimePermissionMode !== expectedPermissionMode) {
            throw new Error(`外部 Agent provider 未报告与冻结配置一致的生效权限模式（expected=${expectedPermissionMode}, actual=${typeof runtimePermissionMode === 'string' ? runtimePermissionMode : 'unknown'}）`)
          }
          if (resolveIntegrationMode(process.env) === 'integration') {
            throw new Error('当前集成模式要求本地 Agent 执行拦截；所选外部 provider 不提供 localAgent')
          }
          if (config.denyTools.length > 0 && frozenConfig.capabilities.toolFilter !== true) {
            throw new Error('当前外部 Agent 不支持配置要求的工具过滤，拒绝派工')
          }
          await beginWorkflowStageAttempt(selectedProvider)
          const external = await executeExternalAgentInContext(ctx, {
            providerName: selectedProvider,
            parent,
            workdir: worktreeDir,
            prompt: promptText,
            label: `scrum:${t.id}`,
            signal: controller.signal,
            policyPreflightPassed: true,
            expectedCapabilities: frozenConfig.capabilities,
            expectedPermissionMode,
            returnRun: true,
          })
          if (external.ok !== true || external.run === undefined) {
            throw new Error(`${external.code ?? 'EXTERNAL_AGENT_START_FAILED'}：${external.message ?? '外部 Agent 启动失败'}`)
          }
          providerRunId = external.runId ?? null
          const externalRun = external.run
          started = {
            id: external.runId,
            result: externalRun.result.then((result: { stopReason?: string; diagnostic?: string; output?: Array<{ type?: string; text?: string }> }) => {
              const diagnostic = typeof result?.diagnostic === 'string'
                ? result.diagnostic.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
                : undefined
              if (result?.stopReason !== 'completed') {
                return { stopReason: result?.stopReason ?? 'unknown', ...(diagnostic === undefined ? {} : { diagnostic }) }
              }
              const output = Array.isArray(result.output)
                ? result.output.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
                : ''
              const parsed = parseExternalWorkerReport(output)
              return parsed.ok === true
                ? { stopReason: 'completed', structured: parsed.report }
                : { stopReason: 'invalid-external-report', diagnostic: parsed.message }
            }),
            dispose: () => externalRun.dispose(),
            localAgent: undefined,
          }
        } else {
          if (hasFrozenTool && frozenConfig.adapter !== 'dsh-native') {
            throw new Error(`阶段 Agent 工具 adapter 不受支持：${frozenConfig?.adapter ?? 'missing'}`)
          }
          if (hasFrozenTool) {
            const registered = subagentProvider(ctx, selectedProvider)
            if (registered === undefined) throw new Error(`冻结配置指定的 DSH provider 未注册：${selectedProvider}`)
            nativeProviderCapabilities = registered.capabilities
            if (registered.capabilities.outputSchema !== frozenConfig.capabilities.outputSchema
              || registered.capabilities.toolFilter !== frozenConfig.capabilities.toolFilter
              || frozenConfig.capabilities.outputSchema !== true
              || (config.denyTools.length > 0 && frozenConfig.capabilities.toolFilter !== true)) {
              throw new Error(`冻结配置与 DSH provider ${selectedProvider} 的结构化输出/工具过滤能力不一致`)
            }
          }
          let modelAgentOptions: Record<string, string> | null = null
          try {
            modelAgentOptions = agentOptionsForFrozenModel({
              modelRef, resolvedModel, agentToolConfig: frozenConfig,
              providerCapabilities: nativeProviderCapabilities,
            })
          } catch (error) {
            throw new Error(`冻结模型配置不可用于 provider ${selectedProvider}：${String(error)}`)
          }
          await beginWorkflowStageAttempt(selectedProvider)
          started = await ctx.subagents.start(selectedProvider, {
            label: `scrum:${t.id}`,
            prompt: [{ type: 'text', text: promptText }],
            parent,
            signal: controller.signal,
            outputSchema: WORKER_SCHEMA,
            ...(modelAgentOptions === null ? {} : { agentOptions: modelAgentOptions }),
            ...(config.denyTools.length > 0 ? { toolFilter: { deny: config.denyTools } } : {}),
          })
          providerRunId = started.id ?? null
        }
        if (workflowStageAttemptId !== null) {
          try {
            await reportWorkflowStageAttempt({ state: 'running', providerRunId })
          } catch (error) {
            await started.dispose().catch(() => undefined)
            throw new Error(`provider 已启动但 run 身份未能持久化：${String(error)}`)
          }
        }
        if (resolveIntegrationMode(process.env) === 'integration' && !started.localAgent) {
          await started.dispose()
          throw new Error('集成模式要求支持执行前拦截的本地 worker')
        }
        void started.result.finally(() => activeWriteGuards.delete(t.id)).catch(() => undefined)
        return started
      } catch (e) {
        activeWriteGuards.delete(t.id)
        log(`${t.id} 派工失败：${String(e)}`)
        if (workflowStageAttemptId !== null) {
          await reportWorkflowStageAttempt({ state: 'unknown', providerRunId, stopReason: 'start-error', error: String(e) })
            .catch(reportError => log(`${t.id} 阶段 Attempt 启动异常未能持久化：${String(reportError)}`))
        }
        await safeComment(t.id, `⚠ 派工失败：${String(e).slice(0, 200)}`)
        return undefined
      } finally {
        clearTimeout(timer)
        controllers.delete(controller)
      }
    })()
    if (run === undefined) {
      if (isWorkflowTask) {
        await quarantineUnknownWorkflowResult('Agent 启动结果未知或启动请求失败')
        return
      }
      if (resolveIntegrationMode(process.env) === 'integration') await transitionTo(t.id, 'blocked', scope, true)
      return
    }
    activity('dispatch', t.id, 'worker 已派工，开始实现')
    // 派工成功即写 hub 评论：任务详情的「AI 执行过程」立刻可见，避免「in_progress 却看不到 AI 在跑」的观感错位
    await safeComment(t.id, `🟢 已派 AI worker 开始执行（worker=scrum:${t.id}${worktreeDir ? `，隔离 worktree=${worktreeDir}` : ''}）——进行中，完成/异常将自动更新并流转`)
    await reportProgress(t.id, 10, '已派工')
    // 看门狗：subagent 可能挂死且 run.result 永不结算（abort 不保证杀死子代理）。
    // workerTimeoutMs 内未完成 → 强制结算为超时，放行 inflight/单槽，下轮自动重试（带退避）。
    const waited = isWorkflowTask
      ? await waitForWorkflowAgentRun({
        run, taskId: t.id, getTask: getWorkflowCancellationState, controller,
        timeoutMs: config.workerTimeoutMs, pollIntervalMs: 1000,
        onPollError: error => log(`${t.id} 取消状态轮询失败：${String(error)}`),
      })
      : await new Promise<{ result: { stopReason: string; structured?: unknown } | null; taskCanceled: false; timedOut: boolean }>((resolve) => {
        const tmr = setTimeout(() => {
          controller.abort()
          log(`${t.id} worker 超时（>${Math.round(config.workerTimeoutMs / 60000)} 分钟），守护强制结算`)
          resolve({ result: null, taskCanceled: false, timedOut: true })
        }, config.workerTimeoutMs)
        void run.result.then(
          result => { clearTimeout(tmr); resolve({ result, taskCanceled: false, timedOut: false }) },
          () => { clearTimeout(tmr); resolve({ result: null, taskCanceled: false, timedOut: false }) },
        )
      })
    const result = waited.result as { stopReason: string; structured?: unknown; diagnostic?: string } | null
    const taskCanceled = waited.taskCanceled
    if (result === null) {
      if (isWorkflowTask) {
        const failureType = 'failureType' in waited && typeof waited.failureType === 'string' ? waited.failureType : null
        const reason = taskCanceled
          ? `任务取消后 provider 未返回可确认的终态${failureType ? `（result rejection type=${failureType}）` : ''}`
          : waited.timedOut
            ? 'worker 超过执行时限，provider 未返回可确认的终态'
            : failureType
              ? `provider result promise rejected（type=${failureType}）`
              : 'worker 连接中断或 provider 未返回可确认的终态'
        await quarantineUnknownWorkflowResult(reason, taskCanceled)
        await run.dispose().catch(() => undefined)
        return
      }
      // ★ BUG-007：超时结算必须**先取证、再决定**（详见 ./timeoutSettlement.ts 的文件头）。
      //
      // 从前这里只写一句"任务保留在 in_progress，下一轮自动重试"就返回：既不改变任务状态、
      // 也不碰写入预约。而 15 分钟后守护自己的 stale 回收器会把该预约**冻结**成 reconciling，
      // 于是那句话永远无法兑现——认领一律被 RECONCILING 拒掉，只能人工 confirm-stopped 解开。
      // 实测 T-178/T-179 双双卡死、两个并发槽位空转，且每 40 分钟必复现。
      //
      // 顺序是刻意的：先 dispose（终止本次会话）→ 再取证（`run.result` 是否在宽限期内结算）
      // → 最后才决定要不要释放写入占用。**取不到证据就不释放**：abort 不保证杀死子代理，
      // 而重派会复用同一个 worktree ⇒ 两个写者落进同一目录比卡住更糟。
      await run.dispose().catch(() => undefined)
      const workerStopped = await workerStoppedWithin(run, TIMEOUT_SETTLE_GRACE_MS)
      const settlement = planTimeoutSettlement({
        taskId: t.id,
        stopped: workerStopped,
        graceMs: TIMEOUT_SETTLE_GRACE_MS,
        timeoutMinutes: Math.round(config.workerTimeoutMs / 60000),
      })
      let timeoutComment = settlement.comment
      let timeoutActivity = settlement.activity
      if (settlement.to !== null) {
        // 已取得终止证据 ⇒ 走既有诚实出口：执行者自己（by = t.soldier）以 confirmedStopped=true
        // 走 in_progress → todo，在 hub 侧这条路径是**释放**预约（team-hub/server.mjs 的 transition）。
        try {
          await transitionTo(t.id, settlement.to, t.scope ?? scope, settlement.confirmedStopped)
        } catch (e) {
          // 转不过去（版本冲突/已被他人动过）时**保持持有**，并把真实原因写进评论——
          // 不能因为"想让自动化成功"就退化成不说实话：释放没成功，就不能打印释放成功的文案。
          log(`${t.id} 超时结算转 todo 失败（保持持有，等待人工确认）：${String(e)}`)
          const failure = planTimeoutTransitionFailure({ taskId: t.id, scope: t.scope ?? scope, reason: String(e) })
          timeoutComment = failure.comment
          timeoutActivity = failure.activity
        }
      }
      await safeComment(t.id, timeoutComment)
      activity('aborted', t.id, timeoutActivity)
      return
    }
    await run.dispose()
    if (isWorkflowTask && taskCanceled) {
      const providerStopReason = result.stopReason.toLowerCase()
      if (['cancelled', 'canceled', 'aborted'].includes(providerStopReason)) {
        await reportWorkflowStageAttempt({ state: 'canceled', providerRunId, stopReason: result.stopReason })
        await safeComment(t.id, `已确认外部 Agent 在用户取消后停止（provider=${t.agentSelectionSnapshot?.agentToolConfig?.providerName ?? config.provider}${providerRunId ? `，run=${providerRunId}` : ''}）。工作区保留供检查；此任务不会自动推进。`, scope)
        activity('aborted', t.id, '用户取消已传到 Agent provider，provider 返回取消终态')
        return
      }
      await quarantineUnknownWorkflowResult(`任务取消与 provider 终态发生竞态（${result.stopReason}）；结果未用于推进工作流`, true)
      return
    }
    if (result.stopReason !== 'completed' || result.structured === undefined) {
      const diagnostic = typeof result.diagnostic === 'string' && result.diagnostic.trim() !== ''
        ? `；provider 诊断：${result.diagnostic.slice(0, 500)}`
        : ''
      log(`${t.id} worker 未完成（${result.stopReason}）${diagnostic}`)
      if (isWorkflowTask) {
        await quarantineUnknownWorkflowResult(`worker 未完成（${result.stopReason}）${diagnostic}`)
        return
      }
      await safeComment(t.id, `⚠ worker 未完成（${result.stopReason}）${diagnostic}，任务保留在 in_progress，等待人工处理或下一轮重试`)
      activity('aborted', t.id, `worker 未完成（${result.stopReason}），保留 in_progress 待租约回收`)
      return
    }
    // External Agent reports are frozen by the strict parser; workflow gates add
    // Legion-owned test receipts to the top-level report after provider return.
    const report = { ...(result.structured as WorkerReport) }
    const agentTestReport = report.testReport ?? null
    let workflowAttemptResult: unknown = report
    let implementationPrecommitted = false
    if (isWorkflowTask && report.status === 'done' && isWorkflowStage(t, stage, 'implementation')) {
      const testRunner = stage?.testRunner
      type BoundTestReceipt = WorkflowTestRunReceipt & {
        sourceCommit: string
        stageAttemptId: string
        providerRunId: string | null
        runnerNodeId: string | null
      }
      let receipt: BoundTestReceipt | null = null
      let sourceCommit = ''
      try {
        if (worktreeDir === null || !testRunner || workflowStageAttemptId === null) {
          throw new Error('独立测试需要冻结 runner、实现 worktree 与 Stage Attempt')
        }
        const committedByWorker = await workspace.commitWorktree(t.id, worktreeDir, report.summary)
        const head = await runGit(worktreeDir, ['rev-parse', '--verify', 'HEAD'])
        sourceCommit = head.out.trim()
        if (head.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(sourceCommit)) throw new Error('无法冻结独立测试对应的实现提交 SHA')
        const cleanBefore = await runGit(worktreeDir, ['status', '--porcelain=v1', '--untracked-files=all'])
        if (cleanBefore.code !== 0 || cleanBefore.out.trim() !== '') throw new Error('独立测试开始前实现 worktree 不干净')
        if (!committedByWorker) {
          const baseCommit = workflowImplementationBaseCommit
          const includesStageBase = baseCommit === null
            ? { code: 1 }
            : await runGit(worktreeDir, ['merge-base', '--is-ancestor', baseCommit, sourceCommit])
          if (baseCommit === null || sourceCommit === baseCommit || includesStageBase.code !== 0) {
            throw new Error('实现改动未能提交，也没有可核验的 Agent 阶段提交；独立测试不在未提交工作树上执行')
          }
        }
        implementationPrecommitted = true
        const run = await runWorkflowTestCommand({ runner: testRunner, cwd: worktreeDir })
        const headAfter = await runGit(worktreeDir, ['rev-parse', '--verify', 'HEAD'])
        const cleanAfter = await runGit(worktreeDir, ['status', '--porcelain=v1', '--untracked-files=all'])
        const changedDuringTests = headAfter.code !== 0 || headAfter.out.trim() !== sourceCommit
          || cleanAfter.code !== 0 || cleanAfter.out.trim() !== ''
        receipt = {
          ...run,
          sourceCommit,
          stageAttemptId: workflowStageAttemptId,
          providerRunId,
          runnerNodeId: (config.agentNodeId ?? '').trim() || null,
        }
        if (changedDuringTests) {
          const completedReceipt = receipt
          receipt = {
            ...completedReceipt,
            state: 'failed',
            exitCode: completedReceipt.exitCode === 0 ? 1 : completedReceipt.exitCode,
            error: '测试执行期间实现提交或 worktree 状态发生变化',
          }
        }
      } catch (error) {
        log(`${t.id} 独立测试执行未完成：${String(error)}`)
      }
      if (receipt !== null) {
        report.testVerification = receipt
        report.testReport = {
          passed: receipt.state === 'passed',
          command: [receipt.executable, ...receipt.args].join(' '),
          summary: receipt.state === 'passed' ? `Legion 独立测试通过（exit ${receipt.exitCode}）` : `Legion 独立测试${receipt.state === 'unknown' ? '结果未知' : '失败'}`,
          evidence: receipt.outputExcerpt || receipt.error || `输出摘要 SHA-256：${receipt.outputDigest}`,
          failures: receipt.state === 'passed' ? [] : [{ name: '独立测试执行', log: receipt.error ?? receipt.outputExcerpt, repro: [receipt.executable, ...receipt.args].join(' ') }],
        }
      } else {
        report.testReport = {
          passed: false,
          command: testRunner ? [testRunner.executable, ...testRunner.args].join(' ') : '',
          summary: 'Legion 独立测试未能启动或未返回可核验回执',
          evidence: '',
          failures: [{ name: '独立测试执行', log: '未生成绑定 Stage Attempt 和实现提交的 runner receipt', repro: '' }],
        }
      }
      workflowAttemptResult = { ...report, agentTestReport }
    }
    if (isWorkflowTask) {
      try {
        await reportWorkflowStageAttempt({ state: 'completed', providerRunId, stopReason: result.stopReason, result: workflowAttemptResult })
      } catch (error) {
        await quarantineUnknownWorkflowResult(`worker 已返回结果但阶段 Attempt 终态未能持久化：${String(error)}`)
        return
      }
    }
    const reviewWorkflow = t.agentSelectionSnapshot?.reviewWorkflow
    if (reviewWorkflow !== null && reviewWorkflow !== undefined && isWorkflowStage(t, stage, 'review')) {
      if (worktreeDir !== null) {
        const status = await runGit(worktreeDir, ['status', '--porcelain=v1', '--untracked-files=all'])
        const isIndependentWorkflowReview = t.agentSelectionSnapshot?.source === 'goal-agent-workflow'
        const reviewHead = isIndependentWorkflowReview
          ? await runGit(worktreeDir, ['rev-parse', '--verify', 'HEAD'])
          : null
        const branchChanges = isIndependentWorkflowReview ? [] : await changedFilesOfBranch(t)
        const workflowReviewCommittedChanges = isIndependentWorkflowReview
          && (reviewHead?.code !== 0 || reviewHead?.out.trim() !== workflowReviewBaseCommit)
        if (status.code !== 0 || status.out.trim() !== '' || workflowReviewCommittedChanges || branchChanges.length > 0) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, `⛔ 审查阶段工作区出现文件改动，未接受审查结论或推进返工。请人工检查审查分支 w/${t.id}；审查阶段只读。`, scope)
          activity('gate', t.id, '审查阶段工作区有改动，停止自动结算')
          return
        }
      }
      const review = report.review
      const findings = Array.isArray(review?.findings) ? review.findings : []
      const malformed = review === undefined
        || report.status !== 'done'
        || (review.passed === true && findings.length > 0)
        || (review.passed === false && findings.length === 0)
      if (malformed) {
        await transitionTo(t.id, 'in_review')
        await safeComment(t.id, `⚠ 审查报告格式不一致，未自动通过或派发返工。要求：通过时 status=done 且 findings 为空；未通过时必须提供可分类的 findings。报告摘要：${report.summary}`, scope)
        activity('gate', t.id, '审查报告不完整，等待人工核对')
        return
      }
      if (review.passed === false) {
        if (!useHub) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, '⚠ typed review 返工需要 team-hub 持久化工作流服务；当前未连接 hub，报告已保留待人工处理。', scope)
          return
        }
        try {
          const outcome = await hubPost('/api/agent-workflow/review', {
            taskId: t.id,
            by: t.soldier ?? config.role,
            scope,
            findings,
            summary: report.summary,
            evidence: report.evidence,
          }) as Record<string, unknown>
          if (outcome.kind === 'rework') {
            await safeComment(t.id, `✓ 已按审查结论创建返工任务 ${String(outcome.nextTaskId ?? '')}（${String(outcome.reworkKind ?? '')}，第 ${String(outcome.round ?? '')}/${String(outcome.maxReworkRounds ?? '')} 轮）；审查任务已结算。`, scope)
            activity('done', t.id, `审查触发 ${String(outcome.reworkKind ?? '')} 返工 ${String(outcome.nextTaskId ?? '')}`)
            return
          }
          await transitionTo(t.id, 'in_review')
          const reason = outcome.kind === 'rework-limit'
            ? `自动返工已达到上限（${String(outcome.round ?? '')}/${String(outcome.maxReworkRounds ?? '')} 轮）`
            : String(outcome.reason ?? '审查结果需要补充说明')
          await safeComment(t.id, `⚠ ${reason}。问题已保留，请人工裁定后续处理：\n${findings.map(f => `- [${f.kind}] ${f.summary}`).join('\n')}`, scope)
          activity('gate', t.id, `审查返工未自动派发：${reason}`)
        } catch (error) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, `⚠ 审查返工未能原子结算，任务保留待人工处理：${String(error).slice(0, 300)}\n${findings.map(f => `- [${f.kind}] ${f.summary}`).join('\n')}`, scope)
          activity('gate', t.id, '审查返工结算失败，保留待人工处理')
        }
        return
      }
    }
    // 目标上下文版本对账（"下一派工对齐"语义，仅提示不阻断）：
    // worker 声明了执行时依据的 contextVersion 但已落后 → 提醒将军本报告基于旧上下文，是否打回由将军定。
    const goalRef = report.goalRef && typeof report.goalRef === 'object' ? report.goalRef : null
    if (goal !== null && goalRef && goalRef.goalId === t.goalId && typeof goalRef.contextVersion === 'number' && goalRef.contextVersion < (goal.contextVersion ?? 0)) {
      await safeComment(t.id, `ℹ️ 本报告基于目标上下文 v${goalRef.contextVersion}，目标现已更新至 v${goal.contextVersion}——如改动受旧上下文约束，请将军核对后决定是否打回重做（默认不自动重做，下一派工按新版本对齐）。`)
    }
    // D7' 机器闸门：切片测试任务（tester + slice 键）走专用结算，不进入常规 advancePipeline 流转
    // 绕行谓词 isSliceTesterTask 已拆到 ./handoff.ts（交接边界）——它与 advancePipeline 是
    // 同一问题的两个面。闸门动作 settleSliceTest 与闸门在 runWorker 里的**位置**（必须排在常规
    // done 分支之前）仍留本文件：前者跨执行面/workspace 边界，后者是控制流形状（见该模块 §D7'）。
    if (report.status === 'done' && isSliceTesterTask(stage, t)) {
      await settleSliceTest(t, worktreeDir, report)
      return
    }
    if (report.status === 'done') {
      // worktree 隔离：先提交到 w/<id> 分支再记录 diff
      const committed = implementationPrecommitted || worktreeDir === null ? true : await workspace.commitWorktree(t.id, worktreeDir, report.summary)
      const reviewWorkflow = t.agentSelectionSnapshot?.reviewWorkflow
      const checkedTestReport = validateAgentWorkflowTestReport(report.testReport)
      if (reviewWorkflow !== null && reviewWorkflow !== undefined && isWorkflowStage(t, stage, 'implementation')
        && (worktreeDir === null || !useHub || !committed || report.testReport?.passed !== true
          || !checkedTestReport.ok
          || report.testVerification?.state !== 'passed'
          || (report.testReport.failures?.length ?? 0) > 0)) {
        await transitionTo(t.id, 'in_review')
        await safeComment(t.id, '⚠ 实现阶段未提供可验证的隔离提交或明确通过的测试报告，未推进到审查阶段。请保留工作现场，补齐测试证据后重试。', scope)
        activity('gate', t.id, '实现阶段缺少通过的测试/提交证据，停止自动交接')
        return
      }
      await recordPatch(t.id, worktreeDir, report.summary)
      if (reviewWorkflow !== null && reviewWorkflow !== undefined && isWorkflowStage(t, stage, 'implementation')) {
        const source = await runGit(worktreeDir!, ['rev-parse', '--verify', 'HEAD'])
        const sourceCommit = source.out.trim()
        if (source.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, '⚠ 无法核验实现提交 SHA，未推进到审查阶段。请将军检查隔离分支后处理。', scope)
          activity('gate', t.id, '实现阶段提交 SHA 无法核验')
          return
        }
        try {
          await hubPost('/api/comment', {
            id: t.id, by: t.soldier ?? config.role, scope, isEvidence: true,
            text: `agent-workflow-implementation:${JSON.stringify({
              passed: true,
              sourceCommit,
              stageAttemptId: workflowStageAttemptId,
              providerRunId,
              testVerification: report.testVerification,
              testCommand: checkedTestReport.ok ? checkedTestReport.command : '',
              testSummary: checkedTestReport.ok ? checkedTestReport.summary : '',
              testEvidence: checkedTestReport.ok ? checkedTestReport.evidence : '',
            })}`,
          })
        } catch (error) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, `⚠ 实现提交与测试证据未能写入 team-hub，未推进到审查阶段：${String(error).slice(0, 240)}`, scope)
          activity('gate', t.id, '实现版本证据写入失败，停止自动交接')
          return
        }
      }
      if (worktreeDir !== null && useHub && resolveIntegrationMode(process.env) === 'integration') {
        const source = await runGit(workspace.repoRootFor(), ['rev-parse', '--verify', `w/${t.id}`])
        if (source.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(source.out.trim())) throw new Error(`任务 ${t.id} 缺少可验收提交`)
        await hubPost('/api/comment', {
          id: t.id, by: t.soldier ?? config.role, scope, isEvidence: true,
          text: `sourceCommit=${source.out.trim()}\n${report.summary}\n${report.evidence}`.slice(0, 800),
        })
      }
    if (report.artifact && report.artifact.path) await recordArtifact(t.id, report.artifact, worktreeDir,
      t.agentSelectionSnapshot?.source === 'goal-agent-workflow')
      // S2 契约文档自动登记：commitWorktree 之后、autoPromote 之前（存在性以 worktree 目录为基准）。
      // 流水线文档型岗位（roles.json stage.docs 契约）结算时逐条登记仓库相对路径条目；worker 未填 artifact 亦登记（AC-R1-2）。
      // R-4/D2 文档同步契约：docSync（用户可见行为变更）任务对 coder/devops 追加 docs/FEATURES.md + README.md，
      // 保证外部门禁（contractPaths 非空）与 registerContractDocs 内部登记都覆盖功能手册（AC-R4-2）。
      const contractPaths = isPipeline && stage ? resolveStageDocPathsWithDocSync(stage, t.id, t.docSync) : []
      let contractReg: { registered: string[]; missing: string[] } | null = null
      if (contractPaths.length > 0 && stage) {
        contractReg = await registerContractDocs(t, stage, worktreeDir, goal)
        // 软门禁（G-R2 缺才停）：契约文档缺失 → 停 in_review 写明确提示评论，不 autoPromote、不误判成功流转；
        // 文档补全后解阻重跑 → 登记成功、提示消除、照常流转。
        if (contractReg.missing.length > 0) {
          const missingText = contractReg.missing.map(m => '`' + m + '`').join('、')
          await safeComment(t.id, `⚠ ${stage.label}完成，但契约产出文档缺失：${missingText}（期望写入 worktree 相对路径，与岗位契约一致）。已停在 in_review：产出不完整可 ↩ 打回并说明；补全文档后解阻重跑会自动登记并照常流转。${contractDocSummary(contractReg)}`)
          await transitionTo(t.id, 'in_review')
          activity('blocked', t.id, `${stage.label}完成但缺失契约文档：${contractReg.missing.join('、')}，转 in_review`)
          log(`${t.id} → in_review（缺失契约文档 ${contractReg.missing.join('、')}）`)
          return
        }
      }
      if (reviewWorkflow !== null && reviewWorkflow !== undefined
        && isWorkflowStage(t, stage, 'implementation') && worktreeDir !== null
        && workflowImplementationBaseCommit !== null) {
        const committedFiles = await runGit(worktreeDir, [
          'diff', '--name-only', '-z', `${workflowImplementationBaseCommit}..HEAD`,
        ])
        if (committedFiles.code !== 0) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, '⚠ 无法枚举实现阶段提交中的文件，未推进到审查阶段。', scope)
          activity('gate', t.id, '无法枚举实现阶段提交文件')
          return
        }
        for (const path of committedFiles.out.split('\0').filter(Boolean)) {
          await recordArtifact(t.id, { kind: 'file', path, title: basename(path) }, worktreeDir,
            t.agentSelectionSnapshot?.source === 'goal-agent-workflow')
        }
      }
      const requiredOutputs = stageContractArtifacts(stage, 'output')
      if (requiredOutputs.length > 0) {
        const latest = useHub ? await getTask(t.id, scope) : null
        const produced = artifactLabels([
          ...(latest?.artifacts ?? []),
          ...(report.artifact ? [report.artifact] : []),
        ])
        if (isWorkflowStage(t, stage, 'implementation')) {
          produced.add('commit')
          if ((report.testReport?.evidence ?? '').trim() !== '') produced.add('test-evidence')
        }
        if (report.testReport?.passed === true && typeof report.testReport.summary === 'string' && report.testReport.summary.trim() !== '') {
          produced.add('test-results')
        }
        const missingOutputs = requiredOutputs.filter((name) => !produced.has(name.toLowerCase()))
        if (missingOutputs.length > 0) {
          await safeComment(t.id, `⚠ 阶段输出未满足冻结契约：缺少 ${missingOutputs.join(', ')}。任务已停在 in_review，补齐可核验产物后再推进。`, scope)
          await transitionTo(t.id, 'in_review')
          activity('gate', t.id, `工作流阶段输出契约缺失：${missingOutputs.join(', ')}`)
          return
        }
      }
      if (reviewWorkflow !== null && reviewWorkflow !== undefined && isWorkflowStage(t, stage, 'design')) {
        const latest = useHub ? await getTask(t.id, scope) : null
        const immutableFiles = (latest?.artifacts ?? []).filter((artifact) =>
          artifact.kind === 'file' && typeof artifact.path === 'string' && !isAbsolute(artifact.path)
          && /^[0-9a-f]{64}$/.test(artifact.digest ?? ''),
        )
        const verifiedDesign = immutableFiles.some((artifact) => {
          const path = resolve(worktreeDir ?? workspace.repoRootFor(), artifact.path)
          const fromRoot = relative(resolve(worktreeDir ?? workspace.repoRootFor()), path)
          if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || !existsSync(path)) return false
          try { return fileDigest(path) === artifact.digest || workflowArtifactDigest(path) === artifact.digest } catch { return false }
        })
        if (!verifiedDesign) {
          await safeComment(t.id, '⚠ 设计阶段没有登记可核验的仓库内文件版本（SHA-256），未推进到实现阶段。请补交设计文件并重试。', scope)
          await transitionTo(t.id, 'in_review')
          activity('gate', t.id, '设计阶段缺少不可变产物版本，停止自动交接')
          return
        }
      }
      if (isIndependentWorkflowTask) {
        const stageId = t.agentSelectionSnapshot?.workflowStageId ?? stage?.workflowStageId ?? stage?.id ?? stage?.role
        const checkpoint = await runGit(worktreeDir!, ['rev-parse', '--verify', 'HEAD'])
        const sourceCommit = checkpoint.out.trim()
        if (checkpoint.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, '⚠ 无法核验本阶段冻结 Git 提交，未推进工作流。请检查隔离分支后处理。', scope)
          activity('gate', t.id, '工作流阶段缺少有效 Git 提交检查点')
          return
        }
        if (typeof stageId !== 'string' || stageId.trim() === '') {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, '⚠ 工作流阶段缺少冻结 stageId，未推进工作流。', scope)
          return
        }
        await hubPost('/api/comment', {
          id: t.id,
          by: t.soldier ?? config.role,
          scope,
          isEvidence: true,
          text: `${WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX}${JSON.stringify({ stageId, sourceCommit })}`,
        })

        if (isWorkflowStage(t, stage, 'review')) {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, `✓ Codex 审查已通过，已冻结设计与实现提交（design=${t.agentSelectionSnapshot?.workflowContext?.designArtifacts?.map(item => item.digest.slice(0, 12)).join(',') ?? 'verified'}；implementation=${t.agentSelectionSnapshot?.workflowContext?.implementation?.sourceCommit ?? 'verified'}）。任务停在 Legion 独立验证与最终验收；候选分支为 w/${t.id}。`, scope)
          activity('gate', t.id, 'Codex 工作流审查通过，等待 Legion 独立验证与最终验收')
          return
        }

        if (stage?.gate === true || resolveIntegrationMode(process.env) === 'integration') {
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, `✓ 工作流阶段 ${stage?.label ?? stageId} 已完成并冻结提交 ${sourceCommit}，等待 Legion 验收后再解锁下游阶段。候选分支为 w/${t.id}。`, scope)
          activity('gate', t.id, `工作流阶段 ${stage?.label ?? stageId} 等待集成验收`)
          return
        }

        await advanceTo(t.id, stage?.role ?? t.role ?? config.role)
        await safeComment(t.id, `✓ 工作流阶段 ${stage?.label ?? stageId} 已完成，冻结提交 ${sourceCommit} 已保存；下游任务会从该提交建立自己的隔离分支。`, scope)
        activity('done', t.id, `工作流阶段 ${stage?.label ?? stageId} 完成，提交检查点已持久化`)
        return
      }
      if (isPipeline && stage && workflowHasForwardEdges(t, stage)) {
        // 文件域机器闸门（B 层防窜台）：声明了文件域的切片任务，改动越出声明域 → 拦截合入转 in_review 等将军裁决。
        if (worktreeDir !== null) {
          const outside = outsideDomainFiles(t, await changedFilesOfBranch(t))
          if (outside.length > 0) {
            const domText = (t.fileDomain ?? []).join(', ') || '（未声明）'
            // ★ BUG-010：这条评论原先只说了"手动合入"或"丢弃"，**漏了最后一步**：把任务推进 done。
            //
            //   为什么那一步不能省：本分支是 `return`，它**绕过了**下面的 `advanceTo` + `advancePipeline`
            //   ——「阶段 → 阶段」的唯一出口。而"4. 流水线 done 补流转"那道扫单只处理
            //   `status === 'done'` 的任务。于是：
            //     人按评论说的合入了 main，任务却停在 in_review ⇒ 扫单看不到它 ⇒
            //     **下一环（reviewer/tester）永远不会被派**，而链看起来"已经走完了"。
            //   实测（2026-10-05）：T-178 是 coder、stage.next=reviewer，本该自动合入并派 reviewer
            //   （历史上 T-050→T-057、T-060→T-065 都是这样接上的），结果代码进了 main、
            //   **代码审查那一环被静默跳过**，而没有任何读数会说话。
            //   所以评论必须把恢复路径写全：合入 → **推进 done** → 守护下一轮补派下一环。
            await safeComment(t.id, `⛔ 文件域越界（合入被机器闸门拦截）：以下改动超出本切片声明文件域【${domText}】→ ${outside.slice(0, 30).join(', ')}${outside.length > 30 ? ` …共 ${outside.length} 个` : ''}。改动保留在分支 w/${t.id}，未合入主分支。请将军裁决：\n· **可接受** → 在评论里说明后手动合入（git -C ${workspace.repoRootFor()} merge --no-ff w/${t.id}），**然后把本任务推进到 done**（界面「✓ 验收通过」；或 POST /api/transition {id:"${t.id}",to:"done"}）。★ 这一步不能省：本任务停在这个状态时不会自动流转，**只有推进 done 之后，守护的「流水线 done 补流转」才会派出下一环（${stage.next}）**；漏掉它 = 下游被静默跳过（本任务已遇到过一次）。\n· **不可接受** → worktree remove --force ${worktreeDir} && git -C ${workspace.repoRootFor()} branch -D w/${t.id} 丢弃后重新派工。`)
            await transitionTo(t.id, 'in_review')
            activity('domain-block', t.id, `文件域越界 ${outside.length} 个文件，合入被机器闸门拦截（下游 ${stage.next} 环暂停，需推进 done 才恢复）`)
            log(`${t.id} → in_review（文件域越界 ${outside.length} 个文件，机器闸门拦截合入；下游 ${stage.next} 环暂停，待将军裁决并推进 done）`)
            return
          }
        }
        if (stage.gate && resolveIntegrationMode(process.env) === 'integration') {
          const gateDoc = goalDocPath(goal, stage.artifact)
          const docOk = gateDoc === '' || (worktreeDir !== null && existsSync(join(worktreeDir, gateDoc)))
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, docOk
            ? `✅ ${stage.label}已完成，候选提交和验收证据已保留。请在任务详情审阅并点击「验收通过」；批准后由集成服务验证并交付。\n要点：${report.summary}\n证据：${report.evidence}`
            : `⚠ ${stage.label}完成，但隔离工作区缺少要求的文档 ${gateDoc}；请打回补全。`)
          activity('gate', t.id, docOk ? `${stage.label}待人工验收` : `${stage.label}缺少产物文档`)
          return
        }
        // 流水线中间阶段：自动合入主分支 → done → 流转下一角色；合入失败转 in_review 等人工，不静默丢产出
        const merged = worktreeDir !== null ? await autoPromote(t.id, worktreeDir) : true
        if (!merged) {
          await safeComment(t.id, resolveIntegrationMode(process.env) === 'integration'
            ? `⚠ ${stage.label}已完成执行，但集成验证未通过或仍在等待。改动保留在分支 w/${t.id}；请在任务交付详情查看失败原因并重试或裁决。`
            : `⚠ ${stage.label}完成，但自动合入主分支失败（可能冲突），改动保留在分支 w/${t.id}。请人工合入并推进：git -C ${workspace.repoRootFor()} merge --no-ff w/${t.id} 解决冲突 → git -C ${workspace.repoRootFor()} worktree remove --force ${worktreeDir} → git -C ${workspace.repoRootFor()} branch -D w/${t.id} → 将军把任务 transition 到 done`)
          await transitionTo(t.id, 'in_review')
          activity('blocked', t.id, `${stage.label}完成但自动合入失败，转 in_review 等待人工合入`)
          log(`${t.id} → in_review（中间阶段自动合入失败，等待人工处理）`)
          return
        }
        if (stage.gate) {
          // 人工闸门阶段（如方案搜索）：方案文档必须明确存在，且等将军验收 done 后才流转下一角色。
          // 将军验收通过（in_review → done）后，下一环（blockedBy 本任务）由守护下轮自动认领；打回则附原因自动纠错重做。
          const gateNext = stageByRole.get(stage.next ?? '')
          // autoPromote 已把 w/<id> 合入主分支并删除 worktree——在此之后查 worktree 目录必然不存在，
          // 会误报「缺文档」并把任务错误地停在 in_review。改为检查合入后的主仓库根目录。
          // 目标级文档目录：有 docsDir 的目标在 <docsDir>/<artifact> 校验，遗留目标在仓库根 docs/ 校验。
          const gateDoc = goalDocPath(goal, stage.artifact)
          const docOk = gateDoc === '' || existsSync(join(workspace.repoRootFor(), gateDoc))
          if (!docOk) {
            await safeComment(t.id, `⚠ ${stage.label}完成，但未找到要求交付的方案文档 ${gateDoc}（应写入 worktree）。已停在 in_review，请人工检查：产出不完整可 ↩ 打回并说明，士兵会补全后重新提交。`)
            await transitionTo(t.id, 'in_review')
            activity('blocked', t.id, `${stage.label}完成但缺少产物文档 ${gateDoc}，转 in_review`)
            log(`${t.id} → in_review（缺少 ${gateDoc}）`)
            return
          }
          await transitionTo(t.id, 'in_review')
          await safeComment(t.id, `✅ ${stage.label}完成，方案文档 ${gateDoc || `分支 w/${t.id}`} 已合入主分支。**请将军人工验收**：通过 → 任务详情「✓ 验收通过」，守护自动流转到「${gateNext?.label ?? stage.next}（${stage.next}）」；不通过 → ↩ 打回并附原因，士兵按反馈修订重做。\n要点：${report.summary}\n证据：${report.evidence}${contractDocSummary(contractReg)}`)
          activity('gate', t.id, `${stage.label}完成，待将军人工验收（闸门）`)
          log(`${t.id} → in_review（${stage.label} 人工闸门，待将军验收）`)
          return
        }
        await advanceTo(t.id, stage.role)
        await safeComment(t.id, `✓ ${stage.label}完成：${report.summary}\n证据：${report.evidence}${contractDocSummary(contractReg)}`)
        activity('done', t.id, `${stage.label}完成：${report.summary}`)
        log(`${t.id} → done（${stage.label}），流转下一角色`)
        await handoff.advancePipeline(t)
      } else if (isPipeline && stage) {
        // 流水线最终阶段（如 devops 链尾，next=null）：worker 已完成自检（门禁/证据/报告全绿），
        // 将军已授权整条流水线 → 自动合入主分支 + 推进 done 收官，不停 in_review 等将军验收。
        // 背景（T-126 现场，2026-09-08）：devops 部署任务完成即提交 in_review，需将军逐个手动
        // 验收 + promote；将军裁决「部署不需要验收，直接部署」——将军职责收敛为 gate 岗（requirement
        // 需求澄清 / researcher 方案确认）与目标发布。目标是否收尾由 hub /api/advance 的
        // settleGoalsOfScope 判定（链全部 done → 目标自动 done）。
        const mergedFinal = worktreeDir !== null ? await autoPromote(t.id, worktreeDir) : true
        if (!mergedFinal) {
          await safeComment(t.id, resolveIntegrationMode(process.env) === 'integration'
            ? `⚠ ${stage.label}已完成执行，但集成验证未通过或仍在等待。改动保留在分支 w/${t.id}；请在任务交付详情查看失败原因并重试或裁决。`
            : `⚠ ${stage.label}完成，但自动合入主分支失败（可能冲突），改动保留在分支 w/${t.id}。请人工合入并推进：git -C ${workspace.repoRootFor()} merge --no-ff w/${t.id} 解决冲突 → git -C ${workspace.repoRootFor()} worktree remove --force ${worktreeDir} → git -C ${workspace.repoRootFor()} branch -D w/${t.id} → 任务 transition 到 done`)
          await transitionTo(t.id, 'in_review')
          activity('blocked', t.id, `${stage.label}完成但自动合入失败，转 in_review 等待人工合入`)
          log(`${t.id} → in_review（最终阶段自动合入失败，等待人工处理）`)
          return
        }
        await advanceTo(t.id, stage.role ?? config.role)
        await safeComment(t.id, `✓ ${stage.label}完成并自动收官（部署类终态免将军验收）：${report.summary}\n证据：${report.evidence}${contractDocSummary(contractReg)}`)
        activity('done', t.id, `${stage.label}完成并自动收官：${report.summary}`)
        log(`${t.id} → done（${stage.label} 最终阶段，自动收官）`)
      } else {
        // 非流水线单角色任务（人工派活）或 stage 缺失：停 in_review 等将军验收
        await transitionTo(t.id, 'in_review')
        const promoteHint = worktreeDir !== null
          ? resolveIntegrationMode(process.env) === 'integration'
            ? `\n[worktree] 改动保留在分支 w/${t.id}，请在任务详情验收；批准后由集成服务交付。`
            : `\n[worktree] 改动在分支 w/${t.id}。验收通过后 promote：git -C ${workspace.repoRootFor()} merge --no-ff w/${t.id}；放弃：git -C ${workspace.repoRootFor()} worktree remove --force ${worktreeDir} && git -C ${workspace.repoRootFor()} branch -D w/${t.id}`
          : ''
        await safeComment(t.id, `✓ 完成并提交验收：${report.summary}\n证据：${report.evidence}${contractDocSummary(contractReg)}${promoteHint}`)
        activity('done', t.id, `完成：${report.summary}${worktreeDir !== null ? `（worktree 分支 w/${t.id} 待 promote）` : ''}`)
        log(`${t.id} → in_review（${report.summary}）`)
      }
    } else {
      // blocked：把部分改动提交到 w/<id>（WIP），解阻/纠错续做时 prepareWorktree 复用，不丢上一轮成果
      if (worktreeDir !== null) {
        const status = await runGit(worktreeDir, ['status', '--porcelain'])
        if (status.code === 0 && status.out.trim().length > 0) {
          await workspace.commitWorktree(t.id, worktreeDir, `WIP：${report.summary}`)
        }
      }
      const wtHint = worktreeDir !== null
        ? `\n[worktree] 部分改动已提交到分支 w/${t.id}（${worktreeDir}），解阻后续做会自动复用`
        : ''
      await safeComment(t.id, `❓ 需要将军介入确认：${report.blocker || report.summary}${wtHint}\n请将军在本任务评论里给出处理意见（例如：继续的方向 / 放宽或调整要求 / 打回原因），士兵会带着答复续做；也可先 🖐 拦截或转派。`)
      await transitionTo(t.id, 'blocked', scope, true)
      activity('ask', t.id, `需要将军确认：${report.blocker || report.summary}`)
      log(`${t.id} → blocked（❓ 待将军确认：${report.blocker || report.summary}）`)
    }
  }

  /** 认领 todo 并派工（流水线模式按任务角色认领 + 用角色提示词）。 */
  async function workTodo(t: Task, stage?: StageDef): Promise<void> {
    let claimed = t
    try {
      claimed = await claimTaskWithResult(t.id, stage ? stage.role : config.role) ?? t
    } catch (e) {
      log(`${t.id} 认领失败（可能已被他人认领）：${String(e)}`)
      return
    }
    activity('claim', t.id, stage ? `${stage.label}（${stage.role}）认领开工` : '认领开工')
    // 审计/打回闭环：认领时把历史有效反馈（将军评论/打回原因/审计批注评论，排除自身系统噪音）带进提示词，
    // 使「打回原因 → 重跑」不丢失上下文（与 in_progress 退回的 feedback 语义一致）。
    const prior = claimed.comments.filter(c => {
      if (c.by === config.role) return false
      const txt = c.text ?? ''
      return !(txt.startsWith('⚠ worker 未完成') || txt.startsWith('⚠ 派工失败') || txt.startsWith('🟢 已派 AI') || txt.startsWith('⏳'))
    }).slice(-12)
    await runWorker(claimed, prior, stage)
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
    // 看门狗：挂死的子代理在 workerTimeoutMs 内未结算也强制返回 null（abort 不保证杀死子代理）
    try {
      const run = await ctx.subagents.start(config.provider, {
        label,
        prompt: [{ type: 'text', text: promptText }],
        parent,
        signal: controller.signal,
        outputSchema: schema,
      })
      const result = await new Promise<{ stopReason: string; structured?: unknown } | null>((resolve) => {
        const tmr = setTimeout(() => {
          controller.abort()
          log(`${label} 超时（>${Math.round(config.workerTimeoutMs / 60000)} 分钟），强制结算为未完成`)
          resolve(null)
        }, config.workerTimeoutMs)
        void run.result.then(
          r => { clearTimeout(tmr); resolve(r) },
          () => { clearTimeout(tmr); resolve(null) },
        )
      })
      await run.dispose().catch(() => undefined)
      if (result === null) return null
      if (result.stopReason !== 'completed' || result.structured === undefined) {
        log(`${label} 未完成（${result.stopReason}）`)
        return null
      }
      return result.structured as T
    } catch (e) {
      log(`${label} 派发失败：${String(e)}`)
      return null
    } finally {
      controllers.delete(controller)
    }
  }
  // ── 阶段 3 PRT-315 切片 1：合入调解已拆到 ./mediation.ts（交接边界）──────────
  // 这里只做**接线**：把原先被闭包隐式捕获的东西显式交给它。
  //
  // `hubUrl` / `useHub` / `stageByRole` 传的是**取值函数**而不是值——它们在运行期
  // 会被改写（detectHub() 探测成功、流水线换源）。传值 = 调解模块从构造那一刻起
  // 就看着一份冻结的旧快照，症状是"探测到 hub 了但调解员还是不走 hub"——不报错。
  const mediation = createMergeMediation({
    config, log, runGit, scope,
    hubUrl: () => hubUrl,
    useHub: () => useHub,
    stageByRole: () => stageByRole,
    repoRootFor: workspace.repoRootFor, worktreeRootFor: workspace.worktreeRootFor,
    mediating, mediateAttempts, mediateRetryAt, maxMediateAttempts,
    safeComment, advanceTo, activity, getTask, listTasks, startOneShot,
    now: () => Date.now(),
  })
  // ── 阶段 3 PRT-315 切片 2：租约回收已拆到 ./reclamation.ts（仓储边界），这里只做**接线** ──
  // `useHub` / `isPipeline` 传**取值函数**（两者都是运行期会被重新赋值的 `let`：detectHub()
  // 探测成功、applyPipeline() 换流水线来源）；`scope` / `config` / `mediating` 传值（const /
  // 身份稳定的集合，与 mediation.ts 一致）；重启标志 `boot` 由本实例持有（见该模块文件头）。
  const reclamation = createReclamation({
    config: effectiveConfig, log, scope,
    useHub: () => useHub,
    isPipeline: () => isPipeline,
    hubPost, runTaskctl, activity, mediating,
    boot: bootReconcile,
  })
  // ── 阶段 3 PRT-315 切片 5：验收与沉淀管线已拆到 ./acceptance.ts（验收边界），这里只做**接线** ──
  // `useHub` / `hubUrl` / `normsGlobalText`（refreshNorms 改写）/ `injectedNorms`（buildWorkerPrompt
  // 改写）四个运行期会被重新赋值的 `let` 一律传**取值函数**——传值 = 模块从构造那刻起看着一份冻结的
  // 旧快照（症状：技能桥永远看不到 hub、doctor 拿一份空产物去比对）。`ruleDoctor` 传**访问器**：
  // 它由该模块写、由 writeDaemonStatus（非验收边界）读，所有权留在本闭包（与 workspace 的 `binding`
  // 同一形态）。`promoteDraft` 是**兄弟能力**——要用 ctx 的执行面能力，故意留在本文件注入。
  const acceptance = createAcceptance({
    config, log, scope, activity,
    draftDir: expDraftDir,
    useHub: () => useHub,
    hubUrl: () => hubUrl,
    pendingRecallRefs, promoteDraft,
    readRepoNormsFiles, readNormsTombstones, readNormsSync,
    normsGlobalText: () => normsGlobalText,
    injectedNorms: () => lastInjectedNorms,
    ruleDoctor: { get: () => lastRuleDoctor, set: r => { lastRuleDoctor = r } },
  })
  // ── 阶段 3 PRT-315 切片 6：流水线阶段交接已拆到 ./handoff.ts（交接边界），这里只做**接线** ──
  // `useHub` / `pipeline` / `stageByRole` 三个运行期会被重新赋值的 `let` 一律传**取值函数**——
  // 传值 = 模块从构造那刻起看着一份冻结的旧快照（症状：整条流水线一个任务都不流转 / 明明有 hub
  // 却去 fork taskctl，日志里一行都不会有）。`scope` / `listTasks` / `hubPost` / `runTaskctl` /
  // `activity` 传值（const 或身份稳定的函数声明）。`SLICE_ANALYSIS_TAIL` / `isSliceGoalTask`
  // 的**单一定义留在这里**——`orchestrateSlices`（切片编排边界）也读它们，与 stateMachine 注入
  // `stageOf` 同形。
  const handoff = createHandoff({
    config, log, scope, activity,
    useHub: () => useHub,
    pipeline: () => pipeline,
    stageByRole: () => stageByRole,
    listTasks, hubPost, runTaskctl,
    SLICE_ANALYSIS_TAIL, isSliceGoalTask,
    // ★ 合并说明（2026-09-16）：这两项来自 `main` 那一侧对**同一个** `advancePipeline`
    //   的生产修复（T-156 复发：历史已收口目标凭空长出新链）。函数已在本分支搬到
    //   `./handoff.ts`，所以修复也跟着搬到那里——接线在这里，与 `createSliceOrchestration`
    //   同一套注入纪律：`goalCtxById` 是 **const Map**（身份稳定）传值，
    //   `fetchGoalById` 是身份稳定的函数声明，传值。
    goalCtxById, fetchGoalById,
  })
  // ── 阶段 3 PRT-315 切片 7：切片流水线编排已拆到 ./sliceOrchestration.ts，这里只做**接线** ──
  // 本界**没有**运行期会被重新赋值的绑定：`useHub` 的守卫（`// 5.`）留在下面调用点，故不传取值
  // 函数；`scope` / `config` / 四个判据 / `hubPost` / `safeComment` / `transitionTo` / `runGit`
  // 全是 const 或身份稳定的函数（传值）。两个容器**所有权留在本闭包**：`expandRetryAt` 是每实例
  // 状态（多空间 mount 共享模块注册表会串台，见该模块文件头）；`goalCtxById` 是「目标级缓存」
  // （refreshGoals 每轮写、非本界的读者读）——只借出去读改，不搬所有权。
  const sliceOrchestration = createSliceOrchestration({
    config, log, scope, activity,
    isSliceBeam, SLICE_ANALYSIS_TAIL, isSliceGoalTask,
    expandRetryAt, goalCtxById, goalDocPath,
    repoRootFor: workspace.repoRootFor, worktreeRootFor: workspace.worktreeRootFor,
    hubPost, safeComment, transitionTo, runGit,
  })


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
    const cwd = workspace.workspaceFor()
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

  // ── 阶段 3 PRT-315 切片 7：切片流水线编排（readyToExpand 注册切片束 / fix 合入后重开 tester
  //    重测）已搬到 ./sliceOrchestration.ts；该模块文件头逐条列了搬了什么、两个容器为什么只借
  //    不搬（每实例状态 / 目标级缓存）、以及哪四个判据按值注入。调用点见本文件 `// 5.`。

  /** 一轮扫单：todo 认领派工；本角色的退回任务纠错；依赖解除的 blocked 续做。 */
  // ── R-4 对话 AI 回复（S10）：chat-responder 扫单 ────────────────────────────
  // 纪律（I-7/K8-A）：team-hub 永不发起出站模型调用；回复由本守护经 ctx.subagents（DSH 模型通道）
  // 派生轻量子代理生成，再经 hub 回写（author=回复方身份，服务器 CAS awaiting→replied）。
  // 节拍 = intervalMs（默认 30s，位于 10-30s 区间内，TC-S10-07）；单轮至多处理 CHAT_REPLY_PER_SWEEP 条
  // （防恢复瞬间队列爆发）；同消息去重（chatBusy）防并发重复派生（TC-S10-03 双保险：服务器 CAS 幂等）。
  const chatBusy = new Set<number>()
  const CHAT_REPLY_PER_SWEEP = 3
  const CHAT_REPLY_SCHEMA: ObjectJsonSchema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false }
  interface HubChatMsg {
    id: number
    convId: number
    scope: string
    convTitle?: string
    author: string
    body: string
    context?: Array<{ id: number; author: string; kind?: string; body: string }>
    /** S3/E1：本条消息绑定的附件引用（内容不入消息体，答问前另行取回）。 */
    meta?: { attachments?: AttachmentRef[] }
    /** 岗位 Agent 会话（/api/agent-messages 那条线）：服务端按会话绑定解析出的岗位身份与任务记录。
     *  来源是服务端的对话绑定，**不是**消息正文——客户端自报的 agentRole 不改变它（agent-main-chat 用例）。
     *  identity 就是本空间该岗位的回复方身份（`agent:<scope>:<role>`）。 */
    agent?: {
      role: string
      name: string
      kind: string
      identity: string
      tasks: Array<{ id: string; title: string; status: string; goalId?: string | null; updatedAt?: string }>
    }
  }
  interface ReplySettingsPayload { enabled: boolean; model: string | null; identity: string | null; systemHint: string | null }
  async function fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      return await res.json() as T
    } catch { return null }
  }
  /** 把一条 awaiting 消息标 failed（服务器 CAS，非 awaiting 幂等跳过；TC-S10-02）。 */
  async function markChatFailed(msgId: number, scopeFor: string, identity: string, reason: string): Promise<void> {
    try {
      await hubPost('/api/chat/replies/fail', { msgId, by: identity, error: reason.slice(0, 500) })
      daemonChatState.lastFailAt = new Date().toISOString()
      daemonChatState.lastFailReason = reason.slice(0, 500)
      log(`chat-responder：消息 ${msgId} 标记失败（${reason.slice(0, 120)}）`)
    } catch (e) {
      log(`chat-responder 标记失败 ${msgId} 未送达：${String(e)}`)
    }
  }
  /** 轻量子代理直答一条 awaiting 消息（TC-S10-01..06）。 */
  async function answerChatMessage(msg: HubChatMsg): Promise<void> {
    try {
      // 1) 回复设置：开关关 / 拉取失败 → 空转零出站（TC-S10-05；失败按「等下一轮」处理）
      const settings = await fetchJson<ReplySettingsPayload>(`${hubUrl}/api/chat/reply-settings?scope=${encodeURIComponent(msg.scope)}`)
      if (settings === null || !settings.enabled) return
      // 岗位 Agent 会话用**服务端解析出的岗位身份**回答（`agent:<scope>:<role>`），
      // 空间会话仍用 `<scope>-assistant`。这个身份同时决定四件事，所以不能只用空间口径：
      //   ① 提示词里"你是谁"（回复方是编码工程师，不是匿名对话助手）；
      //   ② 回写时的 author（服务端 postAiReply 按 by 落库）——写错会让界面把回复显示成别人；
      //   ③ 防自我触发（岗位自己的进度消息 author === identity 时不再回答）；
      //   ④ 失败回写的 by（与应答同一身份，审计里才对得上）。
      // 取值只认服务端的对话绑定：客户端自报的 agentRole 不参与（见 team-hub/agent-main-chat.test.mjs）。
      const identity = msg.agent?.identity ?? chatIdentityFor(msg.scope, settings.identity)
      // 2) 防自我触发：identity 消息不再次进入回答流程（TC-S10-04，服务端已不标 awaiting，双保险）
      if (msg.author === identity) return
      // 3) 模型解析（TC-S10-06/D-14）：settings.model ?? 该空间默认（agent_models）?? 守护当前选择
      let fallback = { provider: config.provider, model: '' }
      try {
        const s = ctx.agentDefaultModel.currentSelection()
        if (s && s.model) fallback = { provider: s.provider || config.provider, model: s.model }
      } catch { /* 取不到默认模型则用空串，由子代理 start 失败路径兜底 */ }
      const rows = await fetchJson<Array<{ role: string; provider?: string; model?: string }>>(`${hubUrl}/api/models?scope=${encodeURIComponent(msg.scope)}`)
      const pick = (rows ?? []).find(r => r.role === 'assistant') ?? (rows ?? []).find(r => r.role === '') ?? (rows ?? [])[0]
      const chosenProvider = (pick?.provider && pick.provider.trim()) || fallback.provider
      const chosenModel = (settings.model && settings.model.trim()) || (pick?.model && pick.model.trim()) || fallback.model
      // 4) foreman 父级（无则标记失败，不重试同一轮）
      const parent = await ensureForeman(workspace.workspaceFor())
      if (parent === undefined) {
        // S1（R-1/A1）：foreman-down 语义沿用（分类器文案含「守护 foreman 不可用」+ 恢复指引）
        await markChatFailed(msg.id, msg.scope, identity, classifyChatError({ stopReason: 'error', error: 'foreman down' }).message)
        return
      }
      const budgetMs = Math.min(config.workerTimeoutMs, 120000) // 回复预算 ≤120s（TC-S10-01）
      // S6（R-2/R-3 决策 C1/E1 接线）：外部上下文收集——绑定仓库摘要（只读 buildSpaceDigest）+ 本次消息附件内容取回。
      // 纪律（AC-R2-4/R4-3/R4-6）：任一步失败仅降级（null/占位），绝不因上下文失败把源消息标 failed（TC-S6-03/04）；
      // 摘要/附件内容只进入本次提示词，不写任何消息体/meta（TC-S6-09：历史消息附件不回填）。
      let ctxBundle: ChatContextBundle = { spaceDigest: undefined, attachments: [] }
      try {
        const boundDir = spaceBinding && spaceBinding.localDir && spaceBinding.localDir.trim().length > 0 ? spaceBinding.localDir.trim() : null
        ctxBundle = await gatherChatContext({
          hubUrl,
          scope: msg.scope,
          convId: msg.convId,
          by: identity,
          attachmentRefs: msg.meta?.attachments,
          bindingDir: boundDir,
          bindingMeta: { name: msg.scope, remoteUrl: spaceBinding?.remoteUrl ?? undefined },
        })
      } catch (e) {
        log(`chat-responder 上下文收集降级（消息 ${msg.id}）：${String(e)}`)
      }
      const prompt = buildChatAnswerPrompt({
        scope: msg.scope,
        convTitle: msg.convTitle,
        systemHint: settings.systemHint,
        identity,
        // 岗位 Agent 会话：把服务端解析出的岗位与任务记录喂进提示词（chatResponder 早已支持这个块，
        // 但这条线此前没有把它传下去 —— 于是「发给编码工程师」被一条通用对话助手规则回答了）。
        // 任务记录只是**已保存记录**：提示词里明写"没有证据不能声称已执行"（chatResponder L200）。
        ...(msg.agent ? { agent: msg.agent } : {}),
        context: [...(msg.context ?? []), { id: msg.id, author: msg.author, body: msg.body }],
        spaceDigest: ctxBundle.spaceDigest,
        attachments: ctxBundle.attachments,
      })
      const controller = new AbortController()
      controllers.add(controller)
      try {
        const run = await ctx.subagents.start(config.provider, {
          label: `chat:${msg.scope}:${msg.id}`,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          signal: controller.signal,
          outputSchema: CHAT_REPLY_SCHEMA,
          agentOptions: { provider: chosenProvider, model: chosenModel },
        })
        const result = await new Promise<{ stopReason: string; structured?: unknown; output?: readonly { type?: string; text?: string }[] } | null>((resolve) => {
          const t = setTimeout(() => { controller.abort(); resolve(null) }, budgetMs)
          void run.result.then(
            r => { clearTimeout(t); resolve(r) },
            () => { clearTimeout(t); resolve(null) },
          )
        })
        await run.dispose().catch(() => undefined)
        // ① 首选结构化结果（请求带了 outputSchema）。
        const structuredReply = result !== null && result.stopReason === 'completed' && result.structured !== undefined
          ? String((result.structured as { reply?: unknown }).reply ?? '').trim()
          : ''
        // ② **回落到模型输出的文本**（BUG-005 现场）。
        //
        //    为什么必须回落：DSH 的 in-process 结构化运行时在"没有捕获到结构化结果"时会把
        //    `stopReason: completed` **改写成 `error`** 并丢掉 structured
        //    （`@deepseek-ai/dsh-subagent-in-process-driver` 的 readResult：
        //     `if (structured.captured === undefined && stopReason === 'completed') return { output, stopReason: 'error' }`）。
        //    而回复提示词本身要求"以纯文本输出"，模型确实经常直接给文本、不走结构化工具。
        //    实测：`llmMs=5341 / decodeTokens=1011 / lastTurnCompleted=true`、正文是一份完整的进展汇报，
        //    却因为"structured === undefined"被整条丢掉，只留一句「原因暂不可识别」——
        //    **把一份已经拿到的答案当成失败扔掉**。文本就在这里（result.output），用它才对。
        const outputText = result !== null && Array.isArray(result.output)
          ? result.output.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim()
          : ''
        const answer = structuredReply.length > 0 ? structuredReply : outputText
        if (answer.length === 0) {
          const why = result === null
            ? { stopReason: 'aborted' }
            : { stopReason: result.stopReason, error: (result as { error?: unknown }).error }
          await markChatFailed(msg.id, msg.scope, identity, classifyChatError(why).message)
          return
        }
        if (structuredReply.length === 0) {
          // 回落是有代价的（没有 reply 字段的约束），所以它必须**可见**：日志里留一行。
          log(`chat-responder：消息 ${msg.id} 未拿到结构化结果（stopReason=${result?.stopReason ?? 'null'}），已回落用文本输出作答（${answer.length} 字）`)
        }
        // 5) 服务器 CAS 回写：awaiting→replied；并发/重复轮 skipped → 不重复回复（TC-S10-03）
        const out = await hubPost('/api/chat/replies/answer', { msgId: msg.id, body: answer, by: identity, model: chosenModel })
        if (out && typeof out === 'object' && (out as { skipped?: boolean }).skipped === true) return
        daemonChatState.lastReplyAt = new Date().toISOString()
        log(`chat-responder：已回复消息 ${msg.id}（${identity}，provider=${chosenProvider}，model=${chosenModel}）`)
      } finally {
        controllers.delete(controller)
      }
    } catch (e) {
      log(`chat-responder 处理消息 ${msg.id} 失败：${String(e)}`)
      // 失败回写的 by 与应答身份一致（岗位会话就是该岗位身份）：审计里"谁答的"与"谁失败的"必须同名。
      const ident = msg.agent?.identity ?? chatIdentityFor(msg.scope)
      // S1（R-1/A1）：catch 吞错路径同样经分类器生成可行动文案（含原文片段 ≤500 契约），不悬挂 awaiting
      await markChatFailed(msg.id, msg.scope, ident, classifyChatError({ stopReason: 'error', error: String(e) }).message).catch(() => undefined)
    }
  }
  /** S2/R-1（决策 B1）：守护心跳：POST /api/heartbeat kind=worker（成员在线 60s 窗由 hub 判定），
   *  附带当前选用模型（daemon-heartbeat，供 GET /api/chat/health 模型解析链兜底展示）。失败仅日志，不阻断扫单。 */
  async function hubHeartbeat(): Promise<void> {
    if (!useHub || config.mode !== 'worker') return
    try {
      let sel: { provider?: string; model?: string } = {}
      try { sel = ctx.agentDefaultModel.currentSelection() ?? {} } catch { /* 读不到默认模型不影响心跳 */ }
      await hubPost('/api/heartbeat', {
        by: `${config.role}@${scope}`,
        scope,
        kind: 'worker',
        model: { provider: sel.provider || config.provider, model: sel.model || '' },
      })
      if ((config.agentNodeId ?? '').trim() !== '') {
        const worktreeProbe = config.isolate
          ? await runGit(workspace.repoRootFor(), ['rev-parse', '--is-inside-work-tree'])
          : { code: 1 }
        const providerNames = listSubagentProviders(ctx)
        const providers = Object.fromEntries(providerNames.map((name) => [name, subagentProviderCapabilities(ctx, name)]))
        await hubPost('/api/agent-nodes/heartbeat', {
          id: (config.agentNodeId ?? '').trim(),
          scope,
          by: `${config.role}@${scope}`,
          providerNames,
          capabilities: {
            isolatedWorktree: config.isolate && worktreeProbe.code === 0,
            externalAgent: providerNames.some((name) => name === 'codex' || name === 'claude-code'),
            structuredOutput: Object.values(providers).some((caps) => caps.outputSchema),
            toolFilter: Object.values(providers).some((caps) => caps.toolFilter),
            cancellation: Object.values(providers).some((caps) => caps.cancellation),
            providers,
          },
        })
      }
    } catch (e) {
      log(`chat 心跳上报失败：${String(e)}`)
    }
  }

  /** 每轮扫单：拉本 scope awaiting 队列并派轻量子代理（受 chatBusy/单轮上限约束，不占任务 worker 并发槽）。 */
  async function sweepChatReplies(): Promise<void> {
    if (!useHub) return
    try {
      const queue = await fetchJson<{ messages?: HubChatMsg[] }>(`${hubUrl}/api/chat/replies?scope=${encodeURIComponent(scope)}&limit=20`)
      const msgs = (queue?.messages ?? []).filter(m => !chatBusy.has(m.id)).slice(0, CHAT_REPLY_PER_SWEEP)
      for (const m of msgs) {
        chatBusy.add(m.id)
        void answerChatMessage(m).catch(e => log(`chat-responder 消息 ${m.id} 异常：${String(e)}`)).finally(() => chatBusy.delete(m.id))
      }
    } catch (e) {
      log(`chat-responder 拉队列失败：${String(e)}`)
    }
  }

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
      // 公共调解员模式：只做跨空间合入调解，不派工。
      if (config.mode === 'mediator') {
        await mediation.sweepMediation()
        writeDaemonStatus(0)
        return
      }
      // 刷新本 scope 的空间仓库绑定（hub 模式：/api/spaces；命中 localDir → 本空间工作/隔离仓库）
      await workspace.refreshSpaceBinding()
      // SP-P0：刷新空间流水线（hub 数据面优先；内容指纹未变 = 零成本；失败沿用当前来源）
      await refreshPipelineFromHub()
      await hubHeartbeat() // S2/R-1（B1）：守护心跳（kind=worker + 当前模型），chat 健康在线数据源
      await ensureForeman(workspace.workspaceFor())
      await fetchSkills()
      await refreshNorms() // R-2/S5：刷新全局规范层缓存（失败保留旧值降级）
      await sweepChatReplies() // R-4/S10：对话 awaiting → 轻量子代理直答回写
      let tasks: Task[]
      try {
        tasks = await listTasks()
        lastTasks = tasks // 本轮任务快照：目标上下文注入的"并行任务表"数据源
        // P2-③：新一轮 sweep 重建召回语料缓存（pendingRecallRefs 不清空——
        // 异步派工可能在本轮尾部才登记，累积到 sweepExperienceVotes 消费后逐条删除）
        recallCorpusCache = null
      } catch (e) {
        log(`list 失败：${String(e)}`)
        return
      }
      await fetchGoals() // 目标级上下文缓存刷新（失败保留上轮；含 context/contextVersion）
      const byId = new Map(tasks.map(t => [t.id, t]))
      const room = () => inflight.size < config.maxWorkers
      // 切片类型化槽位（advisory 并发上限；maxWorkers 仍是绝对上限）：
      // coder×sliceCoderSlots（fix 任务也占 coder 槽）、tester×sliceTesterSlots、单目标进行中切片任务 ≤ perGoalSliceCap。
      const sliceBusy = (role: string): number =>
        tasks.filter(x => x.role === role && x.slice != null && x.status === 'in_progress').length
      const goalBusy = new Map<string, number>()
      for (const x of tasks) {
        if (x.slice != null && (x.role === 'coder' || x.role === 'tester') && x.status === 'in_progress') {
          const k = sliceGoalKey(x.slice)
          if (k !== null) goalBusy.set(k, (goalBusy.get(k) ?? 0) + 1)
        }
      }
      const sliceRoomOk = (t: Task): boolean => {
        if (t.slice == null) return true
        if (t.role === 'coder' && sliceBusy('coder') >= config.sliceCoderSlots) return false
        if (t.role === 'tester' && sliceBusy('tester') >= config.sliceTesterSlots) return false
        if (t.role === 'coder' || t.role === 'tester') {
          const k = sliceGoalKey(t.slice)
          if (k !== null && (goalBusy.get(k) ?? 0) >= config.perGoalSliceCap) return false
        }
        return true
      }
      // 流水线模式：守护按任务角色认领/派工；单角色模式：只认 config.role 的任务
      // `self` / `isOurs`（本角色判定）随状态机搬到 ./stateMachine.ts（读 isPipeline/stageByRole 取值函数）。
      const frozenStageOf = (t: Task) => t.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitionsById?.[t.agentSelectionSnapshot.workflowStageId ?? '']
        ?? t.agentSelectionSnapshot?.reviewWorkflow?.stageDefinitions?.[t.role ?? '']
      const stageOf = (t: Task) => frozenStageOf(t) ?? (isPipeline ? stageByRole.get(t.role ?? '') : undefined)
      const runDetached = (taskId: string, job: Promise<void>): void => {
        void job
          .catch(e => log(`${taskId} 后台派工异常：${String(e)}`))
          .finally(() => inflight.delete(taskId))
      }
      // openDeps / confirmState / gaveUp / giveUpAwaitingGeneral / workerFailStreak /
      // medWorkerRedispatchCount 六个判定谓词随状态机一起搬到 ./stateMachine.ts（含原始注释）。

      // 离线 inbox 计数：本守护名下待认领（todo/blocked 未认领）任务，每轮汇报一次（将军拦截的除外）
      const isOurInbox = (t: Task) => (isPipeline
        ? (t.role !== null && (stageByRole.has(t.role) || frozenStageOf(t) !== undefined))
        : true)
      const inboxIds = tasks.filter(t => (t.status === 'todo' || t.status === 'blocked') && (t.soldier === null || t.soldier === undefined) && !t.hold && isOurInbox(t))
      if (inboxIds.length > 0) log(`inbox=${inboxIds.length}（${inboxIds.map(t => t.id).join(', ')}）`)

      // 0/0.5 认领租约回收 + 守护重启孤儿回收已拆到 ./reclamation.ts（仓储边界）；
      // 原始注释（hub 模式为何不动本地库、孤儿回收为何必须在第一轮、为何要同步本轮快照）随代码搬入该模块。
      //
      // ★ BUG-012：这两行的**先后不能换回来**。它们是两种强度不同的证据，配的也是两种处理：
      //   · `reclaimBootOrphans`（带 ids）= **证明**：本进程刚重启 ⇒ 上一轮 worker 已随进程消失
      //     ⇒ Hub 真释放预约（`cancelled: false`，见 server.mjs 的 `/api/release-stale`），
      //     任务下一轮就能重认领；
      //   · `reclaimStaleLeases`（按超龄/TTL）= **猜测**：只知"很久没进展"，**慢 worker 可能还在写**
      //     ⇒ Hub 把写入资格**冻结**成 `reconciling`，必须人工 `confirm-stopped` 才能再认领
      //     （这是 T-170 的核心不变量：宁要人工解锁，不要两个写者）。
      //
      //   而**猜测**一旦先跑，就会把**证明**的入口关掉 —— 因为两者读的是同一批对象：
      //   下面 `const byId = new Map(tasks.map(t => [t.id, t]))` 的值就是 `tasks` 里的那些对象，
      //   所以超龄那条把任务改成 `todo` 之后，孤儿回收那句 `status === 'in_progress'` 就再也看不到它。
      //   于是**越老的孤儿越一定被冻结**：老，正是超龄那条的命中条件。
      //   实测（2026-10-06）：T-189 因此被冻结 7 小时、850 次认领失败，它的整仓独占预约把 T-190
      //   一起堵死，整个 software 空间零进展。详见 docs/bugs/BUG-012-boot-orphan-reclaim-order.md。
      await reclamation.reclaimBootOrphans(tasks, byId)
      await reclamation.reclaimStaleLeases(byId)

      // 1/2/3 任务迁移决策（todo 认领派工 / blocked 解阻续做 / in_progress 退回纠错·调解重派·中止退避）
      // 已拆到 ./stateMachine.ts（状态机边界）；原始注释（含 T-117 现场与退回/退避口径）随代码搬入该模块。
      // 接线就在调用点、**每轮一次**：`room` / `sliceRoomOk` / `stageOf` 是本轮 sweep 的局部闸门
      // （`sliceRoomOk` 依赖本轮任务聚合），与原实现把这些谓词定义在 sweep 体内同形。
      const stateMachine = createStateMachine({
        config, log, scope,
        isPipeline: () => isPipeline,
        stageByRole: () => stageByRole,
        stageOf, room, sliceRoomOk, runDetached, inflight, abortRetryAt,
        maxWorkerRetry, maxMediateAttempts,
        claimTask, workTodo, workReturned, runDiscussion,
        safeComment, transitionTo,
        mediatorRecoverWorker: mediation.mediatorRecoverWorker,
      })
      stateMachine.runRound(tasks, byId)
      // 4. 流水线 done 补流转：将军人工合入/验收后手动 done 的中间阶段任务 → 创建下一角色任务（幂等：已有后继则跳过）
      if (isPipeline || tasks.some(x => x.status === 'done' && x.agentSelectionSnapshot?.reviewWorkflow !== undefined)) {
        for (const t of tasks.filter(x => x.status === 'done' && stageOf(x) !== undefined)) {
          await handoff.advancePipeline(t)
        }
      }
      // ★ BUG-010：上面那道补流转**只看 `done`**。而异常路径（文件域越界 / 合入失败）把任务停在
      //   `in_review` 就 `return` 了 —— 于是"人只合入、没推进 done"时，下一环**永远不会被派**，
      //   而链看起来像走完了。实测（2026-10-05）：T-178 是 coder、stage.next=reviewer，
      //   人工合入后停在 in_review，它的代码审查环被静默跳过，且没有任何读数会说话。
      //   这里每轮报一次读数（**只读、不改状态**），把这件静默的事变成可见的。
      //
      //   判据 = 「停在 in_review」+「角色有下一环」+「不是人工闸门岗」
      //        +「**分支自己确实改过东西**」+「该分支已并入当前 HEAD」。
      //   后两条的语义：正常流转的任务分支会被 autoPromote 删掉（`branch -D w/<id>`），
      //   所以这个组合只会在"已合入、但没推进 done"时成立；闸门岗（requirement/researcher）
      //   合法地停在这里等将军，故显式排除。
      //
      //   ★「分支自己确实改过东西」这一条是**上线后补的**。首版只判 ancestor，于是 T-179
      //     —— 一个提交都没有的分支，`w/T-179` 的 HEAD 就是它自己的基线 —— **天然是 HEAD 的祖先**，
      //     每轮都为它报一次"请推进 done"。而对一个零改动的判定型任务，推进 done 不会派出任何
      //     真正要干活的下游环（没有代码要审/要发）。忘掉这条 = 把一次假停摆变成每轮的噪音，
      //     而噪音会淹没真信号。判据复用 changedFilesOfBranch（**三点** refspec，理由见 ./branchScope.ts）。
      for (const t of tasks.filter(x => x.status === 'in_review' && stageOf(x) !== undefined)) {
        const sigStage = stageOf(t)
        if (!sigStage || sigStage.next == null || sigStage.gate === true) continue
        const own = await changedFilesOfBranch(t)
        if (own.length === 0) continue
        const anc = await runGit(workspace.repoRootFor(), ['merge-base', '--is-ancestor', `w/${t.id}`, 'HEAD'])
        if (anc.code === 0) {
          log(`${t.id} ⚠ 停在 in_review 但分支 w/${t.id} 已并入 HEAD —— 下游「${sigStage.next}」环不会被派`
            + `（补流转扫单只看 done）。请推进 done：POST /api/transition {id:"${t.id}",to:"done"}（或界面「✓ 验收通过」）`)
        }
      }
      // 4.2 / 4.3 / 4.4 / 4.5a 验收与沉淀管线已拆到 ./acceptance.ts（验收边界）；原始注释
      // （结算幂等、票务→promote 顺序、doctor 口径、技能桥同步时点）随代码搬入该模块。
      // 四步的先后即下面四行的先后：4.3 必须在 4.2 之后跑，本轮新落盘的草稿才能参与事件扫描。
      for (const t of tasks.filter(x => x.status === 'done')) {
        await acceptance.settleExperience(t)
      }
      await acceptance.sweepExperienceVotes(tasks)
      acceptance.runRuleDoctorNow()
      await acceptance.syncSkillsToDsh()
      // 4.5 合入调解（将军已授权自动处理类）：发现 in_review 且评论带「自动合入失败」标记的任务 →
      //     派调解员合入主分支并推进 done（同一时刻只调解一个，防主仓库 git 合并态互相踩踏；
      //     失败带退避重试，超过上限留将军人工；give-up 任务跳过，不挡后续任务调解）。
      //     mediateMergeFails=false（部署公共调解员时）→ worker 不再内嵌调解，交给公共 mediator 实例跨空间处理。
      if (isPipeline && useHub && config.mediateMergeFails) {
        const mediable = tasks
          .filter(t => mediation.isMediatableMergeFail(t) && !mediating.has(t.id))
          .sort((a, b) => a.id.localeCompare(b.id))
        const giveUpComment = (id: string) => {
          // far-future 哨兵保证「已放弃」只提示一次，不再每轮刷评论
          if ((mediateRetryAt.get(id) ?? 0) < Date.now() - 24 * 60 * 60 * 1000) {
            mediateRetryAt.set(id, Date.now() + 24 * 60 * 60 * 1000)
            void safeComment(id, '🛑 调解已自动重试 2 次仍未成功，任务留在 in_review 请将军人工处理')
          }
        }
        for (const t of mediable) {
          const attempts = mediateAttempts.get(t.id) ?? 0
          const lastFail = mediateRetryAt.get(t.id) ?? 0
          if (attempts >= maxMediateAttempts) { giveUpComment(t.id); continue }
          if (Date.now() - lastFail < config.intervalMs * 6) continue // 失败退避期内
          inflight.add(t.id)
          mediating.add(t.id)
          runDetached(t.id, (async () => {
            try {
              await mediation.mediateReview(t)
              const after = await getTask(t.id).catch(() => undefined)
              if (!after || after.status !== 'done') {
                mediateAttempts.set(t.id, attempts + 1)
                mediateRetryAt.set(t.id, Date.now())
              } else {
                mediateAttempts.delete(t.id)
                mediateRetryAt.delete(t.id)
              }
            } finally {
              mediating.delete(t.id)
            }
          })())
          break // 每轮只调解一个（串行化主仓库 git 合并）
        }
      }
      // 5. 切片流水线编排（仅 hub 模式）：readyToExpand 注册切片束 / fix 合入后重开 tester 重测
      //    （PRT-315 切片 7：编排本体已搬到 ./sliceOrchestration.ts；`if (useHub)` 守卫与下面
      //     这圈 try/catch **故意留在这里**——hub 不可达就不编排、编排抛错只记一行日志、本轮
      //     照常收尾（writeDaemonStatus 仍会跑）。搬进模块等于让模块自己决定「hub 不可达算不算
      //     失败」，那是调用方的语义。）
      if (useHub) {
        try {
          await sliceOrchestration.orchestrateSlices(tasks)
        } catch (e) {
          log(`切片编排失败：${String(e)}`)
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

// ─────────────────────────── SP-P1 多空间编排（监督者） ───────────────────────────
// 目标：一个宿主插件行接管 N 个空间，新增空间不再需要改 DSH profile 配置文件。
// 机制：空间定义与执行配置全部来自数据面（GET /api/spaces + GET /api/pipeline?include=active）；
//      监督者按 diff 挂载/卸载子实例（ctx.plugin），每个子实例仍是完整的单空间守护（闭包状态独立）。
// 边界：只接管「数据面已配流水线且 space_runtime.enabled=true」的空间——没有流水线的空间会退化成
//      单角色认领（认领该 scope 下任意 todo），多空间共用一个实例时风险更大，故宁可跳过并写日志。

/** 子实例日志文件：与父日志同目录、按 scope 命名（多空间共用一份日志会互相淹没）。 */
// ── PRT-1007 片 2：文件命名族（`childLogFile` / `statusFileNames`）已整体搬去 `./spacePaths.js` ──
// ★ 回引写在**这里**（原地）而不是文件头：写在文件头会让其下**所有行号 +N**，
//   而 `runtime/adapters/dsh/*.mjs` 与仓里若干 `.ts` 都按行号引本文件 ——
//   `boundary-facts` 的 `source-original-citations-on-line` 会当场读到读数变化。
import { childLogFile, statusFileNames } from './spacePaths.js'   // 本地调用点要用（ESM 的 import 顶层即可，位置不限）
export { childLogFile, statusFileNames } from './spacePaths.js'   // 公开面不变：消费者仍从 lib/index.js 取

/**
 * 守护状态文件名（相对 scrumDir）。
 *
 * 兼容策略：看板与健康页只认 `daemon.json`，故**主 scope**（父配置声明的 scope）继续维护它，
 * 同时也写自己的 per-scope 文件；其余空间只写 per-scope 文件——避免多个实例抢写同一文件，
 * 这正是 P1 要修的多实例问题之一。
 */

/** 数据面视图：一个空间的执行配置（space_runtime + 流水线环数）。 */
export interface SpaceRuntimeView {
  id: string
  /** space_runtime.enabled —— false 表示该空间暂不由守护接管。 */
  enabled: boolean
  maxWorkers?: number
  isolate?: boolean
  /** 数据面启用流水线的环数；0 = 未配置（多空间模式下跳过）。 */
  stages: number
}

/**
 * 由「父配置 + 数据面空间视图」算出要挂载的子实例配置（纯函数，便于单测）。
 *
 * 跳过条件：不在 scopes 白名单、未开通执行、数据面无流水线。返回顺序与输入一致（稳定）。
 *
 * 「主 scope」归属：优先给父配置自己声明的 scope；父 scope 不在接管集合里时**交给第一个空间**——
 * 否则当父 scope 未开通时没人再维护 `daemon.json`，看板/健康页的守护卡片会永久停留在旧数据。
 */
export function planSpaceRunners(parent: Config, spaces: SpaceRuntimeView[]): Config[] {
  const want = parent.scopes
  if (want === undefined || want === 'off') return []
  const allowed = (id: string): boolean => want === 'auto' || want.includes(id)
  const out: Config[] = []
  for (const s of spaces) {
    if (!allowed(s.id)) continue
    if (!s.enabled) continue
    if (s.stages <= 0) continue
    out.push({
      ...parent,
      scope: s.id,
      scopes: 'off' as const,          // 子实例只做单空间派工，不再递归监督
      primaryScope: '',                // 下面统一指定
      rolesFile: '',                   // 多空间共用一个 rolesFile 会串味；数据面才是唯一来源
      logFile: childLogFile(parent.logFile, s.id),
      ...(typeof s.maxWorkers === 'number' ? { maxWorkers: s.maxWorkers } : {}),
      ...(typeof s.isolate === 'boolean' ? { isolate: s.isolate } : {}),
    })
  }
  const primary = out.some(c => c.scope === parent.scope) ? parent.scope : (out[0]?.scope ?? '')
  for (const c of out) c.primaryScope = primary
  return out
}

/** 读数据面：空间清单 + 各自执行配置（hubUrl 为空 = 非 hub 模式 → 空数组）。 */
async function fetchSpaceViews(config: Config): Promise<SpaceRuntimeView[]> {
  const hub = config.hubUrl.replace(/\/+$/, '')
  if (hub === '') return []
  const headers: Record<string, string> = config.hubToken !== '' ? { authorization: `Bearer ${config.hubToken}` } : {}
  const res = await fetch(`${hub}/api/spaces`, { headers, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`hub /api/spaces 失败（${res.status}）`)
  const list = await res.json() as unknown
  const out: SpaceRuntimeView[] = []
  for (const item of Array.isArray(list) ? list : []) {
    const id = typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : ''
    if (id === '') continue
    const view: SpaceRuntimeView = { id, enabled: false, stages: 0 }
    try {
      const r = await fetch(`${hub}/api/pipeline?scope=${encodeURIComponent(id)}&include=active`, { headers, signal: AbortSignal.timeout(5000) })
      if (r.ok) {
        const p = await r.json() as { runtime?: { enabled?: unknown; maxWorkers?: unknown; isolate?: unknown }; activeRoles?: unknown }
        view.enabled = p.runtime?.enabled === true
        if (typeof p.runtime?.maxWorkers === 'number') view.maxWorkers = p.runtime.maxWorkers
        if (typeof p.runtime?.isolate === 'boolean') view.isolate = p.runtime.isolate
        view.stages = Array.isArray(p.activeRoles) ? p.activeRoles.length : 0
      }
    } catch { /* 单空间读取失败 → 视为未开通（下一轮再试） */ }
    out.push(view)
  }
  return out
}

/** 子实例签名：任一「启动期固化」的字段变化 → 重新挂载该空间的子实例。 */
function runnerSignature(child: Config): string {
  return JSON.stringify([child.maxWorkers, child.isolate, child.rolesFile, child.logFile, child.agentPreset, child.workerTimeoutMs, child.primaryScope])
}

/**
 * 多空间监督者：周期对齐「数据面期望的空间集合」与「已挂载的子实例」，只做最小 diff。
 *
 * 对齐是幂等的：空间消失 / 执行关闭 / 关键配置变化 → 卸载（或重启）；新空间 → 挂载。
 * 卸载走 fiber.dispose()：子实例的 setInterval、effect、在跑 controller 随其 Fiber 回收。
 */
/** ★ T2 立缝第一刀（2026-09-24）：`superviseSpaces` 用的文件日志器。
 *
 *  原来它是**捕获 `logFile` 的闭包**，现在提成顶层具名函数：`logFile` 由参数进来。
 *  这是这一刀**唯一**的语义变化 —— "捕获"变"传参"，其余（mkdir 递归、ISO 时间戳、
 *  失败静默）逐字不动。
 *
 *  ★ 为什么只提这一个：同一段日志闭包在 `spaceWorker` 里**还有一份**，两处并不共享。
 *  立缝的第一刀只动一个函数体，另一处原样留着 —— 等它自己被需要时再走同样的路，
 *  不在这里顺手"统一"，因为那会把"一次一刀"变成"一次两处"，而两边跑起来并不等价。
 *
 *  > 第一刀不追求"搬走多少行"，追求"**从此有一个能被单独指认的名字**"：
 *  > 在此之前，这个空间的日志行为只能靠"读那一大段的第三行"来讨论。
 */
function makeFileLogger(logFile: string): (msg: string) => void {
  return (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }
}
function superviseSpaces(ctx: AppContext, config: Config): void {
  const SHORT = 'dsh-scrum-worker'
  const logFile = config.logFile || join(homedir(), '.dsh', 'super-injector', SHORT + '.log')
  // ★ T2 立缝第一刀（2026-09-24）：这段原本是**捕获 `logFile` 的闭包**，已提成顶层
  //   具名函数 `makeFileLogger`（参数进来、行为不变）。刀痕留在这里：
  //   要改这个空间的日志行为，改 `makeFileLogger`。
  //   ★ `spaceWorker` 里那份同类闭包**没有动**（它们不共享）。
  const log = makeFileLogger(logFile)

  type MountedRunner = { dispose: () => void; signature: string }
  const mounted = new Map<string, MountedRunner>()
  let reconciling = false

  const mountRunner = (child: Config): MountedRunner => {
    const plugin = { name: `${name}:space:${child.scope}`, inject, apply: spaceWorker }
    const fiber = (ctx.plugin as unknown as (p: unknown, c: unknown) => { dispose: () => void })(plugin, child)
    return { dispose: () => fiber.dispose(), signature: runnerSignature(child) }
  }

  /** ★ T2 立缝第二刀（2026-09-24）：`reconcile` 里"卸载不再需要的空间"这一段。
   *
   *  它仍然捕获同一作用域里的 `mounted` 与 `log`（**没有**改成传参）—— 所以这一刀
   *  **行为逐字不变**，唯一的产物是"这段逻辑从此有一个能被单独指认的名字"。
   *
   *  ★ 与第一刀的区别，也是立缝的层次感：第一刀把"捕获"变成了"传参"（因为那个闭包
   *    只依赖 `logFile` 一个外部量）；这一刀依赖两个**属于监督者生命周期**的量，
   *    把它们改成参数等于把状态所有权搬出去 —— 那是后面某一刀的事，不是这一刀。
   */
  function unmountStale(desiredScopes: Set<string>): void {
  for (const scope of [...mounted.keys()]) {
    if (desiredScopes.has(scope)) continue
    try { mounted.get(scope)?.dispose() } catch (e) { log(`空间 ${scope} 卸载异常：${String(e)}`) }
    mounted.delete(scope)
    log(`[-] 空间 ${scope} 已卸载（数据面关闭执行 / 空间已移除 / 不再配置流水线）`)
  }
  }
  async function reconcile(): Promise<void> {
    if (reconciling) return
    reconciling = true
    try {
      const views = await fetchSpaceViews(config)
      const desired = planSpaceRunners(config, views)
      const desiredScopes = new Set(desired.map(c => c.scope))

      // ★ T2 立缝第二刀（2026-09-24）：这段已提成上面的具名函数 `unmountStale`。
      //   要改"哪些空间该卸载"，改 `unmountStale`。
      unmountStale(desiredScopes)

      for (const child of desired) {
        const current = mounted.get(child.scope)
        if (current !== undefined && current.signature !== runnerSignature(child)) {
          try { current.dispose() } catch (e) { log(`空间 ${child.scope} 重启（配置变化）异常：${String(e)}`) }
          mounted.delete(child.scope)
          log(`[~] 空间 ${child.scope} 配置变化 → 重新挂载（并发 ${child.maxWorkers}，隔离 ${child.isolate}）`)
        }
        if (mounted.has(child.scope)) continue
        try {
          mounted.set(child.scope, mountRunner(child))
          log(`[+] 空间 ${child.scope} 已挂载（并发 ${child.maxWorkers}，隔离 ${child.isolate}，数据面流水线 ${views.find(v => v.id === child.scope)?.stages ?? 0} 环）`)
        } catch (e) {
          log(`空间 ${child.scope} 挂载失败：${String(e)}`)
        }
      }

      const skipped = views.filter(v => !desiredScopes.has(v.id)).map(v => v.id)
      if (skipped.length > 0) log(`未接管空间（未开通执行 / 无数据面流水线 / 不在 scopes 白名单）：${skipped.join('、')}`)
    } finally {
      reconciling = false
    }
  }

  // 首个对齐立即执行（不等一个 interval）：新空间出现后尽快可派工。
  void reconcile().catch(e => log(`多空间首次编排失败：${String(e)}`))
  // 对齐周期不短于 15s：空间增减是低频事件，避免把 hub 当心跳打。
  const period = Math.max(config.intervalMs, 15_000)
  ctx.setInterval(() => { void reconcile().catch(e => log(`多空间编排异常：${String(e)}`)) }, period)
  ctx.effect(() => () => {
    for (const [scope, runner] of mounted) {
      try { runner.dispose() } catch (e) { log(`空间 ${scope} 释放异常：${String(e)}`) }
    }
    mounted.clear()
  }, `${name}: 多空间卸载`)

  ctx.logger?.info?.(`[${name}] 多空间监督者启动（scopes=${config.scopes === 'auto' ? 'auto' : (Array.isArray(config.scopes) ? config.scopes.join(',') : String(config.scopes))}，每 ${period}ms 对齐，主 scope=${config.scope}）`)
}

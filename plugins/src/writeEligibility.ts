// plugins/src/writeEligibility.ts
// ============================================================================
// 守护侧写入资格判定（S5 / R-3）
//
// 纯函数：把「一次工具调用能不能写、按哪条理由拒绝、RunRequest 的哪些字段模型
// 不得改写」从 3000 行守护闭包里抽出来，使每条拒绝分支都能被单独验证。
//
// 唯一判定来源：packages/shared/src/path-domain.mjs。本模块**不**再写一份
// startsWith 前缀判定——两份判定会给出两个结论，而那种缺陷只在两个任务抢同一
// 文件时才显形（AC-R1-6）。
// ============================================================================
import { pathsIntersect, normalizeRepoPath } from '../../packages/shared/src/path-domain.mjs'

export const WRITE_TOOLS = Object.freeze([
  'write', 'edit', 'apply_patch', 'fs.writeFile', 'fs.edit', 'run_code', 'bash', 'shell', 'multiedit',
])
export const READ_TOOLS = Object.freeze([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'ls', 'cat',
])

export type ToolKind = 'read' | 'write' | 'unknown'

export interface PreExecuteInput {
  toolName: string
  targetPaths?: string[]
  scopePaths?: Array<string | { path: string, type: 'file' | 'dir' }>
  attemptId?: string | null
  epoch?: number | null
  intentRevision?: number | null
  expectedEpoch?: number | null
  expectedRevision?: number | null
  workspaceId?: string | null
  expectedWorkspaceId?: string | null
  caseInsensitive?: boolean
}

export interface WriteDecision {
  allow: boolean
  kind: ToolKind
  code: string
  message: string
}

export function classifyTool(toolName: string): ToolKind {
  const name = String(toolName ?? '').trim()
  if (WRITE_TOOLS.includes(name)) return 'write'
  if (READ_TOOLS.includes(name)) return 'read'
  return 'unknown'
}

/** 路径是否落在声明的写入范围内（目录按段边界覆盖；文件精确相等）。 */
export function isWithinScope(path: string, scopePaths: Array<string | { path: string, type: 'file' | 'dir' }> = [], caseInsensitive = false): boolean {
  const target = [{ path, type: 'file' as const }]
  for (const entry of scopePaths) {
    const e = typeof entry === 'string' ? { path: entry, type: 'dir' as const } : entry
    if (pathsIntersect(target, [e], { caseInsensitive })) return true
  }
  return false
}

function deny(kind: ToolKind, code: string, message: string): WriteDecision {
  return Object.freeze({ allow: false, kind, code, message })
}

/**
 * pre-execute 判定。只读工具永远放行且**不申请预约**；写入工具逐条检查
 * workspace/epoch/revision/范围。
 */
export function evaluatePreExecute(input: PreExecuteInput): WriteDecision {
  const kind = classifyTool(input.toolName)
  if (kind !== 'write') {
    return Object.freeze({ allow: true, kind, code: 'READ_PHASE_NO_RESERVATION', message: '只读操作不申请写入资格' })
  }
  const ci = input.caseInsensitive === true
  if (input.expectedWorkspaceId && input.workspaceId && input.workspaceId !== input.expectedWorkspaceId) {
    return deny('write', 'WORKSPACE_MISMATCH', `写入工作区与 RunRequest 绑定的工作区不一致（${input.workspaceId} ≠ ${input.expectedWorkspaceId}）：请在新工作区重新认领`)
  }
  if (input.expectedEpoch !== undefined && input.expectedEpoch !== null && input.epoch !== undefined && input.epoch !== null && Number(input.epoch) !== Number(input.expectedEpoch)) {
    return deny('write', 'EPOCH_STALE', `写入资格 epoch 已过期（当前 ${input.epoch}，预期 ${input.expectedEpoch}）：该 Attempt 已失去写入资格`)
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== null && input.intentRevision !== undefined && input.intentRevision !== null && Number(input.intentRevision) !== Number(input.expectedRevision)) {
    return deny('write', 'REVISION_MISMATCH', `写入意图 revision 已变化（当前 ${input.intentRevision}，预期 ${input.expectedRevision}）：请基于最新范围重试`)
  }
  const paths = Array.isArray(input.targetPaths) ? input.targetPaths : []
  const scope = Array.isArray(input.scopePaths) ? input.scopePaths : []
  for (const raw of paths) {
    const norm = normalizeRepoPath(raw, { caseInsensitive: ci })
    if (!norm.ok) return deny('write', 'PATH_REJECTED', `写入路径被拒绝：${norm.reason}`)
    if (!isWithinScope(norm.path, scope, ci)) {
      return deny('write', 'OUT_OF_SCOPE', `路径 ${norm.path} 越出本次写入范围（${scope.map((s) => (typeof s === 'string' ? s : s.path)).join(', ')}）：扩域请走 write-intent 扩域事务，不要直接写`)
    }
  }
  return Object.freeze({ allow: true, kind: 'write', code: 'ALLOWED', message: '在声明的写入范围内' })
}

const IDENTITY_FIELDS = Object.freeze(['attemptId', 'epoch', 'intentRevision', 'workspaceId', 'repoId', 'targetRef'])

export interface RunIdentity {
  attemptId: string | null
  epoch: number | null
  intentRevision: number | null
  workspaceId: string | null
  repoId: string | null
  targetRef: string | null
  toolBudget?: number
}

/** 冻结一次 Run 的**身份**字段；模型的任何 patch 都不能改它们。 */
export function freezeRunRequest(input: Partial<RunIdentity> & Record<string, unknown>): Readonly<RunIdentity & Record<string, unknown>> {
  return Object.freeze({
    ...input,
    attemptId: input.attemptId ?? null,
    epoch: input.epoch ?? null,
    intentRevision: input.intentRevision ?? null,
    workspaceId: input.workspaceId ?? null,
    repoId: input.repoId ?? null,
    targetRef: input.targetRef ?? null,
    modelOverridable: Object.freeze([]),
  })
}

/** 应用一个（可能来自模型的）补丁：身份字段一律忽略。 */
export function applyRunPatch(frozen: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...frozen }
  for (const key of Object.keys(patch ?? {})) {
    if (IDENTITY_FIELDS.includes(key)) continue
    out[key] = patch[key]
  }
  return Object.freeze(out)
}

export interface SchedulingView {
  schedulingState: 'reserved' | 'waiting-file'
  waitReason: string | null
  blockingTaskId: string | null
  blockingPath: string | null
  readOnlyWork: readonly string[]
}

/** 用户可读的等待视图：等谁、等哪个文件、等待期间还能做哪些只读工作。 */
export function schedulingView(input: {
  task: { id: string }
  requestedPaths?: string[]
  activeReservations?: Array<{ taskId: string, paths: Array<string | { path: string }> }>
  caseInsensitive?: boolean
}): SchedulingView {
  const ci = input.caseInsensitive === true
  const requested = input.requestedPaths ?? []
  for (const res of input.activeReservations ?? []) {
    if (res.taskId === input.task.id) continue
    const holderPaths = res.paths.map((p) => (typeof p === 'string' ? p : p.path))
    const holderEntries = res.paths.map((p) => (typeof p === 'string' ? { path: p, type: 'dir' as const } : p))
    if (pathsIntersect(requested, holderEntries, { caseInsensitive: ci })) {
      const blocked = requested.find((p) => pathsIntersect([{ path: p, type: 'file' }], holderEntries, { caseInsensitive: ci })) ?? requested[0]
      return Object.freeze({
        schedulingState: 'waiting-file',
        waitReason: `等待任务 ${res.taskId} 释放 ${blocked}`,
        blockingTaskId: res.taskId,
        blockingPath: blocked ?? (holderPaths[0] ?? null),
        readOnlyWork: Object.freeze(['继续只读调研与代码阅读', '完善方案与用例', '等待结束后基于最新目标提交重建工作区']),
      })
    }
  }
  return Object.freeze({ schedulingState: 'reserved', waitReason: null, blockingTaskId: null, blockingPath: null, readOnlyWork: Object.freeze([]) })
}

/** 拿到资格后目标 HEAD 变化 → 需要按新目标重新核验修改计划。 */
export function shouldRecheckPlan({ targetHeadAtReserve, targetHeadNow }: { targetHeadAtReserve: string | null, targetHeadNow: string | null }): boolean {
  return Boolean(targetHeadAtReserve) && targetHeadAtReserve !== targetHeadNow
}

/** 非 Git / Git 不可用的可读降级提示（R-7，不静默）。 */
export function degradationNotice(capability: string, reason?: string | null): string {
  if (capability === 'git') return 'Git 仓库：可并行隔离执行。'
  return `该仓库不是可用的 Git 工作区：首版只允许一个写入任务串行执行（只读任务不受限）。原因：${reason ?? '未提供'}`
}

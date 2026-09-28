import { isAbsolute, relative } from 'node:path'
import { normalizeRepoPath } from '../../packages/shared/src/path-domain.mjs'
import { evaluatePreExecute, classifyTool, type WriteDecision } from './writeEligibility.js'

export interface GrantedWrite {
  attemptId: string
  epoch: number
  revision: number
  workspace: string
  paths: Array<{ path: string, type: 'file' | 'dir' }>
  exclusive: boolean
}

/** The outer PTC program has no filesystem API; every nested tool is screened separately. */
export function toolPaths(name: string, args: unknown, workspace: string): { paths: string[], error?: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { paths: [], error: '写入工具参数无效' }
  const value = args as Record<string, unknown>
  const raw: string[] = []
  if (name === 'apply_patch') {
    const patch = typeof value.patch === 'string' ? value.patch : typeof value.input === 'string' ? value.input : ''
    for (const line of patch.split(/\r?\n/)) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line)
      if (match) raw.push(match[1])
    }
  } else {
    for (const key of ['path', 'file_path', 'filePath', 'filename', 'targetPath']) {
      if (typeof value[key] === 'string') raw.push(value[key] as string)
    }
    if (Array.isArray(value.edits)) {
      for (const edit of value.edits) {
        if (edit && typeof edit === 'object') {
          const item = edit as Record<string, unknown>
          const path = item.path ?? item.file_path ?? item.filePath
          if (typeof path === 'string') raw.push(path)
        }
      }
    }
  }
  if (raw.length === 0) return { paths: [], error: '无法识别写入目标路径' }
  const paths: string[] = []
  for (const path of raw) {
    const rel = isAbsolute(path) ? relative(workspace, path) : path
    const norm = normalizeRepoPath(rel, { caseInsensitive: process.platform === 'win32' })
    if (!norm.ok) return { paths: [], error: `写入路径无效：${norm.reason}` }
    paths.push(norm.path)
  }
  return { paths }
}

function reject(code: string, message: string): WriteDecision {
  return { allow: false, kind: 'write', code, message }
}

/** A task's lease and revision are reread from the hub before every write. */
export function decideProductionTool(input: {
  toolName: string
  args: unknown
  granted: GrantedWrite
  current: GrantedWrite | null
}): WriteDecision {
  const { toolName, args, granted, current } = input
  if (toolName === 'run_code') return { allow: true, kind: 'read', code: 'TRANSPORT_ONLY', message: '内部工具调用逐条核验' }
  if (classifyTool(toolName) === 'read') return { allow: true, kind: 'read', code: 'READ_ONLY', message: '只读操作' }
  if (toolName === 'bash' || toolName === 'shell') return reject('OPAQUE_COMMAND', '集成模式下不允许无法预知写入目标的命令；验证由集成服务执行')
  if (classifyTool(toolName) !== 'write') return reject('UNKNOWN_TOOL', `无法判定工具 ${toolName} 是否写入，已停止执行`)
  if (!current || current.attemptId !== granted.attemptId || current.epoch !== granted.epoch || current.revision !== granted.revision) {
    return reject('WRITE_LEASE_CHANGED', '写入资格或范围版本已经变化，请重新认领任务')
  }
  const extracted = toolPaths(toolName, args, granted.workspace)
  if (extracted.error) return reject('PATH_UNKNOWN', extracted.error)
  return evaluatePreExecute({
    toolName, targetPaths: extracted.paths,
    scopePaths: granted.exclusive ? extracted.paths.map(path => ({ path, type: 'file' as const })) : granted.paths,
    attemptId: granted.attemptId, epoch: current.epoch, expectedEpoch: granted.epoch,
    intentRevision: current.revision, expectedRevision: granted.revision,
    workspaceId: current.workspace, expectedWorkspaceId: granted.workspace,
    caseInsensitive: process.platform === 'win32',
  })
}

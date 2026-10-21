import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function fail(message) {
  throw Object.assign(new Error(message), { code: 'AGENT_WORKFLOW_CHECKPOINT_INVALID', statusCode: 409 })
}

function git(runGit, cwd, args) {
  const result = runGit(args, cwd)
  if (!result?.ok) fail(`冻结工作流阶段提交失败：${(result?.stderr ?? result?.error ?? args[0]).trim()}`)
  return result.stdout.trim()
}

function artifactDigests(bytes) {
  const raw = createHash('sha256').update(bytes).digest('hex')
  if (bytes.includes(0)) return new Set([raw])
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return new Set([raw])
  const canonical = createHash('sha256').update(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'), 'utf8').digest('hex')
  return new Set([raw, canonical])
}

function safeArtifactPath(path) {
  if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) return false
  const parts = path.replaceAll('\\', '/').split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

/** Commit only registered, digest-verified files from a human-accepted workflow stage. */
export function commitAcceptedWorkflowArtifacts({ taskId, stageId, artifacts, workspaceDir, resolveArtifact, runGit }) {
  if (typeof taskId !== 'string' || taskId.trim() === '' || typeof stageId !== 'string' || stageId.trim() === '') fail('工作流阶段缺少 taskId 或 stageId')
  if (typeof workspaceDir !== 'string' || typeof resolveArtifact !== 'function' || typeof runGit !== 'function') fail('冻结工作流阶段提交缺少工作区或 Git 接缝')
  const fileArtifacts = Array.isArray(artifacts) ? artifacts.filter((item) => item?.kind === 'file') : []
  if (fileArtifacts.length === 0) fail(`阶段 ${stageId} 没有可冻结的已登记文件产物`)

  const worktree = realpathSync(resolve(workspaceDir))
  const top = git(runGit, worktree, ['rev-parse', '--show-toplevel'])
  if (realpathSync(top) !== worktree) fail(`任务 ${taskId} 的阶段工作区不是独立 Git worktree`)
  const branch = git(runGit, worktree, ['symbolic-ref', '--short', 'HEAD'])
  if (branch !== `w/${taskId}`) fail(`阶段工作区分支错误：期望 w/${taskId}，实际 ${branch}`)

  const paths = []
  for (const item of fileArtifacts) {
    if (!safeArtifactPath(item.path) || !/^[0-9a-f]{64}$/.test(item.digest ?? '')) {
      fail(`阶段 ${stageId} 的登记产物缺少安全路径或 SHA-256：${item.path ?? '(missing)'}`)
    }
    const target = resolveArtifact(taskId, item.path)
    if (!target || target.unsafe || target.source !== 'worktree') fail(`阶段产物不在任务隔离工作区：${item.path}`)
    const abs = realpathSync(target.abs)
    const rel = relative(worktree, abs)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`阶段产物越出任务隔离工作区：${item.path}`)
    const gitPath = rel.split(sep).join('/')
    if (!artifactDigests(readFileSync(abs)).has(item.digest)) fail(`阶段产物摘要已变化：${item.path}`)
    paths.push(gitPath)
  }
  const uniquePaths = [...new Set(paths)].sort()

  const stagedBefore = git(runGit, worktree, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
  if (stagedBefore.some((path) => !uniquePaths.includes(path))) fail('任务工作区已有未登记的暂存改动；请先处理后再验收')
  const added = runGit(['add', '--', ...uniquePaths], worktree)
  if (!added?.ok) fail(`冻结阶段产物暂存失败：${(added?.stderr ?? added?.error ?? '').trim()}`)
  const staged = git(runGit, worktree, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
  if (staged.some((path) => !uniquePaths.includes(path))) fail('冻结阶段提交包含未登记文件，已拒绝提交')

  if (staged.length > 0) {
    const committed = runGit([
      '-c', 'user.name=Legion', '-c', 'user.email=legion@localhost',
      'commit', '-m', `Freeze accepted workflow stage ${stageId} (${taskId})`,
    ], worktree)
    if (!committed?.ok) fail(`冻结阶段提交失败：${(committed?.stderr ?? committed?.error ?? '').trim()}`)
  }

  const sourceCommit = git(runGit, worktree, ['rev-parse', '--verify', 'HEAD'])
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) fail(`阶段 ${stageId} 未能生成有效的冻结提交`)
  git(runGit, worktree, ['cat-file', '-e', `${sourceCommit}^{commit}`])
  for (const path of uniquePaths) {
    const workingBlob = git(runGit, worktree, ['hash-object', '--', path])
    const committedBlob = git(runGit, worktree, ['rev-parse', `${sourceCommit}:${path}`])
    if (workingBlob !== committedBlob) fail(`冻结提交与登记产物内容不一致：${path}`)
  }
  return Object.freeze({ sourceCommit, paths: Object.freeze(uniquePaths) })
}

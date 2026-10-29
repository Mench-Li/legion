import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commitAcceptedWorkflowArtifacts } from './accepted-workflow-checkpoint.mjs'
import { runGit } from './git-plumbing.mjs'

function git(repo, args) {
  const result = runGit(args, repo)
  assert.equal(result.ok, true, `${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function createTaskWorktree(taskId) {
  const root = mkdtempSync(join(tmpdir(), 'legion-accepted-checkpoint-'))
  git(root, ['init', '--initial-branch', `w/${taskId}`])
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base'])
  return root
}

test('★ 没有登记任何产物时冻结本任务分支的 HEAD（BUG-039：不再一律 409）', () => {
  const taskId = 'T-checkpoint-head'
  const workspaceDir = createTaskWorktree(taskId)
  try {
    // 工作已经提交在这条分支上，但没有任何东西保证 worker 还会去登记产物。
    mkdirSync(join(workspaceDir, 'workbench'), { recursive: true })
    writeFileSync(join(workspaceDir, 'workbench', 'app.mjs'), 'export const fixed = true\n')
    git(workspaceDir, ['add', 'workbench/app.mjs'])
    git(workspaceDir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'stage work'])
    const head = git(workspaceDir, ['rev-parse', 'HEAD'])

    const checkpoint = commitAcceptedWorkflowArtifacts({
      taskId,
      stageId: 'implement',
      workspaceDir,
      artifacts: [],
      resolveArtifact: () => { throw new Error('空产物表不该去解析产物') },
      runGit,
    })

    assert.equal(checkpoint.sourceCommit, head, '冻结的应当是本任务分支的 HEAD')
    assert.deepEqual(checkpoint.paths, [], '没有登记产物 ⇒ 路径清单为空（而不是编一个）')
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('★ 没有产物且工作区脏：拒绝并说清两条出路（未提交改动不在 HEAD 里）', () => {
  const taskId = 'T-checkpoint-head-dirty'
  const workspaceDir = createTaskWorktree(taskId)
  try {
    writeFileSync(join(workspaceDir, 'workbench-uncommitted.mjs'), 'export const loose = true\n')
    assert.throws(() => commitAcceptedWorkflowArtifacts({
      taskId,
      stageId: 'implement',
      workspaceDir,
      artifacts: [],
      resolveArtifact: () => { throw new Error('空产物表不该去解析产物') },
      runGit,
    }), /没有已登记的文件产物，且工作区还有 1 处未提交改动[\s\S]*先提交这些改动或登记对应产物/)
    assert.equal(git(workspaceDir, ['status', '--porcelain=v1', '--untracked-files=all']), '?? workbench-uncommitted.mjs', '拒绝时不得动工作区')
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('★ 没有产物且不在本任务分支：仍拒绝（冻结的是「这一阶段的产物」，不是随便一个 HEAD）', () => {
  const taskId = 'T-checkpoint-head-branch'
  const workspaceDir = createTaskWorktree(taskId)
  try {
    git(workspaceDir, ['symbolic-ref', 'HEAD', 'refs/heads/other'])
    assert.throws(() => commitAcceptedWorkflowArtifacts({
      taskId,
      stageId: 'implement',
      workspaceDir,
      artifacts: [],
      resolveArtifact: () => { throw new Error('空产物表不该去解析产物') },
      runGit,
    }), /阶段工作区分支错误：期望 w\/T-checkpoint-head-branch，实际 other/)
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('human acceptance freezes only the registered workflow artifact into a verifiable task commit', () => {
  const taskId = 'T-checkpoint'
  const workspaceDir = createTaskWorktree(taskId)
  try {
    mkdirSync(join(workspaceDir, 'docs'), { recursive: true })
    const content = '# Requirements\n\nReady for implementation.\n'
    const absolutePath = join(workspaceDir, 'docs', 'REQUIREMENTS.md')
    writeFileSync(absolutePath, content)
    writeFileSync(join(workspaceDir, 'docs', 'NOT_REGISTERED.md'), 'Leave this file out of the checkpoint.\n')
    const digest = createHash('sha256').update(content).digest('hex')

    const checkpoint = commitAcceptedWorkflowArtifacts({
      taskId,
      stageId: 'design',
      workspaceDir,
      artifacts: [{ kind: 'file', path: 'docs/REQUIREMENTS.md', digest }],
      resolveArtifact: () => ({ abs: absolutePath, rel: 'docs/REQUIREMENTS.md', source: 'worktree' }),
      runGit,
    })

    assert.match(checkpoint.sourceCommit, /^[0-9a-f]{40,64}$/)
    assert.equal(git(workspaceDir, ['rev-parse', 'HEAD']), checkpoint.sourceCommit)
    assert.equal(git(workspaceDir, ['show', `${checkpoint.sourceCommit}:docs/REQUIREMENTS.md`]), content.trimEnd())
    assert.equal(git(workspaceDir, ['status', '--porcelain=v1', '--untracked-files=all']), '?? docs/NOT_REGISTERED.md')
    assert.deepEqual(checkpoint.paths, ['docs/REQUIREMENTS.md'])
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('human acceptance refuses a changed artifact digest before creating a commit', () => {
  const taskId = 'T-checkpoint-digest'
  const workspaceDir = createTaskWorktree(taskId)
  try {
    mkdirSync(join(workspaceDir, 'docs'), { recursive: true })
    const absolutePath = join(workspaceDir, 'docs', 'REQUIREMENTS.md')
    writeFileSync(absolutePath, '# Changed after registration\n')
    assert.throws(() => commitAcceptedWorkflowArtifacts({
      taskId,
      stageId: 'design',
      workspaceDir,
      artifacts: [{ kind: 'file', path: 'docs/REQUIREMENTS.md', digest: 'a'.repeat(64) }],
      resolveArtifact: () => ({ abs: absolutePath, rel: 'docs/REQUIREMENTS.md', source: 'worktree' }),
      runGit,
    }), /阶段产物摘要已变化/)
    assert.equal(git(workspaceDir, ['rev-parse', 'HEAD']), git(workspaceDir, ['rev-parse', `refs/heads/w/${taskId}`]))
    assert.equal(git(workspaceDir, ['status', '--porcelain=v1', '--untracked-files=all']), '?? docs/REQUIREMENTS.md')
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('human acceptance refuses a pre-staged unregistered file', () => {
  const taskId = 'T-checkpoint-staged'
  const workspaceDir = createTaskWorktree(taskId)
  try {
    mkdirSync(join(workspaceDir, 'docs'), { recursive: true })
    const absolutePath = join(workspaceDir, 'docs', 'REQUIREMENTS.md')
    const content = '# Requirements\n'
    writeFileSync(absolutePath, content)
    writeFileSync(join(workspaceDir, 'README.md'), 'Unregistered staged change.\n')
    git(workspaceDir, ['add', 'README.md'])
    assert.throws(() => commitAcceptedWorkflowArtifacts({
      taskId,
      stageId: 'design',
      workspaceDir,
      artifacts: [{ kind: 'file', path: 'docs/REQUIREMENTS.md', digest: createHash('sha256').update(content).digest('hex') }],
      resolveArtifact: () => ({ abs: absolutePath, rel: 'docs/REQUIREMENTS.md', source: 'worktree' }),
      runGit,
    }), /未登记的暂存改动/)
    assert.equal(git(workspaceDir, ['diff', '--cached', '--name-only']), 'README.md')
    assert.equal(git(workspaceDir, ['rev-parse', 'HEAD']), git(workspaceDir, ['rev-parse', `refs/heads/w/${taskId}`]))
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})


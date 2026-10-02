import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeWorkflowCheckpoints, WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX } from './agent-workflow-checkpoints.mjs'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function checkedGit(cwd, args) {
  const result = git(cwd, args)
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.err || result.out}`)
  return result.out.trim()
}

async function repoFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-checkpoints-'))
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  checkedGit(root, ['init'])
  checkedGit(root, ['config', 'user.email', 'legion-test@example.com'])
  checkedGit(root, ['config', 'user.name', 'legion-test'])
  await writeFile(join(root, 'seed.txt'), 'base\n')
  checkedGit(root, ['add', 'seed.txt'])
  checkedGit(root, ['commit', '-m', 'base'])
  return root
}

function checkpoint(stageId, sourceCommit) {
  return { by: stageId, at: new Date().toISOString(), text: `${WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX}${JSON.stringify({ stageId, sourceCommit })}` }
}

test('downstream worktree imports immutable design and implementation commits in ancestor order', async (t) => {
  const root = await repoFixture(t)
  const design = join(root, 'design')
  checkedGit(root, ['worktree', 'add', '-b', 'w/design', design, 'HEAD'])
  await mkdir(join(design, 'docs'), { recursive: true })
  await writeFile(join(design, 'docs', 'design.md'), 'design v1\n')
  checkedGit(design, ['add', 'docs/design.md'])
  checkedGit(design, ['commit', '-m', 'design'])
  const designCommit = checkedGit(design, ['rev-parse', 'HEAD'])

  const implementation = join(root, 'implementation')
  checkedGit(root, ['worktree', 'add', '-b', 'w/implementation', implementation, 'HEAD'])
  await materializeWorkflowCheckpoints({
    workdir: implementation,
    runGit: async (cwd, args) => git(cwd, args),
    workflowContext: { upstreamStages: [{ stageId: 'design', taskId: 'task-design', evidence: [checkpoint('design', designCommit)] }] },
  })
  assert.equal((await readFile(join(implementation, 'docs', 'design.md'), 'utf8')).replaceAll('\r\n', '\n'), 'design v1\n')
  checkedGit(implementation, ['merge-base', '--is-ancestor', designCommit, 'HEAD'])
  await writeFile(join(implementation, 'app.txt'), 'implemented from design\n')
  checkedGit(implementation, ['add', 'app.txt'])
  checkedGit(implementation, ['commit', '-m', 'implementation'])
  const implementationCommit = checkedGit(implementation, ['rev-parse', 'HEAD'])

  const review = join(root, 'review')
  checkedGit(root, ['worktree', 'add', '-b', 'w/review', review, 'HEAD'])
  const merged = await materializeWorkflowCheckpoints({
    workdir: review,
    runGit: async (cwd, args) => git(cwd, args),
    workflowContext: { upstreamStages: [
      { stageId: 'implementation', taskId: 'task-implementation', evidence: [checkpoint('implementation', implementationCommit)] },
      { stageId: 'design', taskId: 'task-design', evidence: [checkpoint('design', designCommit)] },
    ] },
  })
  assert.deepEqual(merged.map((item) => item.stageId), ['design', 'implementation'])
  assert.equal((await readFile(join(review, 'docs', 'design.md'), 'utf8')).replaceAll('\r\n', '\n'), 'design v1\n')
  assert.equal((await readFile(join(review, 'app.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'implemented from design\n')
  checkedGit(review, ['merge-base', '--is-ancestor', implementationCommit, 'HEAD'])
})

test('a missing or malformed upstream checkpoint is rejected before execution', async (t) => {
  const root = await repoFixture(t)
  const out = await materializeWorkflowCheckpoints({
    workdir: root, runGit: async (cwd, args) => git(cwd, args),
    workflowContext: { upstreamStages: [{ stageId: 'design', taskId: 'task-design', evidence: [] }] },
  }).then(() => null, (error) => error)
  assert.match(String(out), /缺少有效的冻结 Git 提交证据/)
})

test('conflicting upstream import is rolled back and reported', async (t) => {
  const root = await repoFixture(t)
  const design = join(root, 'design')
  checkedGit(root, ['worktree', 'add', '-b', 'w/design-conflict', design, 'HEAD'])
  await writeFile(join(design, 'seed.txt'), 'design\n')
  checkedGit(design, ['add', 'seed.txt'])
  checkedGit(design, ['commit', '-m', 'design change'])
  const designCommit = checkedGit(design, ['rev-parse', 'HEAD'])

  const downstream = join(root, 'downstream')
  checkedGit(root, ['worktree', 'add', '-b', 'w/downstream', downstream, 'HEAD'])
  await writeFile(join(downstream, 'seed.txt'), 'downstream\n')
  checkedGit(downstream, ['add', 'seed.txt'])
  checkedGit(downstream, ['commit', '-m', 'downstream change'])

  await assert.rejects(materializeWorkflowCheckpoints({
    workdir: downstream, runGit: async (cwd, args) => git(cwd, args),
    workflowContext: { upstreamStages: [{ stageId: 'design', taskId: 'task-design', evidence: [checkpoint('design', designCommit)] }] },
  }), /导入上游阶段 design 的冻结提交失败（合并已回滚）/)
  assert.equal(checkedGit(downstream, ['status', '--porcelain']), '')
  assert.equal((await readFile(join(downstream, 'seed.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'downstream\n')
})

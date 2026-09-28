// team-hub/git-plumbing.test.mjs —— S3（R-4 / 方案 A / I-9）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, revParse, currentHead, isAncestor, isWorktreeClean, mergeTree, commitTree, updateRef, fastForwardCheckedOut } from './git-plumbing.mjs'

function initRepo(tag) {
  const repo = mkdtempSync(join(tmpdir(), 'legion-s3-' + tag + '-'))
  assert.equal(runGit(['init', '-q', '-b', 'main'], repo).status, 0)
  runGit(['config', 'user.email', 't170@example.invalid'], repo)
  runGit(['config', 'user.name', 'T-170'], repo)
  return repo
}
function commitFile(repo, name, content, message) {
  writeFileSync(join(repo, name), content)
  runGit(['add', name], repo)
  const r = runGit(['commit', '-q', '-m', message], repo)
  assert.equal(r.status, 0, 'commit 失败: ' + r.stderr)
  return currentHead(repo)
}

test('TC-S3-08 非管道 stdio：git 输出可捕获（默认管道在本沙箱会 EPERM）', () => {
  const repo = initRepo('io')
  const head = commitFile(repo, 'a.txt', 'a\n', 'init')
  const r = runGit(['rev-parse', '--short', 'HEAD'], repo)
  assert.equal(r.status, 0)
  assert.equal(r.error, null)
  assert.equal(r.stdout.trim(), head.slice(0, 7))
})

test('TC-S3-08b merge-tree --write-tree 干净退出 0、内容冲突退出 1 可区分', () => {
  const repo = initRepo('merge')
  commitFile(repo, 'same.txt', 'base\n', 'base')
  const base = currentHead(repo)
  // 分支 A
  runGit(['checkout', '-q', '-b', 'feat-a'], repo)
  commitFile(repo, 'only-a.txt', 'a\n', 'a')
  const aSha = currentHead(repo)
  // 分支 B：同一文件不同内容 -> 冲突
  runGit(['checkout', '-q', 'main'], repo)
  commitFile(repo, 'same.txt', 'main-side\n', 'main-side')
  const mainSha = currentHead(repo)
  runGit(['checkout', '-q', 'feat-a'], repo)
  commitFile(repo, 'same.txt', 'feat-side\n', 'feat-side')
  const conflictSha = currentHead(repo)

  const clean = mergeTree(repo, mainSha, aSha)
  assert.equal(clean.ok, true)
  assert.ok(clean.treeOid && clean.treeOid.length >= 40)

  const conflicted = mergeTree(repo, mainSha, conflictSha)
  assert.equal(conflicted.ok, false)
  assert.equal(conflicted.code, 'GIT_CONFLICT')

  // base 处二者祖先关系
  assert.equal(isAncestor(repo, base, aSha), true)
})

test('TC-S3-09 commit-tree 第一父等于 expected_head', () => {
  const repo = initRepo('ct')
  const head = commitFile(repo, 'a.txt', 'a\n', 'init')
  const truth = runGit(['rev-parse', head + '^{tree}'], repo).stdout.trim()
  const made = commitTree(repo, truth, [head], 'candidate')
  assert.equal(made.ok, true)
  const firstParent = runGit(['rev-parse', made.commit + '^1'], repo).stdout.trim()
  assert.equal(firstParent, head)
  assert.equal(isAncestor(repo, made.commit, 'HEAD'), false, '候选提交此刻不应已接入目标 ref')
})

test('TC-S3-10 merge-base --is-ancestor 可判是否已应用', () => {
  const repo = initRepo('anc')
  const head = commitFile(repo, 'a.txt', 'a\n', 'init')
  assert.equal(isAncestor(repo, head, 'HEAD'), true)
  assert.equal(isAncestor(repo, 'HEAD', head), true)
})

test('TC-S3-09b update-ref 的 CAS：expectedOld 不符时拒绝', () => {
  const repo = initRepo('cas')
  const head = commitFile(repo, 'a.txt', 'a\n', 'init')
  const tree = runGit(['rev-parse', head + '^{tree}'], repo).stdout.trim()
  const candidate = commitTree(repo, tree, [head], 'cand').commit
  const wrong = updateRef(repo, 'refs/heads/main', candidate, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  assert.equal(wrong.ok, false)
  assert.equal(currentHead(repo), head, 'CAS 失败不得移动 ref')
  const good = updateRef(repo, 'refs/heads/main', candidate, head)
  assert.equal(good.ok, true)
  assert.equal(currentHead(repo), candidate)
})

test('TC-S3-16 工作区脏检测把未跟踪文件也算脏', () => {
  const repo = initRepo('dirty')
  commitFile(repo, 'a.txt', 'a\n', 'init')
  assert.equal(isWorktreeClean(repo).clean, true)
  writeFileSync(join(repo, 'untracked.txt'), 'x\n')
  const dirty = isWorktreeClean(repo)
  assert.equal(dirty.clean, false)
  assert.ok(dirty.reasons.some((l) => l.includes('untracked.txt')))
})

test('从绑定子目录检查时也覆盖完整仓库的本地改动', () => {
  const repo = initRepo('subdir-dirty')
  commitFile(repo, 'a.txt', 'a\n', 'init')
  const subdir = join(repo, 'package')
  mkdirSync(subdir)
  writeFileSync(join(repo, 'outside.txt'), 'local\n')
  const result = isWorktreeClean(subdir)
  assert.equal(result.clean, false)
  assert.ok(result.reasons.some((reason) => reason.includes('outside.txt')))
})

test('集成快进同时更新已检出的文件和索引，且拒绝脏工作区', () => {
  const repo = initRepo('checked-out-ff')
  const old = commitFile(repo, 'a.txt', 'old\n', 'base')
  runGit(['checkout', '-q', '-b', 'task'], repo)
  const candidate = commitFile(repo, 'a.txt', 'new\n', 'task')
  runGit(['checkout', '-q', 'main'], repo)
  assert.equal(fastForwardCheckedOut(repo, 'refs/heads/main', candidate, old).ok, true)
  assert.equal(currentHead(repo), candidate)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').replaceAll('\r\n', '\n'), 'new\n')
  assert.equal(isWorktreeClean(repo).clean, true)

  writeFileSync(join(repo, 'a.txt'), 'user change\n')
  const refusal = fastForwardCheckedOut(repo, 'refs/heads/main', candidate, candidate)
  assert.equal(refusal.ok, false)
  assert.equal(refusal.code, 'DIRTY_WORKSPACE')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'user change\n')
})

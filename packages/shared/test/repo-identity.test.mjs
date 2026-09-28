// packages/shared/test/repo-identity.test.mjs —— S1（R-7 / R-4 / D-P4）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoIdFromCommonDir, detectRepoCapability, probeRepoFacts, defaultRunGit, resolveRepoIdentity } from '../src/repo-identity.mjs'

test('TC-S1-12 两个 worktree 的 common-dir 归一到同一 repoId（大小写/尾斜杠归一）', () => {
  const a = repoIdFromCommonDir('D:/repo/.git')
  const b = repoIdFromCommonDir('D:/repo/.git/')
  const c = repoIdFromCommonDir('d:/repo/.git')
  const d = repoIdFromCommonDir('D:\\repo\\.git\\')
  assert.equal(a, b)
  assert.equal(a, c)
  assert.equal(a, d)
  assert.equal(repoIdFromCommonDir(''), null)
  assert.equal(repoIdFromCommonDir(null), null)
})

test('TC-S1-13 非 Git / Git 不可用 / 不可规范化 -> degraded + 可读原因 + 单写', () => {
  for (const facts of [
    { isGit: false, gitAvailable: false, commonDir: null },
    { isGit: true, gitAvailable: false, commonDir: 'D:/repo/.git' },
    { isGit: true, gitAvailable: true, commonDir: null },
  ]) {
    const r = detectRepoCapability(facts)
    assert.equal(r.capability, 'degraded')
    assert.equal(r.singleWriterRequired, true)
    assert.equal(r.readOnlyAllowed, true)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  }
})

test('TC-S1-13b 正常 Git 仓库能力为 git 且不强制单写', () => {
  const r = detectRepoCapability({ isGit: true, gitAvailable: true, commonDir: 'D:/repo/.git' })
  assert.equal(r.capability, 'git')
  assert.equal(r.repoId, 'd:/repo/.git')
  assert.equal(r.singleWriterRequired, false)
  assert.equal(r.readOnlyAllowed, true)
})

test('TC-S1-11b 判定是纯函数：同事实同输出，事实注入不触盘', () => {
  const facts = { isGit: true, gitAvailable: true, commonDir: 'X:/r/.git' }
  assert.deepEqual(detectRepoCapability(facts), detectRepoCapability(facts))
  assert.equal(Object.isFrozen(detectRepoCapability(facts)), true)
})

test('TC-S1-12b 临时仓库实测 git rev-parse --git-common-dir（非管道 stdio 捕获）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'legion-s1-repo-'))
  const init = defaultRunGit(['init', '-q', '-b', 'main'], repo)
  assert.equal(init.status, 0, 'git init 失败: ' + init.stderr)
  const facts = probeRepoFacts(repo, { runGit: defaultRunGit })
  assert.equal(facts.isGit, true)
  assert.equal(facts.gitAvailable, true)
  assert.ok(typeof facts.commonDir === 'string' && facts.commonDir.length > 0)
  const resolved = resolveRepoIdentity(repo, { runGit: defaultRunGit })
  assert.equal(resolved.capability, 'git')
  assert.ok(typeof resolved.repoId === 'string' && resolved.repoId.length > 0)
})

test('TC-S1-13c 非 Git 目录降级且原因可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-s1-nongit-'))
  const facts = probeRepoFacts(dir, { runGit: defaultRunGit })
  const cap = detectRepoCapability(facts)
  assert.equal(cap.capability, 'degraded')
  assert.equal(cap.singleWriterRequired, true)
  assert.ok(cap.reason.length > 0)
})

test('物理仓库与其 worktree 的相对 common-dir 解析成同一身份', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-repo-binding-'))
  const repo = join(root, 'repo')
  const wt = join(root, 'wt')
  assert.equal(defaultRunGit(['init', '-q', '-b', 'main', repo], root).status, 0)
  defaultRunGit(['config', 'user.email', 'test@example.invalid'], repo)
  defaultRunGit(['config', 'user.name', 'Test'], repo)
  writeFileSync(join(repo, 'a.txt'), 'a')
  defaultRunGit(['add', 'a.txt'], repo)
  assert.equal(defaultRunGit(['commit', '-qm', 'init'], repo).status, 0)
  assert.equal(defaultRunGit(['worktree', 'add', '-q', '-b', 'other', wt], repo).status, 0)
  const a = resolveRepoIdentity(repo)
  const b = resolveRepoIdentity(wt)
  assert.equal(a.repoId, b.repoId)
  assert.notEqual(a.repoId, '.git')
})

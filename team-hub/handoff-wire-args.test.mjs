// team-hub/handoff-wire-args.test.mjs
// ---------------------------------------------------------------------------
// 冻结 argv 里的脚本路径解析（2026-10-30 现场）。
//
// 为什么要有这一条：工作流定义里冻结的 implement runner 是
// `node scripts/ci/verify-changed.mjs`（相对路径），而**接手提交早于该脚本入仓**
// ⇒ worktree 里没有这个文件 ⇒ MODULE_NOT_FOUND ⇒ 结算失败。
// 验证脚本属于**现在的工具链**，不属于被接手的那个提交，所以：worktree 里有就用它，
// 没有就回退到仓库根下的同一路径。
//
// 运行：node --test team-hub/handoff-wire-args.test.mjs
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRunnerArgs } from './handoff-hub-wire.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-args-'))
  const repo = join(root, 'repo')
  const worktree = join(root, 'wt')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(repo, 'scripts', 'verify.mjs'), '// repo tooling\n')
  return { root, repo, worktree }
}

test('① worktree 里有脚本：用 worktree 里的那份（被接手提交自带工具链）', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.worktree, 'scripts'), { recursive: true })
    writeFileSync(join(f.worktree, 'scripts', 'verify.mjs'), '// from that commit\n')
    const args = resolveRunnerArgs(['scripts/verify.mjs', '--x'], { cwd: f.worktree, repoRoot: f.repo })
    assert.equal(args[0], join(f.worktree, 'scripts', 'verify.mjs'))
    assert.deepEqual(args.slice(1), ['--x'], '其余参数必须原样保留')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('② worktree 里没有（接手提交早于脚本入仓）：回退到仓库根下的同一路径', () => {
  const f = fixture()
  try {
    const args = resolveRunnerArgs(['scripts/verify.mjs'], { cwd: f.worktree, repoRoot: f.repo })
    assert.equal(args[0], join(f.repo, 'scripts', 'verify.mjs'))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('③ 两处都没有 / 已是绝对路径：原样返回（不猜、不造路径）', () => {
  const f = fixture()
  try {
    const missing = ['nope/missing.mjs']
    assert.deepEqual(resolveRunnerArgs(missing, { cwd: f.worktree, repoRoot: f.repo }), missing)
    const abs = [join(f.repo, 'scripts', 'verify.mjs')]
    assert.deepEqual(resolveRunnerArgs(abs, { cwd: f.worktree, repoRoot: f.repo }), abs)
    assert.deepEqual(resolveRunnerArgs([], { cwd: f.worktree, repoRoot: f.repo }), [])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// team-hub/git-plumbing.mjs
// ============================================================================
// 沙箱安全的 git 接缝（并行任务文件冲突治理 S3 / R-4 / I-9）
//
// 本机（沙箱）实测：Node 以**默认管道 stdio** spawn 子进程会 EPERM；
// 因此本模块**所有** git 调用都把 stdout/stderr 指向临时文件描述符再读回。
// 这不是风格问题：用管道的那版在 CI 上会得到 status=null + error.code=EPERM，
// 而调用方看到的是"git 没输出"，很容易被读成"没什么可合并"。
//
// 只做接缝：解析 argv 结果，不决定业务语义（语义在 delivery-store / integration-worker）。
// ============================================================================
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function readSafe(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** 非管道 stdio 运行 git；返回 { status, error, stdout, stderr, ok }。 */
export function runGit(args, cwd, { env = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-git-'))
  const out = join(dir, 'out.txt')
  const err = join(dir, 'err.txt')
  const ofd = openSync(out, 'w')
  const efd = openSync(err, 'w')
  let status = null
  let error = null
  try {
    const r = spawnSync('git', args, {
      cwd,
      stdio: ['ignore', ofd, efd],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    })
    status = r.status
    error = r.error ? r.error.code : null
  } finally {
    closeSync(ofd)
    closeSync(efd)
  }
  const stdout = readSafe(out)
  const stderr = readSafe(err)
  return Object.freeze({ status, error, stdout, stderr, ok: status === 0 && error === null })
}

export function revParse(repo, rev) {
  const r = runGit(['rev-parse', '--verify', '--quiet', rev], repo)
  return r.ok ? r.stdout.trim() : null
}

export function currentHead(repo) {
  return revParse(repo, 'HEAD')
}

export function isAncestor(repo, ancestor, descendant) {
  return runGit(['merge-base', '--is-ancestor', ancestor, descendant], repo).status === 0
}

/** 绑定工作区是否整体干净（未提交与未跟踪改动都算脏）。 */
export function isWorktreeClean(repo) {
  const top = runGit(['rev-parse', '--show-toplevel'], repo)
  if (!top.ok || !top.stdout.trim()) return Object.freeze({ clean: false, reasons: ['无法确认完整工作区根目录'] })
  const r = runGit(['status', '--porcelain=v1', '--untracked-files=all'], top.stdout.trim())
  if (!r.ok) return Object.freeze({ clean: false, reasons: ['git status 失败：' + (r.stderr || r.error || 'unknown')] })
  const lines = r.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  return Object.freeze({ clean: lines.length === 0, reasons: Object.freeze(lines) })
}

/**
 * 用 merge-tree --write-tree 在**不触碰工作区**的前提下生成候选合并树。
 * @returns {{ok:true,treeOid:string,conflicts:[]}|{ok:false,code:'GIT_CONFLICT'|'GIT_ERROR',treeOid:string|null,conflicts:string[],stderr:string}}
 */
export function mergeTree(repo, ours, theirs) {
  const r = runGit(['merge-tree', '--write-tree', ours, theirs], repo)
  if (r.ok) {
    const tree = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? null
    return Object.freeze({ ok: true, treeOid: tree, conflicts: Object.freeze([]) })
  }
  if (r.status === 1) {
    return Object.freeze({
      ok: false,
      code: 'GIT_CONFLICT',
      treeOid: null,
      conflicts: Object.freeze(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)),
      stderr: r.stderr.trim(),
    })
  }
  return Object.freeze({
    ok: false, code: 'GIT_ERROR', treeOid: null,
    conflicts: Object.freeze([]), stderr: (r.stderr || String(r.error || '')).trim(),
  })
}

/**
 * 生成候选提交。parents[0] **必须**是 expected_head（设计 §6.2 第 6 条）。
 */
export function commitTree(repo, treeOid, parents, message, { env = null, author = null } = {}) {
  const args = ['commit-tree', treeOid]
  for (const parent of parents) args.push('-p', parent)
  if (author) args.push('-m', message, '--author', author)
  else args.push('-m', message)
  const r = runGit(args, repo, { env })
  if (!r.ok) return Object.freeze({ ok: false, code: 'COMMIT_TREE_FAILED', stderr: r.stderr.trim(), commit: null })
  return Object.freeze({ ok: true, commit: r.stdout.trim(), stderr: r.stderr.trim() })
}

/** 仅允许快进的 ref 更新；expectedOld 不符则 git 自己拒绝（CAS）。 */
export function updateRef(repo, ref, newSha, expectedOld = null) {
  const args = ['update-ref', ref, newSha]
  if (expectedOld) args.push(expectedOld)
  const r = runGit(args, repo)
  return Object.freeze({ ok: r.ok, status: r.status, stderr: r.stderr.trim() })
}

/**
 * Fast-forward the branch checked out in the bound workspace. `update-ref`
 * alone leaves its index and files at the old commit, which makes a delivery
 * appear integrated while the user still sees the old code.
 */
export function fastForwardCheckedOut(workspace, targetRef, newSha, expectedOld) {
  const checkedOut = runGit(['symbolic-ref', '-q', 'HEAD'], workspace)
  if (!checkedOut.ok || checkedOut.stdout.trim() !== targetRef) {
    return Object.freeze({ ok: false, code: 'TARGET_NOT_CHECKED_OUT', stderr: checkedOut.stderr.trim() })
  }
  const head = currentHead(workspace)
  if (head !== expectedOld) return Object.freeze({ ok: false, code: 'HEAD_ADVANCED', currentHead: head })
  const clean = isWorktreeClean(workspace)
  if (!clean.clean) return Object.freeze({ ok: false, code: 'DIRTY_WORKSPACE', reasons: clean.reasons })
  if (!isAncestor(workspace, expectedOld, newSha)) {
    return Object.freeze({ ok: false, code: 'NON_FAST_FORWARD' })
  }
  const applied = runGit(['merge', '--ff-only', '--no-stat', newSha], workspace)
  if (!applied.ok) return Object.freeze({ ok: false, code: 'FAST_FORWARD_FAILED', stderr: applied.stderr.trim() })
  const actual = currentHead(workspace)
  if (actual !== newSha || !isWorktreeClean(workspace).clean) {
    return Object.freeze({ ok: false, code: 'APPLY_UNVERIFIED', currentHead: actual })
  }
  return Object.freeze({ ok: true, currentHead: actual })
}

export function worktreeAdd(repo, dir, ref, { detach = true } = {}) {
  const args = ['worktree', 'add']
  if (detach) args.push('--detach')
  args.push(dir, ref)
  const r = runGit(args, repo)
  return Object.freeze({ ok: r.ok, stderr: r.stderr.trim(), dir })
}

export function worktreeRemove(repo, dir, { force = true } = {}) {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(dir)
  const r = runGit(args, repo)
  return Object.freeze({ ok: r.ok, stderr: r.stderr.trim() })
}

export function fetch(repo, remote, refspec) {
  const r = runGit(['fetch', remote, refspec], repo)
  return Object.freeze({ ok: r.ok, stderr: r.stderr.trim() })
}

// packages/shared/src/repo-identity.mjs
// ============================================================================
// 仓库身份与能力探测（并行任务文件冲突治理 S1 / R-4 · R-7）
//
// 设计 §4：仓库身份取**规范化的 Git common-dir 实路径**，不能只按空间 ID 判断，
// 因为多个空间可能绑定同一仓库，而同一仓库必须共用一个路径占用池与集成锁。
//
// 判定部分是**纯函数**（事实由调用方注入，或由 probeRepoFacts 用非管道 stdio 取得）；
// 这样「非 Git / Git 不可用 / 无法规范化」三条降级分支都能在单测里直接构造。
//
// 沙箱纪律：Node 以默认管道 stdio spawn 子进程在本机返回 EPERM，故默认 runner
// 一律把 stdout/stderr 写进临时文件描述符再读回。
// ============================================================================
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPO_CAPABILITIES = Object.freeze({ GIT: 'git', DEGRADED: 'degraded' })

function readSafe(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** 默认 git runner：非管道 stdio + 临时文件捕获（沙箱 EPERM 纪律）。 */
export function defaultRunGit(args, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-repo-id-'))
  const out = join(dir, 'out.txt')
  const err = join(dir, 'err.txt')
  const ofd = openSync(out, 'w')
  const efd = openSync(err, 'w')
  let status = null
  let error = null
  try {
    const r = spawnSync('git', args, { cwd, stdio: ['ignore', ofd, efd], windowsHide: true })
    status = r.status
    error = r.error ? r.error.code : null
  } finally {
    closeSync(ofd)
    closeSync(efd)
  }
  return Object.freeze({ status, error, stdout: readSafe(out), stderr: readSafe(err) })
}

/**
 * 把 common-dir 归一为稳定的仓库身份：分隔符统一、去尾斜杠、盘符小写。
 */
export function repoIdFromCommonDir(commonDir) {
  const s = String(commonDir ?? '').trim()
  if (s === '') return null
  let p = s.replace(/\\/g, '/')
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  p = p.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':')
  return p
}

function degraded(reason, facts) {
  return Object.freeze({
    capability: REPO_CAPABILITIES.DEGRADED,
    repoId: repoIdFromCommonDir(facts?.commonDir),
    reason,
    readOnlyAllowed: true,
    singleWriterRequired: true,
  })
}

/**
 * 由**探测事实**判定仓库能力（纯函数）。
 * @param {{isGit:boolean,gitAvailable:boolean,commonDir:string|null}} facts
 */
export function detectRepoCapability(facts = {}) {
  const repoId = repoIdFromCommonDir(facts.commonDir)
  if (facts.isGit !== true) {
    return degraded('该目录不是 Git 工作区：首版禁止并行写入，仅允许一个写入任务（只读任务不受限）', facts)
  }
  if (facts.gitAvailable !== true) {
    return degraded('Git 不可用：无法建立隔离工作区，降级为单写入（只读任务不受限）', facts)
  }
  if (repoId === null) {
    return degraded('无法解析 Git common-dir：仓库身份不可确认，降级为单写入', facts)
  }
  return Object.freeze({
    capability: REPO_CAPABILITIES.GIT,
    repoId,
    reason: null,
    readOnlyAllowed: true,
    singleWriterRequired: false,
  })
}

/** 只读任务是否受写入限制（设计 §12：只读任务不受限，且不申请预约）。 */
export function readOnlyAllowed() {
  return true
}

/**
 * 采集仓库事实。runGit 可注入（测试里用替身）。
 */
export function probeRepoFacts(cwd, { runGit } = {}) {
  const git = typeof runGit === 'function' ? runGit : defaultRunGit
  const inside = git(['rev-parse', '--is-inside-work-tree'], cwd)
  const gitAvailable = inside.status !== null && inside.status !== undefined && inside.error == null
  const isGit = gitAvailable && inside.status === 0 && String(inside.stdout).trim() === 'true'
  let commonDir = null
  if (isGit) {
    const c = git(['rev-parse', '--git-common-dir'], cwd)
    if (c.status === 0) commonDir = String(c.stdout).trim() || null
  }
  return Object.freeze({ isGit, gitAvailable, commonDir })
}

/** 一站式：探测 + 判定。 */
export function resolveRepoIdentity(cwd, { runGit } = {}) {
  return detectRepoCapability(probeRepoFacts(cwd, { runGit }))
}

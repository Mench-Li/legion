// product/update/cache.mjs
// ============================================================================
// 下载缓存 —— 设计 §6（line 140）的四句话，逐句落地
//
//   「下载写入 CacheDir 的 `.part` 文件，流式限制大小并计算摘要；下载完成
//     及签名检查通过后原子改名。」
//       → `.part` 与正式文件**同目录同名**，只多一个后缀。这样"改名"是同卷
//          rename（原子），而不是跨目录拷贝（可以中途失败）。
//
//   「首期中断后重新下载完整包，不承诺续传。」
//       → 启动时清理所有 `.part`。这不是"顺手打扫"：留着它们会让"缓存里有
//         一个半截文件"看起来像"缓存可以复用"，而真正的后果是把半个包交给
//         解压器。
//
//   「用户可取消下载，取消不影响当前程序。」
//       → 取消 = 删除 `.part`，不碰任何已就绪文件、不碰程序目录。所以本模块
//         的 `discard` 只接受 `.part` 路径，拒绝删除已提交的产物——一条
//         "取消把已经下好的包删掉了"的实现会让用户重下一次几百 MB。
//
//   「重启后保留有效缓存，重新校验后复用。」
//       → `verifyReady` **每次都重算摘要**。不重算的复用等于信任"上次写完
//         之后没人动过它"，而 Windows 上的磁盘清理、杀毒隔离、用户手工
//         删除都会让这个假设在某一台机器上不成立。
//
// ## 目录布局
//
//   <cacheDir>/
//     downloads/<releaseId>/<文件名>          已校验、可复用
//     downloads/<releaseId>/<文件名>.part     下载中
//
// 一发行一目录，是因为"候选以 releaseId、版本和发行摘要共同标识"（设计 §6
// line 138）：不同 releaseId 的同名文件必须能有各自的位置，否则"同版本不同
// 字节"的两个发行会互相覆盖。
// ============================================================================

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { validateRelativePath } from './release.mjs'

export const PART_SUFFIX = '.part'

export const CACHE_CODES = Object.freeze({
  MISSING: 'cache-missing',
  CORRUPT: 'cache-corrupt',
  SIZE_MISMATCH: 'cache-size-mismatch',
  BAD_PATH: 'cache-bad-path',
  REFUSED: 'cache-refused',
})

function cacheResult(ok, code, reason, extra = {}) {
  return Object.freeze({ ok, code: ok ? null : code, reason, ...extra })
}

/** 缓存里一个产物的相对位置：`downloads/<releaseId>/<文件名>`。 */
export function cacheRelativePath(releaseId, artifactPath) {
  const check = validateRelativePath(releaseId, { field: 'releaseId', allowSubdirDepth: 0 })
  if (!check.ok) return null
  // ★ 先按**完整路径**过一遍发布侧的路径判据，再取最后一段。
  //
  //   只取 `basename` 会把 `releases/rel-1/../../x.zip` 静默"吸收"成
  //   `x.zip`——结果虽然是安全的，但它把一份**本该被拒绝**的路径变成了
  //   可用输入。缓存的职责不是替清单兜底，所以这里先拒，再取段。
  const full = validateRelativePath(artifactPath, { field: 'artifact.path', allowSubdirDepth: 5 })
  if (!full.ok) return null
  const name = basename(artifactPath)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.endsWith(PART_SUFFIX)) return null
  return `downloads/${releaseId}/${name}`
}

function absolute(cacheDir, relative) {
  if (relative === null) return null
  const full = join(cacheDir, relative)
  // 双保险：拼出来的绝对路径必须仍在 cacheDir 之内。
  const root = cacheDir.endsWith('/') || cacheDir.endsWith('\\') ? cacheDir : `${cacheDir}${process.platform === 'win32' ? '\\' : '/'}`
  return full.startsWith(root) ? full : null
}

/**
 * 建立缓存句柄。
 *
 * @param {object} args
 * @param {string} args.cacheDir
 * @param {(path: string) => Promise<string|null>} args.hashFileOnDisk
 * @param {(path: string) => number|null} [args.sizeOfFile]
 * @param {Function} [args.now]
 */
export function createDownloadCache({
  cacheDir, hashFileOnDisk, sizeOfFile = defaultSizeOfFile, now = () => Date.now(),
} = {}) {
  if (typeof cacheDir !== 'string' || cacheDir === '') throw new Error('createDownloadCache 需要 cacheDir')
  if (typeof hashFileOnDisk !== 'function') throw new Error('createDownloadCache 需要 hashFileOnDisk')

  function readyPath(releaseId, artifactPath) {
    const relative = cacheRelativePath(releaseId, artifactPath)
    return absolute(cacheDir, relative)
  }

  function partPathFor(ready) {
    return ready === null ? null : `${ready}${PART_SUFFIX}`
  }

  return Object.freeze({
    cacheDir,
    readyPath,
    partPathFor,

    /** 下载开始前：确保目录存在，并返回这一对路径。 */
    plan(releaseId, artifactPath) {
      const ready = readyPath(releaseId, artifactPath)
      if (ready === null) {
        return cacheResult(false, CACHE_CODES.BAD_PATH,
          `无法把 (${releaseId}, ${artifactPath}) 映射到缓存路径`)
      }
      mkdirSync(dirname(ready), { recursive: true })
      return cacheResult(true, null, null, { readyPath: ready, partPath: partPathFor(ready) })
    },

    /**
     * 复用一个已就绪的产物。**每次都重算摘要**（见文件头）。
     *
     * 结论分四种，调用方必须区别对待：
     *   · `ok`       → 可以直接用；
     *   · `missing`  → 没下过，去下；
     *   · `corrupt`  → 下过但内容不对，**删掉**再下（不删会让下次仍然读到它）；
     *   · `mismatch` → 大小或摘要与本次清单不符（换过发行），删掉再下。
     */
    async verifyReady(releaseId, artifactPath, { sizeBytes, sha256 } = {}) {
      const ready = readyPath(releaseId, artifactPath)
      if (ready === null) return cacheResult(false, CACHE_CODES.BAD_PATH, '产物路径无法映射到缓存路径')
      if (!existsSync(ready)) return cacheResult(false, CACHE_CODES.MISSING, '缓存中没有这个产物', { path: ready })
      const size = sizeOfFile(ready)
      if (size === null) return cacheResult(false, CACHE_CODES.MISSING, '缓存文件读不到大小', { path: ready })
      if (Number.isSafeInteger(sizeBytes) && size !== sizeBytes) {
        // ★ 大小不符时删掉。留着它只会在下一次检查里再被判一次不符。
        rmSync(ready, { force: true })
        return cacheResult(false, CACHE_CODES.SIZE_MISMATCH,
          `缓存文件 ${size} 字节，清单声明 ${sizeBytes}：已删除，将重新下载`, { path: ready, size, expected: sizeBytes })
      }
      const actual = await hashFileOnDisk(ready)
      if (actual === null) return cacheResult(false, CACHE_CODES.MISSING, '缓存文件在计算摘要时消失', { path: ready })
      if (typeof sha256 === 'string' && actual !== sha256) {
        rmSync(ready, { force: true })
        return cacheResult(false, CACHE_CODES.CORRUPT,
          `缓存文件摘要不符（清单 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）：已删除，将重新下载`,
          { path: ready, sha256: actual, expected: sha256 })
      }
      return cacheResult(true, null, null, { path: ready, size, sha256: actual, reused: true })
    },

    /** 提交：`verifyReady` 之前的原子改名。只对 `.part` 生效。 */
    commit(partPath, ready) {
      if (typeof partPath !== 'string' || typeof ready !== 'string' || !partPath.endsWith(PART_SUFFIX)) {
        return cacheResult(false, CACHE_CODES.REFUSED, 'commit 只接受 (xxx.part → xxx)')
      }
      try {
        mkdirSync(dirname(ready), { recursive: true })
        renameSync(partPath, ready)
        return cacheResult(true, null, null, { path: ready })
      } catch (error) {
        return cacheResult(false, CACHE_CODES.REFUSED, `改名失败：${error?.message ?? error}`)
      }
    },

    /**
     * 取消/失败时丢弃。**只删 `.part`**。
     *
     * 一条"取消时把已就绪的包一起删掉"的实现在功能上"也能跑"，
     * 但它把用户的一次犹豫变成了几百 MB 的重新下载。
     */
    discard(partPath) {
      if (typeof partPath !== 'string' || !partPath.endsWith(PART_SUFFIX)) {
        return cacheResult(false, CACHE_CODES.REFUSED, 'discard 只接受 .part 路径')
      }
      try { rmSync(partPath, { force: true }) } catch (error) {
        return cacheResult(false, CACHE_CODES.REFUSED, `删除失败：${error?.message ?? error}`)
      }
      return cacheResult(true, null, null, { path: partPath })
    },

    /**
     * 启动清理：删掉所有 `.part`（设计 §6：中断后重新下载完整包，不承诺续传）。
     *
     * 同时删掉**空目录**——一个只有一个空目录的缓存看起来像"有东西"。
     */
    sweepStaleParts() {
      const removed = []
      const downloads = join(cacheDir, 'downloads')
      if (!existsSync(downloads)) return cacheResult(true, null, null, { removed: Object.freeze([]) })
      for (const releaseDir of safeReaddir(downloads)) {
        const dir = join(downloads, releaseDir)
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
        let remaining = 0
        for (const entry of entries) {
          if (!entry.isFile()) { remaining += 1; continue }
          if (!entry.name.endsWith(PART_SUFFIX)) { remaining += 1; continue }
          const path = join(dir, entry.name)
          try { rmSync(path, { force: true }); removed.push(path) } catch { remaining += 1 }
        }
        if (remaining === 0) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力清理 */ } }
      }
      return cacheResult(true, null, null, { removed: Object.freeze(removed) })
    },

    /** 已就绪产物的字节总量（界面展示与预算用）。 */
    usage() {
      const downloads = join(cacheDir, 'downloads')
      let total = 0
      const releases = []
      if (!existsSync(downloads)) return Object.freeze({ bytes: 0, releases: Object.freeze([]) })
      for (const releaseDir of safeReaddir(downloads)) {
        const dir = join(downloads, releaseDir)
        let bytes = 0
        let mtimeMs = 0
        for (const entry of safeReaddirWithTypes(dir)) {
          if (!entry.isFile() || entry.name.endsWith(PART_SUFFIX)) continue
          try {
            const info = statSync(join(dir, entry.name))
            bytes += info.size
            mtimeMs = Math.max(mtimeMs, info.mtimeMs)
          } catch { /* 跳过读不到的条目 */ }
        }
        total += bytes
        releases.push(Object.freeze({ releaseId: releaseDir, bytes, mtimeMs }))
      }
      return Object.freeze({ bytes: total, releases: Object.freeze(releases) })
    },

    /**
     * 清理旧发行目录。
     *
     * `keep` 是**必须保留**的 releaseId 集合（当前候选、正在下载的、当前
     * 安装版本用到的）。`keep` 里的目录永远不会被删——即使它超过保留期。
     * 这条保护不是可选的：一次"清理把正在安装的包删了"会让安装事务在
     * 第 7 步（解压）失败，而那时数据已经备份过了。
     */
    prune({ keep = [], maxAgeMs = 30 * 24 * 60 * 60 * 1000, maxBytes = null, nowMs = now() } = {}) {
      const keepSet = new Set(keep)
      const usage = this.usage()
      const removed = []
      const candidates = usage.releases
        .filter((entry) => !keepSet.has(entry.releaseId))
        .sort((a, b) => a.mtimeMs - b.mtimeMs)

      let remainingBytes = usage.bytes
      for (const entry of candidates) {
        const expired = maxAgeMs !== null && nowMs - entry.mtimeMs > maxAgeMs
        const overBudget = maxBytes !== null && remainingBytes > maxBytes
        if (!expired && !overBudget) continue
        try {
          rmSync(join(cacheDir, 'downloads', entry.releaseId), { recursive: true, force: true })
          removed.push(entry.releaseId)
          remainingBytes -= entry.bytes
        } catch { /* 下次启动再试 */ }
      }
      return cacheResult(true, null, null, {
        removed: Object.freeze(removed), bytes: remainingBytes > 0 ? remainingBytes : 0,
        kept: Object.freeze([...keepSet]),
      })
    },
  })
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function safeReaddirWithTypes(dir) {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

function defaultSizeOfFile(path) {
  try { return statSync(path).size } catch { return null }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckCache() {
  const problems = []
  if (PART_SUFFIX !== '.part') problems.push('未完成文件后缀不是 .part')

  if (cacheRelativePath('rel-1', 'releases/rel-1/legion-win-x64.zip') !== 'downloads/rel-1/legion-win-x64.zip') {
    problems.push(`缓存相对路径不对：${cacheRelativePath('rel-1', 'releases/rel-1/legion-win-x64.zip')}`)
  }
  // releaseId / 文件名里的危险形态必须映射不出来。
  for (const [releaseId, artifact] of [
    ['../escape', 'releases/a/x.zip'],
    ['rel-1', 'releases/rel-1/../../x.zip'],
    ['rel-1', 'releases/rel-1/x.zip.part'],
    ['rel-1', 'releases/rel-1/'],
    ['', 'releases/a/x.zip'],
  ]) {
    if (cacheRelativePath(releaseId, artifact) !== null) {
      problems.push(`危险形态映射出了缓存路径：${releaseId} / ${artifact}`)
    }
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    partSuffix: PART_SUFFIX,
  })
}

export const CACHE_CHECKED = selfCheckCache()

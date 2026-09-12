// product/upgrade/backup.mjs
// ============================================================================
// PRT-806 / PRT-812：数据库与配置自动备份、**备份保留**与定期恢复演练
//
// spec §9.4 line 722：升级流程的第二步是「备份数据库和配置」。
// spec §9.4 line 737：「升级前备份至少保留最近 3 个成功快照和 30 天，取更大者；
//   每个 stable 候选版本必须在干净机器和真实备份副本上完成自动恢复演练，
//   产品进入稳定运营后至少每季度抽样执行一次恢复演练。」
//
// ## 一、备份不校验，等于没有备份
//
// 一个只做 `copyFileSync` 的备份，与一个备份，在"能不能恢复"上的区别是：
// 后者**被验证过**。而验证只在恢复的那一刻发生，也就是在最不方便的时刻
// 才发现"这份备份从三个月前就是坏的"。
//
//   > 一个"复制了文件就算备份完成"的备份，
//   > 与一个"恢复时才发现文件是坏的"的备份，是同一个东西——
//   > 只不过前者现在报的是成功。
//
// 所以每个快照在写完的那一刻**复算**每个文件的摘要并落成 `snapshot.json`，
// 而 `restoreSnapshot` 在落盘**之前**逐文件对账；对不上就整份拒收，
// 不产生"恢复了一半"的中间态。
//
// ## 二、保留策略不是"删掉旧的"
//
// spec 的"至少保留最近 3 个成功快照和 30 天，**取更大者**"是一句**并集**：
// 按时间窗口留下的，与按数量留下的，合起来都要留。写成"先按时间删、再保证 3 个"
// 会让一台闲置两周的机器上只剩 1 份备份——而它恰好是最可能被恢复的那种机器。
//
// 另一个必须带上的读数是 `underRetained`：**保留得不够不是"通过"**。
// 一台新装机器的策略执行结果永远"没有可删的"，这与"保留策略满足"不是一个读数。
//
// ## 三、恢复演练必须留下"什么时候演练过"
//
// 只提供 `restoreDrill()` 的模块，与一个"从来没有演练过"的模块，
// 在"上一季度到底演练了没有"这个问题上是同一个东西——因为没人记录。
// 所以演练写一条 `drills/<时间戳>.json`，而 `drillStatus()` 读这些文件算过期与否。
// ============================================================================

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashFile, listFiles, toPackagePath } from './package.mjs'

/** 快照格式版本。 */
export const BACKUP_FORMAT = 'legion/backup-snapshot@1'

/** spec §9.4 line 737 的两条硬下限。 */
export const BACKUP_POLICY_DEFAULTS = Object.freeze({
  /** 至少保留最近 N 个**成功**快照。 */
  minCount: 3,
  /** 至少保留最近 N 天内的成功快照。 */
  minAgeDays: 30,
  /** 恢复演练的间隔（天）。spec：「至少每季度抽样执行一次」。 */
  drillIntervalDays: 90,
})

/** 一份快照自身的状态。只有 `complete` 能被恢复。 */
export const SNAPSHOT_STATUSES = Object.freeze(['complete', 'partial', 'failed'])

export const BACKUP_CODES = Object.freeze({
  SNAPSHOT_OK: 'backup-snapshot-ok',
  /** 备份源不存在——**不是**"没有数据要备份"。 */
  SOURCE_MISSING: 'backup-source-missing',
  /** 备份读不到/写不进。 */
  IO_FAILED: 'backup-io-failed',
  /** 复盘时发现某个文件的摘要对不上。 */
  SNAPSHOT_CORRUPT: 'backup-snapshot-corrupt',
  /** 快照目录里缺 `snapshot.json`。 */
  SNAPSHOT_UNREADABLE: 'backup-snapshot-unreadable',
  /** 快照状态不是 `complete`。 */
  SNAPSHOT_NOT_COMPLETE: 'backup-snapshot-not-complete',
  /** 目标是空的：空备份不是备份。 */
  SNAPSHOT_EMPTY: 'backup-snapshot-empty',
})

function backupError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 时间戳文件名要用**文件系统安全**的形态：Windows 不许 `:` 出现在文件名里。 */
export function snapshotId(atMs) {
  return new Date(atMs).toISOString().replace(/[:.]/g, '-')
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

/**
 * 把一棵树拷进快照，并记录**相对快照根**的路径。
 *
 * `prefix` 不是装饰：`collected` 里的路径会同时被用于"复算摘要"和"恢复到哪儿"，
 * 因此它必须是快照根的相对路径。用 `relative(source, abs)` 得到的是相对
 * **数据目录**的路径（`team.db`），恢复时就找不到它——而失败会伪装成
 * "快照损坏"，让人去查一份其实完好的备份。
 */
function copyTree(source, dest, prefix, collected) {
  for (const abs of listFiles(source)) {
    const rel = toPackagePath(source, abs)
    const target = join(dest, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(abs, target)
    collected.push(Object.freeze({
      path: `${prefix}/${rel}`, sha256: hashFile(target), size: statSync(target).size,
    }))
  }
}

/**
 * 建一份快照。
 *
 * @param {object} args
 * @param {string} args.backupDir   备份根目录（须在安装目录之外，否则升级会连带替换它）
 * @param {string} [args.dataDir]   team-hub 数据库所在的数据目录
 * @param {string} [args.configPath] 产品配置文件
 * @param {number} [args.nowMs]
 * @param {string} [args.label]     人类可读的来源标注（如 `pre-upgrade 0.8.0→0.9.0`）
 * @returns {{snapshot: object, files: ReadonlyArray<object>, ok: boolean}}
 */
export function createSnapshot({
  backupDir, dataDir = null, configPath = null, nowMs = Date.now(), label = null,
} = {}) {
  if (typeof backupDir !== 'string' || backupDir.trim() === '') {
    throw backupError(BACKUP_CODES.IO_FAILED, 'createSnapshot 需要 backupDir')
  }
  const id = snapshotId(nowMs)
  const root = join(backupDir, 'snapshots', id)

  // 源一个都不存在时**不建空快照**。
  //   > 一个"没有东西可备份所以成功"的备份，
  //   > 与一个"用户把数据目录配错了、于是三个月没有备份"的备份，
  //   > 是同一个东西——只不过前者每次都报成功。
  const hasData = dataDir !== null && existsSync(dataDir)
  const hasConfig = configPath !== null && existsSync(configPath)
  if (!hasData && !hasConfig) {
    return Object.freeze({
      ok: false,
      code: BACKUP_CODES.SOURCE_MISSING,
      snapshot: Object.freeze({
        format: BACKUP_FORMAT, id, status: 'failed', createdAtMs: nowMs, label,
        dataDir, configPath, files: Object.freeze([]),
      }),
      files: Object.freeze([]),
      reason: '数据目录与配置文件都不存在：空备份与"没有数据要备份"必须分开',
    })
  }

  mkdirSync(root, { recursive: true })
  const files = []
  try {
    if (hasData) copyTree(dataDir, join(root, 'data'), 'data', files)
    if (hasConfig) {
      const dest = join(root, 'config', 'product.config.json')
      mkdirSync(join(dest, '..'), { recursive: true })
      copyFileSync(configPath, dest)
      files.push(Object.freeze({
        path: 'config/product.config.json', sha256: hashFile(dest), size: statSync(dest).size,
      }))
    }
  } catch (e) {
    // 失败快照**留下**状态，而不是删掉。删掉之后"上一次备份失败"这件事
    // 在磁盘上不留任何痕迹，而保留策略会把它当成"这一轮没有快照"。
    const failed = Object.freeze({
      format: BACKUP_FORMAT, id, status: 'failed', createdAtMs: nowMs, label,
      dataDir, configPath, files: Object.freeze(files), error: String(e?.message ?? e),
    })
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'snapshot.json'), JSON.stringify(failed, null, 2) + '\n', 'utf8')
    } catch { /* 尽力而为 */ }
    return Object.freeze({
      ok: false, code: BACKUP_CODES.IO_FAILED, snapshot: failed, files: Object.freeze(files),
      reason: `写快照失败：${e?.message ?? e}`,
    })
  }

  const snapshot = Object.freeze({
    format: BACKUP_FORMAT,
    id,
    status: 'complete',
    createdAtMs: nowMs,
    label,
    dataDir,
    configPath,
    fileCount: files.length,
    totalBytes: files.reduce((a, f) => a + f.size, 0),
    files: Object.freeze(files),
  })
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  return Object.freeze({ ok: true, code: BACKUP_CODES.SNAPSHOT_OK, snapshot, files: Object.freeze(files), reason: null })
}

/** 列出全部快照（含失败的），按创建时间**升序**。 */
export function listSnapshots(backupDir) {
  const base = join(backupDir, 'snapshots')
  if (!existsSync(base)) return Object.freeze([])
  const out = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const meta = join(base, entry.name, 'snapshot.json')
    if (!existsSync(meta)) {
      // 缺描述文件的目录**不静默跳过**：它是一条"这里曾经想写一份快照"的证据。
      out.push(Object.freeze({
        id: entry.name, status: 'unreadable', createdAtMs: 0, fileCount: 0, totalBytes: 0,
        root: join(base, entry.name), code: BACKUP_CODES.SNAPSHOT_UNREADABLE,
      }))
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(meta, 'utf8'))
    } catch {
      parsed = null
    }
    if (parsed === null) {
      out.push(Object.freeze({
        id: entry.name, status: 'unreadable', createdAtMs: 0, fileCount: 0, totalBytes: 0,
        root: join(base, entry.name), code: BACKUP_CODES.SNAPSHOT_UNREADABLE,
      }))
      continue
    }
    out.push(Object.freeze({
      id: parsed.id ?? entry.name,
      status: parsed.status ?? 'unreadable',
      createdAtMs: parsed.createdAtMs ?? 0,
      fileCount: parsed.fileCount ?? (parsed.files?.length ?? 0),
      totalBytes: parsed.totalBytes ?? 0,
      label: parsed.label ?? null,
      root: join(base, entry.name),
      code: parsed.status === 'complete' ? null : BACKUP_CODES.SNAPSHOT_NOT_COMPLETE,
    }))
  }
  return Object.freeze(out.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}

// ---------------------------------------------------------------------------
// 保留策略（PRT-812）
// ---------------------------------------------------------------------------

/**
 * 按 spec line 737 计算每份快照的去向。
 *
 * 判定分三段，顺序即优先级：
 *   ① 非 `complete` 的一律**不保留**（它们恢复不了，留着只会让人以为有备份）；
 *   ② 最近 `minAgeDays` 天内的**成功**快照全部保留（时间窗口）；
 *   ③ 再按数量补足到 `minCount`（数量下限）。
 *
 * `underRetained` 是**独立读数**：窗口与数量都不满足时它非空。
 * 一台新装机器的保留策略执行结果永远是"没有可清理的"，那与"策略满足"不是同一个读数。
 */
export function planRetention(snapshots, { nowMs = Date.now(), policy = BACKUP_POLICY_DEFAULTS } = {}) {
  const minCount = policy.minCount
  const minAgeMs = policy.minAgeDays * 24 * 60 * 60 * 1000
  const complete = snapshots.filter((s) => s.status === 'complete')
  const sortedDesc = [...snapshots].sort((a, b) => b.createdAtMs - a.createdAtMs)
  const completeDesc = [...complete].sort((a, b) => b.createdAtMs - a.createdAtMs)

  const inWindow = completeDesc.filter((s) => nowMs - s.createdAtMs <= minAgeMs)
  const keptIds = new Set(inWindow.map((s) => s.id))
  for (const s of completeDesc) {
    if (keptIds.size >= minCount) break
    keptIds.add(s.id)
  }

  const decisions = sortedDesc.map((s) => {
    if (s.status !== 'complete') {
      return Object.freeze({ id: s.id, status: s.status, keep: false, reason: `状态是 ${s.status}：恢复不了的快照留着会让人以为有备份` })
    }
    if (inWindow.some((w) => w.id === s.id)) {
      return Object.freeze({ id: s.id, status: s.status, keep: true, reason: `在最近 ${policy.minAgeDays} 天窗口内` })
    }
    if (keptIds.has(s.id)) {
      return Object.freeze({ id: s.id, status: s.status, keep: true, reason: `时间窗口内不足 ${minCount} 份，按数量下限保留` })
    }
    return Object.freeze({ id: s.id, status: s.status, keep: false, reason: `既在 ${policy.minAgeDays} 天窗口外，也不在最近 ${minCount} 份之内` })
  })

  const retainedComplete = decisions.filter((d) => d.keep).length
  const underReasons = []
  if (retainedComplete < minCount) {
    underReasons.push(`成功快照只有 ${retainedComplete} 份，少于下限 ${minCount} 份`)
  }
  const oldest = completeDesc[completeDesc.length - 1] ?? null
  if (oldest === null || nowMs - oldest.createdAtMs < minAgeMs) {
    underReasons.push(`最旧的成功快照不足 ${policy.minAgeDays} 天`)
  }

  return Object.freeze({
    policy,
    nowMs,
    decisions: Object.freeze(decisions),
    keep: Object.freeze(decisions.filter((d) => d.keep).map((d) => d.id)),
    prune: Object.freeze(decisions.filter((d) => !d.keep).map((d) => d.id)),
    counts: Object.freeze({
      total: snapshots.length,
      complete: complete.length,
      retained: retainedComplete,
      inWindow: inWindow.length,
    }),
    underRetained: underReasons.length > 0,
    underReasons: Object.freeze(underReasons),
  })
}

/** 按计划实际删除 `prune` 里的快照目录（**只删目录，不删别的**）。 */
export function applyRetention(backupDir, plan, { dryRun = false } = {}) {
  const removed = []
  const snapshots = listSnapshots(backupDir)
  for (const id of plan.prune) {
    const s = snapshots.find((x) => x.id === id)
    if (s === undefined) continue
    if (!dryRun) rmSync(s.root, { recursive: true, force: true })
    removed.push(id)
  }
  return Object.freeze({ removed: Object.freeze(removed), dryRun })
}

// ---------------------------------------------------------------------------
// 恢复（PRT-806）
// ---------------------------------------------------------------------------

/**
 * 从快照恢复。
 *
 * ★ **先逐文件对账，再落盘。** 顺序是有代价的：恢复过程中失败会留下
 * "目标目录里一半是旧数据、一半是新数据"，而那不是任何一个已知状态。
 *
 * ★ 本函数**只恢复数据目录与配置**，不恢复程序（那由 switchover 负责）。
 * 这一点必须写在这里而不只是写在文档里——"回滚"这个词在两个人嘴里
 * 常常一个是数据、一个是程序。
 */
export function restoreSnapshot(snapshotRoot, { dataDir, configPath = null, verify = true } = {}) {
  const metaPath = join(snapshotRoot, 'snapshot.json')
  if (!existsSync(metaPath)) {
    return Object.freeze({
      ok: false, code: BACKUP_CODES.SNAPSHOT_UNREADABLE, restored: Object.freeze([]),
      reason: `快照目录里没有 snapshot.json：${snapshotRoot}`,
    })
  }
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (e) {
    return Object.freeze({
      ok: false, code: BACKUP_CODES.SNAPSHOT_UNREADABLE, restored: Object.freeze([]),
      reason: `快照描述无法解析：${e.message}`,
    })
  }
  if (meta.status !== 'complete') {
    return Object.freeze({
      ok: false, code: BACKUP_CODES.SNAPSHOT_NOT_COMPLETE, restored: Object.freeze([]),
      reason: `快照状态是 ${meta.status}，不是 complete：这份快照本身就是一次失败的记录`,
    })
  }
  if (!Array.isArray(meta.files) || meta.files.length === 0) {
    return Object.freeze({
      ok: false, code: BACKUP_CODES.SNAPSHOT_EMPTY, restored: Object.freeze([]),
      reason: '快照的文件清单是空的：空恢复与"恢复成功"必须分开',
    })
  }

  // ① 对账（落盘之前）。
  const mismatches = []
  if (verify) {
    for (const f of meta.files) {
      const abs = join(snapshotRoot, ...f.path.split('/'))
      if (!existsSync(abs)) {
        mismatches.push(Object.freeze({ path: f.path, kind: 'missing', expected: f.sha256, observed: null }))
        continue
      }
      const actual = hashFile(abs)
      if (actual !== f.sha256) {
        mismatches.push(Object.freeze({ path: f.path, kind: 'hash-mismatch', expected: f.sha256, observed: actual }))
      }
    }
  }
  if (mismatches.length > 0) {
    return Object.freeze({
      ok: false, code: BACKUP_CODES.SNAPSHOT_CORRUPT, restored: Object.freeze([]),
      mismatches: Object.freeze(mismatches),
      reason: `${mismatches.length} 个文件与快照记录对不上：这份快照不能再用来恢复`,
    })
  }

  // ② 落盘。
  //
  // ★ 写回 `.db` 之前必须先删掉它旁边的 `-wal` / `-shm`（PRT-006 已定的那条纪律）。
  //
  //   SQLite 的 WAL 是**属于那个 .db 文件**的：`-wal` 里存的是"尚未合并进主库的
  //   提交"。把一个旧的 `.db` 拷回去、却把升级期间产生的 `-wal` 留在原地，下一次
  //   打开数据库时 SQLite 会把那份**属于新结构的 WAL 重放到旧文件上**——结果是
  //   一个既不是备份时刻、也不是升级之后的第三个状态，而且它**能打开**。
  //
  //   > 一个"只把 .db 拷回来"的恢复，
  //   > 与一个"把两个不同时刻的数据库合并"的恢复，是同一个东西——
  //   > 只不过前者的名字叫「恢复成功」。
  //
  //   删除本身也要留痕：恢复之后被删掉的那两个文件是排障时唯一能解释
  //   "为什么升级期间的写入不见了"的证据。
  const sidecars = []
  for (const f of meta.files) {
    if (!f.path.startsWith('data/')) continue
    const rel = f.path.slice('data/'.length)
    if (!rel.endsWith('.db')) continue
    const dest = join(dataDir, ...rel.split('/'))
    for (const suffix of ['-wal', '-shm']) {
      const side = `${dest}${suffix}`
      if (existsSync(side)) {
        rmSync(side, { force: true })
        sidecars.push(Object.freeze({ path: side, reason: 'WAL/shm 属于被替换掉的那个 .db，留下它就是把两个时刻合并' }))
      }
    }
  }

  const restored = []
  try {
    mkdirSync(dataDir, { recursive: true })
    for (const f of meta.files) {
      if (f.path.startsWith('data/')) {
        const rel = f.path.slice('data/'.length)
        const dest = join(dataDir, ...rel.split('/'))
        mkdirSync(join(dest, '..'), { recursive: true })
        copyFileSync(join(snapshotRoot, ...f.path.split('/')), dest)
        restored.push(Object.freeze({ path: dest, from: f.path }))
      } else if (f.path === 'config/product.config.json' && configPath !== null) {
        mkdirSync(join(configPath, '..'), { recursive: true })
        copyFileSync(join(snapshotRoot, ...f.path.split('/')), configPath)
        restored.push(Object.freeze({ path: configPath, from: f.path }))
      }
    }
  } catch (e) {
    return Object.freeze({
      ok: false, code: BACKUP_CODES.IO_FAILED, restored: Object.freeze(restored),
      sidecarsRemoved: Object.freeze(sidecars),
      reason: `恢复过程中写失败：${e.message}（已经落盘的部分不是任何一个已知状态）`,
    })
  }

  return Object.freeze({
    ok: true, code: BACKUP_CODES.SNAPSHOT_OK, restored: Object.freeze(restored),
    // 被删掉的 -wal/-shm。空数组与"没有检查"也是两件事，所以它是一个**存在**的读数。
    sidecarsRemoved: Object.freeze(sidecars),
    snapshotId: meta.id, createdAtMs: meta.createdAtMs, reason: null,
  })
}

// ---------------------------------------------------------------------------
// 恢复演练（PRT-812）
// ---------------------------------------------------------------------------

/** 演练记录目录名。 */
export const DRILL_DIRNAME = 'drills'

/**
 * 一次恢复演练。
 *
 * 演练**恢复到一个临时目录**，不是原地恢复——原地演练会在真实数据目录上
 * 做一次真实的覆盖，而演练的目的恰好是"在不弄坏现场的前提下知道能不能恢复"。
 *
 * `verify` 是必填的：没有校验的演练只会报"文件复制成功"，而"文件复制成功"
 * 与"恢复出来的数据库能打开"是两件事。
 *
 * @param {object} args
 * @param {string} args.backupDir
 * @param {string} args.scratchDir  演练目标（每次调用方给一个新的空目录）
 * @param {(ctx: {dataDir: string, configPath: string|null}) => ({ok: boolean, detail?: string})} args.verify
 */
export function restoreDrill({
  backupDir, scratchDir, verify, nowMs = Date.now(), snapshotId: wantedId = null, label = null,
} = {}) {
  if (typeof verify !== 'function') {
    throw backupError(
      'backup-drill-verify-required',
      '恢复演练必须提供 verify 回调：没有校验的演练只会报"文件复制成功"，' +
      '而"文件复制成功"与"恢复出来的数据库能打开"是两件事',
    )
  }
  const complete = listSnapshots(backupDir).filter((s) => s.status === 'complete')
  const chosen = wantedId === null ? complete[complete.length - 1] ?? null : complete.find((s) => s.id === wantedId) ?? null
  if (chosen === null) {
    const record = Object.freeze({
      kind: 'legion/restore-drill@1', atMs: nowMs, label,
      snapshotId: wantedId, outcome: 'no-snapshot',
      detail: '没有任何 complete 快照可供演练：演练失败不是因为恢复有问题，而是因为没有可恢复的备份',
    })
    writeDrillRecord(backupDir, nowMs, record)
    return Object.freeze({ ok: false, outcome: 'no-snapshot', record, reason: record.detail })
  }

  const target = join(scratchDir, 'drill')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const dataDir = join(target, 'data')
  const configPath = join(target, 'product.config.json')

  const restored = restoreSnapshot(chosen.root, { dataDir, configPath })
  if (!restored.ok) {
    const record = Object.freeze({
      kind: 'legion/restore-drill@1', atMs: nowMs, label, snapshotId: chosen.id,
      outcome: 'restore-failed', detail: restored.reason,
    })
    writeDrillRecord(backupDir, nowMs, record)
    return Object.freeze({ ok: false, outcome: 'restore-failed', record, reason: restored.reason })
  }

  let verified
  try {
    verified = verify({ dataDir, configPath })
  } catch (e) {
    verified = { ok: false, detail: `校验回调抛错：${e?.message ?? e}` }
  }
  const okVerdict = verified?.ok === true
  const record = Object.freeze({
    kind: 'legion/restore-drill@1',
    atMs: nowMs,
    label,
    snapshotId: chosen.id,
    snapshotCreatedAtMs: chosen.createdAtMs,
    outcome: okVerdict ? 'ok' : 'verify-failed',
    // ★ 只记 verify **返回了 ok: true**，不记"没有报错"。
    detail: verified?.detail ?? (okVerdict ? '校验回调返回 ok' : '校验回调没有返回 ok'),
  })
  writeDrillRecord(backupDir, nowMs, record)
  return Object.freeze({ ok: okVerdict, outcome: record.outcome, record, reason: record.detail })
}

function writeDrillRecord(backupDir, nowMs, record) {
  const dir = join(backupDir, DRILL_DIRNAME)
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${snapshotId(nowMs)}.json`)
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
    return file
  } catch {
    return null
  }
}

/** 读出全部演练记录（按时间升序）。 */
export function listDrills(backupDir) {
  const dir = join(backupDir, DRILL_DIRNAME)
  if (!existsSync(dir)) return Object.freeze([])
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(Object.freeze(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
    } catch { /* 坏记录不静默：下面的 stale 判定会把它当成"没有记录" */ }
  }
  return Object.freeze(out.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0)))
}

/**
 * 演练是否过期。
 *
 * ★ 只统计 `outcome === 'ok'` 的演练。一次"复制了文件但校验失败"的演练，
 * 与一次通过的演练，在"能不能恢复"上是相反的两件事；把它们都算作"演练过"
 * 会让这条读数在**最该报警的时候**（上一次演练失败）显示为新鲜。
 *
 *   > 一个把"演练失败"也算作"演练过了"的新鲜度读数，
 *   > 与一个"演练从来没有真正成功过"的读数，是同一个东西——
 *   > 只不过前者是绿的。
 */
export function drillStatus(backupDir, { nowMs = Date.now(), policy = BACKUP_POLICY_DEFAULTS } = {}) {
  const drills = listDrills(backupDir)
  const succeeded = drills.filter((d) => d.outcome === 'ok')
  const last = succeeded[succeeded.length - 1] ?? null
  const lastAny = drills[drills.length - 1] ?? null
  const dueMs = last === null ? null : (last.atMs ?? 0) + policy.drillIntervalDays * 24 * 60 * 60 * 1000
  const stale = last === null || nowMs >= dueMs
  return Object.freeze({
    drillIntervalDays: policy.drillIntervalDays,
    totalDrills: drills.length,
    succeededDrills: succeeded.length,
    lastSuccessAtMs: last?.atMs ?? null,
    lastAnyAtMs: lastAny?.atMs ?? null,
    lastAnyOutcome: lastAny?.outcome ?? null,
    dueAtMs: dueMs,
    stale,
    reasons: Object.freeze(stale
      ? [last === null
        ? (drills.length === 0
          ? `从来没有恢复演练记录：${policy.drillIntervalDays} 天一次的要求下，没有记录与"逾期"是同一个读数`
          : `有 ${drills.length} 次演练记录但没有一次成功（最近一次：${lastAny?.outcome ?? '未知'}）`)
        : `上一次成功的演练在 ${new Date(last.atMs).toISOString()}，已超过 ${policy.drillIntervalDays} 天`]
      : []),
  })
}

// ---------------------------------------------------------------------------
// 装载期自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：在一个临时目录里真的走一遍"备份 → 恢复"，并把每一格判据
 * **两侧**都跑出来。
 *
 * 本模块的每一格都是一个"能不能说不"的问题，所以自检的样本也成对给：
 *
 *   · 源存在 → 快照 `complete`；源不存在 → 拒绝建快照（空备份不是备份）；
 *   · 快照完好 → 恢复 `ok`；快照被改过 → `backup-snapshot-corrupt`；
 *   · 恢复时旁边有 `-wal` → 它被删掉且被记下来；
 *   · 保留策略不满足 → `underRetained` 为真（"没有可清理的"不是"策略满足"）；
 *   · 只有失败的演练记录 → `stale` 为真（演练失败不算演练过）。
 *
 * 后两格尤其要紧：把它们的样本换成"一台闲置机器"，两条读数都会是绿的，
 * 而绿的原因是这个样本**根本触发不到**那一格。
 *
 *   > 一个只在宽松样本上跑过的自检，
 *   > 与一个把 `problems` 写死成空数组的自检，是同一个东西。
 */
export function selfCheckBackup() {
  const problems = []
  const scratch = mkdtempSync(join(tmpdir(), 'legion-backup-selfcheck-'))
  try {
    const dataDir = join(scratch, 'data')
    const configPath = join(scratch, 'product.config.json')
    const backupDir = join(scratch, 'backup')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'team.db'), 'SELF-CHECK-V1', 'utf8')
    writeFileSync(configPath, '{}', 'utf8')

    const empty = createSnapshot({ backupDir, dataDir: join(scratch, '不存在'), nowMs: 0 })
    if (empty.ok !== false) problems.push('源不存在时本该拒绝建快照（空备份不是备份）')

    const made = createSnapshot({ backupDir, dataDir, configPath, nowMs: 1000 })
    if (made.ok !== true || made.snapshot.status !== 'complete') problems.push(`自检快照没建成：${made.reason}`)
    const snapshotRoot = join(backupDir, 'snapshots', made.snapshot.id)

    // 恢复：先放一个属于**旧主库**的 -wal 在旁边。
    writeFileSync(join(dataDir, 'team.db'), 'SELF-CHECK-V2', 'utf8')
    writeFileSync(join(dataDir, 'team.db-wal'), 'WAL', 'utf8')
    const restored = restoreSnapshot(snapshotRoot, { dataDir, configPath })
    if (restored.ok !== true) problems.push(`恢复本该成功：${restored.reason}`)
    if (readFileSync(join(dataDir, 'team.db'), 'utf8') !== 'SELF-CHECK-V1') problems.push('恢复后主库内容不是快照时刻的那一份')
    if (existsSync(join(dataDir, 'team.db-wal'))) problems.push('恢复后 -wal 还在：它会被重放到旧主库上')
    if (restored.sidecarsRemoved.length === 0) problems.push('删掉了 -wal 却没有把它记下来')

    // 负数格：改掉快照里的一个字节，恢复必须拒绝。
    const target = join(snapshotRoot, 'data', 'team.db')
    const keep = readFileSync(target, 'utf8')
    writeFileSync(target, '被改过', 'utf8')
    const corrupt = restoreSnapshot(snapshotRoot, { dataDir, configPath })
    writeFileSync(target, keep, 'utf8')
    if (corrupt.ok !== false || corrupt.code !== BACKUP_CODES.SNAPSHOT_CORRUPT) {
      problems.push(`损坏的快照本该报 ${BACKUP_CODES.SNAPSHOT_CORRUPT}，实际 ${corrupt.code}`)
    }

    // 保留：一份、且最旧的还不到 30 天 → 不足。
    const thin = planRetention(listSnapshots(backupDir), { nowMs: 1000, policy: BACKUP_POLICY_DEFAULTS })
    if (thin.underRetained !== true) problems.push('只有一份且不到 30 天的快照时 underRetained 本该为真')
    // ★ 这一格必须让"窗口"与"数量"**都**满足，否则它测的只是其中一条。
    //   最旧那份 40 天前（≥30 天窗口），一共 3 份（≥3 份下限）。
    const DAY_MS = 24 * 60 * 60 * 1000
    const rich = planRetention(
      [0, 20 * DAY_MS, 39 * DAY_MS].map((t) => ({ id: `s${t}`, createdAtMs: t, status: 'complete' })),
      { nowMs: 40 * DAY_MS, policy: BACKUP_POLICY_DEFAULTS },
    )
    if (rich.underRetained !== false) problems.push(`满足数量与窗口时 underRetained 本该为假：${rich.underReasons.join('；')}`)
    if (rich.counts.retained < BACKUP_POLICY_DEFAULTS.minCount) problems.push('满足条件的样本里保留份数少于下限')

    // 演练新鲜度：只有失败记录 → stale。
    const drillDir = join(backupDir, DRILL_DIRNAME)
    mkdirSync(drillDir, { recursive: true })
    writeFileSync(
      join(drillDir, '2026-01-02T03-04-05-000Z.json'),
      JSON.stringify({ outcome: 'verify-failed', atMs: 0 }), 'utf8',
    )
    const stale = drillStatus(backupDir, { nowMs: 1000 })
    if (stale.stale !== true || stale.succeededDrills !== 0) {
      problems.push('只有失败的演练记录时本该 stale，且 succeededDrills 为 0')
    }
    writeFileSync(
      join(drillDir, '2026-01-03T03-04-05-000Z.json'),
      JSON.stringify({ outcome: 'ok', atMs: 500 }), 'utf8',
    )
    const fresh = drillStatus(backupDir, { nowMs: 1000 })
    if (fresh.stale !== false || fresh.succeededDrills !== 1) {
      problems.push('窗口内成功过一次后本该不 stale')
    }

    return Object.freeze({
      ok: problems.length === 0,
      problems: Object.freeze(problems),
      samples: Object.freeze({
        emptySnapshotOk: empty.ok,
        emptySnapshotCode: empty.code,
        snapshotFileCount: made.snapshot.fileCount,
        restoredContent: readFileSync(join(dataDir, 'team.db'), 'utf8'),
        sidecarsRemoved: restored.sidecarsRemoved.length,
        corruptRestoreCode: corrupt.code,
        thinUnderRetained: thin.underRetained,
        richUnderRetained: rich.underRetained,
        failedOnlyStale: stale.stale,
        failedOnlySucceeded: stale.succeededDrills,
        afterSuccessStale: fresh.stale,
      }),
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export const BACKUP_CHECKED = selfCheckBackup()

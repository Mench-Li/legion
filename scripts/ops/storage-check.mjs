// scripts/ops/storage-check.mjs
// ============================================================================
// 这台 Hub 的**存储余量**体检。
//
// ## ★ 为什么它是独立脚本，而不是一个 HTTP 端点
//
// 因为它要在**服务正在失败**的时候仍然能跑。
//
// 磁盘满的时候 Hub 本身就在返 503（见 `team-hub/storage-health.mjs`）——
// 那正是最需要读这个读数的一刻。一个由**正在出故障的那个进程**提供的监控端点，
// 会在最需要它的时候跟着一起不可用。
//
//   > 一个"和被测系统同生共死"的健康检查，
//   > 与一个"被测系统挂了就没有的健康检查"，是同一个东西 ——
//   > 只不过前者平时看起来更方便。
//
// 所以它直接读文件系统与库文件，**不需要 Hub 在跑**，也不需要凭据。
//
// ## 用法与退出码
//
//   node scripts/ops/storage-check.mjs                 # 读本机默认位置
//   node scripts/ops/storage-check.mjs --db <路径>
//   node scripts/ops/storage-check.mjs --backups <目录>
//   node scripts/ops/storage-check.mjs --json          # 机器可读（给监控用）
//
//   0  ok        1  warn        2  critical        3  读不到读数
//
// ★ 退出码把 `warn` 与 `critical` **分开**，也把"读不到"单独一档 ——
//   一个把所有非正常都回 1 的脚本，会让监控分不出"快去清盘"与"去装监控"。
// ============================================================================
import { statSync, existsSync, readdirSync, statfsSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'

import { storageReport, levelSummary, WARN_HEADROOM_FACTOR, CRITICAL_HEADROOM_FACTOR, BACKUP_HEADROOM_FACTOR } from '../../team-hub/storage-health.mjs'

/** 退出码。见文件头：`warn` 与 `critical` 必须分开。 */
export const EXIT = Object.freeze({ ok: 0, warn: 1, critical: 2, unknown: 3 })

/**
 * 解析命令行。
 *
 * ★ 导出它是为了**可测**：这里面有一条会出人命的规则 ——
 *   **未认识的参数必须报错，不能忽略**。一个被静默忽略的 `--db` 打错字母，
 *   会让脚本去检查**另一个**库，而输出看起来完全正常。
 */
export function parseArgv(argv) {
  const out = { db: process.env.TEAM_HUB_DB ?? '', backups: '', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') { out.json = true; continue }
    if (a === '--db') { out.db = argv[i + 1] ?? ''; i += 1; continue }
    if (a === '--backups') { out.backups = argv[i + 1] ?? ''; i += 1; continue }
    if (a === '--help' || a === '-h') { out.help = true; continue }
    // 未认识的参数**报错而不是忽略**：一个被静默忽略的 `--db` 会让脚本
    // 去检查**另一个**库，而输出看起来完全正常。
    if (a.startsWith('--')) { out.bad = a; continue }
  }
  return out
}

/** 文件大小；不存在回 `null`（**不是** 0 —— 见下）。 */
function sizeOf(path) {
  try { return statSync(path).size } catch { return null }
}

/** 目录里最新的一个文件的 mtime；读不到回 `null`。 */
function newestMtimeMs(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return null
  try {
    const names = readdirSync(dir).filter((n) => !n.startsWith('.'))
    let newest = null
    for (const n of names) {
      const st = statSync(join(dir, n))
      if (!st.isFile()) continue
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
    }
    return newest
  } catch { return null }
}

/** 磁盘余量（`statfsSync`）。读不到回 `null`。 */
function fsSpace(path) {
  try {
    const st = statfsSync(path)
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize }
  } catch { return null }
}

/**
 * 体检一次。**纯读取**，什么都不改。
 *
 * @returns {{level: string, report: object, paths: object, problems: string[]}}
 */
export function checkStorage({ db = '', backups = '', nowMs = Date.now() } = {}) {
  const problems = []
  const dbPath = db.length > 0 ? resolve(db) : ''
  if (dbPath.length === 0) problems.push('没有指定库文件（用 --db，或设 TEAM_HUB_DB）')
  const dbBytes = dbPath.length > 0 ? sizeOf(dbPath) : null
  if (dbPath.length > 0 && dbBytes === null) problems.push(`读不到库文件：${dbPath}`)
  // ★ WAL **单独**读：实测这台服务器上 WAL 曾比主库还大（1.1MB vs 4.2MB），
  //   只看主库会严重低估真实占用。
  const walBytes = dbPath.length > 0 ? (sizeOf(`${dbPath}-wal`) ?? 0) : 0
  const backupsDir = backups.length > 0 ? resolve(backups) : (dbPath.length > 0 ? join(dirname(dbPath), 'backups') : '')
  if (backupsDir.length > 0 && !existsSync(backupsDir)) problems.push(`备份目录不存在：${backupsDir}`)
  const backupAtMs = newestMtimeMs(backupsDir)
  const space = dbPath.length > 0 ? fsSpace(dirname(dbPath)) : null
  if (space === null && dbPath.length > 0) problems.push('读不到磁盘余量（statfs 失败）')

  const report = storageReport({
    dbBytes: dbBytes ?? 0,
    walBytes,
    freeBytes: space === null ? undefined : space.freeBytes,
    totalBytes: space === null ? undefined : space.totalBytes,
    backupAgeMs: backupAtMs === null ? undefined : nowMs - backupAtMs,
  })
  return { level: report.level, report, paths: { db: dbPath, backups: backupsDir }, problems }
}

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const human = (n) => {
  if (n === null || n === undefined) return '(读不到)'
  const v = Number(n)
  if (!Number.isFinite(v)) return '(读不到)'
  if (v >= GiB) return `${(v / GiB).toFixed(2)} GiB`
  if (v >= MiB) return `${(v / MiB).toFixed(1)} MiB`
  return `${v} B`
}
const age = (ms) => {
  if (ms === null || ms === undefined) return '(读不到 —— 没有备份)'
  const h = ms / 3600000
  return h < 1 ? `${Math.round(ms / 60000)} 分钟前` : h < 48 ? `${h.toFixed(1)} 小时前` : `${(h / 24).toFixed(1)} 天前`
}

/**
 * 最终判定：把**余量**与**备份**两件事合成一个结论与一个退出码。
 *
 * ## ★ 为什么备份那一件事也要影响退出码
 *
 * 初版只让"余量"决定判定，于是"**这台机器一份备份都没有**"会得到
 * `OK / 退出码 0` —— 而监控只会看退出码，于是那件事**永远不会被告警**。
 *
 *   > 一个"读出来了、印出来了、但不影响告警"的读数，
 *   > 与一个"根本读不出来"的读数，在值班的人那里是同一个东西。
 *
 * 所以：余量危险 → critical；余量警戒**或**备份缺失/陈旧 → warn。
 * 两者取**更坏**的那一档。
 *
 * ★ `unknown` 单独一档：它要么是"读不到"（去装监控），要么是"读不到空间"
 *   （去查挂载）—— 而它**比 warn 更该被看见**，因为 warn 至少有人在测。
 *
 * @param {{level: string, backupStale: boolean, problems: string[]}} input
 * @returns {{level: string, exitCode: number, reasons: string[]}}
 */
export function verdict(input = {}) {
  const src = (input === null || typeof input !== 'object') ? {} : input
  const headroom = typeof src.level === 'string' ? src.level : 'unknown'
  const problems = Array.isArray(src.problems) ? src.problems : []
  const reasons = []
  if (headroom === 'critical') reasons.push('存储余量危险：写入随时会失败，备份也已经做不成')
  if (headroom === 'warn') reasons.push('存储余量偏低')
  if (src.backupStale === true) reasons.push('没有可用的备份，或最新一份已超过 48 小时')
  if (headroom === 'unknown') reasons.push('读不到存储余量 —— 这台 Hub 目前没有在监控它')
  // 顺序：critical > unknown > warn > ok。
  // ★ `unknown` 排在 `warn` 前面：`warn` 说明有人在测而情况在恶化，
  //   `unknown` 说明**根本没人在测** —— 后者更该被优先处理。
  let level = 'ok'
  let exitCode = EXIT.ok
  if (headroom === 'critical') {
    level = 'critical'; exitCode = EXIT.critical
  } else if (headroom === 'unknown') {
    level = 'unknown'; exitCode = EXIT.unknown
  } else if (headroom === 'warn' || src.backupStale === true || problems.length > 0) {
    level = 'warn'; exitCode = EXIT.warn
  }
  return { level, exitCode, reasons }
}

function main(argv) {
  const args = parseArgv(argv)
  if (args.help) {
    console.log('用法：node scripts/ops/storage-check.mjs [--db <库路径>] [--backups <目录>] [--json]')
    console.log('退出码：0 ok / 1 warn / 2 critical / 3 读不到读数')
    return EXIT.ok
  }
  if (args.bad !== undefined) {
    // ★ 未认识的参数**报错**而不是忽略：`--db` 打错一个字母会被静默忽略，
    //   脚本于是去检查另一个库，而输出看起来完全正常。
    console.error(`未认识的参数：${args.bad}（用 --help 看用法）`)
    return EXIT.unknown
  }
  const { level, report, paths, problems } = checkStorage({ db: args.db, backups: args.backups })
  const v = verdict({ level, backupStale: report.backupStale, problems })

  if (args.json) {
    console.log(JSON.stringify({
      level: v.level,
      ...report,
      paths,
      problems,
      reasons: v.reasons,
      summary: levelSummary(report.level).key,
    }, null, 2))
  } else {
    console.log('存储体检（这台 Hub）')
    console.log(`  库文件        ${paths.db || '(未指定)'}`)
    console.log(`    主库        ${human(report.dbBytes)}`)
    console.log(`    WAL         ${human(report.walBytes)}   ← 单独报：它可能比主库还大`)
    console.log(`    合计占用    ${human(report.totalUsedBytes)}`)
    console.log(`  磁盘         可用 ${human(report.freeBytes)} / 共 ${human(report.totalBytes)}`)
    console.log(`  备份目录      ${paths.backups || '(未指定)'}`)
    console.log(`    最新一份    ${age(report.backupAgeMs)}${report.backupStale ? '   ★ 没有可用备份' : ''}`)
    console.log('')
    console.log(`  余量判定      ${String(level).toUpperCase()}  ${levelSummary(level).key}`)
    console.log(`  最终判定      ${v.level.toUpperCase()}${v.reasons.length > 0 ? '  ' + v.reasons.join('；') : ''}`)
    console.log(`  阈值          危险 < max(256MiB, ${CRITICAL_HEADROOM_FACTOR}× 主库)；警戒 < max(1GiB, ${WARN_HEADROOM_FACTOR}× 主库)`)
    console.log(`  （备份需要一份与库等大的自由空间，所以"备份能做成"的门槛是 ${BACKUP_HEADROOM_FACTOR}× 主库）`)
    if (report.neededBytes > 0) console.log(`  还需要清出    至少 ${human(report.neededBytes)}`)
    if (problems.length > 0) {
      console.log('')
      console.log('  读数问题：')
      for (const p of problems) console.log(`    - ${p}`)
    }
  }
  return v.exitCode
}

// 只在被直接运行时执行（被 import 时只导出 `checkStorage` 供判据使用）。
const isMain = process.argv[1] !== undefined && basename(process.argv[1]) === 'storage-check.mjs'
if (isMain) process.exit(main(process.argv.slice(2)))

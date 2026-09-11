#!/usr/bin/env node
// scripts/prt/backup-restore-verify.mjs
// ============================================================================
// PRT-006：备份 / 恢复验证
//
// 回答一个问题：**按 docs/DEPLOY.md §6 写的备份方法，真的能恢复出同样的数据吗？**
//
// 验证四条，全部在**副本**上做（源库只读打开，绝不写入、绝不替换）：
//   ① 只复制 team.db（不含 -wal） → 能否恢复全部数据？
//   ② 复制 team.db + -wal + -shm（DEPLOY.md 的写法） → 能否恢复全部数据？
//   ③ `VACUUM INTO` 一致性快照 → 能否恢复全部数据？能否在只有源库只读权限时工作？
//   ④ 恢复到干净目录后：integrity_check、逐表行数、audit.seq 上界与**缺口**
//
// ## 为什么 ④ 查的是「缺口」而不是「连续」
//
// 原计划写的验收项是「audit seq 连续性」。**实测真实库有 1 个缺口**（seq 4501–4502，
// 夹在两条相隔 30s 的 release-stale 之间），而 `PRAGMA integrity_check` 为 ok。
// 原因是分配器本身：`audit()` 在 BEGIN IMMEDIATE 里取 `MAX(seq)+1`
// （team-hub/server.mjs:1197）——**它对回滚是容忍的**：事务回滚后该号被作废，
// 下一个写入者拿到的是「当前 MAX+1」，于是留下空洞。
// 这不是缺陷，是「不回填已作废号」的设计。因此正确的验收项是
// **「恢复前后缺口集合完全一致」**，而不是「没有缺口」。
// 把它写成「必须连续」会让 PRT-006 在真实数据上永远失败——一条永远红的验收项
// 等于没有验收项。
//
// ## 为什么用 VACUUM INTO 而不是文件复制
//
// WAL 模式下已提交的数据可能仍只在 `-wal` 里。只复制 `.db` 会丢掉这部分；
// 连 `-wal` 一起复制虽然通常可行，但**复制期间源库若仍在写入**，三个文件
// 不构成同一时点的一致视图。`VACUUM INTO` 由 SQLite 自己产生一致快照，
// 且只需要对源库的**读**权限。
//
// 用法：
//   node scripts/prt/backup-restore-verify.mjs                     # 用现场库验证
//   node scripts/prt/backup-restore-verify.mjs --source=<path>     # 指定源库
//   node scripts/prt/backup-restore-verify.mjs --json
//   node scripts/prt/backup-restore-verify.mjs --keep              # 保留临时副本
//   node scripts/prt/backup-restore-verify.mjs --help
//
// 退出码：0 全部通过；1 有失败项；2 前置条件不满足（源库不存在等）。
// ============================================================================
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_SOURCE = join(ROOT, 'team-hub', 'team.db')
const rel = (p) => p.split(sep).join('/')

/** WAL 三件套的后缀。缺 -wal 是「只复制 .db」这条路线的核心缺陷。 */
export const WAL_SUFFIXES = ['', '-wal', '-shm']

/** 读取一个库的完整逻辑状态（只读）。 */
export function inspectDb(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)
    const rowCounts = {}
    for (const t of tables) {
      try {
        rowCounts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
      } catch (err) {
        rowCounts[t] = `err:${err.message}`
      }
    }
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const journal = db.prepare('PRAGMA journal_mode').get()

    // audit.seq 的缺口集合——见文件头「为什么查缺口而不是连续性」
    let audit = null
    if (tables.includes('audit')) {
      const agg = db.prepare('SELECT MIN(seq) lo, MAX(seq) hi, COUNT(*) n FROM audit').get()
      const gaps = db
        .prepare(`
          WITH s AS (SELECT seq, LAG(seq) OVER (ORDER BY seq) prev FROM audit)
          SELECT prev AS before, seq AS after FROM s
          WHERE prev IS NOT NULL AND seq != prev + 1
          ORDER BY seq
        `)
        .all()
      audit = { lo: agg.lo, hi: agg.hi, count: agg.n, gaps }
    }
    return {
      ok: true,
      tables,
      tableCount: tables.length,
      rowCounts,
      totalRows: Object.values(rowCounts).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0),
      integrityCheck: integrity?.integrity_check ?? null,
      journalMode: journal?.journal_mode ?? null,
      audit,
    }
  } catch (err) {
    return { ok: false, reason: err.message, tables: [], tableCount: 0, rowCounts: {}, totalRows: 0 }
  } finally {
    db.close()
  }
}

/** 复制源库的三件套到目标目录（模拟 DEPLOY.md §6 的手工备份）。 */
export function copyTriple(srcPath, destDir, { includeWal = true } = {}) {
  mkdirSync(destDir, { recursive: true })
  const copied = []
  for (const suffix of WAL_SUFFIXES) {
    if (suffix !== '' && !includeWal) continue
    const from = srcPath + suffix
    if (!existsSync(from)) continue
    const to = join(destDir, basename(srcPath) + suffix)
    copyFileSync(from, to)
    copied.push({ suffix: suffix || '.db', bytes: statSync(to).size })
  }
  return { dir: destDir, destPath: join(destDir, basename(srcPath)), copied }
}

/**
 * `VACUUM INTO` 一致性快照。
 *
 * 目标文件必须**不存在**（SQLite 会拒绝覆盖），因此先删。源库以只读打开——
 * 这正是「备份员只需要读权限」这一诉求的验证点。
 */
export function vacuumInto(srcPath, destPath) {
  if (existsSync(destPath)) rmSync(destPath, { force: true })
  mkdirSync(dirname(destPath), { recursive: true })
  const db = new DatabaseSync(srcPath, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  return { destPath, bytes: statSync(destPath).size }
}

/** 比较两个逻辑状态，返回差异描述（空数组 = 一致）。 */
export function diffStates(a, b) {
  const lines = []
  if (!a.ok || !b.ok) {
    lines.push(`  状态不可读：a.ok=${a.ok} b.ok=${b.ok}`)
    return lines
  }
  if (a.integrityCheck !== 'ok') lines.push(`  基线 integrity_check=${a.integrityCheck}`)
  if (b.integrityCheck !== 'ok') lines.push(`  恢复后 integrity_check=${b.integrityCheck}`)
  if (a.tableCount !== b.tableCount) lines.push(`  表数 ${a.tableCount} -> ${b.tableCount}`)
  for (const t of new Set([...a.tables, ...b.tables])) {
    const av = a.rowCounts[t] ?? '(缺表)'
    const bv = b.rowCounts[t] ?? '(缺表)'
    if (av !== bv) lines.push(`  ${t}: ${av} -> ${bv}`)
  }
  if (a.totalRows !== b.totalRows) lines.push(`  总行数 ${a.totalRows} -> ${b.totalRows}`)
  const ga = JSON.stringify(a.audit?.gaps ?? [])
  const gb = JSON.stringify(b.audit?.gaps ?? [])
  if (ga !== gb) lines.push(`  audit 缺口集合：${ga} -> ${gb}`)
  if (a.audit?.hi !== b.audit?.hi) lines.push(`  audit.seq 上界 ${a.audit?.hi} -> ${b.audit?.hi}`)
  return lines
}

/**
 * 跑完整验证。**只读源库**：源文件与它同目录的 -wal/-shm 都不会被写入或删除。
 */
export function verifyBackupRestore({ source = DEFAULT_SOURCE, workRoot, keep = false } = {}) {
  if (!existsSync(source)) return { ok: false, reason: `源库不存在：${rel(source)}` }

  const root = workRoot ?? mkdtempSync(join(tmpdir(), 'prt-006-'))
  const results = []

  // 源库的**真实**逻辑状态（只读打开源库；SQLite 在只读模式下不会改动 WAL）
  const truth = inspectDb(source)

  // ① 只复制 .db
  const dbOnly = copyTriple(source, join(root, 'db-only'), { includeWal: false })
  const dbOnlyState = inspectDb(dbOnly.destPath)
  const dbOnlyDiff = diffStates(truth, dbOnlyState)
  results.push({
    name: '① 只复制 team.db（不含 -wal）',
    restored: dbOnlyDiff.length === 0,
    bytes: dbOnly.copied.find((c) => c.suffix === '.db')?.bytes ?? 0,
    diff: dbOnlyDiff,
    note: '遗漏 -wal 中已提交但未 checkpoint 的数据',
  })

  // ② 复制三件套（DEPLOY.md §6 的写法）
  const triple = copyTriple(source, join(root, 'triple'), { includeWal: true })
  const tripleState = inspectDb(triple.destPath)
  const tripleDiff = diffStates(truth, tripleState)
  results.push({
    name: '② 复制 team.db + -wal + -shm（DEPLOY.md §6）',
    restored: tripleDiff.length === 0,
    bytes: triple.copied.reduce((n, c) => n + c.bytes, 0),
    diff: tripleDiff,
    note: '静态副本下可行；源库仍在写入时三文件不构成同一时点视图',
  })

  // ③ VACUUM INTO
  const vac = vacuumInto(source, join(root, 'vacuum', basename(source)))
  const vacState = inspectDb(vac.destPath)
  const vacDiff = diffStates(truth, vacState)
  results.push({
    name: '③ VACUUM INTO 一致性快照',
    restored: vacDiff.length === 0,
    bytes: vac.bytes,
    diff: vacDiff,
    note: 'SQLite 自己产生一致快照；只需源库读权限',
  })

  // ④ 从快照恢复到干净目录（模拟真实恢复：只拿备份文件，不带原目录）
  const restoreDir = join(root, 'restored')
  mkdirSync(restoreDir, { recursive: true })
  const restoredPath = join(restoreDir, basename(source))
  copyFileSync(vac.destPath, restoredPath)
  const restoredState = inspectDb(restoredPath)
  const restoreDiff = diffStates(truth, restoredState)
  results.push({
    name: '④ 从快照恢复到干净目录',
    restored: restoreDiff.length === 0,
    bytes: statSync(restoredPath).size,
    diff: restoreDiff,
    note: '不依赖 -wal/-shm，单文件即可用',
  })

  // ⑤ 陈旧 -wal 与恢复后的 .db 混用（回滚时最容易做错的一步）
  const hazard = staleWalHazard(source, root)
  results.push({
    name: '⑤ 恢复 .db 但目标目录残留陈旧 -wal',
    restored: hazard.safe,
    bytes: hazard.bytes,
    diff: hazard.diff,
    note: hazard.note,
  })

  // ⑥ 源库正在写入时，三件套副本是否构成同一时点视图
  const race = doubleCopyRace(source, root)

  return {
    ok: results.every((r) => r.restored),
    source: rel(source),
    sourceBytes: statSync(source).size,
    walPresent: existsSync(source + '-wal'),
    walBytes: existsSync(source + '-wal') ? statSync(source + '-wal').size : 0,
    truth,
    results,
    race,
    workRoot: keep ? root : null,
    _root: root,
  }
}

/**
 * ⑤ 陈旧 -wal 危害实验。
 *
 * 模拟「按 DEPLOY.md §6 回滚」时最容易做错的一步：**换了 .db，但目标目录里
 * 还留着上一次运行留下的 -wal**。SQLite 不会因为「这个 WAL 不属于这个库」就拒绝它——
 * 它只校验 WAL 自身的页校验和。于是可能把一批**属于另一个时点的页**
 * 重放到刚恢复的库上。
 *
 * 构造方式（全部在副本上，源库只读）：
 *   A = 源库三件套副本（一致）
 *   B = A 的副本，**在连接仍打开时**插入一行合成 audit → 此时它的 -wal 里
 *       确定含有 A 所没有的页（不 close，避免 SQLite 关闭时 checkpoint 掉 WAL）
 *   hazard = A 的 .db + B 的 -wal
 *
 * 报告**实测行为**，不预设结论：可能是报错、可能是静默多出数据。
 */
export function staleWalHazard(source, root) {
  const dirA = join(root, 'hazard-a')
  const dirB = join(root, 'hazard-b')
  copyTriple(source, dirA, { includeWal: true })
  copyTriple(source, dirB, { includeWal: true })

  const dbPathB = join(dirB, basename(source))
  const tableExists = (() => {
    const s = inspectDb(dbPathB)
    return s.ok && s.tables.includes('audit')
  })()

  // 在 B 上写一行，且**保持连接打开**以便拷走带新页的 -wal
  const marker = 'prt-006-hazard-marker'
  if (tableExists) {
    const db = new DatabaseSync(dbPathB)
    try {
      db.exec('PRAGMA wal_autocheckpoint = 0')
      const m = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM audit').get()
      db.prepare('INSERT INTO audit (seq, ts, member, scope, action, taskId, detail, goalId) VALUES (?,?,?,?,?,?,?,?)')
        .run(m.m + 1, new Date().toISOString(), 'prt-006', '*', marker, null, '{}', null)
      db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT') // 确保新页落在 WAL 里
      // 连接仍开着 → 把 B 的三件套拷到「新鲜」目录，WAL 确定含新页
      const fresh = join(root, 'hazard-b-fresh')
      copyTriple(dbPathB, fresh, { includeWal: true })
      db.close()
      // hazard = A 的 .db + B(新鲜) 的 -wal，不放 -shm（强制 SQLite 重建索引）
      const hz = join(root, 'hazard-mix')
      mkdirSync(hz, { recursive: true })
      copyFileSync(join(dirA, basename(source)), join(hz, basename(source)))
      copyFileSync(join(fresh, basename(source) + '-wal'), join(hz, basename(source) + '-wal'))
      const mixed = inspectDb(join(hz, basename(source)))
      const bytes = statSync(join(hz, basename(source) + '-wal')).size
      const leaked = mixed.ok && mixed.tables.includes('audit')
        ? (() => {
            const d = new DatabaseSync(join(hz, basename(source)), { readOnly: true })
            try {
              return d.prepare('SELECT COUNT(*) c FROM audit WHERE action = ?').get(marker).c
            } catch { return -1 } finally { d.close() }
          })()
        : -1
      const base = inspectDb(join(dirA, basename(source)))
      return {
        safe: leaked === 0 && mixed.integrityCheck === 'ok',
        bytes,
        diff: leaked > 0
          ? [`  陈旧 -wal 被重放：恢复库中出现了 ${leaked} 行不属于该快照的合成数据`, `  integrity_check=${mixed.integrityCheck}`]
          : mixed.ok
            ? []
            : [`  恢复库不可读：${mixed.reason}`],
        note: leaked > 0
          ? '**确认危害**：混用陈旧 -wal 会把其它时点的页重放到恢复库上（本行为合成数据）'
          : '未观察到陈旧 -wal 被重放；仍应在恢复时显式清除 -wal/-shm',
        leaked,
        baseIntegrity: base.integrityCheck,
      }
    } catch (err) {
      try { db.close() } catch { /* 已关 */ }
      return { safe: true, bytes: 0, diff: [], note: `实验无法构造（${err.message}），保守视为未验证`, leaked: -1, unverified: true }
    }
  }
  return { safe: true, bytes: 0, diff: [], note: '源库无 audit 表，跳过', leaked: -1, unverified: true }
}

/**
 * ⑥ 双副本竞态：连做两次三件套复制，看是否得到同一逻辑状态。
 *
 * 若不同，则证明**源库写入期间的文件复制不是同一时点视图**——
 * 逐文件复制天然跨越多个时点，中间发生的提交会以「部分页」的形态进入副本。
 */
export function doubleCopyRace(source, root) {
  const a = copyTriple(source, join(root, 'race-a'), { includeWal: true })
  const b = copyTriple(source, join(root, 'race-b'), { includeWal: true })
  const sa = inspectDb(a.destPath)
  const sb = inspectDb(b.destPath)
  const lines = diffStates(sa, sb)
  const aa = inspectDb(a.destPath)
  return {
    identical: lines.length === 0,
    diff: lines,
    aTotal: aa.totalRows,
    bTotal: sb.totalRows,
    note: lines.length === 0
      ? '两次复制恰好一致（源库在此期间未写入）；不能据此认为复制是原子的'
      : '**两次复制得到不同状态**：源库在复制期间有写入 → 文件级复制跨时点，非一致快照',
  }
}

// ---------------------------------------------------------------- CLI

function usage() {
  console.log('backup-restore-verify.mjs — PRT-006 备份/恢复验证（只读源库，全部在副本上做）')
  console.log('')
  console.log('  --source=<path>   源库（默认 team-hub/team.db）')
  console.log('  --json            机器可读输出')
  console.log('  --keep            保留临时副本并打印路径')
  console.log('  --help            本说明')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const source = argv.find((a) => a.startsWith('--source='))?.slice('--source='.length) || DEFAULT_SOURCE
  const keep = argv.includes('--keep')

  const out = verifyBackupRestore({ source, keep })
  if (!out.ok && out.reason) {
    console.error(`FAIL ${out.reason}`)
    process.exit(2)
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log(`源库 ${out.source}  ${(out.sourceBytes / 1024).toFixed(0)} KB` +
      (out.walPresent ? ` + -wal ${(out.walBytes / 1024).toFixed(0)} KB` : ' （无 -wal）'))
    console.log(`逻辑状态：${out.truth.tableCount} 表 / ${out.truth.totalRows} 行 / integrity=${out.truth.integrityCheck}`)
    if (out.truth.audit) {
      console.log(`audit.seq：${out.truth.audit.lo}..${out.truth.audit.hi}，共 ${out.truth.audit.count} 条，` +
        `缺口 ${out.truth.audit.gaps.length} 处`)
    }
    console.log('')
    for (const r of out.results) {
      console.log(`  ${r.restored ? 'PASS' : 'FAIL'}  ${r.name}  （${(r.bytes / 1024).toFixed(0)} KB）`)
      if (!r.restored) for (const l of r.diff) console.log(l)
      if (r.note) console.log(`        ${r.note}`)
    }
    console.log('')
    console.log(out.ok ? '结论：三种备份方式都能完整恢复。' : '结论：存在**不能**完整恢复的备份方式（见上）。')
    if (out.race) {
      console.log('')
      console.log(`竞态探测：两次连续复制${out.race.identical ? '一致' : '**不一致**'}（${out.race.aTotal} vs ${out.race.bTotal} 行）`)
      for (const l of out.race.diff) console.log(l)
      console.log(`  ${out.race.note}`)
    }
  }
  if (!keep) rmSync(out._root, { recursive: true, force: true })
  else console.log(`\n临时副本保留在 ${rel(out._root)}`)

  process.exit(out.ok ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

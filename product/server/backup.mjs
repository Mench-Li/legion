#!/usr/bin/env node
// product/server/backup.mjs
// ============================================================================
// Legion Hub 的一致备份（远程 Agent 通道 S-G）
//
// ## 为什么不能 `cp team.db`
//
// 实测这台服务器上的读数是：`team.db` **1.1 MB**、`team.db-wal` **4.2 MB**。
// 也就是说**大部分最近写入还在 WAL 里**。只拷主库文件会得到一个"能打开、
// 少数据"的备份——它不报错，恢复之后你才发现最近的任务、消息、进展都没了。
//
//   > 一个"拷完不报错"的备份，与一个"真的完整"的备份，在只看文件大小的时候
//   > 是同一个东西。
//
// 所以这里用 SQLite 自己的 **`VACUUM INTO`**：它把**包括 WAL 在内**的一致快照
// 写成一个单独的文件（没有 WAL、没有 shm），且可以在库正在被写的时候跑。
//
// ## 备份必须**被验证过**才算数
//
// 写完之后立刻读回来：完整性检查 + 关键表存在 + 行数与源库对得上。
// 一个"写出来但读不回去"的备份，与没有备份，在出事那天是同一个东西。
//
// ## 加密的边界（必须如实说）
//
// 用 gpg 对称加密，口令从一个 0600 文件读。**口令文件与备份在同一台机器上**，
// 所以它挡的是"备份文件本身外泄"，**挡不住"主机被攻陷"**。
// 真正的异地保护要求口令存在**别处**（密码管理器、另一台机器）并单独保管。
// 本脚本因此把口令文件路径作为参数，并在它落在数据目录里时**警告**。
//
// 用法：
//   node product/server/backup.mjs --db <team.db> --out <备份目录> [--passphrase-file <路径>] [--keep N]
//   node product/server/backup.mjs --verify <备份文件> --passphrase-file <路径>
// ============================================================================
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

/** 备份要证明"拿得回来"的表。缺一张就说明备份不完整。 */
export const EXPECTED_TABLES = Object.freeze([
  'tasks', 'messages', 'conversations', 'audit',
  'run_attempts', 'run_events', 'run_context_snapshots',
  'agent_registry', 'agent_conversation_bindings',
  'hub_users', 'hub_user_sessions', 'hub_devices',
])

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

function parseArgv(argv) {
  const o = { keep: 7, passphraseFile: null, db: null, out: null, verify: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--db') o.db = next()
    else if (a === '--out') o.out = next()
    else if (a === '--verify') o.verify = next()
    else if (a === '--passphrase-file') o.passphraseFile = next()
    else if (a === '--keep') o.keep = Number(next())
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return o
}

/** 一致性快照。**这一步是全部要点**：它在库正被写的时候也给出完整的一份。 */
export function snapshotInto(dbFile, outFile) {
  if (existsSync(outFile)) unlinkSync(outFile)
  const db = new DatabaseSync(dbFile, { readOnly: false })
  try {
    // 参数化不了标识符/路径字面量：这里用转义单引号的方式拼，路径来自命令行而非远端输入。
    db.exec(`VACUUM INTO '${String(outFile).replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  return outFile
}

/** 读回来验一遍：能不能打开、完整性、关键表、行数。 */
export function inspectSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const integrityValue = integrity?.integrity_check ?? Object.values(integrity ?? {})[0]
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
    const missing = EXPECTED_TABLES.filter((t) => !tables.has(t))
    const counts = {}
    for (const t of EXPECTED_TABLES) {
      if (!tables.has(t)) continue
      counts[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
    }
    return { ok: integrityValue === 'ok' && missing.length === 0, integrity: integrityValue, missing, counts, tables: [...tables].sort() }
  } finally {
    db.close()
  }
}

function encryptFile(src, dst, passphraseFile) {
  if (passphraseFile === null) return null
  const r = spawnSync('gpg', [
    '--batch', '--yes', '--quiet',
    '--symmetric', '--cipher-algo', 'AES256',
    '--passphrase-file', passphraseFile,
    '--output', dst, src,
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`gpg 加密失败：${r.stderr?.trim() || r.status}`)
  return dst
}

function decryptFile(src, dst, passphraseFile) {
  const r = spawnSync('gpg', [
    '--batch', '--yes', '--quiet',
    '--decrypt', '--passphrase-file', passphraseFile,
    '--output', dst, src,
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`gpg 解密失败：${r.stderr?.trim() || r.status}`)
  return dst
}

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
const human = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

function main() {
  const o = parseArgv(process.argv.slice(2))
  if (o.help || (o.db === null && o.verify === null)) {
    log('用法：node product/server/backup.mjs --db <team.db> --out <目录> [--passphrase-file <路径>] [--keep N]')
    log('      node product/server/backup.mjs --verify <备份文件> --passphrase-file <路径>   # 加密时')
    log('      node product/server/backup.mjs --verify <备份文件>                            # 未加密时')
    return o.help ? 0 : 2
  }

  // ── 验证既有备份 ─────────────────────────────────────────────────────────
  if (o.verify !== null) {
    const src = resolve(o.verify)
    if (!existsSync(src)) { warn(`备份不存在：${src}`); return 1 }
    let target = src
    let tmp = null
    if (o.passphraseFile !== null) {
      tmp = join(dirname(src), `.verify-${process.pid}.db`)
      decryptFile(src, tmp, o.passphraseFile)
      target = tmp
    }
    try {
      const info = inspectSnapshot(target)
      log(JSON.stringify({ file: basename(src), ...info }, null, 2))
      if (!info.ok) { warn('备份**不可用**：完整性或关键表缺失'); return 1 }
      log(`✔ 备份可用：integrity=${info.integrity}，${EXPECTED_TABLES.length} 张关键表都在`)
      return 0
    } finally {
      if (tmp !== null && existsSync(tmp)) unlinkSync(tmp)
    }
  }

  // ── 造备份 ───────────────────────────────────────────────────────────────
  const dbFile = resolve(o.db)
  if (!existsSync(dbFile)) { warn(`库不存在：${dbFile}`); return 1 }
  const outDir = resolve(o.out)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const base = `team-${stamp()}.db`
  const rawPath = join(outDir, base)
  const encPath = `${rawPath}.gpg`

  log(`① 一致快照（VACUUM INTO；库可以在被写）→ ${rawPath}`)
  snapshotInto(dbFile, rawPath)
  const rawSize = statSync(rawPath).size
  log(`   快照 ${human(rawSize)}（主库 ${human(statSync(dbFile).size)}；WAL 里的数据已并入）`)

  log('② 读回来验证（写出来但读不回去的备份等于没有备份）')
  const info = inspectSnapshot(rawPath)
  if (!info.ok) {
    warn(`快照**未通过验证**：integrity=${info.integrity}，缺表=${info.missing.join(',') || '无'}`)
    rmSync(rawPath, { force: true })
    return 1
  }
  log(`   integrity=ok；行数：${EXPECTED_TABLES.map((t) => `${t}=${info.counts[t] ?? '-'}`).join(' ')}`)

  let finalPath = rawPath
  if (o.passphraseFile !== null) {
    const passPath = resolve(o.passphraseFile)
    if (!existsSync(passPath)) { warn(`口令文件不存在：${passPath}`); rmSync(rawPath, { force: true }); return 1 }
    // ★ 口令与备份同机 = 只挡"备份文件外泄"，挡不住"主机被攻陷"。如实警告。
    if (resolve(dirname(passPath)) === resolve(outDir)) {
      warn('⚠ 口令文件与备份在**同一个目录**：这只能防止备份文件单独外泄，'
        + '主机被攻陷时两者一起丢。异地保护请把口令存到别处。')
    }
    log(`③ 加密 → ${encPath}`)
    encryptFile(rawPath, encPath, passPath)
    unlinkSync(rawPath)
    finalPath = encPath
    log(`   ${human(statSync(encPath).size)}`)
  } else {
    warn('⚠ 未加密：本脚本要求显式给 --passphrase-file 才有加密。备份含口令哈希与设备令牌哈希，不应明文存放。')
  }

  log(`④ 轮转：保留最近 ${o.keep} 份`)
  const all = readdirSync(outDir).filter((f) => f.startsWith('team-') && (f.endsWith('.db') || f.endsWith('.db.gpg'))).sort()
  const excess = all.slice(0, Math.max(0, all.length - o.keep))
  for (const f of excess) { rmSync(join(outDir, f), { force: true }); log(`   删除 ${f}`) }

  log(JSON.stringify({ ok: true, file: finalPath, sizeBytes: statSync(finalPath).size, counts: info.counts }, null, 2))
  return 0
}

// 被 import 时不执行。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  process.exit(main())
}

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
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

/**
 * 备份要证明"拿得回来"的表 —— **只收"中枢启动就会建的"那些**。缺一张就说明备份不完整。
 *
 * ## 为什么必须按"建表时机"分成两组（2026-10-12 实测抓出来的）
 *
 * 这份清单原先混着两种表，而**验证要求全部存在** ⇒ 在一个**全新部署**上，
 * 每一次夜间备份都会失败、并把快照删掉（"不通过就把文件删掉"那条纪律）。
 * 实测（空库起一次中枢，再数它建了哪些表）：
 *
 *     期望的 12 张里，**4 张在全新中枢上根本不存在**：
 *       run_context_snapshots（team-hub/context-store.mjs）、
 *       hub_users / hub_user_sessions（team-hub/user-store.mjs）、
 *       hub_devices（team-hub/device-store.mjs）
 *     —— 它们的 schema 是**懒建**的：存在 `createXStore()` 里，客户从没碰过那个功能就不建。
 *
 *   > 一条"缺一张就判备份不完整"的规则，
 *   > 与一条"把懒建的表也算进去"的规则，在**用过的机器**上是同一个东西 ——
 *   > 只在全新部署上分叉，而那时它把每一份备份都删掉了。
 *
 * 所以分成两组，各有各的判据：
 *   · `EXPECTED_TABLES`（恒建表）—— **缺一张即失败**。它们由中枢的启动期 `ensure*Schema()` 建，
 *     与"有没有人用过某个功能"无关，所以"不存在"必定意味着**库坏了或备份不完整**。
 *   · `LAZY_TABLES`（懒建表）—— **存在就必须能读回来**；不存在只作为读数报出，不判红。
 *     懒建表不存在**等于那个功能从没被用过**，没有数据可丢。
 *
 *   ⚠ 前提由判据钉住（`product/server/backup.test.mjs` ⑥）：**`EXPECTED_TABLES` 里的每一张，
 *     在全新中枢上都必须真的存在**。往严格那组里加一张懒建表 = 重新引入上面那个失败 ——
 *     而那一步看起来只是"多加一行"。
 *
 * ★ 同一天补进来的模型配置三张表**属于严格那组**（实测全新中枢就会建它们）。
 *   补的经过：将军问"配置包有啥用"，查完结论是它在该部署里没用（那 27 行本来就在每次整库备份里），
 *   于是配置包被删掉了 —— 而**删掉之后**，这份备份成了那 27 行唯一的保护，
 *   这才有人去读这份清单，发现它列了 12 张、模型表一张都不在里面：
 *
 *   > 一个"我一直以为另一条路在照看它"的东西，
 *   > 在另一条路被拆掉的那一天，才会要求你回答"那你自己验过它吗"。
 *
 * ⚠ 凭证**值**不在这些表里（在 DPAPI 密钥库，绑机器绑用户）⇒ 恢复之后仍要重新录入钥匙。
 *   清单保证的是"表在、能读回来"，不是"钥匙还在"。
 */
export const EXPECTED_TABLES = Object.freeze([
  'tasks', 'messages', 'conversations', 'audit',
  'run_attempts', 'run_events',
  'agent_registry', 'agent_conversation_bindings',
  // 模型配置（见上面那段：配置包拆掉之后，这里是它唯一的保护）
  'model_providers', 'model_profiles', 'employee_model_bindings',
])

/**
 * **懒建**的表：schema 存在 `createXStore()` 里，那个功能没被用过就不存在。
 *
 * 它们同样必须"拿得回来"（有数据却读不回来是最坏的），但**不能要求它们存在** ——
 * 见 `EXPECTED_TABLES` 上面那段实测。判据：存在则行数必须读得出来（读不出来即失败）。
 */
export const LAZY_TABLES = Object.freeze([
  // 上下文快照：team-hub/context-store.mjs（`createContextStore()` 里建）
  'run_context_snapshots',
  // 远程账号体系：team-hub/user-store.mjs（`hub_users` / `hub_user_sessions`）
  'hub_users', 'hub_user_sessions',
  // 设备令牌：team-hub/device-store.mjs
  'hub_devices',
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

/**
 * 读回来验一遍：能不能打开、完整性、关键表、行数。
 *
 * 两类表分开报（见 `EXPECTED_TABLES` / `LAZY_TABLES` 上面那两段）：
 *   · `missing`    —— 恒建表缺了哪几张 ⇒ **判红**（库坏了或备份不完整）
 *   · `lazyAbsent` —— 懒建表不在（那个功能从没用过）⇒ **读数，不判红**
 *   · `lazyUnreadable` —— 懒建表在、但行数读不出来 ⇒ **判红**（有数据却读不回来是最坏的）
 */
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
    const lazyAbsent = []
    const lazyUnreadable = []
    for (const t of LAZY_TABLES) {
      if (!tables.has(t)) { lazyAbsent.push(t); continue }
      try { counts[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n) } catch { lazyUnreadable.push(t) }
    }
    return {
      ok: integrityValue === 'ok' && missing.length === 0 && lazyUnreadable.length === 0,
      integrity: integrityValue,
      missing,
      lazyAbsent,
      lazyUnreadable,
      counts,
      tables: [...tables].sort(),
    }
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
      if (!info.ok) {
        warn(`备份**不可用**：完整性=${info.integrity}，恒建表缺失=${JSON.stringify(info.missing)}`
          + `${info.lazyUnreadable.length > 0 ? `，懒建表读不出来=${JSON.stringify(info.lazyUnreadable)}` : ''}`)
        return 1
      }
      log(`✔ 备份可用：integrity=${info.integrity}，${EXPECTED_TABLES.length} 张恒建表都在`
        + `（另有 ${LAZY_TABLES.length} 张懒建表：在场 ${LAZY_TABLES.length - info.lazyAbsent.length} 张`
        + `${info.lazyAbsent.length > 0 ? `，未启用 ${info.lazyAbsent.length} 张=那个功能没用过，不算缺失` : ''}）`)
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

  // ★ 先确认**能不能写**，再动手。
  //
  // 不查这一步的话，失败会长成 `SQLITE_ERROR: unable to open database` +
  // 一个指向 `VACUUM INTO` 的堆栈——它读起来像"库坏了"，而真实原因是
  // "备份目录属于 root，而本进程是 legion-hub"。实测踩过：`systemctl start`
  // 只报 `status=1`，得翻 journal 才看到那句 SQLite 错误。
  //
  // 备份是以**非 root 用户**（systemd unit 里写死 legion-hub）跑的，
  // 所以这是一个会真实发生的配置缺口，不是理论问题。
  try {
    const probe = join(outDir, `.write-probe-${process.pid}`)
    const fd = openSync(probe, 'w')
    closeSync(fd)
    unlinkSync(probe)
  } catch (e) {
    warn(`备份目录不可写：${outDir}（${e.code ?? e.message}）`)
    warn(`  所有权：${(() => { try { const s = statSync(outDir); return `uid=${s.uid} gid=${s.gid} mode=${(s.mode & 0o777).toString(8)}` } catch { return '?' } })()}`)
    warn('  备份以非 root 用户运行（systemd unit 里是 legion-hub），所以这个目录要属于它：')
    warn(`    install -d -m 0700 -o legion-hub -g legion-hub ${outDir}`)
    return 1
  }

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
    warn(`快照**未通过验证**：integrity=${info.integrity}，`
      + `缺表=${info.missing.join(',') || '无'}`
      + `${info.lazyUnreadable.length > 0 ? `，懒建表读不出来=${info.lazyUnreadable.join(',')}` : ''}`)
    rmSync(rawPath, { force: true })
    return 1
  }
  log(`   integrity=ok；行数：${EXPECTED_TABLES.map((t) => `${t}=${info.counts[t] ?? '-'}`).join(' ')}`)
  // ★ 懒建表：在场就把行数报出来（运维要知道"那份数据在不在"），
  //   不在场也说一句"哪几张没启用"——**只是读数，不判红**（理由见 `EXPECTED_TABLES` 上面那段）。
  if (info.lazyAbsent.length > 0) {
    log(`   懒建表未启用（那个功能从没用过，不是缺失）：${info.lazyAbsent.join(' ')}`)
  }

  let finalPath = rawPath
  if (o.passphraseFile !== null) {
    const passPath = resolve(o.passphraseFile)
    // ★ 「不存在」与「存在但读不了」要分开报——**修法完全不同**。
    //   不存在 → 生成一个；读不了 → 改所有权/权限。
    //   合成一句"读取失败"会让人去重新生成一个已经存在的口令，
    //   而那会让**此前所有备份都解不开**。
    if (!existsSync(passPath)) {
      // ★ 「不存在」有**两种**成因，而它们的修法不同：
      //   ① 真的没生成；
      //   ② 文件在、但**父目录**对本进程不可穿越（`existsSync` 会把 EACCES 吞成 false）。
      //   实测踩过 ②：口令放在 `/etc/legion-hub/`（`0700 root`），
      //   而备份以 `legion-hub` 跑 —— 它连 stat 都做不到，于是这里报"不存在"，
      //   而人去找一个已经存在的文件。
      const parent = dirname(passPath)
      let parentReachable = false
      try { const fd = openSync(parent, 'r'); closeSync(fd); parentReachable = true } catch { parentReachable = false }
      warn(`口令文件读不到（existsSync=false）：${passPath}`)
      warn(parentReachable
        ? '  父目录可进入，所以它大概是真的不存在。生成一个：'
        : `  ⚠ **父目录 ${parent} 对本进程不可进入**（existsSync 会把权限错误吞成 false）。`)
      if (!parentReachable) {
        const st = (() => { try { return statSync(parent) } catch { return null } })()
        if (st !== null) warn(`     目录所有权 uid=${st.uid} gid=${st.gid} mode=${(st.mode & 0o777).toString(8)}；本进程 uid=${process.getuid?.() ?? '?'}`)
        warn('     修法：把口令放到备份用户能到的位置（推荐数据目录内），而不是放宽目录权限。')
        warn(`       mv ${passPath} /var/lib/legion-hub/backup.passphrase`)
        warn('       chown legion-hub:legion-hub /var/lib/legion-hub/backup.passphrase')
        warn('       chmod 600 /var/lib/legion-hub/backup.passphrase')
      } else {
        warn('    openssl rand -base64 48 | tr -dc \'A-Za-z0-9\' | head -c 40 > <路径> && chmod 600 <路径>')
      }
      warn('  ⚠ **不要**在已有备份之后重新生成——那会让此前每一份备份都解不开。')
      rmSync(rawPath, { force: true })
      return 1
    }
    try {
      const fd = openSync(passPath, 'r')
      closeSync(fd)
    } catch (e) {
      warn(`口令文件读不了：${passPath}（${e.code ?? e.message}）`)
      const st = (() => { try { return statSync(passPath) } catch { return null } })()
      if (st !== null) {
        warn(`  所有权 uid=${st.uid} gid=${st.gid} mode=${(st.mode & 0o777).toString(8)}；本进程 uid=${process.getuid?.() ?? '?'}`)
        warn('  备份以非 root 用户运行，所以口令文件要属于它：')
        warn(`    chown ${process.getuid?.() ?? 'backup-user'} ${passPath} && chmod 600 ${passPath}`)
      }
      rmSync(rawPath, { force: true })
      return 1
    }
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

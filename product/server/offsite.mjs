#!/usr/bin/env node
// product/server/offsite.mjs
// ============================================================================
// Legion Hub 备份的**异地存放**（远程 Agent 通道 S-G 之二）
//
// ## 这一步补的是哪一半
//
// `backup.mjs` 把备份写到 `/var/lib/legion-hub/backups`——**与库同一块盘**。
// 所以它挡住的是"误删"，挡不住"机器没了"。异地把这一半补上。
//
// ## 为什么"传上去了"不算数
//
// 一个上传成功但**取不回来**的备份，与没有异地备份，在出事那天是同一个东西。
// 而它的表现方式与成功一模一样：`rclone copy` 退出码 0，远端列表里有那个文件，
// 大小也对得上。**只有真去读一次**才能分辨。所以本脚本每次都：
//
//   上传 → 拉回来 → 比 sha256 → 解密 → 打开库跑 integrity_check 与关键表核对
//
// 中间任何一步不过，就是**非零退出**。下载一份 1.2 MB 的代价，
// 换的是"异地那份真的能恢复"这句话有依据。
//
// ## 三条不许越过的线
//
// ① **只传加密件，且只传明确列出的那些。** 上传集合由 `team-*.db.gpg` 的
//    白名单决定，**不做目录同步**（`rclone sync` 会把同目录里任何东西一起带走，
//    包括将来某天有人放进来的明文库或凭据文件）。
// ② **口令文件绝不上传。** 传了它，异地那份的加密就与没有加密一样——
//    而它看起来仍然是个 `.gpg` 文件。脚本会在口令文件落在上传目录里时**拒绝执行**。
// ③ **目标必须真的是"异地"。** 一个不带 `:` 的路径不是 rclone 远端，
//    而是本机另一条路径——那正是本脚本要防的那件事（盘坏了一起没）换了个写法。
//    真要用本地路径（演练用）必须显式给 `--allow-local`。
//
// 用法：
//   node product/server/offsite.mjs --dir <备份目录> --remote <rclone 远端> \
//        --passphrase-file <口令文件> [--keep N] [--max-age-hours N] [--dry-run] [--allow-local]
// ============================================================================
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectSnapshot } from './backup.mjs'

export const OFFSITE_ERRORS = Object.freeze({
  RCLONE_MISSING: 'OFFSITE_RCLONE_MISSING',
  TARGET_NOT_REMOTE: 'OFFSITE_TARGET_NOT_REMOTE',
  NO_ENCRYPTED_BACKUP: 'OFFSITE_NO_ENCRYPTED_BACKUP',
  PLAINTEXT_IS_NEWEST: 'OFFSITE_PLAINTEXT_IS_NEWEST',
  PASSPHRASE_IN_SOURCE: 'OFFSITE_PASSPHRASE_IN_SOURCE',
  PASSPHRASE_MISSING: 'OFFSITE_PASSPHRASE_MISSING',
  BACKUP_STALE: 'OFFSITE_BACKUP_STALE',
  UPLOAD_FAILED: 'OFFSITE_UPLOAD_FAILED',
  READBACK_MISMATCH: 'OFFSITE_READBACK_MISMATCH',
  READBACK_UNUSABLE: 'OFFSITE_READBACK_UNUSABLE',
  PRUNE_FAILED: 'OFFSITE_PRUNE_FAILED',
})

export class OffsiteError extends Error {
  constructor(code, message) { super(message); this.name = 'OffsiteError'; this.code = code }
}

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

/** 上传白名单：**只有**加密备份。见文件头 ①。 */
export const ENCRYPTED_BACKUP_RE = /^team-.+\.db\.gpg$/
/** 明文备份：`backup.mjs` 在不给 `--passphrase-file` 时会产出它（它同时会警告）。 */
export const PLAINTEXT_BACKUP_RE = /^team-.+\.db$/

/**
 * 备份件的时间戳。按它排序就是按时间排序。
 *
 * 不用 `statSync().mtime` 排序：mtime 会被拷贝、解压、rsync 一路改掉，
 * 而文件名里的戳是**当初造它那一刻**写下的，它不会因为文件被搬过而动。
 */
export function stampOf(name) {
  const m = /^team-(.+)\.db(\.gpg)?$/.exec(name)
  return m === null ? null : m[1]
}

/**
 * 决定这一轮要传哪些、以及**为什么不传**。
 *
 * 这是纯函数（不碰磁盘、不碰网络），因为它守的是三条线里最容易出错的一条：
 * "最新那一份到底是不是加密的"。
 */
export function planUpload(files) {
  const encrypted = files.filter((f) => ENCRYPTED_BACKUP_RE.test(f)).sort()
  const plaintext = files.filter((f) => PLAINTEXT_BACKUP_RE.test(f)).sort()
  if (encrypted.length === 0) {
    throw new OffsiteError(OFFSITE_ERRORS.NO_ENCRYPTED_BACKUP,
      '备份目录里没有任何加密备份（team-*.db.gpg）。'
      + '不传明文：备份含口令哈希与设备令牌哈希，传到第三方存储比没有异地备份更坏。'
      + '先检查 backup.mjs 是否拿到了 --passphrase-file。')
  }
  // ★ 判据是"**最新那一份**是明文"，不是"目录里有明文"。
  //
  // 后者会误伤：开启加密之前留下的旧明文件会**永久**挡住异地备份，
  // 而它早已不是最新的那一份、也不再有人会去恢复它。
  // 而"最新那一份是明文"是另一件事：它说明**今天**的备份没被加密——
  // 一个会让此后每一份异地副本都暴露的、正在发生的故障。
  const newestEncrypted = stampOf(encrypted[encrypted.length - 1])
  const newestPlain = plaintext.length > 0 ? stampOf(plaintext[plaintext.length - 1]) : null
  if (newestPlain !== null && newestPlain > newestEncrypted) {
    throw new OffsiteError(OFFSITE_ERRORS.PLAINTEXT_IS_NEWEST,
      `最新一份备份是**明文**（${plaintext[plaintext.length - 1]} 晚于 ${encrypted[encrypted.length - 1]}）。`
      + '这说明今天的备份没有被加密——先修 backup.mjs 的 --passphrase-file，不要传。')
  }
  return { upload: encrypted, newest: encrypted[encrypted.length - 1], stalePlaintext: plaintext }
}

/**
 * 目标是不是**真的**异地。见文件头 ③。
 *
 * 判据是 rclone 自己的远端写法 `<名字>:<路径>`：名字只含字母数字与 `_-.`。
 * 一个不带冒号的路径（`/mnt/backup`、`./offsite`）在本机上完全合法，
 * 而它恰好是"盘坏了一起没"换了个写法的样子。
 */
export function assertRemoteTarget(target, { allowLocal = false } = {}) {
  const t = String(target ?? '').trim()
  if (t === '') throw new OffsiteError(OFFSITE_ERRORS.TARGET_NOT_REMOTE, '--remote 不能为空')
  const m = /^([A-Za-z0-9_][A-Za-z0-9_\-.]*):(.*)$/.exec(t)
  if (m !== null) return t
  if (allowLocal) { warn(`⚠ --allow-local：目标 ${t} 不是 rclone 远端，本机路径不算异地。仅用于演练。`); return t }
  throw new OffsiteError(OFFSITE_ERRORS.TARGET_NOT_REMOTE,
    `目标 ${t} 不是 rclone 远端（形如 remote:path）。`
    + '本机路径不是异地备份——盘坏了一起没，而它会看起来像已经做了异地。'
    + '确实要用本地路径（演练）请显式加 --allow-local。')
}

/**
 * 口令文件是不是落在上传目录里。见文件头 ②。
 *
 * 传了口令，异地那份的加密就与没有加密一样，而它**看起来仍然是个 .gpg 文件**——
 * 这是个不会自己暴露的错误。所以在这里拒绝，而不是靠文档提醒。
 */
export function assertPassphraseOutside(passphraseFile, dir) {
  const p = resolve(passphraseFile)
  const d = resolve(dir)
  if (p === d || p.startsWith(d + sep)) {
    throw new OffsiteError(OFFSITE_ERRORS.PASSPHRASE_IN_SOURCE,
      `口令文件在上传目录里：${p}。传了它，异地的加密就等于没有加密（而文件看起来仍是 .gpg）。`
      + '把口令放到别处（`/etc/legion-hub/` 或另一台机器），或至少移出备份目录。')
  }
  return p
}

/**
 * 最新那份备份**是不是今天的**。
 *
 * ## 为什么这里可以用 mtime，而上面排序不行
 *
 * `stampOf` 那段注释说过"排序不依赖 mtime，因为拷贝会改掉它"。那是**排序**的
 * 问题：把两份文件比大小，不能靠一个会被搬运改掉的属性。而这里是**新鲜度**的
 * 问题——"这份文件是不是刚被写出来的"——恰恰是 mtime 唯一能回答的问题，
 * 而且 `backup.mjs` 每次都是新写一个文件（不是覆盖旧文件），所以它的 mtime
 * 就是它诞生那一刻。
 *
 * ## 它挡住的是什么
 *
 * 备份单元失败之后，同步单元**照常**会把上一次的旧文件传过去，然后报成功——
 * 于是异地多了一份"看起来是今天的"备份，而它其实是三天前的。
 *   > 一个"同步成功了但同步的是旧文件"的异地备份，与一个"没有异地备份"，
 *   > 在出事那天是同一个东西——只不过前者让人以为不必再管。
 */
export function assertFresh(file, { nowMs = Date.now(), maxAgeHours = 26 } = {}) {
  const ageMs = nowMs - statSync(file).mtimeMs
  const ageHours = ageMs / 3_600_000
  if (ageHours > maxAgeHours) {
    throw new OffsiteError(OFFSITE_ERRORS.BACKUP_STALE,
      `最新那份备份已有 ${ageHours.toFixed(1)} 小时（上限 ${maxAgeHours}）——它不像今天造的。`
      + '同步一份旧的过去，只会让异地看起来是新的。先查 legion-hub-backup 为什么没跑成：\n'
      + '  systemctl status legion-hub-backup.service && journalctl -u legion-hub-backup.service -n 50')
  }
  return { file, ageHours }
}

/** 前 16 字节是不是 SQLite 头。用来在"传上去之前"认出一次没加密的意外。 */
export function looksLikeSqlite(head) {
  return Buffer.isBuffer(head) && head.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000'
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function headOf(file, n = 16) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const read = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } finally { closeSync(fd) }
}

function parseArgv(argv) {
  const o = { dir: null, remote: null, passphraseFile: null, keep: 3, maxAgeHours: 26, dryRun: false, allowLocal: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--dir') o.dir = next()
    else if (a === '--remote') o.remote = next()
    else if (a === '--passphrase-file') o.passphraseFile = next()
    else if (a === '--keep') o.keep = Number(next())
    else if (a === '--max-age-hours') o.maxAgeHours = Number(next())
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--allow-local') o.allowLocal = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new OffsiteError('OFFSITE_BAD_ARG', `未知参数：${a}`)
  }
  return o
}

/** rclone 的调用出口。可注入，用例因此不必装 rclone、也不必联网。 */
export function makeRcloneRunner({ env = process.env, timeoutMs = 15 * 60 * 1000 } = {}) {
  return (args) => {
    const r = spawnSync('rclone', args, { encoding: 'utf8', env, timeout: timeoutMs })
    if (r.error !== undefined && r.error !== null) {
      // `ENOENT` 的修法（装 rclone）与"远端连不上"完全不同，所以要分开报。
      if (r.error.code === 'ENOENT') {
        throw new OffsiteError(OFFSITE_ERRORS.RCLONE_MISSING,
          '没找到 rclone。安装：`curl https://rclone.org/install.sh | sudo bash`，'
          + '或 `apt install rclone`（版本较旧）。')
      }
      throw new OffsiteError(OFFSITE_ERRORS.UPLOAD_FAILED, `rclone 起不来：${r.error.message}`)
    }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
}

/**
 * 跑一轮异地同步。
 *
 * @param {object} deps
 * @param {string} deps.dir 本地备份目录
 * @param {string} deps.remote rclone 远端（`remote:path`）
 * @param {string} deps.passphraseFile gpg 口令文件（**不上传**，只用于读回验证）
 * @param {number} [deps.keep] 远端保留份数
 * @param {boolean} [deps.dryRun]
 * @param {(args: string[]) => {status:number, stdout:string, stderr:string}} deps.run
 */
export function runOffsite({ dir, remote, passphraseFile, keep = 3, dryRun = false, allowLocal = false, maxAgeHours = 26, run }) {
  const files = readdirSync(dir)
  const plan = planUpload(files)
  const target = assertRemoteTarget(remote, { allowLocal })
  // 顺序有意：先问"这份新不新"，再问"口令放没放错地方"。
  // 一个只报"口令位置不对"、却没说"备份是旧的"的运行，会让人修掉一个次要问题、
  // 以为就好了——而那时数据保护仍然是坏的。
  const fresh = assertFresh(join(dir, plan.newest), { maxAgeHours })
  const passPath = assertPassphraseOutside(passphraseFile, dir)
  if (!existsSync(passPath)) {
    throw new OffsiteError(OFFSITE_ERRORS.PASSPHRASE_MISSING,
      `口令文件不存在：${passPath}。读回验证要用它解密——没有它就无法证明异地那份可用，`
      + '而"传上去了但没验证"正是本脚本存在的理由。')
  }

  log(`① 上传集合（白名单 team-*.db.gpg，共 ${plan.upload.length} 份）→ ${target}`)
  log(`   最新一份 ${plan.newest}（${fresh.ageHours.toFixed(1)} 小时前造）`)
  for (const f of plan.upload) log(`   ${f}  ${(statSync(join(dir, f)).size / 1024 / 1024).toFixed(2)} MB`)
  if (plan.stalePlaintext !== undefined && plan.stalePlaintext.length > 0) {
    warn(`   注意：目录里还有 ${plan.stalePlaintext.length} 份旧**明文**备份（不上传）：${plan.stalePlaintext.join(' ')}`)
  }

  // ★ 传之前先自己认一遍：一个被改名的明文库会以 .gpg 的样子混进白名单。
  for (const f of plan.upload) {
    if (looksLikeSqlite(headOf(join(dir, f)))) {
      throw new OffsiteError(OFFSITE_ERRORS.PLAINTEXT_IS_NEWEST,
        `${f} 的头部是 SQLite 库，不是 gpg 密文。文件名说是加密的，内容说不是——`
        + '先查清它怎么来的，不要传。')
    }
  }

  if (dryRun) { log('   --dry-run：到此为止，不传不验不轮转。'); return { ok: true, dryRun: true, planned: plan.upload } }

  const result = { ok: false, uploaded: [], verified: [], pruned: [] }
  for (const f of plan.upload) {
    const r = run(['copyto', join(dir, f), `${target}/${f}`, '--checksum'])
    if (r.status !== 0) {
      throw new OffsiteError(OFFSITE_ERRORS.UPLOAD_FAILED, `rclone copyto ${f} 失败（退出码 ${r.status}）：${r.stderr.trim().slice(0, 400)}`)
    }
    result.uploaded.push(f)
  }
  log(`② 已上传 ${result.uploaded.length} 份`)

  // ★ 读回验证：把**刚传上去的那一份**重新拉下来，解密，用真实 SQLite 打开。
  //   比 sha256 更强的地方在于它走的是**恢复时真正会走的那条路**
  //   （下载 → gpg → 打开库），而 sha256 只证明字节没变。
  log('③ 读回验证（拉回来 → 解密 → integrity_check + 关键表）')
  const tmp = mkdtempSync(join(tmpdir(), 'legion-offsite-'))
  try {
    for (const f of result.uploaded) {
      const back = join(tmp, f)
      const r = run(['copyto', `${target}/${f}`, back, '--checksum'])
      if (r.status !== 0) {
        throw new OffsiteError(OFFSITE_ERRORS.READBACK_MISMATCH, `从远端取回 ${f} 失败（退出码 ${r.status}）：${r.stderr.trim().slice(0, 400)}`)
      }
      const local = sha256File(join(dir, f))
      const remoteSum = sha256File(back)
      if (local !== remoteSum) {
        throw new OffsiteError(OFFSITE_ERRORS.READBACK_MISMATCH,
          `${f} 取回来的内容与本地不一致：\n  本地 ${local}\n  远端 ${remoteSum}`)
      }
      const plain = join(tmp, `${f}.db`)
      const g = spawnSync('gpg', ['--batch', '--yes', '--quiet', '--decrypt', '--passphrase-file', passPath, '--output', plain, back], { encoding: 'utf8' })
      if (g.status !== 0) {
        throw new OffsiteError(OFFSITE_ERRORS.READBACK_UNUSABLE,
          `${f} 用当前口令解不开（gpg 退出码 ${g.status}）：${(g.stderr ?? '').trim().slice(0, 300)}\n`
          + '  ⚠ 若口令刚被重新生成过，那么**此前每一份备份都解不开**——这不是文件的问题。')
      }
      const info = inspectSnapshot(plain)
      if (!info.ok) {
        throw new OffsiteError(OFFSITE_ERRORS.READBACK_UNUSABLE,
          `${f} 解密后不是一个可用的 Legion 库：integrity=${info.integrity}，缺表=[${info.missing.join(',')}]`)
      }
      log(`   ✔ ${f}：sha256 一致，integrity=ok，关键表 ${Object.keys(info.counts).length} 张`)
      result.verified.push({ file: f, sha256: local, counts: info.counts })
    }
  } finally { rmSync(tmp, { recursive: true, force: true }) }

  // ④ 远端轮转：与本地一样保留最近 N 份。远端不留到无限，否则"异地"会自己长成
  //    一个没人管的、比生产数据还大的副本集合。
  log(`④ 远端轮转：保留最近 ${keep} 份`)
  const ls = run(['lsf', `${target}/`, '--files-only', '--include', 'team-*.db.gpg'])
  if (ls.status !== 0) {
    throw new OffsiteError(OFFSITE_ERRORS.PRUNE_FAILED, `列远端失败（退出码 ${ls.status}）：${ls.stderr.trim().slice(0, 300)}`)
  }
  const remoteFiles = ls.stdout.split('\n').map((s) => s.trim()).filter((s) => ENCRYPTED_BACKUP_RE.test(s)).sort()
  const excess = remoteFiles.slice(0, Math.max(0, remoteFiles.length - keep))
  for (const f of excess) {
    const d = run(['deletefile', `${target}/${f}`])
    if (d.status !== 0) {
      throw new OffsiteError(OFFSITE_ERRORS.PRUNE_FAILED, `删远端 ${f} 失败（退出码 ${d.status}）：${d.stderr.trim().slice(0, 300)}`)
    }
    log(`   删除 ${f}`)
    result.pruned.push(f)
  }

  result.ok = true
  return result
}

function main() {
  const o = parseArgv(process.argv.slice(2))
  if (o.help === true || o.dir === null || o.remote === null) {
    log('用法：node product/server/offsite.mjs --dir <备份目录> --remote <rclone 远端> --passphrase-file <口令文件>')
    log('      [--keep N] [--dry-run] [--allow-local]')
    log('说明：只上传 team-*.db.gpg（白名单），并把刚传上去的那份拉回来解密验证。')
    log('      口令文件绝不上传；它若在 --dir 里，本脚本拒绝执行。')
    return o.help === true ? 0 : 2
  }
  if (o.passphraseFile === null) {
    warn('缺少 --passphrase-file：读回验证要用它解密，没有它就无法证明异地那份可用。')
    return 2
  }
  try {
    const r = runOffsite({
      dir: resolve(o.dir), remote: o.remote, passphraseFile: resolve(o.passphraseFile),
      keep: o.keep, maxAgeHours: o.maxAgeHours, dryRun: o.dryRun, allowLocal: o.allowLocal, run: makeRcloneRunner(),
    })
    log(JSON.stringify(r, null, 2))
    return 0
  } catch (e) {
    if (e instanceof OffsiteError) { warn(`✖ ${e.code}：${e.message}`); return 1 }
    warn(`✖ 未预期的失败：${e?.stack ?? e}`)
    return 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  process.exit(main())
}

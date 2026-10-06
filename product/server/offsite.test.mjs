// product/server/offsite.test.mjs
// 异地备份。守的是"传上去了"与"取得回来"之间的那道缝——
// 缝的这一边退出码是 0、远端列表里有那个文件、大小也对得上，
// 而另一边要到出事那天才发现取不回来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  ENCRYPTED_BACKUP_RE,
  OFFSITE_ERRORS,
  OffsiteError,
  assertFresh,
  assertPassphraseOutside,
  assertRemoteTarget,
  looksLikeSqlite,
  makeRcloneRunner,
  planUpload,
  runOffsite,
  stampOf,
} from './offsite.mjs'

const codeOf = (fn) => { try { fn(); return null } catch (e) { return e instanceof OffsiteError ? e.code : `UNEXPECTED:${e.message}` } }

/** 造一个只有一份备份、mtime 指定在某刻的现场（验新鲜度用）。 */
function sceneAt(mtime) {
  const root = mkdtempSync(join(tmpdir(), 'legion-offsite-fresh-'))
  const dir = join(root, 'backups')
  mkdirSync(dir)
  const file = join(dir, 'team-2026-10-06_03-17-00.db.gpg')
  writeFileSync(file, Buffer.from([0x8c, 0x0d, 0x01]))
  utimesSync(file, mtime, mtime)
  return { root, dir, file }
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-offsite-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 造一个"备份目录 + 目录外的口令文件"的现场。
 *
 * 清理挂在 `t.after` 上而不是在这里 `finally`：现场是要**交给用例继续用**的，
 * 在返回值处就删掉等于把一个已经不存在的目录递出去（首版就是这么写的，
 * 五个用例一起红，红的理由全都是 `ENOENT: scandir`）。
 */
function scene(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'legion-offsite-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'backups')
  mkdirSync(dir)
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
  const pass = join(root, 'backup.passphrase')
  writeFileSync(pass, 'x'.repeat(40), 'utf8')
  return { root, dir, pass }
}

// ── 白名单与"最新那份是不是加密的" ─────────────────────────────────────────

test('只挑加密件；时间戳按文件名排序，不依赖 mtime', () => {
  assert.equal(ENCRYPTED_BACKUP_RE.test('team-2026-10-05_03-17-00.db.gpg'), true)
  assert.equal(ENCRYPTED_BACKUP_RE.test('team-2026-10-05_03-17-00.db'), false)
  assert.equal(stampOf('team-2026-10-05_03-17-00.db.gpg'), '2026-10-05_03-17-00')
  assert.equal(stampOf('team-2026-10-05_03-17-00.db'), '2026-10-05_03-17-00')
  assert.equal(stampOf('rclone.conf'), null)
})

test('一份加密备份都没有 → 具名拒绝，绝不传明文', () => {
  assert.equal(codeOf(() => planUpload(['team-2026-10-05_03-17-00.db', 'rclone.conf', '.write-probe-1'])),
    OFFSITE_ERRORS.NO_ENCRYPTED_BACKUP)
})

test('**最新那一份**是明文 → 拒绝（说明今天的备份没加密）', () => {
  assert.equal(codeOf(() => planUpload([
    'team-2026-10-05_03-17-00.db.gpg',
    'team-2026-10-06_03-17-00.db', // 更晚，且是明文
  ])), OFFSITE_ERRORS.PLAINTEXT_IS_NEWEST)
})

test('旧明文不受影响：开启加密之前的遗留不永久挡住异地备份', () => {
  // 判据若是"目录里有明文"，这几份早年的遗留会让异地备份**永远**做不成，
  // 而它们早已不是最新的那一份、也不再有人会去恢复它。
  const plan = planUpload([
    'team-2026-09-01_03-17-00.db',
    'team-2026-10-05_03-17-00.db.gpg',
    'team-2026-10-06_03-17-00.db.gpg',
  ])
  assert.deepEqual(plan.upload, ['team-2026-10-05_03-17-00.db.gpg', 'team-2026-10-06_03-17-00.db.gpg'])
  assert.equal(plan.newest, 'team-2026-10-06_03-17-00.db.gpg')
  assert.deepEqual(plan.stalePlaintext, ['team-2026-09-01_03-17-00.db'])
})

// ── 目标必须真的是异地 ────────────────────────────────────────────────────

test('带冒号的 rclone 远端通过', () => {
  assert.equal(assertRemoteTarget('legion-b2:legion-hub'), 'legion-b2:legion-hub')
  assert.equal(assertRemoteTarget('s3:bucket/hub'), 's3:bucket/hub')
  assert.equal(assertRemoteTarget('  spaced:path  '), 'spaced:path')
})

test('本机路径默认拒绝：盘坏了一起没，而它会看起来像已经做了异地', () => {
  assert.equal(codeOf(() => assertRemoteTarget('/mnt/backup')), OFFSITE_ERRORS.TARGET_NOT_REMOTE)
  assert.equal(codeOf(() => assertRemoteTarget('./offsite')), OFFSITE_ERRORS.TARGET_NOT_REMOTE)
  assert.equal(codeOf(() => assertRemoteTarget('')), OFFSITE_ERRORS.TARGET_NOT_REMOTE)
  assert.equal(assertRemoteTarget('/mnt/backup', { allowLocal: true }), '/mnt/backup')
})

// ── 口令不许被传 ──────────────────────────────────────────────────────────

test('口令文件在上传目录里 → 拒绝执行（传了它，加密就等于没有加密）', () => withDir((dir) => {
  assert.equal(codeOf(() => assertPassphraseOutside(join(dir, 'backup.passphrase'), dir)),
    OFFSITE_ERRORS.PASSPHRASE_IN_SOURCE)
  assert.equal(codeOf(() => assertPassphraseOutside(dir, dir)), OFFSITE_ERRORS.PASSPHRASE_IN_SOURCE)
}))

test('口令文件在目录外 → 通过', () => withDir((dir) => {
  const inside = join(dir, 'backups')
  mkdirSync(inside, { recursive: true })
  assert.equal(assertPassphraseOutside(join(dir, 'backup.passphrase'), inside), join(dir, 'backup.passphrase'))
}))

// ── 认得出"改名成 .gpg 的明文库" ──────────────────────────────────────────

test('SQLite 头被认出来（一个被改名的明文库会以 .gpg 的样子混进白名单）', () => {
  assert.equal(looksLikeSqlite(Buffer.from('SQLite format 3\u0000rest-of-header')), true)
  // gpg 产出的 OpenPGP 包：首字节高位为 1，且不是 SQLite 头
  assert.equal(looksLikeSqlite(Buffer.from([0x8c, 0x0d, 0x04, 0x09, 0x08, 0x00])), false)
  assert.equal(looksLikeSqlite(Buffer.from('')), false)
})

test('目录里混进一个改名成 .gpg 的明文库 → 传之前就被拦下', () => withDir((root) => {
  const dir = join(root, 'backups'); mkdirSync(dir)
  writeFileSync(join(dir, 'team-2026-10-06_03-17-00.db.gpg'), 'SQLite format 3\u0000not-really-gpg')
  writeFileSync(join(root, 'pass'), 'x'.repeat(40), 'utf8')
  const code = codeOf(() => runOffsite({
    dir, remote: 'remote:path', passphraseFile: join(root, 'pass'),
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  }))
  assert.equal(code, OFFSITE_ERRORS.PLAINTEXT_IS_NEWEST)
}))

// ── 新鲜度：挡住"备份失败 → 同步旧文件 → 报成功" ──────────────────────────

test('最新那份是新鲜的 → 通过', () => {
  const { dir } = sceneAt(new Date())
  assert.ok(assertFresh(join(dir, 'team-2026-10-06_03-17-00.db.gpg')).ageHours < 1)
})

test('最新那份是三天前的 → 具名拒绝，不让异地看起来是新的', () => {
  const old = new Date(Date.now() - 72 * 3_600_000)
  const { dir } = sceneAt(old)
  assert.equal(codeOf(() => assertFresh(join(dir, 'team-2026-10-06_03-17-00.db.gpg'))), OFFSITE_ERRORS.BACKUP_STALE)
})

test('新鲜度问的是"我手上这份是不是今天的"，不是"上一个单元怎么了"', () => {
  // 同一个判据也挡住"备份单元成功、但库根本没被写"那一类——
  // 那时单元是成功的，而文件是旧的。
  const { dir } = sceneAt(new Date(Date.now() - 26.5 * 3_600_000))
  assert.equal(codeOf(() => assertFresh(join(dir, 'team-2026-10-06_03-17-00.db.gpg'))), OFFSITE_ERRORS.BACKUP_STALE)
  // 边界之内仍然通过：26 小时的默认上限给足了一次补跑 + 一次手动重试的余量。
  const { dir: ok } = sceneAt(new Date(Date.now() - 25 * 3_600_000))
  assert.equal(codeOf(() => assertFresh(join(ok, 'team-2026-10-06_03-17-00.db.gpg'))), null)
})

// ── 读回验证：本脚本存在的理由 ────────────────────────────────────────────

test('读回验证：取回来的字节与本地不一致 → 具名失败，不报成功', (t) => {
  const { dir, pass } = scene(t, {
    'team-2026-10-05_03-17-00.db.gpg': Buffer.from([0x8c, 0x0d, 0x01, 0x02, 0x03]),
    'team-2026-10-06_03-17-00.db.gpg': Buffer.from([0x8c, 0x0d, 0x01, 0x02, 0x03]),
  })
  const content = new Map()
  const run = (args) => {
    if (args[0] === 'copyto' && args[1].startsWith('remote:')) {
      // 上传：记下本地内容；下载：写出**内容不同**的一份
      if (args[2].startsWith('remote:')) { content.set(args[2], true); return { status: 0, stdout: '', stderr: '' } }
      writeFileSync(args[2], Buffer.from([0x8c, 0x0d, 0xff, 0xff, 0xff]))
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  assert.equal(codeOf(() => runOffsite({ dir, remote: 'remote:path', passphraseFile: pass, run })),
    OFFSITE_ERRORS.READBACK_MISMATCH)
})

test('上传失败 → 具名失败，且不会走到"已验证"', (t) => {
  const { dir, pass } = scene(t, { 'team-2026-10-06_03-17-00.db.gpg': Buffer.from([0x8c, 0x0d, 0x01]) })
  const code = codeOf(() => runOffsite({
    dir, remote: 'remote:path', passphraseFile: pass,
    run: () => ({ status: 1, stdout: '', stderr: 'connection refused' }),
  }))
  assert.equal(code, OFFSITE_ERRORS.UPLOAD_FAILED)
})

test('口令文件不存在 → 具名拒绝：没有它就无法证明异地那份可用', (t) => {
  const { dir } = scene(t, { 'team-2026-10-06_03-17-00.db.gpg': Buffer.from([0x8c, 0x0d, 0x01]) })
  const code = codeOf(() => runOffsite({
    dir, remote: 'remote:path', passphraseFile: join(dir, '..', 'nope.passphrase'),
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  }))
  assert.equal(code, OFFSITE_ERRORS.PASSPHRASE_MISSING)
})

test('缺 rclone 与"远端连不上"分开报：两者的修法完全不同', () => {
  const missing = makeRcloneRunner({ env: { PATH: '/nonexistent-dir-xyz' } })
  assert.equal(codeOf(() => missing(['version'])), OFFSITE_ERRORS.RCLONE_MISSING)
})

// ── 进程入口（真跑一次，验的是人真正会遇到的那一条） ──────────────────────

test('进程入口：本机路径被拒时退出码非零，且说的是"不是异地"', (t) => {
  const { dir, pass } = scene(t, { 'team-2026-10-06_03-17-00.db.gpg': Buffer.from([0x8c, 0x0d, 0x01]) })
  const r = spawnSync(process.execPath, [
    new URL('./offsite.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    '--dir', dir, '--remote', '/mnt/backup', '--passphrase-file', pass,
  ], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /不是 rclone 远端/)
})

test('进程入口：--dry-run 只列计划，不调用 rclone', (t) => {
  const { dir, pass } = scene(t, { 'team-2026-10-06_03-17-00.db.gpg': Buffer.from([0x8c, 0x0d, 0x01]) })
  const r = spawnSync(process.execPath, [
    new URL('./offsite.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    '--dir', dir, '--remote', 'remote:path', '--passphrase-file', pass, '--dry-run',
  ], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /dry-run/)
})

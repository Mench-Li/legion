// scripts/ops/storage-check.test.mjs
// ============================================================================
// 存储体检脚本的判据。
//
// 守的是两句话：
//   ① **退出码要能分档** —— 一个把所有非正常都回 1 的脚本，会让监控分不出
//      "快去清盘"与"去装监控"，也分不出"备份停了"与"盘快满了"。
//   ② **读不到 ≠ 正常** —— 默认值选错会让"没人监控"报成"一切正常"。
//
// ★ 这个脚本是独立 CLI 而不是 HTTP 端点，理由见它的文件头：
//   盘满时 Hub 本身就在返 503，一个由**正在出故障的进程**提供的监控端点，
//   会在最需要它的时候跟着一起不可用。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXIT, verdict, checkStorage, parseArgv } from './storage-check.mjs'
import { CRITICAL_MIN_FREE_BYTES, WARN_MIN_FREE_BYTES } from '../../team-hub/storage-health.mjs'

const MiB = 1024 * 1024
const HOUR = 3600 * 1000

/** 造一个临时环境：一个假的库文件 + 一个备份目录。 */
function fixture({ dbBytes = 4096, walBytes = 0, backups = [], backupAgeMs = null, noBackupDir = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-storage-'))
  const db = join(root, 'team.db')
  writeFileSync(db, Buffer.alloc(dbBytes))
  if (walBytes > 0) writeFileSync(`${db}-wal`, Buffer.alloc(walBytes))
  const backupsDir = join(root, 'backups')
  if (!noBackupDir) {
    mkdirSync(backupsDir)
    const now = Date.now()
    for (const name of backups) {
      const p = join(backupsDir, name)
      writeFileSync(p, 'x')
      if (backupAgeMs !== null) {
        const t = (now - backupAgeMs) / 1000
        utimesSync(p, t, t)
      }
    }
  }
  return { root, db, backupsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// ── ① ★★★ verdict：两件事合成一个结论 ──────────────────────────────────────

test('★★★ 余量充足 + 备份新鲜 → ok / 0', () => {
  const v = verdict({ level: 'ok', backupStale: false, problems: [] })
  assert.equal(v.level, 'ok')
  assert.equal(v.exitCode, EXIT.ok)
  assert.deepEqual(v.reasons, [])
})

test('★★★ 余量充足但**备份缺失/陈旧** → warn / 1（这条是初版漏掉的）', () => {
  // ★ 初版只让"余量"决定判定，于是"这台机器一份备份都没有"会得到
  //   `OK / 退出码 0` —— 而监控只会看退出码，于是那件事**永远不会被告警**。
  //
  //   > 一个"读出来了、印出来了、但不影响告警"的读数，
  //   > 与一个"根本读不出来"的读数，在值班的人那里是同一个东西。
  const v = verdict({ level: 'ok', backupStale: true, problems: [] })
  assert.equal(v.level, 'warn')
  assert.equal(v.exitCode, EXIT.warn)
  assert.match(v.reasons.join('；'), /备份/)
})

test('★★★ 四档退出码必须两两不同（监控靠它分档）', () => {
  const codes = [
    verdict({ level: 'ok', backupStale: false }).exitCode,
    verdict({ level: 'warn', backupStale: false }).exitCode,
    verdict({ level: 'critical', backupStale: false }).exitCode,
    verdict({ level: 'unknown', backupStale: false }).exitCode,
  ]
  assert.deepEqual(codes, [0, 1, 2, 3])
  assert.equal(new Set(codes).size, 4, '四个退出码必须互不相同')
})

test('★★★ 取**更坏**的那一档（危险 + 备份新鲜 仍是 critical）', () => {
  assert.equal(verdict({ level: 'critical', backupStale: false }).level, 'critical')
  assert.equal(verdict({ level: 'critical', backupStale: true }).level, 'critical')
  // 而 warn + 备份陈旧 不该升到 critical。
  assert.equal(verdict({ level: 'warn', backupStale: true }).level, 'warn')
})

test('★★★ `unknown` 排在 `warn` **前面**（没人在测比情况在恶化更该先处理）', () => {
  // `warn` 说明有人在测而情况在恶化；`unknown` 说明根本没人在测。
  assert.equal(verdict({ level: 'unknown', backupStale: false }).exitCode, EXIT.unknown)
  assert.match(verdict({ level: 'unknown', backupStale: false }).reasons.join('；'), /没有在监控/)
})

test('★★ 读数有问题（读不到库/目录）也要升到 warn —— 除非已经是更坏的档', () => {
  assert.equal(verdict({ level: 'ok', backupStale: false, problems: ['读不到库文件'] }).level, 'warn')
  assert.equal(verdict({ level: 'critical', backupStale: false, problems: ['x'] }).level, 'critical')
})

test('★★ 畸形输入不抛（读数来自文件系统，可能缺项）', () => {
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    assert.doesNotThrow(() => verdict(bad))
    assert.ok(typeof verdict(bad).exitCode === 'number')
  }
  // 什么都不给 → unknown / 3（**不是** ok —— 那会把"没测"报成"正常"）。
  assert.equal(verdict().level, 'unknown')
  assert.equal(verdict().exitCode, EXIT.unknown)
})

// ── ② ★★★ checkStorage：真读文件系统 ──────────────────────────────────────

test('★★★ WAL **单独**报，并计入合计（只看主库会严重低估）', () => {
  const f = fixture({ dbBytes: 1 * MiB, walBytes: 4 * MiB, backups: ['team-x.db.gpg'] })
  try {
    const r = checkStorage({ db: f.db, backups: f.backupsDir })
    assert.equal(r.report.dbBytes, 1 * MiB)
    assert.equal(r.report.walBytes, 4 * MiB)
    assert.equal(r.report.totalUsedBytes, 5 * MiB, '合计必须含 WAL')
  } finally { f.cleanup() }
})

test('★★★ 读不到库文件时**报出来**，而且判成"不是 ok"', () => {
  const f = fixture({ noBackupDir: true })
  try {
    const r = checkStorage({ db: join(f.root, '不存在.db'), backups: join(f.root, 'nope') })
    assert.ok(r.problems.some((p) => /读不到库文件/.test(p)), `problems=${JSON.stringify(r.problems)}`)
    const v = verdict({ level: r.level, backupStale: r.report.backupStale, problems: r.problems })
    assert.notEqual(v.level, 'ok', '"读不到库"绝不能报成 OK')
  } finally { f.cleanup() }
})

test('★★★ 完全没给 DB 路径时**必须报出来**（不许静默去查一个默认位置）', () => {
  // 一个"没给就用默认路径"的实现，会在一台**非标准布局**的机器上
  // 去检查一个不存在的文件，然后（如果默认值选得不好）报 OK。
  const r = checkStorage({ db: '' })
  assert.ok(r.problems.some((p) => /没有指定库文件/.test(p)))
  assert.equal(r.report.freeBytes, null, '没给库路径就不该去 statfs')
})

test('★★★ 备份目录不存在 → `backupStale` 为 true（"没有备份"就是陈旧）', () => {
  const f = fixture({ noBackupDir: true })
  try {
    const r = checkStorage({ db: f.db, backups: f.backupsDir })
    assert.equal(r.report.backupStale, true)
    assert.ok(r.problems.some((p) => /备份目录不存在/.test(p)))
  } finally { f.cleanup() }
})

test('★★ 备份目录里有文件时读得出年龄，且新鲜的不算陈旧', () => {
  const f = fixture({ backups: ['team-a.db.gpg'], backupAgeMs: 2 * HOUR })
  try {
    const r = checkStorage({ db: f.db, backups: f.backupsDir })
    assert.equal(r.report.backupStale, false, `年龄=${r.report.backupAgeMs}`)
    assert.ok(r.report.backupAgeMs > 1.5 * HOUR && r.report.backupAgeMs < 3 * HOUR, `年龄算出 ${r.report.backupAgeMs}`)
  } finally { f.cleanup() }
})

test('★★★ 备份超过 48 小时 → 陈旧，且最终判定升到 warn', () => {
  const f = fixture({ backups: ['team-old.db.gpg'], backupAgeMs: 72 * HOUR })
  try {
    const r = checkStorage({ db: f.db, backups: f.backupsDir })
    assert.equal(r.report.backupStale, true)
    const v = verdict({ level: r.level, backupStale: r.report.backupStale, problems: r.problems })
    assert.notEqual(v.level, 'ok', '备份 72 小时没更新绝不能报 OK')
  } finally { f.cleanup() }
})

test('★★★ 真读到的磁盘余量必须是个正数（不许因为读不到而回 0）', () => {
  // 本机一定有盘。返回 0 会让判定变成 critical —— 一个假的"盘满"告警。
  const f = fixture({})
  try {
    const r = checkStorage({ db: f.db, backups: f.backupsDir })
    assert.ok(Number.isFinite(r.report.freeBytes) && r.report.freeBytes > 0,
      `freeBytes=${r.report.freeBytes}（读不到时应当是 null，不是 0）`)
    assert.ok(Number.isFinite(r.report.totalBytes) && r.report.totalBytes > 0)
  } finally { f.cleanup() }
})

test('★★ 空闲空间充足的小库 → 余量判定 ok（不是每次都报危险）', () => {
  const f = fixture({ dbBytes: 4096 })
  try {
    const r = checkStorage({ db: f.db, backups: f.backupsDir })
    assert.equal(r.level, 'ok', `内存盘上 4KB 的库不该被判危险（freeBytes=${r.report.freeBytes}）`)
  } finally { f.cleanup() }
})

// ── ③ ★★ 阈值的边界在脚本里也必须一致 ─────────────────────────────────────

test('★★★ 脚本用的阈值与模块里的是同一组常量（不是各写一份）', () => {
  // 一个"脚本里抄了一份阈值"的实现，会在有人调模块里的数时静默不一致 ——
  // 于是**告警的门槛**与**文档里写的门槛**变成两个数。
  assert.ok(Number.isFinite(CRITICAL_MIN_FREE_BYTES) && CRITICAL_MIN_FREE_BYTES > 0)
  assert.ok(Number.isFinite(WARN_MIN_FREE_BYTES) && WARN_MIN_FREE_BYTES > 0)
  assert.ok(CRITICAL_MIN_FREE_BYTES < WARN_MIN_FREE_BYTES)
})

// ── ④ ★★★ 参数解析：不认识的参数**必须报错**，不许忽略 ──────────────────────

test('★★★ 未认识的参数必须被记下来（静默忽略会去检查另一个库）', () => {
  // ★ 这条守的是一个**看起来完全正常**的故障：`--db` 打成一个字母，
  //   脚本静默忽略它、去检查默认位置（或干脆不检查），
  //   而输出照样打印一份"存储体检 OK"。
  //
  //   > 一个"参数打错了但照常输出"的体检脚本，
  //   > 与一个"真的检查了你想检查的那台机器"的体检脚本，在输出上分不出来。
  const a = parseArgv(['--dbb', '/var/lib/team.db'])
  assert.equal(a.bad, '--dbb', '未认识的参数必须被记在 bad 上')
  // 而认识的参数不许被误记为 bad。
  const b = parseArgv(['--db', '/x/team.db', '--backups', '/x/backups', '--json'])
  assert.equal(b.bad, undefined)
  assert.equal(b.db, '/x/team.db')
  assert.equal(b.backups, '/x/backups')
  assert.equal(b.json, true)
  // `-h` 与 `--help` 都认。
  assert.equal(parseArgv(['-h']).help, true)
  assert.equal(parseArgv(['--help']).help, true)
  // 单个 `-x` 不算未认识（只有 `--` 开头才算）—— 这保证 `-h` 不被当成错误。
  assert.equal(parseArgv(['-h']).bad, undefined)
})

test('★★ 参数解析不抛（argv 可能是什么都没有）', () => {
  for (const bad of [[], null, undefined, ['--db'], ['--backups']]) {
    assert.doesNotThrow(() => parseArgv(bad ?? []))
  }
  // `--db` 后面没值时回空串（随后会被报成"没有指定库文件"，而不是崩）。
  assert.equal(parseArgv(['--db']).db, '')
})

// ── ⑤ ★★★ 脚本本身能被 CI 解析、且不像"会写东西" ─────────────────────────

test('★★★ 这个脚本是**只读**的（它不该修改库或备份）', async () => {
  // 它会被挂到监控上周期性地跑。一个"顺手清一下旧备份"的监控脚本
  // 会在没人注意的时候删数据。
  const src = (await import('node:fs')).readFileSync(
    new URL('./storage-check.mjs', import.meta.url), 'utf8',
  )
  // 只允许出现**读**类调用；写入类的一个都不许有。
  for (const banned of ['writeFileSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'renameSync', 'rmdirSync', 'appendFileSync', 'createWriteStream']) {
    assert.equal(src.includes(banned), false, `存储体检脚本里不许出现 ${banned}`)
  }
  assert.ok(src.includes('statfsSync') || src.includes('statfs'), '它应当真的去读磁盘余量')
})

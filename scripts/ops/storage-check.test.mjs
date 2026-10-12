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
import { join, sep } from 'node:path'

import { EXIT, verdict, checkStorage, parseArgv, statePathCheck } from './storage-check.mjs'
import { CRITICAL_MIN_FREE_BYTES, WARN_MIN_FREE_BYTES } from '../../team-hub/storage-health.mjs'
import { codeOnly } from '../../scripts/lib/code-only.mjs'
import { DEFAULT_STATE_PATH } from '../../team-hub/storage-state.mjs'

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

/**
 * 读源码，并且**只看代码行**。
 *
 * ★ 这是被同一个坑绊到**第三次**之后抽出来的：
 *   在源码里找"某个名字有没有出现"时，写实现的人**正好也会在自己的注释里
 *   提到那个名字** —— 于是判据在完全正确的实现上变红。
 *
 *   前两次：`storageErrorShape` 的计数（`storage-health.test.mjs`）、
 *   以及这里 `rmSync` 出现在我解释这条判据的那段注释里。
 *
 *   > 一个"在注释里解释某条规则"的实现，
 *   > 与一个"真的违反那条规则"的实现，在按子串搜索的判据眼里一模一样。
 */
async function codeOf(rel) {
  const src = (await import('node:fs')).readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  return src.split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('*/')
    })
    .join('\n')
}

// ── ⑤ ★★★ 写入面：它现在会写状态文件，但**只能**写到该写的地方 ────────────
//
// ★ 这一节原本是一条"脚本必须**只读**"的判据（禁止出现任何写入调用）。
//   加上状态落盘之后它红了 —— 而它红得**有道理**：脚本从此有了一条
//   **数据丢失**路径，那条路径在加状态之前根本不存在。
//
//   最容易的做法是把判据放宽成"现在允许写了"，那等于把这条安全性质直接删掉。
//   所以改成**更强**的一组：既然必须写，就保证只能写到该写的地方。
//
//   > 一个"因为实现变了就放宽"的判据，
//   > 与一个从来没写过的判据，在事故之后看起来是一样的。

test('★★★ 仍然禁止**删除/追加/整树**类的调用（体检绝不该清东西）', async () => {
  const code = await codeOf('./storage-check.mjs')
  // `unlinkSync` 只允许用于**收尾自己的临时文件**（见下一条），
  // 而整树删除、追加、截断、拷贝一律禁止。
  for (const banned of ['rmSync', 'rmdirSync', 'appendFileSync', 'createWriteStream', 'truncateSync', 'copyFileSync']) {
    assert.equal(code.includes(banned), false, `存储体检脚本的**代码**里不许出现 ${banned}`)
  }
  assert.ok(code.includes('statfsSync') || code.includes('statfs'), '它应当真的去读磁盘余量')
})

test('★★★ `unlinkSync` 只出现在**声明写入面**那一处', async () => {
  const code = await codeOf('./storage-check.mjs')
  const calls = code.split('\n').map((l) => l.trim()).filter((l) => /unlinkSync/.test(l))
  // 1 处 import（`import { …, unlinkSync, … }`）+ 1 处列进 `STATE_FS`。
  // 真正的调用在 `storage-state.mjs` 里（模块自带判据）。
  assert.ok(calls.length <= 2, `unlinkSync 出现了 ${calls.length} 次，比预期多：\n  ${calls.join('\n  ')}`)
})

test('★★★ 状态写入必须**只**经过 `writeStateAtomic`（原子、已单测）', async () => {
  const code = await codeOf('./storage-check.mjs')
  // 直接 `writeFileSync(最终路径, …)` 是**非原子**的：Hub 有机会读到半截 JSON，
  // 于是它报"状态文件读不出来"，而真相只是"写入方正在写"。
  assert.ok(code.includes('writeStateAtomic'), '必须用 writeStateAtomic')
  // `STATE_FS` 把写入面**显式列出来**（而不是整包传 `node:fs`），判据才查得下去。
  assert.match(code, /const STATE_FS = \{/, '写入面必须显式列出来，便于判据盯住它')
})

test('★★★ 反例守卫：`codeOf` 真的会剔掉注释（否则上面几条恒真）', async () => {
  // 我的注释里**确实**提到了 `rmSync`（就在解释这条判据的那一段）。
  // 所以：原文件里有，`codeOf` 之后的代码里没有 —— 两边都断言，证明剔除真的在生效。
  const raw = (await import('node:fs')).readFileSync(new URL('./storage-check.mjs', import.meta.url), 'utf8')
  assert.equal(raw.includes('rmSync'), true, '原文件里应当有（注释里提到了它）')
  assert.equal((await codeOf('./storage-check.mjs')).includes('rmSync'), false, 'codeOf 必须把它剔掉')
  // 而一个**真的**在代码里的词不许被剔掉。
  assert.equal((await codeOf('./storage-check.mjs')).includes('statfsSync'), true)
})

// ── ⑥ ★★★ 落点判定：只能写到该写的地方 ─────────────────────────────────────

test('★★★ 落点是库文件本身（或它的 wal/shm）→ **致命拒绝**（会覆盖数据库）', () => {
  // ★ 这是加状态写入**引入**的一条真实的数据丢失路径：
  //   一个打错的 `--state` 会直接盖掉库。必须拒绝，而不是"写就是了"。
  const db = join(sep, 'var', 'lib', 'legion-hub', 'team.db')
  for (const target of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) {
    const r = statePathCheck(target, { dbPath: db, backupsDir: join(sep, 'var', 'lib', 'legion-hub', 'backups') })
    assert.equal(r.ok, false, `${target} 必须被拒绝`)
    assert.equal(r.fatal, true, `${target} 是致命（会丢数据）`)
    assert.match(r.reason, /覆盖数据库/)
  }
})

test('★★★ 落点在**备份目录**里 → 致命拒绝（会让"备份新鲜"永远为真）', () => {
  // 一个 JSON 落进备份目录之后，`newestMtimeMs` 会把它当成"最新一份备份" ——
  // 于是"备份陈旧"这条判据**永远不再报警**，而那正是它存在的理由。
  const backups = join(sep, 'var', 'lib', 'legion-hub', 'backups')
  const db = join(sep, 'var', 'lib', 'legion-hub', 'team.db')
  for (const target of [backups, join(backups, 'storage-state.json')]) {
    const r = statePathCheck(target, { dbPath: db, backupsDir: backups })
    assert.equal(r.ok, false, `${target} 必须被拒绝`)
    assert.equal(r.fatal, true)
    assert.match(r.reason, /备份/)
  }
  // ★ 反向：备份目录**外面**的同类路径不许被"备份目录"那条规则误伤
  //   （前缀匹配写宽了就会这样：`backups-other/` 以 `backups` 开头）。
  //
  //   ⚠️ 判据必须断言**是哪条规则**拒绝的，不能只断言 `ok`。
  //      第一版我写的是 `ok === true`，于是它在**正确实现**上红了 ——
  //      因为 `backups-other/` **确实**与库在同一块盘上，被规则 ③ 正确拒绝。
  //      两条规则都会拒绝它，但**理由**完全不同，而理由决定了该做什么。
  const sibling = join(sep, 'var', 'lib', 'legion-hub', 'backups-other', 's.json')
  const sib = statePathCheck(sibling, { dbPath: db, backupsDir: backups })
  assert.doesNotMatch(String(sib.reason), /备份目录/, '不许被"备份目录"那条规则误伤')
  assert.match(String(sib.reason), /同一块盘/, '它应当被"同一块盘"那条规则拒绝（这才是对的理由）')
  // 而"同前缀但不是备份目录"这一点，在放行同盘之后就能通过 ——
  // 如果它被"备份目录"那条**致命**规则拒了，放行也救不回来。
  assert.equal(statePathCheck(sibling, { dbPath: db, backupsDir: backups, allowOnDataDisk: true }).ok, true,
    '放行同盘之后它就该通过（致命规则没有放行开关，这条证明它不是被致命规则拒的）')
})

test('★★★ 落点与库**同一块盘** → 默认拒绝，但可以**显式**放行', () => {
  // 那正是 `storage-state.mjs` 文件头 ① 说不能做的事：盘满时状态文件也会写不进去。
  // 允许放行（有的部署可能故意这么干），但必须显式。
  const db = join(sep, 'var', 'lib', 'legion-hub', 'team.db')
  const same = join(sep, 'var', 'lib', 'legion-hub', 'storage-state.json')
  const r = statePathCheck(same, { dbPath: db, backupsDir: join(sep, 'var', 'lib', 'legion-hub', 'backups') })
  assert.equal(r.ok, false, '默认必须拒绝')
  assert.equal(r.fatal, false, '它不是数据丢失，是设计违反 —— 两级要分开')
  assert.match(r.reason, /同一块盘|tmpfs/)
  // 显式放行之后才通过。
  assert.equal(statePathCheck(same, { dbPath: db, allowOnDataDisk: true }).ok, true)
  // ★ 而致命那两级**没有**放行开关：放行了也不许通过（盖库是不可挽回的）。
  assert.equal(statePathCheck(db, { dbPath: db, allowOnDataDisk: true }).ok, false, '盖库没有任何放行开关')
})

test('★★★ tmpfs 落点通过（这是默认形态）', () => {
  const r = statePathCheck(join(sep, 'run', 'legion-hub', 'storage-state.json'),
    { dbPath: join(sep, 'var', 'lib', 'legion-hub', 'team.db'), backupsDir: join(sep, 'var', 'lib', 'legion-hub', 'backups') })
  assert.equal(r.ok, true, '默认落点必须能通过 —— 否则部署起来第一步就错')
  assert.equal(r.reason, null)
})

test('★★ 没给库/备份路径时只判"非空"（不许因为缺参照就一律拒绝）', () => {
  assert.equal(statePathCheck(join(sep, 'run', 'x.json'), {}).ok, true)
  assert.equal(statePathCheck('', {}).ok, false)
  assert.equal(statePathCheck('   ', {}).ok, false)
  for (const bad of [null, undefined, 42, {}]) {
    assert.equal(statePathCheck(bad, {}).ok, false, `${String(bad)} 必须被拒绝`)
    assert.doesNotThrow(() => statePathCheck(bad, {}))
  }
})

test('★★ `--state` / `--no-state` / `--allow-state-on-data-disk` 都被认识', () => {
  const a = parseArgv(['--state', '/run/x.json', '--allow-state-on-data-disk'])
  assert.equal(a.state, '/run/x.json')
  assert.equal(a.allowStateOnDataDisk, true)
  assert.equal(a.bad, undefined)
  assert.equal(parseArgv(['--no-state']).noState, true)
  // 默认落点必须是 tmpfs（与 `storage-state.mjs` 的默认一致）。
  assert.equal(parseArgv([]).state, DEFAULT_STATE_PATH)
  assert.match(parseArgv([]).state, /^\/run\//)
})

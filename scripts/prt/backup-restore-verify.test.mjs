// scripts/prt/backup-restore-verify.test.mjs — PRT-006 备份/恢复验证单测
//
// 全部用**合成夹具**，不依赖现场库：CI 机器上不会有产出机那份 team.db，
// 让测试依赖它会让 PRT-006 在 CI 上永远 skip 或永远红。
//
// 夹具的关键是**留一个未 checkpoint 的 WAL**：这正是「只复制 .db 会丢数据」
// 的成因，也是整个 PRT-006 要证明的东西。做法是插入后**保持连接打开**
// （并关掉 autocheckpoint），关闭连接时 SQLite 会 checkpoint 掉 WAL，夹具就失去意义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  WAL_SUFFIXES,
  copyTriple,
  diffStates,
  doubleCopyRace,
  inspectDb,
  staleWalHazard,
  vacuumInto,
  verifyBackupRestore,
} from './backup-restore-verify.mjs'

/**
 * 建一个带未 checkpoint WAL 的合成库。
 *
 * 返回的 `close()` 必须显式调用——连接开着的时候 WAL 才在磁盘上。
 */
function createWalFixture(dir, { auditRows = 40, extraRows = 5, gapAt = null } = {}) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'team.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA wal_autocheckpoint = 0')
  db.exec(`
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT, goalId TEXT
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
  `)
  let seq = 0
  for (let i = 0; i < auditRows; i++) {
    seq += 1
    if (gapAt !== null && seq === gapAt) seq += 1 // 制造一个缺口，模拟回滚作废号
    db.prepare('INSERT INTO audit (seq, ts, member, scope, action, taskId, detail, goalId) VALUES (?,?,?,?,?,?,?,?)')
      .run(seq, new Date(1_700_000_000_000 + i * 1000).toISOString(), 'm', '*', 'act', null, '{}', null)
  }
  for (let i = 0; i < extraRows; i++) {
    db.prepare('INSERT INTO tasks (id, title) VALUES (?,?)').run(`T-${i}`, `t${i}`)
  }
  return { db, path, close: () => db.close() }
}

// ---------------------------------------------------------------- ① inspectDb

test('① inspectDb 读出表、行数、integrity 与 audit 统计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-a-'))
  const fx = createWalFixture(dir, { auditRows: 12, extraRows: 3 })
  try {
    const s = inspectDb(fx.path)
    assert.equal(s.ok, true)
    assert.deepEqual(s.tables, ['audit', 'tasks'])
    assert.equal(s.rowCounts.audit, 12)
    assert.equal(s.rowCounts.tasks, 3)
    assert.equal(s.totalRows, 15)
    assert.equal(s.integrityCheck, 'ok')
    assert.equal(s.audit.lo, 1)
    assert.equal(s.audit.hi, 12)
    assert.deepEqual(s.audit.gaps, [])
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('① 缺口被如实报出（真实库就有 1 个，见文件头说明）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-gap-'))
  const fx = createWalFixture(dir, { auditRows: 10, gapAt: 5 })
  try {
    const s = inspectDb(fx.path)
    assert.equal(s.audit.gaps.length, 1, '未识别出缺口')
    // node:sqlite 返回的行是 null 原型对象，deepStrictEqual 会因原型不同而失败 → 逐字段比
    assert.equal(s.audit.gaps[0].before, 4)
    assert.equal(s.audit.gaps[0].after, 6)
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('① 非库文件返回 ok:false 而不是抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-bad-'))
  const p = join(dir, 'not-a-db')
  try {
    writeFileSync(p, 'definitely not sqlite')
    const s = inspectDb(p)
    assert.equal(s.ok, false)
    assert.ok(typeof s.reason === 'string' && s.reason.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ② 三条备份路线

test('② 只复制 .db 会丢数据（未 checkpoint 的 WAL 未包含在内）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-c-'))
  const fx = createWalFixture(dir, { auditRows: 30, extraRows: 4 })
  try {
    const truth = inspectDb(fx.path)
    const c = copyTriple(fx.path, join(dir, 'db-only'), { includeWal: false })
    assert.equal(c.copied.length, 1, '只应复制 .db 一个文件')
    const got = inspectDb(c.destPath)
    const diff = diffStates(truth, got)
    assert.ok(diff.length > 0, '副本竟与源一致——夹具的 WAL 可能已被 checkpoint，夹具失效')
    // 源库在 WAL 里有数据，副本只拿到主库文件 → 行数变少
    assert.ok(got.totalRows < truth.totalRows, `副本行数 ${got.totalRows} 未少于源 ${truth.totalRows}`)
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② 复制三件套（DEPLOY.md §6 的写法）能完整恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-d-'))
  const fx = createWalFixture(dir, { auditRows: 30, extraRows: 4 })
  try {
    const truth = inspectDb(fx.path)
    const c = copyTriple(fx.path, join(dir, 'triple'), { includeWal: true })
    assert.ok(c.copied.some((x) => x.suffix === '-wal'), '未复制 -wal')
    const got = inspectDb(c.destPath)
    assert.deepEqual(diffStates(truth, got), [])
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② VACUUM INTO 快照与源库逻辑一致，且不需 -wal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-e-'))
  const fx = createWalFixture(dir, { auditRows: 20, extraRows: 2 })
  try {
    const truth = inspectDb(fx.path)
    const dest = join(dir, 'vac', 'team.db')
    const v = vacuumInto(fx.path, dest)
    assert.ok(v.bytes > 0)
    const got = inspectDb(dest)
    assert.deepEqual(diffStates(truth, got), [])
    // 单文件即完整：移走整个目录也只靠这一个文件
    const lonely = join(dir, 'lonely')
    mkdirSync(lonely, { recursive: true })
    copyFileSync(dest, join(lonely, 'team.db'))
    assert.deepEqual(diffStates(truth, inspectDb(join(lonely, 'team.db'))), [])
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② VACUUM INTO 目标已存在时不静默失败（先删再写）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-f-'))
  const fx = createWalFixture(dir, { auditRows: 5, extraRows: 1 })
  try {
    const dest = join(dir, 'v', 'team.db')
    vacuumInto(fx.path, dest)
    const first = statSync(dest).size
    const again = vacuumInto(fx.path, dest) // 第二次不应抛 "output file already exists"
    assert.ok(again.bytes > 0)
    assert.ok(first > 0)
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ③ diffStates

test('③ diffStates 定位行数/表数/缺口/上界差异', () => {
  const base = {
    ok: true, tables: ['a'], tableCount: 1, rowCounts: { a: 5 }, totalRows: 5,
    integrityCheck: 'ok', audit: { lo: 1, hi: 5, count: 5, gaps: [] },
  }
  assert.deepEqual(diffStates(base, base), [])
  const more = { ...base, rowCounts: { a: 7 }, totalRows: 7, audit: { lo: 1, hi: 7, count: 7, gaps: [] } }
  const lines = diffStates(base, more)
  assert.ok(lines.some((l) => /a: 5 -> 7/.test(l)))
  assert.ok(lines.some((l) => /总行数 5 -> 7/.test(l)))
  assert.ok(lines.some((l) => /audit\.seq 上界 5 -> 7/.test(l)))

  const gapped = { ...base, audit: { lo: 1, hi: 5, count: 5, gaps: [{ before: 2, after: 4 }] } }
  assert.ok(diffStates(base, gapped).some((l) => /缺口集合/.test(l)))
  const bad = { ...base, integrityCheck: 'database disk image is malformed' }
  assert.ok(diffStates(base, bad).some((l) => /integrity_check/.test(l)))
  assert.ok(diffStates(base, { ...base, ok: false, reason: 'x' }).length > 0)
})

// ---------------------------------------------------------------- ④ 端到端

test('④ verifyBackupRestore：①必失败、②③④必通过（合成夹具）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-g-'))
  const fx = createWalFixture(dir, { auditRows: 25, extraRows: 3 })
  try {
    const out = verifyBackupRestore({ source: fx.path, workRoot: dir })
    assert.equal(out.ok, false, '只复制 .db 这条路必然不能完整恢复 → 整体不应为 ok')
    const by = (i) => out.results[i]
    assert.equal(by(0).restored, false, '① 应失败')
    assert.equal(by(1).restored, true, '② 应通过')
    assert.equal(by(2).restored, true, '③ 应通过')
    assert.equal(by(3).restored, true, '④ 应通过')
    assert.equal(out.truth.integrityCheck, 'ok')
    // 4 条备份路线 + 陈旧 -wal 危害 = 5 个 results；竞态探测单独挂在 out.race
    assert.equal(out.results.length, 5, '应含 ④ 之后的 ⑤ 陈旧 -wal')
    assert.ok(out.race, '缺 ⑥ 竞态探测结果')
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 源库不存在时返回可读原因，不抛错', () => {
  const out = verifyBackupRestore({ source: join(tmpdir(), '__no_such_team_db__.db') })
  assert.equal(out.ok, false)
  assert.match(out.reason, /源库不存在/)
})

test('④ 源库只读：验证过程不改动源文件与它的 WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-h-'))
  const fx = createWalFixture(dir, { auditRows: 15, extraRows: 2 })
  try {
    const walPath = fx.path + '-wal'
    const before = { db: statSync(fx.path).size, wal: statSync(walPath).size, walMtime: statSync(walPath).mtimeMs }
    verifyBackupRestore({ source: fx.path, workRoot: join(dir, 'w') })
    const after = { db: statSync(fx.path).size, wal: statSync(walPath).size, walMtime: statSync(walPath).mtimeMs }
    assert.equal(after.db, before.db, '源库大小被改动')
    assert.equal(after.wal, before.wal, '源库 -wal 大小被改动')
    assert.equal(after.walMtime, before.walMtime, '源库 -wal 被写入（mtime 变化）')
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ⑤ 陈旧 WAL 危害

test('⑤ 陈旧 -wal 会被重放到恢复库上，且 integrity_check 仍报 ok', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-i-'))
  const fx = createWalFixture(dir, { auditRows: 20, extraRows: 2 })
  try {
    const res = staleWalHazard(fx.path, dir)
    if (res.unverified) {
      // 夹具无法构造「带新页的 WAL」时不要假装通过
      t.diagnostic(`陈旧 -wal 实验未能构造：${res.note}`)
      return
    }
    assert.equal(res.leaked, 1, `期望恰好泄漏 1 行合成数据，实得 ${res.leaked}`)
    assert.equal(res.safe, false, '陈旧 -wal 被重放却判为安全')
    assert.match(res.note, /确认危害/)
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ⑥ 竞态

test('⑥ doubleCopyRace 返回结构化结果（不谎称复制是原子的）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prt006-j-'))
  const fx = createWalFixture(dir, { auditRows: 10, extraRows: 1 })
  try {
    const race = doubleCopyRace(fx.path, dir)
    assert.equal(typeof race.identical, 'boolean')
    assert.ok(Array.isArray(race.diff))
    assert.ok(typeof race.note === 'string' && race.note.length > 0)
    // 源库静止时应一致，且说明文字必须点出「这不能证明原子性」
    assert.equal(race.identical, true)
    assert.match(race.note, /不能据此认为复制是原子的/)
  } finally {
    fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 常量

test('⑦ WAL 三件套后缀是权威定义（供 DEPLOY.md 引用）', () => {
  assert.deepEqual(WAL_SUFFIXES, ['', '-wal', '-shm'])
})

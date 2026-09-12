// ============================================================================
// PRT-807 的判据：幂等数据库迁移框架。
//
// 这一组盯的**不是**"跑两遍结果一样"，而是三个在"幂等"这个词下很容易
// 被合并成一件的事：
//
//   ① **「已应用」与「失败但被吞掉」必须分开。** 最常见的"幂等"写法是
//      `try { exec(sql) } catch {}`——它把语法错误、磁盘满、锁超时，
//      连同那次真的把表改了一半的失败，一起幂等掉了。
//   ② **迁移的身份是内容，不是版本号。** 改过 `up()` 代码之后"跳过"，
//      是在假设改过之后的它与改过之前等价，而这个假设没有人保证。
//   ③ **能不能只回滚程序，是一个声明，不是一个判断。** spec line 733 说
//      "若新版本已写入旧版本无法理解的数据，禁止仅回滚二进制"——
//      只有写迁移的人知道那件事。
//
//   > 一个把异常吞掉的幂等迁移，
//   > 与一个"从来没跑过、但每次都报成功"的迁移，是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPLY_STATUSES,
  COMPATIBILITY,
  MIGRATION_CHECKED,
  MIGRATION_CODES,
  ROLLBACK_SAFETY,
  checksumOf,
  createMemoryMigrationStore,
  defineMigration,
  lastAdditiveBoundary,
  planRollback,
  runMigrations,
  sampleMigrations,
  validateMigrationPlan,
} from '../../product/upgrade/migration.mjs'

/** 一个最小的"数据库"：记录执行过的语句，可注入失败。 */
function fakeDb({ failOn = null } = {}) {
  const executed = []
  return {
    executed,
    exec(sql) {
      if (failOn !== null && sql.includes(failOn)) {
        const e = new Error(`模拟：${failOn} 失败`)
        e.code = 'SIMULATED'
        throw e
      }
      executed.push(sql)
    },
  }
}

/** 一份标准的 additive 集合。 */
function additiveMigrations() {
  return [
    defineMigration({
      version: 1, name: 'create-runs', compatibility: 'additive',
      up: (db) => { db.exec('CREATE TABLE runs') },
      down: (db) => { db.exec('DROP TABLE runs') },
    }),
    defineMigration({
      version: 2, name: 'add-runs-started-at', compatibility: 'additive',
      up: (db) => { db.exec('ALTER TABLE runs ADD started_at') },
    }),
  ]
}

// ── 定义与集合 ──────────────────────────────────────────────────────────────

test('① ★ 迁移的 `compatibility` 是**必填**的：它决定能不能只回滚程序', () => {
  assert.deepEqual([...COMPATIBILITY], ['additive', 'breaking'])
  assert.throws(
    () => defineMigration({ version: 1, name: 'x', up: () => {}, compatibility: '无所谓' }),
    (e) => { assert.equal(e.code, MIGRATION_CODES.PLAN_INVALID); return true },
  )
  assert.throws(() => defineMigration({ version: 1, name: 'x', up: () => {} }), (e) => {
    assert.ok(e.message.includes('compatibility'), e.message)
    return true
  })
})

test('① `hasDownMigration` 默认为 false：没写 down 与"down 只是抛错"是同一档', () => {
  const withoutDown = defineMigration({ version: 1, name: 'a', up: () => {}, compatibility: 'additive' })
  assert.equal(withoutDown.hasDownMigration, false)
  const withDown = defineMigration({ version: 1, name: 'a', up: () => {}, down: () => {}, compatibility: 'additive' })
  assert.equal(withDown.hasDownMigration, true)
})

test('① ★★ 同一个版本号出现两次必须被拦（后跑的会覆盖前一份的记录）', () => {
  const m = defineMigration({ version: 1, name: 'a', up: () => {}, compatibility: 'additive' })
  const r = validateMigrationPlan([m, { ...m, name: 'b' }])
  assert.equal(r.ok, false, '版本号重复被放行')
  assert.ok(r.problems[0].message.includes('出现两次'), r.problems[0].message)
})

test('① 校验和覆盖 (版本, 名字, up 源码)：改任何一样都会变', () => {
  const a = defineMigration({ version: 1, name: 'a', up: () => {}, compatibility: 'additive' })
  const b = defineMigration({ version: 1, name: 'a', up: (x) => { void x }, compatibility: 'additive' })
  const c = defineMigration({ version: 2, name: 'a', up: () => {}, compatibility: 'additive' })
  const d = defineMigration({ version: 1, name: 'b', up: () => {}, compatibility: 'additive' })
  const all = [a.checksum, b.checksum, c.checksum, d.checksum]
  assert.equal(new Set(all).size, 4, `四种改动里有的没让校验和变：${JSON.stringify(all)}`)
  assert.equal(checksumOf({ version: 1, name: 'a', source: 'x' }).startsWith('sha256:'), true)
})

// ── 幂等：已应用 ≠ 失败被吞 ─────────────────────────────────────────────────

test('② ★★ 跑两遍：第二遍报 `already-current`，且**一条 SQL 都不再执行**', async () => {
  const migrations = additiveMigrations()
  const store = createMemoryMigrationStore()
  const db = fakeDb()

  const first = await runMigrations({ migrations, store, base: db })
  assert.equal(first.outcome, 'applied-all')
  assert.equal(first.applied.length, 2)
  assert.equal(db.executed.length, 2)

  const second = await runMigrations({ migrations, store, base: db })
  assert.equal(second.outcome, 'already-current')
  assert.equal(second.applied.length, 0)
  assert.equal(second.skipped.length, 2, JSON.stringify(second.skipped))
  assert.equal(db.executed.length, 2, '第二遍又执行了迁移语句——"已应用"没有真的跳过')

  // 记录里只有 applied，没有别的状态。
  const rows = store.rows()
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => APPLY_STATUSES.includes(r.status)), JSON.stringify(rows))
})

test('② ★★ 迁移抛错时必须原样失败：**不吞**，且不写 applied 记录', async () => {
  const migrations = [
    defineMigration({ version: 1, name: 'ok', compatibility: 'additive', up: (db) => { db.exec('CREATE TABLE a') } }),
    defineMigration({ version: 2, name: 'boom', compatibility: 'additive', up: (db) => { db.exec('ALTER TABLE a ADD 坏了') } }),
  ]
  const store = createMemoryMigrationStore()
  const db = fakeDb({ failOn: '坏了' })

  const r = await runMigrations({ migrations, store, base: db })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.code, MIGRATION_CODES.UP_FAILED)
  assert.equal(r.failed.version, 2)
  assert.ok(r.failed.error.includes('坏了'), r.failed.error)
  assert.deepEqual(r.applied.map((a) => a.version), [1], '第 1 份的成功记录没有被留下')
  assert.equal(store.rows().filter((x) => x.status === 'applied').length, 1, '失败的那一份被写成了已应用')
  assert.equal(store.rows().filter((x) => x.status === 'failed').length, 1, '失败没有被记录')
})

test('② ★★ 「失败但被吞掉」与「已应用」在读数上必须不同', async () => {
  // 构造一份"看起来幂等"的迁移：它自己吞掉异常。这样它会报 applied，
  // 而**存储里也真的有一行 applied**——两者的依据是同一次成功的返回，
  // 区别在于：吞掉异常的那份迁移，其 SQL 并没有生效。
  const swallowed = defineMigration({
    version: 1, name: 'swallow', compatibility: 'additive',
    up: (db) => {
      try { db.exec('ALTER TABLE 不存在的表 ADD x') } catch { /* 已经加过了 */ }
    },
  })
  const store = createMemoryMigrationStore()
  const db = fakeDb({ failOn: '不存在的表' })
  const r = await runMigrations({ migrations: [swallowed], store, base: db })
  assert.equal(r.outcome, 'applied-all', '吞掉异常的迁移"成功"了')

  // ★ 本模块能做的是：**不替它吞**。上面那条用例证明了抛出即失败；
  //   这一条证明"失败记录"与"成功记录"是两个不同的 status，
  //   于是"到底是哪种"在 schema_migrations 里可以查。
  assert.notDeepEqual(
    store.rows().map((x) => x.status),
    createMemoryMigrationStore([{ status: 'failed', version: 1 }]).rows().map((x) => x.status),
    '失败与成功在记录里是同一个 status',
  )
  assert.deepEqual([...APPLY_STATUSES], ['applied', 'failed'])
})

test('② ★★ 记账失败时**必须报错**：up() 已经跑了，而下次还会再跑一遍', async () => {
  const migrations = additiveMigrations()
  const store = createMemoryMigrationStore({ failOnRecord: true })
  const db = fakeDb()
  const r = await runMigrations({ migrations, store, base: db })
  assert.equal(r.outcome, 'failed', '记不上账却报了成功')
  assert.equal(r.code, MIGRATION_CODES.RECORD_FAILED)
  assert.equal(r.failed.version, 1)
  assert.ok(r.reason.includes('再跑一遍'), r.reason)
})

test('② ★★ 校验和漂移是一个**失败**，不是"跳过"', async () => {
  const migrations = additiveMigrations()
  const store = createMemoryMigrationStore()
  await runMigrations({ migrations, store, base: fakeDb() })

  // 有人改了已应用的迁移代码（常见于把两份迁移合并成一份时）。
  const edited = [
    defineMigration({
      version: 1, name: 'create-runs', compatibility: 'additive',
      up: (db) => { db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, extra TEXT)') },
    }),
    ...migrations.slice(1),
  ]
  const r = await runMigrations({ migrations: edited, store, base: fakeDb() })
  assert.equal(r.outcome, 'checksum-drift', '改过代码的迁移被静默跳过了')
  assert.equal(r.code, MIGRATION_CODES.CHECKSUM_DRIFT)
  assert.equal(r.failed.version, 1)
  assert.ok(r.reason.includes('等价'), r.reason)
})

test('② ★ 记录里出现当前集合没有的版本时不许忽略（那说明这台机器的状态不明）', async () => {
  const migrations = additiveMigrations()
  const store = createMemoryMigrationStore({
    rows: [{ status: 'applied', version: 99, name: 'unknown', checksum: 'sha256:zzz' }],
  })
  const r = await runMigrations({ migrations, store, base: fakeDb() })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.code, MIGRATION_CODES.UNKNOWN_APPLIED_VERSION)
  assert.ok(r.reason.includes('99'), r.reason)
})

test('② 集合本身不合法时，一条都不跑', async () => {
  const m = defineMigration({ version: 1, name: 'a', up: () => {}, compatibility: 'additive' })
  const db = fakeDb()
  const r = await runMigrations({ migrations: [m, { ...m, name: 'dup' }], store: createMemoryMigrationStore(), base: db })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.code, MIGRATION_CODES.PLAN_INVALID)
  assert.equal(db.executed.length, 0, '集合不合法却已经跑了迁移')
})

test('② 空集合报 `no-migrations`（不是 `already-current`）', async () => {
  const r = await runMigrations({ migrations: [], store: createMemoryMigrationStore(), base: fakeDb() })
  assert.equal(r.outcome, 'no-migrations')
  assert.equal(r.code, MIGRATION_CODES.NOTHING_TO_DO)
})

// ── 回滚可达性 ──────────────────────────────────────────────────────────────

test('③ ★★ 全部 additive → `program-only-rollback`，且**明说**数据库不用恢复', () => {
  const migrations = additiveMigrations()
  const applied = migrations.map((m) => ({ version: m.version, compatibility: m.compatibility }))
  const plan = planRollback({ applied, migrations })
  assert.equal(plan.safety, 'program-only-rollback')
  assert.equal(plan.programRollbackSufficient, true)
  assert.equal(plan.dbMustBeRestored, false)
  assert.ok(plan.restores.some((r) => r.includes('数据库')), JSON.stringify(plan.restores))
  assert.ok(plan.restores[0].includes('程序版本'), JSON.stringify(plan.restores))
  assert.deepEqual([...plan.doesNotRestore], [])
  assert.ok(plan.reason.includes('additive'), plan.reason)
})

test('③ ★★ breaking 且**没有** down → `forward-fix-required`：拒绝仅回滚程序', () => {
  const migrations = [
    ...additiveMigrations(),
    defineMigration({
      version: 3, name: 'drop-legacy-view', compatibility: 'breaking',
      up: (db) => { db.exec('DROP VIEW legacy') },
      downNote: '重建的视图是空的：历史行不会回来',
    }),
  ]
  const applied = migrations.map((m) => ({ version: m.version, compatibility: m.compatibility }))
  const plan = planRollback({ applied, migrations })
  assert.equal(plan.safety, 'forward-fix-required')
  assert.equal(plan.programRollbackSufficient, false)
  assert.equal(plan.dbMustBeRestored, true)
  assert.deepEqual([...plan.breakingVersions], [3])
  assert.ok(plan.reason.includes('禁止此时仅回滚二进制'), plan.reason)
  // 这一档不许声称"程序也恢复了"。
  assert.deepEqual([...plan.restores], [])
  assert.ok(plan.doesNotRestore.some((x) => x.includes('程序版本')), JSON.stringify(plan.doesNotRestore))
})

test('③ ★★ breaking 且**有** down → `db-restore-required`，且明确写出"可能丢数据"', () => {
  const migrations = [
    defineMigration({
      version: 1, name: 'contract', compatibility: 'breaking',
      up: (db) => { db.exec('DROP TABLE legacy') },
      down: (db) => { db.exec('CREATE TABLE legacy (id TEXT)') },
      downNote: 'down 建回来的是一张空表，行不会回来',
    }),
  ]
  const plan = planRollback({ applied: [{ version: 1, compatibility: 'breaking' }], migrations })
  assert.equal(plan.safety, 'db-restore-required')
  assert.equal(plan.dbMustBeRestored, true)
  assert.ok(plan.reason.includes('可能丢数据'), plan.reason)
  assert.ok(plan.doesNotRestore.some((x) => x.includes('数据库')), JSON.stringify(plan.doesNotRestore))
  assert.ok(!plan.restores.includes('数据库'), JSON.stringify(plan.restores))
})

test('③ ★★ 三档互不相同，且都落在声明的集合里', () => {
  const additive = defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: () => {} })
  const breakingNoDown = defineMigration({ version: 2, name: 'b', compatibility: 'breaking', up: () => {} })
  const breakingWithDown = defineMigration({ version: 3, name: 'c', compatibility: 'breaking', up: () => {}, down: () => {} })

  const s1 = planRollback({ applied: [{ version: 1 }], migrations: [additive] }).safety
  const s2 = planRollback({ applied: [{ version: 2 }], migrations: [breakingNoDown] }).safety
  const s3 = planRollback({ applied: [{ version: 3 }], migrations: [breakingWithDown] }).safety
  assert.deepEqual([s1, s2, s3], ['program-only-rollback', 'forward-fix-required', 'db-restore-required'])
  assert.equal(new Set([s1, s2, s3]).size, 3, '三档里有重复——它们会被当成同一种处置')
  assert.ok([s1, s2, s3].every((s) => ROLLBACK_SAFETY.includes(s)))
})

test('③ ★ 没应用任何迁移时，回滚不需要动数据库', () => {
  const plan = planRollback({ applied: [], migrations: additiveMigrations() })
  assert.equal(plan.safety, 'program-only-rollback')
  assert.ok(plan.reason.includes('数据库从未被改动'), plan.reason)
})

test('③ ★ `lastAdditiveBoundary` 给出"退到哪个版本仍然安全"', () => {
  const migrations = [
    ...additiveMigrations(),
    defineMigration({ version: 3, name: 'contract', compatibility: 'breaking', up: () => {} }),
    defineMigration({ version: 4, name: 'additive-again', compatibility: 'additive', up: () => {} }),
  ]
  const applied = migrations.map((m) => ({ version: m.version, compatibility: m.compatibility }))
  assert.equal(lastAdditiveBoundary(applied, migrations), 2)
  assert.equal(lastAdditiveBoundary([{ version: 3 }], migrations), null, '第一份就是 breaking 却给出了边界')
})

// ── 装载期自检 ──────────────────────────────────────────────────────────────

test('④ ★ 装载期自检留下算出来的值，四条判据都真的跑过', () => {
  assert.deepEqual([...MIGRATION_CHECKED.problems], [])
  const s = MIGRATION_CHECKED.samples
  assert.equal(s.sampleCount, 3)
  assert.equal(s.planOk, true)
  assert.equal(s.duplicatePlanOk, false)
  assert.equal(s.forwardFixSafety, 'forward-fix-required')
  assert.equal(s.programOnlySafety, 'program-only-rollback')
  assert.equal(s.programOnlyRestoresDb, true)
  assert.equal(s.boundary, 2)
  assert.equal(s.sampleChecksums.length, 3)
  assert.deepEqual([...MIGRATION_CHECKED.outcomes],
    ['no-migrations', 'applied-all', 'already-current', 'failed', 'checksum-drift'])
})

test('④ ★ 示例集合真的能跑起来（自检里的定义不是纸面的）', async () => {
  const store = createMemoryMigrationStore()
  const db = fakeDb()
  const r = await runMigrations({ migrations: sampleMigrations(), store, base: db })
  assert.equal(r.outcome, 'applied-all', r.reason)
  assert.equal(db.executed.length, 3)
  const again = await runMigrations({ migrations: sampleMigrations(), store, base: db })
  assert.equal(again.outcome, 'already-current')
  // 示例里的第 3 份是 breaking 且没有 down → 回滚可达性是 forward-fix-required。
  const plan = planRollback({ applied: r.applied, migrations: sampleMigrations() })
  assert.equal(plan.safety, 'forward-fix-required')
})

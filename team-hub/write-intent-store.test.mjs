// team-hub/write-intent-store.test.mjs —— S2（R-2 / R-3 服务端）
// 同进程两个 DatabaseSync 连接 = 等价于「进程/连接」争用口径（A-3）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteIntentStore, ensureWriteIntentSchema, WRITE_INTENT_ERRORS } from './write-intent-store.mjs'

function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-t170-intent-'))
  const file = join(dir, 'intent.db')
  const dbA = new DatabaseSync(file)
  ensureWriteIntentSchema(dbA)
  const dbB = new DatabaseSync(file)
  ensureWriteIntentSchema(dbB)
  return { dbA, dbB, file }
}

test('TC-S2-01/02 异文件并行成功、同文件恰一活跃且另一 FILE_CONTENTION', () => {
  const { dbA, dbB } = pair()
  const a = createWriteIntentStore(dbA)
  const b = createWriteIntentStore(dbB)
  assert.equal(a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] }).ok, true)
  assert.equal(b.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['src/b.mjs'] }).ok, true)
  const contended = b.reserve({ repoId: 'r1', taskId: 't3', attemptId: 'a3', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(contended.ok, false)
  assert.equal(contended.code, 'FILE_CONTENTION')
  assert.ok(Array.isArray(contended.paths) && contended.paths.includes('src/a.mjs'))
  assert.equal(contended.holderTaskId, 't1')
  assert.equal(b.assertNoActiveOverlap('r1').ok, true)
})

test('TC-S2-03 claim 事务无半状态：预约冲突时 Attempt 与 reservation 都不落', () => {
  const { dbA } = pair()
  const db = dbA
  db.exec('CREATE TABLE IF NOT EXISTS claim_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT)')
  const a = createWriteIntentStore(db)
  assert.equal(a.reserve({ repoId: 'r1', taskId: 'holder', attemptId: 'h1', epoch: 1, paths: ['src/shared.mjs'] }).ok, true)
  let thrown = null
  try {
    a.claimWithReservation({
      repoId: 'r1', taskId: 'loser', attemptId: 'l1', epoch: 1, paths: ['src/shared.mjs'],
      createAttempt: () => db.prepare('INSERT INTO claim_attempts (task_id) VALUES (?)').run('loser'),
    })
  } catch (e) { thrown = e }
  assert.equal(thrown.code, 'FILE_CONTENTION')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claim_attempts').get().n, 0, '冲突时 Attempt 不得落库')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id = 'loser'").get().n, 0, '冲突时 reservation 不得落库')
})

test('TC-S2-03b claim 事务成功时 Attempt 与 reservation 一并落库', () => {
  const { dbA: db } = pair()
  db.exec('CREATE TABLE IF NOT EXISTS claim_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT)')
  const a = createWriteIntentStore(db)
  const r = a.claimWithReservation({
    repoId: 'r1', taskId: 'winner', attemptId: 'w1', epoch: 1, paths: ['src/only.mjs'],
    createAttempt: () => db.prepare('INSERT INTO claim_attempts (task_id) VALUES (?)').run('winner'),
  })
  assert.equal(r.ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claim_attempts').get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id = 'winner'").get().n, 1)
})

test('TC-S2-04 epoch 过期释放被拒且回报当前真实 epoch', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 7, paths: ['src/a.mjs'] })
  const rejected = a.release({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 6 })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'EPOCH_STALE')
  assert.equal(rejected.currentEpoch, 7)
  assert.equal(a.listActiveReservations('r1').length, 1, '过期 epoch 不得释放')
  assert.equal(a.release({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 7 }).ok, true)
  assert.equal(a.listActiveReservations('r1').length, 0)
})

test('TC-S2-05 租约过期且进程未确认退出 -> reconciling 而非立即释放，确认后可释放', () => {
  const { dbA } = pair()
  let clock = 1000
  const a = createWriteIntentStore(dbA, { now: () => clock })
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'], leaseMs: 500 })
  clock = 2000
  const frozen = a.sweepExpiredLeases({ repoId: 'r1', nowMs: clock })
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0].state, 'reconciling')
  assert.equal(a.listActiveReservations('r1')[0].state, 'reconciling')
  const freed = a.release({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1 })
  assert.equal(freed.ok, true)
  assert.equal(a.listActiveReservations('r1').length, 0)
})

test('TC-S2-06/07 扩域：成功 revision+1，撞车失败且 revision/路径不变', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  const r1 = a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(r1.intent.revision, 1)
  const ok = a.expandIntent({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, addPaths: ['src/sub/b.mjs'], expectedRevision: 1 })
  assert.equal(ok.ok, true)
  assert.equal(ok.revision, 2)
  a.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['docs/x.md'] })
  const bad = a.expandIntent({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, addPaths: ['docs/x.md'], expectedRevision: 2 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'FILE_CONTENTION')
  assert.equal(bad.holderTaskId, 't2')
  const intent = a.getIntent('t1')
  assert.equal(intent.revision, 2, '扩域失败 revision 不变')
  assert.deepEqual(intent.paths.map((p) => p.path), ['src/a.mjs', 'src/sub/b.mjs'], '扩域失败路径不变')
  const stale = a.expandIntent({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, addPaths: ['src/c.mjs'], expectedRevision: 1 })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'REVISION_CONFLICT')
  assert.equal(stale.currentRevision, 2)
})

test('TC-S2-08 目录段边界：src/a 预约挡住 src/a/b.mjs，但不挡 src/ab', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: [{ path: 'src/a', type: 'dir' }] })
  const blocked = a.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['src/a/b.mjs'] })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'FILE_CONTENTION')
  const notBlocked = a.reserve({ repoId: 'r1', taskId: 't3', attemptId: 'a3', epoch: 1, paths: ['src/ab'] })
  assert.equal(notBlocked.ok, true)
})

test('TC-S2-09 全库活跃预约两两不相交（不变量扫描）', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a'] })
  a.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['src/b'] })
  const scan = a.assertNoActiveOverlap('r1')
  assert.equal(scan.ok, true)
  assert.equal(scan.conflicts.length, 0)
})

test('TC-S2-10 非 Git 仓库第二个写入任务被拒且原因可读', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  assert.equal(a.reserve({ repoId: 'rng', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['x.mjs'], capability: 'degraded' }).ok, true)
  const second = a.reserve({ repoId: 'rng', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['y.mjs'], capability: 'degraded' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'SINGLE_WRITER_REQUIRED')
  assert.ok(second.reason.length > 0)
  assert.equal(second.holderTaskId, 't1')
})

test('TC-S2-11 非法路径整体拒绝，不写任何行', () => {
  const { dbA: db } = pair()
  const a = createWriteIntentStore(db)
  const r = a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['../escape.mjs'] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'INVALID_PATHS')
  assert.equal(a.listActiveReservations('r1').length, 0)
  assert.equal(a.getIntent('t1'), null)
})

test('TC-S2-13 迁移幂等、可从旧库启动、重复迁移无错', () => {
  const { file } = pair()
  const db1 = new DatabaseSync(file)
  assert.equal(ensureWriteIntentSchema(db1), true)
  assert.equal(ensureWriteIntentSchema(db1), true)
  const t = db1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_write_intents','write_reservations')").all()
  assert.equal(t.length, 2)
  db1.close()
  const db2 = new DatabaseSync(file)
  ensureWriteIntentSchema(db2)
  const store = createWriteIntentStore(db2)
  assert.equal(store.assertNoActiveOverlap('r1').ok, true)
  db2.close()
})

test('TC-S2-14 静态反证：write-intent-store 复用共享 path-domain，无第二份前缀判定', () => {
  const src = readFileSync(new URL('./write-intent-store.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("packages/shared/src/path-domain.mjs"), '必须 import 共享判定')
  assert.ok(!/startsWith\(\s*['"][^'"]*\/['"]\s*\)/.test(src), '不得自写 startsWith 段前缀判定')
})

test('TC-S2-15 取消/打回重做保留预约；确认结束后可释放并允许新任务', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] })
  const frozen = a.markReconciling({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, reason: 'cancelled' })
  assert.equal(frozen.ok, true)
  assert.equal(a.listActiveReservations('r1')[0].state, 'reconciling')
  const blocked = a.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(blocked.ok, false, 'reconciling 仍占用，防止迟到写入')
  a.release({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1 })
  const ok = a.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(ok.ok, true)
})

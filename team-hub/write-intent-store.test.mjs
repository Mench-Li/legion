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

test('未规划写入独占仓库，与已规划文件预约双向互斥', () => {
  const { dbA: db } = pair()
  const a = createWriteIntentStore(db)
  const unplanned = a.reserve({ repoId: 'r1', taskId: 'old', attemptId: 'old:1', epoch: 1, paths: [], exclusive: true })
  assert.equal(unplanned.ok, true)
  assert.equal(unplanned.reservation.exclusive, true)
  const blocked = a.reserve({ repoId: 'r1', taskId: 'planned', attemptId: 'p:1', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(blocked.code, 'FILE_CONTENTION')
  a.release({ repoId: 'r1', taskId: 'old', attemptId: 'old:1', epoch: 1 })
  assert.equal(a.reserve({ repoId: 'r1', taskId: 'planned', attemptId: 'p:1', epoch: 1, paths: ['src/a.mjs'] }).ok, true)
  assert.equal(a.reserve({ repoId: 'r1', taskId: 'later', attemptId: 'l:1', epoch: 1, paths: [], exclusive: true }).code, 'FILE_CONTENTION')
})

test('预约可嵌入任务认领事务；错误 Attempt 不能释放', () => {
  const { dbA: db } = pair()
  const a = createWriteIntentStore(db)
  db.exec('BEGIN IMMEDIATE')
  const got = a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['x.mjs'] })
  assert.equal(got.ok, true)
  db.exec('COMMIT')
  const bad = a.release({ repoId: 'r1', taskId: 't1', attemptId: 'wrong', epoch: 1 })
  assert.equal(bad.ok, false)
  assert.equal(a.listActiveReservations('r1').length, 1)
})

test('冻结预约不能被旧请求重新激活；旧 epoch 不能覆盖新租约', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 5, paths: ['x.mjs'] })
  assert.equal(store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 4, paths: ['x.mjs'] }).code, 'EPOCH_STALE')
  store.markReconciling({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 5 })
  assert.equal(store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 6, paths: ['x.mjs'] }).code, 'RECONCILING')
  assert.equal(store.listActiveReservations('r1')[0].state, 'reconciling')
})

test('活跃预约期间不能通过规划接口绕开扩域检查', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['x.mjs'] })
  const before = store.getIntent('t1')
  const changed = store.upsertIntent({ repoId: 'r1', taskId: 't1', attemptId: 'a1', paths: ['y.mjs'], expectedRevision: before.revision })
  assert.equal(changed.code, 'RESERVATION_ACTIVE')
  assert.deepEqual(store.getIntent('t1').paths, before.paths)
})

test('活跃预约只允许原样重放，不能缩小范围或改写 epoch', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  const args = { repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['a.mjs', 'b.mjs'] }
  const first = store.reserve(args)
  assert.equal(first.ok, true)
  assert.equal(store.reserve(args).reservation.id, first.reservation.id)
  assert.equal(store.reserve({ ...args, paths: ['a.mjs'] }).code, 'RESERVATION_ACTIVE')
  assert.equal(store.reserve({ ...args, epoch: 2 }).code, 'RESERVATION_ACTIVE')
  assert.equal(store.reserve({ ...args, exclusive: true }).code, 'RESERVATION_ACTIVE')
  assert.deepEqual(store.listActiveReservations('r1')[0].paths, first.reservation.paths)
  assert.equal(store.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['b.mjs'] }).code, 'FILE_CONTENTION')
})

// ── BUG-006：`resolvePlannedPaths` 是「这个任务打算写哪些路径」的**唯一**取法 ──────────
//
// HTTP 面的四方向对照（诊断 vs 认领）在 team-hub/contention-paths.test.mjs；
// 这一条守的是**取法本身**的两个易错点：
//   · `??` 只在 null/undefined 时回落 ⇒ intent 的 paths 为**空数组**时**不**回落 fileDomain。
//     那是"显式申报了零个路径"，不是"没申报"；写成 `||`（或先判 length）就把这两件事混成一件事，
//     而后者的后果是"整仓独占"这个安全方向被悄悄放宽。
//   · fileDomain 是历史列、用户可能手改过 ⇒ 脏数据（不是数组）必须当空处理且**不抛**。
test('BUG-006 resolvePlannedPaths：intent 优先、空数组不回落、脏 fileDomain 不抛', () => {
  const { dbA: db, dbB } = pair()
  db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, fileDomain TEXT)')
  const store = createWriteIntentStore(db)
  const addTask = (id, fileDomain = null) => db.prepare('INSERT INTO tasks (id, fileDomain) VALUES (?,?)').run(id, fileDomain)

  // ① 无 intent、有 fileDomain ⇒ 用 fileDomain（字符串规范成 {path,type:'dir'}）
  addTask('t-dom', JSON.stringify(['a/', 'b/']))
  assert.deepEqual(store.resolvePlannedPaths('t-dom'), {
    paths: [{ path: 'a/', type: 'dir' }, { path: 'b/', type: 'dir' }],
    from: 'file-domain-fallback',
  })

  // ② 无 intent、无 fileDomain ⇒ 空数组 + unplanned-exclusive（调用方据此 exclusive:true）
  addTask('t-none')
  assert.deepEqual(store.resolvePlannedPaths('t-none'), { paths: [], from: 'unplanned-exclusive' })

  // ③ 有 intent ⇒ 一律以 intent 为准，**即使它申报的是零个路径**
  //
  //  这里守的是"没有 intent"与"intent 申报了零个路径"**不是同一件事**。两者都必须走 intent 分支：
  //  前者表现为"不该有 intent 却回落到 fileDomain"，后者表现为"零个路径被 fileDomain 顶替"。
  //  ★ 一句如实的说明：`??` 与 `||` 在这条上**恰好不可区分**（空数组在 JS 里是 truthy，
  //    `[] || fb` 仍是 `[]`）。所以真正要防的不是"写成 `||`"，而是把判断写成**长度**形态
  //    （`paths.length ? paths : fb` 或 `if (!paths.length)`）—— 那才会把这两件事混成一件。
  addTask('t-empty-intent', JSON.stringify(['z/']))
  assert.equal(store.upsertIntent({ repoId: 'r1', taskId: 't-empty-intent', attemptId: 'a1', targetRef: null, paths: [] }).ok, true)
  const emptyIntent = store.resolvePlannedPaths('t-empty-intent')
  assert.equal(emptyIntent.from, 'intent',
    'intent 存在时不许走 fileDomain 分支（判断若写成"路径数为 0 就回落"会在这里错）')
  assert.deepEqual(emptyIntent.paths, [], 'intent 申报零个路径就是零个，不许拿 fileDomain 顶替')

  // ④ 有 intent 且 fileDomain 是另一个目录 ⇒ 仍以 intent 为准（intent 优先的既有语义）
  addTask('t-wins', JSON.stringify(['other/']))
  assert.equal(store.upsertIntent({ repoId: 'r1', taskId: 't-wins', attemptId: 'a2', targetRef: null, paths: ['picked/'] }).ok, true)
  const wins = store.resolvePlannedPaths('t-wins')
  assert.equal(wins.from, 'intent')
  // intent 里存的是 upsertIntent **归一化过**的条目（去掉尾斜杠、type 默认 file），
  // 与 fileDomain 回落分支的 `{path,type:'dir'}` 形状不同 —— 这是既有行为，本次只统一取法，不改形状。
  assert.deepEqual([...wins.paths], [{ ok: true, path: 'picked', type: 'file' }])

  // ⑤ 脏 fileDomain ⇒ 当空处理，不抛。两种脏都要覆盖：
  //    · 合法 JSON 但不是数组（列被手改成对象）
  //    · **根本不是 JSON**（列被手改成随便一段文本）—— 这一种只有真正的 try/catch 兜底才过得去
  addTask('t-dirty', '{"not":"an array"}')
  assert.deepEqual(store.resolvePlannedPaths('t-dirty'), { paths: [], from: 'unplanned-exclusive' })
  addTask('t-broken', 'not json at all')
  assert.deepEqual(store.resolvePlannedPaths('t-broken'), { paths: [], from: 'unplanned-exclusive' })

  // ⑥ 调用方已读过的 intent 可以传入（避免二次读库导致两次判断不一致）
  const pre = store.getIntent('t-wins')
  assert.equal(store.resolvePlannedPaths('t-wins', { intent: pre }).from, 'intent')
  assert.deepEqual(store.resolvePlannedPaths('t-wins', { intent: null }), {
    paths: [{ path: 'other/', type: 'dir' }], from: 'file-domain-fallback',
  }, '显式传 null 表示"确实没有 intent" ⇒ 应当回落 fileDomain')
  db.close(); dbB.close()
})

// ── 预约续期（与租约同一次心跳） ──────────────────────────────────────────
//
// 这一组守的是"两条寿命不许漂移"：预约在 claim 时写死 `expires_at_ms`，
// 若没人延长它，一个跑得比租期长的任务就会变成"租约新鲜、预约已过期"，
// 而按 `expires_at_ms` 判定的路径会把**正在心跳的活任务**读成"进程未确认退出"。

test('renew 把到期时间推后，且不动路径与 epoch', () => {
  const { dbA: db } = pair()
  let clock = 1000
  const store = createWriteIntentStore(db, { now: () => clock })
  const r = store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 3, paths: ['src/a.mjs'], leaseMs: 500 })
  assert.equal(r.reservation.expiresAtMs, 1500)
  clock = 1200
  const renewed = store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 3, leaseMs: 500 })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.renewed, true)
  assert.equal(renewed.reservation.expiresAtMs, 1700)
  assert.deepEqual(renewed.reservation.paths.map((p) => p.path), ['src/a.mjs'], '续期不是扩域，路径必须原样')
  assert.equal(renewed.reservation.leaseEpoch, 3)
  assert.equal(store.listActiveReservations('r1').length, 1, '续期不新增预约行')
})

test('renew 之后租约不再"先过期"：sweepExpiredLeases 扫不到它', () => {
  const { dbA: db } = pair()
  let clock = 1000
  const store = createWriteIntentStore(db, { now: () => clock })
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'], leaseMs: 500 })
  // 心跳按 leaseMs/5 的节奏来，跑满 5 个租期：不续期的话第一轮之后就该被冻结
  for (let i = 0; i < 5; i += 1) {
    clock += 100
    assert.equal(store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, leaseMs: 500 }).ok, true)
  }
  assert.deepEqual(store.sweepExpiredLeases({ repoId: 'r1', nowMs: clock }), [], '续期过的预约不得被判过期')
  assert.equal(store.listActiveReservations('r1')[0].state, 'reserved')

  // 反证：停止续期、跨过租期之后，它**应当**被判过期。
  // 没有这一半，「扫不到」可能只是因为扫描根本不起作用。
  clock += 501
  assert.equal(store.sweepExpiredLeases({ repoId: 'r1', nowMs: clock }).length, 1)
})

test('reconciling 的预约拒绝续期：续期会抹掉那次对账冻结', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 5, paths: ['x.mjs'] })
  store.markReconciling({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 5, reason: 'UnknownOutcome' })
  const refused = store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 5 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'RECONCILING')
  assert.equal(store.listActiveReservations('r1')[0].state, 'reconciling', '冻结不得被续期按回去')
  assert.equal(store.listActiveReservations('r1')[0].reason, 'UnknownOutcome')
})

test('renew 的三条拒因各自具名：无预约 / epoch 过期 / 别的尝试', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  assert.equal(store.renew({ repoId: 'r1', taskId: 'none', attemptId: 'a1', epoch: 1 }).code, 'NO_ACTIVE_RESERVATION')
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a2', epoch: 9, paths: ['x.mjs'] })
  const stale = store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a2', epoch: 8 })
  assert.equal(stale.code, 'EPOCH_STALE')
  assert.equal(stale.currentEpoch, 9, '要把当前真实 epoch 告诉调用方，否则它只能无限重试')
  assert.equal(store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'other', epoch: 9 }).code, 'ATTEMPT_MISMATCH')
  assert.equal(store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a2', epoch: 9 }).ok, true, '正确的持有者仍然续得上')
})

test('renew 不追加事件：心跳是分钟级的，事件表是给 metrics 与审计读的', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['x.mjs'] })
  const before = store.listWriteIntentEvents('r1').length
  for (let i = 0; i < 20; i += 1) store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, leaseMs: 500 })
  assert.equal(store.listWriteIntentEvents('r1').length, before, '20 次续期不得写进 20 条事件')
})

test('leaseMs 为 null 表示"无到期"，与 reserve 的口径一致', () => {
  const { dbA: db } = pair()
  const store = createWriteIntentStore(db)
  store.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['x.mjs'], leaseMs: 500 })
  const cleared = store.renew({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, leaseMs: null })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.reservation.expiresAtMs, null)
  assert.equal(store.listWriteIntentEvents('r1').length, 1, '只有初始 RESERVED 那一条')
})

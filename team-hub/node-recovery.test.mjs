// team-hub/node-recovery.test.mjs
// 远程 Agent 通道 S-D：租约回收与预约结清。
//
// 这组用例守的是"一次旧得发霉的远端尝试能不能把整个队列堵死"。
// 实测堵过：一条 `Leased` 尝试占着单写者位，后面每一条验收任务都动不了，
// 而界面上只是"任务不动"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createNodeRecovery } from './node-recovery.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT, scheduling_state TEXT);
    CREATE TABLE run_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scope TEXT, state TEXT NOT NULL, lease_expires_at_ms INTEGER);
    CREATE TABLE write_reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, task_id TEXT NOT NULL,
      attempt_id TEXT, lease_epoch INTEGER, state TEXT NOT NULL);
  `)
  return db
}

function makeStores({ recovered = [], releaseResult = null } = {}) {
  const calls = { recoverExpired: [], release: [] }
  return {
    calls,
    runStore: {
      recoverExpired(args) {
        calls.recoverExpired.push(args)
        return { ok: true, scanned: recovered.length, recovered, serverTimeMs: Date.now() }
      },
    },
    writeIntentStore: {
      release(args) {
        calls.release.push(args)
        return releaseResult ?? { ok: true, reservation: { state: 'released' } }
      },
    },
  }
}

const addAttempt = (db, { id, taskId, state, leaseExpiresAtMs = null, scope = 'default' }) => {
  db.prepare('INSERT INTO run_attempts VALUES (?,?,?,?,?)').run(id, taskId, scope, state, leaseExpiresAtMs)
}
const addReservation = (db, { repoId = 'local:/repo', taskId, attemptId = null, epoch = 1, state = 'reserved' }) => {
  db.prepare('INSERT INTO write_reservations (repo_id,task_id,attempt_id,lease_epoch,state) VALUES (?,?,?,?,?)')
    .run(repoId, taskId, attemptId, epoch, state)
}
const addTask = (db, id) => { db.prepare('INSERT INTO tasks VALUES (?,?,NULL)').run(id, 'default') }

// ── 租约回收 ────────────────────────────────────────────────────────────────

test('到期租约被回收，且判定交给仓储（本模块不二次过滤）', () => {
  const db = makeDb()
  const stores = makeStores({ recovered: [{ attemptId: 'att-1', action: 'mark-unknown-outcome' }] })
  const r = createNodeRecovery({ db, ...stores })
  const out = r.sweepOnce()
  assert.equal(out.leasesRecovered, 1)
  assert.equal(stores.calls.recoverExpired.length, 1)
  // ★ 一律按"外部副作用可能已发生"处置。逾期的远端尝试可能已经推了远端、
  //   删了文件、付了款——两条出口里「可重试」会重复执行，「未知」只是要人对账。
  const verdict = stores.calls.recoverExpired[0].externalEffectPossible
  assert.equal(typeof verdict, 'function')
  for (const s of ['Leased', 'PreparingWorkspace', 'BuildingContext', 'Running', 'Validating', 'HandingOff', 'AwaitingApproval']) {
    assert.equal(verdict({ state: s }), true, `${s} 必须按"可能有副作用"处置`)
  }
})

test('回收器崩了也不抛（后台作业失败不该让 Hub 崩）', () => {
  const db = makeDb()
  const r = createNodeRecovery({
    db,
    runStore: { recoverExpired: () => { throw new Error('库锁住了') } },
    writeIntentStore: { release: () => ({ ok: true }) },
  })
  const out = r.sweepOnce()
  assert.equal(out.leasesRecovered, 0)
  assert.equal(out.errors.length, 1)
  assert.equal(out.errors[0].phase, 'recoverExpired')
  assert.match(out.errors[0].message, /库锁住了/)
})

// ── 预约结清 ────────────────────────────────────────────────────────────────

test('没有在途尝试的预约被结清（正是把队列堵死的那一类）', () => {
  const db = makeDb()
  addTask(db, 'T-1')
  // 尝试已经终结（RetryableFailure），但预约还挂着 —— 这就是 `finishTaskReservationInTx`
  // 只在看板迁移时被调用所留下的漏网之鱼。
  addAttempt(db, { id: 'att-1', taskId: 'T-1', state: 'RetryableFailure' })
  addReservation(db, { taskId: 'T-1', attemptId: 'att-1', epoch: 2 })
  const stores = makeStores()
  const r = createNodeRecovery({ db, ...stores })
  const out = r.sweepOnce()
  assert.equal(out.reservationsReleased, 1)
  assert.deepEqual(stores.calls.release, [{ repoId: 'local:/repo', taskId: 'T-1', attemptId: 'att-1', epoch: 2 }])
  assert.equal(db.prepare("SELECT scheduling_state FROM tasks WHERE id='T-1'").get().scheduling_state, 'released')
})

test('**有**在途尝试的预约绝不结清（那会把正在写的任务的空间让出去）', () => {
  const db = makeDb()
  addTask(db, 'T-1')
  addAttempt(db, { id: 'att-1', taskId: 'T-1', state: 'Running' })
  addReservation(db, { taskId: 'T-1', attemptId: 'att-1', epoch: 1 })
  const stores = makeStores()
  const r = createNodeRecovery({ db, ...stores })
  const out = r.sweepOnce()
  assert.equal(out.reservationsReleased, 0)
  assert.equal(out.reservationsSkipped, 1)
  assert.equal(stores.calls.release.length, 0, '不该动它')
})

test('reconciling 的预约同样按"有没有在途尝试"判定', () => {
  const db = makeDb()
  addTask(db, 'T-2')
  addAttempt(db, { id: 'att-2', taskId: 'T-2', state: 'UnknownOutcome' })
  addReservation(db, { taskId: 'T-2', attemptId: 'att-2', epoch: 3, state: 'reconciling' })
  const stores = makeStores()
  const out = createNodeRecovery({ db, ...stores }).sweepOnce()
  // `UnknownOutcome` **不是**在途状态（它不持有租约、等人工），所以这条预约该被结清。
  assert.equal(out.reservationsReleased, 1)
})

test('仓储拒绝释放时如实记账，不假装成功', () => {
  const db = makeDb()
  addTask(db, 'T-3')
  addReservation(db, { taskId: 'T-3', attemptId: 'att-3', epoch: 5 })
  const stores = makeStores({ releaseResult: { ok: false, code: 'EPOCH_STALE', reason: 'epoch 已过期' } })
  const out = createNodeRecovery({ db, ...stores }).sweepOnce()
  assert.equal(out.reservationsReleased, 0)
  assert.equal(out.reservationsSkipped, 1)
  assert.equal(out.reservationDetails[0].code, 'EPOCH_STALE')
})

test('没有预约时是干净的空跑（不发无意义的审计）', () => {
  const db = makeDb()
  const audited = []
  const out = createNodeRecovery({ db, ...makeStores(), audit: (...a) => audited.push(a) }).sweepOnce()
  assert.equal(out.reservationsReleased, 0)
  assert.deepEqual(audited, [])
})

test('构造期要求两个仓储（缺了是编程错误，不是运行期状况）', () => {
  const db = makeDb()
  assert.throws(() => createNodeRecovery({ db }), /runStore/)
  assert.throws(() => createNodeRecovery({ db, runStore: { recoverExpired: () => {} } }), /writeIntentStore/)
  assert.throws(() => createNodeRecovery({ runStore: { recoverExpired: () => {} }, writeIntentStore: { release: () => {} } }), /需要 db/)
})

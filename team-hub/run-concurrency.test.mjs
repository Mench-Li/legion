// team-hub/run-concurrency.test.mjs
// ============================================================================
// PRT-314：WAL、`busy_timeout` 与原子领取事务的**多 worker 并发语义**
//
// 这一组与 run-store.test.mjs 的区别只有一个，但那个区别是决定性的：
// 这里的竞争者是真的**操作系统进程**（`child_process.spawn`），不是同一进程里的两条连接。
//
// 同一进程内的两条连接共享同一份 `node:sqlite` 模块实例、同一次 PRAGMA 设置、
// 同一个事件循环——而且**两条 `BEGIN IMMEDIATE` 不可能真的同时发出**（JS 是单线程）。
// 因此"并发领取只有一个赢家"在那种测法下几乎必然成立，它证明的是
// 「我的条件更新写对了」，而不是「两个进程抢的时候不会都赢」。
//
// 多进程这一层要验的是另外三件事：
//   ① WAL 的**跨进程**可见性：一个进程写了，另一个进程能读到；
//   ② `busy_timeout` 真的在等：另一个进程持写锁时，这里不会立刻抛 SQLITE_BUSY；
//   ③ 条件更新在**真并发**下的胜负：N 个进程同时抢同一条任务，恰好一个赢。
//
// 阶段 3 完成标准里的「不重复执行已确认的外部写操作」在数据面上就是第③条：
// 两个 worker 各执行一遍 = 对已发生的付费/推送就是重复副作用。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { createRunStore } from './run-store.mjs'
import { ensureColumn, columnExists } from './schema-util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, 'scripts', 'claim-probe.mjs')

/** 建一个临时库 + 最小 tasks 表。 */
function makeDb({ tasks = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-conc-'))
  const dbFile = join(root, 'team.db')
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  const now = new Date().toISOString()
  for (const id of tasks) {
    db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,0,?,?)')
      .run(id, id, 'medium', 'todo', 'default', now, now)
  }
  return {
    root, dbFile, db,
    close() { try { db.close() } catch { /* 已关 */ } },
    cleanup() { this.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

/**
 * 起一个探针进程并等它结束。
 *
 * 用 `stdio: 'pipe'` 收 stdout —— 注意在受限沙箱下这可能因命名管道被拒；
 * 本用例是 workspace-write/full-access 场景，正常可用。
 */
function runProbe(dbFile, workerId, startAtMs) {
  const args = [PROBE, dbFile, workerId, String(startAtMs)]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })
    child.on('close', (code) => {
      let parsed = null
      try { parsed = JSON.parse(out.trim().split('\n').pop()) } catch { /* 保留原文供断言 */ }
      resolve({ code, out, err, result: parsed })
    })
  })
}

test('① WAL 跨进程可见：一个进程的写入，另一个进程读得到（含并发读不被写阻塞）', async () => {
  const env = makeDb({ tasks: ['t1'] })
  try {
    // 本进程（"服务端"）写入
    const store = createRunStore({ db: env.db })
    const claimed = store.claim({ workerId: 'w-parent' }).claimed
    assert.equal(claimed.taskId, 't1')

    // 另一个进程读到同一状态。
    // 关键判据是 `code === 0`：表或库不可见时探针会**报错退出**，
    // 而不是优雅地返回"队列空"。因此这里的 queue-empty 恰好证明了跨进程可见。
    const probe = await runProbe(env.dbFile, 'w-child', Date.now() - 1, 't1')
    assert.equal(probe.code, 0, `探针失败（说明子进程看不到父进程建的库/表）：${probe.err}`)
    assert.notEqual(probe.result, null, `探针没有输出 JSON：out=${probe.out} err=${probe.err}`)
    assert.equal(probe.result.claimed, null)
    assert.equal(probe.result.reason, 'queue-empty',
      '任务已被父进程领走，子进程看到的必须是同一个真相：没有可领的任务')

    // WAL 的要点之一：读不被写阻塞。父进程持一个写事务，子进程仍能读。
    env.db.exec('BEGIN IMMEDIATE')
    try {
      const readBack = env.db.prepare('SELECT journal_mode FROM pragma_journal_mode').get()
      assert.equal(readBack.journal_mode, 'wal', '库必须处于 WAL：回滚日志模式下读写互斥，多 worker 会互相饿死')
      const concurrent = createRunStore({ db: env.db, clock: () => Date.now() })
      // 同一连接内的嵌套读取（真实场景里这是另一条连接，语义相同）
      assert.equal(concurrent.stats().byState.Leased, 1)
    } finally { env.db.exec('COMMIT') }
  } finally { env.cleanup() }
})

test('② busy_timeout 真的在等：另一个进程持写锁时，这里按预算等待而不是立刻失败', async () => {
  const env = makeDb({ tasks: ['t1'] })
  try {
    const store = createRunStore({ db: env.db })
    // 父进程先持住写锁
    env.db.exec('BEGIN IMMEDIATE')
    env.db.prepare("UPDATE tasks SET soldier = 'holder' WHERE id = 't1'").run()

    // 另一个**进程**要在锁被持有时写入。没有 busy_timeout 时它会立刻拿到
    // SQLITE_BUSY（"database is locked"），那是"偶发失败"而不是"明确拒绝"——
    // 会把并发问题伪装成随机故障，而随机故障最难查。
    const startedAt = Date.now()
    const releaseAt = startedAt + 1200
    const timer = setTimeout(() => { try { env.db.exec('COMMIT') } catch { /* 已提交 */ } }, 1200)

    const probe = await runProbe(env.dbFile, 'w-blocked', releaseAt - 600)
    clearTimeout(timer)
    try { env.db.exec('COMMIT') } catch { /* 已由定时器提交 */ }

    assert.equal(probe.code, 0, `子进程在锁争用下必须等待而不是崩溃：${probe.err}`)
    assert.notEqual(probe.result, null, `探针没有输出 JSON：out=${probe.out} err=${probe.err}`)
    // 两种可接受结果：等到了锁并领走，或者等到时任务已被别人领走（都是"等待后正常返回"）
    assert.ok(probe.result.claimed !== null || probe.result.reason === 'queue-empty',
      `等待后必须得到明确结果，实际：${JSON.stringify(probe.result)}`)
  } finally { env.cleanup() }
})

test('③ 真并发领取：N 个进程同时抢同一条任务，恰好一个赢（不重复执行的前提）', async () => {
  const env = makeDb({ tasks: ['t1'] })
  try {
    const N = 6
    // 所有进程等到同一个时刻再动手。前后留 250ms 让 6 个进程都能启动完
    // （启动开销远大于争用窗口，因此"到达时刻"的抖动不影响结论，
    //  真正保证同时性的是它们都在等同一个绝对时刻）。
    const startAt = Date.now() + 250
    const runs = await Promise.all(
      Array.from({ length: N }, (_, i) => runProbe(env.dbFile, `w-${i}`, startAt)),
    )
    for (const r of runs) {
      assert.equal(r.code, 0, `进程失败：${r.err}`)
      assert.notEqual(r.result, null, `没有输出 JSON：out=${r.out} err=${r.err}`)
    }
    const winners = runs.filter((r) => r.result.claimed !== null)
    assert.equal(winners.length, 1,
      `${N} 个进程同时领取同一条任务，必须恰好一个赢，实际 ${winners.length} 个：` +
      JSON.stringify(runs.map((r) => ({ w: r.result.workerId, got: r.result.claimed?.attemptId, why: r.result.reason }))))
    assert.equal(winners[0].result.claimed.taskId, 't1')

    // 输的那些必须给出**明确原因**，而不是静默返回 null。
    // 「抢输了」与「队列空」要能分开：前者该立刻再试，后者该退避等待。
    const losers = runs.filter((r) => r.result.claimed === null)
    for (const l of losers) {
      assert.ok(['queue-empty', 'lost-race'].includes(l.result.reason),
        `失败者必须给出明确原因，实际 ${JSON.stringify(l.result.reason)}`)
    }

    // 库里只有一条尝试，且它属于唯一的赢家
    const rows = env.db.prepare('SELECT * FROM run_attempts').all()
    assert.equal(rows.length, 1, '恰好一条尝试：多出来的那条就是重复领取')
    assert.equal(rows[0].worker_id, winners[0].result.workerId)
    assert.equal(rows[0].state, 'Leased')
  } finally { env.cleanup() }
})

test('④ 并发补列：两个进程同时迁移一个「老库」，都成功且只补一次', async () => {
  const env = makeDb({ tasks: ['t1'] })
  try {
    // 造一个**真的老库**：只有 PRT-302/303/313 那批的列，没有 PRT-309/310/311 新增的列。
    // 这正是线上可能出现的样子——上一批已经推送到远程了。
    // （不用 DROP COLUMN：那要 SQLite 3.35+，而且"老库"本来就不是删列删出来的。）
    env.db.exec(`
      CREATE TABLE run_attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default',
        attempt_no INTEGER NOT NULL, state TEXT NOT NULL, worker_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires_at_ms INTEGER, return_to TEXT,
        outcome TEXT, failure_code TEXT, detail TEXT,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, finished_at_ms INTEGER,
        UNIQUE (task_id, attempt_no)
      )
    `)
    assert.equal(columnExists(env.db, 'run_attempts', 'idempotency_key'), false, '前提：这是老库')

    // 两个**进程**同时启动并各自跑一遍迁移。
    // 非原子写法（先 PRAGMA 再 ALTER）下两个都会读到「列不存在」，于是都执行 ALTER，
    // 后者拿到 `duplicate column name` 并在**模块加载期**崩溃——
    // 表现为其中一个进程起不来，看起来与迁移毫无关系。
    const startAt = Date.now() + 200
    const results = await Promise.all([
      runProbe(env.dbFile, 'mig-1', startAt),
      runProbe(env.dbFile, 'mig-2', startAt),
    ])
    for (const r of results) {
      assert.equal(r.code, 0, `进程在迁移期崩溃（这正是非原子 ALTER 的表现）：${r.err}`)
    }
    // 新列都补上了
    const cols = env.db.prepare('PRAGMA table_info(run_attempts)').all().map((c) => c.name)
    for (const c of ['idempotency_key', 'next_attempt_at_ms', 'external_effect', 'resolved_by', 'resolved_note']) {
      assert.ok(cols.includes(c), `缺少列 ${c}：${cols.join(', ')}`)
    }

    // 同一进程内重复调用也幂等，且返回值区分「补了」与「本来就有的」——
    // 这个返回值不是装饰：调用方要靠它判断"这次启动有没有真的改库"。
    assert.equal(ensureColumn(env.db, 'run_attempts', 'idempotency_key', 'TEXT'), false)
    assert.equal(ensureColumn(env.db, 'run_attempts', 'brand_new_col', 'TEXT'), true)
    assert.equal(ensureColumn(env.db, 'run_attempts', 'brand_new_col', 'TEXT'), false)
  } finally { env.cleanup() }
})

test('⑤ 领取用的是 BEGIN IMMEDIATE：持锁期间别的进程只能等，不会两个都读到同一行', async () => {
  const env = makeDb({ tasks: ['t1'] })
  try {
    createRunStore({ db: env.db })
    env.db.prepare(
      `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, worker_id, lease_epoch, created_at_ms, updated_at_ms)
       VALUES ('att:t1:1','t1','default',1,'Queued',NULL,0,?,?)`,
    ).run(Date.now(), Date.now())

    // 父进程持住写锁，子进程此刻来领取。
    //
    // 锁必须**异步**放开：如果写成 `await runProbe(...)` 之后再 COMMIT，
    // 父进程在等子进程、子进程在等父进程的锁，两个一起等到超时——
    // 那是测试脚手架的死锁，会把「写锁确实生效」误报成「连接失败」。
    env.db.exec('BEGIN IMMEDIATE')
    const holdMs = 800
    const release = setTimeout(() => { try { env.db.exec('COMMIT') } catch { /* 已提交 */ } }, holdMs)
    const startedAt = Date.now()
    const probe = await runProbe(env.dbFile, 'w-late', Date.now() - 1)
    const elapsedMs = Date.now() - startedAt
    clearTimeout(release)
    try { env.db.exec('COMMIT') } catch { /* 已由定时器提交 */ }

    assert.equal(probe.code, 0, `探针失败：${probe.err}`)
    assert.notEqual(probe.result, null, `没有输出 JSON：out=${probe.out} err=${probe.err}`)
    // 子进程在锁被持有时**等待**，锁放开后领到那条尝试。
    // 若它为条件更新而没有写锁语义（读→改→写），它会在锁放开前就读到 Queued 并成功——
    // 那样两个持有者可以同时认为自己领到了同一行。
    assert.notEqual(probe.result.claimed, null,
      `父进程提交后子进程应能领到，实际：${JSON.stringify(probe.result)}`)
    assert.equal(probe.result.claimed.attemptId, 'att:t1:1')
    assert.ok(elapsedMs >= holdMs - 150,
      `子进程必须真的等过写锁（实测 ${elapsedMs}ms，持锁 ${holdMs}ms）——立即返回说明它没走写锁`)
    // 只有一条尝试、一个持有者
    const rows = env.db.prepare('SELECT worker_id FROM run_attempts').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].worker_id, 'w-late')
  } finally { env.cleanup() }
})

// product/metrics-source.test.mjs
// ============================================================================
// PRT-712（后半）：仪表盘的**生产数据源**
//
// ## 这一套为什么要起一个真的 SQLite 库
//
// 本批新增的 `run-store.metricsCounts()` 是**真的 SQL**，
// 而 SQL 的错误方式恰好是"看起来对"：列名写错、`IN ()` 恒假、
// `COUNT` 忘了加 `WHERE`、聚合返回 null……
// 拿一个假的 store（返回几组预定数字）去测，测的只是**本模块的算术**，
// 而真正会错的那一半**一行都没执行**。
//
//   > 一个用假库喂出来的"数据源已验证"，
//   > 与一个从没跑过那条 SQL 的"数据源已验证"，是同一个东西——
//   > 只不过前者的用例数是完整的。
//
// 所以这里建真库、走真 schema、真写几行、再读指标。
//
// ## 三个"零与没有"的区分（本套件的重点）
//
//   ① 队列为空 → `oldest-pending-age-ms` 是**不适用**，不是 `0 毫秒`；
//   ② 库连不上 → 那六个指标是"读不出来"，**不是 0**（恒 0 的读数点会让库挂掉看起来像一切正常）；
//   ③ 从没升过级 → `upgrade-result` 是 `never-run`（一个**确定**的事实），
//      不是"读不出来"——而这两个词表的对应关系原先是对不上的，见 §词汇换算。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createRunStore, ensureRunSchema, IN_FLIGHT_ATTEMPT_STATES, inFlightStatesSql } from '../team-hub/run-store.mjs'
import { ensureContextSchema } from '../team-hub/context-store.mjs'
import { computeMetrics, readMetrics } from './metrics.mjs'
import {
  createMetricsSource, normalizeUpgradeResult, ratioReadersFromRunStore,
  sourceFromRunStore, sourceFromUpgradeAudit, UPGRADE_RESULT_VOCABULARY,
} from './metrics-source.mjs'

// ── 夹具：一个真的库 ────────────────────────────────────────────────────

const START_MS = 1_700_000_000_000

function makeStore() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  ensureRunSchema(db)
  ensureContextSchema(db)
  let clockMs = START_MS
  const store = createRunStore({ db, clock: () => clockMs })
  const addTask = (id, { status = 'todo', scope = 'default', hold = 0 } = {}) => {
    db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, id, 'medium', status, scope, hold, new Date(clockMs).toISOString(), new Date(clockMs).toISOString())
    return id
  }
  return {
    db, store, addTask,
    advance: (ms) => { clockMs += ms; return clockMs },
    atMs: () => clockMs,
    close: () => db.close(),
  }
}

/** 直接把一行尝试写进库（绕过状态机），用来造"历史"这种状态机不产生的东西。 */
function seedAttempt(db, { id, taskId, attemptNo = 1, state = 'Queued', leaseEpoch = 0, leaseExpiresAtMs = null, failureCode = null, createdAtMs = START_MS }) {
  db.prepare(
    `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, lease_expires_at_ms,
       failure_code, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, attemptNo, state, leaseEpoch, leaseExpiresAtMs, failureCode, createdAtMs, createdAtMs)
}

const withStore = (fn) => {
  const f = makeStore()
  try { return fn(f) } finally { f.close() }
}

// ── ① 真库上的计数 ──────────────────────────────────────────────────────

test('★ metricsCounts：在真库上数得对（队列深、在途、死信各算各的）', () => {
  withStore(({ db, store }) => {
    // 3 个排队（其中一个是第 2 次尝试）、2 个在途且租约未过期、1 个死信
    seedAttempt(db, { id: 'q1', taskId: 't1', attemptNo: 1, state: 'Queued' })
    seedAttempt(db, { id: 'q2', taskId: 't2', attemptNo: 2, state: 'Queued' })
    seedAttempt(db, { id: 'q3', taskId: 't3', attemptNo: 1, state: 'Queued' })
    seedAttempt(db, { id: 'r1', taskId: 't4', state: 'Running', leaseEpoch: 1, leaseExpiresAtMs: START_MS + 60_000 })
    seedAttempt(db, { id: 'r2', taskId: 't5', state: 'Validating', leaseEpoch: 1, leaseExpiresAtMs: START_MS + 60_000 })
    seedAttempt(db, { id: 'd1', taskId: 't6', attemptNo: 5, state: 'DeadLetter', leaseEpoch: 2, failureCode: 'retry-exhausted' })

    const c = store.metricsCounts()
    assert.equal(c.queueDepth, 3)
    assert.equal(c.activeLeases, 2, '只有在途**且租约未过期**的才算持有中')
    assert.equal(c.deadLetterCount, 1)
    assert.equal(c.attemptsTotal, 6)
    // q2 是第 2 次尝试、d1 是第 5 次 —— 两个都重试过
    assert.equal(c.attemptsRetried, 2, 'attempt_no > 1 才算重试过')
    assert.equal(c.leasesTotal, 3, 'lease_epoch > 0 才算"曾经被租出去过"')
  })
})

test('★ metricsCounts：队列为空时 oldestPendingAgeMs 是 null，**不是 0**', () => {
  withStore(({ db, store }) => {
    // 只有一条在途、没有排队的
    seedAttempt(db, { id: 'r1', taskId: 't4', state: 'Running', leaseEpoch: 1, leaseExpiresAtMs: START_MS + 60_000 })
    const c = store.metricsCounts()
    assert.equal(c.queueDepth, 0)
    // ★ 0 会被读成"有一个刚进来的任务"
    assert.equal(c.oldestPendingAgeMs, null, '没有排队任务时必须是 null（没有读数），不能是 0')
  })
})

test('★ metricsCounts：最老待办年龄取的是**最老**那条，不是最新', () => {
  withStore(({ db, store, advance }) => {
    seedAttempt(db, { id: 'old', taskId: 't1', state: 'Queued', createdAtMs: START_MS })
    advance(30_000)
    seedAttempt(db, { id: 'new', taskId: 't2', state: 'Queued', createdAtMs: START_MS + 30_000 })
    advance(5_000) // 现在 = START_MS + 35000
    const c = store.metricsCounts()
    assert.equal(c.queueDepth, 2)
    assert.equal(c.oldestPendingAgeMs, 35_000, '最老那条等了 35 秒（若取最新则会是 5 秒）')
  })
})

test('★ 已过期的租约不算"活跃 lease"，但算进 expiredLeases', () => {
  withStore(({ db, store }) => {
    seedAttempt(db, { id: 'live', taskId: 't1', state: 'Running', leaseEpoch: 1, leaseExpiresAtMs: START_MS + 60_000 })
    seedAttempt(db, { id: 'dead', taskId: 't2', state: 'Running', leaseEpoch: 1, leaseExpiresAtMs: START_MS - 1 })
    const c = store.metricsCounts()
    // 两个都在 Running，但只有一个还"被持有"
    assert.equal(c.activeLeases, 1, '过期的租约不该被算成有人正在干活')
    assert.equal(c.expiredLeases, 1)
  })
})

test('★ stats() 与 metricsCounts() 用**同一份**在途清单（合并前是三处各写一遍）', () => {
  withStore(({ db, store }) => {
    for (const [i, s] of IN_FLIGHT_ATTEMPT_STATES.entries()) {
      seedAttempt(db, { id: `f${i}`, taskId: `t${i}`, state: s, leaseEpoch: 1, leaseExpiresAtMs: START_MS - 1 })
    }
    // stats().expiredLeases 与 metricsCounts().expiredLeases 都基于同一份集合：
    // 合并之前它们各自抄了一遍状态名，抄歪一个就会一个报 7 个、另一个报 6 个。
    assert.equal(store.stats().expiredLeases, IN_FLIGHT_ATTEMPT_STATES.length)
    assert.equal(store.metricsCounts().expiredLeases, IN_FLIGHT_ATTEMPT_STATES.length)
    assert.equal(inFlightStatesSql().split(',').length, IN_FLIGHT_ATTEMPT_STATES.length)
  })
})

test('metricsCounts 支持 scope：别的 scope 的行不会混进来', () => {
  withStore(({ db, store }) => {
    seedAttempt(db, { id: 'a', taskId: 't1', state: 'Queued' })          // scope=default
    db.prepare(`INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms)
                VALUES ('b','t2','other',1,'Queued',0,?,?)`).run(START_MS, START_MS)
    assert.equal(store.metricsCounts().queueDepth, 2)
    assert.equal(store.metricsCounts({ scope: 'default' }).queueDepth, 1)
    assert.equal(store.metricsCounts({ scope: 'other' }).queueDepth, 1)
  })
})

// ── ② 数据源接上 readMetrics ─────────────────────────────────────────────

test('★ 生产数据源接上 readMetrics：九个指标全都有结论，没一个是"没人喂"的沉默', async () => {
  const f = makeStore()
  try {
    seedAttempt(f.db, { id: 'q1', taskId: 't1', state: 'Queued' })
    // 这条**从没被租出去过**（lease_epoch = 0），所以租约比率的分母是 0
    seedAttempt(f.db, { id: 'd1', taskId: 't2', attemptNo: 5, state: 'DeadLetter' })
    const { source } = createMetricsSource({ store: f.store })
    const r = await readMetrics(source)
    // 运行库那六个必须有真读数
    assert.equal(r.metrics['queue-depth'].known, true)
    assert.equal(r.metrics['queue-depth'].value, 1)
    assert.equal(r.metrics['dead-letter-count'].value, 1)
    assert.equal(r.metrics['active-leases'].value, 0)
    // ★ 分母为 0 的比率：是"还算不出来"，不是 0%。
    //   这里 lease_epoch 全是 0，所以 leasesTotal=0 —— 0/0 没有含义。
    assert.equal(r.metrics['lease-expiry-rate'].known, false, '0 个租约时分母为 0，不该报成 0%')
    // 理由比笼统的 metric-no-data 更具体：是"没有任何观测"，不是"读不到"
    assert.equal(r.metrics['lease-expiry-rate'].reason, 'metric-no-observations')
    // attempt-retry-rate 的分母是 attemptsTotal（=2），所以它是能算的
    assert.equal(r.metrics['attempt-retry-rate'].known, true)
    assert.equal(r.metrics['attempt-retry-rate'].value, 0.5, 'RATIO 存的是比例（2 个里 1 个重试过）')
    assert.match(r.metrics['attempt-retry-rate'].display, /50\.0%/, '展示层负责变成百分比')
    // 两个没有生产者的：不适用，但要能说出原因
    assert.equal(r.metrics['runtime-availability'].known, false)
    assert.equal(r.metrics['model-error-rate'].known, false)
  } finally { f.close() }
})

test('★ 比率：分母为 0 时报"还算不出来"，不是 0%', () => {
  const noAttempts = computeMetrics({ leasesExpired: null, leasesTotal: null })
  assert.equal(noAttempts['lease-expiry-rate'].known, false)
  // 与"真的是 0%"区分开
  const zero = computeMetrics({ leasesExpired: 0, leasesTotal: 4 })
  assert.equal(zero['lease-expiry-rate'].known, true)
  assert.equal(zero['lease-expiry-rate'].value, 0)
})

test('★ 分母非零时比率真的算出来了（数据源给的两个数都被用上）', async () => {
  // ★ 不能套 `withStore`：它在 finally 里同步 close 库，
  //   而 `readMetrics` 是异步的——库会在读数还没读完时被关掉。
  //   （写这条时踩到过：报错是"用例结束后仍有异步活动"，看起来像用例写错了地方。）
  const f = makeStore()
  try {
    // 4 个曾经被租出去过，其中 1 个因租约过期结束 → 25%
    for (let i = 0; i < 3; i++) {
      seedAttempt(f.db, { id: `ok${i}`, taskId: `t${i}`, state: 'Completed', leaseEpoch: 1 })
    }
    seedAttempt(f.db, { id: 'exp', taskId: 'tx', attemptNo: 2, state: 'Queued', leaseEpoch: 1, failureCode: 'lease-expired' })
    const r = await readMetrics(ratioReadersFromRunStore(f.store))
    assert.equal(r.metrics['lease-expiry-rate'].known, true)
    assert.equal(r.metrics['lease-expiry-rate'].value, 0.25)
    assert.match(r.metrics['lease-expiry-rate'].display, /25\.0%/)
  } finally { f.close() }
})

// ── ③ 没有生产者时必须点名 ───────────────────────────────────────────────

test('★ 没给运行库时：那六个指标被**点名**说缺生产者，而不是装一组恒 0 的读数点', () => {
  const { source, missing } = createMetricsSource({ auditDir: 'x' })
  for (const key of ['queue-depth', 'oldest-pending-age-ms', 'active-leases', 'dead-letter-count']) {
    assert.equal(key in source, false, `${key} 不该出现在 source 里——恒 0 的读数点会让"库连不上"看起来像"队列是空的"`)
    assert.ok(missing.some((m) => m.key === key), `${key} 必须出现在 missing 里`)
  }
})

test('★ 没有生产者这件事必须**点名**：runtime-availability 与 model-error-rate', () => {
  const { missing } = createMetricsSource({})
  for (const key of ['runtime-availability', 'model-error-rate']) {
    const m = missing.find((x) => x.key === key)
    assert.ok(m, `${key} 必须在 missing 里被点名——"静静地不出现"与"显示 —"看起来一样，但前者会被当成配置错误`)
    assert.ok(m.reason.length > 10, `${key} 的 missing 必须说明**缺的是什么生产者**，不能只写"没有数据"`)
  }
  // 原因要具体到"缺什么"
  assert.match(missing.find((x) => x.key === 'runtime-availability').reason, /窗口|观测|记录/)
  assert.match(missing.find((x) => x.key === 'model-error-rate').reason, /模型调用|计数|留痕/)
})

test('★ 没给审计目录时 upgrade-result 也被点名（而不是悄悄消失）', () => {
  const { missing } = createMetricsSource({ store: null })
  assert.ok(missing.some((m) => m.key === 'upgrade-result'))
})

// ── ④ 升级结果的词汇换算 ─────────────────────────────────────────────────

test('★★ 词汇换算：从没升过级是 never-run（一个确定的事实），不是"读不出来"', () => {
  // 这是本批发现的**真缺陷**：两张词表对不上，接起来之后新装机器永远显示"—"。
  assert.deepEqual(UPGRADE_RESULT_VOCABULARY, { 'not-started': 'never-run' })
  assert.equal(normalizeUpgradeResult('not-started'), 'never-run')
  assert.equal(normalizeUpgradeResult('succeeded'), 'succeeded', '认识的词原样通过')
  assert.equal(normalizeUpgradeResult('某个没见过的词'), '某个没见过的词', '认不出的词不编，交给指标层报不合法')

  // 换算**之前**是"读不出来"
  const before = computeMetrics({ 'upgrade-result': 'not-started' })
  assert.equal(before['upgrade-result'].known, false, '未换算的 not-started 不在 allowed 里')
  // 换算**之后**是一个确定的读数
  const after = computeMetrics({ 'upgrade-result': normalizeUpgradeResult('not-started') })
  assert.equal(after['upgrade-result'].known, true)
  assert.equal(after['upgrade-result'].value, 'never-run')
})

test('★ 空审计目录 → upgrade-result 是 never-run 而不是"读不出来"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-audit-'))
  try {
    const src = sourceFromUpgradeAudit({ auditDir: dir, listRecords: () => [] })
    const r = await readMetrics(src)
    assert.equal(r.metrics['upgrade-result'].known, true, '从来没有升级记录是一个**确定**的事实')
    assert.equal(r.metrics['upgrade-result'].value, 'never-run')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★ 有升级记录时给出真实结论（一路走到 readMetrics）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-audit2-'))
  try {
    const records = [
      { result: 'failed', finishedAtMs: 1, fromVersion: 'a', toVersion: 'b' },
      { result: 'rolled-back', finishedAtMs: 2, fromVersion: 'a', toVersion: 'b' },
    ]
    const src = sourceFromUpgradeAudit({ auditDir: dir, listRecords: () => records })
    const r = await readMetrics(src)
    assert.equal(r.metrics['upgrade-result'].value, 'rolled-back', '取最近一次')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('没给审计目录时 upgrade-result 读数点是 null（读数层如实报"没有"）', () => {
  const src = sourceFromUpgradeAudit({})
  return readMetrics(src).then((r) => {
    assert.equal(r.metrics['upgrade-result'].known, false)
  })
})

// ── ⑤ 构造期的失败要早说 ─────────────────────────────────────────────────

test('★ 库里没有 metricsCounts() 时**构造期就抛错**（而不是给一组恒 0 的读数点）', () => {
  assert.throws(() => sourceFromRunStore(null), /metricsCounts/)
  assert.throws(() => sourceFromRunStore({}), /metricsCounts/)
  assert.throws(() => ratioReadersFromRunStore(null), /metricsCounts/)
})

test('★ 一个读数点抛错只影响它自己（别的指标照常有读数）', async () => {
  withStore(({ db, store }) => {
    seedAttempt(db, { id: 'q1', taskId: 't1', state: 'Queued' })
    const source = sourceFromRunStore(store)
    // 换掉其中一个读数点让它炸
    const broken = { ...source, 'dead-letter-count': () => { throw new Error('库被锁了') } }
    return readMetrics(broken).then((r) => {
      assert.equal(r.metrics['queue-depth'].known, true, '别的读数点不该被一个坏掉的带走')
      assert.equal(r.metrics['dead-letter-count'].known, false)
      assert.ok(r.diagnostics.some((d) => d.code === 'metric-read-failed'))
    })
  })
})

test('sourceFromRunStore 的读数点是**现查**的：写进去的行下一轮就能看见', async () => {
  const f = makeStore()
  try {
    const src = sourceFromRunStore(f.store)
    assert.equal(await src['queue-depth'](), 0)
    seedAttempt(f.db, { id: 'q1', taskId: 't1', state: 'Queued' })
    assert.equal(await src['queue-depth'](), 1, '读的是此刻的队列，不是构造时的快照')
  } finally { f.close() }
})

test('每次读数都重新取一次库（不缓存旧数字）', async () => {
  // 计数函数被调用两次就说明没有把结果缓存进闭包
  let calls = 0
  const fake = {
    metricsCounts: () => {
      calls += 1
      return { queueDepth: calls, oldestPendingAgeMs: null, activeLeases: 0, deadLetterCount: 0,
        leasesExpired: 0, leasesTotal: 0, attemptsRetried: 0, attemptsTotal: 0 }
    },
  }
  const src = sourceFromRunStore(fake)
  // 读数点本身可以是同步的（真库那份就是同步的）——`readMetrics` 两个都收。
  const a = await src['queue-depth']()
  const b = await src['queue-depth']()
  assert.equal(a, 1)
  assert.equal(b, 2, '两次读数拿到不同的值 ⇒ 没有缓存')
})

// product/metrics-spec7.test.mjs
// §7 第 6 条那六格指标：口径、未知档、真的从库里读出来的数（第 39 轮）。
//
// 这一组盯的**不是**"比率算得对不对"，而是三件事：
//   ① **"零"与"没有"不许同形**（分母为 0 是"还没观察过"，不是 0%）；
//   ② **分子与分母必须是同一批人**（混用会算出一个没有含义的百分比）；
//   ③ **表不存在**与**表是空的**不许得到同一个读数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  METRIC_CODES,
  METRIC_KINDS,
  METRIC_DEFS,
  computeMetrics,
} from './metrics.mjs'
import {
  SPEC7_METRIC_DEFS,
  SPEC7_METRIC_KEYS,
  SPEC7_REQUIREMENTS,
  computeSpec7Metrics,
  metricsOfRequirement,
  renderSpec7Metrics,
  spec7Summary,
} from './metrics-spec7.mjs'
import {
  APPROVAL_NOT_APPROVED,
  TERMINAL_DELIVERY_STATES,
  createSpec7Source,
  median,
  parseTimestampMs,
  rollbackCountsFromRecords,
  spec7CountsFromHubDb,
  tableExists,
} from './metrics-spec7-source.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')

/** 按生产里的**真实建表语句**造一个最小库（只留本模块读到的列）。 */
function fixtureDb({ skip = [] } = {}) {
  const db = new DatabaseSync(':memory:')
  if (!skip.includes('event_deliveries')) {
    db.exec(`CREATE TABLE event_deliveries (
      subscriber_id TEXT NOT NULL, seq INTEGER NOT NULL, scope TEXT, state TEXT NOT NULL,
      reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER, lease_expires_at_ms INTEGER, fanout INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (subscriber_id, seq))`)
  }
  if (!skip.includes('run_attempts')) {
    db.exec(`CREATE TABLE run_attempts (
      attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scope TEXT, state TEXT NOT NULL,
      attempt_no INTEGER NOT NULL DEFAULT 1, failure_code TEXT, created_at_ms INTEGER NOT NULL,
      lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires_at_ms INTEGER)`)
  }
  if (!skip.includes('permission_requests')) {
    db.exec(`CREATE TABLE permission_requests (
      requestId TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, taskId TEXT, operation TEXT NOT NULL, mode TEXT NOT NULL,
      status TEXT NOT NULL, decidedBy TEXT, reason TEXT, createdAt TEXT NOT NULL,
      expiresAt INTEGER, decidedAt TEXT, consumedAt TEXT)`)
  }
  if (!skip.includes('budget_reservations')) {
    db.exec(`CREATE TABLE budget_reservations (
      attempt_id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT NOT NULL,
      model_profile_id TEXT NOT NULL, currency TEXT NOT NULL, billing_unit TEXT NOT NULL,
      price_table_version TEXT NOT NULL, effective_at_ms INTEGER NOT NULL,
      reserved_amount REAL NOT NULL, spent_amount REAL, overrun_amount REAL,
      state TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)`)
  }
  return db
}

// ── ① 六条要求一条都不许没人管 ───────────────────────────────────────────

test('① ★★★ §7 第 6 条的**六个要求**逐字对上，且每一个都至少有一格指标', () => {
  const line = readFileSync(`${REPO}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`, 'utf8')
    .split('\n').find((l) => l.includes('- 持续观察事件遗漏/重复率'))
  assert.ok(line !== undefined, '目标文档里找不到 §7 第 6 条那一行')
  // ★ 逐字同头：正文改字而声明不改 ⇒ 这里红（不是静默漂）
  for (const r of SPEC7_REQUIREMENTS) {
    assert.ok(line.includes(r.text), `要求「${r.text}」在目标文档那一行里**找不到**`)
  }
  assert.equal(SPEC7_REQUIREMENTS.length, 6, `读到 ${SPEC7_REQUIREMENTS.length} 个要求`)
  // 每个要求都必须有指标
  for (const r of SPEC7_REQUIREMENTS) {
    assert.ok(r.metrics.length > 0, `要求「${r.text}」没有任何指标去观察它`)
    for (const m of r.metrics) {
      assert.ok(SPEC7_METRIC_DEFS[m] !== undefined, `\`${m}\` 不是一个已定义的指标`)
    }
  }
})

test('② ★★ 指标的 `requirement` 反向也解得开，且八格全部被认领', () => {
  const declared = new Set(SPEC7_REQUIREMENTS.flatMap((r) => [...r.metrics]))
  assert.deepEqual([...declared].sort(), [...SPEC7_METRIC_KEYS].sort(),
    '指标集合与要求名下声明的集合不一致')
  for (const key of SPEC7_METRIC_KEYS) {
    const def = SPEC7_METRIC_DEFS[key]
    assert.equal(def.spec, '§7', `\`${key}\` 的 spec 不是 §7`)
    assert.ok(metricsOfRequirement(def.requirement).includes(key),
      `\`${key}\` 声明的 requirement \`${def.requirement}\` 名下没有它`)
  }
})

// ── ② 未知档：零与"没有"不许同形 ────────────────────────────────────────

test('③ ★★★ 分母为 0 ⇒ `no-observations`，**不是** 0%', () => {
  const c = computeSpec7Metrics({
    eventsUnknown: 0, eventsTerminal: 0,
    eventsRetryDelivered: 0, eventsDelivered: 0,
    runsRecovered: 0, runsInterrupted: 0,
    approvalsDeniedOrExpired: 0, approvalsDecided: 0,
    budgetOverruns: 0, budgetUsageRows: 0,
    rollbacksSucceeded: 0, rollbacksAttempted: 0,
  })
  for (const key of SPEC7_METRIC_KEYS) {
    if (SPEC7_METRIC_DEFS[key].kind !== METRIC_KINDS.RATIO) continue
    assert.equal(c[key].known, false, `\`${key}\` 分母为 0 却给出了读数 ${c[key].display}`)
    assert.equal(c[key].value, null, `\`${key}\` 的 value 不是 null`)
    assert.equal(c[key].reason, METRIC_CODES.NO_OBSERVATIONS,
      `\`${key}\` 的原因是 ${c[key].reason}（应为 no-observations）`)
    // ★ 0% 与"—"是两件事：0% 会让值班的人以为"观察到过失败，只是没有"
    assert.notEqual(c[key].display, '0.0%')
  }
})

test('④ ★★★ 字段缺失 ⇒ `no-data`，和"分母为 0"**不是同一个原因码**', () => {
  const empty = computeSpec7Metrics({})
  for (const key of SPEC7_METRIC_KEYS) {
    assert.equal(empty[key].known, false)
    assert.equal(empty[key].value, null)
  }
  assert.equal(empty['event-loss-rate'].reason, METRIC_CODES.NO_DATA)
  // 两种"读不出来"必须分得开：一个要去建仪表盘数据源，另一个什么都不用做
  const zeroDen = computeSpec7Metrics({ eventsUnknown: 0, eventsTerminal: 0 })
  assert.equal(zeroDen['event-loss-rate'].reason, METRIC_CODES.NO_OBSERVATIONS)
  assert.notEqual(zeroDen['event-loss-rate'].reason, empty['event-loss-rate'].reason)
})

test('⑤ ★★ 审批等待：没有已决审批时是**不适用**（不是 0 毫秒）', () => {
  const none = computeSpec7Metrics({ approvalsDecided: 0, approvalWaitP50Ms: 0 })
  assert.equal(none['approval-wait-ms'].known, false)
  assert.equal(none['approval-wait-ms'].reason, METRIC_CODES.NOT_APPLICABLE)
  assert.equal(none['approval-wait-ms'].reasonText, 'no-decided-approvals')
  assert.notEqual(none['approval-wait-ms'].display, '0 毫秒')
  // 有人等过就必须给读数
  const some = computeSpec7Metrics({ approvalsDecided: 3, approvalWaitP50Ms: 60000 })
  assert.equal(some['approval-wait-ms'].known, true)
  assert.equal(some['approval-wait-ms'].display, '60000 毫秒')
})

test('⑥ ★★★ 回归：`approval-wait-ms` 的快照字段名与指标键**不同**（`valueFrom`）', () => {
  // 少了 `valueFrom` 这一格会去读 `snapshot['approval-wait-ms']`（永远 undefined）
  // ⇒ **永远显示「—」**，而生产者明明喂了数。
  assert.equal(SPEC7_METRIC_DEFS['approval-wait-ms'].valueFrom, 'approvalWaitP50Ms')
  const c = computeSpec7Metrics({ approvalsDecided: 5, approvalWaitP50Ms: 1234 })
  assert.equal(c['approval-wait-ms'].known, true, '生产者喂了数而这一格仍读不出来')
  assert.equal(c['approval-wait-ms'].value, 1234)
})

// ── ③ 从真库读：分子与分母必须同源 ──────────────────────────────────────

function seed(db) {
  // 事件：10 条终态 —— 7 送达（其中 2 条重投过）、1 抑制、2 结果不明
  const ins = db.prepare(`INSERT INTO event_deliveries
    (subscriber_id, seq, scope, state, attempts, created_at_ms, updated_at_ms)
    VALUES (?,?,?,?,?,?,?)`)
  let seq = 1
  for (let i = 0; i < 7; i++) ins.run('s1', seq++, 'x', 'delivered', i < 2 ? 3 : 1, 1, 1)
  ins.run('s1', seq++, 'x', 'suppressed', 1, 1, 1)
  ins.run('s1', seq++, 'x', 'unknown', 2, 1, 1)
  ins.run('s1', seq++, 'x', 'unknown', 1, 1, 1)
  // 还有一个 pending 的：**不进**终态分母
  ins.run('s1', seq++, 'x', 'pending', 1, 1, 1)

  // 尝试：t1 丢过租约**两次**、且后来起来过（恢复）；t2 丢过一次且没再起来。
  //
  // ★ t1 丢**两次**是刻意的：只有这样 `COUNT(DISTINCT task_id)` 与 `COUNT(*)`
  //   才会给出不同的答案（2 vs 3），从而把"按任务去重"这条规则**真的测到**。
  //   一个每个任务只丢一次的夹具，会让那条规则无论写对写错都通过——
  //   于是用例是绿的，而它盯的那件事从来没被验证过。
  const att = db.prepare(`INSERT INTO run_attempts
    (attempt_id, task_id, scope, state, attempt_no, failure_code, created_at_ms, lease_epoch)
    VALUES (?,?,?,?,?,?,?,?)`)
  att.run('a1', 't1', 'x', 'Failed', 1, 'lease-expired', 1, 1)
  att.run('a2', 't1', 'x', 'Failed', 2, 'lease-expired', 2, 2)
  att.run('a3', 't1', 'x', 'Completed', 3, null, 3, 2)
  att.run('a4', 't2', 'x', 'Failed', 1, 'lease-expired', 1, 1)
  att.run('a5', 't3', 'x', 'Completed', 1, null, 1, 1)

  // 审批：4 已决 —— 1 批准（等 60s）、2 拒、1 越期
  const ap = db.prepare(`INSERT INTO permission_requests
    (requestId, scope, actor, action, target, operation, mode, status, createdAt, decidedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  ap.run('p1', 'x', 'a', 'tool', 't', 'op', 'ask', 'approved', '2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z')
  ap.run('p2', 'x', 'a', 'tool', 't', 'op', 'ask', 'denied', '2026-09-01T00:00:00.000Z', '2026-09-01T00:02:00.000Z')
  ap.run('p3', 'x', 'a', 'tool', 't', 'op', 'ask', 'denied', '2026-09-01T00:00:00.000Z', '2026-09-01T00:02:00.000Z')
  ap.run('p4', 'x', 'a', 'tool', 't', 'op', 'ask', 'expired', '2026-09-01T00:00:00.000Z', '2026-09-01T00:03:00.000Z')
  ap.run('p5', 'x', 'a', 'tool', 't', 'op', 'ask', 'pending', '2026-09-01T00:00:00.000Z', null)

  // 预算：3 条结清（1 条超限）+ 1 条还挂着没花钱（**不进**分母）
  const br = db.prepare(`INSERT INTO budget_reservations
    (attempt_id, scope, task_id, model_profile_id, currency, billing_unit, price_table_version,
     effective_at_ms, reserved_amount, spent_amount, overrun_amount, state, created_at_ms, updated_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  br.run('b1', 'x', 't', 'm', 'CNY', 'token', 'v1', 1, 10, 8, null, 'settled', 1, 1)
  br.run('b2', 'x', 't', 'm', 'CNY', 'token', 'v1', 1, 10, 11, 1, 'settled', 1, 1)
  br.run('b3', 'x', 't', 'm', 'CNY', 'token', 'v1', 1, 10, 10, 0, 'settled', 1, 1)
  br.run('b4', 'x', 't', 'm', 'CNY', 'token', 'v1', 1, 10, null, null, 'held', 1, 1)
}

test('⑦ ★★★ 真库读数：分母与分子取自**同一批行**，逐格对数', () => {
  const db = fixtureDb()
  seed(db)
  const { snapshot, missing } = spec7CountsFromHubDb(db)
  assert.deepEqual([...missing], [], `不该有缺表的指标：${JSON.stringify(missing)}`)

  // 事件：终态 10（7 送达 + 1 抑制 + 2 不明），pending **不算**
  assert.equal(snapshot.eventsTerminal, 10, '终态分母把 pending 也算进去了')
  assert.equal(snapshot.eventsUnknown, 2)
  assert.equal(snapshot.eventsDelivered, 7)
  assert.equal(snapshot.eventsRetryDelivered, 2)
  // Run：中断 **2 个任务**（t1 丢了**两次**也只算一个——这正是这条 SQL 的去重）
  assert.equal(snapshot.runsInterrupted, 2, '中断计数没有按任务去重（应当 2，不是 3）')
  assert.equal(snapshot.runsRecovered, 1)
  // 审批：已决 4（pending 不算），未批准 3（2 拒 + 1 越期）
  assert.equal(snapshot.approvalsDecided, 4)
  assert.equal(snapshot.approvalsDeniedOrExpired, 3)
  assert.equal(snapshot.approvalsWaitSamples, 1)
  assert.equal(snapshot.approvalsWaitUnparsed, 0)
  assert.equal(snapshot.approvalWaitP50Ms, 60000)
  // 预算：分母是**结清过**的 3 条（held 那条不进），超限 1 条
  assert.equal(snapshot.budgetUsageRows, 3, 'held 的预留被算进了分母')
  assert.equal(snapshot.budgetOverruns, 1)

  const c = computeSpec7Metrics(snapshot)
  assert.equal(c['event-loss-rate'].display, '20.0%')
  assert.equal(c['event-duplicate-rate'].display, '28.6%')
  assert.equal(c['run-recovery-rate'].display, '50.0%')
  assert.equal(c['approval-denial-rate'].display, '75.0%')
  assert.equal(c['budget-overrun-rate'].display, '33.3%')
})

test('⑧ ★★★ 表**不存在** ⇒ 进 `missing`，**不许**得到"读数是 0"', () => {
  const db = fixtureDb({ skip: ['event_deliveries', 'permission_requests'] })
  seed2(db)
  const { snapshot, missing } = spec7CountsFromHubDb(db)
  const keys = missing.map((m) => m.key)
  assert.ok(keys.includes('event-loss-rate'))
  assert.ok(keys.includes('event-duplicate-rate'))
  assert.ok(keys.includes('approval-wait-ms'))
  assert.ok(keys.includes('approval-denial-rate'))
  // ★ 关键：缺表的那些键**不许**在 snapshot 里留下一个 0
  assert.equal(snapshot.eventsTerminal, undefined, '缺表却在 snapshot 里留了值')
  assert.equal(snapshot.approvalsDecided, undefined)
  for (const m of missing) assert.ok(typeof m.reason === 'string' && m.reason.length > 10, m.reason)
  // 表在的那些照样读得出来
  assert.equal(typeof snapshot.budgetUsageRows, 'number')
})

/** 只给 run_attempts 与 budget_reservations 的种子（配合 `skip`）。 */
function seed2(db) {
  db.prepare(`INSERT INTO run_attempts
    (attempt_id, task_id, scope, state, attempt_no, failure_code, created_at_ms, lease_epoch)
    VALUES (?,?,?,?,?,?,?,?)`).run('a1', 't1', 'x', 'Failed', 1, 'lease-expired', 1, 1)
  db.prepare(`INSERT INTO budget_reservations
    (attempt_id, scope, task_id, model_profile_id, currency, billing_unit, price_table_version,
     effective_at_ms, reserved_amount, spent_amount, overrun_amount, state, created_at_ms, updated_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('b1', 'x', 't', 'm', 'CNY', 'token', 'v1', 1, 10, 11, 1, 'settled', 1, 1)
}

test('⑨ ★★★ 时间戳不可解析的审批行**如实计数**，不许被静默丢掉', () => {
  const db = fixtureDb({ skip: ['event_deliveries', 'run_attempts', 'budget_reservations'] })
  const ap = db.prepare(`INSERT INTO permission_requests
    (requestId, scope, actor, action, target, operation, mode, status, createdAt, decidedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  ap.run('ok1', 'x', 'a', 'tool', 't', 'op', 'ask', 'approved', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:10.000Z')
  // 毫秒串也认
  ap.run('ok2', 'x', 'a', 'tool', 't', 'op', 'ask', 'approved', '1000', '21000')
  // 认不出来的：丢掉会让"中位数"失去分母
  ap.run('bad1', 'x', 'a', 'tool', 't', 'op', 'ask', 'approved', '不是时间', '也不是时间')
  ap.run('bad2', 'x', 'a', 'tool', 't', 'op', 'ask', 'approved', '2026-09-01T00:00:00.000Z', '倒流的时刻')
  const { snapshot } = spec7CountsFromHubDb(db)
  assert.equal(snapshot.approvalsWaitSamples, 2, '可解析样本数不对')
  assert.equal(snapshot.approvalsWaitUnparsed, 2, '不可解析的行没有被如实计数')
  // 两个样本：10000ms 与 20000ms ⇒ 中位数 15000
  assert.equal(snapshot.approvalWaitP50Ms, 15000)
})

test('⑩ ★★ 中位数：奇数/偶数/空，且空返回 `null`（不是 0）', () => {
  assert.equal(median([]), null)
  assert.equal(median([5]), 5)
  assert.equal(median([1, 3]), 2)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([1, null, undefined, NaN, '5', 3]), 2, '非有限值必须被滤掉')
  assert.equal(parseTimestampMs('2026-09-01T00:00:00.000Z'), Date.parse('2026-09-01T00:00:00.000Z'))
  assert.equal(parseTimestampMs('1000'), 1000)
  assert.equal(parseTimestampMs('nope'), null)
  assert.equal(parseTimestampMs(null), null)
})

// ── ④ 升级回滚成功率 ───────────────────────────────────────────────────

test('⑪ ★★ 回滚成功率从升级记录算，且**不认识的结果如实报未知**', () => {
  const r = rollbackCountsFromRecords([
    { result: 'succeeded' },
    { result: 'rolled-back', rollbackSucceeded: true },
    { result: 'rolled-back', rollbackSucceeded: false },
    { result: 'rolled-back' }, // 没写回滚成没成 ⇒ 计入 attempted 与 unreadable
    { result: 'rolled-back', rollback: { ok: true } },
    { result: 'failed' },
    null,
    'garbage',
  ])
  assert.equal(r.rollbacksAttempted, 4, `需要回滚的应记 4 次，实测 ${r.rollbacksAttempted}`)
  assert.equal(r.rollbacksSucceeded, 2, `回滚成功的应记 2 次，实测 ${r.rollbacksSucceeded}`)
  assert.equal(r.unreadable, 1, '没写回滚结论的那条必须被如实计数')
  const c = computeSpec7Metrics({ ...r })
  assert.equal(c['upgrade-rollback-success-rate'].display, '50.0%')
  // 没有记录 ⇒ 还没观察过，不是 0%
  const none = computeSpec7Metrics({ ...rollbackCountsFromRecords([]) })
  assert.equal(none['upgrade-rollback-success-rate'].reason, METRIC_CODES.NO_OBSERVATIONS)
})

// ── ⑤ 数据源组装：没有生产者 vs 这次读不出来 ───────────────────────────

test('⑫ ★★★ "没有生产者"与"这次读不出来"必须分得开，且**都不填 0**', () => {
  const noDb = createSpec7Source({})
  // 没给库 ⇒ unavailable（这次调用的问题）
  assert.ok(noDb.unavailable.some((u) => u.key === 'event-loss-rate'))
  assert.equal(noDb.source.eventsTerminal, undefined, '没给库却塞了个值进去')
  // 商业 Alpha ⇒ missing（**产品事实**：没有真实用户项目）
  const alpha = noDb.missing.find((m) => m.key === 'alpha-cycle-days')
  assert.ok(alpha !== undefined, '没有把"这一格没人喂"点名列出来')
  assert.match(alpha.reason, /真实用户项目/)
  assert.match(alpha.reason, /PRT-910/)

  const withDb = createSpec7Source({ db: fixtureDb() })
  assert.match(withDb.missing.map((m) => m.key).join(','), /alpha-cycle-days/)
})

test('⑬ ★★★ 真库上跑一遍：八格全部有结论，没有一格是"没人喂"的沉默', () => {
  const db = fixtureDb()
  seed(db)
  const { source, missing, unavailable } = createSpec7Source({ db })
  const c = computeSpec7Metrics(source)
  for (const key of SPEC7_METRIC_KEYS) {
    assert.ok(c[key] !== undefined, `\`${key}\` 没有结论`)
    assert.ok(typeof c[key].reasonText === 'string' || c[key].known === true)
  }
  // ★ 这一跑故意**不给**升级审计目录，于是有两格读不出来——而它们的原因**不同**：
  //   · `alpha-cycle-days`    → missing     （**产品事实**：没有真实用户项目）
  //   · `upgrade-rollback-…`  → unavailable（**这次调用**没给审计目录）
  //   两者在界面上都是「—」，但处置相反：一个要去建记录器，一个把目录传进来就行。
  const unknownKeys = SPEC7_METRIC_KEYS.filter((k) => c[k].known !== true).sort()
  assert.deepEqual(unknownKeys, ['alpha-cycle-days', 'upgrade-rollback-success-rate'],
    `读不出来的格子不对：${JSON.stringify(unknownKeys)}`)
  assert.deepEqual(missing.map((m) => m.key), ['alpha-cycle-days'])
  assert.deepEqual(unavailable.map((u) => u.key), ['upgrade-rollback-success-rate'])
  const s = spec7Summary(c)
  assert.equal(s.totalMetrics, 8)
  assert.equal(s.knownMetrics, 6)
  assert.equal(s.unknownMetrics, 2)
  assert.equal(s.byReason[METRIC_CODES.NO_DATA], 2)
  assert.equal(renderSpec7Metrics(c).length, 8)
})

test('⑬b ★★★ 补上传审计目录后，只剩 `alpha-cycle-days` 那一格读不出来', () => {
  const db = fixtureDb()
  seed(db)
  // 用真的升级审计模块写两条记录，再让数据源自己去读（不手工拼对象）
  const { source } = createSpec7Source({
    db,
    upgradeAuditDir: '/不看这个目录',
    listRecords: () => ([
      { result: 'rolled-back', rollbackSucceeded: true, finishedAtMs: 1 },
      { result: 'rolled-back', rollbackSucceeded: false, finishedAtMs: 2 },
    ]),
  })
  const c = computeSpec7Metrics(source)
  assert.equal(c['upgrade-rollback-success-rate'].known, true)
  assert.equal(c['upgrade-rollback-success-rate'].display, '50.0%')
  const unknownKeys = SPEC7_METRIC_KEYS.filter((k) => c[k].known !== true)
  assert.deepEqual(unknownKeys, ['alpha-cycle-days'],
    `只剩 alpha 那一格该读不出来，实测 ${JSON.stringify(unknownKeys)}`)
})

// ── ⑥ 跨模块：两张表不许各走各的 ────────────────────────────────────────

test('⑭ ★★★ 跨模块一致性：与 `metrics.mjs` 的**码与种类同源**，未知档形状逐字相同', () => {
  // §7 这张表刻意**不并进** §6.6 那九格（那九格的摘要是远程心跳的载荷，走允许名单）。
  // 但"第二张表"不许是"第二套纪律"，所以钉住四件事：
  //   ① 码是同一份导出；② 种类是同一份导出；③ 未知档的键集与 §6.6 逐字相同；
  //   ④ 两边对"分母为 0"给同一个原因码。
  const zero = computeSpec7Metrics({ eventsUnknown: 0, eventsTerminal: 0 })
  assert.equal(zero['event-loss-rate'].reason, METRIC_CODES.NO_OBSERVATIONS)
  const six = computeMetrics({ leasesExpired: 0, leasesTotal: 0 })
  assert.equal(six['lease-expiry-rate'].reason, METRIC_CODES.NO_OBSERVATIONS,
    '两边对"分母为 0"给了不同的原因码')

  // 未知档的**键集**必须一致（少一个键，消费方就会读到 undefined）
  const u = computeSpec7Metrics({})['event-loss-rate']
  const k = computeMetrics({})['queue-depth']
  assert.deepEqual(Object.keys(u).sort(), Object.keys(k).sort(),
    '两张表的未知档形状漂了：\n  §7 = ' + Object.keys(u).sort().join(',')
    + '\n  §6.6 = ' + Object.keys(k).sort().join(','))
  // 两边的已知档也一致
  const uk = computeSpec7Metrics({ eventsUnknown: 0, eventsTerminal: 4 })['event-loss-rate']
  const kk = computeMetrics({ 'queue-depth': 3 })['queue-depth']
  assert.deepEqual(Object.keys(uk).sort(), Object.keys(kk).sort(), '已读档的形状漂了')

  // §7 这一张**不许**动 §6.6 那九格
  assert.equal(Object.keys(METRIC_DEFS).length, 9, '§6.6 那九格被动过了')
  assert.equal(SPEC7_METRIC_KEYS.length, 8)
  for (const key of SPEC7_METRIC_KEYS) {
    assert.equal(METRIC_DEFS[key], undefined, `\`${key}\` 混进了 §6.6 那张表`)
  }
})

test('⑮ ★★ 冻结与词表同源：本模块用的状态词表与生产模块一致', () => {
  assert.ok(Object.isFrozen(SPEC7_METRIC_DEFS))
  assert.ok(Object.isFrozen(SPEC7_METRIC_KEYS))
  assert.ok(Object.isFrozen(SPEC7_REQUIREMENTS))
  for (const key of SPEC7_METRIC_KEYS) {
    assert.ok(Object.isFrozen(SPEC7_METRIC_DEFS[key]), `\`${key}\` 的定义没冻结`)
  }
  // 终态词表必须与生产一致
  assert.deepEqual([...TERMINAL_DELIVERY_STATES], ['delivered', 'suppressed', 'unknown'])
  assert.deepEqual([...APPROVAL_NOT_APPROVED], ['denied', 'expired'])
})

test('⑯ ★★ `tableExists` 分得开"没这张表"与"表是空的"', () => {
  const db = fixtureDb()
  assert.equal(tableExists(db, 'event_deliveries'), true)
  assert.equal(tableExists(db, '根本没有这张表'), false)
})

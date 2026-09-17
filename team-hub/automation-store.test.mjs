// team-hub/automation-store.test.mjs
// ============================================================================
// F-16 自动化计划 / 运行历史的判据。
//
// 这一组要钉住的六件事，每一件都对应一个**不会报错的失效形态**：
//
//   ① **日历只做投影** —— 打开视图不能产生运行行。
//      一个"把视图当成计划"的日历，会在半年后让"上个月跑了 400 次"里
//      有 380 次是**有人翻过日历**。
//   ② **时区** —— 名字写错必须抛，**绝不回落服务器本地时区**。
//      回落时的表现是"每天都成功"，只不过跑在错的时间上。
//   ③ **skip-on-overlap** —— 跳过必须**留下行**且带封闭词表里的原因。
//      不记账时"没被触发"与"被跳过了"在历史里长得一样。
//   ④ **补跑** —— `once` 合并成一次并记下代表了几次；
//      `none` 不补但**仍然推进**（否则它永远到点）。
//   ⑤ **审批暂停** —— 单独的状态，且必须有 approvalId。
//      没有 approvalId 的行是一条**永远醒不过来**的行：它永远占着非终态，
//      于是这条计划从此再也触发不了（静默停摆）。
//   ⑥ **物化幂等** —— 并发/重放不产生第二条同刻运行（唯一索引，不是应用层查重）。
//
// 时区那一组用**真 `Intl`**（不是替身）：这条判据的全部价值就在于
// "真实的时区库会怎么解释这个名字"，而替身恰好会把这件事验掉。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import {
  AUTOMATION_ERRORS,
  AUTOMATION_RUN_STATES,
  CATCH_UP_POLICIES,
  OVERLAP_POLICIES,
  SKIP_REASONS,
  TERMINAL_RUN_STATES,
  assertTimezone,
  createAutomationStore,
  ensureAutomationSchema,
  isRunState,
  nextOccurrenceAfter,
  projectOccurrences,
  validateSpec,
  wallTimeToUtcMs,
  zonedParts,
} from './automation-store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function makeEnv({ startMs = Date.UTC(2026, 0, 15, 3, 0, 0) } = {}) {
  const db = new DatabaseSync(':memory:')
  ensureAutomationSchema(db)
  let clockMs = startMs
  const store = createAutomationStore({ db, clock: () => clockMs })
  return {
    db, store,
    now: () => clockMs,
    setNow: (ms) => { clockMs = ms },
    advance: (ms) => { clockMs += ms; return clockMs },
    dispose: () => { try { db.close() } catch { /* 已关 */ } },
  }
}

const daily = (hour, minute = 0) => ({ kind: 'daily', hour, minute })
const TZ = 'Asia/Shanghai'

// ---------------------------------------------------------------- ① spec / 时区

test('① spec 校验：三种形状，且**刻意**不支持完整 cron', () => {
  assert.deepEqual(validateSpec({ kind: 'interval', everyMs: 300000 }), { kind: 'interval', everyMs: 300000 })
  assert.deepEqual(validateSpec(daily(9, 30)), { kind: 'daily', hour: 9, minute: 30 })
  assert.deepEqual(validateSpec({ kind: 'weekly', weekday: 1, hour: 8, minute: 0 }),
    { kind: 'weekly', weekday: 1, hour: 8, minute: 0 })
  // cron 字符串不给过；也不给"默认成每小时"这种便利回落。
  for (const bad of ['*/5 * * * *', '@reboot', null, 42, undefined]) {
    assert.throws(() => validateSpec(bad), (e) => e.code === AUTOMATION_ERRORS.BAD_SPEC,
      `${JSON.stringify(bad)} 被接受了`)
  }
  // interval 下限 60s：比一次 Run 还短的间隔只会把"重叠跳过"变成常态。
  assert.throws(() => validateSpec({ kind: 'interval', everyMs: 1000 }), (e) => e.code === AUTOMATION_ERRORS.BAD_SPEC)
  assert.throws(() => validateSpec({ kind: 'daily', hour: 24, minute: 0 }), (e) => e.code === AUTOMATION_ERRORS.BAD_SPEC)
  assert.throws(() => validateSpec({ kind: 'weekly', weekday: 7, hour: 0, minute: 0 }), (e) => e.code === AUTOMATION_ERRORS.BAD_SPEC)
})

test('② ★ 时区名写错 ⇒ 抛，**绝不回落服务器本地时区**', () => {
  // `Asia/Shangai`（少一个 h）是最容易写出来的那个错。
  assert.throws(() => assertTimezone('Asia/Shangai'), (e) => e.code === AUTOMATION_ERRORS.BAD_TIMEZONE)
  assert.throws(() => assertTimezone(''), (e) => e.code === AUTOMATION_ERRORS.BAD_TIMEZONE)
  assert.throws(() => assertTimezone(null), (e) => e.code === AUTOMATION_ERRORS.BAD_TIMEZONE)
  // 合法名照常通过（反向对照：检查不是"永远抛"）。
  assert.equal(assertTimezone('UTC'), 'UTC')
  assert.equal(assertTimezone(TZ), TZ)
})

test('③ ★ 真 Intl：daily 09:00 Asia/Shanghai 落在 UTC 01:00（不是 09:00 UTC）', () => {
  // 2026-01-15T03:00Z = 北京时间 11:00，今天的 09:00 已经过了 → 下一次是明天 09:00。
  const from = Date.UTC(2026, 0, 15, 3, 0, 0)
  const next = nextOccurrenceAfter(daily(9, 0), { fromMs: from, timezone: TZ })
  assert.equal(next, Date.UTC(2026, 0, 16, 1, 0, 0),
    `期望 2026-01-16T01:00Z（北京时间 09:00），实际 ${new Date(next).toISOString()}。`
    + '落在 09:00Z 说明时区被当成了 UTC；这正是"每天都成功但跑在错的时间上"')
  // 墙上时间反向确认：它在北京时间确实是 09:00。
  const z = zonedParts(next, TZ)
  assert.equal(z.hour, 9)
  assert.equal(z.minute, 0)

  // 反向对照：同一个 09:00 在 UTC 时区下就是 09:00Z —— 两次结果**不同**，
  // 证明上面那个 01:00 真的是时区换算出来的，不是巧合。
  const utcNext = nextOccurrenceAfter(daily(9, 0), { fromMs: from, timezone: 'UTC' })
  assert.equal(utcNext, Date.UTC(2026, 0, 15, 9, 0, 0))
  assert.notEqual(next, utcNext)
})

test('④ weekly：落在指定的星期几，且跨周正确', () => {
  // 2026-01-15 是周四。找一个"周一 08:00 Asia/Shanghai"。
  const from = Date.UTC(2026, 0, 15, 3, 0, 0)
  const next = nextOccurrenceAfter({ kind: 'weekly', weekday: 1, hour: 8, minute: 0 }, { fromMs: from, timezone: TZ })
  assert.equal(zonedParts(next, TZ).weekday, 1, '落到的不是周一')
  assert.equal(zonedParts(next, TZ).hour, 8)
  assert.ok(next > from)
  // 连续两次之间恰好是 7 天（同一时区、同一墙上时间）。
  const after = nextOccurrenceAfter({ kind: 'weekly', weekday: 1, hour: 8, minute: 0 }, { fromMs: next, timezone: TZ })
  assert.equal(after - next, 7 * 24 * 3600 * 1000)
})

test('⑤ interval 对齐网格：多次重启**不漂移**', () => {
  const every = 3600_000
  // 从任意一个时刻出发连算 5 次，全部落在 everyMs 的整数倍上。
  let cursor = 1_700_000_123_456
  for (let i = 0; i < 5; i += 1) {
    cursor = nextOccurrenceAfter({ kind: 'interval', everyMs: every }, { fromMs: cursor, timezone: 'UTC' })
    assert.equal(cursor % every, 0,
      `第 ${i + 1} 次落点 ${cursor} 不在网格上 —— "每次重启往后挪一点"会让`
      + '"每小时的第 5 分钟"在几次重启之后变成"每小时的第 47 分钟"')
  }
})

test('⑥ DST 边界：wallTimeToUtcMs 两轮迭代（只迭代一轮会偏一小时）', () => {
  // 美国东部 2026-03-08 02:00 → 03:00（EST→EDT）。
  // 取一个**在跳变之后**的墙上时间 03:30，它应该落在 EDT 的 07:30Z。
  const ms = wallTimeToUtcMs({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, 'America/New_York')
  const z = zonedParts(ms, 'America/New_York')
  assert.equal(z.hour, 3)
  assert.equal(z.minute, 30)
  // 前后各一天的同一墙上时间，偏移不同（EST -5 vs EDT -4）。
  const dayBefore = wallTimeToUtcMs({ year: 2026, month: 3, day: 7, hour: 3, minute: 30 }, 'America/New_York')
  assert.notEqual(dayBefore % 86400000, ms % 86400000,
    '两天同一墙上时间的 UTC 落点相同 —— 那说明实现没有处理 DST 偏移变化')
})

// ---------------------------------------------------------------- ② 日历只做投影

test('⑦ ★ 日历只做投影：算 100 次投影，库里**一行都不多**', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({ id: 's1', scope: 'software', name: '每天 9 点', spec: daily(9), timezone: TZ })
    const before = env.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n
    const from = env.now()
    // 反复投影（视图每次翻页都会算）。
    for (let i = 0; i < 100; i += 1) {
      const occ = projectOccurrences(s, { fromMs: from, toMs: from + 30 * 24 * 3600 * 1000 })
      assert.ok(occ.length >= 29 && occ.length <= 31, `投影出 ${occ.length} 个时刻`)
    }
    const after = env.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n
    assert.equal(after, before,
      '投影写了运行行 —— 一个"把视图当成计划"的日历，会让"上个月跑了 400 次"里'
      + '有 380 次是**有人翻过日历**')
    assert.equal(after, 0)
  } finally { env.dispose() }
})

test('⑧ 投影有上界：1 分钟间隔投影一年不炸，且如实截断', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: '每分钟', spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    })
    const from = env.now()
    const occ = projectOccurrences(s, { fromMs: from, toMs: from + 365 * 24 * 3600 * 1000, maxOccurrences: 50 })
    assert.equal(occ.length, 50, '没有按 maxOccurrences 截断 —— 一次翻页会算 52 万条')
    // 升序且严格递增。
    for (let i = 1; i < occ.length; i += 1) assert.ok(occ[i] > occ[i - 1])
    assert.throws(() => projectOccurrences(s, { fromMs: from, toMs: from, maxOccurrences: 10 }),
      (e) => e.code === AUTOMATION_ERRORS.BAD_WINDOW)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ③ 物化

test('⑨ 到点才物化：next_run_at_ms 由 spec 算，不由调用方给', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({ id: 's1', scope: 'software', name: 'x', spec: daily(9), timezone: TZ })
    // 2026-01-15T03:00Z = 北京 11:00 → 下一次是 01-16T01:00Z。
    assert.equal(s.nextRunAtMs, Date.UTC(2026, 0, 16, 1, 0, 0))
    // 还没到点 → 什么都不建。
    let r = env.store.materializeDue()
    assert.equal(r.results.length, 0)
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n, 0)
    // 到点后 → 建一行，并推进到下一次。
    env.setNow(s.nextRunAtMs + 1000)
    r = env.store.materializeDue()
    assert.equal(r.results.length, 1)
    assert.equal(r.results[0].action, 'materialized')
    const runs = env.store.runsOf({ scheduleId: 's1' })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].state, 'scheduled')
    assert.equal(runs[0].plannedAtMs, s.nextRunAtMs)
    assert.equal(env.store.scheduleOf('s1').nextRunAtMs, Date.UTC(2026, 0, 17, 1, 0, 0))
  } finally { env.dispose() }
})

test('⑩ ★ 物化幂等：同一批重放不产生第二条同刻运行', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({ id: 's1', scope: 'software', name: 'x', spec: daily(9), timezone: TZ })
    env.setNow(s.nextRunAtMs + 1000)
    env.store.materializeDue()
    const n1 = env.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n
    // 重放：把 next_run_at_ms 手动拨回去，模拟"两个进程各扫了一次"。
    env.db.prepare('UPDATE automation_schedules SET next_run_at_ms = ? WHERE id = ?').run(s.nextRunAtMs, 's1')
    const r = env.store.materializeDue()
    assert.equal(r.results[0].action, 'already-materialized')
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n, n1,
      '重放产生了第二条 —— 只在应用层查重时，两个进程会各查一次、各写一行')
    // 唯一索引必须在（这是数据库层面的保证，不是应用层的）。
    const src = readFileSync(join(HERE, 'automation-store.mjs'), 'utf8')
    assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_unique ON automation_runs\(schedule_id, planned_at_ms\)/)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ④ skip-on-overlap

test('⑪ ★ skip-on-overlap：跳过要**留下行**且带封闭词表原因', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: '每分钟', spec: { kind: 'interval', everyMs: 60_000 },
      timezone: 'UTC', overlapPolicy: 'skip',
    })
    env.setNow(s.nextRunAtMs + 1000)
    let r = env.store.materializeDue()
    assert.equal(r.results[0].action, 'materialized')
    const firstRun = r.results[0].runId
    // 它还在跑（scheduled / running 都是非终态）。
    env.store.startRun(firstRun)
    // 下一次又到点了。
    env.setNow(env.store.scheduleOf('s1').nextRunAtMs + 1000)
    r = env.store.materializeDue()
    assert.equal(r.results[0].action, 'skipped-overlap')

    const runs = env.store.runsOf({ scheduleId: 's1' })
    const skipped = runs.filter((x) => x.state === 'skipped')
    assert.equal(skipped.length, 1,
      '重叠时**什么都没留下** —— 不记账时"它没被触发"与"它被跳过了"在历史里长得一样')
    assert.equal(skipped[0].skipReason, 'overlap')
    assert.equal(SKIP_REASONS.includes(skipped[0].skipReason), true)
    // 反向对照：第一次运行仍然是 running（跳过的没把它顶掉）。
    assert.equal(env.store.runOf(firstRun).state, 'running')
  } finally { env.dispose() }
})

test('⑫ replace 策略：取消上一次时**留下痕迹**（"取消"不等于"没发生过"）', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 },
      timezone: 'UTC', overlapPolicy: 'replace',
    })
    env.setNow(s.nextRunAtMs + 1000)
    const r1 = env.store.materializeDue()
    const only = r1.results[0].runId
    env.store.startRun(only, { attemptId: 'att:1' })
    env.setNow(env.store.scheduleOf('s1').nextRunAtMs + 1000)
    const r2 = env.store.materializeDue()
    // `replace` 会产生**两条**读数：先报"取消了哪些"，再报"建了哪一条"。
    // 只取 `results[0]` 会拿到取消读数（它没有 runId）——那是探针读错了下标，
    // 而不是功能坏了。
    const replaced = r2.results.find((x) => x.action === 'cancelled-replaced')
    const made = r2.results.find((x) => x.action === 'materialized')
    assert.ok(replaced !== undefined, 'replace 策略没有报出"取消了哪些"')
    assert.ok(made !== undefined, 'replace 策略取消了旧的却没有建新的')
    assert.deepEqual(replaced.cancelled, [only])
    const cancelled = env.store.runOf(only)
    assert.equal(cancelled.state, 'cancelled')
    assert.match(cancelled.error, /replace/,
      '被顶替的那次没有留下原因 —— 它可能已经写了外部系统，"取消"在这里'
      + '等于"把一次已经发生的事说成没发生"')
    assert.notEqual(env.store.runOf(made.runId).state, 'cancelled')
  } finally { env.dispose() }
})

test('⑬ queue 策略：不跳过，直接建（队列会增长——那是被显式选择的行为）', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 },
      timezone: 'UTC', overlapPolicy: 'queue',
    })
    env.setNow(s.nextRunAtMs + 1000)
    env.store.materializeDue()
    env.setNow(env.store.scheduleOf('s1').nextRunAtMs + 1000)
    const r = env.store.materializeDue()
    assert.equal(r.results[0].action, 'materialized')
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE state = 'skipped'").get().n, 0)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ⑤ 补跑

test('⑭ ★ 补跑 once（默认）：停机三天合并成**一次**，并记下代表了几次', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({ id: 's1', scope: 'software', name: '每天', spec: daily(9), timezone: TZ })
    // 停机三天。
    env.setNow(s.nextRunAtMs + 3 * 24 * 3600 * 1000)
    const missed = env.store.missedOccurrences('s1')
    assert.equal(missed.length, 4, `错过了 ${missed.length} 次（含首尾）`)
    const r = env.store.materializeDue()
    assert.equal(r.results.length, 1, 'once 策略建了多行')
    assert.equal(r.results[0].coalescedCount, 4)
    const runs = env.store.runsOf({ scheduleId: 's1' })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].coalescedCount, 4, '"这一次代表了几次"必须留下 —— 否则事后无法回答停机那三天算不算跑过')
    assert.equal(runs[0].plannedAtMs, missed[missed.length - 1], '合并的那一次应该落在**最后一个**错过的时刻上')
    assert.equal(runs[0].catchUpOfMs, missed[0], '没有记下被代表的最早时刻')
  } finally { env.dispose() }
})

test('⑮ 补跑 all：逐次补；none：不补但**仍然推进**（否则永远到点）', () => {
  for (const [policy, expected] of [['all', 4], ['none', 0]]) {
    const env = makeEnv()
    try {
      const s = env.store.createSchedule({
        id: 's1', scope: 'software', name: 'x', spec: daily(9), timezone: TZ, catchUpPolicy: policy,
      })
      env.setNow(s.nextRunAtMs + 3 * 24 * 3600 * 1000)
      const r = env.store.materializeDue()
      assert.equal(r.results.length, expected, `${policy} 建了 ${r.results.length} 行，期望 ${expected}`)
      // 关键：不管哪种策略，next 都要推进到**严格晚于现在**。
      const after = env.store.scheduleOf('s1').nextRunAtMs
      assert.ok(after > env.now(), `${policy}：next_run_at_ms 没有推进到未来（${after} <= ${env.now()}）`)
      // 再 tick 一次不应该又建一批。
      const r2 = env.store.materializeDue()
      assert.equal(r2.results.length, 0, `${policy}：第二次 tick 又物化了 —— 停机期被重放了一遍`)
    } finally { env.dispose() }
  }
})

// ---------------------------------------------------------------- ⑥ 审批暂停

test('⑯ ★ awaiting-approval 是**独立状态**：既不是 running 也不是 failed', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    })
    env.setNow(s.nextRunAtMs + 1000)
    const runId = env.store.materializeDue().results[0].runId
    env.store.startRun(runId, { attemptId: 'att:1', taskId: 'T-1' })
    const paused = env.store.pauseForApproval(runId, { approvalId: 'apr:1' })
    assert.equal(paused.state, 'awaiting-approval')
    assert.equal(paused.approvalId, 'apr:1')
    // 它不是终态：还能回到 running。
    assert.equal(TERMINAL_RUN_STATES.includes('awaiting-approval'), false)
    const resumed = env.store.transitionRun(runId, 'running')
    assert.equal(resumed.state, 'running')
    // 而且它在 running 之前就被登记成"占着这条计划"的状态之一
    // （这就是为什么它不能合进 failed：合进去之后重叠判定看不见它，
    //  这条计划会在前一次还挂着审批时又跑一次）。
    assert.equal(AUTOMATION_RUN_STATES.includes('awaiting-approval'), true)
  } finally { env.dispose() }
})

test('⑰ ★ 进 awaiting-approval 必须带 approvalId（否则是一条永远醒不过来的行）', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    })
    env.setNow(s.nextRunAtMs + 1000)
    const runId = env.store.materializeDue().results[0].runId
    env.store.startRun(runId)
    assert.throws(() => env.store.pauseForApproval(runId, {}),
      (e) => e.code === AUTOMATION_ERRORS.APPROVAL_ID_REQUIRED,
      '没有 approvalId 就进等待 —— 没有任何东西会把它推回 running，'
      + '它会永远占着非终态，让这条计划从此再也触发不了')
    assert.throws(() => env.store.pauseForApproval(runId, { approvalId: '' }),
      (e) => e.code === AUTOMATION_ERRORS.APPROVAL_ID_REQUIRED)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ⑦ 状态机

test('⑱ 终态不可改：允许改写会让"这次成了没有"有两个答案', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    })
    env.setNow(s.nextRunAtMs + 1000)
    const runId = env.store.materializeDue().results[0].runId
    env.store.startRun(runId)
    env.store.finishRun(runId, 'completed')
    for (const to of ['running', 'failed', 'completed', 'cancelled', 'skipped']) {
      assert.throws(() => env.store.transitionRun(runId, to),
        (e) => e.code === AUTOMATION_ERRORS.RUN_FINISHED,
        `终态 completed 被改成了 ${to}`)
    }
    assert.equal(env.store.runOf(runId).state, 'completed')
  } finally { env.dispose() }
})

test('⑲ 非法迁移被具名拒绝（scheduled → completed 跳过 running）', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    })
    env.setNow(s.nextRunAtMs + 1000)
    const runId = env.store.materializeDue().results[0].runId
    assert.throws(() => env.store.finishRun(runId, 'completed'),
      (e) => e.code === AUTOMATION_ERRORS.BAD_STATE_TRANSITION)
    // 跳过必须给封闭词表里的原因。
    assert.throws(() => env.store.skipRun(runId, { reason: '上一次还在跑' }),
      (e) => e.code === AUTOMATION_ERRORS.BAD_POLICY,
      '自由文本的跳过原因 —— 按原因统计时它查不到，而"为什么今天没跑"的答案'
      + '会散落在无数种说法里')
    assert.equal(env.store.skipRun(runId, { reason: 'policy' }).state, 'skipped')
  } finally { env.dispose() }
})

// ---------------------------------------------------------------- ⑧ 汇总

test('⑳ 汇总给出 in-flight / overdue / 未登记状态，且吃进坏数据', () => {
  const env = makeEnv()
  try {
    const s = env.store.createSchedule({
      id: 's1', scope: 'software', name: 'x', spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    })
    env.setNow(s.nextRunAtMs + 1000)
    const runId = env.store.materializeDue().results[0].runId
    env.store.startRun(runId)
    env.store.finishRun(runId, 'failed', { error: 'boom' })

    let sum = env.store.summary()
    assert.equal(sum.schedules, 1)
    assert.equal(sum.enabledSchedules, 1)
    assert.equal(sum.byState.failed, 1)
    assert.equal(sum.settled, true)
    assert.deepEqual(sum.unrecognizedStates, [])

    // ★ 塞一行未登记状态：`settled` **必须**变 false。
    //   只按已知终态判定时，一行坏数据会让它读成"全都安定了"。
    env.db.prepare(
      `INSERT INTO automation_runs (id, schedule_id, scope, planned_at_ms, state, created_at_ms, updated_at_ms)
       VALUES ('bad:1','s1','software', 1, 'mutated', 0, 0)`,
    ).run()
    sum = env.store.summary()
    assert.deepEqual([...sum.unrecognizedStates], ['mutated'])
    assert.equal(sum.settled, false, '未登记状态被当成了安定 —— 一行坏数据读起来像"全都跑完了"')
    assert.equal(sum.byState.mutated, 1, '未登记状态没有被报出来')

    // overdue：拨到下一次到点之后但不物化。
    env.setNow(env.store.scheduleOf('s1').nextRunAtMs + 5000)
    assert.equal(env.store.summary().overdue, 1,
      '"到点但还没物化"必须能被看见 —— 它是"调度循环没在跑"的唯一证据')
  } finally { env.dispose() }
})

test('㉑ 计划 CRUD：改名/改策略总是重算 next；重复 id 拒绝', () => {
  const env = makeEnv()
  try {
    env.store.createSchedule({ id: 's1', scope: 'software', name: 'a', spec: daily(9), timezone: TZ })
    assert.throws(() => env.store.createSchedule({ id: 's1', scope: 'software', name: 'b', spec: daily(9), timezone: TZ }),
      (e) => e.statusCode === 409)
    // 改时区：next 必须重算（保留旧值会让"改了没生效"与"改了但还没到点"同形）。
    const before = env.store.scheduleOf('s1').nextRunAtMs
    const updated = env.store.updateSchedule({ id: 's1', timezone: 'UTC' })
    assert.notEqual(updated.nextRunAtMs, before, '改了时区但 next 没变 —— 下一次触发看起来毫无变化')
    // 停用 → next 为 null，且不再被物化。
    const off = env.store.updateSchedule({ id: 's1', enabled: false })
    assert.equal(off.enabled, false)
    assert.equal(off.nextRunAtMs, null)
    env.setNow(before + 10 * 24 * 3600 * 1000)
    assert.equal(env.store.materializeDue().results.length, 0, '停用的计划被物化了')
    // 非法策略被具名拒绝。
    assert.throws(() => env.store.updateSchedule({ id: 's1', overlapPolicy: 'whatever' }),
      (e) => e.code === AUTOMATION_ERRORS.BAD_POLICY)
    for (const p of OVERLAP_POLICIES) assert.equal(env.store.updateSchedule({ id: 's1', overlapPolicy: p }).overlapPolicy, p)
    for (const p of CATCH_UP_POLICIES) assert.equal(env.store.updateSchedule({ id: 's1', catchUpPolicy: p }).catchUpPolicy, p)
    assert.throws(() => env.store.updateSchedule({ id: 'nope' }),
      (e) => e.code === AUTOMATION_ERRORS.SCHEDULE_NOT_FOUND)
  } finally { env.dispose() }
})

test('㉒ 接线：schema 由 server 建，且 run 状态词表与判定函数一致', () => {
  const src = readFileSync(join(HERE, 'automation-store.mjs'), 'utf8')
  // 只追加：运行历史是审计材料，不该有 UPDATE state 之外的改写路径。
  assert.equal(/DELETE\s+FROM\s+automation_runs/i.test(src), false, 'automation_runs 出现了 DELETE')
  assert.match(src, /CREATE TABLE IF NOT EXISTS automation_runs/)
  // 词表自洽：每个终态都在总表里；每个非终态都不是终态。
  for (const s of TERMINAL_RUN_STATES) assert.equal(isRunState(s), true, `${s} 不在总表里`)
  for (const s of ['scheduled', 'running', 'awaiting-approval']) {
    assert.equal(TERMINAL_RUN_STATES.includes(s), false, `${s} 被当成了终态`)
  }
  // 纯函数里不许出现任何写库调用（"日历只做投影"的结构级对照）。
  const project = src.slice(src.indexOf('export function projectOccurrences'), src.indexOf('// ---------------------------------------------------------------- 建表'))
  for (const forbidden of ['db.prepare', 'INSERT', 'UPDATE', 'db.exec']) {
    assert.equal(project.includes(forbidden), false,
      `projectOccurrences 里出现了 ${forbidden} —— 投影必须是纯函数`)
  }
})

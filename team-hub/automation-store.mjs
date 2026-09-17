// team-hub/automation-store.mjs
// ============================================================================
// F-16 自动化计划 / 运行历史（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.4）
//
// spec 那一行很短，但它点出的六件事每一件都对应一个**不会报错的失效形态**：
//
//   > 日历只做投影；新增计划、运行、时区、skip-on-overlap、补跑和审批暂停状态。
//
// ## 为什么"日历只做投影"是一条**纪律**而不是一句描述
//
// 最自然的实现是"日历上有哪些格子，就往库里写哪些运行"——于是打开一次日历
// 视图就产生了一批运行行。半年后回头看，"这条计划上个月跑了 400 次"里
// 有 380 次是**有人翻过日历**。
//
//   > 一个「把视图当成计划」的日历，与一个「有 380 次运行是因为有人翻了 380 次页」
//   > 的系统，在界面上看起来都是"日历格子被填满了"——只不过后者的运行历史
//   > 记录的是**看的人**，不是做的事。
//
// 所以本模块把两件事**在类型上**分开：
//   · `projectOccurrences()` 是**纯函数**：给一份计划，算出某个时间窗内
//     "本该在什么时候跑"。**不碰库、不写任何行。**
//   · `materializeDue()` 是**唯一的写入口**：它只在"到点了"这个条件下
//     建运行行，并且只建**已经过去**的那些。
//
// ## skip-on-overlap（重叠跳过）
//
// 一条 5 分钟一次的计划，上一次还没跑完就到了下一次。三种可能的处置，
// 而**默认必须是"跳过并记账"**：
//
//   · 排队（queue）—— 队列会无界增长。一个卡住的任务会让队列在一夜之间
//     攒下几百条，然后它们**依次**执行：用户看到的是一次迟到的雪崩。
//   · 顶替（replace）—— 取消正在跑的那一次。它可能已经写了外部系统，
//     "取消"在这里等于"把一次已经发生的事说成没发生"。
//   · 跳过（skip）—— 什么也不做，但**留下一条 skipped 行**。
//
// 跳过之所以要**记账**：不记账时"这条计划今天没跑"与"它跑了但什么都没做"
// 在历史里长得一样。值班的人需要能回答"是它没被触发，还是它被跳过了"。
//
// ## 补跑（catch-up）
//
// 进程停机一段时间后再起来，中间错过了 N 次。策略必须**显式**给：
//   · `none` —— 不补。错过的就是错过了。
//   · `once` —— 合并成**一次**。默认。因为"停机 3 天、每天一次的计划"
//     在补跑时最可能是"现在跑一次就够"，而不是"连着跑 3 次"。
//   · `all`  —— 逐次补。**只对幂等且必须有每次记录的计划成立**，
//     所以它不能是默认值。
//
// 默认 `once` 而不是 `all`：`all` 在有外部副作用的计划上是"把三天的工作
// 一次性重放"，而那个方向修不回来。
//
// ## 审批暂停（awaiting-approval）
//
// 一条自动计划跑到需要人工审批时，它**不是失败**、也**不是完成**。
// 用一个单独的状态表示它，是因为合进任何一个都会产生一个具体的坏读数：
//   · 合进 `failed` —— 值班的人会去查它为什么失败，而它只是在等人。
//   · 合进 `running` —— 它会永远占着"正在运行"，于是重叠判定永远为真，
//     这条计划从此**再也不会被触发**（静默停摆）。
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

export const AUTOMATION_ERRORS = Object.freeze({
  BAD_SPEC: 'BAD_SCHEDULE_SPEC',
  BAD_TIMEZONE: 'BAD_TIMEZONE',
  BAD_ID: 'SCHEDULE_ID_REQUIRED',
  SCHEDULE_NOT_FOUND: 'SCHEDULE_NOT_FOUND',
  RUN_NOT_FOUND: 'SCHEDULE_RUN_NOT_FOUND',
  BAD_POLICY: 'BAD_OVERLAP_POLICY',
  BAD_CATCH_UP: 'BAD_CATCH_UP_POLICY',
  BAD_STATE_TRANSITION: 'ILLEGAL_RUN_TRANSITION',
  RUN_FINISHED: 'RUN_ALREADY_FINISHED',
  APPROVAL_ID_REQUIRED: 'APPROVAL_ID_REQUIRED',
  BAD_WINDOW: 'BAD_CALENDAR_WINDOW',
})

/** 一次计划的**运行**状态。终态见 `TERMINAL_RUN_STATES`。 */
export const AUTOMATION_RUN_STATES = Object.freeze([
  'scheduled',
  'running',
  // 见文件头：**不是** running 也不是 failed。
  'awaiting-approval',
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

export const TERMINAL_RUN_STATES = Object.freeze(['completed', 'failed', 'skipped', 'cancelled'])

/** 非终态 = 仍然"占着"这条计划的状态。重叠判定看的就是它。 */
export const IN_FLIGHT_RUN_STATES = Object.freeze(['scheduled', 'running', 'awaiting-approval'])

export const OVERLAP_POLICIES = Object.freeze(['skip', 'queue', 'replace'])

export const CATCH_UP_POLICIES = Object.freeze(['none', 'once', 'all'])

/**
 * 跳过的原因是**封闭词表**。
 *
 * 与 `event-delivery.mjs` 的 `SUPPRESS_REASONS` 同一条纪律：允许自由文本时，
 * 一个"跳过"会退化成一句备注（`"上一次还在跑"`），于是按原因统计时查不到它，
 * 而"为什么这条计划今天没跑"这个问题的答案散落在无数种说法里。
 */
export const SKIP_REASONS = Object.freeze([
  'overlap',
  'disabled',
  'catch-up-coalesced',
  'outside-window',
  'policy',
])

export const isRunState = (s) => AUTOMATION_RUN_STATES.includes(s)
export const isTerminalRunState = (s) => TERMINAL_RUN_STATES.includes(s)
export const isInFlightRunState = (s) => IN_FLIGHT_RUN_STATES.includes(s)
export const isOverlapPolicy = (p) => OVERLAP_POLICIES.includes(p)
export const isCatchUpPolicy = (p) => CATCH_UP_POLICIES.includes(p)
export const isSkipReason = (r) => SKIP_REASONS.includes(r)

/** 默认在每个 tick 里最多物化多少次运行。防止一次长停机把库撑爆。 */
export const DEFAULT_MATERIALIZE_LIMIT = 200

/** 计划 spec 支持三种形状。刻意不做完整 cron：见 `validateSpec`。 */
export const SCHEDULE_SPEC_KINDS = Object.freeze(['interval', 'daily', 'weekly'])

function fail(code, message, extra = {}, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, ...extra })
}

// ---------------------------------------------------------------- 时区

/**
 * 校验 IANA 时区名。
 *
 * ★ **不合法时抛错，绝不回落到服务器本地时区。**
 *
 * 这是一个真实的、安静的失效：一个面向中国用户的部署把 `Asia/Shanghai`
 * 写成了 `Asia/Shangai`（少一个 h）。回落成本地时区时，`09:00` 会按
 * **服务器所在时区**解释——在一台 UTC 的服务器上，计划在**北京时间 17:00**
 * 触发。而它每天都会成功、每天都会在历史里产生一条 `completed` 行。
 *
 *   > 一个「时区名写错了就按服务器时区跑」的实现，与一个「时区写错了」的实现，
 *   > 在运行历史里看起来都是"每天都成功"——只不过前者跑在错的时间上，
 *   > 而没有任何一条记录会说出这件事。
 */
export function assertTimezone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') {
    throw fail(AUTOMATION_ERRORS.BAD_TIMEZONE, '时区必须是一个非空的 IANA 名（例如 Asia/Shanghai）')
  }
  const name = tz.trim()
  try {
    // 构造一次即可：非法名会让 Intl 抛 RangeError。
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format(new Date(0))
  } catch {
    throw fail(AUTOMATION_ERRORS.BAD_TIMEZONE,
      `认不出的时区名：${name}。**不回落服务器本地时区**——那会让计划在错的时间上每天正常触发，` +
      '而运行历史里看去全是成功')
  }
  return name
}

const HOUR_CYCLE = Object.freeze({ hourCycle: 'h23' })

/** 把某个 UTC 毫秒在给定时区里的"墙上时间"拆出来。 */
export function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, ...HOUR_CYCLE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = {}
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return {
    year: p.year, month: p.month, day: p.day,
    hour: p.hour, minute: p.minute, second: p.second,
    // 星期几：0=周日。用 UTC 版算（它只依赖日历日，不依赖时区偏移）。
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
  }
}

/**
 * 把"某个时区里的墙上时间"换成 UTC 毫秒。
 *
 * 两轮迭代：第一轮用 UTC 假设猜一个偏移，第二轮用这个偏移修正。
 * 一轮在绝大多数情况下就对，两轮是为了跨 DST 边界那一天——
 * 那一天偏移会变，而**只迭代一轮的实现会偏一小时**，并且只在一年两天里偏。
 *
 * 不存在的墙上时间（春季 DST 跳过去的那一小时）：第二轮会落在一个
 * 相邻的合法时刻上。**这是可接受的**——但它在 `projectOccurrences` 里的
 * 表现是"那一年的这一天，计划在跳变后的时刻触发一次"，而不是消失。
 */
export function wallTimeToUtcMs({ year, month, day, hour, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  let ms = guess
  for (let i = 0; i < 2; i += 1) {
    const z = zonedParts(ms, timeZone)
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second)
    const offset = asUtc - ms
    ms = guess - offset
  }
  return ms
}

// ---------------------------------------------------------------- spec

/**
 * 校验并归一化计划 spec。
 *
 * **刻意不支持完整 cron 表达式**：cron 的"每 5 分钟"、"每月 1 日"、
 * `@reboot` 各有各的边界语义（月份天数、DST、闰年），而每一处边界
 * 都是一个"只在某些日子上不同"的失效——那种失效**测试很难覆盖，
 * 而生产上一年才碰到两次**。
 *
 * 三种形状覆盖了自动化计划里绝大多数真实需求，且每一种的语义可以
 * 用一句话说清：
 *   · `interval` —— 每 N 毫秒一次（N ≥ 60s，见下）
 *   · `daily`    —— 每天在给定时区的 H:M
 *   · `weekly`   —— 每周在给定时区的 周W H:M
 */
export function validateSpec(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw fail(AUTOMATION_ERRORS.BAD_SPEC, 'spec 必须是一个对象')
  }
  const kind = spec.kind
  if (!SCHEDULE_SPEC_KINDS.includes(kind)) {
    throw fail(AUTOMATION_ERRORS.BAD_SPEC,
      `不认识的 spec.kind：${JSON.stringify(kind)}。支持 ${SCHEDULE_SPEC_KINDS.join(' / ')}——`
      + '完整 cron 没有被实现，因为它的边界语义（月份天数、DST、闰年）各自都是'
      + '只在某些日子上出现的失效，而那种失效在生产上一年才碰到两次')
  }
  const inRange = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi
  if (kind === 'interval') {
    // 下限 60s：比一次 Run 的正常时长还短的间隔，只会产生一堆 skipped 行。
    // 那不是"更实时"，那是把重叠跳过变成常态。
    if (!inRange(spec.everyMs, 60_000, 365 * 24 * 3600 * 1000)) {
      throw fail(AUTOMATION_ERRORS.BAD_SPEC,
        `interval 的 everyMs 必须在 60000..${365 * 24 * 3600 * 1000} 之间（收到 ${JSON.stringify(spec.everyMs)}）。`
        + '下限 60s 是有意的：比一次 Run 还短的间隔只会把"重叠跳过"变成常态')
    }
    return Object.freeze({ kind: 'interval', everyMs: spec.everyMs })
  }
  if (!inRange(spec.hour, 0, 23) || !inRange(spec.minute, 0, 59)) {
    throw fail(AUTOMATION_ERRORS.BAD_SPEC, `hour/minute 必须在 0..23 / 0..59（收到 ${spec.hour}:${spec.minute}）`)
  }
  if (kind === 'daily') {
    return Object.freeze({ kind: 'daily', hour: spec.hour, minute: spec.minute })
  }
  if (!inRange(spec.weekday, 0, 6)) {
    throw fail(AUTOMATION_ERRORS.BAD_SPEC, `weekly 的 weekday 必须在 0..6（0=周日，收到 ${JSON.stringify(spec.weekday)}）`)
  }
  return Object.freeze({ kind: 'weekly', weekday: spec.weekday, hour: spec.hour, minute: spec.minute })
}

/**
 * 下一次应该在什么时候跑（严格晚于 `fromMs`）。
 *
 * @returns {number} UTC 毫秒
 */
export function nextOccurrenceAfter(spec, { fromMs, timezone }) {
  assertTimezone(timezone)
  if (!Number.isSafeInteger(fromMs)) throw fail(AUTOMATION_ERRORS.BAD_WINDOW, 'fromMs 必须是安全整数毫秒')
  switch (spec.kind) {
    case 'interval': {
      // 对齐到 spec 的网格：服务重启后 `next = now + everyMs` 会让计划
      // **永久漂移**（每次重启往后挪一点），而"每小时的第 5 分钟"这种
      // 意图会在几次重启之后变成"每小时的第 47 分钟"。
      // 用 `floor(from / everyMs) * everyMs + everyMs` 把它钉回网格。
      const n = Math.floor(fromMs / spec.everyMs) + 1
      return n * spec.everyMs
    }
    case 'daily': {
      const z = zonedParts(fromMs, timezone)
      const today = wallTimeToUtcMs(
        { year: z.year, month: z.month, day: z.day, hour: spec.hour, minute: spec.minute }, timezone,
      )
      if (today > fromMs) return today
      // 明天：用"今天的 UTC 日 + 1 天"再取墙上时间，避免手工处理月末。
      const tomorrowNoon = Date.UTC(z.year, z.month - 1, z.day + 1, 12, 0, 0)
      const t = zonedParts(tomorrowNoon, timezone)
      return wallTimeToUtcMs(
        { year: t.year, month: t.month, day: t.day, hour: spec.hour, minute: spec.minute }, timezone,
      )
    }
    case 'weekly': {
      const z = zonedParts(fromMs, timezone)
      // 从今天起找最近的那个 weekday（含今天，但必须是**未来**的时刻）。
      for (let add = 0; add <= 7; add += 1) {
        const probeNoon = Date.UTC(z.year, z.month - 1, z.day + add, 12, 0, 0)
        const p = zonedParts(probeNoon, timezone)
        if (p.weekday !== spec.weekday) continue
        const candidate = wallTimeToUtcMs(
          { year: p.year, month: p.month, day: p.day, hour: spec.hour, minute: spec.minute }, timezone,
        )
        if (candidate > fromMs) return candidate
      }
      // 上面 0..7 必然覆盖一整周，走不到这里。留着这条是为了让"算不出来"
      // 有一个具名出口，而不是静默从前一天的同一时刻凑一个值。
      throw fail(AUTOMATION_ERRORS.BAD_SPEC, 'weekly 算不出下一次触发时刻（这是一个不该发生的读数）', {}, 500)
    }
    default:
      throw fail(AUTOMATION_ERRORS.BAD_SPEC, `不认识的 spec.kind：${spec.kind}`)
  }
}

/**
 * **纯函数**：某个时间窗内"本该跑"的时刻列表。
 *
 * 这是"日历只做投影"的实现——它**不碰库、不写任何行**。
 * 视图要展示未来 7 天，就调它算 7 天；关掉页面，库里一行都不会多。
 *
 * 上界 `maxOccurrences` 是必需的：一条 1 分钟间隔的计划投影一年会算出
 * 52 万条，而视图只需要第一屏。不给上界等于把"一次翻页"变成一次
 * 可能耗光内存的计算。
 */
export function projectOccurrences(schedule, { fromMs, toMs, maxOccurrences = 500 } = {}) {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs) {
    throw fail(AUTOMATION_ERRORS.BAD_WINDOW,
      `日历窗口不合法：fromMs=${fromMs} toMs=${toMs}（必须都是安全整数且 toMs > fromMs）`)
  }
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences <= 0) {
    throw fail(AUTOMATION_ERRORS.BAD_WINDOW, 'maxOccurrences 必须是正安全整数')
  }
  const spec = validateSpec(schedule.spec)
  const timezone = assertTimezone(schedule.timezone)
  const out = []
  let cursor = fromMs
  while (out.length < maxOccurrences) {
    const next = nextOccurrenceAfter(spec, { fromMs: cursor, timezone })
    if (next > toMs) break
    out.push(next)
    cursor = next
  }
  return Object.freeze(out)
}

// ---------------------------------------------------------------- 建表

export function ensureAutomationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_schedules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      catch_up_policy TEXT NOT NULL DEFAULT 'once',
      next_run_at_ms INTEGER,
      last_run_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      created_by TEXT,
      note TEXT
    )
  `)
  // 「到点了」的扫描靠它。没有索引时每个 tick 都全表扫，
  // 而计划表会随着用户使用长起来（那正是它该长的样子）。
  db.exec('CREATE INDEX IF NOT EXISTS idx_automation_due ON automation_schedules(enabled, next_run_at_ms)')

  // ── 计划的**运行**（不是"日历格子"）────────────────────────────────
  //
  // `planned_at_ms` 是"计划本该在什么时候跑"，`started_at_ms` 是"实际什么时候开始的"。
  // 两列必须分开：只有一列时，"这次跑晚了 40 分钟"与"这次是按新的计划时刻跑的"
  // 在库里长得一样，而排查延迟问题的人需要能分开它们。
  //
  // `catch_up_of_ms` 非空表示这一行是**补跑**出来的，值是被它代表的那个
  // 原始计划时刻。合并补跑（`once`）时，一次运行代表了好几个错过的时刻，
  // 而"它代表了哪几个"必须留下——否则事后无法回答"停机那三天到底算不算跑过"。
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      planned_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      attempt_id TEXT,
      task_id TEXT,
      approval_id TEXT,
      skip_reason TEXT,
      error TEXT,
      catch_up_of_ms INTEGER,
      coalesced_count INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_automation_runs_schedule ON automation_runs(schedule_id, planned_at_ms)')
  // 重叠判定只关心**非终态**的那些，而它每个 tick 都跑一次。
  db.exec('CREATE INDEX IF NOT EXISTS idx_automation_runs_state ON automation_runs(schedule_id, state)')
  // 一条计划在同一时刻**只能有一条运行**：物化是幂等的，重放不会产生第二条。
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_unique ON automation_runs(schedule_id, planned_at_ms)')

  // 老库升级：新增列走 ensureColumn（它自己做 BEGIN IMMEDIATE 复读，
  // 两个进程同时开同一个库时不会各查各的然后各加一列）。
  // 签名是 `(db, table, column, ddl)` —— 位置参数，不是选项对象。
  ensureColumn(db, 'automation_runs', 'catch_up_of_ms', 'INTEGER')
  ensureColumn(db, 'automation_runs', 'coalesced_count', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'automation_runs', 'approval_id', 'TEXT')
}

// ---------------------------------------------------------------- 仓储

export function createAutomationStore({ db, clock = () => Date.now(), idFactory = null } = {}) {
  if (typeof clock !== 'function') throw new TypeError('createAutomationStore 需要 clock')
  let seq = 0
  // 默认 id 生成器在**函数体内**定义（它要闭包 `seq` 与 `clock`）。
  // 写成参数默认值 `idFactory = defaultRunId` 会在函数声明提升之前求值，
  // 于是 `ReferenceError: defaultRunId is not defined` —— 而报错位置在
  // 调用方那一行，与真实原因（TDZ）隔着一层。
  const makeId = idFactory ?? ((prefix) => {
    seq += 1
    return `${prefix}:${clock()}:${seq}`
  })

  const withTx = (fn) => {
    if (db.isTransaction === true) return fn()
    db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 事务已经没了 */ }
      throw e
    }
  }

  const shapeSchedule = (r) => r === undefined || r === null ? null : Object.freeze({
    id: r.id,
    scope: r.scope,
    name: r.name,
    spec: JSON.parse(r.spec_json),
    timezone: r.timezone,
    enabled: Number(r.enabled) === 1,
    overlapPolicy: r.overlap_policy,
    catchUpPolicy: r.catch_up_policy,
    nextRunAtMs: r.next_run_at_ms === null ? null : Number(r.next_run_at_ms),
    lastRunAtMs: r.last_run_at_ms === null ? null : Number(r.last_run_at_ms),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    createdBy: r.created_by ?? null,
    note: r.note ?? null,
  })

  const shapeRun = (r) => r === undefined || r === null ? null : Object.freeze({
    id: r.id,
    scheduleId: r.schedule_id,
    scope: r.scope,
    plannedAtMs: Number(r.planned_at_ms),
    state: r.state,
    startedAtMs: r.started_at_ms === null ? null : Number(r.started_at_ms),
    finishedAtMs: r.finished_at_ms === null ? null : Number(r.finished_at_ms),
    attemptId: r.attempt_id ?? null,
    taskId: r.task_id ?? null,
    approvalId: r.approval_id ?? null,
    skipReason: r.skip_reason ?? null,
    error: r.error ?? null,
    catchUpOfMs: r.catch_up_of_ms === null || r.catch_up_of_ms === undefined ? null : Number(r.catch_up_of_ms),
    coalescedCount: Number(r.coalesced_count ?? 1),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
  })

  const scheduleRow = (id) => db.prepare('SELECT * FROM automation_schedules WHERE id = ?').get(id) ?? null
  const runRow = (id) => db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) ?? null

  function scheduleOf(id) { return shapeSchedule(scheduleRow(id)) }
  function runOf(id) { return shapeRun(runRow(id)) }

  /**
   * 建计划。`nextRunAtMs` **由 spec + 时区算出来**，不由调用方给。
   *
   * 让调用方给"下次什么时候跑"是一个看起来很贴心的接口，而它给的是一个
   * **可以与自己填的 spec 不一致**的值：`spec = 每天 09:00` 而
   * `nextRunAtMs = 某个 14:37`。两处不一致时没有任何东西会报错，
   * 计划会先按 14:37 跑一次，然后才回到 09:00。
   */
  function createSchedule({ id, scope, name, spec, timezone, enabled = true, overlapPolicy = 'skip', catchUpPolicy = 'once', createdBy = null, note = null, nowMs = null }) {
    if (typeof id !== 'string' || id.trim() === '') throw fail(AUTOMATION_ERRORS.BAD_ID, '计划需要 id')
    if (typeof scope !== 'string' || scope.trim() === '') throw fail(AUTOMATION_ERRORS.BAD_ID, '计划需要 scope')
    if (typeof name !== 'string' || name.trim() === '') throw fail(AUTOMATION_ERRORS.BAD_ID, '计划需要 name')
    const vSpec = validateSpec(spec)
    const tz = assertTimezone(timezone)
    if (!isOverlapPolicy(overlapPolicy)) {
      throw fail(AUTOMATION_ERRORS.BAD_POLICY,
        `不认识的 overlapPolicy：${JSON.stringify(overlapPolicy)}。支持 ${OVERLAP_POLICIES.join(' / ')}——`
        + '自由文本会让"重叠时怎么办"退化成一句备注，而它是要被机器执行的分支')
    }
    if (!isCatchUpPolicy(catchUpPolicy)) {
      throw fail(AUTOMATION_ERRORS.BAD_CATCH_UP,
        `不认识的 catchUpPolicy：${JSON.stringify(catchUpPolicy)}。支持 ${CATCH_UP_POLICIES.join(' / ')}`)
    }
    const at = nowMs ?? clock()
    return withTx(() => {
      const exists = scheduleRow(id)
      if (exists !== null) {
        throw fail(AUTOMATION_ERRORS.BAD_ID, `计划 ${id} 已存在（改它请用 updateSchedule）`, {}, 409)
      }
      const next = enabled ? nextOccurrenceAfter(vSpec, { fromMs: at, timezone: tz }) : null
      db.prepare(
        `INSERT INTO automation_schedules
           (id, scope, name, spec_json, timezone, enabled, overlap_policy, catch_up_policy,
            next_run_at_ms, last_run_at_ms, created_at_ms, updated_at_ms, created_by, note)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
      ).run(id, scope, name, JSON.stringify(vSpec), tz, enabled ? 1 : 0, overlapPolicy, catchUpPolicy,
        next, at, at, createdBy, note)
      return scheduleOf(id)
    })
  }

  function listSchedules({ scope = null, enabled = null, limit = 200 } = {}) {
    const where = []
    const p = []
    if (scope !== null) { where.push('scope = ?'); p.push(scope) }
    if (enabled !== null) { where.push('enabled = ?'); p.push(enabled ? 1 : 0) }
    const sql = `SELECT * FROM automation_schedules ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at_ms ASC LIMIT ?`
    return Object.freeze(db.prepare(sql).all(...p, limit).map(shapeSchedule))
  }

  /**
   * 改一条计划的策略 / 启用位。
   *
   * `nextRunAtMs` **总是重算**，即使这次只改了 `overlapPolicy`：
   * 保留旧值会让"改了时区"这件事在下次触发前看不出效果——而"改了没生效"
   * 与"改了但还没到点"在界面上是同一个读数。
   */
  function updateSchedule({ id, enabled = null, overlapPolicy = null, catchUpPolicy = null, spec = null, timezone = null, name = null, note = null, nowMs = null }) {
    const at = nowMs ?? clock()
    return withTx(() => {
      const row = scheduleRow(id)
      if (row === null) throw fail(AUTOMATION_ERRORS.SCHEDULE_NOT_FOUND, `没有这条计划：${id}`, {}, 404)
      const vSpec = spec === null ? JSON.parse(row.spec_json) : validateSpec(spec)
      const tz = timezone === null ? assertTimezone(row.timezone) : assertTimezone(timezone)
      if (overlapPolicy !== null && !isOverlapPolicy(overlapPolicy)) {
        throw fail(AUTOMATION_ERRORS.BAD_POLICY, `不认识的 overlapPolicy：${JSON.stringify(overlapPolicy)}`)
      }
      if (catchUpPolicy !== null && !isCatchUpPolicy(catchUpPolicy)) {
        throw fail(AUTOMATION_ERRORS.BAD_CATCH_UP, `不认识的 catchUpPolicy：${JSON.stringify(catchUpPolicy)}`)
      }
      const nextEnabled = enabled === null ? Number(row.enabled) === 1 : enabled === true
      const next = nextEnabled ? nextOccurrenceAfter(vSpec, { fromMs: at, timezone: tz }) : null
      db.prepare(
        `UPDATE automation_schedules
            SET name = ?, spec_json = ?, timezone = ?, enabled = ?, overlap_policy = ?,
                catch_up_policy = ?, next_run_at_ms = ?, updated_at_ms = ?, note = ?
          WHERE id = ?`,
      ).run(
        name ?? row.name, JSON.stringify(vSpec), tz, nextEnabled ? 1 : 0,
        overlapPolicy ?? row.overlap_policy, catchUpPolicy ?? row.catch_up_policy,
        next, at, note ?? row.note, id,
      )
      return scheduleOf(id)
    })
  }

  /** 停机再起来时"中间错过了哪几次"。纯读，不改任何状态。 */
  function missedOccurrences(scheduleId, { nowMs = null, maxOccurrences = DEFAULT_MATERIALIZE_LIMIT } = {}) {
    const row = scheduleRow(scheduleId)
    if (row === null) throw fail(AUTOMATION_ERRORS.SCHEDULE_NOT_FOUND, `没有这条计划：${scheduleId}`, {}, 404)
    const at = nowMs ?? clock()
    const sched = shapeSchedule(row)
    if (!sched.enabled || sched.nextRunAtMs === null) return Object.freeze([])
    const out = []
    let cursor = sched.nextRunAtMs
    if (cursor > at) return Object.freeze([])
    // 逐次推进而不是"用除法一次算出来"：interval 可以直接除，但 daily/weekly
    // 不行，而"两种 spec 用两种算法"是两份会漂移的实现。这里统一走
    // `nextOccurrenceAfter`，慢一点但只有一处语义。
    while (out.length < maxOccurrences) {
      const next = nextOccurrenceAfter(sched.spec, { fromMs: cursor, timezone: sched.timezone })
      if (next > at) break
      out.push(next)
      cursor = next
    }
    // 第一个一定是 `nextRunAtMs` 本身（`nextOccurrenceAfter` 严格晚于 fromMs，
    // 而 fromMs 恰好等于它时不会返回它）。把它补进来。
    out.unshift(sched.nextRunAtMs)
    return Object.freeze(out)
  }

  function inFlightCount(scheduleId) {
    const marks = IN_FLIGHT_RUN_STATES.map(() => '?').join(',')
    return Number(db.prepare(
      `SELECT COUNT(*) AS n FROM automation_runs WHERE schedule_id = ? AND state IN (${marks})`,
    ).get(scheduleId, ...IN_FLIGHT_RUN_STATES).n)
  }

  function insertRun({ id, scheduleId, scope, plannedAtMs, state, catchUpOfMs = null, coalescedCount = 1, skipReason = null, nowMs }) {
    db.prepare(
      `INSERT INTO automation_runs
         (id, schedule_id, scope, planned_at_ms, state, skip_reason, catch_up_of_ms, coalesced_count,
          created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (schedule_id, planned_at_ms) DO NOTHING`,
    ).run(id, scheduleId, scope, plannedAtMs, state, skipReason, catchUpOfMs, coalescedCount, nowMs, nowMs)
    return db.prepare('SELECT * FROM automation_runs WHERE schedule_id = ? AND planned_at_ms = ?').get(scheduleId, plannedAtMs)
  }

  /**
   * **唯一的运行物化入口**：把"到点了"变成运行行。
   *
   * 幂等靠 `UNIQUE(schedule_id, planned_at_ms)`：两个 tick 并发、或一次
   * 崩后重放，都不会产生第二条同刻运行。**只在应用层查重是不够的**
   * （两个进程各查一次、各写一行）。
   *
   * 返回逐条读数，因为调用方需要区分三种"没建"：
   *   · `materialized` —— 建了
   *   · `skipped-overlap` —— 上一次还在跑，按策略跳过（**留下了行**）
   *   · `cancelled-replaced` —— 按 `replace` 策略取消了上一次
   */
  function materializeDue({ nowMs = null, scope = null, limit = DEFAULT_MATERIALIZE_LIMIT } = {}) {
    const at = nowMs ?? clock()
    return withTx(() => {
      const where = ['enabled = 1', 'next_run_at_ms IS NOT NULL', 'next_run_at_ms <= ?']
      const p = [at]
      if (scope !== null) { where.push('scope = ?'); p.push(scope) }
      const due = db.prepare(
        `SELECT * FROM automation_schedules WHERE ${where.join(' AND ')} ORDER BY next_run_at_ms ASC LIMIT ?`,
      ).all(...p, limit)

      const out = []
      for (const raw of due) {
        const sched = shapeSchedule(raw)
        const missed = missedOccurrences(sched.id, { nowMs: at, maxOccurrences: DEFAULT_MATERIALIZE_LIMIT })
        if (missed.length === 0) continue
        // 策略决定"这次要为几个错过的时刻建行"。
        //   none → 一个都不建（但仍然**推进 next_run_at_ms**，否则它会永远到点）
        //   once → 建一行，代表全部（`coalescedCount` 记下代表了几个）
        //   all  → 每个错过的时刻各建一行
        const wanted = sched.catchUpPolicy === 'none'
          ? []
          : sched.catchUpPolicy === 'once'
            ? [{ plannedAtMs: missed[missed.length - 1], catchUpOfMs: missed.length > 1 ? missed[0] : null, coalescedCount: missed.length }]
            : missed.map((ms) => ({ plannedAtMs: ms, catchUpOfMs: null, coalescedCount: 1 }))

        for (const item of wanted) {
          const existing = db.prepare(
            'SELECT * FROM automation_runs WHERE schedule_id = ? AND planned_at_ms = ?',
          ).get(sched.id, item.plannedAtMs)
          if (existing !== undefined) { out.push({ action: 'already-materialized', scheduleId: sched.id, plannedAtMs: item.plannedAtMs }); continue }

          const busy = inFlightCount(sched.id)
          if (busy > 0) {
            if (sched.overlapPolicy === 'replace') {
              // 取消正在跑的那些，然后建新的。
              // ★ `replace` **不**是"把它们说成没跑过"：它们进 `cancelled`
              //   并留下 `error`，因为那一次可能已经产生了外部副作用。
              const marks = IN_FLIGHT_RUN_STATES.map(() => '?').join(',')
              const running = db.prepare(
                `SELECT id FROM automation_runs WHERE schedule_id = ? AND state IN (${marks})`,
              ).all(sched.id, ...IN_FLIGHT_RUN_STATES)
              for (const r of running) {
                db.prepare(
                  `UPDATE automation_runs SET state = 'cancelled', error = ?, finished_at_ms = ?, updated_at_ms = ?
                    WHERE id = ? AND state IN (${marks})`,
                ).run('superseded-by-overlap-policy:replace', at, at, r.id, ...IN_FLIGHT_RUN_STATES)
              }
              out.push({ action: 'cancelled-replaced', scheduleId: sched.id, cancelled: running.map((r) => r.id) })
            } else if (sched.overlapPolicy === 'skip') {
              // 见文件头：**留下行**。不记账时"它没被触发"与"它被跳过了"同形。
              const rid = makeId('autorun')
              insertRun({
                id: rid, scheduleId: sched.id, scope: sched.scope, plannedAtMs: item.plannedAtMs,
                state: 'skipped', skipReason: 'overlap', catchUpOfMs: item.catchUpOfMs,
                coalescedCount: item.coalescedCount, nowMs: at,
              })
              out.push({ action: 'skipped-overlap', scheduleId: sched.id, plannedAtMs: item.plannedAtMs, runId: rid })
              continue
            }
            // `queue`：**不跳过，直接建**。它同样是非终态，于是下一次判定
            // 仍然看到重叠——队列就这样长起来。这是被显式选择的行为。
          }

          const rid = makeId('autorun')
          insertRun({
            id: rid, scheduleId: sched.id, scope: sched.scope, plannedAtMs: item.plannedAtMs,
            state: 'scheduled', catchUpOfMs: item.catchUpOfMs,
            coalescedCount: item.coalescedCount, nowMs: at,
          })
          out.push({ action: 'materialized', scheduleId: sched.id, plannedAtMs: item.plannedAtMs, runId: rid, catchUp: item.catchUpOfMs !== null, coalescedCount: item.coalescedCount })
        }

        // 推进到"严格晚于现在"的下一次。用 `at` 而不是最后一个 missed 时刻：
        // 停机三天后用后者只会推进到停机期间的最后一次，于是下一次 tick
        // **立刻又到点**，把整个停机期再物化一遍。
        const next = nextOccurrenceAfter(sched.spec, { fromMs: at, timezone: sched.timezone })
        db.prepare('UPDATE automation_schedules SET next_run_at_ms = ?, last_run_at_ms = ?, updated_at_ms = ? WHERE id = ?')
          .run(next, at, at, sched.id)
      }
      return Object.freeze({ ok: true, atMs: at, dueCount: due.length, results: Object.freeze(out) })
    })
  }

  // ── 运行的状态推进 ─────────────────────────────────────────────────

  const LEGAL_RUN_TRANSITIONS = Object.freeze({
    scheduled: Object.freeze(['running', 'skipped', 'cancelled', 'failed']),
    running: Object.freeze(['awaiting-approval', 'completed', 'failed', 'cancelled']),
    'awaiting-approval': Object.freeze(['running', 'completed', 'failed', 'cancelled']),
    completed: Object.freeze([]),
    failed: Object.freeze([]),
    skipped: Object.freeze([]),
    cancelled: Object.freeze([]),
  })

  function transitionRun(runId, to, { attemptId = null, taskId = null, approvalId = null, skipReason = null, error = null, nowMs = null } = {}) {
    const at = nowMs ?? clock()
    return withTx(() => {
      const row = runRow(runId)
      if (row === null) throw fail(AUTOMATION_ERRORS.RUN_NOT_FOUND, `没有这次运行：${runId}`, {}, 404)
      const from = row.state
      const allowed = LEGAL_RUN_TRANSITIONS[from] ?? []
      if (!allowed.includes(to)) {
        if (isTerminalRunState(from)) {
          // 终态**不可再改**。允许它会让"这次运行到底成了没有"有两个答案，
          // 而后一个答案会覆盖前一个——审计意义就没了。
          throw fail(AUTOMATION_ERRORS.RUN_FINISHED,
            `运行 ${runId} 已经处于终态 ${from}，不能再变成 ${to}。` +
            '允许改写会让"这次到底成了没有"有两个答案，而后来那个会盖掉前一个', {}, 409)
        }
        throw fail(AUTOMATION_ERRORS.BAD_STATE_TRANSITION,
          `${from} → ${to} 不是合法迁移。允许的目标：${allowed.join(', ') || '（无，终态）'}`, {}, 409)
      }
      if (to === 'skipped' && !isSkipReason(skipReason)) {
        throw fail(AUTOMATION_ERRORS.BAD_POLICY,
          `跳过必须给出封闭词表里的原因（收到 ${JSON.stringify(skipReason)}），可选：${SKIP_REASONS.join(' / ')}`)
      }
      if (to === 'awaiting-approval' && (typeof approvalId !== 'string' || approvalId.trim() === '')) {
        // 没有审批 id 的"等审批"是一条**永远醒不过来**的行：没有任何东西
        // 会去把它推回 running，于是它永远占着非终态，这条计划从此停摆。
        throw fail(AUTOMATION_ERRORS.APPROVAL_ID_REQUIRED,
          '进入 awaiting-approval 必须带 approvalId —— 没有它就没有任何东西会去把它推回 running，'
          + '而它会永远占着非终态，让这条计划从此再也触发不了')
      }
      db.prepare(
        `UPDATE automation_runs
            SET state = ?, started_at_ms = COALESCE(started_at_ms, ?),
                finished_at_ms = ?, attempt_id = COALESCE(?, attempt_id), task_id = COALESCE(?, task_id),
                approval_id = COALESCE(?, approval_id), skip_reason = ?, error = ?, updated_at_ms = ?
          WHERE id = ? AND state = ?`,
      ).run(to, to === 'running' ? at : null, isTerminalRunState(to) ? at : null,
        attemptId, taskId, approvalId, skipReason, error, at, runId, from)
      const after = runRow(runId)
      if (after.state !== to) {
        // CAS 没生效 = 有人在这中间改了它。**报出来**，不静默当作成功。
        throw fail(AUTOMATION_ERRORS.BAD_STATE_TRANSITION,
          `运行 ${runId} 的状态在本次写入期间被改成了 ${after.state}（CAS 失败）：并发推进必须被看见`, {}, 409)
      }
      return shapeRun(after)
    })
  }

  const startRun = (runId, opts) => transitionRun(runId, 'running', opts)
  const finishRun = (runId, outcome, opts = {}) => {
    if (!['completed', 'failed', 'cancelled'].includes(outcome)) {
      throw fail(AUTOMATION_ERRORS.BAD_STATE_TRANSITION,
        `finishRun 的 outcome 只能是 completed / failed / cancelled（收到 ${JSON.stringify(outcome)}）。`
        + '跳过走 skipRunRun，等审批走 pauseForApproval —— 三者在历史里必须分得开')
    }
    return transitionRun(runId, outcome, opts)
  }
  const pauseForApproval = (runId, { approvalId, nowMs = null } = {}) => transitionRun(runId, 'awaiting-approval', { approvalId, nowMs })
  const skipRun = (runId, { reason, error = null, nowMs = null } = {}) => transitionRun(runId, 'skipped', { skipReason: reason, error, nowMs })

  function runsOf({ scheduleId = null, scope = null, state = null, limit = 200 } = {}) {
    const where = []
    const p = []
    if (scheduleId !== null) { where.push('schedule_id = ?'); p.push(scheduleId) }
    if (scope !== null) { where.push('scope = ?'); p.push(scope) }
    if (state !== null) { where.push('state = ?'); p.push(state) }
    const sql = `SELECT * FROM automation_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY planned_at_ms DESC LIMIT ?`
    return Object.freeze(db.prepare(sql).all(...p, limit).map(shapeRun))
  }

  /** 汇总。"这条计划今天跑了没有、跳过几次、还在等审批几次"一眼看到。 */
  function summary({ scope = null } = {}) {
    const at = clock()
    const byState = {}
    for (const s of AUTOMATION_RUN_STATES) byState[s] = 0
    const p = []
    let where = ''
    if (scope !== null) { where = 'WHERE scope = ?'; p.push(scope) }
    for (const r of db.prepare(`SELECT state, COUNT(*) AS n FROM automation_runs ${where} GROUP BY state`).all(...p)) {
      // 未登记的状态**照样报出来**（与 run-store.stats 同一条纪律）：
      // 吞掉它会让"库里有一行坏数据"与"没有这种状态"同形。
      byState[r.state] = Number(r.n)
    }
    const schedWhere = scope === null ? '' : 'WHERE scope = ?'
    const schedules = Number(db.prepare(`SELECT COUNT(*) AS n FROM automation_schedules ${schedWhere}`).get(...p).n)
    const enabledSchedules = Number(db.prepare(
      `SELECT COUNT(*) AS n FROM automation_schedules ${scope === null ? 'WHERE' : 'WHERE scope = ? AND'} enabled = 1`,
    ).get(...p).n)
    const overdue = Number(db.prepare(
      `SELECT COUNT(*) AS n FROM automation_schedules
        ${scope === null ? 'WHERE' : 'WHERE scope = ? AND'} enabled = 1
          AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ?`,
    ).get(...p, at).n)
    const unrecognizedStates = Object.keys(byState).filter((s) => !isRunState(s))
    return Object.freeze({
      schedules,
      enabledSchedules,
      // 「有到点但还没物化的计划」是一个**必须能被看见**的读数：
      // 它是"调度循环没在跑"的唯一证据。
      overdue,
      byState: Object.freeze(byState),
      unrecognizedStates: Object.freeze(unrecognizedStates),
      // `settled` 与 event-delivery 同一个口径：**有未登记状态就不算安定**。
      // 只按四个已知终态判定时，一行坏数据会让它读成"全都安定了"。
      settled: IN_FLIGHT_RUN_STATES.every((s) => byState[s] === 0) && unrecognizedStates.length === 0,
      serverTimeMs: at,
    })
  }

  return Object.freeze({
    createSchedule, updateSchedule, listSchedules, scheduleOf,
    missedOccurrences, materializeDue,
    startRun, finishRun, pauseForApproval, skipRun, transitionRun,
    runsOf, runOf, summary,
    withTx,
    /** 供测试与诊断：合法的运行迁移表（只读）。 */
    legalRunTransitions: LEGAL_RUN_TRANSITIONS,
  })
}

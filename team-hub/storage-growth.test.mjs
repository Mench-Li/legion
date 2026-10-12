// team-hub/storage-growth.test.mjs
// ============================================================================
// 容量趋势：库在以多快的速度长、什么时候到危险线。
//
// 守四句话（每一句都对应一种"看起来正常"的坏法）：
//   ① "算不出来"必须是一个**独立**的结论，不能是一个数；
//   ② 用**库的增长**预测，不用**剩余空间的变化**（后者不可归因）；
//   ③ 库在长的时候，**门槛也在长** —— 差距以 3 倍速度合拢；
//   ④ 主库与 WAL 分开：WAL 会被 checkpoint 截断，它是锯齿形的。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_SAMPLES, MIN_SPAN_MS, MAX_HISTORY, HISTORY_LOOKBACK_MS, MAX_SAMPLE_AGE_MS, GROWTH,
  normalizeSamples, pushSample, growthRate, projectCritical, growthSummary, growthReport, renderVars,
} from './storage-growth.mjs'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const MiB = 1024 * 1024
const GiB = 1024 * MiB
const T0 = 1_800_000_000_000

/** 造 `n` 个每小时一个的样本，库每小时长 `perHour` 字节。 */
const series = (n, perHour, { startMs = 0, db0 = 1 * MiB, freeBytes = 50 * GiB, stepMs = HOUR } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    atMs: T0 + startMs + i * stepMs,
    dbBytes: db0 + i * perHour,
    freeBytes,
  }))

/** 够长够多的一串（7 个样本、跨 6 小时）。 */
const enough = (perHour, opts = {}) => series(7, perHour, opts)

// ★ 库在**缩小**时起点必须够大 —— 否则 `dbBytes` 会变负，
//   而那会被 `normalizeSamples` **正确地**丢掉，于是样本不够、
//   判成 insufficient（我第一版就写成了这样，看起来像实现错了）。
const shrink = (perHour, opts = {}) => series(7, perHour, { db0: 100 * MiB, ...opts })

// ── ① ★★★ 样本清洗：只保留真的量到了库大小的 ────────────────────────────

test('★★★ 缺 `dbBytes` 的样本被丢掉（不是当成 0）', () => {
  // ★ 把"没量到"当成 0 会造出"库变小了"的假象，斜率被拉平甚至变负。
  const out = normalizeSamples([
    { atMs: T0, dbBytes: 1000, freeBytes: 10 },
    { atMs: T0 + HOUR, dbBytes: null, freeBytes: 10 },
    { atMs: T0 + 2 * HOUR, freeBytes: 10 },
    { atMs: T0 + 3 * HOUR, dbBytes: undefined },
    { atMs: T0 + 4 * HOUR, dbBytes: 4000, freeBytes: 10 },
  ])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((s) => s.dbBytes), [1000, 4000])
})

test('★★★ 缺 `freeBytes` 的样本**保留**（库大小才是必需的）', () => {
  const out = normalizeSamples([{ atMs: T0, dbBytes: 1000 }, { atMs: T0 + HOUR, dbBytes: 2000 }])
  assert.equal(out.length, 2)
  assert.equal(out[0].freeBytes, null)
})

test('★★★ 同一时刻的重复样本只留最后一条（否则权重加倍）', () => {
  const out = normalizeSamples([
    { atMs: T0, dbBytes: 1000 },
    { atMs: T0, dbBytes: 9999 },
    { atMs: T0 + HOUR, dbBytes: 2000 },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].dbBytes, 9999, '同一时刻留最后一条')
  // 反向：不同时刻的**不许**被合并。
  assert.equal(normalizeSamples([{ atMs: T0, dbBytes: 1 }, { atMs: T0 + 1, dbBytes: 2 }]).length, 2)
})

test('★★★ 乱序样本按时间排好', () => {
  const out = normalizeSamples([
    { atMs: T0 + 2 * HOUR, dbBytes: 300 },
    { atMs: T0, dbBytes: 100 },
    { atMs: T0 + HOUR, dbBytes: 200 },
  ])
  assert.deepEqual(out.map((s) => s.dbBytes), [100, 200, 300])
})

test('★★ 畸形输入不抛，且回空数组（不是 null）', () => {
  for (const bad of [null, undefined, 'x', 42, {}, [null], [1], ['a'], [[]], [undefined]]) {
    assert.doesNotThrow(() => normalizeSamples(bad))
    assert.ok(Array.isArray(normalizeSamples(bad)), `${String(bad)} 应当回数组`)
    assert.equal(normalizeSamples(bad).length, 0, `${String(bad)} 应当回空数组`)
  }
  // 负的库大小、atMs=0 也都丢掉。
  assert.equal(normalizeSamples([{ atMs: 0, dbBytes: 100 }, { atMs: T0, dbBytes: -1 }]).length, 0)
})

// ── ② ★★★ `pushSample`：有界 + 时间必须前进 ──────────────────────────────

test('★★★ 时间没前进的样本被丢掉（重复的一轮 / 时钟倒退）', () => {
  // ★ 一个"回退"的样本会让跨度算小、斜率算大 —— 而那种错误**只会**
  //   让预测更吓人，不会更保守。
  let h = pushSample([], { atMs: T0, dbBytes: 1000 })
  assert.equal(h.length, 1)
  h = pushSample(h, { atMs: T0, dbBytes: 2000 })
  assert.equal(h.length, 1, '同一时刻再来一条不该追加')
  assert.equal(h[0].dbBytes, 1000, '也不该覆盖已有的')
  h = pushSample(h, { atMs: T0 - HOUR, dbBytes: 3000 })
  assert.equal(h.length, 1, '时间倒退不该追加')
  h = pushSample(h, { atMs: T0 + HOUR, dbBytes: 4000 })
  assert.equal(h.length, 2, '正常前进应当追加')
})

test('★★★ 条数有上限，保留**最新**的', () => {
  // ⚠️ 判据必须用**显式**的 max：每小时一个样本时，7 天 = 168 < 200，
  //    所以时间上限先生效 —— 第一版我拿 MAX_HISTORY 去断言，红了，
  //    而那是**判据**没算清楚，不是实现错了。
  const CAP = 50
  let h = []
  for (let i = 0; i < CAP + 20; i += 1) h = pushSample(h, { atMs: T0 + i * HOUR, dbBytes: 1000 + i }, { max: CAP })
  assert.equal(h.length, CAP, `应当被截到 ${CAP}`)
  // 留下的是**新**的那一头。
  assert.equal(h[h.length - 1].dbBytes, 1000 + CAP + 19)
  assert.ok(h[0].atMs > T0, '老的那一头被丢掉')
  // 而默认上限对每小时一个样本**够用**（7 天 = 168 < 200）——
  // 两个上限各管一件事，别把"够用"当成"没用"。
  assert.ok(7 * 24 <= MAX_HISTORY, '默认上限应当容得下 7 天的每小时样本')
})

test('★★★ 时间跨度也有上限（更老的样本对"现在的趋势"没意义）', () => {
  let h = []
  // 每 6 小时一个，远超过 7 天。
  for (let i = 0; i < 60; i += 1) h = pushSample(h, { atMs: T0 + i * 6 * HOUR, dbBytes: 1000 + i })
  const span = h[h.length - 1].atMs - h[0].atMs
  assert.ok(span <= HISTORY_LOOKBACK_MS, `跨度 ${span} 应当不超过 ${HISTORY_LOOKBACK_MS}`)
})

test('★★ 追加畸形样本不抛，且不改动已有历史', () => {
  const h = pushSample([], { atMs: T0, dbBytes: 1000 })
  for (const bad of [null, undefined, 'x', 42, {}, { atMs: T0 + HOUR }]) {
    assert.doesNotThrow(() => pushSample(h, bad))
    assert.equal(pushSample(h, bad).length, 1, `${String(bad)} 不该被追加`)
  }
  // 历史本身畸形时也不抛。
  for (const bad of [null, undefined, 'x', 42]) {
    assert.doesNotThrow(() => pushSample(bad, { atMs: T0, dbBytes: 1 }))
  }
})

// ── ③ ★★★ 核心：算不出来就说算不出来 ────────────────────────────────────

test('★★★ 两个样本、隔 5 分钟 → `insufficient`，**不给数**', () => {
  // ★ 这是本模块最要紧的一条。那对样本能算出 576MB/天（算术没错），
  //   而那个数**没有意义** —— 它会被当成一个预测去报警。
  //
  //   > 一个从两个样本外推出来的"预测"，与一个真的预测，
  //   > 在告警列表上长得一模一样 —— 而只有其中一个值得采取行动。
  const g = growthRate({ samples: [{ atMs: T0, dbBytes: 1 * MiB }, { atMs: T0 + 5 * MIN, dbBytes: 1.002 * MiB }] })
  assert.equal(g.ok, false)
  assert.equal(g.reason, GROWTH.INSUFFICIENT)
  // ★ 三个"没有数"的断言，缺一不可：
  assert.equal(g.bytesPerDay, null, '不许给一个数')
  assert.notEqual(g.bytesPerDay, 0, '也不许回 0（0 是"没在长"，那是另一个结论）')
  assert.equal(g.confidence, 'none')
})

test('★★★ 样本数够但跨度不够 → 仍然 `insufficient`', () => {
  // 4 个样本、每 1 小时一个 = 跨 3 小时 < 6 小时门槛。
  const g = growthRate({ samples: series(4, 1000) })
  assert.equal(g.reason, GROWTH.INSUFFICIENT)
  assert.equal(g.bytesPerDay, null)
  assert.equal(g.sampleCount, 4, '样本数要如实报出来（运维才知道还差多少）')
  assert.equal(g.spanMs, 3 * HOUR)
})

test('★★★ 跨度够但样本数不够 → `insufficient`', () => {
  // 3 个样本、每 3 小时一个 = 跨 6 小时（够），但只有 3 个（不够 4）。
  const g = growthRate({ samples: series(3, 1000, { stepMs: 3 * HOUR }) })
  assert.equal(g.reason, GROWTH.INSUFFICIENT)
  assert.equal(g.sampleCount, 3)
  assert.equal(g.spanMs, 6 * HOUR)
})

test('★★★ `insufficient` 与 `not-growing` 是两件不同的事', () => {
  // ★ 运维的动作不同：一个是"去等 / 去查定时器"，一个是"什么都不用做"。
  const ins = growthRate({ samples: series(2, 1000) })
  const flat = growthRate({ samples: enough(0) })
  assert.equal(ins.reason, GROWTH.INSUFFICIENT)
  assert.equal(flat.reason, GROWTH.NOT_GROWING)
  assert.notEqual(ins.reason, flat.reason, '不许合并成一个')
  // 而 `not-growing` 要给得出数（0），`insufficient` 给不出。
  assert.equal(flat.ok, true)
  assert.equal(flat.bytesPerDay, 0)
  assert.equal(ins.ok, false)
  assert.equal(ins.bytesPerDay, null)
})

test('★★ 门槛可覆盖（判据用短门槛才测得动）', () => {
  const short = series(3, 1000, { stepMs: MIN })
  assert.equal(growthRate({ samples: short }).reason, GROWTH.INSUFFICIENT)
  const relaxed = growthRate({ samples: short }, { minSamples: 3, minSpanMs: 2 * MIN })
  assert.equal(relaxed.ok, true)
  assert.equal(relaxed.reason, GROWTH.GROWING)
})

// ── ④ ★★★ 拟合本身 ────────────────────────────────────────────────────────

test('★★★ 一条完美的直线拟合出**精确**的斜率', () => {
  // 每小时 1MiB → 每天 24 MiB。
  const g = growthRate({ samples: enough(1 * MiB) })
  assert.equal(g.ok, true)
  assert.ok(Math.abs(g.bytesPerDay - 24 * MiB) < 1, `实际 ${g.bytesPerDay}`)
  assert.equal(g.reason, GROWTH.GROWING)
})

test('★★★ 有噪声时拟合仍然合理（不会被一个野点带跑）', () => {
  const clean = enough(1 * MiB).map((s, i) => ({ ...s, dbBytes: s.dbBytes + (i % 2 === 0 ? 0 : 200 * 1024) }))
  const g = growthRate({ samples: clean })
  assert.equal(g.ok, true)
  // 真值 24MiB/天；一个野点不该把它带偏一倍以上。
  assert.ok(g.bytesPerDay > 12 * MiB && g.bytesPerDay < 36 * MiB, `实际 ${g.bytesPerDay}`)
})

test('★★★ 库在缩 → `not-growing`，且**不夹到 0**', () => {
  // ★ 夹到 0 会把"库在缩"说成"库没长" —— 而"有人清理过"是一件值得知道的事。
  const g = growthRate({ samples: shrink(-1 * MiB) })
  assert.equal(g.reason, GROWTH.NOT_GROWING)
  assert.ok(g.bytesPerDay < 0, `缩放应当保留负号，实际 ${g.bytesPerDay}`)
  assert.ok(Math.abs(g.bytesPerDay + 24 * MiB) < 1)
})

test('★★★ 长期平均与**最近**速率分开报（一次突发不能被摊平）', () => {
  // 前 20 小时几乎不长，最后 1 小时猛灌 1GiB。
  const samples = [
    ...series(20, 0, { stepMs: HOUR }),
  ]
  const last = samples[samples.length - 1]
  samples.push({ atMs: last.atMs + HOUR, dbBytes: last.dbBytes + 1 * GiB, freeBytes: last.freeBytes })
  const g = growthRate({ samples })
  assert.equal(g.ok, true)
  // 长期平均很小（1GiB 摊到 20 小时 → 约 1.2GiB/天）。
  assert.ok(g.bytesPerDay < 2 * GiB, `长期平均应当被摊平，实际 ${g.bytesPerDay}`)
  // 而"最近一段"要如实报出那一小时的量级。
  assert.ok(g.recentBytesPerDay > 20 * GiB, `最近速率应当很大，实际 ${g.recentBytesPerDay}`)
})

test('★★★ 置信度随**跨度**升档（跨度是唯一的依据）', () => {
  assert.equal(growthRate({ samples: enough(1000) }).confidence, 'low', '6 小时 → low')
  assert.equal(growthRate({ samples: series(25, 1000) }).confidence, 'medium', '24 小时 → medium')
  assert.equal(growthRate({ samples: series(73, 1000) }).confidence, 'high', '72 小时 → high')
  // ★ 反向：跨度**不够**时永远是 'none'（不许给一个"低置信度"的假数）。
  assert.equal(growthRate({ samples: series(2, 1000) }).confidence, 'none')
})

test('★★★ WAL **不参与**拟合（它会被 checkpoint 截断，是锯齿形的）', () => {
  // ★ 拿 `主库+WAL` 去拟合，会把"刚 checkpoint 过"读成"数据在减少"。
  const samples = enough(1 * MiB).map((s, i) => ({ ...s, walBytes: i < 3 ? 50 * MiB : 1 * MiB }))
  const g = growthRate({ samples })
  // 拟合结果与不带 WAL 时**完全一样**。
  assert.ok(Math.abs(g.bytesPerDay - 24 * MiB) < 1, `实际 ${g.bytesPerDay}`)
  // 而 WAL 的当前值单独报出来。
  const withWal = growthRate({ samples, walBytes: 7 * MiB })
  assert.equal(withWal.walBytes, 7 * MiB)
})

test('★ 畸形输入不抛，且判成算不出来', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { samples: null }, { samples: 'x' }]) {
    assert.doesNotThrow(() => growthRate(bad))
    assert.equal(growthRate(bad).reason, GROWTH.INSUFFICIENT, `${JSON.stringify(bad)} 应当判算不出来`)
  }
})

// ── ⑤ ★★★ 预测：门槛也在长 ──────────────────────────────────────────────

test('★★★ 门槛不动时（小库）：朴素口径与真实口径相同', () => {
  // 库 1MiB → 2×1MiB = 2MiB << 256MiB 绝对下限，所以门槛固定为 256MiB。
  const p = projectCritical({ samples: enough(1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.equal(p.ok, true)
  assert.equal(p.regime, 'constant')
  assert.ok(Math.abs(p.daysNaive - p.daysEffective) < 1e-9, '固定门槛下两个口径必须相同')
  assert.equal(p.thresholdBytes, 256 * MiB, '门槛就是绝对下限')
  assert.equal(p.closerOf, 'naive')
})

test('★★★ 门槛随库长（大库）：真实到期时间是朴素口径的 **1/3**', () => {
  // ★ 这是最容易漏的一条：`2×主库` 这个门槛**自己也在长**。
  //   库每长 1 字节，要求长 2 字节；剩余空间又少 1 字节 → 差距以 3r 合拢。
  //
  //   > 一个"库长得多快"的预测，与一个"离危险线还有多远"的预测，
  //   > 在库还小的时候是同一个数 —— 而库一大就差了 3 倍。
  const db = 300 * MiB   // 2×300MiB = 600MiB > 256MiB 下限 → 进入 scaling
  const p = projectCritical({ samples: enough(1 * MiB) }, { freeBytes: 4 * GiB, dbBytes: db })
  assert.equal(p.regime, 'scaling')
  assert.equal(p.closerOf, 'effective')
  assert.ok(p.daysEffective < p.daysNaive, '真实到期时间必须**更近**')
  assert.ok(Math.abs(p.daysNaive / p.daysEffective - 3) < 0.001,
    `倍数应当是 3，实际 ${(p.daysNaive / p.daysEffective).toFixed(4)}`)
  assert.equal(p.thresholdBytes, 2 * db)
})

test('★★★ 已经在危险线以下 → `already-critical`，且不给到期时间', () => {
  const p = projectCritical({ samples: enough(1 * MiB) }, { freeBytes: 100 * MiB, dbBytes: 200 * MiB })
  assert.equal(p.alreadyCritical, true)
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'already-critical')
  assert.equal(p.daysEffective, null, '已经发生了就不该再给"还有多久"')
  assert.equal(p.daysNaive, null)
})

test('★★★ 库在缩 → 没有到期时间（不许外推一个负数天）', () => {
  const p = projectCritical({ samples: shrink(-1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 10 * MiB })
  assert.equal(p.ok, false)
  assert.equal(p.reason, GROWTH.NOT_GROWING)
  assert.equal(p.daysEffective, null)
  assert.equal(p.alreadyCritical, false, '库在缩不等于已在危险线以下')
})

test('★★★ 算不出趋势时，预测也**不给数**', () => {
  const p = projectCritical({ samples: series(2, 1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.equal(p.ok, false)
  assert.equal(p.reason, GROWTH.INSUFFICIENT)
  assert.equal(p.daysEffective, null)
  assert.equal(p.daysNaive, null)
})

test('★★★ 读不到剩余空间 → 不给到期时间（但不影响趋势本身）', () => {
  const p = projectCritical({ samples: enough(1 * MiB) }, { freeBytes: null, dbBytes: 1 * MiB })
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'no-free-space')
  assert.equal(p.daysEffective, null)
  // ★ 趋势本身仍然算得出来 —— 两件事不该互相拖累。
  assert.equal(p.base.ok, true)
  assert.equal(p.base.reason, GROWTH.GROWING)
})

test('★★ 增长率为 0 时预测不给数（不许除零得到 Infinity）', () => {
  const p = projectCritical({ samples: enough(0) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.equal(p.ok, false)
  assert.equal(p.daysEffective, null)
  assert.notEqual(p.daysEffective, Infinity, '不许回 Infinity')
  assert.ok(Number.isFinite(p.headroomBytes))
})

test('★★ 到期时间与手算一致（钉住公式，不只是"是正数"）', () => {
  // 库 1MiB（constant 口径）、门槛 256MiB、可用 1GiB、每天长 24MiB：
  //   (1GiB − 256MiB) / 24MiB = 768/24 = 32 天
  const p = projectCritical({ samples: enough(1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.ok(Math.abs(p.daysEffective - 32) < 1e-6, `实际 ${p.daysEffective}`)
})

// ── ⑤b ★★★ 陈旧的样本不许当成"现在的趋势" ────────────────────────────────

test('★★★ 最新样本太老 → `stale-samples`，**不给**斜率（这是最像真话的假话）', () => {
  // ★ 一个停了三天的定时器留下的是三天前的样本。从它们算出的斜率是一条
  //   **当时**的趋势，而它会被当成"库现在在以多快的速度长"。
  //
  //   > 一个从三天前的样本算出来的趋势，与一个现在的趋势，
  //   > 在一行"X MiB/天"里长得一模一样。
  const samples = enough(1 * MiB)          // 跨 6 小时，跨度是**够**的
  const newest = samples[samples.length - 1].atMs
  // 新鲜时算得出来。
  const fresh = growthRate({ samples }, { nowMs: newest + 10 * MIN })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.reason, GROWTH.GROWING)
  // 三天后再看同一批样本 → 必须拒绝给趋势。
  const old = growthRate({ samples }, { nowMs: newest + 3 * DAY })
  assert.equal(old.ok, false)
  assert.equal(old.reason, GROWTH.STALE_SAMPLES)
  assert.equal(old.bytesPerDay, null, '不许给一个"当时的"斜率')
  assert.notEqual(old.reason, GROWTH.INSUFFICIENT, '与"还没测够"要分开（动作不同）')
  // 而样本年龄要如实报出来。
  assert.ok(Math.abs(old.sampleAgeMs - 3 * DAY) < 1000, `实际 ${old.sampleAgeMs}`)
})

test('★★★ 门槛正好在边界上：等于 MAX 算新鲜，超过一毫秒算陈旧', () => {
  const samples = enough(1 * MiB)
  const newest = samples[samples.length - 1].atMs
  assert.equal(growthRate({ samples }, { nowMs: newest + MAX_SAMPLE_AGE_MS }).ok, true, '边界上算新鲜')
  assert.equal(growthRate({ samples }, { nowMs: newest + MAX_SAMPLE_AGE_MS + 1 }).reason, GROWTH.STALE_SAMPLES)
})

test('★★ 时钟倒退（样本来自"未来"）按 0 岁处理，不许判成陈旧', () => {
  const samples = enough(1 * MiB)
  const newest = samples[samples.length - 1].atMs
  assert.equal(growthRate({ samples }, { nowMs: newest - 5 * MIN }).ok, true)
  assert.equal(growthRate({ samples }, { nowMs: newest - 5 * MIN }).sampleAgeMs, 0)
})

test('★★★ 陈旧样本的说法要与"还没测够"**不同**', () => {
  const samples = enough(1 * MiB)
  const newest = samples[samples.length - 1].atMs
  const stale = growthSummary(null, { samples }, { nowMs: newest + 3 * DAY, freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  const thin = growthSummary(null, { samples: series(2, 1000) }, { nowMs: 0, freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.match(stale.text, /定时器|给不出/, `陈旧的说法要指向定时器：${stale.text}`)
  assert.doesNotMatch(stale.text, /算不出来：目前只有/, '不许说成"样本不够"')
  assert.notEqual(stale.text, thin.text)
  assert.doesNotMatch(stale.text, /\{[A-Za-z_]/)
})

test('★★★ 端到端：`growthReport` 也要跟着拒绝给陈旧趋势', () => {
  const samples = enough(1 * MiB)
  const newest = samples[samples.length - 1].atMs
  const r = growthReport({ samples, freeBytes: 1 * GiB, dbBytes: 1 * MiB, nowMs: newest + 3 * DAY })
  assert.equal(r.reason, GROWTH.STALE_SAMPLES)
  assert.equal(r.bytesPerDay, null)
  assert.equal(r.daysEffective, null)
})

// ── ⑥ ★★★ 说法：渲染好、两种口径都报 ────────────────────────────────────

test('★★★ `insufficient` 要说清**缺什么**，并否掉"没问题"的读法', () => {
  const s = growthSummary(null, { samples: series(2, 1000) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.match(s.text, /算不出来/)
  assert.match(s.text, /不是"没问题"/, '必须否掉"看不出来 = 没问题"的读法')
  assert.match(s.text, /6 小时|样本/, '要说清缺哪个条件')
  assert.doesNotMatch(s.text, /\{[A-Za-z_]/, '不许剩占位符')
})

test('★★★ 大库时说清"3 倍合拢"以及两种口径的数', () => {
  const db = 300 * MiB
  const s = growthSummary(null, { samples: enough(1 * MiB) }, { freeBytes: 4 * GiB, dbBytes: db })
  assert.match(s.text, /3 倍|门槛/, '要说清门槛也在长')
  assert.match(s.text, /天|个月|年/, '要给一个时间量级')
  assert.doesNotMatch(s.text, /\{[A-Za-z_]/)
  // 两个口径的数都要出现（一个在"约 X"，一个在"若门槛不动则 Y"）。
  const nums = s.text.match(/\d+(\.\d+)?/g) ?? []
  assert.ok(nums.length >= 3, `说法里应当有多个数：${s.text}`)
})

test('★★★ 库在缩 / 没长各有各的说法（不合并）', () => {
  // ⚠️ 局部变量名不能叫 `shrink` —— 那会**遮蔽**同名的样本构造器，
  //    而它在自己的初始化式里被引用（TDZ）→ ReferenceError。
  //    （这是我批量改名时自己造成的碰撞，不是实现的问题。）
  const goingDown = growthSummary(null, { samples: shrink(-1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 10 * MiB })
  const flat = growthSummary(null, { samples: enough(0) }, { freeBytes: 1 * GiB, dbBytes: 10 * MiB })
  assert.match(goingDown.text, /缩小/)
  assert.match(flat.text, /没有在增长/)
  assert.notEqual(goingDown.text, flat.text)
})

test('★★★ 已在危险线以下时，说法先说**先清空间**再说趋势', () => {
  const s = growthSummary(null, { samples: enough(1 * MiB) }, { freeBytes: 100 * MiB, dbBytes: 200 * MiB })
  assert.match(s.text, /危险线/)
  assert.match(s.text, /清/)
  assert.doesNotMatch(s.text, /天|个月|年/, '已经发生了就不该谈"还有多久"')
})

test('★★ 每一句都同时给 `key`/`vars` 与渲染好的 `text`（与上一轮同一条规矩）', () => {
  const cases = [
    [{ samples: series(2, 1000) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB }],
    [{ samples: shrink(-1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 10 * MiB }],
    [{ samples: enough(0) }, { freeBytes: 1 * GiB, dbBytes: 10 * MiB }],
    [{ samples: enough(1 * MiB) }, { freeBytes: 4 * GiB, dbBytes: 300 * MiB }],
    [{ samples: enough(1 * MiB) }, { freeBytes: 1 * GiB, dbBytes: 1 * MiB }],
    [{ samples: enough(1 * MiB) }, { freeBytes: 100 * MiB, dbBytes: 200 * MiB }],
  ]
  const keys = new Set()
  for (const [input, opts] of cases) {
    const s = growthSummary(null, input, opts)
    keys.add(s.key)
    assert.equal(typeof s.key, 'string')
    assert.equal(typeof s.vars, 'object')
    assert.equal(typeof s.text, 'string')
    assert.doesNotMatch(s.text, /\{[A-Za-z_]/, `text 里剩了占位符：${s.text}`)
    assert.doesNotMatch(s.text, /undefined|\bNaN\b/, `text 里有脏值：${s.text}`)
  }
  assert.equal(keys.size, cases.length, '六种情形必须给出六句不同的话')
})

test('★ 反例守卫：上面的"六句不同"不是恒真', () => {
  const same = [1, 2, 3, 4, 5, 6].map(() => ({ key: '同一句' }))
  assert.equal(new Set(same.map((s) => s.key)).size, 1, '反例：同一句只该算出 1 种')
})

// ── ⑥b ★★★ 占位符渲染（直接测，不靠"某一句话恰好缺变量"）─────────────────

test('★★★ `renderVars` 缺变量时**原样留占位符**（不印 undefined）', () => {
  // ★ 直接测的理由：一套"每一句说法都把变量给全了"的实现，
  //   会让任何**间接**的渲染判据都测不到这条路径。
  assert.equal(renderVars('库以 {rate}/天在长', {}), '库以 {rate}/天在长')
  assert.equal(renderVars('库以 {rate}/天在长', { rate: undefined }), '库以 {rate}/天在长')
  assert.equal(renderVars('库以 {rate}/天在长', { rate: null }), '库以 {rate}/天在长')
  assert.equal(renderVars('库以 {rate}/天在长', { rate: 0 }), '库以 0/天在长', '0 是合法值，不许当成缺变量')
  assert.equal(renderVars('库以 {rate}/天在长', { rate: '24 MiB' }), '库以 24 MiB/天在长')
  assert.equal(renderVars('没有占位符', { x: 1 }), '没有占位符')
  // 多个占位符都要填。
  assert.equal(renderVars('{a} 与 {b}', { a: '1', b: '2' }), '1 与 2')
  // 畸形输入不抛，且回空串。
  for (const bad of [null, undefined, 42, {}]) {
    assert.doesNotThrow(() => renderVars(bad, {}))
    assert.equal(renderVars(bad, {}), '')
  }
})

test('★★★ `renderVars` 的两条边界各有反例（不许恒真）', () => {
  // 反向：一个**有**值的变量必须被替换（否则上面"留占位符"那几条恒真）。
  assert.notEqual(renderVars('{a}', { a: 'x' }), '{a}')
  // 反向：一个**缺**的变量必须留下（否则上面"替换"那条恒真）。
  assert.equal(renderVars('{a}', {}), '{a}')
})
// ── ⑦ ★★★ 端到端：`growthReport` ────────────────────────────────────────

test('★★★ `growthReport` 把趋势与预测合成一块，字段齐全', () => {
  const r = growthReport({ samples: enough(1 * MiB), walBytes: 3 * MiB, freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.equal(r.reason, GROWTH.GROWING)
  assert.ok(Number.isFinite(r.bytesPerDay))
  assert.ok(Number.isFinite(r.daysEffective))
  assert.equal(r.regime, 'constant')
  assert.equal(r.confidence, 'low')
  assert.equal(r.sampleCount, 7)
  assert.equal(r.walBytes, 3 * MiB)
  assert.equal(typeof r.summary.text, 'string')
  assert.doesNotMatch(r.summary.text, /\{[A-Za-z_]/)
})

test('★★★ `growthReport` 在数据不够时**不给任何时间数**', () => {
  const r = growthReport({ samples: series(2, 1 * MiB), freeBytes: 1 * GiB, dbBytes: 1 * MiB })
  assert.equal(r.reason, GROWTH.INSUFFICIENT)
  assert.equal(r.bytesPerDay, null)
  assert.equal(r.daysEffective, null)
  assert.equal(r.daysNaive, null)
  assert.equal(r.confidence, 'none')
  assert.match(r.summary.text, /算不出来/)
})

test('★★ 畸形输入不抛', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { samples: null }]) {
    assert.doesNotThrow(() => growthReport(bad))
    assert.equal(growthReport(bad).reason, GROWTH.INSUFFICIENT)
  }
})

// ── ⑧ ★★★ 判据自身的守卫 ────────────────────────────────────────────────

test('★★★ 上面那些"给不出数"的断言不是恒真（反例在同一套断言下必须红）', () => {
  // ★ 一组"等于 null"的断言在最坏情况下会因为**模块什么都回 null** 而全绿。
  //   所以这里用同一批断言去检查一个**真的给了数**的情形 —— 它必须红。
  const good = growthRate({ samples: enough(1 * MiB) })
  assert.notEqual(good.bytesPerDay, null, '有数据时**必须**给数（否则上面那些判据毫无意义）')
  assert.equal(good.ok, true)
  assert.equal(good.confidence === 'none', false)
  // 而真正没数据时它必须为 null —— 两个方向都断言，才算证明。
  assert.equal(growthRate({ samples: [] }).bytesPerDay, null)
})

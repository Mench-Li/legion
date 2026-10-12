// team-hub/storage-growth.mjs
// ============================================================================
// **容量趋势**：库在以多快的速度长？照这个速度，什么时候会到危险线？
//
// 这是"逐步开放"最后缺的一块：按账号配额挡的是**一个人**打太多，
// 磁盘满的处理是**已经满了之后**怎么说清楚。中间那一段 ——
// "照现在的速度，还有多久" —— 之前没有任何东西在回答。
//
// ## ★① "算不出来"必须是一个**独立**的结论，不能是一个数
//
// 两个样本、隔 5 分钟、涨了 2MB，能算出 576MB/天。那个数是**真的**
// （算术没错），但它**没有意义** —— 而它会被当成一个预测去报警。
//
//   > 一个从两个样本外推出来的"预测"，与一个真的预测，
//   > 在告警列表上长得一模一样 —— 而只有其中一个值得采取行动。
//
// 所以样本不够、跨度太短时回 `insufficient`，**不回 0、也不回那个数**。
// `insufficient` 与 `not-growing` 是两件事：
//   · `insufficient` —— 还没测够，**去等 / 去查定时器**；
//   · `not-growing`  —— 测够了，库没在长，**什么都不用做**。
//
// ## ★② 用**库的增长**做预测，不用**剩余空间的变化**
//
// 剩余空间减少的原因很多：日志、系统更新、别人的文件。用它的变化率外推，
// 等于把**所有**原因都算到 Legion 头上，而那个数**不可归因** ——
// 也就没法据此做任何决定（该清哪个目录？）。
//
// 库的增长是可归因的：它只因为有人往里写而增长。
//
// ## ★③ 库在长的时候，**门槛也在长**（最容易漏的一条）
//
// `storage-health.mjs` 判定"危险"的门槛是 `max(256MiB, 2×主库)` ——
// 其中 `2×主库` 是因为**备份需要一份与库等大的自由空间**。
//
// 于是库每长 1 字节，要求就长 2 字节；加上剩余空间自己少了 1 字节，
// **差距以 3 倍速度合拢**，而不是 1 倍：
//
//     g(t) = free(t) − 2·db(t)      →      g′ = −r − 2r = −3r
//
//   > 一个"库长得多快"的预测，与一个"离危险线还有多远"的预测，
//   > 在库还小的时候是同一个数 —— 而库一大就差了 3 倍。
//
// 所以两种口径**都报**：朴素口径（`free/r`）与含门槛增长的口径（`free/3r`），
// 让运维看见那个差别，而不是替他选一个。
//
// ## ★④ 主库与 WAL 要分开看
//
// WAL 在 checkpoint 时会被**截断** —— 所以 `主库 + WAL` 是个锯齿形的量，
// 它**会变小**。拿锯齿去拟合斜率，会把"刚 checkpoint 过"读成"数据在减少"。
// 主库是单调的、也是真正的数据量，所以**拟合只用主库**；
// WAL 单独报（它的大小是"checkpoint 有多久没跑"的指标，不是数据量）。
// ============================================================================

/** 少于这么多**有效**样本，不给预测。 */
export const MIN_SAMPLES = 4

/** 跨度短于这个，不给预测（每小时一次的话 = 至少 6 个样本）。 */
export const MIN_SPAN_MS = 6 * 60 * 60 * 1000

/** 置信度分档：跨度到这些值才升档。 */
export const MEDIUM_CONFIDENCE_SPAN_MS = 24 * 60 * 60 * 1000
export const HIGH_CONFIDENCE_SPAN_MS = 72 * 60 * 60 * 1000

/** 历史最多留多少个样本（每小时一次 ≈ 8 天）。 */
export const MAX_HISTORY = 200

/** 留的历史时间跨度上限（更老的样本对"现在的趋势"没意义）。 */
export const HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 最新样本比这个还老 → **不给预测**。
 *
 * ★ 一个停了三天的定时器，留下的是三天前的样本。从它们算出来的斜率
 *   是一条**当时**的趋势，而不是"库现在在以多快的速度长"。
 *   照它算出"还有 40 天到危险线"并报成现在的结论，与
 *   `storage-state.mjs` 那条"陈旧的 ok"是同一类错误 ——
 *   只不过它躲在一个看起来更技术、更可信的数字后面。
 *
 *   > 一个从三天前的样本算出来的趋势，与一个现在的趋势，
 *   > 在一行"X MiB/天"里长得一模一样。
 *
 * 默认 6 小时 = 每小时一次的话"至少漏了 5 次"。
 */
export const MAX_SAMPLE_AGE_MS = 6 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** 趋势的四种结论。 */
export const GROWTH = Object.freeze({
  INSUFFICIENT: 'insufficient',
  STALE_SAMPLES: 'stale-samples',
  NOT_GROWING: 'not-growing',
  GROWING: 'growing',
})

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 清洗样本：丢掉不完整的、按时间排序、同一个时刻只留最后一条。
 *
 * ★ 只保留**真的量到了库大小**的样本。体检读不到库文件时（`unknown`）
 *   那个样本必须丢掉 —— 把它当成 0 会造出一个"库变小了"的假象，
 *   而斜率会因此被拉平甚至变负。
 *
 * @returns {Array<{atMs: number, dbBytes: number, freeBytes: number|null}>}
 */
export function normalizeSamples(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const s of raw) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) continue
    const atMs = num(s.atMs)
    const dbBytes = num(s.dbBytes)
    // 库大小是**必需**的；剩余空间可以缺（缺了就不报"离危险线还有多久"）。
    if (atMs === null || atMs <= 0 || dbBytes === null || dbBytes < 0) continue
    out.push({ atMs, dbBytes, freeBytes: num(s.freeBytes) })
  }
  // 同一时刻（毫秒相同）只留最后一条 —— 重复样本会把权重加倍。
  const byTime = new Map()
  for (const s of out) byTime.set(s.atMs, s)
  return [...byTime.values()].sort((a, b) => a.atMs - b.atMs)
}

/**
 * 追加一个样本，并保持有界。
 *
 * ★ 时间**不前进**的样本被丢掉（重复的一轮、或时钟倒退）。
 *   一个"回退"的样本会让跨度算小、斜率算大 —— 而那种错误**只会**
 *   让预测更吓人，不会更保守。
 */
export function pushSample(history, sample, { max = MAX_HISTORY, lookbackMs = HISTORY_LOOKBACK_MS } = {}) {
  const [clean] = normalizeSamples([sample])
  if (clean === undefined) return Array.isArray(history) ? normalizeSamples(history) : []
  const base = normalizeSamples(history)
  const last = base[base.length - 1]
  // 时间没前进（同一时刻或倒退）→ 不追加。
  if (last !== undefined && clean.atMs <= last.atMs) return base
  const next = [...base, clean]
  // 两头都截：条数上限 + 时间跨度上限。
  const newest = next[next.length - 1].atMs
  const fresh = next.filter((s) => newest - s.atMs <= lookbackMs)
  return fresh.slice(Math.max(0, fresh.length - max))
}

/**
 * 拟合增长率（**只用主库**，见文件头 ④）。
 *
 * 用最小二乘（对时间，单位"天"）。跨度与样本数不够时回 `insufficient`。
 *
 * @returns {{ok: boolean, reason: string, bytesPerDay: number|null, recentBytesPerDay: number|null,
 *            spanMs: number|null, sampleCount: number, confidence: string,
 *            firstDbBytes: number|null, lastDbBytes: number|null, walBytes: number|null}}
 */
export function growthRate(input, {
  minSamples = MIN_SAMPLES, minSpanMs = MIN_SPAN_MS,
  nowMs = Date.now(), maxSampleAgeMs = MAX_SAMPLE_AGE_MS,
} = {}) {
  const samples = normalizeSamples(input?.samples)
  const miss = (reason, extra = {}) => ({
    ok: false,
    reason,
    bytesPerDay: null,
    recentBytesPerDay: null,
    spanMs: samples.length >= 2 ? samples[samples.length - 1].atMs - samples[0].atMs : null,
    sampleCount: samples.length,
    confidence: 'none',
    firstDbBytes: samples.length > 0 ? samples[0].dbBytes : null,
    lastDbBytes: samples.length > 0 ? samples[samples.length - 1].dbBytes : null,
    walBytes: num(input?.walBytes),
    sampleAgeMs: samples.length > 0 ? Math.max(0, Number(nowMs) - samples[samples.length - 1].atMs) : null,
    ...extra,
  })
  if (samples.length < Math.max(2, minSamples)) return miss(GROWTH.INSUFFICIENT)
  // ★ 样本太老 → 不给预测（见 `MAX_SAMPLE_AGE_MS` 的注释）。
  //   这一步在跨度检查**之前**：一条三天前的曲线跨度足够长，
  //   而它恰恰是最容易被误当成"现在的趋势"的那种。
  const ageMs = Math.max(0, Number(nowMs) - samples[samples.length - 1].atMs)
  if (Number.isFinite(Number(maxSampleAgeMs)) && maxSampleAgeMs > 0 && ageMs > maxSampleAgeMs) {
    return miss(GROWTH.STALE_SAMPLES)
  }
  const spanMs = samples[samples.length - 1].atMs - samples[0].atMs
  // ★ 跨度不够就**不给数** —— 这是本模块存在的理由（见文件头 ①）。
  if (spanMs < minSpanMs) return miss(GROWTH.INSUFFICIENT)

  // 最小二乘：斜率 = Σ(t−t̄)(y−ȳ) / Σ(t−t̄)²，t 以**天**为单位。
  const ts = samples.map((s) => (s.atMs - samples[0].atMs) / DAY_MS)
  const ys = samples.map((s) => s.dbBytes)
  const n = samples.length
  const tBar = ts.reduce((a, b) => a + b, 0) / n
  const yBar = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i += 1) {
    sxy += (ts[i] - tBar) * (ys[i] - yBar)
    sxx += (ts[i] - tBar) ** 2
  }
  // 所有样本同一时刻（`sxx === 0`）在排序去重后不该出现，但**不许**因此除零。
  if (sxx <= 0) return miss(GROWTH.INSUFFICIENT)
  const slope = sxy / sxx

  // ★ 最近一段的速率**单独报**：长期平均会把一次突发摊平。
  //   两个数一起给，运维才能看出"是不是有人在猛灌"。
  const recent = samples.slice(-2)
  const recentSpanMs = recent[1].atMs - recent[0].atMs
  const recentBytesPerDay = recentSpanMs > 0
    ? (recent[1].dbBytes - recent[0].dbBytes) / (recentSpanMs / DAY_MS)
    : null

  const confidence = spanMs >= HIGH_CONFIDENCE_SPAN_MS ? 'high'
    : spanMs >= MEDIUM_CONFIDENCE_SPAN_MS ? 'medium' : 'low'
  return {
    ok: true,
    // ★ `miss` 那条路报了它，这条路**也必须报** —— 否则调用方拿到的
    //   字段随结论变（`undefined` 与"0 岁"读起来一样，但意思不同）。
    sampleAgeMs: ageMs,
    // ★ `slope <= 0` 是**不是"在长"**，不是"不增长"到 0 —— 库真的会变小
    //   （`VACUUM`、删除会话）。回一个负数让调用方自己判断，别在这里夹到 0：
    //   夹到 0 会把"库在缩"说成"库没长"，那两件事的运维含义不同。
    reason: slope > 0 ? GROWTH.GROWING : GROWTH.NOT_GROWING,
    bytesPerDay: slope,
    recentBytesPerDay,
    spanMs,
    sampleCount: n,
    confidence,
    firstDbBytes: samples[0].dbBytes,
    lastDbBytes: samples[samples.length - 1].dbBytes,
    walBytes: num(input?.walBytes),
  }
}

const MiB = 1024 * 1024

/**
 * 照这个速度，什么时候到危险线？
 *
 * ★ 两种口径都算（见文件头 ③）：
 *   · `daysNaive`   —— `(free − 门槛) / r`（把门槛当成不动的）
 *   · `daysEffective` —— 门槛随库一起长时的真实合拢速度 `3r`（当 `2×库 > 256MiB`）
 *
 * 两个都给，是因为它们的差别**只在库大了之后**才显现 ——
 * 而那正是这个函数会被用到的时候。
 *
 * @returns {{ok: boolean, reason: string, daysNaive: number|null, daysEffective: number|null,
 *            alreadyCritical: boolean, closerOf: 'naive'|'effective'|null,
 *            headroomBytes: number|null, thresholdBytes: number|null,
 *            regime: 'constant'|'scaling'|null, base: object}}
 */
export function projectCritical(input, {
  freeBytes, dbBytes, minSamples = MIN_SAMPLES, minSpanMs = MIN_SPAN_MS,
  // ★ 时间相关的两个参数必须**透下去**：第一版漏了它们，于是
  //   "陈旧样本"那道守卫在投影这一层被静默绕过 ——
  //   端点仍然会报出一个从三天前样本算出来的"还有 N 天"。
  nowMs = Date.now(), maxSampleAgeMs = MAX_SAMPLE_AGE_MS,
  criticalFloorBytes = 256 * MiB, headroomFactor = 2,
} = {}) {
  const base = growthRate(input, { minSamples, minSpanMs, nowMs, maxSampleAgeMs })
  const free = num(freeBytes)
  const db = num(dbBytes) ?? base.lastDbBytes
  const miss = (reason) => ({
    ok: false,
    reason,
    daysNaive: null,
    daysEffective: null,
    alreadyCritical: false,
    closerOf: null,
    headroomBytes: null,
    thresholdBytes: null,
    regime: null,
    base,
  })
  if (base.ok !== true) return miss(base.reason)
  if (free === null || db === null) return miss('no-free-space')
  // 门槛与 `storage-health.mjs` 的 `diskLevel` 同一条公式（含绝对下限）。
  const threshold = Math.max(criticalFloorBytes, headroomFactor * db)
  const headroom = free - threshold
  if (headroom <= 0) {
    return { ...miss('already-critical'), alreadyCritical: true, headroomBytes: headroom, thresholdBytes: threshold }
  }
  const r = base.bytesPerDay
  if (!(r > 0)) {
    return { ...miss(GROWTH.NOT_GROWING), headroomBytes: headroom, thresholdBytes: threshold }
  }
  // ★ 门槛随库增长 ⇒ 差距以 `r + headroomFactor·r` 合拢。
  const regime = headroomFactor * db > criticalFloorBytes ? 'scaling' : 'constant'
  const closingPerDay = regime === 'scaling' ? r * (1 + headroomFactor) : r
  const daysNaive = (free - threshold) / r
  const daysEffective = headroom / closingPerDay
  return {
    ok: true,
    reason: GROWTH.GROWING,
    daysNaive,
    daysEffective,
    alreadyCritical: false,
    closerOf: daysEffective < daysNaive ? 'effective' : 'naive',
    headroomBytes: headroom,
    thresholdBytes: threshold,
    regime,
    base,
  }
}

/**
 * 给运维看的一句话。**键 + 变量**，并同时给渲染好的 `text`。
 *
 * ★ 与 `storage-state.mjs` 同一条规矩：`key` 是给 i18n 的模板，
 *   `text` 是给人直接读的 —— 只有 `key` 会被原样打印成 `{rate}`。
 */
export function growthSummary(projection, input, opts) {
  const p = projection ?? projectCritical(input, opts)
  const b = p.base ?? {}
  const human = (bytes) => {
    if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return null
    const v = Math.abs(Number(bytes))
    if (v >= 1024 * MiB) return `${(Number(bytes) / (1024 * MiB)).toFixed(2)} GiB`
    if (v >= MiB) return `${(Number(bytes) / MiB).toFixed(1)} MiB`
    return `${Math.round(Number(bytes))} B`
  }
  const days = (d) => {
    if (d === null || !Number.isFinite(d)) return null
    if (d < 1) return '不到 1 天'
    if (d < 60) return `${Math.round(d)} 天`
    if (d < 365) return `${(d / 30).toFixed(1)} 个月`
    return `${(d / 365).toFixed(1)} 年`
  }
  const s = (key, vars) => ({ key, vars, text: renderVars(key, vars) })
  if (p.alreadyCritical === true) {
    return s('库的余量**已经在危险线以下** —— 备份已经做不成了。先清空间，再谈趋势。', {})
  }
  if (p.ok !== true) {
    if (p.reason === GROWTH.NOT_GROWING) {
      const rate = human(b.bytesPerDay) ?? '0 B'
      // ★ "在缩"与"没长"分开说：库真的会变小（VACUUM、删会话），
      //   而那是一件**值得知道**的事（有人清理过），与"一直没动"不同。
      if (Number(b.bytesPerDay) < 0) {
        return s('库**在缩小**（最近 {span} 的拟合是 {rate}/天）—— 有人清理过，或者删了东西。', { span: spanText(b.spanMs), rate })
      }
      return s('库没有在增长（最近 {span} 的拟合是 {rate}/天）—— 照这个趋势算不出到期时间。',
        { span: spanText(b.spanMs), rate })
    }
    // ★ `stale-samples` 与 `insufficient` **分开说**：前者是"定时器停了"
    //   （去查它），后者是"还没测够"（去等它）。动作不同。
    if (p.reason === GROWTH.STALE_SAMPLES) {
      return s('**给不出现在的趋势**：最新样本是 {age}前的，而一条几小时前就断掉的曲线'
        + '只能说明**当时**在长多快。去看看定时器为什么没跑。',
      { age: spanText(b.sampleAgeMs) })
    }
    // ★ `insufficient` 要说清**缺什么**，而不是只说"数据不够"。
    const needSpan = spanText(opts?.minSpanMs ?? MIN_SPAN_MS)
    const needN = opts?.minSamples ?? MIN_SAMPLES
    return s('趋势还**算不出来**：目前只有 {n} 个样本、跨 {span}（需要至少 {needN} 个、跨 {needSpan}）。'
      + '这不是"没问题"，是"还看不出来"。',
    { n: String(b.sampleCount ?? 0), span: spanText(b.spanMs), needN: String(needN), needSpan: needSpan })
  }
  const rate = human(b.bytesPerDay)
  const eff = days(p.daysEffective)
  const naive = days(p.daysNaive)
  // ★ 两种口径都报（见文件头 ③）—— 库小的时候它们是同一个数。
  if (p.regime === 'scaling') {
    return s('库以 {rate}/天在长（置信度 {conf}，跨 {span}）。'
      + '因为备份门槛也跟着长（2×主库），差距以 3 倍速度合拢：'
      + '**约 {eff}** 到危险线（若门槛不动则是 {naive}）。',
    { rate: rate ?? '?', conf: String(b.confidence), span: spanText(b.spanMs), eff: eff ?? '?', naive: naive ?? '?' })
  }
  return s('库以 {rate}/天在长（置信度 {conf}，跨 {span}）。约 **{eff}** 到危险线。',
    { rate: rate ?? '?', conf: String(b.confidence), span: spanText(b.spanMs), eff: eff ?? '?' })
}

function spanText(ms) {
  const v = num(ms)
  if (v === null || v <= 0) return '(不足)'
  const h = v / 3600000
  if (h < 1) return `${Math.round(v / 60000)} 分钟`
  if (h < 48) return `${Math.round(h)} 小时`
  return `${(h / 24).toFixed(1)} 天`
}

/**
 * 把 `{name}` 占位符替换成 `vars` 里的值。
 *
 * ★ 导出它是为了**可测**：`storage-state.mjs` 的 `renderSummary` 有直接判据，
 *   而这一份没有 —— 破坏性验证当场试出"把缺变量渲染成 `undefined`"时
 *   **没有判据变红**（因为每一句说法都恰好把变量给全了）。
 *
 *   > 一段"永远拿得到变量"的代码路径，与一段"不会渲染错"的代码路径，
 *   > 在判据上长得一模一样。
 *
 * ★ 缺变量时**原样留占位符**（与 `storage-state.mjs` 同一条规矩）：
 *   留一个看得见的 `{rate}` 比印一个 `undefined` 好查。
 */
export function renderVars(key, vars = {}) {
  // ★ 非字符串一律回空串。`String(null)` 是 **"null"**、`String(42)` 是 "42" ——
  //   于是"没给键"会被渲染成一句话里的 `null`，而那看起来像**数据**坏了，
  //   而不是"模板没填"。`storage-state.mjs` 的 `renderSummary` 一直有这个守卫；
  //   这一份漏了，而且**没有任何判据能发现**（所有调用方都传字符串）。
  //
  //   > 一段"所有调用方都传字符串"的代码，与一段"守着非字符串"的代码，
  //   > 在判据上长得一模一样 —— 直到有一个调用方不是。
  const src = typeof key === 'string' ? key : ''
  return src.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const v = vars?.[name]
    return v === undefined || v === null ? whole : String(v)
  })
}

/** 给机器读的完整一块（端点用）。 */
export function growthReport(input) {
  // ★ 参数**不许**写成解构默认值（`{ samples } = {}`）：默认值只在实参是
  //   `undefined` 时生效，传 `null` 会直接抛 `Cannot destructure property …`。
  //   这条在上一轮的 `storageReport` 上已经踩过一次，这是第二次。
  const src = (input === null || typeof input !== 'object') ? {} : input
  const opts = { freeBytes: src.freeBytes, dbBytes: src.dbBytes, nowMs: num(src.nowMs) ?? Date.now() }
  const projection = projectCritical({ samples: src.samples, walBytes: src.walBytes }, opts)
  const summary = growthSummary(projection, { samples: src.samples, walBytes: src.walBytes }, opts)
  return {
    reason: projection.reason,
    bytesPerDay: projection.base?.bytesPerDay ?? null,
    recentBytesPerDay: projection.base?.recentBytesPerDay ?? null,
    daysNaive: projection.daysNaive,
    daysEffective: projection.daysEffective,
    alreadyCritical: projection.alreadyCritical,
    regime: projection.regime,
    confidence: projection.base?.confidence ?? 'none',
    spanMs: projection.base?.spanMs ?? null,
    sampleAgeMs: projection.base?.sampleAgeMs ?? null,
    sampleCount: projection.base?.sampleCount ?? 0,
    walBytes: num(src.walBytes),
    summary,
  }
}

// product/metrics-source.mjs
// ============================================================================
// 仪表盘的**生产数据源**（PRT-712 的后半 / spec §6.6）
//
// ## 这个模块存在的理由
//
// `product/metrics.mjs` 把九个指标的口径、未知档、比率与"不适用"都做全了
// （34 例断言），`readMetrics(source)` 也早就留好了注入点——
// 而它的 `source` **从来只有测试传过**。
//
//   > 一个「口径完整但没人喂它数」的仪表盘，
//   > 与一个什么都不显示的仪表盘，是同一个东西——
//   > 只不过前者有一份写得非常仔细的指标定义。
//
// 本模块就是那个"喂数"的人。它逐个指标回答同一个问题：
// **这个数从哪来？** 答不出来的，就**明说答不出来**，而不是填 0。
//
// ## 两条纪律
//
// ① **零与"没有"不是同一个东西。**
//    队列为空时"最老待办年龄"是 `0` 还是"不适用"——`metrics.mjs` 已经用
//    `notApplicableWhen` 定死为后者；本模块的职责是不去破坏它：
//    取不到就返回 `null`（→ `metric-no-data`），**绝不返回 0 兜底**。
//
//   > 一个把"读不出来"填成 0 的仪表盘，
//   > 与一个把火灾报成绿灯的仪表盘，是同一个东西。
//
// ② **没有生产者是一个事实，必须说出来。**
//    九个指标里有两个（`runtime-availability`、`model-error-rate`）今天
//    **没有任何东西在记录它们需要的原始数据**。让它们"静静地不出现"
//    与"显示一个 —"看起来一样，但前者会让下次有人真的需要它时
//    以为是自己配置错了。故 `createMetricsSource()` 一并返回 `missing`，
//    逐个点名缺的是哪个生产者。
// ============================================================================

import { upgradeResultMetric } from './upgrade/audit.mjs'

/** 产品指标键 → 运行库计数（`metricsCounts()` 的字段）的对应关系。**只此一处。** */
const RUN_STORE_METRICS = Object.freeze({
  'queue-depth': 'queueDepth',
  'oldest-pending-age-ms': 'oldestPendingAgeMs',
  'active-leases': 'activeLeases',
  'lease-expiry-rate': null,      // 比率：两个计数合成，见下
  'attempt-retry-rate': null,     // 同上
  'dead-letter-count': 'deadLetterCount',
})

/**
 * 由运行库的计数算出**比率类**指标的分子/分母。
 *
 * `metrics.mjs` 的比率定义是 `ratioOf: [分子, 分母]`，两个数**都由这里给**。
 * 只给一个（或让缺失的那个悄悄变成 undefined）会得到一个没有含义的百分比，
 * 所以两个都取不到时，两个都返回 `null`——比率层会如实报"还算不出来"。
 */
function ratiosOf(counts) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    leasesExpired: n(counts.leasesExpired),
    leasesTotal: n(counts.leasesTotal),
    attemptsRetried: n(counts.attemptsRetried),
    attemptsTotal: n(counts.attemptsTotal),
  }
}

/**
 * 运行库 → 指标读数点。
 *
 * @param {{metricsCounts: Function}} store 运行库（`team-hub/run-store.mjs` 的 `createRunStore`）
 * @param {{scope?: string|null}} options
 */
export function sourceFromRunStore(store, { scope = null } = {}) {
  if (store === null || typeof store?.metricsCounts !== 'function') {
    throw new TypeError('sourceFromRunStore 需要一个提供 metricsCounts() 的运行库：'
      + '读不到库时**不能**返回一组恒 0 的读数点——那会让仪表盘在库挂掉时显示"一切正常"')
  }
  return {
    // 每次读数现查：仪表盘要的是**此刻**的队列，缓存过的队列深度会让人
    // 在任务堆积时看到一个漂亮的旧数字。
    'queue-depth': () => store.metricsCounts({ scope }).queueDepth,
    'oldest-pending-age-ms': () => store.metricsCounts({ scope }).oldestPendingAgeMs,
    'active-leases': () => store.metricsCounts({ scope }).activeLeases,
    'dead-letter-count': () => store.metricsCounts({ scope }).deadLetterCount,
    'lease-expiry-rate': () => ratiosOf(store.metricsCounts({ scope })).leasesExpired,
    'attempt-retry-rate': () => ratiosOf(store.metricsCounts({ scope })).attemptsRetried,
  }
}

/**
 * 比率指标需要**两个**读数点，`readMetrics` 的 `source` 是按名字取值的，
 * 所以分子分母各占一个名字。名字与 `METRIC_DEFS[...].ratioOf` 逐字一致。
 */
export function ratioReadersFromRunStore(store, { scope = null } = {}) {
  if (store === null || typeof store?.metricsCounts !== 'function') {
    throw new TypeError('ratioReadersFromRunStore 需要一个提供 metricsCounts() 的运行库')
  }
  return {
    leasesExpired: () => ratiosOf(store.metricsCounts({ scope })).leasesExpired,
    leasesTotal: () => ratiosOf(store.metricsCounts({ scope })).leasesTotal,
    attemptsRetried: () => ratiosOf(store.metricsCounts({ scope })).attemptsRetried,
    attemptsTotal: () => ratiosOf(store.metricsCounts({ scope })).attemptsTotal,
  }
}

/**
 * ★ `upgrade-result` 的两个词表对不上，这里做**唯一**一次换算。
 *
 * `product/upgrade/audit.mjs` 的 `upgradeResultMetric()` 在"一条升级记录都没有"时
 * 返回 `'not-started'`；而 `METRIC_DEFS['upgrade-result'].allowed` 里那个词是
 * `'never-run'`。两边单独看都是对的，接起来就错：
 *
 * ```
 * computeMetrics({ 'upgrade-result': 'not-started' })
 *   → { known: false, value: null, reason: 'metric-no-data' }
 * ```
 *
 * 也就是说，**一台从未升级过的新装机器，仪表盘上"升级结果"会永远显示"—"**，
 * 而"从来没升过级"其实是一个**确定**的事实，不是"读不出来"。
 *
 *   > 一个把"从来没有升过级"显示成"读不出来"的仪表盘，
 *   > 与一个什么都没显示的仪表盘，是同一个东西——
 *   > 只不过前者看起来像是一个暂时的故障，于是没人会去查。
 *
 * 两张词表各自都有理由，所以不改任何一边，只在**它们相遇的地方**换算，
 * 并把这个事实写在这里——下一个人搜 `not-started` 能搜到这段。
 */
export const UPGRADE_RESULT_VOCABULARY = Object.freeze({ 'not-started': 'never-run' })

/** 把升级审计的结论换成指标层认识的词。认不出的词**原样返回**（让指标层报不合法，而不是编一个）。 */
export function normalizeUpgradeResult(result) {
  return Object.prototype.hasOwnProperty.call(UPGRADE_RESULT_VOCABULARY, result)
    ? UPGRADE_RESULT_VOCABULARY[result]
    : result
}

/**
 * 升级审计目录 → `upgrade-result` 读数点。
 *
 * @param {object} deps
 * @param {(dir: string) => Array} deps.listRecords 读审计记录（默认 `listUpgradeRecords`）
 */
export function sourceFromUpgradeAudit({ auditDir = null, listRecords = null } = {}) {
  return {
    'upgrade-result': () => {
      if (auditDir === null || auditDir === undefined) return null
      const records = typeof listRecords === 'function' ? listRecords(auditDir) : []
      const m = upgradeResultMetric(records ?? [])
      return normalizeUpgradeResult(m.result)
    },
  }
}

/**
 * 把九个指标的数据源组装起来。
 *
 * 返回 `{ source, missing }`：
 *   · `source` 交给 `readMetrics(source)`；
 *   · `missing` 逐个点名**今天没有生产者**的指标与原因。
 *
 * 为什么 `missing` 要单独返回，而不是让那几个键干脆不出现在 `source` 里：
 * 两种做法在界面上都表现为"—"，但把它们**点名列出来**之后，
 * "这个指标是坏的"与"这个指标还没有人来喂"就能被区分开。
 */
export function createMetricsSource({ store = null, auditDir = null, listRecords = null, scope = null } = {}) {
  const source = {}
  const missing = []

  if (store !== null && store !== undefined) {
    Object.assign(source, sourceFromRunStore(store, { scope }))
    Object.assign(source, ratioReadersFromRunStore(store, { scope }))
  } else {
    // 没有库时**不装**那六个读数点：装了但恒返回 0 的读数点，
    // 会让"库连不上"在仪表盘上表现为"队列是空的、没有死信"。
    for (const key of Object.keys(RUN_STORE_METRICS)) {
      missing.push(Object.freeze({
        key, reason: '没有可用的运行库（team-hub run-store）：读不到队列、租约与死信',
      }))
    }
  }

  if (auditDir !== null && auditDir !== undefined) {
    Object.assign(source, sourceFromUpgradeAudit({ auditDir, listRecords }))
  } else {
    missing.push(Object.freeze({
      key: 'upgrade-result',
      reason: '没有给升级审计目录：读不到"上一次升级是什么结果"',
    }))
  }

  // ── 这两个今天**没有生产者**，是事实，不是配置问题 ──
  missing.push(Object.freeze({
    key: 'runtime-availability',
    reason: '没有任何东西在记录"Runtime 处于可用状态"的时间：'
      + '`product/runtime-state.mjs` 会算出**此刻**的状态，但没有一份"窗口内 up/observed 时长"的记录。'
      + '要喂它需要先有一个状态观测记录器（并确定窗口多长）。',
  }))
  missing.push(Object.freeze({
    key: 'model-error-rate',
    reason: '没有任何东西在记录模型调用的成功/失败次数：'
      + '执行引擎与预算闸门都不落这份账。要喂它需要先有一次模型调用的计数留痕。',
  }))

  return Object.freeze({
    source: Object.freeze(source),
    missing: Object.freeze(missing),
    /** 有多少个指标今天拿不到数（含"没配库"这种本可避免的）。 */
    missingCount: missing.length,
  })
}

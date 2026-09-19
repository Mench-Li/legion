// product/metrics-spec7.mjs
// ============================================================================
// 目标文档 **§7「测试与指标」第 6 条** 那六个「持续观察」指标的落地。
//
//   > 持续观察事件遗漏/重复率、Run 恢复率、审批等待与拒绝率、预算超限率、
//   > 升级回滚成功率和商业 Alpha 交付周期。
//
// ---------------------------------------------------------------------------
// ## 为什么**不**并进 `product/metrics.mjs` 那九格里
//
// 那九格是 spec §6.6 的指标，**顺序被用例逐字钉住**，而且它们的聚合摘要
// （`metricsSummary()`）是**远程心跳（PRT-713）的载荷**——那份载荷走的是
// **允许名单**，加一个键就是加一次数据外流。
//
// §7 这六个是**运营读数**（事件漏投、审批等待、预算超限），它们该不该出机器
// 是一个**独立的产品决定**，不该由"往仪表盘加一格"顺手做掉。
//
//   > 一次"顺手往心跳里多带一格"的改动，与一次"决定把运营读数发到远端"的改动，
//   > 在 diff 上长得一模一样——只不过后者本来该有人点头。
//
// 所以本模块是**第二张表**，但**不是第二套纪律**：`METRIC_CODES` / `METRIC_KINDS`
// 直接从 `metrics.mjs` 引入，未知档的形状（`value: null` + `reason` + `reasonText`）
// 与它逐字相同，并有一条**跨模块一致性用例**钉住"两边不许漂"。
//
// ## 三条纪律（与 §6.6 那张表逐条相同）
//
// ① **零与"没有"不是同一个东西**：取不到就 `null` → `metric-no-data`，**绝不填 0**。
// ② **比值的分母为 0 是"还没有观察过"，不是"零失败"** → `metric-no-observations`。
// ③ **没有生产者是一个事实，必须点名列出来**——让一格"静静地不出现"，
//    与"显示一个 —"，在界面上一样，但前者会让下一个人以为是自己配错了。
// ============================================================================

import { METRIC_CODES, METRIC_KINDS } from './metrics.mjs'

/**
 * §7 第 6 条那**六个要求**的逐字文本 + 每个要求由哪几格指标服务。
 *
 * ★ `text` 与目标文档 `:271` 那一行**逐字同头**——它是锚，正文改字而这里不改 ⇒ 用例红。
 * ★ 六个要求必须**每一个**至少有一格指标（`requirementOf()` 那条 R1）。
 */
export const SPEC7_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: 'event-loss-duplicate',
    text: '事件遗漏/重复率',
    metrics: Object.freeze(['event-loss-rate', 'event-duplicate-rate']),
  }),
  Object.freeze({
    key: 'run-recovery',
    text: 'Run 恢复率',
    metrics: Object.freeze(['run-recovery-rate']),
  }),
  Object.freeze({
    key: 'approval-wait-denial',
    text: '审批等待与拒绝率',
    metrics: Object.freeze(['approval-wait-ms', 'approval-denial-rate']),
  }),
  Object.freeze({
    key: 'budget-overrun',
    text: '预算超限率',
    metrics: Object.freeze(['budget-overrun-rate']),
  }),
  Object.freeze({
    key: 'upgrade-rollback',
    text: '升级回滚成功率',
    metrics: Object.freeze(['upgrade-rollback-success-rate']),
  }),
  Object.freeze({
    key: 'alpha-cycle',
    text: '商业 Alpha 交付周期',
    metrics: Object.freeze(['alpha-cycle-days']),
  }),
])

/**
 * 八格指标的定义。每一格都写上它服务 §7 的**哪一个**要求（`requirement`），
 * 于是"六条要求一条都不许没人管"可以机械核对。
 *
 * `ratioOf: [分子, 分母]` 指名的两个字段都由**生产者**给（生产者做聚合 SQL），
 * 本模块只负责算比率与判"算不算得出来"——与 §6.6 那张表分工相同。
 */
export const SPEC7_METRIC_DEFS = Object.freeze({
  // ── §7 第 6 条的第 1 个要求：事件遗漏/重复率 ──
  'event-loss-rate': Object.freeze({
    key: 'event-loss-rate', spec: '§7', requirement: 'event-loss-duplicate',
    kind: METRIC_KINDS.RATIO, unit: '%',
    label: '事件漏投率',
    hint: '投递结果不明的帧 / 已到达终态的帧。`unknown` 档的含义是"上一次到底到了没有"无法回答——'
      + '它**不是**可重试的，因为重试它得先做对账。',
    ratioOf: ['eventsUnknown', 'eventsTerminal'],
  }),
  'event-duplicate-rate': Object.freeze({
    key: 'event-duplicate-rate', spec: '§7', requirement: 'event-loss-duplicate',
    kind: METRIC_KINDS.RATIO, unit: '%',
    label: '事件重复投递率',
    hint: '重投过才送达的帧 / 已送达的帧。投递是 at-least-once，所以"重投过"是**正常**的；'
      + '要盯的是它**在涨**——涨说明有东西在反复断。',
    ratioOf: ['eventsRetryDelivered', 'eventsDelivered'],
  }),

  // ── 第 2 个要求：Run 恢复率 ──
  'run-recovery-rate': Object.freeze({
    key: 'run-recovery-rate', spec: '§7', requirement: 'run-recovery',
    kind: METRIC_KINDS.RATIO, unit: '%',
    label: 'Run 恢复率',
    hint: '被中断后恢复起来的 Run / 被中断的 Run。分母为 0 表示**还没中断过**，'
      + '那是"还算不出来"，不是"恢复率 100%"。',
    ratioOf: ['runsRecovered', 'runsInterrupted'],
  }),

  // ── 第 3 个要求：审批等待与拒绝率 ──
  'approval-wait-ms': Object.freeze({
    key: 'approval-wait-ms', spec: '§7', requirement: 'approval-wait-denial',
    kind: METRIC_KINDS.GAUGE, unit: '毫秒',
    label: '审批等待中位数',
    hint: '已决审批从创建到判定耗时的一半位点。用中位数而不是均值：'
      + '一个卡了三天没批的审批会把均值拉到没有意义的量级。',
    // ★ 快照里的字段名与指标键**不一样**：这一格取的是生产者算好的中位数。
    //   少了这一行，`computeSpec7Metrics` 会去读 `snapshot['approval-wait-ms']`
    //   （永远是 undefined）⇒ 这一格**永远显示「—」**，而生产者明明喂了数。
    valueFrom: 'approvalWaitP50Ms',
    // 没有任何已决审批时**不适用**——显示 0 毫秒会让人以为"审批是秒过的"。
    // `dependsOn` 是必须一起判的：判据字段本身读不出来时，"适不适用"也无从判断。
    dependsOn: Object.freeze(['approvalsDecided']),
    notApplicableWhen: (s) => s.approvalsDecided === 0,
    notApplicableReason: 'no-decided-approvals',
  }),
  'approval-denial-rate': Object.freeze({
    key: 'approval-denial-rate', spec: '§7', requirement: 'approval-wait-denial',
    kind: METRIC_KINDS.RATIO, unit: '%',
    label: '审批拒绝率',
    hint: '被拒 + 越期作废 / 已决审批。越期作废算在"没有批准"这一侧：'
      + '一条等到过期的审批，与一条被拒的审批，对等它的人来说是同一件事。',
    ratioOf: ['approvalsDeniedOrExpired', 'approvalsDecided'],
  }),

  // ── 第 4 个要求：预算超限率 ──
  'budget-overrun-rate': Object.freeze({
    key: 'budget-overrun-rate', spec: '§7', requirement: 'budget-overrun',
    kind: METRIC_KINDS.RATIO, unit: '%',
    label: '预算超限率',
    hint: '被闸门拦下（超限）的次数 / 记账过的用量行数。'
      + '分母是**账目行数**而不是尝试数：一次尝试可能记多行。',
    ratioOf: ['budgetOverruns', 'budgetUsageRows'],
  }),

  // ── 第 5 个要求：升级回滚成功率 ──
  'upgrade-rollback-success-rate': Object.freeze({
    key: 'upgrade-rollback-success-rate', spec: '§7', requirement: 'upgrade-rollback',
    kind: METRIC_KINDS.RATIO, unit: '%',
    label: '升级回滚成功率',
    hint: '回滚到"已知兼容状态"且业务数据未丢的次数 / 需要回滚的次数。'
      + '★ 与 `upgrade-result`（§6.6 的 STATE 档）是两件事：那一格说**最近一次是什么结果**，'
      + '这一格说**历来回滚的成功比例**。',
    ratioOf: ['rollbacksSucceeded', 'rollbacksAttempted'],
  }),

  // ── 第 6 个要求：商业 Alpha 交付周期 ──
  'alpha-cycle-days': Object.freeze({
    key: 'alpha-cycle-days', spec: '§7', requirement: 'alpha-cycle',
    kind: METRIC_KINDS.GAUGE, unit: '天',
    label: '商业 Alpha 交付周期',
    hint: '从"安装/配置"到"产物验收/交接"走完整条链所用的天数。'
      + '★ 这一格今天**没有生产者**：它要的是**真实用户项目**上的端到端时长，'
      + '而本机没有任何真实用户项目（PRT-910 同样卡在这里）。'
      + '台账把这记成 ⏸，本模块把它记成"没有人喂它"——两种说法都必须说出来。',
  }),
})

/** §7 这八格的键，顺序即上面定义的顺序。 */
export const SPEC7_METRIC_KEYS = Object.freeze(Object.keys(SPEC7_METRIC_DEFS))

/** 一个要求 → 它名下的指标键。 */
export function metricsOfRequirement(requirementKey) {
  return SPEC7_REQUIREMENTS.find((r) => r.key === requirementKey)?.metrics ?? Object.freeze([])
}

// ── 未知档与已知档：形状与 `metrics.mjs` 逐字相同（有用例钉住"两边不许漂"）──

function unknown(def, reason, reasonText) {
  return Object.freeze({
    key: def.key, label: def.label, kind: def.kind, unit: def.unit,
    hint: def.hint, value: null, display: '—',
    known: false, reason, reasonText,
  })
}

function known(def, value, display) {
  return Object.freeze({
    key: def.key, label: def.label, kind: def.kind, unit: def.unit,
    hint: def.hint, value, display, known: true, reason: null, reasonText: null,
  })
}

/** 一个值能不能当读数用：必须是有限数。`null` / `NaN` / `Infinity` / 字符串都不行。 */
function isReading(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 一个值能不能当**分母**用：有限数且 **> 0**。0 是"还没观察过"，不是"零失败"。 */
function isDenominator(v) {
  return isReading(v) && v > 0
}

function formatGauge(def, v) {
  if (def.unit === '毫秒') return `${Math.round(v)} 毫秒`
  if (def.unit === '天') return `${v} 天`
  return String(v)
}

/** 保留一位小数——这是给人看的方向性读数，不是账目。 */
function formatRatio(v) {
  return `${(v * 100).toFixed(1)}%`
}

/**
 * **纯函数**：把一份已经读好的快照算成 §7 的八格。
 *
 * 算错了与读错了是两件事：生产者（SQL）负责读，这里只负责算。
 * 某个字段是 `null`/`undefined`/`NaN`/字符串 ⇒ 那一格**读不出来**，不是 0。
 */
export function computeSpec7Metrics(snapshot = {}) {
  const out = Object.create(null)
  for (const key of SPEC7_METRIC_KEYS) {
    const def = SPEC7_METRIC_DEFS[key]

    // ① 「不适用」优先于「读不出来」：队列(审批)为空时"等待中位数"不是一个读数，
    //    但那是**确定**的事实，不是故障。★ 它的判据字段本身读不出来时也得让位——
    //    见 §6.6 那张表 `dependsOn` 里记的那件事。
    if (typeof def.notApplicableWhen === 'function') {
      const gate = def.dependsOn ?? [ratioGateKey(def)]
      const gateKnown = gate.every((k) => isReading(snapshot[k]))
      if (gateKnown && def.notApplicableWhen(snapshot)) {
        out[key] = unknown(def, METRIC_CODES.NOT_APPLICABLE,
          def.notApplicableReason ?? 'not-applicable-now')
        continue
      }
    }

    if (def.kind === METRIC_KINDS.RATIO) {
      const [numKey, denKey] = def.ratioOf
      const num = snapshot[numKey]
      const den = snapshot[denKey]
      if (!isReading(num) || !isReading(den)) {
        out[key] = unknown(def, METRIC_CODES.NO_DATA,
          `分子(${numKey})或分母(${denKey})读不出来`)
        continue
      }
      // ② 分母为 0 ⇒ "还没有观察过"，**不是** 0%
      if (!isDenominator(den)) {
        out[key] = unknown(def, METRIC_CODES.NO_OBSERVATIONS,
          `分母(${denKey})为 0：还没有观察过，不是"零失败"`)
        continue
      }
      const v = num / den
      out[key] = known(def, v, formatRatio(v))
      continue
    }

    // GAUGE / COUNTER / STATE
    // ★ `valueFrom` 允许快照里的字段名与指标键不同（如 `approval-wait-ms`
    //   取 `approvalWaitP50Ms`）。没有它就去读自己的键，永远 undefined。
    const srcKey = def.valueFrom ?? key
    const raw = snapshot[srcKey]
    if (!isReading(raw)) {
      out[key] = unknown(def, METRIC_CODES.NO_DATA, `${srcKey} 读不出来（不是 0）`)
      continue
    }
    out[key] = known(def, raw, formatGauge(def, raw))
  }
  return Object.freeze(out)
}

/** 一个指标的不适用判据取决于哪个字段：比率看分母，其余看自己。 */
function ratioGateKey(def) {
  return def.kind === METRIC_KINDS.RATIO ? def.ratioOf[1] : def.key
}

/**
 * 渲染成给人看的文本行。未知一律是「—」加一句为什么，**绝不**是 0。
 */
export function renderSpec7Metrics(computed) {
  return Object.freeze(SPEC7_METRIC_KEYS.map((key) => {
    const m = computed[key]
    return m.known === true ? `${m.label}：${m.display}` : `${m.label}：—（${m.reasonText}）`
  }))
}

/**
 * 概要：读不出来的有几格、按**为什么读不出来**分组。
 *
 * ★ 这一格是给"仪表盘到底坏没坏"这个问题用的：`no-data` 与 `not-applicable`
 *   都表现为「—」，但前者要人去查，后者什么都不用做。
 */
export function spec7Summary(computed) {
  const byReason = Object.create(null)
  let knownCount = 0
  for (const key of SPEC7_METRIC_KEYS) {
    const m = computed[key]
    if (m.known === true) { knownCount += 1; continue }
    byReason[m.reason] = (byReason[m.reason] ?? 0) + 1
  }
  return Object.freeze({
    totalMetrics: SPEC7_METRIC_KEYS.length,
    knownMetrics: knownCount,
    unknownMetrics: SPEC7_METRIC_KEYS.length - knownCount,
    byReason: Object.freeze(byReason),
  })
}

// ============================================================================
// PRT-712 最小系统指标：本地展示队列 / lease / 重试 / 死信 / 可用率
//
// spec §6.6 列了九个指标：
//
//   队列深度、最老待办年龄、活跃 lease、租约过期率、Attempt 重试率、
//   Dead Letter 数量、Runtime 可用率、模型错误率、升级结果
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **「读不出来」不许显示成 0。**
//
// 一个仪表盘把读不到的指标画成 0，与一个把"着火了"画成绿色的仪表盘，
// 在"值班的人会不会去看一眼"上是同一个东西——而且前者更糟：
// 它看起来是**有读数**的，所以没人会去怀疑它。
//
//   > 一个把"我没有数据"渲染成 0 的仪表盘，
//   > 与一个把"一切正常"渲染成 0 的仪表盘，
//   > 在"值班的人能不能看出出事了"上是同一个东西。
//
// 所以每个指标有**三种**结果，不是两种：
//
//   · `value`  —— 有读数（包括**真的**是 0）
//   · `null`   —— 读不出来（附 `reason`），渲染成「—」并说明为什么
//   · `null` + `reason: 'queue-empty'` 等 —— 这个指标此刻**不适用**
//
// 「队列深度 0」与「队列深度读不出来」在数据结构上就是两个不同的东西，
// 渲染层没有机会把它们混起来。
//
// 还有一个同源的陷阱：**比值的分母为 0**。
//
//   0 次失败 / 0 次尝试 = ?   如果填 0%，那说的是"没有失败"；
//                             而事实是"还没有观察过"。
//
// 这正是"上线第一天，错误率 0%，一切正常"这句话的来历。比值的分母为 0
// 一律返回 `null`（reason `no-observations`），不返回 0。
// ============================================================================

/** 指标的三种"读不出来"的原因码。它们会出现在界面文案里。 */
export const METRIC_CODES = Object.freeze({
  /** 读数不是有限数（null / NaN / Infinity / 类型不对）。 */
  NO_DATA: 'metric-no-data',
  /** 采集那一侧抛了错。**与"没有数据"分开**：一个是坏了，一个是空的。 */
  READ_FAILED: 'metric-read-failed',
  /** 指标此刻不适用（比如队列为空时的"最老待办年龄"）。 */
  NOT_APPLICABLE: 'metric-not-applicable',
  /** 比值的分母为 0：还没有观察过，不是"没有失败"。 */
  NO_OBSERVATIONS: 'metric-no-observations',
  /** 时间窗不合法（负数 / 非整数）。 */
  BAD_WINDOW: 'metric-bad-window',
})

/** 指标的种类。`state` 是**类别值**（升级结果），不是数。 */
export const METRIC_KINDS = Object.freeze({
  GAUGE: 'gauge',
  RATIO: 'ratio',
  COUNTER: 'counter',
  STATE: 'state',
})

/**
 * 九个指标的定义。**顺序即 spec §6.6 的顺序**，有用例钉住。
 *
 * `unit` 是**给用户看的单位**；`null` 表示这是一个不适用单位的类别值。
 */
export const METRIC_DEFS = Object.freeze({
  'queue-depth': Object.freeze({
    key: 'queue-depth', kind: METRIC_KINDS.GAUGE, unit: '个',
    label: '队列深度', hint: '等待被认领的任务数',
  }),
  'oldest-pending-age-ms': Object.freeze({
    key: 'oldest-pending-age-ms', kind: METRIC_KINDS.GAUGE, unit: '毫秒',
    label: '最老待办年龄', hint: '队列里最老的那个任务等了多久',
    // 队列为空时这个指标**不适用**——显示 0 秒会让人以为"刚有任务进来"。
    //
    // `dependsOn` 是**必须一起判的**：判据本身读的`queue-depth`如果是未知的，
    // 那"适不适用"也无从判断。少了它会出现这种情况——队列深度读不出来（未知），
    // 而"最老待办年龄"照样报 `0 毫秒`，意思是"有一个刚进来的任务"。
    // 一个读数不明时**替它编一个 0**，与一个把火灾报成绿灯的仪表盘是同一件事。
    dependsOn: ['queue-depth'],
    notApplicableWhen: (s) => s['queue-depth'] === 0,
    notApplicableReason: 'queue-empty',
  }),
  'active-leases': Object.freeze({
    key: 'active-leases', kind: METRIC_KINDS.GAUGE, unit: '个',
    label: '活跃 lease', hint: '当前被 worker 持有的租约数',
  }),
  'lease-expiry-rate': Object.freeze({
    key: 'lease-expiry-rate', kind: METRIC_KINDS.RATIO, unit: '%',
    label: '租约过期率', hint: '过期租约 / 全部租约。过期意味着任务被反复重领',
    ratioOf: ['leasesExpired', 'leasesTotal'],
  }),
  'attempt-retry-rate': Object.freeze({
    key: 'attempt-retry-rate', kind: METRIC_KINDS.RATIO, unit: '%',
    label: 'Attempt 重试率', hint: '重试过的 Attempt / 全部 Attempt',
    ratioOf: ['attemptsRetried', 'attemptsTotal'],
  }),
  'dead-letter-count': Object.freeze({
    key: 'dead-letter-count', kind: METRIC_KINDS.GAUGE, unit: '个',
    label: 'Dead Letter 数量', hint: '重试耗尽后需要人工处置的任务数',
  }),
  'runtime-availability': Object.freeze({
    key: 'runtime-availability', kind: METRIC_KINDS.RATIO, unit: '%',
    label: 'Runtime 可用率', hint: '窗口内 Runtime 处于可用状态的时间占比',
    ratioOf: ['upMs', 'observedMs'],
  }),
  'model-error-rate': Object.freeze({
    key: 'model-error-rate', kind: METRIC_KINDS.RATIO, unit: '%',
    label: '模型错误率', hint: '模型调用失败 / 全部模型调用',
    ratioOf: ['modelErrors', 'modelCalls'],
  }),
  'upgrade-result': Object.freeze({
    key: 'upgrade-result', kind: METRIC_KINDS.STATE, unit: null,
    label: '升级结果', hint: '上一次升级的结论',
    allowed: ['succeeded', 'failed', 'rolled-back', 'never-run'],
  }),
})

/** 全部指标键，顺序与 spec §6.6 逐字一致。 */
export const METRIC_KEYS = Object.freeze(Object.keys(METRIC_DEFS))

/**
 * 「读不出来」的那一档。与 `value` 分开是**结构上**分开的：
 * 调用方拿到的 `value` 要么是一个有限数/合法类别值，要么是 `null`，
 * 且 `null` 一定带 `reason` 与 `reasonText`。
 */
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

function formatGauge(def, v) {
  if (def.unit === '毫秒') return `${Math.round(v)} 毫秒`
  if (def.unit === '个') return `${v} 个`
  return String(v)
}

function formatRatio(v) {
  // 保留一位小数就够：这是给人看的方向性读数，不是账目。
  return `${(v * 100).toFixed(1)}%`
}

/**
 * **纯函数**：把一份已经读好的快照算成九个指标。
 *
 * 输入 `snapshot` 是一个普通对象。某个字段是 `null` / `undefined` / `NaN` /
 * 字符串 → 那个指标**读不出来**，不是 0。比值用 `ratioOf` 指名的两个字段算。
 *
 * 之所以拆成纯函数：算错了和读错了是两件事，混在一起就分不清该修哪一头。
 */
export function computeMetrics(snapshot = {}) {
  const out = Object.create(null)
  for (const key of METRIC_KEYS) {
    const def = METRIC_DEFS[key]
    out[key] = computeOne(def, snapshot)
  }
  return Object.freeze(out)
}

function computeOne(def, snapshot) {
  // ── 类别值（升级结果）──
  if (def.kind === METRIC_KINDS.STATE) {
    const v = snapshot[def.key]
    if (v === null || v === undefined) {
      return unknown(def, METRIC_CODES.NO_DATA, '还没有读到升级结果')
    }
    if (typeof v !== 'string' || !def.allowed.includes(v)) {
      // 一个没见过的类别值**不翻译**成最接近的那一个。
      // 「升级结果：成功」如果是猜出来的，值班的人会据此收工。
      return unknown(def, METRIC_CODES.NO_DATA,
        `升级结果不是一个已知取值（收到 ${JSON.stringify(v)}）`)
    }
    const TEXT = { succeeded: '成功', failed: '失败', 'rolled-back': '已回滚', 'never-run': '从未执行' }
    return known(def, v, TEXT[v] ?? v)
  }

  // ── 比值 ──
  if (def.kind === METRIC_KINDS.RATIO) {
    const [numKey, denKey] = def.ratioOf
    const num = snapshot[numKey]
    const den = snapshot[denKey]
    if (num === null || num === undefined || den === null || den === undefined) {
      return unknown(def, METRIC_CODES.NO_DATA,
        `缺读数：需要 ${numKey} 与 ${denKey}`)
    }
    if (!isReading(num) || !isReading(den)) {
      return unknown(def, METRIC_CODES.NO_DATA,
        `读数不是有限数：${numKey}=${JSON.stringify(num)}，${denKey}=${JSON.stringify(den)}`)
    }
    if (num < 0 || den < 0) {
      return unknown(def, METRIC_CODES.NO_DATA, `读数为负：${numKey}=${num}，${denKey}=${den}`)
    }
    if (num > den) {
      // 分子大于分母说明两个读数来自不同的时间窗或不同的口径。
      // 硬算出 >100% 会让人以为系统疯了；填成 100% 则是**替它编一个数**。
      return unknown(def, METRIC_CODES.READ_FAILED,
        `分子大于分母（${numKey}=${num} > ${denKey}=${den}）：两个读数可能不是同一口径`)
    }
    if (den === 0) {
      // ★ 这一条是本模块的核心之一。
      return unknown(def, METRIC_CODES.NO_OBSERVATIONS,
        '分母为 0：**还没有观察过**，不是"没有失败"')
    }
    return known(def, num / den, formatRatio(num / den))
  }

  // ── 计数 / 仪表 ──
  // 「此刻不适用」与"适不适用判不出来"都要在"有没有读数"**之前**判。
  //
  // 先判**判据本身读不读得出来**：判据依赖的字段是未知的，那"适不适用"
  // 就是个未知数。此时报读数（比如 0）等于替用户编了一个结论。
  if (Array.isArray(def.dependsOn)) {
    for (const dep of def.dependsOn) {
      if (isReading(snapshot[dep])) continue
      const depDef = METRIC_DEFS[dep]
      return unknown(def, METRIC_CODES.NO_DATA,
        `判据依赖的「${depDef?.label ?? dep}」读不出来，因此无法判断这个指标此刻适不适用`)
    }
  }
  // 判据读得出来，才轮到"适不适用"。
  if (typeof def.notApplicableWhen === 'function' && def.notApplicableWhen(snapshot) === true) {
    return unknown(def, METRIC_CODES.NOT_APPLICABLE,
      `${def.label}此刻不适用（${def.notApplicableReason}）`)
  }
  const v = snapshot[def.key]
  if (!isReading(v)) {
    return unknown(def, METRIC_CODES.NO_DATA,
      v === null || v === undefined ? '没有读到这个指标' : `读数不是有限数（收到 ${JSON.stringify(v)}）`)
  }
  if (v < 0) return unknown(def, METRIC_CODES.NO_DATA, `读数为负（${v}）`)
  return known(def, v, formatGauge(def, v))
}

/**
 * 异步读数：按名字调用 `source` 上的**读数点**，逐个容错。
 *
 * 一个读数点抛错，只让**那一个**指标变成"读不出来"，其余照常。
 * 一个坏掉的读数点不该让整个仪表盘消失——那会让值班的人连
 * "别的指标是好的"都看不到。
 *
 * 同时返回 `diagnostics`：读数点失败本身也要被看见，
 * 否则"某个指标一直是 —"会变成一件没人知道原因的事。
 */
export async function readMetrics(source = {}, { logger = null } = {}) {
  const snapshot = {}
  const diagnostics = []
  const readers = Object.keys(source)

  // 先把同步就可能抛错的取值统一走同一条路：任何取值失败都不中断别的。
  const readOne = async (name) => {
    const fn = source[name]
    try {
      const v = typeof fn === 'function' ? await fn() : fn
      snapshot[name] = v
      return v
    } catch (e) {
      snapshot[name] = null
      const d = Object.freeze({
        severity: 'warn', code: METRIC_CODES.READ_FAILED,
        message: `指标读数点「${name}」失败：${String(e?.message ?? e)}`,
        reader: name,
      })
      diagnostics.push(d)
      if (typeof logger === 'function') logger(`[metrics] ${d.message}`)
      return null
    }
  }

  // 并发读：九个读数点互不依赖，串行只会让仪表盘变慢。
  await Promise.all(readers.map(readOne))

  const metrics = computeMetrics(snapshot)
  // 「算出来是未知」也要有诊断，否则界面上一个「—」没有对应的解释。
  for (const key of METRIC_KEYS) {
    const m = metrics[key]
    if (m.known === true) continue
    if (m.reason === METRIC_CODES.READ_FAILED) continue // 上面已经报过
    // 「此刻不适用」是正常状态，不当成告警。
    if (m.reason === METRIC_CODES.NOT_APPLICABLE) continue
    diagnostics.push(Object.freeze({
      severity: 'warn', code: m.reason,
      message: `指标「${m.label}」读不出来：${m.reasonText}`, metric: key,
    }))
  }

  return Object.freeze({
    metrics,
    snapshot: Object.freeze({ ...snapshot }),
    diagnostics: Object.freeze(diagnostics),
    unknownCount: METRIC_KEYS.filter((k) => metrics[k].known !== true).length,
  })
}

/**
 * 渲染成给人看的文本行。**本地展示**（PRT-712 的"本地展示"就是它）。
 *
 * 未知一律是「—」加一句为什么，**绝不**是 0。
 */
export function renderMetrics(report) {
  const lines = []
  for (const key of METRIC_KEYS) {
    const m = report.metrics[key]
    lines.push(m.known === true
      ? `${m.label}：${m.display}`
      : `${m.label}：—（${m.reasonText}）`)
  }
  return Object.freeze(lines)
}

/**
 * 给心跳（PRT-713）用的**聚合**摘要。
 *
 * 只取数，不取标签、不取路径、不取任务名——一个"顺手带上上下文"的心跳
 * 是数据外流最省事的通道：不需要谁犯错，只需要它存在。
 *
 * 读不出来的指标**不进**摘要（而不是填 0）：远端收到一个 0 会把它当成
 * 真实读数，而这正是本模块通篇要防的那件事。
 */
export function metricsSummary(report) {
  const out = {}
  for (const key of METRIC_KEYS) {
    const m = report.metrics[key]
    if (m.known === true) out[key] = m.value
  }
  out.observedMetrics = Object.keys(out).length
  out.totalMetrics = METRIC_KEYS.length
  return Object.freeze(out)
}

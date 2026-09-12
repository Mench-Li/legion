// runtime/dsh-composition/release-gate.mjs
// ============================================================================
// PRT-614：新强制面完成前的 **legacy 高风险工具禁用** + **发布门禁**。
//
// spec line 936；§6.6 line 472；§5 line 64、121。
//
// ## 为什么"发布门禁"不能只是一个布尔
//
// spec line 472 的两句话在同一个句子里，而它们的关系才是重点：
//
//   无人值守模式下，要求人工审批的操作默认拒绝或保持等待，不自动降级为允许。
//   legacy 路径在完成 DSH 强制面接线前禁止高风险工具；
//   **"未批准高风险写操作为零"只在该门禁满足后成为发布指标。**
//
// 最后那半句是一个**关于指标本身的**断言。它在说：那个数字在门禁满足前
// 根本不是证据。理由很具体——
//
//   · 强制面没接线时，"未批准的高风险写"是**零**，因为没有一条高风险写
//     能走到审批那一步（数据库里根本没人在记 `decisionSource`）；
//   · 甚至更容易：既然 legacy 路径按本模块的规定**禁止**高风险工具，
//     那么"未批准的高风险写"当然是零——是**我们把它变成零的**。
//
// 于是会得到这样一个发布报表：数字是零，一切正常，而系统里一次高风险写都没被
// 真的管控过。
//
//   > 一个「报表上写着'未批准高风险写操作为零'」的发布门禁，
//   > 与一个「因为没有一条高风险写被真的试过、于是那个数字当然是零」的发布门禁，
//   > 是同一个东西——只不过前者看起来是一个通过的指标。
//
// 所以本模块**拒绝**在门禁不满足时给出一个通过的读数：它返回
// `metricValid: false` 与一句"这个数字还不是指标"，而不是 `0`。
//
// ## 为什么"零"还需要分母
//
// 即使门禁满足，"0 未批准 / 0 次尝试"仍然是空的。一个从没被尝试过的类别，
// 与一个被尝试且全部合规的类别，在报表上是同一个 `0`。
//
//   > 一个「0 次未批准」的读数，
//   > 与一个「0 次尝试」的读数，是同一个东西——只不过前者会被当成"很干净"。
//
// 所以成功读数要求 `attempted > 0`；没有尝试就报 `no-evidence`，
// 而不是报 `pass`。
// ============================================================================

import { RISK_RANK, UNKNOWN_TOOL_RISK, maxRisk } from './tool-capability.mjs'

/** 门禁自身的版本。改动判据时递增——否则历史报表无法解释。 */
export const RELEASE_GATE_VERSION = 'legion/release-gate@1'

/** 高风险的门槛：`>= high`。`critical` 当然也算。 */
export const HIGH_RISK_FLOOR = 'high'

/** 两条执行路径。spec line 121：开关**按安装生效**，不允许按任务自由切换。 */
export const EXECUTION_PATHS = Object.freeze(['legacy', 'product-runtime'])

export const GATE_CODES = Object.freeze({
  /** 组合补丁层未生效。 */
  PATCH_LAYER_INACTIVE: 'release-gate-patch-layer-inactive',
  /** 运行时版本/能力协商未过。 */
  RUNTIME_UNSUPPORTED: 'release-gate-runtime-unsupported',
  /** 沙箱只有 `partial` 级管制。 */
  SANDBOX_PARTIAL: 'release-gate-sandbox-partial',
  /** 权限语义到强制面的映射不自洽。 */
  MAPPING_INCONSISTENT: 'release-gate-mapping-inconsistent',
  /** 决定来源没有被真的记录进 `tool_calls`（spec line 480）。 */
  DECISION_SOURCE_UNRECORDED: 'release-gate-decision-source-unrecorded',
  /** legacy 路径上仍然存在可用的高风险工具。 */
  LEGACY_HIGH_RISK_REACHABLE: 'release-gate-legacy-high-risk-reachable',
  /** 两个调度器同时扫描同一空间（spec line 121 明令禁止）。 */
  DUAL_SCHEDULER: 'release-gate-dual-scheduler',
  /** 未知的执行路径。 */
  PATH_UNKNOWN: 'release-gate-path-unknown',
})

/** 全部就绪项。`evaluateReadiness` 会**逐项**报，而不是只报一个总布尔。 */
export const READINESS_ITEMS = Object.freeze([
  Object.freeze({
    id: 'patch-layer',
    code: GATE_CODES.PATCH_LAYER_INACTIVE,
    label: '组合补丁层生效',
    why: '补丁层未生效时 ToolGuard 硬底线、pre-execute 策略与审批应答者都不在，而配置看起来完全正常',
  }),
  Object.freeze({
    id: 'runtime',
    code: GATE_CODES.RUNTIME_UNSUPPORTED,
    label: '运行时版本受支持',
    why: '认不出的运行时上补丁层可能挂不上却没有任何报错',
  }),
  Object.freeze({
    id: 'sandbox',
    code: GATE_CODES.SANDBOX_PARTIAL,
    label: '沙箱 full 级管制',
    why: '`partial` 的字面意思是"存在不被管制的路径"',
  }),
  Object.freeze({
    id: 'mapping',
    code: GATE_CODES.MAPPING_INCONSISTENT,
    label: '权限语义映射自洽',
    why: '映射不自洽时"哪几条模式经过审批箱"不是你以为的那张表',
  }),
  Object.freeze({
    id: 'decision-source',
    code: GATE_CODES.DECISION_SOURCE_UNRECORDED,
    label: '决定来源被记录',
    why: 'spec line 480：`tool_calls` 必须记录决定来源，否则事后分不清策略拒绝与沙箱兜底拒绝',
  }),
  Object.freeze({
    id: 'legacy-high-risk',
    code: GATE_CODES.LEGACY_HIGH_RISK_REACHABLE,
    label: 'legacy 高风险工具已禁用',
    why: 'spec line 472：强制面接线完成前，legacy 路径禁用的正是这一批',
  }),
  Object.freeze({
    id: 'scheduler',
    code: GATE_CODES.DUAL_SCHEDULER,
    label: '唯一调度器',
    why: 'spec line 121：禁止让两个调度器同时扫描同一空间',
  }),
])

/** 高风险判定。**未知工具按 `critical`**（`UNKNOWN_TOOL_RISK`）——fail closed。 */
export function isHighRisk(risk) {
  const level = risk ?? UNKNOWN_TOOL_RISK
  const rank = RISK_RANK[level]
  if (rank === undefined) {
    // 认不出的等级按最高风险处理，而不是报错或当作低风险：
    // 这个函数的两个错误方向不对等——当作低风险是**放行**。
    return true
  }
  return rank >= RISK_RANK[HIGH_RISK_FLOOR]
}

/**
 * 就绪评估。
 *
 * @param {object} evidence
 * @param {object} [evidence.selfCheck] `startupSelfCheck` 的返回
 * @param {boolean} [evidence.decisionSourceRecorded] `tool_calls` 是否真的在记 `decisionSource`
 * @param {string} [evidence.path] `'legacy' | 'product-runtime'`
 * @param {string[]} [evidence.legacyHighRiskTools] legacy 路径上仍然可用的高风险工具名
 * @param {string[]} [evidence.schedulers] 正在扫描该空间的调度器名
 * @returns {{satisfied: boolean, version: string, path: string|null,
 *            items: Array<{id: string, ok: boolean, code: string|null, label: string, reasons: string[]}>,
 *            unsatisfied: string[], reasons: string[], legacyHighRiskTools: string[]}}
 */
export function evaluateReadiness(evidence = {}) {
  const path = evidence.path ?? null
  const items = []
  const problems = []

  const record = (id, ok, reasons = []) => {
    const spec = READINESS_ITEMS.find((x) => x.id === id)
    items.push(Object.freeze({
      id,
      ok,
      code: ok ? null : spec.code,
      label: spec.label,
      reasons: Object.freeze([...reasons]),
    }))
    if (!ok) problems.push(`${spec.code}: ${spec.label}${reasons.length ? `（${reasons.join('；')}）` : ''}`)
  }

  // ① 前四项直接来自启动自检的**逐项结论**，不重新判断一遍。
  //    重判一遍就等于把"两处对同一件事的判断"造出来——它们迟早不一样。
  const checks = evidence.selfCheck?.checks ?? null
  if (checks === null) {
    // 没有自检结果 ≠ 自检通过。四项全部按"未证明"处理。
    for (const id of ['patch-layer', 'runtime', 'sandbox', 'mapping']) {
      record(id, false, ['未提供启动自检结果——"没检查"不等于"检查通过"'])
    }
  } else {
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]))
    const pick = (name) => {
      const c = byName[name]
      return c ? { ok: c.ok === true, reasons: c.reasons ?? [] } : { ok: false, reasons: [`自检里没有 ${name} 这一项`] }
    }
    for (const [id, name] of [
      ['patch-layer', 'composition-patch-layer'],
      ['runtime', 'runtime-probe'],
      ['sandbox', 'sandbox-enforcement'],
      ['mapping', 'enforcement-mapping'],
    ]) {
      const r = pick(name)
      record(id, r.ok, r.reasons)
    }
  }

  // ② 决定来源有没有被真的记录。
  //    `undefined`（没人告诉我们）按**否**处理：这一项问的是"有没有证据"，
  //    而缺失的证据不是证据。
  record(
    'decision-source',
    evidence.decisionSourceRecorded === true,
    evidence.decisionSourceRecorded === true ? [] : ['没有证据表明 `tool_calls` 在记 `decisionSource`'],
  )

  // ③ legacy 路径上是否仍有高风险工具可用。空数组 = 已禁用。
  const legacyTools = Array.isArray(evidence.legacyHighRiskTools) ? evidence.legacyHighRiskTools : null
  record(
    'legacy-high-risk',
    legacyTools !== null && legacyTools.length === 0,
    legacyTools === null
      ? ['未提供 legacy 高风险工具清单——缺失的清单不是空清单']
      : legacyTools.length > 0 ? [`仍有 ${legacyTools.length} 个：${legacyTools.join(' / ')}`] : [],
  )

  // ④ 唯一调度器。0 个调度器也**不算**通过：没有调度器时"唯一"是空话。
  const schedulers = Array.isArray(evidence.schedulers) ? evidence.schedulers : null
  record(
    'scheduler',
    schedulers !== null && schedulers.length === 1,
    schedulers === null
      ? ['未提供调度器清单']
      : schedulers.length === 0 ? ['没有调度器——"唯一"不成立']
        : schedulers.length > 1 ? [`同时有 ${schedulers.length} 个：${schedulers.join(' / ')}`] : [],
  )

  if (path !== null && !EXECUTION_PATHS.includes(path)) {
    problems.push(`${GATE_CODES.PATH_UNKNOWN}: 未知执行路径 ${JSON.stringify(path)}（合法值：${EXECUTION_PATHS.join(' / ')}）`)
  }

  return Object.freeze({
    satisfied: problems.length === 0 && path !== null && EXECUTION_PATHS.includes(path),
    version: RELEASE_GATE_VERSION,
    path,
    items: Object.freeze(items),
    unsatisfied: Object.freeze(items.filter((i) => !i.ok).map((i) => i.id)),
    reasons: Object.freeze(problems),
    legacyHighRiskTools: Object.freeze(legacyTools ?? []),
  })
}

/**
 * legacy 路径上的高风险工具策略。
 *
 * spec line 472：**在完成 DSH 强制面接线前禁止高风险工具。**
 * 门禁满足后，高风险工具交给正常强制面（pre-execute + guard + approval），
 * 本函数不再额外禁止——否则会变成"永久禁用"，那不是 spec 要的。
 *
 * @param {object} args
 * @param {string} args.risk 工具的风险等级
 * @param {{satisfied: boolean}} args.gate
 * @param {string} args.path
 * @param {string} [args.toolName]
 * @returns {{allowed: boolean, decision: string, code: string|null, reason: string}}
 */
export function legacyHighRiskPolicy({ risk, gate, path, toolName = null }) {
  const high = isHighRisk(risk)
  if (path === 'product-runtime') {
    return Object.freeze({
      allowed: true,
      decision: 'enforced',
      code: null,
      reason: 'product-runtime 路径上高风险工具由强制面（pre-execute + guard + approval）决定，本策略不额外禁止',
    })
  }
  if (!EXECUTION_PATHS.includes(path)) {
    return Object.freeze({
      allowed: false,
      decision: 'deny',
      code: GATE_CODES.PATH_UNKNOWN,
      reason: `未知执行路径 ${JSON.stringify(path)}——按拒绝处理`,
    })
  }
  if (!high) {
    return Object.freeze({ allowed: true, decision: 'enforced', code: null, reason: `risk=${risk ?? 'unknown'} 不是高风险` })
  }
  if (gate?.satisfied !== true) {
    return Object.freeze({
      allowed: false,
      decision: 'deny',
      code: GATE_CODES.LEGACY_HIGH_RISK_REACHABLE,
      reason: `legacy 路径 + 高风险工具${toolName ? `（${toolName}）` : ''}，而强制面门禁未满足` +
        `（未就绪项：${gate?.unsatisfied?.join(' / ') || '未知'}）——spec line 472 要求此时禁止`,
    })
  }
  return Object.freeze({
    allowed: true,
    decision: 'enforced',
    code: null,
    reason: '门禁已满足，legacy 高风险工具交给正常强制面',
  })
}

// ------------------------------------------------------------------ 发布指标

/** 发布指标的结论。`not-a-metric-yet` 是**唯一的**"门禁没满足"读数。 */
export const METRIC_VERDICTS = Object.freeze(['pass', 'fail', 'no-evidence', 'not-a-metric-yet'])

/**
 * 计算发布指标「未批准高风险写操作为零」。
 *
 * ⚠️ 本函数在门禁未满足时**不会**返回 `pass`，即使 `unapproved === 0`。
 * 那个 `0` 不是证据（见文件头）。它返回 `verdict: 'not-a-metric-yet'`。
 *
 * @param {object} args
 * @param {{satisfied: boolean, reasons: readonly string[], path: string|null}} args.gate `evaluateReadiness` 的返回
 * @param {{attempted?: number, unapproved?: number}} args.observations
 * @returns {{verdict: string, metricValid: boolean, attempted: number, unapproved: number,
 *            code: string|null, reason: string}}
 */
export function evaluateReleaseMetric({ gate, observations = {} } = {}) {
  const attempted = Number.isInteger(observations.attempted) ? observations.attempted : null
  const unapproved = Number.isInteger(observations.unapproved) ? observations.unapproved : null

  // ★ 顺序要紧：门禁**先于**数字被检查。
  //   反过来写（先看 unapproved === 0 就返回 pass）正是本模块要防的那件事。
  if (gate?.satisfied !== true) {
    return Object.freeze({
      verdict: 'not-a-metric-yet',
      metricValid: false,
      attempted: attempted ?? 0,
      unapproved: unapproved ?? 0,
      code: 'release-gate-metric-not-valid-yet',
      reason: '强制面门禁未满足：此时"未批准高风险写操作为零"不是证据——' +
        '它可能只是因为一条高风险写都没被真的管控过（或因为本模块按 spec 把它们全禁掉了）。' +
        `未就绪项：${gate?.unsatisfied?.join(' / ') || '未知'}`,
    })
  }

  if (attempted === null || unapproved === null) {
    return Object.freeze({
      verdict: 'no-evidence', metricValid: true, attempted: attempted ?? 0, unapproved: unapproved ?? 0,
      code: 'release-gate-metric-no-observations',
      reason: '门禁已满足，但没有观测数据——"没有数据"不是"零"，不能当作通过',
    })
  }
  if (attempted === 0) {
    // 0 / 0：分母为零的成功读数。这一条与上面那条不同——上面是"没给数据"，
    // 这里是"给了数据，而那个类别一次都没被尝试过"。
    return Object.freeze({
      verdict: 'no-evidence', metricValid: true, attempted, unapproved, code: 'release-gate-metric-no-attempts',
      reason: '门禁已满足，但一次高风险写都没被尝试过——"0 次未批准"与"0 次尝试"在报表上都是 0，' +
        '而后者不是证据',
    })
  }
  if (unapproved > 0) {
    return Object.freeze({
      verdict: 'fail', metricValid: true, attempted, unapproved, code: 'release-gate-metric-violated',
      reason: `${attempted} 次高风险写里有 ${unapproved} 次未获批准`,
    })
  }
  return Object.freeze({
    verdict: 'pass', metricValid: true, attempted, unapproved, code: null,
    reason: `${attempted} 次高风险写全部获批`,
  })
}

// ------------------------------------------------------------------ 自检

/**
 * 装载期自检：把本模块的**两条**核心判据各真的跑一遍，并留下算出来的值。
 *
 * 留下的是值（码与 verdict），不是一个 `ok` 布尔——报表要能解释自己。
 */
function assertGateSemantics() {
  const problems = []

  const notReady = evaluateReadiness({
    selfCheck: { checks: [{ name: 'composition-patch-layer', ok: false, reasons: ['未生效'] }] },
    path: 'legacy',
    decisionSourceRecorded: false,
    legacyHighRiskTools: ['file_delete'],
    schedulers: ['a'],
  })
  if (notReady.satisfied) problems.push('门禁在明显未就绪的输入上被判为满足')

  const ready = evaluateReadiness({
    selfCheck: {
      checks: [
        { name: 'composition-patch-layer', ok: true, reasons: [] },
        { name: 'runtime-probe', ok: true, reasons: [] },
        { name: 'sandbox-enforcement', ok: true, reasons: [] },
        { name: 'enforcement-mapping', ok: true, reasons: [] },
      ],
    },
    path: 'product-runtime',
    decisionSourceRecorded: true,
    legacyHighRiskTools: [],
    schedulers: ['legion'],
  })
  if (!ready.satisfied) problems.push(`门禁在完全就绪的输入上被判为不满足：${ready.reasons.join('；')}`)

  // ★ 判据一：门禁未满足 + 数字是零 → 必须是 not-a-metric-yet，**不是** pass
  const zeroWithoutGate = evaluateReleaseMetric({
    gate: notReady, observations: { attempted: 0, unapproved: 0 },
  })
  if (zeroWithoutGate.verdict !== 'not-a-metric-yet') {
    problems.push(`门禁未满足时 0 次未批准被判成 ${zeroWithoutGate.verdict}——它必须不是 pass`)
  }
  // 反向：门禁未满足而 unapproved > 0 时也**不能**报 fail，
  // 因为那个数字同样不可信（来源不明的计数不能用来定罪）。
  const badWithoutGate = evaluateReleaseMetric({
    gate: notReady, observations: { attempted: 5, unapproved: 3 },
  })
  if (badWithoutGate.verdict !== 'not-a-metric-yet') {
    problems.push(`门禁未满足时 3 次未批准被判成 ${badWithoutGate.verdict}——门禁必须**先于**数字被检查`)
  }

  // ★ 判据二：门禁满足 + 0 次尝试 → no-evidence，不是 pass
  const noAttempts = evaluateReleaseMetric({ gate: ready, observations: { attempted: 0, unapproved: 0 } })
  if (noAttempts.verdict !== 'no-evidence') {
    problems.push(`门禁满足但 0 次尝试被判成 ${noAttempts.verdict}——它必须是 no-evidence`)
  }

  // ★ 判据三：legacy + 高风险 + 门禁未满足 → deny
  const legacyDenied = legacyHighRiskPolicy({ risk: 'high', gate: notReady, path: 'legacy', toolName: 'file_delete' })
  if (legacyDenied.allowed !== false) problems.push('legacy 路径上高风险工具未被禁用')
  // 而 product-runtime 上不该被本策略禁止（否则就是永久禁用）
  const productAllowed = legacyHighRiskPolicy({ risk: 'high', gate: notReady, path: 'product-runtime' })
  if (productAllowed.allowed !== true) problems.push('product-runtime 路径被本策略误禁')
  // 未知风险等级按高风险（fail closed）
  if (isHighRisk('不认识的等级') !== true) problems.push('未知风险等级没有被当作高风险')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: RELEASE_GATE_VERSION,
    codes: GATE_CODES,
    readinessItems: READINESS_ITEMS.map((i) => i.id),
    metricVerdicts: METRIC_VERDICTS,
    samples: Object.freeze({
      notReadyUnsatisfied: notReady.unsatisfied,
      readySatisfied: ready.satisfied,
      zeroWithoutGate: zeroWithoutGate.verdict,
      badWithoutGate: badWithoutGate.verdict,
      noAttempts: noAttempts.verdict,
      legacyHighRiskDecision: legacyDenied.decision,
      legacyHighRiskCode: legacyDenied.code,
      productRuntimeDecision: productAllowed.decision,
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const RELEASE_GATE_CHECKED = assertGateSemantics()

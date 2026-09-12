// runtime/dsh-composition/release-gate.test.mjs
// ============================================================================
// PRT-614 的判据：新强制面完成前的 legacy 高风险工具禁用 + 发布门禁。
//
// 这一组盯的**不是**"门禁能不能跑"，而是**报表会不会说谎**。
// 它坏在两个方向，而只有一个方向会有人来报 bug：
//
//   ① 门禁太松 → 报表显示"未批准高风险写为 0，通过"（**危险的那个**，没人报 bug）
//   ② 门禁太紧 → 发不出去（会有人来报）
//
// 所以下面每一条都必须用一个**真的未就绪**的输入去问，而不是断言一个常量。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXECUTION_PATHS,
  GATE_CODES,
  HIGH_RISK_FLOOR,
  METRIC_VERDICTS,
  READINESS_ITEMS,
  RELEASE_GATE_CHECKED,
  RELEASE_GATE_VERSION,
  evaluateReadiness,
  evaluateReleaseMetric,
  isHighRisk,
  legacyHighRiskPolicy,
} from './release-gate.mjs'
import { RISK_LEVELS, UNKNOWN_TOOL_RISK } from './tool-capability.mjs'

// ---------------------------------------------------------------- 就绪的所有项都过

const GOOD_CHECKS = [
  { name: 'composition-patch-layer', ok: true, reasons: [] },
  { name: 'runtime-probe', ok: true, reasons: [] },
  { name: 'sandbox-enforcement', ok: true, reasons: [] },
  { name: 'enforcement-mapping', ok: true, reasons: [] },
]

const READY = Object.freeze({
  selfCheck: { checks: GOOD_CHECKS },
  path: 'product-runtime',
  decisionSourceRecorded: true,
  legacyHighRiskTools: [],
  schedulers: ['legion'],
})

const NOT_READY = Object.freeze({
  selfCheck: {
    checks: [
      { name: 'composition-patch-layer', ok: false, reasons: ['补丁层未生效'] },
      { name: 'runtime-probe', ok: false, reasons: ['主版本不符'] },
      { name: 'sandbox-enforcement', ok: false, reasons: ['只有 partial'] },
      { name: 'enforcement-mapping', ok: false, reasons: ['映射不自洽'] },
    ],
  },
  path: 'legacy',
  decisionSourceRecorded: false,
  legacyHighRiskTools: ['file_delete', 'repo_push'],
  schedulers: ['a', 'b'],
})

// ---------------------------------------------------------------- 自检

test('① ★ 装载期自检：三条核心判据都**真的被跑过**（不是注释里的"应该会拦"）', () => {
  assert.equal(RELEASE_GATE_CHECKED.ok, true, JSON.stringify(RELEASE_GATE_CHECKED.problems))
  // 留下的是**值**，不是一个 ok 布尔
  assert.equal(RELEASE_GATE_CHECKED.samples.zeroWithoutGate, 'not-a-metric-yet')
  assert.equal(RELEASE_GATE_CHECKED.samples.noAttempts, 'no-evidence')
  assert.equal(RELEASE_GATE_CHECKED.samples.legacyHighRiskDecision, 'deny')
  assert.equal(RELEASE_GATE_CHECKED.samples.readySatisfied, true)
  assert.equal(RELEASE_GATE_CHECKED.samples.productRuntimeDecision, 'enforced')
  // 未就绪的样例必须**真的**列出未就绪项（空数组会让上面几条失去意义）
  assert.ok(RELEASE_GATE_CHECKED.samples.notReadyUnsatisfied.length > 0)
})

test('① ★ 版本号是字符串常量（报表要能解释自己是按哪版判据算的）', () => {
  assert.match(RELEASE_GATE_VERSION, /^legion\/release-gate@\d+$/)
  assert.equal(RELEASE_GATE_VERSION, RELEASE_GATE_CHECKED.version)
})

// ---------------------------------------------------------------- ★★ 指标不可以说谎

test('② ★★ 门禁未满足 + 未批准为 0 → **不是** pass（本批的核心判据）', () => {
  // 这正是 spec line 472 那半句话要防的场景：那个 0 是我们自己造出来的。
  const r = evaluateReleaseMetric({ gate: evaluateReadiness(NOT_READY), observations: { attempted: 0, unapproved: 0 } })
  assert.equal(r.metricValid, false)
  assert.equal(r.verdict, 'not-a-metric-yet')
  assert.notEqual(r.verdict, 'pass')
  assert.match(r.reason, /不是证据/)
})

test('② ★★ 门禁未满足 + attempted > 0 + unapproved > 0 → 也**不是** fail（门禁先于数字）', () => {
  // 顺序判据：门禁必须先被检查。反过来写（先看 unapproved）会在
  // "门禁没满足但恰好有 0 次未批准"时给出 pass——那才是危险的那一半。
  // 这一条证明的是**两个方向都被门禁挡住**，而不是只有零那一侧。
  const r = evaluateReleaseMetric({ gate: evaluateReadiness(NOT_READY), observations: { attempted: 5, unapproved: 3 } })
  assert.equal(r.verdict, 'not-a-metric-yet')
  assert.equal(r.metricValid, false)
})

test('② ★★ 门禁满足 + 0 次尝试 → no-evidence，**不是** pass（0/0 不是证据）', () => {
  const r = evaluateReleaseMetric({ gate: evaluateReadiness(READY), observations: { attempted: 0, unapproved: 0 } })
  assert.equal(r.verdict, 'no-evidence')
  assert.match(r.reason, /0 次尝试|都没被尝试/)
})

test('② ★★ 门禁满足 + 有尝试 + 全部获批 → pass（唯一会 pass 的形状）', () => {
  const r = evaluateReleaseMetric({ gate: evaluateReadiness(READY), observations: { attempted: 7, unapproved: 0 } })
  assert.equal(r.verdict, 'pass')
  assert.equal(r.metricValid, true)
  assert.equal(r.attempted, 7)
  assert.equal(r.unapproved, 0)
})

test('② ★★ 门禁满足 + 有未批准 → fail', () => {
  const r = evaluateReleaseMetric({ gate: evaluateReadiness(READY), observations: { attempted: 7, unapproved: 2 } })
  assert.equal(r.verdict, 'fail')
  assert.match(r.reason, /2 次未获批准/)
})

test('② ★ 四个 verdict 都在、都没有被写成常量', () => {
  const gate = evaluateReadiness(READY)
  const seen = new Set([
    evaluateReleaseMetric({ gate, observations: { attempted: 1, unapproved: 0 } }).verdict,
    evaluateReleaseMetric({ gate, observations: { attempted: 1, unapproved: 1 } }).verdict,
    evaluateReleaseMetric({ gate, observations: { attempted: 0, unapproved: 0 } }).verdict,
    evaluateReleaseMetric({ gate: evaluateReadiness(NOT_READY), observations: {} }).verdict,
  ])
  assert.deepEqual([...seen].sort(), [...METRIC_VERDICTS].sort())
})

test('② ★ 观测数据缺失（不是 0）→ no-evidence，而 metricValid 为 true', () => {
  const r = evaluateReleaseMetric({ gate: evaluateReadiness(READY) })
  assert.equal(r.verdict, 'no-evidence')
  // `metricValid` 问的是"门禁满足了吗、这个指标成不成立"，不是"这一次通过了吗"
  assert.equal(r.metricValid, true)
  assert.match(r.reason, /没有数据/)
})

// ---------------------------------------------------------------- legacy 禁用

test('③ ★★ legacy + 高风险 + 门禁未满足 → **拒绝**（spec line 472）', () => {
  const gate = evaluateReadiness(NOT_READY)
  for (const risk of ['high', 'critical']) {
    const r = legacyHighRiskPolicy({ risk, gate, path: 'legacy', toolName: 'file_delete' })
    assert.equal(r.allowed, false, `risk=${risk}`)
    assert.equal(r.decision, 'deny')
    assert.equal(r.code, GATE_CODES.LEGACY_HIGH_RISK_REACHABLE)
  }
})

test('③ ★★ product-runtime 上本策略**不**禁止高风险工具（否则是永久禁用）', () => {
  // 门禁未满足也照样不禁：product-runtime 上由强制面决定。
  // 若这里也禁，"接线完成后放开"这件事就永远不会发生——
  // 而 spec line 472 明确说的是"在完成接线**前**禁止"。
  const r = legacyHighRiskPolicy({ risk: 'critical', gate: evaluateReadiness(NOT_READY), path: 'product-runtime' })
  assert.equal(r.allowed, true)
  assert.equal(r.decision, 'enforced')
  assert.equal(r.code, null)
})

test('③ ★ legacy + 门禁**已满足** → 放开（接线完成后不该还禁着）', () => {
  const r = legacyHighRiskPolicy({ risk: 'high', gate: evaluateReadiness(READY), path: 'legacy', toolName: 'file_delete' })
  assert.equal(r.allowed, true)
  assert.match(r.reason, /门禁已满足/)
})

test('③ ★ legacy + 非高风险 → 不受本策略影响', () => {
  for (const risk of ['low', 'medium']) {
    const r = legacyHighRiskPolicy({ risk, gate: evaluateReadiness(NOT_READY), path: 'legacy' })
    assert.equal(r.allowed, true, `risk=${risk} 不该被禁`)
  }
})

test('③ ★ 未知执行路径 → 拒绝（而不是当 legacy 或当 product-runtime）', () => {
  for (const path of [null, undefined, 'legaci', 'PRODUCT-RUNTIME', '']) {
    const r = legacyHighRiskPolicy({ risk: 'low', gate: evaluateReadiness(READY), path })
    assert.equal(r.allowed, false, `path=${JSON.stringify(path)}`)
    assert.equal(r.code, GATE_CODES.PATH_UNKNOWN)
  }
})

test('③ ★★ 未知风险等级按**高风险**处理（fail closed，不是当作低风险）', () => {
  // 这个函数的两个错误方向不对等：当作低风险 = 放行。
  assert.equal(isHighRisk('不认识的等级'), true)
  assert.equal(isHighRisk(undefined), true)   // 缺席 → UNKNOWN_TOOL_RISK
  assert.equal(isHighRisk(null), true)
  assert.equal(UNKNOWN_TOOL_RISK, 'critical', '未知工具的风险等级必须是 critical')
  const r = legacyHighRiskPolicy({ risk: '不认识的等级', gate: evaluateReadiness(NOT_READY), path: 'legacy' })
  assert.equal(r.allowed, false)
})

test('③ ★ 高风险门槛是 `>= high`，且真的用 RISK_RANK 判（不是一张硬编码名单）', () => {
  assert.equal(HIGH_RISK_FLOOR, 'high')
  const rank = RISK_LEVELS.indexOf('high')
  for (const level of RISK_LEVELS) {
    const expected = RISK_LEVELS.indexOf(level) >= rank
    assert.equal(isHighRisk(level), expected, `${level} 应为 ${expected}`)
  }
})

// ---------------------------------------------------------------- 就绪评估

test('④ ★★ 四项自检结论直接来自 `startupSelfCheck`，不重新判断一遍', () => {
  // 只把四项映射过来：改动自检的结论必须**如实**反映在门禁上。
  const r = evaluateReadiness({ ...READY, selfCheck: { checks: GOOD_CHECKS.map((c) => ({ ...c, ok: c.name === 'sandbox-enforcement' ? false : true })) } })
  assert.equal(r.satisfied, false)
  assert.deepEqual([...r.unsatisfied], ['sandbox'])
})

test('④ ★★ 缺自检结果 ≠ 自检通过（四项全部按"未证明"处理）', () => {
  const r = evaluateReadiness({ path: 'product-runtime', decisionSourceRecorded: true, legacyHighRiskTools: [], schedulers: ['a'] })
  assert.equal(r.satisfied, false)
  for (const id of ['patch-layer', 'runtime', 'sandbox', 'mapping']) {
    assert.ok(r.unsatisfied.includes(id), `${id} 应当未就绪`)
  }
  assert.match(r.reasons.join('\n'), /没检查.*不等于.*检查通过/)
})

test('④ ★★ 缺失的 legacy 工具清单**不是**空清单（两项都要能区分"没说"与"没有"）', () => {
  const missing = evaluateReadiness({ ...READY, legacyHighRiskTools: undefined })
  assert.equal(missing.satisfied, false)
  assert.ok(missing.unsatisfied.includes('legacy-high-risk'))
  // 空数组才通过
  const empty = evaluateReadiness({ ...READY, legacyHighRiskTools: [] })
  assert.equal(empty.satisfied, true)
})

test('④ ★ 调度器：0 个**不算**通过，1 个才通过，2 个不通过', () => {
  const one = evaluateReadiness({ ...READY, schedulers: ['legion'] })
  assert.equal(one.satisfied, true)
  const zero = evaluateReadiness({ ...READY, schedulers: [] })
  assert.equal(zero.satisfied, false)
  assert.match(zero.reasons.join('\n'), /唯一.*不成立/)
  const two = evaluateReadiness({ ...READY, schedulers: ['a', 'b'] })
  assert.equal(two.satisfied, false)
  assert.equal(two.reasons.some((x) => x.includes(GATE_CODES.DUAL_SCHEDULER)), true)
})

test('④ ★ 执行路径：未知路径让门禁不满足，且报可归因的码', () => {
  const r = evaluateReadiness({ ...READY, path: 'legacy-mode' })
  assert.equal(r.satisfied, false)
  assert.ok(r.reasons.some((x) => x.startsWith(GATE_CODES.PATH_UNKNOWN)))
  // 两条合法路径都要能过
  for (const p of EXECUTION_PATHS) {
    assert.equal(evaluateReadiness({ ...READY, path: p }).satisfied, true, p)
  }
})

test('④ ★ 每一条未就绪都带可归因的码与标签（不是一个总布尔）', () => {
  const r = evaluateReadiness(NOT_READY)
  assert.equal(r.satisfied, false)
  assert.ok(r.items.length >= READINESS_ITEMS.length)
  for (const item of r.items) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.label, 'string')
    assert.ok(item.label.length > 0)
    if (!item.ok) assert.match(item.code, /^release-gate-/)
    if (item.ok) assert.equal(item.code, null)
  }
  assert.equal(r.unsatisfied.length, r.items.filter((i) => !i.ok).length)
})

test('④ ★ 全绿时才 satisfied（逐项都试一遍，证明不是恒真）', () => {
  // 从全绿出发，逐个把一项打坏——每一次都必须让门禁不满足。
  // 没有这一条时，"satisfied" 可能是被某个我没想到的默认值撑着的。
  for (const item of READINESS_ITEMS) {
    const patch = {}
    if (item.id === 'patch-layer' || item.id === 'runtime' || item.id === 'sandbox' || item.id === 'mapping') {
      const names = { 'patch-layer': 'composition-patch-layer', runtime: 'runtime-probe', sandbox: 'sandbox-enforcement', mapping: 'enforcement-mapping' }
      patch.selfCheck = { checks: GOOD_CHECKS.map((c) => ({ ...c, ok: c.name === names[item.id] ? false : true })) }
    } else if (item.id === 'decision-source') patch.decisionSourceRecorded = false
    else if (item.id === 'legacy-high-risk') patch.legacyHighRiskTools = ['x']
    else if (item.id === 'scheduler') patch.schedulers = ['a', 'b']

    const r = evaluateReadiness({ ...READY, ...patch })
    assert.equal(r.satisfied, false, `打坏 ${item.id} 之后门禁仍然满足`)
    assert.ok(r.unsatisfied.includes(item.id), `打坏 ${item.id} 之后它没出现在未就绪名单里`)
  }
})

test('④ ★ `legacyHighRiskTools` 被带出来（报表要能看到还剩哪些）', () => {
  const r = evaluateReadiness(NOT_READY)
  assert.deepEqual([...r.legacyHighRiskTools], ['file_delete', 'repo_push'])
  assert.match(r.reasons.join('\n'), /file_delete/)
})

test('④ ★ 返回的对象是冻结的（调用方改它不能改掉门禁结论）', () => {
  const r = evaluateReadiness(READY)
  assert.ok(Object.isFrozen(r))
  assert.ok(Object.isFrozen(r.items))
  assert.throws(() => { 'use strict'; r.satisfied = false }, TypeError)
})

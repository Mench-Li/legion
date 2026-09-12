// ============================================================================
// PRT-711 的判据。
//
// 这一组盯的**不是**"六态有没有都映射到"，而是**认不出时会不会照常干活**。
//
// 一个没见过的状态字符串如果落到"默认可以认领"，那么产品的每一次"状态不明"
// 都会变成一次在坏掉的产品上执行的自动化——而执行是有代价的：
// 它花用户的钱、改用户的代码、发用户的消息。
//
//   > 一个在状态不明时"默认照常执行"的系统，与一个在状态不明时
//   > 随机执行一部分任务的系统，在"用户的钱会不会被乱花"上是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAIM_POLICY,
  CLAIM_SCOPE,
  IN_FLIGHT,
  RUNTIME_STATES,
  assertClaimPolicyTotal,
  liftProductState,
  mayClaimTasks,
  orchestratorPolicyFor,
  runtimeStatusReport,
} from './runtime-state.mjs'

// ── 表的完备性 ──────────────────────────────────────────────────────────────

test('① 六个状态一个都不能漏（漏了就是「这个状态不用决定行为」）', () => {
  const r = assertClaimPolicyTotal()
  assert.deepEqual(r.problems, [])
  assert.equal(RUNTIME_STATES.length, 6)
  for (const s of RUNTIME_STATES) assert.ok(CLAIM_POLICY[s], `${s} 没有策略`)
})

test('① ★ 自检**真的会发现**漏掉的状态（喂它一份故意做坏的表）', () => {
  // 这一组不能省。自检读的是真表，而真表当前是完备的——把检查语句删掉，
  // 结果依然是「没有问题」。只有喂它坏表，才能证明它真的会发现问题。
  //
  //   > 一个只能对"当前恰好正确的那份输入"作答的校验，
  //   > 与一个恒真的校验，在"它能不能发现错误"上同形。
  const missing = { ...CLAIM_POLICY }
  delete missing.upgrading
  const r1 = assertClaimPolicyTotal(missing)
  assert.equal(r1.ok, false)
  assert.ok(r1.problems.some((p) => p.includes('upgrading')), JSON.stringify(r1.problems))

  const extra = { ...CLAIM_POLICY, wat: CLAIM_POLICY.ready }
  const r2 = assertClaimPolicyTotal(extra)
  assert.equal(r2.ok, false, '多出一个未知状态却通过了自检')
  assert.ok(r2.problems.some((p) => p.includes('wat')), JSON.stringify(r2.problems))
})

test('① ★ 自检**真的会发现**自相矛盾的一档', () => {
  const bad1 = { ...CLAIM_POLICY, ready: { ...CLAIM_POLICY.ready, claimScope: CLAIM_SCOPE.NONE } }
  const r1 = assertClaimPolicyTotal(bad1)
  assert.equal(r1.ok, false, '「可以认领 + 范围 none」通过了自检')
  assert.ok(r1.problems.some((p) => p.includes('none')), JSON.stringify(r1.problems))

  const bad2 = {
    ...CLAIM_POLICY,
    unavailable: { ...CLAIM_POLICY.unavailable, mayClaim: false, claimScope: CLAIM_SCOPE.ALL },
  }
  assert.equal(assertClaimPolicyTotal(bad2).ok, false, '「不认领 + 有范围」通过了自检')

  const bad3 = { ...CLAIM_POLICY, ready: { ...CLAIM_POLICY.ready, mayClaim: 'yes' } }
  assert.equal(assertClaimPolicyTotal(bad3).ok, false, '「mayClaim 不是布尔」通过了自检')

  const bad4 = { ...CLAIM_POLICY, ready: { ...CLAIM_POLICY.ready, claimScope: 'whatever' } }
  assert.equal(assertClaimPolicyTotal(bad4).ok, false)

  const bad5 = { ...CLAIM_POLICY, ready: { ...CLAIM_POLICY.ready, inFlight: 'whenever' } }
  assert.equal(assertClaimPolicyTotal(bad5).ok, false)
})

test('① `mayClaim` 与 `claimScope` 不能自相矛盾', () => {
  // 这条由 `assertClaimPolicyTotal` 守着；这里直接验证它在自相矛盾时**会报**，
  // 否则"自检通过"这件事什么也没证明。
  for (const s of RUNTIME_STATES) {
    const p = CLAIM_POLICY[s]
    if (p.mayClaim) assert.notEqual(p.claimScope, CLAIM_SCOPE.NONE, `${s}：可以认领却没有范围`)
    else assert.equal(p.claimScope, CLAIM_SCOPE.NONE, `${s}：不认领却给了范围`)
  }
})

// ── ★ 认不出时绝不放行 ──────────────────────────────────────────────────────

test('② ★ 认不出的状态**绝不允许认领**', () => {
  for (const bad of ['wat', '', null, undefined, 'READY', 'Ready', 'ready ', 42, {}, []]) {
    const p = orchestratorPolicyFor(bad)
    assert.equal(p.mayClaim, false,
      `状态 ${JSON.stringify(bad)} 被放行了：那会让"状态不明"变成一次执行`)
    assert.equal(p.claimScope, CLAIM_SCOPE.NONE)
  }
})

test('② ★ 认不出时连**自动执行**也禁止（不只是不认领）', () => {
  // `unavailable` 只停认领；`incompatible` 还禁止自动执行。
  // 状态不明时该选更严的那一个。
  //   > "我不知道出了什么事"不是"事情还可以继续"的理由。
  const p = orchestratorPolicyFor('wat')
  assert.equal(p.blockAutoExecution, true)
  assert.equal(p.unrecognized, true, '要标出来这不是一个已知的故障结论')
})

test('② ★ 认不出时**不抛错**（抛错会让调用方 catch 之后 fallback 到照常执行）', () => {
  assert.doesNotThrow(() => orchestratorPolicyFor('wat'))
  assert.doesNotThrow(() => mayClaimTasks('wat'))
  assert.doesNotThrow(() => runtimeStatusReport('wat'))
})

test('② 认不出时的文案**不能冒充**成一个具体结论', () => {
  const p = orchestratorPolicyFor('wat')
  assert.ok(p.userText.includes('无法识别'), p.userText)
  assert.ok(p.userText.includes('不是一个已知的故障结论'), p.userText)
})

test('② `mayClaimTasks` 在认不出时给出 `claim: false` 与理由', () => {
  const r = mayClaimTasks('wat')
  assert.equal(r.claim, false)
  assert.equal(r.unrecognized, true)
  assert.ok(typeof r.reason === 'string' && r.reason !== '')
})

// ── 逐状态：第三列要真的对 ──────────────────────────────────────────────────

test('③ `starting`：不认领，且 lease **不延长为无限期**', () => {
  const p = orchestratorPolicyFor('starting')
  assert.equal(p.mayClaim, false)
  assert.equal(p.renewLeasesIndefinitely, false,
    '无限期延长的 lease 会让"引擎还在启动"变成一件无限期的事')
})

test('③ `ready`：正常认领与执行，且这是**唯一**报"数字员工在线"的状态', () => {
  const p = orchestratorPolicyFor('ready')
  assert.equal(p.mayClaim, true)
  assert.equal(p.claimScope, CLAIM_SCOPE.ALL)
  assert.equal(p.digitalWorkerOnline, true)
  for (const s of RUNTIME_STATES) {
    if (s === 'ready') continue
    assert.equal(orchestratorPolicyFor(s).digitalWorkerOnline, false,
      `${s} 报了"数字员工在线"：那正是 ready 的说法，不能借用`)
  }
})

test('③ `degraded`：只认领**必需能力全部满足**的任务', () => {
  const p = orchestratorPolicyFor('degraded')
  assert.equal(p.mayClaim, true)
  assert.equal(p.claimScope, CLAIM_SCOPE.REQUIRED_CAPABILITIES_ONLY)

  const yes = mayClaimTasks('degraded', { satisfiedCapabilities: ['t1', 't2'] })
  assert.equal(yes.claim, true)
  assert.deepEqual(yes.eligible, ['t1', 't2'])

  const none = mayClaimTasks('degraded', { satisfiedCapabilities: [] })
  assert.equal(none.claim, false, '能力一个都不满足时不该认领')
})

test('③ ★ `degraded` **不给判据**时一个都不认领（"不给判据"不是"判据都满足"）', () => {
  const r = mayClaimTasks('degraded')
  assert.equal(r.claim, false)
  assert.ok(r.reason.includes('不给判据不等于判据都满足'), r.reason)
})

test('③ `unavailable`：停止认领，在途进入**恢复判断**', () => {
  const p = orchestratorPolicyFor('unavailable')
  assert.equal(p.mayClaim, false)
  assert.equal(p.inFlight, IN_FLIGHT.RECOVERY_JUDGEMENT)
})

test('③ `incompatible`：**禁止自动执行**（比"不认领"多一层）', () => {
  const p = orchestratorPolicyFor('incompatible')
  assert.equal(p.mayClaim, false)
  assert.equal(p.blockAutoExecution, true,
    '在不兼容的组件上重试，只是把同一个错误再犯一次')
  // spec §6.3 这一行只写了"禁止自动执行"，没说在途怎么处置。
  // 下面这条把**我做的那个补充**钉住：组件不兼容时在途的 Attempt 不可能正常完成，
  // 所以它必须走恢复判断，而不是"继续跑"或"什么都没发生"。
  assert.equal(p.inFlight, IN_FLIGHT.RECOVERY_JUDGEMENT,
    '在途的 Attempt 在不兼容的组件上不可能正常完成，必须走恢复判断')
  // 只有它和认不出的那档禁止自动执行
  for (const s of RUNTIME_STATES) {
    if (s === 'incompatible') continue
    assert.equal(orchestratorPolicyFor(s).blockAutoExecution, false, `${s} 不该禁止自动执行`)
  }
})

test('③ `upgrading`：停止认领，在途**等待安全收敛**（不是恢复判断）', () => {
  const p = orchestratorPolicyFor('upgrading')
  assert.equal(p.mayClaim, false)
  assert.equal(p.inFlight, IN_FLIGHT.DRAIN,
    '升级中的在途任务应当等它自己收敛，而不是打断它去做恢复判断')
})

test('③ 每个状态都给出一句**用户能读懂**的话', () => {
  for (const s of RUNTIME_STATES) {
    const p = orchestratorPolicyFor(s)
    assert.ok(typeof p.userText === 'string' && p.userText.length > 10, `${s} 的文案太短`)
    assert.ok(p.userText.includes('：'), `${s} 的文案应当是"结论：怎么办"的形状`)
  }
})

// ── 抬升：外部信号只能往**更保守**的方向抬 ──────────────────────────────────

test('④ ★ 补丁层没生效时，进程全绿也**不能**报 `ready`', () => {
  // 这是 PRT-215 的接线点：强制面没生效的 Runtime 不能因为"进程都起来了"
  // 就报 ready——那等于用一个健康检查为真的结论，去覆盖一个能力层为假的结论。
  const lifted = liftProductState('ready', { selfCheck: { state: 'incompatible', reasons: ['补丁层未应用'] } })
  assert.equal(lifted.state, 'incompatible')
  assert.equal(lifted.liftedFrom, 'ready')
  assert.ok(lifted.reason.includes('不等于能力层生效'), lifted.reason)
})

test('④ ★ 升级进行中时，进程全绿也**不能**报 `ready`（优先级最高）', () => {
  const lifted = liftProductState('ready', { upgrading: true, selfCheck: { state: 'incompatible' } })
  assert.equal(lifted.state, 'upgrading', '升级期间即使自检也不兼容，状态该是"正在升级"')
})

test('④ 自检通过 / 没在升级时**原样返回**，且 `liftedFrom` 是 null', () => {
  const same = liftProductState('ready', { selfCheck: { state: 'enforcement-effective' } })
  assert.equal(same.state, 'ready')
  assert.equal(same.liftedFrom, null)
  assert.equal(same.reason, null)
})

test('④ 抬升**只往保守方向**：`unavailable` 不会被抬成 `ready`', () => {
  const lifted = liftProductState('unavailable', { selfCheck: { state: 'enforcement-effective' } })
  assert.equal(lifted.state, 'unavailable')
  // 反过来：一个"更差"的进程状态不会被外部信号抬成更好的
  assert.notEqual(orchestratorPolicyFor(lifted.state).mayClaim, true)
})

test('④ 抬升之后 Orchestrator 的行为**跟着变**（抬升不是只改一个字符串）', () => {
  const before = runtimeStatusReport('ready')
  assert.equal(before.orchestrator.mayClaim, true)
  const after = runtimeStatusReport('ready', { selfCheck: { state: 'incompatible' } })
  assert.equal(after.runtimeState, 'incompatible')
  assert.equal(after.orchestrator.mayClaim, false)
  assert.equal(after.orchestrator.blockAutoExecution, true)
  assert.equal(after.digitalWorkerOnline, false)
})

// ── 只读面与"数字员工在线"是两件事 ──────────────────────────────────────────

test('⑤ ★ 只读面在**任何**状态都开着（引擎挂掉时更该能看一眼）', () => {
  for (const s of [...RUNTIME_STATES, 'wat']) {
    const r = runtimeStatusReport(s)
    assert.equal(r.readOnlySurfacesOpen, true, `${s} 关掉了只读面`)
  }
})

test('⑤ ★ "产品还能用"**不能**被读成"数字员工在上班"', () => {
  // spec §6.3：只读 Workbench/team-hub 在 Runtime 不可用时继续开放，
  // 但**不能伪装为数字员工在线**。这两个字段放在一起就是为了这个区别。
  for (const s of RUNTIME_STATES) {
    const r = runtimeStatusReport(s)
    if (r.readOnlySurfacesOpen === true && r.digitalWorkerOnline === true) {
      assert.equal(s, 'ready', `${s}：只读面开着、又报数字员工在线——这正是"伪装在线"`)
    }
  }
})

test('⑤ 报告里把 `processState` 与 `runtimeState` **分开**给（抬升过要看得出来）', () => {
  const r = runtimeStatusReport('ready', { upgrading: true })
  assert.equal(r.processState, 'ready')
  assert.equal(r.runtimeState, 'upgrading')
  assert.equal(r.liftedFrom, 'ready')
  assert.ok(r.liftReason !== null)
})

test('⑤ 报告里的 orchestrator 块是**冻结**的最小集合（不含内部字段）', () => {
  const r = runtimeStatusReport('ready')
  assert.deepEqual(Object.keys(r.orchestrator).sort(),
    ['blockAutoExecution', 'claimScope', 'inFlight', 'mayClaim', 'renewLeasesIndefinitely', 'unrecognized'])
  assert.equal(Object.isFrozen(r.orchestrator), true)
  assert.equal(Object.isFrozen(r), true)
})

// ── 不可变性 ────────────────────────────────────────────────────────────────

test('⑥ 策略表与各档都是冻结的（运行时被改掉会让判据静默失效）', () => {
  assert.equal(Object.isFrozen(CLAIM_POLICY), true)
  for (const s of RUNTIME_STATES) assert.equal(Object.isFrozen(CLAIM_POLICY[s]), true, s)
})

test('⑥ `orchestratorPolicyFor` 每次返回**新对象**，改它不会污染策略表', () => {
  const a = orchestratorPolicyFor('ready')
  const b = orchestratorPolicyFor('ready')
  assert.notEqual(a, b)
  assert.equal(CLAIM_POLICY.ready.mayClaim, true)
})

test('⑥ `RUNTIME_STATES` 是冻结的，且与 spec §6.3 表格逐字一致', () => {
  assert.equal(Object.isFrozen(RUNTIME_STATES), true)
  assert.deepEqual([...RUNTIME_STATES],
    ['starting', 'ready', 'degraded', 'unavailable', 'incompatible', 'upgrading'])
})

test('⑥ 三档认领范围的字符串值是稳定的（会被写进状态文件与界面）', () => {
  assert.deepEqual(CLAIM_SCOPE, {
    NONE: 'none', ALL: 'all', REQUIRED_CAPABILITIES_ONLY: 'required-capabilities-only',
  })
})

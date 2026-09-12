// runtime/dsh-composition/approval-policy.test.mjs
// ============================================================================
// 判据：PRT-607（后半）无人值守策略
//
// spec line 472：无人值守模式下，要求人工审批的操作**默认拒绝或保持等待**，
//   不自动降级为允许。
// spec line 495 / 1083：Legion 自己的 preset 表；`legion-unattended` 必须保持
//   `workspace-write`，不得降级为 `danger-full-access`。
// spec line 1084：Run 期间无法改写 approval policy 或 preset。
//
// 一句话：**无人值守不是"没有人所以放行"，而是"没有人所以不能放行"。**
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_DECISIONS,
  APPROVAL_POLICIES,
  APPROVAL_POLICY_CHECKED,
  APPROVAL_POLICY_VERSION,
  HUMAN_REQUIREMENTS,
  POLICY_CODES,
  SANDBOX_MODES,
  applyApprovalOutcome,
  approvalOutcomeSet,
  assertKnobsUnchanged,
  assertPolicy,
  assertPreset,
  decideApproval,
} from './approval-policy.mjs'

// 与审批箱那一侧共用一份闭集——两边各有一份是因为互相 import 会成环，
// 但"两份不一致"恰恰是危险的地方，所以在这里对起来。
import { APPROVAL_OUTCOMES } from './enforcement.mjs'
import { LEGION_PERMISSION_PRESETS } from './patch-layer.mjs'

const decide = (o) => decideApproval(o)

// ============================================================ ① 核心不变量

test('① ★★★ `never` 在任何组合下都不会放行（这是本模块存在的理由）', () => {
  //   > 一个「无人值守时把需要审批的操作自动放行」的降级，
  //   > 与一个「无人值守等于没有权限门」的实现，是同一个东西。
  const rows = APPROVAL_POLICY_CHECKED.neverNeverAllows.rows
  assert.equal(rows.length, HUMAN_REQUIREMENTS.length * 2 * 2, '需求的每一种组合都要探过')
  // 需要人的那些：**无一**放行
  assert.equal(APPROVAL_POLICY_CHECKED.neverNeverAllows.allowedCount, 0)
  assert.deepEqual(APPROVAL_POLICY_CHECKED.neverNeverAllows.decisions, ['deny'])
  for (const r of rows.filter((x) => x.requirement !== 'none')) {
    assert.equal(r.allowed, false, `${r.requirement}/${r.attended}/${r.highRisk}`)
    assert.equal(r.decision, 'deny', `${r.requirement}/${r.attended}/${r.highRisk}`)
  }
  // 不需要人的（requirement: 'none'）本来就不该问人——它放行不是"降级"
  for (const r of rows.filter((x) => x.requirement === 'none')) {
    assert.equal(r.allowed, true)
    assert.equal(r.decision, 'allow-by-policy')
  }
})

test('① ★★★ `never` 下"已经有过一次性批准"也不算数', () => {
  //   > 一个「policy=never 但带一次性批准就放行」的判定，
  //   > 与一个「无人值守时，只要之前有人批过一次就永远放行」的判定，是同一个东西。
  for (const attended of [true, false]) {
    const v = decide({ policy: 'never', requirement: 'allow-once', attended })
    assert.equal(v.allowed, false, `attended=${attended}`)
    assert.equal(v.decision, 'deny', `attended=${attended}`)
    assert.equal(v.code, POLICY_CODES.NEVER_MUST_NOT_ALLOW)
    // 理由里要说清"不询问也不放行"，而不是含糊的"被拒绝"
    assert.match(v.reason, /不询问/)
  }
})

test('① ★★★ 无人值守（现场没人）时 `ask` 也只挂起，不放行', () => {
  //   > 一个「问不到人就当没人反对」的默认，
  //   > 与一个「超时算通过」的默认，是同一个东西。
  const e = APPROVAL_POLICY_CHECKED.unattended
  assert.equal(e.allowedCount, 0)
  assert.equal(e.heldCount, 2, 'ask 与 allow-once 两种需求都要挂起')
  assert.deepEqual(e.needsHumanDecisions, ['hold'])
  // 挂起 ≠ 拒绝：`waited` 与 `decision` 都不同，审计上是两件事
  const held = decide({ policy: 'ask', requirement: 'ask', attended: false })
  const denied = decide({ policy: 'never', requirement: 'ask', attended: false })
  assert.equal(held.decision, 'hold')
  assert.equal(held.waited, true)
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.waited, false)
  // 理由要能区分这两件事
  assert.match(held.reason, /保持等待/)
  assert.match(denied.reason, /无人值守下不询问/)
})

// ============================================================ ② 审批结果

test('② ★★★ 审批结果不能把一个 deny 或 hold 改成放行', () => {
  //   > 一个「已经决定不放行的调用被一个"允许"结果覆盖」的实现，
  //   > 与一个「无人值守时只要审批箱说行就行」的实现，是同一个东西。
  const e = APPROVAL_POLICY_CHECKED.outcomeCannotOverride
  assert.equal(e.denyNeverAllows, true)
  assert.equal(e.holdAllowedOnceThrows, true)
  const hold = decide({ policy: 'ask', requirement: 'ask', attended: false })
  const deny = decide({ policy: 'never', requirement: 'ask', attended: true })
  assert.throws(
    () => applyApprovalOutcome(hold, 'allowed-once'),
    (err) => err.code === POLICY_CODES.UNATTENDED_WOULD_ALLOW,
  )
  assert.throws(
    () => applyApprovalOutcome(deny, 'allowed-once'),
    (err) => err.code === POLICY_CODES.UNATTENDED_WOULD_ALLOW,
  )
  // 非放行结果不改决定
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    assert.equal(applyApprovalOutcome(deny, outcome).allowed, false, outcome)
    assert.equal(applyApprovalOutcome(deny, outcome).decision, 'deny', outcome)
  }
})

test('② ★★ 只有 `allowed-once` 会放行；`unavailable` 变成挂起而不是放行或拒绝', () => {
  const e = APPROVAL_POLICY_CHECKED.onlyAllowedOnceGrants
  assert.equal(e.ask.allowed, false, 'ask 本身不放行——它只是"去问"')
  assert.equal(e.ask.decision, 'ask')
  assert.equal(e.onlyAllowedOnce, true)
  assert.deepEqual(e.grantedOutcomes, ['allowed-once'])
  // unavailable ⇒ hold（"我们问不到人"），不是 deny（"人说不"）
  //
  //   > 一个「把'问不到人'记成'人拒绝了'」的审计，
  //   > 与一个「值班的人去追问一个从未被问过的人」的审计，是同一个东西。
  assert.equal(e.unavailableDecision, 'hold')
  assert.equal(e.rows.find((r) => r.outcome === 'rejected').decision, 'deny')
  assert.equal(e.rows.find((r) => r.outcome === 'cancelled').decision, 'deny')
  assert.equal(e.rows.find((r) => r.outcome === 'unavailable').waited, true)
})

test('② ★★ 结果闭集与 enforcement 那一侧完全一致', () => {
  //   > 一个「本模块认为 `unavailable` 是合法结果、而审批箱那一侧从不产出它」的差异，
  //   > 与一个「超时永远走不到该走的那条分支」的差异，是同一个东西。
  assert.deepEqual([...approvalOutcomeSet()].sort(), [...APPROVAL_OUTCOMES].sort())
  // 而闭集之外的结果必须抛，不能当放行也不能当拒绝
  const ask = decide({ policy: 'ask', requirement: 'ask', attended: true })
  for (const bogus of ['allowed', 'ok', 'yes', true, null, undefined, '']) {
    assert.throws(
      () => applyApprovalOutcome(ask, bogus),
      (err) => err.code === POLICY_CODES.BAD_INPUT,
      String(bogus),
    )
  }
})

// ============================================================ ③ preset 表

test('③ ★★★ Legion 用自己的 preset 表，且无人值守不降级沙箱', () => {
  // spec line 495：若按 DSH 默认表实现「无人值守 = never」，沙箱会**同时**
  // 被降级为 danger-full-access，与最小权限要求直接冲突。
  const e = APPROVAL_POLICY_CHECKED.presets
  assert.deepEqual(e.names, ['legion-attended', 'legion-unattended'])
  assert.equal(e.allLegionPresetsOk, true)
  // spec line 1083：无人值守必须保持 workspace-write
  assert.equal(e.unattended.sandbox, 'workspace-write')
  assert.equal(e.unattended.policy, 'never')
  assert.equal(e.unattendedSandbox, 'workspace-write')
  // ★ 而 DSH 默认表的名字**不在** Legion 的表里 ⇒ 用它会抛
  //
  //   > 一个「复用 DSH 默认 preset 表」的实现，
  //   > 与一个「无人值守时沙箱悄悄升到 danger-full-access」的实现，是同一个东西——
  //   > 只不过前者的代码里没有任何一行写着 danger-full-access。
  for (const dshDefault of ['default', 'danger-full-access', 'unattended', '']) {
    assert.throws(() => assertPreset(dshDefault), (err) => err.code === POLICY_CODES.BAD_PRESET, dshDefault)
  }
  // 而 attended 那个是 ask + workspace-write
  assert.equal(e.rows.find((r) => r.name === 'legion-attended').policy, 'ask')
  assert.equal(e.rows.find((r) => r.name === 'legion-attended').sandbox, 'workspace-write')
  // 两个 preset 的 approval 名必须在 policy 闭集里
  for (const name of Object.keys(LEGION_PERMISSION_PRESETS)) {
    assert.ok(APPROVAL_POLICIES.includes(LEGION_PERMISSION_PRESETS[name].approval), name)
  }
  // 而"无人值守 preset 被改成 danger-full-access"必须被抓到。
  // ★ 这一条在真实表上**永远为假**，所以用一张**被改坏的表**证明它真的会拦——
  //   否则它就是一条从不执行的检查。
  //
  //   > 一个「检查一个不可能出现的值」的检查，
  //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
  const tampered = {
    'legion-attended': { sandbox: 'workspace-write', approval: 'ask' },
    'legion-unattended': { sandbox: 'danger-full-access', approval: 'never' },
  }
  assert.equal(e.downgrade.tamperedSandbox, 'danger-full-access')
  assert.equal(e.downgrade.caughtCode, POLICY_CODES.PRESET_SANDBOX_DOWNGRADE, '降级必须被拦')
  assert.throws(
    () => assertPreset('legion-unattended', { table: tampered }),
    (err) => err.code === POLICY_CODES.PRESET_SANDBOX_DOWNGRADE,
  )
  // 对照组：同一张表里合法的那个仍然通过 ⇒ 拦的是"降级"这件事，不是"表坏了"
  assert.equal(e.downgrade.controlCode, null)
  assert.equal(assertPreset('legion-attended', { table: tampered }).sandbox, 'workspace-write')
  // 而真实表里 legion-unattended 就是 workspace-write（所以上面那条才在真实表上为假）
  const unattended = LEGION_PERMISSION_PRESETS['legion-unattended']
  assert.equal(unattended.sandbox, 'workspace-write')
  assert.ok(SANDBOX_MODES.includes('danger-full-access'), 'danger-full-access 是合法档位之一——所以才需要这条禁令')
})

// ============================================================ ④ fail-closed

test('④ ★★★ 未知的 policy / requirement / attended 一律抛，不给默认值', () => {
  //   > 一个「不认识的 policy 就按 `ask` 处理」的兜底，
  //   > 与一个「拼错的 `nver` 被当成 `ask`、于是无人值守时会去问一个不在场的人」的兜底，
  //   > 是同一个东西。
  const e = APPROVAL_POLICY_CHECKED.unknownInputs
  assert.equal(e.allRejected, true)
  assert.equal(e.rows.length, 8)
  // policy 类的错与输入类的错是**不同的码**——修法不同
  assert.ok(e.codes.includes(POLICY_CODES.BAD_POLICY))
  assert.ok(e.codes.includes(POLICY_CODES.BAD_INPUT))
  assert.ok(e.codes.includes(POLICY_CODES.BAD_PRESET))
  // attended 缺失**不能**默认成"有人"
  assert.throws(
    () => decide({ policy: 'ask', requirement: 'ask' }),
    (err) => err.code === POLICY_CODES.BAD_INPUT,
  )
  assert.throws(
    () => decide({ policy: 'ask', requirement: 'ask', attended: 'yes' }),
    (err) => err.code === POLICY_CODES.BAD_INPUT,
  )
  // requirement 缺失也不能默认成 none（那会让一切都放行）
  assert.throws(
    () => decide({ policy: 'never', attended: true }),
    (err) => err.code === POLICY_CODES.BAD_INPUT,
  )
})

test('④ ★★ `assertPolicy` 把 policy 名的闭集钉住', () => {
  assert.deepEqual([...APPROVAL_POLICIES], ['ask', 'never'])
  for (const p of APPROVAL_POLICIES) assert.equal(assertPolicy(p), p)
  for (const bad of ['nver', 'NEVER', 'Ask', '', null, undefined, 0, {}]) {
    assert.throws(() => assertPolicy(bad), (err) => err.code === POLICY_CODES.BAD_POLICY, String(bad))
  }
  // 大小写不宽容是**刻意**的：policy 会被写进审计与快照，
  // 两个只有大小写差别的名字会让"这次 Run 用的是什么策略"变得要靠猜。
})

// ============================================================ ⑤ 旋钮冻结

test('⑤ ★★★ Run 进行中不允许改写 approval policy 或 preset', () => {
  //   > 一个「Run 期间可以改 approval policy」的实现，
  //   > 与一个「在 Run 快照中冻结的旋钮其实已经变了」的实现，是同一个东西。
  const e = APPROVAL_POLICY_CHECKED.knobs
  assert.equal(e.unchangedIdle.code, 'NO-THROW')
  assert.equal(e.unchangedIdle.changed, false)
  assert.equal(e.unchangedRunning.code, 'NO-THROW', '没改就不该抛，哪怕 Run 在跑')
  assert.equal(e.unchangedRunning.frozen, true)
  assert.equal(e.policyRunning.code, POLICY_CODES.FROZEN_DURING_RUN)
  assert.equal(e.presetRunning.code, POLICY_CODES.FROZEN_DURING_RUN)
  // Run 不在跑的时候改写是允许的（只是要留痕——持久化属于 PRT-619）
  assert.equal(e.policyIdle.code, 'NO-THROW')
  assert.equal(e.policyIdle.changed, true)
  assert.equal(e.policyIdle.frozen, false)
  assert.equal(e.presetIdle.code, 'NO-THROW')
  // 拒绝信息里要列出**哪几个**旋钮被改了
  try {
    assertKnobsUnchanged({
      before: { approvalPolicy: 'ask', permissionPreset: 'legion-attended' },
      after: { approvalPolicy: 'never', permissionPreset: 'legion-unattended' },
      runActive: true,
    })
    assert.fail('应当抛')
  } catch (err) {
    assert.equal(err.code, POLICY_CODES.FROZEN_DURING_RUN)
    assert.match(err.message, /approvalPolicy/)
    assert.match(err.message, /permissionPreset/)
  }
})

test('⑤ ★★ 旋钮快照必须是对象（不能靠 undefined 蒙过去）', () => {
  for (const [a, b] of [[null, {}], [{}, null], [undefined, {}], [{}, undefined]]) {
    assert.throws(
      () => assertKnobsUnchanged({ before: a, after: b, runActive: true }),
      (err) => err.code === POLICY_CODES.BAD_INPUT,
    )
  }
  // 缺字段被当成"从 undefined 变成 undefined" ⇒ 没变
  assert.equal(assertKnobsUnchanged({ before: {}, after: {}, runActive: true }).changed, false)
})

// ============================================================ ⑥ 组合

test('⑥ ★★★ 四种决策各自的可观察形状', () => {
  //   > 一个「把四种决策压成"通过/不通过"」的实现，
  //   > 与一个「审计看不出这次是拒绝还是挂起」的实现，是同一个东西。
  const cases = [
    { input: { policy: 'ask', requirement: 'none', attended: false }, decision: 'allow-by-policy', allowed: true, waited: false },
    { input: { policy: 'ask', requirement: 'ask', attended: true }, decision: 'ask', allowed: false, waited: false },
    { input: { policy: 'ask', requirement: 'ask', attended: false }, decision: 'hold', allowed: false, waited: true },
    { input: { policy: 'never', requirement: 'ask', attended: true }, decision: 'deny', allowed: false, waited: false },
    { input: { policy: 'never', requirement: 'none', attended: false }, decision: 'allow-by-policy', allowed: true, waited: false },
  ]
  for (const c of cases) {
    const v = decide(c.input)
    assert.equal(v.decision, c.decision, JSON.stringify(c.input))
    assert.equal(v.allowed, c.allowed, JSON.stringify(c.input))
    assert.equal(v.waited, c.waited, JSON.stringify(c.input))
    assert.equal(v.needsHuman, c.input.requirement !== 'none', JSON.stringify(c.input))
    assert.equal(Object.isFrozen(v), true)
    // 每条判定都要带上下文，审计靠它复原"当时是什么设置"
    assert.equal(v.policy, c.input.policy)
    assert.equal(v.requirement, c.input.requirement)
    assert.equal(v.attended, c.input.attended)
  }
  assert.deepEqual([...APPROVAL_DECISIONS], ['allow-by-policy', 'ask', 'hold', 'deny'])
  assert.deepEqual([...HUMAN_REQUIREMENTS], ['none', 'ask', 'allow-once'])
})

test('⑥ ★★ 判定是冻结的，且不泄漏内部可变状态', () => {
  const v = decide({ policy: 'ask', requirement: 'ask', attended: true, highRisk: true })
  assert.equal(Object.isFrozen(v), true)
  assert.throws(() => { v.allowed = true }, TypeError)
  // preset 一起校验时，preset 的叶子字段被复制进来，不是引用
  const withPreset = decide({ policy: 'never', requirement: 'ask', attended: false, preset: 'legion-unattended' })
  assert.equal(Object.isFrozen(withPreset), true)
  assert.equal(withPreset.allowed, false)
  // 传进来的 preset 名不改判定结果（它只是被校验）
  const noPreset = decide({ policy: 'never', requirement: 'ask', attended: false })
  assert.equal(noPreset.decision, withPreset.decision)
})

test('⑥ ★★ 自检对象里的每一项都要有内容（防止自检退化成空壳）', () => {
  const e = APPROVAL_POLICY_CHECKED
  assert.equal(e.version, APPROVAL_POLICY_VERSION)
  for (const k of ['neverNeverAllows', 'unattended', 'outcomeCannotOverride', 'onlyAllowedOnceGrants', 'presets', 'unknownInputs', 'knobs']) {
    assert.ok(e[k] !== undefined && e[k] !== null, k)
    assert.ok(Object.keys(e[k]).length > 0, k)
  }
  assert.ok(Object.keys(e.codes).length >= 6)
  assert.equal(e.policies.length, 2)
  assert.equal(e.decisions.length, 4)
})

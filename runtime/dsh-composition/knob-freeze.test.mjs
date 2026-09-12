// runtime/dsh-composition/knob-freeze.test.mjs
// ============================================================================
// 判据：PRT-619（Run 期间 approval policy 与 preset 的冻结，以及**改写审计**）
//
// spec line 453：会话权限档位「绑定 sandbox mode 与 approval policy，并在 Run 快照中冻结」。
// spec line 499：承载 Run 的 session 在 Run 期间禁止改写这两个旋钮；确需改写时必须
//   写入 audit 并作为 Run 事件记录。
// spec line 1084：任何改写都留下审计记录。
//
// 一句话：**「Run 期间策略没被改过」如果没人能核对，它就不是一条保证，只是一句话。**
//
//   > 一个「Run 期间不允许改写」的拒绝，
//   > 与一个「拒绝了、但没人能证明它没被改过」的拒绝，是同一个东西——
//   > 只不过前者的代码里有一行 `throw`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_POLICY_CHECKED,
  KNOB_KEYS,
  KNOB_REWRITE_EVENT,
  POLICY_CODES,
  applyKnobRewrite,
  assertKnobsUnchanged,
  buildKnobRewriteAudit,
  effectiveRunKnobs,
  knobChanges,
  snapshotRunKnobs,
} from './approval-policy.mjs'

const BEFORE = { approvalPolicy: 'ask', permissionPreset: 'legion-attended' }
const AFTER = { approvalPolicy: 'never', permissionPreset: 'legion-unattended' }
const AUDIT = Object.freeze({
  runId: 'run-7',
  actor: 'operator-1',
  at: '2026-09-13T00:00:00.000Z',
  reason: '排障：这个 Run 需要无人值守',
})

// ============================================================ ① 改写审计

test('① ★★★ Run 期间改写被拒绝，而**记录仍然留下来了**（before→after + who/when/why）', () => {
  const persisted = []
  let caught = null
  try {
    applyKnobRewrite({ before: BEFORE, after: AFTER, runActive: true, ...AUDIT, persist: (r) => persisted.push(r) })
  } catch (err) {
    caught = err
  }
  assert.equal(caught?.code, POLICY_CODES.FROZEN_DURING_RUN)
  assert.equal(persisted.length, 1, '审计必须**先**落，拒绝是之后的事')
  const rec = persisted[0]
  assert.equal(rec.event, KNOB_REWRITE_EVENT, 'spec line 499：要能作为 Run 事件被读到')
  assert.equal(rec.decision, 'refused')
  assert.equal(rec.runId, 'run-7')
  assert.equal(rec.actor, 'operator-1')
  assert.equal(rec.at, '2026-09-13T00:00:00.000Z')
  assert.equal(rec.reason, AUDIT.reason)
  assert.deepEqual(rec.changes.map((c) => c.key), ['approvalPolicy', 'permissionPreset'])
  assert.deepEqual(rec.before, BEFORE)
  assert.deepEqual(rec.after, AFTER)
  assert.equal(rec.code, POLICY_CODES.FROZEN_DURING_RUN)
  assert.equal(Object.isFrozen(rec), true)
  // ★ 错误里带回那条记录：调用方的 catch 里必须有东西可落库，否则"拒绝"与"没记录"会同时发生。
  assert.equal(caught.audit, rec)
})

test('① ★★★ 先落审计，再拒绝（顺序反了就等于没有审计）', () => {
  // 这段顺序是 PRT-619 唯一不能被重排的地方：
  //   > 一个「先拒绝、拒绝之后才想起来要记审计」的实现，
  //   > 与一个「拒绝真的发生了、而审计里没有」的实现，是同一个东西。
  const order = []
  let caught = null
  try {
    applyKnobRewrite({
      before: BEFORE,
      after: AFTER,
      runActive: true,
      ...AUDIT,
      persist: () => order.push('persist'),
    })
  } catch {
    order.push('throw')
  }
  assert.deepEqual(order, ['persist', 'throw'])
})

test('② ★★★ 缺 who / when / why 就建不出记录，改写也就无从发生', () => {
  // 一条"改了、但不知道是谁、什么时候、为什么改的"记录，与没有记录，
  // 在事后追责上是同一个东西——所以这里不是"补个默认值"，是**拒绝**。
  for (const field of ['actor', 'at', 'reason']) {
    const input = { before: BEFORE, after: AFTER, runActive: false, ...AUDIT }
    delete input[field]
    let persisted = 0
    assert.throws(
      () => applyKnobRewrite({ ...input, persist: () => { persisted += 1 } }),
      (err) => err.code === POLICY_CODES.REWRITE_UNAUDITED,
      field,
    )
    assert.equal(persisted, 0, `${field} 缺失时连审计都不该被尝试写入`)
  }
  // 空字符串 / 空白同样不算"说过了"
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.throws(
      () => buildKnobRewriteAudit({ before: BEFORE, after: AFTER, runActive: false, ...AUDIT, actor: bad }),
      (err) => err.code === POLICY_CODES.REWRITE_UNAUDITED,
      String(bad),
    )
  }
})

test('② ★★ 没有落点（`persist`）就不许改', () => {
  assert.throws(
    () => applyKnobRewrite({ before: BEFORE, after: AFTER, runActive: false, ...AUDIT }),
    (err) => err.code === POLICY_CODES.REWRITE_UNAUDITED,
  )
})

test('③ ★★★ 拒绝的判定与审计的 before→after 来自**同一份**计算', () => {
  //   > 一个「拒绝的理由说改了 A、审计里记的是 B」的实现，
  //   > 与一个「拒绝与记录各算一遍、迟早对不上」的实现，是同一个东西。
  let thrown = null
  try {
    assertKnobsUnchanged({ before: BEFORE, after: AFTER, runActive: true })
  } catch (err) {
    thrown = err
  }
  const rec = buildKnobRewriteAudit({ before: BEFORE, after: AFTER, runActive: true, ...AUDIT })
  assert.equal(thrown?.code, POLICY_CODES.FROZEN_DURING_RUN)
  assert.equal(rec.decision, 'refused')
  assert.deepEqual(knobChanges(BEFORE, AFTER).map((c) => c.key), rec.changes.map((c) => c.key))
  // 拒绝信息里点名的键，必须与记录里的键一致
  for (const c of rec.changes) assert.match(thrown.message, new RegExp(c.key))
  // 没改就不该有 changes（否则"没改也记一笔"，审计里全是噪音）
  assert.deepEqual(knobChanges(BEFORE, { ...BEFORE }), [])
  assert.equal(buildKnobRewriteAudit({ before: BEFORE, after: { ...BEFORE }, runActive: true, ...AUDIT }).decision, 'applied')
})

test('③ ★★ 改写之后的旋钮必须合法（否则审计成了"这是一次合法变更"的证明）', () => {
  for (const bad of ['nver', 'NEVER', null, undefined, '']) {
    assert.throws(
      () => buildKnobRewriteAudit({ before: BEFORE, after: { ...BEFORE, approvalPolicy: bad }, runActive: false, ...AUDIT }),
      (err) => err.code === POLICY_CODES.BAD_POLICY,
      String(bad),
    )
  }
  // preset 也不许改成 DSH 默认表里的名字（复用默认表 = 无人值守时沙箱被降级）
  assert.throws(
    () => buildKnobRewriteAudit({ before: BEFORE, after: { ...BEFORE, permissionPreset: 'default' }, runActive: false, ...AUDIT }),
    (err) => err.code === POLICY_CODES.BAD_PRESET,
  )
})

test('③ ★★ 未运行时改写允许，但**同样**留审计', () => {
  const persisted = []
  const rec = applyKnobRewrite({
    before: BEFORE, after: AFTER, runActive: false, ...AUDIT, persist: (r) => persisted.push(r),
  })
  assert.equal(rec.decision, 'applied')
  assert.equal(rec.code, null)
  assert.equal(persisted.length, 1, '允许的改写也要留痕——"改过"本身是事实')
  // 缺 runId 的改写记录不下来：Run 事件指不到任何一次 Run
  assert.throws(
    () => buildKnobRewriteAudit({ before: BEFORE, after: AFTER, runActive: false, ...AUDIT, runId: '' }),
    (err) => err.code === POLICY_CODES.BAD_INPUT,
  )
})

// ============================================================ ④ Run 快照

test('④ ★★★ Run 的生效旋钮**只**来自 Run 启动时的快照', () => {
  //   > 一个「用现场旋钮回答这次 Run 的权限档位」的实现，
  //   > 与一个「Run 结束后审计里写着它用过的策略，而那个策略是它跑完之后才被设上的」
  //   > 的实现，是同一个东西。
  const snapshot = snapshotRunKnobs({ ...BEFORE, runId: 'run-7' })
  assert.equal(snapshot.runId, 'run-7')
  assert.deepEqual(snapshot.knobs, BEFORE)
  // preset 的**绑定**（sandbox + approval）一起进快照：名字指向一张可能被改过的表
  assert.deepEqual(snapshot.binding, { sandbox: 'workspace-write', approval: 'ask' })
  assert.match(snapshot.snapshotHash, /^sha256:[0-9a-f]{64}$/)

  // 与快照一致 ⇒ 返回的逐字段等于快照，且标着 fromSnapshot
  const effective = effectiveRunKnobs({ snapshot, current: { ...BEFORE }, runId: 'run-7', runActive: true })
  assert.equal(effective.fromSnapshot, true)
  assert.equal(effective.snapshotHash, snapshot.snapshotHash)
  assert.deepEqual(
    { approvalPolicy: effective.approvalPolicy, permissionPreset: effective.permissionPreset },
    snapshot.knobs,
  )
  // ★ 现场对象上多出来的东西**不会**被带出来 —— 它来自快照，不是来自 current
  const leaked = effectiveRunKnobs({
    snapshot,
    current: { ...BEFORE, sandbox: 'danger-full-access', extra: 1 },
    runId: 'run-7',
    runActive: true,
  })
  assert.equal(leaked.sandbox, undefined)
  assert.equal(leaked.extra, undefined)

  // 漂移 ⇒ 拒绝（同一个 FROZEN_DURING_RUN：Run 期间改动一律不许）
  assert.throws(
    () => effectiveRunKnobs({ snapshot, current: { ...BEFORE, approvalPolicy: 'never' }, runId: 'run-7', runActive: true }),
    (err) => err.code === POLICY_CODES.FROZEN_DURING_RUN,
  )
  // 别的 Run 的快照 ⇒ 拒绝：它与没有快照是同一个东西
  assert.throws(
    () => effectiveRunKnobs({ snapshot, runId: 'run-8', runActive: true }),
    (err) => err.code === POLICY_CODES.STALE_SNAPSHOT,
  )
  // 不是快照的东西不能被当成快照（形状恰好一样也没用）
  for (const bad of [null, {}, { ...BEFORE }, { knobs: BEFORE }]) {
    assert.throws(
      () => effectiveRunKnobs({ snapshot: bad, runActive: true }),
      (err) => err.code === POLICY_CODES.KNOB_SNAPSHOT_MALFORMED,
      JSON.stringify(bad),
    )
  }
})

test('④ ★★ Run 不在跑时生效的是**现场**旋钮，并把差异带出来（好让新 Run 重拍快照）', () => {
  const snapshot = snapshotRunKnobs({ ...BEFORE, runId: 'run-7' })
  const live = effectiveRunKnobs({ snapshot, current: AFTER, runId: 'run-7', runActive: false })
  assert.equal(live.fromSnapshot, false)
  assert.equal(live.snapshotHash, null)
  assert.equal(live.approvalPolicy, 'never')
  assert.deepEqual(live.changedSince.map((c) => c.key), ['approvalPolicy', 'permissionPreset'])
  // 不给 current ⇒ 抛：把上一次的快照当成现在的旋钮，会让新 Run 带着旧旋钮启动
  assert.throws(
    () => effectiveRunKnobs({ snapshot, runActive: false }),
    (err) => err.code === POLICY_CODES.BAD_INPUT,
  )
})

test('④ ★★ 快照身份是**内容**的（同一组旋钮 = 同一份快照），且必须校验旋钮', () => {
  const a = snapshotRunKnobs({ ...BEFORE, runId: 'run-1' })
  const b = snapshotRunKnobs({ ...BEFORE, runId: 'run-2' })
  const c = snapshotRunKnobs({ approvalPolicy: 'never', permissionPreset: 'legion-unattended', runId: 'run-1' })
  assert.equal(a.snapshotHash, b.snapshotHash, '同一组旋钮的快照是同一个身份（runId 不进哈希）')
  assert.notEqual(a.snapshotHash, c.snapshotHash)
  // policy / preset 都要校验，且**不给默认值**
  for (const bad of ['nver', null, undefined, 'Ask']) {
    assert.throws(
      () => snapshotRunKnobs({ approvalPolicy: bad, permissionPreset: 'legion-attended', runId: 'run-1' }),
      (err) => err.code === POLICY_CODES.BAD_POLICY,
      String(bad),
    )
  }
  assert.throws(
    () => snapshotRunKnobs({ approvalPolicy: 'ask', permissionPreset: 'default', runId: 'run-1' }),
    (err) => err.code === POLICY_CODES.BAD_PRESET,
  )
  // 没有 Run 身份就没有"Run 期间冻结"这回事
  assert.throws(
    () => snapshotRunKnobs({ ...BEFORE, runId: '   ' }),
    (err) => err.code === POLICY_CODES.BAD_INPUT,
  )
  // ★ 注入一张**被改坏的表**：真实表上"无人值守不许降级沙箱"永远为真，
  //   于是那条检查在真实输入上从不执行。
  assert.throws(
    () => snapshotRunKnobs({
      approvalPolicy: 'never',
      permissionPreset: 'legion-unattended',
      runId: 'run-1',
      presetTable: {
        'legion-attended': { sandbox: 'workspace-write', approval: 'ask' },
        'legion-unattended': { sandbox: 'danger-full-access', approval: 'never' },
      },
    }),
    (err) => err.code === POLICY_CODES.PRESET_SANDBOX_DOWNGRADE,
  )
})

// ============================================================ ⑤ 装载自检

test('⑤ ★★★ 装载期留下的是**计算值**，而且反向控制真的被拦下', () => {
  const e = APPROVAL_POLICY_CHECKED.knobFreezeAudit
  assert.deepEqual([...KNOB_KEYS], ['approvalPolicy', 'permissionPreset'])
  // 快照
  assert.equal(e.snapshot.runId, 'run-1')
  assert.match(e.snapshot.snapshotHash, /^sha256:/)
  assert.equal(e.snapshot.binding.sandbox, 'workspace-write')
  // 被拒绝的那一次留了完整记录
  assert.equal(e.refusedDuringRun.code, POLICY_CODES.FROZEN_DURING_RUN)
  assert.equal(e.refusedDuringRun.decision, 'refused')
  assert.equal(e.refusedDuringRun.event, KNOB_REWRITE_EVENT)
  assert.deepEqual(e.refusedDuringRun.changedKeys, ['approvalPolicy', 'permissionPreset'])
  assert.equal(typeof e.refusedDuringRun.actor, 'string')
  assert.equal(typeof e.refusedDuringRun.at, 'string')
  assert.equal(typeof e.refusedDuringRun.reason, 'string')
  // 未运行时允许，并且两条都落了审计
  assert.equal(e.appliedWhenIdle.code, 'NO-THROW')
  assert.equal(e.appliedWhenIdle.decision, 'applied')
  assert.equal(e.persistedCount, 2)
  // 缺 who/when/why：一次都没落库（否则"缺字段"会静默变成"记了一笔空的"）
  assert.deepEqual(e.unaudited.map((u) => u.field), ['actor', 'at', 'reason'])
  for (const u of e.unaudited) {
    assert.equal(u.code, POLICY_CODES.REWRITE_UNAUDITED, u.field)
    assert.equal(u.persistedCount, 0, u.field)
  }
  assert.equal(e.noPersistCode, POLICY_CODES.REWRITE_UNAUDITED)
  assert.equal(e.drift.code, POLICY_CODES.FROZEN_DURING_RUN)
  assert.equal(e.staleSnapshot.code, POLICY_CODES.STALE_SNAPSHOT)
  assert.equal(e.effectiveMatchesSnapshot, true)
  assert.equal(e.idleEffective.fromSnapshot, false)
  assert.deepEqual(e.idleEffective.changedKeys, ['approvalPolicy', 'permissionPreset'])
  assert.equal(e.tamperedPresetTable, POLICY_CODES.PRESET_SANDBOX_DOWNGRADE)
  // 每一项都必须有内容（防止自检退化成空壳）
  for (const k of Object.keys(e)) assert.ok(e[k] !== null && e[k] !== undefined, k)
})

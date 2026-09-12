// runtime/dsh-composition/repair.test.mjs
// ============================================================================
// PRT-257「修复入口」的后半：**让修复计划真的被行使**
//
// 这一组守的核心只有一条，而它是本仓库里最贵的一条纪律：
//
//   **判据是重新自检，不是 applier 的返回值。**
//
// 修复是唯一一种"做错了反而更糟"的操作。其他任何动作做错，用户看到的是一个
// 仍然坏着的东西；修复做错，用户看到的是一个**看起来修好了**的东西——
// 而强制面依然不在。所以：
//
//   · applier 说自己成功了，只进 `applierSaid`（诊断用），**从不作为判据**；
//   · 复核里**找不到**对应的检查项 → `unverified`，**不是** `fixed`
//     （"查不出来"与"查出来是好的"绝不同形）；
//   · 复核自己失败 → 全部 `unverified`，**不是**全部 `fixed`。
//
// 第二组守的是"哪些动作**不许**被自动执行"：`reapply-composition-patch`
// 明明有能力自动做，却必须要求显式批准——因为 DSH 的用户 profile 是
// `patchReload: 'live'`，往运行中的 profile 写入这一层会**立刻改变正在跑的
// harness 的强制面，包括发起这次修复的那个进程自己**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { repairPlanFor, REPAIR_ACTIONS } from './bootstrap.mjs'
import {
  REPAIR_CODES,
  REPAIR_MODES,
  REPAIR_VERDICTS,
  approvableActions,
  repairActionsOf,
  repairRuntime,
} from './repair.mjs'

const fail = (name, reasons = ['坏了']) => ({ name, ok: false, reasons })
const pass = (name) => ({ name, ok: true, reasons: [] })

/** 一份"三项全没过"的计划。 */
const planThree = () => repairPlanFor({
  checks: [fail('composition-patch-layer'), fail('runtime-probe'), fail('sandbox-enforcement')],
})

/** 一个"执行了 patch 动作之后，那一项就好了"的复核。 */
const recheckAfterPatch = () => async () => ({
  state: 'effective',
  autoExecutionForbidden: false,
  checks: [pass('composition-patch-layer'), pass('runtime-probe'), pass('sandbox-enforcement')],
})

// ============================================================================
// ① 判据是复核，不是 applier 的返回值
// ============================================================================

test('① applier 说自己成功了，但复核说没过 → `still-failing`（**不是** fixed）', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => ({ ok: true, message: '已重新应用' }) },
    // 复核里那一项**仍然没过** —— 这正是"假装修好了"能被抓住的地方
    recheck: async () => ({ checks: [fail('composition-patch-layer'), fail('runtime-probe'), fail('sandbox-enforcement')] }),
  })
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.verdict, 'still-failing',
    'applier 的返回值不能当判据：它说自己成了，与它真的成了，是两件事')
  assert.deepEqual(patched.applierSaid, { ok: true, message: '已重新应用' }, '要留下来供诊断')
  assert.equal(r.ok, false)
})

test('① 复核确认过了 → `fixed`，且 `ok:true` 只在**全部**项都过了才成立', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => 'whatever' },
    recheck: recheckAfterPatch(),
  })
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.verdict, 'fixed')
  // 另外两项是 manual（本产品做不了）→ **未收尾**。把"三项没过"报成 ok:true
  // 会让用户以为修完了，而两项仍然拦着执行。
  assert.equal(r.ok, false, '只修好一项不等于修好了')
  assert.deepEqual(r.outstanding.map((o) => o.check).sort(), ['runtime-probe', 'sandbox-enforcement'])
  assert.equal(r.needsHuman, true)
})

test('① 复核里**没有**这一项 → `unverified`（查不出来与查出来是好的不同形）', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => true },
    // 复核**不再报告**这一项。这比报"没过"更值得警惕：
    // 一项检查从报告里消失，很容易被读成"没问题了"。
    recheck: async () => ({ checks: [fail('runtime-probe'), fail('sandbox-enforcement')] }),
  })
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.verdict, 'unverified')
  assert.notEqual(patched.verdict, 'fixed')
  assert.match(patched.detail, /无法判定/)
  assert.equal(r.ok, false)
})

test('① 复核自己抛错 → 全部 `unverified`，**不能**被读成修好了', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => true },
    recheck: async () => { throw new Error('复核时炸了') },
  })
  assert.equal(r.code, REPAIR_CODES.RECHECK_FAILED)
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.verdict, 'unverified', '复核没跑成时，任何 fixed 都是编的')
  assert.match(patched.detail, /复核没能完成/)
  assert.equal(r.ok, false)
})

test('① 复核返回畸形结果（没有 checks 数组）→ 同样 `unverified`', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => true },
    recheck: async () => ({ autoExecutionForbidden: false }),
  })
  assert.equal(r.outcomes.find((o) => o.check === 'composition-patch-layer').verdict, 'unverified')
  assert.equal(r.rechecked, false, '`rechecked` 是**复核真的跑成了**的标志')
})

test('① 根本没跑任何动作时**不复核**（没有复核对象，也不该伪造一个结论）', async () => {
  let calls = 0
  const r = await repairRuntime({
    plan: planThree(),
    recheck: async () => { calls += 1; return { checks: [] } },
  })
  assert.equal(calls, 0)
  assert.equal(r.attempted, 0)
  assert.equal(r.rechecked, false)
  // 两种待办各归各：`needs-approval` 说"能做，等人点一下"，
  // `manual` 说"本产品做不了"。合成一个会让用户去人工重装本来一键能做的事。
  assert.deepEqual([...new Set(r.outcomes.map((o) => o.verdict))].sort(), ['manual', 'needs-approval'])
})

test('① applier 抛错 → `applier-threw`，且**不参与**复核改写（它没成功执行过）', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => { throw new Error('写不进去') } },
    // 复核说这一项过了——但动作抛错了，所以**不能**记成 fixed。
    // 否则"抛错但恰好环境自己好了"会被记成"修复生效了"，而下一次不会这么走运。
    recheck: recheckAfterPatch(),
  })
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.verdict, 'applier-threw')
  assert.match(patched.detail, /写不进去/)
  assert.equal(r.ok, false)
})

// ============================================================================
// ② 哪些动作**不许**被自动执行
// ============================================================================

test('② `reapply-composition-patch` 没被批准时**一个字节都不写**，且是一条具名待办', async () => {
  let wrote = 0
  const r = await repairRuntime({
    plan: planThree(),
    // 没有 approved
    appliers: { 'reapply-composition-patch': async () => { wrote += 1; return true } },
    recheck: recheckAfterPatch(),
  })
  assert.equal(wrote, 0, '未批准就不能执行——DSH profile 是 live reload，误调用会改掉当前进程的强制面')
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.verdict, 'needs-approval')
  assert.equal(patched.ran, false)
  assert.match(patched.detail, /patchReload/, '要说清为什么需要批准，而不是只说"没批准"')
})

test('② 批准是**逐动作**的：批准了别的动作不会顺带批准它', async () => {
  let wrote = 0
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['install-supported-runtime', 'fix-sandbox-backend'],
    appliers: { 'reapply-composition-patch': async () => { wrote += 1; return true } },
    recheck: recheckAfterPatch(),
  })
  assert.equal(wrote, 0, '别的动作的批准不能顺延到这一项')
  assert.equal(r.outcomes.find((o) => o.check === 'composition-patch-layer').verdict, 'needs-approval')
})

test('② 本产品做不了的动作必须是 `manual`，**不能**给一个假装能做的按钮', async () => {
  const r = await repairRuntime({ plan: planThree() })
  for (const check of ['runtime-probe', 'sandbox-enforcement']) {
    const o = r.outcomes.find((x) => x.check === check)
    assert.equal(o.verdict, 'manual')
    assert.equal(o.ran, false)
    assert.ok(typeof o.detail === 'string' && o.detail !== '', '要说清为什么本产品做不了')
  }
  assert.equal(r.needsHuman, true)
})

test('② 登记为可执行、却没有注入 applier → **可见的接线缺口**，不是 `manual`', async () => {
  const r = await repairRuntime({
    plan: planThree(),
    approved: ['reapply-composition-patch'],
    appliers: {},
    recheck: recheckAfterPatch(),
  })
  const patched = r.outcomes.find((o) => o.check === 'composition-patch-layer')
  assert.equal(patched.code, REPAIR_CODES.NO_APPLIER)
  assert.match(patched.notice, /可以自动化/,
    '要区分"本产品做不了"与"调用方少给了一个东西"——两者的修法不同')
})

test('② 未登记的动作**不许**被当作无事发生（丢掉它 = 那项失败不存在）', async () => {
  const r = await repairRuntime({
    plan: { items: [{ check: 'some-new-check', action: 'some-unregistered-action', label: 'X' }] },
  })
  assert.equal(r.outcomes.length, 1, '没登记的动作也必须在结果里出现')
  assert.equal(r.outcomes[0].verdict, 'manual')
  assert.match(r.outcomes[0].detail, /没有登记/)
  assert.equal(r.ok, false)
})

// ============================================================================
// ③ 计划形状与判决集合
// ============================================================================

test('③ 计划里没有 items 数组 → `BAD_PLAN`，且**不报成功**', async () => {
  for (const bad of [null, undefined, {}, { items: null }, { items: 'x' }]) {
    const r = await repairRuntime({ plan: bad })
    assert.equal(r.ok, false, `空计划不能报成功：${JSON.stringify(bad)}`)
    assert.equal(r.code, REPAIR_CODES.BAD_PLAN)
  }
})

test('③ 每一项判决都在 `REPAIR_VERDICTS` 里（判决表是**总的**）', async () => {
  const r = await repairRuntime({
    plan: repairPlanFor({ checks: [fail('composition-patch-layer'), fail('runtime-probe')] }),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => { throw new Error('x') } },
    // 复核跑成、但不报这两项
    recheck: async () => ({ checks: [] }),
  })
  for (const o of r.outcomes) {
    assert.ok(REPAIR_VERDICTS.includes(o.verdict), `判决「${o.verdict}」不在表里：判决表必须覆盖所有出口`)
  }
})

test('③ `approvableActions()` 只列**登记为可执行**的动作，且与 `REPAIR_ACTIONS` 对得上', async () => {
  const list = approvableActions()
  const all = Object.values(REPAIR_ACTIONS).map((v) => v.action)
  for (const a of list) assert.ok(all.includes(a), `${a} 不在 REPAIR_ACTIONS 里`)
  for (const a of all) {
    if (REPAIR_MODES[a]?.via === 'applier') assert.ok(list.includes(a), `${a} 登记为可执行却没被列出来`)
    else assert.ok(!list.includes(a), `${a} 不是可执行的，不该出现在批准列表里`)
  }
})

test('③ `repairActionsOf` 逐项给出动作名（含未登记的）', async () => {
  // 返回值是**冻结**的：调用方不该原地重排它（那是这个函数的输出，
  // 不是它的私有数组）。所以这里先复制再排。
  assert.deepEqual([...repairActionsOf(planThree())].sort(),
    ['fix-sandbox-backend', 'install-supported-runtime', 'reapply-composition-patch'])
  assert.deepEqual(repairActionsOf(null), [])
  assert.equal(Object.isFrozen(repairActionsOf(planThree())), true, '返回值必须是冻结的')
})

test('③ 没有未解决项时 `code` 是 null、`needsHuman` false（真修完的样子）', async () => {
  const r = await repairRuntime({
    plan: repairPlanFor({ checks: [fail('composition-patch-layer')] }),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => true },
    recheck: recheckAfterPatch(),
  })
  assert.equal(r.ok, true)
  assert.equal(r.code, null)
  assert.equal(r.needsHuman, false)
  assert.deepEqual(r.outstanding, [])
  assert.equal(r.rechecked, true)
})

test('③ `unverified` 不计入 `needsHuman`——它要的是**再查一次**，不是人工去修', async () => {
  const r = await repairRuntime({
    plan: repairPlanFor({ checks: [fail('composition-patch-layer')] }),
    approved: ['reapply-composition-patch'],
    appliers: { 'reapply-composition-patch': async () => true },
    recheck: async () => { throw new Error('炸了') },
  })
  assert.equal(r.outstanding.length, 1)
  assert.equal(r.outstanding[0].verdict, 'unverified')
  assert.equal(r.needsHuman, false)
})

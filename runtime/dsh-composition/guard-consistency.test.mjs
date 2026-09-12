// runtime/dsh-composition/guard-consistency.test.mjs
// ============================================================================
// 判据：PRT-620（「已由 pre-execute 放行且获得 `allowed-once` 的调用
//       不得被 ToolGuard 拒绝」的一致性不变量）
//
// spec §6.8 line 437：`tools/pre-execute` 的职责之一就是"**静态禁令提前拒绝**
//   以避免无效询问"。
// spec §6.8 line 479：任何已由 pre-execute 放行且获得 `allowed-once` 的调用，
//   不得再被 `ctx.tools.guard()` 拒绝；guard 只有降级语义、没有 allow 语义；
//   出现"人工已批准但仍被 guard 拒绝"即视为**强制面配置错误**，
//   **必须能由审计定位到具体强制点**。
//
// ## 为什么这条不变量值得一个检查器
//
// 因为它违反时**每个点单看都是绿的**：pre-execute 按自己的规则放行、guard 按自己的
// 规则拒绝，两个点各自都对，而合起来出现一条"人批了、又被拒了"的记录——
// 那条记录在审计里没有修复动作（改策略？改 floor？改审批链？）。
//
//   > 一个「每个强制点单看都是绿的」的强制面，
//   > 与一个「点与点之间已经矛盾了」的强制面，是同一个东西——
//   > 只不过前者的现象是"这次怎么又被拒了"，而不是任何一条报错。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENFORCEMENT_SOURCES,
  createHardFloorGuard,
  createPreExecutePolicy,
} from './enforcement.mjs'
import {
  FLOOR_PROBE_EXECUTIONS,
  FLOOR_PROBE_FLOOR,
  GUARD_CONSISTENCY_CHECKED,
  MAPPING_CODES,
  checkApprovedCallsSurviveGuard,
  checkGuardApprovalConsistency,
  guardApprovalPairs,
} from './enforcement-mapping.mjs'

const pair = (over) => ({
  callId: 'c1',
  toolName: 'write',
  preExecute: { kind: 'allow' },
  approval: null,
  guard: { reason: null },
  ...over,
})

// ============================================================ ① 真实下限

test('① ★★★ 真实探针下限下：放行过的调用一次都没被 guard 拒绝', () => {
  const r = checkApprovedCallsSurviveGuard(guardApprovalPairs())
  assert.equal(r.ok, true)
  assert.deepEqual(r.violations, [])
  // 这一次真的验了东西：3 个样本里 1 个放行、2 个被 guard 拒绝
  assert.equal(r.pairs, FLOOR_PROBE_EXECUTIONS.length)
  assert.equal(r.throughCount, 1)
  assert.equal(r.guardDeniedCount, 2)
  assert.deepEqual(r.points, [])
})

test('① ★★ 探针样本必须把**两条**下限分支都走到，且真的出现了 deny', () => {
  // 这是我自己踩过的坑：样本字段写成 `toolName` 时，"按工具名拒绝"那一类下限
  // **静默不生效**——样本全部 pass、检查全绿、`throughCount` 还更大。
  //
  //   > 一个「样本全是 pass」的探针，
  //   > 与一个「下限根本没被走到」的探针，在"它到底验了什么"上是同一个东西。
  const guard = createHardFloorGuard(FLOOR_PROBE_FLOOR)
  assert.match(guard({ name: 'shell.exec', arguments: {} }), /静态禁止/)
  // guard 读的是 `name`；换成 `toolName` 它就什么都不管了 —— 所以样本必须用 `name`
  assert.equal(guard({ toolName: 'shell.exec', arguments: {} }), undefined)

  const pairs = guardApprovalPairs()
  const denied = pairs.filter((p) => p.guard.reason !== null)
  assert.equal(denied.length, 2, '按工具名与按路径各一个')
  assert.match(denied.find((p) => p.toolName === 'shell.exec').guard.reason, /静态禁止/)
  assert.match(denied.find((p) => p.toolName === 'write').guard.reason, /静态禁止范围/)
  // 被拒绝的样本，pre-execute 侧也必须是 deny（这正是"提前拒绝"）
  for (const p of denied) assert.equal(p.preExecute.kind, 'deny')
})

// ============================================================ ② 违规必须能被造出来

test('② ★★★ pre-execute 的静态下限一旦缩水，违规立刻出现并**点名 guard**', () => {
  //   > 一个「hard floor 只在 guard 一处生效」的接线，
  //   > 与一个「人批了之后仍然被 guard 拒绝、而审计里找不到该修哪里」的接线，
  //   > 是同一个东西。
  const shrunk = guardApprovalPairs({ preExecuteFloor: () => undefined })
  const r = checkApprovedCallsSurviveGuard(shrunk)
  assert.equal(r.ok, false)
  assert.equal(r.violations.length, 2, '两个被 guard 拒绝的样本现在都"已放行"')
  for (const v of r.violations) {
    assert.equal(v.code, MAPPING_CODES.GUARD_DENIED_APPROVED)
    // ★ spec line 479 的原话：必须能由审计**定位到具体强制点**
    assert.equal(v.point, 'guard')
    assert.equal(v.auditSource, 'guard')
    assert.ok(ENFORCEMENT_SOURCES.includes(v.auditSource), '审计口径里必须真有这个来源')
    assert.match(v.callId, /^probe-floor-/)
    assert.match(v.detail, /已经放行/)
  }
  assert.deepEqual(r.points, ['guard'])
  assert.equal(r.throughCount, 3)
})

test('② ★★★ `ask` + `allowed-once` 之后被 guard 拒绝 → 违规（人批了不许再被打回）', () => {
  const r = checkApprovedCallsSurviveGuard([
    pair({ preExecute: { kind: 'ask' }, approval: { outcome: 'allowed-once' }, guard: { reason: 'hard floor：工具 rm 被静态禁止' } }),
  ])
  assert.equal(r.ok, false)
  assert.equal(r.throughCount, 1)
  const v = r.violations[0]
  assert.equal(v.code, MAPPING_CODES.GUARD_DENIED_APPROVED)
  assert.equal(v.point, 'guard')
  assert.match(v.detail, /approval=allowed-once/)
  assert.match(v.detail, /静态禁止/, '理由要原样带进违规里，否则值班的人看不到 guard 说了什么')
})

test('② ★★ 反方向：`ask` 还没拿到批准时被 guard 拒绝**不是**违规（那是正常的终审）', () => {
  for (const approval of [null, { outcome: 'rejected' }, { outcome: 'unavailable' }]) {
    const r = checkApprovedCallsSurviveGuard([pair({ preExecute: { kind: 'ask' }, approval })])
    assert.equal(r.ok, true, JSON.stringify(approval))
    assert.equal(r.throughCount, 0)
  }
  // pre-execute 自己就 deny 的调用被 guard 拒绝，同样不是违规（guard 是终审，不是矛盾）
  const d = checkApprovedCallsSurviveGuard([pair({ preExecute: { kind: 'deny', reason: 'x' }, guard: { reason: 'y' } })])
  assert.equal(d.ok, true)
  assert.equal(d.guardDeniedCount, 1)
})

// ============================================================ ③ guard 没有 allow

test('③ ★★★ guard 报出 `allow` → 违规（它只有降级语义）', () => {
  //   > 一个「会放行的 guard」，
  //   > 与一个「同步、确定性、最终单调拒绝的 guard」，不是同一个东西。
  const r = checkApprovedCallsSurviveGuard([pair({ guard: { decision: 'allow', reason: null } })])
  assert.equal(r.ok, false)
  assert.equal(r.violations[0].code, MAPPING_CODES.GUARD_HAS_ALLOW_SEMANTICS)
  assert.equal(r.violations[0].point, 'guard')
  assert.match(r.violations[0].detail, /allow/)
})

test('③ ★★ 判定的闭集与形状：`reason` 缺省即"不动"，畸形对报为违规而不是抛', () => {
  // `guard.reason === null/undefined` = 不动（guard 的契约里没有 "allow" 这个返回值）
  assert.equal(checkApprovedCallsSurviveGuard([pair({ guard: {} })]).ok, true)
  assert.equal(checkApprovedCallsSurviveGuard([pair({ guard: { reason: undefined } })]).ok, true)
  // 畸形：判不了的对不能当作"没问题"
  const bad = checkApprovedCallsSurviveGuard([
    pair({ callId: 'bad-1', preExecute: { kind: 'maybe' } }),
    pair({ callId: 'bad-2', guard: { decision: 'permit' } }),
    pair({ callId: 'bad-3', preExecute: {} }),
  ])
  assert.equal(bad.ok, false)
  assert.equal(bad.violations.length, 3)
  for (const v of bad.violations) assert.equal(v.code, MAPPING_CODES.PAIR_MALFORMED)
  assert.deepEqual(bad.violations.map((v) => v.point).sort(), ['guard', 'pre-execute', 'pre-execute'])
  assert.equal(bad.violations.find((v) => v.callId === 'bad-1').point, 'pre-execute')
  assert.equal(bad.violations.find((v) => v.callId === 'bad-2').point, 'guard')
  // 空输入 / 非数组：不炸，也不假装验过
  for (const empty of [[], null, undefined, 'x']) {
    const r = checkApprovedCallsSurviveGuard(empty)
    assert.equal(r.ok, true)
    assert.equal(r.pairs, 0)
  }
})

// ============================================================ ④ 自检

test('④ ★★★ 自检的反向控制真的会红（不会红的检查等于不存在的检查）', () => {
  const e = GUARD_CONSISTENCY_CHECKED
  assert.equal(e.consistent.ok, true)
  assert.equal(e.tampered.ok, false)
  assert.equal(e.tampered.violations.length, e.probeFloor.denyTools + e.probeFloor.denyPathPrefixes)
  assert.equal(e.tamperedCaught, true)
  // 被拦下的那些确实是"已经放行"的调用，否则它拦的不是这条不变量
  assert.equal(e.tamperedThrough, e.probeFloor.executions, '下限缩水之后**全部**样本都被 pre-execute 放行')
  assert.ok(e.tamperedThrough > e.tampered.violations.length, '放行了 3 个、guard 只拦下 2 个：放行不等于被拒')
  assert.deepEqual(e.probeFloor, { executions: 3, denyTools: 1, denyPathPrefixes: 1 })
  for (const v of e.tampered.violations) {
    assert.equal(v.point, 'guard')
    assert.equal(v.code, MAPPING_CODES.GUARD_DENIED_APPROVED)
  }
})

test('④ ★★ 自检的输入是可注入的：换一份下限，结论跟着换', () => {
  // 一条只在一个写死的输入上跑过的检查，与一条不存在的检查，在"它到底拦住了什么"上
  // 是同一个东西。所以下限必须能从外面换进来。
  const empty = checkGuardApprovalConsistency({ floor: { denyTools: [], denyPathPrefixes: [] } })
  assert.equal(empty.consistent.ok, true)
  assert.equal(empty.consistent.guardDeniedCount, 0, '空下限下 guard 什么都不拦')
  // ★ 而反向控制在空下限上**照样**红不了：它注入的是一个"什么都不拦"的 pre-execute，
  //   而 guard 这时也什么都不拦 ⇒ 没有违规。这不是"检查坏了"，是**探针没内容**——
  //   于是 `ok` 必须是 false：一个没验到东西的检查不许报"通过"。
  assert.equal(empty.tampered.violations.length, 0)
  assert.equal(empty.tamperedCaught, false)
  assert.equal(empty.ok, false, '没验到东西 ⇒ 不许读成"没问题"')
  // 有内容的下限（真实探针）上必须红，且整体判"通过"
  const full = checkGuardApprovalConsistency()
  assert.equal(full.tamperedCaught, true)
  assert.equal(full.ok, true)
})

test('④ ★★ 与真实原语一致：pairs 里的 pre-execute 判定就是 guard 那份判定的投影', async () => {
  // 生产里这一投影由 `composePreExecuteFloor` 接在动态策略之前；
  // 这里用真 `createPreExecutePolicy` 跑一遍，证明"下限先判"确实会先于动态策略生效。
  const { composePreExecuteFloor } = await import('./enforcement.mjs')
  let policyCalls = 0
  const decide = composePreExecuteFloor({
    floor: FLOOR_PROBE_FLOOR,
    decide: () => { policyCalls += 1; return { kind: 'allow' } },
  })
  const listener = createPreExecutePolicy({ decide, connectTimeoutMs: 20, responseTimeoutMs: 20, now: () => 0 })
  const denied = await listener({ name: 'shell.exec', arguments: {} })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /静态禁止/)
  assert.equal(policyCalls, 0, '注定被 guard 拒绝的调用**不该进动态策略**，更不该去问人')
  const passed = await listener({ name: 'read', arguments: { path: 'C:\\Work\\a.txt' } })
  assert.deepEqual(passed, { kind: 'allow' })
  assert.equal(policyCalls, 1)
  // 而这条路径产出的对，与探针造出来的对是同一件事
  const r = checkApprovedCallsSurviveGuard(guardApprovalPairs())
  assert.equal(r.ok, true)
})

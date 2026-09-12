// runtime/dsh-composition/availability.test.mjs
// ============================================================================
// 判据：PRT-617（策略门与 approval answerer 的**两段**超时、`unavailable`
//       fail-closed 语义）
//
// spec §6.8 line 476：策略门与审批 answerer 必须自带超时，并**分别覆盖连接阶段与
//   响应阶段**；team-hub 进程存活却不响应时工具调用会无限期挂起；超时必须 fail closed
//   ——策略门 deny、answerer 返回 `unavailable`——并写入 audit。
// spec §6.8 line 477：team-hub 不可达时 answerer **不得**"等 team-hub 恢复后再询问"，
//   不得把不可达伪装成待审批。
//
// 一句话：**「超时了」不够，还要说得出是哪一段超时；而「不可达」不许长得像「待审批」。**
//
//   > 一个「超时了、但归因到错的那一段」的分类，
//   > 与一个「把值班的人派去修另一边」的分类，是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_OUTCOMES,
  AVAILABILITY_CHECK_CODES,
  AVAILABILITY_CHECKED,
  AVAILABILITY_CODES,
  AVAILABILITY_CONTRACT,
  ENFORCEMENT_PHASES,
  assertUnavailableIsNotPendingNorRejected,
  createApprovalAnswerer,
  createPreExecutePolicy,
  probeTwoPhaseAvailability,
} from './enforcement.mjs'

const SMALL = { connectTimeoutMs: 10, responseTimeoutMs: 10, now: () => 0 }

/** 跑一次 answerer，把 outcome 与审计载荷一起收回来。 */
async function ask(request, over = {}) {
  const seen = []
  const answerer = createApprovalAnswerer({
    request,
    ...SMALL,
    ...over,
    onOutcome: (o) => seen.push(o),
  })
  const outcome = await answerer({ toolName: 'write', callId: 'c1', reason: 'x' })
  return { outcome, audit: seen[seen.length - 1] ?? null }
}

/** 跑一次策略门，把决定与审计载荷一起收回来。 */
async function gate(decide, over = {}) {
  const seen = []
  const listener = createPreExecutePolicy({
    decide,
    ...SMALL,
    ...over,
    onDecision: (d) => seen.push(d),
  })
  const decision = await listener({ name: 'write', arguments: {} })
  return { decision, audit: seen[seen.length - 1] ?? null }
}

// ============================================================ ① 两段各自可观测

test('① ★★★ 两段可以**分别**观测：连接窗口到期 ≠ 响应窗口到期（修法不同）', async () => {
  // 声明了分阶段契约（`portsPhases`）之后，连接窗口是硬期限。
  const connect = await ask(() => new Promise(() => {}), { portsPhases: true })
  assert.equal(connect.outcome, 'unavailable')
  assert.equal(connect.audit.code, AVAILABILITY_CODES.CONNECT_TIMEOUT)
  assert.equal(connect.audit.phase, 'connect')
  assert.equal(connect.audit.phaseDeclared, true)
  assert.equal(connect.audit.connected, false, '连接从未建立')
  assert.match(connect.audit.detail, /连接阶段/)

  // 自己报了连接建立之后才卡住：这是**另一段**，另一个码。
  const response = await ask(({ onConnected }) => { onConnected(); return new Promise(() => {}) }, { portsPhases: true })
  assert.equal(response.outcome, 'unavailable')
  assert.equal(response.audit.code, AVAILABILITY_CODES.RESPONSE_TIMEOUT)
  assert.equal(response.audit.phase, 'response')
  assert.equal(response.audit.connected, true)
  assert.match(response.audit.detail, /响应阶段/)

  assert.notEqual(connect.audit.code, response.audit.code)
  assert.notEqual(connect.audit.phase, response.audit.phase)
})

test('① ★★ 不自报阶段边界的端口：只报"阶段未自报"，**不猜**是哪一段', async () => {
  //   > 一个「超时了、但归因到错的那一段」的分类，
  //   > 与一个「把值班的人派去修另一边」的分类，是同一个东西。
  const r = await ask(() => new Promise(() => {}), { portsPhases: false })
  assert.equal(r.outcome, 'unavailable')
  assert.equal(r.audit.code, AVAILABILITY_CODES.PHASE_UNREPORTED)
  assert.equal(r.audit.phase, null, '不猜')
  assert.equal(r.audit.phaseDeclared, false)
  assert.match(r.audit.detail, /阶段未自报/)
  // 但它**一定结算了**：没结算才是那个"无限期挂起"的故障
  assert.equal(typeof r.audit.elapsedMs, 'number')
})

test('① ★★★ 端口抛错按"有没有自报连接"归因（不可达 ≠ 本次请求失败）', async () => {
  const before = await ask(() => { throw new Error('ECONNREFUSED 127.0.0.1:1') }, { portsPhases: true })
  assert.equal(before.audit.code, AVAILABILITY_CODES.UNREACHABLE)
  assert.equal(before.audit.phase, 'connect')
  assert.match(before.audit.detail, /ECONNREFUSED/, '原始错误必须留在 detail 里，否则排查时只剩一个码')

  const after = await ask(({ onConnected }) => { onConnected(); throw new Error('boom') }, { portsPhases: true })
  assert.equal(after.audit.code, AVAILABILITY_CODES.PORT_ERROR)
  assert.equal(after.audit.phase, 'response')
  assert.notEqual(before.audit.code, after.audit.code)
})

test('① ★★ 闭集之外的返回 ⇒ MALFORMED ⇒ unavailable（这个 answerer 现在不可信）', async () => {
  for (const weird of ['pending', 'ALLOW', 'yes', 42, {}]) {
    const r = await ask(() => weird, { portsPhases: true })
    assert.equal(r.outcome, 'unavailable', JSON.stringify(weird))
    assert.equal(r.audit.code, AVAILABILITY_CODES.MALFORMED)
    assert.equal(r.audit.phase, null)
  }
})

// ============================================================ ② 不可达不许伪装

test('② ★★★ team-hub 不可达 ⇒ `unavailable`：不是 `rejected`，也不是"等它恢复"', async () => {
  // spec line 477：不得"等 team-hub 恢复后再询问"——等待会突破 Run 的期限约束。
  //
  //   > 一个「把不可达伪装成待审批」的实现，
  //   > 与一个「值班的人盯着一条永远不会有人批的审批」的实现，是同一个东西。
  for (const request of [
    () => { throw new Error('ECONNREFUSED') },
    () => new Promise(() => {}),
  ]) {
    const r = await ask(request, { portsPhases: true })
    assert.equal(r.outcome, 'unavailable')
    assert.notEqual(r.outcome, 'rejected')
    assert.notEqual(r.outcome, 'cancelled')
    assert.ok(APPROVAL_OUTCOMES.includes(r.outcome))
  }
  // 闭集里根本没有"待审批/挂起"这个东西 —— 挂起不是一种 outcome，它就是那个故障本身
  assert.equal(APPROVAL_OUTCOMES.includes('pending'), false)
  assert.equal(APPROVAL_OUTCOMES.includes('hold'), false)
})

test('② ★★★ 策略门在同样的情形下一律 `deny`（不是挂起，也不是放行）', async () => {
  const hang = await gate(() => new Promise(() => {}), { portsPhases: false })
  assert.equal(hang.decision.kind, 'deny')
  assert.equal(hang.audit.code, AVAILABILITY_CODES.PHASE_UNREPORTED)
  assert.match(hang.decision.reason, /fail closed/)
  assert.match(hang.decision.reason, /阶段未自报/, '理由要能读出是哪一段')

  const refused = await gate(() => { throw new Error('ECONNREFUSED') }, { portsPhases: true })
  assert.equal(refused.decision.kind, 'deny')
  assert.equal(refused.audit.code, AVAILABILITY_CODES.UNREACHABLE)
  assert.equal(refused.audit.phase, 'connect')
  assert.match(refused.decision.reason, /连接阶段/)

  // 正常路径不受影响：allow / deny / ask 原样透传
  const ok = await gate(() => ({ kind: 'ask' }), { portsPhases: true })
  assert.deepEqual(ok.decision, { kind: 'ask' })
  assert.equal(ok.audit.code, undefined, '没出故障就不该有故障码')
})

// ============================================================ ③ 预算与实测

test('③ ★★ 总预算不被超过：迟到的连接自报也不能把预算撑成两倍', async () => {
  // 连接窗口用完之后才自报连接，此时响应窗口只能拿**剩下的**预算。
  // 不设这个上限，总耗时会是"连接窗口 + 完整响应窗口 × 2"。
  const connectTimeoutMs = 10
  const responseTimeoutMs = 200
  const started = Date.now()
  const seen = []
  const listener = createPreExecutePolicy({
    decide: (_exec, { onConnected }) => new Promise(() => { setTimeout(onConnected, 200) }),
    connectTimeoutMs,
    responseTimeoutMs,
    portsPhases: false,
    onDecision: (d) => seen.push(d),
  })
  const decision = await listener({ name: 'write', arguments: {} })
  const elapsedMs = Date.now() - started
  assert.equal(decision.kind, 'deny')
  assert.equal(seen[0].code, AVAILABILITY_CODES.RESPONSE_TIMEOUT, '自报过连接之后，卡住的是响应段')
  assert.equal(seen[0].phase, 'response')
  // 预算 210ms；不设上限的话这里会是 ~400ms
  assert.ok(elapsedMs <= 300, `耗时 ${elapsedMs}ms 超过预算上界`)
})

test('③ ★★★ 真定时器实测：每一种成因都**结算**，且落到契约里的码上', async () => {
  const p = await probeTwoPhaseAvailability()
  assert.equal(p.ok, true, JSON.stringify(p.reasons))
  assert.equal(p.rows.length, 8)
  for (const row of p.rows) {
    assert.equal(row.got.settled, true, `${row.id} ${row.what}：没结算就会无限期挂起`)
    assert.equal(row.matches, true, `${row.id} ${row.what}：${JSON.stringify(row.got)}`)
    assert.equal(row.withinBudget, true, `${row.id} ${row.what}：超出预算`)
  }
  // 两段各自出现在实测里，而不是只在文档里
  const phases = new Set(p.rows.map((r) => r.got.phase))
  assert.ok(phases.has('connect'))
  assert.ok(phases.has('response'))
  // 策略门那两条的结局是 deny，不是"挂起"也不是"放行"
  for (const row of p.rows.filter((r) => r.via === 'policy')) {
    assert.equal(row.got.kind, 'deny', row.id)
  }
})

// ============================================================ ④ 一致性判据

test('④ ★★★ 一致性判据真的会红：故障记成 rejected / 决定记成 unavailable / 不结算', () => {
  //   > 一个「检查一个不可能出现的值」的检查，
  //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
  const rows = [
    // ① 故障被伪装成决定：审计里写着"用户拒绝了这次写入"，而用户从没被问过
    { label: '超时记成 rejected', cause: 'connect-timeout', outcome: 'rejected', settled: true, code: AVAILABILITY_CODES.CONNECT_TIMEOUT, phase: 'connect' },
    // ② 反方向：人明确说了不，审计里却写着"问不到人"
    { label: '决定记成 unavailable', cause: 'rejected', outcome: 'unavailable', settled: true, code: null, phase: null },
    // ③ 不结算 = 无限期挂起
    { label: '不可达却不结算', cause: 'unreachable', outcome: 'unavailable', settled: false, code: AVAILABILITY_CODES.UNREACHABLE, phase: 'connect' },
    // ④ 故障没有阶段码 ⇒ 派不到正确的那一边去修
    { label: '没有阶段码', cause: 'response-timeout', outcome: 'unavailable', settled: true, code: null, phase: null },
  ]
  const r = assertUnavailableIsNotPendingNorRejected(rows)
  assert.equal(r.ok, false)
  assert.equal(r.violations.length, 4, JSON.stringify(r.violations.map((v) => v.code)))
  const codes = r.violations.map((v) => v.code)
  assert.ok(codes.includes(AVAILABILITY_CHECK_CODES.FAULT_AS_REJECTED))
  assert.ok(codes.includes(AVAILABILITY_CHECK_CODES.DECISION_AS_FAULT))
  assert.ok(codes.includes(AVAILABILITY_CHECK_CODES.NEVER_SETTLES))
  assert.ok(codes.includes(AVAILABILITY_CHECK_CODES.CODE_UNKNOWN))
  // 每条违规都点名它属于哪个强制点（可定位）
  for (const v of r.violations) assert.equal(v.auditSource, 'approval')
  // 契约本身在正常输入下不误报
  const good = assertUnavailableIsNotPendingNorRejected(
    Object.keys(AVAILABILITY_CONTRACT).map((cause) => ({
      cause,
      outcome: AVAILABILITY_CONTRACT[cause].outcome,
      settled: true,
      code: AVAILABILITY_CONTRACT[cause].code,
      phase: AVAILABILITY_CONTRACT[cause].phase,
    })),
  )
  assert.equal(good.ok, true)
  assert.equal(good.faultRows, 6, '六种故障各自一行')
  assert.equal(good.decisionRows, 3)
})

test('④ ★★ 未知成因不许被放过（判不了的输入不能算"没问题"）', () => {
  const r = assertUnavailableIsNotPendingNorRejected([{ cause: 'team-hub-慢', outcome: 'unavailable', settled: true }])
  assert.equal(r.ok, false)
  assert.equal(r.violations[0].code, AVAILABILITY_CHECK_CODES.CAUSE_UNKNOWN)
})

// ============================================================ ⑤ 装载期自检

test('⑤ ★★★ 装载期留下的是计算值：每个阶段有码、反向控制被拦下', () => {
  const e = AVAILABILITY_CHECKED
  assert.deepEqual([...ENFORCEMENT_PHASES], ['connect', 'response'])
  // 每个阶段都真的有码（"一个码 per 阶段"这句话的可查形式）
  const byPhase = Object.fromEntries(e.phaseCodes.map((p) => [p.phase, p.codes]))
  assert.ok(byPhase.connect.length >= 1)
  assert.ok(byPhase.response.length >= 1)
  assert.ok(byPhase.connect.includes(AVAILABILITY_CODES.CONNECT_TIMEOUT))
  assert.ok(byPhase.response.includes(AVAILABILITY_CODES.RESPONSE_TIMEOUT))
  // 不归因的那两个码不许被塞进某个阶段
  assert.equal(byPhase.connect.includes(AVAILABILITY_CODES.PHASE_UNREPORTED), false)
  assert.equal(byPhase.response.includes(AVAILABILITY_CODES.PHASE_UNREPORTED), false)
  // 声明过的码都必须至少被契约验证过一次
  assert.deepEqual(e.codesInContract.filter((c) => !e.codes.includes(c)), [])
  assert.equal(e.declared.violations, 0)
  assert.equal(e.declared.rows, Object.keys(AVAILABILITY_CONTRACT).length)
  // ★ 反向控制：三行故意写坏的行必须全部被拦下
  assert.equal(e.tampered.violations, e.tampered.rows)
  assert.equal(e.tamperedCaught, true)
  assert.deepEqual(
    [...e.tampered.codes].sort(),
    [
      AVAILABILITY_CHECK_CODES.CODE_UNKNOWN,
      AVAILABILITY_CHECK_CODES.FAULT_AS_REJECTED,
      AVAILABILITY_CHECK_CODES.NEVER_SETTLES,
    ].sort(),
  )
})

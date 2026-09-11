// runtime/adapters/dsh/session-boundary.test.mjs
// ============================================================================
// PRT-211：continuable session 边界的判据。
//
// 两类用例：
//   · **接口面** —— 从运行中注册表核实过的签名与归属划分（防"文档漂移"）
//   · **危险语义** —— 把「等待」误当「恢复」这一类，必须在代码层被拦住
//
// 最有价值的一条是 ④：对**真实** DshRuntimeAdapter 做边界检查。
// 合成的 capability 对象只能证明判据逻辑对，证明不了产品当前状态。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDshRuntimeAdapter } from './index.mjs'
import { OPTIONAL_CAPABILITIES, REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import {
  ADAPTER_PORT_METHODS,
  CONTINUABLE_ASPECTS,
  DSH_CONTINUABLE_SURFACE,
  EVIDENCE_LEVEL,
  OWNERSHIP,
  RECOVERY_DECISIONS,
  checkContinuableBoundary,
  classifyRecovery,
  describeContinuableBoundary,
} from './session-boundary.mjs'

const CAPS_OK = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
})

/** 一个最小可用宿主（只为让 Adapter 能构造起来）。 */
function makeHost(over = {}) {
  return {
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() {
      return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } }
    },
    async startRun() {
      return { result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }), dispose: async () => {} }
    },
    ...over,
  }
}

// ================================================================ ① 接口面

test('① 接口面：五个关注面每个都有归属，且归属是闭集', () => {
  const owners = new Set(['adapters', 'orchestrator', 'host-composition'])
  for (const aspect of CONTINUABLE_ASPECTS) {
    const o = OWNERSHIP[aspect]
    assert.ok(o, `${aspect} 缺少归属`)
    assert.ok(owners.has(o.owner), `${aspect} 的 owner=${o.owner} 不在闭集内`)
    assert.ok(o.detail && o.stage, `${aspect} 必须写清归属理由与责任阶段`)
  }
})

test('① 接口面：真实签名带有 service 与 role，且 role 落在关注面里', () => {
  assert.ok(DSH_CONTINUABLE_SURFACE.length >= 10, '接口面清单过小，可能只抄了一部分')
  for (const s of DSH_CONTINUABLE_SURFACE) {
    assert.ok(typeof s.service === 'string' && s.service !== '')
    assert.ok(typeof s.signature === 'string' && s.signature.length > 10)
    assert.ok(CONTINUABLE_ASPECTS.includes(s.role), `${s.signature} 的 role=${s.role} 不属于任何关注面`)
  }
})

test('① 接口面：三条"看起来像恢复"的能力确实是 DSH 提供的（不是我们编的）', () => {
  // 带上 service 名一起拼：只拼 signature 会丢掉归属，正则也就没法按服务定位
  const sigs = DSH_CONTINUABLE_SURFACE.map((s) => `${s.service}: ${s.signature}`).join('\n')
  assert.match(sigs, /agents: async resume\(options: ResumeAgentOptions\)/)
  assert.match(sigs, /agentLoop: async resume\(ownerCtx/)
  assert.match(sigs, /subagents: async sendMessage\(sender: Agent, targetId: SessionId/)
  assert.match(sigs, /subagents: async startContinuable\(/)
})

test('① 接口面：权限**不是**继承而来 —— setPolicy 按 agent、overrideOf 按 session', () => {
  const perm = DSH_CONTINUABLE_SURFACE.filter((s) => s.role === 'permission')
  assert.ok(perm.length >= 2, '权限面至少要有设置与查询两处')
  assert.ok(perm.some((s) => /setPolicy\(agent: Agent/.test(s.signature)), 'setPolicy 是按 agent 设置的')
  assert.ok(perm.some((s) => /overrideOf\(session: Session\)/.test(s.signature)), 'overrideOf 是按 session 查询的')
  // 这一条是判据而非描述：既然是按 agent 设的，就不存在"子会话自动继承"这回事
  assert.match(OWNERSHIP.permission.detail, /显式设置/)
})

test('① 接口面：证据分级同时包含「已核实」与「未验证」，不许只报前者', () => {
  assert.equal(EVIDENCE_LEVEL.apiSurface, 'api-surface-verified')
  assert.equal(EVIDENCE_LEVEL.behavior, 'behavior-unverified')
  const d = describeContinuableBoundary()
  assert.equal(d.evidenceLevel.behavior, 'behavior-unverified')
  assert.match(d.caveat, /未经端到端验证/)
  for (const a of d.aspects) {
    assert.equal(a.behaviorVerified, false, `${a.aspect} 不得声称行为已验证 —— 本批次没跑过续接`)
  }
})

// ================================================================ ② 危险语义

test('② 恢复语义：resume-same-run 是**等待**，不是"可以再执行一次"', () => {
  const r = classifyRecovery(RECOVERY_DECISIONS.resumeSameRun)
  assert.equal(r.isResumption, false)
  assert.equal(r.action, 'keep-waiting')
  assert.equal(r.mayReExecute, false)
  assert.match(r.note, /继续等/)
})

test('② 恢复语义：already-terminal 下重做是**新 Run**，不是恢复', () => {
  const r = classifyRecovery(RECOVERY_DECISIONS.alreadyTerminal)
  assert.equal(r.isResumption, false)
  assert.equal(r.mayReExecute, false)
  assert.match(r.note, /新 Run/)
})

test('② 恢复语义：outcome-unknown 不许自动重试写入', () => {
  const r = classifyRecovery(RECOVERY_DECISIONS.outcomeUnknown)
  assert.equal(r.action, 'require-human')
  assert.equal(r.mayReExecute, false)
  assert.match(r.note, /禁止/)
})

test('② 恢复语义：任何判定都**不得**给出 mayReExecute=true（保守是刻意的）', () => {
  for (const d of Object.values(RECOVERY_DECISIONS)) {
    assert.equal(classifyRecovery(d).mayReExecute, false, `${d} 不得允许自动重执行`)
  }
})

test('② 恢复语义：未识别的判定归 unknown，且默认不许重试（不是默认允许）', () => {
  for (const bogus of [undefined, null, '', 'resume-everything', 42]) {
    const r = classifyRecovery(bogus)
    assert.equal(r.action, 'unknown')
    assert.equal(r.mayReExecute, false)
    assert.match(r.note, /不得据此自动重试/)
  }
})

test('② 恢复语义：三条判定互不重复（闭集，防止新增一条却忘了归类）', () => {
  const vals = Object.values(RECOVERY_DECISIONS)
  assert.equal(new Set(vals).size, vals.length)
  assert.equal(vals.length, 3)
})

// ================================================================ ③ 边界判据

test('③ 判据：宣称 session-resume 但端口无恢复语义 → UNHONORED_SESSION_RESUME', () => {
  const r = checkContinuableBoundary({ capabilities: { 'session-resume': true }, port: {} })
  assert.equal(r.ok, false)
  const f = r.findings.find((x) => x.code === 'UNHONORED_SESSION_RESUME')
  assert.ok(f, '必须拦住 —— 否则有人会按这个宣称去实现"崩溃后接着跑"，实际得到重跑')
  assert.match(f.detail, /重跑/)
})

test('③ 判据：端口真有 resumeRun 时不报（判据看的是实现，不是名字）', () => {
  const r = checkContinuableBoundary({ capabilities: { 'session-resume': true }, port: { resumeRun: () => {} } })
  assert.equal(r.ok, true)
})

test('③ 判据：不宣称 session-resume 时沉默（不制造噪音）', () => {
  for (const caps of [{}, { 'session-resume': false }, undefined]) {
    assert.equal(checkContinuableBoundary({ capabilities: caps }).ok, true)
  }
})

test('③ 判据：continuable 方法出现在宿主端口上 → ORCHESTRATOR_DUTY_IN_ADAPTER', () => {
  const r = checkContinuableBoundary({ capabilities: {}, port: { sendMessage: () => {}, listDescendants: () => {} } })
  assert.equal(r.ok, false)
  const f = r.findings.find((x) => x.code === 'ORCHESTRATOR_DUTY_IN_ADAPTER')
  assert.ok(f)
  assert.match(f.detail, /sendMessage/)
  assert.match(f.detail, /阶段 3/)
})

test('③ 判据：Adapter 的端口方法集合与其契约一致（只有 startRun/probeRuntime）', () => {
  assert.deepEqual([...ADAPTER_PORT_METHODS].sort(), ['probeRuntime', 'startRun'])
  for (const m of ADAPTER_PORT_METHODS) {
    assert.ok(!/continuable|sendMessage|resume|interrupt/i.test(m), `端口方法 ${m} 不应带续接语义`)
  }
})

// ================================================================ ④ 真实适配器

test('④ 真实适配器：其对外能力集**不含**未兑现的 session-resume', async () => {
  const host = makeHost()
  const a = createDshRuntimeAdapter(host, {})
  await a.probe()
  const caps = await a.getCapabilities()
  const r = checkContinuableBoundary({ capabilities: caps, port: host })
  assert.equal(
    r.ok,
    true,
    `真实适配器对外宣称了自己兑现不了的能力：\n${JSON.stringify(r.findings, null, 1)}`,
  )
})

test('④ 真实适配器：session-resume 是**可选**能力，缺失不报错但必须报 false', async () => {
  assert.ok(OPTIONAL_CAPABILITIES.includes('session-resume'), 'session-resume 应在可选能力表里')
  assert.ok(!REQUIRED_CAPABILITIES.includes('session-resume'), '恢复能力不应是必需项 —— 一次性执行本身就是合法的')
  const a = createDshRuntimeAdapter(makeHost(), {})
  await a.probe()
  const caps = await a.getCapabilities()
  assert.notEqual(caps['session-resume'], true, '未实现跨进程恢复就不得报 true')
})

test('④ 真实适配器：recover() 的判定全部落在已知闭集里', async () => {
  const host = makeHost()
  const a = createDshRuntimeAdapter(host, {})
  await a.probe()

  // 未知 runId（本进程没见过）
  const unknown = await a.recover('never-seen-run')
  assert.ok(Object.values(RECOVERY_DECISIONS).includes(unknown.decision), `未知决定：${unknown.decision}`)
  assert.equal(classifyRecovery(unknown.decision).mayReExecute, false)

  // 已结算
  for await (const _ of a.execute({
    runId: 'run-done', attemptId: 'a', idempotencyKey: 'i', workspaceId: 'w', goalId: 'g', taskId: 'T',
    employeeId: 'e', teamPlanRef: 't', contextSnapshotRef: 'c', modelProfileRef: 'm', budget: {}, timeoutMs: 1000,
    workdir: 'C:/tmp', permissions: { preset: 'legion-attended', tools: [] },
    expectedOutput: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, acceptance: 'ok' },
  })) { /* 消费到底 */ }

  const done = await a.recover('run-done')
  assert.equal(done.decision, RECOVERY_DECISIONS.alreadyTerminal)
  assert.equal(done.resumable, false)
  assert.match(done.reason, /不得重复执行/)
})

test('④ 真实适配器：同 runId 第二次 execute 被拒绝 —— 重执行不是恢复', async () => {
  const host = makeHost({
    startRun: async () => ({ result: new Promise(() => {}), dispose: async () => {} }),
  })
  const a = createDshRuntimeAdapter(host, {})
  await a.probe()
  const req = {
    runId: 'run-dup', attemptId: 'a', idempotencyKey: 'i', workspaceId: 'w', goalId: 'g', taskId: 'T',
    employeeId: 'e', teamPlanRef: 't', contextSnapshotRef: 'c', modelProfileRef: 'm', budget: {}, timeoutMs: 5000,
    workdir: 'C:/tmp', permissions: { preset: 'legion-attended', tools: [] },
    expectedOutput: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, acceptance: 'ok' },
  }
  const first = a.execute(req)
  await first.next() // 让首个事件产出，运行进入活跃态

  // 第二次必须被拒，而不是"默默再跑一遍"
  await assert.rejects(
    async () => { for await (const _ of a.execute(req)) { /* */ } },
    (err) => {
      assert.match(String(err?.message ?? err), /重复|已在运行中|已存在|进行中/)
      return true
    },
    '同 runId 的第二次执行必须被拒绝：把它当"恢复"会得到重复副作用',
  )
  await first.return?.()
})

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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDshRuntimeAdapter } from './index.mjs'
import { OPTIONAL_CAPABILITIES, REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import {
  PIN_STATUS,
  anchorPattern,
  auditFindingAnchors,
  checkDshPins,
  foldSource,
} from './pin-drift.mjs'
import {
  ADAPTER_PORT_METHODS,
  CONTINUABLE_ASPECTS,
  DSH_CONTINUABLE_SURFACE,
  EVIDENCE_LEVEL,
  IMPLEMENTATION_FINDINGS,
  OWNERSHIP,
  RECOVERY_DECISIONS,
  checkContinuableBoundary,
  childPolicyPlan,
  classifyRecovery,
  describeContinuableBoundary,
  implementationFindingsFor,
  ownershipCheckScope,
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
  // ★ 原来断言的是 `/未经端到端验证/` 这**一句话**。加了 `implementation` 一级
  //   之后措辞换了，于是它红了——**红的是措辞，不是判据**。
  //   把判据从"那句话在不在"改成"那件事有没有被说出来"，否则下一个人
  //   只要重写一遍注释就能让这条守不住。
  assert.match(d.caveat, /没有任何一个做过运行时行为验证/)
  assert.match(d.caveat, /不是端到端实验/)
  for (const a of d.aspects) {
    assert.equal(a.behaviorVerified, false, `${a.aspect} 不得声称行为已验证 —— 本批次没跑过续接`)
  }
  // ★ 反面：**不许有任何一面自称 behavior**。
  //   `behaviorVerified:false` 只管住了那个布尔字段；如果有人把某一面的
  //   `evidence` 直接写成 `behavior-unverified`（那个常量名字很像"没验证"，
  //   但它其实是分级里的**最强**一档），上面那条断言**照样绿**。
  for (const a of d.aspects) {
    assert.notEqual(a.evidence, EVIDENCE_LEVEL.behavior,
      `${a.aspect} 标成了 behavior 分级，而本批次一个端到端实验都没跑过`)
  }
})

test('① 接口面：`implementation` 是**挣来的** —— 没有出处的结论不许标这一级', () => {
  // 这一条是本批次新增分级的**门禁**。
  //
  // 「读了实现所以结论确定」是一个很强的声明。它只在**给出出处**时才可核，
  // 而一个不可核的强声明与一个编出来的强声明，在读者那里是同一个东西：
  //
  //   > 一条没有出处的结论，与一条编出来的结论，
  //   > 在读者无法核实这一点上是同一个东西——只不过前者可能是对的。
  for (const a of describeContinuableBoundary().aspects) {
    if (a.evidence !== EVIDENCE_LEVEL.implementation) continue
    const findings = implementationFindingsFor(a.aspect)
    assert.ok(findings.length > 0,
      `${a.aspect} 标了 implementation-verified 却一条结论都没有——那一级是空口声明的`)
    for (const f of findings) {
      assert.match(f.source, /\.ts$/,
        `${a.aspect} 的结论 ${f.code} 必须写出处文件（DSH 的 .ts 路径），好让人自己去核`)
      assert.ok(typeof f.lines === 'string' && f.lines.length > 0,
        `${a.aspect} 的结论 ${f.code} 必须给出处行号或函数名`)
      assert.ok(typeof f.evidence === 'string' && f.evidence.length > 40,
        `${a.aspect} 的结论 ${f.code} 的 evidence 太短——那是一句断言，不是依据`)
    }
  }
  // 反过来：**不许有无主的结论**（挂在一个不存在的面上）。
  for (const f of IMPLEMENTATION_FINDINGS) {
    assert.ok(CONTINUABLE_ASPECTS.includes(f.aspect), `结论 ${f.code} 挂在不存在的面上：${f.aspect}`)
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

// ================================================================ ⑤ 源码级结论的**可执行**部分
//
// 上面那张 `IMPLEMENTATION_FINDINGS` 表是给读的人看的。下面这一组守的是
// 「调用方真的会照着它写」——因为一条只写在表里的结论，
// 与一条没写下来的结论，在代码有没有照做这件事上是同一个东西。

test('⑤ 子会话策略：未显式设置时落到**全局默认**，而**不是**父策略', () => {
  const plan = childPolicyPlan({ childHasOwnPolicy: false, configPolicy: 'ask', parentPolicy: 'never' })
  // ★ 这一条是整组里最要害的：父策略是 `never`（确定性拒绝），
  //   而子会话未设策略时生效的是 `ask`——**子会话比父会话更宽松**。
  //   任何"父拒绝了所以子也会拒绝"的推理都会在这里出错，且方向是放开。
  assert.equal(plan.effectiveIfUnset, 'ask')
  assert.notEqual(plan.effectiveIfUnset, 'never',
    '未显式设置时不得继承父会话的 never —— 那是把一次放宽读成一次继承')
  assert.equal(plan.needsExplicitSet, true)
})

test('⑤ 子会话策略：`configPolicy` 缺省时落到 ask（再往下就没有兜底了）', () => {
  const plan = childPolicyPlan({ childHasOwnPolicy: false })
  assert.equal(plan.effectiveIfUnset, 'ask')
  // 三个入口必须给出**同一个**答案，否则"没配"这件事会有两种后果
  assert.equal(childPolicyPlan({ childHasOwnPolicy: false, configPolicy: null }).effectiveIfUnset, 'ask')
  assert.equal(childPolicyPlan({}).effectiveIfUnset, 'ask')
})

test('⑤ 子会话策略：设过与没设过是**不同的**读数（不许都塌成"有策略")', () => {
  const set = childPolicyPlan({ childHasOwnPolicy: true, configPolicy: 'ask' })
  const unset = childPolicyPlan({ childHasOwnPolicy: false, configPolicy: 'ask' })
  assert.equal(set.needsExplicitSet, false)
  assert.equal(unset.needsExplicitSet, true)
  assert.notEqual(set.effective, unset.effective)
  // ★ 而**生效值恰好相同**时（都回落到 ask）也必须还能被区分——
  //   `setPolicy(child,'ask')` 在全局默认就是 ask 时**一个事件都不写**，
  //   所以"两个会话生效值一样"不代表"两个会话的日志一样"。
  assert.notEqual(set.needsExplicitSet, unset.needsExplicitSet)
})

test('⑤ 子会话策略：传了父策略也**不参与**判定（"传了但没用"要看得见）', () => {
  const a = childPolicyPlan({ childHasOwnPolicy: false, configPolicy: 'ask', parentPolicy: 'never' })
  const b = childPolicyPlan({ childHasOwnPolicy: false, configPolicy: 'ask', parentPolicy: 'ask' })
  // 换掉父策略，结论必须一个字都不变
  assert.equal(a.effectiveIfUnset, b.effectiveIfUnset)
  assert.equal(a.needsExplicitSet, b.needsExplicitSet)
  // 但传进来的值要如实回显，好让调用方看出"我传的这个没被用上"
  assert.equal(a.parentPolicyIgnored, 'never')
  assert.equal(childPolicyPlan({ childHasOwnPolicy: false, configPolicy: 'ask' }).parentPolicyIgnored, null)
})

test('⑤ 归属判定：活体 → 可用但**永不持久**', () => {
  const live = ownershipCheckScope({ live: true })
  assert.equal(live.usable, true)
  // ★ 哪怕它这次答对了，答案也不能进持久授权记录：
  //   重启后同一个 id 会给出不同答案。
  assert.equal(live.durable, false)
})

test('⑤ 归属判定：不在活体注册表里时，false **不等于**"不是你的子会话"', () => {
  const gone = ownershipCheckScope({ live: false })
  assert.equal(gone.usable, false)
  assert.equal(gone.durable, false)
  // ★ 这一条守的是措辞：`isOwnedBy` 此时的 false 只意味着"现在问不到"，
  //   把它读成"越权"会把一次**重启**变成一次**授权失败**。
  assert.match(gone.note, /不代表|只代表/)
  assert.notEqual(gone.code, ownershipCheckScope({ live: true }).code,
    '两种情形必须是不同的码，否则调用方无法分辨该不该重问')
})

test('⑤ 归属判定：三个入参只认 `live === true`（不许把"有值"当成"活着")', () => {
  // `store.get(id)` 落空给 undefined；有人会顺手写 `if (entry)`。
  // 任何 truthy 非 true 的值都不该被接受。
  for (const v of [undefined, null, 0, '', 'yes', 1, {}]) {
    assert.equal(ownershipCheckScope({ live: v }).usable, false, `live=${JSON.stringify(v)} 不该被当成活着`)
  }
  assert.equal(ownershipCheckScope().usable, false)
})

// ============================================================================
// ⑥ 出处锚点：让"写着出处"变成一件**可核对的事**（PRT-211 缺口收口）
//
// `IMPLEMENTATION_FINDINGS` 六条结论各自钉着文件 + "约 177-252"这种字样。
// 而 DSH **不是冻结依赖**：升一次级行号就漂、措辞可能改，而结论会继续以原来的
// 语气留在代码里。这组用例守的是"核对机制本身在不在、对不对"。
//
//   > 一条"写着出处、但没人再核对过"的结论，
//   > 与一条"当初就是编的"结论，在下一个读者眼里是同一个东西——
//   > 只不过前者在库里看起来更像有依据。
//
// ★ 这一组里**最要紧的不是"能通过"**，而是"能不能红"：
// 一个永远说"锚点都在"的核对器，与没有核对器，读起来一模一样。
// ============================================================================

const DSH_ROOT = process.env.DSH_CHECKOUT ?? null
const SKIP_PINS = DSH_ROOT === null || DSH_ROOT === ''
  ? '未配置 DSH_CHECKOUT'
  : (!existsSync(join(DSH_ROOT, 'packages')) ? `DSH_CHECKOUT 下没有 packages/：${DSH_ROOT}` : false)

test('⑥ ★★ 每条结论都必须声明锚点（否则核对会**静默跳过**它）', () => {
  // 这一条不是关于 DSH 的，是关于**机制自己的**：没有它，
  // 以后新增一条结论而忘了写 `anchors` 时，漂移核对会跳过它——
  // 而"跳过了"与"核对通过"在报告里长得一样。
  const problems = auditFindingAnchors(IMPLEMENTATION_FINDINGS)
  assert.deepEqual(problems, [],
    '有结论没声明锚点或锚点不合格：' + JSON.stringify(problems))
  // 而且这条判据**能红**：拿一条真的没锚点的结论喂进去。
  const fake = [{ code: 'FAKE', source: 'x', anchors: [] }]
  assert.equal(auditFindingAnchors(fake).length, 1, '没锚点的结论必须被报出来')
  assert.equal(auditFindingAnchors(fake)[0].status, PIN_STATUS.NO_ANCHOR)
  // 太短的锚点也报（一个在任何文件里都能找到的锚点等于没核）。
  const short = [{ code: 'FAKE2', source: 'x', anchors: ['}'] }]
  assert.equal(auditFindingAnchors(short)[0].status, PIN_STATUS.ANCHOR_TOO_SHORT)
})

test('⑥ ★★ 折行不会造成假漂移（这一条是两个真实误报换来的）', () => {
  // DSH 的注释是折行的：
  //     * ... independent of durable session
  //     * lineage and remains unambiguous ...
  // 两句之间的原文是 `\n   * `——里面有一个 **`*`**，它不是空白。
  // 所以"把锚点的空格换成 `\s+`"这种写法**匹配不上**：本批第一版就是这么写的，
  // 六条里两条因此误报"漂移"，而那两句其实一个字都没变。
  //
  //   > 一条因为探针自己写坏而报出来的"漂移"，
  //   > 与一条真的漂移，在只看"✖ 找不到"这一行时是同一个东西——
  //   > 只不过前者会让人去改一句本来正确的话。
  const src = [
    '  /**',
    '   * Test whether a live agent was created through one exact parent agent\'s',
    '   * scoped context. Runtime ownership is independent of durable session',
    '   * lineage and remains unambiguous when unrelated providers reuse an id.',
    '   * @returns true only while the exact child entry is live under that owner.',
    '   */',
  ].join('\n')
  const folded = foldSource(src)
  // 跨两行的句子，折叠后必须连成一个连续串
  assert.ok(folded.text.includes('independent of durable session lineage and remains'),
    '折行没有被折平：' + folded.text)
  assert.ok(anchorPattern('Runtime ownership is independent of durable session lineage').test(folded.text),
    '跨行锚点必须命中——否则 DSH 每次重排注释都会让门禁变红，而总是叫狼来了的门禁会被关掉')
  // 行号要能回到原文件（只用于给人核实，不参与判定）：这句从第 3 行开始
  const m = anchorPattern('Runtime ownership is independent of durable session lineage').exec(folded.text)
  assert.equal(src.slice(0, folded.map[m.index]).split('\n').length, 3, '行号应指回第 3 行')
  // 反向：**真的**变了的话，必须报找不到。
  assert.equal(anchorPattern('Runtime ownership depends on durable session lineage').test(folded.text), false,
    '措辞真的改了却仍然命中，那这个核对就是恒真的')
})

test('⑥ ★★ 真检出上：六条结论的锚点逐字命中（无 DSH_CHECKOUT 时逐条 skip）', (t) => {
  if (SKIP_PINS !== false) return t.skip(`SKIP：${SKIP_PINS}`)
  const r = checkDshPins({ checkoutRoot: DSH_ROOT })
  assert.equal(r.observed, true)
  assert.equal(r.checkedAnchors, IMPLEMENTATION_FINDINGS.reduce((n, f) => n + f.anchors.length, 0),
    '核到的锚点数必须等于声明数——少了就是有结论被静默跳过')
  const drifted = r.rows.filter((x) => x.status !== PIN_STATUS.OK)
  assert.deepEqual(drifted, [],
    '出处对不上了（要么 DSH 改了，要么锚点抄错了，两种都要人去核）：' + JSON.stringify(drifted))
  assert.equal(r.ok, true)
  // 行号是给人二次核实的提示，所以它必须是个正数，不能是 null
  for (const row of r.rows) {
    for (const a of row.anchors) {
      assert.equal(typeof a.line, 'number', `${row.code} 的锚点没给出行号`)
      assert.ok(a.line > 0)
    }
  }
})

test('⑥ ★★ "没观察"与"没漂移"必须是两个读数（不许把没核过说成通过）', () => {
  // 本仓库为这件事付过学费（PRT-214 的 `..._UNOBSERVED`）：
  // "没人给观察结果"静默变成"观察结果是空"，会报出一个**错的诊断**。
  const none = checkDshPins({ checkoutRoot: null })
  assert.equal(none.observed, false)
  assert.equal(none.ok, false, '没有检出时 ok 必须是 false——"我没核过"不等于"核过了没问题"')
  assert.equal(none.checkedAnchors, 0)
  assert.deepEqual([...none.rows], [])
  // 一个**不存在**的路径同样是"没观察"，不是"漂移"
  const bogus = checkDshPins({ checkoutRoot: join(tmpdir(), 'legion-no-such-checkout-9f3a') })
  assert.equal(bogus.observed, false)
  assert.equal(bogus.driftCount, 0, '不存在检出时不该报"漂移"——那会把一个环境问题报成一个 DSH 问题')
})

test('⑥ ★★ 核对器**能红**：注入一个"文件变了"的 reader', () => {
  // 这一条是这组的反空洞：上面几条量的都是"能通过"，
  // 而一个恒真的核对器同样满足它们。
  //
  // 用注入的 `readFile` 造出"被引文件还在、但那句话没了"的处境。
  const r = checkDshPins({
    checkoutRoot: tmpdir(), // 只为让 observed 为真；真实文件由 readFile 提供
    readFile: (p) => (p.includes('continuation') ? '这个文件里没有那句话' : 'overrideOf config.policy ?? \'ask\' effectivePolicy setApprovalPolicy'),
  })
  assert.equal(r.observed, true)
  assert.equal(r.ok, false, '锚点找不到却报 ok，这个核对器就是恒真的')
  assert.ok(r.driftCount > 0)
  const cont = r.rows.find((x) => x.code === 'SENDER_MUST_BE_LIVE_TARGET_NEED_NOT_BE')
  assert.equal(cont.status, PIN_STATUS.DRIFT)
  assert.ok(cont.missing.length > 0, '要说清楚**缺的是哪一句**，否则排查只能去读源码')

  // 反面：所有锚点都在时必须 ok（否则它就是个恒假的核对器，同样无用）
  const all = IMPLEMENTATION_FINDINGS.flatMap((f) => f.anchors).join(' ')
  const ok = checkDshPins({ checkoutRoot: tmpdir(), readFile: () => all })
  assert.equal(ok.ok, true, '锚点都在时必须报 ok')
})

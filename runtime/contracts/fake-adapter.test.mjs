// runtime/contracts/fake-adapter.test.mjs
// ============================================================================
// FakeRuntimeAdapter 与「无 DSH 编排」测试（PRT-107）
//
// 阶段 1 完成标准（spec §6.1）：
//   **不启动 DSH 即可测试正常、失败、取消、超时和恢复编排。**
//
// 因此本套件最后一段是真正的重点：用契约 + Fake Adapter 跑一个最小编排循环，
// 覆盖正常 / 失败 / 取消 / 超时 / 恢复五条路径。若这段能过，就证明编排逻辑
// 不再需要 DSH 才能被测试——这是阶段 2 之后一切对拍与回归的前提。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ERROR_CODES,
  FAKE_SCENARIOS,
  INJECTABLE_ERROR_CODES,
  RUNTIME_CONTRACT_VERSION,
  assertAdapter,
  assertTerminalContract,
  createFakeRuntimeAdapter,
  createTerminalArbiter,
  isRetryable,
  validateRunEvent,
} from './index.mjs'

const REQUEST = Object.freeze({
  runId: 'run-1',
  attemptId: 'att-1',
  idempotencyKey: 'idem-1',
  workspaceId: 'ws-1',
  goalId: 'goal-1',
  taskId: 'task-1',
  employeeId: 'dev',
  teamPlanRef: 'tp-1',
  contextSnapshotRef: 'snap-1',
  modelProfileRef: 'profile-1',
  budget: { maxCostUsd: 1 },
  timeoutMs: 60000,
  workdir: 'D:/ws',
  env: ['PATH'],
  permissions: { preset: 'legion-attended', tools: ['fs.read'] },
  expectedOutput: { schema: { type: 'object' }, acceptance: '产出 result.json' },
})

const req = (over = {}) => ({ ...REQUEST, ...over })

/** 消费整个事件流。 */
async function collect(adapter, request) {
  const events = []
  for await (const e of adapter.execute(request)) events.push(e)
  return events
}

// ---------------------------------------------------------------- 形状与能力

test('Fake Adapter 满足 RuntimeAdapter 契约形状', () => {
  const a = createFakeRuntimeAdapter()
  const res = assertAdapter(a)
  assert.equal(res.ok, true, res.errors.join('; '))
  assert.equal(a.runtimeContractVersion, RUNTIME_CONTRACT_VERSION)
})

test('健康 / 能力 / 模型 / 档案验证可被编排查询', async () => {
  const a = createFakeRuntimeAdapter({ now: () => 1000 })
  assert.equal((await a.getHealth()).state, 'ready')
  assert.equal((await a.getCapabilities())['tool-permission-enforcement'], true)
  assert.equal((await a.listModels()).length, 1)
  assert.equal((await a.validateProfile({ id: 'fake-model', model: 'fake-1' })).ok, true)
  assert.equal((await a.validateProfile({ id: 'nope', model: 'nope' })).ok, false)
})

test('健康状态可切换，供编排分支测试', async () => {
  const a = createFakeRuntimeAdapter()
  a.setHealth('unavailable')
  assert.equal((await a.getHealth()).state, 'unavailable')
  a.setHealth('ready')
  assert.equal((await a.getHealth()).state, 'ready')
})

// ---------------------------------------------------------------- 场景矩阵

test('全部场景的事件流都满足终态契约（no-terminal 除外）', async () => {
  for (const scenario of Object.keys(FAKE_SCENARIOS)) {
    if (scenario === 'no-terminal') continue
    const a = createFakeRuntimeAdapter()
    a.setScenario('r', scenario)
    const events = await collect(a, req({ runId: 'r' }))
    const res = assertTerminalContract(events)
    assert.equal(res.ok, true, `场景 ${scenario} 违反终态契约：${res.errors.join('; ')}`)
    // 每个事件本身也要合法
    for (const e of events) {
      const v = validateRunEvent(e)
      assert.equal(v.ok, true, `场景 ${scenario} 事件非法：${v.errors.join('; ')}`)
    }
  }
})

test('各场景产出预期的终态类型', async () => {
  for (const [scenario, spec] of Object.entries(FAKE_SCENARIOS)) {
    if (spec.terminal === null) continue
    const a = createFakeRuntimeAdapter()
    a.setScenario('r', scenario)
    const events = await collect(a, req({ runId: 'r' }))
    const last = events[events.length - 1]
    assert.equal(last.type, spec.terminal, `场景 ${scenario} 终态类型不符`)
    assert.equal(last.result.code, spec.code, `场景 ${scenario} 错误码不符`)
  }
})

test('每个可注入错误码确实能产出（故障矩阵无缺口）', async () => {
  // 覆盖度断言：scenario 覆盖的错误码集合应包含除「编排侧产生」之外的常见码。
  // RUNTIME_UNAVAILABLE / RUNTIME_NOT_READY / TOOL_DENIED / SCHEMA_MIGRATION_FAILED /
  // UNSUPPORTED_CAPABILITY 属 Runtime Manager 或权限面产出，不由执行场景注入。
  for (const code of INJECTABLE_ERROR_CODES) {
    assert.ok(ERROR_CODES.includes(code))
  }
  const covered = new Set(Object.values(FAKE_SCENARIOS).map((s) => s.code).filter(Boolean))
  for (const code of ['AUTH_FAILED', 'RATE_LIMITED', 'SECRET_UNAVAILABLE', 'BUDGET_EXCEEDED',
    'CONTEXT_TOO_LARGE', 'INVALID_RESULT', 'TIMEOUT', 'CANCELLED', 'RUNTIME_CRASHED',
    'OUTCOME_UNKNOWN', 'MODEL_UNAVAILABLE']) {
    assert.ok(covered.has(code), `错误码 ${code} 无法注入，编排测试会留缺口`)
  }
})

test('崩溃 / 超时 / 结果未知都标注 outcomeUnknown（不得伪装成功）', async () => {
  for (const scenario of ['crash', 'timeout', 'outcome-unknown']) {
    const a = createFakeRuntimeAdapter()
    a.setScenario('r', scenario)
    const events = await collect(a, req({ runId: 'r' }))
    const terminal = events[events.length - 1]
    assert.equal(terminal.result.outcomeUnknown, true, `场景 ${scenario} 必须标注外部结果未知`)
    assert.notEqual(terminal.result.outcome, 'completed', `场景 ${scenario} 不得记为成功`)
  }
})

test('崩溃 / 超时场景的第一个动作是外部写工具（否则测不出重复写风险）', async () => {
  for (const scenario of ['crash', 'timeout', 'outcome-unknown']) {
    const a = createFakeRuntimeAdapter()
    a.setScenario('r', scenario)
    const events = await collect(a, req({ runId: 'r' }))
    const write = events.find((e) => e.type === 'tool.requested' && e.mutating === true)
    assert.ok(write, `场景 ${scenario} 缺少外部写动作`)
  }
})

test('成功场景产出结构化结果，失败场景不产出', async () => {
  const ok = createFakeRuntimeAdapter()
  const okEvents = await collect(ok, req())
  assert.equal(okEvents[okEvents.length - 1].result.output.status, 'ok')

  const bad = createFakeRuntimeAdapter()
  bad.setScenario('run-1', 'failure')
  const badEvents = await collect(bad, req())
  assert.equal(badEvents[badEvents.length - 1].result.output, null)
})

// ---------------------------------------------------------------- 协议违规注入

test('no-terminal 场景被终态契约检出（编排必须能发现半个流）', async () => {
  const a = createFakeRuntimeAdapter()
  a.setScenario('r', 'no-terminal')
  const events = await collect(a, req({ runId: 'r' }))
  const res = assertTerminalContract(events)
  assert.equal(res.ok, false)
  assert.match(res.errors.join(' '), /缺少终态/)
})

// ---------------------------------------------------------------- 取消

test('取消在事件边界生效，产出 run.cancelled 终态', async () => {
  const a = createFakeRuntimeAdapter()
  a.setScenario('r', 'success')
  const seen = []
  for await (const e of a.execute(req({ runId: 'r' }))) {
    seen.push(e.type)
    if (e.type === 'model.selected') await a.cancel('r')
  }
  const res = assertTerminalContract(seen.map((t, i) => (t === 'run.cancelled'
    ? { type: t, runId: 'r', seq: 99, at: 0, result: { runId: 'r', outcome: 'cancelled' } }
    : { type: t, runId: 'r', seq: i + 1, at: 0 })))
  assert.equal(res.ok, true, res.errors.join('; '))
  assert.equal(seen[seen.length - 1], 'run.cancelled')
})

test('取消后已提交终态被记录，重复取消不重复生效', async () => {
  const a = createFakeRuntimeAdapter()
  await collect(a, req())
  assert.equal(a.settledType('run-1'), 'run.completed')
  const c1 = await a.cancel('run-1')
  const c2 = await a.cancel('run-1')
  assert.deepEqual(c1, c2)
  assert.equal(c1.alreadyTerminal, true)
})

// ---------------------------------------------------------------- 恢复

test('recover 只给判断、不修改 Task 状态（否定性断言）', async () => {
  const a = createFakeRuntimeAdapter()
  a.setScenario('r', 'crash')
  const before = a.callCount('recover')
  const res = await a.recover('r')
  assert.equal(a.callCount('recover'), before + 1)
  assert.equal(res.mutatesTaskState, false)
  assert.equal(res.decision, 'outcome-unknown', '崩溃后不得直接判定可重试')
})

test('未观察到外部副作用的 run，recover 给出新 Attempt 重试', async () => {
  const a = createFakeRuntimeAdapter()
  a.setScenario('r', 'failure')
  const res = await a.recover('r')
  assert.equal(res.decision, 'retry-new-attempt')
})

// ---------------------------------------------------------------- 确定性

test('同一脚本重复执行得到相同事件序列（注入时钟）', async () => {
  let t = 0
  const mk = () => createFakeRuntimeAdapter({ now: () => (t += 1) })
  const shape = (events) => events.map((e) => `${e.seq}:${e.type}`)
  const a1 = await collect(mk(), req())
  const a2 = await collect(mk(), req())
  assert.deepEqual(shape(a1), shape(a2))
})

test('execute 拒绝非法 RunRequest 与未知场景', async () => {
  const a = createFakeRuntimeAdapter()
  await assert.rejects(() => collect(a, { runId: 'r' }), /RunRequest 非法/)
  // setScenario 自身会校验；要注入未知场景需走不校验的 planFor 通道
  const bad = createFakeRuntimeAdapter({ planFor: () => 'not-a-scenario' })
  await assert.rejects(() => collect(bad, req({ runId: 'r' })), /未知 Fake 场景/)
})

// ---------------------------------------------------------------- 编排模拟（阶段 1 完成标准）

/**
 * 最小编排循环：只用 Runtime Contract + Fake Adapter，不含任何 DSH。
 * 它模拟 Orchestrator 在 stage 3 将要做的事：执行 → 判终态 → 决策重试/恢复/人工处置。
 *
 * 一个被测试逼出来的语义：**每次重试都是一个新 Attempt，也就是一个新的 Run**，
 * 因此必须换 `runId`。若沿用同一 runId，终态仲裁器会把第二次尝试的终态判为
 * 「迟到事件」而拒绝提交——这正是 §6.4「重试创建新 attempt，不覆盖历史 attempt」
 * 在契约层面的体现。术语表（spec §4.6）写明 Run 是「Runtime 对一个 Attempt 的
 * 一次模型执行实例」，1 Attempt : 1 Run。
 *
 * @param {object} adapter
 * @param {object} request
 * @param {object} [options]
 * @param {number} [options.maxAttempts]
 * @param {string[]} [options.scenarios] 按尝试次序指定场景；未指定者用 Adapter 默认（成功）
 * @returns {Promise<{outcome: string, attempts: number, events: number, action: string}>}
 */
async function runOrchestration(adapter, request, { maxAttempts = 2, scenarios = [], now = () => 0 } = {}) {
  const arbiter = createTerminalArbiter()
  let attempts = 0
  let eventCount = 0

  while (attempts < maxAttempts) {
    attempts += 1
    const attemptId = `att-${attempts}`
    const runId = `${request.runId}#${attemptId}`
    const planned = scenarios[attempts - 1]
    if (planned) adapter.setScenario(runId, planned)

    let events = []
    try {
      events = await collect(adapter, { ...request, runId, attemptId })
    } catch (err) {
      // 契约级异常按错误码决策
      const decision = isRetryable(err.code, { runtimeReady: true })
      return { outcome: err.code, attempts, events: eventCount, action: decision.retryable ? 'retry' : 'manual' }
    }
    eventCount += events.length

    const check = assertTerminalContract(events)
    if (!check.ok) {
      // 协议违规：不得当成成功，进人工处置
      return { outcome: 'protocol-violation', attempts, events: eventCount, action: 'manual' }
    }

    const terminal = check.terminal
    const commit = arbiter.commit(terminal, now())
    assert.equal(commit.committed, true, '首个终态必须提交成功')

    if (check.outcome === 'completed') {
      return { outcome: 'completed', attempts, events: eventCount, action: 'handoff' }
    }
    if (check.outcome === 'cancelled') {
      return { outcome: 'cancelled', attempts, events: eventCount, action: 'stop' }
    }
    if (check.outcome === 'outcome_unknown') {
      // spec §6.1：不得自动重复写入
      return { outcome: 'outcome_unknown', attempts, events: eventCount, action: 'manual' }
    }

    // failed：按契约裁决是否重试
    const decision = isRetryable(terminal.result.code, {
      confirmedNoExternalEffect: terminal.result.outcomeUnknown === false,
      recoveryJudgment: false,
      explicitFallback: false,
      taskPolicyAllowsNewAttempt: true,
      runtimeReady: true,
    })
    if (!decision.retryable) {
      return { outcome: terminal.result.code, attempts, events: eventCount, action: 'manual' }
    }
  }
  return { outcome: 'exhausted', attempts, events: eventCount, action: 'dead-letter' }
}

test('编排模拟：不启动 DSH 即可跑完正常 / 失败 / 取消 / 超时 / 恢复五条路径', async () => {
  // 正常：9 个事件 = started, model.selected, message.delta,
  // tool.requested/started/completed, artifact.produced, usage.updated, run.completed
  const a1 = createFakeRuntimeAdapter()
  assert.deepEqual(await runOrchestration(a1, req()), { outcome: 'completed', attempts: 1, events: 9, action: 'handoff' })

  // 重试后成功（限流可自动重试）：第一次尝试限流，第二次按默认成功
  const a2 = createFakeRuntimeAdapter()
  const r2 = await runOrchestration(a2, req(), { scenarios: ['rate-limited'] })
  assert.equal(r2.outcome, 'completed')
  assert.equal(r2.attempts, 2, '限流应触发一次自动重试')

  // 取消
  const a3 = createFakeRuntimeAdapter()
  const r3 = await runOrchestration(a3, req(), { scenarios: ['cancelled'] })
  assert.equal(r3.outcome, 'cancelled')
  assert.equal(r3.action, 'stop')

  // 超时：未确认外部副作用 → 不得自动重试，进人工处置
  const a4 = createFakeRuntimeAdapter()
  const r4 = await runOrchestration(a4, req(), { scenarios: ['timeout'] })
  assert.equal(r4.action, 'manual', 'TIMEOUT 且外部结果未知时不得自动重试')
  assert.equal(r4.attempts, 1)

  // 恢复：崩溃后 recover 给出判断，编排据此进人工处置而不是重写
  const a5 = createFakeRuntimeAdapter()
  a5.setScenario('run-1#att-1', 'crash')
  const r5 = await runOrchestration(a5, req(), { scenarios: ['crash'] })
  assert.equal(r5.outcome, 'RUNTIME_CRASHED')
  assert.equal(r5.action, 'manual')
  assert.equal((await a5.recover('run-1#att-1')).decision, 'outcome-unknown')

  // 协议违规（事件流无终态）
  const a6 = createFakeRuntimeAdapter()
  const r6 = await runOrchestration(a6, req(), { scenarios: ['no-terminal'] })
  assert.equal(r6.outcome, 'protocol-violation')
  assert.equal(r6.action, 'manual')
})

test('编排模拟：确定性失败直接进人工处置，不空转重试', async () => {
  const a = createFakeRuntimeAdapter()
  const r = await runOrchestration(a, req(), { scenarios: ['auth-failed'] })
  assert.equal(r.outcome, 'AUTH_FAILED')
  assert.equal(r.attempts, 1)
  assert.equal(r.action, 'manual')
})

test('编排模拟全程未接触任何 DSH 符号（契约自足性）', async () => {
  // 本文件只 import ./index.mjs；若契约泄漏 DSH 依赖，import 本身就会失败。
  // 这里额外断言 Fake Adapter 的调用记录里没有执行引擎内部对象。
  const a = createFakeRuntimeAdapter()
  await collect(a, req())
  const serialized = JSON.stringify(a.calls)
  assert.doesNotMatch(serialized, /Cordis|cordis|@deepseek-ai/)
})

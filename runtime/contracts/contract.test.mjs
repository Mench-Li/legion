// runtime/contracts/contract.test.mjs
// ============================================================================
// Runtime Contract 契约测试（PRT-106）
//
// 阶段 1 完成标准：**不启动 DSH 即可测试正常、失败、取消、超时和恢复编排。**
// 本套件证明这一点，并锁住 spec §6.1 里几条易被实现者各解释一遍的语义。
//
// 分为：
//   ① 错误码与重试分类（含「未确认外部副作用不得重试」）
//   ② 模型档案与明文密钥门禁
//   ③ RunRequest / RunEvent / 终态契约
//   ④ 取消幂等与「首个终态为准」仲裁
//   ⑤ 能力协商与版本匹配（不得静默降级）
//   ⑥ 健康状态 → 行为映射
//   ⑦ 幂等键派生
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ERROR_CATALOG,
  ERROR_CODES,
  RUNTIME_CONTRACT_VERSION,
  REQUIRED_CAPABILITIES,
  RuntimeContractError,
  assertAdapter,
  assertTerminalContract,
  canClaimTasks,
  checkCompatibility,
  createTerminalArbiter,
  deriveToolEffectIdempotencyKey,
  describeError,
  findPlaintextSecrets,
  isRetryable,
  recoveryResult,
  toModelDescriptor,
  validateProfile,
  validateRunEvent,
  validateRunRequest,
} from './index.mjs'

// ---------------------------------------------------------------- 夹具

const VALID_REQUEST = Object.freeze({
  runId: 'run-1',
  attemptId: 'att-1',
  idempotencyKey: 'idem-1',
  workspaceId: 'ws-1',
  goalId: 'goal-1',
  taskId: 'task-1',
  employeeId: 'dev',
  teamPlanRef: 'teamplan-1',
  contextSnapshotRef: 'snapshot-1',
  modelProfileRef: 'profile-1',
  budget: { maxCostUsd: 1 },
  timeoutMs: 60000,
  workdir: 'D:/ws',
  env: ['PATH'],
  permissions: { preset: 'legion-attended', tools: ['fs.read'] },
  expectedOutput: { schema: { type: 'object' }, acceptance: '产出 result.json' },
})

const VALID_PROFILE = Object.freeze({
  id: 'profile-1',
  displayName: '主力模型',
  runtimeType: 'dsh',
  provider: 'example',
  model: 'model-x',
  endpoint: 'https://api.example.com/v1',
  secretRef: 'legion/profile-1',
  reasoningEffort: 'medium',
  limits: { maxCostUsdPerRun: 1 },
})

const terminalEvent = (runId, type, result = { runId, outcome: 'completed' }) => ({
  type,
  runId,
  seq: 2,
  at: 1,
  result,
})

// ---------------------------------------------------------------- ① 错误码

test('① 全部标准错误码都登记在 catalog 且字段完整', () => {
  // spec §6.1 列出的 16 个码
  for (const code of [
    'RUNTIME_UNAVAILABLE', 'RUNTIME_NOT_READY', 'UNSUPPORTED_CAPABILITY', 'SECRET_UNAVAILABLE',
    'AUTH_FAILED', 'MODEL_UNAVAILABLE', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'CONTEXT_TOO_LARGE',
    'TOOL_DENIED', 'TIMEOUT', 'CANCELLED', 'RUNTIME_CRASHED', 'OUTCOME_UNKNOWN', 'INVALID_RESULT',
    'SCHEMA_MIGRATION_FAILED',
  ]) {
    assert.ok(ERROR_CODES.includes(code), `缺少标准错误码 ${code}`)
  }
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    assert.ok(['auto', 'conditional', 'manual', 'never'].includes(entry.retryability), `${code} retryability 非法`)
    assert.ok(['notice', 'warn', 'error'].includes(entry.auditLevel), `${code} auditLevel 非法`)
    assert.ok(entry.userMessage.length > 0, `${code} 缺用户文案`)
  }
})

test('① 用户文案不得泄漏 DSH / Cordis 词汇（spec §4.1）', () => {
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    assert.doesNotMatch(entry.userMessage, /DSH|Cordis|cordis|插件|subagent|preset/i, `${code} 的用户文案泄漏了内部词汇`)
  }
})

test('① 未知错误码描述必须抛错，不得静默兜底', () => {
  assert.throws(() => describeError('NOT_A_REAL_CODE'), RuntimeContractError)
  // 这是 spec §6.1「Adapter 不得自行把未知错误归类为成功或普通可重试错误」的机械保障：
  // 静默返回默认可重试会让未归类错误看起来正常。
  assert.throws(() => new RuntimeContractError('NOPE', 'x'))
})

test('① 确定性失败不得可重试；限流可自动重试', () => {
  assert.equal(isRetryable('TOOL_DENIED').retryable, false)
  assert.equal(isRetryable('CONTEXT_TOO_LARGE').retryable, false)
  assert.equal(isRetryable('UNSUPPORTED_CAPABILITY').retryable, false)
  assert.equal(isRetryable('RATE_LIMITED').retryable, true)
})

test('① TIMEOUT 只有在确认无未知外部副作用时才可重试（spec §6.1）', () => {
  const without = isRetryable('TIMEOUT', {})
  assert.equal(without.retryable, false)
  assert.match(without.reason, /外部副作用/)

  const withConfirm = isRetryable('TIMEOUT', { confirmedNoExternalEffect: true })
  assert.equal(withConfirm.retryable, true)
})

test('① OUTCOME_UNKNOWN 必须人工处置，任何上下文都不自动重试', () => {
  const r = isRetryable('OUTCOME_UNKNOWN', {
    confirmedNoExternalEffect: true,
    recoveryJudgment: true,
    runtimeReady: true,
    explicitFallback: true,
    taskPolicyAllowsNewAttempt: true,
  })
  assert.equal(r.retryable, false)
  assert.match(r.reason, /人工/)
})

test('① 条件重试码各自要求对应前置条件', () => {
  assert.equal(isRetryable('MODEL_UNAVAILABLE', { explicitFallback: true }).retryable, true)
  assert.equal(isRetryable('MODEL_UNAVAILABLE', {}).retryable, false)
  assert.equal(isRetryable('RUNTIME_CRASHED', { recoveryJudgment: true }).retryable, true)
  assert.equal(isRetryable('RUNTIME_CRASHED', {}).retryable, false)
  assert.equal(isRetryable('RUNTIME_UNAVAILABLE', { runtimeReady: true }).retryable, true)
  assert.equal(isRetryable('RUNTIME_UNAVAILABLE', { runtimeReady: false }).retryable, false)
  assert.equal(isRetryable('INVALID_RESULT', { taskPolicyAllowsNewAttempt: true }).retryable, true)
  assert.equal(isRetryable('INVALID_RESULT', {}).retryable, false)
})

test('① RuntimeContractError 不携带执行引擎内部对象', () => {
  const err = new RuntimeContractError('TIMEOUT', '超时', { outcomeUnknown: true })
  assert.equal(err.code, 'TIMEOUT')
  assert.equal(err.outcomeUnknown, true)
  assert.equal(err.userMessage, ERROR_CATALOG.TIMEOUT.userMessage)
  // 契约错误只应暴露可序列化字段
  assert.deepEqual(Object.keys(err.details), [])
})

// ---------------------------------------------------------------- ② 模型档案

test('② 合法 ModelProfile 通过校验并归一化', () => {
  const res = validateProfile(VALID_PROFILE)
  assert.equal(res.ok, true, res.errors.join('; '))
  assert.equal(res.value.id, 'profile-1')
  assert.equal(res.value.reasoningEffort, 'medium')
})

test('② 明文密钥字段直接拒绝（字段名形态）', () => {
  for (const key of ['apiKey', 'api_key', 'password', 'token', 'credential', 'privateKey']) {
    const res = validateProfile({ ...VALID_PROFILE, [key]: 'something' })
    assert.equal(res.ok, false, `${key} 应被拒绝`)
    assert.match(res.errors.join(' '), /密钥|未知字段/)
  }
})

test('② 明文密钥值即使塞进合法字段也拒绝（值形态）', () => {
  const res = validateProfile({ ...VALID_PROFILE, displayName: 'sk-abcdefghijklmnopqrstuvwxyz012345' })
  assert.equal(res.ok, false)
  assert.match(res.errors.join(' '), /明文密钥/)
})

test('② 键名像密钥但值是**数字**时不得判成密钥（`limits.maxTokens` 是限额不是密钥）', () => {
  // 这条是回归：此前的判据只看键名，于是 `maxTokens` / `tokenLimit` /
  // `maxOutputTokens` 这类**限额字段**一律被判成"检测到疑似明文密钥"。
  // 后果不是一个误报，而是**任何带 token 限额的模型档案根本写不进去**，
  // 而报错说"检测到疑似明文密钥：$.limits.maxTokens"——那里一个密钥都没有。
  // 把正常配置报成安全事故，会让人去查错的地方。
  const res = validateProfile({ ...VALID_PROFILE, limits: { maxTokens: 4096, tokenLimit: 8192 } })
  assert.equal(res.ok, true, res.errors.join('; '))
  assert.deepEqual(res.value.limits, { maxTokens: 4096, tokenLimit: 8192 })

  // 而不变量仍在：同样的键名装**字符串**密钥必须照旧被拒
  for (const key of ['maxTokens', 'token', 'apiKey']) {
    const bad = validateProfile({ ...VALID_PROFILE, limits: { [key]: 'sk-abcdefghijklmnopqrstuvwxyz' } })
    assert.equal(bad.ok, false, `limits.${key} 装密钥必须被拒绝`)
  }
  // 键名像密钥、值是对象时，真正的字符串密钥在更深一层仍会被抓到
  const nested = validateProfile({ ...VALID_PROFILE, limits: { token: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } } })
  assert.equal(nested.ok, false, '嵌套的密钥必须仍被拒绝')
})

test('② endpoint 内嵌凭证被拒绝（https://user:pass@host 形态）', () => {
  const res = validateProfile({ ...VALID_PROFILE, endpoint: 'https://user:secret@api.example.com/v1' })
  assert.equal(res.ok, false)
  assert.match(res.errors.join(' '), /内嵌用户名或密码/)
})

test('② secretRef 必须是引用形态，不能是密钥内容', () => {
  const ok = validateProfile({ ...VALID_PROFILE, secretRef: 'legion/profile-1' })
  assert.equal(ok.ok, true, ok.errors.join('; '))
  const bad = validateProfile({ ...VALID_PROFILE, secretRef: 'has space and sk-abcdefghijklmnopqrstuvwx' })
  assert.equal(bad.ok, false)
})

test('② 未知字段被拒绝而非忽略（防止密钥搭便车）', () => {
  const res = validateProfile({ ...VALID_PROFILE, extraThing: 1 })
  assert.equal(res.ok, false)
  assert.match(res.errors.join(' '), /未知字段/)
})

test('② findPlaintextSecrets 能穿透嵌套结构定位路径', () => {
  const hits = findPlaintextSecrets({ a: { b: ['ok', 'sk-abcdefghijklmnop1234567890'] } })
  assert.equal(hits.length, 1)
  assert.equal(hits[0], '$.a.b[1]')
})

test('② toModelDescriptor 不暴露 secretRef 内容，只暴露存在性', () => {
  const d = toModelDescriptor(VALID_PROFILE)
  assert.equal(d.hasCredential, true)
  assert.equal(d.secretRef, undefined)
  assert.doesNotMatch(JSON.stringify(d), /legion\/profile-1/)
})

test('② 非法 ModelProfile 无法转换', () => {
  assert.throws(() => toModelDescriptor({ ...VALID_PROFILE, apiKey: 'x' }))
})

// ---------------------------------------------------------------- ③ RunRequest / RunEvent

test('③ 合法 RunRequest 通过；缺必填字段被拒', () => {
  assert.equal(validateRunRequest(VALID_REQUEST).ok, true)
  for (const field of ['runId', 'permissions', 'expectedOutput', 'timeoutMs', 'workdir']) {
    const bad = { ...VALID_REQUEST }
    delete bad[field]
    const res = validateRunRequest(bad)
    assert.equal(res.ok, false, `缺 ${field} 应被拒绝`)
  }
})

test('③ RunRequest 的权限与验收契约缺失时不得补默认值', () => {
  // spec §4.4：每次执行都要有确定的工具权限与验收；补默认值会产出无法审计的执行
  assert.equal(validateRunRequest({ ...VALID_REQUEST, permissions: {} }).ok, false)
  assert.equal(validateRunRequest({ ...VALID_REQUEST, expectedOutput: { schema: {} } }).ok, false)
  assert.equal(validateRunRequest({ ...VALID_REQUEST, expectedOutput: { acceptance: 'x' } }).ok, false)
})

test('③ 空工具白名单是合法的（该员工不能用任何工具）', () => {
  const res = validateRunRequest({ ...VALID_REQUEST, permissions: { preset: 'legion-unattended', tools: [] } })
  assert.equal(res.ok, true)
})

test('③ timeoutMs / budget 必须是正的有限数', () => {
  assert.equal(validateRunRequest({ ...VALID_REQUEST, timeoutMs: 0 }).ok, false)
  assert.equal(validateRunRequest({ ...VALID_REQUEST, timeoutMs: -1 }).ok, false)
  assert.equal(validateRunRequest({ ...VALID_REQUEST, budget: { maxCostUsd: 0 } }).ok, false)
})

test('③ 事件类型集合与 spec 一致（13 种）', async () => {
  const { RUN_EVENT_TYPES, TERMINAL_EVENT_TYPES } = await import('./run.mjs')
  assert.equal(RUN_EVENT_TYPES.length, 13)
  assert.deepEqual([...TERMINAL_EVENT_TYPES].sort(), ['run.cancelled', 'run.completed', 'run.failed', 'run.outcome_unknown'])
})

test('③ 未知事件类型与非法 seq 被拒绝', () => {
  assert.equal(validateRunEvent({ type: 'nope', runId: 'r', seq: 1, at: 0 }).ok, false)
  assert.equal(validateRunEvent({ type: 'run.started', runId: 'r', seq: 0, at: 0 }).ok, false)
  assert.equal(validateRunEvent({ type: 'run.started', runId: 'r', seq: 1.5, at: 0 }).ok, false)
  assert.equal(validateRunEvent({ type: 'run.started', runId: 'r', seq: 1, at: 0 }).ok, true)
})

test('③ 终态事件必须携带或引用 RunResult', () => {
  const bad = validateRunEvent({ type: 'run.completed', runId: 'r', seq: 1, at: 0 })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /RunResult/)
})

test('③ 终态契约：必须以唯一终态结束', () => {
  const ok = assertTerminalContract([
    { type: 'run.started', runId: 'r', seq: 1, at: 0 },
    terminalEvent('r', 'run.completed'),
  ])
  assert.equal(ok.ok, true, ok.errors.join('; '))
  assert.equal(ok.outcome, 'completed')
})

test('③ 终态契约：缺终态 / 多终态 / 终态非最后，都要被检出', () => {
  const missing = assertTerminalContract([{ type: 'run.started', runId: 'r', seq: 1, at: 0 }])
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join(' '), /缺少终态/)

  const multi = assertTerminalContract([
    terminalEvent('r', 'run.completed'),
    { ...terminalEvent('r', 'run.cancelled'), seq: 3 },
  ])
  assert.equal(multi.ok, false)
  assert.match(multi.errors.join(' '), /2 个终态/)

  const notLast = assertTerminalContract([
    terminalEvent('r', 'run.completed'),
    { type: 'usage.updated', runId: 'r', seq: 3, at: 0 },
  ])
  assert.equal(notLast.ok, false)
  assert.match(notLast.errors.join(' '), /不是事件流的最后一个/)
})

test('③ seq 必须严格递增', () => {
  const res = assertTerminalContract([
    { type: 'run.started', runId: 'r', seq: 5, at: 0 },
    { type: 'usage.updated', runId: 'r', seq: 5, at: 0 },
    terminalEvent('r', 'run.completed'),
  ])
  assert.equal(res.ok, false)
  assert.match(res.errors.join(' '), /严格递增/)
})

// ---------------------------------------------------------------- ④ 仲裁与取消

test('④ 首个终态为准，迟到终态只作诊断（取消 vs 完成竞态）', () => {
  const arbiter = createTerminalArbiter()
  const first = arbiter.commit(terminalEvent('r', 'run.completed'))
  assert.equal(first.committed, true)
  assert.equal(first.outcome, 'completed')

  const late = arbiter.commit({ ...terminalEvent('r', 'run.cancelled'), result: { runId: 'r', outcome: 'cancelled' } })
  assert.equal(late.committed, false, '迟到终态不得改写已提交结论')
  assert.equal(late.outcome, 'completed', '迟到事件返回的仍是已提交结论')
  assert.equal(arbiter.isTerminal('r'), true)
  assert.equal(arbiter.diagnostics().length, 1)
})

test('④ 反序：取消先提交则完成为迟到方', () => {
  const arbiter = createTerminalArbiter()
  assert.equal(arbiter.commit(terminalEvent('r', 'run.cancelled')).outcome, 'cancelled')
  const late = arbiter.commit(terminalEvent('r', 'run.completed'))
  assert.equal(late.committed, false)
  assert.equal(arbiter.get('r').outcome, 'cancelled')
})

test('④ 每次取消都是幂等：重复取消返回同一结论', async () => {
  const { createFakeRuntimeAdapter } = await import('./index.mjs')
  const adapter = createFakeRuntimeAdapter()
  const first = await adapter.cancel('run-x')
  assert.equal(first.alreadyTerminal, false)
  const second = await adapter.cancel('run-x')
  assert.equal(second.alreadyTerminal, false)
  assert.deepEqual(first, second, '重复取消必须返回相同结论')
})

test('④ 已终态的 run 取消时报告 alreadyTerminal，不产生新副作用', async () => {
  const { createFakeRuntimeAdapter } = await import('./index.mjs')
  const adapter = createFakeRuntimeAdapter()
  for await (const _ of adapter.execute(VALID_REQUEST)) { /* 消费到终态 */ }
  const res = await adapter.cancel('run-1')
  assert.equal(res.alreadyTerminal, true)
  assert.equal(res.terminalType, 'run.completed')
})

test('④ recoveryResult 恒不修改 Task 状态且拒绝未知判断', () => {
  const r = recoveryResult({ runId: 'r', decision: 'outcome-unknown' })
  assert.equal(r.mutatesTaskState, false)
  assert.throws(() => recoveryResult({ runId: 'r', decision: 'do-something' }))
})

// ---------------------------------------------------------------- ⑤ 能力与版本

test('⑤ 缺少必需能力时判定不兼容并给出 UNSUPPORTED_CAPABILITY', () => {
  const caps = Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true]))
  for (const missing of REQUIRED_CAPABILITIES) {
    const partial = { ...caps, [missing]: false }
    const res = checkCompatibility({ adapterContractVersion: RUNTIME_CONTRACT_VERSION, capabilities: partial })
    assert.equal(res.compatible, false, `缺少 ${missing} 应不兼容`)
    assert.equal(res.code, 'UNSUPPORTED_CAPABILITY')
    assert.deepEqual(res.missingRequired, [missing])
  }
})

test('⑤ 可选能力缺失不算不兼容，但必须说明应禁用对应功能', () => {
  const caps = Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true]))
  const res = checkCompatibility({ adapterContractVersion: RUNTIME_CONTRACT_VERSION, capabilities: caps })
  assert.equal(res.compatible, true)
  assert.match(res.reason, /可选能力缺失/)
})

test('⑤ 契约主版本精确匹配：不匹配即拒绝，不做向后兼容猜测', () => {
  const caps = Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true]))
  const res = checkCompatibility({ adapterContractVersion: 2, capabilities: caps })
  assert.equal(res.compatible, false)
  assert.match(res.reason, /契约版本不匹配/)
})

test('⑤ assertAdapter 拒绝缺方法或缺契约版本的替身', () => {
  assert.equal(assertAdapter(null).ok, false)
  assert.equal(assertAdapter({ runtimeContractVersion: 1 }).ok, false, '缺方法应被拒')
  const full = {
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    getHealth: () => {}, getCapabilities: () => {}, listModels: () => {},
    validateProfile: () => {}, execute: () => {}, cancel: () => {}, recover: () => {},
  }
  assert.equal(assertAdapter(full).ok, true)
  assert.equal(assertAdapter({ ...full, runtimeContractVersion: 99 }).ok, false)
})

// ---------------------------------------------------------------- ⑥ 健康状态

test('⑥ 只有 ready / degraded 允许认领任务', () => {
  assert.equal(canClaimTasks('ready'), true)
  assert.equal(canClaimTasks('degraded'), true)
  for (const state of ['starting', 'unavailable', 'incompatible', 'upgrading']) {
    assert.equal(canClaimTasks(state), false, `${state} 不应认领任务`)
  }
})

test('⑥ 未知健康状态 fail closed（不认领）', () => {
  // 新增状态时忘记更新映射，后果应是「暂时不干活」而不是「绕过检查继续执行」
  assert.equal(canClaimTasks('some-new-state'), false)
  assert.equal(canClaimTasks(undefined), false)
})

test('⑥ 健康状态到产品状态可读，且 Runtime 不可用时仍不伪装在线', async () => {
  const { runtimeHealth } = await import('./adapter.mjs')
  assert.equal(runtimeHealth({ state: 'unavailable' }).productState, '执行引擎不可用')
  assert.throws(() => runtimeHealth({ state: 'bogus' }))
})

// ---------------------------------------------------------------- ⑦ 幂等键

test('⑦ 同一 Attempt 的同一 Call 重放得到相同幂等键', () => {
  const base = { workspaceId: 'ws', taskId: 't', attemptId: 'a1', callId: 'c1', canonicalOperationHash: 'h1' }
  assert.equal(deriveToolEffectIdempotencyKey(base), deriveToolEffectIdempotencyKey({ ...base }))
})

test('⑦ 新 Attempt 得到新幂等键（否则重试会被外部系统当成重复而静默丢弃）', () => {
  const base = { workspaceId: 'ws', taskId: 't', attemptId: 'a1', callId: 'c1', canonicalOperationHash: 'h1' }
  const retry = { ...base, attemptId: 'a2' }
  assert.notEqual(deriveToolEffectIdempotencyKey(base), deriveToolEffectIdempotencyKey(retry))
})

test('⑦ 幂等键对字段边界敏感（不得用可碰撞拼接）', () => {
  // 若用 `|` 拼接： ("a|b","c") 与 ("a","b|c") 会撞成同一个键
  const x = deriveToolEffectIdempotencyKey({ workspaceId: 'a|b', taskId: 'c', attemptId: '1', callId: '1', canonicalOperationHash: 'h' })
  const y = deriveToolEffectIdempotencyKey({ workspaceId: 'a', taskId: 'b|c', attemptId: '1', callId: '1', canonicalOperationHash: 'h' })
  assert.notEqual(x, y)
})

test('⑦ 缺字段时抛错而不是产出弱键', () => {
  assert.throws(() => deriveToolEffectIdempotencyKey({ workspaceId: 'ws' }))
  assert.throws(() => deriveToolEffectIdempotencyKey({ workspaceId: 'ws', taskId: 't', attemptId: '', callId: 'c', canonicalOperationHash: 'h' }))
})

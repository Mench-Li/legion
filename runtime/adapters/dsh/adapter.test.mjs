// runtime/adapters/dsh/adapter.test.mjs
// ============================================================================
// DshRuntimeAdapter 契约与故障路径测试（PRT-201～PRT-209）
//
// 全部用**假宿主端口**，不启动 DSH。这不是图方便——本套件要覆盖的正是
// 真实 DSH 无法稳定复现的那类故障：`run.result` 永不结算、abort 无效、
// 返回畸形结果、事件流中途断掉。用真 DSH 只能测到「顺利时能跑」。
//
// 每条用例都是「设计里写明的一条规则」的可执行版本，注释里标了出处。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDshRuntimeAdapter, mayHaveExternalEffect, isReadOnlyToolName, READ_ONLY_TOOL_PREFIXES } from './index.mjs'
import { assertHostPort, normalizeRunHandle, DshPortError } from './port.mjs'
import { classifyDshError, classifyStopReason, errorFingerprint } from './errors.mjs'
import { redactValue, redactText, SENSITIVE_KEY_RE, REDACTED } from './redact.mjs'
import { validateStructured, validateExpectedOutput } from './schema.mjs'
import { collectUsage, estimateCostUsd, checkBudget, PRICING } from './usage.mjs'
import { mapDshEvent, createEventEmitter, terminalTypeFor, DSH_EVENT_MAP } from './events.mjs'
import { parseVersion, compareVersion, checkRuntimeVersion, probeRuntime, SUPPORTED_RUNTIME } from './probe.mjs'
import { validateRunRequest, validateRunEvent, assertTerminalContract, RUN_EVENT_TYPES } from '../../contracts/run.mjs'

// ------------------------------------------------------------------ 测试夹具

const CAPS_OK = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
})

const OK_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false,
})

/** 请求构造器。默认只读工具 → 超时应判 TIMEOUT。 */
function makeRequest(over = {}) {
  return {
    runId: 'run-1',
    attemptId: 'att-1',
    idempotencyKey: 'idem-1',
    workspaceId: 'ws-1',
    goalId: 'goal-1',
    taskId: 'T-1',
    employeeId: 'emp-1',
    teamPlanRef: 'tp-1',
    contextSnapshotRef: 'ctx-1',
    modelProfileRef: 'mp-1',
    budget: {},
    timeoutMs: 5000,
    workdir: 'C:/tmp/ws',
    permissions: { preset: 'legion-attended', tools: ['read_file'] },
    expectedOutput: { schema: OK_SCHEMA, acceptance: 'ok 为 true 且无额外字段' },
    ...over,
  }
}

/**
 * 假宿主端口。
 *
 * `result` 默认是一个永不结算的 promise——**故意**如此：
 * 忘记给 result 的用例会超时，而不是悄悄通过。
 */
function makeHost(over = {}) {
  const calls = { startRun: [], probeRuntime: 0, currentModelSelection: 0 }
  const host = {
    calls,
    currentModelSelection() {
      calls.currentModelSelection += 1
      return { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }
    },
    async probeRuntime() {
      calls.probeRuntime += 1
      return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } }
    },
    async startRun(provider, options) {
      calls.startRun.push({ provider, options })
      return { result: new Promise(() => {}), dispose: async () => {} }
    },
    ...over,
  }
  return host
}

/** 一个立即成功结算的宿主。 */
function hostOk(structured = { ok: true }, extra = {}) {
  return makeHost({
    async startRun(provider, options) {
      this.calls.startRun.push({ provider, options })
      return {
        result: Promise.resolve({ stopReason: 'completed', structured, ...extra }),
        dispose: async () => {},
      }
    },
  })
}

/** 收集一次 execute 的全部事件。 */
async function collect(adapter, request = makeRequest()) {
  const events = []
  for await (const ev of adapter.execute(request)) events.push(ev)
  return events
}

async function readyAdapter(host, options = {}) {
  const a = createDshRuntimeAdapter(host, options)
  await a.probe()
  return a
}

// ================================================================ ① 端口校验

test('① 端口缺必需方法时构造即失败，且指明缺什么', () => {
  assert.throws(() => createDshRuntimeAdapter({}, {}), (err) => {
    assert.ok(err instanceof DshPortError)
    assert.match(err.message, /startRun/)
    assert.match(err.message, /probeRuntime/)
    return true
  })
})

test('① 端口不是对象时构造失败', () => {
  assert.throws(() => createDshRuntimeAdapter(null, {}), DshPortError)
  assert.throws(() => createDshRuntimeAdapter('nope', {}), DshPortError)
})

test('① assertHostPort 区分「缺必需」与「可选但类型错」', () => {
  assert.deepEqual(assertHostPort({}).errors.length, 2)
  const r = assertHostPort({ startRun() {}, probeRuntime() {}, currentModelSelection: 42 })
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /currentModelSelection 存在但不是函数/)
})

test('① normalizeRunHandle 对缺 result 的句柄抛错，对缺 dispose 只记警告', () => {
  assert.throws(() => normalizeRunHandle(null), DshPortError)
  assert.throws(() => normalizeRunHandle({}), /缺少可等待的 result/)
  const ok = normalizeRunHandle({ result: Promise.resolve(1), dispose: async () => {} })
  assert.deepEqual(ok.warnings, [])
  const noDispose = normalizeRunHandle({ result: Promise.resolve(1) })
  assert.equal(noDispose.dispose, null)
  assert.match(noDispose.warnings.join(' '), /dispose/)
})

// ================================================================ ② 版本与能力

test('② 版本解析支持 v 前缀与预发布', () => {
  assert.deepEqual(parseVersion('0.1.5-rc.2'), { major: 0, minor: 1, patch: 5, prerelease: 'rc.2' })
  assert.equal(parseVersion('v1.2.3').major, 1)
  assert.equal(parseVersion('1.2.3').prerelease, null)
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(undefined), null)
})

test('② 版本比较按 major/minor/patch 进行', () => {
  assert.equal(compareVersion(parseVersion('1.2.3'), parseVersion('1.2.4')), -1)
  assert.equal(compareVersion(parseVersion('2.0.0'), parseVersion('1.9.9')), 1)
  assert.equal(compareVersion(parseVersion('1.2.3'), parseVersion('1.2.3')), 0)
})

test('② 主版本不符判不兼容', () => {
  const r = checkRuntimeVersion('1.0.0', { supportedMajor: 0, minVersion: '0.1.0' })
  assert.equal(r.compatible, false)
  assert.match(r.reason, /主版本不符/)
})

test('② 预发布版本可运行但被显式标注（当前现场跑的就是 RC）', () => {
  const r = checkRuntimeVersion('0.1.5-rc.2', { supportedMajor: 0, minVersion: '0.1.0' })
  assert.equal(r.compatible, true)
  assert.equal(r.prerelease, true)
  assert.match(r.reason, /预发布/)
})

test('② 无法解析的版本判不兼容，而不是放行', () => {
  const r = checkRuntimeVersion('garbage', SUPPORTED_RUNTIME)
  assert.equal(r.compatible, false)
  assert.equal(r.parsed, null)
})

test('② 能力缺失判不兼容：必须显式为 true', async () => {
  const partial = { ...CAPS_OK }
  delete partial['usage-reporting']
  const p = await probeRuntime(makeHost({ async probeRuntime() { return { version: '0.1.5-rc.2', capabilities: partial } } }))
  assert.equal(p.ok, false)
  assert.deepEqual(p.requiredMissing, ['usage-reporting'])
})

test('② 能力值为非布尔（如 "yes"）视为「没说」，不算具备', async () => {
  const p = await probeRuntime(makeHost({ async probeRuntime() {
    return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK, 'usage-reporting': 'yes' } }
  } }))
  assert.equal(p.ok, false)
  assert.deepEqual(p.requiredMissing, ['usage-reporting'])
})

test('② probeRuntime 抛错 → 不兼容，不抛出', async () => {
  const p = await probeRuntime(makeHost({ async probeRuntime() { throw new Error('boom') } }))
  assert.equal(p.ok, false)
  assert.match(p.reason, /probeRuntime\(\) 失败/)
})

test('② probeRuntime 返回非对象 → 不兼容', async () => {
  const p = await probeRuntime(makeHost({ async probeRuntime() { return null } }))
  assert.equal(p.ok, false)
  assert.match(p.reason, /未返回对象/)
})

test('② 未探测前 getCapabilities 是空集，协商判不兼容（fail closed）', async () => {
  const a = createDshRuntimeAdapter(makeHost(), {})
  assert.deepEqual(await a.getCapabilities(), {})
  const compat = await a.checkCompatibilityNow()
  assert.equal(compat.compatible, false)
  assert.equal(compat.code, 'UNSUPPORTED_CAPABILITY')
  assert.equal((await a.getHealth()).state, 'starting')
})

test('② 探测通过后 health=ready 且协商通过', async () => {
  const a = await readyAdapter(makeHost())
  assert.equal((await a.getHealth()).state, 'ready')
  assert.equal((await a.getHealth()).runtimeVersion, '0.1.5-rc.2')
  assert.equal((await a.checkCompatibilityNow()).compatible, true)
})

test('② 版本不兼容时 health=incompatible（禁止自动执行）', async () => {
  const a = await readyAdapter(makeHost({ async probeRuntime() { return { version: '9.0.0', capabilities: { ...CAPS_OK } } } }))
  assert.equal((await a.getHealth()).state, 'incompatible')
  const compat = await a.checkCompatibilityNow()
  assert.equal(compat.compatible, false)
})

// ================================================================ ③ 正常执行

test('③ 正常执行的事件序列是 started → model.selected → completed', async () => {
  const a = await readyAdapter(hostOk())
  const events = await collect(a, makeRequest())
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'model.selected', 'run.completed'])
})

test('③ 事件全部通过契约自身校验，seq 从 1 严格递增', async () => {
  const a = await readyAdapter(hostOk())
  const events = await collect(a, makeRequest())
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
  for (const ev of events) {
    const r = validateRunEvent(ev)
    assert.equal(r.ok, true, `事件非法：${JSON.stringify(r.errors)}`)
  }
  assert.equal(assertTerminalContract(events).ok, true)
})

test('③ 成功结果的 outcome/code/output 正确，usage 已采集', async () => {
  const a = await readyAdapter(hostOk({ ok: true }, { usage: { tokensIn: 120, tokensOut: 40 } }))
  const events = await collect(a, makeRequest())
  const term = events.at(-1)
  assert.equal(term.result.outcome, 'succeeded')
  assert.equal(term.result.code, null)
  assert.deepEqual(term.result.output, { ok: true })
  assert.equal(term.result.usage.tokensIn, 120)
  assert.equal(term.result.usage.tokensOut, 40)
  assert.equal(term.result.outcomeUnknown, false)
})

test('③ 未配置价格表时 estimatedCostUsd 为 null，不是 0', async () => {
  const a = await readyAdapter(hostOk({ ok: true }, { usage: { tokensIn: 120, tokensOut: 40 } }))
  const events = await collect(a, makeRequest())
  assert.equal(events.at(-1).result.usage.estimatedCostUsd, null)
  assert.equal(PRICING.asOf, 'UNSET')
})

test('③ model.selected 不含 secretRef（引用名不进事件流）', async () => {
  const a = await readyAdapter(makeHost({
    currentModelSelection: () => ({ provider: 'p', model: 'm', secretRef: 'my-secret-ref' }),
    async startRun() { return { result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }), dispose: async () => {} } },
  }))
  const events = await collect(a, makeRequest())
  const sel = events.find((e) => e.type === 'model.selected')
  assert.equal(sel.provider, 'p')
  assert.equal(sel.model, 'm')
  assert.equal(JSON.stringify(sel).includes('my-secret-ref'), false)
})

test('③ 引擎没有事件流时不合成任何细粒度事件', async () => {
  const a = await readyAdapter(hostOk())
  const events = await collect(a, makeRequest())
  const types = new Set(events.map((e) => e.type))
  for (const t of ['message.delta', 'tool.completed', 'tool.started', 'usage.updated']) {
    assert.equal(types.has(t), false, `不得凭空合成 ${t}（那是伪造审计）`)
  }
})

test('③ 宿主事件流存在时逐条映射，未识别事件保留原名', async () => {
  async function* gen() {
    yield { type: 'run.started' }
    yield { type: 'message.delta', text: 'hi' }
    yield { type: 'brand.new.event', detail: 'x' }
  }
  const a = await readyAdapter(makeHost({
    async startRun() {
      return { result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }), dispose: async () => {}, events: gen() }
    },
  }))
  const events = await collect(a, makeRequest())
  const types = events.map((e) => e.type)
  assert.ok(types.includes('message.delta'))
  const unmapped = events.find((e) => e.unmapped === true)
  assert.ok(unmapped, '未映射事件必须出现而不是被丢弃')
  assert.equal(unmapped.dshEventType, 'brand.new.event')
})

test('③ 宿主事件流中途抛错不影响终态判定', async () => {
  async function* gen() {
    yield { type: 'message.delta', text: 'a' }
    throw new Error('stream broke')
  }
  const a = await readyAdapter(makeHost({
    async startRun() {
      return { result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }), dispose: async () => {}, events: gen() }
    },
  }))
  const events = await collect(a, makeRequest())
  assert.equal(events.at(-1).type, 'run.completed')
})

test('③ startRun 收到的是取消信号与结构化 schema', async () => {
  const host = hostOk()
  const a = await readyAdapter(host)
  await collect(a, makeRequest())
  const call = host.calls.startRun[0]
  assert.equal(call.provider, 'deepseek')
  assert.ok(call.options.signal instanceof AbortSignal)
  assert.deepEqual(call.options.outputSchema, OK_SCHEMA)
  assert.equal(call.options.prompt[0].type, 'text')
  assert.match(call.options.prompt[0].text, /T-1/)
})

// ================================================================ ④ 结构化校验

test('④ 缺 required 字段 → INVALID_RESULT，不放行', async () => {
  const a = await readyAdapter(hostOk({ note: 'x' }))
  const events = await collect(a, makeRequest())
  const term = events.at(-1)
  assert.equal(term.type, 'run.failed')
  assert.equal(term.code, 'INVALID_RESULT')
  assert.equal(term.result.output, null)
  assert.match(term.result.userMessage, /缺 required 字段/)
})

test('④ 额外字段（additionalProperties:false）→ 失败', async () => {
  const a = await readyAdapter(hostOk({ ok: true, extra: 1 }))
  const events = await collect(a, makeRequest())
  assert.equal(events.at(-1).code, 'INVALID_RESULT')
})

test('④ 缺少 structured（即使 stopReason=completed）→ 失败，不当成功', async () => {
  const a = await readyAdapter(makeHost({
    async startRun() { return { result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} } },
  }))
  const events = await collect(a, makeRequest())
  assert.equal(events.at(-1).type, 'run.failed')
  assert.equal(events.at(-1).code, 'INVALID_RESULT')
})

test('④ 未知 stopReason 判失败，绝不当作 completed', () => {
  const r = classifyStopReason('something_new')
  assert.equal(r.code, 'INVALID_RESULT')
  assert.equal(r.unknown, true)
  assert.equal(classifyStopReason('completed').code, null)
  assert.equal(classifyStopReason('cancelled').code, 'CANCELLED')
  assert.equal(classifyStopReason('').code, 'INVALID_RESULT')
})

test('④ validateStructured 支持的子集与 fail-closed 边界', () => {
  assert.equal(validateStructured({ type: 'string' }, 'a').ok, true)
  assert.equal(validateStructured({ type: 'integer' }, 3).ok, true)
  assert.equal(validateStructured({ type: 'number' }, 3).ok, true)
  assert.equal(validateStructured({ type: 'integer' }, 3.5).ok, false)
  assert.equal(validateStructured({ enum: ['a', 'b'] }, 'c').ok, false)
  assert.equal(validateStructured({ const: 7 }, 7).ok, true)
  assert.equal(validateStructured({ type: 'array', items: { type: 'string' } }, ['a', 'b']).ok, true)
  assert.equal(validateStructured({ type: 'array', items: { type: 'string' } }, ['a', 2]).ok, false)
  // 未识别的 type 必须判失败（不认识就别放行）
  const unknown = validateStructured({ type: 'fancy-new-type' }, 'x')
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors.join(' '), /不支持的 schema type/)
  // 未声明 schema 也必须失败
  assert.equal(validateStructured(undefined, {}).ok, false)
})

test('④ oneOf 要求恰好一个分支匹配，且分支错误不污染外层', () => {
  const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] }
  assert.equal(validateStructured(schema, 'a').ok, true, '纯字符串应只匹配 string 分支')
  assert.equal(validateStructured(schema, 3).ok, true, '纯数字应只匹配 number 分支')
  const none = validateStructured(schema, true)
  assert.equal(none.ok, false)
  assert.match(none.errors.join(' '), /oneOf 无分支匹配/)
})

test('④ expectedOutput 必须同时声明 schema 与 acceptance', () => {
  assert.equal(validateExpectedOutput({ schema: {}, acceptance: 'x' }).ok, true)
  assert.equal(validateExpectedOutput({ schema: {} }).ok, false)
  assert.equal(validateExpectedOutput({ schema: {}, acceptance: '   ' }).ok, false)
  assert.equal(validateExpectedOutput(null).ok, false)
})

// ================================================================ ⑤ 异常分类

test('⑤ 异常分类：鉴权/限流/网络/崩溃各归其位', () => {
  assert.equal(classifyDshError(new Error('401 Unauthorized')).code, 'AUTH_FAILED')
  assert.equal(classifyDshError(new Error('invalid api key')).code, 'AUTH_FAILED')
  assert.equal(classifyDshError(new Error('429 Too Many Requests')).code, 'RATE_LIMITED')
  assert.equal(classifyDshError(new Error('rate_limit_exceeded')).code, 'RATE_LIMITED')
  assert.equal(classifyDshError(new Error('ECONNREFUSED 127.0.0.1')).code, 'RUNTIME_UNAVAILABLE')
  assert.equal(classifyDshError(new Error('context length exceeded')).code, 'CONTEXT_TOO_LARGE')
  assert.equal(classifyDshError(new Error('tool denied by policy')).code, 'TOOL_DENIED')
  assert.equal(classifyDshError(new Error('model not found')).code, 'MODEL_UNAVAILABLE')
})

test('⑤ 顺序敏感：复合消息按更具体的一类归档', () => {
  // 「429 + quota exhausted」必须先命中限流，而不是被别的规则抢走
  assert.equal(classifyDshError(new Error('429 quota exhausted')).code, 'RATE_LIMITED')
  // 「Unauthorized: rate limit」——鉴权在前，因为重试无意义
  assert.equal(classifyDshError(new Error('401 Unauthorized rate limit')).code, 'AUTH_FAILED')
})

test('⑤ 未知异常归 RUNTIME_CRASHED 并标记 unknown，不假设可重试', () => {
  const c = classifyDshError(new Error('完全没见过的一种故障 zzz'))
  assert.equal(c.code, 'RUNTIME_CRASHED')
  assert.equal(c.unknown, true)
})

test('⑤ 取消与超时靠调用方告知，不靠猜消息', () => {
  assert.equal(classifyDshError(new Error('AbortError'), { abortedBy: 'timeout' }).code, 'TIMEOUT')
  assert.equal(classifyDshError(new Error('AbortError'), { abortedBy: 'caller' }).code, 'CANCELLED')
  // 同样的文本，未告知时不应被误判为取消
  const unknown = classifyDshError(new Error('AbortError'), {})
  assert.notEqual(unknown.code, 'CANCELLED')
})

test('⑤ 错误指纹只取 name/code/message，不含 stack（不泄漏路径）', () => {
  const e = new Error('boom')
  e.code = 'E_TEST'
  const fp = errorFingerprint(e)
  assert.match(fp, /E_TEST/)
  assert.match(fp, /boom/)
  assert.equal(fp.includes('at '), false)
  assert.equal(errorFingerprint(null), '')
  assert.equal(errorFingerprint('plain'), 'plain')
})

// ================================================================ ⑥ 看门狗

test('⑥ run.result 永不结算 + 只读工具 → TIMEOUT（可自动重试）', async () => {
  const a = await readyAdapter(makeHost(), { watchdogGraceMs: 20 })
  const events = await collect(a, makeRequest({ timeoutMs: 30 }))
  const term = events.at(-1)
  assert.equal(term.code, 'TIMEOUT')
  assert.equal(term.result.outcome, 'timed-out')
  assert.equal(term.result.outcomeUnknown, false)
})

test('⑥ run.result 永不结算 + 写类工具 → OUTCOME_UNKNOWN（禁止自动重试）', async () => {
  const a = await readyAdapter(makeHost(), { watchdogGraceMs: 20 })
  const events = await collect(a, makeRequest({
    timeoutMs: 30,
    permissions: { preset: 'x', tools: ['write_file'] },
  }))
  const term = events.at(-1)
  assert.equal(term.code, 'OUTCOME_UNKNOWN')
  assert.equal(term.result.outcomeUnknown, true)
  assert.match(term.result.userMessage, /不|未知|无法/)
})

test('⑥ 看门狗触发时确实 abort 了传给 startRun 的 signal', async () => {
  let seenSignal = null
  const a = await readyAdapter(makeHost({
    async startRun(p, o) { seenSignal = o.signal; return { result: new Promise(() => {}), dispose: async () => {} } },
  }), { watchdogGraceMs: 20 })
  await collect(a, makeRequest({ timeoutMs: 30 }))
  assert.ok(seenSignal instanceof AbortSignal)
  assert.equal(seenSignal.aborted, true, '看门狗必须真的中断引擎，而不只是自己放弃等待')
})

test('⑥ 只读白名单方向正确：认不出的工具一律按「可能写」处理', () => {
  assert.equal(isReadOnlyToolName('read_file'), true)
  assert.equal(isReadOnlyToolName('list_dir'), true)
  assert.equal(isReadOnlyToolName('get_task'), true)
  assert.equal(isReadOnlyToolName('web_fetch'), true)
  assert.equal(isReadOnlyToolName('write_file'), false)
  // 这两个是关键：名字看不出会写，但按保守处理
  assert.equal(isReadOnlyToolName('sync_x'), false)
  assert.equal(isReadOnlyToolName('reconcile_y'), false)
  assert.equal(isReadOnlyToolName(''), false)
  assert.ok(READ_ONLY_TOOL_PREFIXES.includes('read'))
})

test('⑥ mayHaveExternalEffect 的四条优先级', () => {
  // ① 显式声明优先
  assert.equal(mayHaveExternalEffect({ permissions: { tools: ['write_file'], mayHaveExternalEffect: false } }), false)
  assert.equal(mayHaveExternalEffect({ permissions: { tools: ['read_file'], mayHaveExternalEffect: true } }), true)
  // ② 空白名单 = 没有工具能跑
  assert.equal(mayHaveExternalEffect({ permissions: { tools: [] } }), false)
  // ③ 全只读
  assert.equal(mayHaveExternalEffect({ permissions: { tools: ['read_file', 'list_dir'] } }), false)
  // ④ 认不出 / 未声明 → 保守
  assert.equal(mayHaveExternalEffect({ permissions: { tools: ['read_file', 'sync_x'] } }), true)
  assert.equal(mayHaveExternalEffect({ permissions: {} }), true)
})

test('⑥ 超时后迟到的成功结果：记录但不改写终态（历史不可覆盖）', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const a = await readyAdapter(makeHost({
    async startRun() {
      return { result: gate, dispose: async () => {} }
    },
  }), { watchdogGraceMs: 20 })
  const events = await collect(a, makeRequest({ timeoutMs: 30 }))
  assert.equal(events.at(-1).code, 'TIMEOUT')
  // 迟到结果现在才到
  release({ stopReason: 'completed', structured: { ok: true } })
  await new Promise((r) => setTimeout(r, 10))
  const late = a._internals.lateResultsList()
  assert.equal(late.length, 1, '迟到结果必须被记录，不能静默丢弃')
  assert.equal(late[0].runId, 'run-1')
  // 终态不变
  assert.equal(events.at(-1).code, 'TIMEOUT')
})

// ================================================================ ⑦ 取消/恢复

test('⑦ 取消进行中的运行 → CANCELLED，且 already 为 false', async () => {
  const a = await readyAdapter(makeHost(), { cancelGraceMs: 20 })
  const it = a.execute(makeRequest())[Symbol.asyncIterator]()
  await it.next() // run.started
  await it.next() // model.selected
  const res = await a.cancel('run-1')
  assert.equal(res.runId, 'run-1')
  assert.equal(res.accepted, true)
  assert.equal(res.alreadyTerminal, false)
})

test('⑦ 取消未开始的 runId → alreadyTerminal=true，不抛错', async () => {
  const a = await readyAdapter(makeHost())
  const res = await a.cancel('never-existed')
  assert.equal(res.accepted, true)
  assert.equal(res.alreadyTerminal, true)
  assert.equal(res.terminalType, null)
})

test('⑦ recover 对已结算的运行给 already-terminal', async () => {
  const a = await readyAdapter(hostOk())
  await collect(a, makeRequest())
  const r = await a.recover('run-1')
  assert.equal(r.decision, 'already-terminal')
  assert.equal(r.resumable, false)
})

test('⑦ recover 对未知运行给 outcome-unknown（不猜是否已写入）', async () => {
  const a = await readyAdapter(makeHost())
  const r = await a.recover('unknown-run')
  assert.equal(r.decision, 'outcome-unknown')
  assert.equal(r.resumable, false)
  assert.equal(r.mutatesTaskState, false)
})

test('⑦ recover 恰好在运行的给 resume-same-run', async () => {
  const a = await readyAdapter(makeHost(), { cancelGraceMs: 20 })
  const it = a.execute(makeRequest())[Symbol.asyncIterator]()
  await it.next()
  const r = await a.recover('run-1')
  assert.equal(r.decision, 'resume-same-run')
  assert.equal(r.resumable, true)
  await a.cancel('run-1')
})

// ================================================================ ⑧ 重复执行防护

test('⑧ 同一 runId 已结算后再次执行被拒（重试必须新建 Attempt/Run）', async () => {
  const a = await readyAdapter(hostOk())
  await collect(a, makeRequest())
  await assert.rejects(
    async () => { await collect(a, makeRequest()) },
    /已结算|重试必须创建新 Attempt/,
  )
})

test('⑧ 同一 runId 并发执行被拒', async () => {
  const a = await readyAdapter(makeHost(), { cancelGraceMs: 20 })
  const it = a.execute(makeRequest())[Symbol.asyncIterator]()
  await it.next()
  await assert.rejects(
    async () => { await collect(a, makeRequest()) },
    /已在运行中/,
  )
  await a.cancel('run-1')
})

test('⑧ 不同 runId 可并发', async () => {
  const a = await readyAdapter(hostOk())
  const [e1, e2] = await Promise.all([
    collect(a, makeRequest({ runId: 'r-a' })),
    collect(a, makeRequest({ runId: 'r-b' })),
  ])
  assert.equal(e1.at(-1).type, 'run.completed')
  assert.equal(e2.at(-1).type, 'run.completed')
})

test('⑧ 非法 RunRequest 被拒（budget 必填）', async () => {
  const a = await readyAdapter(hostOk())
  await assert.rejects(async () => { await collect(a, makeRequest({ budget: undefined })) }, /budget 必填/)
  // 显式空预算对象是合法的：「声明本次无上限」与「忘了写」不同
  const ok = await collect(a, makeRequest({ budget: {} }))
  assert.equal(ok.at(-1).type, 'run.completed')
})

test('⑧ 请求缺 required 字段或 expectedOutput 不完整都被拒', async () => {
  const a = await readyAdapter(hostOk())
  await assert.rejects(async () => { await collect(a, makeRequest({ workspaceId: '' })) }, /workspaceId 必填/)
  await assert.rejects(
    async () => { await collect(a, makeRequest({ expectedOutput: { schema: {} } })) },
    /acceptance/,
  )
})

test('⑧ validateRunRequest 拒绝非法 timeoutMs', () => {
  assert.equal(validateRunRequest(makeRequest({ timeoutMs: 0 })).ok, false)
  assert.equal(validateRunRequest(makeRequest({ timeoutMs: -5 })).ok, false)
  assert.equal(validateRunRequest(makeRequest({ timeoutMs: Number.POSITIVE_INFINITY })).ok, false)
  assert.equal(validateRunRequest(makeRequest()).ok, true)
})

// ================================================================ ⑨ 脱敏

test('⑨ 按键名脱敏：值长什么样都不看', () => {
  const r = redactValue({ token: 'whatever', headers: { Authorization: 'x' }, nested: { api_key: 'y' }, ok: 'keep' })
  assert.equal(r.value.token, REDACTED)
  assert.equal(r.value.headers.Authorization, REDACTED)
  assert.equal(r.value.nested.api_key, REDACTED)
  assert.equal(r.value.ok, 'keep')
  assert.ok(r.redacted.includes('token'))
  assert.ok(r.redacted.includes('headers.Authorization'))
})

test('⑨ 空值不被替换成标记（避免把「未设置」显示成「有密钥」）', () => {
  const r = redactValue({ token: '', secret: null })
  assert.equal(r.value.token, '')
  assert.equal(r.value.secret, null)
})

test('⑨ 按值形态脱敏：常见密钥前缀与 Bearer', () => {
  const r = redactText('key=sk-abcdefghijklmnop and Bearer abcdefghijklmnop')
  assert.equal(r.text.includes('sk-abcdefghijklmnop'), false)
  assert.equal(r.text.includes('abcdefghijklmnop'), false)
  assert.ok(r.hits.length >= 2)
})

test('⑨ URL 内嵌凭证脱敏后保留主机名（排障还需要它）', () => {
  const r = redactText('https://user:pass@example.com/path')
  assert.equal(r.text.includes('pass'), false)
  assert.match(r.text, /example\.com/)
})

test('⑨ 私钥块整体替换', () => {
  const r = redactText('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')
  assert.equal(r.text.includes('AAAA'), false)
})

test('⑨ 脱敏是有界的：深度与超长字符串被截断', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'too deep' } } } } } } } } } }
  const r = redactValue(deep, { maxDepth: 3 })
  assert.equal(r.redacted.some((p) => /超出最大深度/.test(p)), true)
  const long = redactValue({ note: 'x'.repeat(100) }, { maxStringLength: 10 })
  assert.match(long.value.note, /已截断 90 字符/)
  assert.equal(long.truncated, 1)
})

test('⑨ 循环引用与活对象不导致崩溃或深度枚举', () => {
  const cyc = { name: 'a' }
  cyc.self = cyc
  const r = redactValue(cyc)
  assert.equal(r.value.self, '[循环引用]')
  const withFn = redactValue({ cb: () => 1, s: Symbol('x') })
  assert.equal(withFn.value.cb, '[不可序列化]')
  assert.equal(withFn.value.s, '[不可序列化]')
})

test('⑨ 脱敏路径不含原值（审计不该成为第二个泄漏点）', () => {
  const r = redactValue({ apiKey: 'sk-realsecretvalue123456' })
  assert.equal(JSON.stringify(r.redacted).includes('realsecret'), false)
})

// ================================================================ ⑩ 用量与预算

test('⑩ 无用量信息返回 null（不是「零用量」）', () => {
  assert.equal(collectUsage({ stopReason: 'completed' }), null)
  assert.equal(collectUsage({ usage: {} }), null)
  assert.equal(collectUsage(null), null)
})

test('⑩ 用量字段别名兼容，双取缺失侧补 0', () => {
  assert.equal(collectUsage({ usage: { input_tokens: 5, output_tokens: 7 } }).tokensIn, 5)
  assert.equal(collectUsage({ usage: { promptTokens: 5 } }).tokensOut, 0)
  const u = collectUsage({ usage: { tokensIn: 1, tokensOut: 2 } })
  assert.equal(u.tokensIn, 1)
  assert.equal(u.tokensOut, 2)
})

test('⑩ 价格表未生效或模型无价 → 费用为 null', () => {
  assert.equal(estimateCostUsd({ model: 'm', tokensIn: 1e6, tokensOut: 1e6 }), null)
  const priced = { asOf: '2026-01-01', currency: 'USD', models: { m: { inPerMTok: 1, outPerMTok: 2 } } }
  assert.equal(estimateCostUsd({ model: 'm', tokensIn: 1e6, tokensOut: 1e6, pricing: priced }), 3)
  assert.equal(estimateCostUsd({ model: 'other', tokensIn: 1e6, tokensOut: 0, pricing: priced }), null)
  assert.equal(estimateCostUsd({ model: 'm', tokensIn: 1e6, tokensOut: 0, pricing: { ...priced, asOf: 'UNSET' } }), null)
})

test('⑩ 预算超限被检出；费用未知时不得判为「未超」', () => {
  const over = checkBudget({ budget: { maxTokens: 10 }, usage: { tokensIn: 8, tokensOut: 8, estimatedCostUsd: null } })
  assert.equal(over.kind, 'tokens')
  const unknownCost = checkBudget({ budget: { maxCostUsd: 1 }, usage: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: null } })
  assert.equal(unknownCost.kind, 'cost-unknown', '费用未知不能当成没超预算')
  const fine = checkBudget({ budget: { maxTokens: 100 }, usage: { tokensIn: 1, tokensOut: 1, estimatedCostUsd: null } })
  assert.equal(fine, null)
  // 无预算或无用量 → 无法判定，返回 null 而不是放行结论
  assert.equal(checkBudget({ usage: null }), null)
  assert.equal(checkBudget({ budget: null, usage: { tokensIn: 1, tokensOut: 1, estimatedCostUsd: null } }), null)
})

test('⑩ 超预算的运行以 BUDGET_EXCEEDED 失败，不静默通过', async () => {
  const a = await readyAdapter(hostOk({ ok: true }, { usage: { tokensIn: 500, tokensOut: 500 } }))
  const events = await collect(a, makeRequest({ budget: { maxTokens: 100 } }))
  const term = events.at(-1)
  assert.equal(term.type, 'run.failed')
  assert.equal(term.code, 'BUDGET_EXCEEDED')
  assert.equal(term.result.output, null)
})

// ================================================================ ⑪ 模型与校验配置

test('⑪ listModels 用 toModelDescriptor：只暴露 hasCredential', async () => {
  const a = await readyAdapter(makeHost({
    listModels: async () => [{
      id: 'm1', displayName: '模型一', runtimeType: 'dsh', provider: 'p', model: 'v4',
      secretRef: 'ref-1',
    }],
  }))
  const models = await a.listModels()
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'm1')
  assert.equal(typeof models[0].hasCredential, 'boolean')
  assert.equal(Object.hasOwn(models[0], 'secretRef'), false, '描述子不得带出引用名')
})

test('⑪ listModels 遇到疑似明文密钥时拒绝输出，不渲染给用户', async () => {
  const a = await readyAdapter(makeHost({
    listModels: async () => [{
      id: 'm1', displayName: 'x', runtimeType: 'dsh', provider: 'p', model: 'v4',
      apiKey: 'sk-abcdefghijklmnopqrst',
    }],
  }))
  await assert.rejects(async () => a.listModels(), /疑似明文密钥/)
})

test('⑪ 没有 listModels 时退化为当前默认模型', async () => {
  const a = await readyAdapter(hostOk())
  const models = await a.listModels()
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, 'deepseek')
})

test('⑪ 未配置默认模型时执行以 MODEL_UNAVAILABLE 失败（不是崩溃）', async () => {
  const a = await readyAdapter(makeHost({ currentModelSelection: () => null }))
  const events = await collect(a, makeRequest())
  const term = events.at(-1)
  assert.equal(term.type, 'run.failed')
  assert.equal(term.code, 'MODEL_UNAVAILABLE')
})

test('⑪ currentModelSelection 抛错时归为 MODEL_UNAVAILABLE', async () => {
  const a = await readyAdapter(makeHost({ currentModelSelection() { throw new Error('db locked') } }))
  const events = await collect(a, makeRequest())
  assert.equal(events.at(-1).code, 'MODEL_UNAVAILABLE')
})

test('⑪ validateProfile 拒绝含明文密钥的配置', async () => {
  const a = await readyAdapter(hostOk())
  const bad = await a.validateProfile({ id: 'x', displayName: 'x', runtimeType: 'dsh', provider: 'p', model: 'm', apiKey: 'sk-abcdefghijklmnop' })
  assert.equal(bad.ok, false)
  assert.ok(bad.code)
})

test('⑪ validateProfile 在运行时不可用时拒绝', async () => {
  const a = await readyAdapter(makeHost({ async probeRuntime() { return { version: '0.1.5-rc.2', capabilities: {} } } }))
  const r = await a.validateProfile({ id: 'x', displayName: 'x', runtimeType: 'dsh', provider: 'p', model: 'm' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'RUNTIME_NOT_READY')
})

test('⑪ validateProfile 通过时带上耗时与能力', async () => {
  const a = await readyAdapter(hostOk())
  const r = await a.validateProfile({ id: 'x', displayName: 'x', runtimeType: 'dsh', provider: 'p', model: 'm' })
  assert.equal(r.ok, true)
  assert.equal(typeof r.latencyMs, 'number')
  assert.equal(r.capabilities['structured-result'], true)
})

// ================================================================ ⑫ 事件装配

test('⑫ 未映射事件走 run.progress 并带原名（引擎加了新事件要看得见）', () => {
  const m = mapDshEvent({ type: 'totally.new' })
  assert.equal(m.type, 'run.progress')
  assert.equal(m.unmapped, true)
  assert.equal(m.payload.dshEventType, 'totally.new')
})

test('⑫ 事件里的 seq/at 不被引擎覆盖（序号唯一权威在我们）', () => {
  const m = mapDshEvent({ type: 'message.delta', text: 'x', seq: 999, at: 111 })
  assert.equal(Object.hasOwn(m.payload, 'seq'), false)
  assert.equal(Object.hasOwn(m.payload, 'at'), false)
  assert.equal(m.payload.text, 'x')
})

test('⑫ 事件载荷也会脱敏', () => {
  const m = mapDshEvent({ type: 'message.delta', token: 'secret-value' })
  assert.equal(m.payload.token, REDACTED)
})

test('⑫ 畸形事件不丢弃，带原因上报', () => {
  const m = mapDshEvent({ noType: true })
  assert.equal(m.unmapped, true)
  assert.match(m.payload.unmappedReason, /缺少 type/)
})

test('⑫ 映射表产出的类型必须都是契约已知类型', () => {
  for (const [k, v] of Object.entries(DSH_EVENT_MAP)) {
    assert.ok(RUN_EVENT_TYPES.includes(v), `${k} 映射到未知类型 ${v}`)
  }
})

test('⑫ 发射器拒绝第二个终态并记入迟到清单', () => {
  const em = createEventEmitter({ runId: 'r', now: () => 1 })
  assert.ok(em.emit('run.completed', {}))
  assert.equal(em.terminalType(), 'run.completed')
  assert.equal(em.emit('run.failed', {}), null)
  assert.equal(em.lateTerminals().length, 1)
  assert.equal(em.isTerminal(), true)
})

test('⑫ 发射器序号从 1 开始严格递增', () => {
  const em = createEventEmitter({ runId: 'r', now: () => 1 })
  assert.equal(em.emit('run.started', {}).seq, 1)
  assert.equal(em.emit('run.progress', {}).seq, 2)
})

test('⑫ terminalTypeFor 覆盖四类终态', () => {
  assert.equal(terminalTypeFor('completed', { code: null }), 'run.completed')
  assert.equal(terminalTypeFor('cancelled', { code: 'CANCELLED' }), 'run.cancelled')
  assert.equal(terminalTypeFor(null, { code: 'OUTCOME_UNKNOWN' }), 'run.outcome_unknown')
  assert.equal(terminalTypeFor('failed', { code: 'RATE_LIMITED' }), 'run.failed')
})

// ================================================================ ⑬ 适配器自检

test('⑬ 产出的适配器满足契约的 7 个方法', async () => {
  const a = createDshRuntimeAdapter(makeHost(), {})
  for (const m of ['getHealth', 'getCapabilities', 'listModels', 'validateProfile', 'execute', 'cancel', 'recover']) {
    assert.equal(typeof a[m], 'function', `缺方法 ${m}`)
  }
  assert.equal(a.runtimeContractVersion, 1)
})

test('⑬ 提前 break 事件流不会泄漏活跃运行', async () => {
  const a = await readyAdapter(makeHost(), { cancelGraceMs: 20 })
  const it = a.execute(makeRequest())[Symbol.asyncIterator]()
  await it.next()
  await it.return?.() // 消费方提前退出
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(a._internals.activeRuns(), [], '提前退出后不得留下活跃运行')
})

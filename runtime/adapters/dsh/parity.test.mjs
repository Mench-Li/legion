// runtime/adapters/dsh/parity.test.mjs
// ============================================================================
// PRT-210 对拍测试（阶段 2 完成标准）。
//
// 两类用例同等重要：
//   · **漂移检测** —— 保证对拍本身还有意义（复刻件没被旧代码甩下）
//   · **等价判定** —— 保证两条路径在同一输入下给出同一语义
//
// 若只有后者，旧调用一改，对拍就会拿两个不同的东西比较并且**静默通过**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDshRuntimeAdapter } from './index.mjs'
import {
  BOUNDED_DIVERGENCES,
  INTENDED_DIVERGENCES,
  LEGACY_CALL_OPTIONS,
  LEGACY_CALL_SITE,
  LEGACY_CALL_TOKEN,
  LEGACY_CONDITIONAL_OPTIONS,
  collectAdapterRun,
  compareParity,
  deepEqual,
  detectLegacyDrift,
  detectLegacyDriftFromRepo,
  extractLegacyCallOptions,
  runLegacyPath,
} from './parity.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const CAPS_OK = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
})

const OK_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
})

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
    timeoutMs: 300,
    workdir: 'C:/tmp/ws',
    permissions: { preset: 'legion-attended', tools: ['read_file'] },
    expectedOutput: { schema: OK_SCHEMA, acceptance: 'ok 为 true' },
    ...over,
  }
}

/**
 * 假宿主。
 *
 * 三种结算方式，刻意用不同参数名区分，避免"忘了给 structured 于是静默超时"这类假通过：
 *   `structured: {…}`   → 以 `{stopReason, structured}` 结算
 *   `settled: {…}`      → 以给定值结算（可**不带** structured，用于测「completed 但无结构化输出」）
 *   两者都不给          → `result` 永不结算（用于测看门狗）
 */
function makeHost({ structured, settled, stopReason = 'completed', throwOnStart = null, over = {} } = {}) {
  const calls = { startRun: [] }
  const finalValue = settled !== undefined
    ? settled
    : (structured === undefined ? undefined : { stopReason, structured })
  return {
    calls,
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }),
    async probeRuntime() {
      return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } }
    },
    async startRun(provider, options) {
      calls.startRun.push({ provider, options })
      if (throwOnStart !== null) throw new Error(throwOnStart)
      return {
        result: finalValue === undefined ? new Promise(() => {}) : Promise.resolve(finalValue),
        dispose: async () => {},
      }
    },
    ...over,
  }
}

async function readyAdapter(host, options = {}) {
  const a = createDshRuntimeAdapter(host, options)
  await a.probe()
  return a
}

/** 用同一个宿主跑完两条路径，返回对拍输入。 */
async function pair(host, { legacy = {}, request = makeRequest(), adapterOptions = {} } = {}) {
  const l = await runLegacyPath(host, {
    provider: 'deepseek',
    label: `scrum:${request.taskId}`,
    promptText: `任务：${request.taskId}`,
    outputSchema: OK_SCHEMA,
    timeoutMs: 200,
    ...legacy,
  })
  const a = await readyAdapter(host, adapterOptions)
  const ar = await collectAdapterRun(a, request)
  // 新路径实际发出的 prompt —— 从宿主记录里取，而不是猜
  const adapterPromptText = host.calls.startRun.at(-1)?.options?.prompt?.[0]?.text ?? null
  return { legacy: l, adapter: ar, adapterPromptText }
}

// ================================================================ ① 漂移检测

test('① 漂移检测：真实源码与复刻件的选项集合**完全一致**', () => {
  const d = detectLegacyDriftFromRepo(ROOT)
  assert.equal(d.drifted, false, `对拍已失去意义：${d.reason}`)
  assert.deepEqual(d.actual, [...LEGACY_CALL_OPTIONS])
})

test('① 漂移检测：能从真实源码抽出全部子代理启动调用，并正确识别顶层键', () => {
  const source = readFileSync(join(ROOT, LEGACY_CALL_SITE.file), 'utf8')
  const calls = extractLegacyCallOptions(source)
  assert.ok(calls.length >= 4, `应找到多处调用，实际 ${calls.length}`)
  const target = calls.find((c) => c.line === LEGACY_CALL_SITE.line)
  assert.ok(target, `未在 ${LEGACY_CALL_SITE.line} 行找到调用`)
  // 简写属性 `parent,` 必须在列 —— 漏掉它会漏报「旧调用不再传 parent」
  assert.ok(target.options.includes('parent'), '简写属性 parent 未被识别')
  for (const k of ['label', 'prompt', 'signal', 'outputSchema']) {
    assert.ok(target.options.includes(k), `顶层键 ${k} 未被识别`)
  }
})

test('① 漂移检测：条件展开记为 ...spread，而**不是**把 toolFilter 当顶层键', () => {
  const source = readFileSync(join(ROOT, LEGACY_CALL_SITE.file), 'utf8')
  const target = extractLegacyCallOptions(source, LEGACY_CALL_SITE.line)[0]
  assert.ok(target.options.includes('...spread'))
  assert.ok(!target.options.includes('toolFilter'), 'toolFilter 在条件展开内部，不是顶层字面量键')
  assert.equal(LEGACY_CONDITIONAL_OPTIONS[0].key, 'toolFilter')
  assert.match(LEGACY_CONDITIONAL_OPTIONS[0].when, /denyTools/)
})

test('① 漂移检测：嵌套对象与模板字符串不会让扫描提前截断', () => {
  // 这是手写正则最容易错的地方：第一个 `}` 就停，得到**偏小**的集合。
  const src = [
    `const run = await ${LEGACY_CALL_TOKEN}config.provider, {`,
    '  label: `a${b}` ,',
    '  prompt: [{ type: "text", text: t }],',
    '  options: { nested: { deep: 1 } },',
    '  outputSchema: { type: "object", properties: { a: { type: "string" } } },',
    '})',
  ].join('\n')
  const got = extractLegacyCallOptions(src)[0].options
  assert.deepEqual(got, ['label', 'prompt', 'options', 'outputSchema'], '必须在深度归零处才停')
})

test('① 漂移检测：旧调用新增选项 → drifted，且理由点名新增了什么', () => {
  const src = `await ${LEGACY_CALL_TOKEN}p, {\n  label: 1,\n  prompt: 2,\n  parent,\n  signal: 3,\n  outputSchema: 4,\n  brandNew: 5,\n})`
  const d = detectLegacyDrift(src, 1)
  assert.equal(d.drifted, true)
  assert.match(d.reason, /brandNew/)
})

test('① 漂移检测：旧调用移除选项 → drifted，且理由点名移除了什么', () => {
  const src = `await ${LEGACY_CALL_TOKEN}p, {\n  label: 1,\n  prompt: 2,\n  signal: 3,\n  outputSchema: 4,\n})`
  const d = detectLegacyDrift(src, 1)
  assert.equal(d.drifted, true)
  assert.match(d.reason, /parent/)
})

test('① 漂移检测：行号漂移（该行已无调用）→ drifted 并说明复刻件不再代表旧路径', () => {
  const d = detectLegacyDrift('// 这个文件里没有那个调用\nconst x = 1\n', 1)
  assert.equal(d.drifted, true)
  assert.match(d.reason, /未找到/)
  assert.match(d.reason, /本对拍无效/)
})

// ================================================================ ② 比较语义

test('② deepEqual：键顺序无关，数组顺序有关', () => {
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
  assert.equal(deepEqual({ a: [1, { x: 1, y: 2 }] }, { a: [1, { y: 2, x: 1 }] }), true)
  assert.equal(deepEqual(null, undefined), false)
})

test('② 任务状态语义不一致 → violation（这是必须为 0 的一类）', () => {
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { ok: true }, usage: null, events: [] },
    adapter: { outcome: 'failed', code: 'RUNTIME_CRASHED', output: null, usage: null, events: [], eventTypes: [] },
  })
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.id === 'task-outcome'))
})

test('② 两边都成功但结构化结果不同 → violation', () => {
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { ok: true }, usage: null, events: [] },
    adapter: { outcome: 'succeeded', output: { ok: false }, usage: null, events: [], eventTypes: [] },
  })
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.id === 'structured-result'))
})

test('② 两边都成功且结构化结果相同（键序不同）→ 无违规', () => {
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { a: 1, b: 2 }, usage: null, events: [] },
    adapter: { outcome: 'succeeded', output: { b: 2, a: 1 }, usage: null, events: [], eventTypes: [] },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.violations, [])
})

test('② INVALID_RESULT 是 **intended**（PRT-204 要求的更严），不是违规', () => {
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { nope: 1 }, usage: null, events: [] },
    adapter: { outcome: 'failed', code: 'INVALID_RESULT', output: null, usage: null, events: [], eventTypes: [] },
  })
  assert.equal(r.ok, true, 'PRT-204 的结构化校验必须被认作**有意**变更，否则对拍恒红')
  assert.ok(r.intended.some((d) => d.id === 'structured-validation' && d.prt === 'PRT-204'))
})

test('② 旧路径的「未完成」被新路径分类 → intended（PRT-206），不是违规', () => {
  const r = compareParity({
    legacy: { outcome: 'failed', legacyVerdict: '未完成', structured: undefined, usage: null, events: [] },
    adapter: { outcome: 'failed', code: 'RATE_LIMITED', output: null, usage: null, events: [], eventTypes: [] },
  })
  assert.equal(r.ok, true)
  assert.ok(r.intended.some((d) => d.id === 'error-classification' && d.prt === 'PRT-206'))
})

test('② 敏感信息出现在输出中 → security violation，且报告**不回显**该值', () => {
  const secret = 'sk-live-abcdef0123456789'
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { ok: true }, usage: null, events: [] },
    adapter: { outcome: 'succeeded', output: { ok: true, note: secret }, usage: null, events: [], eventTypes: [] },
    secrets: [secret],
  })
  assert.equal(r.ok, false)
  const v = r.violations.find((x) => x.id === 'secret-leak')
  assert.ok(v, '必须报 secret-leak')
  assert.equal(v.class, 'security')
  assert.ok(!JSON.stringify(r).includes(secret), '违规报告自己不得成为泄漏点')
})

test('② 敏感信息只出现在事件流里也算泄漏（不能只看 output）', () => {
  const secret = 'sk-live-zzz'
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { ok: true }, usage: null, events: [] },
    adapter: {
      outcome: 'succeeded', output: { ok: true }, usage: null, eventTypes: ['run.started'],
      events: [{ type: 'model.selected', provider: secret }],
    },
    secrets: [secret],
  })
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.id === 'secret-leak'))
})

test('② prompt 丢失任务身份 → violation；身份保留 → bounded（文本不同不算违规）', () => {
  const request = makeRequest({ taskId: 'T-9', goalId: 'G-9', employeeId: 'E-9' })
  const base = {
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { ok: true }, usage: null, events: [] },
    adapter: { outcome: 'succeeded', output: { ok: true }, usage: null, events: [], eventTypes: [] },
    request,
  }
  const lost = compareParity({ ...base, adapterPromptText: '随便写点什么' })
  assert.equal(lost.ok, false)
  assert.ok(lost.violations.some((v) => v.id === 'prompt-identity'))

  const kept = compareParity({ ...base, adapterPromptText: '任务：T-9\n目标：G-9\n员工：E-9' })
  assert.equal(kept.ok, true)
  assert.ok(kept.bounded.some((d) => d.id === 'prompt-input'))
  assert.match(kept.bounded[0].owner, /阶段 4/)
})

test('② 复刻件漂移被判为 harness 违规，而不是新路径的回归', () => {
  const r = compareParity({
    legacy: { outcome: 'succeeded', legacyVerdict: '完成', structured: { ok: true }, usage: null, events: [] },
    adapter: { outcome: 'succeeded', output: { ok: true }, usage: null, events: [], eventTypes: [] },
    legacySource: '// 没有那个调用了',
  })
  assert.equal(r.ok, false)
  const v = r.violations.find((x) => x.id === 'legacy-replica-drift')
  assert.ok(v)
  assert.equal(v.class, 'harness', '归类为 harness：要修的是对拍工具，不是产品代码')
})

test('② 四类差异分别计数，且 intended/bounded 不混进 violations', () => {
  const r = compareParity({
    legacy: { outcome: 'failed', legacyVerdict: '未完成', structured: undefined, usage: null, events: [] },
    adapter: { outcome: 'failed', code: 'TIMEOUT', output: null, usage: { totalTokens: 5 }, eventTypes: ['run.started', 'run.failed'], events: [{ type: 'run.started' }] },
    request: makeRequest(),
    adapterPromptText: '任务：T-1\n目标：goal-1\n员工：emp-1',
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.counts, { violations: 0, intended: 2, improvements: 1, bounded: 1 })
})

// ================================================================ ③ 复刻件语义

test('③ 复刻件：completed + structured → 完成', async () => {
  const host = makeHost({ structured: { ok: true } })
  const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 200 })
  assert.equal(r.outcome, 'succeeded')
  assert.equal(r.legacyVerdict, '完成')
  assert.equal(r.dispatched, true)
  assert.equal(r.disposed, true)
})

test('③ 复刻件：completed 但 **没有** structured → 未完成（旧路径只看 undefined）', async () => {
  const host = makeHost({ settled: { stopReason: 'completed' } })
  const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 50 })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.legacyVerdict, '未完成')
  assert.equal(r.stopReason, 'completed', '结算确实到了，只是缺 structured')
})

test('③ 复刻件：**不做 schema 校验** —— 违反 schema 的 structured 照样判完成', async () => {
  const host = makeHost({ structured: { nope: 1 } })
  const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 200 })
  assert.equal(r.outcome, 'succeeded', '这正是与 PRT-204 的有意差异；复刻件不得"顺手修好"它')
  assert.equal(r.structuredAccepted, true)
})

test('③ 复刻件：非 completed 的 stopReason 一律「未完成」，不分类', async () => {
  for (const sr of ['max_tokens', 'error', 'aborted', '']) {
    const host = makeHost({ stopReason: sr, structured: { ok: true } })
    const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 50 })
    assert.equal(r.outcome, 'failed', `stopReason=${sr} 应判未完成`)
    assert.equal(r.legacyVerdict, '未完成')
  }
})

test('③ 复刻件：result 永不结算 → 看门狗强制结算为超时（不等 result）', async () => {
  const host = makeHost({})
  const started = Date.now()
  const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 30 })
  assert.equal(r.outcome, 'timed-out')
  assert.ok(Date.now() - started < 1000, '必须到点就走，不能等那个永不结算的 promise')
})

test('③ 复刻件：startRun 抛错 → dispatched=false，不伪造结果', async () => {
  const host = makeHost({ throwOnStart: '派工失败' })
  const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 50 })
  assert.equal(r.dispatched, false)
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /派工失败/)
})

test('③ 复刻件：不采集 usage、不消费事件流（保持旧行为）', async () => {
  const host = makeHost({ structured: { ok: true } })
  const r = await runLegacyPath(host, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 200 })
  assert.equal(r.usage, null)
  assert.deepEqual(r.events, [])
})

test('③ 复刻件：调用形状与旧调用一致（label/prompt/parent/signal/outputSchema）', async () => {
  const host = makeHost({ structured: { ok: true } })
  await runLegacyPath(host, { provider: 'deepseek', label: 'scrum:T-1', promptText: 'hi', outputSchema: OK_SCHEMA, timeoutMs: 200 })
  const call = host.calls.startRun[0]
  assert.equal(call.provider, 'deepseek')
  // `parent` 在旧代码里是**简写属性**，即使值为 undefined 键也存在 —— 复刻件同样如此
  assert.deepEqual(Object.keys(call.options).sort(), ['label', 'outputSchema', 'parent', 'prompt', 'signal'])
  assert.deepEqual(call.options.prompt, [{ type: 'text', text: 'hi' }])
  assert.ok(call.options.signal instanceof AbortSignal)
})

test('③ 复刻件：denyTools 非空时才传 toolFilter（对应旧调用的条件展开）', async () => {
  const withFilter = makeHost({ structured: { ok: true } })
  await runLegacyPath(withFilter, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 200, toolFilter: { deny: ['rm'] } })
  assert.deepEqual(withFilter.calls.startRun[0].options.toolFilter, { deny: ['rm'] })

  const without = makeHost({ structured: { ok: true } })
  await runLegacyPath(without, { provider: 'p', label: 'l', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 200 })
  assert.ok(!('toolFilter' in without.calls.startRun[0].options), '默认配置下不得传 toolFilter')
})

// ================================================================ ④ 端到端对拍

test('④ 端到端：正常任务两条路径等价（阶段 2 完成标准）', async () => {
  const host = makeHost({ structured: { ok: true } })
  const { legacy, adapter, adapterPromptText } = await pair(host)
  const r = compareParity({ legacy, adapter, request: makeRequest(), adapterPromptText, legacySource: readFileSync(join(ROOT, LEGACY_CALL_SITE.file), 'utf8') })

  assert.equal(legacy.outcome, 'succeeded')
  assert.equal(adapter.outcome, 'succeeded', `新路径未成功：code=${adapter.code}`)
  assert.equal(r.ok, true, `出现违规：${JSON.stringify(r.violations, null, 1)}`)
  assert.deepEqual(legacy.structured, adapter.output)
  assert.ok(r.bounded.some((d) => d.id === 'prompt-input'), 'prompt 差异应被记为 bounded，而不是假装相等')
})

test('④ 端到端：正常任务下敏感信息不出现在新路径的任何输出中', async () => {
  // 密钥类字符串塞在 structured 之外的位置：若被回显，必须被抓到
  const host = makeHost({ structured: { ok: true } })
  const { legacy, adapter, adapterPromptText } = await pair(host)
  const r = compareParity({
    legacy, adapter, request: makeRequest(), adapterPromptText,
    secrets: ['sk-live-should-not-appear', 'deepseek'],
  })
  // 'deepseek' 是 provider 名，本来就会出现 —— 这里用它验证检测**确实在工作**
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.id === 'secret-leak'))
})

test('④ 端到端：schema 不合规的结果 —— 旧路径判完成、新路径判 INVALID_RESULT，归 intended', async () => {
  const host = makeHost({ structured: { nope: 1 } })
  const { legacy, adapter, adapterPromptText } = await pair(host)
  const r = compareParity({ legacy, adapter, request: makeRequest(), adapterPromptText })

  assert.equal(legacy.outcome, 'succeeded', '旧路径不看 schema')
  assert.equal(adapter.outcome, 'failed')
  assert.equal(adapter.code, 'INVALID_RESULT')
  assert.equal(r.ok, true, '这是 PRT-204 要求的更严行为，不得判为违规')
  assert.ok(r.intended.some((d) => d.id === 'structured-validation'))
})

test('④ 端到端：result 永不结算 —— 两条路径都不判成功', async () => {
  const host = makeHost({})
  const l = await runLegacyPath(host, { provider: 'deepseek', label: 'scrum:T-1', promptText: 't', outputSchema: OK_SCHEMA, timeoutMs: 25 })
  const a = await readyAdapter(host, { watchdogGraceMs: 0 })
  const ar = await collectAdapterRun(a, makeRequest({ timeoutMs: 25 }))
  const r = compareParity({ legacy: l, adapter: ar })
  assert.notEqual(l.outcome, 'succeeded')
  assert.notEqual(ar.outcome, 'succeeded')
  assert.equal(r.ok, true, `两条路径都不判成功即可：${JSON.stringify(r.violations)}`)
})

test('④ 端到端：新路径事件流被记录为 improvement（旧路径没有消费者）', async () => {
  const host = makeHost({ structured: { ok: true } })
  const { legacy, adapter, adapterPromptText } = await pair(host)
  const r = compareParity({ legacy, adapter, request: makeRequest(), adapterPromptText })
  assert.ok(r.improvements.some((d) => d.id === 'event-stream' && d.prt === 'PRT-203'))
  assert.deepEqual(adapter.eventTypes.slice(0, 2), ['run.started', 'model.selected'])
})

// ================================================================ ⑤ 声明自洽

test('⑤ 声明自洽：每条 intended 差异都点名了要求它的 PRT', () => {
  for (const d of INTENDED_DIVERGENCES) {
    assert.match(d.prt, /^PRT-\d+$/, `${d.id} 缺少 PRT 归属`)
    assert.ok(d.legacy && d.adapter && d.why, `${d.id} 必须同时写清旧行为、新行为和理由`)
  }
})

test('⑤ 声明自洽：每条 bounded 差异都点名了责任里程碑', () => {
  for (const d of BOUNDED_DIVERGENCES) {
    assert.ok(d.owner && /PRT-\d/.test(d.owner), `${d.id} 缺少责任归属 —— 没有归属的差距会永远留在"已知问题"里`)
    assert.ok(d.detail)
  }
})

// ================================================================ ⑥ 边界棘轮

test('⑥ 边界棘轮：本模块对执行面记号贡献 **0**——豁免存在但不消耗', () => {
  // 本模块 import 的执行面包数量是 0；它只是**读**旧源码做漂移检测。
  // 而 `dsh-boundary` 是**纯文本**匹配：写出一整个 `ctx.…` 字面量（哪怕在注释里）
  // 就会被计成「执行面依赖 +1」。那是往坏的方向错的假阳性——
  // 把「防止耦合腐化的工具」本身算成了耦合。
  //
  // 因此 `LEGACY_CALL_TOKEN` 是拼接出来的。这条用例守住那个拼接：
  // 谁把它"简化"回字面量，棘轮就会涨，而这条用例会先红——**报在正确的地方**。
  const literal = 'ctx.' + 'subagents'
  for (const f of ['parity.mjs', 'parity.test.mjs']) {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8')
    assert.ok(
      !src.includes(literal),
      `${f} 出现了执行面记号字面量（即使只在注释/夹具里）：`
      + 'dsh-boundary 是文本匹配，会让本模块被计为依赖增长。请用 LEGACY_CALL_TOKEN 拼接。',
    )
  }
})

test('⑥ 边界棘轮：拼接出的记号仍然能命中真实调用（拼接没有改坏语义）', () => {
  assert.ok(LEGACY_CALL_TOKEN.endsWith('.start('))
  const calls = extractLegacyCallOptions(readFileSync(join(ROOT, LEGACY_CALL_SITE.file), 'utf8'))
  assert.ok(
    calls.some((c) => c.line === LEGACY_CALL_SITE.line),
    '拼接后的正则必须仍能命中旧调用，否则漂移检测会静默失效',
  )
})

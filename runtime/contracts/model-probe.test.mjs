// runtime/contracts/model-probe.test.mjs
// ============================================================================
// 模型连通性与能力测试的**判定面**（PRT-504）
//
// 这一组几乎全部是"分类必须分对"的用例，因为探测的全部价值就是
// **让调用方知道下一步该做什么**。一个分错的码比没有码更糟：
// 它会让运维去修一个不存在的问题（见 SECRET_UNAVAILABLE vs AUTH_FAILED）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_CAPABILITIES,
  NEGATIVE_PROBE_TTL_MS,
  PROBE_CLASSES,
  PROBE_CODE_CLASS,
  PROBE_CODES,
  PROBE_TTL_MS,
  classifyFailure,
  classifyHttpStatus,
  defaultProbeMessage,
  evaluateProbe,
  isProbeFresh,
  normalizeCapabilities,
  probeClassOf,
  probeFingerprint,
  ttlForVerdict,
  validateRequiredCapabilities,
} from './model-probe.mjs'

// ------------------------------------------------------------------ ① 分类

test('① 两个"失败"必须分得开：本地密钥库问题 ≠ 供应商拒绝', () => {
  // spec §6.7 第 423 行：SECRET_UNAVAILABLE 表示本地凭证库或账户问题，
  // AUTH_FAILED 表示供应商拒绝已成功解析的凭证，两者不得混为一类。
  //
  // 混成一类的代价很具体：运维会拿着"鉴权失败"去供应商控制台轮换一把好钥匙，
  // 而真实原因是本机 DPAPI 换了账户作用域——新钥匙同样解不开，
  // 而"解不开"这个线索被一次无关的轮换掩盖了。
  assert.notEqual('SECRET_UNAVAILABLE', 'AUTH_FAILED')
  assert.equal(probeClassOf('SECRET_UNAVAILABLE'), 'fail-closed')
  assert.equal(probeClassOf('AUTH_FAILED'), 'config')
  // 两条默认可操作说明必须指向**不同**的动作
  assert.match(defaultProbeMessage('SECRET_UNAVAILABLE'), /不要去供应商控制台换钥匙/)
  assert.match(defaultProbeMessage('AUTH_FAILED'), /本机密钥库是好的/)
})

test('① HTTP 状态码 → 码：鉴权 / 模型不存在 / 限流 / 供应商错 / 超时', () => {
  assert.equal(classifyHttpStatus(401), 'AUTH_FAILED')
  assert.equal(classifyHttpStatus(403), 'AUTH_FAILED')
  assert.equal(classifyHttpStatus(404), 'MODEL_NOT_FOUND')
  assert.equal(classifyHttpStatus(408), 'TIMEOUT')
  assert.equal(classifyHttpStatus(429), 'RATE_LIMITED')
  assert.equal(classifyHttpStatus(500), 'PROVIDER_ERROR')
  assert.equal(classifyHttpStatus(503), 'PROVIDER_ERROR')
  assert.equal(classifyHttpStatus(400), 'BAD_RESPONSE')
  assert.equal(classifyHttpStatus(422), 'BAD_RESPONSE')
  // 非失败状态码不该被拿来分类
  for (const s of [200, 201, 204, 301, undefined, null, '401', 99, 600, 4.5, NaN]) {
    assert.equal(classifyHttpStatus(s), 'UNCLASSIFIED', `状态码 ${String(s)} 应归入 UNCLASSIFIED`)
  }
})

test('① 传输层事实 → 码，且**主动取消不是失败**', () => {
  assert.equal(classifyFailure({ kind: 'connect' }), 'ENDPOINT_UNREACHABLE')
  assert.equal(classifyFailure({ kind: 'tls' }), 'TLS_FAILED')
  assert.equal(classifyFailure({ kind: 'timeout' }), 'TIMEOUT')
  assert.equal(classifyFailure({ kind: 'parse' }), 'BAD_RESPONSE')
  assert.equal(classifyFailure({ kind: 'http', status: 429 }), 'RATE_LIMITED')
  // 主动取消返回 null —— 它需要**单独**的表达，不能和"连不上"混在一起。
  // 把取消硬塞进某个失败码，会让一次正常取消在审计里看起来像连通性事故。
  assert.equal(classifyFailure({ kind: 'abort' }), null)
  // 分不出来就是分不出来，不许默认成某个"看起来合理"的码
  assert.equal(classifyFailure({ kind: 'unknown' }), 'UNCLASSIFIED')
  assert.equal(classifyFailure({}), 'UNCLASSIFIED')
  assert.equal(classifyFailure(), 'UNCLASSIFIED')
})

test('① TLS 与"连不上"分开：证书问题重试一百次也一样', () => {
  // 若把 TLS 归成 transient，调用方会去重试一个永远失败的东西；
  // 而它真正的含义是"本机信任链或中间人"，值得有人看一眼。
  assert.equal(probeClassOf('TLS_FAILED'), 'config')
  assert.notEqual(probeClassOf('TLS_FAILED'), probeClassOf('ENDPOINT_UNREACHABLE'))
})

test('① 码 → 类别是**全定义**的，且类别集合封闭', () => {
  for (const code of PROBE_CODES) {
    const cls = PROBE_CODE_CLASS[code]
    assert.ok(PROBE_CLASSES.includes(cls), `${code} 的类别 ${String(cls)} 不在封闭集合里`)
  }
  // 键集与码集一一对应（多一个键说明有码已删但类别还在）
  assert.deepEqual(Object.keys(PROBE_CODE_CLASS).sort(), [...PROBE_CODES].sort())
  // 每个码都有默认说明——缺一个会让失败只剩一个代号
  for (const code of PROBE_CODES) {
    assert.ok(defaultProbeMessage(code).length > 4, `${code} 缺默认可操作说明`)
  }
})

test('① 未知码 → unknown，**不默认成 transient**', () => {
  // 默认成 transient 会让一个没人想过的失败被静默重试，
  // 而重试是把一次可诊断的故障变成一串噪声的最快方式。
  assert.equal(probeClassOf('SOMETHING_NEW'), 'unknown')
  assert.equal(probeClassOf(undefined), 'unknown')
  assert.equal(probeClassOf(null), 'unknown')
  assert.equal(probeClassOf(''), 'unknown')
})

// ------------------------------------------------------------------ ② 判定

test('② "连得上"不等于"能用"：能力缺失必须判失败', () => {
  const observed = {
    ok: true,
    latencyMs: 42,
    capabilities: { chat: true, vision: true },
  }
  // 只要求 chat → 通过
  const pass = evaluateProbe({ observed, required: ['chat'] })
  assert.equal(pass.ok, true)
  assert.equal(pass.code, 'OK')
  assert.equal(pass.latencyMs, 42)

  // 要求 tools → 失败，而且必须说清**缺哪些**
  const fail = evaluateProbe({ observed, required: ['chat', 'tools'] })
  assert.equal(fail.ok, false)
  assert.equal(fail.code, 'CAPABILITY_MISSING')
  assert.equal(fail.class, 'config')
  assert.deepEqual([...fail.missingCapabilities], ['tools'])
  assert.match(fail.message, /缺少本次任务需要的能力：tools/)
  // 说明里要带上它**实际**有什么，否则用户不知道该换成什么
  assert.match(fail.message, /chat \/ vision/)
})

test('② 观测失败时**不去看能力**（别把连不上报成缺能力）', () => {
  const v = evaluateProbe({
    observed: { ok: false, code: 'ENDPOINT_UNREACHABLE', message: '送不到 endpoint' },
    required: ['tools'],
  })
  assert.equal(v.code, 'ENDPOINT_UNREACHABLE', '真正的问题（连不上）不能被"缺 tools"盖掉')
  assert.deepEqual([...v.missingCapabilities], [])
  assert.equal(v.class, 'transient')
})

test('② 能力声明必须严格为 true，模糊值一律不算', () => {
  // 供应商常写 "tools": "yes" / 1 / "true"。都放行会让一个其实不支持的
  // 模型被选进链，而整条依赖工具调用的运行会在中途崩。
  const caps = normalizeCapabilities({ chat: true, tools: 'yes', vision: 1, json: 'true', reasoning: true })
  assert.deepEqual(Object.keys(caps).sort(), ['chat', 'reasoning'])
  // 未声明的能力**不在**对象里（不是 false）："没声明"与"声明为否"要能分开
  assert.equal('tools' in caps, false)
  assert.equal('long-context' in caps, false)
  // 垃圾输入不炸
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    assert.deepEqual(Object.keys(normalizeCapabilities(bad)), [])
  }
})

test('② 判定必须能产出"缺哪几项"的完整清单', () => {
  const v = evaluateProbe({
    observed: { ok: true, capabilities: { chat: true } },
    required: ['chat', 'tools', 'vision'],
  })
  assert.deepEqual([...v.missingCapabilities], ['tools', 'vision'])
})

test('② 要求的能力本身写错 → 明确失败，不静默忽略', () => {
  const v = evaluateProbe({ observed: { ok: true, capabilities: { chat: true } }, required: ['toolz'] })
  assert.equal(v.ok, false)
  assert.equal(v.class, 'unknown')
  assert.match(v.message, /未知能力 "toolz"/)
  assert.match(v.message, /tools/)
})

test('② 重复要求同一个能力只报一次（否则读起来像缺两样）', () => {
  const r = validateRequiredCapabilities(['tools', 'tools', 'chat'])
  assert.equal(r.ok, true)
  assert.deepEqual([...r.value], ['tools', 'chat'])
  const v = evaluateProbe({ observed: { ok: true, capabilities: {} }, required: ['tools', 'tools'] })
  assert.deepEqual([...v.missingCapabilities], ['tools'])
})

test('② 判定输入残缺时一律失败，**绝不**因为"没数据"而通过', () => {
  for (const observed of [null, undefined, 'x', 42]) {
    const v = evaluateProbe({ observed, required: [] })
    assert.equal(v.ok, false, `observed=${String(observed)} 不得判为可用`)
    assert.equal(v.class, 'unknown')
  }
  assert.equal(evaluateProbe({}).ok, false)
  assert.equal(evaluateProbe().ok, false)
  // 无要求 + 明确成功 → 通过
  assert.equal(evaluateProbe({ observed: { ok: true }, required: [] }).ok, true)
  assert.equal(evaluateProbe({ observed: { ok: true }, required: null }).ok, true)
})

test('② 所有能力名都在封闭集合里，且判定里的 capabilities 已归一化', () => {
  assert.deepEqual([...MODEL_CAPABILITIES], ['chat', 'tools', 'vision', 'json', 'long-context', 'reasoning'])
  const v = evaluateProbe({ observed: { ok: true, capabilities: { chat: true, bogus: true } }, required: [] })
  assert.equal(v.ok, true)
  assert.deepEqual(Object.keys(v.capabilities), ['chat'], '未知能力名不得进入判定产物')
})

// ------------------------------------------------------------------ ③ 缓存

test('③ 失败缓存**刻意短于**成功（否则一次抖动会让配置页长时间说谎）', () => {
  assert.ok(NEGATIVE_PROBE_TTL_MS < PROBE_TTL_MS)
  assert.equal(ttlForVerdict({ ok: true }), PROBE_TTL_MS)
  assert.equal(ttlForVerdict({ ok: false, code: 'ENDPOINT_UNREACHABLE' }), NEGATIVE_PROBE_TTL_MS)
  // 分不出来的失败也别缓存太久
  assert.equal(ttlForVerdict({ ok: false, code: 'UNCLASSIFIED' }), NEGATIVE_PROBE_TTL_MS)
})

test('③ 新鲜度：过期即不新鲜，**时钟倒流也算不新鲜**', () => {
  const entry = { probedAtMs: 1_000 }
  assert.equal(isProbeFresh({ entry, nowMs: 1_500, ttlMs: 1_000 }), true)
  assert.equal(isProbeFresh({ entry, nowMs: 2_000, ttlMs: 1_000 }), false, '正好到期算不新鲜')
  assert.equal(isProbeFresh({ entry, nowMs: 3_000, ttlMs: 1_000 }), false)
  // 系统时钟被改回去时，一份"来自未来"的缓存没有可信的年龄
  assert.equal(isProbeFresh({ entry, nowMs: 500, ttlMs: 1_000 }), false)
  // 残缺输入一律不新鲜（宁可多探一次，也不拿未知年龄的判定下判断）
  assert.equal(isProbeFresh({ entry: null, nowMs: 1, ttlMs: 1 }), false)
  assert.equal(isProbeFresh({ entry: { probedAtMs: NaN }, nowMs: 1, ttlMs: 1 }), false)
  assert.equal(isProbeFresh({ entry, nowMs: 1, ttlMs: undefined }), false)
  assert.equal(isProbeFresh({}), false)
  assert.equal(isProbeFresh(), false)
})

test('③ 指纹必须含**配置**：给 A 探的成功不能被 B 继承', () => {
  const a = { id: 'm1', provider: 'openai', model: 'gpt-4o', endpoint: 'https://a.example', runtimeType: 'dsh' }
  const same = { ...a }
  const otherModel = { ...a, model: 'gpt-4o-mini' }
  const otherEndpoint = { ...a, endpoint: 'https://b.example' }
  const otherProvider = { ...a, provider: 'azure' }
  assert.equal(probeFingerprint(a), probeFingerprint(same), '同配置必须同指纹（否则缓存永远不命中）')
  assert.notEqual(probeFingerprint(a), probeFingerprint(otherModel))
  assert.notEqual(probeFingerprint(a), probeFingerprint(otherEndpoint))
  assert.notEqual(probeFingerprint(a), probeFingerprint(otherProvider))
  assert.equal(probeFingerprint(null), 'invalid')
  assert.equal(probeFingerprint('x'), 'invalid')
})

test('③ 指纹必须**不含**密钥值', () => {
  const p = { id: 'm1', provider: 'openai', model: 'gpt-4o', endpoint: null, runtimeType: 'dsh', secretRef: 'legion/openai' }
  const fp = probeFingerprint(p)
  assert.ok(fp.includes('legion/openai'), '引用名进指纹：从有凭证改成无凭证必须让缓存失效')
  // 但密钥本身从来不在这里——
  const withKey = { ...p, apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' }
  assert.equal(probeFingerprint(withKey), fp, '指纹不得因为多了一个密钥字段而改变')
  assert.ok(!/sk-/.test(probeFingerprint(withKey)))
})

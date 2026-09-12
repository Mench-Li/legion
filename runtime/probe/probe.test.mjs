// runtime/probe/probe.test.mjs
// ============================================================================
// 探测执行器（PRT-504）
//
// 全部用**假 transport**，因此这一组不碰网络、不需要任何真实密钥，
// 却能覆盖全部失败分类（401/403/404/429/5xx/连不上/TLS/超时/主动取消）。
// 这正是把 transport 做成注入点的意义：判定逻辑的可测性不依赖于
// "真的去连一个供应商"。
//
// 真实 HTTP 传输的那一层单独用本机起的一个真服务验（见 `probe-http.test.mjs`），
// 因为"假 transport 全绿"只证明分类对，不证明真 transport 能把真实响应
// 归一化成正确的 `{kind, status}`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findPlaintextSecrets } from '../contracts/model.mjs'
import {
  NEGATIVE_PROBE_TTL_MS,
  PROBE_TTL_MS,
} from '../contracts/model-probe.mjs'
import { PROBE_RAISED, createModelProbe, normalizeTransportError } from './index.mjs'

const PROFILE = Object.freeze({
  id: 'm1',
  displayName: '主模型',
  runtimeType: 'dsh',
  provider: 'openai',
  model: 'gpt-4o',
  endpoint: 'https://api.example/v1',
  secretRef: 'legion/openai',
  reasoningEffort: 'medium',
  limits: Object.freeze({}),
})

/** 可控时钟，让缓存用例不依赖真实时间。 */
function makeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

/**
 * 记录每次调用的 transport。
 *
 * 约定：返回值里**有 `kind`** 的当"拿到了观测结果"（含 `{kind:'http', status}`）；
 * 其余（`Error` 实例、`{code:'ENOTFOUND'}`、`{name:'AbortError'}`）一律**抛出**——
 * 因为真实 transport 就是这么做的：连不上时它不会"返回一个连不上"，
 * 它抛。把这两者混起来会让分类用例测到一个根本不存在的代码路径。
 */
function makeTransport(result) {
  const calls = []
  const fn = async (arg) => {
    calls.push(arg)
    const r = typeof result === 'function' ? result(arg, calls.length) : result
    if (r !== null && typeof r === 'object' && 'kind' in r) return r
    throw r
  }
  fn.calls = calls
  return fn
}

const okTransport = (capabilities = { chat: true }) =>
  makeTransport({ kind: 'http', status: 200, capabilities, latencyMs: 7 })

// ------------------------------------------------------------------ ① 构造

test('① 没有 transport 就构造不出来（"没问过"绝不能被当成"可用"）', () => {
  assert.throws(() => createModelProbe({}), TypeError)
  assert.throws(() => createModelProbe({ transport: null }), TypeError)
  assert.throws(() => createModelProbe({ transport: 'x' }), TypeError)
  assert.throws(() => createModelProbe({ transport: async () => ({}), resolveSecret: 42 }), TypeError)
  // 省略 resolveSecret 是合法的（无需凭证的本地模型）
  assert.doesNotThrow(() => createModelProbe({ transport: async () => ({ kind: 'http', status: 200 }) }))
  assert.equal(PROBE_RAISED.TRANSPORT_MISSING, 'TRANSPORT_INVALID')
})

// ------------------------------------------------------------------ ② 成功

test('② 真实探测一次：成功、带能力、带耗时，且第二次命中缓存**不再发请求**', async () => {
  const clock = makeClock()
  const transport = okTransport({ chat: true, tools: true })
  const probe = createModelProbe({ transport, clock: clock.now, resolveSecret: async () => 'sk-test' })

  const first = await probe.probe({ profile: PROFILE, requiredCapabilities: ['chat', 'tools'] })
  assert.equal(first.ok, true)
  assert.equal(first.code, 'OK')
  assert.equal(first.cached, false)
  assert.equal(first.latencyMs, 7)
  assert.equal(transport.calls.length, 1, '第一次必须真的发请求')
  assert.equal(transport.calls[0].credential, 'sk-test', '凭证要传给 transport')

  const second = await probe.probe({ profile: PROFILE, requiredCapabilities: ['chat', 'tools'] })
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(transport.calls.length, 1, '命中缓存不得再发请求——探测是要花钱的')
  assert.equal(second.ageMs, 0)

  // 到 TTL 边界：`isProbeFresh` 用严格小于，所以"正好到期"已经算不新鲜。
  // 这条边界是刻意的：一份"恰好到期"的判定不该继续被当成新鲜的。
  clock.advance(PROBE_TTL_MS)
  const third = await probe.probe({ profile: PROFILE, requiredCapabilities: ['chat', 'tools'] })
  assert.equal(third.cached, false, '正好到期即不新鲜，必须重探')
  assert.equal(transport.calls.length, 2)

  // 而刚到期的前一刻仍然命中
  const fourth = await probe.probe({ profile: PROFILE, requiredCapabilities: ['chat', 'tools'] })
  assert.equal(fourth.cached, true)
  assert.equal(transport.calls.length, 2, 'TTL 之内不得重探')
})

test('② force 绕过缓存（"我改了配置想立刻验一次"）', async () => {
  const transport = okTransport()
  const probe = createModelProbe({ transport, resolveSecret: async () => 'k' })
  await probe.probe({ profile: PROFILE })
  await probe.probe({ profile: PROFILE, force: true })
  assert.equal(transport.calls.length, 2)
})

test('② 改了配置 → 缓存自动失效（同一个 id 换模型不能被继承）', async () => {
  const clock = makeClock()
  const transport = okTransport()
  const probe = createModelProbe({ transport, clock: clock.now, resolveSecret: async () => 'k' })
  await probe.probe({ profile: PROFILE })
  assert.equal(transport.calls.length, 1)
  // 把模型换掉（id 不变）——真实场景：用户在配置页改了 model 字段
  const changed = { ...PROFILE, model: 'gpt-4o-mini' }
  const v = await probe.probe({ profile: changed })
  assert.equal(v.cached, false, '配置变了必须重探——否则界面拿着 A 的"通过"给 B 用')
  assert.equal(transport.calls.length, 2)
  assert.equal(probe.inspect().size, 2)
})

test('② 成功但缺能力 → CAPABILITY_MISSING，且缓存按**失败**时长（更短）', async () => {
  const clock = makeClock()
  const transport = okTransport({ chat: true })
  const probe = createModelProbe({ transport, clock: clock.now, resolveSecret: async () => 'k' })
  const v = await probe.probe({ profile: PROFILE, requiredCapabilities: ['tools'] })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'CAPABILITY_MISSING')
  assert.deepEqual([...v.missingCapabilities], ['tools'])

  clock.advance(NEGATIVE_PROBE_TTL_MS + 1)
  await probe.probe({ profile: PROFILE, requiredCapabilities: ['tools'] })
  assert.equal(transport.calls.length, 2, '失败结论必须用更短的 TTL')
})

// ------------------------------------------------------------------ ③ 失败分类

test('③ 401/403 → AUTH_FAILED（凭证已解析成功，是供应商拒绝）', async () => {
  for (const status of [401, 403]) {
    const transport = okTransport()
    transport.calls.length = 0
    const t = makeTransport({ kind: 'http', status })
    const probe = createModelProbe({ transport: t, resolveSecret: async () => 'k' })
    const v = await probe.probe({ profile: PROFILE })
    assert.equal(v.ok, false, `HTTP ${status}`)
    assert.equal(v.code, 'AUTH_FAILED')
    assert.equal(v.class, 'config')
    assert.match(v.message, /本机密钥库是好的/)
  }
})

test('③ 凭证解析失败 → SECRET_UNAVAILABLE，且**根本不发请求**', async () => {
  const transport = okTransport()
  const probe = createModelProbe({
    transport,
    resolveSecret: async () => { throw Object.assign(new Error('DPAPI 换账户了'), { name: 'SecretStoreError', code: 'DECRYPT_FAILED' }) },
  })
  const v = await probe.probe({ profile: PROFILE })
  assert.equal(v.code, 'SECRET_UNAVAILABLE', '本地密钥库问题 ≠ 供应商拒绝')
  assert.equal(v.class, 'fail-closed')
  assert.match(v.message, /不要去供应商控制台换钥匙/)
  assert.equal(transport.calls.length, 0, '解不开钥匙时不该去敲供应商的门')
  // 原始 message 不得原样带出（密钥库异常可能含片段/路径/账户名）
  assert.ok(!v.message.includes('DPAPI 换账户了'), `不得原样带出密钥库异常：${v.message}`)
  assert.match(v.message, /SecretStoreError\/DECRYPT_FAILED/, '但要能看出是哪一类失败')
})

test('③ 需要凭证但没有解析器 → SECRET_UNAVAILABLE（不是 AUTH_FAILED）', async () => {
  const transport = okTransport()
  const probe = createModelProbe({ transport })
  const v = await probe.probe({ profile: PROFILE })
  assert.equal(v.code, 'SECRET_UNAVAILABLE')
  assert.match(v.message, /SECRET_UNAVAILABLE ≠ AUTH_FAILED/)
  assert.equal(transport.calls.length, 0)
})

test('③ 解析器返回空 → SECRET_UNAVAILABLE，不发请求', async () => {
  for (const empty of [null, undefined, '']) {
    const transport = okTransport()
    const probe = createModelProbe({ transport, resolveSecret: async () => empty })
    const v = await probe.probe({ profile: PROFILE })
    assert.equal(v.code, 'SECRET_UNAVAILABLE', `解析器返回 ${String(empty)}`)
    assert.equal(transport.calls.length, 0)
  }
})

test('③ 无凭证的本地模型：不调解析器，直接请求', async () => {
  const transport = okTransport({ chat: true })
  let resolverCalled = false
  const probe = createModelProbe({
    transport,
    resolveSecret: async () => { resolverCalled = true; return 'k' },
  })
  const local = { ...PROFILE, secretRef: null }
  const v = await probe.probe({ profile: local })
  assert.equal(v.ok, true)
  assert.equal(resolverCalled, false, '无需凭证的模型不该去碰密钥库')
  assert.equal(transport.calls[0].credential, null)
})

test('③ transport 抛异常 → 归一化后分类，绝不因"出错了"而通过', async () => {
  const cases = [
    [{ code: 'ENOTFOUND' }, 'ENDPOINT_UNREACHABLE'],
    [{ code: 'ECONNREFUSED' }, 'ENDPOINT_UNREACHABLE'],
    [{ code: 'ECONNRESET' }, 'ENDPOINT_UNREACHABLE'],
    [{ code: 'ETIMEDOUT' }, 'TIMEOUT'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'TLS_FAILED'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'TLS_FAILED'],
    [{ name: 'TimeoutError' }, 'TIMEOUT'],
    [new Error('boom'), 'UNCLASSIFIED'],
    [{ code: 'WEIRD_THING' }, 'UNCLASSIFIED'],
  ]
  for (const [err, want] of cases) {
    const t = makeTransport(err)
    const probe = createModelProbe({ transport: t, resolveSecret: async () => 'k' })
    const v = await probe.probe({ profile: PROFILE })
    assert.equal(v.ok, false, `${JSON.stringify(err)} 不得判为可用`)
    assert.equal(v.code, want, `${JSON.stringify(err)}`)
  }
})

test('③ 连不上是 transient、TLS 是 config——两者的下一步动作不同', async () => {
  const a = createModelProbe({
    transport: makeTransport({ code: 'ENOTFOUND' }), resolveSecret: async () => 'k',
  })
  const b = createModelProbe({
    transport: makeTransport({ code: 'CERT_HAS_EXPIRED' }), resolveSecret: async () => 'k',
  })
  const va = await a.probe({ profile: PROFILE })
  const vb = await b.probe({ profile: PROFILE })
  assert.equal(va.class, 'transient', '连不上：稍后重试有意义')
  assert.equal(vb.class, 'config', '证书问题：重试不会改变结果')
  assert.notEqual(va.message, vb.message)
})

test('③ 证书失败的消息里也要能看出不是"网络抖动"', async () => {
  const probe = createModelProbe({
    transport: makeTransport({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), resolveSecret: async () => 'k',
  })
  const v = await probe.probe({ profile: PROFILE })
  assert.equal(v.code, 'TLS_FAILED')
  assert.match(v.message, /重试不会改变结果|中间人/)
})

test('③ 传输层事实 → kind 的归一化覆盖 Node 与自定义 transport 的形状', () => {
  assert.deepEqual(normalizeTransportError({ name: 'AbortError' }), { kind: 'abort' })
  assert.deepEqual(normalizeTransportError({ name: 'TimeoutError' }), { kind: 'timeout' })
  assert.deepEqual(normalizeTransportError({ cause: { code: 'ECONNREFUSED' } }), { kind: 'connect' })
  assert.deepEqual(normalizeTransportError({ code: 'UND_ERR_CONNECT_TIMEOUT' }), { kind: 'connect' })
  assert.deepEqual(normalizeTransportError(new Error('self-signed certificate')), { kind: 'tls' })
  assert.deepEqual(normalizeTransportError(new Error('The operation was aborted')), { kind: 'abort' })
  assert.deepEqual(normalizeTransportError(new Error('socket timed out')), { kind: 'timeout' })
  assert.deepEqual(normalizeTransportError(new Error('随便什么')), { kind: 'unknown' })
  assert.deepEqual(normalizeTransportError(null), { kind: 'unknown' })
  assert.deepEqual(normalizeTransportError(undefined), { kind: 'unknown' })
  assert.deepEqual(normalizeTransportError('字符串异常'), { kind: 'unknown' })
})

// ------------------------------------------------------------------ ④ 取消

test('④ 主动取消**不写成失败码**（正常动作不该在审计里像事故）', async () => {
  const probe = createModelProbe({
    transport: makeTransport({ name: 'AbortError' }),
    resolveSecret: async () => 'k',
  })
  const v = await probe.probe({ profile: PROFILE })
  assert.equal(v.ok, false)
  assert.equal(v.cancelled, true)
  assert.match(v.message, /主动取消/)
  assert.match(v.message, /不是一次可用的证明，也不是一次故障判定/)
  // 取消**不进缓存**：一次取消不该让接下来的探测被跳过
  const again = await probe.probe({ profile: PROFILE })
  assert.equal(again.cancelled, true, '取消不进缓存，必须重探')
})

test('④ transport 返回 kind:abort 与抛 AbortError 等价', async () => {
  const probe = createModelProbe({
    transport: makeTransport({ kind: 'abort' }), resolveSecret: async () => 'k',
  })
  const v = await probe.probe({ profile: PROFILE })
  assert.equal(v.cancelled, true)
  assert.equal(v.code, 'UNCLASSIFIED', '取消确实不是失败码，但判定结果必须 ok:false')
})

// ------------------------------------------------------------------ ⑤ 密钥

test('⑤ **凭证不进判定、不进缓存、不进诊断**（在原始字节上验）', async () => {
  const SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
  const transport = okTransport()
  const probe = createModelProbe({ transport, resolveSecret: async () => SECRET })
  const verdict = await probe.probe({ profile: PROFILE })
  const diag = probe.inspect()

  const everything = JSON.stringify({ verdict, diag })
  assert.ok(!everything.includes(SECRET), `凭证泄漏进了判定或诊断：${everything}`)
  assert.ok(!/sk-live-/.test(everything))
  // 用仓库自己的明文密钥判据再查一遍（与写入路径共用同一判据）
  assert.deepEqual(findPlaintextSecrets(verdict), [])
  assert.deepEqual(findPlaintextSecrets(diag), [])
  // 凭证确实被传给了 transport（否则上面就是"因为压根没用所以没泄漏"）
  assert.equal(transport.calls[0].credential, SECRET)
})

test('⑤ 解析失败时也不泄漏密钥库异常原文', async () => {
  const probe = createModelProbe({
    transport: okTransport(),
    resolveSecret: async () => {
      throw Object.assign(new Error('cannot decrypt blob Qk9HVVM= account=DESKTOP\\alice'), { name: 'SecretStoreError' })
    },
  })
  const v = await probe.probe({ profile: PROFILE })
  assert.ok(!v.message.includes('Qk9HVVM='), `泄漏了密文片段：${v.message}`)
  assert.ok(!v.message.includes('alice'), `泄漏了账户名：${v.message}`)
})

// ------------------------------------------------------------------ ⑥ 有界

test('⑥ 缓存**有界**（配置页反复试不同 endpoint 不该无上限撑大内存）', async () => {
  const transport = okTransport()
  const probe = createModelProbe({ transport, resolveSecret: async () => 'k', maxEntries: 3 })
  for (let i = 0; i < 10; i += 1) {
    await probe.probe({ profile: { ...PROFILE, endpoint: `https://h${i}.example` } })
  }
  assert.equal(probe.inspect().size, 3, '超过上限必须淘汰最旧的')
  assert.equal(transport.calls.length, 10)
})

test('⑥ invalidate 按 id 清缓存；clear 清全部', async () => {
  const transport = okTransport()
  const probe = createModelProbe({ transport, resolveSecret: async () => 'k' })
  await probe.probe({ profile: PROFILE })
  await probe.probe({ profile: { ...PROFILE, id: 'm2' } })
  assert.equal(probe.inspect().size, 2)
  assert.equal(probe.invalidate('m1'), 1)
  assert.equal(probe.inspect().size, 1)
  assert.equal(probe.invalidate('nope'), 0)
  probe.clear()
  assert.equal(probe.inspect().size, 0)
  assert.equal(probe.inspect().attempts, 0)
})

test('⑥ inspect 记录每次真实探测（含未缓存的那次），供诊断对账', async () => {
  const transport = makeTransport((arg, n) => (n === 1
    ? { kind: 'http', status: 429 }
    : { kind: 'http', status: 200, capabilities: { chat: true } }))
  const clock = makeClock()
  const probe = createModelProbe({ transport, clock: clock.now, resolveSecret: async () => 'k' })
  await probe.probe({ profile: PROFILE })
  clock.advance(NEGATIVE_PROBE_TTL_MS + 1)
  await probe.probe({ profile: PROFILE })
  const d = probe.inspect()
  assert.equal(d.attempts, 2)
  assert.equal(d.entries.length, 1, '只留最新那条')
  assert.equal(d.entries[0].ok, true)
  assert.equal(d.entries[0].code, 'OK')
})

test('⑥ 缓存命中不产生新 attempt（否则诊断会把一次探测记成很多次）', async () => {
  const probe = createModelProbe({ transport: okTransport(), resolveSecret: async () => 'k' })
  await probe.probe({ profile: PROFILE })
  await probe.probe({ profile: PROFILE })
  await probe.probe({ profile: PROFILE })
  assert.equal(probe.inspect().attempts, 1)
})

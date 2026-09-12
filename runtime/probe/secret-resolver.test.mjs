// runtime/probe/secret-resolver.test.mjs
// ============================================================================
// 生产凭证解析器（PRT-505 的"生产调用方" + PRT-509 的读/轮换/删除）
//
// 用**内存后端 + 假 protector**，所以这一组不碰真实 DPAPI、不需要任何
// 真实密钥，却能覆盖：明文后端被拒、引用不存在、解不开、轮换后缓存失效、
// 明文不进任何诊断。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DPAPI_SCHEME,
  SecretStoreError,
  createProtector,
  createSecretStore,
  memoryBackend,
  nullProtector,
} from '../../security/secrets/index.mjs'
import { findPlaintextSecrets } from '../contracts/model.mjs'
import { createModelProbe } from './index.mjs'
import { RESOLVER_RAISED, createSecretResolver, inspectSecretStore } from './secret-resolver.mjs'

const SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'

/** 假保护方案：可逆但**不是** DPAPI，用来模拟"受保护"的后端。 */
function fakeProtector() {
  return createProtector({
    scheme: DPAPI_SCHEME,
    protect: (v) => `enc:${Buffer.from(v, 'utf8').toString('base64')}`,
    unprotect: (b) => {
      if (typeof b !== 'string' || !b.startsWith('enc:')) throw new Error('bad blob')
      return Buffer.from(b.slice(4), 'base64').toString('utf8')
    },
  })
}

function makeStore({ protector = fakeProtector(), entries = [], clock } = {}) {
  const backend = memoryBackend()
  const store = createSecretStore({ backend, protector, now: clock })
  return { store, backend, seed: async (ref, value) => store.put(ref, value) }
}

/** 一个永远成功的 transport，用来验"解析器与执行器接得上"。 */
const okTransport = () => {
  const calls = []
  const fn = async (arg) => { calls.push(arg); return { kind: 'http', status: 200, capabilities: { chat: true } } }
  fn.calls = calls
  return fn
}

const profileWith = (ref) => ({
  id: 'm1', displayName: '主模型', runtimeType: 'dsh', provider: 'openai',
  model: 'gpt-4o', endpoint: 'https://api.example/v1', secretRef: ref,
  reasoningEffort: 'medium', limits: {},
})

// ------------------------------------------------------------------ ① 构造

test('① 没有 store 就构造不出来（"取不到凭证"不能变成"不需要凭证"）', () => {
  assert.throws(() => createSecretResolver({}), TypeError)
  assert.throws(() => createSecretResolver({ store: {} }), TypeError)
  assert.throws(() => createSecretResolver({ store: { get: 1 } }), TypeError)
  assert.equal(RESOLVER_RAISED.STORE_MISSING, 'SECRET_STORE_MISSING')
})

test('① 明文后端**在构造时**就被拒绝（不是等到第一次要用密钥）', () => {
  // 明文后端的失败必须发生在构造时：等到第一次真要用密钥时才发现，
  // 那个错误会落在一次运行中间，而用户不会把它读成"我的密钥库没加密"。
  const { store } = makeStore({ protector: nullProtector() })
  assert.throws(() => createSecretResolver({ store }),
    (e) => e instanceof SecretStoreError && e.code === 'SECRET_STORE_UNPROTECTED')
  // 开发/测试可以显式放开，但那是一个**要说出来**的选择
  assert.doesNotThrow(() => createSecretResolver({ store, requireProtected: false }))
})

test('① protection() 如实报出方案（供诊断与启动自检显示）', () => {
  const { store } = makeStore()
  const r = createSecretResolver({ store })
  assert.deepEqual({ ...r.protection() }, { scheme: DPAPI_SCHEME, protected: true })
})

// ------------------------------------------------------------------ ② 解析

test('② 解析成功返回**明文字符串**，且直接能喂给探测执行器', async () => {
  const { store, seed } = makeStore()
  await seed('legion/openai', SECRET)
  const r = createSecretResolver({ store })
  const value = await r.resolveSecret('legion/openai')
  assert.equal(value, SECRET)
  assert.equal(typeof value, 'string')

  // 接上执行器：凭证传给 transport，判定通过
  const transport = okTransport()
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret, credentialVersionOf: r.credentialVersionOf,
  })
  const v = await probe.probe({ profile: profileWith('legion/openai') })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(transport.calls[0].credential, SECRET)
})

test('② profile 可以省略 ref（从 profile 上取），也可以显式给', async () => {
  const { store, seed } = makeStore()
  await seed('legion/a', 'value-a')
  const r = createSecretResolver({ store })
  assert.equal(await r.resolveSecret(null, profileWith('legion/a')), 'value-a')
  assert.equal(await r.resolveSecret(undefined, profileWith('legion/a')), 'value-a')
  assert.equal(await r.resolveSecret('legion/a'), 'value-a')
})

test('② 无凭证的档案返回 null（"不需要凭证"不是错误）', async () => {
  const { store } = makeStore()
  const r = createSecretResolver({ store })
  for (const ref of [null, undefined, '']) {
    assert.equal(await r.resolveSecret(ref, profileWith(ref)), null)
  }
  // 本地模型：执行器不发 Authorization 头，判定通过
  const transport = okTransport()
  const probe = createModelProbe({ transport, resolveSecret: r.resolveSecret })
  const v = await probe.probe({ profile: profileWith(null) })
  assert.equal(v.ok, true)
  assert.equal(transport.calls[0].credential, null)
})

// ------------------------------------------------------------------ ③ 失败

test('③ 引用不存在 → SECRET_UNAVAILABLE（**绝不是** AUTH_FAILED）', async () => {
  const { store } = makeStore()
  const r = createSecretResolver({ store })
  await assert.rejects(() => r.resolveSecret('legion/missing'),
    (e) => e instanceof SecretStoreError && e.code === 'SECRET_NOT_FOUND'
      && e.runtimeErrorCode === 'SECRET_UNAVAILABLE')
})

test('③ 解不开 → SECRET_UNAVAILABLE，且错误里带得上"该怎么修"', async () => {
  const { store, backend } = makeStore()
  await store.put('legion/broken', SECRET)
  // 模拟"换了 Windows 账户"/"从另一台机器拷了密钥库文件"：密文解不出来。
  // 注意**不能**用非法 base64 来造损坏——`Buffer.from(x,'base64')` 会静默忽略
  // 非法字符而不抛，于是"损坏"根本不会发生，用例测的是一个不存在的路径。
  // 这里直接把密文换成完全不属于本方案的形状。
  const rec = await backend.read('legion/broken')
  await backend.write('legion/broken', { blob: 'not-a-protected-blob', meta: rec.meta })
  const r = createSecretResolver({ store })
  await assert.rejects(() => r.resolveSecret('legion/broken'),
    (e) => e.code === 'SECRET_DECRYPT_FAILED' && e.runtimeErrorCode === 'SECRET_UNAVAILABLE')
  const err = await r.resolveSecret('legion/broken').catch((e) => e)
  assert.match(err.message, /换了 Windows 账户|另一台机器/, '要指向真实的常见原因')
  assert.ok(!err.message.includes(SECRET), '错误里不得出现明文')
})

test('③ 底层异常被收敛，**不原样带出** message（可能含密文片段/路径/账户名）', async () => {
  const backend = memoryBackend()
  const store = createSecretStore({
    backend: {
      read: async () => { throw new Error('cannot read C:\\Users\\alice\\AppData\\creds.bin account=DESKTOP\\alice') },
      write: async () => {}, remove: async () => false, entries: async () => [],
    },
    protector: fakeProtector(),
  })
  const r = createSecretResolver({ store })
  const err = await r.resolveSecret('legion/x').catch((e) => e)
  assert.equal(err.code, 'SECRET_STORE_UNREADABLE')
  assert.ok(!err.message.includes('alice'), `泄漏了账户名/路径：${err.message}`)
  assert.ok(!err.message.includes('creds.bin'), `泄漏了路径：${err.message}`)
  assert.match(err.message, /Error/, '但要保留"是哪一类异常"这个结构信息')
})

test('③ 解析失败**不会去敲供应商的门**（少发一次证明不了什么的请求）', async () => {
  const { store } = makeStore()
  const r = createSecretResolver({ store })
  const transport = okTransport()
  const probe = createModelProbe({ transport, resolveSecret: r.resolveSecret })
  const v = await probe.probe({ profile: profileWith('legion/missing') })
  assert.equal(v.code, 'SECRET_UNAVAILABLE')
  assert.equal(v.class, 'fail-closed')
  assert.equal(transport.calls.length, 0,
    '解不开钥匙时那次 401 什么也证明不了，反而会变成一条"鉴权失败"的证据')
})

test('③ 引用名非法 → SECRET_UNAVAILABLE（不是崩溃）', async () => {
  const { store } = makeStore()
  const r = createSecretResolver({ store })
  await assert.rejects(() => r.resolveSecret('..'), (e) => e.runtimeErrorCode === 'SECRET_UNAVAILABLE')
  await assert.rejects(() => r.resolveSecret('a/b/c'), (e) => e.runtimeErrorCode === 'SECRET_UNAVAILABLE')
})

// ------------------------------------------------------------------ ④ 轮换

test('④ **轮换后探测缓存自动失效**（不需要任何人记得清缓存）', async () => {
  let t = 1_700_000_000_000
  const clock = () => new Date(t).toISOString()
  const { store } = makeStore({ clock })
  await store.put('legion/rot', 'first-key')

  const transport = okTransport()
  const r = createSecretResolver({ store })
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret, credentialVersionOf: r.credentialVersionOf,
    clock: () => t,
  })
  const profile = profileWith('legion/rot')

  await probe.probe({ profile })
  assert.equal(transport.calls.length, 1)
  // 同一把钥匙第二次 → 命中缓存
  const second = await probe.probe({ profile })
  assert.equal(second.cached, true)
  assert.equal(transport.calls.length, 1)

  // 轮换：引用名不变、值变了
  t += 60_000
  await store.rotate('legion/rot', 'second-key')

  const after = await probe.probe({ profile })
  assert.equal(after.cached, false,
    '轮换后必须重探：同一引用名下换了一把钥匙，判定就该重来')
  assert.equal(transport.calls.length, 2)
  assert.equal(transport.calls[1].credential, 'second-key', '用的必须是新钥匙')
})

test('④ 好钥匙被换成坏钥匙时**不会**继续显示"通过"', async () => {
  // 这是反方向、也是更糟的方向：界面显示"通过"，而真实的运行会失败。
  let t = 1_700_000_000_000
  const { store } = makeStore({ clock: () => new Date(t).toISOString() })
  await store.put('legion/k', 'good-key')

  let next = { kind: 'http', status: 200, capabilities: { chat: true } }
  const transport = async () => next
  const r = createSecretResolver({ store })
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret, credentialVersionOf: r.credentialVersionOf,
    clock: () => t,
  })
  const profile = profileWith('legion/k')

  assert.equal((await probe.probe({ profile })).ok, true)
  // 轮换到一把坏钥匙（供应商会拒绝）
  t += 1_000
  await store.rotate('legion/k', 'bad-key')
  next = { kind: 'http', status: 401 }
  const after = await probe.probe({ profile })
  assert.equal(after.code, 'AUTH_FAILED', '必须重探并如实报出供应商拒绝')
  assert.equal(after.cached, false)
})

test('④ 凭证被删除 → 探测报 SECRET_UNAVAILABLE（不是继续用旧判定）', async () => {
  let t = 1_700_000_000_000
  const { store } = makeStore({ clock: () => new Date(t).toISOString() })
  await store.put('legion/gone', SECRET)
  const r = createSecretResolver({ store })
  const transport = okTransport()
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret, credentialVersionOf: r.credentialVersionOf,
    clock: () => t,
  })
  const profile = profileWith('legion/gone')
  assert.equal((await probe.probe({ profile })).ok, true)

  t += 1_000
  await store.remove('legion/gone')
  const after = await probe.probe({ profile })
  assert.equal(after.code, 'SECRET_UNAVAILABLE', '钥匙没了就是本地取不到，不是供应商拒绝')
  assert.equal(after.cached, false)
  // 而且**不得**再发请求
  assert.equal(transport.calls.length, 1)
})

test('④ 版本取不到时**绝不命中缓存**（宁可多探一次）', async () => {
  // 两种错法的代价不对称：给唯一值 → 缓存不命中 → 真的探一次（多花一次请求，
  // 结果正确）；给空串 → "版本未知"的两次探测互相命中 → 可能拿旧钥匙的判定
  // 回答新钥匙的问题。
  const { store, backend } = makeStore()
  await store.put('legion/v', SECRET)
  const transport = okTransport()
  const r = createSecretResolver({ store })
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret,
    // describe 永远读不出来
    credentialVersionOf: async () => { throw new Error('describe failed') },
  })
  const profile = profileWith('legion/v')
  await probe.probe({ profile })
  const second = await probe.probe({ profile })
  assert.equal(second.cached, false, '版本未知时不得命中缓存')
  assert.equal(transport.calls.length, 2)
  assert.ok(backend !== null)
})

test('④ 轮换不影响**别的**档案的缓存（指纹按引用名分桶）', async () => {
  let t = 1_700_000_000_000
  const { store } = makeStore({ clock: () => new Date(t).toISOString() })
  await store.put('legion/a', 'a1')
  await store.put('legion/b', 'b1')
  const transport = okTransport()
  const r = createSecretResolver({ store })
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret, credentialVersionOf: r.credentialVersionOf,
    clock: () => t,
  })
  const pa = { ...profileWith('legion/a'), id: 'a' }
  const pb = { ...profileWith('legion/b'), id: 'b' }
  await probe.probe({ profile: pa })
  await probe.probe({ profile: pb })
  assert.equal(transport.calls.length, 2)

  t += 1_000
  await store.rotate('legion/a', 'a2')
  const ra = await probe.probe({ profile: pa })
  const rb = await probe.probe({ profile: pb })
  assert.equal(ra.cached, false, '被轮换的那条要重探')
  assert.equal(rb.cached, true, '没被动的那条不该被牵连')
  assert.equal(transport.calls.length, 3)
})

// ------------------------------------------------------------------ ⑤ 不泄漏

test('⑤ 明文不进任何诊断、日志或错误（在原始字节上验）', async () => {
  const { store } = makeStore()
  await store.put('legion/openai', SECRET)
  const r = createSecretResolver({ store })
  const transport = okTransport()
  const probe = createModelProbe({
    transport, resolveSecret: r.resolveSecret, credentialVersionOf: r.credentialVersionOf,
  })
  const profile = profileWith('legion/openai')
  const verdict = await probe.probe({ profile })
  const diag = probe.inspect()
  const meta = await store.list()
  const described = await store.describe('legion/openai')

  const everything = JSON.stringify({ verdict, diag, meta, described, protection: r.protection() })
  assert.ok(!everything.includes(SECRET), `明文泄漏：${everything}`)
  assert.ok(!/sk-live-/.test(everything))
  assert.deepEqual(findPlaintextSecrets(verdict), [])
  assert.deepEqual(findPlaintextSecrets(diag), [])
  assert.deepEqual(findPlaintextSecrets(described), [])
  // 但明文确实被用上了（否则上面是"因为没用所以没泄漏"）
  assert.equal(transport.calls[0].credential, SECRET)
})

test('⑤ 密钥库自己序列化时也脱敏（堵住"顺手 JSON.stringify(store)"）', async () => {
  const { store } = makeStore()
  await store.put('legion/openai', SECRET)
  const text = JSON.stringify(store)
  assert.ok(!text.includes(SECRET))
  assert.match(text, /redacted/)
  assert.ok(!String(store).includes(SECRET))
})

test('⑤ onResolve 回调只拿到元数据，拿不到明文', async () => {
  const { store } = makeStore()
  await store.put('legion/openai', SECRET)
  const seen = []
  const r = createSecretResolver({ store, onResolve: (e) => seen.push(e) })
  await r.resolveSecret('legion/openai')
  const text = JSON.stringify(seen)
  assert.ok(!text.includes(SECRET), `回调收到了明文：${text}`)
  assert.equal(seen[0].ref, 'legion/openai')
  assert.equal(seen[0].ok, true)
})

// ------------------------------------------------------------------ ⑥ 自检

test('⑥ inspectSecretStore 返回结果而不抛（自检不是形状错误）', () => {
  const { store } = makeStore()
  const ok = inspectSecretStore(store)
  assert.equal(ok.ok, true)
  assert.equal(ok.protection.scheme, DPAPI_SCHEME)

  const { store: plain } = makeStore({ protector: nullProtector() })
  const bad = inspectSecretStore(plain)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, RESOLVER_RAISED.PROTECTION_REQUIRED)
  assert.match(bad.message, /不得用于真实密钥/)

  const none = inspectSecretStore(null)
  assert.equal(none.ok, false)
  assert.equal(none.code, RESOLVER_RAISED.STORE_MISSING)

  // 保护方案不在允许列表内也拦
  const restricted = inspectSecretStore(store, { allowedSchemes: ['something-else'] })
  assert.equal(restricted.ok, false)
  assert.match(restricted.message, /不在允许列表内/)
})

test('⑥ 自检不抛：坏掉的 store 也返回结果', () => {
  const broken = { protection: () => { throw new Error('boom at C:\\Users\\bob') } }
  const r = inspectSecretStore(broken)
  assert.equal(r.ok, false)
  assert.ok(!r.message.includes('bob'), '自检消息里也不得带出路径/账户')
})

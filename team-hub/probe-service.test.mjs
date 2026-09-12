// team-hub/probe-service.test.mjs
// ============================================================================
// PRT-507 后半：「测试连接」的后端
//
// 这一组守的核心是**一条分界**：
//
//   **「这次没有探测过」绝不能被表示成「探测失败」。**
//
// 两种说法的代价**不对称**：
//   - 说成"模型连不上" → 用户去查网络、查供应商状态、查模型名
//     ——**一条完全错误的方向**；
//   - 说成"没测过" → 用户去查密钥库 ——那是真正的原因。
//
// 而这一组存在的前提是：在此之前 PRT-504 的整套探测**没有任何非测试调用方**。
// 功能、用例、文档全都在，没有任何入口能触发它。
// 所以最后一条用例专门守"这件事真的被接上了"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROBE_UNAVAILABLE_CODES,
  createProbeService,
  unavailableResult,
} from './probe-service.mjs'

const LAYOUT_OK = { layout: { secretsFile: 'C:\\Users\\a\\AppData\\Local\\Legion\\secrets\\credentials.json' }, diagnostics: [] }

/** 一个"密钥库正常打开"的假实现，resolver 可注入。 */
const openOk = (resolveSecret = async () => 'sk-test') => async () => ({
  ok: true,
  code: 'SECRETS_OK',
  path: LAYOUT_OK.layout.secretsFile,
  resolver: { resolveSecret, credentialVersionOf: () => 'v1' },
  store: {},
})

/** 一个"永远回 200 + 模型清单"的 transport。 */
const okTransport = (capabilities = { chat: true }) => async () => ({
  kind: 'http', status: 200, latencyMs: 12, capabilities,
})

const PROFILE = Object.freeze({
  id: 'p1', displayName: 'X', provider: 'custom-ds', model: 'm1',
  endpoint: 'https://api.example.com', secretRef: 'K',
})

const service = (over = {}) => createProbeService({
  resolveLayoutImpl: () => LAYOUT_OK,
  openSecrets: openOk(),
  transport: okTransport(),
  ...over,
})

// ------------------------------------------------------------------ 正常路径

test('密钥库正常 + 供应商 200 → 真的给出探测判定', async () => {
  const r = await service().probeModelProfile(PROFILE)
  assert.equal(r.ok, true)
  assert.equal(r.code, 'OK')
  assert.equal(r.unavailable, undefined, '这是**真实判定**，不是"没探测过"')
  assert.equal(r.cached, false)
})

test('命中新鲜缓存 → cached:true（探测是要花钱的，不该每次点都真发请求）', async () => {
  let calls = 0
  const s = service({ transport: async () => { calls += 1; return { kind: 'http', status: 200, latencyMs: 5, capabilities: {} } } })
  await s.probeModelProfile(PROFILE)
  const second = await s.probeModelProfile(PROFILE)
  assert.equal(calls, 1, '第二次不该再发请求')
  assert.equal(second.cached, true)
})

test('force:true 忽略缓存，强制真探一次', async () => {
  let calls = 0
  const s = service({ transport: async () => { calls += 1; return { kind: 'http', status: 200, latencyMs: 5, capabilities: {} } } })
  await s.probeModelProfile(PROFILE)
  await s.probeModelProfile(PROFILE, { force: true })
  assert.equal(calls, 2)
})

// ------------------------------------------------------------------ 核心分界

test('**密钥库打不开 → UNAVAILABLE，而不是"连不上"**', async () => {
  const s = service({ openSecrets: async () => ({ ok: false, code: 'SECRETS_STORE_UNPROTECTED' }) })
  const r = await s.probeModelProfile(PROFILE)

  assert.equal(r.unavailable, true, '必须能被识别成"没测过"')
  assert.equal(r.code, PROBE_UNAVAILABLE_CODES.SECRETS_UNAVAILABLE)
  assert.equal(r.ok, false)
  // 关键的结构性判据：**没有失败分类**。没有 `class` 就没有"失败原因"可言。
  //
  // 这里刻意**不**用"文案里不许出现'连不上'"这类正则：文案里恰恰要**引用**
  // 这句错误说法来否定它（"这不是"模型连不上""），于是那种断言会因为
  // 正确的话而失败——**一个会被正确实现绊倒的断言，比没有断言更坏**。
  assert.equal(r.class, undefined, '没探测过就不该有失败分类')
  assert.equal(r.latencyMs, undefined, '没发过请求就没有延迟可言')
  assert.match(r.message, /这次没有探测过/)
  assert.match(r.message, /别去查网络/, '要明确拦住那条错误的方向')
})

test('**布局不合法 → UNAVAILABLE，而不是"连不上"**', async () => {
  const s = service({
    resolveLayoutImpl: () => ({ layout: {}, diagnostics: [{ severity: 'error', code: 'SECRETS_INSIDE_DATA_DIR' }] }),
  })
  const r = await s.probeModelProfile(PROFILE)
  assert.equal(r.unavailable, true)
  assert.equal(r.code, PROBE_UNAVAILABLE_CODES.LAYOUT_BLOCKED)
  assert.match(r.message, /这次没有探测过/)
})

test('**没有 endpoint → 说"配置缺失"，不说"供应商故障"**', async () => {
  const r = await service().probeModelProfile({ ...PROFILE, endpoint: '' })
  assert.equal(r.unavailable, true)
  assert.match(r.message, /没有填 endpoint/)
  assert.match(r.message, /这次没有探测过/)
})

test('没有档案 → UNAVAILABLE（不抛）', async () => {
  for (const bad of [null, undefined, 42, 'x']) {
    const r = await service().probeModelProfile(bad)
    assert.equal(r.unavailable, true, `profile=${JSON.stringify(bad)}`)
  }
})

test('UNAVAILABLE 与真实判定的**结构不同**（调用方无法顺手混用）', () => {
  const u = unavailableResult('X', 'm')
  assert.equal(u.unavailable, true)
  assert.equal('class' in u, false, '没有失败分类可言')
  assert.equal('latencyMs' in u, false, '没有延迟可言——我们没发过请求')
})

// ------------------------------------------------------------------ 真实判定仍然如实

test('供应商 401 → 仍然是**真实判定**（这类才该说"鉴权失败"）', async () => {
  // 这一条是上面的对照：真的问过了，就该如实说鉴权失败。
  const s = service({ transport: async () => ({ kind: 'http', status: 401, latencyMs: 8 }) })
  const r = await s.probeModelProfile(PROFILE)
  assert.equal(r.unavailable, undefined, '问过了就不是"没测过"')
  assert.equal(r.ok, false)
  assert.equal(typeof r.code, 'string')
  assert.notEqual(r.code, PROBE_UNAVAILABLE_CODES.SECRETS_UNAVAILABLE)
})

test('凭证解析失败 → **不发请求**，且判成 SECRET_UNAVAILABLE（不是 AUTH_FAILED）', async () => {
  // 没有钥匙时发出的 401 什么也证明不了。这一条与 PRT-505 的纪律一致。
  //
  // 注意这里**没有**被我的服务拦成 `unavailable`：执行器已经把它建模成一条
  // 带独立分类的判定（`class: 'fail-closed'`），文案明确写着"不是供应商的问题…
  // 不要去供应商控制台换钥匙"。**执行器那层处理得比我拦下来更好**——
  // 它有专门的分类和更准的话；在服务层再拦一次只会让判定存在两个产生点。
  let sent = 0
  const s = service({
    openSecrets: openOk(async () => { throw Object.assign(new Error('no'), { name: 'SecretStoreError' }) }),
    transport: async () => { sent += 1; return { kind: 'http', status: 200, latencyMs: 1, capabilities: {} } },
  })
  const r = await s.probeModelProfile(PROFILE)
  assert.equal(sent, 0, '凭证拿不到就不该发请求')
  assert.equal(r.code, 'SECRET_UNAVAILABLE', '必须是这个码，而不是 AUTH_FAILED')
  assert.equal(r.class, 'fail-closed')
  assert.match(r.message, /不是供应商的问题/)
})

// ------------------------------------------------------------------ 缓存失效

test('`invalidate()` 后重新开密钥库并清空探测缓存', async () => {
  let opened = 0
  const s = createProbeService({
    resolveLayoutImpl: () => LAYOUT_OK,
    openSecrets: async () => {
      opened += 1
      return {
        ok: true, code: 'SECRETS_OK', path: LAYOUT_OK.layout.secretsFile,
        resolver: { resolveSecret: async () => 'sk', credentialVersionOf: () => 'v1' }, store: {},
      }
    },
    transport: okTransport(),
  })
  await s.probeModelProfile(PROFILE)
  assert.equal(opened, 1)
  await s.probeModelProfile(PROFILE)
  assert.equal(opened, 1, '第二次不该重新开密钥库')

  s.invalidate()
  assert.equal(s.inspect().opened, false, '失效后必须重新打开——不能被缓存的旧钥匙骗')
  await s.probeModelProfile(PROFILE)
  assert.equal(opened, 2)
})

test('`inspect()` 不带凭证，**也不带引用名**（诊断会进日志与诊断包）', async () => {
  const s = service()
  await s.probeModelProfile(PROFILE)
  const snap = s.inspect()
  const text = JSON.stringify(snap)
  assert.ok(!text.includes('sk-'), '不得出现密钥')
  assert.ok(!text.includes('"K"'), '不得出现 secretRef 引用名——它能画出这台机器配了哪些供应商')
  // 缓存键 = `profileId\u0000fingerprint`，而 fingerprint 含引用名。
  // **能算出指纹 ≠ 该把指纹写进日志。**
  assert.ok(!snap.cacheKeys, '不得暴露缓存键')
  assert.equal(snap.cacheSize, 1, '但数目要说出来，否则"有没有缓存"无从判断')
  assert.deepEqual(snap.cacheCodes, ['OK'], '判定码可以出来——它不含引用名，且是诊断真正需要的')
  assert.equal(snap.opened, true)
})

// ------------------------------------------------------------------ 接线（这一组存在的理由）

test('**探测这件事真的有非测试调用方**（PRT-504 此前是死代码）', async () => {
  // 这一条守的是一个已经发生过的形态：PRT-504 交付了实现 + 两个套件 + 文档，
  // 而 `git grep createModelProbe` 的非测试命中**只有它自己的实现文件**——
  // 「测试连接」整套都在，没有任何入口能触发它。
  //
  // **一个没有任何入口的功能，和一个不存在的功能，从用户角度看完全一样。**
  //
  // 这里做源码断言（弱），真正的行为验证是真起 hub 发一次请求。
  const { readFileSync } = await import('node:fs')
  const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(server, /createProbeService/, 'team-hub 必须真的构造探测服务')
  assert.match(server, /probeModelProfile\(/, '必须有路由调用它')
})

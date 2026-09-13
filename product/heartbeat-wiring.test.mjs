// product/heartbeat-wiring.test.mjs
// ============================================================================
// PRT-713 收尾：真实的发送通道 + 同意采集 + Launcher 接线
//
// ## 这一批补的是三条**互相独立**的缺口，而它们有一个共同点
//
//   ① 没有真实的 transport —— 心跳**发不出去任何东西**；
//   ② 没有同意流程 —— `consent` 只有测试能提供，"没同意就不发"那道闸
//      的实际效果是**永久关闭**；
//   ③ 没有接进 Launcher —— 装配那个模块的只有测试。
//
// 共同点是：**它们都不让任何一条用例变红。** 一个注入式 transport 让所有
// 关于"什么不许发"的用例都能跑绿；一道永远拦着的闸让"没有同意就不发"
// 也跑绿；一个没有生产调用方的模块让全部单测跑绿。
//
//   > 一个"所有闸门都被测过、但门后没有路"的心跳，
//   > 与一个"真的能发出去"的心跳，在测试报告上是同一个读数——
//   > 只不过前者永远不会因为网络、超时、证书而失败，
//   > 所以它**也不会**因为那些原因被修好。
//
// ## 网络怎么办
//
// 一条真实网络请求的用例是**不可靠的**（别人的服务、本机代理、CI 无网），
// 而不可靠的用例会被跳过或删掉，于是"能发出去"这件事又变成没人守的东西。
// 所以这里注入的是 `requestImpl`（`node:https.request` 的替身），
// 而**产品里那条真的路径全长这样**：URL 解析、超时定时器、排空响应、
// 状态码判定、不重试——这些全部被执行，只有套接字那一层是假的。
//
// 这一批**没有**跑过真实 HTTPS 请求。这是诚实边界，见文件末尾。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { HEARTBEAT_CODES, createHeartbeat, validateHeartbeatPolicy } from './heartbeat.mjs'
import {
  MAX_PAYLOAD_BYTES, checkEndpoint, checkPayload, createHttpTransport,
} from './heartbeat-transport.mjs'
import {
  CONSENT_CODES, CONSENT_FILENAME, CONSENT_SCHEMA, consentPath, readConsent, validateConsentRecord, writeConsent,
} from './heartbeat-consent.mjs'
import {
  HEARTBEAT_WIRING_CODES, attachHeartbeat, createLauncherHeartbeat, wireHeartbeat,
} from './launcher/heartbeat-wiring.mjs'

function tmpRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-hb-${tag}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 一个"会成功"的 `https.request` 替身：记录参数，回 204。 */
function fakeRequest({ status = 204, onCall = null, failWith = null } = {}) {
  const calls = []
  const impl = (options) => {
    const req = new EventEmitter()
    req.written = ''
    req.ended = false
    req.destroyed = false
    req.write = (chunk) => { req.written += chunk }
    req.end = () => {
      req.ended = true
      calls.push({ options, body: req.written })
      if (onCall !== null) onCall(options, req.written)
      // 异步回应：真实的 request 从不同步回调。
      setImmediate(() => {
        if (failWith !== null) { req.emit('error', failWith); return }
        const res = new EventEmitter()
        res.statusCode = status
        res.resumed = false
        res.resume = () => { res.resumed = true }
        req.emit('response', res)
        setImmediate(() => res.emit('end'))
      })
    }
    req.destroy = () => { req.destroyed = true }
    return req
  }
  impl.calls = calls
  return impl
}

// ============================================================================
// ① 端点与载荷判定（纯）
// ============================================================================

test('★★ `checkEndpoint`：**这一层自己判 https**，不假设调用方校验过', () => {
  assert.equal(checkEndpoint('https://hb.example.com/x').ok, true)
  for (const bad of [
    'http://hb.example.com/x',   // 明文
    'ftp://hb.example.com',      // 别的协议
    'not a url',
    '',
    null, undefined, 42,
  ]) {
    const r = checkEndpoint(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 被当成了可用端点`)
    assert.equal(r.code, HEARTBEAT_CODES.INVALID_ENDPOINT,
      `${JSON.stringify(bad)} 的码不是 INVALID_ENDPOINT（那会让"配错了"与"发不出去"混在一起）`)
  }
})

test('★★ `checkPayload`：校验的**那一串字节**就是发出去的那一串', () => {
  const ok = checkPayload({ schema: 'legion/heartbeat@1', runtimeState: 'running' })
  assert.equal(ok.ok, true)
  assert.equal(typeof ok.body, 'string')
  assert.equal(ok.bytes, Buffer.byteLength(ok.body, 'utf8'))
  // ★ 返回 body 而不是"再序列化一次"：先校验对象、再另外序列化，
  //   中间那段代码（比如一个 getter）有第二次机会改内容。
  assert.equal(JSON.parse(ok.body).schema, 'legion/heartbeat@1')

  // ★★ 这里**必须**用会数数的对象来钉住"只序列化一次"。
  //
  //   只断言 `JSON.parse(body)` 的字段是对的，是**测不出**这个差别的：
  //   同一个普通对象序列化两次得到一模一样的字节。断验证 ㊿ 量到了这一点
  //   ——把返回值改成"另外序列化一次"，**套件全绿**。
  //
  //     > 一个"再序列化一次也一样"的断言，
  //     > 与一个"钉住了只序列化一次"的断言，在普通对象上是同一个读数——
  //     > 只不过前者的绿，是靠**没有 getter** 换来的。
  let calls = 0
  const counted = { schema: 'legion/heartbeat@1' }
  Object.defineProperty(counted, 'runtimeState', {
    enumerable: true,
    get() { calls += 1; return calls === 1 ? 'running' : 'TAMPERED' },
  })
  const r2 = checkPayload(counted)
  assert.equal(r2.ok, true)
  assert.equal(calls, 1, `序列化了 ${calls} 次——校验过的和发出去的不是同一串字节`)
  assert.equal(JSON.parse(r2.body).runtimeState, 'running',
    '发出去的字节不是被校验的那一串（getter 有第二次机会改内容）')

  for (const bad of [null, [], 'x', 42]) {
    const r = checkPayload(bad)
    assert.equal(r.ok, false)
    assert.equal(r.code, HEARTBEAT_CODES.PAYLOAD_REJECTED)
  }
  // 超限：合法心跳远到不了 4KB，超了说明允许名单被加宽了
  const big = checkPayload({ productVersion: 'x'.repeat(MAX_PAYLOAD_BYTES + 10) })
  assert.equal(big.ok, false)
  assert.equal(big.code, HEARTBEAT_CODES.PAYLOAD_REJECTED)
  assert.match(big.message, /允许名单被加宽/)
})

test('★ `checkPayload`：循环引用 → PAYLOAD_REJECTED，不是抛出去', () => {
  const cyc = { a: 1 }
  cyc.self = cyc
  const r = checkPayload(cyc)
  assert.equal(r.ok, false)
  assert.equal(r.code, HEARTBEAT_CODES.PAYLOAD_REJECTED)
})

// ============================================================================
// ② 真实 transport（只换掉套接字那一层）
// ============================================================================

test('★★★ transport：真的发出 POST，且 **https 是这一层自己判的**', async () => {
  const impl = fakeRequest({ status: 204 })
  const transport = createHttpTransport({
    policy: { endpoint: 'https://hb.example.com/beat', timeoutMs: 5000 },
    requestImpl: impl,
  })
  const r = await transport({ schema: 'legion/heartbeat@1' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 204)
  assert.equal(impl.calls.length, 1, '没有真的发起请求')
  const { options, body } = impl.calls[0]
  assert.equal(options.method, 'POST')
  assert.equal(options.protocol, 'https:')
  assert.equal(options.hostname, 'hb.example.com')
  assert.equal(options.path, '/beat')
  assert.equal(options.port, 443, '没写端口时应当是 443')
  assert.equal(options.headers['content-type'], 'application/json')
  assert.equal(options.headers['content-length'], Buffer.byteLength(body, 'utf8'),
    'content-length 与真正写进去的字节数不一致')
  assert.equal(JSON.parse(body).schema, 'legion/heartbeat@1')
})

test('★★★ transport：`timeoutMs` **真的生效**（超时会 destroy 并报错）', async () => {
  // 一个**永远不回应**的服务端：连上了，但不给 response。
  const impl = () => {
    const req = new EventEmitter()
    req.write = () => {}
    req.end = () => { /* 什么都不发生 */ }
    req.destroy = () => { req.destroyed = true }
    req.destroyed = false
    impl.last = req
    return req
  }
  const transport = createHttpTransport({
    policy: { endpoint: 'https://hb.example.com/beat', timeoutMs: 30 },
    requestImpl: impl,
  })
  const began = Date.now()
  await assert.rejects(
    () => transport({ schema: 'legion/heartbeat@1' }),
    (e) => {
      assert.equal(e.code, HEARTBEAT_CODES.SEND_FAILED)
      assert.equal(e.timeoutMs, 30)
      assert.match(e.message, /发送超时/)
      return true
    },
    '超时没有生效——一个不做超时的发送会让"每 6 小时一次"变成一堆挂着的连接',
  )
  const elapsed = Date.now() - began
  assert.ok(elapsed >= 25, `超时在 ${elapsed}ms 就触发了，太早（说明不是超时那条路）`)
  assert.ok(elapsed < 3000, `超时用了 ${elapsed}ms——` + '一个不做超时的发送会悄悄堆积')
  // ★ 必须 destroy：不 destroy 的话套接字会挂到进程退出。
  assert.equal(impl.last.destroyed, true, '超时之后没有 destroy 套接字（会留下僵尸连接）')
})

test('★★★ transport：非 2xx → 失败，且**不重试**', async () => {
  const impl = fakeRequest({ status: 500 })
  const transport = createHttpTransport({
    policy: { endpoint: 'https://hb.example.com/beat', timeoutMs: 2000 },
    requestImpl: impl,
  })
  await assert.rejects(
    () => transport({ schema: 'legion/heartbeat@1' }),
    (e) => { assert.equal(e.code, HEARTBEAT_CODES.SEND_FAILED); assert.equal(e.status, 500); return true },
  )
  assert.equal(impl.calls.length, 1, `重试了 ${impl.calls.length} 次——` +
    '关掉之后在路上的重试会成为一个新的泄漏口')
})

test('★★ transport：网络错误 → SEND_FAILED，**不重试**', async () => {
  const impl = fakeRequest({ failWith: new Error('ECONNREFUSED') })
  const transport = createHttpTransport({
    policy: { endpoint: 'https://hb.example.com/beat', timeoutMs: 2000 },
    requestImpl: impl,
  })
  await assert.rejects(
    () => transport({ schema: 'legion/heartbeat@1' }),
    (e) => { assert.equal(e.code, HEARTBEAT_CODES.SEND_FAILED); assert.match(e.message, /ECONNREFUSED/); return true },
  )
  assert.equal(impl.calls.length, 1)
})

test('★★ transport：响应体**必须被排空**（不排空会漏连接）', async () => {
  let resumed = false
  const impl = (options) => {
    const req = new EventEmitter()
    req.write = () => {}
    req.end = () => setImmediate(() => {
      const res = new EventEmitter()
      res.statusCode = 200
      res.resume = () => { resumed = true }
      req.emit('response', res)
      setImmediate(() => res.emit('end'))
    })
    req.destroy = () => {}
    return req
  }
  const transport = createHttpTransport({
    policy: { endpoint: 'https://hb.example.com/beat', timeoutMs: 2000 }, requestImpl: impl,
  })
  await transport({ schema: 'legion/heartbeat@1' })
  assert.equal(resumed, true, '没有 resume 响应体——连接不会释放')
})

test('★★ transport：**畸形端点与载荷**给出各自的码，不是一律 SEND_FAILED', async () => {
  const impl = fakeRequest()
  const bad = createHttpTransport({
    policy: { endpoint: 'http://plain.example.com', timeoutMs: 1000 }, requestImpl: impl,
  })
  await assert.rejects(() => bad({ schema: 'x' }),
    (e) => { assert.equal(e.code, HEARTBEAT_CODES.INVALID_ENDPOINT); return true })

  const good = createHttpTransport({
    policy: { endpoint: 'https://hb.example.com/beat', timeoutMs: 1000 }, requestImpl: impl,
  })
  await assert.rejects(() => good(null),
    (e) => { assert.equal(e.code, HEARTBEAT_CODES.PAYLOAD_REJECTED); return true })
  assert.equal(impl.calls.length, 0, '校验没过却仍然发起了请求')
})

test('★★ 心跳：transport 的具体码**穿过 catch 保留下来**（不被压成 SEND_FAILED）', async () => {
  // 三种原因的处置完全不同：配错了 / 代码错了 / 网络的事。
  // 一个把"你配错了"和"我们发不出去"报成同一句话的上报通道，
  // 会让用户反复检查自己那份没有问题的配置。
  const cases = [
    [HEARTBEAT_CODES.INVALID_ENDPOINT],
    [HEARTBEAT_CODES.PAYLOAD_REJECTED],
    [HEARTBEAT_CODES.SEND_FAILED],
  ]
  const results = []
  for (const [code] of cases) {
    const hb = createHeartbeat({
      policy: { enabled: true, endpoint: 'https://h/x', consent: { who: 'a', at: 't' }, intervalMs: 1000, timeoutMs: 1000 },
      transport: async () => { const e = new Error('x'); e.code = code; throw e },
    })
    const r = await hb.sendNow()
    results.push(r.reason)
  }
  assert.deepEqual(results, [
    HEARTBEAT_CODES.INVALID_ENDPOINT, HEARTBEAT_CODES.PAYLOAD_REJECTED, HEARTBEAT_CODES.SEND_FAILED,
  ], '具体码被压成了同一句话')
})

test('★ 心跳：一个**不认识的**码仍然落到 SEND_FAILED（不许把任意异常码透出去）', async () => {
  const hb = createHeartbeat({
    policy: { enabled: true, endpoint: 'https://h/x', consent: { who: 'a', at: 't' }, intervalMs: 1000, timeoutMs: 1000 },
    transport: async () => { const e = new Error('x'); e.code = 'SOMETHING_ELSE'; throw e },
  })
  const r = await hb.sendNow()
  assert.equal(r.reason, HEARTBEAT_CODES.SEND_FAILED)
})

// ============================================================================
// ③ 同意记录
// ============================================================================

test('★★★ 同意：**从未同意 / 撤回了 / 读不出来**是三个不同的读数', () => {
  const { dir, cleanup } = tmpRoot('consent-three')
  try {
    const layout = { productHome: dir }
    // ① 从未同意
    assert.equal(readConsent(layout).code, CONSENT_CODES.NEVER_CONSENTED)

    // ② 同意之后撤回（**不删记录**）
    assert.equal(writeConsent(layout, { who: '张三', now: () => '2026-09-13T10:00:00Z' }).ok, true)
    assert.equal(readConsent(layout).consented, true)
    const rev = writeConsent(layout, { who: '张三', revoke: true, now: () => '2026-09-13T11:00:00Z' })
    assert.equal(rev.ok, true)
    const r = readConsent(layout)
    assert.equal(r.consented, false)
    assert.equal(r.code, CONSENT_CODES.REVOKED)
    // ★ 撤回**保留**原来的 who/at：删掉前一条的话，事后看到的是
    //   "这个人从来没同意过"——而那是错的。
    assert.equal(r.record.who, '张三')
    assert.equal(r.record.at, '2026-09-13T10:00:00Z')
    assert.equal(r.record.revokedAt, '2026-09-13T11:00:00Z')
    assert.match(r.message, /撤回/)

    // ③ 读不出来（损坏的 JSON）
    writeFileSync(join(dir, CONSENT_FILENAME), '{ 这不是 json')
    assert.equal(readConsent(layout).code, CONSENT_CODES.UNREADABLE,
      '损坏的同意文件被读成了"从未同意"——那会让一个明明同意过的用户永远不吭声')

    // ④ 不合法（缺 who）
    writeFileSync(join(dir, CONSENT_FILENAME), JSON.stringify({ schema: CONSENT_SCHEMA, at: 'x' }))
    assert.equal(readConsent(layout).code, CONSENT_CODES.INVALID)
  } finally { cleanup() }
})

test('★★ 同意记录：缺 `who` 或 `at` 一律不合法（那只是一段文本，不是记录）', () => {
  const base = { schema: CONSENT_SCHEMA, who: 'a', at: 't' }
  assert.equal(validateConsentRecord(base).ok, true)
  for (const bad of [
    null, [], 'x',
    { ...base, schema: '别的' },
    { ...base, who: '' },
    { ...base, who: 42 },
    { ...base, at: '' },
    { ...base, at: undefined },
    { ...base, revoked: true },                                    // 撤回缺 revokedAt
  ]) {
    assert.equal(validateConsentRecord(bad).ok, false, `${JSON.stringify(bad)} 被当成了合法同意`)
  }
})

test('★★ `writeConsent`：没有署名就不写（一条没有署名的同意事后无法查证）', () => {
  const { dir, cleanup } = tmpRoot('consent-nowho')
  try {
    const layout = { productHome: dir }
    for (const who of ['', '   ', null, 42]) {
      const r = writeConsent(layout, { who })
      assert.equal(r.ok, false, `who=${JSON.stringify(who)} 被接受了`)
    }
    assert.equal(readConsent(layout).consented, false)
  } finally { cleanup() }
})

test('★★ 同意：**没有可撤回的东西时撤回失败**，而不是写出一条"撤回"记录', () => {
  const { dir, cleanup } = tmpRoot('consent-revoke-none')
  try {
    const layout = { productHome: dir }
    const r = writeConsent(layout, { who: 'a', revoke: true })
    assert.equal(r.ok, false)
    assert.equal(r.code, CONSENT_CODES.NEVER_CONSENTED)
    // 一次失败的撤回**不该**留下任何记录：留下的话，后来真的同意了，
    // 那条陈旧的撤回还在文件里。
    assert.equal(readConsent(layout).code, CONSENT_CODES.NEVER_CONSENTED)
  } finally { cleanup() }
})

test('★★ 同意：写是**原子**的（不会留下半截 JSON）', () => {
  const { dir, cleanup } = tmpRoot('consent-atomic')
  try {
    const writes = []
    const renames = []
    const fakeFs = {
      existsSync: () => false,
      mkdirSync: () => {},
      writeFileSync: (p, t) => { writes.push(p); assert.match(p, /\.tmp-/); JSON.parse(t) },
      renameSync: (a, b) => { renames.push([a, b]) },
    }
    const r = writeConsent({ productHome: dir }, { who: 'a', fs: fakeFs })
    assert.equal(r.ok, true)
    // ★ 先写临时文件、再 rename。直接 writeFileSync 到目标的话，
    //   写到一半断电会留下半截 JSON，读出来是 UNREADABLE ——
    //   用户**刚刚做过的一次同意**变成了"读不出来"。
    assert.equal(writes.length, 1)
    assert.equal(renames.length, 1)
    assert.equal(renames[0][1], consentPath({ productHome: dir }))
  } finally { cleanup() }
})

test('★ 同意：布局里没有家目录 → 不猜位置', () => {
  assert.equal(consentPath({ productHome: null }), null)
  assert.equal(consentPath({}), null)
  assert.equal(readConsent({ productHome: null }).consented, false)
})

// ============================================================================
// ④ 接线：consent 只能来自**这台机器上的记录**
// ============================================================================

const ENABLED = { enabled: true, endpoint: 'https://hb.example.com/x', intervalMs: 1000, timeoutMs: 1000 }

test('★★★ 接线：**配置文件说开着，但没同意过 → 不装配、不发**', () => {
  const { dir, cleanup } = tmpRoot('wire-noconsent')
  try {
    const r = wireHeartbeat({ layout: { productHome: dir }, policy: ENABLED })
    assert.equal(r.ok, false)
    assert.equal(r.code, HEARTBEAT_WIRING_CODES.NO_CONSENT)
    assert.equal(r.heartbeat, undefined, '没有同意却装配出了心跳实例')
  } finally { cleanup() }
})

test('★★★ 接线：**同意跟着配置文件走**这件事在结构上不可能——配置里没有 consent 键', async () => {
  // 这是本批最要紧的一条纪律，而它**不是**靠一段注释守住的：
  // `config.mjs` 里根本不读 `heartbeat.consent`。
  const { loadProductConfig, launcherInputFromConfig } = await import('./config.mjs')
  // 一份"想偷渡同意"的配置
  const text = JSON.stringify({
    heartbeat: {
      enabled: true,
      endpoint: 'https://hb.example.com/x',
      consent: { who: '配置文件', at: '2026-01-01T00:00:00Z' },
    },
  })
  const { dir, cleanup } = tmpRoot('wire-config-consent')
  try {
    writeFileSync(join(dir, 'product.config.json'), text)
    const cfg = loadProductConfig(
      { productHome: dir, dataDir: join(dir, 'data'), productConfigPath: join(dir, 'product.config.json') },
      { envValues: {} },
    )
    // ★ 断言的是**派生的策略**，不是原始的 `merged`。
    //
    //   `merged` 是合并后的原始配置对象，它当然包含文件里写的每一个键
    //   （连拼错的键也在里面）。拿它来判"有没有偷渡"是**判错了对象**：
    //   真正的契约是"**派生的 `heartbeatPolicy` 里没有 consent**"，
    //   而 CLI 传给 Launcher 的正是它。
    //
    //     > 一个"检查原始配置里有没有那个词"的断言，
    //     > 与一个"检查派生结果里有没有那个值"的断言，看起来都在守同一条纪律——
    //     > 只不过前者无论实现对不对都会红，于是它会被删掉，
    //     > 而真正要守的那条纪律就跟着一起没了。
    const derived = launcherInputFromConfig(cfg.merged)
    const policy = derived.heartbeatPolicy ?? {}
    assert.equal(policy.enabled, true, `配置里的 heartbeat.enabled 没被派生出来（keys=${Object.keys(derived).join(',')}）`)
    assert.equal(policy.endpoint, 'https://hb.example.com/x')
    assert.equal(policy.consent, undefined,
      '配置里的 consent **进到了**派生策略里——一个跟着配置走的同意会被复制到别的机器上，'
      + '而那台机器上没有人同意过')
    assert.ok(!JSON.stringify(policy).includes('配置文件'),
      `派生策略里带上了配置文件里的署名：${JSON.stringify(policy)}`)
  } finally { cleanup() }
})

test('★★★ 接线：撤回之后**不再装配**，且码与"从未同意"分开', () => {
  const { dir, cleanup } = tmpRoot('wire-revoked')
  try {
    const layout = { productHome: dir }
    writeConsent(layout, { who: '张三' })
    assert.equal(wireHeartbeat({ layout, policy: ENABLED }).ok, true, '同意之后应当能装配')

    writeConsent(layout, { who: '张三', revoke: true })
    const r = wireHeartbeat({ layout, policy: ENABLED })
    assert.equal(r.ok, false)
    assert.equal(r.code, HEARTBEAT_WIRING_CODES.CONSENT_REVOKED,
      '撤回被报成了"从未同意"——两种情况的处置不同（一个要问用户，一个要查记录）')
  } finally { cleanup() }
})

test('★★★ 接线：同意记录**损坏**时给出的码与"从未同意"**不同**', () => {
  const { dir, cleanup } = tmpRoot('wire-unreadable')
  try {
    const layout = { productHome: dir }
    writeFileSync(join(dir, CONSENT_FILENAME), '{ 坏了')
    const r = wireHeartbeat({ layout, policy: ENABLED })
    assert.equal(r.ok, false)
    assert.equal(r.code, HEARTBEAT_WIRING_CODES.CONSENT_UNREADABLE)
    assert.match(r.message, /不等于「没同意过」/,
      '没有告诉用户"这可能只是记录坏了"——他会以为自己在另一台机器上同意过')
  } finally { cleanup() }
})

test('★★ 接线：默认（`enabled` 不是 true）→ 不装配，且**不是错误**', () => {
  const r = wireHeartbeat({ policy: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, HEARTBEAT_WIRING_CODES.DISABLED)
  // 默认路径不该有 warn/error 级诊断噪音
  assert.equal(r.diagnostics.filter((d) => d.severity !== 'info').length, 0)
})

test('★★★ 接线：端点不合法 → **启动时**就报，不等 6 小时后第一次发送', () => {
  const { dir, cleanup } = tmpRoot('wire-badendpoint')
  try {
    const layout = { productHome: dir }
    writeConsent(layout, { who: '张三' })
    for (const [endpoint, pattern] of [
      ['http://plain/x', /https/],
      ['not a url', /https/],
      // 空端点走的是"开启了却没有端点"那一支，它不该被要求说 https——
      // 那句话对"你压根没填"是无意义的。
      ['', /没有配置端点/],
    ]) {
      const r = wireHeartbeat({ layout, policy: { ...ENABLED, endpoint } })
      assert.equal(r.ok, false, `端点 ${JSON.stringify(endpoint)} 被接受了`)
      // ★ 断言的是**精确的那一个码**，不是"两个之一"。
      //
      //   第一版写的是 `[BAD_ENDPOINT, BAD_POLICY].includes(r.code)`，
      //   于是把端点检查整个删掉，用例**照样绿**（`validateHeartbeatPolicy`
      //   会给出 `BAD_POLICY`）——断验证 ⑤⑩ 量到了这一点。
      //
      //     > 一个"两码皆可"的断言，与一个"什么都没断言"的断言，
      //     > 在被检查的那道闸被删掉时是同一个读数——
      //     > 只不过前者看起来是写了断言的。
      assert.equal(r.code, HEARTBEAT_WIRING_CODES.BAD_ENDPOINT,
        `端点 ${JSON.stringify(endpoint)} 拿到了 ${r.code}，应当是 BAD_ENDPOINT `
        + '（"你配错了"和"策略不合法"对用户是两件事）')
      assert.match(r.message, pattern, `端点 ${JSON.stringify(endpoint)} 的说明没说到点子上：${r.message}`)
    }
    // 反面：合法的 https 端点必须装配成功
    const good = wireHeartbeat({
      layout, policy: ENABLED, transportFactory: () => async () => ({ ok: true }),
    })
    assert.equal(good.ok, true, good.message)
  } finally { cleanup() }
})

test('★★★ 接线：真的走通了——同意 + 合法端点 → 装配出可用的实例，发送成功', async () => {
  const { dir, cleanup } = tmpRoot('wire-happy')
  try {
    const layout = { productHome: dir }
    writeConsent(layout, { who: '张三' })
    const impl = fakeRequest({ status: 200 })
    const wired = wireHeartbeat({
      layout, policy: ENABLED,
      transportFactory: (p) => createHttpTransport({ policy: p, requestImpl: impl }),
    })
    assert.equal(wired.ok, true, wired.message)
    assert.equal(wired.policy.consent.who, '张三', 'consent 没有从同意记录里填进去')
    // ★ 端到端：装配出来的实例真的能沿着真实那条路把一份心跳发出去
    const r = await wired.heartbeat.sendNow()
    assert.equal(r.sent, true, `没发出去：${r.reason}`)
    assert.equal(impl.calls.length, 1)
    const body = JSON.parse(impl.calls[0].body)
    assert.equal(body.schema, 'legion/heartbeat@1')
    // ★ 载荷里**不含**同意记录本身：consent 是"能不能发"的判据，
    //   不是"发什么"的内容。把它发出去等于把用户名外流。
    assert.equal(body.consent, undefined)
    assert.ok(!JSON.stringify(body).includes('张三'), f => `载荷里带上了用户名：${JSON.stringify(body)}`)
  } finally { cleanup() }
})

test('★★★ 接线：装配**抛错也不外传**（心跳是附加能力，不许让产品起不来）', () => {
  const { dir, cleanup } = tmpRoot('wire-throw')
  try {
    const layout = { productHome: dir }
    writeConsent(layout, { who: '张三' })
    const r = wireHeartbeat({
      layout, policy: ENABLED,
      transportFactory: () => { throw new Error('boom') },
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, HEARTBEAT_WIRING_CODES.FAILED)
    assert.match(r.message, /boom/)
    // 但**不许静默**：要有一条诊断
    assert.ok(r.diagnostics.some((d) => d.code === HEARTBEAT_WIRING_CODES.FAILED))
  } finally { cleanup() }
})

test('★★ 接线：`transportFactory` 返回非函数 → 报错而不是等到发送时才炸', () => {
  const { dir, cleanup } = tmpRoot('wire-notfn')
  try {
    const layout = { productHome: dir }
    writeConsent(layout, { who: '张三' })
    const r = wireHeartbeat({ layout, policy: ENABLED, transportFactory: () => 'nope' })
    assert.equal(r.ok, false)
    assert.equal(r.code, HEARTBEAT_WIRING_CODES.FAILED)
  } finally { cleanup() }
})

// ============================================================================
// ⑤ attachHeartbeat：接上 start/stop 的语义
// ============================================================================

test('★★★ `attachHeartbeat`：产品停止 → 心跳**跟着停**（关掉的产品不该还在发）', async () => {
  const { dir, cleanup } = tmpRoot('attach-stop')
  try {
    const layout = { productHome: dir }
    writeConsent(layout, { who: '张三' })
    const impl = fakeRequest({ status: 200 })
    const h = createLauncherHeartbeat({
      layout, policy: ENABLED,
      transportFactory: (p) => createHttpTransport({ policy: p, requestImpl: impl }),
    })
    assert.equal(h.start().started, true)
    h.stop()
    // 停止之后**任何**后续发送都拒绝，包括手动那一次
    const r = await h.heartbeat.sendNow()
    assert.equal(r.sent, false)
    assert.equal(r.reason, HEARTBEAT_CODES.STOPPED)
    assert.equal(impl.calls.length, 0, '产品停止之后仍然发出了心跳')
    assert.equal(h.status().running, false)
  } finally { cleanup() }
})

test('★★ 装配失败时 `start()` **什么也不做**（不是"启动了但内部跳过"）', () => {
  const h = createLauncherHeartbeat({ policy: {} })   // 默认关
  const r = h.start()
  assert.equal(r.started, false)
  assert.equal(r.code, HEARTBEAT_WIRING_CODES.DISABLED)
  assert.equal(h.status().wired, false)
  // 一个照样跑着的定时器是一颗迟早会响的雷
  assert.equal(h.stop().stopped, false)
})

test('★★ `attachHeartbeat`：`stop()` 与 `start()` 都**不抛**', () => {
  const h = attachHeartbeat({
    ok: true,
    heartbeat: {
      start: () => { throw new Error('boom') },
      stop: () => { throw new Error('boom') },
      status: () => ({}),
      diagnostics: () => [],
    },
    diagnostics: [],
  })
  assert.equal(h.start().started, false)
  assert.equal(h.stop().stopped, false)
})

// ============================================================================
// ⑥ Launcher 与 CLI 的接线（**这是原来缺的那一环**）
// ============================================================================

/**
 * 造一个**能真的启动**的布局。
 *
 * ⚠️ 第一版这两条用例写的是 `installDir: dir` 并且把 `data`/`ws`/`cache`/`log`
 * 都放在 `dir` 下面——于是它们全都在**安装目录之内**，preflight 以
 * `WRITABLE_DIR_INSIDE_INSTALL_DIR` 挡下启动，`start()` 根本没走到心跳那一段。
 *
 * 而用例当时是**绿的**：断言写在 `if (started.ok === true)` 的后面。
 * 断验证 ⑤⑮/⑤⑯/⑤⑰ 把这一幕量了出来——把 Launcher 里那三行分别改坏，
 * **套件全绿**。
 *
 *   > 一个"在代码根本没执行到的地方仍然断言通过"的用例，
 *   > 与一个真的守住了那个行为的用例，在报告上是同一个读数——
 *   > 只不过前者是在**什么都没跑**的时候绿着。
 *
 * 现在：安装目录是独立的子目录，密钥库路径合法，且**断言 start 成功**。
 */
function startableLayout(dir) {
  mkdirSync(join(dir, 'install', 'plugins'), { recursive: true })
  return {
    platform: process.platform, productHome: dir, productHomeSource: 'test',
    installDir: join(dir, 'install'),
    dataDir: join(dir, 'data'), cacheDir: join(dir, 'cache'),
    logDir: join(dir, 'log'), workspaceDir: join(dir, 'ws'),
    productConfigPath: join(dir, 'product.config.json'),
    secretsFile: join(dir, 'secrets', 'credentials.json'),
  }
}

/** 一个假的"装配结果"：不碰网络，只记录被调了几次。 */
function stubHeartbeatHandle() {
  return {
    heartbeat: null, code: null, message: '',
    diagnostics: [], diagnosticsList: () => [],
    start: () => ({ started: true }), stop: () => ({ stopped: true }),
    // ★ 这个替身必须把 `wired` 报出来：它是 `attachHeartbeat.status()` 契约的一部分。
    //   早期版本返回 `{}`，于是 `status().heartbeat.wired` 变成 `undefined`——
    //   用例红在了一个**与被测行为无关**的地方（替身不完整）。
    //   Launcher 那边已经改成自己无条件给出 `wired`/`enabled`，所以
    //   这里报全是为了让替身忠实，不是为了迁就实现。
    status: () => ({ wired: true }),
  }
}

test('★★★ Launcher：`enabled` 时会去装配心跳，且**排在就绪之后**', async () => {
  const { createLauncher } = await import('./launcher/launcher.mjs')
  const { dir, cleanup } = tmpRoot('launcher-hb')
  try {
    const layout = startableLayout(dir)
    writeConsent(layout, { who: '张三' })

    // ① 关着：**不该被装配**
    const offCalls = []
    const off = createLauncher({
      layout, ports: {}, include: [],
      heartbeatPolicy: { ...ENABLED, enabled: false },
      heartbeatFactory: (deps) => { offCalls.push(deps); return stubHeartbeatHandle() },
    })
    assert.equal(off.status().heartbeat.wired, false)
    assert.equal(off.status().heartbeat.enabled, false)
    const startedOff = await off.start()
    assert.equal(startedOff.ok, true,
      `夹具没能启动，这条用例会在什么都没跑的时候绿着：${JSON.stringify((startedOff.diagnostics ?? []).map((d) => d.code))}`)
    assert.equal(offCalls.length, 0,
      '`heartbeat.enabled` 不是 true 却仍然装配了心跳——默认关这件事只在一处判是不够的')
    await off.stop({ reason: '测试收尾' })

    // ② 开着 + 已同意：**装上了，而且真的 start 了**
    const onCalls = []
    const on = createLauncher({
      layout, ports: {}, include: [],
      heartbeatPolicy: ENABLED,
      heartbeatFactory: (deps) => { onCalls.push(deps); return stubHeartbeatHandle() },
    })
    const startedOn = await on.start()
    assert.equal(startedOn.ok, true, '夹具没能启动')
    assert.equal(onCalls.length, 1, '开启了心跳却没有装配')
    // ★ 传下去的必须是**布局**与**策略**：不传布局的话它无从去找同意记录。
    assert.ok(onCalls[0].layout, '没有把布局传给心跳装配')
    assert.equal(onCalls[0].policy.enabled, true)
    assert.equal(on.status().heartbeat.wired, true, 'status() 没有如实报出心跳已接上')
    assert.equal(on.status().heartbeat.enabled, true)
    await on.stop({ reason: '测试收尾' })
  } finally { cleanup() }
})

test('★★★ Launcher：`status().heartbeat` 与 `allDiagnostics()` 都带上心跳的读数', async () => {
  const { createLauncher } = await import('./launcher/launcher.mjs')
  const { dir, cleanup } = tmpRoot('launcher-hb-status')
  try {
    const layout = startableLayout(dir)
    const launcher = createLauncher({
      layout, ports: {}, include: [],
      heartbeatPolicy: ENABLED,       // 开着但**没有同意** → 装配失败，要有诊断
    })
    // 装配是懒的（排在就绪之后），所以先看"配置要求开着"这件事有没有被说出来
    const s = launcher.status().heartbeat
    assert.equal(s.wired, false)
    assert.equal(s.enabled, true, 'status().heartbeat 没有如实说出"配置要求开着"')

    const started = await launcher.start()
    assert.equal(started.ok, true,
      `夹具没能启动：${JSON.stringify((started.diagnostics ?? []).map((d) => d.code))}`)
    // ★ 这一条是"用户开了心跳但它其实没发出去"唯一的出口。
    //   只放在 `status()` 里的话，只有专门去查的人看得到。
    const diags = launcher.allDiagnostics()
    assert.ok(diags.some((d) => String(d.code).startsWith('HEARTBEAT_WIRING_')),
      '配置要求发心跳但装配没成功，这条**没有任何地方说出来**——'
      + `实际诊断：${JSON.stringify(diags.map((d) => d.code))}`)
    assert.equal(launcher.status().heartbeat.wired, false)
    await launcher.stop({ reason: '测试收尾' })
  } finally { cleanup() }
})

test('★★★ Launcher：停止时**连带停掉心跳**（关掉的产品不该还在发）', async () => {
  const { createLauncher } = await import('./launcher/launcher.mjs')
  const { dir, cleanup } = tmpRoot('launcher-hb-stop')
  try {
    const layout = startableLayout(dir)
    writeConsent(layout, { who: '张三' })
    const stops = []
    const launcher = createLauncher({
      layout, ports: {}, include: [],
      heartbeatPolicy: ENABLED,
      heartbeatFactory: () => ({
        heartbeat: null, code: null, message: '',
        diagnostics: [], diagnosticsList: () => [],
        start: () => ({ started: true }),
        stop: () => { stops.push(Date.now()); return { stopped: true } },
        status: () => ({}),
      }),
    })
    const started = await launcher.start()
    assert.equal(started.ok, true, '夹具没能启动')
    assert.equal(stops.length, 0, '装配时就停了心跳')
    await launcher.stop({ reason: '测试收尾' })
    // ★ 产品停止必须连带停掉心跳：
    //   一个"产品已经关掉了、心跳还在发"的实现，
    //   与一个关不掉的心跳，在用户点了关闭之后数据还会不会出去上是同一个东西。
    assert.equal(stops.length, 1, '产品停止了却没有停心跳')
  } finally { cleanup() }
})

test('★★ Launcher：`heartbeatFactory` 抛错**不影响启动**，但要留下诊断', async () => {
  const { createLauncher } = await import('./launcher/launcher.mjs')
  const { dir, cleanup } = tmpRoot('launcher-hb-throw')
  try {
    const layout = startableLayout(dir)
    writeConsent(layout, { who: '张三' })
    const launcher = createLauncher({
      layout, ports: {}, include: [],
      heartbeatPolicy: ENABLED,
      heartbeatFactory: () => { throw new Error('boom') },
    })
    const started = await launcher.start()
    assert.equal(started.ok, true, '心跳装配抛错把产品也带崩了——它是附加能力')
    assert.ok(launcher.allDiagnostics().some((d) => d.code === 'HEARTBEAT_WIRING_FAILED'),
      '装配抛错却没有留下任何诊断')
    await launcher.stop({ reason: '测试收尾' })
  } finally { cleanup() }
})

test('★★ CLI：`--heartbeat-consent=<who>` 真的写下同意记录', async () => {
  const { run } = await import('./launcher/cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-consent')
  try {
    const lines = []
    const env = {
      LEGION_HOME: dir,
      LEGION_INSTALL_DIR: new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      LEGION_DATA_DIR: join(dir, 'data'),
      LEGION_WORKSPACE_DIR: join(dir, 'ws'),
    }
    const code = await run({ argv: ['--heartbeat-consent=张三'], env, write: (m) => lines.push(String(m)), waitForSignal: false })
    assert.equal(code, 0, lines.join('\n'))
    const rec = readConsent({ productHome: dir })
    assert.equal(rec.consented, true, `同意没有被写下来：\n${lines.join('\n')}`)
    assert.equal(rec.record.who, '张三')
    assert.ok(lines.join('\n').includes('张三'), '没有把结果告诉用户')
  } finally { cleanup() }
})

test('★★★ CLI：`--heartbeat-revoke-consent` 需要署名，且撤回之后状态变成"已撤回"', async () => {
  const { run } = await import('./launcher/cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-revoke')
  try {
    const env = {
      LEGION_HOME: dir,
      LEGION_INSTALL_DIR: new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      LEGION_DATA_DIR: join(dir, 'data'),
      LEGION_WORKSPACE_DIR: join(dir, 'ws'),
    }
    const lines = []
    await run({ argv: ['--heartbeat-consent=张三'], env, write: (m) => lines.push(String(m)), waitForSignal: false })

    // ① 撤回**没有署名** → 参数错误（一条没有署名的撤回与一次误删文件无法区分）
    const bare = []
    const code = await run({ argv: ['--heartbeat-revoke-consent'], env, write: (m) => bare.push(String(m)), waitForSignal: false })
    assert.equal(code, 2, bare.join('\n'))
    assert.equal(readConsent({ productHome: dir }).consented, true, '一次被拒绝的撤回却改动了状态')

    // ② 带署名的撤回 → 成功，且状态可读地变成"已撤回"
    const out = []
    const ok = await run({
      argv: ['--heartbeat-revoke-consent', '--heartbeat-consent=张三'], env,
      write: (m) => out.push(String(m)), waitForSignal: false,
    })
    assert.equal(ok, 0, out.join('\n'))
    const after = readConsent({ productHome: dir })
    assert.equal(after.consented, false)
    assert.equal(after.code, CONSENT_CODES.REVOKED)
    assert.match(out.join('\n'), /已撤回/, '撤回之后没有明确说出结果')
  } finally { cleanup() }
})

test('★ CLI 帮助里列出了同意相关参数', async () => {
  const { CLI_FLAGS } = await import('./launcher/cli.mjs')
  const names = CLI_FLAGS.map((f) => f.name)
  assert.ok(names.includes('--heartbeat-consent=<who>'))
  assert.ok(names.includes('--heartbeat-revoke-consent'))
})

test('★ 配置：`heartbeat.*` 四个键能被读出来，provenance 也记了', async () => {
  const { loadProductConfig, launcherInputFromConfig } = await import('./config.mjs')
  const { dir, cleanup } = tmpRoot('cfg-hb')
  try {
    writeFileSync(join(dir, 'product.config.json'), JSON.stringify({
      heartbeat: { enabled: true, endpoint: 'https://hb.example.com/x', intervalMs: 3600000, timeoutMs: 5000 },
    }))
    const cfg = loadProductConfig(
      { productHome: dir, dataDir: join(dir, 'data'), productConfigPath: join(dir, 'product.config.json') },
      { envValues: {} },
    )
    // `loadProductConfig` 返回的是合并后的原始配置；**派生**出来的
    // Launcher 输入在 `launcherInputFromConfig` 里——CLI 用的就是它。
    const derived = launcherInputFromConfig(cfg.merged)
    const hb = derived.heartbeatPolicy ?? null
    assert.ok(hb !== null, `配置里的 heartbeat.* 没有被读出来（derived keys=${Object.keys(derived).join(',')}）`)
    assert.equal(hb.enabled, true)
    assert.equal(hb.endpoint, 'https://hb.example.com/x')
    assert.equal(hb.intervalMs, 3600000)
    assert.equal(hb.timeoutMs, 5000)
    // ★ 配置里**不许**有 consent
    assert.equal(hb.consent, undefined)
    // 「这个值是谁给的」应当随时可回答
    assert.equal(derived.provenance['heartbeat.enabled'], 'product-config')
    assert.equal(derived.provenance['heartbeat.endpoint'], 'product-config')
    assert.equal(derived.provenance['heartbeat.intervalMs'], 'product-config')
  } finally { cleanup() }
})

test('★ 配置：不合法的 `heartbeat.intervalMs` **不进**策略（由策略校验去报，不静默纠正）', async () => {
  const { loadProductConfig, launcherInputFromConfig } = await import('./config.mjs')
  const { dir, cleanup } = tmpRoot('cfg-hb-bad')
  try {
    writeFileSync(join(dir, 'product.config.json'), JSON.stringify({
      heartbeat: { enabled: true, endpoint: 'https://h/x', intervalMs: -5, timeoutMs: 'soon' },
    }))
    const cfg = loadProductConfig(
      { productHome: dir, dataDir: join(dir, 'data'), productConfigPath: join(dir, 'product.config.json') },
      { envValues: {} },
    )
    const hb = launcherInputFromConfig(cfg.merged).heartbeatPolicy ?? {}
    assert.equal('intervalMs' in hb, false, '一个不合法的值被静默收下了')
    assert.equal('timeoutMs' in hb, false)
    // 而它也不该被静默纠正成一个"看起来能用"的值
    assert.equal(hb.intervalMs, undefined)
    // 只写了不合法值的那个键**不进** provenance：进了的话，
    // "这个值是谁给的"会指向一个其实没有生效的来源。
    assert.equal(launcherInputFromConfig(cfg.merged).provenance['heartbeat.intervalMs'], undefined)
  } finally { cleanup() }
})

test('★★ `validateHeartbeatPolicy` 对配置来的端点仍然守 https（两处判据一致）', () => {
  const r = validateHeartbeatPolicy({
    enabled: true, endpoint: 'http://plain/x',
    consent: { who: 'a', at: 't' },
  })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /https/.test(p)))
})

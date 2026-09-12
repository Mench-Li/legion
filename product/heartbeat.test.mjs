// ============================================================================
// PRT-713 的判据。
//
// 这一组盯的**不是**"加密了没有"，而是**关了之后还会不会再发一次**。
//
// 对一个已经点过"关闭"的用户来说，"关掉之后还在发"与"根本没关"没有区别。
//
//   > 一个"关了之后还会再发一次"的心跳，与一个根本没关的心跳，
//   > 在"用户点了关闭之后数据还会不会出去"上是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_PAYLOAD_KEYS,
  CONTROLLED_VALUES,
  DEFAULT_HEARTBEAT_POLICY,
  HEARTBEAT_CODES,
  HEARTBEAT_SCHEMA,
  buildHeartbeatPayload,
  createHeartbeat,
  payloadFromRuntime,
  validateHeartbeatPolicy,
} from './heartbeat.mjs'
import { METRIC_KEYS, readMetrics } from './metrics.mjs'

/** 一份合法的、明确选择加入的策略。 */
function optedIn(over = {}) {
  return {
    enabled: true,
    endpoint: 'https://heartbeat.example.invalid/v1/health',
    consent: { at: 1_700_000_000_000, by: 'user' },
    intervalMs: 1000,
    ...over,
  }
}

async function withMetrics(over = {}) {
  return readMetrics({
    'queue-depth': 3, 'oldest-pending-age-ms': 1000, 'active-leases': 1,
    'dead-letter-count': 0, 'upgrade-result': 'succeeded',
    leasesExpired: 0, leasesTotal: 5, attemptsRetried: 0, attemptsTotal: 5,
    upMs: 1000, observedMs: 1000, modelErrors: 0, modelCalls: 5, ...over,
  })
}

// ── ★ 默认关闭 ──────────────────────────────────────────────────────────────

test('① ★ 默认是**关闭**的，而且默认没有端点', () => {
  assert.equal(DEFAULT_HEARTBEAT_POLICY.enabled, false)
  assert.equal(DEFAULT_HEARTBEAT_POLICY.endpoint, null)
  assert.equal(DEFAULT_HEARTBEAT_POLICY.consent, null)
  assert.equal(Object.isFrozen(DEFAULT_HEARTBEAT_POLICY), true)
})

test('① ★ 默认策略下 `start()` **不排定时器**（不是"启动了但内部跳过"）', () => {
  let timers = 0
  const h = createHeartbeat({
    setTimer: () => { timers += 1; return { unref() {} } },
  })
  const r = h.start()
  assert.equal(r.started, false)
  assert.equal(timers, 0, '一个照样跑着的定时器是一颗迟早会响的雷')
  assert.equal(h.status().running, false)
})

test('① ★ 默认策略下**一次都不发**（即使手动 sendNow）', async () => {
  const sentTo = []
  const h = createHeartbeat({ transport: async (p) => sentTo.push(p) })
  const r = await h.sendNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, HEARTBEAT_CODES.DISABLED)
  assert.equal(sentTo.length, 0)
})

test('① 关闭时 `start()` 与 `sendNow()` 都留下一条**说明为什么**的诊断', async () => {
  const h = createHeartbeat({ transport: async () => {} })
  h.start()
  await h.sendNow()
  const codes = h.diagnostics().map((d) => d.code)
  assert.ok(codes.includes(HEARTBEAT_CODES.DISABLED), codes.join(','))
})

// ── ★ 显式选择加入 ──────────────────────────────────────────────────────────

test('② ★ 开启但**没有同意记录**时不发（"用户同意了"不能只是一句注释）', async () => {
  const sentTo = []
  const h = createHeartbeat({
    policy: { enabled: true, endpoint: 'https://x.example.invalid/h', consent: null },
    transport: async (p) => sentTo.push(p),
  })
  const r = await h.sendNow()
  assert.equal(r.sent, false)
  assert.equal(sentTo.length, 0)
  // 断言**具体的理由码**，不只断言"没发"。
  //
  // 这一条很关键：策略校验（`validateHeartbeatPolicy`）也会因为缺同意记录而
  // 判定不合法，所以"没发"这件事有两个地方守着。只断言"没发"的话，
  // 把 `shouldSend` 里那道检查删掉用例照样绿——而那道检查是**唯一**
  // 紧贴在 `transport` 之前的闸。
  //
  //   > 一道"删掉也不会让任何用例变红"的闸，与一道不存在的闸，
  //   > 在"它到底拦不拦得住"上是同一个东西。
  assert.equal(r.reason, HEARTBEAT_CODES.NOT_OPTED_IN,
    '没发，但不是因为"没有同意记录"——说明紧贴 transport 的那道闸没了')
  assert.ok(h.diagnostics().some((d) => d.code === HEARTBEAT_CODES.NOT_OPTED_IN))
  const problems = validateHeartbeatPolicy({ enabled: true, endpoint: 'https://x.example.invalid/h' })
  assert.equal(problems.ok, false)
  assert.ok(problems.problems.some((p) => p.includes('同意记录')), JSON.stringify(problems.problems))
})

test('② 开启却没有端点时不发，且策略校验会报出来', () => {
  const sentTo = []
  const h = createHeartbeat({
    policy: { enabled: true, endpoint: null, consent: { at: 1 } },
    transport: async (p) => sentTo.push(p),
  })
  return h.sendNow().then((r) => {
    assert.equal(r.sent, false)
    assert.equal(sentTo.length, 0)
    const c = validateHeartbeatPolicy({ enabled: true, endpoint: null, consent: { at: 1 } })
    assert.equal(c.ok, false)
  })
})

test('② ★ 端点**必须 https**（心跳链路上有运行状态，明文出去等于没有保护）', () => {
  const c = validateHeartbeatPolicy({ enabled: true, endpoint: 'http://x.example.invalid/h', consent: { at: 1 } })
  assert.equal(c.ok, false)
  assert.ok(c.problems.some((p) => p.includes('https')), JSON.stringify(c.problems))
  // 合法的 https 通过
  assert.equal(validateHeartbeatPolicy(optedIn()).ok, true)
})

test('② 端点不是合法 URL 时会被指出来（不是静默失败）', () => {
  const c = validateHeartbeatPolicy({ enabled: true, endpoint: 'not a url', consent: { at: 1 } })
  assert.equal(c.ok, false)
  assert.ok(c.problems.some((p) => p.includes('URL')), JSON.stringify(c.problems))
})

test('② 关闭状态下策略是合法的（默认配置不该报错）', () => {
  const c = validateHeartbeatPolicy({})
  assert.equal(c.ok, true)
  assert.deepEqual(c.problems, [])
})

test('② `intervalMs` / `timeoutMs` 必须是正整数', () => {
  for (const bad of [0, -1, 1.5, 'x', null]) {
    const c = validateHeartbeatPolicy({ intervalMs: bad, timeoutMs: bad })
    assert.equal(c.ok, false, `${JSON.stringify(bad)} 被当成了合法间隔`)
  }
})

// ── ★ 随时可以关闭 ──────────────────────────────────────────────────────────

test('③ ★ `stop()` 让代际 +1（这是唯一能拦住"已经在路上的那一次"的东西）', () => {
  const h = createHeartbeat({ policy: optedIn() })
  const before = h.status().generation
  h.stop()
  assert.equal(h.status().generation, before + 1)
})

test('③ ★ 关闭之后**不再发**，且 `status().running` 为假', async () => {
  const sentTo = []
  const h = createHeartbeat({ policy: optedIn(), transport: async (p) => sentTo.push(p) })
  h.start()
  assert.equal(h.status().running, true)
  h.stop()
  assert.equal(h.status().running, false)
  const r = await h.sendNow()
  assert.equal(r.sent, false)
  assert.equal(sentTo.length, 0)
})

test('③ ★★ 在途的那一次也会被丢弃（在 transport 真正被调用前再核对一次代际）', async () => {
  // 这是本模块最关键的一条用例。
  //
  // 构造一个"发送已经开始、但还没落到 transport"的时刻：载荷的构造
  // 要遍历指标，而用户的"关闭"完全可能正好落在这个窗口里。
  // 只查一次的实现漏掉的恰好是"已经走到这一步的那一次"——
  // 也就是用户唯一会注意到的那一次。
  const sentTo = []
  let hb = null

  // `payloadFromRuntime` 会读 `metricsReport.metrics[key]`。
  // 把 `metrics` 做成带 getter 的对象：第一次被读到时触发 `stop()`，
  // 而那正好发生在"载荷已经在造、transport 还没被调"的窗口里。
  const inner = await withMetrics()
  let triggered = false
  const metricsWithHook = {
    ...inner,
    metrics: new Proxy(inner.metrics, {
      get(target, prop) {
        if (!triggered && typeof prop === 'string') {
          triggered = true
          hb.stop()
        }
        return target[prop]
      },
    }),
  }

  hb = createHeartbeat({
    policy: optedIn(),
    metricsReport: metricsWithHook,
    runtimeState: 'ready',
    transport: async (p) => { sentTo.push(p) },
  })

  const r = await hb.sendNow()
  assert.equal(triggered, true, '钩子没被触发，这条用例没有真的测到那个窗口')
  assert.equal(r.sent, false, '关闭发生在载荷构造期间，这次发送必须被丢弃')
  // 两道闸都在这里响：`stopped` 与代际对不上。
  // 断言的是**它没被发出去**，而不是它具体走了哪一道闸——
  // 那两道闸的关系是实现细节，改起来不该让这条用例失真。
  assert.ok(
    r.reason === HEARTBEAT_CODES.DROPPED_GENERATION || r.reason === HEARTBEAT_CODES.STOPPED,
    `这次发送是被拒了，但理由不是"关闭"：${r.reason}`,
  )
  assert.equal(sentTo.length, 0, '在途的那一次仍然发出去了')
})

test('③ ★ 丢弃会记账（`status().dropped` 里能看到为什么没发）', async () => {
  const h = createHeartbeat({ policy: optedIn(), transport: async () => {} })
  h.stop()
  await h.sendNow()
  const st = h.status()
  assert.ok(st.dropped.length >= 1)
  assert.ok(st.dropped.includes(HEARTBEAT_CODES.STOPPED), JSON.stringify(st.dropped))
})

test('③ `stop()` 是幂等的（重复关闭不报错，代际继续 +1）', () => {
  const h = createHeartbeat({ policy: optedIn() })
  assert.doesNotThrow(() => { h.stop(); h.stop(); h.stop() })
  assert.equal(h.status().generation, 3)
})

test('③ ★ 定时器必须 `unref`（否则用户关了产品进程还退不出去）', () => {
  let unrefCalled = false
  createHeartbeat({
    policy: optedIn(),
    setTimer: () => ({ unref() { unrefCalled = true } }),
    transport: async () => {},
  }).start()
  assert.equal(unrefCalled, true,
    '一个让进程无法退出的心跳，会让"关闭了产品但进程还在"变成只有任务管理器能解决的事')
})

test('③ 定时器到点会真的发（正向对照，证明上面的"不发"不是恒不发）', async () => {
  const sentTo = []
  let fire = null
  const h = createHeartbeat({
    policy: optedIn(),
    setTimer: (fn) => { fire = fn; return { unref() {} } },
    transport: async (p) => sentTo.push(p),
  })
  h.start()
  assert.ok(fire, '定时器没被排上')
  await fire()
  assert.equal(sentTo.length, 1)
})

// ── ★ 载荷：允许名单，不是拒绝名单 ──────────────────────────────────────────

test('④ ★ 不在允许名单上的键一律不外流（允许名单，不是拒绝名单）', () => {
  const p = buildHeartbeatPayload({
    'queue-depth': 3,
    apiKey: 'sk-live-abcdef',
    token: 'ghp_xxx',
    taskTitle: '给客户 A 部署',
    workspace: 'C:/Users/bob/projects/secret',
    nested: { anything: 1 },
  })
  assert.deepEqual(Object.keys(p.payload), ['queue-depth'])
  assert.deepEqual([...p.dropped].sort(), ['apiKey', 'nested', 'taskTitle', 'token', 'workspace'])
})

test('④ ★ 一个**新加的**未知字段默认不外流（这就是允许名单的意义）', () => {
  // 拒绝名单的实现会在有人往上游加字段时静默外流它。
  const p = buildHeartbeatPayload({ 'queue-depth': 1, brandNewFieldNobodyReviewed: 'oops' })
  assert.equal('brandNewFieldNobodyReviewed' in p.payload, false)
  assert.ok(p.dropped.includes('brandNewFieldNobodyReviewed'))
})

test('④ ★ 带空白或路径分隔符的字符串被挡下（自由文本是泄漏最容易钻进来的地方）', () => {
  for (const bad of ['C:/Users/bob/x', 'C:\\Users\\bob', 'has space', 'line\nbreak', '/etc/passwd']) {
    const p = buildHeartbeatPayload({ productVersion: bad })
    assert.equal('productVersion' in p.payload, false, `${JSON.stringify(bad)} 被发出去了`)
    assert.ok(p.dropped.includes('productVersion'))
  }
})

test('④ `NaN` / `Infinity` / 对象 / 数组 都不外流', () => {
  for (const bad of [NaN, Infinity, {}, [], () => {}, Symbol('x'), undefined, null]) {
    const p = buildHeartbeatPayload({ 'queue-depth': bad })
    assert.equal('queue-depth' in p.payload, false, `${String(bad)} 被发出去了`)
  }
})

test('④ ★ 受控值**精确匹配**（不是一个"看起来像就可以"的检查）', () => {
  assert.equal(buildHeartbeatPayload({ schema: HEARTBEAT_SCHEMA }).payload.schema, HEARTBEAT_SCHEMA)
  assert.equal('schema' in buildHeartbeatPayload({ schema: 'legion/heartbeat@2' }).payload, false)
  assert.equal('platform' in buildHeartbeatPayload({ platform: 'windows' }).payload, false)
  assert.equal(buildHeartbeatPayload({ platform: 'win32' }).payload.platform, 'win32')
  assert.equal(Object.isFrozen(CONTROLLED_VALUES), true)
})

test('④ 允许名单里的每个键都是**受控的**（要么是指标键，要么在 CONTROLLED_VALUES 或短字符串检查下）', () => {
  // 这条守的是"允许名单本身别被人加宽到能装自由文本"。
  const free = ALLOWED_PAYLOAD_KEYS.filter(
    (k) => !METRIC_KEYS.includes(k) && !(k in CONTROLLED_VALUES)
      && !['observedMetrics', 'totalMetrics'].includes(k),
  )
  assert.deepEqual([...free].sort(), ['productVersion', 'runtimeState'],
    `允许名单里出现了预期外的自由字符串键：${free.join(',')}。` +
    '加键之前先想清楚它会不会带出路径或任务名')
})

test('④ `payloadFromRuntime` 只能产出状态 + 指标 + 版本（调用方塞不进别的东西）', () => {
  const r = buildHeartbeatPayload({ 'queue-depth': 1 })
  const p = payloadFromRuntime({ runtimeState: 'ready', productVersion: '0.4.2' })
  assert.equal(p.payload.runtimeState, 'ready')
  assert.equal(p.payload.productVersion, '0.4.2')
  assert.equal(p.payload.schema, HEARTBEAT_SCHEMA)
  assert.equal(Object.isFrozen(p.payload), true)
})

test('④ ★ 生成的载荷里**没有**任何自由文本形状的值（最终防线）', async () => {
  const metrics = await withMetrics()
  const { payload } = payloadFromRuntime({
    runtimeState: 'degraded', metricsReport: metrics, productVersion: '0.4.2',
  })
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v !== 'string') continue
    assert.ok(!/[\s/\\]/.test(v) || k === 'schema', `${k} 的值像自由文本：${v}`)
  }
  // 指标值必须是数——除了 `upgrade-result`，它是一个受控类别值（字符串）。
  for (const k of METRIC_KEYS) {
    if (!(k in payload)) continue
    if (k === 'upgrade-result') {
      assert.equal(typeof payload[k], 'string', `${k} 应当是一个类别值`)
      continue
    }
    assert.equal(typeof payload[k], 'number', `${k} 不是数`)
  }
})

test('④ ★ 未知指标**不进**载荷（填 0 会让远端当成真实读数）', async () => {
  const metrics = await withMetrics({ 'dead-letter-count': null })
  const { payload } = payloadFromRuntime({ metricsReport: metrics })
  assert.equal('dead-letter-count' in payload, false)
  assert.equal(payload.observedMetrics, 8)
  assert.equal(payload.totalMetrics, 9)
})

// ── 发送的容错与记账 ────────────────────────────────────────────────────────

test('⑤ transport 抛错时**不重试**（只记账，等下一个周期）', async () => {
  let calls = 0
  const h = createHeartbeat({
    policy: optedIn(),
    transport: async () => { calls += 1; throw new Error('网络断了') },
  })
  const r = await h.sendNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, HEARTBEAT_CODES.SEND_FAILED)
  assert.equal(calls, 1, '出错的路径上偷偷重试，会让"关闭"变得不可预期')
  assert.ok(h.diagnostics().some((d) => d.code === HEARTBEAT_CODES.SEND_FAILED))
})

test('⑤ ★ 成功发送之后 `status()` 能看出**发了哪些键**（"到底发了什么"要可查）', async () => {
  const metrics = await withMetrics()
  const h = createHeartbeat({
    policy: optedIn(), metricsReport: metrics, runtimeState: 'ready', productVersion: '0.4.2',
    transport: async () => ({ ok: true }),
  })
  const r = await h.sendNow()
  assert.equal(r.sent, true)
  const st = h.status()
  assert.equal(st.sendCount, 1)
  assert.ok(st.lastSentKeys.includes('queue-depth'))
  assert.ok(st.lastSentKeys.includes('schema'))
  // 一个不该有的键绝不能出现在记录里
  for (const k of st.lastSentKeys) assert.ok(ALLOWED_PAYLOAD_KEYS.includes(k) || k === 'observedAt', k)
})

test('⑤ 没有配置 transport 时不发，且报出来（不是静默成功）', async () => {
  const h = createHeartbeat({ policy: optedIn() })
  const r = await h.sendNow()
  assert.equal(r.sent, false)
  assert.equal(r.reason, HEARTBEAT_CODES.SEND_FAILED)
  // 但**理由要能区分**："你没有配发送通道"是一个用户要自己去修的问题，
  // "这次发送失败"是一件会自己过去的事。两者的处置完全不同。
  //
  // 不显式检查的话这条路会落到 `transport is not a function` 的 catch 里，
  // 于是"配置错了"被说成"网络抖了一下"。
  const d = h.diagnostics().find((x) => x.code === HEARTBEAT_CODES.SEND_FAILED)
  assert.ok(d, '没有留下诊断')
  assert.ok(d.message.includes('发送通道'),
    `"没配通道"被说成了别的原因：${d.message}`)
})

test('⑤ 策略不合法时**不发**，并留下 error 级诊断', async () => {
  const sentTo = []
  // http 端点：不合法
  const h = createHeartbeat({
    policy: { enabled: true, endpoint: 'http://x.example.invalid/h', consent: { at: 1 } },
    transport: async (p) => sentTo.push(p),
  })
  const r = await h.sendNow()
  assert.equal(r.sent, false)
  assert.equal(sentTo.length, 0)
  assert.ok(h.diagnostics().some((d) => d.code === HEARTBEAT_CODES.BAD_POLICY && d.severity === 'error'))
})

test('⑤ 策略不合法时 `start()` 也不排定时器', () => {
  let timers = 0
  const h = createHeartbeat({
    policy: { enabled: true, endpoint: 'http://x.example.invalid/h', consent: { at: 1 } },
    setTimer: () => { timers += 1; return { unref() {} } },
  })
  assert.equal(h.start().started, false)
  assert.equal(timers, 0)
})

// ── 不可变性 ────────────────────────────────────────────────────────────────

test('⑥ 心跳对象与 `status()` / `diagnostics()` 都是冻结的', () => {
  const h = createHeartbeat({ policy: optedIn() })
  assert.equal(Object.isFrozen(h), true)
  assert.equal(Object.isFrozen(h.status()), true)
  assert.equal(Object.isFrozen(h.diagnostics()), true)
  assert.equal(Object.isFrozen(h.policy()), true)
})

test('⑥ `policy()` 返回的是**校验后**的策略（默认值已补上）', () => {
  const h = createHeartbeat({ policy: { enabled: true, endpoint: 'https://x.example.invalid/h', consent: { at: 1 } } })
  const p = h.policy()
  assert.equal(p.intervalMs, DEFAULT_HEARTBEAT_POLICY.intervalMs)
  assert.equal(p.timeoutMs, DEFAULT_HEARTBEAT_POLICY.timeoutMs)
})

test('⑥ 协议版本号是稳定的（服务端据此解读）', () => {
  assert.equal(HEARTBEAT_SCHEMA, 'legion/heartbeat@1')
  assert.deepEqual([...CONTROLLED_VALUES.schema], [HEARTBEAT_SCHEMA])
})

test('⑥ `start()` 重复调用不会排两个定时器（否则关闭也只关得掉一个）', () => {
  let timers = 0
  const h = createHeartbeat({
    policy: optedIn(),
    setTimer: () => { timers += 1; return { unref() {} } },
    transport: async () => {},
  })
  h.start(); h.start(); h.start()
  assert.equal(timers, 1)
})

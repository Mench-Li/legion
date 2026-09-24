import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  CONNECTOR_DECISION_PORT_CODES,
  CONNECTOR_DECISION_PORT_VERSION,
  DECISION_KINDS,
  DECISION_RANK,
  createConnectorDecisionPort,
  mergeDecisions,
  normalizeBridgeDecision,
  normalizeRegistryDecision,
} from './decision-port.mjs'
import { CONNECTOR_CODES, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS, createRegistry } from './registry.mjs'

// ── 一条最小的连接器声明（只含判定面会读的字段）
//
//   ★ 注意写的是 `declaredRisk`（**输入**名），不是 `risk`。
//     我第一版这里随手写了 `risk: 'low'` —— 也就是**输出**字段那个名字 ——
//     而它在修掉之前会被静默忽略。这正是本批在 `registry.mjs` 里加那道
//     封闭键集守卫的原因：**连同我自己在内，第一反应都是写输出那个名字。**
function declOf(over = {}) {
  return {
    connectorId: 'github',
    transport: 'stdio',
    command: 'npx mcp-github',
    policy: 'allow',
    tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'allow' }],
    secretRefs: [],
    ...over,
  }
}

/** 造一个 registry + 端口，`inner` 可注入。 */
function setup({ decls = [declOf()], inner = null, resolve = () => 'github', onDecision = null, now = null } = {}) {
  const opts = { connectors: decls }
  if (now !== null) opts.now = now
  const registry = createRegistry(opts)
  const port = createConnectorDecisionPort({ registry, resolveConnectorId: resolve, inner, onDecision })
  return { registry, port }
}

const PROJ = Object.freeze({ toolName: 'list_issues', callId: 'c1' })

// ===========================================================================
// ① ★★★ 连接器层的 `allow` **不许**短路政策门
// ===========================================================================

test('① ★★★ 连接器层 allow 而政策门 deny ⇒ 结果必须是 **deny**（不许短路政策门）', async () => {
  const { port } = setup({ inner: () => ({ kind: 'deny', reason: '政策门拒绝' }) })
  const r = await port(PROJ)
  assert.equal(r.kind, 'deny', `连接器 allow 把政策门的 deny 盖掉了：${JSON.stringify(r)}`)
  assert.match(r.reason, /政策门/, '理由必须说出是政策门更严')

  // ★ 反向对照：**同一条链**，政策门 allow ⇒ 才是 allow。
  //   少了这一条，"永远返回 deny"的实现也能通过上面那个断言。
  const { port: p2 } = setup({ inner: () => ({ kind: 'allow' }) })
  assert.equal((await p2(PROJ)).kind, 'allow')
})

test('①a ★★ 连接器层 allow 而政策门 ask ⇒ 结果是 **ask**（两边都要算）', async () => {
  const { port } = setup({ inner: () => ({ kind: 'ask', reason: '要人批' }) })
  const r = await port(PROJ)
  assert.equal(r.kind, 'ask')
  assert.equal(port.receipts().outerAllow, 1, '连接器层那一侧没有真的跑')
  assert.equal(port.receipts().innerAsk, 1, '政策门那一侧没有真的跑')
  assert.equal(port.receipts().innerDecided, 1, '更严的是政策门 ⇒ 应记在 innerDecided')
})

// ===========================================================================
// ② ★★★ 连接器层的 `ask` **不许**把政策门的 deny 降级
// ===========================================================================

test('② ★★★ 连接器层 ask + 政策门 deny ⇒ **deny**（不许把拒绝降级成"可以批准"）', async () => {
  // 让连接器层真的返回 ask：把工具策略设成 ask。
  const { port } = setup({
    decls: [declOf({ tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'ask' }] })],
    inner: () => ({ kind: 'deny', reason: '政策门说不行' }),
  })
  const r = await port(PROJ)
  assert.equal(port.receipts().outerAsk, 1, '前提没成立：连接器层应当是 ask')
  assert.equal(
    r.kind, 'deny',
    `政策门的 deny 被降级成了 ${r.kind} —— 一次拒绝变成了一次"可以被人批准"`,
  )
  assert.match(r.reason, /政策门/, '取严却报了宽松那一侧的理由')

  // ★ 反向对照：连接器层 ask + 政策门 allow ⇒ ask（连接器层更严）。
  const { port: p2 } = setup({
    decls: [declOf({ tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'ask' }] })],
    inner: () => ({ kind: 'allow' }),
  })
  assert.equal((await p2(PROJ)).kind, 'ask')
  assert.equal(p2.receipts().connectorDecided, 1, '更严的是连接器层 ⇒ 应记在 connectorDecided')
})

test('②a ★★ 高风险工具 ⇒ 连接器层 ask，而政策门 allow 时结果是 ask', async () => {
  // ★ 注意：`capabilities` **不许为空数组** —— `declareConnector` 会把
  //   "没有能力"与"能力未知"当成同一张登记表上的东西，硬拒（它与第 14 条
  //   "whitelist 有位无值"是同一条纪律）。所以这里给一个真的能力。
  const { port } = setup({
    decls: [declOf({ tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'critical', policy: 'allow' }] })],
    inner: () => ({ kind: 'allow' }),
  })
  const r = await port(PROJ)
  assert.equal(r.kind, 'ask', '风险 ≥ high 必须问人')
  assert.match(r.reason, /风险|ask|连接器/, `理由说不清是谁要问：${r.reason}`)
})

// ===========================================================================
// ③ ★★ 认不出 ⇒ **原样交给 inner**，不是放行
// ===========================================================================

test('③ ★★★ 认不出连接器 ⇒ 政策门的**原话**透传（不是 allow）', async () => {
  const { port } = setup({ resolve: () => null, inner: () => ({ kind: 'deny', reason: '政策门拒绝' }) })
  const r = await port(PROJ)
  assert.equal(r.kind, 'deny', '认不出被当成了放行 —— 那不是"管不着"，那是短路')
  assert.match(r.reason, /政策门/)

  // ★ 反向对照：认不出 + 政策门 allow ⇒ allow（证明上面不是"永远 deny"）。
  const { port: p2 } = setup({ resolve: () => null, inner: () => ({ kind: 'allow' }) })
  assert.equal((await p2(PROJ)).kind, 'allow')
  assert.equal(p2.receipts().unattributed, 1)
  assert.equal(p2.receipts().attributed, 0, '没认出连接器却记了 attributed')

  // ★ resolver 抛 ⇒ 与认不出同一条路（不是 deny，也不是 allow）。
  const { port: p3 } = setup({
    resolve: () => { throw new Error('resolver 坏了') },
    inner: () => ({ kind: 'allow' }),
  })
  assert.equal((await p3(PROJ)).kind, 'allow', 'resolver 抛错不该自己变成一个决定')
  assert.equal(p3.receipts().resolveFailed, 1)
  assert.equal(p3.receipts().unattributed, 1)
})

test('③a ★ 认不出时不认识的那个 id 不会被瞎猜（空串/空白/非字符串都算认不出）', async () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    const { port } = setup({ resolve: () => bad, inner: () => ({ kind: 'allow' }) })
    const r = await port(PROJ)
    assert.equal(r.kind, 'allow')
    assert.equal(port.receipts().unattributed, 1, `${JSON.stringify(bad)} 被当成了认出`)
  }
})

// ===========================================================================
// ④ ★★ 读不懂的 kind ⇒ deny，且原值写进理由
// ===========================================================================

test('④ ★★★ inner 返回三个词以外的东西 ⇒ **deny**，且原值出现在理由里', async () => {
  // ★ 每条垃圾值**算出它自己的** `raw` 表示，而不是在用例里再抄一份字符串表。
  //   抄一份的写法会随实现漂移（我第一版就是抄的，于是 `{kind: 1}` 那条
  //   因为断言表里没有 "1" 而红——不是实现错了，是**判据本身**少了一格）。
  const cases = [
    [undefined, 'undefined'],
    [null, 'null'],
    [{}, '(缺少 kind 字段)'],
    [{ kind: 'maybe' }, '"maybe"'],
    [{ kind: 1 }, '1'],
    ['allow', 'string'],
    [0, 'number'],
  ]
  for (const [junk, expectedRaw] of cases) {
    const { port } = setup({ inner: () => junk })
    const r = await port(PROJ)
    assert.equal(r.kind, 'deny', `读不懂的 inner（${JSON.stringify(junk)}）没有被兜住`)
    assert.equal(port.receipts().innerMalformed, 1)
    assert.ok(
      r.reason.includes(expectedRaw),
      `理由里没有原值 ${expectedRaw}，排障时看不出是谁坏了：${r.reason}`,
    )
  }
})

test('④a ★ inner 抛错 ⇒ deny 兜住，理由带上异常消息', async () => {
  const { port } = setup({ inner: () => { throw new Error('政策门炸了') } })
  const r = await port(PROJ)
  assert.equal(r.kind, 'deny')
  assert.equal(port.receipts().innerFailed, 1)
  assert.match(r.reason, /政策门炸了/)
  assert.equal(port.receipts().innerMalformed, 0, '抛错与"返回垃圾"是两件事，读数必须分得开')
})

test('④b ★ registry.decide 抛错 ⇒ deny 兜住（不是放行）', async () => {
  const broken = { decide() { throw Object.assign(new Error('registry 炸了'), { code: 'X' }) } }
  const port = createConnectorDecisionPort({ registry: broken, resolveConnectorId: () => 'github' })
  const r = await port(PROJ)
  assert.equal(r.kind, 'deny', 'registry 抛错被当成了放行')
  assert.equal(port.receipts().registryFailed, 1)
  assert.match(r.reason, /registry 炸了/)
})

// ===========================================================================
// ⑤ ★★★ **永不抛** —— 桥不兜异常（`tool-request.mjs:802` 没有 try/catch）
// ===========================================================================

test('⑤ ★★★ 任何一路坏掉都不许抛出去（桥那一层没有 try/catch）', async () => {
  const cases = [
    { resolve: () => { throw new Error('r') }, inner: () => { throw new Error('i') } },
    { resolve: () => 'github', inner: () => { throw new Error('i') } },
    { resolve: () => 'github', inner: () => { throw new Error('i') } },
    { resolve: () => null, inner: () => { throw new Error('i') } },
  ]
  for (const c of cases) {
    const { port } = setup(c)
    const r = await port(PROJ) // 抛出去这条用例就红
    assert.equal(typeof r.kind, 'string')
  }
  // inner 返回一个 thenable（await 它时抛）
  const { port } = setup({ inner: () => ({ then() { throw new Error('坏 thenable') } }) })
  const r = await port(PROJ)
  assert.equal(r.kind, 'deny')
})

test('⑤a ★ 观测点（onDecision）抛错不许影响判定', async () => {
  const { port } = setup({ onDecision: () => { throw new Error('观测点坏了') } })
  const r = await port(PROJ)
  assert.equal(r.kind, 'allow')
})

// ===========================================================================
// ⑥ ★★ 不许返回 `arguments`（`tool-request.mjs:810-817` 会因此拒绝每一次调用）
// ===========================================================================

test('⑥ ★★★ 返回里**不许**带 `arguments`（带了 ⇒ 桥会把每一次调用都拒掉）', async () => {
  const withArgs = () => ({ kind: 'allow', arguments: { evil: true }, extra: 'x' })
  const { port } = setup({ inner: withArgs })
  const r = await port(PROJ)
  assert.equal('arguments' in r, false, 'arguments 漏出去了 —— 桥会报"试图改写参数"并拒绝')
  assert.equal(r.kind, 'allow')
  assert.deepEqual(Object.keys(r).sort(), ['kind', 'reason'], `返回的键集是契约：${JSON.stringify(Object.keys(r))}`)

  // 连接器层那一侧也要丢：registry 的决定里有 connectorId / risk / code 等字段。
  const { port: p2 } = setup({ inner: () => ({ kind: 'allow' }) })
  const r2 = await p2(PROJ)
  assert.deepEqual(Object.keys(r2).sort(), ['kind', 'reason'])
})

// ===========================================================================
// ⑦ ★★ 构造期 fail-closed
// ===========================================================================

test('⑦ ★★ 构造期缺 registry / resolver 一律**响亮地拒**，且码具名', () => {
  const thrown = (fn) => { try { fn(); return null } catch (e) { return e } }

  const a = thrown(() => createConnectorDecisionPort({ resolveConnectorId: () => 'x' }))
  assert.equal(a?.code, CONNECTOR_DECISION_PORT_CODES.NO_REGISTRY)

  const b = thrown(() => createConnectorDecisionPort({ registry: createRegistry({ connectors: [] }) }))
  assert.equal(b?.code, CONNECTOR_DECISION_PORT_CODES.NO_RESOLVE)

  const c = thrown(() => createConnectorDecisionPort({
    registry: createRegistry({ connectors: [] }), resolveConnectorId: () => 'x', inner: 'nope',
  }))
  assert.equal(c?.code, CONNECTOR_DECISION_PORT_CODES.BAD_INNER)

  // ★ 反向对照：`inner` 缺省（undefined ⇒ null）是**合法**的。
  const ok = createConnectorDecisionPort({
    registry: createRegistry({ connectors: [] }), resolveConnectorId: () => 'x',
  })
  assert.equal(typeof ok, 'function')

  // ★ 而"registry 存在但没有 decide"也要被拒——不是"没连接器"。
  const d = thrown(() => createConnectorDecisionPort({ registry: {}, resolveConnectorId: () => 'x' }))
  assert.equal(d?.code, CONNECTOR_DECISION_PORT_CODES.NO_REGISTRY)
})

// ===========================================================================
// ⑧ ★ 未注册的连接器 / 未声明的工具 ⇒ 连接器层 deny（注册表自己的纪律）
// ===========================================================================

test('⑧ ★ 未注册的 id / 未声明的工具 ⇒ deny，且理由来自连接器层', async () => {
  const { port } = setup({ resolve: () => 'nope', inner: () => ({ kind: 'allow' }) })
  const r = await port(PROJ)
  assert.equal(r.kind, 'deny')
  assert.match(r.reason, /连接器/)
  assert.equal(port.receipts().connectorDecided, 1, '连接器层更严 ⇒ 应记在 connectorDecided')

  const { port: p2 } = setup({ resolve: () => 'github', inner: () => ({ kind: 'allow' }) })
  const r2 = await p2(Object.freeze({ toolName: 'delete_repo', callId: 'c2' }))
  assert.equal(r2.kind, 'deny', '"没见过就放行"等于加一个后门')
})

// ===========================================================================
// ⑨ ★★ 纯函数：mergeDecisions 是格（取严），且顺序无关
// ===========================================================================

test('⑨ ★★ mergeDecisions 是"取严"的格：交换律 + 幂等 + 吸收', () => {
  const ks = [DECISION_KINDS.ALLOW, DECISION_KINDS.ASK, DECISION_KINDS.DENY]
  for (const a of ks) {
    assert.equal(mergeDecisions(a, a), a, `幂等坏了：${a}`)
    for (const b of ks) {
      assert.equal(mergeDecisions(a, b), mergeDecisions(b, a), `交换律坏了：${a}/${b}`)
      const m = mergeDecisions(a, b)
      assert.ok(
        DECISION_RANK[m] >= DECISION_RANK[a] && DECISION_RANK[m] >= DECISION_RANK[b],
        `合并结果 ${m} 比某一侧更松（${a}/${b}）⇒ 这就是那个"取松"的错法`,
      )
    }
  }
  // ★ 三条决定性断言（写死，防止 DECISION_RANK 被人改松）
  assert.equal(mergeDecisions('allow', 'deny'), 'deny')
  assert.equal(mergeDecisions('ask', 'deny'), 'deny', 'deny 必须在 ask 之上，否则拒绝会被降级成询问')
  assert.equal(mergeDecisions('allow', 'ask'), 'ask')
  assert.ok(DECISION_RANK.deny > DECISION_RANK.ask && DECISION_RANK.ask > DECISION_RANK.allow)
})

test('⑨a ★★★ **两套词汇表**：桥读 `kind`、注册表读 `decision` —— 各自只认自己那个字段', () => {
  // ── 桥那一侧（`kind`）
  assert.deepEqual(normalizeBridgeDecision({ kind: 'allow' }), { kind: 'allow', malformed: false, raw: 'allow' })
  assert.deepEqual(normalizeBridgeDecision({ kind: 'deny' }), { kind: 'deny', malformed: false, raw: 'deny' })
  assert.deepEqual(normalizeBridgeDecision({ kind: 'ask' }), { kind: 'ask', malformed: false, raw: 'ask' })

  // ── 注册表那一侧（`decision`）
  assert.deepEqual(
    normalizeRegistryDecision({ decision: 'allow', connectorId: 'g' }),
    { kind: 'allow', malformed: false, raw: 'allow' },
  )
  assert.equal(normalizeRegistryDecision({ decision: 'deny', code: 'x' }).kind, 'deny')

  // ★★★ 交叉喂：**必须**判成 malformed，而不是"好心兼容一下"。
  //
  //   一个"两个字段都收"的规范化，与一个"两套词汇表的差异被藏起来"的实现，
  //   在**这一次**的读数上是同一个东西——只不过下一次有人换字段名时，
  //   它同样会静默。
  assert.equal(normalizeBridgeDecision({ decision: 'allow' }).malformed, true,
    '把注册表的 decision 喂给桥侧读法，竟然认出来了 —— 那两套词汇表就白分了')
  assert.equal(normalizeRegistryDecision({ kind: 'allow' }).malformed, true,
    '把桥的 kind 喂给注册表读法，竟然认出来了')
  assert.equal(normalizeBridgeDecision({ decision: 'allow' }).kind, 'deny', '认不出必须兜成 deny')

  // 大小写 / 空白都**不算**认得出（"看起来像"不是判据）
  for (const junk of [{ kind: 'ALLOW' }, { kind: ' allow' }, { kind: 'allow ' }, {}]) {
    const n = normalizeBridgeDecision(junk)
    assert.equal(n.malformed, true, `${JSON.stringify(junk)} 被当成了合法决定`)
    assert.equal(n.kind, 'deny')
  }
  // 缺字段时的 raw 要说清缺的是哪一个（两套词汇表各自的字段名）
  assert.equal(normalizeBridgeDecision({}).raw, '(缺少 kind 字段)')
  assert.equal(normalizeRegistryDecision({}).raw, '(缺少 decision 字段)')
})

// ===========================================================================
// ⑩ ★★★ 两半是一条环：判定面 ask 的半开探针没有结果回来时，
//     熔断器靠 `CIRCUIT_COOLDOWN_MS` 那个窗口**放一条新的**
// ===========================================================================

test('⑩ ★★★ 两半是一条环：探针被 ask 出去、结果永远不回来 ⇒ 连接器不会被永久停用', async () => {
  let t = 1_000_000
  const { registry, port } = setup({
    inner: () => ({ kind: 'allow' }),
    now: () => t,
  })

  // 前提：这个连接器确实是通的（`decide` 返回 allow）。
  assert.equal((await port(PROJ)).kind, 'allow', '前提：一开始应当放行')

  // 连败三次 ⇒ 开路（用判定面之外的记录面推进，正是那一半的职责）。
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    registry.recordOutcome({ connectorId: 'github', ok: false, error: 'boom' })
  }
  assert.equal((await port(PROJ)).kind, 'deny', '熔断没有生效')

  // 冷却到 ⇒ 半开，**放一条探针**（registry 的设计：探针是 `ask`）。
  t += CIRCUIT_COOLDOWN_MS
  const probe = await port(PROJ)
  assert.equal(probe.kind, 'ask', `冷却后应当是探针（ask），实得 ${probe.kind}`)
  assert.equal(port.receipts().outerAsk >= 1, true)

  // ★★★ 关键：这次探针**没有任何结果回来**（人没批 / 没派发 ⇒ 没有 tools/result）。
  //   反复问下去，**不许**永久停在 "正在探"。
  const later = []
  for (let i = 1; i <= 5; i += 1) {
    t += CIRCUIT_COOLDOWN_MS
    later.push((await port(PROJ)).kind)
  }
  assert.deepEqual(
    later, ['ask', 'ask', 'ask', 'ask', 'ask'],
    '探针超期未归之后必须放**新的**探针（`ask`），而不是永远 deny —— '
    + '一个"等一个永远不来的结果"的熔断器与一个"永久停用"的熔断器是同一个东西',
  )

  // ★ 反向对照：窗口**之内**仍然只放一个探针（保护没被关掉）。
  const { registry: r2, port: p2 } = setup({ inner: () => ({ kind: 'allow' }), now: () => t })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r2.recordOutcome({ connectorId: 'github', ok: false })
  let t2 = t + CIRCUIT_COOLDOWN_MS
  // 这里用受控时钟：重造一个端口以绑定 t2
  const reg2 = createRegistry({ connectors: [declOf()], now: () => t2 })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) reg2.recordOutcome({ connectorId: 'github', ok: false })
  const port2 = createConnectorDecisionPort({ registry: reg2, resolveConnectorId: () => 'github', inner: () => ({ kind: 'allow' }) })
  t2 += CIRCUIT_COOLDOWN_MS
  assert.equal((await port2(PROJ)).kind, 'ask', '冷却后第一条应当是探针')
  t2 += 1_000 // ★ 窗口之内
  assert.equal((await port2(PROJ)).kind, 'deny', '窗口之内不许放第二条探针')
  assert.match(port2.receipts().version, /connector-decision-port/)
})

test('⑩a ★★ 探针**真的回来了**（成功）⇒ 连接器恢复放行 —— 环是闭合的', async () => {
  let t = 5_000_000
  const registry = createRegistry({ connectors: [declOf()], now: () => t })
  const port = createConnectorDecisionPort({
    registry, resolveConnectorId: () => 'github', inner: () => ({ kind: 'allow' }),
  })

  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) registry.recordOutcome({ connectorId: 'github', ok: false })
  t += CIRCUIT_COOLDOWN_MS
  assert.equal((await port(PROJ)).kind, 'ask', '冷却后应当放探针')

  // 探针成功了 ⇒ 结果经**记录面**回来（那正是 `outcome-port.mjs` 的职责）。
  registry.recordOutcome({ connectorId: 'github', ok: true })
  const r = await port(PROJ)
  assert.equal(r.kind, 'allow', '探针成功之后连接器应当恢复放行（熔断器合闸）')
})

// ===========================================================================
// ⑪ ★ 计数器：非枚举、且初始全零
// ===========================================================================

test('⑪ ★ receipts() 不可枚举（活对象不该被 JSON.stringify 带出去），且初始全零', async () => {
  const { port } = setup({ inner: () => ({ kind: 'allow' }) })
  const keys = Object.keys(port)
  assert.ok(!keys.includes('receipts'), `receipts 可枚举了：${JSON.stringify(keys)}`)
  assert.equal(JSON.parse(JSON.stringify({ port })).port, undefined)

  const r = port.receipts()
  assert.equal(r.version, CONNECTOR_DECISION_PORT_VERSION)
  for (const [k, v] of Object.entries(r)) {
    if (k === 'version') continue
    assert.equal(v, 0, `${k} 初值不是 0`)
  }
  await port(PROJ)
  assert.equal(port.receipts().seen, 1)
  assert.equal(port.receipts().attributed, 1)
})


// ---------------------------------------------------------------------------
// ⑩～⑮ §5 第 23 条（2026-09-24 裁决采 ①）：`connectorShape` **谓词**端口
//
//   这一组盯的是"**连接器形状、而命名空间不认识**"这一类名字的归宿：
//   裁决前它只能落给政策门，而政策门把它读成**未知工具** ⇒ 要人批 ⇒ **可以被批**。
//
//   ★ 所以下面每个用例的 `inner` 都返回 **allow** —— 一个"政策门说放行"的反例，
//     才能证明"拦下它的是连接器层，而不是政策门碰巧也拒了"。
// ---------------------------------------------------------------------------

function shapePort({ shape, inner = null, resolve = () => null } = {}) {
  const registry = createRegistry({ connectors: [declOf()] })
  const opts = { registry, resolveConnectorId: resolve, inner }
  if (shape !== undefined) opts.connectorShape = shape
  return createConnectorDecisionPort(opts)
}
const allowInner = () => ({ kind: DECISION_KINDS.ALLOW, reason: '政策门说放行' })

test('⑩ ★★★ 连接器形状 + 命名空间不认识 ⇒ **具名拒绝**（政策门就算放行也拦下）', async () => {
  const port = shapePort({ shape: () => ({ shaped: true, namespaceKnown: false }), inner: allowInner })
  const v = await port({ toolName: 'mcp__evil__x' })
  assert.equal(v.kind, DECISION_KINDS.DENY)
  assert.match(v.reason, /登记表/, '理由必须指向登记表这一侧')
  assert.match(v.reason, /命名空间/)
  const r = port.receipts()
  assert.equal(r.namespaceUnknown, 1)
  assert.equal(r.unattributed, 0, '★ 它不算"认不出"——两个读数必须分得开')
})

test('⑪ ★★ 非连接器形状 ⇒ **原样**交给政策门（"认不出就拒掉一切"不许回来）', async () => {
  const port = shapePort({ shape: () => ({ shaped: false, namespaceKnown: false }), inner: allowInner })
  const v = await port({ toolName: 'totally-made-up' })
  assert.equal(v.kind, DECISION_KINDS.ALLOW, '非 MCP 形状的名字不许被连接器层拒')
  assert.equal(v.reason, '政策门说放行', '必须是 inner 的**原话**')
  assert.equal(port.receipts().unattributed, 1)
  assert.equal(port.receipts().namespaceUnknown, 0)
})

test('⑫ 不给谓词 ⇒ 逐字回到裁决前的行为（缺席不是"默认拒"）', async () => {
  const port = shapePort({ inner: allowInner })
  const v = await port({ toolName: 'mcp__evil__x' })
  assert.equal(v.kind, DECISION_KINDS.ALLOW)
  assert.equal(port.receipts().unattributed, 1)
  assert.equal(port.receipts().namespaceUnknown, 0)
})

test('⑬ 谓词抛 ⇒ 记 shapeFailed，并按"不是连接器形状"走（不把判定路径炸掉）', async () => {
  const port = shapePort({ shape: () => { throw new Error('boom') }, inner: allowInner })
  const v = await port({ toolName: 'mcp__evil__x' })
  assert.equal(v.kind, DECISION_KINDS.ALLOW)
  assert.equal(port.receipts().shapeFailed, 1)
})

test('⑭ 谓词不是函数 ⇒ 造端口时就拒（BAD_SHAPE）', () => {
  assert.throws(
    () => shapePort({ shape: 'yes' }),
    (e) => e.code === CONNECTOR_DECISION_PORT_CODES.BAD_SHAPE,
  )
})

test('⑮ ★ 谓词说"命名空间已声明"而 resolver 没认出 ⇒ 仍拒，但理由是**接线不一致**', async () => {
  const port = shapePort({ shape: () => ({ shaped: true, namespaceKnown: true }), inner: allowInner })
  const v = await port({ toolName: 'mcp__github__x' })
  assert.equal(v.kind, DECISION_KINDS.DENY)
  assert.match(v.reason, /接线不一致/,
    '两种"形状对但归属不成"是两件事：没有这个命名空间 / 有这个命名空间而 resolver 漏了')
})

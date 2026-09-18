// runtime/connectors/outcome-port.test.mjs
// ============================================================================
// F-21 反馈面的判据。这一套要钉住的**不是**"函数能跑"，而是三件事：
//
//   ① **它真的会让熔断器跳闸**：不接反馈时 `decide()` 永远合闸（这是本模块
//      存在的唯一理由，所以它必须有一条**端到端**的用例，而不是只测分类函数）；
//   ② **"判不出来"是第三个桶**，且两个方向都不许折（折成成功 ⇒ 坏连接器隐身；
//      折成失败 ⇒ 好连接器被冤枉）；
//   ③ **永不抛**：宿主兜异常不算数。
//
// ★ 每一条断言都配一条**反向对照**：一个恒真的判据与一个什么都没看的判据，
//   在只看"用例绿了没"的时候是同一个东西。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CIRCUIT_COOLDOWN_MS, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_STATES, declareConnector, createRegistry,
} from './registry.mjs'
import {
  OUTCOME_KINDS, OUTCOME_PORT_CODES, OUTCOME_PORT_VERSION,
  classifyOutcome, createOutcomeListener,
} from './outcome-port.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'outcome-port.mjs'), 'utf8')

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err?.code}：${err?.message}`)
  return err
}

/** 一个两工具连接器。 */
function github(over = {}) {
  return declareConnector({
    connectorId: 'github',
    transport: 'stdio',
    command: 'npx mcp-github',
    tools: [{ name: 'list_issues', capabilities: ['repo:read'] }],
    secretRefs: [],
    ...over,
  })
}

/** 可变时钟：熔断的冷却要能被人为跨过。 */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms }, at: () => t }
}

const okResult = () => ({ isError: false, value: { ok: 1 }, content: [] })
const failResult = (msg = 'boom') => ({ isError: true, error: { message: msg }, content: [] })

/** 一个把每次工具调用都算作 `github` 的解析器。 */
const alwaysGithub = () => 'github'

// ---------------------------------------------------------------------------
// ① ★★ 端到端：**不接反馈 ⇒ 永远合闸；接了 ⇒ 真的跳闸**
// ---------------------------------------------------------------------------

test('① ★★ 端到端：连续失败会把 `decide()` 从 allow 推到 deny（这就是本模块存在的理由）', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const args = { connectorId: 'github', toolName: 'list_issues' }

  // 反向对照：**先证明"不接反馈时它永远合闸"**。
  //   少了这一半，"接了之后它会 deny"无法区分"反馈起了作用"与
  //   "这条判据本来就 deny"。
  assert.equal(r.decide(args).decision, 'allow', '前提：新注册表对已声明工具是 allow')
  for (let i = 0; i < 10; i += 1) r.decide(args)
  assert.equal(r.decide(args).decision, 'allow', '反向对照：不记结果时失败多少次都合闸')
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[0], '反向对照：状态仍是 closed')

  // 接上反馈，真记失败。
  const listener = createOutcomeListener({ registry: r, resolveConnectorId: alwaysGithub })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) listener({ name: 'list_issues' }, failResult())

  assert.equal(r.circuit('github').state, CIRCUIT_STATES[1], `连续 ${CIRCUIT_FAILURE_THRESHOLD} 次失败后应开路`)
  const d = r.decide(args)
  assert.equal(d.decision, 'deny')
  assert.equal(d.code, 'connector-circuit-open')

  // 冷却之后进半开。★ 探针被 admit 成 **`ask`**（不是 `allow`）——那是
  // `registry.mjs` 既有的设计（半开探针要人批），所以这里断言的是 `ask` + `probe`。
  c.advance(30_000 + 1)
  const probe = r.decide(args)
  assert.equal(probe.decision, 'ask', '冷却后应进半开并放行一次探针（探针是 ask，不是 allow）')
  assert.equal(probe.probe, true, '这一条必须自报是探针')
  listener({ name: 'list_issues' }, okResult())
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[0], '一次成功应合闸')
  assert.equal(r.circuit('github').consecutiveFailures, 0, '成功必须清零失败计数')
  assert.equal(r.decide(args).decision, 'allow', '合闸之后应恢复 allow')
})

// ---------------------------------------------------------------------------
// ①a ★★★ 探针**永远不回来**时不许把连接器卡死（本批修掉的真缺陷）
// ---------------------------------------------------------------------------

test('①a ★★★ 半开探针没有结果 ⇒ 冷却之后必须放**新**探针，不许永久卡在半开', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const args = { connectorId: 'github', toolName: 'list_issues' }

  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r.recordOutcome({ connectorId: 'github', ok: false })
  c.advance(30_000 + 1)
  assert.equal(r.decide(args).decision, 'ask', '第一条探针被放出去')
  assert.equal(r.circuit('github').probeInFlight, true)

  // ★ 关键：**没有任何结果回来**。
  //   冷却窗口之内仍然"只放一个探针"（这是对的，别把保护关掉）。
  c.advance(CIRCUIT_COOLDOWN_MS - 1)
  assert.equal(r.decide(args).decision, 'deny', '窗口之内仍然只放一个探针')
  assert.equal(r.decide(args).code, 'connector-circuit-open')

  // ★★ 超过窗口 ⇒ 那条探针**已经被当作丢了**，必须放一条新的。
  //   修之前这里会一直 deny 到进程结束（`state==='open'` 那一支再也不可达）。
  c.advance(2)
  const again = r.decide(args)
  assert.equal(again.decision, 'ask', '★ 超期未归的探针必须被释放，否则连接器永久停用')
  assert.equal(again.probe, true)
  assert.notEqual(again.code, 'connector-circuit-open')

  // 而"确实还在飞"的那种仍然只放一个：刚放出去就问，必须是 deny。
  assert.equal(r.decide(args).decision, 'deny', '刚放出去的探针仍然只放一个（保护没被关掉）')

  // 反向对照：一条**回来了**的探针仍然照常推进状态机（不是"什么都不管了"）。
  const c2 = clock()
  const r2 = createRegistry({ connectors: [github()], now: c2.now })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r2.recordOutcome({ connectorId: 'github', ok: false })
  c2.advance(30_000 + 1)
  assert.equal(r2.decide(args).decision, 'ask')
  const l2 = createOutcomeListener({ registry: r2, resolveConnectorId: alwaysGithub })
  l2({}, okResult())
  assert.equal(r2.circuit('github').state, CIRCUIT_STATES[0], '探针成功必须合闸')
  assert.equal(r2.circuit('github').probeStartedAtMs, null, '结果回来之后探针起点必须清空')
})

test('①b ★★ 判据不许把"探针超期"写成"永远放行"（结构级：窗口来自同一个常量）', () => {
  // 这个修复最危险的错法是"忘了判窗口，于是每次都放新探针"——
  // 那等于把半开保护整个关掉，而用例 ①a 的第二段会绿（它只看超期之后放行）。
  // 所以这里同时钉住源码用的是**同一个** `CIRCUIT_COOLDOWN_MS`，
  // 而不是一个新数（一个新数会让两个窗口悄悄漂移）。
  const REG = readFileSync(join(HERE, 'registry.mjs'), 'utf8')
  assert.match(REG, /probeAge\s*>?=\s*CIRCUIT_COOLDOWN_MS|probeAge[^\n]*CIRCUIT_COOLDOWN_MS/,
    '探针超期的判据必须引用 CIRCUIT_COOLDOWN_MS')
  assert.equal(/probeLost\s*=\s*(true|false)\b/.test(REG), false, '不许把 probeLost 写死')
})


// ---------------------------------------------------------------------------
// ② ★★★ "判不出来"必须是第三个桶（两个方向都不许折）
// ---------------------------------------------------------------------------

test('② ★★★ `isError` 不是布尔 ⇒ unclassifiable（不许当成功，也不许当失败）', () => {
  const cases = [
    ['字段缺失', { value: 1, content: [] }],
    ['undefined', { isError: undefined }],
    ['null', { isError: null }],
    ['字符串 "false"', { isError: 'false' }],
    ['数字 0', { isError: 0 }],
    ['整个 result 是 null', null],
    ['整个 result 是数组', []],
    ['整个 result 是字符串', '{"isError":false}'],
  ]
  for (const [name, input] of cases) {
    const got = classifyOutcome(input)
    assert.equal(got.kind, OUTCOME_KINDS.UNCLASSIFIABLE, `${name} 应判为 unclassifiable，实得 ${got.kind}`)
    assert.equal(got.error, null, `${name} 不许编一个错误消息`)
    assert.equal(typeof got.why, 'string', `${name} 必须说明为什么判不出来`)
  }
  // 反向对照：两个**合法**分支必须仍然分得开。
  assert.equal(classifyOutcome(okResult()).kind, OUTCOME_KINDS.OK)
  assert.equal(classifyOutcome(failResult()).kind, OUTCOME_KINDS.FAILED)
})

test('②a ★★★ 判不出来 ⇒ **一条都不记**（两个方向的错法不对称，都要钉住）', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({ registry: r, resolveConnectorId: alwaysGithub })
  const args = { connectorId: 'github', toolName: 'list_issues' }

  // 方向一：折成成功 ⇒ 会把**坏**连接器合闸（于是它永远开不了路）。
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) listener({}, failResult())
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[1], '前提：此刻已经开路')
  listener({}, { isError: undefined })          // 读不懂的输入
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[1], '读不懂**不许**把它合闸（折成成功的后果）')
  assert.equal(r.circuit('github').consecutiveFailures, CIRCUIT_FAILURE_THRESHOLD,
    '读不懂**不许**清零失败计数')

  // 方向二：折成失败 ⇒ 会把**好**连接器推向开路。
  const c2 = clock()
  const r2 = createRegistry({ connectors: [github()], now: c2.now })
  const l2 = createOutcomeListener({ registry: r2, resolveConnectorId: alwaysGithub })
  for (let i = 0; i < 50; i += 1) l2({}, { isError: 'true' })  // 看着像失败，其实是读不懂
  assert.equal(r2.circuit('github').state, CIRCUIT_STATES[0], '读不懂**不许**把好连接器推向开路')
  assert.equal(r2.circuit('github').consecutiveFailures, 0)
  assert.equal(r2.decide(args).decision, 'allow')

  // 反向对照：**真的**失败必须仍然开路（否则上面两条只是在测"什么都不记"）。
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) l2({}, failResult())
  assert.equal(r2.circuit('github').state, CIRCUIT_STATES[1], '真失败必须开路')
})

test('②b 判不出来的次数**被计数**（"什么都没记"与"没失败"要分得开）', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const seen = []
  const listener = createOutcomeListener({
    registry: r, resolveConnectorId: alwaysGithub, onRecord: (x) => seen.push(x),
  })
  listener({}, failResult())
  listener({}, { isError: undefined })
  listener({}, okResult())
  const rc = listener.receipts()
  assert.deepEqual(
    { seen: rc.seen, recorded: rc.recorded, failed: rc.failed, ok: rc.ok, unclassifiable: rc.unclassifiable },
    { seen: 3, recorded: 2, failed: 1, ok: 1, unclassifiable: 1 },
  )
  assert.equal(rc.version, OUTCOME_PORT_VERSION)
  assert.equal(seen.filter((s) => s.kind === 'unclassifiable').length, 1)
})

// ---------------------------------------------------------------------------
// ③ ★ 认不出属于哪条连接器 ⇒ 不记（绝不"猜一个"）
// ---------------------------------------------------------------------------

test('③ ★★ 认不出连接器 ⇒ 不记，且**不牵连**任何健康连接器', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({ registry: r, resolveConnectorId: () => null })

  for (let i = 0; i < 20; i += 1) listener({}, failResult('不属于任何连接器'))
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[0],
    '一次没有归属的失败**不许**记到某条健康连接器头上')
  assert.equal(listener.receipts().unattributed, 20)
  assert.equal(listener.receipts().recorded, 0)

  // 空串 / 非字符串同样是"认不出"。
  for (const bad of ['', '   ', 42, {}, []]) {
    const l = createOutcomeListener({ registry: r, resolveConnectorId: () => bad })
    l({}, failResult())
    assert.equal(l.receipts().unattributed, 1, `解析器返回 ${JSON.stringify(bad)} 应算认不出`)
    assert.equal(l.receipts().recorded, 0)
  }
})

test('③a ★ 解析器**抛**时也不记（一个会炸的解析器不许把失败记到别人头上）', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({
    registry: r, resolveConnectorId: () => { throw new Error('boom') },
  })
  assert.doesNotThrow(() => listener({}, failResult()))
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[0])
  assert.equal(listener.receipts().unattributed, 1)
})

// ---------------------------------------------------------------------------
// ④ ★★ 永不抛（宿主兜异常不算数）
// ---------------------------------------------------------------------------

test('④ ★★ `recordOutcome` 抛（未注册 id）⇒ 监听器仍然不抛，并如实计数', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({ registry: r, resolveConnectorId: () => 'never-registered' })
  assert.doesNotThrow(() => listener({}, failResult()))
  assert.equal(listener.receipts().recordFailed, 1, '记录失败必须被计数')
  assert.equal(listener.receipts().recorded, 0)
  assert.equal(r.circuit('github').state, CIRCUIT_STATES[0])
})

test('④a 观测点 `onRecord` 自己抛 ⇒ 不影响记录', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({
    registry: r, resolveConnectorId: alwaysGithub, onRecord: () => { throw new Error('observer boom') },
  })
  assert.doesNotThrow(() => listener({}, failResult()))
  assert.equal(listener.receipts().recorded, 1)
  assert.equal(r.circuit('github').consecutiveFailures, 1)
})

test('④b `projectionFor` 抛 ⇒ 不抛，且退化成"认不出"', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({
    registry: r,
    resolveConnectorId: alwaysGithub,
    projectionFor: () => { throw new Error('projection boom') },
  })
  assert.doesNotThrow(() => listener({}, failResult()))
  // 解析器是 alwaysGithub，所以仍然记得上——但投影失败本身不许炸。
  assert.equal(listener.receipts().recorded, 1)
})

// ---------------------------------------------------------------------------
// ⑤ ★ 与强制面看**同一份**投影（`projectionFor` 按 callId 记忆）
// ---------------------------------------------------------------------------

test('⑤ 用 `projectionFor` 取投影：命中记忆的那一份，且失败时退化成无投影', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const memory = new Map([['call-1', { toolName: 'list_issues', canonicalTarget: '/w/a' }]])
  const got = []
  const listener = createOutcomeListener({
    registry: r,
    projectionFor: (exec) => {
      const p = memory.get(exec.callId)
      return p === undefined ? { ok: false, code: 'X', message: 'no' } : { ok: true, projection: p }
    },
    resolveConnectorId: (projection) => {
      got.push(projection)
      return projection === null ? null : 'github'
    },
  })

  listener({ callId: 'call-1' }, failResult())
  assert.deepEqual(got[0], { toolName: 'list_issues', canonicalTarget: '/w/a' }, '应拿到强制面记忆的那一份')
  assert.equal(listener.receipts().recorded, 1)

  listener({ callId: 'unknown' }, failResult())
  assert.equal(got[1], null, '投影失败时交给解析器的是 null，不是编出来的对象')
  assert.equal(listener.receipts().unattributed, 1)
})

// ---------------------------------------------------------------------------
// ⑥ 构造期 fail closed
// ---------------------------------------------------------------------------

test('⑥ ★★ 构造期就拒：没有注册表 / 没有解析器 —— 不留一个"挂了但什么都不记"的空壳', () => {
  throwsCode(() => createOutcomeListener({ resolveConnectorId: alwaysGithub }), OUTCOME_PORT_CODES.NO_REGISTRY)
  throwsCode(() => createOutcomeListener({ registry: {}, resolveConnectorId: alwaysGithub }), OUTCOME_PORT_CODES.NO_REGISTRY)
  throwsCode(() => createOutcomeListener({ registry: null, resolveConnectorId: alwaysGithub }), OUTCOME_PORT_CODES.NO_REGISTRY)

  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  throwsCode(() => createOutcomeListener({ registry: r }), OUTCOME_PORT_CODES.NO_RESOLVE)
  throwsCode(() => createOutcomeListener({ registry: r, resolveConnectorId: null }), OUTCOME_PORT_CODES.NO_RESOLVE)
  throwsCode(() => createOutcomeListener({ registry: r, resolveConnectorId: 'github' }), OUTCOME_PORT_CODES.NO_RESOLVE)
  throwsCode(
    () => createOutcomeListener({ registry: r, resolveConnectorId: alwaysGithub, projectionFor: 42 }),
    OUTCOME_PORT_CODES.NO_RESOLVE,
  )
})

test('⑥a `receipts` 是**不可枚举**的（活对象不许被 JSON.stringify 带出去）', () => {
  const c = clock()
  const r = createRegistry({ connectors: [github()], now: c.now })
  const listener = createOutcomeListener({ registry: r, resolveConnectorId: alwaysGithub })
  assert.equal(typeof listener.receipts, 'function')
  assert.equal(Object.keys(listener).includes('receipts'), false)
  assert.equal(JSON.stringify({ listener }).includes('receipts'), false)
})

// ---------------------------------------------------------------------------
// ⑦ ★ 结构级：它**不许**读 `isError` 之外的字段来判成败
// ---------------------------------------------------------------------------

test('⑦ ★★ 结构级：判成败只许看 `isError` —— 不许从 content/value/error 推导', () => {
  // 一个"content 是空的就算失败"的判据会把**合法的空结果**判成故障；
  // 一个"有 error 字段就算失败"的判据会对成功结果里的 meta.error 误判。
  // 这两条都是**推导**，而推导在这里的方向是"把好连接器推去开路"。
  assert.equal(classifyOutcome({ isError: false, content: [], value: null }).kind, OUTCOME_KINDS.OK,
    '合法的空成功结果不许被判成失败')
  assert.equal(classifyOutcome({ isError: false, error: { message: 'x' } }).kind, OUTCOME_KINDS.OK)
  assert.equal(classifyOutcome({ isError: true, content: [{ type: 'text', text: 'x' }] }).kind, OUTCOME_KINDS.FAILED)

  // ★ 而失败时**读得到**就带上原文，读不到就是 null（不编）。
  assert.equal(classifyOutcome(failResult('connection refused')).error, 'connection refused')
  assert.equal(classifyOutcome({ isError: true }).error, null, '没有 error.message 时不许编一句话')
  assert.equal(classifyOutcome({ isError: true, error: 'refused' }).error, null, 'error 不是对象时也不许猜')

  // 源码里不许出现按 content 长度 / value 存在性判成败的写法。
  assert.equal(/content\.length|value\s*===?\s*(null|undefined)\s*\?/.test(SRC), false,
    '判据源码里不许有"按 content/value 推导成败"的写法')
})

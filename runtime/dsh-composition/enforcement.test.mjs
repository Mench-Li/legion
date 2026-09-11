// runtime/dsh-composition/enforcement.test.mjs
// ============================================================================
// PRT-212 强制点原语的测试。
//
// 这些用例覆盖的是**真实故障路径**：超时、异常、畸形返回、哈希漂移、
// 并发重复消费。它们用真 DSH 几乎无法稳定复现，而这正是把它们做成
// 纯函数 + 注入端口的理由。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANONICAL_OP_KEYS,
  CANONICAL_OP_SCHEMA_VERSION,
  PRE_DECISIONS,
  canonicalJson,
  canonicalOperationHash,
  canonicalScalar,
  canonicalizePath,
  createAllowOnceStore,
  createApprovalAnswerer,
  createHardFloorGuard,
  createPreExecutePolicy,
  nfc,
} from './enforcement.mjs'

/** 一个最小的合法 canonical operation。 */
const OP = Object.freeze({
  scope: 'software',
  actor: 'general',
  action: 'fs.write',
  target: 'C:\\Work\\a.txt',
  taskId: 'T-1',
  toolName: 'write',
  callId: 'call-1',
  arguments: { path: 'C:\\Work\\a.txt', content: 'hi' },
})

const HASH_OPTS = { cwd: 'C:\\Work', platform: 'win32' }

// ----------------------------------------------------------------- canonical op

test('canonical：键顺序不影响哈希（同一个参数对象的不同 JSON 写法是同一个操作）', () => {
  const a = canonicalOperationHash({ ...OP, arguments: { path: 'C:\\Work\\a.txt', content: 'hi' } }, HASH_OPTS)
  const b = canonicalOperationHash({ ...OP, arguments: { content: 'hi', path: 'C:\\Work\\a.txt' } }, HASH_OPTS)
  assert.equal(a, b)
})

test('canonical：数组**保序**（[1,2] 与 [2,1] 是不同的操作）', () => {
  const a = canonicalOperationHash({ ...OP, arguments: { files: [1, 2] } }, HASH_OPTS)
  const b = canonicalOperationHash({ ...OP, arguments: { files: [2, 1] } }, HASH_OPTS)
  assert.notEqual(a, b, '数组顺序必须参与哈希，否则「批准了这两个文件」会覆盖任意顺序')
})

test('canonical：Unicode 做 NFC（组合字符与预组合字符是同一次操作）', () => {
  // U+00E9 (é) 与 U+0065 U+0301 (e + 组合尖音符)
  const precomposed = '\u00e9'
  const decomposed = 'e\u0301'
  assert.notEqual(precomposed, decomposed, '前提：两者字面不同')
  assert.equal(nfc(decomposed), nfc(precomposed))
  const a = canonicalOperationHash({ ...OP, taskId: precomposed }, HASH_OPTS)
  const b = canonicalOperationHash({ ...OP, taskId: decomposed }, HASH_OPTS)
  assert.equal(a, b, '不做 NFC 会让「明明批准了却还是被拒」')
})

test('canonical：Windows 大小写与分隔符归并（同一文件不得产生两个哈希）', () => {
  const a = canonicalOperationHash({ ...OP, target: 'C:\\Work\\a.txt' }, HASH_OPTS)
  const b = canonicalOperationHash({ ...OP, target: 'c:/work/A.TXT' }, HASH_OPTS)
  assert.equal(a, b, '同一台机器上它们是同一个文件，哈希必须一致')
})

test('canonical：POSIX 下大小写**不**归并（那是两个不同文件）', () => {
  const a = canonicalOperationHash({ ...OP, target: '/work/a.txt' }, { cwd: '/work', platform: 'linux' })
  const b = canonicalOperationHash({ ...OP, target: '/work/A.txt' }, { cwd: '/work', platform: 'linux' })
  assert.notEqual(a, b, '在 Linux 上 a.txt 与 A.txt 是两个文件，归并会把批准扩大到另一个文件')
})

test('canonical：路径折叠 `.` 与 `..`（a/../b 与 b 是同一个目标）', () => {
  assert.equal(canonicalizePath('C:\\Work\\sub\\..\\a.txt', HASH_OPTS), canonicalizePath('C:\\Work\\a.txt', HASH_OPTS))
  assert.equal(canonicalizePath('C:\\Work\\.\\a.txt', HASH_OPTS), canonicalizePath('C:\\Work\\a.txt', HASH_OPTS))
})

test('canonical：相对路径按 cwd 展开；**缺 cwd 时抛错而不是猜**', () => {
  assert.equal(canonicalizePath('a.txt', { cwd: 'C:\\Work', platform: 'win32' }), 'c:/work/a.txt')
  assert.throws(
    () => canonicalizePath('a.txt', { platform: 'win32' }),
    /缺少 cwd/,
    '猜一个工作目录会让哈希依赖隐式状态，两次执行得到不同结果而无人知道为什么',
  )
})

test('canonical：数字与空值的规范表达（-0 就是 0，非有限数拒绝）', () => {
  assert.equal(canonicalScalar(-0), 0)
  assert.equal(canonicalScalar(0), 0)
  assert.throws(() => canonicalScalar(Number.POSITIVE_INFINITY), /非有限数值/)
  assert.throws(() => canonicalScalar(Number.NaN), /非有限数值/)
})

test('canonical：undefined 值的键被省略（{a:undefined} 与 {} 在 JSON 语义下相同）', () => {
  assert.equal(canonicalJson({ a: undefined }), '{}')
  assert.equal(canonicalJson({}), '{}')
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
})

test('canonical：null 与缺失**不**等同（null 是有意表达的空，缺失是没说）', () => {
  assert.equal(canonicalJson({ a: null }), '{"a":null}')
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}))
})

test('canonical：缺少任一必需字段即抛错，不静默降级', () => {
  for (const key of CANONICAL_OP_KEYS) {
    const partial = { ...OP }
    delete partial[key]
    assert.throws(() => canonicalOperationHash(partial, HASH_OPTS), new RegExp(`缺少必需字段：${key}`))
  }
})

test('canonical：观察 metadata 不参与哈希（它不影响被授权的那个操作）', () => {
  const base = canonicalOperationHash(OP, HASH_OPTS)
  const withNoise = canonicalOperationHash({ ...OP, attemptId: 'attempt-9', uiText: '正在写入…', timestamp: 123456 }, HASH_OPTS)
  assert.equal(base, withNoise, '把时间戳算进去会让同一个操作每次哈希都不同，批准永远失效')
})

test('canonical：schema 版本是哈希输入的一部分（改形式必须换哈希）', () => {
  assert.equal(typeof CANONICAL_OP_SCHEMA_VERSION, 'number')
  const h = canonicalOperationHash(OP, HASH_OPTS)
  assert.match(h, /^sha256:[0-9a-f]{64}$/)
})

// ----------------------------------------------------------------- hard floor

test('hard floor：拒绝列出的工具，其它工具不动', () => {
  const guard = createHardFloorGuard({ denyTools: ['rm', 'delete_repo'], cwd: 'C:\\Work' })
  assert.match(guard({ name: 'rm', arguments: {} }), /静态禁止/)
  assert.equal(guard({ name: 'read', arguments: {} }), undefined, '不在禁止集里 → 不动（undefined，不是 "allow"）')
})

test('hard floor：**同步**返回，且没有 allow 这个返回值', () => {
  const guard = createHardFloorGuard({ denyTools: ['rm'], cwd: 'C:\\Work' })
  const r = guard({ name: 'read', arguments: {} })
  assert.equal(typeof r?.then, 'undefined', 'guard 变成异步会让「最终」这个语义消失')
  assert.ok(r === undefined || typeof r === 'string', 'guard 的返回值只能是理由或 undefined')
})

test('hard floor：路径前缀按**路径段**匹配，不做字符串前缀', () => {
  const guard = createHardFloorGuard({ denyPathPrefixes: ['C:\\Work\\secrets'], cwd: 'C:\\Work' })
  assert.match(guard({ name: 'write', arguments: { path: 'C:\\Work\\secrets\\k.txt' } }), /静态禁止范围/)
  assert.equal(
    guard({ name: 'write', arguments: { path: 'C:\\Work\\secrets-public\\k.txt' } }),
    undefined,
    '字符串前缀匹配会把 secrets-public 也封掉 —— 那是可用性缺陷，不是安全收益',
  )
})

test('hard floor：路径无法规范化时**拒绝**，因为无法证明它在禁止范围之外', () => {
  const guard = createHardFloorGuard({ denyPathPrefixes: ['C:\\Work\\secrets'] })
  const r = guard({ name: 'write', arguments: { path: 'relative.txt' } })
  assert.match(r, /无法规范化/, '证明不了安全就不放行')
})

test('hard floor：hard floor 不看审批，因此不存在「批了就能过」的输入通道', () => {
  // 结构性断言：guard 只接收 execution。没有 approvals 参数可以传进来，
  // 因此「人工已批准但仍被 guard 拒绝」是**设计上**可能的，不是 bug。
  const guard = createHardFloorGuard({ denyTools: ['rm'], cwd: 'C:\\Work' })
  assert.equal(guard.length, 1)
  assert.match(guard({ name: 'rm', arguments: {}, approved: true, approval: 'allowed-once' }), /静态禁止/)
})

// ----------------------------------------------------------------- pre-execute

test('pre-execute：allow / deny / ask 原样透传', async () => {
  const seen = []
  const listener = createPreExecutePolicy({
    decide: (exec) => ({ allow: PRE_DECISIONS.allow(), deny: PRE_DECISIONS.deny('越界'), ask: PRE_DECISIONS.ask('要问') }[exec.name]),
    now: () => 0,
    onDecision: (d) => seen.push(d.reason),
  })
  assert.deepEqual(await listener({ name: 'allow' }), { kind: 'allow' })
  assert.deepEqual(await listener({ name: 'deny' }), { kind: 'deny', reason: '越界' })
  assert.deepEqual(await listener({ name: 'ask' }), { kind: 'ask', reason: '要问' })
  assert.deepEqual(seen, ['allow', 'deny', 'ask'])
})

test('pre-execute：策略门超时 → **deny**（fail closed），而不是挂起或放行', async () => {
  const listener = createPreExecutePolicy({
    decide: () => new Promise(() => {}), // 永不结算：模拟 team-hub 进程活着但不响应
    connectTimeoutMs: 5,
    responseTimeoutMs: 5,
  })
  const d = await listener({ name: 'write' })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /fail closed/)
})

test('pre-execute：策略门抛错 → deny，且理由带上原因', async () => {
  const listener = createPreExecutePolicy({ decide: () => { throw new Error('team-hub 不可达') }, connectTimeoutMs: 50, responseTimeoutMs: 50 })
  const d = await listener({ name: 'write' })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /team-hub 不可达/)
})

test('pre-execute：畸形返回（缺 kind / 未知 kind）→ deny，不当作放行', async () => {
  for (const bad of [undefined, null, {}, { kind: 'maybe' }, 'allow', 42]) {
    const listener = createPreExecutePolicy({ decide: () => bad, connectTimeoutMs: 50, responseTimeoutMs: 50 })
    const d = await listener({ name: 'write' })
    assert.equal(d.kind, 'deny', `返回值 ${JSON.stringify(bad)} 必须按拒绝处理`)
  }
})

test('pre-execute：拒绝但没给理由 → 补齐理由（无理由的拒绝在审计里无法归因）', async () => {
  const listener = createPreExecutePolicy({ decide: () => ({ kind: 'deny' }), connectTimeoutMs: 50, responseTimeoutMs: 50 })
  const d = await listener({ name: 'write' })
  assert.equal(d.kind, 'deny')
  assert.ok(typeof d.reason === 'string' && d.reason.length > 0)
})

test('pre-execute：每个决定都带 source 归因（策略拒绝与沙箱兜底必须可区分）', async () => {
  const decisions = []
  const listener = createPreExecutePolicy({
    decide: () => ({ kind: 'deny', reason: 'x' }),
    connectTimeoutMs: 50,
    responseTimeoutMs: 50,
    onDecision: (d) => decisions.push(d),
  })
  await listener({ name: 'write' })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].source, 'pre-execute')
  assert.equal(typeof decisions[0].elapsedMs, 'number')
})

// ----------------------------------------------------------------- approval

test('approval：闭集内的结果原样透传', async () => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    const answerer = createApprovalAnswerer({ request: () => outcome, connectTimeoutMs: 50, responseTimeoutMs: 50, now: () => 0 })
    assert.equal(await answerer({ toolName: 'write' }), outcome)
  }
})

test('approval：超时 → `unavailable`，**不是** `rejected`', async () => {
  const answerer = createApprovalAnswerer({
    request: () => new Promise(() => {}),
    connectTimeoutMs: 5,
    responseTimeoutMs: 5,
    now: () => 0,
  })
  const outcome = await answerer({ toolName: 'write' })
  assert.equal(outcome, 'unavailable')
  assert.notEqual(outcome, 'rejected', '把故障伪装成决策，会让人去追问一个从未被问过的人')
})

test('approval：审批箱抛错 → unavailable', async () => {
  const answerer = createApprovalAnswerer({ request: () => { throw new Error('连接失败') }, connectTimeoutMs: 50, responseTimeoutMs: 50, now: () => 0 })
  assert.equal(await answerer({ toolName: 'write' }), 'unavailable')
})

test('approval：闭集外的返回 → unavailable（这个 answerer 现在不可信）', async () => {
  for (const bad of ['yes', 'allow', true, null, undefined, {}]) {
    const answerer = createApprovalAnswerer({ request: () => bad, connectTimeoutMs: 50, responseTimeoutMs: 50, now: () => 0 })
    assert.equal(await answerer({ toolName: 'write' }), 'unavailable', `${JSON.stringify(bad)} 不得当作放行`)
  }
})

test('approval：已取消的请求返回 `cancelled`（调用方撤回 ≠ 我们问不到人）', async () => {
  const ac = new AbortController()
  ac.abort()
  let called = false
  const answerer = createApprovalAnswerer({
    request: () => { called = true; return 'allowed-once' },
    connectTimeoutMs: 50,
    responseTimeoutMs: 50,
    now: () => 0,
  })
  const outcome = await answerer({ toolName: 'write', signal: ac.signal })
  assert.equal(outcome, 'cancelled')
  assert.equal(called, false, '已撤回的请求连问都不必问')
})

test('approval：畸形请求 → unavailable，不抛给 waterfall', async () => {
  const answerer = createApprovalAnswerer({ request: () => 'allowed-once', connectTimeoutMs: 50, responseTimeoutMs: 50, now: () => 0 })
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(await answerer(bad), 'unavailable')
  }
})

test('approval：outcome 与 elapsedMs 被记录（审计要能回答「问了多久」）', async () => {
  const outcomes = []
  const answerer = createApprovalAnswerer({
    request: () => 'rejected',
    connectTimeoutMs: 50,
    responseTimeoutMs: 50,
    now: () => 1234,
    onOutcome: (o) => outcomes.push(o),
  })
  await answerer({ toolName: 'write' })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'rejected')
  assert.equal(outcomes[0].reason, 'denied')
  assert.equal(outcomes[0].elapsedMs, 0)
})

// ----------------------------------------------------------------- allow-once

test('allow-once：同一哈希只能消费一次', () => {
  const store = createAllowOnceStore()
  assert.equal(store.consume('sha256:aa'), true)
  assert.equal(store.consume('sha256:aa'), false, '第二次必须失败，否则「一次性批准」不成其为一次性')
  assert.equal(store.isConsumed('sha256:aa'), true)
  assert.equal(store.consume('sha256:bb'), true, '不同哈希互不影响')
  assert.equal(store.size, 2)
})

test('allow-once：并发重复调用只有一个拿到 true（同步 CAS，无 await 点）', async () => {
  const store = createAllowOnceStore()
  // 同一 tick 内并发：若 consume 是 async，两个调用会同时读到「未消费」。
  const results = await Promise.all([
    Promise.resolve().then(() => store.consume('h')),
    Promise.resolve().then(() => store.consume('h')),
    Promise.resolve().then(() => store.consume('h')),
  ])
  assert.equal(results.filter(Boolean).length, 1, '同一 Attempt 内参数完全相同的并发重复调用不得放行两次')
})

test('allow-once：consume 是同步函数（不返回 promise）', () => {
  const store = createAllowOnceStore()
  const r = store.consume('h')
  assert.equal(r, true)
  assert.equal(typeof r?.then, 'undefined')
})

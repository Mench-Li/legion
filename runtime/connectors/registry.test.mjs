// runtime/connectors/registry.test.mjs
// ============================================================================
// F-21 连接器登记表的判据。
//
// 四条主线，每一条都对应一个"看起来能用、其实在撒谎"的写法：
//   · 未声明的工具**拒绝**（不是"不知道所以放行"）
//   · 风险只能**往上抬**，不认识的能力/等级**不兜底**
//   · 密钥只许引用，且引用要对得上号
//   · 故障隔离：开路有截止时间、半开只放一个探针、互不牵连
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CIRCUIT_COOLDOWN_MS, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_STATES, CONNECTOR_CODES,
  CONNECTOR_DECISIONS, CONNECTOR_REGISTRY_VERSION, CONNECTOR_TRANSPORTS,
  FORBIDDEN_SECRET_KEYS, declareConnector, createRegistry,
} from './registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

/** 一个三工具连接器：低风险、硬底线、工具级 deny。 */
function github(over = {}) {
  return declareConnector({
    connectorId: 'github',
    transport: 'stdio',
    command: 'npx mcp-github',
    tools: [
      { name: 'list_issues', capabilities: ['repo:read'] },
      { name: 'create_pr', capabilities: ['repo:push'] },
      { name: 'delete_branch', capabilities: ['repo:write'], policy: 'deny' },
      { name: 'ping', capabilities: ['mcp:call'] },
    ],
    secretRefs: ['mcp.github.token'],
    ...over,
  })
}

// ---------------------------------------------------------------------------
// ① ★★★ 未声明的工具必须拒绝
// ---------------------------------------------------------------------------

test('① ★★★ 未声明的工具 ⇒ deny（"没见过就放行"等于对方加工具就等于加后门）', () => {
  const r = createRegistry({ connectors: [github()] })
  const d = r.decide({ connectorId: 'github', toolName: 'undeclared_tool' })
  assert.equal(d.decision, 'deny')
  assert.equal(d.code, CONNECTOR_CODES.UNKNOWN_TOOL)
  assert.match(d.reason, /后门/)
  // 空名字、以及只在**别的**连接器上声明过的工具，同样拒绝。
  assert.equal(r.decide({ connectorId: 'github', toolName: '' }).decision, 'deny')
  const other = declareConnector({
    connectorId: 'gitlab', transport: 'http', url: 'https://x', tools: [{ name: 'list_issues', capabilities: ['repo:read'] }],
  })
  const r2 = createRegistry({ connectors: [github(), other] })
  assert.equal(r2.decide({ connectorId: 'github', toolName: 'list_issues' }).decision, 'allow')
  // 工具名是**按连接器**分域的：gitlab 的工具不会让 github 的同类工具多出来。
  assert.equal(r2.decide({ connectorId: 'gitlab', toolName: 'create_pr' }).code, CONNECTOR_CODES.UNKNOWN_TOOL)
})

test('① ★★★ 未注册的连接器 ⇒ deny（不是"没有策略所以放行"）', () => {
  const r = createRegistry({ connectors: [github()] })
  const d = r.decide({ connectorId: 'never-registered', toolName: 'list_issues' })
  assert.equal(d.decision, 'deny')
  assert.equal(d.code, CONNECTOR_CODES.UNKNOWN_CONNECTOR)
  // 查它的熔断状态要抛（不是返回一个"健康"的空壳）。
  throwsCode(() => r.circuit('never-registered'), CONNECTOR_CODES.UNKNOWN_CONNECTOR)
  throwsCode(() => r.recordOutcome({ connectorId: 'never-registered', ok: true }), CONNECTOR_CODES.UNKNOWN_CONNECTOR)
  throwsCode(() => r.secretStatus('never-registered'), CONNECTOR_CODES.UNKNOWN_CONNECTOR)
  assert.equal(r.connector('never-registered'), null)
})

// ---------------------------------------------------------------------------
// ② ★★★ 风险只能往上抬
// ---------------------------------------------------------------------------

test('② ★★★ 声明 low 但能力蕴含更高 ⇒ 生效值被抬上去，且留痕', () => {
  const c = declareConnector({
    connectorId: 'c1', transport: 'stdio', command: 'x',
    tools: [{ name: 'push', capabilities: ['repo:push'], declaredRisk: 'low' }],
  })
  const t = c.tools[0]
  assert.equal(t.declaredRisk, 'low', '作者填的值如实保留（用于诊断）')
  assert.equal(t.riskFloor, 'critical', 'repo:push 是硬底线')
  assert.equal(t.risk, 'critical', '生效值不能低于能力蕴含的下限')
  assert.equal(t.riskRaised, true, '被抬高了必须留痕')
  // 生效值决定判定：hard floor 一定要人批。
  const r = createRegistry({ connectors: [c] })
  assert.equal(r.decide({ connectorId: 'c1', toolName: 'push' }).decision, 'ask')
})

test('② ★★★ 不认识的能力名**报错**，不静默兜底成最严', () => {
  // 兜底成最严看起来安全，实际最坏：整个连接器全要人批，
  // 而没有任何一处指出原因是能力名拼错了。
  const err = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['read'] }],
    }),
    CONNECTOR_CODES.BAD_CAPABILITY,
  )
  assert.match(err.message, /全要人批/)
  assert.match(err.message, /repo:read/, '报错要附上合法清单')
})

test('② ★★ 不认识的**风险等级**也报错，不当成 low 也不当成 critical', () => {
  const err = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['repo:read'], declaredRisk: 'moderate' }],
    }),
    CONNECTOR_CODES.BAD_RISK,
  )
  assert.match(err.message, /当成 low 会放行/)
})

test('② ★★ 工具一个能力都不声明 ⇒ 拒绝（"没有能力"与"能力未知"同形）', () => {
  const err = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: [] }],
    }),
    CONNECTOR_CODES.BAD_DECLARATION,
  )
  assert.match(err.message, /按最严处理/)
})

test('② ★ 高风险一律要人批，低风险才放行', () => {
  const r = createRegistry({ connectors: [github()] })
  assert.equal(r.decide({ connectorId: 'github', toolName: 'list_issues' }).decision, 'allow')
  assert.equal(r.decide({ connectorId: 'github', toolName: 'create_pr' }).decision, 'ask')
  // 调用方给出的额外风险只会把结论推严，不会放松。
  assert.equal(r.decide({ connectorId: 'github', toolName: 'list_issues', toolRisk: 'critical' }).decision, 'ask')
  assert.equal(r.decide({ connectorId: 'github', toolName: 'list_issues', toolRisk: 'low' }).decision, 'allow')
})

// ---------------------------------------------------------------------------
// ③ ★★★ 工具级 deny 优先于 server 级 allow
// ---------------------------------------------------------------------------

test('③ ★★★ 工具级 deny 不被 server 级 allow 盖掉', () => {
  // 一个人专门写下的那条 deny，正是为了拦住一样具体的东西。
  // 反过来（"更具体的说了算"只在工具是 allow 时才看 server）时，
  // 那条 deny 会被宽松的默认静默盖掉。
  const r = createRegistry({ connectors: [github({ policy: 'allow' })] })
  const d = r.decide({ connectorId: 'github', toolName: 'delete_branch' })
  assert.equal(d.decision, 'deny')
  assert.match(d.reason, /工具级策略是 deny/)
  assert.match(d.reason, /优先/)
  // server 级 deny 时，连低风险工具也 deny。
  const r2 = createRegistry({ connectors: [github({ policy: 'deny' })] })
  assert.equal(r2.decide({ connectorId: 'github', toolName: 'list_issues' }).decision, 'deny')
  assert.equal(r2.decide({ connectorId: 'github', toolName: 'ping' }).decision, 'deny')
  // server 级 ask 时，低风险工具变成 ask（不会因为工具是 allow 就放行）。
  const r3 = createRegistry({ connectors: [github({ policy: 'ask' })] })
  assert.equal(r3.decide({ connectorId: 'github', toolName: 'list_issues' }).decision, 'ask')
})

test('③ 策略词表封闭：写个 `allow-always` 会被拒', () => {
  assert.deepEqual([...CONNECTOR_DECISIONS], ['allow', 'deny', 'ask'])
  // 刻意**没有** allow-once / allow-for-task：那些是"一次具体调用"的
  // 一次性状态（F-10 管的），混进登记表会让一次性批准变成永久策略。
  assert.equal(CONNECTOR_DECISIONS.includes('allow-once'), false)
  throwsCode(
    () => declareConnector({
      connectorId: 'c', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['repo:read'], policy: 'allow-once' }],
    }),
    CONNECTOR_CODES.BAD_POLICY,
  )
  throwsCode(() => github({ policy: 'allow-once' }), CONNECTOR_CODES.BAD_POLICY)
})

// ---------------------------------------------------------------------------
// ④ ★★★ 密钥只许引用
// ---------------------------------------------------------------------------

test('④ ★★★ 声明里出现凭证**值** ⇒ 报错（登记表要进 Git）', () => {
  const err = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'http', url: 'https://x',
      tools: [{ name: 't', capabilities: ['repo:read'] }],
      token: 'ghp_abc123',
    }),
    CONNECTOR_CODES.SECRET_VALUE_INLINE,
  )
  assert.match(err.message, /删不掉/)
  // 嵌套的也要抓到，并报出**路径**。
  const nested = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'http', url: 'https://x',
      tools: [{ name: 't', capabilities: ['repo:read'] }],
      description: { deep: [{ apiKey: 'x' }] },
    }),
    CONNECTOR_CODES.SECRET_VALUE_INLINE,
  )
  assert.match(nested.message, /\$\.description\.deep\[0\]\.apiKey/)
  // 键名大小写与下划线都要认。
  for (const k of ['api_key', 'API_KEY', 'ClientSecret', 'connection_string']) {
    throwsCode(
      () => declareConnector({
        connectorId: 'c1', transport: 'http', url: 'https://x',
        tools: [{ name: 't', capabilities: ['repo:read'] }],
        description: { [k]: 'v' },
      }),
      CONNECTOR_CODES.SECRET_VALUE_INLINE,
    )
  }
  assert.equal(FORBIDDEN_SECRET_KEYS.includes('token'), true)
  assert.equal(FORBIDDEN_SECRET_KEYS.includes('connectionstring'), true)
})

test('④ ★★★ 引用要对得上号：缺的引用必须能报出来', () => {
  const c = github({ secretRefs: ['mcp.github.token', 'mcp.github.missing'] })
  // 没传解析器时**不假设**有效也不假设无效，而是明说"这一层没查"。
  const blind = createRegistry({ connectors: [c] })
  const s = blind.secretStatus('github')
  assert.equal(s.checked, false)
  assert.equal(s.resolvable, null, '"没查"不能报成 true')
  assert.deepEqual(s.refs, ['mcp.github.token', 'mcp.github.missing'])
  // 传了解析器 ⇒ 缺的那个被点名。
  const r = createRegistry({ connectors: [c], resolveSecretRef: (n) => n === 'mcp.github.token' })
  const s2 = r.secretStatus('github')
  assert.equal(s2.checked, true)
  assert.equal(s2.resolvable, false)
  assert.deepEqual(s2.missing, ['mcp.github.missing'])
  // 全部齐了 ⇒ resolvable true、missing 空。
  const r2 = createRegistry({ connectors: [github()], resolveSecretRef: () => true })
  assert.deepEqual(r2.secretStatus('github').missing, [])
  assert.equal(r2.secretStatus('github').resolvable, true)
  // 解析器抛 ⇒ 按"拿不到"处理（fail closed），不是当成有。
  const r3 = createRegistry({ connectors: [github()], resolveSecretRef: () => { throw new Error('库挂了') } })
  assert.deepEqual(r3.secretStatus('github').missing, ['mcp.github.token'])
})

test('④ ★★★ 闸门版：缺密钥时**在调用之前**抛（诊断版只报告，不抛）', () => {
  const c = github({ secretRefs: ['mcp.github.token', 'mcp.github.missing'] })
  const r = createRegistry({ connectors: [c], resolveSecretRef: (n) => n === 'mcp.github.token' })
  // 诊断版：能一次说完**哪几个**有问题，所以它不抛。
  assert.equal(r.secretStatus('github').resolvable, false)
  // 闸门版：抛，且说清"别去查那个连接器"。
  const err = throwsCode(() => r.assertSecretsResolvable('github'), CONNECTOR_CODES.SECRET_REF_MISSING)
  assert.match(err.message, /在调用之前停下/)
  assert.match(err.message, /空字符串/)
  assert.match(err.message, /没问题的连接器/)
  // 齐了就不抛。
  const ok = createRegistry({ connectors: [github()], resolveSecretRef: () => true })
  assert.equal(ok.assertSecretsResolvable('github').resolvable, true)
  // ★ 没传解析器时**不装作查过了**：闸门也不抛（"没查"不等于"缺"）。
  const blind = createRegistry({ connectors: [github()] })
  assert.equal(blind.assertSecretsResolvable('github').checked, false)
  throwsCode(() => ok.assertSecretsResolvable('ghost'), CONNECTOR_CODES.UNKNOWN_CONNECTOR)
})

test('④ ★★ 解析器每个引用**只调一次**（有状态解析器会给两个答案）', () => {
  let calls = 0
  const r = createRegistry({
    connectors: [github()],
    resolveSecretRef: () => { calls += 1; return true },
  })
  r.secretStatus('github')
  assert.equal(calls, 1, `解析器被调了 ${calls} 次——两次之间可能给出不同答案`)
  void r.secretReport()
})

test('④ ★ 空引用名被拒；重复引用去重', () => {
  throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'http', url: 'https://x',
      tools: [{ name: 't', capabilities: ['repo:read'] }],
      secretRefs: ['  '],
    }),
    CONNECTOR_CODES.BAD_DECLARATION,
  )
  const c = github({ secretRefs: ['a', 'a', 'b'] })
  assert.deepEqual(c.secretRefs, ['a', 'b'])
})

// ---------------------------------------------------------------------------
// ⑤ ★★★ 故障隔离
// ---------------------------------------------------------------------------

test('⑤ ★★★ 连续失败到阈值 ⇒ 开路，且开路**带截止时间**', () => {
  let t = 1000
  const r = createRegistry({ connectors: [github()], now: () => t })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    r.recordOutcome({ connectorId: 'github', ok: false, error: `e${i}` })
  }
  const c = r.circuit('github')
  assert.equal(c.state, 'open')
  assert.equal(c.consecutiveFailures, CIRCUIT_FAILURE_THRESHOLD)
  // ★ 不带截止时间时，一次临时故障会变成**永久**停用，
  //   而"永久"与"临时"在状态读数上长得一样。
  assert.equal(c.untilMs, 1000 + CIRCUIT_COOLDOWN_MS)
  assert.equal(c.openedAtMs, 1000)
  // 开路期间判定是 deny，且**不重试**。
  const d = r.decide({ connectorId: 'github', toolName: 'list_issues' })
  assert.equal(d.decision, 'deny')
  assert.equal(d.code, CONNECTOR_CODES.CIRCUIT_OPEN)
  assert.equal(d.untilMs, c.untilMs)
  assert.match(d.reason, /别再打了/)
})

test('⑤ ★★★ 冷却到点 ⇒ 半开，且**只放一个探针**', () => {
  let t = 1000
  const r = createRegistry({ connectors: [github()], now: () => t })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r.recordOutcome({ connectorId: 'github', ok: false })
  t += CIRCUIT_COOLDOWN_MS
  // 第一个请求：成为探针（ask，且带 probe 标记）。
  const probe = r.decide({ connectorId: 'github', toolName: 'list_issues' })
  assert.equal(probe.decision, 'ask')
  assert.equal(probe.probe, true)
  assert.equal(r.circuit('github').state, 'half-open')
  // ★ 第二个请求：被拒。
  //   放所有排队请求过去时，探针这一步本身就在打你正在保护的那个东西——
  //   而"熔断"的整个意义是减少对它的压力。
  const second = r.decide({ connectorId: 'github', toolName: 'list_issues' })
  assert.equal(second.decision, 'deny')
  assert.equal(second.code, CONNECTOR_CODES.CIRCUIT_OPEN)
  assert.match(second.reason, /只放一个探针/)
})

test('⑤ ★★★ 半开探针失败 ⇒ 立刻回到开路**并重新计时**', () => {
  let t = 1000
  const r = createRegistry({ connectors: [github()], now: () => t })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r.recordOutcome({ connectorId: 'github', ok: false })
  t += CIRCUIT_COOLDOWN_MS
  r.decide({ connectorId: 'github', toolName: 'ping' })     // 放探针
  r.recordOutcome({ connectorId: 'github', ok: false, error: 'still down' })
  const c = r.circuit('github')
  assert.equal(c.state, 'open')
  // ★ 必须**重新**计时。不重新计时的话，冷却窗口会随着每次失败被"用掉"，
  //   于是探针越来越密——正好与熔断的目的相反。
  assert.equal(c.untilMs, t + CIRCUIT_COOLDOWN_MS)
  assert.equal(c.probeInFlight, false, '探针已经结束，不该还挂着')
})

test('⑤ ★★ 探针成功 ⇒ 回到 closed 并清零', () => {
  let t = 1000
  const r = createRegistry({ connectors: [github()], now: () => t })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r.recordOutcome({ connectorId: 'github', ok: false })
  t += CIRCUIT_COOLDOWN_MS
  r.decide({ connectorId: 'github', toolName: 'ping' })
  r.recordOutcome({ connectorId: 'github', ok: true })
  const c = r.circuit('github')
  assert.equal(c.state, 'closed')
  assert.equal(c.consecutiveFailures, 0)
  assert.equal(c.untilMs, null)
  assert.equal(r.decide({ connectorId: 'github', toolName: 'list_issues' }).decision, 'allow')
})

test('⑤ ★★★ 一个连接器失败**不牵连**别的（隔离就是这一节的标题）', () => {
  const a = github()
  const b = declareConnector({
    connectorId: 'gitlab', transport: 'http', url: 'https://x',
    tools: [{ name: 'list_issues', capabilities: ['repo:read'] }],
  })
  let t = 1000
  const r = createRegistry({ connectors: [a, b], now: () => t })
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) r.recordOutcome({ connectorId: 'github', ok: false })
  // github 开路，gitlab 完全不受影响。
  assert.equal(r.circuit('github').state, 'open')
  assert.equal(r.circuit('gitlab').state, 'closed')
  assert.equal(r.decide({ connectorId: 'gitlab', toolName: 'list_issues' }).decision, 'allow')
  assert.equal(r.decide({ connectorId: 'github', toolName: 'list_issues' }).code, CONNECTOR_CODES.CIRCUIT_OPEN)
  // 健康读数里点名的是**哪一个**开路，而不是"有故障"这一个布尔。
  const h = r.health()
  assert.deepEqual(h.openCircuits, ['github'])
  assert.equal(h.counts.unknown, 1, 'gitlab 一次都没探过')
  assert.equal(h.allHealthy, false)
  void t
})

test('⑤ ★★★ `unknown` 健康 ≠ healthy（"从没成功过"与"一直很好"相反）', () => {
  const r = createRegistry({ connectors: [github()] })
  const h = r.health()
  assert.equal(h.connectors[0].health, 'unknown')
  assert.equal(h.counts.unknown, 1)
  assert.equal(h.counts.healthy, 0)
  // ★ 只要有一个 unknown，整体就**不能**报"全部健康"。
  assert.equal(h.allHealthy, false, '"从没探过"被读成"一切正常"是最坏的那种读数')
  // 探过之后才叫 healthy。
  r.recordOutcome({ connectorId: 'github', ok: true })
  assert.equal(r.health().connectors[0].health, 'healthy')
  assert.equal(r.health().allHealthy, true)
  // 失败一次（还没到阈值）⇒ unhealthy，但熔断还是 closed。
  r.recordOutcome({ connectorId: 'github', ok: false, error: 'boom' })
  const h2 = r.health()
  assert.equal(h2.connectors[0].health, 'unhealthy')
  assert.equal(h2.connectors[0].circuit, 'closed')
  assert.equal(h2.connectors[0].lastError, 'boom')
  assert.equal(h2.allHealthy, false)
  assert.deepEqual(h2.openCircuits, [])
})

test('⑤ 熔断状态词表封闭', () => {
  assert.deepEqual([...CIRCUIT_STATES], ['closed', 'open', 'half-open'])
  // 阈值与冷却都是正数且是常量（改动它们会改变故障行为，需要被看到）。
  assert.equal(CIRCUIT_FAILURE_THRESHOLD > 0, true)
  assert.equal(CIRCUIT_COOLDOWN_MS > 0, true)
})

// ---------------------------------------------------------------------------
// ⑥ 声明的形状
// ---------------------------------------------------------------------------

test('⑥ ★★ 通配符工具名被拒（`*` 与"认真列了每一条"判定结果一样）', () => {
  for (const name of ['*', '**', 'ANY', 'all']) {
    const err = throwsCode(
      () => declareConnector({
        connectorId: 'c1', transport: 'stdio', command: 'x',
        tools: [{ name, capabilities: ['repo:read'] }],
      }),
      CONNECTOR_CODES.WILDCARD_TOOL,
    )
    assert.match(err.message, /出事后才分得开/)
  }
})

test('⑥ ★★ 工具重复声明被拒（后一条会遮蔽前一条）', () => {
  const err = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'stdio', command: 'x',
      tools: [
        { name: 't', capabilities: ['repo:read'] },
        { name: 't', capabilities: ['repo:push'] },
      ],
    }),
    CONNECTOR_CODES.TOOL_DUPLICATE,
  )
  assert.match(err.message, /遮蔽/)
})

test('⑥ ★★ 没有工具 / 连接器 id 重复声明都被拒', () => {
  // 一个"没有工具"的连接器与一个"工具列表没读到"的连接器长得一样。
  const err = throwsCode(
    () => declareConnector({ connectorId: 'c1', transport: 'stdio', command: 'x', tools: [] }),
    CONNECTOR_CODES.NO_TOOLS,
  )
  assert.match(err.message, /没读到/)
  // id 重复 ⇒ 后一条遮蔽前一条。
  const dup = throwsCode(
    () => createRegistry({ connectors: [github(), github({ policy: 'deny' })] }),
    CONNECTOR_CODES.BAD_ID,
  )
  assert.match(dup.message, /静默失效/)
})

test('⑥ ★★ 传输方式与目标必须配套', () => {
  const c = (o) => declareConnector({
    connectorId: 'c1', transport: 'stdio', command: 'x',
    tools: [{ name: 't', capabilities: ['repo:read'] }], ...o,
  })
  // stdio 要 command。
  const e1 = throwsCode(() => c({ command: '' }), CONNECTOR_CODES.BAD_TRANSPORT_TARGET)
  assert.match(e1.message, /必须给 command/)
  // http/sse 要 url。
  throwsCode(() => c({ transport: 'http', command: 'x' }), CONNECTOR_CODES.BAD_TRANSPORT_TARGET)
  throwsCode(() => c({ transport: 'sse' }), CONNECTOR_CODES.BAD_TRANSPORT_TARGET)
  // 不认识的传输方式。
  throwsCode(() => c({ transport: 'grpc' }), CONNECTOR_CODES.BAD_TRANSPORT)
  assert.deepEqual([...CONNECTOR_TRANSPORTS], ['stdio', 'http', 'sse'])
})

test('⑥ ★ 连接器 id 限制成安全字符（它要进日志、指标与 URL）', () => {
  for (const id of ['', '  ', 'a/b', 'a b', 'a#b']) {
    throwsCode(
      () => declareConnector({
        connectorId: id, transport: 'stdio', command: 'x',
        tools: [{ name: 't', capabilities: ['repo:read'] }],
      }),
      id.trim() === '' ? CONNECTOR_CODES.BAD_ID : CONNECTOR_CODES.BAD_ID,
    )
  }
  // 合法的照常过。
  for (const id of ['a', 'a.b', 'a_b', 'a-b', 'A1']) {
    const c = declareConnector({
      connectorId: id, transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['repo:read'] }],
    })
    assert.equal(c.connectorId, id)
  }
})

// ---------------------------------------------------------------------------
// ⑦ 结构级
// ---------------------------------------------------------------------------

test('⑦ ★★★ 本模块**没有**"从外部改策略 / 改声明"的出口', () => {
  const src = readFileSync(join(HERE, 'registry.mjs'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  // 声明来自 declareConnector，且返回冻结对象。有 setter 时，
  // "这个工具的策略是什么"就变成一个可以被运行期改掉的东西——
  // 而审计要看的正是"当时它是什么"。
  for (const banned of ['setPolicy', 'setRisk', 'updateConnector', 'removeConnector', 'deleteConnector']) {
    assert.equal(code.includes(banned), false, `出现了 ${banned}`)
  }
  assert.match(code, /Object\.freeze/)
  // 熔断推进必须**按连接器**取（隔离）。
  assert.match(code, /circuits\.get\(id\)/)
  // 开路必须写 untilMs（见 ⑤ 的用例）。
  assert.match(src, /circuit\.untilMs = t \+ CIRCUIT_COOLDOWN_MS/)
})

test('⑦ ★★ 声明是冻结的，且工具清单不可改', () => {
  const c = github()
  assert.equal(Object.isFrozen(c), true)
  assert.equal(Object.isFrozen(c.tools), true)
  assert.equal(Object.isFrozen(c.tools[0]), true)
  assert.equal(Object.isFrozen(c.secretRefs), true)
  assert.equal(Object.isFrozen(c.tools[0].capabilities), true)
  // 改不动（严格模式下赋值抛）。
  assert.throws(() => { 'use strict'; c.policy = 'deny' })
  assert.equal(c.policy, 'allow')
})

test('⑦ ★ 登记表的读数都是冻结的', () => {
  const r = createRegistry({ connectors: [github()] })
  assert.equal(Object.isFrozen(r), true)
  assert.equal(Object.isFrozen(r.connectors()), true)
  assert.equal(Object.isFrozen(r.toolNames()), true)
  assert.equal(Object.isFrozen(r.health()), true)
  assert.equal(Object.isFrozen(r.health().counts), true)
  assert.equal(Object.isFrozen(r.health().connectors[0]), true)
  assert.equal(Object.isFrozen(r.decide({ connectorId: 'github', toolName: 'ping' })), true)
  assert.equal(r.version, CONNECTOR_REGISTRY_VERSION)
})

test('⑦ ★ 每个码都至少被一个用例触达', () => {
  const src = readFileSync(join(HERE, 'registry.mjs'), 'utf8')
  const declared = [...src.matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1])
  const testSrc = readFileSync(join(HERE, 'registry.test.mjs'), 'utf8')
  const unreachable = declared.filter((n) => !testSrc.includes(`CONNECTOR_CODES.${n}`))
  assert.deepEqual(unreachable, [], `这些码没有用例触达：${unreachable.join(', ')}`)
})

test('⑦ ★ 工具名清单按连接器分域（`connector::tool`）', () => {
  const r = createRegistry({ connectors: [github()] })
  const names = r.toolNames()
  assert.equal(names.includes('github::ping'), true)
  assert.equal(names.includes('github::list_issues'), true)
  assert.equal(names.length, 4)
  // 名字里带 `::` 时不能与"别的连接器的工具"混起来。
  assert.equal(names.every((n) => n.startsWith('github::')), true)
})

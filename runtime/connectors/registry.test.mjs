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
  FORBIDDEN_SECRET_KEYS, TOOL_DECLARATION_KEYS, declareConnector, createRegistry,
  declaredToolNames,
} from './registry.mjs'
import { publicToolName } from './public-name.mjs'

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

// ---------------------------------------------------------------------------
// ①b ★★★ 线上来的名字是 DSH 的**公开名**，不是声明里那个裸名
// ---------------------------------------------------------------------------

test('①b ★★★ 声明写裸名、调用用**公开名** ⇒ 按声明的策略判定（不是"未声明"）', () => {
  // ★ 第 17 轮实测到的缺口：DSH 注册 MCP 工具时用的是
  //   `mcp__<serverName>__<rawName>`（`packages/mcp/mcp-client/src/tools.ts`），
  //   而声明里写的是连接器**自己那一侧**的名字。
  //
  //   > 一个"声明写裸名、判定按裸名比"的登记表，
  //   > 与一个"声明根本对不上任何一次真调用"的登记表，
  //   > 在**套件读数**上是同一片 ✔——只不过前者从来没验过
  //   > "DSH 真的会送来的那个名字"。
  const r = createRegistry({ connectors: [github()] })
  const raw = r.decide({ connectorId: 'github', toolName: 'list_issues' })
  const wire = r.decide({ connectorId: 'github', toolName: publicToolName('github', 'list_issues') })
  assert.equal(wire.decision, raw.decision,
    '公开名与裸名的判定不一致 ⇒ 一个**正确声明过**的工具在真部署里会被拒')
  assert.equal(wire.decision, 'allow')
  assert.equal(wire.risk, raw.risk, '两条名字必须给出同一个有效风险')
  assert.equal(wire.toolName, 'mcp__github__list_issues', '报出来的应当是**线上那个**名字')
  // ★ 工具级 deny 也要照旧生效（不是"公开名一律 allow"）
  assert.equal(r.decide({ connectorId: 'github', toolName: publicToolName('github', 'delete_branch') }).decision, 'deny')
})

test('①c ★★★ 头号教义**仍然成立**：未声明的公开名还是 deny（少这条，①b 可能只是"全放行"）', () => {
  // 没有这一条，①b 可以被一个"把公开名一律当已声明"的实现骗过去。
  const r = createRegistry({ connectors: [github()] })
  const d = r.decide({ connectorId: 'github', toolName: publicToolName('github', 'delete_repo') })
  assert.equal(d.decision, 'deny', '在连接器命名空间里但**没声明过**的工具必须拒')
  assert.equal(d.code, CONNECTOR_CODES.UNKNOWN_TOOL)
  assert.match(d.reason, /后门/)
  // ★ 而它与"裸名未声明"是**同一条**码——两条路都走 `UNKNOWN_TOOL`。
  assert.equal(r.decide({ connectorId: 'github', toolName: 'delete_repo' }).code, CONNECTOR_CODES.UNKNOWN_TOOL)
})

test('①d ★★ 归属面（`attributeTool` / `connectorForTool`）也认公开名', () => {
  const r = createRegistry({ connectors: [github()] })
  const wire = publicToolName('github', 'list_issues')
  assert.equal(r.connectorForTool(wire), 'github')
  assert.deepEqual({ ...r.attributeTool(wire) },
    { state: 'unique', toolName: wire, connectorId: 'github', candidates: ['github'] })
  // 未声明的公开名归属不到（`none`，不是 `unique`）——
  // 归属面必须与判定面给出**同一个**答案，否则桥会把调用送给一个不认它的连接器。
  assert.equal(r.attributeTool(publicToolName('github', 'delete_repo')).state, 'none')
})

test('①e ★★★ 推导出来的名字**不进**声明体（推导值不落盘）', () => {
  // ★ 存一份 `wireName` 会让它变成"又一份记录"：命名规则一变，声明里那一份
  //   就成了**过期的事实**，而它看起来像作者写下的内容。这与文件头 ② 删掉
  //   `risk` 是同一条纪律。
  const decl = github()
  for (const t of decl.tools) {
    assert.deepEqual(Object.keys(t).sort(),
      ['capabilities', 'declaredRisk', 'name', 'policy', 'risk', 'riskFloor', 'riskRaised'],
      `工具「${t.name}」的字段集变了——若新加的是**推导值**，它不该存进声明`)
    assert.equal(t.wireName, undefined)
    assert.equal(t.publicName, undefined)
  }
  // 而 `declaredToolNames` **算**得出来
  assert.deepEqual([...declaredToolNames('github', 'list_issues')],
    ['list_issues', 'mcp__github__list_issues'])
})

test('①f ★★ `declaredToolNames` 的契约：冻结、去重、空名给空表', () => {
  const two = declaredToolNames('github', 'list_issues')
  assert.ok(Object.isFrozen(two))
  assert.equal(two.length, 2)
  // 空 id ⇒ 算不出公开名 ⇒ **只有**裸名（不吞成空表，也不抛）
  assert.deepEqual([...declaredToolNames('', 'x')], ['x'])
  assert.deepEqual([...declaredToolNames('github', '')], [])
  assert.deepEqual([...declaredToolNames(null, null)], [])
  // 名字**已经**是公开名时，公开名那个分支与裸名相同 ⇒ 去重成一条
  const already = declaredToolNames('github', 'mcp__github__x')
  assert.equal(already.length, 2, '`mcp__github__mcp__github__x` 与裸名不同 ⇒ 仍然是两条')
  assert.equal(already[0], 'mcp__github__x')
  assert.equal(already[1], 'mcp__github__mcp__github__x')
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

test('② ★★★ 工具声明里多写 `risk` ⇒ 具名拒（它是**输出**字段，静默忽略会让最严声明消失）', () => {
  // ── 先钉住那个"静默"本身：`declaredRisk` 才有效。
  const withDeclared = createRegistry({
    connectors: [{
      connectorId: 'c1', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['repo:read'], declaredRisk: 'critical', policy: 'allow' }],
    }],
  })
  const d1 = withDeclared.decide({ connectorId: 'c1', toolName: 't' })
  assert.equal(d1.risk, 'critical', '前提：declaredRisk 确实被读到')
  assert.equal(d1.decision, 'ask', '前提：critical 风险必须问人')

  // ── 关键：写 `risk` 必须**拒**，而不是被丢掉。
  //
  //   修之前，下面这条声明会建出一个 `risk: 'low'`（能力下限）的连接器，
  //   `decide()` 答 allow —— 作者明确标了 critical 的工具被自动放行，
  //   而且没有任何一处报错。
  const err = throwsCode(
    () => declareConnector({
      connectorId: 'c1', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['repo:read'], risk: 'critical' }],
    }),
    CONNECTOR_CODES.BAD_DECLARATION,
  )
  assert.match(err.message, /declaredRisk/, '理由必须告诉作者要写哪个字段名')
  assert.match(err.message, /输出/, '理由必须点破"它是输出字段"这件事')

  // ★ 反向对照：四个**合法**键一个都不许被误伤。
  const ok = declareConnector({
    connectorId: 'c2', transport: 'stdio', command: 'x',
    tools: [{ name: 't', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'ask' }],
  })
  assert.equal(ok.tools.length, 1)
  // 反向对照②：**不给** `declaredRisk`（合法，落回能力下限）也不许被误伤。
  assert.equal(declareConnector({
    connectorId: 'c3', transport: 'stdio', command: 'x',
    tools: [{ name: 't', capabilities: ['repo:read'] }],
  }).tools[0].risk, 'low')

  // 其它拼错的键名也一样拒（不只 `risk` 这一个名字）。
  const other = throwsCode(
    () => declareConnector({
      connectorId: 'c4', transport: 'stdio', command: 'x',
      tools: [{ name: 't', capabilities: ['repo:read'], declaredrisk: 'critical' }],
    }),
    CONNECTOR_CODES.BAD_DECLARATION,
  )
  assert.match(other.message, /declaredrisk/, '大小写写错也是一种"看起来生效、实际没生效"')

  // ★ 键集本身是冻结的契约：它必须恰好是这四个。
  assert.deepEqual([...TOOL_DECLARATION_KEYS].sort(), ['capabilities', 'declaredRisk', 'name', 'policy'])
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

// ── §5 第 22 条（2026-09-24 裁决采 ①「声明写裸名」）的判据 ────────────────────
//
// 约定本身不是功能约束（两种写法都工作），所以这一组盯的是**约定的两端**：
//   ① **裸名必须能推导出公开名**（否则"写裸名"这条约定会让合法调用被拒）；
//   ② **同一份声明里两种写法各写一遍**必须在**装配期**被拒（判定期它们指向同一个工具）。

test('①g ★★★ 同一份声明里既写裸名、又写它的公开名 ⇒ 装配期就拒', () => {
  assert.throws(
    () => declareConnector({
      connectorId: 'github',
      transport: 'stdio',
      command: 'npx mcp-github',
      tools: [
        { name: 'list_issues', capabilities: ['network:read'] },
        { name: 'mcp__github__list_issues', capabilities: ['network:read'] },
      ],
    }),
    (err) => err.code === CONNECTOR_CODES.TOOL_DUPLICATE,
    '两行声明会在判定期同时认领同一次调用 —— 只比 t.name 的重复检查看不见它',
  )
})

test('①h ★ 约定可行：全裸名的声明 ⇒ 通过，且公开名**算得出来**', () => {
  const d = declareConnector({
    connectorId: 'github',
    transport: 'stdio',
    command: 'npx mcp-github',
    tools: [{ name: 'list_issues', capabilities: ['network:read'] }],
  })
  assert.equal(d.tools[0].name, 'list_issues', '声明里存的是**作者写下的那个名字**')
  assert.deepEqual([...declaredToolNames('github', 'list_issues')],
    ['list_issues', 'mcp__github__list_issues'],
    '★ 这条约定的可行性就靠这一步：写裸名，公开名由登记表换算')
})

test('①i ★ 如实：只写**公开名**的声明今天仍然被接受（约定是约定，不是硬约束）', () => {
  const d = declareConnector({
    connectorId: 'github',
    transport: 'stdio',
    command: 'npx mcp-github',
    tools: [{ name: 'mcp__github__list_issues', capabilities: ['network:read'] }],
  })
  assert.equal(d.tools[0].name, 'mcp__github__list_issues')
  // 而且它**真的**能匹配线上送来的那个名字 —— 所以这不是"坏的"，只是**不合约定**。
  assert.ok(declaredToolNames('github', 'mcp__github__list_issues').includes('mcp__github__list_issues'))
})

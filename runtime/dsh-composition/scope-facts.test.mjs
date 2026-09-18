// runtime/dsh-composition/scope-facts.test.mjs
// ============================================================================
// PRT-605 / 第 19 轮：执行面事实表（`scope-facts.mjs`）的判据。
//
// 这一套守的是一件**读不出来**的事：事实是**算一次**的还是**算六次**的。
// 六处各自兜底"今天恰好一致"，用例全绿——因为写它们的是同一个人、同一天。
// 所以下面几条不是在验"值对不对"，是在验**值的来源只有一个**。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCOPE_FACTS_CODES, SCOPE_FACTS_VERSION, SCOPE_FACT_ARGUMENTS,
  SCOPE_FACT_CAPABILITY_KIND, SCOPE_FACT_KINDS, GENERIC_FACT_ARGUMENTS,
  deriveScopeFacts,
} from './scope-facts.mjs'
import { TARGET_ARGUMENTS, GENERIC_TARGET_ARGUMENTS } from './tool-request.mjs'
import { CAPABILITY_IDS } from './tool-capability.mjs'

test('① 一张表决定"这次调用是哪一类"：能力 → 类别是满射，且不认识的**不**落进任何一类', () => {
  // ①a：`SCOPE_FACT_CAPABILITY_KIND` 的每个值都必须是 `SCOPE_FACT_KINDS` 之一。
  //    （一个拼错的类别会静静地造出一类永远不成立的检查。）
  for (const [cap, kind] of Object.entries(SCOPE_FACT_CAPABILITY_KIND)) {
    assert.ok(SCOPE_FACT_KINDS.includes(kind), `${cap} → ${kind} 不在 SCOPE_FACT_KINDS 里`)
    assert.ok(CAPABILITY_IDS.includes(cap), `${cap} 不是已知能力——能力表加了一条而这张表没跟`)
  }

  // ①b：四条"出去做事"的通道**都**有归属。
  for (const kind of SCOPE_FACT_KINDS) {
    assert.ok(Object.values(SCOPE_FACT_CAPABILITY_KIND).includes(kind),
      `类别 ${kind} 没有任何能力指向它——那是一类永远不触发的检查`)
  }

  // ①c ★ 反向：不出去做事的能力**不许**出现在这张表里。
  //    一个把 `file:read` 也映射成 `command` 的笔误，会让每个读文件都去过命令白名单。
  for (const cap of ['file:read', 'file:write', 'repo:read', 'credential:read', 'message:send']) {
    assert.equal(SCOPE_FACT_CAPABILITY_KIND[cap], undefined,
      `${cap} 不该产生执行面事实——它由别的强制点管（路径/白名单/政策）`)
  }

  // ①d：`deriveScopeFacts` 对纯文件调用给 `null`（"与执行面无关"）。
  assert.equal(deriveScopeFacts({
    capabilities: ['file:read'], args: { path: 'C:/work/a.txt' }, toolName: 'read-file', known: true,
  }), null, 'file:read 不该产生执行面事实')
})

test('② ★★★ 参数名表与投影自己那张表**同源**：共同能力上不许给出两个字段名', () => {
  // 这是本套件里唯一能防"两张表悄悄漂移"的判据。
  //   > 一个「两张表各自维护、今天恰好一致」的实现，
  //   > 与一个「两张表已经不一致、而恰好没有任何用例同时碰到两边」的实现，
  //   > 在**所有**现有用例上都是绿的。
  const shared = Object.keys(SCOPE_FACT_ARGUMENTS).filter((c) => TARGET_ARGUMENTS[c] !== undefined)
  assert.ok(shared.length >= 6, `共同能力太少（${shared.length}）——判据失去对象`)

  for (const cap of shared) {
    const facts = SCOPE_FACT_ARGUMENTS[cap]
    const target = TARGET_ARGUMENTS[cap]
    // 事实表里的 `url` 与目标表里的对应项必须**有交集**：同一个参数名不能被两处
    // 用两个不同的拼法认出来。
    for (const [field, names] of Object.entries(facts)) {
      if (Array.isArray(names) === false) continue
      if (field !== 'url' && field !== 'argv') continue
      const overlap = names.filter((n) => target.includes(n))
      assert.ok(overlap.length > 0,
        `${cap} 的 ${field} 与 TARGET_ARGUMENTS 在同一个参数上给出两个名字：`
        + `事实=${JSON.stringify(names)} 目标=${JSON.stringify(target)}`)
    }
  }
})

test('③ ★★ 缺席与"空"是两件事：没这个能力给 null，能力在而值是空是**另**一条事实', () => {
  // ③a：没这个能力 ⇒ `deriveScopeFacts` 返回 `null`。
  assert.equal(deriveScopeFacts({ capabilities: ['repo:read'], args: { path: 'a' }, toolName: 'git-status' }), null)

  // ③b ★★★：能力在而**没给值** ⇒ 事实**存在**，且值明确是 `null`。
  //    这正是"必须被拒绝"的形状：不能读成"与命令无关"。
  const f = deriveScopeFacts({ capabilities: ['command:exec'], args: {}, toolName: 'run-command' })
  assert.notEqual(f, null, '声明了 command:exec 却没给命令——不许读成"与执行面无关"')
  assert.deepEqual([...f.kinds], ['command'])
  assert.equal(f.command.argv, null, '没给命令时 `argv` 必须是显式的 null，不是 undefined')
  assert.equal(f.command.from, null)

  // ③c：`argv: []`（空数组）也是"给了值"，与"没给"不同——判定器会各自拒，理由不同。
  const g = deriveScopeFacts({ capabilities: ['command:exec'], args: { argv: [] }, toolName: 'run-command' })
  assert.deepEqual(g.command.argv, [])
  assert.equal(g.command.from, 'argv')
})

test('④ ★★★ 未登记工具按**参数证据**反推——"换个没登记的名字"不许绕过执行面', () => {
  // 这是本批**实测到的洞**：未登记工具能力集为空 ⇒ 按能力查表得 `null`
  // ⇒ 端口"无话可说" ⇒ 放行。而投影里同一处 `resolveTool` 对它的处置是 fail closed。
  const unknown = (args) => deriveScopeFacts({
    capabilities: [], args, toolName: 'brand-new-tool', known: false,
  })

  // ④a：`command` 证据 ⇒ 落进 command 那一类。
  const c = unknown({ command: ['rm', '-rf', '/'] })
  assert.notEqual(c, null, '未登记工具带 command 参数却不产生事实——"换个名字"就能绕过执行面')
  assert.deepEqual([...c.kinds], ['command'])
  assert.equal(c.generic, true, '必须标出它是按证据反推的（generic），而不是按能力')

  // ④b ★★：`url` 证据 ⇒ **两类都记**（network + external-api）。
  //    从参数上看不出它要走哪张授权表；两张都过是更严的方向。
  //      > 一个「按参数猜它要走哪张表」的检查，
  //      > 与一个「猜错了就少过一道」的检查，是同一个东西。
  const n = unknown({ url: 'https://example.com/x' })
  assert.deepEqual([...n.kinds].sort(), ['external-api', 'network'],
    '未登记工具的网络调用必须同时过网络与外部 API 两张表')
  assert.equal(n.network.url, 'https://example.com/x')
  assert.equal(n.externalApi.url, 'https://example.com/x')

  // ④c：`server` + `tool` 证据 ⇒ MCP 那一类。
  const m = unknown({ server: 'github', tool: 'list_issues' })
  assert.deepEqual([...m.kinds], ['mcp'], '成对的 server/tool 参数必须认成 MCP 调用')

  // ④d：`mcp__` 公开名本身也是证据（工具名自己就说了）。
  const m2 = deriveScopeFacts({ capabilities: [], args: {}, toolName: 'mcp__github__x', known: false })
  assert.notEqual(m2, null, '`mcp__` 开头的工具名没被认成 MCP —— 公开名是最直接的证据')
  assert.deepEqual([...m2.kinds], ['mcp'])

  // ④e ★★ 反向对照（这条比上面四条都重要）：未登记工具**没有**任何执行面证据
  //     ⇒ `null`。少了它，④a-d 可能只是"未登记工具一律落进所有类别"。
  assert.equal(unknown({ path: 'C:/work/a.txt' }), null,
    '未登记工具只带 path 参数时不该产生执行面事实——否则所有未登记工具调用都会被四张表各拒一次')

  // ④f ★★：**登记过的**工具不吃参数证据。一个声明了 `file:read` 的工具
  //    参数里带个 `url` 字段，不许被拿去按网络表判——
  //    那是拿**输入**去改写**声明**。
  const declared = deriveScopeFacts({
    capabilities: ['file:read'], args: { path: 'a', url: 'https://evil.example' }, toolName: 'read-file', known: true,
  })
  assert.equal(declared, null,
    '登记过的工具按**声明的能力**判，不吃参数证据——否则输入能改写声明')

  // ④g：`known` 缺省是 `true`（更严的那一边？不是——是不许"默认未知"）。
  //    ★ 这条钉的是一个**默认值的方向**：`known` 缺省 `false` 会让所有调用
  //      都去吃通用证据，而通用证据比声明**宽**。
  assert.equal(deriveScopeFacts({ capabilities: [], args: { url: 'https://x.example' }, toolName: 't' }), null,
    '`known` 不给时必须按"登记过"处理（以声明为准），而不是默认未知')
})

test('⑤ 通用候选名是投影那张通用表的**子集**——两处不许各写一套', () => {
  // 通用目标表（`GENERIC_TARGET_ARGUMENTS`）已经是"未登记工具可能拿哪些参数"的权威。
  // 本模块的通用事实表只能从它里面取，不能凭空多一个。
  for (const [field, names] of Object.entries(GENERIC_FACT_ARGUMENTS)) {
    for (const n of names) {
      assert.ok(GENERIC_TARGET_ARGUMENTS.includes(n),
        `通用事实表里的 ${field}:${n} 不在 GENERIC_TARGET_ARGUMENTS 里——`
        + '凭空多一个参数名等于凭空多一条永远不会被触发的检查')
    }
  }
})

test('⑥ 事实对象是冻结的，且 `sources` 记下了每个值取自哪个参数名（可归因）', () => {
  const f = deriveScopeFacts({
    capabilities: ['external-api:write'],
    args: { endpoint: 'https://api.example.com/v1', method: 'POST', body: '{}' },
    toolName: 'api-call',
  })
  assert.ok(Object.isFrozen(f))
  assert.ok(Object.isFrozen(f.sources))
  assert.equal(f.sources.url, 'endpoint', '要记得住它是从哪个名字取到的——否则同义名下取错值无人能查')
  assert.equal(f.sources.method, 'method')
  assert.equal(f.sources.body, 'body')
  assert.equal(f.version, SCOPE_FACTS_VERSION)

  // 坏输入**抛**（程序错误，不是"这次调用没有事实"）。
  assert.throws(() => deriveScopeFacts({ capabilities: 'file:read', args: {} }), (e) => e.code === SCOPE_FACTS_CODES.BAD_INPUT)
  assert.throws(() => deriveScopeFacts({ capabilities: [], args: null }), (e) => e.code === SCOPE_FACTS_CODES.BAD_INPUT)
})

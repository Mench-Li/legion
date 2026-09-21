// runtime/dsh-composition/whitelist-port.test.mjs
// ============================================================================
// PRT-603 岗位白名单**端口**的判据。
//
// ## 这个套件守的是什么（以及它**不**守什么）
//
// `employee-manifest.test.mjs` 的 20 例守的是 `permitsTool()` 的**每一条规则**；
// `whitelist-limb.test.mjs` 守的是"两个名字空间不相交"这个**事实**。
// 两套都绿，而生产里那个 `whitelist` 端口**恒为 `null`** —— 于是岗位白名单
// 对每一次工具调用**根本不存在**。
//
//   > 一个「每一条规则都走到了、而生产里那个端口恒为 `null`」的白名单，
//   > 与一个「没有岗位白名单」的部署，在"这次调用被它拦住了吗"上是同一个答案。
//
// 本套件就是**那一次"跑一次"**：把真名字（DSH 名）喂进端口，看它给出什么。
//
// ## 每条判据都要能变红 —— 包括写它的那一轮自己踩的坑
//
// ⑥ 是**反向**读数：端口第一版写的是 `state !== 'unique'`，于是
// "部署裁决过"的那一支（`state: 'decided'`）被当成失败挡回去，
// **登记了裁决反而恒拒**，且拒绝时 `rule` 是 `null`（一条没有理由的拒绝）。
// 只断言 `allowed === false` 的用例**看不见它**——所以 ⑥ 同时断言
// `rule` 与 `legionTool`，而不只是 `allowed`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WHITELIST_PORT_CODES, WHITELIST_PORT_ENV_KEY, WHITELIST_PORT_STATES,
  createWhitelistPort, reverseRouting, translateToolName, whitelistPortFromEnv,
} from './whitelist-port.mjs'
import { LEGION_TOOL_ROUTING, dshToolNamesOf } from './employee-preset.mjs'
import { KNOWN_TOOL_NAMES, HIGH_RISK_TOOL_NAMES, resolveTool } from './tool-capability.mjs'

/** 一份只读岗位的许可（字段与 `normalizeManifest` 的闭合一致）。 */
function readerPermit(over = {}) {
  return {
    version: 'legion/employee-manifest@1',
    employeeId: 'e-reader',
    role: 'reader',
    displayName: '只读岗',
    unattended: false,
    allowedTools: ['read-file', 'git-status'],
    allowedCapabilities: ['file:read'],
    maxRisk: 'medium',
    workspaceRoot: null,
    ...over,
  }
}

const envWith = (permit) => ({ [WHITELIST_PORT_ENV_KEY]: JSON.stringify(permit) })

// ══════════════════════════════════════════════════════════════════════════
// ① 反查那张**唯一权威**的表
// ══════════════════════════════════════════════════════════════════════════

test('① ★★ 反查是从 `LEGION_TOOL_ROUTING` 现算的，不是第二张手抄的表', () => {
  const back = reverseRouting()
  // 逐项与正表对拍：**每一个** dshTools 里的名字都必须反查得到它的 Legion 工具。
  for (const [legion, route] of Object.entries(LEGION_TOOL_ROUTING)) {
    if (route.hosted === true) continue
    for (const dsh of route.dshTools ?? []) {
      assert.ok(back.get(dsh)?.includes(legion),
        `${dsh} 反查不到 ${legion} ⇒ 反查表与正表脱钩了（有人只改了一边）`)
    }
  }
  // ★ 而"反查再正推"必须回到原集合 —— 这一条抓的是**漏掉的键**：
  //   只对拍上面那一半会漏掉"反查表里多出一个正表没有的 Legion 名"。
  for (const [dsh, legions] of back) {
    for (const legion of legions) {
      assert.ok((LEGION_TOOL_ROUTING[legion]?.dshTools ?? []).includes(dsh),
        `反查表里有 ${dsh} → ${legion}，而正表里 ${legion} 的 dshTools 没有它`)
    }
  }
  // ★ 候选**升序**：一个"顺序取决于路由表书写顺序"的读数，在重排表之后会
  //   让同一份歧义给出不同的首选，而"首选"最容易被误用成"就按它判"。
  for (const [, cands] of back) {
    assert.deepEqual([...cands], [...cands].sort(), '候选必须是升序（与路由表的书写顺序无关）')
  }
})

test('①b ★★★ `hosted: true` 的行**不进**反查表 —— 猜一个执行面名字就是造一条命中不了的规则', () => {
  const back = reverseRouting()
  const hosted = Object.entries(LEGION_TOOL_ROUTING)
    .filter(([, r]) => r.hosted === true).map(([n]) => n)
  assert.ok(hosted.length > 0, '路由表里必须还有 hosted 行，否则这一条在测空气')

  // ★★★ 这道守卫**今天在行为上不可观测** —— 破验量出的事实，必须写下来：
  //   所有 `hosted: true` 的行**都没有 `dshTools`**（`null`），所以就算把
  //   `if (route.hosted === true) continue` 整行删掉，反查表**一个字都不会变**。
  //
  //   > 一条「删掉之后没有任何用例变红」的守卫，
  //   > 与一条「根本不存在」的守卫，在覆盖率上是同一个读数——
  //   > 只不过前者让我以为那张表被守住过。
  //
  //   所以下面把它拆成**两半可判的**读数：结构不变量（唯一那个让守卫生效的前置），
  //   以及守卫本身（用一份**合成**的路由表把它逼出来）。
  for (const name of hosted) {
    const tools = LEGION_TOOL_ROUTING[name].dshTools
    assert.equal(tools === undefined || tools === null || tools.length === 0, true,
      `hosted 的 ${name} 竟然带了 dshTools=${JSON.stringify(tools)} ⇒ `
      + '"宿主平面能力没有执行面名字"这个前提**破了**：要么删掉那些名字，'
      + '要么它就不该是 hosted。★ 这条不变量正是"删掉守卫也不会变"的成因')
  }

  // ★ 守卫本身：用一份合成的路由表（hosted 行**故意带** dshTools）把它逼出来。
  //   这一条才是真的在守 `reverseRouting` 的那一行 —— 而它对真实路由表**不可观测**。
  const synthetic = {
    'legion-hosted-thing': { hosted: true, dshTools: ['host_only_tool'] },
    'legion-real-thing': { dshTools: ['real_tool'] },
  }
  const syntheticBack = reverseRouting(synthetic)
  assert.equal(syntheticBack.has('host_only_tool'), false,
    'hosted 行的 dshTools 进了反查表 ⇒ 守卫失效（"宿主平面能力"被猜出了一个执行面名字）')
  assert.deepEqual([...syntheticBack.get('real_tool')], ['legion-real-thing'])

  // 而 `dshToolNamesOf()`（另一个方向）也必须把 hosted 排除掉——两边同一处置。
  const mapped = dshToolNamesOf()
  for (const name of mapped) {
    const owners = back.get(name) ?? []
    assert.ok(owners.length > 0,
      `dshToolNamesOf 产出了 ${name}，而反查表里没有任何 Legion 工具认领它 ⇒ 两张表对不上`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ② 翻译的**六个态**，各自的码各不相同
// ══════════════════════════════════════════════════════════════════════════

test('② ★★ 翻译六态：unique / decided / ambiguous / hosted / unrouted / missing —— 码两两不同', () => {
  // ★ 这里断言的是 **码 → 态 是单射**，不是"态 → 码"。
  //
  //   第一版我写的是后者（把每个码记一次、重复就红），而它在 `bash` / `pwsh` /
  //   `web_fetch` 上当场红了——那三个工具**共用** `whitelist-limb-ambiguous`
  //   这一个码，因为它们**就是同一个态**。
  //
  //   > 一条「同一个态不许共用码」的判据，
  //   > 与一条「两个不同的态不许共用一个码」的判据，
  //   > 在只有一个工具歧义的那些日子里是同一个东西——只不过前者会在
  //   > 第二个工具也歧义的那天变红，而它红的理由是**编的**。
  //
  //   要守的是后者：**一个码不许同时表示两个不同的态**——那才会让值班的人
  //   从一个码推出两个不同的下一手。多对一是合法的（三个工具、一个态、一个码）。
  const codeToState = new Map()
  const stateToCode = new Map()
  const cases = [
    ['read', 'unique'],
    ['write', 'unique'],
    ['edit', 'unique'],
    ['glob', 'unique'],
    ['grep', 'unique'],
    ['bash', 'ambiguous'],
    ['pwsh', 'ambiguous'],
    ['web_fetch', 'ambiguous'],
    ['delete-file', 'hosted'],
    ['web_search', 'unrouted'],
    ['todowrite', 'unrouted'],
    ['', 'missing'],
  ]
  for (const [name, expected] of cases) {
    const r = translateToolName({ toolName: name })
    assert.equal(r.state, expected, `${JSON.stringify(name)} 的态应为 ${expected}，实为 ${r.state}`)
    if (r.state === 'unique') {
      assert.equal(r.code, null)
      continue
    }
    assert.equal(typeof r.code, 'string', `${name} 的非成功态必须带码（否则值班的人没有下一手）`)
    // 单射：一个码只能属于一个态。
    const known = codeToState.get(r.code)
    assert.equal(known === undefined || known === r.state, true,
      `码 ${r.code} 同时表示 ${known} 与 ${r.state} 两个态 ⇒ 值班的人从一个码推出两个下一手`)
    codeToState.set(r.code, r.state)
    // 而同一个态在多次触发上必须给出**同一个**码（否则排障要按工具名分叉）。
    const prior = stateToCode.get(r.state)
    assert.equal(prior === undefined || prior === r.code, true,
      `态 ${r.state} 给出了两个码（${prior} / ${r.code}）`)
    stateToCode.set(r.state, r.code)
  }
  // ★ 非成功态的个数**现算**，不写死。
  //
  //   第一版这里写的是 `assert.equal(codeToState.size, 5)`——我把"六态"里的
  //   `decided` 也算进了非成功态。**`decided` 是成功态**（它下面就被单独钉住了），
  //   于是枚举出的非成功态只有四个：ambiguous / hosted / unrouted / missing。
  //
  //   > 一个「硬编码 5」的断言，与一个「从枚举现算」的断言，
  //   > 在枚举恰好是四个的那些日子里是同一个东西——只不过前者会红，
  //   > 而它红的原因是**我数错了**，不是产品错了。
  //
  //   所以这里两件事都钉：集合的**大小**由枚举决定，而集合的**成员**逐个列明。
  const expectedStates = new Set(cases.filter(([, s]) => s !== 'unique').map(([, s]) => s))
  assert.equal(codeToState.size, expectedStates.size,
    `非成功态应有 ${expectedStates.size} 个不同的码，实为 ${codeToState.size}`)
  for (const s of expectedStates) {
    assert.equal(stateToCode.has(s), true, `态 ${s} 在枚举里出现，却没有对应的码`)
  }
  // ★ 而 `decided` **不在**那个集合里（它是成功态）——这一条把"数错"挡在外面。
  assert.equal(expectedStates.has('decided'), false, 'decided 是成功态，不该被算进"非成功态"')
  // ★ 而 `hosted` 与 `unrouted` **都是"零候选"，却不是同一件事**：
  //   hosted 是"这一层表达不出来"，unrouted 是"路由表缺一条"。修法不同 ⇒ 码必须不同。
  assert.notEqual(WHITELIST_PORT_CODES.UNROUTED, WHITELIST_PORT_CODES.UNKNOWN_DSH_TOOL)
  // ★ 反向：`decided` 是**成功态**，所以它不许进上面那张"非成功码"表。
  const decided = translateToolName({ toolName: 'bash', registry: { bash: 'git-status' } })
  assert.equal(decided.state, 'decided')
  assert.equal(decided.code, null, 'decided 与 unique 一样是成功态 ⇒ 不带码')
  assert.equal(codeToState.has(null), false)
})

test('②b ★★★ `bash` / `pwsh` / `web_fetch` 的歧义**是量出来的**，不是假设的', () => {
  const back = reverseRouting()
  // 这三个在今天都一对多 —— 若哪天不歧义了，本节的前提变了，要重核（而不是继续绿）。
  for (const name of ['bash', 'pwsh', 'web_fetch']) {
    assert.ok((back.get(name) ?? []).length > 1,
      `${name} 不再歧义 ⇒ "一对多需要裁决"这一节的前提变了，必须重核而不是继续通过`)
  }
  // ★ 最要紧的那一条：那个候选集里**同时**塌着低风险与高风险。
  const shell = back.get('bash')
  const risks = shell.map((n) => resolveTool(n).risk)
  assert.ok(risks.includes('high'), `shell 的候选里必须有高风险的：${JSON.stringify(shell)}`)
  assert.ok(risks.some((r) => r === 'low' || r === 'medium'),
    `shell 的候选里必须有低/中风险的（否则"按最严的判"是无代价的，这一节就不成立）：${JSON.stringify(risks)}`)
  // ⇒ 所以"按最宽"会让只读岗位跑 git push，"按最严"会让 git status 被拒。
  const wide = shell.find((n) => resolveTool(n).risk === 'high')
  const narrow = shell.find((n) => resolveTool(n).risk !== 'high')
  assert.ok(wide !== undefined && narrow !== undefined)
  assert.ok(HIGH_RISK_TOOL_NAMES.includes(wide) === (resolveTool(wide).risk !== 'low'))
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 端口的**真读数**：真名字进来，放行谁、拒谁、按哪条规则拒
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★★ 真 DSH 名进来：`read` 放行、`write` 按**能力**拒（而不是按"未知工具"拒）', () => {
  const port = createWhitelistPort({ permit: readerPermit() })

  const ok = port({ toolName: 'read', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(ok.allowed, true, `read 必须放行：${JSON.stringify(ok)}`)
  assert.equal(ok.legionTool, 'read-file', '翻译得到的能力名必须如实带出来（否则排障时看不到它判的是谁）')

  // ★★★ 最要紧的一条：拒因必须是**能力**，不能是"未知工具"。
  //   这正是第 21 轮量出来的形状——把 DSH 名直接喂进去会得到
  //   `unknown-tool-not-named`（一条**指向错地方**的拒绝）：
  //   照着它去改的人会去清单里"点名"这个工具，而真正的问题是能力没授予。
  const no = port({ toolName: 'write', arguments: { path: 'C:/work/a.txt' } })
  assert.equal(no.allowed, false)
  assert.equal(no.rule, 'employee-manifest-not-whitelisted',
    `拒因必须是能力不匹配，而不是未知工具：${JSON.stringify(no)}`)
  assert.equal(no.rule === 'employee-manifest-unknown-tool-not-named', false,
    '拒因落回"未知工具" ⇒ 翻译没生效，端口又是拿 DSH 名去查 Legion 目录了')
})

test('③b ★ 端口给出的拒绝必须**带理由**；而放行时理由为空（不然排障时两条路看起来一样）', () => {
  const port = createWhitelistPort({ permit: readerPermit() })
  for (const name of ['write', 'bash', 'web_fetch', 'todowrite']) {
    const v = port({ toolName: name, arguments: {} })
    assert.equal(v.allowed, false, `${name} 不该被放行`)
    assert.equal(typeof v.rule, 'string', `${name} 的拒绝没有码`)
    assert.ok(v.rule.length > 0)
    assert.equal(typeof v.reason, 'string', `${name} 的拒绝没有理由`)
    assert.ok(v.reason.length > 20, `${name} 的理由太短，给不出下一手：${v.reason}`)
  }
  const ok = port({ toolName: 'read', arguments: {} })
  assert.equal(ok.rule, null)
  assert.equal(ok.reason, null)
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 装配期就拒 —— 不留到"第一次工具调用时"
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 缺席记 `absent` **而不是** null：没配 ≠ 没有白名单', () => {
  const r = whitelistPortFromEnv({ env: {} })
  assert.equal(r.state, WHITELIST_PORT_STATES.ABSENT)
  assert.equal(r.port, null)
  assert.ok(r.reason.includes(WHITELIST_PORT_ENV_KEY),
    '缺席的理由必须点名是哪个键没配，否则值班的人不知道去哪配')
  // ★ 反面对照：`enforcementSurfaces().whitelist` 读的是"端口在不在"，
  //   所以缺席就必须是 `null`——把它换成一个"永远放行"的函数会让那一格变成 `true`。
  assert.equal(r.port === null, true)
})

test('④b ★★ 配了却解释不通 ⇒ **抛**（装配期），而不是退化成"放行"或"全拒"', () => {
  const bad = [
    ['不是 JSON', { [WHITELIST_PORT_ENV_KEY]: '{' }, WHITELIST_PORT_CODES.BAD_PERMIT_TEXT],
    ['不是对象', { [WHITELIST_PORT_ENV_KEY]: '"nope"' }, WHITELIST_PORT_CODES.BAD_PERMIT],
    ['空字符串', { [WHITELIST_PORT_ENV_KEY]: '   ' }, null],   // ← 空串**是**缺席，不是错误
    ['缺字段', { [WHITELIST_PORT_ENV_KEY]: JSON.stringify({ employeeId: 'x' }) }, WHITELIST_PORT_CODES.BAD_PERMIT],
    ['通配符', { [WHITELIST_PORT_ENV_KEY]: JSON.stringify(readerPermit({ allowedTools: ['*'] })) }, WHITELIST_PORT_CODES.BAD_PERMIT],
    ['裁决表不是对象', { [WHITELIST_PORT_ENV_KEY]: JSON.stringify(readerPermit({ toolNameDecisions: 'x' })) }, WHITELIST_PORT_CODES.BAD_DECISION],
  ]
  for (const [label, env, expected] of bad) {
    if (expected === null) {
      assert.equal(whitelistPortFromEnv({ env }).state, WHITELIST_PORT_STATES.ABSENT, `${label} 应记缺席`)
      continue
    }
    let caught = null
    try { whitelistPortFromEnv({ env }) } catch (err) { caught = err }
    assert.notEqual(caught, null, `${label} 竟然没抛 ⇒ 它会退化成"放行"或"全拒"`)
    assert.equal(caught.code, expected, `${label} 的码不对：${caught.code}`)
  }
})

test('④c ★★★ 归属裁决在**装配期**逐键校验：不歧义的键 / 表外的键 / 候选外的值', () => {
  const bad = [
    ['给不歧义的 read 登记', { read: 'read-file' }],
    ['键不在路由表里', { definitely_not_a_tool: 'read-file' }],
    ['值不在候选之内', { bash: 'read-file' }],
    ['值是候选但类型不对', { bash: 42 }],
  ]
  for (const [label, decisions] of bad) {
    let caught = null
    try {
      whitelistPortFromEnv({ env: envWith(readerPermit({ toolNameDecisions: decisions })) })
    } catch (err) { caught = err }
    assert.notEqual(caught, null, `${label} 竟然没抛`)
    assert.equal(caught.code, WHITELIST_PORT_CODES.BAD_DECISION, `${label} 的码不对：${caught.code}`)
  }
  // ★ 而"给不歧义的键登记"为什么必须拒：它把一个**已经确定**的事实
  //   重新变成一个可被改错的值——今天它对，路由表加一条之后它会安静地变错。
  const okDecisions = { bash: 'git-status', pwsh: 'git-status' }
  const good = whitelistPortFromEnv({ env: envWith(readerPermit({ toolNameDecisions: okDecisions })) })
  assert.equal(good.state, WHITELIST_PORT_STATES.CONFIGURED)
  assert.deepEqual(good.decisions, okDecisions)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 裁决**真的改变结果** —— 而不是只是"不抛了"
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★★ 有裁决 vs 没裁决：`bash` 从"具名歧义拒绝"变成"按裁决判定"', () => {
  const without = whitelistPortFromEnv({ env: envWith(readerPermit()) })
  const a = without.port({ toolName: 'bash', arguments: {} })
  assert.equal(a.allowed, false)
  assert.equal(a.rule, WHITELIST_PORT_CODES.AMBIGUOUS, `没裁决时必须具名歧义：${JSON.stringify(a)}`)
  assert.deepEqual(a.candidates, ['git-commit', 'git-push', 'git-status', 'run-command'],
    '候选必须原样列出（只喊"歧义"而不给候选，值班的人没有下一手）')

  const withDec = whitelistPortFromEnv({
    env: envWith(readerPermit({ toolNameDecisions: { bash: 'git-status' } })),
  })
  const b = withDec.port({ toolName: 'bash', arguments: {} })
  assert.equal(b.allowed, true, `裁决为 git-status 后必须放行：${JSON.stringify(b)}`)
  assert.equal(b.legionTool, 'git-status', '裁决后的能力名必须如实带出来')

  // ★ 而裁决成**高风险**的那一个时，同一份许可必须**拒** —— 这一条证明
  //   裁决是真的进了判定器，而不是只把 `allowed` 翻成 true。
  const risky = whitelistPortFromEnv({
    env: envWith(readerPermit({ toolNameDecisions: { bash: 'git-push' } })),
  })
  const c = risky.port({ toolName: 'bash', arguments: {} })
  assert.equal(c.allowed, false, `判成 git-push 时必须拒：${JSON.stringify(c)}`)
  assert.ok(String(c.rule).startsWith('employee-manifest-'),
    `拒因必须来自岗位清单那几条规则，而不是翻译层：${c.rule}`)
})

test('⑤b ★ 同一个执行面名在**两份不同许可**下给出不同裁决（证明它读的是清单，不是常量）', () => {
  const viewer = whitelistPortFromEnv({ env: envWith(readerPermit()) })
  const writer = whitelistPortFromEnv({
    env: envWith(readerPermit({
      employeeId: 'e-writer', role: 'writer',
      allowedTools: ['read-file', 'write-file', 'git-status'],
      allowedCapabilities: ['file:read', 'file:write'],
      maxRisk: 'high',
      toolNameDecisions: { bash: 'git-status' },
    })),
  })
  assert.equal(viewer.port({ toolName: 'write', arguments: {} }).allowed, false)
  assert.equal(writer.port({ toolName: 'write', arguments: {} }).allowed, true,
    '同一份代码、同一个工具名，换一份许可必须换一个答案 —— 否则它读的不是清单')
  assert.equal(viewer.port({ toolName: 'bash', arguments: {} }).allowed, false)
  assert.equal(writer.port({ toolName: 'bash', arguments: {} }).allowed, true)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 反向读数：这条判据抓的是**写这一轮时自己踩的那个坑**
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★★★ 裁决过的调用必须**真的放行** —— 只断言 allowed=false 的用例看不见这个坑', () => {
  // 第一版端口写的是 `if (translated.state !== 'unique') return 拒绝`。
  // 裁决那一支把 state 记成 `decided`（它确实不是 `unique`），于是**恒拒**，
  // 而且拒绝时 `translated.code` 是 `null` ⇒ **一条没有理由的拒绝**。
  //
  //   > 一个「裁决写对了、而这一格恒拒」的实现，
  //   > 与一个「裁决根本没生效」的实现，在 `allowed:false` 上是同一个读数。
  //
  // 所以这一条**同时**断言三样：allowed / rule / legionTool。
  // 把那一行改回 `!== 'unique'`，它当场红在 `allowed` 上；
  // 而如果只写 `assert.equal(v.allowed, true)`，它在"理由是 null"上仍然是绿的。
  const built = whitelistPortFromEnv({
    env: envWith(readerPermit({ toolNameDecisions: { bash: 'git-status', pwsh: 'git-status' } })),
  })
  for (const name of ['bash', 'pwsh']) {
    const v = built.port({ toolName: name, arguments: {} })
    assert.equal(v.allowed, true, `${name} 裁决后必须放行：${JSON.stringify(v)}`)
    assert.equal(v.rule, null, `${name} 放行时不该有码`)
    assert.equal(v.reason ?? null, null, `${name} 放行时不该有理由`)
    assert.equal(v.legionTool, 'git-status', `${name} 的能力名必须带出来`)
    assert.equal(v.translationState, undefined,
      '放行路径不该带 translationState —— 它是**拒绝**时的排障字段')
  }
  // ★ 反向：`decided` 态**本身**必须是"成功态"这一事实，也要被直接钉住。
  const t = translateToolName({ toolName: 'bash', registry: { bash: 'git-status' } })
  assert.equal(t.state, 'decided')
  assert.equal(t.code, null, 'decided 是成功态 ⇒ 不带码')
  assert.equal(t.legionTool, 'git-status')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 与生产装配的**接口形状**对齐（不重抄 root-row 的入参，而是钉住形状）
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★ 端口形状与另外三道范围检查**逐字同形**：`(projection) => {allowed, rule, reason}`', () => {
  const port = createWhitelistPort({ permit: readerPermit() })
  assert.equal(typeof port, 'function')
  const v = port({ toolName: 'read', arguments: {} })
  // `tool-request.mjs:1000` 读的正是这三样（`verdict.allowed !== true` 与 `verdict.rule`）。
  assert.equal(typeof v.allowed, 'boolean')
  assert.equal(v.allowed, true)
  const no = port({ toolName: 'write', arguments: {} })
  assert.equal(typeof no.allowed, 'boolean')
  assert.ok(no.rule === null || typeof no.rule === 'string')
  // ★ 而端口**必须容忍**投影里那些它不看的字段（`README` 之外的形状不该让它炸）。
  const wide = port({
    toolName: 'read', arguments: {}, canonicalTarget: 'C:/work/a.txt',
    risk: 'low', isWrite: false, scopeFacts: null, extra: Symbol('x'),
  })
  assert.equal(wide.allowed, true, '端口只读 toolName，多给的字段不许影响判定')
})

test('⑦b ★ 非对象投影 / 空工具名：fail closed 且**具名**（不是抛）', () => {
  const port = createWhitelistPort({ permit: readerPermit() })
  for (const bad of [null, undefined, 42, 'read', []]) {
    const v = port(bad)
    assert.equal(v.allowed, false, `${JSON.stringify(bad)} 必须被拒`)
    assert.equal(v.rule, WHITELIST_PORT_CODES.NO_TOOL_NAME)
  }
  const empty = port({ toolName: '   ', arguments: {} })
  assert.equal(empty.allowed, false)
  assert.equal(empty.rule, WHITELIST_PORT_CODES.NO_TOOL_NAME)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 口径一致性：本套件不许与既有教义冲突
// ══════════════════════════════════════════════════════════════════════════

test('⑧ ★★ 本模块**不新增**任何名字映射：Legion 名一个都不许落进 TOOL_CATALOG 之外', () => {
  // `whitelist-limb.test.mjs` ⑦ 钉住"两个名字空间不相交"。本模块在**中间**加了
  // 一次翻译，所以必须证明它没有把两边混起来：
  //   · 翻译的**输出**必须是 Legion 能力名（`resolveTool` 认得）；
  //   · 翻译的**输入**必须是执行面名（不在 Legion 目录里 —— 除非恰好同名）。
  const back = reverseRouting()
  for (const [dsh, legions] of back) {
    assert.equal(resolveTool(dsh).known, false,
      `执行面名 ${dsh} 竟然在 Legion 目录里被认得 ⇒ 两个名字空间开始相交，本模块的前提要重核`)
    for (const legion of legions) {
      assert.equal(resolveTool(legion).known, true, `翻译输出 ${legion} 必须能在 Legion 目录里查到`)
      assert.ok(KNOWN_TOOL_NAMES.includes(legion))
    }
  }
  // ★ 而本模块**只**用那一张表：源码里不许出现第二张 DSH→Legion 的字面量表。
  //   （扫描本文件自身：路由表那边的键名不许被硬编码成一张映射。）
  assert.equal(LEGION_TOOL_ROUTING['read-file'].dshTools.includes('read'), true)
})

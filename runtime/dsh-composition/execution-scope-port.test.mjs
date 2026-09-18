// runtime/dsh-composition/execution-scope-port.test.mjs
// ============================================================================
// PRT-605（第 19 轮）：`execution-scope-port.mjs` 的判据。
//
// 这一套守三件事，每一件都是"两面都读"：
//
//   ① **装配期 fail closed**：表不合法**现在**抛，不留到第一次调用；
//      而"表合法但授权为空"是另一回事——那不是配置错误。
//   ② **端口只读事实**：它**不**去 `arguments` 里找命令。
//      这条判据用"给一份没有 facts 的投影 ⇒ 放行"来钉——
//      一个自己找命令的端口会在这里拒绝。
//   ③ ★★★ **MCP 那一条未接，而且必须是具名的"未接"**，
//      不是判定器的"名字有歧义"，也不是静默放行。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXECUTION_SCOPE_PORT_CODES, EXECUTION_SCOPE_PORT_ENV_KEY,
  EXECUTION_SCOPE_PORT_ENV_KEYS, EXECUTION_SCOPE_PORT_STATES,
  EXECUTION_SCOPE_PORT_VERSION, createExecutionScopePort, executionScopePortFromEnv,
} from './execution-scope-port.mjs'
import { EXECUTION_SCOPE_VERSION, EXEC_CODES } from './execution-scope.mjs'
import { deriveScopeFacts } from './scope-facts.mjs'

const facts = (capabilities, args, toolName = 'run-command', known = true) =>
  deriveScopeFacts({ capabilities, args, toolName, known })

test('① ★★★ 装配期就归一化：表不合法**现在**抛，不留到第一次调用', () => {
  // ①a：认不认识的字段 ⇒ 抛（`normalizeGrant` 的判据，原样上抛）。
  assert.throws(() => createExecutionScopePort({
    grant: { command: { programs: ['git'] }, 多打的字段: 1 },
  }), (e) => e.code === EXEC_CODES.BAD_GRANT,
  '授权表里的错字必须在**装配期**炸——留到第一次调用就是留到"已经有副作用的那一刻"')

  // ①b：不是对象 ⇒ 本模块自己的 BAD_INPUT。
  assert.throws(() => createExecutionScopePort({ grant: 'git' }),
    (e) => e.code === EXECUTION_SCOPE_PORT_CODES.BAD_INPUT)
  assert.throws(() => createExecutionScopePort({}),
    (e) => e.code === EXECUTION_SCOPE_PORT_CODES.BAD_INPUT)

  // ①c ★ 反向：表**合法但什么都不许**是一份合法的授权表（`programs: []`）。
  //    一个把"空授权"读成"配置错误"的实现，会让"这个岗位什么命令都不许跑"
  //    根本配不出来。
  const empty = createExecutionScopePort({ grant: { command: { programs: [] } } })
  const v = empty({ scopeFacts: facts(['command:exec'], { command: ['git', 'status'] }) })
  assert.equal(v.allowed, false, '空授权表必须拒绝——否则"什么都不许"配不出来')
  assert.equal(v.code, EXEC_CODES.PROGRAM_NOT_ALLOWED)
})

test('② ★★★ 端口**只读** `projection.scopeFacts`——它不自己去 `arguments` 里找', () => {
  // 这条是 `scope-facts.mjs` 那套纪律在**端口**这一侧的对照读数。
  //   > 一个「端口各自兜底参数名」的实现，与一个「六处兜底今天恰好一致」的实现，
  //   > 在所有"只喂一条路径"的用例上都是绿的。
  const port = createExecutionScopePort({ grant: { command: { programs: ['git'] } } })

  // ②a：投影里**没有** facts（普通文件工具）⇒ 放行，**哪怕** `arguments` 里
  //      明明白白躺着一条命令。端口不许去看 `arguments`。
  const sneaky = port({
    arguments: { command: ['rm', '-rf', '/'] },   // ← 端口**不许**读这个
    scopeFacts: null,
  })
  assert.equal(sneaky.allowed, true,
    '端口读了 `arguments` —— 那就是"端口各自兜底"的实现；'
    + '事实必须由投影算一次（`scope-facts.mjs`），端口只摆不复推')

  // ②b：同一个端口，同一份 arguments，**只**把 facts 补上 ⇒ 立刻拒。
  //      两条合起来才说明"决定完全来自 facts"。
  const real = port({
    arguments: { command: ['rm', '-rf', '/'] },
    scopeFacts: facts(['command:exec'], { command: ['rm', '-rf', '/'] }),
  })
  assert.equal(real.allowed, false)
  assert.equal(real.code, EXEC_CODES.PROGRAM_NOT_ALLOWED)

  // ②c：不合法的投影（不是对象）⇒ 拒，带本模块的码。
  assert.equal(port(null).allowed, false)
  assert.equal(port('x').code, EXECUTION_SCOPE_PORT_CODES.BAD_INPUT)
  // ②d：`scopeFacts` 存在但不是对象 ⇒ 拒（接线坏了），不是放行。
  assert.equal(port({ scopeFacts: 'git status' }).code, EXECUTION_SCOPE_PORT_CODES.BAD_INPUT)
})

test('③ ★★★ 能力说是这一类、事实里却没有 ⇒ 拒绝（不是"与执行面无关"）', () => {
  const port = createExecutionScopePort({ grant: { command: { programs: ['git'] } } })
  // 一份"说得出类别、说不出内容"的事实：接线坏掉时才可能出现。
  const broken = port({ scopeFacts: { version: 'legion/scope-facts@1', kinds: ['command'] } })
  assert.equal(broken.allowed, false,
    'kinds 里有 command 而 facts.command 缺席——这必须拒："证明不了它要起什么"')
  assert.equal(broken.code, EXECUTION_SCOPE_PORT_CODES.NO_FACTS)

  // 反向对照：`kinds` 为空 ⇒ 无话可说 ⇒ 放行（这才叫"与执行面无关"）。
  assert.equal(port({ scopeFacts: { version: 'legion/scope-facts@1', kinds: [] } }).allowed, true)
})

test('④ ★★ 命令/网络两条都走判定器：越界的拒，授权之内的放行', () => {
  const grant = {
    command: { programs: ['git'] },
    network: { schemes: ['https'], hosts: ['api.example.com'], ports: [443], methods: ['GET'] },
  }
  const port = createExecutionScopePort({ grant })

  // ④a：授权之内的命令 ⇒ 放行。
  assert.equal(port({ scopeFacts: facts(['command:exec'], { command: ['git', 'status'] }) }).allowed, true)

  // ④b ★：单字符串命令（没分词）⇒ 拒，而且是 `NOT_TOKENIZED` 那个码。
  const raw = port({ scopeFacts: facts(['command:exec'], { command: 'git push --force' }) })
  assert.equal(raw.allowed, false)
  assert.equal(raw.code, EXEC_CODES.NOT_TOKENIZED)

  // ④c：授权之内的 URL ⇒ 放行。
  assert.equal(port({
    scopeFacts: facts(['network:read'], { url: 'https://api.example.com/v1' }),
  }).allowed, true)

  // ④d ★★：方法缺省给 `GET`，**与判定器的默认值同一个字面量**。
  //      一个"端口给 POST、判定器认为 GET"的分歧会让写请求按读判定走。
  //      这里用 methods 只许 GET 的表，POST 必须被拒。
  const post = port({
    scopeFacts: facts(['network:write'], { url: 'https://api.example.com/v1', method: 'POST' }),
  })
  assert.equal(post.allowed, false, 'POST 被放行了——方法没有传到判定器（缺省值分歧）')

  // ④e：没给 method ⇒ 按 GET 判 ⇒ 放行（这是缺省值正确的**正向**读数）。
  assert.equal(port({
    scopeFacts: facts(['network:read'], { url: 'https://api.example.com/v1' }),
  }).allowed, true)

  // ④f：换个 host ⇒ 拒。
  const other = port({ scopeFacts: facts(['network:read'], { url: 'https://evil.example/v1' }) })
  assert.equal(other.allowed, false)
  assert.equal(other.code, EXEC_CODES.HOST_NOT_ALLOWED)
})

test('⑤ ★★★ MCP：没有 mcp 段时**真的在判**；有 mcp 段时**具名地报未接**', () => {
  // 这一条守的是本批最重要的一个**诚实边界**（`execution-scope-port.mjs` 文件头 ③）。
  const mcpFacts = facts(['mcp:call'], {}, 'mcp__github__list_issues')

  // ⑤a：授权表里没有 `mcp` 段 ⇒ 判定器真的在判，用**判定器**的码。
  const noMcp = createExecutionScopePort({ grant: { command: { programs: ['git'] } } })
  const v1 = noMcp({ scopeFacts: mcpFacts })
  assert.equal(v1.allowed, false, 'MCP 绝不能被静默放行')
  assert.equal(v1.code, EXEC_CODES.MCP_SERVER_DENIED,
    `必须是判定器的"没有 MCP 授权"，而不是本模块的码——这一条是**真在判**：${v1.code}`)

  // ⑤b ★★：授权表里**有** `mcp` 段 ⇒ 未接，用**本模块**的码。
  const withMcp = createExecutionScopePort({
    grant: { mcp: { servers: [{ server: 'github', tools: ['list_issues'] }] } },
  })
  const v2 = withMcp({ scopeFacts: mcpFacts })
  assert.equal(v2.allowed, false, '★ 未接 ≠ 放行：放行会让"没接这一道"变成"随便调"')
  assert.equal(v2.code, EXECUTION_SCOPE_PORT_CODES.MCP_LIMB_UNWIRED,
    `必须是"未接"这个码。两者都拒，但一个说"去裁决两份授权表"，`
    + `一个说"改授权表"——值班的人照着改，改错方向：${v2.code}`)
  assert.match(v2.reason, /连接器登记表/, '理由必须点名权威在哪')
  assert.match(v2.reason, /never parsed to recover|拆开公开名/,
    '理由要写清"为什么不能靠拆名字修"——否则下一个人会去写那段代码')

  // ⑤c ★ 反向对照：**授权表里的那条 MCP 规则**（github/list_issues）
  //      并没有让这次调用通过。少了它，⑤b 可能只是"有 mcp 段就一律拒"，
  //      而"授权表里写不写它"这件事就看不出区别——那正是"未接"的形状。
  assert.equal(withMcp({ scopeFacts: mcpFacts }).allowed, false)
})

test('⑥ ★★ 判定器抛异常 ⇒ 拒绝（带码），不把强制面炸掉、也不变成放行', () => {
  const port = createExecutionScopePort({ grant: { command: { programs: ['git'] } } })
  // 判定器内部抛 ⇒ 端口接住并拒。
  //   ★ 用一份 `kinds` 是数组、但 `command` 是 `null` 之外还带坏值的事实来触发：
  //     `checkCommand` 自己是不抛的（它把 parseArgv 的异常转成 verdict），
  //     所以这里改用"事实里的 argv 是 Symbol"制造一次真实抛出。
  const v = port({ scopeFacts: { version: 'legion/scope-facts@1', kinds: ['command'], command: { argv: Symbol('x') } } })
  assert.equal(v.allowed, false, '判定器抛异常必须是拒绝')
  assert.ok(typeof v.code === 'string' && v.code.length > 0, '拒绝必须带码（可归因）')
})

test('⑦ ★★★ 环境端口：缺席如实记 `absent`；配了却解释不通 ⇒ **抛**', () => {
  // ⑦a：缺席 ⇒ `absent` + `port: null`。**不**补一份空表默认值。
  for (const raw of [undefined, null, '']) {
    const r = executionScopePortFromEnv({ env: raw === undefined ? {} : { [EXECUTION_SCOPE_PORT_ENV_KEY]: raw } })
    assert.equal(r.state, EXECUTION_SCOPE_PORT_STATES.ABSENT, `${JSON.stringify(raw)} 应读成缺席`)
    assert.equal(r.port, null, '缺席时端口必须是 null——组合根那一格才会如实报 false')
    assert.match(r.reason, /不是\*\*"没有执行面限制"/)
  }

  // ⑦b：坏 JSON ⇒ **抛**（那是配置错误，不是"没配"）。
  assert.throws(() => executionScopePortFromEnv({ env: { [EXECUTION_SCOPE_PORT_ENV_KEY]: '{oops' } }),
    (e) => e.code === EXECUTION_SCOPE_PORT_CODES.BAD_TABLE_TEXT,
    '坏 JSON 被当成"没配" ⇒ 一次配置笔误与一次真实的"无限制"读数相同')

  // ⑦c：JSON 合法但表不合法（认不认识的字段）⇒ 也抛，码来自判定器。
  assert.throws(() => executionScopePortFromEnv({
    env: { [EXECUTION_SCOPE_PORT_ENV_KEY]: JSON.stringify({ command: { programs: ['git'] }, 多打的: 1 }) },
  }), (e) => e.code === EXEC_CODES.BAD_GRANT)

  // ⑦d：环境对象给错 ⇒ BAD_INPUT。
  assert.throws(() => executionScopePortFromEnv({ env: 'x' }),
    (e) => e.code === EXECUTION_SCOPE_PORT_CODES.BAD_INPUT)

  // ⑦e ★：配好时 `state=configured` 且端口**立刻能用**（不是"要再调一次才生效"）。
  const ok = executionScopePortFromEnv({
    env: { [EXECUTION_SCOPE_PORT_ENV_KEY]: JSON.stringify({ command: { programs: ['git'] } }) },
  })
  assert.equal(ok.state, EXECUTION_SCOPE_PORT_STATES.CONFIGURED)
  assert.equal(typeof ok.port, 'function')
  assert.equal(ok.port({ scopeFacts: facts(['command:exec'], { command: ['git', 'status'] }) }).allowed, true)
  assert.equal(ok.port({ scopeFacts: facts(['command:exec'], { command: ['rm', '-rf', '/'] }) }).allowed, false)
})

test('⑧ 版本与键名表是**导出**的：读取点、用例、失败消息要指同一处', () => {
  // `scripts/config/config.test.mjs` 与 `root-row.mjs` 都从这两个导出取键名，
  // 而不是各写一遍字面量。
  assert.equal(EXECUTION_SCOPE_PORT_ENV_KEY, 'LEGION_EXECUTION_SCOPE')
  assert.deepEqual([...EXECUTION_SCOPE_PORT_ENV_KEYS], [EXECUTION_SCOPE_PORT_ENV_KEY])
  assert.ok(Object.isFrozen(EXECUTION_SCOPE_PORT_ENV_KEYS))
  assert.equal(EXECUTION_SCOPE_PORT_VERSION, 'legion/execution-scope-port@1')
  // ★ 端口的版本与判定器的版本是**两个**：一个改了不代表另一个改了。
  //   合并成一个会让"判定规则改了"与"接线改了"在账上同形。
  assert.notEqual(EXECUTION_SCOPE_PORT_VERSION, EXECUTION_SCOPE_VERSION)
})

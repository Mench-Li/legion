// runtime/dsh-composition/connector-port.test.mjs
// ============================================================================
// F-21 第 19 条 §9.2 第 5 步：部署环境里那份连接器声明 → 组合根。
//
// 本套件盯的是**四种"看起来接好了"**：
//   ① 没配当成空表（于是读数说"装好了"而一次判定都不做）
//   ② 显式空表被静默接受（同上，而且是**写配置的人亲手**触发的）
//   ③ 重名工具被折成"不归连接器管"（于是那几个工具的策略**静默免掉**）
//   ④ 配错了当成没配（于是"我配了"与"我配错了"同形）
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONNECTOR_PORT_CODES,
  CONNECTOR_PORT_ENV_KEY,
  CONNECTOR_PORT_ENV_KEYS,
  CONNECTOR_PORT_STATES,
  CONNECTOR_PORT_VERSION,
  connectorPortFromEnv,
} from './connector-port.mjs'

/** 一份合法的连接器声明（形状取自 `runtime/connectors/registry.mjs`）。 */
const decl = (over = {}) => ({
  connectorId: 'github',
  transport: 'stdio',
  command: 'npx mcp-github',
  policy: 'allow',
  tools: [{ name: 'list_issues', capabilities: ['repo:read'] }],
  secretRefs: [],
  ...over,
})

const withEnv = (value) => ({ [CONNECTOR_PORT_ENV_KEY]: value })

const throwsCode = (fn, code) => {
  try {
    fn()
  } catch (err) {
    assert.equal(err.code, code, `期望具名码 ${code}，实得 ${err.code}：${err.message}`)
    return err
  }
  assert.fail(`没有抛（期望 ${code}）—— 静默通过正是本套件要挡的那一类`)
}

// ---------------------------------------------------------------------------
// ① 缺席
// ---------------------------------------------------------------------------

test('① ★★★ 没配 ⇒ 如实记 absent，且**不建**登记表（缺席 ≠ 空表）', () => {
  //   > 一个"没配就当空表"的读取点，与一个"装了一份零连接器登记表"的组合根，
  //   > 在 `connectorJudgment` 那一格上是同一个 `true`——
  //   > 只不过后者**一次判定都不会做**。
  for (const env of [{}, { OTHER: 'x' }, withEnv(undefined), withEnv(null), withEnv(''), withEnv('   ')]) {
    const p = connectorPortFromEnv({ env })
    assert.equal(p.state, CONNECTOR_PORT_STATES.ABSENT, `env=${JSON.stringify(env)} 应当是缺席`)
    // ★ 关键：`null`，**不是** `[]`。这是本套件存在的首要理由。
    assert.equal(p.declarations, null, '缺席必须是 null —— `[]` 会让组合根建出一份零连接器登记表')
    assert.equal(p.resolveConnectorId, null)
    assert.equal(p.toolCount, 0)
    assert.match(p.reason, /不是.*没有连接器策略/, '理由必须点破"缺席 ≠ 没有策略"')
    assert.match(p.reason, /false/, '理由要写清组合根那一侧会读出什么')
  }
})

test('①a ★★★ 显式空表 ⇒ **具名拒绝**（否则它就是"看起来接好了"的那一种）', () => {
  // 这一条与 ① 是一对：① 证"没配是 null"，这一条证"配了个空的**不许**被
  // 当成同一件事静默收下"。少了任何一条，另一条都能被一个"统一成 []"的实现满足。
  const err = throwsCode(() => connectorPortFromEnv({ env: withEnv('[]') }), CONNECTOR_PORT_CODES.EMPTY_LIST)
  assert.match(err.message, /connectorJudgment/, '理由要点破它会读成 true')
  assert.match(err.message, /不要设这个键/, '理由必须告诉人"想表达没有连接器该怎么做"')
  // 同样拒的是**数组形态**，不是只拒字符串 '[]'
  throwsCode(() => connectorPortFromEnv({ env: withEnv([]) }), CONNECTOR_PORT_CODES.EMPTY_LIST)
})

// ---------------------------------------------------------------------------
// ② 配了就必须解释得通
// ---------------------------------------------------------------------------

test('② ★★ 配了却解释不通 ⇒ **抛**，不当作"没配"', () => {
  //   > 一个"读不出来就当作没配"的组合根，
  //   > 与一个"这个部署确实没有连接器"的部署，在强制面读数上长得一样。
  const bad = throwsCode(() => connectorPortFromEnv({ env: withEnv('not json{') }), CONNECTOR_PORT_CODES.BAD_TEXT)
  assert.match(bad.message, /不是合法 JSON/)
  assert.match(bad.message, /静默丢掉/, '理由要点破"静默丢掉"这个后果')

  throwsCode(() => connectorPortFromEnv({ env: withEnv('{"connectorId":"github"}') }), CONNECTOR_PORT_CODES.NOT_A_LIST)
  throwsCode(() => connectorPortFromEnv({ env: withEnv(42) }), CONNECTOR_PORT_CODES.NOT_A_LIST)

  // ★ 反向对照：**没给**与**给坏了**必须走两条不同的路。
  //   少了这条，"一律抛"的实现也能让上面三条绿——而那会让一个
  //   从没配过连接器的部署**起不来**。
  for (const absent of [null, undefined, '']) {
    assert.doesNotThrow(
      () => connectorPortFromEnv({ env: withEnv(absent) }),
      `「${JSON.stringify(absent)}」是**没给**，不该抛 —— 那会让没配连接器的部署起不来`,
    )
    assert.equal(connectorPortFromEnv({ env: withEnv(absent) }).state, CONNECTOR_PORT_STATES.ABSENT)
  }
})

test('②a ★★ 坏声明 ⇒ 具名拒绝，且**报得出是第几条**', () => {
  // 一个三十条声明的部署只得到一句"某处不对"是没法查的。
  const good = decl()
  const bad = { connectorId: 'gitlab', transport: 'stdio', command: 'x', policy: 'allow', tools: [], secretRefs: [] }
  const err = throwsCode(
    () => connectorPortFromEnv({ env: withEnv(JSON.stringify([good, bad])) }),
    CONNECTOR_PORT_CODES.BAD_DECLARATION,
  )
  assert.match(err.message, /第 2 条/, `理由必须报出第几条：${err.message}`)
  assert.match(err.message, /gitlab/, '理由要点出是哪一条')
  // ★ 原判据的具名码要**活下来**（不是被本模块的码盖掉）——
  //   否则"能力为空"与"风险值不认识"会在装配期变成同一个读数。
  assert.match(err.message, /connector-/, `原判据码必须出现在理由里：${err.message}`)
})

test('②b ★★ 同一个 id 声明两次 ⇒ 拒（后一条会静默遮蔽前一条）', () => {
  const err = throwsCode(
    () => connectorPortFromEnv({ env: withEnv(JSON.stringify([decl(), decl({ policy: 'deny' }) ])) }),
    CONNECTOR_PORT_CODES.BAD_DECLARATION,
  )
  assert.match(err.message, /两次/)
  assert.match(err.message, /静默失效/, '理由要点破后果')
})

// ---------------------------------------------------------------------------
// ③ 重名工具：装配期就停
// ---------------------------------------------------------------------------

test('③ ★★★ 两个连接器声明同名工具 ⇒ 装配期**具名拒绝**（不许折成"不归它管"）', () => {
  //   > 一次"新增了一个重名工具"的声明，
  //   > 与一次"这些工具从来就不归连接器管"的配置，
  //   > 在判定面的读数上是同一个 `unattributed`——
  //   > 只不过前者的后果是那几个工具的连接器策略**被静默免掉**。
  const a = decl({ connectorId: 'a', tools: [{ name: 'search', capabilities: ['repo:read'] }] })
  const b = decl({ connectorId: 'b', tools: [{ name: 'search', capabilities: ['repo:read'] }] })
  const err = throwsCode(
    () => connectorPortFromEnv({ env: withEnv(JSON.stringify([a, b])) }),
    CONNECTOR_PORT_CODES.AMBIGUOUS_TOOLS,
  )
  assert.match(err.message, /search/, '理由要点出是哪个工具名')
  assert.match(err.message, /\ba\b.*\bb\b/, '理由要点出是哪两个连接器')
  assert.match(err.message, /静默失效/, '理由要点破后果')
  assert.match(err.message, /改名/, '理由要给出可修复动作')
})

test('③a ★ 同名**不**同工具不冲突（反向对照：拒的必须是重名，不是"多个连接器"）', () => {
  const a = decl({ connectorId: 'a', tools: [{ name: 'a_tool', capabilities: ['repo:read'] }] })
  const b = decl({ connectorId: 'b', tools: [{ name: 'b_tool', capabilities: ['repo:read'] }] })
  const p = connectorPortFromEnv({ env: withEnv(JSON.stringify([a, b])) })
  assert.equal(p.state, CONNECTOR_PORT_STATES.CONFIGURED)
  assert.equal(p.toolCount, 2)
})

// ---------------------------------------------------------------------------
// ④ 成功路径 + 归属
// ---------------------------------------------------------------------------

test('④ ★★★ 配好了 ⇒ declarations 可用，且 `resolveConnectorId` 是**推导**出来的', () => {
  const p = connectorPortFromEnv({ env: withEnv(JSON.stringify([decl()])) })
  assert.equal(p.state, CONNECTOR_PORT_STATES.CONFIGURED)
  assert.equal(p.declarations.length, 1)
  assert.equal(p.declarations[0].connectorId, 'github')
  assert.equal(p.toolCount, 1)
  assert.equal(typeof p.resolveConnectorId, 'function')

  // ★ 推导：声明里已经写着"这个连接器有哪些工具"，所以归属是**算出来的**，
  //   不是部署再配一遍 `{工具名: id}`。再配一份就是同一件事写两遍。
  assert.equal(p.resolveConnectorId({ toolName: 'list_issues' }), 'github')
  // 工具名过 trim（与 registry 的 `attributeTool` 同一条口径）
  assert.equal(p.resolveConnectorId({ toolName: '  list_issues  ' }), 'github')
})

test('④a ★★★ `resolveConnectorId` **永不抛**（它落在没有 try/catch 的那条路径上）', () => {
  // ★ 桥在 `tool-request.mjs` 里是 `await decide(got.projection)`，**没有 try/catch**。
  //   这个函数抛出去会炸掉整条 pre-execute 瀑布——也就是**每一次**工具调用。
  const p = connectorPortFromEnv({ env: withEnv(JSON.stringify([decl()])) })
  const crazy = [
    undefined, null, {}, 42, 'x', [],
    { toolName: null }, { toolName: 42 }, { toolName: '' }, { toolName: '   ' },
    { toolName: 'nope' },
  ]
  for (const projection of crazy) {
    let got
    assert.doesNotThrow(() => { got = p.resolveConnectorId(projection) },
      `喂 ${JSON.stringify(projection)} 时抛了 —— 那会炸掉每一次工具调用`)
    assert.equal(got, null, `喂 ${JSON.stringify(projection)} 应当得 null（认不出）`)
  }
  // ★ 连"取属性就炸"的投影也要兜住（坏 getter）。这不是假想：
  //   `decision` 那条路径上我已经用同一个理由加过一条坏 thenable 的用例。
  const hostile = { get toolName() { throw new Error('boom') } }
  assert.doesNotThrow(() => assert.equal(p.resolveConnectorId(hostile), null))
})

test('④b ★★ 认不出的工具 ⇒ `null`（"管不着"要交给策略门，不是放行）', () => {
  const p = connectorPortFromEnv({ env: withEnv(JSON.stringify([decl()])) })
  assert.equal(p.resolveConnectorId({ toolName: 'never_declared' }), null)
})

test('④c ★★★ 已知限度：推导式归属**只能**归属已声明的工具（登记表那条教义因此不可达）', () => {
  // ⚠️ 这一条钉的是 `connector-port.mjs` 文件头 ⑦ 那条边界——
  //    不是待办，是"读到判定面已接线的人最容易误解的那件事"。
  //
  //    它必须在这里（而不是只在组合根那一层）被钉住，因为**这个模块
  //    就是那个限度本身**：`resolveConnectorId` 是推导出来的，
  //    而推导的输入**只有声明**。
  const p = connectorPortFromEnv({ env: withEnv(JSON.stringify([
    decl({ connectorId: 'github', tools: [{ name: 'list_issues', capabilities: ['repo:read'] }] }),
  ])) })

  // ★ 三个读数放在一起，才能把"限度"与"坏了"分开：
  //   ① 声明过的 ⇒ 归属得到（功能是好的）
  assert.equal(p.resolveConnectorId({ toolName: 'list_issues' }), 'github')
  //   ② 没声明的连接器风格名字 ⇒ `null`（**这就是限度**）
  assert.equal(p.resolveConnectorId({ toolName: 'github__delete_repo' }), null,
    '未声明的工具名被归属到了连接器 —— 那说明归属不再只依据声明（这条判据要重写）')
  //   ③ 已知核心工具 ⇒ 也是 `null`（与 ② **同一个读数**）
  assert.equal(p.resolveConnectorId({ toolName: 'git-status' }), null)
  //   ⇒ ② 与 ③ 同形，正是"按名字归属"分不开"来源"的证据。
  //
  //   > 一个"连接器新加的工具"与一个"DSH 本来就有的核心工具"，
  //   > 在归属这一格上是同一个 `null`——只不过前者本该被拒绝，
  //   > 而 `null` 的含义是"交给政策门"。
})

// ---------------------------------------------------------------------------
// ⑤ 形状与契约
// ---------------------------------------------------------------------------

test('⑤ ★★ 环境键表与版本号是导出契约（config 门禁靠它反查 schema）', () => {
  assert.equal(CONNECTOR_PORT_ENV_KEY, 'LEGION_CONNECTOR_DECLARATIONS')
  assert.deepEqual([...CONNECTOR_PORT_ENV_KEYS], ['LEGION_CONNECTOR_DECLARATIONS'])
  assert.equal(CONNECTOR_PORT_VERSION, 'legion/connector-port@1')
  // ★ 这套状态词必须与 `scope-port.mjs` / `product/execution-plane-config.mjs`
  //   **逐字**相同：两套同义词会让"缺席"在三个读数里看起来是三件事。
  assert.deepEqual(Object.values(CONNECTOR_PORT_STATES).sort(), ['absent', 'configured'])
})

test('⑤a ★★ 参数不是对象 ⇒ 具名拒（接线写错 ≠ 没配）', () => {
  for (const bad of [undefined, null, 'x', 42, []]) {
    throwsCode(() => connectorPortFromEnv(bad === undefined ? {} : { env: bad }),
      bad === undefined ? CONNECTOR_PORT_CODES.BAD_INPUT : CONNECTOR_PORT_CODES.BAD_INPUT)
  }
})

test('⑤b ★★ 声明表是冻结的（下游改不动它）', () => {
  const p = connectorPortFromEnv({ env: withEnv(JSON.stringify([decl()])) })
  assert.equal(Object.isFrozen(p), true)
  assert.equal(Object.isFrozen(p.declarations), true)
})

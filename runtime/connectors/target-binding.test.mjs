// runtime/connectors/target-binding.test.mjs
// ============================================================================
// 「策略 + 连接目标」组装点的判据。
//
// 这一组用例的重心不是"正常路径能跑"，而是**三条拒绝**：
// 它们是唯一能防止"漏配"与"配错"被静默地读成"少一个工具"的东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TARGET_BINDING_CODES, bindConnectorTargets } from './target-binding.mjs'
// ★ 跨到执行面取**真**注册表：组装出来的东西到底能不能用，只有它说了算。
import { createRegistry } from './registry.mjs'

/** 控制面规范化后那份声明（策略那一半）的形状——手写 fixture，不 import 控制面。 */
function policy(over = {}) {
  return {
    version: 'legion/connector-record@1',
    connectorId: 'github',
    version_label: '1.0.0',
    transport: 'stdio',
    policy: 'allow',
    // ★ 这里原来同时写着 `declaredRisk: 'low', risk: null`。
    //
    //   上面那个 `risk` **从来没有被读过**：声明里的输入字段叫 `declaredRisk`，
    //   而 `risk` 是 `normalizeTool` / `decide()` 交出去的**输出**字段。
    //   它当时被静默忽略，所以这条用例一直绿着，还顺带掩盖了
    //   "照着输出字段的样子写声明 = 整条声明看起来生效、实际没生效"这件事。
    //
    //   现在 `declareTool` 的键集是封闭的：多写一个 `risk` 会被具名拒掉
    //   （`connector-declaration-malformed`，理由直接点名 `declaredRisk`）。
    //   所以这个多余字段删掉——**不是**为了迁就新守卫，而是它本来就是错的。
    tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'allow' }],
    secretRefs: ['mcp.github.token'],
    ...over,
  }
}

test('① ★★★ 策略 + 目标 ⇒ 组装出来的东西**真的**建得起注册表（不是只长得像）', () => {
  const r = bindConnectorTargets({
    declarations: [policy()],
    targets: { github: { command: 'npx', transport: 'stdio' } },
  })
  assert.equal(r.refusals.length, 0)
  assert.equal(r.declarations.length, 1)
  // ★ 落到真的 createRegistry 上——否则这条用例只证明"我产出了一个对象"。
  const reg = createRegistry({ connectors: [...r.declarations] })
  assert.equal(reg.connectors().length, 1)
  assert.equal(reg.connectors()[0].connectorId, 'github')
  // 连接目标真的带进去了（经注册表读回来，而不是读我自己的入参）。
  assert.equal(reg.connectors()[0].command, 'npx')
})

test('① ★★★ 有声明没目标 ⇒ 具名拒绝，**不是**当成"这次没有这个连接器"', () => {
  const r = bindConnectorTargets({ declarations: [policy()], targets: {} })
  assert.equal(r.declarations.length, 0)
  assert.equal(r.refusals.length, 1)
  assert.equal(r.refusals[0].code, TARGET_BINDING_CODES.TARGET_MISSING)
  assert.equal(r.refusals[0].connectorId, 'github')
  assert.match(r.refusals[0].message, /漏配/)
})

test('① ★★★ 部分失败**不静默**：两条里坏一条 ⇒ 一条组装、一条拒绝，两边都看得见', () => {
  // 少了这条，"有一条没配上"与"本来就只有一条"在调用方眼里同形。
  const r = bindConnectorTargets({
    declarations: [policy(), policy({ connectorId: 'gitlab' })],
    targets: { github: { command: 'npx' } },
  })
  assert.equal(r.declarations.length, 1)
  assert.equal(r.refusals.length, 1)
  assert.equal(r.refusals[0].connectorId, 'gitlab')
  assert.equal(r.declarations[0].connectorId, 'github')
})

test('② ★★★ transport 两侧不一致 ⇒ 拒绝，且**两个方向都拒**（不许以某一侧为准）', () => {
  const cases = [
    { declTransport: 'stdio', targetTransport: 'http' },
    { declTransport: 'http', targetTransport: 'stdio' },
  ]
  for (const c of cases) {
    const r = bindConnectorTargets({
      declarations: [policy({ transport: c.declTransport })],
      targets: { github: { transport: c.targetTransport, command: 'npx', url: 'https://x/mcp' } },
    })
    assert.equal(r.declarations.length, 0, `${c.declTransport} vs ${c.targetTransport} 不该组装成功`)
    assert.equal(r.refusals[0].code, TARGET_BINDING_CODES.TRANSPORT_MISMATCH)
    assert.match(r.refusals[0].message, /不一致/)
  }
})

test('② ★ 目标**没给** transport 不算不一致（"没声明"不是"声明了另一个"）', () => {
  const r = bindConnectorTargets({
    declarations: [policy({ transport: 'http' })],
    targets: { github: { url: 'https://x/mcp' } },
  })
  assert.equal(r.refusals.length, 0)
  assert.equal(r.declarations.length, 1)
})

test('③ ★★★ 目标为空 ⇒ 拒绝（空值不算"给了"）', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const r = bindConnectorTargets({
      declarations: [policy()],
      targets: { github: { command: empty } },
    })
    assert.equal(r.declarations.length, 0, `command=${JSON.stringify(empty)} 不该通过`)
    assert.equal(r.refusals[0].code, TARGET_BINDING_CODES.TARGET_EMPTY)
  }
})

test('③ ★★ stdio 要 command、http/sse 要 url——分工与执行面一致', () => {
  // stdio 给了 url 而没给 command ⇒ 仍然拒绝（不许"反正给了一个"）。
  const r1 = bindConnectorTargets({
    declarations: [policy({ transport: 'stdio' })],
    targets: { github: { url: 'https://x/mcp' } },
  })
  assert.equal(r1.refusals[0].code, TARGET_BINDING_CODES.TARGET_EMPTY)
  // http 给 url ⇒ 通过，且 command 是 null（不是空串）。
  const r2 = bindConnectorTargets({
    declarations: [policy({ transport: 'http' })],
    targets: { github: { url: 'https://x/mcp' } },
  })
  assert.equal(r2.refusals.length, 0)
  assert.equal(r2.declarations[0].command, null)
  assert.equal(r2.declarations[0].url, 'https://x/mcp')
})

test('④ ★★★ 组装出来的声明**只含**执行面会读的字段（不靠"对方忽略多余字段"碰巧能跑）', () => {
  const r = bindConnectorTargets({
    declarations: [policy()],
    targets: { github: { command: 'npx' } },
  })
  const bound = r.declarations[0]
  // 控制面那两个字段**不该**被带进来：执行面用 `version` 判断"是不是已声明的"，
  // 带进来会让它走"当成原始输入再声明一次"那条分支——碰巧能跑，但是靠运气。
  assert.equal('version' in bound, false, 'bound 里不该有 version')
  assert.equal('version_label' in bound, false, 'bound 里不该有 version_label')
  assert.deepEqual(
    Object.keys(bound).sort(),
    ['command', 'connectorId', 'policy', 'secretRefs', 'tools', 'transport', 'url'],
  )
})

test('④ ★ 坏输入抛具名码，而不是静默返回空结果', () => {
  const bad = [
    { declarations: 'nope', targets: {} },
    { declarations: [], targets: [] },
    { declarations: [null], targets: {} },
    { declarations: [{ transport: 'stdio' }], targets: {} },   // 缺 connectorId
    { declarations: [policy()], targets: { github: 'nope' } },
  ]
  for (const input of bad) {
    let err = null
    try { bindConnectorTargets(input) } catch (e) { err = e }
    assert.notEqual(err, null, `期望抛错：${JSON.stringify(input)}`)
    assert.equal(err.code, TARGET_BINDING_CODES.BAD_INPUT)
    // ★ 静默返回空结果是最坏的一种：它与"这次没有连接器"同形。
    assert.match(err.message, /（connector-target-binding-bad-input）/)
  }
})

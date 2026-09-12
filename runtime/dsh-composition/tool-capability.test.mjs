// runtime/dsh-composition/tool-capability.test.mjs
// ============================================================================
// PRT-601 的判据。
//
// 这一组盯的**不是**"登记表里有没有 14 个工具"，而是**风险等级能不能被填低**。
//
//   > 一个允许工具把自己的风险等级**填低**的登记表，
//   > 与一个"所有工具都是低风险"的登记表，是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_ERRORS,
  CAPABILITY_IDS,
  CAPABILITY_KINDS,
  CapabilityDeclarationError,
  HARD_FLOOR_CAPABILITIES,
  KNOWN_TOOL_NAMES,
  RISK_LEVELS,
  RISK_RANK,
  TOOL_CATALOG,
  TOOL_CATALOG_CHECKED,
  UNKNOWN_TOOL_RISK,
  assertCatalogConsistent,
  capabilityFacts,
  describeRiskText,
  describeTool,
  maxRisk,
  resolveTool,
  riskFloorOf,
  toolCatalogSnapshot,
} from './tool-capability.mjs'

// ---------------------------------------------------------------- ① 风险是有序的

test('① 四档风险有序，序号单调', () => {
  assert.deepEqual([...RISK_LEVELS], ['low', 'medium', 'high', 'critical'])
  for (let i = 1; i < RISK_LEVELS.length; i += 1) {
    assert.equal(RISK_RANK[RISK_LEVELS[i]] > RISK_RANK[RISK_LEVELS[i - 1]], true)
  }
  assert.equal(RISK_RANK.low, 0)
})

test('① `maxRisk` 取更严的那个，且不认识的输入不降级', () => {
  assert.equal(maxRisk('low', 'high'), 'high')
  assert.equal(maxRisk('critical', 'medium'), 'critical')
  assert.equal(maxRisk('low', 'low'), 'low')
  // 不认识的等级：返回**另一个**，而不是返回那个不认识的
  assert.equal(maxRisk(undefined, 'high'), 'high')
  assert.equal(maxRisk('high', undefined), 'high')
  assert.equal(maxRisk(undefined, undefined), undefined)
})

// ---------------------------------------------------------------- ② 能力事实

test('② 每一种能力都有完整的事实字段（缺一个就会静默按默认走）', () => {
  for (const id of CAPABILITY_IDS) {
    const k = CAPABILITY_KINDS[id]
    assert.ok(RISK_RANK[k.riskFloor] !== undefined, `${id} 的 riskFloor 不认识`)
    assert.ok(k.direction === 'read' || k.direction === 'write', `${id} 的 direction 非法`)
    for (const f of ['externalEffect', 'irreversible', 'hardFloor']) {
      assert.equal(typeof k[f], 'boolean', `${id} 的 ${f} 不是布尔`)
    }
    assert.ok(typeof k.userText === 'string' && k.userText.length > 0, `${id} 没有可读文案`)
  }
})

test('② ★ 硬底线能力与 `permission-engine` 的 `isHardFloor` **是同三个**', () => {
  // 两处各写一份硬底线名单，与"某一条路径上硬底线失效"是同一个东西。
  assert.deepEqual([...HARD_FLOOR_CAPABILITIES].sort(),
    ['credential:write', 'file:delete', 'repo:push'])
})

test('② ★ 写能力一律不比读能力低（同族内单调）', () => {
  const pairs = [
    ['file:read', 'file:write'],
    ['repo:read', 'repo:write'],
    ['network:read', 'network:write'],
    ['external-api:read', 'external-api:write'],
    ['credential:read', 'credential:write'],
  ]
  for (const [read, write] of pairs) {
    assert.ok(
      RISK_RANK[CAPABILITY_KINDS[write].riskFloor] > RISK_RANK[CAPABILITY_KINDS[read].riskFloor],
      `${write} 的下限不高于 ${read}——写操作被当成了读操作`,
    )
  }
})

test('② `riskFloorOf` 取最严的那一项', () => {
  assert.equal(riskFloorOf(['file:read']), 'low')
  assert.equal(riskFloorOf(['file:read', 'file:write']), 'medium')
  assert.equal(riskFloorOf(['file:write', 'command:exec']), 'high')
  assert.equal(riskFloorOf(['command:exec', 'repo:push']), 'critical')
})

test('② ★ `riskFloorOf` 遇到不认识的能力判**最严**（不是 low）', () => {
  assert.equal(riskFloorOf(['file:read', 'weird:magic']), 'critical')
  assert.equal(riskFloorOf(['weird:magic']), 'critical')
})

test('② `capabilityFacts` 聚合方向与副作用', () => {
  const f = capabilityFacts(['file:read'])
  assert.equal(f.direction, 'read')
  assert.equal(f.externalEffect, false)
  assert.equal(f.irreversible, false)
  assert.equal(f.hardFloor, false)

  const w = capabilityFacts(['file:read', 'network:write'])
  assert.equal(w.direction, 'write')
  assert.equal(w.externalEffect, true)

  const d = capabilityFacts(['file:delete'])
  assert.equal(d.hardFloor, true)
  assert.equal(d.irreversible, true)

  assert.equal(capabilityFacts(['weird:magic']).unknown, true)
})

// ---------------------------------------------------------------- ③ ★★ 风险只能往上抬

test('③ ★★ 声明低于下限时，**有效风险被抬到下限**（这是本模块的核心）', () => {
  const tool = describeTool({
    name: 'sneaky-delete', capabilities: ['file:delete'], declaredRisk: 'low',
  })
  assert.equal(tool.declaredRisk, 'low', '作者填的值应当被如实保留下来')
  assert.equal(tool.riskFloor, 'critical')
  assert.equal(tool.risk, 'critical', '一个会删文件的工具被按 low 放行了')
  assert.equal(tool.riskRaised, true)
  assert.equal(tool.requiresApproval, true)
  assert.equal(tool.hardFloor, true)
})

test('③ ★ 声明高于下限时被尊重（抬升不是"一律取下限"）', () => {
  const tool = describeTool({
    name: 'over-cautious', capabilities: ['file:read'], declaredRisk: 'high',
  })
  assert.equal(tool.risk, 'high')
  assert.equal(tool.riskRaised, false)
  assert.equal(tool.requiresApproval, true, 'high 及以上要人批')
})

test('③ 声明与下限相同时不标记为抬升', () => {
  const t = describeTool({ name: 'exact', capabilities: ['file:write'], declaredRisk: 'medium' })
  assert.equal(t.risk, 'medium')
  assert.equal(t.riskRaised, false)
})

test('③ 没填声明时按**下限**走（下限就是"不填"的默认）', () => {
  const t = describeTool({ name: 'no-decl', capabilities: ['command:exec'] })
  assert.equal(t.declaredRisk, null)
  assert.equal(t.risk, 'high')
  assert.equal(t.riskRaised, false)
})

test('③ ★★ **每一种能力**都无法通过填低声明来降低风险', () => {
  // 逐种能力遍历，而不是抽查几个——抽查会漏掉"后来新加的那种能力"。
  for (const id of CAPABILITY_IDS) {
    const t = describeTool({ name: `t-${id}`, capabilities: [id], declaredRisk: 'low' })
    assert.ok(RISK_RANK[t.risk] >= RISK_RANK[CAPABILITY_KINDS[id].riskFloor],
      `能力 ${id} 的下限是 ${CAPABILITY_KINDS[id].riskFloor}，却可以通过声明 low 生效为 ${t.risk}`)
  }
})

test('③ ★ 多能力组合时取最严，且硬底线不会被"另一项很低"冲淡', () => {
  const t = describeTool({
    name: 'mixed', capabilities: ['file:read', 'repo:push'], declaredRisk: 'low',
  })
  assert.equal(t.risk, 'critical')
  assert.equal(t.hardFloor, true)
  assert.equal(t.requiresApproval, true)
})

test('③ `requiresApproval` 对 hardFloor 恒为真，对 low 为假', () => {
  assert.equal(describeTool({ name: 'r', capabilities: ['file:read'] }).requiresApproval, false)
  assert.equal(describeTool({ name: 'd', capabilities: ['file:delete'] }).requiresApproval, true)
  assert.equal(describeTool({ name: 'c', capabilities: ['credential:write'], declaredRisk: 'low' }).requiresApproval, true)
})

test('③ 返回的声明是冻结的，能力列表去重', () => {
  const t = describeTool({
    name: 'dup', capabilities: ['file:read', 'file:read', 'file:write'],
  })
  assert.equal(Object.isFrozen(t), true)
  assert.deepEqual([...t.capabilities], ['file:read', 'file:write'])
})

// ---------------------------------------------------------------- ④ 声明校验

test('④ ★ 空能力被**拒绝**（"什么也不做"与"我们不知道它做什么"长得一样）', () => {
  for (const bad of [[], undefined, null, 'file:read']) {
    assert.throws(
      () => describeTool({ name: 'empty', capabilities: bad }),
      (e) => e instanceof CapabilityDeclarationError && e.code === CAPABILITY_ERRORS.NO_CAPABILITIES,
      `capabilities=${JSON.stringify(bad)} 被接受了`,
    )
  }
})

test('④ ★★ 不认识的能力被拒绝（不能被当成安全能力）', () => {
  assert.throws(
    () => describeTool({ name: 'x', capabilities: ['file:read', 'sudo:everything'] }),
    (e) => e.code === CAPABILITY_ERRORS.UNKNOWN_CAPABILITY,
  )
})

test('④ 没有 name 被拒绝', () => {
  for (const bad of ['', '   ', undefined, null]) {
    assert.throws(() => describeTool({ name: bad, capabilities: ['file:read'] }),
      (e) => e.code === CAPABILITY_ERRORS.BAD_NAME)
  }
})

test('④ 不认识的 `declaredRisk` 被拒绝（不是静默降级成 low）', () => {
  assert.throws(
    () => describeTool({ name: 'x', capabilities: ['file:read'], declaredRisk: 'none' }),
    (e) => e.code === CAPABILITY_ERRORS.UNKNOWN_RISK,
  )
})

test('④ 错误消息里带上"已知的是哪些"，否则作者不知道该怎么改', () => {
  try {
    describeTool({ name: 'x', capabilities: ['nope'] })
    assert.fail('应当抛错')
  } catch (e) {
    for (const id of CAPABILITY_IDS.slice(0, 5)) assert.ok(e.message.includes(id), e.message)
  }
})

// ---------------------------------------------------------------- ⑤ 未登记工具默认最严

test('⑤ ★★ 未登记的工具返回 `critical` 且需要审批（不是"没有风险声明"）', () => {
  const t = resolveTool('some-tool-nobody-registered')
  assert.equal(t.known, false)
  assert.equal(t.risk, UNKNOWN_TOOL_RISK)
  assert.equal(t.risk, 'critical')
  assert.equal(t.requiresApproval, true)
  assert.equal(t.hardFloor, true)
  assert.equal(t.irreversible, true)
  assert.equal(t.externalEffectPossible, true)
})

test('⑤ ★ 兜底等级**不是** low——这正是本模块要防的那个默认', () => {
  assert.notEqual(UNKNOWN_TOOL_RISK, 'low')
  assert.equal(RISK_RANK[UNKNOWN_TOOL_RISK], RISK_RANK.critical)
})

test('⑤ ★ 未知工具的返回形状与已知工具**一致**（调用方不需要第二条分支）', () => {
  const unknown = resolveTool('nope')
  const known = resolveTool('read-file')
  for (const key of Object.keys(known)) {
    assert.ok(key in unknown, `未知工具的返回里缺字段 ${key}——调用方会为它写一条容易忘记的分支`)
  }
  assert.equal(typeof unknown.capabilities.length, 'number')
})

test('⑤ 空名字/`null` 也走未登记那条路（不是崩掉，也不是放行）', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const t = resolveTool(bad)
    assert.equal(t.known, false)
    assert.equal(t.risk, 'critical')
  }
})

test('⑤ 已知工具带上 `known: true`', () => {
  const t = resolveTool('read-file')
  assert.equal(t.known, true)
  assert.equal(t.name, 'read-file')
  assert.equal(t.risk, 'low')
})

// ---------------------------------------------------------------- ⑥ 登记表

test('⑥ 登记表里的每一项都通过校验，且有效风险不低于下限', () => {
  const r = assertCatalogConsistent()
  assert.equal(r.ok, true, JSON.stringify(r.problems))
  assert.deepEqual([...r.problems], [])
})

test('⑥ ★★ 有人手写一张**填低了**的表时，一致性检查必须报出来', () => {
  const forged = {
    'evil-delete': {
      name: 'evil-delete',
      capabilities: ['file:delete'],
      risk: 'low',              // ← 低于 file:delete 的 critical 下限
      hardFloor: false,
      requiresApproval: false,
    },
  }
  const r = assertCatalogConsistent(forged)
  assert.equal(r.ok, false, '一张把删除工具的等级手写成 low 的表被放过了')
  assert.ok(r.problems.some((p) => p.kind === 'risk-below-floor' && p.name === 'evil-delete'),
    JSON.stringify(r.problems))
})

test('⑥ ★ 硬底线却不需要审批的表必须被报出来', () => {
  const forged = {
    x: { name: 'x', capabilities: ['repo:push'], risk: 'critical', hardFloor: true, requiresApproval: false },
  }
  const r = assertCatalogConsistent(forged)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.kind === 'hard-floor-without-approval'))
})

test('⑥ ★ 表里混进非对象条目时也要报出来（不是崩掉，也不是跳过）', () => {
  const r = assertCatalogConsistent({ x: null, y: 'nope', z: 42 })
  assert.equal(r.ok, false)
  assert.ok(r.problems.every((p) => p.kind === 'not-an-object'), JSON.stringify(r.problems))
})

test('⑥ ★★ 加载时自检**真的跑过、且校的是这张表**', () => {
  // 一个可以被人随手写成 `true` 的"通过"标记，与一个恒真的校验，
  // 在"它到底拦不拦得住"上是同一个东西——而能把它写成 `true` 的，
  // 恰恰就是那个把自检删掉的改动。所以断言的是**真正算出来的东西**：
  // 它校过哪些工具，以及它为每个工具算出的下限。
  assert.equal(TOOL_CATALOG_CHECKED.ok, true, '加载时自检没有跑过')
  assert.deepEqual([...TOOL_CATALOG_CHECKED.checkedNames], [...KNOWN_TOOL_NAMES])
  assert.ok(KNOWN_TOOL_NAMES.length > 0)

  // ★ 这一条才是「它真的算了」的证据：`ok: true` 可以随手写，
  //   但每个工具的下限必须由能力现算——想伪造就得把算法再实现一遍。
  assert.equal(typeof TOOL_CATALOG_CHECKED.floors, 'object', '加载时自检没有留下算出来的下限')
  for (const n of KNOWN_TOOL_NAMES) {
    assert.equal(TOOL_CATALOG_CHECKED.floors[n], riskFloorOf(TOOL_CATALOG[n].capabilities),
      `${n} 的现算下限与自检留下的不一致`)
  }
  // 逐项都要在，不能只有一个
  assert.deepEqual(Object.keys(TOOL_CATALOG_CHECKED.floors).sort(), [...KNOWN_TOOL_NAMES].sort())
})

test('⑥ ★ 登记表里**确实存在**被抬升的条目（证明抬升路径不是死代码）', () => {
  const raised = KNOWN_TOOL_NAMES.filter((n) => TOOL_CATALOG[n].riskRaised)
  assert.ok(raised.length >= 1,
    '一张从来没有触发过抬升的登记表，证明不了抬升这条路径是活的')
  for (const n of raised) {
    const t = TOOL_CATALOG[n]
    assert.ok(RISK_RANK[t.risk] > RISK_RANK[t.declaredRisk],
      `${n} 标记为抬升，但生效风险并不高于声明`)
  }
})

test('⑥ 内置表里没有任何一项的风险低于它的下限', () => {
  for (const n of KNOWN_TOOL_NAMES) {
    const t = TOOL_CATALOG[n]
    assert.ok(RISK_RANK[t.risk] >= RISK_RANK[t.riskFloor], `${n}: ${t.risk} < ${t.riskFloor}`)
  }
})

test('⑥ 三个硬底线动作在表里都有对应的工具', () => {
  for (const cap of HARD_FLOOR_CAPABILITIES) {
    const hit = KNOWN_TOOL_NAMES.filter((n) => TOOL_CATALOG[n].capabilities.includes(cap))
    assert.ok(hit.length >= 1, `没有任何工具声明 ${cap}`)
    for (const n of hit) assert.equal(TOOL_CATALOG[n].requiresApproval, true, `${n} 硬底线却不要审批`)
  }
})

// ---------------------------------------------------------------- ⑦ 快照与人话

test('⑦ `describeRiskText` 说清会做什么、风险多高、要不要批', () => {
  const s = describeRiskText(resolveTool('git-push'))
  assert.ok(s.includes('git-push'), s)
  assert.ok(s.includes('极高'), s)
  assert.ok(s.includes('需要人工批准'), s)
  assert.ok(s.includes('不可逆'), s)
})

test('⑦ ★ 未登记工具的文案**明说**它未登记且按最严处理', () => {
  const s = describeRiskText(resolveTool('mystery'))
  assert.ok(s.includes('未登记'), s)
  assert.ok(s.includes('极高'), s)
})

test('⑦ `describeRiskText` 接受已知/未知两种入参', () => {
  assert.ok(describeRiskText(TOOL_CATALOG['read-file']).includes('低'))
  assert.ok(describeRiskText({ name: 'unknown-thing' }).includes('未登记'))
  assert.ok(describeRiskText(null).includes('未登记'))
})

test('⑦ 快照是纯数据、可 JSON、冻结', () => {
  const snap = toolCatalogSnapshot()
  assert.equal(Object.isFrozen(snap), true)
  assert.equal(snap.unknownToolRisk, 'critical')
  assert.deepEqual([...snap.riskLevels], [...RISK_LEVELS])
  assert.deepEqual([...snap.hardFloorCapabilities].sort(), [...HARD_FLOOR_CAPABILITIES].sort())
  const round = JSON.parse(JSON.stringify(snap))
  assert.equal(round.tools.length, KNOWN_TOOL_NAMES.length)
  for (const t of snap.tools) {
    // 快照里不能夹带函数（进了 JSON 会静默变成 undefined）
    for (const v of Object.values(t)) {
      assert.notEqual(typeof v, 'function', `${t.name} 的快照里夹带了函数`)
    }
  }
})

test('⑦ ★ 快照里每一个工具的风险与审批口径**与真表逐项相等**（不能比真表更松）', () => {
  // 只断言 `risk >= riskFloor` 是不够的：把 `risk` 换成 `riskFloor` 时
  // 两者相等，那条断言照样绿——而快照会因此**系统性地更松**。
  for (const t of toolCatalogSnapshot().tools) {
    const real = TOOL_CATALOG[t.name]
    assert.ok(real !== undefined, `快照里出现了真表没有的工具 ${t.name}`)
    assert.equal(t.risk, real.risk, `${t.name} 的快照风险 ${t.risk} 与真表 ${real.risk} 不一致`)
    assert.equal(t.riskFloor, real.riskFloor, `${t.name} 的快照下限不一致`)
    assert.equal(t.requiresApproval, real.requiresApproval, `${t.name} 的快照审批口径不一致`)
    assert.equal(t.hardFloor, real.hardFloor, `${t.name} 的快照硬底线不一致`)
    assert.equal(t.irreversible, real.irreversible, `${t.name} 的快照不可逆标记不一致`)
    assert.equal(t.externalEffectPossible, real.externalEffectPossible, `${t.name} 的外部副作用标记不一致`)
    assert.deepEqual([...t.capabilities], [...real.capabilities], `${t.name} 的快照能力不一致`)
  }
})

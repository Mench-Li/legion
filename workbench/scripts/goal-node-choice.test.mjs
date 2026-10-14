// workbench/scripts/goal-node-choice.test.mjs
// 运行：node --experimental-strip-types workbench/scripts/goal-node-choice.test.mjs
//
// ============================================================================
// 「发布目标时用哪个执行节点」的判定判据。
//
// 这一组守的核心是**一条默认值**：没有可用节点时**不许替用户绑定**。
// 因为绑定是**硬绑定** —— 任务快照写了节点之后，认领路径要求认领方带的
// `agentNodeId` 与它**逐字相等**（`server.mjs:6089` 的 AGENT_NODE_MISMATCH）。
// 而实测本机守护的 `agentNodeId` 是空的、注册节点是 0 ——
// 一旦默认绑定，今天能跑的流水线会**当场全停**。
//
//   > 一个"替用户选好了"的默认值，与一个"用户选好了"的值，
//   > 在**它恰好对**的时候是同一个东西 ——
//   > 区别只在它错的那次，而硬绑定的错法是"整条链一件都领不走"。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bindingWarning,
  crossNodeConflict,
  decideAutoNode,
  describeCrossNodeConflict,
  effectiveNodeId,
  isNodeIdle,
  rankNodesByLoad,
  scanNodes,
} from '../src/goalNodeChoice.ts'

const node = (id, status = 'ready', extra = {}) => ({ id, label: `节点 ${id}`, status, ...extra })
/** 一个"报告了机器与负载"的就绪节点。 */
const ready = (id, machineId, busy = 0, capacity = 2) => ({ id, label: `节点 ${id}`, status: 'ready', machineId, busy, capacity })

describe('扫描执行节点：四种情形', () => {
  test('★ 一个都没登记 ⇒ 不绑定、不弹确认（这是今天就能跑的状态，不是错误）', () => {
    const s = scanNodes([])
    assert.equal(s.kind, 'none-registered')
    assert.equal(s.suggestedNodeId, null, '没有节点可建议 —— 不许编一个出来')
    assert.equal(s.shouldAsk, false, '没得选就不该弹确认')
    assert.match(s.headline, /不绑定节点/)
    assert.match(s.headline, /任一在线/, '要说清"不绑定时也照跑"')
  })

  test('★ 登记了但都没就绪 ⇒ 不绑定，并把"谁没就绪"说出来', () => {
    const s = scanNodes([node('n-a', 'offline'), node('n-b', 'incompatible'), node('n-c', 'disabled')])
    assert.equal(s.kind, 'none-ready')
    assert.equal(s.suggestedNodeId, null)
    assert.equal(s.shouldAsk, false)
    assert.equal(s.notReadyNodes.length, 3)
    assert.match(s.headline, /没有一个就绪/)
    assert.match(s.headline, /n-a:offline/, '要指明是哪个、什么状态')
    assert.match(s.headline, /不绑定节点/)
  })

  test('★ 恰好一个就绪 ⇒ 给建议值，但仍要用户确认（硬绑定的代价见文件头）', () => {
    const s = scanNodes([node('n-a'), node('n-b', 'offline')])
    assert.equal(s.kind, 'single-ready')
    assert.equal(s.suggestedNodeId, 'n-a', '唯一就绪的可以作为建议')
    assert.equal(s.shouldAsk, true, '仍要用户确认 —— 不替他决定')
    assert.equal(s.readyNodes.length, 1)
    assert.equal(s.notReadyNodes.length, 1)
    assert.match(s.headline, /1 个就绪执行节点/)
    assert.match(s.headline, /默认保持不绑定/, '要说清"不点也行"')
  })

  test('★ 多个就绪 ⇒ 这才是真正的选择', () => {
    const s = scanNodes([node('n-a'), node('n-b'), node('n-c', 'offline')])
    assert.equal(s.kind, 'multiple-ready')
    assert.equal(s.readyNodes.length, 2)
    assert.equal(s.suggestedNodeId, null, '两个都就绪时不替用户挑 —— 那才是"选"')
    assert.equal(s.shouldAsk, true)
    assert.match(s.headline, /2 个就绪执行节点/)
    assert.match(s.headline, /同一台/, '要说明整条链只能落在一台上')
  })

  test('脏输入不炸；缺 id 的条目被丢掉（没有 id 就没法绑定）', () => {
    for (const bad of [null, undefined, [], [null], [{}], [{ id: '' }], ['x'], [1]]) {
      assert.doesNotThrow(() => scanNodes(bad))
    }
    assert.equal(scanNodes([{ status: 'ready' }]).kind, 'none-registered', '缺 id 不算一个可绑定的节点')
    assert.equal(scanNodes(null).kind, 'none-registered')
    assert.equal(scanNodes(undefined).kind, 'none-registered')
  })

  test('status 缺失按未就绪处理（不把"不知道"当成"就绪"）', () => {
    const s = scanNodes([{ id: 'n-x' }])
    assert.equal(s.kind, 'none-ready')
    assert.equal(s.notReadyNodes[0].status, undefined)
    assert.match(s.headline, /n-x:unknown/, '缺状态要显示成 unknown，不伪装')
  })
})

describe('绑定的后果提示', () => {
  test('★★ 绑了就要求守护配同一个 agentNodeId —— 必须说出来', () => {
    const w = bindingWarning('n-a')
    assert.ok(w !== null)
    assert.match(w, /agentNodeId/, '要点名那个配置项')
    assert.match(w, /n-a/)
    assert.match(w, /无法认领/, '要说清后果')
    assert.match(w, /配置不一致/, '要写明"重试不会好"')
  })

  test('不绑定 ⇒ 没有额外提示', () => {
    for (const none of [null, undefined, '', '   ']) assert.equal(bindingWarning(none), null)
  })
})

describe('跨节点冲突：要在发布时说清，而不是等认领 409', () => {
  test('★ 工作流自己就要两个节点 ⇒ 报它（与用户选什么无关）', () => {
    const c = crossNodeConflict(['n-a', 'n-b'], null)
    assert.equal(c.kind, 'workflow-internal')
    assert.deepEqual(c.nodeIds, ['n-a', 'n-b'])
    const text = describeCrossNodeConflict(c)
    assert.match(text, /不同节点/)
    assert.match(text, /尚未实现/, '要引用真实原因')
    assert.match(text, /任务不动/, '要说清用户会看到什么')
  })

  test('★ 用户选的与阶段绑的不同 ⇒ 报两者', () => {
    const c = crossNodeConflict(['n-a'], 'n-b')
    assert.equal(c.kind, 'against-choice')
    assert.equal(c.stageNodeId, 'n-a')
    assert.equal(c.chosenNodeId, 'n-b')
    const text = describeCrossNodeConflict(c)
    assert.match(text, /n-b/)
    assert.match(text, /n-a/)
    assert.match(text, /尚未实现/)
  })

  test('一致 / 都不绑 ⇒ 无冲突', () => {
    assert.equal(crossNodeConflict(['n-a'], 'n-a').kind, 'none')
    assert.equal(crossNodeConflict(['n-a', 'n-a'], 'n-a').kind, 'none', '重复的同一个节点不算冲突')
    assert.equal(crossNodeConflict([], 'n-b').kind, 'none', '工作流没绑时用户想绑哪台都行')
    assert.equal(crossNodeConflict([], null).kind, 'none')
    assert.equal(crossNodeConflict([null, undefined, ''], null).kind, 'none')
    assert.equal(describeCrossNodeConflict({ kind: 'none' }), null)
  })

  test('空串/空白节点 id 不算"绑了"', () => {
    assert.equal(crossNodeConflict(['n-a'], '   ').kind, 'none')
    assert.equal(crossNodeConflict(['  ', 'n-a'], '').kind, 'none')
    // 阶段里只有一个有效 id 时不该误报内部冲突
    assert.equal(crossNodeConflict(['n-a', '  ', null], null).kind, 'none')
  })

  test('内部冲突优先于"与所选不符"（先报更根本的那个）', () => {
    const c = crossNodeConflict(['n-a', 'n-b'], 'n-a')
    assert.equal(c.kind, 'workflow-internal', '工作流自己就要两台时，先说这件事')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 自动选择（B 档）。用户的策略：**同机则改派、跨机则排队**。
//
// 判据全部围绕一条：绑定是**硬绑定**（整条链钉在一台上），所以只有"跨机"才值得绑，
// 而"同机"保持不绑定 = 保留抢占式均衡（任何空闲守护都能抢任何任务）。
// ════════════════════════════════════════════════════════════════════════════

describe('自动选择：五档决定', () => {
  test('① 没有就绪节点 ⇒ 不绑（无可绑；与今天一致）', () => {
    for (const input of [[], null, undefined, [node('a', 'offline')], [node('a', 'unknown')], [node('a', 'incompatible')], [node('a', 'disabled')]]) {
      const d = decideAutoNode(input)
      assert.equal(d.kind, 'none-ready', JSON.stringify(input))
      assert.equal(d.nodeId, null)
      assert.match(d.reason, /不绑定节点/)
    }
  })

  test('★★ ② 恰好一个就绪节点 ⇒ 不绑（用户要的"直接分派，无需指定"）', () => {
    const d = decideAutoNode([ready('n-a', 'host-1'), node('n-b', 'offline')])
    assert.equal(d.kind, 'single-ready')
    assert.equal(d.nodeId, null, '★ 刻意不绑 —— 它自然会认领；绑了反而在它掉线时挡死后来者')
    assert.match(d.reason, /只有 1 个就绪执行节点/)
    assert.match(d.reason, /直接认领/)
    // 唯一就绪 + 没有机器标识 也一样（"只有一个"这个事实与机器标识无关）
    assert.equal(decideAutoNode([node('only')]).kind, 'single-ready')
  })

  test('★★ ③ 已经证成跨机 ⇒ 绑最闲的那台（哪怕还有节点没上报）', () => {
    const d = decideAutoNode([
      ready('busy-one', 'host-A', 2, 2),
      ready('idle-one', 'host-B', 0, 2),
      node('unknown-machine'),   // 没上报 —— 但"跨机"已经被前两个证成了
    ])
    assert.equal(d.kind, 'cross-machine')
    assert.equal(d.nodeId, 'idle-one', '挑最闲的')
    assert.deepEqual(d.machines, ['host-A', 'host-B'])
    assert.match(d.reason, /跨了 2 台机器/)
    assert.match(d.reason, /未上报机器标识/, '要把"有节点没上报"这件事说出来，但**不因此放弃绑定**')
  })

  test('★★ ④ 全在同一台机器 ⇒ 不绑（同机 ⇒ 改派）', () => {
    const d = decideAutoNode([ready('n-a', 'host-1', 0, 2), ready('n-b', 'host-1', 2, 2)])
    assert.equal(d.kind, 'same-machine')
    assert.equal(d.nodeId, null, '★ 同机不绑 —— 抢占式均衡比静态指派更能吃满并发')
    assert.deepEqual(d.machines, ['host-1'])
    assert.match(d.reason, /同一台机器/)
    assert.match(d.reason, /谁空闲谁认领/)
  })

  test('★★ ⑤ 判不清（只有一台已知机器 + 有节点没上报）⇒ 不绑，并说明为什么', () => {
    const d = decideAutoNode([ready('n-a', 'host-1'), node('n-unknown')])
    assert.equal(d.kind, 'machine-unknown')
    assert.equal(d.nodeId, null)
    assert.match(d.reason, /没上报机器标识/)
    assert.match(d.reason, /手动指定/, '判不清时要把决定权交回给用户')
    // 全都没上报机器标识也走这一档
    assert.equal(decideAutoNode([node('a'), node('b')]).kind, 'machine-unknown')
  })

  test('★★ 跨机 + 都忙 ⇒ 仍然绑定并说明"排队等待"（用户选的语义）', () => {
    const d = decideAutoNode([ready('a', 'host-A', 2, 2), ready('b', 'host-B', 2, 2)])
    assert.equal(d.kind, 'cross-machine')
    assert.notEqual(d.nodeId, null, '都忙也要绑 —— 跨机时"排队等它"优于"跨机乱跑"')
    assert.match(d.reason, /都忙/)
    assert.match(d.reason, /排队等待/)
  })

  test('★ 空白机器标识视作"未知"（不是"叫空名字的机器"）', () => {
    for (const m of ['', '   ', null, undefined]) {
      assert.equal(decideAutoNode([ready('a', m), ready('b', m)]).kind, 'machine-unknown', JSON.stringify(m))
    }
    // 两侧空白要去掉，否则同一台机器会被拆成两台 ⇒ 误判成跨机 ⇒ 白白绑定
    assert.equal(decideAutoNode([ready('a', ' host-1 '), ready('b', 'host-1')]).kind, 'same-machine')
  })

  test('★ 机器标识**刻意不做大小写归一** —— 判成"跨机"（保守方向）', () => {
    // 两个方向的错误代价**不对等**：
    //   · 同一台被误判成跨机 ⇒ 多余绑定：丢掉抢占式均衡，但任务照跑得动；
    //   · 跨机被误判成同一台 ⇒ 整条链横跨两台 = **未实现场景**，任务 409 卡住。
    // 后者贵得多，所以这里**保守**：字符串不同就当成不同机器（⇒ 倾向绑定）。
    //
    //   > 一个"尽可能合并"的判断，与一个"尽可能区分"的判断，
    //   > 在**两边的错误一样贵**的时候才是等价的选择。
    const d = decideAutoNode([ready('a', 'HOST-1'), ready('b', 'host-1')])
    assert.equal(d.kind, 'cross-machine', '大小写不同 ⇒ 按跨机处理（宁可多绑，不可跨机）')
    // 而**逐字相同**必须判同机 —— 否则一台机器会被自己的两次心跳拆成两台，白白绑定
    assert.equal(decideAutoNode([ready('a', 'host-1'), ready('b', 'host-1')]).kind, 'same-machine')
    // 连"只差一个字符"（这里是连字符 vs 空格）也按跨机 —— 与大小写同一条纪律
    assert.equal(decideAutoNode([ready('a', 'host-1'), ready('b', 'host 1')]).kind, 'cross-machine')
  })
})

describe('自动选择：按负载排序', () => {
  test('★★ 忙闲**未知**的节点必须排在"确实空闲"之后（不许把最不可信的排第一）', () => {
    const ranked = rankNodesByLoad([
      { id: 'unknown-load' },                        // 没有 busy/capacity
      ready('idle', 'h', 0, 4),
      ready('half', 'h', 2, 4),
      ready('full', 'h', 4, 4),
    ])
    assert.deepEqual(ranked.map((n) => n.id), ['idle', 'half', 'full', 'unknown-load'],
      '未知负载要排最后 —— 它可能是已经失联的机器')
  })

  test('★ 同负载时按 busy 升序、再按 id 稳定收尾（不许同分抖动）', () => {
    const a = rankNodesByLoad([ready('z', 'h', 1, 2), ready('a', 'h', 1, 2)])
    assert.deepEqual(a.map((n) => n.id), ['a', 'z'], 'id 升序收尾')
    const b = rankNodesByLoad([ready('m', 'h', 3, 4), ready('n', 'h', 1, 4)])
    assert.deepEqual(b.map((n) => n.id), ['n', 'm'])
    // 反复排序结果必须一致（否则每次发布会挑到不同的节点）
    const first = rankNodesByLoad([ready('p', 'h', 1, 2), ready('q', 'h', 1, 2), ready('r', 'h', 1, 2)]).map((n) => n.id)
    const again = rankNodesByLoad([ready('r', 'h', 1, 2), ready('p', 'h', 1, 2), ready('q', 'h', 1, 2)]).map((n) => n.id)
    assert.deepEqual(first, again)
  })

  test('★ isNodeIdle：只有**可信且没跑满**才算空闲', () => {
    assert.equal(isNodeIdle(ready('a', 'h', 0, 2)), true)
    assert.equal(isNodeIdle(ready('a', 'h', 1, 2)), true)
    assert.equal(isNodeIdle(ready('a', 'h', 2, 2)), false, '跑满不算空闲')
    assert.equal(isNodeIdle({ id: 'x' }), false, '★ 未知不算空闲（否则会把失联机器当空闲）')
    assert.equal(isNodeIdle({ id: 'x', busy: 0 }), false, 'capacity 未知也不算')
    assert.equal(isNodeIdle({ id: 'x', busy: 0, capacity: 0 }), false, 'capacity=0 是坏数据，不算')
    assert.equal(isNodeIdle({ id: 'x', busy: 0, capacity: 3 }), true)
  })
})

describe('手动指定优先于自动', () => {
  test('★★ 有手动选择 ⇒ 用手动；没有 ⇒ 用自动决定', () => {
    const auto = decideAutoNode([ready('a', 'host-A', 0, 2), ready('b', 'host-B', 2, 2)])
    assert.equal(auto.nodeId, 'a')
    assert.equal(effectiveNodeId('manual-x', auto), 'manual-x', '★ 手动永远压过自动（自动是为了省事，不是夺走控制权）')
    assert.equal(effectiveNodeId('', auto), 'a', '空串 = 没指定 ⇒ 用自动')
    assert.equal(effectiveNodeId('   ', auto), 'a', '空白 = 没指定')
    assert.equal(effectiveNodeId(null, auto), 'a')
    assert.equal(effectiveNodeId(undefined, auto), 'a')
    assert.equal(effectiveNodeId('  manual-x  ', auto), 'manual-x', '要去空白')
    // 自动决定不绑时，手动仍然可以绑
    const unbound = decideAutoNode([ready('a', 'host-1')])
    assert.equal(unbound.nodeId, null)
    assert.equal(effectiveNodeId('a', unbound), 'a', '判不清/同机时，用户仍可手动钉一台')
  })

  test('脏输入不炸', () => {
    for (const bad of [[], null, undefined, [null], [{}], ['x'], [1]]) {
      assert.doesNotThrow(() => decideAutoNode(bad))
    }
    assert.equal(decideAutoNode([{ status: 'ready' }]).kind, 'none-ready', '缺 id 不算可绑节点')
  })
})

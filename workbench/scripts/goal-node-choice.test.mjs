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
  describeCrossNodeConflict,
  scanNodes,
} from '../src/goalNodeChoice.ts'

const node = (id, status = 'ready', extra = {}) => ({ id, label: `节点 ${id}`, status, ...extra })

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

// orchestrator/pipeline/pipeline.test.mjs
// ============================================================================
// 岗位、流水线与团队快照（PRT-305）的用例
//
// 这一组问的是「下一岗位是谁」。判错的两种方向**都不报错**：
//   - 判成"没有下一岗位" → 静默掐断任务链，直到整个目标停住才被发现；
//   - 判成"还有下一岗位" → 创建一个没有承接方的任务，它永远没人领。
// 因此用例的重点不在"正常链走对"，而在**边界**：链尾、链断、岗位被停用、
// 岗位改名、自我循环、以及"上一环没留结论"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PIPELINE_ERRORS,
  PipelineError,
  buildHandoffTask,
  handoffDescription,
  handoffTitle,
  indexStages,
  pipelineView,
  resolveNextPost,
} from './index.mjs'

const stage = (role, next, extra = {}) => ({ role, label: `岗位-${role}`, next, enabled: true, ...extra })

/** 一条三岗位的链：analyst → coder → tester（tester 是链尾）。 */
const CHAIN = [stage('analyst', 'coder'), stage('coder', 'tester'), stage('tester', null)]

test('① 正常链：中间岗位有下一岗位，链尾没有', () => {
  const a = resolveNextPost({ stages: CHAIN, role: 'analyst' })
  assert.equal(a.ok, true)
  assert.equal(a.hasNext, true)
  assert.equal(a.nextRole, 'coder')
  assert.equal(a.nextLabel, '岗位-coder')

  const t = resolveNextPost({ stages: CHAIN, role: 'tester' })
  assert.equal(t.ok, true)
  assert.equal(t.hasNext, false, 'tester 是链尾')
  assert.equal(t.nextRole, null)
})

test('② 链断：next 指向不存在的岗位 → 报错而**不是**链尾', () => {
  // 这是本模块最重要的一条。数据上"链断"与"链尾"长得一模一样
  // （都表现为"查不到下一岗位"），而后者是正常的、前者是配置错误。
  // 当成链尾 → 任务在 Completed 收口，整条链静默断在这里。
  const broken = [stage('analyst', 'codeer'), stage('coder', 'tester'), stage('tester', null)]
  const r = resolveNextPost({ stages: broken, role: 'analyst' })
  assert.equal(r.ok, false, '链断必须报错')
  assert.equal(r.code, PIPELINE_ERRORS.UNKNOWN_ROLE)
  assert.deepEqual({ ...r.brokenEdge }, { from: 'analyst', to: 'codeer' })
  assert.match(r.message, /codeer/)
  assert.match(r.message, /不是链尾|配置坏了/)
})

test('② 岗位被停用 → 同样是链断（不只是"没这个岗位"）', () => {
  // 停用一个中间岗位的后果与拼错 next 一样：链在这里断了。
  const disabled = [stage('analyst', 'coder'), stage('coder', 'tester', { enabled: false }), stage('tester', null)]
  const r = resolveNextPost({ stages: disabled, role: 'analyst' })
  assert.equal(r.ok, false)
  assert.equal(r.code, PIPELINE_ERRORS.UNKNOWN_ROLE)
  assert.match(r.message, /不存在或已被停用/)
})

test('② 当前岗位被停用/改名 → 报错而**不是**当链尾', () => {
  // 岗位改名（或停用）后，老任务上记的还是旧 role。
  // 当成链尾会让这条本来还有后续的任务静默停在 Completed。
  const r = resolveNextPost({ stages: [stage('coder', null)], role: 'analyst' })
  assert.equal(r.ok, false)
  assert.equal(r.code, PIPELINE_ERRORS.UNKNOWN_ROLE)
  assert.match(r.message, /不在本空间的流水线里/)
  assert.match(r.message, /不默认成链尾/)
})

test('② 任务没记岗位 → 报错，不猜', () => {
  for (const role of ['', null, undefined, 42]) {
    const r = resolveNextPost({ stages: CHAIN, role })
    assert.equal(r.ok, false, `role=${JSON.stringify(role)} 必须报错`)
    assert.equal(r.code, PIPELINE_ERRORS.UNKNOWN_ROLE)
  }
})

test('③ pipelineView 把「故意链尾」与「断链」分开报出来', () => {
  const mixed = [
    stage('analyst', 'coder'),
    stage('coder', 'tester'),
    stage('tester', null),          // 故意链尾
    stage('orphan', 'ghost'),       // 断链
    stage('off', 'coder', { enabled: false }),
  ]
  const v = pipelineView(mixed)
  assert.deepEqual([...v.roles], ['analyst', 'coder', 'tester', 'orphan'], '停用的岗位不进表')
  assert.deepEqual([...v.tailRoles], ['tester'])
  assert.deepEqual(v.brokenEdges.map((e) => `${e.from}->${e.to}`), ['orphan->ghost'])
})

test('③ stages 不是数组 → 报错（不得当成"没有岗位"）', () => {
  // 当成空流水线时**所有**任务都会被判成链尾——一次读失败会静默掐断所有链。
  for (const bad of [null, undefined, 'analyst', 42, {}]) {
    assert.throws(() => pipelineView(bad),
      (e) => e instanceof PipelineError && e.code === PIPELINE_ERRORS.NO_SUCH_SCOPE,
      `stages=${JSON.stringify(bad)} 必须拒绝`)
  }
})

test('③ 没有 next 字段与 next 为空串等价（都是链尾）', () => {
  const r1 = resolveNextPost({ stages: [{ role: 'a', label: 'A' }], role: 'a' })
  assert.equal(r1.ok, true)
  assert.equal(r1.hasNext, false)
  const r2 = resolveNextPost({ stages: [{ role: 'a', label: 'A', next: '' }], role: 'a' })
  assert.equal(r2.hasNext, false)
})

test('④ 交接任务：parent 是幂等键，goalId/priority/scope 继承', () => {
  const prevTask = { id: 'T-1', title: '【分析】做一件事', description: '目标描述', role: 'analyst', priority: 'high', scope: 'sp1', goalId: 'G-9' }
  const { task } = buildHandoffTask({ prevTask, nextStage: stage('coder', 'tester'), stages: CHAIN, prevSummary: '✓ 分析完了' })
  assert.equal(task.parent, 'T-1', 'parent 必须是上一环任务 id——它是重放时不变的幂等键')
  assert.equal(task.role, 'coder')
  assert.equal(task.status, 'todo')
  assert.equal(task.priority, 'high')
  assert.equal(task.scope, 'sp1')
  assert.equal(task.goalId, 'G-9')
  assert.equal(task.title, '【岗位-coder】做一件事')
  assert.match(task.description, /\[前序阶段\] 岗位-analyst（analyst）已完成：✓ 分析完了/)
  assert.match(task.description, /\[本阶段\] 岗位-coder（coder）/)
})

test('④ 标题沿用上一环但换掉阶段标签；没有标签时补一个', () => {
  assert.equal(handoffTitle('【分析】X', '岗位-coder'), '【岗位-coder】X')
  assert.equal(handoffTitle('没有标签的标题', '岗位-coder'), '【岗位-coder】没有标签的标题')
  // 标签出现在中间时不换（只换开头那个），否则会改到正文
  assert.equal(handoffTitle('前缀【分析】X', '岗位-coder'), '【岗位-coder】前缀【分析】X')
  assert.equal(handoffTitle(null, '岗位-coder'), '【岗位-coder】')
})

test('④ 描述基于**原始目标**重写，不叠加：交接多次也不会越来越长', () => {
  // 一条任务被交接多次时，每次都基于原始目标重写。
  // 叠加会让描述每转一手就长一截，最后没人看得懂要做什么。
  const once = handoffDescription({
    description: '目标描述', prevLabel: 'A', prevRole: 'a', nextLabel: 'B', nextRole: 'b', prevSummary: 's1',
  })
  const twice = handoffDescription({
    description: once, prevLabel: 'B', prevRole: 'b', nextLabel: 'C', nextRole: 'c', prevSummary: 's2',
  })
  assert.equal(twice.match(/\[本阶段\]/g).length, 1, '只能有一个 [本阶段]')
  assert.equal(twice.match(/\[前序阶段\]/g).length, 1, '只能有一个 [前序阶段]（旧的那段被替换掉）')
  assert.match(twice, /\[本阶段\] C（c）/)
  assert.ok(!twice.includes('A（a）'), '上一手的 [前序阶段] 不得累积')
  assert.ok(twice.startsWith('目标描述'), '原始目标必须原样保留在最前面')
})

test('④ 上一环没有收口结论时**明说**，而不是省略整行', () => {
  // 省略会让下一岗位以为交接没发生过，于是它不会去问"上一环到底做完了什么"。
  for (const s of [null, undefined, '', '   ']) {
    const d = handoffDescription({ description: 'x', prevLabel: 'A', prevRole: 'a', nextLabel: 'B', nextRole: 'b', prevSummary: s })
    assert.match(d, /\(上一阶段未留下收口结论\)/)
  }
})

test('⑤ 自我循环的 next → 抛错（那会造出永不收敛的任务链）', () => {
  // next 指回自己时，每一环都再建一次，链永不收敛。
  const selfLoop = [stage('a', 'a')]
  assert.throws(
    () => buildHandoffTask({ prevTask: { id: 'T-1', role: 'a', title: 't' }, nextStage: stage('a', 'a'), stages: selfLoop }),
    (e) => e instanceof PipelineError && /自我繁殖链/.test(e.message))
})

test('⑤ buildHandoffTask 缺关键字段 → 抛错，不猜', () => {
  const next = stage('coder', 'tester')
  for (const bad of [null, undefined, {}, { id: '' }, 'T-1']) {
    assert.throws(() => buildHandoffTask({ prevTask: bad, nextStage: next, stages: CHAIN }),
      (e) => e instanceof PipelineError, `prevTask=${JSON.stringify(bad)} 必须拒绝`)
  }
  for (const bad of [null, undefined, {}, { role: '' }, 'coder']) {
    assert.throws(() => buildHandoffTask({ prevTask: { id: 'T-1' }, nextStage: bad, stages: CHAIN }),
      (e) => e instanceof PipelineError, `nextStage=${JSON.stringify(bad)} 必须拒绝`)
  }
})

test('⑤ 上一环没记岗位时不抛错，但描述里如实写明"未知岗位"', () => {
  // 没记 role 的任务在收口时会被 resolveNextPost 拦下；
  // 但若调用方已经知道下一岗位（人工指定），拼装本身应当能做完，
  // 且不得把"未知"伪装成一个具体岗位名。
  const { task } = buildHandoffTask({
    prevTask: { id: 'T-1', title: 'X', description: 'd', priority: 'low' },
    nextStage: stage('coder', 'tester'), stages: CHAIN,
  })
  assert.equal(task.role, 'coder')
  assert.match(task.description, /未知岗位/)
  assert.equal(task.priority, 'low')
  assert.equal(task.scope, 'default', '没记 scope 时用默认值')
})

test('⑥ indexStages 跳过不完整/停用的行，但保留顺序信息', () => {
  const byRole = indexStages([stage('a', 'b'), { role: '' }, null, { label: 'no role' }, stage('c', null, { enabled: false })])
  assert.deepEqual([...byRole.keys()], ['a'])
})

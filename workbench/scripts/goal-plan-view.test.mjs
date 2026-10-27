// workbench/scripts/goal-plan-view.test.mjs
// ---------------------------------------------------------------------------
// `goalPlanView.ts` 的判据（T1.2 / T1.4）。
//
// 这一组问的是三件**看起来都正常**的事：
//   ① "还没有读数" 会不会被画成 "不可用"；
//   ② 每一行能不能回答 "为什么是它"（没有这一列，用户改完看不出生效没有）；
//   ③ blockers 与 warnings 会不会被混成一句提示。
//
// 运行：node workbench/scripts/goal-plan-view.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSIGNMENT_SOURCE_LABELS, goalPlanView, publishGate, stageReadiness,
} from '../src/goalPlanView.ts'

const plan = (over = {}) => ({
  ok: true,
  scope: 'software',
  orchestration: 'pipeline',
  pipelineVersion: 'v-eight',
  stages: [
    { role: 'requirement', label: '需求澄清', next: 'coder', gate: true, assignment: { source: 'goal-agent', agentToolConfig: { id: 'tool.codex', version: 2 }, modelConfig: null, nodeId: null } },
    { role: 'coder', label: '编码', next: 'reviewer', assignment: { source: 'publish-override', agentToolConfig: { id: 'tool.dsh', version: 1 }, modelConfig: { id: 'model.fast', version: 3 }, nodeId: 'node-a' } },
    { role: 'reviewer', label: '审查', next: null, assignment: { source: 'dsh-default', agentToolConfig: null, modelConfig: null, nodeId: null } },
  ],
  review: null,
  effectiveNodeId: null,
  goalAgent: { agentToolConfig: { id: 'tool.codex', version: 2 } },
  warnings: [],
  blockers: [],
  publishable: true,
  ...over,
})

test('① ★★★ 每张卡片都要回答"为什么是它"：六种 source 各有可读文案', () => {
  const view = goalPlanView(plan())
  assert.deepEqual(view.stages.map((s) => s.sourceLabel), ['继承目标级', '本节点指定', 'DSH 默认'])
  // 六种来源都必须能被翻译；漏一种就会在界面上露出原始英文码。
  for (const code of ['publish-override', 'goal-agent', 'definition', 'space-review-workflow', 'space-stage', 'dsh-default']) {
    assert.equal(typeof ASSIGNMENT_SOURCE_LABELS[code], 'string', `★ 缺少 ${code} 的中文文案`)
    assert.doesNotMatch(ASSIGNMENT_SOURCE_LABELS[code], /[a-z]-[a-z]/, '★ 文案里不许留原始码')
  }
})

test('② ★★★ "还没有读数" 不许被画成 "不可用"', () => {
  const unknown = stageReadiness(null)
  assert.equal(unknown.state, 'unknown')
  assert.match(unknown.detail, /不代表不可用/, '★★ 这句话是这一档的全部意义')

  const ready = stageReadiness(true)
  assert.equal(ready.state, 'ready')
  const notReady = stageReadiness(false, 'Codex 未登录')
  assert.equal(notReady.state, 'not-ready')
  assert.match(notReady.detail, /Codex 未登录/, '★ 不就绪必须带原因')

  // 三档两两不同：把 unknown 与 not-ready 合并会让"没探过"看起来像"探过且失败"。
  assert.notEqual(unknown.state, notReady.state)
  assert.notEqual(unknown.detail, notReady.detail)
})

test('③ ★★★ blockers 与 warnings 分开：前者拦发布，后者只提示', () => {
  const withWarning = goalPlanView(plan({ warnings: [{ code: 'AGENT_PLAN_NEXT_MISMATCH', message: 'next 对不上' }] }))
  assert.equal(withWarning.warnings.length, 1)
  assert.equal(withWarning.blockers.length, 0)
  assert.equal(withWarning.publishable, true, '★ 只有警告不拦发布')
  assert.equal(publishGate(withWarning).enabled, true)

  const withBlocker = goalPlanView(plan({
    blockers: [{ code: 'AGENT_NODE_NOT_READY', message: '执行节点未就绪：node-a' }],
    publishable: false,
  }))
  assert.equal(withBlocker.publishable, false)
  const gate = publishGate(withBlocker)
  assert.equal(gate.enabled, false)
  assert.match(gate.reason, /执行节点未就绪/, '★ 禁用原因必须是那条 blocker 本身，不是笼统的"配置有误"')
})

test('④ 没有计划时禁用发布，且说明在读取——不是"没有阶段"', () => {
  const gate = publishGate(null)
  assert.equal(gate.enabled, false)
  assert.match(gate.reason, /读取/)
  assert.equal(goalPlanView(null), null, '★ null 进 null 出：不要凭空造一个空计划')
})

test('⑤ 外部 Agent 的模型显示「不适用」，DSH 才显示模型引用', () => {
  const view = goalPlanView(plan(), { 'tool.codex': 'Codex', 'tool.dsh': 'DSH 执行服务' })
  const [requirement, coder, reviewer] = view.stages
  assert.match(requirement.agent, /Codex/, '★ 配置名要能翻译成产品名')
  assert.match(requirement.agent, /tool\.codex@2/, '★ 同时保留 id@version 便于核对')
  assert.equal(requirement.model, '不适用', '★★ 外部 Agent 按原生模型跑，阶段级模型对它无效')
  assert.equal(coder.model, 'model.fast@3')
  // DSH 默认（没有冻结工具）时，模型栏留空——不编一句"默认模型"出来。
  assert.equal(reviewer.agent, 'DSH 默认')
  assert.equal(reviewer.model, '')
  assert.equal(reviewer.node, '自动')
})

test('⑥ 依赖用文字不用连线：首环说"起点"，其余说"等待前 1 个阶段"', () => {
  const view = goalPlanView(plan())
  assert.match(view.stages[0].waitingOn, /起点/)
  assert.match(view.stages[1].waitingOn, /等待/)
  // 默认 pipeline 是线性链：画图会暗示并行，而它不会并行。
  assert.doesNotMatch(view.stages[1].waitingOn, /并行/)
})

test('⑦ 目标级选择要能回显；没有时是空串而不是 undefined 文案', () => {
  assert.equal(goalPlanView(plan()).goalAgentLabel, 'tool.codex@2')
  assert.equal(goalPlanView(plan({ goalAgent: null })).goalAgentLabel, '')
})

test('⑧ 空编队是既有合法态：可以发布，但要说清"不会生成任务链"', () => {
  const view = goalPlanView(plan({ stages: [], publishable: true }))
  assert.equal(view.stages.length, 0)
  const gate = publishGate(view)
  assert.equal(gate.enabled, true)
  assert.match(gate.reason, /不会生成任务链/, '★★ 空编队不是错误，但必须说清后果')
})

test('⑨ 服务端没给 `publishable` 时按 blockers 退化判断（两处都要"没 blocker 才能发"）', () => {
  const withoutFlag = goalPlanView(plan({ publishable: undefined, blockers: [] }))
  assert.equal(withoutFlag.publishable, true)
  const withBlocker = goalPlanView(plan({ publishable: undefined, blockers: [{ code: 'X', message: 'y' }] }))
  assert.equal(withBlocker.publishable, false)
})

test('⑩ orchestration 说法要准确：pipeline 说"按空间流水线"，custom-dag 说"按定义拓扑"', () => {
  assert.match(goalPlanView(plan()).headline, /按空间流水线/)
  assert.match(goalPlanView(plan({ orchestration: 'custom-dag' })).headline, /按定义拓扑/)
})

test('⑪ ★★★ 决策 #2：自审提示只提示、不拦发布', () => {
  const selfReview = {
    same: 'spawn',
    note: '审查阶段与实现阶段使用同一个 Agent（spawn），语义审查不具备交叉验证性质；'
      + 'Legion 的独立测试回执不受影响（仍由冻结 runner 独立执行）。',
  }
  const withSelfReview = goalPlanView(plan({ selfReview }))
  assert.equal(withSelfReview.selfReviewNote, selfReview.note)
  // ★★ 关键：有自审提示时**仍然可发布**。拦了就等于否掉「整条目标一个 Agent」这个能力。
  assert.equal(withSelfReview.publishable, true, '★★ 自审是提示，不是拦截')
  assert.equal(publishGate(withSelfReview).enabled, true)

  // 没有自审时是 null（不是空串——空串会让界面渲染一个空的警示框）。
  assert.equal(goalPlanView(plan()).selfReviewNote, null)
  // 服务端没给 note 时也要落成 null，不许把 undefined 传进渲染。
  assert.equal(goalPlanView(plan({ selfReview: { same: 'x', note: '' } })).selfReviewNote, null)
})

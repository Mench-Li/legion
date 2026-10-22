// orchestrator/assignment/index.test.mjs
// 「软件流水线 × Agent 分配」纯解析层的判据。
//
// 这一组问的不是「8 个阶段能不能建出来」，而是**两件事有没有真的拆开**：
//   · 阶段集合只来自流水线（编排定义不能删减它）；
//   · 编排定义只贡献分配（未覆盖的岗位必须是 DSH 默认，而不是消失）。
//
// 这两条在「定义恰好等于流水线」时看不出区别 —— 而那正是 T-212 之前所有
// 用例的形状。所以这里的样本刻意让**定义比流水线短**。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSIGNMENT_SOURCES, PLAN_CODES, PLAN_WARNINGS,
  buildPipelineWorkflow, isGoalPlan, planGoal,
  resolveAssignments, resolveEffectiveNode, resolvePipelineStages, resolveReviewPolicy,
} from './index.mjs'

const stage = (role, extra = {}) => ({ role, label: `阶段-${role}`, next: null, gate: false, artifact: null, sort: 0, enabled: true, ...extra })
const rosterRole = (role) => ({ role, name: `员工-${role}`, kind: 'agent' })

/** 八岗位流水线：requirement → researcher → breaker → test-designer → coder → reviewer → tester → devops。 */
function eightStagePipeline() {
  const roles = ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops']
  return {
    scope: 'software',
    version: 'v-eight',
    workflow: null,
    stages: roles.map((role, index) => stage(role, { sort: index, next: roles[index + 1] ?? null })),
  }
}

/** T-212 现场的三阶段定义：只覆盖三个岗位。 */
const shortDefinition = Object.freeze({
  designRole: 'requirement',
  implementationRole: 'coder',
  reviewRole: 'reviewer',
  maxReworkRounds: 2,
  stageTools: Object.freeze({
    requirement: Object.freeze({ agentToolConfig: { id: 'tool.claude-code', version: 1 }, modelConfig: null, nodeId: null, testRunner: null }),
    coder: Object.freeze({ agentToolConfig: { id: 'tool.dsh-spawn', version: 2 }, modelConfig: null, nodeId: 'desktop-software', testRunner: { executable: 'node', args: ['--test'], timeoutMs: 900000 } }),
    reviewer: Object.freeze({ agentToolConfig: { id: 'tool.codex', version: 1 }, modelConfig: null, nodeId: 'desktop-software', testRunner: null }),
  }),
})

test('① 阶段集合只来自流水线：定义只覆盖三岗，链仍然是八岗', () => {
  const plan = planGoal({
    pipeline: eightStagePipeline(),
    roster: ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'].map(rosterRole),
    profile: shortDefinition,
    profileSource: 'definition',
  })
  assert.deepEqual(plan.pipeline.stages.map((item) => item.role),
    ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'],
    '★ 定义删减不了流水线：researcher / breaker / test-designer / tester / devops 必须还在')
  assert.equal(plan.workflow.topologicalStageIds.length, 8)
  assert.deepEqual(plan.workflow.workflowDefinitionSnapshot.edges, [
    { from: 'requirement', to: 'researcher' },
    { from: 'researcher', to: 'breaker' },
    { from: 'breaker', to: 'test-designer' },
    { from: 'test-designer', to: 'coder' },
    { from: 'coder', to: 'reviewer' },
    { from: 'reviewer', to: 'tester' },
    { from: 'tester', to: 'devops' },
  ])
})

test('② 未覆盖的岗位是**DSH 默认**，不是"没有这个人"', () => {
  const plan = planGoal({
    pipeline: eightStagePipeline(),
    roster: ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'].map(rosterRole),
    profile: shortDefinition,
    profileSource: 'definition',
  })
  for (const role of ['researcher', 'breaker', 'test-designer', 'tester', 'devops']) {
    assert.deepEqual(plan.assignments[role], {
      source: ASSIGNMENT_SOURCES.DSH_DEFAULT,
      agentToolConfig: null, modelConfig: null, nodeId: null, testRunner: null,
    }, `★ ${role} 必须是显式的 dsh-default：留空会让"没配"与"没读到"长得一模一样`)
  }
  assert.equal(plan.assignments.requirement.source, 'definition')
  assert.equal(plan.assignments.requirement.agentToolConfig.id, 'tool.claude-code')
})

test('③ 空间阶段配置的优先级低于分配模板，高于 DSH 默认', () => {
  const pipeline = {
    scope: 's', version: 'v', workflow: null,
    stages: [
      stage('a', { agentToolConfig: { id: 'tool.space-a', version: 1 }, modelConfig: null }),
      stage('b', { agentToolConfig: { id: 'tool.space-b', version: 1 }, modelConfig: null }),
      stage('c'),
    ],
  }
  const profile = { designRole: 'a', implementationRole: 'b', reviewRole: 'c', maxReworkRounds: 1,
    stageTools: { a: { agentToolConfig: { id: 'tool.profile-a', version: 3 }, testRunner: null } } }
  const assignments = resolveAssignments({
    stages: resolvePipelineStages({ pipeline, roster: ['a', 'b', 'c'].map(rosterRole) }).stages,
    profile,
  }).assignments
  assert.equal(assignments.a.agentToolConfig.id, 'tool.profile-a', '模板覆盖空间阶段配置')
  assert.equal(assignments.b.agentToolConfig.id, 'tool.space-b', '模板没写的岗位回落空间阶段配置')
  assert.equal(assignments.c.source, 'dsh-default')
  assert.equal(assignments.c.agentToolConfig, null)
})

test('④ 定义了流水线没有的岗位：忽略该条并告警（不再让发布失败）', () => {
  const pipeline = { scope: 's', version: 'v', workflow: null, stages: [stage('a'), stage('b')] }
  const profile = { designRole: 'a', implementationRole: 'b', reviewRole: 'b',
    stageTools: { a: { agentToolConfig: null }, ghost: { agentToolConfig: { id: 'tool.ghost', version: 1 } } } }
  const out = resolveAssignments({ stages: resolvePipelineStages({ pipeline, roster: ['a', 'b'].map(rosterRole) }).stages, profile })
  assert.equal(out.assignments.ghost, undefined)
  assert.deepEqual(out.warnings.map((item) => item.code), [PLAN_WARNINGS.PROFILE_STAGE_UNKNOWN])
})

test('⑤ 停用一个中间岗位：链按 sort 收敛，next 对不上只告警、不拦发布', () => {
  const pipeline = {
    scope: 's', version: 'v', workflow: null,
    stages: [
      stage('a', { sort: 0, next: 'b' }),
      stage('b', { sort: 1, next: 'c', enabled: false }),
      stage('c', { sort: 2, next: null }),
    ],
  }
  const out = resolvePipelineStages({ pipeline, roster: ['a', 'b', 'c'].map(rosterRole) })
  assert.deepEqual(out.stages.map((item) => item.role), ['a', 'c'])
  assert.equal(out.warnings.length, 1)
  assert.equal(out.warnings[0].code, PLAN_WARNINGS.PIPELINE_NEXT_MISMATCH)
})

test('⑥ 编队有人、流水线零交集：报具名错误（建出来的链没有认领方）', () => {
  assert.throws(
    () => resolvePipelineStages({ pipeline: { scope: 's', stages: [stage('x')] }, roster: [rosterRole('a')] }),
    (error) => error.code === PLAN_CODES.PIPELINE_ROSTER_EMPTY && /没有交集/.test(error.message),
  )
  // 编队本身为空是既有合法态（0 环建链），不得报错
  assert.deepEqual(resolvePipelineStages({ pipeline: { scope: 's', stages: [] }, roster: [] }).stages, [])
})

test('⑦ 配了审查闭环但角色不在链上：拒绝并点名缺哪个', () => {
  const stages = resolvePipelineStages({
    pipeline: { scope: 's', stages: [stage('a'), stage('b')] }, roster: ['a', 'b'].map(rosterRole),
  }).stages
  assert.throws(
    () => resolveReviewPolicy({ stages, assignments: {}, profile: { designRole: 'a', implementationRole: 'b', reviewRole: 'reviewer' } }),
    (error) => error.code === PLAN_CODES.REVIEW_ROLE_MISSING && /reviewRole=reviewer/.test(error.message),
  )
})

test('⑧ 实现阶段没有 testRunner：拒绝（没有回执就没有审查）', () => {
  const stages = resolvePipelineStages({
    pipeline: { scope: 's', stages: [stage('a'), stage('b'), stage('c')] }, roster: ['a', 'b', 'c'].map(rosterRole),
  }).stages
  const assignments = { a: { testRunner: null }, b: { testRunner: null }, c: { testRunner: null } }
  assert.throws(
    () => resolveReviewPolicy({ stages, assignments, profile: { designRole: 'a', implementationRole: 'b', reviewRole: 'c' } }),
    (error) => error.code === PLAN_CODES.IMPLEMENTATION_TEST_RUNNER_MISSING,
  )
})

test('⑨ 没配审查闭环：不生成工作流实例，链是普通流水线', () => {
  const plan = planGoal({
    pipeline: eightStagePipeline(),
    roster: ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'].map(rosterRole),
    profile: null,
  })
  assert.equal(plan.workflow, null)
  assert.equal(plan.review, null)
  assert.equal(plan.mode, 'pipeline-plain')
  assert.equal(plan.pipeline.stages.length, 8)
})

test('⑩ 节点收敛：0 个 → 不绑定，1 个 → 绑定，2 个 → 409 具名码', () => {
  assert.equal(resolveEffectiveNode({ assignments: { a: { nodeId: null } }, agentNodeId: null }), null)
  assert.equal(resolveEffectiveNode({ assignments: { a: { nodeId: 'n1' } }, agentNodeId: 'n1' }), 'n1')
  assert.throws(
    () => resolveEffectiveNode({ assignments: { a: { nodeId: 'n1' }, b: { nodeId: 'n2' } }, agentNodeId: null }),
    (error) => error.code === PLAN_CODES.NODE_CONFLICT && /n1、n2/.test(error.message),
  )
})

test('⑪ 合成的工作流定义形状与 workflowDefinitionForChain 的产物一致', () => {
  const plan = planGoal({
    pipeline: eightStagePipeline(),
    roster: ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'].map(rosterRole),
    profile: shortDefinition,
  })
  const workflow = plan.workflow
  assert.equal(workflow.workflowDefinitionRef, null, '不是用户发布的不可变定义')
  assert.equal(workflow.workflowDefinitionSnapshot.reviewStageId, 'reviewer')
  assert.deepEqual(workflow.workflowDefinitionSnapshot.reviewRoutes, { design: 'requirement', implementation: 'coder' })
  assert.deepEqual(workflow.stageDefinitionsById.coder.previousStageIds, ['test-designer'])
  assert.deepEqual(workflow.stageDefinitionsById.coder.nextStageIds, ['reviewer'])
  assert.equal(workflow.stageToolsById.coder.testRunner.executable, 'node')
  assert.equal(workflow.stageToolsById.tester.agentToolConfig, null, '未覆盖岗位在快照里是 dsh-default')
  assert.equal(isGoalPlan(plan), true)
  assert.equal(isGoalPlan({}), false)
})

test('⑫ 计划是深冻结的：调用方改不动"已经冻住的那一版"', () => {
  const plan = planGoal({
    pipeline: eightStagePipeline(),
    roster: ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops'].map(rosterRole),
    profile: shortDefinition,
  })
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.assignments.coder), true)
  assert.equal(Object.isFrozen(plan.workflow.workflowDefinitionSnapshot.stages[0]), true)
})

test('⑬ buildPipelineWorkflow 在没有审查闭环时返回 null（不伪造一个实例）', () => {
  assert.equal(buildPipelineWorkflow({ stages: [stage('a')], assignments: {}, review: null }), null)
})

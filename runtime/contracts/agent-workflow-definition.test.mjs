import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentWorkflowDefinition } from './agent-workflow-definition.mjs'

const stage = (id, role = id, tool = `tool.${id}`) => ({
  id, role, agentToolConfig: { id: tool, version: 1 },
  testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 },
  outputContract: { artifacts: [{ name: `${id}-bundle`, required: true }] },
})

const definition = (overrides = {}) => createAgentWorkflowDefinition({
  id: 'design-code-review', version: 1, name: 'Design, code, review',
  stages: [stage('design'), stage('implement'), stage('review')],
  edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
  entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
  reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 3,
  ...overrides,
})

test('独立工作流定义冻结版本化岗位、工具、产物契约和有向阶段图', () => {
  const inputContract = { required: ['design-bundle'] }
  const value = definition({ stages: [stage('design'), { ...stage('implement'), inputContract }, stage('review')] })
  assert.equal(value.id, 'design-code-review')
  assert.equal(value.version, 1)
  assert.deepEqual(value.edges, [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }])
  assert.equal(value.stages[1].inputContract.required[0], 'design-bundle')
  assert.deepEqual(value.stages[1].testRunner, { executable: 'node', args: ['--test'], timeoutMs: 300000 })
  assert.equal(Object.isFrozen(value.stages[1].testRunner.args), true)
  assert.equal(Object.isFrozen(value), true)
  assert.equal(Object.isFrozen(value.stages[1].inputContract.required), true)
  inputContract.required.push('mutated-outside')
  assert.deepEqual(value.stages[1].inputContract.required, ['design-bundle'])
})

test('成功拓扑支持可达的 DAG 分支与汇合，返工边独立于成功图', () => {
  const value = definition({
    stages: [stage('design'), stage('code'), stage('tests'), stage('review')],
    edges: [
      { from: 'design', to: 'code' }, { from: 'design', to: 'tests' },
      { from: 'code', to: 'review' }, { from: 'tests', to: 'review' },
    ],
    entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
    reviewRoutes: { design: 'design', implementation: 'code' },
  })
  assert.equal(value.stages.length, 4)
  assert.equal(value.reviewRoutes.design, 'design')
})

test('拒绝成功图环、悬空边、不可达阶段和错误终止点', () => {
  const base = {
    stages: [stage('design'), stage('implement'), stage('review')],
    edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
    entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
    reviewRoutes: { design: 'design', implementation: 'implement' },
  }
  assert.throws(() => definition({
    ...base,
    stages: [...base.stages, stage('cycle')],
    edges: [
      { from: 'design', to: 'implement' }, { from: 'implement', to: 'cycle' },
      { from: 'cycle', to: 'implement' }, { from: 'cycle', to: 'review' },
    ],
  }), /无环/)
  assert.throws(() => definition({ ...base, edges: [...base.edges, { from: 'design', to: 'missing' }] }), /未知阶段/)
  assert.throws(() => definition({ ...base, stages: [...base.stages, stage('orphan')] }), /必须有入边/)
  assert.throws(() => definition({ ...base, terminalStageIds: ['implement'] }), /终止阶段/)
})

test('阶段工具配置、版本、审查路由与边引用均需完整有效', () => {
  const base = {
    stages: [stage('design'), stage('implement'), stage('review')],
    edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
    entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
    reviewRoutes: { design: 'design', implementation: 'implement' },
  }
  assert.throws(() => definition({ ...base, stages: [stage('design'), { ...stage('implement'), agentToolConfig: { id: 'tool', version: 0 } }, stage('review')] }), /正整数/)
  assert.throws(() => definition({ ...base, reviewRoutes: { design: 'missing', implementation: 'implement' } }), /无效阶段/)
  assert.throws(() => definition({ ...base, edges: [...base.edges, base.edges[0]] }), /重复/)
})

test('实现阶段必须冻结无 shell 的独立测试命令；危险 argv 或缺少 runner 时拒绝定义', () => {
  const base = {
    stages: [stage('design'), stage('implement'), stage('review')],
    edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
    entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
    reviewRoutes: { design: 'design', implementation: 'implement' },
  }
  assert.throws(() => definition({ ...base, stages: [stage('design'), { ...stage('implement'), testRunner: null }, stage('review')] }), /必须配置独立 testRunner/)
  assert.throws(() => definition({ ...base, stages: [stage('design'), { ...stage('implement'), testRunner: { executable: 'node', args: ['--eval=process.exit(0)'] } }, stage('review')] }), /testRunner 无效/)
})

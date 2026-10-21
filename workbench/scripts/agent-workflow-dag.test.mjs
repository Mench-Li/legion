import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

let dag
try {
  dag = await import('../src/agentWorkflowDag.ts')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  dag = {}
}

describe('可复用工作流 DAG 选择器选项', () => {
  test('阶段 ID 从未占用的序号自动生成', () => {
    assert.equal(dag.nextGraphStageId([{ id: 'design' }, { id: 'stage-3' }]), 'stage-4')
    assert.equal(dag.nextGraphStageId([{ id: 'stage-3' }, { id: 'stage-4' }]), 'stage-5')
  })

  test('交付产物选项会规整名称并去重', () => {
    assert.deepEqual(dag.declaredArtifactOptions([
      { id: 'design', outputArtifacts: [' design-bundle ', 'shared'] },
      { id: 'implement', outputArtifacts: ['shared', '', 'implementation-commit'] },
    ]), ['design-bundle', 'shared', 'implementation-commit'])
  })

  test('上游产物只列出依赖链祖先阶段交付的名称并去重', () => {
    const stages = [
      { id: 'design', outputArtifacts: ['design-bundle', 'shared'] },
      { id: 'implement', outputArtifacts: ['implementation-commit', 'shared'] },
      { id: 'review', outputArtifacts: ['review-notes'] },
      { id: 'unrelated', outputArtifacts: ['unrelated-output'] },
    ]
    const edges = [
      { from: 'design', to: 'implement' },
      { from: 'implement', to: 'review' },
      { from: 'design', to: 'unrelated' },
    ]

    assert.deepEqual(dag.upstreamArtifactOptions(stages, edges, 'review'), [
      'design-bundle', 'shared', 'implementation-commit',
    ])
    assert.deepEqual(dag.upstreamArtifactOptions(stages, edges, 'design'), [])
    assert.deepEqual(dag.upstreamArtifactOptions(stages, [
      { from: 'design', to: 'implement' },
      { from: 'implement', to: 'design' },
    ], 'design'), ['implementation-commit', 'shared'])
  })

  test('选择器对产物执行多选切换且不会产生重复值', () => {
    assert.deepEqual(dag.toggleArtifact(['design-bundle'], 'test-evidence'), ['design-bundle', 'test-evidence'])
    assert.deepEqual(dag.toggleArtifact(['design-bundle', 'test-evidence'], 'design-bundle'), ['test-evidence'])
    assert.deepEqual(dag.toggleArtifact(['design-bundle'], 'design-bundle'), [])
  })
})

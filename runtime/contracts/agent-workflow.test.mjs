import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_WORKFLOW_ERRORS, agentStageFor, createAgentWorkflow, resolveReviewDisposition,
  validateAgentWorkflowImplementationEvidence, validateAgentWorkflowTestReport,
} from './agent-workflow.mjs'

const workflow = () => createAgentWorkflow({
  id: 'design-code-review',
  version: 2,
  stages: [
    { id: 'design', role: 'designer', agentToolConfig: { id: 'tool.claude', version: 2 }, modelConfig: { id: 'model.sonnet', version: 1 }, next: 'implement' },
    { id: 'implement', role: 'coder', agentToolConfig: { id: 'tool.dsh', version: 3 }, modelConfig: { id: 'model.deepseek', version: 2 }, next: 'review' },
    { id: 'review', role: 'reviewer', agentToolConfig: { id: 'tool.codex', version: 1 }, modelConfig: null, next: null },
  ],
})

test('阶段工具选择与工作流版本一起返回', () => {
  assert.deepEqual(agentStageFor(workflow(), 'design'), {
    ok: true, workflowId: 'design-code-review', workflowVersion: 2,
    id: 'design', role: 'designer', agentToolConfig: { id: 'tool.claude', version: 2 }, modelConfig: { id: 'model.sonnet', version: 1 }, next: 'implement',
  })
})

test('未知阶段具名拒绝', () => {
  assert.equal(agentStageFor(workflow(), 'test').code, AGENT_WORKFLOW_ERRORS.UNKNOWN_STAGE)
})

test('阶段必须形成有序、无分叉的完整链', () => {
  assert.throws(() => createAgentWorkflow({
    id: 'broken', version: 1,
    stages: [
      { id: 'design', role: 'designer', agentToolConfig: { id: 'claude', version: 1 }, next: 'not-review' },
      { id: 'review', role: 'reviewer', agentToolConfig: { id: 'codex', version: 1 }, next: null },
    ],
    reviewRoutes: { implementation: 'review', design: 'design' },
  }), /阶段 design 的 next 必须是 review/)
})

test('设计问题返回设计阶段并增加一次返工计数', () => {
  assert.deepEqual(resolveReviewDisposition(workflow(), {
    passed: false, findings: [{ kind: 'design', summary: '接口不完整' }], reworkRounds: 0,
  }), { ok: true, kind: 'revise-design', nextStageId: 'design', reworkRounds: 1 })
})

test('实现问题返回编码阶段', () => {
  assert.deepEqual(resolveReviewDisposition(workflow(), {
    passed: false, findings: [{ kind: 'implementation', summary: '空值未处理' }],
  }), { ok: true, kind: 'fix-implementation', nextStageId: 'implement', reworkRounds: 1 })
})

test('混合问题先修订设计', () => {
  assert.equal(resolveReviewDisposition(workflow(), {
    passed: false, findings: [{ kind: 'implementation' }, { kind: 'design' }],
  }).nextStageId, 'design')
})

test('没有类型的问题进入澄清，不能被误判为通过', () => {
  const out = resolveReviewDisposition(workflow(), { passed: false, findings: [{ summary: '需要判断' }] })
  assert.equal(out.kind, 'needs-clarification')
  assert.equal(out.reason, AGENT_WORKFLOW_ERRORS.UNKNOWN_REVIEW_KIND)
})

test('空问题列表必须明确通过；通过后沿阶段链完成', () => {
  assert.equal(resolveReviewDisposition(workflow(), { passed: true, findings: [] }).nextStageId, null)
  assert.equal(resolveReviewDisposition(workflow(), { passed: false, findings: [] }).code, AGENT_WORKFLOW_ERRORS.REVIEW_REQUIRED)
})

test('达到返工上限后停止，不丢弃返工计数', () => {
  const out = resolveReviewDisposition(workflow(), {
    passed: false, findings: [{ kind: 'implementation' }], reworkRounds: 3,
  })
  assert.deepEqual(out, { ok: true, kind: 'rework-limit', nextStageId: null, reworkRounds: 3 })
})

test('冻结后的阶段配置不可变', () => {
  const value = workflow()
  assert.equal(Object.isFrozen(value), true)
  assert.equal(Object.isFrozen(value.stages), true)
  assert.equal(Object.isFrozen(value.stages[0]), true)
  assert.equal(Object.isFrozen(value.stages[0].agentToolConfig), true)
  assert.equal(Object.isFrozen(value.stages[0].modelConfig), true)
})

test('实现阶段测试报告必须包含通过结果、命令、摘要和非空输出证据', () => {
  const report = { passed: true, command: 'npm test', summary: '12 tests passed', evidence: '12 passed; 0 failed', failures: [] }
  assert.deepEqual(validateAgentWorkflowTestReport(report), {
    ok: true, command: 'npm test', summary: '12 tests passed', evidence: '12 passed; 0 failed',
  })
  for (const key of ['command', 'summary', 'evidence']) {
    const incomplete = { ...report, [key]: '   ' }
    assert.equal(validateAgentWorkflowTestReport(incomplete).code, AGENT_WORKFLOW_ERRORS.IMPLEMENTATION_EVIDENCE_MISSING)
  }
  assert.equal(validateAgentWorkflowTestReport({ ...report, passed: false }).ok, false)
  assert.equal(validateAgentWorkflowTestReport({ ...report, failures: [{ name: 'assertion' }] }).ok, false)
  assert.equal(validateAgentWorkflowTestReport({ ...report, failures: 'none' }).ok, false)
})

test('审查阶段只接受绑定有效提交 SHA 的完整实现测试证据', () => {
  const evidence = {
    sourceCommit: 'a'.repeat(40), passed: true, command: 'npm test', summary: '12 tests passed', evidence: '12 passed; 0 failed', failures: [],
    testVerification: {
      id: `wft-${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
      state: 'passed', sourceCommit: 'a'.repeat(40), stageAttemptId: 'attempt-1', providerRunId: 'run-1', runnerNodeId: 'node-1',
      executable: 'node', args: ['--test'], timeoutMs: 300000, exitCode: 0, startedAtMs: 100, finishedAtMs: 200,
      outputDigest: 'b'.repeat(64), outputExcerpt: '12 passed', outputTruncated: false, error: null,
    },
  }
  assert.equal(validateAgentWorkflowImplementationEvidence(evidence).ok, true)
  assert.equal(validateAgentWorkflowImplementationEvidence({ ...evidence, sourceCommit: 'not-a-commit' }).ok, false)
  assert.equal(validateAgentWorkflowImplementationEvidence({ ...evidence, evidence: '' }).ok, false)
})

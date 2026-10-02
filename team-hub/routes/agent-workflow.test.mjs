import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentWorkflowRoutes } from './agent-workflow.mjs'

test('agent-workflow review requires injected ports', () => {
  assert.throws(() => createAgentWorkflowRoutes({}), /createAgentWorkflowRoutes 缺注入项：json/)
})

test('GET workflow instances requires scope and bounds result limit', async () => {
  const calls = []
  let response
  const routes = createAgentWorkflowRoutes({
    json: (_res, status, body) => { response = { status, body } },
    handleWrite: async () => {}, submitReview: async () => {}, readHistory: async () => {},
    readInstances: async (input) => { calls.push(input); return { instances: [{ id: 'wf-1' }], total: 1, offset: 0, limit: 100 } },
    beginStageAttempt: async () => ({}), reportStageAttempt: async () => ({}), reconcileStageAttempt: async () => ({}),
  })
  await routes.dispatch({ method: 'GET' }, {}, { path: '/api/agent-workflow/instances', url: new URL('http://local/api/agent-workflow/instances') })
  assert.equal(response.status, 400)
  await routes.dispatch({ method: 'GET' }, {}, { path: '/api/agent-workflow/instances', url: new URL('http://local/api/agent-workflow/instances?scope=legion&limit=1000&offset=-3&status=done&search=foo') })
  assert.deepEqual(calls, [{ scope: 'legion', limit: 100, offset: 0, status: 'done', search: 'foo' }])
  assert.deepEqual(response.body, { instances: [{ id: 'wf-1' }], total: 1, offset: 0, limit: 100 })
  await routes.dispatch({ method: 'GET' }, {}, { path: '/api/agent-workflow/instances', url: new URL('http://local/api/agent-workflow/instances?scope=legion&status=unknown') })
  assert.equal(response.status, 400)
})

test('POST review forwards authenticated actor, scope, and typed evidence to atomic handler', async () => {
  let received
  let response
  const routes = createAgentWorkflowRoutes({
    json: (_res, status, body) => { response = { status, body } },
    handleWrite: async (_req, _res, callback) => callback({
      taskId: 'T-900', findings: [{ kind: 'design', summary: '接口需要明确重试语义' }], summary: '发现设计缺口', evidence: 'review.md#L8',
    }, 'codex', 'legion'),
    submitReview: async (input) => { received = input; return { kind: 'rework', nextTaskId: 'T-901' } },
    readHistory: async (input) => { received = input; return { workflowId: 'T-900', reviews: [] } },
    readInstances: async () => [],
    beginStageAttempt: async () => ({}), reportStageAttempt: async () => ({}), reconcileStageAttempt: async () => ({}),
  })
  assert.equal(await routes.dispatch({ method: 'POST' }, {}, { path: '/api/agent-workflow/review' }), true)
  assert.deepEqual(received, {
    taskId: 'T-900', by: 'codex', scope: 'legion',
    findings: [{ kind: 'design', summary: '接口需要明确重试语义' }], summary: '发现设计缺口', evidence: 'review.md#L8',
  })
  assert.equal(await routes.dispatch({ method: 'GET' }, {}, { path: '/api/agent-workflow/review' }), false)
  assert.equal(await routes.dispatch({ method: 'GET' }, {}, {
    path: '/api/agent-workflow/history',
    url: new URL('http://local/api/agent-workflow/history?taskId=T-900&scope=legion'),
  }), true)
  assert.deepEqual(response.body, { workflowId: 'T-900', reviews: [] })
  assert.deepEqual(received, { taskId: 'T-900', scope: 'legion' })
})

test('stage Attempt routes bind the authenticated actor/scope and forward provider run facts', async () => {
  const received = []
  const routes = createAgentWorkflowRoutes({
    json: () => {},
    handleWrite: async (_req, _res, callback) => callback({
      taskId: 'T-900', stageId: 'design-v1', providerName: 'claude-code', workspaceDir: 'C:/workspace', idempotencyKey: 'once-only-key',
      attemptId: 'wfa-1', providerRunId: 'claude-run-8', state: 'running', stopReason: null,
      disposition: 'confirmed-stopped', note: '本机进程已退出',
    }, 'designer', 'legion'),
    submitReview: async () => ({}), readHistory: async () => ({}), readInstances: async () => [],
    beginStageAttempt: async (input) => { received.push(input); return { id: 'wfa-1' } },
    reportStageAttempt: async (input) => { received.push(input); return { id: 'wfa-1' } },
    reconcileStageAttempt: async (input) => { received.push(input); return { id: 'reconcile-1' } },
  })
  assert.equal(await routes.dispatch({ method: 'POST' }, {}, { path: '/api/agent-workflow/stage-attempts/start' }), true)
  assert.equal(await routes.dispatch({ method: 'POST' }, {}, { path: '/api/agent-workflow/stage-attempts/report' }), true)
  assert.equal(await routes.dispatch({ method: 'POST' }, {}, { path: '/api/agent-workflow/stage-attempts/reconcile' }), true)
  assert.deepEqual(received, [
    { taskId: 'T-900', stageId: 'design-v1', providerName: 'claude-code', workspaceDir: 'C:/workspace', idempotencyKey: 'once-only-key', by: 'designer', scope: 'legion' },
    { attemptId: 'wfa-1', providerRunId: 'claude-run-8', state: 'running', stopReason: null, error: undefined, result: undefined, by: 'designer', scope: 'legion' },
    { attemptId: 'wfa-1', disposition: 'confirmed-stopped', note: '本机进程已退出', idempotencyKey: 'once-only-key', by: 'designer', scope: 'legion' },
  ])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForWorkflowAgentRun } from './workflow-run.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('workflow run resolves normally without aborting its controller', async () => {
  const controller = new AbortController()
  const out = await waitForWorkflowAgentRun({
    run: { result: Promise.resolve({ stopReason: 'completed' }) },
    taskId: 'task-a', getTask: async () => ({ status: 'in_progress' }), controller,
    timeoutMs: 100, pollIntervalMs: 5,
  })
  assert.deepEqual(out, { result: { stopReason: 'completed' }, taskCanceled: false, timedOut: false })
  assert.equal(controller.signal.aborted, false)
})

test('provider result rejection preserves only a safe error class for unknown-outcome diagnosis', async () => {
  const controller = new AbortController()
  const out = await waitForWorkflowAgentRun({
    run: { result: Promise.reject(Object.assign(new Error('credential-bearing message must not escape'), { name: 'ProviderTransportError' })) },
    taskId: 'task-rejected', getTask: async () => ({ status: 'in_progress' }), controller,
    timeoutMs: 100, pollIntervalMs: 5,
  })
  assert.deepEqual(out, { result: null, taskCanceled: false, timedOut: false, failureType: 'ProviderTransportError' })
  assert.equal(JSON.stringify(out).includes('credential-bearing'), false)
})

test('provider rejection with an unsafe error name uses a fixed diagnostic class', async () => {
  const controller = new AbortController()
  const out = await waitForWorkflowAgentRun({
    run: { result: Promise.reject(Object.assign(new Error('private'), { name: 'secret=must-not-escape' })) },
    taskId: 'task-unsafe-rejection', getTask: async () => ({ status: 'in_progress' }), controller,
    timeoutMs: 100, pollIntervalMs: 5,
  })
  assert.equal(out.failureType, 'Error')
  assert.equal(JSON.stringify(out).includes('private'), false)
  assert.equal(JSON.stringify(out).includes('secret='), false)
})

test('provider rejection with a hostile value cannot break settlement or diagnostics', async () => {
  const controller = new AbortController()
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('private proxy trap') } })
  const out = await waitForWorkflowAgentRun({
    run: { result: Promise.reject(hostile) },
    taskId: 'task-hostile-rejection', getTask: async () => ({ status: 'in_progress' }), controller,
    timeoutMs: 100, pollIntervalMs: 5,
  })
  assert.equal(out.failureType, 'Error')
  assert.equal(JSON.stringify(out).includes('private'), false)
  assert.equal(out.timedOut, false)
})

test('workflow task cancellation aborts provider and waits for its terminal result', async () => {
  const controller = new AbortController()
  let taskStatus = 'in_progress'
  let providerSawAbort = false
  const run = { result: new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => {
      providerSawAbort = true
      resolve({ stopReason: 'cancelled' })
    }, { once: true })
  }) }
  const waiting = waitForWorkflowAgentRun({
    run, taskId: 'task-b', getTask: async () => ({ status: taskStatus }), controller,
    timeoutMs: 150, pollIntervalMs: 5,
  })
  await delay(10)
  taskStatus = 'canceled'
  const out = await waiting
  assert.equal(providerSawAbort, true)
  assert.deepEqual(out, { result: { stopReason: 'cancelled' }, taskCanceled: true, timedOut: false })
})

test('canceling a goal aborts an in-progress workflow provider while preserving its task state', async () => {
  const controller = new AbortController()
  let goalStatus = 'active'
  let providerSawAbort = false
  const run = { result: new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => {
      providerSawAbort = true
      resolve({ stopReason: 'aborted' })
    }, { once: true })
  }) }
  const waiting = waitForWorkflowAgentRun({
    run, taskId: 'task-goal-cancel',
    getTask: async () => ({ status: 'in_progress', goalStatus }), controller,
    timeoutMs: 150, pollIntervalMs: 5,
  })
  await delay(10)
  goalStatus = 'canceled'
  const out = await waiting
  assert.equal(providerSawAbort, true)
  assert.deepEqual(out, { result: { stopReason: 'aborted' }, taskCanceled: true, timedOut: false })
})

test('workflow cancellation remains unknown if provider ignores abort through timeout', async () => {
  const controller = new AbortController()
  const out = await waitForWorkflowAgentRun({
    run: { result: new Promise(() => {}) }, taskId: 'task-c',
    getTask: async () => ({ status: 'canceled' }), controller,
    timeoutMs: 20, pollIntervalMs: 5,
  })
  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(out, { result: null, taskCanceled: true, timedOut: true })
})

test('a task canceled at provider settlement is not treated as an accepted completion', async () => {
  const controller = new AbortController()
  const out = await waitForWorkflowAgentRun({
    run: { result: Promise.resolve({ stopReason: 'completed' }) }, taskId: 'task-d',
    getTask: async () => ({ status: 'canceled' }), controller,
    timeoutMs: 100, pollIntervalMs: 5,
  })
  assert.equal(out.taskCanceled, true)
  assert.equal(out.result.stopReason, 'completed')
  assert.equal(controller.signal.aborted, true)
})

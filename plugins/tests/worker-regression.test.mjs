import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

const TASK = {
  id: 'T-001',
  title: 'resume blocked work',
  description: '',
  acceptance: [],
  priority: 'medium',
  status: 'blocked',
  version: 1,
  soldier: 'soldier-auto',
  claimedAt: '2026-09-01T00:00:00.000Z',
  parent: null,
  role: null,
  blockedBy: [],
  comments: [],
}

function config(root) {
  return {
    role: 'soldier-auto',
    intervalMs: 30_000,
    maxWorkers: 1,
    workerTimeoutMs: 60_000,
    staleMinutes: 30,
    taskTtlMinutes: 0,
    provider: 'spawn',
    scrumDir: join(root, 'scrum'),
    workspace: root,
    isolate: false,
    repoRoot: root,
    worktreeRoot: '',
    denyTools: [],
    rolesFile: join(root, 'missing-roles.json'),
    logFile: join(root, 'worker.log'),
    hubUrl: 'http://hub.test',
    hubToken: '',
    scope: 'default',
    agentPreset: 'code',
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function fakeContext(report, onCreate = async () => {}, onMount = async () => {}) {
  const intervals = []
  const disposers = []
  return {
    intervals,
    disposers,
    ctx: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'test', model: 'test-model' }),
      },
      agentPresets: {
        mount: onMount,
      },
      agents: {
        create: async options => {
          await onCreate(options)
          return {
            agent: { session: { id: String(options.sessionId) } },
            dispose: async () => {},
          }
        },
      },
      subagents: {
        start: async () => ({
          result: Promise.resolve({ stopReason: 'completed', structured: report }),
          dispose: async () => {},
        }),
      },
      setInterval: fn => {
        intervals.push(fn)
        return 1
      },
      effect: disposer => {
        disposers.push(disposer)
      },
      logger: { info: () => {} },
    },
  }
}

test('a dependency-cleared blocked task is claimed before its worker can block again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-resume-'))
  const originalFetch = globalThis.fetch
  const requests = []
  let task = structuredClone(TASK)
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([task])
    const body = JSON.parse(String(init.body))
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      task = { ...task, status: 'in_progress', version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/comment') {
      requests.push('comment')
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${task.status}->${body.to}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'blocked', summary: 'still blocked', evidence: '', blocker: 'missing input' })
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => requests.some(request => request.startsWith('transition:')), 'worker never settled')
    assert.deepEqual(requests, ['claim:blocked', 'comment', 'transition:in_progress->blocked'])
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('the foreman mounts the configured agent preset before becoming available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-preset-'))
  const originalFetch = globalThis.fetch
  const mounted = []
  let createOptions
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([])
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext(
    { status: 'done', summary: '', evidence: '', blocker: '' },
    async options => { createOptions = options },
    async (agentCtx, preset) => { mounted.push({ agentCtx, preset }) },
  )
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => createOptions !== undefined, 'foreman was never created')
    assert.equal(typeof createOptions.setup, 'function')
    const agentCtx = { id: 'foreman-context' }
    await createOptions.setup(agentCtx)
    assert.deepEqual(mounted, [{ agentCtx, preset: 'code' }])
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('a detached worker failure is contained and the task can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-contained-'))
  const originalFetch = globalThis.fetch
  const requests = []
  let task = structuredClone(TASK)
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([task])
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      task = { ...task, status: 'in_progress', version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/comment') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push('transition:failed')
      throw new Error('simulated hub failure')
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'blocked', summary: 'blocked', evidence: '', blocker: 'wait' })
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => requests.includes('transition:failed'), 'worker did not reach transition')
    task = { ...task, status: 'blocked' }
    harness.intervals[0]()
    await waitFor(() => requests.filter(request => request.startsWith('claim:')).length === 2, 'failed task remained stuck in-flight')
    assert.deepEqual(requests.filter(request => request.startsWith('claim:')), ['claim:blocked', 'claim:blocked'])
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

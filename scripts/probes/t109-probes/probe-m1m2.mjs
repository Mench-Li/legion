// T-109 probe: M1 (docsDir goal) + M2 (hub write failure) — drives real plugins lib apply settle.
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../plugins/lib/index.js'

const ROLES = {
  name: 'software',
  stages: [
    { role: 'requirement', label: '需求澄清', prompt: '产出写进 docs/REQUIREMENTS.md', next: 'researcher', gate: true, artifact: 'docs/REQUIREMENTS.md', docs: ['docs/REQUIREMENTS.md'] },
    { role: 'researcher', label: '方案搜索', prompt: '产出写进 docs/RESEARCH.md', next: 'breaker', gate: true, artifact: 'docs/RESEARCH.md', docs: ['docs/RESEARCH.md'] },
    { role: 'coder', label: '编码实现', prompt: 'code', next: 'reviewer' },
  ],
}
function config(root, overrides = {}) {
  return {
    role: 'soldier-auto', intervalMs: 30_000, maxWorkers: 1, workerTimeoutMs: 60_000,
    staleMinutes: 30, taskTtlMinutes: 0, provider: 'spawn', scrumDir: join(root, 'scrum'),
    workspace: root, isolate: false, repoRoot: root, worktreeRoot: '', denyTools: [],
    rolesFile: join(root, 'roles.json'), logFile: join(root, 'worker.log'),
    hubUrl: 'http://hub.test', hubToken: '', scope: 'software', agentPreset: 'code',
    ...overrides,
  }
}
function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('TIMEOUT: ' + message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
function fakeContext(report) {
  const intervals = []
  const disposers = []
  return {
    intervals, disposers,
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
      agentPresets: { mount: async () => {} },
      agents: { create: async () => ({ agent: { session: { id: 'foreman-test' } }, dispose: async () => {} }) },
      subagents: { start: async () => ({ result: Promise.resolve({ stopReason: 'completed', structured: report }), dispose: async () => {} }) },
      setInterval: fn => { intervals.push(fn); return 1 },
      effect: disposer => { disposers.push(disposer) },
      logger: { info: () => {} },
    },
  }
}
function baseTask(overrides = {}) {
  return {
    id: 'T-001', title: '目标', description: '', acceptance: [], priority: 'medium',
    status: 'todo', version: 1, soldier: null, claimedAt: null, parent: null, role: 'requirement',
    scope: 'software', hold: false, blockedBy: [], comments: [], slice: null, sliceIdx: null,
    fixOf: null, fixCount: 0, testReport: null, goalId: 'G-DIR-1', ...overrides,
  }
}
function hubMachine(holder, requests, extra = {}) {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const task = holder.task
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/release-stale') return response({ released: [] })
    if (url.pathname === '/api/goal') return response({ goals: [{ id: 'G-DIR-1', scope: 'software', objective: 'docdir goal', status: 'active', mode: 'chain', context: '', contextVersion: 1, docsDir: 'docs/G-DIR-1' }] })
    if (url.pathname === '/api/board') return response([task])
    if (url.pathname === '/api/progress') return response({ task })
    if (extra[url.pathname]) return extra[url.pathname](body, task)
    if (url.pathname === '/api/claim') {
      requests.push('claim')
      holder.task = { ...task, status: 'in_progress', soldier: body.soldier ?? 'soldier-auto', claimedAt: '2026-09-01T00:00:00.000Z', version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/comment') {
      requests.push('comment')
      holder.task = { ...task, comments: [...(task.comments ?? []), { by: body.by, at: '2026-09-01T00:00:01.000Z', text: body.text }], version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/artifact') {
      requests.push('artifact:' + body.path + ':' + (body.digest ?? '').slice(0, 8))
      const entry = { by: body.by, at: '2026-09-01T00:00:02.000Z', kind: body.kind, path: body.path, title: body.title ?? '' }
      if (body.digest) entry.digest = body.digest
      holder.task = { ...task, artifacts: [...(task.artifacts ?? []), entry], version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/transition') {
      requests.push('transition:' + body.to)
      holder.task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/advance') {
      requests.push('advance')
      holder.task = { ...task, status: 'done', version: task.version + 1 }
      return response({ task: holder.task })
    }
    throw new Error('unexpected request ' + url.pathname)
  }
}
function sweep(harness) { harness.intervals[0]() }
async function cleanupDir(root) { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }

async function runScenario(name, setup, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 't109-probe-'))
  const originalFetch = globalThis.fetch
  const originalTasks = process.env.LEGION_TASKS_FILE
  process.env.LEGION_TASKS_FILE = join(root, 'scrum', 'tasks.json')
  let harness
  try {
    writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
    setup(root)
    const holder = { task: baseTask() }
    const requests = []
    globalThis.fetch = hubMachine(holder, requests, extra)
    harness = fakeContext({ status: 'done', summary: '完成', evidence: '见文档', blocker: '' })
    apply(harness.ctx, config(root))
    sweep(harness)
    await waitFor(() => requests.includes('transition:in_review') || requests.includes('advance'), name + ' settle')
    const comments = holder.task.comments.map(c => c.text)
    const artifacts = holder.task.artifacts ?? []
    console.log('=== ' + name + ' ===')
    console.log('requests:', requests.join(' | '))
    console.log('artifacts:', JSON.stringify(artifacts.map(a => ({ path: a.path, digest: a.digest ? a.digest.slice(0, 8) : undefined }))))
    const warn = comments.find(t => t.includes('契约产出文档缺失'))
    console.log('missing-warning-comment:', warn ? warn.slice(0, 220) : '(none)')
    const gate = comments.find(t => t.includes('人工验收'))
    console.log('gate-comment:', gate ? gate.slice(0, 160) : '(none)')
    return { requests, artifacts, warn, gate }
  } finally {
    for (const d of harness?.disposers ?? []) { try { await d() } catch {} }
    globalThis.fetch = originalFetch
    if (originalTasks === undefined) delete process.env.LEGION_TASKS_FILE; else process.env.LEGION_TASKS_FILE = originalTasks
    await cleanupDir(root).catch(() => {})
  }
}

// A1: docsDir goal — worker wrote ONLY docs/G-DIR-1/REQUIREMENTS.md (as instructed by buildWorkerPrompt)
const a1 = await runScenario(
  'M1-A1 docDir goal, real doc only in docs/G-DIR-1/REQUIREMENTS.md',
  (root) => { mkdirSync(join(root, 'docs', 'G-DIR-1'), { recursive: true }); writeFileSync(join(root, 'docs', 'G-DIR-1', 'REQUIREMENTS.md'), '# REAL DIR DOC\n') },
)
console.log('A1 correct-expectation: register docs/G-DIR-1/REQUIREMENTS.md, no missing warning. Actual registered=' + a1.artifacts.length + ' missingWarn=' + !!a1.warn)

// A2: stale root docs/REQUIREMENTS.md exists too (repo legacy doc from other goal)
const a2 = await runScenario(
  'M1-A2 docDir goal + stale root docs/REQUIREMENTS.md present',
  (root) => {
    mkdirSync(join(root, 'docs', 'G-DIR-1'), { recursive: true })
    writeFileSync(join(root, 'docs', 'G-DIR-1', 'REQUIREMENTS.md'), '# REAL DIR DOC\n')
    writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# STALE ROOT DOC (other goal)\n')
  },
)
console.log('A2 correct-expectation: register docs/G-DIR-1/REQUIREMENTS.md only. Actual paths=' + JSON.stringify(a2.artifacts.map(a => a.path)))

// B: hub POST /api/artifact returns 500 — write failure must NOT be treated as missing
const b = await runScenario(
  'M2 hub artifact POST 500 with file present',
  (root) => { mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# OK DOC\n') },
  { '/api/artifact': () => response({ error: 'hub boom' }, 500) },
)
console.log('B correct-expectation: no missing-warning; task continues. Actual missingWarn=' + !!b.warn + ' requests=' + b.requests.join('|'))

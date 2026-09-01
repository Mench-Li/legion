import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function config(root, overrides = {}) {
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
    ...overrides,
  }
}

/**
 * 守护在 hub 模式下仍会直接跑一次本地 taskctl release-stale；
 * 不设 LEGION_TASKS_FILE 会命中真实的 legion/scrum/tasks.json，误释放真实任务。
 * 每个测试把该环境变量指向临时文件（不存在则 release-stale 抛错被吞），并返回恢复函数。
 */
function protectTasksFile(root) {
  const original = process.env.LEGION_TASKS_FILE
  process.env.LEGION_TASKS_FILE = join(root, 'scrum', 'tasks.json')
  return () => {
    if (original === undefined) delete process.env.LEGION_TASKS_FILE
    else process.env.LEGION_TASKS_FILE = original
  }
}

/** 测试内执行 git（worktree 集成用）。 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/** 建一个可用的临时 git 仓库（有初始提交），供 isolate 集成测试使用。 */
function initGitRepo(root) {
  const init = git(root, ['init'])
  if (init.code !== 0) throw new Error(`git init 失败：${init.err}`)
  git(root, ['config', 'user.email', 'legion-test@example.com'])
  git(root, ['config', 'user.name', 'legion-test'])
  writeFileSync(join(root, 'seed.txt'), 'seed\n')
  git(root, ['add', '-A'])
  const commit = git(root, ['commit', '-m', 'init'])
  if (commit.code !== 0) throw new Error(`git 初始提交失败：${commit.err}`)
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Windows 上 git 子进程句柄释放滞后，清理临时仓库需带重试。 */
async function cleanup(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function fakeContext(report, onCreate = async () => {}, onMount = async () => {}, startOverride) {
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
        start: startOverride ?? (async () => ({
          result: Promise.resolve({ stopReason: 'completed', structured: report }),
          dispose: async () => {},
        })),
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
  const restoreTasks = protectTasksFile(root)
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
    restoreTasks()
    await cleanup(root)
  }
})

test('the foreman mounts the configured agent preset before becoming available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-preset-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
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
    restoreTasks()
    await cleanup(root)
  }
})

test('a detached worker failure is contained and the task can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-contained-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
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
    restoreTasks()
    await cleanup(root)
  }
})

test('pipeline final stage submits in_review under the stage role, not the daemon role', async () => {
  // D1 回归：流水线最终阶段（devops，next=null）worker 完成后，in_review 迁移必须以认领者
  // （soldier=devops）提交；硬编码 config.role（soldier-auto）会被 taskctl 的
  // 「由 X 负责，不能由 Y 提交验收」拒绝，导致任务永远卡在 in_progress。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-final-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [{ role: 'devops', label: '部署与 CI/CD', prompt: 'deploy', next: null }],
  }))
  const requests = []
  let task = { ...structuredClone(TASK), role: 'devops', soldier: 'devops' }
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
    if (url.pathname === '/api/comment') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'done', summary: 'deployed', evidence: 'ok', blocker: '' })
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => requests.includes('transition:in_review:devops'), 'final stage never submitted in_review under devops')
    assert.ok(
      !requests.some(r => r.startsWith('transition:in_review:soldier-auto')),
      `transition must not use the daemon role, got ${requests.join(', ')}`,
    )
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('a failed intermediate auto-merge parks the task in in_review instead of silently advancing', async () => {
  // D2 回归：中间阶段（coder → reviewer）worker 完成后自动合入 w/<id> 失败时，
  // 不得推进到 done / 创建下一阶段任务（否则下一阶段基于旧 main 工作，本阶段产出丢失）；
  // 应转 in_review + 说明评论，由将军人工合入后手动 done（sweep 第 4 步再补流转）。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-mergefail-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  initGitRepo(repo)
  writeFileSync(join(repo, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'coder', label: '编码实现', prompt: 'code', next: 'reviewer' },
      { role: 'reviewer', label: '代码审查', prompt: 'review', next: null },
    ],
  }))
  const requests = []
  let task = { ...structuredClone(TASK), role: 'coder', soldier: 'coder' }
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
      requests.push(`transition:${body.to}:${body.by}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/advance' || url.pathname === '/api/create') {
      requests.push(url.pathname)
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let resolveWorker
  const workerRun = { result: new Promise(res => { resolveWorker = res }), dispose: async () => {} }
  const harness = fakeContext(
    { status: 'done', summary: 'coded', evidence: 'ok', blocker: '' },
    async () => {},
    async () => {},
    async () => workerRun,
  )
  try {
    apply(harness.ctx, config(root, { isolate: true, repoRoot: repo, worktreeRoot: join(root, 'wt'), rolesFile: join(repo, 'roles.json') }))
    harness.intervals[0]()
    // worker 挂起期间：删掉 w/T-001 分支引用 → 自动合入必然失败
    await waitFor(() => requests.includes('claim:blocked'), 'task was never claimed')
    await waitFor(() => git(repo, ['rev-parse', '--verify', 'w/T-001']).code === 0, 'worktree branch never created')
    assert.equal(git(repo, ['update-ref', '-d', 'refs/heads/w/T-001']).code, 0, 'branch ref delete failed')
    resolveWorker({ stopReason: 'completed', structured: { status: 'done', summary: 'coded', evidence: 'ok', blocker: '' } })
    await waitFor(() => requests.includes('transition:in_review:coder'), 'merge failure did not park the task in in_review')
    assert.ok(!requests.includes('/api/advance'), 'task must not advance to done after a failed auto-merge')
    assert.ok(!requests.includes('/api/create'), 'no successor task must be created after a failed auto-merge')
    assert.ok(requests.includes('comment'), 'merge-failure guidance comment was not posted')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('unblocking reuses the previous worktree and preserves the blocked worker partial work', async () => {
  // D3 回归：blocked 时部分改动提交为 WIP（分支 w/<id>）；解阻续做时 prepareWorktree
  // 复用既有 worktree/分支，不 force 删除上一轮成果（此前 worktree remove --force + branch -D
  // 会静默丢掉 blocked 轮次的所有未提交改动）。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-resume-wt-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  initGitRepo(repo)
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
    if (url.pathname === '/api/comment') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let resolveWorker
  const makeWorker = () => ({ result: new Promise(res => { resolveWorker = res }), dispose: async () => {} })
  const harness = fakeContext(
    { status: 'blocked', summary: 'partial', evidence: '', blocker: 'missing input' },
    async () => {},
    async () => {},
    async () => makeWorker(),
  )
  try {
    apply(harness.ctx, config(root, { isolate: true, repoRoot: repo, worktreeRoot: join(root, 'wt') }))
    const wtDir = join(root, 'wt', 'T-001')

    // 第 1 轮：worker 挂起期间写入部分改动，然后报 blocked
    harness.intervals[0]()
    await waitFor(() => git(repo, ['rev-parse', '--verify', 'w/T-001']).code === 0, 'worktree branch never created')
    await waitFor(() => typeof resolveWorker === 'function', 'worker 1 never started')
    writeFileSync(join(wtDir, 'partial.txt'), 'partial work\n')
    resolveWorker({ stopReason: 'completed', structured: { status: 'blocked', summary: 'partial', evidence: '', blocker: 'missing input' } })
    await waitFor(() => requests.includes('transition:blocked'), 'blocked transition never happened')
    assert.ok(git(repo, ['log', '--oneline', 'w/T-001']).out.includes('WIP'), 'blocked partial work was not committed as WIP')
    await new Promise(r => setTimeout(r, 100)) // 等 runDetached 释放 inflight

    // 第 2 轮：依赖清空 → 解阻续做，必须复用既有 worktree，部分改动仍在
    task = { ...task, status: 'blocked' }
    harness.intervals[0]()
    await waitFor(() => requests.filter(r => r.startsWith('claim:')).length === 2, 'blocked task was never re-claimed')
    // 等 prepareWorktree 复用执行完（activity 落盘）再断言文件与分支存活
    const activityHasReuse = () => {
      try { return readFileSync(join(root, 'scrum', 'activity.jsonl'), 'utf8').includes('复用既有 worktree') } catch { return false }
    }
    await waitFor(activityHasReuse, 'worktree was not reused on unblock')
    assert.equal(readFileSync(join(wtDir, 'partial.txt'), 'utf8'), 'partial work\n', 'previous partial work was destroyed on unblock')
    assert.equal(git(repo, ['rev-parse', '--verify', 'w/T-001']).code, 0, 'WIP branch was deleted on unblock')
    await waitFor(() => typeof resolveWorker === 'function', 'worker 2 never started')
    resolveWorker({ stopReason: 'completed', structured: { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' } })
    await waitFor(() => requests.includes('transition:in_review'), 'resumed task never reached in_review')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

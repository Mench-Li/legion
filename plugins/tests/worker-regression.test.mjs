import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('a blocked task with answered general question is claimed before the worker is re-dispatched (T-117 regression)', async () => {
  // T-117 现场：blocked + ❓ 问句 + 将军答复 → 旧代码走 workReturned（不认领）直接派 worker，
  // 任务停留在 blocked → 心跳（/api/progress 仅 in_progress 可上报）与完成结算全部失败，任务卡死。
  // 修复：带答复的 blocked 续做必须先 claim（blocked→in_progress）再派 worker。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-answered-question-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const requests = []
  const commentTexts = []
  const askAt = Date.now() - 60_000
  let task = {
    ...structuredClone(TASK),
    status: 'blocked',
    soldier: 'soldier-auto',
    claimedAt: new Date(askAt).toISOString(),
    comments: [
      { by: 'soldier-auto', at: new Date(askAt).toISOString(), text: '❓ 需要将军介入确认：请将军给出处理意见' },
      { by: 'general', at: new Date(askAt + 1000).toISOString(), text: '✅ 将军答复：按脚本侧归一化修复后复测' },
    ],
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([task])
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      task = { ...task, status: 'in_progress', version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/comment') {
      commentTexts.push(body.text)
      task = { ...task, comments: [...task.comments, { by: body.by, at: new Date().toISOString(), text: body.text }] }
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${task.status}->${body.to}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let workerStarts = 0
  const harness = fakeContext(
    { status: 'blocked', summary: 'still blocked', evidence: '', blocker: 'missing input' },
    async () => {},
    async () => {},
    async (provider, options) => {
      workerStarts += 1
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: { status: 'blocked', summary: 'still blocked', evidence: '', blocker: 'missing input' } }),
        dispose: async () => {},
      }
    },
  )
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => workerStarts === 1, 'worker was never re-dispatched after the general answered')
    assert.equal(requests[0], 'claim:blocked', 'answered blocked task must be claimed (blocked→in_progress) BEFORE the worker is dispatched')
    assert.ok(requests.includes('claim:blocked'), 'claim must appear in the request stream')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

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
    assert.deepEqual(requests, ['claim:blocked', 'comment', 'comment', 'transition:in_progress->blocked'])
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

test('pipeline final stage autofinishes to done under the stage role, not the daemon role', async () => {
  // D1 回归（2026-09-08 更新）：流水线最终阶段（devops，next=null）worker 完成后，
  // 不再停 in_review 等将军验收（将军裁决「部署不需验收，直接部署」），而是自动合入 + 推进 done；
  // 推进必须以认领者（soldier=devops）发起 /api/advance，不能硬编码 config.role（soldier-auto）。
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
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.by}`)
      task = { ...task, status: 'done', version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'done', summary: 'deployed', evidence: 'ok', blocker: '' })
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => requests.includes('advance:devops'), 'final stage never advanced to done under devops')
    assert.ok(
      !requests.some(r => r.startsWith('advance:soldier-auto') || r.startsWith('transition:in_review')),
      `final stage must autofinish via advance under the stage role (not daemon role / not in_review), got ${requests.join(', ')}`,
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
    // worker 挂起期间：删掉 w/T-001 分支引用 → 自动合入必然失败。
    // 就绪信号用插件自己的 activity「隔离 worktree 就绪」（git worktree add 成功后才落盘）；
    // 测试侧轮询 git status 会与 add 争抢 index.lock 导致 add 失败回退 workspace（ENOENT/误判合入成功）。
    await waitFor(() => requests.includes('claim:blocked'), 'task was never claimed')
    await waitFor(() => {
      try { return readFileSync(join(root, 'scrum', 'activity.jsonl'), 'utf8').includes('隔离 worktree 就绪') } catch { return false }
    }, 'worktree never became ready')
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
    // 等插件 activity「隔离 worktree 就绪」（add 成功后才落盘；测试侧轮询 git 会争 index.lock）
    await waitFor(() => {
      try { return readFileSync(join(root, 'scrum', 'activity.jsonl'), 'utf8').includes('隔离 worktree 就绪') } catch { return false }
    }, 'worktree never became ready')
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

test('a single-role aborted worker is retried on the next sweep instead of stalling', async () => {
  // D7 回归：单角色模式下守护自己的「⚠ worker 未完成」评论（by=config.role）会被 self 过滤，
  // 导致中止的 worker 只能等 stale 释放（30 分钟）。修复后该评论触发下一轮重试（带退避）。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-abort-retry-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const requests = []
  let task = {
    ...structuredClone(TASK),
    status: 'in_progress',
    claimedAt: new Date(Date.now() - 60_000).toISOString(),
    comments: [{ by: 'soldier-auto', at: new Date().toISOString(), text: '⚠ worker 未完成（aborted），任务保留在 in_progress，等待人工处理或下一轮重试' }],
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([task])
    const body = JSON.parse(String(init.body))
    if (url.pathname === '/api/comment') {
      task = { ...task, comments: [...task.comments, { by: body.by, at: new Date().toISOString(), text: body.text }] }
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let starts = 0
  const harness = fakeContext(
    { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' },
    async () => {},
    async () => {},
    async () => {
      starts += 1
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' } }),
        dispose: async () => {},
      }
    },
  )
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => starts === 1, 'aborted task was not retried on the next sweep')
    await waitFor(() => requests.includes('transition:in_review'), 'retried worker never completed')
    assert.equal(starts, 1, 'aborted task should be retried exactly once here')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('interleaved dispatch comments do not reset the failure streak — give-up still escalates to the mediator (T-117 churn regression)', async () => {
  // T-117 现场：runWorker 每轮派工都发「🟢 已派 AI worker」评论（在 ⚠ 之后），旧 workerFailStreak 从尾部
  // 倒数遇 🟢 即 break → streak 恒 0 → maxWorkerRetry=3 永不达到 → 无限重派死循环（无调解、无 give-up）。
  // 修复：🟢 派工评论跳过不打断计数。本测试模拟 ⚠/🟢 交错 3 轮失败 → 仍应触发调解员。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-streak-interleave-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const requests = []
  const commentTexts = []
  const t0 = Date.now() - 300_000
  const mk = (i, text) => ({ by: 'soldier-auto', at: new Date(t0 + i * 10_000).toISOString(), text })
  let task = {
    ...structuredClone(TASK),
    status: 'in_progress',
    claimedAt: new Date(t0 - 10_000).toISOString(),
    // 3 轮失败，每轮 = ⚠（失败）后跟 🟢（重派）：旧代码 streak 见 🟢 即 0
    comments: [
      mk(1, '⚠ worker 未完成（error），任务保留在 in_progress，等待人工处理或下一轮重试'),
      mk(2, '🟢 已派 AI worker 开始执行（worker=scrum:T-001）——进行中'),
      mk(3, '⚠ worker 未完成（error），任务保留在 in_progress，等待人工处理或下一轮重试'),
      mk(4, '🟢 已派 AI worker 开始执行（worker=scrum:T-001）——进行中'),
      mk(5, '⚠ worker 未完成（error），任务保留在 in_progress，等待人工处理或下一轮重试'),
    ],
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([task])
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/comment') {
      commentTexts.push(body.text)
      task = { ...task, comments: [...task.comments, { by: body.by, at: new Date().toISOString(), text: body.text }] }
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let mediatorStarts = 0
  let workerStarts = 0
  const harness = fakeContext(
    { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' },
    async () => {},
    async () => {},
    async (provider, options) => {
      const label = String(options?.label ?? '')
      if (label.startsWith('mediator:')) {
        mediatorStarts += 1
        return {
          result: Promise.resolve({ stopReason: 'completed', structured: { status: 'done', summary: 'cleared root cause', resolvedFiles: ['team-hub/server.mjs'] } }),
          dispose: async () => {},
        }
      }
      workerStarts += 1
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' } }),
        dispose: async () => {},
      }
    },
  )
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => mediatorStarts === 1, 'mediator was never dispatched despite 3 interleaved failures')
    await waitFor(() => commentTexts.some(t => t.startsWith('🤝 调解员处理重派')), 'mediator redispatch comment was not posted')
    assert.equal(mediatorStarts, 1, 'mediator should be dispatched exactly once here')
    assert.ok(!commentTexts.some(t => t.startsWith('🛑 已自动重试')), 'give-up should not fire while the mediator can still fix')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('repeated worker failures are re-dispatched by the mediator instead of escalating to the general', async () => {
  // D8 回归：同一认领内连续 ≥maxWorkerRetry 次「⚠ worker 未完成」→ 不升级将军，
  // 交调解员（label=mediator:*）诊断修复根因并重新派工（label=scrum:*）；仅调解无法修复才置 blocked。
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-mediator-redispatch-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const requests = []
  const commentTexts = []
  let task = {
    ...structuredClone(TASK),
    status: 'in_progress',
    claimedAt: new Date(Date.now() - 120_000).toISOString(),
    comments: [1, 2, 3].map(i => ({
      by: 'soldier-auto',
      at: new Date(Date.now() - (120_000 - i * 10_000)).toISOString(),
      text: '⚠ worker 未完成（error），任务保留在 in_progress，等待人工处理或下一轮重试',
    })),
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/board') return response([task])
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/comment') {
      commentTexts.push(body.text)
      task = { ...task, comments: [...task.comments, { by: body.by, at: new Date().toISOString(), text: body.text }] }
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let mediatorStarts = 0
  let workerStarts = 0
  const harness = fakeContext(
    { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' },
    async () => {},
    async () => {},
    async (provider, options) => {
      const label = String(options?.label ?? '')
      if (label.startsWith('mediator:')) {
        mediatorStarts += 1
        return {
          result: Promise.resolve({ stopReason: 'completed', structured: { status: 'done', summary: 'cleared conflict markers', resolvedFiles: ['workbench/src/App.tsx'] } }),
          dispose: async () => {},
        }
      }
      workerStarts += 1
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: { status: 'done', summary: 'finished', evidence: 'ok', blocker: '' } }),
        dispose: async () => {},
      }
    },
  )
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => mediatorStarts === 1, 'mediator was never dispatched for the failing worker')
    await waitFor(() => commentTexts.some(t => t.startsWith('🤝 调解员处理重派')), 'mediator redispatch comment was not posted')
    await waitFor(() => workerStarts === 1, 'worker was never re-dispatched after mediator fix')
    await waitFor(() => requests.includes('transition:in_review'), 're-dispatched worker never completed')
    assert.ok(!requests.includes('transition:blocked'), 'task must not be escalated to blocked when the mediator can fix the root cause')
    assert.equal(mediatorStarts, 1, 'mediator should be dispatched exactly once here')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('workflow worker persists Attempt before provider start and binds Run ID before consuming its result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-attempt-order-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  initGitRepo(root)

  const reviewWorkflow = {
    instanceId: 'G-attempt-order',
    designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer',
    designStageId: 'design', implementationStageId: 'implement', reviewStageId: 'review',
    maxReworkRounds: 2,
    stageDefinitionsById: {
      design: {
        workflowStageId: 'design', role: 'designer', label: 'Design', nextStageIds: ['implement'],
        agentToolConfig: {
          id: 'claude-code', version: 1, providerName: 'claude-code', adapter: 'dsh-subagent', enabled: true,
          permissionProfile: 'claude-code-acceptEdits', workspacePolicy: 'attempt-worktree-parent-cwd',
          capabilities: { outputSchema: false, toolFilter: false },
        },
      },
    },
  }
  let task = {
    ...structuredClone(TASK),
    id: 'G-attempt-order-design', role: 'designer', goalId: 'G-attempt-order',
    status: 'todo', soldier: null, claimedAt: null,
    agentSelectionSnapshot: {
      source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'designer',
      reviewWorkflow, workflowStageId: 'design',
      agentToolConfig: reviewWorkflow.stageDefinitionsById.design.agentToolConfig,
    },
  }
  const calls = []
  let resolveRun
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/pipeline') return response({
      version: 'workflow-v1',
      stages: [{
        role: 'designer', label: 'Design', prompt: 'Create the design', next: 'coder',
        agentToolConfig: reviewWorkflow.stageDefinitionsById.design.agentToolConfig,
      }],
      workflow: { designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer', maxReworkRounds: 2 },
    })
    if (url.pathname === '/api/heartbeat' || url.pathname === '/api/agent-nodes/heartbeat') return response({ ok: true })
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/rules') return response({ rules: null })
    if (url.pathname === '/api/chat/replies') return response({ messages: [] })
    if (url.pathname === '/api/board') return response([task])
    if (url.pathname === '/api/goal') return response({ goals: [{ id: task.goalId, status: 'active' }] })
    if (url.pathname === '/api/claim') {
      task = { ...task, status: 'in_progress', soldier: body.soldier, claimedAt: new Date().toISOString() }
      return response({ task })
    }
    if (url.pathname === '/api/release-stale') return response({ released: [], quarantined: [] })
    if (url.pathname === '/api/agent-workflow/stage-attempts/start') {
      calls.push({ kind: 'attempt-start', body })
      return response({ id: 'attempt-persisted-before-provider' })
    }
    if (url.pathname === '/api/agent-workflow/stage-attempts/report') {
      calls.push({ kind: 'attempt-report', body })
      return response({ ok: true })
    }
    if (url.pathname === '/api/comment') {
      calls.push({ kind: 'comment', body })
      task = { ...task, comments: [...(task.comments ?? []), { by: body.by, at: new Date().toISOString(), text: body.text }] }
      return response({ task })
    }
    if (url.pathname === '/api/progress') return response({ ok: true })
    if (url.pathname === '/api/hold') { calls.push({ kind: 'hold', body }); return response({ ok: true }) }
    if (url.pathname === '/api/transition') {
      calls.push({ kind: 'transition', body })
      task = { ...task, status: body.to }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext(
    { status: 'done', summary: 'unused', evidence: '', blocker: '' },
    async () => {},
    async () => {},
    async (providerName, options) => {
      assert.ok(calls.some(call => call.kind === 'attempt-start'), 'provider must not start before its Stage Attempt is durable')
      calls.push({ kind: 'provider-start' })
      assert.equal(providerName, 'claude-code')
      assert.equal(options.prompt[0].type, 'text')
      assert.match(options.prompt[0].text, /不要调用 Bash、PowerShell、终端/)
      assert.match(options.prompt[0].text, /Legion 计算并登记 SHA-256/)
      return {
        id: 'provider-run-73',
        result: new Promise(resolve => { resolveRun = resolve }),
        dispose: async () => { calls.push({ kind: 'provider-dispose' }) },
      }
    },
  )
  harness.ctx.subagents.getProvider = name => name === 'claude-code' ? {
    name, permissionMode: 'acceptEdits',
    capabilities: { outputSchema: false, toolFilter: false, agentOptions: false },
  } : undefined
  harness.ctx.agents.create = async options => ({
    agent: { session: { id: String(options.sessionId), header: { cwd: options.meta.cwd } } },
    dispose: async () => {},
  })
  try {
    apply(harness.ctx, config(root, { isolate: true, scopes: 'off' }))
    harness.intervals[0]()
    try {
      await waitFor(() => calls.some(call => call.kind === 'attempt-report' && call.body.state === 'running'), 'provider Run ID was never persisted')
    } catch (error) {
      const workerLog = readFileSync(join(root, 'worker.log'), 'utf8')
      throw new Error(`${String(error)}; workerLog=${workerLog}`)
    }
    const attemptStartIndex = calls.findIndex(call => call.kind === 'attempt-start')
    const providerStartIndex = calls.findIndex(call => call.kind === 'provider-start')
    const runningReportIndex = calls.findIndex(call => call.kind === 'attempt-report' && call.body.state === 'running')
    assert.ok(attemptStartIndex >= 0 && attemptStartIndex < providerStartIndex, 'durable Attempt must precede provider start')
    assert.ok(providerStartIndex < runningReportIndex, 'Run ID must be reported as soon as provider returns its handle')
    assert.equal(calls[runningReportIndex].body.providerRunId, 'provider-run-73')

    resolveRun({ stopReason: 'error', diagnostic: 'Claude provider returned HTTP 429 after writing its partial design artifact' })
    await waitFor(() => calls.some(call => call.kind === 'attempt-report' && call.body.state === 'unknown'), 'failed execution was not recorded as unknown')
    const unknown = calls.find(call => call.kind === 'attempt-report' && call.body.state === 'unknown')
    assert.equal(unknown.body.providerRunId, 'provider-run-73')
    assert.match(unknown.body.error, /provider 诊断：Claude provider returned HTTP 429/)
    assert.ok(calls.some(call => call.kind === 'hold'), 'unknown side effects must quarantine the task')
    assert.ok(calls.some(call => call.kind === 'transition' && call.body.to === 'in_review'))
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('workflow task cancellation reaches DSH provider and records a confirmed canceled Attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-attempt-cancel-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  initGitRepo(root)

  const reviewWorkflow = {
    instanceId: 'G-attempt-cancel',
    designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer',
    designStageId: 'design', implementationStageId: 'implement', reviewStageId: 'review',
    maxReworkRounds: 2,
    stageDefinitionsById: {
      design: { workflowStageId: 'design', role: 'designer', label: 'Design', nextStageIds: ['implement'] },
    },
  }
  let task = {
    ...structuredClone(TASK),
    id: 'G-attempt-cancel-design', role: 'designer', goalId: 'G-attempt-cancel',
    status: 'todo', soldier: null, claimedAt: null,
    agentSelectionSnapshot: {
      source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'designer',
      reviewWorkflow, workflowStageId: 'design',
    },
  }
  const calls = []
  let signal
  let providerResolve
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/pipeline') return response({
      version: 'workflow-v1', stages: [{ role: 'designer', label: 'Design', prompt: 'Create the design' }],
    })
    if (url.pathname === '/api/heartbeat' || url.pathname === '/api/agent-nodes/heartbeat') return response({ ok: true })
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/rules') return response({ rules: null })
    if (url.pathname === '/api/chat/replies') return response({ messages: [] })
    if (url.pathname === '/api/board') return response([task])
    if (url.pathname === '/api/goal') return response({ goals: [{ id: task.goalId, status: 'active' }] })
    if (url.pathname === '/api/claim') {
      task = { ...task, status: 'in_progress', soldier: body.soldier, claimedAt: new Date().toISOString() }
      return response({ task })
    }
    if (url.pathname === '/api/release-stale') return response({ released: [], quarantined: [] })
    if (url.pathname === '/api/agent-workflow/stage-attempts/start') {
      calls.push({ kind: 'attempt-start', body })
      return response({ id: 'attempt-canceled-confirmed' })
    }
    if (url.pathname === '/api/agent-workflow/stage-attempts/report') {
      calls.push({ kind: 'attempt-report', body })
      return response({ ok: true })
    }
    if (url.pathname === '/api/comment') {
      calls.push({ kind: 'comment', body })
      task = { ...task, comments: [...(task.comments ?? []), { by: body.by, at: new Date().toISOString(), text: body.text }] }
      return response({ task })
    }
    if (url.pathname === '/api/progress') return response({ ok: true })
    if (url.pathname === '/api/hold' || url.pathname === '/api/transition') {
      calls.push({ kind: 'unexpected-state-change', body })
      return response({ ok: true })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext(
    { status: 'done', summary: 'unused', evidence: '', blocker: '' },
    async () => {}, async () => {}, async (_provider, options) => {
      signal = options.signal
      return {
        id: 'provider-run-canceled',
        result: new Promise(resolve => { providerResolve = resolve }),
        dispose: async () => { calls.push({ kind: 'provider-dispose' }) },
      }
    },
  )
  try {
    apply(harness.ctx, config(root, { isolate: true, scopes: 'off' }))
    harness.intervals[0]()
    await waitFor(() => typeof providerResolve === 'function', 'workflow provider did not start')
    task = { ...task, status: 'canceled' }
    await waitFor(() => signal?.aborted === true, 'Hub cancellation was not propagated to provider AbortSignal', 3000)
    providerResolve({ stopReason: 'cancelled' })
    await waitFor(() => calls.some(call => call.kind === 'attempt-report' && call.body.state === 'canceled'), 'confirmed cancellation was not persisted')
    const terminal = calls.find(call => call.kind === 'attempt-report' && call.body.state === 'canceled')
    assert.equal(terminal.body.providerRunId, 'provider-run-canceled')
    assert.equal(calls.some(call => call.kind === 'unexpected-state-change'), false, 'worker must not overwrite the user cancellation state')
    assert.equal(calls.some(call => call.kind === 'hold'), false, 'confirmed cancellation does not need unknown-outcome quarantine')
    assert.ok(calls.some(call => call.kind === 'provider-dispose'), 'provider resources must be disposed after cancellation')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('standalone workflow design task commits a checkpoint and auto-completes without space pipeline coupling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-workflow-design-handoff-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  initGitRepo(root)

  const reviewWorkflow = {
    instanceId: 'G-design-checkpoint',
    designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer',
    designStageId: 'design', implementationStageId: 'implement', reviewStageId: 'review',
    maxReworkRounds: 2,
    stageDefinitionsById: {
      design: { workflowStageId: 'design', id: 'design', role: 'designer', label: 'Design', nextStageIds: ['implement'] },
    },
  }
  let task = {
    ...structuredClone(TASK), id: 'G-design-checkpoint-design', role: 'designer', goalId: 'G-design-checkpoint',
    status: 'todo', soldier: null, claimedAt: null,
    agentSelectionSnapshot: {
      source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'designer',
      reviewWorkflow, workflowStageId: 'design',
      workflowContext: { designArtifacts: [], implementation: null, upstreamStages: [] },
    },
  }
  const calls = []
  let foremanCwd
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/pipeline') return response({ version: 'space-pipeline-v1', stages: [] })
    if (url.pathname === '/api/heartbeat' || url.pathname === '/api/agent-nodes/heartbeat') return response({ ok: true })
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/rules') return response({ rules: null })
    if (url.pathname === '/api/chat/replies') return response({ messages: [] })
    if (url.pathname === '/api/board') return response([task])
    if (url.pathname === '/api/goal') return response({ goals: [{ id: task.goalId, status: 'active' }] })
    if (url.pathname === '/api/claim') {
      task = { ...task, status: 'in_progress', soldier: body.soldier, claimedAt: new Date().toISOString() }
      return response({ task })
    }
    if (url.pathname === '/api/release-stale') return response({ released: [], quarantined: [] })
    if (url.pathname === '/api/agent-workflow/stage-attempts/start') {
      calls.push({ kind: 'attempt-start', body })
      return response({ id: 'attempt-design-checkpoint' })
    }
    if (url.pathname === '/api/agent-workflow/stage-attempts/report') {
      calls.push({ kind: 'attempt-report', body })
      return response({ ok: true })
    }
    if (url.pathname === '/api/artifact') {
      task = { ...task, artifacts: [...(task.artifacts ?? []), { kind: body.kind, path: body.path, title: body.title, digest: body.digest }] }
      return response({ task })
    }
    if (url.pathname === '/api/comment') {
      calls.push({ kind: body.isEvidence ? 'evidence' : 'comment', body })
      const item = { by: body.by, at: new Date().toISOString(), text: body.text }
      task = body.isEvidence
        ? { ...task, evidence: [...(task.evidence ?? []), item] }
        : { ...task, comments: [...(task.comments ?? []), item] }
      return response({ task })
    }
    if (url.pathname === '/api/progress') return response({ ok: true })
    if (url.pathname === '/api/advance') {
      calls.push({ kind: 'advance', body })
      task = { ...task, status: 'done', version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      calls.push({ kind: 'transition', body })
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext(
    { status: 'done', summary: 'design is ready', evidence: 'acceptance is explicit', blocker: '',
      artifact: { kind: 'file', path: 'docs/design.md', title: 'Design' } },
    async options => { foremanCwd = options.meta.cwd },
    async () => {},
    async () => {
      mkdirSync(join(foremanCwd, 'docs'), { recursive: true })
      writeFileSync(join(foremanCwd, 'docs', 'design.md'), '# Design\n\nAcceptance: deterministic handoff.\n')
      return { id: 'provider-design-run', result: Promise.resolve({ stopReason: 'completed', structured: {
        status: 'done', summary: 'design is ready', evidence: 'acceptance is explicit', blocker: '',
        artifact: { kind: 'file', path: 'docs/design.md', title: 'Design' },
      } }), dispose: async () => {} }
    },
  )
  try {
    apply(harness.ctx, config(root, { isolate: true, scopes: 'off' }))
    harness.intervals[0]()
    await waitFor(() => task.status === 'done', 'independent workflow stage did not auto-complete')
    const checkpoint = calls.find(call => call.kind === 'evidence' && call.body.text.startsWith('agent-workflow-stage-checkpoint:'))
    assert.ok(checkpoint, 'stage Git checkpoint must be persisted before making downstream tasks runnable')
    const saved = JSON.parse(checkpoint.body.text.slice('agent-workflow-stage-checkpoint:'.length))
    assert.equal(saved.stageId, 'design')
    assert.match(saved.sourceCommit, /^[0-9a-f]{40,64}$/i)
    assert.equal(calls.some(call => call.kind === 'advance'), true, 'success uses the frozen workflow DAG without depending on space stages')
    assert.equal(calls.some(call => call.kind === 'transition' && call.body.to === 'in_review'), false)
    assert.equal(task.artifacts?.[0]?.digest?.length, 64, 'design artifact digest remains available for downstream verification')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('Agent 自报通过且 runner 测试成功但修改冻结 worktree 时不交给 Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-independent-test-failure-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'test', 'mutates-source.test.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "import assert from 'node:assert/strict'",
    "import test from 'node:test'",
    "test('independent check passes but rewrites the frozen source', () => {",
    "  writeFileSync(new URL('../src.js', import.meta.url), \"export const value = 'rewritten by test'\\n\")",
    '  assert.equal(2 + 2, 4)',
    '})',
    '',
  ].join('\n'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'design.md'), 'Implementation design\n')
  const designDigest = createHash('sha256').update(readFileSync(join(root, 'docs', 'design.md'))).digest('hex')
  initGitRepo(root)
  const designCommit = git(root, ['rev-parse', 'HEAD']).out.trim()

  const runner = { executable: 'node', args: ['--test', 'test/mutates-source.test.mjs'], timeoutMs: 300000 }
  const reviewWorkflow = {
    instanceId: 'G-independent-test-failure', designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer',
    designStageId: 'design', implementationStageId: 'implement', reviewStageId: 'review', maxReworkRounds: 1,
    stageDefinitionsById: { implement: { id: 'implement', role: 'coder', testRunner: runner } },
  }
  const task = {
    ...structuredClone(TASK), id: 'G-independent-test-failure-implement', goalId: reviewWorkflow.instanceId,
    title: 'Implement but do not bypass the independent test gate', role: 'coder', status: 'todo', soldier: null,
    claimedAt: null, blockedBy: ['G-independent-test-failure-design'], artifacts: [], evidence: [], comments: [],
    agentSelectionSnapshot: {
      source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'coder', workflowStageId: 'implement',
      agentToolConfig: { id: 'deepseek', version: 1, providerName: 'deepseek', adapter: 'dsh-native',
        permissionProfile: 'workspace-write', workspacePolicy: 'attempt-worktree-parent-cwd', enabled: true,
        capabilities: { outputSchema: true, toolFilter: true, agentOptions: true, cancellation: true } },
      reviewWorkflow, workflowContext: { designArtifacts: [{ taskId: 'G-independent-test-failure-design', path: 'docs/design.md', digest: designDigest, title: 'Design' }], implementation: null, upstreamStages: [{
        taskId: 'G-independent-test-failure-design', stageId: 'design', artifacts: [{ kind: 'file', path: 'docs/design.md', digest: designDigest }],
        evidence: [{ text: `agent-workflow-stage-checkpoint:${JSON.stringify({ stageId: 'design', sourceCommit: designCommit })}` }],
      }] },
    },
  }
  const designTask = {
    id: 'G-independent-test-failure-design', title: 'Design', role: 'designer', goalId: reviewWorkflow.instanceId,
    status: 'done', blockedBy: [], artifacts: [{ kind: 'file', path: 'docs/design.md', title: 'Design', digest: designDigest }],
    evidence: [{ text: `agent-workflow-stage-checkpoint:${JSON.stringify({ stageId: 'design', sourceCommit: designCommit })}` }], comments: [], agentSelectionSnapshot: { workflowStageId: 'design', reviewWorkflow },
  }
  const calls = []
  const providerStarts = []
  const stageAttempts = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/pipeline') return response({ version: 'workflow-v1', stages: [] })
    if (url.pathname === '/api/heartbeat' || url.pathname === '/api/agent-nodes/heartbeat') return response({ ok: true })
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/rules') return response({ rules: null })
    if (url.pathname === '/api/chat/replies') return response({ messages: [] })
    if (url.pathname === '/api/board') return response([designTask, task])
    if (url.pathname === '/api/goal') return response({ goals: [{ id: task.goalId, status: 'active' }] })
    if (url.pathname === '/api/claim') {
      task.status = 'in_progress'; task.soldier = body.soldier; task.claimedAt = new Date().toISOString()
      return response({ task })
    }
    if (url.pathname === '/api/release-stale') return response({ released: [], quarantined: [] })
    if (url.pathname === '/api/agent-workflow/stage-attempts/start') {
      stageAttempts.push({ id: 'attempt-test-failure', state: 'starting' })
      calls.push({ kind: 'attempt-start', body })
      return response({ id: stageAttempts[0].id })
    }
    if (url.pathname === '/api/agent-workflow/stage-attempts/report') {
      const attempt = stageAttempts[0]
      Object.assign(attempt, { state: body.state, providerRunId: body.providerRunId, result: body.result })
      calls.push({ kind: 'attempt-report', body })
      return response({ ok: true })
    }
    if (url.pathname === '/api/comment') {
      const item = { by: body.by, at: new Date().toISOString(), text: body.text }
      if (body.isEvidence) task.evidence.push(item)
      else task.comments.push(item)
      calls.push({ kind: body.isEvidence ? 'evidence' : 'comment', body })
      return response({ task })
    }
    if (url.pathname === '/api/progress') return response({ ok: true })
    if (url.pathname === '/api/transition') {
      task.status = body.to
      calls.push({ kind: 'transition', body })
      return response({ task })
    }
    if (url.pathname === '/api/advance') {
      calls.push({ kind: 'advance', body })
      task.status = 'done'
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  const harness = fakeContext(
    { status: 'done', summary: 'unused', evidence: '', blocker: '' },
    async () => {}, async () => {},
    async (provider, options) => {
      providerStarts.push(provider)
      writeFileSync(join(options.parent.session.header.cwd, 'src.js'), "export const value = 'present'\n")
      return { id: 'run-failing-implementation', result: Promise.resolve({ stopReason: 'completed', structured: {
        status: 'done', summary: 'implementation complete', evidence: 'DSH says tests passed', blocker: '', artifact: null,
        testReport: { passed: true, command: 'agent-claimed-test', summary: 'passed', evidence: 'agent output', failures: [] },
      } }), dispose: async () => {} }
    },
  )
  harness.ctx.subagents.getProvider = name => ({
    capabilities: { outputSchema: true, toolFilter: true, agentOptions: true, cancellation: true },
  })
  harness.ctx.agents.create = async options => ({
    agent: { session: { id: String(options.sessionId), header: { cwd: options.meta.cwd } } },
    dispose: async () => {},
  })
  try {
    apply(harness.ctx, config(root, { isolate: true, scopes: 'off' }))
    harness.intervals[0]()
    await waitFor(() => task.status === 'in_review', 'worktree-changing test did not stop implementation handoff').catch(error => {
      const log = readFileSync(join(root, 'worker.log'), 'utf8')
      throw new Error(`${String(error)}; calls=${JSON.stringify(calls)}; workerLog=${log}`)
    })
    assert.deepEqual(providerStarts, ['deepseek'], `Codex must not start when the runner changes the frozen worktree; calls=${JSON.stringify(calls)}; attempts=${JSON.stringify(stageAttempts)}; workerLog=${readFileSync(join(root, 'worker.log'), 'utf8')}`)
    assert.equal(stageAttempts[0].state, 'completed')
    assert.equal(stageAttempts[0].providerRunId, 'run-failing-implementation')
    assert.equal(stageAttempts[0].result.testVerification.state, 'failed')
    assert.notEqual(stageAttempts[0].result.testVerification.exitCode, 0)
    assert.match(stageAttempts[0].result.testVerification.outputExcerpt, /ℹ pass 1\s+ℹ fail 0/,
      'the underlying test process passed; Legion rejected its receipt because the worktree changed')
    assert.equal(stageAttempts[0].result.testVerification.error, '测试执行期间实现提交或 worktree 状态发生变化')
    assert.equal(stageAttempts[0].result.testReport.passed, false)
    assert.equal(task.evidence.some(item => item.text.startsWith('agent-workflow-implementation:')), false)
    assert.equal(calls.some(call => call.kind === 'advance'), false)
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('Claude design → DSH implementation → Codex review closes over the exact Git and artifact versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-worker-three-agent-loop-'))
  const originalFetch = globalThis.fetch
  const originalIntegrationMode = process.env.LEGION_INTEGRATION_MODE
  const restoreTasks = protectTasksFile(root)
  delete process.env.LEGION_INTEGRATION_MODE
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'test', 'greeting.test.mjs'), [
    "import assert from 'node:assert/strict'",
    "import { readFileSync } from 'node:fs'",
    "import test from 'node:test'",
    "test('implementation exports greeting', () => assert.match(readFileSync(new URL('../src.js', import.meta.url), 'utf8'), /greeting/))",
    '',
  ].join('\n'))
  initGitRepo(root)
  const workflow = {
    instanceId: 'G-three-agent-loop', designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer',
    designStageId: 'design', implementationStageId: 'implement', reviewStageId: 'review', maxReworkRounds: 2,
    stageDefinitionsById: {
      design: { id: 'design', workflowStageId: 'design', role: 'designer', label: 'Design', nextStageIds: ['implement'] },
      implement: { id: 'implement', workflowStageId: 'implement', role: 'coder', label: 'Implementation', previousStageIds: ['design'], nextStageIds: ['review'], testRunner: { executable: 'node', args: ['--test', 'test/greeting.test.mjs'], timeoutMs: 300000 } },
      review: { id: 'review', workflowStageId: 'review', role: 'reviewer', label: 'Review', previousStageIds: ['implement'], nextStageIds: [] },
    },
  }
  const tool = (providerName, adapter, permissionProfile) => ({
    id: `tool-${providerName}`, version: 1, providerName, adapter,
    permissionProfile, workspacePolicy: 'attempt-worktree-parent-cwd', enabled: true,
    capabilities: adapter === 'dsh-subagent'
      ? { outputSchema: false, toolFilter: false, agentOptions: false, cancellation: true }
      : { outputSchema: true, toolFilter: true, agentOptions: true, cancellation: true },
  })
  const tasks = [
    {
      id: 'G-loop-design', title: 'Create an implementation design', description: 'Specify the greeting behavior.', acceptance: [],
      role: 'designer', status: 'todo', blockedBy: [], artifacts: [], evidence: [], comments: [],
      agentSelectionSnapshot: {
        source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'designer', workflowStageId: 'design',
        agentToolConfig: tool('claude-code', 'dsh-subagent', 'claude-code-acceptEdits'), modelConfig: null,
        reviewWorkflow: workflow, workflowContext: { designArtifacts: [], implementation: null, upstreamStages: [] },
      },
    },
    {
      id: 'G-loop-implementation', title: 'Implement the design', description: 'Implement and test the approved design.', acceptance: [],
      role: 'coder', status: 'todo', blockedBy: ['G-loop-design'], artifacts: [], evidence: [], comments: [],
      agentSelectionSnapshot: {
        source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'coder', workflowStageId: 'implement',
        agentToolConfig: tool('deepseek', 'dsh-native', 'workspace-write'), modelConfig: null,
        reviewWorkflow: workflow, workflowContext: { designArtifacts: [], implementation: null, upstreamStages: [] },
      },
    },
    {
      id: 'G-loop-review', title: 'Review the implementation', description: 'Review the design, implementation, and test evidence.', acceptance: [],
      role: 'reviewer', status: 'todo', blockedBy: ['G-loop-implementation'], artifacts: [], evidence: [], comments: [],
      agentSelectionSnapshot: {
        source: 'goal-agent-workflow', pipelineVersion: 'workflow-v1', stageRole: 'reviewer', workflowStageId: 'review',
        agentToolConfig: tool('codex', 'dsh-subagent', 'codex-workspace-write'), modelConfig: null,
        reviewWorkflow: workflow, workflowContext: { designArtifacts: [], implementation: null, upstreamStages: [] },
      },
    },
  ]
  const calls = []
  const providerStarts = []
  const stageAttempts = []
  let reviewStatus = null
  let reviewFindings = null
  let currentTasks = () => tasks
  const reviewContextFor = (task) => {
    const index = tasks.indexOf(task)
    const ancestors = tasks.slice(0, index)
    const design = tasks[0]
    const implementation = tasks[1]
    let implementationEvidence = null
    if (index >= 2) {
      const proof = [...implementation.evidence].reverse().find(entry => entry.text.startsWith('agent-workflow-implementation:'))
      if (proof) implementationEvidence = JSON.parse(proof.text.slice('agent-workflow-implementation:'.length))
    }
    const workflowContext = {
      designArtifacts: index === 0 ? [] : design.artifacts.filter(item => item.kind === 'file').map(item => ({
        taskId: design.id, path: item.path, digest: item.digest, title: item.title,
      })),
      implementation: index < 2 || !implementationEvidence ? null : {
        taskId: implementation.id, sourceCommit: implementationEvidence.sourceCommit,
        stageAttemptId: implementationEvidence.stageAttemptId, providerRunId: implementationEvidence.providerRunId,
        testCommand: implementationEvidence.testCommand, testSummary: implementationEvidence.testSummary,
        testEvidence: implementationEvidence.testEvidence, testVerification: implementationEvidence.testVerification,
      },
      upstreamStages: ancestors.map(upstream => ({
        stageId: upstream.agentSelectionSnapshot.workflowStageId,
        taskId: upstream.id, artifacts: upstream.artifacts, evidence: upstream.evidence,
      })),
    }
    task.agentSelectionSnapshot = { ...task.agentSelectionSnapshot, workflowContext }
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/pipeline') return response({ version: 'ordinary-pipeline-empty', stages: [] })
    if (url.pathname === '/api/heartbeat' || url.pathname === '/api/agent-nodes/heartbeat') return response({ ok: true })
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/rules') return response({ rules: null })
    if (url.pathname === '/api/chat/replies') return response({ messages: [] })
    if (url.pathname === '/api/board') return response(currentTasks())
    if (url.pathname === '/api/goal') return response({ goals: [{ id: workflow.instanceId, status: 'active' }] })
    if (url.pathname === '/api/claim') {
      const task = tasks.find(item => item.id === body.id)
      if (!task) throw new Error(`unknown task ${body.id}`)
      reviewContextFor(task)
      task.status = 'in_progress'
      task.soldier = body.soldier
      task.claimedAt = new Date().toISOString()
      return response({ task })
    }
    if (url.pathname === '/api/release-stale') return response({ released: [], quarantined: [] })
    if (url.pathname === '/api/agent-workflow/stage-attempts/start') {
      calls.push({ kind: 'attempt-start', body })
      stageAttempts.push({ id: `attempt-${stageAttempts.length + 1}`, taskId: body.taskId,
        providerName: body.providerName, workspaceDir: body.workspaceDir, state: 'starting' })
      return response({ id: stageAttempts.at(-1).id })
    }
    if (url.pathname === '/api/agent-workflow/stage-attempts/report') {
      calls.push({ kind: 'attempt-report', body })
      const attempt = stageAttempts.find(item => item.id === body.attemptId)
      attempt.state = body.state
      attempt.providerRunId = body.providerRunId
      attempt.result = body.result
      return response({ ok: true })
    }
    if (url.pathname === '/api/agent-workflow/review') {
      calls.push({ kind: 'review', body })
      const task = tasks.find(item => item.id === body.taskId)
      task.status = 'done'
      const reworkKind = body.findings.some(finding => finding.kind === 'design') ? 'design' : 'implementation'
      return response({ kind: 'rework', nextTaskId: `G-loop-${reworkKind}-rework`, reworkKind, round: 1, maxReworkRounds: 2 })
    }
    if (url.pathname === '/api/artifact') {
      const task = tasks.find(item => item.id === body.id)
      task.artifacts.push({ by: body.by, at: new Date().toISOString(), kind: body.kind, path: body.path, title: body.title, digest: body.digest })
      return response({ task })
    }
    if (url.pathname === '/api/comment') {
      const task = tasks.find(item => item.id === body.id)
      const entry = { by: body.by, at: new Date().toISOString(), text: body.text }
      if (body.isEvidence) task.evidence.push(entry)
      else task.comments.push(entry)
      calls.push({ kind: body.isEvidence ? 'evidence' : 'comment', body })
      return response({ task })
    }
    if (url.pathname === '/api/progress' || url.pathname === '/api/patch') return response({ ok: true })
    if (url.pathname === '/api/advance') {
      const task = tasks.find(item => item.id === body.id)
      task.status = 'done'
      task.version = (task.version ?? 1) + 1
      calls.push({ kind: 'advance', body })
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      const task = tasks.find(item => item.id === body.id)
      task.status = body.to
      task.version = (task.version ?? 1) + 1
      calls.push({ kind: 'transition', body })
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const reportFor = async (provider, options) => {
    providerStarts.push(provider)
    const cwd = options.parent.session.header.cwd
    const activeAttempt = [...stageAttempts].reverse().find(item => item.state === 'starting' && item.providerName === provider)
    assert.ok(activeAttempt, `${provider} must have a persisted Stage Attempt before startup`)
    assert.equal(resolve(cwd), resolve(activeAttempt.workspaceDir), `${provider} parent session cwd must be the frozen Attempt worktree`)
    if (provider === 'claude-code') {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      writeFileSync(join(cwd, 'docs', 'design.md'), '# Versioned design\n\nContract: render the greeting.\n')
      const report = { status: 'done', summary: 'design ready', evidence: 'docs/design.md contains the acceptance contract', blocker: '',
        artifact: { kind: 'file', path: resolve(cwd, 'docs/design.md'), title: 'Versioned design' } }
      return { id: 'run-claude-design', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }), dispose: async () => {} }
    }
    if (provider === 'deepseek') {
      const promptText = options.prompt.map(block => block.text ?? '').join('')
      assert.match(promptText, /UTF-8 文本按 LF 规范化后计算，CRLF 与 LF 等价/,
        'downstream agents must know workflow artifact digests ignore platform checkout line endings')
      const designText = readFileSync(join(cwd, 'docs', 'design.md'), 'utf8')
      assert.match(designText, /Contract: render the greeting/)
      writeFileSync(join(cwd, 'src.js'), "export const greeting = () => 'hello'\n")
      git(cwd, ['add', '-A'])
      assert.equal(git(cwd, ['commit', '-m', 'Agent implementation commit']).code, 0,
        'the coding Agent may commit its isolated worktree before Legion runs the independent tests')
      const report = { status: 'done', summary: 'implementation complete', evidence: 'src.js implements the versioned design', blocker: '', artifact: null,
        testReport: { passed: true, command: 'node --test test/greeting.test.js', summary: '1 test passed', evidence: '1 pass, 0 fail', failures: [] } }
      return { id: 'run-dsh-implementation', result: Promise.resolve({ stopReason: 'completed', structured: Object.freeze(report) }), dispose: async () => {} }
    }
    if (provider === 'codex') {
      const promptText = options.prompt.map(block => block.text ?? '').join('')
      assert.match(promptText, /允许使用只读文件查看与只读终端命令/,
        'the external reviewer must be allowed to inspect the worktree without permission to modify it')
      reviewStatus = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).out
      assert.match(readFileSync(join(cwd, 'docs', 'design.md'), 'utf8'), /Contract: render the greeting/)
      assert.match(readFileSync(join(cwd, 'src.js'), 'utf8'), /greeting/)
      const report = { status: 'done', summary: 'review passed', evidence: 'design and implementation commits are present', blocker: '', artifact: null,
        review: reviewFindings === null ? { passed: true, findings: [] } : { passed: false, findings: reviewFindings } }
      return { id: 'run-codex-review', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(report) }] }), dispose: async () => {} }
    }
    throw new Error(`unexpected provider ${provider}`)
  }
  const harness = fakeContext(
    { status: 'done', summary: 'unused', evidence: '', blocker: '' },
    async () => {},
    async () => {},
    reportFor,
  )
  harness.ctx.agents.create = async options => ({
    agent: { session: { id: String(options.sessionId), header: { cwd: options.meta.cwd } } },
    dispose: async () => {},
  })
  harness.ctx.subagents.getProvider = providerName => ({
    name: providerName,
    permissionMode: providerName === 'codex' ? 'approve-for-me' : providerName === 'claude-code' ? 'acceptEdits' : undefined,
    capabilities: providerName === 'deepseek'
      ? { outputSchema: true, toolFilter: true, agentOptions: true, cancellation: true }
      : { outputSchema: false, toolFilter: false, agentOptions: false, cancellation: true },
  })

  try {
    apply(harness.ctx, config(root, { isolate: true, scopes: 'off' }))
    harness.intervals[0]()
    await waitFor(() => tasks[0].status === 'done' && tasks[0].evidence.some(item => item.text.startsWith('agent-workflow-stage-checkpoint:')),
      'Claude design stage did not save its artifact and Git checkpoint').catch(error => {
      throw new Error(`${String(error)}; task=${JSON.stringify(tasks[0])}; attempts=${JSON.stringify(stageAttempts)}; log=${readFileSync(join(root, 'worker.log'), 'utf8')}`)
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    harness.intervals[0]()
    await waitFor(() => tasks[1].status === 'done' && tasks[1].evidence.some(item => item.text.startsWith('agent-workflow-implementation:')),
      'DSH implementation did not consume design or save implementation evidence').catch(error => {
      throw new Error(`${String(error)}; task=${JSON.stringify(tasks[1])}; attempts=${JSON.stringify(stageAttempts)}; log=${readFileSync(join(root, 'worker.log'), 'utf8')}`)
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    harness.intervals[0]()
    await waitFor(() => tasks[2].status === 'in_review', 'Codex review pass did not enter Legion final acceptance')
    assert.deepEqual(providerStarts, ['claude-code', 'deepseek', 'codex'])
    assert.deepEqual(stageAttempts.map(item => [item.state, item.providerRunId]), [
      ['completed', 'run-claude-design'], ['completed', 'run-dsh-implementation'], ['completed', 'run-codex-review'],
    ])
    assert.deepEqual(stageAttempts[2].result.review, { passed: true, findings: [] },
      'successful Codex conclusion is included in the Stage Attempt report sent to Hub')
    assert.equal(stageAttempts[2].result.summary, 'review passed')
    assert.equal(tasks[0].artifacts[0].path, 'docs/design.md', 'absolute artifact paths from an independent workflow worktree are stored relative to that worktree')
    assert.equal(tasks[0].artifacts[0].digest.length, 64)
    const reviewCheckpoint = tasks[2].evidence.find(item => item.text.startsWith('agent-workflow-stage-checkpoint:'))
    assert.ok(reviewCheckpoint, 'review stage checkpoint must be persisted before final acceptance')
    const reviewCheckpointText = reviewCheckpoint.text
    assert.equal(JSON.parse(reviewCheckpointText.slice('agent-workflow-stage-checkpoint:'.length)).stageId, 'review')
    const implementationProof = JSON.parse(tasks[1].evidence.find(item => item.text.startsWith('agent-workflow-implementation:')).text.slice('agent-workflow-implementation:'.length))
    assert.match(implementationProof.sourceCommit, /^[0-9a-f]{40,64}$/i)
    assert.equal(implementationProof.stageAttemptId, stageAttempts[1].id)
    assert.equal(implementationProof.providerRunId, 'run-dsh-implementation')
    assert.ok(tasks[1].artifacts.some(item => item.kind === 'file' && item.path === 'src.js'),
      'files in the implementation commit are registered as artifacts even when the Agent did not name them in its report')
    assert.equal(implementationProof.testCommand, 'node --test test/greeting.test.mjs')
    assert.equal(implementationProof.testVerification.state, 'passed')
    assert.equal(implementationProof.testVerification.sourceCommit, implementationProof.sourceCommit)
    assert.equal(implementationProof.testVerification.stageAttemptId, stageAttempts[1].id)
    assert.equal(implementationProof.testVerification.providerRunId, 'run-dsh-implementation')
    assert.match(implementationProof.testEvidence, /implementation exports greeting/)
    assert.equal(stageAttempts[1].result.testVerification.id, implementationProof.testVerification.id,
      'the independent runner receipt must be persisted with its Stage Attempt')
    assert.deepEqual(stageAttempts[1].result.agentTestReport, {
      passed: true, command: 'node --test test/greeting.test.js', summary: '1 test passed',
      evidence: '1 pass, 0 fail', failures: [],
    }, 'Agent self-report remains separately auditable and is not confused with Legion test evidence')
    assert.equal(reviewStatus, '', `Codex review must start from a clean imported worktree: ${reviewStatus}`)
    assert.ok(git(join(root, '.legion-worktrees', tasks[2].id), ['merge-base', '--is-ancestor', implementationProof.sourceCommit, 'HEAD']).code === 0,
      'Codex review worktree must contain the exact implementation commit')
    assert.equal(tasks[2].status, 'in_review', 'passed code review still waits for Legion independent verification and acceptance')

    reviewFindings = [{ kind: 'implementation', severity: 'major', summary: 'Handle the empty greeting case', file: 'src.js', verification: 'Add and run an empty-input test.' }]
    tasks[2].status = 'todo'
    harness.intervals[0]()
    await waitFor(() => calls.some(call => call.kind === 'review'), 'typed Codex finding was not sent to the Hub review handler')
    const reviewCall = calls.find(call => call.kind === 'review')
    assert.equal(reviewCall.body.taskId, tasks[2].id)
    assert.deepEqual(reviewCall.body.findings, reviewFindings)
    assert.equal(reviewCall.body.summary, 'review passed')
    assert.deepEqual(stageAttempts[3].result.review, { passed: false, findings: reviewFindings },
      'typed Codex findings stay attached to the exact review Stage Attempt before Hub routes rework')
    assert.equal(tasks[2].status, 'done', 'worker settles the review task only after the Hub returns a persisted rework outcome')
    assert.equal(tasks[2].comments.at(-1).text.includes('G-loop-implementation-rework'), true)

    reviewFindings = [{ kind: 'design', severity: 'major', summary: 'Define behavior for empty greetings', file: 'docs/design.md', verification: 'State the empty-input acceptance case.' }]
    tasks[2].status = 'todo'
    harness.intervals[0]()
    await waitFor(() => calls.filter(call => call.kind === 'review').length === 2, 'design finding was not sent to the Hub review handler')
    await waitFor(() => tasks[2].comments.some(comment => comment.text.includes('G-loop-design-rework')),
      'worker did not settle the design rework returned by Hub')
    const designReviewCall = calls.filter(call => call.kind === 'review')[1]
    assert.deepEqual(designReviewCall.body.findings, reviewFindings)
    assert.equal(tasks[2].status, 'done')

    reviewFindings = [
      { kind: 'implementation', severity: 'major', summary: 'Add boundary validation', file: 'src.js', verification: 'Test invalid values.' },
      { kind: 'design', severity: 'major', summary: 'Define the invalid-value contract', file: 'docs/design.md', verification: 'Update the acceptance contract.' },
    ]
    tasks[2].status = 'todo'
    harness.intervals[0]()
    await waitFor(() => calls.filter(call => call.kind === 'review').length === 3, 'mixed findings were not sent to the Hub review handler')
    await waitFor(() => tasks[2].comments.filter(comment => comment.text.includes('G-loop-design-rework')).length >= 2,
      'worker did not settle the design-first rework returned for mixed findings')
    const mixedReviewCall = calls.filter(call => call.kind === 'review')[2]
    assert.deepEqual(mixedReviewCall.body.findings, reviewFindings, 'worker preserves both finding categories for Hub policy')
    assert.equal(tasks[2].status, 'done')
    assert.deepEqual(providerStarts, ['claude-code', 'deepseek', 'codex', 'codex', 'codex', 'codex'])
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    if (originalIntegrationMode === undefined) delete process.env.LEGION_INTEGRATION_MODE
    else process.env.LEGION_INTEGRATION_MODE = originalIntegrationMode
    restoreTasks()
    await cleanup(root)
  }
})

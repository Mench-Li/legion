import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** 测试内执行 git（isolate 换基线用例用）。 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

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

function protectTasksFile(root) {
  const original = process.env.LEGION_TASKS_FILE
  process.env.LEGION_TASKS_FILE = join(root, 'scrum', 'tasks.json')
  return () => {
    if (original === undefined) delete process.env.LEGION_TASKS_FILE
    else process.env.LEGION_TASKS_FILE = original
  }
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

async function cleanup(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function fakeContext(report) {
  const intervals = []
  const disposers = []
  return {
    intervals,
    disposers,
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
      agentPresets: { mount: async () => {} },
      agents: {
        create: async () => ({
          agent: { session: { id: 'foreman-test' } },
          dispose: async () => {},
        }),
      },
      subagents: {
        start: async () => ({
          result: Promise.resolve({ stopReason: 'completed', structured: report }),
          dispose: async () => {},
        }),
      },
      setInterval: fn => { intervals.push(fn); return 1 },
      effect: disposer => { disposers.push(disposer) },
      logger: { info: () => {} },
    },
  }
}

/** 带按 label 路由的 worker 启动器：label=scrum:<taskId>，可让指定任务挂起、其余即时结算。 */
function fakeContextRouted(startByLabel) {
  const intervals = []
  const disposers = []
  return {
    intervals,
    disposers,
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
      agentPresets: { mount: async () => {} },
      agents: {
        create: async () => ({
          agent: { session: { id: 'foreman-test' } },
          dispose: async () => {},
        }),
      },
      subagents: {
        start: async (provider, options) => {
          const label = options?.label ?? ''
          const override = startByLabel[label]
          if (override) return override
          return {
            result: Promise.resolve({
              stopReason: 'completed',
              structured: { status: 'done', summary: 'ok', evidence: 'ok', blocker: '', artifact: null },
            }),
            dispose: async () => {},
          }
        },
      },
      setInterval: fn => { intervals.push(fn); return 1 },
      effect: disposer => { disposers.push(disposer) },
      logger: { info: () => {} },
    },
  }
}

const TD = {
  id: 'T-001',
  title: '【测试用例设计】目标',
  description: '[auto-goal]\n[slice-mode]\n目标：做一个切片目标\n本阶段：测试用例设计',
  acceptance: [],
  priority: 'high',
  status: 'done',
  version: 3,
  soldier: 'test-designer',
  claimedAt: '2026-09-02T00:00:00.000Z',
  parent: null,
  role: 'test-designer',
  scope: 'default',
  hold: false,
  blockedBy: [],
  comments: [],
  slice: null,
  sliceIdx: null,
  fixOf: null,
  fixCount: 0,
  testReport: null,
}

/** hub 打桩基座：board/技能/空间/租约回收/评论通用，写路径交给 use 收集。 */
function hubStub({ board, requests }) {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/release-stale') return response({ released: [] })
    if (url.pathname === '/api/board') return response(board())
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task: board()[0] }) }
    if (url.pathname === '/api/progress') return response({ task: board().find(t => t.id === body.id) })
    return undefined // 让各测试的 stub 继续处理写路径
  }
}

test('slice analysis tail done triggers beam registration parsed from TASK_BREAKDOWN.md', async () => {
  // readyToExpand：test-designer（[slice-mode]）done 且切片束未注册 → 解析 docs/TASK_BREAKDOWN.md
  // 的机器可读切片清单 → POST /api/goal/slices（幂等注册交给 server 侧，守护侧只负责解析+投递）。
  const root = await mkdtemp(join(tmpdir(), 'slice-expand-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'TASK_BREAKDOWN.md'), [
    '# 拆解说明',
    '## slices',
    '- S1 | 登录接口 | src/auth.ts, src/auth.test.ts | 注册成功返回 201; 密码错误返回 401',
    '- S2 | 用户资料页 | src/profile.tsx | 加载成功渲染用户信息',
    '',
  ].join('\n'))
  const requests = []
  let posted
  const base = hubStub({ board: () => [TD], requests })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/goal/slices') {
      posted = body
      return response({ task: { created: ['T-002', 'T-003', 'T-004', 'T-005'], devops: 'T-006' } })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task: TD }) }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'done', summary: '', evidence: '', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => posted !== undefined, 'beam was never registered')
    assert.equal(posted.testDesignerTaskId, 'T-001')
    assert.equal(posted.slices.length, 2)
    assert.deepEqual(posted.slices.map(s => s.title), ['登录接口', '用户资料页'])
    assert.deepEqual(posted.slices[0].files, ['src/auth.ts', 'src/auth.test.ts'])
    assert.deepEqual(posted.slices[0].acceptance, ['注册成功返回 201', '密码错误返回 401'])
    assert.ok(requests.includes('comment'), 'registration confirmation comment missing')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('a passing slice tester report auto-advances done under tester identity (D7 gate)', async () => {
  // 机器闸门：tester worker 回报 testReport.passed=true → /api/test-report 登记 → advance by=tester。
  // 不出现 in_review（人工验收）路径。
  const root = await mkdtemp(join(tmpdir(), 'slice-gate-pass-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'coder', label: '编码实现', prompt: 'code', next: 'tester' },
      { role: 'tester', label: '测试执行', prompt: 'test', next: null },
    ],
  }))
  const requests = []
  const dep = { ...TD, id: 'T-001', role: 'coder', title: '【切片 S1 编码】登录', status: 'done', slice: 'T-001:S1', sliceIdx: 1 }
  const tester = {
    ...TD, id: 'T-002', role: 'tester', title: '【切片 S1 测试】登录', status: 'todo', soldier: null,
    claimedAt: null, slice: 'T-001:S1', sliceIdx: 1, blockedBy: ['T-001'], fixCount: 0, testReport: null,
  }
  let task = structuredClone(tester)
  const base = hubStub({ board: () => [dep, task], requests })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      task = { ...task, status: 'in_progress', soldier: 'tester', version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task }) }
    if (url.pathname === '/api/test-report') {
      requests.push(`test-report:${body.passed}`)
      task = { ...task, testReport: { passed: body.passed, failures: [], at: '2026-09-02T00:00:00.000Z' }, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.by}`)
      task = { ...task, status: 'done', version: task.version + 1 }
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({
    status: 'done', summary: 'S1 测试全绿', evidence: 'npm test: 3 passed', blocker: '',
    testReport: { passed: true, summary: 'S1 全绿', failures: [] },
  })
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => requests.includes('advance:tester'), 'passing tester was never auto-done')
    assert.ok(requests.includes('test-report:true'), 'test-report(true) was not registered')
    assert.ok(!requests.some(r => r.startsWith('transition:in_review')), `must not route via in_review, got ${requests.join(', ')}`)
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('a failing slice tester parks in_review and creates a bounded fix task', async () => {
  // D7' 失败路径：passed=false → test-report(false) 登记 → in_review → 创建 fix 回炉任务
  // （role coder, fixOf=本 tester, slice 保留同一切片, blockedBy=[] 由守护条件闸门把关）。
  const root = await mkdtemp(join(tmpdir(), 'slice-gate-fail-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'coder', label: '编码实现', prompt: 'code', next: 'tester' },
      { role: 'tester', label: '测试执行', prompt: 'test', next: null },
    ],
  }))
  const requests = []
  const dep = { ...TD, id: 'T-001', role: 'coder', title: '【切片 S1 编码】登录', status: 'done', slice: 'T-001:S1', sliceIdx: 1 }
  let task = {
    ...TD, id: 'T-002', role: 'tester', title: '【切片 S1 测试】登录', status: 'todo', soldier: null,
    claimedAt: null, slice: 'T-001:S1', sliceIdx: 1, blockedBy: ['T-001'], fixCount: 0, testReport: null,
  }
  const base = hubStub({ board: () => [dep, task], requests })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${task.status}`)
      task = { ...task, status: 'in_progress', soldier: 'tester', version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task }) }
    if (url.pathname === '/api/test-report') {
      requests.push(`test-report:${body.passed}`)
      task = { ...task, testReport: { passed: body.passed, failures: body.failures, at: '2026-09-02T00:00:00.000Z' }, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task })
    }
    if (url.pathname === '/api/create') {
      requests.push('create-fix')
      return response({ task: { id: 'T-003', ...body } })
    }
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.by}`)
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({
    status: 'done', summary: 'S1 测试失败', evidence: 'npm test: 1 failed', blocker: '',
    testReport: {
      passed: false, summary: '登录用例失败', failures: [{ name: 'tc-login-401', log: 'expected 401 got 200', repro: 'npm test -- tc-login' }],
    },
  })
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => requests.includes('create-fix'), 'failing tester did not spawn a fix task')
    assert.ok(requests.includes('test-report:false'), 'test-report(false) was not registered')
    assert.ok(requests.includes('transition:in_review:tester'), 'failing tester did not park in_review under tester')
    assert.ok(!requests.some(r => r.startsWith('advance:')), 'failing tester must never auto-done')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('a completed fix reopens the tester for retest unless budget escalation stopped it', async () => {
  // 机器闸门闭环：fix 任务合入 done → tester（in_review）自动重开（in_review→todo）；
  // 但已升级将军（预算用尽评论）的 tester 绝不自动重开，避免 fix 全 done 后的无限重测循环。
  const root = await mkdtemp(join(tmpdir(), 'slice-retest-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const requests = []
  const dep = { ...TD, id: 'T-001', role: 'coder', status: 'done', slice: 'T-001:S1', sliceIdx: 1 }
  const fix = {
    ...TD, id: 'T-003', role: 'coder', title: '【切片 S1 修复】登录', status: 'done',
    slice: 'T-001:S1', sliceIdx: 1, fixOf: 'T-002', blockedBy: [],
  }
  let tester = {
    ...TD, id: 'T-002', role: 'tester', title: '【切片 S1 测试】登录', status: 'in_review', soldier: 'tester',
    claimedAt: '2026-09-02T00:00:00.000Z', slice: 'T-001:S1', sliceIdx: 1, blockedBy: ['T-001'],
    fixCount: 1,
    testReport: { passed: false, failures: [{ name: 'tc', log: 'boom', repro: '' }], at: '2026-09-02T00:00:00.000Z' },
  }
  const base = hubStub({ board: () => [dep, tester, fix], requests })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      tester = { ...tester, status: body.to, soldier: body.to === 'todo' ? null : tester.soldier, version: tester.version + 1 }
      return response({ task: tester })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task: tester }) }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'done', summary: '', evidence: '', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    harness.intervals[0]()
    await waitFor(() => requests.includes('transition:todo:tester'), 'completed fix did not reopen the tester')
    assert.ok(!requests.some(r => r.startsWith('transition:in_review')), `unexpected transitions: ${requests.join(', ')}`)
    // 预算用尽护栏：tester 被升级将军后，即使 fix 全 done 也不得自动重开
    tester = {
      ...tester,
      status: 'in_review',
      comments: [{ by: 'soldier-auto', at: '2026-09-02T00:00:01.000Z', text: '❓ 修复预算已用尽（maxFixPerSlice=2...）' }],
    }
    const before = requests.length
    harness.intervals[0]()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(requests.length, before, `escalated tester must not auto-reopen: ${requests.slice(before).join(', ')}`)
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('a tester slice worker runs while another slice coder is still in flight (cross-slice overlap)', async () => {
  // 核心架构验证（Q1/Q2 答案的机器证据）：切片之间互不依赖 —— coder_S2 的 worker 挂起占 1 个
  // worker 槽时，tester_S1（依赖自己的 coder_S1，已 done）仍被派工；即「S1 在测、S2 在写」可重叠，
  // 串行化只来自 maxWorkers=1（本测试显式 maxWorkers=2 证明引擎在切片粒度支持并行）。
  const root = await mkdtemp(join(tmpdir(), 'slice-overlap-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'coder', label: '编码实现', prompt: 'code', next: 'tester' },
      { role: 'tester', label: '测试执行', prompt: 'test', next: null },
    ],
  }))
  const requests = []
  const tdDone = { ...TD, id: 'T-001', status: 'done', slice: null }
  const coderS1 = { ...TD, id: 'T-100', role: 'coder', title: '【切片 S1 编码】', status: 'done', slice: 'T-001:S1', sliceIdx: 1 }
  let coderS2 = {
    ...TD, id: 'T-200', role: 'coder', title: '【切片 S2 编码】', status: 'todo', soldier: null, claimedAt: null,
    slice: 'T-001:S2', sliceIdx: 2, blockedBy: ['T-001'], fixCount: 0, testReport: null,
  }
  let testerS1 = {
    ...TD, id: 'T-300', role: 'tester', title: '【切片 S1 测试】', status: 'todo', soldier: null, claimedAt: null,
    slice: 'T-001:S1', sliceIdx: 1, blockedBy: ['T-100'], fixCount: 0, testReport: null,
  }
  let coderWorkerPending = false
  const base = hubStub({ board: () => [tdDone, coderS1, coderS2, testerS1], requests })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push(`claim:${body.id}`)
      if (body.id === coderS2.id) coderS2 = { ...coderS2, status: 'in_progress', soldier: 'coder', version: coderS2.version + 1 }
      if (body.id === testerS1.id) testerS1 = { ...testerS1, status: 'in_progress', soldier: 'tester', version: testerS1.version + 1 }
      return response({ task: body.id === coderS2.id ? coderS2 : testerS1 })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task: coderS2 }) }
    if (url.pathname === '/api/test-report') {
      requests.push(`test-report:${body.passed}`)
      testerS1 = { ...testerS1, testReport: { passed: body.passed, failures: [], at: '2026-09-02T00:00:00.000Z' } }
      return response({ task: testerS1 })
    }
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.id ?? body.by}`)
      testerS1 = { ...testerS1, status: 'done', version: testerS1.version + 1 }
      return response({ task: testerS1 })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  let resolveCoder
  const coderRun = { result: new Promise(res => { resolveCoder = res }), dispose: async () => {} }
  const harness = fakeContextRouted({
    'scrum:T-200': (() => { coderWorkerPending = true; return coderRun })(),
    'scrum:T-300': {
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          status: 'done', summary: 'S1 全绿', evidence: 'npm test: 2 passed', blocker: '',
          testReport: { passed: true, summary: 'S1 全绿', failures: [] },
        },
      }),
      dispose: async () => {},
    },
  })
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json'), maxWorkers: 2 }))
    harness.intervals[0]()
    // coder_S2 的 worker 先进入挂起态，tester_S1 仍在同一轮被认领并完成（两个 worker 重叠）
    await waitFor(() => requests.some(r => r.startsWith('claim:T-200')), 'coder slice was never claimed')
    await waitFor(() => coderWorkerPending, 'coder worker never became pending')
    await waitFor(() => requests.some(r => r.startsWith('advance:')), 'tester slice never settled while coder worker pending')
    assert.ok(requests.some(r => r.startsWith('claim:T-300')), `tester_S1 was not dispatched while coder_S2 in flight: ${requests.join(', ')}`)
    assert.ok(coderWorkerPending, 'cross-slice overlap requires the coder worker to still be running at tester settle')
    // 让挂起的 coder worker 结算，避免看门狗定时器拖住进程退出
    resolveCoder({ stopReason: 'completed', structured: { status: 'blocked', summary: 'done-late', evidence: '', blocker: '' } })
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

test('retest reopen drops the stale tester worktree so retests run on the fixed main baseline', async () => {
  // 换基线语义：fix 合入 done 后守护重开 tester（in_review→todo）时，必须清掉上一轮的 tester
  // worktree/分支——否则 prepareWorktree 复用旧快照，重测跑在合入修复前的代码上（v0.3 补丁回归）。
  const root = await mkdtemp(join(tmpdir(), 'slice-retest-baseline-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  initGitRepo(repo)
  // 模拟上一轮 tester 的 stale worktree/分支（指向旧 HEAD；main 随后已被 fix 合入前进——测试只关心清理动作）
  const staleDir = join(root, 'wt', 'T-200')
  mkdirSync(join(root, 'wt'), { recursive: true })
  const add = git(repo, ['worktree', 'add', '-b', 'w/T-200', staleDir, 'HEAD'])
  if (add.code !== 0) throw new Error(`stale worktree add 失败：${add.err}`)
  const requests = []
  const dep = { ...TD, id: 'T-100', role: 'coder', status: 'done', slice: 'T-001:S1', sliceIdx: 1 }
  const fix = {
    ...TD, id: 'T-300', role: 'coder', title: '【切片 S1 修复】', status: 'done',
    slice: 'T-001:S1', sliceIdx: 1, fixOf: 'T-200', blockedBy: [],
  }
  let tester = {
    ...TD, id: 'T-200', role: 'tester', title: '【切片 S1 测试】', status: 'in_review', soldier: 'tester',
    claimedAt: '2026-09-02T00:00:00.000Z', slice: 'T-001:S1', sliceIdx: 1, blockedBy: ['T-100'],
    fixCount: 1,
    testReport: { passed: false, failures: [{ name: 'tc', log: 'boom', repro: '' }], at: '2026-09-02T00:00:00.000Z' },
  }
  const base = hubStub({ board: () => [dep, tester, fix], requests })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      tester = { ...tester, status: body.to, soldier: body.to === 'todo' ? null : tester.soldier }
      return response({ task: tester })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task: tester }) }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeContext({ status: 'done', summary: '', evidence: '', blocker: '' })
  try {
    apply(harness.ctx, config(root, {
      isolate: true, repoRoot: repo, worktreeRoot: join(root, 'wt'),
      rolesFile: join(root, 'missing-roles.json'), scrumDir: join(root, 'scrum'),
    }))
    harness.intervals[0]()
    await waitFor(() => requests.some(r => r.startsWith('transition:todo:')), 'tester was never reopened after fix')
    // stale worktree 与分支必须已被清理
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/w/T-200']).code !== 0, true, 'stale branch w/T-200 must be deleted')
    assert.equal(git(repo, ['worktree', 'list']).out.includes(staleDir), false, 'stale worktree dir must be removed from git')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanup(root)
  }
})

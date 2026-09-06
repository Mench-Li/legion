// plugins/tests/goal-context.test.mjs — 目标级上下文（A：派工注入 + 镜像 docs/goals/<id>.md）
// 与文件域机器闸门（B：merge 前越域打回）的守护契约测试。
// 运行：node --test tests/goal-context.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

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
  if (git(root, ['commit', '-m', 'init']).code !== 0) throw new Error('git 初始提交失败')
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

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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

const GOAL = {
  id: 'G-1',
  scope: 'software',
  objective: '目标甲：交付登录与资料页',
  status: 'active',
  mode: 'slice',
  context: '共享上下文：\n- 不许动 team-hub 存储层；\n- 验收口径 = 契约测试全绿；\n- 文件域地图以各切片声明为准。',
  contextVersion: 3,
}

const TD = {
  id: 'T-000',
  title: '任务',
  description: '[auto-goal]',
  acceptance: [],
  priority: 'high',
  status: 'todo',
  version: 1,
  soldier: null,
  claimedAt: null,
  parent: null,
  role: 'coder',
  scope: 'software',
  hold: false,
  blockedBy: [],
  comments: [],
  slice: null,
  sliceIdx: null,
  fixOf: null,
  fixCount: 0,
  goalId: 'G-1',
  fileDomain: null,
  testReport: null,
}

/** hub 打桩基座：本轮守护每轮都会打的目标/技能/空间/租约 + 写路径由各测试闭包继续。 */
function hubBase({ board, goals = [GOAL] }) {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/release-stale') return response({ released: [] })
    if (url.pathname === '/api/goal') return response({ goals })
    if (url.pathname === '/api/board') return response(board())
    return undefined
  }
}

function fakeHarnessBase() {
  const intervals = []
  const disposers = []
  return {
    intervals,
    disposers,
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
      agentPresets: { mount: async () => {} },
      agents: {
        create: async () => ({ agent: { session: { id: 'foreman-test' } }, dispose: async () => {} }),
      },
      setInterval: fn => { intervals.push(fn); return 1 },
      effect: disposer => { disposers.push(disposer) },
      logger: { info: () => {} },
    },
  }
}

/** 捕获派工提示词 + 即时完成（done）的 ctx。 */
function capturePromptHarness(captured) {
  const h = fakeHarnessBase()
  h.ctx.subagents = {
    start: async (provider, options) => {
      captured.push(options.prompt?.[0]?.text ?? '')
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          structured: { status: 'done', summary: '完成', evidence: 'evidence: ok', blocker: '', artifact: null },
        }),
        dispose: async () => {},
      }
    },
  }
  return h
}

test('目标上下文注入：派工提示词含所属目标/objective/context vN/并行任务表，镜像 docs/goals/<goalId>.md 落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-ctx-inject-'))
  const originalFetch = globalThis.fetch
  mkdirSync(join(root, 'scrum'), { recursive: true })
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [{ role: 'coder', label: '编码实现', prompt: 'code', next: null }],
  }))
  const dep = { ...TD, id: 'T-001', role: 'coder', title: '【切片 S1 编码】登录', status: 'done', slice: 'T-001:S1', sliceIdx: 1, fileDomain: ['src/auth.ts'] }
  const task = { ...TD, id: 'T-200', role: 'coder', title: '【切片 S2 编码】资料页', status: 'todo', slice: 'T-001:S2', sliceIdx: 2, fileDomain: ['src/profile.tsx'], blockedBy: ['T-001'] }
  const requests = []
  const captured = []
  const base = hubBase({ board: () => [dep, task], goals: [GOAL] })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push('claim')
      task.status = 'in_progress'
      task.soldier = 'coder'
      return response({ task })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task }) }
    if (url.pathname === '/api/progress') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}`)
      task.status = body.to
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = capturePromptHarness(captured)
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => captured.length > 0, 'worker never dispatched')
    const prompt = captured[0]
    assert.ok(prompt.includes('所属目标：G-1'), 'prompt 应含所属目标行')
    assert.ok(prompt.includes('目标甲：交付登录与资料页'), 'prompt 应含 objective')
    assert.ok(prompt.includes('目标上下文（contextVersion v3）'), 'prompt 应含 context 版本')
    assert.ok(prompt.includes('不许动 team-hub 存储层'), 'prompt 应内联目标上下文正文')
    assert.ok(prompt.includes('- T-001｜coder｜done｜T-001:S1'), 'prompt 应含并行任务快照（兄弟任务）')
    assert.ok(prompt.includes('文件域约束（机器校验）'), 'prompt 应含文件域约束段')
    assert.ok(prompt.includes('- src/profile.tsx'), 'prompt 应列出本任务声明文件域')
    assert.ok(prompt.includes('G-1.md'), 'prompt 应指向上下文镜像文件')
    // 镜像落盘：docs/goals/G-1.md（版本头 + objective + 正文 + 并行任务）
    const mirror = join(root, 'docs', 'goals', 'G-1.md')
    assert.equal(existsSync(mirror), true, '目标上下文镜像应写入工作目录 docs/goals/G-1.md')
    const mirrorText = readFileSync(mirror, 'utf8')
    assert.ok(mirrorText.includes('版本 v3'), '镜像应含版本头')
    assert.ok(mirrorText.includes('目标甲：交付登录与资料页'))
    assert.ok(mirrorText.includes('不许动 team-hub 存储层'))
    assert.ok(mirrorText.includes('- T-001｜coder｜done'), '镜像应含派工时刻并行任务快照')
    await waitFor(() => requests.includes('transition:in_review'), 'final stage task should park in_review')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await cleanup(root)
  }
})

function setupIsolatedRepo(taskSpec, branchFiles) {
  const root = mkdtempSync(join(tmpdir(), 'goal-domain-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  initGitRepo(repo)
  // 预置任务分支 w/<id> 及其越界/合规改动（模拟 worker 已完成并提交到分支）
  const id = taskSpec.id
  git(repo, ['checkout', '-b', `w/${id}`])
  for (const f of branchFiles) {
    mkdirSync(join(repo, f.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(repo, f), `${f} content\n`)
  }
  git(repo, ['add', '-A'])
  if (git(repo, ['commit', '-m', `${id} changes`]).code !== 0) throw new Error('任务分支提交失败')
  git(repo, ['checkout', 'master'])
  return { root, repo }
}

test('目标级文档目录：gate 文档按 docs/<goalId>/ 校验，提示词与完成评论指向目标目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-docdir-gate-'))
  const originalFetch = globalThis.fetch
  mkdirSync(join(root, 'scrum'), { recursive: true })
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'requirement', label: '需求澄清', prompt: '产出写进 worktree 的 docs/REQUIREMENTS.md', gate: true, artifact: 'docs/REQUIREMENTS.md', next: 'researcher' },
      { role: 'researcher', label: '方案搜索', prompt: '基于已澄清需求产出 docs/RESEARCH.md', next: null },
    ],
  }))
  const docGoal = { ...GOAL, id: 'G-9', docsDir: 'docs/G-9', objective: '目标丁：目标化文档', context: '', contextVersion: 0 }
  // gate 文档已存在（worker 已完成并合入主分支后的主仓库态）
  mkdirSync(join(root, 'docs', 'G-9'), { recursive: true })
  writeFileSync(join(root, 'docs', 'G-9', 'REQUIREMENTS.md'), '# 需求\n')
  const task = { ...TD, id: 'T-300', role: 'requirement', title: '【需求澄清】目标化文档', status: 'todo', soldier: null, claimedAt: null, blockedBy: [], goalId: 'G-9' }
  const requests = []
  const comments = []
  const captured = []
  const base = hubBase({ board: () => [task], goals: [docGoal] })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push('claim')
      task.status = 'in_progress'
      task.soldier = 'requirement'
      return response({ task })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); comments.push(String(body.text ?? '')); return response({ task }) }
    if (url.pathname === '/api/progress') return response({ task })
    if (url.pathname === '/api/patch') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      task.status = body.to
      return response({ task })
    }
    if (url.pathname === '/api/advance') { requests.push(`advance:${body.by}`); return response({ task }) }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  const harness = capturePromptHarness(captured)
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => captured.length > 0, 'worker never dispatched')
    const prompt = captured[0]
    assert.ok(prompt.includes('本目标分析文档目录：docs/G-9/'), 'prompt 应注入目标文档目录行')
    assert.ok(prompt.includes('docs/G-9/REQUIREMENTS.md'), 'stage prompt 的产物路径应改写为目标目录')
    assert.ok(!prompt.includes('worktree 的 docs/REQUIREMENTS.md'), '遗留根槽位路径不应残留在提示词中')
    await waitFor(() => requests.some(r => r.startsWith('transition:in_review')), 'requirement gate 应停在 in_review')
    const okComment = comments.find(c => c.includes('方案文档 docs/G-9/REQUIREMENTS.md 已合入主分支'))
    assert.ok(okComment, `gate 完成评论应指向目标目录文档：${comments.join(' | ')}`)
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await cleanup(root)
  }
})

test('遗留回退：无 docsDir 目标 → gate 文档按根 docs/REQUIREMENTS.md 校验，提示词保持原样', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-gate-'))
  const originalFetch = globalThis.fetch
  mkdirSync(join(root, 'scrum'), { recursive: true })
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'requirement', label: '需求澄清', prompt: '产出写进 worktree 的 docs/REQUIREMENTS.md', gate: true, artifact: 'docs/REQUIREMENTS.md', next: 'researcher' },
      { role: 'researcher', label: '方案搜索', prompt: '基于已澄清需求产出 docs/RESEARCH.md', next: null },
    ],
  }))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# 需求\n')
  const task = { ...TD, id: 'T-310', role: 'requirement', title: '【需求澄清】遗留链', status: 'todo', soldier: null, claimedAt: null, blockedBy: [], goalId: null }
  const requests = []
  const comments = []
  const captured = []
  const base = hubBase({ board: () => [task], goals: [] })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') { requests.push('claim'); task.status = 'in_progress'; task.soldier = 'requirement'; return response({ task }) }
    if (url.pathname === '/api/comment') { requests.push('comment'); comments.push(String(body.text ?? '')); return response({ task }) }
    if (url.pathname === '/api/progress') return response({ task })
    if (url.pathname === '/api/patch') return response({ task })
    if (url.pathname === '/api/transition') { requests.push(`transition:${body.to}:${body.by}`); task.status = body.to; return response({ task }) }
    if (url.pathname === '/api/advance') { requests.push(`advance:${body.by}`); return response({ task }) }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  const harness = capturePromptHarness(captured)
  try {
    apply(harness.ctx, config(root, { rolesFile: join(root, 'roles.json') }))
    harness.intervals[0]()
    await waitFor(() => captured.length > 0, 'worker never dispatched')
    assert.ok(captured[0].includes('worktree 的 docs/REQUIREMENTS.md'), '遗留（无 docsDir）提示词应保持原根槽位路径')
    assert.ok(!captured[0].includes('本目标分析文档目录：'), '遗留目标不应注入目标文档目录行')
    await waitFor(() => requests.some(r => r.startsWith('transition:in_review')), 'requirement gate 应停在 in_review')
    const okComment = comments.find(c => c.includes('方案文档 docs/REQUIREMENTS.md 已合入主分支'))
    assert.ok(okComment, `遗留 gate 完成评论应指向根 docs/REQUIREMENTS.md：${comments.join(' | ')}`)
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await cleanup(root)
  }
})

test('B 闸门：切片改动越出声明文件域 → 拦截合入，任务停 in_review 且分支保留', async () => {
  const task = {
    ...TD, id: 'T-200', role: 'coder', title: '【切片 S1 编码】登录', status: 'todo', soldier: null,
    claimedAt: null, slice: 'T-001:S1', sliceIdx: 1, blockedBy: [], fileDomain: ['src/'],
  }
  const { root, repo } = setupIsolatedRepo(task, ['src/auth.ts', 'docs/outside.md'])
  const originalFetch = globalThis.fetch
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'coder', label: '编码实现', prompt: 'code', next: 'tester' },
      { role: 'tester', label: '测试执行', prompt: 'test', next: null },
    ],
  }))
  const requests = []
  const comments = []
  const base = hubBase({ board: () => [task], goals: [] })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push('claim')
      task.status = 'in_progress'
      task.soldier = 'coder'
      return response({ task })
    }
    if (url.pathname === '/api/comment') {
      requests.push('comment')
      comments.push(String(body.text ?? ''))
      return response({ task })
    }
    if (url.pathname === '/api/progress') return response({ task })
    if (url.pathname === '/api/patch') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      task.status = body.to
      return response({ task })
    }
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.by}`)
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeHarnessBase()
  harness.ctx.subagents = {
    start: async () => ({
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { status: 'done', summary: '完成', evidence: 'evidence: ok', blocker: '', artifact: null },
      }),
      dispose: async () => {},
    }),
  }
  try {
    apply(harness.ctx, config(root, {
      isolate: true, repoRoot: repo, worktreeRoot: join(root, 'wt'),
      rolesFile: join(root, 'roles.json'), scrumDir: join(root, 'scrum'),
    }))
    harness.intervals[0]()
    await waitFor(() => requests.some(r => r.startsWith('transition:in_review')), '越界任务未停 in_review')
    assert.ok(!requests.some(r => r.startsWith('advance:')), `unexpected: 越界任务不得自动 done（requests=${requests.join(',')}）`)
    const blockComment = comments.find(c => c.includes('文件域越界'))
    assert.ok(blockComment, '应有越域拦截评论')
    assert.ok(blockComment.includes('docs/outside.md'), `评论应列明越域文件：${blockComment}`)
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/w/T-200']).code, 0, '分支 w/T-200 应保留（改动不丢）')
  } finally {
    // 反向断言放这里：advance 不应出现（上面 try 内 waitFor 已含 transition，advance 若出现会在 waitFor 后立刻被捕获）
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await cleanup(root)
  }
})

test('切片展开读取目标目录的 TASK_BREAKDOWN.md（docs/<goalId>/），跨目标不互踩', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slice-goal-docs-'))
  const originalFetch = globalThis.fetch
  mkdirSync(join(root, 'scrum'), { recursive: true })
  // 拆解文档放在该目标自己的目录（模拟 breaker 阶段按目标目录产出并已 promote 到主分支）
  mkdirSync(join(root, 'docs', 'G-9'), { recursive: true })
  writeFileSync(join(root, 'docs', 'G-9', 'TASK_BREAKDOWN.md'), [
    '# 拆解说明',
    '## slices',
    '- S1 | 登录接口 | src/auth.ts | 注册成功返回 201',
    '',
  ].join('\n'))
  const docGoal = { ...GOAL, id: 'G-9', docsDir: 'docs/G-9', objective: '切片目标：目标化文档', context: '', contextVersion: 0 }
  const tdDone = {
    ...TD, id: 'T-400', role: 'test-designer', title: '【测试用例设计】切片', status: 'done', soldier: 'test-designer',
    claimedAt: '2026-09-02T00:00:00.000Z', goalId: 'G-9',
    description: '[auto-goal]\n[slice-mode]\n目标：切片目标\n本阶段：测试用例设计',
  }
  const requests = []
  let posted
  const base = hubBase({ board: () => [tdDone], goals: [docGoal] })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/comment') { requests.push('comment'); return response({ task: tdDone }) }
    if (url.pathname === '/api/goal/slices') {
      posted = body
      return response({ task: { created: ['T-500', 'T-501', 'T-502'] } })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  const harness = fakeHarnessBase()
  try {
    apply(harness.ctx, config(root, { scope: 'software' }))
    harness.intervals[0]()
    await waitFor(() => posted !== undefined, 'beam was never registered')
    assert.equal(posted.testDesignerTaskId, 'T-400')
    assert.equal(posted.slices.length, 1)
    assert.deepEqual(posted.slices[0].files, ['src/auth.ts'])
    assert.ok(requests.includes('comment'), 'registration confirmation comment missing')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await cleanup(root)
  }
})

test('B 闸门正例：改动全部在声明文件域内 → 照常自动合入并推进 done', async () => {
  const task = {
    ...TD, id: 'T-200', role: 'coder', title: '【切片 S1 编码】登录', status: 'todo', soldier: null,
    claimedAt: null, slice: 'T-001:S1', sliceIdx: 1, blockedBy: [], fileDomain: ['src/'],
  }
  const { root, repo } = setupIsolatedRepo(task, ['src/auth.ts'])
  const originalFetch = globalThis.fetch
  writeFileSync(join(root, 'roles.json'), JSON.stringify({
    name: 'software',
    stages: [
      { role: 'coder', label: '编码实现', prompt: 'code', next: 'tester' },
      { role: 'tester', label: '测试执行', prompt: 'test', next: null },
    ],
  }))
  const requests = []
  const comments = []
  const base = hubBase({ board: () => [task], goals: [] })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const handled = await base(input, init)
    if (handled !== undefined) return handled
    if (url.pathname === '/api/claim') {
      requests.push('claim')
      task.status = 'in_progress'
      task.soldier = 'coder'
      return response({ task })
    }
    if (url.pathname === '/api/comment') { requests.push('comment'); comments.push(String(body.text ?? '')); return response({ task }) }
    if (url.pathname === '/api/progress') return response({ task })
    if (url.pathname === '/api/patch') return response({ task })
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}:${body.by}`)
      task.status = body.to
      return response({ task })
    }
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.by}`)
      task.status = 'done'
      return response({ task })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }

  const harness = fakeHarnessBase()
  harness.ctx.subagents = {
    start: async () => ({
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { status: 'done', summary: '完成', evidence: 'evidence: ok', blocker: '', artifact: null },
      }),
      dispose: async () => {},
    }),
  }
  try {
    apply(harness.ctx, config(root, {
      isolate: true, repoRoot: repo, worktreeRoot: join(root, 'wt'),
      rolesFile: join(root, 'roles.json'), scrumDir: join(root, 'scrum'),
    }))
    harness.intervals[0]()
    await waitFor(() => requests.some(r => r.startsWith('advance:')), '域内改动应自动合入并推进 done')
    assert.ok(!comments.some(c => c.includes('文件域越界')), '域内改动不应触发越域拦截')
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/w/T-200']).code !== 0, true, '合入成功后分支 w/T-200 应被清理')
  } finally {
    for (const dispose of harness.disposers) await dispose()
    globalThis.fetch = originalFetch
    await cleanup(root)
  }
})

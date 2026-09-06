import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** 全八岗流水线 roles 夹具（与生产 roles.json 同语义；docs 契约驱动 S2 结算登记）。 */
const ROLES = {
  name: 'software',
  stages: [
    { role: 'requirement', label: '需求澄清', prompt: '产出写进 docs/REQUIREMENTS.md', next: 'researcher', docs: ['docs/REQUIREMENTS.md'] },
    { role: 'researcher', label: '方案搜索', prompt: '产出写进 docs/RESEARCH.md', next: 'breaker', gate: true, artifact: 'docs/RESEARCH.md', docs: ['docs/RESEARCH.md'] },
    { role: 'breaker', label: '任务拆解', prompt: 'docs/TASK_BREAKDOWN.md', next: 'test-designer', docs: ['docs/TASK_BREAKDOWN.md'] },
    { role: 'test-designer', label: '测试用例设计', prompt: 'docs/TEST_CASES.md', next: 'coder', docs: ['docs/TEST_CASES.md'] },
    { role: 'coder', label: '编码实现', prompt: 'code', next: 'reviewer' },
    { role: 'reviewer', label: '代码审查', prompt: 'docs/review/<任务ID>-REVIEW.md', next: 'tester', docs: ['docs/review/{taskId}-REVIEW.md'] },
    { role: 'tester', label: '测试执行', prompt: 'docs/TEST_REPORT.md', next: 'devops', docs: ['docs/TEST_REPORT.md'] },
    { role: 'devops', label: '部署与 CI/CD', prompt: 'docs/DEPLOY.md', next: null, docs: ['docs/DEPLOY.md'] },
  ],
}

function config(root, overrides = {}) {
  return {
    role: 'soldier-auto', intervalMs: 30_000, maxWorkers: 1, workerTimeoutMs: 60_000,
    staleMinutes: 30, taskTtlMinutes: 0, provider: 'spawn', scrumDir: join(root, 'scrum'),
    workspace: root, isolate: false, repoRoot: root, worktreeRoot: '', denyTools: [],
    rolesFile: join(root, 'roles.json'), logFile: join(root, 'worker.log'),
    hubUrl: 'http://hub.test', hubToken: '', scope: 'default', agentPreset: 'code',
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
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function cleanupDir(root) {
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
        create: async () => ({ agent: { session: { id: 'foreman-test' } }, dispose: async () => {} }),
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

function baseTask(role, overrides = {}) {
  return {
    id: 'T-001', title: '目标', description: '', acceptance: [], priority: 'medium',
    status: 'todo', version: 1, soldier: null, claimedAt: null, parent: null, role,
    scope: 'default', hold: false, blockedBy: [], comments: [], slice: null, sliceIdx: null,
    fixOf: null, fixCount: 0, testReport: null, ...overrides,
  }
}

/**
 * hub 打桩状态机：写路径更新 holder.task（S2 需多轮/回放，故持对象引用而不是闭包副本）。
 * /api/artifact 语义与 server.mjs 契约一致：把 {kind,path,title,by,digest} 追加进 artifacts。
 */
function hubMachine(holder, requests, extra = {}) {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body ?? '{}'))
    const task = holder.task
    if (url.pathname === '/api/skills') return response([])
    if (url.pathname === '/api/spaces') return response({ spaces: [] })
    if (url.pathname === '/api/release-stale') return response({ released: [] })
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
      requests.push(`artifact:${body.path}:${body.kind}:${body.digest ?? ''}`)
      const entry = { by: body.by, at: '2026-09-01T00:00:02.000Z', kind: body.kind, path: body.path, title: body.title ?? '' }
      if (body.digest) entry.digest = body.digest
      holder.task = { ...task, artifacts: [...(task.artifacts ?? []), entry], version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/transition') {
      requests.push(`transition:${body.to}`)
      holder.task = { ...task, status: body.to, version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/advance') {
      requests.push(`advance:${body.by}`)
      holder.task = { ...task, status: 'done', version: task.version + 1 }
      return response({ task: holder.task })
    }
    if (url.pathname === '/api/create') {
      requests.push('create')
      return response({ task: { id: 'T-002', ...body } })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }
}

/** 跑一次扫单（apply 后调用 interval）。 */
function sweep(harness) {
  harness.intervals[0]()
}

test('requirement 岗 done：结算自动登记 docs/REQUIREMENTS.md（kind=file、仓库相对路径、by=守护、带 digest），worker 未填 artifact 亦登记（AC-R1-2）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-req-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# 需求\n- 支持预览\n')
  const holder = { task: baseTask('requirement') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '需求已澄清', evidence: '见文档', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    sweep(harness)
    await waitFor(() => requests.some(r => r.startsWith('artifact:')), 'requirement 契约产物未登记')
    const reg = requests.find(r => r.startsWith('artifact:'))
    assert.match(reg, /^artifact:docs\/REQUIREMENTS\.md:file:[0-9a-f]{64}$/, `登记应相对路径 file + digest：${reg}`)
    assert.ok(requests.includes('advance:requirement'), '登记后应照常流转')
    // 完成评论应含产出文档清单（R-11 不刷屏：清单只在有登记/缺失时出现一次）
    const comments = holder.task.comments.filter(c => c.by === 'soldier-auto')
    const finalComment = comments[comments.length - 1]
    assert.match(finalComment.text, /产出文档清单/, '完成评论应给产出文档清单')
    assert.match(finalComment.text, /docs\/REQUIREMENTS\.md/, '清单应含登记路径')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})

test('reviewer 岗 done：{taskId} 解析为 docs/review/T-0xx-REVIEW.md 实际登记（AC-R1-3）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-review-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  mkdirSync(join(root, 'docs', 'review'), { recursive: true })
  writeFileSync(join(root, 'docs', 'review', 'T-001-REVIEW.md'), '# review\nok\n')
  const holder = { task: baseTask('reviewer') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '审查通过', evidence: '见文档', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    sweep(harness)
    await waitFor(() => requests.some(r => r.startsWith('artifact:docs/review/')), 'reviewer 契约产物未登记')
    const reg = requests.find(r => r.startsWith('artifact:docs/review/'))
    assert.match(reg, /^artifact:docs\/review\/T-001-REVIEW\.md:file:[0-9a-f]{64}$/, `应登记动态命名路径：${reg}`)
    assert.ok(requests.includes('advance:reviewer'), 'reviewer 应照常流转')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})

test('契约文档缺失 → 任务停 in_review、评论含期望路径与已登记清单提示、不流转（AC-R1-4）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-missing-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  // 不创建 docs/REQUIREMENTS.md → 契约文档缺失
  const holder = { task: baseTask('requirement') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '需求已澄清', evidence: '', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    sweep(harness)
    await waitFor(() => requests.includes('transition:in_review'), '缺失文档应停在 in_review')
    assert.ok(!requests.some(r => r.startsWith('artifact:')), '缺失时不得登记')
    assert.ok(!requests.some(r => r.startsWith('advance:')), '缺失时不得流转')
    const warn = holder.task.comments.map(c => c.text).find(t => t.includes('契约产出文档缺失'))
    assert.ok(warn, '应有缺失契约提示评论')
    assert.match(warn, /docs\/REQUIREMENTS\.md/, '提示应含期望路径')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})

test('gate 岗 researcher 既有行为不回归：文档存在时登记后仍走 in_review 人工验收（AC-R1-5）；缺失走缺失提示', async () => {
  // 存在：登记 + in_review + 验收评论含方案文档与产出文档清单
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-gate-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'RESEARCH.md'), '# 方案\n- 选 A\n')
  const holder = { task: baseTask('researcher') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '方案已选型', evidence: '见文档', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    sweep(harness)
    await waitFor(() => requests.includes('transition:in_review'), 'gate 应停在 in_review 人工验收')
    const reg = requests.find(r => r.startsWith('artifact:docs/RESEARCH.md'))
    assert.ok(reg, '方案文档应被登记')
    const last = holder.task.comments.map(c => c.text).find(t => t.includes('请将军人工验收'))
    assert.ok(last, '应有人工验收评论')
    assert.match(last, /docs\/RESEARCH\.md/, '验收评论应指向方案文档')
    assert.match(last, /产出文档清单/, '验收评论应含产出文档清单')
    assert.ok(!requests.includes('advance:researcher'), 'gate 不自动 done')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})

test('文档补全后重跑登记成功、提示消除并照常流转（G-R2 软门禁缺才停）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-retry-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  mkdirSync(join(root, 'docs'), { recursive: true })
  const holder = { task: baseTask('requirement') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '需求已澄清', evidence: '', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    // 第 1 轮：无文档 → 停 in_review + 缺失提示
    sweep(harness)
    await waitFor(() => requests.includes('transition:in_review'), '第 1 轮应停在 in_review')
    assert.ok(holder.task.comments.some(c => c.text.includes('契约产出文档缺失')), '第 1 轮应有缺失提示')
    const baseCount = holder.task.comments.length
    // 补全文档，任务回到 todo（打回/解阻语义）→ 第 2 轮
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# 补全后的需求\n')
    holder.task = { ...holder.task, status: 'todo', soldier: null, claimedAt: null, comments: holder.task.comments, version: holder.task.version + 1 }
    sweep(harness)
    await waitFor(() => requests.some(r => r.startsWith('artifact:docs/REQUIREMENTS.md')), '第 2 轮应登记成功')
    const round2Comments = holder.task.comments.slice(baseCount).map(c => c.text)
    assert.ok(!round2Comments.some(t => t.includes('契约产出文档缺失')), '第 2 轮新评论不应有缺失提示')
    assert.ok(requests.includes('advance:requirement'), '第 2 轮应照常流转')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})

test('非文档型岗位 coder 不产生契约登记；worker 自填 artifact 既有登记路径不回退', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-coder-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'x.html'), '<p>hi</p>')
  const holder = { task: baseTask('coder') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '实现完成', evidence: 'ok', blocker: '', artifact: { kind: 'html', path: 'out/x.html', title: '实现预览' } })
  try {
    apply(harness.ctx, config(root))
    sweep(harness)
    await waitFor(() => requests.some(r => r.startsWith('artifact:') && r.includes('x.html') && r.includes(':html:')), 'worker 自填 artifact 应登记')
    const regs = requests.filter(r => r.startsWith('artifact:'))
    assert.equal(regs.length, 1, 'coder 不应产生额外契约登记（无 docs 契约）')
    assert.ok(regs[0].includes(':html:') && regs[0].includes('x.html'), 'coder 只登记既有 worker 自填产物')
    assert.ok(!regs[0].includes('docs'), 'coder 不应出现契约路径登记')
    const doneComments = holder.task.comments.map(c => c.text).filter(t => t.includes('✓'))
    assert.ok(doneComments.every(t => !t.includes('产出文档清单')), 'coder 完成评论不应带契约清单（不刷屏）')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})

test('多轮同 path 字节未变不重复登记（幂等）；变化则追加新条目（AC-R2-3 多轮倒序数据源）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scrum-reg-idem-'))
  const originalFetch = globalThis.fetch
  const restoreTasks = protectTasksFile(root)
  writeFileSync(join(root, 'roles.json'), JSON.stringify(ROLES))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# v1\n')
  const holder = { task: baseTask('requirement') }
  const requests = []
  globalThis.fetch = hubMachine(holder, requests)
  const harness = fakeContext({ status: 'done', summary: '需求澄清', evidence: '', blocker: '' })
  try {
    apply(harness.ctx, config(root))
    const expectedTotals = [1, 1, 2] // 第 1 轮登记 1 条；第 2 轮同字节幂等跳过仍 1 条；第 3 轮字节变化追加为 2 条
    for (let round = 1; round <= 3; round += 1) {
      if (round === 3) writeFileSync(join(root, 'docs', 'REQUIREMENTS.md'), '# v2 变更\n')
      holder.task = { ...holder.task, status: 'todo', soldier: null, claimedAt: null, version: holder.task.version + 1 }
      sweep(harness)
      const want = expectedTotals[round - 1]
      await waitFor(
        () => requests.filter(r => r.startsWith('artifact:docs/REQUIREMENTS.md')).length === want,
        `第 ${round} 轮登记总数应为 ${want}`,
      )
    }
    const regs = requests.filter(r => r.startsWith('artifact:docs/REQUIREMENTS.md'))
    assert.equal(regs.length, 2, '两次字节变化才两条登记（v1/v2）')
    assert.notEqual(regs[0].split(':')[3], regs[1].split(':')[3], '两条登记的 digest 应不同')
    assert.equal(holder.task.artifacts.length, 2, '任务记录 artifacts 应为 2 条（多轮追加）')
    const times = holder.task.artifacts.map(a => a.at)
    assert.ok(new Date(times[1]) >= new Date(times[0]), '按轮次先后追加（前端倒序展示最新在前）')
  } finally {
    for (const d of harness.disposers) await d()
    globalThis.fetch = originalFetch
    restoreTasks()
    await cleanupDir(root)
  }
})
// PRT-315 切片 7：切片流水线编排（`plugins/src/sliceOrchestration.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// `orchestrateSlices(tasks)` 此前是 `spaceWorker()` 闭包里一个 68 行的内联函数，只从
// `sweep()` 的 `// 5.` 调用点进入，且要求**整个守护跑起来**、hub 可达、board 上恰好摆着
// 那几条任务。于是此前它只有端到端路径被顺带覆盖，而下面这些**只有边界输入**才会走到的分支，
// 一条用例都没有：
//
//   · 「切片束已注册」的**两条**识别各自单独成立时（`:S` 前缀命中 / devops 尾 slice 命中）；
//   · 解析出的清单为**空**（文件不在 / 段头缺失 / 清单为空）时，除了退避还会 `return`——
//     于是**整段 ② 重测重开本轮不跑**；
//   · `TASK_BREAKDOWN.md` **读得动但读炸**（路径指向目录、权限、编码）时被吞掉的那条 catch；
//   · ②里三处 `continue` 各自拦住谁（预算用尽评论 / fix 数超预算 / fix 未全 done），
//     以及 `canceled` 的 fix **不算**进计数；
//   · 重测换基线时 `worktree remove` **失败**那条只记日志的分支，与 stale 目录**不存在**
//     时"只删分支"那条；
//   · `SLICE_ANALYSIS_TAIL` 角色但**不带** `[slice-mode]` 标记的目标任务；
//   · 非本 scope / `hold` / `canceled` 三种"不算切片任务"。
//
//   > 一个"只有把整个守护跑起来、并且恰好撞上边界输入"才能验证的分支，
//   > 与一个"根本没有这条分支"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// 拆出来之后，这个文件用**替身注入**驱动全部分支，不需要 hub、不需要 git；只有两处必须碰真
// 文件系统的地方（`TASK_BREAKDOWN.md` 的读取、stale worktree 目录的存在性）用
// `mkdtempSync(os.tmpdir())` 建**临时**目录——**不读不写**操作员的任何真实目录。
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬过来的 68 行 + `parseSlices` 的 21 行与 pristine `index.ts` 里那两段逐字相同」由
// `_prt-handoff/prt315g-compare.mjs` 验证（按锚点抽旧块、施加 4 处已声明的注入改写后逐行对拍）。
// 本文件只管**行为**。
//
// ## 诚实边界（写在这里，免得被读成"端到端也验过了"）
//
// `hubPost` / `safeComment` / `transitionTo` / `runGit` 都是**替身**：本文件证明的是
// "以哪一份 body / 哪一组 argv 调了谁、调用几次、顺序如何"，**不**证明真实 team-hub
// `/api/goal/slices`、真实 `/api/transition` 与真实 git 的行为。日志与 `activity(...)` 的
// **文案**是逐字断言的（它们是对外可观测的那一半）。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSliceOrchestration, parseSlices } from '../lib/sliceOrchestration.js'

// ── 任务替身 ─────────────────────────────────────────────────────────────────

const SLICE_GOAL_DESC = '[auto-goal]\n[slice-mode]\n目标：做一个切片目标\n本阶段：测试用例设计'

/** 造一个任务；默认：一个 `[slice-mode]` 的 test-designer done 任务（"干净"输入）。 */
function task(over = {}) {
  return {
    id: 'T-001',
    title: '【测试用例设计】目标',
    description: SLICE_GOAL_DESC,
    acceptance: [],
    priority: 'high',
    status: 'done',
    version: 3,
    soldier: 'test-designer',
    claimedAt: '2026-09-02T00:00:00.000Z',
    parent: null,
    role: 'test-designer',
    scope: 'app',
    hold: false,
    blockedBy: [],
    comments: [],
    slice: null,
    sliceIdx: null,
    fixOf: null,
    fixCount: 0,
    testReport: null,
    ...over,
  }
}

/** 切片束里的一个 coder 任务（`slice` 键 = `${tdId}:S${n}`）。 */
const beamCoder = (over = {}) => task({
  id: 'T-100', role: 'coder', title: '【切片 S1 编码】', status: 'done',
  soldier: 'coder', slice: 'T-001:S1', sliceIdx: 1, ...over,
})

/** 停在 in_review 的切片 tester。 */
const parkedTester = (over = {}) => task({
  id: 'T-200', role: 'tester', title: '【切片 S1 测试】', status: 'in_review',
  soldier: 'tester', slice: 'T-001:S1', sliceIdx: 1, blockedBy: ['T-100'], ...over,
})

/** 已合入的 fix 回炉任务。 */
const mergedFix = (over = {}) => task({
  id: 'T-300', role: 'coder', title: '【切片 S1 修复】', status: 'done',
  soldier: 'coder', slice: 'T-001:S1', sliceIdx: 1, fixOf: 'T-200', blockedBy: [], ...over,
})

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 组装一个被测编排模块。
 *
 * ★ 这里**没有**可变绑定（本切片不读 `useHub` / `pipeline` / `stageByRole`），所以没有
 * `() => x` 取值函数——但"接口是活的、不是构造时快照"这件事仍然要钉：`config` 是**对象身份**
 * 注入的，用例改 `h.deps.config.maxFixPerSlice` 必须立刻生效（见对应两条用例）。
 * `repoRootFor` / `worktreeRootFor` 读 `state`，所以用例可以在两次调用之间把仓库根换掉。
 */
function harness(over = {}) {
  const calls = []
  const state = {
    repoRoot: over.repoRoot ?? 'D:/repo',
    worktreeRoot: over.worktreeRoot ?? 'D:/wt',
  }
  const deps = {
    config: {
      role: over.role ?? 'guard',
      intervalMs: over.intervalMs ?? 30_000,
      maxFixPerSlice: over.maxFixPerSlice ?? 2,
      isolate: over.isolate ?? false,
    },
    log: m => { calls.push(['log', m]) },
    scope: over.scope ?? 'app',
    activity: (kind, taskId, text) => { calls.push(['activity', kind, taskId, text]) },
    isSliceBeam: t => t.slice != null && t.role != null && (t.role === 'coder' || t.role === 'tester' || t.role === 'devops'),
    SLICE_ANALYSIS_TAIL: 'test-designer',
    isSliceGoalTask: t => (t.description ?? '').includes('[slice-mode]'),
    expandRetryAt: over.expandRetryAt ?? new Map(),
    goalCtxById: over.goalCtxById ?? { get: () => undefined },
    goalDocPath: over.goalDocPath ?? ((goal, legacy) => {
      if (!legacy) return ''
      const base = String(legacy).split('/').pop() || String(legacy)
      return goal?.docsDir ? `${goal.docsDir}/${base}` : legacy
    }),
    repoRootFor: () => state.repoRoot,
    worktreeRootFor: () => state.worktreeRoot,
    hubPost: async (path, body) => {
      calls.push(['hubPost', path, body])
      if (over.hubThrows) throw new Error('hub 挂了')
      return over.hubResult === undefined ? { created: ['T-2', 'T-3'] } : over.hubResult
    },
    safeComment: async (id, text) => { calls.push(['safeComment', id, text]) },
    transitionTo: async (id, to) => { calls.push(['transitionTo', id, to]) },
    runGit: async (root, args) => {
      calls.push(['runGit', root, args])
      return over.gitResult === undefined ? { code: 0, out: '', err: '' } : over.gitResult
    },
  }
  const orch = createSliceOrchestration(deps)
  return { orch, deps, calls, state, over }
}

/** 只取"副作用"调用（log 单独断言，避免顺序噪音）。 */
const effects = h => h.calls.filter(c => c[0] !== 'log')
const logs = h => h.calls.filter(c => c[0] === 'log').map(c => c[1])
const hubCalls = h => h.calls.filter(c => c[0] === 'hubPost')

// ── 临时目录（只在测试自己的 tmp 下） ────────────────────────────────────────

function tmpRoot(tag) {
  return mkdtempSync(join(tmpdir(), `prt315g-${tag}-`))
}
function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

const BREAKDOWN = [
  '# 拆解说明',
  '',
  '## slices',
  '- S1 | 登录接口 | src/auth.ts, src/auth.test.ts | 注册成功返回 201; 密码错误返回 401',
  '- S2 | 用户资料页 | src/profile.tsx | 加载成功渲染用户信息',
  '',
].join('\n')

const EXPECTED_SLICES = [
  { title: '登录接口', files: ['src/auth.ts', 'src/auth.test.ts'], acceptance: ['注册成功返回 201', '密码错误返回 401'] },
  { title: '用户资料页', files: ['src/profile.tsx'], acceptance: ['加载成功渲染用户信息'] },
]

/** 在临时仓库根下写一份 TASK_BREAKDOWN.md，返回仓库根。 */
function repoWithBreakdown(tag, content = BREAKDOWN, rel = 'docs/TASK_BREAKDOWN.md') {
  const root = tmpRoot(tag)
  const p = join(root, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content, 'utf8')
  return root
}

// ── 静态契约 ─────────────────────────────────────────────────────────────────

test('模块出口：工厂只交回 orchestrateSlices；parseSlices 是模块级导出纯函数', () => {
  const h = harness()
  assert.deepEqual(Object.keys(h.orch), ['orchestrateSlices'])
  assert.equal(typeof parseSlices, 'function')
  // 纯函数：同样输入同样输出，且不读任何闭包/文件
  const src = '## slices\n- S1 | 甲 | a.ts | x\n'
  assert.deepEqual(parseSlices(src), parseSlices(src))
  assert.deepEqual(parseSlices(src), [{ title: '甲', files: ['a.ts'], acceptance: ['x'] }])
})

// ── ① readyToExpand ──────────────────────────────────────────────────────────

test('没有切片任务 → 一发副作用都不发（不读文件、不 POST、不 transition、不 log）', async () => {
  const h = harness({ tasks: [] })
  await h.orch.orchestrateSlices([])
  assert.deepEqual(h.calls, [])

  // 有任务但都不是"切片任务"：既不是切片束，也不是带 [slice-mode] 的分析前缀尾
  const only = task({ id: 'T-900', role: 'coder', slice: null })
  const h2 = harness({ tasks: [only] })
  await h2.orch.orchestrateSlices([only])
  assert.deepEqual(h2.calls, [])
})

test('分析前缀尾 done 但**不带** [slice-mode] → 不注册（标记才是"这是切片目标"的判据）', async () => {
  const root = repoWithBreakdown('nomark')
  try {
    const td = task({ description: '[auto-goal]\n目标：普通目标\n本阶段：测试用例设计' })
    const h = harness({ repoRoot: root, tasks: [td] })
    await h.orch.orchestrateSlices([td])
    assert.deepEqual(h.calls, [], '没有 [slice-mode] 标记时不该有任何动作')
  } finally { cleanup(root) }
})

test('非本 scope / hold / canceled 三种都不算切片任务', async () => {
  const root = repoWithBreakdown('filters')
  try {
    const variants = [
      task({ scope: 'other' }),
      task({ hold: true }),
      task({ status: 'canceled' }),
    ]
    for (const td of variants) {
      const h = harness({ repoRoot: root, tasks: [td] })
      await h.orch.orchestrateSlices([td])
      assert.deepEqual(h.calls, [], `不该处理：${JSON.stringify({ scope: td.scope, hold: td.hold, status: td.status })}`)
    }
  } finally { cleanup(root) }
})

test('★ 分析前缀尾 done → 解析 TASK_BREAKDOWN.md → POST /api/goal/slices，body/评论/活动/日志逐字', async () => {
  const root = repoWithBreakdown('expand')
  try {
    const td = task()
    const h = harness({ repoRoot: root, tasks: [td] })
    await h.orch.orchestrateSlices([td])
    assert.deepEqual(effects(h), [
      ['hubPost', '/api/goal/slices', { testDesignerTaskId: 'T-001', slices: EXPECTED_SLICES, by: 'guard' }],
      ['safeComment', 'T-001', '📐 已注册 2 个切片（coder_Si→tester_Si 微链 + devops 目标级收尾），切片之间互不依赖，可并行派工。'],
      ['activity', 'slices', 'T-001', '切片展开：2 个任务'],
    ])
    assert.deepEqual(logs(h), ['T-001 切片束已注册：2 个任务'])
  } finally { cleanup(root) }
})

test('★ res 里没有 created → n=0（`res.created ?? []`，不是崩溃也不是漏评论）', async () => {
  const root = repoWithBreakdown('nocreated')
  try {
    const td = task()
    const h = harness({ repoRoot: root, tasks: [td], hubResult: {} })
    await h.orch.orchestrateSlices([td])
    assert.deepEqual(effects(h)[1], ['safeComment', 'T-001', '📐 已注册 0 个切片（coder_Si→tester_Si 微链 + devops 目标级收尾），切片之间互不依赖，可并行派工。'])
    assert.deepEqual(logs(h), ['T-001 切片束已注册：0 个任务'])
  } finally { cleanup(root) }
})

test('★ 幂等：切片束已注册（`:S` 前缀命中）→ 不 POST、不评论（文件在也不解析）', async () => {
  const root = repoWithBreakdown('beam-s')
  try {
    const td = task()
    const beam = beamCoder()
    const h = harness({ repoRoot: root, tasks: [td, beam] })
    await h.orch.orchestrateSlices([td, beam])
    assert.deepEqual(h.calls, [], '已有 :S 切片束时不得再注册')
  } finally { cleanup(root) }
})

test('★ 幂等：devops 尾任务的 slice **等于** td.id 也算已注册', async () => {
  const root = repoWithBreakdown('beam-tail')
  try {
    const td = task()
    const tail = task({ id: 'T-400', role: 'devops', status: 'todo', slice: 'T-001', sliceIdx: null })
    const h = harness({ repoRoot: root, tasks: [td, tail] })
    await h.orch.orchestrateSlices([td, tail])
    assert.deepEqual(h.calls, [], 'devops 尾 slice=T-001 时不得再注册')
  } finally { cleanup(root) }
})

test('★ 退避窗内不重试（连文件都不读）；窗口一过立刻重试', async () => {
  const root = repoWithBreakdown('backoff')
  try {
    const td = task()
    const retryAt = new Map([['T-001', Date.now()]])
    const h = harness({ repoRoot: root, tasks: [td], expandRetryAt: retryAt })
    await h.orch.orchestrateSlices([td])
    assert.deepEqual(h.calls, [], '退避窗内不该有任何动作（尤其不该有"无切片清单"日志）')

    // 窗口 = intervalMs * 6 = 180_000ms；刚过后必须重试
    retryAt.set('T-001', Date.now() - 180_000 - 1)
    await h.orch.orchestrateSlices([td])
    assert.equal(hubCalls(h).length, 1, '退避窗过后应重试注册')
  } finally { cleanup(root) }
})

test('★ 清单为空（文件不存在）→ 记退避 + 逐字日志，且**本轮整段 ② 不跑**（那句 return）', async () => {
  const root = tmpRoot('empty') // 注意：不写 TASK_BREAKDOWN.md
  try {
    const td = task()
    // 一条**属于另一个目标**的切片 tester（slice=T-999:S1）停在 in_review 且 fix 已合入。
    // 它的（以及它那条 fix 的）slice 键都不满足 `T-001` / `T-001:S` 前缀，所以不会让 ① 认为
    // **本目标**的切片束已注册；于是 ① 会走到"清单为空"那句 `return`，② 本轮**整段被跳过**——
    // 这正是要钉的形状。（反过来说：任何一条 slice 键属于本目标的任务——包括 fix——都会让
    // `beamExists` 为真，① 根本不会进来。）
    const tester = parkedTester({ slice: 'T-999:S1', blockedBy: ['T-998'] })
    const fix = mergedFix({ slice: 'T-999:S1' })
    const retryAt = new Map()
    const h = harness({ repoRoot: root, tasks: [td, tester, fix], expandRetryAt: retryAt })
    await h.orch.orchestrateSlices([td, tester, fix])
    const bdPath = join(root, 'docs', 'TASK_BREAKDOWN.md')
    assert.deepEqual(logs(h), [`T-001 分析前缀完成但 TASK_BREAKDOWN.md 无切片清单（${bdPath}），等待 breaker 产出（退避重试）`])
    assert.deepEqual(effects(h), [], 'return 那一下把 ② 也跳过了：不得 transition/评论')
    assert.equal(retryAt.get('T-001') !== undefined, true, '必须记下退避时间戳')

    // 对照：把整份清单写出来之后，同一批任务里 ② 立刻会跑（证明上面"没跑"是那句 return）
    const root2 = repoWithBreakdown('empty-control')
    try {
      const h2 = harness({ repoRoot: root2, tasks: [td, tester, fix] })
      await h2.orch.orchestrateSlices([td, tester, fix])
      assert.deepEqual(effects(h2).filter(c => c[0] === 'transitionTo'), [['transitionTo', 'T-200', 'todo']])
    } finally { cleanup(root2) }
  } finally { cleanup(root) }
})

test('★ 文件读得动但读炸（路径是目录）→ catch 吞掉 + 逐字日志 + 退避（不抛出）', async () => {
  const root = tmpRoot('eisdir')
  try {
    // 目录冒充 TASK_BREAKDOWN.md：existsSync 为真、readFileSync 抛 EISDIR
    mkdirSync(join(root, 'docs', 'TASK_BREAKDOWN.md'), { recursive: true })
    const td = task()
    const retryAt = new Map()
    const h = harness({ repoRoot: root, tasks: [td], expandRetryAt: retryAt })
    await h.orch.orchestrateSlices([td])
    assert.equal(logs(h).length, 2, `两条日志（读取失败 + 无清单）：${JSON.stringify(logs(h))}`)
    assert.match(logs(h)[0], /^TASK_BREAKDOWN\.md 读取失败：Error: EISDIR/)
    assert.match(logs(h)[1], /等待 breaker 产出（退避重试）$/)
    assert.equal(retryAt.get('T-001') !== undefined, true)
  } finally { cleanup(root) }
})

test('★ 注册失败（hub 抛）→ 记退避 + 逐字日志；不抛、不发 activity/评论（等下一轮）', async () => {
  const root = repoWithBreakdown('hubfail')
  try {
    const td = task()
    const retryAt = new Map()
    const h = harness({ repoRoot: root, tasks: [td], hubThrows: true, expandRetryAt: retryAt })
    await h.orch.orchestrateSlices([td]) // 不抛即通过
    assert.deepEqual(effects(h), [['hubPost', '/api/goal/slices', { testDesignerTaskId: 'T-001', slices: EXPECTED_SLICES, by: 'guard' }]])
    assert.deepEqual(logs(h), ['T-001 切片注册失败（退避重试）：Error: hub 挂了'])
    assert.equal(retryAt.get('T-001') !== undefined, true)
  } finally { cleanup(root) }
})

test('★ 目标目录解析：goalId 命中 goalCtxById.docsDir → 读 docs/<goalId>/TASK_BREAKDOWN.md', async () => {
  const root = repoWithBreakdown('goalized', BREAKDOWN, 'docs/G-7/TASK_BREAKDOWN.md')
  try {
    // 根 docs/ 下**故意**放一份不同的清单：读错了就会注册错的切片
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'TASK_BREAKDOWN.md'), '## slices\n- S1 | 错的 | wrong.ts | 不该被读到\n', 'utf8')
    const td = task({ goalId: 'G-7' })
    const h = harness({
      repoRoot: root, tasks: [td],
      goalCtxById: { get: id => (id === 'G-7' ? { docsDir: 'docs/G-7' } : undefined) },
    })
    await h.orch.orchestrateSlices([td])
    assert.deepEqual(hubCalls(h)[0][2].slices, EXPECTED_SLICES)
  } finally { cleanup(root) }
})

test('★ 仓库根是**每次取值**：构造后才换 repoRoot 也立刻生效（不是构造时快照）', async () => {
  const empty = tmpRoot('root-old')       // 没有清单
  const withBd = repoWithBreakdown('root-new')
  try {
    const td = task()
    const h = harness({ repoRoot: empty, tasks: [td] })
    h.state.repoRoot = withBd              // 构造之后才换（模拟 workspace 绑定刷新）
    await h.orch.orchestrateSlices([td])
    assert.equal(hubCalls(h).length, 1, '换过仓库根之后应读到新目录下的清单')
    assert.deepEqual(hubCalls(h)[0][2].slices, EXPECTED_SLICES)
  } finally { cleanup(empty); cleanup(withBd) }
})

// ── ② readyToRetest ─────────────────────────────────────────────────────────

test('★ fix 全 done → 重开 tester：transitionTo/safeComment/activity/log 逐字且顺序固定', async () => {
  const tester = parkedTester()
  const fix = mergedFix()
  const h = harness({ tasks: [tester, fix] })
  await h.orch.orchestrateSlices([tester, fix])
  assert.deepEqual(effects(h), [
    ['transitionTo', 'T-200', 'todo'],
    ['safeComment', 'T-200', '🔄 修复已完成（第 1 轮），自动重开本切片重测（机器闸门：通过后自动 done）。'],
    ['activity', 'retest', 'T-200', '修复完成，重开重测（第 1 轮）'],
  ])
  assert.deepEqual(logs(h), ['T-200 → todo（fix 完成，第 1 轮重测）'])
})

test('★ 已升级将军（评论含「预算已用尽」）→ 绝不自动重开（否则 fix 全 done 后每轮重测，死循环）', async () => {
  const tester = parkedTester({
    comments: [{ by: 'soldier-auto', at: '2026-09-02T00:00:01.000Z', text: '❓ 修复预算已用尽（maxFixPerSlice=2，已回炉 2 轮仍未通过）...' }],
  })
  const fix = mergedFix()
  const h = harness({ tasks: [tester, fix] })
  await h.orch.orchestrateSlices([tester, fix])
  assert.deepEqual(h.calls, [], '预算用尽的 tester 不得被重开，也不该有任何日志')

  // 对照：同一条 tester 摘掉那条评论 → 照常重开（证明拦住它的就是「预算已用尽」这一条）
  const plain = parkedTester()
  const h2 = harness({ tasks: [plain, fix] })
  await h2.orch.orchestrateSlices([plain, fix])
  assert.deepEqual(effects(h2)[0], ['transitionTo', 'T-200', 'todo'])
})

test('fix 数超预算 / 没有 fix / fix 未全 done / fix 被 canceled → 四种都不重开', async () => {
  const cases = {
    '超预算（maxFixPerSlice=1，2 个 fix）': { maxFixPerSlice: 1, fixes: [mergedFix(), mergedFix({ id: 'T-301' })] },
    '没有 fix': { fixes: [] },
    'fix 未全 done': { fixes: [mergedFix(), mergedFix({ id: 'T-301', status: 'in_progress' })] },
    'fix 全 canceled': { fixes: [mergedFix({ status: 'canceled' })] },
  }
  for (const [label, c] of Object.entries(cases)) {
    const tester = parkedTester()
    const tasks = [tester, ...c.fixes]
    const h = harness({ tasks, maxFixPerSlice: c.maxFixPerSlice ?? 2 })
    await h.orch.orchestrateSlices(tasks)
    assert.deepEqual(h.calls, [], `${label} 时不该重开`)
  }
})

test('★ 半 canceled：一个 canceled + 一个 done → canceled 不计入，仍按 done 重开（第 1 轮）', async () => {
  const tester = parkedTester()
  const tasks = [tester, mergedFix({ status: 'canceled' }), mergedFix({ id: 'T-301', status: 'done' })]
  const h = harness({ tasks })
  await h.orch.orchestrateSlices(tasks)
  assert.deepEqual(effects(h)[0], ['transitionTo', 'T-200', 'todo'])
  assert.deepEqual(logs(h), ['T-200 → todo（fix 完成，第 1 轮重测）'])
})

test('② 只认「tester + in_review + slice 含 :S」：其它状态的 tester 一律不动', async () => {
  const variants = [
    parkedTester({ status: 'todo' }),
    parkedTester({ status: 'done' }),
    parkedTester({ status: 'in_review', slice: null }),
    parkedTester({ status: 'in_review', slice: 'T-001' }), // devops 尾形态的键，tester 上不该出现
    parkedTester({ status: 'in_review', hold: true }),
    parkedTester({ status: 'in_review', scope: 'other' }),
  ]
  for (const tester of variants) {
    const tasks = [tester, mergedFix()]
    const h = harness({ tasks })
    await h.orch.orchestrateSlices(tasks)
    assert.deepEqual(h.calls, [], `不该重开：${JSON.stringify({ status: tester.status, slice: tester.slice, hold: tester.hold, scope: tester.scope })}`)
  }
})

test('fix 的识别按 `fixOf === tester.id`：别人的 fix 不算（同切片也不行）', async () => {
  const tester = parkedTester()
  const otherFix = mergedFix({ fixOf: 'T-999' })
  const h = harness({ tasks: [tester, otherFix] })
  await h.orch.orchestrateSlices([tester, otherFix])
  assert.deepEqual(h.calls, [], 'fixOf 指向别的 tester 时不该重开本 tester')
})

// ── ② 的换基线（isolate）────────────────────────────────────────────────────

test('★ isolate=true：清 stale worktree + 删分支，argv 逐条、顺序在 transitionTo 之前', async () => {
  const root = tmpRoot('isolate')
  try {
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'T-200'), { recursive: true }) // stale 目录真的存在
    const tester = parkedTester()
    const fix = mergedFix()
    const h = harness({ tasks: [tester, fix], isolate: true, repoRoot: root, worktreeRoot: wt })
    await h.orch.orchestrateSlices([tester, fix])
    assert.deepEqual(effects(h), [
      ['runGit', root, ['worktree', 'remove', '--force', join(wt, 'T-200')]],
      ['runGit', root, ['branch', '-D', 'w/T-200']],
      ['activity', 'worktree', 'T-200', '重测换基线：已清理旧 worktree/分支 w/T-200，将基于最新主分支重建'],
      ['transitionTo', 'T-200', 'todo'],
      ['safeComment', 'T-200', '🔄 修复已完成（第 1 轮），自动重开本切片重测（机器闸门：通过后自动 done）。'],
      ['activity', 'retest', 'T-200', '修复完成，重开重测（第 1 轮）'],
    ])
    assert.deepEqual(logs(h), ['T-200 → todo（fix 完成，第 1 轮重测）'])
  } finally { cleanup(root) }
})

test('★ worktree remove 失败 → 用 (err || out).trim() 记日志，分支仍删、tester 仍重开', async () => {
  const root = tmpRoot('isolate-fail')
  try {
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'T-200'), { recursive: true })
    const tester = parkedTester()
    const fix = mergedFix()
    const h = harness({
      tasks: [tester, fix], isolate: true, repoRoot: root, worktreeRoot: wt,
      gitResult: { code: 1, out: '  out 兜底  ', err: 'err 优先  ' },
    })
    await h.orch.orchestrateSlices([tester, fix])
    assert.deepEqual(logs(h), [
      'T-200 重开前清理旧 worktree 失败（下轮 prepareWorktree 将复用旧快照）：err 优先',
      'T-200 → todo（fix 完成，第 1 轮重测）',
    ])
    // 失败的只是「清 worktree」；删分支与重开照做
    assert.deepEqual(effects(h).filter(c => c[0] === 'runGit')[1], ['runGit', root, ['branch', '-D', 'w/T-200']])
    assert.deepEqual(effects(h).filter(c => c[0] === 'transitionTo'), [['transitionTo', 'T-200', 'todo']])
  } finally { cleanup(root) }
})

test('★ worktree remove 失败且 err 为空 → 退到 out（`(err || out)` 这一半）', async () => {
  const root = tmpRoot('isolate-fail-out')
  try {
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'T-200'), { recursive: true })
    const h = harness({
      tasks: [parkedTester(), mergedFix()], isolate: true, repoRoot: root, worktreeRoot: wt,
      gitResult: { code: 1, out: ' 只有 stdout ', err: '' },
    })
    await h.orch.orchestrateSlices([parkedTester(), mergedFix()])
    assert.deepEqual(logs(h)[0], 'T-200 重开前清理旧 worktree 失败（下轮 prepareWorktree 将复用旧快照）：只有 stdout')
  } finally { cleanup(root) }
})

test('★ isolate=true 但 stale 目录不存在 → 不发 worktree remove，只删分支', async () => {
  const root = tmpRoot('isolate-nostale')
  try {
    const wt = join(root, 'wt')
    mkdirSync(wt, { recursive: true }) // 存在，但里面没有 T-200
    const h = harness({ tasks: [parkedTester(), mergedFix()], isolate: true, repoRoot: root, worktreeRoot: wt })
    await h.orch.orchestrateSlices([parkedTester(), mergedFix()])
    assert.deepEqual(effects(h).filter(c => c[0] === 'runGit'), [['runGit', root, ['branch', '-D', 'w/T-200']]])
    assert.equal(effects(h).filter(c => c[0] === 'activity' && c[1] === 'worktree').length, 1)
  } finally { cleanup(root) }
})

test('isolate=false → 一发 git 命令都不发，也不记「换基线」活动（重测直接在原目录续做）', async () => {
  const h = harness({ tasks: [parkedTester(), mergedFix()] })
  await h.orch.orchestrateSlices([parkedTester(), mergedFix()])
  assert.equal(effects(h).filter(c => c[0] === 'runGit').length, 0)
  assert.equal(effects(h).filter(c => c[0] === 'activity' && c[1] === 'worktree').length, 0)
})

// ── 接口活性 / 无模块级状态 ─────────────────────────────────────────────────

test('★ config 是**活的**：构造之后改 maxFixPerSlice 立刻改变行为（不是构造时快照）', async () => {
  const tester = parkedTester()
  const tasks = [tester, mergedFix(), mergedFix({ id: 'T-301' })]
  const h = harness({ tasks }) // 默认 maxFixPerSlice=2 → 2 个 fix 不超预算
  await h.orch.orchestrateSlices(tasks)
  assert.equal(effects(h).filter(c => c[0] === 'transitionTo').length, 1, '默认预算下应重开')

  h.deps.config.maxFixPerSlice = 1 // 同一实例、同一个 config 对象
  await h.orch.orchestrateSlices(tasks)
  assert.equal(effects(h).filter(c => c[0] === 'transitionTo').length, 1, '预算降到 1 之后不得再重开（第二次调用不该新增 transition）')
})

test('★ 没有模块级状态：两个实例各持一份退避表（空间 A 的退避不得挡住空间 B）', async () => {
  const root = repoWithBreakdown('two-instances')
  try {
    const td = task()
    const a = harness({ repoRoot: root, tasks: [td], expandRetryAt: new Map([['T-001', Date.now()]]) })
    const b = harness({ repoRoot: root, tasks: [td], expandRetryAt: new Map() })
    await a.orch.orchestrateSlices([td])
    await b.orch.orchestrateSlices([td])
    assert.deepEqual(a.calls, [], 'A 在退避窗内')
    assert.equal(hubCalls(b).length, 1, 'B 有自己的退避表，必须照常注册')
  } finally { cleanup(root) }
})

test('★ 没有模块级状态：同一实例连续两轮调用 = 两轮都注册（模块不记忆"已注册过"）', async () => {
  const root = repoWithBreakdown('twice')
  try {
    const td = task()
    const h = harness({ repoRoot: root, tasks: [td] })
    await h.orch.orchestrateSlices([td])
    await h.orch.orchestrateSlices([td])
    assert.equal(hubCalls(h).length, 2, '幂等由服务端与"切片束已存在"判定负责，模块自身不得记忆')
  } finally { cleanup(root) }
})

// ── parseSlices 的格式契约（直接钉，不隔着 sweep） ──────────────────────────

test('parseSlices：`## slices` 段 + `|` 四段（roles.json breaker 提示词的现行约定）', () => {
  assert.deepEqual(parseSlices(BREAKDOWN), EXPECTED_SLICES)
  // `### 切片` 也算段头（正则接受 2~3 个 #，中英文两种词）
  assert.deepEqual(parseSlices('### 切片\n- S1 | 甲 | a.ts | x\n'), [{ title: '甲', files: ['a.ts'], acceptance: ['x'] }])
})

test('parseSlices：ASCII `:` 也当分隔符；全角 `：` **不**当分隔符（现行行为，逐字继承）', () => {
  assert.deepEqual(parseSlices('## slices\n- S1:甲|a.ts|x\n'), [{ title: '甲', files: ['a.ts'], acceptance: ['x'] }])
  // 全角冒号不在字符类里 → 该行不匹配 → 视为无清单（roles.json 提示词要求的是 `|`，故不是缺陷）
  assert.deepEqual(parseSlices('## slices\n- S1：甲 | a.ts | x\n'), [])
})

test('parseSlices：`S` 前缀可省、`*` 子弹可用；CJK 逗号/分号也切分', () => {
  assert.deepEqual(parseSlices('## slices\n* 2 | 甲 | a.ts | x\n'), [{ title: '甲', files: ['a.ts'], acceptance: ['x'] }])
  assert.deepEqual(
    parseSlices('## slices\n- S1 | 甲 | a.ts，b.ts | x；y\n'),
    [{ title: '甲', files: ['a.ts', 'b.ts'], acceptance: ['x', 'y'] }],
  )
})

test('parseSlices：缺列 → 空数组；空标题行跳过；下一个标题即结束；无段头 → 空', () => {
  assert.deepEqual(parseSlices('## slices\n- S1 | 只有标题\n'), [{ title: '只有标题', files: [], acceptance: [] }])
  assert.deepEqual(
    parseSlices('## slices\n- S1 | | a.ts | x\n- S2 | 真标题 | b.ts | y\n'),
    [{ title: '真标题', files: ['b.ts'], acceptance: ['y'] }],
  )
  assert.deepEqual(
    parseSlices('## slices\n- S1 | 甲 | a.ts | x\n## 别的段\n- S2 | 乙 | b.ts | y\n'),
    [{ title: '甲', files: ['a.ts'], acceptance: ['x'] }],
  )
  assert.deepEqual(parseSlices('# 只有一级标题\n- S1 | 甲 | a.ts | x\n'), [])
  assert.deepEqual(parseSlices(''), [])
  // 段头之前/之后的纯文本行不参与解析
  assert.deepEqual(parseSlices('# x\n说明文字\n## slices\n说明文字\n- S1 | 甲 | a.ts | x\n'), [{ title: '甲', files: ['a.ts'], acceptance: ['x'] }])
})

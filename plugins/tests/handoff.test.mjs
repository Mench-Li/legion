// PRT-315 切片 6：流水线阶段交接（`plugins/src/handoff.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// `advancePipeline(doneTask)` 此前是 `spaceWorker()` 闭包里一个 57 行的内联函数：它读的是
// 闭包里的 `pipeline` / `stageByRole` / `useHub` / `scope` / `listTasks` / `hubPost`，
// 要触发它的任何一条分支，唯一的办法是**把整个守护跑起来**、在真 hub 或真 taskctl 上造
// done 任务、再等下一轮扫单。于是此前它只有端到端路径被顺带覆盖，而下面这些**只有边界输入
// 才会走到**的分支，一条用例都没有：
//
//   · 「后继已存在」的两条识别各自单独成立时（`parent` 命中 / `blockedBy` 命中且非 canceled）；
//   · 「canceled 不算存在」这条**唯一放行补建**的口子；
//   · 同角色但**不同 scope** 的后继不算后继；
//   · 链尾（`next === null`）与 `next` 指向不存在角色的两种"没有下一棒"；
//   · 切片任务 / fix 回炉任务 / 分析前缀尾的三种**不建**；
//   · 创建**失败**时只记日志、不抛出（守护必须继续跑）。
//
//   > 一个"只有把整个守护跑起来、并且恰好撞上边界输入"才能验证的分支，
//   > 与一个"根本没有这条分支"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// 拆出来之后，这个文件用**替身注入**驱动全部分支，不需要 hub、不需要 git、不碰文件系统。
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬过来的 57 行与 pristine `index.ts` 里那一段逐字相同」由 `_prt-handoff/prt315f-compare.mjs`
// 验证（按锚点抽出旧块、施加 3 条已声明的注入改写后逐行对拍，并单独核对 D7' 谓词的条件串）。
// 本文件只管**行为**。
//
// ## ★ 切片交接的"绕行"：这里能证明什么、不能证明什么
//
// `runWorker()` 里的 D7' 机器闸门（`report.status === 'done' && isSliceTesterTask(stage, t)`
// → `settleSliceTest` → `return`）**不在本模块**：它的动作要 hub / worktree / 执行面能力。
// 本文件能证明的是：
//   ① `isSliceTesterTask` 这个**谓词**的真值表（它同时是闸门与「测试士兵纪律」提示段的条件）；
//   ② **退一万步**——一个切片测试任务真的被喂进 `advancePipeline` 时，它**不会**拿到常规后继
//      （`slice != null` 那道闸门），并配一个**同形但非切片**的对照用例证明"拦住它的就是这道闸门"。
//   不能证明的是：闸门在 `runWorker` 里的**位置**（必须排在常规 done 分支之前）。那条只有读接线
//   才能发现——写在 `docs/superpowers/prt/PRT-315-handoff-slice.md` §诚实边界。
//
// ## 诚实边界（写在这里，免得被读成"端到端也验过了"）
//
// `hubPost` / `runTaskctl` / `listTasks` 都是**替身**：本文件证明的是"以哪一份 body / 哪一组
// argv 调了谁、调用几次、顺序如何"，**不**证明真实 team-hub `/api/create` 与真实 `taskctl create`
// 的行为。日志与 `activity(...)` 的**文案**是逐字断言的（它们是对外可观测的那一半）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createHandoff, isSliceTesterTask } from '../lib/handoff.js'

// ── 阶段与任务替身 ───────────────────────────────────────────────────────────

const STAGE = (role, label, next) => ({ role, label, prompt: '', next })

/** 默认编队：coder → tester → devops（devops 是链尾）。 */
const STAGES = [
  STAGE('coder', '切片编码', 'tester'),
  STAGE('tester', '切片测试', 'devops'),
  STAGE('devops', '部署', null),
]
const PIPELINE = { name: 'software', stages: STAGES }

/** 造一个任务；默认：一个 coder 阶段 done 任务（"干净"输入）。 */
function task(over = {}) {
  return {
    id: 'T-1',
    title: '【切片编码】把甲功能做出来',
    description: '目标描述正文。',
    acceptance: [],
    priority: 'P1',
    status: 'done',
    version: 1,
    soldier: 'coder',
    claimedAt: null,
    parent: null,
    role: 'coder',
    scope: 'app',
    hold: false,
    blockedBy: [],
    comments: [],
    ...over,
  }
}

/** 一条 ✓ 完成评论（`advancePipeline` 用它做 doneSummary 的数据源）。 */
const doneComment = (text) => ({ by: 'guard', at: '2026-09-15T00:00:00.000Z', text })

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 组装一个被测交接模块。
 *
 * ★ 可变绑定挂在 `state` 上，模块拿到的是**取值函数**——这正是 `index.ts` 的接线形态
 * （`pipeline: () => pipeline`）。用例改 `h.state.pipeline` 等于复现 `applyPipeline()` 的真实赋值，
 * 而不是"改了一个模块根本没读的字段"（前几个切片都踩过这一类假绿：`const { x } = deps` 之后
 * 改 `deps.x` 毫无影响）。`scope` / `config` / `log` / `activity` 是**值**，必须在构造时给。
 *
 * `listTasks` / `hubPost` / `runTaskctl` 每次调用都重新读 `h.state` 或 `over`，
 * 所以用例可以在两次调用之间改它们的行为（`h.state.tasks` / `h.over.hubThrows`）。
 */
function harness(over = {}) {
  const calls = []
  const state = {
    useHub: over.useHub ?? true,
    pipeline: over.pipeline === undefined ? PIPELINE : over.pipeline,
    stageByRole: over.stageByRole ?? new Map(STAGES.map(s => [s.role, s])),
    tasks: over.tasks ?? [],
    // ★ 2026-09-16（main 整合）：目标状态守卫的两个数据源，**刻意分开**。
    //   `goals` = 本进程缓存（`goalCtxById`）；`fetchable` = 权威回查能查到的东西。
    //   合成一个就没法区分"缓存命中"与"缓存缺失但回查到了"——
    //   而后者正是 T-156 那次加固新加的那条路。
    goals: over.goals ?? new Map(),
    fetchable: over.fetchable ?? new Map(),
  }
  const deps = {
    config: { role: over.role ?? 'guard', scrumDir: over.scrumDir ?? 'C:/scrum' },
    log: (m) => { calls.push(['log', m]) },
    scope: over.scope ?? 'app',
    useHub: () => state.useHub,
    pipeline: () => state.pipeline,
    stageByRole: () => state.stageByRole,
    listTasks: async (scopeFor) => { calls.push(['listTasks', scopeFor]); return state.tasks },
    hubPost: async (path, body) => {
      calls.push(['hubPost', path, body])
      if (over.hubThrows) throw new Error('hub 挂了')
      return over.hubResult === undefined ? { id: 'T-9' } : over.hubResult
    },
    runTaskctl: async (scrumDir, argv) => {
      calls.push(['taskctl', scrumDir, argv])
      if (over.taskctlThrows) throw new Error('taskctl 挂了')
      return over.taskctlResult === undefined ? { id: 'T-8' } : over.taskctlResult
    },
    activity: (kind, taskId, text) => { calls.push(['activity', kind, taskId, text]) },
    SLICE_ANALYSIS_TAIL: 'test-designer',
    isSliceGoalTask: (t) => (t.description ?? '').includes('[slice-mode]'),
    goalCtxById: { get: (id) => state.goals.get(id) },
    fetchGoalById: async (id) => {
      calls.push(['fetchGoalById', id])
      return state.fetchable.get(id)
    },
  }
  const handoff = createHandoff(deps)
  return { handoff, deps, calls, state, over, config: deps.config }
}

/** 只取"副作用"调用（log 单独断言，避免顺序噪音）。 */
const effects = (h) => h.calls.filter(c => c[0] !== 'log')
/** 全部 hubPost 调用。 */
const hubCalls = (h) => h.calls.filter(c => c[0] === 'hubPost')
const logs = (h) => h.calls.filter(c => c[0] === 'log').map(c => c[1])

// ── 静态契约 ─────────────────────────────────────────────────────────────────

test('模块出口：工厂只交回 advancePipeline；isSliceTesterTask 是模块级纯函数', () => {
  const h = harness()
  assert.deepEqual(Object.keys(h.handoff), ['advancePipeline'])
  assert.equal(typeof isSliceTesterTask, 'function')
  // 纯函数：不读任何闭包状态，同样输入同样输出（两处读点共用它）
  const st = STAGE('tester', '切片测试', 'devops')
  assert.equal(isSliceTesterTask(st, task({ role: 'tester', slice: 'T-4:S2' })), true)
  assert.equal(isSliceTesterTask(st, task({ role: 'tester', slice: 'T-4:S2' })), true)
})

// ══════════════════════════════════════════════════════════════════════════════
// D7' 谓词（闸门 + 测试士兵纪律段共用的唯一判定）
// ══════════════════════════════════════════════════════════════════════════════

test("★ isSliceTesterTask 真值表：角色=tester ∧ slice 非空 ∧ 键含 ':S'，三者缺一不可", () => {
  const tester = STAGE('tester', '切片测试', 'devops')
  const coder = STAGE('coder', '切片编码', 'tester')
  const cases = [
    ['tester + T-4:S2', tester, task({ role: 'tester', slice: 'T-4:S2' }), true],
    ['tester + T-4:S12（多位数序号）', tester, task({ role: 'tester', slice: 'T-4:S12' }), true],
    ['tester + slice=null（普通 tester 阶段任务）', tester, task({ role: 'tester', slice: null }), false],
    ['tester + slice=T-4（devops 尾形态，无 :S）', tester, task({ role: 'tester', slice: 'T-4' }), false],
    ['tester + slice=S2（缺目标前缀的 :）', tester, task({ role: 'tester', slice: 'S2' }), false],
    ['coder + T-4:S2（角色不对）', coder, task({ role: 'coder', slice: 'T-4:S2' }), false],
    ['stage 未定义（未知角色）', undefined, task({ role: 'tester', slice: 'T-4:S2' }), false],
  ]
  for (const [name, stage, t, want] of cases) {
    assert.equal(isSliceTesterTask(stage, t), want, `${name} → 期望 ${want}`)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ★ 切片交接的"绕行"：切片测试任务不拿常规后继（并配同形对照）
// ══════════════════════════════════════════════════════════════════════════════

test('★★ 切片测试任务（tester + T-4:S1）即使被喂进 advancePipeline 也不建常规后继', async () => {
  // D7' 闸门本该在 runWorker 里就把它改道 settleSliceTest；这里是**第二道**闸门
  // （advancePipeline 自己的 `slice != null`），证明"退一万步也不会建常规后继"。
  const h = harness()
  await h.handoff.advancePipeline(task({ id: 'T-4', role: 'tester', slice: 'T-4:S1', soldier: 'tester' }))
  assert.deepEqual(hubCalls(h), [], '切片任务不得走 /api/create 常规流转')
  assert.deepEqual(logs(h), [])
  assert.deepEqual(effects(h), [], '连 listTasks 都不该查（闸门在它之前）')
})

test('★★ 同形对照：把同一任务摘掉 slice 键（普通 tester 阶段任务）→ 当场建后继 devops', async () => {
  // 这一条是上一条的**对照**：它证明拦住切片任务的正是 `slice != null` 那道闸门，
  // 而不是"tester 这个角色本来就不流转"。
  const h = harness()
  await h.handoff.advancePipeline(task({ id: 'T-4', role: 'tester', slice: null, soldier: 'tester' }))
  assert.deepEqual(hubCalls(h).map(c => c[2].role), ['devops'])
  assert.deepEqual(logs(h), ['T-4 流水线流转：tester → devops（新任务 T-9）'])
})

// ══════════════════════════════════════════════════════════════════════════════
// 不建后继的其余闸门（每一条都单独可观测）
// ══════════════════════════════════════════════════════════════════════════════

test('pipeline() 为 null（单角色模式 / 数据面流水线被清空）→ 一行都不做', async () => {
  const h = harness({ pipeline: null })
  await h.handoff.advancePipeline(task())
  assert.deepEqual(h.calls, [], '连 listTasks / log 都不该有')
})

test('fix 回炉任务（fixOf 非空）→ 不建常规后继（合入即闭环，重测由编排重开 tester）', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({ fixOf: 'T-4' }))
  assert.deepEqual(h.calls, [])
})

test('★ 分析前缀尾（test-designer）且是 slice-mode 目标 → 不建通用 coder', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({
    role: 'test-designer', soldier: 'test-designer', description: '[slice-mode]\n拆解任务',
  }))
  assert.deepEqual(h.calls, [])
})

test('★ 对照：同样是 test-designer，但描述**不带** [slice-mode] → 照常走 next 流转', async () => {
  // 钉住闸门里那个 `&& isSliceGoalTask(...)`：少了它，切片模式之外的 test-designer 会被误吞。
  const h = harness({
    stageByRole: new Map([
      STAGE('test-designer', '测试设计', 'coder'),
      STAGE('coder', '切片编码', 'tester'),
    ].map(s => [s.role, s])),
  })
  await h.handoff.advancePipeline(task({
    role: 'test-designer', soldier: 'test-designer', title: '【测试设计】给出用例', description: '普通目标',
  }))
  assert.equal(hubCalls(h).length, 1)
  assert.equal(hubCalls(h)[0][2].role, 'coder')
})

test('未知角色（stageByRole 里没有）→ 不建', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({ role: 'nobody' }))
  assert.deepEqual(h.calls, [])
})

test('链尾阶段（next === null，如 devops）→ 不建', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({ role: 'devops', soldier: 'devops' }))
  assert.deepEqual(h.calls, [])
})

test('★ next 指向的角色在当前编队里不存在 → 不建（换编队期间不留半截）', async () => {
  const h = harness({
    stageByRole: new Map([STAGE('coder', '切片编码', 'ghost')].map(s => [s.role, s])),
  })
  await h.handoff.advancePipeline(task())
  assert.deepEqual(h.calls, [], 'nextStage 查不到 → 连 listTasks 都不该有')
})

// ══════════════════════════════════════════════════════════════════════════════
// 幂等：后继存在的两条识别（各子条件单独成立也够）
// ══════════════════════════════════════════════════════════════════════════════

test('★ 后继已存在（parent === 本任务）→ 跳过；**任意状态**都算，含 canceled', async () => {
  // 补建任务被将军 canceled 之后不得每轮重建——这是注释里写明的"拉锯"防线。
  for (const status of ['todo', 'in_progress', 'done', 'canceled']) {
    const h = harness({ tasks: [task({ id: 'T-9', role: 'tester', parent: 'T-1', status })] })
    await h.handoff.advancePipeline(task())
    assert.deepEqual(effects(h), [['listTasks', undefined]], `parent 命中（${status}）→ 只查一次，不建`)
  }
})

test('★ 后继已存在（blockedBy 含本任务，parent 为空）→ 跳过（createGoalChain 预建的全链）', async () => {
  const h = harness({ tasks: [task({ id: 'T-9', role: 'tester', parent: null, blockedBy: ['T-1'], status: 'todo' })] })
  await h.handoff.advancePipeline(task())
  assert.deepEqual(effects(h), [['listTasks', undefined]])
})

test('★★ canceled 是唯一不算存在的状态：blockedBy 命中但 status=canceled → 照常补建', async () => {
  // 「真被砍掉才允许补建」——把 canceled 也算存在，阶段链会在将军取消后**永久停住**。
  const h = harness({ tasks: [task({ id: 'T-9', role: 'tester', parent: null, blockedBy: ['T-1'], status: 'canceled' })] })
  await h.handoff.advancePipeline(task())
  assert.equal(hubCalls(h).length, 1, 'canceled 不算存在 → 补建下一角色任务')
  assert.equal(hubCalls(h)[0][2].role, 'tester')
})

test('★ 同角色同 parent 但**不同 scope** → 不算后继（多空间部署：任务 id 跨空间会撞号）', async () => {
  const h = harness({ scope: 'app', tasks: [task({ id: 'T-9', role: 'tester', parent: 'T-1', scope: 'other-space' })] })
  await h.handoff.advancePipeline(task())
  assert.equal(hubCalls(h).length, 1, '别的空间的后继与本空间无关')
  assert.equal(hubCalls(h)[0][2].scope, 'app')
})

test('★ 同 scope 但角色不是 next（例如另一个 coder）→ 不算后继', async () => {
  const h = harness({ tasks: [task({ id: 'T-9', role: 'coder', parent: 'T-1' })] })
  await h.handoff.advancePipeline(task())
  assert.equal(hubCalls(h).length, 1)
  assert.equal(hubCalls(h)[0][2].role, 'tester')
})

test('★ blockedBy 为空数组的后继不算（Array.isArray 那道闸门之外还有 includes）', async () => {
  const h = harness({ tasks: [task({ id: 'T-9', role: 'tester', parent: null, blockedBy: [] })] })
  await h.handoff.advancePipeline(task())
  assert.equal(hubCalls(h).length, 1)
})

// ══════════════════════════════════════════════════════════════════════════════
// 建任务：hub 与非 hub 两条路径的**逐字段**断言
// ══════════════════════════════════════════════════════════════════════════════

test('★ hub 模式：POST /api/create 的 body 逐字段 + log/activity 逐字', async () => {
  // ★ 2026-09-16（main 整合）：多了一条前置条件——该目标**仍未收口**。
  //   这不是为了让用例变绿而补的夹具：目标终态时不建后继是 T-156 的生产语义，
  //   所以"带 goalId 的正常流转"本来就必须包含"目标还开着"这一条。
  //   （把这条前置写出来，正是下面 `目标状态守卫` 那一组用例存在的理由。）
  const h = harness({ goals: new Map([['G-7', { id: 'G-7', status: 'active' }]]) })
  await h.handoff.advancePipeline(task({
    id: 'T-1', priority: 'P0', goalId: 'G-7',
    description: '目标描述正文。\n\n[本阶段] 切片编码（coder）\n\n旧阶段补充说明',
    comments: [doneComment('✓ 上上轮：早就完成'), doneComment('✓ 切片编码完成：写了三个文件\n证据：npm test 337 绿')],
  }))
  assert.deepEqual(hubCalls(h), [['hubPost', '/api/create', {
    title: '【切片测试】把甲功能做出来',
    description: '目标描述正文。\n\n[前序阶段] 切片编码（coder）已完成：✓ 切片编码完成：写了三个文件\n\n[本阶段] 切片测试（tester）',
    role: 'tester',
    parent: 'T-1',
    priority: 'P0',
    status: 'todo',
    by: 'guard',
    scope: 'app',
    goalId: 'G-7',
  }]])
  assert.deepEqual(logs(h), ['T-1 流水线流转：coder → tester（新任务 T-9）'])
  assert.deepEqual(h.calls.filter(c => c[0] === 'activity'),
    [['activity', 'dispatch', 'T-1', '流水线流转 切片编码 → 切片测试']])
})

test('★ doneSummary 取**最后一条** ✓ 评论的首行；没有 ✓ 评论 → 回落到 title', async () => {
  const last = harness()
  await last.handoff.advancePipeline(task({
    comments: [doneComment('✓ 早先那条'), doneComment('✓ 真正完成的这条\n第二行不进摘要')],
  }))
  assert.equal(hubCalls(last)[0][2].description.split('\n\n')[1], '[前序阶段] 切片编码（coder）已完成：✓ 真正完成的这条')

  const none = harness()
  await none.handoff.advancePipeline(task({ title: '【切片编码】把甲功能做出来', comments: [doneComment('普通评论')] }))
  assert.equal(hubCalls(none)[0][2].description.split('\n\n')[1], '[前序阶段] 切片编码（coder）已完成：【切片编码】把甲功能做出来')
})

test('★ description 的 base 只砍尾部 [本阶段] 段；非 ✓ 评论不参与摘要', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({ description: '', comments: [] }))
  // base 为空 → filter 掉空段 → 只剩两段；title 无【】前缀 → 原样
  assert.equal(hubCalls(h)[0][2].description, '[前序阶段] 切片编码（coder）已完成：【切片编码】把甲功能做出来\n\n[本阶段] 切片测试（tester）')
  assert.equal(hubCalls(h)[0][2].title, '【切片测试】把甲功能做出来')
})

test('★ title 无「【…】」前缀 → 不强行加；有嵌套括号时只替换第一段', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({ title: '把【乙】功能做出来' }))
  assert.equal(hubCalls(h)[0][2].title, '把【乙】功能做出来')

  const h2 = harness()
  await h2.handoff.advancePipeline(task({ title: '【切片编码】把【乙】做出来' }))
  assert.equal(hubCalls(h2)[0][2].title, '【切片测试】把【乙】做出来')
})

test('goalId 为空 → body.goalId 传 undefined（hub 侧按"无目标"落库）', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task({ goalId: null }))
  assert.equal(hubCalls(h)[0][2].goalId, undefined)
  assert.equal('goalId' in hubCalls(h)[0][2], true, 'key 仍在，值为 undefined')
})

// ══════════════════════════════════════════════════════════════════════════════
// ★★ 目标状态守卫（T-156）——这一组是**合并时新写的**，上游那一侧没有它
// ══════════════════════════════════════════════════════════════════════════════
//
// 这段守卫是 `main` 那一侧对**同一个** `advancePipeline` 的生产修复，随本次合并进入
// 本模块，而它在上游**一条用例都没有**（`git grep advancePipeline origin/main -- '*.test.mjs'`
// 为空）。也就是说：那笔修复是靠**事故**验证的，而不是靠用例。
//
//   > 一段"只在生产里被验证过"的修复，与一段"没有修复"的代码，
//   > 在**下一次事故之前**是同一个东西——而事故的代价是"已验收的 creative-kit 被覆盖"。
//
// 现场（T-156 复发，2026-09-16）：守护比该防御代码早启动 27 分钟（跑的是旧代码），
// 两个历史已收口目标上凭空长出 4 个任务（2 个已执行完并 promote、1 个已在跑），
// 下游下一环正是素材制作。
//
// 注入纪律对应关系：`state.goals` = 本进程缓存（`goalCtxById`）；
// `state.fetchable` = 权威回查（`fetchGoalById`）能查到的东西。

test('★★ 目标守卫：缓存里是终态（done/canceled）→ **不建**后继，且给出可读理由', async () => {
  for (const status of ['done', 'canceled']) {
    const h = harness({ goals: new Map([['G-7', { id: 'G-7', status }]]) })
    await h.handoff.advancePipeline(task({ goalId: 'G-7' }))
    assert.deepEqual(hubCalls(h), [], `目标 ${status} 时不该建后继（hub 模式）`)
    assert.deepEqual(logs(h), [`T-1 流水线流转跳过：目标 G-7 已 ${status}（终态不再补建后继）`])
    // 缓存命中就够，**不许**为此去回查（否则每轮都为每个终态目标打一次 hub）
    assert.deepEqual(h.calls.filter(c => c[0] === 'fetchGoalById'), [])
  }
})

test('★★ 目标守卫：缓存缺失 → **权威回查**；回查到终态照样不建（T-156 加固的那条路）', async () => {
  // 这一条正是 2026-09-16 加固新增的语义：旧实现只在**本进程缓存**里查，
  // 缓存缺失时保持原行为 = **放行**（于是历史收口目标又长出链）。
  const h = harness({ fetchable: new Map([['G-7', { id: 'G-7', status: 'done' }]]) })
  await h.handoff.advancePipeline(task({ goalId: 'G-7' }))
  assert.deepEqual(h.calls.filter(c => c[0] === 'fetchGoalById'), [['fetchGoalById', 'G-7']], '缓存缺失必须回查')
  assert.deepEqual(hubCalls(h), [], '回查到终态也必须不建')
  assert.deepEqual(logs(h), ['T-1 流水线流转跳过：目标 G-7 已 done（终态不再补建后继）'])
})

test('★★ 目标守卫：回查**也拿不到** → 保守跳过，且理由写明是"状态无法确认"（fail closed）', async () => {
  // 判据不是"hub 挂了就跳过"这个动作，而是**跳过时说的话**：
  // "已 done"与"状态无法确认"是两件事，运维要能分清——前者是正常收口，后者要去看 hub。
  const h = harness() // 缓存空、回查也查不到
  await h.handoff.advancePipeline(task({ goalId: 'G-7' }))
  assert.deepEqual(hubCalls(h), [], '状态无法确认时必须保守跳过')
  assert.deepEqual(logs(h), ['T-1 流水线流转跳过：目标 G-7 状态无法确认（hub 不可达），保守不补建后继'])
})

test('★★ 目标守卫：**`paused` 有意不拦**——它是可恢复态，拦下会让恢复后的链永久断档', async () => {
  // 反向守卫。没有这一条，上面三条可以被一个"凡是不是 active 就跳过"的实现骗过，
  // 而那个实现会造成一个更隐蔽的故障：将军暂停 → 恢复 → 链永远不往下走
  //（advance 只在 done 事件触发，恢复时不会补跑）。
  const h = harness({ goals: new Map([['G-7', { id: 'G-7', status: 'paused' }]]) })
  await h.handoff.advancePipeline(task({ goalId: 'G-7' }))
  assert.equal(hubCalls(h).length, 1, 'paused 不该拦下流转')
})

test('★★ 目标守卫：守卫排在**切片/fix/分析前缀尾**三道闸之后、取 stage 之前', async () => {
  // 顺序是有意的（与上游逐字一致）：切片任务、fix 回炉、分析前缀尾本来就**不建**后继，
  // 让它们先返回，就不必为一个终态目标多做一次回查。
  // 没有这一条，"守卫放到函数最前面"会是一个**用例全绿**的改动，而它让每一轮
  // 都为每个切片/fix 任务白打一次 hub 回查。
  const h = harness({
    fetchable: new Map([['G-7', { id: 'G-7', status: 'done' }]]),
  })
  await h.handoff.advancePipeline(task({ goalId: 'G-7', slice: 'T-4:S2' }))
  assert.deepEqual(h.calls.filter(c => c[0] === 'fetchGoalById'), [], '切片任务不该走到守卫（它更早就返回了）')
  assert.deepEqual(hubCalls(h), [])
  assert.deepEqual(logs(h), [], '切片任务的返回不是"跳过"，不该打守卫那两条日志')
})

test('★ 非 hub 模式：runTaskctl 的 argv 逐字（含 config.scrumDir），且 body 不走 hub', async () => {
  const h = harness({ useHub: false, scrumDir: 'D:/scrum-dir' })
  await h.handoff.advancePipeline(task({ priority: 'P2' }))
  assert.deepEqual(hubCalls(h), [])
  assert.deepEqual(h.calls.filter(c => c[0] === 'taskctl'), [['taskctl', 'D:/scrum-dir', [
    'create',
    '--title', '【切片测试】把甲功能做出来',
    '--description', '目标描述正文。\n\n[前序阶段] 切片编码（coder）已完成：【切片编码】把甲功能做出来\n\n[本阶段] 切片测试（tester）',
    '--role', 'tester',
    '--parent', 'T-1',
    '--priority', 'P2',
    '--status', 'todo',
  ]]])
  assert.deepEqual(logs(h), ['T-1 流水线流转：coder → tester（新任务 T-8）'])
})

test('创建返回里没有 id → 日志用空串占位（不出现 undefined）', async () => {
  const h = harness({ hubResult: {} })
  await h.handoff.advancePipeline(task())
  assert.deepEqual(logs(h), ['T-1 流水线流转：coder → tester（新任务 ）'])
})

// ══════════════════════════════════════════════════════════════════════════════
// 失败路径：只记日志、不抛出、不发 activity
// ══════════════════════════════════════════════════════════════════════════════

test('★★ hub 建任务抛错 → 吞掉、只记 `${id} 流转失败：…`；**不**发 activity、不向上抛', async () => {
  const h = harness({ hubThrows: true })
  await assert.doesNotReject(h.handoff.advancePipeline(task()), '建任务失败不得掀翻整轮扫单')
  assert.deepEqual(logs(h), ['T-1 流转失败：Error: hub 挂了'])
  assert.deepEqual(h.calls.filter(c => c[0] === 'activity'), [], '失败路径不得发"流转"activity')
})

test('★ 非 hub 建任务抛错 → 同一处理（文案同形）', async () => {
  const h = harness({ useHub: false, taskctlThrows: true })
  await assert.doesNotReject(h.handoff.advancePipeline(task()))
  assert.deepEqual(logs(h), ['T-1 流转失败：Error: taskctl 挂了'])
})

test('★ 失败之后同一个实例仍能正常工作（失败不留状态）', async () => {
  const h = harness({ hubThrows: true })
  await h.handoff.advancePipeline(task())
  h.over.hubThrows = false
  await h.handoff.advancePipeline(task({ id: 'T-2' }))
  assert.deepEqual(logs(h), ['T-1 流转失败：Error: hub 挂了', 'T-2 流水线流转：coder → tester（新任务 T-9）'])
})

// ══════════════════════════════════════════════════════════════════════════════
// 取值函数活性（快照 vs 每次重新取值）
// ══════════════════════════════════════════════════════════════════════════════

test('★★ pipeline 走**取值函数**：构造后从 null 切到有流水线，立刻开始流转', async () => {
  // `applyPipeline()` 会把 `pipeline` 整体改写（数据面清空时还会退回 null）。
  // 快照住它的模块在"先单角色、后加载数据面流水线"的部署里**永远不流转**，且一行日志都没有。
  const h = harness({ pipeline: null })
  await h.handoff.advancePipeline(task())
  assert.deepEqual(h.calls, [], '此时没有流水线 → 不动')

  h.state.pipeline = PIPELINE // —— 与 applyPipeline() 的真实赋值同形
  await h.handoff.advancePipeline(task({ id: 'T-2' }))
  assert.deepEqual(logs(h), ['T-2 流水线流转：coder → tester（新任务 T-9）'])
})

test('★★ stageByRole 走**取值函数**：换编队后"下一角色"按新表查（旧表会查不到 → 静默不流转）', async () => {
  const h = harness()
  await h.handoff.advancePipeline(task())
  assert.equal(hubCalls(h)[0][2].role, 'tester')

  // —— 与 applyPipeline() 的真实改写同形：整个 Map 被替换
  h.state.stageByRole = new Map([
    STAGE('coder', '切片编码', 'reviewer'),
    STAGE('reviewer', '复核', null),
  ].map(s => [s.role, s]))
  await h.handoff.advancePipeline(task({ id: 'T-2' }))
  assert.equal(hubCalls(h)[1][2].role, 'reviewer')
})

test('★★ useHub 走**取值函数**：构造后 detectHub() 探测成功 → 立刻改走 hub 建任务', async () => {
  const h = harness({ useHub: false })
  await h.handoff.advancePipeline(task())
  assert.deepEqual(hubCalls(h), [])
  assert.equal(h.calls.filter(c => c[0] === 'taskctl').length, 1)

  h.state.useHub = true // —— 与 detectHub() 的真实赋值同形
  await h.handoff.advancePipeline(task({ id: 'T-2' }))
  assert.equal(hubCalls(h).length, 1, '探测到 hub 之后必须走 /api/create，不再 fork taskctl')
})

// ══════════════════════════════════════════════════════════════════════════════
// 无状态（多空间监督者：同进程 mount 多个 spaceWorker）
// ══════════════════════════════════════════════════════════════════════════════

test('★ 没有模块级"已流转"记忆：同一任务调两次就是两次创建（幂等只来自 listTasks 快照）', async () => {
  // 幂等来自"查一遍任务池"，不是来自本模块内部记住谁流转过。若模块级记了 Set，
  // 空间 A 的流转会把空间 B 的**同名 taskId** 一起挡住——多空间部署里撞号是常态。
  const h = harness()
  await h.handoff.advancePipeline(task())
  await h.handoff.advancePipeline(task())
  assert.equal(hubCalls(h).length, 2)
  assert.equal(h.calls.filter(c => c[0] === 'listTasks').length, 2, '两次都真的查了任务池')
})

test('★ 两个实例互不影响：一个空间的边界状态不得串到另一个空间', async () => {
  const a = harness({ scope: 'space-a' })
  const b = harness({ scope: 'space-b' })
  a.state.tasks = [task({ id: 'T-9', role: 'tester', parent: 'T-1', scope: 'space-a' })] // A 有后继
  await a.handoff.advancePipeline(task())
  await b.handoff.advancePipeline(task())
  assert.equal(hubCalls(a).length, 0, 'A 空间已有后继 → 不建')
  assert.equal(hubCalls(b).length, 1, 'B 空间的同名任务照常建')
  assert.equal(hubCalls(b)[0][2].scope, 'space-b')
})

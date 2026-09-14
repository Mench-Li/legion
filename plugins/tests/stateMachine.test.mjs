// PRT-315 切片 3：状态机（`plugins/src/stateMachine.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// 这里测的五个步骤（`// 1.` → `// 3.2`）此前是 `spaceWorker()` 里 `sweep()` 体内的
// **无名语句块 + 六个闭包箭头函数**：它们从闭包隐式捕获 `config` / `log` / `scope` /
// `isPipeline` / `stageByRole` / `stageOf` / `inflight` / `room` / `sliceRoomOk` /
// `runDetached` / `abortRetryAt` / `maxWorkerRetry` / `maxMediateAttempts` /
// `claimTask` / `workTodo` / `workReturned` / `runDiscussion` / `safeComment` /
// `transitionTo` / `mediation.mediatorRecoverWorker`。要想单测其中任何一句，
// 唯一的办法是**把整个守护跑起来**。
//
// 于是它们此前一条用例都没有，而它们做的是**这台机器的全部"自动重跑"决策**：
// 什么任务会被认领、被解阻续做、被退回纠错、被强制置 blocked。
//   > 一个"只有把整个进程跑起来才能验证"的决策链，
//   > 与一个"根本没有这条决策链"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// （T-117 那两次现场就在这条链上：streak 恒 0 导致无限重派；workReturned 未认领
//   导致任务卡 blocked。两条回归此前只有"把守护跑起来"的端到端用例覆盖。）
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬过来的编译产物与原 index.js 里内联的那段逐字相同」由构建期对拍脚本
// `_prt-handoff/prt315c-compare.mjs` 验证（按注释锚点 + 大括号配平抽出旧块、
// 与新模块 `runRound` 的函数体归一化对拍，只放行两条已声明的注入改写：
// 判定谓词的隐式捕获 → 显式参数、`isPipeline`/`stageByRole` → 取值函数）。
// 本文件只管**行为**。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createStateMachine } from '../lib/stateMachine.js'

// ── 时间与任务替身 ───────────────────────────────────────────────────────────

/** 固定时间原点（远早于真实 `Date.now()`，退避窗口用真实时钟即可）。 */
const T0 = Date.parse('2026-01-01T00:00:00Z')
/** 第 n 秒的 ISO 时间戳（`at` 与 `claimedAt` 都用它，保证先后关系可读）。 */
const at = (n) => new Date(T0 + n * 1000).toISOString()

function comment(by, text, n) {
  return { by, at: at(n), text }
}

/** 造一个任务；默认：todo、无角色、未认领（第 1 步的"干净"输入）。 */
function task(over = {}) {
  return {
    id: 'T-1', title: '任务一', description: '', acceptance: [], priority: 'P1',
    status: 'todo', version: 1, soldier: null, claimedAt: null, parent: null,
    role: null, hold: false, blockedBy: [], comments: [],
    ...over,
  }
}

const STAGE = (role) => ({ role, label: role, prompt: '', next: null })

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 组装一个被测状态机。
 *
 * ★ 替身挂在**调用时才读**的 `over` 对象上，用例改的是 `over` 的字段。
 *
 * 为什么：`config` / `maxWorkerRetry` / `claimTask` 这些是构造时取走的**值**
 * （`const { claimTask } = deps`），改 `h.deps.claimTask` 对被测模块毫无影响——
 * 用例会"看起来改了行为"，实际什么都没改，然后绿着通过（切片 2 §7.2 同一条教训）。
 *
 * 而 `over.isPipeline` / `over.stageByRole` / `over.room` / `over.sliceRoomOk`
 * 是模块自带的**取值函数**每次调用重新读的那个值——改它们等于复现
 * `applyPipeline()` 的真实改写，这正是本文件要钉住的活性。
 *
 * `run: (tasks) => ...` 每次调用都**新建** `byId`（与原实现每轮扫单一致），
 * 并把 `runDetached` 收到的 job 收进 `deferred`——**不自动 await**，
 * 因为原实现也是 fire-and-forget；用例想等它就 `await h.flush()`。
 */
function harness(over = {}) {
  const calls = []
  const deferred = []
  const inflight = over.inflight ?? new Set()
  const abortRetryAt = over.abortRetryAt ?? new Map()
  const emptyStages = new Map()
  const deps = {
    config: { role: 'guard', intervalMs: 1000, ...(over.config ?? {}) },
    log: (m) => { calls.push(['log', m]) },
    scope: over.scope ?? 'app',
    isPipeline: () => over.isPipeline ?? false,
    stageByRole: () => over.stageByRole ?? emptyStages,
    stageOf: (t) => ((over.isPipeline ?? false) ? (over.stageByRole ?? emptyStages).get(t.role ?? '') : undefined),
    inflight,
    room: () => over.room ?? true,
    sliceRoomOk: () => over.sliceRoomOk ?? true,
    runDetached: (taskId, job) => { calls.push(['detached', taskId]); deferred.push(job) },
    abortRetryAt,
    maxWorkerRetry: over.maxWorkerRetry ?? 3,
    maxMediateAttempts: over.maxMediateAttempts ?? 2,
    claimTask: async (id, soldier) => {
      calls.push(['claim', id, soldier])
      if (over.claimThrows) throw new Error('已被他人认领')
    },
    workTodo: async (t, stage) => { calls.push(['workTodo', t.id, stage ? stage.role : null]) },
    workReturned: async (t, feedback, stage) => {
      calls.push(['workReturned', t.id, feedback.map(c => c.text), stage ? stage.role : null])
    },
    runDiscussion: async (t) => { calls.push(['runDiscussion', t.id]) },
    safeComment: async (id, text, scopeFor) => { calls.push(['safeComment', id, text, scopeFor]) },
    transitionTo: async (id, to, scopeFor) => { calls.push(['transitionTo', id, to, scopeFor]) },
    mediatorRecoverWorker: async (id, taskScope) => {
      calls.push(['mediator', id, taskScope])
      return over.recover ?? { fixed: true, summary: '修好了' }
    },
  }
  const sm = createStateMachine(deps)
  return {
    sm, deps, calls, deferred, inflight, abortRetryAt, over,
    run: (tasks) => sm.runRound(tasks, new Map(tasks.map(t => [t.id, t]))),
    flush: async () => { for (const j of [...deferred]) await j },
  }
}

/** 只取"派工相关"的调用（log 单独断言，避免顺序噪音）。 */
const jobs = (h) => h.calls.filter(c => c[0] !== 'log')

// ── 静态契约 ─────────────────────────────────────────────────────────────────

test('模块出口只有 runRound 一个函数：状态机自己不持有任何跨轮状态', () => {
  const h = harness()
  assert.equal(typeof h.sm.runRound, 'function')
  // 出参即全部：没有可被别处顺手读写的模块级状态（每实例状态都由调用方注入）。
  assert.deepEqual(Object.keys(h.sm), ['runRound'])
})

// ── // 1. todo：认领（互斥）→ 派工 ────────────────────────────────────────────

test('★ 第 1 步：todo → 单角色模式按 config.role 派 workTodo（stage=undefined）', () => {
  const h = harness()
  const t1 = task({ id: 'T-1' })
  h.run([t1])
  assert.deepEqual(jobs(h), [['workTodo', 'T-1', null], ['detached', 'T-1']])
  assert.equal(h.inflight.has('T-1'), true, '派工即登记在办，下轮才能互斥')
})

test('★ 流水线模式：按任务角色取阶段并派工；未知角色的 todo 直接跳过', () => {
  const h = harness({ isPipeline: true, stageByRole: new Map([['coder', STAGE('coder')]]) })
  const known = task({ id: 'T-1', role: 'coder' })
  const unknown = task({ id: 'T-2', role: 'nobody' })
  const anon = task({ id: 'T-3', role: null })
  h.run([known, unknown, anon])
  assert.deepEqual(jobs(h), [['workTodo', 'T-1', 'coder'], ['detached', 'T-1']])
  assert.equal(h.inflight.has('T-1'), true)
  assert.equal(h.inflight.has('T-2'), false, '未知角色不认领')
  assert.equal(h.inflight.has('T-3'), false, '无角色不认领')
})

test('讨论任务走群聊：role=discussion 派 runDiscussion，不走 workTodo', () => {
  const h = harness()
  h.run([task({ id: 'T-D', role: 'discussion' })])
  assert.deepEqual(jobs(h), [['runDiscussion', 'T-D'], ['detached', 'T-D']])
})

test('★ 互斥（inflight）：已在办的 taskId 不再派第二次', () => {
  const h = harness({ inflight: new Set(['T-1']) })
  h.run([task({ id: 'T-1' }), task({ id: 'T-2' })])
  assert.deepEqual(jobs(h), [['workTodo', 'T-2', null], ['detached', 'T-2']])
})

test('将军拦截（hold）的 todo 不认领；并发预算满（room=false）一条都不派', () => {
  const held = harness()
  held.run([task({ id: 'T-1', hold: true })])
  assert.deepEqual(jobs(held), [])

  const full = harness({ room: false })
  full.run([task({ id: 'T-1' }), task({ id: 'T-2' })])
  assert.deepEqual(jobs(full), [])
})

test('切片槽位闸门（sliceRoomOk）挡住时留给下轮，不认领、不登记在办', () => {
  const h = harness({ sliceRoomOk: false })
  h.run([task({ id: 'T-1', role: 'coder', slice: 'TD-1:S1' })])
  assert.deepEqual(jobs(h), [])
  assert.equal(h.inflight.size, 0)
})

test('★ 派工 promise 由 runDetached 收尾：job 真的执行 workTodo（fire-and-forget 不变）', async () => {
  const h = harness()
  h.run([task({ id: 'T-1' })])
  assert.equal(h.deferred.length, 1)
  await h.flush()
  assert.deepEqual(jobs(h), [['workTodo', 'T-1', null], ['detached', 'T-1']])
})

// ── // 2. blocked 且本角色、依赖已全部解除：解阻续做 ──────────────────────────

test('★ 解阻续做：依赖全部解除 → 走 workTodo（不预认领，claimTask 幂等在内层）', () => {
  const h = harness()
  const dep = task({ id: 'T-0', status: 'done' })
  const t = task({ id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0), blockedBy: ['T-0'] })
  h.run([dep, t])
  assert.deepEqual(jobs(h), [['workTodo', 'T-1', null], ['detached', 'T-1']])
})

test('★★ 依赖未解除 → 不续做；解除之后同一实例下一轮就续做（T-117：链上后段待命）', () => {
  const h = harness()
  const dep = task({ id: 'T-0', status: 'in_progress' })
  const t = task({ id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0), blockedBy: ['T-0'] })
  h.run([dep, t])
  assert.deepEqual(jobs(h), [], '上一环没 done：后段保持待命')

  dep.status = 'done'
  h.run([dep, t])
  assert.deepEqual(jobs(h), [['workTodo', 'T-1', null], ['detached', 'T-1']])
})

test('★ 依赖两种边界形态：依赖 id 查不到 → 视为未解除；canceled → 放行', () => {
  const missing = harness()
  missing.run([task({ id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0), blockedBy: ['T-404'] })])
  assert.deepEqual(jobs(missing), [], '依赖 id 查不到 → 视为未解除（不猜、不放行）')

  const canceled = harness()
  const dep = task({ id: 'T-0', status: 'canceled' })
  canceled.run([dep, task({ id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0), blockedBy: ['T-0'] })])
  assert.deepEqual(jobs(canceled), [['workTodo', 'T-1', null], ['detached', 'T-1']])
})

test('★★ blocked + 将军已答复：先 claim（blocked→in_progress）再 workReturned，且带上全部答复', async () => {
  // T-117 现场：workReturned 不认领 → 任务长时间卡 blocked、progress 被 hub 拒。
  // 这条钉住"先认领、再续做"的顺序，以及答复原文（顺序也必须一致）。
  //
  // 注意顺序：`detached` 记在**派工那一刻**（IIFE 挂起、还没跑完后续步骤），
  // 所以完整序列是 claim → detached → workReturned（`await h.flush()` 之后才是全貌）。
  const h = harness()
  const t = task({
    id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '❓ 需要将军确认：方向？', 1), comment('general', '继续 A 方案', 2), comment('general', '验收按 3 条算', 3)],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [['claim', 'T-1', 'guard'], ['detached', 'T-1']], '派工那一刻：认领已经发出')
  await h.flush()
  assert.deepEqual(jobs(h), [
    ['claim', 'T-1', 'guard'],
    ['detached', 'T-1'],
    ['workReturned', 'T-1', ['继续 A 方案', '验收按 3 条算'], null],
  ])
})

test('blocked + ❓ 仍待答复（无人回）：不自动重跑，等将军（避免空转）', () => {
  const h = harness()
  h.run([task({
    id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '❓ 需要将军确认：方向？', 1)],
  })])
  assert.deepEqual(jobs(h), [])
})

test('blocked + 将军拦截（hold）：不续做', () => {
  const h = harness()
  h.run([task({ id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0), hold: true })])
  assert.deepEqual(jobs(h), [])
})

test('blocked 但不属于本角色：连门都不进', () => {
  const h = harness()
  h.run([task({ id: 'T-1', status: 'blocked', soldier: 'someone-else', claimedAt: at(0) })])
  assert.deepEqual(jobs(h), [])
})

test('★ blocked 续做前置认领失败（已被他人认领）→ 吞掉只记日志，不派 workReturned', async () => {
  const h = harness({ claimThrows: true })
  const t = task({
    id: 'T-1', status: 'blocked', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '❓ 需要将军确认：方向？', 1), comment('general', '继续 A 方案', 2)],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [['claim', 'T-1', 'guard'], ['detached', 'T-1']])
  await assert.doesNotReject(h.flush(), '认领失败不得掀翻整轮扫单')
  assert.deepEqual(h.calls.filter(c => c[0] === 'log'),
    [['log', 'T-1 blocked 续做认领失败（可能已被他人认领）：Error: 已被他人认领']])
})

test('★ 流水线模式的解阻续做：claim 用**阶段角色**（不是 config.role）', async () => {
  const h = harness({ isPipeline: true, stageByRole: new Map([['tester', STAGE('tester')]]) })
  const t = task({
    id: 'T-1', status: 'blocked', soldier: 'tester', role: 'tester', claimedAt: at(0),
    comments: [comment('guard', '❓ 需要将军确认：跑哪些用例？', 1), comment('general', '全量', 2)],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [['claim', 'T-1', 'tester'], ['detached', 'T-1']])
  await h.flush()
  assert.deepEqual(jobs(h), [
    ['claim', 'T-1', 'tester'],
    ['detached', 'T-1'],
    ['workReturned', 'T-1', ['全量'], 'tester'],
  ])
})

test('★★ blocked 解阻与"本角色"判定走**取值函数**：换流水线之后立刻生效（快照会漏掉阶段角色）', () => {
  // `isPipeline` / `stageByRole` 在原文件里都是 `let`，`applyPipeline()` 换来源时重新赋值。
  // 快照住它们的模块在"从单角色切到多角色流水线"之后，仍按 soldier===config.role 判定 →
  // 阶段角色认领的任务**永远不被解阻**，只能干等 stale 释放。
  const h = harness()
  const t = task({ id: 'T-1', status: 'blocked', soldier: 'tester', role: 'tester', claimedAt: at(0) })
  h.run([t])
  assert.deepEqual(jobs(h), [], '此时不是流水线：soldier=tester ≠ guard，不是本角色')

  // —— 与 applyPipeline() 的真实改写同形：换掉取值函数背后的那个值
  h.over.isPipeline = true
  h.over.stageByRole = new Map([['tester', STAGE('tester')]])
  const t2 = task({ id: 'T-2', status: 'blocked', soldier: 'tester', role: 'tester', claimedAt: at(0) })
  h.run([t2])
  assert.deepEqual(jobs(h), [['workTodo', 'T-2', 'tester'], ['detached', 'T-2']])
})

// ── // 3. in_progress：退回纠错 / 中止退避 ───────────────────────────────────

test('★ 第 3 步：他人（将军）在认领后评论 → 退回纠错，反馈按原文顺序带进 worker', () => {
  const h = harness()
  const t = task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '🟢 已派 AI worker 开始执行', 1), comment('general', '这段重写', 2), comment('general', '补测试', 3)],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [['workReturned', 'T-1', ['这段重写', '补测试'], null], ['detached', 'T-1']])
})

test('认领**之前**的评论不算反馈：只按 claimedAt 之后过滤', () => {
  const h = harness()
  const t = task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(5),
    comments: [comment('general', '认领前的旧评论', 2)],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [], '旧评论不得触发重跑（否则每轮都会重派）')
})

test('★★ 守护自己的「worker 超时」评论 → 中止驱动重试，并写退避时间戳', () => {
  const h = harness()
  const t = task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '⚠ worker 超时（守护强制结算），任务保留在 in_progress，下一轮自动重试', 1)],
  })
  const before = Date.now()
  h.run([t])
  assert.deepEqual(jobs(h), [['workReturned', 'T-1', [], null], ['detached', 'T-1']])
  assert.equal(h.deferred.length, 1)
  const stamped = h.abortRetryAt.get('T-1')
  assert.equal(typeof stamped, 'number')
  assert.ok(stamped >= before && stamped <= Date.now(), '退避时间戳必须是"刚才"')
})

test('★★ 退避窗口内不再重试（防故障期热循环），窗口过后恢复', () => {
  // 这是本切片最容易写错的闸门：只跑一次的用例无论闸门在不在都是绿的。
  //   > 一个"只调用一次"的用例，与一个"真的验证了第二次被挡住"的用例，
  //   > 在闸门恰好存在时读数相同——只不过前者在闸门消失时也是绿的。
  const abortComment = comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', 1)
  const mk = (stamp) => task({ id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0), comments: [abortComment] })

  // ① 刚刚重试过（窗口 = intervalMs*4 = 4000ms）→ 挡住
  const fresh = harness({ abortRetryAt: new Map([['T-1', Date.now()]]) })
  fresh.run([mk()])
  assert.deepEqual(jobs(fresh), [], '退避窗口内不得再派')
  assert.equal(fresh.abortRetryAt.get('T-1') <= Date.now(), true, '被挡住时不得刷新时间戳')

  // ② 窗口已过 → 恢复重试
  const expired = harness({ abortRetryAt: new Map([['T-1', Date.now() - 5000]]) })
  expired.run([mk()])
  assert.deepEqual(jobs(expired), [['workReturned', 'T-1', [], null], ['detached', 'T-1']])
})

test('★ 退避只作用于"中止驱动"：将军反馈那条路**不**受退避影响', () => {
  // 预置一个"刚刚重试过"的退避戳：将军反馈必须照常派工，且**不得改写**这个戳
  // （改写会顺带把别的路径的窗口刷新掉）。
  const seeded = Date.now()
  const h = harness({ abortRetryAt: new Map([['T-1', seeded]]) })
  h.run([task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [comment('general', '按这个方向改', 1)],
  })])
  assert.deepEqual(jobs(h), [['workReturned', 'T-1', ['按这个方向改'], null], ['detached', 'T-1']])
  assert.equal(h.abortRetryAt.get('T-1'), seeded, '将军反馈这条路不写退避戳')
})

test('in_progress 无反馈也无中止评论 → 什么都不做（正常在办）', () => {
  const h = harness()
  h.run([task({ id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0), comments: [comment('guard', '🟢 已派 AI worker 开始执行', 1)] })])
  assert.deepEqual(jobs(h), [])
})

test('in_progress + 将军拦截（hold）→ 不自动纠错续跑', () => {
  const h = harness()
  h.run([task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0), hold: true,
    comments: [comment('general', '这段重写', 1)],
  })])
  assert.deepEqual(jobs(h), [])
})

test('in_progress + ❓ 待将军确认 → 不自动重跑（否则士兵提问后仍被重派，空转）', () => {
  const h = harness()
  h.run([task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '❓ 需要将军确认：方向？', 1)],
  })])
  assert.deepEqual(jobs(h), [])
})

test('★★ self(t) 跟随流水线取值函数：流水线模式下"本角色"是任务角色，阶段角色的评论不算反馈', () => {
  // 单角色：self = config.role = 'guard'，所以 coder 的评论**算**反馈；
  // 流水线：self = 任务角色 = 'coder'，同一条评论**不算**反馈（它是同事而不是将军）。
  const single = harness()
  single.run([task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', role: 'coder', claimedAt: at(0),
    comments: [comment('coder', '我是另一个角色', 1)],
  })])
  assert.deepEqual(jobs(single), [['workReturned', 'T-1', ['我是另一个角色'], null], ['detached', 'T-1']])

  const pipe = harness({ isPipeline: true, stageByRole: new Map([['coder', STAGE('coder')]]) })
  pipe.run([task({
    id: 'T-1', status: 'in_progress', soldier: 'coder', role: 'coder', claimedAt: at(0),
    comments: [comment('coder', '我是另一个角色', 1)],
  })])
  assert.deepEqual(jobs(pipe), [], '流水线模式下 coder 的评论不是"他人反馈"，不该触发退回')
})

// ── // 3.1 连续 worker 失败 → 交调解员处理重派 ───────────────────────────────

/** 造一个"连续 N 次失败后被强制结算"的 in_progress 任务。 */
function failedTask(fails = 3, extra = []) {
  const comments = []
  for (let i = 1; i <= fails; i++) comments.push(comment('guard', `⚠ worker 未完成（aborted），任务保留在 in_progress，等待人工处理或下一轮重试`, i))
  return task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [...comments, ...extra],
  })
}

/**
 * 造一个"已经历 N 轮调解员处理重派、每轮之后 worker 又失败"的任务。
 *
 * 顺序很要紧：`workerFailStreak` 只数**末尾连续**的失败，🤝 标记在中间；
 * 把 🤝 放在最后（而不是每轮失败之前）会让 streak 从尾部一读就是 0，
 * 于是"调解满上限"这条路径**永远进不去**——用例会绿着通过、什么都没测到。
 */
function redispatchedTask(rounds) {
  const comments = []
  let n = 1
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 3; i++) comments.push(comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', n++))
    comments.push(comment('guard', `🤝 调解员处理重派：已修复根因（第 ${r + 1} 次）`, n++))
  }
  for (let i = 0; i < 3; i++) comments.push(comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', n++))
  return task({ id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0), comments })
}

test('★ 连续失败未达上限（streak<3）→ 不当失败处理，走中止退避那条路', () => {
  const h = harness()
  h.run([failedTask(2)])
  assert.deepEqual(jobs(h), [['workReturned', 'T-1', [], null], ['detached', 'T-1']])
  assert.equal(h.abortRetryAt.has('T-1'), true)
})

test('★★ streak≥3 → 交调解员（不是置 blocked）：修复成功则重新派工续做', async () => {
  const h = harness({ recover: { fixed: true, summary: '去掉了冲突标记' } })
  h.run([failedTask(3)])
  assert.deepEqual(jobs(h), [['mediator', 'T-1', 'app'], ['detached', 'T-1']])
  await h.flush()
  assert.deepEqual(jobs(h), [
    ['mediator', 'T-1', 'app'],
    ['detached', 'T-1'],
    ['safeComment', 'T-1', '🤝 调解员处理重派：已修复根因（去掉了冲突标记），重新派工续做', 'app'],
    ['workReturned', 'T-1', [], null],
  ])
})

test('★ 调解员修不好 → 置 blocked 并留将军，评论文案逐字', async () => {
  const h = harness({ recover: { fixed: false, whyFailed: '根因在外部服务' } })
  h.run([failedTask(3)])
  await h.flush()
  assert.deepEqual(jobs(h), [
    ['mediator', 'T-1', 'app'],
    ['detached', 'T-1'],
    ['safeComment', 'T-1', '🛑 已自动重试 3 次且调解员未能自动修复根因（根因在外部服务），任务已置 blocked，请将军人工处理（或转派）', 'app'],
    ['transitionTo', 'T-1', 'blocked', 'app'],
  ])
})

test('★ 已调解满 maxMediateAttempts 次 → 不再调解，直接置 blocked（终态安全阀）', async () => {
  const h = harness()
  h.run([redispatchedTask(2)])
  assert.deepEqual(jobs(h), [['safeComment', 'T-1', '🛑 已自动重试 3 次、调解员处理重派 2 次仍未解决，任务已置 blocked，请将军人工处理（或转派）', 'app'], ['detached', 'T-1']])
  await h.flush()
  assert.deepEqual(jobs(h), [
    ['safeComment', 'T-1', '🛑 已自动重试 3 次、调解员处理重派 2 次仍未解决，任务已置 blocked，请将军人工处理（或转派）', 'app'],
    ['detached', 'T-1'],
    ['transitionTo', 'T-1', 'blocked', 'app'],
  ])
  assert.equal(h.calls.some(c => c[0] === 'mediator'), false, '到了上限就不得再调解（否则调解-再失败死循环）')
})

test('★★ T-117 churn 回归：🟢 派工评论不打断失败连续计数，streak 仍数到 3', () => {
  // 旧实现从尾部倒数遇 🟢 即 break → streak 恒 0 → give-up/调解永不触发 → 无限重派死循环。
  const h = harness()
  const t = task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [
      comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', 1),
      comment('guard', '🟢 已派 AI worker 开始执行（worker=scrum:T-1）', 2),
      comment('guard', '⚠ worker 超时（守护强制结算），任务保留在 in_progress', 3),
      comment('guard', '🟢 已派 AI worker 开始执行（worker=scrum:T-1）', 4),
      comment('guard', '⚠ 派工失败：Error: boom', 5),
    ],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [['mediator', 'T-1', 'app'], ['detached', 'T-1']], '🟢 穿插不影响 streak=（3）')
})

test('★ 将军评论打断失败连续计数：streak 归零 → 走反馈纠错而不是调解', () => {
  const h = harness()
  const t = task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [
      comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', 1),
      comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', 2),
      comment('general', '换个思路', 3),
      comment('guard', '⚠ worker 未完成（aborted），任务保留在 in_progress', 4),
    ],
  })
  h.run([t])
  assert.deepEqual(jobs(h), [['workReturned', 'T-1', ['换个思路'], null], ['detached', 'T-1']])
})

test('★ 已带 🛑 give-up 标记且将军未答复 → 完全停手（不重派、不调解，防无限空转）', () => {
  const h = harness()
  h.run([failedTask(3, [comment('guard', '🛑 已自动重试 3 次且调解员未能自动修复根因（x），任务已置 blocked，请将军人工处理（或转派）', 50)])])
  assert.deepEqual(jobs(h), [])
  assert.equal(h.deferred.length, 0)
})

test('★ give-up 后将军答复 → 解除等待，带答复退回纠错（不再触发调解）', () => {
  const h = harness()
  h.run([failedTask(3, [
    comment('guard', '🛑 已自动重试 3 次且调解员未能自动修复根因（x），任务已置 blocked，请将军人工处理（或转派）', 50),
    comment('general', '继续，按新方向做', 51),
  ])])
  assert.deepEqual(jobs(h), [['workReturned', 'T-1', ['继续，按新方向做'], null], ['detached', 'T-1']])
})

test('★ 任务的 scope 优先于实例 scope（多空间部署：评论/流转都写到任务所属空间）', async () => {
  const h = harness({ scope: 'app' })
  const t = failedTask(3)
  t.scope = 'other-space'
  h.run([t])
  await h.flush()
  assert.deepEqual(jobs(h), [
    ['mediator', 'T-1', 'other-space'],
    ['detached', 'T-1'],
    ['safeComment', 'T-1', '🤝 调解员处理重派：已修复根因（修好了），重新派工续做', 'other-space'],
    ['workReturned', 'T-1', [], null],
  ])
})

test('★ 调解员的 summary/whyFailed 缺失 → 文案退化为空串，不出现 undefined', async () => {
  const h = harness({ recover: { fixed: false } })
  h.run([failedTask(3)])
  await h.flush()
  const text = h.calls.find(c => c[0] === 'safeComment')[2]
  assert.equal(text, '🛑 已自动重试 3 次且调解员未能自动修复根因（），任务已置 blocked，请将军人工处理（或转派）')
})

// ── 每实例状态（多空间监督者：同进程 mount 多个 spaceWorker）─────────────────

test('★★ 退避表由调用方持有、每实例一份：一个空间的退避不得挡住另一个空间（同 taskId 会撞号）', () => {
  // `superviseSpaces()` 在同一进程里按空间 mount 多个 spaceWorker，它们共用模块注册表。
  // 如果退避表是模块级 Map，空间 A 的退避会把空间 B 的**同名 taskId** 一起挡住——
  // 任务 id 只在空间内唯一，跨空间撞号是常态而不是意外，且日志里一行都不会有。
  //   > 一个"每实例一份"的状态对象，
  //   > 与一个"每进程一份"的模块级 Map，在只有一个守护实例的部署里是同一个东西——
  //   > 只不过多空间部署下，后者会让两个空间的任务 id 互相退避。
  const mk = () => task({
    id: 'T-1', status: 'in_progress', soldier: 'guard', claimedAt: at(0),
    comments: [comment('guard', '⚠ worker 超时（守护强制结算），任务保留在 in_progress', 1)],
  })
  const s1 = harness({ scope: 'space-a' })
  const s2 = harness({ scope: 'space-b' })
  s1.run([mk()])
  s2.run([mk()])
  assert.deepEqual(jobs(s1), [['workReturned', 'T-1', [], null], ['detached', 'T-1']])
  assert.deepEqual(jobs(s2), [['workReturned', 'T-1', [], null], ['detached', 'T-1']], '★ 空间 B 的同名任务同样要重试')
  assert.equal(s1.abortRetryAt.size, 1)
  assert.equal(s2.abortRetryAt.size, 1)
})

test('两个实例的 in-flight 登记互不影响', () => {
  const s1 = harness({ inflight: new Set() })
  const s2 = harness({ inflight: new Set() })
  s1.run([task({ id: 'T-1' })])
  s2.run([task({ id: 'T-1' })])
  assert.deepEqual(jobs(s1), [['workTodo', 'T-1', null], ['detached', 'T-1']])
  assert.deepEqual(jobs(s2), [['workTodo', 'T-1', null], ['detached', 'T-1']])
  assert.equal(s1.inflight.has('T-1') && s2.inflight.has('T-1'), true)
})

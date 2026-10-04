// product/upgrade/task-state.test.mjs
// ============================================================================
// 任务读数词表的回归 —— 以及"接上真实读数就不会永久阻塞"这条判据
//
// 这个文件里最值钱的两条：
//
//   ① 用**真实源码**比对词表（`team-hub/server.mjs` 的 STATUSES、
//      `run-store.mjs` 的 IN_FLIGHT_ATTEMPT_STATES、`claim-policy.mjs` 的
//      TERMINAL_ATTEMPT_STATES）。词表在那边改了，这里会红。
//
//   ② 「一整份全都做完的看板读数必须放行」。这是那个缺陷的直接复现：
//      旧词表下 `done`/`canceled` 既不在活跃也不在终态里 → 全部落进
//      "认不出 → 按活跃" → **任何有任务历史的机器升级都被永久拦下**，
//      而被点名的全是早就做完的任务。
// ============================================================================

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  ACTIVE_TASK_STATES, ATTEMPT_ACTIVE_STATES, ATTEMPT_TERMINAL_STATES, BOARD_ACTIVE_STATES,
  BOARD_TASK_STATES, BOARD_TASK_STATES_OBSERVED_EXTRA, BOARD_TERMINAL_STATES, TASK_STATE_CHECKED,
  TASK_VOCABULARY_DRIFT, TERMINAL_TASK_STATES, WAITING_TASK_STATES, boardTasksFromPayload,
  classifyTaskState, describeTaskReadings, detectVocabularyDrift, extractStringArray, normalizeTaskReading,
  normalizeTaskReadings,
} from './task-state.mjs'

const ROOT = new URL('../../', import.meta.url)

function repo(relative) {
  return readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8')
}

// ---------------------------------------------------------------------------
// ① 与真实源码的一致性
// ---------------------------------------------------------------------------

test('★★★ 词表与真实源码一致：看板 STATUSES / 尝试 IN_FLIGHT / 尝试 TERMINAL', () => {
  const drift = TASK_VOCABULARY_DRIFT
  assert.equal(drift.ok, true, `词表漂移：\n${drift.problems.join('\n')}`)
})

test('★★★ 回归：旧词表与真实词表交集为空（这就是那个缺陷）', () => {
  // 把**修之前**手写的那两份清单原样写下来，然后证明它们与真实词表不相交。
  // 这一条不测实现，它把这个缺陷的**形状**钉在这里：将来若有人把清单改回
  // 手写，交集判据不会红（它只比对真实源码），但这条注释与下面这条断言
  // 会告诉读者"为什么不能那样写"。
  const OLD_ACTIVE = ['claimed', 'running', 'awaiting-approval', 'cancelling', 'retrying']
  const OLD_TERMINAL = ['completed', 'failed', 'cancelled', 'dead-letter']
  const realBoard = new Set(BOARD_TASK_STATES)
  const realAttempts = new Set([...ATTEMPT_ACTIVE_STATES, ...ATTEMPT_TERMINAL_STATES])

  for (const state of [...OLD_ACTIVE, ...OLD_TERMINAL]) {
    assert.equal(realBoard.has(state), false, `旧清单里的 ${state} 竟然是真的看板状态`)
    assert.equal(realAttempts.has(state), false, `旧清单里的 ${state} 竟然是真的尝试状态`)
  }
  // 而新的集合**必须**认识真实的那些。
  for (const state of ['in_progress', 'Running', 'done', 'canceled', 'Completed']) {
    assert.equal(classifyTaskState(state) === 'unrecognized', false, `真实状态 ${state} 被判成认不出`)
  }
})

test('读真实源码：看板 STATUSES 逐条对上', () => {
  const board = extractStringArray(repo('team-hub/server.mjs'), 'const STATUSES = ')
  assert.deepEqual(board, [...BOARD_TASK_STATES])
})

test('读真实源码：尝试的状态清单逐条对上', () => {
  const inFlight = extractStringArray(repo('team-hub/run-store.mjs'), 'IN_FLIGHT_ATTEMPT_STATES = Object.freeze(')
  assert.deepEqual(inFlight, [...ATTEMPT_ACTIVE_STATES])
  const terminal = extractStringArray(repo('team-hub/claim-policy.mjs'), 'TERMINAL_ATTEMPT_STATES = Object.freeze(')
  assert.deepEqual(terminal, [...ATTEMPT_TERMINAL_STATES])
})

test('漂移检测器自己能报出漂移（否则上面那条断言是空转的）', () => {
  const drifted = detectVocabularyDrift({
    serverSource: "const STATUSES = ['totally', 'new', 'states']\n",
    runStoreSource: 'IN_FLIGHT_ATTEMPT_STATES = Object.freeze([\n  \'Nope\',\n])\n',
    claimPolicySource: 'TERMINAL_ATTEMPT_STATES = Object.freeze([\'Nope2\'])\n',
  })
  assert.equal(drifted.ok, false, '漂移检测器没有报出漂移')
  assert.ok(drifted.problems.some((p) => p.includes('totally')))
  assert.ok(drifted.problems.some((p) => p.includes('Nope')))
})

// ---------------------------------------------------------------------------
// ② 判据方向
// ---------------------------------------------------------------------------

test('★ 分类：在跑 / 已收敛 / 等待 / 认不出 四类互斥', () => {
  assert.equal(classifyTaskState('in_progress'), 'active')
  assert.equal(classifyTaskState('Running'), 'active')
  assert.equal(classifyTaskState('AwaitingApproval'), 'active')
  assert.equal(classifyTaskState('done'), 'terminal')
  assert.equal(classifyTaskState('canceled'), 'terminal')
  assert.equal(classifyTaskState('Completed'), 'terminal')
  assert.equal(classifyTaskState('todo'), 'waiting')
  assert.equal(classifyTaskState('blocked'), 'waiting')
  assert.equal(classifyTaskState('in_review'), 'waiting')
  assert.equal(classifyTaskState('backlog'), 'waiting')
  assert.equal(classifyTaskState('从没见过的状态'), 'unrecognized')
  assert.equal(classifyTaskState(null), 'unrecognized')
  assert.equal(classifyTaskState(42), 'unrecognized')
})

test('★ 活跃与终态清单不相交（否则"算不算在跑"有两个答案）', () => {
  const overlap = ACTIVE_TASK_STATES.filter((state) => TERMINAL_TASK_STATES.includes(state))
  assert.deepEqual(overlap, [])
})

test('★ `RetryableFailure` 落在"认不出"：它没在跑，但也**没有收敛**', () => {
  // 放进终态就是允许一次升级在"下一轮重试即将开始"的间隙里动手。
  assert.equal(classifyTaskState('RetryableFailure'), 'unrecognized')
  assert.equal(ACTIVE_TASK_STATES.includes('RetryableFailure'), false)
  assert.equal(TERMINAL_TASK_STATES.includes('RetryableFailure'), false)
})

test('看板终态含 `failed`（代码里出现过、不在 STATUSES 里的历史值）', () => {
  assert.deepEqual([...BOARD_TASK_STATES_OBSERVED_EXTRA], ['failed'])
  assert.equal(classifyTaskState('failed'), 'terminal',
    '库里的历史 failed 值若被当成认不出，会让一台有失败任务的机器永久阻塞升级')
})

test('看板活跃只有 `in_progress`', () => {
  // 一个被遗忘的评审（`in_review`）或一个卡住的阻塞（`blocked`）不该
  // 永久阻塞这台机器的所有升级 —— 它们恰恰是最容易被遗忘的两类。
  assert.deepEqual([...BOARD_ACTIVE_STATES], ['in_progress'])
  assert.deepEqual([...WAITING_TASK_STATES], ['backlog', 'todo', 'in_review', 'blocked'])
})

// ---------------------------------------------------------------------------
// ③ 归一化
// ---------------------------------------------------------------------------

test('★ 归一化接受三种真实形状，`state` 原样保留', () => {
  const board = normalizeTaskReading({ id: 't-1', status: 'in_progress' })
  assert.equal(board.ok, true)
  assert.deepEqual({ ...board.task }, { id: 't-1', state: 'in_progress' })

  const attempt = normalizeTaskReading({ id: 'a-1', state: 'Running' })
  assert.equal(attempt.ok, true)
  assert.deepEqual({ ...attempt.task }, { id: 'a-1', state: 'Running' })

  const bare = normalizeTaskReading('t-9')
  assert.equal(bare.ok, true)
  assert.deepEqual({ ...bare.task }, { id: 't-9', state: null })

  // `in_progress` 与 `Running` 是**不同**东西的两种词表，不做形状归一。
  assert.equal(normalizeTaskReading({ id: 'x', status: 'in_progress' }).task.state, 'in_progress')
  assert.equal(normalizeTaskReading({ id: 'x', state: 'Running' }).task.state, 'Running')
})

test('★ 归一化失败的条目**保留**在结果里（丢掉它 = 让它不被判成在跑）', () => {
  const mixed = normalizeTaskReadings([
    { id: 'ok1', status: 'todo' },
    { id: '', status: 'done' },   // 空 id → 失败
    42,                            // 不是对象 → 失败
    { state: 'running' },          // 缺 id → 失败
  ])
  assert.equal(mixed.ok, true)
  assert.equal(mixed.tasks.length, 4, '归一化失败的条目被丢掉了')
  assert.equal(mixed.problems.length, 3)
  for (const task of mixed.tasks.slice(1)) {
    assert.equal(classifyTaskState(task.state), 'unrecognized', '失败的条目没有落进"认不出"')
  }
})

test('非数组的读数明确失败（而不是当成空数组）', () => {
  const r = normalizeTaskReadings(null)
  assert.equal(r.ok, false)
  assert.equal(r.tasks, null)
})

test('boardTasksFromPayload 认两种形状，其余明确失败', () => {
  const fromArray = boardTasksFromPayload([{ id: 't', status: 'done' }])
  assert.equal(fromArray.ok, true)
  assert.equal(fromArray.tasks.length, 1)

  const fromObject = boardTasksFromPayload({ tasks: [{ id: 't', status: 'done' }] })
  assert.equal(fromObject.ok, true)

  for (const bad of [null, 42, {}, { nope: 1 }, 'string']) {
    const r = boardTasksFromPayload(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 被接受了`)
    assert.equal(r.tasks, null)
  }
})

// ---------------------------------------------------------------------------
// ④ 摘要（设计 §7 line 150：界面要显示有没有在途任务）
// ---------------------------------------------------------------------------

test('★ 摘要把"在跑"与"认不出"都算进在途，且说得出各有多少', () => {
  assert.equal(describeTaskReadings([]), '没有任务')
  assert.match(describeTaskReadings([{ id: 'a', state: 'done' }]), /没有在途/)
  assert.match(describeTaskReadings([{ id: 'a', state: 'in_progress' }]), /1 个在途/)
  const mixed = describeTaskReadings([
    { id: 'a', state: 'in_progress' },
    { id: 'b', state: '全新状态' },
    { id: 'c', state: 'done' },
  ])
  assert.match(mixed, /2 个在途/)
  assert.match(mixed, /1 个在跑/)
  assert.match(mixed, /1 个状态认不出/)
  // 读数不可用时不能报成"没有在途"。
  assert.equal(describeTaskReadings(null), '任务读数不可用')
})

test('模块自检全绿', () => {
  assert.deepEqual([...TASK_STATE_CHECKED.problems], [])
  assert.equal(TASK_STATE_CHECKED.ok, true)
})

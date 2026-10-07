// product/upgrade/task-state.mjs
// ============================================================================
// 任务读数的**词表**与归一化 —— 升级侧唯一一处认识"什么状态算在跑"
//
// ## 为什么需要这个模块（这是一个真实缺陷的记录）
//
// `preflight.mjs` 原先自带两份手写清单：
//
//     ACTIVE_TASK_STATES   = ['claimed', 'running', 'awaiting-approval', 'cancelling', 'retrying']
//     TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled', 'dead-letter']
//
// 这两份清单**与产品里任何一个真实生产方都对不上**。产品实际有两套词表：
//
//   ① 看板任务（`team-hub/server.mjs` 的 `STATUSES`）：
//        backlog, todo, in_progress, in_review, blocked, done, canceled
//   ② 运行尝试（`team-hub/run-store.mjs` / `claim-policy.mjs`，PascalCase）：
//        Leased, PreparingWorkspace, BuildingContext, Running, Validating,
//        HandingOff, AwaitingApproval / Completed, Cancelled, DeadLetter
//
// 两边**交集为空**。后果不是"漏判"而是**两个方向同时错**，而且都很严重：
//
//   · 真实的"在跑"状态（`in_progress` / `Running`）不在活跃清单里 → 被当成
//     认不出的状态。`checkInFlightTasks` 对认不出的状态**按活跃处理**，
//     所以这一侧侥幸安全（那是那条判据写得好）。
//   · 真实的"已完成"状态（`done` / `canceled` / `Completed`）**也不在终态清单
//     里** → 同样被当成认不出的状态 → **按活跃处理**。
//
// 于是把真实读数接进来的结果是：**一台机器上只要有过任务历史，升级就永远
// 被拦在"仍有 N 个活跃任务"**，而那 N 个任务的 id 全是早就做完的。
//
// 这也解释了为什么在此之前**没有任何生产方写 `pendingTasks`**：
// 一旦接上真实数据就会永久阻塞，所以那一头一直是空的（`null` →
// "没有拿到任务读数" → 也拦）。两头都拦，升级一次都跑不成。
//
//   > 一个"从来没被接上过的接口"与一个"接上就永久阻塞的接口"，
//   > 在日志里长得一样：都是"没有拿到任务读数"。
//
// ## 修法是让它**只能**从真实词表派生
//
// 本模块不再手写那两份清单，而是从上面两套真实词表**派生**，并导出
// `TASK_VOCABULARY_DRIFT`（模块载入时读真实源文件比对的结果）。
// 另有 `task-state.test.mjs` 逐条读真实源码——词表在那边改了，这里会红。
//
// ## 判据的方向
//
// 认不出的一律按**活跃**处理（继承 `checkInFlightTasks` 的原判据）：
// 新加一个状态而这里没跟上时，"当成已完成"会让一次升级踩着它开始，
// 而"当成活跃"只会让升级多等一轮——多等一轮可以由超时路径兜住，
// 踩上去开始的那一次没有兜底。
// ============================================================================

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 词表 ①：看板任务状态（team-hub/server.mjs 的 STATUSES）
// ---------------------------------------------------------------------------

/**
 * 看板任务的**全部**状态。
 *
 * 顺序与 `server.mjs` 的 `STATUSES` 一致（含 `failed`——它在代码里出现过，
 * 但不在 `STATUSES` 里，见下面的 `EXTRA_OBSERVED`）。
 */
export const BOARD_TASK_STATES = Object.freeze([
  'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled',
])

/**
 * 代码里出现过、但不在 `STATUSES` 里的状态。
 *
 * `failed` 在 `team-hub` 里有 1 处写入。它不在 `TRANSITIONS` 图里，所以
 * **不能**被当作正规状态——但它是一个可能存在的历史值，而"一个可能在库里
 * 存在、而这里不认识的值"正是 `checkInFlightTasks` 的 `unrecognized` 分支
 * 要处理的东西。列在这里是为了让"我们见过它"这件事有记录，而不是让它
 * 悄悄落进 unrecognized 然后被当成活跃（那会让一台有失败任务的机器永久
 * 阻塞升级）。
 */
export const BOARD_TASK_STATES_OBSERVED_EXTRA = Object.freeze(['failed'])

/**
 * 看板里算"在跑"的状态。
 *
 * ★ 只有 `in_progress`。
 *
 *   设计 §7 line 150 的说法是"是否有**在途**任务"，line 216 的风险场景是
 *   「有任务**运行**、不能安全取消、服务拒绝退出」。两个说法都指向
 *   "正在执行"。
 *
 *   `in_review` 与 `blocked` 都**不在执行**：一个在等人评审、一个在等人解阻。
 *   把它们也算活跃会有一个很具体的坏结果——**一个被遗忘的评审会永久阻塞
 *   这台机器的所有升级**，而它们恰恰是最容易被遗忘的两类。
 *   真正在跑的工作由 `in_progress` 覆盖，等不下去时由 drain 超时 +
 *   "回到可选择界面"兜住（设计 §7 line 150 的后半句）。
 */
export const BOARD_ACTIVE_STATES = Object.freeze(['in_progress'])

/** 看板里算"已经收敛"的状态。 */
export const BOARD_TERMINAL_STATES = Object.freeze([
  'done', 'canceled', ...BOARD_TASK_STATES_OBSERVED_EXTRA,
])

// ---------------------------------------------------------------------------
// 词表 ②：运行尝试状态（team-hub/run-store.mjs / claim-policy.mjs）
// ---------------------------------------------------------------------------

/**
 * 在途的运行尝试状态（PascalCase）。
 *
 * 与 `run-store.mjs` 的 `IN_FLIGHT_ATTEMPT_STATES` 逐字一致。
 */
export const ATTEMPT_ACTIVE_STATES = Object.freeze([
  'Leased', 'PreparingWorkspace', 'BuildingContext', 'Running', 'Validating', 'HandingOff', 'AwaitingApproval',
])

/**
 * 终态的运行尝试状态。
 *
 * ★ `RetryableFailure` **不在这里**，而且这个遗漏是**故意**的：
 *   它既不是"在跑"（进程已经退出），也不是"收敛"（它还要被重试，
 *   也就是说这台机器上马上会有另一个尝试开始跑）。
 *   把"要重试的失败"当成终态，就是允许一次升级在"下一轮重试即将开始"
 *   的间隙里动手。所以它落在"认不出 → 按活跃处理"那一类，而这是对的。
 *
 * 与 `claim-policy.mjs` 的 `TERMINAL_ATTEMPT_STATES` 逐字一致。
 */
export const ATTEMPT_TERMINAL_STATES = Object.freeze(['Completed', 'Cancelled', 'DeadLetter'])

// ---------------------------------------------------------------------------
// 合并后的判据集合
// ---------------------------------------------------------------------------

/** 认作"不能切"的状态：两套词表的并集。 */
export const ACTIVE_TASK_STATES = Object.freeze([...BOARD_ACTIVE_STATES, ...ATTEMPT_ACTIVE_STATES])

/** 认作"已经收敛"的状态：两套词表的并集。 */
export const TERMINAL_TASK_STATES = Object.freeze([...BOARD_TERMINAL_STATES, ...ATTEMPT_TERMINAL_STATES])

/**
 * 两套词表里**既非活跃也非终态**的中间状态。
 *
 * 它们不是错误：`todo` 是"排队等人开始"、`in_review` 是"等人评审"、
 * `AwaitingApproval` 在尝试那侧已经算活跃所以不在这里。
 * 列出来是为了让"这个状态既不算在跑也不算收敛"成为一条**明写的判据**，
 * 而不是一个靠读者去比对三份清单才能得出的结论。
 */
export const WAITING_TASK_STATES = Object.freeze([
  'backlog', 'todo', 'in_review', 'blocked',
])

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

export const TASK_READING_CODES = Object.freeze({
  BAD_READING: 'task-reading-bad',
  EMPTY_ID: 'task-reading-empty-id',
  UNKNOWN_STATE: 'task-reading-unknown-state',
})

/**
 * 把一个任务读数归一化成 `{ id, state }`。
 *
 * 接受三种形状（真实生产方各不相同，而"让调用方先转成统一形状"是我在别处
 * 反复见到的漂移来源）：
 *
 *   · `{ id, status }`  —— 看板任务（`/api/board` 的行）
 *   · `{ id, state }`   —— 运行尝试
 *   · `'t-1'`           —— 只有一个 id（调用方只想说"这个还在跑"）
 *
 * `state` 一律**原样保留**（不做大小写/下划线归一）：两套词表是不同的东西
 * （`in_progress` 与 `Running` 不是同一个状态的两种写法），把它们的形状抹平
 * 只会让"这个状态属于哪套词表"变得不可回答。判据用的是上面那两份并集。
 */
export function normalizeTaskReading(raw) {
  if (typeof raw === 'string') {
    if (raw === '') return { ok: false, code: TASK_READING_CODES.EMPTY_ID, reason: '任务 id 是空字符串' }
    return { ok: true, code: null, reason: null, task: Object.freeze({ id: raw, state: null }) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: TASK_READING_CODES.BAD_READING, reason: '任务读数必须是对象或字符串' }
  }
  const id = raw.id ?? raw.taskId ?? raw.task_id ?? null
  if (typeof id !== 'string' || id === '') {
    return { ok: false, code: TASK_READING_CODES.EMPTY_ID, reason: `任务读数没有可用的 id：${JSON.stringify(raw).slice(0, 120)}` }
  }
  const state = raw.state ?? raw.status ?? null
  if (state !== null && typeof state !== 'string') {
    return { ok: false, code: TASK_READING_CODES.UNKNOWN_STATE, reason: `任务 ${id} 的状态不是字符串：${JSON.stringify(state)}` }
  }
  return { ok: true, code: null, reason: null, task: Object.freeze({ id, state }) }
}

/**
 * 归一化一整份读数。
 *
 * ★ 失败的条目**不丢弃**，而是变成 `state: null` 的条目。
 *
 *   一个 Normalize 失败的条目按"认不出"处理 → 活跃 → 拦。
 *   而"丢掉它然后报没有活跃任务"会让一次升级踩着一条**读不懂的记录**开始。
 *   这两种处置的差别，正是这个模块存在的理由。
 */
export function normalizeTaskReadings(readings) {
  if (!Array.isArray(readings)) {
    return Object.freeze({ ok: false, code: TASK_READING_CODES.BAD_READING, reason: '读数必须是数组', tasks: null, problems: Object.freeze([]) })
  }
  const tasks = []
  const problems = []
  for (const raw of readings) {
    const normalized = normalizeTaskReading(raw)
    if (normalized.ok) { tasks.push(normalized.task); continue }
    problems.push(Object.freeze({ code: normalized.code, reason: normalized.reason }))
    // 保留 id（拿得到的话），状态留空 —— 于是它一定会被判成"认不出"。
    const fallbackId = typeof raw === 'string' && raw !== '' ? raw
      : (typeof raw?.id === 'string' && raw.id !== '' ? raw.id : null)
    tasks.push(Object.freeze({ id: fallbackId, state: null }))
  }
  return Object.freeze({ ok: true, code: null, reason: null, tasks: Object.freeze(tasks), problems: Object.freeze(problems) })
}

/** 从 `/api/board` 的响应体取出任务读数。只认它认识的形状，不认识就明确失败。 */
export function boardTasksFromPayload(payload) {
  const rows = Array.isArray(payload) ? payload
    : (Array.isArray(payload?.tasks) ? payload.tasks : null)
  if (rows === null) {
    return Object.freeze({
      ok: false, code: TASK_READING_CODES.BAD_READING,
      reason: `/api/board 的响应既不是数组、也没有 tasks 数组：${JSON.stringify(payload)?.slice(0, 120)}`,
      tasks: null, problems: Object.freeze([]),
    })
  }
  return normalizeTaskReadings(rows)
}

/** 分类一份读数：`active` / `terminal` / `waiting` / `unrecognized`。 */
export function classifyTaskState(state) {
  if (typeof state !== 'string') return 'unrecognized'
  if (ACTIVE_TASK_STATES.includes(state)) return 'active'
  if (TERMINAL_TASK_STATES.includes(state)) return 'terminal'
  if (WAITING_TASK_STATES.includes(state)) return 'waiting'
  return 'unrecognized'
}

/** 一句话摘要，给界面与日志用（设计 §7 line 150：安装确认要显示有没有在途任务）。 */
export function describeTaskReadings(tasks) {
  if (!Array.isArray(tasks)) return '任务读数不可用'
  const buckets = { active: [], terminal: [], waiting: [], unrecognized: [] }
  for (const task of tasks) buckets[classifyTaskState(task?.state)].push(task)
  const blocking = [...buckets.active, ...buckets.unrecognized]
  if (blocking.length === 0) {
    return tasks.length === 0 ? '没有任务' : `${tasks.length} 个任务，没有在途的`
  }
  const parts = []
  if (buckets.active.length > 0) parts.push(`${buckets.active.length} 个在跑`)
  if (buckets.unrecognized.length > 0) parts.push(`${buckets.unrecognized.length} 个状态认不出（按在跑处理）`)
  return `有 ${blocking.length} 个在途任务（${parts.join('，')}）`
}

// ---------------------------------------------------------------------------
// 与真实源码的一致性（模块载入时读一遍）
// ---------------------------------------------------------------------------

function readRepoFile(relative) {
  try {
    return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
  } catch {
    return null
  }
}

/** 从 `const STATUSES = ['a', 'b']` 这样的字面量里取出字符串数组。 */
export function extractStringArray(source, anchor) {
  if (typeof source !== 'string') return null
  const at = source.indexOf(anchor)
  if (at < 0) return null
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  if (open < 0 || close < 0) return null
  return [...source.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * 读真实源码，看本模块的词表有没有漂移。
 *
 * 不做成"载入即抛"：词表漂移是一个**必须被看见**的事实，而不是一个
 * 让整个程序起不来的条件——升级端在词表漂移时仍然应当（保守地）工作。
 * 所以它是一份读数，由 `task-state.test.mjs` 断言为空。
 */
export function detectVocabularyDrift({
  serverSource = readRepoFile('team-hub/server.mjs'),
  runStoreSource = readRepoFile('team-hub/run-store.mjs'),
  claimPolicySource = readRepoFile('team-hub/claim-policy.mjs'),
} = {}) {
  const problems = []

  const board = extractStringArray(serverSource, 'const STATUSES = ')
  if (board === null) problems.push('读不到 team-hub/server.mjs 的 STATUSES')
  else {
    for (const state of board) {
      if (!BOARD_TASK_STATES.includes(state)) problems.push(`看板状态 ${state} 不在本模块的词表里`)
    }
    for (const state of BOARD_TASK_STATES) {
      if (!board.includes(state)) problems.push(`本模块的看板状态 ${state} 不在 server.mjs 的 STATUSES 里`)
    }
  }

  const inFlight = extractStringArray(runStoreSource, 'IN_FLIGHT_ATTEMPT_STATES = Object.freeze(')
  if (inFlight === null) problems.push('读不到 run-store.mjs 的 IN_FLIGHT_ATTEMPT_STATES')
  else if (inFlight.join(',') !== ATTEMPT_ACTIVE_STATES.join(',')) {
    problems.push(`运行尝试的在途清单漂移：源码 ${inFlight.join(',')} / 本模块 ${ATTEMPT_ACTIVE_STATES.join(',')}`)
  }

  const terminal = extractStringArray(claimPolicySource, 'TERMINAL_ATTEMPT_STATES = Object.freeze(')
  if (terminal === null) problems.push('读不到 claim-policy.mjs 的 TERMINAL_ATTEMPT_STATES')
  else if (terminal.join(',') !== ATTEMPT_TERMINAL_STATES.join(',')) {
    problems.push(`运行尝试的终态清单漂移：源码 ${terminal.join(',')} / 本模块 ${ATTEMPT_TERMINAL_STATES.join(',')}`)
  }

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

export const TASK_VOCABULARY_DRIFT = detectVocabularyDrift()

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckTaskState() {
  const problems = []

  // ① 两套词表的并集必须互不重叠，否则"算不算在跑"会有两个答案。
  const overlap = ACTIVE_TASK_STATES.filter((state) => TERMINAL_TASK_STATES.includes(state))
  if (overlap.length > 0) problems.push(`活跃与终态清单有交集：${overlap.join(',')}`)

  // ② 两套词表合起来必须覆盖各自的全部状态（一个状态既不在活跃也不在终态
  //   也不在等待集合里，就是一个沉默的"认不出"）。
  const covered = new Set([...ACTIVE_TASK_STATES, ...TERMINAL_TASK_STATES, ...WAITING_TASK_STATES])
  for (const state of [...BOARD_TASK_STATES, ...ATTEMPT_ACTIVE_STATES, ...ATTEMPT_TERMINAL_STATES]) {
    if (!covered.has(state)) problems.push(`状态 ${state} 没有被任何一类覆盖`)
  }

  // ③ 分类判据。
  if (classifyTaskState('in_progress') !== 'active') problems.push('in_progress 不算活跃')
  if (classifyTaskState('Running') !== 'active') problems.push('Running 不算活跃')
  if (classifyTaskState('done') !== 'terminal') problems.push('done 不算终态')
  if (classifyTaskState('canceled') !== 'terminal') problems.push('canceled 不算终态')
  if (classifyTaskState('Completed') !== 'terminal') problems.push('Completed 不算终态')
  if (classifyTaskState('todo') !== 'waiting') problems.push('todo 不算等待')
  if (classifyTaskState('全新状态') !== 'unrecognized') problems.push('未知状态没有被判为认不出')
  if (classifyTaskState(null) !== 'unrecognized') problems.push('缺状态没有被判为认不出')
  // ★ `RetryableFailure` 故意落在"认不出"：它既没在跑，也**没有收敛**
  //   （马上会有下一个尝试）。放进终态就是允许升级在重试间隙里动手。
  if (classifyTaskState('RetryableFailure') !== 'unrecognized') {
    problems.push('RetryableFailure 被判成了已知状态：它既没在跑也没收敛')
  }

  // ④ 归一化。
  const a = normalizeTaskReading({ id: 't1', status: 'done' })
  if (!a.ok || a.task.state !== 'done') problems.push('看板行（status 字段）没有归一化成功')
  const b = normalizeTaskReading({ id: 'a1', state: 'Running' })
  if (!b.ok || b.task.state !== 'Running') problems.push('尝试（state 字段）没有归一化成功')
  const c = normalizeTaskReading('t9')
  if (!c.ok || c.task.id !== 't9' || c.task.state !== null) problems.push('纯 id 形状没有归一化成功')
  if (normalizeTaskReading({ state: 'running' }).ok) problems.push('缺 id 的读数被接受了')
  if (normalizeTaskReading({ id: 'x', state: 42 }).ok) problems.push('非字符串状态被接受了')
  // ★ 归一化失败的条目**保留**在结果里（作为"认不出"），不丢。
  const mixed = normalizeTaskReadings([{ id: 'ok1', status: 'todo' }, { id: '', status: 'done' }, 42])
  if (mixed.tasks.length !== 3) problems.push(`归一化失败 ${3 - mixed.tasks.length} 个条目被丢掉了：丢掉的条目不会被判成在跑`)
  if (mixed.problems.length !== 2) problems.push(`归一化问题的条数不对：${mixed.problems.length}`)
  if (classifyTaskState(mixed.tasks[1].state) !== 'unrecognized') problems.push('归一化失败后的状态不是认不出')

  // ⑤ 摘要。
  if (describeTaskReadings([]) !== '没有任务') problems.push(`空读数的摘要不对：${describeTaskReadings([])}`)
  if (!describeTaskReadings([{ id: 'a', state: 'in_progress' }]).includes('在途')) problems.push('有在跑任务时摘要没有说"在途"')
  if (!describeTaskReadings([{ id: 'a', state: 'done' }]).includes('没有在途')) problems.push('只有已完成任务时摘要不对')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    boardActive: BOARD_ACTIVE_STATES,
    boardTerminal: BOARD_TERMINAL_STATES,
    attemptActive: ATTEMPT_ACTIVE_STATES,
    attemptTerminal: ATTEMPT_TERMINAL_STATES,
    drift: TASK_VOCABULARY_DRIFT,
  })
}

export const TASK_STATE_CHECKED = selfCheckTaskState()

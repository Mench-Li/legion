// workbench/mobile/board.mjs
// ============================================================================
// 手机端**空间看板**与**输入意图**的纯投影（远程 Agent 通道 S-F 之二）
//
// ## 为什么手机端要有看板，而不只是"某个 Agent 的对话"
//
// 只给对话的手机端有一个很安静的坏处：用户看到的是**一个 Agent 说了什么**，
// 而不是**这个空间里有什么事**。而"我要下个任务"这件事的前提恰恰是后者——
// 你得先看见现在有什么、卡在哪、谁在做。
//
// 设计文档 §1 要求「在同一 Agent 详情中汇合三类信息」，本模块补的是它的**上一层**：
// 空间级的任务全貌。两者不重复：看板回答"有什么"，Agent 详情回答"这个 Agent 在做什么"。
//
// ## 这个模块存在的唯一理由：**派单意图必须显式**
//
// 手机端曾经只有一条发送路径，而它固定发 `intent: 'ask'`（只读询问）。于是
// 用户在手机上打一句"把登录页的错误提示改一下"，发出去的是一条**询问**——
// 它永远不会变成任务，永远不会到电脑上执行。而界面上的回执看起来很正常。
//
//   > 一个"只能发询问"的输入框，与一个"能派活"的输入框，
//   > 在用户按下发送之后、在屏幕上长得一模一样。
//   > 区别要到"任务有没有被创建"那一刻才出现，而那时用户已经走开了。
//
// 所以意图由**用户显式选择**（默认仍是询问——它是安全的默认），
// 并且每种意图都带一句"它会发生什么"的说明。
// ============================================================================

/** 输入意图。`id` 必须是服务端 `agent-conversations.mjs` 白名单里的那几个。 */
export const INTENT_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'ask',
    label: '询问',
    hint: '问状态、要解释。**不**创建任务、不改变正在跑的执行。',
    createsTask: false,
    needsTask: false,
  }),
  Object.freeze({
    id: 'create_task',
    label: '派任务',
    hint: '新建一条任务，电脑上线后领取执行。',
    createsTask: true,
    needsTask: false,
  }),
  Object.freeze({
    id: 'feedback',
    label: '追加要求',
    hint: '给**正在跑的那条**任务补充要求，下一次执行时生效。',
    createsTask: false,
    needsTask: true,
  }),
])

export const DEFAULT_INTENT = 'ask'

export const INTENT_CODES = Object.freeze({
  UNKNOWN_INTENT: 'UNKNOWN_INTENT',
  TASK_REQUIRED: 'TASK_REQUIRED',
  EMPTY_BODY: 'EMPTY_BODY',
})

export class IntentError extends Error {
  constructor(code, message) { super(message); this.name = 'IntentError'; this.code = code }
}

export function intentOf(id) {
  return INTENT_OPTIONS.find((o) => o.id === id) ?? null
}

/**
 * 发送前的本地判定。**服务端仍会再判一次**——这里判的目的是别让用户白等一个
 * 必然被拒的往返，不是替服务端做安全判断。
 *
 * @returns {{ ok: true, intent: object, body: string, taskId: string|null }}
 */
export function planSend({ intent = DEFAULT_INTENT, body = '', taskId = null } = {}) {
  const text = String(body ?? '').trim()
  if (text.length === 0) throw new IntentError(INTENT_CODES.EMPTY_BODY, '消息不能为空')
  const option = intentOf(intent)
  if (option === null) throw new IntentError(INTENT_CODES.UNKNOWN_INTENT, `不支持的意图：${intent}`)
  // 「追加要求」必须知道改的是哪一条任务。界面上"当前任务"是一个隐含默认，
  // 而隐含默认在只有一个活动任务时正确、在有两个时**悄悄改错那一条**。
  if (option.needsTask === true && (taskId === null || String(taskId).trim().length === 0)) {
    throw new IntentError(INTENT_CODES.TASK_REQUIRED, '「追加要求」需要先指定要补充的是哪条任务')
  }
  return Object.freeze({ ok: true, intent: option, body: text, taskId: taskId === null ? null : String(taskId).trim() })
}

// ── 看板 ────────────────────────────────────────────────────────────────────

/** 任务状态（`orchestrator/state-machine/states.mjs` 的 6 个）→ 中文列名。 */
export const TASK_STATUS_LABELS = Object.freeze({
  todo: '待办',
  in_progress: '进行中',
  in_review: '待验收',
  blocked: '受阻',
  done: '已完成',
  canceled: '已取消',
})

/**
 * 看板列。顺序是**用户关心的顺序**，不是数据库顺序：
 *   · 「受阻 / 待验收」排在前面——它们需要人做点什么；
 *   · 「已完成」排最后，它是记录不是待办。
 *
 * `backlog` 不在 6 个状态里，但库里**真的会**出现它（看板上人工排期的任务）。
 * 刻意把它列出来：一个"在库里但不在界面上"的任务，与一个不存在的任务是同一个东西
 * ——用户会以为它丢了。
 */
export const BOARD_COLUMNS = Object.freeze([
  Object.freeze({ id: 'blocked', title: '受阻', tone: 'warn', statuses: ['blocked'] }),
  Object.freeze({ id: 'in_review', title: '待验收', tone: 'warn', statuses: ['in_review'] }),
  Object.freeze({ id: 'in_progress', title: '进行中', tone: 'busy', statuses: ['in_progress'] }),
  Object.freeze({ id: 'todo', title: '待办', tone: 'muted', statuses: ['todo'] }),
  Object.freeze({ id: 'backlog', title: '未排期', tone: 'muted', statuses: ['backlog'] }),
  Object.freeze({ id: 'done', title: '已完成', tone: 'ok', statuses: ['done', 'canceled'] }),
])

/**
 * 任务列表 → 看板列。
 *
 * 不认识的 `status` **不丢弃**：丢进最后一列并标注原文。丢掉的后果是
 * "状态机新增了一个状态，而手机上看不到那些任务"——一个不会报错、只是少东西的错。
 */
export function boardColumns(tasks = []) {
  const buckets = new Map(BOARD_COLUMNS.map((c) => [c.id, []]))
  const unknown = []
  for (const t of tasks ?? []) {
    const status = String(t?.status ?? '')
    const col = BOARD_COLUMNS.find((c) => c.statuses.includes(status))
    if (col === undefined) { unknown.push({ ...t, status }); continue }
    buckets.get(col.id).push(t)
  }
  const columns = BOARD_COLUMNS.map((c) => Object.freeze({
    id: c.id, title: c.title, tone: c.tone,
    tasks: Object.freeze(buckets.get(c.id)),
    count: buckets.get(c.id).length,
  }))
  return Object.freeze({ columns: Object.freeze(columns), unknown: Object.freeze(unknown), total: (tasks ?? []).length })
}

/** 看板上"需要我处理的"条数：受阻 + 待验收。用在标签上的小红点。 */
export function attentionCount(tasks = []) {
  return (tasks ?? []).filter((t) => ['blocked', 'in_review'].includes(t?.status)).length
}

// ── 任务的动态（进展）──────────────────────────────────────────────────────

/**
 * 把一条任务的 Attempt 与最近事件翻成**人话**。
 *
 * 三条不许混的口径（照着设计文档 §11 与 `timeline.mjs` 的同一套纪律）：
 *   · **没记录 ≠ 排队中**：`attempt === null` 时按任务本身的状态说；
 *   · **执行结束 ≠ 交付完成**：`Validating` 说的是"跑完了，等验收"；
 *   · **未知就是未知**：`UnknownOutcome` 不许翻译成"失败"，那会让人重跑。
 */
export function taskLine(task) {
  const status = String(task?.status ?? '')
  const attempt = task?.attempt ?? null
  const attemptState = attempt?.state ?? null
  if (attemptState === 'UnknownOutcome') return '结果待确认：这次执行的结果没法自动判定，需要人工对账'
  if (attemptState === 'DeadLetter') return '多次失败已停手：需要人看一眼再决定'
  if (attemptState === 'AwaitingApproval') return '等你确认：有一个动作需要你批准'
  if (attemptState === 'Validating') return '执行已结束，等待验收'
  if (attemptState === 'Running') return '正在电脑上执行'
  if (['Leased', 'PreparingWorkspace', 'BuildingContext'].includes(attemptState)) return '已派给电脑，正在准备'
  if (attemptState === 'Cancelled') return '本次执行已停止'
  if (attemptState === 'Completed') return '本轮执行完成'
  if (status === 'todo' && attemptState === null) return '等电脑领取'
  if (status === 'blocked') return '受阻，需要人处理'
  if (status === 'in_review') return '等待验收'
  if (status === 'done') return '已完成'
  if (status === 'canceled') return '已取消'
  if (status === 'backlog') return '未排期：还不该被领取'
  return '尚无执行记录'
}

/**
 * 「等待电脑上线」与「电脑在执行」必须分得开。
 *
 * 判据是**有没有活跃尝试**，不是 `hold`、也不是有没有设备在线——设备在线只说明
 * 通道可达，不说明这条任务被领走了。设计文档 §11 明确要求界面区分这两者。
 */
export function isWaitingForNode(task) {
  const attempt = task?.attempt ?? null
  if (attempt !== null && attempt?.state !== undefined) return false
  return ['todo', 'backlog'].includes(String(task?.status ?? ''))
}

/** 一条任务的摘要行（看板卡片第二行）。 */
export function taskMeta(task) {
  const parts = []
  const role = task?.role ?? task?.soldier ?? null
  if (typeof role === 'string' && role.length > 0) parts.push(role)
  if (task?.priority === 'high') parts.push('高优先级')
  return parts.join(' · ')
}

/**
 * 把「Agent 详情」里的 Attempt 并进「空间看板」的任务行。
 *
 * 两个端点各有一半：`/api/board` 知道**空间里所有**任务但不知道执行到哪一步，
 * `/api/agent-detail` 知道当前 Agent 的 Attempt 但它只覆盖一个岗位。
 * 看板要显示"等电脑领取 / 正在执行"，就必须把这两半拼起来。
 *
 * 拼的规矩是**详情优先、缺了不编**：
 *   · 详情里有这条任务 → 用它的 `attempt`；
 *   · 详情里没有（别的岗位的任务）→ **保持原样**（`attempt` 仍是 `undefined`），
 *     让 `taskLine` 按任务状态说那句它确定的话。绝不能补一个 `null` 之外的
 *     假 Attempt——那等于替另一台电脑断言它没在跑。
 */
export function mergeAttempts(tasks = [], detailTasks = []) {
  const byId = new Map((detailTasks ?? []).map((t) => [t?.id, t]))
  return (tasks ?? []).map((t) => {
    const d = byId.get(t?.id)
    if (d === undefined || d === null || !('attempt' in d)) return t
    return { ...t, attempt: d.attempt, dispatchHoldOwned: d.dispatchHoldOwned === true }
  })
}

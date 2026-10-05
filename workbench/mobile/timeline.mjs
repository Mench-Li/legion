// workbench/mobile/timeline.mjs
// ============================================================================
// 手机端时间线投影（远程 Agent 通道 S-F）
//
// 设计依据：设计文档 §1「核心体验不是单独增加一个"远程终端"，而是在同一 Agent
// 详情中汇合三类信息：用户与 Agent 的对话、Agent 正在做的任务、可追溯的进展和
// 结果。每条进展都关联任务及来源；用户对 Agent 的聊天和任务状态不能互相冒充」。
//
// ## 这个模块存在的唯一理由：**不要撒谎**
//
// 时间线把三类信息画在一起，于是"看起来像一条消息"与"真的是一条消息"很容易混。
// 设计文档 §5.1 明确：「聊天消息可以创建任务或关联既有任务，但不能把一条普通
// 消息误显示为执行进度」。所以每一条都带 `source`，且来源**由数据决定**，
// 不由绘制位置决定。
//
// ## 三个"不知道"必须能显示出来
//
// `connecting` / `stale` / `unavailable` 是三种不同的状态，不能都压成"加载中"：
//
//   · Hub 不可达          —— 手机侧网络或服务端问题；
//   · 电脑离线            —— 任务排队中，**不是**在跑；
//   · runtime 不可用      —— 连接在、但 Agent 干不了活。
//
// 设计文档 §11 明确要求界面「至少区分」这些。把它们混成一个"转圈"会让用户在
// 电脑关机时以为任务在跑——而他会因此等下去。
// ============================================================================

/** 三类信息。绘制顺序**不**决定来源，来源是数据里的字段。 */
export const SOURCES = Object.freeze(['user', 'agent', 'progress', 'command'])

export const TIMELINE_CODES = Object.freeze({
  HUB_UNREACHABLE: 'HUB_UNREACHABLE',
  NOT_SIGNED_IN: 'NOT_SIGNED_IN',
  NODE_OFFLINE: 'NODE_OFFLINE',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  TASK_RUNNING: 'TASK_RUNNING',
  TASK_AWAITING_USER: 'TASK_AWAITING_USER',
  TASK_RESULT_UNCONFIRMED: 'TASK_RESULT_UNCONFIRMED',
  IDLE: 'IDLE',
})

/**
 * 连接与运行状态 → 一个**具名**的显示结论。
 *
 * 优先级是刻意的：先判 Hub 可达性（它决定"看到的任何东西是不是最新的"），
 * 再判电脑，最后判 runtime。反过来的顺序会在 Hub 掉线时显示"HUB 正常"——
 * 因为最后更新的那次快照里它确实正常。
 *
 * `signedIn: false` 与 `hubReachable: false` 是**两件事**，不能合并：
 * 前者是"你还没登录"（Hub 好好的），后者是"服务端连不上"。
 * 实测踩过：未登录时界面显示"Hub 不可达"——而那正是把用户送去查网络的
 * 那种错话。他看到"服务器挂了"会去重启服务器，而其实只需要登录。
 */
export function deriveConnectionState({ hubReachable = false, signedIn = true, nodeOnline = null, runtimeHealthy = null, activeTaskState = null } = {}) {
  if (hubReachable !== true) {
    return Object.freeze({
      code: TIMELINE_CODES.HUB_UNREACHABLE, tone: 'error',
      label: 'Hub 不可达', detail: '读到的内容可能不是最新的；恢复后会按游标补齐',
    })
  }
  if (signedIn !== true) {
    return Object.freeze({
      code: TIMELINE_CODES.NOT_SIGNED_IN, tone: 'muted',
      label: '未登录', detail: 'Hub 正常；登录后即可查看 Agent 与任务',
    })
  }
  if (nodeOnline === false) {
    return Object.freeze({
      code: TIMELINE_CODES.NODE_OFFLINE, tone: 'warn',
      label: '电脑离线', detail: '任务会排队等待电脑上线，不是"执行中"',
    })
  }
  if (runtimeHealthy === false) {
    return Object.freeze({
      code: TIMELINE_CODES.RUNTIME_UNAVAILABLE, tone: 'warn',
      label: '运行时不可用', detail: '连接正常，但这台电脑上的 Agent 现在干不了活',
    })
  }
  // `runtimeHealthy === null` 是"没上报"，**不是**"不可用"——见下面对 unknown 的处理。
  if (activeTaskState === 'AwaitingApproval') {
    return Object.freeze({ code: TIMELINE_CODES.TASK_AWAITING_USER, tone: 'warn', label: '等待你确认', detail: '有一个动作需要你批准' })
  }
  if (activeTaskState === 'UnknownOutcome') {
    return Object.freeze({ code: TIMELINE_CODES.TASK_RESULT_UNCONFIRMED, tone: 'warn', label: '结果待确认', detail: '这次执行的结果无法自动判定，需要人工对账' })
  }
  if (activeTaskState !== null && activeTaskState !== undefined) {
    return Object.freeze({ code: TIMELINE_CODES.TASK_RUNNING, tone: 'busy', label: '任务进行中', detail: `Attempt 状态：${activeTaskState}` })
  }
  if (nodeOnline === null) {
    // 电脑状态未知：显示"未知"而不是默认"离线"，因为后者会让用户去开机，
    // 而问题可能只是还没拉到快照。
    return Object.freeze({ code: TIMELINE_CODES.IDLE, tone: 'muted', label: '电脑状态未知', detail: '还没有收到这台电脑的状态上报' })
  }
  return Object.freeze({ code: TIMELINE_CODES.IDLE, tone: 'ok', label: '空闲', detail: '电脑在线，当前没有进行中的任务' })
}

/**
 * 从消息元数据判定来源。
 *
 * `team-hub/agent-conversations.mjs` 写消息时会带 `meta.source`：
 * `user` / `answer` / `progress` / `command`。这里做的是**显示映射**，
 * 而不是重新判断"这算不算进展"——判断依据是服务端写入时的事实。
 */
export function sourceOf(meta = {}) {
  const raw = String(meta?.source ?? '')
  if (raw === 'user') return 'user'
  if (raw === 'answer') return 'agent'
  if (raw === 'progress') return 'progress'
  if (raw === 'command') return 'command'
  // 认不出来的一律标 `agent`（它是"系统/AI 说的"这一类），**不**默认成 `user`：
  // 把系统的消息显示成"我说过的话"是一个会让用户误判的错。
  return 'agent'
}

/** 一条消息 → 时间线条目。 */
export function timelineEntry(message) {
  const meta = message?.meta ?? {}
  const source = sourceOf(meta)
  const taskId = meta.taskId ?? null
  return Object.freeze({
    id: message?.id ?? null,
    at: message?.createdAt ?? null,
    author: message?.author ?? '',
    body: String(message?.body ?? ''),
    source,
    kind: meta.semanticType ?? null,
    taskId,
    // 只有带 taskId 的条目才能"打开任务"——一条没有任务归属的普通消息
    // 不该给一个会跳到空页面的入口。
    openableTask: typeof taskId === 'string' && taskId.length > 0,
    questionId: meta.questionId ?? null,
    options: Array.isArray(meta.options) ? meta.options : [],
    // 幂等重放：服务端可能补投同一条。`reportId` 是它自己的去重键。
    dedupeKey: meta.reportId ?? meta.commandId ?? (message?.id === undefined || message?.id === null ? null : `msg:${message.id}`),
  })
}

/**
 * 合并本地已有的与刚补到的条目。
 *
 * 两条纪律：
 *   ① 按 id 去重（断线重连会重复投递同一批）；
 *   ② **顺序按 id 单调**，不按到达顺序——补投的历史条目会晚到，插到末尾
 *      会让对话读起来像是"过去的消息刚刚发生"。
 */
export function mergeTimeline(existing, incoming) {
  const byId = new Map()
  for (const e of existing ?? []) if (e?.id !== undefined && e?.id !== null) byId.set(e.id, e)
  let appended = 0
  for (const e of incoming ?? []) {
    if (e?.id === undefined || e?.id === null) continue
    if (!byId.has(e.id)) appended += 1
    byId.set(e.id, e)
  }
  const merged = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))
  return Object.freeze({
    entries: merged,
    appended,
    // 重复投递的条数要能被看见：它是"游标没推进"的证据。
    duplicates: (incoming ?? []).filter((e) => e?.id !== undefined && e?.id !== null && (existing ?? []).some((x) => x.id === e.id)).length,
    cursor: merged.length === 0 ? null : merged[merged.length - 1].id,
  })
}

/** 待办任务视图：把"排队中"与"执行中"分开，因为它们的用户动作不同。 */
export function pendingTasks(tasks = []) {
  const queued = []
  const running = []
  const awaiting = []
  for (const t of tasks) {
    const state = t?.attempt?.state ?? null
    if (state === 'AwaitingApproval') { awaiting.push(t); continue }
    if (state === null || state === 'Queued') { queued.push(t); continue }
    if (['Leased', 'PreparingWorkspace', 'BuildingContext', 'Running', 'Validating', 'HandingOff'].includes(state)) running.push(t)
    else if (['UnknownOutcome', 'DeadLetter'].includes(state)) awaiting.push(t)
  }
  return Object.freeze({ queued, running, awaiting })
}

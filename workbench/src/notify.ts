/**
 * 通知中心统一定义与纯函数（P2-4）。
 *
 * 设计：通知 = 中枢审计（audit）派生，零新表零新端点。本模块把原先散在 NotifyView.tsx 里的
 * 「action → 文案/跳转/分类」判断、已读判定与合并去重，收敛为一组**无副作用纯函数**，
 * 供组件与 node:test 共用（与 dedupe.ts 同一模式：可被 --experimental-strip-types 直接 import）。
 *
 * 四项统一：
 *   1. **分类 / 优先级 / 来源**：每个 audit 动作映射为 { category, priority, source }（规则见
 *      NOTIFY_META，可解释且可测）。来源当前只有中枢审计（hub-audit），保留字段以便未来接入
 *      本地守护通知而不改前端消费方。
 *   2. **批量已读**：已读状态 = { cursor, ids }：cursor 是「连续已读游标」（历史兼容），ids 是
 *      显式已读 seq 集合（支持非连续批量）。applyMarkRead 负责压实：当 ids 恰好补满 cursor 之后
 *      的连续区间时推进 cursor 并清理，保持单调语义。
 *   3. **跳转协议**：jumpOf 统一产出 NotifyJump（task/goal/space/model/skill/none），UI 只按 kind
 *      分发，不再散落 if/else 前缀判断。
 *   4. **去重与断线恢复**：mergeNotifyItems 按 seq 去重降序（SSE 回放 / 轮询合并 / 乱序帧同语义）；
 *      audit seq 全局单调，故 shouldRefill 用「未过滤的全量流」判缺口——收到 seq > prevMax+1
 *      即说明中间帧丢失，应立即重拉补齐（详见 NotifyView 的重连/缺口处理）。
 */
import type { HubActivity, HubAuditEvent } from './types'

// ───────────────────────── 分类 / 优先级 / 来源 ─────────────────────────

/** 通知分类（与审计动作前缀对齐，UI 按此分组过滤）。 */
export type NotifyCategory = 'task' | 'goal' | 'space' | 'model' | 'skill'

/** 通知优先级：high = 需将军关注（拦截/转派/测试报告/目标关键节点/进入 blocked·in_review）。 */
export type NotifyPriority = 'high' | 'normal' | 'low'

/** 通知来源：当前唯一来源为中心审计；预留扩展位（本地守护/系统级）。 */
export type NotifySource = 'hub-audit'

export const NOTIFY_CATEGORY_LABEL: Record<NotifyCategory, string> = {
  task: '任务',
  goal: '目标',
  space: '空间',
  model: '模型',
  skill: '技能',
}

export const NOTIFY_PRIORITY_LABEL: Record<NotifyPriority, string> = {
  high: '高',
  normal: '普通',
  low: '低',
}

/**
 * 通知 action 白名单（原 api.ts NOTIFY_ACTIONS 迁移至此，api.ts re-export 保持兼容）。
 * chat:* 一律排除（防刷屏）；progress（中间态）、comment（走对话中心）、release-stale（租约回收）、
 * exec:*（开关回声）等高频/系统噪音不入列。
 */
export const NOTIFY_ACTIONS: ReadonlySet<string> = new Set<string>([
  'create', 'claim', 'transition', 'advance', 'reassign', 'hold', 'unhold',
  'patch', 'evidence', 'artifact', 'review-note', 'test-report',
  'goal:publish', 'goal:slices', 'goal:pause', 'goal:resume', 'goal:done', 'goal:cancel', 'goal:context',
  'space:create', 'space:update', 'space:delete', 'space:add-agents',
  'model:set', 'model:clear',
  'skill:submit', 'skill:review', 'skill:grant',
])

/** 是否通知白名单 action（chat:* 等不入列）。 */
export function isNotifyAction(action: unknown): boolean {
  return typeof action === 'string' && NOTIFY_ACTIONS.has(action)
}

/** 需要将军关注的优先级升级动作（明确清单）。 */
const HIGH_ACTIONS: ReadonlySet<string> = new Set(['hold', 'reassign', 'test-report', 'goal:publish', 'goal:done', 'goal:cancel'])
/** 低优先级（过程性/可稍后看）。 */
const LOW_ACTIONS: ReadonlySet<string> = new Set(['review-note', 'goal:context', 'model:clear', 'space:update'])
/** transition 落到这些状态视为高优先级（需人工介入）。 */
const HIGH_TRANSITION_STATES: ReadonlySet<string> = new Set(['blocked', 'in_review'])

/** action → 中文文案（图标 + 动作；与任务详情时间线同源风格，覆盖白名单全集）。 */
export const NOTIFY_ACTION_LABEL: Record<string, string> = {
  create: '📝 任务创建',
  claim: '🔒 认领开工',
  transition: '🔄 状态变更',
  advance: '⏩ 推进完成',
  reassign: '🔁 转派',
  hold: '🖐 拦截自动',
  unhold: '🚀 放行自动',
  patch: '🔧 补丁登记',
  evidence: '📦 提交证据',
  artifact: '📦 产物登记',
  'review-note': '🧾 审计批注',
  'test-report': '🧪 测试报告',
  'goal:publish': '🎯 目标发布',
  'goal:slices': '🎯 目标拆解',
  'goal:pause': '⏸ 目标暂停',
  'goal:resume': '▶ 目标恢复',
  'goal:done': '✅ 目标收尾',
  'goal:cancel': '✕ 目标取消',
  'goal:context': '📄 目标上下文更新',
  'space:create': '🗂 空间创建',
  'space:update': '🗂 空间更新',
  'space:delete': '🗂 空间删除',
  'space:add-agents': '🗂 智能体入编',
  'model:set': '⚙ 默认模型设置',
  'model:clear': '⚙ 默认模型清除',
  'skill:submit': '🧩 技能提交',
  'skill:review': '🧩 技能复审',
  'skill:grant': '🧩 技能授权',
}

/** 通知文案（未知动作兜底不抛错）。 */
export function notifyLabel(action: string): string {
  return NOTIFY_ACTION_LABEL[action] ?? ('⚡ ' + action)
}

/** action → 分类（前缀决定目标域；任务类为无前缀的默认域）。 */
export function notifyCategory(action: string): NotifyCategory {
  if (action.startsWith('goal:')) return 'goal'
  if (action.startsWith('space:')) return 'space'
  if (action.startsWith('model:')) return 'model'
  if (action.startsWith('skill:')) return 'skill'
  return 'task'
}

/** action（可结合 detail）→ 优先级。规则见 HIGH_/LOW_ 常量说明。 */
export function notifyPriority(action: string, detail?: Record<string, unknown> | null): NotifyPriority {
  if (HIGH_ACTIONS.has(action)) return 'high'
  if (LOW_ACTIONS.has(action)) return 'low'
  if (action === 'transition') {
    const to = detail && typeof detail.to === 'string' ? detail.to : ''
    if (HIGH_TRANSITION_STATES.has(to)) return 'high'
  }
  return 'normal'
}

// ───────────────────────── 跳转协议 ─────────────────────────

/** 统一跳转目标：UI 只按 kind 分发（不再散落 action 前缀判断）。 */
export type NotifyJump =
  | { kind: 'task'; ref: string }
  | { kind: 'goal'; ref: string | null }
  | { kind: 'space'; ref: string }
  | { kind: 'model'; ref: null }
  | { kind: 'skill'; ref: string | null }
  | { kind: 'none'; ref: null }

/** 有效任务号（排除空值、'*' 占位）。 */
export function validTaskId(taskId: unknown): string | null {
  return typeof taskId === 'string' && taskId.length > 0 && taskId !== '*' ? taskId : null
}

/**
 * 计算跳转目标。顺序（P2-4 统一语义：**动作所属域优先**，与分类一致）：
 *   ① `goal:` → 目标面板（ref = goalId 或 null）——目标类动作即使带 taskId（如 goal:slices 生成的
 *      阶段任务）也跳目标面板：用户点「目标发布/拆解」期待看到目标上下文，而非某个阶段任务；
 *   ② 有效 taskId → 任务详情（任务类动作）；
 *   ③ `space:` → 空间（ref = scope）；
 *   ④ `model:` / `skill:` → 对应面板；
 *   ⑤ 其它 → none（UI 兜底提示，不崩溃）。
 */
export function jumpOf(row: { action: string; taskId?: string | null; goalId?: string | null; scope?: string }): NotifyJump {
  if (row.action.startsWith('goal:')) return { kind: 'goal', ref: typeof row.goalId === 'string' && row.goalId ? row.goalId : null }
  const tid = validTaskId(row.taskId)
  if (tid) return { kind: 'task', ref: tid }
  if (row.action.startsWith('space:')) return { kind: 'space', ref: row.scope ?? '' }
  if (row.action.startsWith('model:')) return { kind: 'model', ref: null }
  if (row.action.startsWith('skill:')) return { kind: 'skill', ref: null }
  return { kind: 'none', ref: null }
}

// ───────────────────────── 已读状态（游标 + 显式集合）─────────────────────────

/** 已读状态：cursor = 连续已读游标（历史兼容）；ids = 显式已读 seq（支持非连续批量已读）。 */
export interface NotifyReadState {
  cursor: number
  ids: number[]
}

export const EMPTY_READ_STATE: NotifyReadState = { cursor: 0, ids: [] }

/** 单条是否已读。 */
export function isSeqRead(seq: number, state: NotifyReadState): boolean {
  return seq <= state.cursor || state.ids.includes(seq)
}

/** 规范化（去重、排序、丢弃 <= cursor 的冗余 id），保证状态可比对、可持久化。 */
export function normalizeReadState(state: NotifyReadState): NotifyReadState {
  const cursor = Number.isFinite(state.cursor) && state.cursor > 0 ? Math.floor(state.cursor) : 0
  const ids = [...new Set(state.ids.filter((s) => Number.isFinite(s) && s > cursor).map((s) => Math.floor(s)))].sort((a, b) => a - b)
  return { cursor, ids }
}

/**
 * 批量标记已读：把 seqs（或其 maxSeq）并入 ids，并**压实**——把 cursor 之后连续的已读区间并入游标。
 * 幂等：重复标记同一批结果不变。返回规范化后的新状态。
 */
export function applyMarkRead(state: NotifyReadState, seqs: number[]): NotifyReadState {
  const base = normalizeReadState(state)
  const ids = new Set(base.ids)
  for (const s of seqs) {
    if (!Number.isFinite(s)) continue
    const v = Math.floor(s)
    if (v > base.cursor) ids.add(v)
  }
  let cursor = base.cursor
  while (ids.has(cursor + 1)) { cursor += 1; ids.delete(cursor) }
  return normalizeReadState({ cursor, ids: [...ids] })
}

/**
 * 全部已读（当前列表口径）：游标推进到 maxSeq，清空其下的显式 id。
 * maxSeq 小于当前游标时不回退（单调）。
 */
export function applyMarkAllRead(state: NotifyReadState, maxSeq: number): NotifyReadState {
  const base = normalizeReadState(state)
  const v = Number.isFinite(maxSeq) ? Math.floor(maxSeq) : 0
  const cursor = Math.max(base.cursor, v)
  return normalizeReadState({ cursor, ids: base.ids.filter((s) => s > cursor) })
}

// ───────────────────────── 通知项与合并 ─────────────────────────

/** 通知项（列表渲染与计数的统一形状）。 */
export interface NotifyItem {
  /** 稳定去重键：`${scope}:${seq}`（seq 本身全局唯一，带 scope 便于跨空间合并调试）。 */
  id: string
  seq: number
  ts: string
  scope: string
  member: string
  action: string
  label: string
  category: NotifyCategory
  priority: NotifyPriority
  source: NotifySource
  taskId: string | null
  goalId: string | null
  detail: Record<string, unknown>
  jump: NotifyJump
  read: boolean
}

/** 由审计行构造通知项（read 由当前已读状态判定）。 */
export function toNotifyItem(row: HubActivity | HubAuditEvent, state: NotifyReadState): NotifyItem {
  const goalId = typeof (row as HubActivity).goalId === 'string' ? ((row as HubActivity).goalId as string) : null
  return {
    id: row.scope + ':' + String(row.seq),
    seq: row.seq,
    ts: row.ts,
    scope: row.scope,
    member: row.member,
    action: row.action,
    label: notifyLabel(row.action),
    category: notifyCategory(row.action),
    priority: notifyPriority(row.action, row.detail),
    source: 'hub-audit',
    taskId: row.taskId ?? null,
    goalId,
    detail: row.detail ?? {},
    jump: jumpOf({ action: row.action, taskId: row.taskId, goalId, scope: row.scope }),
    read: isSeqRead(row.seq, state),
  }
}

/** 批量构造（先过滤白名单；保持输入顺序）。 */
export function toNotifyItems(rows: Array<HubActivity | HubAuditEvent>, state: NotifyReadState): NotifyItem[] {
  return rows.filter((r) => isNotifyAction(r.action)).map((r) => toNotifyItem(r, state))
}

/**
 * 合并两批通知项：按 seq 去重（prev 保留已读态；同 seq 以 prev 为准），降序，截断 limit。
 * SSE 回放 / 轮询合并 / 乱序帧共用同一语义。
 */
export function mergeNotifyItems(prev: NotifyItem[], incoming: NotifyItem[], limit: number): NotifyItem[] {
  const seen = new Set<number>()
  const out: NotifyItem[] = []
  for (const it of prev) {
    if (seen.has(it.seq)) continue
    seen.add(it.seq)
    out.push(it)
  }
  for (const it of incoming) {
    if (seen.has(it.seq)) continue
    seen.add(it.seq)
    out.push(it)
  }
  out.sort((a, b) => b.seq - a.seq)
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out
}

/** 用新已读状态重算每一项的 read（批量已读后无需重建列表）。 */
export function applyReadState(items: NotifyItem[], state: NotifyReadState): NotifyItem[] {
  return items.map((it) => (it.read === isSeqRead(it.seq, state) ? it : { ...it, read: isSeqRead(it.seq, state) }))
}

// ───────────────────────── 计数与过滤 ─────────────────────────

/** 未读数（当前口径：read=false 的条数）。 */
export function unreadCount(items: NotifyItem[]): number {
  let n = 0
  for (const it of items) if (!it.read) n += 1
  return n
}

/** 分类计数（total/unread），供分类页签展示。 */
export function categoryCounts(items: NotifyItem[]): Record<NotifyCategory, { total: number; unread: number }> {
  const out: Record<NotifyCategory, { total: number; unread: number }> = {
    task: { total: 0, unread: 0 },
    goal: { total: 0, unread: 0 },
    space: { total: 0, unread: 0 },
    model: { total: 0, unread: 0 },
    skill: { total: 0, unread: 0 },
  }
  for (const it of items) {
    out[it.category].total += 1
    if (!it.read) out[it.category].unread += 1
  }
  return out
}

/** 按分类过滤（null = 全部）；可选 onlyUnread。 */
export function filterItems(items: NotifyItem[], category: NotifyCategory | null, onlyUnread = false): NotifyItem[] {
  return items.filter((it) => (category === null || it.category === category) && (!onlyUnread || !it.read))
}

/** 最高 seq（空列表 → 0）。 */
export function highestSeq(items: Array<{ seq: number }>): number {
  let max = 0
  for (const it of items) if (it.seq > max) max = it.seq
  return max
}

// ───────────────────────── 断线恢复缺口检测 ─────────────────────────

/**
 * 缺口检测（断线恢复的关键判据）。
 *
 * audit seq 在枢纽内**全局单调递增且唯一**（P1-1 已用事务内 MAX+1 保证跨进程唯一）。
 * 因此追踪**未按 scope 过滤的全量 SSE 流**：若某帧 seq > prevMaxSeq + 1，说明中间帧丢失
 * （断线窗口/回放不足），应立即重拉列表补齐。缺省 prevMaxSeq<=0 表示尚无基线（首帧建立基线，
 * 不算缺口，避免 SSE 首批回放误报）。
 */
export function shouldRefill(prevMaxSeq: number, incoming: Array<{ seq: number }>): boolean {
  if (prevMaxSeq <= 0) return false
  for (const it of incoming) {
    if (it.seq > prevMaxSeq + 1) return true
  }
  return false
}

/** 已读存储键（per scope；空 scope 用 __all__ 与旧版一致）。 */
export const notifyReadKey = (scope: string | null): string => 'legion.notify.read.' + (scope ?? '__all__')
/** 显式已读集合存储键（P2-4 新增；与游标键并存，旧数据继续生效）。 */
export const notifyReadIdsKey = (scope: string | null): string => 'legion.notify.readseq.' + (scope ?? '__all__')

// ───────────────────────── 右下角弹框（BUG-021）─────────────────────────
//
// ## 这一节要修的是什么
//
// 通知这条线**从前只做了一个未读计数徽标**：`App.tsx` 那个 effect 拉到审计行之后只调
// `setNotifyUnread(countNotifyUnread(...))`——数一下、点亮侧栏，**从来不打扰人**。
// 于是一个 worker 干完活停在 `in_review` 等将军，将军不知道，等待时间全浪费。
//
//   > 一个"有通知中心"的系统，与一个"到点了会来叫你"的系统，
//   > 在有人正好盯着侧栏的时候一模一样。
//
// ## 为什么不复用已读态判"新"
//
// 已读游标是**用户点出来的**（点开通知中心、点行、全部已读）——拿它当"弹过了没有"的游标，
// 会得到两种都错的后果：用户点一次「全部已读」⇒ 下一条新事件不再弹（因为他把游标推到了未来）；
// 用户从不点 ⇒ 每次刷新都把历史重弹一遍。
// 所以弹框**自己一把游标**（`popupSeqKey`），与已读态正交。

/** 状态中文（只用于弹框文案；看板列名在 `hubBoard.ts`，两处措辞不同是有意的：
 *  看板是**列名**（待验收），弹框是**一句叫你来的话**（待你验收）。） */
export const NOTIFY_STATUS_LABEL: Record<string, string> = {
  backlog: '待规划',
  todo: '待处理',
  in_progress: '进行中',
  in_review: '待你验收',
  blocked: '受阻（等你处理）',
  done: '已完成',
  canceled: '已取消',
}

/**
 * 该不该**弹框**：只弹高优先级（`notifyPriority` 的既有口径：拦截/转派/测试报告/目标关键节点/
 * 进入 blocked·in_review）。
 *
 * 弹框是**打扰**，所以门槛必须比"进通知中心"更高：`claim`（开工）、`artifact`（产物登记）这类
 * 进列表、进徽标，但不弹。一个什么都弹的提醒，等于没有提醒。
 */
export function shouldPopup(item: Pick<NotifyItem, 'priority'>): boolean {
  return item.priority === 'high'
}

/** 弹框主文案（一句话，含任务号与"要你做什么"）。`who` 可选：角色中文名（如「方案搜索」）。 */
export function popupText(item: NotifyItem, who?: string | null): string {
  const tid = validTaskId(item.taskId)
  const head = tid === null ? '' : tid + ' '
  const tail = typeof who === 'string' && who.length > 0 ? `（${who}）` : ''
  const detail = item.detail ?? {}
  switch (item.action) {
    case 'transition': {
      const to = typeof detail.to === 'string' ? detail.to : ''
      const state = NOTIFY_STATUS_LABEL[to] ?? (to.length > 0 ? to : '状态变更')
      const icon = to === 'in_review' ? '⏳' : to === 'blocked' ? '⛔' : '🔄'
      return `${icon} ${head}${state}${tail}`
    }
    case 'hold': return `🖐 ${head}被拦截：守护不再自动认领${tail}`
    case 'unhold': return `🚀 ${head}已放行：守护恢复自动认领${tail}`
    case 'reassign': return `🔁 ${head}被转派${tail}`
    case 'test-report': return `🧪 ${head}测试报告已提交${tail}`
    case 'evidence': return `📦 ${head}提交了证据${tail}`
    case 'goal:publish': return '🎯 目标已发布'
    case 'goal:done': return '✅ 目标已完成'
    case 'goal:cancel': return '✕ 目标已取消'
    case 'goal:pause': return '⏸ 目标已暂停'
    default: return `${notifyLabel(item.action)} ${head}${tail}`.trim()
  }
}

/** 一条待弹的提醒。 */
export interface NotifyPopup {
  /** 稳定去重键（= NotifyItem.id，`${scope}:${seq}`）。 */
  id: string
  seq: number
  text: string
  item: NotifyItem
}

/**
 * 从审计行里挑出**这一轮该弹**的提醒。
 *
 * - 只看 `seq > lastSeq`（游标持久化 ⇒ 刷新页面/重开浏览器不重弹）；
 * - 只弹 `shouldPopup`（高优先级）；
 * - **首次运行（`lastSeq <= 0`）只建立基线**，但会**补告**最近 `replayWindowMs` 内的
 *   （见下）——否则"刚装上这个提醒的人"看不到任何东西，而他恰好最需要知道"现在有谁在等我"；
 * - 升序返回（先发生先弹），超过 `limit` 时**只留最后 limit 条**（最新的才要紧），
 *   游标仍然推进到最新，避免下一轮把丢掉的那些又弹一遍。
 *
 * ## 为什么首次要补告"最近一段时间"，而不是全量历史、也不是什么都不说
 *
 * 两个极端都错：
 *   - **全量补弹**：一打开页面就被 200 条历史糊一脸 —— "被历史通知糊脸"的用户下一步就是关掉提醒；
 *   - **完全沉默**：装上提醒的那一刻恰好什么也不说，而那时 T-196 可能正停在待验收等你 ——
 *     于是"我装了提醒"与"我还是不知道"同时成立（这正是 BUG-021 修完之后**仍然会**发生的形态）。
 *
 * 折中是**时间窗**：只补告最近 `replayWindowMs`（App 传 6 小时）内真正需要你动手的事。
 * 时间窗的语义是"你刚才大概不在"，而不是"这台机器上曾经发生过什么"。
 */
export function popupBatch(
  rows: Array<HubActivity | HubAuditEvent>,
  lastSeq: number,
  limit = 3,
  options: { nowMs?: number; replayWindowMs?: number } = {},
): { popups: NotifyPopup[]; lastSeq: number } {
  const safeLast = Number.isFinite(lastSeq) && lastSeq > 0 ? Math.floor(lastSeq) : 0
  // 游标按**未过滤**的全量行推进：白名单外的行（progress/release-stale/chat:*）也在涨 seq，
  // 用过滤后的最大值会让游标停在原地反复重扫。
  let maxSeq = safeLast
  for (const r of rows) {
    const s = Number(r?.seq)
    if (Number.isFinite(s) && s > maxSeq) maxSeq = Math.floor(s)
  }
  const notable = toNotifyItems(rows, EMPTY_READ_STATE).filter(shouldPopup).sort((a, b) => a.seq - b.seq)

  if (safeLast <= 0) {
    // 首次：补告最近时间窗内的高优先级事件（默认窗口 0 = 不补，"纯建立基线"的语义仍可单独验证）
    const rawWindow = options.replayWindowMs
    const windowMs = typeof rawWindow === 'number' && Number.isFinite(rawWindow) ? Math.max(0, rawWindow) : 0
    const rawNow = options.nowMs
    const nowMs = typeof rawNow === 'number' && Number.isFinite(rawNow) ? rawNow : Date.now()
    const replay = windowMs === 0 ? [] : notable.filter((it) => {
      const ts = Date.parse(it.ts)
      if (!Number.isFinite(ts)) return false
      const age = nowMs - ts
      return age >= 0 && age <= windowMs
    })
    const kept = limit > 0 && replay.length > limit ? replay.slice(replay.length - limit) : replay
    return { popups: kept.map((it) => ({ id: it.id, seq: it.seq, text: popupText(it), item: it })), lastSeq: maxSeq }
  }

  const fresh = notable.filter((it) => it.seq > safeLast)
  const kept = limit > 0 && fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh
  return {
    popups: kept.map((it) => ({ id: it.id, seq: it.seq, text: popupText(it), item: it })),
    lastSeq: maxSeq,
  }
}

/** 弹框游标存储键（per scope；与已读游标**分开**，见本节开头说明）。 */
export const popupSeqKey = (scope: string | null): string => 'legion.notify.popupseq.' + (scope ?? '__all__')

/** 读弹框游标（存储不可用/损坏 → 0 = 下次只建立基线，不炸）。 */
export function readPopupSeq(scope: string | null, storage?: Pick<Storage, 'getItem'>): number {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
  if (store === null) return 0
  try {
    const raw = store.getItem(popupSeqKey(scope))
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

/** 写弹框游标（**只前进**：并发标签页里落后的一方不许把游标推回去，否则会重弹）。 */
export function writePopupSeq(scope: string | null, seq: number, storage?: Pick<Storage, 'getItem' | 'setItem'>): void {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
  if (store === null) return
  if (!Number.isFinite(seq) || seq <= 0) return
  try {
    if (Math.floor(seq) <= readPopupSeq(scope, store)) return
    store.setItem(popupSeqKey(scope), String(Math.floor(seq)))
  } catch {
    /* 存储不可用不影响本次弹框 */
  }
}

// workbench/src/runEventsView.ts
// ============================================================================
// 运行明细（`run_events`）的**纯展示层**。
//
// ## 为什么需要它
//
// `run_events` 早就落库了（`team-hub/run-store.mjs`，按 `attempt_id + event_seq`
// 存 13 类事件），只读端点 `GET /api/runtime/run-events` 也一直在（
// `team-hub/routes/runtime-verification.mjs`），但 workbench **从未调用过**。
// 结果就是：provider 启动、工具成败、模型请求这些**已经记下来的事实**，
// 在界面上一个字都看不到——用户只能看到一条"阶段 Attempt 摘要"。
//
// 缺的从来不是采集，是"一个只读出口 + 一层投影"。本模块就是那层投影。
//
// ## 三条判据（都是"看起来正常但其实错了"的形状）
//
// ① **`known === false` 必须显式显示。** 上游产生了一种控制面不认识的事件时，
//    过滤掉它会让「上游新增了事件但我们不记」与「上游什么都没产生」长得一样。
//
// ② **空事件集 ≠ 读取失败。** 前者是"这次运行确实没记事件"，后者是"没问成"。
//    两者若都渲染成一片空白，用户会以为运行很干净。
//
// ③ **不把未识别的事件文本原样当标题渲染。** 未知类型只显示类型名与序号，
//    正文留在折叠层——原样渲染等于让上游字段决定我们的界面。
// ============================================================================

/**
 * 13 类 RunEvent 的中文标签。
 *
 * ★ 这份清单必须与 `runtime/contracts/run.mjs` 的 `RUN_EVENT_TYPES` **逐字一致**——
 *   它是那份契约的展示投影，不是另一套定义。对不上的类型不会静默消失：它会以
 *   「未识别事件（type）」的形式露出来（见 `runEventsSection`），这既是兜底也是提醒。
 */
export const RUN_EVENT_LABELS: Record<string, string> = {
  'run.started': '开始运行',
  'model.selected': '选定模型',
  'message.delta': '消息增量',
  'tool.requested': '请求工具',
  'tool.started': '工具开始',
  'tool.completed': '工具完成',
  'tool.failed': '工具失败',
  'usage.updated': '用量更新',
  'artifact.produced': '产出物',
  'run.completed': '运行完成',
  'run.failed': '运行失败',
  'run.cancelled': '运行取消',
  'run.outcome_unknown': '结果未知',
}

/** 事件在摘要里的权重：数字越小越靠前。未登记的一律排在最后。 */
const EVENT_RANK: Record<string, number> = {
  'run.failed': 0,
  'run.outcome_unknown': 1,
  'tool.failed': 2,
  'run.cancelled': 3,
  'run.completed': 4,
  'run.started': 5,
  'tool.requested': 6,
  'tool.started': 7,
  'tool.completed': 8,
  'artifact.produced': 9,
  'model.selected': 10,
  'usage.updated': 11,
  'message.delta': 12,
}

export interface RunEventRow {
  /** 契约序号：同一 attempt 内单调（`run-store.mjs` 的 `event_seq`）。 */
  seq?: number
  eventSeq?: number
  type: string
  /** `false` = 上游产生了本控制面不认识的事件（必须显式显示）。 */
  known?: boolean
  atMs?: number
  /** 运输层字段名叫 `event`（`runEventsOf` 的产物），不是 `payload`。 */
  event?: unknown
  payload?: unknown
}

export interface RunEventView {
  type: string
  label: string
  known: boolean
  seq: number | null
  atMs: number | null
  /** 未识别类型只在详情里出正文；已知类型才允许直接展示摘要。 */
  summary: string
}

export interface RunEventsSection {
  /** `empty` / `unreadable` / `ok` 三态必须分得开（判据②）。 */
  state: 'empty' | 'unreadable' | 'ok'
  events: RunEventView[]
  /** 按类型计数，供默认折叠时显示"这次运行用了 3 个工具、失败 1 次"。 */
  counts: Array<{ type: string; label: string; count: number }>
  /** 读取失败时的原因（`state === 'unreadable'` 时必有）。 */
  reason: string | null
  /** 未识别事件条数：> 0 时界面要提示"有本版本不认识的事件"。 */
  unknownCount: number
}

/** 从一行事件里取一个短摘要；只取标量字段，不把对象/数组拼进标题。 */
function shortSummary(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload.length > 120 ? `${payload.slice(0, 120)}…` : payload
  if (typeof payload !== 'object') return String(payload)
  const record = payload as Record<string, unknown>
  for (const key of ['summary', 'message', 'name', 'tool', 'model', 'reason', 'text']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 120 ? `${value.slice(0, 120)}…` : value
    }
  }
  return ''
}

function seqOf(row: RunEventRow): number | null {
  const value = row.seq ?? row.eventSeq
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把一次运行的原始事件投影成 UI 需要的形状。
 *
 * @param rows 接口返回的 `events`；`null` = **没读到**（与空数组语义不同）
 * @param reason 读取失败原因（`rows === null` 时用）
 */
export function runEventsSection(rows: RunEventRow[] | null, reason: string | null = null): RunEventsSection {
  if (rows === null) {
    // ★ 没给原因时也要说一句"这不是没有事件"——`null` 与 `[]` 的区别就是这一句。
    return { state: 'unreadable', events: [], counts: [], reason: reason ?? '未提供原因', unknownCount: 0 }
  }
  const views: RunEventView[] = rows.map((row) => {
    const type = typeof row?.type === 'string' && row.type !== '' ? row.type : '(未声明类型)'
    // ★ 判据①：`known === false` 就是显式不认识；`undefined` 按已知处理（老数据没有这一位）。
    const known = row?.known !== false
    return {
      type,
      label: known ? (RUN_EVENT_LABELS[type] ?? type) : `未识别事件（${type}）`,
      known,
      seq: seqOf(row),
      atMs: typeof row?.atMs === 'number' ? row.atMs : null,
      summary: known ? shortSummary(row?.event ?? row?.payload) : '',
    }
  })
  if (views.length === 0) {
    return { state: 'empty', events: [], counts: [], reason: null, unknownCount: 0 }
  }
  const counter = new Map<string, { label: string; count: number }>()
  for (const view of views) {
    const item = counter.get(view.type) ?? { label: view.label, count: 0 }
    item.count += 1
    counter.set(view.type, item)
  }
  const counts = [...counter.entries()]
    .map(([type, item]) => ({ type, label: item.label, count: item.count }))
    .sort((a, b) => (EVENT_RANK[a.type] ?? 99) - (EVENT_RANK[b.type] ?? 99) || b.count - a.count)
  return {
    state: 'ok',
    events: views,
    counts,
    reason: null,
    unknownCount: views.filter((view) => !view.known).length,
  }
}

/** 折叠状态的一句话摘要：只说**已知为真**的事，不推测。 */
export function runEventsHeadline(section: RunEventsSection): string {
  if (section.state === 'unreadable') return `运行明细读取失败：${section.reason ?? '未提供原因'}`
  if (section.state === 'empty') return '这次运行没有记录到事件'
  const tools = section.counts.find((item) => item.type === 'tool.requested')?.count ?? 0
  const toolFailures = section.counts.find((item) => item.type === 'tool.failed')?.count ?? 0
  const parts = [`${section.events.length} 条事件`]
  if (tools > 0) parts.push(`工具 ${tools} 次`)
  if (toolFailures > 0) parts.push(`其中失败 ${toolFailures} 次`)
  if (section.unknownCount > 0) parts.push(`${section.unknownCount} 条本版本不认识`)
  return parts.join(' · ')
}

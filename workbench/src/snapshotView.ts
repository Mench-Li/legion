/**
 * 上下文快照查看界面（PRT-409 最后一件：spec line 897「支持**查看**和导出」）的
 * **纯判定层**：不碰 DOM、不碰网络，只做归一、判定与文案。
 *
 * ## 为什么单独成模块
 *
 * 这个界面要回答的问题与别处不同：它不是"把一份 JSON 显示出来"，
 * 而是"**让我相信屏幕上这一份就是模型当时看到的**"。所以这里最要紧的
 * 判定全都不是布局问题，而是**可信度问题**：
 *
 *   ① **验证三态必须分开显示。** 后端 `?verify=1` 给 `verification`
 *      （`{ok, storedHash, recomputedHash}`）。把"没验过"与"验过了且通过"
 *      显示成同一个样子，等于把一次未经校验的展示伪装成一次校验过的展示。
 *   ② **裁剪/排除/脱敏三本账都要能看见。** 一份**截断过的**快照
 *      如果只显示正文，用户会以为模型读完了全文——这正是 PRT-407 存在的理由，
 *      而界面是它唯一被看到的地方。
 *   ③ **被清掉的快照不是"没找到"。** hub 给 410 + 墓碑；把 410 渲染成
 *      "无数据"会让一次静默的数据丢失看起来像一次输错 id（PRT-409 收尾的核心）。
 *
 * 抽取成纯函数的理由与 `browserUi.ts` / `filesUi.ts` 一致：
 * 这些判定最容易出现"后端加了码、前端还是笼统提示"，
 * 抽出来后可用 `node --test` 直接钉住。
 *
 * ## 权威在后端
 *
 * 快照内容、哈希、账本、墓碑、保留计划**全部来自 team-hub**。本模块
 * **不重算哈希**：它没有库、没有正文的完整上下文，重算只会得到一个
 * 与后端不一致的第二事实来源。它只**呈现并区分**后端给的两个哈希是否相同。
 */

// ───────────────────────── 类型（与 hub 响应一一对应）─────────────────────────

export interface SnapshotTokens { kind: string; tokens: number }

export interface SnapshotAssociations {
  goalId?: string | null
  taskId?: string | null
  employeeId?: string | null
  teamPlanId?: string | null
}

export interface SnapshotListItem {
  attemptId: string
  runId: string
  scope?: string | null
  associations?: SnapshotAssociations
  frozenAtMs: number
  recordedAtMs: number
  snapshotHash: string
  tokens: SnapshotTokens
  maxTokens?: number | null
  budgetTrimmed: boolean
  candidateCount: number
  includedCount: number
  excludedCount: number
  truncationCount: number
}

export interface SnapshotExclusion { id: string; reason: string; detail?: string }
export interface SnapshotTruncation {
  id: string; keptChars?: number; totalChars?: number; reason?: string; detail?: string
}
export interface SnapshotRedaction { sourceId: string; at: string; why: string }
export interface SnapshotSegment { at: string; from: number; to: number }

export interface SnapshotVerification {
  ok: boolean
  attemptId: string
  storedHash: string
  recomputedHash: string
}

/**
 * 冻结下来的快照本体（hub 的 `snapshot` 字段）。
 *
 * ★ **三本账在这里，不在顶层。** 这是实测出来的，不是猜的：
 * `GET /api/context-snapshots/:id?verify=1` 把
 * `excluded` / `truncations` / `redactions` / `segments` / `finalText`
 * 全部放在 `snapshot.*` 里，顶层只有**计数**（`excludedCount` / `truncationCount`）。
 *
 * 读错层级的后果是**方向性**的：
 *
 *   > 一个"从错误的层级读账本、于是永远读到 `undefined`"的界面，
 *   > 与一个"这份快照确实没有排除任何来源"的界面，长得一模一样——
 *   > 只不过前者会在一次越权过滤之后，向用户显示"来源已完整清点"。
 *
 * 所以下面 `ledgersOf` 会**区分**"键在且是空数组"与"键根本不在"，
 * 后者是契约破裂，必须在屏幕上说出来。
 */
export interface SnapshotBody {
  schemaVersion?: number
  attemptId?: string
  runId?: string
  frozenAtMs?: number
  candidateCount?: number
  sources?: unknown[]
  excluded?: SnapshotExclusion[]
  segments?: SnapshotSegment[]
  truncations?: SnapshotTruncation[]
  redactions?: SnapshotRedaction[]
  redactionSchema?: string
  tokens?: { kind: string; tokens: number; maxTokens?: number | null }
  budget?: { maxTokens?: number | null; trimmed?: boolean }
  finalText?: string
  snapshotHash?: string
}

export interface SnapshotDetail extends SnapshotListItem {
  ok: boolean
  verification: SnapshotVerification
  snapshot: SnapshotBody
  summary?: string
}

export interface SnapshotTombstone {
  attemptId: string
  runId?: string | null
  scope?: string | null
  frozenAtMs: number
  recordedAtMs?: number | null
  purgedAtMs: number
  snapshotHash: string
  bytes: number
  reason: string
  actor: string
}

export interface SnapshotCounts { live: number; purged: number; everRecorded: number }

/** hub 响应归一后的结果。**三种状态**，与后端一致。 */
export type SnapshotFetch =
  | { kind: 'live'; detail: SnapshotDetail }
  | { kind: 'purged'; tombstone: SnapshotTombstone }
  | { kind: 'missing'; attemptId: string }

// ───────────────────────── 取数路径 ─────────────────────────

/**
 * 单份快照的读取路径。
 *
 * ★ `verify=1` **永远**带上，不做成可选参数。一个"默认不验、想看才验"的
 * 查看界面会让绝大多数人看到的是**未被校验过**的内容，而界面上没有任何
 * 东西提示这一点。校验的成本是一次哈希重算，而漏掉它的时候，
 * 一次被篡改的展示与一次正常的展示长得一模一样。
 */
export function snapshotPath(attemptId: string, { verify = true }: { verify?: boolean } = {}): string {
  const id = encodeURIComponent(attemptId)
  return `/api/context-snapshots/${id}${verify ? '?verify=1' : ''}`
}

export function snapshotListPath({ runId, scope, limit }: { runId?: string | null; scope?: string | null; limit?: number } = {}): string {
  const q = new URLSearchParams()
  if (runId) q.set('runId', runId)
  if (scope) q.set('scope', scope)
  if (Number.isInteger(limit)) q.set('limit', String(limit))
  const s = q.toString()
  return `/api/context-snapshots${s ? `?${s}` : ''}`
}

export function tombstonesPath({ limit }: { limit?: number } = {}): string {
  return `/api/context-snapshots/tombstones${Number.isInteger(limit) ? `?limit=${limit}` : ''}`
}

export function exportPath(attemptId: string, { by, atMs, reason }: { by: string; atMs: number; reason?: string }): string {
  const q = new URLSearchParams({ by, atMs: String(atMs) })
  if (reason) q.set('reason', reason)
  return `/api/context-snapshots/${encodeURIComponent(attemptId)}/export?${q}`
}

// ───────────────────────── ① 三态：live / purged / missing ─────────────────────────

/**
 * 把一次读取的 HTTP 结果归一成**三态**。
 *
 * ★ 这是本模块最重要的一条：**410 不是"没找到"**。
 *
 * hub 对"被保留策略清掉"给 410 + `code: 'CONTEXT_SNAPSHOT_PURGED'` + 墓碑，
 * 对"从来没有过"给 404。界面如果把两者都渲染成"无数据"：
 *
 *   > 一次"这份证据被清掉了、我们再也说不出模型当时看到了什么"，
 *   > 与一次"你查错了 id"，在屏幕上长得一模一样——
 *   > 只不过前者需要有人去追问"是谁清的、为什么"，
 *   > 而后者只需要用户重新输入一次。
 */
export function readSnapshotResponse(status: number, body: unknown): SnapshotFetch {
  const b = (body ?? {}) as Record<string, unknown>
  if (status === 200 && b.attemptId !== undefined) {
    return { kind: 'live', detail: b as unknown as SnapshotDetail }
  }
  // 410 优先于 code 判断：状态码是**协议层**的事实，
  // 而一个被中间层改写过的 `code` 不该让界面把 410 当成"没有"。
  if (status === 410 && b.tombstone !== undefined && b.tombstone !== null) {
    return { kind: 'purged', tombstone: b.tombstone as SnapshotTombstone }
  }
  // 兜底：410 但墓碑丢了。**仍然不降级成 missing**——
  // 墓碑缺失是后端的问题，而"存在过"这个事实由状态码确认了。
  if (status === 410) {
    return {
      kind: 'purged',
      tombstone: {
        attemptId: typeof b.attemptId === 'string' ? b.attemptId : '',
        frozenAtMs: NaN,
        purgedAtMs: NaN,
        snapshotHash: '',
        bytes: 0,
        reason: typeof b.error === 'string' ? b.error : '（后端未给出墓碑）',
        actor: '',
      },
    }
  }
  return { kind: 'missing', attemptId: typeof b.attemptId === 'string' ? b.attemptId : '' }
}

// ───────────────────────── ② 验证三态 ─────────────────────────

export type VerifyVerdict = 'unverified' | 'ok' | 'mismatch'

/**
 * 验证结论。**三态**，不是两态。
 *
 * `verification` 缺席时给 `unverified` 而不是 `ok`：
 *
 *   > 一个"没验过"的快照，与一个"验过了且通过"的快照，
 *   > 在只显示一个绿色对勾的界面上是同一个东西——
 *   > 只不过前者会让用户以为有人检查过。
 */
export function verifyVerdict(detail: { verification?: SnapshotVerification | null } | null | undefined): VerifyVerdict {
  const v = detail?.verification
  if (v === null || v === undefined || typeof v.ok !== 'boolean') return 'unverified'
  if (v.ok !== true) return 'mismatch'
  // `ok:true` 但两个哈希字段对不上 → 仍然是 mismatch。
  // 一个"结论说通过、而证据字段互相矛盾"的结果，不能按通过处理。
  if (typeof v.storedHash === 'string' && typeof v.recomputedHash === 'string'
    && v.storedHash !== '' && v.recomputedHash !== '' && v.storedHash !== v.recomputedHash) {
    return 'mismatch'
  }
  return 'ok'
}

export function verifyText(verdict: VerifyVerdict): string {
  if (verdict === 'ok') return '✅ 哈希校验通过：屏幕上的内容与落库时一致'
  if (verdict === 'mismatch') return '⛔ 哈希对不上：这份快照在落库之后被改动过，**不要**把它当作当时的输入'
  return '⚠ 未校验：这次读取没有拿到校验结论，屏幕上是否正确**未知**'
}

/** 短哈希：界面上只需要能**比对**，不需要全文。 */
export function shortHash(hash: string | null | undefined, keep = 12): string {
  if (typeof hash !== 'string' || hash === '') return '—'
  const body = hash.startsWith('sha256:') ? hash.slice(7) : hash
  return `${hash.startsWith('sha256:') ? 'sha256:' : ''}${body.slice(0, keep)}…`
}

// ───────────────────────── ③ 三本账（裁剪/排除/脱敏）─────────────────────────

export interface LedgerView {
  candidates: number
  included: number
  excluded: number
  truncated: number
  redacted: number
  /** 入选 + 排除 是否等于候选数。**不等于就是缺陷**，界面必须说出来。 */
  balanced: boolean
  /** 是否发生了任何"部分包含"。 */
  partial: boolean
  /**
   * ★ 契约是否破裂：`snapshot.excluded` 这类键**根本不在**。
   *
   * 与"键在、值是空数组"是两件完全不同的事：
   * 前者说明我们读错了地方（或后端改了形状），此时屏幕上显示的 0
   * 是**假的 0**；后者才是"真的没有排除任何来源"。
   */
  contractBroken: boolean
}

/** 三本账的原始数组 + 它们是否**真的存在**（而不是被读成了 undefined）。 */
export function ledgersOf(detail: Partial<SnapshotDetail> | null | undefined): {
  excluded: SnapshotExclusion[]; truncations: SnapshotTruncation[]
  redactions: SnapshotRedaction[]; segments: SnapshotSegment[]
  finalText: string; contractBroken: boolean
} {
  const body = detail?.snapshot
  const isArr = (v: unknown): v is unknown[] => Array.isArray(v)
  // ★ 判据是"键在不在"，不是"数组长不长"。
  const contractBroken = body === null || body === undefined
    || !isArr(body.excluded) || !isArr(body.truncations) || !isArr(body.redactions)
  return {
    excluded: isArr(body?.excluded) ? (body.excluded as SnapshotExclusion[]) : [],
    truncations: isArr(body?.truncations) ? (body.truncations as SnapshotTruncation[]) : [],
    redactions: isArr(body?.redactions) ? (body.redactions as SnapshotRedaction[]) : [],
    segments: isArr(body?.segments) ? (body.segments as SnapshotSegment[]) : [],
    finalText: typeof body?.finalText === 'string' ? body.finalText : '',
    contractBroken,
  }
}

/**
 * 把三本账归一成一个可显示的视图。
 *
 * ★ `balanced` 单独算出来并显示，而不是只把三个数字并排：
 * 守恒断言（入选 + 排除 == 候选数）是 PRT-407 的核心不变量。
 * 一份**不守恒**的快照意味着"有来源既没进也没被记账"，
 * 而那正是"模型基于一份不完整的世界观得出结论、而快照上写着来源已完整清点"。
 * 三个数字并排放在屏幕上，看的人是**不会**去做这个加法的。
 *
 * ★ `contractBroken` 同理：读错层级的 0 与真的 0 必须分开。
 */
export function ledgerView(detail: Partial<SnapshotDetail> | null | undefined): LedgerView {
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const led = ledgersOf(detail)
  const candidates = n(detail?.candidateCount)
  const included = n(detail?.includedCount)
  const excluded = n(detail?.excludedCount)
  const truncated = n(detail?.truncationCount)
  return {
    candidates, included, excluded, truncated,
    redacted: led.redactions.length,
    balanced: candidates === included + excluded,
    // "部分包含"是第三种状态：整个进了 / 整个没进 / **进了一部分**。
    // 只看 includedCount 会把第三种读成第一种。
    partial: truncated > 0 || detail?.budgetTrimmed === true,
    contractBroken: led.contractBroken,
  }
}

/** 三本账的人读摘要。 */
export function ledgerText(l: LedgerView): string {
  if (l.contractBroken) {
    return '⛔ 账本读不到：这份快照的响应里没有 `snapshot.excluded`/`truncations`/`redactions`。'
      + '屏幕上显示的 0 是**读错了地方**，不是"真的没有排除"——不要用它判断来源是否完整'
  }
  if (!l.balanced) {
    return `⛔ 账本不守恒：候选 ${l.candidates} ≠ 入选 ${l.included} + 排除 ${l.excluded}`
      + '——有来源既没进也没被记账，这份快照**不能**用来说明"来源已完整清点"'
  }
  const parts = [`候选 ${l.candidates}`, `入选 ${l.included}`, `排除 ${l.excluded}`]
  if (l.truncated > 0) parts.push(`截断 ${l.truncated}`)
  if (l.redacted > 0) parts.push(`脱敏 ${l.redacted}`)
  return parts.join(' · ')
}

export const EXCLUSION_REASON_LABEL: Record<string, string> = {
  unauthorized: '越权：该员工无权读取',
  stale: '过期：已被更新的版本取代',
  'over-budget': '超预算：裁剪后仍放不下',
  redacted: '整条不发：内容整体不可外发',
  missing: '不存在：引用指向的来源查不到',
  'out-of-scope': '不相关：作用域不匹配',
}

export function exclusionLabel(reason: string): string {
  return EXCLUSION_REASON_LABEL[reason] ?? `未知理由：${reason}`
}

/**
 * ★ 未知的排除理由必须**看得出来**，不能被吞成一个通用文案。
 *
 * 理由枚举是后端定义的。前端遇到没见过的值时，如果回落到"其他原因"，
 * 一个新的、可能很重要的排除理由（比如"这份来源被策略禁止外发"）
 * 会在界面上与一句废话等价。
 */
export function unknownReasons(excluded: ReadonlyArray<SnapshotExclusion> | null | undefined): string[] {
  if (!Array.isArray(excluded)) return []
  const seen = new Set<string>()
  for (const e of excluded) {
    if (e === null || typeof e !== 'object') continue
    if (typeof e.reason === 'string' && !Object.hasOwn(EXCLUSION_REASON_LABEL, e.reason)) seen.add(e.reason)
  }
  return [...seen]
}

// ───────────────────────── ④ 正文与分段 ─────────────────────────

export interface SegmentView { at: string; from: number; to: number; chars: number }

/**
 * 分段视图。把 `finalText` 切回去答"第 N 个字符来自哪里"。
 *
 * ★ `chars` 与是否**有缺口**都要算出来：
 * 分段如果有洞（前一段的 `to` 小于后一段的 `from`），那段字符**不属于任何来源**，
 * 而它确实被发给了模型。只把分段列表画出来的界面看不到这个洞。
 */
export function segmentViews(segments: ReadonlyArray<SnapshotSegment> | null | undefined): {
  segments: SegmentView[]; gaps: number; covered: number
} {
  if (!Array.isArray(segments)) return { segments: [], gaps: 0, covered: 0 }
  const out: SegmentView[] = []
  for (const s of segments) {
    if (s === null || typeof s !== 'object') continue
    const from = Number(s.from)
    const to = Number(s.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    out.push({ at: String(s.at ?? ''), from, to, chars: Math.max(0, to - from) })
  }
  out.sort((a, b) => a.from - b.from)
  let gaps = 0
  let covered = 0
  let cursor = 0
  for (const s of out) {
    if (s.from > cursor) gaps += s.from - cursor
    covered += s.chars
    cursor = Math.max(cursor, s.to)
  }
  return { segments: out, gaps, covered }
}

/** 正文预览：超长时截断。**明确说出截断了**，不能让预览看起来是全文。 */
export function textPreview(text: string | null | undefined, limit = 4000): { text: string; truncated: boolean; totalChars: number } {
  const s = typeof text === 'string' ? text : ''
  if (s.length <= limit) return { text: s, truncated: false, totalChars: s.length }
  return { text: s.slice(0, limit), truncated: true, totalChars: s.length }
}

// ───────────────────────── ⑤ 墓碑与保留 ─────────────────────────

export function tombstoneText(t: SnapshotTombstone | null | undefined): string {
  if (t === null || t === undefined) return '（无墓碑）'
  const who = t.actor !== '' ? t.actor : '（未记操作人）'
  const when = Number.isFinite(t.purgedAtMs) ? new Date(t.purgedAtMs).toLocaleString() : '（未记时间）'
  const size = Number.isFinite(t.bytes) ? `${t.bytes} 字节` : '（未记大小）'
  return `这份上下文**存在过**，已被保留策略清理：${who} 于 ${when} 以「${t.reason}」清掉，`
    + `丢掉了 ${size}，内容哈希 ${shortHash(t.snapshotHash)}。`
    + '正文**没有了**——这次的输入已经无法还原。'
}

/**
 * ★ 计数摘要。`everRecorded` 必须显示。
 *
 *   > 一个"清理之后总数下降了"的报表，与一个"证据悄悄丢了"的报表，
 *   > 在只看一个数字的人眼里是同一个东西。
 */
export function countsText(c: SnapshotCounts | null | undefined): string {
  if (c === null || c === undefined) return ''
  const total = Number.isFinite(c.everRecorded) ? c.everRecorded : c.live + c.purged
  return `现存 ${c.live} · 已清理 ${c.purged} · 累计产生 ${total}`
}

export interface RetentionPlanView {
  purgeCount: number
  purgeBytes: number
  keepCount: number
  findingCount: number
  /** 策略是"不设上限"还是"有上限"。 */
  bounded: boolean
}

/**
 * 保留计划视图。`bounded: false` 必须能看出来。
 *
 * 一份"当前没有要清的"报告，在"策略是不设上限"与"策略有上限但恰好没超"两种情况下
 * 数字完全相同——而它们意味着完全不同的未来。
 */
export function retentionView(plan: {
  policy?: { maxAgeDays?: number | null; maxBytes?: number | null }
  purge?: unknown[]
  keepCount?: number
  findings?: unknown[]
  usage?: { purgeBytes?: number }
} | null | undefined): RetentionPlanView {
  const p = plan ?? {}
  const purge = Array.isArray(p.purge) ? p.purge : []
  const findings = Array.isArray(p.findings) ? p.findings : []
  const age = p.policy?.maxAgeDays
  const bytes = p.policy?.maxBytes
  return {
    purgeCount: purge.length,
    purgeBytes: Number.isFinite(Number(p.usage?.purgeBytes)) ? Number(p.usage?.purgeBytes) : 0,
    keepCount: Number.isFinite(Number(p.keepCount)) ? Number(p.keepCount) : 0,
    findingCount: findings.length,
    bounded: age !== null && age !== undefined || bytes !== null && bytes !== undefined,
  }
}

// ───────────────────────── ⑥ 时间与大小 ─────────────────────────

export function relativeTime(atMs: number, nowMs: number): string {
  if (!Number.isFinite(atMs)) return '—'
  const d = nowMs - atMs
  if (d < 0) return '（时间在未来）'
  const min = Math.floor(d / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days} 天前`
  return new Date(atMs).toLocaleDateString()
}

/**
 * 字节数文案。**用字节而不是字符**——与 PRT-409 保留策略同一条纪律：
 * 快照正文大量是中文，UTF-8 下一个汉字 3 字节。
 * 界面上显示"字符数"会让人以为一份 3 MB 的快照只有 1 MB。
 */
export function bytesText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ───────────────────────── ⑦ 列表归一 ─────────────────────────

/**
 * 列表项归一。**哈希缺一不可**：一份没有哈希的列表项在界面上
 * 与一份有哈希的看起来一样，而前者无法用于任何比对。
 */
export function listRows(items: ReadonlyArray<Partial<SnapshotListItem>> | null | undefined, nowMs: number): Array<{
  attemptId: string; runId: string; frozenAt: string; tokens: string; hash: string; flags: string[]
}> {
  if (!Array.isArray(items)) return []
  return items
    .filter((it) => it !== null && typeof it === 'object' && typeof it.attemptId === 'string')
    .map((it) => {
      const flags: string[] = []
      if (it.budgetTrimmed === true) flags.push('已裁剪')
      if (Number(it.truncationCount) > 0) flags.push(`截断 ${it.truncationCount}`)
      if (Number(it.excludedCount) > 0) flags.push(`排除 ${it.excludedCount}`)
      if (typeof it.snapshotHash !== 'string' || it.snapshotHash === '') flags.push('⚠ 缺哈希')
      const max = it.maxTokens
      const tokens = typeof max === 'number' && Number.isFinite(max)
        ? `${it.tokens?.tokens ?? '?'} / ${max} tokens`
        : `${it.tokens?.tokens ?? '?'} tokens`
      return {
        attemptId: it.attemptId,
        runId: typeof it.runId === 'string' ? it.runId : '—',
        frozenAt: relativeTime(Number(it.frozenAtMs), nowMs),
        tokens,
        hash: shortHash(it.snapshotHash),
        flags,
      }
    })
}

/**
 * 该显示哪一屏。
 *
 * ★ `list` / `detail` / `purged` / `missing` 是**四个**屏幕，不是一个。
 * 少一屏就会让两种情况在界面上重合——而这里重合的每一对都意味着
 * 用户会对"这份证据还在不在"得出错误结论。
 */
export type ScreenKind = 'list' | 'detail' | 'purged' | 'missing'

export function screenFor(state: {
  items?: unknown[] | null
  fetch?: SnapshotFetch | null
}): ScreenKind {
  if (state.fetch != null) return state.fetch.kind === 'live' ? 'detail' : state.fetch.kind
  return 'list'
}

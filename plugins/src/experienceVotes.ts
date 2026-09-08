/**
 * 经验草稿置信度晋升管线（P0-3，对齐 docs/research/teamai-cli-review.md §4.3）：
 * 对 4.2 的草稿队列（docs/experience/drafts/<taskId>.md）实现 votes→confidence→promote。
 *
 * 信号与落地（Legion 语境简化，纯函数可单测）：
 *   1. recalled（被后续任务引用）= 本 scope 其它任务的 description/acceptance/comments
 *      显式引用某草稿的源任务 id（如「参考 T-004 经验」「drafts/T-004.md」）。每个任务对
 *      同一草稿只投一次（recalledBy 去重），任务引用自己不计数。
 *   2. upvoted（将军采纳）= by=general 的评论显式采纳语义 + 指向草稿源任务 id
 *      （如「采纳草稿 T-004」「按 T-004 的经验办」「点赞经验草稿 T-004」）。
 *      与 teamai「防幻觉上票」同理：只对显式声明采纳的评论上票，不猜。
 *   3. frontmatter 是状态快照：守护只在新事件存在时增量更新（recalledBy/upvotedBy 记录
 *      已投者防重复），将军手工在 frontmatter 改计数不会被守护覆盖（无事件不动文件）。
 *   4. confidence（参考 teamai confidence.ts，改 30 天衰减）= 0.4·votes + 0.3·recency +
 *      0.3·ratio：votes=min(1, recalled·0.15 + upvoted·0.35)（采纳权重大于引用）；
 *      recency=距最近活动(lastActivityAt)天数 D≤30 线性 1→0；ratio=recalled>0 ? upvoted/recalled : 0。
 *   5. promote 四门槛（全部满足才晋升，防秒升）：
 *        1) 观察窗：草稿落盘 ≥ OBSERVE_DAYS 天；
 *        2) recalled ≥ RECALL_MIN（被 ≥2 个任务引用）；
 *        3) upvoted ≥ UPVOTE_MIN（将军采纳 ≥1）；
 *        4) confidence ≥ CONF_PROMOTE_MIN（0.5）且未被衰减拖垮。
 *      promote 动作（插件挂点执行，本模块只判）：AI 把草稿改写成正式 skill → team-hub
 *      skills register（scope 继承，owner=守护身份）→ status=pending → 将军 review publish
 *      = 最终人工关（服务端门禁，D-2）。草稿原件 frontmatter 记 status: promoted +
 *      promotedTo: <skillId> + promotedAt（溯源；原件不删，正文留链接）。
 *   6. prune 保守版：从未产生任何票（无引用无采纳）且落盘超过 PRUNE_DAYS 天 → status: stale
 *      （标记不删除，供人工复核；有票草稿不自动 stale——团队小时好经验久未被再次用到仍应保留）。
 *
 * 本模块无 I/O、无副作用；node --test 直接单测。
 */

// ── frontmatter 状态模型 ────────────────────────────────────────────────

export type DraftStatus = 'draft' | 'promoted' | 'stale'

export interface DraftState {
  taskId: string
  status: DraftStatus
  friction: number
  recalled: number
  recalledBy: string[]
  upvoted: number
  upvotedBy: string[]
  createdAt: string   // ISO；草稿生成时间
  lastActivityAt: string // ISO；最近一次 recalled/upvoted/落盘
  role: string
  goalId: string
  scope: string
  /** promote 后的正式资产定位（team-hub skill id 或 learning/<taskId>）。 */
  promotedTo: string
  promotedAt: string
  /** 经验形态（P2-①）：'' = 未分类（promote 时启发式判定）；procedure | declarative = 将军/守护显式指定。 */
  kind: '' | 'procedure' | 'declarative'
}

export const DRAFT_STATE_DEFAULTS = {
  status: 'draft',
  friction: 0,
  recalled: 0,
  upvoted: 0,
  role: '',
  goalId: '',
  scope: '',
  promotedTo: '',
  promotedAt: '',
  kind: '',
}

/** 解析草稿 markdown 的 frontmatter（--- 段）→ DraftState（缺字段给默认值，宽容解析）。 */
export function parseDraftState(md: string): DraftState {
  const m = /^---\n([\s\S]*?)\n---/.exec(md ?? '')
  const kv: Record<string, string> = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const eq = line.indexOf(':')
      if (eq <= 0) continue
      kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
  const arr = (v: string | undefined): string[] => {
    if (!v || v === '[]') return []
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? p.map(String) : [String(p)]
    } catch { return v.split(',').map(s => s.trim()).filter(Boolean) }
  }
  const taskId = kv.taskId ?? ''
  return {
    taskId,
    status: (['draft', 'promoted', 'stale'].includes(kv.status) ? kv.status : DRAFT_STATE_DEFAULTS.status) as DraftStatus,
    friction: Number(kv.friction) || 0,
    recalled: Number(kv.recalled) || 0,
    recalledBy: arr(kv.recalledBy),
    upvoted: Number(kv.upvoted) || 0,
    upvotedBy: arr(kv.upvotedBy),
    createdAt: kv.createdAt ?? '',
    lastActivityAt: kv.lastActivityAt ?? kv.createdAt ?? '',
    role: kv.role ?? '',
    goalId: kv.goalId ?? '',
    scope: kv.scope ?? '',
    promotedTo: kv.promotedTo ?? '',
    promotedAt: kv.promotedAt ?? '',
    kind: (['', 'procedure', 'declarative'].includes(kv.kind) ? kv.kind : '') as '' | 'procedure' | 'declarative',
  }
}

/** 把 DraftState 渲染成 frontmatter 段（含尾部 --- 行）。 */
export function renderFrontmatter(s: DraftState): string {
  return [
    '---',
    `taskId: ${s.taskId}`,
    `status: ${s.status}`,
    `friction: ${s.friction.toFixed(2)}`,
    `recalled: ${s.recalled}`,
    `recalledBy: ${JSON.stringify(s.recalledBy)}`,
    `upvoted: ${s.upvoted}`,
    `upvotedBy: ${JSON.stringify(s.upvotedBy)}`,
    `createdAt: ${s.createdAt}`,
    `lastActivityAt: ${s.lastActivityAt}`,
    `role: ${s.role}`,
    `goalId: ${s.goalId}`,
    `scope: ${s.scope}`,
    `promotedTo: ${s.promotedTo}`,
    `promotedAt: ${s.promotedAt}`,
    `kind: ${s.kind ?? ''}`,
    '---',
  ].join('\n')
}

/** 用新 frontmatter 替换草稿 markdown 的旧 frontmatter，正文原样保留。 */
export function replaceFrontmatter(md: string, frontmatter: string): string {
  const rest = (md ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '')
  return `${frontmatter}\n${rest}`
}

// ── 事件识别 ─────────────────────────────────────────────────────────────

/** 任务引用草稿的显式模式：语义词/草稿路径 + 源任务 id。 */
const RECALL_PATTERNS: RegExp[] = [
  /(?:参考|参照|借鉴|复用|按|照|套用|学习|引用|based on)\s*(?:经验草稿|草稿|经验)?\s*(T-\d+)/i,
  /(?:经验草稿|experience\/drafts|drafts)\s*[:\/：]?\s*(T-\d+)/i,
]
/** 将军采纳的显式模式（语义词 + 源任务 id）。 */
const UPVOTE_PATTERNS: RegExp[] = [
  /(?:采纳|采用|点赞|认可|推荐|upvoted?|endorse|appl(y|ied))\s*(?:草稿|经验|经验草稿)?\s*(T-\d+)/i,
]

function extractTaskIds(text: string, patterns: RegExp[]): string[] {
  const out = new Set<string>()
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      // 鲁棒取组：模式里可能有内部捕获（如 appl(y|ied)），收集所有形如 T-xxx 的组
      for (const g of m.slice(1)) {
        if (typeof g === 'string' && /^T-\d+$/.test(g)) out.add(g)
      }
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return [...out]
}

/** 引用文本是否可能指向某任务（宽松命中再精确判定）。 */
export function detectRecalledTaskIds(text: string): string[] {
  return extractTaskIds(text, RECALL_PATTERNS)
}

/** 采纳文本是否可能指向某任务。 */
export function detectUpvotedTaskIds(text: string): string[] {
  return extractTaskIds(text, UPVOTE_PATTERNS)
}

/** 应用 recalled/upvoted 事件（任务 id → 事件者，用于去重）。返回新状态（纯函数）。 */
export interface DraftVoteInput {
  state: DraftState
  recalledByTaskId?: string // 引用者（任务 id，非草稿源任务）
  upvotedBy?: string        // 采纳者身份（将军）
  now?: string              // ISO，活动时间戳；缺省用当前时间
}

export function applyVote(input: DraftVoteInput): DraftState {
  const s = { ...input.state, recalledBy: [...input.state.recalledBy], upvotedBy: [...input.state.upvotedBy] }
  const now = input.now ?? new Date().toISOString()
  let changed = false
  if (input.recalledByTaskId && input.recalledByTaskId !== s.taskId && !s.recalledBy.includes(input.recalledByTaskId)) {
    s.recalledBy.push(input.recalledByTaskId)
    s.recalled += 1
    changed = true
  }
  if (input.upvotedBy && !s.upvotedBy.includes(input.upvotedBy)) {
    s.upvotedBy.push(input.upvotedBy)
    s.upvoted += 1
    changed = true
  }
  if (changed) s.lastActivityAt = now
  return s
}

// ── confidence 与衰减 ────────────────────────────────────────────────────

/** 距 lastActivityAt 的天数（ISO 解析失败按 0）。 */
export function daysSince(iso: string, now: string): number {
  const a = new Date(iso).getTime()
  const b = new Date(now).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, (b - a) / 86400000)
}

/** votes 分量：min(1, recalled·0.15 + upvoted·0.35)。 */
export function votesScore(recalled: number, upvoted: number): number {
  return Math.min(1, recalled * 0.15 + upvoted * 0.35)
}

/** recency 分量：距最近活动 ≤30 天线性 1→0（30 天衰减）。 */
export function recencyScore(iso: string, now: string, halfLifeDays = 30): number {
  const d = daysSince(iso, now)
  if (d >= halfLifeDays) return 0
  return 1 - d / halfLifeDays
}

/** ratio 分量：recalled>0 ? upvoted/recalled : 0（封顶 1）。 */
export function ratioScore(recalled: number, upvoted: number): number {
  if (recalled <= 0) return 0
  return Math.min(1, upvoted / recalled)
}

/** confidence = 0.4·votes + 0.3·recency + 0.3·ratio（参考 teamai confidence.ts，30 天衰减）。 */
export function confidenceOf(s: DraftState, now?: string): number {
  const n = now ?? new Date().toISOString()
  const v = votesScore(s.recalled, s.upvoted)
  const r = recencyScore(s.lastActivityAt, n)
  const q = ratioScore(s.recalled, s.upvoted)
  return 0.4 * v + 0.3 * r + 0.3 * q
}

// ── promote / prune 门槛 ─────────────────────────────────────────────────

export const PROMOTE_GATES = {
  OBSERVE_DAYS: 3,      // 门槛 1：观察窗（防秒升）
  RECALL_MIN: 2,        // 门槛 2：被 ≥2 个任务引用
  UPVOTE_MIN: 1,        // 门槛 3：将军采纳 ≥1
  CONF_PROMOTE_MIN: 0.5, // 门槛 4：confidence ≥ 0.5
}
export const PRUNE_CONF = 0.15
export const PRUNE_DAYS = 90

export interface GateResult {
  promote: boolean
  gates: Array<{ name: string; pass: boolean; detail: string }>
}

/** promote 四门槛判定（全部通过才 promote）。 */
export function shouldPromote(s: DraftState, now?: string): GateResult {
  const n = now ?? new Date().toISOString()
  const age = daysSince(s.createdAt || s.lastActivityAt, n)
  const conf = confidenceOf(s, n)
  const gates = [
    { name: 'observe', pass: age >= PROMOTE_GATES.OBSERVE_DAYS, detail: `观察窗 ${age.toFixed(1)}/${PROMOTE_GATES.OBSERVE_DAYS} 天` },
    { name: 'recalled', pass: s.recalled >= PROMOTE_GATES.RECALL_MIN, detail: `recalled ${s.recalled}/${PROMOTE_GATES.RECALL_MIN}` },
    { name: 'upvoted', pass: s.upvoted >= PROMOTE_GATES.UPVOTE_MIN, detail: `upvoted ${s.upvoted}/${PROMOTE_GATES.UPVOTE_MIN}` },
    { name: 'confidence', pass: conf >= PROMOTE_GATES.CONF_PROMOTE_MIN, detail: `confidence ${conf.toFixed(2)}/${PROMOTE_GATES.CONF_PROMOTE_MIN}` },
  ]
  return { promote: gates.every(g => g.pass), gates }
}

/**
 * prune 判定：从未产生任何票（recalled=0 且 upvoted=0）且落盘超过 PRUNE_DAYS 天 →
 * status: stale（标记不删，供人工复核）。有过真实引用/采纳的草稿不自动 stale——
 * 团队规模小时好经验可能很久才被再次用到，confidence 衰减不应把有票草稿清掉。
 */
export function shouldPrune(s: DraftState, now?: string): boolean {
  if (s.status !== 'draft') return false
  if (s.recalled > 0 || s.upvoted > 0) return false
  const n = now ?? new Date().toISOString()
  const age = daysSince(s.createdAt || s.lastActivityAt, n)
  return age >= PRUNE_DAYS
}

// ── promote 改写：正式 skill 文本（给运行时 AI 改写的提示词/降级模板）──

export const SKILL_ID_PREFIX = 'exp-'
/** taskId 'T-004' → 'exp-t004'（skill id 规则：小写字母开头，可含连字符，≤64；任务 id 内连字符去除）。 */
export function skillIdForTask(taskId: string): string {
  const base = String(taskId).toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${SKILL_ID_PREFIX}${base}`.slice(0, 64)
}

/**
 * 构建「AI 改写正式 skill」的子代理提示词：输入草稿正文 → 输出正式 skill 的
 * name/description/main（SKILL.md 主指引）/cases。运行时由插件挂点喂给轻量子代理
 * （chat-responder 同款通道）；结构对齐 team-hub normalizeBundle。
 */
export function buildPromotePrompt(draftTaskId: string, draftBody: string): string {
  return [
    `把下面的「经验草稿」改写成团队正式技能（skill），供之后给士兵 worker 注入提示词复用。`,
    ``,
    `草稿来源任务：${draftTaskId}`,
    ``,
    `要求：`,
    `1. name：≤40 字的中文技能名（概括这条经验，如「跨模块自动合入冲突调解」「浏览器 GUI 切片测试冒烟」）；`,
    `2. description：一句话说明何时用这条技能（≤120 字）；`,
    `3. main：正式 SKILL.md 主指引——从草稿的将军评语/evidence 提炼「做法/检查点/注意事项」，写成可执行的步骤式文本，`,
    `   不编造草稿里没有的事实；如果草稿主要是「某任务反复失败」的教训，就写「遇到 X 时先检查 Y」式避坑指引；`,
    `4. cases：1-2 条引用草稿 evidence 的具体例子（何时适用/预期结果）；`,
    `5. 输出为 JSON：{"name": string, "description": string, "main": string, "cases": [string]}。`,
    ``,
    `===== 草稿正文 =====`,
    ``,
    (draftBody ?? '').slice(0, 6000),
  ].join('\n')
}

/** 降级模板：子代理不可用时用草稿原文组装正式 skill（保底 promote，保证溯源不断链）。 */
export function fallbackSkill(draftTaskId: string, s: DraftState, draftBody: string): { name: string; description: string; main: string; cases: string[] } {
  const title = /^# 经验草稿：\S+\s+(.+)$/m.exec(draftBody)?.[1]?.trim() ?? `经验：${draftTaskId}`
  return {
    name: title.slice(0, 40),
    description: `源自任务 ${draftTaskId} 的团队经验（自动 promote，待将军 review）。`,
    main: (draftBody ?? '').slice(0, 5000),
    cases: [],
  }
}

// ── P2-① 经验形态分流：procedure（→skill）/ declarative（→learnings 条目）──
// 方案：docs/research/teamai-cli-review.md §4.5 + 将军 P2 立项。经验不止「怎么做」；
// 大量摩擦经验是陈述性知识（决策理由/背景事实/坑的成因），硬塞 SKILL.md 会丢语义。
// 判定：草稿 frontmatter kind 字段（将军/守护显式指定）优先；未分类用启发式
//   classifyDraftKind（步骤式 marker 权重 vs 陈述式 marker），可单测、确定性。
// 出口：procedure → team-hub skill（register 现有路径）；declarative → docs/experience/learnings/。

/** 步骤式 marker（出现 = 偏 procedure）。 */
const PROCEDURE_MARKERS = [
  '做法', '步骤', '检查点', '注意事项', '先检查', '先核对', '流程', '命令', '复现', '验证方式', '操作',
  'run', 'typecheck', 'build', 'test', '执行', '按以下', 'step', 'when', 'if ',
]
/** 陈述式 marker（出现 = 偏 declarative）。 */
const DECLARATIVE_MARKERS = [
  '原因', '背景', '决策', '为什么', '教训', '结论', '权衡', '上下文', '上下文', '历史', '演进', '经验',
  '坑', '失败', '反复', '根因', '猜测', '不一致', '遗留', '可选', '备注', '说明', '选择理由',
]

/** 形态判定：draftBody 文本 → 'procedure' | 'declarative'。确定性、无 I/O。 */
export function classifyDraftKind(draftBody: string): 'procedure' | 'declarative' {
  const body = String(draftBody ?? '')
  const proc = PROCEDURE_MARKERS.filter((m) => body.toLowerCase().includes(m.toLowerCase())).length
  const decl = DECLARATIVE_MARKERS.filter((m) => body.toLowerCase().includes(m.toLowerCase())).length
  if (proc > decl) return 'procedure'
  if (decl > proc) return 'declarative'
  // 平局：默认 procedure（skill 是现状默认出口，宁保守不把可复用做法埋进只读 learnings）
  return 'procedure'
}

/** 综合判定：草稿显式 kind（frontmatter）优先，否则启发式。 */
export function resolveKind(s: Pick<DraftState, 'kind'>, draftBody: string): 'procedure' | 'declarative' {
  if (s.kind === 'procedure' || s.kind === 'declarative') return s.kind
  return classifyDraftKind(draftBody)
}

/** declarative 经验落盘文件名（docs/experience/learnings/<taskId>.md）。 */
export function learningIdForTask(taskId: string): string {
  return `learning-${String(taskId).toLowerCase().replace(/[^a-z0-9]/g, '')}`
}

/** 构建「AI 改写陈述性经验条目」的子代理提示词：输入草稿 → 输出结构化的 learning 正文（markdown）。 */
export function buildLearningPrompt(draftTaskId: string, draftBody: string): string {
  return [
    `把下面的「经验草稿」提炼成一条团队经验记录（learning），落档供后续任务检索参考。`,
    ``,
    `草稿来源任务：${draftTaskId}`,
    ``,
    `这条经验被判定为「陈述性/决策类」而非可步骤化的技能——请按此提炼，不要硬编成操作步骤：`,
    `要求：`,
    `1. 标题：≤40 字，概括这条经验（如「跨 space 技能授权用 scope: 前缀的教训」「集成回归空转的根因」）；`,
    `2. 背景/起因：为什么会有这条经验（一句话交代任务上下文）；`,
    `3. 结论/教训：这条经验的核心陈述（决策理由 / 坑的成因 / 事实性结论）——只写草稿里有依据的；`,
    `4. 适用场景：后续什么情况下该想起这条经验（何时参考、何时不参考）；`,
    `5. 溯源：末尾附「源自任务 ${draftTaskId}」。`,
    `6. 输出为一段 markdown 正文（不要 JSON，不要代码围栏包全文），按 ## 分节。`,
    ``,
    `===== 草稿正文 =====`,
    ``,
    (draftBody ?? '').slice(0, 6000),
  ].join('\n')
}

/** declarative 落盘 markdown：frontmatter（kind:declarative + 溯源）+ AI 提炼正文。 */
export function renderLearningFile(opts: {
  taskId: string
  scope: string
  role: string
  goalId: string
  createdAt: string
  promotedAt: string
  body: string
}): string {
  const fm = [
    '---',
    `taskId: ${opts.taskId}`,
    'kind: declarative',
    'status: learning',
    `scope: ${opts.scope}`,
    `role: ${opts.role}`,
    `goalId: ${opts.goalId}`,
    `createdAt: ${opts.createdAt}`,
    `promotedAt: ${opts.promotedAt}`,
    '---',
  ].join('\n')
  return `${fm}\n\n${String(opts.body ?? '').trim()}\n`
}

/** 降级模板：子代理不可用时用草稿原文的「将军评语/evidence」段做 learning 正文（保底，溯源不断）。 */
export function fallbackLearning(draftTaskId: string, draftBody: string): string {
  const title = /^# 经验草稿：\S+\s+(.+)$/m.exec(draftBody)?.[1]?.trim() ?? `经验：${draftTaskId}`
  const stripped = String(draftBody ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '')
  return `## ${title}\n\n${stripped.slice(0, 5000)}\n\n---\n\n源自任务 ${draftTaskId}（自动 promote 降级模板，待将军复核）。`
}

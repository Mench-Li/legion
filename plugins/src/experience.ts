/**
 * 任务级经验沉淀（P0-2，对齐 docs/research/teamai-cli-review.md §4.2）：
 * 守护在任务被将军验收 done 时结算 friction 打分；高分任务自动生成
 * “经验草稿”（将军评语 + 关键 evidence 摘录），进「待晋升」队列
 * （docs/experience/drafts/<taskId>.md，复用 evidence 目录的文档约定）。
 *
 * 规则（对齐真实 hub 评论形态，纯函数可单测）：
 *   1. friction 信号从任务快照的 comments 提取——hub 把打回/验收/失败全记成
 *      {by, at, text} 评论，因此无需额外状态即可还原任务经历的摩擦轮次：
 *        - rework（打回轮）：将军/他人评论含「退回」「打回」语义，或守护
 *          「⚠ worker 未完成/超时/派工失败」重试轮——每出现一次计 1；
 *        - reviewRounds（验收轮）：提交 in_review 的次数（「完成并提交验收」
 *          「请将军人工验收」「切片测试完成」等每轮各一次）；
 *        - gateRounds（将军验收轮）：含「请将军人工验收」的评论数；
 *        - generalNotes（将军纠正/评语）：by === 'general' 的非空评论数；
 *        - artifactMiss（缺料）：评论含「缺失产出文档/缺少产物/未找到要求交付」。
 *   2. friction 分 = 各信号加权的实数；≥ FRICTION_DRAFT_MIN 的任务进入草稿，
 *      且必须带将军评语或有真实摩擦（纯自动流水线顺滑任务不产草稿）。
 *   3. 草稿正文 = frontmatter（friction/信号明细/source 溯源）+ 将军评语 +
 *      任务要点 + 证据摘录 + 待晋升提示。草稿文件不覆盖已有文件（幂等，防
 *      打回期间重复结算重复落盘）。
 *   4. 晋升（P0-3）由草稿队列消费：recalled/upvoted 计数写入 frontmatter，
 *      promote 后原件留溯源链接。本模块只负责打分与草稿生成。
 *
 * 本模块无 I/O、无副作用；node --test 直接单测（对齐 norms.ts 风格）。
 */

export interface ExpComment {
  by: string
  at: string
  text: string
}

export interface ExpTaskInput {
  id: string
  title: string
  description: string
  role: string | null
  soldier: string | null
  goalId?: string | null
  scope?: string
  /** 任务当前 status（守护仅在 status === 'done' 时结算）。 */
  status: string
  comments: ExpComment[]
  /** evidence 字段文本数组（hub evidence JSON），供草稿摘录。 */
  evidence?: Array<{ by: string; at: string; text: string }>
  /** 已登记产物相对路径（artifacts），写入草稿 sources 区。 */
  artifacts?: Array<{ by?: string; kind?: string; path?: string; title?: string }>
}

export interface FrictionSignals {
  /** 将军/他人退回或 worker 失败重试轮数（打回轮）。 */
  rework: number
  /** 提交 in_review 的轮数。 */
  reviewRounds: number
  /** 含「请将军人工验收」的闸门轮数（将军验收点）。 */
  gateRounds: number
  /** by === 'general' 的非空评论数（将军评语/纠正）。 */
  generalNotes: number
  /** 缺产出文档的提示轮数。 */
  artifactMiss: number
  /** 归一的 friction 分（见 frictionScore）。 */
  score: number
  /** 将军评语原文（末条 general 评论，草稿用）。 */
  generalQuote: string
}

/** 将军身份别名（hub 写 by 用 general；taskctl 旧数据可能为中文名）。 */
const GENERAL_BYS = new Set(['general', '将军'])

/** 提交验收 / 闸门提交标记（每轮一次，据此数 reviewRounds）。 */
const SUBMIT_MARKERS: RegExp[] = [
  /完成并提交验收/,
  /请将军人工验收/,
  /切片测试完成/,
  /已提交验收/,
]
/** 完成评论里的证据段标记（草稿摘录“关键 evidence”用——legion 惯例把证据写在完成评论里而非 evidence 列）。 */
const EVIDENCE_PREFIX_MARKERS: RegExp[] = [
  /证据[：:]/,
  /证据与输出/,
  /命令与输出要点/,
]
/** 打回/重做 / 失败重试标记。 */
const REWORK_MARKERS: RegExp[] = [
  /^退回[：:]/,
  /打回/,
  /退回并附原因/,
  /worker 未完成/,
  /worker 超时/,
  /派工失败/,
  /请修订/,
]
/** 将军验收/合入标记（gate 人工介入正向信号，不计摩擦但记轮次）。 */
const GATE_ACCEPT_MARKERS: RegExp[] = [
  /将军验收/,
  /将军人工合入/,
  /将军合入/,
]
/** 缺产出文档提示。 */
const MISS_MARKERS: RegExp[] = [
  /缺失产出文档/,
  /缺少产物文档/,
  /未找到要求交付/,
  /契约产出文档缺失/,
]

function countMatches(texts: string[], markers: RegExp[]): number {
  let n = 0
  for (const t of texts) {
    if (markers.some((m) => m.test(t))) n += 1
  }
  return n
}

/**
 * 从任务快照提取 friction 信号。纯函数。
 */
export function collectSignals(task: ExpTaskInput): FrictionSignals {
  const comments = Array.isArray(task.comments) ? task.comments : []
  const texts = comments.map((c) => String(c.text ?? ''))
  const generalTexts = comments.filter((c) => GENERAL_BYS.has(String(c.by))).map((c) => String(c.text ?? '').trim()).filter((t) => t.length > 0)

  const rework = countMatches(texts, REWORK_MARKERS)
  const reviewRounds = countMatches(texts, SUBMIT_MARKERS)
  const gateRounds = countMatches(texts, GATE_ACCEPT_MARKERS)
  const generalNotes = generalTexts.length
  const artifactMiss = countMatches(texts, MISS_MARKERS)

  const score = frictionScore({ rework, reviewRounds, gateRounds, generalNotes, artifactMiss })
  return {
    rework,
    reviewRounds,
    gateRounds,
    generalNotes,
    artifactMiss,
    score,
    generalQuote: generalTexts.length > 0 ? generalTexts[generalTexts.length - 1] : '',
  }
}

/** 各信号权重（经验曲线，可后续经 env 微调；当前为设计初值）。 */
export const FRICTION_WEIGHTS = {
  rework: 2.0,
  reviewRounds: 0.5, // 多轮验收说明有往返，但机器闸门也计轮，权重低
  gateRounds: 1.0,   // 将军亲自验收 = 有人工确认价值
  generalNotes: 1.5, // 将军评语/纠正 = 最有沉淀价值的信号
  artifactMiss: 1.0,
}

/**
 * 各信号计入分数的封顶值。早期守护（配置期噪音/热循环 bug）会给单任务灌入几十上百条
 * 「⚠ worker 未完成」评论（实测 T-110=87、T-113=76），线性累加会让个别任务分爆表、
 * 淹没分布、也让「失败多轮」与「失败一轮」在语义上失去区分（超过 N 轮已足够说明
 * 该任务有坑，再多不加分）。cap 语义：超过 N 轮按 N 计。
 */
export const FRICTION_CAPS = {
  rework: 3,
  reviewRounds: 3,
  gateRounds: 3,
  generalNotes: 3,
  artifactMiss: 3,
}

export interface FrictionParts { rework: number; reviewRounds: number; gateRounds: number; generalNotes: number; artifactMiss: number }

function capped(s: FrictionParts): FrictionParts {
  return {
    rework: Math.min(s.rework, FRICTION_CAPS.rework),
    reviewRounds: Math.min(s.reviewRounds, FRICTION_CAPS.reviewRounds),
    gateRounds: Math.min(s.gateRounds, FRICTION_CAPS.gateRounds),
    generalNotes: Math.min(s.generalNotes, FRICTION_CAPS.generalNotes),
    artifactMiss: Math.min(s.artifactMiss, FRICTION_CAPS.artifactMiss),
  }
}

/** 展示/落盘用的封顶后明细（草稿 frontmatter 不写 87 这种爆表原始值，写封顶后语义值）。 */
export function cappedParts(s: FrictionParts): FrictionParts {
  return capped(s)
}

/** friction 分 = Σ 信号 × 权重（信号先按 FRICTION_CAPS 封顶）；≥ DRAFT_MIN 进入草稿候选。 */
export function frictionScore(s: FrictionParts): number {
  const c = capped(s)
  return (
    c.rework * FRICTION_WEIGHTS.rework +
    c.reviewRounds * FRICTION_WEIGHTS.reviewRounds +
    c.gateRounds * FRICTION_WEIGHTS.gateRounds +
    c.generalNotes * FRICTION_WEIGHTS.generalNotes +
    c.artifactMiss * FRICTION_WEIGHTS.artifactMiss
  )
}

/** 进入草稿的最低分（将军验收 + 评语 ≈ 3.0 即达线；纯机器闸门 0 分不产）。 */
export const FRICTION_DRAFT_MIN = 3.0

/** 草稿内容预算（防 evidence 过长撑爆文件；将军评语完整保留）。 */
export const DRAFT_QUOTE_MAX = 1200
export const DRAFT_BODY_MAX = 4000

export function clampText(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length <= n ? t : `${t.slice(0, n)}\n…（已截断，原文 ${t.length} 字）`
}

function evidenceTextOf(task: ExpTaskInput): string {
  const parts: string[] = []
  // 1) evidence 列（hub evidence JSON；实际使用少，但保留）
  const ev = Array.isArray(task.evidence) ? task.evidence : []
  for (const e of ev.slice(-5)) {
    const txt = String(e.text ?? '').trim()
    if (!txt) continue
    parts.push(`- ${clampText(txt, 600)}`)
  }
  // 2) 完成评论里的证据段（legion 实际惯例：worker 在提交验收评论里写「证据：…」）。
  //    取最后一条含证据标记的完成评论，把证据标记之后的部分摘录为关键 evidence。
  const comments = Array.isArray(task.comments) ? task.comments : []
  for (let i = comments.length - 1; i >= 0; i--) {
    const txt = String(comments[i].text ?? '')
    if (!SUBMIT_MARKERS.some((m) => m.test(txt))) continue
    const evm = EVIDENCE_PREFIX_MARKERS.map((m) => m.exec(txt)).find((x) => x !== null)
    if (!evm) continue
    const after = txt.slice((evm.index ?? 0) + evm[0].length).trim()
    if (after.length > 0) {
      parts.push(`- ${clampText(after, 600)}`)
      break // 只摘最近一轮完成评论的证据段
    }
  }
  return parts.length > 0 ? parts.join('\n') : ''
}

function artifactListOf(task: ExpTaskInput): string {
  const arts = Array.isArray(task.artifacts) ? task.artifacts : []
  const paths = arts
    .map((a) => String(a.path ?? '').trim())
    .filter((p) => p.length > 0 && !p.startsWith('http'))
  if (paths.length === 0) return ''
  const uniq = [...new Set(paths)].slice(0, 12)
  return uniq.map((p) => `- ${p}`).join('\n')
}

function frontmatterOf(task: ExpTaskInput, sig: FrictionSignals, meta?: { createdAt?: string }): string {
  const role = task.role ?? task.soldier ?? ''
  const c = cappedParts(sig)
  const createdAt = meta?.createdAt ?? ''
  const lastActivityAt = createdAt
  return [
    '---',
    `taskId: ${task.id}`,
    `status: draft`,
    `friction: ${sig.score.toFixed(2)}`,
    'recalled: 0',
    'recalledBy: []',
    'upvoted: 0',
    'upvotedBy: []',
    `createdAt: ${createdAt}`,
    `lastActivityAt: ${lastActivityAt}`,
    `role: ${role}`,
    `goalId: ${task.goalId ?? ''}`,
    `scope: ${task.scope ?? ''}`,
    `rework: ${c.rework}`,
    `reviewRounds: ${c.reviewRounds}`,
    `gateRounds: ${c.gateRounds}`,
    `generalNotes: ${c.generalNotes}`,
    'kind: ',
    '---',
  ].join('\n')
}

/** 判断任务是否应进入经验草稿。 */
export function shouldDraft(task: ExpTaskInput, sig: FrictionSignals): boolean {
  if (sig.score < FRICTION_DRAFT_MIN) return false
  // 必须有真实摩擦或将军介入：纯自动流水线（机器闸门一把过、无将军评语）不产草稿
  if (sig.generalNotes === 0 && sig.rework === 0 && sig.artifactMiss === 0 && sig.gateRounds === 0) return false
  // 无将军介入的纯机制摩擦：只有 worker 反复失败（≥3 轮）才值得沉淀——
  // 1-2 轮失败多为环境偶发，写成草稿是噪音（实测 T-080/T-107 类）
  if (sig.generalNotes === 0 && sig.gateRounds === 0 && sig.rework < 3) return false
  return true
}

/**
 * 生成经验草稿 markdown（不写盘，落盘由调用方控制）。
 * 草稿只含任务快照里已有的信息，不调用模型——将军评语原文 + evidence 摘录
 * 已足够支撑待晋升队列的人工/机器复审（P0-3 的 AI 改写放在 promote 时做）。
 * meta.createdAt：落盘时间 ISO（守护结算时传入）；不传则留空（纯函数/幂等单测）。
 */
export function buildDraft(task: ExpTaskInput, sig: FrictionSignals, meta?: { createdAt?: string }): string {
  const quote = sig.generalQuote ? clampText(sig.generalQuote, DRAFT_QUOTE_MAX) : '（无将军评语）'
  const ev = evidenceTextOf(task)
  const arts = artifactListOf(task)
  const lines: string[] = []
  lines.push(frontmatterOf(task, sig, meta))
  lines.push('')
  lines.push(`# 经验草稿：${task.id} ${task.title}`)
  lines.push('')
  lines.push('> 自动生成（守护 done 结算，friction 打分）：本任务是「待晋升」队列草稿，')
  lines.push('> 未经复审。P0-3 晋升管线将据此做 recalled/upvoted 统计与 AI 改写。')
  lines.push('')
  lines.push(`- friction: **${sig.score.toFixed(2)}**（阈值 ${FRICTION_DRAFT_MIN}）`)
  const c = cappedParts(sig)
  lines.push(`- 打回轮 ${c.rework} / 验收轮 ${c.reviewRounds} / 将军验收 ${c.gateRounds} / 将军评语 ${c.generalNotes} / 缺料 ${c.artifactMiss}`)
  lines.push(`- 角色：${task.role ?? task.soldier ?? '（未标注）'}${task.goalId ? `　目标：${task.goalId}` : ''}`)
  lines.push('')
  lines.push('## 将军评语')
  lines.push('')
  lines.push(quote)
  if (ev) {
    lines.push('')
    lines.push('## 关键 evidence（摘录）')
    lines.push('')
    lines.push(ev)
  }
  if (arts) {
    lines.push('')
    lines.push('## 产出物（登记 artifacts）')
    lines.push('')
    lines.push(arts)
  }
  lines.push('')
  lines.push('## 待晋升')
  lines.push('')
  lines.push('- [ ] 人工复审（将军/复审者确认值得沉淀为团队经验）')
  lines.push('- [ ] 被后续任务引用（recalled）或将军采纳（upvoted）后由 P0-3 管线提升置信度')
  lines.push('- [ ] 达到晋升门槛后 AI 改写为正式 skill/rule，原件此处留溯源链接')
  return lines.join('\n')
}

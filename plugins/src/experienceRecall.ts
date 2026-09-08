/**
 * 经验自动召回（P2-③，对齐 docs/research/teamai-cli-review.md §4.5 + 将军 P2 立项）：
 * 守护派工时对任务文本做轻量检索，把最相关的经验草稿/learnings 段注入士兵提示词，
 * 并按「注入 = 一次真实召回」给草稿记 recalled（喂回 P0-3 晋升管线，解决真实语料
 * recalled 信号稀缺——后续任务几乎不会主动写「参考 T-xxx」，但派工时自动带上的
 * 相关经验是真实发生的复用，应计入信号）。
 *
 * 纯逻辑、无 I/O、无副作用；node --test 直接单测。
 *
 * 检索：复用 kb-recall 的取舍（标题×3/正文×1 + IDF + 长度归一），但守护内嵌自含
 * （不依赖 kb-recall preset 存在）：CJK 用 Intl.Segmenter + 相邻双字，英文 camelCase 拆分。
 */

// ── 分词（与 kb-recall 同款但自含）────────────────────────────────────────

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u
const WS_RE = /[\s\u3000]+/u

let _segmenter: Intl.Segmenter | null | undefined
function segWords(text: string): string[] {
  if (_segmenter === undefined) {
    _segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
      ? new Intl.Segmenter('zh', { granularity: 'word' })
      : null
  }
  const out: string[] = []
  if (_segmenter) {
    const segs = [..._segmenter.segment(text)].map((x) => x.segment)
    let i = 0
    while (i < segs.length) {
      const s = segs[i]
      if (!CJK_RE.test(s)) { i++; continue }
      if ([...s].length >= 2) { out.push(s.trim()); i++; continue }
      const run: string[] = []
      while (i < segs.length && CJK_RE.test(segs[i]) && [...segs[i]].length === 1) {
        run.push(segs[i]); i++
      }
      if (run.length === 1) out.push(run[0])
      else {
        for (let k = 0; k + 1 < run.length; k++) out.push(run[k] + run[k + 1])
      }
    }
    return out
  }
  const chars = [...text]
  if (chars.length === 1) { if (CJK_RE.test(chars[0])) out.push(chars[0]) }
  for (let i = 0; i + 1 < chars.length; i++) {
    if (CJK_RE.test(chars[i]) && CJK_RE.test(chars[i + 1])) out.push(chars[i] + chars[i + 1])
  }
  return out
}

function camelWords(s: string): string[] {
  const out: string[] = []
  for (const part of s.split(/[^a-zA-Z0-9]+/u)) {
    if (!part) continue
    // camelCase / PascalCase 拆分：getUserById → get/user/by/id
    for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])/u).map((x) => x.toLowerCase())) {
      if (w.length > 1) out.push(w)
      if (w.length === 1) continue // 单个字母是噪音
    }
    if (part.toLowerCase().length > 1) out.push(part.toLowerCase())
  }
  return out
}

/** 全量分词（去重保序）：CJK 词/双字 + 英文小写词/camel 拆分。 */
export function recallTokens(text: string): string[] {
  const seen = new Set<string>()
  const add = (w: string) => { if (w && w.length > 0) seen.add(w) }
  for (const part of String(text ?? '').split(WS_RE)) {
    if (!part) continue
    const hasCjk = CJK_RE.test(part)
    const ascii = part.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    for (const w of camelWords(ascii)) add(w)
    if (hasCjk) {
      const cjkRun = part.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, ' ')
      for (const w of cjkRun.split(/\s+/)) {
        if (!w) continue
        for (const seg of segWords(w)) add(seg)
      }
    }
  }
  return [...seen]
}

// ── 语料面 ────────────────────────────────────────────────────────────────

/** 召回语料单元：一条经验草稿或 learning 资产。 */
export interface RecallDoc {
  /** 源任务 id（草稿 taskId），如 T-092。 */
  taskId: string
  /** 资产类型：draft（待晋升草稿）| learning（declarative 资产）。 */
  kind: 'draft' | 'learning'
  /** 展示标题（草稿名/学习条目名）。 */
  title: string
  /** 检索正文（草稿将军评语/evidence 或 learning 提炼正文）。 */
  body: string
  /** 源目标 id（草稿 goalId）——同目标兄弟任务命中只注入提示词不计 recalled。 */
  goalId?: string
}

/** 计算每条语料与查询词的加权命中分（标题词×3 / 正文×1，IDF，按词频封顶 4）。 */
export function scoreRecall(queryTokens: string[], docs: RecallDoc[]): Array<{ doc: RecallDoc; score: number; hit: string[] }> {
  const N = Math.max(1, docs.length)
  const present = new Map(queryTokens.map((t) => [t, 0]))
  const docTf = docs.map(() => new Map(queryTokens.map((t) => [t, 0])))
  docs.forEach((doc, di) => {
    const countHit = (words: string[], mult: number) => {
      const local = new Map<string, number>()
      for (const w of words) local.set(w, (local.get(w) || 0) + 1)
      for (const [w, c] of local) {
        if (!present.has(w)) continue
        const tf = (docTf[di].get(w) || 0) + Math.min(c, 4) * mult
        docTf[di].set(w, tf)
        present.set(w, (present.get(w) || 0) + 1)
      }
    }
    countHit(recallTokens(doc.title), 3)
    countHit(recallTokens(doc.body || ''), 1)
  })
  const idf = new Map<string, number>()
  for (const t of queryTokens) idf.set(t, Math.log((N + 1) / ((present.get(t) || 0) + 1)) + 1)
  const scored = docs.map((doc, di) => {
    let sum = 0
    const hit: string[] = []
    for (const t of queryTokens) {
      const tf = docTf[di].get(t) || 0
      if (tf > 0) { sum += tf * (idf.get(t) || 0); hit.push(t) }
    }
    return { doc, score: queryTokens.length ? sum / Math.sqrt(queryTokens.length) : 0, hit }
  })
  return scored
}

// ── 召回阈值与选择 ────────────────────────────────────────────────────────

/** 默认召回门槛：命中分低于此不注入（防噪音上票）。 */
export const RECALL_SCORE_MIN = 2.0
/** 每任务最多注入的草稿数。 */
export const RECALL_TOP_N = 3

export interface RecallPick {
  doc: RecallDoc
  score: number
}

/** 从语料中选出值得注入的相关经验（≥阈值、top-N、至少 1 个命中词）。 */
export function pickRecall(taskText: string, docs: RecallDoc[], opts?: { minScore?: number; topN?: number }): RecallPick[] {
  const minScore = opts?.minScore ?? RECALL_SCORE_MIN
  const topN = opts?.topN ?? RECALL_TOP_N
  const terms = recallTokens(taskText)
  if (terms.length === 0) return []
  const scored = scoreRecall(terms, docs)
  return scored
    .filter((s) => s.score >= minScore && s.hit.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => ({ doc: s.doc, score: s.score }))
}

// ── 注入段渲染 ────────────────────────────────────────────────────────────

/** 渲染「相关团队经验」注入段（士兵提示词用）。无命中返回 null。 */
export function renderRecallSection(picks: RecallPick[]): string | null {
  if (picks.length === 0) return null
  const lines = [
    '相关团队经验（自动召回，P2：来自历史任务的真实摩擦沉淀。若与本任务相关请参考其做法/避坑点，并在报告 evidence 中注明参考了哪条；无关则忽略，不要硬套）：',
    ...picks.map((p) => {
      const label = p.doc.kind === 'learning' ? '经验条目(learning)' : '经验草稿'
      const hint = p.doc.body ? p.doc.body.replace(/\s+/g, ' ').slice(0, 200) : ''
      return `- ${label} ${p.doc.taskId}「${p.doc.title}」（相关度 ${p.score.toFixed(1)}）${hint ? `：${hint}…` : ''}`
    }),
  ]
  return lines.join('\n')
}

/**
 * 可计 recalled 的命中集（P2-③ 防模板噪音）：注入段可包含全部命中（供士兵参考），
 * 但「注入 = 一次真实召回」只对**跨目标**的命中计数——同目标兄弟任务的描述/文案高度
 * 相似（同一目标的拆解/用例/编码/审查/测试/部署链），是流水线常态而非"经验被再次发现"；
 * 计入会把 recalled 信号污染成模板重复。自引用（同任务 id）一律排除。
 * @returns {RecallPick[]} 计入 recalled 的命中子集
 */
export function countableRefs(picks: RecallPick[], taskId: string, taskGoalId?: string | null): RecallPick[] {
  return picks.filter((p) => {
    if (p.doc.taskId === taskId) return false // 自引用
    const sameGoal = taskGoalId != null && taskGoalId !== '' && p.doc.goalId != null && p.doc.goalId === taskGoalId
    return !sameGoal
  })
}

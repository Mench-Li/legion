/**
 * 规则资产治理（P1-4.4，对齐 docs/research/teamai-cli-review.md §4.4 + §2.2 协议）：
 * 把 Legion 现有规则注入源（repo 文件族 LEGION.md/AGENTS.md/agent.md + team-hub 全局层）
 * 作为"目录资产"治理：desired-set 收敛 + tombstone 停用 + marker 所有权 + doctor 校验
 * "每条规则是否真的进了士兵提示词"。
 *
 * 语义（对应 teamai §2.2）：
 *   1. desired-set = 注入源文件族 + 全局层文本，各自解析成**规则单元**（按 `## 标题` 切分，
 *      与 norms.ts 注入产物同构；无二级标题的整文件视为一个单元）。将军加规则=加一段，
 *      删规则=删一段，git 历史即资产版本化（现状已满足，本模块负责可观测化）。
 *   2. tombstone：仓库根 `.legion-norms-removed`（每行一个注入源文件名，`#` 注释/空行跳过）——
 *      停用某注入源（保留 git 文件但不再注入），与 teamai `<type>/.removed` 语义一致。
 *   3. marker 所有权：norms.ts 注入产物自带来源锚点——空间层每文件段首
 *      `【来源：仓库文件 X】`、全局层段首 `全局规范（必须遵守…）：`。doctor 按这些 marker
 *      逐源校验"该源的规则单元是否完整出现在注入文本"（不被预算截断吞掉）。
 *   4. doctor：对每个 desired 规则单元做归一化包含校验（标题 + 单元首部出现在注入文本），
 *      报告 present/missing；missing = 规则被预算截断或分层逻辑剔除 → 将军可见地发现
 *      "我的规则没进士兵提示词"（对应 DSH 的 preset mount 诊断）。
 *
 * 纯函数、无 I/O，可 node --test 直接单测 + golden 字节测试。
 */

export interface NormUnit {
  /** 归属注入源（LEGION.md / AGENTS.md / agent.md / global）。 */
  source: string
  /** 规则单元标题（`## ` 之后文本；无标题时取前 24 字）。 */
  title: string
  /** 单元完整文本（含标题行）。 */
  body: string
  /** 单元归一化指纹（标题+去空白首 80 字），用于包含校验。 */
  fingerprint: string
}

/** 按 `## ` 二级标题把源文本切成规则单元；无 `## ` 时整文件/整文本为一个单元。 */
export function splitNormUnits(source: string, text: string): NormUnit[] {
  const raw = String(text ?? '')
  const lines = raw.split('\n')
  const heads: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) heads.push(i)
  }
  if (heads.length === 0) {
    const body = raw.trim()
    const title = firstMeaningfulLine(body, '')
    return body.length > 0 ? [{ source, title, body, fingerprint: fingerprintOf(body, title) }] : []
  }
  const units: NormUnit[] = []
  for (let i = 0; i < heads.length; i += 1) {
    const start = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1] : lines.length
    const body = lines.slice(start, end).join('\n').trim()
    const title = lines[start].replace(/^##\s+/, '').trim()
    if (body.length > 0) units.push({ source, title, body, fingerprint: fingerprintOf(body, title) })
  }
  return units
}

/** 首行有意义的文本（用于整文本单元取标题）。 */
function firstMeaningfulLine(text: string, fallback: string): string {
  for (const l of text.split('\n')) {
    const t = l.trim()
    if (t.length > 0) return t.slice(0, 24)
  }
  return fallback
}

/** 归一化指纹：去掉所有空白（含换行）后的单元正文前 140 字。
 * 正文以 `## 标题`（或整文本首行）开头，标题天然含入指纹 —— 无需另拼 title。 */
export function fingerprintOf(body: string, _title: string): string {
  return String(body).replace(/\s+/g, '').slice(0, 140)
}

/** 归一化后做子串包含校验（注入文本经 budget 截断后，present 的规则单元指纹应完整出现）。 */
export function unitPresentIn(unit: NormUnit, injectedText: string): boolean {
  const text = String(injectedText ?? '').replace(/\s+/g, '')
  return text.length > 0 && unit.fingerprint.length > 0 && text.includes(unit.fingerprint)
}

/**
 * 真实注入产物 = norms sections 本身是逐文件拼接的**内容副本**（不是引用），
 * 因此更强校验：把注入文本也切成单元，按 source+title 与 desired 对账。
 * 但截断发生在文本层（content 被 cut），单元级对账会把"部分保留的单元"全判 missing。
 * 故采用指纹包含校验（指纹 = 单元头部 140 字）：预算截断默认保前弃后，
 * 头部被裁掉的单元才判 missing —— 精准指向"将军的规则被截断没进提示词"。
 */


/** 解析 tombstone 文件内容（每行一个注入源文件名；# 注释与空行跳过）→ 停用集合。 */
export function parseTombstones(content: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const line of String(content ?? '').split('\n')) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#')) continue
    out.add(t)
  }
  return out
}

/** 应用 tombstone：过滤掉被停用的注入源文件。 */
export function applyTombstones<T extends { label: string }>(files: T[], removed: Set<string>): T[] {
  return files.filter(f => !removed.has(f.label))
}

/** 从注入产物文本中找某源的 marker 行（空间层文件 marker / 全局层 header）。 */
export function sourceMarkerIn(source: string, injectedText: string): boolean {
  const text = String(injectedText ?? '')
  if (source === 'global') return text.includes('全局规范（必须遵守，来自 team-hub rules 全局层）：')
  return text.includes(`【来源：仓库文件 ${source}】`)
}

export interface RuleDoctorItem {
  source: string
  title: string
  present: boolean
}

export interface RuleDoctorReport {
  ok: boolean
  /** 逐个 desired 规则单元的注入校验结果。 */
  items: RuleDoctorItem[]
  /** 被 tombstone 停用的源（未参与 desired-set）。 */
  removedSources: string[]
  /** 注入是否发生过预算截断（norms 返回 truncated）。 */
  truncated: boolean
}

/**
 * 规则 doctor 主校验：把注入源文件族 + 全局层文本解析为 desired 规则单元，
 * 逐条断言其真实出现在注入产物文本里。
 *
 * 判据 = **单元指纹包含校验**（将军写的规则文字真的在提示词里）——这是内容级证据，
 * 对 norms 两种形态都成立：
 *   - 多文件/两段形态：注入段带【来源：仓库文件 X】marker + 内容副本；
 *   - 兼容单文件形态（仅 LEGION.md + 无全局层，norms.ts TC-S5-03）：REPO_RULES_HEADER + 逐字内容，无文件 marker。
 * sourceMarkerIn 只做辅助归属说明，不参与 ok 判据（防兼容分支误报）。
 * missing = 单元头部 140 字未出现在注入文本 → 被预算截断或分层逻辑剔除，
 * 将军可据此发现"我的规则没进士兵提示词"（对应 DSH 的 preset mount 诊断）。
 */
export function runRuleDoctor(opts: {
  /** 注入源文件族（已含 label/content）。 */
  files: Array<{ label: string; content: string }>
  /** team-hub 全局层文本（空串 = 未配置）。 */
  globalText: string
  /** tombstone 停用集合（可空）。 */
  removed?: Set<string>
  /** norms 实际注入产物（sections 拼接，含 marker 与可能的截断）。 */
  injectedText: string
  /** norms 是否报告预算截断。 */
  truncated?: boolean
}): RuleDoctorReport {
  const removed = opts.removed ?? new Set<string>()
  const active = applyTombstones(opts.files, removed)
  const items: RuleDoctorItem[] = []
  for (const f of active) {
    const units = splitNormUnits(f.label, f.content)
    for (const u of units) {
      items.push({ source: u.source, title: u.title, present: unitPresentIn(u, opts.injectedText) })
    }
  }
  if (opts.globalText.trim().length > 0) {
    for (const u of splitNormUnits('global', opts.globalText)) {
      items.push({ source: 'global', title: u.title, present: unitPresentIn(u, opts.injectedText) })
    }
  }
  const truncated = opts.truncated === true
  const missing = items.filter(i => !i.present)
  return {
    ok: missing.length === 0 && !truncated,
    items,
    removedSources: [...removed].sort(),
    truncated,
  }
}

/**
 * 分层项目规范（R-2，S5）：全局层（team-hub rules scope=global）与空间/项目层
 * （仓库文件族 LEGION.md → AGENTS.md → agent.md，按序读全部存在者）的分层合并与预算截断。
 *
 * 规则（对齐 docs/TEST_CASES.md TC-S5-01..09 / AC-R2-1..5）：
 *   1. 两段顺序稳定：先全局层段、后空间层段；空间层段带「优先于全局层」声明与来源标注。
 *   2. 兼容回归：仅 LEGION.md 且无全局内容时，输出与现状 readRepoRules 逐字一致
 *      （含「仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）：」段首文案）。
 *   3. 无任何内容 → 空 sections（buildWorkerPrompt 不输出规范段、不报错）。
 *   4. 各层按段落边界截断到预算内（NORMS_GLOBAL_MAX=3000 / NORMS_SPACE_MAX=4000 / NORMS_TOTAL_MAX=7000
 *      可经环境变量注入）；截断处追加真实数字提示；不产生半截代码块。
 * 纯函数 + 模块级 env 预算常量，无 I/O；node --test 直接单测。
 */

export interface NormFile {
  /** 文件名（LEGION.md / AGENTS.md / agent.md），用于来源标注与 LEGACY 判定。 */
  label: string
  content: string
}

export interface NormInput {
  /** 全局层文本（rules content for scope=global；空串 = 无全局层）。 */
  globalText: string
  /** 仓库文件族按序读到的存在文件（空数组 = 空间层无文件）。 */
  files: NormFile[]
}

export interface NormResult {
  /** 注入提示词的规范小节文本数组（顺序：全局层段在前、空间层段在后）；[] = 无规范段。 */
  sections: string[]
  /** 是否发生过任何截断。 */
  truncated: boolean
}

const envNum = (key: string, fallback: number): number => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** 各层预算（env 可配，S5-06 三值法）。 */
export const NORMS_GLOBAL_MAX = envNum('NORMS_GLOBAL_MAX', 3000)
export const NORMS_SPACE_MAX = envNum('NORMS_SPACE_MAX', 4000)
export const NORMS_TOTAL_MAX = envNum('NORMS_TOTAL_MAX', 7000)

export const REPO_RULES_HEADER = '仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）：'
/** 空间/项目层段首文案（导出供 doctor 用 marker 所有权校验注入产物归属）。 */
export const SPACE_PRIORITY_NOTE = '空间/项目层规范（优先于全局层，必须遵守）'
/** 全局层段首文案（导出供 doctor 校验全局规则是否真的进了注入产物）。 */
export const GLOBAL_HEADER = '全局规范（必须遵守，来自 team-hub rules 全局层）：'
/** 空间层单文件来源标注前缀（真实注入产物里的 marker：docs/rule-assets doctor 按此校验逐文件所有权）。 */
export const FILE_SOURCE_PREFIX = '【来源：仓库文件 '

/** 数出文本中 ``` 围栏行的数量。 */
function fenceLines(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) n += 1
  }
  return n
}

/**
 * 按段落边界截断到预算内：优先整段保留；任何输出保证代码围栏配对。
 * 返回 { body, truncated }；截断时追加真实数字提示（原文 N 字 / 已保留 M 字）。
 */
export function truncateNormsText(raw: string, max: number): { body: string; truncated: boolean } {
  const text = raw ?? ''
  const originalLen = text.length
  if (originalLen <= max) return { body: text, truncated: false }
  const segs = text.split(/(\n{2,})/)
  const parts: string[] = []
  let len = 0
  for (const seg of segs) {
    if (seg.trim().length === 0) {
      if (parts.length > 0 && len + seg.length <= max) { parts.push(seg); len += seg.length }
      continue
    }
    if (len + seg.length > max) {
      if (parts.length === 0) {
        // 单段本身就超限：字符回退 + 围栏配对校验
        let body = text.slice(0, max)
        if (fenceLines(body) % 2 === 1) {
          const lines = body.split('\n')
          let li = -1
          for (let i = 0; i < lines.length; i += 1) if (/^\s*```/.test(lines[i])) li = i
          if (li >= 0) body = lines.slice(0, li).join('\n').replace(/\n+$/, '')
        }
        const kept = body.length
        if (kept === 0) return { body: '', truncated: true }
        return { body: body + '\n\n（规范超限截断：原文 ' + originalLen + ' 字，已保留前 ' + kept + ' 字，超限部分未注入）', truncated: true }
      }
      break
    }
    parts.push(seg); len += seg.length
  }
  let body = parts.join('')
  if (fenceLines(body) % 2 === 1) {
    const lines = body.split('\n')
    let li = -1
    for (let i = 0; i < lines.length; i += 1) if (/^\s*```/.test(lines[i])) li = i
    if (li >= 0) body = lines.slice(0, li).join('\n').replace(/\n+$/, '')
  }
  const kept = body.length
  if (kept === 0) return { body: '', truncated: true }
  return { body: body + '\n\n（规范超限截断：原文 ' + originalLen + ' 字，已保留前 ' + kept + ' 字，超限部分未注入）', truncated: true }
}

/**
 * 分层合并主函数：返回按序 sections。
 *
 * 兼容回归分支（TC-S5-03）：globalText 为空且文件族恰为单文件 LEGION.md → 单段、
 * 段首文案与内容与现状 readRepoRules 注入逐字一致。其余情况走两段新形态。
 */
export function buildNormSections(
  input: NormInput,
  opts: { globalMax?: number; spaceMax?: number; totalMax?: number } = {},
): NormResult {
  const globalMax = opts.globalMax ?? NORMS_GLOBAL_MAX
  const spaceMax = opts.spaceMax ?? NORMS_SPACE_MAX
  const totalMax = opts.totalMax ?? NORMS_TOTAL_MAX
  const files = (input.files ?? []).filter((f) => f && typeof f.content === 'string' && f.content.length > 0)
  const globalRaw = (input.globalText ?? '').trim()
  const sections: string[] = []
  let truncated = false

  if (globalRaw.length === 0 && files.length === 1 && files[0].label === 'LEGION.md') {
    return { sections: [REPO_RULES_HEADER + '\n' + files[0].content], truncated: false }
  }

  if (globalRaw.length > 0) {
    const g = truncateNormsText(globalRaw, globalMax)
    truncated = truncated || g.truncated
    if (g.body.length > 0) sections.push(GLOBAL_HEADER + '\n' + g.body)
  }

  if (files.length > 0) {
    const spaceRaw = files
      .map((f, i) => {
        const head = files.length > 1 || f.label !== 'LEGION.md' ? '【来源：仓库文件 ' + f.label + '】\n' : ''
        return (i > 0 ? '\n\n' : '') + head + f.content
      })
      .join('')
    const s = truncateNormsText(spaceRaw, spaceMax)
    truncated = truncated || s.truncated
    if (s.body.length > 0) {
      const src = files.map((f) => f.label).join(' / ')
      sections.push(SPACE_PRIORITY_NOTE + '（' + src + '）：\n' + s.body)
    }
  }

  // 合计预算：两层都超总预算时保全局层、空间层按剩余裁剪（段落边界）
  if (sections.length === 2 && totalMax > 0) {
    const gLen = sections[0].length
    const sLen = sections[1].length
    const src = files.map((f) => f.label).join(' / ')
    if (gLen + sLen > totalMax) {
      const remain = Math.max(0, totalMax - gLen)
      if (remain < SPACE_PRIORITY_NOTE.length + 20) {
        sections[1] = SPACE_PRIORITY_NOTE + '（' + src + '）：\n（空间层已因合计预算 ' + totalMax + ' 字超限被裁剪）'
        truncated = true
      } else {
        const bodyOnly = sections[1].slice(sections[1].indexOf('：\n') + 2)
        const s2 = truncateNormsText(bodyOnly, remain - SPACE_PRIORITY_NOTE.length - 20)
        sections[1] = SPACE_PRIORITY_NOTE + '（' + src + '）：\n' + s2.body
        truncated = truncated || s2.truncated
      }
    }
  }

  return { sections, truncated }
}

/**
 * 团队共享技能缓存指纹（R-1 守护注入刷新面，S3）。
 *
 * 守护把 team-hub 的已发布技能注入 worker 提示词，缓存在内存并随 sweep 刷新。
 * 刷新判据 = 指纹比较而非简单长度比较：指纹取 (id, version, contentHash) 序列（按 id 排序，
 * 顺序变化不视为内容变化），保证：
 *   - 同量内容改版（version+1 / contentHash 变化）→ 指纹变化 → 刷新；
 *   - 完全相同的列表（含顺序变化）→ 指纹不变 → 不刷新（零噪音日志/零无谓注入变更）；
 *   - 撤销（条目移除）/ 新授权（条目加入）→ 指纹变化 → 刷新；
 *   - 拉取失败 → 调用方保留旧缓存（本模块无状态，由调用方控制）。
 * 纯函数、无 I/O，可直接被 node --test 单测（对齐 TC-S3-01..06）。
 *
 * 技能内容在 v2 重构为「多部件 bundle」：主提示(SKILL.md) + 配置(config.yaml) + 脚本(scripts) + 案例(cases)。
 * formatSkill 将其序列化为注入 worker 的文本块（纯函数、无 I/O，可单测）。
 */

export interface SkillPart {
  name: string
  content: string
}

export interface SkillBundle {
  main: string
  config: string
  scripts: SkillPart[]
  cases: SkillPart[]
}

export interface SkillRef {
  id: string
  name: string
  description?: string | null
  prompt?: string | null
  bundle?: SkillBundle | null
  version?: number | null
  contentHash?: string | null
}

/** 按 id 稳定排序后的指纹串：顺序变化不刷新（TC-S3-06 不崩且不噪音刷新）。 */
export function skillsFingerprint(skills: readonly SkillRef[]): string {
  const sorted = [...skills]
    .filter((s) => s && typeof s.id === 'string')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => `${s.id}:${s.version ?? 0}:${s.contentHash ?? ''}`)
  return JSON.stringify(sorted)
}

/** 内容/成员是否变化（供 fetchSkills 决策是否覆盖缓存）。 */
export function skillsChanged(prev: readonly SkillRef[], next: readonly SkillRef[]): boolean {
  return skillsFingerprint(prev) !== skillsFingerprint(next)
}

// 注入裁剪：避免脚本/案例把上下文撑爆（主提示不截断；附属部件按部件数 + 每件字符数双截断）。
const CONFIG_CAP = 2400
const PART_CAP = 1600
const PART_LIMIT = 6

function clamp(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length <= n ? t : `${t.slice(0, n)}\n…（已截断，共 ${t.length} 字）`
}

/**
 * 把技能序列化为注入 worker 的文本块：主提示(SKILL.md)为「必须遵守」主线完整给出，
 * 配置/脚本/案例作为附录分段给出（主要供模型读取；脚本/案例按数量与字数裁剪防上下文膨胀）。
 */
export function formatSkill(s: SkillRef): string {
  const b = s.bundle ?? null
  const main = String(b?.main ?? s.prompt ?? '').trim()
  const out: string[] = [`【${s.name}】${s.description ? String(s.description).trim() : ''}`.trimEnd()]
  if (main) out.push(`\n【SKILL.md 主指引】\n${main}`)
  if (b && b.config && b.config.trim()) out.push(`\n【配置 config.yaml】\n${clamp(b.config, CONFIG_CAP)}`)
  if (b && Array.isArray(b.scripts) && b.scripts.length) {
    out.push(`\n【脚本 scripts】\n${b.scripts.slice(0, PART_LIMIT).map((p) => `- ${p.name || '(未命名)'}\n${clamp(p.content, PART_CAP)}`).join('\n\n')}`)
  }
  if (b && Array.isArray(b.cases) && b.cases.length) {
    out.push(`\n【案例 examples】\n${b.cases.slice(0, PART_LIMIT).map((p) => `- ${p.name || '(未命名)'}\n${clamp(p.content, PART_CAP)}`).join('\n\n')}`)
  }
  return out.join('\n')
}

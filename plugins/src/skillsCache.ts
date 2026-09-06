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
 */

export interface SkillRef {
  id: string
  name: string
  prompt: string
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

/**
 * 技能资产双向桥（P1-4.5，对齐 docs/research/teamai-cli-review.md §4.5 + §2.2）：
 * 把 team-hub 已发布（published）技能幂等 reconcile 成 DSH 原生技能目录
 * `~/.dsh/skills/<id>/SKILL.md` —— 该目录同时是 teamai 对 DSH 的同步目标
 * （skill-filesystem home-dsh root，rank 400；teamai toolPaths dsh.skills），
 * 因此"发送端"落地后：Legion 沉淀的技能既进 DSH 当前会话的 skill 目录
 * （其他 agent preset 可扫描/复用），也兼容 teamai 的拉取格式。
 *
 * 收敛协议（对齐 §2.2，纯函数可单测）：
 *   1. desired-set = team-hub skills（status=published，按 scope 过滤可选）+ 各自
 *      contentHash；渲染为 SKILL.md 文本（frontmatter + body，body = skillsCache
 *      注入同构文本，保证「士兵提示词里看到的」与「DSH 目录里的」一致）。
 *   2. 幂等 reconcile：目录里每份 SKILL.md 带 `<!-- legion-skill: <id>: <hash> -->`
 *      marker；hash 未变不重写（避免每轮落盘噪音），变化才写。
 *   3. tombstone：`~/.dsh/skills/.removed`（每行一个技能 id，# 注释跳过）。曾被本桥
 *      写出、现不在 desired 的目录 → 若在 removed 里则删除（将军/团队确已停用）；
 *      不在 removed 里 → 视为团队外个人技能，保留不删（防误删，teamai 同款语义）。
 *   4. 非本桥目录（无 marker）一律不动。
 *
 * 纯函数、无 I/O；文件系统操作由调用方（守护）按返回值执行，便于 node --test 单测。
 */

export interface PublishedSkill {
  id: string
  name: string
  description?: string | null
  /** 注入同构文本（调用方用 skillsCache.formatSkill 生成），SKILL.md body 即此。 */
  body: string
  contentHash?: string | null
}

export interface SkillFsPlan {
  /** 应写入/更新的 SKILL.md 文件（目录 + 内容）。 */
  writes: Array<{ id: string; content: string }>
  /** 应删除的目录（tombstone 确认停用）。 */
  deletes: Array<{ id: string }>
  /** 现状与 desired 的差异摘要（供日志）。 */
  changed: boolean
}

/** frontmatter + body 渲染：marker 行藏于 body 末尾，标识本桥所有权与内容哈希。 */
export function renderSkillMd(s: PublishedSkill): string {
  const name = String(s.name || s.id)
  const desc = String(s.description ?? '').trim()
  const fm = ['---', `name: ${s.id}`, `description: ${desc}`, '---'].join('\n')
  const marker = `<!-- legion-skill: ${s.id}: ${s.contentHash ?? ''} -->`
  const body = String(s.body ?? '').trim()
  return `${fm}\n\n${body}\n\n${marker}\n`
}

/** 从 SKILL.md 内容里解析 legion marker（无 marker → 非本桥文件，返回 null）。 */
export function parseSkillMarker(content: string): { id: string; hash: string } | null {
  const m = String(content ?? '').match(/<!--\s*legion-skill:\s*([^\s:]+)\s*:\s*([^\s]+)\s*-->/)
  if (!m) return null
  return { id: m[1], hash: m[2] }
}

/** 现状目录的既有 SKILL.md 内容（label=目录名 → content）映射。 */
export type ExistingSkillDirs = Map<string, string>

/**
 * 计算收敛计划：对比 desired（published skills）与现状（既有 SKILL.md 目录 + tombstone）。
 * 规则：
 *   - desired 里的技能：目录缺 → writes；目录有但 marker hash 不同（含无 marker 的同名目录被
 *     本桥接管）→ writes（更新）；hash 相同 → 不动。
 *   - 本桥曾写（marker 存在）但已不在 desired 的目录：在 tombstone → deletes；否则保留（个人/未确认）。
 *   - 非本桥目录（无 marker）不在 desired：不动（含未 tombstone 情形——个人技能绝不删）。
 * @param desired 当前 published 技能列表。
 * @param existing 现状 `<id> → SKILL.md 全文`（守护读目录得到）。
 * @param removed tombstone 停用集合。
 */
export function planSkillSync(desired: PublishedSkill[], existing: ExistingSkillDirs, removed: Set<string>): SkillFsPlan {
  const writes = new Map<string, string>()
  const deletes: Array<{ id: string }> = []
  const desiredSet = new Map(desired.map(d => [d.id, d]))
  // 1) desired → 写入/更新
  for (const d of desired) {
    const want = renderSkillMd(d)
    const cur = existing.get(d.id)
    if (cur === undefined) {
      writes.set(d.id, want)
    } else {
      const marker = parseSkillMarker(cur)
      const curHash = marker?.hash ?? ''
      if (curHash !== String(d.contentHash ?? '')) writes.set(d.id, want)
    }
  }
  // 2) 本桥曾写但已停用 → tombstone 确认才删
  for (const [id, content] of existing) {
    if (desiredSet.has(id)) continue
    const marker = parseSkillMarker(content)
    if (marker === null) continue // 非本桥文件：不动（个人技能）
    if (removed.has(id)) deletes.push({ id })
    // 不在 removed → 团队停用未确认：保留（现状留一份可人工复核）
  }
  const changed = writes.size > 0 || deletes.length > 0
  return {
    writes: [...writes].map(([id, content]) => ({ id, content })),
    deletes,
    changed,
  }
}

/** 解析 tombstone 文件内容（与 ruleAssets.parseTombstones 同语义；每行一个技能 id）。 */
export function parseSkillTombstones(content: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const line of String(content ?? '').split('\n')) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#')) continue
    out.add(t)
  }
  return out
}

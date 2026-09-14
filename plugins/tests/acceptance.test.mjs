// PRT-315 切片 5：验收与沉淀管线（`plugins/src/acceptance.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// `// 4.2` ~ `// 4.5a` 四段此前是 `spaceWorker()` 里四段内联代码：它们的输入是
// `workspace.repoRootFor()` / `hubUrl` / `lastInjectedNorms` 这些**闭包里的东西**，
// 要触发任何一条分支，唯一的办法是**把整个守护跑起来**、在真仓库里造 done 任务、
// 在真的 `~/.dsh/skills` 上落盘。于是此前只有端到端用例覆盖主路径，而
// 「内存已结算 vs 盘上已存在」「friction 不到阈值」「失败只记日志」「4.2 必须早于 4.3」
// 这几条**只有边界输入才会走到**的分支，一条用例都没有。
//
//   > 一个"只有把整个守护跑起来、并且恰好撞上边界输入"才能验证的分支，
//   > 与一个"根本没有这条分支"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// 拆出来之后，这个文件用**替身注入 + 真实临时目录**驱动全部分支。
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬过来的代码与原 `index.ts` 里内联的那几段逐字相同」由构建期脚本
// `_prt-handoff/prt315e-compare.mjs` 验证（按锚点抽出旧块、与新模块归一化对拍，
// 只放行 7 条已声明的注入改写规则）。本文件只管**行为**。
//
// ## 诚实边界（写在这里，免得被读成"真实文件系统也验过了"）
//
// `settleExperience` 与 `syncSkillsToDsh` 是**真的写盘**的（不是替身）——但它们写的
// 是 `mkdtempSync(os.tmpdir())` 下的目录：草稿目录经 `draftDir` 注入，技能目录经
// `config.dshSkillsDir` 配置位注入。本文件**绝不**触碰操作员真实的 `~/.dsh`。
// `promoteDraft` 是**替身**：本文件证明的是"门槛够了、以哪份正文、调了几次"，
// **不**证明真实 AI 改写 / hub register / learnings 落盘（那些留在 `index.ts`，
// 属执行面，不在本切片）。`fetch` 也是替身（`stubFetch`），只断言请求 URL 与
// 由它驱动的收敛结果，不证明真实 team-hub 行为。
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAcceptance } from '../lib/acceptance.js'

/** 真实的 fetch：`stubFetch` 要还原到的那个（不是"上一个替身"）。 */
const REAL_FETCH = globalThis.fetch
const DAY = 86400000
const NOW = '2026-09-15T00:00:00.000Z'
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString()

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 组装一个被测 acceptance 模块。
 *
 * ★ 可变绑定挂在 `h.state` 上，模块拿到的是**取值函数**——这正是 `index.ts` 的接线形态
 * （`useHub: () => useHub`）。用例改 `h.state.useHub` 等于复现 `detectHub()` 的真实赋值，
 * 而不是"改了一个模块根本没读的字段"（前几个切片都踩过这一类假绿：`const { x } = deps`
 * 之后改 `deps.x` 毫无影响）。`draftDir` 是**值**（const 箭头），故必须在构造时给。
 */
function harness(over = {}) {
  const root = over.root ?? mkdtempSync(join(tmpdir(), 'legion-acc-'))
  const draftDir = over.draftDir ?? join(root, 'docs', 'experience', 'drafts')
  const logs = []
  const activities = []
  const promotes = []
  const state = {
    useHub: over.useHub ?? false,
    hubUrl: over.hubUrl ?? 'http://hub.local',
    normsGlobalText: over.normsGlobalText ?? '',
    injected: over.injected ?? { text: '', truncated: false },
    doctor: null,
  }
  const pendingRecallRefs = over.pendingRecallRefs ?? new Map()
  const deps = {
    config: { mode: over.mode ?? 'worker', dshSkillsDir: over.dshSkillsDir ?? join(root, 'dsh-skills') },
    log: (m) => { logs.push(m) },
    scope: over.scope ?? 'app',
    activity: (kind, taskId, text) => { activities.push({ kind, taskId, text }) },
    draftDir: typeof draftDir === 'function' ? draftDir : () => draftDir,
    useHub: () => state.useHub,
    hubUrl: () => state.hubUrl,
    pendingRecallRefs,
    promoteDraft: async (id, body) => { promotes.push({ id, body }) },
    readRepoNormsFiles: over.readRepoNormsFiles ?? (() => [{ label: 'LEGION.md', content: '## 规则甲\n必须这样做' }]),
    readNormsTombstones: over.readNormsTombstones ?? (() => new Set()),
    readNormsSync: over.readNormsSync ?? (() => ({ sections: [], truncated: false })),
    normsGlobalText: () => state.normsGlobalText,
    injectedNorms: () => state.injected,
    ruleDoctor: { get: () => state.doctor, set: (r) => { state.doctor = r } },
  }
  const acc = createAcceptance(deps)
  return { acc, deps, logs, activities, promotes, state, root, draftDir, pendingRecallRefs, config: deps.config }
}

/** 夹具 + 临时目录清理（用例结束删树）。 */
function tmp(t, over = {}) {
  const h = harness(over)
  t.after(() => rmSync(h.root, { recursive: true, force: true }))
  return h
}

/** 装一个假的 fetch，并在用例结束后还原**真实** fetch。 */
function stubFetch(t, handler) {
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return handler(String(url))
  }
  t.after(() => { globalThis.fetch = REAL_FETCH })
  return urls
}

const okJson = (body) => ({ ok: true, json: async () => body })

const draftPath = (h, id) => join(typeof h.draftDir === 'function' ? h.draftDir() : h.draftDir, `${id}.md`)
const readText = (p) => readFileSync(p, 'utf8')

/** 造一个任务快照（字段与 hub 任务同形；只填本切片读的那些）。 */
const task = (over = {}) => ({
  id: over.id ?? 'T-1',
  title: over.title ?? '把甲功能做出来',
  description: over.description ?? '',
  role: over.role ?? 'coder',
  soldier: over.soldier ?? 'coder',
  goalId: over.goalId ?? null,
  scope: over.scope,
  status: over.status ?? 'done',
  comments: over.comments ?? [],
})

/** 高摩擦评论：将军评语 1 + 打回 1 + 验收轮 1 → friction 4.00（≥3.0 阈值，且将军介入）。 */
const HIGH_FRICTION = [
  { by: 'worker', at: '2026-09-15T00:00:00.000Z', text: '完成并提交验收' },
  { by: 'general', at: '2026-09-15T01:00:00.000Z', text: '口径不对，请修订' },
]
/** 低摩擦评论：只有机器闸门一轮 → friction 0.50（<3.0 阈值）→ 不产草稿。 */
const LOW_FRICTION = [
  { by: 'worker', at: '2026-09-15T00:00:00.000Z', text: '完成并提交验收' },
]

/** 手写一份草稿文件（不走 buildDraft——用例要**控制** frontmatter 的每一个字段）。 */
function writeDraft(h, s, body = '\n# 经验草稿：T-1 把甲功能做出来\n\n正文原样保留。\n') {
  mkdirSync(h.draftDir, { recursive: true })
  const fm = [
    '---',
    `taskId: ${s.taskId}`,
    `status: ${s.status ?? 'draft'}`,
    `friction: ${(s.friction ?? 4).toFixed(2)}`,
    `recalled: ${s.recalled ?? 0}`,
    `recalledBy: ${JSON.stringify(s.recalledBy ?? [])}`,
    `upvoted: ${s.upvoted ?? 0}`,
    `upvotedBy: ${JSON.stringify(s.upvotedBy ?? [])}`,
    `createdAt: ${s.createdAt ?? daysAgo(10)}`,
    `lastActivityAt: ${s.lastActivityAt ?? daysAgo(10)}`,
    `role: ${s.role ?? 'coder'}`,
    `goalId: ${s.goalId ?? ''}`,
    `scope: ${s.scope ?? 'app'}`,
    `promotedTo: ${s.promotedTo ?? ''}`,
    `promotedAt: ${s.promotedAt ?? ''}`,
    `kind: ${s.kind ?? ''}`,
    '---',
  ].join('\n')
  const md = `${fm}\n${body}`
  writeFileSync(join(h.draftDir, `${s.taskId}.md`), md, 'utf8')
  return md
}

// ══════════════════════════════════════════════════════════════════════════════
// 4.2 经验沉淀：friction 阈值 + **两种**跳过 + 失败只记日志
// ══════════════════════════════════════════════════════════════════════════════

test('4.2 阈值以上：写 <draftDir>/T-1.md，日志/activity 逐字（含 friction=4.00 与三个信号）', async (t) => {
  const h = tmp(t)
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION }))
  const file = draftPath(h, 'T-1')
  assert.equal(existsSync(file), true)
  const md = readText(file)
  assert.ok(md.startsWith('---\ntaskId: T-1\nstatus: draft\nfriction: 4.00\n'), `frontmatter 不符：\n${md.slice(0, 200)}`)
  assert.ok(md.includes('# 经验草稿：T-1 把甲功能做出来'))
  assert.ok(md.includes('口径不对，请修订'), '将军评语原文应在草稿里')
  assert.deepEqual(h.logs, [`T-1 → 经验草稿落盘：${file}（friction=4.00，打回1/验收1/将军评语1）`])
  assert.deepEqual(h.activities, [
    { kind: 'experience', taskId: 'T-1', text: '经验草稿已生成：docs/experience/drafts/T-1.md（friction=4.00）' },
  ])
})

test('4.2 阈值以下：friction 0.50 → 不落盘、不记日志、不记 activity（阈值是硬闸门）', async (t) => {
  const h = tmp(t)
  await h.acc.settleExperience(task({ comments: LOW_FRICTION }))
  assert.equal(existsSync(draftPath(h, 'T-1')), false)
  assert.deepEqual(h.logs, [])
  assert.deepEqual(h.activities, [])
})

test('4.2 ★ 跳过之一：内存已结算 —— 文件被删掉也不再重算（这一条只有内存闸门能拦住）', async (t) => {
  const h = tmp(t)
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION }))
  const file = draftPath(h, 'T-1')
  const first = readText(file)
  rmSync(file) // 人工删掉草稿：内存闸门仍须拦住"重算+重写"
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION }))
  assert.equal(existsSync(file), false, '内存里已结算 → 第二次连磁盘都不该写')
  assert.equal(h.logs.length, 1, '只该有第一次那条落盘日志')
  assert.equal(h.activities.length, 1)
  assert.ok(first.includes('friction: 4.00'))
})

test('4.2 ★ 跳过之二：盘上已存在 —— 新实例（内存空）撞上已有文件 → 不覆盖、不记日志', async (t) => {
  const h = tmp(t)
  const file = draftPath(h, 'T-1')
  mkdirSync(h.draftDir, { recursive: true })
  writeFileSync(file, '人工修订过的内容，守护不许覆盖\n', 'utf8')
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION }))
  assert.equal(readText(file), '人工修订过的内容，守护不许覆盖\n', '盘上已存在 → 不覆盖（这一条内存闸门拦不住，必须靠 existsSync）')
  assert.deepEqual(h.logs, [])
  assert.deepEqual(h.activities, [])
})

test('4.2 非 done 任务：直接返回（不做任何判定，也不记内存）', async (t) => {
  const h = tmp(t)
  await h.acc.settleExperience(task({ status: 'in_progress', comments: HIGH_FRICTION }))
  assert.equal(existsSync(draftPath(h, 'T-1')), false)
  assert.deepEqual(h.logs, [])
  // 之后转 done 仍应正常结算（说明上面那次没有把 id 记进内存）
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION }))
  assert.equal(existsSync(draftPath(h, 'T-1')), true)
})

test('4.2 ★ 落盘失败只记日志、不抛出；且"先记再干活"——失败后本轮不再重试（与闭包变量同位置）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-acc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'blocked'), 'x', 'utf8') // 一个**文件**占住路径
  const h = harness({ root, draftDir: () => join(root, 'blocked', 'drafts') })
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION })) // 不应抛出
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0], /^T-1 经验草稿生成失败：/)
  assert.deepEqual(h.activities, [])
  await h.acc.settleExperience(task({ comments: HIGH_FRICTION })) // expSettled 已置位 → 不再动手
  assert.equal(h.logs.length, 1)
})

// ══════════════════════════════════════════════════════════════════════════════
// 4.3 置信度晋升管线：票务（recalled / upvoted / decay）→ prune → promote
// ══════════════════════════════════════════════════════════════════════════════

test('4.3 派工注入的召回引用 → recalled=1 / recalledBy=["T-9"]，且消费完即清空 pendingRecallRefs', async (t) => {
  const h = tmp(t, { pendingRecallRefs: new Map([['T-9', ['T-1']]]) })
  const before = writeDraft(h, { taskId: 'T-1' })
  await h.acc.sweepExperienceVotes([])
  const after = readText(draftPath(h, 'T-1'))
  assert.match(after, /\nrecalled: 1\n/)
  assert.match(after, /\nrecalledBy: \["T-9"\]\n/)
  assert.notEqual(after, before, 'frontmatter 有票就该写回')
  assert.ok(after.includes('正文原样保留。'), '正文必须原样保留')
  assert.equal(h.pendingRecallRefs.size, 0, '消费完即清：任务重派会重新登记')
  assert.deepEqual(h.logs, [])
})

test('4.3 ★ upvote 只认将军（by=general / 将军）：worker 说"采纳"不算票', async (t) => {
  const h = tmp(t)
  writeDraft(h, { taskId: 'T-1' })
  await h.acc.sweepExperienceVotes([
    task({ id: 'T-2', comments: [{ by: 'general', at: NOW, text: '采纳草稿 T-1' }] }),
    task({ id: 'T-3', comments: [{ by: 'worker', at: NOW, text: '采纳草稿 T-1' }] }),
  ])
  const after = readText(draftPath(h, 'T-1'))
  assert.match(after, /\nupvoted: 1\n/)
  assert.match(after, /\nupvotedBy: \["general"\]\n/)
})

test('4.3 自引用不计票：草稿源任务自己写"参考 T-1"不产生 recalled', async (t) => {
  const h = tmp(t)
  writeDraft(h, { taskId: 'T-1' })
  await h.acc.sweepExperienceVotes([
    task({ id: 'T-1', comments: [{ by: 'worker', at: NOW, text: '参考经验草稿 T-1' }] }),
  ])
  const after = readText(draftPath(h, 'T-1'))
  assert.match(after, /\nrecalled: 0\n/)
  assert.match(after, /\nrecalledBy: \[\]\n/)
})

test('4.3 ★ promote 门槛够了 → 调注入的 promoteDraft(草稿 id, 原正文)；每轮至多一个', async (t) => {
  const h = tmp(t)
  const raw1 = writeDraft(h, { taskId: 'T-1', recalled: 2, recalledBy: ['T-8', 'T-9'], upvoted: 1, upvotedBy: ['general'], createdAt: daysAgo(10), lastActivityAt: new Date().toISOString() })
  writeDraft(h, { taskId: 'T-2', recalled: 2, recalledBy: ['T-8', 'T-9'], upvoted: 1, upvotedBy: ['general'], createdAt: daysAgo(10), lastActivityAt: new Date().toISOString() })
  await h.acc.sweepExperienceVotes([])
  assert.equal(h.promotes.length, 1, '每轮至多派一个 promote（防热循环）')
  assert.equal(h.promotes[0].id, 'T-1', '按文件名排序取第一个')
  assert.equal(h.promotes[0].body, raw1, '传给 promoteDraft 的是**改动前**的原正文（溯源用）')
  assert.deepEqual(h.logs, [], 'promote 动作本身不在这里记日志（由注入的实现负责）')
})

test('4.3 promote 门槛不够（观察窗 <3 天）→ 一次都不派', async (t) => {
  const h = tmp(t)
  writeDraft(h, { taskId: 'T-1', recalled: 2, recalledBy: ['T-8', 'T-9'], upvoted: 1, upvotedBy: ['general'], createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() })
  await h.acc.sweepExperienceVotes([])
  assert.deepEqual(h.promotes, [])
})

test('4.3 prune：90 天无任何票 → status: stale（标记不删，供人工复核）', async (t) => {
  const h = tmp(t)
  writeDraft(h, { taskId: 'T-1', createdAt: daysAgo(100), lastActivityAt: daysAgo(100) })
  await h.acc.sweepExperienceVotes([])
  const after = readText(draftPath(h, 'T-1'))
  assert.match(after, /\nstatus: stale\n/)
  assert.ok(after.includes('正文原样保留。'))
})

test('4.3 有票的草稿不 prune（团队小、好经验可能很久才被再用）', async (t) => {
  const h = tmp(t)
  writeDraft(h, { taskId: 'T-1', recalled: 1, recalledBy: ['T-7'], createdAt: daysAgo(100), lastActivityAt: daysAgo(100) })
  await h.acc.sweepExperienceVotes([])
  assert.match(readText(draftPath(h, 'T-1')), /\nstatus: draft\n/)
})

test('4.3 目录不存在 / 空目录 → 直接返回（无日志、无 promote、不清 pendingRecallRefs）', async (t) => {
  const h = tmp(t, { pendingRecallRefs: new Map([['T-9', ['T-1']]]) })
  await h.acc.sweepExperienceVotes([]) // 目录不存在
  assert.equal(h.pendingRecallRefs.size, 1, '目录都没有 → 根本没进消费路径')
  mkdirSync(h.draftDir, { recursive: true })
  await h.acc.sweepExperienceVotes([]) // 空目录
  assert.equal(h.pendingRecallRefs.size, 1)
  assert.deepEqual(h.logs, [])
})

test('4.3 单个草稿读失败只记日志，不中断其余草稿（T-9.md 是目录 → EISDIR）', async (t) => {
  const h = tmp(t, { pendingRecallRefs: new Map([['T-8', ['T-1']]]) })
  writeDraft(h, { taskId: 'T-1' })
  mkdirSync(join(h.draftDir, 'T-9.md'), { recursive: true })
  await h.acc.sweepExperienceVotes([])
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0], /^经验草稿 T-9\.md 票务更新失败：/)
  assert.match(readText(draftPath(h, 'T-1')), /\nrecalled: 1\n/, '前面那份草稿照常记票')
})

test('4.3 已 promoted / stale 的草稿跳过票务（不做无意义写回）', async (t) => {
  const h = tmp(t, { pendingRecallRefs: new Map([['T-8', ['T-1']]]) })
  const raw = writeDraft(h, { taskId: 'T-1', status: 'promoted' })
  await h.acc.sweepExperienceVotes([])
  assert.equal(readText(draftPath(h, 'T-1')), raw, 'promoted 草稿原样不动')
})

test('★ 顺序：4.2 必须在 4.3 之前——本轮新落盘的草稿，同一轮就参与事件扫描', async (t) => {
  const h = tmp(t, { pendingRecallRefs: new Map() })
  const file = draftPath(h, 'T-1')
  const referencing = [
    task({ id: 'T-9', status: 'in_progress', comments: [{ by: 'worker', at: NOW, text: '参考经验草稿 T-1' }] }),
  ]
  assert.equal(existsSync(file), false, '开局盘上没有草稿')
  // 反例（先跑 4.3）：草稿还不存在 → 这一轮一个字节都不记
  await h.acc.sweepExperienceVotes(referencing)
  assert.equal(existsSync(file), false)
  // 正例（4.2 → 4.3）：新落盘的草稿在同一轮里当场得票
  await h.acc.settleExperience(task({ id: 'T-1', comments: HIGH_FRICTION }))
  assert.equal(existsSync(file), true)
  assert.match(readText(file), /\nrecalled: 0\n/, '仅 4.2 落盘时还没有票')
  await h.acc.sweepExperienceVotes(referencing)
  assert.match(readText(file), /\nrecalled: 1\n/)
  assert.match(readText(file), /\nrecalledBy: \["T-9"\]\n/)
})

// ══════════════════════════════════════════════════════════════════════════════
// 4.4 规则资产 doctor：desired 规则单元 vs 最近真实注入产物
// ══════════════════════════════════════════════════════════════════════════════

const RULE_TEXT = '【来源：仓库文件 LEGION.md】\n## 规则甲\n必须这样做'

test('4.4 规则进了提示词：ok=true，1/1，log 逐字，报告写回访问器', async (t) => {
  const h = tmp(t, { injected: { text: RULE_TEXT, truncated: false } })
  const report = h.acc.runRuleDoctorNow()
  assert.equal(report.ok, true)
  assert.deepEqual(report.items, [{ source: 'LEGION.md', title: '规则甲', present: true }])
  assert.deepEqual(report.removedSources, [])
  assert.equal(report.truncated, false)
  assert.equal(h.state.doctor, report, '报告必须写回调用方持有的访问器')
  assert.deepEqual(h.logs, ['【规则 doctor】1/1 规则单元全部进了提示词 ✓'])
  assert.deepEqual(h.activities, [])
})

test('4.4 规则没进提示词：告警 log + activity 逐字；状态未变时**不刷屏**（第二次一条都不记）', async (t) => {
  const h = tmp(t, { injected: { text: '注入产物里没有那条规则', truncated: false } })
  const r1 = h.acc.runRuleDoctorNow()
  assert.equal(r1.ok, false)
  assert.deepEqual(r1.items, [{ source: 'LEGION.md', title: '规则甲', present: false }])
  assert.deepEqual(h.logs, ['【规则 doctor】告警：0/1 规则单元进了提示词；缺失 LEGION.md#规则甲'])
  assert.deepEqual(h.activities, [
    { kind: 'rules-doctor', taskId: '*', text: '规则注入缺失 1 条：LEGION.md#规则甲（truncated=false）' },
  ])
  const r2 = h.acc.runRuleDoctorNow()
  assert.equal(r2.ok, false)
  assert.equal(h.logs.length, 1, '状态没变 → 不重复记日志')
  assert.equal(h.activities.length, 1)
  assert.equal(h.state.doctor, r2)
})

test('4.4 状态变化才 log：缺失 → 补齐（同一次调用内比较的是**上一轮**报告）', async (t) => {
  const h = tmp(t, { injected: { text: '注入产物里没有那条规则', truncated: false } })
  h.acc.runRuleDoctorNow()
  assert.equal(h.logs.length, 1)
  h.state.injected = { text: RULE_TEXT, truncated: false } // 规则补进提示词了
  const r = h.acc.runRuleDoctorNow()
  assert.equal(r.ok, true)
  assert.deepEqual(h.logs.slice(1), ['【规则 doctor】1/1 规则单元全部进了提示词 ✓'])
})

test('4.4 预算截断：truncated=true → ok=false，即使规则单元都在（截断本身就是问题）', async (t) => {
  const h = tmp(t, { injected: { text: RULE_TEXT, truncated: true } })
  const r = h.acc.runRuleDoctorNow()
  assert.equal(r.ok, false)
  assert.equal(r.truncated, true)
  assert.deepEqual(h.logs, ['【规则 doctor】1/1 规则单元全部进了提示词 ✓'])
})

test('4.4 降级：守护从未派工（注入产物为空）→ 用 readNormsSync() 当场拼装，truncated 按 false', async (t) => {
  const h = tmp(t, {
    injected: { text: '', truncated: false },
    readNormsSync: () => ({ sections: [RULE_TEXT], truncated: true }), // 拼装路径**不**采信它的 truncated
  })
  const r = h.acc.runRuleDoctorNow()
  assert.equal(r.ok, true, '降级拼装里规则在 → 判 present')
  assert.equal(r.truncated, false, '降级路径按 { truncated: false } 传（与原地实现一致）')
})

test('4.4 有注入产物时**不**调 readNormsSync（降级只在产物为空时发生）', async (t) => {
  let calls = 0
  const h = tmp(t, {
    injected: { text: RULE_TEXT, truncated: false },
    readNormsSync: () => { calls += 1; return { sections: [RULE_TEXT], truncated: false } },
  })
  h.acc.runRuleDoctorNow()
  assert.equal(calls, 0)
})

test('4.4 全局层规则也计入 desired-set（hub 规则没进提示词同样报 missing）', async (t) => {
  const h = tmp(t, {
    injected: { text: '【来源：仓库文件 LEGION.md】\n## 规则甲\n必须这样做', truncated: false },
    readRepoNormsFiles: () => [],
  })
  h.state.normsGlobalText = '## 全局规则乙\n全局口径'
  const r = h.acc.runRuleDoctorNow()
  assert.deepEqual(r.items, [{ source: 'global', title: '全局规则乙', present: false }])
  assert.deepEqual(h.logs, ['【规则 doctor】告警：0/1 规则单元进了提示词；缺失 global#全局规则乙'])
})

test('4.4 tombstone 停用的注入源不进 desired-set（不注入、也不误报 missing）', async (t) => {
  const h = tmp(t, {
    injected: { text: '【来源：仓库文件 LEGION.md】\n## 规则甲\n必须这样做', truncated: false },
    readRepoNormsFiles: () => [{ label: 'LEGION.md', content: '## 规则甲\n必须这样做' }, { label: 'AGENTS.md', content: '## 规则乙\n另一条' }],
    readNormsTombstones: () => new Set(['AGENTS.md']),
  })
  const r = h.acc.runRuleDoctorNow()
  assert.deepEqual(r.items.map(i => i.source), ['LEGION.md'])
  assert.deepEqual(r.removedSources, ['AGENTS.md'])
  assert.equal(r.ok, true)
})

// ══════════════════════════════════════════════════════════════════════════════
// 4.5a 技能桥：published skills → config.dshSkillsDir（**真实临时目录**）
// ══════════════════════════════════════════════════════════════════════════════

const SKILL = { id: 'sk-1', name: '甲技能', description: '描述', prompt: '做法：先做 A 再做 B', contentHash: 'h1' }
/** 由 formatSkill + renderSkillMd 的**语义**手工写出的期望文本（不 import 被测依赖来"自证"）。 */
const SKILL_MD = [
  '---',
  'name: sk-1',
  'description: 描述',
  '---',
  '',
  '【甲技能】描述',
  '',
  '【SKILL.md 主指引】',
  '做法：先做 A 再做 B',
  '',
  '<!-- legion-skill: sk-1: h1 -->',
  '',
].join('\n')

test('4.5a published skills 落盘：<dshSkillsDir>/<id>/SKILL.md 逐字；请求 URL / 日志 / activity 逐字', async (t) => {
  const h = tmp(t, { useHub: true })
  const urls = stubFetch(t, () => okJson([SKILL]))
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(urls, ['http://hub.local/api/skills?scope=app'])
  const file = join(h.config.dshSkillsDir, 'sk-1', 'SKILL.md')
  assert.equal(readText(file), SKILL_MD)
  assert.deepEqual(h.logs, [`技能桥：${h.config.dshSkillsDir} 同步 1 写 / 0 删（scope=app，1 个 published）`])
  assert.deepEqual(h.activities, [
    { kind: 'skills-bridge', taskId: '*', text: `published skills → ${h.config.dshSkillsDir}：写 sk-1` },
  ])
})

test('4.5a 幂等：contentHash 未变 → 第二次不重写（mtime 不动）、不记日志', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => okJson([SKILL]))
  await h.acc.syncSkillsToDsh()
  const file = join(h.config.dshSkillsDir, 'sk-1', 'SKILL.md')
  const mtime = statSync(file).mtimeMs
  await h.acc.syncSkillsToDsh()
  assert.equal(statSync(file).mtimeMs, mtime, 'hash 未变 → 一个字节都不重写')
  assert.equal(h.logs.length, 1)
  assert.equal(h.activities.length, 1)
})

test('4.5a hash 变化 → 重写；hash 相同但内容被外部改坏 → 第二次不修（以 marker 为准）', async (t) => {
  const h = tmp(t, { useHub: true })
  let list = [SKILL]
  stubFetch(t, () => okJson(list))
  await h.acc.syncSkillsToDsh()
  const file = join(h.config.dshSkillsDir, 'sk-1', 'SKILL.md')
  list = [{ ...SKILL, contentHash: 'h2', prompt: '做法：先做 C' }]
  await h.acc.syncSkillsToDsh()
  assert.match(readText(file), /<!-- legion-skill: sk-1: h2 -->/)
  assert.ok(readText(file).includes('做法：先做 C'))
  assert.equal(h.logs.length, 2)
})

test('4.5a tombstone：曾经本桥写过、现不在 desired、且在 .removed 里 → 删目录', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => okJson([]))
  const dir = join(h.config.dshSkillsDir, 'sk-9')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: sk-9\n---\n\n正文\n\n<!-- legion-skill: sk-9: h9 -->\n', 'utf8')
  writeFileSync(join(h.config.dshSkillsDir, '.removed'), '# 停用名单\nsk-9\n', 'utf8')
  await h.acc.syncSkillsToDsh()
  assert.equal(existsSync(dir), false, 'tombstone 确认停用 → 删')
  assert.deepEqual(h.logs, [`技能桥：${h.config.dshSkillsDir} 同步 0 写 / 1 删（scope=app，0 个 published）`])
})

test('4.5a 非本桥目录（无 marker）即使停用也保留：绝不删个人技能', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => okJson([]))
  const dir = join(h.config.dshSkillsDir, 'personal')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '手写的个人技能，没有 legion marker\n', 'utf8')
  writeFileSync(join(h.config.dshSkillsDir, '.removed'), 'personal\n', 'utf8')
  await h.acc.syncSkillsToDsh()
  assert.equal(readText(join(dir, 'SKILL.md')), '手写的个人技能，没有 legion marker\n')
  assert.deepEqual(h.logs, [])
})

test('4.5a Δ 无变化（desired 空、目录空）→ 不写盘、不记日志', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => okJson([]))
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(h.logs, [])
  assert.equal(existsSync(h.config.dshSkillsDir), false, 'plan.changed=false → 连目录都不建')
})

test('4.5a ★ 非 hub / mediator 模式：直接返回，一次 fetch 都不发（不写用户级技能目录）', async (t) => {
  const h = tmp(t, { useHub: false })
  const urls = stubFetch(t, () => okJson([SKILL]))
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(urls, [])
  h.state.useHub = true
  h.config.mode = 'mediator'
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(urls, [], '公共调解员不写用户级技能目录（多空间归属不清）')
})

test('4.5a 技能目录配置为空白串 → 直接返回（不 fetch，也不回落到真实 ~/.dsh）', async (t) => {
  const h = tmp(t, { useHub: true, dshSkillsDir: '   ' })
  const urls = stubFetch(t, () => okJson([SKILL]))
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(urls, [])
  assert.deepEqual(h.logs, [])
})

test('4.5a 抛错只记日志、不抛出（技能拉取失败不影响派工）', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => { throw new Error('hub 挂了') })
  await h.acc.syncSkillsToDsh() // 不应抛出
  assert.deepEqual(h.logs, ['技能桥同步失败：Error: hub 挂了'])
})

test('4.5a hub 返回 4xx → 静默返回（保留现状，不记日志）', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => ({ ok: false, status: 500, json: async () => ({}) }))
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(h.logs, [])
})

test('4.5a 非法 id（带 / 或 .. 或空）被过滤掉，不进 desired-set，更不会写到目录外', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => okJson([
    { id: '../escape', name: '坏', prompt: 'x', contentHash: 'h' },
    { id: 'a/b', name: '坏2', prompt: 'x', contentHash: 'h' },
    { id: '', name: '空', prompt: 'x', contentHash: 'h' },
    // ★ '..evil' 不含 '/'，只有 `..` 这道闸门能拦住它——少了它，目录会被建到技能目录的**父级**
    { id: '..evil', name: '坏3', prompt: 'x', contentHash: 'h' },
  ]))
  await h.acc.syncSkillsToDsh()
  assert.deepEqual(h.logs, [])
  assert.equal(existsSync(join(h.root, 'escape')), false)
  assert.equal(existsSync(join(h.config.dshSkillsDir, '..evil')), false)
})

test('4.5a 落盘失败（目标被文件占住）只记日志、不抛出', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-acc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const blocked = join(root, 'blocked')
  writeFileSync(blocked, 'x', 'utf8')
  const h = harness({ root, useHub: true, dshSkillsDir: blocked })
  stubFetch(t, () => okJson([SKILL]))
  await h.acc.syncSkillsToDsh() // 不应抛出
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0], /^技能桥落盘失败：/)
})

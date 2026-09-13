// PRT-315 切片 1：合入调解（`plugins/src/mediation.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// 这里的被测函数此前全都住在 `index.ts` 的 `spaceWorker()` 闭包里——
// 一个约 3000 行的函数。它们从闭包隐式捕获 `config` / `log` / `runGit` /
// `hubUrl` / `useHub` / `stageByRole` / `safeComment` / `advanceTo` / `activity` /
// `getTask` / `listTasks` / `startOneShot` / `mediateAttempts` / `mediateRetryAt` …
// 要想单测其中任何一个，唯一的办法是**把整个守护跑起来**。
//
// 于是它们此前一条用例都没有，而它们做的事一点都不轻：
// 有未提交产出的 worktree 会被 `--force` 强删（T-116 现场：review 文档从未进过
// 任何 commit，被连文件带目录删掉，内容永久丢失）。
//
//   > 一个"只有把整个进程跑起来才能验证"的兜底逻辑，
//   > 与一个"根本没有兜底逻辑"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// 拆出来之后，这些函数全部可以用替身驱动：不跑 git、不连 hub、不看时钟。
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬到 mediation.ts 的代码与原 index.ts 的编译产物逐字相同」由构建期脚本
// `_prt-handoff/prt315-compare.mjs` 验证（比对 `lib/index.js` 与 `lib/mediation.js`，
// 只放行已声明的注入改写）。本文件只管**行为**。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createMergeMediation, MEDIATOR_SCHEMA } from '../lib/mediation.js'

// ── 替身 ─────────────────────────────────────────────────────────────────────

/**
 * 造一个可控的 `runGit`：按 argv 前缀匹配应答，未命中的调用返回成功空输出。
 *
 * ★ 命中规则是**最长前缀优先**，不是"书写顺序第一条"。
 *
 * 为什么：`diff --name-only HEAD` 与 `diff --name-only HEAD w/T-1` 是两条真实存在的
 * 调用，前者是后者的前缀。按书写顺序命中时，先写的那条会把后写的那条**整条吃掉**，
 * 于是"完整性闸门"那类用例会因为一个空输出而**看起来通过**。
 *
 *   > 一个"按书写顺序命中第一条"的替身，
 *   > 与一个"命中最长匹配"的替身，在规则恰好从窄到宽书写时是同一个东西——
 *   > 只不过前者会在下一个人插入一条更宽的规则时，悄悄改掉已有用例的含义。
 */
function gitStub(handlers) {
  const calls = []
  const run = async (root, args) => {
    calls.push({ root, args })
    const key = args.join(' ')
    let best = null
    for (const [pat, resp] of handlers) {
      const hit = typeof pat === 'function' ? pat(args) : key.startsWith(pat)
      if (!hit) continue
      const len = typeof pat === 'function' ? 0 : pat.length
      if (best === null || len > best.len) best = { len, resp }
    }
    if (best === null) return { code: 0, out: '', err: '' }
    return typeof best.resp === 'function' ? best.resp(args) : { code: 0, out: '', err: '', ...best.resp }
  }
  run.calls = calls
  return run
}

/** 造一个任务。默认是一个"带自动合入失败标记、可调解"的 in_review 任务。 */
function task(over = {}) {
  return {
    id: 'T-1', title: '任务一', description: '', acceptance: [], priority: 'P1',
    status: 'in_review', version: 1, soldier: null, claimedAt: null, parent: null,
    role: 'coder', scope: 'app', blockedBy: [],
    comments: [{ by: 'guard', at: '2026-01-01T00:00:00Z', text: '已合入，但自动合入主分支失败' }],
    ...over,
  }
}

/**
 * 组装一个被测调解模块。
 *
 * 返回的 `deps` 暴露了每个替身的调用记录，用例据此断言"它到底做了什么"——
 * 而不是只断言"它没抛错"。
 */
function harness(over = {}) {
  const wtRoot = mkdtempSync(join(tmpdir(), 'prt315-wt-'))
  const log = []
  const comments = []
  const activities = []
  const advances = []
  const oneShots = []
  const runGit = over.runGit ?? gitStub([])
  const getTaskImpl = over.getTaskFor ?? (async () => task())

  const deps = {
    config: { mode: 'worker', role: 'guard', worktreeRoot: wtRoot, intervalMs: 1000, ...(over.config ?? {}) },
    log: (m) => log.push(m),
    runGit,
    scope: over.scope ?? 'app',
    hubUrl: () => over.hubUrl ?? 'http://hub.test',
    useHub: () => over.useHub ?? true,
    stageByRole: () => over.stages ?? new Map([['coder', { role: 'coder' }], ['guard', { role: 'guard' }]]),
    repoRootFor: () => over.repoRoot ?? 'C:/repo',
    worktreeRootFor: () => wtRoot,
    mediating: over.mediating ?? new Set(),
    mediateAttempts: over.mediateAttempts ?? new Map(),
    mediateRetryAt: over.mediateRetryAt ?? new Map(),
    maxMediateAttempts: over.maxMediateAttempts ?? 2,
    safeComment: async (id, text, scopeFor) => { comments.push({ id, text, scope: scopeFor }) },
    advanceTo: async (id, by, scopeFor) => { advances.push({ id, by, scope: scopeFor }) },
    activity: (kind, id, text) => { activities.push({ kind, id, text }) },
    getTask: (id, scopeFor) => getTaskImpl(id, scopeFor),
    listTasks: async (scopeFor) => (over.tasksFor ? over.tasksFor(scopeFor) : []),
    startOneShot: async (label, prompt, schema, cwd) => {
      oneShots.push({ label, prompt, cwd })
      return over.oneShotResult ?? { status: 'done', summary: '已合并' }
    },
    now: () => over.now ?? 1_000_000_000,
  }
  const m = createMergeMediation(deps)
  return { m, wtRoot, log, comments, activities, advances, oneShots, runGit, deps, cleanup: () => rmSync(wtRoot, { recursive: true, force: true }) }
}

// ── 静态契约 ─────────────────────────────────────────────────────────────────

test('MEDIATOR_SCHEMA：调解员只回报结论，不回报"它跑了什么命令"', () => {
  assert.equal(MEDIATOR_SCHEMA.type, 'object')
  assert.deepEqual(MEDIATOR_SCHEMA.required, ['status', 'summary'])
  assert.deepEqual(MEDIATOR_SCHEMA.properties.status.enum, ['done', 'failed'])
  // additionalProperties:false 是刻意的：调解员**不许跑 git**（git 由守护在主仓库执行），
  // 所以它的输出里不该有"我执行了 X"这种字段。
  assert.equal(MEDIATOR_SCHEMA.additionalProperties, false)
})

test('模块出口齐全：拆出去的能力一个都没少', () => {
  const { m, cleanup } = harness()
  for (const k of ['refreshSpaceRepos', 'mediationCtxFor', 'isMediatableMergeFail',
    'preserveWorktreeLoose', 'mediateReview', 'mediatorRecoverWorker', 'sweepMediation']) {
    assert.equal(typeof m[k], 'function', `缺 ${k}`)
  }
  cleanup()
})

// ── isMediatableMergeFail ────────────────────────────────────────────────────

test('可调解判定：只有"停下等人且确实合入失败过、且人还没来过"的才算', () => {
  const { m, cleanup } = harness()
  const bad = [
    ['没停在 in_review', task({ status: 'in_progress' })],
    ['被将军 hold', task({ hold: true })],
    ['没有角色', task({ role: null })],
    ['角色不在本实例流水线里', task({ role: 'nobody' })],
    ['评论里没有失败标记', task({ comments: [{ by: 'g', at: '', text: '随便一句' }] })],
  ]
  for (const [why, t] of bad) assert.equal(m.isMediatableMergeFail(t), false, why)
  assert.equal(m.isMediatableMergeFail(task()), true, '基线任务应当可调解')
  cleanup()
})

test('★ 放弃标记排除：重启后内存计数清空，也不得再自动调解', () => {
  // 判定里排掉 🛑 是为了让「已放弃」跨重启成立——`mediateAttempts` 是内存 Map，
  // 重启就没了；如果判定不看评论，一个已经放弃过 2 次的任务会在重启后
  // 重新开始调解，无限循环。
  const { m, cleanup } = harness()
  const t = task({ comments: [
    { by: 'g', at: '', text: '已合入，但自动合入主分支失败' },
    { by: 'guard', at: '', text: '🛑 调解已自动重试 2 次仍未成功，任务留在 in_review 请将军人工处理' },
  ] })
  assert.equal(m.isMediatableMergeFail(t), false)
  cleanup()
})

test('★ 人已介入就不抢：将军（publicMode）或任何非守护评论者（worker 模式）', () => {
  // 两处 `laterHuman` 的**枚举对象不同**，而且都对：
  //   · publicMode（公共调解员跨空间跑）→ 只有将军 `by==='general'` 算人；
  //     因为公共调解员不认识各空间的守护角色名，放宽会把守护自己的评论当成"人"。
  //   · worker 模式 → 除自己以外的**任何**评论者都算人（此时本实例就是那个守护）。
  const { m, cleanup } = harness()
  const base = [{ by: 'guard', at: '', text: '已合入，但自动合入主分支失败' }]

  // publicMode：守护角色的评论**不算**人介入
  const t1 = task({ comments: [...base, { by: 'guard', at: '', text: '重试中' }] })
  assert.equal(m.isMediatableMergeFail(t1, true), true, 'publicMode 下守护评论不算人工介入')
  // publicMode：将军评论算
  const t2 = task({ comments: [...base, { by: 'general', at: '', text: '我来看看' }] })
  assert.equal(m.isMediatableMergeFail(t2, true), false, 'publicMode 下将军评论 = 人工介入')

  // worker 模式：非本守护角色的评论算人介入
  const t3 = task({ comments: [...base, { by: 'general', at: '', text: '我来看看' }] })
  assert.equal(m.isMediatableMergeFail(t3, false), false, 'worker 模式下他人评论 = 人工介入')
  // worker 模式：本守护自己后续发的调解进度评论**不算**人介入
  const t4 = task({ comments: [...base, { by: 'guard', at: '', text: '🛠 守护调解员接管' }] })
  assert.equal(m.isMediatableMergeFail(t4, false), true, '守护自己的调解评论不该挡住重试')
  cleanup()
})

test('★ stageByRole 走取值函数：换流水线后判定立刻用新的（快照会静默用旧的）', () => {
  // 这条钉住的是一个**不报错**的失效：`stageByRole` 在原文件里是 `let`，
  // 换流水线来源时整个 Map 被**重新赋值**（`stageByRole = new Map(...)`）。
  // 如果构造时把 Map 传值进来，调解模块会永远认为"这个角色不在流水线里"
  // → 永远判不可调解 → 任务静静躺在 in_review，没有任何报错。
  //
  // ★ 夹具必须**换掉整个 Map**，不能只往同一个 Map 里加键。
  //   我第一版就是 `mutable.set(...)`，而"取值函数"与"快照"在那种夹具下
  //   拿到的是**同一个 Map 对象**，于是两种实现都通过——那条用例等于没测。
  //      > 一个"在同一个 Map 上增删元素"的替身，
  //      > 与一个"换掉整个 Map"的替身，在"取值函数 vs 快照"这件事上是同一个东西——
  //      > 只不过前者会让快照实现看起来也是对的。
  const h = harness()
  let stages = new Map() // 起手**空**：archive 还不是本实例的流水线角色
  const m2 = createMergeMediation({ ...h.deps, stageByRole: () => stages })
  assert.equal(m2.isMediatableMergeFail(task({ role: 'archive' })), false, '此时 archive 不在流水线里')
  stages = new Map([['archive', { role: 'archive' }]]) // ★ 整个换掉，与 index.ts 的真实改写一致
  assert.equal(m2.isMediatableMergeFail(task({ role: 'archive' })), true, '换流水线后必须立刻生效')
  h.cleanup()
})

test('★ hubUrl / useHub 也走取值函数：detectHub 探测到 hub 之后调解员必须跟上', async () => {
  // 同一个失效模式的另两个实例：`detectHub()` 探测成功后把 `hubUrl` 与 `useHub`
  // 一起改写。快照住这两个值的调解模块会**永远走不到 hub 调解路径**——
  // 症状是"多空间的任务没人调解"，而日志里一行错都没有。
  const h = harness()
  let useHub = false
  let hub = 'http://a.test'
  const seen = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({ spaces: [] }) } }
  const m2 = createMergeMediation({ ...h.deps, useHub: () => useHub, hubUrl: () => hub })
  try {
    // ① 还没探测到 hub → 不联网
    await m2.refreshSpaceRepos()
    assert.deepEqual(seen, [], 'useHub=false 时不该发请求')

    // ② 探测成功（两个 let 一起被改写）→ 立刻生效
    useHub = true
    await m2.refreshSpaceRepos()
    assert.deepEqual(seen, ['http://a.test/api/spaces'])

    // ③ hub 换地址 → 下一次请求就走新地址
    hub = 'http://b.test'
    await m2.refreshSpaceRepos()
    assert.deepEqual(seen.at(-1), 'http://b.test/api/spaces', '换 hub 地址后必须立刻生效')
  } finally { globalThis.fetch = origFetch; h.cleanup() }
})

// ── mediationCtxFor ─────────────────────────────────────────────────────────

test('仓库上下文：worker 模式认本实例仓库，mediator 模式只认已绑定空间', () => {
  const w = harness({ config: { mode: 'worker' }, repoRoot: 'C:/r' })
  assert.deepEqual(w.m.mediationCtxFor('任意'), { root: 'C:/r', wtRoot: w.wtRoot })
  w.cleanup()

  const mm = harness({ config: { mode: 'mediator' } })
  // 空间缓存还没刷新 → 任何空间都没有绑定 → null（跳过该任务）
  assert.equal(mm.m.mediationCtxFor('app'), null, '未绑定空间必须返回 null 而不是回落到本实例仓库')
  mm.cleanup()
})

// ── preserveWorktreeLoose（T-116 的兜底）────────────────────────────────────

test('★ 保全：目录不存在 / 干净 / 已提交 / 只能复制 —— 四条路径都要走对', async () => {
  // T-116 现场：调解员 `worktree remove --force` 时把从未进过 commit 的 review 文档
  // 连文件带目录删掉。这个函数是那次事故的兜底，所以四条路径都得有用例。
  const h = harness()
  try {
    // ① 目录不存在
    assert.deepEqual(await h.m.preserveWorktreeLoose('C:/r', join(h.wtRoot, 'nope'), 'T-1'),
      { saved: false, detail: 'no worktree dir' })

    // ② 干净
    const h2 = harness({ runGit: gitStub([['status --porcelain', { out: '' }]]) })
    const dirtyDir = join(h2.wtRoot, 'T-1')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dirtyDir, { recursive: true }); writeFileSync(join(dirtyDir, 'a.md'), 'x')
    assert.deepEqual(await h2.m.preserveWorktreeLoose('C:/r', dirtyDir, 'T-1'),
      { saved: false, detail: 'clean' }, '干净的 worktree 不该被"保全"')
    h2.cleanup()

    // ③ 能提交 → 提交到 w/<id>（后续 merge 自然带上，文档类产物最稳）
    const h3 = harness({
      runGit: gitStub([
        ['status --porcelain', { out: ' M docs/x.md' }],
        ['rev-parse --verify w/T-1', { code: 0 }],
        ['add -A', { code: 0 }],
        ['commit -m', { code: 0 }],
      ]),
    })
    const d3 = join(h3.wtRoot, 'T-1'); mkdirSync(d3, { recursive: true }); writeFileSync(join(d3, 'a.md'), 'x')
    assert.deepEqual(await h3.m.preserveWorktreeLoose('C:/r', d3, 'T-1'), { saved: true, via: 'commit' })
    h3.cleanup()

    // ④ 分支不存在（commit 不可行）→ 整目录复制到 .lost-<id>-<ts>
    const h4 = harness({ now: 1700000000000, runGit: gitStub([['status --porcelain', { out: ' M docs/x.md' }], ['rev-parse --verify', { code: 1 }]]) })
    const d4 = join(h4.wtRoot, 'T-1'); mkdirSync(d4, { recursive: true }); writeFileSync(join(d4, 'a.md'), 'x')
    const r4 = await h4.m.preserveWorktreeLoose('C:/r', d4, 'T-1')
    assert.equal(r4.saved, true); assert.equal(r4.via, 'copy')
    // 目录名用**注入的时钟**：这同时证明 `now` 注入是真的接上了（用 Date.now 会得到另一个名字）
    assert.equal(r4.detail, join(h4.wtRoot, '.lost-T-1-1700000000000'))
    assert.equal(existsSync(r4.detail), true, '复制出来的保全目录必须真的存在')
    h4.cleanup()
  } finally { h.cleanup() }
})

test('保全失败不抛：兜底逻辑自己出错时不能让调解把守护带崩', async () => {
  const h = harness({ runGit: async () => { throw new Error('git 没了') } })
  try {
    const d = join(h.wtRoot, 'T-1')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(d, { recursive: true })
    const r = await h.m.preserveWorktreeLoose('C:/r', d, 'T-1')
    assert.equal(r.saved, false)
    assert.match(r.detail, /git 没了/)
    assert.equal(h.log.some((l) => l.includes('保全失败')), true)
  } finally { h.cleanup() }
})

// ── mediateReview ───────────────────────────────────────────────────────────

test('调解成功路径：无冲突干净合入 → 清 worktree/分支 → 推进 done', async () => {
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['diff --name-only HEAD', { out: '' }],
    ['merge --no-ff', { code: 0 }],
  ])
  const h = harness({ runGit })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.deepEqual(h.advances, [{ id: 'T-1', by: 'coder', scope: 'app' }])
    assert.equal(h.comments.at(-1).text.includes('✅ 调解完成'), true)
    assert.equal(h.activities.at(-1).kind, 'done')
    // 分支真的被删了（清理干净）
    assert.equal(runGit.calls.some((c) => c.args.join(' ') === 'branch -D w/T-1'), true)
  } finally { h.cleanup() }
})

test('★ 完整性闸门：合入后 HEAD 与 w/<id> 仍有差异 → **保留分支**、保全产物、留人工', async () => {
  // 这条是 T-116 的正面教训：如果解决冲突后的提交变成了单亲提交（丢了 w/<id> 的树），
  // 静默 `branch -D` 就等于把 worker 的产出永久删掉。所以差异非空时
  // **绝不删分支**——宁可留一个需要人工合入的任务。
  //
  // ★ 夹具的注意点（我第一版就写错了）：这个闸门只在**冲突解决路径**上（步骤 3c→4）。
  // 干净合入路径（3a）没有这道检查，而且不需要——那条路上的
  // `git merge --no-ff` 由 git 自己保证产出一个**双亲**提交，
  // 不存在"树丢了"的形态。所以夹具必须让 merge 先失败，才走得到闸门。
  //   > 一个"在不需要它的路径上也有"的检查，与一个"只在需要它的路径上"的检查，
  //   > 在用例全绿的时候长得一样——只不过前者会让你以为干净合入也被保护着。
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['merge --no-ff', { code: 1, err: 'CONFLICT' }],
    ['diff --name-only --diff-filter=U', { out: 'docs/review/T-1-REVIEW.md' }],
    ['grep -l ^<<<<<<<', { out: '' }],
    ['add', { code: 0 }],
    ['commit --no-edit', { code: 0 }],
    // 提交之后：HEAD 与 w/T-1 仍有差异 = 产出没随提交落库
    ['diff --name-only HEAD w/T-1', { out: 'docs/review/T-1-REVIEW.md' }],
  ])
  const h = harness({ runGit })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.deepEqual(h.advances, [], '有未落库产出时不得推进 done')
    assert.equal(runGit.calls.some((c) => c.args.join(' ') === 'branch -D w/T-1'), false,
      '★ 分支必须保留（这是人工核查的唯一凭据）')
    const last = h.comments.at(-1).text
    assert.match(last, /未随提交落库/)
    assert.match(last, /分支 w\/T-1 已保留/)
    assert.match(last, /T-1-REVIEW\.md/)
    assert.equal(h.activities.at(-1).kind, 'blocked')
  } finally { h.cleanup() }
})

test('冲突标记未清 → 回退合并态，不提交、不推进', async () => {
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['diff --name-only HEAD', { out: '' }],
    ['merge --no-ff', { code: 1, err: 'CONFLICT' }],
    ['diff --name-only --diff-filter=U', { out: 'docs/a.md' }],
    ['grep -l ^<<<<<<<', { out: 'docs/a.md:1:<<<<<<<' }],
  ])
  const h = harness({ runGit })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.deepEqual(h.advances, [])
    assert.match(h.comments.at(-1).text, /仍有冲突标记未清除/)
    assert.equal(h.activities.at(-1).kind, 'blocked')
    assert.equal(runGit.calls.some((c) => c.args[0] === 'commit'), false, '标记还在就不该提交')
  } finally { h.cleanup() }
})

test('非内容冲突（分支不存在等）→ 不派调解员，直接回退人工', async () => {
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['diff --name-only HEAD', { out: '' }],
    ['merge --no-ff', { code: 1, err: 'not something we can merge' }],
    ['diff --name-only --diff-filter=U', { out: '' }],
  ])
  const h = harness({ runGit })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.equal(h.oneShots.length, 0, '没有冲突文件就不该派调解员（花了模型调用还解决不了）')
    assert.match(h.comments.at(-1).text, /非内容冲突/)
    assert.equal(h.activities.at(-1).kind, 'blocked')
  } finally { h.cleanup() }
})

test('内容冲突且调解员解决成功 → 提交、清理、推进 done', async () => {
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['diff --name-only HEAD', { out: '' }],
    ['merge --no-ff', { code: 1, err: 'CONFLICT' }],
    ['diff --name-only --diff-filter=U', { out: 'docs/a.md' }],
    ['grep -l ^<<<<<<<', { out: '' }],
    ['add', { code: 0 }],
    ['commit --no-edit', { code: 0 }],
    ['diff --name-only HEAD w/T-1', { out: '' }],
  ])
  const h = harness({ runGit })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.equal(h.oneShots.length, 1)
    assert.equal(h.oneShots[0].label, 'mediator:T-1')
    assert.deepEqual(h.advances, [{ id: 'T-1', by: 'coder', scope: 'app' }])
    assert.equal(runGit.calls.some((c) => c.args.join(' ') === 'branch -D w/T-1'), true)
  } finally { h.cleanup() }
})

test('调解员没解决（返回 failed）→ 回退合并态，不提交', async () => {
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['diff --name-only HEAD', { out: '' }],
    ['merge --no-ff', { code: 1, err: 'CONFLICT' }],
    ['diff --name-only --diff-filter=U', { out: 'docs/a.md' }],
  ])
  const h = harness({ runGit, oneShotResult: { status: 'failed', summary: '', whyFailed: '看不懂' } })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.deepEqual(h.advances, [])
    assert.match(h.comments.at(-1).text, /冲突文件未能自动解决/)
    assert.equal(runGit.calls.some((c) => c.args[0] === 'commit'), false)
  } finally { h.cleanup() }
})

test('mediator 模式下空间未绑定仓库 → 跳过，且要说清为什么', async () => {
  const h = harness({ config: { mode: 'mediator' } })
  try {
    await h.m.mediateReview(task(), 'unknown-space')
    assert.deepEqual(h.advances, [])
    assert.equal(h.comments.length, 0, '连接管评论都不该发（这条任务本来就不归这个调解员）')
    assert.equal(h.log.some((l) => l.includes('未绑定本地仓库')), true)
  } finally { h.cleanup() }
})

test('调解过程抛错 → 记日志 + 尽力回退合并态，不让守护崩', async () => {
  const runGit = gitStub([
    ['worktree list', { out: '' }],
    ['diff --name-only HEAD', { out: '' }],
    ['merge --no-ff', () => { throw new Error('磁盘满了') }],
  ])
  const h = harness({ runGit })
  try {
    await h.m.mediateReview(task(), 'app')
    assert.equal(h.log.some((l) => l.includes('调解异常')), true)
    // ★ 断言**次数**而不是 `some(...)`：步骤 0 本来就会 abort 一次，
    // 所以 `some` 在"异常路径完全没回退"时也是绿的——那样这条用例等于没测。
    //   > 一个 `some(...)` 形式的断言，与一个"真的数了次数"的断言，
    //   > 在被测调用恰好已经发生过一次时，读数是同一个东西。
    const aborts = runGit.calls.filter((c) => c.args.join(' ') === 'merge --abort').length
    assert.equal(aborts, 2, `异常路径必须再 attempt 一次回退（否则主仓库留在冲突态，后续合入全被挡住）；实际 ${aborts} 次`)
    assert.match(h.comments.at(-1).text, /调解异常/)
  } finally { h.cleanup() }
})

// ── refreshSpaceRepos + sweepMediation ──────────────────────────────────────

test('★ sweepMediation：退回期内不调解（同一任务不会每轮都去撞 git）', async () => {
  const now = 1_000_000_000
  const h = harness({
    config: { mode: 'mediator', intervalMs: 1000 },
    now,
    mediateRetryAt: new Map([['T-1', now - 1000]]), // 距上次失败仅 1s < 6*intervalMs
    tasksFor: () => [task({ scope: 's1' })],
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ spaces: [{ id: 's1', localDir: 'C:/s1' }] }) })
  try {
    await h.m.sweepMediation()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(h.advances, [], '退避期内不得调解')
  } finally { globalThis.fetch = origFetch; h.cleanup() }
})

test('★ sweepMediation：已达上限 → 只留一条 🛑 提示，且置 24h 哨兵（不每轮刷评论）', async () => {
  const now = 1_000_000_000
  const retryAt = new Map()
  const h = harness({
    config: { mode: 'mediator', intervalMs: 1000 },
    now,
    mediateAttempts: new Map([['T-1', 2]]),
    mediateRetryAt: retryAt,
    tasksFor: () => [task({ scope: 's1' })],
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ spaces: [{ id: 's1', localDir: 'C:/s1' }] }) })
  try {
    await h.m.sweepMediation()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(h.advances, [])
    assert.equal(h.comments.length, 1)
    assert.match(h.comments[0].text, /🛑/)
    assert.equal(retryAt.get('T-1'), now + 24 * 60 * 60 * 1000, '哨兵必须落在未来 24h')
    // 第二轮：哨兵还没到 → 不再重复提示
    await h.m.sweepMediation()
    await new Promise((r) => setImmediate(r))
    assert.equal(h.comments.length, 1, '★ 每轮刷评论会把看板淹掉')
  } finally { globalThis.fetch = origFetch; h.cleanup() }
})

test('★ sweepMediation：一轮最多调解一个（跨空间串行化 git 合并）', async () => {
  // 主仓库的合并是**全局**互斥的：两个空间的调解同时跑会互相踩 merge 冲突态。
  const h = harness({
    config: { mode: 'mediator', intervalMs: 1000 },
    config2: null,
    tasksFor: (scopeFor) => [task({ id: `T-${scopeFor}`, scope: scopeFor })],
    runGit: gitStub([
      ['worktree list', { out: '' }],
      ['diff --name-only HEAD', { out: '' }],
      ['merge --no-ff', { code: 0 }],
      ['rev-parse --show-toplevel', { code: 0, out: 'C:/s' }],
    ]),
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ spaces: [{ id: 's1', localDir: 'C:/s1' }, { id: 's2', localDir: 'C:/s2' }] }),
  })
  try {
    await h.m.sweepMediation()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(h.advances.length, 1, `一轮只能调解一个，实际 ${h.advances.length}`)
  } finally { globalThis.fetch = origFetch; h.cleanup() }
})

test('sweepMediation：非 mediator 模式 / hub 不可达 → 什么都不做', async () => {
  const w = harness({ config: { mode: 'worker' } })
  await w.m.sweepMediation()
  assert.deepEqual(w.advances, []); w.cleanup()

  const noHub = harness({ config: { mode: 'mediator' }, useHub: false })
  await noHub.m.sweepMediation()
  assert.deepEqual(noHub.advances, []); noHub.cleanup()
})

test('refreshSpaceRepos：/api/spaces 拿不到时保留旧缓存（不把已绑定的空间清空）', async () => {
  // 这条钉住的是"hub 抖一下"的后果：如果失败路径顺手清了缓存，
  // 所有在办任务的调解会在这段时间里全部变成"空间未绑定"而被跳过。
  const h = harness({ config: { mode: 'mediator' } })
  const origFetch = globalThis.fetch
  let mode = 'ok'
  globalThis.fetch = async () => {
    if (mode === 'ok') return { ok: true, json: async () => ({ spaces: [{ id: 's1', localDir: 'C:/s1' }] }) }
    throw new Error('network down')
  }
  try {
    await h.m.refreshSpaceRepos()
    assert.deepEqual(h.m.spaceIds(), ['s1'])
    mode = 'down'
    await h.m.refreshSpaceRepos()
    assert.deepEqual(h.m.spaceIds(), ['s1'], '★ 刷新失败不得清空已有绑定')
    assert.equal(h.log.some((l) => l.includes('刷新失败')), true)
  } finally { globalThis.fetch = origFetch; h.cleanup() }
})

// ── mediatorRecoverWorker ───────────────────────────────────────────────────

test('调解员处理重派：把最近失败线索喂给它，修好了才算 fixed', async () => {
  const h = harness({
    runGit: gitStub([['rev-parse --show-toplevel', { code: 0, out: 'C:/s' }]]),
    config: { mode: 'worker' },
    getTaskFor: async () => task({ comments: [{ by: 'guard', at: '2026-01-01', text: '又失败了' }] }),
  })
  try {
    const r = await h.m.mediatorRecoverWorker('T-1', 'app')
    assert.equal(r.fixed, true)
    assert.equal(h.oneShots.length, 1)
    assert.match(h.oneShots[0].prompt, /又失败了/, '必须把真实线索喂进去，否则它只能瞎猜')
    assert.match(h.oneShots[0].prompt, /不运行任何 git\/shell 命令/, '★ 调解员改文件，git 由守护执行')
  } finally { h.cleanup() }
})

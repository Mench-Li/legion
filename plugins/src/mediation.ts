// plugins/src/mediation.ts
// ============================================================================
// PRT-315（第 1 个切片）：**合入调解**（交接边界）
//
// ## 这一批在做什么
//
// `plugins/src/index.ts` 3700 行，其中 `spaceWorker()` 一个函数约 3000 行——
// 它是评审闸门点名的热点文件之一。spec §阶段 3 的 PRT-315 要求
// 「按仓储、状态机、workspace、验收和交接边界拆分，**每次只迁移一个切片**」。
//
// 本文件是**第 1 个切片**，取「交接边界」：中间阶段任务合入主分支失败后的
// 自动调解（公共调解员 + worker 内嵌调解两条路径共用这一套原语）。
//
// ## 这个模块**没有**改变任何行为
//
// 代码逐段搬过来，唯一的改动是把原先从 `spaceWorker` 闭包里**隐式**捕获的
// 东西变成**显式**依赖。这不是洁癖：
//
//   > 一个从 3000 行闭包里隐式捕获十几个名字的代码块，
//   > 与一个把这些名字写在接口上的代码块，在运行时是同一个东西——
//   > 只不过前者的"它到底依赖什么"这个问题，只有把整个闭包读完才能回答。
//
// 拆分的收益不是行数变少（行数几乎不变），是**依赖变成了可读的、可断言的**。
//
// ## 依赖分三类，各自有各自的理由
//
// ① **纯函数/工具**（`log` / `runGit` / `now` / fs 原语）：直接注入，没有别的选择。
// ② **可变状态**（`hubUrl` / `useHub` / `stageByRole`）：**传的是取值函数而不是值**。
//    这三个在原文件里是 `let` 且在运行期会被改（`detectHub()` 探测成功后改写
//    `hubUrl` 与 `useHub`；`refreshSpacePipeline()` 换掉 `stageByRole`）。
//    传值 = 模块从构造那一刻起就看着一份**冻结的旧快照**，而症状是
//    "探测到 hub 了但调解员还是不走 hub"——不报错，只是永远用不上。
//
//        > 一个"构造时快照了可变配置"的模块，
//        > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
//        > 只不过前者会在配置变化之后，安静地继续按旧的来。
//
// ③ **兄弟能力**（`safeComment` / `advanceTo` / `activity` / `getTask` /
//    `listTasks` / `startOneShot`）：这些仍属于 worker 的上下文（它们要写
//    hub、要跑 subagent），不该跟着调解一起搬。它们**故意**留在 `index.ts`，
//    由构造点注入——调解模块只声明"我需要一个能安全发评论的东西"，
//    不关心它是怎么实现的。这也让本模块可以只用替身测。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// `Config` 是 `index.ts` 里由 zod schema 推出来的值（`z.object(...)`），
// 从本模块 import 它会形成**真的**运行时循环依赖。所以这里只声明
// 本切片真正读的那几个字段。
//
// 这不会造成漂移：调用点传的是**真的** `Config`，TypeScript 在那个赋值处
// 校验可赋值性——`config.intervalMs` 被改名的那天，编译会红在**调用点**，
// 而不是让这里安静地读到 `undefined`。
// ============================================================================

import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { StageDef, Task } from './types.js'

/**
 * 调解员输出 schema 的**形状**——本模块自己声明，不从 `@deepseek-ai/dsh-tools` import。
 *
 * ## 为什么不 import `ObjectJsonSchema`
 *
 * PRT-108 的棘轮门禁（`scripts/ci/dsh-boundary.mjs`）把 `@deepseek-ai/dsh-tools`
 * 算作「DSH 执行面记号」，基线只允许既有文件持有它；**新增文件出现执行面记号直接红**。
 * 这个文件就是新增文件，所以：
 *
 *   > 一个"新增文件里多一行 `import type`"的改动，
 *   > 与一个"插件层开始自己长 DSH 执行面依赖"的改动，在棘轮门禁眼里是同一个东西——
 *   > 只不过前者根本不影响运行时（类型会被完全抹掉）。
 *
 * 与其去 `--update-baseline` 把它洗白（那正是门禁设计上要防住的），
 * 不如让本模块**真的**不依赖 DSH：它只声明自己产出的那两种节点。
 *
 * ## 这样并不比 import 弱
 *
 * `mediation.ts` 不再知道 DSH 的子集定义，但**接线点**（`index.ts` 构造
 * `createMergeMediation` 时传入真实的 `startOneShot`）会做可赋值性检查：
 * `MediatorSchema` 必须是 `ObjectJsonSchema` 的子类型才编译得过。
 * 于是"DSH 收窄了它的 schema 子集"这件事会在**编译期**、在**那一行**报出来，
 * 而不是让本模块安静地一直以为自己合法。
 *
 *   > 一个"从 DSH import 类型"的模块，
 *   > 与一个"自述形状、由接线点证明兼容"的模块，在编译通过时是同一个东西——
 *   > 只不过前者把耦合藏在一行 import 里，后者把它摆在构造点上。
 */
export interface MediatorSchema {
  type: 'object'
  properties: Record<string, MediatorNode>
  required: string[]
  additionalProperties: boolean
}

/** 本模块实际产出的节点形状（只两种：带枚举的字符串、字符串数组）。 */
export type MediatorNode =
  | { type: 'string'; enum?: string[] }
  | { type: 'array'; items: MediatorNode }

/** 调解员（merge 冲突合入调解）输出：status=done 表示已把冲突文件改为正确的合并结果（未运行 git）。 */
export const MEDIATOR_SCHEMA: MediatorSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    resolvedFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    whyFailed: { type: 'string' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
}

export interface MergeMediationDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    mode: string
    role: string
    worktreeRoot?: string
    intervalMs: number
  }
  log: (msg: string) => void
  runGit: (repoRoot: string, args: string[]) => Promise<{ code: number; out: string; err: string }>
  /** 本 worker 实例的 scope（默认任务空间）。 */
  scope: string
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  hubUrl: () => string
  useHub: () => boolean
  /** 取值函数：换流水线来源时整个 Map 会被替换。 */
  stageByRole: () => Map<string, StageDef>
  repoRootFor: () => string
  worktreeRootFor: () => string
  /** 正在调解中的任务 id（同 `index.ts` 的 worker 循环共享，故由外部持有）。 */
  mediating: Set<string>
  /** 调解重试计数与退避时刻（同上，worker 内嵌调解路径也读它）。 */
  mediateAttempts: Map<string, number>
  mediateRetryAt: Map<string, number>
  maxMediateAttempts: number
  safeComment: (id: string, text: string, scopeFor?: string) => Promise<void>
  advanceTo: (id: string, by: string, scopeFor?: string) => Promise<void>
  activity: (kind: string, taskId: string, text: string) => void
  getTask: (id: string, scopeFor?: string) => Promise<Task>
  listTasks: (scopeFor?: string) => Promise<Task[]>
  startOneShot: <T>(label: string, promptText: string, schema: MediatorSchema, cwd: string) => Promise<T | null>
  now: () => number
}

/** `createMergeMediation` 交回给 `index.ts` 的东西。 */
export interface MergeMediation {
  refreshSpaceRepos: () => Promise<void>
  mediationCtxFor: (taskScope: string) => { root: string; wtRoot: string } | null
  /** 已绑定仓库的空间 id（供 daemon 状态视图展示）。 */
  spaceIds: () => string[]
  isMediatableMergeFail: (t: Task, publicMode?: boolean) => boolean
  preserveWorktreeLoose: (root: string, dir: string, id: string) => Promise<{ saved: boolean; via?: string; detail?: string }>
  mediateReview: (t: Task, taskScope?: string) => Promise<void>
  mediatorRecoverWorker: (taskId: string, taskScope?: string) => Promise<{ fixed: boolean; summary?: string; whyFailed?: string }>
  sweepMediation: () => Promise<void>
}

export function createMergeMediation(deps: MergeMediationDeps): MergeMediation {
  const {
    config, log, runGit, scope, hubUrl, useHub, stageByRole,
    repoRootFor, worktreeRootFor, mediating,
    mediateAttempts, mediateRetryAt, maxMediateAttempts,
    safeComment, advanceTo, activity, getTask, listTasks, startOneShot, now,
  } = deps

  // ── 公共调解员（mode:'mediator'）：跨空间合入调解 ─────────────────────────
  // 不派工、不认领，只做一件事：扫所有空间的在办合入失败任务，逐个自动合入主分支并推进 done。
  // 空间仓库按 /api/spaces 绑定解析（每轮刷新缓存），与 worker 实例的注入 repoRoot 解耦。
  const spaceRepos = new Map<string, { localDir: string; repoRoot: string; worktreeRoot: string }>()

  async function refreshSpaceRepos(): Promise<void> {
    if (!useHub()) return
    try {
      const res = await fetch(`${hubUrl()}/api/spaces`)
      if (!res.ok) return
      const data = await res.json() as { spaces?: Array<{ id: string; localDir?: string }> }
      const next = new Map<string, { localDir: string; repoRoot: string; worktreeRoot: string }>()
      for (const s of data.spaces ?? []) {
        const localDir = typeof s.localDir === 'string' ? s.localDir.trim() : ''
        if (localDir === '') continue
        let repoRoot = localDir
        try {
          const r = await runGit(localDir, ['rev-parse', '--show-toplevel'])
          if (r.code === 0 && r.out.trim().length > 0) repoRoot = r.out.trim()
        } catch { /* 非仓库目录沿用所选目录 */ }
        const wtRoot = config.worktreeRoot || join(repoRoot, '.legion-worktrees')
        next.set(s.id, { localDir, repoRoot, worktreeRoot: wtRoot })
      }
      let changed = next.size !== spaceRepos.size
      if (!changed) for (const [k, v] of next) {
        const old = spaceRepos.get(k)
        if (!old || old.repoRoot !== v.repoRoot || old.worktreeRoot !== v.worktreeRoot) { changed = true; break }
      }
      if (changed) {
        for (const [k, v] of next) spaceRepos.set(k, v)
        for (const k of [...spaceRepos.keys()]) if (!next.has(k)) spaceRepos.delete(k)
        log(`公共调解员：空间仓库缓存刷新（${[...spaceRepos.entries()].map(([k, v]) => `${k}→${v.repoRoot}`).join('；') || '空'}）`)
      }
    } catch (e) {
      log(`公共调解员：空间仓库缓存刷新失败：${String(e)}`)
    }
  }

  /** 任务所属空间的可调解仓库上下文（无绑定返回 null，跳过该任务）。 */
  function mediationCtxFor(taskScope: string): { root: string; wtRoot: string } | null {
    if (config.mode !== 'mediator') return { root: repoRootFor(), wtRoot: worktreeRootFor() }
    const hit = spaceRepos.get(taskScope)
    return hit ? { root: hit.repoRoot, wtRoot: hit.worktreeRoot } : null
  }

  /** 已绑定仓库的空间 id（daemon 状态视图用；此前直接读 `spaceRepos.keys()`）。 */
  function spaceIds(): string[] { return [...spaceRepos.keys()] }

  // ── 合入调解（in_review merge-fail 自动处理，替代将军手动 git 合入）────────────────────────
  // 背景：中间阶段任务自动合入主分支失败 → 停 in_review 等人工。将军已授权守护用「调解员」自动处理
  // 这一类机械性 + 半语义问题（脏工作区挡 merge / 内容冲突），仅在调解多次失败后才回到将军。
  // 判定：任务 in_review、评论含「自动合入主分支失败」标记、将军未 hold、切片/流水线角色。
  // publicMode（mode:'mediator' 公共调解员）：不依赖本实例 roles.json，任何空间带标记的任务都可调；
  // 人工介入 = 将军（by==='general'）在失败标记后的评论——其余都是自动化角色，不视为人。
  const isMediatableMergeFail = (t: Task, publicMode: boolean = false): boolean => {
    if (t.status !== 'in_review' || t.hold) return false
    if (t.role === null) return false
    if (!publicMode && !stageByRole().has(t.role)) return false
    const failIdx = t.comments.findIndex(c =>
      (c.text ?? '').includes('但自动合入主分支失败') || (c.text ?? '').includes('请人工合入并推进'))
    if (failIdx < 0) return false
    // 已达放弃上限（守护/调解员自己发的 🛑，不限评论者——worker 与公共调解员可能角色不同）：
    // 重启后内存计数清空也不得再自动调解，避免无限重试
    if (t.comments.some(c => (c.text ?? '').startsWith('🛑 调解已自动重试'))) return false
    // 将军（或 worker 模式下其他非守护评论者）在失败标记后已介入 → 不抢，留人工
    const laterHuman = publicMode
      ? t.comments.slice(failIdx + 1).some(c => c.by === 'general')
      : t.comments.slice(failIdx + 1).some(c => c.by !== config.role && !c.text.startsWith('🛠 守护调解员'))
    return !laterHuman
  }

  /**
   * 防丢文件加固：强删 worktree 前保全 worker 的未提交/未合入产出（T-116 现场：
   * review 文档登记了产物但从未进任何 commit，调解员 force-remove worktree 时连文件带目录删除 → 内容永久丢失）。
   * 1) 优先把 loose 改动提交到 w/<id>（后续 merge 自然带上，文档类产物最稳）；
   * 2) commit 不可行（分支缺失 / git 写失败 / 沙箱禁写共享 .git 等）→ 整目录复制到 .legion-worktrees/.lost-<id>-<ts> 保全。
   * 返回 {saved, via, detail}；任何失败都不抛，仅记日志（保全是尽力而为的兜底）。
   */
  async function preserveWorktreeLoose(root: string, dir: string, id: string): Promise<{ saved: boolean; via?: string; detail?: string }> {
    try {
      if (!existsSync(dir)) return { saved: false, detail: 'no worktree dir' }
      const st = await runGit(dir, ['status', '--porcelain'])
      const dirty = (st.out ?? '').trim()
      if (dirty.length === 0) return { saved: false, detail: 'clean' }
      // 1) 提交到 w/<id>：需分支存在
      const branchOk = (await runGit(root, ['rev-parse', '--verify', `w/${id}`])).code === 0
      if (branchOk) {
        const add = await runGit(dir, ['add', '-A'])
        if (add.code === 0) {
          const commit = await runGit(dir, ['commit', '-m', `${id}：调解接管前保全未提交产物`])
          if (commit.code === 0) return { saved: true, via: 'commit' }
          log(`${id} 保全：w/${id} commit 失败（${(commit.err || commit.out).trim().slice(0, 120)}）→ 转目录复制`)
        }
      }
      // 2) 目录复制保全
      const lostDir = join(dirname(dir), `.lost-${id}-${now()}`)
      cpSync(dir, lostDir, { recursive: true, force: true })
      return { saved: true, via: 'copy', detail: lostDir }
    } catch (e) {
      log(`${id} 保全失败：${String(e)}`)
      return { saved: false, detail: String(e) }
    }
  }

  /** 调解员主流程：把 in_review merge-fail 任务合入其所属空间的主分支并推进到 done（复用 autoPromote 的 git 原语）。
   *  worker 模式：taskScope 默认本实例 scope（仓库 ctx=repoRootFor）；
   *  mediator 模式：taskScope=任务所属空间，仓库 ctx 从 spaceRepos 解析（无绑定则跳过）。
   */
  async function mediateReview(t: Task, taskScope: string = scope): Promise<void> {
    const id = t.id
    const ctxRepo = mediationCtxFor(taskScope)
    if (ctxRepo === null) {
      log(`调解跳过：任务 ${id} 所属空间 ${taskScope} 未绑定本地仓库（公共调解员只处理已绑定仓库的空间）`)
      return
    }
    const root = ctxRepo.root
    const wtRoot = ctxRepo.wtRoot
    try {
      await safeComment(id, '🛠 守护调解员接管：正在自动合入主分支（解决冲突后推进），将军无需操作', taskScope)
      const dir = join(wtRoot, id)
      // 0. 防御：清上次遗留冲突态
      await runGit(root, ['merge', '--abort'])
      // 1. 若 worktree 仍绑定分支，先解除（防止 merge 冲突态被 worker 误操作）。
      //    防丢文件：解除绑定=force remove，若 worker 有未提交产出，先提交/复制保全（T-116 现场教训）。
      const wt = (await runGit(root, ['worktree', 'list'])).out
      if (wt.includes(`.legion-worktrees/${id}`) || wt.includes(`.legion-worktrees\\${id}`)) {
        const pres = await preserveWorktreeLoose(root, dir, id)
        if (pres.saved) log(`${id} 调解：强删 worktree 前已保全未提交产物（${pres.via}${pres.detail ? ' → ' + pres.detail : ''}）`)
        await runGit(root, ['worktree', 'remove', '--force', dir])
        log(`${id} 调解：已解除残留 worktree 绑定`)
      }
      // 2. 脏工作区保护：若有已跟踪改动挡住 merge（git 会拒绝），先定向 stash → merge → pop。
      //    只取已跟踪文件的改动（git diff HEAD），未跟踪文件不参与 merge 且会让 stash pathspec 失败。
      const dirtyPaths = (await runGit(root, ['diff', '--name-only', 'HEAD'])).out.trim()
        .split('\n').map(l => l.trim()).filter(p => p.length > 0 && !p.startsWith('"'))
      const stashDone: string[] = []
      if (dirtyPaths.length > 0) {
        const stash = await runGit(root, ['stash', 'push', '-m', `mediator-${id}`, '--', ...dirtyPaths])
        if (stash.code === 0) stashDone.push(...dirtyPaths)
        else log(`${id} 调解：脏工作区暂存失败（继续尝试合并）`)
      }
      // 3. 合并
      const merge = await runGit(root, ['merge', '--no-ff', `w/${id}`, '-m', `promote ${id} (mediator)`])
      if (merge.code === 0) {
        // 3a. 合并干净 → 清理 worktree/分支 → 推进 done
        const pres = await preserveWorktreeLoose(root, dir, id)
        if (pres.saved) log(`${id} 调解：干净合入后 worktree 仍有未提交产物，已保全（${pres.via}${pres.detail ? ' → ' + pres.detail : ''}）`)
        await runGit(root, ['worktree', 'remove', '--force', dir])
        await runGit(root, ['branch', '-D', `w/${id}`])
        if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
        await advanceTo(id, t.role ?? config.role, taskScope)
        await safeComment(id, '✅ 调解完成：无冲突干净合入主分支，任务已推进 done', taskScope)
        activity('done', id, '调解合入成功，已推进 done')
        log(`${id} → done（调解员自动合入）`)
        return
      }
      // 3b. 合并冲突或失败 → 检查是否内容冲突
      const conflictFiles = (await runGit(root, ['diff', '--name-only', '--diff-filter=U'])).out.trim().split('\n').filter(Boolean)
      if (conflictFiles.length === 0) {
        // 非内容冲突（如分支被删/不存在）→ 放弃自动处理，回退将军
        await runGit(root, ['merge', '--abort'])
        if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
        await safeComment(id, `⚠ 调解失败：合入遇到非内容冲突（${(merge.err || merge.out).trim().slice(0, 200)}），请将军人工处理`, taskScope)
        activity('blocked', id, '调解失败：非内容冲突')
        return
      }
      // 3c. 真内容冲突 → 派调解员 subagent 解决冲突文件
      const resolve = await dispatchMediator(id, conflictFiles, taskScope)
      if (!resolve) {
        await runGit(root, ['merge', '--abort'])
        if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
        await safeComment(id, '⚠ 调解失败：冲突文件未能自动解决，已回退合并态，请将军人工处理（或稍后重试）', taskScope)
        activity('blocked', id, '调解失败：冲突未能自动解决')
        return
      }
      // 4. 确认冲突标记已清 → 完成合入
      const markers = (await runGit(root, ['grep', '-l', '^<<<<<<<', '--', ...conflictFiles])).out.trim()
      if (markers.length > 0) {
        await runGit(root, ['merge', '--abort'])
        if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
        await safeComment(id, `⚠ 调解失败：仍有冲突标记未清除（${markers}），已回退，请将军人工处理`, taskScope)
        activity('blocked', id, '调解失败：冲突标记残留')
        return
      }
      await runGit(root, ['add', ...conflictFiles])
      const commit = await runGit(root, ['commit', '--no-edit', '-m', `promote ${id} (mediator resolve)`])
      if (commit.code !== 0) {
        await runGit(root, ['merge', '--abort'])
        if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
        await safeComment(id, `⚠ 调解失败：提交合入结果失败（${(commit.err || commit.out).trim().slice(0, 200)}），请将军人工处理`, taskScope)
        activity('blocked', id, '调解失败：提交失败')
        return
      }
      // 完整性闸门：解决冲突的提交必须真正包含 w/<id> 的全部产出。
      // 若 commit 变成了单亲提交（丢失 w/<id> 树，T-116 现场：review 文档从未落库即被强删），
      // HEAD 与 w/<id> 必有差异 → 保留分支 + 保全 + 警告将军，绝不静默 -D 丢弃。
      const missing = (await runGit(root, ['diff', '--name-only', 'HEAD', `w/${id}`])).out.trim()
      if (missing.length > 0) {
        const pres = await preserveWorktreeLoose(root, dir, id)
        await runGit(root, ['worktree', 'remove', '--force', dir])
        // 分支保留（不 -D），供将军人工核查/合入；stash 还原照旧
        if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
        await safeComment(id, `⚠ 调解合入存在未随提交落库的产出（${missing.split('\n').slice(0, 5).join(', ')}${missing.split('\n').length > 5 ? ` …共 ${missing.split('\n').length} 个` : ''}）。分支 w/${id} 已保留未删除${pres.saved ? `，worktree 残留产物已保全（${pres.via}${pres.detail ? ' → ' + pres.detail : ''}）` : ''}，请将军核查后人工合入或转派。`, taskScope)
        activity('blocked', id, '调解合入未完整落库，保留分支待人工')
        log(`${id} 调解：合入后 HEAD 与 w/${id} 仍有差异（${missing.split('\n').length} 个文件），分支保留`)
        return
      }
      const pres = await preserveWorktreeLoose(root, dir, id)
      if (pres.saved) log(`${id} 调解：worktree 仍有未提交产物，已保全（${pres.via}${pres.detail ? ' → ' + pres.detail : ''}）`)
      await runGit(root, ['worktree', 'remove', '--force', dir])
      await runGit(root, ['branch', '-D', `w/${id}`])
      if (stashDone.length > 0) await runGit(root, ['stash', 'pop'])
      await advanceTo(id, t.role ?? config.role, taskScope)
      await safeComment(id, `✅ 调解完成：冲突文件已由调解员解决并合入主分支，任务推进 done（解决：${conflictFiles.join(', ')}）`, taskScope)
      activity('done', id, '调解合入成功（冲突已解决），已推进 done')
      log(`${id} → done（调解员解决 ${conflictFiles.length} 个冲突文件后合入）`)
    } catch (e) {
      log(`${id} 调解异常：${String(e)}`)
      await runGit(root, ['merge', '--abort']).catch(() => undefined)
      await safeComment(id, `⚠ 调解异常（${String(e).slice(0, 150)}），已回退合并态，请将军人工处理`, taskScope)
    }
  }

  /** 派调解 subagent：读取冲突文件两侧，产出正确合并（不运行 git，只改文件内容）。 */
  async function dispatchMediator(taskId: string, conflictFiles: string[], taskScope: string = scope): Promise<boolean> {
    const t = await getTask(taskId, taskScope)
    const ctxRepo = mediationCtxFor(taskScope)
    if (ctxRepo === null) {
      log(`调解跳过：任务 ${taskId} 所属空间 ${taskScope} 未绑定本地仓库`)
      return false
    }
    const root = ctxRepo.root
    const prompt = [
      `你是「合入调解员」。仓库里有任务 ${taskId} 的合入冲突待解决（git merge 已停在冲突态，冲突标记在以下文件中）。`,
      `任务：${t.title}`,
      `冲突文件：${conflictFiles.join(', ')}`,
      '',
      '请逐个打开这些文件，找到 <<<<<<< HEAD … ======= … >>>>>>> w/ 冲突区，判断两侧改动意图：',
      '- 若是同一处各自新增（文档注释等）→ 保留两侧内容合并；',
      '- 若一侧是删除/重构、另一侧是新增 → 按任务目标决定保留谁；',
      '- 若两侧改同一逻辑 → 融合成正确实现（不破坏任一侧的验收标准）。',
      '',
      '规则：只修改冲突文件，去掉所有冲突标记；不改其他文件；不运行任何 git/shell 命令；不要创建新文件。',
      '完成后输出 status=done + resolvedFiles + summary（简述每个文件怎么合的）。',
    ].join('\n')
    const r = await startOneShot<{ status: string; resolvedFiles?: string[]; summary: string; whyFailed?: string }>(
      `mediator:${taskId}`, prompt, MEDIATOR_SCHEMA, root,
    )
    if (r === null || r.status !== 'done') {
      log(`${taskId} 调解员未完成：${r?.whyFailed ?? '无返回'}`)
      return false
    }
    log(`${taskId} 调解员完成：${r.summary}`)
    return true
  }

  /** 调解员处理重派：worker 连续失败时不升级将军，由调解员诊断根因并直接在任务工作树修复（清冲突标记/修编译错误），
   *  修复成功返回 {fixed:true, summary}，调用方据此重新派工；无法修复返回 {fixed:false}。 */
  async function mediatorRecoverWorker(taskId: string, taskScope: string = scope): Promise<{ fixed: boolean; summary?: string; whyFailed?: string }> {
    const t = await getTask(taskId, taskScope)
    const ctxRepo = mediationCtxFor(taskScope)
    if (ctxRepo === null) {
      log(`调解处理重派跳过：任务 ${taskId} 所属空间 ${taskScope} 未绑定本地仓库`)
      return { fixed: false, whyFailed: '无绑定仓库' }
    }
    const root = ctxRepo.root
    const wtDir = join(ctxRepo.wtRoot || join(root, '.legion-worktrees'), taskId)
    const tail = t.comments.slice(-6)
      .map(c => `- [${c.at}] ${c.by}: ${(c.text ?? '').slice(0, 220)}`)
      .join('\n')
    const prompt = [
      `你是「调解员」。军团任务 ${taskId}（${t.title}）的 worker 连续失败多次，请诊断根因并直接修复，以便重新派工。`,
      `任务：${t.title}`,
      `任务工作树：${wtDir}`,
      '',
      `worker 最近失败线索（时间逆序）：`,
      tail || '（无）',
      '',
      '请打开该工作树，找到 worker 反复失败的根本原因：',
      '- git 合并冲突标记（<<<<<<< / ======= / >>>>>>>）残留导致的编译/语法错误——保留两侧正确实现、去掉标记；',
      '- 构建/类型错误——修复到可编译通过；',
      '- 其他导致 worker 无法完成的根因。',
      '',
      '规则：只修改导致失败的少数文件；不包括无关业务代码；不新建文件；不运行任何 git/shell 命令。',
      '完成后输出 status=done + summary（根因与修复方法）；若无法修复输出 status=failed + whyFailed。',
    ].join('\n')
    const r = await startOneShot<{ status: string; summary: string; whyFailed?: string }>(
      `mediator:${taskId}`, prompt, MEDIATOR_SCHEMA, root,
    )
    if (r === null || r.status !== 'done') {
      log(`${taskId} 调解员处理重派未完成：${r?.whyFailed ?? '无返回'}`)
      return { fixed: false, summary: r?.summary, whyFailed: r?.whyFailed }
    }
    log(`${taskId} 调解员处理重派完成：${r.summary}`)
    return { fixed: true, summary: r.summary }
  }

  /**
   * 公共调解员一轮：扫所有已绑定空间的可调解任务，**每轮只调解一个**（全局串行化 git 合并）。
   *
   * 与 `index.ts` worker 循环里那段内嵌调解共用 `mediateAttempts` / `mediateRetryAt` /
   * `mediating`——它们由外部持有并注入，所以两条路径的重试计数是**同一份**。
   */
  async function sweepMediation(): Promise<void> {
    if (config.mode !== 'mediator' || !useHub()) return
    await refreshSpaceRepos()
    if (spaceRepos.size === 0) return // 无任何已绑定仓库的空间 → 无调解目标
    // 汇总所有已绑定空间的可调解任务（公共判定：带 merge-fail 标记的 in_review，不依赖本实例 roles.json；
    // 人工介入 = 将军 by==='general' 评论；空间无仓库绑定的任务天然被过滤——那些空间合入失败需将军人工处理）
    const mediable: Task[] = []
    for (const spaceId of spaceRepos.keys()) {
      let spaceTasks: Task[]
      try {
        spaceTasks = await listTasks(spaceId)
      } catch (e) {
        log(`公共调解员：拉取空间 ${spaceId} 任务失败：${String(e)}`)
        continue
      }
      for (const t of spaceTasks) {
        if (t.scope == null) t.scope = spaceId
        if (!isMediatableMergeFail(t, true) || mediating.has(t.id)) continue
        mediable.push(t)
      }
    }
    if (mediable.length === 0) return
    mediable.sort((a, b) => a.id.localeCompare(b.id))
    for (const t of mediable) {
      const id = t.id
      const attempts = mediateAttempts.get(id) ?? 0
      if (attempts >= maxMediateAttempts) {
        // give-up：任务留给将军人工处理；24h 哨兵只提示一次（重启后内存清空也不得再自动调解——🛑 标记已在判定里排除）
        if ((mediateRetryAt.get(id) ?? 0) < now() - 24 * 60 * 60 * 1000) {
          mediateRetryAt.set(id, now() + 24 * 60 * 60 * 1000)
          void safeComment(id, '🛑 调解已自动重试 2 次仍未成功，任务留在 in_review 请将军人工处理', t.scope ?? scope)
        }
        continue
      }
      if (now() - (mediateRetryAt.get(id) ?? 0) < config.intervalMs * 6) continue // 失败退避期内
      mediating.add(id)
      void (async () => {
        try {
          await mediateReview(t, t.scope ?? scope)
          const after = await getTask(id, t.scope ?? scope).catch(() => undefined)
          if (!after || after.status !== 'done') {
            mediateAttempts.set(id, attempts + 1)
            mediateRetryAt.set(id, now())
          } else {
            mediateAttempts.delete(id)
            mediateRetryAt.delete(id)
          }
        } finally {
          mediating.delete(id)
        }
      })()
      break // 每轮只调解一个（全局串行化 git 合并，跨空间同理）
    }
  }

  return {
    refreshSpaceRepos,
    mediationCtxFor,
    spaceIds,
    isMediatableMergeFail,
    preserveWorktreeLoose,
    mediateReview,
    mediatorRecoverWorker,
    sweepMediation,
  }
}

// plugins/src/workspace.ts
// ============================================================================
// PRT-315（第 4 个切片）：**workspace / worktree 隔离**（workspace 边界）
//
// ## 这一批在做什么
//
// 第 1 个切片（`./mediation.ts`）取了「交接边界」的合入调解；第 2 个切片
// （`./reclamation.ts`）取了「仓储边界」的租约回收；第 3 个切片
// （`./stateMachine.ts`）取了「状态机」。本文件是**第 4 个切片**，取「workspace 边界」：
// 一个任务的**独立工作树**从建到提交的整条生命周期——
//
//   · `prepareWorktree(taskId)`：`w/<taskId>` 分支 worktree 的创建 / 复用 / 重新挂载；
//   · `ensurePrePushGuard()`：拦截 `w/*` 分支 push 的公共钩子（只在 `prepareWorktree` 里被调，
//     故**不对调用方导出**）；
//   · `commitWorktree(taskId, dir, summary)`：把 worktree 里的改动提交回 `w/<taskId>`；
//   · 本 scope 的 workspace 解析：`refreshSpaceBinding()`（hub `/api/spaces` → localDir →
//     `git rev-parse --show-toplevel`）与 `repoRootFor()` / `workspaceFor()` / `worktreeRootFor()`。
//
// 为什么这四件算**同一个边界**：它们回答同一个问题——「这个任务的工作目录到底在哪，
// 里面的改动挂在哪个引用上」。答错一次的代价不是报错，而是**静默地丢/串改动**：
// 复用判定写错 → 上一轮的未提交改动被 `rmSync` 掉；挂载分支写错 → worker 在错误的基线上开工；
// 根解析写错 → worktree 建进了别的仓库，要到合入那一步才发现。
//
// ## 这个模块**没有**改变任何行为
//
// 代码逐段搬过来，除了文件头 §「依赖」写明的注入改写（`spaceBinding` 的读写变取值/置值函数、
// `useHub` / `hubUrl` 变取值函数），一行都没有动：日志串、`activity(...)` 的调用与顺序、
// **git 子进程的调用顺序**（先 `rev-parse --verify w/<id>`，分支在 → `worktree add <dir> w/<id>`，
// 不在 → `worktree add -b w/<id> <dir> HEAD`）、`try/catch` 的吞错范围、以及
// 「失败返回 `null` 由调用方回退」这条契约。
//
// 顺序在这里不是风格问题：调换 `worktree add` 的两种形态、或把 `rev-parse` 挪到清理之后，
// 都会改变「哪一种残留形态会被复用、哪一种会被重建」——而那正是**上一轮部分改动还在不在**的
// 分水岭。所以本切片的用例逐字断言 argv 数组与它们的次序，而不是"git 被调用过"。
//
// ## 依赖：可变状态传**访问器**，并且状态**由调用方持有**
//
// `spaceBinding` 是 `spaceWorker()` 闭包里的 `let`，`refreshSpaceBinding()` 每轮扫单会
// **重新赋值**它。按本切片系列既有口径（见 `mediation.ts` / `stateMachine.ts`），
// 运行期会被重新赋值的绑定一律不传值——但这里比 `useHub` / `stageByRole` 多一层：
// 本模块自己就是那个**写者**，所以注入的是一对访问器 `{ get, set }`，而不是只读 getter。
//
//   · **为什么不改成「返回新值由调用方回写」**：回写会把赋值推到 `refreshSpaceBinding()`
//     的 `return` 之后（也就是 `log(...)` 之后），而原实现的赋值在 `log` **之前**、
//     且只在「值真的变了」时才发生（比较 `localDir` / `repoRoot` 两项）。
//     访问器让赋值留在**原来那一行**，与 `reclamation.ts` 把 `boot.done` 留在动手之前
//     是同一条理由：赋值的**位置**本身是语义（这里的位置还决定了"没变就不记日志"、
//     以及每个读点都**当场取值**而不是构造时快照）。
//
//   · **为什么不是模块级变量**：`superviseSpaces()` 会在**同一进程**里按空间把
//     `spaceWorker` mount 成多个子实例（`index.ts` 的 `mountRunner`），它们共用一个模块注册表。
//     一个模块级绑定会让**空间 A 的仓库根覆盖空间 B 的**——症状是某个空间的 worktree
//     建进了另一个空间的仓库，日志里只会多出一行"绑定刷新"，没有一处报错。
//
//         > 一个"每实例一份"的闭包绑定，
//         > 与一个"每进程一份"的模块级绑定，在只有一个守护实例的部署里是同一个东西——
//         > 只不过多空间部署下，后者会让第二个空间的 worktree 建进第一个空间的仓库。
//
//   · **绑定值本身仍留在 `index.ts` 的闭包里**（本模块只拿到 get/set）。理由不是洁癖：
//     `writeDaemonStatus`（daemon.json 的 `repo` 段）、worker 提示词里的「空间仓库绑定」行、
//     chat 上下文的 `bindingDir` / `bindingMeta` 三处**不属于 workspace 边界**的读者直接读它；
//     把所有权搬进来就要连带改这三处，那是本切片之外的改动。
//
// `useHub` / `hubUrl` 同样传取值函数：`detectHub()` 探测成功后这两个 `let` 都会被改写。
// 传值 = 绑定刷新从构造那一刻起就看着一份冻结的旧快照，症状是"配了 hub 却永远走注入默认仓库"，
// 一处都不报。`config` / `scope` / `runGit` / `log` / `activity` 则传值：前两个是 `const`，
// 后三个是身份稳定的函数（`runGit` 是顶层函数声明，`log` / `activity` 是闭包里的 `const` 箭头）。
//
// ## `runGit` 为什么**留在** `index.ts`
//
// `runGit`（`index.ts` 顶层的进程工具）本切片读它，但**不搬**：
//
//   · 它不专属于 workspace：规范 tombstone 读取、目标镜像的 `.git/info/exclude`、产物登记、
//     验收闸门、自动 promote、重测换基线，以及 `mediation.ts`（经构造点注入）都走同一个
//     `runGit`。搬进来就要让这些**非 workspace 边界**的代码反向 import 本模块，依赖方向反了。
//   · 它是本切片**用例的替身接缝**：`prepareWorktree` 的全部 git 交互都经它一层，
//     于是测试可以逐字断言 argv 与调用顺序，而不必真的建仓库。
//
// 与 `stateMachine.ts` 的 `stageOf` 同一形态：**单一定义留在原处**，由调用点注入。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// 与 `mediation.ts` / `reclamation.ts` / `stateMachine.ts` 同源：`Config` 是 `index.ts` 里
// 由 zod schema 推出来的值，import 它形成**真的**运行时循环依赖。这里只声明本切片真正读的三个
// 字段；调用点传的是**真的** `Config`，TypeScript 在赋值处校验可赋值性——字段改名的那天红在
// **调用点**，而不是让这里安静地读到 `undefined`（`worktreeRoot` 一旦读不到，worktree 会
// 落到仓库根下的默认位置：这是那种"不报错、只是位置不对"的坏症状）。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 本 scope 的空间仓库绑定（`refreshSpaceBinding()` 解析出来的结果）。 */
export interface SpaceBinding {
  localDir: string
  repoRoot: string
  remoteUrl: string
}

/**
 * 绑定状态的读写访问器。**由 `spaceWorker()` 闭包持有**（理由见文件头）：
 * 本模块是那个**写者**，不是那个拥有者。
 */
export interface WorkspaceBindingAccess {
  get: () => SpaceBinding | null
  set: (binding: SpaceBinding | null) => void
}

export interface WorkspaceDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    repoRoot: string
    workspace: string
    worktreeRoot?: string
  }
  log: (msg: string) => void
  /** 顶层进程工具，**单一定义留在 `index.ts`**（理由见文件头）。 */
  runGit: (repoRoot: string, args: string[]) => Promise<{ code: number; out: string; err: string }>
  /** 本 worker 实例的 scope（绑定按它命中空间）。 */
  scope: string
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  useHub: () => boolean
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  hubUrl: () => string
  /** 绑定状态访问器（**每实例一份**，理由见文件头）。 */
  binding: WorkspaceBindingAccess
  activity: (kind: string, taskId: string, text: string) => void
}

/** `createWorkspace` 交回给 `index.ts` 的东西。 */
export interface Workspace {
  refreshSpaceBinding: () => Promise<void>
  repoRootFor: () => string
  workspaceFor: () => string
  worktreeRootFor: () => string
  prepareWorktree: (taskId: string) => Promise<string | null>
  commitWorktree: (taskId: string, dir: string, summary: string) => Promise<boolean>
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  const { config, log, runGit, scope, useHub, hubUrl, binding, activity } = deps

  // ── 空间仓库绑定：每个工作空间可配置自己的「本地文件夹 + 远程仓库」（team-hub /api/spaces，
  //    军团指挥台「空间设置」维护——选文件夹而非手填，自动识别该 git 仓库的远程）。
  //    守护在 hub 模式下每轮扫单刷新本 scope 的绑定：
  //    命中 localDir 时，worker 工作目录 = 该文件夹；隔离仓库根（worktree/pre-push 守卫/LEGION.md/自动 promote）
  //    = 该文件夹所属的 git 仓库根（文件夹本身就是仓库根时二者相同；子目录则向上取 toplevel）。
  //    remoteUrl 只作登记与提示——push 纪律不变（w/* 分支一律禁止 push，本地/私有空间 remoteUrl 为空 = 不进共享仓库）。
  //    未绑定 / hub 不可达时全部回退注入配置（repoRoot/workspace/worktreeRoot）。
  async function refreshSpaceBinding(): Promise<void> {
    if (!useHub()) return
    try {
      const res = await fetch(`${hubUrl()}/api/spaces`)
      if (!res.ok) return
      const data = await res.json() as { spaces?: Array<{ id: string; localDir?: string; remoteUrl?: string }> }
      const hit = (data.spaces ?? []).find(x => x.id === scope)
      let next: SpaceBinding | null = null
      if (hit && typeof hit.localDir === 'string' && hit.localDir.trim() !== '') {
        const localDir = hit.localDir.trim()
        // 选中的目录可能在某 git 仓库内部：隔离仓库根取所属仓库根（toplevel），worker 目录仍用所选目录。
        let repoRoot = localDir
        try {
          const r = await runGit(localDir, ['rev-parse', '--show-toplevel'])
          if (r.code === 0 && r.out.trim().length > 0) repoRoot = r.out.trim()
        } catch { /* 非仓库目录沿用所选目录 */ }
        next = { localDir, repoRoot, remoteUrl: typeof hit.remoteUrl === 'string' ? hit.remoteUrl.trim() : '' }
      }
      if ((next?.localDir ?? '') !== (binding.get()?.localDir ?? '') || (next?.repoRoot ?? '') !== (binding.get()?.repoRoot ?? '')) {
        binding.set(next)
        log(next
          ? `空间仓库绑定：scope=${scope} → 本地文件夹=${next.localDir}（隔离仓库根=${next.repoRoot === next.localDir ? next.localDir : next.repoRoot}；远程=${next.remoteUrl || '仅本地 / 不进共享仓库'}）`
          : `空间仓库绑定：scope=${scope} 未配置，沿用注入默认仓库（repoRoot=${config.repoRoot}）`)
      }
    } catch (e) {
      log(`空间仓库绑定刷新失败（沿用注入默认）：${String(e)}`)
    }
  }

  /** 该 scope 实际使用的隔离 git 仓库根（空间绑定仓库根优先，注入配置兜底）。 */
  function repoRootFor(): string { return binding.get()?.repoRoot || config.repoRoot }
  /** 该 scope 实际使用的 worker 工作目录（isolate=false / worktree 不可用 / 讨论时；= 绑定的本地文件夹）。 */
  function workspaceFor(): string { return binding.get()?.localDir || config.workspace }
  /** 该 scope 实际使用的 worktree 目录根。 */
  function worktreeRootFor(): string { return config.worktreeRoot || join(repoRootFor(), '.legion-worktrees') }

  /**
   * worktree 隔离：为任务建独立分支 worktree（w/<taskId>）。失败返回 null 由调用方回退。
   * 复用优先：同任务已有 worktree（blocked 解阻 / 退回纠错续做）直接复用，不删除上一轮部分改动；
   * worktree 被清理但分支仍在（blocked 时已提交 WIP）则从分支重新挂载。
   */
  async function prepareWorktree(taskId: string): Promise<string | null> {
    const root = worktreeRootFor()
    const dir = join(root, taskId)
    try {
      await ensurePrePushGuard()
      if (existsSync(dir)) {
        if (existsSync(join(dir, '.git'))) {
          // 既有 worktree：直接复用（保留未提交/已提交改动）
          activity('worktree', taskId, `复用既有 worktree：${dir}（分支 w/${taskId}）`)
          log(`${taskId} 复用既有 worktree：${dir}`)
          return dir
        }
        // 残留空目录/非 worktree 壳（daemon 自有路径），清理后重建
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败继续 */ }
      }
      const branchExists = (await runGit(repoRootFor(), ['rev-parse', '--verify', `w/${taskId}`])).code === 0
      if (branchExists) {
        // 分支还在（上轮已提交 WIP/成果）：从分支挂载续做
        const add = await runGit(repoRootFor(), ['worktree', 'add', dir, `w/${taskId}`])
        if (add.code !== 0) {
          log(`${taskId} 从分支 w/${taskId} 挂载 worktree 失败：${(add.err || add.out).trim()}`)
          return null
        }
        activity('worktree', taskId, `复用分支 w/${taskId}：${dir}`)
        return dir
      }
      const add = await runGit(repoRootFor(), ['worktree', 'add', '-b', `w/${taskId}`, dir, 'HEAD'])
      if (add.code !== 0) {
        log(`${taskId} worktree 创建失败：${(add.err || add.out).trim()}`)
        return null
      }
      activity('worktree', taskId, `隔离 worktree 就绪：${dir}（分支 w/${taskId}）`)
      return dir
    } catch (e) {
      log(`${taskId} prepareWorktree 异常：${String(e)}`)
      return null
    }
  }

  /**
   * 安装公共 pre-push 守卫：worktree 的钩子走公共 hooks 目录（无每-worktree 独立钩子），
   * 故用一个通用钩子拦截所有 w/*（worktree 分支）push，放行普通分支。幂等，不覆盖已有自定义钩子。
   */
  async function ensurePrePushGuard(): Promise<void> {
    const hooksDir = join(repoRootFor(), '.git', 'hooks')
    const hook = join(hooksDir, 'pre-push')
    const marker = 'legion worktree guard'
    const script = `#!/bin/sh
# ${marker}：禁止 push worktree 分支（w/*）；普通分支放行
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in
    refs/heads/w/*) echo "legion: worktree 分支 w/* 禁止 push（须经 promote 合并回主分支）" >&2; exit 1 ;;
  esac
done
exit 0
`
    try {
      mkdirSync(hooksDir, { recursive: true })
      if (existsSync(hook)) {
        if (readFileSync(hook, 'utf8').includes(marker)) return // 已装
        log('检测到已有自定义 pre-push 钩子，跳过安装守卫（请自行确保 w/* 分支不被 push）')
        return
      }
      writeFileSync(hook, script, { mode: 0o755 })
      log('已安装 pre-push 守卫（拦截 w/* 分支 push）')
    } catch (e) {
      log(`pre-push 守卫安装失败：${String(e)}`)
    }
  }

  /** 把 worktree 里的改动提交到 w/<taskId> 分支（done 时调用；blocked 保留未提交改动）。 */
  async function commitWorktree(taskId: string, dir: string, summary: string): Promise<boolean> {
    const add = await runGit(dir, ['add', '-A'])
    if (add.code !== 0) { log(`${taskId} git add 失败：${add.err.trim()}`); return false }
    const commit = await runGit(dir, ['commit', '-m', `${taskId}：${summary}`])
    if (commit.code !== 0) { log(`${taskId} git commit 失败：${(commit.err || commit.out).trim()}`); return false }
    return true
  }

  return { refreshSpaceBinding, repoRootFor, workspaceFor, worktreeRootFor, prepareWorktree, commitWorktree }
}

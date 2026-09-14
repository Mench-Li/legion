// plugins/src/sliceOrchestration.ts
// ============================================================================
// PRT-315（第 7 个切片）：**切片流水线编排**
//
// ## 这一批在做什么
//
// 前六个切片各取一条边界：./mediation.ts（交接·合入调解）、./reclamation.ts（仓储·租约回收）、
// ./stateMachine.ts（状态机·迁移决策）、./workspace.ts（workspace·worktree 隔离）、
// ./acceptance.ts（验收·结算与自检）、./handoff.ts（交接·阶段流转）。本文件是**第 7 个**，
// 取 `spaceWorker()` 里 `sweep()` 的 `// 5.` 块：`orchestrateSlices(tasks)` 与它唯一的私有助手
// `parseSlices(text)`。
//
// ★ **它不在 spec 点名的五个边界里。** spec
// （`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md:882`）点名的是
// 「仓储、状态机、workspace、验收和交接」五条；切片 1–6 已经把五条都取完了。这一片是**它们的
// 邻居**——`sweep()` 里唯一还没拆出来、且自带完整语义的一整块。写清楚这一点，是因为
// 「按边界拆」读到后面很容易被读成「凡是拆出来的都对应某个点名的边界」。
//
// 它做什么（仅 hub 模式，每轮扫单一次）：
//
//   ① `readyToExpand`：分析前缀尾（`SLICE_ANALYSIS_TAIL` = test-designer）done + `[slice-mode]`
//      且**切片束尚未注册** → 按目标目录解析已合入主分支的 `docs/<goalId>/TASK_BREAKDOWN.md`
//      （遗留目标回落根 `docs/`）→ `POST /api/goal/slices`；清单为空或注册失败 → 记退避时间戳，
//      `intervalMs * 6` 之后才再试。
//   ② `readyToRetest`：tester 停在 `in_review` 且其 fix 回炉任务**全部**合入 done
//      （且 fix 数未超预算）→ 换基线（清掉上一轮的 tester worktree/分支）→
//      重开 tester（`in_review → todo`），下轮由 todo 认领重测。
//
// 两个方向都不是「阶段 → 阶段」的接力（那是 `./handoff.ts` 的 `advancePipeline`）：
// ①是**把目标展开成切片束**，②是**把打回的那一片推回重测**。这就是它自成一界的原因。
//
// ## 这个模块**没有**改变任何行为
//
// 两段代码逐字节搬过来：除 §「注入改写白名单」里的 **4 处**（全部是
// `workspace.xxxFor()` → `xxxFor()` 这一种形状）之外，一行都没有动——日志串、
// `activity(...)` 的调用与顺序、`try/catch` 的吞错范围、`if` 闸门的次序、退避判据
// `(expandRetryAt.get(id) ?? 0) + intervalMs * 6 <= Date.now()`、以及「②里三处 `continue`
// 分别拦住谁」都照旧。切片 6 有 3 条正则改写，本切片有 4 处、且是同一形状。
//
// 逐字对拍见 `_prt-handoff/prt315g-compare.mjs`：按**锚点**（不是行号）从 pristine 取两个块、
// 施加**穷尽白名单**后逐行比较。
//
// ## `parseSlices()` 为什么**搬进来了**（与四个按值注入的判据不同）
//
// 它此前是 `spaceWorker()` 闭包里的一个**函数声明**，全仓（`plugins/src`）**只有本界一个读者**，
// 而且**是纯函数**：只读入参 `text`，不碰闭包、不碰文件、不碰 hub。它描述的是本界的**输入格式**——
// 「breaker 写进 `TASK_BREAKDOWN.md` 的机器可读切片清单长什么样」。
//
//   > 一个「只服务本界、且没有任何闭包依赖」的纯助手留在原处，
//   > 与它搬进本界，在行为上是同一个东西——
//   > 只不过前者会让「切片束怎么被解析出来」这件事，一半在新模块、一半在旧文件。
//
// 所以搬。搬法与原处**完全相同**（`function` 声明，逐字未改），另加 `export`：
// 导出是为了让 `sliceOrchestration.test.mjs` 能**直接**钉住那份格式契约（`## slices` 段的
// 四种列、`：`/`|` 分隔、CJK 逗号分号、遇到下一个标题即结束、非清单行跳过），
// 而不是只能隔着 `sweep()` 的端到端用例间接验证。
//
// **对照**：`SLICE_ANALYSIS_TAIL` / `isSliceGoalTask` / `isSliceBeam` / `goalDocPath` 四个判据
// **不搬**、按值注入——后三者各有第二个读者（`./handoff.ts`、`registerContractDocs`、契约登记），
// 搬进来就要么在 `index.ts` 留第二份（同一逻辑两处），要么让它们反向依赖本模块。
// 唯独 `isSliceBeam` 目前也只有本界一个读者：留它是**判断**（它与 `sliceGoalKey` 等
// 同属「切片键判据」一家，拆开会让「什么算切片任务」分散到两个文件），不是硬约束，
// 已列在 `docs/superpowers/prt/PRT-315-slice-orchestration-boundary.md` §诚实边界。
//
// ## 状态：两个容器**不搬所有权**，只借读改
//
// `expandRetryAt`（`Map<string, number>`）与 `goalCtxById` 在改前是 `spaceWorker()` 闭包里的
// `const`。两者的**所有权都留在闭包**，理由不同：
//
//   · `expandRetryAt` 是这一界自己的状态，看起来最该搬。不搬是因为它的**语义单位是
//     「spaceWorker 实例」**：`superviseSpaces()` 会在同一进程里按空间把 `spaceWorker`
//     mount 成多个子实例（`index.ts` 的 `mountRunner`），它们共用一个模块注册表。
//     一个模块级 `Map` 会让空间 A 的退避时间戳挡住空间 B 的展开——而两边撞上同一个
//     test-designer taskId 在多空间部署里是常态。**每实例一份**这件事，闭包天然做到，
//     模块级变量天然做不到。`sliceOrchestration.test.mjs` 有一条直接钉它。
//
//         > 一个「每实例一份」的闭包容器，
//         > 与一个「每进程一份」的模块级容器，在只有一个守护实例的部署里是同一个东西——
//         > 只不过多空间部署下，后者会让第二个空间的切片展开**静默地晚 6 轮**。
//
//   · `goalCtxById` 则**根本不是这一界的状态**：它是「目标级上下文缓存」，由
//     `refreshGoals()`（`sweep()` 每轮从 hub `/api/goal` 刷新）写，被
//     `registerContractDocs`、worker 提示词、目标文件镜像等**非本界**的读者读。
//     搬走所有权 = 把一条「全实例共享的目标视图」塞进一个只读它一格的模块里，
//     下一个读它的人就得反过来 import 本模块。故只借 `get`：接口里它**不是** `Map`，
//     而是一个 `{ get }` 结构类型——把契约收窄到「本界只读」。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// 与 mediation / reclamation / stateMachine / workspace / acceptance / handoff 同源：
// `Config` 是 `index.ts` 里由 zod schema 推出来的值，import 它形成**真的**运行时循环依赖
// （本模块被 `index.ts` import）。这里只声明本切片真正读的四个字段
// （`role` / `intervalMs` / `maxFixPerSlice` / `isolate`）；调用点传的是**真的** `Config`，
// TypeScript 在赋值处校验可赋值性——字段改名的那天红在**调用点**，而不是让这里安静地读到
// `undefined`。这不是洁癖，两个字段各有自己的静默症状：
//
//   · `maxFixPerSlice` 读不到 → `fixes.length > undefined` 恒为 false →
//     重测重开会**绕过预算闸门**（「不报错、只是一直重测」）；
//   · `isolate` 读不到 → `if (config.isolate)` 恒假 → 重测**跳过换基线**，复用上一轮的
//     tester worktree，重测跑在合入修复前的代码上（下面那段注释写的正是这个坑）。
//
// ## 依赖：为什么这里**没有**取值函数
//
// 前六个切片反复强调「运行期会被重新赋值的绑定必须传**取值函数**」。本切片刻意没有这一节，
// 因为 `orchestrateSlices` 一个可变绑定都不读：
//
//   · `useHub` 它**不读**——`if (useHub)` 那道守卫是 `sweep()` 的 `// 5.` 块自己的形状，
//     留在 `index.ts`。把它搬进来，本模块就会多读一个 `let`，而那正是这条规矩要防的东西；
//   · `pipeline` / `stageByRole` / `isPipeline` 同样不读：切片束任务的「下一环」由
//     `blockedBy` 预建，不走 `roles.json` 的 `next`（见 `./handoff.ts` 的注释）。
//
// `scope` 是 `const`；`config` 是 `apply()` 的形参；`expandRetryAt` / `goalCtxById` 是
// 调用方持有的**对象身份**（每次都重新读它的内容，见上一节）；其余全是函数声明或 `const` 箭头
// 的**身份稳定**引用。传值即传那个稳定的身份，与 reclamation / handoff 对同类绑定的处理一致。
// 这条「没有取值函数」不是口头声明：`sliceOrchestration.test.mjs` 有一条活性检查，
// 构造之后替换 `deps.config.maxFixPerSlice` 立刻生效（证明接口是活的，不是快照）。
//
// ## 注入改写白名单（穷尽，4 处，全是同一形状）
//
//   `workspace.repoRootFor()`     → `repoRootFor()`      命中 3 处
//   `workspace.worktreeRootFor()` → `worktreeRootFor()`  命中 1 处
//
// 两个取值函数由 `./workspace.ts` 的实例提供（调用点写 `repoRootFor: workspace.repoRootFor`）。
// **只搬这两个**，不把 `workspace` 整个对象拖进来：对本界而言 workspace 只有两个只读问题
// （「仓库根在哪」「worktree 根在哪」），把它整个交出去等于让本模块有权调 `prepareWorktree` /
// `commitWorktree`——越界不会报错，只会让「谁负责 worktree」这件事重新说不清。
//
// ## 边界：留在 `sweep()` 那边的两件事，逐条点名
//
//   1. **`if (useHub) { try { ... } catch (e) { log(...) } }` 这一圈**留在调用点，
//      是本切片刻意不搬的控制流：hub 不可达时**不编排**，编排抛错时**只记一行日志、
//      本轮照常收尾**（`writeDaemonStatus` 仍会跑）。搬进来就会让模块自己决定
//      「hub 不可达算不算失败」——那是调用方的语义，不是这一界的。
//   2. **四个判据的**定义****（`SLICE_ANALYSIS_TAIL` / `isSliceGoalTask` / `isSliceBeam` /
//      `goalDocPath`）留在 `index.ts`，按**值**注入，理由见上一节。
//
// ## 执行面记号贡献 = 0
//
// 本模块只经 `hubPost`（HTTP）与 `runGit` 触碰外界，没有一行 `ctx.*`。
// `dsh-boundary --check` 在改后仍是 3 文件 / 26 处；本文件的注释里也**不写出**执行面记号的
// 整串字面形式（写成整串会被记成「执行面依赖 +1」，那是往坏的方向错的假阳性）。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Task } from './types.js'

/**
 * 目标上下文的**只读投影**：本切片只把它交给 `goalDocPath` 读 `docsDir`。
 *
 * 不 import `index.ts` 的 `GoalCtx`（那是内部类型），也不声明整个缓存 Map：
 * 接口只承认本界真正用到的那一格。
 */
export interface GoalCtxRef {
  docsDir?: string | null
}

export interface SliceOrchestrationDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    /** hub 写路径的 `by`（`POST /api/goal/slices`）。 */
    role: string
    /** 展开失败后的退避窗口 = `intervalMs * 6`。 */
    intervalMs: number
    /** 每切片最多回炉几轮（超过则不再自动重开重测）。 */
    maxFixPerSlice: number
    /** 隔离模式：重测换基线时清掉上一轮的 tester worktree/分支。 */
    isolate: boolean
  }
  log: (msg: string) => void
  /** 本 worker 实例的 scope（切片束过滤的 key）。**const**，传值。 */
  scope: string
  activity: (kind: string, taskId: string, text: string) => void
  /** 是否切片束任务（**单一定义留在 `index.ts`**，理由见文件头）。 */
  isSliceBeam: (t: Task) => boolean
  /** 分析前缀尾角色（**单一定义留在 `index.ts`**，理由见文件头）。 */
  SLICE_ANALYSIS_TAIL: string
  /** 是否切片束目标任务（**单一定义留在 `index.ts`**，理由见文件头）。 */
  isSliceGoalTask: (t: Task) => boolean
  /** 切片展开重试退避（**所有权留在 `spaceWorker()`**，理由见文件头）。 */
  expandRetryAt: Map<string, number>
  /** 目标级上下文缓存（**所有权留在 `spaceWorker()`**，理由见文件头）；本界只读 `get`。 */
  goalCtxById: { get: (id: string) => GoalCtxRef | undefined }
  /** 目标文档槽位解析（**单一定义留在 `index.ts`**，理由见文件头）。
   *  写成**方法**（而不是函数类型属性）是有意的：本界只把 `goalCtxById.get()` 拿到的
   *  `GoalCtxRef` 交给它，而真实实现收的是完整的 `GoalCtx`——方法参数按**双变**检查，
   *  调用点因此不必写一个 `as` 断言（断言会把"字段改名"这种真错也一起吞掉，
   *  而这条链上的静默症状是"契约文档登记到错的目录"）。 */
  goalDocPath(goal: GoalCtxRef | null | undefined, legacyPath: string | null | undefined): string
  /** workspace 边界的仓库根取值函数（`./workspace.ts`，本切片只注入不搬）。 */
  repoRootFor: () => string
  /** workspace 边界的 worktree 根取值函数（`./workspace.ts`，本切片只注入不搬）。 */
  worktreeRootFor: () => string
  hubPost: (path: string, body: Record<string, unknown>) => Promise<unknown>
  safeComment: (id: string, text: string) => Promise<void>
  transitionTo: (id: string, to: string) => Promise<void>
  runGit: (repoRoot: string, args: string[]) => Promise<{ code: number; out: string; err: string }>
}

/** `createSliceOrchestration` 交回给 `index.ts` 的东西。 */
export interface SliceOrchestration {
  orchestrateSlices: (tasks: Task[]) => Promise<void>
}

/** 解析 breaker 产出的 TASK_BREAKDOWN.md 切片清单（P1-4 机器可读格式，见 roles.json breaker 提示词）：
 *  '## slices' 段落后逐行「- S1 | 切片标题 | a.js, b.ts | 验收1; 验收2」。 */
export function parseSlices(text: string): Array<{ title: string; files: string[]; acceptance: string[] }> {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^#{2,3}\s*(slices|切片)/i.test(l.trim()))
  if (start === -1) return []
  const out: Array<{ title: string; files: string[]; acceptance: string[] }> = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (line === '') continue
    if (/^#{1,6}\s/.test(line)) break // 下一个标题 = 清单结束
    const m = /^[-*]\s*S?(\d+)\s*[|:]\s*(.*)$/.exec(line)
    if (!m) continue
    const parts = m[2].split('|').map(x => x.trim())
    const title = (parts[0] ?? '').trim()
    if (title === '') continue
    const files = (parts[1] ?? '').split(/[,，]/).map(x => x.trim()).filter(Boolean)
    const acceptance = (parts[2] ?? '').split(/[;；]/).map(x => x.trim()).filter(Boolean)
    out.push({ title, files, acceptance })
  }
  return out
}

export function createSliceOrchestration(deps: SliceOrchestrationDeps): SliceOrchestration {
  const {
    config, log, scope, activity,
    isSliceBeam, SLICE_ANALYSIS_TAIL, isSliceGoalTask,
    expandRetryAt, goalCtxById, goalDocPath,
    repoRootFor, worktreeRootFor,
    hubPost, safeComment, transitionTo, runGit,
  } = deps

  /** 切片流水线编排（每轮扫单，仅 hub 模式）：
   * ① readyToExpand：分析前缀尾（test-designer done + [slice-mode]）且切片束尚未注册 →
   *    解析已合入主分支的 TASK_BREAKDOWN.md（目标目录 docs/<goalId>/ 或遗留根 docs/，breaker 机器可读切片清单）→
   *    POST /api/goal/slices 注册
   *    （coder_Si→tester_Si 微链 + devops 目标级收尾；注册幂等，失败退避后重试）。
   * ② readyToRetest：tester 停在 in_review 且其 fix 回炉任务已全部合入 done（预算未用尽）→
   *    重开 tester（in_review→todo），下轮由 todo 认领重测——机器闸门闭环。
   */
  async function orchestrateSlices(tasks: Task[]): Promise<void> {
    const sliced = tasks.filter(t =>
      t.scope === scope && !t.hold && t.status !== 'canceled' &&
      (isSliceBeam(t) || (t.role === SLICE_ANALYSIS_TAIL && isSliceGoalTask(t))))
    if (sliced.length === 0) return
    // ① 展开就绪
    const tdDone = sliced.find(t => t.role === SLICE_ANALYSIS_TAIL && t.status === 'done' && isSliceGoalTask(t))
    if (tdDone !== undefined) {
      const beamExists = sliced.some(x => x.slice === tdDone.id || String(x.slice ?? '').startsWith(`${tdDone.id}:S`))
      if (!beamExists && (expandRetryAt.get(tdDone.id) ?? 0) + config.intervalMs * 6 <= Date.now()) {
        // 拆解文档按目标目录解析：目标化目标在 docs/<goalId>/TASK_BREAKDOWN.md，遗留目标回退根 docs/TASK_BREAKDOWN.md。
        const tdGoal = tdDone.goalId ? goalCtxById.get(tdDone.goalId) ?? null : null
        const bdPath = join(repoRootFor(), goalDocPath(tdGoal, 'docs/TASK_BREAKDOWN.md'))
        let slices: Array<{ title: string; files: string[]; acceptance: string[] }> = []
        try {
          if (existsSync(bdPath)) slices = parseSlices(readFileSync(bdPath, 'utf8'))
        } catch (e) {
          log(`TASK_BREAKDOWN.md 读取失败：${String(e)}`)
        }
        if (slices.length === 0) {
          expandRetryAt.set(tdDone.id, Date.now())
          log(`${tdDone.id} 分析前缀完成但 TASK_BREAKDOWN.md 无切片清单（${bdPath}），等待 breaker 产出（退避重试）`)
          return
        }
        try {
          const res = await hubPost('/api/goal/slices', { testDesignerTaskId: tdDone.id, slices, by: config.role }) as { created?: string[] }
          const n = (res.created ?? []).length
          await safeComment(tdDone.id, `📐 已注册 ${n} 个切片（coder_Si→tester_Si 微链 + devops 目标级收尾），切片之间互不依赖，可并行派工。`)
          activity('slices', tdDone.id, `切片展开：${n} 个任务`)
          log(`${tdDone.id} 切片束已注册：${n} 个任务`)
        } catch (e) {
          expandRetryAt.set(tdDone.id, Date.now())
          log(`${tdDone.id} 切片注册失败（退避重试）：${String(e)}`)
        }
      }
    }
    // ② 重测重开
    for (const tester of sliced.filter(t => t.role === 'tester' && t.status === 'in_review' && String(t.slice ?? '').includes(':S'))) {
      // 已升级将军（预算用尽）的 tester 绝不自动重开——否则 fix 全 done 后每轮都重测，形成死循环
      if (tester.comments.some(c => (c.text ?? '').includes('预算已用尽'))) continue
      const fixes = tasks.filter(f => f.role === 'coder' && f.fixOf === tester.id && f.status !== 'canceled')
      if (fixes.length === 0 || fixes.length > config.maxFixPerSlice) continue
      if (!fixes.every(f => f.status === 'done')) continue // 有在途/失败 fix 未合入，等下一轮
      // 清掉上一轮的 tester worktree/分支：重测必须基于合入修复后的主分支，而非复用旧快照
      // （prepareWorktree 对既有 worktree/分支默认复用续做——那是"打回纠错"语义；重测是"换基线"语义）。
      if (config.isolate) {
        const staleDir = join(worktreeRootFor(), tester.id)
        if (existsSync(staleDir)) {
          const removed = await runGit(repoRootFor(), ['worktree', 'remove', '--force', staleDir])
          if (removed.code !== 0) log(`${tester.id} 重开前清理旧 worktree 失败（下轮 prepareWorktree 将复用旧快照）：${(removed.err || removed.out).trim()}`)
        }
        await runGit(repoRootFor(), ['branch', '-D', `w/${tester.id}`])
        activity('worktree', tester.id, `重测换基线：已清理旧 worktree/分支 w/${tester.id}，将基于最新主分支重建`)
      }
      await transitionTo(tester.id, 'todo')
      await safeComment(tester.id, `🔄 修复已完成（第 ${fixes.length} 轮），自动重开本切片重测（机器闸门：通过后自动 done）。`)
      activity('retest', tester.id, `修复完成，重开重测（第 ${fixes.length} 轮）`)
      log(`${tester.id} → todo（fix 完成，第 ${fixes.length} 轮重测）`)
    }
  }

  return { orchestrateSlices }
}

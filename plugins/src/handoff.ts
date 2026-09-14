// plugins/src/handoff.ts
// ============================================================================
// PRT-315（第 6 个切片）：**交接边界**——流水线阶段之间的 hand-off
//
// ## 这一批在做什么
//
// 前五个切片各取一条边界：./mediation.ts（交接边界的合入调解）、./reclamation.ts（仓储边界的
// 租约回收）、./stateMachine.ts（状态机边界的迁移决策）、./workspace.ts（workspace 边界的
// worktree 隔离）、./acceptance.ts（验收边界的结算与自检）。本文件是**第 6 个**，取 spec 点名的
// 「交接边界」里最正中间的那一步：**一个阶段任务 done 之后，把接力棒交给下一角色**。
//
//   · `advancePipeline(doneTask)`：done 任务所属角色有 next、且**尚无后继**时，创建下一角色
//     任务（status=todo）。它是「阶段 → 阶段」的唯一出口。
//
// 为什么这一件算**交接边界**：它不改任务池的租约（仓储）、不重跑/退回任何任务（状态机）、
// 不碰 worktree（workspace）、不结算已产出的资产（验收）。它只回答一个问题——
// 「这一棒交给谁，还是早就交出去了」。放错边界的代价不是报错，而是**静默地多建一个任务**
// 或**静默地不往下走**：前者让同一步骤被两个角色各做一遍，后者让目标链停在半路。
//
// ## 这个模块**没有**改变任何行为
//
// 函数整段搬过来，除了文件头 §「依赖」写明的**三处注入改写**（`useHub` / `pipeline` /
// `stageByRole` 从闭包变量变**取值函数**），一行都没有动：日志串、`activity(...)` 的调用与
// 顺序、`try/catch` 的吞错范围（**创建失败只记日志、不抛出**）、`if` 闸门的**次序**
// （pipeline 为空 → 切片任务 → fix 回炉 → 分析前缀尾 → 无 stage → 无 next → 无 nextStage →
// 后继已存在）、"后继已存在"那两条识别的**每一条子条件**（parent 任意状态 / blockedBy 且非
// canceled），以及 title/description 的拼法。
//
// ## ★ D7' 机器闸门：交接的**绕行**（本切片唯一的"非纯搬"改动，已逐条声明）
//
// `runWorker` 里有一条与 `advancePipeline` 直接对冲的分支：
//
//     // D7' 机器闸门：切片测试任务（tester + slice 键）走专用结算，不进入常规 advancePipeline 流转
//     if (report.status === 'done' && stage?.role === 'tester' && t.slice != null && String(t.slice).includes(':S')) {
//       await settleSliceTest(t, worktreeDir, report)
//       return
//     }
//
// 也就是：**切片测试任务不走常规交接**，它在闸门里当场结算（pass → 自动 done；fail → 建 fix 回炉），
// 于是根本走不到下面那个 `await handoff.advancePipeline(t)`。
//
// 本切片把这条分支的**谓词**提成具名纯函数 `isSliceTesterTask(stage, t)`，与 `advancePipeline`
// 放在一起——两者回答的是同一个问题的两个面：「这一棒交给下一角色」，还是「这一棒不进常规交接」。
//
// **为什么是"提成函数"而不是"原样搬一行"**：同一串条件在 `index.ts` 里本来就有**两个**读点
// （`buildWorkerPrompt()` 注入「测试士兵纪律」段；`runWorker()` 的 D7' 闸门改道结算），
// 各自写了一遍。留着内联，本切片就只是把"同一判定两处写法"照抄过来；提出来则两处共用**一个**
// 定义（任务不变量 §5：逻辑只能有一处）。这是本切片**唯一**超出"逐字搬"的改动，条件与短路
// 次序一字未改，纯函数、无可观测差异——`docs/superpowers/prt/PRT-315-handoff-slice.md` 里
// 逐条列了它。
//
// **搬走的只有谓词，不是闸门**：闸门的**动作**（`settleSliceTest`）留在 `index.ts`——它要
// hub 的 `/api/test-report`、要 `commitWorktree`/`recordPatch`、要按预算建 fix 任务，跨的是
// 执行面与 workspace 边界。闸门在 `runWorker` 里的**位置**（必须排在常规 done 分支**之前**）
// 也留在 `index.ts`：那是控制流的形状，不是本模块能表达的。两者都在
// `docs/superpowers/prt/PRT-315-handoff-slice.md` §诚实边界 里点名。
//
// ## 依赖：运行期会被重新赋值的绑定传**取值函数**，不传值
//
// 三个绑定在原文件里都是会被**重新赋值**的 `let`：
//
//   · `pipeline`：`applyPipeline()` 换流水线来源时整体改写（hub 数据面清空还会**退回 null**，
//     双向都动）；
//   · `stageByRole`：`applyPipeline()` 每次把整个 `Map` **替换**成新的；
//   · `useHub`：`detectHub()` 探测成功后改写。
//
// 传值 = 模块从构造那一刻起看着一份**冻结的旧快照**，而症状一条日志都不会有：
//
//   · `pipeline` 快照成 `null` → **整条流水线永远不流转**（每次进函数第一行就 return），
//     阶段任务一个接一个 done，却谁也不会拿到下一棒；
//   · `stageByRole` 快照 → 换流水线之后"下一角色"查的是一张旧表，`nextStage` 查不到 →
//     同样静默地不流转（或者更糟：按旧编队建了下一棒）；
//   · `useHub` 快照成 `false` → 明明有 hub，流转却去 fork `taskctl create`。
//
//       > 一个"构造时快照了可变配置"的模块，
//       > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
//       > 只不过前者会在配置变化之后，安静地继续按旧的来。
//
// ## 依赖：为什么 `scope` / `listTasks` / `hubPost` … 传**值**
//
// `scope` 是 `const`；`listTasks` 是身份稳定的 `const` 箭头（每次调用内部重新读 `useHub`，
// 所以"跟着变"这件事本来就发生在调用方那一侧）；`hubPost` / `runTaskctl` 是函数声明；
// `log` / `activity` 是 `const` 箭头。它们都不会被重新赋值——传值即传那个稳定的身份，
// 与 reclamation / acceptance 对同类绑定的处理一致。
//
// ## `SLICE_ANALYSIS_TAIL` 与 `isSliceGoalTask` 为什么**留在** `index.ts`
//
// 两者本切片都读（分析前缀尾 done 不建通用 coder），但**不搬**：`orchestrateSlices()`
// （切片编排边界，`// 5.`）也读它们。搬进来要么在 `index.ts` 留第二份（**同一逻辑两处**，
// 正是任务禁止的），要么让切片编排反向依赖交接模块。故与 `stateMachine.ts` 的 `stageOf` 同形：
// 单一定义留在 `index.ts`，由构造点注入（一个是常量、一个是身份稳定的箭头函数）。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// 与 mediation / reclamation / stateMachine / workspace / acceptance 同源：`Config` 是
// `index.ts` 里由 zod schema 推出来的值，import 它形成**真的**运行时循环依赖。这里只声明
// 本切片真正读的两个字段（`role` / `scrumDir`）；调用点传的是**真的** `Config`，TypeScript
// 在赋值处校验可赋值性——字段改名的那天红在**调用点**，而不是让这里安静地读到 `undefined`
// （`scrumDir` 一旦读不到，非 hub 模式的流转会把任务创建到别处——"不报错、只是建错地方"）。
//
// ## 状态：本模块**没有**任何状态
//
// `advancePipeline` 不持有任何跨轮状态（连每实例状态都没有）：它只做**读**（本实例的流水线
// 定义 + `listTasks()` 的任务快照）与**一次创建调用**。`superviseSpaces()` 会在同一进程里按
// 空间把 `spaceWorker` mount 成多个子实例（`index.ts` 的 `mountRunner`），它们共用一个模块
// 注册表——所以这里**连一个模块级 `let` 都不许有**，否则空间 A 的流水线状态会串到空间 B。
// ============================================================================

import type { StageDef, Task } from './types.js'

export interface HandoffDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    role: string
    scrumDir: string
  }
  log: (msg: string) => void
  /** 本 worker 实例的 scope（流转建任务与"同 scope"后继判定的 key）。**const**，传值。 */
  scope: string
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  useHub: () => boolean
  /** 取值函数：`applyPipeline()` 换来源时整体改写（还可能退回 `null`）。只判空，不读字段。 */
  pipeline: () => object | null
  /** 取值函数：`applyPipeline()` 换来源时整个 Map 会被替换。 */
  stageByRole: () => Map<string, StageDef>
  /** 任务池读路径（**单一定义留在 `index.ts`**：`getTask` 等共用它，且它内部自带 useHub 分派）。 */
  listTasks: (scopeFor?: string) => Promise<Task[]>
  hubPost: (path: string, body: Record<string, unknown>) => Promise<unknown>
  runTaskctl: (scrumDir: string, argv: string[]) => Promise<unknown>
  activity: (kind: string, taskId: string, text: string) => void
  /** 分析前缀尾角色（**单一定义留在 `index.ts`**，理由见文件头）。 */
  SLICE_ANALYSIS_TAIL: string
  /** 是否切片束目标任务（**单一定义留在 `index.ts`**，理由见文件头）。 */
  isSliceGoalTask: (t: Task) => boolean
}

/** `createHandoff` 交回给 `index.ts` 的东西。 */
export interface Handoff {
  advancePipeline: (doneTask: Task) => Promise<void>
}

/**
 * D7' 机器闸门判定：这是不是一个**切片测试任务**（阶段角色 tester + slice 键含 ':S'）。
 *
 * 谓词提到这里，是因为它在 `index.ts` 里有**两个**读点，而两处此前各写了一遍同一串条件：
 *   ① `buildWorkerPrompt()`：命中 → 注入「测试士兵纪律（只测不修 + testReport 字段）」段；
 *   ② `runWorker()` 的 D7' 闸门：命中 → 结算改道 `settleSliceTest`，**绕开常规交接**
 *      （于是根本走不到 `advancePipeline`）。
 * ②正是本切片的「交接绕行」。条件本身**一字未改**，短路次序照旧（角色 → slice 非空 → 键含 ':S'），
 * 它是纯函数，两个读点的可观测行为都不变。
 */
export function isSliceTesterTask(stage: StageDef | undefined, t: Task): boolean {
  return stage?.role === 'tester' && t.slice != null && String(t.slice).includes(':S')
}

export function createHandoff(deps: HandoffDeps): Handoff {
  const {
    config, log, scope, useHub, pipeline, stageByRole, listTasks, hubPost, runTaskctl, activity,
    SLICE_ANALYSIS_TAIL, isSliceGoalTask,
  } = deps

  /** 流水线流转：done 任务所属角色有 next 且尚无后继时，创建下一角色任务（todo）。 */
  async function advancePipeline(doneTask: Task): Promise<void> {
    if (pipeline() === null) return
    // 切片流水线任务不走 roles.json 的 next 流转：
    // 切片束任务（slice≠null）的"下一环"由切片编排决定（coder→tester 已由 blockedBy 预建、
    // tester→devops 尾同理）；fix 回炉任务合入即闭环（重测由编排重开 tester）。
    // 分析前缀尾（test-designer）done 也不建通用 coder——切片束由 readyToExpand 注册。
    if (doneTask.slice != null) return
    if (doneTask.fixOf != null) return
    if (doneTask.role === SLICE_ANALYSIS_TAIL && isSliceGoalTask(doneTask)) return
    const stage = stageByRole().get(doneTask.role ?? '')
    if (!stage || !stage.next) return
    const nextStage = stageByRole().get(stage.next)
    if (!nextStage) return
    const all = await listTasks()
    // 后继已存在则跳过：advance 补建的任务以 parent 链识别（任意状态，含 canceled——避免将军
    // 废弃补建任务后每轮重建的拉锯）；createGoalChain 预建的全链任务以「同 scope 同 role 且
    // blockedBy 含已完成任务」识别（parent 为空，done 也算存在，仅 canceled 不算——真被砍掉才允许补建）。
    const hasSuccessor = all.some(t =>
      t.scope === scope && t.role === nextStage.role &&
      (t.parent === doneTask.id ||
        (t.status !== 'canceled' && Array.isArray(t.blockedBy) && t.blockedBy.includes(doneTask.id))),
    )
    if (hasSuccessor) return
    const doneSummary = doneTask.comments
      .filter(c => c.text.startsWith('✓'))
      .map(c => c.text.replace(/\n.*$/s, ''))
      .slice(-1)[0] ?? doneTask.title
    const base = (doneTask.description ?? '').replace(/\n\n\[本阶段\].*$/s, '')
    const description = [
      base,
      `[前序阶段] ${stage.label}（${stage.role}）已完成：${doneSummary}`,
      `[本阶段] ${nextStage.label}（${nextStage.role}）`,
    ].filter(s => s.trim().length > 0).join('\n\n')
    // 标题沿用上一环但把「【阶段标签】」换成下一环的，避免重复建任务时标题仍旧是前序阶段
    const title = doneTask.title.replace(/^【[^】]*】/, `【${nextStage.label}】`)
    try {
      let res: { id?: string }
      if (useHub()) {
        res = await hubPost('/api/create', {
          title, description, role: nextStage.role,
          parent: doneTask.id, priority: doneTask.priority, status: 'todo',
          by: config.role, scope: scope,
          goalId: doneTask.goalId ?? undefined,
        }) as { id?: string }
      } else {
        res = await runTaskctl(config.scrumDir, [
          'create', '--title', title, '--description', description,
          '--role', nextStage.role, '--parent', doneTask.id, '--priority', doneTask.priority, '--status', 'todo',
        ]) as { id?: string }
      }
      log(`${doneTask.id} 流水线流转：${stage.role} → ${nextStage.role}（新任务 ${res?.id ?? ''}）`)
      activity('dispatch', doneTask.id, `流水线流转 ${stage.label} → ${nextStage.label}`)
    } catch (e) {
      log(`${doneTask.id} 流转失败：${String(e)}`)
    }
  }

  return { advancePipeline }
}

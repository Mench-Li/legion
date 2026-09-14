// plugins/src/reclamation.ts
// ============================================================================
// PRT-315（第 2 个切片）：**租约回收**（仓储边界）
//
// ## 这一批在做什么
//
// 第 1 个切片（`./mediation.ts`）取了「交接边界」的合入调解。本文件是**第 2 个切片**，
// 取「仓储边界」里最靠前的一段：`spaceWorker()` 每轮扫单开头对**在办租约**做的两件事——
//
//   · `// 0. 认领租约回收`：释放超过 `staleMinutes` 无进展（距最近 progress 起算）
//     或过 TTL 的 `in_progress` 任务；
//   · `// 0.5 守护重启孤儿回收`（仅进程启动后第一轮）：重启前进程的 worker 已随进程消失，
//     其任务停在 `in_progress` 且通常无「未完成」评论——若只靠 stale 释放要等
//     `staleMinutes`（如 100 分钟），故第一轮就释放回 `todo`。
//
// 两者都是**任务池的写路径**：hub 模式走 `/api/release-stale`（守护不直连本地库，
// 多存储部署下避免误碰其他任务池），本地模式走 `taskctl release-stale`。
// 这正是「仓储边界」——它只跟任务池的租约状态有关，不派工、不跑 subagent、不碰 git。
//
// ## 这个模块**没有**改变任何行为
//
// 两段代码逐句搬过来，除了下面 §「依赖」里写明的两处注入改写（`useHub` / `isPipeline`
// 从隐式捕获变显式取值函数），一行都没有动：日志串、`activity(...)` 的调用顺序、
// `try/catch` 的吞错范围、`useHub ? A : B` 的分派、连本地模式那个
// `'--older-than', '0'` 都照旧。
//
// ## 依赖：可变状态一律传**取值函数**，不传值
//
// `mediation.ts` 已经踩过这个坑，这里是同一类东西的另外两个实例：
//
//   · `useHub` 是 `let`，`detectHub()` 探测成功后会被改写；
//   · `isPipeline` 是 `let`，`applyPipeline()` 换流水线来源时会被**重新赋值**。
//
// 传值 = 模块从构造那一刻起就看着一份冻结的旧快照。症状不报错，只是：
// 守护本来该走 hub 释放、却一直去 fork `taskctl`；或者换流水线之后，
// 孤儿回收的「本守护认领」判定一直按旧的 `isPipeline` 来（多角色流水线里
// `soldier === 角色` 的任务会被漏掉，静静等满 `staleMinutes`）。
//
//     > 一个"构造时快照了可变配置"的模块，
//     > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
//     > 只不过前者会在配置变化之后，安静地继续按旧的来。
//
// `scope` / `config` / `mediating` 则**传值**，因为它们在 `spaceWorker()` 里分别是
// `const`、`const`、以及一个身份稳定的 `Set`（内容会变，对象不会换）——这与
// `mediation.ts` 对 `mediating` 的处理一致。
//
// ## ★ 重启标志用**调用方持有的状态对象**，不用模块级变量
//
// 原代码里 `bootReconciled` 是 `spaceWorker()` 闭包里的 `let`：
//
//     if (!bootReconciled) { bootReconciled = true; ...回收... }
//
// 它必须**跨模块边界**保持三个语义，缺一不可：
//   ① 初值 `false`；
//   ② 第一次进入时**先置 `true`**（哪怕后面的释放调用抛错也算「做过了」——
//      原代码的赋值在 `try` 之前，异常被内层 catch 吞掉，标志不会回退）；
//   ③ 只对**本实例**生效。
//
// 这里选择把状态提升为一个显式对象 `BootReconcileState`（`{ done: boolean }`），
// 由调用方 `spaceWorker()` 创建、注入，模块只读改它的字段。**为什么是这个机制：**
//
//   · **不是模块级变量。** 一个模块级 `let bootReconciled` 会在**同一进程内多个守护
//     实例之间串台**：`superviseSpaces()` 会按空间把 `spaceWorker` mount 成多个子实例
//     （`plugins/src/index.ts` 的 `mountRunner`），它们共用一个模块注册表。
//     谁先扫单谁就把标志置了 `true`，**其余空间的守护从此再也不会做开机孤儿回收**——
//     那些空间的重启孤儿只能干等满 `staleMinutes`。而原闭包变量天然是每实例一份。
//
//         > 一个"每实例一份"的闭包变量，
//         > 与一个"每进程一份"的模块级变量，在只有一个守护实例的部署里是同一个东西——
//         > 只不过多空间部署下，后者会让第二个空间的开机回收**静默地不发生**。
//
//   · **不是"返回新值由调用方回写"。** 那会把置位推到 `await` **之后**：调用方拿到
//     返回值才能写回，于是「第一轮做到一半就被记成未做」之间多出一个窗口期，
//     而且窗口期里一旦被重入（`sweep()` 的 `sweeping` 闸门是**同一个实例**的保护，
//     不是跨实例的）就会重复回收。状态对象让置位留在**原来的那一刻**——
//     进入函数、动手之前——语义与闭包变量逐字一致，只是所有权变显式了。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// 与 `mediation.ts` 同源：`Config` 是 `index.ts` 里由 zod schema 推出来的值，
// import 它形成**真的**运行时循环依赖。这里只声明本切片真正读的三个字段；
// 调用点传的是**真的** `Config`，TypeScript 在赋值处校验可赋值性——
// 字段改名的那天红在**调用点**，而不是让这里安静地读到 `undefined`。
// ============================================================================

import type { Task } from './types.js'

/**
 * 守护进程「开机孤儿回收是否已做」的跨模块状态。
 *
 * 字段名刻意不叫 `bootReconciled`：调用方一眼要能看出这是**一个对象**、
 * 一次注入、每实例一份——而不是又一个可以被别处顺手读写的模块级标志。
 */
export interface BootReconcileState {
  done: boolean
}

export interface ReclamationDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    role: string
    scrumDir: string
    staleMinutes: number
  }
  log: (msg: string) => void
  /** 本 worker 实例的 scope（回收调用的 `--scope`）。 */
  scope: string
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  useHub: () => boolean
  /** 取值函数：`applyPipeline()` 换流水线来源时整个值会被重新赋值。 */
  isPipeline: () => boolean
  hubPost: (path: string, body: Record<string, unknown>) => Promise<unknown>
  runTaskctl: (scrumDir: string, argv: string[]) => Promise<unknown>
  activity: (kind: string, taskId: string, text: string) => void
  /** 正在调解中的任务 id（与 `mediation.ts` 共享同一份，故由外部持有）。 */
  mediating: Set<string>
  /** 开机孤儿回收状态；**由 `spaceWorker()` 闭包持有**（理由见文件头）。 */
  boot: BootReconcileState
}

/** `createReclamation` 交回给 `index.ts` 的东西（调用顺序即 `index.ts` 里的 `// 0.` → `// 0.5`）。 */
export interface Reclamation {
  reclaimStaleLeases: (byId: Map<string, Task>) => Promise<void>
  reclaimBootOrphans: (tasks: Task[], byId: Map<string, Task>) => Promise<void>
}

export function createReclamation(deps: ReclamationDeps): Reclamation {
  const { config, log, scope, useHub, isPipeline, hubPost, runTaskctl, activity, mediating, boot } = deps

  // 0. 认领租约回收：释放超过 staleMinutes 无进展（距最近 progress 起算）或过 TTL 的 in_progress 任务。
  //    hub 模式走 hub 的 /api/release-stale（守护不直连本地库，多存储部署下避免误碰其他任务池）；本地模式带 --scope 限定本守护 scope。
  async function reclaimStaleLeases(byId: Map<string, Task>): Promise<void> {
    try {
      const res = useHub()
        ? await hubPost('/api/release-stale', { by: config.role, scope, olderThan: config.staleMinutes }) as { released?: string[] }
        : await runTaskctl(config.scrumDir, ['release-stale', '--older-than', String(config.staleMinutes), '--by', config.role, '--scope', scope]) as { released?: string[] }
      for (const id of res.released ?? []) {
        activity('released', id, `距最近进展超过 ${config.staleMinutes} 分钟或过 TTL，自动释放回 todo`)
        const t = byId.get(id)
        if (t) { t.status = 'todo'; t.soldier = null; t.claimedAt = null }
      }
    } catch (e) {
      log(`release-stale 失败：${String(e)}`)
    }
  }

  // 0.5 守护重启孤儿回收（仅进程启动后第一轮）：重启前进程的 worker 已随进程消失，
  //     其任务停在 in_progress 且通常无「未完成」评论——若只靠 stale 释放要等 staleMinutes（如 100 分钟）。
  //     立即把「本守护名下、未拦截」的 in_progress 释放回 todo，下轮自动重新认领续做（复用 w/<id> WIP）。
  //
  //     闸门语义（见文件头）：`boot.done` 在**动手之前**置位，故即使下面的释放调用抛错，
  //     本轮也算「做过了」——与原来闭包里 `bootReconciled = true` 的位置逐字一致。
  async function reclaimBootOrphans(tasks: Task[], byId: Map<string, Task>): Promise<void> {
    if (boot.done) return
    boot.done = true
    // 只回收本守护认领的任务（soldier = 守护角色或流水线阶段角色）；人类手动在办（soldier=人名）不碰。
    const claimedByUs = (t: Task): boolean =>
      t.soldier === config.role || (isPipeline() && t.role !== null && t.soldier === t.role)
    const orphans = tasks
      .filter(t => t.status === 'in_progress' && claimedByUs(t) && !t.hold && !mediating.has(t.id))
      .map(t => t.id)
    if (orphans.length > 0) {
      try {
        const res = useHub()
          ? await hubPost('/api/release-stale', { by: config.role, scope, olderThan: config.staleMinutes, ids: orphans }) as { released?: string[] }
          : await runTaskctl(config.scrumDir, ['release-stale', '--older-than', '0', '--by', config.role, '--scope', scope]) as { released?: string[] }
        for (const id of res.released ?? []) {
          activity('released', id, '守护重启：孤儿 in_progress 释放回 todo，自动重新认领续做')
          log(`${id} 守护重启孤儿回收 → todo（下轮重新认领续做）`)
          // 同步更新本轮快照：若不同步，step 3 仍按旧快照把该任务当 in_progress + 有 abort 评论 →
          // abortDriven 重派会派「无主 worker」（workReturned 不 claim），占满 inflight 且任务仍是 todo。
          const t = byId.get(id)
          if (t) { t.status = 'todo'; t.soldier = null; t.claimedAt = null }
        }
      } catch (e) {
        log(`守护重启孤儿回收失败：${String(e)}`)
      }
    }
  }

  return { reclaimStaleLeases, reclaimBootOrphans }
}

// plugins/src/stateMachine.ts
// ============================================================================
// PRT-315（第 3 个切片）：**状态机**——`spaceWorker()` 每轮扫单的任务迁移决策
//
// ## 这一批在做什么
//
// 第 1 个切片（`./mediation.ts`）取了「交接边界」的合入调解；第 2 个切片
// （`./reclamation.ts`）取了「仓储边界」的租约回收。本文件是**第 3 个切片**，
// 取「状态机」：`sweep()` 里那五段带编号注释的**任务迁移决策**——
//
//   · `// 1. todo：认领（互斥）→ 派工`（流水线模式按任务角色；讨论任务走群聊）；
//   · `// 2. blocked 且本角色、依赖已全部解除：解阻续做`（同样遵守拦截）；
//   · `// 3. in_progress 且本角色、认领后有他人评论：视为退回，附反馈纠错`；
//   · `// 3.1 连续 worker 失败 → 交调解员处理重派`（默认不升级将军）；
//   · `// 3.2 存在将军 / 他人反馈 → 退回附反馈纠错；只有守护自己的
//      「worker 未完成/超时/派工失败」评论 → 退避重试`。
//
// 连同它们读的**判定谓词**一起搬：`openDeps`（依赖闸门）、`confirmState`（❓ 待答复）、
// `gaveUp` / `giveUpAwaitingGeneral`（🛑 give-up 闸门）、`workerFailStreak`（连续失败计数）、
// `medWorkerRedispatchCount`（调解重派计数）、`self` / `isOurs`（本角色判定）。
//
// 这些谓词此前是 `sweep()` 里一串**没有名字归属**的闭包箭头函数：它们的存在理由是
// 「第 1/2/3 步要用」，却躺在 2700 行闭包的中间——想知道「什么情况下任务会被自动重跑」，
// 唯一的办法是把整个 `spaceWorker` 读完。
//
// ## 这个模块**没有**改变任何行为
//
// 代码逐段搬过来，除了文件头 §「依赖」写明的两类显式化改写（**判定谓词从隐式捕获变显式
// 依赖**、`isPipeline` / `stageByRole` 从闭包变量变**取值函数**），一行都没有动：
// 日志串、`safeComment(...)` 文案、`activity(...)` 调用、`try/catch` 的吞错范围、
// `t.hold` / `openDeps` / `sliceRoomOk` 的**判定顺序**、`runDetached` 的用法、
// `useHub ? A : B` 一类的分派（本切片没有这类分派），以及 `for` 循环的顺序全部照旧。
//
// ## 依赖：这里**没有**模块级可变状态
//
// 本模块不持有任何跨轮状态：`runRound(tasks, byId)` 的每一轮输入都由调用方给，
// `inflight` / `abortRetryAt` 这两个**会被改写**的集合由 `spaceWorker()` 闭包持有并注入。
//
// 为什么必须这样，而不是把 `abortRetryAt` 挪成模块级变量：
//
//   `superviseSpaces()` 会在**同一进程**里按空间把 `spaceWorker` mount 成多个子实例
//   （`plugins/src/index.ts` 的 `mountRunner`），它们共用一个模块注册表。一个模块级
//   `abortRetryAt` 会让空间 A 的退避把空间 B 的**同名 taskId** 一起挡住——
//   任务 id 在多空间部署里只在空间内唯一，跨空间撞号是常态而不是意外。
//   症状是"某个空间的中止重试莫名其妙地被退避吞掉"，日志里一行都不会有。
//
//       > 一个"每实例一份"的闭包 Map，
//       > 与一个"每进程一份"的模块级 Map，在只有一个守护实例的部署里是同一个东西——
//       > 只不过多空间部署下，后者会让两个空间的任务 id 互相退避。
//
// ## 依赖：运行期会被重新赋值的绑定传**取值函数**，不传值
//
// `isPipeline` 与 `stageByRole` 都是 `spaceWorker()` 里的 `let`，`applyPipeline()`
// 换流水线来源时会被**重新赋值**（`stageByRole` 整个 Map 被替换）。
//
// 传值 = 模块从构造那一刻起看着一份**冻结的旧快照**，而症状不报错：
//
//   · `isPipeline` 快照 → 切到流水线之后，`isOurs` 一直按单角色口径（`soldier ===
//     config.role`）判定：阶段角色认领的任务**被判成"不是本守护的"**，
//     blocked 解阻与 in_progress 退回纠错**静默地不再发生**，任务干等 stale 释放；
//   · `stageByRole` 快照 → 换流水线之后，"本角色"映射整个是旧的。
//
//       > 一个"构造时快照了可变配置"的模块，
//       > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
//       > 只不过前者会在配置变化之后，安静地继续按旧的来。
//
// `config` / `scope` / `stageOf` / `maxWorkerRetry` / `maxMediateAttempts` 传值：
// 前三个在 `spaceWorker()` 里是 `const`（`stageOf` 是一个闭包箭头函数，身份稳定、
// 每次调用重新读 `stageByRole`），后两个是常量。
//
// ## `stageOf` 为什么**留在** `index.ts` 由调用点注入
//
// `stageOf(t)`（任务 → 流水线阶段）本切片也读，但**不搬**：`sweep()` 的
// `// 4. 流水线 done 补流转`（流水线边界，非本切片）同样用它。
// 搬进来要么在 `index.ts` 留第二份（**同一逻辑两处**，正是任务禁止的），
// 要么让流水线补流转去够状态机模块里的一个阶段查表——后者把依赖方向搞反了。
// 所以它留给调用点注入：一个身份稳定、每次调用重新取值 `stageByRole` 的箭头函数。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// 与 `mediation.ts` / `reclamation.ts` 同源：`Config` 是 `index.ts` 里由 zod schema
// 推出来的值，import 它形成**真的**运行时循环依赖。这里只声明本切片真正读的两个字段；
// 调用点传的是**真的** `Config`，TypeScript 在赋值处校验可赋值性——字段改名的那天
// 红在**调用点**，而不是让这里安静地读到 `undefined`。
// ============================================================================

import type { StageDef, Task } from './types.js'

export interface StateMachineDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    role: string
    intervalMs: number
  }
  log: (msg: string) => void
  /** 本 worker 实例的 scope（`transitionTo` / `safeComment` 的默认 scopeFor）。 */
  scope: string
  /** 取值函数：`applyPipeline()` 换流水线来源时整个值会被重新赋值。 */
  isPipeline: () => boolean
  /** 取值函数：`applyPipeline()` 换来源时整个 Map 会被替换。 */
  stageByRole: () => Map<string, StageDef>
  /** 任务 → 流水线阶段（**单一定义留在 `index.ts`**，理由见文件头）。 */
  stageOf: (t: Task) => StageDef | undefined
  /** 本实例的在办任务登记（`inflight.has` 去重 + `runDetached` 收尾）。 */
  inflight: Set<string>
  /** 并发预算闸门（`inflight.size < config.maxWorkers`，仍归调用方）。 */
  room: () => boolean
  /** 切片类型化槽位闸门（依赖本轮任务聚合，属切片编排边界，仍归调用方）。 */
  sliceRoomOk: (t: Task) => boolean
  runDetached: (taskId: string, job: Promise<void>) => void
  /** 中止类重试的退避表（**每实例一份**，理由见文件头）。 */
  abortRetryAt: Map<string, number>
  /** worker 连续「未完成/超时/派工失败」重试上限（`spaceWorker()` 里的常量 `maxWorkerRetry`）。 */
  maxWorkerRetry: number
  /** 调解员处理重派上限（`spaceWorker()` 里的常量 `maxMediateAttempts`）。 */
  maxMediateAttempts: number
  claimTask: (id: string, soldier: string) => Promise<void>
  workTodo: (t: Task, stage?: StageDef) => Promise<void>
  workReturned: (t: Task, feedback: Task['comments'], stage?: StageDef) => Promise<void>
  runDiscussion: (t: Task) => Promise<void>
  safeComment: (id: string, text: string, scopeFor?: string) => Promise<void>
  transitionTo: (id: string, to: string, scopeFor?: string) => Promise<void>
  mediatorRecoverWorker: (taskId: string, taskScope?: string) => Promise<{ fixed: boolean; summary?: string; whyFailed?: string }>
}

/** `createStateMachine` 交回给 `index.ts` 的东西（调用顺序即 `index.ts` 里的 `// 1.` → `// 3.2`）。 */
export interface StateMachine {
  runRound: (tasks: Task[], byId: Map<string, Task>) => void
}

export function createStateMachine(deps: StateMachineDeps): StateMachine {
  const {
    config, log, scope, isPipeline, stageByRole, stageOf,
    inflight, room, sliceRoomOk, runDetached, abortRetryAt,
    maxWorkerRetry, maxMediateAttempts,
    claimTask, workTodo, workReturned, runDiscussion,
    safeComment, transitionTo, mediatorRecoverWorker,
  } = deps

  // 流水线模式：守护按任务角色认领/派工；单角色模式：只认 config.role 的任务
  const self = (t: Task) => (isPipeline() ? (t.role ?? config.role) : config.role)
  const isOurs = (t: Task) => (isPipeline() ? (t.role !== null && stageByRole().has(t.role)) : t.soldier === config.role)

  // ❓ 士兵提问待将军答复状态：最后一条 ❓（守护评论）之后还没有他人（非守护）评论 = 仍待答复。
  // 返回 { open: 是否仍在等答复, answers: 将军/他人已给的答复评论（供重跑时带进提示词） }
  const confirmState = (t: Task): { open: boolean; answers: Task['comments'] } => {
    const asks = t.comments.filter(c => (c.text ?? '').startsWith('❓'))
    if (asks.length === 0) return { open: false, answers: [] }
    const lastAsk = asks[asks.length - 1]
    const answers = t.comments.filter(c => c.by !== config.role && new Date(c.at).getTime() >= new Date(lastAsk.at).getTime())
    return { open: answers.length === 0, answers }
  }
  // worker 连续失败 give-up：任务已带 🛑 give-up 标记。仅当「将军/他人（非守护）在该标记之后新评论」才解除等待 → 将军答复后下轮自动续做；
  // 未答复前保持停手（blocked/in_progress 均不自动重跑），避免 40 分钟 stale 释放→重新认领→再失败的无限空转。
  const gaveUp = (t: Task): boolean => t.comments.some(c => (c.text ?? '').startsWith('🛑 已自动重试'))
  const giveUpAwaitingGeneral = (t: Task): boolean => {
    const lastGiveUp = [...t.comments].reverse().find(c => (c.text ?? '').startsWith('🛑 已自动重试'))
    if (!lastGiveUp) return false
    const ts = new Date(lastGiveUp.at).getTime()
    return !t.comments.some(c => c.by !== config.role && new Date(c.at).getTime() >= ts)
  }
  // 同一认领内末尾连续的「worker 未完成/超时/派工失败」计数（将军/他人评论或非失败评论会打断并重置）。
  // 超时也算失败：跑满 workerTimeoutMs 被强制结算同样说明这轮没产出，连续超时也是热循环（如 reviewer 大 diff 超时→重派→再超时）。
  // T-117 现场（fix 背景）：runWorker 每轮派工都发「🟢 已派 AI worker」评论，它在 ⚠ 失败评论之后；
  // 旧实现从尾部倒数遇 🟢 即 break，streak 恒 0 → give-up/调解（maxWorkerRetry）永不触发 → 无限重派死循环。
  // 修复：🟢 派工评论只标记「新一轮开始」，跳过不打断失败连续计数；将军/他人评论等仍打断。
  const workerFailStreak = (t: Task): number => {
    const since = t.claimedAt === null ? 0 : new Date(t.claimedAt).getTime()
    let n = 0
    for (let i = t.comments.length - 1; i >= 0; i--) {
      const c = t.comments[i]
      if (new Date(c.at).getTime() < since) break
      const txt = c.text ?? ''
      if (txt.startsWith('⚠ worker 未完成') || txt.startsWith('⚠ worker 超时') || txt.startsWith('⚠ 派工失败')) n++
      else if (txt.startsWith('🟢 已派 AI')) continue
      else break
    }
    return n
  }
  // 调解员处理重派已发生的次数（按 🤝 标记计数）：超过上限后不再自动调解，转将军（终态安全阀，防调解-再失败死循环）。
  const medWorkerRedispatchCount = (t: Task): number =>
    t.comments.filter(c => (c.text ?? '').startsWith('🤝 调解员处理重派')).length

  function runRound(tasks: Task[], byId: Map<string, Task>): void {
    // 依赖未解除（链上后段在上一环 done 前保持待命，不空转抢认领）
    const openDeps = (t: Task): boolean =>
      (t.blockedBy ?? []).some(depId => {
        const dep = byId.get(depId)
        return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
      })

    // 1. todo：认领（互斥）→ 派工（流水线模式按任务角色；讨论任务走群聊）。
    //    自动交接纪律：被将军拦截（hold）的任务不认领；依赖未解除的任务待上一环 done 后由下轮认领。
    for (const t of tasks.filter(t => t.status === 'todo')) {
      if (!room() || inflight.has(t.id)) continue
      if (isPipeline() && stageOf(t) === undefined && t.role !== 'discussion') continue // 流水线模式跳过无角色/未知角色任务
      if (t.hold) continue // 将军拦截：等放行
      if (openDeps(t)) continue // 链上后段：上一环 done 后自动交接
      if (!sliceRoomOk(t)) continue // 切片类型化槽位 / 目标并发预算已满：留给其他切片或下轮
      inflight.add(t.id)
      const job = t.role === 'discussion' ? runDiscussion(t) : workTodo(t, stageOf(t))
      runDetached(t.id, job)
    }
    // 2. blocked 且本角色、依赖已全部解除：解阻续做（同样遵守拦截）；
    //    士兵「❓ 待将军答复」的疑问型 blocked 不自动重跑——醒目等将军介入，将军评论答复后下轮自动带答复续做
    for (const t of tasks.filter(t => t.status === 'blocked' && isOurs(t))) {
      if (!room() || inflight.has(t.id)) continue
      if (t.hold) continue
      if (openDeps(t)) continue
      if (giveUpAwaitingGeneral(t)) continue // give-up 待将军答复：不自动续做，等将军评论后下轮带答复续做
      if (!sliceRoomOk(t)) continue
      const cf = confirmState(t)
      if (cf.open) continue // 待将军确认：不自动重跑，等答复
      // blocked 续做必须先认领（claim blocked→in_progress），否则任务停留在 blocked：
      // worker 心跳（/api/progress 仅 in_progress 可上报）与完成结算（advanceTo）都会失败
      // ——T-117 现场：将军答复后 workReturned 未认领，任务长时间卡 blocked、progress 被 hub 拒。
      // workReturned 不认领（workTodo 才认领），故 answers>0（带将军答复续做）需先 claim；
      // answers=0 保持 workTodo 原路径（其内部 claimTask 幂等，勿重复认领）。
      const resumeStage = stageOf(t)
      if (cf.answers.length > 0) {
        inflight.add(t.id)
        runDetached(t.id, (async () => {
          try {
            await claimTask(t.id, resumeStage ? resumeStage.role : config.role)
          } catch (e) {
            log(`${t.id} blocked 续做认领失败（可能已被他人认领）：${String(e)}`)
            return
          }
          await workReturned(t, cf.answers, resumeStage)
        })())
      } else {
        inflight.add(t.id)
        runDetached(t.id, workTodo(t, resumeStage))
      }
    }
    // 3. in_progress 且本角色、认领后有他人评论：视为退回，附反馈纠错；
    //    守护自己的「worker 未完成 / 派工失败」评论也触发重试（单角色模式 self=config.role 会把它过滤掉，
    //    导致中止的 worker 只能等 stale 释放），带 ≥4 个扫单周期的退避，避免故障期间热循环
    for (const t of tasks.filter(t => t.status === 'in_progress' && isOurs(t))) {
      if (!room() || inflight.has(t.id)) continue
      if (t.hold) continue // 将军拦截进行中任务：不自动纠错续跑
      if (giveUpAwaitingGeneral(t)) continue // give-up 待将军答复：不自动重跑，等将军评论后下轮带答复续做
      if (confirmState(t).open) continue // ❓ 待将军确认：不自动重跑，等将军答复（否则士兵❓后仍被错误重派，造成空转）
      const since = t.claimedAt === null ? 0 : new Date(t.claimedAt).getTime()
      const feedback = t.comments.filter(c => new Date(c.at).getTime() > since && c.by !== self(t))
      // 3.1 连续 worker 失败 → 交调解员处理重派（默认不升级将军）：调解员诊断根因并修复工作树，成功后重新派工；
      //     只有在「调解已尝试 ≥maxMediateAttempts 次仍失败」或「调解员无法修复根因」时才置 blocked 留将军（终态安全阀）。
      const streak = workerFailStreak(t)
      if (streak >= maxWorkerRetry && !gaveUp(t)) {
        inflight.add(t.id)
        runDetached(t.id, (async () => {
          if (medWorkerRedispatchCount(t) >= maxMediateAttempts) {
            await safeComment(t.id, `🛑 已自动重试 ${streak} 次、调解员处理重派 ${maxMediateAttempts} 次仍未解决，任务已置 blocked，请将军人工处理（或转派）`, t.scope ?? scope)
            await transitionTo(t.id, 'blocked', t.scope ?? scope)
            return
          }
          const rec = await mediatorRecoverWorker(t.id, t.scope ?? scope)
          if (rec.fixed) {
            await safeComment(t.id, `🤝 调解员处理重派：已修复根因（${(rec.summary ?? '').slice(0, 200)}），重新派工续做`, t.scope ?? scope)
            await workReturned(t, [], stageOf(t))
          } else {
            await safeComment(t.id, `🛑 已自动重试 ${streak} 次且调解员未能自动修复根因（${(rec.whyFailed ?? rec.summary ?? '').slice(0, 160)}），任务已置 blocked，请将军人工处理（或转派）`, t.scope ?? scope)
            await transitionTo(t.id, 'blocked', t.scope ?? scope)
          }
        })())
        continue
      }
      // 3.2 存在将军 / 他人反馈 → 退回附反馈纠错；只有守护自己的「worker 未完成/超时/派工失败」评论 → 退避重试
      // （超时也算中止驱动：worker 跑满 workerTimeoutMs 被强制结算后任务留在 in_progress，下一轮应自动重试续做）
      const abortDriven = feedback.length === 0 && t.comments.some(c =>
        new Date(c.at).getTime() > since && (c.text.startsWith('⚠ worker 未完成') || c.text.startsWith('⚠ worker 超时') || c.text.startsWith('⚠ 派工失败')))
      if (feedback.length === 0 && !abortDriven) continue
      if (abortDriven && (abortRetryAt.get(t.id) ?? 0) + config.intervalMs * 4 > Date.now()) continue
      if (abortDriven) abortRetryAt.set(t.id, Date.now())
      inflight.add(t.id)
      runDetached(t.id, workReturned(t, feedback, stageOf(t)))
    }
  }

  return { runRound }
}

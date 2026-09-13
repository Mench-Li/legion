// product/orchestrator/claim-gate.mjs
// ============================================================================
// 认领闸门：把**产品状态**接到 Orchestrator 的认领决定上（PRT-711 / spec §6.3）
//
// ## 这个模块存在的理由
//
// `product/runtime-state.mjs` 已经把 spec §6.3 那张表做全了——产品状态 → 认领行为。
// 但它当时**没有任何生产调用方**，于是那张表在真实运行里从不生效：
// worker 只问「我能不能执行」（有没有 executor、阶段齐不齐），
// 从不问「现在该不该执行」。
//
//   > 一个"引擎在、我就认领"的 worker，
//   > 与一个在升级过程中继续把任务领走并跑起来的 worker，
//   > 是同一个东西——只不过前者在"我能不能执行"这个问题上回答得完全正确。
//
// 本模块就是那根线：它在 **worker 进程的入口**（`worker.mjs`）里被装上，
// 而入口文件本身保持"只有一层转发"（它自己的注释把这条写成设计约束），
// 所以判定逻辑住在这里。
//
// ## 两个容易搞错的地方
//
// ① **闸门是函数，不是取值。** worker 每轮 tick() 都重新问一次。
//    "正在升级"是运行中发生的事；只在启动时判一次，等于在升级开始的下一秒
//    又开始认领。
//
// ② **认不出来的处境不许落到 `ready`。** `ready` 是唯一会让 worker
//    领走任务的档。缺省档取 `unavailable`——不是"保守"，而是
//    "没问过"与"问过说可以"是两件事。
// ============================================================================

import { EXECUTOR_CODES } from '../../orchestrator/worker/executor.mjs'
import { liftProductState, mayClaimTasks } from '../runtime-state.mjs'

/**
 * 执行引擎状态 → **产品状态**。
 *
 * 判据用**执行引擎自己的回答**，不用推断：
 *
 * | 执行引擎状态 | 产品状态 | 为什么 |
 * | --- | --- | --- |
 * | 已接线 | `ready` | 自检过了、强制面生效了，本进程具备全部能力 |
 * | 拒绝且码是 `EXECUTOR_SELF_CHECK_INCOMPATIBLE` | `incompatible` | 强制面没生效。**进程都起来了不等于能力层生效了** |
 * | 其它拒绝（缺宿主端口 / 接线错） | `unavailable` | 不是"不兼容"，是"现在干不了" |
 */
export function runtimeStateFromExecutor({ wired, refusal } = {}) {
  if (wired === true) return Object.freeze({ processState: 'ready', selfCheck: null })
  const code = refusal?.code ?? null
  if (code === EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE) {
    return Object.freeze({
      processState: 'unavailable',
      selfCheck: Object.freeze({ state: 'incompatible', reasons: Object.freeze([...(refusal?.reasons ?? [])]) }),
    })
  }
  return Object.freeze({ processState: 'unavailable', selfCheck: null })
}

/**
 * 造一个认领闸门交给 worker。
 *
 * @param {{wired:boolean, refusal:object|null}} executorStatus 执行引擎状态
 * @param {() => object} getOverrides 每轮重新求值的**外部信号**：
 *   `{ upgrading, processState, selfCheck, satisfiedCapabilities }`。
 *   它只可能把状态**往上抬**（更保守）——这一点由 `liftProductState` 保证，
 *   调用方无法用它把状态"抬"成 `ready`。
 */
export function claimGateFromExecutor({ wired, refusal } = {}, getOverrides = () => ({})) {
  return () => {
    const o = getOverrides() ?? {}
    const base = runtimeStateFromExecutor({ wired, refusal })
    const lifted = liftProductState(o.processState ?? base.processState, {
      selfCheck: o.selfCheck ?? base.selfCheck,
      upgrading: o.upgrading === true,
    })
    const verdict = mayClaimTasks(lifted.state, { satisfiedCapabilities: o.satisfiedCapabilities ?? null })
    return { ...verdict, liftedFrom: lifted.liftedFrom, liftReason: lifted.reason }
  }
}

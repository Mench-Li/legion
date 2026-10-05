// plugins/src/timeoutSettlement.ts
// ============================================================================
// BUG-007：worker 超时后的结算计划（纯决策 + 文案，便于单测两个分支）
//
// ## 缺陷（现场记录 `docs/bugs/BUG-007-timeout-reservation-not-released.md`）
//
// 超时结算从前只写一句「任务保留在 in_progress，下一轮自动重试（会复用 w/<id> 的 WIP 续做）」
// 就返回：**既不改变任务状态、也不碰写入预约**。而 15 分钟后守护自己的 stale 回收器
// （`team-hub/server.mjs` 的 `releaseStaleTasks` 超龄分支）会把该预约**冻结**成
// `reconciling`，于是那句"下一轮自动重试"永远无法兑现——认领一律被 `RECONCILING`
// （"上一轮执行尚未确认停止"）拒掉，只能人工
// `POST /api/tasks/:id/reservation/confirm-stopped` 解开。
//
// 实测后果（2026-10-05）：T-178 与 T-179 **同时**卡在待认领，两个并发槽位空转，
// 且每 40 分钟必然复现一次（超时 25 分钟 + stale 40 分钟的时间差）。
//
// ## 为什么不能"超时就顺手释放"
//
// `abort()` **不保证杀死子代理**（见 `index.ts` 看门狗那段的注释）。若在 worker 可能还活着时
// 释放预约并让下一个 worker 认领，就会出现**两个写者**；而重派实测会**复用同一个 worktree**
// （守护日志：`T-xxx 复用既有 worktree：…\.legion-worktrees\T-xxx`），
// 两个写者会落在**同一个目录**里——比写两个不同目录更糟。写入预约（T-170）正是为防这件事。
//
// ⇒ 本模块的分工是：**先取证，再决定。**
//
//   · **能证明终止**（abort + dispose 之后 `run.result` 在宽限期内到达终态）
//     ⇒ 走**既有诚实出口**：执行者自己（`transitionTo` 里 `by = t.soldier`）以
//       `confirmedStopped: true` 走 `in_progress → todo`；在 `team-hub/server.mjs`
//       的 transition 里这条路径是**释放**（`cancelled: false`）而不是冻结。
//   · **不能证明** ⇒ **保持持有**（安全方向不许为自动化让步），但文案必须说实话：
//       说清"写入占用仍被本轮持有""不会自动重试"，并给出确切的恢复命令。
//
// ★ 这条与提交 `b5ce7ec8`（守护重启孤儿路径）修的是**同一个病**：
//   "执行者已经不存在了"这个事实，必须在预约上被表达出来——否则承诺与效果就是两张皮。
// ============================================================================

/**
 * 宽限期：`abort()` + `run.dispose()` 之后，等 `run.result` 结算多久才承认"取不到终止证据"。
 *
 * 取值理由：正常被 abort 的 run 会在秒级内结算；取 20 秒是给"正在收尾的写操作落盘"留余量，
 * 同时不至于让一个挂死的 run 拖住扫描循环（`intervalMs` 是 30 秒量级）。
 */
export const TIMEOUT_SETTLE_GRACE_MS = 20_000

/** 超时结算的计划：要么"释放并重派"，要么"保持持有等人工"。 */
export interface TimeoutSettlementPlan {
  /** `release-and-retry`：已取得终止证据 ⇒ 回 todo 并释放预约；`hold-for-manual`：取不到 ⇒ 保持持有。 */
  action: 'release-and-retry' | 'hold-for-manual'
  /** 传给 `/api/transition` 的 `confirmedStopped`（hold 时**必须**为 false）。 */
  confirmedStopped: boolean
  /** 目标状态；hold 时为 `null`（**不动状态**，预约继续被本轮持有）。 */
  to: 'todo' | null
  /** 写进任务评论的文案（必须与**实际效果**一致）。 */
  comment: string
  /** 写进活动流的文案。 */
  activity: string
}

/**
 * 决定"超时之后怎么结算"。**纯函数**：两个分支的文案与字段都在这里钉住，避免
 * "实现改了而评论还在承诺旧行为"——那正是本缺陷的形态。
 */
export function planTimeoutSettlement(input: {
  taskId: string
  /** 是否已取得"该次 run 已终止"的证据（由 `workerStoppedWithin` 给出）。 */
  stopped: boolean
  graceMs: number
  timeoutMinutes: number
}): TimeoutSettlementPlan {
  const { taskId, stopped, graceMs, timeoutMinutes } = input
  if (stopped) {
    return Object.freeze({
      action: 'release-and-retry' as const,
      confirmedStopped: true,
      to: 'todo' as const,
      comment: `⚠ worker 超时（>${timeoutMinutes} 分钟）：已确认该次执行终止`
        + `（abort 后 run 在 ${Math.round(graceMs / 1000)} 秒内到达终态），`
        + `写入占用随之释放，任务回到 todo 等待下一轮重派（会复用 w/${taskId} 的 WIP 续做）。`,
      activity: 'worker 超时强制结算：已确认终止，释放写入占用并重派',
    })
  }
  return Object.freeze({
    action: 'hold-for-manual' as const,
    confirmedStopped: false,
    to: null,
    // ★ 这段文案不许出现"自动重试"这类承诺：不能证明 worker 已停止时，重派是**不安全**的
    //   （两个写者会落进同一个 worktree）。所以它说的是"保持持有 + 需要人工确认 + 确切命令"。
    comment: `⚠ worker 超时（>${timeoutMinutes} 分钟），但**未能确认该 worker 已停止**`
      + `（abort 后 ${Math.round(graceMs / 1000)} 秒内 run 未结算）。`
      + `为避免两个写者落进同一个 worktree，**写入占用仍被本轮持有，且不会自动重试**。`
      + `确认执行者已停止后请执行：POST /api/tasks/${taskId}/reservation/confirm-stopped`
      + `（body: {"by":"general","confirm":"stopped:${taskId}"}）。`,
    activity: 'worker 超时强制结算：未能确认停止，保持持有等待人工确认',
  })
}

/**
 * `abort()` + `dispose()` 之后，在宽限期内问 `run.result` 是否结算
 * （结算 = 该次 run 已到终态 ⇒ 我们**有**"执行者已终止"的证据）。
 *
 * ★ 这是"取证"，不是"猜想"：本函数只回答"证据到没到"，**不**回答"要不要释放"
 *   （那是 `planTimeoutSettlement` 的事）。
 */
export async function workerStoppedWithin(run: { result: Promise<unknown> }, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run.result.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

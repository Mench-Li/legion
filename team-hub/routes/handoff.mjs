// team-hub/routes/handoff.mjs
// ============================================================================
// 路由层：**从任意一环接手（handoff）** —— 1 条，`exact`
//
//   POST /api/handoff/settle
//
// ## 它解决的问题
//
// 目标链上某一环的活**已经干完了**（例如编码已在 `w/T-224 @ 717607bf` 交付并通过
// 测试），但流程接不上：审查环认领要求"实现环有一份 state=passed 的独立测试回执
// + 与之一致的实现证据"。没有这份东西，只剩两条路——整链重来（≈3 小时，代码一行
// 不变），或者派个 agent 把已写好的代码"再实现一遍"（实测就这么发生了，被叫停）。
//
// 这条路由做第三种选择：**接手那一环，只补结算**。
//
// ## 为什么是路由 + 注入的域函数
//
// 与 `rework.mjs` 同一个理由：这件事在一个事务里做多步（准备 worktree → 跑冻结
// 验证 → 写 attempt → 写实现证据 → 写检查点 → 置 done），而路由层只该负责
// "HTTP 形状 → 域函数参数"。判定（回执能不能交出去）已在 `handoff-settle.mjs`，
// 有独立单测；这里再掺判定进去，就会出现第二份真相。
//
// ## 语义边界（写死在参数校验里）
//
//   · 只接**工作流实现阶段**的任务：别的环"接手"会绕开它自己的证据契约；
//   · 只接 `todo` / `in_review` 的任务：`in_progress` 说明有人正在干，抢过来等于
//     两处同时写同一份工作区；
//   · 必须显式给出 `by`（`handleWrite` 的既有闸门）；
//   · 幂等：重复调用同一个任务时，域函数返回既有的结算结果，不重复跑命令。
// ============================================================================

/**
 * 造 handoff 路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 * @param {(input: {taskId: string, by: string, reason?: string}) => object} deps.settleHandoff
 *        域函数：跑冻结验证并按判定结果结算这一环（实现见 `settleHandoff`）
 */
export function createHandoffRoutes({ json, handleWrite, settleHandoff, audit }) {
  for (const [k, v] of Object.entries({ json, handleWrite, settleHandoff })) {
    if (v === undefined || v === null) throw new TypeError(`createHandoffRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/handoff/settle',
      async run(req, res) {
        // envelope: null —— 这次写的结果是一份**结算报告**（回执、attempt、判定），
        // 不是"那个任务"。塞进 `{ok, task}` 会让调用方以为改的是任务本身。
        await handleWrite(req, res, (body, by, scope) => {
          const taskId = body.id ?? body.taskId
          if (typeof taskId !== 'string' || taskId.trim() === '') throw new Error('缺少参数 id（要结算的任务 ID）')
          const result = settleHandoff({
            taskId: taskId.trim(),
            by,
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          })
          audit?.(by, scope, 'handoff:settle', taskId.trim(), {
            state: result?.settlement?.state ?? null,
            attemptId: result?.attempt?.id ?? null,
            sourceCommit: result?.sourceCommit ?? null,
          })
          return result
        }, { envelope: null })
      },
    },
  ]

  const matches = (r, path) => (r.match === 'exact' ? path === r.path : false)

  return {
    id: 'handoff',
    routes,
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

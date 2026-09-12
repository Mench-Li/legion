#!/usr/bin/env node
// product/orchestrator/worker.mjs
// ============================================================================
// Legion Orchestrator worker 的**入口**（进程清单里声明的那个路径，PRT-301）
//
// 这个文件刻意只有一层：清单冻结了「orchestrator 的入口是
// `product/orchestrator/worker.mjs`」这个事实（`product/process-manifest.mjs`），
// 而实现住在 `orchestrator/`（spec §11 的目录约定）。
// 让入口保持成一层转发，有两个具体好处：
//   ① 清单里的路径不必因为实现搬家而改（它是被用例与文档对账的契约）；
//   ② 「进程从哪里开始跑」与「编排逻辑长什么样」可以分别阅读。
//
// 本入口不做任何逻辑判断：所有判定都在 `orchestrator/worker/run.mjs` 里，
// 因而可以在不启动真实进程的情况下被完整测试。
// ============================================================================

import { runWorkerProcess } from '../../orchestrator/worker/run.mjs'
import { productionExecutorProviderFromEnv } from '../../orchestrator/worker/executor-binding.mjs'

// PRT-253：把生产执行引擎的**提供者**交给 worker。
//
// 为什么是提供者而不是直接造一个 executor：构造要先做启动自检（异步、可能拒绝），
// 而拒绝的理由必须能进启动结果——"自检没过"、"缺宿主端口"、"忘了配 hub"
// 三种处境的修复动作完全不同，而它们以前在 Launcher 看来都是同一句 `no-executor`。
//
// 今天它大概会返回 `EXECUTOR_HOST_PORT_REQUIRED`：DSH 宿主端口的绑定
// 由 `runtime/dsh-composition/` 在 DSH 进程内完成（PRT-214/215），
// 而 worker 是独立进程。装上之后，**这个入口不需要改一行代码**就开始真的执行。
const startup = await runWorkerProcess({
  executorProvider: () => productionExecutorProviderFromEnv({}),
})

// 起不来时必须**以非零码退出**。
// 上一版这里写成 `const { runPromise } = await runWorkerProcess()`，
// 而起不来时函数返回的是数字 `8`——解构一个数字得到 `undefined`，
// 于是 `await undefined` 通过、下面把退出码设成 0。
// Launcher 会据此认为「worker 起来了」，而它其实什么都没做。
if (startup.ok !== true) {
  process.stderr.write(`✖ orchestrator worker 无法启动（${startup.code}）：${startup.message}\n`)
  process.exit(startup.exitCode)
}

// 状态文件的位置必须打在启动日志里：这是运维唯一能在不猜的情况下知道
// 「这个没有端口的进程现在在干什么」的入口。§10 的仅回环约束也让「去连它看看」
// 不成立——它根本没有端口。
process.stdout.write(`[worker] 状态文件：${startup.statusPath}\n`)

// 执行引擎没接上时必须**显式说出来**，而且要带上码。
// 以前这里只有一句"没配"——于是"自检没过"（该去看强制面）、
// "缺宿主端口"（该去看组合层接线）、"没配 hub"（该去看配置）
// 三种修复动作完全不同的处境，在启动输出里长得一模一样。
//
// 注意这**不是**致命错误：worker 仍然起来了、仍然写状态文件、
// 仍然不认领任何任务。一个"起来了但干不了活"的进程必须能说清自己缺什么，
// 否则运维看到的信息就只剩"进程在跑"。
if (startup.executorWired !== true) {
  const r = startup.executorRefusal
  process.stdout.write(`⚠ [worker] 执行引擎未接线：${r?.code ?? '(无码)'} ${r?.message ?? ''}\n`)
  for (const reason of r?.reasons ?? []) process.stdout.write(`    · ${reason}\n`)
}

// 长驻在这里等主循环结束。主循环只在收到停止信号并完成
// 「停止认领 → 释放 lease → 写终态」之后才返回，因此这一行同时也是
// 「优雅停止真的走完了」的保证——提前 process.exit() 会跳过释放 lease，
// 任务就得等租期自然过期才能被别人领走（表现为队列卡住，且没有任何错误信息）。
//
// ⚠️ 但 Windows 上这条路径**可能一次都不会执行**：任何「终止」都是无条件终止，
// 接收方的信号处理器不会被调用（见 orchestrator/worker/status-file.mjs 的 isStatusFresh）。
// 因此释放 lease 不能只依赖这一步，Launcher 侧与租期本身都必须能兜住。
await startup.runPromise
process.exitCode = 0

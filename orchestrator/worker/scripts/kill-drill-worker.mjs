#!/usr/bin/env node
// orchestrator/worker/scripts/kill-drill-worker.mjs
// ============================================================================
// **测试夹具**：一个真实的 worker 进程，可以在指定阶段卡住，供 PRT-312 的强杀演练使用。
//
// 为什么必须是真的进程（而不是把 `createWorker` 放进测试进程里）：
// 阶段 3 的完成标准是「**强制终止** worker 或 DSH 后，重启不会丢任务、伪装成功
// 或重复执行已确认的外部写操作」。这些性质全都与被杀那一刻**磁盘上留了什么**有关
// （Attempt 状态、lease、幂等键）。在同一个进程里模拟"被杀"只能靠不调用某个函数，
// 而真实强杀的语义是「函数执行到一半，进程没了」——两者留下的痕迹不同。
//
// 而且 Windows 上 `child.kill('SIGTERM')` 会**无条件终止**目标进程，
// 信号处理器根本不会被调用；只有真进程 + 真强杀才能验到这条平台事实。
//
// 用法（全部走环境变量，因为要跨进程传）：
//   LEGION_DATA_DIR        状态文件落点（worker 必需）
//   TEAM_HUB_URL / TEAM_HUB_TOKEN  数据面
//   DRILL_MARKER           外部写/阶段调用的记录文件（每行一次调用）
//   DRILL_BLOCK_IN         在哪个阶段卡住：prepareWorkspace | buildContext | execute
//   DRILL_BLOCK_MS         卡住多久（要足够长，让父进程来得及强杀）
//   DRILL_WRITE_AT         'execute' 时先记一次"外部写"再卡住（默认：execute 阶段都记）
//
// 这个文件不是产品代码：产品里的 worker 入口是 `product/orchestrator/worker.mjs`，
// 它不注入任何执行引擎（PRT-253 才接线）。这里是**唯一**给真实进程注入慢速
// executor 的地方，因此演练能覆盖到真实的 worker 主循环、心跳与失败上报路径。
// ============================================================================
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { runWorkerProcess } from '../run.mjs'
import { inPlaceStages } from '../main.mjs'

const blockIn = process.env.DRILL_BLOCK_IN ?? 'execute'
const blockMs = Number(process.env.DRILL_BLOCK_MS ?? '30000')
const marker = process.env.DRILL_MARKER ?? null

/** 记一次调用。用 append 而不是写整个文件：父进程要在被杀之后读到"写到哪一行"。 */
function mark(stage, kind) {
  if (marker === null) return
  try {
    mkdirSync(dirname(marker), { recursive: true })
    appendFileSync(marker, `${JSON.stringify({ stage, kind, pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8')
  } catch { /* 记录失败不改变演练结论：判据会因此报"没有记录"而不是"通过" */ }
}

/** 卡住（真实的长时间等待，不是忙等——父进程要能杀得掉它）。 */
async function block(stage) {
  mark(stage, 'enter')
  if (stage === blockIn) {
    await new Promise((resolve) => setTimeout(resolve, blockMs))
  }
  mark(stage, 'leave')
}

const base = inPlaceStages()
const executor = {
  prepareWorkspace: async () => { await block('prepareWorkspace'); return base.prepareWorkspace() },
  buildContext: async () => { await block('buildContext'); return base.buildContext() },
  // execute 代表「外部写边界之后」：先记一次写、再卡住。
  // 被杀之后这条记录就是"外部写可能已经发生"的**唯一证据**，
  // 而恢复扫描必须据此拒绝自动重试。
  execute: async (lease) => {
    mark('execute', 'external-write')
    if (blockIn === 'execute') await new Promise((resolve) => setTimeout(resolve, blockMs))
    mark('execute', 'leave')
    return { outcome: 'completed', detail: `drill-ok:${lease.attemptId}` }
  },
}

const startup = await runWorkerProcess({ executor })
if (startup.ok !== true) {
  process.stderr.write(`✖ drill worker 无法启动（${startup.code}）：${startup.message}\n`)
  process.exit(startup.exitCode)
}
process.stdout.write(`[drill] 状态文件：${startup.statusPath} blockIn=${blockIn}\n`)
await startup.runPromise
process.exitCode = 0

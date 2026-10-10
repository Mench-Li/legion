#!/usr/bin/env node
/**
 * executor-worker.mjs — 「电脑」侧真正干活的执行器夹具（T-195）。
 *
 * ## 为什么需要它（而不是继续用内联 `node -e`）
 *
 * 侦察确认：仓库里**没有任何** committed 的 `--agent` 脚本，
 * 既有的用例都用内联 `node -e` 代码（`product/node/agent.test.mjs:127`、
 * `executor.test.mjs:20-22`）。内联字符串有两个后果：
 *
 *   ① 它只能被测它的那一个文件用——**跨模块的闭环用例没法复用它**；
 *   ② 它通常只吐一行 result，于是"进展真的会出境"这条路径
 *      （`progress` 帧 → egress → 会话）从来没被端到端跑过。
 *
 *   > 一个只吐 `result` 的执行器夹具，
 *   > 与一个"进展通道根本没接线"的产品，在闭环用例里是同一个东西——
 *   > 只不过前者的用例是绿的，而用户永远看不到"正在做什么"。
 *
 * 所以本文件是一个**真实、可复用**的执行器：按 `product/node/executor.mjs`
 * 的接缝契约（stdin 收一条 JSON；stdout 逐行吐 `progress` / `result`）工作。
 *
 * ## 接缝契约（来自 `executor.mjs:24, 98-131, 169-176`）
 *
 * stdin：`{ task, brief, attempt, workspace }`
 * stdout：每行一个 JSON，`{"type":"progress", kind, summary}` 或
 *         `{"type":"result", outcome, summary, artifacts}`；
 *         `outcome` 必须是 `completed|failed|outcome_unknown|cancelled` 之一。
 * 其余行按本地日志处理（**不出境**）。
 *
 * ## 它做三件可验证的事
 *
 * 1. **在 cwd（工作区）里真的写一个文件** —— 证明"任务真的在这台机器上执行过"，
 *    而不是只有协议往返。判据落在磁盘上，不在回执里。
 * 2. 吐**两行 progress** —— 证明进展真的走完了 执行器 → egress → Hub → 会话 这条链。
 * 3. 吐一行 result（`completed`），`summary` 里带上任务标题的标记
 *    —— 让调用方能从 Hub 侧断言"回来的是**这一条**任务的结果"。
 *
 * 用法（由 Node 以 `--agent <node> --agent-arg <本文件>` 调起）：
 *   node executor-worker.mjs
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHUNK = 64 * 1024

/** 读完 stdin 的全部内容。 */
function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    // 上游不关 stdin 时也要能结束——超时是 30 分钟，等不起。
    setTimeout(() => resolve(buf), 5000).unref?.()
  })
}

/** 逐行 JSON 出境。`console.log` 会带上换行，正是协议要的形状。 */
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)

const raw = await readStdin()

let input = null
try { input = JSON.parse(raw) } catch { /* 坏输入下面按 failed 上报，不静默 */ }

if (input === null || typeof input !== 'object') {
  emit({ type: 'result', outcome: 'failed', summary: `执行器收到的输入不是 JSON 对象（${raw.slice(0, 80)}）`, artifacts: [] })
  process.exit(0)
}

const task = input.task ?? {}
const brief = input.brief ?? null
const attempt = input.attempt ?? null
const workspace = input.workspace ?? null
const title = String(task.title ?? task.id ?? 'untitled')

// ① 第一行进展：说明"活开始了"。kind 用协议里通用的 'step'。
emit({ type: 'progress', kind: 'step', summary: `开始执行：${title.slice(0, 120)}` })

// ② 在**工作区**里落一个真实文件。cwd 由 executor.mjs:75 设为 workspace.path，
//    所以写 './' 就落在"这台电脑的工作区"里——这正是闭环要证明的那件事。
const workDir = process.cwd()
const stamp = {
  at: new Date().toISOString(),
  title,
  taskId: task.id ?? null,
  attemptId: attempt?.id ?? attempt?.attemptId ?? null,
  briefSeen: brief !== null,
  // brief 是"做这件事需要知道的全部"；把它的键名列出来，
  // 就能证明它**真的从 Hub 走到了电脑**（而不是只有 task.title）。
  briefKeys: brief !== null && typeof brief === 'object' ? Object.keys(brief).sort() : [],
  workspaceScope: workspace?.scope ?? null,
  pid: process.pid,
}
let proofFile = null
try {
  proofFile = join(workDir, 'executor-proof.json')
  writeFileSync(proofFile, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
} catch (e) {
  emit({ type: 'result', outcome: 'failed', summary: `无法在工作区写入证明文件：${e.message}`, artifacts: [] })
  process.exit(0)
}

// ③ 第二行进展：说明"活干完了"。两行 progress 是刻意的——
//    只吐一行的夹具无法区分"进展通道通了"与"只在结尾顺带报了一次"。
emit({ type: 'progress', kind: 'step', summary: `已在工作区落盘 ${'executor-proof.json'}` })

// ④ 结果帧。outcome 取闭集里的 completed（executor.mjs:42）。
emit({
  type: 'result',
  outcome: 'completed',
  summary: `完成 ${title.slice(0, 100)}（工作区已写入 executor-proof.json）`,
  artifacts: [{ kind: 'file', path: 'executor-proof.json', bytes: Buffer.byteLength(JSON.stringify(stamp)) }],
})

// 退出码 0 且已上报结果帧：executor.mjs:190-195 以**结果帧为准**。
process.exit(0)

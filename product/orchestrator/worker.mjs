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
import { hubIo, productionExecutorProviderFromEnv } from '../../orchestrator/worker/executor-binding.mjs'
import { createModelProfileRefResolver } from '../../orchestrator/worker/run-inputs.mjs'
import { resolveRuntimePidFromEnv, withRunPeakResource } from '../../orchestrator/worker/run-peak-resource.mjs'
import { claimGateFromExecutor } from './claim-gate.mjs'

// ── PRT-253 续批：`modelProfileRef` 的生产来源 ──────────────────────────────
//
// `RunRequest` 的三个必填字段里，`workspaceId` 与 `workdir` 由 worker 外壳
// 自己就能算（租约的 scope / 工作区阶段的产物），而**模型档案**必须问 team-hub：
// 它是 `(scope, role)` 上的员工模型绑定（PRT-502），租约上没有、环境变量里也不该有。
//
//   > 一个"从环境变量读一个模型名"的接线，
//   > 与一个"用某个没人给这个岗位选过的模型花用户的钱"的接线，
//   > 在配置一直正确的时候是同一个东西。
//
// 所以这里按 hub 的真实契约去读：先从任务取岗位（`task.role`——岗位**不在**租约上），
// 再解析该岗位的模型绑定。读不到就返回具名拒绝，由执行引擎在装配请求时停下。
//
// ⚠️ 没有 `TEAM_HUB_URL` 时**不建**这个端口：`hubIo` 会抛，而抛在建实例之前
//    会让 worker 连状态文件都写不出来（那样运维只能看到"进程退出了"）。
//    返回 `null` 时模型那一项只能来自租约，该失败会在执行引擎那里具名报出来。
const workerHubUrl = process.env.TEAM_HUB_URL ?? null
let modelProfileRefFor = null
if (typeof workerHubUrl === 'string' && workerHubUrl.trim() !== '') {
  try {
    const workerIo = hubIo({ hubUrl: workerHubUrl, hubToken: process.env.TEAM_HUB_TOKEN ?? '' })
    modelProfileRefFor = createModelProfileRefResolver({ get: workerIo.get })
  } catch (e) {
    process.stderr.write(`⚠ [worker] 模型绑定解析端口未建立：${e?.message ?? e}——`
      + '本次运行不会用任何默认模型顶替\n')
  }
}

// PRT-253：把生产执行引擎的**提供者**交给 worker。
//
// 为什么是提供者而不是直接造一个 executor：构造要先做启动自检（异步、可能拒绝），
// 而拒绝的理由必须能进启动结果——"自检没过"、"缺宿主端口"、"忘了配 hub"
// 三种处境的修复动作完全不同，而它们以前在 Launcher 看来都是同一句 `no-executor`。
//
// 今天它大概会返回 `EXECUTOR_HOST_PORT_REQUIRED`：DSH 宿主端口的绑定
// 由 `runtime/dsh-composition/` 在 DSH 进程内完成（PRT-214/215），
// 而 worker 是独立进程。装上之后，**这个入口不需要改一行代码**就开始真的执行。
// PRT-009 `peak-resource` 的**每 Run 窗口**接在生产入口上。
//
// 为什么接在这里而不是深处：`withRunPeakResource` 要的是一个"每次 Run 都经过"
// 的窄腰，而**本入口是全产品唯一一处 executor 的诞生点**——往里放，两处构造
// 路径（同进程绑定 / 跨进程契约）**都**自动被包上；放进任一条路径里，
// 另一条就会静默地没有读数，而两条路径在 diff 上只差一行。
//
// ★ 采的是**另一个进程**。worker 与 DSH Runtime 不是同一个（`host` 端口只在
//   后者里），而 worker 拿不到 pid，只有 `LEGION_RUNTIME_URL`。所以这里先拿
//   `resolveRuntimePidForSampling` 用 host/port **认领那份发布**，
//   对不上就一个数都不采——照一份属于上一次运行的发布去采 pid，
//   不会报错也不会采到 0，它会**采到别人的数**。
//
// ★ 采样失败**永远不许**让一次 Run 失败（`withRunPeakResource` 内部吞掉全部
//   采样异常）；这里只负责把读数送到一个**有人读**的地方——stderr，
//   与上面的下限告诫同一条流，于是启动告警与运行期读数在收集端不分家。
//
// `withRunPeakResource` 在没有出口时**原样返回** executor，所以下面那个
// 「出口是空的」分支不是防御性代码：它保证"没接出口"与"接了出口但不读"
// 不会变成同一种东西。
function attachRunPeakResource(provided) {
  if (provided === null || typeof provided !== 'object' || provided.ok !== true || provided.executor == null) {
    // 引擎没接上 ⇒ 没有可包的 executor，也**没有**可以归因的资源读数。
    // 原样返回，让调用方那条既有的具名拒绝继续说话（不要去合成一个新的）。
    return provided
  }
  const executor = withRunPeakResource(provided.executor, {
    onReading: (reading, ctx) => {
      if (reading === null || reading === undefined) {
        // ★ 「没采到」与「采到 0」必须不同形（与 `describePeakResource` 同一条纪律）。
        process.stderr.write(`[worker] peak-resource pid=${ctx?.pid ?? '?'}：这次 Run 从未采到读数\n`)
        return
      }
      process.stderr.write(
        `[worker] peak-resource pid=${reading.pid ?? '?'} samples=${reading.samples ?? 0}`
        + ` peakWorkingSet=${reading.peakWorkingSetBytes ?? '不可得'}`
        + ` peakRss=${reading.peakRssBytes ?? '不可得'}`
        + ` cpuMs=${reading.cpuMs ?? '不可得'}`
        + `${reading.lastCode === null || reading.lastCode === undefined ? '' : ` lastCode=${reading.lastCode}`}`
        + `（窗口 ${reading.startedAtMs ?? '?'}→${reading.endedAtMs ?? '?'}ms，端点 ${ctx?.host}:${ctx?.port}）\n`,
      )
    },
    // ★ 每次 Run 重新解析：Runtime 可能在这两次之间重启过，pid 就变了。
    //   缓存一次会让我们继续采**上一个** pid——而那正是本模块要防的那件事。
    //
    // ★ 这里**不读 `process.env`**：那两个键（`LEGION_DATA_DIR` /
    //   `LEGION_RUNTIME_URL`）属于 orchestrator 进程的配置面，
    //   在 product 进程里读它们会被 `topology-inventory --diff` 正确地报成
    //   `product.envReadKeys += LEGION_RUNTIME_URL`。由模块自己读自己的键。
    resolvePid: () => resolveRuntimePidFromEnv(),
    logger: (message) => process.stderr.write(`${message}\n`),
  })
  return { ...provided, executor }
}

const startup = await runWorkerProcess({
  executorProvider: () => productionExecutorProviderFromEnv({
    // ★ PRT-214 续：静态下限派生成功时那些"必须被记录"的告诫的**生产出口**。
    //
    //   没有这一行，`run-floor-collateral-denial`（"为了拦一个推送，整个 shell
    //   会被一起禁掉"）与政策禁令落不了地那两条告诫就只是派生物里的两个字段：
    //   产生了、单测锁了、而**这台机器上没有任何人读得到**。
    //
    //     > 一条"记录在案"的连带禁止，与一条没人看得见的连带禁止，
    //     > 在运维读到的那份输出里是同一个东西。
    //
    //   写到 stderr 而不是 stdout：它是**告诫**（这次下限额外付出了什么代价），
    //   不是状态输出。与下面启动阶段的 `⚠` 走同一条流，于是"启动告警"与
    //   "运行期告诫"在收集端落在同一个地方，不需要两套采集规则。
    //
    //   ⚠️ 出口本身的异常由 `executor.mjs` 吞掉（诊断不许让 Run 失败），
    //   但**不静默**：那次失败会以 `floorNoticeSinkFailed` 出现在结果里。
    onFloorNotice: (notice) => {
      process.stderr.write(
        `[worker] 下限告诫 ${notice?.code ?? '(无码)'}：关于「${notice?.tool ?? '(未点名)'}」——`
        + `${notice?.message ?? ''}`
        + (notice?.dshTools?.length ? `（执行面上禁掉 ${JSON.stringify([...notice.dshTools])}）` : '')
        + (notice?.collateral?.length ? `（连带也会禁掉 ${JSON.stringify([...notice.collateral])}）` : '')
        + '\n',
      )
    },
  }).then(attachRunPeakResource),
  // PRT-711：认领闸门。**这是 `mayClaimTasks()` 的生产调用点**——
  // 没有它，"正在升级"与"Runtime 不可用"都不会阻止 worker 领走任务。
  claimGateFromExecutor,
  // PRT-253 续批：模型档案的生产来源（见文件头）。
  modelProfileRefFor,
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

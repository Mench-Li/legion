# BUG-043：工作流阶段超时被记成 `outcome-unknown`，且「生效超时配置」不可见

## 现象

2026-10-30 复核 T-220…T-224 的引擎耗时与超时配置时发现三件事叠在一起：

1. **T-224（coder / spawn）跑了 56.9 分钟**：18:38:03 认领，19:34:58 才完成。当时 desktop
   profile 的 `workerTimeoutMs` 是 45 分钟（`2700000`），它**没有**被强制结算，日志里也没有
   任何超时行。
2. **库里查不到「超时」这个事实**：`agent_workflow_stage_attempts` 的 12 条 `unknown` 全部是
   `stop_reason='outcome-unknown'`。超时、启动失败、provider 拒绝、取消竞态被压成同一个值，
   所以「看门狗到底响没响」只能靠猜（机器休眠？生效值其实是 60？路径没走到？）。
3. **「生效配置」不可见**：配置只在宿主启动时装载，但没有一行日志说明本进程实际用的是多少。
   文件里的 45/60 与**没在运行**的 web profile 的 25/40 混在一起，读错一次就能得出相反的
   结论（例如「staleMinutes=40 会让活着的 worker 被回收 ⇒ 双写者」——而 workflow 任务根本
   不参与 age-based 回收）。

同一批数据里，claude-code 4 / codex 6 / spawn 2 共 **12** 条 unknown，却被归纳成「8 次」；
数量口径本身也因为不可归因被读错了。

## 根因

两处叠加，缺一不可：

- `runtime/adapters/dsh/workflow-run.mjs` 到点只 `controller.abort()` 并返回 `timedOut`，
  **不打日志**；
- `plugins/src/index.ts` 的 `quarantineUnknownWorkflowResult` 无论 timeout / start-error /
  canceled-race / provider-rejected / persist-error，一律写 `stopReason: 'outcome-unknown'`。

> 一个「超时了但没人知道」的看门狗，
> 与一个「根本没装」的看门狗，在事故复盘里是同一个东西——只不过前者的代码里写着 `timedOut`。

## 修复

1. **纯函数归因**：`workflowUnknownStopReason({ timedOut, taskCanceled, failureType })`，
   优先级 `canceled-race > timeout > provider-rejected > outcome-unknown`，可单测。
2. **`stopReason` 参数化**：`quarantineUnknownWorkflowResult(reason, preserveCanceledTask,
   stopReason = 'outcome-unknown')`；5 个调用点分别写：
   `start-error`、`timeout`（或映射结果）、`canceled-race`、`provider-incomplete`、
   `persist-error`。
3. **超时留痕**：超时分支打一行
   `T-xxx workflow 阶段超时（>N 分钟），provider 未返回可确认的终态，已隔离为 timeout`。
4. **启动打印生效值**：每进程一行
   `生效超时配置（BUG-043）：workerTimeoutMs=…（N 分钟），staleMinutes=…`；
   若发生 BUG-009-b 校正，同一行标注「已按 BUG-009-b 校正」。
5. **修正过期注释**：profile 的 `cordis.patch.yml` 里那句「这条关系只是注释、没有强制」
   已不成立——`configSanity.resolveStaleMinutes` 在启动时强制校正并打印。

## 验证

- `node --test plugins/tests/workflow-timeout-attribution.test.mjs`：**7/7**。
- 连带回归：`runtime/adapters/dsh/workflow-run.test.mjs`（8）、
  `plugins/tests/timeout-settlement.test.mjs`（10）、`plugins/tests/config-sanity.test.mjs`（6），
  合计 **29/29**。
- `node scripts/ci/build-external-package.mjs plugins`：tsc 通过。
- 重启后的现场判据：
  - 日志出现 `生效超时配置（BUG-043）`，其数字应与渲染后的 `cordis.yml` 一致；
  - 下一次长阶段若被看门狗结算，Attempt 的 `stop_reason` 必须是 `timeout`，
    而不是 `outcome-unknown`。

## 边界（写清楚，免得被当成「修好了」）

- 本修复**不改变**超时策略，也不改变 `releaseStaleTasks` 对 workflow 任务的跳过；
  看门狗仍是长阶段的唯一兜底。
- 它只保证两件事：超时发生时会留下 `timeout` 这个事实；「本进程用的是多少」能被日志读到。
- **T-224 那一次 56.9 分钟究竟是「生效值其实是 60」「定时器被机器休眠推迟」还是
  「路径没走到」，本修复不能回溯判定。** 下一次复现时，日志 + `stop_reason` 才能给出答案。

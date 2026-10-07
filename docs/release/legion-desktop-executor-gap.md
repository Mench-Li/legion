# 任务：orchestrator 报 `no-executor` —— **拒绝码已量出**，缺的是两处接线

> 状态：**根因已实测**（见下面"实测读数"）。本文件记录读数与要补的东西。
> 立此存照的原因：这条缺口在验收记录里出现过，而它的根因此前**没有被量过**。

## 症状

`docs/release/legion-desktop-acceptance.md`（2026-10-03）记着：

> Orchestrator 进入 `no-executor` 安全状态，**未认领任务**……按设计 fail-closed

对用户的表现是：**任务一直没人做**。手机上派了活，电脑上什么都没发生。

## 实测读数（2026-10-07）

直接跑 `product/orchestrator/worker.mjs`，用环境变量逐级打开 —— **不需要改任何档案**：

| 环境 | worker 报的码 |
| --- | --- |
| 什么都不设 | `EXECUTOR_BAD_WIRING`（未设置 `TEAM_HUB_URL`） |
| 给 `TEAM_HUB_URL`（死地址） | `EXECUTOR_HOST_PORT_REQUIRED`（跨进程那条路也还没配） |
| 再给 `LEGION_RUNTIME_URL`（死地址） | **`EXECUTOR_CAN_READ_REQUIRED`** ← 跨进程那条路**真的走到了** |

复现：

```bash
# ③ 那一条
TEAM_HUB_URL=http://127.0.0.1:9 TEAM_HUB_TOKEN=x \
LEGION_RUNTIME_URL=http://127.0.0.1:9 LEGION_RUNTIME_TOKEN=t \
LEGION_DATA_DIR=<临时目录> node product/orchestrator/worker.mjs
# ⚠ [worker] 执行引擎未接线（EXECUTOR_CAN_READ_REQUIRED）：跨进程路径需要调用方显式给出 canRead…
```

## 结论：两条取得引擎的路，各自卡在不同的一环

| 路 | 怎么走 | 卡在哪 |
| --- | --- | --- |
| **同进程** | DSH 进程内调 `bindDshRuntime({host, selfCheck, canRead})` | **没有任何生产代码调它**（只有 `executor-binding-sources.test.mjs`） |
| **跨进程** | Launcher 注入 `LEGION_RUNTIME_URL`（`launcher.mjs:943`，**真的在注入**） | 走到了，但 **`canRead` 没人给** |

而 **`orchestrator/worker.mjs` 这两样都不传** —— 它是生产入口，`grep canRead` 在这个文件里
**一行都没有**。跨进程路要 `canRead` 是**worker 侧**的责任（见下面为什么），
权威也在它手里（lease / 岗位清单），可它没给。

    > 一个"调用方必须给、而生产入口从不给"的参数，
    > 与一个不存在的参数，在部署上是同一个东西 ——
    > 只不过前者的报错文案会把排查的人引向"去配那个变量"，而变量早就配好了。

## 为什么 `canRead` 不是"补个默认值"就完事

这一点必须写清楚，否则下一个人会顺手补一个 `() => ({all:true})` 就交差。

代码里三处独立地拒绝对它给默认值：

- `executor.mjs`：`canRead` 缺失 → `BAD_WIRING`，理由是"一个**默认都能读**的默认值会让一次接线遗漏变成一次**静默越权**"
- `context-stage.mjs:300`：`canRead` 不给就抛，理由是"路由不替调用方决定权限，这里也不猜"
- `executor-binding.mjs`：`bindDshRuntime` 明确区分"canRead 是函数"与"这个进程里没有来源"

所以**补这一环需要先定一条策略**：这次 Attempt 的角色能读哪些来源。
权威是 `lease` + 岗位清单（`/api/roster?scope=`），而 `context-stage.mjs` 已经把它
规范成 `canRead(meta, {lease, scope, inputs}) → true | {all:true} | string[] | {ids:[]}`。
**本仓今天没有任何一处把这个映射实现出来**（`git grep canRead` 的生产方只有消费者，没有生产者）。

## 交付判据

1. **一条策略**：写清"哪个角色的 Attempt 能读哪些来源"，并说明它从哪里取得权威
   （不得回落到"默认都能读"）。
2. 把 `canRead` 接到 `orchestrator/worker.mjs` 的 `productionExecutorProviderFromEnv` 调用上。
3. **一个实测读数**：接上之后同一条命令不再报 `EXECUTOR_CAN_READ_REQUIRED`；
   若 Runtime 仍不可达，应当报 `EXECUTOR_RUNTIME_UNREACHABLE`（**与上一条修法不同**：
   那一条去查那台进程为什么没起来）。
4. 端到端：派一条任务 → 见到 Attempt 真的起来（而不是 `no-executor`）。

## 一个已经量到的性质：它是**二元**的

`publish('no-executor')` 那条日志写着设计意图：

> 认领会立刻失败并把重试额度烧光，最终表现为「任务都在跑但全都失败」

所以这条缺口的用户表现是二元的：要么任务真被执行，要么**一条都不会被认领**。
没有中间态 —— 这意味着它很适合被一条端到端用例钉住。

## 另一个同症状的嫌疑（未量）

缺 `LEGION_WORKSPACE_DIR` 时 worker 的状态是 **`no-stages`**（`main.mjs:475`），
同样一个任务都不认领、同样没有任何错误。**与 `no-executor` 在用户那里一模一样**，
而修法完全不同。排障时**两处都要读**：状态文件的 `state`，以及 `publish()` 在状态变迁
那一刻打的那行日志（只读状态文件会看到四个字母，理由在日志里）。

## 诚实边界

- 上面三个码是**实测**的；但第 ③ 条用的是**死地址**，所以只证明了"跨进程路走到了
  `canRead` 这一关"，**没有**证明"给了 canRead 之后能连上 Runtime"。
- `bindDshRuntime` 在生产上没人调，是 `git grep` 读出来的（那条路是给 DSH 进程内用的）。
- 本文件**不声称**打包版一定报这个码：打包版由 Launcher 启动，环境与上面手工跑的不同。
  要断言它，得跑一次 `scripts/legion-start.mjs` 并读它自己的输出。

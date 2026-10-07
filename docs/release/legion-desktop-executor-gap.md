# 任务：Legion 启动后 orchestrator 报 `no-executor` —— 先量出**是哪个拒绝码**

> 状态：**待实测**。本文件是一份任务描述，不是结论。
> 立此存照的原因：这条缺口在验收记录里出现过，而**它的根因没有被量过**。

## 症状

`docs/release/legion-desktop-acceptance.md`（2026-10-03）记着：

> Orchestrator 进入 `no-executor` 安全状态，**未认领任务**……按设计 fail-closed

对用户的表现是：**任务一直没人做**。状态文件里只有一个词（`no-executor` 或 `no-stages`），
没有任何错误。手机上派了活，电脑上什么都没发生。

## 已经查清的：**接线是存在的**，所以"没接"不是结论

这条线常被当成"还没实现"。实测不是：

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 同进程注册口 | `orchestrator/worker/executor-binding.mjs` 的 `bindDshRuntime()` | 存在；**只有测试在调** |
| 跨进程契约（客户端） | `orchestrator/worker/runtime-contract-client.mjs` | 存在 |
| 跨进程契约（服务端） | `runtime/dsh-composition/runtime-contract-server.mjs` | 存在 |
| **环境变量的生产方** | `product/launcher/launcher.mjs:943` `out.LEGION_RUNTIME_URL = runtimeContractEndpoint.url` | **存在，真的在注入** |
| 进程清单声明 | `product/process-manifest.mjs` 的 `orchestrator` 项 | 声明了 `LEGION_RUNTIME_URL` / `LEGION_RUNTIME_TOKEN` / `LEGION_WORKSPACE_DIR` |

`desktop-launcher.mjs` 用的就是这个 `createLauncher`，所以**打包版与单入口走同一条接线**。

    > 「这段代码存在」与「这条链路在真实部署里通了」，
    > 只有在一次真实启动之后才不是同一句话 ——
    > 而验收记录里那句 `no-executor` 是**上一次**启动的读数，没人知道这一版报的是什么。

## 本任务的**第一步**：量出拒绝码，不要先改代码

`orchestrator/worker/executor.mjs` 的 `EXECUTOR_CODES` 是一张**可裁决**的表 ——
每个码对应**不同的修法**，混起来会让值班的人去查错的地方：

| 码 | 含义 | 该去哪里看 |
| --- | --- | --- |
| `EXECUTOR_HOST_PORT_REQUIRED` | 既没有同进程绑定，也没有 `LEGION_RUNTIME_URL` | 启动方有没有注入；端口发布文件在不在 |
| `EXECUTOR_RUNTIME_UNREACHABLE` | **配了**端点但连不上 | 那台 Runtime 进程为什么没起来（与上一条修法完全不同） |
| `EXECUTOR_SELF_CHECK_INCOMPATIBLE` | 自检未过：补丁层 / 运行时探测 / 沙箱管制有其一没生效 | `runtime/dsh-composition/` 的强制面 |
| `EXECUTOR_CAN_READ_REQUIRED` | 有绑定但没给 `canRead` | 装配阶段的权限来源 |
| `EXECUTOR_BAD_WIRING` | 参数缺失或形状不对 | `post` / `get` 适配器 |

**另有一个不在 executor 侧的嫌疑**：`process-manifest.mjs` 那段注释写着，缺
`LEGION_WORKSPACE_DIR` 时 worker 的状态是 **`no-stages`**（不是 `no-executor`），
同样**一个任务都不认领，且没有任何错误**。两个症状在用户那里一模一样。

## 复现步骤

```bash
# 1. 起 Legion（单入口会接线 + 起宿主 + 盯就绪）
node scripts/legion-start.mjs

# 2. 读两处，**缺一不可**：
#    ① orchestrator 的状态文件（`state` 字段 + 它带出来的 extra，如 missingStages / claimGate）
#    ② worker 的**日志**：状态变迁那一刻会打一行"为什么不干活"的解释
```

★ 只读状态文件会看到 `no-executor` 四个字母，而**理由在日志行里** ——
`publish()` 在状态变迁的那一刻打一条具名说明（见 `orchestrator/worker/main.mjs` 的那几个分支）。
只看状态文件，`no-executor` 与 `no-stages` 在排障的人眼里是同一句话："不认领"。

预期两种之一：

- `state: 'claiming'|'idle'|'executing'` —— 引擎真的造出来了，验收记录那句已过时，**如实记下并关闭本任务**；
- 上面表里某一个具名码 / 具名状态 —— **那才是本任务要修的东西**。

## 交付判据

1. **一个实测读数**：一次真实启动后 orchestrator 的 `state` 与日志里那条理由。
2. 若为具名码 / 具名状态：**该码对应的那一环**的修复 —— 不是"让它别报这个"。
3. 回归：这条路径上**不能再出现"没配却看起来正常"**的形状。本仓在这上面已经栽过三次
   （`LEGION_DATA_DIR` 声明了没人给值 / `LEGION_WORKSPACE_DIR` 连声明都没有 /
   `LEGION_RUNTIME_URL` 消费方会读而生产方不写），三处的注释都还在。

## 一个已经量到的旁证：**它一定是"要么全通、要么全不干"**

`publish('no-executor')` 那条日志本身写着设计意图：

> 未配置执行引擎：**不认领任何任务**（认领会立刻失败并把重试额度烧光，
> 最终表现为「任务都在跑但全都失败」）。配置执行引擎后重启即可开始工作。

所以这条缺口的**用户表现**是二元的：要么任务真的被执行，要么**一条都不会被认领**。
不存在"部分能跑"的中间态 —— 这也意味着**它很适合被一条端到端用例钉住**
（派一条任务 → 要么见到 Attempt 起来，要么见到那个具名码）。

## 诚实边界（本文件写的时候）

- **没有跑过**真实启动。上面那张"接线存在"的表是**读代码**读出来的。
- 因此本文件**不能**用来声称"打包版不认领任务"。那句话需要一次实跑才能说。
- 验收记录（2026-10-03）是这条缺口唯一的现场记录，而它没有留下拒绝码。

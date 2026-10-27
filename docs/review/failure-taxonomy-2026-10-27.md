# 失败分类盘点：设计 §11 的九类，在代码里到底归谁管

日期：2026-10-27
状态：只读盘点（**不改行为**）
依据：[Agent 编排设计 v1.1](../design/legion-agent-orchestration-design.md) §11、[实施计划](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md) T3.2
落盘：`docs/review/failure-taxonomy-2026-10-27.md`

## 0. 一句话结论

设计 §11 的九类失败**每一类都有归属**，但**没有一个统一的出口**：分类判据分散在四层
（运行状态机、team-hub 任务/Attempt、写入预约、集成 worker），且**有两套 Attempt 词表并存**。

所以今天能说"每一类都有人管"，不能说"每一类都能用同一个码去问"。这份文档只提供事实与三个候选方案，**决定留给人**。

---

## 1. 逐类归属

| # | 设计 §11 的分类 | 具名码 / 状态 | 判据所在 | 可观测点 |
|---|---|---|---|---|
| 1 | 依赖未完成 | **无错误码** | `blockedBy` 门挡在 `todo`（`team-hub/server.mjs` 的 `claimTask` 前置检查） | 任务仍是 `todo` + `blockedBy` 非空；**不消耗重试** |
| 2 | 节点未就绪 / provider 不匹配 | `AGENT_NODE_NOT_READY`、`AGENT_NODE_PROVIDER_INCOMPATIBLE` | `team-hub/server.mjs` 发布校验与认领校验 | 发布 409 / 认领 409，带节点 id 与缺失的能力位 |
| 3 | 认证缺失或失效 | `AUTH_FAILED` | `runtime/contracts/model-probe.mjs` | 探针结果；**不索取密钥** |
| 4 | 权限配置与工具能力不兼容 | `permission-denied` | `orchestrator/state-machine/failure.mjs` + 派工前能力比对（`plugins/src/index.ts`） | 派工被拒，日志里有 expected/actual 权限模式 |
| 5 | Agent 有明确失败结果 | 阶段 Attempt `state='failed'` | `team-hub/server.mjs` 的 attempt 状态机 | `agent_workflow_stage_attempts.state`、`stop_reason` |
| 6 | 验收失败 | **不是失败类**：走 typed review 返工 | `submitAgentWorkflowReview` | 返工任务 + `agent_workflow_reviews` 台账 |
| 7 | 取消请求尚未确认 | 写入预约态 `reconciling` + `confirm-stopped` | `team-hub/write-intent-store.mjs`、`routes/write-intent.mjs` | 预约行；**确认停止的审计已于 2026-10-27 补上**（`write-intent:confirm-stopped`） |
| 8 | Worker/节点执行中断开 | 阶段 Attempt `unknown` + `stop_reason='worker-restarted'` | `team-hub/server.mjs` 启动隔离 | Attempt 行；`unknown` **不可**回 `running` |
| 9 | 文件冲突或集成失败 | `GIT_CONFLICT`、`JOB_CONTENTION`、`VALIDATION_FAILED` | `team-hub/integration-worker.mjs`、`delivery-store.mjs` | `delivery_integration_events`；验证在**候选提交**上 |

**三处需要说明的"看起来反直觉"：**

- **第 1 类没有错误码，这是对的。** 依赖未完成不是一次失败，是一个**还没到它**的状态。
  给它一个错误码会让它进重试计数器，而"等上游"不该消耗额度。
- **第 6 类被归类为"不是失败"。** 验收不通过会创建**新的返工任务**，原审查任务按流程收尾。
  把它做成失败类会把"流程正常工作"显示成"出错了"。
- **第 7 类跨了两个子系统。** `reconciling` 在写入预约里，`confirm-stopped` 在路由里，
  而任务的 `scheduling_state` 是第三处。这三处必须同时改才叫"确认停止生效"。

---

## 2. 两套 Attempt 词表

| 词表 | 取值 | 位置 | 谁写 |
|---|---|---|---|
| **阶段 Attempt** | `starting` / `running` / `completed` / `failed` / `unknown` / `canceled` | `agent_workflow_stage_attempts.state` | team-hub 路由 + worker 回报 |
| **运行状态机** | 13 态：`Queued` … `HandingOff` / `RetryableFailure` / `UnknownOutcome` / `Cancelled` / `DeadLetter` | `orchestrator/state-machine/states.mjs` | run plane（`run_attempts.state`） |

**两者并存是对的**（一个是"阶段的一次尝试"，一个是"运行生命周期"），但**缺一条映射规则**。
今天的实际情况是：同一件事（比如 worker 中途死掉）在阶段表里落 `unknown`，
在运行表里落 `UnknownOutcome`，而**没有任何一层把这两行关联起来**——
`agent_workflow_stage_attempts` 有 `provider_run_id`，但没有 `run_attempt_id`。

这就是设计原则 4 说"只有一个权威来源"时最容易被读错的地方：**真实情况是"两张表各自权威，
但缺一条唯一映射"**。设计文档 v1.1 已按此改写。

---

## 3. 三个候选方案

### 方案 A：统一码表

新建一张 `failure_codes` 表，四层各自映射到同一套码上，UI 只认一套。

- **代价**：要改四处判据 + 全部历史数据；且第 1、6 类本来就**不是**失败，硬塞会污染语义。
- **收益**：用户只看到一个词。
- **风险**：把"等上游"与"验收返工"也做成失败码，会让指标里的失败率失去意义。

### 方案 B：保持分层，加一条映射层（推荐）

保留四层各自的判据与码，新增**只读**的归一化函数（例如 `failureKindOf(attempt)`），
把"(阶段 Attempt 状态 + stop_reason + 预约状态 + 集成事件)"映射成**一个面向用户的类别**。

- **代价**：一个新模块 + 一组单测；不动任何既有写入路径。
- **收益**：指标与 UI 拿到统一的分类，而数据面保持各自权威——这符合本仓"不建第二份真相"的纪律。
- **风险**：映射函数本身可能变成"第二份判据"，所以它必须**只读、可测、不写库**。

### 方案 C：不收敛

承认四层各有语境，UI 直接显示原始状态 + 一句人话解释。

- **代价**：用户要学四种词表。
- **收益**：零改动。
- **风险**：这正是今天的状态，而"同一次失败在不同页面看起来不一样"已经是实际投诉来源。

---

## 4. 建议

**先做方案 B 的只读部分**（一个纯函数 + 单测），**不碰写路径**。理由：

1. 它不改变任何既有语义，回退成本为零；
2. 它立刻能让指标与 UI 用同一套词；
3. 如果将来决定走方案 A，这个函数就是映射表本身，不会白做。

**先不做的事**：不要为了"统一"而给第 1、6 类造失败码。那两类的价值恰恰在于
**不是失败**——而把它们做成失败码，会让"目标卡在等上游"看起来像"系统出错了"。

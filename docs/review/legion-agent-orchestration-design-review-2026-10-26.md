# 设计核对：《Legion 多 Agent 协同与执行可观察性设计》

> 核对对象：`docs/design/legion-agent-orchestration-design.md`（v1.0，2026-10-14）
> 核对时点：2026-10-26，基线 `6d688731`（其后紧邻 `26f48561` 移除返工上限）
> 核对方式：只读源码 + 逐条指认 `path:line` 证据；不修改被审文档、不改业务代码
> 落盘：`docs/review/legion-agent-orchestration-design-review-2026-10-26.md`

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 整体 | 设计**方向正确、原则扎实**，但**状态标签是 2026-10-14 的**，其中约 1/4 的主张与今天的代码不符 |
| 不属实（会误导实现） | **3 处**：§4.1/§4.3 发布入口的计划预览与每阶段执行者展示、§2.3+§6 Mesh 已在用、§9.5「遵守返工上限」 |
| 陈述与现状相反或已过时 | **3 处**：§8.1 DAG 编辑（与 2026-10-21 的"阶段集合由流水线决定"冲突）、§9.6 集成复验时点（在合并前）、§10 Timeline 覆盖（gate/集成/确认停止均未入流） |
| 部分属实需细化 | **4 处**：Gate 的"独立"实质（测试回执而非语义门）、失败分类归属分散、needs input 无独立状态、事件补读的投递账本边界 |
| 属实且值得保留 | **9 处**（见 §2）：冻结三快照、Attempt/providerRunId、unknown 语义、单一 SSE + 持久 seq、节点发布校验、失败分类器、needs input 形态、DAG 静态校验、三时点数据面对应 |
| 最大遗漏 | **3 条**：`run_events` 通道已落库但从不开放给 UI/SSE；两套 Attempt 状态词表已并存却无映射规则；一条目标只能一个执行节点的硬约束未写 |
| 是否可据此开工 | **不能直接开工**。§14 阶段一的 4 条里，2 条要从零建（计划图预览、编排模式选择）、2 条只完成了一半（执行者展示只在配置页、冻结选择只在任务详情里）；§15 的验收场景 1–3、11 当前**不可达** |

设计文档自己写了「本文件本身不等于代码实现授权」（`:361`）——这一句是对的，而且比作者当时预想的更重要：文档描述的东西里，有一部分是**还没建的**，另一部分是**已经建了但和文档说的不一样**。评审者需要能分清这两类，否则会把"缺口"读成"回归"。

---

## 1. 与代码不符（按严重度）

### 1.1 发布入口根本没有"计划预览"，也不存在编排模式选择 ★最严重

文档承诺（`:57`、`:59-64`、`:89-99`）：发布前先由 General 生成计划预览，显示阶段、依赖、每阶段 Agent 工具、配置版本、模型、执行节点、provider 就绪读数、输入输出与验收摘要，并提供"采用推荐 / 选择已有流程 / 编辑计划 / 创建后暂不运行"四种操作。

实际（`workbench/src/components/GoalModal.tsx:94-190`，全文 191 行）：

| 弹窗里有的 | 位置 |
| --- | --- |
| 目标文案 textarea | `:102-111` |
| 「**Agent 分配模板（不改变阶段）**」下拉，只列每个定义的最新版 | `:112-132` |
| 执行节点（自动判定 + 折叠的手动覆盖） | `:133-171` |
| 多目标并存提示 | `:172-180` |

弹窗里没有的：阶段列表、依赖边、每阶段 provider/adapter/模型、就绪度、并行度、冻结版本选择器、四种操作的任何一种。

更关键的是**编排模式在 UI 上不可达**：

- `workbench/src/api.ts:327-334` 的 `publishGoal()` body 里**没有** `orchestration` 字段；
- `workbench/src/App.tsx:539` 调它时 `mode` 恒为 `undefined`；
- 全仓 workbench 里 `orchestration` / `custom-dag` 只命中 **2 条注释**：`AgentWorkflowConfigurator.tsx:611`、`GoalModal.tsx:115`（都写着"当前由 API 调用方指定"）。

而服务端是**支持**的：`team-hub/routes/goal-lifecycle.mjs:77` 读 `body.orchestration === 'custom-dag'`，`team-hub/server.mjs:2715-2719` 在 `custom-dag` 分支上走具名定义的拓扑。

> 也就是说：**代码里存在一条能表达"并行/汇合 DAG"的路径，但没有任何界面能走到它**。文档把这条路径当作默认体验来描述，这是全文最大的一处失真。

**判定：不属实。**

### 1.2 §8.1「高级模式编辑 DAG」与 2026-10-21 的语义变更冲突

§8.1（`:211`）写：高级模式下用户编辑节点、阶段岗位、依赖边、工具配置、模型、执行节点、契约与返工路由；编辑器校验无入口、无终点、循环依赖、不可达阶段。

DAG 编辑器**确实存在**，而且比"三角色链"强得多——`workbench/src/components/AgentWorkflowConfigurator.tsx:837-1112`：增删阶段（最少 2 个，`:360`）、每阶段岗位/工具/稳定 ID（`:905-958`）、产物契约（`:960-983`）、模型/节点/独立测试命令（`:984-1046`）、依赖增删（`:1048-1072`）、审查返工路由（`:1074-1085`）、发布不可变版本（`:1091-1112`）。服务端校验也齐：`runtime/contracts/agent-workflow-definition.mjs:123-158` 覆盖入边/出边、环、可达性，`:169-171` 强制实现阶段必须配 testRunner。

**但它与"发布目标"之间是断开的。** 2026-10-21 的 `24536c88`（"阶段集合由流水线决定，Agent 配置只决定分配"）之后：

- 具名定义在发布路径上被 `definitionAsAssignmentProfile()`（`team-hub/server.mjs:5629-5656`）降格成**按岗位的分配模板**；
- 阶段集合来自 `planGoal()`（`orchestrator/assignment/index.mjs:369-399`），即"编队 ∩ 流水线启用岗位"；
- `buildPipelineWorkflow()` 只生成**相邻边**（`orchestrator/assignment/index.mjs:283-286`），是一条纯线性链。

所以 §4.2 举的例子（"实现"依赖"方案设计"和"测试方案"两个前驱，二者可并行、汇合后解锁）**在默认路径下不可能产生**；它只在显式 `custom-dag` 下成立，而 `custom-dag` 又没有 UI 入口。

**判定：部分属实（编辑器存在），但与默认发布路径语义相反。**

### 1.3 Mesh 不在主路径上，§6 架构图里的 HUB↔Mesh 是虚构的

§2.3（`:37`）把"Mesh"列进 Legion 已有基础；§6（`:172`、`:183`）画了 `HUB <--> M[Mesh：Agent 状态、求助、协调]`，并写"Mesh：承担持久 Soldier 的消息、状态和求助信号"。

实际：

- `mesh/` 只有 6 个文件（`README.md`、`orders.md`、`board.md`、`mailboxes/README.md`、`mailboxes/general.md`、`roster.json`），**没有代码**，`mesh/store` 不存在；
- `mesh/README.md:3,13` 自己说总线由**外部插件** `@deepseek-ai/dsh-tool-mesh` 提供，该包不在本仓 `node_modules`；
- `mesh/board.md:3`、`mesh/mailboxes/README.md:3` 标注"已弃用"；
- `README.md:459` 定性为"早期持久士兵消息总线协议与记录"，`:472` 明说"当前自动化主路径以 team-hub + dsh-scrum-worker + ORCHESTRATION-V3 为准"；
- team-hub 对 `mesh/`、`roster.json`、`orders.md`、`messages.jsonl`、`cursors.json` **零引用**；workbench 里所有 "mesh" 命中都是 three.js 的 `<mesh>` 标签（如 `TaskBoard3D.tsx:59`）；`team-hub/server.mjs:2016` 只有一条注释提及 v1 mesh orders。

**判定：不属实。** 设计不应把已弃用的旁路协议写成当前架构的一部分。

### 1.4 §9 第 5 条"遵守返工上限"已过时

§9（`:244`）写"返工任务引用审查发现、原始 Attempt 与目标阶段，**遵守返工上限**"。

实际是**刻意取消了上限**：`team-hub/server.mjs:5038-5040` 的注释原文——

> `maxReworkRounds` remains in old snapshots for compatibility/history only. Mandatory review findings must continue through implementation and review; a numeric cap used to strand the workflow in `in_review` without fixing them.

`:5215` 返回体的 `maxReworkRounds` 恒为 `null`；`team-hub/pipeline.test.mjs:473` 断言"旧快照 maxReworkRounds=2 不得中断必改项闭环"；对应提交 `26f48561`（"Fix mobile review findings and remove rework cap"）。

残留的不一致值得点名：配置校验仍在校验这个字段（`server.mjs:2220-2225`），UI 已不暴露却仍写死 legacy 值 2（`AgentWorkflowConfigurator.tsx:135` 定义，`:345`、`:423` 使用），`runtime/contracts/agent-workflow.mjs:237` 还留着一份上限判断（旧 Hub 兼容路径）。**"字段还在、语义已废"** 是文档最该说清、也最容易漏记的一类。

**判定：不属实（对当前实现而言）。**

### 1.5 §9 第 6 条"完成合入后复验"时点描述错误

§9（`:245`）与 §11（`:302`）都写"Fan-in 根据仓库配置完成串行集成和**集成后复验**"。

实际顺序（`team-hub/integration-worker.mjs`）：

1. 在**候选合并提交**上跑验证（`:202-216`）；
2. 通过后直接把同一个 SHA 应用到目标 ref（`:232-249`）；
3. 应用之后只校验 ancestor 关系（`:250-253`），**没有在 ref 更新后再跑一遍验证**。

指标端点同样如此：`postIntegrationValidationFailureRate` 统计的是 `VALIDATION_FAILED`（`team-hub/routes/metrics.mjs:56-60`），来源是应用前的那次验证。

这不是 bug，但**文档措辞把"合并前验证候选提交"说成了"合并后再验一次"**，两者在"用户以为集成后的分支被验过"这件事上不等价。

**判定：部分属实（有验证，时点在合并前）。**

### 1.6 §10 的"实时 Timeline"被夸大

§10（`:284`）建议 Timeline 覆盖：认领、节点分配、provider 启动、阶段进度、需要输入、工具失败、取消请求、确认停止、Attempt 终态、验证判词、返工路由、集成结果，并要求带单调序号与断线补读。

实测覆盖情况：

| 事件 | 现状 | 证据 |
| --- | --- | --- |
| claim / transition / advance / reassign / hold / unhold | ✅ | `team-hub/routes/task-lifecycle.mjs:161,177,192,209,229` |
| comment / evidence / feedback | ✅ | `team-hub/routes/comment.mjs:70` |
| patch / review-note / progress / artifact / test-report | ✅ | `task-records.mjs:127,153,90,178,204` |
| rework / rework:chain | ✅ | `team-hub/server.mjs:6911`、`routes/rework.mjs:59` |
| attempt-start / report / reconciliation | ✅ | `server.mjs:5282,5414,5448` |
| provider 启动 | ⚠️ 只有 `attempt-start` 带 `providerName`（`:5282`），无 run id；真实 `run.started` 只在 `run_events`（`runtime/contracts/run.mjs:23`、`run-store.mjs:485-497`） |  |
| 阶段进度 | ⚠️ 仅远程节点有 `node:phase/progress/transition/failure`（`node-gateway.mjs:549,576,634,663`）；本地 run plane 路由**零审计**（`routes/runtime-lease.mjs`） |  |
| 需要输入 | ❌ 无事件，UI 靠"最后一条评论以 ❓ 开头"推断（`TaskDetailModal.tsx:135-141`） |  |
| 工具失败 | ❌ `tool.failed` 只在 `run_events` 与 `/api/tool-calls`（`routes/tool-calls.mjs:90`） |  |
| 取消请求 | ⚠️ 只有 `budget.cancel-requested`（`budget-ledger.mjs:599`），且其 `taskId` 列被填成 attemptId（`server.mjs:1231-1232`）；`stop_run` 无审计 |  |
| 确认停止 | ❌ `routes/write-intent.mjs:172-186` 全程不写 audit |  |
| 验证判词 | ❌ 只在 `run_validations`（`run-store.mjs:2583-2610`） |  |
| 集成结果 | ❌ 只在 `delivery_integration_events`，UI 另拉 `/api/deliveries`（`routes/delivery.mjs:124,131`） |  |

另外**时间线不是实时的**：`TaskDetailModal.tsx:215` 只在挂载/操作后 fetch `/api/activity?taskId=`，弹层内**没有 SSE 订阅**；渲染也只显示时间/动作/人（`:928-944`），不展示 payload。

**判定：部分属实（列出的动作集属实且更全），但"覆盖 gate/集成/确认停止"不属实，"实时"不属实。**

---

## 2. 属实、且值得在设计里保留的部分

这些不是客套——它们是这份设计比同类文档强的地方，逐条都有代码兜底：

1. **冻结三快照已落地**：`goal` 表有 `orchestration` / `pipeline_snapshot` / `assignment_snapshot` / `workflow_snapshot` 四列（`team-hub/server.mjs:2047-2050`），发布时写入（`:2769-2775`），解析后的那份回填 `workflow_snapshot`（`:2782`），发布回执直接带 `frozen` 读数（`:2869-2877`）。§5.2、§7 的"计划选择 / 发布冻结 / 实际运行"三层在数据面**有真实对应**。
2. **任务快照的 `source` 区分了三种来源**：`goal-agent-workflow`（`:5890`）、`goal-node-binding`（`:5910`）、`space-pipeline`（`:6477`）。这正好支撑 §5.1"不用一条配置推断完整执行事实"。
3. **Attempt 与 provider 原生身份持久化**：`agent_workflow_stage_attempts`（`server.mjs:1977-1999`）含 `provider_run_id`、`stop_reason`、`workspace_dir`、`selection_snapshot_json`；首报后 run id 冻结（`:5298-5301`）；`unknown` 不可回 `running`（`:5306`）；worker 重启把未终结 Attempt 批量置 `unknown` + `stop_reason='worker-restarted'`（`:6984-6999`）。
4. **§10 状态标签里"结果待核对"的语义是对的**：UI 已经把 `unknown` 显示为「结果未知，待核对」，并在 provider 无 run id 时显示「Provider 未提供 Run ID」（`TaskDetailModal.tsx:508,511`）。§5.2 结尾那句"不能将沉默解释成进度"有代码支撑。
5. **单一 SSE + 持久单调 seq**：`GET /api/events`（`server.mjs:8300`）是 hub 唯一事件流；`audit.seq INTEGER PRIMARY KEY AUTOINCREMENT`（`:1635-1644`），写事务内 `MAX(seq)+1` 分配（`:3049-3057`，注释记录着"曾用进程内计数器"的教训）；`id:` 行 = seq（`:7231`）；无续传头时回放最近 30 条（`:8342`）——**"有界回放"这句话准确**。
6. **发布时硬校验执行节点**：`:2743-2756` 校验存在/就绪/与阶段绑定一致；跨节点冲突在发布时 409（`:2739-2741`）。§4.3"未开启持续执行时要在发布确认处说明"这条纪律的精神在节点上是兑现的。
7. **失败分类器集中且有兜底**：`orchestrator/state-machine/failure.mjs:19-23`（retryable / unknown-outcome / fatal）、`:33-56`（码表）、`:71-125`（**未登记的码绝不判 retryable**）、`:185-233`（重启恢复）；重试上限默认 5（`run-store.mjs:1098,1172`）。§11"按失败类型决定重试"不是空话。
8. **needs input 有可实现形态**：不是新状态，而是 `blocked` + 以 ❓ 开头的评论（`plugins/src/index.ts:3306-3309`、`plugins/src/stateMachine.ts:146-153`），将军答复后自动解除（`:152-153`）。§10 不新增第二套状态机的原则在这里被守住了。
9. **DAG 定义的静态校验完备**：`runtime/contracts/agent-workflow-definition.mjs:123-158` 覆盖入口无入边、非入口必有入边、终点无出边、非终点必有出边、无环、全部可达。§8.1 列的校验项**全部已在代码里**。

外部引用也核对过：

- **Grok Workflows 属实**（[x.ai/news/workflows](https://x.ai/news/workflows)）：plan as phases/agents/rollup、each agent 干净聚焦上下文、independent skeptics 复核每个 finding、预算 128 agents（大任务 1024）、进度保存支持 pause/resume、`/workflows` 逐阶段查看、`.grok/workflows/` 共享。文档没写 128/1024 这个预算数字，**建议补上**——它是"Agent 预算"（§8.2 最后一条）最直接的可参照量。
- **CloudCLI / Quay 的定性相符**：Quay 自述 "a thin, agent-first task workbench (Provider ABI over MCP)"，与 §2.2"Provider 适配任务存储"和 §2.2 末段"两者 Provider 含义不同不可合并"一致。

---

## 3. 重要遗漏（代码里已有、文档没写，且影响设计判断）

### 3.1 `run_events` 这条明细通道已经落库，但从不开放给 UI/SSE ★最值得补

文档 §10 花大篇幅"建议 Timeline 覆盖 provider 启动、工具失败、阶段进度"。这些数据**其实已经在库里**：

- `run_events` 按 `(attempt_id, event_seq)` 存（`team-hub/run-store.mjs:485-497`），含 `run.started`、`tool.*` 等；
- `run_attempt_events` 只追加（`:294-307,512`）；
- 但 `docs/MULTI-AGENT-FEATURE-STATUS.md:56` 明确记录：**刻意不进 `/api/events`**；
- 且 `workbench/src` 里对 `/api/runtime/run-events` **零调用**。

结论：**这条路上缺的不是采集，是"一个只读出口 + 一层 UI 投影"。** 文档把这件事写成"要建设"，实际成本比它估计的低一个数量级；反过来，如果不指出来，实现者很可能去重复采集一遍。

### 3.2 两套 Attempt 状态词表已经并存，而 §3 原则 4 说"只有一个权威来源"

| 词表 | 取值 | 位置 |
| --- | --- | --- |
| 阶段 Attempt | `starting / running / completed / failed / unknown / canceled` | `team-hub/server.mjs:5289-5290` |
| 运行状态机 | 13 态：`Queued…HandingOff / RetryableFailure / UnknownOutcome / Cancelled / DeadLetter` | `orchestrator/state-machine/states.mjs:22-38` |

两者并存不是错（一个是"阶段一次尝试"，一个是"运行生命周期"），但文档 §3 第 4 条"执行状态只有一个权威来源"目前**在字面上是假的**。真正该写的是：**两张表各自权威、并通过 `taskId` + `stageAttemptId` 建立唯一映射**；缺失的正是这个映射规则。

### 3.3 回放帧会被投递账本 CAS 跳过，老游标重连可能静默少帧

§10（`:286`）要求"断线后使用最后读取的游标向 Hub 补读，页面重连时避免重复展示"。

服务端回放确实按 `seq > N` 走（`server.mjs:8337-8340`），但回放帧**要过 F-05 投递账本**：`takeUp()` 抢不到（该订阅者已把这条标记为 `delivered`/`suppressed` 终态）时直接 `skipped`（`:8352-8360`），不写帧。

语义上这是对的（防重复投递），但它意味着：**换一个订阅者身份、或同一 clientId 反复重连时，补读可能出现静默空洞**。文档只写了"交付去重"的好处，没写这条边界。而 `team-hub/event-delivery.mjs` 整个模块（六态 + 租约 + 三条不变量）在文档里一个字都没出现——它是 §10 落地时绕不开的东西。

### 3.4 Gate 的"独立"实质是测试回执，不是语义审查

§3 第 5 条"Agent 自述是输入，独立检查是验收"是对的，但要说清今天独立在哪：

- **真正的独立证据**是实现阶段的 `testRunner`：worker 自己提交后跑冻结 runner（`plugins/src/index.ts:2856-2912`），Hub 校验回执与**冻结 runner / provider / 节点 / 提交 SHA** 绑定（`server.mjs:5347-5373`），agent 自报测试另存 `agentTestReport`（`:5310-5345`）；
- **但语义审查的"通过"仍然是 reviewer agent 自己的判断**：`plugins/src/index.ts:2942-2953` 只拒绝格式不一致，没有机械语义门；
- 审查阶段缺设计产物或通过回执会被拒（`server.mjs:6165-6293`），这是**证据完整性**门槛，不是**结论正确性**门槛。

文档 §9 把两者混在"独立 Gate"一个词里，会让人以为存在一个第三方语义门。

### 3.5 默认集成模式是 `legacy`，"Fan-in"是可选开关

§6 把 Fan-in 写成运行常态。实际 `plugins/src/legacyConvergence.ts:28-31` 默认 legacy；只有 `LEGION_INTEGRATION_MODE=integration` 才拒绝旧的直合并路径（`plugins/src/index.ts:1874-1898`）。`.legion/delivery.json` 存在、`loadDeliveryConfig` 实跑 `verifyCount=13`，说明配置面是活的，但**默认没启用**。

### 3.6 一条目标只能有一个执行节点

§5.1 表格里 `Execution node` 只写"自动选择或指定节点 ID"。实际有硬约束：`orchestrator/assignment/index.mjs:250-268` 把各阶段 nodeId 与目标级绑定**收敛成一个**，多于一个即 409；`server.mjs:2739-2741` 同义。跨节点 workspace/Git 交接**未实现**。这是会直接影响"多机部署"预期的约束，应写进 §5.1 或 §8.2。

### 3.7 文档里的 REA 证据不可复核

§2.1（`:25`）说"本机 Grok Bot 客户端的 REA 静态分析还观察到会话任务状态、持久 Agent 任务与运行中子 Agent 的独立数据结构，以及 WORKING、NEEDS_INPUT、DONE 等状态"。

`docs/research/` 下**没有任何 REA 报告**（grep `REA`/`静态分析` 零命中），唯一相关的 `external-agent-tools-2026-09-30.md` 讲的是 Grok Bot 的**接入方式**，不是客户端协议结构。这句话目前**无法被下一个读者复核**——本仓对"读数 vs 推断"的要求很高（§2.3 末段自己就写了"源码和配置能证明某能力已建模…不自动证明…"），这条应当同样对待。

---

## 4. 逐节修订建议

按"改一句就能救回准确性"的优先级排列。

| 位置 | 现状问题 | 建议改法 |
| --- | --- | --- |
| `:3-5` 头部 | 写着"设计稿供评审 / v1.0 / 2026-10-14" | 加一行"**核对基线 2026-10-26 @6d688731**"，并把每节改为"现状 / 目标"两段式 |
| 新增 §0 | 无现状基线 | 加一张三列表：`文档主张 \| 代码现状（属实/部分/不属实） \| 证据 path:line`。本报告 §1–§2 可直接压缩成它 |
| `:37`、`:172`、`:183` | 把 Mesh 写成现有基础 | 改为"Mesh 是前代持久士兵消息总线，已不在主路径（`README.md:472`），本设计不以它为前提"；架构图删掉 HUB↔Mesh 或降为虚线"历史" |
| `:57-66` §4.1 | 描述四种操作与计划预览 | 明确标注"**计划预览与编排模式选择尚未实现**（`GoalModal.tsx:94-190` 只有目标文案/分配模板/节点）"；四种操作降为"目标形态" |
| `:87` §4.2 | 用并行/汇合举例 | 注明"并行拓扑只在 `custom-dag` 下成立（`server.mjs:2715`），默认 pipeline 是线性链（`assignment/index.mjs:283-286`，当前无 UI 入口）" |
| `:89-99` §4.3 | 要求阶段卡片显示 7 项 | 分成"配置页已有"（工具/模型/节点，`AgentWorkflowConfigurator.tsx:914-1025`）与"发布面待建"两栏；注明 adapter 在 UI 上**不以文字出现**，用户看到的是「DSH / Claude Code / Codex」三分 |
| `:107-114` §5.1 | 三层概念表 | 加第 5 行"节点唯一性：一条目标只能一个节点，跨节点交接未实现（`server.mjs:2739-2741`）" |
| `:126-148` §5.2 | 成功证明链条 | 保留，但补一句"UI 侧目前只有『冻结版本』与『Attempt 记录』两块并列（`TaskDetailModal.tsx:472-528`），**没有计划/冻结/实际三态对照视图**" |
| `:172`、`:183` §6 | Mesh 承担消息/状态/求助 | 删除或改注为历史；补充"Gate 的独立性目前体现在测试回执而非语义门（§3.4）" |
| `:203` §7 末段 | Session 与 Attempt 分离 | 保留；补"另需定义 `agent_workflow_stage_attempts`（6 态）与运行状态机（13 态，`states.mjs:22-38`）之间的映射规则" |
| `:211` §8.1 | 高级模式编辑 DAG | 保留能力描述，加粗前置条件："在 `pipeline` 编排下，DAG 定义的**阶段集合被忽略**，只作为分配模板；要自定义拓扑必须显式 `custom-dag`（当前无 UI 入口）" |
| `:244` §9 第 5 条 | "遵守返工上限" | 改为"**返工不设上限**（2026-10 移除，`server.mjs:5038-5040`）；必改项必须走完实现与审查，字段 `maxReworkRounds` 仅为历史快照兼容保留（UI 侧残留见 `AgentWorkflowConfigurator.tsx:135`）" |
| `:245` §9 第 6 条 | "集成和集成后复验" | 改为"在**候选合并提交**上验证，通过后应用同一 SHA 并核对 ancestor（`integration-worker.mjs:202-253`）"；并注明默认模式是 `legacy` |
| `:263` §9 末段 | "旧版本通过的证据不能证明返工后的版本通过" | 这条**很好且已被代码守住**（回执绑定提交 SHA），建议升级为独立小节并给出 `server.mjs:5347-5373` 指认 |
| `:269-282` §10 状态表 | 10 个用户可见状态 | 删除「草拟中」（目标状态只有 `active/paused/done/canceled`，`server.mjs:2504`）；其余保留但标注映射来源 |
| `:284` §10 事件清单 | 12 类事件建议 | 拆成"**已入 audit**"/"**已在 run_events 但未开放**"/"**尚不存在**"三组；把 §3.1 的结论写进去 |
| `:286` §10 补读 | 未提投递账本 | 补"回放帧受 F-05 投递账本约束，终态会被 CAS 跳过（`server.mjs:8352-8360`）；`event-delivery.mjs` 六态需与前端去重策略对齐" |
| `:292-302` §11 失败表 | 9 类处理建议 | 大体对，但补"依赖未完成无错误码（靠 `blockedBy`）、门禁失败走返工不走失败类、取消未确认走写入预约 `reconciling`"三处实际归属，否则会被当成待建功能 |
| `:330-359` §14 交付顺序 | 阶段一 4 条 | 按"从零建 / 补齐 / 已完成"重标：**从零建**=发布计划图预览、编排模式选择；**部分已有**=每阶段执行者展示（配置页有、发布面没有）、冻结选择查看（只在任务详情、无并排对照）；**已完成**=节点发布校验。事件补读大半已实现，真缺口是 `run_events` 出口与 gate/集成事件入流 |
| `:363-376` §15 验收场景 | 11 条 | 1、2、3、11 **当前不可达**，需标「依赖 §4.1 未实现」；5、9、10 已可达；6 部分可达 |
| `:392-394` §17 参考 | Grok 链接 | 补 128/1024 agent 预算与 `.grok/workflows/` 共享这两条可复用事实 |
| `:25` §2.1 | REA 静态分析结论 | 补报告路径，或降级为"据外部观察（不可复核）"；本仓纪律要求二者必居其一 |

---

## 5. 建议的新章节骨架（若要做 v1.1）

```
0. 现状基线（2026-10-26 核对表：主张 / 现状 / 证据）
1. 目标与结论（收窄：本设计只承诺三件事）
2. 设计依据（外部三源 + 本仓已落地能力，分开列）
3. 原则（保留 7 条，第 4 条改成"两张状态表各自权威 + 唯一映射"）
4. 发布体验（明确当前形态 vs 目标形态；编排模式必须先有 UI 入口才谈得上选择）
5. 执行者模型（加节点唯一性约束；adapter 在 UI 不显式暴露）
6. 架构（删 Mesh；Gate/Fan-in 标注"默认 legacy，可选 integration"）
7. 数据模型（goal 四快照 + attempt + run_events + delivery 账本）
8. DAG 与心智（pipeline 线性 vs custom-dag 拓扑，边界写死）
9. 交付与核验（返工无上限；验证在候选提交上；门禁证据绑定 SHA）
10. 运行可见性（三组事件：已入 audit / 在 run_events 未开放 / 尚不存在）
11. 失败与恢复（按代码现实重排归属）
12. 权限与隔离
13. 指标
14. 交付顺序（按"从零建/补齐/已完成"重标）
15. 验收场景（标注可达性）
16. 待决策项
17. 参考
```

---

## 6. 一句话给作者

这份设计最有价值的部分（三时点区分、unknown 语义、单一状态源、证据绑定提交）**恰恰是代码已经做到的那部分**；最需要改的部分（发布预览、DAG 编排入口、事件覆盖、集成复验）**恰恰是文档写得最具体、代码最没有的部分**。把这两类分开标注，文档立刻从"愿景"变成"可执行的差距清单"——而本仓的写作风格（`README`/`FEATURES`/`STATUS`）本来就是这么干的。

---

## 7. 后续（本报告提出后已落地的事）

本报告的修订建议已应用，产出两份文件：

1. **设计文档升级到 v1.1**（`docs/design/legion-agent-orchestration-design.md`）：新增 §0 现状基线 20 行对照表；删除 Mesh 架构边与「草拟中」状态；§9 改为「返工不设上限」与「验证在候选提交上」；§10 拆成"已入 audit / 已落库未开放 / 尚不存在"三组；§11 加"今天的实现归属"列；§14、§15 逐条标注可达性。
2. **实施计划 v1**（`docs/superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md`）：按 T1.1–T4.1 拆分，每项含 Files／实现纪律／验收，并预置"常见自我欺骗"清单。

本报告保留原样作为**修订前的证据快照**，不再随代码演进更新。若代码与本报告的判断出现分歧，以代码为准，并在此处追加一行说明。

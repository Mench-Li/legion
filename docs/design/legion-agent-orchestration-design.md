# Legion 多 Agent 协同与执行可观察性设计

状态：设计稿（v1.1 已按代码现状核对），供评审  
版本：1.1（原 v1.0：2026-10-14）  
更新日期：2026-10-26  
核对基线：`6d688731`（其后紧邻 `26f48561` 移除返工上限）  
核对报告：[设计核对报告](../review/legion-agent-orchestration-design-review-2026-10-26.md)  
实现计划：[Agent 编排可观察性实施计划](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md)  

## 0. 现状基线（2026-10-26 核对）

本文件描述**目标形态**。目标与现状之间有一段落差，逐条证据见[核对报告](../review/legion-agent-orchestration-design-review-2026-10-26.md)。开工前请先读本表，避免把"尚未建设"读成"已经回归"。

状态口径：**已落地** = 代码里已有且可用；**部分** = 数据面/配置面有、目标入口没有；**待建** = 尚无实现。

| # | 主张 | 现状 | 关键证据 |
|---|---|---|---|
| 1 | 单一发布入口 + 计划预览（§4.1） | **待建**：发布弹窗只有目标文案、Agent 分配模板、执行节点 | `workbench/src/components/GoalModal.tsx:94-190` |
| 2 | 四种发布操作（采用/选已有/编辑/暂不运行）（§4.1） | **待建** | 同上 |
| 3 | 计划卡片逐阶段显示执行者与就绪度（§4.3） | **部分**：配置页有工具/模型/节点；发布面没有；adapter 不以文字形式出现 | `AgentWorkflowConfigurator.tsx:914-1025`、`:622-653` |
| 4 | 编排模式可选（pipeline / custom-dag）（§8.1） | **部分**：服务端支持，UI 无入口 | `team-hub/routes/goal-lifecycle.mjs:77`；`workbench/src/api.ts:327-334`（无该字段） |
| 5 | 可复用 DAG 编辑（阶段/边/契约/返工路由）（§8.1） | **已落地**（但不改变阶段集合） | `AgentWorkflowConfigurator.tsx:837-1112`、`runtime/contracts/agent-workflow-definition.mjs:123-171` |
| 6 | 阶段集合由流水线决定、编排只决定分配（§8.2） | **已落地**（2026-10-21 语义变更） | `orchestrator/assignment/index.mjs:81-199`、`team-hub/server.mjs:2695-2723` |
| 7 | 发布时冻结流水线/分配/工作流快照（§5.2、§7） | **已落地**：goal 表四列 + 发布回执 `frozen` | `team-hub/server.mjs:2047-2050`、`:2769-2777`、`:2869-2877` |
| 8 | 真实 Attempt + provider 原生 Run ID（§5.2） | **已落地**；无 Run ID 时显示「Provider 未提供 Run ID」 | `team-hub/server.mjs:1977-1999`、`TaskDetailModal.tsx:501-514` |
| 9 | 计划选择 / 发布冻结 / 实际运行 三态并排对照（§5.2） | **待建**：两块信息各自可见，无对照视图 | `TaskDetailModal.tsx:472-528` |
| 10 | 独立 Gate（测试/审查/交付检查）（§9） | **部分**：测试回执是独立证据；语义审查仍由 reviewer agent 判定 | `plugins/src/index.ts:2856-2912`；`server.mjs:5347-5373`；`plugins/src/index.ts:2942-2953` |
| 11 | 返工上限（§9 第 5 条） | **已废除**：必改项不设轮数上限 | `team-hub/server.mjs:5038-5040`、`:5215` |
| 12 | Fan-in 串行集成与复验（§9 第 6 条） | **部分**：有集成 worker；默认 `legacy`；验证在候选合并提交上（合并前） | `team-hub/integration-worker.mjs:202-253`、`plugins/src/legacyConvergence.ts:28-31` |
| 13 | 目标进度与事件时间线（§10） | **部分**：任务时间线有 claim/transition/comment/patch/…；gate、集成、确认停止、工具失败**不入** audit | `team-hub/routes/activity.mjs:79-85`；`TaskDetailModal.tsx:928-944` |
| 14 | 断线补读（§10） | **已落地**：持久 seq + `Last-Event-ID`/`sinceSeq` + 无游标回放最近 30 条 | `team-hub/server.mjs:8321-8343` |
| 15 | provider 启动 / 工具失败等细粒度运行事件（§10） | **已落库但未开放**：`run_events` 刻意不进 `/api/events`，UI 零调用 | `team-hub/run-store.mjs:485-497`；`docs/MULTI-AGENT-FEATURE-STATUS.md:56` |
| 16 | needs input 可见（§10） | **部分**：实现为 `blocked` + ❓ 评论，无独立状态与事件 | `plugins/src/index.ts:3306-3309`、`plugins/src/stateMachine.ts:146-153` |
| 17 | 失败分类与有界重试（§11） | **部分**：分类器在运行层；设计列的 9 类未逐一对应到具名码 | `orchestrator/state-machine/failure.mjs:19-125` |
| 18 | Mesh 承担 Soldier 消息/状态/求助（§2.3、§6） | **不在主路径**：仅遗留协议文档，无代码、无接线 | `mesh/README.md:3`、`README.md:472` |
| 19 | 一条目标一个执行节点（§5.1 隐含） | **已落地且是硬约束**：跨阶段节点不一即 409 | `orchestrator/assignment/index.mjs:250-268`、`team-hub/server.mjs:2739-2741` |
| 20 | 指标从现有事件计算（§13） | **部分**：仓库/交付指标有端点，目标级编排指标待建 | `team-hub/routes/metrics.mjs:76-89` |

读法建议：**§5.2、§7、§9 前半、§10 的补读机制是设计里最扎实的部分，因为代码已经兑现**；**§4.1、§4.3 与 §10 的事件覆盖是写得最具体、代码最没有的部分**。两者必须分开对待。

---

## 1. 目标与结论

本设计把 Grok Bot 的协调者理念、Grok Workflows 的分阶段委派与独立核验、CloudCLI 的会话运行与事件补读，以及 Quay 的可执行验收与失败升级，映射到 Legion 现有的 Goal、TeamPlan、工作流 DAG、任务、Attempt 和验收流程。（Mesh 不在当前主路径，见 §2.3。）

用户只需面向 General 描述要完成的目标。General 负责规划、解释并协调；发布前，用户能看懂每一阶段由什么 Agent 工具执行、依赖哪些阶段、是否自动运行；发布后，页面能区分计划选择与真实运行记录，并给出可追溯的验证结果。

推荐的产品路径是：**一个发布入口，一份可读计划，一套冻结执行快照，一条可观察的运行记录，一个独立验收与结果汇总闭环。** Legion 已有 DAG 和 Agent 工具快照，不应再增加相互竞争的调度状态源。优先工作应补齐配置体验、执行身份展示、运行详情与失败恢复。

本设计的范围是 Legion 内部目标到交付的多 Agent 编排，不涵盖把 Legion 重写为通用 Agent 平台，也不直接引入 CloudCLI 或 Quay 的整套运行环境。

## 2. 设计依据与项目边界

### 2.1 Grok Bot 与 Grok Workflows

Grok Bot 把用户入口交给一个协调者，由协调者处理常规路由，在需要判断时再找用户；工具和技能可以共享，角色上下文保持区分；Agent 的状态和当前活动可按需查看。[Grok Bot 产品设计](https://x.ai/news/designing-grok-bot)

Grok Workflows 把复杂工作规划为阶段、阶段内的 Agent 与结果汇总关系。公开介绍特别强调各 Agent 使用聚焦上下文、运行可暂停和恢复，以及让独立验证者检查发现后再汇总。同文给出的规模上限是**单次运行 128 个 Agent、大任务可到 1024**，以及保存在 `.grok/workflows/`（团队共享）或 `~/.grok/workflows/`（个人）下的可复用流程与 `/workflows` 逐阶段观测。[Grok Workflows](https://x.ai/news/workflows)

本机 Grok Bot 客户端的 REA 静态分析还观察到会话任务状态、持久 Agent 任务与运行中子 Agent 的独立数据结构，以及 WORKING、NEEDS_INPUT、DONE 等状态。这支持“任务可见、求助可见、后台工作可追踪”的产品方向；静态协议结构不能证明 Grok 服务端的实际调度算法。**该分析目前没有落进 `docs/research/`，属于不可复核证据，引用时按"外部观察"对待。**

### 2.2 CloudCLI 与 Quay

CloudCLI 面向人和多个编程 Agent 的日常协作，值得参考的是 Session、Run、底层进程/Host 分层、事件序号与断线补读，以及多个客户端观察同一运行的能力。[CloudCLI](https://github.com/yaleh/claudecodeui) [聊天运行架构](https://github.com/yaleh/claudecodeui/blob/develop/docs/architecture/README.md)

Quay 面向任务持续推进和代码落地，值得参考的是可执行验收门、机械驱动、独立检查、Fan-in 集成和失败后升级到人工处理。[Quay](https://github.com/yaleh/quay) [Promotion Driver](https://github.com/yaleh/quay/blob/master/plugin/scripts/promotion-driver.ts) [Worker Driver](https://github.com/yaleh/quay/blob/master/plugin/scripts/worker-driver.ts) [Fan-in](https://github.com/yaleh/quay/blob/master/plugin/scripts/worker-fan-in.ts)

两项目的 Provider 含义不同：CloudCLI Provider 适配 Agent 工具；Quay Provider 适配任务存储。二者不能因术语相同而合并成 Legion 的同一种配置。

### 2.3 Legion 已有基础

Legion 已有空间流水线、可配置 Agent Workflow DAG、工作流定义和实例、发布目标时冻结的阶段配置、按 DAG 依赖派工、上游产物交接、阶段 Attempt、失败与未知状态处理、审查返工和看板。默认流水线可独立运行；Agent Workflow 用于自定义阶段、工具和依赖。自动执行仍由持续执行设置等现有开关控制。[Legion 功能说明](../FEATURES.md#321-agent-工作流配置跨-agent-闭环可选) [外部 Agent 工作流实现记录](../research/external-agent-tools-2026-09-30.md)

**Mesh 不在当前主路径。** `mesh/` 只剩协议文档与记录，不含代码；总线本身由外部插件 `@deepseek-ai/dsh-tool-mesh` 提供且本仓未安装，team-hub 对它零引用。仓内定位见 `README.md:472`（"当前自动化主路径以 team-hub + dsh-scrum-worker + ORCHESTRATION-V3 为准"）。本设计不以它为前置。

Legion 的 Claude Code 与 Codex 外部阶段经 DSH Provider 接入；DSH 原生执行也在同一工作流中可选。配置快照和实际 Attempt 记录已经有代码基础，运行界面需要让它们形成用户可读的解释链。[外部 Agent 接入讨论稿](../research/cloudcli-quay-legion-discussion.md)

源码和配置能证明某能力已建模或已接线，不自动证明某台执行节点当前已安装、认证、权限匹配，或某次运行真实成功。节点心跳、provider 就绪读数、冻结选择和成功 Attempt 是不同证据。

## 3. 设计原则

1. **General 是唯一默认入口。** 用户讲目标与约束，General 负责规划、分派、收敛结果；用户仍可查看或覆盖阶段 Agent。
2. **先解释任务计划，再展示 DAG 术语。** 默认视图讲阶段、负责人、先后关系和交付物；高级视图才开放依赖边、工具、契约、模型与节点等细节。
3. **Agent 身份必须可确认。** 计划选择、发布冻结、节点实际启动和任务交付记录分别展示，不用一条配置推断完整执行事实。
4. **执行状态只有一个权威来源，且两张状态表要有唯一映射。** 复用 Goal、工作流实例、任务和 Attempt；Timeline 是这些记录的可读投影，不建立第二套任务状态机。今天实际存在两张 Attempt 级词表——阶段 Attempt 六态（`starting/running/completed/failed/unknown/canceled`，`team-hub/server.mjs:5289-5290`）与运行状态机十三态（`orchestrator/state-machine/states.mjs:22-38`）——**它们各自权威，必须通过 `taskId` + `stageAttemptId` 建立唯一映射**，否则"同一个失败"在两张表里会读出两种结局。
5. **Agent 自述是输入，独立检查是验收。** 工具退出、文字报告、测试、提交、合入和用户验收表达不同事实。
6. **上下文按阶段交接。** 给阶段所需的目标、约束、上游产物和证据；角色专属提示留在角色侧；凭据留在执行节点本地。
7. **未证实的结果不能当成功。** 对取消与结束竞争、进程重启、连接中断等情况保留 unknown 或待核对状态，核实后再决定续做。

## 4. 用户操作流程

### 4.1 单一发布入口

> **现状（2026-10-26）**：本节描述的是**目标形态，尚未实现**。今天的发布弹窗只有三项：目标文案、「Agent 分配模板（不改变阶段）」下拉、执行节点（`workbench/src/components/GoalModal.tsx:94-190`）。没有计划预览，也没有下面四种操作。

用户在指挥台的“发布目标”入口输入目标。General 读取空间流水线、可用岗位、Agent 工具配置、执行节点与自动执行设置，生成一份计划预览。入口给出推荐流程、实际 Agent 选择和可执行性检查，再由用户发布。

计划预览提供四种操作：

- **采用推荐计划并发布**：直接使用 General 给出的 DAG。
- **选择已有流程**：采用空间默认流水线或已发布的工作流版本。
- **编辑计划**：进入高级 DAG 编辑器，修改阶段、负责人、依赖、工具或验收契约。
- **创建后暂不运行**：保存目标和计划，等待用户或管理员开启执行。

用户不需要配置自定义 DAG 时不应被送入空白编辑器。若当前工作流工具面板已有多步配置，发布入口要说明该步骤究竟选择了什么；“工作流已发布”与“任务会自动启动”不能混为一件事。

**今天这一步实际发生的事**（可作为落地的起点，不必推翻）：

1. 弹窗读 `/api/agent-workflows/definitions`，按 id 只保留最新版（`workbench/src/goalWorkflowOptions.mjs:9-18`）；
2. 选中的定义**不改阶段集合**，只当分配模板（`team-hub/server.mjs:2695-2698`，经 `definitionAsAssignmentProfile`）；
3. 节点由纯函数 `decideAutoNode` 五档判定，手动可覆盖（`workbench/src/goalNodeChoice.ts`）；
4. 提交只带 `{id, version} + agentNodeId`（`workbench/src/api.ts:327-334`）——**`orchestration` 字段界面上不存在**，所以 `custom-dag` 目前只能由脚本/API 调用方触发（`team-hub/routes/goal-lifecycle.mjs:77`）。

### 4.2 推荐计划示例

目标：“实现商品价格监控，包含需求澄清、实现、测试和独立审查。”

> **注意**：下图是目标形态。默认 `pipeline` 编排只生成**相邻边**的线性链（`orchestrator/assignment/index.mjs:283-286`），并行/汇合拓扑只在显式 `custom-dag` 下成立，而后者当前没有界面入口。所以“实现依赖方案设计 + 测试方案两个前驱”这类图，今天**发布不出来**。

~~~mermaid
flowchart TD
    U[用户描述目标] --> G[General 澄清目标和约束]
    G --> P[生成计划预览]
    P --> D{选择}
    D -->|采用推荐| V[检查工具、岗位、节点和依赖]
    D -->|选择已发布工作流| V
    D -->|高级编辑 DAG| V
    V -->|有缺项| X[显示缺失条件和修法]
    X --> D
    V -->|满足条件| C[用户确认发布]
    C --> F[冻结工作流与阶段配置]
    F --> R[按 DAG 调度阶段]
~~~

对并行图，界面应明确汇合阶段需要等待哪些前驱。例如“实现”依赖“方案设计”和“测试方案”时，两个前置阶段可并行，只有二者都完成后实现才解锁。General 应解释重要边的含义，不能只让用户看到连线。

### 4.3 计划卡片显示执行者

每个阶段卡片至少显示：

- 阶段名称与岗位；
- Agent 执行工具：例如 DSH 原生、Claude Code 或 Codex；
- 工具配置版本和适用时的模型；
- 执行节点或自动节点选择说明；
- provider 就绪读数与权限兼容状态；
- 输入、输出和验收摘要；
- 阶段依赖及预期并行/汇合关系。

分栏说明今天各自落在哪：

| 字段 | 配置页（`AgentWorkflowConfigurator.tsx`） | 发布面（`GoalModal.tsx`） |
|---|---|---|
| 阶段名称与岗位 | 有（`:905-958`） | 无 |
| Agent 执行工具 + 配置 id/版本 | 有（`:914-948`、`:76-82`） | 只有"分配模板"一个粗粒度下拉 |
| 模型 | 有，但仅 DSH 原生可选；Claude/Codex 显示"不适用"（`:987-1019`） | 无 |
| 执行节点 | 有（`:1021-1025`） | 有（自动判定 + 手动覆盖） |
| provider 就绪读数 | 面板级、按 provider 的只读清单（`:622-653`），**不是每阶段徽标** | 无 |
| 输入/输出/验收摘要 | 有产物契约选择（`:960-983`） | 无 |
| 依赖与并行/汇合 | 有依赖增删（`:1048-1072`） | 无 |

**adapter 在界面上不以文字出现**：用户看到的是「DSH / Claude Code / Codex」三分，`dsh-native` / `dsh-subagent` 只用于代码判断（`:77-80`、`:922-923`）。设计若要展示 §5.1 的三层概念，需要先让界面引入 adapter 这一档。

预览需区分“系统读数没有”与“已知不就绪”。节点心跳在线只证明节点通信，不证明 Agent 认证成功。若未开启持续执行，发布确认处要说明计划将创建任务但不会自行开跑。

## 5. 执行者模型与确认链路

### 5.1 三个概念层

“DSH、Claude、Codex”不是互斥的同层选择。设计和 UI 统一显示以下字段：

| 层 | 含义 | 示例 |
|---|---|---|
| Adapter | Legion 通过哪条接入路径执行 | DSH 原生 dsh-native；DSH 子 Agent 适配器 dsh-subagent |
| Provider / Agent 工具 | 实际选择的 Agent 实现 | spawn、fork、claude-code、codex |
| Model | Provider 内部采用的模型配置 | DSH 原生阶段冻结的供应商与模型；外部 Agent 按各自原生模型配置执行 |
| Execution node | 哪台 Legion worker/守护执行节点承载该任务 | 自动选择或指定节点 ID |
| **节点唯一性** | 一条目标只能收敛到一个执行节点 | 跨节点 workspace/Git 交接**未实现**：各阶段 nodeId 多于一个即发布 409 |

例如 adapter 为 dsh-subagent、providerName 为 codex，表示通过 DSH 的子 Agent 执行路径启动 Codex。执行节点是运行 Legion worker 的机器，不是 Claude/Codex 产品本身。

**节点唯一性是硬约束，不是默认值**：`resolveEffectiveNode()`（`orchestrator/assignment/index.mjs:250-268`）把目标级绑定与各阶段 nodeId 去重后收敛成一个，多于一个抛 `AGENT_NODE_WORKSPACE_MISMATCH`（409）；`publishGoalRecord()` 在发布时同样检查（`team-hub/server.mjs:2739-2741`）。多机部署的预期必须据此调整：**一条链不能横跨两台机器**。

### 5.1.1 执行者的两级粒度

选择"由哪个 Agent 执行"有两个粒度，用户可以只用其一，也可以叠加：

1. **整目标一个 Agent**：一次选定，链上所有阶段都用它。适合"这个目标我想整条交给 Codex"。
2. **按节点分别指定**：每个阶段各自选 Agent／模型／节点。适合"需求轻量、编码用 Claude、审查用 Codex"。

**现状**：第 2 种已可用，但入口在配置页且是**空间级**的（影响之后所有目标）；第 1 种**尚不存在**——`goal` 表只有 `agentNodeId`，没有目标级 Agent 配置。要在发布弹窗里做"只影响这一个目标"的选择，需要新增一层。

**优先级**（同一次发布里，越具体越优先）：

| 层 | 来源 | 作用域 |
|---|---|---|
| 1 | 发布时按节点覆盖 | 本目标本次发布 |
| 2 | 目标级 Agent | 本目标本次发布 |
| 3 | 分配模板 `stageTools[role]`（具名定义／空间闭环配置） | 空间可复用 |
| 4 | `space_stages.agent_tool_config` | 空间阶段默认 |
| 5 | DSH 默认 | 全局 |

三条不可让步的约束：

- **目标级只决定"谁执行"，不决定"怎么验证"**。独立测试命令（`testRunner`）始终来自模板／空间配置，不能被发布时随手覆盖——否则"整目标一个 Agent"会顺手把验收改成永远通过。
- **外部 Agent 与模型覆盖互斥**。Claude Code／Codex 按各自原生模型配置执行，阶段级模型选择对它们无效（`team-hub/server.mjs:6299-6305` 明确拒绝）。
- **整目标同一 Agent = 自审**。design／implementation／review 同源时，语义审查不再来自第二个 Agent（测试回执仍然独立）。这是可接受的取舍，但必须在界面上说明，不能让人以为仍是交叉验证。**2026-10-27 决策：接受并显式标注（不拦发布）**——拦了就等于否掉这个能力本身。实现为 `selfReview` 字段，同时进计划预览与发布回执的 `frozen`；提示语必须说清"哪一半仍独立"（独立测试回执不受影响）。详见[决策记录](../review/decisions-2026-10-27.md) §2。

实现拆分见[实施计划](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md) T1.5、T1.6。

### 5.2 计划选择、冻结配置、实际运行

Legion 需要在 UI、日志和审计里区分三个时点：

1. **计划选择**：General/DAG 为该阶段推荐或用户指定的工具与节点。
2. **发布冻结**：目标发布时写入该阶段的 Agent 工具、配置版本、模型配置、权限模式和节点快照。
3. **实际运行**：每次 Attempt 的 provider 名、原生 Run/Thread ID（若有）、执行节点、起止时间、状态、结果摘要和证据。

成功证明链条：

~~~mermaid
sequenceDiagram
    participant U as 用户
    participant G as General / 计划器
    participant H as Hub
    participant W as Worker
    participant D as DSH Provider
    participant A as Claude / Codex / DSH Agent
    U->>G: 提出目标与约束
    G->>H: 发布冻结的阶段配置
    H->>W: 依据 DAG 解锁和派发阶段
    W->>H: 创建 Attempt，记录计划 provider
    W->>D: 校验节点、工具和权限后启动
    D->>A: 原生 SDK、app-server 或 DSH Agent 调用
    A-->>D: 运行事件、结果和产物
    D-->>W: 返回 provider 身份与执行结果
    W-->>H: 结算 Attempt 并附证据
    H-->>U: 展示冻结选择、实际运行和验证状态
~~~

只有配置快照时，状态应显示“计划使用”；provider 成功启动后显示“已由该 provider 执行”；provider 未提供原生 Run ID 时显示“未提供”，不编造身份。状态为 unknown 或启动结果不明时，界面明确显示“执行身份/结果待核对”，避免将它与失败或完成合并。

**今天已兑现的部分**：三个时点在数据面都有对应物——发布时把流水线、分配、解析后的工作流快照分别冻结进 `goal.pipeline_snapshot / assignment_snapshot / workflow_snapshot`（`team-hub/server.mjs:2047-2050`、`:2769-2777`），发布回执直接带 `frozen` 读数（`:2869-2877`）；任务快照的 `source` 区分 `goal-agent-workflow` / `goal-node-binding` / `space-pipeline`（`:5890`、`:5910`、`:6477`）；每次尝试落在 `agent_workflow_stage_attempts`（含 `provider_run_id`、`stop_reason`、`workspace_dir`）。

**尚未兑现的部分**：界面上只有「冻结版本」与「实际 Attempt 记录」两块**各自可见**（`workbench/src/components/TaskDetailModal.tsx:472-528`），没有把计划选择 / 发布冻结 / 实际运行**并排对照**的三态视图，也没有"计划说 A、实际跑 B"的偏差提示。"计划使用"这类标签全仓不存在。

## 6. 目标架构与职责

~~~mermaid
flowchart LR
    U[用户] --> G[General：唯一协调者]
    G --> PLAN[计划器：目标、DAG、执行者选择]
    PLAN --> HUB[Team Hub：Goal、TeamPlan、实例、任务]
    HUB --> SCHED[现有 DAG 调度与认领]
    SCHED --> W[Legion Worker]
    W --> NODE[执行节点：本地凭据和工作区]
    NODE --> DSH[DSH subagents Provider]
    DSH --> C[Claude Code]
    DSH --> X[Codex]
    DSH --> N[DSH 原生 Agent]
    W --> ATT[Attempt 与运行事件]
    C --> ATT
    X --> ATT
    N --> ATT
    ATT --> GATE[独立 Gate：测试、审查、交付检查]
    GATE --> FANIN[Fan-in：按仓库策略集成与复验]
    FANIN --> R[General 汇总证据、结论和待办]
    R --> U
~~~

> **Mesh 已从图中移除**：它不在主路径（见 §2.3）。若将来恢复持久 Soldier 消息面，应作为 Hub 之外的旁路重新论证，而不是默认画进架构。

各组件职责建议如下：

- **General**：用户沟通、目标澄清、计划草拟、例外处理、最终汇总。
- **工作流定义与实例**：阶段拓扑、依赖边、阶段输入输出契约、冻结配置及目标内运行记录。
- **DAG 调度**：基于现有 blockedBy 和阶段实例决定哪些任务可认领；汇合阶段等待全部必要前驱。（默认 `pipeline` 编排的链是线性的，见 §4.2。）
- **Worker**：领取任务、准备独立工作区、校验冻结配置、创建 Attempt、调用 DSH Provider、解析交付并报告。
- **执行节点**：提供实际进程、权限和本地凭据；向 Hub 报告可用工具和能力。
- **Gate / 验收者**：独立检查工作结果和证据，判定通过、返工或需要人工处理。**独立性今天主要来自测试回执**（worker 提交后跑冻结 runner，Hub 校验回执与 runner/provider/节点/提交 SHA 绑定，`plugins/src/index.ts:2856-2912`、`team-hub/server.mjs:5347-5373`）；**语义审查的"通过"仍由 reviewer agent 判定**（`plugins/src/index.ts:2942-2953` 只拒格式不一致）。不要把两者混成一个"第三方门禁"。
- **Fan-in / 交付**：依据仓库配置串行集成；**验证发生在候选合并提交上、fast-forward 之前**，应用后只核对 ancestor 关系。**两点必须写明**：默认模式是 `legacy`（`plugins/src/legacyConvergence.ts:28-31`），只有 `LEGION_INTEGRATION_MODE=integration` 才走严格路径；"集成后复验"是不准确的措辞（`team-hub/integration-worker.mjs:202-253`）。

## 7. 计划数据与运行数据

新设计尽量使用现有数据结构，先检查能否补齐关联字段，避免复制第二份状态。

| 对象 | 作用 | Legion 对应基础 |
|---|---|---|
| Goal | 用户想达成的结果及目标状态 | /api/goal 与目标记录 |
| Workflow Definition | 可复用的阶段、边、契约与工具引用 | 版本化不可变定义 |
| Workflow Instance | 某个 Goal 的冻结运行计划与阶段关系 | 工作流运行实例 |
| Stage Task | 可被调度、阻塞、审查和完成的工作项 | TeamPlan/任务及 blockedBy |
| Attempt | 阶段的一次实际执行尝试 | agent_workflow_stage_attempts |
| Run identity | Agent provider 侧线程、turn 或进程标识 | Provider 可提供时关联保存 |
| Event | 运行、等待、取消、验证、集成等事件 | 现有 Hub 审计（`audit`）+ SSE `/api/events`；细粒度运行事件在 `run_events`，**尚未开放**（见 §10） |
| Artifact / Evidence | 文件、提交、测试、来源和检查结果 | 阶段产物及证据契约 |
| Gate | 机械或独立语义验收 | 测试回执（独立）+ 审查判词（agent 判定） |

Session 与 Attempt 的职责要保持分开。Session 表示持续设计讨论或 Provider 可恢复的原生会话；Attempt 表示一次阶段执行。第一阶段优先让一次性 Attempt 可观察、可核实、可恢复，不需要为了界面新增持久会话实体。以后若做持续设计伙伴，再确定 Session 与 Goal/工作流实例的关联、历史冻结规则和恢复行为。

## 8. DAG 设计和用户心智

### 8.1 两种使用层级

**常用模式**：空间默认流水线，或 General 从目标生成推荐 DAG。用户只看阶段卡片和依赖解释。

**高级模式**：用户编辑节点、阶段岗位、依赖边、工具配置、模型、执行节点、输入输出契约和审查返工路由。编辑器校验无入口、无终点、循环依赖、不可达阶段、缺少岗位或无效工具等错误。

> **编辑器已在，只是与发布链路脱钩（2026-10-26）**
>
> 能力齐备：`workbench/src/components/AgentWorkflowConfigurator.tsx:837-1112` 可增删阶段（最少 2 个，`:360`）、配岗位/工具/稳定 ID（`:905-958`）、选产物契约（`:960-983`）、配模型/节点/独立测试命令（`:984-1046`）、增删依赖（`:1048-1072`）、设审查返工路由（`:1074-1085`）、发布不可变版本（`:1091-1112`）。静态校验也齐：`runtime/contracts/agent-workflow-definition.mjs:123-171` 覆盖入边/出边、环、可达性，并强制实现阶段必须有 testRunner。
>
> **但 2026-10-21 起**（`24536c88`），具名定义在发布路径上被降格成**按岗位的分配模板**（`team-hub/server.mjs:5629-5656` 的 `definitionAsAssignmentProfile`），阶段集合改由 `planGoal()` 从流水线推导（`orchestrator/assignment/index.mjs:369-399`），而 `buildPipelineWorkflow()` 只生成**相邻边**（`:283-286`）。因此：**在默认 `pipeline` 编排下，用户在编辑器里画的拓扑不会进入目标链**；要按拓扑建链必须显式 `custom-dag`（`team-hub/server.mjs:2715-2719`），而它当前没有 UI 入口。
>
> 这条边界必须写在用户读到的第一段，否则"我画了并行图，跑出来却是直线"会是一个反复出现的困惑。

发布目标页应说明选择的模式、流程版本、自动执行开关与未满足前置条件。工作流定义用于可复用计划，工作流实例用于某个目标的冻结运行；修改新版本不能改变已经发布目标的执行配置。

### 8.2 General 生成计划的约束

- 把目标拆成可交付、可验收的阶段，而非只拆成职位名称。
- 只在输入依赖允许时并行，明确标注汇合阶段等待的全部输入。
- 每个阶段都输出可传递的产物或明确状态。
- 工具和节点能力不满足时先标记不可执行并解释原因，不静默回退到另一个 Agent。
- 给出阶段数、最大并行度和 Agent 预算；无法可靠估成本时显示未提供。（可参照量：Grok Workflows 单次运行预算 128 个 Agent，大任务 1024。）
- 生成后执行静态 DAG 与配置校验，用户预览确认后才发布。
- 将计划说明和上游摘要传给执行者；不把其他 Agent 的整段历史无差别广播。
- **平台约束先于"最优拆分"**：一条目标只能收敛到一个执行节点（§5.1），所以不要把"分给多台机器并行"当作默认策略；需要跨机时必须先解决 workspace/Git 交接。

## 9. 阶段交付、汇总和独立核验

每个阶段的标准报告包含：

| 字段 | 内容 |
|---|---|
| 状态 | 完成、受阻、需要用户决策、结果未知 |
| 摘要 | 做了什么、结论是什么 |
| 产物 | 文件、报告、提交或其他可查看输出 |
| 证据 | 测试结果、来源、命令与适用版本 |
| 未解决项 | 对后续阶段或目标验收的影响 |
| 建议路由 | 可进入的下游阶段或建议返工目标 |

汇总遵循以下链路：

1. Worker 将原始报告和产物与阶段 Attempt 绑定。
2. DAG 解锁只根据任务状态和依赖判据；报告文本不能绕过依赖。
3. 汇合阶段接收契约所声明的上游产物。
4. 独立 Gate 检查接受标准，输出通过或带原因的失败判词。
5. 返工任务引用审查发现、原始 Attempt 与目标阶段，**返工不设轮数上限**（2026-10 移除：`team-hub/server.mjs:5038-5040`，理由是数值上限会把未修完的必改项晾在 `in_review`；`maxReworkRounds` 字段仅为历史快照兼容保留，UI 侧仍写死 legacy 值 2 见 `AgentWorkflowConfigurator.tsx:135`）。
   **2026-10-27 决策：连续同因升级**——同一 finding（指纹 = `kind|file|归一化 summary`，**不含 evidence**）连续 N 轮（默认 3）仍在 ⇒ 审查任务停 `in_review` + `hold` 并追加说明评论，**不再自动开下一轮**。治的是"同一件事反复修不好"，不是"轮数多"；修好一次再复发（回归）不算。详见[决策记录](../review/decisions-2026-10-27.md) §1。
6. Fan-in 根据仓库配置完成串行集成与验证；**验证发生在候选合并提交上、fast-forward 之前**（`team-hub/integration-worker.mjs:202-253`），默认模式是 `legacy`。
7. General 给用户汇总完成情况、证据链接、未解决事项和下一步。

~~~mermaid
flowchart TD
    A1[设计 Agent：设计与边界] --> M[实现阶段：接收冻结设计]
    A2[测试方案 Agent：独立测试思路] --> M
    M --> T[测试 Gate：检查指定提交]
    T -->|通过| R[独立审查 Agent]
    T -->|失败| FIX[修复 Attempt：带失败证据]
    FIX --> T
    R -->|通过| FI[Fan-in：集成与复验]
    R -->|需返工| RT[路由到设计或实现阶段]
    RT --> T
    FI -->|集成成功| S[General 汇总并交付]
    FI -->|失败或冲突| H[保留现场并升级处理]
~~~

测试和审查必须记录针对的代码版本或产物摘要。旧版本通过的证据不能证明返工后的版本通过；Agent 自己生成的测试不能单独取代独立验收。

**这条已被代码守住，是本设计最该保留的纪律**：实现阶段交付时，Legion 宿主自建提交后跑冻结的 testRunner（`plugins/src/index.ts:2856-2912`），Hub 把回执与**冻结 runner / provider / 节点 / 提交 SHA** 逐项核对（`team-hub/server.mjs:5347-5373`），agent 自报的测试另存为 `agentTestReport`（`:5310-5345`）。审查阶段缺少设计产物或通过回执时直接拒收（`:6165-6293`）。

需要同时说清它**不**包含什么：上述检查保证的是**证据完整性**（结论是否绑定了确切版本），不是**结论正确性**（"通过"这个判断本身仍由 reviewer agent 作出）。

## 10. 运行状态、Timeline 与进度可见性

用户主视图需要回答四个问题：谁在执行？执行到哪个阶段？为什么在等待或停止？我需要做什么？

建议主视图使用简洁的阶段卡片和目标进度条；点击阶段才展开事件、Attempt、Agent 原生身份、日志摘要、产物和证据。状态标签要将 Legion 任务状态映射为用户可理解的语义，不新增第二套持久状态机：

| 用户可见状态 | 含义 | 今天映射自 |
|---|---|---|
| 等待前置任务 | DAG 上游阶段未完成 | `todo` + 非空 `blockedBy` |
| 排队 | 已可执行，等待 worker/节点 | `todo` + 依赖已解 |
| 运行中 | provider 已确认开始 | `in_progress` |
| 需要用户决定 | 目标取舍或澄清需由用户判断 | `blocked` + 以 ❓ 开头的评论（无独立状态） |
| 执行受阻 | 节点、认证、权限、工具或工作区问题 | `blocked` |
| 待验证 | Agent 有结果，Gate 尚未结算 | `in_review` |
| 集成中 | 进入 Fan-in、合入或集成前验证 | 交付态 `preparing/validating`（`workbench/src/deliveryBadge.ts:18-26`） |
| 已完成 | 必需阶段、验收与交付条件全部达成 | `done` |
| 结果待核对 | 进程或节点异常，实际副作用/终态未知 | 阶段 Attempt `unknown` + `stop_reason`（如 `worker-restarted`） |

> 已删除原表的「草拟中」：目标状态只有 `active / paused / done / canceled`（`team-hub/server.mjs:2504`），"计划已存但未发布"在今天不是一个可持久化的目标形态。若要做"创建后暂不运行"，需要先引入草稿态。

Timeline 事件建议覆盖：认领、节点分配、provider 启动、阶段进度、需要输入、工具失败、取消请求、确认停止、Attempt 终态、验证判词、返工路由、集成结果。事件带有空间、目标、任务、阶段、Attempt、来源、时间和单调序号或等效游标。

**现状三分（2026-10-26）——这决定了每一步的真实成本：**

- **已入 audit（`/api/events` 可看到）**：`claim`、`transition`、`advance`、`reassign`、`hold`、`unhold`（`team-hub/routes/task-lifecycle.mjs:161,177,192,209,229`）、`comment`/`evidence`/`feedback`（`routes/comment.mjs:70`）、`patch`/`review-note`/`progress`/`artifact`/`test-report`（`task-records.mjs:127,153,90,178,204`）、`rework`/`rework:chain`（`server.mjs:6911`、`routes/rework.mjs:59`）、`agent-workflow:attempt-start/report/reconciliation`（`server.mjs:5282,5414,5448`）。**这一组的覆盖比本文原清单更全。**
- **已落库但未开放**：`run_events`（按 `attempt_id + event_seq`，`team-hub/run-store.mjs:485-497`）含 `run.started`、`tool.*` 等 13 类；它**刻意不进 `/api/events`**（`docs/MULTI-AGENT-FEATURE-STATUS.md:56`），workbench 对 `/api/runtime/run-events` **零调用**。provider 启动、工具失败、本地 run plane 的阶段进度都在这里——**缺的不是采集，是一个只读出口 + 一层 UI 投影**。
- **尚不存在**：需要输入（靠 ❓ 评论推断）、取消请求（只有 `budget.cancel-requested`，且其 `taskId` 列被填成 attemptId）、确认停止（`routes/write-intent.mjs:172-186` 不写 audit）、验证判词（只在 `run_validations`）、集成结果（只在 `delivery_integration_events`，UI 另拉 `/api/deliveries`）。

另外：任务详情的时间线**已于 2026-10-27 接通实时增量**（T2.2）。此前它只在挂载/操作后 fetch 一次，弹层内没有订阅——用户必须关掉再打开才看得见"它开始跑了"。现在它订阅**既有的** `/api/events`（与对话中心/通知中心/任务中心同一个原语），按 `taskId` 过滤后并入时间线；首次拉取仍是权威历史，增量按 `seq` 去重（`workbench/src/timelineSummary.ts`）。摘要只折叠相邻的进度心跳，返工、验证判词、状态变更等关键事件**一条都不折叠**。渲染仍只到"时间/动作/人"，不展开 payload。

断线后，客户端使用最后读取的游标向 Hub 补读事件，历史记录为事实来源，实时流作为增量传输。页面重连时要避免重复展示。敏感环境变量与凭据值不进入事件。Provider 未提供的事件或身份显示“未提供”，不能将沉默解释成进度。

**已落地的补读机制**：`audit.seq` 是 SQLite 自增主键（`team-hub/server.mjs:1635-1644`），写事务内 `MAX(seq)+1` 分配（`:3049-3057`）；`GET /api/events` 优先读 `Last-Event-ID`、其次 `sinceSeq`，按 `seq > N` 升序回放；**无游标时回放最近 30 条**（`:8321-8343`）。客户端实际走 `sinceSeq`（主动重连、不依赖 EventSource 原生续传，`workbench/src/hubEventStream.ts:132-180`）。

**两条边界必须写进设计，否则会在现场被当成 bug**：

1. **回放帧要过投递账本**（`team-hub/event-delivery.mjs`）。`takeUp()` 抢不到（该订阅者已把这条标记为 `delivered`/`suppressed` 终态）时直接跳过不写帧（`server.mjs:8352-8360`）。语义正确，但它意味着**换订阅者身份或反复重连时补读可能出现静默空洞**。
2. **带游标回放无上限**（`:8337-8340`），长时间不连后第一次重连可能回放大量历史帧；而兜底路径是整表重拉（`workbench/src/App.tsx:198,473`，20s 轮询见 `TaskCenterView.tsx:284`）。

## 11. 失败处理与恢复

Quay 的有价值模式是持续评估、有限修复和失败升级。Legion 需要按失败类型决定重试，而不是所有错误都重新派工。

| 失败类型 | 建议处理 | 今天的实现归属 |
|---|---|---|
| 依赖未完成 | 维持等待，不消耗执行重试 | **无错误码**：由 `blockedBy` 门挡在 `todo`（`team-hub/server.mjs:2980`） |
| 节点未就绪或 provider 不匹配 | 发布/认领前给出具体配置原因；修正后再调度 | `AGENT_NODE_NOT_READY` / `AGENT_NODE_PROVIDER_INCOMPATIBLE`（`:6531-6541`、`:2750`） |
| 认证缺失或失效 | 停止该 Attempt，提示在执行节点修复认证，不索取并记录密钥 | `AUTH_FAILED`（`runtime/contracts/model-probe.mjs:48,161`） |
| 权限配置与工具能力不兼容 | 拒绝启动并报告冻结权限与节点能力差异 | `permission-denied`（`orchestrator/state-machine/failure.mjs:49`）+ 派工前能力比对（`plugins/src/index.ts:2562-2578`） |
| Agent 有明确失败结果 | 保存报告、退出原因和工作区；按策略有限重试或进入人工处理 | 阶段 Attempt `failed`（`server.mjs:5289`），重试由 `failure.mjs:19-125` 分类 + 上限默认 5（`run-store.mjs:1098,1172`） |
| 验收失败 | 用 Gate 证据创建有明确返工目标的新 Attempt | **不是失败类**：走 typed review 返工（`server.mjs:5022-5220`），且**不设轮数上限** |
| 取消请求尚未确认 | 显示正在取消；确认底层停止前不能释放占用或标记取消完成 | 写入预约态 `reconciling`（`team-hub/write-intent-store.mjs:19-25,451-475`）+ `confirm-stopped` 人工确认（`routes/write-intent.mjs:172-181`） |
| Worker/节点在执行中断开 | 标记结果待核对；核实旧进程和副作用后再决定续做 | 阶段 Attempt 置 `unknown` + `stop_reason='worker-restarted'`（`server.mjs:6984-6999`）；`unknown` 不可回 `running`（`:5306`） |
| 文件冲突或集成失败 | 保留隔离工作区和提交，串行集成（在候选合并提交上验证）或交由人工处理 | 集成 worker + 同仓唯一活跃 job 约束（`delivery-store.mjs:93,268-269`）；默认 `legacy` |

**读法提醒**：这张表里的分类**分散在四层**（运行状态机、team-hub 任务/Attempt、写入预约、集成 worker），不是一处集中的错误码体系。设计若要"按失败类型决定重试"，需要先决定是否把它们收敛成一套具名码；今天能做到的是"每一类都有归属"，不是"每一类都有同一个出口"。

**2026-10-27 决策：保持分层 + 只读归一化（方案 B）**。数据面各自权威，新增纯函数 `failureKindOf()`（`orchestrator/state-machine/failure-kind.mjs`）把四层读数映射成面向用户的类别；它**不查库、不写库**，回退成本为零。两条红线：

- **依赖未完成**（`waiting`）与**验收返工**（`rework`）**不是失败**——做成失败会让"等上游"进重试计数器，也会把流程正常工作显示成出错；
- 指标失败率的**分母包含**它们（它们是样本），**分子只算真失败**；空样本返回 `available:false`，不返回 0。

详见[决策记录](../review/decisions-2026-10-27.md) §6。

恢复不能简单等同于“重新发送同一 prompt”。恢复前核对冻结版本、工作区、已有副作用、原生 Run identity、未收事件和实际进程状态。（逐项查法与决策表见[恢复核对清单](../review/recovery-checklist-2026-10-27.md)。）

## 12. 权限和上下文隔离

- 共享工具与技能按空间授权；各阶段只获得其工作所需工具。
- 阶段提示、岗位规则和共享项目材料分层组织。
- 阶段输入显式列出上游产物及版本摘要；不默认广播其他 Agent 的全部会话。
- Claude/Codex 原生认证与 DSH 凭据引用留在执行节点；Hub 和普通 Attempt 日志只存非秘密的工具配置引用。
- 权限配置快照、节点上报能力和操作系统实际隔离分别记录；provider 自报能力不代替文件访问或 worktree 验证。
- 有影响的动作按 Legion 的任务、权限和审计边界处理；CloudCLI 常驻会话中的特殊权限策略不直接照搬。
- 引入跨 Agent 工具时，明确工具能读、写、执行、联网和访问的范围。

## 13. 指标与完成定义

目标是让运行更可理解、交付更可信，而非单纯增加并行 Agent 数。建议从现有事件中计算：

- 目标完成率及每阶段通过率；
- 阶段等待、执行、验证和集成耗时；
- 首次验证通过率、返工轮数与返工原因；
- 节点/provider 启动失败率和 unknown 结果数；
- 需要用户介入的次数与原因；
- 隔离工作区到集成分支的交付率；
- 每个完成交付的 Agent/模型用量（仅当 provider 提供可靠读数）。

指标必须保留样本范围和时间区间；未知成本不应显示为零。

**现状**：仓库/交付维度已有只读端点 `GET /api/metrics/repository?repoId=`（`team-hub/routes/metrics.mjs:76-89`），读数不可用时显式返回 `available:false` 而非 0——这条纪律已兑现，可作为其余指标的模板。**目标级编排指标（完成率、阶段耗时、首次通过率、需用户介入次数）尚无实现**。

一处需要修正的口径：`postIntegrationValidationFailureRate` 统计的是 `VALIDATION_FAILED`（`metrics.mjs:56-60`），而该验证发生在**候选合并提交上、fast-forward 之前**，所以它的名字读起来像"集成后失败率"，实际是"集成前候选验证失败率"。指标命名应与时点一致。

## 14. 交付顺序

此前讨论中，优先方向已确定为先跑通现有工作流，再补齐执行详情与恢复；持续设计对话和外部 MCP 控制不是首阶段重点。本设计沿用这一优先级。

原 ✅／🔧 标记按 2026-10-26 的代码现状重标：**已完成** = 今天可用；**部分** = 数据面/配置面有、目标入口没有；**待建** = 尚无实现。逐条对应 §0 表。

### 阶段一：可理解的发布计划与执行者确认

- 发布目标入口明确默认流水线、自定义 DAG 与自动运行的关系。｜**部分**：目标文案/分配模板/节点已有；"默认流水线 vs 自定义 DAG"的关系界面上仍未解释（`GoalModal.tsx:112-132`）。
- 展示计划图和依赖解释，支持采用、选择已有版本或进入高级编辑。｜**待建**。
- DAG 各阶段显示 Agent 工具、适配器、模型（适用时）、节点和就绪状态。｜**部分**：配置页有前三项与节点；发布面无；adapter 在界面不出现；就绪度是面板级而非每阶段。
- 发布前检查配置和权限一致性；目标发布后能查看被冻结的执行选择。｜**已完成（数据面）**：发布即校验节点与能力（`server.mjs:2739-2762`、`:6376-6398`），冻结四列可读（`:2869-2877`）；**界面只呈现为任务详情里的"流程版本"，无专门入口**。

### 阶段二：真实运行详情与事件补读

- 任务详情清楚区分冻结选择与实际 Attempt。｜**部分**：两块各自可见、无并排对照（`TaskDetailModal.tsx:472-528`）。
- 将可取得的原生 provider Run/Thread 标识、节点、事件和产物关联起来。｜**部分**：Run ID 与节点已关联（`:507-514`）；**运行事件未关联**（`run_events` 未开放，见 §10）。
- 补齐断线事件补读、去重和时间线摘要。｜**已完成（机制）**：持久 seq + 游标回放（`server.mjs:8321-8343`）；**待建**：时间线摘要与弹层内实时更新。
- 明确显示 needs input、blocked 和 unknown 的不同含义。｜**部分**：`unknown` 已显示"结果未知，待核对"（`:508`）；needs input 仍靠 ❓ 评论推断，无独立标识。

### 阶段三：独立 Gate、Fan-in 和有界恢复

- 检查验收判据与运行产物/代码版本绑定。｜**已完成**：测试回执绑定提交 SHA（`server.mjs:5347-5373`）。
- 明确失败分类、有限重试、返工路径和人工升级。｜**部分**：分类器与重试上限在运行层（`failure.mjs`、`run-store.mjs:1098`）；返工**不设上限**（§9）；四层归属未收敛（§11）。
- 完成合入后复验和证据关联。｜**部分**：验证在候选合并提交上（合并前）；默认 `legacy`（`integration-worker.mjs:202-253`、`legacyConvergence.ts:28-31`）。
- 对 unknown、取消和守护重启加强现场核对规则。｜**已完成**：`unknown` 不可回 `running`（`server.mjs:5306`）、重启批量置 `unknown`（`:6984-6999`）、`confirm-stopped` 人工确认（`routes/write-intent.mjs:172-181`）。

### 阶段四：持久设计会话与外部控制评估

- 评估设计伙伴的 Session 与现有 Goal/Workflow/Attempt 如何关联及恢复。｜**待评估**（无实现，符合预期）。
- 按 Provider 能力明确 Claude/Codex 会话恢复是否真实可用。｜**待评估**。
- 如有真实需求，再定义外部 MCP 只读查询和写操作；重用 Hub 权限与审计。｜**待评估**。

**由此得到的两条修正**：① 阶段一真正的工作量在"发布面"，不在"配置面"；② 阶段二的投资回报最高的一项不是补采集，而是给已有的 `run_events` 加只读出口。

前一阶段的完成证据应作为后一阶段输入。每阶段先盘点并核验现有实现，明确需要补齐的差距，再决定具体实现工作；本文件本身不等于代码实现授权。

## 15. 验收场景

括号内为 2026-10-26 的可达性判定。

1. 新用户输入目标后能看到可读计划，理解阶段顺序、并行和汇合原因。｜**不可达**（依赖 §4.1 计划预览）
2. 发布前能区分空间默认流水线、自定义 DAG 与自动执行是否启用。｜**不可达**（发布面无编排模式概念）
3. 每个阶段能确认计划使用的 Agent/provider、适配器、模型和执行节点；执行不可用时有具体原因。｜**不可达**（发布面无阶段卡片；配置页有部分字段）
4. 发布后能查看冻结选择，运行后能查看实际 Attempt provider、节点、原生 Run ID（若有）和终态。｜**可达**
5. 配置为 Codex 而实际未启动时，页面不能显示“Codex 已执行”；结果 unknown 时不能自动宣告失败或成功。｜**可达**（`TaskDetailModal.tsx:507-511`）
6. 用户刷新或短暂断线后可以从已有记录恢复目标进度与事件时间线，不重复派工或重复展示事件。｜**部分可达**（seq/游标机制在，投递账本会跳过终态帧，见 §10）
7. Agent 自报完成但 Gate 失败时，目标不应显示交付完成，返工任务能指向具体失败证据。｜**可达**（typed review + 返工任务带 finding）
8. Fan-in 后测试必须关联集成后的确切代码版本。｜**部分可达**：版本绑定在**候选合并提交**上；合入后无再次验证（§9 第 6 条）
9. 取消请求、实际停止和最终状态分别可见；旧进程未核实前不释放工作区占用。｜**部分可达**：写入预约的 `reconciling`/`confirm-stopped` 已实现，但 `confirm-stopped` 不写 audit，时间线上看不到
10. 持续执行关闭时，任务计划仍可保存；页面清楚说明任务不会自动开跑。｜**可达**（发布与自动执行已解耦）
11. 关键结论能够追溯到阶段、Attempt、产物和验证证据。｜**部分可达**（数据面齐全；UI 无三时点对照视图）

## 16. 尚待确认的产品决策

当前明确的用户诉求是把此会话的 Grok 理念与 CloudCLI/Quay 研究合并为中文设计、带图；此前已确认首阶段优先跑通工作流并补齐执行详情与恢复；DAG 推荐计划和阶段执行者都需要直观呈现。

以下项目仍应作为后续决策处理：

- DAG 推荐计划是默认自动生成，还是仅在用户选择“帮我规划”时触发；
- **编排模式（`pipeline` / `custom-dag`）是否需要曝光给用户**：它现在只能由 API 调用方指定；若曝光，`custom-dag` 的并行/汇合与 `pipeline` 的线性链必须同时讲清，否则用户画了拓扑却看不到效果；
- **返工不设上限后，如何防"反复不通过"**：今天依赖必改项必须走完实现与审查，代价是无自然收敛点——需要决定是否改用"人工升级阈值"而非"自动停止"；
- 可见阶段状态映射是否采用本设计中的具体标签（特别是是否需要引入「草拟中」这类新目标态）；
- 第一阶段事件需要展示哪些 provider 活动，以及**是否开放 `run_events`**（它是已经落库的既有通道，取舍只在前端投影成本）；
- 失败分类是否收敛成单一具名码表，还是保持四层各自归属（三个候选方案与代价见[失败分类盘点](../review/failure-taxonomy-2026-10-27.md)）；
- Session 是否先限于设计阶段，以及哪些外部 Agent 能恢复原生会话（评估结论与"为什么现在不该建 Session"见[会话与 MCP 评估](../review/session-and-mcp-2026-10-27.md)）；
- MCP 外部控制是否纳入后续产品范围；
- 指标与 Agent 用量的具体保留周期、访问权限和脱敏策略。

## 17. 参考资料

- [Grok Bot 设计理念](https://x.ai/news/designing-grok-bot)
- [Grok Workflows](https://x.ai/news/workflows)
- [xAI Multi-Agent 文档](https://docs.x.ai/developers/model-capabilities/text/multi-agent)
- [CloudCLI 源码仓库](https://github.com/yaleh/claudecodeui)
- [CloudCLI 聊天运行架构](https://github.com/yaleh/claudecodeui/blob/develop/docs/architecture/README.md)
- [CloudCLI Provider 契约](https://github.com/yaleh/claudecodeui/blob/develop/server/modules/providers/README.md)
- [Quay 源码仓库](https://github.com/yaleh/quay)
- [Quay 任务模型与 Core](https://github.com/yaleh/quay/blob/master/packages/quay/README.md)
- [Legion 功能说明](../FEATURES.md)
- [Legion 外部 Agent 工具研究](../research/external-agent-tools-2026-09-30.md)
- [CloudCLI、Quay 与 Legion 讨论稿](../research/cloudcli-quay-legion-discussion.md)
- [本设计的代码核对报告（2026-10-26）](../review/legion-agent-orchestration-design-review-2026-10-26.md)
- [本设计的实施计划（2026-10-26）](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md)
- [软件流水线 × Agent 分配解耦设计（阶段集合由流水线决定）](2026-10-21-software-pipeline-agent-assignment-split.md)



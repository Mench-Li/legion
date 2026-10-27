# Agent 编排可观察性实施计划（v1）

日期：2026-10-26（2026-10-27 实施）
状态：**T1.1–T4.1 全部交付；§5 七项未决项已全部决策并落地**（见 §8 实施记录与[决策记录](../../review/decisions-2026-10-27.md)）
设计依据：[Legion 多 Agent 协同与执行可观察性设计 v1.1](../../design/legion-agent-orchestration-design.md)
现状证据：[设计核对报告](../../review/legion-agent-orchestration-design-review-2026-10-26.md)
语义前提：[软件流水线 × Agent 分配解耦设计](../../design/2026-10-21-software-pipeline-agent-assignment-split.md)（阶段集合由流水线决定）
基线：`6d688731`

## 0. 这份计划要解决什么

核对报告把设计文档的主张分成了三类：**代码已兑现**、**部分兑现**、**尚未实现**。本计划只处理后两类里"投入产出比最高、且不推翻现有语义"的部分。

一句话概括目标：**让用户在按下"发布"之前看得见会发生什么，在运行之后看得见实际发生了什么。**

两条硬边界，任何任务都不得突破：

1. **不新增第二套调度状态源。** 所有展示都读现有表（`goal`、`tasks`、`agent_workflow_stage_attempts`、`run_attempts`、`run_events`、`audit`），不建镜像表。
2. **不改变"阶段集合由流水线决定"（2026-10-21）的语义。** `custom-dag` 是既有出口，本计划只是给它一个 UI 入口，不恢复"具名定义决定阶段集合"的旧行为。

### 0.1 范围裁剪（必须先确认）

| 做 | 不做 |
|---|---|
| 发布前只读计划预览 | General 自动生成推荐 DAG（依赖模型规划能力，单独评估） |
| **执行者粒度两级：整目标一个 Agent／按节点分别指定** | 跨目标 Agent 池、按负载自动挑 Agent（那是调度优化，不是配置） |
| 编排模式（`pipeline` / `custom-dag`）UI 入口 | 重写 DAG 编辑器（已够用，见设计 §8.1） |
| 逐阶段执行者展示与就绪读数 | 每阶段实时就绪徽标（需要新的节点探测协议） |
| **`run_events` 只读出口接到 UI** | 新增运行事件采集（已采集，见 T2.1） |
| 三态（计划／冻结／实际）并排展示 | 自动偏差告警与自愈 |
| 取消确认、确认停止、验证判词入 audit | 统一四层失败分类码表（只做盘点，T3.2） |
| Session / MCP 评估 | 实现持久设计会话与外部 MCP 控制 |

### 0.2 为什么这个顺序（以及一个例外）

阶段一是设计的门面，所以排在最前。但需要提前说明：**全计划里投入产出比最高的其实是 T2.1（把 `run_events` 接到任务详情）**——数据已经落库、只读端点已经存在（`GET /api/runtime/run-events`）、缺的只有一次前端调用，而它一次性补上 provider 启动、工具失败、阶段进度三类可见性。

如果资源只够做一件事，做 T2.1，不要做阶段一。阶段一的价值在于"发布前不被误导"，T2.1 的价值在于"运行中不再黑箱"——后者今天的缺口更大。

### 0.3 两个正交维度，别塞进同一个下拉

发布目标时要问两件事，它们的答案互不影响：

| 维度 | 问的是 | 取值 | 现状 |
|---|---|---|---|
| **编排模式** | 阶段集合从哪来 | `pipeline`（来自流水线）／`custom-dag`（来自具名定义的拓扑） | 服务端有，UI 无入口（T1.3） |
| **执行者粒度** | 每个阶段由哪个 Agent 跑 | ①整目标一个 Agent ②按节点分别指定 ③沿用空间/模板配置 | 只有 ③ 可用（T1.5、T1.6） |

把这两件事合成一个"工作流"下拉，会让用户以为"选了某个 Agent 就改了阶段"——而且它们恰好分别对应本仓已经踩过的两个坑（T-212 阶段凭空消失、节点绑定后"任务不动"）。界面上必须是**两个独立的控件**，文案各自说清"它改变什么、不改变什么"。

### 0.4 执行者分配的五层优先级

`resolveAssignments()` 的注释里已经预留了第 4 层"发布时显式覆盖（本版未开放）"（`orchestrator/assignment/index.mjs:147-159`）。本计划把它和新的目标级 Agent 一起落地，最终优先级从高到低：

| 层 | 来源 | 作用域 | 状态 |
|---|---|---|---|
| 1 | **发布时按节点覆盖** | 本目标本次发布 | 待建（T1.6） |
| 2 | **目标级 Agent** | 本目标本次发布 | 待建（T1.5） |
| 3 | 分配模板 `stageTools[role]`（具名定义／空间闭环配置） | 空间可复用 | 已有 |
| 4 | `space_stages.agent_tool_config` | 空间阶段默认 | 已有 |
| 5 | DSH 默认（`dsh-default`） | 全局 | 已有 |

一句话：**同一次发布里，越具体的选择越优先；本目标的显式选择优先于可复用的模板与空间默认。**

每条分配都要带 `source`，UI 据此显示「本节点覆盖／继承目标级／模板／空间默认／DSH 默认」——否则用户看到的是一张"全是 Agent 名"的表，看不出自己的选择有没有生效。

---

## 1. 阶段一：发布计划与执行者确认

目标：发布弹窗从"输入目标 + 选模板"升级为"看见阶段、看见执行者、看见风险、再确认"。

### T1.1 只读计划端点 `POST /api/goal/plan`

**问题**：今天没有任何 dry-run 入口。`publishGoalRecord()` 边算边写，用户只有发布后才在回执里看到 `frozen`（`team-hub/server.mjs:2869-2877`）。于是"预览"只能靠前端自行拼装，必然与后端不一致。

**Files**
- `team-hub/server.mjs`：把 `publishGoalRecord` 里的规划段（`:2691-2762`）抽成不写库的 `previewGoalPlan({ scope, objective, mode, workflowDefinitionRef, agentNodeId, orchestration, agentToolConfig, stageOverrides })`，返回 `{ orchestration, pipelineVersion, stages[], assignments, review, effectiveNodeId, agentToolConfig, warnings[], blockers[] }`；`publishGoalRecord` 改为调用它。
- `team-hub/routes/goal-lifecycle.mjs`：新增 `POST /api/goal/plan`（**只读**：不进 `handleWrite` 的事务写路径，但仍走鉴权与 scope 解析）。
- `team-hub/goal-plan-routes.test.mjs`（新建）：路由层单测。

**请求体形状**（与 `POST /api/goal` 保持同名同义，前端只改一个 URL）：

```jsonc
{
  "objective": "…",
  "mode": "chain",
  "orchestration": "pipeline",              // pipeline | custom-dag
  "agentToolConfig": { "id": "tool.codex", "version": 1 },   // 目标级，可空（T1.5）
  "stageOverrides": { "reviewer": { "agentToolConfig": {…}, "modelConfig": null, "nodeId": null } },  // 按节点，可空（T1.6）
  "agentNodeId": null
}
```

**实现纪律**
- 预览与发布**必须调用同一个函数**。两份实现会在"恰好一致"的配置上看不出区别，只在第一次不一致时表现为"预览说行、发布 409"。
- `blockers` 与 `warnings` 分开：前者对应发布必然失败的条件（节点未就绪、能力不匹配、跨节点冲突、隔离关闭、审查闭环缺 testRunner），后者对应 `planGoal()` 已产出的 `PLAN_WARNINGS`（`orchestrator/assignment/index.mjs:49-56`）。
- 端点**永不写库**，包括不写 audit。用不着 `dryRun` 参数——它没有副作用分支，加一个开关反而引入"忘了传就写库"的风险。
- 响应里的 `assignments[role].source` 必须原样返回（`goal-agent` / `publish-override` / `definition` / `space-review-workflow` / `space-stage` / `dsh-default`），UI 靠它解释"这一环为什么是这个 Agent"。

**验收**
- 单测：同一输入下 `POST /api/goal/plan` 的 `stages/assignments/effectiveNodeId` 与随后 `POST /api/goal` 回执的 `frozen` 逐字段相等。
- 反例守卫：计划端点被调用后 `goal` 表行数不变、`audit` 无新行。
- 反例守卫：配置了跨节点绑定时，plan 返回 `blockers` 且 `POST /api/goal` 仍以同一 code 409（证明两条路径同源）。

### T1.2 发布弹窗的计划预览

**Files**
- `workbench/src/components/GoalModal.tsx`：在目标文案与执行节点之间插入阶段卡片列表。
- `workbench/src/goalPlanView.ts`（新建，纯函数）：把 plan 响应投影成卡片模型（含"读数缺失"与"已知不就绪"的三态区分）。
- `workbench/scripts/goal-plan-view.test.mjs`（新建）。

**卡片字段**（对应设计 §4.3）：阶段名与岗位、Agent 工具（显示 `DSH / Claude Code / Codex` + 配置 id@version）、模型（仅 `dsh-native` 适用时显示，否则「不适用」）、执行节点、就绪状态、输入/输出摘要、依赖。

**每行末尾必须显示这一环"为什么是它"**（来自 `assignments[role].source`）：

| source | 显示 | 用户能做的 |
|---|---|---|
| `publish-override` | `本节点指定` | 清除即回落下一层 |
| `goal-agent` | `继承目标级` | 在主开关处改一次，全链跟着变 |
| `definition` / `space-review-workflow` | `分配模板：<名称>` | 去掉模板或逐节点覆盖 |
| `space-stage` | `空间阶段默认` | 去设置页改 |
| `dsh-default` | `DSH 默认` | 选中即可覆盖 |

没有这一列，用户改完看不出生效没有——而"看起来生效了、其实被上层覆盖"正是这类配置最常见的挫败来源。

**实现纪律**
- `adapter`（`dsh-native` / `dsh-subagent`）**默认不显示**：界面上今天不存在这一档，突然加一列会让用户看到自己从未选择过的字段。放到卡片的"技术详情"折叠里。
- 就绪三态必须区分：`ready` / 有读数但不就绪（附修法）/ **还没有读数**（不等于不可用）。后者是 `AgentWorkflowConfigurator.tsx:622-653` 已确立的口径，照抄，不要重新发明。
- 依赖关系用"等待 N 个前驱"的文字，不画连线。默认 `pipeline` 是线性链，画图会暗示并行。
- 目标级 Agent 选好后，卡片上的 Agent 一栏应显示**同一个值并标注"继承"**，而不是每行显示成"用户逐个选过"。

**验收**
- 纯函数单测：无读数不渲染成"不可用"；不就绪必须带原因；未知状态不显示为绿色。
- 纯函数单测：六种 `source` 各自渲染为对应文案；目标级生效时每行都标"继承目标级"。
- 浏览器复核：发布弹窗在窄屏（≤430px）不横向溢出。

### T1.3 编排模式与 `custom-dag` 入口

**问题**：服务端支持 `orchestration: 'custom-dag'`（`team-hub/routes/goal-lifecycle.mjs:77`、`team-hub/server.mjs:2715-2719`），但 `workbench/src/api.ts:327-334` 不发送该字段，App 层 `mode` 恒为 `undefined`。用户在 DAG 编辑器里画的拓扑永远不会进入目标链。

**Files**
- `workbench/src/api.ts`：`publishGoal` 增加 `orchestration` 与 `mode` 参数（保持向后兼容：缺省不发送）。
- `workbench/src/components/GoalModal.tsx`：编排模式二选一；选 `custom-dag` 时切换为"选择具名定义 + 版本"，并禁用依赖自动节点的部分逻辑。
- `workbench/src/App.tsx`：透传 `orchestration`。
- `workbench/scripts/goal-modal-orchestration.test.mjs`（新建）。

**实现纪律**
- `custom-dag` 的前置条件必须在 UI 上拦住并说明：**必须** `mode === 'chain'`、**必须**有具名定义（`server.mjs:2635`、`:2716-2719`）。否则用户会看到一条服务端 400。
- 默认值仍是 `pipeline`。切换模式时**不重置**已填的目标文案。
- 文案必须点明差异：`pipeline` = 阶段来自流水线、定义只作分配模板；`custom-dag` = 按定义拓扑建链（可并行／汇合）。

**验收**
- 单测：默认不发送 `orchestration`（保持旧行为）；选 `custom-dag` 且无定义时提交按钮禁用并给出原因。
- 集成：`custom-dag` 发布后，目标的任务 `blockedBy` 与定义 `edges` 一致；`pipeline` 发布后仍是相邻边单链。

### T1.4 冻结结果可见 + 三态第一版

**Files**
- `workbench/src/components/TaskDetailModal.tsx`：在现有「流程版本」区上方加"发布冻结"摘要（流水线版本、各岗位分配来源、审查闭环、绑定节点）。
- `workbench/src/goalFrozenView.ts`（新建，纯函数）：把 `goal.pipeline_snapshot / assignment_snapshot / workflow_snapshot` 与任务 `agentSelectionSnapshot` 投影成三列。
- `workbench/scripts/goal-frozen-view.test.mjs`（新建）。

**实现纪律**
- 三态**只做并排展示，不做偏差推断**。判断"计划 A 实际跑 B"需要定义什么算偏差（同 id 不同版本？同版本不同节点？），那是产品决策，不在本计划。
- 缺数据必须显示「未记录」而非空白或推测值。
- `source` 字段要如实展示：`goal-agent-workflow` / `goal-node-binding` / `space-pipeline` 三者的语义不同（`server.mjs:5890,5910,6477`）。
- 三态里的"计划"一列必须带每个阶段 assignment 的 `source`（§0.4），否则用户无法解释"为什么冻结下来是这个 Agent"。

**验收**
- 纯函数单测：三类 `source` 各自渲染；`providerRunId` 为空时显示「Provider 未提供 Run ID」而不是隐藏该行。
- 纯函数单测：`goal-agent` 与 `publish-override` 两类新 source 的文案正确。
- 老目标（`orchestration` 为 NULL）不报错，显示「本列上线前发布」。

### T1.5 目标级 Agent：整条目标由一个 Agent 完成

**要的体验**：用户在发布弹窗里选「本目标由 Claude Code 执行」，此后流水线上每一个阶段都用它——不必逐节点重复选八次。

**现状缺口**：`goal` 表只有 `agentNodeId`（`team-hub/server.mjs:2037`），**没有任何目标级 Agent 工具配置**。今天要让整条目标用同一个 Agent，只能在配置页把八行阶段逐一改一遍，而且改动是**空间级**的——会影响之后所有目标。这正是"我只想让这一个目标用 Codex"做不到的原因。

**Files**
- `orchestrator/assignment/index.mjs`：
  - `ASSIGNMENT_SOURCES` 增加 `GOAL_AGENT: 'goal-agent'`；
  - `resolveAssignments({ stages, profile, profileSource, goalAgent = null })` 插入该层（优先级见 §0.4）：
    ```js
    const agentRef = stageTool?.agentToolConfig ?? goalAgent?.agentToolConfig ?? stage.agentToolConfig ?? null
    const modelRef = stageTool?.modelConfig ?? goalAgent?.modelConfig ?? stage.modelConfig ?? null
    const nodeId   = stageTool?.nodeId ?? goalAgent?.nodeId ?? null
    const testRunner = stageTool?.testRunner ?? null        // ★ 目标级**不提供** testRunner
    const source = goalAgent !== null ? ASSIGNMENT_SOURCES.GOAL_AGENT : (fromProfile ? source : …)
    ```
  - `planGoal()` 透传 `goalAgent`。
- `team-hub/server.mjs`：
  - `ensureColumn('goal', 'agent_tool_config', "agent_tool_config TEXT DEFAULT NULL")`（与 `agentNodeId` 并列，幂等补列）；
  - `publishGoalRecord` / `previewGoalPlan` 解析 `agentToolConfig`，**按引用校验**（存在、启用，`harnessStoreForDispatch().getAgentToolConfig`），不存在即 409 `AGENT_TOOL_CONFIG_UNRESOLVED`（复用既有 code）；
  - 冻结时写进 `goal.agent_tool_config`，并把每阶段的解析结果进 `assignment_snapshot`（已有结构，`source` 自动变成 `goal-agent`）。
- `team-hub/routes/goal-lifecycle.mjs`：读 `body.agentToolConfig`。
- `team-hub/goal-orchestration.test.mjs`：追加用例。

**实现纪律（每一条都是会咬人的）**

1. **testRunner 不可被目标级提供。** 目标级只决定"谁执行"，不决定"用什么命令验证"。若允许它带 testRunner，"整目标一个 Agent"会顺手覆盖掉实现阶段的独立测试命令——那正好废掉本仓最硬的一条证据链（`server.mjs:5347-5373`）。配了审查闭环时，`testRunner` 仍必须来自模板/空间配置，否则照旧 400 `AGENT_PLAN_TEST_RUNNER_MISSING`。
2. **外部 Agent 与模型覆盖互斥。** `resolveFrozenAgentModelConfig()` 对 `adapter !== 'dsh-native'` 直接抛 `AGENT_MODEL_CONFIG_UNSUPPORTED`（`server.mjs:6299-6305`）。所以目标级选 Claude Code / Codex 时，任何阶段级 `modelConfig` 都必须清空或明确拒绝——**不能静默丢掉用户的模型选择**。
3. **节点能力校验从"个别阶段"升级为"全链"。** 每阶段都会比对 provider／能力位／权限模式（`server.mjs:6376-6398`）。目标级选外部 Agent ⇒ **八个阶段全部**要求该 provider 在节点就绪。原本只在一两个阶段用外部 Agent 的空间，门禁会突然变严；这必须作为 `blockers` 在预览里说清，而不是等发布 409。
4. **workspacePolicy 约束全链生效。** 外部 Agent 必须 `attempt-worktree-parent-cwd` + 独立 worktree（`plugins/src/index.ts:2564-2568`）。整目标用它意味着**每一环都要独立 worktree**，磁盘与清理成本按阶段数线性增长。预览里要显示"将创建 N 个独立工作区"。
5. **审查独立性下降，必须提示而不是隐瞒。** 整目标同一 Agent 时，design / implementation / review 由同一个 provider 完成 = **自审**。测试回执仍由 Legion 独立跑（这条不变），但"语义审查来自另一个 Agent"这个前提没了。UI 上要如实写一句，不阻止用户选，只让他知道代价。

**验收**
- 单测：目标级指定 Agent 后，`assignments[*].source` 全部为 `goal-agent`，且 `stageTools` 里的同名阶段仍能覆盖它（验证 §0.4 的相对优先级）。
- 单测：目标级选外部 Agent + 某阶段带 `modelConfig` ⇒ 明确的 400/409 与原因，而不是静默忽略。
- 单测：目标级不改变 `testRunner` 来源；配了审查闭环且模板缺 testRunner 时仍然拒绝发布。
- 反例守卫：目标级引用了不存在的工具配置 ⇒ 发布拒绝，且**不留半条链**（`goal` 表无新行）。
- 冻结：发布后 `goal.agent_tool_config` 与每个任务快照里的 `agentToolConfig` 一致，且目标后续被新空间配置影响时不变。

### T1.6 按节点指定：发布时逐阶段覆盖

**要的体验**：另一个目标里，用户想让「需求澄清用轻量模型、编码用 Claude Code、审查用 Codex」——在发布弹窗里逐个节点选，只影响这个目标。

**现状**：这条路**部分可用**，但入口不在发布弹窗：
- 空间级逐阶段：配置页「阶段由谁执行？」写进 `space_runtime.review_workflow.stageTools[role]`（`AgentWorkflowConfigurator.tsx:333-346`），或经 `POST /api/pipeline` 写 `space_stages.agent_tool_config`（`routes/space-config.mjs:117-121`）；
- 模板级：具名定义里的 `stages[].agentToolConfig`，发布时选它即生效。
- **缺的是"只对本次发布生效"的那一层**——`resolveAssignments()` 注释里预留的第 4 层（`orchestrator/assignment/index.mjs:154`）。

**Files**
- `orchestrator/assignment/index.mjs`：`ASSIGNMENT_SOURCES` 增加 `PUBLISH_OVERRIDE: 'publish-override'`；`resolveAssignments({ …, stageOverrides = null })` 按 §0.4 置于最高层。
- `team-hub/server.mjs`：`publishGoalRecord` / `previewGoalPlan` 接收并校验 `stageOverrides`（role 必须在本链上、引用必须可解析）。
- `workbench/src/components/GoalModal.tsx`：计划卡片每行加「改为…」下拉；默认不展开（避免把简单场景复杂化）。
- `workbench/src/goalPlanView.ts`：把 `source` 投影成可读文案（§0.4 末段）。
- `workbench/scripts/goal-plan-view.test.mjs`：追加。

**可覆盖与不可覆盖（这条界线要写死）**

| 字段 | 发布时可否覆盖 | 理由 |
|---|---|---|
| `agentToolConfig` | ✅ | 这正是本任务的目的 |
| `modelConfig` | ✅（仅 `dsh-native`） | 外部分支不支持，见 T1.5 纪律 2 |
| `nodeId` | ⚠️ 可填，但**全链必须一致** | 跨节点交接未实现，多值即 409（`server.mjs:2739-2741`）；UI 应在选第二个不同节点时就红 |
| `testRunner` | ❌ **只读** | 让发布弹窗随手改独立测试命令，等于允许"把验收改成永远通过"。要改请回配置页改模板。 |

**实现纪律**
- 覆盖项**逐字段独立**：只覆盖 `agentToolConfig` 时，`modelConfig` / `nodeId` 仍按低层解析，不要整条替换。
- 空对象 `{}` 不等于"清空"，等于"没覆盖"。要清空某字段得显式 `null` 并说清语义——否则一次"点了下拉又取消"会静默改掉配置。
- 覆盖结果必须进 `assignment_snapshot`，这样冻结后仍能回答"这一环是谁改的、改成什么"。

**验收**
- 单测：仅覆盖 `agentToolConfig` 时其余字段不变；`stageOverrides` 里的未知 role 被忽略并告警（复用 `PLAN_WARNINGS.PROFILE_STAGE_UNKNOWN`）。
- 单测：两个阶段填不同「节点」⇒ 预览即返回 blocker 且发布 409（同一 code）。
- 集成：`publish-override` 与 `goal-agent` 同时给时，前者胜出（§0.4 第 1 层 > 第 2 层）。
- 反例守卫：`stageOverrides` 试图塞 `testRunner` 时必须被拒绝，而不是静默忽略——静默忽略会让用户以为自己改了。

---

## 2. 阶段二：运行详情与事件

目标：把已经存在但看不见的东西接上，并补齐三处事件缺口。

### T2.1 `run_events` 接到任务详情 ★最高性价比

**问题**：`run_events` 按 `(attempt_id, event_seq)` 落库（`team-hub/run-store.mjs:485-497`），含 `run.started`、`tool.*` 等 13 类；只读端点 `GET /api/runtime/run-events` 已存在（`team-hub/routes/runtime-verification.mjs:163-196`），**但 workbench 从未调用**。于是 provider 启动、工具失败、阶段进度在界面上完全不可见。

**Files**
- `workbench/src/api.ts`：新增 `fetchRunAttempts(taskId)`（走 `GET /api/runtime/attempt?taskId=`，`routes/task-lifecycle.mjs:142-145`）与 `fetchRunEvents(attemptId, { type, limit })`。
- `workbench/src/components/TaskDetailModal.tsx`：在「Agent 实际运行记录」的每条阶段 Attempt 下加"运行明细"折叠区。
- `workbench/src/runEventsView.ts`（新建，纯函数）：13 类事件的展示映射与聚合。

**实现纪律**
- 必须透出 `known: false`（上游产生了控制面不认识的事件）。过滤掉它会让"上游新增了事件但我们不记"与"上游什么都没产生"长得一样——这是该端点存在的理由（`runtime-verification.mjs:176-178`）。
- 事件可能很多：默认只显示计数摘要（`counts=1`），点开才拉正文，`limit` 用默认 1000。
- 两个 Attempt 概念不要混：`agent_workflow_stage_attempts`（阶段尝试）与 `run_attempts`（运行尝试）ID 空间不同，UI 必须分组显示并写清"阶段 Attempt → 运行 Attempt"的对应关系。
- 敏感值不入前端：事件里若有凭据形态的字段，按 `run-events` 既有脱敏口径处理，不在前端二次加工。

**验收**
- 单测：未知事件类型渲染为「未识别事件（known=false）」而不是丢弃；空事件集显示「本次运行没有记录到事件」，与「读取失败」区分。
- 反例守卫：拉取失败时不得显示成"0 条事件"。

### T2.2 时间线摘要与实时性

**Files**
- `workbench/src/components/TaskDetailModal.tsx`：时间线加按 Attempt 分组的折叠摘要。
- `workbench/src/timelineSummary.ts`（新建，纯函数）。
- `workbench/scripts/timeline-summary.test.mjs`（新建）。

**实现纪律**
- 弹层当前**不是实时的**（只在挂载/操作后 fetch，`:215`）。本任务**不引入弹层内的 SSE 订阅**——那会与全局 `/api/events` 的单流纪律冲突。改为：弹层打开期间复用 App 层已有的 SSE 事件，仅对"属于本任务"的事件做增量追加。
- 摘要优先级：状态变更 > 审查／返工 > 补丁／证据 > 进度心跳。心跳不得淹没关键事件。

**验收**
- 单测：同一 task 的 200 条事件能压成 ≤8 条摘要，且关键事件一条不丢。
- 去重：同一 `seq` 的事件经 SSE 与首拉各到一次时只显示一次。

### T2.3 needs-input 具名化（不新增状态）

**问题**：今天"待用户决定"是 `blocked` + 最后一条评论以 `❓` 开头（`plugins/src/index.ts:3306-3309`、`plugins/src/stateMachine.ts:146-153`）。判定逻辑散落在 UI 两处（`TaskDetailModal.tsx:135-141`、`TaskCenterView.tsx:199`），没有单测守卫。

**Files**
- `workbench/src/waitingOnUser.ts`（新建，纯函数）：`isWaitingOnUser(task)`。
- `workbench/src/components/TaskDetailModal.tsx`、`TaskCenterView.tsx`：改用该纯函数。
- `workbench/scripts/waiting-on-user.test.mjs`（新建）。

**实现纪律**
- **不新增任务状态**。设计原则 4 与现有数据面都不允许。若将来要独立状态，先改设计文档再改代码。
- 保持与"已答复即解除"的现有语义一致（`stateMachine.ts:152-153`）。

**验收**
- 单测：`❓` 在首条／末条／中间三种位置；答复后解除；空评论不误判。

### T2.4 补齐三处事件缺口

**问题**：设计 §10 要求的时间线里有三类事件**根本不进 audit**：

| 缺口 | 现状 | 位置 |
|---|---|---|
| 确认停止 | 路由全程不写 audit | `team-hub/routes/write-intent.mjs:172-186` |
| 取消请求 | 只有 `budget.cancel-requested`，且其 `taskId` 列被填成 attemptId | `server.mjs:1231-1232` |
| 验证判词 | 只在 `run_validations` | `team-hub/run-store.mjs:2583-2610` |

**Files**
- `team-hub/routes/write-intent.mjs`：`confirm-stopped` 成功后写 `audit(by, scope, 'write-intent:confirm-stopped', taskId, {...})`。
- `team-hub/server.mjs`：修正 `budget.cancel-requested` 的 `taskId` 列（填真实 taskId，attemptId 放 detail）。
- `team-hub/routes/runtime-verification.mjs`：`validate` 成功后写入一条轻量 `runtime:validation` 审计（只记结论与 attemptId，不复制证据正文）。

**实现纪律**
- 审计写成**追加**，不改变任何控制流；写失败不得阻断原操作（沿用现有 `try/catch` 纪律）。
- 不复制大块证据：判词只放结论、attemptId、时间，证据留在 `run_validations`。
- 修 `taskId` 列是**破坏性更正**：老行中该列存的是 attemptId。不要回填，只在查询侧容忍（两者都可能是 id），并在 detail 里明确字段名。

**验收**
- HTTP 测试：`confirm-stopped` 后 `/api/activity?taskId=` 能查到该事件。
- 反例守卫：审计写失败（模拟）时原操作仍返回成功。
- 兼容性：老数据里 `budget.cancel-requested` 行不导致 `/api/activity?taskId=` 报错。

---

## 3. 阶段三：Gate、Fan-in 与恢复口径

目标：不改行为，先把口径改对，再决定是否收敛。

### T3.1 修正"集成后复验"的命名与文案

**问题**：验证跑在候选合并提交上、fast-forward **之前**（`team-hub/integration-worker.mjs:202-216`），应用后只验 ancestor（`:250-253`）。但指标叫 `postIntegrationValidationFailureRate`（`routes/metrics.mjs:59-60`），UI 徽标写的是 `'🔁 集成后验证中'`（`workbench/src/deliveryBadge.ts:22`）。

**Files**
- `team-hub/routes/metrics.mjs`：新增 `preIntegrationCandidateValidationFailureRate`，旧字段保留并标注 deprecated。
- `workbench/src/deliveryBadge.ts`：`validating` 的 label 改为「🔁 合并前验证中」。
- 相关测试：`team-hub/metrics.test.mjs`、`workbench/scripts/delivery-ui.test.mjs`。

**实现纪律**
- **先加新字段，不删旧字段**。删字段会让外部消费方静默拿到 undefined，而"没有读数"与"0"必须区分（`deliveryBadge.ts:88-97` 已确立该纪律）。
- 若后续要真正的"合入后复验"，那是行为变更，另立任务（见 §5 未决项）。

**验收**
- 单测：新字段存在且与旧字段同值；旧的仍返回。
- 文档：`docs/FEATURES.md` §3.20 与设计 §9 同步。

### T3.2 失败分类盘点（只读，不改行为）

**问题**：设计 §11 的 9 类失败分散在四层（运行状态机、team-hub 任务／Attempt、写入预约、集成 worker），没有统一出口。

**Files**
- `docs/review/failure-taxonomy-2026-10-26.md`（新建）：逐类列出归属、具名码、可观测点、缺口。
- 不改代码。

**产出**：一张"设计表 ↔ 代码归属"的对照，并给出三个可选收敛方案（统一码表／保持分层但加映射层／不收敛），附代价。**决定由人做**，本任务只提供事实。

**验收**：文档里每个码都能被 grep 到定义处；每个设计分类都能指到代码位置或明确标"无实现"。

### T3.3 恢复路径的现场核对清单

**问题**：设计 §11 末尾只有一句"恢复前核对冻结版本、工作区、已有副作用、原生 Run identity、未收事件和实际进程状态"，没说**用什么查**。

**Files**
- `docs/review/recovery-checklist-2026-10-26.md`（新建）：把上述 6 项逐条映射到可查端点或命令。
- 设计文档 §11 末尾加一行指向该清单（一行，不复制内容）。

**验收**：清单里每一项都能在 `/api/activity`、`/api/runtime/attempt?taskId=` 或 `GET /api/runtime/run-events?attemptId=` 里查到；查不到的项必须标注"需人工"并写清人工怎么判。

---

## 4. 阶段四：评估（不实现）

### T4.1 持久设计会话与外部 MCP 的可行性评估

**Files**：`docs/review/session-and-mcp-2026-10-26.md`（新建）。

**内容**：Session 与 Goal/Workflow/Attempt 的关联方式；Claude Code / Codex 会话恢复是否真实可用（需按 provider 实测，不得由能力声明推断）；MCP 外部控制的权限与审计边界。

**验收**：结论必须区分"已实测"与"文档声明"，且给出不做会怎样。

---

## 5. 未决项 → **已全部决策**（2026-10-27）

七项均已定档，逐项理由与落地形态见 [决策记录](../../review/decisions-2026-10-27.md)。摘要：

| # | 议题 | 决定 | 状态 |
|---|---|---|---|
| 1 | 返工不设上限后如何收敛 | **B 连续同因升级** | ✅ 已实现（`rework-escalation.mjs` + Hub 分支） |
| 2 | 整目标同一 Agent 的审查独立性 | **A 接受并显式标注** | ✅ 已实现（`selfReview` 进预览/冻结/UI） |
| 3 | 是否要真正的"合入后复验" | **不做** | 决策定档 |
| 4 | 编排模式是否长期暴露 | **先暴露，用数据再定** | 决策定档（看 `goal.orchestration` 占比） |
| 5 | 目标级 Agent 是否升为空间级默认 | **不加**（改用配置页批量按钮） | 决策定档 |
| 6 | 失败分类是否收敛成单一码表 | **B 分层 + 只读归一化** | ✅ 已实现（`failure-kind.mjs` + 指标字段） |
| 7 | 指标保留/脱敏/权限 | **三条最小规则** | 决策定档 |

---

## 6. 验证与门禁

每个任务合入前必须：

- [ ] 新增／修改的纯函数有独立单测（`workbench/scripts/*.test.mjs` 或 `team-hub/*.test.mjs`）。
- [ ] 反例守卫至少一条：证明"看起来正常但其实错了"的情形会红。
- [ ] 文档同步：`docs/FEATURES.md` 对应小节、设计文档相关段落。
- [ ] 全套件注册到 `scripts/ci/run-ci.mjs`（若新增文件）。
- [ ] 编码门禁：`node scripts/ci/encoding-check.test.mjs` 通过（本仓历史上有中文乱码事故）。
- [ ] 涉及表格的文档：`node scripts/prt/doc-table-integrity.test.mjs` 不因本次修改新增失败。

> 备注：该门禁当前**已有 1 处既有失败**（`docs/superpowers/prt/PRT-PROGRESS.md:164`，表头 3 格 / 行 4 格），与本次工作无关。修法不是转义竖线，是换记号（`或` / 全角 `｜`）。

---

## 7. 完成判据

满足全部以下条目，可认为本轮交付完成：

1. **用户发布目标前，能在同一屏看到：阶段列表、每阶段执行者（工具 + 配置版本 + 模型或"不适用"）、执行节点、就绪三态、依赖关系，以及每行"为什么是它"的来源标注。**
2. **用户能在发布前二选一：整条目标由一个 Agent 完成，或按节点逐个指定；两者可叠加（逐节点覆盖优先），且只影响本次发布。**
3. 用户能在发布前选择 `pipeline` 或 `custom-dag`，且选 `custom-dag` 时前置条件不满足会被界面拦住并说明原因。
4. 计划预览的结果与发布后冻结的结果**逐字段一致**（同一函数产出），包括每阶段的 `source`。
5. 任务详情能展开某次运行的逐条事件，包括 provider 启动与工具失败；未知事件类型如实显示。
6. 任务详情能同时看到"计划选择 / 冻结配置 / 实际 Attempt"，缺数据显示「未记录」。
7. 取消确认、验证判词能在任务时间线上查到。
8. 上述每一项都有对应单测，且至少一条反例守卫。

不满足判据的常见自我欺骗（预先点名）：

- 模块写好了但**生产路径没调用**（本仓历史上出现过多次）——以"生产入口点开能看到"为准。
- 纯函数单测绿了但**没有接线**——每任务都要有 HTTP 或浏览器级证据。
- 把"读数缺失"渲染成默认值——任何缺失都必须是显式文案。

---

## 8. 实施记录

### 2026-10-27 首轮实施（T1.1–T4.1 全部交付）

基线 `6d688731`（工作区另有他人未提交改动，未触碰）。

#### 已交付

| 任务 | 交付物 | 关键判据 |
|---|---|---|
| **T1.1** 只读计划端点 | `resolveGoalPlan()` / `goalPlanPreview()` / `previewGoalPlan()`；`POST /api/goal/plan`（`routes/goal-lifecycle.mjs`，`envelope:null` 扁平响应） | `team-hub/goal-orchestration.test.mjs` 新增「预览与发布逐字段一致」+「预览不许新建目标/写审计」两条反例守卫 |
| **T1.5** 目标级 Agent | `goal.agent_tool_config` 列（幂等补列）；`ASSIGNMENT_SOURCES.GOAL_AGENT`；`resolveAssignments({ goalAgent })`；`assertPublishAssignmentLayers()` 校验引用与 adapter×模型互斥 | `orchestrator/assignment/index.test.mjs` ⑭⑰⑲；`goal-orchestration.test.mjs` 幽灵工具 409 且不留半条链 |
| **T1.6** 逐节点覆盖 | `ASSIGNMENT_SOURCES.PUBLISH_OVERRIDE`；`resolveAssignments({ stageOverrides })`；`PLAN_CODES.OVERRIDE_TEST_RUNNER` | ⑮⑯⑱：逐字段独立、显式 `null` 遮下层、`testRunner` 出现即拒绝 |
| **T1.2** 计划预览 | `workbench/src/goalPlanView.ts`；`GoalModal` 阶段卡片（含「为什么是它」来源列） | `workbench/scripts/goal-plan-view.test.mjs` 10 条 |
| **T1.3** 编排模式 | `publishGoal` / `previewGoalPlan` 共享 `goalPublishBody`；弹窗「编排模式」独立控件 | `goal-publish-wiring.test.mjs` ②⑥：默认不发该字段、custom-dag 不发分配层 |
| **T1.4** 冻结可见 | 发布回执 `frozen` 增加 `agentToolConfigVersion` / `modelConfig` / `nodeId` / `goalAgent` / `stageOverridesApplied` | 逐字段比对与发布一致 |
| **T2.1** 运行明细 | `fetchRunAttempts` / `fetchRunEvents`；`workbench/src/runEventsView.ts`；任务详情每条阶段 Attempt 下折叠区 | `run-events-view.test.mjs` 7 条（`known=false` 不许丢、失败≠空、标签与契约逐字对齐） |
| **T2.3** needs-input | `workbench/src/waitingOnUser.ts`（唯一判据）；详情与看板改用它 | `waiting-on-user.test.mjs` ⑥ 反例守卫：两文件内联 `startsWith('❓')` 必须为 0 |
| **T2.2** 时间线摘要与实时性 | `workbench/src/timelineSummary.ts`（`mergeTimeline` / `summarizeTimeline` / `belongsToTask` / `timelineHeadline`）；任务详情接既有 `subscribeHubAudit` 做增量，不重拉整表 | `timeline-summary.test.mjs` 10 条；⑩ 接线守卫：必须订阅既有 `/api/events`、必须按 taskId 过滤、**不许**自己 `new EventSource` |
| **T2.4** 事件缺口 | `confirm-stopped` 写 `write-intent:confirm-stopped`；`budget.cancel-requested` 的 `taskId` 列改为真任务号（attemptId 进 detail）；`validate` 写 `runtime:validation` | `claim-reservation.e2e`（含"失败那次不许多记"）、`budget-routes` ⑥、`runtime-verification-routes` ④d/④e |
| **T3.1** 指标命名 | `preIntegrationCandidateValidationFailureRate` 新增；旧字段保留 + `deprecated`/`deprecatedBy`/`deprecationNote`；`deliveryBadge` 文案改「合并前验证中」 | `metrics.test.mjs`、`delivery-ui.test.mjs` |
| **T3.2** 失败分类盘点 | [failure-taxonomy-2026-10-27.md](../../review/failure-taxonomy-2026-10-27.md)：九类逐条归属 + 两套 Attempt 词表 + 三个候选方案 | 只读，不改行为 |
| **T3.3** 恢复清单 | [recovery-checklist-2026-10-27.md](../../review/recovery-checklist-2026-10-27.md)：六项核对 → 可执行查询 → 决策表 | 每项都能指到端点或标"需人工" |
| **T4.1** 会话/MCP 评估 | [session-and-mcp-2026-10-27.md](../../review/session-and-mcp-2026-10-27.md) | 结论：现在不建 Session、不开 MCP 写 |

#### 七项决策的落地（2026-10-27 第二轮）

| 决策 | 产物 | 判据 |
|---|---|---|
| #1 返工连续同因升级（B） | `orchestrator/state-machine/rework-escalation.mjs`；`submitAgentWorkflowReview` 的升级分支 | 纯层 8 条；`pipeline.test.mjs` 决策 #1 e2e（连续 3 轮 ⇒ `escalated` + `in_review` + `hold` + 审计；换 summary 不升级） |
| #2 自审标注（A） | `resolveGoalPlan()` 产 `selfReview`；预览与 `frozen` 回执带出；`goalPlanView.selfReviewNote` + 弹窗黄框 | `goal-orchestration.test.mjs` 决策 #2 e2e（同源标注 / 不同源不标 / **仍然 publishable**）；`goal-plan-view` ⑪ |
| #6 失败分类归一化（B） | `orchestrator/state-machine/failure-kind.mjs`；指标新增 `failureKindRate` / `failureKindCounts` | 纯层 8 条（等待/返工不是失败、分母口径、空样本不显示 0） |

#### 与计划的三处偏差（及原因）

1. **`testRunner` 拒绝码新增 `OVERRIDE_TEST_RUNNER` / `OVERRIDE_INVALID`**（计划里只写了"拒绝"）。
   原因：拒绝必须有具名码，否则前端只能匹配中文。
2. **目标级在线上是简写**：请求体收 `agentToolConfig: {id, version}`，路由层包成
   `goalAgent: { agentToolConfig }` 再交给解析层。原因：解析层不该知道 HTTP 简写。
3. **T2.2（时间线摘要）未做**。原因见下。

#### 未做 / 留给后续

- **计划内无未完成项**。T2.2 已在同轮补齐；§5 七项决策已全部落地或定档。
- **计划以外刻意没做的**（都是决策记录里明确"不做"的）：合入后复验、空间级 Agent 默认、
  把失败分类并成单一码表。理由见[决策记录](../../review/decisions-2026-10-27.md) §3/§5/§6。
- **#4 的后续动作**：观察 `goal.orchestration` 里 `custom-dag` 的占比；若长期接近 0，
  按决策记录 §4 的退路办（编辑器只产出分配模板）。

#### 验证

```
orchestrator/assignment/index.test.mjs          19 pass
team-hub/goal-orchestration.test.mjs             9 pass
team-hub/goal-lifecycle-routes.test.mjs         19 pass
team-hub/pipeline.test.mjs                      24 pass
team-hub/metrics.test.mjs                        3 pass
team-hub/runtime-verification-routes.test.mjs   13 pass
team-hub/claim-reservation.e2e.test.mjs          1 pass
team-hub/budget-routes.test.mjs                 23 pass
workbench goal-plan-view / goal-publish-wiring /
          run-events-view / waiting-on-user /
          delivery-ui / task-order / timeline-summary   10+7+7+6+7+15+10 pass
workbench tsc --noEmit                           exit 0
workbench vite build                             exit 0
scripts/ci/encoding-check.test.mjs               6 pass
scripts/prt/doc-table-integrity.test.mjs         9 pass / 1 fail（既有：PRT-PROGRESS.md:164）
```

**两个既有失败，与本次改动无关**（已在基线上复现）：
- `workbench/scripts/agent-workflow-view.test.mjs` 6 红（代理模式文案期望与实现不一致）；
- `docs/superpowers/prt/PRT-PROGRESS.md:164` 表格列数。

#### 新增套件已注册

`scripts/ci/run-ci.mjs` 增加七条：`goal-plan-view`、`goal-publish-wiring`、
`run-events-view`、`waiting-on-user`、`timeline-summary`、`rework-escalation`、`failure-kind`。

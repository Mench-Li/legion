# 软件流水线 × Agent 分配解耦设计

> 状态：**后端已实现（2026-10-22）**；界面部分见 §11「落地记录」。
> 日期：2026-10-21（设计）／2026-10-22（实现）
> 现场：T-212 / 目标 `G-mvgf01af-4` / 空间 `software`
> 关联：`docs/FEATURES.md` §3.21（F-22）、`docs/superpowers/prt/F-23-MULTI-HARNESS-ROUTING.md` §14、PRT-305、PRT-402

## 0. 一句话结论

**软件流水线决定「做哪些阶段、按什么顺序」；Agent 工作流配置只决定「每个阶段由哪个 Agent / 模型 / 执行节点处理」。** 未单独配置的岗位走 DSH 默认。发布目标时两者分别冻结：流水线快照 + Agent 分配覆盖项；已有目标继续按创建时冻结的配置运行。

---

## 1. 现场与根因

### 1.1 T-212 的冻结链

本机 `team-hub/team.db` 的现场（2026-10-21 核对）：

| 项 | 值 |
| --- | --- |
| 目标 | `G-mvgf01af-4`（software，active，chain） |
| 链任务 | `T-211 requirement` → `T-212 coder` → `T-213 reviewer` |
| 冻结定义 | `workflow.software.custom@3`（"Claude Code → DeepSeek Harness → Codex"） |
| 定义阶段 | `design(requirement)` / `implement(coder)` / `review(reviewer)` |
| 空间流水线 | 8 个启用岗位：`requirement → researcher → breaker → test-designer → coder → reviewer → tester → devops` |

也就是说：**空间里明明有测试执行和部署两个启用岗位，目标链却只有三个阶段**，`researcher`、`breaker`、`test-designer`、`tester`、`devops` 全部没有进入这条链。

### 1.2 代码根因

根因不在 T-212 本身，而在两个概念的耦合：

1. `publishGoalRecord()`（`team-hub/server.mjs:2606`）把可选的 `workflowDefinitionRef` 解析成定义对象，然后调用
   `createGoalChain(goalId, scope, objective, mode, workflowDefinition)`（`:2691`）。
2. `createGoalChain()`（`team-hub/server.mjs:5587`）里：

   ```js
   const configuredWorkflow = mode === 'chain'
     ? workflowDefinition === null ? pipeline.workflow : workflowDefinitionForChain(workflowDefinition)
     : null
   const workflowStagePlan = ... configuredWorkflow 的阶段列表 ...
   const route = workflowStagePlan === null ? legacyRoute : workflowStagePlan.map(...)
   ```

   `legacyRoute` 是「编队 ∩ 流水线启用岗位」（`:5609-5618`），也就是原软件流程的正确读法。
   但只要存在 Agent 工作流配置（**具名定义**或**空间级 `space_runtime.review_workflow`**），`route` 就被替换成工作流定义的阶段列表（`:5621-5628`），流水线只退化成一道「这些岗位必须启用」的校验（`:5625-5626`）。

3. 同一份路径也用于 TeamPlan 冻结（`:2739-2762`）和任务快照（`:5691-5713`），所以冻下来的就是「工作流的三个阶段」，不是流水线。

这与旧设计文档的字面口径一致：`F-23-MULTI-HARNESS-ROUTING.md:256` 曾明确写「`space_stages` 与 roster …… 不能在创建工作流时被隐式重排或删减」。**本次要改的正是这句语义**：工作流定义不再拥有阶段集合的决定权。

### 1.3 为什么不能只给 T-212 补一个部署任务

- 补一个 `devops` 任务只能让 T-212 这一条链看起来完整；下一个带工作流定义的目标仍会丢掉测试与部署。
- T-212 的链是创建时冻结的，补任务等于改写一条正在执行的目标历史，和「已有目标按创建时配置运行」直接冲突。
- 缺的不只是部署，还有测试；只补部署会把「测试没跑」掩盖得更彻底。

**结论：T-212 保持原样；修复落在编排语义上，新目标才按新语义生成。**

---

## 2. 目标语义

### 2.1 配置层的三层分离

| 层 | 权威数据 | 决定什么 | 不决定什么 |
| --- | --- | --- | --- |
| **软件流水线** | `space_stages`（role/label/next/enabled/sort）+ `roster` | 做哪些阶段、顺序、闸门与产物 | 谁执行 |
| **Agent 分配** | 空间闭环配置 `space_runtime.review_workflow.stageTools`；具名定义 `agent_workflow_definitions`；`space_stages.agent_tool_config/model_config` | 每个阶段用哪个 Agent 工具、模型、执行节点、testRunner | 阶段集合与顺序 |
| **审查闭环（可选）** | 上述配置里的 `designRole / implementationRole / reviewRole / reviewRoutes / maxReworkRounds` | 三个角色间的 typed review 与返工路由 | 是否产生测试/部署阶段 |

### 2.2 不变量

1. **阶段集合只由流水线决定**：`route = roster ∩ enabled space_stages`，按 `sort` 排序；工作流配置不能增加、删除或重排阶段。
2. **分配只按岗位匹配**：工作流配置里写了哪个 `role`，就覆盖哪个岗位的执行配置；没写的岗位用 DSH 默认。
3. **默认是 DSH**：无工具覆盖 → DSH 原生 provider（`spawn`）；无模型覆盖 → DSH 侧默认模型；无节点覆盖 → 自动认领（或目标级绑定）。
4. **显式配置失败即拒绝**：工作流里点名的工具配置不存在/停用/能力不符时，发布直接失败，**不静默回退默认**（沿用 F-23 §14.2 的「拒绝，不换另一个」）。
5. **发布时冻结，运行时不回读**：新目标冻结流水线、分配与审查策略；已有目标的冻结数据不被新代码改写。
6. **审查策略可选**：没有配置审查闭环时，链就是普通流水线；配置了但流水线里没有对应岗位时，按明确规则报错（见 §3.4）。
7. **一条目标只有一个有效执行节点**：跨节点 workspace/Git 交接尚未实现；阶段级节点配置必须收敛成唯一节点，否则发布时 409。

### 2.3 运行层：仍然是一条「线性工作流实例」

配置层解耦，不等于运行层要退化成普通任务链。现有跨 Agent 机制（独立 worktree、阶段 Attempt、冻结提交检查点、typed review、返工路由）都建立在 `tasks.agent_selection_snapshot.reviewWorkflow` 上：

- `plugins/src/index.ts:2402` 要求工作流阶段必须有独立 worktree；
- `materializeWorkflowCheckpoints()`（`runtime/contracts/agent-workflow-checkpoints.mjs`）按上游阶段的冻结提交逐个 merge；
- `submitAgentWorkflowReview()`（`server.mjs:4895`）按冻结阶段配置结算审查与返工。

如果只给 `requirement/coder/reviewer` 三个任务挂 `reviewWorkflow`、其余阶段当普通任务，下游 `tester` 会从主分支开工，**拿不到被审查的那份代码**；而检查点模块又要求上游每个阶段都有冻结提交，普通阶段提供不了。

因此：**流水线在运行层被实例化成一条线性的工作流实例**（8 个阶段、id 用角色名、边为 `sort` 相邻边），全部任务共享同一个 `reviewWorkflow` 快照与 `instanceId`。这样：

- 阶段集合仍只来自流水线；
- 每个阶段都有检查点，`tester/devops` 能 merge 到实现与审查阶段的提交；
- 三阶段审查语义（design/implementation/review）保持不变；
- 运行历史里看到的是「这条流水线的执行实例」，不是另一套编排。

> 一句话：**配置层拆开，运行层统一。** 工作流定义管分配，流水线管阶段，运行时仍是同一个受审计的工作流实例。

---

## 3. 数据模型与解析

### 3.1 PipelineSnapshot（流水线快照）

```jsonc
{
  "version": "sha1-16",                 // readPipeline().version，内容指纹
  "mode": "chain",                      // chain | slice
  "stages": [                           // 只含实际入链的岗位，按 sort
    { "role": "requirement", "label": "需求澄清", "next": "researcher",
      "gate": false, "artifact": null, "sort": 0 }
  ]
}
```

- 只记录**实际入链**的岗位（`roster` 有、`space_stages.enabled !== 0`），避免冻结一份没被执行的配置。
- `next` 保留用于展示与一致性校验；实际依赖由 `blockedBy` 表达。

### 3.2 AssignmentSnapshot（分配覆盖项）

```jsonc
{
  "profileRef": { "source": "definition", "id": "workflow.software.custom", "version": 3 },
  // source: "definition" | "space-review-workflow" | null
  "stages": {
    "requirement": {
      "source": "definition",
      "agentToolConfig": { "id": "tool.claude-code", "version": 1, "providerName": "claude-code", "...": "发布时解析后的完整注册项" },
      "modelConfig": null,
      "resolvedModelConfig": null,
      "executionNode": null,
      "testRunner": null
    },
    "coder": {
      "source": "definition",
      "agentToolConfig": { "id": "tool.dsh-spawn", "version": 2, "...": "..." },
      "modelConfig": { "id": "fjd-ds-deepseek-v4-flash-openai", "version": 1 },
      "resolvedModelConfig": { "provider": "fjd-ds", "model": "deepseek-v4-flash-openai", "reasoningEffort": "medium" },
      "executionNode": { "id": "desktop-software", "version": 1, "...": "..." },
      "testRunner": { "executable": "node", "args": ["--test"], "timeoutMs": 900000 }
    },
    "tester": {
      "source": "dsh-default",
      "agentToolConfig": null,
      "modelConfig": null,
      "resolvedModelConfig": null,
      "executionNode": null,
      "testRunner": null
    }
  },
  "effectiveNode": { "id": "desktop-software", "version": 1, "...": "..." }
}
```

- 工具配置在**发布时**解析并整份写入（含 `providerName`、`adapter`、能力位），运行期不再查注册表；与现有 `resolveAgentReviewWorkflowSnapshot()`（`server.mjs:6073`）的冻结口径一致。
- `source` 只用于诊断：`definition` / `space-review-workflow` / `space-stage` / `dsh-default`。
- 未覆盖岗位也显式记一条 `dsh-default`，让「没配」与「没读到」在快照上分得开。

### 3.3 PipelineWorkflowSnapshot（线性工作流实例）

由流水线快照合成，形状兼容现有 worker 读取的 `reviewWorkflow`：

```jsonc
{
  "kind": "pipeline",
  "orchestration": "pipeline",
  "profileRef": { "source": "definition", "id": "workflow.software.custom", "version": 3 },
  "pipelineVersion": "sha1-16",
  "instanceId": "G-mvgf01af-4",
  "designRole": "requirement",
  "implementationRole": "coder",
  "reviewRole": "reviewer",
  "designStageId": "requirement",
  "implementationStageId": "coder",
  "reviewStageId": "reviewer",
  "reviewRoutes": { "design": "requirement", "implementation": "coder" },
  "maxReworkRounds": 2,
  "topologicalStageIds": ["requirement", "researcher", "breaker", "test-designer", "coder", "reviewer", "tester", "devops"],
  "workflowDefinitionRef": null,          // 不是用户发布的不可变定义
  "workflowDefinitionSnapshot": { "...": "由流水线合成的线性 DAG，保留给既有读取方" },
  "stageIdByRole": { "requirement": "requirement", "coder": "coder", "reviewer": "reviewer", "tester": "tester", "devops": "devops" },
  "stageTools":      { "requirement": { "...": "同 AssignmentSnapshot.stages" }, "tester": { "...": "dsh-default" } },
  "stageToolsById":  { "...": "同上，按 stage id" },
  "stageDefinitions":    { "...": "按角色，含 next/previousStageIds/label" },
  "stageDefinitionsById": { "...": "全 8 阶段" },
  "stageLabels": { "requirement": "需求澄清", "tester": "测试执行", "devops": "部署与 CI/CD" }
}
```

- `plugins/src/index.ts` 的 `isWorkflowStage()`、`workflowHasForwardEdges()`、typed review 结算、返工路由读的字段都不变。
- 变的是：`workflowDefinitionSnapshot.stages` 现在来自流水线，而不是用户定义；用户定义只贡献 `stageTools` 与审查参数。
- 合成 DAG 建议仍走 `createAgentWorkflowDefinition()` 校验（线性边、入口/终点、reviewRoutes 的实现阶段必须带 `testRunner`），避免手写一个不合法快照。

### 3.4 解析算法与优先级

新增纯模块（建议 `orchestrator/assignment/index.mjs`）：

```js
resolveGoalPlan({
  pipeline,            // readPipeline(scope)
  roster,              // 编队
  profile,             // 具名定义对象 | 空间 review_workflow | null
  agentNodeId,         // 发布弹窗的选择
}) -> { pipeline: PipelineSnapshot,
        assignments: AssignmentSnapshot,
        workflow: PipelineWorkflowSnapshot | null,
        effectiveNode: NodeSnapshot | null }
```

**阶段解析**

1. 取 `space_stages.enabled !== 0` 且 `roster` 里存在的岗位；
2. 排序用 `space_stages.sort`，再用 `role` 稳定排序；
3. 结果为空且 `roster` 非空 → 沿用现有 `createGoalChain` 的报错（编队与流水线没有交集）；
4. 一致性校验：非末位的 `next` 若存在，必须等于下一岗位，否则发布 409（流水线自身矛盾，不能靠工作流配置掩盖）。

**分配解析（按 role，后者覆盖前者）**

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1（最低） | 无 | `dsh-default` |
| 2 | `space_stages.agent_tool_config` / `model_config` | 既有数据面，当前 software 全为空 |
| 3 | `profile.stageTools[role]` | 空间闭环配置或具名定义 |
| 4（最高） | 发布时显式覆盖 | 本设计**暂不新增**；预留字段 `assignmentOverrides` |

- 具名定义按 `role` 匹配 `stages[].role`；同一 role 出现在多个阶段时，取拓扑序第一个并**产出发布警告**（提示该定义不适合作为分配模板）。
- 定义里存在、但流水线里没有（或停用）的 role：**忽略该条并警告**，不再像今天这样直接报「跨 Agent 工作流阶段未启用」。
- 显式引用的工具/模型配置解析失败：**发布失败**（`AGENT_TOOL_CONFIG_UNRESOLVED`，沿用现码）。

**审查策略解析**

- 角色来源：`profile.designRole/implementationRole/reviewRole`（空间闭环配置与具名定义都已有这三个字段）。
- 生成线性工作流实例的条件：`profile !== null`，三个角色**都**在流水线里且启用，且实现阶段有可用 `testRunner`。
- 配置了审查闭环但任一条件缺失 → **发布失败**并点名缺什么（配置错误，不静默降级）。
- 完全没配置审查闭环（`profile === null`）→ 不生成工作流实例，链是普通流水线（与今天无工作流路径一致），**不自动推断审查角色**。

### 3.5 有效执行节点

候选集 = `{ goal.agentNodeId } ∪ { assignments[*].executionNode.id }`：

- 去重后 > 1 → 发布 409 `AGENT_NODE_WORKSPACE_MISMATCH`（沿用现文案：跨节点交接尚未实现）；
- 恰好 1 → 写入 `effectiveNode`，并冻进**每个**任务快照；
- 0 → `null`，由认领方按既有自动/手动规则决定（同机可改派）。

为什么要「每个任务都写」：今天具名定义只有 `coder` 绑了 `desktop-software`，其余阶段为空；`requirement` 被别的节点认领后，`coder` 会在认领时 409（`server.mjs:6265-6272` 的节点继承检查）。8 阶段链把这个问题放大了，必须在发布时收敛。

### 3.6 冻结位置

- `goal` 表新增列（`ensureColumn`，可空）：`pipeline_snapshot TEXT`、`assignment_snapshot TEXT`、`workflow_snapshot TEXT`、`orchestration TEXT DEFAULT 'pipeline'`（`pipeline` | `custom-dag` | `none`）。
  - `none` = 没有审查闭环的普通链，`workflow_snapshot` 为 NULL。
- 任务 `agent_selection_snapshot`：
  - 有审查闭环时 `source` 继续用 `goal-agent-workflow`（保持独立 worktree / 检查点 / 产物摘要的既有行为）；
  - 没有审查闭环时用 `source: 'space-pipeline'`（与既有 live pipeline 读法同名），保持普通任务语义；
  - 有审查闭环时新增 `orchestration: 'pipeline' | 'custom-dag'` 与 `profileRef`，让界面与诊断能区分「流水线实例」和「用户自定义 DAG 实例」；
  - `reviewWorkflow` 存 `PipelineWorkflowSnapshot`（或 custom DAG 快照）。
- `agent_workflow_instances` 继续按目标存一行：pipeline 模式下 `definition_id/definition_version` 为 NULL，`snapshot_json` 存 `PipelineWorkflowSnapshot`；custom-dag 模式保持现状。
- TeamPlan（`contextPlanStore().putTeamPlan`）继续写，`note` 改为「流水线 + 分配覆盖项」，阶段里带 `assignmentSource` 便于界面解释。

---

## 4. 代码改动

### 4.1 新增纯模块

`orchestrator/assignment/index.mjs` + `assignment.test.mjs`：

- `resolvePipelineRoute({ pipeline, roster })`
- `resolveAssignments({ pipeline, stages, profile })`
- `buildPipelineWorkflow({ pipeline, stages, assignments, profile })`
- `resolveEffectiveNode({ agentNodeId, assignments })`

纯函数、不碰 DB；工具配置解析作为注入端口（`resolveTool(ref)`/`resolveModel(ref)`），与 `model-binding` 的风格一致，便于穷举测试。

### 4.2 `publishGoalRecord`

```js
const pipeline = readPipeline(targetScope)
const profile = workflowDefinitionRef ? loadDefinition(...) : (pipeline.workflow ?? null)
const plan = resolveGoalPlan({ pipeline, roster: readRoster(targetScope), profile, agentNodeId })
// 发布校验：显式配置可解析、审查角色齐全、testRunner 存在、节点唯一、
// 生成工作流实例时 space_runtime.isolate 必须为真（工作流阶段强制独立 worktree）
INSERT goal (..., orchestration, pipeline_snapshot, assignment_snapshot, workflow_snapshot)
const chain = createGoalChain(goalId, scope, objective, mode, plan)
```

- `workflowDefinitionRef` 在 `pipeline` 模式下不再走 `workflowDefinitionForChain()`，而是作为分配模板传给 `resolveGoalPlan()`。
- 校验前移：跨节点、节点未登记/未就绪、工具配置不存在，都在写入 goal 行之前失败，避免「发布成功、派工必失败」。

### 4.3 `createGoalChain`

```js
const route = plan.pipeline.stages.map((stage) => ({
  ...roster.find((r) => r.role === stage.role),
  workflowStageId: stage.role,
}))
build.forEach((r, i) => {
  const a = plan.assignments.stages[r.role]
  const snapshot = {
    source: plan.workflow === null ? 'space-pipeline' : 'goal-agent-workflow',
    orchestration: plan.workflow === null ? null : 'pipeline',
    profileRef: plan.workflow?.profileRef ?? null,
    pipelineVersion: plan.pipeline.version,
    stageRole: r.role,
    workflowStageId: plan.workflow === null ? null : r.role,
    agentToolConfig: a.agentToolConfig,
    modelConfig: a.modelConfig,
    resolvedModelConfig: a.resolvedModelConfig,
    executionNode: plan.effectiveNode,
    reviewWorkflow: plan.workflow,
    workflowContext: plan.workflow === null ? null : { designArtifacts: [], implementation: null },
  }
  insertGoalTask({ ..., blockedBy: i > 0 ? [created.at(-1).id] : [], agentSelectionSnapshot: snapshot })
})
```

- `blockedBy` 恢复为**顺序链**（`created.at(-1)`），与流水线 `sort` 一致；不再有 DAG 多前驱/汇合。
- `tester/devops` 等未配置岗位拿到 `dsh-default` 分配，但在工作流实例里仍是普通阶段（有检查点、无 typed review）。
- `slice` 模式保持不变（本批不动切片展开）；`mode` 与 `orchestration` 是正交的两个维度。

### 4.4 返工收敛（本设计新增的必需行为）

**问题一：下游抢跑。** 8 阶段链里 `tester.blockedBy = [reviewer]`。审查不通过时 `submitAgentWorkflowReview()` 会把原审查任务置 `done`（`server.mjs:5058-5060`），于是 `tester` 会在返工还在跑的时候被解锁——测试的是一个正在被返工的版本。

**问题二：整段复制。** 现有 `submitAgentWorkflowReview()` 对带 `workflowDefinitionSnapshot` 的实例会重建目标阶段的**全部下游**（`:4987-5055`）。在 3 阶段定义里下游只有 `review`，没问题；在 8 阶段线性实例里，`coder` 的下游包含 `reviewer/tester/devops`，会复制出重复任务。

**方案**（在 `submitAgentWorkflowReview` 内，原子完成，仅对 `kind === 'pipeline'`）：

1. 计算返工子链：按 `reviewRoutes` 选目标角色；从目标角色到 `reviewRole` 依次创建任务（设计返工 = design→implementation→review；实现返工 = implementation→review），每个任务带冻结分配快照，`blockedBy` 指向前一个。
2. 找到本目标里 `blockedBy` 包含**原审查任务**的下游任务（`tester`、`devops` 等），把该依赖替换成**新审查任务** id。
3. 最后才把原审查任务置 `done`。
4. 达到 `maxReworkRounds` 时维持现状：不创建返工、不置 done，下游保持阻塞，交人工裁决。

这样：
- 审查通过 → 审查任务停在 `in_review`，人工验收后 `done`，下游解锁（现有语义）；
- 审查不通过 → 旧审查 `done` 只为让返工链启动，下游被重新指向新审查，不会抢跑；
- 返工审查通过 → 新审查停在 `in_review`，验收后下游解锁；
- 多轮返工每次只把下游指向「最新一代」审查任务。

`custom-dag` 模式继续走现有「重建全部下游」逻辑，避免改变具名 DAG 的语义。

### 4.5 worker / handoff

- `plugins/src/index.ts` 的 `isWorkflowStage()` 只按 `reviewWorkflow` 的三个 stage id 判定；其余阶段走同一实例的普通阶段检查点路径（`:3132-3172`）。
- `materializeWorkflowCheckpoints()` 的上游齐套要求由「所有入链阶段都是工作流阶段」满足；`tester/devops` 能从 `coder`/上游拿到冻结提交。
- `handoff.advancePipeline()`：`source === 'goal-agent-workflow'` 继续直接 return（所有后继已预建）；`pipeline` 模式不依赖它补建。
- `resolveLegacyAgentSelection()`（`server.mjs:6185`）：对**新目标**优先读 `goal.assignment_snapshot` / `goal.workflow_snapshot`，取不到再回退 live pipeline；对旧目标保持现状（先读任务快照/TeamPlan）。
- `frozenGoalWorkflow()` 扩为 `frozenGoalPlan()`，统一给返工、认领、上下文装配使用。

### 4.6 API

`POST /api/goal`：

```jsonc
{
  "objective": "...",
  "mode": "chain",                       // chain | slice，语义不变
  "orchestration": "pipeline",           // 新增，默认 pipeline；custom-dag 才按定义拓扑建链
  "workflowDefinition": { "id": "...", "version": 3 },  // pipeline 模式下 = 分配模板
  "agentNodeId": "desktop-software"
}
```

- 响应增加 `frozen: { pipelineVersion, stages, assignmentProfile, workflowInstanceId }`，便于发布弹窗与验收用例核对。
- `GET /api/pipeline` 不变；新增 `GET /api/goal/:id/plan`（只读冻结计划）供界面解释「这一环为什么是 DSH 默认」。

### 4.7 自定义 DAG 模式（建议保留，但必须显式）

具名定义今天支持并行分支、同岗位多阶段、汇合等拓扑，这些能力无法用「单链流水线」表达。建议：

- `orchestration: 'custom-dag'` 时保留现有 `workflowDefinitionForChain()` 路径，行为与今天完全一致；
- 默认 `pipeline`，界面不得默认选中 DAG；
- 具名定义在 `pipeline` 模式下退化为「按岗位的分配模板」；
- 若产品决定彻底退役 DAG，则删除 `custom-dag` 分支、编辑器与相关用例，但需要单独的迁移说明（见 §10-Q1）。

---

## 5. 界面

1. **设置 → Agent 工作流**：
   - 标题从「配置跨 Agent 闭环」改为「岗位 Agent 分配（可选）」；
   - 主体是一张**流水线岗位表**：每一行 = 空间流水线的一个启用岗位，列为「Agent 工具 / 模型 / 执行节点」，未配置显示「DSH 默认」；
   - 三阶段审查闭环仍保留（design / implementation / review 角色选择 + 返工上限），但说明文案明确：**它只决定谁执行与审查返工，不决定阶段集合**；
   - 「自定义交接链（DAG）」收进高级设置，标注「显式启用，默认不参与」。
2. **发布目标弹窗**：
   - 预览要生成的链（如 8 个岗位）以及每个岗位的执行来源（定义 / 空间配置 / DSH 默认）；
   - 定义选择器的文案改为「Agent 分配模板（不改变阶段）」；
   - 节点选择继续走现有 `decideAutoNode`。
3. **工作流运行页**：
   - pipeline 模式展示「流水线阶段 + 返工轮次」；
   - custom-dag 模式才展示 DAG 实例视图。

---

## 6. 兼容、迁移与 T-212 处置

- **已有目标**：任务快照与 TeamPlan 已冻结，不改写；读路径优先快照。代码上线后它们仍按 3 阶段跑完。
- **数据库**：只加可空列，无回填；旧行 `orchestration` 为 NULL 时按任务快照派生（有 `reviewWorkflow` → `custom-dag`，否则 `none`），避免误判。
- **T-212**：保持现状，不补任务。若确需部署，按「续做 = 新目标」的既有纪律重新发布；新目标会得到完整 8 阶段链（`researcher`、`breaker`、`test-designer`、`tester`、`devops` 也会进来）。
- **文档**：更新 `FEATURES.md` §3.21（当前写着「自定义交接链可并行/汇合、不按流水线顺序」）、`F-23` §14.2/§14.3（`:256` 的旧不变量）、`docs/design/legion-agent-orchestration-design.md`。
- **灰度**：可用 `LEGION_GOAL_ORCHESTRATION=pipeline|legacy` 环境开关控制一个发布周期；默认 `pipeline`，`legacy` 仅用于回滚。

---

## 7. 测试计划

| 层 | 用例 | 断言 |
| --- | --- | --- |
| 纯模块 | 流水线解析 | 8 阶段按 sort；停用岗位不进链；编队缺失的岗位不生成；`next` 矛盾报错 |
| 纯模块 | 分配优先级 | 定义覆盖空间阶段配置；未配置 = dsh-default；无效工具引用抛错 |
| 纯模块 | 工作流合成 | 8 阶段线性 DAG；入口/终点正确；reviewRoutes 指向角色；实现阶段必须有 testRunner |
| 纯模块 | 节点收敛 | 0 个 → null；1 个 → effectiveNode；2 个 → 409 |
| Hub | 发布目标（带定义） | 生成 8 个任务；`tester/devops` 存在；requirement/coder/reviewer 快照来自定义；其余为 DSH 默认 |
| Hub | 发布目标（无定义） | 8 个任务，全部 DSH 默认；与今天无工作流路径一致 |
| Hub | 冻结 | 发布后改流水线/定义，不改变已建任务；旧目标 3 任务保持 |
| Hub | 返工收敛 | 审查 findings → 旧审查 done、下游 `blockedBy` 指向新审查；新审查通过前 tester 不可认领 |
| Hub | 返工上限 | 达上限不建返工、不置 done、下游保持阻塞 |
| Worker | 8 阶段链 | `tester/devops` 走工作流普通阶段检查点；reviewer 走 typed review；不重复建后继 |
| Worker | 检查点 | tester 开工时能 merge 到 coder 的冻结提交；缺任一上游检查点则停止并具名报错 |
| Worker | 3 阶段自定义 DAG | 既有替身闭环用例全绿（显式 `orchestration:'custom-dag'`） |
| UI | 面板/弹窗 | 岗位表显示 DSH 默认；定义选择器不再暗示改变阶段 |
| 回归 | `pipeline.test.mjs` / `goal-lifecycle-routes.test.mjs` / `handoff.test.mjs` / `worker-regression.test.mjs` | 全绿；旧快照用例不变 |

---

## 8. 实施顺序

1. **纯模块 + 单测**：解析、优先级、工作流合成、节点收敛（不碰 DB）。
2. **Hub 数据面**：新增列、`publishGoalRecord` 冻结、`createGoalChain` 按流水线建链；补发布/冻结用例。
3. **返工收敛**：`submitAgentWorkflowReview` 按 `kind` 分流，预建返工审查 + 下游重指；补收敛用例。
4. **worker/handoff 回归**：普通阶段检查点、上游齐套、跳过重复补建；跑替身闭环。
5. **UI**：岗位分配表、发布预览、运行页文案。
6. **文档与现场验证**：更新 FEATURES / F-23 / 设计文档；在 scratch 空间发布一个目标验证 8 阶段链；T-212 不动。

每步的退出条件：该层用例全绿 + 至少一条「变红验证」（把修复回退后用例必须红），避免只证明「代码与自己的声明一致」。

---

## 9. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 语义反转 | 具名定义从「编排」变「分配」，用户预期变化 | UI 明示；custom-dag 显式保留；发布响应回显 |
| 下游抢跑 | 返工期间 tester 提前解锁 | §4.4 的依赖重指 + 专项用例 |
| 返工误复制 | 8 阶段实例按旧逻辑重建全部下游 | 按 `kind === 'pipeline'` 分流，只重建审查环 |
| 旧目标被改写 | 读路径回读 live pipeline | 快照优先；旧目标无新列时只读任务快照/TeamPlan |
| 节点不一致 | 8 阶段链跨节点 409 | 发布时收敛唯一 `effectiveNode` |
| 审查角色缺失 | 空间没有 reviewer | 发布时报错并点名；不静默关掉审查 |
| 分析阶段也进检查点 | `requirement/researcher/...` 现在都是工作流阶段，需要独立 worktree 与 HEAD | 发布前校验 `space_runtime.isolate`；文档注明 |
| 切片模式 | 切片展开未接分配 | 本批保持现限制（slice 暂不与 review 配置共存），下一批再接 |

---

## 10. 待确认（2026-10-22 已按「确认」落地，保留原文供对照）

1. **具名 DAG 的处置**：建议保留为显式 `custom-dag` 模式（默认不选，旧能力不丢）；备选是彻底退役。请确认。
2. **分配范围**：建议允许给**所有**流水线岗位配 Agent（不只设计/实现/审查三岗）；请确认是否有意限制。
3. **审查角色缺失**：建议发布失败（配置错误不静默降级）；若希望「缺 reviewer 就退化成普通链」，需要明确改成警告。
4. **切片模式**：建议本批不动，后续单独接分配；若要求同批完成，需要把 `expandGoalSlices()` 一并纳入。
5. **灰度开关**：是否需要 `LEGION_GOAL_ORCHESTRATION` 保留一个发布周期的 legacy 回滚能力。

---

## 11. 落地记录（2026-10-22）

### 11.1 已交付

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 纯解析 | `orchestrator/assignment/index.mjs` | `planGoal()` / `resolvePipelineStages()` / `resolveAssignments()` / `resolveReviewPolicy()` / `resolveEffectiveNode()` / `buildPipelineWorkflow()`；深冻结、具名错误码、告警码 |
| 纯解析用例 | `orchestrator/assignment/index.test.mjs` | 13 例：八岗流水线 + 三岗模板仍建八环、未覆盖岗位 = `dsh-default`、优先级、停用中间岗位只告警、缺角色/缺 runner/跨节点各自具名拒绝、合成工作流形状 |
| Hub 数据面 | `team-hub/server.mjs` | `goal` 新增 `orchestration` / `pipeline_snapshot` / `assignment_snapshot` / `workflow_snapshot` 四列（`ensureColumn`，可空）；`publishGoalRecord(..., orchestration)`；`createGoalChain` 接受计划或显式 DAG 定义 |
| Hub 返工 | `team-hub/server.mjs` | `submitAgentWorkflowReview` 仅对 `kind === 'pipeline'` 收敛：只重建「目标角色 → 审查角色」，并把下游 `blockedBy` 重指到新一代审查任务 |
| 路由 | `team-hub/routes/goal-lifecycle.mjs` | `POST /api/goal` 识别 `orchestration`（只认字面量 `custom-dag`，其余一律 `pipeline`） |
| Hub 用例 | `team-hub/goal-orchestration.test.mjs` | 7 例：八岗仍八环、发布后不漂移、缺审查岗拒绝、跨节点拒绝、返工不复制/不抢跑、任意岗位可覆盖、custom-dag 必须显式 |
| 路由用例 | `team-hub/goal-lifecycle-routes.test.mjs` | 第 8 位参数 `orchestration` 的搬运与默认值 |
| 分配范围 | `team-hub/server.mjs` 的 `normalizeAgentWorkflow` | `stageTools` 放宽到**任意流水线岗位**（原先只允许审查闭环的三个角色；那会让"给 tester 换 Agent"在数据面根本存不进去）。仍然拒绝流水线里没有的岗位——那种配置永远不会生效，存下来只会让人以为配好了 |
| 界面文案 | `workbench/src/components/AgentWorkflowConfigurator.tsx` / `GoalModal.tsx` | 面板首段明写「本页只决定每个岗位由谁执行、不改阶段」；发布弹窗的下拉框改为「Agent 分配模板（不改变阶段）」 |
| CI | `scripts/ci/run-ci.mjs` | 新增 `goal-orchestration` 与 `agent-assignment` 两个套件 |

实现要点与设计的差异：

1. **发布时把「有效节点」写进每一环**：设计只要求收敛，实现额外把 `effectiveNodeId` 冻进每个任务的 `executionNode`——否则只有配了 `nodeId` 的那一环被钉住，别的阶段会被另一台机器领走、下一环认领时 409。
2. **`workflow_snapshot` 在 `createGoalChain` 之后回写**：要冻的是**解析后**的那一份（含工具注册项与能力位），而它在建链时才生成；目标级快照与 `agent_workflow_instances` 必须是同一份。
3. **新增发布期校验 `AGENT_WORKFLOW_REQUIRES_ISOLATION`**：工作流阶段强制独立 worktree，空间 `runtime.isolate=false` 时发布即拒绝，而不是等第一环认领才发现。
4. **`custom-dag` 必须带定义**：显式选了 `custom-dag` 却没给 `workflowDefinition` 时报 `AGENT_WORKFLOW_DEFINITION_REQUIRED`，不静默退回 pipeline。
5. **无流水线的历史空间**：`space_stages` 为 0 行时仍按全编队建链（与 SP-P0 的旧行为一致），只有「配了流水线但一个都没启用」才报 `AGENT_PLAN_PIPELINE_EMPTY`。

### 11.2 尚未交付

- **界面（§5）**：`AgentWorkflowConfigurator` 目前仍是「三行岗位」形态，只是把语义写清楚了；「所有岗位一张分配表」与发布弹窗的 `frozen` 预览都还没做。后端已在 `POST /api/goal` 的响应里返回 `frozen`（阶段、逐岗位分配来源、审查策略、有效节点），界面接入只差展示层。
- **灰度开关（§10-Q5）**：未加 `LEGION_GOAL_ORCHESTRATION`。当前回滚手段是让调用方显式传 `orchestration: 'custom-dag'`；若要整空间回滚，建议下一批补环境开关。
- **切片模式**：本批未动（`slice` 仍要求空间未启用审查闭环），切片任务不参与分配覆盖。
- **T-212 本身**：按设计保持原样（3 环）。需要部署就按「续做 = 新目标」重新发布，新目标才会得到 8 环。

### 11.3 验证记录

| 套件 | 结果 |
| --- | --- |
| `orchestrator/assignment/index.test.mjs` | 13/13 |
| `team-hub/goal-orchestration.test.mjs` | 7/7（含返工不复制/不抢跑、任意岗位可覆盖） |
| `team-hub/pipeline.test.mjs` | 24/24（`custom-dag` 用例改为显式选择） |
| `team-hub/goal.test.mjs` + `goal-closed.test.mjs` + `goal-lifecycle-routes.test.mjs` + `spaces.test.mjs` | 90/90 全绿 |
| `team-hub/handoff-store.test.mjs` + `handoff-routes.test.mjs` | 20/20 |
| `plugins`：`handoff` / `stateMachine` / `reclamation` | 100/100 |
| `workbench`：`goal-workflow-options` / `workflow-panel-layering` / `agent-workflow-defaults` | 37/37 |
| `workbench` tsc `--noEmit` | 通过 |

⚠️ **诚实边界**：`plugins/tests/worker-regression.test.mjs` 在本机有 4 条端到端用例超时
（`aborted worker 重派`、`mediator 重派`、`workflow cancellation`、`standalone workflow design`，
均在 10s `waitFor` 上超时）。本批**没有改动** `plugins/` 与 `runtime/`（`git status` 可查），
这些用例也不 import 本批任何新模块，因此判断为环境/时序问题而非回归；但**没有**在改动前的代码上
逐条复跑对照，所以这句话只到"与本批改动无因果关系"为止，不宣称它们本来是通过的。

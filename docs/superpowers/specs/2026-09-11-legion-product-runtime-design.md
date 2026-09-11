# Legion Product Runtime 产品化架构设计

> 日期：2026-09-11  
> 状态：待评审  
> 决策：首版继续使用 DSH 作为内部受控执行引擎，不把完全脱离 DSH 作为商业化前置条件

## 1. 摘要

Legion 当前已经具备 Workbench 指挥台、team-hub 权威数据源、数字员工流水线、任务执行、worktree 隔离、验收交接、技能、审计与对话等基础能力。当前产品化的主要障碍不是功能缺失，而是执行面和生命周期仍以 DSH 插件形态存在：模型选择、Agent 启动、定时任务、插件实例与退出清理直接依赖 DSH/Cordis 上下文，安装、配置、升级和故障处理仍需要开发者知识。

本方案将目标定义为 **Legion Product Runtime**：

- DSH 继续承担模型接入、单 Agent 推理循环、工具执行和会话运行时。
- Legion 拥有数字团队编排、上下文快照、权限审批、审计、产品配置和交付体验。
- 两者之间新增稳定的 `RuntimeAdapter` 契约；除 DSH 适配器外，新增代码不得直接调用 DSH API。
- 客户安装和使用 Legion，不单独安装、配置或升级 DSH。
- DSH 版本由内部验证后与 Legion 产品版本绑定，经灰度和可回滚升级流程推送。
- team-hub 继续作为业务状态唯一事实源，不建立第二套任务、审批或审计状态。

该路线优先验证数字团队的付费意愿、可信交付和真实业务价值，同时保留未来替换 DSH 或增加其他执行器的能力。

## 2. 背景与现状

当前仓库的生产主路径为：

| 层面 | 当前组件 | 当前职责 |
|---|---|---|
| 指挥面 | `workbench/` | 空间、目标、任务、模型、技能、文件、浏览器、日历、通知与审计界面 |
| 数据面 | `team-hub/server.mjs` | SQLite、HTTP API、任务状态机、空间数据、审批、审计与 SSE |
| 执行面 | `plugins/` | 扫单、认领、派工、worktree、交接、调解、对话回复和经验召回 |
| 生命周期 | `services-plugin/` | 在 DSH Desktop 中启动、停止和重启 Legion 服务 |
| 执行宿主 | DSH | 模型配置、Subagent 启动、Agent Loop、工具调用与 Cordis 生命周期 |

现有耦合集中在以下类型：

- 模型选择依赖 `ctx.agentDefaultModel.currentSelection()`。
- Agent 执行依赖 `ctx.subagents.start()`。
- 周期调度和资源回收依赖 `ctx.setInterval()`、`ctx.effect()`。
- 多空间子实例依赖 `ctx.plugin()`。
- 外部包构建依赖 DSH checkout 提供 Cordis、Agent、Session、Subagent 等模块。

team-hub 和 Workbench 已可以作为独立进程运行；缺少 DSH 时，用户仍可访问界面和数据，但无法完成自动模型执行。因此本方案不重写 DSH，而是把它从“开发宿主”转化为“随产品分发的内部执行引擎”。

## 3. 产品目标

### 3.1 目标

- 在未配置 Legion/DSH 开发环境的 Windows 机器上完成一键安装、首次配置和启动。
- 用户只通过 Legion 配置模型、管理数字员工和处理审批，不接触 DSH/Cordis 插件配置。
- 所有 DSH 能力通过版本化 Runtime Contract 使用。
- 将团队编排逻辑与 DSH 生命周期分离，使其可独立测试、恢复和演进。
- 每次员工执行都有确定的输入快照、输出产物、工具记录、审批记录和状态历史。
- 模型密钥不进入提示词、业务数据库正文、日志、导出证据或能力包。
- 产品版本精确绑定经过验证的 DSH 版本，支持 internal、canary、stable 发布通道。
- 升级前自动备份，升级失败可恢复到兼容版本且不丢失任务和审计数据。
- 首个商业 Alpha 能可靠运行软件交付数字团队，并为后续跨境电商能力包提供公共底座。

### 3.2 非目标

首版不实现：

- 完全脱离 DSH 的 Standalone Agent Runtime。
- 自研模型协议、完整 ReAct/Tool Agent Loop 或模型供应商 SDK 聚合层。
- 企业级多租户 SaaS、跨主机分布式调度或高可用集群。
- 同时交付多个 Runtime Adapter；接口可扩展，但首版仅启用 DSH。
- 自动付款、采购、生产发布等不可逆动作。
- 允许客户自行替换、单独升级或混装未经验证的 DSH 版本。
- 以向量数据库为前置的复杂知识库；首版采用结构化来源、显式引用、版本和作用域检索。
- 复制 team-hub 业务状态到另一个产品数据库。

## 4. 核心架构决策

### 4.1 DSH 是受控内部引擎

DSH 与 Legion 一起安装、启动、停止和升级。面向客户的界面统一称为“AI 执行引擎”或“Runtime”；诊断包内部可以保留 DSH 组件版本，但用户不需要理解其配置和插件模型。

### 4.2 Legion 拥有团队编排语义

任务认领、岗位选择、流水线、上下文组装、结果验收、角色交接、审批、恢复和审计属于 Legion。DSH 只负责执行一个已定义的 `RunRequest`，不成为任务或团队状态的事实源。

### 4.3 不重写单 Agent Loop

首版继续使用 DSH 的模型调用、流式推理、工具调用和会话执行能力。只有当许可证、分发、可靠性、成本、性能、模型支持或安全隔离形成经过验证的商业瓶颈时，才启动 Direct API Runtime 或独立 Agent Loop 项目。

### 4.4 单一事实源

team-hub 保持以下数据的唯一权威来源：

- 工作空间、目标、任务和任务状态。
- 数字员工与团队快照。
- 上下文版本和执行记录。
- 审批、工具调用、用量和审计事件。
- 技能、能力包安装记录与发布状态。

Git 保存可审阅的代码、能力包和导出证据；不承担运行中业务状态的权威存储。

### 4.5 渐进迁移，不复制完整系统

保留当前插件执行路径作为兼容基线，新路径通过 `orchestrationMode=legacy|product-runtime` 切换。模块按契约逐步提取并进行新旧对拍；达到退出条件后再删除旧路径。禁止长期双写两套任务状态。

## 5. 目标组件图

```text
┌──────────────────────────────────────────────────────────┐
│                     Legion Desktop                       │
│  Workbench：团队 / 目标 / 任务 / 配置 / 审批 / 升级      │
├──────────────────────────────────────────────────────────┤
│                Legion Product Services                   │
│  Product API              Runtime Manager                │
│  Orchestrator Core        Context Assembler              │
│  Approval & Permission    Tool Broker                    │
│  Audit & Usage            Pack Manager                   │
├──────────────────────────────────────────────────────────┤
│                    Runtime Contract                      │
│  health / models / validate / execute / cancel / recover │
├──────────────────────────────────────────────────────────┤
│                    DshRuntimeAdapter                     │
│  Subagents / Agent Loop / Tools / Session / Model Config │
├──────────────────────────────────────────────────────────┤
│  team-hub SQLite / Workspace / Git / OS Credential Store │
└──────────────────────────────────────────────────────────┘
```

## 6. 模块设计

### 6.1 Runtime Contract

Runtime Contract 是 Legion 与执行引擎之间唯一允许的调用边界。

```ts
interface RuntimeAdapter {
  getHealth(): Promise<RuntimeHealth>
  getCapabilities(): Promise<RuntimeCapabilities>
  listModels(): Promise<ModelDescriptor[]>
  validateProfile(profile: ModelProfile): Promise<ValidationResult>
  execute(request: RunRequest): AsyncIterable<RunEvent>
  cancel(runId: string): Promise<CancelResult>
  recover(runId: string): Promise<RecoveryResult>
}
```

`RunRequest` 至少包含：

- `runId`、`attemptId`、`idempotencyKey`。
- `workspaceId`、`goalId`、`taskId`、`employeeId`。
- 冻结的 `teamPlanRef` 和 `contextSnapshotRef`。
- `modelProfileRef`、预算、超时和取消策略。
- 工作目录、环境变量白名单和工具权限。
- 预期输出 Schema 与验收提示。

`RunEvent` 采用可持久化事件类型：

- `run.started`
- `model.selected`
- `message.delta`
- `tool.requested`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `usage.updated`
- `artifact.produced`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `run.outcome_unknown`

标准错误码至少包括：

- `AUTH_FAILED`
- `MODEL_UNAVAILABLE`
- `RATE_LIMITED`
- `CONTEXT_TOO_LARGE`
- `TOOL_DENIED`
- `TIMEOUT`
- `CANCELLED`
- `RUNTIME_CRASHED`
- `OUTCOME_UNKNOWN`
- `INVALID_RESULT`

Runtime Contract 必须独立于 Cordis 和 DSH 类型，能够用内存 Fake Adapter 完成全部 Orchestrator 测试。

### 6.2 DshRuntimeAdapter

`DshRuntimeAdapter` 是首版唯一执行器实现，负责：

- 包装模型选择和可用模型读取。
- 包装 Subagent 启动、输出和结构化结果。
- 把 DSH 流式事件转换为 `RunEvent`。
- 处理取消、超时和 DSH 生命周期信号。
- 把 DSH 异常转换为标准错误。
- 采集模型、token、耗时和工具使用量。
- 对提示词、异常和日志进行密钥脱敏。
- 对外报告精确 DSH 版本和 Runtime Contract 版本。

除该模块和迁移期兼容代码外，仓库内不得新增对 `ctx.subagents`、`ctx.agentDefaultModel` 或其他 DSH 执行 API 的直接调用。CI 增加静态边界检查防止回归。

### 6.3 Runtime Manager

Runtime Manager 管理 Adapter 的注册、健康、执行和兼容性：

- 启动时校验产品清单、DSH 版本和契约版本。
- 拒绝启动未经验证或不兼容的组合。
- 为 Orchestrator 提供单一 Adapter 引用。
- 维护运行级取消和恢复入口。
- 将 Runtime 健康状态转换成用户可理解的产品状态。
- 不保存任务业务状态，只保存执行器注册和健康快照。

### 6.4 Orchestrator Core

Orchestrator Core 从当前 `plugins/src/index.ts` 中提取模型无关的团队调度语义：

- 扫描和认领待执行任务。
- 解析岗位与流水线。
- 建立 task lease 和 attempt。
- 准备 workspace/worktree。
- 请求 Context Assembler 生成快照。
- 调用 Runtime Manager。
- 持久化执行事件、用量和产物。
- 校验结构化结果和机器闸门。
- 执行打回、重试、审批、交接与完成迁移。
- 在进程重启后恢复未完成任务。

运行状态机：

```text
Queued
  → Leased
  → PreparingWorkspace
  → BuildingContext
  → Running
  → Validating
  → AwaitingApproval | HandingOff
  → Completed

异常：
  → RetryableFailure
  → UnknownOutcome
  → Cancelled
  → DeadLetter
```

状态迁移要求：

- 在执行下一步副作用前持久化意图或 attempt。
- lease 有所有者、租期和 heartbeat。
- 重试创建新 attempt，不覆盖历史 attempt。
- 外部写操作使用幂等键。
- 无法确认外部结果时进入 `UnknownOutcome`，不得伪装成功或自动重复写入。
- 状态迁移、恢复和人工处置均写入 audit。

### 6.5 Context Assembler

Context Assembler 生成版本化、确定性、可回放的 `RunContextSnapshot`：

```text
Compiled TeamPlan 快照
+ EmployeeManifest
+ Goal Context vN
+ 当前任务与用户反馈
+ 上游员工交付
+ 已发布技能和显式知识
+ 工作区状态
- 越权数据
- 过期数据
- 超出预算内容
= RunContextSnapshot
```

每个快照记录：

- 来源 ID、来源类型、版本和取得时间。
- 内容哈希与最终组合哈希。
- 权限过滤和脱敏结果。
- 字符/token 预算与裁剪理由。
- 发送给 Runtime 的最终文本或结构化段落。
- 关联的目标、任务、员工和团队方案。

首版检索以 scope、标签、类型、显式引用和版本为主。向量检索可以作为后续 Context Source 接入，但不得改变快照和来源追踪协议。

### 6.6 Model Configuration

Workbench 提供统一模型配置，屏蔽 DSH 内部配置格式。

```text
ModelProfile
- id
- displayName
- runtimeType
- provider
- model
- endpoint
- secretRef
- reasoningEffort
- limits

EmployeeModelBinding
- employeeRole
- primaryProfile
- fallbackProfiles
- perRunBudget
- dailyBudget
```

支持：

- BYOK 供应商、Endpoint 和模型配置。
- 岗位默认模型和 fallback 顺序。
- 推理强度和执行预算。
- 连通性、模型可用性和能力验证。
- 配置导入导出；导出不包含密钥。
- 将产品配置转换为 DSH 所需配置，但不让用户直接编辑 DSH profile。

### 6.7 Secret Store

首版 Windows 使用 Windows Credential Manager 或 DPAPI 保护密钥：

- team-hub 只保存 `secretRef`，不保存明文。
- Runtime 在获得授权后按需解析密钥。
- 密钥只注入需要它的执行进程和工具。
- 提示词、日志、异常、审计、诊断包和能力包均不得包含密钥。
- 新增、更新、轮换和删除密钥写入不含密文的审计记录。
- 无法访问或解密密钥时 fail closed，并显示可操作错误。

### 6.8 Tool Broker 与权限审批

工具请求统一经过：

```text
Agent → Tool Request → Permission Evaluation
      → Allow / Ask / Deny
      → Tool Execution → Result → Audit
```

权限由 `EmployeeManifest + TeamPlan + UserPolicy + TaskContext` 共同决定，至少覆盖：

- 文件读写范围。
- Git 和 worktree 操作。
- 命令执行。
- 网络访问。
- MCP 工具。
- 外部 API 读取与写入。
- 发布、付款、删除等高风险动作。

审批绑定规范化操作内容哈希；任一关键字段变化都会使审批失效。无人值守模式下，要求人工审批的操作默认拒绝或保持等待，不自动降级为允许。

### 6.9 Product Launcher

Product Launcher 是客户唯一启动入口，管理：

- team-hub。
- Workbench 静态服务。
- DSH Runtime。
- Legion Orchestrator worker。
- 可选 Whiteboard 服务。

必须提供：

- 首次运行初始化。
- 组件依赖顺序和就绪探针。
- 端口冲突检测与明确提示。
- 子进程监督、退避重启和熔断。
- 优雅关闭与僵尸进程清理。
- 日志轮转和磁盘容量保护。
- 系统托盘入口和打开 Workbench。
- 备份、恢复和诊断包导出。

Launcher 不修改客户项目内容；所有进程参数和路径来自经过 Schema 校验的产品配置。

### 6.10 产品配置与目录

运行目录按职责隔离：

```text
InstallDir/   只读程序、固定依赖和 DSH Runtime
DataDir/      team-hub 数据库、附件、审计和产品元数据
Workspace/    用户授权的项目目录
CacheDir/     构建、下载和临时缓存
LogDir/       可轮转日志
```

配置优先级固定为：

```text
内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量
```

所有环境变量必须在配置 Schema 中声明。不得把安装目录当作可写业务数据目录，也不得把密钥写入上述普通配置文件。

### 6.11 审计、用量和可信交付

每次运行至少可查询：

- 发起人、数字员工、目标、任务和 attempt。
- 产品、DSH、Runtime Contract、能力包和 TeamPlan 版本。
- ModelProfile 引用，不含密钥。
- Context Snapshot 哈希和来源。
- 工具请求、权限决定、审批与执行结果。
- 文件、代码差异和其他产物。
- token、费用估算、耗时和错误。
- 最终验收、交接与人工处置。

Workbench 提供从“目标 → 任务 → 员工执行 → 工具 → 证据 → 差异 → 审批 → 交付”的追踪视图。

## 7. 数据模型增量

在 team-hub 现有 SQLite 基础上增量增加或规范化以下实体：

| 实体 | 用途 |
|---|---|
| `runtime_registrations` | Runtime 类型、契约版本、组件版本和健康状态 |
| `model_profiles` | 非敏感模型配置及 `secretRef` |
| `employee_model_bindings` | 岗位到模型档案和预算的绑定 |
| `team_plan_snapshots` | 编译后的团队方案、版本与内容哈希 |
| `context_snapshots` | 执行上下文、来源、预算和内容哈希 |
| `task_attempts` | 每次任务执行尝试、状态、lease 和恢复信息 |
| `agent_runs` | Runtime run、模型、时间、结果和错误 |
| `run_events` | 规范化执行事件；大体量 delta 可按保留策略压缩 |
| `tool_calls` | 工具请求、权限决定、幂等键和结果 |
| `usage_records` | token、费用估算和耗时 |
| `artifacts` | 产物位置、类型、内容哈希和来源 |
| `secret_refs` | 密钥引用、用途和元数据，不含密文 |
| `schema_migrations` | 数据库迁移版本和执行结果 |

已有权限、审批和 audit 表优先扩展复用；只有现有语义无法表达时才新增表。所有迁移必须幂等，旧数据库升级前自动备份。

## 8. 关键执行流程

### 8.1 正常任务

```text
用户创建目标
→ team-hub 冻结 TeamPlan
→ Orchestrator 创建任务链
→ worker 获取 lease
→ 准备 workspace/worktree
→ Context Assembler 生成快照
→ Runtime Manager 校验 DSH 健康与模型配置
→ DshRuntimeAdapter 执行员工
→ 持久化 RunEvent、ToolCall、Usage、Artifact
→ 机器验收
→ 人工审批或角色交接
→ 完成交付
```

### 8.2 Runtime 崩溃

```text
heartbeat 超时
→ attempt 标记 RuntimeCrashed/OutcomeUnknown
→ Runtime Manager 查询 recover
→ 可确认未执行副作用：创建新 attempt 重试
→ 外部结果未知：进入人工处置
→ 可恢复会话：继续同一 run 并追加审计
```

### 8.3 高风险工具调用

```text
Runtime 发出 ToolRequest
→ Tool Broker 规范化操作并计算哈希
→ Permission Engine 判定 ask
→ task 进入 AwaitingApproval
→ 用户批准同一哈希
→ 执行工具并记录幂等键
→ 返回结果给 Runtime
```

## 9. DSH 版本治理与产品升级

### 9.1 版本清单

每个产品版本携带不可变清单：

```json
{
  "productVersion": "0.3.0",
  "legionVersion": "0.3.0",
  "dshVersion": "0.8.3",
  "schemaVersion": 12,
  "runtimeContractVersion": 1,
  "packProtocolVersion": 1,
  "channel": "stable"
}
```

客户不能在产品内单独升级 DSH。启动时发现实际版本与清单不一致，应停止自动执行并引导修复，不带病运行。

### 9.2 发布通道

```text
internal → canary → stable
```

- `internal`：开发和内部真实项目验证。
- `canary`：少量明确接受灰度的用户。
- `stable`：通过兼容性、迁移、恢复和黄金流程验证的版本。

### 9.3 DSH 升级门禁

DSH 新版本必须通过：

- Runtime Contract 契约测试。
- 模型发现、配置和调用测试。
- 流式事件与结构化结果测试。
- 工具调用、权限和取消测试。
- 上下文注入与敏感信息测试。
- 超时、限流和异常标准化测试。
- DSH 崩溃和产品重启恢复测试。
- 软件交付数字团队黄金端到端流程。
- 数据库升级、降级恢复和旧任务兼容测试。

### 9.4 客户端升级流程

```text
检查兼容性与空间
→ 备份数据库和配置
→ 下载并校验签名
→ 停止任务认领
→ 等待或安全中断在途运行
→ 停止服务
→ 原子切换程序版本
→ 执行数据库迁移
→ 启动并运行健康检查
→ 提交升级或回滚
```

数据库迁移优先采用向前兼容和 expand/contract 策略。若新版本已写入旧版本无法理解的数据，禁止仅回滚二进制；必须使用经过验证的数据库恢复或向前修复流程。

## 10. 安全与商业发布要求

- 默认只监听 loopback；远程访问必须启用认证和明确网络配置。
- 安装包、升级清单和下载产物需要完整性校验；正式版使用代码签名。
- 提供第三方组件清单和 SBOM，确认 DSH 及所有依赖的商业使用与分发条件。
- 工作目录、环境变量、网络和工具遵循最小权限。
- 诊断包默认脱敏，并由用户主动生成。
- 日志、事件和产物设置容量上限与保留策略。
- 卸载时明确区分删除程序、保留数据和彻底删除数据。
- 高风险操作必须可定位到发起人、审批人、内容哈希和实际结果。

## 11. 代码组织与迁移

建议在现有 Legion 仓库内新增清晰边界，避免复制完整系统形成永久分叉：

```text
legion/
├── product/
│   ├── launcher/
│   ├── installer/
│   ├── updater/
│   └── diagnostics/
├── runtime/
│   ├── contracts/
│   ├── manager/
│   └── adapters/dsh/
├── orchestrator/
│   ├── scheduler/
│   ├── state-machine/
│   ├── context/
│   ├── recovery/
│   └── validation/
├── security/
│   ├── secrets/
│   ├── permissions/
│   └── redaction/
├── packs/
│   └── software-delivery/
├── team-hub/
├── workbench/
├── plugins/          # 迁移期保留旧执行路径
└── services-plugin/  # 由 Product Launcher 逐步接管
```

迁移规则：

1. 先建立纯契约和 Fake Adapter，再包装 DSH。
2. 新功能只走新边界，旧功能暂不重写。
3. 按功能切片把编排逻辑从插件中提取为纯模块。
4. 对同一黄金任务运行 legacy 与 product-runtime 路径，比较状态、产物、审计和错误。
5. Product Launcher 稳定后接管生命周期，`services-plugin` 保留一个发布周期作为回退。
6. 新路径连续满足退出指标后删除旧路径；不长期维护两套实现。

## 12. 实施任务树

### 阶段 0：冻结基线

- `PRT-001`：记录当前进程、端口、组件和数据拓扑。
- `PRT-002`：建立 DSH/Cordis API 依赖清单和静态扫描规则。
- `PRT-003`：建立配置、环境变量、密钥和路径来源清单。
- `PRT-004`：定义软件交付黄金流程和固定输入仓库。
- `PRT-005`：保存旧路径的任务状态、执行事件、产物和审计证据。
- `PRT-006`：验证当前 team-hub 数据备份与恢复。
- `PRT-007`：建立旧系统功能、HTTP、数据库和执行行为基线。

完成标准：在受控环境稳定复现一次端到端软件交付，并能对后续新路径做等价比较。

### 阶段 1：Runtime Contract

- `PRT-101`：定义 `RuntimeAdapter` 和 `RuntimeCapabilities`。
- `PRT-102`：定义 ModelProfile、ModelDescriptor 和验证结果。
- `PRT-103`：定义 RunRequest、RunEvent、RunResult。
- `PRT-104`：定义标准错误码、重试等级和用户可见错误。
- `PRT-105`：定义取消、超时、恢复和 Unknown Outcome 语义。
- `PRT-106`：建立 Runtime Contract 契约测试。
- `PRT-107`：实现内存 FakeRuntimeAdapter。
- `PRT-108`：增加禁止新增直接 DSH 调用的静态边界检查。

完成标准：不启动 DSH 即可测试正常、失败、取消、超时和恢复编排。

### 阶段 2：DshRuntimeAdapter

- `PRT-201`：包装模型读取与 ModelProfile 转换。
- `PRT-202`：包装 `subagents.start` 与运行标识映射。
- `PRT-203`：转换 DSH 流式事件和最终结果。
- `PRT-204`：实现结构化输出校验。
- `PRT-205`：实现取消、超时和生命周期清理。
- `PRT-206`：实现异常标准化与重试分类。
- `PRT-207`：采集模型、token、费用估算和耗时。
- `PRT-208`：实现日志、异常和事件脱敏。
- `PRT-209`：建立 DSH 版本与能力探测。
- `PRT-210`：建立旧调用与 Adapter 路径对拍测试。

完成标准：同一任务通过两条路径得到等价任务状态、结构化结果和产物，且敏感信息不出现在输出中。

### 阶段 3：Orchestrator Core

- `PRT-301`：定义持久化运行状态机。
- `PRT-302`：实现 task lease、租期和 heartbeat。
- `PRT-303`：实现 attempt 与不可覆盖历史。
- `PRT-304`：提取任务扫描和认领逻辑。
- `PRT-305`：提取岗位、流水线与团队快照逻辑。
- `PRT-306`：提取 workspace/worktree 管理。
- `PRT-307`：提取结构化结果和机器验收。
- `PRT-308`：提取打回、交接和完成逻辑。
- `PRT-309`：实现重试、退避和 Dead Letter。
- `PRT-310`：实现恢复扫描和人工处置。
- `PRT-311`：实现外部副作用幂等与 Unknown Outcome。
- `PRT-312`：覆盖状态迁移、并发、崩溃和恢复测试。

完成标准：强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。

### 阶段 4：上下文与能力包边界

- `PRT-401`：定义 Context Source 和 RunContextSnapshot。
- `PRT-402`：接入 TeamPlan 和 EmployeeManifest。
- `PRT-403`：接入目标上下文及 `contextVersion`。
- `PRT-404`：接入任务、评论和用户反馈。
- `PRT-405`：接入上游员工交付和产物。
- `PRT-406`：接入已发布 Skills 与显式文档。
- `PRT-407`：实现作用域、权限、预算和裁剪。
- `PRT-408`：实现脱敏、来源清单和内容哈希。
- `PRT-409`：持久化快照并支持查看和导出。
- `PRT-410`：建立确定性、越权、超限和回放测试。

完成标准：任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因。

### 阶段 5：模型和密钥配置

- `PRT-501`：实现 ModelProfile 数据模型和 API。
- `PRT-502`：实现岗位模型绑定和 fallback。
- `PRT-503`：实现单次、岗位和每日预算策略。
- `PRT-504`：实现模型连通性与能力测试。
- `PRT-505`：实现 Windows Secret Store。
- `PRT-506`：迁移现有非敏感模型配置。
- `PRT-507`：实现 Workbench 模型设置页面。
- `PRT-508`：实现配置导入导出但排除密钥。
- `PRT-509`：覆盖密钥读取、轮换、删除和泄漏测试。

完成标准：用户只在 Legion 中完成 BYOK 配置，明文密钥不进入 team-hub 业务数据、日志和诊断包。

### 阶段 6：工具、权限和审批

- `PRT-601`：定义工具能力描述和风险等级。
- `PRT-602`：实现 Tool Broker 与统一 ToolRequest。
- `PRT-603`：接入 EmployeeManifest 工具白名单。
- `PRT-604`：实现文件和工作目录范围限制。
- `PRT-605`：实现命令、网络和 MCP 权限控制。
- `PRT-606`：区分外部 API 读取与写入权限。
- `PRT-607`：接入审批箱和无人值守策略。
- `PRT-608`：审批绑定规范化操作哈希。
- `PRT-609`：实现字段变化后审批失效。
- `PRT-610`：持久化工具调用、决定、结果和幂等键。

完成标准：未批准高风险写操作为零；改变已批准操作的任一关键字段后无法继续执行。

### 阶段 7：Product Launcher

- `PRT-701`：定义进程清单、启动依赖和健康协议。
- `PRT-702`：实现统一启动、停止和状态查询。
- `PRT-703`：实现端口冲突、依赖缺失和配置错误诊断。
- `PRT-704`：实现子进程监督、退避重启和熔断。
- `PRT-705`：实现优雅关闭和僵尸进程清理。
- `PRT-706`：实现产品目录与首次运行初始化。
- `PRT-707`：实现首次运行向导。
- `PRT-708`：实现系统托盘和打开 Workbench。
- `PRT-709`：实现日志轮转和磁盘保护。
- `PRT-710`：实现脱敏诊断包导出。

完成标准：干净 Windows 机器不打开终端即可完成安装后启动、模型配置、运行和停止。

### 阶段 8：安装、升级和回滚

- `PRT-801`：定义并生成产品版本清单。
- `PRT-802`：锁定 DSH 与依赖精确版本。
- `PRT-803`：生成可签名安装包。
- `PRT-804`：实现升级包、清单签名和完整性校验。
- `PRT-805`：实现升级前兼容性、磁盘和在途任务检查。
- `PRT-806`：实现数据库与配置自动备份。
- `PRT-807`：建立幂等数据库迁移框架。
- `PRT-808`：实现原子程序切换和升级健康检查。
- `PRT-809`：实现安全回滚或向前修复。
- `PRT-810`：实现 internal、canary、stable 通道。
- `PRT-811`：实现升级审计、发布说明和用户通知。

完成标准：模拟下载损坏、迁移失败、DSH 启动失败和健康检查失败时，系统能恢复到已知兼容状态且业务数据不丢失。

### 阶段 9：商业 Alpha 发布保障

- `PRT-901`：生成第三方许可证清单和 SBOM。
- `PRT-902`：确认 DSH、模型供应商和依赖的商业分发条件。
- `PRT-903`：形成隐私、数据处理和模型调用说明。
- `PRT-904`：实现日志、执行事件和产物保留策略。
- `PRT-905`：提供备份、恢复和数据导出入口。
- `PRT-906`：定义崩溃报告的用户授权和脱敏策略。
- `PRT-907`：形成支持诊断与故障处置手册。
- `PRT-908`：实现卸载时的数据保留和彻底删除选择。
- `PRT-909`：建立产品发布检查清单。
- `PRT-910`：完成内部和金丝雀真实项目验证。

完成标准：商业 Alpha 安装、使用、升级、恢复、诊断和卸载流程均有可重复验收证据。

## 13. 里程碑与优先级

| 里程碑 | 包含阶段 | 可交付结果 |
|---|---|---|
| M0 基线冻结 | 阶段 0 | 当前系统可重复验收和比较 |
| M1 Runtime 边界 | 阶段 1～2 | DSH 被稳定接口隔离，新增代码不再直接依赖 DSH |
| M2 可恢复编排 | 阶段 3～4 | 编排与上下文可测试、可回放、可恢复 |
| M3 产品配置与安全 | 阶段 5～6 | 用户可安全配置模型并控制工具权限 |
| M4 一键运行 | 阶段 7 | 客户无需开发环境和终端 |
| M5 可控升级 | 阶段 8 | DSH 经内部验证后可灰度、可回滚推送 |
| M6 商业 Alpha | 阶段 9 | 首批真实用户完成可信软件交付 |
| M7 行业扩展 | 后续能力包计划 | 接入跨境电商数字团队 |

第一实施批次锁定在阶段 0～2。其目的不是立即改变用户界面，而是先阻止耦合继续扩散，并建立后续产品化工作的安全边界。

## 14. 测试策略

### 14.1 单元与契约测试

- Runtime Contract 的正常、失败、取消、超时和恢复。
- 状态机合法迁移、非法迁移和幂等。
- 上下文确定性、预算、过滤、脱敏和哈希。
- 权限决策、审批失效和无人值守 fail closed。
- 配置 Schema、密钥引用和日志脱敏。

### 14.2 新旧对拍

对固定黄金任务比较：

- 任务状态序列。
- 岗位、模型和提示输入。
- 结构化结果。
- 文件产物和 Git diff。
- 交接、审批和审计。
- 错误分类与用户提示。

模型输出允许文本差异，但状态语义、关键字段、权限行为和交付产物必须满足同一验收契约。

### 14.3 故障注入

- DSH 启动失败或运行中退出。
- 模型鉴权失败、限流和超时。
- Tool Call 前后断电或进程终止。
- team-hub 暂时不可达。
- SQLite busy、磁盘空间不足和日志写入失败。
- Launcher 重复启动和端口占用。
- 升级包损坏、迁移失败和新版本健康失败。

### 14.4 安全测试

- 密钥不出现在 API、数据库正文、日志、异常、诊断包和提示快照中。
- 员工无法访问 Manifest 之外的路径、工具和网络能力。
- 未批准或审批哈希失效的高风险操作无法执行。
- 非回环访问未认证时被拒绝。

## 15. 商业 Alpha 完成标准

在一台未安装 Legion/DSH 开发依赖的新 Windows 机器上，必须完成：

1. 使用单个安装包安装产品。
2. 在 Legion 首次运行向导中完成 BYOK 模型配置。
3. 绑定一个 Git 项目并选择软件交付数字团队。
4. 创建一个真实开发目标。
5. 至少两个数字员工完成执行和角色交接。
6. 用户可查看上下文来源、执行过程、工具、证据和代码差异。
7. 高风险操作只有在批准后执行，且审批与内容哈希绑定。
8. 强制关闭并重启产品后任务能够继续或进入明确的人工处置状态。
9. DSH 崩溃不会被记录为成功，也不会导致重复外部写操作。
10. 能导出脱敏的诊断与完整审计记录。
11. 能从内部验证版本灰度升级，并在故障注入下安全恢复。
12. 用户全过程不需要理解 DSH、Cordis、插件目录或多进程启动命令。

试点期可信交付指标：

- 未批准高风险写操作为零。
- 密钥泄漏为零。
- 任务状态伪成功为零。
- 已确认外部写操作的重复执行为零。
- 升级造成的不可恢复数据丢失为零。

## 16. 延后脱离 DSH 的触发条件

只有出现并确认以下至少一类瓶颈，才单独立项 Standalone Runtime：

- DSH 或依赖不能合法用于目标商业分发方式。
- DSH 无法在客户环境稳定安装或运行。
- DSH 升级持续破坏兼容性，维护成本超过替换成本。
- 多租户、安全隔离或企业部署要求无法满足。
- 目标模型、私有模型或推理供应商无法接入。
- Agent 执行成本、性能或可观测性无法控制。
- 生命周期限制导致恢复、扩展或 SLA 无法达标。
- 关键客户明确要求不安装或不使用 DSH。

触发条件未出现前，DSH 视为产品加速器；Runtime Contract 是风险隔离措施，而不是立即替换的承诺。

## 17. 最终决策

Legion 商业化不以脱离 DSH 为前置条件。首版采用“Legion 产品层 + Runtime Contract + DshRuntimeAdapter + 受控 DSH Runtime”的架构：

- 优先建立边界、可靠性、配置、安全、安装和升级能力。
- 不自研完整模型 Agent Loop。
- 不复制整个 Legion 或建立长期双轨产品。
- DSH 升级由内部完成兼容性和黄金流程验证后，随产品版本灰度推送。
- 软件交付数字团队先验证商业闭环，跨境电商能力包在公共产品底座稳定后继续建设。

这一决策同时满足短期上市速度和长期可替换性：DSH 继续作为发动机，但客户购买、配置和使用的是完整的 Legion 数字团队产品。

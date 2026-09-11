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

### 2.1 真实重构成本

DSH API 的直接调用点数量有限，当前 `plugins/src/index.ts` 中五类宿主调用合计 16 处：`ctx.subagents` 6 处、`ctx.agentDefaultModel` 4 处、`ctx.plugin` 2 处、`ctx.effect` 2 处、`ctx.setInterval` 2 处。这说明 Runtime Contract 能够建立，但不代表编排提取成本很低。

当前 `plugins/src/index.ts` 和 `team-hub/server.mjs` 都是超过 20 万字节、数千行的单文件。阶段 3 的任务扫描、流水线、workspace、验收和交接提取属于高风险外科式重构；team-hub 增加运行、上下文、用量等数据模型时也必须先建立模块边界。实施计划必须按小切片迁移，每个切片独立对拍和回归，不允许一次性重写两个大文件。

### 2.2 与既有设计和 DSH 原生能力对齐

本方案复用并扩展以下既有设计与实现：

| 既有能力 | 当前事实 | Product Runtime 的处理 |
|---|---|---|
| F-01 可恢复事件流 | audit 全局单调 `seq`、SSE `Last-Event-ID`、`sinceSeq`、scope 过滤和客户端持久游标已经存在 | 保持 `/api/events` 为唯一公开业务实时流；运行明细不建立第二条公开事件流 |
| F-02 权限治理 | `permission-engine.mjs`、权限规则、审批请求与 API 已存在，当前主要接入技能授权 | 扩展为 DSH 工具策略提供方，不重写五种决策模式 |
| DSH `tools/pre-execute` | 原生异步 allow/deny/ask waterfall | 承担动态权限、人工审批和 team-hub 策略接入 |
| DSH `ctx.tools.guard()` | 同步单调拒绝，后续 listener 不可撤销 | 承担静态 hard floor 和不可变安全禁令 |
| DSH `ctx.approval` | 仅 `allowed-once` 放行；缺失、异常、取消或 `never` 均 fail closed | 由 Legion 注册 answerer，将审批请求路由到 team-hub 审批箱 |
| DSH `ctx.permissionPresets` | 将 sandbox mode 与 approval policy 绑定为会话预设 | 作为 Employee/Run 权限档位的执行载体 |
| DSH `ctx.sandbox` | 提供进程沙箱 seam 和 Windows ACL 等后端 | 启动时探测实际 backend 与 enforcement；未启用或能力不足时禁止受保护执行 |

DSH 原生能力的存在不等于当前 Legion 已经受到保护。现有 Agent 执行插件尚未接入 Legion 权限引擎，Workbench 审批箱也尚未形成可用闭环；在新强制路径完成前，legacy 模式必须禁用高风险工具或使用经验证的受限 DSH 权限预设。

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

保留当前插件执行路径作为兼容基线，新路径通过 `orchestrationMode=legacy|product-runtime` 切换。该开关首版只允许按安装生效，后续如需按 space 生效，也必须由 team-hub 原子分配唯一调度器；禁止按任务自由切换或让两个调度器同时扫描同一空间。

模块按契约逐步提取并进行新旧对拍；对拍只在隔离数据库、隔离工作区和非生产空间中执行，不对真实客户任务双跑。达到退出条件后再删除旧路径。禁止长期双写两套任务状态。

### 4.6 术语

| 术语 | 权威含义 |
|---|---|
| Task | team-hub 中可由一个岗位完成和验收的业务工作单元 |
| Attempt | Task 的一次执行尝试；重试创建新 Attempt，历史不可覆盖 |
| Run | Runtime 对一个 Attempt 的一次模型执行实例 |
| Session | DSH 内部持久会话；可能承载一个或多个可继续 Run，不等同于 Task |
| Lease | Orchestrator 对 Task 的限时执行所有权 |
| Lease Epoch | 每次成功领取递增的 fencing token，用于拒绝旧 worker 写入 |
| TeamPlan | 目标创建时冻结的团队、岗位、流水线和能力包组合快照 |
| Context Snapshot | BuildingContext 完成时冻结、实际发送给 Runtime 的不可变输入 |

## 5. 目标组件图

```text
┌──────────────────────────────────────────────────────────┐
│                     Legion Desktop                       │
│  Workbench：团队 / 目标 / 任务 / 配置 / 审批 / 升级      │
├──────────────────────────────────────────────────────────┤
│                Legion Product Services                   │
│  Product API              Runtime Manager                │
│  Orchestrator Core        Context Assembler              │
│  Approval & Permission    DSH Enforcement Bridge         │
│  Audit & Usage            Pack Manager                   │
├──────────────────────────────────────────────────────────┤
│                    Runtime Contract                      │
│  health / models / validate / execute / cancel / recover │
├──────────────────────────────────────────────────────────┤
│                    DshRuntimeAdapter                     │
│  Subagents / Agent Loop / Tools / Session / Model Config │
├──────────────────────────────────────────────────────────┤
│         Legion DSH 组合补丁层（host 平面，随产品升级）   │
│  ToolGuard / pre-execute 策略 / approval / preset 表     │
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

- `RUNTIME_UNAVAILABLE`：Runtime 未启动或健康检查失败；可在恢复健康后重试。
- `RUNTIME_NOT_READY`：Runtime 正在启动、升级或降级；暂不认领新任务。
- `UNSUPPORTED_CAPABILITY`：当前产品与 DSH 组合不提供请求能力；不可自动重试。
- `SECRET_UNAVAILABLE`：系统凭证不存在、不可解密或运行账户不匹配；修复凭证后重试。
- `AUTH_FAILED`：供应商拒绝已有凭证；用户验证或轮换凭证后重试。
- `MODEL_UNAVAILABLE`：模型不存在或暂不可用；按显式 fallback 策略处理。
- `RATE_LIMITED`：供应商限流；按服务端建议或指数退避重试。
- `BUDGET_EXCEEDED`：预算预留失败或运行达到硬上限；停止运行并等待用户处理。
- `CONTEXT_TOO_LARGE`：在既定裁剪策略后仍超出模型限制；不可盲目重试。
- `TOOL_DENIED`：策略或人工决定拒绝；不可自动绕过或换工具重试同一意图。
- `TIMEOUT`：运行达到期限；只有确认无未知外部副作用时才可重试。
- `CANCELLED`：取消胜出；终态幂等。
- `RUNTIME_CRASHED`：执行器异常退出；进入恢复判断。
- `OUTCOME_UNKNOWN`：无法确认外部副作用或最终结果；只允许人工处置或可靠查询。
- `INVALID_RESULT`：最终输出不符合 Schema；可按任务策略创建新 Attempt。
- `SCHEMA_MIGRATION_FAILED`：产品数据迁移失败；停止启动并进入升级恢复。

正式实现为每个标准码维护“默认可重试性、重试前置条件、用户文案和审计等级”的版本化映射；Adapter 不得自行把未知错误归类为成功或普通可重试错误。

`cancel(runId)` 是幂等操作。若取消与完成并发，以 team-hub 首个成功提交的终态为准；Adapter 返回的迟到事件只能作为诊断记录，不能改写已提交终态。`execute()` 的事件流必须以一个终态事件结束；终态事件携带或引用 `RunResult`。`recover()` 返回恢复判断，不直接修改 Task 状态，由 Orchestrator 依据当前 lease epoch 和 attempt 状态提交迁移。

Runtime Contract 首版使用精确主版本匹配：产品清单声明唯一支持的 `runtimeContractVersion`，Runtime Manager 决定是否兼容。次版本能力通过 `RuntimeCapabilities` 探测；任何必需能力缺失都返回 `UNSUPPORTED_CAPABILITY`，不得静默降级。

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

Runtime 健康状态与 Orchestrator 行为固定如下：

| Runtime 状态 | 产品状态 | Orchestrator 行为 |
|---|---|---|
| `starting` | 正在启动执行引擎 | 不认领新任务；已有 lease 不延长为无限期 |
| `ready` | 执行引擎可用 | 正常认领和执行 |
| `degraded` | 部分能力不可用 | 只认领其必需能力全部满足的任务 |
| `unavailable` | 执行引擎不可用 | 停止认领；在途 Attempt 进入恢复判断 |
| `incompatible` | 组件版本不兼容 | 禁止自动执行，提示修复或回滚 |
| `upgrading` | 正在升级 | 停止认领，等待在途运行安全收敛 |

只读 Workbench 和 team-hub 在 Runtime 不可用时继续开放，用户仍可查看、导出和处理任务，但不能伪装为数字员工在线。

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
  ↔ AwaitingApproval
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
- lease 有所有者、租期、heartbeat 和单调递增的 `leaseEpoch`。
- 领取使用 team-hub 数据库事务和 team-hub 时钟；worker 不得自报租约权威时间。
- attempt、run、工具和任务结果的所有写入必须携带领取时的 `leaseEpoch`；team-hub 拒绝过期 epoch。
- SQLite 使用 WAL、`busy_timeout` 和 `BEGIN IMMEDIATE` 或等价条件更新保证领取原子性；忙等待耗尽后保留任务可重试状态。
- 重试创建新 attempt，不覆盖历史 attempt。
- 外部写操作使用幂等键。
- 无法确认外部结果时进入 `UnknownOutcome`，不得伪装成功或自动重复写入。
- 状态迁移、恢复和人工处置均写入 audit。
- `AwaitingApproval` 期间 heartbeat 继续、lease 随 heartbeat 续期，但受审批 TTL 约束；审批 TTL 到期自动 deny，Attempt 转为 `blocked`，写入 audit 并通知用户。

`AwaitingApproval` 是 Attempt/Run 级暂停态，可以由运行中的工具请求进入并在批准后回到 `Running`，也可以由验收后的交付审批进入并在批准后进入 `HandingOff` 或 `Completed`。它不直接替换 team-hub 的用户任务状态。

审批等待期必须明确 lease 与 heartbeat 行为，两种退化都不可接受：停止 heartbeat 会使 lease 到期并被其他 worker 领取，从而对同一 Task 重复执行，直接违背 §15 的“已确认外部写操作的重复执行为零”；无限续期则让一个无人处理的审批永久占用 lease，与 §6.3“已有 lease 不延长为无限期”冲突。因此采用 heartbeat 继续 + 审批 TTL 的方案，TTL 是配置项，必须在配置 Schema 中声明，并与 F-02 已有的 `expired` 审批状态对齐。

新旧状态映射：

| Product Runtime 状态 | team-hub Task 状态 | 说明 |
|---|---|---|
| `Queued` | `todo` | 尚未领取 |
| `Leased` / `PreparingWorkspace` / `BuildingContext` / `Running` | `in_progress` | 员工持有有效 lease |
| 工具级 `AwaitingApproval` | `in_progress` | Run 暂停，Task 仍由该 Attempt 持有 |
| 交付级 `AwaitingApproval` / `Validating` | `in_review` | 等待验收或人工批准 |
| `HandingOff` | `in_progress` | 当前 Task 收口并原子创建/释放下一岗位任务 |
| `RetryableFailure` | `todo` 或 `blocked` | 有自动重试额度时回到 todo，否则 blocked |
| `UnknownOutcome` / `DeadLetter` | `blocked` | 必须人工处置 |
| `Cancelled` | `canceled` | 使用现有取消语义；若库内命名不同由兼容映射处理 |
| `Completed` | `done` | 已通过所需闸门 |

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

快照在 `BuildingContext` 完成、Attempt 进入 `Running` 之前冻结，之后不可修改。运行中到达的新评论、目标上下文更新或知识变更只进入下一次 Attempt；首版不向正在运行的模型热注入。快照使用统一 canonical JSON 规则序列化后计算哈希，规则与审批哈希共享基础库，但两者使用不同的 Schema 和 domain separator，防止跨对象复用哈希。

仓库文件、网页、附件、上游产物和用户输入一律标记为不可信内容。来源文本可以影响分析结论，但永远不能授予权限、修改 EmployeeManifest、改变审批策略或扩大工具范围。Prompt injection 的主要安全边界是 DSH ToolGuard、sandbox 和审批，而不是仅依靠提示词提醒。

token 预算由选定 ModelProfile 的 tokenizer/限制决定；无法获得精确 tokenizer 时使用明确标记的保守估算器。Assembler 按固定优先级裁剪并记录过程，裁剪后仍超限才返回 `CONTEXT_TOO_LARGE`。不同模型的快照可以引用相同来源，但最终组合内容、token 估算和哈希分别冻结。

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
```

支持：

- BYOK 供应商、Endpoint 和模型配置。
- 岗位默认模型和 fallback 顺序。
- 推理强度和执行预算。
- 连通性、模型可用性和能力验证。
- 配置导入导出；导出不包含密钥。
- 将产品配置转换为 DSH 所需配置，但不让用户直接编辑 DSH profile。

商业 Alpha 只承诺单次运行预算：运行前原子预留最大预算，运行中采集实际 usage，达到硬上限时请求取消，终态后按实际使用结算并释放余额。若取消后结果未知，预留保持锁定直到恢复或人工处置。每日并发总预算、跨模型价格优化和组织级账本延后到真实使用验证后实现。

费用记录必须冻结 `priceTableVersion`、币种、模型计价单位、生效时间和运行时估算结果。后续价格表更新不得重算历史 `usage_records`。预算超限默认取消当前 Run 并将 Attempt 标为 `BUDGET_EXCEEDED`，不得在未获用户批准时自动切换到更昂贵模型。

### 6.7 Secret Store

商业 Alpha 固定为 per-user 安装，Launcher、team-hub、Workbench 和 DSH Runtime 以完成安装和配置的同一 Windows 用户身份运行，不安装为 LocalSystem 或其他服务账户。首版使用 Windows Credential Manager 或当前用户作用域 DPAPI 保护密钥：

- team-hub 只保存 `secretRef`，不保存明文。
- Runtime 在获得授权后按需解析密钥。
- 密钥只注入需要它的执行进程和工具。
- 提示词、日志、异常、审计、诊断包和能力包均不得包含密钥。
- 新增、更新、轮换和删除密钥写入不含密文的审计记录。
- 无法访问或解密密钥时 fail closed，并显示可操作错误。

密钥轮换只影响轮换后创建的 Run；在途 Run 保持其启动时解析到进程内的短生命周期凭证，不在中途替换。未来若引入 per-machine 安装或 Windows Service，必须先增加独立服务身份、ACL、凭证迁移和恢复设计，不能直接复用 per-user `secretRef`。

`SECRET_UNAVAILABLE` 表示本地凭证库或账户问题，`AUTH_FAILED` 表示供应商拒绝已成功解析的凭证，两者不得混为一类。

### 6.8 DSH 工具强制面与 Legion 权限策略

工具执行不在 Legion 外围重造一条平行管线。Legion 负责控制面策略和审批事实，DSH 负责 Agent Loop 内不可绕过的执行强制：

```text
Legion/team-hub 控制面
  EmployeeManifest + TeamPlan + UserPolicy + TaskContext
  → 生成 Run 权限档位、静态 hard floor 和动态策略
  → DshRuntimeAdapter 安装到目标 Agent/Session

DSH 执行面
  Agent Tool Call
  → tools/pre-execute           动态 allow / deny / ask；静态禁令提前拒绝以避免无效询问
  → ctx.approval                仅 allowed-once 放行
  → ctx.tools.guard()           静态、同步、最终单调拒绝
  → ctx.sandbox                 文件/进程强制执行
  → Tool Execution
  → tools/result                不可变结果观察与审计投影
```

固定映射：

| Legion 语义 | DSH 强制点 | 约束 |
|---|---|---|
| hard floor、禁止工具、禁止越界路径 | `tools/pre-execute` 提前拒绝 + `ctx.tools.guard()` 最终复核 | Guard 只做同步、确定性拒绝；后续流程不可撤销 |
| allow-by-policy、allow-for-task、动态 deny | `tools/pre-execute` | 调用 F-02 纯策略；team-hub 不可达或策略异常时 deny |
| ask、allow-once | `tools/pre-execute` → `ctx.approval` | Legion answerer 把请求写入审批箱；只有 `allowed-once` 执行 |
| 无人值守禁止询问 | `approval/policy=never` | DSH 在 answerer waterfall 前拒绝 |
| 会话权限档位 | `ctx.permissionPresets` | 绑定 sandbox mode 与 approval policy，并在 Run 快照中冻结 |
| 文件和子进程约束 | `ctx.sandbox` 及 sandbox-aware executor | 必须探测实际后端和 enforcement；仅有配置名不算生效 |

现有 `team-hub/permission-engine.mjs` 保持为策略核心并扩展 canonical operation 与审批哈希，不搬出 team-hub、不重复定义 F-02 的五种模式。DshRuntimeAdapter 内新增 DSH 侧策略插件和 approval answerer。

权限至少覆盖：

- 文件读写范围。
- Git 和 worktree 操作。
- 命令执行。
- 网络访问。
- MCP 工具。
- 外部 API 读取与写入。
- 发布、付款、删除等高风险动作。

审批绑定不可变 `ToolExecution` 参数的 canonical operation 哈希；任一授权关键字段变化都会使审批失效。DSH `tools/pre-execute` 不允许改写工具参数，因为审计、UI 和实际执行必须看到相同输入。Legion 如需改变参数，只能拒绝当前调用并要求模型或工具定义产生一个新的 Tool Call，不能在审批后静默改写。

canonical operation 明确定义：Schema 版本、domain separator、固定键集合与顺序、Unicode NFC、路径绝对化与分隔符、Windows 大小写规则、数字和空值表达。授权主体包含 scope、actor、action、target、taskId、toolName、callId 和不可变工具参数；attemptId、UI 文案、时间戳等观察 metadata 不参与授权哈希。原始输入和 canonical 输入同时保存，执行只使用与哈希一致的不可变参数。

无人值守模式下，要求人工审批的操作默认拒绝或保持等待，不自动降级为允许。legacy 路径在完成 DSH 强制面接线前禁止高风险工具；“未批准高风险写操作为零”只在该门禁满足后成为发布指标。

强制面的可用性语义与不变量固定如下：

- 策略门与审批 answerer 必须自带超时，并分别覆盖连接阶段与响应阶段。DSH 会在异步门 settle 之后重新检查取消，但不会放弃挂起的 promise：team-hub 进程存活却不响应（SQLite 卡住、事件循环阻塞、请求排队）时，工具调用会无限期挂起。超时必须 fail closed——策略门 deny、answerer 返回 `unavailable`——并写入 audit。超时值属于配置 Schema。
- team-hub 不可达时 answerer 不得“等 team-hub 恢复后再询问”，等待会突破 Run 的期限约束；该情形按 §6.3 的 Runtime 健康表处理，不把不可达伪装成待审批。
- F-02 的 `allow-once` 是按 canonical operation 哈希的一次性决定，DSH 的 `allowed-once` 是按 `callId` 的一次性授权。answerer 命中 Legion 已批准决定时，消费必须由 team-hub 执行原子 CAS（`approved → consumed`），同一哈希只能成功一次，CAS 失败即 deny。同一 Attempt 内模型对同一目标发出参数完全相同的并发重复调用不得放行两次。
- 可测不变量：任何已由 `tools/pre-execute` 放行且获得 `allowed-once` 的调用，不得再被 `ctx.tools.guard()` 拒绝。guard 只有降级语义、没有 allow 语义，出现“人工已批准但仍被 guard 拒绝”即视为强制面配置错误，必须能由审计定位到具体强制点。
- `tool_calls` 必须记录决定来源（pre-execute / guard / approval / sandbox 兜底）；否则事后无法区分策略拒绝与沙箱兜底拒绝，而这两类的修复动作不同。

### 6.9 DSH 强制面的归属、分发与升级

§6.8 的映射要成为安全保证，前提是强制面挂载在正确的组合平面上。DSH 逐层 patch 组合：`dsh-base` bundle 打底，模式 bundle（web-app / headless）与用户 profile 层在其上覆盖；host 组合拥有 registry 本身、sandbox 与审批栈、持久化和模型路由，agent preset 则按 session 挂载。因此归属固定为：

| 组件 | 所属平面 | 内容 |
|---|---|---|
| Legion DSH 组合补丁层 | host 组合 / profile 层 | ToolGuard hard floor、`tools/pre-execute` 策略 listener、approval answerer、Legion 自有 permission preset 表 |
| Legion 员工 agent preset | agent 平面，按 session 挂载 | 岗位工具集、persona、提示段、skill 引用 |

规则：

- 静态 hard floor、策略 listener、approval answerer 与 preset 表必须位于 host 组合补丁层，不得只放在 agent preset。preset 按 session 挂载且可替换、可扩展、可被 shadow，把安全下限放在其中等于让“不可绕过的下限”取决于当前 session 恰好挂了哪个 preset。
- agent preset 只承载岗位能力，不提供任何服务；确需提供服务时必须位于带 `isolate` realm 的 group 内，避免与其他 preset 在 root realm 撞名而被挂载期拒绝。
- Legion 必须声明自己的 permission preset 表，不复用 DSH 默认表。默认表把 `workspace-write`↔`ask` 与 `danger-full-access`↔`never` 绑定，若按默认表实现“无人值守 = `approval/policy=never`”，沙箱会同时被降级为 `danger-full-access`，与 §10 的最小权限要求直接冲突。首版至少定义 `legion-attended`（workspace-write + ask）与 `legion-unattended`（workspace-write + never）。
- 补丁层不得编辑或覆盖 DSH 随部署分发的 preset 安装，只能通过产品自己的 profile/补丁层注入；升级必须重新应用并验证，不得假定 patch 锚点不变。
- 组合补丁层随 `dshVersion` 一起进入版本清单（§9.1）并纳入 DSH 升级门禁（§9.3）。DSH 升级会改变 bundle 结构与 patch 锚点，补丁层静默失效比 API 变化更隐蔽。
- Runtime Manager 启动时校验补丁层已成功应用且强制面已生效；未生效按 `incompatible` 处理，禁止自动执行。
- approval policy 与 preset 是按 session 可变旋钮（`setApprovalPolicy` 是唯一写路径，重放会重建覆盖）。承载某 Run 的 session 在 Run 期间禁止改写这两个旋钮；确需改写时必须写入 audit 并作为 Run 事件记录，否则 §6.8 的“在 Run 快照中冻结”无法兑现。

### 6.10 Product Launcher

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

### 6.11 产品配置与目录

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

### 6.12 审计、用量和可信交付

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

除单次运行审计外，Product Runtime 还必须提供最小系统指标：队列深度、最老待办年龄、活跃 lease、租约过期率、Attempt 重试率、Dead Letter 数量、Runtime 可用率、模型错误率和升级结果。商业 Alpha 默认仅本地展示；远程心跳必须显式选择加入、只发送脱敏聚合状态，并允许用户随时关闭。

### 6.13 Pack Manager

Pack Manager 首版只负责可验证安装和 TeamPlan 编译，不负责在线市场、付费分发或远程代码执行。能力包包含：

- `PackManifest`：包 ID、类型、语义版本、协议版本、依赖、兼容条件和内容哈希。
- 只读内容：EmployeeManifest、流水线模板、提示词、Schema、规则、测试样本和文档。
- 明确声明的 Runtime 能力、工具、权限和数据依赖。
- 安装、启用、停用和升级记录。

安装时验证签名/来源、内容哈希、`packProtocolVersion`、依赖和产品兼容性；解析成功后生成不可变 `CompiledTeamPlan`。运行中的目标始终使用创建时快照，能力包升级只影响之后创建的目标。能力包不得携带密钥，不得绕过 ToolGuard、权限预设和审批，也不得把 Git 文件变成运行状态事实源。

软件交付团队作为内置首包验证协议；跨境电商团队在商业 Alpha 底座通过后接入。在线能力包市场和第三方包信任模型另行立项。

### 6.14 Product API 兼容性

Workbench 与 team-hub 也是长期边界。商业 Alpha 为同一安装包内精确版本组合，暂不强制把全部现有路由迁移到 `/api/v1`；team-hub 的 `/api/config` 必须返回 `productApiVersion`、`schemaVersion` 和 capabilities，Workbench 启动时进行精确主版本校验。

- 主版本不匹配：进入只读不兼容页，不发送写请求。
- 主版本匹配但可选 capability 缺失：隐藏或禁用对应功能并说明原因。
- 写 API 的请求/响应 Schema 进入契约测试，禁止只依靠 TypeScript 前端类型。
- 出现独立客户端、公开 SDK 或不同步部署需求时，再把新 API 放入显式版本前缀；不为尚未存在的外部消费者一次性迁移全部旧路由。

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
| `agent_run_events` | Run 内部详细事件；不是第二条公开业务流，大体量 delta 可按保留策略压缩 |
| `tool_calls` | 工具请求、权限决定与决定来源、幂等键和结果 |
| `usage_records` | token、费用估算和耗时 |
| `artifacts` | 产物位置、类型、内容哈希和来源 |
| `secret_refs` | 密钥引用、用途和元数据，不含密文 |
| `schema_migrations` | 数据库迁移版本和执行结果 |

已有权限、审批和 audit 表优先扩展复用；只有现有语义无法表达时才新增表。所有迁移必须幂等，旧数据库升级前自动备份。

`agent_run_events` 与 audit 的边界固定如下：

- `agent_run_events` 保存模型 delta、工具阶段和 Adapter 诊断等 Run 内部明细，以 `runId + seq` 排序。
- audit 保存 Task/Attempt/审批/交付等产品状态变化及必要的 `runId`、事件范围引用。
- `/api/events` 继续复用 audit，作为 Workbench 唯一公开实时业务流，并沿用 F-01 的 scope 与游标语义。
- Workbench 需要查看 Run 明细时通过按 `runId` 分页的查询 API 获取，不订阅第二条 SSE。

team-hub 在增加上述实体前，先把数据库初始化、运行仓储、权限仓储、审计投影和 HTTP 路由从 `server.mjs` 提取为边界清晰的模块；提取必须保持现有 API 和数据库兼容，不与新表一次性混改。

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
→ 已验证可恢复且无 in-flight 未知工具：继续同一 run 并追加审计
```

“继续同一 Run”不是首版预设承诺。阶段 2 必须用 DSH continuable session 做验证性任务，证明持久化身份、权限继承、事件续接、取消和工具边界均满足契约；验证失败则 `recover()` 只返回“新 Attempt 重试”或 `UnknownOutcome`。崩溃瞬间存在 in-flight 外部写工具时，无论会话是否可继续，都必须先查询外部结果或进入人工处置。

### 8.3 高风险工具调用

```text
DSH 产生不可变 ToolExecution
→ ToolGuard 执行静态 hard floor
→ pre-execute 查询 F-02 策略并计算 canonical operation 哈希
→ Permission Engine 判定 ask
→ Run 进入 AwaitingApproval，DSH approval answerer 等待 team-hub
→ 用户批准同一哈希并返回 allowed-once
→ DSH 执行原始不可变参数并记录幂等键
→ tools/result 投影结果和审计
→ Run 回到 Running
```

审批等待期间 heartbeat 继续，并按 §6.4 的审批 TTL 续期；TTL 到期自动拒绝并转入人工处置。批准与消费共用同一原子 CAS，同一 canonical 哈希只能放行一次，失败即 deny。

Legion 生成外部写操作幂等键，基础公式为：

```text
SHA-256("legion-tool-effect-v1" || workspaceId || taskId || attemptId || callId || canonicalOperationHash)
```

同一 Attempt 的同一 Call 重放得到相同键；新 Attempt 得到新键。若目标外部系统不支持幂等键或可靠结果查询，发生超时、断连或崩溃后不得自动重试该写操作，只能进入 `UnknownOutcome`。

## 9. DSH 版本治理与产品升级

### 9.1 版本清单

每个产品版本携带不可变清单：

```json
{
  "productVersion": "0.3.0",
  "legionVersion": "0.3.0",
  "dshVersion": "0.8.3",
  "dshCompositionPatchVersion": 1,
  "schemaVersion": 12,
  "runtimeContractVersion": 1,
  "packProtocolVersion": 1,
  "channel": "stable"
}
```

`dshCompositionPatchVersion` 标识 §6.9 的 Legion DSH 组合补丁层版本。它与 `dshVersion` 强绑定：补丁层通过 patch 锚点作用于 DSH bundle，锚点随 DSH 版本变化，因此两者必须成对验证，不允许出现“DSH 已升级但补丁层仍是旧锚点”的组合。

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
- §6.9 组合补丁层在目标 DSH 版本上成功应用，且强制面（ToolGuard、pre-execute、approval answerer、permission preset 表与 sandbox）回归通过；补丁锚点失效视为门禁失败。

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

组合补丁层随程序版本原子切换后重新应用并自检（§6.9）；补丁无法应用或强制面未生效时升级失败并保留旧程序版本，不得带病启动。

商业 Alpha 支持从当前 stable 的 N-1 版本升级到 N，不承诺跨多个主版本直接升级；更旧版本先按逐级升级或离线迁移处理。升级前备份至少保留最近 3 个成功快照和 30 天，取更大者；每个 stable 候选版本必须在干净机器和真实备份副本上完成自动恢复演练，产品进入稳定运营后至少每季度抽样执行一次恢复演练。

Windows 安装采用 per-user 模式并处理文件占用、长路径、Defender 扫描延迟和 Node 子进程树退出。程序切换使用同一卷内的版本目录和原子活动指针/重命名；SQLite、日志和工作区不放入被替换的 InstallDir。无法释放文件句柄时升级应安全中止并保留旧版本，而不是部分覆盖。

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
│   ├── adapters/dsh/
│   └── dsh-composition/  # §6.9 host 平面补丁层与员工 agent preset（随 dshVersion 版本化）
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
│   ├── repositories/     # 数据库初始化与领域仓储（渐进提取）
│   ├── runtime/          # Attempt、Run、lease 与恢复 API
│   ├── permissions/      # F-02 策略、审批与 canonical operation
│   └── events/           # audit 与 F-01 SSE 投影
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
- `PRT-008`：冻结 Task、Attempt、Run、Session、Lease、TeamPlan 和 Context Snapshot 术语。
- `PRT-009`：记录黄金流程的成功率、人工介入、token、费用估算、端到端耗时和峰值资源基线。
- `PRT-010`：记录当前 DSH 组合层、profile 层、bundle 结构与 patch 锚点基线，作为 §6.9 补丁层的对照起点。
- `PRT-011`：确定 DSH 分发形态：内置 Node 运行时、DSH 代码与依赖树的打包方式、首次运行是否必须联网、`DSH_HOME` 位置、preset 安装位，以及升级时如何保持 shipped preset install 不被编辑。

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
- `PRT-109`：定义 Runtime Contract 精确主版本校验和 capabilities 协商。

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
- `PRT-211`：验证 DSH continuable session 的身份、权限继承、事件续接、取消和恢复边界。
- `PRT-212`：接入最小 DSH 强制面：ToolGuard hard floor、pre-execute fail-closed 和 approval answerer。
- `PRT-213`：探测 DSH sandbox backend、sandbox-aware executor 和实际 enforcement，不满足要求时禁止执行。
- `PRT-214`：按 §6.9 建立 Legion DSH 组合补丁层（host 平面：ToolGuard hard floor、pre-execute 策略 listener、approval answerer、Legion 自有 preset 表）与员工 agent preset，并纳入 `dshCompositionPatchVersion`。
- `PRT-215`：实现补丁层应用与强制面生效的启动自检；未生效时 Runtime Manager 按 `incompatible` 处理并禁止自动执行。

完成标准：同一任务通过两条路径得到等价任务状态、结构化结果和产物，且敏感信息不出现在输出中。

### 阶段 2.5：商业薄垂直切片

- `PRT-251`：实现只管理必需进程的最小 Product Launcher。
- `PRT-252`：复用现有 Workbench 模型配置，增加产品化校验和用户可见错误。
- `PRT-253`：只迁移单员工、无自动交接的黄金任务到 RuntimeAdapter。
- `PRT-254`：完成 per-user 数据目录、Secret Store 最小闭环和一键启动。
- `PRT-255`：在隔离测试空间完成安装、运行、取消、重启和诊断验证。
- `PRT-256`：让内部设计伙伴独立完成一次真实但低风险的软件任务。
- `PRT-257`：Launcher 负责 DSH 运行时与组合补丁层的首次安装、应用自检和修复入口（PRT-011 的分发形态在此落地）。
- `PRT-258`：冻结本阶段产出的进程清单、per-user 目录布局、配置 Schema 和 Secret Store 接口，作为后续阶段沿用的契约。

完成标准：不依赖终端和 DSH 配置知识，设计伙伴可以安装产品、配置 BYOK、启动一个受限数字员工并查看结果。未达到该标准前，不启动阶段 3 的大规模编排提取。

阶段 2.5 的最小实现是最终实现的子集，不是一次性脚手架。PRT-251 与 PRT-254 的进程清单、目录布局、配置 Schema 和 Secret Store 接口即为阶段 5、阶段 7 沿用的契约，后续只做增量扩展，不重新设计，避免同一交付物做两遍。

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
- `PRT-313`：为 task lease 增加 team-hub 权威时间、`leaseEpoch` 和过期 epoch 拒写。
- `PRT-314`：验证 WAL、`busy_timeout` 和原子领取事务的多 worker 并发语义。
- `PRT-315`：按仓储、状态机、workspace、验收和交接边界拆分 `plugins/src/index.ts`，每次只迁移一个切片。
- `PRT-316`：先提取 team-hub 数据库初始化、运行仓储、审计投影和路由模块，再新增运行实体。

完成标准：强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。

### 阶段 4：上下文边界

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
- `PRT-411`：定义冻结时点、运行中更新进入下一 Attempt 的规则。
- `PRT-412`：标记不可信来源并验证其不能扩大权限或改变审批策略。
- `PRT-413`：实现 canonical JSON、模型相关 tokenizer 和保守估算降级。

完成标准：任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因。

### 阶段 5：模型和密钥配置

- `PRT-501`：实现 ModelProfile 数据模型和 API。
- `PRT-502`：实现岗位模型绑定和 fallback。
- `PRT-503`：实现单次运行与岗位预算策略；每日总预算与组织级账本延后（见 §6.6）。
- `PRT-504`：实现模型连通性与能力测试。
- `PRT-505`：实现 Windows Secret Store。
- `PRT-506`：迁移现有非敏感模型配置。
- `PRT-507`：实现 Workbench 模型设置页面。
- `PRT-508`：实现配置导入导出但排除密钥。
- `PRT-509`：覆盖密钥读取、轮换、删除和泄漏测试。
- `PRT-510`：实现单次运行预算原子预留、结算、取消和 Unknown Outcome 锁定。
- `PRT-511`：冻结价格表版本、币种、计价单位和生效时间。

完成标准：用户只在 Legion 中完成 BYOK 配置，明文密钥不进入 team-hub 业务数据、日志和诊断包。

### 阶段 6：工具、权限和审批

- `PRT-601`：定义工具能力描述和风险等级。
- `PRT-602`：实现 DSH Enforcement Bridge 与统一 ToolRequest 投影。
- `PRT-603`：接入 EmployeeManifest 工具白名单。
- `PRT-604`：实现文件和工作目录范围限制。
- `PRT-605`：实现命令、网络和 MCP 权限控制。
- `PRT-606`：区分外部 API 读取与写入权限。
- `PRT-607`：接入审批箱和无人值守策略。
- `PRT-608`：审批绑定规范化操作哈希。
- `PRT-609`：实现字段变化后审批失效。
- `PRT-610`：持久化工具调用、决定与决定来源、结果和幂等键。
- `PRT-611`：扩展 F-02 canonical operation，替换键序敏感的 `JSON.stringify` 判等。
- `PRT-612`：实现 Legion 权限语义到 ToolGuard、pre-execute、approval、permission preset 和 sandbox 的固定映射。
- `PRT-613`：保证审批、UI、审计与执行看到同一不可变工具参数，禁止 pre-execute 改写。
- `PRT-614`：在新强制面完成前禁用 legacy 高风险工具，并建立发布门禁。
- `PRT-615`：实现审批 TTL、过期自动拒绝，以及与 lease/heartbeat 的交互（§6.4）。
- `PRT-616`：实现 `allow-once` 的 team-hub 原子 CAS 消费，防护同一 Attempt 内相同 canonical 哈希的并发重复调用。
- `PRT-617`：实现策略门与 approval answerer 的连接/响应双段超时、`unavailable` fail-closed 语义和决定来源审计。
- `PRT-618`：声明 `legion-attended` 与 `legion-unattended` preset 表，禁止复用 DSH 默认表。
- `PRT-619`：实现 Run 期间 approval policy 与 preset 的冻结，以及改写审计。
- `PRT-620`：验证“已由 pre-execute 放行且获得 `allowed-once` 的调用不得被 ToolGuard 拒绝”的一致性不变量。

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
- `PRT-711`：实现 Runtime 健康状态到产品状态和 Orchestrator 行为的映射。
- `PRT-712`：本地展示队列、lease、重试、死信和 Runtime 可用率指标。
- `PRT-713`：实现默认关闭、显式选择加入的脱敏健康心跳。

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
- `PRT-812`：实现 N-1 升级窗口、备份保留和定期恢复演练。
- `PRT-813`：覆盖 Windows 文件占用、Defender 延迟、长路径和子进程树退出。

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

### 阶段 10：能力包协议

- `PRT-1001`：定义 PackManifest、类型、语义版本和协议版本。
- `PRT-1002`：实现内容哈希、签名/来源、依赖和兼容性预检。
- `PRT-1003`：实现安装、启用、停用和升级记录。
- `PRT-1004`：实现不可变 CompiledTeamPlan 和运行中版本固定。
- `PRT-1005`：验证能力包不能携带密钥、扩大权限或绕过 DSH 强制面。
- `PRT-1006`：将软件交付团队整理为首个内置能力包。

完成标准：更新能力包不会改变运行中目标；不兼容、缺依赖、哈希错误或越权包在创建目标前失败。

## 13. 里程碑与优先级

| 里程碑 | 包含阶段 | 可交付结果 |
|---|---|---|
| M0 基线冻结 | 阶段 0 | 当前系统可重复验收和比较 |
| M1 Runtime 边界 | 阶段 1～2 | DSH 被稳定接口隔离，新增代码不再直接依赖 DSH；host 平面强制面补丁层就位并纳入版本清单 |
| M1.5 设计伙伴切片 | 阶段 2.5 | 一键启动单个受限员工完成真实低风险任务 |
| M2 可恢复编排 | 阶段 3～4 | 多员工编排与上下文可测试、可回放、可恢复 |
| M3 产品配置与安全 | 阶段 5～6 | 用户可安全配置模型并控制工具权限 |
| M4 完整一键运行 | 阶段 7 | 客户无需开发环境和终端运行完整团队 |
| M5 可控升级 | 阶段 8 | DSH 经内部验证后可灰度、可回滚推送 |
| M6 商业 Alpha | 阶段 9 | 首批真实用户完成可信软件交付 |
| M7 能力包协议 | 阶段 10 | 软件交付团队成为版本化内置包 |
| M8 行业扩展 | 后续独立计划 | 接入跨境电商数字团队 |

第一实施批次锁定在阶段 0～2，并立即接阶段 2.5 薄垂直切片。其目的既是阻止耦合继续扩散，也是在大规模重构前获得真实用户验证。

Program 级停止条件：M1.5 评审时，如果设计伙伴仍不能在无开发协助的情况下完成“安装 → BYOK → 单员工任务 → 查看结果 → 重启恢复”，则暂停阶段 3～4，不继续投入多员工编排重构；项目收缩为 Launcher、模型配置、受限单员工、诊断和升级产品化，编排提取另行立项。只有 M1.5 达标且设计伙伴确认交付具有持续使用价值，才进入 M2。

## 14. 测试策略

### 14.1 单元与契约测试

- Runtime Contract 的正常、失败、取消、超时和恢复。
- 状态机合法迁移、非法迁移和幂等。
- 上下文确定性、预算、过滤、脱敏和哈希。
- 权限决策、审批失效和无人值守 fail closed。
- 配置 Schema、密钥引用和日志脱敏。
- lease epoch、过期 worker 拒写、权威时钟和 SQLite 并发领取。
- 取消幂等以及取消与完成竞态。
- Product API 主版本、capabilities 和写 API Schema。
- F-01 单一公开事件流与 F-02 决策模式回归。
- 审批 TTL 到期自动拒绝，以及审批等待期 lease/heartbeat 行为。
- `allow-once` 原子 CAS 消费，以及同一 Attempt 内相同 canonical 哈希并发重复调用只放行一次。
- 策略门与 answerer 在连接超时、响应超时、team-hub 不可达三种情形下的 fail-closed 行为。
- pre-execute 放行与 ToolGuard 拒绝的一致性不变量。
- 强制面决定来源（pre-execute / guard / approval / sandbox）可归因。

### 14.2 新旧对拍

对固定黄金任务比较：

- 任务状态序列。
- 岗位、模型和提示输入。
- 结构化结果。
- 文件产物和 Git diff。
- 交接、审批和审计。
- 错误分类与用户提示。
- token、费用估算、端到端延迟和资源消耗相对基线的变化。

模型输出允许文本差异，但状态语义、关键字段、权限行为和交付产物必须满足同一验收契约。

### 14.3 故障注入

- DSH 启动失败或运行中退出。
- 模型鉴权失败、限流和超时。
- Tool Call 前后断电或进程终止。
- team-hub 暂时不可达。
- SQLite busy、磁盘空间不足和日志写入失败。
- Launcher 重复启动和端口占用。
- 升级包损坏、迁移失败和新版本健康失败。
- 旧 lease worker 恢复后尝试提交迟到结果。
- in-flight 外部写工具发生断连且目标系统不支持幂等键。
- team-hub 进程存活但不响应（SQLite 卡住、事件循环阻塞、请求排队）时，策略门与 answerer 挂起并最终超时 fail closed。
- 审批等待期间 worker 崩溃或 lease 到期，不得导致同一 Task 被重复执行。
- DSH 升级后组合补丁层锚点失效或强制面未生效，产品拒绝自动执行而不是带病运行。

### 14.4 安全测试

- 密钥不出现在 API、数据库正文、日志、异常、诊断包和提示快照中。
- 员工无法访问 Manifest 之外的路径、工具和网络能力。
- 未批准或审批哈希失效的高风险操作无法执行。
- 非回环访问未认证时被拒绝。
- DSH sandbox 配置存在但实际 backend/enforcement 不可用时禁止执行。
- 不可信 Context Source 不能改变权限档位、工具白名单和审批结果。
- 无人值守 preset 不得把 sandbox 降级为 `danger-full-access`；`legion-unattended` 必须保持 workspace-write。
- 承载 Run 的 session 在 Run 期间无法改写 approval policy 或 preset，任何改写都留下审计记录。
- host 平面强制面缺失或未生效时，Agent 不能获得未受限的工具执行能力。

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

- 优先建立边界和薄垂直产品切片，再扩展可靠编排、配置、安全、安装和升级能力。
- 不自研完整模型 Agent Loop。
- 不复制整个 Legion 或建立长期双轨产品。
- DSH 升级由内部完成兼容性和黄金流程验证后，随产品版本灰度推送。
- 软件交付数字团队先验证商业闭环，跨境电商能力包在公共产品底座稳定后继续建设。

这一决策同时满足短期上市速度和长期可替换性：DSH 继续作为发动机，但客户购买、配置和使用的是完整的 Legion 数字团队产品。

---

## 附录 A：阶段 0～1 已落地指针（**回填，不改设计**）

> 本节由阶段 0～1 收口时**追加**，只记录「本设计里的哪一条已经落到哪个文件」，
> 不修改任何前述设计内容。设计如与本节冲突，**以设计为准**。
> 采集于 2026-09-11；全量 CI `run-ci --only env,boundary,deps,build,test,doc` 六阶段 PASS，
> `test` **46 套件 / 1217 用例**（复现见 `docs/STATUS.md`）。

### A.1 已交付（阶段 0～1）

| 任务 | 落地物 | 验证 |
| --- | --- | --- |
| `PRT-001`、`PRT-003` | `docs/superpowers/prt/PRT-001-topology-inventory.md`、`PRT-003-config-secret-inventory.md` + `prt-001-003-inventory.json` | `prt-topology`（20 例） |
| `PRT-002`、`PRT-108` | `scripts/ci/dsh-boundary.mjs`（执行面依赖棘轮）+ `dsh-boundary-baseline.json` | `boundary` 阶段 + `dsh-boundary`（22 例） |
| `PRT-004` | `scripts/prt/golden-flow.mjs`（GF-001）+ `PRT-004-golden-flow.md` | `prt-golden-flow`（14 例） |
| `PRT-006` | `scripts/prt/backup-restore-verify.mjs` + `docs/PRT-006-evidence/` | `prt-backup`（14 例） |
| `PRT-007` | `scripts/prt/baseline-snapshot.mjs` + `prt-007-baseline.json` | `prt-baseline`（16 例） |
| `PRT-008`、`PRT-010` | `docs/superpowers/prt/PRT-010-dsh-composition-baseline.md` + `prt-010-composition-baseline.json` | `prt-composition`（22 例） |
| `PRT-009` | `scripts/prt/baseline-measure.mjs` + `prt-009-baseline.json` | 机器测量部分；`pending` 段留空 |
| `PRT-011` | `docs/superpowers/prt/PRT-011-dsh-distribution-decision.md` | **已裁决：路线 C** |
| `PRT-101`～`PRT-106`、`PRT-109` | `runtime/contracts/`（`index.mjs` + `index.d.mts` + `errors` / `model` / `run` / `adapter`） | `runtime-contract`（62 例） |
| `PRT-107` | `runtime/contracts/fake-adapter.mjs` | 同上；含六条编排路径模拟 |

**§6.4「重试创建新 Attempt、不覆盖历史」已由代码固定**：终态仲裁器拒绝第二个终态，
重试必须换 `runId`（新 Attempt → 新 Run）。见 `runtime/contracts/run.mjs`。

**阶段 1 完成标准已满足**：`runtime/contracts/fake-adapter.test.mjs` 的
`runOrchestration()` 在**不启动 DSH** 的前提下跑完正常 / 限流重试 / 取消 / 超时 /
崩溃恢复 / 协议违规六条路径。

### A.2 三条对设计有实际影响的实测结论

1. **§6.10「所有环境变量必须在配置 Schema 中声明」已满足**——声明缺口为 0
   （`scripts/config/scan.mjs --check` PASS，97 个疑似字面量全部已处理）。
   该项不需要再排任务；单测已锁定，缺口复现即红。
2. **数据落点越界**：4 个 path 字段的默认值落在安装目录内
   （`TEAM_HUB_DB=team-hub/team.db` + whiteboard 三处）。安装目录会被升级覆盖 →
   需由 `DataDir` 承接（`PRT-505` / `PRT-257` 输入）。
   反过来说明 DSH 侧位置是对的：`$DSH_HOME/.credentials.yaml` 不在安装目录内，
   且其 `{version, refs, records}` 结构正是 `secretRef` 所指的既有机制 →
   **`PRT-505` 应复用它，不要另建密钥库**。
3. **`PRT-006` 的验收口径需要修正**：`audit.seq` **允许有缺口**
   （分配器为 `MAX(seq)+1`，回滚后作废号不回填；现场库实测 1 处）。
   验收应为「恢复前后**缺口集合**一致」，而非「连续」。

### A.3 已裁决

- **`PRT-011`：路线 C** —— 依赖 `@deepseek-ai/dsh` npm 包（`0.1.5-rc.2`、MIT、
  `bin.dsh`），由 Launcher 装进 `DataDir` 并原子切换。
  实测当前部署是**开发布局**（`$DSH_HOME` 下 244 个 junction 指向源码 checkout），
  checkout ≈ 1845 MB——路线 A「内置完整运行时」的代价即在此。
  仍待回答：Legion 自身四个 `file:` 包如何分发给用户；`0.1.5-rc.2` 是否可作对外依赖。

### A.4 未落地与顺延

| 项 | 状态 |
| --- | --- |
| `PRT-005` | 未启动 |
| `PRT-009` 的 `pending` 段 | 需一次**真实模型执行**才能采集 token / 费用 / 端到端耗时 / 峰值资源；工具拒绝编造，宁可留空 |
| `PRT-006` 的 `uploads/` 附件备份 | **未覆盖**（附件不在 SQLite 内，`VACUUM INTO` 覆盖不到；现场无 `uploads/`，无法验证） |
| `PRT-006` 跨版本恢复 | 顺延至 `PRT-316` 之后 |
| `PRT-201`～`PRT-214`（阶段 2） | 未启动 |
| `PRT-315`、`PRT-316`（阶段 3） | 未启动。评审闸门**已通过**：两个热点文件最近 40 个提交仅被触及 1 / 2 次（历史峰值 9 / 7），日更节奏已降温，可用 `scripts/prt/hot-file-churn.mjs` 复算 |

### A.5 阶段 3 启动前置（提醒）

- `PRT-316` 仍须排在 team-hub 启动期并发迁移加固（`0db37af`）**沉淀一个完整发布周期**之后。
- 阶段 3 的切片每个都要能独立对拍与回滚，不允许一次性重写两个大文件。〔§2.1、§11 迁移规则 3〕

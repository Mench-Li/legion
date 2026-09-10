# Legion 多智能体功能优化建议

> 文档状态：建议稿  
> 编写日期：2026-09-09  
> 适用项目：`D:\project\DSH\legion`  
> 参考项目目录：`D:\project\multi-agent`

## 1. 文档目的

本文基于对 `D:\project\multi-agent` 下五个多智能体项目的逐项分析，提炼适合 Legion 当前产品定位、技术栈和演进阶段的功能优化建议，并给出可追溯的代码参考、建议落点、实施顺序与验收标准。

参考项目包括：

1. `hermes-agent`
2. `openclaw`
3. `openworker`
4. `qm`
5. `teamai-cli`

本文不建议整体移植任一项目，而是优先借鉴经过验证的设计原则、状态模型和边界划分，再以 Legion 的 TypeScript、SQLite、React、DSH 插件和本地优先架构重新实现。

## 2. Legion 当前基础

Legion 已经具备以下基础能力：

- 基于空间的成员、任务、目标和代码仓库管理。
- chain、slice 等多智能体编排方式。
- 基于 Git worktree 和 `w/<taskID>` 分支的任务隔离。
- 人工关卡、任务暂停、审计、差异查看和重叠检测。
- 按角色选择模型，以及聊天、附件和上下文收集。
- 文件中心、受控网页抓取、规则、技能和授权管理。
- 经验草稿、召回、表决和晋升。
- 日历 CRUD、通知中心与 SSE 更新。

因此，下一阶段不宜重复建设基础任务看板或简单技能库，而应集中提升以下五个方面：

1. **可靠性**：事件恢复、幂等投递、失败治理和无人值守运行。
2. **治理能力**：操作级权限、常驻授权、审批和完整审计。
3. **智能质量**：上下文压缩、图增强召回和摩擦学习。
4. **可运营性**：统一配置、诊断工具、预算和用量统计。
5. **扩展能力**：连接器、执行后端、多 Harness 和多用户 ACL。

## 3. 参考项目分析

### 3.1 Hermes Agent

#### 项目定位

Hermes Agent 是一个跨 CLI、TUI、桌面端和消息渠道运行的通用 Agent Runtime，强调统一 Agent 核心、记忆与技能、子智能体、定时任务、浏览器和终端执行，以及多种模型后端。

#### 可借鉴能力

- 稳定的会话持久化和提示词前缀缓存。
- 基于 token 阈值的上下文压缩。
- 动态工具注册、可用性检查与渐进式工具披露。
- 本地、容器或远程执行后端的统一接口。
- 重启后可恢复的持久投递队列。
- 可复用的自动化蓝图。

#### 关键代码参考

| 能力 | 文件与位置 |
|---|---|
| 会话持久化与缓存稳定性 | `D:\project\multi-agent\hermes-agent\agent\session_persistence.py:29` |
| 上下文压缩入口 | `D:\project\multi-agent\hermes-agent\agent\turn_context_compaction.py:128` |
| 工具注册中心 | `D:\project\multi-agent\hermes-agent\tools\registry.py:368` |
| 工具集合解析 | `D:\project\multi-agent\hermes-agent\toolsets.py:262` |
| 执行环境基类 | `D:\project\multi-agent\hermes-agent\tools\environments\base.py:142` |
| 持久投递队列 | `D:\project\multi-agent\hermes-agent\cron\delivery_queue.py:134` |
| 同步等待投递结果 | `D:\project\multi-agent\hermes-agent\cron\delivery_queue.py:357` |

#### 对 Legion 的启示

Legion 应保持核心调度层精简，把工具、连接器和执行环境放在可组合的边缘层。会话压缩不能破坏原始记录，也不应把临时提示脚手架混入持久 transcript，否则会降低缓存复用率并增加重试时的不确定性。

### 3.2 OpenClaw

#### 项目定位

OpenClaw 是本地 Gateway、消息渠道、原生应用、插件与执行沙箱组成的平台，尤其重视可信控制面与不可信执行面的隔离、确定性策略和可靠消息交付。

#### 可借鉴能力

- 消息投递状态、回执、抑制和失败语义。
- 投递过程的幂等记录。
- 严格配置 Schema、旧配置检测和 Doctor 迁移。
- 自动化连续失败告警、冷却和自动禁用。
- 外部渠道身份配对。
- 插件 SDK 与执行沙箱边界。

#### 关键代码参考

| 能力 | 文件与位置 |
|---|---|
| 可靠回复投递 | `D:\project\multi-agent\openclaw\src\channels\turn\durable-delivery.ts:152` |
| 投递进度幂等存储 | `D:\project\multi-agent\openclaw\src\audit\message-delivery-progress-store.ts:294` |
| 严格配置 Schema | `D:\project\multi-agent\openclaw\src\config\zod-schema.ts:17` |
| Doctor 迁移注册表 | `D:\project\multi-agent\openclaw\src\commands\doctor\shared\legacy-config-migrations.ts:18` |
| 连续失败自动禁用 | `D:\project\multi-agent\openclaw\src\cron\service\auto-disable.ts:21` |
| 失败告警策略 | `D:\project\multi-agent\openclaw\src\cron\service\failure-alerts.ts:381` |
| 渠道身份配对 | `D:\project\multi-agent\openclaw\src\channels\plugins\pairing.ts:12` |

#### 对 Legion 的启示

SSE、聊天回复、任务完成通知和未来的外部渠道投递，应共享一套明确的状态机和幂等语义。配置升级也不应依赖人工阅读变更说明，应由 Schema、迁移预览和 Doctor 自动完成检测与修复建议。

### 3.3 OpenWorker

#### 项目定位

OpenWorker 是一个本地 AI Coworker 平台，提供安全角色、自动化、连接器和治理能力。其功能形态与 Legion 最为接近。

#### 可借鉴能力

- 硬性安全底线、一次授权、常驻规则和配置白名单组成的权限体系。
- 自动审批采用第二审查者和熔断机制。
- 无人值守任务遇到审批时进入 Inbox，而不是直接失败或静默跳过。
- 支持重启恢复、重叠跳过和运行历史的真实调度器。
- Prompt、技能、工具、权限和模型组合成声明式 Persona。
- MCP 配置合并、工具过滤、逐工具审批和 OAuth 管理。

#### 关键代码参考

| 能力 | 文件与位置 |
|---|---|
| 权限决策引擎 | `D:\project\multi-agent\openworker\coworker\permissions.py:282` |
| 任务期常驻规则 | `D:\project\multi-agent\openworker\coworker\permissions.py:500` |
| 自动审查器 | `D:\project\multi-agent\openworker\coworker\reviewer.py:315` |
| 审批 Inbox | `D:\project\multi-agent\openworker\coworker\inbox.py:99` |
| 权限审计 | `D:\project\multi-agent\openworker\coworker\audit.py:26` |
| 自动化调度器 | `D:\project\multi-agent\openworker\coworker\automation\scheduler.py:23` |
| ScheduledTask 与 TaskRun | `D:\project\multi-agent\openworker\coworker\automation\models.py:118` |
| 上下文压缩状态 | `D:\project\multi-agent\openworker\coworker\compaction.py:417` |
| Persona 清单 | `D:\project\multi-agent\openworker\coworker\personas\manifest.py:264` |
| MCP 配置 | `D:\project\multi-agent\openworker\coworker\mcp\config.py:26` |
| MCP 工具审批 | `D:\project\multi-agent\openworker\coworker\mcp\tools.py:46` |

#### 对 Legion 的启示

权限判断应成为统一基础设施，而不是分散在按钮、API 路由和 worker 分支中的条件判断。日历也应只是计划展示层，真正的调度状态、运行记录、补跑策略和失败状态需要独立建模。

### 3.4 QM

#### 项目定位

QM 是面向团队和多人协作的 Agent Harness。每个用户或房间拥有独立的记忆、文件、密钥、权限、定时任务、应用和沙箱，并支持多种编码 Agent 后端。

#### 可借鉴能力

- 多用户和多空间 ACL。
- 组织安全底线与空间策略合成。
- 命令级硬策略和提示注入筛查。
- 每空间可持久化的执行沙箱。
- 多 Harness 路由和模型可用性判断。
- token、费用和任务目标预算。
- 可替换的记忆策略。

#### 关键代码参考

| 能力 | 文件与位置 |
|---|---|
| ACL 接口 | `D:\project\multi-agent\qm\src\acl\acl-store.ts:37` |
| 安全策略合成 | `D:\project\multi-agent\qm\src\security\security-posture.ts:36` |
| 命令策略 | `D:\project\multi-agent\qm\src\policy\command-policy.ts:25` |
| Sandbox 接口 | `D:\project\multi-agent\qm\src\sandbox\sandbox.ts:136` |
| Sandbox 路由 | `D:\project\multi-agent\qm\src\sandbox\sandbox-routing.ts:37` |
| Harness 路由 | `D:\project\multi-agent\qm\src\harness\harness-router.ts:12` |
| 成本计量 | `D:\project\multi-agent\qm\src\harness\grind.ts:35` |
| 目标预算约束 | `D:\project\multi-agent\qm\src\harness\goal.ts:138` |

#### 对 Legion 的启示

Git worktree 只能提供代码修改隔离，不能替代进程、网络、凭证和文件系统安全沙箱。Legion 若从本地单负责人模式进入多人或网络部署模式，必须先补齐身份、ACL、预算和执行隔离。

### 3.5 TeamAI CLI

#### 项目定位

TeamAI CLI 通过 Git 在 Claude、Codex、Cursor、OpenCode、Hermes、DSH 等工具间同步技能、规则、文档、Agent、Hook 和 MCP 配置，并提供知识召回与学习能力。

#### 可借鉴能力

- Git 化的跨工具资源分发。
- 按角色、标签和来源订阅资源。
- BM25 与代码知识图谱结合的检索。
- 从用户中断、工具拒绝和重复纠正中提取摩擦经验。
- Hook 和 MCP 的声明式协调。
- 知识库健康度、摘要和报告。

#### 关键代码参考

| 能力 | 文件与位置 |
|---|---|
| 资源拉取与 revision 提交 | `D:\project\multi-agent\teamai-cli\src\pull.ts:347`、`:877` |
| Hook 统一协调 | `D:\project\multi-agent\teamai-cli\src\hooks.ts:1053` |
| BM25 基础评分 | `D:\project\multi-agent\teamai-cli\src\code-knowledge-recall.ts:46` |
| 图关系增强评分 | `D:\project\multi-agent\teamai-cli\src\code-knowledge-recall.ts:473` |
| 综合召回 | `D:\project\multi-agent\teamai-cli\src\recall.ts:342` |
| 会话摩擦收集 | `D:\project\multi-agent\teamai-cli\src\session-collector.ts:58` |

#### 对 Legion 的启示

Legion 已有技能和经验中心，不应再建立第二个互相竞争的数据权威。建议 team-hub 保持权威数据源，Git 只承担导入、导出、版本追踪和跨工具发布。

## 4. 功能优化总清单

### 4.1 P0：可靠性与治理基础

#### F-01 可恢复事件流与可靠投递

**目标**

将 SSE、聊天回复、任务通知和未来的渠道消息统一到可恢复、可去重、可审计的事件和投递模型中。

**建议设计**

- 统一事件 Envelope：`id`、`event`、`scope`、`seq`、`ts`、`payload`。
- 服务端维护单调递增的 scope sequence。
- 支持 `Last-Event-ID` 或显式 `sinceSeq` 恢复。
- 客户端按 `scope + seq` 去重，检测缺口后主动补拉。
- 投递状态至少区分：`pending`、`delivering`、`delivered`、`suppressed`、`failed`、`unknown`。
- 重启后只重放可确认未送达的记录；未知状态不得无条件重复发送。
- 投递回执和失败原因进入审计。

**Legion 建议落点**

- `team-hub/server.mjs:2008`：扩展 `broadcastAudit`。
- `team-hub/server.mjs:3266`：扩展 `/api/events`。
- workbench SSE 客户端：增加重连游标、去重和缺口恢复。
- 新增 `event_log`、`delivery_attempts` 或等价持久表。

**验收标准**

- 断网重连不会遗漏已提交事件。
- 同一事件重复到达不会重复更新 UI 或触发通知。
- 服务重启后可继续处理明确未完成的投递。
- 每次投递均能查询最终状态和尝试记录。

#### F-02 统一操作权限引擎

**目标**

把高风险操作的授权逻辑从各模块中抽离，形成统一、可解释、可审计的决策入口。

**建议设计**

- 权限模式：`deny`、`ask`、`allow-once`、`allow-for-task`、`allow-by-policy`。
- 设置不可被模型或自动审查器突破的硬性安全底线。
- 常驻规则至少绑定 `scope + actor + action + exact target`。
- 无人值守任务需要审批时，进入审批 Inbox 并暂停当前步骤。
- 自动审批必须使用独立审查上下文，并设置失败熔断和速率限制。
- 决策结果包含：允许与否、命中规则、决策者、原因、有效期和证据。

**首批纳管操作**

- 合并或推送代码。
- 删除和覆盖文件。
- 跨空间读取或写入。
- 外部网络访问和连接器调用。
- 创建或修改自动化计划。
- 使用凭证或执行高风险命令。

**验收标准**

- 所有纳管操作只能通过统一权限 API 获得决策。
- 一次授权不会泄漏到其他任务或目标。
- 常驻规则可以查看、撤销并追踪创建来源。
- 无人值守任务能在获批后从原步骤恢复。

#### F-03 配置 Schema、迁移与 Doctor

**目标**

建立单一、可验证、可迁移的配置系统，消除独立服务和 DSH 插件间的行为漂移。

**建议设计**

- 使用严格 Schema 定义全部配置和默认值。
- 配置层级明确为：内置默认值、用户配置、空间配置、进程参数。
- 明确每个字段的覆盖方向和安全限制。
- Doctor 提供检查、迁移预览、自动修复和脱敏后的有效配置输出。
- 旧字段迁移采用有序注册表并带版本号。
- 独立 team-hub 与 DSH 适配器共享同一业务处理器和契约测试。

**验收标准**

- 相同配置在独立服务和 DSH 宿主内产生相同行为。
- 非法字段启动前即可被定位到具体路径。
- 迁移可以预览且重复执行保持幂等。
- Doctor 输出不包含 token、密钥或完整凭证。

#### F-04 自动化调度与运行历史

**目标**

把现有日历数据面升级为真正的任务自动化系统。

**建议设计**

- `scheduled_tasks` 保存计划、时区、目标任务模板、启停状态和并发策略。
- `task_runs` 保存每次计划触发、开始、完成、失败、跳过和审批暂停记录。
- 默认采用 skip-on-overlap，避免同一计划并发堆积。
- 服务重启后按配置决定补跑、跳过或仅执行下一次。
- 支持一次性、周期性和手动补跑。
- 日历作为计划和运行结果的投影视图，而非唯一事实源。

**验收标准**

- 重启后计划不会丢失或重复触发。
- 长任务不会被同一计划重叠执行。
- 每次运行可以追溯到计划版本、目标、模型和最终产物。
- 暂停、恢复、补跑和禁用均写入审计。

#### F-05 自动化失败治理

**目标**

避免自动化持续失败、重复刷屏或无声失效。

**建议设计**

- 配置连续失败告警阈值和冷却时间。
- 区分计划解析错误、执行失败、审批超时和结果投递失败。
- 达到阈值后自动禁用，并向所有者发送一次明确通知。
- 恢复成功后发送恢复通知并重置失败计数。
- 支持 best-effort 投递，避免次要通知失败覆盖主要任务结果。

**验收标准**

- 相同故障在冷却期内不会重复告警。
- 自动禁用原因可在 UI 和 API 中查看。
- 用户修复并重新启用后，失败计数和运行状态符合预期。

#### F-06 用量、成本与预算

**目标**

让空间负责人了解每个目标、任务、角色和模型的资源消耗，并在失控前终止或降级。

**建议设计**

- 记录输入/输出 token、调用次数、耗时、模型、供应商和估算成本。
- 支持 scope、goal、task、role 四级聚合。
- 支持金额、token、轮次和墙钟时间预算。
- 预算策略包括告警、降级模型、暂停和阻止继续执行。
- 预算判断在模型调用前后均执行，避免并发超支。

**验收标准**

- 任一任务均可查询完整的模型使用明细。
- 预算超过阈值时产生确定且可审计的行为。
- 多 worker 并发下不会明显突破硬预算。

### 4.2 P1：智能质量与平台扩展

#### F-07 长会话上下文压缩

- 保留用户原始请求、长期约束、关键决策、已完成工作、产物和未决事项。
- 压缩结果采用结构化版本化格式。
- 原始消息不可变，压缩摘要只是后续模型输入的派生视图。
- 压缩前后记录 token 估算和覆盖边界。
- 为聊天、长任务重试和自动化恢复共享同一套机制。

#### F-08 图增强经验召回

- 在现有 BM25/文本召回上增加实体与关系图。
- 首批节点：任务、目标、文件、模块、技能、经验、角色、错误类型。
- 首批边：修改、依赖、产出、使用、失败于、解决、属于。
- 召回分数由文本相关度、图距离、时间衰减和人工表决组合。
- 每条召回结果必须保留来源锚点和评分解释。

建议直接扩展 `plugins/src/experienceRecall.ts`，避免引入第二套检索服务。

#### F-09 会话摩擦学习

- 收集用户纠正、工具拒绝、重新提示、任务回滚、重复失败和人工中断。
- 多次相似摩擦合并成经验草稿，不直接自动晋升为正式规则。
- 草稿包含触发条件、错误行为、推荐行为、证据任务和置信度。
- 继续沿用 Legion 现有审核、表决和晋升流程。

#### F-10 声明式角色包

- 将角色 Prompt、技能、工具、权限默认值、推荐模型、连接器和预算模板放入版本化 Manifest。
- 启动时验证角色引用的技能、工具和模型是否可用。
- 任务记录实际采用的角色包版本，确保后续可复现。
- 角色升级不影响已经运行中的任务。

#### F-11 MCP 与连接器中心

- 支持全局与空间配置合并，并明确优先级。
- 支持 server 级和 tool 级 include/exclude。
- 每个工具声明风险等级和是否需要审批。
- OAuth token 和密钥通过 SecretStore 或系统凭证库管理。
- 连接器异常不能阻塞不依赖该连接器的任务。

#### F-12 执行后端抽象

- 定义统一的 `ExecutionBackend`：创建环境、执行、上传、下载、终止、查询能力和清理。
- 首版保留 local process + worktree。
- 后续增加 Docker、SSH 或远程 worker。
- 统一输出长度、超时、环境变量、网络权限和可写路径限制。
- 明确 worktree 是版本控制隔离，不是安全沙箱。

### 4.3 P2：团队化和生态能力

#### F-13 多 Harness 路由

- DSH 保持默认运行时。
- 为 Codex、Claude Code、OpenCode 等定义统一 Harness 接口。
- 路由考虑角色支持、模型可用性、上下文长度、工具能力、预算和健康状态。
- 每个任务固定实际 Harness 和版本，避免中途切换导致不可复现。

#### F-14 多用户身份与 ACL

- 增加用户、组织、空间成员和服务身份。
- 权限至少包括 owner、manager、member、viewer。
- 禁止授权接收者默认再次转授权限。
- API、SSE、附件、技能、聊天和审计统一使用同一身份边界。

#### F-15 外部消息渠道

- Slack、Teams、Telegram 等只作为传输适配器。
- 渠道接入前必须完成身份配对、可靠投递、权限引擎和限流。
- 渠道不得拥有独立业务状态；任务、会话和审计仍由 team-hub 管理。

#### F-16 Git 化知识分发

- team-hub 继续作为技能、规则和经验的权威数据源。
- Git 提供导出、审阅、版本回滚和跨工具发布。
- 支持角色、标签、来源和空间过滤。
- revision 只在所有资源阶段成功后提交，避免部分同步被误认为完成。

## 5. 建议目标架构

```text
Workbench / 外部渠道
          │
          ▼
  Team Hub 控制面
  ├─ Identity / ACL
  ├─ Permission Engine / Approval Inbox
  ├─ Event Log / Delivery State
  ├─ Scheduler / Run History
  ├─ Usage / Budget
  ├─ Skills / Experience / Knowledge Graph
  └─ Config Schema / Doctor
          │
          ▼
   Worker Orchestrator
  ├─ Role Manifest
  ├─ Harness Router
  ├─ Context Compaction
  ├─ Tool / MCP Registry
  └─ Execution Backend
          │
          ▼
 Worktree / Local / Docker / SSH
```

架构边界建议如下：

- **team-hub** 是业务事实、身份、权限、审计、计划和事件的唯一控制面。
- **worker** 负责认领、编排、模型调用、工具执行和状态回报，不自行维护第二套业务数据。
- **workbench** 只负责交互与派生展示，不承担可靠性或权限决策。
- **外部渠道** 只负责输入输出转换，不持有独立任务状态。
- **Git** 负责代码与可发布知识资产的版本，不替代运行期数据库。

## 6. 实施路线

### 阶段一：控制面收敛

建议周期：1～2 个迭代。

1. 合并 team-hub 两套业务实现。
2. 建立配置 Schema、有效配置解析和 Doctor。
3. 固化独立服务与 DSH 适配器的 HTTP 契约测试。

退出条件：相同请求在两种宿主形态下具有一致状态码、字段、鉴权和错误语义。

### 阶段二：可靠运行

建议周期：2 个迭代。

1. 统一事件 Envelope 和持久事件游标。
2. 完成客户端断线恢复与去重。
3. 建立投递状态和失败尝试记录。
4. 上线自动化计划、运行历史、失败告警和自动禁用。

退出条件：网络中断、进程重启和重复请求不会造成任务、通知或回复的明显遗漏与重复。

### 阶段三：权限和运营

建议周期：2～3 个迭代。

1. 上线统一权限引擎和审批 Inbox。
2. 纳管代码合并、文件变更、外部访问、连接器和自动化修改。
3. 增加模型用量、成本和预算。

退出条件：每个高风险动作都有明确决策来源，且每个任务的资源消耗可追踪、可限制。

### 阶段四：智能质量

建议周期：2 个迭代。

1. 上线上下文压缩。
2. 为经验召回增加知识图谱。
3. 收集会话摩擦并生成经验草稿。
4. 角色配置升级为版本化 Manifest。

退出条件：长任务可稳定恢复；召回结果可解释；用户纠正能进入受控学习闭环。

### 阶段五：生态与团队化

按实际产品需求启动，不建议提前建设。

1. MCP 与连接器中心。
2. 执行后端抽象和安全沙箱。
3. 多 Harness 路由。
4. 多用户 ACL。
5. 外部消息渠道。

## 7. 优先级总表

| 编号 | 功能 | 优先级 | 价值 | 主要依赖 |
|---|---|---|---|---|
| F-01 | 可恢复事件流与可靠投递 | P0 | 高 | team-hub 单一实现 |
| F-02 | 统一操作权限引擎 | P0 | 高 | 身份、审计 |
| F-03 | 配置 Schema、迁移与 Doctor | P0 | 高 | team-hub 收敛 |
| F-04 | 自动化调度与运行历史 | P0 | 高 | 事件、权限 |
| F-05 | 自动化失败治理 | P0 | 高 | F-04、通知 |
| F-06 | 用量、成本与预算 | P0 | 高 | 模型调用统一入口 |
| F-07 | 长会话上下文压缩 | P1 | 高 | 会话不可变记录 |
| F-08 | 图增强经验召回 | P1 | 中高 | 现有经验中心 |
| F-09 | 会话摩擦学习 | P1 | 中高 | F-08、人工审核 |
| F-10 | 声明式角色包 | P1 | 中高 | 技能、模型配置 |
| F-11 | MCP 与连接器中心 | P1 | 中高 | F-02、SecretStore |
| F-12 | 执行后端抽象 | P1 | 中高 | worker 重构 |
| F-13 | 多 Harness 路由 | P2 | 中 | F-10、F-12 |
| F-14 | 多用户身份与 ACL | P2 | 高但取决于定位 | 身份系统 |
| F-15 | 外部消息渠道 | P2 | 中 | F-01、F-02、F-14 |
| F-16 | Git 化知识分发 | P2 | 中 | 技能权威源明确 |

## 8. 建议指标

功能落地后建议持续观察以下指标：

- SSE 重连后的事件遗漏率和重复消费率。
- 聊天、通知和自动化结果的最终投递成功率。
- 自动化连续失败数、自动禁用数和平均恢复时间。
- 需要人工审批的操作比例、平均等待时间和拒绝率。
- 每任务 token、成本、耗时和预算超限率。
- 上下文压缩前后 token 降幅与任务恢复成功率。
- 经验召回采用率、人工通过率和召回后返工率。
- 用户纠正转化为经验草稿及正式规则的比例。
- 每个角色包、Harness 和连接器的成功率与平均成本。

## 9. 不建议当前重复建设的功能

- 基础任务看板、空间和成员列表。
- 第二套技能或经验数据库。
- 仅用于展示的另一套日历 CRUD。
- 与现有 worktree 并列但没有安全边界定义的“伪沙箱”。
- 在可靠投递和身份治理完成前接入大量消息渠道。
- 在 DSH 单运行时尚未抽象稳定前，同时适配大量 Harness。

## 10. 风险与约束

1. 五个参考项目虽然根目录均声明 MIT，但直接复制较大代码段时仍需保留版权声明并复核第三方依赖许可证。
2. Hermes 和 OpenClaw 规模较大，应借鉴状态模型和模块边界，不应直接引入其完整运行时。
3. OpenWorker 以 Python 为主，示例代码需转换为 Legion 的 TypeScript/SQLite 实现。
4. QM 偏向 PostgreSQL 和云端团队部署，其 ACL 和沙箱能力应在 Legion 确认多人部署需求后分阶段引入。
5. TeamAI CLI 的 Git 分发能力不应改变 team-hub 作为运行期权威数据源的定位。
6. 权限、预算和事件恢复均属于跨模块基础设施，应避免由单个前端页面或特定 worker 私有实现。

## 11. 最终建议

Legion 下一阶段最优先的优化主线是：

```text
控制面单一实现
  → 配置 Schema 与 Doctor
  → 可恢复事件和可靠投递
  → 权限引擎与审批 Inbox
  → 自动化调度、失败治理和预算
  → 上下文压缩、知识图谱和摩擦学习
  → 连接器、沙箱、多 Harness 和多用户能力
```

这条路线可以最大限度复用 Legion 已有的空间、任务、审计、技能、经验、聊天和日历能力，同时避免过早扩张到高成本的渠道、云端基础设施或多运行时兼容工作。

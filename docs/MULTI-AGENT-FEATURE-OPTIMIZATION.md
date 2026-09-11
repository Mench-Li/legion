# Legion Product Runtime 功能优化文档

> 基于 `docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md` 重构。本文按 Product Runtime 架构分层功能、依赖和实施阶段组织。

## 1. 结论摘要

Legion 下一阶段的核心不是继续堆叠页面或 Agent，而是把已有能力产品化：Legion 拥有团队编排、上下文、权限、审计、用量、配置和交付语义；DSH 继续作为受控内部执行引擎，负责模型调用、单 Agent Loop、工具执行和会话运行时；两者之间通过唯一的 `RuntimeAdapter` 契约连接。

`team-hub` 继续是任务、员工、Attempt、Run、审批、用量、技能和审计的唯一事实源。Workbench 只做交互与派生展示，Git 只负责代码和能力包版本，DSH 不成为业务状态源。迁移期间保留 `legacy|product-runtime` 开关，但禁止两个调度器同时扫描同一空间。

主线应调整为：

```text
Runtime Contract → DshRuntimeAdapter → Orchestrator
→ Context Snapshot → Permission/DSH Enforcement
→ Launcher/Config/Upgrade → Pack Manager/商业交付
```

## 2. 架构基线

| 层 | Legion 应拥有的语义 | 首版落点 |
|---|---|---|
| 指挥面 | 空间、目标、任务、员工、审批、配置、升级体验 | Workbench + Product API |
| 控制面 | Task、Attempt、Lease、Run、审计、用量、事件 | team-hub SQLite |
| 编排面 | 扫描、认领、上下文、执行、验收、恢复、交接 | Orchestrator Core |
| 运行契约 | health、models、validate、execute、cancel、recover | `RuntimeAdapter` |
| 执行面 | 模型、Agent Loop、工具、Session、流式事件 | `DshRuntimeAdapter` |
| 强制面 | hard floor、pre-execute、approval、sandbox、preset | DSH 组合补丁层 |
| 交付面 | 安装、配置、诊断、升级、回滚、能力包 | Product Launcher + Pack Manager |

不可突破的边界：不自研第二套 Agent Loop；不复制任务/审批/审计数据库；不把 worktree 当安全沙箱；不在契约稳定前同时支持多个 Harness；客户不需要单独安装或升级 DSH。

## 3. 参考项目到新架构的映射

| 参考项目 | 可借鉴能力 | Product Runtime 落点 |
|---|---|---|
| Hermes Agent | 权限模式、审批队列、会话/工具状态、可靠交付 | Permission、Approval Inbox、RunEvent、Delivery State |
| OpenClaw | pairing、安全配置、持久队列、插件生命周期、自动化 | Identity/ACL、Launcher、Scheduler、升级回滚 |
| OpenWorker | PermissionEngine、任务规则、Reviewer、Inbox、审计、压缩 | 权限、Orchestrator、Context Assembler |
| QM | ACL、安全姿态、命令策略、Sandbox、Harness、预算 | DSH Enforcement、SecretStore、Backend、Usage |
| TeamAI CLI | Git 分发、BM25/图召回、摩擦学习、Hook/MCP | Pack Manager、Knowledge、Connector Registry |

## 4. 分层功能优化清单

### 4.1 P0：执行契约与编排

#### F-01 Runtime Contract

定义唯一接口：`getHealth`、`getCapabilities`、`listModels`、`validateProfile`、`execute`、`cancel`、`recover`。`RunRequest` 必须包含 `runId`、`attemptId`、`idempotencyKey`、workspace/goal/task/employee、TeamPlan、Context Snapshot、模型、预算、工作目录、环境变量白名单和工具权限。

`RunEvent` 固定为 `run.started`、`model.selected`、`message.delta`、`tool.*`、`usage.updated`、`artifact.produced` 和终态事件。未知错误不得静默归类为成功或普通可重试。

#### F-02 DshRuntimeAdapter

封装 `ctx.subagents`、`ctx.agentDefaultModel`、Session 和 DSH 流式事件；统一取消、超时、崩溃、恢复、用量和密钥脱敏；除 Adapter 和迁移期兼容代码外，禁止新增 DSH API 直接调用。

#### F-03 Runtime Manager

启动时校验产品清单、DSH 版本、契约版本和能力；提供单一 Adapter 引用；Runtime 未就绪时禁止 Orchestrator 认领新任务。

#### F-04 Orchestrator Core

将 worker 逻辑提取为 `Task → Attempt → Lease(epoch) → Run → Outcome → Verification → Task transition`。重试创建新 Attempt；Lease 使用 epoch fencing；Orchestrator 不保存第二套任务状态。

#### F-05 可靠事件与投递

延续 F-01 的 scope、seq、Last-Event-ID、持久游标和去重。运行明细作为可持久化 RunEvent 写入控制面，不新增第二条公开 SSE。投递状态区分 `pending/delivering/delivered/suppressed/failed/unknown`。

#### F-06 验收、交接与恢复

统一产物 Schema、验收结果和交接；`recover()` 只返回判断，不直接改 Task；取消与完成并发以 team-hub 首个终态为准；迟到事件只能用于诊断。

### 4.2 P0：上下文、模型与安全

#### F-07 Context Assembler / Snapshot

按固定顺序组装规则、TeamPlan、任务、依赖、技能、历史、用户输入和工具限制；生成不可变 Snapshot、hash、token 估算、裁剪边界和来源引用。

#### F-08 Model Configuration

统一全局默认、空间覆盖、角色推荐和任务显式选择；通过 Runtime Manager 校验模型；记录实际模型、版本和 fallback 原因。

#### F-09 Secret Store

密钥只进入 OS Credential Store/SecretStore；提示词、业务正文、日志、审计导出和能力包不得出现 token；缺失、不可解密、账户不匹配和供应商拒绝分别映射标准错误码。

#### F-10 Permission Engine

在现有 F-02 基础上接入 DSH 工具执行：模式为 `deny/ask/allow-once/allow-for-task/allow-by-policy`；规则绑定 `scope + actor + action + exact target`；`ctx.tools.guard()` 负责不可撤销 hard floor；`tools/pre-execute` 负责动态检查；`ctx.approval` 将人工请求路由到 team-hub Inbox。首批纳管代码合并/推送、文件删除/覆盖、跨空间读写、外部网络/连接器、自动化变更、凭证和高风险命令。

#### F-11 Sandbox / Permission Preset

启动时探测 sandbox backend 与 enforcement；能力不足时禁止受保护执行；将 sandbox mode、approval policy 和工具白名单绑定为员工/Run 档位。worktree 仅是版本隔离。

### 4.3 P0：产品化交付

#### F-12 Product Launcher

提供 Windows 一键安装、配置、启动/停止/重启、健康诊断和日志收集，管理 team-hub、Workbench、Worker、DSH Runtime 生命周期。

#### F-13 Config Schema / Doctor

固定内置默认、用户、空间、进程参数的覆盖规则；提供迁移预览、自动修复、脱敏有效配置和幂等版本迁移。

#### F-14 DSH 版本治理与升级回滚

产品清单精确绑定经过验证的 DSH/Runtime Contract；支持 internal/canary/stable；升级前备份数据库、配置和能力包索引，失败可恢复到兼容组合。

### 4.4 P1：运营、质量与能力包

- **F-15 用量/成本/预算**：按 scope、goal、task、employee、model 记录 token、调用次数、耗时和成本，支持告警、降级、暂停和硬阻止。
- **F-16 自动化计划/运行历史**：日历只做投影；新增计划、运行、时区、skip-on-overlap、补跑和审批暂停状态。
- **F-17 长会话压缩**：原始消息不可变，压缩摘要版本化并服务聊天、重试和恢复。
- **F-18 经验图谱/摩擦学习**：扩展任务、文件、技能、错误关系图；纠正、拒绝、回滚和重复失败先形成审核草稿。
- **F-19 Employee/Role Pack**：Manifest 固化 Prompt、技能、工具、权限、模型、连接器和预算版本。
- **F-20 Pack Manager**：校验能力包签名、依赖、权限和 Runtime Contract，安装可回滚；team-hub 保存安装事实，Git 提供审阅与导出。

### 4.5 P2：生态扩展

- **F-21 MCP/Connector Registry**：server/tool 级策略、风险等级、SecretStore 和故障隔离。
- **F-22 Execution Backend**：统一 local process + worktree，后续扩展 Docker/SSH/remote worker。
- **F-23 多 Harness 路由**：按角色能力、模型、上下文、预算和健康状态路由。
- **F-24 多用户 ACL**：身份贯穿 API、SSE、附件、技能、聊天和审计。
- **F-25 外部消息渠道**：仅作传输适配器，先完成 pairing、可靠投递、权限和限流。

## 5. 依赖与实施路线

```text
F-01 Contract → F-02 Adapter → F-03 Manager
                         ↓
F-04 Orchestrator ← F-07 Snapshot ← F-08 Model / F-09 Secret
                         ↓
                 F-10 Permission / F-11 Sandbox
                         ↓
        F-12 Launcher → F-13 Doctor → F-14 Upgrade
                         ↓
          F-15 Usage + F-16 Scheduler → F-17~F-20
                         ↓
                       F-21~F-25
```

1. **阶段 0：冻结基线**：保留 legacy；建立契约、错误码、迁移和新旧对拍。
2. **阶段 1：执行契约**：Runtime Contract、Fake Adapter、DshRuntimeAdapter、Runtime Manager。
3. **阶段 2：商业薄垂直切片**：贯通软件交付团队的 TeamPlan → Snapshot → Run → Artifact → Review → 交接。
4. **阶段 3：编排与权限**：Attempt/Lease/Run 状态机，接入 pre-execute、approval、hard floor。
5. **阶段 4：产品化交付**：Launcher、Config/Doctor、SecretStore、安装、升级、回滚。
6. **阶段 5：运营与质量**：预算、自动化、压缩、经验、摩擦学习、Role Pack。
7. **阶段 6：生态扩展**：Connector、Backend、Harness、ACL、外部渠道。

## 6. 优先级与退出条件

| 优先级 | 范围 | 退出条件 |
|---|---|---|
| P0 | Contract、Adapter、Manager、Orchestrator | Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复 |
| P0 | Snapshot、Model、Secret、Permission、Sandbox | 输入和权限可复现、可审计，hard floor 不可绕过 |
| P0 | Launcher、Doctor、Upgrade | Windows 新机可安装、诊断、升级和回滚 |
| P1 | Usage、Budget、Scheduler、Quality、Pack | 成本可控，长任务可恢复，角色/能力包可复现 |
| P2 | Connector、Backend、Harness、ACL、Channel | 按客户需求扩展且不破坏单一控制面 |

## 7. 测试与指标

- Runtime Contract 用 Fake Adapter 覆盖 health、execute、cancel、recover、终态和错误码。
- 新旧对拍只在隔离数据库、worktree 和非生产空间执行，不双跑客户任务。
- 故障注入覆盖 Runtime 崩溃、网络中断、重复事件、审批超时、凭证缺失、预算耗尽和升级失败。
- 安全测试覆盖 hard floor、approval fail closed、sandbox 能力不足、密钥脱敏和路径/网络越权。
- 静态检查禁止 Adapter 外新增 DSH API 直接调用。
- 持续观察事件遗漏/重复率、Run 恢复率、审批等待与拒绝率、预算超限率、升级回滚成功率和商业 Alpha 交付周期。

## 8. 代码参考与建议落点

| 目标 | Legion 现有参考 | 新架构落点 |
|---|---|---|
| 事件/审计 | `team-hub/server.mjs`、`workbench/src/hubEventStream.ts` | Event Log、RunEvent、Delivery State |
| 权限 | `team-hub/permission-engine.mjs`、权限 API | Permission Service + DSH Bridge |
| 编排 | `plugins/src/index.ts` | Orchestrator Core、Runtime Manager |
| 经验/上下文 | `plugins/src/experienceRecall.ts`、聊天上下文 | Context、Compaction、Knowledge |
| 生命周期 | `services-plugin/` | Product Launcher、Upgrade |

| 能力 | 外部参考 |
|---|---|
| 权限/Inbox/审计 | `D:\project\multi-agent\openworker\coworker\permissions.py:282,500`；`reviewer.py:315`；`inbox.py:99`；`audit.py:26` |
| ACL/Sandbox/预算 | `D:\project\multi-agent\qm\src\acl\acl-store.ts:37`；`security\security-posture.ts:36`；`sandbox\sandbox.ts:136`；`harness\goal.ts:138` |
| Git 分发/召回/摩擦 | `D:\project\multi-agent\teamai-cli\src\pull.ts:347`；`recall.ts:342`；`session-collector.ts:58` |

## 9. 商业 Alpha 完成标准

```text
安装/配置 → Launcher 启动 Runtime → 创建空间与 TeamPlan
→ 认领 Task / 生成 Snapshot → DshRuntimeAdapter 执行 Run
→ 工具审批与 hard floor → 产物验收/交接/审计/用量
→ Runtime 崩溃可恢复 → 升级失败可回滚且业务数据不丢失
```

该闭环成立后，Legion 才具备可安装、可配置、可审计、可恢复、可交付的产品基础；多用户、多 Harness、远程后端和外部渠道按真实客户需求推进。

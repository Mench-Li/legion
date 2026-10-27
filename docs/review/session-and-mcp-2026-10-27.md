# 持久设计会话与外部 MCP 控制：可行性评估（只评估，不实现）

日期：2026-10-27
状态：评估（T4.1）
依据：[Agent 编排设计 v1.1](../design/legion-agent-orchestration-design.md) §7 末段、§14 阶段四、[实施计划](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md) T4.1
落盘：`docs/review/session-and-mcp-2026-10-27.md`

## 0. 结论

| 问题 | 结论 | 依据 |
|---|---|---|
| Session 该不该先并入现有 Goal/Workflow/Attempt？ | **不该**。今天没有"会话"实体，而每次阶段执行都有完整的 Attempt 记录——先把一次性 Attempt 做扎实，比引入会话便宜一个数量级 | §2 |
| Claude / Codex 的会话恢复是否真实可用？ | **未验证，且不应由能力声明推断**。本仓的 `sessionResume` 能力位已写死 `false`（零消费方），说明它从未被真正用到 | §3 |
| 外部 MCP 控制现在要不要做？ | **不要**。缺的不是协议，是"谁有权改什么"的边界 | §4 |

---

## 1. 今天实际有什么

| 概念 | 存在吗 | 在哪 |
|---|---|---|
| Goal | ✅ | `goal` 表（含四列冻结快照 + 目标级 Agent） |
| Workflow Definition / Instance | ✅ | `agent_workflow_definitions` / `agent_workflow_instances` |
| Stage Task | ✅ | `tasks`（`blockedBy` 表达依赖） |
| Attempt（阶段级） | ✅ | `agent_workflow_stage_attempts`（6 态 + `provider_run_id`） |
| Attempt（运行级） | ✅ | `run_attempts`（13 态）+ `run_events` |
| Session | ❌ | **不存在**。没有任何表或字段表达"一段可持续的对话上下文" |

**这个缺口是有意的**。设计 §7 末段写得很清楚：第一阶段优先让**一次性 Attempt**
可观察、可核实、可恢复，不需要为了界面新增持久会话实体。

---

## 2. 为什么现在不该引入 Session

三个具体理由，都对应一次会踩的坑：

1. **会话恢复的前提是 provider 真的能恢复。** 今天没有实测证据表明 Claude Code 或 Codex
   的外部调用可以由 Legion 恢复上下文。若在未验证的前提下建 Session 表，
   这张表会立刻退化成一个"看起来能续，实际每次都新建"的装饰——
   而那种装饰比没有更糟：它让人以为上下文被保住了。

2. **会话与冻结快照的关系没有答案。** 一个 Session 跨越多条目标时，
   每次执行该用哪一版冻结配置？如果沿用最新版，就违反了"发布时冻结、运行时不回读"；
   如果钉在某一版，那 Session 就成了"第一次发布时的配置"的别名，没有独立价值。

3. **Attempt 已经解决了"可恢复"这件事。** 每一个阶段 Attempt 都带着
   `selectionSnapshot`（那次执行读到的完整配置）+ `workspaceDir` + `providerRunId`。
   恢复所需的全部事实已在，缺的只是**核对流程**——而那份清单[T3.3](recovery-checklist-2026-10-27.md)已经写了。

---

## 3. Claude / Codex 会话恢复：需要实测，不能推断

本仓已经有一处明确的自我纠正记录（`docs/FEATURES.md` §3.21）：

> **`sessionResume` 不再问用户**（2026-10-13）：全仓检索它只有**声明点、零消费方**，
> 于是写死 `false` —— 问一个答案不会被用到的选项，只会让人以为自己的选择起了作用。

这说明两件事：

- 这个能力位**存在**，但它**从未被执行路径消费**；
- 当初写死 `false` 的理由是"没人用"，不是"不支持"。

**要做的事（若将来要恢复会话）**：按 provider 分别实测——

| provider | 要验证的 | 判定方式 |
|---|---|---|
| Claude Code | 能否用上次的 session/thread 标识续接，且上下文真的在 | 真跑两轮：第二轮问一个只在第一轮提过的事实；答得出才算 |
| Codex | 同上（app-server 的 thread 是否可续） | 同上 |
| DSH 原生 | `spawn` / `fork` 的会话是否可续 | 同上 |

**验收纪律**：三种 provider 各自独立验证，**不允许**"一个通了就推其余通"。
能力声明与文档都不能代替一次真实的两轮对话。

---

## 4. 外部 MCP 控制：缺的不是协议

设计要求"如有真实需求，再定义外部 MCP 只读查询和写操作；重用 Hub 权限与审计"。今天的实际情况：

| 前提 | 现状 |
|---|---|
| 身份 | 只有共享 API token + 请求体里的 `by`——**没有独立用户鉴权**（`docs/FEATURES.md` §3.20 已如实记录） |
| 权限 | 有审批端口与 TTL，但"谁可以 approve 什么"仍靠 token 边界 |
| 审计 | `audit` 表完整，但 `by` 是自报的 |

**结论**：在"`by` 是自报的"这一点没有解决之前，开放 MCP **写操作**等于让任何拿到 token
的人以任何身份写入。而只读查询的价值可以先用现有 HTTP 只读端点满足
（`/api/goal`、`/api/activity`、`/api/runtime/attempt`、`/api/runtime/run-events`）。

**如果将来要做**：先解决身份，再谈协议。顺序反了会得到一个"审计看起来很全、
但每一条都不可信"的系统。

---

## 5. 不做会怎样（诚实回答）

| 不做 | 代价 |
|---|---|
| 不做 Session | 用户不能"接着上次的讨论继续"，但每次执行都有完整记录可查——这是当前的主要使用方式 |
| 不恢复会话 | 每个阶段都从干净上下文开始，可能重复一些背景；代价是输入 token，不是正确性 |
| 不做 MCP | 外部工具不能直接驱动 Legion；但 HTTP API 已经够脚本化，且没有引入新的鉴权面 |

**反向代价**（做了会怎样）：
- 建一个未验证的 Session 表，会让"上下文保住了"成为一句**没人能证伪的话**；
- 开放 MCP 写操作，会让审计里每条 `by` 都变成自报。

这些都比"暂时没有这个功能"贵。

# 恢复前的现场核对清单

日期：2026-10-27
状态：只读清单（设计 §11 末段的展开）
依据：[Agent 编排设计 v1.1](../design/legion-agent-orchestration-design.md) §11、[实施计划](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md) T3.3
落盘：`docs/review/recovery-checklist-2026-10-27.md`

## 0. 为什么需要这张清单

设计 §11 末尾只有一句话：

> 恢复不能简单等同于"重新发送同一 prompt"。恢复前核对冻结版本、工作区、已有副作用、
> 原生 Run identity、未收事件和实际进程状态。

这句话是对的，但它没说**用什么查**。于是"按流程恢复"在实践中退化成一个动作：
**再派一次**。而"再派一次"在六项核对全部通过时是对的，在任何一项没核对时
就是让两个写者落进同一个工作区。

下面把六项逐条映射到**可执行的查询**。查不到的项标明"需人工"并写清怎么判。

---

## 1. 冻结版本：这次到底按哪一版配置跑的

| 查什么 | 怎么查 | 输出含义 |
|---|---|---|
| 目标级冻结 | `GET /api/goal?scope=<s>` → 目标行的 `orchestration` / `pipeline_snapshot` / `assignment_snapshot` / `workflow_snapshot` | 四列任一为 `NULL` = 本列上线前发布，按任务快照派生 |
| 任务级冻结 | `GET /api/task?id=<T>` → `agentSelectionSnapshot` | 含 `source`（`goal-agent-workflow` / `goal-node-binding` / `space-pipeline`）、`pipelineVersion`、冻结工具与节点 |
| 阶段 Attempt 用的那份 | `GET /api/agent-workflow/history?taskId=<T>&scope=<s>` → `stageAttempts[].selectionSnapshot` | **这是最关键的一份**：它才是那次执行真正读到的配置 |

**判定**：三处不一致 ⇒ **不要恢复**，先把差异查清。不一致本身可能正常（老目标），
但恢复前必须知道"我按哪一份来"。查得出不一致却说不清原因时，按冻结的那份为准，
并记录在任务评论里。

---

## 2. 工作区：有没有半成品、有没有别的写者

| 查什么 | 怎么查 |
|---|---|
| 本任务的独立工作区 | `stageAttempts[].workspaceDir`（`GET /api/agent-workflow/history`） |
| 写入资格 | `GET /api/tasks/<T>/write-intent` → `state`（`unplanned` / `waiting-file` / `reserved` / `reconciling` / `released`） |
| 谁在占着 | `GET /api/tasks/<T>/contention` → 阻塞任务与路径 |

**判定**：
- `reserved` **且** 执行进程还活着 ⇒ **不能恢复**（两个写者）。
- `reconciling` ⇒ 先走 `POST /api/tasks/<T>/reservation/confirm-stopped`
  （`confirm: "stopped:<T>"`，仅 general），确认后占用才释放。
- `released` 但工作区里有未提交改动 ⇒ 那是**上一轮的现场**，恢复前先决定要不要保留它。

---

## 3. 已有副作用：外部世界被改过了吗

这一项**代码不能替人判断**，只能给人证据。按影响面分三级：

| 级别 | 例子 | 怎么查 |
|---|---|---|
| 仓库内 | 提交、分支、worktree 改动 | 工作区 `git status` / `git log`；阶段 Attempt 的 `result.sourceCommit` |
| 仓库外但本机 | 生成的文件、跑的脚本、装的东西 | 需人工：看任务评论里的执行记录与 `run_events` 的 `tool.requested` / `tool.completed` |
| 真外部 | 发出去的请求、改掉的线上配置 | **需人工**：`run_events` 只能证明"调了什么工具"，不能证明"对方收到了什么" |

**判定**：`unknown` 状态的 Attempt **必须先按"可能已发生"处理**。这是本仓
`unknown` 语义的全部意义——它不能自动变成"没发生"，也不能自动变成"失败"。

---

## 4. 原生 Run identity：那次执行是不是同一个

| 查什么 | 怎么查 |
|---|---|
| 阶段 Attempt 的 provider run | `stageAttempts[].providerRunId`（`null` = **Provider 未提供**，不是"没有运行"） |
| 运行尝试 | `GET /api/runtime/attempt?taskId=<T>` → `history[]`（`run_attempts`，**与阶段 Attempt 是不同的 ID 空间**） |
| 逐条事件 | `GET /api/runtime/run-events?attemptId=<A>` → 13 类事件，含 `run.started` / `run.failed` / `run.outcome_unknown` |

**判定**：
- `providerRunId` 为空 ⇒ **不要**据此推断"没跑过"。它只说明 provider 没给身份。
- 两个 ID 空间要分清：拿阶段 Attempt 的 id 去查 `run-events` 会查不到东西，
  而那看起来像"没有事件"。

---

## 5. 未收事件：有没有还在路上的

| 查什么 | 怎么查 |
|---|---|
| 事件水位 | 客户端 localStorage 的游标；`GET /api/events?sinceSeq=<N>` 可补读 |
| 投递状态 | `GET /api/event-delivery?subscriberId=<id>` → 六态与 `oldestOutstandingSeq` |

**判定**：补读**可能静默少帧**——回放帧要过投递账本，已落终态（`delivered`/`suppressed`）
的会被 CAS 跳过（`team-hub/server.mjs` 的回放循环）。所以"补读后没看到"不等于"没发生过"，
**以历史表为准**（`/api/activity`、`stageAttempts`）。

---

## 6. 实际进程状态：它还在跑吗

| 查什么 | 怎么查 |
|---|---|
| 阶段 Attempt 状态 | `stageAttempts[].state`（`running` / `unknown` 是两种要分开的情况） |
| 节点是否在线 | `GET /api/agent-nodes?scope=<s>` → `status` |
| 心跳与负载 | 同上，`busy` / `capacity` / `lastSeenAtMs` |

**判定**：这一项**永远需要人工确认**。代码能证明"某个进程上报过"，不能证明"那个进程现在还在"。
`abort()` 不保证杀死子代理——所以 `unknown` 状态下**不得**自动重试。

---

## 7. 恢复决策表

六项核对完，按这张表决定动作（**不需要再推理一遍**）：

| 情形 | 动作 |
|---|---|
| 冻结版本清、工作区干净、无副作用、`providerRunId` 有且 Attempt 已终结 | **可以恢复**：新建 Attempt，不覆盖旧记录 |
| 任一项 `unknown`，且未能确认进程已停 | **不得恢复**：保持原状，写评论等人 |
| 预约是 `reconciling` | 先 `confirm-stopped`，确认后再判 |
| 工作区有未提交改动 | 先决定保留还是丢弃，再恢复 |
| 两处冻结版本不一致且说不清原因 | **不得恢复**：先查清按哪一份 |

**一句话**：这张表里"不得恢复"的每一行，都是一次真实事故的形状。
恢复动作本身很便宜，**恢复错了的代价是两个写者落进同一个工作区**。

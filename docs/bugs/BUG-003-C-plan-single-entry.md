# BUG-003 · 修法 C 方案（单入口：一个 (空间, 岗位) 只有一条主对话）

> 状态：**方案，未实施**。用户已选定"排期做 C"。本文只描述要动什么、按什么顺序、判据是什么、
> 风险在哪；不含代码改动。事实部分都标注了**实测出处**（行号/命令），便于复核。

## 1. 目标与验收

**目标**：点开一个 Agent（人员条目）与从任意入口（任务负责人、概览成员、通知）进入，
打开的**都是同一条**主对话；汇报、提问、追加要求、控制命令都落在这一条上。

**验收判据**（可自动化）：

| # | 判据 | 怎么测 |
| --- | --- | --- |
| C-1 | 一个 `(scope, role)` 在库里**只有一条**属于该岗位的会话 | 断言 `SELECT scope, agent_role FROM conversations WHERE agent_role IS NOT NULL` 无重复；撤销 `agent_conversation_bindings` 与它的"双子"关系 |
| C-2 | 同一岗位重复进入**不新增**会话（幂等） | 连续两次 `POST /api/agent-conversations`（或新的统一入口）返回同一 `convId` |
| C-3 | 汇报与人的提问**在同一条**会话里可见 | 造一次任务状态变化 → `GET /api/chat/messages?conv=<主对话>` 同时含 `source=progress` 与 `author=general` 的消息 |
| C-4 | 从任务/概览进入与从 Agent 条目进入**得到同一会话** | 两条入口路径取到的 `convId` 相等 |
| C-5 | 存量历史**不丢**且可读 | 迁移前后把两条会话的消息按时间合并导出，条数与内容逐条一致（除显式标注的合并说明外） |
| C-6 | 写入协议只有一条 | `postMessage()` 对主对话**不再**抛 `Agent conversation requires /api/agent-messages`（或反过来：ChatView 改说 agent-messages 后，`/api/chat/messages` 不再被用于该会话） |

## 2. 现状（为什么 C 不是"改一行"）

已实测的三件事：

1. **同一个 (空间, 岗位) 有两条会话**（`docs/bugs/BUG-003-inspect.py` 的输出）：
   `software/编码工程师` = conv 7（`agent_role` 为空、32 条汇报）+ conv 25（`agent_role=coder`、人的消息）。
   两条是两套子系统的产物：
   - conv 7 由 `agent_conversations.mjs` 的 `conversation()` 建，身份是
     `agent_conversation_bindings.agent_id`（稳定 uuid，`agent_registry` 备份）；
   - conv 25 由 `server.mjs` 的 `createConversation({agentRole})` 建（`server.mjs:3493-3497`），
     身份是 `conversations.agent_role`（role 字符串）。
2. **写入协议被绑定关系锁死**：`postMessage()` 第一行就是
   `if (agentConversations.binding(input.conv)) throw new Error('Agent conversation requires /api/agent-messages')`
   （`server.mjs:3531`）。也就是说：**谁拿到 binding，谁就只能走 `/api/agent-messages`**。
3. **界面按 `agent_role` 找会话**：`ChatView.tsx:173`
   `list.find(c => c.agentRole === agent.role) ?? await ensureAgentChatConversation(...)`；
   而汇报流那条（无 `agent_role`）只在空间会话列表里出现（`ChatView.tsx:178` 过滤 `!c.agentRole`）。
   另有 `AgentConversationPanel.tsx`（读 binding 那条、说 agent-messages 协议）**全仓无人 import**。

设计文档要求的方向是单入口：`2026-10-02-legion-interface-design.md` L175（稳定 Agent 身份 +
同一身份不重复建会话）、L188（从任务与概览进入复用同一主对话）、L79/L102（不另设平级入口）。
同时 L31 提醒：**不能把文档当成已上线能力**——所以本文的每一步都以实测为准。

## 3. 方案（尽量不搬数据，先单入口、后物理合并）

### 阶段 C1｜主对话唯一化（数据面，不动 UI）

- **定权威**：以**绑定会话**为唯一主对话（它有三样别人没有的东西：稳定 `agent_id`、`agent_reports`
  的投影账、`agent_read_cursors`/`agent_commands` 的读写）。
- **给主对话补 `agent_role`**：`UPDATE conversations SET agent_role=<role> WHERE id=<binding conv>`。
  这样界面的"按 agent_role 找会话"会**直接找到主对话**——这也是本方案的关键一步：
  让两条入口指向同一条，而不需要先改前端协议。
- **收敛创建路径**：`createConversation({agentRole})`（`server.mjs:3493`）改为**委托**
  `agentConversations.conversation()`：命中已有绑定就返回它，没有才新建——从源头杜绝"又来一条双子"。
  `ensureAgentChatConversation`（`api.ts:869`）随之变成幂等代理。
- **旧双子怎么办**（conv 25 这类）：**先不删**。它的消息仍然可读，但在 UI 上不再作为该 Agent 的
  主对话出现（因为主对话已经带 `agent_role`，`find()` 会先命中主对话）。
  给它加一个显式的去向标记（标题后缀或 `archived` 列），并在主对话里插一条"历史会话已并入"的说明。
- 判据：C-1 / C-2 / C-4 可测；C-5 成立（旧会话一行没动）。

### 阶段 C2｜前端改说主对话的协议（界面面）

- `ChatView` 在 `agent` 存在时：会话取主对话（C1 之后 `find(agentRole)` 就命中它），
  **发送**改走 `POST /api/agent-messages`（`{scope, conv, body, intent, target?, clientRequestId, by}`），
  并带上 `clientRequestId`（服务端有幂等收据 `agent_request_receipts`，重发不会产生两条）。
- 需要产品决策的三点（都是 UI 语义，不是技术障碍）：
  1. **intent 怎么选**：`/api/agent-messages` 有 `ask` / `feedback` / `answer_question` / `create_task`。
     现状 ChatView 只有一个输入框；最小做法=默认 `ask`，另给"追加要求（下一轮生效）"开关
     （对应 `feedback`，服务端要求必须选中具体任务）。
  2. **控制命令**：`暂停后续调度 / 停止执行 / 核对后重跑` 只在 `/api/agent-commands` 上有；
     把它们放进主对话的抽屉（`AgentConversationPanel` 已有现成 UI 可借，但要补 CSS）。
  3. **AI 回复路径不变**：`ask` 仍写 `meta.aiStatus=awaiting`，守护仍按
     `/api/chat/replies` 取队列、以 `agent:<scope>:<role>` 身份回写
     （BUG-002 已把这条修好并通过 4 例判据）——**不需要第二套回复通道**。
- 判据：C-3 / C-6。

### 阶段 C3（可选，物理合并）

把旧双子的消息搬进主对话（`UPDATE messages SET conv_id=<主对话>` + 重排 `createdAt` 次序），
然后删除旧行。**风险点**：`agent_reports.message_id`、`agent_read_cursors.message_id`、
附件绑定都以消息 id 为键——搬 `conv_id` 不动 id 才安全；一旦需要重建 id 就会牵动这三处。
收益仅是"库里少一条行"，因此**建议不做**，除非以后要按会话统计。

## 4. 顺序、工作量与风险

| 阶段 | 改动面 | 估量 | 主要风险 |
| --- | --- | --- | --- |
| C1 | `team-hub/agent-conversations.mjs`（暴露/复用 conversation）、`team-hub/server.mjs`（createConversation 委托）+ 迁移脚本（给主对话补 `agent_role`） | 半天 | 补 `agent_role` 前必须先确认该 `(scope, role)` 没有第二条带 `agent_role` 的行（唯一性断言先行，否则两条都带 = 界面随机命中） |
| C2 | `workbench/src/components/ChatView.tsx`（发送协议）、`api.ts`、可能补 `AgentConversationPanel` 的 CSS | 1–2 天 | 发送语义变化会影响既有测试与草稿保留/失败重试行为（`retryAiReply` 目前走 `/api/chat/replies/retry`） |
| C3 | 数据迁移 | 半天 | 消息 id 相关三处引用；**建议不做** |

**部署注意**：`agent_role` 是后续所有前端查找的锚，迁移必须**在服务重启前完成并复核**
（迁移脚本要幂等、可回滚；先在生产库**副本**上跑一遍并核对 C-1/C-5）。

## 5. 与已完成工作的关系

- BUG-003 的**修法 A**（汇报多播）已经在 `main` 上生效：**即使 C 一直不做**，你在 Agent 对话里
  也能看到汇报。C 做的是"不再有两条会话"这件更根本的事。
- BUG-002 修好的守护侧身份（`agent:<scope>:<role>`）**正是 C2 依赖的那条回复通道**；
  没有它，C2 之后主对话里的回复作者会是错的。
- 本文不替代 `2026-10-02` 界面设计文档；它是那份文档落到**当前代码事实**上的一份施工单。

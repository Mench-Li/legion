# BUG-003 · 修法 C 方案（单入口：一个 (空间, 岗位) 只有一条主对话）

> 状态：**C1 已实施并在生产库落地**（2026-10-05）；C2 的**核心必要性已被 C1 的设计消掉**
> （见 §3「落地记录」），C3 仍是"建议不做"。本文上半部分是**施工前的方案**（保留原样以便对照
> 当初的判断），下半部分 §3 是**实施记录**：实际改了什么、现场读数、以及施工中被迫多修的两处。

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

---

# 3. 实施记录（2026-10-05）

## 3.1 先说一个施工中才发现的库级事实

库上**本来就有**这条唯一索引（`team-hub/server.mjs:1607`，实测生产库上也存在）：

```sql
CREATE UNIQUE INDEX idx_agent_main_conversation ON conversations(scope, agent_role) WHERE agent_role IS NOT NULL
```

所以"两条都带 `agent_role` 的会话"在库层面**根本不允许**——这让迁移方向变成**单向安全**的：
把 binding 搬到 `agent_role` 那条，绝不会撞上唯一索引。同时它纠正了方案里的一个说法：
双子的真正成因不是"两条都带 agent_role"，而是**绑定那条压根没有 `agent_role`**。

## 3.2 实际改了什么（C1）

| 位置 | 改动 |
| --- | --- |
| `team-hub/agent-conversations.mjs` `conversation()` | 建直接会话时**收养**该岗位已有的 `agent_role` 会话（存在就复用它、标题回到纯岗位名），否则新建并**打上 `agent_role`** |
| `team-hub/agent-conversations.mjs` `convergeAgentConversations()` | 新增的**存量迁移**（幂等、不自动执行）：binding 搬到 `agent_role` 那条；历史那条摘 `agent_role`、标题写 `岗位名 · 历史汇报（已并入主对话）`；**一条消息都不搬** |
| `team-hub/agent-conversations.mjs` `report()` | 改为"绑定会话各一份 +（若不同）`agent_role` 会话一份"，收敛后自然只写一份；**作者按会话归属选**（主对话 `agent:<scope>:<role>`、任务会话稳定 agent_id） |
| `team-hub/server.mjs` `createConversation({agentRole})` | **委托**给岗位会话服务（先 `syncRoster()`，再按 `agent_id` 调 `conversation()`）——从源头杜绝"又来一条双子" |
| `team-hub/server.mjs` `postMessage()` | 写协议分工：**任务/联系会话**只许 `/api/agent-messages`；**岗位主对话**两种协议都放行（界面不必改协议） |
| `team-hub/server.mjs` `postAiReply()` | 回复作者按会话归属选（同上规则）：主对话用调用方身份，任务会话用稳定 agent_id |

**C2 的核心必要性因此被消掉了**：方案原本要求"前端改说 `/api/agent-messages`"，但上面那条
"主对话两种协议都放行"让 ChatView **一行都不用改**就能写进主对话。C2 剩下的只是增强项
（intent 选择、控制命令抽屉），不是单入口的必需条件。**C3 按原判断不做。**

## 3.3 施工中被"逼"出来的第二处修复：新鲜窗口

把 binding 搬到主对话后，`reconcile()` 在新会话上会把**几周前的终态**当成"还没有汇报过"而投影，
`insertMessage` 盖上"现在"的时间戳 —— 正是 BUG-003 当初实测到的 43 条 `T-006 任务状态：已取消。`。

修法：`report()` 增加 `atMs` 参数（**这条汇报所描述的事件发生时间**），超出
`REPORT_FRESH_WINDOW_MS`（24 小时）就不投影；`reconcile()` 把每个事件的真实时间传进去
（`task.updatedAt` / `attempt.updated_at_ms` / `run_events.created_at_ms`）。
判据见 `agent-conversations.test.mjs` 的「历史事件不补播」用例：旧终态一条不投、新事件照常投。

## 3.4 生产库落地读数

**迁移**（先在副本上演练，再 `--db <live> --apply`）：

| 判据 | 读数 |
| --- | --- |
| C-1 每 (空间, 岗位) 只有一条主对话 | ✅ 0 组重复 |
| C-1b 每条主对话都被 binding 指着（汇报写得进来） | ✅ 全部 |
| C-6 主对话标题是纯岗位名 | ✅ 无 `汇报流`/`历史汇报` 残留 |
| C-5 历史消息不丢 | ✅ conv 7 的 34 条、conv 10 的 18 条原样保留；消息总数 181 不变 |
| 收养的双子 | `software/coder`：conv 7 → conv 25；`software/devops`：conv 10 → conv 24 |
| 其余岗位 | 直接给绑定那条补 `agent_role`（software 6 条 + ozon 13 条 + gf001 3 条） |

**活体判据**（8778 重启后）：

- `GET /api/chat/conversations?scope=software`：每个岗位**一条**，标题为纯岗位名；
- `POST /api/chat/messages`（**ChatView 用的那条协议**）写主对话 → **HTTP 200**（C-6 成立，
  以前这里会抛 `Agent conversation requires /api/agent-messages`）；
- `conv 25` 里**人和汇报在同一条**：`general` 的提问 + `agent:software:coder` 的
  `T-174 任务状态：已完成。` 与 AI 回复并存；
- 旧终态**没有回流**（`已取消` 计数 0）。

## 3.5 一处我自己的执行顺序错误（已纠正，留痕）

迁移在生产库上生效、而**仍在运行的旧中枢进程**还没重启的那几十秒里，旧代码（没有新鲜窗口）
把 **43 条**历史终态灌进了 conv 24/25，作者还是稳定 agent_id。

- 这是**执行顺序**问题（应当先重启中枢再迁移），不是修法缺陷：新代码对这些行**不会投影**
  （§3.3 的新鲜窗口，单测钉着）。
- 纠正：`docs/bugs/BUG-003-C-cleanup-burst.mjs --convs 24,25 --apply` 删掉这 43 条及其投递记录，
  随后新代码在 12 秒内把**窗口内真正新鲜**的事件（如 `T-174 已完成`）用**正确作者**补了回来。
- 这个过程本身留下一条教训，已写进脚本注释：**清理脚本的范围必须显式传入**——
  第一版把过滤条件写漏，候选集从 43 条变成 210 条（几乎整个仓库的汇报史）。
  一个"清理"脚本的范围写宽了，与一个删除脚本没有区别。

## 3.6 剩下的（未做）

- **C2 增强项**：意图选择（`ask`/`feedback`）、控制命令抽屉、把 `AgentConversationPanel` 从死代码
  接起来（需要补 CSS）。都不是单入口的必需条件。
- **C3 物理合并**：按原判断**不做**（消息 id 关联三处，收益仅是少一行记录）。
- 历史会话（conv 7/10）保留为可读的历史，标题已写明去向；若将来要彻底归档，再单独评估。


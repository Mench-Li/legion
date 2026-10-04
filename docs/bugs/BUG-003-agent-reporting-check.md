# BUG-003｜「Agent 定时汇报任务」：检查结论 + 修法 A（汇报多播进用户在用的那条会话）

> 这是**检查报告 + 已落地的修法 A**。检查与验证全程只读生产库（`mode=ro`），
> 写入只落在库副本与测试夹具上。结论分三块：生效的、**不生效的**、以及设计上**不做**的。
> 判据可复跑（命令在 §6）。
>
> 用户裁决：选 **A（多播，最小）**；**不做**时间驱动的"仍在努力"式汇报（保持设计原样，§7.2）。

## 1. 结论（先看这三句）

1. **管道在跑**：3 秒对账定时器活着（实测 `team.db-wal` 每 **3.000s** 推进一次），
   任务状态一变，汇报 **~1s** 落库（T-174 `done` 14:58:31 → 汇报 14:58:32）。
   生产库里 **163 条汇报**（162 条任务状态 + 1 条问题投影），全部 `delivered`。
2. **但它不落在你看的那条会话里**（本次修的就是这一条）：`software/编码工程师` 有**两条同名会话**——
   `conv 7`（汇报流，32 条**全是汇报**）与 `conv 25`（你在用的那条，`agent_role=coder`，
   只有你那句「什么进展了」，**汇报 0 条**）。界面上你能打开的是 conv 25。
3. **而且设计上不做"每隔 N 分钟汇报一次进度"**：`2026-10-01` 的进度设计 §7.2 明写
   「长时间无进展只显示事实上的陈旧状态，**不周期性生成"仍在努力"**」。
   3 秒是**对账**（补偿重启/离线缺口），不是汇报节拍；汇报由**状态变化**触发。
   用户已确认**保持这个设计**——所以本 Bug 只修"看不见"，不新增心跳式汇报。

## 2. 生效的部分（有读数）

| 读数 | 值 | 怎么取的 |
| --- | --- | --- |
| `agent_reports` | **163**（全部 `delivered`） | 库 |
| 汇报家族 | `task` **162** / `question` 1 | `agent_reports.source_key` |
| 最新汇报 | `2026-10-04T14:58:44Z`（T-173 受阻） | 库 |
| 状态变化 → 汇报延迟 | T-174 `done` 14:58:31 → 汇报 14:58:32（**~1s**） | 库 + 任务表 |
| 对账定时器活着 | `team.db-wal` mtime：`…59.353 → …02.355 → …05.356 → …08.364`（**每 3.000s**） | 文件采样（14s 窗口） |
| 对账补齐能力 | 在库副本上跑一次 `reconcile()`：**新增 0 条**（没有积压） | 副本探针 |

机制本身没有坏。**坏的是它写给谁。**

## 3. 不生效的部分（这是本次检查的核心）

### 3.1 同名的双胞胎会话，汇报全在你不看的那条

```text
conv  scope      title        agent_role  消息  其中汇报
7     software   编码工程师     -           32    32     ← 汇报全在这
25    software   编码工程师     coder        1     0     ← 你在用的这条（agent_role=coder）
10    software   部署运维员     -           16    16
24    software   部署运维员     devops       0     0
```

两条会话**标题一模一样**，靠 `agent_role` 区分；而对话中心给你打开的是 `agent_role` 那条
（`ChatView.tsx:173`：`list.find(c => c.agentRole === agent.role)`）。于是：
**汇报在隔壁那条，你这条永远是空的。**

实测（live hub，与界面同源）：

```text
GET /api/chat/messages?conv=7   → 32 条，其中汇报 32 条（最后一条：T-174 任务状态：已完成。）
GET /api/chat/messages?conv=25  →  1 条，其中汇报  0 条（就你那句「什么进展了」）
```

### 3.2 唯一会显示汇报的面板是**死代码**

`workbench/src/components/AgentConversationPanel.tsx` 读的正是 `conv 7` 那条流
（`/api/agents` → `/api/agent-conversations` → `POST /api/agent-messages`，每 3s 轮询）。
但全仓**没有任何模块 import 它**：

```text
$ git grep -n 'AgentConversationPanel' HEAD -- workbench
HEAD:workbench/src/components/AgentConversationPanel.tsx:17:export function AgentConversationPanel(...)
```

它是在 `1a1ee3fc`（2026-10-03「simplify provider settings」）里**新增**的文件，
同一个提交里 `App.tsx` 只改了两行文案——**面板加了，挂载点从来没有过**。
对照仓库自己的纪律：*「一个功能没有入口，与这个功能不存在，对用户来说是同一件事」*。

### 3.3 生产里事件类汇报**一条都发不出来**

设计 §7.1 列了 8 类信息来源（Attempt Running / tool.completed / artifact.produced /
RunResult / 验收…）。生产库里这些输入表是**空的**：

| 表 | 行数 |
| --- | --- |
| `run_events` | **0** |
| `run_attempts` | **0** |
| `run_context_snapshots` | 表不存在 |

所以只剩「任务状态变化」这一类（§7.3 的降级路径："能力不足时只发开工、已有阻塞、结果与交付"）。
**"开工"也发不出来**——它来自 Attempt 进入 Running，而 Attempt 表是空的。

### 3.4 「应报未报」逐条解释后**不是漏报**

10 条可汇报状态没有汇报，逐条查下来**全部**是"本空间没有在职岗位"（外部执行者
`soldier-a/b`、`general`、`soldier-auto`、`soldier-market` 与 `role=NULL`）——
没有汇报主体，本来就不该有汇报。这条**不是缺口**（我第一遍用消息 `sourceRefs` 对账时算错了，
权威唯一键是 `agent_reports.source_key`；改用副本探针复核：`reconcile()` 新增 0 条）。

## 4. 根因：一个 (空间, 岗位) 有两条会话，各自被不同子系统认领

| | 汇报/主对话流（conv 7/10） | 你在用的那条（conv 24/25） |
| --- | --- | --- |
| 谁建的 | `agent_conversations.mjs` 的 `conversation()`（`/api/agent-conversations`） | `server.mjs` 的 `createConversation({agentRole})`（对话中心） |
| 身份锚 | `agent_conversation_bindings.agent_id`（稳定 uuid）+ `agent_registry` | `conversations.agent_role`（role 字符串） |
| 谁写 | 汇报投影 `report()`；`/api/agent-messages`（intent/幂等/命令） | `/api/chat/messages`（对话中心 + AI 回复队列） |
| 汇报 | **32 条** | **0 条** |
| 入口 | **无**（唯一消费方是死代码） | 对话中心（你在用） |

关键约束（决定修法）：**谁拿到 binding，谁就被限制走 `/api/agent-messages`**——
`postMessage()` 第一行就是 `if (agentConversations.binding(input.conv)) throw new Error('Agent conversation requires /api/agent-messages')`
（`server.mjs:3531`）。所以"把两条合成一条"不是换个 id，而是**要让对话中心改说岗位会话的协议**。

对照设计文档（`2026-10-02-legion-interface-design.md`）：
- L175：「Agent 主对话需服务端权威绑定空间与**稳定 Agent 身份**，并确保**同一身份重复进入不会创建重复会话**」
- L188：「同空间同岗位及不同空间同名 Agent 的会话可正确区分；从任务与概览进入时复用**同一 Agent 主对话**」
- L79/L102：不另设平级「对话中心」；点 Agent 行直接打开**该 Agent 的主对话**

即：**当前状态正是设计文档明确要消除的那种"重复会话"**。而 L31 又写着
「先前 Agent 对话提案可作为服务契约参考，但实现前必须重新核对实际代码，**不能将文档视为已上线能力**」——
所以这不是一个"改一行"的缺陷，而是界面重构里的一块。

## 5. 修法（用户裁决：A；B/C 未做）

| 选项 | 做什么 | 状态 |
| --- | --- | --- |
| **A** 汇报**多播**一份到 `agent_role` 会话 | `report()` 除了绑定的那条，再往"该岗位的 `agent_role` 会话"投影一份（`agent_reports` 的唯一键本来就是 `(source_key, conv_id)`，**设计允许同一事件在每个会话各一份投影**）。无需迁移、无需改协议、不动 UI | **✅ 本次已实现**（见 §5.1） |
| B 挂载死面板 `AgentConversationPanel` | 挂上那个现成面板（它已按 `/api/agent-messages` 说话） | 未做：会把"两条会话"固化下来，与设计文档 L175/L188 冲突 |
| C 按设计合成一条主对话（单入口） | 一个 `(scope, role)` 只有一条主对话；对话中心改走 `/api/agent-messages`；迁移存量 | 未做：**界面重构级**（ChatView 的发送/回复/重试/附件全要换协议），应单独立项 |

### 5.1 A 的落地形状（`team-hub/agent-conversations.mjs` 的 `report()`）

1. **多播**：绑定会话各一份（不变，`author` 仍是稳定 `agent_id`——`AgentConversationPanel` 按它认人），
   再加"该岗位的 `agent_role` 会话"一份，副本 `author` 用 **`agent:<scope>:<role>`**
   （对话中心在这个会话里认的就是这个身份；用 uuid 会把它显示成一串 id）。
2. **不补播存量**（这一条是被实测逼出来的）：副本只在**主场确有新投递**时写。
   原因——`insertMessage` 的时间戳是"现在"，而存量汇报描述的是几周前的状态；实测在
   **生产库副本**上补播一次会往用户那条会话灌 **43 条**历史（`T-006 任务状态：已取消。`……），
   每条都盖上当前时刻。**那不是补全历史，是把旧事件重新盖章成刚刚发生。**
   代价（已确认接受）：部署后那条会话要等**下一次状态变化**才有第一条汇报。
3. **幂等**：仍靠 `agent_reports` 的 `(source_key, conv_id)` 唯一键 + `message_id` 守卫，
   再对账多少次都不加消息。

生产库副本上的两段实测（`docs/bugs/BUG-003-reconcile-probe.mjs`）：

| 段 | 动作 | 读数 |
| --- | --- | --- |
| ① 存量 | 直接 `reconcile()` | 新增 **0** 条消息、**0** 条落进用户会话 ⇒ 不补播 ✅ |
| ② 新事件 | 在副本上把 `T-173` 置 `in_review`（版本+1）再 `reconcile()` | 新增 **2** 条：conv 10（绑定，`author=agent-bfe138ac…`）+ **conv 24**（用户会话，`author=agent:software:devops`） |

## 6. 判据（可复跑）

```bash
# ① 检查读数全取（只读生产库）
python docs/bugs/BUG-003-inspect.py

# ② 修法 A 的两段判据（库副本；①应为 0、②应为 intoChatView=1 / intoAllConvs=2）
node docs/bugs/BUG-003-reconcile-probe.mjs

# ③ 单测：多播身份正确 + 幂等 + **存量不补播**
node --test team-hub/agent-conversations.test.mjs        # 20 例（新增 2 例）
node --test team-hub/agent-main-chat.test.mjs            # 5 例（岗位载荷由服务端解析）
node --test team-hub/chat.test.mjs                       # 53 例（对话中心契约，不回归）

# ④ 定时器是否活着（看 WAL 每 3.000s 推进一次；只读采样）
#    PowerShell：每 3 秒打印一次 team-hub/team.db-wal 的 LastWriteTime，连续 5 次间隔应≈3s

# ⑤ 现场对照（live hub，与界面同源）
curl "http://127.0.0.1:8787/api/chat/messages?conv=7&limit=200"   # 绑定会话：汇报流
curl "http://127.0.0.1:8787/api/chat/messages?conv=25&limit=200"  # 用户会话：部署后由下一次状态变化起有汇报
```

**反向验证**（证明判据会红）：把 `agent-conversations.mjs` 的 `report()` 换回单目标版本，
`team-hub/agent-conversations.test.mjs` 的两条新用例红（多播那条：用户会话收到 0 条）。

## 7. 边界

- 本次**改了**：`team-hub/agent-conversations.mjs`（`report()` 多播 + 不补播）、
  `team-hub/agent-conversations.test.mjs`（+2 例）、`scripts/ci/run-ci.mjs`（登记下面那两个套件）。
  **没有**改库、没有重启任何进程、没有动 `main`。
- **部署要动一处并重启**：中枢侧改的是 `team-hub/server.mjs` 的依赖模块
  （`agent-conversations.mjs`）⇒ 8787 独立进程与宿主外壳都要重启才生效。
- **`agent-conversations` / `agent-main-chat` 两个套件此前没有任何 CI 登记**（一次都没被执行过），
  本次按 BUG-002 的同一处置**登记**（不加 `EXEMPT`）：这一族正是"汇报投影"的契约所在，
  而 BUG-003 的现场在这两个文件里没有任何一条断言在管。
- **不做时间驱动汇报**（用户确认）：§7.2 的设计原样保留——长任务在两次状态变化之间不会
  产生"仍在努力"式消息。要改这条属于新增能力，不是本 Bug。
- 上面 ① 的第一版对账脚本有两处会得出相反结论的错法，都已改正并留痕在 §3.4：
  ① 拿消息 `meta.sourceRefs` 当汇报键（它只带 `taskId`/`version`，不带 `status`）⇒ 会报"168 条应报未报"；
  ② 把"无在职岗位"的任务算成漏报。**权威键是 `agent_reports.source_key`**，且要用副本探针交叉复核。
- `run_events` / `run_attempts` 为 0 是**部署事实**（这套部署没在跑 Runtime 执行面），
  不是本 Bug 的结论；但它决定了"开工/产物/失败"类汇报在今天**不可能**出现。

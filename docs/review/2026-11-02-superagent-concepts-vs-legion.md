# 核心概念逐个拆解：它消除哪种失效模式 × Legion 现状

> **已被取代**：本文的 §2 与结论已并入 [`2026-11-02-superagent-porting-whitepaper.md`](2026-11-02-superagent-porting-whitepaper.md)（v3，单一权威版）的 §2。本文保留作为**拆解过程与证据**的档案。

日期：2026-11-02 ｜ 配套：[移植白皮书](2026-11-02-superagent-porting-whitepaper.md)、[授权对照](2026-11-02-superagent-authz-vs-legion.md)
读法：每个概念都问同一个问题——**它到底在防哪种失效？** 防不住的失效，就是 Legion 现在暴露的风险。

---

## 0. 先更正一处，这会改变结论

我在前几份材料里说 Legion "没有 attention 对象、没有读位、没有会话线程"。**这个判断在 `team-hub` 层是错的**，只对守护插件成立。实测：

| 结构 | 位置 | 字段 |
| --- | --- | --- |
| `agent_questions` | `team-hub/agent-conversations.mjs:34-37` | `id, scope, agent_id, task_id, attempt_id, body, options_json, status, version, answer, answered_by, source_message_id` |
| `agent_read_cursors` | `:48-50` | `(actor, scope, conv_id, message_id)` |
| `agent_conversation_bindings` | `:22-24` | `conv_id, scope, agent_id, task_id, binding_key` |
| `agent_commands` + `agent_dispatch_holds` | `:38-43` | 控制命令（stop / pause / release_hold）+ 任务级派工闸 |
| question 生命周期 | `:324-333`（问）/ `:206-209`（答，含 `version=version+1` 乐观锁）/ `:319-320`（命令认领） | — |

**也就是说：attention 的对象、读位、会话-任务绑定、控制通道，Legion 都已经有了。缺的是"工作回路没接上"** —— 真正派工的那个守护插件 `plugins/src/index.ts` 对 `agent_questions` / `agent_commands` / `agent_read_cursors` **零引用**（grep 0 命中），它用的是任务 JSON 里的 `comments` 数组 + `❓` 文本约定。

**因此 S1/S2 的性质变了**：不是"新建"，是"**接线**"（见 §4）。

---

## 1. 拆解方法

一个概念值得存在，是因为它**消掉一类具体的失效**。清单如下：

| 概念 | 消除的失效 | 不装会怎样 |
| --- | --- | --- |
| Source | 重启重放 / 漏读 | 重复干活，或事件永久丢失 |
| Trigger | 同一事件被算两次 | 一评论两工单，权限翻倍 |
| Thread | 同话题并发决策互相打脸 | 两个执行者对着同一件事做相反决定 |
| Gate | 路人/bot 触发真干活 | 授权失守，且无法解释 |
| Assessment | "顺手做点没人要的" | 主动性失控 |
| Policy version | 规则改了无法追责 | "按哪版规则批准的"答不出来 |
| Mandate | 授权来源丢失 / 范围悄悄扩大 | 事后无人认账 |
| Ticket | 工作单元与执行器耦合 | 换执行器=换语义 |
| Assignment | 工单状态跟着执行器崩 | 执行器一挂，工单状态不可信 |
| Report 六态 | 状态靠猜、靠读自由文本 | "假完成""假受阻" |
| Attention | 问句淹没在长文本里 / 答非所问 | 沟通返工，注意力通胀 |
| Channel | 回话跑到新线程 | 人找不到上下文 |
| Subscription | 上下文断裂 | 人要重复解释同一件事 |
| Disposition | 答不出"它为什么没动" | 无法收敛噪音，也无法放开自动化 |
| Strength | bot / 路人甲即授权 | 一句话就能让 agent 动生产 |
| accept mode | 一上来就全自动 | 无法建立信任 |

---

## 2. 逐条对照

### 2.1 Source（来源）

- **作用**：把"外部世界发生了什么"翻译成域内能审计的事件，并**持有读位**。
- **规则**：读位不重放；丢弃自己的消息；定义"什么算事件"（含只有时间才能满足的条件）。
- **不装的后果**：重启后要么重放（重复干活），要么漏读（永久丢失）。
- **Legion 现状**：**没有外部 Source**。它的"输入"是三个内部状态变化面：
  1. 看板任务状态（守护每 `intervalMs`（默认 30s）扫一次，`plugins/src/index.ts:4,230`）
  2. 定时自动化（`team-hub/automation-store.mjs:1-40`：重叠策略 skip/replace/queue、补跑 none/once/all、等审批态）
  3. 人/将军的直接操作（批准、拖拽、评论）
- **判定**：**形态不同，不能照搬**。Legion 的来源是**状态**而不是**事件**——所以它天然幂等（扫到就干、没扫到下次再说），但也天然**没有"发生了什么"的记录**。这正是 S4 要补的。

### 2.2 Trigger（触发）

- **作用**：不可变事件，带 actor；受理两次只成一个工单（幂等的单位）。
- **规则**：不可变；确定性 ID（含 version）。
- **Legion 现状**：`audit` 表 `(seq, ts, member, scope, action, taskId, detail)`（`team-hub/server.mjs`）**是最接近的东西**：有 actor（`member`）、有动作（`action`）、有 seq 单调。但它是**动作流水**，不是"输入事件"；`detail` 是自由文本/JSON，没有 `addressed`、`human`、`actor.kind` 这些准入必需字段。
- **判定**：**素材齐，语义缺**。加三个字段（actor.kind / addressed / human）即可当 Trigger 用，不必新表。

### 2.3 Thread（线程）

- **作用**：把同一话题的事件归并；**同时只允许一个 Eval**，保证决策一致。
- **规则**：串行决策；可挂多个工单。
- **Legion 现状**：**已经有了，只是叫别的名字**：
  - `conversations` + `agent_conversation_bindings(conv_id, agent_id, task_id)`（`:22-24,127-133`）——会话绑定到 **Agent + 任务**
  - 任务内的 `comments` 数组（`tasks.comments`）
- **判定**：**已具备**。缺的只是"同一会话同时只允许一个决策在飞"这条规则——Legion 现在是靠 `claim` 互斥保证的，语义等价但层级不同（互斥的是执行，不是决策）。

### 2.4 Eval = Gate + Assessment

- **作用**：把"该不该开工"拆成「能判定的一半」与「要判断的一半」。
- **Gate 规则**（确定性）：名单、bot 名单、准入表三格、强度；**非名单者默认 ignore**。
- **Assessment 规则**（模型）：**每条启用规则逐条判一次**；主动受理至少命中一条。
- **Legion 现状**：
  - **Gate：有，但管错对象**。`claim-policy.mjs:64-104` 的 `TASK_GATES`（`status='todo'` + `hold=0`）是确定性代码，且有 `holds()` 纯函数镜像 + `assertTaskGatesShared()` 防绕过——**这套写法正是 superagent 那套**，只不过它管"能不能被领走"，不管"该不该开"。
  - **Assessment：有，但是"将军这个人"**。`COMMAND.md:31`：将军从 backlog 挑 2–5 个。没有规则集，因此无法"逐条判"，也无法回答"依据哪条规则"。
- **判定**：**Gate 抄写法、换对象；Assessment 补规则集**（S3）。

### 2.5 Policy 与 Policy version

- **作用**：规则 + 名单 + 准入表 + accept mode 的**版本化快照**；变了要投递说明给在途工单，但**不撤销**。
- **Legion 现状**：三套并存，各管一段：
  | 现有 | 管什么 | 版本化? |
  | --- | --- | --- |
  | `rules` 表（global/space 分层） | 行为规范（给模型读的散文） | 无版本，覆盖写 |
  | `permissions` 规则（`routes/permissions.mjs`） | 动作级 allow/ask/deny | 有规则 id，无版本 |
  | `CLAIM_POLICY_VERSION = 'legion/claim-policy@1'` | 认领资格 | **有版本号**（唯一一处） |
  | `tasks.ordersVersion` | 任务创建时的需求版本 | 有，但只对需求文本 |
- **判定**：**版本化的思想已有先例（claim-policy），缺的是"受理策略"这一份**。`ordersVersion` 已经证明"任务记住自己在哪版规则下成立"这条路能走。

### 2.6 Mandate（授权）

- **作用**：把"凭什么让它干、能干多远"冻结成不可变记录。
- **规则**：不可变；只有人喊停能撤回；策略不再支持才吊销；**更宽的范围 = 新工单**。
- **Legion 现状**：**没有**。最接近的是：`tasks.soldier`（谁认领）、`tasks.hold`（将军拦截）、`audit.member`（谁按的按钮）、`tasks.ordersVersion`（哪版需求）。
  - 但这四样拼不出"依据哪条规则、什么强度、谁请求的"。**"谁按的按钮"≠"凭什么允许"。**
- **判定**：**必须新建**（S3 的核心），但字段可以从现有列派生大半。

### 2.7 Ticket（工单）

- **作用**：授权的工作单元；**自己定义状态，不跟随执行器**。
- **Legion 现状**：**比它更硬**。`tasks` 表：`id, title, description, acceptance, boundary, priority, status, version, soldier, role, scope, hold, blocks, blockedBy, comments, ttlMinutes, expiresAt…`
  - 比 superagent 多的：`boundary`（文件域）、`acceptance`（验收标准）、依赖（`blocks/blockedBy`）、TTL、乐观锁 `version`。
- **判定**：**保留，只需挂 Mandate**，不重建。

### 2.8 Assignment（派工）

- **作用**：工单↔执行器实例的绑定；**独立状态机**，一次工单可有多次。
- **Legion 现状**：**明显更强**：`run_attempts`（attempt_no / state / 退避 `next_attempt_at_ms`）+ `agent_run_bindings(attempt_id, run_id, agent_id, worker_id, lease_epoch)`（`:51-53`）+ 预约/租约/`confirm-stopped` 人工对账。
- **判定**：**不动**。白皮书里已列为"不要退回去"的三处之一。

### 2.9 Executor 与 Report（六态）

- **作用**：把执行器的"我在什么状态"变成**结构化事实**，让工单阶段可以推导。
- **六态**：`progress / waiting / ready / blocked / failed / dropped`。
- **Legion 现状**：**只有两态**！`WorkerReport.status: 'done' | 'blocked'`（`plugins/src/index.ts:331-350`）。
  - 这份报告里**另有**很丰富的领域字段（`testReport`、`testVerification`、`review`、`goalRef`、`artifact`），**在"验证"这个维度上比 superagent 细**；
  - 但**在"意图"这个维度上只有两个值**。
- **后果（这条被严重低估）**：士兵遇到"这活不值得做 / 已经不需要了 / 在等外部条件"时，只有两条路——**报 `done`（假完成）** 或 **报 `blocked`（假受阻）**。前者污染验收，后者制造噪音。superagent 的 `dropped`（无需处理，且默认不发消息）就是为这个场景存在的合法结局。
- **判定**：**优先补 `dropped` 和 `waiting`**，比补 attention 更便宜、收益更直接。

### 2.10 Attention（待人工决定）

- **作用**：把"我需要人拍板"变成一个**有 id、有状态、可被一条消息回答**的对象。
- **规则**：一个工单同时只有一个未答问题；回答必须对得上当前问句原文；问句换了就撤回旧的未发回复。
- **Legion 现状**：**两层割裂**：
  - 存储层已有完整对象（`agent_questions`，含 `options_json` / `status` / `version` / `answer` / `answered_by`）；
  - 工作层用的是文本约定（`❓ 待将军确认` 前缀写进 `blocker`，`plugins/src/index.ts:2177`），守护据此 `blocked`（`:3422-3425`）；
  - 两层**没有接线**。
- **判定**：**接线，不新建**（这是本次最重要的更正）。

### 2.11 Channel（渠道）

- **作用**：回话的写地址；"话在哪说的，结果回哪去"。
- **规则**：渠道失效则丢弃并**留档**（谁、何时、为什么丢掉）。
- **Legion 现状**：多而散：任务评论、`agent-messages` 会话、mesh 总线、handoff。**没有"渠道失效 → 丢弃留档"的账**；也没有"一条工单对同一会话的消息保序"的保证（superagent 有，`003:179`）。
- **判定**：**先不做**。它的价值取决于是否接外部源；内部场景靠看板复核即可。

### 2.12 Subscription（订阅）

- **作用**：让上下文自动回流，**续跑不需重新授权，但不扩权**。
- **不装的后果**：人得重复解释；或者反之——一追加消息就顺手扩权。
- **Legion 现状**：**半条**。`in_progress` 且认领后有人评论 → 视为退回、派纠错 worker（`plugins/src/index.ts:10-11`）。也就是说：**评论能唤醒执行者，但语义只有"你重做"**，没有"追加"、没有"回答"。
- **判定**：**需要扩语义**（S2），机制已存在，不需要新的投递通道。

### 2.13 Disposition（去向）

- **作用**：记录每条输入**最终去哪了**：被过滤 / 被评估 / 被扇出。**它记的是"没做"**。
- **Legion 现状**：**没有**。`audit` 记的是"做了什么"。将军没挑某个任务、守护跳过了某条候选——**不留痕**。
- **判定**：**新建，但极便宜**（一张表 + 一个字段），却是 observe/auto 的唯一数据基础。

### 2.14 Strength 与 accept mode（策略的两个旋钮）

- **作用**：`explicit / inferred` 决定"够不够格开工"；`off / observe / auto` 决定"多快能自己开工"。
- **Legion 现状**：**都没有**。等价物是二元的："将军批准 = 干"、"没批准 = 不干"。
- **后果**：无法区分"人明确要求的"与"agent 觉得该做的"，也无法"先只记录不做"。
- **判定**：**随 S3 一起做**，几乎是两个枚举字段的成本。

### 2.15 Correlation（关联）

- **作用**：把相关线程作为**上下文**引入，但**绝不用它来路由**。
- **判定**：**不做**。这是 superagent 处理 GitHub Issue↔PR↔review 多线程的手段，Legion 的"一任务一 worktree"没有这个形状。

---

## 3. 汇总矩阵

| 概念 | Legion 状态 | 处置 | 落在哪一步 |
| --- | --- | --- | --- |
| Source | 无外部源（状态驱动） | 不照搬；把"状态变化"事件化 | S4 |
| Trigger | audit 有素材，缺语义字段 | 加 `actor.kind / addressed / human` | S4 |
| Thread | **已有**（conversation + binding） | 补"单决策在飞" | 可延后 |
| Gate | **已有**（claim-policy），对象错位 | 抄写法，换对象 | S3 |
| Assessment | 将军本人 | 补规则集 | S3 |
| Policy / version | `ordersVersion` + `claim-policy@1` 有先例 | 新建受理策略版本 | S3 |
| Mandate | **无** | **新建** | S3 |
| Ticket | **更强** | 挂 Mandate | S3 |
| Assignment | **更强**（attempt/租约） | 不动 | — |
| Executor Report | **两态**（done/blocked） | **补 `dropped` / `waiting`** | S1′(见 §5) |
| Attention | **存储有、回路无** | **接线** | S1 |
| Channel | 多且散 | 暂不做 | — |
| Subscription | 半条（等价于"重做"） | 扩语义 | S2 |
| Disposition | **无** | 新建（便宜） | S3 |
| Strength / accept mode | 无 | 加两个枚举 | S3 |
| Correlation | — | 不做 | — |

---

## 4. 由此得出的三个修正

**① S1 从"新建 attention"改成"接线 `agent_questions`"。**
具体三处：
- `plugins/src/index.ts:331-350`：`WorkerReport` 加 `question?: { body, options? }`（**不要**再造新字段名，与表对齐）；
- `:3422` 的 `blocked` 分支：把 `❓` 评论换成 `agent_questions` 写入 + 会话消息（复用 `question()`，`agent-conversations.mjs:324-333`）；
- 派工资格：在 `TASK_GATES`（`claim-policy.mjs:64-104`）里加一条 `no-open-question`（等价 `holds()` 纯函数），让"有未答问题"真正阻断派工。

**收益**：不引入第二套 attention；`options_json` / `version` 乐观锁 / `answered_by` 全部现成；面板已经在读（`workbench/src/components/AgentConversationPanel.tsx`）。

**② S2 不要造第三条入口。**
Legion 已经为"两条入口"付过代价：同一个 (空间,岗位) 曾同时存在"对话中心那条"和"汇报流那条"，最后靠**收养**合并（`agent-conversations.mjs:108-117`，注释里写明"两条标题一样，汇报只在后者、人的消息只在前者"）。
所以 S2 的正确做法是：**评论路径复用 `agent-messages` 的写入与投递**，而不是新造 `task_input` 表。

**③ 优先级重排：`dropped`/`waiting` 应该在 attention 之前或同时。**
理由：Report 从六态压成两态，是"假完成"的根源；而 `dropped` 的实现成本几乎为零（一个枚举值 + 一条"不发消息"的分支），收益立刻体现在验收质量上。**建议 S1 拆成 S1a（Report 扩到四态：`done/waiting/blocked/dropped`）+ S1b（attention 接线）。**

---

## 5. 修正后的四步

| 步 | 内容 | 与原方案的差别 |
| --- | --- | --- |
| **S1a** | Report 四态（补 `waiting` / `dropped`，后者默认不发消息） | **新增**，替换原来 S1 的一半 |
| **S1b** | attention 接线到 `agent_questions` + 派工闸 | 从"新建字段"改为"接线" |
| **S2** | 评论 `@角色` 复用 `agent-messages`，语义分"追加/驳回/回答" | 从"新建 task_input"改为"复用现有通道" |
| **S3** | 决策台账 + `policy_rules` + Strength/accept mode + Disposition | 加了两个枚举字段与 Disposition |
| **S4** | LegionEvent（复用 `audit.seq`）+ watches | 不变 |

总量从"11–16 天"降到约 **9–13 天**，且每一步都是"接线/加字段"，没有一步需要新建状态机。

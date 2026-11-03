# superagent → Legion 移植白皮书 v3.3

日期：2026-11-03 ｜ 版本：v3.3（**单一权威版**）
覆盖面：superagent 的**每一个核心概念** → Legion 现状 → 如何借鉴 → 作用 → 具体方案 → 六步计划（S0–S4）→ **并发治理（§7）与自我进化（§8）**
取代关系：本文件取代 `2026-11-02-superagent-concepts-vs-legion.md` 的 §2 与 `…-porting-whitepaper.md` 的 v2；那两份连同 `…-three-mechanisms.md`、`…-mention-mechanism.md`、`…-authz-vs-legion.md`、`scratch/superagent-feasibility.md` 作为**依据材料**保留。

> **v3.3 变更**
> 新增 **§7 并发治理**（五层现状栈图 + superagent 三条补充 + 四个缺口 + D1–D3）与 **§8 自我进化**（原料/仓库图 + 六步闭环图 + 三条硬约束 + E1–E3），两节同为图文版；并在 §0 与 §8.5 标明两阶段施工顺序。
>
> **v3.2 变更**
> §2 全部 17 个概念的**借鉴方案**重写为「图文版」：每章固定给 **现状图（问题在哪）→ 目标图（改成什么样）→ 改动清单表 → 关键决策（为什么这么选）→ 验收**。图用 ASCII 画，可直接在终端/任意 Markdown 阅读器里看，也便于贴进评审。
>
> **v3.1 变更**
> 1. §2.1 重写为「状态 / 事件的分工」：四层位置表 + 四种双写做法 + 事件化判据 + 权限边界 + 三条纪律 + **对账**。
> 2. 新增 §2.17 Input：评论是"事件塞进状态列"的活标本 → 新增 **S0 评论 append-only 化**（0.5 天），排在所有步之前。
> 3. 全局约束增至**七条**（新增：状态写与事件追加必须同事务；事件流不得触发派工）。
> 4. 计划由五步改为**六步**，总量 9–13 → **10–14 天**；S4 验收加入**对账 0 差异**。

---

## 0. 一屏结论

| 问题 | 答案 |
| --- | --- |
| 要不要装这个插件 | **不装**（桌面端无 CLI、单实例、内嵌 cordis 4.0.5/schemastery 3.18.5 与它精确 pin 不符；Windows 侧 `env`/`sh`/无扩展名 shim/tmux 四道硬阻塞，实测 43/1197 用例失败） |
| 要不要抄它的模型 | **要，但只抄"契约化"这一层** |
| 最大发现 | Legion **已经有大半结构，缺的是"工作回路没接上"**（`agent_questions`/`agent_read_cursors`/`agent_commands` 都已存在，但真正派工的守护插件零引用） |
| 改动总量 | **10–14 天**，六步（S0–S4），每步可独立回滚，**没有一步需要新建状态机** |
| 第二阶段 | **并发治理（D1–D3）** 见 §7、**自我进化（E1–E3）** 见 §8；顺序上 **E1 必须先于 D1** |
| 一条总原则 | **把"约定"变成"契约"**：现在靠提示词与前缀的地方，改成字段 + 拒收 |

**一句话**：Legion 的执行层比它强，缺的是**两头**（事件进不来、注意力出不去）和**中间一本账**（凭什么开工 / 为什么没做）。而这两头一账，Legion 的数据结构其实已经准备好了。

### 全局七条不可违反

| # | 约束 | 依据 |
| --- | --- | --- |
| 1 | 不新增第二个调度/状态源；attempt + 租约 + fileDomain 仍是唯一执行真相 | `design/legion-agent-orchestration-design.md:49` |
| 2 | 事件读位**复用 `audit.seq`**，禁止新造计数器 | `team-hub/event-delivery.mjs:1-18` |
| 3 | 新状态一律做**派生视图**，不改 `team-hub` 状态枚举 | 现网状态机在跑 |
| 4 | `@`/事件只能把强度提到 `explicit`，**不越** `claim-policy` 的 gate | `team-hub/claim-policy.mjs:64-104` |
| 5 | 名单制：发表者必须在空间成员/任务 scope 内 | 已有 `members` / scope |
| 6 | 编辑不追认、自 @ 不算、同一输入幂等 | `superagent/src/sources/github.ts:353`、`github-trigger.ts:62-63,68` |
| 7 | **状态写与事件追加必须同事务**；事件流只供记录/对账，**不得触发派工** | 见 §2.1；`team-hub` 的 `withTx` |

---

## 1. 全景：它跑一遍是什么样

一句话：**一个事件进来 → 过两道闸 → 变成一张带授权记录的工单 → 交给独立会话去干 → 只说三种话 → 线程后续自动回流 → 干完或被停。**

```
 外部世界          域内（可审计）                                    域外（执行）
 ───────────────   ──────────────────────────────────────────    ────────────────────
 ① 通知 / 人的指令 ─▶ ② Source
                       ├ Trigger（不可变 + actor）
                       └ Thread（同话题，单决策在飞）
                            │
                            ▼
                       ⑤ Gate ──▶ ⑥ Assess ──▶ ⑦ Decision
                                                  │ accept
                                                  ▼
                                       ⑧ Ticket + Mandate
                                                  │ ⑨ Assignment
                                                  ▼
                                       ⑩ Executor Session（独立目录 / worktree）
                                                  │ ⑪ Report 六态 · ⑫ Attention
                                                  ▼
                    ⑬ Subscription 回流（续跑不需再授权，但 ★ 不扩权）
```

| # | 环节 | 落点 |
| --- | --- | --- |
| ① | 人在 Issue `@agent 把登录限流改成滑动窗口` | 外部 |
| ② | Source 轮询通知（默认 1 分钟） | `sources/github.ts:297-342` |
| ③ | 归一化成 Trigger（不可变，带 actor） | `github-trigger.ts:65-77` |
| ④ | 归入 Thread（同话题，同时只有一个 Eval） | `001-domain.md:29` |
| ⑤ | Gate：名单 + 准入表 + 强度 | `002-authorization.md:11-16` |
| ⑥ | Assessment：逐条规则判一次 | `002:101` |
| ⑦ | Decision：accept / stop / ignore / unavailable | `001:109` |
| ⑧ | Ticket + Mandate（不可变授权） | `001:34-35` |
| ⑨ | Assignment（工单↔执行器实例） | `001:36` |
| ⑩ | 独立 Session + 目录（prepare 用 worktree，限 10 分钟） | `003:25,51` |
| ⑪ | Report 六态：progress/waiting/ready/blocked/failed/dropped | `001:112` |
| ⑫ | 三种说话：沉默 / 结构化问 / 说结果 | `notices.ts:127`、`replies.ts:16` |
| ⑬ | Subscription 回流：续跑不需再 @，但**不扩权** | `001:37` |
| ⑭ | 结束：ready / dropped / 人喊停撤回 Mandate | `003:92-106` |

**核心概念只有 5 个**（它自己的划法，`001:23`）：Source、Thread、Eval、Mandate、Subscription。其余是支撑——但支撑里 **Policy / Decision / Disposition / Attention** 四个决定成败。

---

## 2. 逐个概念：它是什么 × Legion 现状 × 怎么借鉴

> 每章五段：**作用** / **规则** / **不装的后果** / **Legion 现状** / **借鉴方案（含验收）**
> 处置标签：`复用`（已有，直接用）/ `接线`（已有结构，未接回路）/ `新建` / `不做`

### 2.1 Source（来源）与「状态 / 事件」的分工

- **作用**：把"外部发生了什么"翻译成域内事件，并**持有读位**。
- **规则**：读位不重放；丢弃自己的消息；"什么算事件"由来源自己定义。
- **不装的后果**：重启后要么重放（重复干活），要么漏读（永久丢失）。
- **Legion 现状**：**没有外部 Source**。输入是三个内部面：看板状态（守护每 30s 扫，`plugins/src/index.ts:4,230`）、定时自动化（`automation-store.mjs:1-40`，含重叠策略/补跑/等审批）、人的直接操作。

#### ① "状态驱动 vs 事件驱动"不是开关，是四层选择

| 层 | 状态驱动 | 事件驱动 | **Legion 实际** |
| --- | --- | --- | --- |
| ① 触发（怎么发现该干活） | 轮询"当前是否满足条件" | 订阅"发生了一件事" | **状态**：守护 30s 扫 + `materializeDue()` |
| ② 真相（权威存哪） | 状态表，覆盖写 | append-only 日志，状态由日志投影 | **混合**：`tasks.status` + `audit(seq…)` |
| ③ 一致性 | 乐观锁 version、认领互斥、租约 | 幂等 id + 因果序 | **状态**（很硬：`version` / `lease_epoch` / `confirm-stopped`） |
| ④ 传播 | 拉取 | 推送 | **事件**（SSE + `Last-Event-ID` + seq 回放） |

所以准确说法不是"Legion 是状态驱动"，而是：**状态驱动触发 + 状态机为真相 + 事件驱动观测**。这套混合本身是对的，问题只出在 ②③ 的接缝上。

#### ② 借鉴方案：保留状态为控制源，补事件为账

```
现状：状态是真相，事件只记了一半

   tasks.status ────────────── 能答"现在是什么"
        （覆盖写，唯一真相）

   audit ─────────────────────  记了：claim / transition / comment / rework
                                没记：gate / 集成 / 确认停止 / 工具失败  ← 设计稿 #13
                               ✗ 答不全"为什么变成这样"

目标：同事务双写 + 定期对账

   tasks.status ══(同一事务 withTx)══▶ audit
        │                              + actor_kind / addressed / human / event_id
        │ 派工只能看这里                  │
        ▼                                ▼ 重放到 seq N
   attempt / 士兵                  "应该是"的状态
        └────────── 对账：差异即报警 ◀─────┘
```

四种"双重控制"里只有一种安全：

| 做法 | 含义 | 判断 |
| --- | --- | --- |
| A 双写 | 业务代码分别写状态表与事件表 | ❌ 会分歧：一次成一次败，永久不一致 |
| **B 同事务双写** | 状态写 + 事件追加在**同一事务** | ✅ **采用**：`team-hub` 全走 `withTx`，同一 `team.db`，成本≈0 |
| C 事件为唯一写点、状态是投影 | 全量事件溯源 | ❌ 太贵：读位/重放/投影全要自己扛 |
| D CDC / 数据库触发器 | DB 自己产生事件 | ❌ 只能捕到"值变了"，拿不到"谁按的、为什么" |

#### ③ 判据：什么该事件化

> **凡是"只能被观测一次"的 → 事件化；凡是"可随时重算"的 → 保持状态推导。**

| 对象 | 判据 | 结论 |
| --- | --- | --- |
| 人的一次性指令、CI/验证回执、外部事件 | 只能观测一次 | **事件化** |
| 任务是否满足派工条件 | 可随时重算 | **保持状态推导**（`TASK_GATES` 不动） |
| 是否有未答 question | 可随时重算 | 做成 gate，不做监听 |
| 跳过 / 忽略的决定 | 只能观测一次 | **必须记账**（Disposition） |
| 评论内容 | 语义上是事件 | **迁出 `tasks.comments`**（S0） |

#### ④ 权限边界（防止"双重"变成"两个控制源"）

| | 谁写 | 谁读 | 能否触发派工 |
| --- | --- | --- | --- |
| 状态表 | 业务写点（`withTx`） | gate、看板、守护 | ✅ **唯一能触发** |
| 事件流 | 同事务追加 | 人、报表、评估、对账 | ❌ 不能；只产生候选，候选仍需过 gate |

#### ⑤ 三条纪律

1. **禁止裸 UPDATE**：状态写入必须与事件追加同事务（加守卫/测试，写法同 `assertTaskGatesShared()`）。
2. **事件必须幂等**：确定性 id（含 version）——状态驱动下重复扫描是常态。
3. **事件由业务写点产生**，不用数据库触发器——只有写点知道意图。

#### ⑥ 红利不是日志，是对账

定期把事件重放到某个 seq，得到"应该是"的状态，再与 `tasks.status` 实际值比对，**不一致即报警**。这是单独用状态或单独用事件都拿不到的能力。superagent 敢让工单阶段"全部推导"（`003:5-19`），就是因为它天生可对账。

**反面实证就在本仓**：设计稿 #13 记载 gate / 集成 / 确认停止 / 工具失败**不入 audit**——这正是"双写只写了一半"：动作改了状态，没留事件。而 `docs/DUAL-WRITE-RACE-evidence/` 说明这个接缝被专门处理过，是**结构性薄弱点**而非偶发 bug。

**验收**：故障注入下状态与事件要么都成要么都不成；重复扫描不重复记事件；对账任务 0 差异；用测试断言"gate 只读状态、不读事件"。

### 2.2 Trigger（触发）

- **作用**：不可变事件 + actor，是**幂等的单位**（同一事件受理两次只成一个工单）。
- **规则**：不可变；确定性 ID（含 version：编辑=新事件、重复读=同一事件）。
- **不装的后果**：一条评论两个工单；权限翻倍。
- **Legion 现状**：`audit(seq, ts, member, scope, action, taskId, detail)` —— 有 actor（`member`）、有 action、seq 单调。但它是**动作流水**，不是输入事件，`detail` 里没有准入需要的三个语义。

**借鉴方案：`接线`**（不新建表，只给现有 audit 补语义）

```
现状（现在这一行 audit）

  seq · ts · member · scope · action · taskId · detail
  ★ 只知道"谁做了动作"；不知道"这条消息是不是对我说的、是不是人说的"
        │
        ▼  同表加四列（同一事务，不新建表）
目标（同一行 audit，多四个语义）

  actor_kind   user | general | soldier | ci | bot
  addressed    mention | direct | none
  human        0/1                                ← 决定"能不能授权"
  event_id     hash(kind, subject, version)       ← 幂等键
```

| 改动点 | 内容 |
| --- | --- |
| `audit` 表 | 加 4 列（`actor_kind` / `addressed` / `human` / `event_id`），可空，老行回填按 `action` 推断 |
| 写入点 | 统一在 `audit()` 里派生 `event_id`；调用方传 `actor_kind` 与 `addressed` |
| 读取点 | gate 只读 `human` + `addressed`；报表读其余 |

**关键决策**：
1. **不新建 event 表**——全局约束 2（复用 `audit.seq`）；新表会立刻产生"两本账"。
2. **`human` 与 `addressed` 必须分开**：前者决定"能不能授权"，后者决定"是不是明确请求"。合成一个布尔值会把"bot @ 了我"误判成授权。
3. **幂等键含 version**：状态驱动下重复扫描是常态，重复写必须收敛成一行。

**验收**：同一评论/回执重复写入只产生一条事件；bot 与 CI 的 `human=false` 且永不产生 `explicit`；`event_id` 冲突时返回既有行而非报错。

---

### 2.3 Thread（线程）

- **作用**：同话题事件归并；**同时只允许一个决策在飞**，避免同一件事上两个相反决定。
- **不装的后果**：两个执行者对着同一话题做相反决定。
- **Legion 现状**：**已有**，只是叫法不同。

```
┌────────────┐        ┌──────────────────────────┐
│ conversations │◀────│ agent_conversation_bindings│
└────────────┘        │ (conv_id, agent_id, task_id)│
      │               └──────────────────────────┘
      │ task_id
      ▼
   tasks ──── comments[]（线程内的消息，现状存在任务列上）

现状：绑定已有；「同一会话只允许一个决策在飞」没有
     —— 现在靠 claim 互斥在**执行层**兜，不在**决策层**
```

**借鉴方案：`复用`（可延后）**

| 项 | 决定 |
| --- | --- |
| 绑定结构 | 直接用 `conversations` + `agent_conversation_bindings` |
| 缺的那条规则 | 「同会话单决策在飞」= 在 decisions 表加唯一约束 `(thread_id) WHERE state='running'` |
| 何时做 | 等 S3 落了 decisions 表再说；**不阻塞 S0–S2** |

**关键决策**：不在 Legion 新造 Thread 概念——`conversation` 就是 Thread，改名只会制造两套词汇。

**验收**：暂不设（延后项）。

---

### 2.4 Policy 与 Policy version（策略）

- **作用**：规则 + 名单 + 准入表 + accept mode 的**版本化快照**。
- **规则**：变了**不撤销**在途工单，只投递说明；吊销只发生在恢复前再校验。
- **不装的后果**："按哪版规则批准的"答不出来；规则一改，在途工作烂尾。
- **Legion 现状**：三套策略并存，各管一段，**没有一份"谁能让我开工"**。

```
   现状：三套策略 + 一个孤立的版本号

     rules 表（global / space 分层）    行为规范 · 散文 · 无版本 · 覆盖写
     permissions 规则                  动作级 allow/ask/deny · 有 id 无版本
     CLAIM_POLICY_VERSION @1          认领资格 · ★唯一有版本号
     tasks.ordersVersion              需求版本 · 只对需求文本
     ────────────────────────────────────────────────
     ✗ 四者之间没有引用关系；"受理依据"无处安放
```

**借鉴方案：`新建（轻）`**

```
   目标

     rules 表 ──(人工挑 3–5 条转写，不复制正文)──▶ policy_rules
        （不动，只作为                         (id, kind: always|when|never,
          人读的规范）                            text, scope, enabled)
                                                        │
                                                        ▼
                                          POLICY_VERSION = "legion/policy@N"
                                            （规则集一变就 +1）
                                                        │ 受理时冻结
                                                        ▼
                                  mandate.policyVersion
                                    ← 任务永远知道自己按哪版被批准
```

| 改动点 | 内容 |
| --- | --- |
| 新表 `policy_rules` | 4 类字段；初始转写 3–5 条 |
| 新常量 `POLICY_VERSION` | 规则集变化时递增（手动或按表哈希） |
| 写点 | `approve` 时把当前版本写进 mandate |
| 策略变更 | 只写一条 `policy_changed` 事件 + 给在途任务投一条说明；**不撤销** |

**关键决策**：
1. **`policy_rules` 引用 `rules` 的 id，不复制正文**——避免两份文本漂移。
2. **不做"变更即重评估"**：superagent 只投递说明（`002:107-119`），因为撤销会留下半成品。
3. **版本号用常量而非时间戳**：可 diff、可回滚、可写进 mandate 做长期引用。

**验收**：任务能反查 `policyVersion`；规则变更产生一条事件且不撤销在途任务；同一版本内重复受理结果稳定。

---

### 2.5 Gate（准入，确定性）

- **作用**：把"谁能发起、什么强度"从模型手里拿走，变成代码。
- **规则**：名单 + bot 名单 + 准入表三格 + 强度；非名单者默认 ignore。
- **不装的后果**：路人/bot 一句话就能让 agent 动生产。
- **Legion 现状**：**有 gate，但管错了对象**。

```
决策链上其实有两道闸，Legion 只有后面那道：

  事件/指令（人说话、@、回执）
        │
        ▼
  ┌ ① MANDATE_GATES ────────────────────── ✗ Legion 没有
  │   谁能让我开工？名单 · 准入表 · 强度
  │   → 现在由"将军这个模型"承担（依据落不下来）
        │ accept
        ▼
  tasks (status='todo')
        │
        ▼
  ┌ ② TASK_GATES ───────────────────────── ✓ 已有，且写得很好
  │   现在能不能被领走？status='todo' AND hold=0
  │   claim-policy.mjs:64-104（一份 SQL + holds() 镜像 + assert 防绕过）
        ▼
      attempt / 租约 → 士兵
```

**借鉴方案：`抄写法、换对象`**

| 项 | 现有 `claim-policy.mjs` | 新增 `mandate-policy.mjs` |
| --- | --- | --- |
| 约束数组 | `TASK_GATES` | `MANDATE_GATES` |
| 纯函数镜像 | `holds(task)` | `holds(candidate, policy)` |
| 防绕过 | `assertTaskGatesShared()` | `assertGatesShared()` |
| 管的问题 | 能不能被领走 | **该不该开工** |
| 输入 | 任务行 | 候选事件 + 名单 + 准入表 + accept mode |

准入表按 Legion 真实接收面写四行：

| 接收面 | 名单内且明确指向 | 名单内未指向 | 名单外指向 |
| --- | --- | --- | --- |
| 用户对话 / 指挥台 | explicit | inferred | ignore（默认） |
| 看板拖拽 | explicit | ignore | ignore |
| 自动化 / 脚本创建 | ignore | inferred | ignore |
| 士兵上报触发的新活 | ignore | inferred | ignore |

**关键决策**：
1. **两道闸分开，不合并**：①管"授权"，②管"调度"。合并会让"将军拦下任务"和"路人无权开工"变成同一件事，无法分别审计。
2. **纯函数镜像必须存在**：superagent 与 Legion 都靠它做 dry-run 与诊断；SQL 与函数不一致比没有更糟（`claim-policy.mjs:59-62` 同款理由）。
3. **`inferred` 默认不入队**（observe），只有显式 `auto` 才执行。

**验收**：四行 × 三格单测全覆盖；`assertGatesShared` 能拦住手写 SQL 的绕过；`inferred` 在 `observe` 档只记账不入队。

### 2.6 Assessment（研判，模型）

- **作用**：对**每条启用规则逐条判一次**（命中不命中都判）；主动受理至少命中一条。
- **不装的后果**："顺手做点没人要的"——主动性失控。
- **Legion 现状**：**评估器就是将军本人**（`COMMAND.md:31`：从 backlog 挑 2–5 个）。没有规则集，所以"为什么挑它"只活在将军的上下文里，任务落库之后就消失了。

```
现状：将军在脑子里判 ──▶ 只交出结论（一张任务卡）
                          ✗ 依据丢了
目标：将军判 ──▶ 结论 + 依据一起落库
        │
        ├─ 命中 R-2、R-5 ──▶ decisions(accept, basisRuleIds=[R-2,R-5])
        ├─ 卡片一看无关 ──▶ decisions(ignore, ignoredFromCard=true)   ← 快路
        └─ 拿不准/没人要 ──▶ decisions(ignore) 或 shouldAccept 记录
```

**借鉴方案：`新建（轻）`** —— 规则集来自 §2.4 的 `policy_rules`，结论落 §2.7 的 `decisions`

| 改动点 | 内容 |
| --- | --- |
| 将军提示词 | 挑任务时**必须**输出 `basisRuleIds[]` 或 `manual: true` |
| 写点 | `approve` 路由校验并落 `decisions` |
| 快路 | `ignoredFromCard` 允许不逐条判（照抄 `002:87-89`），单独计数 |
| 规则集 | 来自 §2.4 的 `policy_rules`，只读 |

**关键决策**：
1. **保留"不逐条判"的快路**：否则每条候选都要一次模型全量评估，成本与延迟都不可接受。
2. **`manual: true` 必须显式**：人特批是合法路径，但要留痕，不能与"命中规则"混为一谈。

**验收**：`accept` 决策必须有 `basisRuleIds` 或 `manual`，否则 422；`ignoredFromCard` 单独计数并可按空间聚合。

---

### 2.7 Decision（决定）

- **作用**：Eval 的输出，四值：`accept / stop / ignore / unavailable`。
- **规则**：**"没做"也要落库**；超时三次记 `unavailable`；面板只在 24 小时内、且是最后一条决定时打扰人。
- **不装的后果**：答不出"它为什么没动"，无法收敛噪音。
- **Legion 现状**：`audit` 记"做了什么"，状态迁移记"到哪了"，**没有"为什么没做"**。

```
一条候选
   │
   ├─ accept ──────▶ 建任务 + mandate（§2.8）
   ├─ ignore ──────▶ 只记账
   │                  ├ ignoredFromCard  （一看就无关）
   │                  └ wouldAccept      （observe 档："本会做"）
   ├─ stop ────────▶ 撤回 mandate（人喊停）
   └─ unavailable ─▶ 超时/失败 3 次，可重新排队
```

**借鉴方案：`新建`**

```sql
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,          -- task:<id> | goal:<id>
  thread_id     TEXT,                   -- 对应 conversation（§2.3）
  trigger_id    TEXT,                   -- 触发它的 event_id（§2.2）
  kind          TEXT NOT NULL,          -- accept|stop|ignore|unavailable
  matched_rule_ids TEXT DEFAULT '[]',   -- 命中哪些 policy_rules
  would_accept  INTEGER DEFAULT 0,      -- observe 档下"本会接受"
  reason        TEXT,                   -- 自由文本，仅辅助
  by            TEXT NOT NULL,          -- 决策者（general / user / ci）
  at            TEXT NOT NULL,
  policy_version TEXT NOT NULL          -- 决策时用的策略版本
);
```

| 改动点 | 内容 |
| --- | --- |
| 新表 | 上表；索引 `(subject)`、`(kind, at)`、`(would_accept)` |
| 写点 | `approve` → accept；`hold` → stop；跳过候选 → ignore；评估超时 → unavailable |
| 查询 | `GET /api/decisions?wouldAccept=true&scope=` |

**关键决策**：
1. **`would_accept` 与 `kind=ignore` 组合使用**：observe 档的语义是"忽略，但记为本来会接受"——不要为它新造第五种 kind。
2. **记 `policy_version`**：这条让"三个月前为什么批了它"可以精确回答。
3. **`reason` 只做辅助**：真正可查询的是 `matched_rule_ids`；自由文本不可统计。

**验收**：任意新任务可反查一条 `accept`；`?wouldAccept=true` 能列出"本会做但没做"；`stop` 与 `hold` 一一对应。

### 2.8 Mandate（授权）

- **作用**：把"凭什么让它干、能干多远"冻结成**不可变记录**。
- **规则**：不可变；只有人喊停能撤回；策略不再支持才吊销；**更宽范围 = 新工单**。
- **不装的后果**：授权来源丢失、事后无人认账、范围被悄悄放大。
- **Legion 现状**：**空白**。现有四样拼不出授权：

```
  tasks.soldier   → 谁认领了
  tasks.hold      → 将军拦过
  audit.member    → 谁按的按钮
  ordersVersion   → 哪版需求
  ────────────────────────────────────────
  ✗ 依据哪条规则  ✗ 什么强度  ✗ 谁请求的
  "谁按的按钮" ≠ "凭什么允许"
```

- **借鉴方案**：`新建`。挂在 `tasks` 上（JSON 列，无迁移）：

  ```jsonc
  "mandate": {
    "schema": "legion/mandate@1",
    "policyVersion": "legion/policy@1",
    "strength": "explicit",                      // explicit | inferred
    "requestedBy": { "kind": "user", "id": "u-1" },
    "grantedBy": { "kind": "general", "id": "general" },
    "basisRuleIds": ["R-2"],                      // 空则必须 manual:true
    "manual": false,
    "scope": { "fileDomain": ["team-hub/routes/"], "stages": ["coder","reviewer"] },
    "grantedAt": "2026-11-02T09:00:00+08:00"
  }
  ```
**生命周期（不可变 = 只追加，不原地改）**

```
approve ──▶ mandate v1 ──┬─ 范围变宽 ──▶ mandate v2   （v1 保留，任务指向 v2）
                         ├─ 人喊停   ──▶ revoked      （撤回，保留）
                         └─ 策略失效 ──▶ 恢复前再校验失败 → 吊销
```

| 改动点 | 内容 |
| --- | --- |
| `tasks` 表 | 加 `mandate` JSON 列（可空，无迁移） |
| `approve` 路由 | 校验并写入 mandate；缺 `basisRuleIds` 且非 `manual` → 422 |
| `hold` 路由 | 写 `revoked` 记录，**不改** mandate |
| `fileDomain` 变更 | 触发新 mandate 版本（递增），旧版本保留可读 |
| 查询 | `GET /api/tasks/:id/mandate?all=1` 返回版本链 |

**关键决策**：
1. **挂在 `tasks` 上而不是新表**：任务与授权 1:1，独立表会让"任务存在但没有授权"成为可表达状态。
2. **加宽范围 = 新版本，而不是修改**：这是 superagent 唯一硬性要求（`001:34`），也是"事后被悄悄扩权"的唯一防线。
3. **`hold` 与 `revoke` 分开**：`hold` 是调度拦截（可恢复），`revoke` 是授权撤回（需重新批准）。

**验收**：任意任务可反查 mandate 与版本链；缺 `basisRuleIds` 且非 `manual` → 422；加宽 fileDomain 后版本递增且旧版可读；老任务 `null` 不报错、不阻塞派工。

### 2.9 Ticket（工单）

- **作用**：授权的工作单元；**自己定义状态，不跟随执行器**。
- **Legion 现状**：**比它更硬**——多出文件域、验收标准、依赖、TTL、乐观锁。

```
  superagent: Ticket = 授权 + 渠道 + 输入
  Legion:     tasks  = 上述 + boundary(文件域) + acceptance(验收)
                       + blocks/blockedBy(依赖) + ttlMinutes + version
```

**借鉴方案：`复用`** —— 只在行上挂一个 `mandate` 列（§2.8），**不重建**。

| 决定 | 理由 |
| --- | --- |
| 不引入"Ticket"这个词 | `tasks` 已经是工单，改名只制造第二套词汇 |
| 不加 `stage` 列 | 阶段由 `deriveStage(task)` 派生（§2.11/§2.12），加了就会与状态机打架 |

**验收**：现有 `tasks` 相关测试全绿；加 `mandate` 列后老行 `null` 可读。

---

### 2.10 Assignment（派工）

- **作用**：工单↔执行器实例的绑定，**独立状态机**，一次工单可有多次。
- **Legion 现状**：**明显更强**。

```
  tasks ──1:N──▶ run_attempts ──1:1──▶ agent_run_bindings
                 (attempt_no,           (attempt_id, run_id,
                  state, 退避,            agent_id, worker_id,
                  next_attempt_at_ms)     lease_epoch)
                        │
                        └─▶ 预约 / 租约 / confirm-stopped 人工对账
```

**借鉴方案：`不做`（一处都别动）**

| 对比项 | superagent | Legion |
| --- | --- | --- |
| 状态 | pending→running→ended | 更多态 + 终态集合显式定义 |
| 并发 | maxWorkers + 一个额外槽 | 租约 + epoch + 预约，可对账 |
| 失败 | 退避三次 | 退避 + DeadLetter + 人工 `confirm-stopped` |

**关键决策**：把它写进"不要退回去"清单，任何"为了统一而重写 attempt"的提案都应被这条挡住。

**验收**：无（不动即通过）。

### 2.11 Executor 与 Report（六态）

- **作用**：把执行器的意图变成**结构化事实**，让工单阶段可推导。
- **六态**：`progress / waiting / ready / blocked / failed / dropped`（`001:112`）。其中 **`dropped`（无需处理）是合法结局，默认不发消息**。
- **不装的后果**：**"假完成"与"假受阻"**。
- **Legion 现状**：**只有两态**，但验证维度极细。

```
现状（压缩成两个值，逼出两种谎）

  士兵的真实处境                   现在只能报             后果
  ─────────────────────────────────────────────────────────────
  做完了，可交付                  → done                 ✅
  卡在技术上                      → blocked              ✅
  这活不值得做 / 已不必要          → done（假完成）        ❌ 污染验收
  在等外部条件 / 等人              → blocked（假受阻）     ❌ 制造噪音

  同一份 WorkerReport 里：
    testReport / testVerification / review / goalRef / artifact
        ← 验证维度很细（强项，保留）
    status: 'done' | 'blocked'
        ← 意图维度只有两个值（缺口）
```

**借鉴方案：`接线（扩枚举）`** —— **S1a**

```
目标（四态，把两种谎变成合法状态）

| 报告值 | 看板映射 | 副作用 |
| --- | --- | --- |
| `done` | `in_review` | 不变 |
| `waiting` | `idle` | **必须带 `waitFor`**（在等什么，结构化） |
| `blocked` | `blocked + question` | **必须带 `question`**（S1b 落地后） |
| `dropped` | `done(no-action)` | ★ **不发任何消息** |
```

| 改动点 | 内容 |
| --- | --- |
| `plugins/src/index.ts:331-350` | `status` 枚举扩为四值；`waiting` 加 `waitFor: string`（带枚举化原因，不是自由文本） |
| `WORKER_SCHEMA`（`:380` 一带） | JSON schema 同步 |
| 守护分支 | `dropped` 走"不发消息、直接结束"；`waiting` 走 idle |
| 提示词（`:2182-2194`） | 四态各给一条示例，明确"不值得做就报 dropped" |

**关键决策**：
1. **`progress` 暂不做**：它与"沉默"冲突——superagent 的 progress 从不外发（`notices.ts:127`），Legion 连外发渠道都没有，做了只是噪音。
2. **`waiting` 必须带结构化原因**：否则它退化成第二种 `blocked`（这正是"从自由文本推断状态"被 superagent 明确拒绝的做法，`001:60`）。
3. **`dropped` 默认不发消息**：这是它存在的全部意义；一发消息就变回噪音。

**验收**：四态各一条用例；`dropped` 不产生评论与通知；`waiting` 缺 `waitFor` 则拒收；`blocked` 无 `question` 过渡期仍按现状处理（一个版本后收紧）。

### 2.12 Attention（待人工决定）

- **作用**：把"我需要人拍板"变成**有 id、有状态、可被一条消息回答**的对象。
- **规则**：一个工单**同时只有一个**未答问题；回答必须对得上当前问句；问句变了撤回旧回复。
- **不装的后果**：问句淹没在长文本里、答非所问、沟通返工。

**Legion 现状：两层割裂（本次最重要的发现）**

```
   工作层（士兵 / 守护）              存储层（team-hub）              面板
  ──────────────────────────────────────────────────────────────────────
   ❓ 待将军确认…           ──写进──▶
   写进 blocker                          agent_questions               已在读
   （文本约定）                          body / options_json /         该表
                                          status / version /
   守护 parse                            answer / answered_by
   → 评论 + blocked      ◀──问/答闭环齐全──
                            （question() / answer()）

   ┆
   ┆ ★ 零引用：守护插件对 agent_questions grep 0 命中
   ┆   于是"问句"是文本、"答句"是评论，两者靠人脑对齐
```

**借鉴方案：`接线`（不是新建）** —— **S1b**

```
目标：一条问句的完整生命
─────────────────────────────────────────────────────────────
士兵 ──report{blocked, question{body, options}}──▶ 守护
                                                   │
                        ┌──────────────────────────┤
                        ▼                          ▼
             agent_questions(open)          会话消息（结构化卡片）
                        │
          ┌─────────────┴──────────────┐
          │ TASK_GATES.no-open-question│──false──▶ 不派工（停在这里）
          └─────────────┬──────────────┘
                        │ 人回答：answer(attentionId, text, version)
                        ▼
             status='answered', answer, answered_by
                        │
                        ▼
              任务回 todo ──▶ 续跑（答案作为输入带入）
                        │
                        ▼
        问句变了？→ 旧问句 superseded + 撤回其未发出的回复
```

| 改动点 | 内容 |
| --- | --- |
| `plugins/src/index.ts:335` | `WorkerReport` 加 `question?: { body: string; options?: string[] }`（**字段名与表对齐**） |
| `:3422` `blocked` 分支 | 把 `❓` 评论改为写 `agent_questions` + 会话消息（复用 `question()`） |
| `claim-policy.mjs:64-104` | `TASK_GATES` 加 `no-open-question`（SQL + `holds()` 镜像 + assert） |
| 回答路径 | 走已有 `answer()`（`:206-209`），`version` 乐观锁 |
| 兼容 | `❓` 文本约定保留一个版本，读取时双向兼容 |

**关键决策**：
1. **不新建 attention 结构**：`agent_questions` 已经有 `options_json`、`version` 乐观锁、`answered_by`，重建等于制造第二套。
2. **"有未答问题"必须做成 gate，而不是事件监听**：按 §2.1 判据——它随时可重算，属于状态推导。
3. **一次只允许一个未答问题**：靠 `agent_questions` 上加唯一约束 `(task_id) WHERE status='open'`，而不是靠提示词。

**验收**：`blocked + question` → 任务停派；回答后自动回 `todo` 并续跑；两处并发回答只有一条生效（version 冲突 409）；两个未答问题同时写入被唯一约束挡下；`❓` 老数据仍可读。

### 2.13 Subscription（订阅）

- **作用**：上下文自动回流；**续跑不需重新授权，但不扩权**。
- **不装的后果**：人要重复解释；或反向——一追加消息就顺手扩权。
- **Legion 现状**：**半条**——评论确实能唤醒执行者，但语义只有"你重做"。

```
现状（一条评论只有一个含义）
   有人在 in_progress 任务上评论 ──▶ 守护判定"被退回" ──▶ 派纠错 worker
                                    （plugins/src/index.ts:10-11）
   于是："这里是新需求" 和 "你做错了" 被压成同一件事
```

**借鉴方案：`接线（扩语义）`** —— **S2**

```
目标（同一条评论，三个语义出口）
   任务评论（新增评论才算）
        │
        ├─ "@coder 改成滑动窗口"  ──▶ 追加：投给当前执行者 → 任务回 todo 续跑
        │                             （范围仍受 mandate.fileDomain 约束）
        ├─ "@general 口径由你定"   ──▶ 升级：生成 attention（§2.12）
        │                             → 任务进 awaiting_answer
        └─ 无 @                    ──▶ 驳回：现有 rework 路径（完全不变）
                                        ↓
                                   四条护栏
                                   ① 只投 scope 成员
                                   ② 只在 in_progress / awaiting_answer 生效
                                   ③ 自 @ 忽略
                                   ④ 只认新增评论，编辑不入队
```

| 改动点 | 内容 |
| --- | --- |
| 评论写路径 | 解析 `@<role>`（边界正则，照抄 `github-trigger.ts:60-61`） |
| 投递通道 | **复用 `agent-messages`**（`agents.mjs:12`），**不造第三条入口** |
| 幂等 | `inputId = hash(taskId, commentId)`；同评论只投一次 |
| 语义判定 | 有 @ 且 @ 的是任务当前角色 → 追加；@general → 提问；其余 → 现状 |
| 灰度 | `mention.enabled`（默认 false） |

**关键决策**：
1. **不新建投递通道**：Legion 已为"两条入口"付过代价——同一个 (空间,岗位) 曾同时有"对话中心会话"和"汇报流会话"，最后靠**收养**合并（`agent-conversations.mjs:108-117` 注释："两条标题一样，汇报只在后者、人的消息只在前者"）。第三条入口会重演这个坑。
2. **"追加"必须仍受 mandate 约束**：这正是"订阅 ≠ 授权"（`001:37`）——可以续跑，不能扩权；超 `fileDomain` 要求新任务。
3. **先定死"有 @ = 追加，无 @ = 驳回"**：语义歧义比技术缺陷更难修，会在士兵行为上留下长期混乱。

**验收**：`@coder …` 追加续跑；无 @ 仍走退回；自 @ 忽略；同评论幂等；超 fileDomain 拒绝并要求新任务；`mention.enabled=false` 时与今天行为完全一致。

---

### 2.14 Channel（渠道）

- **作用**：回话写地址；话在哪说，结果回哪去；渠道失效则**丢弃并留档**。
- **Legion 现状**：多而散，无"失效丢弃留档"，也无"同工单同会话保序"。

```
   任务评论 ─┐
   agent-messages ─┼─▶ 都能到人，但没有统一的"这次回话属于哪条工单"
   mesh 总线 ─┤
   handoff ──┘
   ✗ 渠道失效时不留"为什么没送到"
```

**借鉴方案：`不做`**（内部场景靠看板复核即可）

| 保留的唯一纪律 | 理由 |
| --- | --- |
| 任何对外消息必须带 `purpose`（`attention/answer/result/progress`） | 它是附录 A 注意力度量的最小前提；不带就无法区分打扰与通知 |

**关键决策**：不为了"完整性"先建渠道抽象——它只有在接外部 Source（GitHub/IM）时才有价值，而外部 Source 已在 §3 不做清单里。

### 2.15 Disposition（去向）

- **作用**：记录每条输入**最终去哪**：filtered / evaluated / fanned out。**它记的是"没做"**。
- **不装的后果**：无法收敛噪音，也无法安全放开自动化。
- **Legion 现状**：**没有**。将军没挑某任务、守护跳过多条候选——**不留痕**。

```
现状：候选 → （将军没挑） → 消失。
      唯一记录是"没发生的证据"，即不存在。

目标：与 decisions 同表，用 kind 区分

  decisions 按 kind 分布（示意）
  accept      ████████████████ 32    ← 做了
  ignore      ██████ 12              ← 看过没做（含 ignoredFromCard）
  wouldAccept ███ 6                  ← observe 档："本会做"
  unavailable █ 2                    ← 评估失败/超时
              └─────────────── 这张图就是"为什么没动"的答案
```

**借鉴方案：`新建（极便宜）`** —— 与 §2.7 的 `decisions` **同表不同 kind**，不另设表。

| 改动点 | 内容 |
| --- | --- |
| 表 | 复用 `decisions`（`kind=ignore/unavailable` 即 Disposition 记录） |
| 写点 | 候选被跳过时写一条，带 `matched_rule_ids`（可为空） |
| 展示 | **按天聚合**，不进实时时间线（否则淹没真事件） |

**关键决策**：**不建独立表**。Disposition 与 Decision 是同一件事的两面（一个是"做了"，一个是"没做"），拆表会导致"同一次评估写两处"。

**验收**：`observe` 两周后能输出"本会做但没做"的条数、分布与命中规则；聚合查询不扫全表。

---

### 2.16 Strength 与 accept mode（两个旋钮）

- **作用**：`explicit/inferred` 决定"够不够格开工"；`off/observe/auto` 决定"多快能自己开工"。
- **不装的后果**：无法区分"人要求的"与"agent 觉得该做的"；无法"先只记录不做"。
- **Legion 现状**：二元（批准=干，不批=不干）。

```
**借鉴方案：`新建（两个枚举）`** —— 随 §2.6 / §2.8 一起落，几乎零成本

目标：两个正交旋钮组成的 3 × 3 九宫格

| 强度 ↓ ／ 档位 → | `off` | `observe`（默认） | `auto` |
| --- | --- | --- | --- |
| **explicit**（人点名 / 私聊 / 拖拽） | ✅ 执行 | ✅ 执行 | ✅ 执行 |
| **inferred**（未点名 / 推断 / bot） | ❌ 不入队、不记账 | 📝 只记 `wouldAccept`，不入队 | ✅ 执行，**且需命中 ≥1 条规则** |

★ 默认：`explicit` 照常执行，`inferred` 一律走 `observe`
```

| 改动点 | 内容 |
| --- | --- |
| `policy_rules` 旁 | 加一份 `accept_mode`（单一值，落 settings 或 kv） |
| `mandate.strength` | 两个枚举值，受理时冻结（§2.8） |
| gate | `inferred + mode≠auto` → 只写 `wouldAccept`，不入队 |
| 切换 | 改 `accept_mode` 需显式动作 + audit，不随提交静默生效 |

**关键决策**：
1. **两个旋钮正交**：合成为一个"信任等级"会失去"人明确要求就该做"的能力。
2. **默认 `observe` 而不是 `off`**：`off` 是"什么都不记"，`observe` 才产生判断依据——没有数据永远不敢放开。
3. **切 `auto` 必须留审计**：这是唯一能让"谁放开的自动化"可追溯的地方。

**验收**：`observe` 档下 `inferred` 候选 100% 不入看板、100% 留 `wouldAccept`；`explicit` 在任何档位都执行；切 `auto` 产生一条 audit 且可回滚。

### 2.17 Input（输入）——Legion 的评论就是错位的输入

- **作用**：交付给工单的上下文：扇出的触发、策略变更、恢复、纯文本。**Input 是事件，不是状态。**
- **规则**：一条 Input 只被消费一次（有读回收据）；未读的在工单结束时回流评估。
- **不装的后果**：评论丢失或重复；"人说了但没人接"。

**Legion 现状：评论被存成状态 + 事件两份**

```
现状
  人写评论 ──▶ route ──┬─▶ tasks.comments = JSON 数组（整列覆盖）   ← 状态
                       └─▶ audit(action='comment')                  ← 事件
                            ↑
              两次并发写：后写覆盖先写
              （version 乐观锁是唯一防线；DUAL-WRITE-RACE-evidence/ 的来源）

  并且：评论既是"状态"又是"事件"，于是
        · 想按时间回放 → 只能靠 audit
        · 想取当前全部评论 → 只能读列
        · 两者不一致时，谁是真相？
```

**借鉴方案：`新建（S0，0.5 天）`**

```
目标
  人写评论 ──▶ route ──┬─▶ task_input(id, task_id, actor, body,
                       │             created_at, consumed_at,
                       │             superseded)          ← append-only，唯一真相
                       └─▶ audit(event_id=hash(...))       ← 同事务
                                    │
                                    │ 投影（只读）
                                    ▼
                            tasks.comments  ← 保留一个版本，随后废弃

  · 幂等：inputId = hash(taskId, commentId)
  · 消费回执：consumed_at（一条 Input 只被消费一次）
  · 替换：superseded（问句变了/被新指令取代）
```

| 改动点 | 内容 |
| --- | --- |
| 新表 `task_input` | 上表 + `inputId` 唯一约束 |
| 写路径 | `team-hub/routes/comment.mjs` 改为写 `task_input`（同事务写 audit） |
| 读路径 | 一个投影函数生成 `comments` 视图，老代码不改也能读 |
| 迁移 | 脚本回填历史 `comments`（按 `commentId` 幂等，可重跑） |
| 消费 | S1b/S2 从这里取输入，`consumed_at` 标记 |

**关键决策**：
1. **排在所有步之前（S0）**：它同时是 S1b（回答绑定需要稳定输入行）、S2（@ 需在输入上标语义）、S4（事件地基）的前提。
2. **保留一个版本的投影**：让读路径可以回退，避免一次性大改。
3. **`superseded` 而不是删除**：被取代的输入要留档——否则"我说过这句话"会变成不可证明的事。

**验收**：并发两条评论都留痕、无覆盖；同一评论重复提交只一行；迁移可重复执行且不产生重复；`tasks.comments` 读路径与投影一致；对账任务能发现"投影 ≠ 行表"的不一致。

---

## 3. 不做清单

| 项 | 理由 |
| --- | --- |
| 装 dsh-superagent 插件 | 桌面端无 CLI / 单实例 / peer 精确 pin 不符；Windows POSIX 四道硬阻塞（实测 43/1197 用例失败） |
| 外部 Source（GitHub/飞书） | Legion 的输入是人，没有需要公网入站的事件流；若将来接，优先"可轮询的账号通知"而非 webhook |
| Correlation（关联线程） | 服务于 Issue↔PR↔review 的多线程形状，Legion 一任务一 worktree 无此形 |
| Channel 具体实现 | 内部场景用看板复核即可；仅保留 `purpose` 字段纪律 |
| worker slot / 30 分钟后台规则 | 与 attempt 租约/TTL 冲突 |
| 第二套调度/状态机 | 违反全局约束 1 |
| 新造事件计数器 | 违反全局约束 2；复用 `audit.seq` |

---

## 4. 六步计划（由概念章节汇总而来）

| 步 | 涉及概念 | 内容 | 工期 | 回滚 |
| --- | --- | --- | --- | --- |
| **S0** | Input / Channel | 评论从 `tasks.comments` 迁到 append-only `task_input`，同事务写事件 | 0.5 天 | 保留投影一个版本，读路径回退 |
| **S1a** | Report 六态 | 四态：`done/waiting/blocked/dropped`，`dropped` 不发消息 | 0.5–1 天 | 枚举回退 |
| **S1b** | Attention | 接线 `agent_questions` + `TASK_GATES` 加 `no-open-question` | 1–1.5 天 | flag |
| **S2** | Subscription | 评论 `@角色` 复用 `agent-messages`，语义三分 | 2–3 天 | `mention.enabled=false` |
| **S3** | Policy/Gate/Assessment/Decision/Mandate/Disposition/Strength | `policy_rules` + `decisions` + `mandate` + 两个枚举 | 3–4 天 | 只写不改读 |
| **S4** | Source/Trigger | `LegionEvent`（复用 `audit.seq`）+ `event_cursor` + `watches` + **对账任务** | 4–6 天 | 只写不入队 |

**总计 10–14 天。** 六步全部是"接线/加表/加字段"，没有一步需要新建状态机。

**为什么 S0 排第一**：评论是 Legion 里最明显的"事件塞进状态列"，它同时卡着 S1b（回答绑定需要可靠的输入行）、S2（@ 需要在输入上标注语义）与 S4（事件流的地基）。先把它做成 append-only，后面三步都是顺水推舟。

### 每步的改动点与验收（摘要）

**S0**：`team-hub/routes/comment.mjs` 改写路径；新增 `task_input` 表与投影；迁移脚本回填。
验收：并发评论不丢；同评论幂等；投影与旧 `comments` 一致；状态写与事件追加同事务（故障注入用例）。

**S1a**：`plugins/src/index.ts` 报告类型与校验；`dropped` 分支不发评论。
验收：四态用例；`dropped` 无副作用；`waiting` 缺"在等什么"拒收。

**S1b**：`WorkerReport.question`；`blocked` 分支改写 `agent_questions`；`claim-policy.mjs` 的 `TASK_GATES` 增一条。
验收：有未答问题不派工；回答后回 `todo`；并发回答 409。

**S2**：评论写路径解析 `@<role>`（边界正则）；复用 `agent-messages` 投递；`mention.enabled` 灰度。
验收：追加/驳回/回答三分；名单外不投；自 @ 忽略；幂等；超域拒绝。

**S3**：`policy_rules` / `decisions` 两表；`approve` 写 mandate；`Strength`/`acceptMode` 两枚举；`ignore`/`unavailable` 兼作 Disposition。
验收：可反查 mandate；缺依据 422；`wouldAccept` 可查；规则变更不撤销在途。

**S4**：`LegionEvent` + `event_cursor` + `watches` + `evaluate()` + **对账任务**（事件重放 vs 状态表）。
验收：幂等；重启不重放；三决策可落；对账 0 差异；gate 只读状态的断言通过；`events.enabled=false` 时行为不变。

---

## 5. 闸门与总验收

### Go / No-Go

| 闸门 | 看什么 | 不达标 |
| --- | --- | --- |
| S0 后 | 并发评论丢失数、投影一致性、对账差异 | 有任何丢失 → 先修 S0，**不进入 S1** |
| S1a 后 | `dropped` 占比、`waiting` 平均时长 | `dropped` 异常高 → 说明任务质量差，先治需求 |
| S1b 后 | 每任务提问次数、`stuck` 占比 | >3 次/任务 → 改提示词，**暂停 S2** |
| S2 后 | `@` 占比、"追加 vs 驳回"误判率 | >20% → 上显式前缀 |
| S3 observe 两周 | `wouldAccept` 与人工判断一致率 | <70% → 不放开 `auto` |
| S4 后 | 附录 A 的 A/I、D/I、重问率 | 见附录 A 阈值 |

### 总验收矩阵

| # | 断言 | 概念 |
| --- | --- | --- |
| A1 | 同一输入重复写入只产生一条事件/一条 input | Trigger |
| A2 | 四态报告各一条用例；`dropped` 无副作用 | Report |
| A3 | 有未答 question 时任务不派工 | Attention |
| A4 | 回答必须对得上当前 question id/version，否则 409 | Attention |
| A5 | `@` 只投 scope 成员、只在可续跑状态生效 | Subscription |
| A6 | 每个新任务可反查一条 decision + 一条 mandate（否则 422） | Policy/Mandate |
| A7 | `wouldAccept` 可查、可按空间过滤 | Decision/Disposition |
| A8 | 规则变更不撤销在途任务，只写变更事件 | Policy version |
| A9 | 五个 feature flag 全关时行为与今天一致 | 全部 |
| A10 | 每条出站消息带 `purpose`；`progress` 不进 push | 附录 A |
| A11 | 并发评论都留痕、同评论幂等、投影与旧口径一致 | Input（S0） |
| A12 | 事件重放与状态表对账 **0 差异** | Source/Trigger |
| A13 | gate 只读状态、不读事件（用测试断言） | Source/Trigger |

---

## 6. 拍板点

1. **是否从 S0 开工**（0.5 天）：评论 append-only 化 + 同事务事件。它最便宜，且是 S1b / S2 / S4 的地基。
2. **接着是否上 S1a**（0.5–1 天）：消灭"假完成/假受阻"，当天可见。
3. **S2 的语义是否按"有 @ = 追加，无 @ = 驳回"定死**（会改动士兵行为习惯，越早定越好）。

---

## 7. 并发治理：多目标 / 多任务同时跑

> 与 §2 的关系：§2 管"一张工单做对"，§7 管"很多工单同时不打架"。

### 7.1 现状：Legion 已经有五层，比 superagent 细

```
  ⑦ 冲突可解释   GET /api/tasks/:id/contention
  ────────────────────────────────────────────────────────────────
  ⑥ 预算          reserve / observe / settle（budget-ledger）
  ────────────────────────────────────────────────────────────────
  ⑤ 真·多进程     WAL 跨进程可见 · busy_timeout · 原子认领
                  （用 child_process 真进程测过，不是同进程两条连接）
  ────────────────────────────────────────────────────────────────
  ④ 依赖          blocks / blockedBy（用条件闸门避免 openDeps 死锁）
  ────────────────────────────────────────────────────────────────
  ③ 预约 / 租约   reservation + lease_epoch + confirm-stopped
  ────────────────────────────────────────────────────────────────
  ② 文件域互斥    write-intent ⊆ fileDomain（越界 422）
  ────────────────────────────────────────────────────────────────
  ① 空间级并发    space_runtime.maxWorkers（默认 1）
```

| 层 | 机制 | 证据 |
| --- | --- | --- |
| ① 空间级并发上限 | `space_runtime(scope, enabled, maxWorkers, isolate, review_workflow)` | `exec-routes.test.mjs:66-104,283-307` |
| ② 文件域互斥 | write-intent 必须 ⊆ fileDomain，越界 422 `OUT_OF_FILE_DOMAIN` | `contention-paths.test.mjs:76`、`routes/write-intent.mjs` |
| ③ 预约 / 租约 / epoch | 防"两个 worker 同时执行"；`confirm-stopped` 人工对账 | `claim-reservation.e2e.test.mjs` |
| ④ 依赖 | `blocks` / `blockedBy`，且刻意用"条件闸门"而非依赖链把关，**避免 openDeps 死锁** | `plugins/src/index.ts:2208` |
| ⑤ 真多进程并发 | WAL 跨进程、`busy_timeout` 真在等、`BEGIN IMMEDIATE` 原子认领 | `run-concurrency.test.mjs:1-18` |
| ⑥ 预算 | `reserve / observe / settle` | `budget-ledger.mjs:570,842` |
| ⑦ 冲突可解释 | `GET /api/tasks/:id/contention` | `contention-paths.test.mjs:3,34` |

### 7.2 superagent 的三条补充（它整体更弱，但有三个点子）

```
  ① 给人留一个额外槽（003:59）

       后台新活 × maxWorkers        ★ 保留槽 ×1
       [后台][后台][后台]           [人的消息]
       └── 满了就排队 ──┘           └── 永远能插进来 ──┘

     满负荷时：新活进不来，但人能立刻插话

  ② prepare 并发（003:61）：慢的准备只阻塞自己那张工单
  ③ Eval 按 Thread 串行（001:29）：同话题同时只有一个决策在飞
```

| 补充 | Legion 现状 | 是否值得补 |
| --- | --- | --- |
| 人优先的保留槽 | 没有：人的消息与后台新活抢同一批槽 | ✅ 值得（见 D2） |
| prepare 并发 | 任务内串行，影响小 | ⬜ 不急 |
| 同话题单决策在飞 | 靠 claim 互斥在**执行层**兜，决策层没有 | ⭕ 可延后（§2.3） |

### 7.3 四个缺口（按会先疼的顺序）

```
① 目标级公平 —— 大目标饿死小目标

   空间 maxWorkers = 3，大目标切了 12 片：

       槽位占用：  [大1][大2][大3]        ← 永远被大目标占满
       小目标：    排队 · 排队 · 排队      ← 永远轮不到
       ✗ 缺"目标级 fair share / 权重"

② 没有抢占：PRIORITY_ORDER_SQL 只影响认领顺序
   紧急 bug 插不进正在跑的大重构（已在跑的任务不会让槽）

③ 没有"人优先"：人发的一句话 与 后台新活 抢同一批槽
   人等着，机器在忙别的

④ 并发 × 注意力 = 指数级噪音
   N 个任务同时 blocked ＝ N 条 ❓ 砸向将军
   ★ 并发治理不只是槽位管理，也是注意力配额管理
```

### 7.4 路线：D1 → D3

| 步 | 做什么 | 落点 | 验收 |
| --- | --- | --- | --- |
| **D1** | **目标级配额**：在 `space_runtime.maxWorkers` 之下加 `goal_share`（每目标最多占 N 槽 / 加权轮转） | `claim-policy.mjs` 的候选 SQL 增加 goal 维度排序与配额 | 12 片大目标 + 1 个单任务小目标同空间并发时，小目标 P95 等待 ≤ 约定阈值 |
| **D2** | **抢占 + 人优先槽**：人的输入可占保留槽；紧急任务可请求"让槽"（向当前持有者投 `stop`，走已有 `agent_commands`） | `agent_commands`（`agent-conversations.mjs:249+`）+ 空间配置加 `reservedSlots` | 满负荷下人的消息 P95 响应 < 30s；被抢占任务能 resume 且不丢上下文 |
| **D3** | **并发可解释**：把 `contention` 聚合成"我被谁挡住、等多久"，进看板 | `routes/write-intent.mjs` 的 contention 聚合 | 任一排队任务一眼看出阻塞源（租约 / 文件域 / 依赖 / 槽位） |

**关键决策**：
1. **配额加在 gate，不加在守护**：和 §2.5 同理——可判定的部分下沉成代码，守护只执行。
2. **抢占只能通过现有 `agent_commands` 通道**：不新造"双向控制通道"（否则又是一个第二控制源）。
3. **并发上限与注意力配额绑定**：N 个槽同时 `blocked` 时，`❓` 必须聚合成一条"3 个任务在等同一类决定"，而不是三条（这是附录 A 的 D/I 指标落地处）。

---

## 8. 自我进化：规则迭代 / 错误归纳

> 与 §2 的关系：§2 把契约立起来，§8 让契约**越用越准**。

### 8.1 现状：这一维 Legion 比 superagent 走得更远

superagent **没有自我进化机制**：提示词是人手改的，唯一相关的是"升级后标 `Default updated`，让人复查哪些默认变了"（`006:240-241`）。要抄的东西几乎没有。反过来，Legion 已有的组件其实已经构成"原料 + 仓库"：

```
  原　料                        仓　库                          已有的门
  ─────────────────────────  ────────────────────────────  ──────────────────
  audit                      experience-store（F-18）      skills
  decisions          ──▶      · 摩擦分 · 草稿 draft   ──▶   register
  wouldAccept                · 关系图 promote/discard       → review
  返工率                       ★ 记录即真相，状态靠推导       → publish
                                                            → grant
  docs/bugs/BUG-NNN          rules（global / space）
                             role-pack（带版本 @v）
  ─────────────────────────  ────────────────────────────  ──────────────────
  ★ 原料齐、仓库齐、门也齐 —— 缺的是把两头接起来的管道
```

| 已有 | 它其实是什么（证据） |
| --- | --- |
| **F-18 经验图谱 / 摩擦学习** | 造草稿、维护关系图，**晋升/丢弃都记成记录而非改状态**（`experience-store.mjs:1-37`）——已经是"经验→候选"的完整数据面 |
| **技能中心** | `register → review → publish → grant`，`pending` 有收口（只有 general 复审视角可看草稿） |
| **rules 分层** | global / space 两层的规则文本 |
| **role-pack 版本化** | 岗位包带 `@v`，可冻结可引用（`role-pack-store.mjs:334,449`） |
| **docs/bugs/** | 错误现场记录（`LEGION.md:32`） |
| feedback-heartbeat / budget-alert | 两个现成反馈回路 |

**结论：有原料、有仓库、有门，缺的是把两头接起来的管道。**

### 8.2 缺的是一条闭环（本图是 §8 的重点）

```
   ① 观测          ② 归因          ③ 候选        ④ 验证        ⑤ 固化        ⑥ 回归
  ───────────    ───────────    ───────────   ───────────   ───────────   ───────────
   decisions ──▶  失败聚类    ──▶ experience ──▶ 影子对比   ──▶ rules /   ──▶ 回归集
   wouldAcc       按 stage /      draft          同批任务       role-pack      不退化门
   audit          规则 / 路径     ★ 已有          并排 A/B       skills         ★ 新建
   返工率         （不是逐条读）                               POLICY_VER
                      ▲                                                          │
                      └──────────── 下一次观测（闭环） ◀───────────────────────────┘
```

| 步 | 现有 | 要补 |
| --- | --- | --- |
| ① 观测 | `audit`、`decisions`、`wouldAccept`（S3 后）、附录 A 指标 | 变成**周报字段**，而不是查的时候才拼 SQL |
| ② 归因 | `contention`、blocker 文本 | **失败聚类**：按 stage / 规则 / 文件域聚合 |
| ③ 候选 | **`experience` draft 已有** | 让 draft **指向**要改的对象（哪条 rule / 哪个 stage prompt / 哪个 skill） |
| ④ 验证 | 无 | **影子运行**：候选在 observe 档跑，与现状对比同一批任务的决策 |
| ⑤ 固化 | `skills` 有 review 门、`role-pack` 有版本 | 规则要带**版本号 + 变更记录**（§2.4 的 `POLICY_VERSION` 正是它） |
| ⑥ 回归 | 无 | **回归集**：历史失败固化成必过用例（`docs/bugs/` 是天然素材） |

### 8.3 三条硬约束（防自我进化失控）

```
① 评价标准不可自我修改
   ┌ 回归集 + 硬指标  ← 由人持有，agent 无权编辑
   └ 否则 agent 会优化指标，而不是变好（Goodhart）

② 晋升必须过人的门
   自动提议 ✅ ──▶ review 门 ──▶ 生效
        自动生效 ❌

③ 每次进化必须留"前后对比"
   没有对比 = 无法回滚 + 无法判断是否真的变好
```

**这三条里最重要的是第一条**：一旦"什么算好"可以被 agent 改写，整套进化就退化成了"自我认证"。`policyVersion`（§2.4）与附录 A 周报是进化机制的**前置条件**，不是可选项。

### 8.4 路线：E1 → E3

| 步 | 做什么 | 落点 | 验收 |
| --- | --- | --- | --- |
| **E1** | **错误归纳机械化**：失败 → 聚类 → 自动生成回归 case | `docs/bugs/` + 测试目录；由守护在 `failed/blocked` 后生成 | 每个 P0 bug 都被固化成回归用例；新提交跑不过就拦下 |
| **E2** | **规则候选的影子验证**：`experience draft` → 指向具体 rule / stage prompt → observe 档并排跑 | `experience-store` + §2.7 `decisions` | 候选与现状在同一批任务上的决策差异可量化；差异 > X% 需人工看 |
| **E3** | **不退化门**：改 rules / role-pack / prompt 前后跑回归集 + 附录 A 指标 | CI + 周报 | 任一硬指标退化超阈值 → 阻止合并 |

### 8.5 与 §2 的衔接

```
  §2（S0–S4）：把契约立起来        §7（D1–D3）：同时干更多事     §8（E1–E3）：越干越对
  ────────────────────────       ───────────────────────       ───────────────────
  有效、可审计、可回滚              并发不打架、冲突可解释          规则越用越准、错误不重犯
        │                                │                              │
        └──────────── 共同稀缺资源：人的注意力（附录 A）──────────────┘
```

**施工顺序不是"并发、进化、契约"三选一，而是**：

> **S0 / S1（契约）→ E1（错误先固化）→ D1 / D2（再加并发）→ E2 / E3（再谈进化）。**

理由一句话：**没有回归集的并发，只是把错误放大 N 倍。**

---

# 附录 A · 注意力度量

## A.0 前提

superagent 也**没有**注意力度量——它靠**结构**省注意力（三值 purpose、progress 不外发、工单只有一个未答问题、面板只列待人）。**Legion 有数据、没有结构**；做法是把它的结构接到 Legion 的事件流上，让数字自己长出来。

## A.1 三个概念别混

| 概念 | 定义 | 成本特征 |
| --- | --- | --- |
| Push（打扰） | 主动推给人、要求响应 | 最高，立即感知 |
| Pull（可见） | 人去看才看到（看板/面板） | 低 |
| Rework（返工） | 做错了，验收/合并时才发现 | **最高且不可感知** |

## A.2 单位：一条消息 = 一次决策请求

```jsonc
{ "id": "…", "at": "…", "taskId": "T-123", "space": "software", "recipients": ["general"],
  "purpose": "attention",   // attention | answer | result | progress  ← 抄 core/replies.ts:16
  "channel": "push",        // push | pull
  "requiredAction": true,
  "weight": 2 }             // 1=确认型 2=选择型 3=阻塞型
```

`purpose` 是**发送时校验点**：`progress` 不许进 push；`attention` 必须带问句。

## A.3 四个自动比率 + 一个人给的权重

| 指标 | 定义 | 为什么能自动 |
| --- | --- | --- |
| **A/I** 行动转化率 | attention 条数中**真引发对应动作**的比例 | "打扰是否值得"不需要打分：看它是否引发了它要的那个动作 |
| **D/I** 无效应答率 | 推送后 N 小时无行动且任务被换路/取消 | 只能自动检出，人记不住 |
| **R/(R+I)** 主动闭环率 | 全程无人介入完成的任务占比 | 从状态 + 台账推导 |
| **重问率** | 同一任务被问 ≥2 次的比例 | 结构上可压（一工单一个未答问题） |
| weight 1/2/3 | 确认型 / 选择型 / 阻塞型 | **只能人给** |

## A.4 两条硬判断

1. **绝不拿"消息总数"当 KPI**：单位是**决策轮次**，不是消息条数。
2. **一半指标必须测"没问导致的代价"**：只优化少打扰 → agent 攒着不问 → 成本转到返工。

| 优化 | 配对防线（不得恶化） |
| --- | --- |
| 降 I | 返工率 / 事后追认率 |
| 降 D | 被驳回的决策数 |
| 提 A/I | 平均处理时长 |

## A.5 阈值

| 指标 | 起步线 |
| --- | --- |
| A/I | ≥ 0.7 |
| D/I | ≤ 0.15 |
| 重问率 | ≤ 10% |
| push 占比 | ≤ 20% |
| 主动闭环率 | 只看周环比 |

## A.6 SQL 口径（示意）

```sql
-- I
SELECT space, COUNT(*) AS i FROM attention_event
WHERE purpose='attention' AND at >= :week_start GROUP BY space;

-- A（同 attention 引发过动作）
SELECT ae.space, COUNT(*) AS a FROM attention_event ae
JOIN decision d ON d.attention_id = ae.id AND d.kind IN ('accept','stop','answer')
WHERE ae.purpose='attention' AND ae.at >= :week_start GROUP BY ae.space;

-- D（超时未答且任务被换路）
SELECT ae.space, COUNT(*) AS d FROM attention_event ae
WHERE ae.purpose='attention' AND ae.at >= :week_start
  AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.attention_id = ae.id)
  AND EXISTS (SELECT 1 FROM audit a WHERE a.taskId = ae.taskId
              AND a.action IN ('rework','cancel','reopen') AND a.ts > ae.at)
GROUP BY ae.space;
```

## A.7 周报字段

| 字段 | 用途 |
| --- | --- |
| I / A / D / 重问数（按空间、按 stage） | 找最费人的环节 |
| push 占比 | 是否退化成推送机器 |
| 主动闭环率周环比 | 唯一衡量"是否越来越少用人管" |
| D/I 最高的 3 个 stage | **指向该重写的 stage prompt** |
| weight=3 占比最高的 3 类任务 | **指向验收标准没写清的地方** |

**周报评价的不是 agent，是我们的规则与提示词。**

## A.8 边界

测得出"打扰值不值"，测不出"该不该由 agent 做"——后者只能靠 `observe` 两周的 `wouldAccept` + 人的判断。**度量替代不了判断，只让判断有据可依。**

---

# 附录 B · 概念速查

| 英文 | 中文 | 一句话 | Legion 处置 |
| --- | --- | --- | --- |
| Source | 来源 | 事件流 + 读位 | 不做外部；**状态控制 + 事件记账**（§2.1） |
| Trigger | 触发 | 不可变事件 + actor | 接线（audit 加三字段） |
| Input | 输入 | 交付给工单的上下文（**事件，非状态**） | 评论迁出状态列（S0） |
| Thread | 线程 | 同话题，单决策在飞 | 已有（conversation） |
| Policy | 策略 | 规则 + 名单 + 准入表，版本化 | 新建（轻） |
| Gate | 准入 | 确定性判定 | 抄写法换对象 |
| Assessment | 研判 | 逐条规则判一次 | 补规则集 |
| Decision | 决定 | accept/stop/ignore/unavailable | 新建台账 |
| Mandate | 授权 | 不可变"凭什么" | **新建** |
| Ticket | 工单 | 授权的工作单元 | 复用（更强） |
| Assignment | 派工 | 工单↔执行器绑定 | 不动（更强） |
| Report | 报告 | 六态 | 扩到四态 |
| Attention | 待人工决定 | 结构化问句 | **接线**（表已有） |
| Subscription | 订阅 | 续跑不扩权 | 扩语义 |
| Channel | 渠道 | 回话写地址 | 不做（留 purpose 纪律） |
| Disposition | 去向 | 记录"没做" | 并入 decisions |
| Strength / accept mode | 强度 / 受理档位 | explicit·inferred / off·observe·auto | 两个枚举 |
| Correlation | 关联 | 只给上下文，不路由 | 不做 |

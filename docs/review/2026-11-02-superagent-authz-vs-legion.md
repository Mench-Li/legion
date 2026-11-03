# dsh-superagent 授权模型 × Legion 现有流程：对照分析

日期：2026-11-02
对象：`deepseek-ai/dsh-superagent-prototype`（HEAD `6337fc8`，docs/000–008）vs 本仓 Legion（`COMMAND.md`、`team-hub`、`scrum`、`docs/design/`）
读法：**[实证]** = 读过代码/文档并给出 file:line；**[推断]** = 由相邻证据推出，未逐行核对；**[待核]** = 需要一次验证才能定论。

---

## 0. 结论

**概念套得上，插件装不得。**

- **能套**：superagent 的 `Trigger → Eval(gate + assessment) → Ticket + Mandate → Assignment` 这条链，与 Legion 的 `目标/需求 → 批准 → 任务卡 + 认领 → attempt` 几乎同构，可以逐项映射（§2）。
- **正好补上** Legion 自己在设计稿里承认的三处缺口：确定性准入 Gate、needs-input 的一等状态、决策入审计（§3）。
- **不能装**：superagent 的 Source 是 GitHub/Feishu 事件流、Executor 是"一工单一 session + worktree"，而 Legion 的执行面（run-store / attempt / 租约 / 文件域 / 预算账本）已经比它复杂一个量级，装进来等于**两套调度状态源并存**，而这正是 Legion 设计稿明令避免的事（`docs/design/legion-agent-orchestration-design.md:49`：「不应再增加相互竞争的调度状态源」）。
- **该借的只有一层：授权数据面**（§5）。成本 1–2 天，纯增量，不动执行面。

一句话取舍：**借它的"凭什么开工"，别借它的"怎么干活"。**

---

## 1. 两侧的最小事实

### 1.1 superagent 的核心主张 [实证]

| 主张 | 出处 |
| --- | --- |
| 只有 Eval 能创建工单；工单携带 Mandate（策略版本 + 范围 + 强度 + 命中规则 + 请求者身份 + 来源接收方式），**不可变**；只有"人喊停"能撤回、只有策略不再支持才吊销；结束不等于撤销 | `docs/001-domain.md:34-35` |
| Eval 分两层：**gate 是确定性代码**（谁可发起、什么强度），**assessment 是模型判断** | `docs/001-domain.md:90-91`、`docs/002-authorization.md:11-16` |
| 强度分 `explicit` / `inferred`；accept mode `off` / `observe`（只记录"本会接受"）/ `auto` | `docs/002-authorization.md:46-53`、`94-101` |
| 准入表：按"接收范围 × 是否在名单 × 是否 @ 智能体"三格决策，默认值偏保守 | `docs/002-authorization.md:56-75` |
| 策略变更**不撤销**在途工单，只投递一条变更说明；被吊销只发生在恢复前的再校验 | `docs/001-domain.md:32`、`docs/002-authorization.md:107-119`、`131-141` |
| 工单状态由"它在等什么"推出（person/delivery、person/answer、person/review、blocked|failed、queued、idle、working），**第一次匹配即胜** | `docs/003-execution.md:5-19` |
| 订阅（Subscription）：订阅线程的消息**无需重新授权**即可续跑，但不扩大权限 | `docs/001-domain.md:37`、`docs/002-authorization.md:18-26` |

### 1.2 Legion 现状 [实证]

| 现有物 | 出处 | 性质 |
| --- | --- | --- |
| 任务状态机 + 认领资格 `TASK_GATES`（`status='todo'` + `hold=0`），两条认领 SQL **共用一份** gate，且有 `holds()` 纯函数镜像供 dry-run | `team-hub/claim-policy.mjs:52-104` | **已经是确定性 gate**（但管的是"能不能认领"，不是"能不能开工"） |
| 认领策略版本 `legion/claim-policy@1` | `team-hub/claim-policy.mjs:36` | 版本化概念**已有雏形** |
| 写意图 / 预约 / 租约 epoch / `confirm-stopped` 人工对账 | `team-hub/routes/write-intent.mjs`、`claim-reservation.e2e.test.mjs` | 比 superagent 的 worker slot 强得多 |
| 操作级权限内核：`/api/permissions/{check,inbox,decide,rules}`，allow/ask/deny、审批箱、一次性 requestId、硬底线拒绝 | `docs/F02-PERMISSION-GOVERNANCE.md:1-13`、`team-hub/routes/permissions.mjs` | **管"能不能做这个动作"**，不管"这活该不该开" |
| 分层规范：`LEGION.md`/`AGENTS.md`/`agent.md`（仓层）> team-hub `rules` 表（全局层） | `LEGION.md:56-59`、`team-hub/routes/rules.mjs` | 是**行为规范**，不是准入名单 |
| 将军/士兵、8 阶段流水线、文件域并行、worktree 隔离、独立验证 | `COMMAND.md`、`roles.json`、`LEGION.md:6-27`、`46-48` | 执行面与协作面都很成熟 |
| 设计稿自述缺口：独立 Gate 只到"部分"、needs-input 无独立状态、gate/确认停止不入审计 | `docs/design/legion-agent-orchestration-design.md:27,33,30`（基线表 #10、#16、#13） | Legion **自己**已经点名 |

---

## 2. 概念映射

| superagent | Legion 对应物 | 判定 |
| --- | --- | --- |
| Source（事件流 + 读位 + 自身身份） | 用户对话 / 指挥台 / 看板拖拽 / 自动化触发器 | **形态不同**：Legion 的输入是人，没有"读位 + 重放"问题 |
| Trigger（不可变事件 + actor） | 任务卡创建、评论、状态迁移事件 | 有事件，但**没有"谁发起"的一等字段** |
| Thread（同一话题的触发序列） | 任务卡 / 目标 G-* / 会话 | 近似，但 Legion 的"多工单共享一线程"不成立（一卡一活） |
| Eval · Gate（确定性准入） | **缺失**（等价物是 `claim-policy` 的 TASK_GATES，管的却是认领） | **最大缺口** |
| Eval · Assessment（模型研判） | 将军选任务、`roles.json` 阶段 prompt、reviewer 判定 | Legion 已有，且更结构化（8 阶段） |
| Policy（版本化规则 + 名单 + 准入表） | `rules` 表（分层文本）+ `permissions` 规则（动作级）+ `CLAIM_POLICY_VERSION` | 三者各管一段，**没有一份"谁能让我开工"的策略** |
| Mandate（授权） | `tasks` 行的 `hold`、`by` 审计、`approved` 动作 | **只有"谁按的按钮"，没有"凭什么、多大范围、依据哪版策略"** |
| Ticket（授权工作单元） | 任务卡（含 fileDomain / 验收标准） | 同构，且 Legion 的范围约束更硬（fileDomain ⊆ 强制） |
| Assignment（工单↔执行器绑定） | attempt（attemptId + epoch + 租约 + 退避 + 终态） | **Legion 明显更强** |
| Subscription（订阅线程，续跑不需再授权） | 任务评论 → 执行者？ | **[待核]**：评论是否自动回流到在跑的 worker；若否，可借这条规则 |
| Channel（写回） | 看板评论 / mesh / 报告 / 交付 | Legion 更分散，但没有"渠道失效即丢弃"的账 |
| Strength（explicit/inferred） | 无 | **缺口** |
| accept mode（off/observe/auto） | 无（将军批准即执行） | **缺口**：Legion 缺"影子受理"这一档 |
| Attention（结构化待答） | `blocked` + ❓ 评论 | 设计稿 #16 自认可升级为独立状态/事件 |
| Decision 记录（accept/stop/ignore/unavailable） | 状态迁移 + comment + audit | "忽略/未完成"**不入账**，正是 #13 的痛点 |

---

## 3. 三处"正好补上"（按 Legion 自己的缺口表）

1. **确定性准入 Gate（设计稿 #10「独立 Gate」：部分）**
   Legion 现在"这条活该不该开"由**将军这个模型**判断；`claim-policy` 的 gate 只管"能不能被领走"。superagent 的办法是把"谁能发起 + 什么强度"做成**固定代码 + 一张准入表**，模型只做"值不值得做"的研判。这正好是 #10 缺的那一半，而且**不需要改执行面**。
2. **needs-input 一等化（设计稿 #16：部分）**
   superagent 把"在等人"拆成三档（输入没送达 / 等人答 / 等评审），并由**最近一条 Report + 是否有新消息**推导，而不是靠人读评论。Legion 的 `blocked + ❓` 可以按这三档细分，`docs/003-execution.md:5-19` 的判定顺序表可以直接照抄成状态推导函数。
3. **决策入审计（设计稿 #13：部分）**
   superagent 的 `Decision`（accept / stop / ignore / unavailable，含 `ignoredFromCard`、`would accept`）是**记录"没做什么"**的账。Legion 的 audit 现在记"做了什么"，缺"为什么没做"——这正是噪声治理（少打扰）唯一的数据来源。

---

## 4. 三处 Legion 更强，**不要**退回去

| 维度 | Legion 现状 | 若照搬 superagent 会退化 |
| --- | --- | --- |
| 并发与冲突 | 文件域 write-intent（越界 422 `OUT_OF_FILE_DOMAIN`）+ 预约/epoch/`confirm-stopped` + 退避 | superagent 只有"一工单一个 worker 槽 + maxWorkers"，并发冲突全靠人 |
| 执行可观测 | attempt + provider Run ID + run-store + 事件补读（seq / Last-Event-ID） | superagent 的 Assignment 只有 pending/running/ended 三态 |
| 失败与预算 | 失败分类、退避、预算账本（reserve/observe/settle）、模型切换闸 | superagent 只有"连续失败三次才报系统问题" |

**推论**：任何把人往 superagent 形态搬的改动，都必须**保留 Legion 的 attempt/租约/文件域作为唯一执行真相**，只在其上加授权层。

---

## 5. 移植方案：只借数据面（建议分三步）

### 第一步（1–2 天，纯增量）：把 Mandate 落到任务卡

在 `tasks` 表加一列（JSON），写入时机 = 任务从 `backlog` 被 `approve` 的那一刻。**不改任何流转逻辑，只开始记账。**

```jsonc
// task.mandate —— 建议形态
{
  "schema": "legion/mandate@1",
  "policyVersion": "legion/policy@1",        // 由 rules 表 + 准入表算出，写入时冻结
  "strength": "explicit",                     // explicit | inferred
  "requestedBy": { "kind": "user", "id": "u-1" },   // user | general | soldier | automation
  "grantedBy": { "kind": "general", "id": "general" },
  "basis": [{ "ruleId": "R-2", "text": "…" }],// 命中的规则（可为空 = 人工特批）
  "scope": { "fileDomain": ["team-hub/routes/"], "stages": ["coder","reviewer"] },
  "grantedAt": "2026-11-02T09:00:00+08:00"
}
```

验收（沿用本仓风格）：`approve` 后 `GET /api/tasks/<id>` 能读到 mandate；缺字段时 approve 失败并给出 400；老任务回填 `null` 不报错；`fileDomain` 变更必须产生**新** mandate（对应 superagent「更宽的范围 = 新工单」`docs/001-domain.md:34`）。

### 第二步（3–5 天）：把"能不能开工"从模型判断变成确定性 gate

- 新增 `team-hub/mandate-policy.mjs`，照抄 `claim-policy.mjs` 的形态：`MANDATE_GATES`（一份 SQL + 一份 `holds()` 纯函数镜像 + `assertGatesShared()` 防绕过），并定义 `POLICY_VERSION`。
- 准入表按 Legion 的真实接收面写三格：
  | 接收范围 | 在名单且明确指向 | 在名单未指向 | 不在名单指向 |
  | --- | --- | --- | --- |
  | 用户对话/指挥台 | explicit | inferred | ignore（默认） |
  | 看板拖拽 | explicit | ignore | ignore |
  | 自动化/脚本创建 | ignore | inferred | ignore |
  | 士兵上报触发的新活 | ignore | inferred | ignore |
- **第一步的 gate 只做一件事**：`inferred` 一律拒绝开工（等价 superagent 默认 `observe`），只在看板上留一条 `wouldAccept` 记录。跑两周看记录，再决定放宽。

### 第三步（按需）：observe 记录 + 策略变更投递

- `wouldAccept` 行 = superagent 的 `observe` 模式，**先把"智能体本会自己开工的活"记账、但不真开工**。这是它整套哲学里对 Legion 最有价值的一条（`docs/002-authorization.md:98`、`docs/000-philosophy.md:28`「先窄，再放开」）。
- 策略变更时，给**在途任务**投一条 `policy-changed` 输入（说明哪条规则变了/请求者是否仍在名单/是否仍允许主动受理），**不撤销**任务（`docs/002-authorization.md:107-119`）。Legion 现在改 `rules` 表对在跑任务零影响，既没有惊喜也没有解释——补这条是把"规范中心"变成可追责的一步。

---

## 6. 明确**不要**照搬的四件

1. **Source / Channel 实现**：Legion 没有 GitHub 通知流，也没有"渠道失效即丢弃、丢弃必须留档"的需求；`lark-cli`/`gh` 的 wrapper + `#!/bin/sh` shim 这套在 Windows 上本来也跑不起来（见上一份可行性评估）。
2. **Eval 的 LLM 研判复刻**：Legion 的将军 + 8 阶段已经是更强的研判结构，再套一层"batch assessment"只会多一次模型调用与一个状态源。
3. **Ticket / Assignment 双状态机**：Legion 的 attempt 已覆盖且更强；引入双状态机会让"谁在跑"有两个答案。
4. **worker slot + 30 分钟后台规则**：与 Legion 的租约/TTL/续租语义冲突，混用会让"任务算不算在跑"出现第三种口径。

---

## 7. 风险与冲突点

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 第三套"策略"并存 | 已有 `rules`（规范）、`permissions`（动作）、`claim-policy`（认领），再加 `mandate-policy` = 四套 | mandate 只**读**前两者的结论，不新建编辑面；策略版本里显式记录引用了哪个 `rules` 版本 |
| 双写与竞态 | mandate 与 `hold`/`approve` 可能不同步 | mandate 写入与状态迁移放同一次事务；沿用已有 `--if-version` 乐观锁 |
| 审计膨胀 | 每条拒绝都入库会淹没时间线 | 只记 admit / wouldAccept / stop 三类；ignore 按天聚合（对应 superagent 的 `stats`/`dropped` 分账） |
| 误读为"沙箱" | superagent 明确写了 wrapper 不是安全边界（`docs/003-execution.md:80`） | mandate 只证明"授权来源"，动作仍需过 `permissions/check`，两层不要合并 |

---

## 8. 建议

**做第一步，立刻做第二步的"名单 + 默认拒绝"，其余等两周数据。**

1. 先只加 `mandate` 字段与 `wouldAccept` 记录（不动流转），成本 1–2 天，可随时回滚（字段可空）。
2. 同时把"谁能让我开工"写成一份**代码里的准入表**（第二张表就是答案），而不是继续靠将军的提示词。
3. `observe` 跑满两周，用 `wouldAccept` 的条数与误判率决定是否放开 `auto`——这正是 superagent `docs/000-philosophy.md:28` 的"先窄，再放开"，也是 Legion 目前**唯一**缺的信任建立机制。
4. 不搬插件、不搬执行面、不新建第二套调度状态源。

**一句话**：superagent 最值得偷的不是那个 agent，而是它**"授权是一份不可变记录、准入是确定性代码、忽略也要记账"**这三条纪律——正好是 Legion 设计稿里那三个"部分"。

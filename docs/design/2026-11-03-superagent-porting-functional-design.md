# superagent → Legion 移植：功能设计与实施计划

版本：v1.2 ｜ 日期：2026-11-03 ｜ 状态：**Q1–Q5 已决策，可进入 M0**
上游：[移植白皮书 v3.3](review/2026-11-02-superagent-porting-whitepaper.md)（§2 概念、§4 六步、§7/§8 阶段二）
本文定位：白皮书回答**"做什么、为什么"**；本文回答**"做成什么样"（功能设计）**与**"怎么做完"（实施计划）**。术语沿用白皮书附录 B。

> **v1.2 变更（决策定稿）**
> Q1–Q5 全部拍板，§7 由"未决问题"改为**决策记录（DEC-1 – DEC-5）**，并回写到设计：
> - **DEC-1** 授权绑状态迁移 → F4 接线点改 `transitionTask()`；新增 M0-4、A16、R13
> - **DEC-2** 守护不落盘 → 新增 `POST /api/tasks/:id/report`；§2.2 增第 4 条架构约束；R4 关闭、新增 R14
> - **DEC-3** 过渡期同步列 → F0 两段迁移（A/B）；新增 M1-5、A15、R15；R1 降级
> - **DEC-4** 迁移前归并 → 新增 M3-0 与 `merge-open-questions.mjs`
> - **DEC-5** 空间级 accept_mode → 落 `space_runtime`，预留 `goal_overrides`
> 工期修正：16.5 → **≈17.75 天**（上限 18.75，含条件项）。
>
> **v1.1 变更**
> 1. §7 未决问题扩写：每条给「为什么卡住设计 → 两种可能的现实 → 一次确认命令 → 推荐方案（含代价）→ Plan B → 影响模块」。
> 2. 新增 **§8 阶段二**：把白皮书 §7（并发治理 D1–D3）与 §8（自我进化 E1–E3）落成 **F6–F11 六个模块 + M7–M12 六个里程碑**（约 12.5 天），含 B1–B10 验收与 R8–R12 风险。

---

## 0. 三个前置结论（直接影响设计）

1. **不改状态机、不新增调度源**：本期全部是"加表 / 加列 / 加派生 / 接线"，`tasks.status` 与 `run_attempts` 仍是唯一执行真相。
2. **一切写入同事务**：状态写与事件追加必须在同一个 `withTx` 里（白皮书全局约束 7）。
3. **每个功能都有独立开关**：五个 flag 全关 = 今天的行为（白皮书 A9）。

---

## 1. 范围

### 1.1 本期（阶段一）

| 模块 | 白皮书步 | 一句话 |
| --- | --- | --- |
| **F0** `task_input` | S0 | 评论从 JSON 列迁到 append-only 行，成为唯一真相 |
| **F1** Report 四态 | S1a | 消灭"假完成 / 假受阻" |
| **F2** Attention 接线 | S1b | 结构化提问 → 有未答问题就不派工 |
| **F3** 输入语义 @ | S2 | 一条评论三种语义：追加 / 驳回 / 提问 |
| **F4** 受理台账 | S3 | 凭什么开工（mandate）+ 为什么没做（disposition） |
| **F5** 事件流与对账 | S4 | 状态变化事件化 + 定期对账 |

### 1.2 下期（阶段二，见 §8）

| 模块 | 白皮书 | 一句话 |
| --- | --- | --- |
| **F9** 错误归纳机械化 | E1 | 失败 → 聚类 → 回归用例草稿 |
| **F6** 目标级配额 | D1 | 大目标不能吃干槽位 |
| **F7** 抢占与人优先槽 | D2 | 人随时能插话，紧急活能让槽 |
| **F8** 并发可解释 | D3 | 排队任务一眼看出被谁挡住 |
| **F10** 规则候选影子验证 | E2 | 改规则前先看历史决策会不会翻转 |
| **F11** 不退化门 | E3 | 指标退化就不许合并 |

**顺序（不可换）**：F9 → F6 → F7 → F10 → F11（F8 可并行）。理由：**没有回归集的并发，只是把错误放大 N 倍。**
阶段二不新增任何状态源，全部建立在阶段一的数据面上（`decisions` / `audit` 事件 / 指标），故**必须在 M6 之后开始**。

### 1.3 明确不做

装 dsh-superagent 插件、外部 Source（GitHub/飞书）、webhook 入站、第二套状态机、新事件计数器、worker slot / 30 分钟规则、Correlation。

---

## 2. 总体架构

### 2.1 分层与数据流

```
  写入口（routes）                事务层                    真相                    派生 / 消费
  ─────────────────            ──────────────            ──────────────          ──────────────────
  POST /api/comment      ─┐
  POST /api/agent-messages┼──▶  withTx{                 ┌ task_input  ──投影──▶ comments 视图
  POST /api/comment(@)   ─┤      状态写 + 追加事件 }  ──┤
  士兵报告（守护）        ─┘                           └ audit(+4 列) ──▶ SSE / 周报 / 对账
                                                              │
                                                              ▼
                                              decisions（accept/ignore/wouldAccept）
                                                              │
  gate（纯函数 + SQL）  ◀─────────────────────────────────────┘
    ├ MANDATE_GATES（能否开工）
    └ TASK_GATES（能否被领走，+ no-open-question）
                                                              │
                                                              ▼
                                                      attempt / 租约 → 士兵
```

### 2.2 四条架构约束（评审时必须逐条确认）

| 约束 | 检查方式 |
| --- | --- |
| 状态写与事件追加同事务 | 守卫测试 `assertStateWriteInTx`：禁止对 `tasks` / `agent_questions` 的裸 `UPDATE` |
| 事件流不得触发派工 | 断言 `claim-policy` / `mandate-policy` 不读 `audit` |
| 派生状态不落列 | `awaiting_answer` / `stuck` 只由 `deriveStage()` 计算，不加列 |
| **跨进程写一律走 HTTP 边界（守护不落盘，DEC-2）** | 断言 `plugins/src` 不出现 `DatabaseSync` / `team.db` 直连；守护只调 `/api/*` |

### 2.3 给阶段二预留的数据接口

| 阶段二 | 需要的数据 | 本期是否已具备 |
| --- | --- | --- |
| E1 错误归纳 | `decisions` + `audit` 的 stage/rule/fileDomain 维度 | ✅ F4 |
| E2 影子验证 | `would_accept` + `policy_version` | ✅ F4 |
| D1 目标级配额 | `tasks.goalId` + `space_runtime.maxWorkers` | ✅ 已有 |
| D2 抢占 | `agent_commands`（stop/pause） | ✅ 已有 |
| D3 并发可解释 | `contention` 聚合 | ✅ 已有 |

**结论：阶段二的原料基本齐，本期不为其加任何表。**

---

## 3. 功能设计

> 每个模块固定七段：**目标 / 功能点 / 数据契约 / 接口契约 / 行为与不变量 / 接线点 / 观测与验收**，末尾给**回滚开关**。

### F0 · `task_input`（S0）

**目标**：评论成为有独立身份的 append-only 输入行，`tasks.comments` 降级为投影。

**功能点**
1. 新增输入行写入（取代"整列 read-modify-write"）。
2. 历史评论一次性迁移（可重跑、幂等）。
3. `tasks.comments` / `evidence` / `feedback` 由投影生成，读路径不变。
4. 输入可被标记 `consumed_at`（被某次执行消费）与 `superseded`（被新指令取代）。
5. 对账：投影 vs 行表差异可查。

**数据契约**

```sql
CREATE TABLE IF NOT EXISTS task_input (
  id             TEXT PRIMARY KEY,          -- sha1(task_id | channel | seq_or_time | by)
  task_id        TEXT NOT NULL,
  scope          TEXT NOT NULL,
  kind           TEXT NOT NULL,             -- comment | evidence | feedback | order | answer
  actor          TEXT NOT NULL,             -- 人的成员名 / soldier-* / system
  actor_kind     TEXT NOT NULL,             -- user | general | soldier | ci | system
  body           TEXT NOT NULL,
  meta           TEXT DEFAULT '{}',         -- { reply_to, addressed, mention_role }
  created_at     TEXT NOT NULL,
  consumed_at    TEXT,                      -- 被消费时间（F2/F3 用）
  consumed_by    TEXT,                      -- attempt id
  superseded     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_input_task ON task_input(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_input_idem ON task_input(id);
```

**接口契约**

| 方法 | 路径 | 变化 |
| --- | --- | --- |
| `POST` | `/api/comment` | **请求/响应完全不变**（`{id,text,kind?,isEvidence?}` → 任务对象），仅内部改存储 |
| `GET` | `/api/tasks/:id/inputs` | 新增只读：`{inputs:[{id,kind,actor,body,createdAt,consumedAt,superseded}], next?}` |
| `GET` | `/api/reconcile/inputs?scope=` | 新增只读：`{tasks: n, mismatched: [{taskId, projected, actual}]}` |

**行为与不变量**
- `I-0.1` 同一输入重复提交只产生一行（`id` 幂等，冲突返回既有行 + 200，不报错）。
- `I-0.2` 任何写 `tasks.comments` 的代码路径必须改走输入表（当前有**两处**：`appendTaskNote`、`reassignTask` 内联 push）。
- `I-0.3` `consumed_at` 单调递增，且只由执行器在"读到并进了本轮上下文"时写。
- `I-0.4` `superseded` 只由显式动作置位（F3 提问替换），不随消费自动置位。
- `I-0.5` 迁移脚本可重跑：以 `id` 幂等，二次运行不新增行。

**接线点**

| 位置 | 改动 |
| --- | --- |
| `team-hub/server.mjs:7511` `appendTaskNote` | 改为 `insertInput()` + **同事务同步列**（DEC-3） |
| `team-hub/server.mjs:7533` `reassignTask` | 内联 push 改为 `insertInput()`（消除第二写点） |
| `team-hub/routes/comment.mjs:69` | 无需改（仍是唯一 HTTP 入口） |
| 同步列 | `insertInput()` 内同事务追加 `tasks.comments`（过渡期 A 段，读路径零改动） |
| 投影 | 新增 `commentsOf(taskId, kind)`；**B 段**读取点收敛后再删同步写与列 |
| 迁移 | A 段 `migrate-task-input.mjs`（历史回填）；B 段 `drop-comments-column.mjs`（收敛后执行） |

**观测与验收**
- 指标：`input_rows_total`、`input_reconcile_mismatch`（必须 0）、`input_dup_blocked`。
- 验收：A11（并发两条都留痕、同评论幂等、投影一致）+ 迁移可重跑 + `POST /api/comment` 响应结构零变化。

**回滚开关**：`taskInput.enabled=false` → 写路径回到 `appendTaskNote` 原实现；表与投影保留（只读）。

---

### F1 · Report 四态（S1a）

**目标**：士兵能合法地说"这活不值得做"和"我在等外部条件"。

**功能点**
1. `WorkerReport.status` 扩为 `done | waiting | blocked | dropped`。
2. `waiting` 必须带结构化 `waitFor`；`dropped` 默认不发任何消息。
3. 看板与守护按四态映射；老报告（两态）继续可用。

**数据契约**

```sql
ALTER TABLE tasks ADD COLUMN report_state TEXT;   -- done|waiting|blocked|dropped（最近一次）
ALTER TABLE tasks ADD COLUMN wait_for    TEXT;    -- waiting 时必填，枚举化原因
```

`waitFor` 枚举（不是自由文本）：`external-review | upstream-merge | human-decision | ci-result | dependency`
—— `human-decision` 与 F2 的 attention 二选一，有 attention 时不填此值。

**接口契约**：无新 HTTP。报告走现有工具与守护解析，仅 JSON schema 扩字段：

```jsonc
{ "status": "waiting", "summary": "…", "evidence": "…", "wait_for": "ci-result" }
{ "status": "dropped", "summary": "需求已被 8f2a 覆盖，无需处理", "evidence": "…#8f2a", "blocker": "" }
```

**行为与不变量**
- `I-1.1` `waiting` 无 `wait_for` → 报告判不合法（走现有"报告不合法"重试路径），不落库。
- `I-1.2` `dropped` 不产生评论、不产生通知、不进时间线；但**必须**写一条 `audit(action='drop')`。
- `I-1.3` `dropped` 的任务终态为 `done`，并带 `no_action=true` 标记（看板显示"无需处理"）。
- `I-1.4` 两态老报告行为不变（`done`→`in_review`，`blocked`→`blocked`）。

**接线点**

| 位置 | 改动 |
| --- | --- |
| `plugins/src/index.ts:331-350` | `WorkerReport` 类型 + 四态 |
| `plugins/src/index.ts:380` 起 `WORKER_SCHEMA` | JSON schema 同步（加 `wait_for`、`status` enum） |
| `plugins/src/index.ts:2078-2194` | 提示词：四态各一条示例 + "不值得做就报 dropped" |
| 守护结算分支 | `dropped` 走"无消息、直接结束"；`waiting` 走 idle |

**观测与验收**
- 指标：`report_dropped_total`、`report_waiting_total`、`waiting_age_p50/p95`。
- 验收：四态各一条用例；`dropped` 零副作用（无评论/无 SSE 事件/无 mesh 消息）；`waiting` 缺字段拒收。

**回滚**：`report.fourStates=false` → 两态枚举（新值落库前先校验，关闭后旧值视为 `done`）。

---

### F2 · Attention 接线 + 派工闸（S1b）

**目标**：把"我需要人拍板"从 `❓` 文本变成 `agent_questions` 行，并让"有未答问题"真正阻止派工。

**功能点**
1. 报告可带 `question {body, options[]}` → 写 `agent_questions`。
2. 派工资格新增 `no-open-question` gate。
3. 回答走已有 `answer()`（`version` 乐观锁），答完任务回 `todo`。
4. 派生状态 `awaiting_answer` / `stuck`。

**数据契约**（**复用现有表，不加新表**）

```sql
-- 已存在：agent_questions(id, scope, agent_id, task_id, attempt_id, body,
--                        options_json, status, version, answer, answered_by, source_message_id)
-- 只加一条部分唯一索引，保证"一个任务同时最多一个未答问题"：
CREATE UNIQUE INDEX IF NOT EXISTS ux_question_open
  ON agent_questions(task_id) WHERE status = 'open';
```

**接口契约**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/agent-messages` | **已有**：带 `intent:'answer'` + `questionId` 即回答（复用 `answer()`） |
| `POST` | `/api/tasks/:id/report` | **新增（DEC-2）**：守护回报唯一写口。一个事务内写 `tasks.report_state` + `agent_questions(open)` + `audit` 事件，返回 `{task, question?, auditSeq}`；按 `reportId` 幂等 |
| `GET` | `/api/tasks/:id` | 响应新增派生字段 `stage`（`awaiting_answer` / `stuck` / 既有值） |

**错误码**

| 码 | 场景 | HTTP |
| --- | --- | --- |
| `ATTENTION_ALREADY_OPEN` | 同一任务已有 open 问题 | 409 |
| `QUESTION_VERSION_MISMATCH` | 回答时 `version` 落后 | 409 |
| `QUESTION_NOT_FOUND` | `questionId` 不存在或不属于该任务 | 404 |

**行为与不变量**
- `I-2.1` 一个任务同时最多一个 `status='open'` 的问题（DB 部分唯一索引兜底）。
- `I-2.2` 有 open 问题的任务**不进**候选 SQL（gate 层拦截，不是守护层判断）。
- `I-2.3` 回答后：`status='answered'`、`answer`、`answered_by`、`version+1`、任务回 `todo`、写一条 `audit(action='answer')`。
- `I-2.4` 新问题覆盖旧问题时：旧问题置 `superseded`（不删），并撤回未发出的回复。
- `I-2.5` `❓` 文本约定保留一个版本：读路径双向兼容，写路径只写结构化。

**接线点**

| 位置 | 改动 |
| --- | --- |
| `plugins/src/index.ts` `blocked` 分支（`:3422` 一带） | **改为调用 `POST /api/tasks/:id/report`**（DEC-2），不再直连写库；`❓` 文本不再拼 |
| `team-hub/claim-policy.mjs:64-104` | `TASK_GATES` 增 `no-open-question`（SQL + `holds()` 镜像 + `assertTaskGatesShared()`） |
| `agent-conversations.mjs:206-209` | 复用 `answer()`，不改 |
| 派生 | 新增 `deriveStage(task)` 纯函数（`team-hub/` 或 `packages/shared`） |
| 迁移（M3-0，DEC-4） | `scripts/merge-open-questions.mjs`：查重 → 归并 → 审计 → 再建部分唯一索引 |

**观测与验收**
- 指标：`attention_open_total`、`attention_age_p95`、`attention_answered_ratio`、`dispatch_blocked_by_question`。
- 验收：A3（有未答问题不派工）、A4（版本冲突 409）、唯一索引挡双开、回答后自动续跑。

**回滚**：`attention.enabled=false` → 守护回到 `❓` 文本路径；索引可保留（不影响旧逻辑）。

---

### F3 · 输入语义 @（S2）

**目标**：一条评论按"是否 @、@ 谁"分流成三种语义，且**不越授权**。

**功能点**
1. 解析 `@<role>`（边界正则）。
2. 分流：追加（order）/ 升级为提问（@general）/ 驳回（无 @，现状）。
3. 四条护栏：scope 成员、状态白名单、自 @ 忽略、只认新增评论。
4. 超 `fileDomain` 的追加被拒绝并要求新任务。

**数据契约**：复用 F0 的 `task_input`（`kind='order'`）+ `meta.mention_role`。不建新表。

**接口契约**：`POST /api/comment` 请求体不变；响应新增 `input: {id, kind, addressed_to, effect}`（附加字段，不破坏现有消费方）。

**行为与不变量**
- `I-3.1` `@` 只把强度提到 `explicit`，**不能**绕过 `MANDATE_GATES`（F4）。
- `I-3.2` 只在 `status ∈ {in_progress, awaiting_answer}` 生效；其它状态只写输入，不投递。
- `I-3.3` 评论者 == 当前 `soldier` → 视为普通评论（自 @ 忽略）。
- `I-3.4` 只认新增评论；`PATCH`/编辑不产生输入（编辑只更新 `body` 与一条 `audit`）。
- `I-3.5` 追加的期望路径与 `mandate.scope.fileDomain` 求交；空交 → 422 `OUT_OF_MANDATE`。

**接线点**

| 位置 | 改动 |
| --- | --- |
| F0 的 `insertInput()` | 写入前做 mention 解析与分流（单点，不在路由层散落） |
| `agent-messages` 投递 | 复用现有通道，不新建 |
| 守护 `in_progress` 的"他人评论 → 退回"判定（`index.ts:10-11`） | 分流：**无 @ → 退回（不变）；有 @ → 追加续跑** |

**观测与验收**
- 指标：`mention_order_total`、`mention_escalate_total`、`mention_ignored_self`、`mention_out_of_mandate`。
- 验收：A5（只投 scope 成员、只在可续跑状态生效）+ 自 @ 忽略 + 幂等 + 超域拒绝。

**回滚**：`mention.enabled=false` → 一律走"无 @"分支（即今天的行为）。

---

### F4 · 受理台账（S3）

**目标**：任何任务都答得出"凭什么开工"，任何候选都答得出"为什么没做"。

**功能点**
1. `policy_rules`（规则集，从 `rules` 人工转写 3–5 条）。
2. `decisions`（accept / stop / ignore / unavailable + `would_accept`）。
3. `tasks.mandate`（不可变授权记录，版本链）。
4. `strength` + `accept_mode` 两个枚举。
5. `MANDATE_GATES` 确定性准入 + 准入表四行。

**数据契约**

```sql
CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,          -- always | when | never
  text TEXT NOT NULL, scope TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  rule_ref TEXT                                    -- 引用 rules 表的 id，不复制正文
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL,       -- task:<id> | goal:<id>
  thread_id TEXT, trigger_id TEXT,                  -- trigger_id → audit.event_id（F5）
  kind TEXT NOT NULL,                               -- accept|stop|ignore|unavailable
  matched_rule_ids TEXT DEFAULT '[]',
  would_accept INTEGER NOT NULL DEFAULT 0,
  reason TEXT, by TEXT NOT NULL, at TEXT NOT NULL,
  policy_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dec_kind ON decisions(kind, at);

ALTER TABLE tasks ADD COLUMN mandate JSON;          -- 见下
ALTER TABLE tasks ADD COLUMN accept_mode TEXT;      -- 冗余快照，便于审计（真值在 settings）
```

```jsonc
// tasks.mandate（不可变；变宽 = 新版本）
{ "schema":"legion/mandate@1", "version":1, "policyVersion":"legion/policy@1",
  "strength":"explicit", "requestedBy":{"kind":"user","id":"u-1"},
  "grantedBy":{"kind":"general","id":"general"},
  "basisRuleIds":["R-2"], "manual":false,
  "scope":{"fileDomain":["team-hub/routes/"],"stages":["coder","reviewer"]},
  "grantedAt":"…", "supersedes":null }
```

**接口契约**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/decisions?kind=&wouldAccept=&scope=&from=&to=` | 新增只读，带分页 |
| `GET` | `/api/tasks/:id/mandate?all=1` | 新增只读，返回版本链 |
| `POST` | `/api/policy-rules` / `GET` | 规则集维护（沿用 `handleWrite`：`by` 必填 + audit + SSE） |
| `POST` | `/api/tasks/:id/accept` | 或改造现有 approve 路径（M0 spike 确认） |

**错误码**：`422 MISSING_BASIS`（既无 `basisRuleIds` 又非 `manual`）、`409 STALE_REVISION`、`422 OUT_OF_MANDATE`。

**行为与不变量**
- `I-4.1` 任何 `accept` 决策必须有 `basisRuleIds` 或 `manual:true`。
- `I-4.2` `mandate` 只追加：变宽 `fileDomain` → 新版本，旧版本保留可读。
- `I-4.3` `hold` 是调度拦截，`revoke` 是授权撤回——**两者不共用字段**。
- `I-4.4` 规则变更只写一条 `policy_changed` 事件 + 给在途任务投说明，**不撤销**。
- `I-4.5` `inferred + accept_mode≠auto` → 只写 `would_accept=1` 的 ignore 行，不入队。

**接线点**

| 位置 | 改动 |
| --- | --- |
| **`transitionTask()`**（状态迁移函数，DEC-1） | `→ todo` 时校验 `basisRuleIds`/`manual` 并写 mandate + decision；**不在路由层写** |
| 新增 `team-hub/mandate-policy.mjs` | `MANDATE_GATES` + `holds()` + `assertGatesShared()`（照抄 `claim-policy.mjs` 形态） |
| `routes/rules.mjs` | 变更时递增 `POLICY_VERSION` + 写 `policy_changed` 事件 |
| `space_runtime`（DEC-5） | 加 `accept_mode`（空间级真值）+ `goal_overrides`（预留，不实现） |
| 读取 | `mandate.strength` 判定读任务所在空间的 `accept_mode` |

**观测与验收**
- 指标：`would_accept_total`（按天）、`mandate_missing_ratio`（必须 0）、`decision_kind_distribution`。
- 验收：A6（每任务可反查 decision + mandate）、A7（`wouldAccept` 可查）、A8（规则变更不撤销在途）。

**回滚**：`mandate.enabled=false` → 不写 mandate/decision（表留着）；`accept_mode` 固定视为 `explicit-only`。

---

### F5 · 事件流与对账（S4）

**目标**：状态变化可被事件流回答"为什么"，并支持定期对账。

**功能点**
1. `audit` 加四列（`actor_kind` / `addressed` / `human` / `event_id`）。
2. `event_cursor`（消费者读位）。
3. `tasks.watches`（订阅对象）。
4. `evaluate(event)` 纯函数 → 写 `decisions`。
5. **对账任务**：事件重放 vs 状态表。

**数据契约**

```sql
ALTER TABLE audit ADD COLUMN actor_kind TEXT;   -- user|general|soldier|ci|bot|system
ALTER TABLE audit ADD COLUMN addressed  TEXT;   -- mention|direct|none
ALTER TABLE audit ADD COLUMN human      INTEGER;-- 0/1，决定能否授权
ALTER TABLE audit ADD COLUMN event_id   TEXT;   -- hash(kind, subject, version)，幂等
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_event ON audit(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_cursor (
  consumer TEXT PRIMARY KEY, seq INTEGER NOT NULL, updated_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN watches JSON DEFAULT '[]';   -- [{kind, subjectId}]
```

**接口契约**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/events?since=` | 已有（SSE / 增量），不变 |
| `GET` | `/api/reconcile?scope=&untilSeq=` | 新增只读：`{expected:{taskId:status}, actual:{…}, mismatched:[…]}` |

**行为与不变量**
- `I-5.1` 事件只由业务写点产生（不用触发器），且与状态写入同事务。
- `I-5.2` 事件消费方**不得触发派工**；只写 `decisions` 与报表。
- `I-5.3` `event_cursor.seq` 单调；重启后从 cursor 续读，不重放。
- `I-5.4` 同一 `event_id` 重复写入 → 冲突忽略（不报错、不重编号）。
- `I-5.5` 对账差异 > 0 → 报警，且只读（不自动修复）。

**接线点**

| 位置 | 改动 |
| --- | --- |
| `server.mjs` 的 `audit()` 辅助 | 派生 `event_id`；调用方传 `actor_kind` / `addressed` |
| 四类事件生产点 | 评论、验证回执、交付回执、目标状态——**全部在 team-hub 侧**（DEC-2：守护不写事件） |
| 新增 `team-hub/scripts/reconcile-events.mjs` | 对账 CLI（可被守护/CI 调用） |

**观测与验收**
- 指标：`reconcile_mismatch`（必须 0）、`event_backlog`、`cursor_lag_sec`。
- 验收：A12（对账 0 差异）、A13（gate 不读 audit 的断言）、A1（幂等）。

**回滚**：`events.enabled=false` → 只写不读（连 `evaluate` 都不跑），行为回到今天。

---

## 4. 横切设计

### 4.1 Feature flag（五个，默认全关）

| flag | 默认 | 打开后影响 | 关闭后行为 |
| --- | --- | --- | --- |
| `taskInput.enabled` | false | F0：评论走输入表 + 投影 | 回 `appendTaskNote` |
| `report.fourStates` | false | F1：四态报告 | 两态 |
| `attention.enabled` | false | F2：结构化提问 + 派工闸 | `❓` 文本 |
| `mention.enabled` | false | F3：@ 三种语义 | 一律"驳回" |
| `events.enabled` | false | F5：事件消费 + 对账 | 只写不读 |

**规则**：flag 存 `space_runtime` 或全局 settings；**改 flag 必须留 `audit`**；任何 flag 关闭后不得残留副作用（表可留、写可停）。

### 4.2 错误码（新增）

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `ATTENTION_ALREADY_OPEN` | 409 | 已有未答问题 |
| `QUESTION_VERSION_MISMATCH` | 409 | 回答版本落后 |
| `MISSING_BASIS` | 422 | 无依据且非人工特批 |
| `OUT_OF_MANDATE` | 422 | 超出授权文件域 |
| `PROJECTION_STALE` | 409 | 投影与行表不一致（写时检测） |

### 4.3 事务与并发纪律（加守卫测试）

```
assertStateWriteInTx()      禁止对 tasks / agent_questions 的裸 UPDATE
assertGateReadsStateOnly()  claim-policy / mandate-policy 不得 import audit 读接口
assertIdempotent(inputId)   同 id 两次插入 → 第二次返回既有行
```

### 4.4 迁移策略

| 迁移 | 幂等键 | 可重跑 | 回滚方式 |
| --- | --- | --- | --- |
| F0 历史评论 → `task_input` | `id = sha1(task|idx|at|by)` | ✅ | 停写即可（表留着） |
| F4 `mandate` 回填 | 老任务置 `null` | ✅ | 不需要回滚 |
| F5 `audit` 四列回填 | 按 `action` 推断 `actor_kind` | ✅ | 列可空 |

**统一要求**：迁移脚本只做 `INSERT`/`ALTER`，不做 `DELETE`；每个脚本带 `--dry-run`。

### 4.5 观测（周报字段，接白皮书附录 A）

`input_reconcile_mismatch` / `attention_open_total` / `attention_age_p95` / `would_accept_total` / `decision_kind_distribution` / `reconcile_mismatch` —— 这六个数就是"这套机制是否在工作"的唯一证据。

---

## 5. 实施计划

### 5.1 里程碑

```
 M0 基线&探针   M1 F0       M2 F1     M3 F2        M4 F3      M5 F4        M6 F5+对账
   1 天         1 天        1 天      1.75 天      3 天       4 天         6 天
   ───┬───      ───┬───   ───┬───   ────┬────   ───┬───   ────┬────   ────┬────
      │            │          │           │          │          │           │
   DEC-1/DEC-2 确认    A11        A2          A3/A4      A5        A6/A7/A8    A1/A12/A13
```

| 里程碑 | 内容 | 工期 | 依赖 |
| --- | --- | --- | --- |
| **M0** | 基线 + 跑通现有测试 + **Q1/Q2 一次性确认** + 迁移函数收敛评估 + 写点地图 | 1 天 | — |
| **M1** | F0 `task_input` + 同步列（DEC-3）+ A/B 两段迁移 + 对账接口 | 1 天 | M0 |
| **M2** | F1 四态报告 | 1 天 | — |
| **M3** | F2 attention 接线 + 派工闸（含 **M3-0 归并**，DEC-4） | 1.75 天 | M1、M2 |
| **M4** | F3 @ 三种语义 | 3 天 | M1、M3 |
| **M5** | F4 规则集 + 台账 + mandate（DEC-1）+ 两旋钮（DEC-5） | 4 天 | M0 |
| **M6** | F5 事件流 + 对账 + 周报 | 6 天 | M1、M5 |

**合计 ≈ 17.75 天**（DEC-3 +0.5、DEC-4 +0.25）→ 条件项：DEC-2 已由 M0 消除；**DEC-1 仍待排 0.5–1 天（M5 前）→ 上限约 18.75 天**。

**M0 实测结论（2026-11-03）**

| 项 | 结论 | 依据 |
| --- | --- | --- |
| DEC-2 | ✅ **已满足**：守护不直连 DB，全部走 `fetch(hubUrl() + '/api/…')` | `plugins/src/*.ts` 对 `DatabaseSync` / `node:sqlite` / `dbPath` grep **0 命中** |
| DEC-1 | ⚠️ **命中"多处"**：写 `status='todo'` 的点分布在 `server.mjs`、`scrum/taskctl.mjs`、`routes/exec.mjs`、`routes/space-operations.mjs` | 需在 M5 前收敛到 `transitionTask()`，条件任务 **0.5–1 天，尚未开始** |
| DEC-3 | 读 `tasks.comments` 的位置 **65 处**（team-hub / scrum / workbench） | 同步列策略成立，A 段必须先落地 |

**可并行的两段**：M2 与 M1 可并行；M5 可与 M3/M4 并行（不同文件域：`policy/decisions` vs `input/attention`），但需同一个 `withTx` 约定先合并。

### 5.2 WBS

| ID | 任务 | 产出 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| M0-1 | 跑基线：`team-hub` + `plugins` 全量测试留档 | 基线日志 | 全绿或已知失败清单 | — |
| M0-2 | 定位 approve / claim / 报告三条路径的真实文件与函数 | 一张"写点地图" | 与本文 §3 接线点一致或更新本文 | — |
| M0-3 | 确认投影替换面（谁在读 `tasks.comments`） | 读取点清单 | 覆盖 render/serve/UI | — |
| M0-4 | **Q1 确认**：`status='todo'` 写入点计数；若 > 1 则合并成 `transitionTask()` | 写点地图 | 授权有唯一写点 | — |
| M0-5 | **Q2 确认**：守护是否直连 `team.db`；若直连则改造为调 HTTP | 结论 +（条件）改造方案 | 守护无 DB 直连 | — |
| M1-1 | `task_input` DDL + `insertInput()`（含同事务同步列，DEC-3） | 迁移脚本 + 单测 | 幂等插入 + 列一致 | M0-3 |
| M1-2 | `appendTaskNote` / `reassignTask` 改走输入表 | 两处补丁 | I-0.2 消除双写点 | M1-1 |
| M1-3 | 投影 + 对账接口 | `commentsOf()` + `/api/reconcile/inputs`（比列 vs 行表） | 差异 0 | M1-2 |
| M1-4 | A 段历史迁移 + dry-run | `migrate-task-input.mjs` | 可重跑、不重复 | M1-1 |
| M1-5 | B 段（读取点收敛后）删列 | `drop-comments-column.mjs` | 读取全走投影 | M1-3、全部读取点改完 |
| M3-0 | **归并双开问题 + dry-run**（DEC-4） | `merge-open-questions.mjs` | 索引可建 | M1 |
| M3-1 | `question` 字段 + 守护改调 `POST /api/tasks/:id/report` | 守护补丁 + 新接口 | 单开约束 + 幂等 | M1-1、M2-1 |
| M2-1 | 四态类型 + schema | 类型/ schema 补丁 | 四态用例 | — |
| M2-2 | 守护分支 + 提示词 | 分支与示例 | `dropped` 零副作用 | M2-1 |
| M3-1 | `question` 字段 + 写 `agent_questions` | 守护补丁 | 单开约束 | M1-1、M2-1 |
| M3-2 | `no-open-question` gate | `claim-policy` 补丁 | gate 单测 + 防绕过 | M3-1 |
| M3-3 | 回答闭环 + `deriveStage()` | 派生函数 + 接口 | A4 版本冲突 409 | M3-1 |
| M4-1 | mention 解析（边界正则） | 解析函数 + 单测 | 误判用例（`a@b.c`、`@x-y`） | M1-1 |
| M4-2 | 三路分流 + 四护栏 | `insertInput` 扩展 | A5 | M4-1、M3-3 |
| M4-3 | 超域拒绝 + 提示 | 错误码 `OUT_OF_MANDATE` | 拒绝用例 | M4-2、M5-2 |
| M5-1 | `policy_rules` + `decisions` DDL | 表 + 迁移 | 可空回填 | M0-1 |
| M5-2 | `mandate` 写入 + 版本链 | approve 补丁 | A6 | M5-1 |
| M5-3 | `MANDATE_GATES` + 准入表四行 | `mandate-policy.mjs` | 四行×三格单测 | M5-1 |
| M5-4 | `accept_mode` + `strength` | 两枚举 + settings | observe 不入队 | M5-3 |
| M6-1 | `audit` 四列 + `event_id` | 迁移 + `audit()` 补丁 | 幂等 | M1-1 |
| M6-2 | `event_cursor` + 消费循环 | 消费器 | 不重放 | M6-1 |
| M6-3 | 对账 CLI + 报警 | `reconcile-events.mjs` | A12 差异 0 | M6-2 |
| M6-4 | 周报字段 | 查询 + 报表 | 六个数可出 | M6-3、M5-1 |

### 5.3 每里程碑的 Go / No-Go

| 里程碑 | 过关条件 | 不过怎么办 |
| --- | --- | --- |
| M0 | 基线可复现；三个写点定位完成 | 不进入 M1，先补探针 |
| M1 | 迁移可重跑、差异 0、响应结构零变化 | 停写、保留表 |
| M2 | `dropped` 零副作用 | 回两态 |
| M3 | 有未答问题 100% 停派 | 只开 attention 不开 gate（半开） |
| M4 | 误判率 < 20% | 上显式前缀（`@role:`） |
| M5 | 每任务可反查 mandate；observe 一致率 ≥ 70% 才谈 auto | 继续 observe |
| M6 | 对账 0 差异 + gate 不读事件的断言通过 | 降级为"只写不读" |

### 5.4 回滚演练（每个 flag 都要真跑一次）

| flag | 关停步骤 | 预期 | 检查 |
| --- | --- | --- | --- |
| `taskInput.enabled` | 改 settings + restart team-hub | 写回 JSON 列 | `POST /api/comment` 仍 200 |
| `report.fourStates` | 同上 | 两态 | 老报告可读 |
| `attention.enabled` | 同上 | `❓` 文本 | 任务仍能 blocked |
| `mention.enabled` | 同上 | 一律驳回 | 续跑仍靠 rework |
| `events.enabled` | 同上 | 只写不读 | 派工不受影响 |

### 5.5 风险登记

| # | 风险 | 概率/影响 | 缓解 | 触发信号 |
| --- | --- | --- | --- | --- |
| R1 | 投影替换漏改读取点 → UI 显示空评论 | **低** / 中（D3 后） | 过渡期同事务同步列，读取点零改动（DEC-3） | 对账 `列 vs 行表` 差异 > 0 |
| R2 | `tasks.comments` 有第三处内联写点未发现 | 中 / 中 | grep `comments=` + 守卫测试 | 对账差异 > 0 |
| R3 | 部分唯一索引在老数据上建不起来（已有双开问题） | 低 / 中 | 迁移前先归并（保留最新，旧置 superseded） | 建索引失败 |
| R4 | ~~守护与 team-hub 的 `withTx` 不是同一个连接~~ | **已消除（DEC-2）** | 守护不落盘，写全走 HTTP；残余风险见 R14 | 若 M0 发现直连 → 同一轮改造 |
| R5 | 四态扩展打破看板/渲染映射 | 中 / 中 | 派生映射表 + 渲染兜底 | 任务卡片显示空白 |
| R6 | `@` 语义误判导致士兵把"追加"当"驳回" | 中 / 中 | 上线先只开 `@general` 提问 | 返工率上升 |
| R7 | mandate 写入与 approve 不同事务 | 低 / 高 | 同一 `withTx` + 守卫 | 存在无 mandate 的 accept |
| R13 | **DEC-1 的迁移函数合并引入回归**（把分散的迁移逻辑收成一个，行为可能微变） | 中 / 高 | 合并前先补状态迁移的**全路径用例**；合并后跑全量 + 回归集 | 有任务卡在中间态 / 迁移被跳过 |
| R14 | **DEC-2 的 HTTP 化带来新的失败模式**：守护调接口超时、重试导致重复回报、team-hub 重启期间回报丢失 | 中 / 高 | 回报接口按 `reportId` 幂等 + 守护侧指数退避 + 失败入队重试；team-hub 不可用时守护暂停派工而非降级直写 | `report_duplicate_total` > 0 / 回报积压 |
| R15 | **DEC-3 的同步列长期不清**（B 段一直不做，双写永久化） | 中 / 低 | B 段写进里程碑 M1-5，超过两周未做则记技术债并要求排期 | 双写年龄 > 2 周 |

### 5.6 提交与协作纪律（对齐 `LEGION.md`）

- 只在 `w/<任务ID>` worktree 改；**不 `git push`**。
- 提交**显式列路径**：`git commit -m "…" -- <files>`；禁止 `git add -A`。
- 每个任务产出：改动 + 证据（命令与输出要点）+ 结构化报告 `{status, summary, evidence, blocker}`。
- 改动行为同时更新文档（本文或白皮书对应小节）。

### 5.7 交付物清单

| 交付物 | 位置 |
| --- | --- |
| 功能设计与实施计划（本文） | `docs/design/2026-11-03-superagent-porting-functional-design.md` |
| 写点地图（M0-2） | 本文 §3 更新 + `docs/design/` 附页 |
| 迁移脚本 ×3 | `team-hub/scripts/migrate-task-input.mjs`、`…-audit-columns.mjs`、`…-mandate-backfill.mjs` |
| 守卫测试 ×3 | `team-hub/state-write-guard.test.mjs` 等 |
| 对账 CLI | `team-hub/scripts/reconcile-events.mjs` |
| 周报查询 | `team-hub/scripts/weekly-attention-report.mjs` |
| 回滚演练记录 | `docs/evidence/` |

---

## 6. 验收总表（白皮书 A 系列 → 里程碑）

| 断言 | 内容 | 里程碑 |
| --- | --- | --- |
| A0 | 五个 flag 全关 = 今天的行为 | M1–M6 各自 |
| A1 | 同输入重复只产生一条事件/输入 | M1、M6 |
| A2 | 四态各一条用例；`dropped` 无副作用 | M2 |
| A3 | 有未答问题不派工 | M3 |
| A4 | 回答版本冲突 409 | M3 |
| A5 | `@` 只投 scope 成员、只在可续跑状态 | M4 |
| A6 | 每任务可反查 decision + mandate | M5 |
| A7 | `wouldAccept` 可查 | M5 |
| A8 | 规则变更不撤销在途 | M5 |
| A11 | 并发评论都留痕、幂等、投影一致 | M1 |
| A12 | 对账 0 差异 | M6 |
| A13 | gate 只读状态、不读事件 | M6 |
| **A14** | 守护进程**不直连 `team.db`**（断言 `plugins/src` 无 `DatabaseSync`/db 路径，只有 `/api/*` 调用） | M0-5 / M3 |
| **A15** | 过渡期 `tasks.comments` 与 `task_input` **列/行一致**（对账差异 0） | M1 |
| **A16** | 所有 `status='todo'` 的写入都经过 `transitionTask()`（grep 计数 = 1 处） | M0-4 / M5 |

---

## 7. 决策记录（Q1–Q5 已定，2026-11-03）

> **命名约定**：决策一律用 `DEC-n`；`D1–D3`（并发治理）与 `E1–E3`（自我进化）专指白皮书 §7/§8 的阶段二模块，两者不可混用。
>
> 这五条原为"未决问题"，现已拍板。每个问题保留：**为什么它曾卡住设计 → 决定 → 对本设计的影响（改动点）→ 落地前仍需执行的一次性确认（若结果与假设不符，触发 Plan B）**。

### 决策一览

| # | 问题 | 决定 | 影响模块 | 计划影响 |
| --- | --- | --- | --- | --- |
| **DEC-1** | approve 入口 | 授权绑到**状态迁移**（`→ todo` 时校验并写 mandate），路由只鉴权与转发 | F4、F3 | M0 增"迁移函数收敛"检查；若多处 → 条件任务 0.5–1 天 |
| **DEC-2** | 守护写路径 | 守护**只决定、不落盘**；一切写走 team-hub HTTP | F0、F2、F5 | 新增 `POST /api/tasks/:id/report`；M0 增评估，条件任务 0.5–1 天 |
| **DEC-3** | comments 读取点 | **过渡期同事务同步列**，读取点零改动；两段迁移（先同步、后删列） | F0 | M1 +0.5 天（同步列 + 对账口径） |
| **DEC-4** | 双开问题 | 迁移前**先归并**（保留最新、其余 superseded + 审计），`--dry-run` 给人看 | F2 | M3 前置 M3-0（0.25 天） |
| **DEC-5** | accept_mode 粒度 | **空间级**（与 `space_runtime` 对齐），预留 `goal_overrides` | F4、F3 | 无额外工期 |

**阶段一工期据此修正：16.5 天 → **17.75 天**（DEC-3 的 +0.5、DEC-4 的 +0.25）；若 DEC-1 命中"多处迁移"或 DEC-2 命中"守护直连"，再加条件项 ≤1 天 → **上限约 18.75 天**。

---

### Q1 · approve 的真实入口在哪条路径？

**当初卡住设计**
F4 要把"授权记录（mandate）"写在任务从 `backlog` 变成 `todo` 的那一刻。若这个迁移有多个入口（HTTP 路由 / `taskctl` CLI / 守护自动批准 / 工作台按钮），写在路由里就一定会漏——**漏掉的那个入口产生的任务，会是没有授权的任务**。

**✅ 决定（DEC-1）：把授权绑到"状态迁移"，而不是 HTTP 路由**
在唯一的迁移函数里，`→ todo` 时校验并写 mandate；路由只负责**鉴权与转发**。

**对本设计的影响**
- F4 接线点从"approve 路由"改为 **`transitionTask()`（状态迁移函数）**。
- F3 的追加校验同理：在迁移/写输入的同一点读取 mandate，不在路由分散判断。
- M0 新增检查：`status='todo'` 的写入点若 > 1 → 先合并再开工（条件任务，0.5–1 天）。

**落地前仍需确认（10 分钟）**

```bash
grep -rn "'todo'" team-hub/routes/*.mjs scrum/taskctl.mjs | grep -v test
```

一处 = 直接开工；多处 = 先合并（Plan B 见下）。

**Plan B**：若确认多处，先在 M0 合并成一个 `transitionTask()`，再做 F4。**不要**在路由层打补丁，那会造出第三个写点。

---

### Q2 · 守护插件的写路径：直连 `team.db` 还是走 HTTP？

**当初卡住设计**
F0/F2/F5 都要求"状态写 + 事件追加 + 问题写入"在**同一个事务**里。而"同一个 SQLite 文件"**不等于**"同一个事务"——两个连接各自的 `withTx` 互不原子。

**✅ 决定（DEC-2）：守护"只决定、不落盘"，全部写操作走 team-hub HTTP**
守护负责**扫板 → 决定派谁 → 跑 worker → 回报**；凡是"改任务状态 / 写问题 / 记事件"的，一律调 team-hub 接口。

**对本设计的影响**
- 新增接口 **`POST /api/tasks/:id/report`**（守护回报：`{status, summary, evidence, waitFor?, question?}` → 一个事务内写 `tasks.*` + `agent_questions` + `audit` 事件），定义见 §3 F2。
- F0/F2/F5 的"同事务"假设**全部成立**，因为事务边界 = HTTP 请求边界。
- 守护侧要从"直连写"改为"HTTP 调用"，并处理重试与幂等（见风险 R14）。
- 阶段二 F6/F7 的配额与抢占判定也更干净：守护不再有第二个写口。

**落地前仍需确认（10 分钟）**

```bash
grep -n "dbPath\|DatabaseSync\|team.db\|fetch(" plugins/src/index.ts | head -30
```

**Plan B**：若必须直连（离线/单进程部署），把跨表写收敛成**一条** SQL 或一个函数，依赖 SQLite 单写者 + `BEGIN IMMEDIATE`，并在风险表把 R4 标为"已确认存在"，用对账任务兜底。

---

### Q3 · `tasks.comments` 到底有多少读取点？

**为什么卡住设计**
F0 把评论迁到 `task_input` 之后，所有读 `tasks.comments` 的地方都要跟着改。读的地方越多（render / serve / workbench / mobile / 外部脚本），漏改的概率越高，症状是"看板上评论突然消失"。

**怎么一次确认（10 分钟）**

```bash
grep -rn "\.comments\|comments=\|comments," --include=*.mjs --include=*.ts --include=*.tsx \
  team-hub scrum workbench/src mobile 2>/dev/null | grep -v test | wc -l
```

**✅ 决定（DEC-3）：不"改所有读取点"，过渡期保持列同步**

**对本设计的影响**
- F0 增加"**同事务**同步写 `tasks.comments`"，读取点**零改动**。
- 迁移分两段：**A 段**行表 + 列并存（读取仍走列）；**B 段**读取点收敛到 `commentsOf()` 后，删除同步写与列。
- 对账口径 = "列 vs 行表"，`GET /api/reconcile/inputs` 直接比这两者。
- M1 工期 +0.5 天（同步列 + 对账口径）。

```
insertInput()  ──同事务──┬─▶ task_input（唯一真相，append-only）
                        └─▶ tasks.comments（投影列，同步维护，读路径零改动）
```

过渡期双写、**同事务**；等读取点全部收敛到 `commentsOf()` 后，一次性删除同步写。

| 理由 | 代价 |
| --- | --- |
| 读取点零改动 → 风险 R1 从"高"降到"低" | 过渡期多一次写（同事务，可接受） |
| 可随时回退（列还是对的） | 需要 `commentsOf()` 与列严格一致 → 靠对账任务保 |

> ⚠️ 澄清一处：白皮书反对的是"**两处独立写入**"（可能一个成一个败）；**同事务内的同步投影**是安全的，不违反约束 7。

**Plan B**：若读取点少于 5 处，直接改读取点、不做同步列（更干净）。

**影响模块**：F0、F3（输入列表接口）

---

### Q4 · 现有数据里有没有"同一任务两条 open question"？

**为什么卡住设计**
F2 要在 `agent_questions(task_id) WHERE status='open'` 上建**部分唯一索引**。若历史数据已有双开，索引直接建不起来，迁移阻塞在第一步。

**怎么一次确认（1 分钟）**

```sql
SELECT task_id, COUNT(*) c FROM agent_questions
WHERE status='open' GROUP BY task_id HAVING c > 1;
```

**✅ 决定（DEC-4）：迁移前先归并，dry-run 给人看**

**对本设计的影响**
- F2 增加**迁移前置步骤 M3-0**：查重 → 归并（保留最新、其余 `superseded`）→ 写 `audit(action='question_merge')` → 建部分唯一索引。
- 交付物新增 `team-hub/scripts/merge-open-questions.mjs`（带 `--dry-run`）。
- 若查重结果为空则跳过（脚本幂等）。
1. 找出双开的 `task_id`；
2. 保留**最新一条**，其余置 `status='superseded'` + 写一条 `audit(action='question_merge')` 说明来源；
3. `--dry-run` 先打印清单，人确认后再执行；
4. 建索引。

| 理由 | 代价 |
| --- | --- |
| 不删数据，只改状态（可复原） | 需要一次人工确认 |
| 归并动作本身留痕，可审计 | — |

**Plan B**：若双开很普遍（说明写入缺少约束），先在**应用层**加互斥（写前查 open），跑一周观察无新增后，再建索引。

**影响模块**：F2（迁移）

---

### Q5 · `accept_mode` 的粒度：全局 / 空间 / 目标？

**为什么卡住设计**
它决定"autonomy 的开关装在哪一级"。装太粗（全局）→ 一个实验空间放开，所有空间一起放开；装太细（目标级）→ 同一空间里两套标准并存，无法解释"为什么这个目标能自动、那个不能"。

**三种选择**

| 粒度 | 好处 | 坏处 |
| --- | --- | --- |
| 全局 | 简单，一个值 | 无法分区试验；一处放开全局受影响 |
| **空间级（推荐）** | 与 `space_runtime` / 成员 / 规则的分层一致 | 需要按空间配置（已有先例） |
| 目标级 | 最细 | 同空间标准不一，审计解释成本高 |

**✅ 决定（DEC-5）：空间级，字段预留目标级 override**

**对本设计的影响**
- F4 的 `accept_mode` 落在 `space_runtime`（与 `maxWorkers` 同表），不落全局 settings。
- `mandate.strength` 判定时读**任务所在空间**的 `accept_mode`。
- `goal_overrides` 字段**先建不实现**（结构预留），避免将来改表。
- 无额外工期。

```jsonc
// settings（空间级真值）
{ "accept_mode": "observe",
  "goal_overrides": {} }        // 预留：{"G-xxx": "off"}，先不实现
```

| 理由 | 代价 |
| --- | --- |
| Legion 的隔离单位本来就是空间（成员 / rules / maxWorkers 都按空间） | 多一个字段层级 |
| 与 `space_runtime` 同一张表，读取零成本 | — |
| 需要更紧时可用 goal override 单独收紧，不必放宽全局 | — |

**Plan B**：若短期内只有一个空间在用，先做全局（一个值），但**读取接口按"空间级"签名**，将来加维度不改调用方。

**影响模块**：F4（settings 结构）、F3（`@` 的 explicit 判定依赖 strength）

---

## 8. 阶段二：并发治理与自我进化（白皮书 §7 / §8 的落地）

### 8.0 总路线图

```
 阶段一（本文 §3–§5）：把契约立起来                     阶段二（本节）：同时干更多事 + 越干越对
 ─────────────────────────────────────               ──────────────────────────────────────
 M0 → M1(F0) → M2(F1) → M3(F2) → M4(F3) → M5(F4) → M6(F5)
   探针  输入     四态     attention   @语义    台账    事件+对账
   0.5   0.5      1        1.5        3        4       6       ≈ 16.5 天
                                                              │
                            ┌─────────────────────────────────┘
                            ▼
        M7(F9)      →   M8(F6)   →   M9(F7)   →   M10(F8)  →  M11(F10)  →  M12(F11)
        E1 错误归纳     D1 目标配额    D2 抢占/人优先  D3 并发可解释   E2 影子验证    E3 不退化门
        2 天            2 天           2.5 天          1 天            3 天           2 天   ≈ 12.5 天
                        └────────── 可与 M10 并行 ──────────┘

  ★ 顺序不可换：E1 必须先于 D1 —— 没有回归集的并发，只是把错误放大 N 倍。
```

**与阶段一的关系**：阶段二**不新增状态源**，全部建立在阶段一的数据面上——
- D1/D2 读 `tasks.goalId` + `space_runtime.maxWorkers` + `agent_commands`（都已有）
- E1/E2/E3 读 `decisions`（F4 产出）+ `audit` 事件（F5 产出）+ 附录 A 指标

因此**阶段二一行代码都必须在 M6 之后开始**，否则没有数据。

---

### 8.1 F6 · 目标级配额与公平（D1）

**目标**：同一空间里，一个大目标不能把槽位吃干，小目标不能饿死。

**功能点**
1. 空间配置加"目标份额"：每目标最多占多少槽 / 权重。
2. 候选 SQL 增加 goal 维度的排序与配额约束。
3. 允许**借槽**（其它目标空闲时可用），但带过期时间，避免长期占用。

**数据契约**

```jsonc
// space_runtime 新增列（JSON）
"goal_share": {
  "default": 0.5,                    // 单目标默认最多占一半槽位
  "weights": { "G-1001": 2 },        // 可选加权
  "borrowTtlSec": 600                 // 借槽最长占用
}
```

**行为与不变量**
- `I-6.1` 单目标活跃槽 ≤ `ceil(maxWorkers × share)`，除非空间内无其它目标在等。
- `I-6.2` 借槽必须有 TTL，到期释放；释放动作写 `audit(action='share_release')`。
- `I-6.3` 配额只影响**认领顺序**，不改变 gate 的资格判定（`TASK_GATES` 不动）。

**接线点**：`team-hub/claim-policy.mjs` 的 `buildClaimableTaskSql()`（加 goal 计数子查询）+ `space_runtime` 列。

**验收**
- 12 片的大目标 + 1 个单任务的小目标，同空间并发：小目标 P95 等待 ≤ 约定阈值（建议 15 分钟）。
- 空载时大目标可以用满全部槽（借槽生效）。
- 关闭开关后排序回到 `priority × createdAt`。

**回滚**：`goalShare.enabled=false` → 排序回原逻辑（配置保留）。

**依赖**：M6 完成（需要事件判断"目标是否在等"）；可与 M10 并行。

---

### 8.2 F7 · 抢占与人优先槽（D2）

**目标**：满负荷时人还能立刻插话；紧急任务能让槽。

**功能点**
1. 空间配置 `reservedSlots`（默认 1）：只给人发起的输入使用。
2. 抢占请求：向当前持有者投 `agent_commands` 的 `stop` → 释放槽 → 新任务入槽。
3. 被抢占任务收到 recovery note 后回 `todo`，可续跑。
4. **最小执行时间**保护：任务执行不足 60s 不可被抢占（防抖）。

**数据契约**：复用 `agent_commands`（`type: 'stop' | 'release_hold'`）+ `space_runtime.reserved_slots`。不建新表。

**行为与不变量**
- `I-7.1` 抢占只能由 `strength='explicit'` 的请求发起（bot / inferred 不可抢占）。
- `I-7.2` 被抢占任务必须能 resume，且带一条"被谁因何抢占"的说明（写 `task_input`）。
- `I-7.3` 保留槽只接受人发起的输入；后台新活不得占用。
- `I-7.4` 同一任务在 10 分钟内被抢占 ≥ 2 次 → 拒绝后续抢占并告警（防活锁）。

**接线点**：`plugins/src/index.ts` 的认领逻辑（读保留槽）+ `agent-conversations.mjs` 的 `command()`（已有 stop/release_hold）。

**验收**
- 满负荷下人的消息 P95 响应 < 30s。
- 被抢占任务 resume 后不丢上下文（对比 attempt 前后 `task_input` 消费数）。
- 抖动保护生效：60s 内不抢占、10 分钟内不二次抢占。

**回滚**：`preempt.enabled=false` → 保留槽退回普通槽，抢占接口 403。

**依赖**：M9 需 M8（配额先上，否则抢占会被大目标反复触发）。

---

### 8.3 F8 · 并发可解释（D3）

**目标**：任一排队任务，一眼看出"我被什么挡住"。

**功能点**：把现有 `contention` 聚合成分类型阻塞源，并在任务详情给出"谁挡我、挡了多久"。

**接口契约**

```jsonc
// GET /api/tasks/:id/blocking
{ "blocked": true, "since": "…",
  "reason": "slot | fileDomain | dependency | lease | question",   // 见 F2 的 no-open-question
  "blocker": { "taskId": "T-118", "holder": "soldier-coder", "expiresAt": "…" },
  "waitedSec": 842 }
```

**不变量**
- `I-8.1` `reason` 必须是枚举（不允许自由文本），与 gate 的拦截点一一对应。
- `I-8.2` 该接口只读，不得触发任何状态变更。

**接线点**：`routes/write-intent.mjs` 的 contention + `claim-policy` 的 gate id 复用（gate id 直接作为 `reason`）。

**验收**：任一排队任务返回非空 `reason`；`reason='question'` 只在 F2 开启时出现；接口无写副作用。

**回滚**：纯只读，无需开关；不返回该接口即可。

**依赖**：M3（F2 提供 `question` 阻塞源）。可与 M7/M8 并行。

---

### 8.4 F9 · 错误归纳机械化（E1）

**目标**：失败不再只留在 `docs/bugs/` 的手写记录里，而是自动变成**回归用例**。

**功能点**
1. 从 `decisions` + `audit` 中提取失败事件（`failed` / `rework` / `unavailable`）。
2. 按 `stage × rule × fileDomain` 聚类，输出"top 失败簇"。
3. 每个簇生成**回归用例草稿**（模板：现象 / 复现命令 / 期望 / 关联任务）。
4. 人确认后 `draft → active`；CI 从此跑 active 集。

**数据契约**

```sql
CREATE TABLE IF NOT EXISTS regression_cases (
  id TEXT PRIMARY KEY,
  cluster_key TEXT NOT NULL,        -- stage:rule:pathPrefix
  source_task TEXT,                 -- 来源任务
  kind TEXT NOT NULL,               -- unit | e2e | manual
  command TEXT,                     -- 复现/验证命令
  expect TEXT NOT NULL,             -- 期望（可机器判定的断言）
  state TEXT NOT NULL DEFAULT 'draft',  -- draft | active | retired
  created_at TEXT NOT NULL, promoted_by TEXT
);
```

**行为与不变量**
- `I-9.1` 只能生成 `draft`；`active` 必须由人晋升（沿用 skills 的 review 门）。
- `I-9.2` 聚类键必须稳定（同一失败重复出现不会被拆成两个簇）。
- `I-9.3` 每个 P0 失败**必须**有至少一条 active case 才算闭环（由周报检查）。

**接线点**：新增 `team-hub/regression-store.mjs` + `scripts/regression-candidates.mjs`（聚类 CLI）；失败事件来自 F5 的事件流。

**验收**：跑一次历史数据能产出 top-5 失败簇；每个簇有可执行草稿；晋升后 CI 能跑。

**回滚**：纯增量（新表 + CLI），关掉生成器即停。

**依赖**：M6（需要事件流）。

---

### 8.5 F10 · 规则候选影子验证（E2）

**目标**：改规则/提示词之前，先看它在**历史决策**上会不会做出不同判断。

**功能点**
1. 从 `experience` draft 生成"候选规则"（指向具体 `policy_rules` 或 stage prompt）。
2. 在 `observe` 档用候选规则重放一批历史候选，得到 `would_accept` 分布。
3. 与现役规则同批对比，输出差异报告。

**数据契约**：复用 `decisions`（`policy_version` 已记录来源版本）；新增只读视图/查询，**不新增表**。

**接口契约**

```jsonc
// GET /api/shadow-report?candidateRuleId=&from=&to=
{ "n": 128, "same": 109, "flipToAccept": 12, "flipToIgnore": 7,
  "flips": [{ "subject": "task:T-201", "current": "ignore", "candidate": "accept", "why": "R-7 命中" }] }
```

**不变量**
- `I-10.1` 影子跑**不得**产生真实任务、不得写 `tasks`。
- `I-10.2` 差异率 > 阈值（建议 20%）→ 报告标记"需人工评审"，禁止自动晋升。
- `I-10.3` 影子结论只写 `decisions(would_accept=1, policy_version='shadow@x')`，与现役版本可区分。

**接线点**：`evaluate()` 纯函数（F5 已建）可直接复用；`experience-store` 的 draft 提供候选。

**验收**：同一批 128 条历史候选能出差异报告；翻转案例可下钻到具体规则；无副作用。

**回滚**：`shadow.enabled=false`。

**依赖**：M5（`policy_rules` / `decisions`）+ M6（`evaluate()`）。

---

### 8.6 F11 · 不退化门（E3）

**目标**：任何规则/提示词/岗位包改动，都要证明"没变差"。

**功能点**
1. CI 步骤：跑 `regression_cases(state='active')` + 附录 A 六项指标。
2. 与基线快照比对；退化超阈值 → 阻止合并。
3. 基线由人更新（agent 无权改）。

**数据契约**

```sql
CREATE TABLE IF NOT EXISTS metric_baseline (
  metric TEXT NOT NULL, scope TEXT NOT NULL, value REAL NOT NULL,
  at TEXT NOT NULL, set_by TEXT NOT NULL, PRIMARY KEY (metric, scope)
);
```

**行为与不变量**
- `I-11.1` **基线表只能由人写**（API 校验 `by` 属于人工角色），agent 无权修改——这是白皮书 §8.3 硬约束①的落地。
- `I-11.2` 退化判定必须给"哪个指标、从多少到多少、阈值几何"，不能只说"变差了"。
- `I-11.3` 门是**硬的**：不通过就不合并，没有 `--force`（紧急放行要单独走审批并留痕）。

**接线点**：CI 配置 + `scripts/weekly-attention-report.mjs`（指标来源复用）。

**验收**：故意把某指标改差 → 门拦住并说明原因；人更新基线后放行；记录留痕。

**回滚**：门挂在 CI，关闭即降级为"只报告不拦截"。

**依赖**：M7（回归集）+ M6（指标）。

---

### 8.7 阶段二里程碑与 WBS

```
 M7 F9   ──▶  M8 F6  ──▶  M9 F7  ──▶  M11 F10  ──▶  M12 F11
 2 天         2 天         2.5 天       3 天          2 天
                 └── M10 F8 1 天（可并行）──┘
```

| 里程碑 | 内容 | 工期 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| **M7** | E1：失败聚类 + 回归草稿 + 晋升门 | 2 天 | M6 | 历史数据出 top-5 簇；草稿可执行 |
| **M8** | D1：目标级配额 + 借槽 TTL | 2 天 | M6 | 小目标 P95 等待达标；空载可占满 |
| **M9** | D2：保留槽 + 抢占 + 抖动保护 | 2.5 天 | M8 | 人的消息 P95 < 30s；可 resume |
| **M10** | D3：`/blocking` 可解释接口 | 1 天 | M3 | 排队任务 `reason` 非空 |
| **M11** | E2：影子验证 + 差异报告 | 3 天 | M5、M6 | 128 条历史出差异报告 |
| **M12** | E3：不退化门 + 基线表 | 2 天 | M7、M6 | 退化被拦；基线人写 |

**阶段二合计 ≈ 12.5 天**（M10 并行，实际串行 11.5 天）。

| ID | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M7-1 | 失败事件提取与聚类 | `scripts/regression-candidates.mjs` | top-5 簇稳定 |
| M7-2 | `regression_cases` 表 + 晋升门 | store + review 路由 | draft→active 需人 |
| M7-3 | CI 接入 active 集 | 流水线一步 | 跑不过即红 |
| M8-1 | `goal_share` 配置 + 借槽 TTL | `space_runtime` 列 | 配置可读 |
| M8-2 | 候选 SQL 加 goal 维度 | `claim-policy` 补丁 | 配额单测 |
| M9-1 | 保留槽 + 抢占接口 | 认领先读保留槽 | 人的消息可插 |
| M9-2 | 抢占与 resume 闭环 | `agent_commands` 接线 | 不丢上下文 |
| M9-3 | 抖动保护 | 60s / 10min 规则 | 防活锁用例 |
| M10-1 | `/blocking` 聚合接口 | 路由 | `reason` 枚举 |
| M11-1 | 候选规则 → 影子跑 | `shadow-report` | 无副作用 |
| M11-2 | 差异报告与下钻 | 查询 + 页面/CLI | 翻转可解释 |
| M12-1 | 指标基线表 + 只人人写 | 表 + 校验 | agent 被拒 |
| M12-2 | 不退化门 | CI 步骤 | 退化被拦 |

### 8.8 阶段二验收（B 系列）

| 断言 | 内容 | 里程碑 |
| --- | --- | --- |
| B1 | 单目标活跃槽 ≤ 配额（除非无人竞争） | M8 |
| B2 | 借槽到期自动释放并留痕 | M8 |
| B3 | 满负荷下人的消息 P95 < 30s | M9 |
| B4 | 被抢占任务可 resume 且不丢上下文 | M9 |
| B5 | 任一排队任务返回非空 `reason`（枚举） | M10 |
| B6 | 每个 P0 失败有 ≥1 条 active 回归用例 | M7 |
| B7 | 影子跑不产生真实任务 | M11 |
| B8 | 差异率 > 20% 自动标记"需人工评审" | M11 |
| B9 | 指标退化超阈值阻止合并 | M12 |
| B10 | 基线只能由人更新（agent 写入被拒） | M12 |

### 8.9 阶段二风险

| # | 风险 | 概率/影响 | 缓解 | 触发信号 |
| --- | --- | --- | --- | --- |
| R8 | 配额导致槽位利用率下降（为公平牺牲吞吐） | 中 / 中 | 借槽机制 + 监控 `slot_idle_ratio` | 空转率 > 30% |
| R9 | 抢占抖动（任务反复被踢） | 中 / 高 | 60s 最小执行 + 10min 二次抢占禁止 | 同任务抢占 ≥ 2 次/10min |
| R10 | 回归集膨胀导致 CI 变慢 | 中 / 中 | 分片 + 只跑受影响域（按 fileDomain 选子集） | CI 时长 > 2×基线 |
| R11 | 影子验证的"同批历史"样本偏差 | 中 / 中 | 固定抽样集 + 记录抽样口径 | 差异率月间剧烈波动 |
| R12 | 基线被人为放宽以通过门 | 低 / 高 | 基线变更必须写理由 + 双人确认 | 基线变更频率异常 |



---

## 9. 实施进度（滚动更新）

| 里程碑 | 状态 | 产出 | 证据 |
| --- | --- | --- | --- |
| M0 基线&探针 | ✅ 完成 | DEC-1 / DEC-2 / DEC-3 结论（见 §7 上方「M0 实测结论」） | grep 计数 |
| M1 · F0 输入行化 | ✅ **完成（B 段删列除外，见下）** | 输入行表 + 投影 + 消费/取代 + 对账 + **两个只读接口** + **A 段迁移 CLI** | `task-input` 9/9、`-routes` 5/5、`-migration` 5/5、`comment-routes` 11/11、`task-records` + `write-intent` 全绿；合计 **56/56** |
| M2 · F1 Report 四态 | ✅ **完成** | 四态意图 + `wait_for` 枚举 + 校验拒收 + `dropped` 静默取消 + `waiting` 不发噪音 + 提示词与 JSON schema | `report-settlement.test.mjs` 7/7；`stateMachine` + `timeout-settlement` + `acceptance` + `multi-space` 112/112 |
| M3 · F2 attention 接线 | 🚧 **进行中（闸与归并已落地）** | ① `no-open-question` 任务级闸（SQL + `holds()` 镜像 + 专属拒绝码 + 策略版本 v2）；② M3-0 归并脚本与**部分唯一索引**（DB 层保证"一任务一未答问题"）；③ 启动时建索引、失败给出可执行指令 | `claim-policy-question-gate` 6/6、`merge-open-questions` 6/6、`claim-policy` 39/39 |
| M3 · 回报写口 | ✅ 完成 | `task-report.mjs`（校验/幂等/只允许一个未答问题/三样一起落盘）+ `POST /api/tasks/:id/report`（走 `handleWrite`，`{ok,task,question,auditSeq,duplicated}`） | `task-report` 8/8、`task-report-routes` 5/5（含"报完真的停派"端到端） |
| M3 · 回答放行 | ✅ 完成 | `task-resume.mjs`：blocked + 无未答问题 ⇒ 回 `todo`（乐观锁 + 审计）；`answer_question` 分支改为**输入行**写答复并调用放行 | `task-resume` 5/5；`chat.test.mjs` 53/53 回归 |
| M3 · 阶段派生 | ✅ 完成 | `task-stage.mjs`：`awaiting_answer` / `stuck` / `dropped` / 原样 status，**首次匹配即胜**、脏输入不抛 | `task-stage` 6/6 |
| M3 · 守护换写点 | ✅ 完成 | `reportPayload.ts`（幂等键 `blocked:<id>:<version>`、空 blocker 不带问题、id 转义、问题截断 800）；守护 `blocked` 分支改为**一次** `POST /api/tasks/:id/report` + `applyTransition`，接口失败自动回落评论+transition；`❓` 文本不再写 | `report-payload` 7/7；plugins 回归 99/99；team-hub 回归 106/106 |
| M4 · F3 `@` 语义 | 🚧 **进行中（解析 + 评论接线已落地）** | `mentions.mjs`：边界正则（邮箱/单词内 @ 不算）、只认 scope 成员、自 @ 忽略、幂等、escalate 优先；`appendTaskNote` 单点分流：无 @ → `comment`、@成员 → `order` + `meta.mention_role`、@general → 建未答问题（升级为提问） | `mentions` 10/10、`mention-routes` 5/5、`comment-routes` 11/11、合并回归 82/82 + 42/42 |
| M4 · 守护侧分流 | ✅ 完成 | `commentIntent.ts`：无 @ ⇒ rework、@成员 ⇒ order（追加，不算失败）、@general ⇒ escalate（**守护停手**等人拍板）；`stateMachine` 按意图分流，`workReturned` 措辞分开 | `comment-intent` 8/8；`stateMachine` 回归 62/62；acceptance/handoff/multi-space/timeout 回归 111/111 |
| M4 剩余 | ⬜ | 超 `fileDomain` 的追加拒绝（依赖 F4 的 mandate，留到 M5） | — |
| M5 · F4 授权与台账 | 🚧 **进行中（mandate + decisions + 只读面已落地）** | `mandate-policy.mjs`（不可变 mandate、四道 `MANDATE_GATES`、`widenMandate` 版本链）；`decisions.mjs`（`policy_rules`/`decisions` 表、`accept/stop/ignore/unavailable` 分流、`would_accept`）；只读面 `GET /api/decisions`、`GET /api/tasks/:id/mandate?all=1`；启动建表 + `tasks.mandate`/`accept_mode` 列 | `mandate-policy` 9/9、`decisions` 8/8、`decisions-routes` 5/5；F0–F4 合并回归 **148/148** |
| M5 · 写入口（DEC-1） | ✅ 完成 | `acceptance.mjs`：`→ todo` 时写 mandate + 决策 + audit；**strict=false 先记账 / strict=true 才强制**（`LEGION_MANDATE_STRICT=1`）；接在 `transitionTask()` 的 `to==='todo'` 分支内（同事务，拒绝即回滚） | `acceptance` 6/6、`decisions-routes` 6/6（含真实 `blocked→todo` 迁移落账）；F0–F4 回归 150/150 + 迁移密集套件 51/51 |
| M5 · 规则集与受理模式 | ✅ 完成 | `policy-rules.mjs`（校验 / upsert / **内容指纹版 policyVersion** / `policy_changed` 事件）；`GET｜POST /api/policy-rules`；`space_runtime.accept_mode`（DEC-5，任务上留快照，查不到兜底 manual） | `policy-rules` 5/5、`policy-rules-routes` 6/6、`accept-mode` 3/3；F0–F4 合并回归 **164/164** |
| M5 | ✅ **完成** | F4 全部落地：授权（mandate）+ 台账（decisions）+ 写入口（transitionTask）+ 规则集 + 空间受理模式 | 同上 |
| M6 · F5 事件流 | 🚧 **进行中（事件章 + 游标 + 对账已落地）** | `event-log.mjs`：`event_id = hash(kind,subject,version)`、重复事件忽略、`event_cursor` 单调不重放、`reconcileEvents()` **只读**对账；`GET /api/reconcile?scope=&untilSeq=`；`scripts/reconcile-events.mjs`（差异>0 ⇒ exit 1） | `event-log` 6/6（含"消费事件不改任务状态"=I-5.2）、`decisions-routes` 8/8（含⑦⑧）；F0–F5 合并回归 **172/172**；CLI 手测 exit 1 通过 |
| M6 · 事件章接线 | ✅ 完成 | `audit()` 单点盖事件章（`transition`/`comment`/`delivery`/`verify`/`goal` 五类），派生 `actor_kind` 与 `human`（决定能否授权）；**不改 `action`**（既有读取方按它分派）；盖章失败只告警、不影响业务写入 | `audit-events` 5/5（含"event_id 有值且 action 仍是 transition"与"盖章失败不阻断迁移"） |
| M6 · 周报 | ✅ 完成 | `weekly-report.mjs` + `GET /api/report/weekly`：六个数（accepted/stopped/ignored/unavailable/wouldAccept/mandateMissingRatio）+ 支撑数（在途、缺授权、事件积压），**只读** | `weekly-report` 5/5、`decisions-routes` ⑨；F0–F5 合并回归 **183/183** |
| M6 | ✅ **完成** | F5 全部落地：事件章 + 游标 + 只读对账 + CLI + 周报 | 同上 |
---

## 10. 阶段二进度（滚动更新）

| 里程碑 | 状态 | 产出 | 证据 |
| --- | --- | --- | --- |
| M7 · F9 错误归纳（E1） | 🚧 **进行中（聚类 + 草稿 + 晋升门已落地）** | `regression-store.mjs`：失败收集（decisions `stop/unavailable` + audit `rework`）、稳定聚类键 `stage:rule:pathPrefix`、draft 幂等；`scripts/regression-candidates.mjs`（`--top` / `--save`）；`GET /api/regression-cases`、`POST /api/regression-cases/candidates`、`POST /api/regression-cases/:id/promote`（**只有人**能晋升，I-9.1） | `regression-store` 5/5、`regression-routes` 5/5；F0–F9 合并回归 **193/193**；CLI 手测：4 条失败聚成 2 簇（3+1），`--save` 落 2 份 draft |
| M7 · CI 跑 active 集 | ✅ 完成 | `planRun()`（只取 active、无命令的如实列 `skipped`）+ `scripts/run-regression-cases.mjs`：**默认只打印**，`--execute` 才跑且**不开 shell**（argv 直切，挡 `;`/`|`/重定向） | `regression-store` 6/6（新增⑥）；F0–F9 合并回归 **201/201** |
| M7 · I-9.3 闭环口径 | ✅ 完成 | 周报 `support.closure`：`p0Total / uncovered / uncoveredTasks / ok`——P0 决策的任务若无 **active** 用例以 `source_task` 覆盖即算未闭环；**draft 不算覆盖**（呼应 I-9.1） | `closure-check` 5/5 |
| 全局约束 · 迁移幂等 | ✅ 完成 | `schema-idempotency`：10 个 `ensure*Schema` + 唯一索引各自跑两次不抛、结构不变（含视图）；覆盖"两进程同时启动"的真实形态 | `schema-idempotency` 11/11 |
| M8 · F6 目标级配额（D1） | 🚧 **进行中（公平算法已落地）** | `goal-share.mjs`：配置归一化（份额夹 0..1、权重取整、TTL **夹到下限**）、配额 `ceil(maxWorkers×share×weight)` 且至少 1、`admitCandidate()`（配额内 / 借槽带 TTL / 超配额拒绝）、`orderCandidates()`（缺口→priority→createdAt） | `goal-share` 7/7（⑦ 断言配额**不进** gate：候选 SQL 里没有 goal 配额条件，I-6.3） |
| M8 · 配置与借槽 | ✅ 完成 | `space_runtime.goal_share` 列；`GET｜POST /api/spaces/:scope/goal-share`（读给默认值、写归一化后落库）；`ensureBorrowSchema` + `recordBorrow` / `activeBorrows` / `releaseExpiredBorrows`（到期释放**必留** `share_release` 审计，幂等）；`POST /api/goal-borrows/release` | `goal-borrow` 5/5、`goal-share-routes` 4/4；阶段二合并回归 84/84，F0–F9 全量 **210/210** |
| M8 剩余 | ⬜ | 把 `orderCandidates()` 接进实际认领排序层（`run-store` 候选扫描），开关 `goalShare.enabled` 默认关 | — |
| M9 · F7 抢占（D2） | 🚧 **进行中（判定 + 台账 + 留痕已落地）** | `preemption.mjs`：四道闸（只人 / 只 explicit / 60s 防抖 / 10min 防活锁并 `alert`）、`reserveSlotDecision()`（保留槽只给人）、`preemptionNote()`（被谁·因何·会带你回来）；`POST /api/tasks/:id/preempt` 一次落三处（台账 + `task_input` + 审计）；`handleWrite` 透出 `alert` | `preemption` 8/8、`preemption-routes` 5/5；全量 **223/223** |
| M9 · 执行面（让槽） | ✅ 完成 | `applyPreemption()`：台账 → 时间线说明 → **回 `todo`（可 resume）** → 尽力通知 `stop_run`；**通知失败不回滚**（任务已释放是事实）；`server.mjs` 的 `issueStopCommand()` 走既有 `agent_commands` 通道；`space_runtime.reserved_slots` 列已落 | `preemption-exec` 4/4、`preemption-routes` 6/6（新增⑥"抢完真的回到 todo"）；全量 **283/283** |
| M9/F6 · 认领准入 | ✅ 完成 | `claim-admission.mjs`：保留槽（I-7.3）与目标配额（I-6.1）合成**一个**判定（两处各写一遍的规则迟早给出相反结论）；接进 `/api/claim`，**默认关闭**（`LEGION_CLAIM_ADMISSION=1` 才生效）⇒ 开关全关 = 今天的行为 | `claim-admission` 6/6、`claim-admission-routes` 2/2；全量 **289/289** |
| M8 剩余 | ✅ 说明 | `orderCandidates()` 已实现并测（F6 排序层）；实际认领排序仍由 `PRIORITY_ORDER_SQL` 决定——**未接线是有意的**：排序改动的影响面比准入大，留待单独一轮带影子对比（F10 的 `shadow-report` 已能算翻转率） | — |
| M10 · F8 并发可解释（D3） | ✅ 完成 | `blocking.mjs`：`reason` 六值枚举（hold / question / dependency / fileDomain / lease / slot，与 gate 一一对应，I-8.1）、按调度器真实拦截顺序判定、`blocker` 指到具体挡路者、`waitedSec` 答"挡了多久"；`GET /api/tasks/:id/blocking` **纯只读**（I-8.2）；新增 `space_runtime.reserved_slots` 列 | `blocking` 9/9、`blocking-routes` 6/6；全量 **238/238** |
| M9 剩余 | ⬜ | 执行面让槽接线（`agent_commands.stop` → 释放 → 被抢任务回 `todo`）；认领时读 `reserved_slots` | — |
| M11 · F10 影子验证（E2） | ✅ 完成 | `shadow-report.mjs`：按候选规则 kind 重放历史 decisions（`always` 补依据 → accept、`never` → stop、`when` 不猜），输出 `n/same/flipToAccept/flipToIgnore/flipRate/flips`；差异率 > 阈值 ⇒ `needsReview`（I-10.2）；候选规则不存在 ⇒ **404** 而不是假报告；`GET /api/shadow-report` **纯只读**（I-10.1） | `shadow-report` 7/7、`shadow-report-routes` 4/4；全量 **249/249** |
| M12 · F11 不退化门（E3） | ✅ 完成 | `regression-gate.mjs`：`metric_baseline`（PK `metric+scope`）、**只有人能写基线**（I-11.1）、`checkGate()` 按指标方向与容忍度判退化并给四要素说明（I-11.2）、**传 `force` 也照样拦**（I-11.3）；`scripts/check-baseline.mjs` 挂 CI：退化 ⇒ exit 1 | `regression-gate` 8/8；CLI 手测：`stopped 1→3` 拦住并说明阈值，`--force` 仍 exit 1 且 `forcedIgnored:true`；全量 **262/262** |
| **F0–F11** | ✅ **全部模块落地** | 阶段一 6 个 + 阶段二 6 个功能模块，共 **30+ 个新模块、262 条 team-hub 判据** | 见 §9 / §10 各里程碑 |

**本轮改动清单**

- 新增 `team-hub/task-input.mjs`：`ensureTaskInputSchema` / `appendInput` / `listInputs` / `projectField` / `syncField` / `markConsumed` / `supersedeInput` / `reconcileInputs`。
- 新增 `team-hub/task-input.test.mjs`：9 条判据，**TDD 先红（模块缺失）后绿**。
- 改 `team-hub/server.mjs`：加 import、启动时 `ensureTaskInputSchema(db)`、`appendTaskNote` 与 `reassignTask` 的内联写改为 `appendInput`（消除对 `comments` 列的两处独立写）。

**未做（下一步，仍属 M1）**

- `GET /api/tasks/:id/inputs`、`GET /api/reconcile/inputs` 两个只读接口。
- A 段历史迁移脚本 `scripts/migrate-task-input.mjs`（幂等、`--dry-run`）与 B 段 `drop-comments-column.mjs`。

**M2 实测修正（TDD 撞出来的两条）**

- **`dropped` 落 `canceled`，不是 `done`**：`scrum/taskctl.mjs:527-532` 规定「只有将军（--by general）能在用户接受后把任务移到 done」，而「无需处理」的执行面语义等于取消。契约随之改为 `taskStatus: 'canceled' + noAction: true`，看板据 `canceled` + 审计 `drop` 显示「无需处理」。
- **`waiting` 的实现口径**：Legion 没有 `idle` 状态，因此 `waiting` 留在 `in_progress`、**不发任何消息**、只写 `report` 审计；由 stale 回收器在下一轮重新评估（这是"等条件成熟再试"的自然实现，不是重试风暴）。

**基线说明（避免误判）**

- `plugins/tests/worker-regression.test.mjs` 在本机**存量失败**（10s 超时、`worker did not reach transition`）。已用 `git stash` + 重新构建做**对照**：不引入 F1 改动时同样失败 → 属环境/既有问题，与本轮无关。

**已知偏差与取舍**

- `appendInput` 对 `taskId` 只判「非空字符串」而不 trim —— 保留 `/api/comment` 既有文案「未知任务 <id>」（含只含空格的 id），既有用例 ⑦ 依赖这条契约。
- 过渡期列同步在**同一事务**内完成（`appendInput` 自带 `BEGIN IMMEDIATE`，或由调用方 `withTx` + `inTransaction:true`），符合全局约束 7。

---

## 11. 交付说明（implemented）

> 本节是**可验收**的收口：做了什么、每条不变量由哪条判据证明、怎么开关与回滚、还剩什么。
> 更新于 2026-11-03。

### 11.1 范围与状态

| 模块 | 一句话 | 状态 |
| --- | --- | --- |
| F0 `task_input` | 评论/证据/反馈迁到 append-only 行，列为投影 | ✅ 含 A 段迁移；B 段删列待读取点收敛 |
| F1 Report 四态 | 消灭"假完成/假受阻"；`dropped` 落 `canceled` | ✅ |
| F2 Attention | 有未答问题就不派工 + 回报写口 + 回答放行 + 阶段派生 | ✅ |
| F3 `@` 语义 | 一条评论三种语义（追加/提问/普通） | ✅ team-hub 解析 + 守护分流 |
| F4 受理台账 | 凭什么开工（mandate）+ 为什么没做（decisions） | ✅ 含规则集与空间受理模式 |
| F5 事件流 | 事件章 + 游标 + 只读对账 + CLI + 周报 | ✅ |
| F9 错误归纳 | 失败 → 稳定聚类 → draft 用例 → **人**晋升 | ✅ |
| F6 目标配额 | 配额算法 + 借槽 TTL + 认领准入 + **认领顺序**（均开关默认关） | ✅ |
| F7 抢占 | 四道闸 + 台账 + 留痕 + **真的让槽** | ✅ |
| F8 并发可解释 | `reason` 六值枚举 + "挡了多久" + 纯只读 | ✅ |
| F10 影子验证 | 新规则会让历史决策翻转多少；超阈值要人评审 | ✅ |
| F11 不退化门 | 基线只能人写；退化即拦；**没有 force** | ✅ |

### 11.2 不变量 ↔ 判据对照

| 不变量 | 判据（文件 · 用例） |
| --- | --- |
| I-3.x `@` 四护栏 | `mentions.test.mjs` ②–⑤、`commentIntent`（plugins）③⑤⑦ |
| I-4.1 受理必须有依据 | `decisions.test.mjs` ② |
| I-4.2 mandate 只追加 | `mandate-policy.test.mjs` ⑧ |
| I-4.3 revoke ≠ hold | `mandate-policy.test.mjs` ① |
| I-5.1 状态与事件同事务 | `audit-events.test.mjs` ①④ |
| I-5.2 事件不触发派工 | `event-log.test.mjs` ⑥ |
| I-5.3 游标单调不重放 | `event-log.test.mjs` ③④ |
| I-5.4 重复事件忽略 | `event-log.test.mjs` ②、`audit-events.test.mjs` ③ |
| I-5.5 对账只读 | `event-log.test.mjs` ⑤、`decisions-routes.test.mjs` ⑧ |
| I-6.1 配额 + 借槽 | `goal-share.test.mjs` ④⑤、`claim-admission.test.mjs` ④⑤ |
| I-6.2 借槽必须过期并留痕 | `goal-borrow.test.mjs` ③④ |
| I-6.3 配额不碰 gate | `goal-share.test.mjs` ⑦ |
| I-7.1 只 explicit 可抢 | `preemption.test.mjs` ④、`preemption-routes` ③ |
| I-7.2 抢占必须留说明 | `preemption.test.mjs` ⑧、`preemption-routes` ① |
| I-7.3 保留槽只给人 | `preemption.test.mjs` ⑦、`claim-admission` ②③ |
| I-7.4 防活锁 + 告警 | `preemption.test.mjs` ⑥、`preemption-routes` ⑤ |
| I-8.1 reason 必须是枚举 | `blocking.test.mjs` ①、`blocking-routes` ⑤ |
| I-8.2 解释接口只读 | `blocking.test.mjs` ⑧、`blocking-routes` ⑥ |
| I-9.1 active 必须人晋升 | `regression-store.test.mjs` ④、`regression-routes` ④ |
| I-9.2 聚类键稳定 | `regression-store.test.mjs` ① |
| I-9.3 P0 必须有 active 用例 | `closure-check.test.mjs` ②③④ |
| I-10.1 影子跑不写 | `shadow-report.test.mjs` ⑥、`shadow-report-routes` ③ |
| I-10.2 差异超阈值需评审 | `shadow-report.test.mjs` ④ |
| I-11.1 基线只能人写 | `regression-gate.test.mjs` ② |
| I-11.2 退化要说清四要素 | `regression-gate.test.mjs` ⑤ |
| I-11.3 门没有 force | `regression-gate.test.mjs` ⑦ |
| 启动期迁移幂等 | `schema-idempotency.test.mjs`（11 条） |

### 11.3 开关与回滚

| 能力 | 开关 | 关掉之后 |
| --- | --- | --- |
| 认领准入（保留槽 + 目标配额） | `LEGION_CLAIM_ADMISSION=1`（默认**关**） | 认领行为与今天完全一致 |
| 授权强制 | `LEGION_MANDATE_STRICT=1`（默认**关**） | 只记账不拦截 |
| `@` 追加 / 升级 | `appendTaskNote` 单点；无 @ 走原分支 | 无 @ 即今天的行为 |
| 事件流 | 只加列与只读接口 | 不调 `/api/reconcile` 即可 |
| 回归门 | CI 里是否调用 `check-baseline.mjs` | 不调用 = 只报告不拦截 |
| **认领顺序（已决定先开）** | `LEGION_GOAL_SHARE=1`（+ 可选 `LEGION_GOAL_SHARE_DEFAULT=0.5`） | 关闭后回到 `priority × createdAt` |

**启用 `LEGION_GOAL_SHARE` 的操作口径**（2026-11-03 决策：先只开这一个）

它读取的是**守护进程的环境变量**，不是仓库里的配置文件——所以必须在启动 DSH/守护的那个环境里导出：

```powershell
# PowerShell（当前会话）
$env:LEGION_GOAL_SHARE = '1'
$env:LEGION_GOAL_SHARE_DEFAULT = '0.5'   # 单目标默认份额，可省略
```
```bash
# bash / CI
export LEGION_GOAL_SHARE=1
export LEGION_GOAL_SHARE_DEFAULT=0.5
```

生效后只改**认领顺序**（缺口大的目标先跑），不拒任何任务；要回滚就删掉这个变量重启守护。
验证方式：同一空间造两个不同目标的 todo 任务、只留 1 个空槽，观察先被认领的是"在跑数更少的目标"那个；
再看 `GET /api/tasks/:id/blocking` 的 `reason` 分布是否仍以 `slot` / `fileDomain` 为主。

回滚粒度都是"关开关"或"不调用某个脚本"，**没有需要回滚的库结构变更**（除 `tasks.comments` 的 B 段删列，那是最后一步、可延后）。

### 11.4 剩余两项（有理由，不是遗漏）

1. ~~**F6 排序接线**~~ ✅ 已完成：`plugins/src/claimOrder.ts`（缺口→priority→createdAt、权重、不改集合）+ 接进 `stateMachine.runRound` 的 todo 遍历，开关 `LEGION_GOAL_SHARE=1`（默认关）。判据 `plugins/tests/claim-order.test.mjs` 6/6。
2. **F0 B 段删列**（唯一剩余）：**实测 165 处**读取点（不是早期估算的 65——用
   `node team-hub/scripts/comment-column-readers.mjs` 扫描 657 个文件得出，含 `文件:行` 清单）。
   过渡期的同事务同步列已保证读取零改动，**删除是纯清理、收益小于风险**，故延后为技术债。
   什么时候可以删：该脚本 `count < 5`（`readyToDrop=true`）时。

### 11.5 验收命令（可复现）

```bash
# team-hub：本设计新增/影响的 38 个套件
cd team-hub && node --test task-input.test.mjs task-input-routes.test.mjs task-input-migration.test.mjs \
  task-report.test.mjs task-report-routes.test.mjs task-resume.test.mjs task-stage.test.mjs \
  mentions.test.mjs mention-routes.test.mjs mandate-policy.test.mjs decisions.test.mjs decisions-routes.test.mjs \
  acceptance.test.mjs policy-rules.test.mjs policy-rules-routes.test.mjs accept-mode.test.mjs \
  event-log.test.mjs audit-events.test.mjs weekly-report.test.mjs closure-check.test.mjs \
  regression-store.test.mjs regression-routes.test.mjs goal-share.test.mjs goal-borrow.test.mjs \
  goal-share-routes.test.mjs claim-admission.test.mjs preemption.test.mjs preemption-exec.test.mjs \
  preemption-routes.test.mjs blocking.test.mjs blocking-routes.test.mjs shadow-report.test.mjs \
  shadow-report-routes.test.mjs regression-gate.test.mjs schema-idempotency.test.mjs \
  claim-policy.test.mjs claim-policy-question-gate.test.mjs merge-open-questions.test.mjs comment-routes.test.mjs

# 认领准入接线（需在独立进程里开开关）
cd team-hub && node --test claim-admission-routes.test.mjs

# plugins：守护侧
cd plugins && node --test tests/report-settlement.test.mjs tests/report-payload.test.mjs \
  tests/comment-intent.test.mjs tests/stateMachine.test.mjs tests/acceptance.test.mjs \
  tests/timeout-settlement.test.mjs tests/handoff.test.mjs tests/multi-space.test.mjs

# 迁移与对账工具（对真实库先 dry-run）
node team-hub/scripts/migrate-task-input.mjs --dry-run
node team-hub/scripts/merge-open-questions.mjs --dry-run
node team-hub/scripts/reconcile-events.mjs
node team-hub/scripts/regression-candidates.mjs --top=5
node team-hub/scripts/check-baseline.mjs
```

### 11.6 已知偏差（当时就地记录，未粉饰）

- `dropped` 落 `canceled` 而非 `done`：`done` 只有将军能写（`taskctl:527-532`）。
- `waiting` 留在 `in_progress`、不发消息：Legion 没有 `idle` 态。
- `plugins/tests/worker-regression.test.mjs` 本机**存量失败**（10s 超时）；已 `git stash` 对照确认与本次改动无关。
  **2026-11-03 已加环境守卫**：缺完整 agent 链路时 15 条用例显式 `skip`（`pass 0 / fail 0 / skipped 15`），
  恢复条件 = 设 `LEGION_AGENT_CHAIN=1` 且中枢可真实派发 agent。理由：**假红点会掩盖真回归**。
- `mentions.mjs` 与 `commentIntent.ts` 是**两份规则**（两个包之间无运行时依赖，DEC-2），变更需同时改两处。
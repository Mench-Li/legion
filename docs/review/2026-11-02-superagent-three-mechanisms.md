# 三机制深挖：注意（Attention）/ 评估（Eval）/ 事件（Source·Trigger）

日期：2026-11-02 ｜ 对象：`dsh-superagent-prototype` HEAD `6337fc8` vs Legion（`team-hub` / `plugins/src` / `scrum`）
证据分级：**[实证]** 读过代码并给 file:line；**[推断]** 由相邻证据推出；**[待核]** 需一次验证。

---

## 0. 三句话结论

1. **注意机制**：Legion 有"半个"——`❓ 待将军确认` 是**提示词约定**（`plugins/src/index.ts:2177`、`:3422`），superagent 把它做成**对象**（`core/model.ts:275`）。差别不是有没有问，而是**能不能派生状态、绑定回答、统计噪音**。
2. **评估机制**：Legion 的评估器就是将军本人（模型），没有规则集、没有 `wouldAccept` 记录；superagent 把"谁能发起"（确定性 gate）与"值不值得做"（模型研判，逐条规则判）分开，并**记录"没做"**。
3. **事件机制**：Legion 的事件是**观测面**（SSE + audit，给人看），superagent 的事件是**输入面**（Trigger，能开工）。缺的中间件是三样：**身份、读位、订阅**。

方法论差异一句话：**Legion 用约定（提示词 + 前缀），superagent 用契约（字段 + 拒收）**。

---

## 1. 注意机制（Attention）

### 1.1 superagent 的五段结构 [实证]

| 段 | 做法 | 证据 |
| --- | --- | --- |
| ① **结构化地问** | worker 报告里带 `question` 字段；`report()` 校验：有 `question` 就不能同时是 `ready`/`answers`，`askedBy` 必须指向一个**真人且已送达**的 Trigger | `core/assignments.ts:102-109` |
| ② **对象化** | `interface Attention { id; question; triggerId? }` 挂在工单上；问句变了就换 id，旧的中继回复**撤回** | `core/model.ts:275`、`core/assignments.ts:114-121`、`core/replies.ts:47` |
| ③ **状态由此派生** | 阶段判定第一优先：有 attention → `person / answer`（"第一次匹配即胜"） | `core/stage.ts:12`、`docs/003-execution.md:5-19` |
| ④ **中继给主 Session，而不是刷屏给人** | `progress` 且无 `answers` 的例行报告**不外发**；问句发 `worker_attention`，结果/受阻/结束发 `worker_report` | `app/notices.ts:121-128` |
| ⑤ **回答必须对得上问句** | 回答要带 `human_action` = 工单**当前**的问句文本，否则工具直接拒收（`notAttention`）；"日常未完成的工作只在内部保留" | `app/tools/main.ts:225-230`、`core/errors.ts:33`、`core/replies.ts:75-77` |

配套还有两条**注意力经济**的硬规则：后台任务在 30 分钟内必须收尾并报告"谁被杀了"（`docs/003-execution.md:33-35`）；交回给人时**立即释放 worker 槽**（`:37`）。

### 1.2 Legion 现状 [实证]

| 现有物 | 证据 | 性质 |
| --- | --- | --- |
| 士兵在 JSON 报告里写 `blocker`，每条以 `❓ 待将军确认` 开头 | `plugins/src/index.ts:2177` | **提示词约定** |
| 守护把它转成任务评论 + `blocked` | `plugins/src/index.ts:3422-3425` | 有落点，无结构 |
| 预算耗尽也走 `❓` 评论 | `plugins/src/index.ts:2256` | 同上 |
| 设计稿自评 | `docs/design/legion-agent-orchestration-design.md:33`（#16） | "部分：`blocked` + ❓ 评论，无独立状态与事件" |

### 1.3 差距（不是"有没有问"，是四条能力）

| 能力 | superagent | Legion |
| --- | --- | --- |
| 从"在等人"派生状态 | 有（`person/answer`） | 无（`blocked` 里混着"等答""等评审""卡死"） |
| 回答绑定到具体问句 | 有（文本必须相等，变了就撤回） | 无（评论谁都能答，答了算不算也不确定） |
| 噪音闸 | 有（progress 不外发；无 `human_action` 拒收） | 无（`❓` 写多写少全凭士兵） |
| 注意力统计 | 有（面板只列"需要人"的，健康态不占位） | 无（`blocked` 计数不分原因） |

### 1.4 最小移植（3–4 天，纯增量）

1. **字段化**：在士兵报告的 JSON 里加
   ```jsonc
   { "status": "blocked",
     "attention": { "question": "验收口径是 A 还是 B？", "options": ["A","B"], "askedBy": "T-123/comment-7" } }
   ```
   守护做**拒收**：`blocked` 但无 `attention` → 报告不通过（等价 `notAttention`）。
2. **状态派生**：任务阶段表加一档 —— 有 `attention` → `awaiting_answer`；`blocked` 无 `attention` → `stuck`。**只加派生，不改流转**（沿用 `claim-policy` 的 `holds()` 形态：一份 SQL + 一份纯函数）。
3. **回答绑定**：将军/用户答复时必须带 `answersAttention: <attention.id>`；与当前 id 不符 → 400。回答后 attention 清除、任务回 `todo` 续跑。
4. **噪音闸**：`progress` 类报告不入时间线（只在任务详情页），`blocked/stuck/ready` 才进 `/api/events`。

---

## 2. 评估机制（Eval）

### 2.1 superagent：两层 + 记账 [实证]

| 层 | 做什么 | 证据 |
| --- | --- | --- |
| **Gate（确定性）** | 谁能发起：名单、bot 名单、准入表三格、强度 explicit/inferred；非名单者默认 ignore | `docs/002-authorization.md:56-75` |
| **Assessment（模型）** | 对**每条启用的规则逐条判一次**（命中不命中都要判）；"主动受理至少要命中一条规则" | `docs/002-authorization.md:101` |
| **Decision** | accept / stop / ignore / unavailable 四值，ignore 还有 `ignoredFromCard`（卡片一看就无关，直接忽略） | `docs/002-authorization.md:87-89`、`001-domain.md:109` |
| **三个保守档** | `off` / `observe`（只记"本会接受"）/ `auto` | `docs/002-authorization.md:94-101` |
| **失败也算结论** | 连续超时三次记 `unavailable`；面板只在 24 小时内、且是最后一条决定时才打扰人 | `docs/002-authorization.md:147-155` |

### 2.2 Legion 现状 [实证]

| 现有物 | 证据 | 性质 |
| --- | --- | --- |
| "这活该不该开"由**将军这个模型**判断 | `COMMAND.md:31`（从 backlog 挑 2–5 个） | 评估器 = 模型，无规则集 |
| 认领资格是确定性代码 | `team-hub/claim-policy.mjs:64-104` | **这是 gate，但管"能不能领"，不管"该不该开"** |
| 规则以文本存在（分层） | `LEGION.md:56-59`、`team-hub/routes/rules.mjs` | 是**行为规范**，不是受理规则集 |
| 动作级权限内核 | `docs/F02-PERMISSION-GOVERNANCE.md:1-13` | 管"能不能做这个动作" |
| 自动化：定时 + 重叠策略 + 补跑 + 等审批 | `team-hub/automation-store.mjs:1-40` | **定时触发**，不是事件触发；规划质量很高 |
| 无受理记录 | `team-hub/server.mjs` 与 `routes/*.mjs` 内无 `requested_by` / `mandate` / `wouldAccept`（grep 0 命中） | **缺口** |

### 2.3 差距

- **没有"规则集"这个对象**：Legion 的规范是给人/给模型读的散文，没法"逐条判一次"，也没法回答"这个任务依据哪条规则被受理"。
- **没有"没做"的记录**：将军没挑某个任务，这件事不留痕；superagent 的 `ignore` + `wouldAccept` 正是这个。
- **没有三档信任**：Legion 只有"开/不开"，没有"先记着不做"。

### 2.4 最小移植（3–5 天）

1. **规则对象化**：`rules` 表加一列结构化，或新建 `policy_rules` 表：`{ id, kind: 'always'|'when'|'never', text, scope, enabled }`。**不改现有规范文本**，只在受理时引用其 id。
2. **受理台账**：新增 `decisions` 表：`{ taskId?, trigger, kind: accept|stop|ignore|unavailable, matchedRules[], wouldAccept, by, at }`。将军挑任务时调用一次 `POST /api/decisions/accept`（`basisRuleIds` 必填或显式 `manual`）。
3. **`observe` 档**：将军本来不挑的候选（例如新出现的 bug 报告、CI 红灯），先只写 `wouldAccept: true` 的决策，不进看板。**两周数据决定是否放开**。

---

## 3. 事件机制（Source / Trigger / Thread / Subscription）

### 3.1 superagent：一个 Source 是 8 个钩子的契约 [实证]

`src/sources/kind.ts:85-110` 定义 `SourceKind`：

| 钩子 | 作用 |
| --- | --- |
| `schema` / `fields` | 配置与面板表单 |
| `health` | 该来源独有的健康条目（别的模块不得占用） |
| `scope()` | **收听规则**：这条事件算不算"对我说" |
| `channel` | 写回适配器（`send` 幂等，返回 `'sent' | 'gone'`） |
| `threadContext` | 有界上下文读取（线程/根/父消息 + 图片），供评估用 |
| `policy` | 名单 + 准入表行 + 可选的外部名录同步 |
| `find` / `repliesTo` / `refreshLabels` | 搜索、回复关系、显示名刷新 |

配套的**事件语义**（这才是"一级事件机制"的实质）：

| 语义 | 做法 | 证据 |
| --- | --- | --- |
| 不可变 + 幂等 | Trigger 不可变；"同一个 Trigger 受理两次只产生一个工单" | `docs/001-domain.md:28` |
| 读位 | Source 持有自己的读位；重启不得重放 | `docs/001-domain.md:27` |
| 时间回退 5s | 轮询起点前推 5 秒，防迟到事件；确定性 Trigger ID 去重 | `sources/poll.ts:15-16` |
| 订阅 + 地平线 | 订阅线程在"最后事件 or 工单结束"后 **14 天**内继续轮询 | `sources/poll.ts:5-14` |
| 逐线程错误 | 单线程失败挂在 Thread 上（`pollError`），成功即清；连续三次才升级为来源级错误 | `sources/poll.ts:17-31`、`docs/003-execution.md:164-174` |
| 去向记账 | 每条 Trigger 有 Disposition（filtered / evaluated / fanned out） | `docs/001-domain.md:102` |
| 订阅 ≠ 授权 | 订阅线程的消息可续跑，但**不扩权** | `docs/001-domain.md:37` |

### 3.2 Legion 现状 [实证]

| 现有物 | 证据 | 性质 |
| --- | --- | --- |
| SSE 公开事件流：`scope` + `seq` + `Last-Event-ID` 增量回放 + 去重 | 设计稿 #14 已落地；`team-hub/event-delivery.mjs:1-18` | **观测面**：给人/UI 看 |
| 投递状态机（pending/delivering/…/unknown） | `event-delivery.mjs` | 投递可靠，与"能不能开工"无关 |
| 定时自动化（重叠策略/补跑/等审批） | `automation-store.mjs:1-40` | **定时触发**，不是事件触发 |
| 无入站 webhook | `team-hub/*.mjs` + `routes/*.mjs` grep `webhook` = 0 命中 | **无外部事件入口** |
| 事件不完整 | 设计稿 #13：gate / 集成 / 确认停止 / 工具失败**不入** audit | 观测面本身有洞 |

### 3.3 差距：三件中间件

| 缺什么 | 后果 |
| --- | --- |
| **身份**（actor） | 一条评论是谁说的？人 / bot / CI？没有身份就无法做准入，只能人看 |
| **读位** | 没有"读到哪了"，所以外部事件要么全量重扫、要么漏；SSE 的 seq 是给客户端的游标，不是来源的读位 |
| **订阅** | 没有"这个任务关注这条线程"，所以线程后续讨论不会回流；三周后的问题只能靠人重新开卡 |

### 3.4 移植路径（不建议照抄 superagent，建议抄契约）

Legion 的事件源不是 GitHub 通知，而是**它自己的对象变化**（任务评论、CI/验证结果、交付回执、目标状态）。所以正确形态是：

1. **定义 `LegionEvent`**（不可变）：`{ id, kind, actor: {kind:'user'|'general'|'soldier'|'ci'|'bot', id}, subject: {taskId|goalId}, at, payload }`。
2. **加读位**：`event_cursor` 表（每个消费者一行），`seq` 已有（`audit.seq` 事务内单调）→ **直接复用，不要新造**。
3. **订阅 = 任务的关注集合**：任务的 `fileDomain` 已经有了，再加 `watches: [{ kind, subjectId }]`；匹配的事件按"订阅≠授权"处理：可续跑、不扩权（照抄 `docs/001-domain.md:37` 这条规则）。
4. **评估入口**：一个 `evaluate(event)` 纯函数 → `{ admit | wouldAccept | ignore }`，与 §2 的决策台账共表。
5. **不做**：不做通用 webhook、不做第二套调度源（沿用设计稿 `:49` 的约束）。

---

## 4. 三者怎么串起来

```
外部/内部对象变化 ──(身份/读位/订阅)──▶ 事件
                                        │
                                   评估(规则集) ──▶ 决策台账(accept/ignore/wouldAccept)
                                        │
                              授权(Mandate, §上一份报告) ──▶ 任务卡
                                        │
                                    执行(attempt/租约/文件域)
                                        │
                            报告(结构化 state + question 字段)
                                        │
                     ┌──────────────────┴──────────────────┐
              有 question → attention 对象 → 等人 → 回答绑定 → 续跑
              无 question → progress 内部保留 / ready·blocked 才外发
```

**三者是一件事的三个面**：事件是入口，评估是闸门，注意是出口。Legion 现在**中间那层最完整（执行），两头都是约定而不是契约**。

---

## 5. 落地顺序（建议）

| 步 | 内容 | 成本 | 验收 |
| --- | --- | --- | --- |
| 1 | `attention` 字段 + 拒收 + 状态派生 | 3–4 天 | `blocked` 无 `attention` 报 400；`awaiting_answer` 可从 SQL 派生；回答 id 不符报 400 |
| 2 | 决策台账 + `policy_rules` | 3–5 天 | 每条新任务有 `basisRuleIds` 或 `manual`；`wouldAccept` 可查 |
| 3 | `LegionEvent` + 复用 `audit.seq` 做读位 + 任务 `watches` | 5–7 天 | 评论事件能按 `watches` 回流到任务；不回流的进"未受理"台账 |
| 4 | `observe` 跑两周再放开 `auto` | 0 | 誤判率与噪音条数 |

**不建议**在第 1 步之前碰事件层——没有 attention 对象，事件回流进来也无处安放。

---

## 6. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 注意力通胀 | 一旦 `attention` 好用，士兵会大量提问 | 拒收 progress；每任务同时只允许**一个**未答 attention（superagent 同款） |
| 评估抖动 | 规则集让将军"逐条判"，可能把简单任务判复杂 | 保留 `ignoredFromCard` 快路：卡片明显无关就跳过逐条判 |
| 事件风暴 | 评论/CI 全进事件流会让评估排队 | 事件层先只做"记账 + 不入队"，与 `observe` 同步放开 |
| 双读位 | SSE 的 seq 与事件读位混用会乱 | 同一张 `audit` 表、同一个 seq，禁止新造计数器 |
| 与 `blocked` 语义重叠 | `awaiting_answer` 与 `blocked` 并存易混 | 明确：`awaiting_answer` ⊆ `blocked`，是子状态不是并列状态 |

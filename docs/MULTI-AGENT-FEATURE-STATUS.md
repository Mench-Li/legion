# F-01～F-25 对照表与实施顺序

> 本文是 [`MULTI-AGENT-FEATURE-OPTIMIZATION.md`](./MULTI-AGENT-FEATURE-OPTIMIZATION.md)
> 那份优化清单的**落地对照**：每一条 F-xx 在今天的代码里落在哪、判据是什么、
> 还差什么。
>
> 它与 [`superpowers/prt/PRT-PROGRESS.md`](./superpowers/prt/PRT-PROGRESS.md) 的关系：
> PRT-PROGRESS 记录 spec §12 那 **145 项**的权威状态；本文记录**优化清单**
> 那 **25 条**的现状。两者**不是同一份清单**——这正是本文存在的理由：
> 优化清单里有一部分（F-05、F-16、F-17、F-21、F-23、F-25）在 145 项里
> **没有任务号**，因此它们不会出现在任何进度表的"未完成"栏里。
>
> **状态口径**（与 PRT-PROGRESS 同一份）：
> - ✅ **已闭合**：有代码落点 + 可复跑的判据。
> - 🟡 **部分**：交付物已落地但完成标准未全部满足（必须写明缺哪一条）。
> - ⬜ **未实现**：代码里不存在。
> - ⏸ **需外部输入**：真人裁决、真实凭据或另一台机器。
>
> ⚠️ 沿用 PRT-PROGRESS 那条告警：**「有用例」不等于「已生效」**。
> 只有自己的用例驱动的原语一律 🟡。

---

## 0. 先说结论：优先级是怎么定的

优化文档自己的 §1.1 校准（2026-09-16）给出的判断是：

> 因此当前最准确的产品判断是：**Runtime 边界已经从设计进入可测试实现，
> 但 Product Runtime 尚未完成商业化闭环。** 后续功能应优先围绕**阶段 2 收口**
> 和**阶段 2.5 薄垂直切片**，而不是把 P1/P2 功能全部提前扩张。

所以顺序不是按 P0 → P1 → P2 铺开，而是按**"能不能被一次真实运行证伪"**排：

| 序 | 做什么 | 为什么排在这里 |
|---|---|---|
| 1 | 关掉 P0 里**纯代码、无外部依赖**的缺口（F-05 前后半） | 它是优化文档自己点名的缺失，且判据完全在仓内 |
| 2 | 阶段 2 收口里的加固项（PRT-509 B1/B2、PRT-214、PRT-253） | 这些是"能力齐全但生产调用方数为 0"的缺口——见下面 §2 |
| 3 | 阶段 2.5 薄垂直切片（单员工黄金任务） | 需要真实凭据/模型，属 ⏸ |
| 4 | P1 里**不依赖外部输入**的（F-16 调度、F-17 压缩） | 纯代码，且是"没有它就没有产品形态"的功能 |
| 5 | P1/P2 其余（F-15 用量收口、F-18～F-25） | 多数需要外部裁决或客户需求 |

**排序的依据是一条可检验的判据，不是主观偏好**：排在前面的每一条，都能用
"把这段代码删掉，有哪个用例会变红"来验证它真的被接线了；排在后面的那些，
删掉之后用例仍然全绿——因为它们**只有自己的用例**。

---

## 1. P0：执行契约与编排

| 编号 | 名称 | 状态 | 代码落点 | 判据 / 证据 | 还差什么 |
|---|---|---|---|---|---|
| F-01 | Runtime Contract | ✅ | `runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs` | PRT-101～109；套件 `runtime-contract`（13 例）、`contract.test.mjs` | — |
| F-02 | DshRuntimeAdapter | ✅ | `runtime/adapters/dsh/*` | PRT-201～206；套件 `dsh-adapter`（25 例） | — |
| F-03 | Runtime Manager | ✅ | `product/runtime-state.mjs` | `RUNTIME_STATES` / `CLAIM_POLICY` / `runtimeStatusReport()`；PRT-711 认领闸门 | — |
| F-04 | Orchestrator Core | 🟡 | `orchestrator/worker/*`、`team-hub/run-store.mjs`、`orchestrator/{acceptance,pipeline,workspace}/` | PRT-301～316。★ **不在这里复制那份计数**——逐条状态见 [`superpowers/prt/PRT-PROGRESS.md`](./superpowers/prt/PRT-PROGRESS.md) 台账（那是权威）。此处曾写着一份手抄的四列合计（已完成 143、部分 19、未开始 1、需外部输入 2），而台账当时的真实读数是 **145 行 = 已完成 138、部分 4、未开始 1、需外部输入 2**：**它对不上**，且**没有任何门禁会去核对它**（`check-docs` 只管 `README.md` 与 `docs/FEATURES.md`）。一个手抄的计数与一份会漂移的计数是同一个东西，只不过前者的读者会以为它被核对过——现已改为不复制，并由 `scripts/prt/progress-check.test.mjs` 用例 ⑥ 钉住 | `plugins/src/index.ts` 仍是主要编排热点（§1.1 的判断）；**PRT-316 是台账里唯一的 ⬜**，且它是**排期规则**没到（`0db37af` = 2026-09-10，一个发布周期 = 14 天 ⇒ 最早 **2026-09-24** 可启动），不是"没事可做" |
| F-05 前半 | 运行明细作为可持久化 RunEvent | ✅ | `team-hub/run-store.mjs`（`run_events`）、`orchestrator/worker/{executor,main}.mjs`、`server.mjs` | `team-hub/run-events.test.mjs`（18 例） | 明细**不进** `/api/events`（刻意：不新增第二条公开流） |
| F-05 后半 | 可靠事件与投递状态机 | ✅ | `team-hub/event-delivery.mjs`、`server.mjs`（`broadcastAudit` 重写、 `/api/event-delivery`） | `event-delivery.test.mjs`（31 例）+ `event-delivery-wiring.test.mjs`（7 例真 HTTP） | — |
| F-06 | Run 状态机 / 验收 / 交接 | ✅ | `team-hub/run-store.mjs`、`orchestrator/acceptance/`、`orchestrator/pipeline/` | PRT-307/308/309/310/311/312 | — |
| F-07 | 上下文快照 | ✅ | `runtime/context/*`、`team-hub/context-store.mjs` | PRT-401～409；套件 `context-store`、`context-export`、`context-retention` | — |
| F-08 | 模型档案与绑定 | ✅ | `team-hub/model-store.mjs`、`binding-store.mjs`、`probe-service.mjs` | PRT-501/502/506/507 | — |
| F-09 | 密钥库与 Run 凭证 | 🟡 | `security/secrets/*`、`product/secrets.mjs`、`product/launcher/{secrets-check,run-credential*,secrets-acl-runner}.mjs` | PRT-505/509；`secrets-acl-runner.test.mjs`（12 例，含真 `whoami`+`icacls`） | 见 §2「本轮已关掉的」；**C1～C4 是产品裁决**，属 ⏸ |
| F-10 | 权限、审批与审计 | ✅ | `team-hub/permission-engine.mjs`、`approval-*.mjs`、`context-plan-store.mjs` | PRT-601～607 | — |
| F-11 | DSH 强制面（hard floor / sandbox / preset） | 🟡 | `runtime/dsh-composition/*` | PRT-213/214/253 的一部分 | 见 §2；G1/G4、G2/G3/G4/G6 需人裁决。★★ **另有一条本轮新发现（§5.2）：三道范围检查在生产里从未被注入**——`enforcementSurfaces()` 实测 `pathScope:false` / `whitelist:false`，`execution-scope`/`external-api-scope` 连端口都没有。这不是"F-11 没做"，而是"做了但没装上"；裁决见 §5 第 14 条 |
| F-12 | Product Launcher | ✅ | `product/launcher/*` | PRT-701～713 | — |
| F-13 | 配置与诊断 | ✅ | `product/config-schema.mjs`、`scripts/config/scan.mjs` | `scan --check`（1065 个疑似字面量）、`config sync`、`encoding-check` | — |
| F-14 | 安装、升级、回滚 | ✅ | `product/launcher/runtime-install.mjs`、`runtime/packs/*` | PRT-801～813、PRT-1001～1006 | — |

## 2. 本轮（2026-09-17）关掉的缺口

> ⚠️ **一次自我更正**：本表此前把 F-20 记成 ✅、把 F-19 的名字写成"知识库"。
> 两条都是错的——F-19 的原文是 **Employee / Role Pack**（§4.4），而 F-20 的
> "安装可回滚 + team-hub 保存安装事实"**一件都没有**（`rollback` 在
> `store.mjs` 里明写"不走这里"，store 自陈纯内存，hub 侧无表无路由）。
> 这正是本表存在的理由：**一份把"有用例"读成"已生效"的进度表，
> 与一份把未完成读成完成的进度表，是同一个东西。** 现已按读数改正。

这几条的共同形状是 **"能力齐全、用例全绿、而生产调用方数为 0"**：

| 缺口 | 改动前的实际读数 | 关掉它的判据 |
|---|---|---|
| F-05 前半 | 13 种契约事件里 **11 种读完即弃**（`executor.mjs` 的 `else` 什么都不做） | `run-events.test.mjs` 18 例；三条出口都带明细 |
| F-05 后半 | `broadcastAudit` 丢掉 `res.write` 返回值 ⇒ 读数是"发过了" | `event-delivery*.test.mjs` 38 例；`delivered` 只能 CAS 得到 |
| F-16 | 能力**完全不存在**（grep `skipOnOverlap`/`scheduleStore` 零命中） | `automation-store.test.mjs` 27 例 + `automation-http.test.mjs` 9 例 |
| F-17 | 能力**完全不存在**（grep `compact` 零命中） | `compaction-store.test.mjs` 14 例 + `compaction-http.test.mjs` 5 例 |
| F-15 | 闸门齐全而**汇总不存在**（grep `evidenceAggregate`/`rollup` 零命中）：`budget-ledger` 记了 `usage_records`，但"按员工花了多少"没有一个读出口 | `usage-rollup.test.mjs` 12 例 + `usage-rollup-http.test.mjs` 6 例 |
| PRT-509 B1 | `secretsRun`/`secretsOwner` 全仓只有声明与传参两处，**没有生产调用方** ⇒ 恒为 `ACL_NO_RUNNER` | `secrets-acl-runner.test.mjs` 12 例（含真 `whoami`+真 `icacls`） |
| PRT-509 B2 | `inspectSecretsAcl` **定义在、有注释、零调用方**（比调用点少 `owner`/`exists` 两参 ⇒ 调用点各内联一份 `inspectFileAcl`） | `secrets.test.mjs` 用例 ⑧：1 条结构级 + 2 条行为级，两条行为级已**变异验证** |
| F-20 缺口① | 账里**没有回滚**：`upgrade()` 注释写着"降级是另一个操作（回滚）"，而那个操作不存在——需要回滚的人两条路都被堵（`install` 报 `ALREADY_INSTALLED`、`upgrade` 报 `NOT_AN_UPGRADE`） | `store.test.mjs` 用例⑦（8 条），两条关键守卫已**变异验证** |
| F-20 缺口② | 账**纯内存**（`store.mjs` 第 129 行自陈）⇒ 重启即失忆，"现在装了什么"永远回答"什么都没装" | `store.test.mjs` 用例⑧（5 条）：快照/重建/seq 接着走/坏账整本拒绝；"整本拒绝"已**变异验证** |
| F-20 缺口③ | team-hub **没有安装事实**（无表、无路由）⇒ 控制面重启后依赖预检拿一份空基线，每个包都突然报"缺依赖" | `pack-facts.test.mjs` 19 例 + `pack-facts-http.test.mjs` 8 例（含**跨模块实例**重建、seq 的 CAS、账只追加）；seq 的 CAS 已**变异验证** |
| F-19 缺口① | 七类版本**没有落点**：`EmployeeManifest` 只是上下文来源，没有任何模块承载"这个岗位被冻结成哪一版" | `role-pack.test.mjs` 40 例（含对账两种漂移、嵌套强制面、连接器凭证），6 处守卫已**变异验证** |
| F-19 缺口② | 冻结产物**算完即丢**（纯内存）⇒ "上周那个岗位是哪一版"永远回答不了 | `role-pack-store.test.mjs` 25 例 + `role-pack-http.test.mjs` 10 例（含 409 **真的走得到网络上**）；6 处守卫已**变异验证** |
| F-21 | 四条能力**全部不存在**（grep `connector`/`mcp` 在产品代码里零命中）：没有工具级策略、没有风险分级、没有密钥引用、没有故障隔离 | 能力已建（`registry.test.mjs` 31 例 + `connector-store.test.mjs` 22 例 + `connector-http.test.mjs` 11 例真 HTTP；**30 处守卫全部变异验证**）。★ 途中抓到 4 个真缺陷（能力名兜底成最严、凭证检查只看自己认识的字段、刚失败却报 healthy、`version` 参数被静默忽略），详见 §4.1。⚠️ **但判定面仍没有生产调用方** ⇒ 如实记 🟡，不记 ✅ |

一条值得单独记下的判据：**F-05 后半的三条设计纪律各自对应一个真实的失效方向**，
因此它们在用例里是**分开**验的，而不是合并成一句"投递可靠"：

- `delivered` 只能由 CAS 从 `delivering` 得到 —— 应用层的 `if` 在并发下会各查各的；
- `suppressed` 必须带封闭词表里的原因 —— 自由文本会让"跳过"退化成一句备注；
- 崩溃只能落 `unknown` —— 说 `delivered` 是谎报可见性，回 `pending` 是重投一个
  可能已经到达的事件。

同一个形状在 F-16 与 F-17 上各出现一次，因此这两条的判据也是**按失效方向拆开**的：

- **F-16**：日历投影**必须是纯函数**（用例⑦的判据是"打 100 次投影，`automation_runs`
  一行都不多"——一个"把视图当成计划"的日历，会让"上个月跑了 400 次"里有 380 次
  是**有人翻过日历**）；时区名写错必须**抛**而不是回落服务器本地时区
  （回落时计划每天都会成功，只不过跑在错的时间上）；跳过必须**留下行**
  （不记账时"它没被触发"与"它被跳过了"在历史里长得一样）。
- **F-17**：原文**只追加**（用例②的判据锚在 `SET` 子句上，而不是匹配
  `state = 'active'` —— 那会命中 `WHERE` 读屏障，一条会对着正确代码报警的守卫，
  与一条不存在的守卫，在被人手动关掉之后是同一个东西）。

**F-15 与 F-16 各有一个"看起来更好读、实际更坏"的写法**，两条都写进了判据：

- **F-15**：五个维度里每一个数字都有一个**"不知道"的邻居**，而把它们合并成
  一个读数是这类报表最典型的失效——`SUM()` 把 `NULL` 当 0 加进去之后，
  "这次运行没采集到 token"与"这次运行确实用了 0 个 token"在同一格里；
  缺价的金额被算成 0 会**低估总成本**，而总额看上去完全正常。
  所以每一行都带 `tokensUnknownRecords` / `amountUnknownRecords`，
  未结束的 Attempt 单列 `inFlightAttempts`（用 `now - created` 顶替会把
  "卡住了"画成"正在跑"），混币种时 `currency` 报 `null` 且 `mixedCurrency:true`
  （替调用方换算需要汇率，而汇率是一个会随时间变的外部事实）。
  另有一条**第一版真的写错**的：耗时按 Attempt 算，不许 JOIN 到
  `usage_records`——一条 Attempt 记 N 笔账就会被算 N 次，
  而"每条恰好记一笔"的那个月里完全看不出来（用例⑦与结构级用例⑫钉住它）。
- **F-16**：`payload` 的**三态**必须分开。`null` 同时表示"不改"与"清掉"时，
  用户想把一条计划从"建任务"改成"只提醒"，那次调用**什么都没改**、
  界面显示成功、计划继续建任务；而 `payload` 透传会开一条绕过
  `createTaskInTx` 的路（`payload.status='done'` 直接写进任务行，
  那里"初始状态只能 backlog/todo"的校验被跳过）。
  没配 `payload` 时**只物化、不建任务**，且这不是错误——
  建一个标题为空的占位任务会让 worker 领到一张只能靠猜的卡。

### 2.1 关于"基线漂移"这件事

本轮新增 4 张业务表 + 10 张（含 F-05 的 2 张）协议表与 20 条路由，
因此 `scripts/prt/baseline-snapshot.mjs` 的契约基线**必须刷新**——
运行 `--diff` 得到的漂移清单是**且仅是**本轮有意新增的那些：

```text
+ 数据表: automation_runs / automation_schedules / compaction_messages /
          compaction_summaries / event_deliveries / event_subscribers /
          run_events / pack_install_facts / role_packs / experience_records
+ 路由:   GET/POST /api/automation/*（6）、/api/compaction/*（5）、
          GET /api/event-delivery、GET /api/runtime/run-events、
          GET /api/usage/{totals,rollup}（2）、
          GET/POST /api/packs/facts、GET /api/packs/{account,export}（4）、
          GET/POST /api/role-packs、GET /api/role-packs/export（3）、
          GET/POST /api/experience/records、GET /api/experience/{account,export}、
          POST /api/experience/drafts/（6）、
          GET/POST /api/connectors、GET /api/connectors/{incidents,export}（4）、
          POST /api/connectors/（1）
~ 源文件已变更：team-hub/server.mjs、team-hub/run-store.mjs、
                team-hub/automation-store.mjs、team-hub/pack-facts.mjs、
                team-hub/role-pack-store.mjs、team-hub/experience-store.mjs、
                team-hub/connector-store.mjs
```

`team-hub/automation-store.mjs` 与 `team-hub/usage-rollup.mjs` 的列变化
（`automation_schedules.payload_json`）走 `ensureColumn`，
因此是**老库可平滑升级**的加列，不是破坏性迁移。

★ 这四个建表模块**是被门禁自己要求登记的**：`prt-baseline` 的用例⑤
（"每个建表模块都登记进了 schema 采集"）当场报出
「它们的表对平台契约基线**不可见**」。不登记的后果正是那道门禁存在的理由——
表在真实 schema 里多出来，而 `--check` 兴高采烈地说"无漂移"。

## 3. P1：体验与运营

| 编号 | 名称 | 状态 | 代码落点 | 还差什么 |
|---|---|---|---|---|
| F-15 | 用量/费用与预算 | 🟡 | `team-hub/budget-ledger.mjs`、`team-hub/usage-rollup.mjs`、`runtime/contracts/price-table.mjs` | PRT-503/510/511 已落地；**成本刻已采**（$0.045086 实测）；本轮补上**五维度汇总**（`usage-rollup.test.mjs` 12 例 + `usage-rollup-http.test.mjs` 6 例真 HTTP）。`peak-resource` 仍缺（PRT-009 🟡，阻塞于 PRT-011 平台裁决） |
| F-16 | 自动化计划 | ✅ | `team-hub/automation-store.mjs`、`server.mjs`（6 条路由 + 30s tick） | `automation-store.test.mjs`（27 例）+ `automation-http.test.mjs`（9 例真 HTTP）。★ 本轮补上 `payload` 任务模板与 `bindTask`，`automationTick` 从 `wired:false` 变为 **`wired:true`**：物化出的运行会按计划模板建出一张**可领取**的任务卡 |
| F-17 | 长会话压缩 | ✅ | `team-hub/compaction-store.mjs`、`server.mjs`（5 条路由） | `compaction-store.test.mjs`（14 例）+ `compaction-http.test.mjs`（5 例真 HTTP）。★ 刻意**不调用模型**：收的是已算好的摘要文本 |
| F-18 | 经验图谱/摩擦学习 | 🟡→✅ | `runtime/experience/{friction,graph}.mjs`、`team-hub/experience-store.mjs`、`server.mjs`（5 条路由） | 本轮落地。★ 与旧 `plugins/src/experience.ts` 最要紧的分歧：旧实现从**评论散文**里数信号（正则匹配"打回"/"退回："/"将军验收"），于是有人改了措辞分数就变——而"因为改词变成 0"与"这段时间确实没有摩擦"在报表上是同一个 0。新实现**只从结构化字段取值**（拒绝 = `run_validations.decision`，重做 = 同一任务的第 2 次 attempt），并有一条**结构级**用例断言模块源码里不出现正则字面量。★ **缺失的输入是"不知道"、不是 0**：缺任何一维 ⇒ `complete:false`、`score` **抛**；要部分分必须显式 `allowPartial`，且返回的分数自报 `partial:true`——把缺失当 0 求和会得到一个**看起来完全正常**的低分。★ **草稿不是知识**：`draft → promoted | discarded`，两个终点都要人 + **封闭词表**的理由（丢弃也要写理由，因为"这条教训被谁按什么理由扔了"正是它消失的方式），没有自动晋升路径。★ 关系图**只记不推断**：边不隐式创建节点、必须署名，**撤销是追加记录不是删除**（"这条边存在过、被谁按什么理由收了"永远能答），遍历带 visited（这张图天然有环，没 visited 会在真实图上挂死）。旧 `plugins/src/experience*` 仍在，但不再是这一能力的落点 |
| F-18 缺口① | 摩擦分无法被证伪：信号来自评论散文的正则匹配，措辞一改分数就变 | `friction.test.mjs` 23 例（含"换一段无关评论分数必须一样"与结构级"不许出现正则"），8 处守卫已**变异验证** |
| F-18 缺口② | 关系图**不存在**：没有任务/文件/技能/错误的关系结构，也没有任何地方记"这条边是谁加的" | `graph.test.mjs` 15 例（含带环图遍历不挂死、撤销是追加），6 处守卫已**变异验证** |
| F-18 缺口③ | 草稿**算完即丢**（纯内存），且落盘面会把"现在的状态"存成第二份真相 | `experience-store.test.mjs` 23 例 + `experience-http.test.mjs` 14 例（含 409 走真网络、`seq` 用 `lastInsertRowid`），10 处守卫已**变异验证** |
| F-19 | Employee / Role Pack | ✅ | `runtime/employee/role-pack.mjs`、`team-hub/role-pack-store.mjs`、`server.mjs`（3 条路由） | 本轮落地。★ **七类版本一个不少**（prompt / skills / tools / permissions / model / connectors / budget），缺一类**不给默认空值**——`connectors: []`（显式"就是不用"）合法，**没写这一节**非法：一个"缺连接器就当没有连接器"的包与一个"作者忘了写、而它静默地没有连接器"的包在运行结果上是同一个东西。★ **版本号是标签、内容哈希才是身份**：承载内容的四类必须带 `hash`，而对账把两种漂移**分开报**——版本变了（`VERSION_DRIFT`，显眼）与版本没变而内容变了（`CONTENT_DRIFT`，阴险到按版本号比对会报"一致"）。★ 岗位包属于 **agent 平面**（`EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement:false`），强制面字段在**每一层嵌套对象**上都被拒，连接器一节只许出现引用、出现凭证字段单独成码。★ 冻结**改不动**：主键 `(scope, role_pack_id, version)` 让多版本同时存在（塞进就地更新的 `employee_manifests` 会让第二次修改覆盖第一次的答案），同版本同内容幂等、同版本不同内容 **409** |
| F-20 | Pack Manager | 🟡→✅ | `runtime/packs/{manifest,authority,store,compiled-plan}.mjs`、`team-hub/pack-facts.mjs` | 校验面**齐全**：签名三级（`builtin/signed/unsigned`，无验证器即 `unsigned`——"没法验"不是"验过了"）、依赖与权限（`authority.mjs`）、Runtime Contract、预检结论**必填**。★ **本轮关掉三处缺**（此前本表误记为 ✅）：① **`rollback` 已实现**——账上多一类**自己的**记录（不与 upgrade 混），四条拒绝各有具名码；② **账可持久化**——`snapshot()` / `createPackStore({history})`，坏账**整本拒绝**（跳过坏记录会让"这几个包没装过"与"这几条记录坏了"变成同一个读数）；③ **team-hub 保存安装事实**——`pack_install_facts` 表 + 4 条路由，`GET /api/packs/account` 的形状**原样**能喂回 `createPackStore`，`GET /api/packs/export` 给出可提交进 Git 的审阅文本（不含包内容/凭证） |

## 4. P2：扩展面

| 编号 | 名称 | 状态 | 依据 |
|---|---|---|---|
| F-21 | Connector / MCP 注册表 | ⬜→🟡 | **登记面与落盘面已生效**（`team-hub/connector-store.mjs` 的 `freezeDeclaration`/`connectorIncidents`/`exportConnectors` 都接在真 HTTP 路由上）；**判定面（`runtime/connectors/registry.mjs` 的 `decide()`）没有生产调用方**——见「还差什么」。64 例、30 处变异全部咬住 | ★ **还差一条，且它正是本仓库最忌讳的那一种**：`createRegistry`/`declareConnector` 全仓除了自己的用例**零调用方**（`grep` 无命中），也就是 §2 那句「能力齐全、用例全绿、而生产调用方数为 0」。正确的执行点是 `runtime/dsh-composition/plugins/pre-execute.mjs` → `tool-request.mjs` 的 `createEnforcementBridge().preExecute`（DSH `tools/pre-execute` 瀑布，每一次真工具调用都过它）——**本轮没能落在这里，因为同一工作树上另一个 agent 进程正在改 `tool-request.mjs`**（`git status` 显示该文件为 M），并发编辑一个承重的强制面模块风险高于收益。所以本轮如实记 🟡：登记了、能审、能冻，但**还没有任何一个真调用被它拦过** |
| F-22 | 后端与工作区 | 🟡 | `orchestrator/workspace/*`（git worktree）。§2 明写「不把 worktree 当安全沙箱」 |
| F-23 | 多 Harness 路由 | ⏸ | §2 明写「**不在契约稳定前同时支持多个 Harness**」——这一条**是设计决定，不是缺口** |
| F-24 | ACL 与安全姿态 | 🟡 | `team-hub/read-auth.test.mjs`、`read-open-loopback.test.mjs` 已覆盖读面矩阵；多用户写面 ACL 未做 |
| F-25 | 外部渠道 | ⏸ | §9 明写「多用户、多 Harness、远程后端和外部渠道**按真实客户需求推进**」 |

### 4.1 F-21 详情：四件事各自"看起来能用、其实在撒谎"的写法

§4.4 要求的是四件一起（**服务/工具策略、风险分级、SecretStore、故障隔离**）。
判据就是照着这四种坏写法写的：

★ **未声明的工具必须拒绝。** 最自然的写法
`if (declared === undefined) return 'allow'`（"没见过，交给下游判断"）的含义其实是
"只要有人往 MCP server 上加一个工具，它自动获得授权"——连接器是**外部**的，
对方可以在它那一侧加工具而控制面毫不知情。所以"没被显式声明过的，一律拒绝"。

★ **风险只能往上抬**（与 `dsh-composition/tool-capability.mjs` 的 `maxRisk` 同源），
且**不认识的能力名 / 风险等级要报错**。`riskFloorOf` 对不认识的能力会兜底成
`critical`——看起来安全，实际最坏：整个连接器莫名其妙全要人批，而**没有任何一处**
指出原因是能力名拼错了，作者会去查一个根本没问题的权限配置。
★ 一个真 bug 当场暴露了这个：我最初猜的能力名（`read`/`write`/`delete`）
全不在词表里，于是三个工具**全部**变成 `critical`——正是"兜底成最严"的现场。

★ **工具级 `deny` 优先于 server 级 `allow`。** 反过来写时，一个人专门写下的那条
deny 会被宽松的默认静默盖掉，而他写那条正是为了拦住一样具体的东西。
策略词表**刻意没有** `allow-once` / `allow-for-task`——那是"一次具体调用"的
一次性状态（F-10 管的），混进登记表会让一次性批准变成**永久策略**。

★ **密钥只许引用**：声明里递归检查凭证**值**（键名大小写与下划线都认）。
★ 这里抓到一个真 bug——第一版只检查自己解构出来的 `command/url/description`，
于是 `declareConnector({ ..., token: 'ghp_…' })` 里那个 `token` 被解构**丢掉**、
从未被检查过。失败模式很具体：今天那个多出来的键被静默忽略，某天有人
"支持一下 token 直填"把它加进解构列表时，它就变成一条**从来没有被任何检查拦过**
的凭证通道。已改成检查**整个入参**。

★ **引用要对得上号。** "指向不存在的密钥"与"密钥值恰好是空字符串"在调用时
表现得一模一样，而只有一个可以修。诊断版（`secretStatus`/`secretReport`，
一次说完哪几个有问题、**不抛**）与闸门版（`assertSecretsResolvable`，调用前抛）
的分工是刻意的。没传解析器时**不装作查过了**（`checked:false`、
`resolvable:null`——"没查"不等于"缺"）；解析器抛按"拿不到"处理（fail closed）；
每个引用**只调一次**（有状态解析器会在两次调用之间给出不同答案）。

★ **故障隔离**：
· 开路**必须带截止时间**——不带时一次临时故障会变成**永久**停用，
  而"永久"与"临时"在状态读数上长得一样，值班的人会一直等一个永远不会到来的恢复。
· 半开**只放一个探针**——放所有请求过去时，探针这一步本身就在打你正在保护的那个
  东西，而熔断的整个意义是减少对它的压力。
· 探针失败**立刻重新计时**——不重新计时，冷却窗口会随每次失败被"用掉"，
  于是探针越来越密，正好与熔断的目的相反。
· 一个连接器失败**不牵连**别的（"隔离"就是这一节标题）。
· `unknown`（一次都没探过）**不是** healthy。
★ 这里又抓到一个真 bug：`health` 最初从 `circuit` 推导
（`closed ? healthy : unhealthy`），于是**一个刚刚失败的连接器报 `healthy`**——
因为熔断要连续失败三次才跳闸，前两次失败时 circuit 还是 `closed`。
`circuit` 回答"现在还放不放调用过去"，`health` 回答"最近观察到的状态好不好"，
两者**不能互相推导**。

★ **落盘面**：声明按**内容哈希**冻结（同版本换内容 **409**）。与 F-19 同一条纪律，
但这一处更重——岗位包描述的是"这个岗位能做什么"，而连接器声明说的是
"一个**外部进程**能拿到什么权限"。事件**必须点名**是哪一个连接器（不接"全局"
这种值：一个能表达"全局故障"的字段，会让"三个连接器各挂了一次"与"全部同时挂"
写成同一条记录）；`openCircuits` 给的是**哪几个**开着，而不是"有故障"这一个布尔。
★ 两条**只在生产上错**的坑在这里修掉：`seq` 用 `lastInsertRowid` 而非
`SELECT MAX(seq)` 回读（两个进程共用一个 SQLite 文件时，A 会把 B 的号报成自己的）；
`atMs` 必填且必须是整数（`undefined` 与"当时就是 0"同形）。
★ 还抓到一处**规范化不幂等**：`normalizeDeclaration` 读的是 `input.version`，
而对一份已经规范化过的记录再规范化一次会把**记录格式版本**当成声明版本号，
于是同一个逻辑声明算出来的**身份**取决于"你传进来的是原始输入还是规范化后的对象"
（`freezeDeclaration` 内部先规范化，所以调用方事前自己算哈希去比对时必然对不上）。

★ **三条一致性性质**（这一组最容易被"看起来对"糊弄过去的地方）：
· 控制面**不 import 执行面**（单向产品边界），词表副本由用例①
  **从执行面源码里抽出来**逐字比对——再抄一遍互相核对时，两边一起写错它全绿。
· 路由守卫写成**字面量** + `startsWith`/`endsWith`，由用例⑤钉住：
  正则守卫会**悄悄**不进平台契约（`baseline-snapshot.mjs` 的抽取器只认字面量），
  而 `--record` 会写下一份"看起来正常、少了一条端点"的基线（PRT-507 的坑）。
· `version` 查询参数**必须真的被用上**：一个被静默忽略的 `version` 比"不支持"
  深得多——调用方问"1.0.0 当时放行了哪些工具"会拿回 2.0.0 的清单，
  而响应里没有任何地方提示这件事（这个 bug 被用例②当场抓到）。

| F-21 缺口 | 坏写法 | 判据 |
|---|---|---|
| ① | 未声明的工具放行（"没见过就放行"＝对方加一个工具就等于加一个后门） | `registry.test.mjs` ①②：未声明的工具 / 未注册的连接器 / 空名字三种都断言 `deny` + 具名码 |
| ② | 风险可被作者压低；不认识的能力名静默兜底成最严 | `registry.test.mjs` ②：`declaredRisk:'low'` 遇 `repo:push` 必抬到 `critical` 且留痕；拼错能力名必须**报错** |
| ③ | 凭证值可写进登记表；密钥引用对不上号时无人报出 | `registry.test.mjs` ③（含嵌套路径 `$.description.deep[0].apiKey`）；诊断版/闸门版分工 |
| ④ | 没有熔断：外部故障被无限重试，且"没探过"读成"一切正常" | `registry.test.mjs` ④⑤：开路带 `untilMs`、半开只放一个探针、失败重新计时、互不牵连、`unknown ≠ healthy` |
| ⑤ | 声明在落盘面可被就地修改，"当时放行了哪些工具"在写的那一刻失去答案 | `connector-store.test.mjs`：内容哈希冻结、同版本换内容 409、坏行 `readable:false`、拿不到读数报 `null` 不是 `0`、事件必须点名 |

判据合计 **64 例**（`registry.test.mjs` 31 + `connector-store.test.mjs` 22 +
`connector-http.test.mjs` 11 例真 HTTP），**30 处变异全部咬住**（15 + 15）。
★ 期间还删掉了一个 `CONNECTOR_NOT_FOUND`：`getDeclaration` 找不到时返回 `null`，
那是一个**正常读数**（"这个连接器还没登记过"），不是错误——登记一个永远抛不出的
码与登记一段被注释掉的代码是同一个东西，只不过前者让错误码清单看起来更完整。

### 4.2 ★ F-21 为什么记 🟡 而不是 ✅：判定面没有生产调用方

这是本轮**自己推翻自己**的一条，值得单独写下：

四处 `grep` `createRegistry` / `declareConnector` 的结果是——**只有
`runtime/connectors/registry.test.mjs`**，全仓**零生产调用方**。

这正是本文 §2 那句开场白说的形状：

> 这几条的共同形状是 **"能力齐全、用例全绿、而生产调用方数为 0"**。

登记那半边**是活的**：`freezeDeclaration` / `connectorIncidents` /
`exportConnectors` 都接在 `server.mjs` 的真路由上，一段真 HTTP 请求能把声明冻进去、
把熔断事件读出来。但**判定**那半边（`decide()`）没有被任何东西调用——
产品里目前没有任何组件真的发起一次 MCP 工具调用。

> 一个"写得很对但没人调用"的闸门，与一个不存在的闸门，
> 在"这次调用被拦住了吗"这个问题上给出同一个答案：没有。

**正确的执行点已经找到**：`runtime/dsh-composition/plugins/pre-execute.mjs`
挂在 DSH 的 `tools/pre-execute` **瀑布**上，把判定全部交给
`tool-request.mjs` 的 `createEnforcementBridge().preExecute`——每一次真工具调用
都过那里，所以连接器判定应该在那条桥里（**而不是**在 `pre-execute.mjs` 里：
那个文件的文件头明写「判定逻辑**不在这里**」，把一段判定塞进去会让
"强制面在哪"这个问题的答案变成两处）。

**本轮没有落在那里的原因**是并发的：同一工作树上另一个 agent 进程**正在改
`tool-request.mjs`**（`git status` 里它是 M）。往一个承重的强制面模块里做
跨边界并发编辑，风险高于它带来的收益——尤其当"改错了"的后果是
**放行或拦截错一次真实的工具调用**。所以按仓库的纪律如实记 🟡：

> ✅ 要求"有代码落点 + 可复跑的判据"，而 🟡 要求**写明缺哪一条**。
> 这一条的缺法很具体：**判定面还没有被任何一次真调用驱动过**。

到期的接法（留给下一轮或另一条工作线）：

1. 在 `createEnforcementBridge({...})` 上开一个**可选**的 `connectorRegistry` 端口，
   并使用**字面量**守卫（`path.startsWith(...)` 那一条约定同样适用于工具名匹配的登记，
   任何"看不见某类改动"的匹配都会重演 PRT-507）。
2. ★ **没给端口时，连接器形状的工具必须 deny**（fail closed），而不是放行。
   这一条是承重的：它让"忘了接线"变成**可见的失败**——一个连接器工具
   在没接线时静默放行，与一个"后门一直在那儿"是同一个东西，
   而前者的表现只是"暂时没人用连接器"。
3. 判据要写成 `decide()` 的**返回值真的改变了瀑布的结论**，而不是
   "桥里出现了对 `decide()` 的调用"——*一个"含不含"的断言对"用不用"的缺陷
   完全不敏感*（这是 PRT-253 那一行用真实代价学到的）。

---

## 5. 需人工介入清单（汇总给到项目方）

下面这些**不是"还没做"**，而是"代码侧无法单独关闭"。
每一条都写明了：需要谁做决定、决定什么、不做决定时的实际后果。

| # | 事项 | 需要谁 | 具体决定 | 不决定的后果 |
|---|---|---|---|---|
| 1 | **PRT-011 DSH 分发形态** | 项目主 | 路线 C 已裁决；`peak-resource` 基线依赖它确认目标平台 | PRT-009 只能停在 🟡；峰值内存/CPU 永远没有"期望值"可比 |
| 2 | **PRT-009 峰值资源采样** | 需要一台**执行期外**的机器 | 采样窗口、工具（perfmon/typeperf？）、多少次跑取分位 | DSH 会话转录**不记**进程资源，所以仓内无法测 |
| 3 | **PRT-214 G1** | 项目主 | Legion host-plane 是否冻结（不再加新的 host 插件） | per-Run 授权身份只能做到"进程级"，多空间时错标 |
| 4 | **PRT-214 G4** | 产品 | win32 `sandbox-enforcement` 的"完整 vs 部分"判据 | 强制面自检的通过标准没有权威定义，自检通过与否不可复核 |
| 5 | **PRT-253 G2/G3/G4/G6** | 产品 + 项目主 | 能力来源判据、win32 沙箱口径、**真实模型黄金跑** | 单员工黄金任务只能"代码就绪"，不能宣称跑通 |
| 6 | **PRT-509 C1～C4** | 产品 | 凭证的产品决策（轮换、多档案、失败姿态、运维出口） | B1 已关（真 runner/owner）；C 系列是产品形态问题 |
| 7 | **真实凭据 / 另一台机器** | 项目方 | 提供 DPAPI 可用的 Windows 机器、真实模型 API key | F-09 的"真进程读到了值"已在本机验证；跨机器证据仍缺 |
| 8 | **F-23 / F-25 是否要做** | 产品 | §2 与 §9 已明确"契约稳定前不做多 Harness""按真实客户需求推进" | 目前按**设计决定**归档，不按缺口处理——若产品要提前做，请显式说明 |
| 9 | **PRT-316 的开工资格（台账里唯一的 ⬜）** | 项目主（时间到点即可，无人需裁决） | 前置条件是**排期规则**而非缺失能力：`0db37af` = 2026-09-10，一个发布周期 = 14 天（`PRT-909-release-checklist.md:63`）⇒ 最早 **2026-09-24** 可开工；两个条件里"热点文件争用"那条**已过**（`hot-file-churn.mjs` exit 0，当前 2/40、峰值 14/40） | 这一天之前**没有**"再等一个人拍板"的事，只是**时间没到**；到期后可按 PRT-315 那七刀的先例逐片提取 `team-hub` 模块。★ 若产品要求**提前**开工，请显式说明——那等于自愿放弃那个发布周期的冷却理由 |
| 10 | **F-22 / F-24 是否按客户需求推进** | 产品 | F-22 的**远程后端**与 F-24 的**多用户写面 ACL** 都属 §9「按真实客户需求推进」；当前落地范围（worktree 工作区 + 只读面 ACL 矩阵）**按设计已完成** | 不推进则这两条长期停在 🟡（**这是设计决定，不是缺陷**）。★ 注意 §2 明写「**不把 worktree 当安全沙箱**」——若某天真要跑不可信代码，那不是"补 ACL"，而是换隔离机制 |
| 11 | **PRT-509 剩余三条** | 环境 + 项目方 | ① win32 上 `0600` **本机无法证明**；② **生产默认句柄工厂**（走 `resolveDshBaseBundlePatchPath` 解析器）**只有注入式覆盖**，真实调用没跑过；③ 已证明的是"**DSH 的凭据提供方**从 Legion 材料化的文件里读到了值"，**不是**"一个真 DSH 进程启动时把那份覆盖层文档解析出来了" | 三条都**如实记为 🟡 的剩余**，不冒充已闭合。②③ 需要一次**真 DSH 进程启动**的现场（有 `DSH_CHECKOUT` 时可跑，但没有覆盖层真实生效的那条路径） |
| 12 | **F-19 Role Pack 的"七类版本"范围确认** | 产品 | 七类（prompt / skills / tools / permissions / model / connectors / budget）是否就是这个岗位包的全部版本面 | 若产品认为还缺一类（例如"环境"或"路由"），现在加是**新增一节**；等到有真实岗位包在库里之后再改，就要处理"旧包缺这一节"的兼容问题（而现在按设计**拒绝缺节**的包） |
| 13 | **F-21 判定面的接线资格** | 项目主（只需确认"现在可以动 `tool-request.mjs`"） | 把连接器判定接进 `createEnforcementBridge().preExecute`（DSH `tools/pre-execute` 瀑布，见 §4.2）。**本轮唯一没做的原因是并发**：同一工作树上另一个 agent 进程正在改那个文件 | 不接则 F-21 停在 🟡：登记、冻结、审计、导出都能用，但**没有任何一次真调用被它拦过**——"闸门写好了、还没装到门上"。★ 若产品认为"现在产品里没有 MCP 客户端，接线是给不存在的东西装门"，**请显式说明**，那我就把 F-21 的定位改成"控制面已就绪、判定面随 MCP 客户端一起做"，并在文档里这么写 |
| 14 | ★★★ **三道范围检查的生产接线（PRT-603/604/605/606）** | 产品 + 项目主 | **这三道检查今天在生产里一次都不跑**（读数见 §5.2）。要决定的是：**这一次 Run 的范围表（读根/写根/平台、命令/网络/MCP 授权、外部 API 读写端点）从哪来、挂在哪一层**。可选方向：(A) 随 Run 的载荷到达，像 PRT-214 的下限/授权身份那样由 `runtime-host-registrar-row.mjs` 按 Run 安装；(B) 由岗位包（F-19 的 `permissions` 一节）派生，装配期算一次；(C) 仍留在 hub 侧判（那 `path-scope.mjs` 这类执行面检查器就应当明确废弃，而不是挂在桥上当"可选端口"） | 不决定则**越界路径今天拦不住**：`tool-request.mjs:639` 在 `pathScope === null` 时返回"放行"，而生产从不注入。★★ 我**没有**擅自接线，因为凭空造一份范围表正是 PRT-253 §3 明令禁止的"不发明任何默认值、替身或暂时放行"——那会让"没接线"与"接好了"在读数上同形。本轮的处置是把读数钉住（`production-scope-wiring.test.mjs` 5 例 + 5/5 变异），所以**接上了它会红**。★ 另注意：三个台账行（PRT-604/605/606）的 ✅ 依据是"模块 + 自己那套用例"——按本表 §0 那条告警（"只有自己的用例驱动的原语一律 🟡"），它们的口径需要在台账里对齐 |
| 15 | ★★ **PRT-610 执行面的落账点** | 项目主 + 产品 | `tool_calls` 的**表、读面、就绪证据的产出点**已经接上（本轮），而**写入方仍然是 0**：要接 `recordToolCall`/`markDispatched` 得先定"一次工具调用在哪一层落账"——`tools/pre-execute` 是**判定**点，而 `markDispatched` 必须在**真的派发之前**落库，那个位置比判定点更靠下 | 不接则这笔账永远是空的：表建好了、三条路由能读、就绪判据能回答"在不在记"，而**一条记录都不会有**。★ 这与第 14 条是**同一个决定**（执行面的载荷里今天没有这些字段），不是代码量问题。★★ 另：`release-gate.mjs` 的 `evaluateReadiness` **本身也零生产调用方**，所以"证据有了产出点"之后仍没有人在**发布决策**里读它——本轮只补齐了能被代码单独关闭的那一半 |
| 16 | ★★ **阶段 9 产品动作的 CLI 面（PRT-903/904/905/908/909、PRT-712、PRT-707）** | 产品 | 这批模块（发布检查清单、隐私说明、保留策略、数据导出、卸载、支持手册、首次运行向导、指标数据源）**全部自带用例、全部 ✅、全部零生产入口**（系统盘点见 §5.3）。要决定的是：**这些"产品级动作"由谁触发**——`legion` 的子命令？一个独立的发布/运维 CLI？还是只作为发布流程里人工跑的一次性脚本？ | 不决定则它们**对用户不存在**。台账自己为 PRT-509 写过这句话：「一个功能没有入口，与这个功能不存在，对用户来说是同一件事」。★ 其中 `metrics-source.mjs` 的台账行已如实写了"还没有界面/CLI 消费者"，另外六个没有写。★★ 另：PRT-801～813 的升级执行链**看起来**也在这个清单里，但它**不是**缺口——`runtime-install.mjs` 的注释写明 Launcher **刻意不 import** 它（进程卫生：Launcher 要在那些依赖起来之前先把进程看好）。**不要**给 Launcher 补这个 import，见 §5.3。它的执行者同样取决于第 1 条（PRT-011 DSH 分发形态） |
| 17 | ★★★ **PRT-707 的两份实现用两个不同的模型密钥引用名** | 产品 + 项目主 | PRT-707（首次运行向导）在仓库里有**两份实现**：**活的**是 `cli.mjs` 的 `--wizard` 分支（内联，写 `model/api-key`），**死的**是 `first-run.mjs`（636 行 + 一整套用例，算 `legion/model/<profileId>`）。要裁决的是：**模型密钥的引用名用哪一个**——Legion 自己的三段式（`legion/model/<id>`，与 `credential-materializer.mjs` 文件头那句"Legion 的模型引用是 `legion/model/<profileId>`"一致，但 `planDshLookup()` 实测 `addressable:false`），还是运行时物化的那一段（`model/api-key`，端到端通、被 drift 用例钉着）？**或者**：两份实现留哪一份、另一份删掉还是明确废弃？ | ★★ **不要**把 `first-run.mjs` 直接接上去。它写进 hub 档案的 `secretRef` 是 `legion/model/<id>`——**三段**，而 `security/secrets/credential-materializer.mjs` 的 `planDshLookup()` 对三段引用返回 `{addressable:false, space:null}`（在 `refs` 与 `records` 两个键空间里**都没有位置**）。接上它的后果**不报错**：向导报"模型已配置"，而运行时拿不到钥匙——正是该模块文件头点破的那种失效（"文件看起来完整、就是少了最要紧那一把钥匙"）。★ 本轮**没有**替任何一方改代码：两份**各自都自洽**，裁决它需要产品决定。已把它变成读数：`product/launcher/wizard-wiring.test.mjs`（5 例，**今天全绿**，7/7 变异成立）——它红的那天，正是有人接线或对齐的那天 |

---

## 5.1 本轮（F-18/F-19/F-21）自己发现的、需要记账的边界

这几条**不是**要人裁决，而是**如实写下的"这一套没有证明什么"**，
以免下一个人把绿色摘要读成超出它范围的结论：

| 事项 | 已经证明的 | **没有**证明的 |
|---|---|---|
| F-18 摩擦分 | 只从结构化字段取值；缺输入是"不知道"不是 0；草稿要人 + 封闭理由；图只记不推断 | 这些**信号本身**来自 `run_validations`/attempt/`run_reconciliations`——它们在真实运行里**是否被写得足够全**，属于上游数据质量问题，不在这套用例里 |
| F-18 图 | 只记不推断、撤销是追加、带环遍历不挂死 | **没有任何真实调用方**在跑它（§0 那条告警照旧：只有自己的用例驱动的原语一律 🟡 的邻居）——落盘面与 HTTP 都已接上，但"谁在生产里写第一条记录"还没发生 |
| F-19 岗位包 | 七节齐全、版本与内容两种漂移分开、冻结改不动、幂等不碰冻结时刻 | 包里的 `skills`/`tools` 等**引用**是否指向世界里真实存在的东西，只做到"引用形状合法"；`REF_MISSING_IN_WORLD` 需要一份真实世界清单才能判 |
| F-21 连接器 | 未声明即拒绝、风险只上抬、密钥只许引用、熔断有截止时间、隔离互不牵连 | **没有连过任何一个真的 MCP server**：`transport: 'stdio'`/`http` 的**实际握手**不在这套用例里（这一层判的是"放不放过去"，不是"连得上吗"）。以及 `resolveSecretRef` 的真实实现（接 `SecretStore`）尚未接线——没接线时它如实报 `checked:false` 而不是假装查过 |
| PRT-610 工具调用账 | 表结构、幂等键、四态结果、来源与决定的闭合性；**读面三条路由**；就绪证据 `decisionSourceRecorded` 的产出点（三态，区分"表不在/读不出来/读得出来"） | **写入方为 0**：一笔记录都还没有产生过，所以"决定来源真的在记"这件事只有**结构**证据、没有**运行**证据。见 §5 第 15 条 |

---

## 5.2 ★★★ 本轮新发现：**三道范围检查在生产里从来没有跑过**

这是本轮最大的一条，而且它不属于 F-01～F-25 里任何一条——它是 PRT-603/604/605/606
（台账里**都是 ✅**）与生产装配之间的一段落差。

### 读数

```text
生产组合根 enforcementSurfaces() = {
  hardFloor: true, pathScope: false, whitelist: false, policy: true, approval: true
}
```

`pathScope:false` 与 `whitelist:false` 意味着：**这两道检查在生产里没有被注入**。
而 `execution-scope.mjs`（PRT-605）与 `external-api-scope.mjs`（PRT-606）
**连端口都没有**——桥的参数表里没有它们的位置，所以连"没接"这个读数都表达不出来。

### 怎么核出来的

| 环节 | 位置 | 读数 |
|---|---|---|
| 生产装配的**唯一**入口 | `runtime/dsh-composition/plugins/root-row.mjs:485-509` | `installEnforcementRoot({ env, decide, createRequestApproval })` —— **只有三个键** |
| 组合根透传 | `runtime/dsh-composition/root.mjs:465-466` | `whitelist: input.whitelist, pathScope: input.pathScope` ⇒ 两者都是 `undefined` |
| 装配默认值 | `runtime/dsh-composition/assemble.mjs:135-136` | `whitelist = null, pathScope = null` |
| 桥的行为 | `runtime/dsh-composition/tool-request.mjs:638-651` | `if (pathScope === null) return undefined` —— **返回 undefined 就是放行** |
| 两个检查器的 import 者 | `grep 'from .*(path-scope\|execution-scope\|external-api-scope)'` | **只有它们自己的 `.test.mjs`**（零生产 import 者） |

### 这条落差为什么危险

三道检查**各自**都写得很硬（`path-scope.test.mjs` 的 22 例把"字符串比包含关系"
的三种放行方向逐条钉住），而"它们在生产里跑不跑"是**另一个问题**——
每一道检查器的套件都**结构上问不到**它：

> 一个「端口没接上、而没接上时检查自动放行」的组合根，
> 与一个「路径范围限制没有生效」的组合根，是同一个东西——
> 只不过前者的证据里有一行诚实的 `pathScope:false`。
>
> 而这三个套件（`path-scope` / `execution-scope` / `external-api-scope`）
> 即使全绿，也说明不了那一行。

### 本轮做了什么

**没有接线。** 理由不是"没时间"，而是**接了就是编造**：

- 要注入 `pathScope`，得先有**这一次 Run 的范围表**（读根/写根/平台）。
  它今天不在任何随请求到达的载荷里——这与 PRT-253 那篇论证 `canRead`
  "答案不在这边"是**同一个形状**。凭空造一份范围表正是那篇明令禁止的
  "不发明任何默认值、替身或暂时放行"（该文 §3「明确不做的事」）。
- 真要接，要改的是 `root-row.mjs` 与 `runtime-host-registrar-row.mjs`
  这条按 Run 安装载荷的链（下限/授权身份已经走这条路）——
  而**后一个文件当轮正被另一个 agent 进程改着**（未提交 +56 行，PRT-214 缺口②）。

所以本轮做的是**把这句话变成读数**（PRT-253 自己立的标准：
「把这句话从"作者当时相信"变成"再多加一个键就会红的读数"」）：

`runtime/dsh-composition/production-scope-wiring.test.mjs`（**5 例**，已进 `run-ci.mjs`）：

| 用例 | 钉住的读数 |
|---|---|
| ① | 以 root-row.mjs 的**同一组入参**装配真组合根，`enforcementSurfaces()` 恰好是 `{hardFloor:true, pathScope:false, whitelist:false, policy:true, approval:true}`；**且**生产入参键集里不许出现 `pathScope`/`whitelist` |
| ② | 桥的参数表里没有 `executionScope`/`externalApiScope`，且强制面键集恰好是那五个（键集是**契约**） |
| ③ | ★ **后果是真的**：同一路越界调用（`C:/etc/passwd`），没接 = `allow`，接上 = `deny` |
| ④ | **反向对照**：显式传上两个键，读数翻成 `true`（证明 ① 的 false 是"没人给"，不是"这个读数恒 false"） |
| ⑤ | 生产装配入口没有搬家（`root-row.mjs` 仍是唯一调 `installEnforcementRoot` 的生产文件） |

★ 变异验证 **5/5 全部咬住**：①a 给生产装配加 `pathScope:`、①b 加 `whitelist:`、
② 给桥加 `executionScope` 端口、③ 让 `pathScope` 缺席时**拒绝**（不再是放行）、
④ 让 `enforcementSurfaces()` 恒报 `pathScope:true`——每一条都当场变红。

★ 变异是在**副本**上做的（`.mut-rt/`），不是活树：活树全程只被读，
前后 sha256 相同（`d788f16e…`）。理由写在那份脚本的注释里——

> 一次成功的破坏与一次成功的还原，在事后的 `git diff` 里长得一样。
> 而活树上另一个 agent 进程正持着未提交的改动。

### 需要人裁决的一条

**这三道检查应当在哪一层拿到范围数据？** 见 §5 第 14 条。

---

## 5.3 ★★ 系统盘点：还有一批"模块全绿、而没有任何生产入口"的原语

§5.2 的三道范围检查不是孤例。本轮把这一类形状**系统扫了一遍**，并把结论记在这里，
以免下一个人（或下一个 agent）再推一遍——**或者更糟：把其中一个"修好"**。

### 扫法与它的正对照

判据是"**零个非测试文件 import 它**"。扫法本身有一个必须防的失效：

> 一个「因为解析器坏了所以什么都没找到」的扫描，
> 与一个「真的什么都没有」的扫描，在输出上是同一个东西。

所以脚本先跑**正对照**（已知接在生产上的模块必须被认出）。★ 第一版的正对照**没挡住**：
四条样本全在 `runtime/`+`team-hub/` 里，而漏扫的是 `scripts/`——于是
`product/compliance/inventory.mjs`（PRT-901）被报成"零调用方"，
而台账明写它的生产入口是 `scripts/prt/sbom.mjs`。

> 一个只覆盖已知路径的正对照，
> 与一个没有正对照的检查，在"漏扫"这件事上一样。

补上 `scripts/` 与一条跨目录对照后，命中 40 个 → **排掉合法类别后剩 14 个**。
合法类别（**不是**缺口）：CLI 入口（`scripts/**`、`*-cli.mjs`）、barrel（`index.mjs`）、
`config-schema.mjs`（被 `scan.mjs` 读**源码**，按设计不被 import）、
测试夹具（`*-fixture.mjs`）、组合行（由 `patch-layer.mjs` 的 `runtimeModule:` **清单**加载）。

### 收窄后的 14 个，按"为什么"分四类

| 类别 | 模块 | 为什么没有生产入口 |
|---|---|---|
| **已记账**（本轮/上轮） | `runtime/connectors/registry.mjs`（§4.2）、`path-scope.mjs`+`execution-scope.mjs`+`external-api-scope.mjs`（§5.2） | 判定面/范围表要等执行面载荷定义，见 §5 第 13/14 条 |
| **★ 刻意不接，且理由写在代码里** | `product/upgrade/{index,backup,migration,switchover,package,preflight}.mjs`（PRT-801～813 的**执行**链） | 见下 |
| **★★ 接上去会更坏** | `product/launcher/first-run.mjs`（PRT-707 的**死的那份**实现） | 见 §5.3.1 |
| **产品入口尚未定形** | `product/release/{checklist,privacy}.mjs`、`product/lifecycle/{retention,data-export,uninstall}.mjs`、`product/support/runbook.mjs`、`product/metrics-source.mjs` | 都是**阶段 9** 的交付物；它们的入口是一次"产品级动作"（发布检查、导出、卸载），而那个 CLI 面今天不存在。★ 其中 `metrics-source.mjs` 的台账行**已经如实写了**"`metricsCounts()` 目前只被这个数据源使用，还没有界面/CLI 消费者" |

★ **"零生产入口"这一列读数的结论只有一句：去读代码里的理由，再决定动作。**
四类的正确动作**完全不同**：已记账的等裁决、刻意不接的**别动**、
接上去会更坏的**先对齐**、入口未定形的才轮到"补一个入口"。

### ★★ 最要紧的一条：**不要**把升级链 import 进 Launcher

`product/upgrade/index.mjs`（聚 backup / migration / switchover / package / preflight）
**零外部 import**。**四种触发方式逐一查过**：静态/动态 import（无）、
被 spawn 成子进程（全仓无一处 spawn 带 upgrade 路径）、CLI 自调用守卫（9 个模块**全无**）、
ci/脚本按路径跑（只有用例）。

看起来是个大洞——**但它不是**。`product/launcher/runtime-install.mjs` 的注释写了原因：

> 判据形状与 `product/upgrade/index.mjs` 的 `patchPairOf()` **刻意一致**……
> **没有 import 它**，是因为那个模块连同 `manifest.mjs` 把升级审计的整条依赖
> 拖进 Launcher 的进程，而 Launcher 的职责恰恰是"**在那些东西起来之前先把进程看好**"。

同一条纪律在 `product/launcher/dsh-overlay.mjs:64-73` 又写了一次（那里刻意重写了一个
路径字面量而不 import `render.mjs`，并用一条用例钉住两处相等）。

所以这里有一个**反向的**风险，比"没接线"更值得写下来：

> 一个看见"零调用方"就去补一个 `import` 的人，
> 会把 Launcher 的启动依赖拖成升级审计的依赖——
> 而那正是这两处注释**提前**挡住的事。
> **一个看起来该补的洞，与一个被刻意留着的缺口，在"零调用方"这个读数上是同一个东西。**

这条与 PRT-011（**DSH 分发形态**，§5 第 1 条）是同一个决定的下游：
升级链的执行者是谁，取决于产品以什么形态分发与安装。**本轮没有动它**。

### 本轮**没有**改任何一行的 ✅/🟡

理由与 §5.2 末尾那条相同：`✅`/`🟡` 的口径由台账的读者定，而"改状态"与"补证据"是两件事。
本节的用途是**把读数钉在这里**：谁要给这批模块补入口，就从这里出发；
谁要改口径，也已经有完整的清单。

### 一条代码侧的、能被单独关闭的缺口（**已修**）

`team-hub/server.mjs` 从来没有调用 `ensureToolCallSchema`，于是 `tool_calls`
**在任何生产进程里都没有被 CREATE 过**；而 `release-gate.mjs` 的就绪判据
`decisionSourceRecorded` 在全仓**没有产出者**，因此永远判否。
本批补上了建表、三条只读路由与那个产出点 —— 见 PRT-PROGRESS 的 PRT-610 续批段
与 §5 第 15 条。

### 5.3.1 ★★★ 第三类：**接上去会更坏**（PRT-707 有两份实现）

前两类是"等裁决"与"别动"。这一类更安静：**动它会得到一个不报错的坏产品**。

`product/launcher/first-run.mjs`（636 行、一整套用例、台账 ✅、零生产导入者）
是 PRT-707 的**第二份**实现。**活的那份**是 `cli.mjs` 的 `--wizard` 分支里
**内联**的一份。两份对"模型密钥叫什么名字"说法不一致：

| 角色 | 文件 | 引用名 | 谁钉着它 |
|---|---|---|---|
| 活的 | `cli.mjs` `--wizard`（内联） | `model/api-key` | `run-credential-materialization.mjs` 的 `RUNTIME_MODEL_KEY_REF` + 一条 drift 用例 |
| 死的 | `first-run.mjs` | `legion/model/<profileId>` | `first-run.test.mjs`（自己一整套） |

关键在于**死的那份用的名字在三段**，而
`security/secrets/credential-materializer.mjs` 的 `planDshLookup()` 对它返回
`{addressable:false, space:null}`——**在两个键空间里都没有位置**
（`refs` 的键是 POSIX 标识符，`records` 的键是**恰好两段**）。本轮用**真实读者**实测：

```text
model/api-key                {"addressable":true,"space":"records"}   ← 活的那条
legion/model/default         {"addressable":false,"space":null}      ← 死的那条
legion/openai                {"addressable":true,"space":"records"}   ← 正对照（两段→可以）
DEEPSEEK_API_KEY             {"addressable":true,"space":"refs"}      ← 正对照（另一个空间）
```

所以把那份死的接上去的后果**不报错**：向导报"模型已配置"，而运行时拿不到钥匙。
`credential-materializer.mjs` 自己把这种失效点破了：

> 一个"文件看起来完整、就是少了最要紧那一把钥匙"的读数，
> 与一个"文件本来就只该有这么多"的读数，在 `cat` 的输出里长得一模一样。

**§5.3 那条"别动"的教训在这里推进一步**：上一节说的是"零调用方 ≠ 缺陷"，
这一节说的是"**零调用方也可能是被一个更坏的东西挡住的**"。
补一个 `import` 之前，先确认接上去的那条链**端到端**是同一件事
（这里就是：写进去的引用名 == 运行时读出来的引用名）。

★ **本轮没有替任何一方改代码。** 两份**各自都自洽**：
死的那份用的是 Legion 自己的三段式（与 `credential-materializer.mjs` 文件头一致），
活的那条链端到端通。裁决它是 §5 第 17 条。本轮把它变成**读数**：
`product/launcher/wizard-wiring.test.mjs`（5 例，**今天全绿**，7/7 变异成立）。

★ 变异验证在本轮**又咬到一次**（同族第四次）：第 ⑥ 处变异第一次没咬住，原因不是
判据写错，而是**我的扫描漏了一种装法**（只收 `from '…'` 与 `import('…')`，
不收 `import '…'` 这种纯副作用导入）。

> 一个「漏了一种装法」的扫描，
> 与一个「那个模块真的没人装」的扫描，在输出上是同一个东西。

已补上第三种装法，并让那一处变异专门用这种形态——它咬住了，也就证明补漏**有效**。


## 6. 怎么复跑这份对照表里的每一条

```bash
# 全量门禁（含本文引用的每一套用例）
node scripts/ci/run-ci.mjs

# 只跑本轮新增的套
node scripts/ci/run-ci.mjs --only test   # 然后在输出里找：
#   run-events / event-delivery / automation / compaction / usage-rollup / pack-facts / role-pack / experience / connectors

# 单独复跑
node --test team-hub/run-events.test.mjs
node --test team-hub/event-delivery.test.mjs team-hub/event-delivery-wiring.test.mjs
node --test team-hub/automation-store.test.mjs team-hub/automation-http.test.mjs
node --test team-hub/compaction-store.test.mjs team-hub/compaction-http.test.mjs
node --test team-hub/usage-rollup.test.mjs team-hub/usage-rollup-http.test.mjs
node --test team-hub/pack-facts.test.mjs team-hub/pack-facts-http.test.mjs
node --test runtime/employee/role-pack.test.mjs team-hub/role-pack-store.test.mjs team-hub/role-pack-http.test.mjs
node --test runtime/experience/friction.test.mjs runtime/experience/graph.test.mjs team-hub/experience-store.test.mjs team-hub/experience-http.test.mjs
node --test runtime/connectors/registry.test.mjs team-hub/connector-store.test.mjs team-hub/connector-http.test.mjs
node --test runtime/dsh-composition/production-scope-wiring.test.mjs
node --test team-hub/tool-call-log.test.mjs team-hub/tool-call-http.test.mjs
# ★ 下面这一套今天**全绿**——它是一份读数，不是待办（见 §5.3.1 与 §5 第 17 条）
node --test product/launcher/wizard-wiring.test.mjs
node --test runtime/packs/store.test.mjs
node --test product/secrets.test.mjs
node --test product/launcher/secrets-acl-runner.test.mjs

# 配置面（新增字面量必须登记）
node scripts/config/scan.mjs --check

# 平台契约基线（新增表/路由后必须刷新，否则 prt-baseline 用例④⑤会红）
node scripts/prt/baseline-snapshot.mjs --diff
node scripts/prt/baseline-snapshot.mjs --record   # 仅在确认漂移都是有意变更后
```

证据目录：`.ci/<timestamp>/`（每次 `run-ci` 一份 `summary.json`）。

### 6.1 ★ 读 CI 红之前先看这一节：`prt-churn` 可能与你的改动**无关**

`--only test` 里有一组会**偶发**变红：`prt-churn`（热点文件改动节奏探针）。
本轮实测到过一次，`fail=2`，两条都在 ③。**它不是回归**，机制已经被钉住：

- `scripts/prt/hot-file-churn.test.mjs:84` 在**模块加载时**跑一次
  `const churn = collectChurn({ size: 40, windows: 3 })`；
- 全套件 13 条用例里，**只有两条**读这个快照（③ 的 `assert.equal(churn.ok, true)`
  与 ③ 的遍历 `churn.files`）——所以快照一旦取不到，**恰好两条**变红；
- `collectChurn()` 内部用 `git rev-parse HEAD` / `git rev-list HEAD` 起手，
  取不到就返回 `{ok:false}`（那是它的设计：非 git 目录要给出可读原因）。
  于是在一个**有另一个 agent 进程每 ~60s 提交**的共享工作树上，
  一次瞬时争用就能让 `ok:false`，而那两条用例跟着红。

★ **怎么区分"偶发"与"真回归"**：把那个计数打出来。

```bash
node scripts/prt/hot-file-churn.mjs --json
# 看每个文件的各窗口计数与窗口大小（默认 40）。
```

本轮实测 `max=14 / 40`（`team-hub/server.mjs` 的峰值窗口），**离阈值很远**——
也就是说 ③ 报出"计数 > 窗口大小"是**不可能的**，红的那次只可能是 `churn.ok === false`。
单独复跑该套件即 13/13 通过。

> 一个「共享工作树上 git 瞬时争用导致的红」，
> 与一个「这次改动真的破坏了闸门」的红，在 `FAIL prt-churn` 这一行上是同一个东西——
> 而 ③ 的**两条**用例（不是一条、也不是十三条）同时红，正是前者的指纹。

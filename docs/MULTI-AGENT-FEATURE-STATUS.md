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
| F-04 | Orchestrator Core | 🟡 | `orchestrator/worker/*`、`team-hub/run-store.mjs`、`orchestrator/{acceptance,pipeline,workspace}/` | PRT-301～316（143 ✅ / 19 🟡 / 1 ⬜ / 2 ⏸） | `plugins/src/index.ts` 仍是主要编排热点（§1.1 的判断）；PRT-316 未开始 |
| F-05 前半 | 运行明细作为可持久化 RunEvent | ✅ | `team-hub/run-store.mjs`（`run_events`）、`orchestrator/worker/{executor,main}.mjs`、`server.mjs` | `team-hub/run-events.test.mjs`（18 例） | 明细**不进** `/api/events`（刻意：不新增第二条公开流） |
| F-05 后半 | 可靠事件与投递状态机 | ✅ | `team-hub/event-delivery.mjs`、`server.mjs`（`broadcastAudit` 重写、 `/api/event-delivery`） | `event-delivery.test.mjs`（31 例）+ `event-delivery-wiring.test.mjs`（7 例真 HTTP） | — |
| F-06 | Run 状态机 / 验收 / 交接 | ✅ | `team-hub/run-store.mjs`、`orchestrator/acceptance/`、`orchestrator/pipeline/` | PRT-307/308/309/310/311/312 | — |
| F-07 | 上下文快照 | ✅ | `runtime/context/*`、`team-hub/context-store.mjs` | PRT-401～409；套件 `context-store`、`context-export`、`context-retention` | — |
| F-08 | 模型档案与绑定 | ✅ | `team-hub/model-store.mjs`、`binding-store.mjs`、`probe-service.mjs` | PRT-501/502/506/507 | — |
| F-09 | 密钥库与 Run 凭证 | 🟡 | `security/secrets/*`、`product/secrets.mjs`、`product/launcher/{secrets-check,run-credential*,secrets-acl-runner}.mjs` | PRT-505/509；`secrets-acl-runner.test.mjs`（12 例，含真 `whoami`+`icacls`） | 见 §2「本轮已关掉的」；**C1～C4 是产品裁决**，属 ⏸ |
| F-10 | 权限、审批与审计 | ✅ | `team-hub/permission-engine.mjs`、`approval-*.mjs`、`context-plan-store.mjs` | PRT-601～607 | — |
| F-11 | DSH 强制面（hard floor / sandbox / preset） | 🟡 | `runtime/dsh-composition/*` | PRT-213/214/253 的一部分 | 见 §2；G1/G4、G2/G3/G4/G6 需人裁决 |
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
          run_events / pack_install_facts / role_packs
+ 路由:   GET/POST /api/automation/*（6）、/api/compaction/*（5）、
          GET /api/event-delivery、GET /api/runtime/run-events、
          GET /api/usage/{totals,rollup}（2）、
          GET/POST /api/packs/facts、GET /api/packs/{account,export}（4）、
          GET/POST /api/role-packs、GET /api/role-packs/export（3）
~ 源文件已变更：team-hub/server.mjs、team-hub/run-store.mjs、
                team-hub/automation-store.mjs、team-hub/pack-facts.mjs、
                team-hub/role-pack-store.mjs
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
| F-18 | 经验图谱/摩擦学习 | 🟡 | `plugins/src/experience.ts`、`experienceVotes.ts`、`experienceRecall.ts` | 摩擦打分/草稿/投票/晋升门限**都已实现且有用例**，但落在**旧的 `plugins/` 路径**上，未纳入 Product Runtime。§8 给的落点是「Context、Compaction、Knowledge」——三者都已就绪，缺的是把这一族搬过来 |
| F-19 | Employee / Role Pack | ✅ | `runtime/employee/role-pack.mjs`、`team-hub/role-pack-store.mjs`、`server.mjs`（3 条路由） | 本轮落地。★ **七类版本一个不少**（prompt / skills / tools / permissions / model / connectors / budget），缺一类**不给默认空值**——`connectors: []`（显式"就是不用"）合法，**没写这一节**非法：一个"缺连接器就当没有连接器"的包与一个"作者忘了写、而它静默地没有连接器"的包在运行结果上是同一个东西。★ **版本号是标签、内容哈希才是身份**：承载内容的四类必须带 `hash`，而对账把两种漂移**分开报**——版本变了（`VERSION_DRIFT`，显眼）与版本没变而内容变了（`CONTENT_DRIFT`，阴险到按版本号比对会报"一致"）。★ 岗位包属于 **agent 平面**（`EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement:false`），强制面字段在**每一层嵌套对象**上都被拒，连接器一节只许出现引用、出现凭证字段单独成码。★ 冻结**改不动**：主键 `(scope, role_pack_id, version)` 让多版本同时存在（塞进就地更新的 `employee_manifests` 会让第二次修改覆盖第一次的答案），同版本同内容幂等、同版本不同内容 **409** |
| F-20 | Pack Manager | 🟡→✅ | `runtime/packs/{manifest,authority,store,compiled-plan}.mjs`、`team-hub/pack-facts.mjs` | 校验面**齐全**：签名三级（`builtin/signed/unsigned`，无验证器即 `unsigned`——"没法验"不是"验过了"）、依赖与权限（`authority.mjs`）、Runtime Contract、预检结论**必填**。★ **本轮关掉三处缺**（此前本表误记为 ✅）：① **`rollback` 已实现**——账上多一类**自己的**记录（不与 upgrade 混），四条拒绝各有具名码；② **账可持久化**——`snapshot()` / `createPackStore({history})`，坏账**整本拒绝**（跳过坏记录会让"这几个包没装过"与"这几条记录坏了"变成同一个读数）；③ **team-hub 保存安装事实**——`pack_install_facts` 表 + 4 条路由，`GET /api/packs/account` 的形状**原样**能喂回 `createPackStore`，`GET /api/packs/export` 给出可提交进 Git 的审阅文本（不含包内容/凭证） |

## 4. P2：扩展面

| 编号 | 名称 | 状态 | 依据 |
|---|---|---|---|
| F-21 | Connector / MCP 注册表 | ⬜ | 无代码。需要"服务/工具策略、风险分级、密钥引用、故障隔离"四件一起设计 |
| F-22 | 后端与工作区 | 🟡 | `orchestrator/workspace/*`（git worktree）。§2 明写「不把 worktree 当安全沙箱」 |
| F-23 | 多 Harness 路由 | ⏸ | §2 明写「**不在契约稳定前同时支持多个 Harness**」——这一条**是设计决定，不是缺口** |
| F-24 | ACL 与安全姿态 | 🟡 | `team-hub/read-auth.test.mjs`、`read-open-loopback.test.mjs` 已覆盖读面矩阵；多用户写面 ACL 未做 |
| F-25 | 外部渠道 | ⏸ | §9 明写「多用户、多 Harness、远程后端和外部渠道**按真实客户需求推进**」 |

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

---

## 6. 怎么复跑这份对照表里的每一条

```bash
# 全量门禁（含本文引用的每一套用例）
node scripts/ci/run-ci.mjs

# 只跑本轮新增的套
node scripts/ci/run-ci.mjs --only test   # 然后在输出里找：
#   run-events / event-delivery / automation / compaction / usage-rollup / pack-facts / role-pack

# 单独复跑
node --test team-hub/run-events.test.mjs
node --test team-hub/event-delivery.test.mjs team-hub/event-delivery-wiring.test.mjs
node --test team-hub/automation-store.test.mjs team-hub/automation-http.test.mjs
node --test team-hub/compaction-store.test.mjs team-hub/compaction-http.test.mjs
node --test team-hub/usage-rollup.test.mjs team-hub/usage-rollup-http.test.mjs
node --test team-hub/pack-facts.test.mjs team-hub/pack-facts-http.test.mjs
node --test runtime/employee/role-pack.test.mjs team-hub/role-pack-store.test.mjs team-hub/role-pack-http.test.mjs
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

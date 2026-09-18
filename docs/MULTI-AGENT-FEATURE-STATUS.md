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
| F-11 | DSH 强制面（hard floor / sandbox / preset） | 🟡 | `runtime/dsh-composition/*` | PRT-213/214/253 的一部分 | 见 §2；G1/G4、G2/G3/G4/G6 需人裁决。★★ **另有一条本轮新发现（§5.2）：三道范围检查在生产里从未被注入**——`enforcementSurfaces()` 实测 `pathScope:false` / `whitelist:false`，`execution-scope`/`external-api-scope` 连端口都没有。这不是"F-11 没做"，而是"做了但没装上"；裁决见 §5 第 14 条 ★★★ **[2026-09-18 订正·逐句] 上面这段有三处要按新读数读**：① 「三道范围检查在生产里**从未**被注入」**对第一道已不成立**——`pathScope`（PRT-604）**已经接进生产组合根**（`40d2d60`）：范围表从**部署配置**来（`LEGION_PATH_SCOPE`，登记在 `runtime/config-schema.mjs`），经 `scope-port.mjs` 变成桥要的那个函数，在 `root-row.mjs` 接上；`production-scope-wiring.test.mjs` ①b 钉住"配了翻成 true"。② 所以那个 `pathScope:false` 读数**不是**"没接线"的证据，而是"**这次装配没有配范围表**"的读数——**没配 ≠ 接了个空的**，两者在读数上分得开了（这正是 `scope-port.mjs` 存在的理由）。③ ★ 「`whitelist` 连端口都没有」**是错的**：`createEnforcementBridge` 的入参表里**有它**（`runtime/dsh-composition/tool-request.mjs:517`，注释 `PRT-603 的岗位白名单`），`assembleEnforcement` 也照传（`assemble.mjs:135`/`:168`）——**位置在、没人给它值**。真正连位置都没有的只有 `execution-scope`（PRT-605）/`external-api-scope`（PRT-606）两道。★ 一句话：`pathScope` 已接（**配了才拦**）、`whitelist` **有位无值**、另外两道**无位** |
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
| F-15 | 用量/费用与预算 | 🟡 | `team-hub/budget-ledger.mjs`、`team-hub/usage-rollup.mjs`、`runtime/contracts/price-table.mjs` | PRT-503/510/511 已落地；**成本刻已采**（$0.045086 实测）；本轮补上**五维度汇总**（`usage-rollup.test.mjs` 12 例 + `usage-rollup-http.test.mjs` 6 例真 HTTP）。`peak-resource` 仍缺 ★★ **[2026-09-18 订正]** 本格此前写的是「`peak-resource` 仍缺（PRT-009 🟡，阻塞于 **PRT-011 平台裁决**）」——**两处都过期了**：① **PRT-011 早在 2026-09-11 就裁决为路线 C**（`docs/superpowers/prt/PRT-011-dsh-distribution-decision.md:4`），而且它裁的是**分发形态**、与峰值资源的**目标平台**无关，所以"阻塞于 PRT-011"这个框架本身是错的；② **PRT-009 已由 🟡 转 ⏸**（2026-09-18 业主裁定），因为两个采样器**均已落地**（`product/launcher/peak-resource.mjs` 经 supervisor、`orchestrator/worker/run-peak-resource.mjs` 按 Run 开合窗口），剩下的**只有一次真实 Legion 部署的实跑读数**——它卡在 `docs/STATUS.md` §4 第 15 条那个**已裁定的永久平台边界**（Windows 上不会有自动执行）。⇒ 本格现在应当读作：**缺的不是"谁来决定"，是一次本机永远发生不了的外部观测**。★ 另：记录层那一半也已打通（`run-record.mjs` 现在带 `peakResource`，判据 47 例、变异 6/6），所以"采了也没人接"不再成立——**剩下的最后一根线在 `launcher.mjs` 的 `persistRunRecord()`**，而那个文件是另一个会话的在制品 |
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
| 9 | **PRT-316 的开工资格（台账里唯一的 ⬜）** | 项目主（★ 见下方订正；★★ 2026-09-18 再订正：**今天只剩时间那一条**） | 前置条件**曾经**被记成"只有排期规则"（`0db37af` = 2026-09-10，一个发布周期 = 14 天（`PRT-909-release-checklist.md:63`）⇒ 最早 **2026-09-24** 可开工），并附带一句「热点文件争用那条**已过**（`hot-file-churn.mjs` exit 0，当前 2/40、峰值 14/40）」。★★★ **那句订正前的读数是用一个坏掉的探针量出来的**（见本节末）：修好之后**当时读数 9/40 > 阈值 2 ⇒ 未降温**，即"churn 门禁已过"这句**不成立** ★★★★ **2026-09-18 再订正：这一句今天也不成立了。** 在 `main = 677c197` 上复跑 `node scripts/prt/hot-file-churn.mjs --json`，`verdict = { recentMax: 0, recentPerFile: { 'plugins/src/index.ts': 0, 'team-hub/server.mjs': 0 }, historicalPeak: 11, absoluteBar: 2, cooled: true }` ⇒ **已降温**，exit 0。那个 9/40 是 **2026-09-17 那一时刻**的读数：此后 40 个提交里两个热点文件**一次都没被碰过**（`team-hub/server.mjs` 最近一次触及是 `1b0ade3`，已在 54 个提交之前），窗口滑走了。 ★★ **由此得出一条比"到底过没过"更要紧的纪律**：这个数是**窗口长度为 40 的函数**，随 `HEAD` 每落一个提交就移动一次——把"churn 已过"或"churn 未过"当成一条**站得住的结论**写进文档，几天之内就会在**两个方向**上都变错。本节先前那句"未降温"与更早那句"已过"其实是**同一种错误**（把移动读数写成了事实），只不过一个偏保守、一个偏乐观，而**偏保守的那一个更难被发现**——它读起来像是有人在谨慎。正确的记法是**把 HEAD 一起记下来**（探针自己就打印 `HEAD <sha>`），并在**做决定的那一刻**重量一次，而不是引用一段历史读数。 | ★ 于是 PRT-316 有**两条**独立条件：① 时间（2026-09-24）；② churn 门禁。**2026-09-18 的读数**：② **已满足**（0/40 ≤ 2），① **还差 6 天**。★ 所以本条的处置改为：**到期那天把 ② 重量一次**（不是"到期即可开工"）——若那次读数是 `> 2`，要开工就得先回答"谁在最近的窗口里改了 `team-hub/server.mjs`"。★ 附带一条：`hot-file-churn.test.mjs` **18/18 绿**，其中两条专门钉住那两种错误写法（`A^..B` 的区间语义、以及 `--no-walk` 会被关掉路径过滤），所以上面这个 0 是**修好的探针**量的。★ 若产品要求**提前**开工，请显式说明——那等于自愿放弃那个发布周期的冷却理由，**并且**要接受在热点文件上追加改动 |
| 10 | **F-22 / F-24 是否按客户需求推进** | 产品 | F-22 的**远程后端**与 F-24 的**多用户写面 ACL** 都属 §9「按真实客户需求推进」；当前落地范围（worktree 工作区 + 只读面 ACL 矩阵）**按设计已完成** | 不推进则这两条长期停在 🟡（**这是设计决定，不是缺陷**）。★ 注意 §2 明写「**不把 worktree 当安全沙箱**」——若某天真要跑不可信代码，那不是"补 ACL"，而是换隔离机制 |
| 11 | **PRT-509 剩余三条** | 环境 + 项目方 | ① win32 上 `0600` **本机无法证明**；② **生产默认句柄工厂**（走 `resolveDshBaseBundlePatchPath` 解析器）**只有注入式覆盖**，真实调用没跑过；③ 已证明的是"**DSH 的凭据提供方**从 Legion 材料化的文件里读到了值"，**不是**"一个真 DSH 进程启动时把那份覆盖层文档解析出来了" | 三条都**如实记为 🟡 的剩余**，不冒充已闭合。②③ 需要一次**真 DSH 进程启动**的现场（有 `DSH_CHECKOUT` 时可跑，但没有覆盖层真实生效的那条路径）  ★★★ **2026-09-18 订正：本格那句"三条都如实记为 🟡 的剩余，不冒充已闭合"已过期——PRT-509 已于 2026-09-18 转为 ✅（业主裁定 `065bc57`）。** 原文保留。该裁定**逐条对齐了正好这三条**：② 已于 2026-09-17 关上，且带**破验**（把那个默认分支换成一句 `throw`，19 条仍全绿、只有新加的那条红）；③ 已于 2026-09-17 关上，关闭物是 `product/launcher/run-credential-dsh-process.test.mjs`（真 `apps/…` 子进程）；① win32 `0600` **不是交付缺口，是已裁定的永久平台边界**（与 `sandbox-enforcement=partial` 同类，见 `docs/STATUS.md` §4 第 15 条）。★ **本轮的独立复核**（不是引用裁决，是自己跑的）：`run-credential-materialization.test.mjs` **21/21**；`run-credential-dsh-process.test.mjs` **1/1、skipped 0**，且它是**真的**跑了——真宿主进程 **2.8s**、`settle=natural`、`exit_code=0`、证据落盘，不是走那条"没有 `DSH_CHECKOUT` 就整条 skip"的退路。★ 因此本格现在应当读作：**三条都已闭合或已裁定，不再需要"环境 + 项目方"提供现场**；若仍要挂一条，只能挂①那个已裁定的平台边界（本机不可测），而它**不是**外部输入。★ 另：本条此前要"一次真 DSH 进程启动的现场（有 `DSH_CHECKOUT` 时可跑）"——那个现场**已经跑过了**（上条读数），所以"需要现场"这个说法本身也不再成立。|
| 12 | **F-19 Role Pack 的"七类版本"范围确认** | 产品 | 七类（prompt / skills / tools / permissions / model / connectors / budget）是否就是这个岗位包的全部版本面 | 若产品认为还缺一类（例如"环境"或"路由"），现在加是**新增一节**；等到有真实岗位包在库里之后再改，就要处理"旧包缺这一节"的兼容问题（而现在按设计**拒绝缺节**的包） |
| 13 | **F-21 判定面的接线资格**（★★★ 2026-09-18 **两次**订正：并发那条已过期 ⇒ 真实阻塞是**数据**；而第 19 条选定后本条**仍未解开** ⇒ 它有自己的决定，见"缺口"末段与裁决栏末段） | 项目主 + 产品（★ **要裁决的是"连接目标放哪"**，不只是"确认可以动文件"） | 把连接器判定接进 `createEnforcementBridge().preExecute`（DSH `tools/pre-execute` 瀑布，见 §4.2）。**当时唯一没做的原因是并发**：同一工作树上另一个 agent 进程正在改那个文件。★★ **本批核实：并发那条已经过期，但清掉它并不解开本条。** ① 那个改动**已经落地**（`f291f9c`，`runtime/dsh-composition/tool-request.mjs` 最后一次改动），且另一个 agent 今天的工作树里**不含** `runtime/dsh-composition/` ⇒ 并发确实没了。② **但接线接不上，缺的是"判定要对着什么判"**：`runtime/connectors/registry.mjs` 的 `createRegistry` / `declareConnector` **全仓库只有它自己的用例在调**（`git grep` 命中只在 `registry.mjs` 与 `registry.test.mjs`），而**声明**（策略 / 风险 / 工具清单 / transport / secretRef）的唯一真相在**控制面** `team-hub/connector-store.mjs`。③ 执行面**没有任何渠道**拿到那些声明：`runtime/contracts/*.mjs` 与 `run-floor.mjs` 提 `connector` **零命中**；`runtime/dsh-composition/` 下的**生产**代码提 `connector` **零命中**；`runtime` 进程的 `envNames` 故意**不含** `TEAM_HUB_TOKEN`（`product/process-manifest.mjs`）。④ 岗位包（`runtime/employee/role-pack.mjs:184`）里的 `connectors` 是 `Object.freeze(['id','version'])`——**只是引用，不含声明**，拿它判不出 allow/deny/ask。⇒ **本条的真实阻塞与第 14/15/18 条是同一个**（第 19 条那道"数据进 `RunRequest` 还是注入 `TEAM_HUB_TOKEN`"）。★ 这与第 19 条自己的标题（"第 13/14/15/18 条其实是**一条**决定"）**一致**；只是本条"缺口"里那句"唯一没做的原因是并发"是**当时**的事实，过期后**没人改**，而它会让读到这一格的人**以为清掉并发就只差一次编辑**。★★★ **但最后那句在本批当天又被实测修正了**：真实阻塞**不是**第 19 条那道二选一，而是**本条自己的一个决定**——执行面要的两半里，**连接目标**（`command`/`url`）在控制面**不存**、全仓**零生产者**（`4290254`，读数见裁决栏末段）⇒ 第 19 条选定「放进 `RunRequest`」**并没有**解开本条。 | 不接则 F-21 停在 🟡：登记、冻结、审计、导出都能用，但**没有任何一次真调用被它拦过**——"闸门写好了、还没装到门上"。★ 若产品认为"现在产品里没有 MCP 客户端，接线是给不存在的东西装门"，**请显式说明**，那我就把 F-21 的定位改成"控制面已就绪、判定面随 MCP 客户端一起做"，并在文档里这么写。★★ **订正后的可选方案**（本批）：既然真实阻塞是第 19 条，那么第 19 条一旦选定，本条自然解开——**不需要单独裁决**。⇒ 请把本条**并入第 19 条一起回答**；★ **但见本格末段：这句当天就被实测证伪了**；★ 我**没有**擅自接线：在没有声明的执行面上装这道闸，它只会对所有连接器调用**一律拒绝**（那与"没装"在用户眼里一样），而"反正它更严"这个辩护**不成立**——收成"全拒"会同时拒掉将来合法的连接器调用，表现成"工具莫名其妙失败"。★ 顺带一处**规格支持**：`docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md:106` 把"外部网络/连接器"列在 `tools/pre-execute` 动态检查的**首批纳管**名单里 ⇒ 接线本身是规格要的；但同文件 `:164` 又写"**只有在上述闭环稳定后**，才扩展……连接器"，所以"现在接不接"确实仍是一个**排期**决定，那就更该与第 19 条一起答。★★★ **末段（2026-09-18 同日证伪）：本条不是"并入第 19 条即可"，它有自己的一个决定。** 第 19 条**已经**选定（业主裁定「放进 `RunRequest`」），而另一个会话按那份裁决文件自己的硬约束（**不许凭空造数据**）**开工前复核**，量到连接器这一条**喂不进去**（`4290254`）：① hub 的 `normalizeDeclaration()` 产出的字段是 `version / connectorId / version_label / transport / policy / tools / secretRefs`——**没有 `command`，也没有 `url`**；② 把这份记录**原样**喂进执行面的 `createRegistry()` ⇒ 具名拒绝 `connector-transport-target-missing`（"transport 是 stdio，必须给 command"）；③ 反向对照：**只**补上 `command` ⇒ 就建起来了（`connectors() = 1`）。⇒ 执行面要**两半**：**策略**（hub 存）与**连接目标**（`command`/`url`，hub **不存**，且**导出时也刻意不含**——既有用例⑤的标题就是「含权限面与引用**名**，**不含命令与 URL**」，所以那是**有判据守着的设计性质，不是遗漏**）。而连接目标在全仓**零生产者**。⇒ 本条的真实阻塞是**它自己的一个决定：连接目标放哪**（四个候选方向见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §7.4），**不是**"照抄 PRT-214 的形状"那种纯代码工作量。★★ 那个会话还立了一条**会响的判据**（`team-hub/connector-store.test.mjs` 用例⑧，23/23，含 http/sse 缺 `url` 的同一具名码），并做了破坏性验证（关掉执行面那条判据 ⇒ 用例⑧变红，还原后逐字节相同）⇒ **"接上了它就会红"**。★ 他们那句话值得抄在这里：**"没接线看得出来，接错了看不出来。"** ★ 我**没有**擅自接线（理由见上），这一条我两批都只动了**文档**。 ★★★ **[2026-09-18 第三批订正·这一条的施工分两半] 上面那句"不是纯代码工作量"是对的，但**理由还不完整**：即使把连接目标那个决定做掉，把 `decide()` 接进 `preExecute` 也**仍然接不出一条能按设计动作的链**。逐条量出来的读数（写在 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §10）：① `decide()` **读得到**熔断器状态（`registry.mjs:556` `circuits.get(id)`，`:565` 开路即 `deny` `connector-circuit-open`，`:573-585` 半开只放行一次探针）；② 而改熔断器状态的**只有** `recordOutcome({connectorId, ok, error, atMs})`（`:607`，阈值 3 / 冷却 30 s），它的**生产调用方是 0 处**——全仓 `grep` 只命中定义与它自己的用例；③ **强制面桥没有"执行后"的钩子**：`createEnforcementBridge()` 的返回对象（`tool-request.mjs:876-901`）只有 `project` / `projectionFor` / `guard` / `preExecute` / `answerer` / `ledgerOf` / `ledgerHashes` / `contradictions` / `assertNoContradiction` / `enforcementSurfaces`——`preExecute` 是**判定**点、`onDecision` 是**事后通知**（那时决定已作出去了），**没有任何一处**看得到"这次调用最后成功了没有"；④ `enforcementSurfaces()`（`:894-900`）**恰好 5 个面**，**没有** `connector` 这一格 ⇒ 少装了什么都**不会有人知道**。⇒ **只接判定面 = 接了一个永远合闸的熔断器**，而且这一版**一行错都不报**、用例全绿、`enforcementSurfaces()` 也照常。这比 §7 那次更坏：§7 会在运行时具名拒绝（看得见），这一次看不出来——**§7.4 那句"没接线看得出来，接错了看不出来"要再往前一步：接了一半，也看不出来。** ★ 于是这一条的施工顺序应当是：**先定"执行结果在哪一层可见"**（第二半今天没有接缝；它与**第 15 条**——`tool_calls` 写入方为 0——是**同一个缺口**，不是两个问题），**再一次性接两半**。★ 本批**没有动任何代码**：这不是"来不及"，是 §3 那条硬约束的直接后果——这里能造的不是数据，是一个**看起来完整、永远不会跳闸**的接缝。⚠️ 边界：我没有去核 DSH `tools/` 那一侧有没有执行后钩子（`pre-execute` 是**前置**瀑布，名字就说清了位置），所以精确的意思是"**本仓的强制面桥**没有这个接缝"，**不是**"DSH 不提供任何钩子"。 |
| 14 | ★★★ **三道范围检查的生产接线（PRT-603/604/605/606）** | 产品 + 项目主 | **这三道检查今天在生产里一次都不跑**（读数见 §5.2）。要决定的是：**这一次 Run 的范围表（读根/写根/平台、命令/网络/MCP 授权、外部 API 读写端点）从哪来、挂在哪一层**。可选方向：(A) 随 Run 的载荷到达，像 PRT-214 的下限/授权身份那样由 `runtime-host-registrar-row.mjs` 按 Run 安装；(B) 由岗位包（F-19 的 `permissions` 一节）派生，装配期算一次；(C) 仍留在 hub 侧判（那 `path-scope.mjs` 这类执行面检查器就应当明确废弃，而不是挂在桥上当"可选端口"） | 不决定则**越界路径今天拦不住**：`tool-request.mjs:639` 在 `pathScope === null` 时返回"放行"，而生产从不注入。★★ 我**没有**擅自接线，因为凭空造一份范围表正是 PRT-253 §3 明令禁止的"不发明任何默认值、替身或暂时放行"——那会让"没接线"与"接好了"在读数上同形。本轮的处置是把读数钉住（`production-scope-wiring.test.mjs` 5 例 + 5/5 变异），所以**接上了它会红**。★ 另注意：三个台账行（PRT-604/605/606）的 ✅ 依据是"模块 + 自己那套用例"——按本表 §0 那条告警（"只有自己的用例驱动的原语一律 🟡"），它们的口径需要在台账里对齐  ★★★ **2026-09-18 订正（当天更晚）：上面那句"这三道检查今天在生产里一次都不跑"与"我**没有**擅自接线"**已经不再成立**——三道里的**第一道（`pathScope`，PRT-604）已经接进生产组合根**（`40d2d60`）。逐条对齐，原文保留：① **接线是真的、而且不是"凭空造一份范围表"**：范围表从**部署配置**来（`LEGION_PATH_SCOPE`，登记在 `runtime/config-schema.mjs`），由 `runtime/dsh-composition/scope-port.mjs` 变成桥要的那个函数（`pathScope(projection)`），在 `root-row.mjs` 接上。**没配**时端口仍是 `null`、读数仍是 `pathScope:false`——**没配不等于接了个空的**（`production-scope-wiring.test.mjs` ①b 钉住"配了翻成 true"）。② 所以本格"可选方向"实际没有走 A/B/C 中的任何一条，而是走**第 4 条**：数据由**部署方**在配置里给出（`§9.2 第 3 步`"汇合到同一个部署配置读取点"）。A/B/C 那道裁决**仍然只对另外两道**（`execution-scope` / `external-api-scope`）有效。③ "不决定则越界路径今天拦不住"要按**条件**读：**没配 `LEGION_PATH_SCOPE` 的部署仍然拦不住**（今天这是默认），配了才拦得住——与 §5.2 那张两行表一致。④ `production-scope-wiring.test.mjs` 现在 **6 例**（原 5 例 + ①b），且**它确实红了**——"接上了它会红"这条预言当时写对了，红的时候就照本格末句去改了账（本段就是那次改账）。⑤ **仍未接的**：`whitelist`（岗位白名单）与 `execution-scope`（PRT-605）/ `external-api-scope`（PRT-606）两道——**桥的参数表里连它们的位置都没有**。⑥ ★ 一条**可达性**上的机器可核证据（同一次改动）：`runtime/dsh-composition/path-scope.mjs` 与 `scope-table-binding.mjs` 从"不可达"变成**可达**（基线 49 → 47）。"判定写好了、只是没人给它一份表"这句话，现在有了一条会自动红的读数。 ★★ **2026-09-18 续：上面这条"口径不一致"现在有了一个机器可核的独立记录。** `docs/superpowers/prt/prt-reachability-baseline.json` 给这两个模块**各自带了一个 `class`**：`runtime/dsh-composition/execution-scope.mjs` 与 `runtime/dsh-composition/external-api-scope.mjs` **都是** `class: "gap"`，且 `reason` 明写「§5.2：连端口都没有 ⇒ 裁决处：§5 第 14 条（三道范围检查的生产接线）」——**reason 直接指向本条**。而 `runtime/dsh-composition/path-scope.mjs`（PRT-604）**不在**这份基线里（已可达，实测）。⇒ 三行的 ✅ 分两种：PRT-604 有**接线为据**（`40d2d60`）；PRT-605/606 的 ✅ 与**本仓库自己那份基线文件**直接冲突，且与台账 §0 告警「只有自己的用例驱动的原语一律 🟡」指向同一结论。★ **待裁决（两条都要写清理由）**：要么把 605/606 改 🟡 并接线，要么把那条告警**明确豁免**这两个模块。不能两样都不做——*一个「✅ 但没有生产调用方」的记录，与一个「这道检查在生产里跑着」的记录，下一个人读起来是同一个东西。* ★ 而且方向是**偏乐观**的那一边：它让人以为那两道检查在拦，实际它们一次都没被调用过。★ 本轮**没有**改这几行的状态：① 状态口径由项目方（台账的读者）定；② `PRT-PROGRESS.md` 此刻是**另一个会话的在制品**，按纪律不得触碰。 【2026-09-18 新读数·只订正事实，不改裁决】**本条开头那句"这三道检查今天在生产里一次都不跑"对 `path-scope.mjs` 已经**不成立**（对 `execution-scope` / `external-api-scope` 仍然成立）。**已核到端到端**（不是"有人 import 了它"）：`patch-layer.mjs` 的 `PATCH_LAYER_ROWS` 加载 `plugins/pre-execute-row.mjs` → `plugins/root-row.mjs:497` 真的调 `scopePortFromEnv({ env })`（读不出就 `throw`，**fail closed**）→ `:508-514` 把 `scope.port` 传进 `installEnforcementRoot({ pathScope })` → `scope-port.mjs:169` 调 `checkPathScope(...)`。落在 `40d2d60`（§9.2 第 4 步），**不是本会话做的**。 ⚠️ 但这**不等于"默认就拦"**：**没配**范围表时 `port` 是 `null`，而 `tool-request.mjs:639` 那句 `if (pathScope === null) return undefined` ⇒ 那次缺席仍然落到**放行**。所以"越界路径今天拦不住"**只在没配范围表的部署上**仍然成立，而这一条正是本行要裁决的那件事——**裁决未变**。 ★★ 值得单独记一句的是**这件事是怎么被发现的**：**不是我读文档看出来的，是可达性探针的红报出来的**——而那条红**同时含一条假消息**（`external-api-scope.mjs`，由我自己那张记账表的键名冒充清单造成，见 `boundary-facts` 的判据 `criteria-files-do-not-impersonate-manifests`）。*一半真、一半假的红，比全假更难查，因为它对了一半——而人会顺手把两半一起"按指示清掉"。* ★ 现状读数（同一探针）：入口 58 / 可达 224 / **不可达 47**（`by-design 13` / `gap 26` / `deliberate 8`），与基线一致。 ★★★ **[2026-09-18 第三批订正·这三道不是同一种缺口]** 上面把三道写成一件事（"这三道检查今天在生产里一次都不跑"），而逐道量下来它们是**两类**：① `pathScope`（PRT-604）**已经接进生产组合根**（`40d2d60`）；② `whitelist`（PRT-603）**端口在，但算这个值的模块自己没在跑**——桥要的端口形状是 `(projection) => {allowed, rule, reason}`（`tool-request.mjs:751-757`），而 `employee-manifest.mjs:317` 的 `permitsTool({permit, toolName, capabilities})` **恰好返回这个形状**（L315 的 JSDoc 逐字写着），可是它**零生产调用方**（全仓 grep 只命中定义与自己的用例）；它要的 `permit` 只能由 `narrowToGrant({manifest, grant})` 产出，而那个函数的**生产调用点全仓只有一处**：`runtime/packs/authority.mjs:759`——**`[gap]`，零生产 importer**（`normalizeManifest` 的两处生产调用 `authority.mjs:752` / `compiled-plan.mjs:313` 同样是 `[gap]`）。⇒ **`whitelist` 至少还压着第 19 条那个包层**：一个配置键能给出 `grant`（宿主授予的那一半），**给不出** `manifest`（岗位包产物）那一半。★ ③ 真正属于本条（"数据从哪来、挂哪一层"）的只有 `execution-scope`（PRT-605）与 `external-api-scope`（PRT-606）——它们**连端口都没有**。⚠️ **本批只改了措辞、没有改判归属**：`permit` 的另一半（`hostGrant`）从哪来、算不算部署配置，我**没有量**，所以不擅自把 `whitelist` 整条移到第 19 条。详见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11。★ 顺带记一条与基线 `$comment` 对上的机制：**可达性是逐模块测的**——`employee-manifest.mjs` 在基线里**是可达的**（不在 47 条里），而它里面那个正是端口要用的函数**零生产调用方**；"模块可达"与"这条链通了"是两件事，这一次有了一个可以指名的例子。|
| 15 | ★★ **PRT-610 执行面的落账点** | 项目主 + 产品 | `tool_calls` 的**表、读面、就绪证据的产出点**已经接上（本轮），而**写入方仍然是 0**：要接 `recordToolCall`/`markDispatched` 得先定"一次工具调用在哪一层落账"——`tools/pre-execute` 是**判定**点，而 `markDispatched` 必须在**真的派发之前**落库，那个位置比判定点更靠下 | 不接则这笔账永远是空的：表建好了、三条路由能读、就绪判据能回答"在不在记"，而**一条记录都不会有**。★ 这与第 14 条是**同一个决定**（执行面的载荷里今天没有这些字段），不是代码量问题。★★ 另：`release-gate.mjs` 的 `evaluateReadiness` **本身也零生产调用方**，所以"证据有了产出点"之后仍没有人在**发布决策**里读它——本轮只补齐了能被代码单独关闭的那一半 |
| 16 | ★★ **阶段 9 产品动作的 CLI 面（PRT-903/904/905/908/909、PRT-712、PRT-707）** | 产品 | 这批模块（发布检查清单、隐私说明、保留策略、数据分类、数据导出、卸载、支持手册、首次运行向导、指标数据源、崩溃报告）**全部自带用例、全部 ✅、全部零生产入口**（系统盘点见 §5.3）。要决定的是：**这些"产品级动作"由谁触发**——`legion` 的子命令？一个独立的发布/运维 CLI？还是只作为发布流程里人工跑的一次性脚本？ | 不决定则它们**对用户不存在**。台账自己为 PRT-509 写过这句话：「一个功能没有入口，与这个功能不存在，对用户来说是同一件事」。★ 其中 `metrics-source.mjs` 的台账行已如实写了"还没有界面/CLI 消费者"，另外六个没有写。★★ 另：PRT-801～813 的升级执行链**看起来**也在这个清单里，但它**不是**缺口——`runtime-install.mjs` 的注释写明 Launcher **刻意不 import** 它（进程卫生：Launcher 要在那些依赖起来之前先把进程看好）。**不要**给 Launcher 补这个 import，见 §5.3。它的执行者同样取决于第 1 条（PRT-011 DSH 分发形态） |
| 17 | ★★★ **PRT-707 的两份实现用两个不同的模型密钥引用名** | 产品 + 项目主 | PRT-707（首次运行向导）在仓库里有**两份实现**：**活的**是 `cli.mjs` 的 `--wizard` 分支（内联，写 `model/api-key`），**死的**是 `first-run.mjs`（636 行 + 一整套用例，算 `legion/model/<profileId>`）。要裁决的是：**模型密钥的引用名用哪一个**——Legion 自己的三段式（`legion/model/<id>`，与 `credential-materializer.mjs` 文件头那句"Legion 的模型引用是 `legion/model/<profileId>`"一致，但 `planDshLookup()` 实测 `addressable:false`），还是运行时物化的那一段（`model/api-key`，端到端通、被 drift 用例钉着）？**或者**：两份实现留哪一份、另一份删掉还是明确废弃？ | ★★ **不要**把 `first-run.mjs` 直接接上去。它写进 hub 档案的 `secretRef` 是 `legion/model/<id>`——**三段**，而 `security/secrets/credential-materializer.mjs` 的 `planDshLookup()` 对三段引用返回 `{addressable:false, space:null}`（在 `refs` 与 `records` 两个键空间里**都没有位置**）。接上它的后果**不报错**：向导报"模型已配置"，而运行时拿不到钥匙——正是该模块文件头点破的那种失效（"文件看起来完整、就是少了最要紧那一把钥匙"）。★ 本轮**没有**替任何一方改代码：两份**各自都自洽**，裁决它需要产品决定。已把它变成读数：`product/launcher/wizard-wiring.test.mjs`（5 例，**今天全绿**，7/7 变异成立）——它红的那天，正是有人接线或对齐的那天 |
| 18 | ★★★ **F-18 / F-19 的"执行面一半"要谁来调用**（可达性探针新读数，见 §5.4） | 产品 + 项目主 | 从**真实入口**跑 import 图，`runtime/experience/{friction,graph}.mjs`（F-18）与 `runtime/employee/role-pack.mjs`（F-19）**从任何生产入口都到不了**——只被自己的用例驱动。hub 侧**是**接上的（`experience-store`/`role-pack-store` 经 `server.mjs` 可达），缺的是**产出者**：没有任何东西算摩擦分、没有任何东西记图边、没有任何东西建岗位包。要裁决的是：**这三件事由谁在什么时候调用**——执行面在 Run 结束时算（那要定"从哪拿到 validations/attempts"）？还是控制面在写账之前算？★ 同一族：PRT-610 的 `recordToolCall` 写入方（第 15 条）、三道范围表（第 14 条）——**三条都卡在"执行面的载荷里今天没有这些字段"这同一个决定上** | 不决定则这三块能力**对用户不存在**：账能读、读数是干净的、用例全绿，而**一行都不会被写进去**。★ 这三行的 ✅ 依据是"模块 + 自己那套用例"，与台账 §0 自己那条告警（「只有自己的用例驱动的原语一律 🟡」）**口径不一致**。★★ 本轮**没有**改这三行的状态——✅/🟡 的口径由台账的读者（项目方）定，"改状态"与"补证据"是两件事。★★ 另：另有 4 个不可达模块（`runtime-host-registrar-row.mjs`、`runtime-contract-server-row.mjs` 及其传递依赖 `run-floor.mjs` / `runtime-contract-server.mjs`）**本批已由 `in-flight` 改判为 `gap`**——那份"另一个 agent 正持着它们"的工作**已经提交**（`e0b83af` / `69da8fd` / `5c1d698`），而模块**仍然不可达**。它们不在任何清单里（`PATCH_LAYER_ROWS` 只声明 4 行、`legion-host.patch.yml` 只有 2 行），接线的决定与第 14 条是同一个；★ 而本批已把它单列为**第 20 条**，理由见 §5.8：此前它只在 `STATUS.md` 的正文里，**不在**这张待裁决清单上，于是没有任何一处会被人读到 |
| 19 | ★★★ **第 13/14/15/18 条其实是**一条**决定，而且执行面拿不到控制面凭证**（本轮新读数，见 §5.5） | ★★ **已裁决（2026-09-18）**——不再是"待裁决"，而是**待施工**（纯代码工作量） | §5.5 的三条机器读数：① `runtime` 进程的 `envNames` **故意没有 `TEAM_HUB_TOKEN`**（`product/process-manifest.mjs:203-215`）；② `RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`，**没有**范围表 / host surface（`runtime/contracts/run.mjs:158-181`）；③ `runtime/packs/*` 四个模块（`store` / `compiled-plan` / `authority` / `builtin/software-delivery`）**零生产入口**，`createPackStore` 生产调用点 **0 处**（hub 的 `/api/packs/account` 把账交出去，**没有任何生产代码接住**）。要裁决的**只有一个问题**：把执行面需要的那几份数据（连接器声明 / 范围表 / 落账端点 / 摩擦与岗位包的输入）放进 `RunRequest`，**还是**给执行面开一个控制面入口（注入 `TEAM_HUB_TOKEN`）？ | ★★★ **业主 2026-09-18 裁定：选前者。** 把执行面需要的那几份数据**放进 `RunRequest`**，照抄 PRT-214 已跑通两遍的形状（专属线上字段 / 按 Run 安装 / 对象身份配对 / 可 dispose / 装不上具名拒绝）。**不**给执行面开控制面入口、**不**注入 `TEAM_HUB_TOKEN`。⇒ 本条与它合并的第 13/14/15/18 条从「待裁决」变成「**待施工**」。★ 完整裁决单独成文：`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md`（含"**不许凭空造范围表**"这条**硬约束**、四项待搬运数据、三条复核读数；单独立文的原因是当时这一行上有别的会话的在制品）。**以下是裁决之前记下的两个选项，保留以备查**：★ 选**前者**：形状已经跑通**两遍**（PRT-214 缺口①的 `enforcementFloor`、缺口②的 `enforcementIdentity`——都是"专属线上字段 + 按 Run 安装 + 对象身份配对 + 可 dispose + 装不上具名拒绝"），照抄即可，是纯代码工作量。★ 选**后者**会让「Runtime 不看业务状态」这条 spec §2 的不可突破边界消失，并且执行面一旦有 token，"读声明"与"改状态"就只差一次调用的距离。**不决定**则这四处继续各记一行 🟡：登记了、能审、能冻，而**没有任何一次真调用被它们拦过 / 记过 / 算过**。★★ 本轮**没有**擅自补任何一行接线：`RunRequest` 里今天没有范围表字段，凭空造一份（例如"读根=写根=`workdir`"）正是 PRT-253 §3 明令禁止的"发明默认值"，且方向是**放行**；而"反正它更严"这个辩护**不成立**——收成 `workdir` 会同时拒掉合法的越目录读，表现成"工具莫名其妙失败" |
| 20 | ★★★ **Runtime 契约服务端那一行要不要进补丁层**（本批新提，见 §5.8） | 产品 + 项目主 | 可达性探针（2026-09-18）：`runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` 与 `runtime-host-registrar-row.mjs` **不在 `PATCH_LAYER_ROWS` 里**，也不在 `legion-host.patch.yml` 里，也没有任何生产 importer ⇒ **Runtime 契约服务端没有生产挂点**。而**消费侧已经接好了**：`product/launcher/runtime-contract-endpoint.mjs` 会去 DataDir 读那份发布、把 `LEGION_RUNTIME_URL`/`LEGION_RUNTIME_TOKEN` 注入 worker。**没有服务端，那份发布永远不会被写出来。** 要裁决的是：这一行**现在**要不要挂进补丁层——以及挂上去之后 `probeRuntime` 报什么（它要报 version + 四项必需能力，而**全仓没有生产实现**：真 DSH 进程里实测没有版本服务、也没有能力服务） | ★ 两条路都不许"编"：给一张**全 true** 的能力表会让 `checkCompatibility` 在一个**从未验过**的引擎上判"兼容"——那比不接更坏，因为**它会以"已兼容"的样子通过**。可选的是：① 挂行但让 `probeRuntime` **如实报 unknown** 并以具名码拒绝（fail closed，等价于今天"没挂"的效果，但**读数变成"查过且拒了"而不是"没人挂"**）；② 明确本阶段只走**同进程绑定**（`bindDshRuntime`）这一条路，把跨进程契约**显式降级为未启用**并写进产品边界。★ 无论选哪条，都**不要**把这一项继续留在"等另一个 agent 接线"里——那份工作已经提交了（`e0b83af` 等），而模块仍然不可达（本批已把 4 条 `in-flight` 改判 `gap`）。★★ **本批新读数（2026-09-18，见会话报告 §10.24）**：该模块 `state()`（`runtime-contract-server.mjs:592-601`）的**七个**字段里**六个是算出来的**（`listening` / `address` / `tokenConfigured` / `enforcementConfigured` / `probed`，`wireVersion` 是版本常量），**只有 `wireChecked: true` 是写死的字面量**，且全仓库**没有任何地方读它**（连用例都不读）——一个状态面上"线核过没有"的结论，实际是一个常量。⚠️ 我**没有**改它：这个字段的**本意**我判不出来（该服务端**确实**校验请求信封的 `wireVersion`，见 `:469-470`，所以它也可能只是在陈述"本服务端会核信封"这么一句真话）。含义不明时改字段，正是 PRT-253 §3 禁的那种"发明默认值"。**留作该行接线时一并裁决。** |
| 21 | ★★ **两条 ⏸ 要的不是机器、也不是凭据：是**真实的**外部用户 / 真实项目**（PRT-256、PRT-910；本批新提，见 §5.8） | 项目方 | 台账里两条 ⏸ 的"缺口"那一列逐字写着：**`需真实外部用户`**（PRT-256「设计伙伴独立完成真实低风险任务」）与 **`需真实用户项目`**（PRT-910「内部与金丝雀真实项目验证」）。**它们此前不在本清单上**——于是它们与"没有任何人在等它"是同一种东西（**同第 20 条那次的形状**，见 §5.8 与 §10.19）。要的东西与第 7 条**不同**：第 7 条要的是"DPAPI 可用的 Windows 机器 + 真实模型 API key"（**凭据与机器**），这一条要的是**一个愿意用它的人 / 一个真实的项目**。★ 本批把这条交叉核对做成了门禁（`scripts/prt/intervention-coverage.test.mjs`）：台账里**每一条非 ✅ 的行**都必须被 §5 的某一格点到名 | 不提供则这两条**永远是 ⏸**：能力已在、用例全绿，而**没有一次真实使用**。★ 这也是"任务是否完成"这句话**最大的限定**：产品侧能单独关掉的都已关掉，而这两条**按定义**关不掉——它们要的是**使用**，不是实现。★ 请不要把它们当成"还差一点代码"：把它们当成"还差一个用户" |

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

### ★★★ 2026-09-18 更新：`pathScope` 那一道**已经接上了**

第 19 条 §9.2 第 4 步落地（`runtime/dsh-composition/scope-port.mjs` +
`root-row.mjs` 从环境读 `LEGION_PATH_SCOPE`）。所以上面那张读数表要按**条件**读：

| 部署配置 | `enforcementSurfaces().pathScope` | 含义 |
| --- | --- | --- |
| 没配 `LEGION_PATH_SCOPE`（**今天的默认**） | `false` | 与上面那张表**一字不差**——没配就是没配 |
| 配了 | `true` | 端口真的接上了 |

★ 「没配」读数不变**是有意的**：把"没配"改成一个看起来像接上了的读数，
就是本轮反复记的那个形状（缺席被读成一个不可区分的读数）。

**仍未接的**：`whitelist`（岗位白名单）与 `execution-scope` / `external-api-scope`
两道。所以本节标题"三道范围检查"仍然成立，只是**第一道**有了一条能走通的路。

配套的可达性读数（同一次改动，机器可核）：
`runtime/dsh-composition/path-scope.mjs` 与 `scope-table-binding.mjs`
从"不可达"变成**可达**（基线 49 → 47 条）——那正是"判定写好了、只是没人给它一份表"
这句话消失的形式。

### 怎么核出来的

| 环节 | 位置 | 读数 |
|---|---|---|
| 生产装配的**唯一**入口 | `runtime/dsh-composition/plugins/root-row.mjs:508-536`（§9.5 接线前是 485-509） | `installEnforcementRoot({ env, decide, createRequestApproval })` —— **只有三个键** |
| 组合根透传 | `runtime/dsh-composition/root.mjs:465-466` | `whitelist: input.whitelist, pathScope: input.pathScope` ⇒ 两者都是 `undefined` |
| 装配默认值 | `runtime/dsh-composition/assemble.mjs:135-136` | `whitelist = null, pathScope = null` |
| 桥的行为 | `runtime/dsh-composition/tool-request.mjs:638-651` | `if (pathScope === null) return undefined` —— **返回 undefined 就是放行** |
| 两个检查器的 import 者 | `grep 'from .*(path-scope\|execution-scope\|external-api-scope)'` | **只有它们自己的 `.test.mjs`**（零生产 import 者） ★ **[2026-09-18 订正]** 这句话对 `path-scope.mjs` **已经不成立**：它现在有两个**生产** import 者（`scope-port.mjs:50`、`scope-table-binding.mjs:72`），而 `scope-port.mjs:169` 真的调 `checkPathScope(...)`。**仍然成立**的是 `execution-scope.mjs` 与 `external-api-scope.mjs`（各零个生产 import 者）。⇒ 本行那句"零生产 import 者"只该读作"对 605/606 成立"。 ★ 订正方法是**可达性探针的红**，不是重跑这行 grep——*一个写在表格里的读数，与一个被测的东西，差别在于前者不会自己变红。* |

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


## 5.4 ★★★ 可达性探针：**生产模块从任何入口都到不了**的那些（本轮新增读数）

> ★★ **读数订正（2026-09-17 续批）**：本节标题与读数原为「48 个」，
> 而探针当前报的是 **46 个**。两次变化各有原因，都写在这里，
> 因为"数字变小了"与"探针漏报了"在只看数字时是同一个东西：
>
> | 变化 | 原因 |
> |---|---|
> | 48 → **47** | `in-flight` 那 5 条随另一个 agent 进程的提交落地，其中一条已可达；`by-design` 13 → 12。**不是**本轮改的 |
> | 47 → **46** | ★ **本轮改的，而且是一处假阳性的消除**——见下 |
>
> ★★★ **`scrum/` 整个目录当时不在 `SCAN_DIRS` 里**，而 `scrum/serve.mjs`
> 是一个**按路径启动的产品服务**（`scripts/ci/run-ci.mjs:3748` 的 `tracked`
> 清单——stage 阶段算 SHA256SUMS 的那一份——逐字列着它）。
> 后果不是"少扫几个文件"，而是一处**假阳性**：
> `scrum/serve.mjs:38` import 的 `packages/shared/src/artifact-policy.mjs`
> 被报成 `[gap] 只被自己的用例 import`，而它**有两个真实消费者**
> （另一个是 `board-plugin/src/index.ts:18`，编成未跟踪的 `lib/`，import 图扫不到）。
>
> > 一个"把在跑的服务报成死代码"的探针，
> > 比一个"什么都没查"的探针更坏——因为**它的结论会被当成读数用**，
> > 而读的人会去查那个服务。
>
> 修法：`SCAN_DIRS` 收 `scrum`；`PROCESS_ENTRIES` 收 `scrum/serve.mjs`
> 与它按路径 `spawn` 的两个子进程（`taskctl.mjs` / `render.mjs`，
> `serve.mjs:153`、`:176`——它们**不可能**出现在任何 import 图里）。
> 新增正对照 `reachability.test.mjs` ①-5 钉住这一族
> （同 ①-3 的理由：每一类入口写法各要一条对照，因为实测漏过两种）。
> 破坏性验证 **2/2 咬住**（㉗ 删掉 `scrum/serve.mjs` 入口 / ㉘ 删掉 `SCAN_DIRS`
> 里的 `scrum`，两条都让 ① 变红）。
>
> ⚠️ **`workbench/` 与它不是同一个情况**，所以本轮**没有**把它一起收进来：
> 那是被 145 项明确排除的**旧 GUI**，而 `scrum/` 是 v1 看板服务本体
> （`tests/contract/v1v2-contract.test.mjs` 把它当契约面在测）。
> "没收"与"不该收"是两件事，不能共用一条理由。

§5.2 与 §5.3 都是**逐个模块**数的（"它有几个非测试导入者"）。那个读数有一个
**传递**盲点，本轮实测到了：

> `runtime/packs/store.mjs`（PRT-1003 安装/启用/停用/升级记录，**✅**）
> 有 **1** 个非测试导入者 ⇒ 看起来是活的。
> 而那 1 个是 `runtime/packs/builtin/software-delivery.mjs`，它有 **0** 个导入者。
>
> **一个「唯一的导入者也是死的」的模块，
> 与一个「真的有人在用」的模块，在"有几个非测试导入者"上是同一个东西。**

所以本轮换了个问法——**从真实进程入口出发，顺着 import 边走得到它吗**——
并把它做成一个可复跑的探针：`scripts/prt/reachability.mjs`
（`--json` 机器读 / `--diff` 与基线比对 / `--record` 重写）。
门禁 `scripts/prt/reachability.test.mjs`（**7 例**，已登记进 `run-ci.mjs`），
基线 `docs/superpowers/prt/prt-reachability-baseline.json`（**46** 条，逐条带 class 与 reason）。

### 读数

**518 个 `.mjs`（不含用例）里，46 个从任何生产入口都到不了**，入口 55 个。分类：

| class | 条数 | 含义 | 正确动作 |
|---|---|---|---|
| `by-design` | 13 | 按设计不被 import：`*/config-schema.mjs`（被 `scan.mjs` 读**源码**）、barrel/公开出口、`*-fixture.mjs`、按路径跑的开发脚本 | 不动 |
| `deliberate` | 8 | 升级链 `product/upgrade/*`：`runtime-install.mjs` 注释写明 Launcher **刻意不 import**（进程卫生） | **别动**（见 §5.3） |
| `in-flight` | **0** | ★ **本批清空**：它只在该文件**确实还有未提交改动**时成立。原来那 5 条里，**4 条的文件已经提交而模块仍不可达**（⇒ 改判 `gap`），第 5 条已变成可达（⇒ 删掉） | 见 §5.8（本批新增） |
| **`gap`** | **25** | ★ **台账/对照表说它已交付，而生产里没有路径** | **见 §5 第 14/15/16/17/18/20 条，与 §5.5 的那一条决定** |

> ★ 两处数字订正，都记在这里，因为"数字变了"与"探针漏报了"在只看数字时是同一个东西：
> · `by-design` 这一格写的原是 **12**。**那个 12 当时是对的**——我顺着基线的提交史
>   核过一遍（`git log -25 -- …/prt-reachability-baseline.json` 逐版数 class）：
>   `f291f9c` 起确实是 12（48→47 那一步移走了一条 by-design）。
>   而后来 **`db629e4`（2026-09-17 16:39）把总数从 46 拉回 47、by-design 12 → 13**，
>   这张表的**当前读数**那一格没有跟着改。所以不是"文档一直错"，
>   是**它写对过，然后被另一处改动追上了**。
>   > 一处"当时写对、之后被别处改动追平"的数字，
>   > 与一处"一开始就写错"的数字，读起来完全一样——只有顺提交史才分得开。
> · `in-flight` 5 → **0**、`gap` 21 → **25**：**本批改的**，逐条见 §5.8。
>   合计 47 → 46（少的那一条是 `runtime-contract-publication.mjs`，它**变成可达**了）。

### ★★ 最要紧的两条新读数（都在 `gap` 里）

**① F-18 与 F-19 的「执行面一半」全都到不了。**

| 模块 | 台账/对照表 | 现实 |
|---|---|---|
| `runtime/experience/friction.mjs`（487 行：`collectFriction`/`frictionScore`/`shouldDraft`/`buildDraft`…） | F-18 **✅** | 只被自己的用例驱动 ⇒ **生产里没有任何地方算过一个摩擦分** |
| `runtime/experience/graph.mjs`（`createGraph`，节点/边全封闭） | F-18 **✅** | 同上：**没有任何地方记过一条边** |
| `runtime/employee/role-pack.mjs`（756 行：`buildRolePack`/`verifyRolePack`/`diffRolePacks`…） | F-19 **✅** | 只被自己的用例驱动 ⇒ **生产里没有任何地方建出或校验过一个岗位包** |

★ 注意这**不是**说 hub 侧没接：`team-hub/experience-store.mjs` /
`role-pack-store.mjs` **是**可达的（经 `server.mjs` 的路由）。缺的是**产出者**——
账和读面都在，而**没有任何东西往里面写**。这与 PRT-610 那条是同一种形状
（"表建好了、能读，而一条记录都不会有"）。

★ 这也正是台账 §0 自己那条告警的字面含义：「只有自己的用例驱动的原语一律 🟡」。
**本轮没有改这两行的状态**——✅/🟡 的口径由台账的读者定，见下。

**② 组合行 `runtime-host-registrar-row.mjs` 与 `runtime-contract-server-row.mjs`
不在任何清单里。** `PATCH_LAYER_ROWS` 只声明 **5** 行（硬下限 / 审批登记 / pre-execute /
approval-answerer / **permission-presets**），`legion-host.patch.yml` 里有 **3 行**的落点
（2 行 `insert` + 1 行 `patch-over` 覆盖 `permission` 的 preset 表）；而这两行**只有用例引用**
（那些 `*-dsh-process.test.mjs` 自己拼补丁文件把它们挂起来）。
★★ **2026-09-18 订正**：这里原写"只声明 **4** 行"并把第 5 行漏在枚举外——
`legion-enforcement-permission-presets` 是 **2026-09-15** 由 `ed60213` 加进声明的，
而这句读数**没人跟着改**。（*一个"当时数对过"的数字，与一个"现在还是对的"的数字，
在文档里长得一样——区别只在有没有人回去数第二遍。*）
★ 顺带记一条**容易数错的地方**（`patch-layer.mjs:273-277` 自己写着警告）：
`permission-presets` 的 `module` **也是 `null`**，但它**不是**运行期行——
`patch-over` 不需要模块（按 id 覆盖既有行的 config），它生效与否的判据是
"Legion 的 preset 名解析得到"。所以"`module: null` 的有 3 行"与"运行期行有 2 行"
是两件事，不能拿前者当后者。
它们归 `in-flight`——**另一个 agent 进程当轮正持着这两个文件**（未提交），
所以本轮不把它们记为缺口，只记录读数。

> ★★★ **2026-09-18 续批：这个"等"已经等到了，答案是"接不上"。**
>
> 上面那句判据被兑现了：那几个文件在 `e0b83af` / `69da8fd` / `5c1d698` 里
> **已经提交**，而探针复核——**模块仍然不可达**。
> 于是 `in-flight` 的前提（"工作树未提交"）**过期**，正确的分类是 `gap`。
>
> | 文件 | 原 class | 现 class |
> |---|---|---|
> | `runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` | in-flight | **`gap`** |
> | `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` | in-flight | **`gap`** |
> | `runtime/dsh-composition/run-floor.mjs` | in-flight | **`gap`** |
> | `runtime/dsh-composition/runtime-contract-server.mjs` | in-flight | **`gap`** |
> | `runtime/dsh-composition/runtime-contract-publication.mjs` | in-flight | **删掉（已可达）** |
>
> > 一个把"已经停工"写成"正在进行"的标签，比一个写错的标签更坏：
> > 它会让人**不去催**——而这一条本来正等人裁决。
>
> 那份"接不上"的理由早就写在 `docs/STATUS.md`「本轮明确不做的两件」§四：
> 补上这一行需要 `runtimeHost` 的 `probeRuntime` 报 version + 四项必需能力，
> 而**全仓没有生产实现**（真 DSH 进程里实测：没有版本服务、也没有能力服务）。
> 给一张全 true 的能力表就是**编**——它会让 `checkCompatibility` 在一个
> **从未验过**的引擎上判"兼容"。
>
> ⇒ 因此本批把它提升为 **§5 第 20 条**（此前它只在 `STATUS.md` 的记录里，
> **不在**这张待裁决清单上——于是它没有任何一处会被人读到）。
>
> ★★ **一处"好消息"的误读，必须一起记下来。**
> `runtime-contract-publication.mjs` 变成可达，`--diff` 会把它报成
> 「基线过期 1 条（好消息）」。但那**不是**因为写侧接上了——
> 它是被 `orchestrator/worker/run-peak-resource.mjs` import 的，
> 也就是说它现在只被**读侧**碰到（格式常量）。
> 写那份发布的**服务端行仍然没有挂点**（就是上表第一条 `gap`）。
>
> > 可达性是**逐模块**测的，而一条链是**端到端**才通的：
> > 一个模块可以只因为有人 import 了它的两个常量而变成"可达"，
> > 而那条链的另一头从未被挂上。
>
> 所以「publication 变可达」**不**构成「Runtime 契约链有进展」的读数。
>
> ★ 并且本批给 `in-flight` 加了一条**到期判据**（`reachability.test.mjs` ⑦）：
> 文件干净却仍标 `in-flight` ⇒ **红**。破坏性验证 1/1 咬住
> （往基线里塞一条干净文件的 `in-flight` 条目，红的正是 ⑦）。

### ★ 三个过程教训（都是"探针自己坏了"）

**① 漏一种入口 = 把正在跑的进程报成死代码。** 第一版只认「进程入口 / `scripts/` /
`package.json`」，于是：

· `product/orchestrator/worker.mjs` 被报成不可达——而 `product/process-manifest.mjs`
  里明写着 `entry: {kind:'node-file', path:'product/orchestrator/worker.mjs'}`，
  **Launcher 真的会把它 spawn 起来**；
· 全部 `plugins/*-row.mjs` 被报成死代码——它们由 `patch-layer.mjs` 的
  `module:` / `runtimeModule:` **字符串**加载。

> 一个「漏了一种入口」的探针，
> 与一个「那个模块真的没人用」的探针，在输出上是同一个东西——
> 只不过前者会把**正在跑的进程**报成死代码。

（同一类错犯了两次：先只按**仓库相对**解析清单路径，漏了 `./` 开头的；
再只按**文件相对**解析，漏了仓库相对的。两种约定**同时存在**。）

**② ★★ 把用例算成入口，整个探针当场反转。** 第二版为了"`scripts/` 下的都算入口"
顺手把 `*.test.mjs` 也加了进去，于是**每一个只被自己用例 import 的模块都变成了可达**——
恰好就是本探针要查的那一类。读数从 48 掉到 0 而**报告看起来一切正常**。

> 一个「把用例也算成入口」的可达性探针，
> 与一个「什么都没查」的探针，在输出上是同一个东西。

**③ ★★ `evidenceFrom:` 是**存在性**断言，不是加载指令——别"顺手"加进去。**

探针支持四种"按字符串加载"的清单写法，所以很自然会有人看到
`product/release/checklist.mjs` 里的

```js
evidenceFrom: 'product/diagnostics/crash-report.mjs'
```

就以为"又漏了一种入口机制"，把它加进 `MANIFEST_PATTERNS`。**不能加。**
`evidenceFrom` 的消费者只做一件事：

```js
const sourceExists = deps.sourceExists ?? ((p) => existsSync(join(REPO, p)))
```

它是「**这个文件必须存在**」的断言，不是「这个文件会被加载」。实测：加进去会让
**8 个**模块**假**报成可达（`privacy.mjs`、`uninstall.mjs`、`preflight.mjs`、
`switchover.mjs`、`backup.mjs`、`retention.mjs`、`crash-report.mjs`、`audit.mjs`），
而每一个都是"存在但没人跑"。

> 一个「把它当成入口声明」的探针，
> 与一个「那些模块真的被用上了」的探针，在输出上是同一个东西——
> 只不过前者会把**"存在"读成"在用"**。

存在性与可达性是**两条不同的契约**。用例 ⑥ 专门把这条钉开
（变异验证：把 `evidenceFrom` 加进 `MANIFEST_PATTERNS` ⇒ ⑥ 精确变红）。

这三条都由**正对照**挡住，而正对照本身也修过一次：第一版的四条对照全在
`runtime/`+`team-hub/`，**恰好不需要 `scripts/`**（见 §5.3）。
现在 ① 里有五条，覆盖四种接线方式 + 两条清单写法。

### 判据与变异

门禁 **6 条**，**变异验证 11/11 成立**（10 处咬住 + 1 处等价变异如期不红）：
让 `resolveSpec` 空转 / 不再认清单的仓库相对路径 / 不再认 `module:` 键 /
★ 把用例算成入口 / 新建一个没人 import 的模块 / 往基线塞不存在的文件 /
★ 把 `path-scope` 接上（读数用例必须红）/ class 改成词表外的值 / reason 清空 /
★ 把 `evidenceFrom` 当成入口声明（⑥ 精确变红）/ 只改注释。

★ 一条**刻意的取舍**：基线**过期（模块变成可达）不判红**，只报警。

> 一个「把别人正在接线的好消息判成回归」的闸门，
> 与一个「逼着人把好消息 `--record` 确认一遍」的闸门，是同一个东西——
> 只不过前者会在**共享工作树上天天红**。

新增不可达（新的"到不了"）仍然判红——那才是本探针要挡的方向。

## 5.5 ★★★ 把 §5 第 13/14/15/18 条收成**一条**决定：执行面**没有**任何控制面入口

> 本节是 2026-09-17 续批的记录。它不改任何 ✅/🟡，只把**四张分开的清单**
> 换成**一条**读得出的架构事实——因为分开记会让人以为要开四次会。

### 读数：执行面进程**故意**拿不到控制面凭证

`product/process-manifest.mjs` 里 `runtime` 那一行的 `envNames`，
逐字是（`product/process-manifest.mjs:203-215`）：

```text
DSH_HOME, LEGION_DATA_DIR, LEGION_LOG_DIR,
TEAM_HUB_URL,                                        ← 只有地址
LEGION_ACTOR, LEGION_SCOPE, LEGION_ENFORCEMENT_ACTION, LEGION_CWD, LEGION_TASK_ID,
LEGION_APPROVAL_POLICY, LEGION_ATTENDED, LEGION_PERMISSION_PRESET,
LEGION_RUNTIME_TOKEN,
```

**`TEAM_HUB_TOKEN` 不在里面。** 这不是漏声明（漏声明会被
`buildChildEnv()` 直接抛，见 §5.2 与 PRT-253 续批四）——它是**刻意的**：
Runtime 进程是执行面，给它控制面凭证等于让执行面能读、能在最坏情况下改业务状态。

于是下面这四件事**同时**成立，而且它们不是四个问题：

| # | 那件事 | 它要的输入 | 为什么拿不到 |
|---|---|---|---|
| 13 | F-21 连接器判定面接进 `preExecute` | 连接器声明（`connector-store`，hub 侧）**＋ 一次调用的成败** | 声明在 hub 上，而 Runtime 进程**没有 token**；`TEAM_HUB_URL` 只是一个地址。★★ **这一条要的输入是两份，不是一份**（2026-09-18 第三批量出）：`decide()` 读熔断器状态，而改那个状态的 `recordOutcome` **生产调用方为 0**、强制面桥**没有执行后钩子**、`enforcementSurfaces()` 里**也没有 `connector` 这一格** ⇒ 只接判定面会得到一个**永远合闸的熔断器**，而且**一行错都不报**。详见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §10 |
| 14 | 三道范围表注入 `pathScope` / `whitelist` / `execution-scope` | 这一次 Run 的读根/写根/平台、命令/网络/MCP 授权、外部 API 端点 | `RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`（`runtime/contracts/run.mjs:158-181`）——**没有**范围表字段，也没有 host surface ★★ **这三道不是同一种缺口**（2026-09-18 第三批量出）：`pathScope` 已接（部署配置，`40d2d60`）；`whitelist` 端口在，**但算这个值的模块自己没在跑**——`permitsTool()`（`employee-manifest.mjs:317`）返回的形状**恰好**是端口要的，却**零生产调用方**，而它要的 `permit` 只能由 `narrowToGrant()` 产出、后者生产调用点全仓只有 `runtime/packs/authority.mjs:759` 一处，那个模块是 **`[gap]`** ⇒ **至少还压着第 19 条的包层**；真正属于本条（数据从哪来）的只有 `execution-scope` / `external-api-scope`。详见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11 |
| 15 | PRT-610 `recordToolCall` 的**写入方** | 一次工具调用在哪一层落账 | 落账要走 hub（同样没有 token），或走一条**逐 Run 的**载荷 |
| 18 | F-18 / F-19 的执行面一半（算摩擦分、记图边、建岗位包） | validations / attempts / 岗位包内容 | 都在 hub 上，同上 |

> 一个"因为没有凭证所以读不到声明"的执行面，
> 与一个"因为没人写载荷所以读不到声明"的执行面，
> 在这四处的读数上完全同形——**都是"那件事没有发生"**。
> 只不过前者去加一个环境变量就会**把执行面变成控制面客户端**，
> 而后者要动的是契约。**这就是为什么不能靠"把 token 也注入过去"来关掉它们。**

### 该走的方向已经有**两份**可复制的先例

PRT-214 缺口①（静态 hard floor）与缺口②（授权身份）**各自**走完了同一条路，
而且都已经是**已交付、有判据**的实现：

```text
hub / worker 侧算出这份数据
  → 挂到 RunRequest 的一个**专属线上字段**上
    （enforcementFloor / enforcementIdentity，都是**可选**字段）
  → runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
     在**每次 Run 只过一次**的缝上按 Run 安装
  → 安装点用**对象身份**配对，装完可 `dispose()`（Run 之间不串台）
  → 装不上 fail closed / 具名拒绝，不静默回落
```

所以第 14 条的候选 (A)（"随 Run 的载荷到达，像下限/授权身份那样按 Run 安装"）
**不再是一个提议，而是一个已经跑通两遍的形状**。本节的结论只有一句：

> **13 / 14 / 15 / 18 是同一个决定：把执行面需要的那几份数据放进 `RunRequest`，
> 还是给执行面开一个控制面入口。** 前者已经有先例与判据，后者会把
> 「Runtime 不看业务状态」这条边界去掉，而它正是 spec §2 那条不可突破的边界。

### 为什么不"顺手接线"

**本轮没有**给这四处补任何一行接线，理由与 §5.2 那句逐字相同：
`RunRequest` 里今天**没有**范围表字段，凭空造一份范围表（比如
"读根=写根=`workdir`"）正是 PRT-253 §3 明令禁止的"不发明任何默认值、替身或
暂时放行"——而它会让"没接线"与"接好了"在读数上同形，且方向是**放行**。

★ 注意这条**不能**用"反正它更严"来自我辩护：把范围收成 `workdir` 会同时
**拒掉**合法的越目录读（真实岗位要读依赖、读配置），于是它会表现成
"工具莫名其妙失败"，而值班的人会去查工具、不会来查这里。

### 顺带一条被这次核对咬出来的读数：F-20 的安装链也**零生产入口**

可达性探针（§5.4）的 `gap` 里有 4 条是**同一条链**：

```text
runtime/packs/store.mjs              唯一 import 者 = builtin/software-delivery.mjs
runtime/packs/compiled-plan.mjs      同上
runtime/packs/authority.mjs          同上
runtime/packs/builtin/software-delivery.mjs   **零 import 者**
```

实测确认：`createPackStore` 全仓库的生产调用点是 **0 处**——只有它自己的用例
（`runtime/packs/store.test.mjs` 27 处）、以及 hub 的
`/api/packs/account` **把账交出去**（`team-hub/pack-facts.mjs:228` 的注释写着
"交给 `createPackStore({ history })`"），而**没有任何生产代码接住那本账**。

> 一本"能导出、形状正确、喂回去就能重建"的账，
> 与一本"生产里从来没有人往里记过一笔"的账，
> 在 `GET /api/packs/account` 的读数上是同一个东西——**都是空数组**。

这一条与第 15 条（`tool_calls` 写入方 0 处）**逐字同形**，且同样是"决定谁在
什么时候调用"，所以也归到上面的**一条决定**里，不另开一节。
⚠️ **本表没有因此把 F-20 从 ✅ 改回 🟡**——口径由项目方定（同第 18 条的处理），
这里只把读数钉住：`releases` 之外，`runtime/packs/*` 在生产里
**至今没有被任何入口调用过**。

## 5.6 ★★★ 门禁自己的第三处缺陷：**跳过了多少条断言，摘要里一个字都没有**

这一处比 §5.4/§6.1 那两处更要紧，因为它的影响面是**整条 CI**，不是某一个探针。

### 读数

`run-ci.mjs` 有**四处**注释写着「`skipped: N` 看得见」「摘要里留下 `skipped: N`」。
而实现里：

```js
const counts = { tests: num(...), pass: num(...), fail: num(...) }   // ← 没有 skipped
const detail = label + ': exit=' + r.code + ' tests=' + counts.tests + ' pass=' + ... + ' fail=' + ...
//                                          ↑ 摘要行里也没有 skipped
```

`skipped` **从来没有被解析过**。跳过数只能靠 `tests - pass - fail` 的算术**反推**，
而那与"看见"不是同一件事：一个整数减法不会告诉你跳过的是哪一批。

实测代价（`DSH_CHECKOUT` 未设、而那份检出就在 `D:/project/DSH/dsh/` 盘上）：

```text
四个真进程套件：38 条断言里跳过 20 条
CI 那四行的读数：exit=0 tests=38 pass=18 fail=0     ← 摘要里一个字都没说
把 DSH_CHECKOUT 指向那份检出后：36 pass / 1 skip
```

修好之后，同一次 `--only test` 的汇总行是：

```text
test   FAIL (476092ms)  ⚠ skipped=232
⚠ 本次共跳过 232 条断言。跳过可以是合法的（缺 DSH 检出 / 缺浏览器 / posix 上跑不了 win32 分支），
  也可以是环境没配上 —— SUMMARY 里这一行就是为了让这两者不再同形。
```

而逐行的读数里有这些（**此前全部不可见**）：

```text
PASS dsh-composition-run-floor-dsh-process   tests=6  pass=0  fail=0 skipped=6
PASS runtime-contract-cross-process          tests=19 pass=0  fail=0 skipped=19
PASS dsh-credentials                         tests=165 pass=93 fail=0 skipped=72
PASS enforcement-real-process                tests=5  pass=0  fail=0 skipped=5
PASS subagents-surface-real-process          tests=12 pass=0  fail=0 skipped=12
```

> 一个"跳过了 20 条真进程断言"的 PASS，
> 与一个"全部跑过"的 PASS，在摘要行上是同一个东西——
> 只不过前者的绿来自**没跑**，而注释还在替它保证"看得见"。

### 修法与判据

| 改了什么 | 判据 |
|---|---|
| `runNodeTests` 解析 `skipped` | `scripts/ci/skip-visibility.test.mjs` ①（且**反向**断言它不是用减法反推的） |
| 每行 detail 带 `skipped=` | 同 ② |
| 跨套件汇总一行 + `SKIPPED_NOTE` 说明"怎么分辨合法跳过与没配上环境" | 同 ③ |
| `summary.json` 带 `skippedTotal`；SUMMARY 每行带 `skipped=` | 同 ④ |
| **跳过不判红** | 同 ⑤ |

★ 最后一条是**刻意**的取舍，不是漏了：跳过的合法理由有三种（干净检出上没有 DSH、
posix 上跑不了 win32 分支、机器上没有浏览器），把它判红会用一个大得多的故障
（"所有没装 DSH 的机器 CI 全红"）去换一个小得多的故障。它做的是**把它变成读数**。

破坏性验证：`scratch/verify-skip-visibility.mjs` **5/5 咬住**，还原逐字节一致。

### 环境事实（这条必须写下来，否则下一个人会重踩）

本机 `DSH_CHECKOUT` **未设**，而 DSH 检出**完整地在盘上**（`apps/cli/lib/bin.js`、
`packages/credentials/credentials-local/lib/index.js` 等编译产物都在）。
也就是说 **232 条跳过里有一整批不是"缺东西"，是"没配上"**。

```bash
# 复跑真进程套件（本机可用）
export DSH_CHECKOUT=D:/project/DSH/dsh/deepseek-harness
node scripts/ci/run-ci.mjs --only test     # 看 skipped 是否降下来
```

### ★★★ 这一处修好之后的**第一次读数**就抓到一个真回归

修完当天把 `DSH_CHECKOUT` 指上，读数从 `skipped=232` 变成 `skipped=1`，
而**多跑出来的那 231 条里有一条是红的**：

```text
FAIL product-launcher: exit=1 tests=397 pass=396 fail=1 skipped=0
  ✖ ★★★★★ 用 Launcher 拼出的 argv，真 DSH CLI 接受并把行装进组合树（120075ms）
```

它自 `f291f9c`（2026-09-13 之后不久）起就是坏的，而**所有门禁都是绿的**——
因为那条用例需要 `DSH_CHECKOUT`，而它一直没被设过。

根因是**根选项与 app 选项的段顺序**：DSH 用 `passThroughOptions()`
（`apps/cli/src/args.ts:142`）——一旦遇到第一个不认识的 token，**从那里往后全归 app**。
`f291f9c` 给 argv 末尾补了 `--host`/`--port`/`--no-open`（**产品侧是对的**），
而用例把 `--dump-config` 追加在**它们之后**，于是 DSH 没进 dump 模式、
去启动 web app 然后挂到 120s 超时。

> 产品代码里逐字论证过同一件事的反面（`process-manifest.mjs` 那段：
> 「`--port` 跑到 `--patch` 前面 ⇒ 覆盖层静默消失」）；
> 产品修好了，而**夹具**踩在了同一个坑的另一侧——
> 两者红起来的样子**完全一样**，只不过一个要改用例、一个要改实现。

详见 `docs/superpowers/prt/PRT-SESSION-REPORT-2026-09-17.md` §10.12。

## 5.7 ★★★ 第三处缺陷修好之后暴露的**第四处**：232 条跳过里有一整批"本该跑"

§5.6 把跳过数变成了读数。**读数一出来就指向了下一个缺陷**——
而这一处比 §5.6 更根本：它不是"跳过看不见"，是**跳过本来就不该发生**。

### 读数

按套件把 `skipped` 摊开（`scratch/skip-breakdown.mjs`，读的是 `.ci/*/ci.log`）：

```text
套件数 215，跳过合计 232

★ 报 PASS 而**一条断言都没验过**（pass=0）：
   dsh-composition-run-floor-dsh-process        tests=  6 skipped=6
   runtime-contract-cross-process               tests= 19 skipped=19
   headless-real-tool                           tests=  4 skipped=4
   enforcement-real-process                     tests=  5 skipped=5
   session-boundary-real-process                tests=  9 skipped=9
   subagents-surface-real-process               tests= 12 skipped=12
   小计：6 个套件 / 55 条断言

★ 跳过**多于**通过的套件：
   dsh-composition-root-row-dsh-process         pass=  1 skipped=10
   dsh-composition-runtime-host-row-dsh-process pass=  1 skipped=10
   approval-answerer                            pass=  6 skipped=12
   pre-execute                                  pass=  3 skipped=15
   小计：7 个套件 / 68 条跳过
```

> 一个「跑了 0 条、报绿」的套件，与一个「跑完 19 条全过、报绿」的套件，
> 在 CI 摘要上是**同一个东西**。

### 根因：21 个套件各自手写了同一个判定

```js
const DSH = process.env.DSH_CHECKOUT ?? null
const SKIP = DSH === null ? '未配置 DSH_CHECKOUT' : false
```

而那份检出**完整地在盘上**（`apps/cli/lib/bin.js`、
`packages/credentials/credentials-local/lib/index.js` 都在），只是环境变量没导出。
**55 条真进程断言**（覆盖 PRT-211/212/214/253 最要紧的那几条）因此从未在这台机器上跑过。

### 处置：一份解析器，而不是二十一份

新增 `scripts/lib/dsh-checkout.mjs`，21 个套件改为从它取检出。

| 它回答的问题 | 为什么单独回答 |
|---|---|
| **没找到** | 合法跳过；理由里带上候选列表，"找过哪里"是可读的 |
| **找到了但没构建** | 与上一条**不同的话**——"克隆了没 build"不等于"这台机器上没有 DSH" |
| **变量设了、底下不对** | **不回退**。静默换一份检出跑绿，会把一个配置错误变成一次"通过" |
| **用了哪一份** | `source: 'env' \| 'candidate'` + 完整路径，所以"显式指定的"与"推测出来的"可分 |

候选列表里第一条是**结构性**的 `<ROOT>/../dsh/deepseek-harness`（两个检出在本项目布局里平级），
不是硬编码的绝对路径；win32 字面量按平台收窄。

### 顺带发现：同一个候选列表此前有**三份**，且已经不一致

| 位置 | 候选 |
|---|---|
| `tests/p13-fixture/host-fixture.mjs` | `D:/project/DSH/dsh/deepseek-harness` |
| `scripts/ci/build-external-package.mjs` | `D:/project/dsh/deepseek-harness` |
| `scripts/prt/dsh-pin-drift.mjs` | 同上一份 |

前两处的 Windows 字面量**大小写不同**。win32 路径不区分大小写，所以**今天看不出来**。

> 一个只在大小写不敏感的文件系统上成立的巧合，
> 与一条真正的规则，在"它今天能解析"这个读数上是同一个东西。

★ 解析器第一版我放在 `tests/` 下，于是 `scripts/` 那两份**继续独立漂着**——
因为本仓的依赖方向是 **tests → scripts**（`credential-materializer.test.mjs` import
`scripts/config/scan.mjs` 等），**scripts → tests 一处都没有**。所以它现在住在
`scripts/lib/`。判据见 `tests/dsh-checkout.test.mjs` ⑱（并带反向控制）。

> 一个"统一了候选列表、但留在只有一半调用方能 import 的位置"的模块，
> 与三个各自独立的列表，在**今天**的读数上是同一个东西。

### 结果（逐套件实测，`node --test <file>`）

| 套件 | 改之前 | 改之后 |
|---|---|---|
| `run-floor-dsh-process` | `pass=0 skipped=6` | **6/6** |
| `runtime-contract-cross-process` | `pass=0 skipped=19` | **19/19** |
| `headless-real-tool` | `pass=0 skipped=4` | **4/4** |
| `enforcement-real-process` | `pass=0 skipped=5` | **5/5** |
| `session-boundary-real-process` | `pass=0 skipped=9` | **9/9** |
| `subagents-surface-real-process` | `pass=0 skipped=12` | **12/12** |
| 11 个 dsh-composition 套件（一次跑） | 跳过 98 条 | **203/203，跳过 0** |
| `dsh-credentials` | `tests=165 pass=93 skipped=72` | **164/164，跳过 0** |

★ `dsh-credentials` 的 `tests` 从 165 变 164 **不是丢了用例**：那个套件在
"DSH 不可用"时会**另外注册**一条占位用例（`dsh-credentials.test.mjs:708`，
`assert.ok(true, ...)`，只为把跳过理由印出来）。检出可用时它不注册——
所以两条路径的 `tests` 本来就差 1。这个数我用"显式 `DSH_CHECKOUT` 跑一遍旧代码"
对过（旧代码 + 显式变量 = `tests=164 pass=164 skipped=0`，与新代码逐字相同）。

### ★★★ 全量 CI 的读数（`node scripts/ci/run-ci.mjs`）

```text
  syntax PASS (3891ms)
  env    PASS (3809ms)
  boundary PASS (811ms)
  deps   PASS (3ms)
  build  PASS (32582ms)
  test   PASS (746311ms)  ⚠ skipped=2        ← 改之前：skipped=232
  smoke  PASS (9266ms)
  stage  PASS (124ms)
  doc    PASS (272ms)

  failed=0   skippedTotal=2
  ⚠ 跳过 2 条断言（2 个套件）：1/33、1/52
```

★ **`test` 阶段从 535s 涨到 746s（+211s）**，那正是这个修法的代价、
也是它唯一的证据：**232 条断言从"没跑"变成了"跑了"**，而它们跑的是
真 DSH 进程（下限拦截、跨进程契约、可续接子会话）。
一次 CI 多花 3 分半，换来 232 条真进程断言 —— 这笔账本身不需要裁决。

★ 而 `skipped=2` 那一行现在**点名了是哪两个套件**，这是 §5.6 那个修法的直接红利：
改之前，这 232 条在摘要里是**一个字都没有**。

### ★★★ 而那一行点出来的两个名字里，有一个是**我自己的漏网**

汇总行第一次打出套件名之后，读数是：

```text
⚠ 跳过 2 条断言（2 个套件）：dsh-session-boundary(1)、secret-store(1)
```

`dsh-session-boundary` 的 `⑥ 每条结论的锚点逐字命中` **仍然写着**
`SKIP：未配置 DSH_CHECKOUT`——**而那份检出就在盘上**。
也就是说：这一轮在清的那件事，**它自己还剩一处没清干净**。

它能被发现，靠的正是**这一轮新加的那一行**：

> 第一版的汇总行是 `1/33、1/52`——那两个数字**告诉不了你任何事**。
> 要知道"1/33"是哪个套件，得往上翻 200 多行去交叉引用。
> 而这一行存在的**全部意义**就是省掉那次翻找。
>
> 一个要求读者自己去交叉引用的"汇总"，
> 与没有这一行，在"我得翻多少行才能知道是哪两个套件"上是同一个东西。

修掉之后：`dsh-session-boundary` **33/33，跳过 0**。

★ **所以最后的 `skipped` 不是 2，是 1** —— 而剩下的那 1 条是
`secret-store` 套件里的 `④ ★★ 落盘后的文件模式是 0600`：

```text
skip: process.platform === 'win32'
  ? 'win32 无法表达 POSIX 权限位：Node 的 chmod 在 Windows 上只影响只读位，
     stat().mode 恒为可读写形态，这条断言在这个平台上证不出来——跳过，而不是假装通过'
  : false
```

这一条是**合法跳过**的三条判据全都满足：平台确实表达不了、理由写出来了、
而且它的**机制那一半**（`chmodSync(临时文件, 0o600)` 在 rename 之前）
由同一个文件里另一条用例在**所有平台**上数出来。
**这是本轮唯一一条我不认为该被消掉的跳过。**

### ★ 而最后一处漏网在**门禁自己**里（`run-ci.mjs`）

把测试侧全部迁移完之后再扫一遍**非注释**的 `process.env.DSH_CHECKOUT`，
还剩**一处**——在 `scripts/ci/run-ci.mjs` 的 `stageTest` 里：

```js
const dsh = process.env.DSH_CHECKOUT
if (dsh && existsSync(join(dsh, 'packages'))) {   // ← 变量没导出 ⇒ 整段不执行
  // 构建 team-hub / plugins / board-plugin，然后**才**把这三套件推进 suites
```

而它注释里写的目的是——

> 这里显式构建，**使该套件可从零复现**

手写判定做不到那件事。实测：本机 `DSH_CHECKOUT` 未设，而
`p13-host-injection` / `plugins` / `board-plugin` 当轮**都是绿的**——
绿的原因是**产物恰好还躺在盘上**，不是这段构建真的跑了。

> 一个"可从零复现"的门禁，与一个"在产物恰好还在时能过"的门禁，
> 在作者那台机器上是同一个东西——因为作者的产物恰好还在。

改用共享解析器后，这一段在检出可达的任何机器上都会真的去构建。
`need` 取 `packages`（与原来的 `existsSync(join(dsh,'packages'))` 同粒度），
**不收紧成 `cli`**：缺 CLI 时那三套件会各自具名跳过，
在门禁侧顺手收紧判据只会让"为什么没构建"变得看不见。

### 破坏性验证

`scratch/verify-dsh-resolver.mjs`：逐条把解析器改坏（**只改语义、不改成语法错误**
——语法错误会被 `--check` 拦下，那样验的是 Node 不是判据），跑判据套件要求它红，
再逐字节还原。

```text
㊸ 删掉结构性候选         咬住（8 条红）
㊹ 静默回退               咬住（4 条红）
㊺ 抹掉「找到但没构建」    咬住（4 条红）
㊾ 把「路径不存在」并进「没构建」  咬住（2 条红）   ← 我第一版的那个错
㊻ isDir 说了不算         咬住（2 条红）
㊼ 调换候选顺序           咬住（8 条红）
㊽ win32 字面量不收窄     咬住（4 条红）
㊿ REPO_ROOT 少数一级 ..  咬住（2 条红）   ← 我第一版的第二个错，见下

咬住 8 / 8　　还原逐字节一致：是
```

★ 每条变异都对应**一种下一个人真会犯的错**，而不是"把函数名拼错"——
后者会咬住任何判据，**不构成证据**。

### ★★★ 我第一版的第二个错：**"结构性候选"其实只有硬编码字面量在工作**

这一条是**提交后在隔离 worktree 里复核 HEAD 时**才暴露的，
主工作树上**永远看不到**它。

```text
第一版：export const REPO_ROOT = resolve(HERE, '..')     // HERE = <root>/scripts/lib
⇒ REPO_ROOT        = <root>/scripts                       ← 错了，应当是 <root>
⇒ 结构性候选        = <root>/dsh/deepseek-harness          ← 一个不存在的地方
⇒ 而 win32 字面量 D:/project/DSH/dsh/deepseek-harness **命中**
⇒ 所有判据全绿
```

> 我写这个模块是为了让"结构性候选"取代"作者那台机器上的绝对路径"，
> 而它第一版恰恰**只有那条绝对路径在工作**。
> 一个只在作者机器上成立的模块，用"我把它改成结构性的了"这句话，是验不出来的。

**更糟的是判据自己也复制了同一个错误**：`tests/dsh-checkout.test.mjs` 当时用的是
测试文件里**自己写死的** `ROOT = 'D:/project/DSH/legion'`，于是
"模块算出来的 `REPO_ROOT` 对不对"这件事，那两条读数**问都没问**。

> 一个"用自己写死的根去核对别人算出来的根"的判据，
> 与没有这条判据，在作者那台机器上是同一个东西。

修法两条：

1. `REPO_ROOT = resolve(HERE, '..', '..')`；
2. 新增判据 ⑳——它**从模块自己的 `REPO_ROOT` 出发**去比对（不看任何字面量），
   并断言**在 posix 平台上、把盘符字面量整个拿掉之后仍然解析得出来**。
   第一版在那条断言下会返回 `null`。

★ 这一条能发现，靠的是"**提交后在隔离 worktree 上复核一遍 HEAD**"这个动作——
而不是靠在主工作树上多跑几次 CI。**主工作树上那条字面量永远命中。**

### ★★★ 我自己在这个模块里写错过一次，而且错在**它存在的理由**上

第一版把「`$DSH_CHECKOUT` 指向一个**不存在**的路径」与
「找到了一棵树、但缺构建产物」并成了一支。于是：

```text
$DSH_CHECKOUT=D:/typo/nope
→ 「找到一个 DSH 检出（D:/typo/nope），但它缺少 packages……
    那多半是『克隆了但没构建』」
```

**那句话是错的**：那里根本没有东西，谈不上"没构建"。后果是具体的——
它会让下一个人去跑 `pnpm build`，而真正该做的是改那个变量。

> 这个模块的全部价值就是"三种情况说三句话"，
> 而它自己一开始就会把三种并成两种。
> 一个自己都分不清的模块，比没有它更糟——
> 因为它的**名字**承诺了它分得清。

修法：加 `kind`（`env-not-a-dir` / `unbuilt` / `not-found`），三条出口。
判据是 `tests/dsh-checkout.test.mjs` ⑲——它断言**三句话两两不同**，
并断言"路径不存在"那一句里**不许出现 `pnpm build`**。

### 这一处暴露的**新**缺陷

迁移过程中，`product/launcher/run-credential-dsh-process.test.mjs` 的
`★★★★★ 缺口 ③（真进程）` 在我改完后**报了一个 `ReferenceError`**：
我删掉手写判定时，把后面还在用的 `cliBin` 一起删了。

> 这条不是"迁移引入的 bug"值得单独记，而是它说明**这套件此前从没执行到那一行**——
> 一个从未跑过的用例，它的上下文里少一个变量是**看不见**的。

### 诚实边界

1. **这 6 个套件从"全跳"变成"真跑"，是这一轮最实质的收益，也是最该被怀疑的地方。**
   它们此前从没在本机跑过，所以它们**第一次真跑就绿**这件事本身需要解释。
   我逐条看过失败面：真正暴露出来的只有上面那个 `ReferenceError`，
   其余 55 条一次通过。我**没有**去做"故意破坏产品模块看它们会不会红"的变异验证——
   那是这 55 条自己的变异套件该做的事，不是这一轮做的。**记在这里，不冒充已做。**
2. `skipped=232` 这个数**我只把它降下来了，没有逐条归类**。剩下的跳过里至少包括：
   win32 平台分支（`④ 0600 POSIX 权限位`，合法）、浏览器 e2e（缺 Edge/Chrome）、
   以及 `dsh-credentials` 那 72 条之外的其他条件式套件。**没有逐条确认剩下的都是合法的。**
3. `DSH_CHECKOUT` 用的是**候选回退**而不是"必须显式指定"。这在合法检出存在时
   让读数变**准**；但如果一台机器上存在**两份**检出，它会取候选顺序里的第一份，
   而"取了哪一份"只体现在 `source`/`reason` 里——**CI 摘要不会说**。
4. `dsh-pin-drift` 与 `build-external-package` 的行为差异是**刻意保留**的
   （前者找不到返回 `null`＝未观察，后者 `exit 1`＝构建门禁）。这两条口径
   **没有**被任何用例钉住，只有注释。

## 5.8 ★★★ 本批（2026-09-18）新加的两条**到期判据**：标签会烂，指针也会烂

§5.4 记的是**读数**。这一节记的是**读数为什么会烂、以及怎么让它烂不下去**。

本批的起点是一个字：**「等」**。§5.4 里那 5 条 `in-flight` 的"正确动作"那一格
写的就是它。而 `in-flight` 的定义是：

> 另一个 agent 进程当轮正在接线（**工作树未提交**）

那 5 条里有 4 条的文件**已经提交了**（`e0b83af` / `69da8fd` / `5c1d698`），
而模块**仍然不可达** ⇒ 前提过期。真实内容是"接不上、要人裁决"，
而它**不在** §5 的清单上——于是没有任何一处会被人读到。

> 一个把"已经停工"写成"正在进行"的标签，比一个写错的标签更坏：
> 它会让人**不去催**——而这一条本来正等人裁决。

### 两处失效，两种判据（缺一条就只治一半）

| # | 失效 | 判据 | 位置 |
|---|---|---|---|
| ⑦ | **标签过期**：文件已提交，却仍标 `in-flight` | `in-flight` 的文件必须出现在 `git status --porcelain` 的改动里 | `reachability.test.mjs` ⑦ |
| ⑧ | **没人会裁决**：标着 `gap`，却写不出裁决处 | 每条 `gap` 的 reason 必须含 `§5 第 N 条`，且 **N 必须在 §5 清单里真实存在** | `reachability.test.mjs` ⑧ |

⑦ 只治"标签写错了"；**⑧ 治的是"标签写对了、而这条缺口没人在看"**。
本批那处缺口是**两者同时**发生的：标签过期（in-flight）**且**没有指针。
所以只加 ⑦ 是不够的。

### ⑧ 的两个细节，都是被真实错误逼出来的

**① "§5 裁决"不算指针。** 必须写到**第几条**。只说"§5 裁决"等于没告诉人去哪一条——
而本批那条缺口的原文里正好就有"§5 裁决"这几个字。

**② 指针必须**解析**得到。** 判据不只是"写了 `第 N 条`"，而是那个 N 在 §5 的清单里
**真的存在**。取条号是**按位置**取的：从 `## 5.` 标题到下一个 `## ` 标题之间，
`| N | … |` 形式的编号。**不能**按"全文档所有 `| N |`"取——文档里还有
优先级那一张（`1..5`）和 §5.5 的"同一决定的四个下游"那一张（`13..18`）。
按全文档取，`§5 第 3 条` 会**解析成功**，而它指向的是优先级表。

> 一个会"解析成功但指错地方"的判据，比一个解析失败的判据更坏。

**③ 于是"指针腐烂"成了一种可查的失效**：§5 的清单改了（重排、删条、
加条），而引用没跟着改。一个指向不存在条号的引用，与没有引用，
对读的人是同一个结果——**只不过前者看起来像已经归档过了**。

### 本批实际做的

- 4 条 `in-flight` 改判 `gap`（逐条理由写在基线里），第 5 条已变成可达 ⇒ 删掉。
- **给全部 25 条 `gap` 补上裁决处指针**。补之前只有 **6** 条有具体指针。
  逐条对着 §5 的清单核过（13 / 16 / 17 / 18 / 19 / 20 六处），不是猜的。
- 分类净变化：`in-flight` 5 → **0**、`gap` 21 → **25**、合计 47 → **46**。
- 破坏性验证：⑦ **1/1** 咬住；⑧ **3/3** 咬住——其中最要紧的一条是
  **从文档里删掉 §5 第 20 条那一行**，它证明指针**真的**解析到了那份文档上
  （少了这条，一个把 `matrixItems()` 换成 `new Set([1..99])` 的人也能让用例全绿）。

### 顺带订正的两处

- §5.4 里 `by-design` 那一格写的原是 **12**。**那个 12 当时是对的**——
  顺着基线的提交史逐版数过：`f291f9c` 起确实是 12，而 `db629e4`
  把总数从 46 拉回 47、by-design 12 → 13，这张表的**当前读数**没跟着改。
  > 一处"当时写对、之后被别处改动追平"的数字，
  > 与一处"一开始就写错"的数字，读起来完全一样——只有顺提交史才分得开。
- §5 第 16 条的枚举里补上了**崩溃报告**（`product/diagnostics/crash-report.mjs`）
  与**数据分类**（`product/lifecycle/data-classes.mjs`）：它们与本项其余模块
  是同一族（阶段 9 产品动作、自带用例、零生产入口），原文的枚举漏了这两个名字。

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

### 6.1 ★★★ `prt-churn` 红过两次，而**第一次的结论是错的**

`--only test` 里有一组会红：`prt-churn`（热点文件改动节奏探针）。**红过两次**，
两次的指纹**一模一样**（`fail=2`，两条都在 ③），而**原因完全不同**。
这一节存在的理由是：第一次给的结论让第二次差点被当成噪声放过去。

#### 第一次（2026-09-16）：判为"共享工作树的 git 瞬时争用"

当时的记录是这样的：

- `hot-file-churn.test.mjs` 在**模块加载时**跑一次 `collectChurn({...})`；
- 全套件里**只有两条**用例读这个快照（③ 的 `churn.ok === true`
  与 ③ 的遍历 `churn.files`）；
- `collectChurn()` 用 `git rev-parse HEAD` 起手，取不到就返回 `{ok:false}`；
- 于是一个"每 ~60s 提交一次"的共享工作树上，一次瞬时争用就能让 `ok:false`，
  **恰好两条**跟着红。

结论写成了：*「③ 的**两条**用例（不是一条、也不是十三条）同时红，正是前者的指纹」*，
并附了一句实测：`max=14 / 40`，**离阈值很远**，所以
*「③ 报出『计数 > 窗口大小』是**不可能的**」*。

#### 第二次（2026-09-17）：同一条指纹，而这次是**探针自己坏了**

```
✖ ③ 每个文件的窗口计数都不超过窗口大小（防错误写法回归）
    AssertionError: team-hub/server.mjs 第 1 窗口计数 41 > 40：可能又改成错误写法了
✖ ④ 判定给出理由与阈值，而不是一个孤立的布尔
    （同源：`v.recentMax <= churn.windowSize`）
```

两条，都在 ③/④ 那一族——**与第一次的指纹无法区分**。而这次 `churn.ok` 是 `true`，
`max` 也不是 14：探针真的报出了一个**超过窗口大小**的数。

★ 根因是探针的计数写法 **`<oldest>^..<newest> -- <file>`**：
`A^..B` 的语义是「B 可达且 A^ 不可达」，于是**合并提交的第二个父亲能带进来一大批
不在窗口里的提交**（本仓有 101 个合并提交）。窗口 1 只有 40 个提交，
区间里却有 **217** 个。

读数（同一次、同一棵历史，两种写法对照）：

```text
窗口 1  plugins/src/index.ts   区间写法 9  / 精确 1     ← 多算 9 倍
窗口 1  team-hub/server.mjs    区间写法 41 / 精确 9     ← 超过窗口大小
窗口 6  team-hub/server.mjs    区间写法 9  / 精确 10    ← 这个方向又少算
```

**两个方向都错**，而多算那一侧正是本探针文件头警告过的事：
*一个会把「该开工」读成「不能开工」的测量方法，比没有测量更糟。*
窗口 1 的真实答案是 **1**（该文件已降温），区间写法说 **9**——
而 9 会把 `recentMax <= 2` 推成"未降温"。

顺带一提：修这条时**第一版修法也是错的**——改成
`git log --no-walk --stdin -- <file>`，而 `--no-walk` 会把**路径过滤整个关掉**，
输出恒等于喂进去的 N 个提交（每个格子都是 `40/40`，两条满格条形图）。
正确写法是让 git 说出每个提交动了哪些文件，**路径过滤自己做**：

```bash
git log --no-walk --format=%x1f%h --stdin --name-only    # 窗口哈希从 stdin 喂进去
```

#### 这一节真正的教训：**"指纹"不能替代"读数"**

第一次那句话说反了。两条用例同时红之所以被当成瞬时针争的指纹，是因为
**当时没有把那个计数打出来**——只写了"`max=14`，离阈值很远"，
而那个 14 本身也是同一个坏探针量出来的。于是：

> 一个用**坏掉的探针**量出来的"离阈值很远"，
> 与一份真正的余量，在文档上是同一个句子——
> 只不过前者的作用是**教下一个人把真红当成噪声**。

所以正确的读法不是"两条红 = 可以忽略"，而是**先把数打出来**：

```bash
node scripts/prt/hot-file-churn.mjs --json
# 看每个文件的各窗口计数与窗口大小；若某个 count > windowSize，那是**探针的缺陷**，
# 不是"又改成错误写法了"——这句诊断本身在 2026-09-17 之前一直是错的。
node --test scripts/prt/hot-file-churn.test.mjs   # 单独复跑：17/17
```

判据：**`count > windowSize` 在正确实现下不可能出现**（窗口里最多就 N 个提交）。
它一旦出现，先怀疑计数方法，再看是不是真回归——这个顺序与第一次的结论**相反**。


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
| F-01 | Runtime Contract | ✅ | `runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs` | PRT-101～109；套件 `runtime-contract`（64 例）、`runtime/contracts/contract.test.mjs`（45 例）。★ **[2026-09-19 第 36 轮订正]** 本格此前点的是一条**裸文件名**（只有文件名、没有目录），而全仓有 **2** 个同名文件（另一个是 `whiteboard/packages/shared/test/contract.test.mjs`，26 例，讲的是另一件事）⇒ **读者按它去复核会找不开**。目标文件由内容判定：`runtime/contracts/contract.test.mjs` 的文件头逐字写着「Runtime Contract 契约测试（PRT-106）」，正是本行的主题。⚠️ 本行**不再**把那条裸名写成反引号——判据认的是**反引号里的那一个 token**，而"描述那条坏引用"会把它**重新引进**来（本轮的修订稿第一次就踩了这个坑） | — |
| F-02 | DshRuntimeAdapter | ✅ | `runtime/adapters/dsh/*` | PRT-201～206；套件 `dsh-adapter`（98 例） | — |
| F-03 | Runtime Manager | ✅ | `product/runtime-state.mjs` | `RUNTIME_STATES` / `CLAIM_POLICY` / `runtimeStatusReport()`；PRT-711 认领闸门 | — |
| F-04 | Orchestrator Core | 🟡 | `orchestrator/worker/*`、`team-hub/run-store.mjs`、`orchestrator/{acceptance,pipeline,workspace}/` | PRT-301～316。★ **不在这里复制那份计数**——逐条状态见 [`superpowers/prt/PRT-PROGRESS.md`](./superpowers/prt/PRT-PROGRESS.md) 台账（那是权威）。此处曾写着一份手抄的四列合计（已完成 143、部分 19、未开始 1、需外部输入 2），而台账当时的真实读数是 **145 行 = 已完成 138、部分 4、未开始 1、需外部输入 2**：**它对不上**，且**没有任何门禁会去核对它**（`check-docs` 只管 `README.md` 与 `docs/FEATURES.md`）。一个手抄的计数与一份会漂移的计数是同一个东西，只不过前者的读者会以为它被核对过——现已改为不复制，并由 `scripts/prt/progress-check.test.mjs` 用例 ⑥ 钉住 | `plugins/src/index.ts` 仍是主要编排热点（§1.1 的判断）；**PRT-316 是台账里唯一的 ⬜**，且它是**排期规则**没到（`0db37af` = 2026-09-10，一个发布周期 = 14 天 ⇒ 最早 **2026-09-24** 可启动），不是"没事可做" |
| F-05 前半 | 运行明细作为可持久化 RunEvent | ✅ | `team-hub/run-store.mjs`（`run_events`）、`orchestrator/worker/{executor,main}.mjs`、`server.mjs` | `team-hub/run-events.test.mjs`（18 例） | 明细**不进** `/api/events`（刻意：不新增第二条公开流） |
| F-05 后半 | 可靠事件与投递状态机 | ✅ | `team-hub/event-delivery.mjs`、`server.mjs`（`broadcastAudit` 重写、 `/api/event-delivery`） | `event-delivery.test.mjs`（31 例）+ `event-delivery-wiring.test.mjs`（7 例真 HTTP） | — |
| F-06 | Run 状态机 / 验收 / 交接 | ✅ | `team-hub/run-store.mjs`、`orchestrator/acceptance/`、`orchestrator/pipeline/` | PRT-307/308/309/310/311/312 | — |
| F-07 | 上下文快照 | ✅ | `runtime/context/*`、`team-hub/context-store.mjs` | PRT-401～409；套件 `context-store`、`context-export`、`context-retention` | — |
| F-08 | 模型档案与绑定 | ✅ | `team-hub/model-store.mjs`、`binding-store.mjs`、`probe-service.mjs` | PRT-501/502/506/507 | — |
| F-09 | 密钥库与 Run 凭证 | 🟡 | `security/secrets/*`、`product/secrets.mjs`、`product/launcher/{secrets-check,run-credential*,secrets-acl-runner}.mjs` | PRT-505/509；`secrets-acl-runner.test.mjs`（12 例，含真 `whoami`+`icacls`） | 见 §2「本轮已关掉的」；**C1～C4 是产品裁决**，属 ⏸ |
| F-10 | 权限、审批与审计 | ✅ | `team-hub/permission-engine.mjs`、`approval-*.mjs`、`context-plan-store.mjs` | PRT-601～607 | — |
| F-11 | DSH 强制面（hard floor / sandbox / preset） | 🟡 | `runtime/dsh-composition/*` | PRT-213/214/253 的一部分 | 见 §2；G1/G4、G2/G3/G4/G6 需人裁决。★★ **另有一条本轮新发现（§5.2）：三道范围检查在生产里从未被注入**——`enforcementSurfaces()` 实测 `pathScope:false` / `whitelist:false`，`execution-scope`/`external-api-scope` 连端口都没有。这不是"F-11 没做"，而是"做了但没装上"；裁决见 §5 第 14 条 ★★★ **[2026-09-18 订正·逐句] 上面这段有三处要按新读数读**：① 「三道范围检查在生产里**从未**被注入」**对第一道已不成立**——`pathScope`（PRT-604）**已经接进生产组合根**（`40d2d60`）：范围表从**部署配置**来（`LEGION_PATH_SCOPE`，登记在 `runtime/config-schema.mjs`），经 `scope-port.mjs` 变成桥要的那个函数，在 `root-row.mjs` 接上；`production-scope-wiring.test.mjs` ①b 钉住"配了翻成 true"。② 所以那个 `pathScope:false` 读数**不是**"没接线"的证据，而是"**这次装配没有配范围表**"的读数——**没配 ≠ 接了个空的**，两者在读数上分得开了（这正是 `scope-port.mjs` 存在的理由）。③ ★ 「`whitelist` 连端口都没有」**是错的**：`createEnforcementBridge` 的入参表里**有它**（`runtime/dsh-composition/tool-request.mjs:517`，注释 `PRT-603 的岗位白名单`），`assembleEnforcement` 也照传（`assemble.mjs:135`/`:168`）——**位置在、没人给它值**。真正连位置都没有的只有 `execution-scope`（PRT-605）/`external-api-scope`（PRT-606）两道。★ 一句话：`pathScope` 已接（**配了才拦**）、`whitelist` **有位无值**、另外两道**无位**  ★★★ **2026-09-18 第 21 轮再订正一句：上面那处「`whitelist` **有位无值**」要读成「位置在、**值给不进去**」。** 第 21 轮把 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11 留下的两处"我没有量"量掉了：唯一那个产出者（`permitsTool`）与桥的输入**词汇表不相交**（产出者认 **Legion 能力名**，桥交进来的是**执行面 DSH 名**——同一份 permit 喂前者放行、喂后者一个都不放行，抬 `maxRisk` 也救不了）⇒ 这一道**不是"等人配一个值"**，配了也只会得到一个**全拒**的强制面。已从第 14 条移出、立为第 **27** 条。详见 §4.4 与 §5.2 第 21 轮更新 |
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
| F-21 | 四条能力**全部不存在**（grep `connector`/`mcp` 在产品代码里零命中）：没有工具级策略、没有风险分级、没有密钥引用、没有故障隔离 | 能力已建（`registry.test.mjs` 37 例 + `connector-store.test.mjs` 23 例 + `connector-http.test.mjs` 11 例真 HTTP；**30 处守卫全部变异验证**）。★ 途中抓到 4 个真缺陷（能力名兜底成最严、凭证检查只看自己认识的字段、刚失败却报 healthy、`version` 参数被静默忽略），详见 §4.1。★★ **2026-09-18 续批：上面那句「判定面仍没有生产调用方」已经过期了。** 判定面建起来了（`runtime/connectors/decision-port.mjs`）并接进组合根（`assemble.mjs` 一次造齐两半、共用**同一份** registry；`tool-request.mjs` 新增 `connectorJudgment`；`enforcementSurfaces()` 6 格 → **7 格**）。证据不是"接上了"，而是**真调用被拦下**：`root.test.mjs` ⑨④ 里不装 ⇒ `preExecute(git-commit)` = `allow`（前提对照），装了 ⇒ `deny`（理由「连接器 github 没有声明工具「git-commit」」），而本连接器声明过的 `git-status` 照旧 `allow`；⑨⑤ 是**闭环**（开路 ⇒ deny ⇒ 反馈面记回 ⇒ 探针成功 ⇒ 恢复 allow）。★ 同一批还修掉一个**静默**缺陷：输入字段叫 `declaredRisk` 而**输出**字段叫 `risk`，照着输出写 `risk: 'critical'` 会被**静默丢掉**、落回能力下限 `low` ⇒ 一个作者标成 critical 的工具被自动放行；`declareTool` 的键集已改成**封闭**（全仓 9 处真样本用错字段名，其中一条用例**一直是绿的但什么都没验到**）。⚠️ **还差的一条不再是接线**：生产入参里没有连接器声明表 ⇒ `connectorJudgment` 在生产里仍是 `false`；"声明从哪来"归第 19 条那个配置键。精确读数：**从「没人接线」变成「接好了、且真调用被它拦下」**，而**不是**"生产里已经在拦"。★★ **2026-09-18 第 5 步续：投递面也建起来了**（`runtime/dsh-composition/connector-port.mjs` → `root-row.mjs` 的真生产调用方），于是上面那句"生产入参里没有连接器声明表"也**过期了**——配了 `LEGION_CONNECTOR_DECLARATIONS` 之后那一格**真的**翻 `true`，且一次**连接器策略是 deny** 的调用被连接器层拦下（`connectorDecided === 1`），前提对照是"没配时同一次调用 `allow`"。⇒ **仍差的两条换了位置**：**①** 那个键在 schema 的 `fields` 里却**不在** `product/process-manifest.mjs` 的 runtime `envNames` 里（与 `LEGION_PATH_SCOPE` **同一处**，`buildChildEnv()` 对未声明的键直接抛或静默丢掉）⇒ 与第 19 条同生共死；**②** 归属是**推导式**的（按声明），于是登记表那条「未声明就拒绝」**在生产里不可达**——真正的洞是"名字撞上已知核心工具"的未声明连接器工具。两条都写进了 §4.2 与人工介入清单 |

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
| F-15 | 用量/费用与预算 | 🟡 | `team-hub/budget-ledger.mjs`、`team-hub/usage-rollup.mjs`、`runtime/contracts/price-table.mjs` | PRT-503/510/511 已落地；**成本刻已采**（$0.045086 实测）；本轮补上**五维度汇总**（`usage-rollup.test.mjs` 12 例 + `usage-rollup-http.test.mjs` 6 例真 HTTP）。`peak-resource` 仍缺 ★★ **[2026-09-18 订正]** 本格此前写的是「`peak-resource` 仍缺（PRT-009 🟡，阻塞于 **PRT-011 平台裁决**）」——**两处都过期了**：① **PRT-011 早在 2026-09-11 就裁决为路线 C**（`docs/superpowers/prt/PRT-011-dsh-distribution-decision.md:4`），而且它裁的是**分发形态**、与峰值资源的**目标平台**无关，所以"阻塞于 PRT-011"这个框架本身是错的；② **PRT-009 已由 🟡 转 ⏸**（2026-09-18 业主裁定），因为两个采样器**均已落地**（`product/launcher/peak-resource.mjs` 经 supervisor、`orchestrator/worker/run-peak-resource.mjs` 按 Run 开合窗口），剩下的**只有一次真实 Legion 部署的实跑读数**——它卡在 `docs/STATUS.md` §4 第 15 条那个**已裁定的永久平台边界**（Windows 上不会有自动执行）。⇒ 本格现在应当读作：**缺的不是"谁来决定"，是一次本机永远发生不了的外部观测**。★ 另：记录层那一半也已打通（`run-record.mjs` 现在带 `peakResource`，判据 47 例、变异 6/6），所以"采了也没人接"不再成立——**剩下的最后一根线在 `launcher.mjs` 的 `persistRunRecord()`**，而那个文件是另一个会话的在制品 ★★ **2026-09-18 第 23 轮：告警与降级补齐了。** spec 那一行要四件事——「支持**告警、降级、暂停和硬阻止**」。此前 `budget-ledger.mjs` 实现了**暂停 / 硬阻止**（预留超限 ⇒ `cancel-requested` ⇒ 调用方取消 Run），`usage-rollup.mjs` 实现了**按五维读出来**；而**告警与降级一件都没有**——实测 `budget-ledger.mjs` 里 `降级` / `告警` / `degrade` / `alert` / `notify`的出现次数**全部是 0**，而 `usage-rollup.mjs` 的文件头**声称**它已实现（本轮已订正那句归属）。⇒ 新增 `team-hub/budget-alert.mjs`（20 例，7 处变异逐条咬住）+ `GET /api/usage/alert`（9 例真 HTTP）。★★★ 它的核心不是"比大小"，是**不许把"不知道"读成"没事"**：已知花费 0 元 / 上限 100 元 / 7 条账目金额未知 ⇒ `spent / limit = 0` ⇒ "离上限还远"，而那 7 笔里可能有一笔早就超了。⇒ 求值把两个**正交**的东西分开报（`level` 只由已知金额算、`confidence` 由"不知道几条"算），再用一条规则接起来：**`confidence !== 'exact'` 时 `action` 永远不许是 `none`**；对外只暴露一个 `allClear`，它要三件事同时成立。★ 本批还抓到接缝上的一个真缺陷：路由第一版只把**认识的那三个**阈值名从查询串里挑出来交给求值函数，于是 `?warning=0.5`（拼错了 `warn`）**根本没进到**那条"不认识的阈值名 ⇒ 抛"的守卫里——**守卫在，但它看不见这个键**，接口照旧 200。*一个把不合格的输入**过滤掉**再交给守卫的适配层，与一个根本没有守卫的实现，是同一个东西——只不过前者的守卫在源码里看起来是有的。*修法：参数集变**封闭**。★★ 并刻意**不**用模型绑定里的 `perRunBudget` 当上限：那是**单次运行**的天花板，而这里比的是**时间窗内的累计花费**——那个比值算得出来、通常落在 0..1、看起来完全正常，但它没有意义。 |
| F-16 | 自动化计划 | ✅ | `team-hub/automation-store.mjs`、`server.mjs`（6 条路由 + 30s tick） | `automation-store.test.mjs`（27 例）+ `automation-http.test.mjs`（9 例真 HTTP）。★ 本轮补上 `payload` 任务模板与 `bindTask`，`automationTick` 从 `wired:false` 变为 **`wired:true`**：物化出的运行会按计划模板建出一张**可领取**的任务卡 |
| F-17 | 长会话压缩 | ✅ | `team-hub/compaction-store.mjs`、`server.mjs`（5 条路由） | `compaction-store.test.mjs`（14 例）+ `compaction-http.test.mjs`（5 例真 HTTP）。★ 刻意**不调用模型**：收的是已算好的摘要文本 |
| F-18 | 经验图谱/摩擦学习 | 🟡→✅ | `runtime/experience/{friction,graph}.mjs`、`team-hub/experience-store.mjs`、`server.mjs`（5 条路由） | 本轮落地。★ 与旧 `plugins/src/experience.ts` 最要紧的分歧：旧实现从**评论散文**里数信号（正则匹配"打回"/"退回："/"将军验收"），于是有人改了措辞分数就变——而"因为改词变成 0"与"这段时间确实没有摩擦"在报表上是同一个 0。新实现**只从结构化字段取值**（拒绝 = `run_validations.decision`，重做 = 同一任务的第 2 次 attempt），并有一条**结构级**用例断言模块源码里不出现正则字面量。★ **缺失的输入是"不知道"、不是 0**：缺任何一维 ⇒ `complete:false`、`score` **抛**；要部分分必须显式 `allowPartial`，且返回的分数自报 `partial:true`——把缺失当 0 求和会得到一个**看起来完全正常**的低分。★ **草稿不是知识**：`draft → promoted` 或 `discarded`，两个终点都要人 + **封闭词表**的理由（丢弃也要写理由，因为"这条教训被谁按什么理由扔了"正是它消失的方式），没有自动晋升路径。★ 关系图**只记不推断**：边不隐式创建节点、必须署名，**撤销是追加记录不是删除**（"这条边存在过、被谁按什么理由收了"永远能答），遍历带 visited（这张图天然有环，没 visited 会在真实图上挂死）。旧 `plugins/src/experience*` 仍在，但不再是这一能力的落点 |
| F-18 缺口① | 摩擦分无法被证伪：信号来自评论散文的正则匹配，措辞一改分数就变 | ✅ | `friction.test.mjs` 23 例（含"换一段无关评论分数必须一样"与结构级"不许出现正则"），8 处守卫已**变异验证** | — |
| F-18 缺口② | 关系图**不存在**：没有任务/文件/技能/错误的关系结构，也没有任何地方记"这条边是谁加的" | ✅ | `graph.test.mjs` 15 例（含带环图遍历不挂死、撤销是追加），6 处守卫已**变异验证** | — |
| F-18 缺口③ | 草稿**算完即丢**（纯内存），且落盘面会把"现在的状态"存成第二份真相 | ✅ | `experience-store.test.mjs` 23 例 + `experience-http.test.mjs` 14 例（含 409 走真网络、`seq` 用 `lastInsertRowid`），10 处守卫已**变异验证** | — |
| F-19 | Employee / Role Pack | ✅ | `runtime/employee/role-pack.mjs`、`team-hub/role-pack-store.mjs`、`server.mjs`（3 条路由） | 本轮落地。★ **七类版本一个不少**（prompt / skills / tools / permissions / model / connectors / budget），缺一类**不给默认空值**——`connectors: []`（显式"就是不用"）合法，**没写这一节**非法：一个"缺连接器就当没有连接器"的包与一个"作者忘了写、而它静默地没有连接器"的包在运行结果上是同一个东西。★ **版本号是标签、内容哈希才是身份**：承载内容的四类必须带 `hash`，而对账把两种漂移**分开报**——版本变了（`VERSION_DRIFT`，显眼）与版本没变而内容变了（`CONTENT_DRIFT`，阴险到按版本号比对会报"一致"）。★ 岗位包属于 **agent 平面**（`EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement:false`），强制面字段在**每一层嵌套对象**上都被拒，连接器一节只许出现引用、出现凭证字段单独成码。★ 冻结**改不动**：主键 `(scope, role_pack_id, version)` 让多版本同时存在（塞进就地更新的 `employee_manifests` 会让第二次修改覆盖第一次的答案），同版本同内容幂等、同版本不同内容 **409** |
| F-20 | Pack Manager | 🟡→✅ | `runtime/packs/{manifest,authority,store,compiled-plan}.mjs`、`team-hub/pack-facts.mjs` | 校验面**齐全**：签名三级（`builtin/signed/unsigned`，无验证器即 `unsigned`——"没法验"不是"验过了"）、依赖与权限（`authority.mjs`）、Runtime Contract、预检结论**必填**。★ **本轮关掉三处缺**（此前本表误记为 ✅）：① **`rollback` 已实现**——账上多一类**自己的**记录（不与 upgrade 混），四条拒绝各有具名码；② **账可持久化**——`snapshot()` / `createPackStore({history})`，坏账**整本拒绝**（跳过坏记录会让"这几个包没装过"与"这几条记录坏了"变成同一个读数）；③ **team-hub 保存安装事实**——`pack_install_facts` 表 + 4 条路由，`GET /api/packs/account` 的形状**原样**能喂回 `createPackStore`，`GET /api/packs/export` 给出可提交进 Git 的审阅文本（不含包内容/凭证） |

## 4. P2：扩展面

| 编号 | 名称 | 状态 | 依据 | 还差什么 |
|---|---|---|---|---|
| F-21 | Connector / MCP 注册表 | ⬜→🟡 | **登记面、落盘面、判定面、反馈面四面俱在**：登记与落盘（`team-hub/connector-store.mjs` 的 `freezeDeclaration`/`connectorIncidents`/`exportConnectors` 都接在真 HTTP 路由上）；**判定面已接进生产组合根**（`runtime/connectors/decision-port.mjs` → `assemble.mjs` → `tool-request.mjs` 的 `connectorJudgment`）；**反馈面已接**（`outcome-port.mjs` → `runtime/dsh-composition/plugins/connector-feedback.mjs`，订阅 DSH `tools/result`）。★ **`enforcementSurfaces()` 从 6 格 → 7 格**（新增 `connectorJudgment`，与 `connectorFeedback` 分开报——只有一格时"判定面装了、反馈面没装"与反过来是同一个读数）。★ 隔离真拦下过：`root.test.mjs` ⑨④「未声明工具 `git-commit` ⇒ deny（政策门说 allow）」、⑨⑤「开路 ⇒ deny ⇒ 反馈面记回 ⇒ 探针成功 ⇒ 恢复 allow」的**闭环**、⑨⑥ 两半共用**同一份** registry。★★ **投递面也建好了**（`runtime/dsh-composition/connector-port.mjs` → `root-row.mjs`，第 19 条 §9.2 第 5 步）：配了 ⇒ 上面那一格**真的**翻 `true`（在真生产路径上验的，`root-row.test.mjs` 五条：配了/没配/空表/坏 JSON/真拦下，含**前提对照**"没配时同一次调用是 allow"）；缺席**如实**是 `absent`（不许折成空表——空表会让组合根建一份**零连接器**登记表 ⇒ 那一格报 `true` 而它**一次判定都不会做**）；显式 `[]` **具名拒绝**；重名工具**装配期**就停。273 例（decision-port 19 + connector-port 14 + root 3 + root-row 5 + tool-request 3 + registry 32 + connector-store 23 … + public-name 14） | ★ **仍差四条，且四条都不是"再写点代码"**。**① 投递**：`LEGION_CONNECTOR_DECLARATIONS` 与 `LEGION_PATH_SCOPE` 一样，**在 schema 的 `fields` 里而不在 `process-manifest.mjs` 的 runtime `envNames` 里** ⇒ `buildChildEnv()` 对未声明的键**直接抛**（`values`）或**静默丢掉**（`baseEnv`）。这一条与第 19 条**同生共死**（同一个文件、同一个数组，且是另一条工作线的在制品）。★★ **② 归属的来源——第 17 轮已解决**（原记"本仓没有这条源信号"是**错的**：约定不在本仓，在执行引擎那边）。新增 `runtime/connectors/public-name.mjs` 逐字镜像 DSH 的 `publicToolName`（`mcp__<serverName>__<rawName>`，含归一化/截断时的 12 位 SHA-256 后缀），接成归属的**第一条**依据 ⇒ 那条「未声明就拒绝」第一次在生产路径上真的拦下了东西（`mcp__github__delete_repo` 从 **`allow` → `deny`**）。判据含**一条把 DSH 真源码切片求值对跑 18 组**的用例（18/18 一致）。★★ **③ 声明名 vs 线上名——第 18 轮已解决一半**：`registry.mjs` 新增 `declaredToolNames`，登记表**同时**认声明名与 DSH 公开名（归属与判定共用**一份**实现）。实测：`mcp__github__list_issues`（第 17 轮 **`deny`「没有声明工具」** ⇒ 一个**正确声明过**的工具在真部署里不可用）现在连接器层答 **`allow`**。★ 剩下的**约定**（写哪个名字）记 §5 第 22 条。★★★ **④ 而最终判决仍然是 `deny`——理由是 `[政策门]`**（第 18 轮新查出，**本条最要紧**）：`tool-capability.mjs` 的 `resolveTool` 对不在它目录里的名字一律给 `direction: 'write'`、`requiresApproval: true`（fail closed），而 MCP 公开名**不在那个目录里** ⇒ **连接器层今天只能让事情更严，永远不能让它更松**。要不要让政策门从声明里读能力，是 §5 第 24 条。★ 另有命名空间**认不出**的一类仍落政策门（§5 第 23 条）。★ 本批另修掉一个**静默**缺陷：输入字段叫 `declaredRisk` 而**输出**字段叫 `risk`，照着输出写 `risk: 'critical'` 会被**静默丢掉**、落回能力下限 `low` ⇒ 一个作者标成 critical 的工具被自动放行；`declareTool` 的键集已改成**封闭**（不认识的键具名拒）。全仓共撞到 **9 处**用错字段名的真样本。★★ **第 19 轮新增一条**：PRT-605 的执行面授权表也有一个 `mcp` 段，它**同样**声称决定"哪些 MCP 工具可用"⇒ 第一次出现**两张表管同一件事**、而两道检查接在**同一个** `preExecute` 上。本轮**没有**选边，而是把"配了 `mcp` 段"做成一次**具名的拒绝**（`execution-scope-port-mcp-limb-unwired`，理由里写清权威在连接器登记表）——*一个"未接"与一个"检查不通过"，在最终 `deny` 上是同一个读数，而它们指向的修复动作完全相反*。裁决项见 §5 第 25 条，详细账见 §4.3 |
| F-22 | 后端与工作区 | 🟡 | `orchestrator/workspace/*`（git worktree）。§2 明写「不把 worktree 当安全沙箱」 | **核心已交付**：`orchestrator/workspace/index.mjs`（472 行，真 `git worktree`）+ worker 接线（`LEGION_WORKSPACE_DIR`、`resolveWorkspaceStages`、状态文件 `workspaceMode`），套件 `workspace` **24 例** + `workspace-wiring` **9 例**；PRT-306 ✅、可达、已接线。**未做**：Docker / SSH / remote worker 扩展——spec 第 138 行明写「**后续**扩展 Docker/SSH/remote worker」，且 §218 把「远程后端」列进「按真实客户需求推进」，与 F-23/F-25 同属一类。★ **[2026-09-18 第 27 轮订正]** 本格此前是 `—`：一个 🟡 行说「不差什么」，与「已做完」在表里长得一模一样（见 §5.11） |
| F-23 | 多 Harness 路由 | ⏸ | §2 明写「**不在契约稳定前同时支持多个 Harness**」——这一条**是设计决定，不是缺口** | — |
| F-24 | ACL 与安全姿态 | 🟡 | `team-hub/read-auth.test.mjs`、`read-open-loopback.test.mjs` 已覆盖读面矩阵；多用户写面 ACL 未做 | **读面已交付**：读权限矩阵由 `read-auth.test.mjs` + `read-open-loopback.test.mjs` 覆盖（含环回地址的读开放边界）。**未做**：多用户**写**面 ACL——即身份贯穿 API、SSE、附件、技能、聊天与审计的写侧；§218 把「多用户」列进「按真实客户需求推进」，与 F-23/F-25 同属一类。★ **[2026-09-18 第 27 轮订正]** 本格此前是 `—`，而「多用户写面 ACL 未做」那句**写在「依据」格里**——同一份信息放错格子，按「还差什么」读表的机器与人都读不到（见 §5.11） |
| F-25 | 外部渠道 | ⏸ | §9 明写「多用户、多 Harness、远程后端和外部渠道**按真实客户需求推进**」 | — |

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

### 4.2 ★ F-21 为什么仍记 🟡 而不是 ✅：**最后一根线换了两处，但没有消失**

这一条本轮**被自己推翻了两次**，两次都值得单独写下来。

#### 第一次（早前）：四处 `grep` 的结果是"零生产调用方"

四周 `grep` `createRegistry` / `declareConnector` 的结果是——**只有
`runtime/connectors/registry.test.mjs`**，全仓**零生产调用方**。

这正是本文 §2 那句开场白说的形状：

> 这几条的共同形状是 **"能力齐全、用例全绿、而生产调用方数为 0"**。

登记那半边**是活的**：`freezeDeclaration` / `connectorIncidents` /
`exportConnectors` 都接在 `server.mjs` 的真路由上，一段真 HTTP 请求能把声明冻进去、
把熔断事件读出来。但**判定**那半边（`decide()`）没有被任何东西调用——
产品里目前没有任何组件真的发起一次 MCP 工具调用。

> 一个"写得很对但没人调用"的闸门，与一个不存在的闸门，
> 在"这次调用被拦住了吗"这个问题上给出同一个答案：没有。

**正确的执行点**是 `runtime/dsh-composition/plugins/pre-execute.mjs` 挂的
DSH `tools/pre-execute` 瀑布 → `tool-request.mjs` 的
`createEnforcementBridge().preExecute`（判定**不该**塞进 `pre-execute.mjs`：
那个文件的文件头明写「判定逻辑**不在这里**」，塞进去会让"强制面在哪"的答案变成两处）。

#### 第二次（2026-09-18）：判定面接好了，**投递面**是新的最后一根线

判定面已经接进生产组合根并**在真生产路径上验过**（`root-row.test.mjs` 五条）：
配了 ⇒ `enforcementSurfaces()` 七格全对且 `connectorJudgment === true`；**没配** ⇒ 如实 `false`；
显式给 `[]` ⇒ 拦住装配；坏 JSON ⇒ 拦住装配；配上之后一次**连接器策略是 deny** 的调用
被连接器层拦下（`connectorDecided === 1`），而**同一次调用没配时是 `allow`**。

但那条链上还剩**两处**，各自的性质不同：

**① 部署配置到不了那个进程（与 `LEGION_PATH_SCOPE` 是同一处）**

新增的读取点 `runtime/dsh-composition/connector-port.mjs` 从 Runtime 子进程的
环境里读 `LEGION_CONNECTOR_DECLARATIONS`。而
`runtime/config-schema.mjs` 的 `fields`（"这个进程**可以**被配成什么"）与
`product/process-manifest.mjs` 的 runtime `envNames`（"Launcher 会**转发**什么"）
**两张声明面各自都有门禁，却没有一条判据把它们对起来** ⇒
"schema 里声明了、清单里没放行"是**两处都绿**的。

实测有**三处**这样的键，其中一处**早于本轮、没有任何归属**：

| 键 | 归属 |
| --- | --- |
| `LEGION_PATH_SCOPE` | 第 19 条 §9.2 第 4 步 |
| `LEGION_CONNECTOR_DECLARATIONS` | 第 19 条 §9.2 第 5 步（本轮） |
| `TEAM_HUB_TOKEN` | ★ **无归属**：`root.mjs` 的 `readString` 确实读它，只是**可选**（`MISSING_FIELD_CODES` 里没有它）⇒ 今天不致命，但"配了也传不到进程"与另两条一样 |

后果很具体：`buildChildEnv()` 对未声明的键，在 `values` 里**直接抛**、
在 `baseEnv` 里**静默丢掉**——两种都让"我配了"与"我没配"在那个进程里同形。
本轮已在 `scripts/config/config.test.mjs` 新增那道闸（三条 + 理由 + **查旧**），
并**变异实测**过：塞第 4 个未放行的键 ⇒ 判据红且点名它。

⇒ 所以精确读数是：**`enforcementSurfaces().connectorJudgment` 在"环境里有那个键"时为 `true`，
而"谁把那个键放进去"这一根线仍断着**（同一个文件、同一个数组，
且那个文件是另一条工作线的在制品）。这一条仍与第 19 条**同生共死**。

**② 归属只能覆盖"已声明"的工具（登记表的头号教义在生产里不可达）**

`registry.mjs` 文件头 ① 的头号教义是「未声明的工具**必须拒绝**——没见过就放行，
等于任何人在外部加一个工具就等于加一个后门」。直接问登记表它**确实**拒
（`decision: 'deny'`, `code: 'connector-tool-not-declared'`）。

但本轮交付的 `resolveConnectorId` 是**推导式**的（按"工具名在不在某份声明里"归属）
⇒ 一个**没被声明**的工具名归属不到任何连接器 ⇒ **登记表根本不会被问到**。
实测：`github__delete_repo` / `totally-made-up` 走桥时 `unattributed++`、
`connectorDecided === 0`；净效果**仍是拒绝**——但功劳在**政策门**
（未知工具 direction=`write`、`requiresApproval` 真 ⇒ fail closed），不是登记表。

> 一个"要触发『未声明就拒绝』、得先把这个工具归属到某个连接器，
> 而归属本身要求它已经被声明"的接线，
> 与一个"从来没有那条教义"的接线，在每一次真调用的读数上
> 都是同一个 `unattributed`——只不过前者的文件头里**明确写着**不许这样。

★ 这正好是**本文件上面那份到期接法的第 2 条**（"★ **没给端口时，连接器形状的工具
必须 deny**（fail closed），而不是放行"）——**它至今没有实现**。
而且不是忘了做：**"连接器形状"这件事今天判不了**。要判它，归属必须基于
**来源**（这次调用是不是走连接器发出去的），而不是基于名字；那需要一条
本仓**没有**的源信号（DSH 那侧的 MCP 工具命名/路由）。

剩下真正可被利用的那一格是：**一个名字撞上已知核心工具**的未声明连接器工具——
那种名字在本层眼里"不在任何声明里"、在政策门眼里是**已知的低风险工具** ⇒ `allow`。
这条边界写在 `connector-port.mjs` 文件头 ⑦，并在
`connector-port.test.mjs` ④c 与 `root-row.test.mjs`「归属的**边界**」两处钉住。

#### 为什么仍记 🟡

> ✅ 要求"有代码落点 + 可复跑的判据"，而 🟡 要求**写明缺哪一条**。

缺的是两条，都写明了：**投递**（键到不了进程，与第 19 条同一根线）与
**归属的来源信号**（本仓没有，需 DSH 侧或产品裁决）。两条都不是"再写点代码"能关的。

#### 第三次（2026-09-18 第 17 轮）：**来源信号找到了**——它一直在 DSH 的源码里

上面那条"归属的来源信号本仓没有"**是错的**，而错的方式值得记下来：

我做的是 `grep` `mcp__` / 工具前缀在**本仓**生产代码里的命中，**零命中**，
于是判定"没有这条源信号"。但命名约定不在本仓——它在**执行引擎**那边。
DSH 检出里逐字写着（`packages/mcp/mcp-client/src/tools.ts:8`）：

```text
is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
```

> 一个"在**我的**仓里找不到这个约定"的读数，
> 与一个"这个约定不存在"的读数，是同一次 `grep` 的两个解释——
> 而我只验了前者。**约定在被我编排的那个引擎里，不在编排它的那一侧。**

于是本轮新增 `runtime/connectors/public-name.mjs`（+14 例，其中有**一条把 DSH 的真源码
切片求值对跑 18 组**，18/18 一致），并把它接成归属的**第一条**依据：

| 依据 | 输入 | 与"有没有被声明过"有关吗 |
| --- | --- | --- |
| **命名空间**（前） | 工具名的 `mcp__<id>__` 前缀 | **无关** ← 这就是教义可达的原因 |
| 声明推导（后） | 工具名在不在某份声明里 | 有关（兜住"声明了 DSH 核心工具名"那一类） |

**实测（同一次调用、显式 `target`，策略门是放行的桩以便看清"谁在说话"）：**

| 调用名 | 第 16 轮 | 第 17 轮 |
| --- | --- | --- |
| `mcp__github__delete_repo`（`github` 是已知连接器，`delete_repo` 未声明） | **`allow`** | **`deny`**，理由 `[连接器 github] 连接器 github 没有声明工具「mcp__github__delete_repo」` |
| `list_issues`（逐字声明过） | `allow` + 连接器理由 | 同左（未变） |

⇒ **那条「未声明的工具必须拒绝」的头号教义，第一次在生产路径上真的拦下了东西。**

**而它同时照出了第二处缺口**（本批新查出，见 §5 新增条）：声明里写的是**裸名**
（`list_issues`）或 **DSH 核心工具名**（`git-status`），而线上来的永远是**公开名**
（`mcp__github__list_issues`）⇒ **一个正确声明过的 `list_issues`，在真 DSH 进程里会被拒**。

> 一组"声明写裸名、用例写裸名"的夹具，与一组"声明与线上名字对得上"的夹具，
> 在**套件读数**上是同一片 ✔——只不过前者从来没验过"DSH 真的会送来的那个名字"。

★ 修法**不是**剥命名空间：DSH 的公开名在归一化/截断时会被替换成 12 位 SHA-256 后缀，
那时剥不出 rawName（`tools.ts:9-10` 逐字："the public name is never parsed to recover it"）。
正确做法是**声明侧**用 `publicToolName(connectorId, rawName)` 算出公开名。
本批**没有**改声明语义（契约变更 + 既有夹具全要动），记为裁决项。

**仍未关的那一半**：命名空间**认不出来**的（`mcp__evil__x`——一个没有任何已知连接器
占着的 MCP 命名空间）仍落政策门。按教义它该被拒，而 `resolveConnectorId` 的值域
是 `string|null`，**装不下"拒"**。这件事没有被偷偷做掉。

#### 第四次（2026-09-18 第 18 轮）：**声明名 vs 线上名**关掉一半，而另一半更值得说

第 17 轮照出的那条缺口（声明写裸名、线上来公开名 ⇒ **正确声明过的工具被拒**）
本批关掉了一半：`registry.mjs` 新增 `declaredToolNames(connectorId, toolName)`，
让登记表**同时**认这两个名字，归属与判定共用**一份**实现。

**实测（同一次调用、显式 `target`、策略门是放行的桩）：**

| 调用名 | 第 17 轮 | 第 18 轮 |
| --- | --- | --- |
| `list_issues`（声明里写的） | `allow` | `allow`（未变） |
| `mcp__github__list_issues`（DSH 真会送的） | **`deny`「没有声明工具」** | **连接器层 `allow`**（不再说"没声明"） |
| `mcp__github__delete_repo`（未声明） | `deny` | `deny`（教义照旧） |

★ 修法**不是**剥命名空间（公开名被截断后带 12 位哈希，剥不出原名），
也**不是**把推导名存进声明体（那是"又一份记录"，规则一变就成了过期的事实）。
两个名字**都留**：裸名兜住既有夹具与"声明了一个 DSH 核心工具名"那一类。

★★★ **而另一半更值得说：最终判决仍然是 `deny`，理由是 `[政策门]`。**

`tool-capability.mjs` 的 `resolveTool` 对不在它目录里的名字一律给
`direction: 'write'`、`requiresApproval: true`（fail closed），而 MCP 工具的公开名
**不在那个目录里**。取严是设计（`deny > ask > allow`），后果是一句必须说清的话：

> **连接器层今天只能让事情更严，永远不能让它更松。**

一个"连接器声明了 `allow`、而每次调用都要人批"的系统，与一个"连接器层根本没接上"
的系统，在**最终判决**上是同一个 `deny`——只不过前者的理由里写着 `[政策门]`，
而后者连理由都没有。要不要让政策门从**声明**里读能力（那会把两层耦合成一层，
而取严的合并正是为了让连接器层成为**额外**约束）是裁决项，见 §5 第 24 条。

★ 判据把两条读数**分开取**（`outerAllow` vs 最终的 `kind`），
免得"公开名已支持"被读成"一次真的 MCP 调用今天就能按声明跑通"。

#### 为什么仍记 🟡（更新）

四条，都写明了：**① 投递**（键到不了进程，与第 19 条同一根线）；
**② 政策门不认识 MCP 工具**（连接器层只能更严、不能更松，§5 第 24 条）；
**③ 命名空间"认不出来"的那一类**（需要一个新端口，§5 第 23 条）；
**④ 声明该写哪个名字**（§5 第 22 条——功能上已两可，但**约定**仍要定，
否则下一个写声明的人不知道写哪个）。

### 4.3 ★★★ 第 19–20 轮：**三道范围检查**的账（PRT-604 / 605 / 606）

§5.2 早先记过一句话：**"三道范围检查在生产里从来没有跑过"**。第 19 轮接上了
**第二道**、第 20 轮接上了**第三道**——至此三道的账全部结清。而接的过程本身
产生了比"接上了"更值钱的读数。

| 道 | 检查器 | 端口 | 生产读数 | 为什么停在这里 |
| --- | --- | --- | --- | --- |
| PRT-604 路径范围 | `path-scope.mjs` | `scope-port.mjs`（`LEGION_PATH_SCOPE`） | ✅ 已接（第 19 条 §9.2 第 4 步） | 缺**投递**（§5 第 19 条，已裁决为"放进 `RunRequest`"，待施工） |
| PRT-605 命令/网络/MCP | `execution-scope.mjs` | `execution-scope-port.mjs`（`LEGION_EXECUTION_SCOPE`，第 19 轮新建） | ✅ 已接（第 19 轮） | 同上；★ 且 **MCP 那一条刻意未接**，见下 |
| **PRT-606 外部 API** | `external-api-scope.mjs` | **`external-api-scope-port.mjs`（`LEGION_EXTERNAL_API_SCOPE`，第 20 轮新建）** | ✅ 已接（第 20 轮） | 同上；★★ 且 **scheme 不在它的职责里**，见第 20 轮边界 ① |

**① `enforcementSurfaces()` 从 7 格长到 9 格，而"多一格"与"多一道检查"不是同一件事。**

第 19 轮之前，后两道**连位置都没有**。而"没有位置"比"有位置但没人给值"更糟：

> 一个「端口在、没人给它值」的强制面，
> 与一个「端口根本不存在」的强制面，在 `enforcementSurfaces()` 上是
> `false` 与**什么都没有**——而后者连"我该配点什么"都问不出来。

所以每一次"接上"都分成两条**分开取**的读数，缺一条都不能算数：
键在（`productionRootInputs()` 的文本解析）+ 行为读数（`env` 没配 ⇒ `false`；配了 ⇒ `true`；
**并且**同一路越界调用在真实 `preExecute` 上真的被拒，而授权表之内的照旧放行）。

★ 而三格**必须独立**：它们是三份**不同**的配置（`LEGION_PATH_SCOPE` /
`LEGION_EXECUTION_SCOPE` / `LEGION_EXTERNAL_API_SCOPE`）。一个共用布尔会让
"只配了路径范围"与"三道全配了"在读数上同形。

**② ★★★ 事实只算一次，这是本轮的架构决定。**

两个检查器需要的输入（`argv` / `url` / `method` / `tool`）投影里一个都没有。
最容易的写法是**在端口里**从 `arguments` 兜底取值——而那就是六份独立的兜底链：

> 一个「六处各自推导、今天恰好一致」的组合，
> 与一个「一处推导、六处引用」的组合，在**今天的用例**上是同一片 ✔——
> 只不过前者的下一次不一致会表现为"某个强制点没拦住"，
> 而那个现象看起来像"那条规则没生效"。

⇒ 新增 `scope-facts.mjs`，事实**只算一次**、落成 `projection.scopeFacts`，
端口**只读**。判据把它钉成一对反向读数（端口拿到 `scopeFacts: null` 而 `arguments`
里躺着 `command: ['rm','-rf','/']` 时**必须放行**；补上同一份 facts 后**立刻拒**）。

**③ ★★★ 一个刻意的**未接**，因为它该被裁决而不是被实现。**

`execution-scope.mjs` 的 MCP 授权与 F-21 的连接器登记表**都声称自己决定
"哪些 MCP 工具可用"**，而两道检查接在**同一个** `preExecute` 上。
本轮没有替产品方选边，而是做成一次**具名的拒绝**（`execution-scope-port-mcp-limb-unwired`）：

| 授权表的 `mcp` 段 | 端口的处置 | 码 |
| --- | --- | --- |
| **没有** | 拒绝——这一条**真的在判**（不需要拆名字） | `exec-scope-mcp-server-denied`（判定器的码） |
| **有** | 拒绝——而这是**未接**，不是"不通过" | `execution-scope-port-mcp-limb-unwired`（本模块的码） |

两种都拒，而**理由完全不同**：一个说"去裁决两张表谁是权威"，一个说"改授权表"。
值班的人照着改，改错方向。⇒ 裁决项见 §5 第 25 条。

**④ 本轮抓到的三个真问题**（都是先有判据、后被顶出来的）：

1. ★★★ **"换一个没登记过的工具名"能绕过执行面。** 未登记工具能力集是空的
   （`resolveTool` 对不认识的名字给 `capabilities: []`），于是按能力查表时
   类别也是空的 ⇒ 事实为 `null` ⇒ 端口"无话可说" ⇒ **放行**。
   而**同一份投影里**，政策门对它的处置是 fail closed（`direction: 'write'`、
   `requiresApproval: true`）——同一个 `resolveTool` 的两个读者给出相反结论，
   而两边各自的用例都是绿的。修法照抄投影自己 `GENERIC_TARGET_ARGUMENTS` 的纪律
   （未登记＝"我不知道它会干什么"，任何已知的这类参数都算证据）。
   ★ 但**刻意与目标那一条相反**：目标撞上多个候选是**抛**（不猜），
   事实撞上多个候选**全部采用**——事实是一组**检查**，多过一道是严格更严的方向。
2. ★ **归因记录在最需要它的那条路上缺席**：`sources.url` 第一版写在 `network`
   分支里，于是"只走外部 API 表"的调用读不到来源——一个看起来像
   "这个字段没有来源"的记录，比没有它更糟。
3. ★ **我自己内联了一个 `/^mcp__/` 正则**，而 `connectors/public-name.mjs` 里
   已经有一条**对着 DSH 真实源码逐字核过（18/18）**的 `isMcpPublicName`：
   一个"对着真实源码核过的判据"与一个"照着印象写的判据"，在所有**今天**的用例上
   是同一条绿——直到命名规则变一次。改成 import 之后，顺带把那一条从
   "只有自己的用例在调"变成生产可达。

**⑤ 本轮的诚实边界**（这几条**没有**被证明过）：

- `LEGION_EXECUTION_SCOPE` 与 `LEGION_PATH_SCOPE`、`LEGION_CONNECTOR_DECLARATIONS`
  卡在**同一个数组**里（`product/process-manifest.mjs` 的 runtime `envNames`，
  另一会话的在制品）⇒ 在**真的** Launcher 启动的部署里，这一格**仍然是 `false`**。
  ★ 而它是**同一个缺口的第三个受害者**，不是"第四个缺口"——
  补那一个数组时三把键一起通。
- `guard` / `preExecute` 两处都用真实组合根验过，但**没有**端到端跑过一次
  Launcher 启动的部署（用户的 DSH 在 3080 端口）。
- 事实表对**未登记**工具的通用识别是**启发式**的：它按参数名反推，
  能挡住"换个名字就用熟悉的参数起进程"，但挡不住"换个名字**也换一套参数名**"
  ——那一格仍然只能靠政策门（未登记工具一律 `write` + 要人批）。

**⑥ ★★★ 第 20 轮（PRT-606）抓到的：把 URL 交给解析器，等于让三道检查**从不触发**。**

`checkExternalApi` 要的是 `{host, method, path, headers, query, body}` 六项**分开**的
请求形状，而事实表里只有一个 `url` 字符串。所以适配器的职责是把 URL 拆开——
而**怎么拆**，决定 `external-api-scope.mjs` 那 24 例里的三条检查是"会触发"
还是"从不触发"。本批**实测**了两个洞：

| 写法 | 输入 | `new URL()` 给出来的 | 后果 |
| --- | --- | --- | --- |
| `u.hostname` | `https://api.example.com:8443/v1` | `api.example.com` | **端口被丢掉** ⇒ `HOST_HAS_PORT` **从不触发** |
| `u.pathname` | `https://api.example.com/api/items/../admin` | `/api/admin` | **`..` 被折叠** ⇒ `PATH_ESCAPE` **从不触发**，而折叠后的路径还可能命中一条它本来不匹配的授权 |
| `u.hostname` | `https://api.example.com@evil.com/x` | `evil.com` | **userinfo 被解析掉** ⇒ 具名的 `HOST_HAS_USERINFO` 退化成"这个 host 没被授权" |

★ 第三个洞在 **query** 上，形态不同但同族：按 `&`/`=` 手切时
`?%6dethod=DELETE` 切出来的键是 `%6dethod`，而 `METHOD_OVERRIDE_KEYS` 里只有
`method` ⇒ 那条"能覆盖方法的东西一律拒绝"的检查**从不触发**，一次 DELETE 被按**读**判。
⇒ 用 `URLSearchParams`（会百分号解码）。

> 一个「在解析之后才检查 `..`」的检查，
> 与一个「解析器已经悄悄把它们折叠掉了、所以这条检查从不触发」的检查，
> 是同一个东西——而它的方向是放行。

⇒ 端口**从原始串上取**（`host` 用 `parseEgressUrl` 的 `rawAuthority`，
`path`/`query` 用一条**只切不改**的正则）。

★★ 而这三个洞**红的方式很特殊**：退回 `new URL()` 时它们会变成
`ENDPOINT_NOT_GRANTED`（"不匹配任何端点"）——**方向仍然是拒**。
所以一个只看 `allowed === false` 的用例**抓不到它**；套件断言的是**码**。

> 一个「只看 allowed 是不是 false」的用例，
> 与一个「分不清"端口与 userinfo 没被检查"与"这个端点没被授权"」的用例，
> 是同一个东西——只不过前者在适配器退回解析器之后**照样是绿的**。

**⑦ ★★★ 第 20 轮由判据顶出来的两个真缺陷（都不是我推断的，是跑出来的）。**

1. ★★★ **`normalizeApiGrant` 不幂等，而三个端口长着同一副样子。**
   `fromEnv` 归一化一次、`create*Port` 再归一化一次——这在 PRT-604/605 上是绿的，
   在 PRT-606 上是**装配期就抛**（`api-scope-malformed`："出现了不认识的字段 [`parsed`]"）。
   根因是 `normalizeApiGrant` 会在每个端点上挂一个**派生字段** `parsed`
   （让 `checkExternalApi` 不必每次重新解析模式），而 `parsed` **不在**
   `ENDPOINT_FIELDS` 里。实测：`normalizeGrant`（605）**幂等** ✓、
   `normalizeApiGrant`（606）**不幂等** ✗。
   ⇒ 而最值得记的不是这个 bug，是**"这个归一化器幂等吗"这件事在三个端口的代码里
   一个字都没写**。三个长得一样的端口，其中两个的同一段接线是对的、第三个是错的。
2. ★★★ **可达性基线只被单边守。** `reachability.test.mjs` 的 ② 只管
   "当前不可达的必须有分类"、③ 只管"基线里的文件必须还在"——
   **没有一条判据管"基线里判成 `gap` 的模块后来被接上了"**。
   实测有**两条**这样的过期条目：`external-api-scope.mjs`（第 20 轮接上）
   与 **`execution-scope.mjs`（第 19 轮就接上了，而它的基线条目一直留到今天）**。
   ⇒ 第 19 轮做过正确的事（从 READINGS 删条目、按规矩补替身、更新 §5.2），
   **却没有任何判据要求它动基线**。已新增用例 **③b** 补上这个方向。

> 一个「只检查'有没有漏掉'的基线闸」，
> 与一个「可以无限积累过期条目、而每一条都长得像一条读数」的基线闸，
> 是同一个东西——只不过后者会让"死代码还有多少"这个数**只会涨不会跌**。

**⑧ 诚实的成果边界：三道范围检查现在是"配了才跑"，不是"默认就拦"。**

三次接线（604/605/606）都是同一个形状：**没配** ⇒ `port` 是 `null` ⇒ 那一行是放行。
所以"接上了"精确地等于**从"一次都不跑"变成"配了才跑"**。

**⑨ 第 20 轮的诚实边界**（这几条**没有**被证明过）：

- ★★ **本端口不看 scheme**（`checkExternalApi` 也不看）：那一条 `SCHEME_DENIED`
  归 `checkNetwork`。⇒ 一个 `ftp://api.example.com/api/items/1` 只要 host 与模式
  对得上就会被**放行**。本批**没有**顺手加"必须 http(s)"——那是**发明策略**
  （PRT-253 §3 明令禁止发明默认值）。它是一处**需要裁决的如实读数**，见 §5 第 26 条。
- `idempotencyKey` 恒为 `null`（事实表里没有它）⇒ `IDEMPOTENCY_NOT_HONORED`
  在当前接线里**不会触发**——重试语义还没有数据来源。
- `LEGION_EXTERNAL_API_SCOPE` 同样**不在** `product/process-manifest.mjs` 的
  runtime `envNames` 里 ⇒ 真实部署里 `externalApiScope` 仍是 `false`。
  ★ 它是**同一个缺口（一个数组）的第四个受害者**，不是第四处要修的地方。
  ⚠️ 而这个数**连续两轮都在涨**：每接一道范围检查，就有一把新键落进同一个没修的数组。
- `runtime/dsh-composition/runtime-contract-server.mjs` 一族（服务端 + 挂载行 +
  `run-floor.mjs`）仍然不可达，且**消费侧已经在等它**（见 §5 第 20 条）。

### 4.4 ★★★ 第 21 轮：`whitelist` 这一道**不是配置项**（PRT-603）——产出者与桥的词汇表不相交

§4.3 的 ⑩ 与 §5.2 第 20 轮更新把这一族里最后剩下的成员记成
**"`whitelist` 位置在、而生产装配从不给它值"**。那句读数是对的，
但它**暗示了一个错的修法**："没人给值"听起来像"等人配一个"（前三道正是那样修好的，
各配一个环境变量）。第 21 轮把 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md`
§11 明写的两处"我没有量"量掉了，结论是**配也配不进去**。

| # | 问题 | 实测 |
| --- | --- | --- |
| ① | §11.3：`permit` 的另一半 `grant` 从哪来 | **宿主显式注入**（不给就抛 `pack-authority-host-surface-unresolved`）；`preset` 那一半来自 host 组合的 `LEGION_PERMISSION_PRESETS` |
| ② | §11.5：`permitsTool` 装得下桥要的三个键吗 | **装得下**（`{allowed, rule, reason, riskRaised}` ⊇ `{allowed, rule, reason}`） |
| ③ | §11.5：桥交进来的工具名，它认得吗 | ★★★ **一个都不认得** |

③ 是新的。同一份 permit、同一个函数，差异**只来自词汇表**：

| 喂进去的名字 | 属于哪套词汇表 | 结果 |
| --- | --- | --- |
| `read-file` / `git-status` | **Legion 能力名**（`KNOWN_TOOL_NAMES`） | 放行 |
| `read` / `write` / `bash` / `web_fetch` | **执行面 DSH 名**（桥真正交进来的） | **一个都不放行** |

而**抬 `maxRisk` 到最高也救不了**：拒因从 `risk-above-ceiling` 挪到
`unknown-tool-not-named`，**还是拒**。

> 一个「拒得对、而理由是错的」的检查，
> 与一个「放行了它该拒的」的检查，在今天的行为上是同一个东西——
> 只不过照着理由去改的人会改错地方，而改完仍然是拒的，
> 于是没有人会发现理由本身是错的。

**★ 而这不是新知识**：`runtime/dsh-composition/tool-capability.mjs:465-492`
（`HIGH_RISK_TOOL_NAMES` 头上）早就逐字写着"两个名字空间**不相交**、
作为 `denyTools` 它是空的"。那条讲的是**静态下限**（`createHardFloorGuard`
只看 `execution.name`、中间没有翻译）；本轮量的是**同一件事在白名单那一道上的形态**
——而它此前**一个字都没被写过**，因为 `permitsTool` 在生产里**零调用方**：

> 一个「在生产里零调用方、于是它的名字空间问题从没被量过」的检查，
> 与一个「量过了、并且把结论写在了定义点上」的检查，
> 在今天的行为上是同一个东西——只不过接线的那天只有一个是对的。

**★★ "那就加一个反向映射"也不行**：`LEGION_TOOL_ROUTING` 的反推**不是一一对应**
——`bash` / `pwsh` 各对应 4 个 Legion 名（`run-command` / `git-status` /
`git-commit` / `git-push`）、`web_fetch` 对应 2 个（`fetch-url` /
`call-external-api`）；而 `bash` 那一堆里**同时塌着**低风险的 `git-status`
与高风险的 `git-push`。⇒ 翻译需要一个**取舍决定**（取严？看参数？还是让
`permitsTool` 直接收 DSH 名 + 一份 DSH 侧能力表），是**裁决项不是施工项**
（§5 第 **27** 条）。

**★★★ 顺带查出的第三件：仓库里有**两个同名 `EmployeeManifest`。**

强制面一份（`dsh-composition/employee-manifest.mjs`，`MANIFEST_FIELDS` **10** 个）、
上下文一份（`context/sources.mjs` 的 `employeeManifestSource`，`stableRecord`
写死 **11** 个键）。两边都认 `employeeId` / `role` / `displayName` / `allowedTools`，
所以**看起来是同一个东西**；实测**两个方向都不可转换**：

- **context 形状 → 强制面：抛** `employee-manifest-enforcement-on-agent-plane`
  （因为 `approvalPolicy` 正躺在 `FORBIDDEN_MANIFEST_FIELDS` 里）。
  ★ **拒得对**——把它加进名单才是错的，所以这**不是**"少登记了一个字段"。
- **强制面形状 → context：接受但丢字段**（`allowedCapabilities` / `maxRisk` /
  `workspaceRoot` / `unattended` 一个都不进正文，正文里是 `null`）。

> 一个「两个同名对象、一个抛一个丢字段」的仓库，
> 与一个「它们只是同一个东西的两个视图」的仓库，
> 在只读其中一侧的时候是同一个东西——只不过前者的接线人会在第一次
> 把 hub 里那份员工清单喂进强制面时拿到一个**具名拒绝**，
> 而那个拒绝看起来像「这份清单写错了」。

**读数与判据**：`scripts/prt/whitelist-limb.test.mjs`（7 例；`run-ci` 套件
`whitelist-limb`）。它**不重复** `employee-manifest.test.mjs` 那 20 例
"每条规则都能触发"——它问的是另一个问题：*真名字进来时这道检查放行过谁*：

> 一个「用 Legion 名字把每一条规则都走到拒绝」的套件，
> 与一个「真名字进来时这道检查到底放行过谁」的套件，
> 在摘要里都是绿的——只不过前者的绿是**词汇表自己对自己**的绿。

**★ 顺带订正一处 framing**：`production-scope-wiring.test.mjs` ② 此前把这一格写成
"**有位置却没人给值**"。**断言一条没动**，只把措辞订正成"位置在、**值给不进去**"
——因为它守的那件事没变，变的是"该往哪修"。

**诚实边界（本批没有做）**：**没有接线**（`enforcementSurfaces().whitelist`
今天仍是 `false`）、**没有改任何生产判定路径**（`tool-request.mjs` 一行没动）、
**没有决定**上面那个取舍、**没有量**那两个清单该不该合并、**没有量**"包层接上之后
`grant` 与 `manifest` 能不能同时凑齐"（本批只量了**凑齐了也接不上**这一半）。

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
| 13 | **F-21 判定面的接线资格**（★★★ 2026-09-18 **两次**订正：并发那条已过期 ⇒ 真实阻塞是**数据**；而第 19 条选定后本条**仍未解开** ⇒ 它有自己的决定，见"缺口"末段与裁决栏末段） | 项目主 + 产品（★ **要裁决的是"连接目标放哪"**，不只是"确认可以动文件"） | 把连接器判定接进 `createEnforcementBridge().preExecute`（DSH `tools/pre-execute` 瀑布，见 §4.2）。**当时唯一没做的原因是并发**：同一工作树上另一个 agent 进程正在改那个文件。★★ **本批核实：并发那条已经过期，但清掉它并不解开本条。** ① 那个改动**已经落地**（`f291f9c`，`runtime/dsh-composition/tool-request.mjs` 最后一次改动），且另一个 agent 今天的工作树里**不含** `runtime/dsh-composition/` ⇒ 并发确实没了。② **但接线接不上，缺的是"判定要对着什么判"**：`runtime/connectors/registry.mjs` 的 `createRegistry` / `declareConnector` **全仓库只有它自己的用例在调**（`git grep` 命中只在 `registry.mjs` 与 `registry.test.mjs`），而**声明**（策略 / 风险 / 工具清单 / transport / secretRef）的唯一真相在**控制面** `team-hub/connector-store.mjs`。③ 执行面**没有任何渠道**拿到那些声明：`runtime/contracts/*.mjs` 与 `run-floor.mjs` 提 `connector` **零命中**；`runtime/dsh-composition/` 下的**生产**代码提 `connector` **零命中**；`runtime` 进程的 `envNames` 故意**不含** `TEAM_HUB_TOKEN`（`product/process-manifest.mjs`）。④ 岗位包（`runtime/employee/role-pack.mjs:184`）里的 `connectors` 是 `Object.freeze(['id','version'])`——**只是引用，不含声明**，拿它判不出 allow/deny/ask。⇒ **本条的真实阻塞与第 14/15/18 条是同一个**（第 19 条那道"数据进 `RunRequest` 还是注入 `TEAM_HUB_TOKEN`"）。★ 这与第 19 条自己的标题（"第 13/14/15/18 条其实是**一条**决定"）**一致**；只是本条"缺口"里那句"唯一没做的原因是并发"是**当时**的事实，过期后**没人改**，而它会让读到这一格的人**以为清掉并发就只差一次编辑**。★★★ **但最后那句在本批当天又被实测修正了**：真实阻塞**不是**第 19 条那道二选一，而是**本条自己的一个决定**——执行面要的两半里，**连接目标**（`command`/`url`）在控制面**不存**、全仓**零生产者**（`4290254`，读数见裁决栏末段）⇒ 第 19 条选定「放进 `RunRequest`」**并没有**解开本条。 | 不接则 F-21 停在 🟡：登记、冻结、审计、导出都能用，但**没有任何一次真调用被它拦过**——"闸门写好了、还没装到门上"。★ 若产品认为"现在产品里没有 MCP 客户端，接线是给不存在的东西装门"，**请显式说明**，那我就把 F-21 的定位改成"控制面已就绪、判定面随 MCP 客户端一起做"，并在文档里这么写。★★ **订正后的可选方案**（本批）：既然真实阻塞是第 19 条，那么第 19 条一旦选定，本条自然解开——**不需要单独裁决**。⇒ 请把本条**并入第 19 条一起回答**；★ **但见本格末段：这句当天就被实测证伪了**；★ 我**没有**擅自接线：在没有声明的执行面上装这道闸，它只会对所有连接器调用**一律拒绝**（那与"没装"在用户眼里一样），而"反正它更严"这个辩护**不成立**——收成"全拒"会同时拒掉将来合法的连接器调用，表现成"工具莫名其妙失败"。★ 顺带一处**规格支持**：`docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md:106` 把"外部网络/连接器"列在 `tools/pre-execute` 动态检查的**首批纳管**名单里 ⇒ 接线本身是规格要的；但同文件 `:164` 又写"**只有在上述闭环稳定后**，才扩展……连接器"，所以"现在接不接"确实仍是一个**排期**决定，那就更该与第 19 条一起答。★★★ **末段（2026-09-18 同日证伪）：本条不是"并入第 19 条即可"，它有自己的一个决定。** 第 19 条**已经**选定（业主裁定「放进 `RunRequest`」），而另一个会话按那份裁决文件自己的硬约束（**不许凭空造数据**）**开工前复核**，量到连接器这一条**喂不进去**（`4290254`）：① hub 的 `normalizeDeclaration()` 产出的字段是 `version / connectorId / version_label / transport / policy / tools / secretRefs`——**没有 `command`，也没有 `url`**；② 把这份记录**原样**喂进执行面的 `createRegistry()` ⇒ 具名拒绝 `connector-transport-target-missing`（"transport 是 stdio，必须给 command"）；③ 反向对照：**只**补上 `command` ⇒ 就建起来了（`connectors() = 1`）。⇒ 执行面要**两半**：**策略**（hub 存）与**连接目标**（`command`/`url`，hub **不存**，且**导出时也刻意不含**——既有用例⑤的标题就是「含权限面与引用**名**，**不含命令与 URL**」，所以那是**有判据守着的设计性质，不是遗漏**）。而连接目标在全仓**零生产者**。⇒ 本条的真实阻塞是**它自己的一个决定：连接目标放哪**（四个候选方向见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §7.4），**不是**"照抄 PRT-214 的形状"那种纯代码工作量。★★ 那个会话还立了一条**会响的判据**（`team-hub/connector-store.test.mjs` 用例⑧，23/23，含 http/sse 缺 `url` 的同一具名码），并做了破坏性验证（关掉执行面那条判据 ⇒ 用例⑧变红，还原后逐字节相同）⇒ **"接上了它就会红"**。★ 他们那句话值得抄在这里：**"没接线看得出来，接错了看不出来。"** ★ 我**没有**擅自接线（理由见上），这一条我两批都只动了**文档**。 ★★★ **[2026-09-18 第三批订正·这一条的施工分两半] 上面那句"不是纯代码工作量"是对的，但**理由还不完整**：即使把连接目标那个决定做掉，把 `decide()` 接进 `preExecute` 也**仍然接不出一条能按设计动作的链**。逐条量出来的读数（写在 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §10）：① `decide()` **读得到**熔断器状态（`registry.mjs:556` `circuits.get(id)`，`:565` 开路即 `deny` `connector-circuit-open`，`:573-585` 半开只放行一次探针）；② 而改熔断器状态的**只有** `recordOutcome({connectorId, ok, error, atMs})`（`:607`，阈值 3 / 冷却 30 s），它的**生产调用方是 0 处**——全仓 `grep` 只命中定义与它自己的用例；③ **强制面桥没有"执行后"的钩子**：`createEnforcementBridge()` 的返回对象（`tool-request.mjs:876-901`）只有 `project` / `projectionFor` / `guard` / `preExecute` / `answerer` / `ledgerOf` / `ledgerHashes` / `contradictions` / `assertNoContradiction` / `enforcementSurfaces`——`preExecute` 是**判定**点、`onDecision` 是**事后通知**（那时决定已作出去了），**没有任何一处**看得到"这次调用最后成功了没有"；④ `enforcementSurfaces()`（`:894-900`）**恰好 5 个面**，**没有** `connector` 这一格 ⇒ 少装了什么都**不会有人知道**。⇒ **只接判定面 = 接了一个永远合闸的熔断器**，而且这一版**一行错都不报**、用例全绿、`enforcementSurfaces()` 也照常。这比 §7 那次更坏：§7 会在运行时具名拒绝（看得见），这一次看不出来——**§7.4 那句"没接线看得出来，接错了看不出来"要再往前一步：接了一半，也看不出来。** ★ 于是这一条的施工顺序应当是：**先定"执行结果在哪一层可见"**（第二半今天没有接缝；它与**第 15 条**——`tool_calls` 写入方为 0——是**同一个缺口**，不是两个问题），**再一次性接两半**。★ 本批**没有动任何代码**：这不是"来不及"，是 §3 那条硬约束的直接后果——这里能造的不是数据，是一个**看起来完整、永远不会跳闸**的接缝。⚠️ 边界：我没有去核 DSH `tools/` 那一侧有没有执行后钩子（`pre-execute` 是**前置**瀑布，名字就说清了位置），所以精确的意思是"**本仓的强制面桥**没有这个接缝"，**不是**"DSH 不提供任何钩子"。 ★★★ **[2026-09-18 第三批·接缝已建好]** 上面那句"桥**没有**这个接缝"**现在不成立了**——本批**动了代码**：`runtime/connectors/outcome-port.mjs`（把 DSH 的 `tools/result` 载荷变成 `recordOutcome({connectorId, ok, error})`）＋ `runtime/dsh-composition/plugins/connector-feedback.mjs`（订阅 `tools/result` 的那一行），由 `assemble.mjs` 在拿到连接器声明时**一次装齐两半**；`enforcementSurfaces()` 从 **5 格变 6 格**（原来连"连接器"这一格都**没有**）。★ **边界也核了**：DSH 的钩子**有两个且语义不同**——`:169 'tools/post-execute'` 是 `waterfall`（在派发路径里，可 accept/replace/block ⇒ **改变**结果），`:191 'tools/result'` 是 `emit`（"Observe the frozen, lossless-JSON **final** outcome"）；熔断器是**记录器** ⇒ 要后者。⚠️ **但归零 ≠ 通了**：`runtime/connectors/registry.mjs` 因此**有了生产 importer**（探针 47/26 → **46/25**，本条归零），可是 `createRegistry()` 在 `assembleEnforcement` 里是**条件调用**，而**今天没有任何生产路径**给 `connectorDeclarations`（来源是**第 19 条**那个部署配置键）⇒ 精确读数是"**从没人 import 变成了被 import、但那个函数从不被调用**"。⇒ **本条不再是"要不要接"、也不再是"缺反馈接缝"：剩下的并进第 19 条。** 详见会话报告 §10.43。 |
| 14 | ★★★ **三道范围检查的生产接线（PRT-603/604/605/606）** | 产品 + 项目主 | **这三道检查今天在生产里一次都不跑**（读数见 §5.2）。要决定的是：**这一次 Run 的范围表（读根/写根/平台、命令/网络/MCP 授权、外部 API 读写端点）从哪来、挂在哪一层**。可选方向：(A) 随 Run 的载荷到达，像 PRT-214 的下限/授权身份那样由 `runtime-host-registrar-row.mjs` 按 Run 安装；(B) 由岗位包（F-19 的 `permissions` 一节）派生，装配期算一次；(C) 仍留在 hub 侧判（那 `path-scope.mjs` 这类执行面检查器就应当明确废弃，而不是挂在桥上当"可选端口"） | 不决定则**越界路径今天拦不住**：`tool-request.mjs` 的 `scopeGuard` 在 `pathScope === null` 时返回"放行"，而生产从不注入。★★ 我**没有**擅自接线，因为凭空造一份范围表正是 PRT-253 §3 明令禁止的"不发明任何默认值、替身或暂时放行"——那会让"没接线"与"接好了"在读数上同形。本轮的处置是把读数钉住（`production-scope-wiring.test.mjs` 5 例 + 5/5 变异），所以**接上了它会红**。★ 另注意：三个台账行（PRT-604/605/606）的 ✅ 依据是"模块 + 自己那套用例"——按本表 §0 那条告警（"只有自己的用例驱动的原语一律 🟡"），它们的口径需要在台账里对齐  ★★★ **2026-09-18 订正（当天更晚）：上面那句"这三道检查今天在生产里一次都不跑"与"我**没有**擅自接线"**已经不再成立**——三道里的**第一道（`pathScope`，PRT-604）已经接进生产组合根**（`40d2d60`）。逐条对齐，原文保留：① **接线是真的、而且不是"凭空造一份范围表"**：范围表从**部署配置**来（`LEGION_PATH_SCOPE`，登记在 `runtime/config-schema.mjs`），由 `runtime/dsh-composition/scope-port.mjs` 变成桥要的那个函数（`pathScope(projection)`），在 `root-row.mjs` 接上。**没配**时端口仍是 `null`、读数仍是 `pathScope:false`——**没配不等于接了个空的**（`production-scope-wiring.test.mjs` ①b 钉住"配了翻成 true"）。② 所以本格"可选方向"实际没有走 A/B/C 中的任何一条，而是走**第 4 条**：数据由**部署方**在配置里给出（`§9.2 第 3 步`"汇合到同一个部署配置读取点"）。A/B/C 那道裁决**仍然只对另外两道**（`execution-scope` / `external-api-scope`）有效。③ "不决定则越界路径今天拦不住"要按**条件**读：**没配 `LEGION_PATH_SCOPE` 的部署仍然拦不住**（今天这是默认），配了才拦得住——与 §5.2 那张两行表一致。④ `production-scope-wiring.test.mjs` 现在 **6 例**（原 5 例 + ①b），且**它确实红了**——"接上了它会红"这条预言当时写对了，红的时候就照本格末句去改了账（本段就是那次改账）。⑤ **仍未接的**：`whitelist`（岗位白名单）与 `execution-scope`（PRT-605）/ `external-api-scope`（PRT-606）两道——**桥的参数表里连它们的位置都没有**。⑥ ★ 一条**可达性**上的机器可核证据（同一次改动）：`runtime/dsh-composition/path-scope.mjs` 与 `scope-table-binding.mjs` 从"不可达"变成**可达**（基线 49 → 47）。"判定写好了、只是没人给它一份表"这句话，现在有了一条会自动红的读数。 ★★ **2026-09-18 续：上面这条"口径不一致"现在有了一个机器可核的独立记录。** `docs/superpowers/prt/prt-reachability-baseline.json` 给这两个模块**各自带了一个 `class`**：`runtime/dsh-composition/execution-scope.mjs` 与 `runtime/dsh-composition/external-api-scope.mjs` **都是** `class: "gap"`，且 `reason` 明写「§5.2：连端口都没有 ⇒ 裁决处：§5 第 14 条（三道范围检查的生产接线）」——**reason 直接指向本条**。而 `runtime/dsh-composition/path-scope.mjs`（PRT-604）**不在**这份基线里（已可达，实测）。⇒ 三行的 ✅ 分两种：PRT-604 有**接线为据**（`40d2d60`）；PRT-605/606 的 ✅ 与**本仓库自己那份基线文件**直接冲突，且与台账 §0 告警「只有自己的用例驱动的原语一律 🟡」指向同一结论。★ **待裁决（两条都要写清理由）**：要么把 605/606 改 🟡 并接线，要么把那条告警**明确豁免**这两个模块。不能两样都不做——*一个「✅ 但没有生产调用方」的记录，与一个「这道检查在生产里跑着」的记录，下一个人读起来是同一个东西。* ★ 而且方向是**偏乐观**的那一边：它让人以为那两道检查在拦，实际它们一次都没被调用过。★ 本轮**没有**改这几行的状态：① 状态口径由项目方（台账的读者）定；② `PRT-PROGRESS.md` 此刻是**另一个会话的在制品**，按纪律不得触碰。 【2026-09-18 新读数·只订正事实，不改裁决】**本条开头那句"这三道检查今天在生产里一次都不跑"对 `path-scope.mjs` 已经**不成立**（对 `execution-scope` / `external-api-scope` 仍然成立）。**已核到端到端**（不是"有人 import 了它"）：`patch-layer.mjs` 的 `PATCH_LAYER_ROWS` 加载 `plugins/pre-execute-row.mjs` → `plugins/root-row.mjs:497` 真的调 `scopePortFromEnv({ env })`（读不出就 `throw`，**fail closed**）→ `:508-514` 把 `scope.port` 传进 `installEnforcementRoot({ pathScope })` → `scope-port.mjs:169` 调 `checkPathScope(...)`。落在 `40d2d60`（§9.2 第 4 步），**不是本会话做的**。 ⚠️ 但这**不等于"默认就拦"**：**没配**范围表时 `port` 是 `null`，而 `tool-request.mjs` 的 `scopeGuard` 那句 `if (pathScope === null) return undefined` ⇒ 那次缺席仍然落到**放行**。所以"越界路径今天拦不住"**只在没配范围表的部署上**仍然成立，而这一条正是本行要裁决的那件事——**裁决未变**。 ★★ 值得单独记一句的是**这件事是怎么被发现的**：**不是我读文档看出来的，是可达性探针的红报出来的**——而那条红**同时含一条假消息**（`external-api-scope.mjs`，由我自己那张记账表的键名冒充清单造成，见 `boundary-facts` 的判据 `criteria-files-do-not-impersonate-manifests`）。*一半真、一半假的红，比全假更难查，因为它对了一半——而人会顺手把两半一起"按指示清掉"。* ★ 现状读数（同一探针）：入口 58 / 可达 224 / **不可达 47**（`by-design 13` / `gap 26` / `deliberate 8`），与基线一致。 ★★★ **[2026-09-18 第三批订正·这三道不是同一种缺口]** 上面把三道写成一件事（"这三道检查今天在生产里一次都不跑"），而逐道量下来它们是**两类**：① `pathScope`（PRT-604）**已经接进生产组合根**（`40d2d60`）；② `whitelist`（PRT-603）**端口在，但算这个值的模块自己没在跑**——桥要的端口形状是 `(projection) => {allowed, rule, reason}`（`tool-request.mjs:751-757`），而 `employee-manifest.mjs:317` 的 `permitsTool({permit, toolName, capabilities})` **恰好返回这个形状**（L315 的 JSDoc 逐字写着），可是它**零生产调用方**（全仓 grep 只命中定义与自己的用例）；它要的 `permit` 只能由 `narrowToGrant({manifest, grant})` 产出，而那个函数的**生产调用点全仓只有一处**：`runtime/packs/authority.mjs:759`——**`[gap]`，零生产 importer**（`normalizeManifest` 的两处生产调用 `authority.mjs:752` / `compiled-plan.mjs:313` 同样是 `[gap]`）。⇒ **`whitelist` 至少还压着第 19 条那个包层**：一个配置键能给出 `grant`（宿主授予的那一半），**给不出** `manifest`（岗位包产物）那一半。★ ③ 真正属于本条（"数据从哪来、挂哪一层"）的只有 `execution-scope`（PRT-605）与 `external-api-scope`（PRT-606）——它们**连端口都没有**。⚠️ **本批只改了措辞、没有改判归属**：`permit` 的另一半（`hostGrant`）从哪来、算不算部署配置，我**没有量**，所以不擅自把 `whitelist` 整条移到第 19 条。详见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11。★ 顺带记一条与基线 `$comment` 对上的机制：**可达性是逐模块测的**——`employee-manifest.mjs` 在基线里**是可达的**（不在 47 条里），而它里面那个正是端口要用的函数**零生产调用方**；"模块可达"与"这条链通了"是两件事，这一次有了一个可以指名的例子。 ★★★ **2026-09-18 第 21 轮：本条的范围收窄为两道（`execution-scope` / `external-api-scope`）——`whitelist`（PRT-603）移出。** 它不属于"范围表从哪来、挂在哪一层"，而属于"**词汇表**"：量出唯一那个产出者（`permitsTool`）与桥交进来的输入**结构上不相交**（同一份 permit 喂 Legion 名放行、喂 DSH 名一个都不放行，抬上限也救不了）⇒ 它**接不上**，不是"暂时没配"。详见 §4.4 与第 **27** 条。★ 而 604（`pathScope`）已接（第 19 条 §9.2 第 4 步），所以本条今天**真的**只剩两道 |
| 15 | ★★ **PRT-610 执行面的落账点** | 项目主 + 产品 | `tool_calls` 的**表、读面、就绪证据的产出点**已经接上（本轮），而**写入方仍然是 0**：要接 `recordToolCall`/`markDispatched` 得先定"一次工具调用在哪一层落账"——`tools/pre-execute` 是**判定**点，而 `markDispatched` 必须在**真的派发之前**落库，那个位置比判定点更靠下 | 不接则这笔账永远是空的：表建好了、三条路由能读、就绪判据能回答"在不在记"，而**一条记录都不会有**。★ 这与第 14 条是**同一个决定**（执行面的载荷里今天没有这些字段），不是代码量问题。★★ 另：`release-gate.mjs` 的 `evaluateReadiness` **本身也零生产调用方**，所以"证据有了产出点"之后仍没有人在**发布决策**里读它——本轮只补齐了能被代码单独关闭的那一半 |
| 16 | ★★ **阶段 9 产品动作的 CLI 面（PRT-903/904/905/908/909、PRT-712、PRT-707）** | 产品 | 这批模块（发布检查清单、隐私说明、保留策略、数据分类、数据导出、卸载、支持手册、首次运行向导、指标数据源、崩溃报告、★ **第 39 轮新增的 §7 指标口径与生产者**：`product/metrics-spec7.mjs` + `product/metrics-spec7-source.mjs`）**全部自带用例、全部 ✅、全部零生产入口**（系统盘点见 §5.3）。要决定的是：**这些"产品级动作"由谁触发**——`legion` 的子命令？一个独立的发布/运维 CLI？还是只作为发布流程里人工跑的一次性脚本？ | 不决定则它们**对用户不存在**。台账自己为 PRT-509 写过这句话：「一个功能没有入口，与这个功能不存在，对用户来说是同一件事」。★ 其中 `metrics-source.mjs` 的台账行已如实写了"还没有界面/CLI 消费者"，另外六个没有写。★★ **第 39 轮的补充**：§7 那六格指标的数据**已经在库里**、读出口**也写好了**（17 例断言、13/13 变异），于是这条决定的代价从"要不要做"变成了**"做好了给谁看"**——并且它**不能**用"顺手接进远程心跳"来绕过：那份载荷走**允许名单**，加一个键就是加一次**数据外流**，那是本条之外的另一个点头。★★ 另：PRT-801～813 的升级执行链**看起来**也在这个清单里，但它**不是**缺口——`runtime-install.mjs` 的注释写明 Launcher **刻意不 import** 它（进程卫生：Launcher 要在那些依赖起来之前先把进程看好）。**不要**给 Launcher 补这个 import，见 §5.3。它的执行者同样取决于第 1 条（PRT-011 DSH 分发形态） |
| 17 | ★★★ **PRT-707 的两份实现用两个不同的模型密钥引用名** | 产品 + 项目主 | PRT-707（首次运行向导）在仓库里有**两份实现**：**活的**是 `cli.mjs` 的 `--wizard` 分支（内联，写 `model/api-key`），**死的**是 `first-run.mjs`（636 行 + 一整套用例，算 `legion/model/<profileId>`）。要裁决的是：**模型密钥的引用名用哪一个**——Legion 自己的三段式（`legion/model/<id>`，与 `credential-materializer.mjs` 文件头那句"Legion 的模型引用是 `legion/model/<profileId>`"一致，但 `planDshLookup()` 实测 `addressable:false`），还是运行时物化的那一段（`model/api-key`，端到端通、被 drift 用例钉着）？**或者**：两份实现留哪一份、另一份删掉还是明确废弃？ | ★★ **不要**把 `first-run.mjs` 直接接上去。它写进 hub 档案的 `secretRef` 是 `legion/model/<id>`——**三段**，而 `security/secrets/credential-materializer.mjs` 的 `planDshLookup()` 对三段引用返回 `{addressable:false, space:null}`（在 `refs` 与 `records` 两个键空间里**都没有位置**）。接上它的后果**不报错**：向导报"模型已配置"，而运行时拿不到钥匙——正是该模块文件头点破的那种失效（"文件看起来完整、就是少了最要紧那一把钥匙"）。★ 本轮**没有**替任何一方改代码：两份**各自都自洽**，裁决它需要产品决定。已把它变成读数：`product/launcher/wizard-wiring.test.mjs`（5 例，**今天全绿**，7/7 变异成立）——它红的那天，正是有人接线或对齐的那天 |
| 18 | ★★★ **F-18 / F-19 的"执行面一半"要谁来调用**（可达性探针新读数，见 §5.4） | 产品 + 项目主 | 从**真实入口**跑 import 图，`runtime/experience/{friction,graph}.mjs`（F-18）与 `runtime/employee/role-pack.mjs`（F-19）**从任何生产入口都到不了**——只被自己的用例驱动。hub 侧**是**接上的（`experience-store`/`role-pack-store` 经 `server.mjs` 可达），缺的是**产出者**：没有任何东西算摩擦分、没有任何东西记图边、没有任何东西建岗位包。要裁决的是：**这三件事由谁在什么时候调用**——执行面在 Run 结束时算（那要定"从哪拿到 validations/attempts"）？还是控制面在写账之前算？★ 同一族：PRT-610 的 `recordToolCall` 写入方（第 15 条）、三道范围表（第 14 条）——**三条都卡在"执行面的载荷里今天没有这些字段"这同一个决定上** | 不决定则这三块能力**对用户不存在**：账能读、读数是干净的、用例全绿，而**一行都不会被写进去**。★ 这三行的 ✅ 依据是"模块 + 自己那套用例"，与台账 §0 自己那条告警（「只有自己的用例驱动的原语一律 🟡」）**口径不一致**。★★ 本轮**没有**改这三行的状态——✅/🟡 的口径由台账的读者（项目方）定，"改状态"与"补证据"是两件事。★★ 另：另有 4 个不可达模块（`runtime-host-registrar-row.mjs`、`runtime-contract-server-row.mjs` 及其传递依赖 `run-floor.mjs` / `runtime-contract-server.mjs`）**本批已由 `in-flight` 改判为 `gap`**——那份"另一个 agent 正持着它们"的工作**已经提交**（`e0b83af` / `69da8fd` / `5c1d698`），而模块**仍然不可达**。它们不在任何清单里（`PATCH_LAYER_ROWS` 只声明 4 行、`legion-host.patch.yml` 只有 2 行），接线的决定与第 14 条是同一个；★ 而本批已把它单列为**第 20 条**，理由见 §5.8：此前它只在 `STATUS.md` 的正文里，**不在**这张待裁决清单上，于是没有任何一处会被人读到 |
| 19 | ★★★ **第 13/14/15/18 条其实是**一条**决定，而且执行面拿不到控制面凭证**（本轮新读数，见 §5.5） | ★★ **已裁决（2026-09-18）**——不再是"待裁决"，而是**待施工**（纯代码工作量） | §5.5 的三条机器读数：① `runtime` 进程的 `envNames` **故意没有 `TEAM_HUB_TOKEN`**（`product/process-manifest.mjs:203-215`）；② `RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`，**没有**范围表 / host surface（`runtime/contracts/run.mjs:158-181`）；③ `runtime/packs/*` 四个模块（`store` / `compiled-plan` / `authority` / `builtin/software-delivery`）**零生产入口**，`createPackStore` 生产调用点 **0 处**（hub 的 `/api/packs/account` 把账交出去，**没有任何生产代码接住**）。要裁决的**只有一个问题**：把执行面需要的那几份数据（连接器声明 / 范围表 / 落账端点 / 摩擦与岗位包的输入）放进 `RunRequest`，**还是**给执行面开一个控制面入口（注入 `TEAM_HUB_TOKEN`）？ | ★★★ **业主 2026-09-18 裁定：选前者。** 把执行面需要的那几份数据**放进 `RunRequest`**，照抄 PRT-214 已跑通两遍的形状（专属线上字段 / 按 Run 安装 / 对象身份配对 / 可 dispose / 装不上具名拒绝）。**不**给执行面开控制面入口、**不**注入 `TEAM_HUB_TOKEN`。⇒ 本条与它合并的第 13/14/15/18 条从「待裁决」变成「**待施工**」。★ 完整裁决单独成文：`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md`（含"**不许凭空造范围表**"这条**硬约束**、四项待搬运数据、三条复核读数；单独立文的原因是当时这一行上有别的会话的在制品）。**以下是裁决之前记下的两个选项，保留以备查**：★ 选**前者**：形状已经跑通**两遍**（PRT-214 缺口①的 `enforcementFloor`、缺口②的 `enforcementIdentity`——都是"专属线上字段 + 按 Run 安装 + 对象身份配对 + 可 dispose + 装不上具名拒绝"），照抄即可，是纯代码工作量。★ 选**后者**会让「Runtime 不看业务状态」这条 spec §2 的不可突破边界消失，并且执行面一旦有 token，"读声明"与"改状态"就只差一次调用的距离。**不决定**则这四处继续各记一行 🟡：登记了、能审、能冻，而**没有任何一次真调用被它们拦过 / 记过 / 算过**。★★ 本轮**没有**擅自补任何一行接线：`RunRequest` 里今天没有范围表字段，凭空造一份（例如"读根=写根=`workdir`"）正是 PRT-253 §3 明令禁止的"发明默认值"，且方向是**放行**；而"反正它更严"这个辩护**不成立**——收成 `workdir` 会同时拒掉合法的越目录读，表现成"工具莫名其妙失败" |
| 20 | ★★★ **Runtime 契约服务端那一行要不要进补丁层**（本批新提，见 §5.8） | 产品 + 项目主 | 可达性探针（2026-09-18）：`runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` 与 `runtime-host-registrar-row.mjs` **不在 `PATCH_LAYER_ROWS` 里**，也不在 `legion-host.patch.yml` 里，也没有任何生产 importer ⇒ **Runtime 契约服务端没有生产挂点**。而**消费侧已经接好了**：`product/launcher/runtime-contract-endpoint.mjs` 会去 DataDir 读那份发布、把 `LEGION_RUNTIME_URL`/`LEGION_RUNTIME_TOKEN` 注入 worker。**没有服务端，那份发布永远不会被写出来。** 要裁决的是：这一行**现在**要不要挂进补丁层——以及挂上去之后 `probeRuntime` 报什么（它要报 version + 四项必需能力，而**全仓没有生产实现**：真 DSH 进程里实测没有版本服务、也没有能力服务） | ★ 两条路都不许"编"：给一张**全 true** 的能力表会让 `checkCompatibility` 在一个**从未验过**的引擎上判"兼容"——那比不接更坏，因为**它会以"已兼容"的样子通过**。可选的是：① 挂行但让 `probeRuntime` **如实报 unknown** 并以具名码拒绝（fail closed，等价于今天"没挂"的效果，但**读数变成"查过且拒了"而不是"没人挂"**）；② 明确本阶段只走**同进程绑定**（`bindDshRuntime`）这一条路，把跨进程契约**显式降级为未启用**并写进产品边界。★ 无论选哪条，都**不要**把这一项继续留在"等另一个 agent 接线"里——那份工作已经提交了（`e0b83af` 等），而模块仍然不可达（本批已把 4 条 `in-flight` 改判 `gap`）。★★ **本批新读数（2026-09-18，见会话报告 §10.24）**：该模块 `state()`（`runtime-contract-server.mjs:592-601`）的**七个**字段里**六个是算出来的**（`listening` / `address` / `tokenConfigured` / `enforcementConfigured` / `probed`，`wireVersion` 是版本常量），**只有 `wireChecked: true` 是写死的字面量**，且全仓库**没有任何地方读它**（连用例都不读）——一个状态面上"线核过没有"的结论，实际是一个常量。⚠️ 我**没有**改它：这个字段的**本意**我判不出来（该服务端**确实**校验请求信封的 `wireVersion`，见 `:469-470`，所以它也可能只是在陈述"本服务端会核信封"这么一句真话）。含义不明时改字段，正是 PRT-253 §3 禁的那种"发明默认值"。**留作该行接线时一并裁决。** |
| 21 | ★★ **两条 ⏸ 要的不是机器、也不是凭据：是**真实的**外部用户 / 真实项目**（PRT-256、PRT-910；本批新提，见 §5.8） | 项目方 | 台账里两条 ⏸ 的"缺口"那一列逐字写着：**`需真实外部用户`**（PRT-256「设计伙伴独立完成真实低风险任务」）与 **`需真实用户项目`**（PRT-910「内部与金丝雀真实项目验证」）。**它们此前不在本清单上**——于是它们与"没有任何人在等它"是同一种东西（**同第 20 条那次的形状**，见 §5.8 与 §10.19）。要的东西与第 7 条**不同**：第 7 条要的是"DPAPI 可用的 Windows 机器 + 真实模型 API key"（**凭据与机器**），这一条要的是**一个愿意用它的人 / 一个真实的项目**。★ 本批把这条交叉核对做成了门禁（`scripts/prt/intervention-coverage.test.mjs`）：台账里**每一条非 ✅ 的行**都必须被 §5 的某一格点到名 | 不提供则这两条**永远是 ⏸**：能力已在、用例全绿，而**没有一次真实使用**。★ 这也是"任务是否完成"这句话**最大的限定**：产品侧能单独关掉的都已关掉，而这两条**按定义**关不掉——它们要的是**使用**，不是实现。★ 请不要把它们当成"还差一点代码"：把它们当成"还差一个用户" |
| 22 | ★★ **连接器声明里的工具名该写「公开名」还是「裸名」**（第 17 轮**新查出**；第 18 轮**功能上已两可**） | 产品 + 项目主（**只需定约定**，不再是功能阻塞） | 第 17 轮接上 DSH 的 MCP 命名契约（`mcp__<serverName>__<rawName>`，逐字读 `packages/mcp/mcp-client/src/tools.ts`）后照出来的一件事：**声明里写的是裸名**（`list_issues`）而**线上来的永远是公开名**。实测（第 17 轮）：`github` 声明 `list_issues` 时，调 `mcp__github__list_issues` ⇒ **`deny`「没有声明工具」** ⇒ **一个正确声明过的工具，在真 DSH 进程里会被拒**。★★ **第 18 轮已修**：`registry.mjs` 的 `declaredToolNames` 让登记表**同时**认两个名字（归属与判定共用**一份**实现），实测该调用在连接器层从 `deny` 变成 **`allow`**。⇒ **要裁决的只剩「写哪个」这个约定** | ★ 功能上**两种写法现在都能工作**（写裸名 ⇒ 由 `declaredToolNames` 推导公开名；写公开名 ⇒ 字面命中）。**不要**为了"统一"删掉裸名那一半——它兜住"连接器声明一个 DSH 核心工具名"那一类合法用法。★ 也**不许**在归属时"把命名空间剥掉"：DSH 的公开名在归一化/截断时会被替换成 12 位 SHA-256 后缀（`mcp__github__a b` ⇒ `mcp__github__a_b_200f08ef849a`），那时**剥不出** rawName；`tools.ts:9-10` 逐字写着 "the public name is never parsed to recover it"。★ 建议**按连接器自己那一侧的名字写**（可读，且是唯一总能写对的形式），由登记表负责换算 |
| 23 | ★★ **命名空间"认不出来"的那一类要不要按教义拒**（第 17 轮**新查出**，见 §4.2 第三次末段） | 产品 + 项目主 | `mcp__evil__x`：一个 MCP 公开名，而它那个命名空间**没有任何已知连接器**占着（一次漏配，或一次**未经声明的挂载**）。它今天落到**政策门**（不是登记表）。按 `registry.mjs` 文件头 ① 的头号教义，它应当**被拒**——而做不到的原因是**端口形状**：`resolveConnectorId` 的值域是 `string` 或 `null`，**装不下"拒"**。要裁决的是：**要不要**新增一个端口（例如 `connectorShape` 谓词）让"连接器形状、但命名空间不认识"能被表达成一次**具名的拒绝** | ★ 这一格与第 22 条是**相反方向**的两个缺口，别合并：第 22 条是"**已登记的**连接器把**合法**工具拒了"（过严），本条是"**未登记的** MCP 服务器把工具放过去"（过松）。★ 不裁决则：一个未声明的 MCP 服务器挂上来，它的工具走政策门——未知工具在那里是 fail closed，所以**今天不致命**；但**一旦某个名字在政策门眼里是已知的低风险读工具**，它就会被放行，而登记表连问都没被问过。★ 本批**没有**偷偷加这个端口，也没有把它塞进 `resolveConnectorId` 的返回值里凑合。★ 它与第 24 条的关系：**两条都是"过松"方向**（都该拒而没拒），而第 24 条更根本——**今天即使它被拒了，理由也会是政策门而不是登记表** |
| 24 | ★★★ **政策门要不要从连接器声明里读「能力」**（第 18 轮**新查出**，见 §4.2 第四次） | 产品 + 架构 | 第 18 轮修好"声明名 vs 公开名"之后，**最终判决仍然是 `deny`，理由是 `[政策门]`**：`tool-capability.mjs` 的 `resolveTool` 对不在它目录里的名字一律给 `direction: 'write'`、`requiresApproval: true`（fail closed），而 MCP 工具的公开名**不在那个目录里**。⇒ 一句必须说清的话：**连接器层今天只能让事情更严，永远不能让它更松**——一个"连接器声明了 `allow`、而每次调用都要人批"的系统，与一个"连接器层根本没接上"的系统，在**最终判决**上是同一个 `deny`（只不过前者的理由里写着 `[政策门]`）。要裁决的是：**政策门要不要（以及怎么）从声明里取能力/风险**，从而让连接器层的 `allow` 真的生效 | ★ 这**不是**一个明显的 bug：`deny > ask > allow` 的取严合并正是为了让连接器层成为**额外**约束而不是替代品；让政策门从**声明**读能力会把两层耦合成一层，并打开一个新方向——**一条写错的声明可以下调政策门的评估**（层内"风险只能往上抬"那条纪律管不到跨层）。⇒ 三条路各有代价：**(a)** 保持现状（MCP 工具一律要人批，最安全，但连接器策略事实上只用于**收紧**）；**(b)** 让声明向政策门提供能力（连接器策略真正生效，但引入跨层下调的口子）；**(c)** 折中：只允许声明**抬升**，政策门对声明来的能力取 `max(静态评估, 声明)`。★ 本批**没有**动 `tool-capability.mjs`，也没有把这个口子偷偷打开 |
| 25 | ★★★ **「这个岗位能调哪些 MCP 工具」该由哪张表说了算**（第 19 轮**新查出**，见 §4.3） | 产品 + 架构 | 第 19 轮给 PRT-605 接了端口时，`execution-scope.mjs` 的 `mcp` 段与 F-21 的**连接器登记表**第一次同时出现在生产路径上——**两张表都声称自己决定"哪些 MCP 工具可用"**，而且两道检查接在**同一个** `preExecute` 上（`connectorJudgment` 与新的 `executionScope`）。要裁决的是：**哪一张是权威**——是 PRT-605 的 `mcp.servers[].tools`（岗位授权表，按 `server__tool` 对），还是 F-21 的连接器声明（按连接器自己的名字 + DSH 公开名，`declaredToolNames` 两个都认）？ | ★ 本轮**没有**替它做决定，而是把它做成一次**具名的拒绝**（`execution-scope-port-mcp-limb-unwired`）：配了 `mcp` 段 ⇒ 拒，理由逐字写清"权威在连接器登记表，两份表不许并存"。★ 为什么不"顺手接上"：DSH 送上来的公开名是 `mcp__<server>__<rawName>`（**两个** `__`），而 `splitMcpTool` 要求**恰好一个**——把线上名字直接喂进去会以 `MCP_AMBIGUOUS_NAME` 拒，*方向是安全的（拒），而**理由是错的**，且后果是"每一个 MCP 调用都被拒"——一个"配置笔误"与"这道检查坏了"会表现成同一句话*；而靠**拆开公开名**还原是堵死的（截断后带 12 位 SHA-256 后缀，`tools.ts:9-10` 逐字 *the public name is never parsed to recover it*）。★ 不裁决则两种坏结果各占一半：接上去 ⇒ 两道检查对同一个 MCP 工具给出**两个**结论（而 `deny > ask > allow` 的取严会让严的那张永远赢，于是另一张表**写了等于没写**，但账上记着"配了"）；不接 ⇒ `mcp` 段今天只能表达"这个岗位没有任何 MCP 授权"（拒绝靠的是**段缺席**，不是**段内容**）。★ 与第 24 条的关系：第 24 条问"政策门要不要读声明里的能力"，本条问"**两张 MCP 表**谁是权威"——两条都会让"配了却没生效"变成一件读不出来的事，但**改的文件完全不同**。★ 建议方向：**F-21 的连接器登记表为权威**（它已经认两个名字、已经有熔断与反馈面、已经接在同一个 `preExecute` 上），而 `execution-scope.mjs` 的 `mcp` 段**降级为"这个岗位允不允许调 MCP"这一个布尔**（或直接删除该段并写进废弃说明）——但这是**裁决**，不是本轮能单方面关掉的 |
| 26 | ★★★ **外部 API 授权表要不要管 scheme**（第 20 轮**新查出**，见 §4.3 第 ⑨ 条） | 产品 + 架构 | 第 20 轮给 PRT-606 接上端口之后，`checkExternalApi` 的**输入**第一次真的从线上来了。而它**不看 scheme**——`normalizeHost` 只取 host、`normalizeUrlPath` 只取 path，`scheme` 从头到尾没被读过（`SCHEME_DENIED` 那一条归 PRT-605 的 `checkNetwork`）。⇒ 精确读数是：**一个 `ftp://api.example.com/api/items/1` 只要 host 与模式对得上，就会被 `externalApiScope` 放行**；它**不会**因此就真的发得出去（`executionScope` 的 `checkNetwork` 会拦 scheme），但"外部 API 读/写授权"这一道自己给的是 `allow`。要裁决的是：**(a)** 保持现状（scheme 只由 `checkNetwork` 管，两道各管一段）；**(b)** 让 `checkExternalApi` 也拒非 http(s)（一道能自洽，但从此两道对同一个 URL 有两套 scheme 规则）；**(c)** 在端口适配器里拒（**最坏**：把策略写进适配器，而适配器本该只做形状转换） | ★ 本轮**没有**顺手加"必须 http(s)"，因为那是**发明策略**——PRT-253 §3 明令禁止发明默认值，而"哪些 scheme 算外部 API"是一个产品决定（`ftp`/`file`/`gopher` 各不相同）。★ 为什么它**今天不致命**：端口为 `null` 时是放行，所以真实部署里 `externalApiScope` 仍是 `false`（见第 ⑨ 条最后一段的 `envNames` 缺口）；而且这一道与 `checkNetwork` 接在**同一个** `preExecute` 上，取严的合并会让 `checkNetwork` 的 `SCHEME_DENIED` 先赢。★ 为什么仍然要记：**这两道今天谁先谁后没有判据钉着**——`externalApiGuard` 在 `executionGuard` **之后**跑（顺序有注释、有用例，但用例钉的是"包装在 code 里对得上"），而"取严"这件事在 `preExecute` 上是**短路**（先拒的说了算），不是真的一次取严合并。⇒ 一旦那个顺序被改，`ftp://` 这种 URL 的处置就跟着变，而**没有任何读数会发现** |
| 27 | ★★★ **岗位清单说的是「Legion 能力名」还是「执行面工具名」**（第 21 轮**新查出**，见 §4.4） | 产品 + 架构 | 第 21 轮把 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11 留下的两处"我没有量"量掉之后，`whitelist`（PRT-603）这一道的缺口**不在配置里**：唯一那个产出者 `permitsTool` 的输入是 **Legion 能力名**（`read-file` / `git-push` / …），而桥交给这个端口的投影里那个工具名是**执行面（DSH）名**（`read` / `write` / `bash` / `web_fetch` / …），两个空间**结构上不相交**（`tool-capability.mjs:465-492` 早就写过这件事——那条讲的是**静态下限**）。实测：同一份 permit，喂 Legion 名 ⇒ 放行；喂 DSH 名 ⇒ **一个都不放行**，抬 `maxRisk` 到最高也救不了（拒因从 `risk-above-ceiling` 挪到 `unknown-tool-not-named`，**还是拒**）。而"加一个反向映射"也不行——`LEGION_TOOL_ROUTING` 的反推在 `bash` / `pwsh`（各 4 个）与 `web_fetch`（2 个）上**一对多**，而 `bash` 那一堆里同时塌着低风险的 `git-status` 与高风险的 `git-push`。要裁决的是：**让 `permitsTool` 收执行面名 + 一份执行面能力表，还是继续收 Legion 名并新增一层带取舍的翻译？** | 不决定则这一道**接不上**——不是"暂时没配"，是**接上去也只会全拒**：*一个「拒得对、而理由是错的」的检查，与一个「放行了它该拒的」的检查，在今天的行为上是同一个东西，只不过照着理由去改的人会改错地方，而改完仍然是拒的，于是没有人会发现理由本身是错的*。★ 顺带查出的两个同名 `EmployeeManifest`（强制面 `MANIFEST_FIELDS` **10** 个 / 上下文 `stableRecord` 写死 **11** 键，**两个方向都不可转换**：一个抛、一个丢字段）也在本节一并记账，但它是否要合并是**另一个**裁决 |
| 28 | ★★★ **那条"出站车道"的文件该放在哪个目录**（第 22 轮**新查出**，见 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14） | 产品 + 架构 | 第 22 轮把决策表第 15 条（PRT-610 的**写入方**）那条缝造出了能走通的两半：写入侧 `runtime/toolcall/spool.mjs`（套件 `toolcall-spool` 14 例）、收账侧 `orchestrator/worker/toolcall-drain.mjs`（套件 `toolcall-drain` 13 例），并在**真 SQLite** 上把整条环走通：执行面（无 token）写 spool → 收账侧（有 token）调 `recordToolCall`/`markDispatched`/`recordResult` → `toolCallLogEvidence().recorded` 由 `false` 翻成 `true`。⚠️ **但生产里还没有人调它们**，而缺的**不是代码**、是**一个位置决定**：收账的一方今天拿不到 spool 的目录（hub 的库是 `team-hub/team.db`，`server.mjs:279`，它**不读** `LEGION_DATA_DIR`），而生产者那一侧拿不到 Run 维度（`onDecision` 是**装配期**参数，runId 是**按 Run** 到的）。要裁决的**只有一个问题**：这条车道的目录由**哪一个**既有配置量派生（`LEGION_DATA_DIR`？hub 的 `dbFile` 同级的 `dataDir`？还是新登记一个键），以及谁负责在**按 Run** 的缝上绑 runId。 ★★ **要裁的只有一件事**，而这件事有**三条路**（各自与已裁决事项的关系都写清了，`DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.7）：**甲** 新登记一个部署配置键、两半各自从自己的 env 读——★ 它会落进**同一个没修的数组**（第 19 条那个人工项 A 今天缺 4 把键），等于把本条**并进**第 19 条，一起通或一起不通；**乙** 收账侧住进 hub 进程、路径从 hub 自己的 `dbFile` 同级目录派生（`server.mjs:279`）——不新增键，但把车道位置**绑死在库位置上**，且那条隐式耦合没有任何地方写着；**丙** 照第 19 条裁决的形状按 Run 交付目录（PRT-214 那五个性质）——最贵，但**唯一与第 19 条逐字一致**的一条，且 runId 必须在**按 Run 安装**的那一处绑（`root-row.mjs:591` 是**进程级单例**，在那儿绑死会让整个进程只往**第一个** Run 的账本里写）。★★ **本轮不替业主选**——"猜一个两边都同意的路径"正是 PRT-253 §3 禁止的"发明默认值"。 | ★ **不许"猜一个两边都同意的路径"**——那正是 PRT-253 §3 明令禁止的"发明默认值、替身或暂时放行"，而它的后果是让"没接线"与"接好了"在读数上**同形**，正是过去 21 轮反复付代价的那一件事。**不决定**则第 15 条继续停在原处：表在、读面在、就绪判据在，而 `decisionSourceRecorded` **依然没有任何产出者**——发布门禁永远判否，而它判否的理由（"缺失的证据不是证据"）读起来完全正确。★★ 本轮**没有**擅自接线，也**没有**把第 15 条记成已关：交付口径是"**车道已建、环已证、位置未决**"。★ 生产接线的两个候选接缝已读出（hub 进程 / `root-row.mjs:591` 的 `onDecision`），但第二个必须从**按 Run 安装**的缝读 runId（PRT-214 两遍先例的形状）——`root-row.mjs` 是**进程级单例**，在那儿绑死一个 Run 会让整个进程只往**第一个** Run 的账本里写。 ★★★ **★★ 本条不是一个实例，是一族**（§14.8）：它问的其实是"**控制面的数据怎么到达执行面**"这条**通用契约**，PRT-610 只是第一个被施工的实例。**F-18 / F-19 的执行面一半**（`runtime/experience/{friction,graph}.mjs`、`runtime/employee/role-pack.mjs` 三个模块零生产调用方）与 **Pack 账**（hub 有 `GET /api/packs/account`、**生产里没有任何消费方**）**卡在同一处**。⇒ 这解释了一件本来会显得奇怪的事：**它们代码侧各有进度，却都停在原地——不是缺实现，是缺同一个决定。**★ 反之：范围表与连接器声明**不**在这一族里，它们走的是**部署配置键**那条路，缺口是第 19 条的人工项 A。★ 在裁定之前**不去给它们各自发明一个位置**——那会把 PRT-253 §3 再犯三次。 |
| 29 | ★★ **`RunRequest.env`（环境变量白名单）要不要有真消费者**（第 30 轮**新查出**） | 产品 + 架构 | 两份规格都把它写成 RunRequest 的**必要内容**：本仓目标文档 §4.1 F-01 逐字「`RunRequest` 必须包含 …工作目录、**环境变量白名单**和工具权限」（`MULTI-AGENT-FEATURE-OPTIMIZATION.md:146`），设计规格 `2026-09-11-legion-runtime-design.md:195` 同。第 30 轮把它逐项量了一遍（`scratch/_probe-env-whitelist.mjs`）：① **不在** `RUN_REQUEST_REQUIRED`（15 个必填字段）里 ⇒ **不是必填**；② 给了**会**校验形状（非数组 ⇒ `env 必须是数组（白名单）`，`run.mjs:218-222`）；③ 不给**静默补成 `[]`**（`run.mjs:227`）；④ **读者一个都没有**——全仓 `req.env` / `request.env` **零命中**，`runtime/adapters/**` 没有任何一处碰它。⇒ 一次 Run 报不报白名单，对执行**没有任何影响**。★★ 而同一个文件 `run.mjs:97-125` 用一整段论证过**为什么 `enforcementFloor` 不能这么写**——那里选的是三态（`absent`/`installed`/`refused`），原话是「一个"用必填字段把缺席挡在门外"的契约，与一个"让每个人都编一份空下限才进得来"的契约，是同一个东西」。`env` 走的是相反的一条：缺席折成 `[]`，于是「**没声明**」与「**声明了一个都不许**」在读数上是**同一个值** | ★ **不许**顺手把 `env` 改成必填：今天唯一的生产者（`orchestrator/worker/executor.mjs:1061-1091`）**不发**这个字段，改成必填等于逼每个人都**编一份**白名单——那正是上面那段论证禁止的形状，而且编出来的值方向是**收窄**（可能拒掉合法环境）。两条路：**①** 给 `env` 接一个**真消费者**（那它才是一条真的白名单，且要照 PRT-214 的五性质办），或 **②** 承认环境的作用域**本来**就是**进程级**的（`product/process-manifest.mjs` 的 `envNames` + `buildChildEnv()`——今天真正在起作用的那一层），于是把两份规格里那句"必须包含"改掉、并决定这个字段是留还是删。★ 本条**不作恶**的原因只有一个：这一格**本来就没被消费**——"它没伤人"与"它是对的"是两件事。★ 与第 15/18 条同族（**能力在、生产里没有消费者**），但**解法不同**：那两条缺的是"谁来调用"，本条缺的是"这个字段到底该不该存在"。详见 `MULTI-AGENT-FEATURE-OPTIMIZATION.md` §1.3.1 |

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

**仍未接的**：`whitelist`（岗位白名单）与 `external-api-scope`（PRT-606）两道。
所以本节标题"三道范围检查"仍然成立，只是**前两道**各有一条能走通的路。

配套的可达性读数（同一次改动，机器可核）：
`runtime/dsh-composition/path-scope.mjs` 与 `scope-table-binding.mjs`
从"不可达"变成**可达**（基线 49 → 47 条）——那正是"判定写好了、只是没人给它一份表"
这句话消失的形式。

### ★★★ 2026-09-18 第 19 轮更新：**第二道（PRT-605）也接上了**——而它是被自己的判据叫来的

新增 `runtime/dsh-composition/execution-scope-port.mjs`（`LEGION_EXECUTION_SCOPE`）
＋ `scope-facts.mjs`（**事实只算一次**），`enforcementSurfaces()` 从 **7 格变 8 格**：

| 部署配置 | `pathScope` | `executionScope` | 含义 |
| --- | --- | --- | --- |
| 都没配（**今天的默认**） | `false` | `false` | 与本节最早那张表同形——没配就是没配 |
| 只配了路径范围 | `true` | `false` | ★ 两格**独立**：一格读数下这两种状态是同一个 |
| 都配了 | `true` | `true` | 两道都真的会拦人（已用真实 `preExecute` 验过） |

★ 而这次接线**最早是被一条判据叫来的**，不是被"该做了"叫来的：
`runtime/dsh-composition/production-scope-wiring.test.mjs` ② 从本轮之前就逐字钉着
"桥的参数表里没有 `executionScope`"，并在失败消息里写着
*一条"接上了而账上还写着没接"的记录与一条"没接而账上写着接上了"，同样不能用来做判断*。
⇒ 本轮照做了，而**那条判据没有被删掉、也没有被放宽**——它换了一个对象继续守
（`externalApiScope` 仍不许出现）。

★★ 同一族还有一条**仍然不可达**的模块被本轮补进可达性读数：
`product/execution-plane-config.mjs`（`readExecutionPlaneConfig` 零生产导入方）——
它与三道范围表是**同一族**（*一个"读取器写好了、而没有生产调用方"的模块，
与一个"这份配置根本不存在"的模块，在"范围表配了没有"这个问题上给出同一个答案：没配*），
归属第 19 条，已裁决、待施工。

### ★★★ 2026-09-18 第 20 轮更新：**第三道（PRT-606）也接上了**——三道结清

新增 `runtime/dsh-composition/external-api-scope-port.mjs`（`LEGION_EXTERNAL_API_SCOPE`），
`enforcementSurfaces()` 从 **8 格变 9 格**：

| 部署配置 | `pathScope` | `executionScope` | `externalApiScope` | 含义 |
| --- | --- | --- | --- | --- |
| 都没配（**今天的默认**） | `false` | `false` | `false` | 与本节最早那张表同形——没配就是没配 |
| 只配了路径范围 | `true` | `false` | `false` | ★ 三格**独立**：一格读数下这几种状态是同一个 |
| 只配了执行面 | `false` | `true` | `false` | 同上 |
| 都配了 | `true` | `true` | `true` | 三道都真的会拦人（各用真实 `preExecute` 验过） |

★★ 而**第三次接线同样是判据叫来的**，这一点现在有了三轮的证据：
`production-scope-wiring.test.mjs` ② 在每一轮结束时都会改写自己的对象，
并在失败消息里逐字要求"把台账、docs 与本套件一起更新"。
⇒ 第 19 轮它指向 `externalApiScope`，第 20 轮照做；而它**第三次换对象**——
现在守 `whitelist`，那是一个**不同形状**的缺口：

> 三道范围检查是"**桥里没有位置**"（连一格 `false` 都读不出来）；
> `whitelist` 是"**位置在、而生产装配从不给它值**"。
> 前者连"我该配什么"都问不出来，后者问得出来却**没有任何人**在问。 **★ 2026-09-18 第 21 轮订正：见下方。**

★ 三道**全部**接上之后，这一族里剩下的最后一个成员就是 `whitelist`（PRT-603）。
**没有任何一条判据会去问"谁该给 `whitelist` 一个值"**——它有一格 `false`、
有一份套件、有一份台账 ✅，而生产装配里那个键从来不存在。

### ★★★ 2026-09-18 第 21 轮更新：最后那个成员**不是配置项**——它压在词汇表上

上面（第 20 轮更新）把 `whitelist` 记成"**位置在、而生产装配从不给它值**"，
并由此说它"问得出来却**没有任何人**在问"。第 21 轮量完
`DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11 留下的两处"我没有量"之后，
这句话要改成：

> 不是**没有人**在问，是**问了也答不上**——唯一那个产出者与桥要的输入
> **不同词汇表**。

| 问题 | 第 20 轮记的 | 第 21 轮量出的 |
| --- | --- | --- |
| 缺口在哪一层 | 配置（"没人给值"） | **词汇表**（产出者说的是 Legion 能力名，桥交进来的是 DSH 名） |
| 该往哪修 | 加一个环境变量（像前三道那样） | **不适用**——接上去会得到一个**全拒**的强制面 |
| 那一格今天的读数 | `false` | `false`（**没变**） |

⇒ 前三道"配一个环境变量就接上了"的修法在这一道**不适用**。所以它从
第 **14** 条那一格（"范围表从哪来、挂在哪一层"）里**移了出去**，成为第 **27** 条。
详细读数见 §4.4。

### 怎么核出来的

| 环节 | 位置 | 读数 |
|---|---|---|
| 生产装配的**唯一**入口 | `runtime/dsh-composition/plugins/root-row.mjs:508-536`（§9.5 接线前是 485-509） | `installEnforcementRoot({ env, decide, createRequestApproval })` —— **只有三个键** |
| 组合根透传 | `runtime/dsh-composition/root.mjs:465-466` | `whitelist: input.whitelist, pathScope: input.pathScope` ⇒ 两者都是 `undefined` |
| 装配默认值 | `runtime/dsh-composition/assemble.mjs:135-136` | `whitelist = null, pathScope = null` |
| 桥的行为 | `runtime/dsh-composition/tool-request.mjs:638-651` | `if (pathScope === null) return undefined` —— **返回 undefined 就是放行** |
| 两个检查器的 import 者 | `grep 'from .*(path-scope\|execution-scope\|external-api-scope)'` | **只有它们自己的 `.test.mjs`**（零生产 import 者） ★ **[2026-09-18 订正]** 这句话对 `path-scope.mjs` **已经不成立**：它现在有两个**生产** import 者（`scope-port.mjs:50`、`scope-table-binding.mjs:72`），而 `scope-port.mjs:169` 真的调 `checkPathScope(...)`。**仍然成立**的是 `external-api-scope.mjs`（零个生产 import 者）。⇒ 本行那句"零生产 import 者"只该读作"对 606 成立"。 ★ 订正方法是**可达性探针的红**，不是重跑这行 grep——*一个写在表格里的读数，与一个被测的东西，差别在于前者不会自己变红。* ★★ **[2026-09-18 第 19 轮再订正]** `execution-scope.mjs` 也**不再**成立：它现在有一个生产 import 者（`execution-scope-port.mjs:44`），而那个端口在 `executionGuard` 里真的调 `checkCommand` / `checkNetwork` / `checkMcp`。⇒ 本行现在只对 `external-api-scope.mjs` 成立。★ 而这次订正**同样是可达性探针的红**顶出来的（`reachability.test.mjs` ④ 报"execution-scope.mjs 已经变成可达了"）——两次订正走了同一条路，这本身就是这条注释值得留在这里的证据 ★★★ **[2026-09-18 第 20 轮第三次订正]** `external-api-scope.mjs` **也不再成立**：它现在有一个生产 import 者（`external-api-scope-port.mjs`），而那个端口在 `externalApiGuard` 里真的调 `checkExternalApi`。⇒ **这一行整个作废**：三道范围检查器现在**各自都有生产 import 者**，"零生产 import 者"这句话在本节里已经没有对象了。★★ 而第三次订正**还是**可达性探针的红顶出来的（`reachability.test.mjs` ④ 报"external-api-scope.mjs 已经变成可达了"）——三次订正、三次同一条路。★★★ 第三次还多顶出一件事：`reachability.test.mjs` 的基线闸**只守一个方向**（② 管"当前不可达的要有分类"、③ 管"基线里的文件要还在"），**没有一条管"基线里判成 gap 的模块后来被接上了"**。实测有**两条**过期条目——`external-api-scope.mjs`（本轮）与 `execution-scope.mjs`（**第 19 轮**就接上了，一直留到今天）。⇒ 已新增用例 ③b 补上那个方向，基线 46 → 44 条。*一个只能涨不能跌的"死代码清单"，与一个读数，是同一个东西——只不过前者会让人以为缺口在变多。* |

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
| 13 | F-21 连接器判定面接进 `preExecute` | 连接器声明（`connector-store`，hub 侧）**＋ 一次调用的成败** | 声明在 hub 上，而 Runtime 进程**没有 token**；`TEAM_HUB_URL` 只是一个地址。★★ **这一条要的输入是两份，不是一份**（2026-09-18 第三批量出）：`decide()` 读熔断器状态，而改那个状态的 `recordOutcome` **生产调用方为 0**、强制面桥**没有执行后钩子**、`enforcementSurfaces()` 里**也没有 `connector` 这一格** ⇒ 只接判定面会得到一个**永远合闸的熔断器**，而且**一行错都不报**。详见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §10 ★★★ **[2026-09-18 第三批·接缝已建好]** 上面那句"桥**没有**这个接缝"**现在不成立了**——本批**动了代码**：`runtime/connectors/outcome-port.mjs`（把 DSH 的 `tools/result` 载荷变成 `recordOutcome({connectorId, ok, error})`）＋ `runtime/dsh-composition/plugins/connector-feedback.mjs`（订阅 `tools/result` 的那一行），由 `assemble.mjs` 在拿到连接器声明时**一次装齐两半**；`enforcementSurfaces()` 从 **5 格变 6 格**（原来连"连接器"这一格都**没有**）。★ **边界也核了**：DSH 的钩子**有两个且语义不同**——`:169 'tools/post-execute'` 是 `waterfall`（在派发路径里，可 accept/replace/block ⇒ **改变**结果），`:191 'tools/result'` 是 `emit`（"Observe the frozen, lossless-JSON **final** outcome"）；熔断器是**记录器** ⇒ 要后者。⚠️ **但归零 ≠ 通了**：`runtime/connectors/registry.mjs` 因此**有了生产 importer**（探针 47/26 → **46/25**，本条归零），可是 `createRegistry()` 在 `assembleEnforcement` 里是**条件调用**，而**今天没有任何生产路径**给 `connectorDeclarations`（来源是**第 19 条**那个部署配置键）⇒ 精确读数是"**从没人 import 变成了被 import、但那个函数从不被调用**"。⇒ **本条不再是"要不要接"、也不再是"缺反馈接缝"：剩下的并进第 19 条。** 详见会话报告 §10.43。 |
| 14 | 三道范围表注入 `pathScope` / `whitelist` / `execution-scope` | 这一次 Run 的读根/写根/平台、命令/网络/MCP 授权、外部 API 端点 | `RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`（`runtime/contracts/run.mjs:158-181`）——**没有**范围表字段，也没有 host surface ★★ **这三道不是同一种缺口**（2026-09-18 第三批量出）：`pathScope` 已接（部署配置，`40d2d60`）；`whitelist` 端口在，**但算这个值的模块自己没在跑**——`permitsTool()`（`employee-manifest.mjs:317`）返回的形状**恰好**是端口要的，却**零生产调用方**，而它要的 `permit` 只能由 `narrowToGrant()` 产出、后者生产调用点全仓只有 `runtime/packs/authority.mjs:759` 一处，那个模块是 **`[gap]`** ⇒ **至少还压着第 19 条的包层**；真正属于本条（数据从哪来）的只有 `execution-scope` / `external-api-scope`。详见 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11  ★★★ **2026-09-18 第 21 轮：上面这句还要再改一次**——"**至少还压着第 19 条的包层**"**还不够**：即使包层跑起来、`grant` 与 `manifest` 都凑齐，**这一道仍然接不上**，因为唯一那个产出者（`permitsTool`）的输入是 **Legion 能力名**（`read-file` / `git-push` / …），而桥交进来的是**执行面 DSH 名**（`read` / `write` / `bash` / `web_fetch` / …），两个空间**结构上不相交**——同一份 permit 喂 Legion 名**放行**、喂 DSH 名**一个都不放行**，抬 `maxRisk` 到最高也救不了（拒因从 `risk-above-ceiling` 挪到 `unknown-tool-not-named`）⇒ 缺口的那一层既不是**配置**、也不只是**包层**，是**词汇表**。已从第 14 条移出、立为第 **27** 条。详见 §4.4 与 §5.2 第 21 轮更新 |
| 15 | PRT-610 `recordToolCall` 的**写入方** | 一次工具调用在哪一层落账 | 落账要走 hub（同样没有 token），或走一条**逐 Run 的**载荷。★★★ **2026-09-18 第 22 轮：那条"逐 Run 的载荷"造出来了，环也在真库上走通了**——写入侧 `runtime/toolcall/spool.mjs`（套件 `toolcall-spool` 14 例）＋收账侧 `orchestrator/worker/toolcall-drain.mjs`（套件 `toolcall-drain` 13 例），`toolcall-drain` ① 把 `toolCallLogEvidence().recorded` 由 `false` **真的翻成** `true`（并有否定对照 ①b：只写不收则仍是 `false`）。⚠️ **但本条仍然没关，且缺的不是代码**：生产里还没有人调这两半，因为**收账的那一方拿不到 spool 的目录**（hub 的库是 `team-hub/team.db`，`server.mjs:279`，它**不读** `LEGION_DATA_DIR`），而**猜一个两边都同意的路径**正是 PRT-253 §3 禁止的"发明默认值"。⇒ 已从本条移出、立为第 **28** 条。详见 §14 与 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14 |
| 18 | F-18 / F-19 的执行面一半（算摩擦分、记图边、建岗位包） | validations / attempts / 岗位包内容 | 都在 hub 上，同上 ★★ **2026-09-18 第 22 轮复读**：本条与 PRT-610 那一项（第 15 项）**卡在同一处**——不是缺实现，是缺**同一个决定**（第 28 条：控制面的数据怎么到达执行面）。⇒ 见 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.8。 |

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

## 5.9 ★★★ 第 25 轮：**数字也会烂** —— 主表 33 处计数声明里 3 处与实测不符

§5.8 的标题是"标签会烂，指针也会烂"。这一节是同一族的**第三个成员**：
**计数也会烂**——而且它是三者里**最可机器核对**的一个
（CI 每一行套件都带 `tests=N`，声明就在文档里，两者本可以自动对上）。

### 读数（`node scripts/prt/suite-counts.mjs` 可复跑）

主表（`F-01..F-25` 那 15 行）里共 **33** 处"套件 X（N 例）"声明：

| 项 | 修复前 | 实测 | 判读 |
| --- | --- | --- | --- |
| `runtime-contract`（F-01） | 13 | **64** | 套件两级文件之和（`contract` 45 + `fake-adapter` 19） |
| `dsh-adapter`（F-02） | 25 | **98** | 同一个文件，长了 73 例 |
| `registry.test.mjs`（F-21） | 32 | **37** | 同一个文件，长了 5 例 |

**其余 30 处全对。** ★ 这个"30 对 3 错"的分布本身就是一条读数：
三个数**都不是**"写的时候算错了"（§5.8 那两处的成因），而是
**写完之后用例还在长**——而那三格描述的是**今天的状态**。

> 一个"写的时候数对了"的数字，与一个"昨天数对了"的数字，
> 在文档里长得一模一样——而后者是**借来的**权威。

### ★★ 为什么**不**把全仓的"N 例"都做成判据

全仓扫下来有 **106 处**与实测不符。而其中绝大多数是**历史读数**
（"本轮…5 例"、evidence 日志里当时的数）——**那些必须留着旧值**，
改它们就是**篡改历史**。

> 一条"当时的读数"与一条"现在的读数"，在文本里长得一样——
> 而前者**必须**冻结、后者**必须**跟着代码走。
> 所以一条"全仓 N 例都不许过期"的判据会**红在正确的地方**。

⇒ 判据**只查主表**（`| F-NN … |` 那 15 行，与 §2 描述的当前状态），
并且测试 ④ 专门钉住这一点：拿一条非主表的历史读数去喂，它必须**不**报。

### ★★ 为什么**不**复用 CI 的套件行计数

CI 一行**聚合多个文件**：`path-scope` 那一行 = 4 个文件 ⇒ `tests=67`，
而声明说的 `path-scope` 22 例指的是**其中那一个文件**。两个数都真，
只是**分母不同**。

我第一版就是拿聚合总数去比单个数，得到 **135 处假发现**——
那与第 23 轮"拿窗口聚合去比单次上限"是同一类错
（见 §5.9 末尾的诚实边界）。⇒ 判据**真跑文件**（32 个，串行 ≈ 18s）。

### 判据与变异

- 新套件 `scripts/prt/suite-counts.test.mjs`：**10 例**，已登记进 `run-ci.mjs`；
- 变异（`scratch/_mutate-counts.mjs`）：把上面三个数**逐个改回去**，
  再加一个"漂亮但错的数"，**4/4 逐条咬住**，还原后**逐字相同**；
- 关键断言不是 `ok`，而是 **`skipped` 必须为 0** —— 见下。

### ★★★ 写这道判据时踩的两个坑（都是"门禁瞎掉而看起来是绿的"）

**坑 A：提取器只认到 20 条，而实际 33 条。**
行首正则写成 `/^\|\s*(F-\d+)\s*\|/`，于是
`| F-05 前半 |`、`| F-19 缺口① |` 这样的主表行**一条都没被认出来**
（漏掉的 13 条里含 `run-events.test.mjs` 18 例、`event-delivery.test.mjs` 31 例）。

> 一个"只认 20 条、而这 20 条全对"的门禁，与一个"33 条全对"的门禁，
> 在只有 `ok: true` 的输出里是同一个东西——而前者**看起来更可信**：
> 它还报了一个具体的条数。

**坑 B：在测试运行器里 spawn 测试运行器，子进程一个字都不输出。**
这道判据自己是套件，它要 spawn `node --test <别的文件>`。父进程带着
`NODE_TEST_CONTEXT` 时，子 node 认为自己是测试 worker：

```text
父进程在 test runner 里 + 不清 env   ⇒ len=0        ℹ tests 读不到
父进程在 test runner 里 + 清 env     ⇒ len=1169     读得到
父进程不在 test runner 里           ⇒ len=1166     读得到（所以直接跑 CLI 时看不出问题）
```

⇒ 32 条声明**全部**落进 `skipped`，返回体是 `{ ok: true, checked: 0, skipped: 32 }`。

> 一个**完全瞎掉**的门禁，与一个"32 条全对"的门禁，
> 在只看 `ok` 的输出里是同一个东西。

抓住它的是测试 ① 里那条 **`skipped === 0`** 的断言——
这条断言就是为这种形状写的（与第 23 轮 F-15 的 `confidence` 同一个设计）：
**"跳过多少条"必须与"都对"分开报**。

### 诚实边界

- 它查的是**用例条数**，**不**查"这些用例测的东西对不对"。
  绿只等于"声明与实测的条数一致"，**不等于**那一格的证据够用。
- 它认不出**语义**上过期而**数字**恰好不变的声明
  （例：换了实现、条数没变）。那要读懂内容，做不了。
- `runtime-contract` 那一档是**套件级**（两级文件求和）。
  如果哪一天 CI 那一行拆成两行，这个数会从 64 变 45 —— 判据会红，
  那正是"分账变了要有人看一眼"的正确表现。

## 5.10 ★★★ 第 26 轮：那一族的**第四个成员** —— 报告声称"可复跑"

§5.8 是"标签会烂，指针也会烂"，§5.9 是"数字也会烂"。这一节是**同一个形状
换到最靠前的位置**：不是某个数字过期，而是**整份汇总报告的标题在保证**。

§二 的标题是「最终读数（**都是机器读数，可复跑**）」。这句话本身
**没有任何东西核对**——而它出现在一份**专门用来汇总"哪些读数可信"**的报告里：

> 读者正是**因为**它写着"可复跑"才不去跑。

我去跑了（`scratch/_verify-readings.mjs`）。**大部分对，抓到一处真漂移**：

| | 值 |
| --- | --- |
| §二 表里最新一行（`交付 HEAD`，`.ci/r25`） | `test` **824992ms** |
| 紧挨着表的正文那句 | "test 阶段那 **808** 秒里……" |
| 808s 实际是哪一轮 | **第 23 轮**（`.ci/r23b`，807541ms） |

**第 22 轮**写下那句话；**第 23 轮**往上面那张表加行时，
**没有回头改句子**。于是同一份报告里，表说 825s、正文说 808s。

> 一张表里已经写了三轮新读数，而紧挨着它的那句话还记着第一轮的那个数。
> 两者在报告里长得都像"机器读数"。

### 做成了 5 条判据（加进既有的 `boundary-facts`，没有另起一套）

| 判据 id | 两侧分别是什么 |
| --- | --- |
| `handover-ledger-tallies` | 散文里的 `145 = 140 ✅ / 4 ⏸ / 1 ⬜` ↔ 台账每行的状态标记（**三个数都核**） |
| `handover-tracked-suites` | 散文里的套件数 ↔ `git ls-files '*.test.mjs'` |
| `handover-unreachable-total` | 散文里的不可达条数 ↔ 基线 JSON 的数组长度 |
| `handover-doc-ratchet` | 散文里的棘轮 ↔ `doc-table-integrity.mjs` 的 `REPO_WIDE_BASELINE` |
| `handover-ci-prose-matches-table` | 散文那句秒数 ↔ 表里最新一行的毫秒数（秒 = round(毫秒/1000)） |

★ 加进 `boundary-facts` 而**不**另写一套，是因为那份模块已经解决了这条路的
三个关键问题：① 两侧必须**独立读出来**；② 锚点找不到要判红；
③ 锚点命中多于一处也判红。第 5 条是新形状（两侧都在同一份文档里：
散文 vs 表），但那**不是**"手抄件互核"——表里的毫秒数是每轮从
`summary.json` 抄进来的**实测**，散文那句是**对表的概括**，
概括与表不一致本身就是缺陷，而且**真实发生过**。

### 判据与变异

- 自身套件 **36 → 43 例**；
- 变异打的是 **derive 侧**（既有测试 ③ 只打声称侧）：**5/5 咬住**，还原**逐字相同**；
- 真实仓库 **19/19，红 0**。

### ★★★ 这一轮踩的两个坑

**坑 A：变异全部"漏网"，而真相是变异没跑。**
第一版变异脚本在**同一个进程**里改源文件再 `checkFacts()`——
ESM 的**模块缓存**让它仍用改之前那份。

> "变异没执行"与"守卫没咬住"在输出里长得一模一样，处置却完全相反。

这是第 24 轮就写进报告的坑，第 26 轮又踩一次。改成 spawn 新进程后 **5/5 咬住**。

**坑 B：写这一节的解释文字，把判据自己搞红了。**
我照抄原文时连 `test` 外面的**反引号**一起抄，于是锚点在同一份报告里
命中**两处**，`ANCHOR_AMBIGUOUS` 判红。

> 一段**解释这个锚点为什么危险**的文字，自己给这个锚点制造了歧义。

这与本模块 `D2` 那件事同形：*解释这个 bug 的注释复现了这个 bug*。
处置是**改文档**（去掉反引号引用），不是放宽判据。

### 诚实边界

- 只钉这一份报告里**那几个承重的数**，不是"全仓散文里的数都核过了"。
- 第 5 条钉的是"散文 == 表里**最新**那一行"。将来若要指更早一轮，会红——
  那是对的：得把那句话写清楚。
- **它不核**"表里那些毫秒数与 `.ci/*/summary.json` 一致"
  （那要读每次 CI 各自的新目录）。**这一条仍是人工的。**

## 5.11 ★★★ 第 27 轮：那一族的**第五种形态** —— 同一张表的两个格子互相矛盾

§5.8「标签会烂，指针也会烂」→ §5.9「数字也会烂」→ §5.10「报告的标题在保证」。
这一节是同一个形状，但位置换到了**功能表内部**：

> 功能表的「状态」格与「还差什么」格**各由人填**，
> 而**没有任何东西**检查这两个格子是否相容。

### 读数：29 行功能表里，**2 行**自相矛盾

| 行 | 状态 | 「还差什么」 |
| --- | --- | --- |
| **F-22 后端与工作区** | 🟡（没做完） | **`—`**（不差什么） |
| **F-24 ACL 与安全姿态** | 🟡（没做完） | **`—`**（不差什么） |

> 一行 🟡 配一个 `—`，与一行 ✅ 在表里**长得一模一样**——
> 而读者只会看「状态」那一列。

其余 27 行彼此相容（`—` 只出现在 ✅ / ⏸ 行上，那是**正确**的写法）。

### 订正后写进去的内容

- **F-22**：核心**已交付**（`orchestrator/workspace/index.mjs` 472 行、真 `git worktree`、
  worker 接线、套件 `workspace` **24 例** + `workspace-wiring` **9 例**、PRT-306 ✅、可达）；
  **未做**的是 Docker / SSH / remote worker 扩展——spec 第 138 行明写「**后续**扩展」，
  且第 218 行把「**远程后端**」列进「按真实客户需求推进」。
- **F-24**：读面**已交付**（`read-auth.test.mjs` + `read-open-loopback.test.mjs` 覆盖读面矩阵）；
  **未做**的是多用户**写**面 ACL——第 218 行把「**多用户**」列进同一句。
  ★ 注意：这句「多用户写面 ACL 未做」**原来写在「依据」格里**——
  同一份信息放错格子，按「还差什么」读表的人与机器都读不到。

**两行都保持 🟡**，没有升级成 ✅：写清缺口是**补上缺失的信息**，
而把状态改成 ✅ 是**对"做完了"下断言**。前者我不需要谁批准，后者需要。
（表里 F-15 就是这个先例：核心已落地 + 一条子项未做 ⇒ 🟡，且缺口写出来。）

### 判据：`feature-table-status`（新套件，8 例）

规则只有一条、且**不需要猜**：

> 状态格的**终点**既不是 ✅ 也不是 ⏸ ⇒ 「还差什么」格**不许为空**。

★ **✅ 与 ⏸ 必须豁免**：表中 **21 行 ✅ 与 2 行 ⏸ 正是用 `—` 写的**，
而那是正确的写法。一条"任何状态下都不许 `—`"的规则会红在**23 个正确的地方**，
然后被人整体关掉——那比没有更坏（与 §5.9「全仓 N 例都不许过期」是同一种错）。

★ 状态可能是 `🟡→✅` 这种**迁移**写法，所以取**终点**：
`⬜→🟡` 的终点是 🟡（受约束）、`🟡→✅` 的终点是 ✅（豁免）。

### 变异：文档侧与代码侧**分开打**（5/5 咬住，还原逐字相同）

| 方向 | 变异 | 谁捉住它 |
| --- | --- | --- |
| 文档 | F-22 / F-24 的缺口格退回 `—` | 门禁在**真仓库**上（exit 1，点名到行） |
| 代码 | `isEmptyGap` 恒 false（门禁弄瞎） | **套件自己** |
| 代码 | 把 🟡 也当豁免（规则架空） | **套件自己** |
| 代码 | 把 ✅ 也算受约束（规则过宽） | **套件自己** |

★ 只打文档会漏掉"规则被架空了却仍然绿"这一整类 ⇒ **两个方向都要打**。
★ 每次都在**新进程**里跑：ESM 缓存会让同进程内的变异"看起来没生效"，
而*"变异没执行"与"守卫没咬住"在输出里一模一样*（第 24/26 轮的坑）。

### 诚实边界

- 它只查**两个格子是否相容**，**不查**缺口里那句话**对不对**
  （"未做 Docker/SSH"是不是真的没做，要读代码，机械判不了）。
- 它**不**能发现"状态与缺口都写得很自洽、但都是错的"。
- 16 行被**跳过**是因为它们不是功能表（§2 缺口投影表 3 列、§5.1 边界表 3 列，
  都没有状态列）。跳过数会报出来——*"跳过 16 行"与"16 行都合规"在只报 `ok`
  的输出里是同一个东西*。

## 5.12 ★★★ 第 28 轮：那一族的**第六种形态** —— 读数的**适用范围**

§5.8 标签/指针 → §5.9 数字 → §5.10 报告标题 → §5.11 表内两格。
这一节是同一条形状，换到了**读数与它所证明的东西之间**。

### 形态表（一次列全）

| # | 形态 | 长什么样 | 轮次 |
| --- | --- | --- | --- |
| ① | 覆盖声明 | "降级已实现"（其实是零） | 23 |
| ② | 指针 | `file.mjs:731` 指的是空行 | 24 |
| ③ | 计数 | "套件 X（N 例）"过期 | 25 |
| ④ | 报告标题 | "都是机器读数，可复跑" | 26 |
| ⑤ | 表内两格 | 🟡（没做完）配 `—`（不差什么） | 27 |
| ⑥ | **读数的适用范围** | 绿的是"**这棵树**"，被读成了"**那个提交**" | **28** |

### 读数：我这一天跑的**每一次**全量 CI 都跑在一棵脏树上

本会话第 24～27 轮共 5 次全量 CI，逐条写成：

> 全量 CI（**交付 HEAD**）| **9/9 PASS，exit 0**（HEAD `dd6eb8f`，`.ci/r27b`）

而 `summary.json` 里唯一能回答"跑的哪棵树"的字段是 `git head=<sha>` ——
**那是提交的名字，不是树的状态**。实测（`git status --porcelain`）：
那一整天的工作树里都躺着**另一个会话的 13 个已改文件 + 441 个未跟踪文件**。

> `git head` 回答"哪个提交"，读者读成"哪棵树"。
> 在一份 9/9 PASS 的报告里，这两个问题**长得一模一样**。

★ 这一次读数**大部分是真的**——另一个会话的在制品与 `scripts/prt/` 无关。
但"是不是真的"当时**没有任何东西**回答得了，这正是它也算一个成员的理由。

★ 顺带订正一处我自己的**推断**：我曾担心"脏树"会污染我对条目 A 的读数
（4 把键不在 `runtime.envNames` 里）。**实测不必担心**：把 `HEAD` 版与工作树版的
`process-manifest.mjs` 的 5 个 `envNames` 数组逐字比过，**完全一致**
（`scratch/_extract-envnames.mjs`）⇒ 条目 A 的读数在两棵树上都成立。

### 修法：两处

1. **产物侧**：`run-ci.mjs` 新增 `readTreeState()`，把 `head` / `dirty` /
   `modifiedCount` / `untrackedCount` / `fingerprint`（`git status` 路径清单的
   sha256 前 16 位）写进 `summary.json`，并在**脏树时红字警告**，
   明说"这次证明的是**这棵树**，不是那个提交"。
   ★ 读不出来时报 `known:false` 并说"读不出来"——**"没法判断"不等于"干净"**。
2. **判据侧**：新增套件 `ci-reading-integrity`（**12 例**），两层刻意分开：

   | 层 | 查什么 | 能不能进 CI |
   | --- | --- | --- |
   | 文档层 | 「交付 HEAD」那一行必须用**封闭词表**写树：`干净树` 或 `脏树 N 改 + M 未跟踪` | **能**（纯文本） |
   | 产物层 | 真读 `.ci/*/summary.json` 交叉核对（缺产物 / 没记树 / 说干净而产物是脏） | **不能** |

   ⚠️ 产物层**不能**当 CI 门禁：`.ci/` 在 `.gitignore:43`、tracked 文件数 **0**
   ⇒ 全新检出里那份产物根本不存在，它在 CI 里会永远"没有可核对的产物"，
   而**那种绿是假的**。这一条边界写在模块头注释里。

   ★ 词表**刻意封闭**：自由文本（"已确认工作树"）与真的提了树，
   在正则下的区别是**猜**出来的。

### 它当场红在**我自己的报告**上

第一次运行：

    ✖ 第 39 行是「交付 HEAD」的 CI 读数，但**没说跑在哪棵树上**。

### 变异：6/6 咬住，还原逐字相同

| 方向 | 变异 |
| --- | --- |
| 文档 | M1 删掉「脏树 14 改 + 441 未跟踪」 |
| 文档 | M2 换成自由文本「已确认工作树」 |
| 文档 | M3 把「交付 HEAD」这个标志词改掉（判据扫到 0 行必须红） |
| 代码 | M4 封闭词表放宽成"任何非空都行" |
| 代码 | M5 去掉"扫到 0 行也是失败" |
| 代码 | M6 `readSummaryTree` 把"缺字段"当成干净 |

### 诚实边界

- 它查"**有没有说清楚跑在哪棵树上**"，**不查**"那次 CI 到底绿不绿"
  （那要读 `summary.json` 的 `stages`）。
- 它**不**判断"脏树上的绿算不算数"——那是判断，不是机械事实。
  这次脏树上的读数**可以**接受（在制品与判据目录无关），但"它可以接受"
  是**我读出来的**，不是门禁判出来的。
- 文档层只约束「交付 HEAD」那一行。历史轮次的行不受约束，因为那些是
  **当年的快照**，要求它们补写树的状态等于**篡改历史**。

## 5.13 ★★★ 第 29 轮：那一族的**第七种形态** —— 跨文档的状态各说各话

§5.8 标签/指针 → §5.9 数字 → §5.10 报告标题 → §5.11 表内两格 → §5.12 读数适用范围。
这一节换了位置：不再是"某个数没人核"，而是**两份文档对同一件事各说各话，
且没有一处交叉引用**。

### 形态表（七种，一次列全）

| # | 形态 | 长什么样 | 轮次 |
| --- | --- | --- | --- |
| ① | 覆盖声明 | "降级已实现"（其实是零） | 23 |
| ② | 指针 | `file.mjs:731` 指的是空行 | 24 |
| ③ | 计数 | "套件 X（N 例）"过期 | 25 |
| ④ | 报告标题 | "都是机器读数，可复跑" | 26 |
| ⑤ | 表内两个格子 | 🟡（没做完）配 `—`（不差什么） | 27 |
| ⑥ | 读数的适用范围 | 绿的是"这棵树"，被读成"那个提交" | 28 |
| ⑦ | **跨文档的状态** | 规格说"F-12 待完成"，进度表说"F-12 ✅" | **29** |

### 读数：目标点名的**输入文档**自己在说工作没做完

目标原话是「**以这份文档**要增加的功能为基础」——指
`docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`。它的 §4 每个功能标题后面括着
**写作当时**的状态注记：

    #### F-01 Runtime Contract（基础已落地，收口中）
    #### F-03 Runtime Manager（规格已定义，产品级闭环待补）
    #### F-10 Permission Engine（控制面基础已落地，DSH 工具全量接线待收口）
    #### F-12 Product Launcher（产品级 Launcher 待完成）

实测：**8 条带注记的标题里，7 条说"还没做完"，而状态表里那 7 条已经全是 ✅**
（只有 **F-04** 的注记仍然成立——它今天还是 🟡）。

> 一份说"F-12 待完成"的设计文档，与一份说"F-12 ✅"的进度表，放在一起，
> **读者信哪一份取决于他先打开哪一份**。

★ 而且 §1.1 自己写着「以下状态以**当前** `main` 可见代码和 CI 套件为准」——
这句话让它读起来像当前状态，而它其实是 2026-09-16 的快照。

### 修法：注记**一个字都不删**，写一张取代关系表

删注记等于篡改历史（与本会话一贯做法一致：**历史冻结、当前跟着代码走**）。
⇒ 在规格 §1.1 之后加一节 **§1.2 状态注记校准**，逐条写
「当时的注记 → 现在是什么 → 依据」，并明确 §1.1 那张阶段表是 09-16 快照。

### 判据：`spec-status-calibration`（新套件，13 例）

规则窄、不需要猜：

| 规则 | 内容 |
| --- | --- |
| R1 | 注记**说没做完** + 状态表里该 F-NN **已全 ✅** ⇒ **必须**在校准表里 |
| R2 | 校准表写的状态必须**等于**状态表当前状态（⇒ 校准表自己会过期） |
| R3 | 校准表不许有"注记还没被取代"的条目 |

★ 只有 R1 的"说没做完"需要识别语义，所以那部分用**封闭词表**
（待补/收口/待完成/尚未/未完成/部分）——**自由文本下的识别是猜**。
刻意**不**去判断"收口中算不算没做完"这种模糊问题：词表命中即算，宁可多要求几条。

★ **F-04 刻意不进校准表**，而这是一条被测试钉住的**反向控制**：
一条"凡标题说没做完就登记"的表，就不再回答"哪些**已经**被取代"。

### 变异：8/8 咬住，还原逐字相同（**两份文档都要打**）

| 方向 | 变异 | 谁捉住 |
| --- | --- | --- |
| 规格 | M1 拿掉 §1.2 整节 | 门禁（点名 F-01） |
| 规格 | M2 校准表把 F-12 的 ✅ 改成 🟡 | 门禁（点名 F-12） |
| 规格 | M3 给仍然 🟡 的 F-04 写一条校准 | 门禁（点名 F-04） |
| **状态表** | **M4 把 F-01 退回 🟡** | 门禁（点名 F-01）——**校准表立刻过期** |
| 代码 | M5 封闭词表清空 | 套件 |
| 代码 | M6 R1 不比对状态 | 套件 |
| 代码 | M7 R2 放宽成"有条目就行" | 套件 |
| 代码 | M8 不再报"什么都没查" | 套件 |

★★ **M4 是最强的一条**：它打的是**另一份文档**。
只打规格会漏掉"状态表漂移而校准表继续宣称 ✅"这一整类——
那正是这条判据要防的事（校准表变成一句新的、没人核的话）。

### 诚实边界

- 只覆盖 §4 的**标题注记**（可机械解析的形状）。
  **§1.1 那张阶段表不在覆盖内**——里面的"阶段 2.5 尚未形成闭环"、
  "阶段 4～10 按未完成处理"同样已被取代，但它们与 F-NN 不是一一对应，
  机械判不了，只能在文档里由人说明。
- 它查"两份文档**对不对得上**"，**不查**"那份注记当年的判断**对不对**"。
- 它也**不**替你决定 F-22/F-24 这类"设计范围已完成、其余按客户需求"的行
  该记 🟡 还是 ⏸——那是产品裁决（见 §5 第 10 条）。

## 5.14 ★★★ 第 31 轮：**我报了一次假发现，而且是两次叠加的**

这一节与前面几节形状不同：它记的不是"发现了一处坏引用"，而是
**"我差点报出 23 处，而真缺陷只有 1 处"**。

### 起因

第 25 轮就发现 F-21 那格引的是 `plugins/connector-feedback.mjs`，而文件实际在
`runtime/dsh-composition/plugins/connector-feedback.mjs`——当时判断
「代码落点正确性归第 27 轮那种判据管」，**没有**顺手改。第 31 轮把它量完。

### 第一版读数：**49 个引用里 23 个"解不开"** —— 假的，两层原因

**① 遍历没排 worktree 副本。** 我扫全仓同名文件时只跳了 `node_modules` 等，
于是 `.legion-worktrees/*/team-hub/server.mjs` 这些**同名副本**把
`server.mjs` 的计数撑成 **38**。看起来像"这个名字有歧义"，实际是我的遍历没排干净。
（排除后：**唯一**。）

**② 我把每个名字独立拼路径，而这一列有惯例。** 正确惯例是：

    一格里的**第一个带目录的路径**确立目录，其后的**裸文件名**继承那个目录。
    例：`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`
        ⇒ 后两个是 runtime/contracts/run.mjs 与 runtime/contracts/errors.mjs

按惯例重扫：**原样解得开 36 + 沿本格继承解得开 12 = 48**，剩下 1 个也在
**全仓唯一的同名文件**里找得到。⇒ **0 个真缺陷。**

> 一个"23 处坏引用"的读数，与一个"**我的解析器不懂这列的惯例**"的读数，
> 在只看那一行输出的屏幕上，是同一个东西。

★ 这与 §5.12（读数的适用范围）是同一族，但方向相反：那一次是**读数被过度解读**，
这一次是**我的探针本身错了**——而它报出来的数字比我预期的更"像发现"。

### 真缺陷：**恰好 1 处**，就是第 25 轮看见的那一处

把规则收紧成"**带 `/` 就必须原样存在**"（而不是"沿别的目录也许能找到"）之后：

    ✖ 第 187 行（F-21）的「代码落点」引了带目录的路径 `plugins/connector-feedback.mjs`，
      而它**不在被跟踪的文件里**。

★ 为什么这条规则是对的：`plugins/connector-feedback.mjs` 以 `plugins/` 开头，
**读起来就是顶层 `plugins/`**——而顶层 `plugins/` 里没有它。
"沿本格继承"能救它，但读者不会那么读。⇒ 已改成全路径。

### 判据：`feature-landing-paths`（新套件，13 例）

| 规则 | 内容 |
| --- | --- |
| R1 | 带目录的路径（含 `/`）⇒ **必须存在** |
| R2 | 裸文件名 ⇒ 必须在全仓**恰好一个**同名文件 |
| R3 | 裸名先试沿本格已确立的目录继承，再试全仓唯一 |

★★ **R2 才是这条判据存在的理由**：`run.mjs` 能当简写用，是因为全仓只有一个
`run.mjs`。哪天多出第二个，那个简写就变成**读者无法解析**的引用——
而它**今天仍然"看起来是对的"**（名字没错、文件也都在）。
这与 §5.11（🟡 配 `—`）是同一个形状：**一个字面为真、而读者会读错的写法**。

★ 扫描面用 `git ls-files`（只看被跟踪的文件），理由与套件计数那条一致。

### 变异：7/7 咬住，还原逐字相同

| 方向 | 变异 | 谁捉住 |
| --- | --- | --- |
| 文档 | M1 把 F-21 改回短路径（就是当天那处） | 门禁（点名） |
| 文档 | M2 把带目录的落点改成不存在的路径 | 门禁（点名） |
| 文档 | **M3 删掉一格里的第一个带目录路径**（后续裸名失去继承目录） | 门禁（点名） |
| 代码 | M4 去掉 R2（只留"存在就行"） | 套件 |
| 代码 | M5 去掉 R3（继承） | 套件 |
| 代码 | M6 去掉"扫到 0 个路径也失败" | 套件 |
| 代码 | M7 把通配符重新排除出"像路径"（`globbed` 会永远 0） | 套件 |

★ **M3 是最值得记的一条**：它打的是**惯例本身**。删掉一格里第一个带目录的路径，
后面那些裸名就失去继承目录——这正是第一版探针没理解的机制。

### 一处被用例抓到的真缺陷（我自己的）

第一版的 `PATH_RE` 字符集里**没有通配符**，于是 `approval-*.mjs` 在进入
"跳过通配"那条分支**之前**就被过滤掉了 ⇒ `globbed` **永远是 0**。
即"**跳过了 0 个通配**"与"**这一列根本没有通配**"是同一个读数——
正是本报告反复在说的那种形状，只不过这次出现在我的判据自己身上。
用例 ⑧ 抓住了它（`实际 0，期望 1`）。订正后真读数：**跳过通配 2**。

### 诚实边界

- 它查"读者**找不找得到**这个引用"，**不查**"被引的那个文件**是不是**这句话的落点"。
  后者是语义判断（`boundary-facts` 那条的边界也一样）。
- 它**只覆盖「代码落点」那一列**（第 4 格）。同一张表的「判据 / 证据」列里
  还有大量路径引用，不在覆盖内。
- 它**不**要求每一格都写全路径——**简写是允许的**，前提是全仓唯一。
  这个设计是刻意的：要求全路径会把表变得很长，而唯一简写同样让读者找得到。

## 5.15 ★★★ 第 32 轮：我自己第 30 轮加的那一条，**在表格外面**

这一节记的是一件比它看起来更一般的事：**一行"内容全对、位置错了"的内容**。

### 事情本身

第 30 轮往 §5 的裁决表加第 29 条时，我把那一行插在了一个**空行之后**。
在 Markdown 里，**空行结束表格**——于是第 29 条（编号对、内容对、位置在 §5 里）
**不是那张表的一行**，而是一张只有一行的独立表。

**行在、编号对、内容对、Ctrl-F 找得到。** 而它不在表里。

### 为什么已有的闸门没有拦住它

§5 早有一条判据（`intervention-coverage.mjs`，第 20/21 轮立的）在核对
"台账里非 ✅ 的行有没有被 §5 点名"，它查的是 `section.includes('PRT-…')`——
**子串在不在**。子串与"它是不是表的一行"无关，所以它绿灯放行。

> 一行"插在表格外面"的裁决项，与一行"插在表格里面"的裁决项，
> 在读者用 Ctrl-F 找它的编号时，是同一个东西。

### 抓到它的判据（第 32 轮新加，函数在 `intervention-coverage.mjs`）

`docs/DECISION-BRIEF.md` 是一页纸决策摘要，开头写着「§5 里那 **29 条**裁决项」。
新判据做两件事：

| 规则 | 内容 |
| --- | --- |
| 条数一致 | 简报声明的条数 **必须等于** §5 裁决表的实际条数 |
| 编号连续 | §5 裁决表的编号必须 `1..N` 无缺号 |

★ **按表头定位**（`| # | 事项 | 需要谁 |`），不按行号、也不按"§5 里第几张表"——
行号会漂（本仓记录里同一处先后写作 485-509 → 508-536 → 540/545），
而 §5 里还有别的编号表（开头 1～5 的优先级表、后面 13/14/15/18 的缺口表），
按"编号行"取会把它们一起吃进来。

★★ 而它**当天就红了**：解析器数到 **28**、简报写着 **29**。
两个数字一对照，那条被空行隔开的第 29 条就现形了。⇒ 已删掉那个空行，
第 29 条现在真的是表里的一行。

### 变异：7/7 咬住，三个文件逐字还原

| 方向 | 变异 | 结果 |
| --- | --- | --- |
| 文档 | M1 简报把 29 写成 31 | 咬住 |
| 文档 | **M2 在 `\| 28 \|` 前插空行**（把表切断） | 咬住 |
| 文档 | **M2b 直接在 `\| 29 \|` 前插空行**（复现第 30 轮的**原错**） | 咬住 |
| 代码 | M3 去掉"条数一致"核对 | 咬住 |
| 代码 | M4 去掉"编号连续"核对 | 咬住 |
| 代码 | M5 去掉"简报一处都没声明也失败"守卫 | 咬住 |
| 代码 | M6 去掉"表头找不到也失败"守卫 | 咬住 |

★ M2b 就是**我两天前犯的那个错的原样复现**——判据能咬住它，说明这一类错误
以后不会再靠人偶然读到。

### 为什么这一节值得单独记

它不是一个孤立的小错。这一族到目前为止的形态里，**这一种的特点是没有一处是"写错"的**：
编号对、内容对、状态对、引用对。错的只有**位置**——
而"位置"正是所有基于**内容**的判据都看不见的那一维。

## 5.16 ★★★ 第 33 轮：把目标文档 §9 那条链**逐节投影**——它断在第 5 节

### 为什么要做这件事

目标文档把"做完了"写成一条九节的链（§9，逐字）：

```text
安装/配置 → Launcher 启动 Runtime → 创建空间与 TeamPlan
→ 认领 Task / 生成 Snapshot → DshRuntimeAdapter 执行 Run
→ 工具审批与 hard floor → 产物验收/交接/审计/用量
→ Runtime 崩溃可恢复 → 升级失败可回滚且业务数据不丢失
```

而"还剩什么没做"在本仓散落在**四个**地方：

| 在哪 | 回答的问题 | 规模 |
| --- | --- | --- |
| `PRT-PROGRESS.md` | 每个**任务**完没完成 | 145 行 |
| 本文档 §5 | 哪些要**人回答** | 29 条 |
| `prt-reachability-baseline.json` | 哪块**代码没人挂** | 46 项 |
| §5.1～§5.15 | 各处**散文** | —— |

**没有一处回答"这条链断在哪一节"**——而那是"下一步做什么"最直接的问法。
于是同一个问题每次都要重读四个地方，而读者会停在最先读懂的那一个上。

> 一份"还剩 5 项"的台账，与一份"这条链断在第 5 节"的投影，
> 对"下一步该做什么"给出的答案不是同一个东西。

### 读数（`scripts/prt/alpha-chain-trace.mjs`）

| 节 | 内容 | 判定 |
| --- | --- | --- |
| L1 | 安装/配置 | ✔ 有活实现 |
| L2 | Launcher 启动 Runtime | ✔ 有活实现 |
| L3 | 创建空间与 TeamPlan | ✔ 有活实现 |
| L4 | 认领 Task / 生成 Snapshot | ✔ 有活实现 |
| **L5** | **DshRuntimeAdapter 执行 Run** | **✖ 硬断** |
| L6 | 工具审批与 hard floor | ✔ 有活实现 |
| L7 | 产物验收/交接/审计/用量 | △ 软缺口 |
| L8 | Runtime 崩溃可恢复 | ✔ 有活实现 |
| L9 | 升级失败可回滚 | △ 软缺口 |

### ★★ 两处最容易写错的地方（各被变异钉住）

**① 第一版的判据太弱：九节全绿。**

第一版把"这一节有活实现"定义成"**至少一个**模块可达"⇒ 九节全过，
而它对"断在哪一节"**一个字都没说**——因为每一节都有一半早就接好了。

> 一个"九节全绿"的读数，与一个"每一节都有一半接好了"的读数，
> 在只看那九行 ✔ 的时候是同一个东西。

⇒ 每一节现在必须**显式**写下它的**核心模块**与**为什么**：
核心缺席 = **硬断**；只有支撑缺席 = **软缺口**。两者**不许同形**。

**② 「不可达」与「不可达且没人打算接」不许同形。**

`product/upgrade/switchover.mjs` 不可达（属 `deliberate`——CLI 按路径调它，**正常**），
而 `runtime/toolcall/spool.mjs` 不可达（属 `gap`——确实缺一个挂点）。
只看"可达/不可达"这个二值时，两者**一模一样**。

⇒ 判据读的是基线里**有人判过的** `class`，不是现算的二值。

### L5 为什么断，以及它**正好就是 §5 第 20 条**

worker（orchestrator 进程）与 DSH Runtime 是**两个进程**，所以同进程的
`bindDshRuntime()` **填多好都不会改变 worker 的读数**——
这句话是 `runtime-contract-server-row.mjs:9-10` **自己写的**。
那一行是这条缝上**唯一的监听器**，而它**不在 `PATCH_LAYER_ROWS` 里**
（补丁层五行：hard-floor / root / pre-execute / approval-answerer / permission-presets）、
不在 `legion-host.patch.yml` 里、**没有任何生产 importer**（全仓只有测试文件 import 它）。

⇒ 那份发布**永远不会被写出来** ⇒ Launcher 的消费侧读不到 ⇒ 不注入
`LEGION_RUNTIME_URL`/`LEGION_RUNTIME_TOKEN` ⇒ worker 报具名码
`EXECUTOR_HOST_PORT_REQUIRED`、**不认领任何任务**。

★ `product/launcher/launcher.mjs:473-476` 逐字记着同一件事：
> worker…读两个键…**在本批之前没有任何生产方写它们**——
> 白名单只放行清单声明过的键，所以真实部署里它们会被丢掉，worker 永远报 `EXECUTOR_HOST_PORT_REQUIRED`。

★★ **而这是"可见的降级"，不是静默失效**——这一点很重要，也是代码自己强调的取舍
（`runtime-contract-server-row.mjs:16-36`）：出口挂不上时产品照常起、
worker 明说自己干不了活，而不是"看起了却执行了错的写操作"。
⇒ L5 的问题**不是**"它在偷偷做错事"，而是"**它今天做不了这件事**"。

### 变异：8/8 咬住

| 变异 | 结果 |
| --- | --- |
| M1 硬断判据忽略 `gap`（只查文件在不在） | 咬住 |
| M2 硬断判据退化成"至少一个模块可达" | 咬住 |
| M3 软缺口被并进硬断 | 咬住 |
| M4 `allGreen` 退化成"没有硬断" | 咬住 |
| **M5 L5 的核心标记改成一条不存在的路径（恒绿分支）** | 咬住 |
| M6 链定义里塞一条不存在的路径 | 咬住 |
| M7 基线里 L5 的核心模块那条记录被改名 | 咬住 |
| M8 L5 的 `coreWhy` 整段退化成一句短话 | 咬住 |

★ **M5 与 M8 是两个我自己犯过的形状**：
- M5 是"**永远匹配不上的分支**"——`core` 里写个不在 `modules` 里的路径，
  那一节就永远判不出硬断。⇒ ⑦ 号用例专门断言 `core ⊆ modules`。
- M8 第一版**是个假变异**：我只替换了多行拼接的**第一行**，
  后面几行仍然拼上来、字符串长度没变 ⇒ 判据当然不红。
  **这与本仓记过的"变异必须覆盖缺陷的每一行"是同一条。**

### 附带抓到的一处误报：**序数不是计数**

同在 §5 第 20 条那一格我写了一句指路的话——「它正好就是**第 20 条裁决项**」——
而 §5.15 那条新判据（简报声明的条数 = §5 裁决表的条数）立刻报红：
「简报写着 20 条、§5 有 29 条」。

它分不清"**第** 20 条"（指路）与"20 条"（计数）。

> 一个分不清"第 20 条"与"20 条"的计数器，
> 会在**引用**某一条的时候，报出一个**条数**上的错误。

⇒ 已改判据（前面带「第」的不算计数），并补 ⑨c 号用例把它钉住。
★ 这是**我自己的判据第二次误报**（第一次是 §5.13 的 23 处坏引用），
两次的形状都是"**把一句自然的中文读成了别的东西**"。

## 5.17 ★★★ 第 34 轮：链上每一个断点都必须有人认领

### 它补的是哪一格

§5 回答"哪些要人回答"，§5.16 的链投影回答"断在哪一节"。
而**两者之间没有任何东西交叉核对**——于是这条形状可以长期存在：
**链上一个断点，而 §5 里没有任何一条在管它**。

它与 §5 治过两次的那种（`intervention-coverage` 的第 20/21 条）**完全同形，只是高了一层**：

> 一个"谁也没在看"的断链，与一个"已经排上日程"的断链，
> 在只看那条链的投影时是同一个东西。

### ★★ 而我这轮的第一次尝试**报错了**——这一节最值得记的就是它为什么错

第一版探针（`scratch/_probe-break-owners.mjs`）去 §5 的**每一格里搜文件名**，于是它报出：

```text
L9 [支撑] product/lifecycle/retention.mjs
    §5 里点到它的条目：**没有**
```

**这是错的。** 第 16 条管着它，只是 §5 用的是**中文名**「保留策略」：

| | 写法 |
| --- | --- |
| 代码 | `product/lifecycle/retention.mjs` |
| §5 第 16 条 | 「发布检查清单、隐私说明、**保留策略**、数据分类、数据导出、卸载、支持手册…」 |

> 一个靠"文件名在不在散文里"判定的归属，
> 与一个靠"§5 里那个词恰好是中文还是英文"判定的归属，是同一个东西——
> 只不过前者会输出一个数字。

★ 这是**本族的第 5 次误报**（前四次：worktree 副本撑出 38 个同名、
两次拼写变体"零命中"、23 处坏引用），而它的形状与前几次略有不同：
前四次是"**我不知道它在这儿叫什么**"，这一次是"**我知道它叫什么，而两份文档用两种语言叫它**"。

### 判据：归属必须是**声明的 §5 条目编号**

⇒ 归属**不能靠正则从散文里找**。它写成 §5 的**条目编号**——唯一的、机器可核的最小单位。

这与 `NOT_FORWARDED_YET` ↔ `ASSEMBLY_ANCHORS`（`scripts/config/config.test.mjs`）
是**同一种记账法**：一个**声明出来的指针**，由判据去核它**解得开**。

| 规则 | 内容 |
| --- | --- |
| ① 断点无归属 | 有断点却没有 `owner` 的那一节 ⇒ 红（"没有任何人在等它"） |
| ② 归属指到空处 | `owner` 不是一个**存在**的 §5 条目号 ⇒ 红 |
| ③ 归属已过期 | 没有断点却还写着 `owner` ⇒ 红（与 `NOT_FORWARDED_YET` 的 stale 同形） |
| ④ 归属没写理由 | 有 `owner` 而 `ownerWhy` 太短 ⇒ 红（"我随手指了一条"与"它真的归那一条"同形） |
| ⑤ 什么都没查 | §5 表解析不出来 ⇒ 红（不许靠"没数据"通过） |

### 今天的读数

```text
断点归属（每个断点都必须有人认领）：**全部有归属**

  L5 硬断        ⇒ 归属 §5 第 20 条
  L7 软缺口      ⇒ 归属 §5 第 28 条
  L9 软缺口      ⇒ 归属 §5 第 16 条
```

★ **所以这一轮的结论是一个否定结果**：链上的断点**今天没有孤儿**——
三个断点各自都有 §5 条目在管。值钱的地方不在这个结论，而在：
**它现在是算出来的，而不是"我读了一遍觉得有"**。下一个孤儿会红。

### 变异：15/15 咬住

在 §5.16 那 8 条之外，新增 7 条专测归属：

| 变异 | 结果 |
| --- | --- |
| M9 去掉"有断点却没归属"那条规则 | 咬住 |
| M10 去掉"归属指到空处"那条规则 | 咬住 |
| M11 去掉"归属已过期"那条规则 | 咬住 |
| M12 去掉"§5 表解析不出来就失败"的守卫 | 咬住 |
| M13 L7 的归属改指一条不存在的 §5 条目 | 咬住 |
| **M14 L9 的归属整条删掉**（那一节就没人认领了） | 咬住 |
| M15 归属改成文件路径（不是条目编号） | 咬住 |

## 5.18 ★★★ 第 35 轮：把判据指向"目标完成了没有"——以及我因此踩到的两个坑

### 一、补的是哪一格：**那 140 个 ✅ 的证据栏，从来没有被核对过**

到第 34 轮为止，本仓为**非 ✅** 的那 5 行立过判据（`intervention-coverage`：非 ✅ 的行必须被 §5 点名），
也为 §5 的裁决表立过判据（`alpha-chain-trace`：断点必须有归属）。
而**那 140 个 ✅ 的证据栏，从来没有被任何东西核对过**——而"任务全部完成"恰恰就靠这一列。

台账自己的口径写着（`PRT-PROGRESS.md` 文件头）：

```text
✅ 已完成：有代码/文档交付物 + **可复跑的用例或实测证据**
```

⇒ **"可复跑"是 ✅ 的定义的一部分。** 而一篇点名了一个**不存在**的套件的证据，
与一篇点名了一个真套件的证据，在这张表里长得**一模一样**：

> 一份"写着有证据"的台账，与一份"证据真的找得到"的台账，
> 在只看状态那一列的时候是同一个东西。

### 二、判据只收**形状无歧义**的点名（`scripts/prt/ledger-evidence.mjs`）

| 规则 | 内容 |
| --- | --- |
| R1 | 套件 `` `X` `` 必须是一行 **CI 套件行**的名字（`prt-topology` 在磁盘上没有同名文件，这是它唯一能落地的解释） |
| R2 | 含 `/` 的路径必须**原样**是被跟踪的文件 |
| R3 | 裸 `x.test.mjs` 必须在全仓**恰好一个**同名文件——这正是"简写合法"的条件 |

★ **刻意不做**的三件事（写下来是为了让下一个人不必重新论证）：

- **不**解析"裸名沿本格目录继承"——台账证据栏是**一段散文**，没有"本格目录"这个位置概念；
- **不**把"没有点名任何套件"判红——口径允许"实测证据"（文档 / 基线 JSON），那一批只作读数；
- **不**去散文里找文件名——点名必须是**反引号里**的那一个 token。

★ 而且解析器**转手** `suite-counts.mjs` 的 `suiteFilesFromCi()`——那个函数的注释里
写着同一件事：「那两个名字在仓库里**没有同名文件**……不解析这一层，那两条声明就会
落进 `unresolved` 被**静默跳过**——而"跳过 2 条"与"2 条都对"，在只报 `ok` 的输出里长得一样」。

### 三、读数：3 处歧义裸名（已修文档）

```text
台账 ✅ 行 140 条
点名的可复跑证据：套件 96 处、带目录的用例 33 处、裸名 39 处
没有点名任何套件/用例的 ✅ 行：6 条（口径允许"实测证据"，只作读数）
```

抓到 **3 处**——与第 31 轮修 F-21 的短路径是**同一个形状**（点名解不开）：

| 条目 | 原来 | 实测有几个同名 | 改成 |
| --- | --- | --- | --- |
| PRT-254（×2） | `config.test.mjs` | **3** 个 | `scripts/config/config.test.mjs` |
| PRT-254 | `secrets.test.mjs` | **2** 个 | `security/secrets/secrets.test.mjs` |
| PRT-413 | `config.test.mjs` | **3** 个 | `scripts/config/config.test.mjs` |

**目标文件是判出来的，不是猜的**：

- 「凡 env 名含 TOKEN/SECRET/KEY 必须 sensitive」那条判据在 `scripts/config/config.test.mjs:454`，
  而 `FOREIGN_DYNAMIC_SUBSCRIPTS` 也在它里面；
- 台账写「`secrets.test.mjs` **9 → 19 例**」，而 `security/secrets/secrets.test.mjs`
  实测**正好 19 例**（`product/secrets.test.mjs` 是 37 例，锁/ttl 主题 1 处 vs 53 处）。

★ **改的是文档，不是判据**——与第 31 轮同一条原则。读者解不开的点名是文档的缺陷；
把判据放松，只会让下一个解不开的点名也通过。

### 四、★★ 我自己的第 6 次误报：那一批"解不开的套件"里有 40 个是假的

第一版探针把**套件别名**当**文件名**去解析，于是报出 40 个"解不开"（`prt-topology`、
`product-upgrade`、`secret-store`…）。**全部是假的**——它们是 **CI 套件行**的名字，
在 `scripts/ci/run-ci.mjs` 里各有其行，并映射到真实的测试文件：

```text
label: 'prt-topology（PRT-001 拓扑 / PRT-003 配置与密钥来源清单）'  → scripts/prt/topology-inventory.test.mjs
```

> 一个把"套件别名"当"文件名"去解析的探针，
> 会在**每一个**别名上报一次"文件不存在"——而报出来的那个数字看着很像发现。

★ 本族第 6 次误报。前五次的形状是"**我不知道它在这儿叫什么**"，
这一次是"**我把两种东西当成了同一种**"。
**而更早的 `suite-counts.mjs:184-191` 早就把这条写下来了**——
同一族错误本仓已经犯过一次，这是第二次。

### 五、★★★ 而这一轮真正的收获是第二个坑：`--only boundary` **不跑** `boundary-facts`

本轮的收尾复核里，我拿

```text
node scripts/ci/run-ci.mjs --only boundary
```

当成了"边界类判据都验过了"，并在报告里写了"判据全绿"。而 **`boundary-facts` 不在 `boundary` 阶段**：

| | 是什么 | 在哪 |
| --- | --- | --- |
| `boundary` **阶段** | DSH 执行面边界棘轮（PRT-108）+ DSH 出处锚点漂移（PRT-211） | `stageBoundary()` |
| `boundary-facts` **判据** | 文档**数字**与**坐标** ↔ 产物真实的值 | **`test`** 阶段 |

于是那次"验证"**一个字节都没跑到**要验的判据，而它的输出写着 `boundary PASS`。
结果：那一轮的收尾提交把一个**红的**判据发了出去
（`handover-ci-prose-matches-table`：散文写 873 秒、表里 `873594ms` 四舍五入是 **874**
——**我把四舍五入写成了截断**）。

> 一个叫 `boundary` 的阶段，与一个叫 `boundary-facts` 的判据，
> 在 `--only boundary` 的输出里是同一个东西——
> 只不过前者真的跑过，而后者一次都没跑。

⇒ 新增 `scripts/prt/stage-scope.mjs`：判的不是"相似该不该存在"（两边名字都合理），
而是**它有没有被写下来**——每个"名字像"都必须在 `DISAMBIGUATION` 表里有条目与理由，
且**过期的声明也会红**（与 `NOT_FORWARDED_YET` 的 stale 同形）。

今天的四处：

```text
`--only boundary` **不跑** 套件 `boundary-facts`
`--only stage`    **不跑** 套件 `stage-scope`
`--only doc`      **不跑** 套件 `doc-table`
`--only doc`      **不跑** 套件 `doc-render`
```

★★ **第二处是判据自己抓出来的**：加这条判据的那一次改动，`stage-scope` 这个**套件名**
与 CI 里那个叫 `stage` 的**阶段名**立刻构成第四处碰撞，而它**当场变红**。
这条判据上线第一次运行就抓住了自己。

### 六、变异：16/16，其中**三个第一次是漏网的**

| 漏网 | 诊断 | 处置 |
| --- | --- | --- |
| L8 台账行解析放宽 | **假变异**：`cells.length < 3` → `< 2`。实测 `PRT-` 开头的 145 行里 **2 格的 0 条** ⇒ 两个条件行为完全相同 | 换成**收窄状态词表**（丢掉 ⏸/⬜ 两行），那才改读数 |
| S5 表清空 | **假变异**：我的替换串只是往 `Object.freeze({` 后面**加了一个键**，原来的条目一个没动 | 换成把默认参数换成空表 |
| S7 说明长度下限去掉 | **真缺口**：套件里**根本没有喂过"短理由"这个输入** | **补一条用例**（⑩）钉住它 |

★★ 第三条是这一轮最有价值的一条：
**一条没人喂过输入的规则，与一条不存在的规则，在套件里长得一模一样。**
它只有靠变异才会露出来——不是靠读代码。

### 七、★★★ 而这一轮还咬出了**我自己制造的一个假读数**：一个用例的**名字**改写了一次 CI 的读数

第一版 `ledger-evidence` 的用例 ⑧ 是这么写的：

```js
test('⑧ ★ "套件 `tests 21 / pass 20 / skipped 1`" 不是套件名（自然中文里的一句话）', …)
```

它的**夹具**就是那句运行器摘要（用来验证"摘要不是套件名"）。而 node 会把**用例名**
打进 stdout，于是 CI 那一行的读数是：

```text
PASS ledger-evidence（…）: exit=0 tests=21 pass=20 fail=0 skipped=1     ← 假的
                                   ↑ 真实是 10/10/0/0
```

因为 `run-ci.mjs` 的计数解析用的是 `re.exec(all)`——**第一个**匹配：

```js
const num = (re) => { const m = re.exec(all); return m ? Number(m[1]) : NaN }
```

`test` 阶段的总 `skipped` 也跟着从 1 变成 2，而多出来的那一条**根本不存在**。

> 一个用例的**名字**，改写了一次 CI 的读数——
> 而"跳过了 1 条"与"跳过了 0 条"，在那一行里长得一模一样。

★ 这与本仓 2026-09-17 那一课（`skipped` 曾经**没被解析**：「38 条里跳过 20 条」而摘要
一个字没说）是**同一格的两个方向**：那次是**看不见一个数**，这次是**看见了一个假的数**。
两个方向都让一个数说谎。

⇒ 三处修正：

| # | 修什么 | 怎么修 |
| --- | --- | --- |
| 1 | 那个用例名 | 名字改成一句话，**夹具放函数体里**（成功时不会被打进输出） |
| 2 | 解析器取**第一个**匹配 | 抽成 `scripts/ci/parse-suite-output.mjs`，取**最后**一个匹配（node 摘要在末尾） |
| 3 | 干扰**静默** | 首个 ≠ 最后 ⇒ 摘要行里写出 `⚠计数被输出干扰:tests(21→10),…`——**不静默** |

★ 抽出模块是为了**能测**：`parse-suite-output.test.mjs` 直接喂两段输出对比，
并加了一道**根因守卫**——`git ls-files '*.test.mjs'` 扫**全部 372 个套件**的用例名，
**任何**用例名都不许出现 `tests N` / `pass N` / `skipped N` 这种形状
（夹具要放函数体里）。实测：**0 处违规**，而扫描本身有 `files.length > 300` 的下限守卫
（一条"扫了 0 个文件也算过"的判据与没有判据是同一个东西）。

★ 变异 **6/6** 咬住，其中 P1 就是"回到取第一个匹配"——**这一轮那个 bug 本身**。

### 八、★★ 顺带：我的变异框架本身也错了一次

`_mutate-parse-output.mjs` 的 `mut` 第一版签名是**位置参数**：

```js
function mut(name, find, repl, file = MOD, original = orig)
```

而 P6 是按 `{ file: VICTIM, original: victimOrig }` 传的 ⇒ 那个对象整个落进了 `file`，
`original` 仍是 `MOD` 的内容 ⇒ `orig.includes(find)` 永远为假 ⇒
**P6 静默什么都没变异**，只报了一句"变异串没找到"。

★ 形状是：**一个什么都没做的变异，与一个变异了但没被咬住的变异，在输出里只差一个字**。
改成对象解构后 P6 立刻咬住。

### 九、★★ 而全量 CI 里，**既有的一道判据**把我这次重构拦下了

把解析搬进模块之后，全量 CI 的 `test` 阶段红了 **3 条**，全部来自 `skip-visibility`：

```text
FAIL skip-visibility（门禁摘要必须说出跳过了多少条断言）: exit=1 tests=6 pass=3 fail=3
  ✖ ① run-ci.mjs 真的解析了 skipped，而不是只解析 tests/pass/fail
  ✖ ② 摘要行里带 skipped=（跳过数不再是"要靠减法才知道"的那个数）
  ✖ ⑥ 反向：本组自己不能是"读注释就算过"的那种判据
```

★ 它是**源码级**判据（读 `run-ci.mjs` 的文本，不 import 它——因为 import 会跑整个 CLI），
所以代码一搬家，它就找不到锚点了。**这是它该有的行为**：
一道"锚在具体那几行上"的判据，本来就该在代码搬走时喊出来。

⇒ 修法是让锚点**跟着代码走**，而不是把判据放松：

| 判据 | 原来锚在 | 现在锚在 |
| --- | --- | --- |
| ① 解析了四个计数 | `run-ci.mjs` 的 `counts = {` | `parse-suite-output.mjs` 的 `pick()` 段 |
| ② 摘要里有 `skipped=` | `run-ci.mjs` 的 detail 行 | `parse-suite-output.mjs` 的 `countsFragment()` |
| ⑥ 锚点不在注释里 | 两条旧锚点 | 四条新锚点 |

★★ **而搬家的动作本身带来一个新风险——"代码搬走了、没人调它"**，
那正是本仓反复抓的那种形状。所以**新增一条判据 ①b**：

```text
①b ★★★ 接线：run-ci.mjs 必须**真的调用**那个模块（搬走了不等于接上了）
```

它断言 `run-ci.mjs` 里 `import … parseSuiteCounts …`、`const counts = parseSuiteCounts(all)`、
以及 detail 行用的是 `countsFragment(counts)`。
⇒ 搬完之后这一组**比原来更严**，而不是更松。变异 **P7 / P8** 各咬住一条：

    P7 摘要行改回手写那几个数（不再调 countsFragment）      ✓ 咬住
    P8 去掉 parseSuiteCounts 的 import（搬走了、没人调它）   ✓ 咬住

## 5.19 第 36 轮：**目标文档自己的实现投影表**此前没有任何判据

第 35 轮核的是**台账**（`PRT-PROGRESS.md`）里 140 条 ✅ 的可复跑证据。
而"目标实现了没有"还有**第二份**权威表——就是**本文档**的 F-01～F-25。
它此前**没有任何判据核对**，于是两类形状都能长期存在：

  ① **凭空点名**：引用台账里不存在的 PRT 编号、一个不是任何 CI 套件的"套件名"、
     或一个全仓同名的裸用例文件。读者按它去复核会**找不到**，
     而这与"证据真的在那里"在这张表里长得一模一样。

  ② ★★ **一个 🟡 行说「不差什么」**——本文档 §5.11 记的**真的发生过**：
     F-22 与 F-24 的「还差什么」格此前是 `—`，真正的缺口写在**「依据」格**里。

     > 一个 🟡 行说「不差什么」，与「已做完」，在表里长得一模一样。

     格子里有信息、而**放错了格子**，按「还差什么」那一列读表的机器与人就都读不到它。

⇒ 新增 `scripts/prt/feature-evidence.mjs`（判据 10 例，变异 **9/9**），五条规则：
R1 引用的 `PRT-nnn` 必须在台账里存在；R2 套件别名必须是一行 CI 套件；
R3 带 `/` 的路径必须原样存在、裸文件名必须全仓**恰好一个**；
R4 ★ **🟡/🟡→✅/✅→🟡 行**的「还差什么」不许是空或只有 `—`；
R5 同一**整格标签**的状态行不许出现两次。

**上线第一次的真读数**：F 表 29 条状态行（✅18 / 🟡6 / 🟡→✅2 / ⬜→🟡1 / ⏸2）、
证据指针 57 处，抓出**一处真的**——F-01 点的是**裸名**（只有文件名、没有目录），
而全仓有 2 个同名文件（`runtime/contracts/contract.test.mjs` 45 例 /
`whiteboard/packages/shared/test/contract.test.mjs` 26 例）。
目标文件由**内容**判定：前者的文件头逐字写着「Runtime Contract 契约测试（PRT-106）」。

★★ 而**我的修订稿第一次就踩了自己的判据**：我在那句订正里把那条坏引用**写成了反引号**
（"此前写的是 `` `contract.test.mjs` ``"），于是判据立刻又红了一次——
**判据认的是反引号里的那一个 token，而"描述那条坏引用"会把坏引用重新引进来。**
最后改成不带反引号的散文。

### ① ★★★ 而我的判据**在我自己手里**犯了一次它专门要抓的形状

`featureRows()` 第一版把状态列写成 `cells[1]`——那是**名称**（`[0]` 编号、`[1]` 名称、
`[2]` 状态）。于是它**读到 0 行**，而 CLI 兴高采烈地印出：

```text
F 表状态行 0 条：{}
点名的证据指针 0 处
✅ 每一条点名的证据都解得开，且每个 🟡 行都说清了还差什么
```

**一条什么都没查的判据，报的绿与一条全对的判据一模一样。**
这正是本仓反复抓的形状（`stage-scope` 的 `no-stages`、`suite-counts` 的
`files.length > 300`），所以修的时候补了一条**下限**：读到 0 行 ⇒ 红。
变异 M1 就是"状态列读 `cells[1]`"、M2 就是"去掉那条下限"。

### ② ★★ 4 处**全是我的假阳性**：把限定词削掉再去重

R5 第一版把标签**削成编号**（`F-05 前半` → `F-05`）再比，于是：

    F-05 前半 / F-05 后半      （同一件事的两半，各一行）
    F-18 缺口① / ② / ③         （每个缺口各一行）

全部被报成"重复"，**4 处没有一处是真的**。

> 一个把限定词削掉再去重的编号，
> 会把「同一件事的两半」与「同一件事写了两遍」看成同一个东西。

限定词（`前半` / `缺口①`）**正是**区分它们的东西。改成按**整格标签**去重后，
真仓库只剩那 1 处真的歧义引用。变异 M7 就是"回到削限定词"。

### ③ ★★★ 第二个判据在同一处**看不见目录**：`suite-counts.mjs` 的 `split('/').pop()`

修完文档之后，`node scripts/prt/suite-counts.mjs` **仍然**报：

```text
suite-counts: 主表计数声明 33 处 —— 已核 32、跳过 1
  ⚠️ 有 1 条**没能核对**：
     · F-01 `contract.test.mjs`（ambiguous）
```

★ 根因在 `parseCountClaims()`：正则本来**认**路径（`[\w./-]*`），
而紧接着那一行把它砍回文件名——

```js
out.push({ row: row[1], line: i + 1, name: m[1].split('/').pop(), claim: Number(m[2]) })
```

后果是具体的：一条**写得很准**的全路径引用被当成裸名去解析 ⇒ 撞上同名文件 ⇒
记 `ambiguous` ⇒ **静默跳过**。而"跳过"是**没能核对**，不是"文档写错了"。

> 一个把路径砍成文件名的判据，
> 会把「这条引用很准，只是我读不出目录」报成「这条引用有歧义」——
> 于是**修文档永远消不掉这个告警**，而下一个读的人会以为文档还有问题。

★ 而我**改文档并不能让它变绿**——这就是这一处最值钱的地方：
**同一个缺陷被两套判据各犯了一次，其中一套还把它记成了"跳过"。**

**修法与结果**：

    before：  已核 32、跳过 1          ⇒ F-01 的全路径**从未被核对过**
    after ：  已核 33、跳过 0          ✅ 全部与实测一致

★ 修的时候顺手打断了另一条路：`team-hub/budget-alert.mjs（20 例）` 的 20 例在
`team-hub/budget-alert.test.mjs`，而新的全路径分支不认识"带目录的模块名"⇒
落进 `unresolved`；**修之前它靠 `split('/').pop()` 侥幸解对了**。
⇒ 两条路都要在：全路径优先，然后**带目录的归一化**。变异 S3 咬住这一条。

### ④ ★★ 我的用例夹具给错了输入，于是假红

用例 ⑪ 第一版把 `team-hub/budget-alert.mjs`（**模块本身**）也塞进了夹具的
`trackedTests`，于是全路径分支先命中了它、返回了**模块**而不是测试文件 ⇒ 假红。

★ `resolveTargets()` 的形参叫 `trackedTests`，而生产给的是
`git ls-files '*.test.mjs'`——**只含测试文件**。

> 夹具必须与生产给的是**同一种**输入，否则测的是另一件事。

### ⑤ 这一轮的判据读数

| 判据 | 用例 | 变异 | 抓到的真缺陷 |
| --- | --- | --- | --- |
| `feature-evidence`（新，CI 第 14 套） | 10/10 | **9/9** | F-01 的裸名歧义（已修文档） |
| `suite-counts`（补 3 例回归） | 13/13 | **5/5** | ★★★ 全路径被砍成裸名（已修判据） |

★ 套件 **368 → 369**。

## 5.20 第 37 轮：目标文档 **§7「测试与指标」** 此前没有任何判据，也没有任何文档引用它

前几轮核过：台账（140 条 ✅ 的证据）、F 表（F-01～F-25）、§9 那条九节链。
而 **§7** —— `git grep '§7'` 在整仓里只命中**别的东西**，没有任何判据、
也没有任何文档引用过它。于是"§7 满足了没有"这一问**无法回答**，
而它是目标文档自己的一节要求。

**逐条读下来的结论是：§7 的 5 条可核对要求全部已满足，第 6 条不是完成标准。**

| §7 条 | 内容 | 归属（§6 退出条件 / 观测） | 落点 | 核到的读数 |
| --- | --- | --- | --- | --- |
| 1 | Fake Adapter 覆盖 health/execute/cancel/recover/终态/错误码 | P0「Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复」 | `runtime/contracts/fake-adapter.test.mjs`、`runtime/contracts/contract.test.mjs`、套件 `runtime-contract` | **六项各有具名用例**；其中"错误码"那一条的用例名就叫「故障矩阵无缺口」 |
| 2 | 新旧对拍只在隔离库/worktree/非生产空间 | 同上 | `scripts/ci/dual-write-smoke.test.mjs`、套件 `runtime-contract-cross-process` | 用 `mkdtempSync(tmpdir())` 的**临时库**，起两个真进程并发写；不指向任何客户库 |
| 3 | 故障注入 7 类 | 同上 | 5 个用例文件（见下） | **7 类各有落点** |
| 4 | 安全测试 5 项 | P0「输入和权限可复现、可审计，hard floor 不可绕过」 | 5 个用例文件 | 全仓命中用例文件 **25 / 17 / 8 / 25 / 38** 个 |
| 5 | 静态检查禁止 Adapter 外调 DSH API | P0「对拍通过；并发、重试、崩溃可恢复」 | `scripts/ci/dsh-boundary.mjs`、`scripts/ci/dsh-boundary.test.mjs` | ★ **已有**：PRT-002 依赖清单 / PRT-108 执行面边界**棘轮**（`--check` 在 CI 的 `boundary` 阶段），适配层是唯一豁免 |
| 6 | 持续观察 6 个指标 | ★ **不是退出条件** | 部分：套件 `usage-rollup`、套件 `budget-alert` | ⚠️ **尚未全部实现**，如实记录 |

§7 第 3 条的 7 类逐类落点（**每一类都打开文件读过具名用例，不是关键词命中**）：

| 故障 | 落点 | 读了什么 |
| --- | --- | --- |
| Runtime 崩溃 | `runtime/contracts/fake-adapter.test.mjs` | `crash` 场景 → `RUNTIME_CRASHED`，并入"故障矩阵无缺口" |
| 网络中断 | `product/launcher/readiness.test.mjs` | 「连接被拒 → 可重试」，**含真 undici 的 `TypeError('fetch failed')+cause.code` 形态**（该用例自己的注释说：不是只认我们伪造的） |
| 重复事件 | `team-hub/event-delivery.test.mjs` | 「plan 幂等：已投过的行不会被重新 plan 成 pending（**重启不重投**）」、`takeUp` 二次取走被拒、`markDelivered` 只能从 `delivering` 来 |
| 审批超时 | `team-hub/approval-ttl.test.mjs` | 40+ 条，含「越期的审批**不能被批准**」「到期扫描是**幂等**的」「结束态的行不会被改判成过期」 |
| 凭证缺失 | `runtime/contracts/fake-adapter.test.mjs` | `secret-unavailable` 场景 → `SECRET_UNAVAILABLE` |
| 预算耗尽 | `runtime/contracts/fake-adapter.test.mjs` | `budget-exceeded` 场景 → `BUDGET_EXCEEDED` |
| 升级失败 | `product/upgrade/upgrade.test.mjs` | 四档失败点（下载损坏 / 迁移失败 / 启动失败 / 健康检查失败）**各自**验"恢复到已知兼容状态且数据不丢失"，另有第五条 contract 迁移后的回滚 |

### ★★★ 这一格真正值钱的那条：**观测性要求不是完成标准**

§6 那五条退出条件**逐字读**过，**没有一条**提到指标。而 §7 第 6 条那 6 个
「持续观察」指标在代码里几乎**没有读出口**（4 个零命中，也没有 `/api/metrics`）。

> 一条**观测性**要求与一条**完成标准**，在"未实现"这个读数下长得一模一样——
> 而前者不该拦发布，后者该。把它们混起来，要么永远关不掉，
> 要么用"指标没做"去否掉一个已经达标的发布。

而且它诚实的读数是**两半**：其中「商业 Alpha 交付周期」必须有**真实用户项目**
才量得出来（PRT-910 需真实用户项目，属 ⏸）；另外五个所需的原始数据
（`run_reconciliations`、`usage_records`、升级记录、投递状态机）**已经在库里**，
缺的是**汇总读出口**而不是数据。⇒ 我把它记成**观测档 + 一处如实记录的缺口**，
而不是把它做成一个新的"红"——**把一个非退出条件做成红，等于用一个假的未完成
去换一个真的告警**。

### ★★ 而我的表第一版就栽在"看起来是证据、实际谁都没查"上

`budget-alert` 那一处漏写了 `套件 ` 前缀 ⇒ 解析器不把它当指针 ⇒
**它看起来是证据、实际永远不会被核对**（探针读数那一行 `suites=1`，而它写了两个套件）。

⇒ 补了一条守卫：**后引号里像套件别名、而又真的是一行 CI 套件、却没写 `套件 ` 前缀的
token，必须红**。修完读数 **17 → 18 处落点**（被漏掉的那一处回到了核对里）。

★ 并订正我自己的**一处误报**：我当时以为 `runtime-contract-cross-process` 也漏了前缀，
那是**探针输出被截断**造成的误读——它带着前缀、也被核对了。注释里已改成"一处"。

### 这一轮的判据读数

| 判据 | 用例 | 变异 | 说明 |
| --- | --- | --- | --- |
| `spec-tests-7`（新，CI 第 15 套） | 13/13 | **10/10** | 6 条要求 → 6 行投影（5 退出条件 + 1 观测）、18 处落点 |

★ 变异 M10 是**改真文档**：把 §7 第 6 条从 `MULTI-AGENT-FEATURE-OPTIMIZATION.md` 里删掉
⇒ 那一行投影立刻过期、判据必须红。**判据与目标文档是活的对照，不是一份抄件。**

★ 套件 **369 → 370**。

## 5.21 第 38 轮：目标文档 §2 那 5 条「不可突破的边界」，整仓里只有它自己提到过

§2 那一行（`MULTI-AGENT-FEATURE-OPTIMIZATION.md:128`）逐字写着：

> 不可突破的边界：不自研第二套 Agent Loop；不复制任务/审批/审计数据库；
> 不把 worktree 当安全沙箱；不在契约稳定前同时支持多个 Harness；
> 客户不需要单独安装或升级 DSH。

第 38 轮实测：`git grep '不可突破的边界'` 在**整仓里只命中两处**——
目标文档自己，和本仓状态文档。**没有任何判据、没有任何模块引用过这 5 条。**

> 五条「不可突破的边界」与五句没人读过的愿望，
> 在"它们有没有被守住"这个读数下是同一个东西。

### 逐条量下来的归属：4 条可机械化，1 条如实记为设计决定

| 边界 | 归属 | 判据 | 扫了 |
| --- | --- | --- | --- |
| ① 不自研第二套 Agent Loop | 机械 | `orchestrator`/`product`/`team-hub` 三层里 `agentLoop` 一次都不许出现 | 296 个文件 |
| ② 不复制任务/审批/审计数据库 | 机械 | `team-hub/` 下打开控制面库的生产文件只有 `server.mjs` 一个 | 38 个文件 |
| ③ 不把 worktree 当安全沙箱 | ★ **设计决定** | —— 见下 | 0（不适用） |
| ④ 不在契约稳定前同时支持多个 Harness | 机械 | `runtime/adapters/` 下只能有**一个**适配器目录（今天只有 `dsh`） | 15 个文件 |
| ⑤ 客户不需要单独安装或升级 DSH | 机械 | 产品代码里不许有"下载/安装 DSH"这一步（PRT-011 路线 C） | 162 个文件 |

**逐条核到的读数**（都是打开文件读的，不是关键词计数）：

- **①** `agentLoop` 全仓 10 处命中，**产品三层里 0 处**；命中的都在
  `runtime/adapters/dsh/session-boundary.mjs`（适配层在**声明 DSH 自己的**服务面，
  注释逐字写着"签名逐字抄自该注册表"）与 `runtime/dsh-composition/` 的探针里。
  ★ 反向核对：`DshRuntimeAdapter` 命中 17 个文件——**执行面确实在适配层**。
- **②** `new DatabaseSync` 在生产代码里命中 12 个文件，其中 `team-hub/` 下**只有
  `server.mjs`**（其余是 store 收句柄、backtest 工具、迁移脚本、`whiteboard` 自己的库）。
  控制面账本**只有一本**。
- **④** `runtime/adapters/` 下**只有 `dsh` 一个目录**；`claude.*adapter` / `codex.*adapter`
  零命中。
- **⑤** `installDsh` / `DSH_CHECKOUT` 在产品代码里零命中。

### ★ ③ 为什么如实记成"设计决定"而不是造一条判据

`worktree` 在 **125 个文件**里出现过，绝大多数是在说"这是这次 Attempt 的独立检出"。
**把出现次数当违反会立刻得到一片假阳性**——这是本仓反复栽过的那类错（第 31～37 轮
一共记了 8 个我自己的假阳性）。

第 38 轮实测：`worktree.*(sandbox|沙箱|隔离)` 与反向写法**各 0 命中**，
**没有任何一处代码把 worktree 与安全边界并列**；安全边界确实建在强制面
（PRT-603～606 与 `run-floor`）上。但——

> "没有一处这样写"是一个**读数**，不是一条能长期把守的判据。

⇒ 记成 `kind: 'design'`，并**强制写出为什么它没有机械形状**（≥20 字）。
**把一条没有机械形状的约束硬做成判据，等于用一个假的守卫换一个真的假阳性。**

### ★★★ 这一轮最值钱的教训：**"零命中"可能来自"没跑"**

本轮的探针第一版是**整套假阴性**，两个错叠在一起：

1. 我拼了 `rg` 的参数，而 **`rg` 在本机根本不在 PATH 上**（`spawnSync rg ENOENT`）；
2. `catch { return [] }` 把 **ENOENT** 与"**没有匹配**"吞成了**同一个值**。

⇒ 5 条边界**全部报 0 命中**。而"5 条全清白"与"探针一次都没跑成"在输出上
**长得一模一样**。

> 一个依赖缺失的检索器，与一个真的什么都没匹配到的仓库，
> 在"零命中"这个读数下是同一个东西——只不过前者的 0 来自**没跑**。

修法三条，都进了判据：

- 改用 `git grep`（必然存在），并且**只把 exit 1 当"没有匹配"**，其它非 0 一律抛；
- 跑之前先拿一个**必然命中**的模式（`RuntimeAdapter`）**自检**，命中 0 就直接抛——
  **没有自检的探针，报的 0 不可信**；
- 判据层加**空转守卫**：每个机械判据必须报出**它扫了几个文件**，扫到 0 ⇒ **红**。

★ 判据本身也**不用任何外部可执行文件**搜内容：只 `git ls-files` 取清单 + `readFileSync` 读。
那次假阴性正是"依赖一个不在 PATH 上的可执行文件"造成的。

### 这一轮的判据读数

| 判据 | 用例 | 变异 | 说明 |
| --- | --- | --- | --- |
| `design-boundaries`（新，CI 第 16 套） | 12/12 | **11/11** | 5 条边界 → 5 条声明（4 机械 / 1 设计） |

变异里有两条与别处不同，**它们改的不是判据，而是被判据看着的世界**：

- **M10** 往 `orchestrator/worker/run.mjs` **真的塞一处 `agentLoop`** ⇒ 边界被破，判据必须红；
- **M11** 从**真文档**里删掉「不把 worktree 当安全沙箱」⇒ 声明立刻过期，判据必须红。

两条都咬住了，且**三个被改的文件**（判据 / 目标文档 / 被注入的产品文件）**逐字还原**
核对过。

★ 套件 **370 → 371**。

## 5.22 第 39 轮：§7 第 6 条那六个「持续观察」指标**真的落地了**——四轮前那句"不是退出条件"被我自己读窄了

第 37 轮把 §7 投影了一遍，结论是「**5 条可核对要求全部已满足**，第 6 条**不是完成标准**」，
并把它记成"观测档 + 一处如实记录的缺口"。

**那个结论的前半句是对的，后半句被读窄了。** 「不是退出条件」≠「不该实现」——
它是目标文档的**明文要求**。我连续几轮说"本机功能工作已尽"，**这不准确**。

### 起因：一个**关键词探针**造成的假阴性

第 38 轮我量过 §7 第 6 条，用的是这些关键词，全部**零命中**：

    eventLoss|遗漏|duplicateRate   Run 恢复率   rollbackRate|回滚成功率   /api/metrics

而实际上：

| 我以为不存在 | 其实早就有 |
| --- | --- |
| 指标框架 | ★ `product/metrics.mjs` —— **9 个指标**（spec §6.6）、未知档、比率、不适用，**34 例断言** |
| 指标数据源 | ★ `product/metrics-source.mjs` —— 生产喂数人，还会逐个点名"没有生产者"的格子 |
| 升级结果读数 | ★ `product/upgrade/audit.mjs:183` 的 `upgradeResultMetric()` |
| 心跳载荷 | `product/heartbeat.mjs`（PRT-713） |

> 一个**按关键词**去搜代码的探针，与一个"仓库里确实没有"的仓库，
> 在"零命中"这个读数下是同一个东西——只不过前者的零来自**名字不一样**。

**这与第 38 轮那次假阴性是同一族的第三种形态**（那次是"依赖的 `rg` 不在 PATH 上"，
这次是"依赖的名字猜错了"）。两次都是**探针**报 0，而仓库里有东西。

### 真正的缺口（精确读数）

框架在、口径在，而 §7 那六个指标**一格都不在那九格里**（那九格是 spec §6.6 的）：

| §7 第 6 条的要求 | 今天 | 原始数据在哪 |
| --- | --- | --- |
| 事件遗漏/重复率 | ❌ 零命中 | ★ `event_deliveries`（state / attempts）**已在库里** |
| Run 恢复率 | ❌ 零命中 | ★ `run_attempts`（failure_code / attempt_no）**已在库里** |
| 审批等待与拒绝率 | ❌ 零命中 | ★ `permission_requests`（status / createdAt / decidedAt）**已在库里** |
| 预算超限率 | ❌ 零命中 | ★ `budget_reservations`（overrun_amount / spent_amount）**已在库里** |
| 升级回滚成功率 | ⚠️ 只有"最近一次结果"（STATE），没有**比例** | `product/upgrade/audit.mjs` 的审计记录 |
| 商业 Alpha 交付周期 | ❌ 需要**真实用户项目** | ★ **没有生产者**（PRT-910 同样卡在这里） |

⇒ **缺的是"汇总读出口"，不是数据。** 这不阻塞、不需要裁决、不需要外部环境。

### 交付：`product/metrics-spec7.mjs` + `product/metrics-spec7-source.mjs`（纯功能）

**6 条要求 → 8 格指标**（每条要求至少一格，`requirement` 字段双向可核）：

    event-loss-rate                  事件漏投率        unknown / 已到终态的帧
    event-duplicate-rate             事件重复投递率     重投过才送达 / 已送达
    run-recovery-rate                Run 恢复率        恢复起来的中断任务 / 中断任务
    approval-wait-ms                 审批等待中位数     已决审批的中位等待（中位数，不是均值）
    approval-denial-rate             审批拒绝率         拒+越期 / 已决
    budget-overrun-rate              预算超限率         超限预留 / **结清过用量**的预留
    upgrade-rollback-success-rate    升级回滚成功率     回滚成功 / 需要回滚
    alpha-cycle-days                 商业 Alpha 交付周期  ★ **没有生产者**，如实点名

### ★ 为什么**不**并进 §6.6 那九格

那九格的聚合摘要（`metricsSummary()`）是**远程心跳（PRT-713）的载荷**，而那份载荷走
**允许名单**——加一个键就是**加一次数据外流**。§7 这六个是**运营读数**（漏投、审批等待、
预算超限），它们该不该出机器是一个**独立的产品决定**。

> 一次"顺手往心跳里多带一格"的改动，与一次"决定把运营读数发到远端"的改动，
> 在 diff 上长得一模一样——只不过后者本来该有人点头。

但**第二张表不许是第二套纪律**：`METRIC_CODES` / `METRIC_KINDS` 直接从 `metrics.mjs`
引入，未知档的**键集**有一条跨模块用例逐字比对（漂了就红），"分母为 0"两边给同一个原因码。

### 三条纪律（与 §6.6 那张表同族）

1. **零与"没有"不是同一个东西**：分母为 0 ⇒ `metric-no-observations`（"还没观察过"），
   **不是 0%**——0% 会让值班的人以为"观察到过失败，只是没有"。
2. ★ **分子与分母必须是同一批人**：预算超限率的分母是"**已经结清过用量**"的预留行。
   用"全部预留行"会系统性地压低超限率——一条还挂着、还没花过钱的预留**没有机会**超限。
   （`run-store.mjs` 的 `metricsCounts()` 早就为这件事写过一段。）
3. **"没这张表"与"表是空的"不许同形**：表不存在 ⇒ 进 `missing` 并具名，
   **不许**在 snapshot 里留一个 0。同理**"没有生产者"（产品事实）与"这次读不出来"
   （这次调用的问题）分开**——两者都是「—」，但一个要去建记录器，一个把库连上就行。

### ★★ 一处**回归**（我自己刚写下的）

`approval-wait-ms` 的快照字段名（`approvalWaitP50Ms`）与指标键**不一样**。第一版没有
`valueFrom`，于是它去读 `snapshot['approval-wait-ms']`（永远 undefined）⇒
**这一格永远显示「—」，而生产者明明喂了数**。用例 ⑥ 专门钉住它。

### 这一轮的判据读数

| 交付 | 用例 | 变异 |
| --- | --- | --- |
| `product/metrics-spec7.mjs` + `-source.mjs`（CI 第 17 套） | **17/17** | **13/13** |

★ 变异 S6 **第一次漏网**，而那是一个**真缺陷**：我的夹具让 `t1` 只丢**一次**租约，
于是 `COUNT(DISTINCT task_id)` 与 `COUNT(*)` 给出同一个答案——
**"按任务去重"这条规则无论写对写错都通过**。改成丢**两次**之后咬住。
（这就是"夹具没打中规则，于是控制用例是假的"。）

★ 变异 S1/S2 第一次打了**错误的文件**（守卫在声明模块，我打了数据源模块）⇒
"变异串没找到"。**"没找到变异串"与"变异被咬住"在输出上都是"没有漏网"**，只是前者多一行 ⚠。

★ 另修掉我自己写下的一个**假变异体**（S7 的 find 与 repl 相同）——
它永远不会咬住，而"没咬住"会被误读成"判据漏网"。

★ 套件 **371 → 372**。

## 5.23 第 40 轮：`RUN_RECORD_OPTIONAL_FIELDS` 那张声明表**没有消费者**——"新读数加在这里"是一句空话

起因是把 PRT-009 那条"峰值读到不了磁盘"的链**逐段走完**（此前是推断）：

| 段 | 位置 | 状态 |
| --- | --- | --- |
| 生产者 | `supervisor.mjs:508` `status()` 每行带 `peakResource: readPeakResource()` | ★ **已经在产出** |
| 记录层收不收 | `run-record.mjs` `buildRunRecord` | ★ 收 |
| 校验层认不认 | `run-record.mjs` `validateRunRecord` | ★ 认 |
| **中间那一跳** | `launcher.mjs:1261-1267` 把 `status()` 的行映射成三个字段 | ★★ **就是这里丢的** |

⇒ 前几轮说的"缺的是生产者的那一行"**是对的**，而现在它是**读数**，不是推断。

### 走这条路时撞到的真缺陷

`run-record.mjs` 里有一张 ★★★ 声明表 `RUN_RECORD_OPTIONAL_FIELDS`，注释写着
「**新读数一律加在这里**，不要加进 `RUN_RECORD_FIELDS`」。而在本轮之前：

- `buildRunRecord` **自己手写** `'peakResource'` 这一个名字来抄；
- `validateRunRecord` **自己手写** `'peakResource'` 这一个名字来校验。

⇒ 那张声明表**没有任何机械消费者**。**照注释做一次**的后果（实测，`scratch/_probe-record-drop.mjs`）：

    输入字段 = ["key","pid","image","peakResource","diskUsageBytes"]
    写出字段 = ["key","pid","image","peakResource"]
    diskUsageBytes 还在吗 = ★ 被静默丢掉了
    validateRunRecord 的问题 = []

★ 记录**看起来完全正常**，而那个读数从来没到过磁盘——
与本仓反复防的那个形状完全同族。

> 一张只写在注释里的扩展点，与一条真的能扩展的通路，
> 在"下一个人照做之后会不会发现问题"这个读数上是同一个东西：都不会发现。

### 处置：让两边都**遍历声明**

1. 新增 `REQUIRED_FIELD_READERS` / `OPTIONAL_FIELD_READERS` / `OPTIONAL_FIELD_VALIDATORS`
   三张登记表；
2. `buildRunRecord` 遍历 `RUN_RECORD_FIELDS` + `RUN_RECORD_OPTIONAL_FIELDS` 去取，
   **不再手写字段名**；声明了没登记 ⇒ **具名上抛** `RUN_RECORD_FIELD_NOT_WIRED`
   （**不跳过**——跳过就是静默丢掉）；
3. `validateRunRecord` 同样遍历；可选字段的**形状校验器**单独一张表，
   因为"写出去的样子"与"读回来什么样算坏"是两个方向的问题；
4. 新增 `recordWiring()`：把**四个方向**都报出来——
   必填没取法 / 可选没取法 / 可选没校验器 / **登记了却没声明**（另一个方向的静默）。

★ 四张登记表都可注入，**是为了让用例能造一个第二字段去证明这条通路真的通**；
不然这条判据只能证明"当下这一个字段恰好是通的"。

### 读数

| 交付 | 用例 | 变异 |
| --- | --- | --- |
| `product/launcher/run-record.mjs`（声明表接线化） | `run-record` **47 → 53**（+6） | **9/9** |

★ **反向控制**（两条都钉住）：旧记录（只有三个必填字段）仍然算好记录
——否则上一个 launcher 写下的记录会被判死、**孤儿进程清不掉**；
而 `peakResource` **不许**挪进必填表（变异 M9 证明这条会被捉住）。

★ 全部 launcher 套件 **30 个 / 688 例**全绿。套件总数不变（**372**，没有新增套件文件）。

### 这一轮我自己的三次误报（都记下来）

1. 我按关键词找"§7 六指标"曾经零命中（第 39 轮）——第 40 轮我换了个方向，
   去逐条打开可达性基线里 27 条 `gap`。其中 **`product/lifecycle/data-classes.mjs`
   被我判成"没有用例"，是错的**：它被 `uninstall.test.mjs` / `retention.test.mjs` 覆盖着。
2. 我又去查"✅ 但证据栏没有一个 `*.test.mjs` 落点"的行，得到 **50 条**——
   **同样是我探针的口径错了**（`extractMentions` 只把 `*.test.mjs` 算"套件"，
   而那 50 条写的是**文档与非测试模块的路径**，都是真落点）。
3. `F-12 产品级 Launcher 待完成` 我一度以为没被校准，其实它在 §1.2 的表里
   （我只读了表的前六行就下了结论）。

★★ 三次都是**我的探针的口径**错了，不是仓库错了。
第 39 轮那次是"名字猜错"，这三次是"口径太窄"——
**同一个族，第四次到第六次**。所以这一轮最后落到的那个缺陷，
是**读代码读出来的**（逐段走生产者→记录层→校验层→中间那一跳），不是搜出来的。

### 5.24 第 41 轮：把那种形状**做成可证伪的**——`declaration-mirrors` 门禁

第 40 轮那个缺陷的形状是"**一张声明表 + 它的成员被手写复述**"。这一轮先做了一件事：
**验证那个形状在这个仓库里是不是只有一处**。

- 逐条打开可达性基线里 **27 条 `gap`** 去找同族缺陷；
- 然后写了一个判据去量"声明表有没有被遍历"，**第一版报了 366/702 张**——
  `*_CODES` / `*_ERRORS` 这类**字典**本来就该按 `CODES.FOO` 取值、不该被遍历。
  ⇒ **本族的第七次误报**（"没被遍历" ≠ "没有消费者"）。
- 收窄到"注释里**自己承诺**可扩展"的表：全仓**只有 1 张**，就是第 40 轮修掉的那张。
  ⇒ 那条矿脉**已经采完**。

于是这一轮的价值不在"再找一个"，而在**把那个形状变成以后每次都会自动检查的**：

| | |
| --- | --- |
| 判据 | `scripts/prt/declaration-mirrors.mjs`（CI 第 18 套） |
| 口径 | 只认**键位**复述（`member:` / `, member,`）——认"字符串出现过"会报 **17 张**假阳性，因为枚举值出现在**值位**是正常使用 |
| 门槛 | 命中成员 ≥ 2 且 ≥ 总数一半（"只命中一个"是巧合） |
| 自证 | 一份**修复前的真实形状**必须被报出、一份**修复后的**必须被放行（R4） |
| 豁免 | 必须写 `why`（≥20 字）与 `owner`；**过期豁免判红**（R2）——豁免表不会变成一句没人核的话 |
| 读数 | 238 张表 / 3 张装饰（全部已写明理由）/ 12 例全绿 / 变异 **12/12** / **1.9 秒** |

**本轮第三个真缺陷**（`team-hub/budget-alert.mjs`）：
`BUDGET_ALERT_CONFIDENCE = ['exact','partial','unknown']` 与
`ACTION_FLOOR_FOR_CONFIDENCE = { exact:'none', partial:'review', unknown:'review' }`
是两张**必须逐项对齐**的表，而它们的漂移是**静默**的——
`ACTION_FLOOR_FOR_CONFIDENCE[未登记置信度]` 返回 `undefined`，
`strictestAction(fromLevel, undefined)` 把它当成一个新档位
⇒ **动作下限凭空消失，而一行错都没有**。已改成一进模块就遍历词表、缺一项就具名上抛。

★ 这个判据自己的两次破验漏网也留档了（都很值钱）：

1. **M3 漏网**：不是判据漏了，是**我的夹具没构造出键位形状的注释**
   （`// data: 业务状态` 前面有 `// `，本来就匹配不上 `^\s*data\s*:`）
   ⇒ 那一条即使把"去注释"整行删掉也照样绿。
   > 一个"判据没报"的读数，与一个"夹具根本没构造出那个形状"的读数，
   > 在只看断言真假时是同一个东西。
2. **M4 漏网**：`isDeclarationLine` 那道"整行跳过声明"的守卫**走不到**
   （数组声明里的成员永远带引号，键位规则在声明段内没有可命中的形状）。
   但它**不是无害的**：当声明与真实代码**同一行**时
   （`export const F = Object.freeze([...]); const row = { key: 1 }`），
   整行跳过会把那处**真凭据**一起丢掉。
   ⇒ 改成"只挖掉声明那一段"（等长空格、保留换行、行号仍与文件一致）。

**性能也是一条判据**：第一版"每个名字一次 `git grep`"= 238 次子进程、
**单次扫描 236 秒**。一个慢到没人愿意跑的判据，与它不存在，
在"下一次有人照注释加字段时会不会被拦下"这个读数上是同一个东西。
改成**一次** `git grep` 取回全部候选名字后，**1.9 秒**（快 124 倍）。

### 5.24.1 ★★ 第八次误报：**同一个判据、两个时刻**的两次读数，看起来像两个判据打架

新增套件（372 → 373）之后，CI 的 `test` 阶段在 `boundary-facts` 上报红：

    ✖ handover-tracked-suites  交接报告 §二 说"套件清单完备：N 个"
      文档说 372，产物是 373

我当场就写下了"**两个判据不一致**：`boundary-facts.mjs` 这个 CLI 说 19/19 绿，
而它的套件报了红"——听上去很像本会话那个反复出现的形状（两个判据共享一个缺陷、
其中一个记成绿的）。

**这个推断是错的。** 我比的是：

- 一次**第 40 轮**跑的 CLI（那时套件确实是 372，所以 19/19 绿是对的）；
- 一次**第 41 轮**跑的套件（那时套件是 373）。

⇒ 同一个判据、**两个时刻**。它从头到尾都是对的。

> 同一个判据在两个时刻的两次读数，
> 与两个判据之间的分歧，在"我手里这两行输出"上是同一个东西——
> 只不过前者需要的不是修判据，是**把两次读数放到同一个时刻去取**。

★ 佐证：那条 fact 的 `why` 里**早就写着**这件事会这样发生
（"每一轮新增套件都会让它过期——而它旁边那句'全部有归属'是 `stage` 阶段**当场**判的，
两者挨在一起，看起来一样权威"）。也就是说**判据自己预言了我这次的误读方式**。

★ 我真正该改的是文档里那句过期的话（`套件清单完备：372 个` ⇒ **373**），
不是判据。改完 CLI **19/19**、套件 **43/43**，两者同时绿。

### 5.25 第 42 轮：把**我自己上一轮发的豁免**收回——`WRITABLE_ROLES` 那处不是"耦合"，是两条静默失效路径

第 41 轮我新建 `declaration-mirrors` 时，把 `WRITABLE_ROLES` 列进了豁免表，理由写的是
"它是类型的来源、那份手写映射无法机械派生、是一处**已知耦合**"。
第 42 轮我按自己的建议去**裁决**它，读代码读出来的结论是：**豁免错了。**

`product/paths.mjs` 里那两张声明表（`DIR_ROLES` / `WRITABLE_ROLES`）原先**各有一份手写复述**，
而两份都有静默失效路径（实测：`scratch/_probe-path-roles.mjs`）：

| | 写法 | 后果（实测） |
| --- | --- | --- |
| ① | `for (const role of DIR_ROLES)` 里一个嵌套三元，**兜底那支是 `layout?.logDir`** | 加一个角色 ⇒ 它被**当成 logDir** 检查。输出 `PATH_NOT_ABSOLUTE [role=backup] → backup 必须是绝对路径，当前为「relative-log」` ——**角色名对、文案对、值是别人的**，而真正的 `backupDir` 从未被看过 |
| ② | 安装目录那条检查自己手写 `{ data, workspace, cache, log }` 当角色清单 | 往 `WRITABLE_ROLES` 加角色 ⇒ 那条**"可写目录不得落在安装目录内"**的安全检查**根本不查它**（实测：不报） |

> 一条报在正确名字下、引用着另一个值的诊断，与一条正确的诊断，
> 在"这一项检查过了"这个读数上是同一个东西。

**处置**：取法收敛到 `DIR_ROLE_READERS`（`DIR_ROLES`/`WRITABLE_ROLES` 唯一的机械消费者）；
两侧都**遍历声明**；三张表不对齐 ⇒ **一进模块就抛** `dirRoleWiring()`。
★ 那条检查单独抽成 `writableDirsInsideInstall()`（角色清单可注入），
**因为"跟随声明"这件事在今天不可证伪**（见下）。

**读数**：`paths` 套件 **18 → 26**（+8 例，接线①…⑧）；破验 **10/10 咬住、0 漏网**；
`declaration-mirrors` **3 张装饰 → 2 张**（豁免收回一条）。

### 5.25.1 ★★ 豁免是**会过期**的，而且过期是判据自己报出来的

把 `WRITABLE_ROLES` 修成非装饰之后，我**还没来得及删**那条豁免，
`declaration-mirrors` 的 **R2 就把它判成了 `stale-exemption`**。

> 豁免一条判据，与修掉它所指的那处缺陷，
> 在"下一次有人加一个角色时会不会被拦下"这个读数上是同一个东西——
> 只不过前者把这件事记在了我的账上，后者记在了代码里。

★ 这是 R2 这一条规则**第一次真的用上**，而且拦的是**写它的人**。

### 5.25.2 ★★★ 破验里的两次漏网，暴露了一个"不可证伪"的性质

M3（把角色清单改回手写的四元对象）与 M4（改成 `DIR_ROLES.slice(1, 5)`）**都漏网了**。
查下来不是判据漏了，是**它们与正确实现行为完全等价**：今天声明正好是四个可写角色，
手写那四个、切 `DIR_ROLES` 的第 1..4 个、遍历 `WRITABLE_ROLES`——三者结果一模一样。
**任何行为用例都分不开它们。**

> 一条"恰好查对了四个目录"的检查，与一条"跟随声明查目录"的检查，
> 在声明正好是四个角色的那一天是同一个东西——
> 只不过前者会在有人加第五个角色的那一天开始静悄悄地少查一个。

⇒ 处置不是"再写一条更狠的断言"，而是**把角色清单做成可注入的**
（`writableDirsInsideInstall({ writableRoles, readers })`），
于是用例可以拿**第五个**角色去试，"跟随声明"从**不可证伪**变成**可证伪**。
改完之后 M3/M4 **都咬住了**。

★ 同一个理由也适用于 `dirRoleWiring()` 与 `file:///` 那条守卫：
一条只在模块加载时跑一次的守卫，**只能靠改源码来验证**，
而改源码的人正是它要防的那个人 ⇒ 做成可注入的纯函数（接线⑥）。

### 5.25.3 ★ 我自己的 API 错误被**错误文案**当场叫出来

写接线⑧时我传了一张**只有 `backup` 的** `readers` 表去替换默认表，
于是 `data` 等角色成了"没有取法"。守卫**当场抛**：

    paths：可写角色「data」没有取法——静默跳过它，等于这条安全检查从没查过这个目录。

★ 如果当时写的是"没有取法就 `continue`"，我这次会得到一个**少查了四个目录**的绿。
那条文案就是为这一幕写的。

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


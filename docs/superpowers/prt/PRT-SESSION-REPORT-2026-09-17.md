# 本轮交付报告 —— F-01～F-25 在 Legion→DSH 架构上的落地

> 日期：2026-09-17 ｜ 依据：[`MULTI-AGENT-FEATURE-OPTIMIZATION.md`](../../MULTI-AGENT-FEATURE-OPTIMIZATION.md) 的 §5 执行顺序
> 对照表：[`MULTI-AGENT-FEATURE-STATUS.md`](../../MULTI-AGENT-FEATURE-STATUS.md) ｜ 权威台账：[`superpowers/prt/PRT-PROGRESS.md`](./PRT-PROGRESS.md)
>
> **结论先说**：优化清单里**可以在代码侧单独完成的部分已经做完了**；
> 剩下的每一条都指向一个**代码之外的决定**（产品裁决、另一台机器、真实用户、排期日期），
> 或指向另一个 agent 进程**当轮正持着未提交改动**的文件。
> 详见 §5 的 **16** 条人工介入清单。
>
> **本报告随每次续批更新**（§1 的提交表与 §3 的缺口清单是活的）。

---

## 1. 本轮交付（提交）

| 提交 | 内容 | 判据 |
|---|---|---|
| `933365c` | **F-19** Employee / Role Pack | 75 例（`role-pack` 40 + `role-pack-store` 25 + `role-pack-http` 10） |
| `b1800af` | **F-18** 经验图谱 / 摩擦学习 | 75 例（`friction` 23 + `graph` 15 + `experience-store` 23 + `experience-http` 14） |
| `747de46` | **F-20** 能力包回滚 / 账持久化 / 安装事实 | `store` + `pack-facts` + HTTP |
| `8c8ee84` | **PRT-509 B2** `inspectSecretsAcl` 从死代码变成唯一读取点 | `secrets.test.mjs` ⑧ |
| `6bdf4fc` | **F-21** Connector / MCP 注册表 | **64 例** + **30 处变异** |
| `7336ab1` | **docs(F-04)** 手抄台账合计对不上 → 补 3 条门禁 | `progress-check` 15/15 |
| `a2fc2df` | **docs(F-21)** 如实从 ✅ 改回 🟡 + 门禁锚点纠错 | 同上 |
| `7ad5c8b` | **PRT-604/605/606** 三道范围检查在生产里从未跑过 → 变成读数 | **5 例** + **5 处变异** |
| `9a56e77` | 本报告初版 | — |
| `1b0ade3` | **PRT-610 续批** 建表 + 三条只读路由 + 就绪证据的**产出点** | **41 例**（31+10）+ **10 处变异** |

新增生产/测试文件 **18 个**（`git diff --name-status`）：

```text
runtime/connectors/{registry,registry.test}.mjs
runtime/employee/{role-pack,role-pack.test}.mjs
runtime/experience/{friction,friction.test,graph,graph.test}.mjs
runtime/dsh-composition/production-scope-wiring.test.mjs
team-hub/{connector-store,connector-store.test,connector-http.test}.mjs
team-hub/{experience-store,experience-store.test,experience-http.test}.mjs
team-hub/{role-pack-store,role-pack-store.test,role-pack-http.test}.mjs
```

## 2. 按文档 §5 执行顺序的进度

| 顺序 | 内容 | 状态 |
|---|---|---|
| ① | Runtime Contract / DshRuntimeAdapter 边界 | ✅（PRT-101～107、PRT-213/214/253 主体） |
| ② | 阶段 2.5 最小商业闭环 | 🟡 PRT-253（`canRead` 需改 wire 契约 ⇒ 人裁决）；PRT-256 ⏸（需真实用户） |
| ③ | Orchestrator 切片 | ✅ PRT-301～315；⬜ PRT-316 **排期未到**（最早 2026-09-24） |
| ④ | 用量/自动化/连接器/多 Harness/多用户 ACL | F-15 🟡（缺 `peak-resource`，阻塞于人）、F-16 ✅、F-17 ✅、**F-21 本轮落地**、F-23/F-25 ⏸、F-22/F-24 按 §9 按需 |

F-01～F-25 的逐条状态与依据见对照表；台账 145 条今天读数是 **138 ✅ / 4 🟡 / 1 ⬜ / 2 ⏸**。

## 3. 三个功能任务的判据与"它防的是哪种坏写法"

### 3.1 F-19 Employee / Role Pack（`933365c`）

- **七类版本一个不少**，缺一类**不给默认空值**：`connectors: []`（显式"就是不用"）合法，
  **没写这一节**非法——"缺连接器就当没有"与"作者忘了写、于是静默地没有"在运行结果上同形。
- **版本号是标签、内容哈希才是身份**：对账把 `VERSION_DRIFT`（显眼）与
  `CONTENT_DRIFT`（阴险——按版本号比对会报"一致"）**分开报**。
- 岗位包属 **agent 平面**，强制面字段在**每一层嵌套**都被拒；连接器一节只许出现引用。
- 冻结**改不动**：主键 `(scope, role_pack_id, version)`；同版本换内容 **409**。

### 3.2 F-18 经验图谱 / 摩擦学习（`b1800af`）

- 与旧 `plugins/src/experience.ts` 最要紧的分歧：旧实现从**评论散文**里正则数信号，
  于是**改了措辞分数就变**——而"因为改词变成 0"与"这段时间确实没有摩擦"在报表上是同一个 0。
  新实现**只从结构化字段取值**，并有一条**结构级**用例禁止源码里出现正则字面量。
- **缺失的输入是"不知道"、不是 0**：缺任何一维 ⇒ `complete:false`、`score` **抛**。
- **草稿不是知识**：`draft → promoted | discarded`，两个终点都要人 + **封闭词表**的理由。
- **关系图只记不推断**：边不隐式创建节点、必须署名、**撤销是追加不是删除**、遍历带 visited。

### 3.3 F-21 Connector / MCP 注册表（`6bdf4fc`）—— 本轮唯一"从零到一"的功能

spec §4.4 要求四件事一起做（**服务/工具策略、风险分级、SecretStore、故障隔离**）。
此前 grep `connector`/`mcp` 在产品代码里**零命中**。判据照着**坏的写法**写：

| 坏写法 | 为什么它看起来能用 | 实情 |
|---|---|---|
| `if (declared === undefined) return 'allow'` | "没见过，交给下游判断" | = 任何人往 MCP server 上加一个工具就等于加一个后门 |
| 不认识的能力名兜底成 `critical` | "最安全" | 整个连接器莫名其妙全要人批，**没有一处**指出原因是名字拼错 |
| 只检查自己解构出来的三个字段 | 看起来在守着门 | `token: 'ghp_…'` 被解构丢掉、从未被检查 |
| `health = circuit === 'closed' ? 'healthy' : …` | 简洁 | **刚失败的连接器报 healthy**（熔断要连续三次才跳闸） |
| 路由收下 `version` 但不传给查询 | 不报错 | 问"1.0.0 放行了哪些工具"拿回 2.0.0 的清单，**响应里没有任何提示** |

★ 这四个真缺陷都是**跑出来的**，不是审出来的。判据：`registry` 31 + `connector-store` 22 +
`connector-http` 11 = **64 例**，**30 处变异全部咬住**。

### 3.4 两处"记账"工作（`7336ab1` / `a2fc2df` / `7ad5c8b`）

1. **F-04 那一行手抄的台账合计对不上**（写 143/19/1/2，实际 145 行 = 138/4/1/2），
   而且**没有任何门禁会去核对它**（`check-docs` 只管 README 与 `docs/FEATURES.md`）。
   → 改为不复制 + 补 `progress-check` 用例 ⑤⑥⑦（手抄合计 / 引用不存在的任务号 /
   状态标记不在图例）。**3/3 变异咬住**。
2. **F-21 从 ✅ 改回 🟡**：`createRegistry` 全仓**零生产调用方**——正是对照表 §2
   开场白那句"能力齐全、用例全绿、而生产调用方数为 0"。如实改回去，并写清接法与为什么本轮没接。
3. **★★★ 三道范围检查在生产里从来没有跑过**（PRT-603/604/605/606 与生产装配的落差）：
   `enforcementSurfaces()` 实测 `pathScope:false` / `whitelist:false`，
   `execution-scope`/`external-api-scope` **连端口都没有**。详见对照表 §5.2。
   → 新增 `production-scope-wiring.test.mjs`（5 例），**5/5 变异咬住**。完整链条（有行号）：

   | 环节 | 位置 | 读数 |
   |---|---|---|
   | 生产装配唯一入口 | `plugins/root-row.mjs:485-509` | `installEnforcementRoot({env, decide, createRequestApproval})`——只有三个键 |
   | 组合根透传 | `root.mjs:465-466` | `whitelist`/`pathScope` ⇒ `undefined` |
   | 装配默认值 | `assemble.mjs:135-136` | 均为 `null` |
   | 桥的行为 | `tool-request.mjs:638-651` | `null` ⇒ 返回 `undefined` ⇒ **放行** |

   ★ **本轮没有接线**，因为**接了就是编造**：范围表（读根/写根/平台）今天不在任何随请求
   到达的载荷里——与 PRT-253 论证 `canRead`「答案不在这边」是同一个形状，
   而凭空造一份范围表正是那篇 §3 明令禁止的"不发明任何默认值、替身或暂时放行"。

## 4. 阶段的总结

### 阶段 A：把"从零到一"的功能补齐（F-18 / F-19 / F-21）

这三条的共同点是**此前 grep 零命中**。它们都按同一条纪律落的地：
**先写"坏的写法长什么样"，再写判据**。三条合计 **214 例**、**54 处变异全部咬住**
（F-19 12 + F-18 24 + F-21 30 — 见各自文档）。

### 阶段 B：处理"用例全绿而生产调用方为 0"

这是本轮**更有价值**的一半，而且它**不在功能清单里**。四次同样的发现：

1. F-21 的判定面（`decide()`）零调用方；
2. PRT-603/604 的 `whitelist`/`pathScope` 端口生产不注入；
3. PRT-605/606 的检查器连端口都没有；
4. ★ **PRT-610 的账从来没有被建起来过**：`ensureToolCallSchema` 在生产里**一行都不调**，
   而 `release-gate.mjs` 的就绪判据 `decisionSourceRecorded` 全仓**没有产出者**——
   于是一个写得很谨慎的判据（"缺失的证据不是证据"）变成了**永远判否**。

四者的**共同形状**是：**注入点让"没接"变成一个可选状态，而可选状态没有调用方。**
对应的处置统一为"**把它变成读数**"（PRT-253 自己立的标准）——
所以现在**接上了会红**，而不是靠人记得。

★ 第 4 条是本轮唯一**同时把两侧都关掉**的：建表（表在生产里真的存在了）+
读面（三条路由）+ **判据的产出点**（`/api/tool-calls/evidence`）。
剩下的一半（写入方）与第 2/3 条卡在**同一个决定**上。

### 阶段 B′：★ 系统盘点，以及一次**差点**报出去的假阳性

阶段 B 的四条不是孤例。本轮把"零生产入口"这一类形状**系统扫了一遍**（§5.3）：

- 命中 40 个 → 排掉合法类别（CLI 入口 / barrel / config-schema / 测试夹具 / 组合行）后**剩 14 个**；
- 分成三类：**已记账**（前四条）、**刻意不接且理由写在代码里**、**产品入口尚未定形**。

★ 两个必须写下来的过程教训：

**① a positive control that only covers known paths is worth nothing.**
第一版的四条正对照全在 `runtime/`+`team-hub/`，而漏扫的是 `scripts/`——
于是 `product/compliance/inventory.mjs`（台账明写入口是 `scripts/prt/sbom.mjs`）
被报成"零调用方"。补上一条跨目录对照后才暴露。

**② 差点把一个"刻意留着的缺口"报成缺陷。** `product/upgrade/index.mjs` 零外部 import，
看起来是整个升级链（PRT-801～813，**200 例**）没有入口。**四种触发方式逐一查过**
（静态/动态 import、被 spawn、CLI 自调用守卫、脚本按路径跑），全无——
但 `runtime-install.mjs` 的注释写了原因：Launcher **刻意不 import** 它，
因为那会把升级审计的整条依赖拖进 Launcher 的进程，而 Launcher 的职责是
"**在那些东西起来之前先把进程看好**"。

> 一个看见"零调用方"就去补一个 `import` 的人，
> 会把 Launcher 的启动依赖拖成升级审计的依赖——
> 而那正是那两处注释**提前**挡住的事。
>
> **一个看起来该补的洞，与一个被刻意留着的缺口，在"零调用方"这个读数上是同一个东西。**

所以 §5.3 里最要紧的一句是"**不要**给 Launcher 补这个 import"。
静态分析能给出**读数**，但"该不该补"要读代码里的理由。

### 阶段 B″：★★★ 第三类 —— **接上去会更坏**（PRT-707 有两份实现）

§5.3 把"零生产入口"分成了"等裁决 / 别动 / 入口未定形"。
这一轮找到了**第四种**，也是唯一一种**动作会主动造成损害**的：

> 前几类是"接不上"。这一类是"**接上去会更坏**"。

`product/launcher/first-run.mjs`（636 行、一整套用例、台账 ✅、零生产导入者）
是 PRT-707 的**第二份**实现；**活的那份**是 `cli.mjs` 的 `--wizard` 分支里**内联**的。
两份对"模型密钥叫什么名字"说法不一致：

| 角色 | 文件 | 引用名 | 谁钉着它 |
|---|---|---|---|
| 活的 | `cli.mjs` `--wizard`（内联） | `model/api-key` | `RUNTIME_MODEL_KEY_REF` + 一条 drift 用例 |
| 死的 | `first-run.mjs` | `legion/model/<profileId>` | `first-run.test.mjs`（自己一整套） |

**关键差别是段数。** `security/secrets/credential-materializer.mjs` 的
`planDshLookup()` 对三段引用返回 `{addressable:false, space:null}`——
在两个键空间里都**没有位置**（`refs` 的键是 POSIX 标识符，
`records` 的键是**恰好两段**）。本轮用**真实读者**实测（含两个可寻址正对照）：

```text
model/api-key                {"addressable":true,"space":"records"}   ← 活的那条
legion/model/default         {"addressable":false,"space":null}      ← 死的那条
legion/openai                {"addressable":true,"space":"records"}   ← 正对照（两段→可以）
DEEPSEEK_API_KEY             {"addressable":true,"space":"refs"}      ← 正对照（另一个空间）
```

于是把那份死的接上去，后果**不报错**：向导报"模型已配置"，运行时拿不到钥匙。
`credential-materializer.mjs` 自己的文件头把这种失效点破了：

> 一个"文件看起来完整、就是少了最要紧那一把钥匙"的读数，
> 与一个"文件本来就只该有这么多"的读数，在 `cat` 的输出里长得一模一样。

★ **本轮没有替任何一方改代码**：两份**各自都自洽**（死的那份用的是 Legion 自己的
三段式，与 `credential-materializer.mjs` 文件头那句一致；活的那条链端到端通）。
裁决它是 §5 第 17 条。本轮把它变成**读数**：`product/launcher/wizard-wiring.test.mjs`
（5 例，**今天全绿**，**7/7 变异成立**）。

★ 变异验证在这一轮**又咬到一次**（同族第四次）：第 ⑥ 处变异第一次没咬住，
原因不是判据写错，而是**我的扫描漏了一种装法**——

> 一个「漏了一种装法」的扫描，
> 与一个「那个模块真的没人装」的扫描，在输出上是同一个东西。

只收 `from '…'` 与 `import('…')`、不收 `import '…'`（纯副作用导入）的扫描，
会把一个纯副作用导入的模块报成"零导入者"。补上第三种装法后它咬住了，
也就证明补漏**有效**（而不是"补了之后正巧还是绿的"）。

### 阶段 C：把"账"本身的缺陷修掉

本轮发现两处**账层面的**缺陷（都不是功能缺陷）：

- 一份手抄的合计数字**对不上**且**无人核对**；→ 去掉副本 + 补门禁。
- 三条 ✅ 的依据是"模块 + 自己的用例"，与台账 §0 那条告警
  「只有自己的用例驱动的原语一律 🟡」**口径不一致**。
  → **没有擅自改状态**（口径由项目方定），记进人工介入清单第 14 条。

## 5. 需人工介入清单（汇总）

完整的"需要谁 / 决定什么 / 不决定的后果"见
[`MULTI-AGENT-FEATURE-STATUS.md` §5](../../MULTI-AGENT-FEATURE-STATUS.md)（共 **18** 条）。摘要：

| # | 事项 | 需要谁 | 不做会怎样 |
|---|---|---|---|
| 1 | PRT-011 DSH 分发形态 | 项目主 | PRT-009 只能停在 🟡 |
| 2 | PRT-009 峰值资源采样 | **执行期外的机器** | 仓内无法测（会话转录不记进程资源） |
| 3–4 | PRT-214 G1 / G4 | 项目主 / 产品 | per-Run 身份只能到进程级；自检通过标准无权威定义 |
| 5 | PRT-253 G2/G3/G4/G6 | 产品 + 项目主 | 黄金任务只能"代码就绪" |
| 6 | PRT-509 C1～C4 | 产品 | 凭证轮换/多档案/失败姿态/运维出口 |
| 7 | 真实凭据 / 另一台机器 | 项目方 | 跨机器证据仍缺 |
| 8 | F-23 / F-25 是否要做 | 产品 | 现按**设计决定**归档 |
| 9 | PRT-316 开工资格 | 项目主（时间到点即可） | **无人需裁决**，最早 2026-09-24 |
| 10 | F-22 远程后端 / F-24 多用户写面 | 产品 | 长期 🟡（**设计决定，不是缺陷**） |
| 11 | PRT-509 剩余三条 | 环境 + 项目方 | 如实记 🟡，不冒充已闭合 |
| 12 | F-19 七类版本范围确认 | 产品 | 有真实包在库后再改就要处理兼容 |
| **13** | **F-21 判定面接线资格** | 项目主 | F-21 停 🟡："闸门写好了、还没装到门上" |
| **14** | ★★★ **三道范围检查的生产接线** | 产品 + 项目主 | **越界路径今天拦不住**（`pathScope === null` ⇒ 放行） |
| **15** | ★★ **PRT-610 执行面的落账点** | 项目主 + 产品 | 表建好了、路由能读、判据能回答"在不在记"，而**一条记录都不会有**（写入方 0）。与第 14 条是同一个决定 |
| **16** | ★★ **阶段 9 产品动作的 CLI 面**（PRT-903/904/905/908/909、712、707） | 产品 | 这批模块**全部自带用例、全部 ✅、全部零生产入口**。不决定则它们**对用户不存在**（台账自己的话："一个功能没有入口，与这个功能不存在，对用户来说是同一件事"）。★ 见 §3 阶段 B′——**PRT-801～813 的升级链不在这一条里**，它刻意不接 |
| **17** | ★★★ **PRT-707 的两份实现用两个不同的模型密钥引用名** | 产品 + 项目主 | **活的**：`cli.mjs --wizard`（内联，`model/api-key`，端到端通）；**死的**：`first-run.mjs`（636 行，`legion/model/<profileId>`，`planDshLookup()` 实测 `addressable:false`——在两个键空间里都没有位置）。要裁决：引用名用哪一个？还是留一份、废弃另一份？★★ **不要**把 `first-run.mjs` 直接接上去：它写进 hub 档案的 `secretRef` 运行时**既不读、也读不到**，而后果**不报错**（向导报"模型已配置"）。★ 本轮没替任何一方改代码——两份**各自都自洽**——而是把它变成读数：`wizard-wiring.test.mjs` 5 例**今天全绿**、7/7 变异成立 |
| **18** | ★★★ **F-18 / F-19 的"执行面一半"由谁调用**（可达性探针新读数，见 §9） | 产品 + 项目主 | 从**真实入口**跑 import 图，`runtime/experience/{friction,graph}.mjs`（F-18）与 `runtime/employee/role-pack.mjs`（F-19）**从任何生产入口都到不了**——只被自己的用例驱动。hub 侧**是**接上的（`experience-store`/`role-pack-store` 经 `server.mjs` 可达），缺的是**产出者**：没有东西算摩擦分、没有东西记图边、没有东西建岗位包。要裁决：这三件事**由谁在什么时候调用**？★ 与第 14 条（范围表）、第 15 条（PRT-610 写入方）**是同一个决定**——三条都卡在"执行面的载荷里今天没有这些字段"。★ 另：本轮**没有**改这三行的 ✅/🟡（口径由项目方定），只把落差记成读数 |

## 6. 诚实边界（本轮**没有**证明的东西）

写在这里以免下一个人把绿色摘要读成超出它范围的结论：

| 事项 | 已证明 | **未**证明 |
|---|---|---|
| F-18 摩擦分 | 只从结构化字段取值、缺输入是"不知道" | 上游数据（`run_validations`/attempt）在真实运行里写得够不够全 |
| F-18 图 | 只记不推断、撤销是追加、带环遍历不挂死 | **没有任何真实调用方**在跑它 |
| F-19 岗位包 | 七节齐全、两种漂移分开、冻结改不动 | 包里的引用是否指向**世界里真实存在**的东西 |
| F-21 连接器 | 未声明即拒绝、风险只上抬、密钥只许引用、熔断有截止时间 | **没有连过任何一个真的 MCP server**；判定面零调用方；`resolveSecretRef` 未接 `SecretStore` |
| PRT-604/605/606 | 三道检查器本身写得很硬（尤其 `path-scope` 那 22 例） | **生产里一次都没跑**（§3.4） |
| PRT-509 | 同机"真进程读到了值"（DSH 提供方从 Legion 材料化的文件里读到） | win32 `0600` 不可证；跨机器证据缺 |
| PRT-610 工具调用账 | 表结构、幂等键、四态结果、读面三条路由、就绪证据的**三态**产出点 | **写入方为 0**：一笔记录都还没有产生过，所以"决定来源真的在记"只有**结构**证据、没有**运行**证据 |
| "零生产入口"那 14 个模块 | 逐个查过**四种**触发方式（静态/动态 import、被 spawn、CLI 自调用守卫、脚本按路径跑） | ⚠️ **不能**从"零 import"推出"该补一个 import"——其中升级链是**刻意**不接的（§3 阶段 B′）。这份清单是**读数**，不是待办 |

## 7. 复跑方法

```bash
# 全量门禁
node scripts/ci/run-ci.mjs

# 本轮新增/相关的六组（合计 260 例）
node --test runtime/employee/role-pack.test.mjs team-hub/role-pack-store.test.mjs team-hub/role-pack-http.test.mjs
node --test runtime/experience/friction.test.mjs runtime/experience/graph.test.mjs team-hub/experience-store.test.mjs team-hub/experience-http.test.mjs
node --test runtime/connectors/registry.test.mjs team-hub/connector-store.test.mjs team-hub/connector-http.test.mjs
node --test runtime/dsh-composition/production-scope-wiring.test.mjs
node --test team-hub/tool-call-log.test.mjs team-hub/tool-call-http.test.mjs

# 账与门禁自身
node --test scripts/prt/progress-check.test.mjs

# 契约基线 / 拓扑清单（新增表或路由后必须刷新）
node scripts/prt/baseline-snapshot.mjs --diff
node scripts/prt/topology-inventory.mjs --diff
node scripts/config/scan.mjs --check
```

★ **`--only test` 今天整体仍是 FAIL，唯一失败的是 `config` 组，且与本轮无关**：
它报的未处理字面量恰好是**同一工作树上另一个 agent 进程**正在改的文件的
（`RUNTIME_HOST_REGISTRAR_IDENTITY_UNREADABLE` 等，落点 `runtime/dsh-composition/plugins/`、
`product/launcher/*`、`runtime/{contracts,dsh-composition}/run-identity.mjs`，均为该进程未提交/未跟踪的文件）。
把本轮的文件 `git add` 之后重跑 `scan --check`，输出为「✔ 全部读取点、字面量与动态读取已在 schema 中处理」。

## 8. 结论

**"任务全部完成"这句话需要限定，而限定本身就是本轮最重要的交付之一。**

- 清单里**可以在代码侧单独关闭**的：已关闭（F-18 / F-19 / F-21 落地；F-16/F-17/F-20 等前序批次已在）。
- 清单里**代码侧关不掉的**：**16 条**，全部指向人、机器、时间或真实用户（§5）。
- 以及**三条不在清单里**的真实缺口，都是同一族（"模块全绿、而生产里没接"）：
  1. 三道范围检查在生产里从未跑过（§3.4）；
  2. `tool_calls` 从来没有被建起来过、就绪判据没有产出者（§3 阶段 B 第 4 条）；
  3. 阶段 9 一批产品动作模块没有入口（§3 阶段 B′）。
  前两条中能被代码单独关闭的部分**已经关掉了**；剩下的都收敛到**同一个决定**
  （"执行面的载荷里今天没有这些字段"）与**同一个产品问题**（"这些动作由谁触发"）。

★ 还有一条**反向**的结论，它比缺口本身更值得记住：系统盘点里 14 个"零生产入口"的模块中，
**有一个不是缺口**——升级执行链被 `runtime-install.mjs` **刻意**排除在 Launcher 之外，
理由是进程卫生（Launcher 要在那些依赖起来之前先把进程看好）。
所以那份清单是**读数，不是待办**。详见 §5.3。

> 一份把"有用例"读成"已生效"的进度表，
> 与一份把未完成读成完成的进度表，是同一个东西。
> 本轮的每一次改动都尽量落在同一侧：**宁可记 🟡 并写清缺哪一条，也不让读数比事实好看。**
>
> 而这一轮又补了半句：**"零调用方"也一样**——
> 它既可能是漏接，也可能是**刻意留着的**，而两者在读数上是同一个东西。
> 报出读数，然后去读代码里的理由。

---

## 9. 第四轮补记（2026-09-17 续）：可达性探针 —— 把"到不了"变成可复跑读数

**提交**：`55a7af6`（探针 + 门禁 + 基线）、`a6343a5`（`evidenceFrom` 那条纪律）。
前置：本轮开头还有 `c7ef934`（记下 `prt-churn` 偶发红的机制）。

### 9.1 为什么在"功能已完成"之后还要做这一件

到第三轮为止，25 条 F-xx 里剩的 🟡/⏸ **全部**指向产品裁决或外部输入
（F-04/09/11/22/24 的缺项、F-23/25 的产品决定、PRT-316 的排期）。
台账 145 行是 138 ✅ / 4 🟡 / 2 ⏸ / 1 ⬜。

于是本轮去查**判据本身**有没有漏格。结论是有的，而且它在**元层面**：

> 台账与对照表的 ✅ 口径是「有代码落点 + 可复跑的判据」。
> 那条口径里**没有**"这个落点在生产里到得了"这一格。

§5.2 与 §5.3 都是**逐个模块**数的（"它有几个非测试导入者"）。那个读数有一个
**传递**盲点：

> `runtime/packs/store.mjs`（PRT-1003 安装/启用/停用/升级记录，**✅**）
> 有 **1** 个非测试导入者 ⇒ 在"有几个导入者"这个读数上它是**活的**。
> 而那 1 个是 `runtime/packs/builtin/software-delivery.mjs`，它有 **0** 个导入者。
>
> **一个「唯一的导入者也是死的」的模块，
> 与一个「真的有人在用」的模块，在"有几个非测试导入者"上是同一个东西。**

### 9.2 读数

513 个 `.mjs`（不含用例）里 **48 个**从任何生产入口都到不了。
by-design 13 / deliberate 8 / in-flight 5 / **gap 22**。

**★★ 最要紧的一条：F-18 与 F-19 的"执行面一半"全都到不了。**

| 模块 | 台账 | 现实 |
|---|---|---|
| `runtime/experience/friction.mjs`（487 行） | F-18 ✅ | 只被自己的用例驱动 ⇒ 生产里**没有算过一个摩擦分** |
| `runtime/experience/graph.mjs` | F-18 ✅ | **没有记过一条边** |
| `runtime/employee/role-pack.mjs`（756 行） | F-19 ✅ | **没有建出或校验过一个岗位包** |

★ 这**不是**说 hub 侧没接：`experience-store` / `role-pack-store` 经 `server.mjs`
**是**可达的。缺的是**产出者**——账和读面都在，而**没有任何东西往里面写**。
与 PRT-610 同一种形状（"表建好了、能读，而一条记录都不会有"）。

★ 本轮**没有**改这三行的 ✅/🟡。台账 §0 自己的告警写着
「只有自己的用例驱动的原语一律 🟡」，与这三行的 ✅ **口径不一致**——
但"改状态"与"补证据"是两件事，口径由台账的读者（项目方）定。
已作为 §5 第 18 条汇总。

### 9.3 ★★ 三条过程教训，都是"探针自己坏了"

**① 漏一种入口 = 把正在跑的进程报成死代码。** 第一版只认
「进程入口 / `scripts/` / `package.json`」，于是 `product/orchestrator/worker.mjs`
被报成不可达——而 `product/process-manifest.mjs` 明写着
`entry: {kind:'node-file', path:…}`，**Launcher 真的会把它 spawn 起来**；
全部 `plugins/*-row.mjs` 也被报成死代码——它们由 `patch-layer.mjs` 的
`module:` / `runtimeModule:` **字符串**加载。

> 一个「漏了一种入口」的探针，
> 与一个「那个模块真的没人用」的探针，在输出上是同一个东西——
> 只不过前者会把**正在跑的进程**报成死代码。

同一类错犯了**两次**：先只按**仓库相对**解析清单路径（漏了 `./` 开头的），
再只按**文件相对**解析（漏了仓库相对的）。两种约定**同时存在**于同一类清单里。

**② ★★ 把用例算成入口，整个探针当场反转。** 第二版为"`scripts/` 下的都算入口"
顺手把 `*.test.mjs` 也加了进去，于是**每一个只被自己用例 import 的模块都变成可达**——
恰好就是本探针要查的那一类。读数从 48 掉到 **0**，而**报告看起来一切正常**
（"与基线一致"）。

> 一个「把用例也算成入口」的可达性探针，
> 与一个「什么都没查」的探针，在输出上是同一个东西。

**③ ★★ `evidenceFrom:` 是存在性断言，不是加载指令。** 为了防下一次"顺手加一种入口"，
专门写了用例 ⑥：`product/release/checklist.mjs` 里
`evidenceFrom: 'product/diagnostics/crash-report.mjs'` 的消费者只做
`existsSync(join(REPO, p))`……加进 `MANIFEST_PATTERNS` 会让 **8 个**模块**假**报成可达。

> 一个「把它当成入口声明」的探针，
> 与一个「那些模块真的被用上了」的探针，在输出上是同一个东西——
> 只不过前者会把**"存在"读成"在用"**。

### 9.4 判据与变异

门禁 6 例，**变异 11/11 成立**（10 处咬住 + 1 处等价变异如期不红）：
`resolveSpec` 空转 / 不认清单的仓库相对路径 / 不认 `module:` 键 /
★ 用例算成入口 / 新建没人 import 的模块 / 基线塞不存在的文件 /
★ 把 `path-scope` 接上（读数用例红）/ class 越词表 / reason 清空 /
★ `evidenceFrom` 当入口 / 只改注释。

### 9.5 ★ 一条刻意的取舍：基线过期**不判红**

模块**变成可达**（基线过期）只报警、不判红——那是好消息。

> 一个「把别人正在接线的好消息判成回归」的闸门，
> 与一个「逼着人把好消息 `--record` 确认一遍」的闸门，是同一个东西——
> 只不过前者会在**共享工作树上天天红**。

新增不可达（新的"到不了"）仍然判红——那才是本探针要挡的方向。

### 9.6 诚实边界

- **本探针不新增任何功能**，它只把"到不了"变成**可复跑读数**（48 条，逐条带分类与理由）。
- 它的价值是**防退化**：那 22 条 `gap` 从此不会悄悄变多。
- 它**没有**回答"这些 gap 该不该接"——那是 §5 第 14/15/16/17/18 条要项目方裁决的。
- `in-flight` 那 5 条依赖**另一个 agent 进程**当轮未提交的工作，本轮只记录读数。
- 一致性：`--diff` 与基线一致；`syntax`/`boundary`/`deps`/`doc` 全 PASS；
  契约基线与拓扑清单**零漂移**；`--only test` 里本组 6/6 PASS。
  ★ 全量 `--only test` 仍只在 daemon 的 `config` 组红
  （`actual: ['RUNTIME_HOST_REGISTRAR_IDENTITY_UNREADABLE']` 等未登记字面量），与本轮无关。

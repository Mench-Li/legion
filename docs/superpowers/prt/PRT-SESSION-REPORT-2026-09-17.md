# 本轮交付报告 —— F-01～F-25 在 Legion→DSH 架构上的落地

> 日期：2026-09-17 ｜ 依据：[`MULTI-AGENT-FEATURE-OPTIMIZATION.md`](../../MULTI-AGENT-FEATURE-OPTIMIZATION.md) 的 §5 执行顺序
> 对照表：[`MULTI-AGENT-FEATURE-STATUS.md`](../../MULTI-AGENT-FEATURE-STATUS.md) ｜ 权威台账：[`superpowers/prt/PRT-PROGRESS.md`](./PRT-PROGRESS.md)
>
> **结论先说**：优化清单里**可以在代码侧单独完成的部分已经做完了**；
> 剩下的每一条都指向一个**代码之外的决定**（产品裁决、另一台机器、真实用户、排期日期），
> 或指向另一个 agent 进程**当轮正持着未提交改动**的文件。
> ★ **续批（§10）把这件事收得更紧了**：第 13/14/15/18 条其实是**一条**决定
> （执行面需要的数据进不进 `RunRequest`），而这个问题**已经有两个跑通的答案**。
> 详见 §5 的 **19** 条人工介入清单与 §10.5。
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
| `f291f9c` | **§10 续批**：PRT-214 缺口② 授权身份按 Run 生效 / PRT-251 续 旧库接管 + `ports.runtime` 到达 DSH / PRT-253 续 `LEGION_WORKSPACE_DIR` | 28 文件 **+4046/−215**；`run-identity` 20 例、`legacy-data-adoption` 15 例；**变异 ⑪–⑰ 7/7、㉑–㉖ 6/6、⑱–⑳ 3/3** |

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
| **19** | ★★★ **第 13/14/15/18 条其实是**一条**决定**（续批新读数，见 §5.5） | 项目主 + 产品（**只需回答一个问题**） | 三条机器读数把它钉死了：① **`runtime` 进程故意没有 `TEAM_HUB_TOKEN`**（`product/process-manifest.mjs:203-215`——只有 `TEAM_HUB_URL` 这个地址；漏声明会被 `buildChildEnv()` 直接抛，所以这是刻意的）；② **`RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`**，没有范围表、没有 host surface（`runtime/contracts/run.mjs:158-181`）；③ **`runtime/packs/*` 零生产入口**（`store`/`compiled-plan`/`authority` 的唯一 import 者是 `builtin/software-delivery.mjs`，而它**零 import 者**；`createPackStore` 生产调用点 **0 处**，hub 的 `/api/packs/account` 把账交出去而**没人接住**）。**要回答的只有一个问题**：把执行面需要的数据（连接器声明 / 范围表 / 落账端点 / 摩擦与岗位包的输入）放进 `RunRequest`，**还是**给执行面开一个控制面入口（注入 `TEAM_HUB_TOKEN`）？★★ 前者**已经有先例，而且跑通了两遍**（PRT-214 缺口①`enforcementFloor`、缺口②`enforcementIdentity`：专属线上字段 → 按 Run 安装 → 对象身份配对 → 可 `dispose()` → 装不上具名拒绝），照抄是纯代码工作量；后者会让 spec §2「Runtime 不看业务状态」那条不可突破边界消失，而且执行面一旦有 token，"读声明"与"改状态"只差一次调用。★★ 本轮**没有**擅自补接线：`RunRequest` 里没有范围表字段，凭空造一份（"读根=写根=`workdir`"）正是 PRT-253 §3 禁止的"发明默认值"，且方向是**放行**——而"反正它更严"这个辩护**不成立**，收成 `workdir` 会同时拒掉合法的越目录读，表现成"工具莫名其妙失败" |

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
- 清单里**代码侧关不掉的**：**19 条**，全部指向人、机器、时间或真实用户（§5）。
  ★ 其中第 **19** 条是续批新加的：它把第 13/14/15/18 条**收成一条**决定，
  所以"19 条"里**真正要回答的问题比条数少**——详见 §10.5。
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

---

## 10 续批（2026-09-17 下午）：把上一批的收尾做完，并回答"为什么剩下的不是代码问题"

> 本节是**续批**记录。上一批把三条缺口的代码写完了，却把工作树留在
> **未提交**状态（另一个 agent 进程当轮持着文件）。续批做三件事：
> ① 把那一批**验证后提交**；② 修掉它留下的一处**门禁红**，
> 并且在这一步咬出**一个真缺陷**；③ 把人工介入清单里
> 第 13/14/15/18 条**收成一条**读得出的架构事实。

### 10.1 提交 `f291f9c`（三条缺口一起落库）

上一批的文件在工作树里、**没有提交**。续批先做核对，再提交：

| 步骤 | 读数 |
|---|---|
| 六套相关用例在提交前跑过 | `run-identity` **20/20**、`legacy-data-adoption` + `runtime-contract-wiring` **26/26**、registrar + run-inputs **78/78** |
| 端到端探针 | `scratch/probe-identity-loop.mjs`：租约的空间名一路走到授权哈希，两个空间得到**两个不同的 `canonicalHash`** |
| 破坏性验证 | ⑪–⑰ **5/6**（⑩ 那条见 §10.3）、㉑–㉖ **6/6**、⑱–⑳ **3/3** |

提交 `f291f9c`：**28 个文件、+4046 / −215**。

★ **提交前的一处必要性处理**：`scrum/daemon-ozon.json` 是守护进程**每次心跳都在写**的
文件（`lastSweepAt` / `uptimeMs`），把它卷进这次提交等于让每一个提交都带上
"提交那一刻这个守护跑了多久"。已从暂存区移出，**没进**这个提交。

### 10.2 ★★★ 破坏性验证 harness 被中途杀掉，留下一个**已变异的靶文件**

`scratch/mutate.mjs` 的 ①–⑨ 那一跑被外部超时**在 ⑩ 处杀掉**
（实测：`MUTATE_ONLY=⑩` 单独跑也会超时——它要起真子进程，一条就超过 120s 窗口）。
而 `mutate.mjs` 的还原写在"跑完之后"，于是 `product/process-manifest.mjs`
**停在"已变异"状态**：`LEGION_WORKSPACE_DIR` 那一行声明**整个消失**。

紧接着的批量 `git add -A` 把那个状态**收进了索引**——也就是说，
`f291f9c` 的**第一版暂存内容**里，PRT-253 续批五那个修复是**缺失**的，
而我自己在几个工具调用之前刚把它当成"已交付"读过一遍。

抓到它的方式是**继续跑那条变异**：⑩ 报 `锚点没找到，跳过`。

> 一条"锚点没找到"的破坏性验证，读起来像"这条性质没被守住"；
> 而实情是**靶子被人拿走了**——只不过拿走它的是上一条被中断的验证。
> 而 `git status` 对这两种处境**完全沉默**：它只知道有个文件变了。

**处置**：按文档 §10 复原那一行，`git checkout` 复核，再单独复跑一次确认
（见 §10.3）。★ 过程教训记在这里而不是只写在提交信息里，因为
**这是这套 harness 的一个真实失效模式**：`mutate.mjs` 的还原是
"跑完之后"而不是"无论如何"，所以**任何**中断（超时、杀进程、Ctrl+C）
都会留下一个改过的源码文件，而它下一步会被 `git add -A` 收走。

### 10.3 复核 ⑩（那条被中断的变异）——**在隔离 worktree 里跑**

不敢再在共享工作树上动那个文件（另一个 agent 进程正在改它），
所以用 `git worktree add --detach _verify-f291f9c f291f9c` 开了一棵
**只含这次提交**的树来跑：

```bash
node scratch/verify-commit-f291f9c.mjs     # 基线 → 变异 → 还原，全程在隔离树里
```

读数：

| 阶段 | 结果 |
|---|---|
| 基线（未变异） | `tests 1 / pass 1 / fail 0` —— ①b′ 绿 |
| 变异 ⑩（删掉 `'LEGION_WORKSPACE_DIR',` 声明） | **✖ ①b′ 变红**（`Launcher 把 LEGION_WORKSPACE_DIR 交给 worker`） |
| 还原 | `restored identical = true`（逐字节） |

★ 所以 ⑩ **咬住**，而它的期望靶子就是 ①b′——与 `mutate.mjs` 里写的 `expect` 一致。
（`mutate.mjs` 自己的汇总把这一条读成"没咬住"，只是因为它的判据锚在
`ℹ fail N` 上，而 `--test-name-pattern` 把输出收成一条用例后没有那一行；
这不影响"①b′ 确实红了"这个读数。）

### 10.4 修门禁：21 条字面量未登记，而其中一条**不该被登记**

上一批没有登记新字面量，所以 `scan --check` 是红的，`config` 组两条用例跟着红。
登记完之后（`runtime/` 11 条 + `product/` 10 条）门禁转绿。

★ 但**第一版登记里有一条是错的**，而且错的方式值得单独写下来：

`product/launcher/launcher.mjs` 当时写着

```js
code: `LEGACY_ADOPTION_${String(adoptionReading?.state ?? 'RUNNING').toUpperCase()}`
```

而那个回调是在 `runLegacyAdoption()` **运行期间**触发的——
`adoptionReading` 在那一刻**必然是 `undefined`**（它正是被这次调用的返回值赋值的）。
于是逐项那几行**每一行**都叫 `LEGACY_ADOPTION_RUNNING`：一项接管成功、一项失败，
码完全一样。

门禁报的是"`RUNNING` 未登记"。我照着报错把它登记成**一个"进度态"**，
还在注释里替它写了一段理由（"它表达的是'还没有状态'"）。

**这是把门禁从"发现了一个错误码"变成了"给这个错误盖章"**：

> 登记一条字面量之前必须先问**它是不是对的**；
> 一个"照着报错把缺陷登记成有意的设计"的处置，
> 与一个"根本没有这道门禁"的处置，在文件里的读数上是同一个东西——
> 只不过前者把那个缺陷变成了**有文档背书的**缺陷。

**改正**：`RUNNING` 不登记，换成 `LEGACY_ADOPTION_ITEM`，并把上面这段历史
连同"为什么"写进 `product/config-schema.mjs` 的注释里（§10.5 的读数来自
另一个 agent 进程的同一批修复——它把那个恒为 `RUNNING` 的码换成了
不带总体状态的 `LEGACY_ADOPTION_ITEM`）。

> ★ 顺带一条本轮的诚实边界：**上面这个修正是与另一个 agent 进程协同的结果**。
> 它改了 `launcher.mjs`（我**没有**碰那个文件），我改的是 `config-schema.mjs`
> 里的登记与注释。所以 `LEGACY_ADOPTION_ITEM` 这一条**在当前工作树上是绿的，
> 但它依赖尚未提交的那份改动**——这也是我**没有**单独把 `config-schema.mjs`
> 提交出去的原因：那样提交出来的快照里，这个字面量在源码中**不存在**，
> 而 `scan` 自己的判据写着「多一条是编造，少一条是漏登」。

### 10.5 ★★★ 新读数：第 13/14/15/18 条是**一条**决定（详见 STATUS §5.5）

三条机器读数：

| # | 读数 | 坐标 |
|---|---|---|
| ① | `runtime` 进程的 `envNames` **故意没有 `TEAM_HUB_TOKEN`**（只有 `TEAM_HUB_URL` 这个地址） | `product/process-manifest.mjs:203-215` |
| ② | `RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`——没有范围表、没有 host surface | `runtime/contracts/run.mjs:158-181` |
| ③ | `runtime/packs/*` 四个模块**零生产入口**；`createPackStore` 生产调用点 **0 处** | 可达性探针 §5.4 + `grep` |

读数 ① 是最要紧的一条，因为它把"漏了一个环境变量"与"刻意的边界"分开了：
`buildChildEnv()` 对**未声明**的键直接抛（PRT-253 续批四实测过），
所以 `TEAM_HUB_TOKEN` 不在 `runtime` 的清单里**不是漏写**——
它是「Runtime 不看业务状态」这条 spec §2 不可突破边界的**实现方式**。

于是这四处（F-21 判定面、三道范围表、PRT-610 落账点、F-18/F-19 执行面一半）
**不是四个问题**，而是同一个问题的四个面：
**执行面需要的数据进不进 `RunRequest`。** 而这个问题**已经有两个跑通的答案**：
PRT-214 缺口① 的 `enforcementFloor` 与缺口② 的 `enforcementIdentity`——
专属线上字段 → 按 Run 安装 → 对象身份配对 → 可 `dispose()` → 装不上具名拒绝。

★ 本轮**没有**替它们接线，理由见 STATUS §5.5 末段（凭空造范围表是
PRT-253 §3 明禁的"发明默认值"，且方向是放行）。

### 10.6 本轮判据（可复跑）

```bash
node --test runtime/dsh-composition/run-identity.test.mjs                    # 20/20
node --test product/launcher/legacy-data-adoption.test.mjs \
            product/launcher/runtime-contract-wiring.test.mjs                # 26/26
node --test product/launcher/runtime-manifest.test.mjs                       # 9/9
node --test scripts/config/config.test.mjs                                   # 52/52（修前 50/52）
node scratch/probe-identity-loop.mjs                                         # 两空间两哈希
node scripts/config/scan.mjs --check                                         # PASS（1129 条）
node scripts/prt/reachability.mjs --diff                                     # 与基线一致（46 条）
node scratch/verify-reachability-entry.mjs                                   # 破验 2/2 咬住、还原逐字节一致
node scratch/verify-credential-resolver.mjs                                  # 破验 ㉙ 咬住、还原逐字节一致
node scratch/probe-real-declaration-chain.mjs                                # 真 DSH：解析 → 声明 ['DEEPSEEK_API_KEY']
node scripts/prt/progress-check.mjs ; node scripts/prt/spec-progress.mjs --check
```

CI（隔离 worktree 内全量 `run-ci.mjs`，提交 `f291f9c`）：

| 阶段 | 结果 |
|---|---|
| syntax / env / boundary / deps / build / smoke / stage / doc | **PASS**（`env` 由红转绿：修前 `4 项未在 schema 中处理`，修后 PASS） |
| test | 只剩两处，**都只在隔离 worktree 里红、主树全绿**（见下） |

★ 那两处**不是回归**，是"隔离 worktree 缺构建产物"：
`product-launcher` 的 `runtime-manifest` 用例读 `releases/*/MANIFEST.json`
（主树 8 份、worktree 只有本次 `stage` 刚生成的那 1 份）；
`p13-host-injection` 要 `team-hub/lib/index.js`（**未跟踪的构建产物**，
主树有、worktree 没有）。主树单独复跑：`runtime-manifest` **9/9**、
`p13` 两套件 **39/39**。

> 一个"干净检出里必红"的用例，与一个"真的坏了"的用例，
> 在 CI 输出里是同一行 `FAIL`——只不过前者的修法是
> **在跑之前把产物建出来**。这与台账里 PRT-707 那条
> "该套件只能在本机恰好残留 `lib/` 时通过"是同一类记录。

### 10.7 ★★ 第一处功能代码改动：可达性探针的一处假阳性

上一节的结论是"剩下的都要人裁决"。收尾核对那 22 条 `gap` 时，
发现了**一条不属于任何裁决**的——它根本不是缺口，是**探针报错了**。

`packages/shared/src/artifact-policy.mjs` 被列成
`[gap] 只被自己的用例 import（产物路径规范化）`。而它**有两个真实消费者**：

```text
scrum/serve.mjs:38          import { normalizeArtifactPath } from '../packages/shared/src/artifact-policy.mjs'
board-plugin/src/index.ts:18 同一个模块（编成 board-plugin/lib/index.js，**未跟踪产物**，import 图扫不到）
```

根因是**两层叠加**，缺一层都不会出这个读数：

| 层 | 事实 |
|---|---|
| 扫不到 | `scrum/` **整个目录不在 `SCAN_DIRS` 里** |
| 认不出 | 即使扫到，`scrum/serve.mjs` 也不匹配任何一条入口规则（它既不 `scripts/` 开头、也不含 `/scripts/`，而 `PROCESS_ENTRIES` 里没有它） |

**权威来源不是猜的**：`scripts/ci/run-ci.mjs:3748` 的 `tracked` 清单
（stage 阶段算 `SHA256SUMS.txt` 的那一份）逐字列着 `scrum/serve.mjs`
——也就是说，**打包发布的人一直知道它是要按路径跑的那个文件**。

> 一个"把在跑的服务报成死代码"的探针，
> 比一个"什么都没查"的探针更坏——因为**它的结论会被当成读数用**，
> 而读的人会去查那个服务。

**修法**（三处，都在 `scripts/prt/`）：

| 改动 | 内容 |
|---|---|
| `SCAN_DIRS` | 收 `scrum`（并写明它与被排除的旧 GUI `workbench/` **不是同一个情况**：`scrum/` 是 v1 看板服务本体，`tests/contract/v1v2-contract.test.mjs` 把它当契约面在测） |
| `PROCESS_ENTRIES` | 收 `scrum/serve.mjs`，以及它**按路径 `spawn`** 的两个子进程 `scrum/taskctl.mjs`（`serve.mjs:153`）与 `scrum/render.mjs`（`:176`）——它们**不可能**出现在任何 import 图里 |
| `reachability.test.mjs` ①-5 | 新增正对照钉住这一族（同 ①-3 的理由：**每一类入口写法各要一条对照**，因为实测已经漏过两种） |

读数变化：

```text
改前  513 个 .mjs；入口 52 个；可达 211 个；不可达 47 个   by-design=12 gap=22 deliberate=8 in-flight=5
改后  518 个 .mjs；入口 55 个；可达 215 个；不可达 46 个   by-design=12 gap=21 deliberate=8 in-flight=5
```

**唯一的一条变化就是那处假阳性消失**（`artifact-policy.mjs` 从 `gap` 变成可达），
没有任何新模块变成不可达——也就是说 `scrum/` 收进来之后，
那个目录里的模块本来就都是活的。

破坏性验证 **2/2 咬住**（`scratch/verify-reachability-entry.mjs`）：

| # | 变异 | 结果 |
|---|---|---|
| ㉗ | 从 `PROCESS_ENTRIES` 删掉 `scrum/serve.mjs` | ✔ 红 **3** 条（① / ② / ⑤） |
| ㉘ | 从 `SCAN_DIRS` 删掉 `scrum` | ✔ 红 **3** 条（同上） |

★ 这个 harness **刻意不复用** `scratch/mutate.mjs`：那个文件的还原写在
"跑完之后"，而本轮已经实测过它的失效模式（§10.2——被超时杀掉，靶文件留在
"已变异"状态，随后被 `git add -A` 收进索引）。这里的还原写在 `finally` 里，
**从"跑完之后"改成"无论如何"**，并把"还原逐字节一致"也打印出来当读数。

### 10.8 ★★★ 第二处、也是更要紧的一处：自动映射在生产里恒不工作

§10.7 那处是**探针**误报（产品是好的）。这一处相反：**产品真的坏了**，
而所有既有判据都是绿的。

#### 缺口挂在台账上，但被记成了"边界"而不是"未验证的假设"

`docs/superpowers/prt/PRT-PROGRESS.md` 的 PRT-509 行末尾一直写着三条 🟡，其中第 ② 条是：

> ② **生产默认句柄工厂**（走 `resolveDshBaseBundlePatchPath` 解析器那条路）
> **只有注入式覆盖**，真实调用没跑过

这一句读起来像一条**诚实的保留**——"我们知道这里没验证过"。而它不是：
**真实调用不是"没跑过"，是跑不了**。这两件事在台账上写成同一句话，
但一个是"待补验证"，另一个是**恒失效的接线**。

> 一个「只有注入式覆盖 ⇒ 真实调用没跑过」的记录，
> 与一个「生产里恒不工作」的记录，在台账上是同一句话——
> 只不过前者等的是一次验证，而后者等的是一次修复。

#### 那处缺陷本身

`resolveDshBaseBundlePatchPath()` 里写着（`product/launcher/run-credential-materialization.mjs`）：

```js
const usable = (r) => r !== null && typeof r === 'object' && typeof r.resolve === 'function'
```

而**生产走的是不注入那条路**，它拿到的 `req = createRequire(entry)` 是一个**函数**：

```text
typeof createRequire(entry)          = 'function'   ← 不是 'object'
typeof createRequire(entry).resolve  = 'function'
usable() per 旧判据                   = false        ← 被当成"没注入"
```

于是 `return null` → 调用方翻成 `DSH_DECLARATION_UNLOCATABLE` → 覆盖层退回**空操作**。
**自动映射这条路在生产里一次都没有成功过**，而它的读数是一条看起来完全正常的具名降级。

★ 而这行代码**上面三行就是一段注释**，逐字写着要防的正是这一类错误：

```js
// 判据按"有没有那个方法"来，而不是按"是不是函数"：一个按后者写的判据会把
// 所有以对象形状注入的替代实现（用例最自然的注入形状）当成"没注入"……
```

**注释防的是"按是不是函数来判"，实现加的是"必须是对象"**——同一个错误的镜像，
而后者的后果更重（前者会把用例的注入形状判错，后者会把**生产**的形状判错）。

#### 为什么用例看不见：注入的形状与生产拿到的形状**不是同一个**

| 形状 | 来源 | 旧判据 |
|---|---|---|
| `{ resolve }`（对象） | **只有用例** | ✅ 通过 |
| 函数带 `.resolve` | **只有生产** | ❌ 被当成"没注入" |

> 一个"只在用例注入的那个形状下能跑"的解析器，
> 与一个"在生产里恒不工作"的解析器，是同一个东西——
> 只不过前者的用例是绿的，而绿的理由恰恰是
> **用例注入的形状与生产拿到的形状不是同一个**。

#### 修法与实测

判据收成一句：**有 `.resolve` 就能用**（对象或函数都行）。
新增用例**必须用函数**钉（用对象再测一遍是重复，而重复正是原缺陷藏身的方式），
外加两条反向（函数但无 `.resolve` ⇒ 仍不可用；字符串 ⇒ 不可用）。

真 DSH 检出上的实测（`scratch/probe-patch-resolution-precise.mjs` /
`scratch/probe-real-declaration-chain.mjs`，入口 `apps/cli/lib/bin.js`，
即 DSH 自己的 `package.json` 里 `bin.dsh` 指的那个文件）：

| 步骤 | 修前 | 修后 |
|---|---|---|
| 生产函数（**不注入任何东西**） | `null` | `…\packages\bundle\base\cordis.patch.yml` |
| 读回 `apiKeyEnv` 声明 | （走不到） | `['DEEPSEEK_API_KEY']`（20193 字节） |
| 对照：`createRequire(entry).resolve(…)` | 解析得到 | 解析得到 |

破坏性验证 **㉙ 咬住**：把判据还原成"必须是对象" ⇒ 新增那条用例**精确变红**；
还原后与提交版**逐字节相同**。

★★ 这一步还咬出了 harness 自己的一个坑：第一版变异脚本报"**没咬住**"，
而真相是**锚点锚到了注释上**——那段注释里逐字抄了一遍旧代码，于是脚本改的是注释，
真代码一个字没动。

> 一条"改了注释所以行为不变"的变异，
> 与一条"靶子根本没被改到"的变异，在读数上是同一个"没咬住"——
> 只不过前者的结论是"这段代码没有对应判据"，而后者是"我的锚点写错了"。

修法是把锚点钉在新代码**独有**的那半句上（`r !== null && r !== undefined`），
注释里抄的是 `typeof r === 'object'`，两者再也匹配不到一起。

### 10.9 ★★ 交接事实：**当前工作树是红的**，而红的原因不是本轮的提交

收尾时在主工作树上跑 `product-launcher` 那一组，红了 3 条（另加那条
worktree 产物导致的 `MANIFEST.json`）：`enforcement-identity` 的
「PRT-214 续 Legion 身份：接进 Launcher 的三态」、`launcher.test.mjs` 的
「envSurface：跨进程接线是**派生**的」与「真实进程：team-hub + workbench
按波次启动并经身份断言就绪」。

**这不是本轮的回归。** 判据是：在提交 `9bb4f7f` 上开一棵隔离 worktree
（`.worktrees/_verify-defects`，`git worktree add --detach`，并把
`team-hub/lib` 这份**未跟踪构建产物**复制进去——见 §10.6），复跑同两组：

| 组 | 隔离 worktree @ `9bb4f7f` | 主工作树（含别人未提交的改动） |
|---|---|---|
| `enforcement-identity.test.mjs` | **22/22** | ✖ |
| `launcher.test.mjs` | **34/34** | ✖（2 条） |
| 整组 20 套件 | **382/386**（1 红是产物、3 skip） | 至少 4 红 |

原因是**另一个 agent 进程当下正持着三个承重文件的未提交改动**：

```text
product/launcher/readiness.mjs        +322 / −
product/launcher/launcher.mjs         +130 / −
product/process-manifest.mjs          +159 / −
```

（`git status` 显示这三个是 M；它们改的是**就绪判据**——从 HTTP 探测改成
stdout 上那行 `dsh web: <url>`——而上面那 3 条失败的用例恰好都在验
"按波次启动并就绪"。本轮**没有**碰这三个文件。）

★ 记这一条不是为了归因，是为了**交接**：

> 一个"当前树是红的、而它红的原因在别人手里"的状态，
> 与一个"当前树是红的、原因不明"的状态，对下一个人来说是两件事——
> 只不过 `git status` 对这两者完全沉默（它只知道有文件变了）。

所以下一个人跑 CI 时看到 `product-launcher` 红，应当先跑
`git status -- product/launcher product/process-manifest.mjs`：
如果那三个文件是 M，红就在那边，不在 `9bb4f7f`。

### 10.10 ★★★ 第三批：门禁自己的两处缺陷（这一批影响面最大）

§10.7/§10.8 修的是**功能代码**。这一批修的是**门禁**——两处都不是"某个模块写错了"，
而是"那把尺子量错了"。它们的共同形状是：**注释里写着的事，实现里从来没做**。

#### ① 跳过了多少条断言，摘要里一个字都没有（影响整条 CI）

`run-ci.mjs` 有**四处**注释写着「`skipped: N` 看得见」，而 `counts` 只解析了
`tests`/`pass`/`fail`——`skipped` **从来没被解析过**。

| | 修之前 | 修之后 |
|---|---|---|
| 摘要行 | `tests=38 pass=18 fail=0` | `tests=38 pass=18 fail=0 skipped=20` |
| SUMMARY | `test PASS` | `test PASS  ⚠ skipped=232` |
| `summary.json` | 无跳过字段 | `skippedTotal: 232` |

实测（本机 `DSH_CHECKOUT` 未设，而 DSH 检出**完整地在盘上**）：四个真进程套件
38 条断言跳过 20 条，而 CI 报全绿。修好后同一次 `--only test` 的读数是
**232 条跳过**，其中 `runtime-contract-cross-process` 是 **19 条全跳**
（`pass=0`）、`dsh-credentials` 是 **72 条跳过**。

★ 跳过**刻意不判红**：合法跳过有三种（缺 DSH、posix 上跑不了 win32 分支、
没有浏览器），判红会用"所有没装 DSH 的机器 CI 全红"换一个小得多的故障。
它做的是**变成读数**。破坏性验证 `scratch/verify-skip-visibility.mjs` **5/5 咬住**。

#### ② `prt-churn` 的窗口计数在合并历史上**两个方向都错**

探针用 `<oldest>^..<newest> -- <file>` 数"窗口里几个提交碰了该文件"。
`A^..B` 的语义是「B 可达且 A^ 不可达」——**合并提交的第二个父亲能带进来一大批
不在窗口里的提交**（本仓 101 个合并提交）。窗口 1 有 40 个提交，区间里有 **217** 个。

```text
窗口 1  plugins/src/index.ts   区间 9  / 精确 1     ← 多算 9 倍
窗口 1  team-hub/server.mjs    区间 41 / 精确 9     ← 超过窗口大小
窗口 6  team-hub/server.mjs    区间 9  / 精确 10    ← 这个方向又少算
```

**多算那一侧正是这个探针文件头警告过的事**：*一个会把「该开工」读成
「不能开工」的测量方法，比没有测量更糟*。而它这次的假红给出的诊断是
「可能又改成错误写法了」——把**测量方法的缺陷**说成了**实现回归**。

★★ 这一批真正的教训在 `docs/MULTI-AGENT-FEATURE-STATUS.md` §6.1：
这条红**前一天被同一条指纹判成了"瞬时针争、可以忽略"**。
当时的记录写着 *「③ 的两条用例（不是一条、也不是十三条）同时红，正是前者的指纹」*
与 *「`max=14/40`，离阈值很远，所以③报出『计数 > 窗口大小』是**不可能的**」*。
**两句都错了**，而那个 14 也是同一把坏尺子量的。

> 一个用**坏掉的探针**量出来的"离阈值很远"，
> 与一份真正的余量，在文档上是同一个句子——
> 只不过前者的作用是**教下一个人把真红当成噪声**。

修这条时**第一版修法也是错的**：改成 `git log --no-walk --stdin -- <file>`，
而 `--no-walk` 把**路径过滤整个关掉**，于是每个格子恒等于窗口大小（两条满格条形图）。
正确写法是让 git 说出每个提交动了哪些文件，**路径过滤自己做**：
`--no-walk --format=%x1f%h --stdin --name-only`。

#### ③ 判定：PRT-316 现在有**两条**条件都没满足

§5 第 9 条此前写着「两个条件里"热点文件争用"那条**已过**（当前 2/40、峰值 14/40）」。
按修正后的探针，当天读数是 `team-hub/server.mjs` **9/40 > 阈值 2** ⇒ **未降温**。

而**当年那次门禁判定没有被污染**——在判定所在的提交 `9bec1e5` 上，
最近窗口的两种写法给出同一个数（plugins 1/1、server 0/0），都 ≤2。
所以在 `PRT-315-slice1-mediation.md` 里**只加注、不改历史表格**。

#### ④ 这一批的判据

| 判据 | 命令 |
|---|---|
| 跳过被解析、逐行可见、汇总成行、进 summary.json、且不判红 | `node --test scripts/ci/skip-visibility.test.mjs`（6 例） |
| 窗口计数逐格等于独立算出的精确值 | `node --test scripts/prt/hot-file-churn.test.mjs`（17 例） |
| 三种错法各自变红 | `node scratch/verify-churn-counting.mjs`（**4/4 咬住**） |
| 跳过可见性五处各自变红 | `node scratch/verify-skip-visibility.mjs`（**5/5 咬住**） |

★ 其中「逐格交叉核对」那一条是**后补的**：补它之前，㊱㊲㊳ 三处变异**一条都不红**——
因为原套件只有「计数 ≤ 窗口大小」这一条约束，而"每次都答窗口大小"满足它。
*一条只写下"不许超过 40"的规矩，管不住"每次都答 40"。*

### 10.12 ★★★ 第四批：修好跳过可见性之后，**第一次读数就抓到一个真回归**

这一条是 §10.10① 的直接回报，单独记，因为它是"把一句话变成读数"这句话的实证。

#### 环境一改，读数就变

```text
DSH_CHECKOUT 未设（默认）：--only test → test PASS，⚠ skipped=232
DSH_CHECKOUT 指向盘上那份检出：--only test → test FAIL，⚠ skipped=1
                                FAIL product-launcher: tests=397 pass=396 fail=1
                                  ✖ ★★★★★ 用 Launcher 拼出的 argv，真 DSH CLI 接受并把行装进组合树（120075ms）
```

**232 条跳过里，有 231 条是真能跑的**——同一批断言在配好环境后 `pass` 了
（例如四个真进程套件单独跑是 **32/32**）。而剩下那一条，是一个**真回归**。

#### 这个回归已经坏了四天，而所有门禁都是绿的

判据（隔离 worktree，把未跟踪的 `team-hub/lib` 复制进去）：

```text
6c65752（2026-09-13 引入这条用例那次）  17/17 全绿   ← 它当年是过的
1d3ee25^ / 1d3ee25                      17/17 全绿
f291f9c^                                17/17 全绿
f291f9c                                 16/17  ✖     ← 首次变红
```

`f291f9c` 是本轮开头落库的那一批（PRT-214/251/253）。`git bisect` 与手工复核一致。

#### 根因：**根选项与 app 选项的段顺序**

DSH 的根部命令用了 `passThroughOptions()`
（`apps/cli/src/args.ts:142`），语义是：**一旦遇到第一个不认识的 token，
从那里往后全都归 app**。而：

| 段 | 旗标 | 谁给的 |
|---|---|---|
| 根 | `--profile <名>`、`--patch <覆盖层>`、`--dump-config` | 用户命令 / Launcher / 用例 |
| app | `--host <值>`、`--port <值>`、`--no-open` | `process-manifest.mjs`（PRT-251 续批新增） |

`f291f9c` 给 argv 末尾补了 `--host`/`--port`/`--no-open`（**产品侧是对的**），
而用例原来是 `[...rt.command.args, '--dump-config']`——把自己的根选项追加在
**app 段之后**，于是 `--dump-config` 被当成 app 参数，DSH **根本没进 dump 模式**，
它去启动 web app 然后一直不退出 ⇒ `spawnSync ETIMEDOUT` / 120s 被杀。

★★ 讽刺的是，**产品代码里逐字论证过同一件事的反面**：

> 把 `--port` 放进 `argsTemplate` 会拼出 `… --port 3081 --patch X`，
> 其中 **`--patch X` 落进了 app 段**：DSH 照常启动、照常绑 3081、
> 照常打印 URL——**强制面补丁层静默消失**。

产品把 `--port` 挪到最后解决了它；而**夹具**从那一刻起踩在这个坑的另一侧。

> 一个"产品把两段顺序搞对了、而夹具把自己的根选项插错了段"的用例，
> 红起来的样子与"产品把覆盖层弄丢了"**完全一样**——
> 只不过前者要改的是用例，后者要改的是实现。

#### 修法用的是 DSH 自己的报错，不是我的推断

第一版修法是"把 `--dump-config` 插到 app 段之前"。DSH 直接给出：

```text
error: config dumps take no app arguments, got "--host" "127.0.0.1" "--port" "51718" "--no-open"
```

也就是说这不是"位置没放对"，而是**这两件事不能同时要求**。于是夹具只能二选一：
要 dump（验根选项那条链）就不能带 app 段。改成**摘掉 app 段再 dump**，并在
**生产 argv 上**单独断言两段的顺序。

#### 顺带咬出一个覆盖缺口

新加的那条不变式（"所有根选项都在所有 app 选项之前"）在 `dsh-overlay` 上
只覆盖 `runtimeCommand` 分支。把 `node-file` 分支的 `extras`/`appArgs` 对调，
**两个套件全绿**——因为清单读数显示：

```text
team-hub / workbench / orchestrator / whiteboard   entry=node-file  portArgv=null hostArgv=null boolArgv=null
runtime                                            entry=configured 三族齐全
```

**只有 `runtime` 声明了 app 族旗标，而它走的是另一条分支** ⇒ `node-file` 分支上
`appArgs` 恒为空 ⇒ 那条规矩**今天没有可观察的对象**。于是在
`process-manifest.test.mjs` 里补了一条**源码级**断言把顺序钉住，并**同时**断言
"今天没有 node-file 进程声明 app 族旗标"——后者的作用是：等哪天有人给 team-hub
加了一个 `--port`，**它会红**，提醒把源码断言换成真跑一遍 argv 的断言。

#### 判据

```bash
export DSH_CHECKOUT=D:/project/DSH/dsh/deepseek-harness
node --test product/launcher/dsh-overlay.test.mjs      # 17/17
node --test product/process-manifest.test.mjs          # 21/21
node scratch/verify-overlay-argv.mjs                   # 4/4 咬住，两个套件一起跑
```

★ 那个验证脚本第一版**只跑 `dsh-overlay`**，于是锚在 `node-file` 分支上的变异
报"没咬住"——那不是用例的问题，是**验证脚本选错了靶场**。

### 10.13 本轮的诚实边界

1. **上一批的三条缺口，本轮的验证是在它们的用例与探针上复跑的**，
   不是在一次**真实多空间部署**里目击的——`scope` 对不上 `permission_rules`
   时匹配器的失败方向仍未端到端验证（PRT-214 续 §6 第 3 条照旧）。
2. **用户那份旧库仍未被动过**：`team-hub/team.db` 与它 4.3 MB 的 `-wal`
   原样未动，`DataDir` 未写。
3. **没有起过一个由 Launcher 完整启动的部署**（用户在跑的 DSH 在 3080 上）。
4. **`product/config-schema.mjs` 的修正未提交**，理由见 §10.4 末段——
   它依赖另一个 agent 进程尚未提交的 `launcher.mjs`。
5. **`runtime/packs/*` 零生产入口这一条是静态读数**（import 图 + `grep`），
   不是"跑起来看到的"——我没有构造一次真实的包安装去证明它装不上。
6. 本轮**不主张**新建任务号：三条续篇都记在 PRT-214 / PRT-251 / PRT-253 之下，
   与 `PRT-214-*.md` 的其余续篇同例。
7. §10.7 修掉的是**探针**，不是产品：`scrum/serve.mjs` 与
   `packages/shared/src/artifact-policy.mjs` 一直都是活的，
   改的只是"探针能不能看见它们"。所以这一节**不新增任何功能**，
   它消掉的是一条**读起来像缺口、实际是误报**的读数。
8. 那处假阳性**存在了很久而没有人被它误导**（它在 22 条 `gap` 里排第一，
   而 §5.4 的正文只点名了另外几族）——这不是"所以它不重要"，
   而是"它下次可能会被点名"。**一条误报的代价不是这一次错了，
   是下一次有人照着它去查一个正在跑的服务。**
9. §10.8 修掉的是**真代码**，但**没有**因此把 PRT-509 从 🟡 改成 ✅：
   它剩下的第 ① 条（win32 上 0600 不可证）与第 ③ 条（不是一次真进程端到端）
   **照旧**。本轮只关掉了第 ② 条——而那条被关掉的方式是**修了一个缺陷**，
   不是补了一次验证。★ 口径由项目方定（同 §5 第 18 条的处理）。
10. §10.8 的实测用的是 `D:\project\DSH\dsh\deepseek-harness` 这份**开发检出**上的
   `apps/cli/lib/bin.js`。我**没有**在路线 C（npm 装进
   `<DataDir>/runtime/dsh/versions/<版本>/`）的目录形状上跑过——
   那条路正是这个函数用 `createRequire` 而不是拼路径的**理由**，
   但"理由说得对"与"那条布局上验过"是两件事。
11. §10.9 那 3 条失败**只被观察到、没有被处理**——它们是另一个 agent 进程
   正在改的文件的直接后果，本轮**没有**去修（改别人手里正在写的承重文件，
   风险高于收益，而且会让两边的读数互相污染）。
12. §10.9 的隔离读数用的是 **`9bb4f7f`** 这一棵提交。它证明的是"这 3 条在本轮
   的提交上是绿的"，**不是**"那 3 条失败是错的"——那边可能正在修一个真缺陷，
   而它的红是修到一半的样子。
13. §10.10① 的 **232 条跳过**是**修好之后的第一次读数**，我**没有**逐条判断
   它们各自是否合法。已确证的只有一件事：那台机器上 DSH 检出**完整在盘上**
   而 `DSH_CHECKOUT` 未设，所以其中**至少**那批真进程套件是"环境没配上"
   而不是"缺东西"。逐条归类留给下一次（这也是为什么修法是"变成读数"而不是"判红"）。
14. §10.10② 的修法我在**本仓**、**两个人造仓库**（带合并的、带后缀路径的）
   上验过，**没有**在大型开源仓库上验过。`--no-walk --name-only` 在
   **根提交**上会列出全部文件（而不是"改动"），本仓的窗口里没有根提交，
   所以这条边界**没有被我的用例覆盖**。
15. §10.10③ 里"当年那次判定没有被污染"这个结论，只对**一个**提交（`9bec1e5`）成立。
   我没有把它在前后的相邻提交上扫一遍；而且 `PRT-315-slice1-mediation.md` 里
   记的 `server.mjs` 那两个数（2 和 7）**我复算不出来**（精确值 0 和 10）——
   所以"没被污染"这句话的适用范围是"最近窗口"，不是"那两个历史峰值"。
16. §10.12 那 231 条"配好环境就能跑"的结论，我只对**四个真进程套件**（32/32）
   与**整条 test 阶段**（`skipped` 232→1）验过。我没有逐条去分辨
   "那 1 条剩下的跳过是合法的"——它是什么、该不该跳，我没有查。
17. §10.12 的修法改的是**用例**（摘掉 app 段再 dump），**不是产品代码**。
   我的依据是"DSH 报 `config dumps take no app arguments`"与"产品 argv 的两段
   顺序是对的"这两条读数。**我没有**独立验证过"产品意图就是让
   `--dump-config` 与 app 段互斥"——那是 DSH 的设计，不是本仓的。
18. §10.12 的新不变式只在 `runtime` 进程上跑过一次真 argv。`team-hub` /
   `workbench` / `orchestrator` / `whiteboard` 四个进程的 argv **今天没有
   app 段**，所以它们那条路径上的段顺序只有源码级断言，**没有行为证据**。

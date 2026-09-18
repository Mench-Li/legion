# 最终报告：MULTI-AGENT-FEATURE-OPTIMIZATION 功能实现

- 日期：2026-09-18
- 仓库：`D:\project\DSH\legion`（DSH 检出 `D:\project\DSH\dsh\deepseek-harness\`）
- 权威台账：[`PRT-PROGRESS.md`](./PRT-PROGRESS.md) —— **145 行 = 140 ✅ / 1 ⬜ / 4 ⏸**
- 对照表：[`MULTI-AGENT-FEATURE-STATUS.md`](../../MULTI-AGENT-FEATURE-STATUS.md) —— F-01…F-25
- 目标文档：[`MULTI-AGENT-FEATURE-OPTIMIZATION.md`](../../MULTI-AGENT-FEATURE-OPTIMIZATION.md)
- 最近一轮 CI：`.ci/r16b`（本轮改动后重跑）／上一轮 `.ci/r15b` —— **9/9 阶段 PASS，exit 0**（`test` ≈ 800–842s，`skipped=1` 为已知的 secret-store）
- 相关提交：`502b636`（F-21 判定面，29 文件）、`c567791`、`d2168a2`、本轮（F-21 **投递面**，13 文件）

> ★ 本报告第 16 轮**追加**了一节「三、本轮又做了什么」的最后一小节与第二节的三条新裁决项；
> 结论那一段（"剩余 5 项本机不可关闭"）**没有变**，变的是**为什么**——见 §2.1 的 A 项与新加的 D/E 两项。

---

## 一、结论：功能实现已完成，剩余 5 项**本机不可关闭**

目标是"以该文档要增加的功能为基础，基于新架构（Legion 唤起 DSH）做完整实现"。
到本批为止：

| 读数 | 值 | 含义 |
| --- | --- | --- |
| 台账总行数 | **145** | 全部有落点、有判据 |
| ✅ 已完成 | **140** | |
| 🟡 部分 | **0** | **本批把最后一个 🟡 收掉了** |
| ⬜ 未开始 | **1** | PRT-316，**日期未到** |
| ⏸ 需外部输入 | **4** | 需要真实用户 / 真实平台 / 真实部署 |

**没有任何一项的阻塞理由是本机可以执行的代码工作。** 这一句是本报告最要紧的一句，
所以下一节把 5 项逐个交代到"为什么本机做不了"。

---

## 二、剩余 5 项：逐项交代（这是需要您裁决的部分）

### 2.1 需要您决策的（有具体动作，但归属不在我手里）

| # | 项 | 状态 | 精确的最后一根线 | 为什么我没做 |
| --- | --- | --- | --- | --- |
| **A** | **第 19 条**：部署配置键 → 组合根 | ★ **本轮已推进一大步**：投递面建好了（`connector-port.mjs` → `root-row.mjs`），`connectorJudgment` 在有那个键时**真的**是 `true` | 剩下的那一根线**只剩一处，而且与 `LEGION_PATH_SCOPE` 是同一处**：`LEGION_CONNECTOR_DECLARATIONS` 在 `runtime/config-schema.mjs` 的 `fields` 里，却**不在** `product/process-manifest.mjs` 的 runtime `envNames` 里。决定性实测：`buildChildEnv()` 对未声明的键在 `values` 里**抛**、在 `baseEnv` 里**静默丢掉** | `product/process-manifest.mjs` 是**另一会话的在制品**（`git status` 显示 M）。加一行到那个数组即可，但按纪律不碰 |
| **B** | **PRT-009 的最后一根线** | 峰值资源落盘 | `launcher.mjs` 的 `persistRunRecord()` 要把 `peakResource` 传进来（记录层已能带、能校验、能落盘、能读回，判据 47 例、变异 6/6） | `product/launcher/launcher.mjs` 是**另一会话的在制品**，按纪律不碰 |
| **C** | **第 16 条**：死代码处置 | 待裁决 | 模块级探针：**9** 个不可达模块；函数级探针：**43** 条（其中 `product/` 一簇 **23** 个）。9 vs 43 的差本身就是裁决依据 | 这是"要不要删/要不要接"的**产品决定**，不是代码问题 |
| **D** | ★★ **`TEAM_HUB_TOKEN` 到底该不该进 runtime 的 `envNames`**（本轮**新查出**，早于本轮且**没有任何归属**） | 待裁决 | `runtime/dsh-composition/root.mjs` 的 `readString(source, keys)` **确实**会读它（`ENFORCEMENT_CONFIG_FIELDS.hubToken`），但它**不在** `product/process-manifest.mjs` 的 runtime `envNames` 里 ⇒ **配了也传不到进程**。不致命的原因是它**可选**（`MISSING_FIELD_CODES` 里没有它，缺了不拦装配） | 两条路都行、但必须选一条：**①** 加进 runtime 的 `envNames`（那就真的能配了）；**②** 从 `runtime/config-schema.mjs` 的 `fields` 里**拿掉**它（那就别再声称本进程能配它）。"这个进程能配它"与"它能拿到它"必须有一处让步——★ 我**没有**替您选 |
| **E** | ★★★ **F-21 那条「未声明就拒绝」的教义要不要在生产里生效** | ★ **第 17 轮已解决**（原记"需要一条本仓没有的源信号"是**错**的——约定在执行引擎那边） | 新增 `runtime/connectors/public-name.mjs` 逐字镜像 DSH 的 MCP 公开名契约（`mcp__<serverName>__<rawName>`，逐字读 `packages/mcp/mcp-client/src/tools.ts`），并接成归属的**第一条**依据 ⇒ **`mcp__github__delete_repo` 从 `allow` → `deny`**，理由 `[连接器 github] …没有声明工具「…」`。判据含**一条把 DSH 真源码切片求值对跑 18 组**的用例（18/18 一致） | 本条已不需裁决。★ 而它**照出了两条新的**，见下面的 F/G |
| **F** | ★★★ **连接器声明里的工具名该写「公开名」还是「裸名」**（第 17 轮**新查出**） | 待裁决 | 声明里写的是**裸名**（`list_issues`）或 **DSH 核心工具名**（`git-status`，今天全部夹具都是这种），而**线上来的永远是公开名**（`mcp__github__list_issues`）。实测：`github` 声明 `list_issues` 时，调 `list_issues` ⇒ `allow`，调 `mcp__github__list_issues` ⇒ **`deny`「没有声明工具」** ⇒ **一个正确声明过的工具，在真 DSH 进程里会被拒** | ★ **不许**在归属时"把命名空间剥掉"来兼容裸名：DSH 的公开名在归一化/截断时会被替换成 12 位 SHA-256 后缀（`mcp__github__a b` ⇒ `mcp__github__a_b_200f08ef849a`），那时**剥不出** rawName；`tools.ts:9-10` 逐字写着 "the public name is never parsed to recover it"。⇒ 只有"声明侧写公开名（用已导出的 `publicToolName`）"这一条路是**可判**的。不裁决则所有按裸名写的声明在真部署里**把合法工具拒掉**（fail closed，安全但功能不可用）；修法涉及契约变更 + 既有夹具全要动，所以本批没有擅自做 |
| **G** | ★★ **命名空间"认不出来"的那一类要不要按教义拒**（第 17 轮**新查出**） | 待裁决 | `mcp__evil__x`：一个 MCP 公开名，而它那个命名空间**没有任何已知连接器**占着（一次漏配，或一次**未经声明的挂载**）。按头号教义它应当被拒，而做不到的原因是**端口形状**：`resolveConnectorId` 的值域是 `string 或 null`，**装不下"拒"** | ★ 本条与 **F** 方向**相反**，**不许合并**：F 是**已登记**的连接器把**合法**工具拒了（过严），本条是**未登记**的 MCP 服务器把工具放过去（过松）。不裁决则今天**不致命**（未知工具在政策门是 fail closed），但**一旦某个名字在政策门眼里是已知的低风险读工具**，它就会被放行，而登记表连问都没被问过 |

> **A 与 B 都可以由另一会话收尾，或由您在它提交后让我收尾。** 两处都精确到一处调用点。

### 2.2 需要外部环境的（本机永远做不了）

| # | 项 | 状态 | 阻塞 |
| --- | --- | --- | --- |
| D | **PRT-253** | ⏸ | 要一次**真的自动执行**（worker → Runtime 契约 → DSH → 模型）。真额度**已经花过且已验**（`dsh --profile headless` → exit=0、9.2s、`PONG`），剩下的是平台边界：`docs/STATUS.md` §4 第 15 条（Windows 上不会有自动执行） |
| E | **PRT-256** | ⏸ | 需**真实外部用户** |
| F | **PRT-910** | ⏸ | 需**真实用户项目** |

### 2.3 需要时间的（唯一一个纯等待项）

| # | 项 | 状态 | 算术 |
| --- | --- | --- | --- |
| G | **PRT-316**（team-hub 模块提取） | ⬜ | 加固提交 `0db37af` = 2026-09-10；一个发布周期 **14 天**（`PRT-909-release-checklist.md:63`）⇒ 最早 **2026-09-24**；今天 **2026-09-18** ⇒ **还差 6 天**。评审闸门**已过**（`hot-file-churn.mjs` 复跑 exit 0：0/40，历史峰值 11/40） |

---

## 三、第 15 轮做了什么

### 3.0 第 16 轮（本轮）：F-21 的**投递面**——那份声明**从哪来**

第 15 轮把判定面接进了组合根，但末尾如实留了一句「生产入参里没有连接器声明表」。
本轮补的就是那个"没有"：新增 `runtime/dsh-composition/connector-port.mjs`（+14 例）+
`plugins/root-row.mjs` 的真生产调用方，于是 `enforcementSurfaces().connectorJudgment`
在环境里有那个键时**真的**是 `true`。

三条纪律（都写进了文件头，各有真用例）：

| 纪律 | 坏写法为什么危险 |
| --- | --- |
| **缺席 ≠ 空表** | `env[KEY] ?? '[]'` 会让组合根建出一份**零连接器**登记表 ⇒ 那一格报 `true`，而它**一次判定都不会做**。而 `assemble.mjs` 只判 `=== null` |
| **显式空表具名拒绝** | 写 `[]` 的人要么想表达"不许任何连接器工具"（那需要**拒绝语义**），要么是生成配置的代码出错了。静默接受让"我配了"与"我配错了"同形 |
| **重名工具在装配期停** | `none` 与 `ambiguous` 在判定面那个 `string 或 null` 端口上折成同一个 `null`，而 `null` 的含义是"交给政策门" ⇒ 一次**新增重名声明**就能把那几个工具的策略**静默免掉** |

证据是**在真生产路径上**的五条（`root-row.test.mjs`）：配了 ⇒ 七格全对；
**没配** ⇒ 如实 `false`；显式 `[]` ⇒ 拦住装配；坏 JSON ⇒ 拦住装配；
配上之后一次**连接器策略是 deny** 的调用被**连接器层**拦下（`connectorDecided === 1`），
而**同一次调用没配时是 `allow`**（前提对照）。

★ 本轮最重要的产出其实是**两条边界**（详见 `docs/MULTI-AGENT-FEATURE-STATUS.md` §4.2 与
会话报告 §10.46）：

1. **登记表的头号教义在生产里不可达**——推导式归属要求"先被声明才能归属"，
   而未声明的工具正是那条教义要拒的东西。⇒ 报告 §2.1 的 **E** 项。
2. **两张声明面之间原本没有任何闸**——`runtime/config-schema.mjs` 的 `fields`
   与 `product/process-manifest.mjs` 的 runtime `envNames` 各自都有门禁，
   而"schema 里声明了、清单里没放行"是**两处都绿**的。实测三处缺口
   （含一处**早于本轮、没有任何归属**的 `TEAM_HUB_TOKEN`）⇒ 报告 §2.1 的 **D** 项。
   已加闸并**变异实测**过。

★ 全量 CI 在本轮**抓到我自己的一次回归**（`production-scope-wiring` ①）：我把那组新入参
写成了**条件展开**，而那条判据是**文本解析**这组键的 ⇒ 解析器中途停下。
修法是回到这一行既有的形状（`pathScope: scope.port`：**键恒在、缺席为 `null`**），
**行为逐字不变**。

> 一个"用条件展开来表达缺席"的装配点，与一个"键恒在、缺席为 null"的装配点，
> 在**行为上**完全相同——只不过前者的键集**不可文本化**，
> 于是任何"数一数传了哪几个键"的判据都会静静地少看见几个。

---

### 3.0b 第 17 轮：**来源信号一直都在执行引擎那边**——上一轮那句"本仓没有"错在哪

第 16 轮我在报告里写下"归属的来源信号本仓没有，需要 DSH 侧的信息或一次产品裁决"。
**那句话是错的**，而错的方式是本项目里第一次出现的一种：

我做的是 `grep` `mcp__` / 工具前缀在**本仓**生产代码里的命中（**零命中**），
于是判定"约定不存在"。但约定不在本仓——它在**执行引擎**那边。DSH 检出里逐字写着
（`packages/mcp/mcp-client/src/tools.ts:8`）：

```text
is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
```

> 一个"在**我的**仓里找不到这个约定"的读数，
> 与一个"这个约定不存在"的读数，是同一次 `grep` 的两个解释——而我只验了前者。
> **约定在被我编排的那个引擎里，不在编排它的那一侧。**

★ 这是本项目**第一次**由编排者（Legion）去读被编排者（DSH）的契约来关掉自己的缺口。
前 16 轮里 DSH 一直是下游（我调它、限制它），这一次它是**规范的来源**。

| 动作 | 落点 |
| --- | --- |
| 逐字镜像 DSH 的 `publicToolName` + 命名空间归属 | `runtime/connectors/public-name.mjs`（+14 例） |
| 归属改成**两条依据、命名空间在前** | `runtime/dsh-composition/connector-port.mjs` |
| 判据：把 DSH 的**真源码切片求值**对跑 18 组 | `public-name.test.mjs` ①a（**18/18 一致**） |

**实测（同一次调用、显式 `target`，策略门是放行的桩好让"谁在说话"看得清楚）：**

| 调用名 | 第 16 轮 | 第 17 轮 |
| --- | --- | --- |
| `mcp__github__delete_repo`（`github` 是已知连接器，`delete_repo` 未声明） | **`allow`** | **`deny`**，理由 `[连接器 github] …没有声明工具「…」` |
| `list_issues`（逐字声明过） | `allow` + 连接器理由 | 同左（未变） |

⇒ **那条「未声明的工具必须拒绝」的头号教义，第一次在生产路径上真的拦下了东西。**

★ 而它一上线就**照出了第三处缺口**：声明里写**裸名**，线上来的是**公开名**
⇒ 一个**正确声明过**的工具在真部署里会被拒（报告 §2.1 的 **F** 项）。
以及**仍未关的那一半**：命名空间**认不出**的仍落政策门（**G** 项）。

★ 两处判据被本批"改了要钉的东西"，**而它们本来是全绿的**——
`root-row.test.mjs`「归属的边界」原本钉"教义不可达"（用**单下划线**的名字，
命中不了命名空间），`connector-port.test.mjs` ④c 原来三条断言**全都没有 `mcp__` 前缀**。
两者测的都是**非**命名空间那一类，所以边界关掉之后**不会红**：

> 一条钉着**旧**边界的判据，在边界被关掉之后**不会红**——
> 它只会让下一个读到它的人以为洞还在。

---

### 3.1 第 15 轮：F-21 的**判定面**

台账 F-21 那一行自己点名的阻塞**已经过期**——它写着

> 正确的执行点是 `tool-request.mjs` 的 `createEnforcementBridge().preExecute`——
> **本轮没能落在这里，因为同一工作树上另一个 agent 进程正在改 `tool-request.mjs`**

而我在上一批（`99fb763`）里已经改完并提交了那个文件。所以本批做的是**那一行点名的事**：

| 动作 | 落点 |
| --- | --- |
| 新模块：把 `registry.decide()` 织进桥的 `decide` 端口 | `runtime/connectors/decision-port.mjs`（+ 19 例） |
| 桥新增 `connectorJudgment` 参数（给了就**替**在决策路径上） | `runtime/dsh-composition/tool-request.mjs` |
| 一次造齐两半、共用**同一份** registry（判定读熔断器、反馈写熔断器） | `runtime/dsh-composition/assemble.mjs` |
| `enforcementSurfaces()` **6 格 → 7 格** | 新增 `connectorJudgment`，与 `connectorFeedback` **分开报** |

**合并的方向是最要紧的一条**：

> 一个"连接器层 `allow` 就整体 `allow`"的组合，
> 与一个"每一次连接器调用都**跳过整个政策层**"的桥，是同一个东西——
> 只不过前者的读数看起来像"连接器策略生效了"。

所以取严（`deny > ask > allow`）而不是短路。第二条同样重要、且更容易漏——
因为它看起来像"更安全"：连接器层的 `ask` **不许把政策门的 `deny` 降级**成一次
"可以被人批准"的调用。

### 3.2 证据：这是判定面第一次在组合根上**真的拦下调用**

`root.test.mjs` ⑨④～⑨⑥ 用真 `installEnforcementRoot`：

```
不装连接器：preExecute(git-commit) → allow     ← 前提对照（政策门说 allow）
装了连接器：preExecute(git-commit) → deny
           理由「连接器 github 没有声明工具「git-commit」」
           connectorDecided = 1                ← 更严的那一侧是连接器层
装了连接器：preExecute(git-status) → allow     ← 反向对照（本连接器声明过的）
```

⑨⑤ 是**闭环**：开路 ⇒ deny ⇒ 反馈面记回三次失败 ⇒ 探针成功 ⇒ 恢复 allow。
⑨⑥ 断言两半的 `.registry` 是**同一个对象**（指着两份 ⇒ 熔断器永远读不到同一个状态）。

### 3.3 途中抓到并修掉的缺陷

| # | 缺陷 | 为什么它危险 |
| --- | --- | --- |
| 1 | **两套词汇表**：桥读 `kind`、注册表返回 `decision`。第一版两边都用 `kind` 读 | **连接器一配上就会把每一次工具调用都拒掉**——而读数看起来像"连接器策略很严"。★ **是用例当场抓到的**（一批同时红），不是复核出来的 |
| 2 | **`declaredRisk` vs `risk` 静默丢数据**：输入字段叫 `declaredRisk`、**输出**字段叫 `risk`；照着输出写 `risk: 'critical'` 会被**静默丢掉**、落回能力下限 `low` ⇒ 作者标成 critical 的工具被自动放行 | 无报错、无计数。★ **全仓 9 处真样本**用错字段名，其中两处是**自己人写的**；**我自己新用例的第一版**也写错了 |
| 3 | **一条一直是绿的、但什么都没验到的用例** | 它用 `risk: 'high'` / `risk: 'low'` 断言哈希不同，而这两个声明在**权限上完全一样**（那个字段永远不生效）；哈希之所以不同，是因为哈希把**无效字段**也读进了载荷 |
| 4 | **导出面喂不回去** | `exportConnectors` 出的是 `risk`，于是"导出、提交、给人审阅"的文件**喂不回** `declareConnector`；而且记录里还多存了一个**推导值** |

修法：`declareTool` 键集改成**封闭**（不认识的键具名拒，理由直接点名两个字段名）；
导出面改出 `declaredRisk`；记录形状与声明的**输入**形状对齐。

### 3.4 附带修掉的

- **手钉坐标位移 639 → 731**：机检的那 1 处 + **26 处叙述性引用**（后者不会让 CI 变红，
  但会让下一个照着坐标去读的人落在 `}` 上）。★ 两次位移**都是判据自己报红顶出来的**。
- **`prt-007` 基线刷新**：刷新**之前先核**——只有 1 个源文件哈希变了、**6 张契约表全等**
  （`httpRoutes`/`dbTables`/`taskStatuses`/`taskTransitions`/`goalStatuses`/`permissionModes`）。
  ⇒ 结论：一次**无契约影响**的源改动，不是契约漂移。
- **F-21 状态格**：第一版塞了叙事（`⬜→🟡→**🟡（已接线）**`），`prt-progress` ⑥ 报红
  ⇒ 回到图例允许的 `⬜→🟡`，细节留在依据/还差两格。
- **§2 缺口表那句过期的话**：第三格是**判据**不是状态，所以**没有任何门禁会看它**。

---

## 四、验证与门禁

| 项 | 读数 |
| --- | --- |
| 全量 CI（`502b636`，`.ci/r15b`） | **9/9 PASS，exit 0**；`test` 801030ms；`skipped=1`（secret-store，已知） |
| 受影响面（connectors + composition + connector-store + connector-http） | **239/239** |
| connectors 套件（含本批新注册 `decision-port.test.mjs`） | **75/75** |
| dsh-composition 套件 | **115/115** |
| `team-hub/connector-store.test.mjs` | **23/23**（测试⑧那句"缺的是连接目标，不是策略"**第一次成为真的**） |
| `boundary-facts`（手钉坐标） | **34/34** |
| `feature-table` / `progress-check` / `intervention-coverage` / `reachability` | 52/52 |
| 可达性 | 不可达 **46**（未增加）；`decision-port.mjs` 等 5 个模块**全部可达** |

★ 有一处**必须说清**：`--only boundary` 那一快阶段**不含** `boundary-facts` 套件
（它在 `test` 阶段），所以坐标位移是**`test` 阶段抓到的**——快阶段绿**不代表**坐标对。

---

## 五、诚实边界（这些不是"待办"，是已知的读数上限）

1. ⚠️ **F-21 在生产里还不会拦任何东西**：生产入参里没有连接器声明表 ⇒
   `enforcementSurfaces().connectorJudgment` 在生产里仍是 `false`。
   本批打通的是"**给了声明之后整条链能不能跑**"。
   精确读数：**从「没人接线」变成「接好了、且真调用被它拦下」**，而**不是**"生产里已经在拦"。
2. ⚠️ **两半可能对同一次调用给出不同的归属**：`resolveConnectorId` 在判定面上只拿得到
   `projection`、在反馈面上拿得到 `exec`。一个"必须靠 `exec` 才认得出"的解析器在判定面上会抛
   ⇒ 算作"认不出" ⇒ 交给政策门（**有意的** fail-open 到政策门，不是 fail-open 到放行）。
   **没有生产解析器，所以这件事尚未被测过。**
3. ⚠️ `decision-port.mjs` 与 `connector-feedback.mjs` 一样，只在**假 Context** 上挂过，
   没有在真 DSH 进程里跑过（它们不在补丁层里）。
4. ⚠️ 半开探针那个修复的生产效果**仍未被观察**：今天没有任何生产路径会调 `recordOutcome`，
   所以熔断器在跑着的系统里永远合闸；⑨⑤ 是在**测试里**把它推起来的。
5. ⚠️ 函数级审计的 **106 条死条目里 98 条未逐条核实**，是文本分析的**下界**。

---

## 六、给下一个人的一句话

> 本批三次撞到同一个形状：**"能力齐全、用例全绿、而生产调用方数为 0"**
> ——第一次在 F-21 的判定面、第二次在 `declaredRisk`/`risk`（一条绿用例什么都没验到）、
> 第三次在第 19 条自己的交付物 `joinExecutionPlane` 上（零生产导入方）。
>
> 所以**读"✅ + 用例全绿"时，要同时问一句"生产里谁在调用它"**。
> 本仓把这个读数做成了可查的东西：模块级探针（9 个）+ 函数级探针（43 条）。

---

## 附：相关文档

- 会话报告 §10.45（判定面）+ 诚实边界 **139–159**：
  [`PRT-SESSION-REPORT-2026-09-17.md`](./PRT-SESSION-REPORT-2026-09-17.md)
- 台账 PRT-611 条目 **⑮/⑯/⑰**：[`PRT-PROGRESS.md`](./PRT-PROGRESS.md)
- 对照表 F-21 行 + §2 缺口表：[`MULTI-AGENT-FEATURE-STATUS.md`](../../MULTI-AGENT-FEATURE-STATUS.md)

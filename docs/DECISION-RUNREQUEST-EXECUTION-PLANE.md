# 裁决：执行面需要的数据放进 `RunRequest`（2026-09-18）

> 本文件记录 `docs/MULTI-AGENT-FEATURE-STATUS.md` **决策表第 19 条**的裁决。
> 之所以单独成文：第 19 条那一行当时**有别的会话的在制品**，我没有去动它
> （见本文件末「为什么没写进决策表」）。裁决本身不因载体而改变。

## 1. 裁决内容

**选前者**：把执行面需要的那几份数据**放进 `RunRequest`**，
照抄 PRT-214 已经跑通两遍的形状。

**不选后者**：不给执行面开控制面入口、**不**注入 `TEAM_HUB_TOKEN`。
理由（决策表原文）：那会让 spec §2「**Runtime 不看业务状态**」这条不可突破边界消失，
并且执行面一旦有 token，「读声明」与「改状态」就只差一次调用。

★ 因此第 19 条（以及被它合并的第 13/14/15/18 条）从「**待裁决**」变成「**待施工**」，
责任也随之从「产品 + 项目主」变成**纯代码工作量**。

## 2. 要照抄的形状（PRT-214 已跑通两遍，五个性质缺一不可）

1. **专属线上字段**——不塞进既有的通用袋子里，`RunRequest` 上有自己的字段名；
2. **按 Run 安装**——不是进程级默认值；
3. **对象身份配对**——安装与卸载认的是**同一个对象身份**，不是"名字对得上"；
4. **可 dispose**——Run 结束要撤得掉；
5. **装不上就具名拒绝**——不许静默降级成"没有这份数据"。

（两遍先例：缺口①的 `enforcementFloor`、缺口②的 `enforcementIdentity`。）

## 3. 硬约束（**不是建议**）

> **不许凭空造那份范围表。**

`读根 = 写根 = workdir` 这类"看起来更严"的默认值，**方向是放行**；
而"反正它更严"这个辩护**不成立**——收成 `workdir` 会同时拒掉**合法的**越目录读，
表现成"工具莫名其妙失败"，比拒绝更难诊断。

范围表**必须来自一个有出处的生产者**。若某一轮找不到，就如实记成
「**线上字段已可读、输入仍缺席**」，而不是把一条编出来的默认值接上去充数——
那正是 PRT-253 §3 明令禁止的「发明默认值、替身或暂时放行」，后果是让
"没接线"与"接好了"在读数上**同形**。

## 4. 待搬运的四项数据（决策表第 19 条列出）

| 项 | 今天的读数 | 出处 |
| --- | --- | --- |
| 连接器声明（F-21） | 能力已建（64 例、30 处变异），**判定面零生产调用方** | `runtime/connectors/registry.mjs` 的 `decide()` |
| 范围表（PRT-603/604/605/606） | **生产里一次都不跑**；`tool-request.mjs:639` 在 `pathScope === null` 时返回"放行"，而生产从不注入 | `runtime/dsh-composition/path-scope.mjs` 等 |
| 落账端点（PRT-610） | 表、读面、就绪证据的产出点已接上，**写入方仍是 0** | `recordToolCall` / `markDispatched` |
| 摩擦与岗位包输入（F-18/F-19） | `runtime/packs/*` 四个模块**零生产入口**，`createPackStore` 生产调用点 **0 处** | `runtime/packs/*` |

## 5. 我复核过的三条机器读数（支撑上面这张表）

- ① `runtime` 进程的 `envNames` **故意没有** `TEAM_HUB_TOKEN`；
  而 **worker 有**（`product/process-manifest.mjs:296-298`）。
  所以"执行面拿不到控制面凭证"是真的，而且**是刻意设计的**。
- ② `RunRequest.permissions` 只有 `{preset, tools, deniedTools?}`，
  **没有**范围表 / host surface（`runtime/contracts/run.mjs:158-181`）。
- ③ `runtime/packs/*` 四个模块（`store` / `compiled-plan` / `authority` /
  `builtin/software-delivery`）**零生产入口**，`createPackStore` 的生产调用点 **0 处**——
  hub 的 `/api/packs/account` 把账交出去，而**没有任何生产代码接住**。

## 6. 为什么没写进决策表

`docs/MULTI-AGENT-FEATURE-STATUS.md` 在第 19 条那一行上**有别的会话的在制品**
（`git status --porcelain` 显示 ` M`）。按本仓的纪律，**不去动别人未提交的工作**，
所以裁决记录在这里。**下一个拥有那份在制品的会话**应当把本文件的结论并回第 19 条，
或直接按本文件施工。

---

## 7. ★★★ 施工前的复核：连接器那一条**不能照抄形状**（2026-09-18 实测）

裁决说"照抄 PRT-214 的形状是纯代码工作量"。开工前我按本文件的硬约束先去核
**每一项数据是不是真的有出处**，量到一件必须先说清的事。

### 7.1 读数（不是推理，是跑出来的）

用两边**各自的生产函数**跑一遍：hub 的 `normalizeDeclaration()` → 执行面的 `createRegistry()`。

```
① hub 规范化后产出的字段：version, connectorId, version_label, transport, policy, tools, secretRefs
   有 command 吗? false
   有 url 吗?     false

② 把这份记录**原样**喂进 createRegistry
   → 拒绝码 connector-transport-target-missing
      "连接器 probe-mcp 的 transport 是 stdio，必须给 command"

③ 反向对照：**只**补上 command
   → 建起来了：connectors() = 1
```

### 7.2 这说明什么

执行面要的两半，控制面只存了一一半：

| 一半 | 内容 | 控制面存吗 |
| --- | --- | --- |
| **策略** | `connectorId` / `transport` / `policy` / `tools`(含 capabilities、risk) / `secretRefs` | **存** |
| **连接目标** | `command`（stdio）/ `url`（http、sse） | **不存**，且**导出时也刻意不含** |

★ 第三条不是我的推断：既有用例 ⑤ 的标题就是
「导出是可提交进 Git 的文本：含权限面与引用**名**，**不含命令与 URL**」。
所以"控制面不持有连接目标"是一条**有判据守着的设计性质**，不是遗漏。

### 7.3 后果

**把控制面的连接器声明挂到 `RunRequest` 上，执行面装不成注册表。**
唯一能让它通过的办法是**编一个 command/url**——那正是 PRT-253 §3 明令禁止的
"发明默认值"，也正是本文件 §3 那条硬约束要拦的事。

> 一个"照抄形状就能跑"的判断，与一个"照抄形状之后在 `declareConnector` 这一步
> 具名拒绝"的实现，在计划文档上是同一个句子——只不过前者的前提**没有被人量过**。

### 7.4 于是这一条不是"待施工"，是"**待决定数据放哪**"

连接目标（`command`/`url`）今天在全仓**没有任何生产者**（已 grep：生产代码里零命中，
只有 `.skills-cache` 里一份第三方用例和台账自己的诚实边界）。因此要决定的是：

- **(a)** 控制面**扩表**，把连接目标也存下来，并**故意**让它进导出文本；
- **(b)** 连接目标由**岗位包 / 能力包**声明（F-19 / 阶段 10），装配期算一次；
- **(c)** 连接目标由**运维**在部署配置里给（与 `model/api-key` 那类运行时物化的东西同一层）；
- **(d)** 本阶段**明确不做**跨进程 MCP，把 F-21 的定位改成"控制面已就绪、判定面随 MCP 客户端一起做"。

★ 无论选哪条，**都不要**先接"照抄形状"那一版：它会在运行时以具名码失败，
而那比"没接线"更难诊断——**没接线看得出来，接错了看不出来**。

### 7.5 本轮钉住了什么

`team-hub/connector-store.test.mjs` 新增用例 ⑧（**23/23 绿**，破坏性验证已咬住）：
它把上面 ①②③④ 四条读数固化下来（含 http/sse 缺 `url` 的同一具名码）。
于是"接上了它就会红"——下一个人想照抄形状时，判据会先说话。

---

## 8. 连接目标放哪：**运维 / 部署配置**（业主裁决，2026-09-18）

§7 摆出四个方向后，业主选 **(c)**：连接目标（`command` / `url`）由**运维在部署配置里给**，
与 `model/api-key` 那类"运行时物化"的东西同一层。

### 8.1 这条裁决与 §7 的读数是一致的

| 一半 | 放在哪 | 为什么这样分 |
| --- | --- | --- |
| **策略**（谁能用哪些工具、多大风险、引用哪把钥） | **控制面**（已在，且已冻结、可审计、可导出） | 它是**可移植**的：同一岗位在哪儿都该有同样的边界 |
| **连接目标**（连哪个 MCP 端点 / 跑哪条命令） | **部署配置**（本次裁决） | 它是**每套部署各不相同**的：同一员工在笔记本与服务器上连的不是同一个端点 |

★ 于是 §7.2 里那条"控制面不存、导出也不含连接目标"的既有性质**不必被推翻**——
它是**对的**，只是此前少了一半的说明：缺的那一半不在控制面，在运维手里。

### 8.2 由此得到的组装规则（这是要施工的形状）

```
控制面冻结的声明（策略）  ┐
                          ├─→ 组装成执行面认的声明 ──→ createRegistry({ connectors })
部署配置给的目标（连接）  ┘
```

三条**必须 fail closed** 的拒绝（都不许"猜一个"）：

1. **有声明、没目标** ⇒ 具名拒绝（不许退化成"这次没有这个连接器"——
   那与"这个连接器没配"同形，会让一次漏配静默地变成"少一个工具"）；
2. **目标的 transport 与声明的 transport 不一致** ⇒ 具名拒绝。
   ★ 不许"以某一侧为准"：两侧不一致时，任何一侧都可能是错的，
   而选错的那一侧会让一个 `http` 声明拿着一条 `stdio` 命令**看起来配置完整**；
3. **目标为空**（`command`/`url` 是空串） ⇒ 具名拒绝。
   这与执行面 `declareConnector` 已有的 `connector-transport-target-missing` 同一条理由。

### 8.3 今天的状态：**部分被别人的在制品挡住**

施工要碰的两个文件此刻**有别的会话的在制品**：

| 文件 | 状态 | 为什么需要它 |
| --- | --- | --- |
| `product/process-manifest.mjs` | **DIRTY** | 新的部署配置键必须在这里声明 `envNames`，否则启动器会把它丢掉 |
| `product/config-schema.mjs` | **DIRTY** | 新键必须登记，否则 `scan --check` 报未登记字面量 |

按本仓纪律**不动别人未提交的工作**，所以 (c) 的"配置键"那一半**暂停**，
等那两个文件干净。

**没有被挡住的**：组装规则本身（§8.2）是一个**纯函数**，不依赖目标存哪儿。
它可以在 `runtime/connectors/` 里先落地并钉住（三个拒绝 + 对照），
等配置键那边解冻再接上去。

**已落地**：`runtime/connectors/target-binding.mjs` + 9 例用例（4 条变异全部咬住），
已登记进 CI 的 `connectors` 套件，可达性基线里分类为 `gap`（指向本条）。

### 8.3.1 ★★★ 订正：上表那两条理由**都是错的**（2026-09-18 复核）

上面那张表是我的**印象**，不是量出来的。逐条量过之后，两条都不成立：

| 我原写的理由 | 实测读数 | 判定 |
| --- | --- | --- |
| "新键必须在 `product/process-manifest.mjs` 声明 `envNames`" | 该文件里 **`envNames:` 声明 0 处**（只在字段说明的注释里被提到）；而**已存在的**配置键（`runtime.enforcementOverlay` / `runtime.secretRefs` / `launcher.backoffBaseMs` / `ports.team-hub` / `components.whiteboard.enabled`）在那里出现 **0 次** | **假** |
| "新键必须登记进 `product/config-schema.mjs`，否则 `scan --check` 报未登记字面量" | 该文件里 `KNOWN_CONFIG_KEYS` 出现 **0 次**、`nonEnvsLiterals` 出现 **0 次**；而 `nonEnvsLiterals` **全仓都不存在**（`git grep` 无命中） | **假** |

**真正登记 `product.config.json` 键的地方是 `product/config.mjs` 的 `KNOWN_CONFIG_KEYS`**
——它在 2026-09-18 是**干净的**。那个文件的 `SCHEMA.fields` 装的是**进程级设置**
（`home` / `installDir` / `dataDir` / … / `teamHubToken`），与本条要的键不是一回事。

★ 两点顺带量出来的事实：

1. `validateConfigValues` **只**在"键没登记"那一支递归。所以把
   `runtime.pathScope` 登记成 `object` 之后，它内部的 `platform` / `read` / `write`
   **不会**各自报 `CONFIG_UNKNOWN_KEY`（`runtime.secretRefs` 用的是同一机制）。
2. 未登记的键只报 **warn**（`CONFIG_UNKNOWN_KEY`），不报 error——
   原话是"向前兼容是真实场景……但它必须被**看见**"。

> 一个"照印象写下的阻塞理由"，与一个"量出来的阻塞理由"，
> 在计划文档里长得一模一样——只不过前者会让整整一轮工作**停在其实没堵的地方**。

**结论**：§8.3 的"配置键那一半暂停"**取消**。这一半可以在只碰干净文件的前提下开工，
本轮的落地见 §9.4。

⚠️ 仍然被挡住的**不是**配置键，而是**把新用例登记进 CI**：
`scripts/ci/run-ci.mjs` 在 2026-09-18 变成**别人的在制品**（一个 `MEASURE` 读数机制，
+23 行），而我这边需要往它的套件清单里加一行。详见 §9.4 的边界一节。

---

## 9. 路径范围表放哪：**同样归运维 / 部署配置**（业主裁决，2026-09-18）

第 19 条要的四项数据里，第二项是**路径范围表**（`readRoots` / `writeRoots`）。
复核后它**与连接目标是同一个形状**——数据没有家：

| 实测 | 读数 |
| --- | --- |
| 执行面 `pathScope` | **可选端口**；没注入时 `tool-request.mjs:639` 直接返回**放行** |
| 岗位清单 `MANIFEST_FIELDS` | **闭合白名单**，里面**只有** `workspaceRoot`，没有读/写根 |
| `FORBIDDEN_MANIFEST_FIELDS` | **明列** `denyPathPrefixes`，注释：*"一个能写强制面字段的清单，就是一个能给自己发权限的清单"* |

★ 第三条把「员工清单扩字段」这条路**从设计上**堵死了——不是"没做"，是**不许**。
所以范围表**不可能**来自岗位清单，这与它"是不是可移植"无关。

业主裁决：**(b) 部署 / 运维配置**，与 §8 的连接目标同一层。

### 9.1 ★ 两条裁决合起来是一个简化：**一个缝，不是两个**

```
控制面（策略）        ┐
                      ├─→ 装配点 ──→ RunRequest ──→ 执行面
部署配置（连接目标）  │
部署配置（范围表）    ┘
```

连接目标与范围表**归同一层**，于是它们应当在**同一个装配点**被读取与校验，
并共用同一条纪律：

> **配了就必须解释得通；没配就如实缺席；不许猜一个。**

★ 这条纪律不是新发明的——它已经是 `runtime/contracts/run.mjs:97-125` 给
`enforcementFloor` 写下的那一条（"给了就必须解释得通，不给就如实缺席"）。
**同一个形状的决定，应当复用同一条纪律，而不是各写一套。**

### 9.2 下一个施工点（供接手者）

★ **订正（同日）：本节的第 2 条我写错了。** 我原写"范围表照 `target-binding` 的同一形状
做一个纯函数 + 三条拒绝"——**但那个纯函数已经存在**：

`runtime/dsh-composition/path-scope.mjs`，**863 行**，导出 `normalizeScope` /
`narrowScopeToWorkspace` / `checkPathScope` / `createResolver` / `contains` /
`resolveReal`，外加一整套自证（`PATH_SCOPE_CHECKED`、`assertBoundaryNotPrefix`、
`assertSymlinkEscapeCaught`、`assertWriteScopeNarrowed`…）。**再写一个就是重复建设。**

> 于是范围表缺的**不是判定逻辑，是那份表的出处**——而这与连接目标是**同一个缺口**。
> 一句话：**它的 `checkPathScope` 写好了，只是没人给它一份表。**

真正剩下的施工点：

1. `runtime/connectors/target-binding.mjs` 的三个拒绝（**已落地**，`a3c0800`）
   是这条纪律的**第一份实现**；
2. ~~范围表照 `target-binding` 的同一形状做一个纯函数 + 三条拒绝~~ → **已落地**
   `runtime/dsh-composition/scope-table-binding.mjs`（11 例，4 条变异全咬住）。
   ★ 它**不**重写判定：判定仍在 `path-scope.mjs` 里，本模块只做**装配期**那三条拒绝
   （缺表 / 无读根 / 有写根却没工作区根）+ 归一化收窄 + `cwd` 派生。
   ★★ 形状与 `target-binding` **故意不同**：连接器是**多条** ⇒ 返回
   `{declarations, refusals}`（部分成功，漏配的后果是**权限变少**，安全）；
   范围表只有**一张** ⇒ **抛**具名错误（漏配的后果是**权限变多**）。
   *两条装配线，一条可以"少几条"，另一条只能"要么有、要么当场停"。*
3. 两处（连接目标 + 范围表）汇合到**同一个**部署配置读取点，再挂上 `RunRequest`；
4. ★ 但配置键仍被 `product/process-manifest.mjs` / `product/config-schema.mjs`
   的**他人在制品**挡着（§8.3）——那是唯一的外部依赖。

> **★ 上面第 3、4 条已被订正**：第 3 条读作"挂上 `RunRequest`"，而实测下来
> **`RunRequest` 里根本没有放范围表的地方**（`runtime/contracts/run.mjs` 的
> `RUN_REQUEST_REQUIRED` 与投影字段里都没有 `pathScope`）。真正的接缝是
> **组合根的入参**：`installEnforcementRoot({pathScope})`，而它要的是一个**函数**
> （`tool-request.mjs:642` 的 `pathScope(projection)`），不是一份表。
> 第 4 条的两条理由在 §8.3.1 已证伪。落地见 §9.4（读取点）与 §9.5（端口 + 生产接线）。


### 9.3 ★ 装配点里量出来的一件事：缺表 = **放行**，不是拒绝

`tool-request.mjs:639` 是：

```js
if (pathScope === null) return undefined      // ← 放行
verdict = pathScope(projection)
```

所以"这份表没配上"在**今天**的表现**不是**"拒绝一切"，而是**放行一切**：

> 一个"因为没配范围表所以什么都没限制"的位点，
> 与一个"这次确实没有东西要限制"的位点，在读数上是同一个东西——
> 只不过前者看起来像有保护（端口在、函数在、用例绿），而它一个真路径都没拦过。

★ 这与 PRT-214 缺口①当初那条教训**同形**（"缺席在传输层落到拒绝一切，看起来像有保护，
实际一个真工具都没被拦过"），只差方向：那里缺席落成**拒绝一切**，这里缺席落成**放行一切**。
两者都是"缺席被读成一个不可区分的读数"。

★ 因此 `scope-table-binding` 的**第一职责不是算范围，是把"没配上"变成一件必须处置的事**
——这也是它必须**抛**而不是返回 `scope: null` 的原因（§9.2 第 2 条）。

---

## 9.4 第 3 步落地：**同一个部署配置读取点**（2026-09-18）

§9.2 第 3 步（"两处汇合到**同一个**部署配置读取点"）本轮落地，
**只碰干净文件**（§8.3.1 已证明原以为的阻塞不存在）。

### 交付物

| 文件 | 内容 |
| --- | --- |
| `product/config.mjs` | `KNOWN_CONFIG_KEYS` 新增两个键（**这就是键的登记处**，见 §8.3.1） |
| `product/execution-plane-config.mjs` | 读取点：`readExecutionPlaneConfig()` + `joinExecutionPlane()` |
| `product/execution-plane-config.test.mjs` | 17 例；4 条变异全部咬住、每次还原逐字节相同 |

两个键（键名导出成常量，免得字符串散落）：

- `runtime.pathScope` → `{platform, read[], write[]}`，交给 `bindScopeTable()`
- `runtime.connectorTargets` → `{connectorId: {transport?, command?, url?}}`，
  与控制面的连接器声明交给 `bindConnectorTargets()` **配对**

### ★ 读取点加的那一层：把"没配"与"配了但解释不通"分开

这条不是新发明，是 `runtime/contracts/run.mjs:97-125` 给 `enforcementFloor`
定的**同一条纪律**：

> 给了就必须解释得通，不给就如实缺席。

所以两半各返回一个 `state`：

| 状态 | 何时 | 处置归谁 |
| --- | --- | --- |
| `configured` | 键在，且形状解释得通 | —— |
| `absent` | 键**压根不在**配置里 | **消费点**（不是读取点） |

★ 为什么"没配"必须是**可读出来的状态**而不是 `null`：`tool-request.mjs:639` 是
`if (pathScope === null) return undefined`（**放行**）。所以把"没配"读成"没有范围表"
就是**放行一切**（§9.3）。反过来把"没配"读成"拒绝一切"也不对——那让一个还没配过的
部署整个起不来，于是操作者学会的做法是"随便填一张表让它闭嘴"。

> 一个"没配就当作没有限制"的读取点，
> 与一个"没配就当作全部禁止"的读取点，
> 在汇总表里都很干脆——只不过前者把漏配洗成了放行，后者把漏配洗成了严格。

### ★★ 本轮我自己的一个真错（被用例抓住）

第一版只判 `isPlainObject(merged)`。而 `configValueAt()` 走的是 **`merged.value`**
（它收的是 `loadProductConfig()` 的产物）。于是调用方传一份**裸配置对象**时，
两半**都**读成 `absent`：

> 一个"传错了形状"的输入，与一个"这次部署确实没配"的输入，
> 在 `absent` 上长得一样——只不过前者会安静地把执行面两半都判成缺席，
> 而它的报错方式（如果有）是"没配"，不是"你传错了"。

**抓住它的是夹具**：我按 `loadProductConfig()` 的真实形状写夹具时，6 条用例变红。
修法是把 `value` 也要求为普通对象 ⇒ 变成一次**具名拒绝**。
用例 ③ 现在钉住"传裸配置 ⇒ 具名拒绝"，并有一条反向对照（包上 `value` 之后
**同一份内容**就正常了 ⇒ 拒绝的理由确实是那一层，不是配置内容有问题）。

★ 顺带一条同形状的读数：修这条时我还写错过一处用例断言（把 `tools` 写成字符串数组、
把 `policy` 写成对象），三次变红都是**注册表**给出的具名拒绝
（`connector-declaration-malformed` / `connector-capability-unknown` / `connector-policy-unknown`）。
那是**好事**：它说明"落到真读者上"这条纪律真的在起作用——
只对着自己产出的对象断言，这三个错一个都不会被发现。

### 边界（如实）

- **还没有生产调用方**。把两半挂上 `RunRequest` 是§9.2 的第 4 步，本轮没做。
  所以可达性基线里 `product/execution-plane-config.mjs` 分类为 `gap`（指向本节）。
- **用例登记一度被挡，但登记本身做成了**。经过：我准备往
  `scripts/ci/run-ci.mjs` 的套件清单加一行时，那个文件正带着**别的会话的在制品**
  （一个 `MEASURE` 读数机制，+23 行）。按纪律不碰，我停下来问了业主；
  业主同意"只暂存我那一块"。**而在动手的那一刻，那个会话已经把它的改动提交了**
  （`e217982`）⇒ 阻塞自己消失了，按常规方式登记即可。已登记进 `product-config` 套件。

  ★ 这一段值得留着，因为它是**同一个形状的第三次**：

  > 一个"我现在被挡住了"的判断，与一个"我五分钟前被挡住了"的判断，
  > 在计划文档里长得一样——只不过前者会让人等，而后者只该让人**再量一次**。

  本轮我为"别人的在制品"停下来问过一次，而那次停下的前提在我问出口时就已经过期了。
  上一节 §8.3.1 那两条错误的阻塞理由，是同一个形状。


---

## 9.5 第 4 步落地：**范围表 → 执行面端口**，并接进生产组合根（2026-09-18）

### 先订正一处框架错误

§9.2 第 3 条写的是"再挂上 `RunRequest`"。**那是错的**——量下来：

| 想找的东西 | 实测 |
| --- | --- |
| `runtime/contracts/run.mjs` 里的 `pathScope` 字段 | **0 处**（`RUN_REQUEST_REQUIRED` 与投影字段里都没有） |
| `pathScope` 的生产消费者 | `tool-request.mjs:642` 的 `pathScope(projection)`，来源是**组合根入参** |
| 生产组合根传给 `installEnforcementRoot` 的键 | `{ env, decide, createRequestApproval }` —— **只有三个**（接线前 `:485`，现在 `:508`） |

⇒ 真正的接缝是 **`installEnforcementRoot({pathScope})`**，而且它要的是一个
**函数**（表 + 一次投影 → 一个判定），不是一份表。

> 一个"挂上 RunRequest"的施工计划，与一个"接线其实在组合根入参上"的现实，
> 在文档里长得一样——只不过前者会让你去改一个**根本不该装这个数据的契约**。

（这与 §8.3.1 是同一个形状：**框架写错了，而写错的那一版看起来更像计划**。）

### 交付物

| 文件 | 内容 |
| --- | --- |
| `runtime/dsh-composition/scope-port.mjs` | 表 + 解析器 → `pathScope(projection)` 端口；`scopePortFromEnv()` 从环境取表 |
| `runtime/dsh-composition/scope-port.test.mjs` | 16 例；7 条变异全部咬住、每次还原逐字节相同 |
| `runtime/dsh-composition/plugins/root-row.mjs` | 生产组合根：读 `LEGION_PATH_SCOPE` → 接上端口；读不出来则**拦装配** |
| `runtime/config-schema.mjs` | 登记新 env 键 `LEGION_PATH_SCOPE` + 两条动态读取（`scan --check` 逼出来的） |
| `runtime/dsh-composition/production-scope-wiring.test.mjs` | ① 改钉"键在 + 没配仍是 false"，新增 ①b"配了翻成 true" |
| `scripts/config/config.test.mjs` | 四条**数出来的**锚点跟着改（env 键基线 10→11，Trap 1 计数 7→11 / 5→7 / 2→4） |

### ★ 这一截填的是哪个洞（一句话）

`tool-request.mjs:639` 是 `if (pathScope === null) return undefined`（**放行**），
而在此之前**全仓没有任何地方**把一份范围表变成那个函数：

- `path-scope.mjs` 有判定（`checkPathScope`），要的是一份表 + 一次具体调用；
- `scope-table-binding.mjs` 把**部署配置**装配成那份表；
- **中间那一步原先不存在** ⇒ 端口恒为 `null` ⇒ 每次工具调用都从那一行放行。

### 三个 fail-closed 决定（都不是新发明，是别处已经定过的）

| 决定 | 依据 |
| --- | --- |
| 方向未知 ⇒ 按 `write` 判 | `tool-request.mjs:365`："`unknown` 工具的方向是 `write`（fail closed）"；用 `=== 'write'` 会让未登记工具被读成"不是写" |
| 目标缺失 ⇒ 拒绝 | 投影成功时目标一定在（`deriveTarget()` 推不出来就**抛**）⇒ 这个分支只可能是接线坏了，而"证明不了它在范围内"必须是拒绝 |
| 表在**装配期**就校验 | 一个"第一次工具调用时才炸"的表，把错误推迟到**已经有副作用的那一刻** |

★ 还有一处**不推导**：本模块**只读** `projection.canonicalTarget` 与
`projection.direction`，绝不从 `arguments` 里再找一遍路径。依据是
`tool-request.mjs:378` 那条原话：

> 一个「在适配器里顺手补一次字段兜底」的桥，
> 与一个「两个强制点看到两个不同目标」的桥，是同一个东西。

### ★★ 一个与"跳过"有关的实测（值得单独记）

链接逃逸那条用例，我第一版写成"建不了符号链接就 `return`"。实测 Windows 上
`symlinkSync` **EPERM** ⇒ 它**静默跳过**了，而摘要是 `fail 0`。
那正是本仓反复记账的陷阱：**"跳过"在摘要里与"通过"长得一样。**

改成两条之后：

1. **确定性**用例（注入式解析器 + POSIX 路径）——**永远跑**，不依赖平台能建链接；
2. 真 fs 那条，建不了链接时**打一行可见的警告**并说明"逃逸判定由第 1 条覆盖，不靠这条"。

顺带量到一条我之前不知道的机制：`checkPathScope` **只在 `exists` 报真时才调
`realpath`**。所以那条例外用例里 `exists = () => true` 是**必须的**——
否则解析器根本不被调用，用例会以"放行"失败，看起来像判据坏了，其实是用例坏了。

### ★★ 接线做对了的一个机器可核证据

可达性基线 **49 → 47**：`runtime/dsh-composition/path-scope.mjs` 与
`scope-table-binding.mjs` 从**不可达**变成**可达**。

> "它的判定写好了，只是没人给它一份表"这句话，
> 现在有了一条能自动红的读数——它不再是一句自述。

### 仍未做（如实）

- **Launcher 那一侧**：`LEGION_PATH_SCOPE` 谁来**写**进 Runtime 子进程的环境。
  今天只有 Runtime 侧会**读**它。所以这条链要真正跑起来还差"部署配置 →
  `buildChildEnv`"那一步；而 `product/launcher/launcher.mjs` 此刻是**别人的在制品**。
  给部署配置的键**已经登记好了**（`runtime.pathScope`，§9.4），
  且 `product/execution-plane-config.mjs` 就是为它准备的读取点（仍记为 `gap`）。
- `whitelist`（岗位白名单）与 `execution-scope` / `external-api-scope` 两道**仍未接**。

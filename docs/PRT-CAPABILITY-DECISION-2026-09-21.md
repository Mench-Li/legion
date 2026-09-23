# 决策清单 · 「四项必需能力」该按什么处理（2026-09-21）

> ★★ **业主已裁决：走「乙」**——`tool-permission-enforcement` 由**产品自己认**，
> **移出 `REQUIRED_CAPABILITIES`**，进 `OPTIONAL_CAPABILITIES`。
> **实施记录见文末 §5**（含安全论证与破验读数）。

> 本文件**只做一件事**：把上一轮那句"产品决定 ⇒ 我按三项分别处理"摊成可勾选项。
> 产品侧此刻仍有并行会话在途，本文件是唯一新增物。

---

## 第 0 件：先撤我上一轮的一句话（我核错了）

上一轮我写：「`tool-permission-enforcement` 的 `false` 是**口径错位**，
⇒ **改引用同一份判定**」。

**这句不成立，我撤回。** 核实过程：

```
runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs:579  runtimeCapabilityEvidence(ctx)
  → 唯一读 ctx 的地方是 structuredResultEvidence(ctx)（L580）
  → 另外三项是**字面量**：L583-606 里没有任何一次 ctx.get / 环境读取
```

而它的 `ctx` 是**注册期**的 ctx，`startupSelfCheck` 的输入里也没有 `probeSandbox`：

```
bootstrap.mjs:247   probed  = await probeFactory(...)        ← ① 探针（算能力表）
bootstrap.mjs:264   check   = await run({composition, sandbox,
                          runtime: {ok: probed.ok === true}})  ← ② 自检
selfcheck.mjs:135   const { composition, sandbox, runtime, guardProbe, availabilityProbe }
                    ← ★ 没有 runtimeHost / 没有能力表，拿不到 probeSandbox
```

所以"让它引用同一份判定"**今天连不进去**；能接进去的只有 `probed.ok`
（自检② 已经在吃它），而那对 `tool-permission-enforcement` 是一个**必然为假**的输入
⇒ **改引用不会给出真值**，只会给出一份**看起来有依据**的假值。

> 一个"我建议改引用"的方案，与一个"那个引用接不进去"的事实，
> 在我只读了理由（`reason` 那三行）而没读**谁在被读**的时候，是同一个东西。

⇒ 那三项的正确读法是：**它们不是"算错了"，而是"被设计成不回答"。**
`REQUIRED_CAPABILITIES` 里放着一个**产品侧**的能力，而这个探针在**引擎侧** ⇒
它诚实地报"我不判这个"。**这是对的，不是缺陷。**

---

## 第 1 件：于是真正的决定只有一句

> **`tool-permission-enforcement` 应该由引擎报，还是由产品自己认？**

| | 选项 | 含义 | 代价 |
|---|---|---|---|
| **甲** | 留在必需表，但**换判定方** | 由 Legion 产品侧（自检那两项）来认领这一项，引擎探针不再对它表态 | 要定义"产品自检通过 ⇒ 这张表怎么被读到"；且自检② 已经在吃 `probed.ok`，**存在环**要理清 |
| **乙** | **移出必需表**，放进 `OPTIONAL_CAPABILITIES` | "强制面由 Legion 补丁层实现"变成一个**产品事实**，不再是引擎能力；引擎不再被追问 | 表从 4 项变 3 项；`wire.test.mjs:418` 那条判据要改；**要论证这不是放宽** |
| **丙** | 维持现状 | 承认「自检不兼容 ⇒ 不自动执行」是本设计的正确行为 | 那 22 条红 / 6 个套件要按"按设计关着"**重定基线**，且**逐族**做（有一族是反向对照，修法不是改期望） |

★ 我**倾向乙**，理由是：`REQUIRED_CAPABILITIES` 的注释说它管的是
「执行器**必须**声明支持的能力键」，而 `tool-permission-enforcement` 的实现
**不在引擎里、在 Legion 自己的补丁层里** —— 拿引擎能力表去问一件引擎不负责的事，
本身就是那张表**放错了位置**。而 `OPTIONAL_CAPABILITIES` 的注释恰好写着
「缺失时应**禁用对应产品功能，而不是报错**」—— 语义对得上。

★ 但**这是我倾向，不是我的裁决**。请勾。

---

## 第 2 件：另外三项各自怎么处理（都**不**需要你现在裁决）

| 能力 | 建议动作 | 成本 | "不做会怎样" |
|---|---|---|---|
| **`usage-reporting`** | **先接已有来源**：`scripts/prt/dsh-session-usage.mjs` 能从会话转录读出真用量 | 中（要定义"单次 run 怎么归因"——⚠️ **该工具今天只读到会话级，未验证单 run 归因**） | 一项**已经有数据**的能力一直报"没有来源" |
| **`cancel-and-timeout`** | **先立一次读数**：看门狗是否真收得住那次挂死 | 高（要造一次真挂死） | 「引擎能保证」与「Legion 替他兜住」继续共用一格，而该不该共用**没有依据** |
| **`structured-result`** | **不动**——它已经在**算**（`structuredResultEvidence(ctx)`），只是现场常判 false（注册表空/多 provider） | —— | —— |

★ 注意第三行：`structured-result` 也是 `satisfied: false`（L515/530/539/556），
但它走的是**函数**。所以"三项写死 false"这句话的准确边界是
**三项字面量 + 一项函数**，不是"四项都写死"。

---

## 第 3 件：这条决定**不**影响什么（免得被当成大开关）

- 它**不**决定产品能不能自动执行：`adapter.mjs:108` 是"任一必需能力缺失即
  `UNSUPPORTED_CAPABILITY`"，所以就算把这一项挪走/认领，
  **另外两项仍然是 `false` ⇒ 仍然不兼容**。
- ⇒ 这一条**只解决"那一格说的是不是真话"**，**不解决"产品能不能跑"**。

> 一份"把这一格改对了"的读数，与一份"产品能自动执行了"的读数，
> 在只看"少了几个红"的时候是同一个东西——只不过前者一条端到端用例都不会变绿。

---

## 第 4 件：本轮**没做**的事（如实记）

- 未改任何生产代码（`runtime/`、`product/`、`orchestrator/` 一行未动）
- 未改任何 fail-closed 语义（那三项 `false` 一字未动）
- 未重定那 22 条红的基线（那是第 1 件的**后果**，得先有裁决）
- `scripts/probes/_probe-r117-caps.mjs` 的夹具**没造出"补丁层生效"的组合**
  （`reconcilePatchLayer` 在 `patchVersion=1` 下仍报 `effective:false`），
  所以那个探针**没有给出产品结论** —— 它只给出了"那三项不读任何输入"这个**源码事实**。
  ⚠️ **不要把那份输出读成"补丁层没生效"**：那是我的夹具不完整，不是产品读数。

---

## 5. ★★ 实施记录（业主裁决「乙」之后，2026-09-21）

### 5.1 改了哪 7 个文件

| 文件 | 改动 |
| --- | --- |
| `runtime/contracts/adapter.mjs` | 那一项移出 `REQUIRED_CAPABILITIES`（4→3）；新增 `PRODUCT_PLANE_CAPABILITIES`；`OPTIONAL_CAPABILITIES` 收它进来（作为子集）；`checkCompatibility` **两类措辞分开**，并多回一个 `missingProductPlane` |
| `runtime/contracts/index.mjs` | 转出新常量 |
| `runtime/contracts/contract.test.mjs` | 两条改向（产品面那句**不许**混进"应禁用对应功能"）+ 一条反向控制 + 一条表关系 |
| `runtime/contracts/wire.test.mjs` | ⑥ 的锚点从那一项换成 `cancel-and-timeout`（那条用例钉的是"表从契约来"，与表**内容**无关）+ 一条"不许回来" |
| `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` | **不再对它表态**（从 `evidence` 移除）；版本 4→5；头部那段"四项能力"改写；那个已退役的码**保留并写明为什么还在** |
| `.../runtime-host-registrar-row.test.mjs` | 两条被钉住的旧期望改向；**并把它守的"两个读数不许合并"不变量换载体保留** |
| `.../runtime-host-registrar-row-dsh-process.test.mjs` | ② ③ 两段：项集改由 `REQUIRED_CAPABILITIES` 派生，并断言它**不许**出现在引擎自报的能力表里 |

### 5.2 安全论证（★ 这一步不能省，它回答"移除之后谁守强制面"）

**读数**（不是论证，是源码）：

```
selfcheck.mjs:139  name: 'composition-patch-layer'   ← 强制面判定①，**直接读补丁层**
selfcheck.mjs:183  name: 'enforcement-mapping'       ← 判定④
selfcheck.mjs:253  const failed = checks.filter((c) => !c.ok)
selfcheck.mjs:259  autoExecutionForbidden: failed.length > 0
```

⇒ `autoExecutionForbidden` 由自检的**六项**决定，**不是**由能力表决定；
而强制面由 ①④ **两项**守着，它们**直接读补丁层**。
**移走"问引擎"这一问，碰不到那一层判定。**

**破验 M6 专门证这一条**：把自检① 的 `ok` 改成恒 `true`（等于废掉强制面判定）
⇒ **咬住（红）**。也就是说：如果我这次**真的**削弱了 fail-closed，M6 会咬出来；
它没咬，说明减的是"问错人"的那一问，不是守卫本身。

### 5.3 破验（`scripts/probes/_mutate-r118-caps.mjs`）

```
✔ M1 产品面表被清空              → 咬住（红）
✔ M2 ★ 措辞合并（产品面塞进"禁用功能"句） → 咬住（红）
✔ M3 row 侧又对它表态            → 咬住（红）
✔ M4 产品面那句根本不发           → 咬住（红）
✔ M5 ★ 反向：引擎可选说成产品面    → 咬住（红）
✔ M6 ★★ 安全方向：废掉强制面判定   → 咬住（红）
还原逐字节相同：✔
```

★ 中途踩了两个坑，都记在脚本注释里：
① 变异锚点用逐字串 ⇒ 本仓是 **CRLF** 而源码写的字面串是 LF ⇒ 报"变异点找不到"，
而它与"判据没咬住"在输出里**只差一个字符**；
② 我第一版的修法是 `replace(/\\n/g, ...)` —— 那匹配的是**字面的反斜杠加 n**，
而锚点里是**真换行**，于是正则永远对不上。正确做法是把两边都规范化成 LF 再比。

### 5.4 门禁读数

```
runtime/contracts/contract.test.mjs                 48/48
runtime/contracts/wire.test.mjs                     30/30
runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs   51/51
runtime/dsh-composition/bootstrap.test.mjs          23/23
runtime/dsh-composition/e2e-assembly.test.mjs       19/19
runtime/dsh-composition/root.test.mjs               33/33
runtime/adapters/dsh/adapter.test.mjs               98/98
runtime/adapters/dsh/parity.test.mjs                37/37
runtime/adapters/dsh/session-boundary.test.mjs      33/33
orchestrator/worker/runtime-contract-client.test.mjs 38/38
product/launcher/doctor.test.mjs                    24/24
product/launcher/cli.test.mjs                       46/46
runtime/contracts/fake-adapter.test.mjs             19/19
check-docs / encoding-check / spec-progress / boundary-facts（30/30 红 0）/ progress-check  全 PASS
```

### 5.5 ⚠️ 一处**既有**的红，**不是我引入的**（如实记）

`runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs`
的 **N** 条（`RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`）失败，报的是
`service "legionRuntimeHostBinding" has been registered at <legion-runtime-host>`
（重复注册）。**隔离读数**：

- 把**我全部改动 stash 掉**（回到真 HEAD `4dc200f`）再跑 ⇒ **N 仍然红**（4 pass / 2 fail）。
- 受影响的那条 `读数对照` 是**连带**红：它依赖 N 留下的读数（报错原文
  "n 没有留下读数——上面某条用例没跑成"）。
- `runtime/dsh-composition/plugins/runtime-host-row.mjs` 正是**并行会话的在制品**
  （` M `，+40/-1），重复注册的 `provide(...)` 路径在那个文件里。

⇒ **N 是既有问题**，且与并行会话的在制品相关；**我这一批没有碰 N**，
也没有把它改绿（改它要动别人的在制品）。**不要把它记成本次改动的代价。**


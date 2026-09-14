# PRT-253（续）：`bindDshRuntime` 的生产调用方

> 这一批只关**一条**链：`bindDshRuntime()` 从"只有用例在调"变成"有一个真的挂得上
> 的生产调用方"，并在一个**真 DSH 进程**里读出绑定确实生效。
>
> 前一篇是 `PRT-253-runtime-adapter-migration.md`（适配器迁移），它的 §6「未交付」
> 第一条就是本文要关的那一条。

## 1. 这一批要解决的问题

`orchestrator/worker/executor-binding.mjs` 的 `bindDshRuntime()` 早就写好了，
`runtime/dsh-composition/bootstrap.mjs` 的 `bootstrapDshRuntime()`（先自检、通过才注册）
也早就写好了，两样都被用例钉住。而它们的共同处境是：

> `bindDshRuntime` 的定义在仓库里，**调用者不在任何生产代码里**。

后果不是"少一个功能"，而是三件已经交付的东西在真实部署里**从来没被行使过**：

| 已经交付的东西 | 谁会在生产路径上调它 | 没有调用方时它是什么 |
| --- | --- | --- |
| `EXECUTOR_CODES.HOST_PORT_REQUIRED` 的**反面**（拿到一个可用引擎） | `product/orchestrator/worker.mjs` 的 `productionExecutorProviderFromEnv()` | 永远是那条拒绝 |
| PRT-215「强制面未生效时禁止自动执行」 | 同上，经 `selfCheck` | 从来没被行使 |
| PRT-510 预算闸门（`budget-gate`） | `createProductionExecutor` 内的 `budgetActor` 分支 | 生产路径上永远不建 |

而 `runtime/dsh-composition/index.mjs` 的头部早就把这条口径写在仓库里了：

> 一个"有人可以调"的装配入口，与一个"从来没有被调用过"的装配入口，
> 在运行的部署上是同一个东西——只不过前者的用例是绿的。

## 2. 交付了什么

### 2.1 `runtime/dsh-composition/plugins/runtime-host-row.mjs` —— 生产调用方

一行 Cordis 插件，形状与同目录另外三行一致（`name` / `inject` / `apply`，按路径被加载）。
它在 `apply` 期做四件事：

1. 从**真 DSH 组合树**读组合观察结果（见 §3.1）；
2. 从**真 DSH 服务**取沙箱端口（`ctx.sandbox`）；
3. 从**注册缝**取宿主端口（`{startRun, probeRuntime}`）与 `canRead`；
4. 调 `root.bootstrap(...)` → `bootstrapDshRuntime()` → `bindDshRuntime()`，
   把结论作为服务 `legionRuntimeHostBinding` 发布出去。

四样输入**来源逐一列在文件头的表里**，每一样缺了都报一个**具名的、互不相同**的码：

```
RUNTIME_HOST_ROW_NO_CONTEXT               不是 Cordis Context
RUNTIME_HOST_ROW_NO_ENFORCEMENT_ROOT      组合根服务不在
RUNTIME_HOST_ROW_ENFORCEMENT_ROOT_REFUSED 服务在，但它是一份拒绝
RUNTIME_HOST_ROW_ROOT_SHAPE_INVALID       服务在、也不是拒绝，但形状不对
RUNTIME_HOST_ROW_NO_INPUTS_FACTORY        没有人注册宿主端口工厂  ← 今天唯一缺的那一样
RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW     工厂自己抛了（带上它抛了什么）
RUNTIME_HOST_ROW_NO_HOST_PORT             工厂没给端口（或给的形状不对）
RUNTIME_HOST_ROW_NO_CAN_READ              工厂没给 canRead
RUNTIME_HOST_ROW_NO_COMPOSITION           组合树读不到 / 零条目
RUNTIME_HOST_ROW_NO_SANDBOX_PORT          沙箱服务不在
RUNTIME_HOST_ROW_BIND_REFUSED             内层 bootstrap 拒绝了（内层码原样带出）
```

### 2.2 `runtime/dsh-composition/plugins/runtime-host-row.test.mjs` —— 23 条

四组：组合树观察（含 `patch-over` 映射，见 §3.1）、每一样输入一个拒绝码、
交出去的四样输入**按引用**核对、真 cordis Context 上的依赖语义（顺序无关 + 反序控制）。

### 2.3 `runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs` —— 4 条，真 DSH 进程

见 §4。

### 2.4 `runtime/dsh-composition/index.mjs`

加了本行的出口（与 `root-row.mjs` 的出口同一处、同一条理由）。**没有**动
`PATCH_LAYER_ROWS`、**没有**动 `legion-host.patch.yml`、**没有**动
`DSH_COMPOSITION_PATCH_VERSION` —— 理由见 §5。

## 3. 四样输入各自的来源（这是本批要回答的问题）

### 3.1 `composition`：**有**真来源，由本行自己读

`bootstrapDshRuntime()` 要一份 `{rows: [{id, activated}], permissionPresets}` 的观察结果。
在真 DSH 进程里这份东西**真的存在**：`ctx.get('loader')` 就是那个 loader，
`ctx.loader.entries()` 给出每个补丁行条目的 `options` 与 `fiber.state`。

实测读数（本批，一次性 `DSH_HOME`，`bundles: []`，见 §4 的场景）：

* 补丁行的声明 `id` **确实**在 `entry.options.id` 上；
* 加载完成的行的 `entry.fiber.state === 2`；
* 这就是 `reconcilePatchLayer()` 要的 `{id, activated}`。

**但只按 `options.id` 一对一地读是读不全的**，而且这条错得很安静。本批在真 DSH 进程里量到：

```
legion-enforcement-permission-presets: 补丁层行未出现在组合树中（预期锚点：patch-over）
```

原因是结构性的：`PATCH_LAYER_ROWS` 里 `legion-enforcement-permission-presets` 那一行是
`patch-over`，补丁文件顶层的 `id` 是**被覆盖的目标**（`permission`），Legion 自己的行 id
**刻意不出现**——`composition.test.mjs` 把这一条写成了断言
（"它的 id 出现才说明我们写错了，会打不到靶子"）。

所以一个只按树条目的 id 逐行对账的观察器，会为那一行**永远**报 `ROW_MISSING`，
于是 `startupSelfCheck` 永远判"强制面未生效"，于是 `bootstrapDshRuntime()` 永远拒绝注册：

> **任何**生产调用方都再也绑不上——而这条链上每一个用例都可以是全绿的。

本批的处理是按**声明**做一次映射：`patch-over` 行报成它 `mount.target` 那条树条目的
激活状态，行 id 用声明里的那个。这个映射的分量说清楚：

* 它读的是"**被覆盖的那一行在不在、活没活**"；
* 它**不是**"覆盖真的落上去了"——后者由 `permissionPresets` 那一条**独立**判定
  （Legion 的 preset 名解析得到才算），两条会分别坏掉，所以分开。

映射是从 `PATCH_LAYER_ROWS` **推导**的（`mount.anchor === 'patch-over'` → `mount.target`），
不写死 `'permission'`：写死的那一份会在补丁层加一行的当天变成假话。

### 3.2 `sandbox`：**有**真来源（`ctx.sandbox`），但本批的读数里它是替身

`probeSandbox` 要 `{confine}`，返回的 `argv` 必须**真的变了**、`enforcement` 必须是
`'full'`、`denialSignatures` 必须非空。`ctx.sandbox` 是合法的读取位置，本行读的就是它。

⚠️ 但在本批的**测试**里它是一个替身：`bundles: []` 的一次性 profile 里没有提供沙箱服务的
bundle。所以"本机沙箱真的在管制"**不是**本批的读数（见 §6）。生产上这一样来自 DSH 的
沙箱服务，本行只是按契约取。

### 3.3 `runtimeHost`（`{startRun, probeRuntime}`）：**没有**合法来源 → 走注册缝

这是本批最要紧的一条**否定**结论。

* `startRun` 有真来源：DSH 的 `ctx.subagents.start(provider, options)`
  （Legion 自己的 DSH 插件就是这么调的，`plugins/src/index.ts`）。
* **`probeRuntime` 没有。** `probeRuntime(host)` 要从宿主那里读到
  **版本**与**四项必需能力**（`REQUIRED_CAPABILITIES`：`tool-permission-enforcement` /
  `cancel-and-timeout` / `structured-result` / `usage-reporting`），
  而全仓库**没有任何生产实现**提供这两个读数。实测过一个真 DSH 进程里
  `ctx` 上能看见的服务（`ctx.get(name)` 逐个问）：没有版本服务、也没有能力服务。

于是本行**不造一个**。理由就是这个仓库反复写下的那条禁令：

> 一个"能力表全 true"的默认值，会让 `checkCompatibility` 在一个**从未验过**的引擎上
> 判"兼容"——而它的读数与"真的验过"完全同形。

`canRead` 同理（§3.4）。两样都只能由**知道答案的那一侧**注册进来，
所以本行提供注册缝（`setDshRuntimeInputsFactory()`，返回幂等注销函数），
形状与 `root-row.mjs` 的 `setApprovalPortFactory()` 完全相同。

**方向**：注册方应当住在 `team-hub/` 或 `product/` 一侧——`runtime/` **不得** import
`team-hub/`（`scripts/ci/dsh-boundary.mjs` 的 import 图，本批跑过）。这与审批端口工厂
（`team-hub/approval-registrar-row.mjs`）是同一条取舍。

**⛔ 今天没有生产注册方。** 缝里那一件是本批**没有**交付的东西，而且是**唯一**还缺的
那一件。它没有被含糊过去：没有工厂时本行以 `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`
当场拒绝（§4 的场景 C 在真 DSH 进程里读到了这个码）。

### 3.4 `canRead`：**没有**合法来源 → 同一条缝

`canRead` 是**装配阶段**的权限判定。全仓库的 `canRead` 实现清一色是 `() => true`
之类的**用例替身**（`grep canRead`）。默认放行会让一次接线遗漏变成一次静默越权，
默认拒绝会让它静默停摆——两者都不报错。所以由调用方显式给，本行不猜。

## 4. 真 DSH 进程里的读数（本批的核心证据）

`runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs` 跑四个场景。
每个场景一个**新的一次性 `DSH_HOME`**（`os.tmpdir()` 下、spawn 前断言）、
`dsh.profile.bundles: []` + `patchReload: 'startup'`、从环境里删掉 `DSH_SNAPSHOT`、
`spawnSync` 带超时、`after()` 整棵删掉。**没有**读写任何真实 profile。

三个场景的补丁层：

```
[services(替身 tools/approval/sandbox) ,
 permission(替身权限行) ,
 真 legion-host.patch.yml（一个字节都不改） ,
 runtimeRows(真的 pre-execute-row / approval-answerer-row) ,
 ← 只有 A/C 才有：本行 ,
 probe]
```

原始读数：

```
✔ A. 本行挂上：worker 自己的 productionExecutorProvider() 不再报缺端口
ℹ   A: ok=true code=none
✔ B. 反向对照：不挂本行（其余一字不变）→ 两个读数都反转
ℹ   B: ok=false code=EXECUTOR_HOST_PORT_REQUIRED
✔ C. 本行挂上、但没有人注册端口 → 真进程里具名拒绝（exit 1）
ℹ   C: 具名拒绝 RUNTIME_HOST_ROW_NO_INPUTS_FACTORY
✔ D. 三个读数两两不同形
ℹ   A=ok=true code=none / B=ok=false code=EXECUTOR_HOST_PORT_REQUIRED / C=RUNTIME_HOST_ROW_NO_INPUTS_FACTORY
```

判据不是"这一行被加载了"，也不是"文件里有这个 import"，而是 **worker 自己的读数**：
探针 import 的是 `orchestrator/worker/executor-binding.mjs` **本身**
（`dshRuntimeBound()` + `productionExecutorProvider()`），不是副本、不是测试专用接口。

* **A**：绑定生效之后，worker 从生产路径**造出了一个引擎**（`ok=true code=none`）。
  不是"少了那个错误码"，是正面读数。
* **B**：与 A 只差**一行补丁**（不挂本行）。两个读数都反转：`BOUND false` +
  `EXECUTOR_HOST_PORT_REQUIRED`。
* **C**：与 A 只差"工厂在不在"（把产品自己的行模块当补丁行挂，= 行交付了、没人注册端口的
  那种部署）。真进程 exit 1，具名码 `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`。
  **不是静默 no-op。**
* **D**：三个读数两两不同形。分开成立推不出"它们是三个不同的读数"——
  一个把任何输入都读成同一个值的探针能让 A/B/C 同时"通过"。

### 4.1 顺带钉住的两条 Cordis 语义（都是被真进程咬出来的）

第一版实现在**假 Context 上全绿、在真进程里连错三次**。三条都不是风格问题：

1. **`ctx.get(name, x)` 的第二个参数是 `strict`，不是 fallback。**
   服务缺席时一律返回 `undefined`。第一版把它当 fallback 用
   （`ctx.get('sandbox', NOT_MOUNTED)` + 自造哨兵），于是沙箱缺席会被读成沙箱在场。
2. **`async apply` 不能返回一个普通对象。** Cordis 把 `apply` 的返回值当**效果**收集：
   async `apply` 解析出的值会走 `effect.then(safeCollect)`，一个既不是函数、又没有
   `then` / `Symbol.iterator` 的对象会报 `TypeError: Invalid effect`，
   **并且连带把这一行已经 `provide` 出去的服务一起回滚掉**。
   `ctx.effect` 收的是"**返回 disposer 的回调**"，不是 disposer 本身。
3. **组合根服务是"安装结果"，不是组合根。** `root-row.mjs` 发布的是
   `installEnforcementRoot()` 的 `{ok, code, message, root}`，`bootstrap` 在
   `installed.root.bootstrap` 上。第一版把服务值当组合根用 → 在真进程里报成
   "服务不在"，把"形状读错了"报成了"没装组合根"——所以本批给它单开了一个码
   `RUNTIME_HOST_ROW_ROOT_SHAPE_INVALID`。

## 5. 为什么本行**不进**静态补丁层（也是为什么本批不改版本号）

一行"挂上去、然后在 `apply` 期以具名码拒绝"的行，一旦进静态补丁层，后果是
**每一个 DSH Runtime 进程都起不来**——PRT-214 文档 §9 的读数 C 就是这个形状。

那在 root 行上是**对的**（被要求装上的强制面不能只写一行日志）。但本行**不是强制面**：
没有引擎绑定时，员工 harness 仍然可用，而 worker 侧照旧报 `EXECUTOR_HOST_PORT_REQUIRED`
且**不认领任何任务**——那是**可见**的降级，不是静默失效。让整个 harness 因为
"编排器绑不上引擎"而起不来，是拿一个大得多的故障去换一个小得多的故障。

所以本行的挂载是一个**显式步骤**，等真的端口工厂落地之后与
`PATCH_LAYER_ROWS` 的登记 + `DSH_COMPOSITION_PATCH_VERSION` 的递增**一起**做。
本批**不做**那两件事还有第二条理由，是本批量出来的：递增补丁层版本会连带要求
`runtime/packs/builtin/software-delivery.mjs` 那几处 host 版本跟着走，
而那是打包权威面（`runtime/packs/authority.mjs`）的地盘——不属于本批。

## 6. 诚实边界

### 6.1 绑定**确实**在一个真 DSH 进程里生效了吗？——是，但只在 §4 那套装配下

**是**：场景 A 里，一个真的 `dsh --profile … --patch …` 进程启动成功，
本行 `apply` 跑完，`orchestrator/worker/executor-binding.mjs` 的
`productionExecutorProvider()` 返回 `ok=true code=none`。
那不是一个替身的自报——那就是生产路径上那个模块。

**但**：那套装配里有三处替身，各自的分量不同：

| 装配件 | 真 / 替身 | 它意味着什么 |
| --- | --- | --- |
| 组合补丁层 `legion-host.patch.yml` | **真**（一个字节都不改） | 组合树观察是真读数；`patch-over` 真的打到了靶子 |
| `pre-execute-row` / `approval-answerer-row` | **真** | 那两行真的 ACTIVE |
| `tools` / `approval` 服务 | 替身 | 只为让那两行激活；**不**代表 ToolRuntime |
| `permission` 行 | 替身（真实部署里由 DSH bundle 提供） | 只为让真 `patch-over` 有靶子；不含任何权限语义 |
| **宿主端口 `{startRun, probeRuntime}`** | **替身** | **本批没有交付真端口。** 它证明"调用方与绑定链在真进程里是通的"，**不**证明"真 DSH 引擎被验过兼容" |
| **`canRead`** | **替身**（`() => true`） | 只证明这一样输入被**原样交到**绑定里；不证明权限判定接对了 |
| **沙箱端口 `confine`** | **替身**（报 `full`） | 只为让启动自检的这一路走得通；**不**证明本机沙箱在管制 |

### 6.2 宿主端口有合法来源吗，还是只能桩？——只能桩（今天）

见 §3.3。`startRun` 有真来源（`ctx.subagents.start`），**`probeRuntime` 没有**：
版本与四项必需能力在仓库里没有任何生产读数来源。本行**不编**一个默认值，
而是留在具名拒绝上（`RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`），并把缝留给
依赖方向允许的那一侧（`team-hub/` / `product/`）去注册。**今天这个缝是空的。**

### 6.3 本批**刻意没做**的部署工作

* **没有**把本行写进 `legion-host.patch.yml`（理由见 §5），因此
  `dshCompositionPatchVersion` 不变，`PATCH_LAYER_ROWS` 不变。
* **没有**写任何"把补丁层写进一个 profile"的代码。`runtime/dsh-composition/index.mjs`
  里那条"本目录不含写入 profile 的代码"的性质**保持不变**——操作者那台机器上的活
  harness 是 `patchReload: 'live'`，往它里面写会改到正在跑的进程（包括发起本批的会话）。
  本批全程只用 `os.tmpdir()` 下的一次性 `DSH_HOME`。
* **没有**带 bundle 的 profile 启动。§4 用的是 `bundles: []` 的一次性 profile，
  所以**没有**验证"在一个真的 DSH 部署里，`permission` 行本来就存在、
  `patch-over` 天然打得到靶子"。本批是靠替身那一行把这条链走通的；
  真实部署下这一条**预期**更简单，但本批没有量过。
* **没有**写任何生产端口工厂。所以真实部署今天的读数**仍然**是
  `EXECUTOR_HOST_PORT_REQUIRED`：本行在没有工厂时会**拒绝装配**，
  而它当前也不在补丁层里——**"调用方存在"与"部署上绑上了"是两件事**。
* **没有**跑 `scripts/ci/run-ci.mjs`（全量 CI），**没有**跑 `scripts/prt/*` 的
  反证脚本，**没有**改 `docs/STATUS.md` / `PRT-PROGRESS.md`。
* **没有**证明"一个真实任务被真的执行"：§4 只走到"worker 造出了引擎"，
  没有走到一次 `execute()`。黄金任务仍未跑过（这与 PRT-253 原文 §6 一致）。

### 6.4 静态门禁对本批的覆盖面（说清楚哪一侧**没**被覆盖）

`scripts/config/scan.mjs --check` 的 `PROCESSES` 覆盖 `team-hub/`、`product/`、
`orchestrator/`、`plugins/` 等，**不覆盖 `runtime/`**。本批的新文件全部在
`runtime/dsh-composition/plugins/` 下（外加 index 的一处出口），
所以：

> **`scan --check` 通过不是本批新代码被扫描过的证据**——
> 它压根不在那个扫描的进程清单里。

真正覆盖本批的静态门禁是 `encoding-check` / `ci-syntax` / `dsh-boundary` / `check-docs`
（它们按目录或全树走）。

`dsh-boundary` 还有一条与本批有关的读数：本批的新模块落在 `runtime/dsh-composition/`，
而基线里的 `adapterPrefixes` 恰好**豁免**这个前缀——所以哪怕它多一个 DSH 记号，
棘轮也是绿的。本批第一版在注释里写了一次 `ctx.<服务>` 的完整记号，于是本目录从
"0 个 DSH 记号"变成 1 个；那条豁免是**存在但刻意不用**的
（`patch-layer.mjs` 文件头写明了这一点）。已改回：

```
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
```

> 一个"豁免可用、于是顺手用了"的漂移，在门禁上**恰好是绿的**。

### 6.6 猜测 / 没把握的地方（逐条列）

1. **`ACTIVE_FIBER_STATE = 2`**：本批实测到的值（`fiber.state === 2` = ACTIVE，
   见 §3.1 与 §4）。我没有读 Cordis 的常量表去核对"2 就是 ACTIVE"这个名字，
   我是按"`apply` 已跑完的行读到 2、等待依赖的行读到别的值"来用的。
   除 2 之外的一切一律按**未激活**处理（保守方向）。
2. **`permissionPresets` 的来源**：我假设"生效的 preset 表"就是 `permission` 那一行
   `options.config.presets` 的键。这个假设的**依据**是 `reconcilePatchLayer()` 的注释
   （判据是 preset 名解析得到）与补丁文件的形状，不是我验证过 DSH 真的按这个 config
   建了 preset 表。要验它需要一次带 bundle 的启动。
3. **`--patch` 的层序 vs `patch-over` 的靶子**：本批量到"替身 `permission` 行必须排在
   真补丁层之前，patch-over 才打得到靶子"，并把它写成了测试注释。我没有去读
   DSH `applyEntryPatches` 的实现来确认这是**定义**行为还是本机现象。
4. **`ctx.get(name, strict)` 的第二参数语义**：我读了 `vendor/cordis/lib/index.js` 的
   `get(name, strict = true)` 来确认它**不是** fallback，并用真进程读数交叉验证过。
   这一条我认为是确定的；列在这里是因为它与我第一版的假设相反。
5. **`runtime-host-row` 该不该进补丁层**是一个**判断**，不是读数（§5 给了理由）。
   换一个判断的人可能得出相反结论；能定这件事的是"没有真端口工厂时该不该让
   Runtime 进程起不来"，那是个产品决定。
6. **注册缝该由谁注册**：我给的结论是"`team-hub/` / `product/` 一侧"，依据是
   `dsh-boundary` 的 import 图与审批端口工厂的先例。我没有去核对
   `product/launcher/` 那条 `dsh-overlay.mjs` 路径是不是更该承担这件事。

## 7. 验证（本批实际跑的）

全部在 `D:\project\DSH\legion\.worktrees\prt-runtime`（分支 `codex/prt-runtime`）下，
`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`：

| 命令 | 读数 |
| --- | --- |
| `node --test "runtime/dsh-composition/*.test.mjs"` | `tests 539 / pass 539 / fail 0` |
| `node --test "runtime/dsh-composition/plugins/*.test.mjs"` | `tests 59 / pass 59 / fail 0`（本批新增 27 条：23 + 4） |
| `node --test "orchestrator/**/*.test.mjs"` | `tests 329 / pass 329 / fail 0` |

加上 5 个静态门禁（`git add -A` 之后跑）：

```
node scripts/config/scan.mjs --check
node scripts/ci/ci-syntax.mjs
node scripts/ci/encoding-check.mjs --all --quiet
node scripts/ci/check-docs.mjs
node scripts/ci/dsh-boundary.mjs --check
```

读数见本批的交付回复（逐条原始输出）。

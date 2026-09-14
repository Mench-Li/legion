# PRT-253 解阻批：Runtime 宿主绑定拦在一个**没有读者的输入**上

> 本文回答一个问题，并**只**回答这一个问题：
>
> **把"Runtime 进程里必须有一个 `canRead` 来源"这条残留要求拿掉之后，
> 绑定真的建立得起来吗？拒绝有没有被松动？**
>
> 结论：**绑定建立得起来**（在一个**声明过的**能力探针替身下读到，原始读数见 §4）；
> **两条 fail-closed 一个都没放松**（同进程与跨进程两条路都仍然
> `EXECUTOR_CAN_READ_REQUIRED`，见 §2 与 §6）。
> 而**下一个**阻塞点不是接线，是"三项必需能力在这个进程里没有可确认的来源"（§9）。
>
> 本文不是"引擎接好了"的交付说明。它是**一条要求被拿掉之后的界桩**：
> 哪一条被拿掉了、为什么它是残留的、哪几条**没有**被拿掉、以及拿掉之后
> 真进程里到底读到了什么。

---

## 0. 一句话结论

`canRead` 是"这一次 Attempt 能读哪些上下文来源"的权限判定，它的权威在
EmployeeManifest / lease 上——**两者都在 worker 一侧**。而
`runtime-host-registrar-row.mjs` 跑在 **DSH Runtime 进程**里：那个进程里
**没有任何东西读这个绑定的 `canRead`**（五条测量见下）。为一个没有读者的输入
拦住整个绑定，是把两件不同的事压成同一条拒绝：

- "某个部署忘了接权限权威"（worker 进程的问题，**那里确实要拦**）；
- "这个进程里根本没有这个读者"（Runtime 进程的**正常**形状）。

所以本批：**缺席如实记成 `canRead: null`**，绑定照常建立；**执行**那一侧
（`productionExecutorProvider()`，同进程与跨进程两条路）读到不是函数 → 仍然
`EXECUTOR_CAN_READ_REQUIRED`。**没有**发明任何默认值、替身或"暂时放行"。

五条测量（都是读出来的，不是态度）：

| # | 测量 | 读数 |
|---|---|---|
| ① | `runtime/adapters/dsh/port.mjs:44,47` | 必需方法是 `['startRun','probeRuntime']`，可选是 `currentModelSelection`/`subscribeRun`/`listModels`——**端口契约里没有权限面**；同文件 `canRead\|permission\|readScope\|acl` **0 命中** |
| ② | `runtime/dsh-composition/enforcement.mjs` | `canRead` **0 命中** |
| ③ | 全仓库读"某个绑定的 `canRead`"的地方 | **只有** `orchestrator/worker/executor-binding.mjs` 的 `productionExecutorProvider()`，而它跑在 **worker 进程**里；跨进程那条路用**调用方**给的那一份 |
| ④ | `docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md` | `canRead` **0 命中**——它是 Legion 的实现概念，不是 spec 要求的输入 |
| ⑤ | 绑定在 Runtime 进程里**确有**读者 | `runtime-contract-server-row.mjs:415-416` 惰性读 `legionRuntimeHostBinding`，交给 `verdictFromRuntimeHostBinding()`（`:244-255`）——后者**只取** `{ok, state, patchVersion, checks}`。**`canRead` 不在其中** |

---

## 1. 改了什么（生产代码 4 个文件）

### 1.1 `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs`

- 默认工厂**不再**在"没有 `canRead` 来源"时抛 `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`；
  它返回 `{ runtimeHost, canRead: null }`——**缺席如实记成缺席**。
- `NO_CAN_READ_SOURCE` 的含义**收窄**（没有删除）：只表示"调用方**试图挂一个**
  不是函数、也不是 `null`/`undefined` 的 `canRead`"（构造期检查）。静默丢掉它，
  就再没有人看得出有人试图挂它。
- ★ 新接上 `currentModelSelection`（见 §5）：`runtimeHost` 现在有三个方法，
  多出来的那一个是端口契约里的**可选**方法。
- 文件头新写 `### currentModelSelection` 一节；`canRead` 那一节**改写**为
  "这个进程里没有读者 → 缺席就是缺席"，并把上面五条测量逐条落在里面
  （**没有删掉**旧的论证框架，是把它改成现在为真的话）。
- `RUNTIME_HOST_REGISTRAR_VERSION`: 1 → 2。
- 新增具名码集合 `MODEL_SELECTION_CODES`（4 个：读到了 / 服务缺席 / 服务形状不对 /
  返回值不是对象）与导出 `readModelSelection(ctx)`。
- "为什么本行仍然不进静态补丁层"从**三条理由减到两条**——删掉的那一条
  （"`canRead` 没有合法来源、工厂会以具名码拒绝"）已经不成立。

### 1.2 `runtime/dsh-composition/plugins/runtime-host-row.mjs`

- `apply` 里 `canRead` 由"必须是函数"改为：**可以是 `null`**（缺席），
  但**给了一个不是函数的值仍然当场拒** `RUNTIME_HOST_ROW_NO_CAN_READ`。
  交给组合根的那一份是 `null`（`input.canRead ?? null`）——**不是 `undefined`**。
- `NO_CAN_READ` 的含义同样收窄；文件头那张"四样输入各自的来源"表里，
  `canRead` 一行改成"可选：缺席合法，被如实记成 `null` 交下去"。
- 文件头里那句「⚠️ **今天没有生产注册方**」在注册方落地那一批之后就不成立了，
  顺手改成现在为真的话（注册方在 `runtime-host-registrar-row.mjs`；
  仍然缺的是**能力表**，即下一个阻塞点）。

### 1.3 `runtime/dsh-composition/bootstrap.mjs`

- `canRead` 由**必给**改为**可选**：`null`/`undefined` = "这个进程里没有来源"，
  原样交下去；给了个不是函数的值 → `BOOTSTRAP_BAD_WIRING`（当场拒，不静默丢）。
- 自检本身**从不调用** `canRead`（这一点上一批已经测住），所以它不需要一个"决定"。

### 1.4 `orchestrator/worker/executor-binding.mjs`

- `bindDshRuntime`：`canRead` 由**必填**改为**可选**；缺席存成 `canRead: null`
  （不是 `undefined`——那与"忘了写这个键"同形）；给了不是函数的值 → `TypeError`。
  `selfCheck` 仍然**必填**（一字未改：一个"没给自检就当通过"的默认值等于绕过 PRT-215）。
- ★ `productionExecutorProvider()` 的**同进程**分支**新加**一条：绑定里的
  `canRead` 不是函数 → `EXECUTOR_CAN_READ_REQUIRED`（`innerCode: null`）。
  为什么必须新加：本批之前这种绑定**根本不存在**（`bindDshRuntime` 当场就拒了），
  现在它存在了，所以"谁拒绝"必须有一个明确答案——而且是那个**具名**的权限码，
  **不是** `createProductionExecutor` 深处那条更笼统的 `BAD_WIRING`。
- **跨进程**分支（`crossProcessExecutorProvider`）与 `createProductionExecutor`
  的 `canRead` 要求（`executor.mjs:147`）**一字未改**。

---

## 2. 保留了什么（逐条 + 哪条用例会因为它被拿掉而红）

| 保留的拒绝 | 位置 | 拿掉它会让哪条断言红 |
|---|---|---|
| 同进程绑定没有 `canRead` → `EXECUTOR_CAN_READ_REQUIRED` | `executor-binding.mjs`（`productionExecutorProvider`） | `orchestrator/worker/executor.test.mjs` ④ ★★（会读到 `ok:true`＝一个"谁都能读"的引擎）；真进程：新套件 ③（`PROVIDERCODE` 会变成空） |
| 跨进程没给 `canRead` → `EXECUTOR_CAN_READ_REQUIRED` | `crossProcessExecutorProvider`（未改动） | `orchestrator/worker/runtime-contract-cross-process.test.mjs` 场景 G |
| `createProductionExecutor` 缺 `canRead` → `EXECUTOR_BAD_WIRING` | `executor.mjs:147`（未改动） | `orchestrator/worker/executor.test.mjs` ② "缺 `canRead`/`post`/`get` → 构造时拒绝" |
| `bindDshRuntime` 缺 `selfCheck` → `TypeError` | `executor-binding.mjs`（未改动） | `executor.test.mjs` ④；`bootstrap.test.mjs` ④；`root.test.mjs` 「`bind` 缺 `selfCheck` 当场抛」 |
| 挂一个**不是函数**的 `canRead` → 当场拒 | 四层各一处 | `runtime-host-registrar-row.test.mjs` C 段；`runtime-host-row.test.mjs` ⑧；`bootstrap.test.mjs` ②；`root.test.mjs` ⑦；真进程：新套件 ④ |
| 缺席必须是 `null`（不是 `undefined`／不是函数／不是空对象） | `bindDshRuntime` 归一 + 行透传 | `runtime-host-row.test.mjs` ⑫c；`can-read-authorization-boundary.test.mjs` E |

---

## 3. 真 DSH 进程读数：before / after

### 3.1 `before`：**真的旧生产代码**（`git stash` 掉本批的 4 个生产文件之后跑同一场景）

命令（工作树里，`DSH_CHECKOUT` 已设）：

```
node --test --test-name-pattern='换成生产注册方当那一行的模块' runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs
```

原始读数（**节选**；`（…）` 是我省略的同一段中文消息，码与结构一字未动）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to apply loader entry legion-runtime-host (file:///…/runtime-host-registrar-row.mjs):
  legion-runtime-host 拒绝装配：宿主端口工厂抛了：runtime-host-registrar 拒绝：没有任何 `canRead` 来源：…
  （code=RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE）
  …
  [cause]: Error [RuntimeHostRowError]: legion-runtime-host 拒绝装配：宿主端口工厂抛了：…（code=RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE）
    at rowError (…/runtime-host-row.mjs:345:15)
    at Object.apply [as callback] (…/runtime-host-row.mjs:429:13) {
      code: 'RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW'
    }
```

`exit=1`。这就是任务里那条
`RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE)`
的**原始形态**（不是我复述的）。

### 3.2 `after`：本批之后，同一场景（生产注册方当那一行的模块）

```
ℹ R: exit=1 RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
```

同一套件的完整尾巴：

```
▶ PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数
  ✔ N. 上一批的取值（组件本体当模块、没人注册工厂）→ `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY` (702.5045ms)
  ℹ N: exit=1 RUNTIME_HOST_ROW_NO_INPUTS_FACTORY
  ✔ R. ★★★ 换成生产注册方当那一行的模块 → 工厂**成功**，拒绝移到下一站（自检） (798.1609ms)
  ℹ R: exit=1 RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
  ✔ F. 注册方 + 注入的 canRead（替身）→ 未确认的能力在**启动自检**那一步后果可见 (804.3973ms)
  ℹ F: exit=1 RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
  ✔ S. ★★ 生产探针在真 DSH 进程里的读数：版本是真安装的版本，能力逐项有据 (3719.1332ms)
  ℹ S: version=0.1.5-rc.2 caps={"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false} defaultFactoryCanRead=canRead-null modelSelection=null/RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_ABSENT
  ✔ S2. S 的反向对照：桩 provider 把 `outputSchema` 报成 false → 那两项读数跟着变 (3716.3085ms)
  ℹ S2: structured-result=false RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_LACKS_OUTPUT_SCHEMA
  ✔ ★ 读数对照：注册方在不在分得开；**canRead 在不在分不开**；能力读没读到分得开 (0.2791ms)
  ℹ N=RUNTIME_HOST_ROW_NO_INPUTS_FACTORY / R=RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE) / F=RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE) [R===F：canRead 无读者] / canRead=canRead-null / model=null
✔ PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数 (9742.3789ms)
ℹ tests 6 / suites 1 / pass 6 / fail 0
```

**★ 本套件里新长出来的一条读数**：`R`（没有 `canRead`）与 `F`（注入了一个
`canRead` 替身）在绑定阶段**一字不差**——它们失败在**同一站**（启动自检的
`runtime-probe`），而 `canRead` 缺席/在场没有改变任何东西。这不是"两个场景碰巧都
失败"，这是"这个进程里没有它的读者"的**直接读数**（用例里是硬断言：
`assert.equal(READINGS.r.code, READINGS.f.code)` 与 `inner` 也相等）。

---

## 4. 绑定真的建立了吗（正例，以及**替身边界**）

新套件 `runtime-host-binding-unblocked-dsh-process.test.mjs` 的 ③ 场景：
生产注册方 + **一个声明过的替身**（能力探针）+ `canRead` **缺席**。

```
ℹ BEFORE-CONTROL: exit=1 RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE)
ℹ AFTER: exit=1 RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
ℹ BOUND: exit=0 bound=true serviceOk=true startFwd=true provider=EXECUTOR_CAN_READ_REQUIRED
ℹ BAD-CANREAD: exit=1 RUNTIME_HOST_ROW_NO_CAN_READ
ℹ MODEL-REAL: class=AgentDefaultModelConfig selection={"provider":"prt253bu-real-provider","model":"prt253bu-real-model"} code=RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_READ
ℹ MODEL-ABSENT: selection=null code=RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_ABSENT
ℹ tests 7 / suites 1 / pass 7 / fail 0 / duration_ms 16833.7805
```

`BOUND` 那一条的逐项断言（全部通过）：

| 断言 | 读数 | 意思 |
|---|---|---|
| `BOUND` | `true` | `dshRuntimeBound()` 为真＝注册口里**真的**多了一份绑定 |
| `SERVICEOK` | `true` | 本行把 `legionRuntimeHostBinding` 发布出去了（`ok: true`） |
| 没有 `BIND_REFUSED`/`NO_CAN_READ`/`INPUTS_FACTORY_THREW`/`NO_HOST_PORT` | — | 绑定**建立**（不是"换了一条拒绝理由"） |
| `exit` | `0` | 进程正常收尾（绑定成功时它活着） |
| `BOUND-WRAPPER-CANREAD-KIND` | `null` | 交出去的是**缺席本身** |
| `STARTFWD` + `SUBAGENTS-START-FORWARDED provider=prt253bu-spawn` | `true` | 生产 `startRun` 的那一跳**真的**到了现场服务 |
| `PROVIDERCODE` | `EXECUTOR_CAN_READ_REQUIRED` | ★ 同一个绑定，问真正要执行的那一侧：**缺席被保留到底** |
| `PROVIDERINNER` | `null` | 这是本进程的拒绝，**不伪装成**一次对端拒绝 |

**★ 替身的边界（必须与读数一起读）**：`BOUND` 里**唯一**的替身是
`probeRuntime` 的能力表（四项报成全具备）。其余全部是真读数：
版本来自真探针（`process.argv[1]` 所属安装的 `package.json`）、
`startRun` 是生产实现（按引用转发到现场服务）、组合树来自真补丁层、
沙箱自检与强制面装配走真路径。

**为什么非要有这个替身**：真探针在一个真进程里只能确认 **1/4** 项
（`structured-result`，读现场 provider 注册表）。另三项按**未确认**报是
**正确的**读数，于是真取值下的自检**必然**拒绝——`AFTER`（§3.2）读的就是那条。
所以："绑定建立得起来"这句话是在**一个声明过的替身**下成立的，
**不是**"真引擎下绑定建立"。

**`startRun` 不是替身**（这一条容易读反）：生产
`startRun: (provider, options) => subagents.start(provider, options)` 是按引用转发；
替身的是**这个一次性 profile 里那个服务**（`bundles: []` 没有真引擎）。
所以读数证明的是"**端口 → 服务**这一跳通了"，**不是**"真 subagent 跑起来了"。

---

## 5. 模型选择：来源是**真的** DSH 服务

`currentModelSelection` 是端口契约里的**可选**方法（`port.mjs:27,47`），
`index.mjs:250` 读它，`:455-457` 在它缺席时判 `MODEL_UNAVAILABLE`。

**形状先对过，不搬运**：端口要 `{provider, model, endpoint?, reasoningEffort?, limits?}`；
DSH 的 `currentSelection()`（`packages/core/agent-default-model/src/index.ts:49-57`）
给 `{provider, model, reasoningEffort?}`——前者所需的两项后者都给，后者多出来的
`reasoningEffort` 也在前者的可选表里。所以实现是**原样返回服务给的那个对象**
（一个字段都不搬），判据在用例里是 `assert.equal(got, raw)`（**按引用同一个对象**）。

`MODEL-REAL` 场景**没有**用手写替身：它把检出里**真的**
`@deepseek-ai/dsh-agent-default-model` 包（`packages/core/agent-default-model/lib/index.js`）
按**绝对路径**挂进一次性 profile（于是不需要 profile 依赖安装、不联网），
`provider`/`model` 用本次用例**显式配置**的两个值：

```
MODELSERVICEPRESENT true
MODELSERVICECLASS AgentDefaultModelConfig
MODELSELECTIONCODE RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_READ
MODELSELECTION {"provider":"prt253bu-real-provider","model":"prt253bu-real-model"}
PORTSELECTION {"provider":"prt253bu-real-provider","model":"prt253bu-real-model"}
ADAPTERSELECTION {"provider":"prt253bu-real-provider","model":"prt253bu-real-model","runtimeType":"dsh"}
LISTMODELS [{"id":"prt253bu-real-provider","provider":"prt253bu-real-provider","model":"prt253bu-real-model"}]
```

`MODEL-ABSENT`（不挂那一行）：

```
MODELSERVICEPRESENT false
MODELSELECTIONCODE RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_ABSENT
MODELSELECTION null
PORTSELECTION null
ADAPTERSELECTION null
LISTMODELS []
```

**★ 我真地观察到了一个真的 `agentDefaultModel`**：是，读数是
`MODELSERVICECLASS = AgentDefaultModelConfig`——真包、真装载、真 `ctx.get`、真读法。
而**另外**那套件（`-dsh-process`，`bundles: []`）里它**不在场**，读数是
`..._MODEL_SELECTION_SERVICE_ABSENT` + `null`——那一条不是"没验"，是
"如实报缺席"。**没有**任何一个读数里出现过编出来的模型名。

同时量到的一条**未证**：`provider`/`model` 是本用例声明的值；本套件**没有**
证明"某个真实部署的 `$DSH_HOME/settings.yaml` 会被读进来"（那要 `settings` 服务，
`bundles: []` 下不挂）。见 §7。

---

## 6. 单元与集成读数（改了哪些、为什么它们**能红**）

```
node --test "orchestrator/worker/*.test.mjs"                                  → tests 273 / pass 273 / fail 0
node --test "runtime/dsh-composition/*.test.mjs" "runtime/dsh-composition/plugins/*.test.mjs"
                                                                              → tests 709 / pass 709 / fail 0
node --test team-hub/context-replay-run.test.mjs team-hub/context-untrusted-authority.test.mjs
                                                                              → tests 13 / pass 13 / fail 0
node --test runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs → tests 31 / pass 31 / fail 0
```

改动的用例文件（7 个）与它们**新**钉住的东西：

| 文件 | 改动 | 怎么让它红 |
|---|---|---|
| `orchestrator/worker/executor.test.mjs` | ④ 拆成两条：`canRead` 缺席合法（注册口收下）；★★ 同进程 provider 读到缺席 → `EXECUTOR_CAN_READ_REQUIRED`，并有反向对照（给了函数 → `ok: true`） | 把 `productionExecutorProvider` 里那条检查删掉 → 第一条红；把码改成 `BAD_WIRING` → 第二条红；把反向对照删掉 → "一律拒绝"与"真的读了绑定值"分不开 |
| `runtime/dsh-composition/bootstrap.test.mjs` | ② 从"缺 `canRead` 拒绝"改为"缺席合法；给个不是函数的才拒" | 恢复"必须是函数" → 红 |
| `runtime/dsh-composition/root.test.mjs` | ⑦ 同上（`root.bootstrap` 这一层） | 同上 |
| `runtime/dsh-composition/plugins/runtime-host-row.test.mjs` | ⑧ 分为"缺席合法 / 坏值拒"；新增 ⑫c：交给组合根的是 `null`（**不是** `undefined`、不是函数） | 行改成传 `undefined` → ⑫c 红；行恢复"必须是函数" → ⑧ 红 |
| `runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs` | C 段：缺席 → `canRead === null`；坏值（4 种）→ 仍拒；新增 C2 段（模型来源 4 条 + "服务抛错让它抛"） | 工厂恢复抛 → C 段红；`readModelSelection` 吞异常 → C2 最后一条红 |
| `runtime/dsh-composition/can-read-authorization-boundary.test.mjs` | E 段改写（缺席 → `null`，注入 → 按引用，坏值 → 仍拒）；A/B/B2/C **一字未动** | 同 registrar C 段 |
| `runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs` | R 的期望从 `INPUTS_FACTORY_THREW(NO_CAN_READ_SOURCE)` 改为 `BIND_REFUSED(SELF_CHECK_INCOMPATIBLE)`；S 的 `DEFAULTFACTORY` 读数改为 `canRead-null` + 模型缺席读数；汇总断言改为"R 与 F 同形" | 见 §3.2 |

---

## 7. 诚实边界

**这一批证明了的**：

1. 在**真 DSH 进程**里，本批之前那条读数（`INPUTS_FACTORY_THREW(NO_CAN_READ_SOURCE)`）
   与本批之后那条（`BIND_REFUSED(SELF_CHECK_INCOMPATIBLE)`）**不同形**，
   且 `before` 是用**真的旧代码**（`git stash` 之后）跑出来的，不是复述。
2. 在真 DSH 进程里，绑定**真的建立**（服务发布、`dshRuntimeBound() === true`、exit 0）——
   在一个**声明过的能力探针替身**下。
3. 缺席**没有**被放松：同一个进程里问 `productionExecutorProvider()` 仍然
   `EXECUTOR_CAN_READ_REQUIRED`（`innerCode: null`）；"挂一个不是函数的"仍然当场拒。
4. `currentModelSelection` 挂在**真的** `agentDefaultModel` 服务上（真包、真装载），
   服务缺席时如实报 `null` + `..._SERVICE_ABSENT`。
5. 同进程那条路在**本批之前根本读不到**"没有 `canRead` 的绑定"，所以它那条新判定
   不是"放松了一条旧判定"，而是"新出现的一种输入有了明确答案"。

**这一批没有证明的（逐条）**：

- ✗ **"真引擎下绑定建立"**。`BOUND` 里的能力表是替身；真进程里探针只能确认 1/4 项。
  "绑定建立"与"一个真引擎完成了真任务"是两个不同的命题——本文只主张前者，
  且附了替身条件。
- ✗ **"`startRun` 真的跑了一个 subagent"**。生产 `startRun` 是**真转发**，
  但它转到的那个 `subagents` 服务在本套件里是**桩**（`bundles: []` 没有真引擎）。
  读数证明"端口 → 服务这一跳通了"。
- ✗ **"授权跨过了进程边界"**。本批**没有**改变上一批的结论
  （`PRT-253-can-read-authorization.md`：没有跨过）。本批只是不再让那条
  边界事实拦住一个**没有读者**的输入。
- ✗ **"某个真实部署的 `settings.yaml` 会被读进 `currentModelSelection`"**。
  `MODEL-REAL` 的 `provider`/`model` 是用例显式配置的；`settings` 服务没有挂，
  所以"热覆盖"那条路（`agent-default-model` 的 `ctx.inject(['settings'], …)`）
  没有被行使过。
- ✗ **"Runtime 进程的绑定会被生产用上"**。绑定在 Runtime 进程里的读者目前只有
  `runtime-contract-server-row.mjs` 的强制面结论（它只取 `{ok,state,patchVersion,checks}`）；
  而编排器进程读到的是**跨进程**那一条路。也就是说：**本批让"绑定建立"这件事成真，
  但没有让它变成生产行为**。
- ✗ **沙箱端口是替身**（沿用上一批的形状）；**`permission` 行是替身**
  （`bundles: []` 里没有它的靶子）；**组合补丁层用的是磁盘上那份真
  `legion-host.patch.yml`**（一个字节都不改），所以组合树观察与强制面装配是真读数。
- ✗ 三段"反向对照"（`BEFORE-CONTROL`、`BAD-CANREAD`、`MODEL-ABSENT`）里的
  `BEFORE-CONTROL` 是**包装层重建**那道门，不是旧代码；真正的旧代码读数在 §3.1
  （一次性、需要 stash），**不在**用例里。用例里那一条的作用是"在**同一份代码**上
  只动那一道门"，使"before/after 的差别只可能来自那道门"。
- ⚠️ **`runtime/` 不在 `scan.mjs` 的 `PROCESSES` 里**（见 §8），所以本批新增的
  `RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_*` 等字面量**不在** scan 的覆盖范围内。
  它们是**读数的名字**，不是 env 键；但如果有一天 `runtime/` 进了扫描范围，
  它们需要按那一侧的口径登记。这一条是覆盖说明，不是"应该没问题"。

---

## 8. 门禁与"绿"的效力

```
node scripts/config/scan.mjs --check          → scan: PASS（558 个疑似字面量；全部已处理）
node scripts/ci/ci-syntax.mjs                 → ci-syntax: PASS（50 个脚本）
node scripts/ci/encoding-check.mjs --all --quiet
                                              → encoding-check: PASS（1921 个文本文件；无 U+FFFD）
node scripts/ci/check-docs.mjs                → check-docs: PASS（10 类校验项全绿）
node scripts/ci/dsh-boundary.mjs --check      → dsh-boundary: PASS（3 个文件 / 26 处，均在基线内）
node scripts/prt/topology-inventory.mjs --diff → topology-inventory: 与清单一致（无漂移）
node scripts/prt/baseline-snapshot.mjs --check → baseline-snapshot: 平台契约与基线一致（无漂移）
```

**⚠️ scan 的绿对本批只有一半效力**：`scan.mjs` 的 `PROCESSES` 覆盖
`team-hub` / `workbench` / `whiteboard` / `plugins` / `board-plugin` /
`services-plugin` / `product` / `orchestrator`——**没有 `runtime`**。
本批新增的具名码与字面量**全部**落在 `runtime/dsh-composition/` 与
`runtime/`，因此**不在**扫描范围里；`orchestrator/worker/executor-binding.mjs`
那一处改动**没有**新增字面量（复用的是已声明的 `EXECUTOR_CAN_READ_REQUIRED`
属性访问），所以 `orchestrator` 侧不需要新的 `nonEnvLiterals`——**这是读数的结果**，
不是"应该不用"。换句话说：**scan 绿只对本批的 `orchestrator` 半边有效，
对 `runtime` 那半边它什么也没说。**

**零新增第三方依赖**：本批只用 `node:test` / `node:assert` / `node:fs` /
`node:os` / `node:path` / `node:child_process` / `node:url`。`package.json` 未改。

**没跑的**：`scripts/ci/run-ci.mjs`（任务明令禁止）、`scripts/prt/*` 破验脚本、
`topology-inventory --record`。**没有**读写任何真实 profile
（操作者那台机器的活 harness 是 `patchReload: 'live'`）。

**新增用例文件路径**（1 个）：

```
runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process.test.mjs
```

---

## 9. 下一个阻塞点（本批之后的）

**① 三项必需能力在这个进程里没有可确认的来源。** 这是**立即**的那一个，
而且它是**读出来的**：真探针在真进程里的读数是

```
caps={"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false}
```

`probe.mjs` 的判据是"必须显式为 true"，于是启动自检判 `autoExecutionForbidden: true`，
于是本行仍然**不能**进静态补丁层（挂上去＝每一个 Runtime 进程都起不来）。
修它不是接线：要么给那三项各自一个**真来源**（`cancel-and-timeout` 与
`usage-reporting` 各有一条已记录的生产故障/契约缺口），要么改变"必需能力"
这个集合的口径——两条都要单独一批、单独论证。

**② 然后才是"这个绑定算不算生产的一部分"。** Runtime 进程里读绑定的是强制面结论
（`{ok,state,patchVersion,checks}`）；编排器进程走的是跨进程那条路。
本批让"绑定建立"成真，但**没有**让它成为生产行为——那需要
`product/process-manifest.mjs` 那一侧（Runtime 进程真的挂上这一行、
并把 `LEGION_RUNTIME_URL` 交给 orchestrator），而那两个文件由操作者拥有。

---

## 10. 附：本批改动的文件

```
生产（4）：
  orchestrator/worker/executor-binding.mjs
  runtime/dsh-composition/bootstrap.mjs
  runtime/dsh-composition/plugins/runtime-host-row.mjs
  runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
用例（7 改 1 新）：
  orchestrator/worker/executor.test.mjs
  runtime/dsh-composition/bootstrap.test.mjs
  runtime/dsh-composition/root.test.mjs
  runtime/dsh-composition/can-read-authorization-boundary.test.mjs
  runtime/dsh-composition/plugins/runtime-host-row.test.mjs
  runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs
  runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs
  runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process.test.mjs   ← 新
文档（1 新 + 1 处界桩）：
  docs/superpowers/prt/PRT-253-runtime-host-binding-unblocked.md                        ← 新
  docs/superpowers/prt/PRT-253-can-read-authorization.md                                ← 顶部加"已被本批取代"的指向
```

**未改动**（操作者拥有）：`docs/STATUS.md`、`docs/superpowers/prt/PRT-PROGRESS.md`、
`scripts/ci/run-ci.mjs`、`docs/superpowers/prt/PRT-IMPLEMENTATION-REPORT.md`、
`runtime/dsh-composition/legion-host.patch.yml`、`product/process-manifest.mjs`、
`product/launcher/*`。

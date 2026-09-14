# PRT-253（续批三）：Runtime Contract 的**跨进程边界**

> 这一批去填上一批在真进程里量到的那条**更大的缝**：
>
> > 消费方（`product/orchestrator/worker.mjs`）与注册方（DSH Runtime 进程）
> > **是两个进程**，所以 `bindDshRuntime()` 这条缝**填多好都不会改变 worker 的读数**。
>
> 结论写在最前面，免得后面的话读起来像"都做完了"：
>
> **补上了，而且是用两个真的操作系统进程量出来的**：Runtime 进程里那一行起一台
> 回环 HTTP 监听器，worker 进程**没有任何本地绑定**，却经**产品的那个入口函数**
> （`productionExecutorProviderFromEnv`）拿到了一个可用的引擎，并且一次 `execute`
> 真的落到了另一个进程里（那边打印了 `START-RUN-CALLED n=1`）。
> 八种处境（A–H）各有**互不相同**的具名码，最后一条用例把八个读数放在一起断言两两不同形。
>
> 而**没有**证明的东西同样写在最前面：
> **那个 `dsh` 进程里的引擎端口是替身。** 所以这一批证明的是
> 「**边界**通了、请求真的进了另一个进程、具名拒绝逐条可分」，
> **不是**「一台真 DSH 引擎能跑完一个真任务」。逐条见 §6 诚实边界。

前置：`PRT-253-runtime-binding-caller.md`（续批一）、`PRT-253-runtime-host-inputs.md`（续批二）。

## 1. 这一批要回答的三个问题

1. 两进程部署里，worker 进程**凭什么**走到 DSH 执行引擎？那条路上传什么、怎么鉴权？
2. 引擎在**另一个进程**里时，`executor.mjs` 的执行逻辑要不要重写？
3. 断流、无终态、对端崩溃、凭证给错——这些"出事了"的读数，在跨进程之后**还分得开吗**？

## 2. 交付了什么

### 2.1 `runtime/contracts/wire.mjs` —— 线上表示（① 协议）

七个 `RuntimeAdapter` 方法的**线上形状**：路由、信封、NDJSON 帧、鉴权头、失败语义
（`RUNTIME_CONTRACT_WIRE_VERSION = 1`）。它复用 `runtime/contracts/*` 已有的
RunEvent / RunRequest / 能力表，**不发明平行的第二份契约**。

装载期断言 `assertWireCoversContract()`（导出为 `WIRE_CONTRACT_CHECKED`）：
`WIRE_ADAPTER_OPERATIONS` **恰好**等于 `ADAPTER_METHODS`，且匿名表里每一项都是只读的、
且 `execute` / `cancel` / `recover` **不在**匿名表里。

| 关注点 | 取值 | 理由 |
| --- | --- | --- |
| 前缀 | `/legion/runtime/v1` | 带版本，于是"路由换了"与"契约换了"可以分别判定 |
| 执行流 | `application/x-ndjson` | 每一行可**独立**用 `validateRunEvent` 校验 |
| 鉴权 | `authorization: Bearer <token>` | **只认这一个方案**——多认一种就多一条没被测过的路径 |
| 匿名 | **只有** `getHealth` | 它不含模型清单/能力表/运行输入；Launcher 的就绪探测恰在没有凭证的时刻要问它 |
| 附加端点 | `GET .../enforcement` | **不是**第八个适配器方法，见 §2.4 |

**★ `execute` 的失败语义**（本模块存在的核心）。一张可被判定的表，
`WIRE_ENDING_YIELDS_OUTCOME` 里**恰好一项为真**：

| 结束方式 | 客户端读数 |
| --- | --- |
| `terminal` | 正常返回（结论由**终态事件**给出，不由"连接正常关闭"给出） |
| `no-terminal` | **抛** `RUNTIME_CONTRACT_STREAM_NO_TERMINAL` |
| `transport-failed` | **抛** `RUNTIME_CONTRACT_STREAM_BROKEN` |
| `malformed-line` | **抛** `RUNTIME_CONTRACT_STREAM_MALFORMED` |
| `events-after-terminal` | **抛** `RUNTIME_CONTRACT_STREAM_AFTER_TERMINAL` |

`no-terminal` 与 `transport-failed` **不得合成一个读数**：前者是"对端说完了没说结论"
（去看适配器的收尾逻辑），后者是"我们没听完"（去看网络与进程）。修法相反。

> 一个把"连接关闭"读成"运行成功"的客户端，与一个把任何结果都读成成功的客户端，
> 在用户看来是同一个东西——只不过前者只在网络抖动的那一天出错，而那天没人会去查它。

### 2.2 ★ 流内**控制帧**（一个在设计中被逼出来的东西）

HTTP 头的字节一旦发出去，状态码就定死了。此后适配器中途抛错、或事件流没有终态就结束，
服务端**知道**发生了什么，却已经没法用一个状态码说出来。剩下的两条路都更差：

* `res.end()` → 客户端只能读到"干净结束却没有终态"，于是
  "适配器中途抛了"与"适配器正常结束但忘了发终态"**同形**；
* `res.destroy()` → 客户端读到的是**传输失败**，于是
  "适配器违约"与"服务端进程崩了 / 网络断了"**同形**。

所以加了一种与 RunEvent **不可能混淆**的帧（`{"__legionWire":"error","code":…}`，
它没有 `type`，`validateRunEvent` 一定拒绝它），带上**具名码**。
于是四种结束方式各自可分辨，**没有一种**看起来像成功。

> 服务端知道答案却只肯说"连接断了"，与它不知道答案，对排障的人是同一回事。

### 2.3 `runtime/dsh-composition/runtime-contract-server.mjs` —— 服务端（② 监听器）

`node:http`，回环，**零第三方依赖**。端口与地址的默认值纪律：

* `host` 缺省 `127.0.0.1`——这个默认值**只能更严格**，它不可能把监听面意外放大到局域网；
* `port` **没有默认值**：给一个默认端口会让"没配"与"配在这个端口上"在读数上同形，
  而"端口冲突（EADDRINUSE）"与"服务没起来"是完全不同的两件事；`port: 0` 允许，
  实际端口从 `address()` 读回（**测试与不想占固定端口的部署都用它**）。

鉴权 **fail closed**，且两条必须可分：

| 处境 | 状态码 | 码 |
| --- | --- | --- |
| 本进程**没配** token | 403 | `RUNTIME_CONTRACT_NO_TOKEN`（去配） |
| 出示的凭证**不匹配** | 401 | `RUNTIME_CONTRACT_UNAUTHORIZED`（去取对的） |

空串与纯空白一律算"没配"（`tokensMatch('','') === false`：**"没配"不是"配对了"**）。
比较用 `timingSafeEqual`（等长时）；长度不同直接 false——那是所有 bearer 比较都有的性质。

### 2.4 `enforcement` 为什么是一个**附加端点**

`createProductionExecutor` 的 `selfCheck` 接缝在 **worker 进程**里被消费，
而它的权威（`startupSelfCheck` / 组合树 / 沙箱端口）在 **DSH Runtime 进程**里。

不能塞进 `getHealth()`：`RuntimeHealth` 的形状是**冻结**的，加字段就是改契约形状；
而把结论塞进 `detail` 字符串等于把一个**判定**降级成一句散文——读它的代码只能靠正则，
而正则会在文案改动的当天失效。

所以它是一个与七个方法同名空间、同鉴权纪律的附加端点，
语义上属于「Legion 产品层跨进程搬运自己的强制面结论」。
**没有来源时它具名拒绝**（`RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE`），
**绝不回落成"通过"**——一个"读不到就当它通过"的默认值会让
「强制面未生效时禁止自动执行」这条保证变成一个装饰。

### 2.5 `runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` —— 补丁层里的一行

形状与 `runtime-host-registrar-row.mjs` 同形：注册方在**模块求值期**调用
`setRuntimeContractInputsFactory(...)`，然后 `export default` 真的那个插件对象。
理由不变：Loader 用 `Promise.allSettled(config.map(create))` **并发**创建补丁行，
而 ESM 保证被 import 的模块先求值完（2×2 矩阵读数见 PRT-214 文档 §10）。

**★ 一个与 `runtime-host-row.mjs` 故意相反的取舍**：挂载失败时本行
**永不**在 `apply` 期抛，而是 `ctx.provide(...)` 一个**带具名码的 ok:false 状态**。

| | 强制面（`runtime-host-row`） | 出口（本行） |
| --- | --- | --- |
| 挂不上时 | **拒绝启动** | **降级 + 可见具名状态** |
| 理由 | "强制面没生效却照跑"会执行真实写操作却毫无征兆 | 出口挂不上时 harness 仍可用，worker 仍报 `HOST_PORT_REQUIRED` 且**不认领任务**——可见的降级，不是静默失效 |
| 代价 | 起不来是**刻意的** | 反过来会让**每一个** Runtime 进程起不来，把可见的小故障换成不可用的大故障 |

> 一个"因为出口装不上而整个产品起不来"的部署，与一个"出口装不上、但产品照常在跑
> 并明说自己干不了活"的部署，后者的失败面小得多——而两者都能被看见。

`canRead` **不**在这一行：它的权威是 lease / 岗位清单，而 lease 由 worker 进程在认领之后
才有。在 Runtime 进程里配一个 `canRead`，无论填什么都是编的。

> 把 worker 侧的权限判定搬到 Runtime 进程里做，与把它留在一个"没有 lease 可看"的地方，
> 是同一个东西——只不过前者看起来像已经解决了。

### 2.6 `orchestrator/worker/runtime-contract-client.mjs` —— 客户端适配器（③ worker 一侧）

`executor.mjs` 的执行逻辑**一行未改**。接的是它本来就有的注入点
（`adapterFactory = createDshRuntimeAdapter`），换成
`(host) => createRuntimeContractAdapter(host)`。

`probe()` **复用** `runtime/adapters/dsh/probe.mjs` 的 `probeRuntime()`：
把对端的版本与能力取回来，交给**同一套**判定。

> 一个在本进程里再写一遍"哪些能力算数"的探测，
> 与一个"两处判定迟早不一样"的探测，是同一个东西。

`execute` **不设**超时上界：运行长度由 `RunRequest.timeoutMs` 决定，由**服务端**适配器的
看门狗强制执行。在这一侧再设一个会让"运行超时"与"网络超时"混成一个读数。

### 2.7 `orchestrator/worker/executor-binding.mjs` —— 两条取得引擎的路

| 路 | 何时成立 | 优先级 |
| --- | --- | --- |
| ① 进程内绑定（`bindDshRuntime`） | worker 与引擎同进程 | **高**（它是本进程里那一台引擎，证据更强） |
| ② 跨进程契约（本批新增） | `LEGION_RUNTIME_URL` 配上 | 低 |

两条都不通时 **`EXECUTOR_HOST_PORT_REQUIRED` 一字不改**——
`executor.test.mjs` 与 `executor-binding-sources.test.mjs` 钉着它。

> 加了一条新路之后把老路的读数改掉，等于用一次重构悄悄换掉一条别人正在依赖的契约。

新增四个具名码，各自对应**修法完全不同**的一种处境：

| 码 | 含义 | 修法 |
| --- | --- | --- |
| `EXECUTOR_RUNTIME_UNREACHABLE` | **配了**端点但够不着 | 去看那台进程 |
| `EXECUTOR_RUNTIME_UNAUTHORIZED` | 端点在对，凭证不成立 | 去看配置（对端码在 `innerCode`） |
| `EXECUTOR_RUNTIME_REFUSED` | 对端具名拒绝了别的东西 | 看 `innerCode` |
| `EXECUTOR_CAN_READ_REQUIRED` | 权限判定没有来源 | **不**回落成"默认都能读" |

强制面结论在**进 `createProductionExecutor` 之前**读、先归类：因为
`createProductionExecutor` 把 `selfCheck()` 的任何异常都收成
`EXECUTOR_SELF_CHECK_INCOMPATIBLE`，那会把"连不上 / 凭证不对 / 对端没配 token"
三种修法完全不同的处境压成同一个码。

> 一句不区分处境的报错，与没有报错，在排障上的价值是一样的。

## 3. 两进程证明：`orchestrator/worker/runtime-contract-cross-process.test.mjs`

结构与既有 DSH 进程套件的**唯一差别**：不能用 `spawnSync`——跨进程那条路要在那台进程
**活着**的时候从本进程走一遍，所以用 `spawn` + 探针在 stderr 上打 `READY` 再 `hold()`。

```
Runtime 进程（真 dsh）                        worker 侧（本测试进程）
─────────────────────────                     ─────────────────────────
真补丁层 legion-host.patch.yml                resetDshRuntimeBinding() ⇒ 无本地绑定
真 Loader / 真 Cordis Context
  legion-runtime-host        （绑定，替身引擎） productionExecutorProviderFromEnv(
  legion-runtime-contract-server ← ★ 本行        env:{LEGION_RUNTIME_URL, LEGION_RUNTIME_TOKEN},
    bindPort: 0 → node:http 回环                 canRead
    ├ 真 RuntimeAdapter（createDshRuntimeAdapter）      │
    ├ 真鉴权比较（timingSafeEqual）                     │ HTTP
    └ 引擎端口 = 替身 ─────────────────────────────────┘
探针把 CONTRACTSVC 读数打到 stderr
```

八个处境的读数（**全部来自实跑**，最后一条用例断言两两不同形）：

| # | 处境 | 读数（逐字） |
| --- | --- | --- |
| A | 行挂上 + 有工厂 + 有 token | `ok=true`；`execute` → `completed`；对端 `START-RUN-CALLED n=1` |
| B | **不挂**那一行 | 服务 `ok=absent`；worker → `EXECUTOR_HOST_PORT_REQUIRED` |
| C | 挂上但**没人注册工厂** | 进程 **exit 0**；服务 `ok=0` + `RUNTIME_CONTRACT_ROW_NO_INPUTS_FACTORY` |
| D | 挂上但**没有 token** | 服务 `ok=1` / `tokenConfigured=0` / `warnings=…_NO_TOKEN`；worker → `…UNAUTHORIZED` + innerCode `…_NO_TOKEN` |
| E | token 配了但 worker **给错** | `…UNAUTHORIZED` + innerCode `…UNAUTHORIZED`（与 D 不同形） |
| F | URL 配了但那台进程**不在** | `EXECUTOR_RUNTIME_UNREACHABLE`（与 B 不同形） |
| G | URL 配了但**没给 canRead** | `EXECUTOR_CAN_READ_REQUIRED`（innerCode 为空：这是**本进程**的拒绝） |
| H | URL 配了但**没给 token** | `…UNAUTHORIZED`，且**对端一次请求都没收到** |

形状读数（实跑）：

```
{"A":"ok/-",
 "B":"EXECUTOR_HOST_PORT_REQUIRED/-",
 "D":"EXECUTOR_RUNTIME_UNAUTHORIZED/RUNTIME_CONTRACT_NO_TOKEN",
 "E":"EXECUTOR_RUNTIME_UNAUTHORIZED/RUNTIME_CONTRACT_UNAUTHORIZED",
 "F":"EXECUTOR_RUNTIME_UNREACHABLE/-",
 "G":"EXECUTOR_CAN_READ_REQUIRED/-",
 "H":"EXECUTOR_RUNTIME_UNAUTHORIZED/-"}
```

D 与 E 的**外层码相同**，所以形状函数把 `innerCode` 也算进去——不这样做，
这一对会被误判成同形而放过去。

### 3.1 ★ A2 那条断言为什么不能靠"返回了 completed"来推断

一个把请求丢进虚空、却仍然回 `completed` 的替身也会让"executor 返回了 completed"变绿。
所以判据是**对端进程的 stderr 里出现了 `START-RUN-CALLED n=1 provider=… promptParts=1`**。
`promptParts=1` 还顺带证明冻结的正文真的被拼进了 `prompt`。

### 3.2 三条在写套件时**被实测咬出来**的东西（都是夹具的错，不是产品的错）

1. **不能读绝对计数**。第一版端到端用例断言 `START-RUN-CALLED n=2`，而 A2 已经在
   **同一个**进程上跑过一次。一条"跑全量时红、单独跑时绿"的断言测的是测试的执行顺序。

   > 一个只在别人的用例没跑过时才成立的断言，比没有断言更坏：
   > 它会把"顺序变了"报成"产品坏了"。

   改成读**增量**。
2. **不能复用已结算的 `runId`**。第一版端到端两次运行复用同一份 `LEASE`，实测拿到一句
   非常准确的拒绝：「runId run-ct-1 已结算（run.completed）；重试必须创建新 Attempt/Run」。
   **引擎侧的幂等纪律是对的，错的是夹具。** 这条纪律本身被单独钉成一条用例
   （`同一个已结算的 runId 不得再跑一次`），并断言被拒的那一次**没有**在对端留下第二次
   启动记录——一次拒绝不等于一次执行。
3. **`stopReason` 必须是契约认得的那个词**。替身第一版写 `'end_turn'`（某家的方言），
   而 `classifyStopReason` 对**未识别**的停止原因判 `INVALID_RESULT`，于是这次运行
   "跑到了终点"却报失败。那是**它该有的行为**（不认识的停止原因不许当成功），错的是替身。
   同理 `budget.maxCostUsd` 配在替身模型上会让 `estimateCostUsd` 返回 null
   → `cost-unknown` → `BUDGET_EXCEEDED`；夹具改用 token 上限。

## 4. 单元套件

| 套件 | 覆盖 |
| --- | --- |
| `runtime/contracts/wire.test.mjs`（30 条） | 覆盖性 / 三种路由决策 / 鉴权七种畸形头 / 五种结束方式**恰好一种**为真 / 三种信封 / NDJSON 与控制帧 |
| `runtime/dsh-composition/runtime-contract-server.test.mjs`（39 条） | 造不出来（三种各自可分辨）/ port 0 读回 / 逐个操作断言匿名被拒 / ★ 五种 execute 结束方式 / enforcement 四种无来源 |
| `orchestrator/worker/runtime-contract-client.test.mjs`（34 条） | 接线 / 七方法来回 / probe 复用同一判定 / 鉴权与传输码 / ★ 四种非成功结束方式两两不同码 |

服务端套件**用手写的原始请求**、不用客户端适配器：

> 用自己的客户端测自己的服务端，测的是两者是否一致，不是两者是否正确。

客户端套件的失败语义那一段**用手写的坏对端**（真服务端**永远不会**产生那些违约的流）：

> 只对着一个守规矩的对端测"不守规矩时会怎样"，测到的是"那个对端很守规矩"。

## 5. 清单 / 配置变化（**需要操作者决策**）

### 5.1 已经改的

* `orchestrator/config-schema.mjs`：`LEGION_RUNTIME_URL` / `LEGION_RUNTIME_TOKEN` 在**两处**登记
  （`ENV_NAMES` 读取声明 + `SCHEMA.fields` —— 后者才是 `scan` 读的那一份，见 §7.4）；
  `NON_ENV_LITERALS` 加四个新 `EXECUTOR_*` 码（带理由）。
* `orchestrator/worker/executor.mjs`：`EXECUTOR_CODES` 加四个码（**执行逻辑一行未改**）。
* `runtime/contracts/index.mjs`：把 `wire.mjs` 的符号接进 barrel
  （上一批**故意没有**接进去，因为那时它还不存在；现在是契约的一部分，两侧各 import 一份
  就不会出现"服务端与客户端各有一份协议"）。

### 5.2 ★ **没有**改、但真实部署需要的（本批只报告，不擅自改）

`product/process-manifest.mjs` 是 **PRT-258 冻结的契约**，本批**一个字节都没改**。
但跨进程那条路要在真实部署里生效，它需要三处改动——**这是一次明确的决策，不是一次顺手**：

1. `orchestrator` 那一项的 `envNames` 加 `LEGION_RUNTIME_URL` 与 `LEGION_RUNTIME_TOKEN`。
   **不改的后果是具体的**：`product/launcher/allowlist.mjs` 的 `buildChildEnv()`
   对未声明的键**直接抛**，所以 Launcher 启动的 worker 进程里这两个键**会被丢掉**，
   跨进程那条路会退化回 `EXECUTOR_HOST_PORT_REQUIRED`。
2. 一个把 Runtime 进程实际绑定的端口**交给** worker 的取值面。
   今天的问题很具体：DSH 自己用 3080，而契约监听器是临时端口
   （`bindPort: 0`），所以服务端把绑到的端口放在**发布的服务值**上
   （`legionRuntimeContractServer.port`）并从 stdout 可读。
   Launcher 侧的派生值管道（`product/launcher/launcher.mjs` 的
   `PORT_ENV_KEYS` / `derivedValuesFor`）**本批没有动**。
3. `LEGION_RUNTIME_TOKEN` 的**产生与分发**。今天没有任何进程生成它，
   也没有任何地方把它写进 Runtime 进程的环境。这是安全面的决定（谁来生成、
   怎么只让两个进程看到、要不要轮换），**不该由这一批顺手决定**。

**在这三处落地之前，真实部署的读数仍然是 `EXECUTOR_HOST_PORT_REQUIRED`。**
这一条必须说清楚，否则 §3 那张全绿的表会被读成"生产已经通了"。

### 5.3 本批新增的**测试专用**环境变量

两个只在套件里用、**不在任何生产代码里**的键：
`PRT253CT_TOKEN`（把令牌交给一次性 `dsh` 进程）与 `PRT253CT_WAIT_MS`（探针轮询上限）。
它们只出现在 `orchestrator/worker/runtime-contract-cross-process.test.mjs` 与它写进
一次性 scratch 目录的脚手架里，**不进** `process-manifest.mjs`、**不进**任何 schema。
取 `PRT253CT_` 前缀是为了让"这是测试面的东西"一眼可辨。

## 6. ★ 诚实边界

### 6.1 **引擎是替身**——这一批没有证明"引擎能干活"

那个 `dsh` 进程里的引擎端口（`startRun` / `probeRuntime` / `currentModelSelection`）
是脚手架。具体地说：

* `probeRuntime()` 的能力表是**按 `REQUIRED_CAPABILITIES` 推导**的
  （`Object.fromEntries(REQUIRED_CAPABILITIES.map(c => [c, true]))`），
  **不是**任何一台真引擎报出来的；
* `startRun()` 不启动任何子代理，只回一个已结算的句柄；
* 替换的理由是一条**实测事实**：真的 `createRuntimeHostInputsFactory()`
  （从 `ctx.get('subagents')` 取端口、由 `probeDshRuntime()` 取能力）在一个只有脚手架服务的
  进程里只确认得了 `structured-result` 一项，于是 `bootstrapDshRuntime` 的自检报
  `BOOTSTRAP_SELF_CHECK_INCOMPATIBLE`，`legion-runtime-host` 那一行**不发布**绑定服务。

> 于是本套件的选择是：把引擎换成替身，用真进程 / 真 Loader / 真补丁层 / 真监听器 /
> 真鉴权去测**边界**；而不是把边界也换成替身去测引擎。

所以：**`execute` 在一次真实运行里跑完过吗？** 跑完过，但那是**替身引擎的
`execute`**——它走完了整条:HTTP → NDJSON 帧 → 客户端解析 → 终态 → `executor` 收成
`completed`。**没有**跑过任何一个真 DSH 能力、真模型调用或真工具调用。

### 6.2 除引擎外，其余全是真的

真操作系统进程、真 `dsh` CLI、真 Loader、真 Cordis Context、真补丁层
（`legion-host.patch.yml`，本批**一个字节没改**）、真 `node:http` 监听器、
真服务发布（`ctx.provide` + `ctx.effect` 回收）、真 `RuntimeAdapter`
（`createDshRuntimeAdapter`）、真客户端（`runtime-contract-client.mjs`）、
真鉴权比较（`timingSafeEqual`）。

### 6.3 鉴权是真的，但它保护的是什么

真比较、真 fail closed、真两条可分（`NO_TOKEN` 403 vs `UNAUTHORIZED` 401）。但要说清它的**射程**：

* 监听面**只回环**，所以威胁模型里已经包含本地进程；
* 它**没有**防御一个已在本机、能读进程环境或命令行的人；
* 它**没有**传输加密（回环 HTTP）；
* token 的**产生与轮换**本批没有实现（见 §5.2 第 3 条），
  所以"凭证怎么来"这个问题今天是**空的**——本批只实现了"给了凭证之后它怎么被比"。

### 6.4 两处替身输入（与续批二同源）

* `canRead: () => true`：真权威是 lease / 岗位清单，DSH Runtime 进程里两者都不在。
* `currentModelSelection`：见 §6.5。

### 6.5 ★ 顺带量到的一处**既有**接缝缺口（不是本批引入的）

全仓库**没有任何生产代码**提供 `currentModelSelection`（只有测试夹具提供），
而它在 `OPTIONAL_PORT_METHODS` 里。后果是具体的：缺了它
`DshRuntimeAdapter._selection()` 返回 null，**每一次 `execute` 都以
`MODEL_UNAVAILABLE` 终态失败**。

本批在脚手架里补了一个替身，好让跨进程那次运行能走完。
**真实部署里那个缺口还在**，而且它现在更值钱了：跨进程那条路一通，
下一个读数就会是 `MODEL_UNAVAILABLE`，而不是 `EXECUTOR_HOST_PORT_REQUIRED`。

### 6.6 那个 `legion-runtime-host` 服务值本批**读不到**

`runtime-contract-server-row.mjs` 的 `enforcement` 惰性读 `legionRuntimeHostBinding`。
在替身引擎下那条路**走不通**（自检不过 ⇒ 那一行不发布服务），
所以本批实跑的所有场景里，`enforcement` 结论都来自
**另一种**处境——即 `enforcementConfigured=1` 是**本行自己的判断**（§3 的 `CONTRACTSVC` 读数），
而 `SELF-ENFORCEMENT status=200` 说明那条端点确实给出了 `autoExecutionForbidden:false`。

> ⚠️ 一条**不能说清**的边界，如实写在这里：三种来源
> （① 工厂显式给 `enforcement`；② 惰性读 `legionRuntimeHostBinding`；③ 都没有 → 具名拒绝）
> 里,本批**只实测了 ① 与 ③**。② 的逻辑（`verdictFromRuntimeHostBinding`）只有单测覆盖，
> **没有**在真进程里被行使过——因为在替身引擎下它永远读不到服务。
> 区分"那一行没挂"与"那一行挂了但自检拒绝"需要 `runtime-host-row` 把自己的拒绝也发布出来，
> 而那不在本批范围内。

### 6.7 本批**没有**做的事

* **没有**用带 bundle 的真实 profile 启动过（安全规则要求 `bundles: []`），
  所以"真实部署里 `subagents` / `tools` / `sandbox` 的形状与这里一致"是**假设**。
* **没有**跑满 CI（`scripts/ci/run-ci.mjs`）、**没有**提交、**没有**推送。
* **没有**改 `product/process-manifest.mjs`（见 §5.2）。
* **没有**改 `docs/STATUS.md` / `PRT-PROGRESS.md` / `PRT-IMPLEMENTATION-REPORT.md` /
  `runtime/dsh-composition/legion-host.patch.yml`。
* **没有**动 Launcher 的派生值管道（端口怎么从 Runtime 传给 worker）。
* **没有**任何"真 DSH 引擎跑完一个真任务"的读数（见 §6.1）。

## 7. 验证（本批实际跑的）

全部在 `D:\project\DSH\legion\.worktrees\prt-runtime`（分支 `codex/prt-runtime`）下，
`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`，Node `v24.19.0`。

### 7.1 新增/改动的套件（逐个）

| 命令 | 读数 |
| --- | --- |
| `node --test runtime/contracts/wire.test.mjs` | `tests 30 / pass 30 / fail 0` |
| `node --test runtime/dsh-composition/runtime-contract-server.test.mjs` | `tests 39 / pass 39 / fail 0` |
| `node --test orchestrator/worker/runtime-contract-client.test.mjs` | `tests 34 / pass 34 / fail 0` |
| `node --test orchestrator/worker/runtime-contract-cross-process.test.mjs` | `tests 17 / pass 17 / fail 0`（5 次真 DSH 启动，约 42s） |

### 7.2 全量套件

| 命令 | 读数 |
| --- | --- |
| `node --test "runtime/**/*.test.mjs"` | `tests 1402 / pass 1402 / fail 0 / skipped 0`（exit 0） |
| `node --test "orchestrator/**/*.test.mjs"` | `tests 380 / pass 380 / fail 0 / skipped 0`（exit 0） |

### 7.3 静态门禁（`git add -A` 之后）

```
node scripts/config/scan.mjs --check
  → scan: PASS（全部 env 读取点与疑似字面量均已处理；共 548 个疑似字面量）
node scripts/ci/ci-syntax.mjs
  → ci-syntax: PASS（50 个脚本全部可被 Node 解析）
node scripts/ci/encoding-check.mjs --all --quiet
  → encoding-check: PASS（1910 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；
     37 个历史采集物为 UTF-16，已列出）
node scripts/ci/check-docs.mjs
  → check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）
node scripts/ci/dsh-boundary.mjs --check
  → dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
```

★ `dsh-boundary` 的读数（3 个文件 / 26 处）与续批二**逐字相同**：
本批新增的 `runtime-contracts` 侧代码没有新增任何 `ctx.<service>` 执行面记号、
也没有 import 任何 DSH 包——worker 一侧读引擎走的是 HTTP，
所以"依赖方向"这个问题在跨进程之后**根本不再出现**。

### 7.4 ★ 一次实测到的门禁真红（值得单列，因为它证明门禁在干活）

第一次跑 `scan --check` 时它是**红**的：

```
=== orchestrator：... ===
  ✖ 未处理字面量（2）：LEGION_RUNTIME_TOKEN, LEGION_RUNTIME_URL
scan: FAIL —— 2 项未在 schema 中处理
```

原因值得记下来，因为它是这个仓库里一个**容易踩的坑**：
`orchestrator/config-schema.mjs` 同时导出两份名单——
`ENV_NAMES`（"本进程确实要读它"的**声明**，`runtime/dsh-composition/root.mjs`
与多份文档都引它）与 `SCHEMA = defineSchema({ fields: [...] })`。
而 `scripts/config/scan.mjs` 读的是 **`SCHEMA.envNames()`**，
那个函数是 `fields.map(f => f.env)`（见 `packages/shared/src/config.mjs`）。

> 我第一版只登记进了 `ENV_NAMES`——一份**没人拿来判定的**名单。
> 于是"我已经声明了"与"门禁看得见"是两件事，而它们的差别
> 只在**别人**跑门禁的那一天才显现。

修法是两处都登记（与 `TEAM_HUB_TOKEN` 在两处都出现同一纪律，见该文件 §notes），
并且给 `runtimeToken` 打上 `sensitive: true`——与 `hubToken` 同一条纪律：
**跨进程凭证绝不进状态文件**（`worker/status-file.mjs` 的禁用键名单也钉着这个字符串）。

### 7.5 `scan` 这一侧的覆盖情况（**不粉饰**，口径同续批二）

`scripts/config/scan.mjs` 的 `PROCESSES` 里**没有** `runtime`。所以：

* **被 `scan` 覆盖的**是本批改动里的 `orchestrator/` 那一部分
  （`config-schema.mjs` 的两个新 env 字段 + 四个新码，`executor.mjs`、`executor-binding.mjs`）；
* **不被覆盖的**是全部 `runtime/` 新代码：`runtime/contracts/wire.mjs`、
  `runtime/dsh-composition/runtime-contract-server.mjs`、
  `runtime/dsh-composition/plugins/runtime-contract-server-row.mjs`，以及三个 `runtime/` 套件。
  `scan --check` **绿**这件事对这批代码**不是证据**。
* `security/` 同样不在 `PROCESSES` 里（本批没有改它）。

### 7.6 破验（四个变异，**逐条实跑**，读数照抄）

四个变异各自是**一处**最小改动，跑完立刻 `git checkout --` 还原
（还原后用 `git status --porcelain` 确认工作树只剩本批的 13 个文件）。

| 变异 | 改的是什么 | 实跑读数 | 判断 |
| --- | --- | --- | --- |
| A | `wire.mjs` 的 `WIRE_ENDING_YIELDS_OUTCOME` 里把 `TRANSPORT_FAILED` 改成 `true` | `wire.test.mjs`：`tests 30 / pass 29 / fail 1`，红的是「④ 五种结束方式里**恰好一种**允许被读成"有结论"」 | **被咬住** |
| B | `runtime-contract-server.mjs` 里把"没有终态"那条 `failStream(STREAM_NO_TERMINAL, …)` 换成裸 `res.end()` | `runtime-contract-server.test.mjs`：`tests 39 / pass 37 / fail 2`，红的是「⑤ 有事件但没有终态就结束 → 控制帧 STREAM_NO_TERMINAL（与"中途抛"可分）」与「⑤ 五种结束方式**两两不同形**」 | **被咬住**（2 条） |
| C | `runtime-contract-client.mjs` 里把读失败的 `throw STREAM_BROKEN` 换成 `break` | `runtime-contract-client.test.mjs`：`tests 34 / pass 32 / fail 2`，红的是「⑤ 传输中途断掉 → STREAM_BROKEN，`outcomeUnknown` 为真」与「⑤ 四种非成功结束方式**两两不同码**」 | **被咬住**（2 条） |
| D | `executor-binding.mjs` 里把跨进程分支提到**本地绑定之前**（`currentBinding() === null` → `currentBinding() !== null \|\| runtimeUrl !== null`） | `node --test "orchestrator/**/*.test.mjs"`：**14 条以上变红**，含「★ 没绑 DSH 运行时 → 仍然是 HOST_PORT_REQUIRED」、「④ 装上端口之后，同一个入口就开始真的执行」、「④ 注销之后又回到拒绝」、「F. URL 配了但那台进程**不在** → RUNTIME_UNREACHABLE」 | **被咬住** |

**关于变异 D 的一句如实交代**：写这一节之前，我**先**在草稿里把它记成
"未被咬住，是一条已知的覆盖缺口"——因为我以为"同进程部署里两路同时可用"
没有用例覆盖。实跑之后它**被咬住了 14 条以上**，于是那句话是错的，已按实跑读数改掉。

> 一个**没有跑过**的破验表，读起来与一个跑过的完全一样。
> 它唯一的区别是在别人复现的那一天才显现——
> 而那一天，这张表正是他拿来决定"要不要信这套断言"的东西。

四条变异合起来说明的东西比各自单看更强：**RUNTIME_UNREACHABLE 与
HOST_PORT_REQUIRED 被绑在同一处分派上**（D 同时打红了它们两条），
也就是"两条路谁优先"这件事是有用例盯着的，不是一段没人管的 if。

## 8. 本批新增的套件（操作者需要登记）

* `runtime/contracts/wire.test.mjs`
* `runtime/dsh-composition/runtime-contract-server.test.mjs`
* `orchestrator/worker/runtime-contract-client.test.mjs`
* `orchestrator/worker/runtime-contract-cross-process.test.mjs`

## 9. 下一批**最该**做的三件事（按读数与代价排序）

1. **`currentModelSelection` 的生产来源**（§6.5）：它是唯一一个"跨进程通了之后
   立刻就会撞上"的缺口，而且它的失败读数（`MODEL_UNAVAILABLE`）看起来像引擎的错。
2. **§5.2 那三处清单/配置**：没有它们，真实部署的读数仍然是
   `EXECUTOR_HOST_PORT_REQUIRED`——**本批的全部读数都停在一个测试进程里**。
3. **`runtime-host-row` 发布自己的拒绝**（§6.6）：把"没挂"与"挂了但自检拒绝"
   分开，`enforcement` 的来源 ② 才能真正被行使。

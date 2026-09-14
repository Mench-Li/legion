# PRT-253 续批四：把 Runtime Contract 接到 Launcher 上（端点、端口、凭证）

* 工作树：`D:\project\DSH\legion\.worktrees\prt-runtime`（分支 `codex/prt-runtime`，基线 `9517faf`）
* 环境：Node `v24.19.0`，`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`
* 上一批：`docs/superpowers/prt/PRT-253-runtime-contract-boundary.md`（下称「续批三」）

---

## 1. 这一批要闭的三个缺口

续批三把跨进程那条路建成了：worker 能从**环境**读 `LEGION_RUNTIME_URL` /
`LEGION_RUNTIME_TOKEN`，读到了就能连上另一台进程里的契约监听器，
`runtime-contract-cross-process.test.mjs` 逐条证明了这件事。

但那份文档的 §5.2 与 §6.3 自己写明了：**在一个由 Launcher 启动的真实部署里，
这两个键一个都不会被写进去**。于是那套全绿的读数停在一个测试进程里。
三个缺口是：

| # | 缺口 | 续批三的说法 | 本批的处置 |
| --- | --- | --- | --- |
| 1 | worker **收不到**端点与凭证这两个名字 | 「`buildChildEnv()` 对未声明的键直接抛」（§5.2 第 1 条） | **闭合**：清单增量扩展（§2） |
| 2 | 契约端口是**临时**的，worker 无从得知 | 「Launcher 侧的派生值管道本批没有动」（§5.2 第 2 条） | **闭合**：Runtime 进程发布实际端口，Launcher 读回并校验（§3） |
| 3 | **没有人生成凭证**，也没有地方把它注入 | 「这是安全面的决定，不该由这一批顺手决定」（§5.2 第 3 条） | **闭合（有明确射程）**：Launcher 每次启动生成一份，只注入两个进程（§4） |
| 4 | worker **连状态文件的落点都没有**（任务书里没有这一条） | 未提及 | **顺带闭合**：Launcher 从没注入过 `LEGION_DATA_DIR`（§2.4） |

一句话的结论：**Launcher 现在真的把这两个名字与两个值交给 worker，
而 worker 在没有它们时会具名拒绝、不会拿到一个编出来的 URL。**
这句话**不等于**「一个真实部署现在能执行任务」——差在哪，全写在 §7。

---

## 2. 缺口 1：清单的**增量扩展**（不是重新设计）

### 2.1 改了什么

`product/process-manifest.mjs`，**两处 `envNames`、零处结构**：

```js
// runtime（服务端）：新增 1 个键
envNames: [ …原 12 项…, 'LEGION_RUNTIME_TOKEN' ]

// orchestrator（worker）：新增 2 个键
envNames: [ 'TEAM_HUB_URL', 'TEAM_HUB_TOKEN', 'LEGION_DATA_DIR',
            'LEGION_RUNTIME_URL', 'LEGION_RUNTIME_TOKEN' ]
```

### 2.2 为什么这是「增量扩展」而不是「重新设计」

`product/process-manifest.mjs` 是 **PRT-258 冻结的契约**，续批三**一个字节都没改**它，
并把这件事写进了 §5.2 作为「需要一次明确的决策，不是一次顺手」。本批的判定是：
**这次改动落在"扩展"这一侧，理由可以被逐条检查**：

1. **没有动任何结构**：`PROCESS_SPECS` 的条目数、顺序、`key`、`kind`、`required`、
   `dependsOn`、`entry`、`cwd`、`portKey`、`defaultPort`、`host`、`readiness`、
   `writesRoles`、`milestone` **一个字段都没变**；`PROCESS_MANIFEST_VERSION` 仍是 `1`；
   `DEFAULT_PORTS`、`LOOPBACK_HOSTS`、`MANIFEST_KNOWN_GAPS`、`startupWaves`、
   `materializeProcessPlan`、`validateProcessPlan` 全部未触碰。
2. **两个键在改动之前就已经存在**：它们早在 `orchestrator/config-schema.mjs` 的
   `ENV_NAMES` 与 `fields` 里登记过（续批三改的），也在
   `orchestrator/worker/executor-binding.mjs` 里作为生产读取点用了整整一批。
   本批做的是把「**已经声明过的读取**」接进「**白名单的唯一来源**」——
   也就是把一处**已经存在的自相矛盾**修掉，而不是引入一个新概念。
3. **被加进去的名字全部满足既有的命名纪律**：`LEGION_*` 前缀，
   与 `enforcement-identity.test.mjs` 那条闭集断言
   （`/^(DSH_HOME|LEGION_[A-Z_]+|TEAM_HUB_[A-Z_]+)$/`）相容。
4. **它不改变任何一个进程需要什么**，只改变白名单放不放行：
   加不进去的后果续批三写得非常具体——「两个键会被丢掉，
   跨进程那条路退化回 `EXECUTOR_HOST_PORT_REQUIRED`」。

**为什么仍然值得单列一句**：把「冻结」理解成「一个字都不许加」会让这份清单
永远停在它第一次被写下的那天；而把「冻结」理解成「随便加」会让它不再是契约。
本批取的口径是：**只做增量、只加已被别处声明过的键、并把这个判定写进文档**。
如果操作者认为连增量也需要走一次显式评审，那么这一批的 §2 就是那份待评审的清单
（改动面精确为两行 `envNames`）。

### 2.3 顺带补上的登记（`product/config-schema.mjs`）

`scan.mjs` 的字面量门禁要求每个进程的读取点都在它自己的 schema 里登记。
本批往 `product` 那份 schema 里加了：

* `CHILD_ENV_NAMES`：`LEGION_RUNTIME_URL` / `LEGION_RUNTIME_TOKEN`
  （它们是**注入目标**的名字——本进程从不读它们，只写进那两个子进程的环境）。
* `nonEnvLiterals`：本批新增的 7 个诊断码（§3.4、§4.4）与 `ENOENT`
  （它是「发布文件不在」的判据，与既有的 `EACCES` / `EADDRINUSE` 同一类：
  Node 的 fs 错误码，名字长得像环境变量所以 scan 会怀疑它）。
* `injects`：5 条（两个进程的 `LEGION_DATA_DIR`、两个进程的
  `LEGION_RUNTIME_TOKEN`、orchestrator 的 `LEGION_RUNTIME_URL`），
  每条都写了来源与「没有时怎么办」。

`orchestrator/config-schema.mjs` 与 `orchestrator/worker/executor-binding.mjs` 里
那两段「⚠️ 它们还没有被写进清单」的注释**已按事实改掉**——留着它们会让
下一个读代码的人以为缺口还在，而去修一处已经修好的东西。

### 2.4 顺带闭掉的第四个缺口：`LEGION_DATA_DIR`（任务书里没有这一条）

**这一条不是任务书要求的，是实测撞出来的**，所以单独写在这里。

`orchestrator/worker/run.mjs` 在缺 `LEGION_DATA_DIR` 时返回
`exitCode: 8` / `code: 'DATA_DIR_REQUIRED'`（那段注释自己写着：
状态文件是这个**没有监听端口**的进程的**唯一观测出口**）。

而在本批之前，`product/launcher/launcher.mjs` 里
**一次都没有**写过这个键（`git show HEAD:product/launcher/launcher.mjs`
里 `LEGION_DATA_DIR` 出现 **0** 次）。它能到达子进程只是因为清单的
`envNames` 一直放行它，然后由 `baseEnv` 带进去——而 `baseEnv` 的默认值是
`{}`，不是 `process.env`：

> **「白名单放行」与「有人真的注入了它」是两件事。**

实跑读数（真入口 `product/orchestrator/worker.mjs`，`--include orchestrator`）：

| 处境 | `status().processes[orchestrator]` |
| --- | --- |
| 注入 `LEGION_DATA_DIR`（本批） | `state: 'ready'`、`pid: 22736`、`restarts: 0` |
| 不注入（= 本批之前的 Launcher） | `state: 'restarting'`、`pid: null`、`restarts: 2` |

也就是说：本批之前，一个由 Launcher 拉起来的 orchestrator 会**崩溃重启循环**。
而它的 `lastError` 是 `null`——**这个循环在 Launcher 的读数里没有一条错误信息**，
只表现为重启计数。这一条现在有用例盯着（`①b` / `①c`，见 §6.1、§6.3）。

`runtime` 进程也一并注入（端口发布要落在 DataDir 下），用的是**同一个**目录。

---

## 3. 缺口 2：端口怎么从 Runtime 进程到 worker

### 3.1 先说清楚问题

契约监听器绑的是**临时端口**（`bindPort: 0`）。这是对的，而且**不能改**：

* 一个固定端口会让「没配」与「配在这个端口上」在读数上同形；
* 3080 已被 DSH 自己占用（续批三 §7.1 的实测）；
* 两台 Runtime 会撞在同一个端口上。

于是问题变成：**另一个进程凭什么知道这个随机数字？**

### 3.2 选定的机制：**由真的绑上了的那个进程发布，消费侧读回并校验**

新增 `runtime/dsh-composition/runtime-contract-publication.mjs`（写侧）与
`product/launcher/runtime-contract-endpoint.mjs`（读侧）。

```
Runtime 进程                           Launcher                       worker 进程
─────────────                         ────────                       ──────────
监听器 listen() 成功
  → address() 读回真实端口
  → 原子写 <dataDir>/runtime/runtime-contract.json
     {version,pid,host,port,wireVersion}

                    spawn runtime 之前：先删掉上一次的同名文件
                    spawn orchestrator 之前：
                      readFileSync → JSON.parse
                      → 形状校验（version/host/port/wireVersion）
                      → **身份校验：pid 必须等于本次那个 runtime 子进程**
                      → 拼出 http://127.0.0.1:<port>
                                          → LEGION_RUNTIME_URL ────────→ 读它
                                          → LEGION_RUNTIME_TOKEN ──────→ 读它
```

四条设计约束，每条都对应一条具名拒绝：

| 约束 | 没有它会发生什么 | 具名码 |
| --- | --- | --- |
| 只在 `listen()` **成功之后**发布 | 消费侧拿到一个没人听的端口，症状是 `RUNTIME_UNREACHABLE`（看起来像网络问题） | —（写侧不发布） |
| 写是**原子**的（临时文件 + `rename`） | 消费侧读到半截 JSON，而半截文件与「坏掉的发布」在 `JSON.parse` 之后同形 | `PUBLICATION_UNREADABLE` |
| 消费侧用 **pid** 判身份 | 「文件在」被当成「Runtime 在跑」——进程可以被无条件终止，文件会留下 | `PUBLICATION_STALE` |
| 读不到就**不注入**，绝不回落默认端口 | 一个猜出来的地址会让「引擎在哪里」变成一个我们其实不知道的答案 | `PUBLICATION_ABSENT` |

### 3.3 被否决的替代方案：**Launcher 先分配端口，再传给 Runtime**

这条路也走得通——`product/launcher/ports.mjs` 本来就有 `reserveEphemeralPort()`
（它自己的注释里已经写明那是一次「先绑一次再放开」的、**有竞态**的预留）。
本批**没有**选它，理由是一条具体的失败模式，而不是风格偏好：

> **先绑一次再放开**，到 Runtime 进程真的绑上之间有一个窗口。
> 窗口里被别的进程抢走时，Runtime 进程里那一行会报 `LISTEN_FAILED`
> （具名、正确），**但 Runtime 进程自己仍然是健康的**——
> 它的 `/` 照样返回 200，于是 Launcher 报「runtime 就绪」，
> 并把那个已经不属于任何人的端口交给 worker。
> worker 读到的是 `RUNTIME_UNREACHABLE`（「配了但够不着」），
> 而真因（端口被抢）只写在**另一个进程**的一份服务值里。

也就是说：这条路把「分配失败」的读数**挪到了一个看不见的地方**。
发布文件这条路把「谁真的绑上了」当成唯一事实来源——监听成功之前不发布，
所以「发布的端口」与「在听的端口」不会有分歧。

**代价如实列出**（这一段是它相对替代方案的劣势）：

* 多一个文件、多一处需要在崩溃后处理的陈旧状态；
* 多一次磁盘往返（在 `listen()` 之后、worker 起来之前）；
* 两个进程必须共享 DataDir 的约定（`<dataDir>/runtime/`）；
* 发布是**非同步**的：`orchestrator` 起来时它可能还没出现（见 §3.5 的等待）。

### 3.4 三种失败模式，各自的读数

| 处境 | 读数 | 修法 | 会不会编 URL |
| --- | --- | --- | --- |
| **没有发布**（那一行没挂 / 没给 `dataDir` / 还没发布） | `RUNTIME_CONTRACT_PUBLICATION_ABSENT` | 去看 Runtime 那一行挂没挂、`LEGION_DATA_DIR` 有没有给 | 不会 |
| **陈旧发布**（上一次崩溃留下的，或**第二个进程**在写同一个 DataDir） | `RUNTIME_CONTRACT_PUBLICATION_STALE`（带上 `publishedPid` 与 `expectedPid`） | 去看是谁在写同一个 DataDir | 不会 |
| **内容非法 / 读不了** | `RUNTIME_CONTRACT_PUBLICATION_INVALID`（逐字段点名）/ `..._UNREADABLE` | 前者查写侧版本与取值域，后者查盘/权限 | 不会 |

另外两条只可能出现在更早的阶段，各自也有名字：
`..._PATH_UNAVAILABLE`（连 DataDir 都没有）与
`..._TOKEN_GENERATION_FAILED`（凭证那一路，见 §4）。

**「陈旧」与「没有」必须是两个码**：前者的修法是「去看谁在写同一个 DataDir」，
后者的修法是「去把那一行挂上」。压成一个码，运维只能靠文案猜。

### 3.5 为什么必须**等**，以及等到超时报什么

写侧那一行是在 DSH 的 Loader **并发**创建补丁行时 `apply` 的
（`Promise.allSettled(config.map(create))`），所以「Runtime 那台进程起来了」
与「契约那一行绑好端口并发布了」之间**没有顺序保证**。读一次会把一次正常的启动
报成缺发布。于是 `waitForRuntimeContractEndpoint()` 轮询等待（默认 5s / 50ms）。

超时之后返回的是**最后一次的那个拒绝**，不是合成一个新的 `..._TIMEOUT`：

* 一直没出现过 → `PUBLICATION_ABSENT`（它就是「没人发布」的准确读数）；
* 一直是旧进程那一份 → `PUBLICATION_STALE`（「有东西在写，但不是本次那个」）。

> 一个合成的「超时」码会把两种**修法完全不同**的处境压成同一个读数——
> 而排障的人第一步就是要在它们之间选一个方向。

`PUBLICATION_PATH_UNAVAILABLE` 与 `TOKEN_GENERATION_FAILED`
**不在可重试集合里**：等下去它们不会变好。`ABSENT` / `UNREADABLE` /
`INVALID` / `STALE` 在，因为它们都能由「本次那个进程稍后覆盖旧文件」变成正常。

### 3.5.1 一条被实跑纠正的东西：受限启动里的严重级

`runtimeContractDiagnostic()` 的第一版把 `severity` 硬写成 `'error'`，
而它的注释里写着「带错 `process` 会让 `--include` 的作用域降级判据落空」。
实跑一个 `--include orchestrator`（**不含** `runtime`）的启动，读数是：

```
诊断 = [ {PROCESS_EXCLUDED_BY_SCOPE, runtime, warn},
         {PROCESS_EXCLUDED_BY_SCOPE, runtime, warn},
         {READINESS_VERIFIED, orchestrator, warn},
         {RUNTIME_CONTRACT_PUBLICATION_ABSENT, orchestrator, error} ]
started.ok = true
```

两点被这条读数钉住：

1. 那句注释是**错的**：这些诊断是**启动过程中**产生的、直接拼进最终列表，
   **不经过** `launcher.mjs` 里那段「被 `--include` 排除的进程降级为 warn」
   （它跑在启动计划那一步，用的是 `planDiagnostics`）。所以 `process` 字段
   只影响「人去哪里找」，不影响严重级。
2. 于是那次**刻意**的受限启动带着一条 `error` 出来——而它**并不阻塞启动**
   （`started.ok = true`）。一个不阻塞的 `error` 只会训练人忽略 `error`，
   而且根因已经有一条 `PROCESS_EXCLUDED_BY_SCOPE`（warn）说过一次了。

修法是给 `runtimeContractDiagnostic(result, { severity })` 加一个显式参数，
调用点在这一条上传 `warn`；**码不变**（`PUBLICATION_ABSENT` 是准确的事实，
而且 `derivedValuesFor` 依赖 `ok !== true` 才不注入 URL）。
注释也按实测改成了它真正的行为。

### 3.6 崩溃残留怎么处理

`Launcher` 在 **spawn Runtime 之前**删一次发布文件。那条顺序给出的保证是：

> **清完之后再出现的发布，只可能来自本次那个进程。**

pid 判定是第二道（清理失败只记一条 `warn`：`PUBLICATION_CLEAR_FAILED`，
因为 pid 判定仍然兜得住）。

**这一条我是破验过的，而且第一版是错的**：第一版只断言「启动成功且最终的
pid 是对的」——把 `clearStalePublication()` 里那一句 `rmSync` 删掉之后它**照样绿**，
因为 Runtime 进程会把新发布**覆盖**上去，于是「清掉了」与「没清、只是被覆盖了」
在**末态上同形**。改法是给真 fs 套一层记账包装，断言
`rmSync(发布路径, {force:true})` 真的被调用过、且排在**任何一次读之前**。
再破验一次：删掉那句 `rmSync` → 该用例变红（读数见 §6.3 变异 A）。

### 3.7 写侧的那一行怎么拿到 DataDir

`runtime-contract-server-row.mjs` 的输入从
`{runtimeHost, token, bindPort, enforcement?}` 扩展为
`{runtimeHost, token, bindPort, dataDir?, enforcement?}`——
**`dataDir` 是可选的**，而且两种情况**必须可分**：

| 处境 | 行内读数 | 后果 |
| --- | --- | --- |
| 没给 `dataDir` | `ok:true` + warning `RUNTIME_CONTRACT_ROW_NO_PUBLICATION_DIR` | 服务照起、照听，**但另一个进程发现不了它**；Launcher 会以 `..._PUBLICATION_ABSENT` 具名拒绝 |
| 给了但写失败 | `ok:true` + warning `RUNTIME_CONTRACT_ROW_PUBLICATION_FAILED` | 同上，但修法是查路径而不是补输入 |

**为什么不让它 `ok:false`**：把「降级」与「没装上」合成一个读数，
会让一个只配了一半的部署看起来像完全没配——这与那一行既有的
`NO_TOKEN` 处理是同一条判据（`NO_TOKEN` 也是一条 warning，不是 `ok:false`）。

服务值新增一个 `publication: {published, path, code}` 字段，
`degraded()` 路径上也给出**形状完整**的同一字段（`{published:false, path:null}`）：
读侧读到 `undefined.published` 与读到 `false` 是两件事，后者说「这一行明确地
没有发布」，前者会让调用方崩或静默判假。因为服务值的形状变了，
`RUNTIME_CONTRACT_ROW_VERSION` 从 `1` 提到 `2`。

行被卸载时发布文件也一并清掉（`ctx.effect` 的 disposer 里）：
本行卸掉之后「本进程在听哪个端口」这句话就不成立了，留着它是一份陈旧发布。

---

## 4. 缺口 3：凭证的产生与分发（安全面的决定）

### 4.1 决定

* **谁生成**：**Launcher**（`product/launcher/runtime-contract-endpoint.mjs` 的
  `generateRuntimeToken`）。理由是它独占两个能力——
  `product/launcher/allowlist.mjs` 的白名单注入，以及唯一同时看得到
  `runtime` 与 `orchestrator` 两个子进程的位置。
* **什么时候生成**：**每次 `createLauncher()` 一份**（即每次启动一份），
  惰性求值 + 记忆化（`envSurface()` 与 `envFor()` 必须问出**同一个值**——
  两次生成会让两个进程拿着两份不同的凭证，而那表现为「鉴权失败」）。
* **怎么生成**：`node:crypto` 的 `randomBytes(32)` → `base64url`（43 个字符）。
  **零新增第三方依赖**。
* **给谁**：**只有 `runtime` 与 `orchestrator`**。其余三个进程
  （`team-hub` / `workbench` / `whiteboard`）的 `envNames` 里没有这个键，
  所以 `buildChildEnv()` 连宿主环境里的同名值都不放行。
  `product/launcher/allowlist.test.mjs` 用 `deepEqual` 逐字钉住这张表，
  并额外断言那三个进程拿不到它。
* **怎么传**：**只经环境变量**。不进 `argv`、不进日志、不进运行记录、
  不进状态文件、不进端口发布文件。

### 4.2 为什么不复用 DSH 的 `.credentials.yaml` 或既有密钥库

`product/launcher/secrets-check.mjs` / `product/secrets.mjs` 那一套解决的是
**模型密钥**（长期、跨启动、要落盘、经 `secretRef` 解析）。本凭证的性质完全不同：

* 它的射程只有**本机回环**，生命周期只有**这一次启动**；
* 落盘会让它变成「一个跨启动继续有效的凭证」，而那时它保护的是一个
  已经不存在的会话；
* 一个提交进仓库的常量会让**任何**拿到那份源码的进程都能调用执行面——
  而「谁能调用执行面」正是这条边界要守住的东西。

> 把这两个东西合并成一个机制，会让「本次启动的一次性回环凭证」
> 获得「长期密钥」的落盘与轮换要求，而那是它不需要、也不该有的。

### 4.3 fail closed 的形态

生成失败时（随机源不可用、返回值不是缓冲、太短、含空白）：

1. **不注入任何值**——不空串、不默认、不「关掉鉴权」；
2. 返回具名码 `RUNTIME_CONTRACT_TOKEN_GENERATION_FAILED`，
   且返回值里**没有 `token` 字段**（有字段的失败路径会被调用方顺手用掉）；
3. Launcher 把它记进启动诊断；
4. 对端的真实读数是 `RUNTIME_CONTRACT_NO_TOKEN`（403，「这台进程没配」），
   而**不是** 200。

一个含空白的凭证也被拒绝：它在 HTTP 头里会被截断，而症状是「凭证不对」
——离真因很远。

### 4.4 `config-schema.mjs` 的 `sensitive: true` 买到了什么

`orchestrator/config-schema.mjs` 里 `runtimeToken` 字段标了 `sensitive: true`。
本批**核对了它到底管什么**，结论要说清：

* 它**不**参与 `buildChildEnv()` 的白名单判定（那是 `envNames` 的事）；
* 它是一份**声明**，与 `hubToken` 同列，被 `worker/status-file.mjs` 的
  禁用键名单钉着——也就是「跨进程凭证绝不进状态文件」这条纪律在**读取层**的落点；
* 本批新增的注入**遵守**这条纪律，但没有依赖它：
  凭证不进状态文件的保证来自「Launcher 根本不把它交给写状态文件的代码路径」，
  而不是来自那份声明。

### 4.5 射程（比续批三 §6.3 前进了多少）

续批三说「token 的产生与轮换本批没有实现，所以『凭证怎么来』这个问题今天是空的」。
本批把**产生与一次性分发**填上了。**没有**填上的是：

* **轮换**：进程活着的时候不换（换了也没人通知 worker）；
* **重启后的续用**：每次启动都是新的一份，旧的那份随进程环境消失
  （这是有意的）；
* **防本地读环境的人**：回环监听 + 环境变量传递的威胁模型里已经包含
  「本机上一个能读进程环境的人」。本批没有防御他，也没有声称防御他。

---

## 5. 改动的文件

### 5.1 新增

| 文件 | 是什么 |
| --- | --- |
| `runtime/dsh-composition/runtime-contract-publication.mjs` | 端口发布的**写侧**（原子写、清理、具名码） |
| `runtime/dsh-composition/runtime-contract-publication.test.mjs` | 它的套件（12 条） |
| `runtime/dsh-composition/plugins/runtime-contract-server-row.test.mjs` | 契约行的**行内**套件（9 条，续批三没有它） |
| `product/launcher/runtime-contract-endpoint.mjs` | 端口发布的**读侧** + 凭证生成 + 具名码 |
| `product/launcher/runtime-contract-endpoint.test.mjs` | 它的套件（21 条，含两份副本对账） |
| `product/launcher/runtime-contract-wiring.test.mjs` | **接线**的真进程套件（7 条） |

### 5.2 修改

| 文件 | 改了什么 |
| --- | --- |
| `product/process-manifest.mjs` | 两处 `envNames` 增量扩展（§2）；**零处结构改动** |
| `product/config-schema.mjs` | `CHILD_ENV_NAMES` +2、`nonEnvLiterals` +8、`injects` +5、`notes` 一段 |
| `product/launcher/launcher.mjs` | 新增两个注入参数（`runtimeTokenFactory` / `publicationFs`）、凭证生成与记忆化、陈旧发布清理、端点解析与等待、把三者接进两波循环与诊断、导出 `runtimeContract()`；`derivedValuesFor()` 新增两个进程的 `LEGION_DATA_DIR` 注入（§2.4） |
| `product/launcher/allowlist.test.mjs` | **改掉一条断言的前提**（原文断言 `runtime` 不得有任何凭证键）；口径仍是逐字 `deepEqual` + 新增反向锚（§5.3） |
| `runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` | 可选 `dataDir` 输入、`publication` 服务值字段、两条 warning 码、`ROW_VERSION` 1→2、卸载时清发布 |
| `orchestrator/config-schema.mjs` | 把那两段「⚠️ 还没写进清单」的注释改成「✅ 已补」 |
| `orchestrator/worker/executor-binding.mjs` | 同上（一处注释） |
| `orchestrator/worker/runtime-contract-cross-process.test.mjs` | 夹具给 `dataDir`、`CONTRACT-FACTORY-CALLED` 增加 `dataDirConfigured=`、新增 A0b（真进程发布对账）与 A3b（DataDir 全文件扫凭证） |

`docs/STATUS.md`、`docs/superpowers/prt/PRT-PROGRESS.md`、
`docs/superpowers/prt/PRT-IMPLEMENTATION-REPORT.md`、
`scripts/ci/run-ci.mjs`、`runtime/dsh-composition/legion-host.patch.yml`
**一个字节都没改**（操作者拥有它们）。
`legion-host.patch.yml` 仍然**没有**挂契约行——本批没有动它，
所以那台进程里的契约行仍然由 `root.mjs` / 测试的补丁层挂载。

### 5.3 一条被**改掉前提**的既有断言（必须单独说）

`product/launcher/allowlist.test.mjs` 原文是：

```js
assert.equal('runtime' in byProcess, false, 'runtime 不得有任何凭证类环境变量（模型密钥走 secretRef 解析）')
```

它的**理由仍然成立**（runtime 依旧拿不到模型密钥），但它的**前提**被本批改掉了：
`LEGION_RUNTIME_TOKEN` 不是模型密钥，而是契约的**服务端凭证**——
服务端要拿它比对 worker 出示的那一份，因此它**必须**在 runtime 进程里；
而它不能经发布文件/状态文件传递（那些要落盘），环境变量是唯一既不落盘、
又只在该进程内可见的通道。

处置是**把口径写清楚并保持逐字列举**，而不是放松它：

```js
assert.deepEqual(byProcess.runtime, ['LEGION_RUNTIME_TOKEN'], …)
assert.deepEqual(byProcess.orchestrator, ['TEAM_HUB_TOKEN', 'LEGION_RUNTIME_TOKEN'])
// 反向锚：契约凭证只进了这两个进程
for (const proc of ['team-hub', 'workbench', 'whiteboard']) { … includes(...) === false }
```

逐字 `deepEqual` 保住的性质正是原文要保的：**『有人又给 runtime 加了一个
`*_TOKEN`』在断言层面立刻可见**。把 `runtime` 从表里删掉（原文那种写法）反而
做不到这一点——那正是原文注释自己说的。

---

## 6. 验证（本批实际跑的）

全部在 `D:\project\DSH\legion\.worktrees\prt-runtime`（分支 `codex/prt-runtime`）下，
`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`，Node `v24.19.0`。

### 6.1 新增/改动的套件（逐条原始读数）

| 命令 | 读数 |
| --- | --- |
| `node --test runtime/dsh-composition/runtime-contract-publication.test.mjs` | `tests 12 / pass 12 / fail 0` |
| `node --test runtime/dsh-composition/plugins/runtime-contract-server-row.test.mjs` | `tests 9 / pass 9 / fail 0` |
| `node --test product/launcher/runtime-contract-endpoint.test.mjs` | `tests 21 / pass 21 / fail 0` |
| `node --test product/launcher/runtime-contract-wiring.test.mjs` | `tests 9 / pass 9 / fail 0` |
| 上面四个一起 | `tests 51 / pass 51 / fail 0`（`duration_ms 15467.4`） |
| `node --test orchestrator/worker/runtime-contract-cross-process.test.mjs` | `tests 19 / pass 19 / fail 0`（`duration_ms 38457.0`，5 次真 DSH 启动） |
| `node --test "product/launcher/*.test.mjs"` | `tests 390 / suites 6 / pass 390 / fail 0` |

续批三的四个套件里，本批改了的那一个是
`orchestrator/worker/runtime-contract-cross-process.test.mjs`（从 17 条到 19 条）。

### 6.2 静态门禁（`git add -A` 之后）

| 命令 | 读数 |
| --- | --- |
| `node scripts/config/scan.mjs --check` | `scan: PASS（全部 env 读取点与疑似字面量均已处理；共 558 个疑似字面量）` |
| `node scripts/ci/ci-syntax.mjs` | `ci-syntax: PASS（50 个脚本全部可被 Node 解析）` |
| `node scripts/ci/encoding-check.mjs --all --quiet` | `encoding-check: PASS（1916 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；37 个历史采集物为 UTF-16，已列出）` |
| `node scripts/ci/check-docs.mjs` | `check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）` |
| `node scripts/ci/dsh-boundary.mjs --check` | `dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）` |
| `node scripts/prt/topology-inventory.mjs --diff` | `topology-inventory: 与清单一致（无漂移）` |
| `node scripts/prt/baseline-snapshot.mjs --check` | `baseline-snapshot: 平台契约与基线一致（无漂移）`（exit 0） |

**`scan` 第一次是红的**，红在一处真实缺口上：本批新增的 `ENOENT`
（发布不在的判据）不在任何 schema 的 `nonEnvLiterals` 里，
`scan: FAIL —— 1 项未在 schema 中处理`。补登记之后转绿。
这是门禁在干活的证据，不是一次顺手放过。

### 6.3 破验（五个变异，**逐条实跑**）

| 变异 | 改的是什么 | 实跑读数 | 判断 |
| --- | --- | --- | --- |
| A | `launcher.mjs` 的 `clearStalePublication()` 里删掉 `fsImpl.rmSync(path, {force:true})` | `runtime-contract-wiring.test.mjs` 的 ③b 变红：`AssertionError: Launcher 没有清掉上一次的发布（记账：["readFileSync:runtime-contract.json"]）` | **被咬住** |
| B | `launcher.mjs` 的 `derivedValuesFor()` 里删掉 `out.LEGION_RUNTIME_URL = runtimeContractEndpoint.url` | ① 变红（`urlPresent:false`）、② 变红（`正向对照没跑通：{"urlPresent":false,…}`） | **被咬住**（2 条） |
| C | ③b 的第一版（只断言末态、不记账） | 上面的变异 A **没有**咬住它 | **已改成记账式**（见 §3.6） |
| D | `derivedValuesFor()` 里删掉 orchestrator 的 `out.LEGION_DATA_DIR = layout.dataDir` | ①b 变红（`actual: undefined` / `expected: '…\\data'`）；①c 变红（`真 worker 没有进程：{"state":"restarting","pid":null,"restarts":2,…}`） | **被咬住**（2 条） |
| E | 把 `runtimeContractDiagnostic()` 里 `severity` 改回硬编码 `'error'` | 单测「③ 五条可分拒绝 + 重试集合」变红（`assert.equal(w.severity,'warn')`） | **被咬住** |

变异 A 的原始读数（`node --test --test-name-pattern="③b"`）：

```
✖ ③b ★★ 崩溃残留：Launcher 在 spawn Runtime **之前**删掉上一次的发布，本次再覆盖它
  AssertionError [ERR_ASSERTION]: Launcher 没有清掉上一次的发布（记账：["readFileSync:runtime-contract.json"]）
      at product\launcher\runtime-contract-wiring.test.mjs:449:10
ℹ tests 1 / pass 0 / fail 1
```

变异 D 的原始读数（`node --test --test-name-pattern="①b|①c"`，两处尾部）：

```
✖ ①b ★★ Launcher 也把 `LEGION_DATA_DIR` 交给 worker（否则 worker 起来就退 8）
  AssertionError: actual: undefined / expected: 'C:\\Users\\…\\Temp\\legion-wire-datadir-TQyvC0\\data'
✖ ①c ★★★ 真入口：Launcher 启动**真的** worker.mjs 时它稳定运行；没有 DataDir 时退 8
  AssertionError: 真 worker 没有进程：{"state":"restarting","pid":null,"restarts":2,…}
ℹ fail 2
```

还原方式：改回那几行，`git status --porcelain` 确认工作树只剩本批的文件，
`Select-String product/launcher/launcher.mjs -Pattern BREAK-VERIFY` 无匹配。

变异 C 值得单列：**它不是代码的缺陷，是用例的缺陷**，
而它只在"我试着让用例变红"的那一步才显现。

> 一条只能看见末态的断言，分不出"做过清理"与"结果碰巧一样"。

### 6.4 一次**与本事批无关**的既有 flake（如实报告）

`node --test "runtime/dsh-composition/*.test.mjs" "runtime/dsh-composition/plugins/*.test.mjs"`
（690 条）在**大批并发**下偶尔有 1 条红，红的通常是
`tool-request.test.mjs` 的「★★★ PRT-212：自报了连接才算响应阶段超时」，
读数是 `actual: 'allowed-once' / expected: 'unavailable'`。

**它不是本批引入的**，两点证据：

1. 出问题的文件与它的两个产品模块在本批**完全没有出现在 `git status` 里**；
2. 用一个从 `HEAD`（`9517faf`）检出的**独立工作树**跑同一条批量命令 6 次，
   **2 次失败**（且失败面更大：还带上 `④ 总预算不被超过`、
   `① 端到端：结算带上真实用量`、`③ 引擎故障`）。

机制是**真实计时器竞态**：那个用例里 `responseTimeoutMs: 25` 而替身请求
`await setTimeout(r, 60)`，并发负载下 60ms 的定时器可能先落地。

本批**没有修它**（不在范围内），也没有据此调整任何读数。

### 6.5 `scan` 这一侧的覆盖情况（**不粉饰**，口径同续批三 §7.5）

`scripts/config/scan.mjs` 的 `PROCESSES` 里**没有** `runtime`。所以：

* **被 `scan` 覆盖的是**本批改动里的 `product/` 与 `orchestrator/` 那一部分
  （`process-manifest.mjs` 的两个新键、`product/config-schema.mjs`、
  `product/launcher/*.mjs` 的新字面量与错误码）；
* **不被覆盖的是**全部 `runtime/` 新代码：
  `runtime/dsh-composition/runtime-contract-publication.mjs` 与
  `runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` 的改动，
  以及两个 `runtime/` 套件（`runtime-contract-publication.test.mjs`、
  `plugins/runtime-contract-server-row.test.mjs`）。
  `scan --check` **绿**这件事对这批代码**不是证据**。

---

## 7. ★ 诚实边界

### 7.1 三个缺口：闭了什么、没闭什么

| # | 状态 | 精确到什么程度 |
| --- | --- | --- |
| 1 | **闭合** | worker 子进程的环境里**真的有**这两个键（`runtime-contract-wiring.test.mjs` ① 用真子进程读到，并让对端回 200）；而且**只有那两个**进程拿得到（①末尾与 `allowlist.test.mjs` 逐字钉住） |
| 2 | **闭合** | 端点从「Runtime 进程发布的、由 `address()` 读回的实际端口」来；Launcher 用**本次那个子进程的 pid** 校验；没有发布/发布陈旧时**具名拒绝且不注入 URL**（①/②/③/③b） |
| 3 | **闭合（射程见 §4.5）** | 每次启动一份、只给两个进程、失败就不注入（对端 403 `NO_TOKEN`）、值不进 envSurface/status/诊断/日志/运行记录/子进程 stdout/DataDir 任何文件（④/⑤ 与 cross-process A3/A3b） |
| 4 | **顺带闭合**（任务书没有这一条，见 §2.4） | Launcher 现在真的注入 `LEGION_DATA_DIR`；**真入口** `product/orchestrator/worker.mjs` 因此从「崩溃重启循环」变成稳定 `ready`（①b/①c 两条，正负对照都在） |

### 7.2 端到端到底证到什么程度

**必须分清三层的「真」：**

| 层 | 这一层是真的吗 | 谁验的 |
| --- | --- | --- |
| Launcher 把值交给子进程 | **真的**（真 `spawn`、真白名单 env） | `runtime-contract-wiring.test.mjs` ①/④/⑤ |
| 端口发布与鉴权 | **真的**（真 `node:http` 监听器、真 `address()`、真 `timingSafeEqual`、真文件原子写） | 同上 + `runtime-contract-publication.test.mjs` |
| **DSH Runtime 进程里的那一行** | **真的**（真 `dsh` CLI、真 Loader、真补丁层、真 `ctx.provide`） | cross-process A0b（真进程写出的发布与它自报的端口对账） |
| **orchestrator 的真入口** | **真的**（`product/orchestrator/worker.mjs` 本身，不是探针）——但只到「它稳定起来了、能写状态文件」 | `runtime-contract-wiring.test.mjs` ①c |
| **worker 那一侧的产品入口**（派工那一路） | **半真**：①/②/④/⑤ 里跑的是**最小探针**（读两个键 + 按契约发一次请求），**不是** `product/orchestrator/worker.mjs` 的派工路径 | — |
| **引擎** | **替身**（`createFakeRuntimeAdapter` / 脚手架 `startRun`） | 续批三 §6.1 的结论**未变** |

①c 与 ①/②/④/⑤ 的分工要说清：前者用的是**真入口**但只观察到「它在跑」，
后者用的是**探针**但观察到「端点真的被接受了」。两件事没有在同一次运行里
同时成立过——这是本批的一处**结构性限制**（要同时做到，需要一台真 hub
与一次真实派工，见下）。

**所以下面是明确**没有**被证明的东西：**

* **没有任何一个真 DSH 引擎跑完过一个真任务。** 这一条与续批三一样，一个字都不改。
* **没有一次"由 Launcher 启动的完整部署（含真 worker 派工路径）执行了一个任务"的读数。**
  `runtime-contract-wiring.test.mjs` 证明的是**接线**（值到达了对端且被接受），
  不是「`product/orchestrator/worker.mjs` 因此完成了派工」。
  后者需要一台真 hub、一份 lease 与一次真实派工。
* **①c 里那个真 worker 没有连上任何 hub**（`TEAM_HUB_URL` 没给 → 它以
  hub-unreachable 状态稳定运行）。也就是说 ①c 证明的是「它不再崩溃重启」，
  **不是**「它能干活」。
* **没有用带 bundle 的真实 profile 启动过**（安全规则要求 `bundles: []`），
  所以「真实部署里 `subagents` / `tools` / `sandbox` 的形状与这里一致」仍是**假设**。
* **`product/launcher/runtime-contract-wiring.test.mjs` 里的 Runtime 进程是替身**：
  它跑真的服务端与真的发布，但引擎端口是契约级 Fake 适配器。

### 7.3 仍然是旧的缺口（本批没碰，也没有变好）

* **`currentModelSelection` 没有生产来源**（续批三 §6.5）。
  后果不变且**更近了**：跨进程那条路一通，下一个读数会是 `MODEL_UNAVAILABLE`，
  而不是 `EXECUTOR_HOST_PORT_REQUIRED`。
* **`legionRuntimeHostBinding`（`enforcement` 来源 ②）在真进程里没被行使过**
  （续批三 §6.6）。本批**没有**改这一条；实跑里 `enforcementConfigured=1`
  仍然来自本行自己的判断。
* **`legion-host.patch.yml` 里没有契约行**，本批也没有加
  （它是操作者的文件）。所以一个真实的 `dsh` 部署要挂上这一行，
  仍然需要一次**补丁层**的改动——本批只保证了"挂上之后线是通的"。

### 7.4 本批新引入的、**如实列出的**未覆盖面

* **`runtimeContract()` 返回 `null` 的那条分支**没有被真进程套件走到：
  它要求「runtime 不在范围内」或「runtime 已失败」，而后者会让整体回滚。
  行内逻辑（`resolveRuntimeContractEndpoint` 的早返回）只有读代码可确认，
  **没有用例**。
* **`PUBLICATION_CLEAR_FAILED`（清理失败只记 warn）没有用例**：
  它要一个"删不掉但读得到"的文件（Windows 上被独占的文件），
  本批没有构造它。它的后果由 pid 判定兜住，但**那条 warn 本身没被验过**。
* **`PUBLICATION_INVALID` 与 `PUBLICATION_STALE` 在真进程里各只走了一种形态**：
  前者只走了单测（六种字段各一条），后者只走了"pid 不同"。
  「第二个进程在写同一个 DataDir」这个真实场景**没有**被构造。
* **`publicationFs` 注入在生产里恒为 `null`**（真 fs）。除 ③b 之外的真进程用例
  走的是真 fs，而 ③b 走的是**记账包装真 fs**。也就是说"注入的假 fs"这条路
  只在单测里被行使。
* **凭证的轮换**没有实现，也没有用例（见 §4.5）。**进程活着时不换**是当前事实。
* **`LEGION_DATA_DIR` 只被验到"注入了、真入口因此不死"**（①b/①c）。
  **没有**用例验「worker 真的把状态文件写到了那个目录里」——
  ①c 用的是真入口，但断言只看 `state`/`pid`/`restarts`，没有去读那个状态文件。
  这是一处**可以补而没补**的接线断言（补的成本很低：读一下
  `<dataDir>/orchestrator/…` 下的状态文件）。

### 7.5 本批**没有**做的事

* **没有**跑满 CI（`scripts/ci/run-ci.mjs`）、**没有**提交、**没有**推送。
* **没有**改 `docs/STATUS.md` / `PRT-PROGRESS.md` / `PRT-IMPLEMENTATION-REPORT.md` /
  `runtime/dsh-composition/legion-host.patch.yml`。
* **没有**跑 `topology-inventory.mjs --record` 或 `baseline-snapshot.mjs --record`
  （两条都是 `--diff` / `--check`，读数在上表；要不要记录由操作者决定）。
* **没有**动 `PORT_ENV_KEYS` / `derivedValuesFor` 里既有的端口派生管道
  （`team-hub` / `whiteboard` 那两条**一个字节没变**；契约端点走的是**另一条**路）。
* **没有**引入任何新依赖（`node:crypto` / `node:fs` / `node:http` 都是标准库）。
* **没有**修 §6.4 那条既有 flake。

### 7.6 仍然**真正未决定**的一件事

**`<dataDir>/runtime/runtime-contract.json` 这个位置本身是一个约定，
而不是一条被评审过的接口。** 两份副本（写侧 `runtime/dsh-composition/`、
读侧 `product/launcher/`）由 `runtime-contract-endpoint.test.mjs` 的
【逐段对账】用例钉住（版本 / 相对路径片段 / 字段清单三样逐字相等），
但**为什么是这个名字、为什么在这个目录下、要不要给它一个更强的隔离**
（例如放进一个只对这两个进程可读的子目录）**本批没有论证**。
它落在「DataDir 下的进程子目录」这套既有约定里（与 `team-hub/team.db` 同一条），
但在一个把凭证与端点都放在本机的地方，**这个位置值得下一次评审**。

---

## 8. 本批新增的套件（操作者需要登记）

* `runtime/dsh-composition/runtime-contract-publication.test.mjs`
* `runtime/dsh-composition/plugins/runtime-contract-server-row.test.mjs`
* `product/launcher/runtime-contract-endpoint.test.mjs`
* `product/launcher/runtime-contract-wiring.test.mjs`

改动的套件：`product/launcher/allowlist.test.mjs`、
`orchestrator/worker/runtime-contract-cross-process.test.mjs`。

---

## 9. 下一批最该做的三件事（按读数与代价排序）

1. **`currentModelSelection` 的生产来源**——续批三 §9.1 的第一条，
   本批**没有**动它，而它现在离"会被撞上"更近了（§7.3）。
2. **把契约行挂进 `legion-host.patch.yml`**，让一个真实部署真的起这台监听器。
   本批证明了"挂上之后线是通的"，但**那份补丁层今天没有它**（§7.3）。
   这是操作者的文件，需要一次显式改动。
3. **`legionRuntimeHostBinding` 发布自己的拒绝**（续批三 §6.6）：
   它仍然是唯一一个"逻辑存在、在真进程里从没被行使过"的接缝。

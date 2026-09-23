# 接管队列（2026-09-23）—— 守护全停之后

> **本文件是"本会话接下来按什么顺序做什么"的队列，不是新的台账。**
> 「PRT 实施到哪一步」的唯一权威入口仍是
> [`PRT-PROGRESS.md`](PRT-PROGRESS.md)（141/145 ✅，未完成 4）；
> 需要业主一句话的事项在 [`../../DECISION-BRIEF.md`](../../DECISION-BRIEF.md)。
> 本文件**不改任何状态格**，只记录：谁在做、按什么顺序、以及为什么是这个顺序。
> 台账、spec 与本文件冲突时，以台账与 spec 为准。

---

## 0. 本轮已落地的两件事（都有读数）

### 0.1 守护全停

| 对象 | 之前 | 现在 | 读法 |
| --- | --- | --- | --- |
| `include:legion-scrum-worker-ozon` | `enabled: true` | **`enabled: false`** | `plugin_manager` 改的，**profile 级、立即应用** |
| `include:legion-scrum-worker`（software） | false | false | 本来就停着 |
| `include:legion-mediator` | false | false | 本来就停着 |
| `include:legion-scrum-worker-gf001` | false | false | 本来就停着 |
| `scrum/control.json` | `{"paused":false}` | **`{"paused":true}`** | 第二道闸：守护每轮扫单前读它（`plugins/src/index.ts` 的 `readControlPaused()`） |

- **验证读数**：`scrum/daemon-ozon.json` 的 mtime 在 **45 秒**窗口内未再变化
  （此前它每 `intervalMs=20000` 一轮改写一次，最后写入 2026-09-23 09:54:31）。
- **刻意保留**：`include:legion-team-hub`（服务）与 `include:legion-scrum-board`（看板 UI）——
  它们不是守护，不认领任务、不派工。
- **恢复方法**：`plugin_manager` 把那一行 `set_plugin enabled=true`；
  再把 `scrum/control.json` 改回 `{"paused":false}`。
- **冲突的根因（供以后参考）**：`legion-scrum-worker` 这一族是**同一模块挂四行**
  （software / ozon / mediator / gf001），各自带自己的 `scope` 与 `repo.root`。
  同一时刻只要有两行是 `enabled`，就会有两个进程在**同一棵工作树**上
  认领任务、写同一批文件——本轮之前 ozon 那行在跑，software 那行停着，
  所以"看起来只有一个"，但**看板/健康页只认 `daemon.json`**，
  而 ozon 写的是 `daemon-ozon.json`，于是读数与实际在跑的东西并不同形。

### 0.2 在制改动已提交

| 提交 | 内容 | 提交前复跑的门禁 |
| --- | --- | --- |
| `061974f` | `runtime/config-schema.mjs` 补登 9 个字面量 + `runtime/adapters/dsh/adapter.test.mjs` ⑯ 三例 | `env` PASS / `config.test.mjs` 53/53 / `suite-counts` 33/33 |
| `762d979` | 两份在制证据文档（用法投影 / 第 116 轮红套件逐条根因） | `check-docs` PASS / `encoding-check` PASS / `boundary-facts` 30/30 |

工作树里**已无被跟踪文件的未提交改动**；`scrum/daemon-ozon.json` 的运行时抖动
（`lastSweepAt` / `uptimeMs` / `checkedAt`）已还原到 `HEAD` 的值，
不把运行时状态写进提交。

### 0.3 接管后第一次全量 `test` 阶段的读数（**红，且两个红的性质完全不同**）

`node scripts/ci/run-ci.mjs --only test` → **FAIL**（1295s，跳过 1 条）。
19 个套件里 **2 个红**，其余全绿（`toolcall-spool` 14/14、`toolcall-drain` 13/13
也在绿的一侧——那正是 P1-1 要接的两半）。

| 红套件 | 读数 | 归因 | 处置 |
| --- | --- | --- | --- |
| `prt-composition` | 22 例中 **1 败**：④ 与当前 `DSH_HOME` 一致 | ★ **我自己造的** —— §0.1 关掉守护那一下改了现场 profile，而这条判据比对的就是现场与快照 | 已按工具自述的路径 `--record` 刷新基线并提交（`22bad70`）；复跑 **22/22** |
| `runtime-contract-cross-process` | 19 例中 **6 败**（A1 / A2 / H + 三条 ★） | ★★ **真缺陷，且不是本轮的**（第 116 轮那批修完剩下的两个红之一） | 立为 **P0-2**，见下 |

`prt-composition` 那条红证明了一件好事：**"现场被人改过"这条判据是活的**。
而它的处置只有一个正确写法——按工具自己打印的那句
「若确为有意变更，运行 `--record` 刷新基线并在提交信息中说明」，
不是把断言改宽。

`runtime-contract-cross-process` 的根因（原样抄下来）：

```text
A2: 没造出执行器：{"ok":false,"code":"EXECUTOR_SELF_CHECK_INCOMPATIBLE",
     "message":"启动自检判定强制面未生效，禁止自动执行",
     "reasons":["composition-patch-layer: legion-enforcement-runtime-contract-server:
                行已挂载但未激活（等待依赖服务），不产生任何强制效果"]}
A1: 跨进程那条路没通：{"ok":false,"code":"EXECUTOR_SELF_CHECK_INCOMPATIBLE", …}
```

⇒ **`legion-enforcement-runtime-contract-server` 这一行挂上了、却从未激活**，
于是跨进程那条路根本走不通。六条失败里四条是这条的**下游**
（H / 三条 ★ 断言的"两两不同形"与"幂等"都依赖执行器真的存在）。
这一条与本轮 P1-1 是**同一族**（"控制面的数据怎么到达执行面"），
而且它现在挡着 PRT-253 的跨进程证据 —— 所以它排在 P1-1 之前。

### 0.4 P0-2 的根因（第 118 轮，已证到），以及**一次被我自己撤回的修法**

#### 根因：判据与等待**不在同一个平面**

- `settleEnforcementMount()` 等的是**组合根那本挂载账**（`assemble.mjs` 的
  `mountSettled()`）——**只有进程内 `mount()` 写得出来**；
- 而 `reconcilePatchLayer()` 判"未激活"判的是 **Loader 那棵树**
  （`observeComposition()` → `entry.fiber.state === 2`）。

补丁层那些 `insert` 行（`legion-host.patch.yml`）由 Loader 用
`Promise.allSettled(config.map(create))` **并发**创建，`mountSettled()` 对它们一无所知。
于是"等挂载收敛"等完之后，树里仍可能有行的 `apply` **正在跑** ——
只要那一行的 `apply` 里有**一次真 I/O**。`runtime-contract-server-row.mjs:482`
的 `await created.listen()` 就是。

`activated` 那一个布尔把两件事压成了一件（`runtime-host-row.mjs:128-138` 是**刻意**的）：

| fiber.state | 含义 | 旧读数 |
| --- | --- | --- |
| `0 PENDING` | 它在等注入的服务 | `activated:false` |
| `1 LOADING` | **它的 `apply` 还在跑** | `activated:false` ← 本次的真凶 |
| `2 ACTIVE` | 跑完了 | `true` |
| `3 FAILED` / `4 DISPOSED` / `5 UNLOADING` | **跑坏了 / 已经走了** | `activated:false` |

（取值是 `@deepseek-ai/cordis` 的 const enum，在 `plugin-inventory` 与 `web/loader-status`
里各有一份运行期镜像，逐字核对过。）

#### 证据（同一条组合、同一台进程）

1. **A0 / A0b 是绿的**：探针读到 `CONTRACTSVC ok=1 listening=1 tokenConfigured=1 warnings=`，
   端口是真内核临时端口，`runtime/runtime-contract.json` 真的写出来了；
2. **A1 是红的**：同一份 `scenario('full')` 里，worker 拿到的自检结论是
   `EXECUTOR_SELF_CHECK_INCOMPATIBLE` + `composition-patch-layer:
   legion-enforcement-runtime-contract-server: 行已挂载但未激活（等待依赖服务）`；
3. 而且 A1 自己**已经把 HTTP 请求打到了那台进程上**（`base = http://127.0.0.1:${svc.port}`）——
   一台"没有生效"的服务不会答这个请求。

> 一份"读的时候它还没跑完"的自检，与一份"它真的没跑起来"的自检，
> 给出同一条红 —— 只不过前者会在几毫秒之后自己变成绿的；
> 而那一瞬间的读数会被**固化成** `autoExecutionForbidden: true`。

#### 撤回的修法（第一阶段，**已 `git checkout` 还原**）

曾把表补全、给每行加 `state`、加 `observeCompositionSettled()`（有界 5 秒轮询等
"离开挂载中"）、并让那句诊断按状态分岔。读数：

- `runtime-contract-cross-process`：**6 红 → 2 红**（H 与三条 ★ 转绿）；
- 但 `runtime/dsh-composition` 全域复跑出现 **14 条新红**，落在三个
  **CI 里已注册、改动前是绿的**真进程套件上：
  `runtime-host-binding-unblocked-dsh-process`、
  `runtime-host-registrar-row-dsh-process`、`runtime-host-registrar-row`。
- ⇒ 整体**净亏**，当场还原；还原后 `runtime-host-*.test.mjs` **104/104** 绿（已复跑确认）。

**教训（写下来，因为下一次很容易再犯）**：对**任何** `PENDING / LOADING` 的行
一律等 5 秒，是**太钝**的一刀 —— 那些夹具里有行**合法地**停在 `PENDING`
（在等一个夹具永远不提供的服务），于是"等收敛"变成了 5 秒启动延迟与读数的整体平移。
判据没放宽，但**失败从一个套件搬到了三个套件**。

#### 撤回后暴露出来的**第二条缝**

第一阶段之后残留的那 2 条红换了形状，指向下一处：

```text
A1: EXECUTOR_RUNTIME_REFUSED / RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE
A2: HTTP 503「强制面结论的形状不对：必须是带布尔字段 autoExecutionForbidden 的对象」
```

即：worker 可以在注册方把 `legionRuntimeHostBinding` 发布出来**之前**就请求
`/legion/enforcement`。而那台服务端把"**还没发布**"说成了"**形状不对**" ——
与本次同类：两个不同的处境，一句诊断。

#### 收口（同日第二轮）：真正的原因是**等待把观察者自己也等进去了**

把等待收窄到"只等 `LOADING(1)`"**仍然**是 15 条红，而且**每一条失败的用例都恰好
花掉 5 秒** —— 那正是 `COMPOSITION_SETTLE_TIMEOUT_MS`。这条读数把原因指了出来：

> 本函数是从注册方**自己的 `apply` 里**调的，而执行那个 `apply` 的 fiber 在它返回
> 之前**就是** `LOADING` —— 观察自己永远读到"还在跑"，于是**每一次观察都白等满超时**。

这与 `observeComposition()` 里那段 `selfObserved`（`:346-366`，"它因为读自己而报自己
未激活"）是**同一条自指**，只是它出现在另一个字段上；而第一版把它一起修掉了，
第二版又在"等谁"那一侧重新引入了一次。

修法三处（都不是放宽判据，只是把**读取时机**推后并**排除自己**）：

| # | 位置 | 改了什么 |
| --- | --- | --- |
| 1 | `runtime/dsh-composition/plugins/runtime-host-row.mjs` | 补 `FIBER_STATE` 表；每行多一个 `state` 原始读数（`null` ＝ 读不出，与读到 0 分开） |
| 2 | 同上 | 新增 `rowsApplying()`（**只** `LOADING(1)`、**排除** `selfObserved`、**排除**读不出状态）与 `observeCompositionSettled()`（有界轮询，返回 `settled` / `applying`） |
| 3 | 同上，`apply` 里 | `observeComposition(ctx)` → `await observeCompositionSettled(ctx)` |

**读数（本轮实测）**：

| 读数 | 之前 | 之后 |
| --- | --- | --- |
| `runtime-contract-cross-process` | **19 例 6 败** | **19/19 全绿** |
| `runtime/dsh-composition` 全域（54 个文件） | 第一版修法下 14 败 | **1025/1025 全绿** |
| `runtime-host-*.test.mjs`（三条真进程套件） | 第一版 14–15 败 | **104/104 全绿** |
| 新钉的用例 | — | `runtime-host-row.test.mjs` 新增 ①e（`LOADING` 算 / `PENDING` 不算 / 自己不算 / 等到之后读到激活 / 超时 `settled:false` 且判据不放宽 / 读不到树返回 `null`） |

#### 更正上一轮的一处判断：那"第二条缝"是**我自己造的**

上一轮把撤回后残留的 2 条红（`RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE` / HTTP 503
「强制面结论的形状不对」）记成了产品的**第二条缝**。收口后它**自己消失了**，
而 19/19 全绿 —— 说明它是第一版修法的副作用：

> 注册方为"等别的行跑完"推迟了自己的 `apply`，于是**绑定服务的发布时间**被推到
> 契约服务开始监听之后，worker 就在窗口里读到了"服务不在"（那是**设计好的**
> 三态之一：不在 / 说不行 / 说行，`runtime-contract-server-row.mjs:244-255`）。

⇒ 它不是产品缺陷，是我的修法制造出来的时序。**记在这里，免得下一轮有人照着它去改
服务端那三态**（那三态是对的，不该动）。

#### 这一条的通用教训（值得单独记一行）

> 一个"等所有还没就位的行"的检查，
> 与一个"把自己也算进还没就位的行"的检查，在只看健康部署时是同一个东西 ——
> 只不过后者在**每一次**启动上都要白等满超时。

#### 最终读数：全量 `test` 阶段 **PASS**（19 个套件、1204 秒）

```
[test] -> PASS (1204223ms)  ⚠ skipped=1
```

- `runtime-contract-cross-process`（PRT-253 跨进程）：**19/19** —— 这条套件从第 116 轮
  起一直红着，现在绿了；
- `prt-composition`：**22/22**（基线已随守护全停刷新，见 `22bad70`）；
- 其余套件（`product-launcher` 415、`plugins` 409、`whiteboard` 211 …）全绿；
  唯一跳过的 1 条在 `secret-store`（既有、合法）。

**⚠ 一条自己踩的坑，记下来**：第一次跑这个阶段时 `boundary-facts` 被 300 秒上限杀掉，
报"可能存在泄漏句柄或死锁"。它**不是**回归 —— 那一次我在 CI 跑的同时并发跑了几轮重扫描
（`check-docs` / `encoding-check` / `boundary-facts` / `suite-counts` / `config scan`，
外加两遍 `boundary-facts` 套件复现）。单独跑（`--test-timeout=15000`）**67/67 绿**，
第二次 CI（不并发）也绿。

> 一个"在 CI 跑的同时再压几轮全仓扫描"的习惯，
> 与一个"CI 真的超时了"的读数，在摘要里是同一行 ——
> 只不过前者只要把负载挪开就消失。

⇒ **重任务不许与 CI 阶段并发**（并入本会话施工纪律）。

---

## 1. 优先级队列

排序依据只有一条：**会不会让下一个人照着一个反的读数做决定**。
同档之内，先做"解锁别人的"。

| 序 | 任务 | 类型 | 依据 | 状态 |
| --- | --- | --- | --- | --- |
| **P0-1** | `test` 阶段**全量**复跑 | 验证 | 第 116 轮 7 个红套件修在 `59a6ad9` | ✅ **PASS**（19 套件 / 1204s，第二次单独跑） |
| **P0-2** | **`legion-enforcement-runtime-contract-server` 行挂载了却从未激活** | 施工·真缺陷 | 两个平面（等的账 ≠ 判的树）＋ 自指等待 | ✅ **已修**（`c735415`）：cross-process 6 败 → **19/19**；全域 1025/1025；新增用例 ①e 钉住 |
| **P1-1** | 接 `spool` / `toolcall-drain` **落账车道**（解目标链 L7） | 施工 | ★ **两半都已接进生产**（§3.5 / §3.6）：收账侧 = hub 收账 tick（第七轮，端到端实测）；写入侧 = `root-row.mjs` 把 `spool-writer.mjs` 挂成 `onDecision`，Run 号**按事件**取（第八轮，车道三套 + 写入侧 9 例，54 套装配用例 1026 例全绿） | 🟡 **只剩三处未接**：`dispatched` / `result` 两种记录**没有观察点**；只有**带投影**的事件会被写成一行；行里的 `attemptId` 仍是 `null`（载体今天只加了 `runId`） |
| **P1-2** | 删掉 PRT-707 **死的那份**实现 | 施工 | 业主 2026-09-23 裁决（第 17 条） | **✅ 已执行（第九轮，`943ccdc`）** —— ★ 第十四轮核实：上一版这里还写着"待做"，而 `product/launcher/first-run.mjs` **早已不存在**（`Test-Path` = False）；活的那份 `wizard.mjs` / `--wizard` 仍在。> 一张"状态"列与台账的行内散文犯了同一个病：**做完之后没有人回头改那一格**。 |
| **P1-3** | `whitelist` 装配 + **Legion 能力词表**映射 | 施工 | 业主 2026-09-23 裁决（第 27 条：Legion 名 + 加映射层） | **✅ 两半都清了（第十四轮核实）**：① 映射层在 `whitelist-port.mjs:278`（执行面名 → Legion 名）/`:309`（交给 `permitsTool`）；② 端口的**生产装配**在 `root-row.mjs:645`（`whitelistPortFromEnv({ env: effectiveEnv })`）⇒ `:760` 喂给桥 ⇒ 它**不再是**"在生产里恒为 null"。剩下的"**许可的取值从哪来**"已**并入第 14 条**（§3.7.1），而业主已答（部署方在配置里给，缺失即未接）⇒ 本会话无待办 |
| **P1-4** | 阶段 9 产品动作的 **CLI 面** | 施工 | 业主 2026-09-23 裁决（第 16 条：做） | **🟡 两刀都已落（第十四 / 第十六轮）**：第一刀 3 份只读报告接进 `legion --report=<kind>`（`product/report-cli.mjs`）；**第二刀接的是一条读法**——`product/lifecycle/store-scan.mjs`（把落点从磁盘读出来）+ `product/lifecycle/plan-cli.mjs` 三面旗标（`--uninstall-plan=<mode>` / `--export-plan` / `--retention-plan`）。合计：不可达 41→**33**、`gap` 20→**12**、本族 11→**3**；★ 第二刀**不需要**另一次业主裁决——那三个模块要的"目录"就是布局自己那几个根（`resolveLayout` 给的），真正还差的只有 metrics 那一支的**库句柄**（§3.10 / §7） |
| **P1-5** | 外部 API 授权表**管 scheme** | 施工 | 业主 2026-09-23 裁决（第 26 条：管） | **✅ 已执行（第十一轮）**，见 §3.8 |
| **P2-1** | 第 24 / 25 条的**临时口径**：政策门暂不从连接器声明读能力；MCP 工具归属暂以 F-21 登记表为准 | 记账 | 业主本轮未给，先按保守一侧记，等他改 | 已记 |
| **P2-2** | 剩下的裁决项：第 12 / 10 / 8 / 6 / 21 条 | 裁决 | `DECISION-BRIEF.md` §1 / §2 | 待业主 |
| **P3-1** | 20 个 `gap` 类模块（有实现、无生产路径）的收口盘点 | 记账 | `reachability.mjs --diff`：不可达 **41** = by-design 13 · deliberate 8 · **gap 20**（第七轮：44 → 42；**第九轮：42 → 41**，第 17 条删掉 `first-run.mjs`；两次都随 `--record` 重录） | **✅ 清点完成（第十四轮）**：20 个 gap **逐条有名字、且全部挂着裁决处** —— 第 16 条 **11** 个、第 19 条 **6** 个、第 18 条 **3** 个（逐条清单见 §5.1） |
| **P3-2** | ★★ **`scratch/` 是"证据库"却没有被跟踪**（第十轮量到） | 记账 / 待业主定 | `git status` 里**未跟踪 777 个**：189 个根目录 `_*` 遗留（0 个被文档引用，已清）、其余约 580 个在 `scratch/`。而**文档与脚本引用了 105 个不同的 `scratch/…` 路径**当"可复跑的量具"（例：`scripts/probes/_mutate-whitelist-port.mjs` 就写在 `run-ci.mjs` 的注释里）。`scratch/` **不在 `.gitignore`、也从未提交** ⇒ 那些引用指向**只存在于这个工作区**的文件。> 一个"证据可复跑"的读数，与一个"证据在别人的检出里根本不存在"的读数，在**本机**是同一个东西。⇒ 待定：把量具收进 `scripts/probes/` 并跟踪，还是明确 `scratch/` 是一次性工作区（那就该把引用改成"当时量具已随批次丢弃"） | **✅ 已执行（第十二轮）**：量具收进 `scripts/probes/`（110 个，跟踪），引用改写 354 处；4 个已丢弃的量具在引用处标了"**已随批次丢弃**"；`scratch/` 进 `.gitignore`。★★★ **第十三轮复核：上面那句"从未提交"是错的，本行按事实改回 🟡** —— `git ls-files scratch` 实测 **447 个**（233 `.mjs`、72 `.json`、54 `.txt`、25 `.md`、**43 个 `.db`/`.db-shm`/`.db-wal` 二进制库**）；`scripts/probes/` 111 个，两边**同名并存 65 个**。⇒ `.gitignore` 对**已被跟踪**的文件**没有任何作用**：`git status` 干净，不等于 `scratch/` 没进版本库。> 一个"已经处理过"的读数，与一个"真的处理完了"的读数，在 `git status` 干净的时候是同一个东西。★ 第十三轮量到的残余：**264 个**仍被别处按路径或文件名引用（★ 文件名命中是**弱**判据，只说明"这个名字还出现在某处"）、**183 个孤儿**（158 `.mjs`）、43 个二进制库。⇒ 待定：这 447 个里哪些该 `git rm --cached`（保留在工作区）、哪些该随批次丢弃、二进制库要不要一并移出版本库 —— **不动手，等业主定** |
| **P3-2** | 19 个陈旧 worktree（`w/T-043`…`w/T-117`、`codex/prt-phase0-1`、`codex/prt-runtime`） | 卫生 | 分支领先 `main` 1–2 个提交未合并，最后活动 9/5–9/12；其中 4 个还有未提交改动 | 待排 |
| **P3-3** | **`security/` 的「原文/原句」引文面不在任何判据里**（第十三轮量到） | 记账 · 待定 | `ORIGINAL_CITATION_ROOTS` 是从邻居那里抄来的六个根，**`security/` 整个目录不在内** —— 而它写着这种引用（第十三轮那 9 处里的第 9 处就在 `security/config-schema.mjs:36`，**而且它是对的**）。实测：`security/` 下 15 个 `.mjs` 里有 **6 处**「原文/原句」形状，今天都不在任何判据的扫描面里。> 一个"根目录表是从邻居那里抄来的"扫描器，与一个"自己的面已经量过"的扫描器，在**今天**给出同样的绿。⇒ 待定：把 `security` 并进 `ORIGINAL_CITATION_ROOTS` 并重读那一层逐条登记的 expect，还是只并进新判据（**第十三轮已经这样做了**：见 `CITE_SYMBOL_ROOTS` 与 §4.2） | 待排 |
| **P4-1** | PRT-009 / PRT-253 / PRT-256 / PRT-910 | 等外部 | 需执行期外的机器 / 真实外部用户 / 真实用户项目 | 本机无可做动作 |
| **P4-2** | PRT-316 的日期闸门 | 等日期 | 最早可启动 **2026-09-24**（`PRT-909-release-checklist.md:63` 默认有效期 **14 天**，`0db37af` = 09-10 17:10 ⇒ 09-24，**今天还差 1 天**）。★ churn 闸门是**随 HEAD 变的读数**：第十三轮实测（2026-09-23，`79fbdb0`）`cooled=true recentMax=2/40 historicalPeak=15/40` ⇒ **已降温**；而 09-21 那次它是 `9/40`（未降温）⇒ **开工那天必须重量一次**，不能照抄任何一份 | 等日期（09-24）；churn 需**当天重测** |

---

## 2. P1-1 的施工面（★★ 第十四轮核实：**四处里前三处 + 收账 tick 早就落了**）

★★ **本节此前把已经做完的事记成了"待做"** —— 与 §5 里 P1-2 / P1-3 同一种病，
而这一次犯病的是**我自己写的交接文档**。逐条核实（`git log -S` + 读代码 + 跑用例）：

| 本节原来写的 | 第十四轮核实到的 |
| --- | --- |
| ① 派生表缺 `team-hub` 那一行 | **已落**：`product/config-schema.mjs:1076`（`d955dac`，第 118 轮**第七轮**） |
| ② `process-manifest` 的 `envNames` 里没有它 | **已落**：`product/process-manifest.mjs:146` 已有 `LEGION_DATA_DIR`（同提交；`:135` 那条注释写明 hub 是**收账侧宿主**） |
| ③ Launcher 没真的传下去 | **已落**：`product/launcher/launcher.mjs:427`（`dataDir: layout.dataDir ?? null`）+ `derivedValuesFor()` 的 team-hub 分支 |
| ④ 按 Run 的缝（设计） | **仍未落** —— 见 §2.1 |
| （本节当时根本没记的）收账侧要有生产调用方 | **已落**：`team-hub/server.mjs:212` import `sweepToolCallSpool`，`:5698` 每 30s 收一次账 |

> 一份交接文档里"待做"那几格，与台账的行内散文犯的是同一个病：
> **做完之后没有人回头改那一格** —— 而读它的人会**再去做一遍已经做完的事**。

而这一变的依据是**第 28 条已裁定**（丙的机制 + 目录锚在既有配置量上，逐字见 `d955dac` 的提交说明）
⇒ 本节下面那段"已撤回、未裁决"的记录**是当时的事实**，后来被一次裁决追上了；
它留在这里当**纪律样本**，不是当前状态。

### 2.1 第 4 条：按 Run 的缝（仍然唯一带设计成分的一处）

| # | 位置 | 要做什么 | 状态 |
| --- | --- | --- | --- |
| 1 | `product/config-schema.mjs` 的派生表 | 补一行 `{ target: 'team-hub', env: 'LEGION_DATA_DIR', via: 'env', from: 'layout.dataDir', … }` | **✅ 已落**（`:1076`） |
| 2 | `product/process-manifest.mjs` 的 team-hub 块 | 把 `LEGION_DATA_DIR` 加进它的 `envNames`（不加 ⇒ `buildChildEnv()` 对未声明的键**直接抛**） | **✅ 已落**（`:146`） |
| 3 | `product/launcher/launcher.mjs` | 拼子进程环境时把该键真的传下去 | **✅ 已落** |
| 4 | **按 Run 的缝**（设计） | `onDecision` 是**装配期**参数，而 spool 是**逐 Run** 一份。观察点必须从**按 Run 安装**的那个缝（PRT-214 已跑通两遍的形状）读当前 runId | **❌ 未落**（§2.1） |

### 2.2 ★ 真正剩下的三处（第十四轮读到行；本节此前没有这三行，它们只记在 §1 的 P1-1 行里）

| # | 位置 | 缺什么 |
| --- | --- | --- |
| 甲 | `runtime/toolcall/spool-writer.mjs:144` | **只追加 `DECISION` 一种记录**。`spool.mjs:110` / `:112` 定义了 `dispatched` / `result` 两种，`toolcall-drain.mjs` 也认它们（`markDispatched()` / `recordResult()`）—— **写入侧没有观察点** ⇒ 那两种记录在生产里**永远不会出现** |
| 乙 | 同上（`spool-writer.mjs:128`） | `projection == null` ⇒ 具名拒绝 `NO_PROJECTION`。这**是对的**（"猜不出一行来"），但它意味着**只有带投影的事件会被写成一行**；派发 / 结果那种事件天然被排除在外 —— 要接它们，得先回答"它们的行长什么样" |
| 丙 | `runtime/toolcall/spool.mjs:124` | `dispatched` 的必填字段今天只有 `['callId']`；行里的 `attemptId` **仍是 `null`** —— 载体上连这个名字都还不在（`spool-writer.mjs` / `spool.mjs` 里 grep `attemptId` **零命中**） |

★ 三条都**不是**"补一个环境变量"：甲要一个**新的观察点**（桥的 `onDecision` 只报"决定"），
乙要一次**行形状**的决定，丙要给**载体**加一个字段并在两侧都接上。

★★ **第 118 轮第十六轮实测（本会话顺手读到的，为下一轮备料）**：那个"新观察点"**已经在桥上了，
只是被接进了错误的那条线**。逐字读 `runtime/dsh-composition/assemble.mjs:313`：

```js
...(onDecision === null ? {} : { onOutcome: onDecision }),
```

也就是说——**结果事件（`onOutcome`）今天被拍平送进了 `onDecision`**，
而 `spool-writer.observeDecision` 的第一道守卫是"没带投影 ⇒ `NO_PROJECTION` 具名拒绝"（上面乙那一行）。
⇒ 甲与乙是**同一件事的两面**：

| 项 | 之前记的 | 实测之后它变成 |
| --- | --- | --- |
| 甲 | "写入侧没有观察点" | **有**（`onOutcome`），但被并进了 `onDecision` ⇒ 需要的是**在 `assemble.mjs:313` 把这个漏斗拆开**，给结果一条自己的写入路径 |
| 乙 | "要一次行形状的决定" | 同一次决定：结果行的形状（`dispatched` 要 `['callId']`，`result` 要 `['callId','status']`，见 `spool.mjs:124-125`），而**投影不是它的必填项**——今天它却是被投影这道门挡在外面的 |
| 丙 | "载体里连 `attemptId` 这个名字都没有" | ★ **部分过期**：收账侧**读**它（`orchestrator/worker/toolcall-drain.mjs:159` 逐字 `attemptId: row.attemptId ?? null`）⇒ 缺的是**写入侧把它填上**，不是两侧都加 |

★ 这一格是"账要跟着代码走"的又一次现场：**四行之前那句"要一个新的观察点"是对的，
但"（桥的 `onDecision` 只报'决定'）"这个括号是错的** —— `assemble.mjs:313` 那一刻正好写着相反的话。
⇒ 下一轮动它时，**先读那一行**，别信这张表。

**回到 §2.1 那一条**（按 Run 的缝）：`runtime/dsh-composition/plugins/root-row.mjs:724`
（★ 第十四轮校订：本节原写 `:626`，实测已漂到 `:724` —— 由 §3.8 那条手钉判据先红出来的）
是 `installEnforcementRoot()` 在全仓**唯一**的生产调用方；在那里绑死 runId
会让**整个进程只往第一个 Run 的账本里写**——而"第二个 Run 的工具账不见了"
在任何单 Run 的用例里都是绿的。

⚠️ 两条口径先写在前面，免得施工时走偏：

1. **不许发明默认值**（PRT-253 §3）。收账侧的库路径今天是 `team-hub/server.mjs:335`
   的 `join(ROOT, 'team-hub', 'team.db')`——那是**库**的位置，不是**车道**的位置，
   不能顺手拿它当 spool 的目录。
2. ⚠️ **更正（第 118 轮第四轮，本轮）**：本节原先写"**收账侧不住进 hub 进程**（第 28 条的"乙"）"
   —— **引错了**，而且把一条**未裁**的路写成了"本轮裁决"。
   `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.7 摆的三条路逐字是：

   | | 做法 | 与既有裁决的关系 |
   | --- | --- | --- |
   | **甲** | 新登记一个部署配置键（如 `LEGION_TOOLCALL_SPOOL_DIR`），两半各自从 env 读 | 会并进第 19 条那个人工项 **A**，一起通或一起不通 |
   | **乙** | **收账侧住在 hub 进程里**，路径从 hub 自己的库位置派生 | 不新增键；但把车道绑死在库位置上 |
   | **丙** | 照第 19 条的形状**按 Run** 交付 | ★ **唯一与第 19 条裁决逐字一致**的一条 |

   而 §14.7 末尾逐字写着「★★ **本文件不替业主选**」。⇒ 本节当时说的"本轮裁决"
   其实是把**丙**当成了已定事项，而它只是三条待选路里的一条。

3. ★ 由此立一条施工纪律：**未裁决的选项不许由 diff 选定**。
   第 118 轮第三轮给 hub 放行了 `LEGION_DATA_DIR`（理由是"生产进程里只有它开着库"
   —— 那个理由是对的，而它推出的结论**恰好就是选项乙**），等于用一次看起来只是
   "补一个环境变量"的改动把一条路定了下来。**当时已撤回**；撤回后用例 `①b″` 钉的正是
   "裁决之前不放行"。
4. ★★★ **续（第十四轮核实）**：**第 28 条后来真的裁了** —— 逐字见 `d955dac` 的提交说明
   「第 28 条裁定（**丙的机制** + **目录锚在既有配置量上**）」，于是同一处代码又被落回去
   （见 §2 的核实表）。**同一处代码先撤回、再落地，两次都对着同一条纪律**：
   撤回是因为当时**没有裁决**，落地是因为后来**有了裁决**。
   ⇒ 这一条要读成"**裁决是这类改动的前置条件**"，而不是"这个改动被否掉过"。

---

## 3. 本轮业主裁决（2026-09-23，六条）

| 项 | 裁决 | 直接后果 |
| --- | --- | --- |
| 守护停止范围 | 保持**全停**，由本会话接管 | 不再有第二个进程争同一棵工作树 |
| P1 首项 | **接 spool / toolcall-drain 车道** | 见 §2 |
| 第 27 条（whitelist 词汇表） | 用 **Legion 能力名**，在强制面**加一层映射** | `runtime/dsh-composition/whitelist-port.mjs:177` 的 `translateToolName()` / `:350` 的 `whitelistPortFromEnv()` 就是那层；缺的是**装配里没人传值**（`surfaces.whitelist === false`，有用例钉着） |
| 第 17 条（两份向导实现） | **删掉死的那份**（`product/launcher/first-run.mjs`）—— ★ **第 118 轮第九轮已执行** | 它被三条判据围着：`wizard-wiring.test.mjs` 的 ③（零生产导入者）、`scripts/prt/reachability.test.mjs:310` 的基线（★ 第 118 轮第十三轮校订：原写 `:309`，我在 `:104` 插了一行注释后它 +1）、`scripts/ci/run-ci.mjs:4285` 的套件登记——删文件必须同时处置这三处。★ **执行读数**：三处都处置了（前两条按规矩补了同族真实成员／改写为"文档 vs 代码"的漂移读数，第三条改成登记改写后的套件）；基线 42 → 41；那四个 `FIRST_RUN_*` 码也随实现从 `product/config-schema.mjs` 撤掉 |
| 第 16 条（阶段 9 CLI 面） | **做** | 14 个"零生产入口"模块里唯一"轮到补入口"的一类 |
| 第 26 条（外部 API 的 scheme） | **管**：不在白名单协议里一律拒绝 | `runtime/dsh-composition/external-api-scope.mjs:806` 的 `checkExternalApi()` 今天**完全不看 scheme**（全文件搜 `scheme` 零命中）⇒ `ftp://…` 会被放行 |

### 3.1 第二轮待业主裁决（第 118 轮第四轮提出）

| # | 要裁的事 | 为什么现在提 | 选项 |
| --- | --- | --- | --- |
| **①** | **第 28 条**：车道的目录由哪个既有配置量派生、谁在**按 Run** 的缝上绑 `runId` | ★ **唯一一条"不裁就没法往下走"的**——P1-1 的后半整块压在它上面：收账侧住哪个进程、写侧的缝怎么绑，全由它决定 | 甲 / 乙 / 丙（§14.7 的原文表；三条各有代价，**没有一条是顺手选一个**） |
| **②** | 车道文件的**裁剪/归档**归谁、按什么条件 | §14.6 第 4 条如实记着"**没有**做裁剪"，而 spool 是**只追加**的 ⇒ 它会一直长；"收完就删"会在崩溃后把没落账的几条当成已收过，所以这不是"顺手加个 rm" | 按 Run 收完即删 / 保留 N 天 / 按大小轮转 / 暂不裁（继续记账） |
| **③** | 坐标判据（`boundary-facts.mjs` 那一条）要不要从**只扫台账**扩到**决策面文档** | §4 量到决策面文档里有 **4 处漂掉的引用**今天无人管；扩了当场翻出这 4 条，代价是每次重排注释都可能变红 | 扩（并接受噪声）/ 不扩（维持现状，只在改到时人工核） |

### 3.2 裁决结果（第 118 轮第四轮，业主答复）

| # | 裁决 | 直接后果 |
| --- | --- | --- |
| ② spool 裁剪 | **暂不裁，继续记账**（等有真实流量再说） | 实现侧**不做任何删除**；队列里留一条增长读数（车道只追加 ⇒ 会一直长，这是刻意换来的代价） |
| ③ 坐标判据 | **不扩**，维持只扫台账 | 决策面文档那 4 处漂掉的引用继续只在"改到它时"人工核 |
| ① 第 28 条 | 业主答"**你觉得哪个好**" ⇒ **授权本会话定** | 取法见 §3.2.1；这是一条**可一条提交回退**的配置路径决定 |

#### 3.2.1 第 28 条：取「丙 的机制 ＋ 目录锚在 `LEGION_DATA_DIR`」，并补上乙的一个洞

复核 §14.7 那张表时发现**乙那一格有个洞**，这是选之前必须说的：

> 乙说"路径从 hub 自己的 `dbFile` 同级目录派生" —— 那只回答了**收账侧**怎么找到目录。
> 而**写侧是执行面（runtime 进程），它拿不到 `TEAM_HUB_DB`**，推不出"hub 的库旁边"在哪儿。
> 要让写侧算出同一个目录，就得再给它一把键 —— 那正是乙用来主张"不新增任何键"的理由。
> ⇒ **乙省下的键，会在写侧再加回来。**

甲同样不通：它要落进 `product/process-manifest.mjs` 的 runtime `envNames`，而那里
**今天已经缺 4 把键**（第 19 条人工项 A）⇒ 再加一把就是第五个受害者，而车道**仍然不通**。

⇒ 取 **丙 的机制**（按 Run 交付；runId 在**按 Run 安装**的那处绑 —— PRT-214 已跑通两遍），
而**目录锚在 `LEGION_DATA_DIR`**：这是"既有配置量"，**runtime 与 orchestrator 今天就已经
各拿一份**（`product/config-schema.mjs:1074` / `:1076`）⇒ 两半都不需要新键，
甲与乙各自的代价都不付。

**收账侧的宿主**（§14.7 没把它当成要裁的事）随之定下：**hub** —— 它是唯一持有**可写 db**
的进程（`team-hub/server.mjs:717` 的 `ensureToolCallSchema(db)`）。于是它需要同一个
`LEGION_DATA_DIR`，即**第三轮那版登记是被这条裁决追认的**：当时撤回的是"**替业主选**"，
不是"这个接线本身"。落地时要一并做三件事：

1. 把 `server.mjs:714` 那句边界改写清楚：本进程只建表 **＋ 收账**（把执行面写的 spool
   收进来），**不**新增任何来自网络的写面；
2. 把"spool 目录与 db 同锚于 `LEGION_DATA_DIR`"写成**判据**（否则它仍是一条隐式耦合，
   库一挪账就断而没人知道）；
3. 写侧按 Run 的那条缝照旧要绑 runId（与宿主选择无关，任何一条路都需要它）。

★ 一句话记这里：§14.7 把"**目录由哪个配置量派生**"与"**谁在按 Run 的缝上绑 runId**"
摆成了甲/乙/丙三选一，而复核下来它们是**两个可以分开取的问题** —— 三选一里
没有哪一格同时把两问答对。

⚠️ P2-2 那五条（第 12 / 10 / 8 / 6 / 21 条，`DECISION-BRIEF.md` §1 / §2）**本轮没有一起摆上来**：
本轮先把"卡住施工的那一条"问掉。下一轮整理成同一张表再问一次。

### 3.3 ★★ 本轮量到的一处缺陷：收账的**读数**不能安全重跑

写收账宿主（`team-hub/toolcall-sweep.mjs`，§3.2.1 裁定的那条路）时，用例 ③b 立刻红了。
没有改判据去迁就它，而是把原因量了出来（同一个 spool 文件收两趟）：

```
pass1: applied={decision:1,dispatched:1,result:1,total:3} complete=true  refusals=[]
pass2: applied={decision:1,dispatched:0,result:1,total:2} complete=false
       refusals=[{ line:2, code:'toolcall-drain-apply-failed',
                   reason:'不能把 c1 标记为"已派发"：它不在 none 状态（要么已经派发过、
                           要么已经有结果）——重复派发是外部写做两遍的直接原因' }]
```

⇒ 凡是文件里**已经收过**的 `dispatched` 记录，第二趟都会被状态机拒绝，于是那一趟
读成"有东西没进去"。而 `orchestrator/worker/toolcall-drain.mjs` 头部 ② 逐字写着
「结果是幂等的，而且**必须**是——因为"收了一半崩了"是正常情况」。

> **行的幂等成立**（库里一行不多，这一条也断言了）；**读数的幂等不成立**。

这不是收账宿主的错，是那条声称与行为之间的缺口。它今天**不影响**按 Run 的主路径
（每个 Run 只收一次，读数是干净的），但**禁止**把"扫一趟"接进定时器：

> 一个每 30 秒把 `complete:false` 刷一遍的定时器，与一个坏掉的告警是同一个东西
> ——而"总是叫狼来了的门禁会被关掉"。

**处置（第 118 轮第六轮，已修）**：修法**不在状态守卫那一侧** —— `markDispatched` 一个字
都没动（它防的是"重复派发＝外部写做两遍"，有用例直接调它钉着）。收账改成**先读状态**：
行已经不在 `none` 就是**重放**，记 `outcome:'replayed'` 并跳过；`applied` 与 `replayed`
分开报。同一份探针现在给的是：

```
pass1: applied={decision:1,dispatched:1,result:1,total:3} replayed={total:0} complete=true
pass2: applied={decision:0,dispatched:0,result:0,total:0} replayed={…,total:2} complete=true
pass3: 同 pass2                                    refusals=0  rows=1
```

同一趟还量到**第二个同族副作用**并一并修掉：`recordToolCall` 的 duplicate 分支**会写**
（`attempts = attempts + 1`、`updatedAt`），于是"重放"会把 `attempts` 随扫描次数抬上去
——而 `attempts` 是**重试**的读数，记成"重试了 N 次"与真的重试过 N 次，在审计里是同一个
东西。现在决定的**完全一致**的重放也走 `replayed`（工具名或 canonical 哈希变了仍然交给
`recordToolCall` 抛 —— 那是真事故，不是重放）。

用例跟着改的是**那两条钉着旧行为的断言**（`toolcall-drain.test.mjs` ③ / ③b、`toolcall-sweep.test.mjs`
③b），并新增"`attempts` 一步不动"与"守卫照旧拒绝直接派发"两条。

**下一步**：读数幂等了，"扫一趟"才谈得上接进 tick —— 下一轮连同 hub 的
`LEGION_DATA_DIR` 登记一起做（免得又落一次"有登记、没消费者"），再做写侧按 Run 绑 `runId`。

---

## 3.4 P2-2 那五条：**先测量、再裁决**（本轮补齐第四轮欠下的那一张表）

第四轮把 P2-2 记成"下一轮列表"，本轮把五条**各自的现状量了**。做这件事的理由：
五条里有**一条已经不用问了**、**一条是外部输入**、**三条各自只需要业主说一句话**
——把"需要您裁决的事项"原样递上去，与把"其中三条其实只要一个字"递上去，
对您的时间是两件事。

| # | 本会话实测到的现状 | 还要您说的那一句 |
|---|---|---|
| **6**（PRT-509 C1～C4） | ★★ **已经不用问了**：`PRT-PROGRESS.md:163` 那一行是 **✅**，`MULTI-AGENT-FEATURE-STATUS.md:872` 记着 2026-09-18 的业主裁定（`065bc57`）"逐条对齐了正好这三条"。C 系列那四个动作里「新增 / 更新 / 轮换 / 删除」**已有生产入口**（`team-hub/secret-admin.mjs` 5 条路由 + 两组套件 24/15 例）。 | **无** —— 除非您指的 C1~C4 含「多档案」（多份凭证档并存）那半，那只需「要 / 不要」 |
| **10**（F-22 / F-24 记 🟡 还是 ⏸） | 两条的**剩余工作**逐字落在 §9「按**真实客户需求**推进」里（F-22：Docker / SSH / remote worker；F-24：多用户**写**面 ACL）。而**同一句话**下的 F-23 / F-25 记的是 **⏸**，并注明「这一条**是设计决定，不是缺口**」⇒ 同一个事实今天被判了两次（**口径不一致，不是新事实**）。 | 「按 ②⏸（与 F-23/F-25 一致）」或「继续 🟡、等客户需求」 |
| **12**（F-19 七类版本范围） | F-19 是 ✅，七类（prompt / skills / tools / permissions / model / connectors / budget）**一个不少**，且**缺一类不给默认空值**（缺节＝非法；`connectors: []` 是"就是不用"）。⇒ 现在加第八类是**新增一节**；等库里有真实岗位包之后再改，要做"旧包缺这一节"的兼容，而今天的设计**刻意拒绝**缺节的包。 | 「这七类就是全部」或「还缺 X」——**越早越便宜**（兼容是后加的） |
| **8**（F-23 / F-25 做不做） | 两条现在都是 **⏸**，依据是 §2「契约稳定前不同时支持多 Harness」与 §9「按真实客户需求推进」。⇒ **"不决定"的后果不是静默缺口，而是一条明写的归档**（与 §5 第 8 条自己写的处置一致）。 | 「确认按设计归档（不做）」或「提前做」 |
| **21**（PRT-256 / PRT-910） | 台账 `:80` / `:241` 两条 **⏸**，理由逐字是"需**真实外部用户** / 需**真实用户项目**"——**这是外部输入，本仓造不出来**。 | 只有您能给：「有一个真实外部用户 / 一个真实用户项目」或「暂时没有」 |

★ 一条分辨：**第 21 条与 PRT-009 不同类**。PRT-009（峰值内存/CPU）是"采样实现已落地、
只差一次实跑读数"——那是本会话能自己跑的（要挑一个不与 CI 抢资源的窗口），**不是**外部输入。
把这两件事放在同一格里，会让"我们自己能做完的"看起来在等您。

★ 另一条：**第 6 条在本队列里一直是"待问"，而它其实早已由您裁过**（`065bc57`）。
本会话的处置是**不改台账**（那一行本来就是 ✅），只把它从"要问的清单"里拿掉 ——
一条已经答过的问题留在待办里，会让"还剩几件事要您拍"这个读数虚高。

### 3.5 收账侧接进生产（第 118 轮第七轮）：四处一起落 + 一条端到端读数

第 28 条裁定（§3.2.1）之后，接线的几处**必须一起落**，否则就是第三轮那种
"有登记、没消费者"：

| 落点 | 改的是什么 | 为什么不能只改它 |
|---|---|---|
| `product/process-manifest.mjs` | team-hub 的 `envNames` 加 `LEGION_DATA_DIR` | 不登记 ⇒ `buildChildEnv()` 把值丢掉，子进程读到 `undefined`，收账只报 `NO_DATA_DIR` |
| `product/config-schema.mjs` | 新增 team-hub 的派生行（`from: layout.dataDir`） | 不登记 ⇒ 那道"派生值都有出处"的读数里，它成了凭空出现的一行 |
| `product/launcher/launcher.mjs` | `derivedValuesFor()` 加 team-hub 分支 | 不注入 ⇒ 前两处白登记（Launcher 是唯一知道 `layout.dataDir` 的地方） |
| `team-hub/server.mjs` | `isMain` 里加 30s 收账 tick + 边界注释改写 | 不接 ⇒ 前三处只是"允许它收账"，而没有人收 |

★ **只给目录，不给凭证**：用例 ①b″ 把这一对钉在一起（`LEGION_DATA_DIR === layout.dataDir`，
且 `LEGION_RUNTIME_TOKEN` **不在** hub 的 env 里）。那条用例**换过一次立场** ——
第三/四轮它钉的是"hub 两个键都没有"（那时给 hub 加目录等于替业主选乙），
第七轮钉的是"目录给、钥匙不给"。两次都留着读：差别不在 diff 的行数，
而在**有没有一个写下来的理由**。

**端到端读数**（不是"模块加起来了"，而是"真的收进去了"）：临时 DataDir + 临时库 +
`node team-hub/server.mjs` 起一个**真的 hub 进程** → 用 `appendSpoolRecord` 往车道写一条
→ 45s 内库里出现那一行：

```
hub 起来了：true（db=true）
45s 内 tick 收进来的行数：1
落在库里的那一行：{"callId":"e2e-call","decision":"deny","decisionSource":"pre-execute","runId":"e2e-run"}
```

⇒ `decisionSourceRecorded` 那条发布判据**第一次有了产出者**（此前它永远判否，
而判否的理由读起来完全正确）。

★★ 这一变**顺带把两处读数顶动了**，两处都按"读数变了就说清楚"处理，
没有一处是靠放松判据通过的：

1. **可达性**：`runtime/toolcall/spool.mjs` 与 `orchestrator/worker/toolcall-drain.mjs`
   从 `gap` 转为**可达** ⇒ 基线里"到不了生产"那句话成了假话，被 `③b` 那条用例直接抓出来
   （"基线里有 2 条 `gap` 已经不再不可达"）。处置：`reachability.mjs --record` 重录
   （44 → **42**，`gap` 23 → **21**，删掉的就是那两条，未分类 0）。
2. **§9 九节链**：L7 因此从"软缺口"转 ✔，它的 `owner: 28` 随即被 `owner-stale` 判掉。
   处置：把 L7 的 `coreWhy` 写成**带残余**的一句话（写入侧仍无调用点，而可达性看不见
   调用点缺口），并更新那两条钉着旧集合的用例（`①` / `⑨`）。
   ★ 一句**不能读成"顺带"**的话：链上"声明了归属的节"从 2 变 1，含义是
   **第 28 条不再需要业主拍**（已裁定），残余那一半是**施工**、归 P1-1 ——
   而不是"少了一个有人认领的断点"。

★ 还有一条**没有被我说圆**的：hub 那个 tick 失败时只在**日志**里说一次
（`console.warn`，同一种坏法去重），而**没有**进任何可查询的诊断面。
⇒ "收账坏着"这件事今天要去看 hub 的 stdout。把它做成一条可读读数排在下一轮
（与写入侧一起做更自然：那时才有真账可读）。

### 3.6 写入侧接进生产（第 118 轮第八轮）：**Run 号按事件取**，不在装配期绑

§14.5 量到的那处真设计问题在这里收口：`spoolDirFor({dataDir, runId})` 是**逐 Run** 一份，
而 `onDecision` 是**装配期**给的 —— 在装配期把 Run 绑死，会让**整个进程只往第一个 Run
的账本里写**：

> 一个「装配期绑死 Run」的车道，与一个「只记第一个 Run」的车道，是同一个东西 ——
> 只不过前者的表现是"后面的 Run 没有工具账"，而那读起来像"那些 Run 没调过工具"。

⇒ 写入侧宿主 `runtime/toolcall/spool-writer.mjs` **不持有 Run**：`runIdOf(event)` 每次从
**这一个事件**里读，于是同一个进程里并发的两个 Run 各写各的文件。

**四处一起落**（少任何一处，车道都还是不产账）：

| 落点 | 改的是什么 | 为什么不能只改它 |
|---|---|---|
| `runtime/contracts/run-identity.mjs` | 按 Run 的身份载荷加 `runId`（`PAYLOAD_KEYS` / `OVERLAY_FIELDS` / 校验） | 不加 ⇒ `readRunIdentity()` 按**闭合键集**拒绝整份载荷（"多一个就拒"），Run 号到不了执行面 |
| `orchestrator/worker/executor.mjs` | `deriveRunIdentityCarrier()` 把 `request.runId` 搬上线上形状（**唯一**的生产者） | 不加 ⇒ 载荷里永远没有 Run 号，写入侧每条都具名拒绝 |
| `runtime/toolcall/spool-writer.mjs` | 写入侧宿主：具名读数码 + **任何失败都不抛** | 不写 ⇒ 车道只有收账侧 |
| `runtime/dsh-composition/plugins/root-row.mjs` | 装配期把写入侧挂成 `onDecision`（`root.mjs:486` 本来就透传这一个键） | 不挂 ⇒ 前三处都只是"允许它写"，没人写 |

★ **`runId` 刻意不进 `CANONICAL_OP_KEYS`**（`enforcement.mjs` 那份是**闭集**：`scope`/`actor`/
`action`/`target`/`taskId`/`toolName`/`callId`/`arguments`）。进去会让"同一个不可变操作"
在不同 Run 下得到不同哈希，于是一次批准覆盖不了真正相同的那次调用 —— 与 `attemptId`
不进哈希是同一条理由（spec §6.5 line 470）。**这一条是本轮唯一动到安全邻域的地方，
所以先量了那张闭集表才动手。**

**⚠️ 仍未接的三处**（一处都不许读成"审计完整性已达成"）：

1. **`dispatched` / `result` 两种记录今天没有观察点**：强制面只看得到"决定已作出"
   （`pre-execute` 那一条通知），看不到"派发了没有、结果是什么" ⇒ 车道**只产 `decision`
   那一种**。要接它们得先有一个**执行结果**观察点，而那是一个新的缝、不是接线问题 ——
   写成施工项而不是随手拿 `elapsedMs` 凑一个 `result`。
2. **只有带投影的事件会被写成一行**：`onDecision` 有几个发射方，只有桥那一条工具调用级
   通知带 `projection`（`tool-request.mjs` 的 `onDecision`）。别的事件**具名拒绝**
   （`NO_PROJECTION`），不猜一行出来 —— 猜出来的那一行会带着别的强制点的语义混进同一本账。
3. **`attemptId` 仍是 `null`**：按 Run 的载体这一轮只加了 `runId`。加它的理由与加 `runId`
   逐字相同（同为观察 metadata、同不进哈希），**下一轮连同第一处一起做**（那时才有真行可读）。

**读数**：写入侧 9 例（`spool-writer.test.mjs`：按事件分账 / 追加不覆盖 / 缺锚具名拒绝且
一个字节都不写 / 读不出 Run 号不回落 / 无投影不猜 / 记账失败不抛也不改判定 / 观测点抛错
不影响写入 / 与收账侧同一份契约）；54 套 `runtime/dsh-composition` 用例 **1026/1026**
（装配期挂 `onDecision` 没有顶动任何既有读数）；`reachability --diff` 与基线一致（新模块
经组合根可达，基线不需要新条目）；§9 链仍是"无硬断 + 唯一软缺口 L9 + 断点全部有归属"。

**★★ 生产路径的验收读数**（`runtime/dsh-composition/spool-writer-wiring.test.mjs`，**5 例**）：
**真的**桥 + **真的**按 Run 身份安装 + 组合根**逐字相同**的三个注入点 ⇒ 一次工具决定
落进**那个 Run** 的车道文件；一个进程里两个 Run 各写各的（§14.5 那处设计的验收点）；
身份里没有 `runId` 时**判定照常**而账一条不写（具名 `NO_RUN_ID`，不回落）；
`deny` 也照记（审计要的是**决定**，不是放行）。

★ 探测时**实测**到一条我原先只是推断的事实：`bridge.preExecute()` **自己**就会发出那条通知，
而它携带的键是 `canonicalHash, decision, elapsedMs, execution, projection, reason, source`
—— **带投影**。⇒ 生产路径上"一次工具决定"正好对应**一条可写**的通知。

★ 同一份探测也暴露出接线里的一个真缺陷：`onDecision` 有**两个**发射方（`assemble.mjs`
把同一个回调同时给了桥与 pre-execute 插件），而后者**按设计**不带投影 ⇒
**每调用一次工具**就产生一次 `NO_PROJECTION` 拒绝。第一版把观测点直接接到 `console.warn` 上——
那会**每一次调用告警一次**，而"每次都告警"与"没有告警"在值班眼里一样没用。
⇒ 改成"同一种坏法只告警一次"，并把"这一条按设计会出现、**不是丢账**（同一次决定已由带投影
那一条记进去了）"写进那一行日志。

★ 这条缺陷值得单独记一句：**它是"接线做对了"的用例看不见的那一类** ——
5 例全绿、1026 例全绿，而日志会在真实负载下被淹掉。

---

### 3.7 ★★★ 白名单的生产路径读数逼出一处**放行方向**的缺陷（第 118 轮第十轮），并补上 CI 漏登记

#### 3.7.1 P1-3 先被量成了两半（它本来被记成一件"施工"）

第 27 条那半（**词汇表 + 映射层**）已经落地：`whitelist-port.mjs:278` 把投影里的
**执行面名**翻成 **Legion 名**，`:309` 再交给 `permitsTool()`。

★ 这件事顺带**推翻了一条记在文档里的旧读数**：状态文档与 §11 那一处都写着
「`permitsTool` 的**生产调用方 = 0 处**」。那句话在第 21 轮是真的，在第 27 条
的映射层落地之后**就不再是真的**——调用方就是那个端口。已在那两处标注订正。

⇒ 于是 P1-3 剩下的是**另一半**：**那份许可的取值从哪来**。今天
`LEGION_EMPLOYEE_PERMIT` 的产出者链是
`runtime/packs/authority.mjs`（**`[gap]`**）→ `narrowToGrant` → 许可 → 环境键。
**它不是一个施工项**：那正是 §5 第 **14** 条（A/B/C）在问的事，而第 14 条
是**业主裁决项**。⇒ P1-3 的剩余部分**并入第 14 条**，不再单列。

#### 3.7.2 为把这一半钉住而写的生产路径读数，落地当天抓到一处缺陷

新套件 `runtime/dsh-composition/whitelist-wiring.test.mjs`（**8 例**）：真端口
（从环境键造出来的）+ 真 `permitsTool`（端口内部调）+ 真桥。
① 里第一次跑就**红了**，而红的原因不是用例写错：

> 只读许可下 `read`（放行）之后，拿**同一个 `callId`** 发 `write` ⇒ **放行**。
> 换一个 `callId` ⇒ 拒。

根因在 `tool-request.mjs` 的 `projectionFor()`：

```js
const remembered = byCallId.get(request.callId)
if (remembered !== undefined) return { ok: true, projection: remembered, remembered: true }
```

**命中就返回**——第二份请求的工具名与参数**从来没进过判据**，桥拿第一份的
形状替它作决定。而 `callId` 是**请求方给的**（`CALL_ID_FIELDS`）。

> 一个「按 callId 复用投影、而 callId 由请求方给」的桥，
> 与一个「第一次调用长什么样，这个 callId 就永远按那个样子判」的桥，
> 在"一个人一个 callId 只用一次"时是同一个东西——只不过后者让
> **一次放行可以洗白任何复用那个 callId 的调用**。

受影响的**不是白名单一道**：`scopeGuard`（路径范围）、`whitelist`、策略判定、
hard floor、`canonicalHash`（账本）全都读那份投影 ⇒ 全都判错对象。

**修法**（不新写一份规范化，复用 PRT-611 那套共享基础库）：
缓存改存 `{projection, toolName, argsKey}`，命中时**先核对身份**——
工具名 + `canonicalJson(arguments)`；不一致 ⇒
`PROJECTION_CODES.CALL_ID_REUSED` + 一条 `contradictions` 读数 + **按拒绝处理**。
审批/guard 那些只拿得到 `{toolName, callId}` 的端口按工具名比（它们本来就看不到参数）。

**两条正对照**（不然"修好了"与"把重试也拒了"分不开）：
⑦ 复用 callId 发不同工具/不同参数 ⇒ **拒**；⑧ 真重试（同 callId、同工具、同参数）
⇒ **仍然放行**，且不留矛盾读数。

#### 3.7.3 ★★ 顺带量到：第八轮那两套用例**从来没进过 CI**

修这一处时顺手把全仓用例对了一遍 `run-ci.mjs`：**333 个 `*.test.mjs` 里有 3 个没登记，
而三个都是本会话加的**——`runtime/toolcall/spool-writer.test.mjs`（写入宿主，9 例）、
`runtime/dsh-composition/spool-writer-wiring.test.mjs`（车道生产路径，5 例）、
以及本轮这一个。⇒ 第八轮那条车道的用例**只在手工跑过**。

> 一个"用例写好了、也全绿"的读数，
> 与一个"用例写好了、而 CI 从不跑它"的读数，在提交记录里是同一个东西——
> 只不过后者把"这条链有人守着"这句话，变成了一句**没人核过的话**。

已全部补登记（现为 **0 个未登记**）。★ 这条也说明"手工跑绿"这个动作**不能替代登记**：
手工跑出来的绿在**当天**与 CI 里的绿同形，在下一次改动之后就不是了。

---

### 3.8 ★★★ 外部 API 授权表**管 scheme**（第 118 轮第十一轮）：协议白名单是表里的**必填项**

业主第 26 条裁决是「**管**：不在白名单协议里一律拒绝」。落地时**没有**在代码里发明"必须 http(s)"——
那既是 PRT-253 §3 禁止的发明默认值，也正是第 20 轮当时**故意没做**的那一步。改成"协议从**表**里来"：

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 授权表 | 只有 `endpoints`（host / pattern / effects） | 多一个**必填** `schemes`（协议白名单；不写 ⇒ **建表失败** `BAD_GRANT`） |
| 请求 | `{method, path, host, ...}` | 必带 `scheme`（缺 ⇒ `SCHEME_MISSING`；不在白名单 ⇒ `SCHEME_NOT_GRANTED`） |
| 端口 | 只把 `rawAuthority` 传下去 | 把 `parseEgressUrl` 已经解析出的 `scheme` **一并**传下去 |

读数：`external-api-scope.test.mjs` ⑱（**同一 host、同一条路径，只差协议**：`https` 放行 / `http`·`ftp`·`ws` 拒；
表里声明 `['https','http']` 之后同一个请求放行 ⇒ 判据读的是**表**、不是硬编码；`'HTTPS'` 按 RFC 3986 归一化）
+ 端口套件 ⑭（端到端：URL → 事实 → 端口 → 判定器）+ 模块内自检 `assertSchemeIsDeclaredNotInherited()`。

★ 一处**残余仍然成立**：`externalApiGuard` 与 `executionGuard` 在同一个 `preExecute` 上是**短路**
（先拒的说了算），不是真的一次取严合并 ⇒ "两道谁先谁后"仍然没有判据钉着。

**同轮量到的两条既有红**（都**不是**本轮改动引入的，且都在**测试**里而不在门禁里）：

1. ★★★ `scripts/config/config.test.mjs` **两条**：① `runtime/` 里出现**字面量**形态的 env 读取点
   （`root-row.mjs` 的 `effectiveEnv.LEGION_DATA_DIR`）；② `runtime/config-schema.mjs` 的 fields 里有这个键、
   而五张键名表的并集里没有 ⇒ 两边各自都能自圆其说。修法是**一处改动同时收口两半**：新增导出的
   `SPOOL_ENV_KEYS`（`root-row.mjs`）并改用下标读取，再把它并进那条判据的并集（15 → **16**，连同它要求的那句复核）。
   ★ 这正是队列 §3.2.1 里归本会话的那条（**丙的机制 + `LEGION_DATA_DIR` 锚**）——机制在，**读取点**当时没走声明面。
2. ★★ `scripts/prt/baseline-snapshot` 的平台契约基线：`team-hub/server.mjs` 的**文件哈希**变了
   （`d955dac`：hub 收账 tick + DataDir 登记）而基线没刷。逐键核对：`httpRoutes`/`dbTables`/`taskStatuses`/
   `taskTransitions`/`goalStatuses`/`permissionModes` **逐字相同**，只有 `sources` 那一行哈希
   ⇒ **不是契约变化**，按工具的话 `--record` 刷新，diff 恰好一行。

**以及三处"手钉坐标"的位移**（都由这一族判据自己红出来）：`boundary-facts.test.mjs` ⑫b（`root-row.mjs`
626 → **724**）、⑫c（`tool-request.mjs` 780 → **848**——★ 这是**第十轮**的位移：当时只改了
`PINNED_CITATIONS`、**没跑这个套件**，所以它红着过了一轮）、`PINNED_CITATIONS` 里
`external-api-scope.mjs` 1061 → **1152**（第六次位移，成因是协议白名单那 91 行）。

### 3.9 ★★★ 台账里的"当时口径"（第 118 轮第十三轮 a+b）：33 处就地标记 + 一条新判据

**问题**：台账是**编年体** —— 每一批进度都**追加在行内**，而"当前状态"只有第 2 列那一格。
于是同一行里可以同时存在"本行仍 🟡"（写于某一批）和一个 ✅ 的状态格，
而**读散文的人拿到的是旧答案**。实测：**10 行里有 33 处**这样的"当时口径"
（第 `33`、`65`、`66`、`68`、`77`、`78`、`81`、`163`、`187`、`203` 行）。

> 一个"写着当时状态"的句子，与一个"现在仍然如此"的句子，在读者眼里是同一个东西。

**处置（a）：不删旧话，就地补标记。** 33 处一律插入
`（★ 当时口径；状态格现为 <格子里的那个符号>）`，紧跟在那个状态词之后。
台账**行数不变**（1807），所以不牵动任何引文坐标。

**处置（b）：把这条写成判据。** `progress-check.mjs` 新增第三类判定 `PROSE_STATUS_STALE`：
行内任何 `本行…仍/仍是 <符号>` 的说法，要么与状态格**相同**，要么**紧邻**一个标记；
标记里的符号必须**等于状态格**（⇒ 抄到别的行、或格子后来变了，两种都会红）。
新增 4 条用例（⑰ / ⑰b / ⑰c / ⑱，含"标记停在 80 字符外不算"与"真实台账 ≥33 处"的非空守卫）。

**量具**：`scripts/prt/mark-stale-prose.mjs`（`--write` 落盘，默认 dry-run，幂等 —— 第二次跑报"处=0"）。
★ 它**没有**自己的 `.test.mjs`，这是**有意的**：它是**修复工具**，而它的产物的对错由
`PROSE_STATUS_STALE` 那条判据验（⑰/⑰b/⑰c/⑱ 四条用例 + 真实台账 ≥33 处的非空守卫）
—— 与其再写一套"工具自己说自己对"的用例，不如让**判据**去判它的输出。

**破验**：删掉任意一处标记 ⇒ `PROSE_STATUS_STALE = 1`，且**2 条用例**同时红。

**一处教训**（已写进工具注释）：这一轮中途用 `git checkout --` 收尾了一次破验，
把**尚未提交**的 33 处标记一起还原掉了（标记数归零、判据立刻红 33）。
⇒ **未提交的交付物不能用 `git checkout` 收尾**；现在这条修复有永久工具兜底（重跑 `--write` 即复原）。

### 3.10 ★ 第 16 条第一刀（第 118 轮第十四轮）：`legion --report=<kind>` —— 接 3 个模块，**5 个 gap 消失**

业主已裁「做」。本条问的形式是"这些产品级动作**由谁触发**"，而本仓**已经有**三处**同一形状**的先例
（`--log-policy` PRT-709 / `--runtime-install-plan` PRT-257 / `--diagnostics=<dir>` PRT-710）
⇒ 第一刀**沿用它**（`legion` 的旗标），**不**新造第二个入口（`legion-release` 之类）。

**切哪三个**：`checklist` / `privacy` / `runbook` —— 三份都自带**无参** `render*()`，
入参**都是模块自己的默认** ⇒ **不发明默认值**（PRT-253 §3），且**零副作用**。
另外 8 个要目录、要模式、要库连接（**碰数据**）⇒ 各有各的那一次裁决，**不在这一刀里顺手做掉**。

**读数**（实测，不是预期）：

| 读数 | 前 | 后 |
| --- | --- | --- |
| 不可达 | 41 | **36** |
| `gap` | 20 | **15** |
| 第 16 条那族 | 11 | **6** |

★★ **比预期多两个**：我只 `import` 了 **3** 个模块，而 `--diff` 报出 **5** 条基线过期 ——
`lifecycle/data-classes.mjs`（`privacy.mjs` import 它）与 `diagnostics/crash-report.mjs`
（`checklist.mjs` 那条链）是**被连带**接上的，**谁都没有直接去接它们**。

> 一次接线会让**几个**模块同时变成可达，而基线与那张人读表
> 只会报出"你记着的那几条"——剩下那几条**没人记得**，于是它们从账上消失。
> ⇒ `--diff` 那句"基线过期 N 条"**必须逐条看**，不能只看数字。

**两个判据如约红了，而且红的方式正是它们设计的样子**：

1. `reachability.test.mjs` ④（"四族 gap 仍然不可达 —— **谁把它们接上，这条就红**"）：
   第九轮刚把 `data-classes.mjs` 补进那张**人读**表，我这一轮就把它接上了 ⇒ 红 ✓。
   按它自己写的处置办：删掉那一条、**补同族的真实成员**（否则 `>= 10` 会红，
   而"把门槛降到刚好够"与"这一层本来就没在查什么"在绿色摘要里长得一样）
   ⇒ 补了 `data-export` / `retention` / `metrics-source` 三条。
2. 新写的 `product/report-cli.test.mjs` ⑤：旗标**真的接到了 handler**
   （`--report=relase` ⇒ 退出码 **2** 且列出可选项；`--report=checklist` ⇒ 0 且输出非空；
   `--report=runbook --json` ⇒ 可解析）。★ 这一条防的是"**旗标写在帮助里、派发却没接**"，
   而那正是 `--help` 自己漂移过一次的形状。

**四条守卫各自的负面控制**（`report-cli.test.mjs` ④：注入一张假表）：
渲染出空串 ⇒ `NOT_TEXT`（不然"报告是空的"会被读成"报告说没事"）；
渲染抛 / 判定抛 ⇒ `RENDER_FAILED`；不认识的 kind ⇒ `UNKNOWN_KIND`
**且消息里列出全部可选项、且不带正文**（不回落 —— 回落会让人拿着**别的**那份报告去核对发布条件）。

**登记**：新套件已进 `run-ci.mjs` 的套件表（第八轮那条教训：写好了却不登记 = CI 从不跑它）；
`--only stage` 的"套件归属"审计 PASS。★ 台账那 6 行（PRT-903/904/905/906/907/909）加了就地注记，
**状态格一个都没动**（它们本来就是 ✅，这一刀改的是"有没有入口"，不是"做没做完"）。

---

## 4. 顺带量到的一条：**决策面文档的引文坐标在漂**（本轮新读数）

写 §2 时逐个核了坐标，结果**四处对不上**：

| 文档里写的 | 今天的实际 | 差 |
| --- | --- | --- |
| `product/config-schema.mjs:88` 定义 `dataDir` | `:88` 是 `export const SCHEMA = defineSchema({`；`dataDir` 在 **`:102`** | 漂 14 行 |
| `product/config-schema.mjs:1043` / `:1045` 是 `LEGION_DATA_DIR` 的两行派生 | 那两行现在是 `TEAM_HUB_URL` 与 `LEGION_ACTOR`；`LEGION_DATA_DIR` 在 **`:1074`** / **`:1076`**（★ 第 118 轮第十五轮校订到 `:1064`/`:1066`，**第十六轮又 +10**：我在同一个文件的 `nonEnvLiterals` 里插了第 16 条第二刀的 4 个码 ⇒ 两行再往后挪。**同一个面在一轮之内漂了两次**，而两次都不是"写错了"，是**物理位移**） | 漂 14 → 21 → **31** 行 |
| `team-hub/server.mjs:279` 是 hub 的库 | `:279` 是 `ROOT` 的算法；库在 **`:335`** | 漂 56 行 |
| `runtime/dsh-composition/plugins/root-row.mjs:591` 是 `installEnforcementRoot` 的生产调用方 | **那一行是空的**；真正的调用在 **`:626`** | 漂 35 行，且落在空行上 |

**为什么没有任何闸门变红**：`scripts/prt/boundary-facts.mjs` 的坐标判据
只扫**台账**那一个文件（`lineCitations: () => scanLineCitations(doc(LEDGER_DOC))`），
而上面四条都在 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` 与
`MULTI-AGENT-FEATURE-STATUS.md` 里。这与第 104 轮那条
「漂了 414 行的引用落在**所有判据的视野之外**」是同一个形状——
只不过那次在台账里，这次在决策面文档里。

> 一条"写着出处、但没人再核对过"的坐标，与一条"当初就是编的"坐标，
> 在读者的眼里是同一个东西——只不过前者在被引用时看起来更有依据。

**处置（本轮只记账，不改那两份文档）**：§2 的施工坐标一律用**本次实核过的行号**；
要不要把坐标判据从"只扫台账"扩到决策面文档，是一次独立的决定——
扩了会当场翻出上面这四条，也会让每次重排注释都可能变红
（而**一个总是叫狼来了的门禁会被关掉**）。

### 4.1 同一批量出来的第二条：**"被关掉的行"与"解析不出包的行"在基线里同形**

刷新组合基线时（见 `22bad70`）看到：被 `plugin_manager` 关掉的那一行，
在 `prt-010-composition-baseline.json` 里记成

```json
{ "id": "legion-scrum-worker-ozon", "package": null, "repoDir": null,
  "configKeys": [], "emptyConfigKeys": [] }
```

而记录器的解析器**是**认 `disabled:` 的（`scripts/prt/composition-baseline.mjs:162`）——
只是这一层投影没把它带出来。于是：

> 一个"被有意关掉的行"，与一个"解析不出包的行"，在基线文件里是同一段字节。

本轮**没有**改记录器（只记账）。它与 §4 那条是同一类待决定项：
**判据的覆盖面要不要往外挪一格**，而每一次往外挪都要先想清楚
"它变红的时候，读的人能不能分辨是哪一种红"。

### 4.2 ★★★ 同一形状的**第三个面**：源码注释里的坐标（第 118 轮第十三轮 c）

§4 问的是"判据要不要从**只扫台账**扩到**决策面文档**"。本轮量到的是**另一个面**
—— **源码注释**，而它今天**已经收进判据**了（§4 那个面**没有**动，仍是待决定项）。

**形状**：`` `路径:行` 的 `符号` `` —— 一句"这个符号在那个坐标上"。
它此前被明确记为做不了（`source-original-citations-on-line` 的 why 里那句
"多数 `文件:行` 引用只给坐标、不抄原文，要判它们必须读语义"）。
★ 那句话对**纯坐标**是对的，但**点了名的那种不需要语义** —— 符号在不在那儿是机械命题。

**实测（全仓七个根目录）**：这个形状只有 **9 处**，其中 **6 处对不上**：

| 引用处 | 写的 | 今天实际 | 差 |
| --- | --- | --- | --- |
| `orchestrator/config-schema.mjs:152` | `team-hub/server.mjs:438` 的 `resolveRunPermissions` | **`:497`**（`:438` 是一句无关的 SQL 插入） | 漂 59 行 |
| `runtime/dsh-composition/whitelist-port.mjs:8` | `tool-request.mjs:998` 的 `whitelist` | **`:1066`**（`if (whitelist !== null)` 那一行） | 漂 68 行 |
| `scripts/prt/reachability.mjs:79` 与 `:120`、`reachability.test.mjs:103` | `scripts/ci/run-ci.mjs:3748` 的 `tracked` | **`:4738`** | 漂 **990** 行 |
| `runtime/contracts/run-identity.mjs:12` | `enforcement.mjs:86` 的 `CANONICAL_OP_KEYS` | 行号**是对的**，但**文件名少了目录**（真文件在 `runtime/dsh-composition/`）⇒ 三个候选都解析不到 | 读者**找不到文件** |

**处置**：六处全部订正；新增两条判据 —— `source-comment-coordinate-names-its-symbol`
与它的空转守卫 `source-comment-coordinate-symbol-surface-not-empty`；
新增 3 条用例（⑳ / ⑳b / ⑳c：窗口边界**两侧各钉一次**、四种结局、两条载荷控制）。

**破验（实跑过）**：往 `scripts/prt/` 放一个含错坐标的临时文件 ⇒
`✖ source-comment-coordinate-names-its-symbol` 连同它自己那句诊断一起红；删掉即恢复 PASS。

**两处顺带量到的缺陷**（都不是"有人偷懒"，而是**量具自己的洞**）：

1. ★★ **扫描面是从邻居那里抄来的**：`ORIGINAL_CITATION_ROOTS` 只有六个根，
   **`security/` 整个目录不在里面** —— 而它写着这种引用（第 9 处就在那儿，**且它是对的**）。
   ⇒ 本判据用自己的根表 `CITE_SYMBOL_ROOTS`（多一个 `security`）；
   `security/` 下那 **6 处**「原文/原句」今天仍不在任何判据里 ⇒ 记 **P3-3**。
2. ★★ **一个比判据自己更严的前置过滤**：`if (!text.includes('` 的 `'))`
   漏掉「`的` 两侧没空格」的写法，把 9 处**静默读成 8 处**
   ⇒ 已换成恒弱于正则的前置（只要求出现过 `的`），并在代码里记下这次误读。

> 一个"便宜的前置过滤"与一个"判据自己的正则"，在写法只差一个空格的时候给出不同的读数 ——
> 只不过前者少读的那一处，**不会以任何形式出现**。

**仍然开着的两个面**（本轮**没有**动）：
· §4 那个面（决策面 **markdown 文档**的坐标，四条已知漂移）—— 理由不变，仍是待决定项；
· **纯坐标**（既没抄原文、也没点名符号）—— 这一层判不了，边界写在那条判据的 `why` 里。
  实测的一个样本：`scripts/prt/progress-check.mjs:64` 引 `scripts/prt/boundary-facts.mjs:142`，
  而 `:142` 今天讲的是**另一件事**（"一份专门用来汇总'哪些读数可信'的报告里…"）⇒
  它**至少是可疑的**，而这条判据**看不见它** —— 因为它既没抄原文、也没点名符号。

★ **顺带自我记录**：本轮我自己制造了**两处**坐标位移，都当场订正了 ——
`reachability.test.mjs:309 → :310`（我在 `:104` 插了一行注释）、
`boundary-facts.test.mjs:1141 → :1145`（我在导入区插了 4 行）。两处都**没有任何门禁**会报
（都在 §4 那个面里）—— 这正好是"**每次重排注释都可能让文档坐标变红**"那句话的现场样本。

### 4.3 那个面的**规模**（第十四轮实测）：21 处同形、7 处真漂、4 处是"记录漂移本身"

把 (c) 的判据**原样挪到 markdown** 上量了一遍（同一个形状 `` `路径:行` 的 `符号` ``；
解析器补上 `feature-landing-paths` 那条**裸名全仓唯一**规则 —— 不补的话读数会被
`unresolved` 淹没：21 处里会报 13 处"解析不到"，而"淹没"与"没漂"在只看总数时是同一个东西）：

| 读数 | 值 |
| --- | --- |
| markdown 里带具名符号的坐标 | **21** |
| 对得上 | 10 |
| **真漂了** | **7** —— `root-row.mjs:591` 的 `onDecision`（×4 份文档）、`run-ci.mjs:3748` 的 `tracked`（×2）、`server.mjs:1735` 的 `checkPermission`（×2）⇒ 去重后 **3 个坐标**、跨 **5 份**文档 |
| 剩下 4 处"坏" | ★★ 是 **§4 与 §4.2 这两张表自己**：它们**故意逐字引用**那些错误的旧坐标 |

★★ 最后一行是那个决定里**最关键的一条新读数**：

> 一条盯着"markdown 里的坐标"的判据，会**先红在记录这些漂移的那两张表上** ——
> 也就是说，它惩罚的恰恰是"**把问题写下来**"这个动作。

所以 §4 那个面真要做，**必须先有"引用旧坐标"的合法写法**（例如显式标 `（旧）`），
否则第一个被逼着改的就是**记录本身**。这一条是实测出来的，不是推的。

★ 顺带：本会话在 (c) 里订正的 6 处是**源码注释面**，全部不在这 21 里；
两个面**没有重叠** —— §4 那个面今天仍然**一处都没改**。

---

## 5. 本会话欠账清单（第 118 轮第十四轮**逐条核实**）

★ 起因：业主让"把欠在你这边的整理出来继续完成"。
★ 核实纪律：**不信本表上一版的状态列**，逐条去读代码 / 跑工具 / 查提交 ——
结果**两条已经做完，而状态列还写着"待做"**（与台账行内散文同一个病）。

| 项 | 上一版状态列 | 第十四轮核实到的 | 读数 / 证据 |
| --- | --- | --- | --- |
| **P1-2** | 待做 | **✅ 已做完**（第九轮） | `product/launcher/first-run.mjs` 不存在（`Test-Path` = False）；删除提交 `943ccdc`；活的那份 `wizard.mjs` / `--wizard` 仍在 |
| **P1-3** | 待做 | **✅ 两半都做完** | 映射层 `whitelist-port.mjs:278` / `:309`；**生产装配** `root-row.mjs:645`（`whitelistPortFromEnv`）⇒ `:760` 喂桥；剩下的"许可取值从哪来"并入第 14 条，**业主已答** |
| **P3-1** | 待排 | **✅ 清点完成** | 20 个 gap 逐条有名字、全部挂着裁决处：第 16 条 11 / 第 19 条 6 / 第 18 条 3（见 §5.1） |
| **P1-1** | 🟡 只剩三处未接 | **仍然如此**（三处都在代码里点到）；★ 而 **§2 那四处施工面第七轮就全落了**（`d955dac`）—— 本节此前只会让人**再去做一遍** | ① `spool-writer.mjs:128` 对 `projection == null` **具名拒绝**（`NO_PROJECTION`）⇒ "只有带投影的事件会被写成一行"；② `spool-writer.mjs:144` **只追加 `DECISION`**，而 `spool.mjs:110`/`:112` 定义了 `dispatched`/`result`、`toolcall-drain.mjs` 也认它们 ⇒ 那两种记录**没有写入侧观察点**；③ 行里的 `attemptId` 仍是 `null`（载体只带 `runId`，`spool.mjs:124` 的必填字段只有 `['callId']`） |
| **P1-4** | 待做 | **🟡 两刀都已落**（第十四 / 第十六轮） | 它本来不是一个"CLI 面"，是 **11 个模块**没有生产入口；第一刀接 3 个只读报告（**连带**清掉 5 个），第二刀接**一条读法**（`store-scan.mjs` + 三面计划旗标，**直接**接上 3 个）⇒ **剩 3 个**（全是 metrics 那一支，要库句柄）（§3.10 / §7 / §5.1） |
| **P3-3** | 待排 | 待排（读数已有） | `security/` 下 15 个 `.mjs` 里 **6 处**「原文/原句」，今天不在任何判据面内 |
| **§4 那个面** | 待决定 | 待决定（**读数补齐**） | markdown 21 处同形坐标：10 对、**7 真漂**、4 处是"记录漂移本身"的表（§4.3）⇒ 做之前必须先有"引用旧坐标"的写法 |

### 5.1 P3-1 的逐条清单（20 个 `gap`，全部有主）

| 裁决处 | 个数 | 模块 |
| --- | --- | --- |
| **§5 第 16 条**（业主已裁：**做**） | ~~11~~ → 6 → **3** | **已清（第十四轮第一刀连带）**：`release/{checklist,privacy}.mjs`、`support/runbook.mjs`（直接接）、`lifecycle/data-classes.mjs`、`diagnostics/crash-report.mjs`（**连带**接上）。**已清（第十六轮第二刀直连）**：`lifecycle/{data-export,retention,uninstall}.mjs` —— 走 `plan-cli.mjs` 三面旗标，共同入参由新模块 `store-scan.mjs` 从磁盘读。**剩下 3 个**：`product/metrics-source.mjs`、`product/metrics-spec7.mjs`、`product/metrics-spec7-source.mjs` —— ★ 它们要的是**库句柄**（只读打开 hub 的 `team.db`），那是"谁可以在什么时候读运行中的库"那一类问题，与前三者的"目录"不同 |
| §5 第 19 条 | **6** | `product/execution-plane-config.mjs`、`runtime/connectors/target-binding.mjs`、`runtime/packs/store.mjs`（PRT-1003）、`runtime/packs/compiled-plan.mjs`（PRT-1004）、`runtime/packs/authority.mjs`（PRT-1005）、`runtime/packs/builtin/software-delivery.mjs`（PRT-1006） |

| §5 第 18 条 | **3** | `runtime/employee/role-pack.mjs`（F-19 执行面）、`runtime/experience/friction.mjs`（F-18 摩擦分）、`runtime/experience/graph.mjs`（F-18 图） |

★ 一句要写下来的边界：`product/diagnostics/` 与 `product/launcher/` 里**已经有** CLI 面
（`diagnostics-cli.mjs`、`wizard-cli.mjs`，两套都在 CI 里），而 `crash-report.mjs` **仍在 gap 里**
⇒ "这一族有 CLI" **不等于**"这一族每个模块都有入口"。前者是印象，后者是读数。

---

## 6. 本批收口（第十五轮末）：全量 CI **9/9 PASS**（`f3d960b`）

```
syntax:PASS env:PASS boundary:PASS deps:PASS build:PASS test:PASS smoke:PASS stage:PASS doc:PASS
```

而这一次的 `test` 阶段是**在三条提交之后、工作树全干净**的状态下跑的 —— ★ 也就是上一次它红的那种状态。
上一次它抓出 3 处，性质**必须分开说**：

| # | 抓到的 | 性质 |
| --- | --- | --- |
| ① | `alpha-chain-trace` ⑧：`map.size >= 40` 假红 | **该红的**：一条会过期的魔数（我把不可达从 41 降到 36）。已改成与**基线文件本身**逐条对齐 |
| ② | `reachability` ⑭：§5 状态索引 28 vs 29，且第 16 条派生出 `待裁决` | **该红的**：我把索引那一格写成了词表外的词（整条掉出索引），又把正文那行的标记写成了词表不认的形式（`已裁「做」` ≠ `已裁决` / `业主 <日期> 裁定`） |
| ③ | `reachability` ⑦：`dirty.size > 0` 假红 | ★ **门禁自己的缺陷**：它要求工作树**必须是脏的**，于是把"收工"判成了红。已换成更强的断言：**干净 ⇒ `in-flight` 必须为空** |

### 6.1 一条操作纪律（我自己踩的）

我第一次跑 CI 时用了 `… | Select-String … | Select-Object -First 60` —— **`-First` 会在取够 60 行后
关掉上游管道**，于是那个 CI 跑到 `test` 阶段开头就被**掐死**，作业退出码 1。
我一度把它读成"CI 又红了"。分辨它靠的是 CI 自己落盘的 `.ci/<时间戳>/ci.log`
（末尾停在 `===== [test] L0 … =====`，而 `suites/` 里**一个失败日志都没有**）。

> CI 的输出**不许被下游截断**：`-First N` 与"这个进程还在跑"是不相容的。

### 6.2 本会话这一批的完整读数（★ 这是**第一刀之后、第二刀之前**的快照）

| 面 | 之前 | 现在 | 出处 |
| --- | --- | --- | --- |
| 不可达总数 | 41 | **36** | `prt-reachability-baseline.json`（36 条，未分类 0） |
| 其中 `gap` | 20 | **15** | 同上 |
| 第 16 条名下 | 11 | **6** | §5.1 |
| 生产入口 | `--report` 无 | `--report=checklist\|privacy\|runbook`（3 份只读报告） | `product/report-cli.mjs` + `product/launcher/cli.mjs` |
| 全量 CI | — | **9/9 PASS**（`f3d960b`） | 本节 |

★ 上表三行数字（36 / 15 / 6）在**第十六轮第二刀之后**又变了（**33 / 12 / 3**）——
**§7 开头那张表**是新的。★ 两张都留着：这一张是"第一刀落地时"的读数，
而它**当时是对的**；把它改成新数字，就等于把"这一批做了两次"这件事从账上抹掉。


---

## 7. 第 16 条第二刀（第十六轮）：**缺的不是 CLI，是一个读法** —— 已落

★ 本节是**第十五轮只读实测**留下的记录（它当时**没有**动代码），而**第十六轮把它做掉了**。
两段都留着：前一段是"为什么不能拿静态目录打印去关掉 gap"（这条劝阻现在仍然成立），
后一段是"实际怎么落的、读数是多少"。

把当时剩下 6 个逐一看它们的**主入口要什么入参**，结论只有两类：

| 模块 | 主入口 | 要的入参 | 仓里有吗 |
| --- | --- | --- | --- |
| `lifecycle/data-export.mjs` | `planExport({stores, include, scannedSecrets})` | 磁盘上**实际存在**的落点（带 class） | ❌ **没有** → ★ **第十六轮补上**：`store-scan.mjs` |
| `lifecycle/retention.mjs` | `planRetention({entries, policy, nowMs, activeRefs})` | 逐条的 `{path, bytes, mtimeMs}` | ❌ **没有** → ★ 同上 |
| `lifecycle/uninstall.mjs` | `planUninstall({stores, mode, layout})` | 同 `planExport` 的落点清单 **+ 一个显式模式** | ❌ 落点清单没有 → ★ 同上（模式由 `--uninstall-plan=<mode>` 显式给） |
| `metrics-spec7-source.mjs` | `spec7CountsFromHubDb(db, …)` | 一个**库句柄** | ⚠️ 路径知道（`team-hub/server.mjs:335`），但没有"只读打开"的入口 |
| `metrics-spec7.mjs` | `computeSpec7Metrics(snapshot)` | 上面那个 source 的产物 | ❌ 同上 |
| `metrics-source.mjs` | `createMetricsSource({store, auditDir, …})` | 库句柄 + 审计目录 | ❌ 同上 |

**★ 四条卡在同一个东西上：仓里没有任何"把数据目录走一遍、按 `classifyPath` 分出类别"的生产读法。**
（`product/init.mjs:268` 的 `directorySize()` 走的是同一棵树，但它**只回一个总量**，不落每条 ⇒ 不是枚举器。）

★★ **第十六轮已落**：那个读法是 `product/lifecycle/store-scan.mjs`，三个消费者是
`product/lifecycle/plan-cli.mjs` 接的三面旗标 —— `--uninstall-plan=<mode>` / `--export-plan` / `--retention-plan`。

| 面 | 之前 | 现在 |
| --- | --- | --- |
| 不可达总数 | 36 | **33** |
| 其中 `gap` | 15 | **12** |
| 第 16 条名下 | 6 | **3**（只剩 metrics 那一支，要一个库句柄） |
| 全量 CI | 9/9（`f3d960b`） | **9/9 PASS**（`2ca5c51`；`syntax 13463 / env 3957 / boundary 924 / deps 4 / build 14692 / test 1174441 / smoke 9778 / stage 111 / doc 2264` ms） |

★ 本刀**一次全量 CI 就全绿**（上一批的 9/9 里有 3 处红是它抓出来的；这一批 0 处）——
而它**不代表**这刀没有错：`plan-cli` 自己的 3 处红是在写用例的当场就被自己抓住的
（见 `plan-cli.test.mjs` 的 ④⑦⑨），没等到 CI。**能把错在当场抓住的，是用例；CI 是第二道网。**

★ 读数之外的两条**必须一起读**（它们比数字重要）：

1. **`--diff` 报"过期 3 条"，而人读表里只记着 2 条** —— 第三条 `uninstall.mjs` **只在基线 JSON 里**。
   "一次接线让几个模块同时可达，而账只会报出你记着的那几条" —— 这句话上一轮刚写过，这一轮**又对了一次**。
2. **这一刀是直接 import，不是连带**（第一刀那 5 个是连带）。两种接线方式在 `--diff` 上**长得一样**，
   所以"为什么这个模块可达了"永远要**逐条看**，不能只看条数。

### 7.1 ⚠️ 一个很容易犯、而且会骗过判据的走法：**拿静态目录打印去把 gap 关掉**

`data-classes.mjs` / `retention.mjs` / `data-export.mjs` 各自都导出**静态表**
（类别表、`DEFAULT_RETENTION`、`EXPORT_CLASS_POLICY`）。于是"给 `--report` 加四个目录类报告"
可以让 4 个模块**今天就变成可达**、`gap` 从 15 掉到 11 —— 而**用户一个动作都按不到**。

> 这正是 `scripts/prt/reachability.test.mjs` ④ 那句自己写着的判据：
> 一个"模块可达"的读数，与一个"这条链真的跑了"的读数，
> 在只看探针汇总的时候是**同一个东西**。

⇒ **第十六轮没有走这条路** —— 先有那个**读法**（枚举器），再有那个**读数**。
★ 这一格是留给下一个人看的：**当时差一点就这么做了**，而它能让上表三行数字立刻变好看。

### 7.2 第二刀实际落的形状（一个读法解锁 3 个 gap）

扫的**根**全部来自 `resolveLayout`（安装目录 / 数据 / 工作区 / 缓存 / 日志 / 密钥库 / 配置文件），
这一层**一个默认值都不加**。扫描器自己守四条纪律（每一条都有用例）：

- **只读**（`data-export.mjs` 文件头坑②明令："为了导出一致快照先 checkpoint 一下 WAL"是对运行中的产品做了一次写操作）；
- **有上限，且到上限要说出来**（`scan-truncated`）——"没扫完"与"扫完了"不许同形；
- **不跟符号链接出根**（跟着走会扫到**别人的文件**），跳过多少条要报；
- **认不出就原样带出、不猜一个类别**（`scan-unclassified`）—— 猜了，上层的具名拒绝
  （`uninstall-unclassified-store` / `export-class-unknown`）就**永远不会出现**。

★ 还有一条**只有真跑一次才会想起来的**：**安装目录必须在要扫的根里**。
`program-only` 模式要删的就是它；漏了它，计划会打印"会删：无"——**而模式名正说着要删程序**。
用例 `⑤` 专门钉这一条。

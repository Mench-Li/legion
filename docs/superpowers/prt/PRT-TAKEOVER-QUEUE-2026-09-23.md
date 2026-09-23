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

#### 下一阶段的两个候选（先记形状，不先写码）

1. 等待只针对 `LOADING(1)`（"`apply` 在跑"），**永不**针对 `PENDING(0)`
   （那是一个可能永远不来的依赖）——且必须证明三个真进程套件仍然全绿；
2. `runtime-contract-server-row.mjs` 里把"注册方还没发布"与"形状不对"分成两个读数
   （前者可等，后者当场拒），而不是都落进 503 的同一句话。

---

## 1. 优先级队列

排序依据只有一条：**会不会让下一个人照着一个反的读数做决定**。
同档之内，先做"解锁别人的"。

| 序 | 任务 | 类型 | 依据 | 状态 |
| --- | --- | --- | --- | --- |
| **P0-1** | `test` 阶段**全量**复跑 | 验证 | 第 116 轮 7 个红套件修在 `59a6ad9`，此后只跑过 `--only` | ✅ 已跑（本轮，1295s）：2 红 —— 一个我已修，一个见 P0-2 |
| **P0-2** | **`legion-enforcement-runtime-contract-server` 行挂载了却从未激活** | 施工·真缺陷 | `EXECUTOR_SELF_CHECK_INCOMPATIBLE` + `行已挂载但未激活（等待依赖服务）`；19 例 6 败 | 🟡 根因已证（§0.4）；第一阶段修法**净亏、已撤回**；下一阶段两个候选待做 |
| **P1-1** | 接 `spool` / `toolcall-drain` **落账车道**（解目标链 L7） | 施工 | §14.4 / §14.5；两半各有一套用例（14 + 13 例），环已在真 SQLite 上走通 | **本轮开工**（业主已选定） |
| **P1-2** | 删掉 PRT-707 **死的那份**实现 | 施工 | 业主 2026-09-23 裁决 | 待做 |
| **P1-3** | `whitelist` 装配 + **Legion 能力词表**映射 | 施工 | 业主 2026-09-23 裁决（第 27 条选 Legion 名 + 加映射） | 待做 |
| **P1-4** | 阶段 9 产品动作的 **CLI 面** | 施工 | 业主 2026-09-23 裁决（第 16 条：做） | 待做 |
| **P1-5** | 外部 API 授权表**管 scheme** | 施工 | 业主 2026-09-23 裁决（第 26 条：管） | 待做 |
| **P2-1** | 第 24 / 25 条的**临时口径**：政策门暂不从连接器声明读能力；MCP 工具归属暂以 F-21 登记表为准 | 记账 | 业主本轮未给，先按保守一侧记，等他改 | 已记 |
| **P2-2** | 剩下的裁决项：第 12 / 10 / 8 / 6 / 21 条 | 裁决 | `DECISION-BRIEF.md` §1 / §2 | 待业主 |
| **P3-1** | 23 个 `gap` 类模块（有实现、无生产路径）的收口盘点 | 记账 | `reachability.mjs --diff`：不可达 44 = by-design 13 · deliberate 8 · **gap 23** | 待排 |
| **P3-2** | 19 个陈旧 worktree（`w/T-043`…`w/T-117`、`codex/prt-phase0-1`、`codex/prt-runtime`） | 卫生 | 分支领先 `main` 1–2 个提交未合并，最后活动 9/5–9/12；其中 4 个还有未提交改动 | 待排 |
| **P4-1** | PRT-009 / PRT-253 / PRT-256 / PRT-910 | 等外部 | 需执行期外的机器 / 真实外部用户 / 真实用户项目 | 本机无可做动作 |
| **P4-2** | PRT-316 的日期闸门 | 等日期 | 最早可启动 **2026-09-24**；但 churn 闸门读数 `cooled=false recentMax=9/40`（阈值 ≤2）⇒ 阶段 3 **仍应推迟** | 等日期 + 等降温 |

---

## 2. P1-1 的施工面（先把坐标钉准）

第 22/76/84/87 轮反复量过这一条。**要改的不是"实现什么"，是接线**；
而接线的前提是"车道的目录由哪一个既有配置量派生"——第 84 轮已经把这一半答掉了：

> `product/config-schema.mjs:102` 定义了产品**唯一**的 `dataDir`（`LEGION_DATA_DIR`，落点由冻结的目录布局定），
> 而 `:1057`（runtime）与 `:1059`（orchestrator）已经把它派给了那两个进程。
> `product/process-manifest.mjs:111` 显示 `team-hub` 是**同一份进程清单里的兄弟进程**，
> 只是它的 `envNames`（`:135`）里**没有** `LEGION_DATA_DIR`。

于是施工面是三处 + 一处设计：

| # | 位置 | 要做什么 |
| --- | --- | --- |
| 1 | `product/config-schema.mjs` 的派生表（`:1057` / `:1059` 那一族） | 补一行 `{ target: 'team-hub', env: 'LEGION_DATA_DIR', via: 'env', from: 'layout.dataDir', … }` |
| 2 | `product/process-manifest.mjs` 的 team-hub 块（`:111` / `:135`） | 把 `LEGION_DATA_DIR` 加进它的 `envNames`（不加 ⇒ `buildChildEnv()` 对未声明的键**直接抛**） |
| 3 | `product/launcher/launcher.mjs` | 拼子进程环境时把该键真的传下去 |
| 4 | **按 Run 的缝**（设计） | `onDecision` 是**装配期**参数，而 spool 是**逐 Run** 一份。观察点必须从**按 Run 安装**的那个缝（PRT-214 已跑通两遍的形状）读当前 runId |

第 4 条是**唯一还带设计成分**的一处。`runtime/dsh-composition/plugins/root-row.mjs:626`
是 `installEnforcementRoot()` 在全仓**唯一**的生产调用方；在那里绑死 runId
会让**整个进程只往第一个 Run 的账本里写**——而"第二个 Run 的工具账不见了"
在任何单 Run 的用例里都是绿的。

⚠️ 两条口径先写在前面，免得施工时走偏：

1. **不许发明默认值**（PRT-253 §3）。收账侧的库路径今天是 `team-hub/server.mjs:335`
   的 `join(ROOT, 'team-hub', 'team.db')`——那是**库**的位置，不是**车道**的位置，
   不能顺手拿它当 spool 的目录。
2. **收账侧不住进 hub 进程**（第 28 条的"乙"）。本轮裁决走的是"按 Run 交付"
   这一族形状（与第 19 条逐字一致），不是把车道绑死在库旁边。

---

## 3. 本轮业主裁决（2026-09-23，六条）

| 项 | 裁决 | 直接后果 |
| --- | --- | --- |
| 守护停止范围 | 保持**全停**，由本会话接管 | 不再有第二个进程争同一棵工作树 |
| P1 首项 | **接 spool / toolcall-drain 车道** | 见 §2 |
| 第 27 条（whitelist 词汇表） | 用 **Legion 能力名**，在强制面**加一层映射** | `runtime/dsh-composition/whitelist-port.mjs:177` 的 `translateToolName()` / `:350` 的 `whitelistPortFromEnv()` 就是那层；缺的是**装配里没人传值**（`surfaces.whitelist === false`，有用例钉着） |
| 第 17 条（两份向导实现） | **删掉死的那份**（`product/launcher/first-run.mjs`） | 它被三条判据围着：`wizard-wiring.test.mjs` 的 ③（零生产导入者）、`scripts/prt/reachability.test.mjs:309` 的基线、`scripts/ci/run-ci.mjs:4285` 的套件登记——删文件必须同时处置这三处 |
| 第 16 条（阶段 9 CLI 面） | **做** | 14 个"零生产入口"模块里唯一"轮到补入口"的一类 |
| 第 26 条（外部 API 的 scheme） | **管**：不在白名单协议里一律拒绝 | `runtime/dsh-composition/external-api-scope.mjs:806` 的 `checkExternalApi()` 今天**完全不看 scheme**（全文件搜 `scheme` 零命中）⇒ `ftp://…` 会被放行 |

---

## 4. 顺带量到的一条：**决策面文档的引文坐标在漂**（本轮新读数）

写 §2 时逐个核了坐标，结果**四处对不上**：

| 文档里写的 | 今天的实际 | 差 |
| --- | --- | --- |
| `product/config-schema.mjs:88` 定义 `dataDir` | `:88` 是 `export const SCHEMA = defineSchema({`；`dataDir` 在 **`:102`** | 漂 14 行 |
| `product/config-schema.mjs:1043` / `:1045` 是 `LEGION_DATA_DIR` 的两行派生 | 那两行现在是 `TEAM_HUB_URL` 与 `LEGION_ACTOR`；`LEGION_DATA_DIR` 在 **`:1057`** / **`:1059`** | 漂 14 行 |
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

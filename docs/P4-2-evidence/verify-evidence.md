<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P4-2 宿主插件导入失败诊断 —— 验证证据

> 任务来源：`docs/REMAINING-TASKS.md` 候选 #9「宿主插件导入失败的诊断可读性」。
> 症状原话：`team-hub/lib` 缺失与启动期迁移崩溃在宿主侧都表现为「60s 未就绪」或「插件路由 404」，
> 定位只能靠翻宿主子进程 stderr。

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `tests/p13-fixture/host-diagnostics.mjs`（新，纯函数） | 诊断层：组合行入口解析（`resolveRowEntry`）、启动前预检（`preflightEntries`）、真实宿主日志解析（`parseHostFailures`）、裸模块错误反查组合行（`attributeModuleError`）、汇总结论（`diagnoseHostLogs`）、可读渲染（`formatDiagnosis`）、诊断错误类型（`HostBootError` / `hostBootError`）、组合行 YAML 提取（`parseCompositionRows`） |
| `tests/p13-fixture/host-diagnostics.test.mjs`（新，**24 例**） | 纯函数单测：**无 DSH 依赖**，任何机器都跑（含 CI）。用例锁的是**真实日志原文**（见 §3.1）与**真实文件系统**真值 |
| `tests/p13-fixture/broken-plugin.mjs`（新） | 负向夹具：一个在**导入期**就 `throw` 的插件（只被负向用例挂载，任何生产 profile 都不引用） |
| `tests/p13-fixture/host-fixture.mjs`（改） | `makeFixture` 支持 `extraRows` / `extraPackages`（挂坏条目 + 假包）、`rows` 与 `packageDirs`（组合行真值 + 入口表，来自刚写下的补丁层）、`preflight()`、`diagnoseOpts()`；`waitReady` 失败时**快速失败 + 结构化诊断**（并等 stdio 排空）；新增 `drainLogs`（按 `readableEnded` 判交付完成，不白等上限）、`routeMissDetail` |
| `tests/p13-fixture/p13-host-injection.test.mjs`（改，9 → **14 例**） | 主套件：`before` 加启动前预检 + 带诊断的 `waitReady`；路由 200 断言改带 `routeMissDetail`；新增「健康宿主零误报」对照 1 例 + **两个负向 describe（5 例）** |
| `scripts/ci/run-ci.mjs` | `p13-host-injection` 套件组纳入 2 个文件（纯函数单测 + 真实宿主）；标签更新 |
| `docs/REMAINING-TASKS.md` / `docs/STATUS.md` | 候选 #9 关闭；基线数字与限制同步 |

## 2. 决策与取舍

### 2.1 诊断的根是「组合行真值」+「真实日志原文」，不是猜

三处输入全部可验证，**没有一处是猜的**：

1. **谁在组合里**：`makeFixture` 把刚写下的 `cordis.patch.yml` 用 `parseCompositionRows` 解析成
   `rows`（`{id, name}`）——诊断用的表与宿主真正挂载的行**同一来源**，不会漂移；
2. **入口文件在不在**：`resolveRowEntry` 用行的 `name`（`@dsh-external/*` → 仓库目录、`file://` → 文件）
   读 `package.json` 的 `main/module/exports` 并 `existsSync`；
3. **宿主到底报了什么**：`parseHostFailures` 只做字符串匹配真实 app-boot/loader 输出（模式见 §3.1），
   匹配不到就是空数组——**不编造结论**。

### 2.2 先复现，再写解析（本轮最重要的一次自我纠错）

初版解析器按**推测**的失败文本写了 `plugin(s) failed to load:` 与 `N entries did not activate` 两条模式。
负向夹具一跑，真实宿主给的是完全不同的形状（下方为逐字原文）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to import loader entry p13-broken-file (file:///D:/…/broken-plugin.mjs): p13-broken-plugin: 故意在导入期抛错
```

即：**装载器用「组合行 id + specifier」点名失败条目**（`failed to import|apply loader entry <id> (<specifier>): <msg>`），
而 `plugin(s) failed to load:` 那条友好行在这条路径上**根本不会出现**。照初版模式，诊断只能给出
「（未能定位到具体插件条目）」——正是要消灭的那种无用结论。据此改成按 id 精确反查，两种场景都能点名到条目。

### 2.3 「快速失败」必须包含「等 stdio 排空」

`child.exitCode !== null` **不等于** stdout/stderr 已读完：实测进程已退出时日志还在管道里，
诊断拿到的是**被截断的尾部**（友好错误行没了）。因此 `waitReady` 在发现进程已退出后先 `drainLogs`
再生成诊断。这条不写下来，下一次会再踩。

`drainLogs` 自己也踩了一次：初版只 `once('close')`，而调用它时 'close' **往往早已触发** →
每次失败白等满 3s 上限（实测 B 场景：退出于 5506ms、诊断抛出于 8695ms，差的 3.2s 全是白等）。
改为轮询两个流的 `readableEnded`（数据交付完成的真实信号）后即刻返回。

### 2.3b 入口表必须跟「谁挂的」一起传下去

要给出**入口路径**就得知道「这个包名对应哪个目录」。默认表只有三个 legion 包；夹具临时挂的自造包
不在其中 → 出现「能点名条目、但 `.entry === null`」的**半条结论**。现在
`diagnoseHostLogs` / `hostBootError` / `waitReady` 都可传 `packageDirs`，夹具直接提供
`fx.packageDirs` 与 `fx.diagnoseOpts(logText)`；并有 2 条回归断言（含「不传时确实给不出路径」的现状锁定）。

### 2.4 两个负向场景各自独立夹具

一度把两个坏条目挂在**同一个**宿主上，结果只有第一个失败被报出来（装载器在第一处即失败退出），
第二个条目的错误根本不出现 → 断言必然不稳。改为**一场景一夹具**，失败可归因。

### 2.5 诊断要能回答「404 是不是插件没挂上」

除启动期外，`routeMissDetail({ fx, child, res, path, plugin })` 把路由状态断言失败直接接到宿主日志上：
有装载失败就说「这才是 404 的原因」并附结论；**没有**就说「更像路由前缀/config 写错」。两个方向都不猜。

### 2.6 诚实边界：预检只覆盖「能静态判定」的一类

`preflightEntries` 只能发现**入口产物缺失/package.json 缺失或未声明入口**这类启动前可判定问题；
依赖缺失、导入期抛错、apply 抛错、服务未提供（pending）都只能在宿主日志里看到。因此预检与日志诊断
是两层，缺一不可——预检的结论也说清了「这是启动前判定」。

## 3. 验证证据

### 3.1 真实失败文本（逐字取自真实宿主输出，已写成回归断言）

场景 A（插件导入期抛错，`tests/p13-fixture/broken-plugin.mjs`）：

```
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to import loader entry p13-broken-file (file:///D:/project/DSH/legion/tests/p13-fixture/broken-plugin.mjs):
  p13-broken-plugin: 故意在导入期抛错（P4-2 负向夹具）
```

场景 B（入口产物缺失，复现 CI 现场）：

```
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to import loader entry p13-broken-missing (@dsh-external/dsh-p13-missing):
  Cannot find package '…\profiles\p13fixture\node_modules\@dsh-external\dsh-p13-missing\lib\index.js' imported from …
… code: 'ERR_MODULE_NOT_FOUND'
```

两条原文都已进 `host-diagnostics.test.mjs`（解析断言）与 `p13-host-injection.test.mjs`（真实宿主断言），
避免「解析器只在自己的自造样例上通过」。

### 3.2 诊断输出实测（场景 A）

```
宿主插件加载失败（已定位 1 处）：
  1. [import_threw] p13-broken-file（file:///D:/…/tests/p13-fixture/broken-plugin.mjs）
     入口：D:\project\DSH\legion\tests\p13-fixture\broken-plugin.mjs
     现象：p13-broken-plugin: 故意在导入期抛错（P4-2 负向夹具）
     处置：模块在**导入期**就抛错（不是 apply 期）→ 上方原始错误即插件自己的错误；若是依赖缺失，按 specifier 补依赖或修入口
  --- 宿主日志尾部（原始输出，未加工） ---
  | …（原始日志，保留可人工核对）
```

场景 B 的类型为 `missing_entry`，并带上缺失入口路径与处置建议。两类都能回答：
**哪个插件条目 / 哪个入口文件 / 原始错误是什么 / 该怎么办**。

### 3.3 两条失败路径的行为差异（实测）

| 场景 | `/__p13/ready` 是否曾答 200 | 退出 | 旧症状 | 新结论 |
| --- | --- | --- | --- | --- |
| A 导入期抛错 | **是**（实测：ready 一度 200，之后 audit 失败） | exit 1 | 客户端「路由缺失 / 60s 未就绪」都可能 | `import_threw` + id + 入口 + 插件错误 |
| B 入口缺失 | **不确定 —— 是竞态**（两次实测分别得到「答过 200」与「从未就绪」） | exit 1 | 客户端干等 45–60s「未就绪」 | `missing_entry` + id + 缺失路径 + 构建建议 |

**由此确定的两条判据（均已写成断言）**：

1. **不要用「未就绪」当判据**。场景 B 里 `/__p13/ready` 是否短暂成功取决于
   webserver 开始监听与「条目解析失败中止启动」的先后，实测**两种时序都出现过**；
   因此 B 的用例先等进程退出（<30s，实测约 4.7–5.5s），再断言 `waitReady` **立即**抛出 `HostBootError`
   （<10s，实测约 3s），不依赖这个窗口。
2. **可靠判据是「exit 1 + 日志诊断」**。B 的用例另有一条与进程时序完全无关的断言：
   仅凭抓到的原始日志调用 `diagnoseHostLogs`，也必须点名到 `p13-broken-missing` 并给出缺失入口路径。

场景 A 的「曾就绪」同样是实测事实，也让本轮用例设计改了方向：对 A 断言的是**日志诊断**而不是「未就绪」，
否则用例会因宿主短暂可用而随机红。补充：把「坏条目一起挂、只报第一个」的教训（§2.4）与本条合起来看，
可知**失败时序本身不该进断言**，能进断言的只有「进程最终 exit 1」与「日志可被诊断」。

> 另记一处实测修正：`drainLogs` 初版只 `once('close')`，但调用它时 'close' 往往**早已触发**，
> 于是每次失败都白等满 3s 上限（实测 B 的诊断耗时 8695ms − 退出时刻 5506ms ≈ 3.2s 全是白等）。
> 改为轮询两个流的 `readableEnded`（数据交付完成的真实信号）后即刻返回。

### 3.4 用例读数

| 运行 | 命令 | 结果 |
| --- | --- | --- |
| 纯函数单测（无 DSH） | `node --test tests/p13-fixture/host-diagnostics.test.mjs` | **24/24 PASS** |
| 主套件（含负向，真实宿主） | `node --test tests/p13-fixture/p13-host-injection.test.mjs` | **14/14 PASS**，31.4s（原 9 例约 10s） |
| 仅负向用例（独立性） | `node --test --test-name-pattern='负向' …` | **5/5 PASS**（不依赖主套件状态） |
| CI 套件组（2 文件） | `run-ci --only env,test,doc` | `p13-host-injection: exit=0 tests=38 pass=38 fail=0` |
| 健康宿主零误报对照 | 主套件 ⑦ | 真实宿主全量日志 → `problems == []`；预检 6 条行 0 问题 |

### 3.5 全量门禁

| 运行 | 阶段 | 结论 | 读数 |
| --- | --- | --- | --- |
| 分支 `w/host-diagnostics`（`.ci/p4-2-final3`，收尾修正后） | `env` / `test` / `doc` | **全 PASS** | 1812ms / 237524ms / 179ms；**39 套件 / 980 用例** |
| 分支首轮（`.ci/p4-2-final2`，收尾修正前） | `env` / `test` / `doc` | **全 PASS** | 1889ms / 254822ms / 314ms；39 套件 / 978 用例 |
| `main`（首次合并 `--no-ff` 后，`.ci/p4-2-main`） | `env` / `test` / `doc` | **全 PASS** | 3301ms / 254797ms / 456ms；39 套件 / 978 用例 |
| 各轮 `p13-host-injection` | `test` | PASS | 首轮 `36/36` → 收尾后 `38/38`（`exit=0 fail=0`） |
| `env` 阶段三项配置自检 | `scan` / `sync` / `check(good fixture)` | **全 PASS** | 见 `.ci/*/ci.log` 的 `config ...: PASS` 行 |

> 注：`node scripts/config/check.mjs`（**不带夹具**）在开发机上会因宿主会话里的 `TEAM_HUB_PORT=3080`
> 报 `hub_upstream_port_mismatch` —— 这是**按设计**的机器相关结果，门禁只认带 `--isolated-env` 的夹具检查
> （`run-ci` 的既有做法，本轮未改）。

### 3.6 与基线的差异（诚实登记）

- `p13-host-injection`：**9 → 14 例**，并新增同组纯函数文件 **24 例** → 套件组 **38 例**；
- 其余套件读数未变（`plugins` 185、`whiteboard` 158、`config` 36、`e2e-browser` 7 …）；
- **成本**：主套件由约 10s 升到约 31s（两次真实宿主启动用于负向场景）。
  取舍：负向验证是这层的唯一护栏（诊断最容易「写得漂亮但从没跑过」），20s 换「诊断被真实复现覆盖」值得；
  若将来 CI 时间紧张，可把两个负向 describe 合并为一次宿主启动，但会**牺牲失败可归因性**（见 §2.4）。

## 4. 诚实边界（本切片未覆盖）

1. **只覆盖本地包形态**：`@dsh-external/*` 与 `file://` 两类行。裸包名（`@deepseek-ai/dsh-*`）走
   `bareModuleBaseUrl` 解析，诊断不做入口文件存在性判断（`kind:'unknown'`，**不当作问题**）——
   避免假阳性。
2. **预检不是万能**：如上 §2.6，依赖缺失/导入抛错/apply 抛错/pending 只能从日志判定。
3. **日志匹配仍是字符串规则**：DSH 未来改动 `app-boot`/loader 的文案会让对应模式失效；
   缓解是「健康宿主零误报」对照 + 匹配不到时如实说「未能识别」，但**没有**与 harness 版本的契约测试。
4. **pending（服务未提供）只有解析单测，无真实宿主负向夹具**：构造一个 inject 无人提供的插件需要在
   fixture profile 里再造一个只提供部分服务的组合，本轮未做——该路径的日志形状取自 harness 源码
   （`assertEntriesActivated`），**未在真实宿主上复现过**，属未验证形状。
5. **`routeMissDetail` 只在断言消息里用了一次**（team-hub / board-plugin 两条路由），
   其余路由的 404 断言未逐一接线。
6. **失败套件仍要靠人看 `.ci/<run>/suites/*.log`**：诊断改善的是「p13 类失败」的可读性，
   不改变 CI 的失败聚合方式。
7. **场景 A 的时序（曾就绪 → exit 1）没有被断言锁死**：只断言了「最终 exit 1」与「日志可诊断」，
   中间那段短暂可用属于实测观察，未写成断言（写死会与宿主实现细节耦合）。

## 5. 复跑命令

```powershell
cd D:\project\DSH\legion
# 纯函数单测（无 DSH 也能跑）
node --test tests/p13-fixture/host-diagnostics.test.mjs

# 真实宿主（含负向场景）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node --test tests/p13-fixture/p13-host-injection.test.mjs

# 全量门禁（本切片相关阶段）
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci/p4-2-final
```

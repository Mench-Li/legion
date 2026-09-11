# 当前状态入口（STATUS）

> **这是判断「Legion 现在是什么状态」的唯一入口。** 全仓所有 `docs/**-evidence/`、`docs/G-*/`
> 目录内的文档都是**历史快照**（顶部带 `⚠️ 历史快照` banner），其中的测试数量、端口、命令与
> 结论只代表当时基线，**不得作为当前状态依据**。

**最近一次全量基线**：2026-09-11　`run-ci --only test` **PASS**；其中 `test` **59 套件 / 1617 用例**
—— 以本文件所在提交为准；证据 `.ci/prt-258/`
⚠️ `test` 阶段耗时**不是稳定值**：同一提交上空载约 **4.5 分钟**，而在 `gf001` 守护
（`scrum/daemon-gf001.json`，`intervalMs: 15000`）同时运行时实测 **31 分钟**（约 7 倍）。
**因此不要把耗时当回归基线**——只有套件数/用例数/通过与否可用于判定。

> ### ⚠️ 运行期状态：所有 AI 守护已停用（2026-09-11 起）
>
> `$DSH_HOME/profiles/web/cordis.patch.yml` 里 4 个 `dsh-scrum-worker` 实例
> —— `legion-scrum-worker`（scope=software）、`legion-scrum-worker-ozon`、
> `legion-scrum-worker-gf001`、`legion-mediator` —— 均已加 `disabled: true`。
>
> - **影响**：没有任何空间会自动认领或派工。看板与健康页的「守护」卡片会停在最后一次
>   sweep 的时间不再刷新 —— 这是「已停」的可见形态，**不是故障**。
> - **动阶段 2.5 之前必须先恢复至少一个空间守护**（阶段 2.5 含「设计伙伴真实任务」，
>   否则目标链会一直停在 `todo`）。恢复方式：去掉对应行的 `disabled`。
> - 停用理由逐行写在该 yml 每行上方（含「software 行 repoRoot 指向主仓库且 maxWorkers=2」
>   这一条）；改前备份 `cordis.patch.yml.bak-20260911`（该文件不在 git 下）。
> - 顺带修掉一处**既有**缺陷：静态守护行都没声明 `primaryScope`，而 `statusFileNames()`
>   把空值视为「我就是主 scope」，于是**每个**实例都去写 `daemon.json`
>   （看板/健康页唯一认的状态文件）并互相覆盖 —— 实测在 `software ↔ ozon` 之间
>   每 20~30s 跳变一次。gf001 的 15s 间隔原本最快、通常最后一个写，把这场竞争掩盖了；
>   停用 gf001 后立刻显形。现已在这两行显式声明 `primaryScope: 'software'`。
> - `gf001` 空间非终态任务数为 **0**；T-141 已由将军于 `14:00:32Z` 转 `canceled`
>   （产物从 patch 记录逐字恢复为 `53d9d15`，需求已由 `G-mtwxx7an-2` 交付，无需重做）。

> **本轮（阶段 7 Product Launcher：PRT-251 / 701~704）**：新增 `product/launcher/`
> （`launcher.mjs` / `supervisor.mjs` / `readiness.mjs` / `ports.mjs` / `allowlist.mjs` /
> `cli.mjs`）与套件 `product-launcher`（**57 例**，含 **3 例真实进程**）。
> 交付物是**一个能如实报告自己起不来的启动器**：
> `node product/launcher/cli.mjs --check` 现在会报出两个真实入口缺口并返回 4。
> 58→**59** 套件、1559→**1617** 用例。
>
> 三条值得单独记住的判断：
> **① 端口能连 ≠ 就绪。** 就绪判据加了**身份断言**（`/api/config` 返回的 `port` 必须
> 等于本次启动的端口），而这条断言立刻抓到一条真实缺陷：workbench 的 hub 上游默认指
> 8787，于是它去代理了**别的** hub 实例，而 `/hub/api/config` 照样返回 200——
> 没有身份断言就会报「就绪」，而用户看到的界面数据来自另一个数据库。
> **② 子进程环境不继承宿主。** 改为白名单（`allowlist.mjs`），替代 `services-plugin` 的
> `{ ...process.env }` 打底；后者让白板与 workbench 也拿到了模型密钥，
> 而 spec §6.7 要求密钥只进需要它的进程。
> **③ 启动期崩溃必须熔断。** `supervisor.mjs` 按**存活时长**决定退避是否归零，
> 连续快速失败则进 `circuit-open` 停手；原实现没有熔断，会以 30s 周期永远重启。
>
> ⚠️ **未交付**必须记住：**首次运行初始化**（PRT-706）、**托盘/日志轮转/诊断包**
> （PRT-708~710）、**`incompatible`/`upgrading` 两态无判据来源**（需 PRT-801 版本清单）、
> **退避参数尚未配置文件化**（PRT-253/259）、以及 **`services-plugin` 未替换**——
> 本批次交付的是替代实现，接线属 PRT-252。
> **完整产品当前起不来，且这是如实上报的**：`runtime.command` 未配置（PRT-011 路线 C 未落地）
> 与 `product/orchestrator/worker.mjs` 不存在（PRT-301）。`--include=` 是显式受限范围，
> 且受限范围的产品状态**永远不会是 `ready`**。详见
> `docs/superpowers/prt/PRT-251-product-launcher.md`。
>
> 上一批（阶段 2.5 产品层契约）：**① PRT-258 前三份契约**——
> 新增 `product/`（`paths.mjs`、`process-manifest.mjs`、`index.mjs`、`index.d.mts`）
> 与套件 `product-runtime`（**29 例**）：五进程清单与启动波次、per-user 目录布局不变量、
> 配置优先级合并（带 provenance）、「普通配置文件不得含明文密钥」写入门禁。
> **② PRT-505 密钥库**——新增 `security/secrets/` 与套件 `secret-store`（**9 例**，
> 含 **1 例真实 DPAPI 往返**）：断言集中在两类**不会抛异常**的失败上——
> 元数据接口把值/密文带出去，以及受保护后端不可用时**退化**为明文。
> 56→**58** 套件、1521→**1559** 用例。
> **密钥库目前没有任何生产调用方**（接线点是 `PRT-501` 与 `PRT-254`）；
> `MANIFEST_KNOWN_GAPS` 把两处入口缺口写成机器可读事实，
> 并由用例与**真实仓库**对账——缺口补上时用例会**变红**。
> 详见 `docs/superpowers/prt/PRT-258-product-contracts.md`、
> `docs/superpowers/prt/PRT-505-secret-store.md`，以及
> **`docs/superpowers/prt/PRT-PROGRESS.md`（全 145 项任务的唯一进度入口）**。
>
> 上一批（阶段 2 完成标准 PRT-210/211）：新增 `dsh-parity`（**36 例**）与
> `dsh-session-boundary`（**20 例**）。54→**56** 套件、1465→**1521** 用例。
> 阶段 2 的完成标准原文是「同一任务通过两条路径得到等价任务状态、结构化结果和产物，
> 且敏感信息不出现在输出中」——这两套用例就是它的可执行形式。
>
> **① 对拍（PRT-210）**：旧调用在 `plugins/src/index.ts:2219`，而 Global Constraints
> 规定阶段 3 之前不碰该文件，因此 `parity.mjs` **复刻**旧语义而非调用它。
> **复刻会腐化，而失去意义的对拍会静默通过** —— 所以配了漂移检测，实测 `drifted = false`。
> 差异按四类分开（violations / intended / improvements / bounded）：把有意变更混进违规
> 会让对拍恒红、最后被人关掉；当作不存在则是自欺。实测 violations = **0**。
> `intended` 里最典型的一条：**旧路径不做 schema 校验**，只看 `structured === undefined`，
> 于是「模型返回字段名拼错的对象」会被当作**完成**写进交付物；新路径判 `INVALID_RESULT`
> 是 PRT-204 的交付内容。用例把旧路径这个行为**钉住**，防止有人"顺手修好"复刻件
> 而让对拍退化成「拿新路径和新路径比」。
>
> **② 边界（PRT-211）**：DSH 有整套 continuable session 能力（15 条签名，逐字抄自运行中
> 的 Inspect 注册表），但阶段 2 的适配器是**一次性**的。最危险的不是「没实现」而是
> **看起来实现了**：契约的可选能力表里有 `session-resume`，照抄 DSH 上报能力就会对外
> 宣称支持恢复，而 `recover()` 只会说「继续等同一个 run」——**那是等待，不是恢复**。
> 按这个宣称实现「崩溃后接着跑」会得到**重跑**（副作用翻倍）。判据对**真实**适配器运行，
> 不是合成的 capability 对象。
>
> **证据分级**（写进了代码，不只在文档里）：接口面 `api-surface-verified`；
> continuable session 的**运行时行为 `behavior-unverified`** —— 没跑过就是没跑过。
>
> ⚠️ **`dsh-boundary` 仍是 3 文件 / 26 处**，与本批次之前完全一致。`parity.mjs` 里出现的
> `ctx.subagents` 全是注释/报错文案/测试夹具里的**字符串**（模块 `import` 的执行面包为 **0**），
> 一度让棘轮涨到 5 文件/33 处并因豁免前缀而**判 PASS**。已改为三段拼接并加用例自证贡献为 0：
> 豁免一旦开始被消耗，就再没有信号能区分「适配器真多依赖了 DSH」与「有人写了句注释」。
> `scripts/ci/dsh-boundary-baseline.json` **未被改动**。
>
> 上一批（阶段 2 强制面 PRT-212~215）：新增 `dsh-enforcement`（**34 例**）与
> `dsh-composition`（**28 例**），落在 `runtime/dsh-composition/`。52→**54** 套件、
> 1403→**1465** 用例。那一批交付的是**声明 + 原语 + 自检**，补丁层**尚未落盘应用**——
> 因为 DSH 的 profile 层是 `patchReload: 'live'`，写入会**立刻改变正在运行的 harness
> 的强制面**（包括当前会话自己）。详见 `docs/PRT-212-evidence/verify-evidence.md` §2 与 §5。
>
> ⚠️ 跑全量基线需设 `$env:DSH_CHECKOUT`，否则 `plugins`（185 例）与 `board-plugin`（37 例）
> 两组外部宿主回归会 **SKIP**（不伪绿），套件数会少 2、用例数会少 222 —— 这是有意设计。
>
> PRT-009 的六项「待采集」已结清四项（token 用量 / 端到端耗时 / 旧路径实测状态序列 /
> 人工介入率），靠的是**读取一次已经发生的真实执行**（受控隔离空间 `gf001`，目标 `G-mtwxx7an-2`），
> 不是重新跑一次。证据见 `docs/PRT-005-evidence/verify-evidence.md` 与
> `docs/PRT-009-evidence/verify-evidence.md` §3。**费用与峰值资源仍未采集，且原因已不是
> 「需要真实执行」**——两项各有不同的阻塞原因，见上述证据文档 §4。

> 说明：上句之前基线为 **P4-6** 之后的全量运行（含 `doc` 阶段），证据 `.ci/final-main4/`；
> 彼时 `test` 为 **48 套件 / 1315 用例**。
> 此前各基线：P4-3 之后、P4-2 之后为 **981 用例**、
> P4-1 之后 `test` 阶段为 **39 套件 / 950 用例**，P3-4 收尾为 **38 套件 / 943 用例**（详见下方 §2 基线表）；
> 各轮证据见 `docs/P4-6-evidence/verify-evidence.md`、`docs/P4-5-evidence/verify-evidence.md` §3、
> `docs/P4-3-evidence/verify-evidence.md` §3、`docs/P4-2-evidence/verify-evidence.md` §3.5、
> `docs/P4-1-evidence/verify-evidence.md` §3。

> ✅ **基线可单命令复现**（2026-09-10）：`test` 阶段此前会因 `notify-hub-smoke` 泄漏 hub 子进程
> 而**永不结束**（零输出、永久等待），P2-7 / P2-8 / P3-1 / P3-2 之后新增或扩充的套件只能用「逐套件单跑」
> 拼基线。现已修掉根因并由全量运行验证，表中数字全部来自**同一次** `--only test` 运行。
> 同一轮把此前未覆盖的**并发启动缺陷**也补齐了：双进程同时启动时的启动期迁移竞态、以及
> **WAL 切换不受 `busy_timeout` 保护**——二者都会让后到进程在模块加载期崩溃（宿主侧表现为
> `/team-hub` 路由缺失直到重启）。详见 `docs/CI-TEST-STAGE-evidence/verify-evidence.md`、
> `docs/DUAL-WRITE-RACE-evidence/verify-evidence.md`。

---

## 1. 当前形态与拓扑

| 层 | 组件 | 默认地址 | 说明 |
| --- | --- | --- | --- |
| 指挥台 | `workbench/` | `http://127.0.0.1:5173` | 空间/编队、目标、任务中心（单一 Scrum 泳道 + 将军视角过滤）、3D 总览、调度验收、对话/文件/浏览器、规范/技能/日历/通知 |
| 数据面 | `team-hub/server.mjs`（v2） | `http://127.0.0.1:8787` | **唯一业务实现**：SQLite（`team-hub/team.db`）、HTTP API、任务状态机、审计与 SSE 事件流 |
| 宿主外壳 | `team-hub/src/index.ts` | 宿主 `:3080` 的 `/team-hub` | 仅做该前缀路由注册 + env 转接，业务全部委托 `server.mjs`；与 8787 **同库** |
| 看板面板 | `board-plugin/` | 宿主 `:3080` 的 `/scrum-board` | DSH 会话内 iframe 面板；配置 `hubUrl` 或探测同宿主 `/team-hub` 后走 v2（hub 模式），否则退回本地文件模式 |
| 执行面 | `plugins/` | DSH 宿主内 | 扫单、认领、派工、隔离 worktree、自动交接、合入调解、对话回复、经验召回 |
| 生命周期 | `services-plugin/` | DSH Desktop 内 | 随 Desktop 自启停 8787 / 5173；**`:4820` v1 看板已退役**（不再托管） |
| v1 兼容面 | `scrum/` | — | 保留 v1 协议引擎与 `serve.mjs`（供契约测试与本地自托管）；**任务库 `tasks.json` 已归档**，日常入口不再使用 |
| 独立应用 | `whiteboard/` | `http://127.0.0.1:8080` | 零第三方依赖的多人实时协作白板，不属 Legion 核心三件套 |

关键约定：

- **单一数据池**：宿主 `/team-hub` 与独立进程 8787 共用 `team-hub/team.db`（`team-hub/src/index.ts` 默认
  `dbPath=''` → server.mjs 默认库）。因此两者是**多进程写同一库**：`audit.seq` 等分配必须在写事务内读库
  取号（回归见 `scripts/ci/dual-write-smoke.test.mjs`，已入 CI）。
- **单一事件流**：写操作一律经 `audit()` 落库并广播 SSE；`/api/events` 带 `id:` 行（seq）与信封字段
  `{seq, event, id, payload}`，支持 `Last-Event-ID` 断线续传（契约见 `docs/CONTRACT-V1V2.md`）。
- **部署链**：`~/.dsh/profiles/web/node_modules/@dsh-external/*` **必须是 junction（指向本仓源码目录）**，
  否则宿主会加载陈旧复制副本而不生效：
  ```powershell
  Get-Item ~/.dsh/profiles/web/node_modules/@dsh-external/* | Select-Object Name, LinkType   # 应全为 Junction
  ```
- **v1 独有动作**：`/api/reject`、`/api/promote`（v1 worktree git 语义）在 v2 hub 模式下返回 **501 降级指引**，
  请改用 `transition` + `comment`（v2 分支合入由 worker 完成）。
- **插件配置面**：三个 DSH 插件（`plugins/` 守护、`board-plugin/` 看板、`services-plugin/` 托管）在宿主进程内运行，
  **主配置来自宿主 composition**（`~/.dsh/profiles/web/cordis.patch.yml` 的 `config:` 块）；它们从**进程环境**
  读取的少数项（提示词预算、hub token 回落）已纳入统一配置体系（P3-4，`docs/CONFIG.md` §3.4–3.6）。
  改这些环境变量后需**重启宿主**才生效。

## 2. 测试基线与复跑方式

全量门禁（单命令）：

```powershell
cd D:\project\DSH\legion
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'   # 宿主面测试需要 DSH checkout
node scripts/ci/run-ci.mjs --only test --out .ci\<run-name>
```

产物：`.ci/<run-name>/ci.log`（全量输出）、`summary.json`（阶段结论）、`suites/<套件>.log`（失败套件的原始输出）。

**当前基线：59 套件 / 1617 用例，`--only test` 整体 PASS** —— 2026-09-11 实测
（阶段 7 Product Launcher：新增 `product-launcher`（**57 例**：PRT-251 / 701~704，含
**3 例真实进程**——真 team-hub + 真 workbench，临时端口 + 临时 DataDir）。
这一组的核心断言分三层：
**① 就绪判据**——「端口能连」不是就绪，`/api/config` 返回的 `port` 必须等于本次启动的端口；
身份不符要**只探一次就立刻失败**，因为「重试」这个动作本身在暗示它会变好。
这两条断言各自抓到一条真实缺陷（workbench 代理了别的 hub；期望值被字符串化后与 number
严格比较永远不成立，把类型问题伪装成安全问题）。
**② 子进程环境不继承宿主**——白名单（`allowlist.mjs`）替代 `{ ...process.env }` 打底，
并有断言钉住「哪些进程拿得到凭证键」。
**③ 退避按存活时长重置 + 连续快速失败熔断**——原实现没有熔断，
启动期崩溃的进程会以 30s 周期永远重启，症状是最像「什么都没发生」的那种故障。
前一批（阶段 2.5 产品层契约：新增 `product-runtime`（**29 例**：PRT-258 前三份契约）与
`secret-store`（**9 例**：PRT-505 密钥库 = 第四份契约，含真实 DPAPI 往返）。
前者的核心断言是**启动之前就能判定的事实**——依赖顺序、端口唯一、入口存在性、
目录不变量与配置优先级。其中「入口不存在」这一类还被做成与真实仓库的**对账**：
缺口补上时用例变红，逼文档与清单一起更新。
后者的核心断言是**六条出口各自脱敏**与**不退化**——元数据接口带出密文、
明文后端被当成真实密钥库，这两件事都不会报错，只会让「密钥受保护」这句话变成空话。
56→**58** 套件、1521→**1559** 用例）
`product/` 与 `security/` 均属 `mustBeZeroPrefixes`，本批次对执行面依赖为 **0 处**。
上一批（阶段 2 完成标准：新增 `dsh-parity`（**36 例**：PRT-210）与 `dsh-session-boundary`（**20 例**：PRT-211）。
对拍的核心不是「逐字节相同」而是**四类差异分开归因**——旧调用是复刻件，
复刻会腐化，而**失去意义的对拍会静默通过**，故漂移检测本身就是一条受测的判据。
边界的核心不是「没实现续接」而是**没有假装实现了**：`session-resume` 是可选能力，
照抄 DSH 上报能力就会宣称支持恢复，而 `recover()` 只是「继续等」——按这个宣称实现
「崩溃后接着跑」会得到**重跑**（副作用翻倍）。判据对真实适配器运行。
`dsh-boundary` 仍是 **3 文件 / 26 处**（本批次三个新文件贡献 **0**）。
54→**56** 套件、1465→**1521** 用例）。
上一批（阶段 2 强制面：新增 `dsh-enforcement`（**34 例**：PRT-212）与 `dsh-composition`（**28 例**：PRT-213~215）。
这一组的核心断言**几乎全是「不生效」**——因为强制面最危险的失效方式是
**看起来生效了**：组合行挂上了但没激活、`permission` 行在但 preset 表没被覆盖、
沙箱返回 `partial`（有未被管制的路径）、`confine` 原样返回输入 argv（没做任何包装）、
`denialSignatures` 为空（沙箱拒绝退化成普通失败）。五种都在返回值里长得像成功。
52→**54** 套件、1403→**1465** 用例。
`runtime/dsh-composition/` 对 DSH 的依赖为 **0 处**。
⚠️ 那一组交付的是**声明 + 原语 + 自检**；补丁层**尚未落盘应用**，
因此那些原语目前只被自己的用例驱动、**还没有生产调用方**，详见 `docs/PRT-212-evidence/verify-evidence.md` §2 与 §5）。
上一批收口：新增 `prt-usage`（**14 例**：PRT-009 会话用量提取——DSH 会话转录是
**多帧拼接 zstd**，整段一次性解压只得到第一帧（会话头），工具会「成功」报出 0 token；
用例把逐帧解码与 token 口径钉死）与 `prt-measure`（**8 例**：单价缺失时费用必须是 `null`
而不是 `0`——`0` 会让预算检查静默失效；以及「待采集清单必须随证据结清」）。
同时扩了三套既有套件：`prt-golden-flow` 18→**20**、`prt-old-path` 25→**30**、`prt-gf001` 23→**30**。
50→**52** 套件、~1385→**1403** 用例。
⚠️ 跑此基线必须设 `DSH_CHECKOUT`，否则 `plugins`（185）与 `board-plugin`（37）会 SKIP。
上一批收口：新增 `dsh-adapter`（**85 例**：PRT-201~209 的 DSH 适配器）。
全部用假宿主端口，覆盖真实 DSH 无法稳定复现的故障——`run.result` 永不结算、
abort 无效、畸形结构化输出、事件流中断。47→**48** 套件、1230→**1315** 用例。
该适配器**不 import 任何引擎包**（与 DSH 的耦合只在 `port.mjs` 的注入面），
因此 `dsh-boundary` 里适配层贡献为 **0 处**——是真正零耦合，不是靠
`adapterPrefixes` 豁免成 0。
上一批收口：新增 `prt-churn`（**13 例**：阶段 3 评审闸门的热点文件改动节奏探针，
含一条锁定「正确写法 vs 错误写法」差异的用例——`git log -n 40 -- <file>` 会先按
路径过滤再截断、恒返回 40，把「该开工」读成「不能开工」）；46→**47** 套件、
1217→**1230** 用例。
上一批 PRT-006：新增 `prt-backup`（**14 例**：三条备份路线 / 陈旧 WAL 危害 / 活写竞态 /
源库只读）；45→**46** 套件、1203→**1217** 用例。
上一批 PRT-001/003：新增 `prt-topology`（**20 例**：复用既有扫描器对账 / 越界写入判定 / 密钥聚合 /
数据产物分类 / diff 定位）；PRT-008/010：新增 `prt-composition`（**22 例**：patch 解析 /
失败要响 / 快照卫生 / 组合对账 / diff）；43→**45** 套件、1161→**1203** 用例（+42 = 20+22）。
再上一批 PRT-101~107 新增 `runtime-contract`（**62 例**）；PRT-004/007 新增 `prt-baseline`（**16 例**）
与 `prt-golden-flow`（**14 例**）；40→43 套件、1069→1161 用例。
本轮 PRT-002/PRT-108 交付 `dsh-boundary.test.mjs` **22 例**（记号识别 / 反误报 / 判定语义 / 棘轮真实性），
39→40 套件、1047→1069 用例，并让 `run-ci.mjs` 新增 **`boundary` 阶段**（紧随 `env`，纯静态秒级门禁）。
上一基线为 P4-6 之后的 `39 套件 / 1047 用例`（`.ci/final-main4/`））
（P4-6 之后：`dir-lock.test.mjs` 新增 **12 例**（7 纯函数 + 4 注册表联动 + 1 真实双进程），白板 199→**211**；
P4-5 之后：`audit-archive.test.mjs` 新增 **14 例**（10 纯函数 + 4 真实进程：重启/写入量量级），白板 185→**199**；
P4-4 之后：`static-serve` 6→**16 例**（新增导航/资源判定与缺失资源 404 契约）；
P4-3 之后：`e2e-browser` 7→**10 例**（新增连接未就绪窗口/切房间补发/单连接三条用例）、`whiteboard` 158→**185 例**
（新增 `pendingOps.test.mjs` 19 例队列/补发单测 + `notice.test.mjs` 8 例提示优先级单测）；
P4-3 与 P4-4 的全量门禁读数见 `docs/P4-3-evidence/verify-evidence.md` §3、`docs/P4-4-evidence/verify-evidence.md` §3；
P4-2 之后：`p13-host-injection` 9→14 例（含 5 例真实宿主负向诊断），并新增同组纯函数文件
`host-diagnostics.test.mjs` **25 例** → 该套件组 39 例；
P4-1 之后：新增 `e2e-browser` 真实浏览器 DOM 端到端 **7 例**；P3-4 之后：`plugins` 177→185、
`config` 28→36、`p13-host-injection` 7→8。
此前 `test` 阶段会因 `notify-hub-smoke` 泄漏子进程而**永不结束**，故长期只能用「逐套件单跑」拼出基线；
根因、修复与两处连带回归见 `docs/CI-TEST-STAGE-evidence/verify-evidence.md`）。
> `e2e-browser` 需要本机 Edge/Chrome：**找不到浏览器时整组 SKIP**（打印探测路径，不失败也不伪绿），
> 因此无浏览器的机器上它是「没跑」而不是「通过」。手册见 `docs/E2E.md`。

| 套件 | 用例 | 套件 | 用例 |
| --- | --- | --- | --- |
| chat | 42 | contracts | 56 |
| skills | 20 | v1v2-contract | 17 |
| permissions（F-02 权限内核与审批，3 文件） | 7 | team-hub-parity | 1 |
| calendar（P2-5 含重复展开/更新/冲突/关联） | 29 | dedupe | 9 |
| spaces | 5 | calendar-ui（P2-5 前端纯函数） | 12 |
| pipeline（SP-P0 空间流水线数据面） | 19 | chat-ui（P2-6 对话前端纯函数） | 8 |
| goal | 14 | notify（P2-4 含真实 hub SSE 断线重连） | 15 |
| rules | 7 | hub-event-stream（F-01 scope/游标/信封） | 5 |
| artifact | 16 | dual-write（P1-1 双进程写同库竞态 + 迁移竞态） | 4 |
| security | 6 | p13-host-injection（P1-3 真实宿主注入 + P3-4 配置摘要 + P4-2 导入失败诊断，2 文件） | 39 |
| read-auth（鉴权矩阵 + 回环开放，2 文件） | 14 | whiteboard（含 P3-1 治理端到端、P4-3 待发队列/提示优先级单测、P4-5 审计归档跨重启、P4-6 单实例目录锁与前端静态契约，18 文件） | 211 |
| files-api | 41 | plugins（含 P2-6 chat-context、SP-P0 space-pipeline、P3-4 配置） | 185 |
| files-p27 / files-ui（P2-7） | 36 / 19 | web-p28 / browser-ui（P2-8） | 21 / 21 |
| web | 24 | static-serve（静态托管 404/SPA 回退/穿越 + P4-4 导航与资源判定） | 16 |
| doc-render | 11 | board-plugin | 37 |
| skill-importer | 4 | scrum | 25 |
| hub-board / artifact-policy | 1 / 3 | config（P3-2 统一配置 + P3-4 插件族） | 36 |
| web-history（P2-8 抓取历史） | 1 | e2e-browser（P4-1 真实浏览器 DOM 端到端 + P4-3 重连补发，10 例） | 10 |

（上表**全部**为 `--only test` 单次全量运行的实测值；不再存在「未入全量基线」的套件。）

其他阶段：`--only doc`（文档新鲜度 + 历史 evidence banner 覆盖）、`--only boundary`（PRT-108 DSH 执行面边界棘轮，秒级）、`--only build|smoke|env|deps|stage`。
部署与回滚：`docs/DEPLOY.md`。现场（真实宿主）验收脚本：`scripts/live/p11-step2-verify.mjs`。

## 3. 文档地图（按可信度分层）

| 层级 | 文档 | 用途 |
| --- | --- | --- |
| **当前状态（权威）** | 本文件 `docs/STATUS.md` | 形态/拓扑/测试基线/约定；状态变化先改这里 |
| | `README.md` | 产品总览与快速上手 |
| | `docs/FEATURES.md` | 功能操作手册 |
| | `docs/DEPLOY.md` | 部署、验证、回滚 |
| | `docs/CONFIG.md` | 统一配置参考（优先级、三进程字段清单、校验命令、脱敏规则、已知边界） |
| | `docs/E2E.md` | 浏览器端到端手册（CDP 基座用法、写用例纪律、覆盖范围与未覆盖项） |
| | `docs/REMAINING-TASKS.md` | 未完成事项与优先级 |
| | `.ci/<run>/summary.json` + `ci.log` | 最近一次机器证据 |
| **契约（权威）** | `docs/CONTRACT-V1V2.md` | v1/v2 语义统一表（状态机、分页、SSE 信封） |
| | `runtime/contracts/`（`index.mjs` + `index.d.mts`） | **PRT Runtime Contract**：`RuntimeAdapter` 七方法、16 个标准错误码与重试分类、`RunRequest`/`RunEvent`（13 种）/终态契约、能力协商。**对 DSH 依赖为零**（`--only boundary` 强制）。用 `node --test runtime/contracts/*.test.mjs` 跑 |
| | `docs/REQUIREMENTS.md`、`docs/ORCHESTRATION-V3.md` | 需求与编排设计 |
| **迁移基线（可 diff）** | `docs/superpowers/prt/prt-007-baseline.json` | PRT-007 旧系统平台契约基线：85 路由 / 22 表 / 7 任务状态 / 20 迁移边。`node scripts/prt/baseline-snapshot.mjs --diff` 查漂移 |
| | `docs/superpowers/prt/prt-009-baseline.json` | PRT-009 成本/延迟/资源基线。**「已由 GF-001 真实执行采集」段的数值不在本文件里**，而是运行期从证据文件读出（抄一份进来就多一处会与源漂移的副本）。`node scripts/prt/baseline-measure.mjs --pending` 看六项各自结清状态 |
| | `docs/superpowers/prt/PRT-004-golden-flow.md` | 黄金流程 GF-001 定义（固定夹具哈希 `9d4d958c…`、3 段岗位交接、**五项**机器可判定验收）。§5 记录**对拍基准被实测修正**：字面预期序列只被 4/76 个任务走过，现行基准是「模态序列 + 可接受集合 + 已登记旁路」 |
| | `docs/superpowers/prt/prt-009-gf001-execution.json` | **GF-001 真实执行证据**（`node scripts/prt/gf001-run.mjs report --out=…`）：独立重算的验收结果、逐岗位 token 用量、端到端耗时，以及**模型分工未生效**的对拍偏差（声明 `pro`、实跑 `flash`） |
| | `docs/superpowers/prt/prt-009-execution-evidence.json` | 生产空间 `software` 的旧路径执行证据：状态序列 / 耗时分布 / 人工介入 / **可用性空窗**。数值全部来自 `audit` 表只读提取 |
| | `docs/superpowers/prt/prt-009-gf001-controlled-evidence.json` | 受控空间 `gf001` 的同一组指标（**旧路径**，含两次中止轮次），与上一行**不可互相冒充**——两者是不同总体 |
| | `docs/superpowers/prt/PRT-001-topology-inventory.md`、`prt-001-003-inventory.json` | PRT-001/003 拓扑与配置密钥清单。**4 个 path 字段默认落在安装目录内**（越界写入，PRT-505/257 输入）；仓库内明文凭证 0 处 |
| | `docs/superpowers/prt/PRT-010-dsh-composition-baseline.md`、`prt-010-composition-baseline.json` | PRT-008 术语冻结 + PRT-010 组合分层基线：`dsh-base` → `dsh-web-app` → 用户层，Legion 6 行 / 4 个 `file:` 依赖。`--diff` 无需 DSH_HOME |
| | `docs/superpowers/prt/PRT-011-dsh-distribution-decision.md` | PRT-011 分发形态**已裁决：路线 C**（依赖 `@deepseek-ai/dsh` npm 包 + Launcher 装进 DataDir）；DSH 已是 MIT npm 包，当前部署是 244 个 junction 的开发布局，checkout ≈ 1845 MB |
| | `docs/PRT-006-evidence/backup-restore-evidence.md` | PRT-006 备份/恢复验证：只复制 `.db` **静默丢 253 条 audit**；陈旧 `-wal` 混用**被重放且 integrity_check 仍 ok**。恢复步骤与发布检查单已回写 `docs/DEPLOY.md` §6.1 |
| | `docs/PRT-005-evidence/verify-evidence.md` | PRT-005 旧路径执行状态证据：状态序列（**含「声明的状态机不是被强制执行的状态机」——`advanceTask` 绕过 `TRANSITIONS` 且不需将军**）、耗时、人工介入、**可用性空窗**（旧路径没有独立守护：两个独立空间同时断流 1.98h，无任何外部告警） |
| | `docs/PRT-009-evidence/verify-evidence.md` | PRT-009 成本/延迟/资源基线证据：逐项口径、结清状态、费用模型（**单价缺失返回 `null` 而非 `0`**）与未覆盖项 |
| | `runtime/dsh-composition/` | **阶段 2 强制面**（PRT-212~215）：补丁层声明（`patch-layer.mjs` + 生成物 `legion-host.patch.yml`）、三个强制点原语与 canonical operation 哈希（`enforcement.mjs`）、沙箱实际管制探测与启动自检（`selfcheck.mjs`）。**不 import 任何 DSH 包**——对 DSH 依赖 0 处，棘轮豁免存在但未使用 |
| | `docs/PRT-212-evidence/verify-evidence.md` | 强制面证据：从**运行中** harness 实测读到的强制点（含 `ConfinedArgv.enforcement: full\|partial` 这条判据的落点）、四类「看起来生效了」的隐蔽失效、以及**刻意未落盘**的理由（profile 层 `patchReload: live`，写入会立刻改变当前进程的强制面） |
| | `runtime/adapters/dsh/parity.mjs` | **阶段 2 完成标准**（PRT-210）：旧调用语义复刻 + 漂移检测 + 四类差异归因（violations/intended/improvements/bounded）。不 import 任何引擎包 |
| | `runtime/adapters/dsh/session-boundary.mjs` | PRT-211 continuable session 边界：15 条真实签名（运行中注册表）、五面归属划分、`session-resume` 未兑现能力的拦截判据、`resume-same-run` **是等待不是恢复**的归类。含 `EVIDENCE_LEVEL` 证据分级 |
| | `docs/PRT-210-evidence/verify-evidence.md` | 阶段 2 完成标准证据：对拍的四类归因与漂移检测实测、continuable session 的接口面结论与**行为未验证**的显式声明、以及棘轮假阳性的处置 |
| **设计规格** | `docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md` | Product Runtime 设计（17 节 + **附录 A 阶段 0～1 已落地指针**）。附录只回填落地位置，不改设计 |
| **计划与闸门** | `docs/superpowers/plans/2026-09-11-prt-phase0-1.md` | 阶段 0～1 计划与逐任务结论。含**阶段 3 评审闸门**：热点文件最近 40 个提交仅触及 1/2 次（历史峰值 9/7）→ 已降温 |
| **历史快照（非当前依据）** | `docs/**-evidence/**`、`docs/G-*/**` | 各任务/目标的当时验证记录，顶部均有 `⚠️ 历史快照` banner（含生成日期与基线 commit）；含 `docs/PRT-005-evidence/`、`docs/PRT-009-evidence/`、`docs/PRT-210-evidence/`、`docs/PRT-212-evidence/` |
| **历史交付文档** | `docs/TEST_REPORT.md`、`docs/TEST_CASES.md`、`docs/TASK_BREAKDOWN.md`、`docs/RESEARCH.md`、`docs/P0-CONFIRMATION.md` 等 | 立项期交付物，测试数字以本文件 §2 为准 |
| **运维叙事（过程）** | `docs/P1-LIVE-ROLLOUT.md`、`docs/P2-GOALDOCS-LIVE.md`、`docs/P3-PROD-ROLLOUT.md`、`docs/P1-1-DECISION.md`、`docs/P1-1-step2-runbook.md` | 当时决策与现场步骤；结论已并入本文件 |

## 4. 已知限制（诚实登记）

1. Workbench 部分面板为功能基础版（通知分类/批量已读、日历冲突检测、文件批量与续传、
   对话真实模型通道 E2E 等仍在 `docs/REMAINING-TASKS.md` 待办；浏览器助手的缓存/正文提取/截图已按 P2-8 增强）。
2. 白板为**单实例多房间**模型（P3-1 已落地房间隔离/权限/限流/指标审计）；
   **不承诺横向扩展**，多实例共享存储未实现（ADR-0008 记录了被否理由与转 v2 触发条件）。
   **P4-6 已把该约束从注释升级为可执行守卫**：房间目录独占锁 `.whiteboard.lock`，
   第二个实例指向同一目录**启动即失败**并给出处置建议（实测旧行为是**静默数据分裂**：
   两边视图分别停在 2 与 3 而真值 4，两侧日志无任何错误）；陈旧锁可自动接管，不会把服务锁死。
   锁是**建议性**的（只防误操作），且不覆盖审计目录；验证见 `docs/P4-6-evidence/verify-evidence.md`。
3. 配置面已统一（P3-2 + P3-4）：**6 个配置面**共用统一配置引擎
   （`packages/shared/src/config.mjs`，优先级 **CLI > env > 默认值**）——三个活跃进程
   （team-hub / workbench / whiteboard）与三个 DSH 插件族（plugins / board-plugin / services-plugin），
   共 64 个已声明字段；启动打印**脱敏**摘要；`node scripts/config/check.mjs` 提供校验、12 条跨进程
   一致性规则与进程内 schema 规则（含「services-plugin 会覆盖子进程端口」这类只有把两边摆在一起才看得出的结论），
   CI env 阶段跑 scan/sync/check 三项自检。**已知边界**：插件的主配置面仍是宿主 composition
   （`cordis.patch.yml` 的 `config:` 块，`check.mjs` 看不到）；`board-plugin` / `services-plugin` 只做声明与
   校验、未改运行时；配置**不支持热更新**（启动时解析一次，改 env 需重启宿主）；`check.mjs` 只做配置面一致性、
   **不发网络请求**；白板因 Docker 构建上下文隔离而使用根引擎的**同步副本**（逐字节校验）。
   插件族的非法值走「大声降级」（回退默认 + 打印错误行），不退出宿主。详见 `docs/CONFIG.md`。
4. board-plugin 的 hub 动态面板为轻量自渲染（覆盖看板主操作），未复刻旧静态页全部视觉细节；
   无 hub 时退回本地文件模式，此时不渲染 v1 静态产物。
5. 通知中心（P2-4）已具备分类/优先级/批量已读/统一跳转/断线补齐；**已读状态仅存本机
   localStorage**（跨浏览器与跨标签页不同步，服务端已读持久化未做——按 R-15 v1 取舍）。
   Node 侧 SSE 回归用的是最小 EventSource 实现（不覆盖浏览器全部行为：无 `retry:` 指令、
   无超时关闭），浏览器行为以现场为准。
6. 生产宿主 `/team-hub` 与 8787 双进程写同库：已通过事务内取号保证一致性，但两进程的
   `audit` 广播各自独立（事件流不跨进程合并）；消费方以 SSE 连接的那个实例为准。
7. 日程日历（P2-5）：**时间为字面本地时间，不做时区换算**（跨时区协作需人工换算）；
   重复仅支持简单规则（日/周/月 + 间隔 + 结束条件 + 例外日），不支持「单次修改」与按星期几的复杂规则；
   冲突检测只提示不阻断；单窗展开上限 400 实例（超出抛错，不静默截断）。
8. 对话中心（P2-6）：`/api/events` 带 `Last-Event-ID` 时只回放增量，**不带**该头时只回放最近 30 条
   （有界）→ 断线恢复倚赖「SSE 重连回调 + 本地 seq 水位缺口判据」两层叠加，仅靠服务端续传不保证完整；
   标签页被挂起（定时器冻结）时补齐延后到唤醒；UI 验证为判定层（DOM 文案无自动断言）；
   附件内容按 UTF-8 文本注入，二进制附件未支持。
9. 文件中心（P2-7）：批量下载**逐个触发不打包 zip**；分片上传为**顺序**语义（offset 必须等于服务端已收字节），
   不做并发分片与逐片哈希（仅校总长度）；搜索只匹配**文件名**（不检索内容）；「移动到」目标目录须已存在；
   git 面板**只读**（无 stage/commit/checkout，`ahead/behind` 依赖本地 upstream 引用，无 upstream 时为 null）；
   `.dsh-uploads` 上传会话**无自动 TTL 回收**（完成/中止会清理，进程被强杀可能残留，需管理端按需清理）；
   前端验证为判定层（`workbench/scripts/files-ui.test.mjs` 19 例，不引入 jsdom/react 渲染断言）。
10. 浏览器助手（P2-8）：抓取**缓存与配额计数都在进程内**（重启清零，非持久账目；缓存 TTL 默认 5 分钟）；
    截图**不自带浏览器**（探测本机 Edge/Chrome，未装则不可用；`DSH_WEB_SHOT_ENABLE=1` 才启用，默认关闭；
    无等待元素/交互脚本，自动化测试仅用假浏览器脚本验证服务端路径，**未在 CI 产出真实 PNG**）；
    正文抽取为**启发式**（样板词表 + 容器打分，无 DOM 语义理解，强 JS 渲染页仍只能报 `empty_content`）；
    空间抓取历史按空间**上限 200 条**裁剪（超出丢最旧，无分页游标），且依赖 team-hub v2 运行（否则界面明确报不可用）；
    限流默认值可用 `DSH_WEB_QUOTA_*` 调整，为**单进程**语义（无分布式限流）。
    前端验证为判定层（`workbench/scripts/browser-ui.test.mjs` 21 例）。
11. 白板治理（P3-1；**审计留存已由 P4-5 补齐**）：`/metrics` 的**运行计数器**仍为进程内（重启归零，这是刻意设计）；
    审计 JSONL 按大小轮转保留 3 份。P4-5 起**审计归档可读、可跨重启回溯**：
    `GET /api/rooms/<id>/audit?source=process|archive|all`（默认 `process` 保持 P3-1 语义不变），
    每条记录带跨重启单调递增的 `auditSeq`（启动时从归档尾部播种），响应永远附 `retention`
    （文件数/字节/**最早与最新时间**/跨重启轮转次数/`historyTruncated`），`/metrics` 同样暴露 `audit.retention`；
    进程内为空而磁盘有历史时会给出指向 `source=archive` 的 `hint`。同时补上两处**声明了却从未写入**的审计类型
    （`ops`、`presence`）——此前审计只记「谁来了/谁被拒」，恰恰缺「谁画了什么」，归档也不完整。
    验证见 `docs/P4-5-evidence/verify-evidence.md`（含真实进程**真重启**后查回历史的端到端读数）。
    **已知边界**：仍无**长期**归档（保留 3 份即滚出，`historyTruncated` 只报事实不做归档扩张）；
    `archive` 查询返回的是**最近的** N 条并标 `truncated`（不是全档精确总数）；轮转以单文件字节为界，
    **不按时间/天数**保留；append-only JSONL 中若半行后又被追加完整行会被拼成一行（记入 `malformed`，不可恢复）。
    角色只有 `rw`/`ro` 两档（无按元素/区域的细粒度权限，无操作级回放）；
    单 IP 连接上限为**粗粒度**防滥用且**不信任** `X-Forwarded-For`（反代 + 大量同出口用户的部署需在边界
    做真实客户端识别，否则同一出口会共享该额度）；房间空闲关闭依赖 tick 心跳；
    房间与单房间连接上限默认 50、全局 200（对齐 soak 承诺，`WB_*` 可调）；
    **多实例共享存储未实现**（ADR-0008 记录了被否理由与转 v2 触发条件）；
    **单实例约束已由目录锁强制**（P4-6，`dir-lock.test.mjs` 12 例：含真实双进程拒绝与陈旧锁接管）；
    前端房间/角色逻辑为判定层测试（`whiteboard/packages/shared/test/room.test.mjs` 12 例）+
    前端静态契约（`whiteboard/apps/web/test/ui-contract.test.mjs` 6 例：DOM id 与共享模块接线、
    CSS 类与只读态类名一致），**并有真实浏览器 DOM 端到端**（P4-1：`tests/browser/whiteboard-ui.e2e.test.mjs`
    7 例——进入房间的标签/标题/角色同步、真实绘制落库 + canvas 像素、只读态 UI 降级与零写入、
    切房间与 URL/token 语义、非法房间号提示、主路径无页面异常、限流提示）；
    真实文件型房间路径由临时生产路径脚本验证（18/18，未入库）。
    浏览器 E2E 的**覆盖边界**见 `docs/E2E.md` §6（workbench / board-plugin 前端、视觉回归、
    多浏览器矩阵、网络故障注入仍无自动化）；候选 #10「重连窗口内的绘制被静默丢弃」已于同日修复（P4-3）。
12. 静态托管（**P4-4 已修**）：`workbench/scripts/serve.mjs` 在产物缺失时返回 404 + 指引（不再断流），
    并且**按扩展名区分导航与静态资源**：只有导航请求（无扩展名 / `.html` / `Accept: text/html`）才回退
    SPA 入口，缺失的 `/assets/*.js`、`/data/*.json`、`/favicon.ico` 等现在回 **404 + 可读 JSON 体**
    （旧行为是 200 + 整页 HTML，前端只会看到「JSON 解析失败」/「MIME 类型不对」）。
    验证与边界见 `docs/P4-4-evidence/verify-evidence.md`（含真实浏览器 A/B 读数）。
    **已知边界**：浏览器加载缺失**模块脚本**时控制台仍报 MIME 类错误（404 体是 JSON，非 JS）——
    可诊断性来自诚实的 404 状态码；未覆盖 `HEAD`/`Range`/条件请求；
    `serve.mjs` 静态分支仍不分方法（与改动前一致）。静态根可用 `DSH_WORKBENCH_ROOT` 覆盖（测试用）。
13. 宿主插件诊断（P4-2）：`p13` 夹具现在把「插件条目导入失败」翻成点名到条目的结论
    （启动前预检 + 日志解析 + 路由 404 归因，见 `docs/P4-2-evidence/verify-evidence.md`），
    **已知边界**：① 只覆盖本地包行（`@dsh-external/*` 与 `file://`），裸包名行不判入口存在性（避免假阳性）；
    ② `pending`（服务无人提供）的日志形状取自 harness 源码、**未在真实宿主复现**；
    ③ 解析依赖 DSH `app-boot`/loader 的**文案**（`failed to import|apply loader entry <id> (<specifier>)`），
    harness 改文案会让模式失效——缓解是「健康宿主零误报」对照 + 匹配不到时如实报「未能识别」；
    ④ 诊断改善的是失败**可读性**，CI 的失败聚合方式不变。
14. 白板断线窗口补发（P4-3）：连接未就绪时的绘制现在**入队 + 提示 + 重连后补发**
    （`whiteboard/packages/shared/src/pendingOps.mjs`，见 `docs/P4-3-evidence/verify-evidence.md`），
    **已知边界**：① 入队 op 沿用原 stamp，并发修改按 LWW 取舍（操作送达了，冲突值可能保留对端）；
    ② 队列有界 **500** op，极端离线仍丢**最旧**（提示里报出丢弃条数）；
    ③ 「已写进 socket、未到服务端」的在途 op 仍会丢——需要 ack/重传协议才能解决，本轮不做；
    ④ 真实网络故障（TCP 半开）下前端拿不到 `onclose`，该场景未验证（E2E 用「真实关闭连接」制造窗口）；
    ⑤ 补发**只把真正写进 socket 的部分**算发出去（`sendInChunks`），未发出的回队重试（§2.8）；
    ⑥ 切房间不再连出第二个 socket（`connect()` 的陈旧连接守卫，§2.9）——旧行为是「3 个 socket、2 个同时 OPEN」；
    ⑦ 提示条按**优先级**占用（治理类 > 连接状态类，见 `whiteboard/packages/shared/src/notice.mjs`）：
    高优先级提示在场时，「已补发」这类过程信息不显示（信息被**延迟**，不是丢失）——
    该规则来自本轮自造的一次回归（队列提示顶掉了「操作过于频繁」，被既有 e2e 限流用例抓到）。

## 5. 维护约定

- **状态变化**（拓扑、端口、数据池、测试基线、已知限制）→ 更新本文件，并同步 `README.md` 的必要部分。
- **新增 evidence**：在 `docs/` 下建立 `*-evidence/` 目录后运行
  `node scripts/ci/evidence-banner.mjs` 补 banner（幂等）；CI `doc` 阶段会校验覆盖完整性
  （`node scripts/ci/evidence-banner.mjs --check`，由 `check-docs.mjs` 统一驱动）。
- **不要**把历史快照的结论回填进本文件；本文件只写当前可复现的事实与命令。

# 当前状态入口（STATUS）

> **这是判断「Legion 现在是什么状态」的唯一入口。** 全仓所有 `docs/**-evidence/`、`docs/G-*/`
> 目录内的文档都是**历史快照**（顶部带 `⚠️ 历史快照` banner），其中的测试数量、端口、命令与
> 结论只代表当时基线，**不得作为当前状态依据**。

**最近一次全量基线**：2026-09-10　`run-ci --only env,test,doc` **全 PASS**；其中 `test` **39 套件 / 1035 用例**
（约 4 分钟）—— 以本文件所在提交为准

> 说明：上句记录 P4-3 之后的全量运行（含 `doc` 阶段）。P4-2 之后为 **981 用例**、
> P4-1 之后 `test` 阶段为 **39 套件 / 950 用例**，P3-4 收尾为 **38 套件 / 943 用例**（详见下方 §2 基线表）；
> 各轮证据见 `docs/P4-3-evidence/verify-evidence.md` §3、`docs/P4-2-evidence/verify-evidence.md` §3.5、
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

**当前基线：39 套件 / 1035 用例，`--only test` 整体 PASS** —— 2026-09-10 实测
（P4-5 之后：`audit-archive.test.mjs` 新增 **14 例**（10 纯函数 + 4 真实进程：重启/写入量量级），白板 185→**199**；
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
| security | 6 | p13-host-injection（P1-3 真实宿主注入 + P3-4 配置摘要 + P4-2 导入失败诊断，2 文件） | 38 |
| read-auth（鉴权矩阵 + 回环开放，2 文件） | 14 | whiteboard（含 P3-1 治理端到端、P4-3 待发队列/提示优先级单测、P4-5 审计归档跨重启与前端静态契约，17 文件） | 199 |
| files-api | 41 | plugins（含 P2-6 chat-context、SP-P0 space-pipeline、P3-4 配置） | 185 |
| files-p27 / files-ui（P2-7） | 36 / 19 | web-p28 / browser-ui（P2-8） | 21 / 21 |
| web | 24 | static-serve（静态托管 404/SPA 回退/穿越 + P4-4 导航与资源判定） | 16 |
| doc-render | 11 | board-plugin | 37 |
| skill-importer | 4 | scrum | 25 |
| hub-board / artifact-policy | 1 / 3 | config（P3-2 统一配置 + P3-4 插件族） | 36 |
| web-history（P2-8 抓取历史） | 1 | e2e-browser（P4-1 真实浏览器 DOM 端到端 + P4-3 重连补发，10 例） | 10 |

（上表**全部**为 `--only test` 单次全量运行的实测值；不再存在「未入全量基线」的套件。）

其他阶段：`--only doc`（文档新鲜度 + 历史 evidence banner 覆盖）、`--only build|smoke|env|deps|stage`。
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
| | `docs/REQUIREMENTS.md`、`docs/ORCHESTRATION-V3.md` | 需求与编排设计 |
| **历史快照（非当前依据）** | `docs/**-evidence/**`、`docs/G-*/**` | 各任务/目标的当时验证记录，顶部均有 `⚠️ 历史快照` banner（含生成日期与基线 commit） |
| **历史交付文档** | `docs/TEST_REPORT.md`、`docs/TEST_CASES.md`、`docs/TASK_BREAKDOWN.md`、`docs/RESEARCH.md`、`docs/P0-CONFIRMATION.md` 等 | 立项期交付物，测试数字以本文件 §2 为准 |
| **运维叙事（过程）** | `docs/P1-LIVE-ROLLOUT.md`、`docs/P2-GOALDOCS-LIVE.md`、`docs/P3-PROD-ROLLOUT.md`、`docs/P1-1-DECISION.md`、`docs/P1-1-step2-runbook.md` | 当时决策与现场步骤；结论已并入本文件 |

## 4. 已知限制（诚实登记）

1. Workbench 部分面板为功能基础版（通知分类/批量已读、日历冲突检测、文件批量与续传、
   对话真实模型通道 E2E 等仍在 `docs/REMAINING-TASKS.md` 待办；浏览器助手的缓存/正文提取/截图已按 P2-8 增强）。
2. 白板为**单实例多房间**模型（P3-1 已落地房间隔离/权限/限流/指标审计）；
   **不承诺横向扩展**，多实例共享存储未实现（ADR-0008 记录了被否理由与转 v2 触发条件）。
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

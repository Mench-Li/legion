# T-076 测试用例 / 验收测试：第二批（三中心收尾 · 平台剩余功能）

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-076（分支 w/T-076 独立 worktree）
> 上游：T-073 需求澄清（docs/REQUIREMENTS.md，唯一权威需求基线，含 R-A1..R-C3 与 I-1..I-10）→ T-074 方案搜索（docs/RESEARCH.md：决策域 J1~J9 + 闸门 G-8..G-14）→ T-075 任务拆解（docs/TASK_BREAKDOWN.md：**「## slices」8 个切片 S1~S8**，本用例唯一拆解基准）
> 下游：守护按 TASK_BREAKDOWN 注册 coder_Si → tester_Si 微链；coder 按本文档「自动化落点 / 附录 B」把 P0/P1 用例落成契约测试与守卫断言；tester 按 §2 分层逐条执行并把结果写入 docs/TEST_REPORT.md（S8）
> 依据：TASK_BREAKDOWN §1 机器验收行（每片「验收标准」与「测试锚点」逐条）、REQUIREMENTS §4.2 不变量 / §5 需求验收口径、RESEARCH §11.2 闸门 G-8..G-14、LEGION.md 纪律与 T-076 阶段验收（覆盖 主路径+边界+异常；每条含 前置/步骤/期望；通过判据明确；关键规则正反向成对）。
>
> **取代声明**：本文档取代旧流水线产物 docs/TEST_CASES.md（T-039 版 = 第一批「三中心从零建造」用例；第一批 S1~S8 已交付合入 main，其 TC 编号与本文档**不同批、不同语义**）。旧版经 git 历史可回溯（`git show 6e775e3:docs/TEST_CASES.md`，或 `git log --follow docs/TEST_CASES.md`）。历史测试文件头部注释中的「TC-S1-01..18」等指第一批编号，属历史快照，不再与本文档对齐。

## 0. 结论速览

- 交付单件：本文档（+ 证据目录 docs/T076-evidence/，含机器复核 02-doc-machcheck.txt）。共 **84 条用例**（S1 13 / S2 12 / S3 8 / S4 10 / S5 12 / S6 10 / S7 9 / S8 10；🟢正常 37 / 🟡边界 26 / 🔴异常 21；P0=57 为切片验收门槛、P1=23、P2=4），每条含 前置条件 / 操作步骤 / 期望结果与通过判据；计数/ID 唯一性/表结构/矩阵引用已经一次性 Node 脚本复核（§9 附录 C + docs/T076-evidence/02-doc-machcheck.txt），无重复 ID、无引用缺失。
- 验收标准用例化：TASK_BREAKDOWN §1 机器验收行（S1~S8）每条 + REQUIREMENTS R-A1..R-A7 / R-B1..R-B3 验收口径逐条映射到用例（§6 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果」列，无黑盒。既有「必须修改」缺陷（F1/F2/A3/A4/A5/A6）均有**回归优先**的 P0 用例（§4.0 缺陷→切片→用例索引）。
- 关键业务规则正反向成对（§5）：.git 任一层级防护、畸形输入进程存活、抓取审计留痕、body stall/整链超时归类、错误码枚举表收口、ChatView 会话/空间写回守卫、浏览器错误态（不落正文分支）、calendar scope 隔离与入参校验、delete/覆盖类二次确认、通知 action 白名单与已读不写 audit，均给正向 + 反向用例。
- 测试代码落点：S1→`workbench/scripts/files-api.test.mjs`、S2→`workbench/scripts/web.test.mjs` + `workbench/.gitignore`、S3→ChatView（评审 + L2；若抽纯函数则新增 node --test）、S4→BrowserView 合入复核（评审 + L2）、S5→`team-hub/calendar.test.mjs`（新增）+ L1 curl、S6/S7→L2 浏览器清单 + 评审、S8→全量套件 + `docs/TEST_REPORT.md`。骨架与代码片段见附录 B。**本阶段不新增/不预写切片域内可执行测试文件**（原因同 T-039：S1~S7 目标代码未实现，预写必全红；测试文件所有权在 TASK_BREAKDOWN 中已划给各 coder），仅交付用例 + 可照抄的骨架。
- 现存基线（本阶段实测跑绿，见 docs/T076-evidence/01-baselines.txt）：files-api.test.mjs 34/34、web.test.mjs 12/12、chat.test.mjs 13/13、skills.test.mjs 12/12、contracts.test.mjs 56/56 —— 全部 exit 0（node v24.19.0 直跑等效）。
- 环境事实（写进各用例执行说明）：本 worktree **无 node_modules/dist**（不随 git 分发），tsc/vite build 需宿主/CI 或 junction（R-18 按「环境受限 + 复现步骤」记录，不冒充通过）；契约测试零第三方依赖（node 内置 + 相对 import），沙箱内 `node <file>` 可直跑（与 `node --test <file>` 等效，T-039 已验证）。
- ⚖️ G-13 门：S5/S6/S7（日程日历 / 通知中心）默认纳入但待将军 OQ-3 裁决；若裁定不纳入，删 §4 中 S5/S6/S7 三节及 §5/§6 对应行即可（守护按 TASK_BREAKDOWN 当前内容注册，S8 不受影响）。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入与假设

| 输入 | 说明 |
| --- | --- |
| REQUIREMENTS.md §5 | R-A1..R-A7（三中心收尾）/ R-B1..R-B3（平台剩余）/ I-1..I-10（不变量）—— 验收口径逐条可测试 |
| TASK_BREAKDOWN.md §1 | S1~S8 机器验收行（含命令、期望、DoD）+ §3 测试锚点 —— 本用例逐条翻译对象 |
| RESEARCH.md §11.2 | 闸门 G-8..G-14 默认值（本用例按默认展开；翻转只改对应用例期望） |
| 证据 | T-058/T-059/T-062/T-060 报告（F1/F2/A3/A4/A5 复现与归属）、T-054/T-056 review、w/T-051（a524951，S4 合入源） |
| 假设 H-1 | 200-envelope 口径（OQ-7 默认）：业务错误经 HTTP 200 + body {ok:false, code, error} 表达（web 面现状）；文件面错误按 httpErr 4xx（现状）。web.test 断言以 body code 为准 |
| 假设 H-2 | S5 日历删除端点：R-B1 验收 2 要求「可创建/查看/删除」最小闭环而 TASK_BREAKDOWN S5 机器行未列删除端点 → 判为拆解遗漏（实现归属 S5 后端域，文件仍为 team-hub/server.mjs）；本用例按 I-3/I-6 语义定契约：`POST /api/calendar/events/delete { id, confirm:'yes', scope?, by }`（或等价方法），缺 confirm 拒、scope 越权拒、audit action=calendar:delete + SSE 广播。将军/coder 如给不同契约仅改本组用例请求形状，断言语义不变 |
| 假设 H-3 | .git 防护口径（G-8/R-14 tester 定）：任一层级段 .git 即拒（**大小写不敏感**比较），realpath 复检覆盖符号链接/挂载点绕入；list 根/子目录对 .git 目录**隐藏条目**（现状已按点文件隐藏），但目录本身以 isRepo=true 呈现不受影响 |
| 假设 H-4 | 错误码枚举（G-11/R-13）：后端实际只发出集合 ⊆ 枚举常量表；BrowserView errorText/isErrorResult 覆盖**枚举表全集**（含后端不发出的 dns_error 等，允许前端映射超集但不得漏码） |
| 假设 H-5 | 审计容量轮转（R-17）：web 审计 JSONL 上限默认 1 MiB（⚖️ 可配 env，如 DSH_WEB_AUDIT_MAX_KB），超限轮转归档 data/web-audit.<ts>.jsonl 或截断重开，总占用受控 |
| 假设 H-6 | 会话/空间守卫（R-A5）：以「发起时快照（convId/scope）与 activeRef.current 比对」判据；不匹配 = 仅复位 loading/sending 等标志 + 丢弃本次合并，**不**清空/改写当前视图数据 |

### 1.2 决策闸门默认值（G-8..G-14，本用例判定依据）

| 闸门 | 默认（本用例按此展开） | 对立主张 | 翻转影响 |
| --- | --- | --- | --- |
| G-8 .git 防护 | 段级 + realpath 复检；list 默认隐藏嵌套 .git 条目 | 仅段级 / list 显示条目点击 403 | S1 一组用例期望变化 |
| G-9 F2 | 顶层整体 try/catch + URIError→400 | 逐路由 try/catch | S1 畸形矩阵期望近似不变（400/404） |
| G-10 抓取审计 | 本地 JSONL（ROOT 外）+ console | hub audit 转写 | S2 审计用例从「查文件」改为「查 hub /api/activity」 |
| G-11 错误码枚举 | 常量表收口，前端映射三方对齐 | 维持内联字符串 | S2-08/09 从可测断言降为评审项 |
| G-12 A6 合入 | 沿用 w/T-051（a524951）合入 | main 重做 | S4 用例不变，实施路径不同 |
| G-13 B1/B2 | 本批实现（默认纳入，等将军 OQ-3） | 维持占位 | 删 S5/S6/S7 三节 |
| G-14 第三方库 | 一律不引入（本地盘点缺失即 blocker） | 将军批准联网安装 | 全批零依赖断言失效 |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I-1 | 零新增运行时依赖（node:sqlite/node:http/node:fs/EventSource/自研 React） | TC-S1-13 / TC-S2-12 / TC-S5-12 / TC-S8-01 |
| I-2 | 仅回环 + 写需 token（serve.mjs 端点） | TC-S1-13（写面）回归见 files-api 34 基线；S8-04 |
| I-3 | 写统一走 handleWrite / audit（by 必填 + audit + SSE） | TC-S5-05 / TC-S5-08 |
| I-4 | 数据按 scope 隔离 | TC-S5-03/04；TC-S6-06；TC-S7-03 |
| I-5 | 远端/用户/文件内容不得以未净化 HTML 直插 DOM | TC-S4-09 / TC-S6-09 / TC-S7-09 / TC-S8-03/05 |
| I-6 | 文件写：覆盖 overwrite=1、删除 confirm=yes、非空目录拒删 | 基线已锚（files-api 34）；S8-04 |
| I-7 | SSRF：协议白名单 + 私网/回环逐跳阻断 + 限长/超时 + 审计 | TC-S2-02 / TC-S8-05 |
| I-8 | 实时推送并入单一 /api/events 按 kind 过滤（不新增 hub 事件连接） | TC-S5-08 / TC-S7-07 / TC-S8-06 |
| I-9 | **任何请求（含畸形输入）不得导致进程整体崩溃** | TC-S1-09/10/11 |
| I-10 | **文件面任何读写不得暴露非顶层 .git 内部** | TC-S1-01..07 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 与第一批 T-039 同构；命令以 `node <file>` 直跑等效为准（node:test 进程内执行、不 spawn 子进程 → 沙箱可跑）。**node_modules 不在本 worktree**：tsc/vite 类命令按 R-18 记录「环境受限 + 复现步骤」（宿主 junction 后执行），不冒充通过。

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 契约测试直跑：`node workbench/scripts/files-api.test.mjs`、`node workbench/scripts/web.test.mjs`、`node team-hub/chat.test.mjs`、`node team-hub/skills.test.mjs`、`node team-hub/calendar.test.mjs`（S5 新增）、`node tests/contract/contracts.test.mjs` | S1/S2/S5 纯逻辑 + 路由契约（进程内 HTTP）；既有基线 | coder 随实现交付自跑；tester 验收复跑 | 沙箱直跑已验证（01-baselines.txt）；web 目标一律本地 mock（§8.3） |
| L1 | 真进程 HTTP 冒烟（serve.mjs / team-hub 起临时端口 + 临时库 + curl / node fetch 脚本）：files、web audit/stall、calendar POST→GET→activity、SSE 事件、畸形并发 | 路由、鉴权、审计文件、SSE、进程存活端到端 | tester（S1/S2/S5 后） | env：TEAM_HUB_DB/TEAM_HUB_PORT、DSH_WORKBENCH_PORT/DSH_WORKBENCH_SPACES_JSON/DSH_WORKBENCH_TOKEN、DSH_WEB_FETCH_ALLOW_PRIVATE（仅测试放开私网目标） |
| L2 | 浏览器手工验收（:5173 构建产物；calendar/notify 为新增面板） | S3/S4/S6/S7 交互主路径与错误态；S8 回归 | tester + 将军验收（§7 清单） | 改前端后须 pnpm build 再验（宿主/CI）；旧标签 Ctrl+F5 |
| L3 | 集成回归：全量 L0 + L1 + build + 三中心主路径走查 + whiteboard/board-plugin 存量 | S8 / R-B3 | tester / devops | board-plugin 宿主注入不可达 → 记录「环境受限 + 复现步骤」 |

### 2.1 关键命令与 env（tester/coder 照抄）

| 用途 | 命令 / env | 说明 |
| --- | --- | --- |
| files-api 契约 | `node workbench/scripts/files-api.test.mjs` | import serve.mjs 三次（?files=?tok=?cap）进程内 HTTP + 函数级 |
| web 契约 | `node workbench/scripts/web.test.mjs` | 本地 mock HTTP；SSRF 注入口 DSH_WEB_FETCH_ALLOW_PRIVATE=1 仅测试用 |
| hub DAO 契约 | `node team-hub/chat.test.mjs`、`node team-hub/skills.test.mjs`、`node team-hub/calendar.test.mjs` | TEAM_HUB_DB=临时库 → import server.mjs（isMain 守卫不占端口） |
| 存量契约 | `node tests/contract/contracts.test.mjs` | 56 例基线；whiteboard 套件见 `whiteboard/package.json` test 脚本 |
| 前端类型 | `node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit`（node_modules 就位后） | strict + noUnusedLocals/noUnusedParameters；EPERM/node_modules 缺失按 R-18 记录 |
| 前端构建 | `cd workbench && pnpm build` | esbuild spawn EPERM 历史限制 → 宿主/CI 补跑；tsc 0 错误为沙箱内最严证据 |
| 真服务冒烟 | serve：`node workbench/scripts/serve.mjs --port <p> [--token tk]`；hub：`TEAM_HUB_DB=<tmp> TEAM_HUB_PORT=<p> node team-hub/server.mjs` | L1 用；静态 ROOT=workbench/dist（不存在时仅 API 可测，L2 需宿主构建产物） |
| 空间注入 | DSH_WORKBENCH_SPACES_JSON=[{id,localDir}] | files 测试免起中枢（serve.mjs 读 env，先例见测试头注） |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> ⚖️ 者为实现期可配值：实现必须导出为常量或读 env，测试用「三值法」（值-1 / 值 / 值+1）断言；定值后无需改用例。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| .git 防护（I-10） | 任一层级段拒绝 | list/read/download/upload/mkdir/rename/delete 对嵌套/顶层/大小写变体 .git 一律 403 + 错误含「禁止访问 .git 内部」；符号链接→.git 经 realpath 复检 403（TC-S1-01..07） |
| 畸形输入（I-9） | URIError→400 | 单发/并发/超长/重复 % 均返回 400/404（非 HTTP 000），进程存活、后续 200（TC-S1-09..11） |
| fetch 审计行 | 每次实际抓取 1 行 | 行含 url/finalUrl/status/耗时 ms/by=general/ts；成功与 ssrf_blocked/timeout/too_large/http_<n> 均留痕；无痕=FAIL（TC-S2-01/02） |
| 审计文件位置/轮转 | ROOT（workbench/dist）之外；默认 1 MiB ⚖️ | 路径断言在 ROOT 外；GET 不到内容；超限轮转不失控（TC-S2-03/04） |
| body stall/整链超时 | 统一 code=timeout | 2xx 与 5xx「headers 已回 body 挂起」→ {ok:false, code:'timeout'}；整链超时同码；不出现 abort/undefined/web_error（TC-S2-05..07） |
| 错误码枚举 | 常量表全码 | 场景矩阵产出的每个 code ∈ 枚举表；前端 errorText 覆盖枚举全集（TC-S2-08/09） |
| chat 实时可见 | ≤15s（轮询/重连节拍） | 第二标签同会话 ≤15s 收到（TC-S3-05 / TC-S8-03） |
| chat SSE 推送 | ≤5s | 订阅 /api/events 后写消息 ≤5s 收到对应帧（TC-S5-08 同机制复用） |
| 会话/空间写回守卫 | 发起时快照比对 | 在途 loadOlder/send 在切会话/切空间后不回写当前视图（TC-S3-02..04/06） |
| calendar 标题长度 | MAX_CALENDAR_TITLE=100 ⚖️ | 100 字符 → 200；101 → 400 |
| calendar 时间 | start 必填可解析；end 可选须 ≥ start | 非法/乱序 → 400；日期窗 [from,to] 含边界（TC-S5-05/06） |
| 通知未读 | 已读游标 localStorage per scope | 点读后 badge 减、刷新保持、per-scope 隔离、已读不写 audit（TC-S7-04/05） |
| hub 事件连接数 | ≤ 既有 +0（单一 /api/events） | devtools EventStream 计数 + 静态唯一 EventSource（TC-S7-07 / TC-S8-06） |

## 4. 用例目录

> 图例：类别 🟢正常 / 🟡边界 / 🔴异常；优先级 P0（切片验收门槛，P0 用例 coder 必须落成断言）/ P1 / P2；「自动化落点」= 测试文件（coder 落盘）/ L1 curl / L2 浏览器 / 评审（grep + 代码审查断言）。
> 追溯列引用：REQUIREMENTS 需求号（R-A1..）、TASK_BREAKDOWN 机器验收行（S1 验收 1/2/3… 即该片 DoD 分句）、闸门（G-x）、不变量（I-x）。
> 复现索引（§4.0）给「缺陷 → 已确认证据 → 本批用例」映射，供 coder 回归时先复现后修复。

### 4.0 既有缺陷 → 切片 → 用例索引（回归优先）

| 缺陷 | 证据 | 本批切片 | 直接用例 |
| --- | --- | --- | --- |
| F1 嵌套 .git 元数据外泄 | T-062 §5 / T-058（read/download 200 泄出 subrepo/.git/config） | S1 | TC-S1-01..07 |
| F2 畸形 % 路径崩溃进程 | T-062 §5 / T-058（/api/files%zz → 进程 exit 1，后续 000） | S1 | TC-S1-09..11 |
| A3 web fetch 审计零实现 | T-057 M1 / T-059 M1 | S2 | TC-S2-01..04 |
| A4 body stall 误分类 | T-057 M2 / T-059 M2（web_error/abort/undefined） | S2 | TC-S2-05..07 |
| A5 ChatView 异步回写竞态串显 | T-060 review M1（loadOlder/send 无会话守卫） | S3 | TC-S3-01..04/06 |
| A6 前端错误态/命名收口 | main BrowserPanel 漏 too_many_redirects/web_error + 无 IME 守卫；w/T-051 已实现 | S4 | TC-S4-01..06 |
| R-B1/R-B2 占位模块 | Sidebar.tsx:78-79 占位 toast | S5/S6/S7 | §4.5..4.7 |

### 4.1 S1 serve.mjs 文件面加固：嵌套 .git 防护 + 畸形路径防崩溃（R-A1/F1 · R-A2/F2）【P0】
自动化：`workbench/scripts/files-api.test.mjs`（模块级 + 进程内 HTTP 路由层 + 真进程存活）｜L1

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | 夹具根含顶层 .git/config + 嵌套仓库 subrepo/.git/config（既有 fixtures 扩展，见 §8.1）；serve.mjs 已实现段级 .git 守卫 | GET /api/files/read?scope=fx&path=.git/config；download 同 | 403 + error 含「禁止访问 .git 内部」；download 非 200、零字节泄露（顶层对照，回归 TC-S3-12 语义） | files-api.test.mjs | R-A1 验收 2；I-10 |
| TC-S1-02 | 🔴 P0 | 同上（含嵌套仓库夹具） | GET read/download path=subrepo/.git/config、subrepo/.git/objects/pack/x.pack、subrepo/.git/logs/HEAD | 全 403（非 200/非 000）；无任何文件字节返回；错误码经 classifyFilesError=.git→403 | files-api.test.mjs（新增主矩阵） | R-A1 验收 1；I-10 |
| TC-S1-03 | 🟡 P0 | 同上 | GET list path=subrepo/.git 与 subrepo/.git/objects；再 list path=（根）与 path=subrepo | list 指向 .git 内部 → 403；list 根/subrepo 时**不出现 .git 条目**（点文件隐藏默认），subrepo 条目 isRepo=true 保留 | files-api.test.mjs | G-8；R-A1 |
| TC-S1-04 | 🔴 P0 | 夹具 subrepo/.git/ 内含占位文件 secret | 写面注入：upload→subrepo/.git/x、mkdir→subrepo/.git/a/b、rename from=subrepo/.git/secret to=根外/内部、delete path=subrepo/.git/secret | 每写操作 403（或文档化 400）且**零副作用**：.git 内文件原样、根外无新建文件；无半写残留 | files-api.test.mjs（写面同强度） | R-A1 验收 3；I-10 |
| TC-S1-05 | 🟡 P0 | 夹具含真实 .git（大小写不敏感 FS 可访问 .GIT） | read/download/list 大小写变体路径：.GIT/config、SUBREPO/.GIT/config、subrepo/.Git/config | 一律 403（实现段级比较先 toLowerCase；POSIX 敏感 FS 上文件不存在也不得绕过防护 → 403 或 400，禁止 200） | files-api.test.mjs | R-14；G-8 |
| TC-S1-06 | 🟡 P0 | 夹具：submodule 型仓库 —— sub/ 目录内含 .git **文件**（gitdir: 指针，指向 ../.git/modules/sub） | read path=sub/.git（指针文件本身）；list path=sub/.git | 403（任一层段含 .git 即拒；指针内容属父仓 .git/modules 元数据，不暴露） | files-api.test.mjs（新增） | R-14；G-8 |
| TC-S1-07 | 🔴 P0 | 夹具：symlink/junction lkg → 根内 .git 目录（或 lkg2 → subrepo/.git） | read path=lkg/config、list path=lkg；download path=lkg2/config | 词法段无 .git 时 realpath 复检必须拦截 → 403 且错误含 .git/符号链接语义；无字节返回 | files-api.test.mjs（realpath 复检用例） | R-A1；G-8；R-14 |
| TC-S1-08 | 🟢 P0 | 夹具正常目录树 | read subrepo/README.md、download docs/guide.txt、list subrepo（正向对照，确认守卫不过度拦截） | 200 正常返回；嵌套仓库正常文件**不受** .git 防护波及（防护只拦 .git 内部） | files-api.test.mjs（正向控制） | R-A1；I-10 |
| TC-S1-09 | 🔴 P0 | serve.mjs 真进程（import 后 listen 随机端口或 spawn）；畸形 % 可经**原始 socket** 发送（Node http.request 会编码，须 net 直写原始请求行，见 §8.2） | 逐路注入单发畸形：GET /api/files%zz、/api/files/list%zz、/api/web/fetch%zz、/api/fs/home%zz、/%zz、/hub%zz、带 %00 与悬空 % 的混合 | 每请求返回 400（URIError→400）或 404；**HTTP 非 000、进程存活**；紧接的正常请求（GET /api/config 或 /）→ 200；stderr 无未捕获 URIError | files-api.test.mjs + L1 | R-A2 验收 1/2；G-9；I-9 |
| TC-S1-10 | 🟡 P0 | 同上 | **10 并发**畸形请求（混合端点） | 全部收到 4xx 响应（无悬挂/无 000）；进程存活且后续 200；无异常堆栈落 stderr（并发不崩） | files-api.test.mjs（并发断言） | R-A2 验收 4；I-9 |
| TC-S1-11 | 🟡 P0 | 同上 | 长尾/超大畸形：路径 ≥1 万字符、'%' 重复 ≥5000、%00 嵌入、畸形 + 长 query | 响应受控 400/404（或 414 类长度拒绝），进程存活、不 OOM 迹象、后续 200 | files-api.test.mjs（长尾矩阵） | R-A2 验收 3；I-9 |
| TC-S1-12 | 🟢 P0 | S1 实现完成 | 复跑 `node workbench/scripts/files-api.test.mjs` 全量 | 既有 34 例 + 新增全部绿，fail=0（基线不回归） | L0 | S1 验收 3 |
| TC-S1-13 | 🟢 P2 | S1 实现完成 | git diff 核对 serve.mjs/package.json；检查守卫语义注释 | 零新增依赖（package.json 无变更）；读/写面与 .gitignore 语义注释与实际一致；错误信息不含内部路径细节 | 评审 | S1 验收 4；I-1/I-2 |

### 4.2 S2 serve.mjs 浏览器后端：抓取审计留痕 + body stall 归类（R-A3 · R-A4）【P0/P1】
自动化：`workbench/scripts/web.test.mjs` + `workbench/.gitignore`｜L1（审计文件与真进程）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | 本地 mock HTML 页（§8.3）；DSH_WEB_FETCH_ALLOW_PRIVATE=1 仅测试；webFetch 已实现审计 | POST /api/web/fetch {url: mock/page} 成功后读取审计文件（默认 workbench/data/web-audit.jsonl ⚖️ 路径以实现导出常量为准） | 200；审计文件**追加** ≥1 行 JSON：含 url（请求时规范后）、finalUrl、status=200、ms（数值 ≥0）、by='general'、ts；服务端 console 亦输出一行（评审确认） | web.test.mjs + L1 | R-A3 验收 1/3；G-10 |
| TC-S2-02 | 🔴 P0 | mock 提供 /slow /500 /big 等；默认 SSRF 策略（无 allow-private） | 依次造 4 类失败/拦截抓取：①ssrf_blocked（fetch 私网目标）②timeout（/slow + 小 timeoutMs）③too_large（/big + 小 maxBytes）④http_500（mock /500） | 每类响应后审计文件含**对应行**：url=原始目标、finalUrl/status 按实际、ms、by=general；其中 ssrf_blocked 行仍记录目标 URL（拦截也留痕）。四类缺一行 = FAIL（无痕 = 失败） | web.test.mjs + L1 | R-A3 验收 2/3；G-10；I-7 |
| TC-S2-03 | 🟡 P0 | 审计目录已产生文件 | ①代码断言审计文件绝对路径 **不在** ROOT（workbench/dist）内 ②HTTP GET 该相对路径/遍历路径 | ①路径断言通过 ②静态服务器不返回审计内容（SPA 回退 200 index.html 或 403/404，不含 JSONL 原文）—— 审计不可经 GET 外泄（R-17） | web.test.mjs + L1 | R-17；G-10 |
| TC-S2-04 | 🟡 P1 | 注入小轮转上限（如 DSH_WEB_AUDIT_MAX_KB=2，⚖️ 三值法） | 连续抓取 ≥上限容量的多次请求 | 审计文件总量受控（≤ 上限 + 单行余量）；发生轮转（归档或截断重开）且**后续行仍可追加**；无无限膨胀、服务不崩 | web.test.mjs（轮转用例） | R-17 |
| TC-S2-05 | 🔴 P0 | mock 新增 /stall2xx：写 200 headers 后挂起 body；timeoutMs 注入小值 | fetch {url: mock/stall2xx, timeoutMs: 300} | 响应 {ok:false, code:'timeout'}（HTTP 200 envelope）；耗时 ≈ 超时值非立即；**code 不是** web_error/abort/undefined；此后服务正常（后续 fetch 200） | web.test.mjs（body stall 夹具） | R-A4 验收 1；G-11 |
| TC-S2-06 | 🔴 P0 | mock /stall5xx：写 500 headers 后挂起 body | fetch {url: mock/stall5xx, timeoutMs: 300} | 同样 code='timeout'（不是 http_500/web_error）——错误分类以「body 未读完即超时」为唯一判据，与状态码无关 | web.test.mjs | R-A4；M2 全路径 |
| TC-S2-07 | 🟢 P0 | 延迟重定向链夹具（c1→c2→page，每跳 < 总超时、整链 > 总超时） | fetch 慢链 timeoutMs=300 | code='timeout'（整链共享 deadline 不重置；回归 TC-S6-09b 语义）；充足超时下同链正常 → 抽取终页（共享 deadline 不误伤） | web.test.mjs（既有回归保留） | R-A4 验收 2 |
| TC-S2-08 | 🟢 P0 | S2 实现完成 | 断言 webFetch 导出/引用**错误码枚举常量表**（如 WEB_ERROR_CODES），含 invalid_url/protocol_blocked/ssrf_blocked/too_many_redirects/timeout/too_large/fetch_error/http_<n>/unsupported/empty_content/web_error；跑场景矩阵收集全部返回 code | 枚举表存在且上述码全在；矩阵每个 code ∈ 表（无表外新码泄漏到 handleWebApi 响应）；http_<n> 以 http_ 前缀动态归类在表内 | web.test.mjs | G-11；R-13 |
| TC-S2-09 | 🔴 P0 | S4 合入后（BrowserView 就位） | 静态读取 BrowserView 的 errorText/isErrorResult 映射键集合，与枚举表对比；并核对后端实际发射集合 | 前端映射键覆盖枚举表**全集**（允许超集如 dns_error，不得漏码）；后端发射集合 ⊆ 枚举表（无漂移）；三方对齐（后端 / 枚举表 / 前端） | 评审 + 脚本对比 | R-13；G-11 |
| TC-S2-10 | 🟡 P1 | — | 参数级失败（url='' / 非字符串 / 解析失败） | 400 + code=invalid_url（webFetch 层 throw）；**不产生审计行**（未发起实际抓取；与 TC-S2-02 的「发起后拦截须留痕」分界明确） | web.test.mjs | R-A3 边界；OQ-7 |
| TC-S2-11 | 🟡 P1 | mock 提供多路由 | 10 并发混合抓取（含 1 个 stall、1 个 500、若干成功） | 响应各自正确归类；审计行数与实际抓取数一致（≥9 行）；服务不崩、无泄漏；单请求异常不影响并发 | web.test.mjs（并发） | R-A3 健壮性 |
| TC-S2-12 | 🟢 P1 | S2 实现完成 | 复跑 `node workbench/scripts/web.test.mjs` 与 `node workbench/scripts/files-api.test.mjs`；核对 `workbench/.gitignore` | web 既有 12 例 + 新增全绿；files-api 34 仍全绿（serve.mjs 读面未破坏）；.gitignore 含 data/ 条目（审计目录不入库） | L0 | S2 验收（基线不回归 + gitignore）；R-17 |

### 4.3 S3 ChatView 会话/空间身份守卫（R-A5）【P1】
自动化：评审（grep + 代码正读）+ L2 浏览器清单；可选纯函数抽取后 node --test

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | S3 实现完成 | 代码正读 ChatView.tsx：send（现 :232-256）/ loadOlder（现 :160-180）异步写回 setMsgs/setDraft 前是否比对「发起时快照」与 activeRef.current | 存在守卫：快照不匹配时**仅**复位 loadingOlder/sending（且不 setDraft('') 不清当前视图），直接丢弃本次合并；无任何无条件 setMsgs/setDraft 写回残留（评审关键行 + grep） | 评审 | R-A5；T-060 M1 |
| TC-S3-02 | 🟡 P0 | team-hub + serve 双服务真实可跑；会话 A 消息量 > PAGE（可翻页） | 浏览器：在 A 点「加载更早」后**立即**切到 B 会话，等两请求完成 | B 视图只含 B 消息：无 A 的旧页消息混入、无重复/乱序；切回 A 历史仍完整（在途响应不回写到非发起会话） | L2（配合 §7.1） | R-A5 验收 1 |
| TC-S3-03 | 🟡 P0 | 双会话 A/B；B 正在输入 | 在 A 发送消息后**立即**切到 B 再切回 A（或保持 B），等 send 响应返回 | 消息气泡只出现在发起会话 A（最终视图正确）；若停留在 B，B 不被写入 A 消息、B 草稿不被误清；无 toast 噪音以外异常 | L2 | R-A5 验收 1 |
| TC-S3-04 | 🔴 P0 | 空间 software 与 marketing 各有会话 | 在 software 会话发起 loadOlder/send 后**立即**切到 marketing 空间，等响应返回 | marketing 视图零污染（旧空间响应不回写进新空间视图）；切回 software 数据仍在（发起会话语义正确） | L2 | R-A5 验收 2 |
| TC-S3-05 | 🟢 P0 | 正常主路径 | 新建会话 → 发消息 → 气泡即时出现；第二标签同会话观察 | ≤15s 实时收到（SSE/poll 无回归）；刷新后历史完整；分页 loadOlder 正常（主路径无回归） | L2 | R-A5 验收 3；R-A7 验收 1 |
| TC-S3-06 | 🟡 P1 | SSE/poll 生效 | 代码正读 mergeNewest（现 :118-130）与 SSE/poll 回调（:133-151）：异步 fetchChatMessages(convId) 返回后是否**再校验** activeRef.current===convId 才合并 | 轮询/SSE 引发的 merge 同样受守卫（会话已切走则丢弃）；预防「事件到达时正确、返回时已切走」的第二类竞态 | 评审 | R-A5 扩展；T-060 M1 同族 |
| TC-S3-07 | 🟢 P1 | node_modules 就位（宿主/CI） | tsc --noEmit / pnpm build | 0 类型错误；build 绿（EPERM 时记录 tsc 结果 + 复现步骤，不冒充） | L0 build | R-A5 验收 3 |
| TC-S3-08 | 🟡 P2 | — | grep ChatView 渲染路径 + 手工 XSS 样本消息 | 无 dangerouslySetInnerHTML 直插正文；<img onerror>/<script>/[x](javascript:) 按纯文本显示不执行（渲染安全不回归） | 评审 + L2 | I-5 |

### 4.4 S4 浏览器前端收口：合入 w/T-051 为 BrowserView（R-A6）【P1】
自动化：评审（grep + diff 复核）+ L2 浏览器清单（合入源 w/T-051 a524951）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | S4 合入完成 | ①workbench/src/components/BrowserView.tsx 存在 ②BrowserPanel.tsx 不存在 ③App.tsx 渲染 BrowserView（import 同步）④grep 全 src 无 BrowserPanel 引用 | ①✅ ②删除 ③active==='browser' 分支渲染 BrowserView ④零残留引用（含注释） | 评审/grep | R-A6 验收 1；G-12 |
| TC-S4-02 | 🟢 P0 | node_modules 就位 | tsc --noEmit / pnpm build（受限记录） | 0 类型错误 / build 绿或 EPERM 记录 | L0 build | R-A6 验收 4 |
| TC-S4-03 | 🟢 P0 | BrowserView 就位 | 代码正读 errorText/isErrorResult：①errorText 是否覆盖 全部枚举码（含 too_many_redirects/web_error/http_*）②isErrorResult 对 too_many_redirects/web_error/http_*/ssrf_blocked/timeout/too_large/protocol_blocked/dns_error/invalid_url/fetch_error 均 true；对 ok 结果（含 unsupported/empty_content 的 ok:true 业务提示）不落入「错误视图」而走正文/提示分支 | 覆盖表与枚举表（TC-S2-08）一致；无码漏映射导致错误落入正文分支（基线 BrowserPanel 缺陷已修）；成功/失败可区分、可重试（重试/重新抓取按钮分支正确） | 评审 | R-A6 验收 2；R-13 |
| TC-S4-04 | 🔴 P0 | 本地可抓 mock；SSRF 默认拦私网 | 浏览器输入 http://127.0.0.1:8787/api/config 抓取 | 展示错误视图文案含「已拦截：禁止访问内网地址」（ssrf_blocked 映射）；**不**把上游 JSON 当正文展示；重试按钮可用 | L2 | R-A6 验收 2；R-A7 验收 3 |
| TC-S4-05 | 🟡 P0 | mock 可控 | 依次触发 5 类结果：超时（慢目标）/ 限长（大页面）/ 非文本（pdf）/ 4xx / 5xx | 每种给出**可区分**文案（timeout/too_large/unsupported/http_404/http_500 各不同）且不落正文分支；目标恢复后重试成功 | L2 | R-A6 验收 2/3 |
| TC-S4-06 | 🟡 P0 | 中文输入法环境 | 地址栏进入中文拼音合成态（isComposing=true）按 Enter → 再确认候选后按 Enter | 合成态 Enter **不触发**抓取（无请求、无 loading）；确认后 Enter 正常抓取（实现 = e.nativeEvent.isComposing 守卫，w/T-051 :130） | L2（评审关键行 + 手工） | R-A6 验收 3 |
| TC-S4-07 | 🟢 P0 | 全量产物 | QuickTools「浏览网页」与侧栏「浏览器助手」分别点击 | 两者进入**同一**面板（active==='browser'），地址栏自动聚焦；active 高亮正确（入口一致性） | L2 | R-A6 验收 4 |
| TC-S4-08 | 🟢 P1 | mock 返回含标题/正文/链接页 | 地址栏输入 mock URL → 抓取 | 标题 + 正文以文本视图呈现；链接列表 <a target=_blank rel=noopener>；无整页刷新；成功态提供「重新抓取」 | L2 | R-A6；主路径 |
| TC-S4-09 | 🔴 P1 | mock 页正文含 <script>alert(1)</script>/<img onerror> | 抓取并查看结果 | 按文本渲染、无脚本执行、无弹窗；grep BrowserView 无 dangerouslySetInnerHTML 直插远端内容 | L2 + 评审/grep | I-5 |
| TC-S4-10 | 🟡 P2 | — | 成功抓取 9 个不同 URL 后查看地址栏 datalist | 历史保留最近 8 条（MAX_HISTORY），去重、刷新保持（localStorage 键 legion.browser.history） | L2 | R-A6 附（P2 观察项） |

### 4.5 S5 日程日历后端：team-hub 扩表扩 API（R-B1 数据面）【P1 · G-13 门】
自动化：`team-hub/calendar.test.mjs`（新增，仿 chat.test.mjs：临时库 import server.mjs 不占端口）+ L1 curl

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | TEAM_HUB_DB=临时新库 | import server.mjs（自动建表）后查 sqlite_master；再以「旧库（有 tasks/skills/conversations/messages、无 calendar_events）」import | calendar_events 表存在且建表幂等；旧库自动建表不报错、旧表数据完整（chat/skills 断言仍绿） | calendar.test.mjs | S5 验收 1；S1-AC2 同构 |
| TC-S5-02 | 🟢 P0 | 临时库；合法输入 | POST /api/calendar/events {scope:'software', title:'评审会', start:'2026-08-20T10:00', by:'general'} | 200 {ok:true, event:{id,scope,title,start,end:null,allDay:false,createdAt,updatedAt}}；库中可查；audit 增 calendar:create 行（member/scope/detail 形状正确）；SSE 订阅方 ≤5s 收到 action='calendar:create' 帧 | calendar.test.mjs + L1（SSE） | S5 验收 2/4；I-3 |
| TC-S5-03 | 🟢 P0 | software/marketing 各建 3 条不同日期事件 | GET /api/calendar/events?scope=software；再带 from/to 日期窗 | ①仅 software 事件 ②日期窗 [from,to] **含边界**过滤正确（from<=start<=to），按 start asc/createdAt 稳定排序 | calendar.test.mjs | S5 验收 2；I-4 |
| TC-S5-04 | 🔴 P0 | 同 TC-S5-03 | GET ?scope=marketing 对比 software；POST body scope 与路径语义一致后交叉查询 | marketing 列表不含任何 software 事件（scope 隔离反向）；跨 scope 写不串（事件 scope=请求 scope） | calendar.test.mjs | I-4；S5 验收 |
| TC-S5-05 | 🔴 P0 | 临时库 | 逐项非法输入：①缺 by ②title 空 ③title=101 字符 ④start 缺 ⑤start 非法（'2026-13-99'/'garbage'）⑥end<start ⑦scope 缺/非法 | 全部 400（handleWrite 语义）且**零落库**；audit 无 calendar:* 新行；错误信息可读（by/title/时间分别指明） | calendar.test.mjs | S5 验收 3；I-3 |
| TC-S5-06 | 🟡 P1 | 事件 start 恰在 from / 恰在 to / 前一日 / 后一日；allDay 事件（date-only start） | GET ?from=2026-08-20&to=2026-08-26 | 20 日与 26 日事件含（闭区间），19/27 不含；allDay 无时间事件按日期落入窗（口径 = v1 以 start 是否在窗内为准，⚖️ 见 R-16） | calendar.test.mjs | S5 验收 2（日期窗边界） |
| TC-S5-07 | 🔴 P0 | 已建事件 E1(software)、E2(marketing)；契约按假设 H-2 | POST /api/calendar/events/delete：①{id:E1, by:'general'}（缺 confirm）②{id:E1, confirm:'nope'} ③{id:E1, confirm:'yes', scope:'marketing'}（scope 越权）④{id:E1, confirm:'yes'} | ①②400 且 E1 仍在；③400/404（越权不可删他人空间事件）；④200 且 GET 不再含 E1、audit 增 calendar:delete + SSE 广播 | calendar.test.mjs + L1 | R-B1 验收 2（删除闭环）；假设 H-2；I-6 语义 |
| TC-S5-08 | 🟢 P0 | 真服务临时端口 + SSE 客户端 | POST 创建 → 订阅方观察事件 → GET /api/activity?scope=software | audit 可查：action ∈ {calendar:create, calendar:delete}，member/scope/detail 形状与 chat:* 同构；SSE 复用既有 /api/events 单一流（kind=calendar:*）广播 ≤5s | L1（SSE 脚本，复用 chat-s2-smoke 模式） | I-8；S5 验收 4 |
| TC-S5-09 | 🟢 P0 | 旧库迁移 | 以旧库（无 calendar 表，含 chat/skills 存量）import 后：创建/查询事件；复跑 chat.test/skills.test 等价断言 | 自动建表 + 事件可用；存量模块零回归 | calendar.test.mjs | S5 验收 1 |
| TC-S5-10 | 🟢 P0 | S5 实现完成 | 复跑 chat.test.mjs + skills.test.mjs | 13/13 + 12/12 全绿（team-hub 改动不回归既有模块） | L0 | S5 验收（不回归） |
| TC-S5-11 | 🟡 P1 | 合法输入 | ①title 恰 100 字符 ②end 可省 ③allDay:true ④end=start（零长时段） | ①200 ②end=null ③allDay=true ④200（v1 允许 end=start）；字段形状稳定 | calendar.test.mjs | 边界 |
| TC-S5-12 | 🟢 P2 | S5 实现完成 | git diff 核对 team-hub/package.json；L1 curl 冒烟：POST → GET 日期窗 → /api/activity 查 calendar:* | 零新增依赖（仅 node:sqlite）；curl 三连结果正确入 evidence | L1 + 评审 | I-1；S5 验收 4 |

### 4.6 S6 日程日历前端：自研月视图面板 + 接线（R-B1 视图面）【P1 · G-13 门】
自动化：L2 浏览器清单 + 评审（grep）+ build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 P0 | 已选具体空间；hub + S5 后端就位 | 侧栏点「日程日历」 | 进入**真实月视图面板**（非 toast 占位）：当月 7×N 网格、每格日期正确（月首/月尾周对齐）、今天格高亮 | L2 | R-B1 验收 1 |
| TC-S6-02 | 🟢 P0 | 面板已开 | 新建条目：标题 + 日期（必填）→ 保存 | 前端校验放行合法输入；POST 后网格对应日期出现条目（标题可见）；toast 成功；无整页刷新 | L2 | R-B1 验收 2 |
| TC-S6-03 | 🔴 P0 | 面板已开 | ①标题空/日期空保存 ②标题 101 字 ③停 hub 后保存 | ①②前端阻止或后端 400 映射 toast（不崩溃、不产生坏条目）③hub 不可达 → toast 错误、无静默丢失、hub 恢复后可重试成功 | L2 | R-B1 验收 3 |
| TC-S6-04 | 🔴 P0 | 已建条目 | 删除：先点删除 → 弹二次确认 → 先「取消」再「确认」 | 取消 → 无请求、条目仍在；确认（confirm=yes）→ 条目从网格消失且持久（刷新后不在） | L2 | R-B1 验收 2（删除闭环）；I-6 语义 |
| TC-S6-05 | 🟢 P0 | 已建条目 | 刷新页面（F5）重新进入面板 | 条目仍在（数据 = GET /api/calendar/events，scope=当前空间，非 localStorage 假数据） | L2 | R-B1 验收 2 |
| TC-S6-06 | 🟡 P0 | software 与 marketing 各有条目 | 从 software 切到 marketing 再切回 | 事件随空间切换互不串：marketing 看不到 software 条目，切回 software 数据仍在；「全部空间/未选空间」给引导（同 ChatView 语义，非白屏） | L2 | I-4；R-B1 验收 3 |
| TC-S6-07 | 🟡 P1 | 面板已开 | 上月/下月按钮切换 | 网格正确跨月（含月界对齐/当月标记）；今天高亮在回到当月时恢复；事件随所在月份显示 | L2 | 月视图边界 |
| TC-S6-08 | 🔴 P1 | 面板已开 | 停 hub 后点新建/删除/切换月 | 错误以 toast 呈现、面板不白屏不崩溃；hub 恢复后操作成功 | L2 | R-B1 验收 3 |
| TC-S6-09 | 🔴 P1 | 服务端存有标题含 <img src=x onerror=...> 的条目 | 月视图/弹层展示 | 标题按**纯文本**渲染、无脚本执行；grep CalendarView 无 dangerouslySetInnerHTML 直插服务端数据 | L2 + 评审/grep | I-5 |
| TC-S6-10 | 🟢 P1 | 全量产物 | 回归走查 chat/files/browser 面板 + tsc/build | 三中心无回归；build 绿或受限记录；calendar 接线不破坏其它模块 | L3/L2 + build | R-B1 验收 4 |

### 4.7 S7 通知中心：audit 派生面板 + 接线（R-B2）【P1 · G-13 门】
自动化：L2 浏览器清单 + 评审（数据同源/渲染安全 grep）+ devtools 连接数

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 P0 | 当前空间有 ≥1 条未读通知 | 侧栏点「通知中心」；观察 badge | 进入真实面板（非 toast 占位）；列表含通知行（时间/scope/来源 action）；badge 未读数 >0 时显示 | L2 | R-B2 验收 1/2 |
| TC-S7-02 | 🟢 P0 | hub 有任务/goal/space 类审计 | 打开通知面板 | 列表 = GET /api/activity（scope 过滤 + action 白名单）；行含时间、scope、action 来源；任务/目标类可辨识（taskId/detail）；新→旧排序 | L2 | R-B2 验收 2/3 |
| TC-S7-03 | 🔴 P0 | 同空间存在 chat:* 审计与任务类审计 | 打开面板查看列表 | **chat:create/chat:message 默认排除**（防刷屏白名单）；任务 claim/transition/advance/review-note/test-report/patch/evidence/artifact、goal:publish、space:* 等入列；scope 过滤只显示当前空间 | L2 | R-B2 验收 3；R-15；I-4 |
| TC-S7-04 | 🟡 P0 | 未读数 N>0 | 点击一条未读通知 → 已读；刷新页面；切空间再切回 | 点击后未读高亮消失、badge 减 1；刷新后已读状态保持（localStorage 游标 per scope）；切空间回来该空间已读状态仍在（per-scope 游标） | L2 | R-B2 验收 2；R-15 |
| TC-S7-05 | 🔴 P0 | 面板已开 | 标记若干已读；随后 GET /api/activity 数量对比 | 「已读」**不产生**任何 audit 新行（已读只落 localStorage，不写服务端；对比前后 /api/activity 计数一致） | L2 + L1（API 计数） | R-15；I-8 |
| TC-S7-06 | 🟡 P1 | 存在任务/目标类通知 | 点击任务类通知 / 目标类通知 / space 类 | 任务类跳转任务详情（复用 TaskDetailModal 或等价导航）；目标类跳对应目标/面板；space 类给出明确去向或说明；未知 action 不崩溃（兜底 toast/文案） | L2 | R-B2 验收 2 |
| TC-S7-07 | 🟢 P1 | 面板打开中；另一标签产生任务事件 | 观察面板/徽标；devtools Network 数 hub EventSource | 新事件经既有 subscribeHubAudit（单一 /api/events）实时进列表/badge；hub 事件连接数 ≤ 改造前（无第二连接，静态：全仓唯一 hub EventSource） | L2 devtools + 评审 | I-8；R-B2 验收 3 |
| TC-S7-08 | 🔴 P1 | 面板已开 | 停 hub → 刷新/操作 | toast 错误、面板不白屏；hub 恢复后列表与实时恢复 | L2 | R-B2 错误路径 |
| TC-S7-09 | 🟢 P1 | S7 实现完成 | grep NotifyView/api.ts 改动 + build | 无 dangerouslySetInnerHTML 直插（通知内容纯文本）；数据同源评审通过（列表=GET /api/activity + SSE=subscribeHubAudit，**无第三数据源**、无新增 hub 端点/事件连接）；tsc/build 绿或受限记录 | 评审 + build | I-5/I-8；R-B2 验收 3/4 |

### 4.8 S8 三中心集成回归锚定（R-A7 · R-B3 仓库内可跑部分）【P1 收尾】
自动化：L3 全量套件 + L2 主路径清单；结果沉淀 docs/TEST_REPORT.md（本片验证型，tester 执行；本设计给出判据与命令清单）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 P0 | S1~S7 合入完成 | 逐套件运行并记录输出要点：files-api.test.mjs、web.test.mjs、chat.test.mjs、skills.test.mjs、calendar.test.mjs、contracts.test.mjs、whiteboard 各套件 | 全部 fail=0（记录 tests/pass 计数；whiteboard 走 package.json test 脚本）；命令输出要点入 docs/TEST_REPORT.md | L3 | S8 验收（全量）；R-B3 验收 1/2 |
| TC-S8-02 | 🟢 P0 | node_modules 就位 | cd workbench && pnpm build（或 tsc --noEmit） | build 全绿；EPERM/node_modules 缺失 → 记录「环境受限 + 复现步骤」（tsc 结果附上），不冒充通过 | L3 build | R-A7 验收 4；R-18 |
| TC-S8-03 | 🟢 P0 | 双标签同空间进入同会话 | 标签 A 发消息 → 观察 B；断开服务再恢复观察重连；注入 XSS 样本消息查看渲染 | B ≤15s 实时收到；EventSource 断线自动重连（retry 2s + 15s 轮询兜底）不白屏；消息纯文本渲染（无 dangerouslySetInnerHTML 直插，grep + 评审） | L2 + 评审 | R-A7 验收 1 |
| TC-S8-04 | 🟢 P0 | 已绑定空间夹具 | 文件主路径走通：list/read/download/upload/mkdir/rename/delete；再验未绑定引导、越界/顶层 .git 403、overwrite/confirm 语义、预览受控文本 | 全操作成功语义 + 403/409/400 判据各就位；未绑定空间给引导不静默落任意目录；.git 防护含新 S1 语义不回归 | L1 + L2 | R-A7 验收 2；I-2/I-6/I-10 |
| TC-S8-05 | 🟢 P0 | mock/真环境 | 浏览器助手主路径：SSRF 私网目标 → 拦截文案「已拦截：禁止访问内网地址」；限长/超时/非文本/4xx-5xx 各触发一次 | 文案正确且错误可区分；结果文本/markdown 渲染不直插远端 HTML；重试可用 | L2 | R-A7 验收 3；I-5/I-7 |
| TC-S8-06 | 🟡 P1 | 双标签（对话中心 + 实时动态 + 通知面板） | devtools Network 数 hub 事件源连接；动态流与通知流各自收到事件 | hub 事件源连接数符合「≤ 改造前 +0」（chat/notify 均走 subscribeHubAudit 单一 /api/events）；无第二 hub 连接 | L2 devtools + 评审 | I-8；S8 |
| TC-S8-07 | 🟡 P1 | 全量产物 | 回归走查：右侧实时动态/顶部 KPI/3D 场景/任务详情/目标面板/chat/files/browser/calendar/notify | 与收口前行为一致无回归；calendar/notify 真实面板不与既有模块互相干扰 | L2/L3 | S8 验收（无回归） |
| TC-S8-08 | 🟡 P1 | 需 DSH Desktop/宿主 | board-plugin / plugins 按各自 README typecheck/build + 宿主注入冒烟 | 宿主可达 → 全绿；不可达 → evidence 记录「环境受限 + 复现步骤」，不静默判过也不冒充通过 | L3 | R-B3 验收 3；R-18 |
| TC-S8-09 | 🟡 P1 | 全部合入 | 双账本纪律/写源核对：grep UI/脚本路径直写 DB 的旁路；README §5「只写一个账本」警示 | 无绕过 API 直写 DB 的新路径（chat/files/web/calendar 写源唯一）；文档与实现一致 | 评审 | R-B3/R-B4 边界 |
| TC-S8-10 | 🟢 P1 | S8 完成后 | 全部结论（含环境受限项）写入 docs/TEST_REPORT.md；失败项 = 0 或如实标注 + 归属 | 报告含每套件命令输出要点、三中心主路径清单勾选、board-plugin 宿主结论；无未标注的「应该没问题」式结论 | L3 | S8 DoD；LEGION.md |

## 5. 关键业务规则 正反向覆盖矩阵

| 业务规则 | 正向用例（规则成立/被满足） | 反向用例（违反/攻击/边界被拒） |
| --- | --- | --- |
| .git 任一层级防护（I-10） | TC-S1-01（顶层对照 403）/ TC-S1-08（正常文件 200） | TC-S1-02（嵌套）/ TC-S1-03（list 进入 .git）/ TC-S1-04（写面）/ TC-S1-05（大小写）/ TC-S1-06（.git 文件指针）/ TC-S1-07（symlink 绕入） |
| 畸形输入不崩溃（I-9） | TC-S1-12（全量基线绿）/ S8-04（后续 200） | TC-S1-09（单发畸形）/ TC-S1-10（10 并发）/ TC-S1-11（超长/重复 %） |
| 抓取审计留痕（R-A3） | TC-S2-01（成功留痕、字段形状） | TC-S2-02（失败/拦截亦留痕；无痕=FAIL）/ TC-S2-03（审计不可被 GET）/ TC-S2-11（并发一致） |
| 超时统一归类 timeout（R-A4） | TC-S2-07（整链慢链=timeout；充足超时正常） | TC-S2-05（2xx body stall）/ TC-S2-06（5xx body stall）→ 必须 code=timeout |
| 错误码枚举收口（G-11） | TC-S2-08（枚举表含全码、发射 ⊆ 表） | TC-S2-09（前端漏码/漂移 = FAIL） |
| 会话/空间写回守卫（R-A5） | TC-S3-05（主路径正常）/ TC-S3-01（守卫存在评审） | TC-S3-02/03（切会话在途写回）/ TC-S3-04（切空间）/ TC-S3-06（SSE/poll 返回竞态） |
| 浏览器错误态不落正文（R-A6） | TC-S4-03（isErrorResult 判定表）/ TC-S4-08（成功态正文+重新抓取） | TC-S4-04（SSRF 错误视图）/ TC-S4-05（5 类错误可区分）/ TC-S4-06（IME 中间态 Enter 不误发） |
| 文件写二次确认（I-6，延续） | files-api 基线 34 例（overwrite=1/confirm=yes 成功） | files-api 基线（缺 overwrite→409、缺 confirm→400、非空目录拒删）；S8-04 回归 |
| calendar scope 隔离（I-4） | TC-S5-03（A scope 查询只见 A）+ TC-S6-06（前端切换正确） | TC-S5-04（B scope 查不到 A；反向隔离） |
| calendar 入参校验（I-3） | TC-S5-02（合法创建）/ TC-S5-11（边界值 100 字符/可省/零长） | TC-S5-05（by/title/start/end 非法全 400 零落库） |
| calendar 删除确认（R-B1 AC2） | TC-S5-07 ④ + TC-S6-04（确认删除成功） | TC-S5-07 ①②③（缺/错 confirm、越权 scope 均拒）+ TC-S6-04（先取消无请求） |
| 通知 action 白名单（R-B2/R-15） | TC-S7-02（任务/目标类入列）+ TC-S7-01（badge） | TC-S7-03（chat:* 默认排除 + scope 过滤） |
| 已读游标语义（R-B2） | TC-S7-04（点击已读、badge 减、刷新保持、per-scope） | TC-S7-05（已读不得写 audit —— 反向断言服务端零新行） |
| 数据同源/单事件连接（I-8） | TC-S5-08 / TC-S7-07（复用单一 /api/events；动态/通知互不干扰） | TC-S7-07 + S8-06（出现第二 hub EventSource = FAIL；出现第三数据源 = FAIL） |
| 渲染安全（I-5） | TC-S8-03/05（正文受控渲染） | TC-S3-08 / TC-S4-09 / TC-S6-09 / TC-S7-09（XSS 样本按文本、grep 无直插） |

## 6. 验收标准逐条用例化：需求/验收 → 用例追溯矩阵

> PASS 判据 = 该需求/验收行映射的全部用例通过。机器验收行（TASK_BREAKDOWN §1）→ 用例见「追溯」列；下表为需求级汇总。

| 需求/验收（REQUIREMENTS §5 / TASK_BREAKDOWN） | 直接用例 | 边界/异常补充 | 通过判据（汇总） |
| --- | --- | --- | --- |
| R-A1（F1 嵌套 .git，P0）｜S1 验收 1/2 | TC-S1-01/02/03/08 | TC-S1-04/05/06/07 | 读/写/list 对任一层级 .git 均 403、零泄露、正常文件不误伤 |
| R-A2（F2 畸形路径，P0）｜S1 验收 | TC-S1-09 | TC-S1-10/11 | 400/404 + 进程存活 + 后续 200（含并发/长尾） |
| R-A3（fetch 审计，P0）｜S2 验收 | TC-S2-01 | TC-S2-02/03/10/11 | 成功与拦截/失败均留痕（字段形状正确），文件在 ROOT 外不可 GET |
| R-A4（body stall→timeout，P1）｜S2 | TC-S2-07 | TC-S2-05/06 | 2xx/5xx stall 与整链超时统一 code=timeout |
| G-11/R-13 错误码 | TC-S2-08 | TC-S2-09 | 枚举表 + 发射 ⊆ 表 + 前端映射全覆盖 |
| R-A5（ChatView 守卫，P1）｜S3 | TC-S3-01/05 | TC-S3-02/03/04/06 | 在途写回不串会话/空间；主路径无回归；build 绿/受限记录 |
| R-A6（浏览器收口，P1）｜S4 | TC-S4-01/02/07/08 | TC-S4-03/04/05/06/09/10 | BrowserView 生效、错误态不落正文、IME 守卫、入口一致、渲染安全 |
| R-A7（三中心回归锚定）｜S8 | TC-S8-01/02/03/04/05 | TC-S8-06/07 | 套件全绿 + 主路径 + 实时/断线/隔离/渲染安全清单过 |
| R-B1（日程日历）｜S5+S6 | TC-S5-01/02/03/08/10；TC-S6-01/02/05 | TC-S5-04/05/06/07/09/11/12；TC-S6-03/04/06/07/08/09/10 | 建表幂等/API 契约/审计 SSE/scope 隔离/前端月视图最小闭环/错误态/渲染安全 |
| R-B2（通知中心）｜S7 | TC-S7-01/02/07/09 | TC-S7-03/04/05/06/08 | 真实面板/白名单/未读已读/跳转/数据同源/渲染安全 |
| R-B3（存量回归）｜S8 | TC-S8-01/08/10 | TC-S8-09 | 存量套件全绿或「环境受限+复现步骤」如实记录 |
| I-1..I-10 | 见 §1.3 门禁列 | — | 每不变量至少一组用例锚定 |
| G-8..G-14 | 见 §1.2 翻转列 | — | 按默认值展开；翻转只改对应用例期望 |
| T-076 阶段验收 1（主路径+边界+异常、每条含前置/步骤/期望） | 本文 §4 全部 84 条 | — | 每条含三类要素 + 类别 + 优先级 |
| T-076 阶段验收 2（通过/失败判据） | 每条「期望结果/通过判据」列 | — | 无黑盒描述（可用命令/断言/可观察状态表达） |
| T-076 阶段验收 3（关键规则正反向） | §5 矩阵 | — | 14 条规则成对覆盖 |

## 7. 浏览器手工验收清单模板（L2，tester 执行时逐条勾选并记录可见结果）

### 7.1 对话中心（S3 守卫回归 + R-A7）
- [ ] 新建会话 → 发消息 → 气泡即时出现（TC-S3-05）
- [ ] 第二标签同会话 ≤15s 实时收到（TC-S3-05）
- [ ] A/B 会话快速切换在途 loadOlder/send 不串显（TC-S3-02/03）
- [ ] 切空间后旧空间在途响应不回写（TC-S3-04）
- [ ] 含 <img onerror>/<script> 的消息按纯文本显示、无弹窗（TC-S3-08）
- [ ] 停中枢 → 发送 toast 错误且草稿保留 → 恢复后可重发（TC-S3-05 错误路径）

### 7.2 文件中心（R-A7 / S8-04）
- [ ] list/read/download/upload/mkdir/rename/delete 主路径走通（TC-S8-04）
- [ ] 未绑定空间显示引导、不静默落任意目录（TC-S8-04）
- [ ] 越界路径与 .git（含嵌套 subrepo/.git）访问 403（TC-S1-02 + S8-04）
- [ ] 覆盖需确认（409 提示）、删除需二次确认（TC-S8-04）
- [ ] 预览含 <script> 的文件按文本渲染不执行（FilesView 既有 TC-S5-08 语义）

### 7.3 浏览器助手（S4 收口 + R-A7）
- [ ] 私网目标显示「已拦截：禁止访问内网地址」错误视图（TC-S4-04）
- [ ] timeout / too_large / 非文本 / 4xx / 5xx 文案可区分且可重试（TC-S4-05）
- [ ] IME 中文合成态 Enter 不触发抓取（TC-S4-06）
- [ ] QuickTools「浏览网页」与侧栏「浏览器助手」进同一面板、地址栏聚焦（TC-S4-07）
- [ ] 含 <script> 的远端页按文本渲染、无弹窗（TC-S4-09）
- [ ] 历史 datalist 保留 ≤8 条、刷新保持（TC-S4-10）

### 7.4 日程日历（S6，G-13 纳入时）
- [ ] 侧栏「日程日历」进入真实月视图、今天高亮（TC-S6-01）
- [ ] 新建（标题+日期必填）保存后网格出现；刷新仍在（TC-S6-02/05）
- [ ] 删除需二次确认，取消无请求（TC-S6-04）
- [ ] 跨月切换正确（TC-S6-07）
- [ ] 切空间事件互不串；未选空间有引导（TC-S6-06）
- [ ] 停 hub → toast 错误不白屏（TC-S6-08）
- [ ] XSS 标题样本纯文本显示（TC-S6-09）

### 7.5 通知中心（S7，G-13 纳入时）
- [ ] 侧栏「通知中心」进真实面板 + badge（TC-S7-01）
- [ ] chat:* 不刷屏、任务/goal/space 类入列、scope 过滤（TC-S7-02/03）
- [ ] 点击已读 → 高亮消失 badge 减；刷新保持；per-scope 隔离（TC-S7-04）
- [ ] 任务类通知点击跳任务详情（TC-S7-06）
- [ ] devtools 确认 hub EventSource 仍唯一（TC-S7-07）
- [ ] 停 hub 错误提示、恢复正常（TC-S7-08）

## 8. 测试夹具与数据约定（供 coder 落测试 / tester 执行）

### 8.1 目录夹具树（S1 扩展；沿用 files-api.test.mjs mkdtemp 先例）

```text
tmpRoot/
  repo/                       ← 空间 local_dir（DSH_WORKBENCH_SPACES_JSON 注入 id='fx'）
    README.md  docs/guide.txt  big.log  pic.png  '中文 文件.txt'
    .git/config               ← 顶层 .git（对照 403）
    subrepo/                  ← 嵌套独立仓库
      .git/config .git/objects/pack/… .git/logs/HEAD
      README.md               ← 嵌套仓库正常文件（200 正向控制）
    sub/                      ← submodule 型：.git 是文件（gitdir: ../.git/modules/sub）
    lkg → (symlink/junction) repo/.git        ← 符号链接绕入 .git（realpath 复检）
    nonempty/ empty/  link-in→docs  link-out→outsideDir
```

- list 断言：根与 subrepo 列表不含任何以 '.' 开头的条目；subrepo 条目 isRepo=true（既有语义）。
- symlink 创建失败（Windows 权限）时，跳过用例并在 evidence 注明（既有先例）。

### 8.2 畸形 % 路径矩阵（S1，原始 socket 发送）

> 原因：Node `http.request` 会对 path 再编码；为把原始 `%zz` 送达服务端，用 `node:net` 直写原始请求行（或真进程 curl --path-as-is）。

| 样本 | 期望 |
| --- | --- |
| GET /api/files%zz HTTP/1.1 | 400/404，进程存活 |
| GET /api/files/list%zz?scope=fx | 400/404 |
| GET /api/web/fetch%zz | 400/404 |
| GET /api/fs/home%zz | 400/404 |
| GET /%zz 与 /hub%zz | 400/404（或 SPA 回退 200，进程存活即可，判据 = 非 000 + 后续 200） |
| GET '/api/files/' + '%zz'.repeat(5000) | 400/404，响应受控 |
| GET '/api/files/%00'、路径含悬空 % 组合 | 400/404（NUL/畸形），进程存活 |
| 同组 ×10 并发 | 全 4xx，进程存活 |

### 8.3 本地 mock HTTP 服务（S2/S4，禁网抓取目标）

沿用 web.test.mjs 进程内 mock，S2 追加路由：
- `/stall2xx`：writeHead(200, text/plain) 后**不 end**（挂起 body）
- `/stall5xx`：writeHead(500) 后不 end
- `/big`：content-length 大但流式（供 too_large）
- 既有 /slow /fast /404 /500 /pdf /r1/r2/loop/tofile /c1/c2 保留（回归）
- SSRF 测试注入口 DSH_WEB_FETCH_ALLOW_PRIVATE=1 **仅测试文件内**使用，生产默认关闭（先例）。

### 8.4 web 审计断言助手（S2）

```js
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
// audit 目录 = 实现导出常量（如 m.AUDIT_DIR / m.auditFile()）；ROOT=serve.mjs 静态根
const rows = (dir) => existsSync(dir)
  ? readdirSync(dir).filter(f => f.startsWith('web-audit')).flatMap(f =>
      readFileSync(join(dir, f), 'utf8').trim().split('
').filter(Boolean).map(l => JSON.parse(l)))
  : []
// 断言字段：row.url / row.finalUrl / row.status / typeof row.ms === 'number' / row.by === 'general'
// ROOT 外断言：!path.resolve(rowDir).startsWith(path.resolve(root) + sep)
```

### 8.5 calendar 契约样本（S5）

```js
// 创建
POST /api/calendar/events  { scope:'software', title:'评审会', start:'2026-08-20T10:00', by:'general' }
// 合法边界：title=100 字符 / end 可省 / allDay:true / end=start
// 非法：缺 by；title ''；title 101 字符；start ''；start '2026-13-99'；end < start
// 删除（H-2 契约）
POST /api/calendar/events/delete { id: 3, confirm:'yes', scope:'software', by:'general' }
// 日期窗（闭区间）
GET /api/calendar/events?scope=software&from=2026-08-01&to=2026-08-31
```

### 8.6 env / token / 端口约定

| 用途 | env/参数 | 说明 |
| --- | --- | --- |
| hub 临时库/端口 | TEAM_HUB_DB / TEAM_HUB_PORT（默认 8787）/ TEAM_HUB_HOST | chat/calendar/skills 测试临时库 import；L1 真服务起临时端口 |
| hub 写 token | TEAM_HUB_TOKEN（非空时写需 Bearer） | calendar 写经 handleWrite（authorized），S5 鉴权随既有语义 |
| serve 端口/host | DSH_WORKBENCH_PORT / DSH_WORKBENCH_HOST（默认 127.0.0.1:5173） | L1 真进程 |
| serve 空间注入 | DSH_WORKBENCH_SPACES_JSON=[{id,localDir}] | files 免起中枢（先例见 files-api.test.mjs 头注） |
| serve 写 token/上限 | DSH_WORKBENCH_TOKEN / DSH_WORKBENCH_MAX_UPLOAD | 三值法上限 |
| 测试放开私网 | DSH_WEB_FETCH_ALLOW_PRIVATE=1 | 仅 web.test.mjs 内使用 |
| 审计轮转（拟） | DSH_WEB_AUDIT_MAX_KB（⚖️） | S2-04 三值法 |

## 9. 附录

### 附录 A：取代声明
- 本文档取代 docs/TEST_CASES.md（T-039 第一批版）。第一批三中心已交付，其执行记录见 docs/TEST_REPORT.md 与各 T0xx-evidence/；旧用例供回归参考经 git 历史回溯（`git log --follow docs/TEST_CASES.md`；`git show 6e775e3:docs/TEST_CASES.md`）。
- 批次编号冲突说明：TASK_BREAKDOWN 本批 S1~S8 与第一批 S1~S8 编号相同但内容不同；**以本文档追溯列（R-Ax / Sx 验收）为准**，历史测试文件头注释的 TC 编号指第一批，不再维护。

### 附录 B：测试代码落点骨架（coder 落盘时照此；断言细则以 §4「期望结果/通过判据」列为准；P0 用例必须各有一条对应 it()）

**S1 → files-api.test.mjs（追加 describe，重命名旧 TC-S3-12 为回归对照）：**
```js
describe('S1 R-A1 嵌套 .git 防护矩阵（read/download/list/写面 × 样本）', () => {
  it('read/download 嵌套 subrepo/.git/config → 403 且零字节', async () => { /* HTTP：read 断言 res.status===403；download 断言非 200 且 body 不含 [core] */ })
  it('写面 upload/mkdir/rename/delete 指向 .git 内部 → 403 且零副作用', async () => { /* before/after readdir+stat 对照 */ })
  it('大小写变体 .GIT / subrepo/.Git → 403', async () => {})
  it('.git 文件（submodule 指针）与 symlink→.git realpath 复检 → 403', async () => {})
  it('正向控制：subrepo/README.md read 200（防护不误伤）', async () => {})
})
describe('S1 R-A2 畸形 percent-encoding（原始 socket；进程存活）', () => {
  it('单发 /api/files%zz → 4xx，紧接正常请求 200', async () => { /* net 直写 + 跟随请求 */ })
  it('10 并发畸形 → 全 4xx、进程存活、无 URIError stderr', async () => {})
  it('超长/重复 %/NUL 矩阵 → 响应受控、进程存活', async () => {})
})
```

**S2 → web.test.mjs（追加 describe）+ workbench/.gitignore 增 data/：**
```js
describe('S2 R-A3 抓取审计留痕', () => {
  it('成功 fetch 后审计行含 url/finalUrl/status/ms/by=general', async () => { /* 读 m.AUDIT_FILE 断言 JSON */ })
  it('ssrf_blocked/timeout/too_large/http_500 均留痕（无痕=FAIL）', async () => {})
  it('审计文件在 ROOT 外且 GET 不可达', async () => {})
  it('轮转：注入小上限后多行仍可追加、总量受控', async () => {})
  it('invalid_url 不产生审计行（未发起抓取）', async () => {})
})
describe('S2 R-A4 body stall 统一归类', () => {
  it('2xx headers 已回 body 挂起 → {ok:false,code:"timeout"}', async () => { /* mock /stall2xx */ })
  it('5xx body 挂起 → 同样 code=timeout（非 http_500）', async () => {})
  it('整链共享 deadline 慢链 → code=timeout（回归 P0-3）', async () => {})
})
describe('S2 G-11 错误码枚举收口', () => {
  it('导出枚举表含全部码；场景矩阵产出 code ⊆ 表', async () => {})
})
```

**S5 → team-hub/calendar.test.mjs（新增；仿 chat.test.mjs 临时库 import）：**
```js
// before: TEAM_HUB_DB=临时 → import './server.mjs'
describe('S5 calendar_events 建表幂等 + 旧库自动建表', () => { /* sqlite_master 断言 */ })
describe('S5 create/list/delete 契约 + scope 隔离', () => {
  it('创建合法事件 → 200/字段形状/audit calendar:create', () => {})
  it('scope 过滤 + 日期窗闭区间 + 排序', () => {})
  it('反向隔离：marketing 列表不含 software 事件', () => {})
  it('非法输入矩阵 → 400 零落库零 audit', () => {})
  it('删除需 confirm=yes 且 scope 越权拒绝；确认后 audit calendar:delete', () => {})
  it('旧库 import 后 chat/skills 数据完整（回归照跑）', () => {})
})
```

**S3/S4/S6/S7**（前端，无 test runner）：以 §7 清单 + 评审断言为准；若 coder 抽纯函数（如会话守卫判定 / isErrorResult / normalizeUrl / 游标计算），在同一文件域内新增 `.mjs` node --test 并把函数导出（chat 守卫抽到新文件属 S3 文件域许可，见 TASK_BREAKDOWN S3 注）。

### 附录 C：机器复核（本文件自检）
- 用例计数、类别分布、追溯引用完整性、正反向矩阵与 §4 的 ID 一致性：以执行 `node docs/scripts-… ` 之类的复核为准——本阶段已用一次性 Node 脚本核对（计数/ID 唯一/矩阵 ID 存在），结果写入 docs/T076-evidence/（若有差异以脚本复核为准，表内为设计值）。
- 行数/计数（T-076 阶段 AC 用）：S1 13 / S2 12 / S3 8 / S4 10 / S5 12 / S6 10 / S7 9 / S8 10 = 84。

### 附录 D：风险与开放项
- R-11 同文件域串行（serve.mjs S1→S2、App/Sidebar S4→S6→S7）：用例按切片归属文件，coder 不越域写测试文件。
- R-12 G-13 门：S5/S6/S7 用例在将军裁决前按「纳入」展开；不纳入则删 §4.5..4.7 与 §5/§6 对应行。
- R-13 错误码三方对齐：以 S2 枚举表为唯一基准，S4 合入时复核前端映射；测试以枚举表为准（TC-S2-09）。
- R-14 嵌套 .git 口径：H-3（段级大小写不敏感 + realpath 复检 + list 隐藏）。测试者执行时可复核并注释，不改判据。
- R-15 通知噪音/游标：chat:* 排除；已读游标 per-scope localStorage（跨标签不同步为 v1 接受，README 注明）。
- R-17 审计文件安全：data/ 位于 ROOT 外 + 轮转 + .gitignore（TC-S2-03/04/12）。
- R-18 环境受限：本 worktree 无 node_modules/dist、vite build EPERM 史、board-plugin 宿主注入 —— 一律记录「环境受限 + 复现步骤」，不冒充通过（TC-S8-02/08 + 各 build 用例）。
- ❓ 假设待将军/下游复核：H-2（calendar 删除端点契约归属 S5）、H-5（审计轮转默认 1 MiB + env 名）、OQ-7（200-envelope）；均为本文件内可单点修改的用例形状/默认值，不影响其余。

---
（本文档由 T-076 test-designer 产出；只写用例与落点，不写业务实现、不执行用例——执行为 tester 职责。）

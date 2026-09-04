# T-075 任务拆解：交付剩余 Legion 军团指挥团任务（第二批：三中心收尾 · 平台剩余功能）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-075（分支 w/T-075 独立 worktree，HEAD = 615465e promote T-074）
> 上游：T-073 需求澄清（docs/REQUIREMENTS.md，唯一权威需求基线）→ T-074 方案搜索（docs/RESEARCH.md：决策域 J1~J9 一等推荐 + 新增闸门 G-8..G-14 + §11.1 按文件域切片建议）
> 下游：test-designer（docs/TEST_CASES.md）→ 守护解析本文件「## slices」注册 coder_Si→tester_Si 微链 → 逐切片开发/测试 → devops 目标级收尾
> 依据：LEGION.md 纪律、本任务验收标准与边界、REQUIREMENTS §4.2 不变量 I-1..I-10 / §5 需求 R-A1..R-C3、RESEARCH §11 一等选型与闸门 G-8..G-14（默认值即一等，将军未否决即按默认放行）。
>
> **取代关系**：本文档**取代**同文件 T-038 拆解（第一批「三中心从零建造」产物，其 S1~S8 已交付合入 main，仅遗留缺陷与收口在本批处理）。T-038 旧版经 git 历史回溯（`git log --follow docs/TASK_BREAKDOWN.md`）。本批范围/优先级/验收口径一律以 REQUIREMENTS.md 为准；方案细节以 RESEARCH.md 为准（本拆解不重复论证，只引用）。

## 0. 结论速览

- 拆解产物：**8 个切片（S1~S8）**，其中：
  - **Part A 三中心收尾（P0/P1，必做 5 片）**：S1（serve.mjs 文件面 F1+F2）、S2（serve.mjs 浏览器后端 A3+A4）、S3（ChatView 会话守卫 A5）、S4（浏览器前端收口 A6 = 合入 w/T-051）、S8（集成回归锚定 A7/B3）。
  - **Part B 平台剩余（P1，3 片，受闸门 G-13 = 将军 OQ-3 约束）**：S5（日程日历后端）、S6（日程日历前端）、S7（通知中心）。→ 若将军裁定 B1/B2 不纳入本批，请在验收本文档时评论说明，删除 S5/S6/S7 三行即可（守护按文件当前内容注册，S8 不受影响）。
- 全批**零新增运行时依赖**（一等选型全部 Node 内置 / 自研 / 沿用 w/T-051）；第三方日历/通知/markdown 库一律不引入（闸门 G-14）。
- **文件域纪律（并行合入安全的前提）**：同文件只允许 1 个切片持有；仅两处例外并靠**注册顺序 = 派工顺序（当前生产单 worker）**串行化：
  - serve.mjs 串行链：**S1 → S2**（S2 blockedBy S1，同文件域）。
  - 前端壳串行链：**S4 → S6 → S7**（三者均改 App.tsx，S6/S7 还改 Sidebar.tsx；S6 另需 S5 的后端 API 合入）。
  - **禁止**在提升并发槽位后同时派工同文件域的相邻切片（详见 §2 与 §5 R-11）。
- 决策闸门 G-8..G-14（RESEARCH §11.2）默认全部采纳：G-8 段级+realpath .git 复检且 list 默认隐藏嵌套 .git 条目；G-9 顶层整体 try/catch + URIError→400；G-10 web fetch 审计=本地 JSONL+console；G-11 错误码枚举常量表收口（三方对齐）；G-12 A6 沿用 w/T-051 合入；G-13 B1/B2 按将军 OQ-3（本拆解默认纳入并排在必做面之后）；G-14 不引入第三方库。

## 1. 机器可读切片清单（守护据此注册并行派工，逐行严格遵循）

## slices
- S1 | serve.mjs 文件面加固：嵌套 .git 防护+畸形路径防崩溃（R-A1、R-A2） | workbench/scripts/serve.mjs, workbench/scripts/files-api.test.mjs | node --test workbench/scripts/files-api.test.mjs 全绿（新增嵌套 .git 矩阵：subrepo/.git/config 的 list/read/download/upload/mkdir/rename/delete 均 403 或拒绝，顶层 .git 对照仍拒绝，符号链接指向 .git 内部经 realpath 复检拒绝）;畸形 percent-encoding 注入（/api/files%zz 等）返回 400/404 且进程存活（同进程后续请求 200，≥10 并发畸形请求不崩，测试/脚本断言）;files-api.test.mjs 既有 34 例基线不回归;零新增运行时依赖（evidence 附 package.json 无新增项）
- S2 | serve.mjs 浏览器后端：抓取审计留痕+body stall 归类（R-A3、R-A4） | workbench/scripts/serve.mjs, workbench/scripts/web.test.mjs, workbench/.gitignore | node --test workbench/scripts/web.test.mjs 全绿（既有 12 例基线不回归）;成功与失败（ssrf_blocked、timeout、too_large、http_<n>）抓取均留痕：web-audit.jsonl（静态 ROOT 之外）追加行含 url、finalUrl、status、耗时 ms、by=general;body stall 夹具（headers 已回、body 挂起）→ 响应 {ok:false, code:timeout}，整链超时同码，错误码枚举常量表收口（web.test 断言枚举含 timeout 等）;审计文件容量轮转生效且 workbench/.gitignore 含 data/ 条目;node --test workbench/scripts/files-api.test.mjs 仍全绿（serve.mjs 读面未破坏）
- S3 | ChatView 会话/空间身份守卫（R-A5） | workbench/src/components/ChatView.tsx | pnpm build（workbench 目录）全绿（tsc --noEmit 零错误；EPERM 环境受限时记录复现步骤并附 tsc 结果）;评审+grep 证据：loadOlder/send 异步写回前比对发起时 convId 与 activeRef 当前值，不匹配仅复位 loading/sending 并丢弃合并，无无条件 setMsgs 残留;浏览器验收（serve.mjs 托管 + hub，:5173）：A/B 会话快速切换在途 loadOlder/send 不串显，切空间旧响应不回写，新建会话→发消息→第二标签 ≤15s 实时收到主路径无回归;零新增依赖（package.json 无变更）
- S4 | 浏览器前端收口：合入 w/T-051 为 BrowserView（R-A6） | workbench/src/components/BrowserView.tsx, workbench/src/components/BrowserPanel.tsx, workbench/src/App.tsx | 合入（优先 cherry-pick a524951 或应用 git diff main...w/T-051；分支不可用按 RESEARCH §7 J6-B 重做）：BrowserView.tsx 存在、BrowserPanel.tsx 移除、App.tsx 浏览器分支渲染 BrowserView;pnpm build 全绿（受限时记录 EPERM 复现 + tsc 结果）;grep/评审：App.tsx 无 BrowserPanel 引用，BrowserView 以 isErrorResult 将 too_many_redirects/web_error/http_*/timeout 归错误态、errorText 全错误码映射、成功与失败可区分可重试;IME 中文输入中间态按 Enter 不触发抓取（评审关键行）；QuickTools「浏览网页」与侧栏「浏览器助手」进入同一面板（active=browser）;浏览器主路径冒烟（地址栏→正文/错误态）无回归
- S5 | 日程日历后端：team-hub 扩表扩 API（R-B1 数据面，G-13 门） | team-hub/server.mjs, team-hub/calendar.test.mjs | node --test team-hub/chat.test.mjs 与 node --test team-hub/skills.test.mjs 全绿（既有模块不回归）;node --test team-hub/calendar.test.mjs 全绿（新增，临时库 import 不占端口）：calendar_events 建表幂等（旧库自动建表），GET /api/calendar/events（scope 过滤+日期窗）与 POST 创建（by 缺失 400、非法时间/超长标题拒绝、scope 隔离互不可见），写走 handleWrite 产生 audit（action=calendar:*）与 SSE 广播;curl 冒烟（临时 TEAM_HUB_DB+真端口）：POST 事件→GET 列表日期窗正确→/api/activity?scope= 可查 calendar:* 审计;零新增依赖（team-hub/package.json 无变更，仅 node:sqlite）
- S6 | 日程日历前端：自研月视图面板+接线（R-B1 视图面，G-13 门） | workbench/src/components/CalendarView.tsx, workbench/src/App.tsx, workbench/src/components/Sidebar.tsx, workbench/src/index.css | pnpm build 全绿（受限时记录+tsc）;侧栏「日程日历」点击进入真实月视图面板（非 toast 占位）：当月 7×N 网格、今天高亮、可跨月切换，未选具体空间给引导（与对话中心一致）;最小闭环浏览器验收（:5173）：新建条目（标题+日期必填、时间可选）保存后网格出现，删除需二次确认，刷新后仍在（数据=GET /api/calendar/events，scope=当前空间）;切换空间事件随之切换互不串；hub 不可达/校验失败 toast 错误提示;条目文本纯文本渲染（grep 无 dangerouslySetInnerHTML 直插服务端数据）；chat/files/browser 面板无回归
- S7 | 通知中心：audit 派生面板+接线（R-B2，G-13 门） | workbench/src/components/NotifyView.tsx, workbench/src/api.ts, workbench/src/App.tsx, workbench/src/components/Sidebar.tsx | pnpm build 全绿（受限时记录+tsc）;侧栏「通知中心」点击进入真实面板（非 toast 占位），badge 未读数 >0 显示，列表含时间/scope/来源 action，未读高亮、点击已读（localStorage per scope，刷新保持）;数据同源：列表=GET /api/activity（scope 过滤+action 白名单，chat:* 默认排除）+SSE /api/events 增量复用 subscribeHubAudit/既有端点，评审断言无第三数据源、无新增 hub 事件连接；已读不写 audit;任务/目标类通知点击跳转任务详情/对应面板（复用既有导航）；错误路径 toast;渲染安全（无 dangerouslySetInnerHTML 直插）+ chat/files/browser/calendar 面板无回归
- S8 | 三中心集成回归锚定（R-A7、R-B3 仓库内可跑部分） | docs/TEST_REPORT.md | 逐套件运行并记录输出要点：node --test workbench/scripts/files-api.test.mjs、web.test.mjs、team-hub/chat.test.mjs、team-hub/skills.test.mjs、team-hub/calendar.test.mjs、tests/contract/contracts.test.mjs、whiteboard 套件全绿（失败=0，记录用例数）;pnpm build（workbench）全绿或按 R-18 记录环境受限复现步骤;三中心主路径清单走通并写入 docs/TEST_REPORT.md：对话双标签 ≤15s 实时+断线自动重连+纯文本渲染；文件 list/read/download/upload/mkdir/rename/delete 走通+未绑定空间引导+越界与 .git 403+overwrite/confirm 语义；浏览器 SSRF 拦截文案「已拦截：禁止访问内网地址」+错误可区分（限长/超时/非文本/4xx-5xx）+结果文本渲染不直插远端 HTML;board-plugin 按 README 验证（typecheck/build+宿主注入冒烟）；宿主不可达记录「环境受限+复现步骤」不冒充通过

## 2. 依赖关系、执行顺序与并行（给人看）

### 2.1 blockedBy 一览（同文件域 = 硬串行；跨域 = 可并行）

| 切片 | blockedBy（按注册序执行时） | 依赖理由 |
| --- | --- | --- |
| S1 | 分析前缀（G-8/G-9 默认） | serve.mjs 域链起点（P0 安全/DoS 优先） |
| S2 | **S1**（同 serve.mjs 域，硬串行） | 与 S1 同文件叠加必冲突 |
| S3 | 分析前缀 | 独立 ChatView.tsx 域，域不相交可并行 |
| S4 | 分析前缀（建议排在 S1~S3 后取基线） | 前端壳链（App.tsx）起点；w/T-051 合入 |
| S5 | 分析前缀（G-13 确认后） | team-hub 域与一切不相交，可与 S1~S4 并行 |
| S6 | **S4**（App.tsx 域）+ **S5**（需 /api/calendar/events 合入可验） | 面板接线依赖既有 App 壳与后端 API |
| S7 | **S6**（App.tsx/Sidebar.tsx 域串行） | 与 S6 同壳文件叠加必冲突 |
| S8 | S1~S7 全部 done | 回归锚定必须在收口后执行 |

**无循环依赖**：所有边沿「后端/服务加固 → 前端 → 集成回归」方向，且同文件域链为线性（S1→S2；S4→S6→S7），不存在回边。

### 2.2 执行顺序与并行建议

- **默认安全路径（当前生产守护 maxWorkers=1，按注册顺序单 worker 派工）**：S1→S2→S3→S4→S5→S6→S7→S8。注册顺序即派工顺序，本清单已按此排好。
- **若将军提升并发槽位（maxWorkers≥2）**：仅允许派工**文件域两两不相交**的组合，例如 {S1, S3}、{S1, S5}、{S3, S4}、{S3, S5}、{S4, S5} 中任取（每对域不相交）。**严禁**把 S1 与 S2、或 S4/S6/S7 中任两个同时派工（同文件域并行 = 自动合入冲突 → 打回将军，违背本批零返工目标）。S8 永远最后。
- S5（team-hub 域）与前端壳链（S4/S6/S7）互不干扰，可在后端先行后随时并行；S6 的前端验收需要 hub 带 /api/calendar/events 运行（S5 合入后）。

## 3. 子任务明细（每切片 = 一个士兵一轮可完成并验收；「验收」以 §1 机器行逐条为准）

工作量刻度：S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满。

---

#### S1 serve.mjs 文件面加固：嵌套 .git 防护 + 畸形路径防崩溃（R-A1/F1 + R-A2/F2）【P0 必做】

- **目标**：按 RESEARCH J1-A + J2-A 修复两处「必须修改」级缺陷——① `assertNotGitInternal`（serve.mjs:209）由「仅拦首段 .git」升级为「任一层段 .git 即拒 + realpath 后复检（防符号链接绕入 .git 内部）」，list/read/download/upload/mkdir/rename/delete 9 处调用点签名不变（:274/301/327/339/352/381/390/391/407）；② createServer 回调（:942 起，含 :944 decodeURIComponent）整体 try/catch 兜底，URIError→400，任何畸形输入进程绝不死（落实 I-9）。
- **产出（文件域）**：`workbench/scripts/serve.mjs`、`workbench/scripts/files-api.test.mjs`（追加嵌套 .git 矩阵 + 畸形路径注入 + 进程存活断言）。
- **依赖**：分析前缀；G-8/G-9 默认。
- **工作量**：M（1 轮）。
- **完成 =（DoD）**：files-api.test.mjs 新增用例全绿 + 既有 34 例不回归 + 畸形并发不崩（真实命令输出为证）= 完成；无需前端。
- **测试锚点（test-designer 直转）**：嵌套仓库路径矩阵（subrepo/.git/config、.git/objects、submodule .git 文件、符号链接→.git 内部）、顶层 .git 对照、Windows 大小写 .GIT（建议比较前 toLowerCase）、写面同强度、畸形 % 注入矩阵（%zz、超长 ≥1 万字符、重复 %）、10 并发不崩、进程存活后续 200。
- **纪律**：只改上述两文件；如需在 README 说明守卫语义属可接受文档更新（README 不列入任何切片域，冲突仅文档级）。

#### S2 serve.mjs 浏览器后端：抓取审计留痕 + body stall 归类（R-A3 + R-A4）【P0/P1 必做】

- **目标**：按 RESEARCH J3-A + J4-A —— ① /api/web/fetch（handleWebApi :809-821）每次抓取（成功/失败/拦截皆算）append 一行 JSONL 到**静态 ROOT（serve.mjs:26=workbench/dist）之外**的数据目录（如 `workbench/data/web-audit.jsonl`）+ console 一行，含 ts/by=general/url/finalUrl/status/code/ms；按容量轮转；workbench/.gitignore 追加 data/。② body stall（headers 已回、body 挂起超时，readBodyLimited :730-743）与整链超时统一归类 code=timeout（以 ac.signal.aborted 状态判据，不按错误 message 匹配）；错误码枚举（invalid_url/protocol_blocked/ssrf_blocked/too_many_redirects/timeout/too_large/fetch_error/http_<n>/unsupported/empty_content/web_error）抽常量表收口（顺带修 w/T-051 前端映射含后端不发出码的漂移）。
- **产出（文件域）**：`workbench/scripts/serve.mjs`、`workbench/scripts/web.test.mjs`（追加留痕/body-stall/枚举用例）、`workbench/.gitignore`。
- **依赖**：S1（同 serve.mjs 域硬串行）。
- **工作量**：M（1 轮）。
- **完成 =（DoD）**：web.test.mjs 新增用例全绿 + 既有 12 例不回归 + files-api.test.mjs 全绿 + 审计行可查（含失败/拦截留痕）= 完成。
- **测试锚点**：留痕字段形状（url/finalUrl/status/ms/by）、ssrf_blocked/timeout/too_large/http_<n> 皆留痕、审计文件位于 ROOT 外不可被 GET、轮转生效、body-stall 夹具→code=timeout、整链超时同码、错误码枚举表与前端映射对齐。

#### S3 ChatView 会话/空间身份守卫（R-A5/S2-M1）【P1 必做】

- **目标**：按 RESEARCH J5-A —— loadOlder（ChatView.tsx:160-168）与 send（:239-248）异步写回 setMsgs/setDraft 前，比对「发起时 convId/scope」与 `activeRef.current`（:49-51，既有）当前值；不匹配则仅复位 loadingOlder/sending 并丢弃合并（不污染当前视图）。复用既有 cancelled flag 模式（:71-91/:103-113）；不改变协议与数据流。
- **产出（文件域）**：`workbench/src/components/ChatView.tsx`。
- **依赖**：分析前缀（域独立，可并行）。
- **工作量**：S-M（≈1 轮）。
- **完成 =（DoD）**：守卫实现 + 构建绿 + A/B 会话快速切换/切空间浏览器验收不串显 + 主路径无回归 = 完成。
- **测试锚点**：A/B 快速切换在途 loadOlder/send、切空间旧响应不回写、新建→发→实时收主路径、（可选）纯逻辑抽函数供 node --test（若抽新文件，请在本切片文件域内创建，勿越域）。

#### S4 浏览器前端收口：合入 w/T-051 为 BrowserView（R-A6/S7 收口）【P1 必做】

- **目标**：按 RESEARCH J6-A（G-12 默认）—— 合入 w/T-051 分支（提交 a524951 已验证）：BrowserPanel.tsx → BrowserView.tsx（命名对齐 ChatView/FilesView）、errorText 全错误码映射、isErrorResult 把 too_many_redirects/web_error/http_*/timeout 归错误态（不落正文分支）、IME 中文中间态 Enter 守卫、App.tsx:355-356 浏览器分支改渲染 BrowserView（import 同步）。分支不可用则按 J6-B 在 main 重做同款（验收同）。
- **产出（文件域）**：`workbench/src/components/BrowserView.tsx`、`workbench/src/components/BrowserPanel.tsx`（移除）、`workbench/src/App.tsx`。
- **依赖**：建议在 S1~S3 合入后执行（取稳定基线）；App.tsx 域与 S6/S7 硬串行（本片最先）。
- **工作量**：S（≈0.5 轮：合入 + 复核，自带 evidence docs/T051-evidence/）。
- **完成 =（DoD）**：BrowserView 生效且 App.tsx 无 BrowserPanel 引用 + build 绿 + 错误态/IME 守卫经评审与浏览器冒烟确认 = 完成。
- **测试锚点**：错误态判定矩阵（too_many_redirects/web_error/http_*/timeout 归错误分支；成功态可重试）、IME 守卫、入口一致性（QuickTools「浏览网页」/侧栏「浏览器助手」active=browser）。

#### S5 日程日历后端：team-hub 扩表扩 API（R-B1 数据面）【P1 · G-13 门，将军 OQ-3 确认后派工】

- **目标**：按 RESEARCH J7-A —— team-hub/server.mjs 仿既有 chat 路由（:1633-1666）与 ensureColumn 先例（:246）新增 `calendar_events(id, scope, title, start, end?, allDay?, meta JSON, createdAt, updatedAt)` 幂等建表 + `GET /api/calendar/events?scope=&from=&to=`（scope 过滤 + 日期窗）与 `POST /api/calendar/events`（写走 handleWrite：by 必填 + audit action=calendar:* + SSE /api/events 广播，机制复用 audit() :413-415 与事件流 :1807-1817）。
- **产出（文件域）**：`team-hub/server.mjs`、`team-hub/calendar.test.mjs`（新增，仿 chat.test.mjs：临时库 import server.mjs，不占端口）。
- **依赖**：分析前缀 + G-13（将军确认纳入）；域独立可并行。
- **工作量**：M（1 轮）。
- **完成 =（DoD）**：calendar.test.mjs 全绿 + chat/skills 测试不回归 + curl 冒烟（POST→GET 日期窗→audit 可查）= 完成。
- **测试锚点**：scope 隔离互不可见、日期窗边界、by 必填 400、非法时间/超长标题拒绝、旧库自动建表幂等、audit 记录与 SSE 载荷（kind=calendar:*）。

#### S6 日程日历前端：自研月视图面板 + 接线（R-B1 视图面）【P1 · G-13 门】

- **目标**：按 RESEARCH J7-D —— 自研 CSS grid 月视图（7×N 周网格 + 今天高亮 + 跨月切换），复用既有 Toast/Modal/按钮样式与 index.css token；点击侧栏「日程日历」（Sidebar.tsx:21/79 现为占位 toast）进入真实面板：App.tsx:348-359 分支链加 `active==='calendar'` 分支渲染 CalendarView（active 状态为 `useState('home')`，App.tsx:59，无需改 types.ts），Sidebar.tsx clickModule（:68-80）把 calendar 加入 onNavigate 面板分支；未选具体空间引导先选（与 ChatView 语义一致）；条目渲染纯文本（I-5）；scope=当前空间经 GET /api/calendar/events 读写。
- **产出（文件域）**：`workbench/src/components/CalendarView.tsx`（新增）、`workbench/src/App.tsx`、`workbench/src/components/Sidebar.tsx`、`workbench/src/index.css`（月视图网格样式）。
- **依赖**：S4（App/Sidebar 域串行）+ S5（后端 API 合入后方可联调验收）。
- **工作量**：L（1 轮满）。
- **完成 =（DoD）**：侧栏进入真实月视图 + 创建/删除最小闭环浏览器走通 + scope 切换/空态/错误态明确 + build 绿 + 三中心无回归 = 完成。
- **测试锚点**：月网格渲染/今天高亮/跨月、标题+日期必填校验、删除二次确认、刷新持久、scope 切换隔离、未绑定/未选空间引导、hub 不可达错误提示、渲染安全 grep。

#### S7 通知中心：audit 派生面板 + 接线（R-B2）【P1 · G-13 门】

- **目标**：按 RESEARCH J8-A（纯前端派生，后端零改动）—— 新面板 NotifyView：列表 = GET /api/activity（api.ts:280 fetchActivity 既有，按 scope 过滤 + action 白名单：任务 claim/transition/advance/review-note/test-report/patch/evidence/artifact、goal:publish、space:* 等；**chat:* 默认排除防刷屏**）；实时增量 = 复用 api.ts:489-500 `subscribeHubAudit`（单一 /api/events，I-8）；未读数 = 已读游标之后的新审计条数（localStorage per scope）；已读不写 audit；点击任务/目标类通知跳转任务详情（复用既有 TaskDetailModal 导航）；侧栏「通知中心」点击进真实面板 + badge 未读数（Sidebar.tsx:63 已有计数先例，改为通知未读数）；Sidebar/App 接线方式同 S6。
- **产出（文件域）**：`workbench/src/components/NotifyView.tsx`（新增）、`workbench/src/api.ts`（如仅需白名单/游标辅助函数可加于此）、`workbench/src/App.tsx`、`workbench/src/components/Sidebar.tsx`。
- **依赖**：S6（App/Sidebar 域硬串行）。
- **工作量**：M-L（≈1 轮）。
- **完成 =（DoD）**：侧栏进入真实面板 + 列表/未读/已读游标闭环 + badge + 点击跳转 + 数据同源评审通过 + build 绿 = 完成。
- **测试锚点**：action 白名单过滤（含 chat:* 排除）、未读计数增减、已读游标 per-scope 持久、点击跳转、无第三数据源（评审）、渲染安全 grep。

#### S8 三中心集成回归锚定（R-A7 + R-B3 仓库内可跑部分）【P1 收尾】

- **目标**：S1~S7 全部合入后，按 REQUIREMENTS R-A7 与 R-B3 执行全量回归并沉淀 docs/TEST_REPORT.md：既有契约套件（files-api/web/team-hub chat+skills+calendar/contracts/whiteboard）全绿 + workbench pnpm build + 三中心浏览器主路径/实时/断线/隔离/渲染安全清单 + board-plugin 宿主注入（不可达按「环境受限+复现步骤」记录，不冒充通过）。
- **产出（文件域）**：`docs/TEST_REPORT.md`（追加本批结论；本片为验证型，源码零改动）。
- **依赖**：S1~S7 全部 done（注册序最后）。
- **工作量**：M（tester 视角 1 轮；只测不修，失败项走 fix 回炉）。
- **完成 =（DoD）**：全量命令输出记录齐全且失败=0（或环境受限项如实标注）+ docs/TEST_REPORT.md 结论 = 完成。
- **测试锚点**：直接取 §1 S8 验收行与 REQUIREMENTS R-A7 验收 1~4。

## 4. 需求 → 切片覆盖矩阵（无遗漏核对）

| 需求（REQUIREMENTS §5 / §2.3） | 切片 | 归属说明 |
| --- | --- | --- |
| R-A1（F1 嵌套 .git 泄密，P0） | S1 | ✅ |
| R-A2（F2 畸形路径崩溃，P0） | S1 | ✅ |
| R-A3（抓取审计留痕，P0） | S2 | ✅ |
| R-A4（body stall 归类，P1） | S2 | ✅ |
| R-A5（ChatView 串显，P1） | S3 | ✅ |
| R-A6（浏览器前端收口，P1） | S4 | ✅ 沿用 w/T-051 |
| R-A7（三中心主路径回归锚定，P1） | S8 | ✅ |
| R-B1（日程日历，P1） | S5 + S6 | ⚠️ G-13 门（默认纳入，排在必做面后） |
| R-B2（通知中心，P1） | S7 | ⚠️ G-13 门 |
| R-B3（存量回归 R-1，P1） | S8（仓库内可跑部分） | board-plugin 宿主部分按「环境受限」记录 |
| R-B4（双账本收敛，P2） | —（不拆 coder slice） | 架构收敛/迁移，归属 devops/将军定时机（REQUIREMENTS §9 OQ-5）；T-073 附录 A 登记，非悬空 |
| R-B5（旧文档归档，P2） | —（不拆 coder slice） | 文档整理，随各阶段产物更新一并处理（各切片 DoD 已含受影响文档更新） |
| R-C1（候选增强 X-1~X-5，P2） | —（默认不做） | 将军勾选才拆；前置 = 本地盘点、缺失即 blocker（G-14） |
| R-C2（生产发布，P2） | —（devops 尾） | 发布需将军批准；本批交付「可发布状态」，由守护生成的 devops 目标级收尾承接 |
| R-C3（环境构建链路，P2） | —（宿主/CI 侧） | vite build EPERM 等按「环境受限+复现步骤」记录，不冒充通过 |

## 5. 风险与假设

- **R-11（同文件域串行纪律）**：serve.mjs 链 S1→S2、前端壳链 S4→S6→S7 靠**注册顺序**串行；若将军调高守护并发（maxWorkers/coderSlots≥2），请勿同时派工同文件域切片（见 §2.2 允许组合）。提升并发前建议先合入本文档并确认守护按序派工。
- **R-12（G-13 门控）**：S5/S6/S7 默认纳入但依赖将军 OQ-3 裁决；若裁定不纳入，删 §1 中对应行即可（守护按文件当前内容注册）。若裁定纳入但要求减少切片数，可将 S5+S6 合成一片（calendar 后端+前端同片，工作量 L）并把 S7 顺延。
- **R-13（错误码漂移）**：S2 的枚举常量表收口需与 w/T-051 前端映射（errorText/isErrorResult）三方对齐（含后端不发出的 dns_error 等），S4 合入时复核；测试以枚举表为准。
- **R-14（嵌套 .git 口径）**：list 默认隐藏嵌套 .git 条目（G-8 默认）；符号链接→.git、Windows 大小写、submodule .git 文件均入 S1 用例矩阵，tester 定口径。
- **R-15（通知噪音/游标）**：chat:* 默认排除；已读游标 localStorage per scope 跨标签不同步（v1 单浏览器可接受，README 注明）。
- **R-16/R-17（日历扩展成本/审计安全）**：自研月视图后续拖拽/时区属 v2；JSONL 必须置于静态 ROOT 外 + 容量轮转（S2 验收含此断言）。
- **R-18（环境受限）**：vite build EPERM / worktree 无 node_modules / board-plugin 宿主注入 —— 沿用仓库纪律：按「环境受限+复现步骤」如实记录，不冒充通过；S8 汇总。
- **假设**：G-8..G-14 默认采纳（将军未否决）；测试运行命令以 `node --test <file>`（直跑 `node <file>` 等效）与 `pnpm build`（workbench）为准；本批全部零新增依赖。

## 6. 本阶段验收对照（breaker 自拟，逐条对应任务验收）

- **AC-1（拆成可独立认领、独立验收的子任务）**：§1 机器行 8 切片，每片 = coder_Si→tester_Si 垂直单元，验收标准逐条可测（命令+期望）。✅
- **AC-2（每子任务带 验收标准+依赖+工作量）**：§1 验收标准 + §2.1 blockedBy + §3 工作量/DoD。✅
- **AC-3（完成=什么 的可测口径，不留黑盒）**：每片 DoD 均写成「命令/行为 + 可观察结果」；环境受限项显式标注，不冒充通过。✅
- **AC-4（顺序/并行明确，无循环依赖无遗漏）**：§2 顺序/并行 + §4 覆盖矩阵（R-A1..R-B3 全覆盖，R-B4/B5/C1/C2/C3 显式标注归属与触发，不拆悬空任务）。✅
- **边界遵守**：本阶段只产出本文档（docs/TASK_BREAKDOWN.md，取代 T-038 旧版）；未改任何实现代码、未做技术选型变更、未调 taskctl/看板写接口、未 push、未下载依赖。✅
- **真实验证记录**：①全部 [本地] 锚点行号经 read/grep 实测（serve.mjs:209/274/730-743/809-821/942-944；ChatView:49-51/160/239；App.tsx:59/348-359；Sidebar:13-23/61-80；api.ts:280/489-500 subscribeHubAudit；team-hub ensureColumn/audit/chat 路由先例）；②w/T-051 分支与提交 a524951 存在性经 git branch/cat-file 实测；③`## slices` 解析格式对照 plugins/src/index.ts parseSlices（L472-491）与 team-hub expandGoalSlices（L758-823）逐字段核验。✅

---

## 附录 A：与既有产物的关系

- T-038 拆解（第一批 S1~S8）已交付；本文件**取代**之，旧版见 `git log --follow docs/TASK_BREAKDOWN.md`（T-038 promote 提交）。
- 范围/验收基线 = docs/REQUIREMENTS.md（T-073）；方案/选型/闸门 = docs/RESEARCH.md（T-074，含 T-044 全文存档附录）。本批 P0 缺陷复现证据 = docs/T062-evidence/、docs/T059-evidence/ 等，供 coder 回归依据。

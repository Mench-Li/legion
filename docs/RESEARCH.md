# T-074 方案搜索与选型报告（第二批：三中心收尾 + 平台剩余功能）

> 角色：researcher（方案搜索）｜阶段：方案搜索｜任务：T-074（分支 w/T-074 独立 worktree，HEAD = 72d8ef8 promote T-073）
> 输入：docs/REQUIREMENTS.md（T-073 需求澄清，本批唯一权威需求基线）+ 本仓库本地代码盘点（本报告全部 [本地] 行号均为本阶段 read/grep 实测）
> 下游：breaker（docs/TASK_BREAKDOWN.md，须写「## slices」）→ test-designer → coder → reviewer → tester → devops
> 替换关系：本文档**取代**同文件 T-044 报告成为当前阶段依据；T-044 全文已原样移入文末「存档」附录（内容一字未删，仅标题降级一级），经 git 亦可回溯。
>
> **结论一句话**：本批（三中心收尾 + 平台剩余功能）**不是新架构选型，而是「缺陷修复方案 + 两占位模块选型」**。推荐主线——①缺陷面（R-A1~R-A6）：在既有 serve.mjs / ChatView.tsx 内做**最小单点加固**，全部零新增依赖：F1 = .git 守卫升级为「任一层段 .git 即拒 + realpath 后复检（防符号链接绕入）」；F2 = serve.mjs 顶层整体 try/catch + URIError→4xx（进程绝不死）；A3 = 浏览器抓取审计落**本地 JSONL（静态 ROOT 之外）+ console**（满足「日志链路可查」验收）；A4 = body stall 在 body 读取单一归类点判 timeout（不再冒泡成 web_error/abort）；A5 = ChatView loadOlder/send 写回前做**会话身份守卫**（复用既有 activeRef/cancelled 模式）；A6 = **直接沿用 w/T-051**（BrowserPanel→BrowserView + 错误态 + IME 守卫已实现并有证据，零新依赖）。②平台剩余功能：日程日历 = **自研月视图（CSS grid，仿 FilesView/ChatView 先例）+ team-hub 扩表扩 API（仿 chat S1：表 + REST + handleWrite + SSE）**；通知中心 = **由既有 audit 表派生（单数据源，零新表）+ 本地已读游标 + 既有 Toast 即时提示**。③第三方候选（react-big-calendar / FullCalendar / tui.calendar / react-calendar / react-markdown / DOMPurify / CodeMirror 等）**本批默认全部不引入**：workbench node_modules/.pnpm 本地盘点（130 项）无这些包，落地需 pnpm install（禁网纪律 = blocker），除非将军批准联网安装。

## 0. 结论速览（TL;DR）

| 需求（REQUIREMENTS §5） | 一等（推荐） | 备选 | 排除 |
| --- | --- | --- | --- |
| R-A1/F1 嵌套 .git 防护 | **assertNotGitInternal 任一层段 .git 即拒 + realpath 复检**（serve.mjs 内 ~10 行，9 处调用点不变） | 仅 realpath 全链夹逼 | 白名单/隐藏段禁用（仓库含合法隐藏文件） |
| R-A2/F2 畸形路径防崩溃 | **createServer 顶层 try/catch（整体兜底）+ decodeURIComponent URIError→400** | 安全解码 fallback；预校验正则 | 进程崩溃现状（不可接受） |
| R-A3 web fetch 审计 | **本地 JSONL + console（文件置于静态 ROOT 外，容量轮转）** | 经 hub 转写 team-hub audit（action=web:fetch） | 仅 console 无持久（不满足可查） |
| R-A4 body stall 归类 | **body 读取单一归类点：abort/deadline → code=timeout；错误码枚举常量表收口** | catch 内按 message 匹配 'abort' | 现状（误分类为 web_error/code=undefined） |
| R-A5 ChatView 会话守卫 | **写回前会话身份守卫（activeRef 快照比对，仿既有 cancelled 模式）；纯逻辑抽函数可 node --test** | AbortController 取消在途只读请求（辅助） | 状态按 conv 分桶重构（v1 过重） |
| R-A6 浏览器前端收口 | **沿用 w/T-051 合入**（改名 BrowserView + isErrorResult/errorText + IME 守卫；evidence 齐全） | 在 main 上重做同款收口 | 维持 BrowserPanel 现状（不满足命名/错误态验收） |
| R-B1 日程日历 | **自研月视图 + team-hub 扩表扩 API（仿 chat S1 写纪律）** | react-big-calendar / FullCalendar（需将军批准联网安装） | 云日历 SaaS |
| R-B2 通知中心 | **audit 派生视图（单数据源）+ 本地已读游标 + Toast 即时提示** | 独立 notifications 表（跨端/精确投递时才做） | 纯第三方 toast（无列表/未读语义） |
| R-A7/R-B3 回归 | **既有契约套件扩用例（files-api/web/team-hub/contracts/whiteboard）+ pnpm build + 浏览器手工清单** | 新增 vitest（本地无 → 需安装，不采纳） | 无回归验证（不满足交付判据） |

## 1. 输入、范围与方法

### 1.1 需求输入（T-073 REQUIREMENTS.md，唯一权威基线）

本批待办 = §2.3 待办表 + §5 R-A1..R-C3：
- **Part A 三中心收尾（P0/P1，必做）**：R-A1(F1 嵌套 .git 泄密/P0)、R-A2(F2 畸形路径崩溃/P0)、R-A3(S6 抓取审计留痕零实现/P0)、R-A4(body stall 归类/P1)、R-A5(ChatView 串显/P1)、R-A6(浏览器前端收口/P1)、R-A7(主路径+实时/断线回归锚定/P1)。
- **Part B 平台剩余（P1/P2，待将军确认是否纳入）**：R-B1 日程日历（建议 P1）、R-B2 通知中心（建议 P1）、R-B3 存量回归（P1）、R-B4 双账本收敛（P2）、R-B5 旧文档归档（P2）。
- **Part C 交付与工程（P2）**：R-C1 候选增强 X-1~X-5、R-C2 生产发布、R-C3 构建链路。
- 硬性不变量（§4.2，本批方案不得违反）：I-1 零新增运行时依赖；I-2 仅回环 + 写需 token；I-3 chat 写统一 handleWrite；I-5 渲染安全（无未净化 HTML 直插 DOM）；I-7 SSRF 防护；I-8 实时并入单一 /api/events；I-9 任何请求不得崩溃进程；I-10 文件面不得暴露非顶层 .git 内部。

### 1.2 现状代码证据（本阶段 read/grep 实测锚点，均可复核）

| 证据点 | 位置（当前 main 源码，w/T-074 HEAD=72d8ef8） | 含义 |
| --- | --- | --- |
| F1：assertNotGitInternal 只判首段 .git | workbench/scripts/serve.mjs:208-212（`if (parts[0] === '.git')`）；调用点 274/301/327/339/352/381/390/391/407 覆盖 list/read/download/upload/mkdir/rename/delete 各入口 | 嵌套仓库 subrepo/.git/config 首段非 .git → 绕过（T-062 §5 F1 已实测 200 泄出） |
| F2：顶层 decodeURIComponent 无捕获 | serve.mjs:942-944（createServer 回调内直接 decodeURIComponent(url.pathname)，942-1001 无 try/catch）；:963-968 /api/web/fetch；:969-973 /api/files | 单请求 /api/files%zz → URIError → 进程 exit（T-062 §5 F2 已实测） |
| A3：web fetch 零审计 | serve.mjs:809-821 handleWebApi（:810 isLoopback、:814 webFetch、:816-819 catch code=err.code??'web_error'）；全文件 console 仅 :999 启动横幅（grep 实测）；createWriteStream 仅 :473 上传临时文件 | S6 AC5「审计留痕」零实现（T-057 M1/T-059 M1） |
| A4：body 读取错误归类缺口 | serve.mjs:730-743 readBodyLimited（:735 仅在 await 前查 signal.aborted；await reader.read() 若被 abort reject → 无捕获）；:751-806 webFetch（:765 timer→ac.abort；:770-772 fetch 段 abort→timeout；body 段无同款）；:816-819 兜底 web_error | headers 已回、body stall 超时被归类为 web_error/code=undefined（T-057 M2/T-059 M2） |
| A5：ChatView 异步写回无守卫 | workbench/src/components/ChatView.tsx:160-180 loadOlder（await 后无条件 setMsgs）；:232-256 send（postChatMessage resolve 后无条件 setDraft/setMsgs）；对照：:64-92 activeId effect 与 :95-115 scope effect 已有 cancelled flag；:49-51 activeRef 已存在 | 切会话/空间竞态可串显（T-060 review M1） |
| A6：main 仍是 BrowserPanel | workbench/src/App.tsx:351-356（chat→ChatView、files→FilesView、browser→BrowserPanel）；w/T-051 分支已有 BrowserView.tsx（改名 + errorText 全码映射 :37-52 + isErrorResult :56-62，含 too_many_redirects/web_error；提交 a524951，evidence docs/T051-evidence/） | 收口实现已存在未合入 |
| 占位模块 | workbench/src/components/Sidebar.tsx:21-22（calendar/notify 定义）、:63（notify 计数=inReview）、:78-79（点击仅 toast 占位） | B1/B2 待实现 |
| 实时/审计底座 | team-hub/server.mjs:188 audit 表、:413-415 audit()、:1573-1583 GET /api/activity（scope/taskId/limit）、:1807-1817 /api/events SSE（回放最近 30 条 audit、retry 2000、15s hb）、:1633-1666 /api/chat/* 路由（写走 handleWrite）；api.ts:489-491 subscribeHubAudit（单一 EventSource /api/events 按 action chat:* 过滤） | B2 通知中心可派生复用；chat 写纪律是 B1 数据面模板 |
| 依赖面 | workbench/package.json（dependencies 仅 react/react-dom/three/@react-three/fiber|drei；engines >=22.5）；workbench/node_modules/.pnpm 实测 130 项 = 仅自身依赖闭包 | 任何第三方组件本地均不可得 → 引入需 pnpm install（禁网 = blocker） |
| w/T-051 与 A6 | git diff main...w/T-051：BrowserPanel.tsx→BrowserView.tsx + App.tsx + README×2 + evidence（build/typecheck/web-test 绿） | A6 可直接采纳合入 |

### 1.3 评估维度与引用分级

- 每决策域按「候选 ≥2 / 适配度 / 成本 / 风险 / 迁移量」评估；推荐理由锚定 [本地] 行号（可离线复核）或 [公开·待核] URL。
- 引用分级沿用 T-044 惯例：`[本地]` = 本仓库文件/行号/命令输出；`[公开·待核]` = 公开项目主页/许可证事实。本环境 **web_search 实测 Insufficient Balance（本阶段已复测）** 且仓库纪律禁网，公开事实一律标「待核」并给规范 URL，**不编造 star 数/版本号/日期**。
- 「本地盘点」结论以实际探测为准：workbench/node_modules/.pnpm 目录清单 130 项，逐一按关键字探测 **react-big-calendar / fullcalendar / toast-ui / react-calendar / react-markdown / dompurify / codemirror / readability / turndown / cheerio / hot-toast / vitest / testing-library / tanstack 均不存在**（pwsh Get-ChildItem 实测）。

## 2. 决策域 J1：文件中心 .git 内部防护策略（R-A1/F1）【P0·安全】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J1-A（推荐）任一层段 .git 即拒 + realpath 后复检**：assertNotGitInternal 由 `parts[0]==='.git'` 升级为 `parts.some(p=>p==='.git')`；同时在既有 resolveWithinRoot 的 realpath 结果上对「根相对路径」再跑同判定（防符号链接指向 .git 内部，如 subrepo/link → .git/config） | 高（正中 F1 复现面） | 极低（~10 行，9 处调用点签名不变） | 低：顶层 .git 行为不变（首段仍拦）；嵌套任意层 .git/config、.git/objects 403；submodule/.git 文件（gitdir: 指针）与 git worktree 的实体均在父 .git/modules/worktrees 下 → 含 .git 段被拦；realpath 复检补上「链接绕入」。Windows 大小写不敏感（.GIT）建议比较前 toLowerCase | **一等**：可测试语句直转（嵌套矩阵 + 顶层对照 + 符号链接夹具） |
| J1-B 仅 realpath 全链夹逼（不查 rel 段） | 中-高 | 中（需祖先遍历 + 大小写/别名处理） | 中：能拦链接绕入但依赖 realpath 成功路径；失败路径（不存在文件/坏链接）需另定语义；.git 文件（非目录）场景需额外识别 | 作为 J1-A 的补充而非替代 |
| J1-C 白名单/「禁隐藏段」通用过滤 | 低 | 低 | 仓库内合法隐藏文件（.env 样例/.gitignore 等）会被误伤；不可行 | 排除 |

**设计要点（供 breaker/designer）**：①写路径（upload/mkdir/rename/delete 的 from/to）与读路径同强度（R-A1.3）；②list 的 rel 若含 .git 段（任一层）在守卫升级后应 403——listDirEntries:274 已在入口调用守卫，升级即覆盖 list/read/download/写面同强度；父目录列表对点条目本就隐藏（listDirEntries:277 过滤 `. 前缀条目（含 .git）`，界面不可导航入 .git，已满足「不暴露」呈现），无需额外改动；③回归夹具矩阵进 files-api.test.mjs（现状 34/34 全绿基线）。

## 3. 决策域 J2：畸形 percent-encoding 防进程崩溃（R-A2/F2）【P0·健壮性/DoS】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J2-A（推荐）顶层整体 try/catch + URIError→4xx**：把 createServer 回调（含 :944 decodeURIComponent 与后续路由分发/静态服务）整体包入 try/catch；decode 失败显式捕获 → 400（body 给提示）；其余意外同步异常 → 500 且进程存活。可选把 decode 移入独立函数 safeDecode（try 内 decodeURIComponent，失败返回 null → 400） | 高（正中 DoS 面，且兜底未来一切同步异常，直接落实 I-9） | 低（1 层包裹 + ~8 行） | 低：现有路由行为不变（catch 只拦未捕获）；畸形输入统一 400/404 可测；需防「catch 内再写响应抛错」（复用 :824-829 httpErr 的断连保护） | **一等**：验收直转（/api/files%zz → 400 且进程存活、后续 /api/config 200；注入矩阵；10 并发不崩） |
| J2-B 安全解码 fallback（decode 失败返回原样字符串继续路由） | 中 | 低 | 中：非法字符静默下传，后续 parse/路径 join 可能再抛或语义错乱；治标不治本 | 仅作 J2-A 内部降级细节，不作为独立方案 |
| J2-C 请求行预校验（% 后必须 2 位 hex，非法即拒） | 中 | 中 | 中：重复实现 URL 规范解析易漏（overlong/surrogate/大小写 hex）；新增一处可绕过面 | 否（规范解析交给 URL/decodeURIComponent + 顶层兜底） |

## 4. 决策域 J3：浏览器抓取审计留痕通道（R-A3/S6-AC5）【P0·审计】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J3-A（推荐）serve.mjs 本地结构化日志（JSONL + console）**：每次 /api/web/fetch 完成（成功/失败/拦截都算）append 一行 `{ts, by:'general', url, finalUrl, status, code, ms, bytes?}` 到**静态 ROOT（serve.mjs:26 = workbench/dist）之外**的数据目录（如 <workbench>/data/web-audit.jsonl，.gitignore 追加 data/）+ console 一行；文件按大小上限轮转 | 高（满足验收 R-A3.3「既有 /api/activity **或日志链路**查询到」） | 低（~20 行零依赖；Node 内置 fs appendFile） | 低-中：文件放 ROOT 外避免被静态服务 GET；容量轮转（如 5MB 截断/按天）；hub 不在线也能审计（浏览器面板本就不依赖 hub）；by 默认 general | **一等**：成功与失败（ssrf_blocked/timeout/too_large/http_<n>）皆留痕，验收 1/2/3 全可测 |
| J3-B serve→hub 转写 team-hub audit（新增 action=web:fetch 端点，写走 handleWrite） | 中-高（进 /api/activity + 实时动态流） | 中-高（新 hub 端点 + serve 侧转发 + 跨服务耦合；每次抓取多一次写） | 中：hub 挂则审计丢失/阻塞抓取；SSE 广播会刷「实时动态」；跨文件改动面大 | 备选/增强：若将军要求抓取痕迹进指挥台审计时间线再启用；v1 不做 |
| J3-C 仅 console 无持久 | 低 | 极低 | console 不落盘不可查（浏览器端看不到 serve 控制台），不满足「可查询」 | 排除 |

## 5. 决策域 J4：body stall 超时归类（R-A4/S6-M2）【P1·正确性】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J4-A（推荐）body 读取单一归类点 + 错误码枚举收口**：readBodyLimited 在 `await reader.read()` 外层加 catch——若 `ac.signal.aborted`（含共享 deadline 触发）→ 一律 webErr('timeout')；只有连接层真失败才保持 fetch_error；handleWebApi 兜底 code 保持 err.code ?? 'web_error'；同时把 webErr 的 code 枚举（invalid_url/protocol_blocked/ssrf_blocked/too_many_redirects/timeout/too_large/fetch_error/http_<n>/unsupported/empty_content/web_error）抽为常量表，供后端 emit、前端映射（w/T-051 errorText）、TC-S6 三方对齐 | 高（正中 T-059 M2 复现面） | 低（~10 行 + 常量表） | 低-中：undici abort 传播行为差异 → 用 ac.signal.aborted 状态而非错误 message 判据；顺带修复 w/T-051 前端映射含后端不发出的 dns_error 之类漂移（见 §13 R-13） | **一等**：验收 1/2 直转（注入「headers 已回、body 挂起」本地 http server 夹具 → code='timeout'；整链超时同码） |
| J4-B handleWebApi catch 按 e.message==='abort'/AbortError 判 timeout | 中 | 极低 | message 匹配脆弱（undici/不同 Node 版本文案可变） | 否 |
| J4-C 放弃 AbortController 改 fetch 原生 timeout | 低 | — | Node fetch 无标准超时属性；丢共享 deadline 语义 | 排除 |

## 6. 决策域 J5：ChatView 会话/空间身份守卫（R-A5/S2-M1）【P1·正确性】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J5-A（推荐）异步写回前会话身份守卫**：loadOlder 在 await fetchChatMessages 后、send 在 await postChatMessage 后，回写 setMsgs/setDraft/setLoadingOlder/setSending 前比对「发起时 convId === activeRef.current」；不匹配则仅复位 loading/sending 标志并丢弃合并（消息数据不动）；doCreate 的 setActiveId 后如 scope 已切同样忽略。复用既有 activeRef（ChatView.tsx:49-51）与 cancelled flag 模式（:71-91/:103-113）。建议把判定抽成纯函数/小 hook（如 `isStale(convAtCall, now)`），使核心逻辑可进 node --test（前端无 test runner，R-3） | 高（正中 T-060 M1 复现面） | 低（~15 行 + 纯函数） | 低：不改变数据流/协议；对 send 不可用 AbortController（消息可能已入库，abort 会造成「已发但 UI 未知」）——守卫即可 | **一等**：验收 1/2/3 直转（A/B 会话快速切换、跨空间竞态、主路径回归） |
| J5-B 守卫 + AbortController 取消在途只读请求（loadOlder/messages） | 中 | 中 | 只读取消省流量、防旧响应（守卫已防写回）；POST 不 abort | 可选叠加，非必需 |
| J5-C 状态按 convId 分桶（msgsByConv Map）从结构隔离 | 中 | 高（滚动/分页/实时合并全部按桶重构，测试面大） | 改动大、回归风险高 | v1 不做，v2 再评估 |

## 7. 决策域 J6：浏览器助手前端收口（R-A6/S7）【P1·收口】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J6-A（推荐）沿用 w/T-051 合入**：diff main...w/T-051 = BrowserPanel.tsx→BrowserView.tsx（改名对齐 ChatView/FilesView；errorText 全错误码映射 :37-52；isErrorResult 把 too_many_redirects/web_error/http_*/timeout 等全部归错误态 :56-62）+ App.tsx import 替换 + README×2；提交 a524951 自带 evidence（build/typecheck/web-test 绿，docs/T051-evidence/），零新依赖 | 高（R-A6 四项验收已在分支实现：命名/错误态/IME 守卫/入口一致） | 极低（合入 + 验收复核） | 低：App.tsx 与其他切片文件域重叠风险 → breaker 拆片时 A6 独占 App.tsx 或最先合入；合入后跑 R-A7 回归 | **一等**：验收 1/2/3/4 已在分支证据中覆盖，tester 复核即可 |
| J6-B 在 main 上重做同款收口 | 中 | 中（重复劳动） | w/T-051 已实现且验证，重做浪费且无额外收益 | 仅在 w/T-051 合入受阻时兜底 |
| J6-C 维持 BrowserPanel 现状 | 低 | — | 不满足命名/错误态验收（A6 必做） | 排除 |

## 8. 决策域 J7：日程日历模块（R-B1）【P1·建议纳入，待将军确认】

数据面与视图面分开评估；若将军 OQ-3 裁定不纳入本批，本节作预研存档。

### 8.1 数据面（候选 ≥2）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J7-A（推荐）team-hub 扩表扩 API（仿 chat S1 模板）**：calendar_events(id, scope, title, start, end?, allDay?, meta JSON, createdAt/updatedAt) + GET/POST /api/calendar/events（scope 分区、分页或按日期窗）+ 写走 handleWrite（by 必填 + audit + SSE，机制复用 server.mjs:1633-1666 chat 路由同构）| 高：与既有数据/写纪律/审计模型完全一致；事件可跨标签实时（SSE）；scope 隔离天然 | 中-低（1 表 + 2 路由 + DAO，全 node:sqlite/内置） | 低：SQLite 串行写压力（日历写入频率远低于 chat，无 R-4 式担忧）；I-3 只约束 chat 写，calendar 写沿用同纪律即可 | **一等**（单库单服务零新依赖） |
| J7-B 事件存空间 local_dir 的 JSON 文件（走 serve.mjs 文件面） | 中 | 低 | 事件文件混入用户仓库内容（污染/误删/证据混淆）；无审计无 SSE；并发写文件需锁 | 否 |
| J7-C localStorage-only | 低 | 极低 | 单浏览器、清缓存即丢、无审计无 scope 共享，与平台其余模块数据语义割裂 | 否 |

### 8.2 视图面（候选 ≥2；[公开·待核] 许可证）

| 候选 | 适配度 | 许可证/维护（待核） | 迁移/学习成本 | 结论 |
| --- | --- | --- | --- | --- |
| **J7-D（推荐）自研月视图**：CSS grid 7×N 周网格 + 弹层创建/删除（复用既有 Toast/Modal/按钮样式），渲染纯文本防注入（I-5）；数据接 J7-A | 高（MVP：创建/查看/删除 + 时间/标题/scope + 月视图，全部可测） | 无新依赖 | 低（~300-500 行，仿 FilesView/ChatView 先例） | **一等**：符合 I-1 零依赖；主题一致；验收 R-B1.1-4 全部可覆盖 |
| J7-E react-big-calendar（MIT，[公开·待核] https://github.com/jquense/react-big-calendar） | 中-高（月/周/日/拖拽/议程齐全） | MIT；维护活跃（待核） | 中-高：日期适配层（date-fns/dayjs）、样式覆写贴近指挥台、包体 | 备选：仅当将军批准联网安装（本地盘点无此包，pnpm install 即 blocker）且需要周/日/拖拽时 |
| J7-F FullCalendar / @fullcalendar/react（MIT 标准版，premium 插件商业，[公开·待核] https://fullcalendar.io / https://github.com/fullcalendar/fullcalendar） | 中-高（功能最强） | MIT(标准)/商业(premium)（待核） | 中-高：React 封装 + 样式/时区/插件树 | 同上备选；premium 授权需将军知悉 |
| J7-G @toast-ui/react-calendar（MIT，[公开·待核] https://github.com/nhn/tui.calendar） | 中 | MIT；TOAST UI 系（维护状态待核） | 中 | 备选同上 |
| J7-H react-calendar（MIT，[公开·待核] https://github.com/wojtekmaj/react-calendar） | 中（纯月历选择组件，非日程管理） | MIT（待核） | 低 | 若只缺「月历选择」小件可参考，不构成日程模块 |
| 云日历（Google Calendar API 等） | 低 | 商业/平台 | 高 | 数据出境/断网不可用，与本地定位冲突；排除 |

## 9. 决策域 J8：通知中心模块（R-B2）【P1·建议纳入，待将军确认】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J8-A（推荐）audit 派生视图（单数据源）**：通知面板 = GET /api/activity?scope=…（team-hub:1573-1583，既有）+ SSE /api/events 实时增量（:1807-1817，面板自身订阅，与 ChatView 同模式）；前端按「通知 action 白名单」过滤（任务 claim/transition/advance/review-note/test-report/patch/evidence/artifact、goal:publish、space:*、model:* 等；chat:* 建议默认排除防刷屏，可加开关）；未读数 = audit.seq > 本地已读游标（localStorage per scope）；点击通知 → 跳转任务详情/对应面板；侧栏 badge（Sidebar:63 已有 inReview 计数先例）| 高：R-B2.3「与既有事件流同源、避免第三数据源」字面满足；scope 隔离天然（audit 有 scope）；零新表零新写接口 | 低（前端面板 + 过滤 + 游标，纯展示） | 中：audit 含全动作，需白名单降噪；本地游标跨标签不同步（v1 单浏览器可接受，列文档）；「通知已读」不落 audit（避免已读写刷审计）——用 localStorage | **一等**：验收 1/2/3/4 可测（列出+未读+跳转+与事件流同源）；点击跳转复用任务详情弹窗 |
| J8-B 独立 notifications 表 + /api/notifications + 写走 handleWrite | 中-高（精确 receiver/已读持久/跨端一致） | 中-高（新表 + 路由 + producer 定义「哪些事件转通知」+ 双写一致性） | 新增数据面与 audit 投影重叠；producer 挂点散落 audit() 各调用点（server.mjs:413-415）需逐个决策 | 备选：将军要求跨设备/指定接收人/服务端已读持久时再做；v1 不引入 |
| J8-C 纯第三方 toast 库（react-hot-toast 等，MIT [公开·待核]） | 低 | 低（本地无 → 需安装） | 只有即时浮层，无列表/未读/跳转语义；不构成「通知中心」 | 排除（即时提示沿用既有自研 Toast.tsx，作为 J8-A 的补充） |

## 10. 决策域 J9：回归锚定与存量回归（R-A7 / R-B3）

| 候选 | 适配度 | 成本 | 结论 |
| --- | --- | --- | --- |
| **J9-A（推荐）既有契约套件扩用例 + 构建 + 浏览器清单**：A1/A2/A4 的新用例**追加进既有文件**（workbench/scripts/files-api.test.mjs 现状 34/34、web.test.mjs 12/12 基线，T-062 evidence）；A5 守卫纯函数可入 team-hub 或 workbench scripts 的 node --test（chat.test.mjs 先例）；存量回归 = tests/contract/contracts.test.mjs（56 基线）+ whiteboard node --test（67 基线）+ 前端 pnpm build/tsc + 浏览器主路径手工清单（三中心实时/断线/隔离/渲染安全，见 REQUIREMENTS R-A7 验收 1-3） | 高 | 中-低 | **一等**：R-B3 宿主项（board-plugin 注入 DSH Desktop）不可达时按「环境受限 + 复现步骤」如实记录（REQUIREMENTS R-6/OQ-8） |
| J9-B 新引 vitest/@testing-library 做 React 单测 | 中 | 高（需安装 vitest/jsdom——本地盘点无 → blocker；配置/改造 tsconfig） | 否（沿用既有 R-3 结论：纯逻辑下沉 node --test、UI 走构建 + 浏览器清单） |
| J9-C 仅手工回归 | 低 | 低 | 无自动化证据，不满足仓库「真实验证」纪律 | 否（作为 J9-A 的补充而非替代） |

## 11. 一等选型汇总 → 直接支撑 breaker 拆片的建议

### 11.1 实施拓扑建议（含边界与文件域，breaker 可据此定 slice）

1. **R-A1（F1）+ R-A2（F2）同属 serve.mjs（共用文件）**：建议合成一个 slice 或两个**串行** slice（文件域 = workbench/scripts/serve.mjs + workbench/scripts/files-api.test.mjs），避免同文件并行叠加（REQUIREMENTS R-4/R-5 已预警）。实现=J1-A + J2-A；回归=嵌套 .git 读/写矩阵 + 畸形路径注入矩阵 + 进程存活断言。
2. **R-A3（A3）+ R-A4（A4）同属 serve.mjs webFetch 域**：可与 A1/A2 同 slice 或同文件串行第二 slice（文件域 = serve.mjs + web.test.mjs + 新数据目录 .gitignore）。实现=J3-A + J4-A + 错误码常量表收口。
3. **R-A5（A5）**：文件域 = workbench/src/components/ChatView.tsx（+ 可选新纯函数文件便于 node --test）。实现=J5-A。
4. **R-A6（A6）**：合入 w/T-051（文件域 = workbench/src/components/BrowserView.tsx + App.tsx 1 行 + README）；与其它 slice 的 App.tsx 改动错开（breaker 排序列）。
5. **R-B1（日历）**：若将军纳入：slice 文件域 = team-hub/server.mjs（表+2 路由）+ workbench/src/components/CalendarView.tsx（新）+ App.tsx/Sidebar.tsx（接线）+ 样式；仿 chat S1 的 DAO/audit/SSE 模板。
6. **R-B2（通知）**：若将军纳入：slice 文件域 = workbench/src/components/NotifyView.tsx（新）+ App.tsx/Sidebar.tsx（接线 + badge）+ api.ts（list/游标）；后端零改动（纯派生）。
7. **R-A7/R-B3（回归）**：tester/devops 阶段执行；契约文件扩展随各 coder slice 一起（不单列或单列「回归聚合」）。
8. **Part C / B4 / B5（增强/双账本/归档/发布/环境）**：非技术选型面；按 REQUIREMENTS §6 顺序由 devops/general 处理，breaker 可标注归属不拆 coder slice（X-1~X-5 仅当将军勾选才拆，前置=本地盘点）。

### 11.2 决策闸门（新增 G-8..G-14；建议默认值即上文一等）

- G-8 F1 采用「段级 + realpath 复检」且 list 默认隐藏嵌套 .git 条目（默认✅；否 = 仅段级 / list 显示条目点击 403）
- G-9 F2 采用顶层整体 try/catch + URIError→400（默认✅）
- G-10 web fetch 审计 = 本地 JSONL + console（默认✅；否 = hub audit 转写，需 hub 在线）
- G-11 错误码枚举收口为常量表（默认✅，顺带修前端映射漂移）
- G-12 A6 沿用 w/T-051 合入（默认✅；否 = main 重做）
- G-13 B1/B2 是否本批实现（默认✅=按将军 OQ-3 裁决；若纳入：数据走 J7-A、视图 J7-D、通知 J8-A）
- G-14 第三方日历/通知/markdown 库一律不引入（默认✅；将军批准联网安装才追加，前置=本地盘点）

## 12. 新引入技术/依赖逐项影响（AC-3：许可 · 维护 · 学习成本 · 生态）

> 本批一等路线（R-A1~R-A6 + B1/B2 按推荐实现）**零新增运行时依赖**。下表为「候选外部库」逐项影响；**本地盘点结论：workbench node_modules/.pnpm（130 项）均无以下包**，任何采纳都需 pnpm install（当前禁网纪律下 = blocker，除非将军批准联网或提供离线缓存）。

| 名称 | 许可证（待核） | 维护活跃度 | 学习成本 | 生态/与本项目契合 | 用途与前置（本批状态） |
| --- | --- | --- | --- | --- | --- |
| react-big-calendar | MIT | 高（jquense 系，待核） | 中-高（日期适配层） | React 生态日程组件主流 | R-B1 备选视图；前置=联网安装；**默认不引入** |
| FullCalendar（@fullcalendar/react + core） | MIT(标准)/商业(premium)（待核） | 高 | 中-高（插件树/时区） | 功能最强但 premium 授权需知悉 | 同上备选 |
| @toast-ui/react-calendar | MIT（待核） | 中（维护状态待核） | 中 | TOAST UI 系 | 同上备选 |
| react-calendar | MIT（待核） | 高 | 低 | 纯月历小件 | 仅参考/小件，不构成日程模块 |
| react-hot-toast / notistack / sonner | MIT（待核） | 高 | 低 | 即时浮层 | 既有自研 Toast.tsx 已够；不引入 |
| react-markdown / remark 系 | MIT（待核） | 极高 | 低 | React markdown 事实标准 | X-1 增强（R-C1）；将军勾选 + 联网安装才引入 |
| DOMPurify | MIT 或 MPL-2.0（待核；MPL-2.0 为弱 copyleft 文件级） | 极高 | 低 | 前端净化标准库 | X-4 增强：仅当走「远端 HTML 直接渲染」路径才必需（默认文本/markdown 渲染可避免）；将军勾选 + 联网安装才引入 |
| CodeMirror 6 | MIT（待核） | 高 | 中 | 轻量编辑器 | X-2 文件在线编辑；默认不做 |
| Monaco（@monaco-editor/react） | MIT（待核） | 极高 | 中-高（worker/体积） | 完整 IDE | v2 场景；默认不做 |
| @mozilla/readability / cheerio / Turndown | Apache-2.0 / MIT / MIT（待核） | 高 | 低 | 正文抽取生态 | X-3 正文精抽取（现为零依赖正则版，serve.mjs:700-727）；默认不替换 |
| ws | MIT（待核） | 极高 | 低 | Node WebSocket 标准 | 实时通道仍走 SSE（I-8），不引入 |
| vitest / @testing-library/react | MIT（待核） | 极高 | 中 | 前端测试 | 前端无 test runner 现状（R-3）维持；纯逻辑下沉 node --test |
| Playwright / Puppeteer | Apache-2.0（待核） | 极高 | 中-高 | 浏览器自动化 | 需下载 Chromium 二进制，禁网 blocker；v2 单独立项 |

## 13. 许可证与合规总表

| 项 | 许可证 | 置信度 | 结论 |
| --- | --- | --- | --- |
| node:sqlite / node:http / node:fs / node:test / EventSource | Node.js MIT / 平台标准 | 高（产线在用） | 采纳 |
| React 19 / Vite 7 / three / @react-three/* | MIT（产线已有，workbench/package.json） | 高 | 沿用 |
| 本批一等路线新增 | **无**（全部 Node 内置 + 自研 + 沿用 w/T-051 零新依赖） | 高 | 采纳 |
| react-big-calendar / FullCalendar(标准) / tui.calendar / react-calendar / react-markdown / DOMPurify(择 MIT 分支) / CodeMirror / Monaco / readability / cheerio / Turndown / ws / vitest | MIT / Apache-2.0（逐项[公开·待核]） | 中-高 | 均**默认不引入**；待将军批准联网安装 + 落地前 SPDX 复核（沿用 T-044 §14 R10 待核清单） |
| FullCalendar premium / 云日历 / Jina Reader | 商业/ToS | 高 | 排除（授权/数据出境） |

## 14. 风险与未知（追加 R-11..R-18；与 REQUIREMENTS §7 R-1..R-9 叠加）

- **R-11（w/T-051 合入冲突）**：A6 与其它切片同改 App.tsx/Sidebar.tsx → breaker 拆片时给 A6 独占或排序最先；w/T-051 自带 evidence，合入成本低。
- **R-12（serve.mjs 共用文件域）**：R-A1/A2/A3/A4 全在 serve.mjs（~1000 行单体）→ 拆片须串行或按函数域（守卫层/服务器层/webFetch 域）切分，禁止并行叠加（同 REQUIREMENTS R-4/R-5）。
- **R-13（错误码枚举漂移）**：w/T-051 前端映射含后端未发出的 dns_error；TC-S6 与实现偶有漂移（REQUIREMENTS R-9/OQ-7）→ J4-A 常量表收口时三方对齐，测试以枚举表为准。
- **R-14（嵌套 .git 边界口径）**：符号链接→.git 内部、Windows 大小写（.GIT）、.git 文件（submodule/worktree 指针）、list 是否隐藏条目——两可选项均可测（G-8 默认隐藏）；tester 定口径并在用例矩阵覆盖。
- **R-15（通知噪音/游标）**：audit 全量作源需 action 白名单（chat:* 默认排除）；已读游标 localStorage 跨标签不同步（v1 接受，文档注明；需服务端已读时走 J8-B）。
- **R-16（日历 MVP 扩展成本）**：自研若后续要拖拽/时区/重复事件成本上升 → 切 J7-E/J7-F 备选（需将军批准安装）。
- **R-17（审计文件安全/膨胀）**：JSONL 必须置于静态 ROOT（workbench/dist）之外 + 容量轮转；勿把审计写入可被 GET 的目录。
- **R-18（环境/禁网）**：与 REQUIREMENTS R-1/R-2/R-3/R-6 相同：第三方一律本地盘点、缺失即 blocker；vite build EPERM / worktree 无 node_modules / board-plugin 宿主注入按「环境受限 + 复现步骤」如实记录，不冒充通过。
- **OQ 假设**：本报告按 T-073 §9 默认倾向推进（A 项必做；B1/B2 建议纳入；X-1~X-5 默认不勾选；200-envelope 口径）。若将军对 OQ-1/OQ-3/OQ-7 有不同裁决，受影响面仅 B1/B2 纳入与否与 X 勾选，Part A 方案不受影响。

## 15. 引用与来源清单

### 15.1 [本地] 可复核（本阶段 read/grep 实测，行号以当前 w/T-074 HEAD=72d8ef8 为准）
- workbench/scripts/serve.mjs:26（ROOT=dist）、:69（writeToken）、:208-212（assertNotGitInternal 只判首段 .git）、:274/301/327/339/352/381/390/391/407（守卫调用点）、:473（上传临时文件 createWriteStream）、:700-727（零依赖正文抽取）、:730-743（readBodyLimited abort/too_large）、:751-806（webFetch：协议白名单 :761 / SSRF :763 / manual redirect :769 / 递归跳转 :775-782 / 共享 deadline :756-758）、:809-821（handleWebApi：loopback :810 / catch code=err.code??web_error :816-819）、:824-829（httpErr 断连保护）、:839-846（classifyFilesError）、:942-1001（createServer 顶层 decodeURIComponent :944 无 try/catch）、:963-968（/api/web/fetch 路由）、:969-973（/api/files 路由）、:999（唯一 console=启动横幅）
- workbench/src/components/ChatView.tsx:49-51（activeRef）、:64-92（activeId effect cancelled flag）、:95-115（scope effect cancelled flag）、:118-130（mergeNewest）、:133-151（SSE chat:* 过滤 + 15s 轮询，写回有 activeRef 守卫）、:160-180（loadOlder 无守卫）、:232-256（send 无守卫）、:315-320（纯文本渲染）
- workbench/src/components/Sidebar.tsx:21-22/63/78-79（calendar/notify 占位 + notify 计数先例）
- workbench/src/App.tsx:348-359（chat/files/browser 面板分支，browser 仍是 BrowserPanel）
- workbench/src/components/BrowserView.tsx（w/T-051 分支）:37-52（errorText 全码映射）、:56-62（isErrorResult 错误态收口）——与 main 的 diff：git diff main...w/T-051
- team-hub/server.mjs:37/45/64-66（node:sqlite DatabaseSync + WAL + busy_timeout + DB_FILE）、:188（audit 表）、:413-415（audit()）、:1573-1583（GET /api/activity）、:1633-1666（/api/chat/* 路由：写走 handleWrite）、:1807-1817（/api/events SSE：回放 30 条 + retry 2000 + 15s hb）
- workbench/src/api.ts:489-491（subscribeHubAudit 单一 /api/events）
- workbench/package.json（deps = react/react-dom/three/@react-three/*；engines >=22.5）；workbench/node_modules/.pnpm 130 项清单（pwsh 实测，无日历/markdown/editor/通知类包）
- w/T-051 提交 a524951 + docs/T051-evidence/（build/typecheck/web-test）；REQUIREMENTS.md 附录 C（T-073 复核，同 HEAD 断言 F1/F2/A3/接线/占位仍在源码）
- 基线套件计数（历史证据引用，非本阶段运行）：files-api.test.mjs 34/34、web.test.mjs 12/12（docs/T062-evidence/）；chat.test.mjs、skills.test.mjs（team-hub）；contracts.test.mjs 56（tests/contract/README.md）；whiteboard node --test（whiteboard/docs/DEPLOY.md 零第三方依赖先例）

### 15.2 [公开·待核]（web_search 实测 Insufficient Balance + 禁网纪律 → 无法在线复核；本报告不引用未核实数字/日期）
- Node.js node:sqlite / 内置模块：https://nodejs.org/api/sqlite.html
- Server-Sent Events（EventSource）：https://html.spec.whatwg.org/multipage/server-sent-events.html ／ https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- react-big-calendar（MIT）：https://github.com/jquense/react-big-calendar
- FullCalendar（标准 MIT / premium 商业）：https://fullcalendar.io ／ https://github.com/fullcalendar/fullcalendar
- @toast-ui/react-calendar / tui.calendar（MIT）：https://github.com/nhn/tui.calendar
- react-calendar（MIT）：https://github.com/wojtekmaj/react-calendar
- react-markdown（MIT）：https://github.com/remarkjs/react-markdown
- DOMPurify（MIT/MPL-2.0）：https://github.com/cure53/DOMPurify
- CodeMirror 6（MIT）：https://codemirror.net ／ Monaco（MIT）：https://microsoft.github.io/monaco-editor/
- @mozilla/readability（Apache-2.0）：https://github.com/mozilla/readability ／ cheerio（MIT）：https://github.com/cheeriojs/cheerio ／ Turndown（MIT）：https://github.com/mixmark-io/turndown
- ws（MIT）：https://github.com/websockets/ws
- vitest / @testing-library/react（MIT）：https://vitest.dev ／ https://testing-library.com
- Playwright（Apache-2.0）：https://playwright.dev ／ Puppeteer（Apache-2.0）：https://pptr.dev

## 16. 本阶段验收对照（researcher 自拟，逐条对应任务验收）

- **AC-1 方案覆盖需求要点且每决策域 ≥2 候选对比（优缺/成本/风险）**：§2-§10 共 9 决策域（J1-J9），每域 2-6 候选并给适配度/成本/风险与优缺点结论，覆盖 R-A1..R-A7、R-B1/R-B2、R-A7/R-B3 全部需求要点；B4/B5/C 类过程项在 §11.1 标注归属。✅
- **AC-2 有明确推荐与理由，依据真实可查来源并注明引用**：每个一等推荐锚定 [本地] 行号（§1.2/§15.1，本阶段 read/grep 实测可离线复核）；公开事实因 web_search 实测 Insufficient Balance + 禁网，标 [公开·待核] 并给规范 URL（§15.2），未编造任何数字。✅
- **AC-3 新引入技术/依赖逐项说明影响（许可/维护/学习/生态）**：§12 逐项表（含本地盘点实证：.pnpm 130 项无候选包）+ §13 合规总表 + §14 R-11..R-18。✅
- **AC-4 结论可直接支撑后续任务拆解**：§11.1 按 slice 边界给文件域/串并行建议 + §11.2 决策闸门 G-8..G-14；breaker 可直接产出「## slices」。✅
- **边界遵守**：只产出本文档；未改任何实现代码、未调 taskctl、未 push、未下载依赖；「不确定项」全部列为风险/备选/OQ 假设（§14）。✅
- **真实验证记录**：本阶段无运行代码（文档阶段），验证 = ①全部 [本地] 行号经 read/grep 实测（serve.mjs/ChatView/Sidebar/App/api.ts/team-hub/workbench package.json 等）；②本地盘点经 pwsh Get-ChildItem 实测（node_modules/.pnpm 130 项、候选库全缺、w/T-051 差异 diff main...w/T-051 实测）；③web_search 复测 Insufficient Balance。见 §1.2/§15.1。

---

## 存档附录：T-044 报告全文（已执行完毕的历史选型，非当前阶段依据）

> 以下为 T-044「三中心从零建造」阶段的方案搜索全文（按仓库「续写/覆盖 + 取代声明」惯例原样保留，仅标题降级一级，内容未删改）。当前阶段（T-074）以本文档 §0-§16 为准；T-044 供历史回溯与三中心既有设计的依据引用。

## T-044 方案搜索与选型报告：交付剩余 Legion 指挥团任务（对话中心 · 文件中心 · 浏览器助手）

> 角色：researcher（方案搜索）｜阶段：方案搜索｜执行任务：T-044（分支 w/T-044 独立 worktree）
> 输入：T-036 需求澄清（evidence 全文，经 `GET http://127.0.0.1:8787/api/task?id=T-036` 只读读取）+ 本仓库本地代码盘点（见 §1.2 行号证据表）
> 下游：breaker（docs/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
>
> **结论一句话**：三个占位中心全部走「**零新运行时依赖自研 + 复用既有层**」主线——① 对话中心 = team-hub v2 扩表扩 API（conversations/messages，node:sqlite 已有）+ 复用 `/api/events` SSE 推送 + 指挥台自研 React 会话面板；② 文件中心 = 扩展现有 `/api/fs`（仅回环 + git 仓库探测，已有）为 `/api/files` 文件面 + 自研目录树/文件表 + 轻量文本预览；③ 浏览器助手 v1 = 服务端 fetch 代理 + 正文抽取（零二进制，SSRF 必须防护），v2 再评估无头浏览器（Playwright/Puppeteer，受禁网安装限制）；④ 导航接线 = App.tsx 按 `active` 挂面板 + `React.lazy`（仿 SkillsPanel / Scene3D 既有先例）。所有第三方组件一律「先本地盘点可用再采纳，缺失即 blocker，不联网下载」。

### 0. 结论速览（TL;DR）

| 域 | 一等（推荐） | 备选 | 排除 |
| --- | --- | --- | --- |
| 对话中心·后端 | **team-hub 扩表扩 API**（conversations/messages + REST + 复用 /api/events SSE + 统一 handleWrite/审计） | 独立消息微服务（ws/Socket.IO） | Rocket.Chat / Zulip / Mattermost / Matrix(Synapse)；Stream/Sendbird 云 |
| 对话中心·实时 | **复用 SSE**（EventSource 自动重连已有先例） | WebSocket（引入 `ws`） | 长轮询为主通道；第三方推送云 |
| 对话中心·前端 | **自研 ChatView**（与指挥台主题一致） | chatscope/chat-ui-kit-react | stream-chat-react（绑其后端）；iframe 嵌聊天服务器 |
| 文件中心·后端 | **扩展 workbench `/api/fs` → `/api/files`**（仅回环 + token 写 + 目录根=空间 local_dir/仓库根） | filebrowser sidecar；DSH fs 工具面代理 | Nextcloud/Seafile/云盘（WebDAV/S3） |
| 文件中心·前端 | **自研树/表 + 文本预览**（v1 `<pre>`，需编辑时 CodeMirror 6） | Monaco Editor（@monaco-editor/react） | 整套网盘式 UI |
| 浏览器助手·引擎 | **v1 服务端 fetch 代理 + 正文抽取**（readability/cheerio；SSRF 防护） | v2 Playwright / Puppeteer sidecar；Jina Reader 云（开关默认关） | browser-use 等 Python 框架；无头浏览器进 v1（禁网装不了浏览器二进制） |
| 浏览器助手·前端 | **自研阅读面板**（地址栏 + markdown 预览；抓回 HTML 需 DOMPurify） | sandbox iframe 受限预览 | 直接把远程页 iframe 进主应用（X-Frame-Options/CSP 普遍禁嵌） |
| 导航接线 | **App.tsx 按 `active` 渲染面板 + React.lazy 分 chunk** | react-router 引入 | 每模块独立 HTML 页 |

### 1. 输入、范围与方法

#### 1.1 上游结论（T-036 需求盘点，requirement evidence 要点）

1. **现状盘点**：scrum v1（:4820 遗留）/ team-hub v2（:8787 SQLite 任务池）/ workbench 军团指挥台（:5173 React）/ board-plugin / whiteboard（零依赖 CRDT 白板，测试/ADR 齐）/ mesh+workflows。
2. **目标点名项现状**（占位区）：
   - **对话中心(chat)缺失**：仅 Sidebar 模块项，点击 toast「后续步骤接入」，全仓无聊天 UI/后端；
   - **文件中心(files)缺失**：Sidebar + QuickTools「DSH 文件工具」均未接线；
   - **浏览器助手(browser)有极雏形**：QuickTools→openKanban() 只跳经典看板，非真浏览。
3. **P0/P1/P2 清单**：P0-1 三中心需求澄清（已完成）；P0-2 对话中心=会话/消息存储与 API + 前端视图；P0-3 文件中心=文件浏览/上传/存储 + 真实 DSH 文件工具面接线；P0-4 浏览器助手=真网页抓取/浏览能力；P1-5 workbench 导航接线（files/browser/chat/calendar/notify 占位改真实路由）；P1-6 双账本收敛（v1/v2 写源统一）；P1-7 存量验收（whiteboard 起服联调、board-plugin 注入宿主验证）；P2-8 旧流水线文档归档。
4. 蓝图参考：scrum/sidebar-mockup.html（聊天区 + 看板侧栏面板的视觉效果，非实现约束）。

#### 1.2 盘点方法：本地代码行号证据（均可复核）

| 证据点 | 位置（本地可核） | 含义 |
| --- | --- | --- |
| 侧栏 9 模块含 files/browser/chat/calendar/notify | workbench/src/components/Sidebar.tsx:13-21 | 目标点名项 = 侧栏占位模块 |
| 占位点击行为（tasks→openKanban，其余 toast「后续步骤接入」） | Sidebar.tsx:66-77（70/74/77） | 对话/文件/浏览器点不动是「导航未接线」 |
| 面板渲染仅 skills 有真实现 | workbench/src/App.tsx:346-350 | 新面板挂在 App 同款分支即可 |
| 懒加载先例（Scene3D = lazy） | workbench/src/components/CenterPanel.tsx:8 | 大模块按需分 chunk 的先例 |
| 快捷工具 DSH_TOOLS（files/browser/ocr/voice）占位 | workbench/src/components/QuickTools.tsx | 仅 browser→openKanban()，其余 toast |
| 已有目录浏览 /api/fs（仅回环 403）与 /hub 代理 | workbench/scripts/serve.mjs:8-10, 48, 135, 139-148, 163-166 | 文件中心可直接扩展同款端点 |
| 客户端 SSE 订阅（EventSource 自动重连）+ /api/fs 客户端 | workbench/src/api.ts:107, 119-120, 222-235 | 对话实时推送复用同款通道模式 |
| team-hub = node:sqlite DatabaseSync + WAL + busy_timeout | team-hub/server.mjs:35, 62-64 | 后端存储/并发前提 |
| 现成表结构 tasks/members/roster/spaces/goal/exec_*/agent_models | server.mjs:66-173 | conversations/messages 沿用同构建表 + JSON 列约定 |
| SSE 事件流 /api/events（text/event-stream） | server.mjs:1291-1302 | 聊天事件推送挂同通道 |
| 工作台技术栈与 Node 版本要求 | workbench/package.json（react19/vite7/three；engines >=22.5） | 新增依赖须与之兼容 |
| 零第三方运行时依赖先例 | whiteboard/docs/DEPLOY.md:9（Node≥22.5 内置 node:sqlite） | 「零依赖自研」路线在本环境已验证可行 |

#### 1.3 评估维度与引用分级

- 每决策域按「适配度 / 成熟度 / 许可证 / 维护活跃度 / 迁移成本」评估。
- **引用分级**：`[本地]` = 本仓库文件行号，可离线复核（上表）；`[公开·待核]` = 公开项目主页/许可证，因本环境禁网且 web_search 工具不可用（实测报 Insufficient Balance），按既有知识定性并显式标注「待核」，**不编造 star/版本号/日期**。落地前（coder/devops 或将军）按 §14 待核清单复核。

### 2. 需求要点 → 决策域映射

| 需求要点（T-036） | 决策域 | 关键取舍点 |
| --- | --- | --- |
| 对话中心：会话/消息存储与 API + 前端视图 | A（存储/API）/ B（实时）/ C（UI） | 数据放哪、推送通道、UI 自研还是组件库 |
| 文件中心：浏览/上传/存储 + 真实文件工具面接线 | D（后端访问面）/ E（前端） | 端点位置、写权限、目录根语义、预览/编辑能力 |
| 浏览器助手：真网页抓取/浏览 | F（引擎）/ G（呈现） | 无头浏览器 vs 轻量抓取、SSRF 防护、JS 渲染边界 |
| P1-5 导航接线（5 个占位） | H（导航/模块化） | 面板挂接方式、懒加载、v1 覆盖范围 |
| 依赖纪律（禁网，缺失即 blocker） | 横切 | 默认零新依赖；外部库先本地盘点 |

### 3. 决策域 A：对话中心 —— 存储与 API

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **A1（推荐）team-hub v2 扩表扩 API**：conversations/messages + REST（GET/POST `/api/chat/*`）+ 统一 handleWrite/审计 + 复用 /api/events | 高 | 极高（产线已有） | 无新增（node:sqlite 属 Node 运行时） | 极低 | 优：单库单服务零新依赖；scope 分区与 by 审计模型现成（tasks 同构，server.mjs:66-173）；消息可与任务/evidence 关联（AI 执行过程写回）；运维/迁移成本最低。缺：聊天与任务写共享 SQLite（DatabaseSync 串行写，busy_timeout=5000）；高并发聊天需节制——v1 局域网多将军单机场景完全够用，风险低 |
| A2 独立消息服务（Node + 自有存储 + ws） | 中 | 高 | 引入 ws(MIT) | 中-高 | 优：隔离、可独立扩、协议自由。缺：重复基建（成员/空间/任务数据跨服务联查）、双服务运维、破坏「轻量单体」现状；无独立价值 |
| A3 整机聊天平台（Rocket.Chat MIT / Zulip Apache-2.0 / Mattermost / Matrix-Synapse） | 低 | 极高 | MIT/Apache-2.0（逐项待核） | 高 | 优：频道/私信/富文本/移动端全套。缺：独立服务 + 独立认证体系，与 team-hub 任务/编队数据、审计 SSE、scope 语义完全不融合；v1 明显过度，维护面爆炸 |
| A4 云聊天 SaaS（Stream/Sendbird 等） | 低 | 高 | 商业 | 高 | 数据出境 + 订阅成本 + 断网不可用，与本项目「本地自托管」定位冲突；排除 |

**建议 v1 数据形态（供 breaker，非实现）：** conversations(id, scope, title, kind∈{space,direct,task}, participants JSON, created/updated, last_message_at) + messages(id, conv_id, scope, author, kind∈{text,markdown,system}, body, meta JSON, clientTs, createdAt)，JSON-in-TEXT 列与现有表同构；`POST /api/chat/messages` 走统一 handleWrite（by 必填 → 审计 + SSE 广播，机制复用 server.mjs 现状）。

### 4. 决策域 B：对话中心 —— 实时通道

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **B1 复用 Server-Sent Events（推荐）** | 高 | 零新增：EventSource 浏览器原生（[公开] WHATWG 标准，待核），服务端 text/event-stream 已实现（server.mjs:1291-1302），客户端订阅先例在 api.ts:119-120 | 低。注意 HTTP/1.1 每源连接上限约 6 条：v1 已用 board/activity 两条事件源，建议把 chat 事件并入单一 `/api/events` 流按 kind 过滤，或走 `/hub` 同源合并，避免连接数撞顶 | **一等**：单向下行天然够聊天推送；消息上行走 REST POST（与现状一致）；EventSource 自动重连免费获得 |
| B2 WebSocket（引入 `ws` MIT） | 中 | 新增依赖 `ws`；Node 内置无 ws server（服务端需手写 upgrade 或引库） | 低-中：双向低延迟，但引入新依赖 + 新连接管理代码 | 备选：若未来需要在线状态/输入中/强双向交互再切 |
| B3 轮询兜底 | 低 | 零 | 延迟 3-15s，聊天体感差 | 仅作 SSE 断线兜底（workbench 已有 15s board 轮询先例） |

### 5. 决策域 C：对话中心 —— 前端 UI

| 候选 | 适配度 | 许可证/维护 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- |
| **C1 自研轻量 ChatView（推荐）**：会话列 + 消息气泡 + 输入框 + 分页加载 | 高 | 无新依赖 | 低 | 与指挥台暗色/3D 风格完全一致；交互参照 DSH Web GUI 的 ui-conversation 范式（[本地] packages/client/ui-conversation 存在可参考，非复用代码）；消息渲染 markdown 可选 react-markdown(MIT，待核) |
| C2 chatscope/chat-ui-kit-react | 中 | MIT（待核），维护中 | 中 | 现成气泡/输入/引用组件省时间，但样式主题需大量覆写以贴近指挥台；纯 UI 不绑后端，可作备选 |
| C3 stream-chat-react | 低 | SDK MIT（待核），核心能力绑定其后端 | 高 | 后端/定价耦合；排除 |
| C4 iframe 嵌现成聊天页 | 低 | 绑定 A3 | 高 | 与 A3 同排除 |

### 6. 决策域 D：文件中心 —— 后端文件访问面

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **D1（推荐）扩展 `/api/fs` → `/api/files`**（workbench serve.mjs，与 /hub 代理同源）：list(类型/大小/mtime/.git 标记)、read(文本截断+行数)、write/rename/mkdir/delete、上传(PUT raw body)、下载；目录根 = 当前空间 local_dir（未绑定回退显式配置根/仓库根）；沿用「仅回环可访问 + token 写」边界（serve.mjs:135 已有 403 先例） | 高 | 极高（目录浏览/git 探测已在产线，serve.mjs:139-148） | 无新增（node:fs/path/http 内置） | 低 | 优：零依赖；文件=空间绑定的真实仓库目录（任务证据/文档就在其中），语义自洽；只读默认、写操作要 token + 仅回环，攻击面小。缺：上传 multipart 需手写解析——用「fetch PUT raw bytes」规避（免 busboy/multer）；大文件需限尺寸与流式落盘 |
| D2 filebrowser sidecar（Apache-2.0，待核） | 中 | 高 | Apache-2.0 | 中-高 | 优：现成网盘式管理（分享/搜索/编辑器/用户）。缺：Go 二进制整机 + 独立用户/权限模型 + 新端口进程托管（services-plugin 需扩展）；面向家目录而非「当前空间 git 仓库根」语义；v1 重 |
| D3 DSH harness 文件工具面代理（把 DSH 的 fs 能力封装为 HTTP） | 中 | 高（宿主内） | 随 DSH | 高 | 优：复用沙箱语义。缺：DSH 文件工具是 agent 沙箱接口，浏览器直连需鉴权/路径策略 + 依赖 Desktop 插件运行时在线；定位 v2 深度接线；QuickTools「DSH 文件工具」卡片可先由 D1 目录浏览器充当真实能力面（即「接线」） |
| D4 云盘/WebDAV/S3 | 低 | 高 | 平台侧 | 中 | 不在「本地仓库目录」语义内；v2 另议 |

### 7. 决策域 E：文件中心 —— 前端浏览/预览/编辑

| 候选 | 适配度 | 许可证/维护 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- |
| **E1（推荐）自研目录树 + 文件表 + 文本预览**：导航/样式复用 FolderPickerModal 的既有交互（[本地] workbench/src/components/FolderPickerModal.tsx / api.ts:222-235）；v1 预览用受控 `<pre>`（防 XSS：textContent 渲染），按扩展名出图标/行数 | 高 | 无新依赖 | 低 | 覆盖「浏览/定位/下载/上传」核心诉求；对仓库内文本查看够用 |
| E2 CodeMirror 6（MIT，待核） | 中-高 | MIT，活跃 | 中 | 轻量（相对 Monaco），懒加载分 chunk 后可做「文本查看 + 简易编辑」；若 v1 就要编辑则推荐（先本地盘点依赖） |
| E3 Monaco Editor / @monaco-editor/react（MIT，待核） | 中 | MIT，微软维护 | 中-高 | 完整 IDE 体验，但包体大 + worker 配置复杂（与现有 Vite 构建要专门处理）；v2「在指挥台内写代码/改配置」再引入 |
| E4 react-arborist 等现成树组件（MIT，待核） | 中 | 中 | 中 | 可选小件；树不复杂时自研更贴合现有样式 |

### 8. 决策域 F：浏览器助手 —— 抓取引擎

**语义**：将军在指挥台内「喂 URL → 看页面内容/快照」，替代 QuickTools「跳看板」占位；未来演进为可操作浏览。

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **F1（推荐 v1）服务端 fetch 代理 + 正文抽取**：workbench serve.mjs（或 team-hub）加 `POST /api/web/fetch`（url 入参）；Node 内置 fetch(undici) 拉取 → 抽取：纯 HTML→标题/文本/链接摘要（零依赖）；正文精抽取用 @mozilla/readability(Apache-2.0，待核) 或 cheerio(MIT，待核)；可选 Turndown(MIT，待核) 转 Markdown | 高（v1 阅读场景） | 高 | 零二进制新依赖 | 低 | 优：轻、快、无需浏览器二进制（禁网环境唯一可行）；响应限长/超时/Content-Type 白名单可控。缺：**不能执行 JS**——SPA/反爬/需登录页拿不到正文（v2 无头浏览器补）；**服务端外呼=SSRF 高危**：必须禁私有网段/回环/内网、URL 协议白名单 http/https、重定向链校验、限大小超时、审计日志（本地已有 loopback-only 先例 serve.mjs:48,135 可扩展为「仅允许显式外网」策略） |
| F2 v2 无头浏览器 sidecar：Playwright（Apache-2.0）/ Puppeteer（Apache-2.0，均待核） | 中-高（未来） | 极高 | Apache-2.0 | 高 | 优：完整渲染/截图/DOM 操作，才是「浏览器助手」完全体。缺：需下载 Chromium（约 120-300MB，**禁网环境无法安装 → 实施时本地盘点即 blocker，不擅自下载**）；进程管理/内存开销；远控浏览器攻击面大；v1 不做 |
| F3 云阅读服务（Jina AI Reader r.jina.ai 等） | 中 | 服务可用性依赖第三方 | 商业 ToS | 低 | 内容经第三方、隐私/合规不可控、断网不可用；仅作「显式开关、默认关」选项 |
| F4 window.open / iframe 直嵌目标站 | 低 | — | — | 低 | 非通用方案：X-Frame-Options/CSP 普遍禁嵌，跨域不可读；保留 openKanban 新窗口作为「打开内部看板」快捷入口，不算浏览能力本体 |

### 9. 决策域 G：浏览器助手 —— 前端呈现

| 候选 | 适配度 | 结论 |
| --- | --- | --- |
| **G1 自研阅读面板（推荐）**：地址栏 + 请求态 + 结果视图。结果若为 Markdown → react-markdown(MIT) 渲染；若直接渲染抓回 HTML → 必须先 DOMPurify(MIT/MPL-2.0，待核) 净化（防存储型 XSS——抓取内容不可信） | 高 | 一等：默认把抓回内容转 Markdown/文本渲染，**避免把远端 HTML 直接落 DOM**，从根上收窄注入面 |
| G2 sandbox iframe 受限预览 | 中 | 辅助：对同意被嵌的站（X-Frame-Options 放行）用 sandbox 属性只读预览 |
| G3 DSH Web GUI 自身浏览器 | 低 | 宿主浏览器能力面（tab/窗口）与 workbench 集成属另一主题，v2 评估 |

### 10. 决策域 H：导航接线与模块化（横切 P1-5）

| 候选 | 适配度 | 迁移成本 | 结论 |
| --- | --- | --- | --- |
| **H1（推荐）App.tsx 按 `active` 渲染面板**：仿既有 skills 分支（App.tsx:346-350）为 chat/files/browser 各挂懒加载面板（React.lazy 仿 Scene3D，CenterPanel.tsx:8 先例）；Sidebar.clickModule 把这 3 个 id 从 toast 分支移入 onNavigate 分支（Sidebar.tsx:66-77）；「任务中心」维持 openKanban 外部经典看板页；calendar/notify 维持 toast（P1 后续再接线） | 高 | 低 | 一等：改动集中在 App/Sidebar 两个文件；无路由库依赖；三个面板各自独立 chunk，首屏体积不涨 |
| H2 引入 react-router | 中 | 中 | 备选：模块到两位数/需要 URL 深链（如 `#/chat/conv/1` 可分享）时再引入；当前 state 切换够用，避免过度工程 |
| H3 每模块独立 HTML 入口 | 低 | 高 | 与 SPA + 弹窗 + 独立看板页现状割裂；否 |

### 11. 一等选型汇总 → 直接支撑任务拆解的 v1 建议

#### 11.1 实施拓扑建议（供 breaker 取舍，含边界）

1. **对话中心 v1**：team-hub 新增 conversations/messages 表 + `/api/chat/conversations|messages`（scope/分页/审计）→ 复用 /api/events 推 chat 事件 → workbench 侧 ChatView（会话列/气泡/发送/markdown 可选）+ Sidebar/App 接线。不做：富文本/文件附件/已读回执/多端同步（v2）。
2. **文件中心 v1**：serve.mjs 扩 `/api/files`（list/read/download/upload-PUT + 受限写操作，仅回环 + token）→ 目录根=当前空间 local_dir/仓库根 → workbench FilesView（树+表+预览）→ QuickTools「文件浏览」卡与侧栏 files 接线。不做：跨机器访问、权限系统、版本历史（git 已天然有）、在线编辑（v1 预览只读）。
3. **浏览器助手 v1**：`/api/web/fetch` 代理（SSRF 防护：协议白名单 + 私网阻断 + 限长超时 + 审计）→ 正文抽取（先零依赖正则版，可后挂 readability/cheerio）→ BrowserView 阅读面板（结果以文本/markdown 呈现，HTML 必须净化）→ QuickTools「打开浏览器」卡拆为「打开内部看板」与「浏览网页」两个入口。不做：JS 渲染页、登录态、点击/表单操作（v2 无头浏览器）。
4. **导航接线**：按 H1；calendar/notify 仍占位。
5. **依赖纪律**：以上 v1 全部零新依赖；若采纳 E2/react-markdown/readability 等，coder 首步先本地盘点（node_modules/pnpm store/仓库缓存），缺失即 blocker，不下载（§14 风险 R1）。

#### 11.2 决策闸门（G-1..G-7，请将军裁决；建议默认值即上文一等）

- G-1 对话数据入 team-hub 单库（默认✅，否=A2 独立服务）
- G-2 实时通道 = 复用 SSE（默认✅，否=ws 新依赖）
- G-3 对话 UI 自研（默认✅，否=chat-ui-kit-react）
- G-4 文件端点放 workbench serve.mjs（默认✅，否=team-hub 或 filebrowser sidecar）；写默认只读+token
- G-5 浏览器引擎 = v1 fetch+抽取 / v2 无头（默认✅）；JS 渲染/登录页明示为 v1 边界
- G-6 导航 v1 范围 = chat/files/browser 三模块（默认✅；calendar/notify 仍占位）
- G-7 新依赖引入策略 = 先本地盘点、缺失即 blocker（默认✅，全 v1 路线零新依赖即自动满足）

### 12. 新技术 / 依赖逐项影响（许可 · 维护 · 学习成本 · 生态）

> 注：v1 一等路线**零新运行时依赖**（node:sqlite / node:http / node:fs / EventSource / 自研 React 均已在产线）。下表列的是「可选增强 / v2」候选，逐项标注影响与前置条件。

| 名称 | 许可证（待核） | 维护活跃度 | 学习成本 | 生态/与本项目契合 | 用途与前置 |
| --- | --- | --- | --- | --- | --- |
| @mozilla/readability | Apache-2.0 | 高（Mozilla 维护，社区活跃） | 低（单函数 read()） | Node 可跑；主流正文抽取事实标准 | 浏览器助手正文抽取（v1 增强）；前置=本地可安装 |
| cheerio | MIT | 高（长期活跃） | 低 | Node 生态最普及的 HTML 解析 | 结构化抓取/链接提取备选 |
| Turndown | MIT | 中（成熟少动） | 低 | 常用 HTML→Markdown | 抽取结果转 Markdown 的可选项 |
| DOMPurify | MIT 或 MPL-2.0 双许可 | 极高 | 低 | 前端净化标准库 | 抓回/用户 HTML 渲染前的必需净化（若走 HTML 渲染路径） |
| react-markdown | MIT | 高（remark 生态活跃） | 低 | React 生态标准 markdown 渲染 | 聊天/网页摘要 markdown 渲染（可选项） |
| CodeMirror 6 | MIT | 高 | 中（API 与现代编辑器不同） | 轻量、无 worker 包袱 | 文件中心在线查看/编辑（v2 或 v1 增强） |
| Monaco Editor（@monaco-editor/react） | MIT | 极高（微软） | 中（体积与 worker 配置是主要成本） | VSCode 同源，能力最强 | 「在指挥台写代码」场景（v2） |
| chatscope/chat-ui-kit-react | MIT | 中 | 中 | 纯 UI 组件 | 对话 UI 备选（不绑后端） |
| ws | MIT | 极高 | 低 | Node WebSocket 事实标准 | 若 G-2 翻转选 ws 通道 |
| filebrowser | Apache-2.0 | 高 | 低（整机服务） | Go 生态 | 文件中心 sidecar 备选（v2） |
| Playwright / Puppeteer | Apache-2.0 | 极高 | 中-高（浏览器自动化心智） | 浏览器自动化事实标准 | 浏览器助手 v2 无头引擎；**前置=可下载 Chromium，禁网环境大概率 blocker** |
| Jina AI Reader | 商业 ToS | 服务 | 极低 | 云依赖 | 开关默认关的云兜底 |
| Rocket.Chat / Zulip / Mattermost / Matrix | MIT / Apache-2.0（逐项待核） | 高 | 高（整机运维） | 独立社区/认证生态 | 排除（数据模型与本地定位不融合） |

### 13. 许可证与合规总表

| 项 | 许可证 | 置信度 | 结论 |
| --- | --- | --- | --- |
| node:sqlite / node:http / node:fs / EventSource | Node.js MIT / 平台标准 | 高 | 采纳（已在产线） |
| React / react-dom / Vite / TS / three / @react-three/fiber / drei | MIT（Vite 亦 MIT） | 高 | 已在用，采纳 |
| @mozilla/readability / cheerio / Turndown / react-markdown / CodeMirror / Monaco / ws / filebrowser / Playwright / Puppeteer | 见 §12 | 中-高 | 待核后按需采纳（全部非 copyleft 类） |
| DOMPurify | MIT 或 MPL-2.0 双许可 | 中 | 待核（MPL-2.0 为弱 copyleft，文件级） |
| chatscope chat-ui-kit-react / stream-chat-react | MIT（后者的核心后端为商业） | 中 | 前者可采纳，后者排除 |
| Rocket.Chat / Zulip / Mattermost / Matrix-Synapse | MIT / Apache-2.0 等 | 中 | 排除（过度） |
| Jina Reader 等云服务 | 商业 ToS | 高 | 默认关闭选项 |

风险提示：DOMPurify 双许可含 MPL-2.0 需按文件级合规评估（若采纳选 Apache-2.0 分支即可）；Playwright/Puppeteer 引入的是浏览器二进制下载而非纯 npm 依赖，禁网环境下先盘点再决定。

### 14. 风险与未知（含备选方案）

- **R1（环境）禁网/禁下载**：外部库一律先本地盘点，缺失列为 blocker 不擅自安装（与 LEGION.md 纪律、白板先例一致）。v1 一等路线零新依赖即为此设计。备选：任何外部库不可得时用「零依赖自研等价物」降级（正则抽取、`<pre>` 预览等）。
- **R2（浏览器助手）SSRF**：服务端 fetch 代理是 SSRF 高危点——协议白名单 + 私有网段/回环/链路本地阻断 + 重定向链校验 + 响应限长与超时 + 操作审计 + 默认不开（显式按钮触发）。参考已有 loopback-only 边界实现（serve.mjs:48,135）。
- **R3（浏览器助手）JS 渲染页不可抓**：v1 明确边界（SPA/反爬/登录页只返回提示），v2 无头浏览器补；备选 = Jina Reader 云开关（默认关，隐私自负）。
- **R4（对话中心）SQLite 写竞争**：chat 高频写与任务写共享 DatabaseSync 串行写；单机场景够用，压力上限需 breaker/test-designer 量化（如 ≤100 msg/min 冒烟 + P95 写延迟断言）；备选 = 独立消息库/表分文件。
- **R5（实时）HTTP/1.1 连接数**：事件源建议并流（单一 /api/events 按 kind 过滤）防撞约 6 连接/源上限。
- **R6（文件中心）越权与误删**：写默认只读 + token + 仅回环 + 路径规范化（禁越出目录根，禁符号链接逃逸）；删除/覆盖需二次确认。
- **R7（抓回内容注入）**：远端内容不可信——默认转文本/markdown 渲染；HTML 渲染路径必须 DOMPurify（§9 G1）。
- **R8（双账本 P1-6 / 存量验收 P1-7 / 归档 P2-8）**：属 devops/tester/requirement 后续任务，本报告仅标注依赖与顺序（文件中心建在 workbench serve.mjs 上时注意与 team-hub 双写源纪律一致——v1 只写 team-hub 或只写 v1，避免再引入第三写源）。
- **R9（SaaS/重平台诱惑）**：云聊天/云文件/整机聊天或网盘产品均因「数据本地、认证隔离、模型不融合、运维重」排除；若未来将军要「公网多用户」，再单独立项评估（含认证/安全专题）。
- **R10（待核清单，联网后复核）**：§12/§13 各许可证 SPDX 复核（readability/cheerio/Turndown/DOMPurify/CodeMirror/Monaco/chatscope/filebrowser/Playwright/Puppeteer/Rocket.Chat/Zulip/Mattermost/Matrix）；node:sqlite 在 Node 24 的稳定性级别；各库最近 release 与维护活跃度量化。

### 15. 引用与来源清单

#### 15.1 [本地] 可复核（本仓库文件/接口，行号见 §1.2 证据表）
- workbench/src/components/Sidebar.tsx:13-21,66-77（占位模块与点击行为）
- workbench/src/components/QuickTools.tsx（DSH_TOOLS 占位卡，仅 browser→openKanban）
- workbench/src/App.tsx:346-350（模块面板渲染分支）；CenterPanel.tsx:8（lazy 先例）
- workbench/scripts/serve.mjs:8-10,48,135,139-148,163-166（/api/fs 与 /hub 代理，仅回环边界）
- workbench/src/api.ts:107,119-120,222-235（SSE 订阅与 /api/fs 客户端）
- team-hub/server.mjs:35,62-64,66-173,1291-1302（node:sqlite/WAL、表结构、/api/events SSE）
- workbench/package.json（React19/Vite7/three；engines ≥22.5）；whiteboard/docs/DEPLOY.md:9（零第三方运行时依赖先例）
- T-036 需求盘点 evidence：`GET http://127.0.0.1:8787/api/task?id=T-036`（只读）

#### 15.2 [公开·待核]（禁网不可实时抓取，URL 供联网复核；本报告未引用未核实数字）
- SQLite 公共域声明：https://www.sqlite.org/copyright.html
- Node.js 内置 SQLite（node:sqlite）：https://nodejs.org/api/sqlite.html
- Server-Sent Events：https://html.spec.whatwg.org/multipage/server-sent-events.html（MDN: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events）
- @mozilla/readability（Apache-2.0）：https://github.com/mozilla/readability
- cheerio（MIT）：https://cheerio.js.org ／ https://github.com/cheeriojs/cheerio
- Turndown（MIT）：https://github.com/mixmark-io/turndown
- DOMPurify（MIT/MPL-2.0）：https://github.com/cure53/DOMPurify
- react-markdown（MIT）：https://github.com/remarkjs/react-markdown
- CodeMirror（MIT）：https://codemirror.net ／ Monaco Editor（MIT）：https://microsoft.github.io/monaco-editor/
- chatscope chat-ui-kit-react（MIT）：https://github.com/chatscope/chat-ui-kit-react
- ws（MIT）：https://github.com/websockets/ws
- filebrowser（Apache-2.0）：https://filebrowser.org ／ https://github.com/filebrowser/filebrowser
- Playwright（Apache-2.0）：https://playwright.dev ／ Puppeteer（Apache-2.0）：https://pptr.dev
- Jina AI Reader：https://jina.ai/reader
- Rocket.Chat（MIT）：https://rocket.chat ／ Zulip（Apache-2.0）：https://zulip.com ／ Mattermost：https://mattermost.com ／ Matrix/Synapse（Apache-2.0）：https://matrix.org

### 16. 本阶段验收标准（researcher 自拟，因任务 acceptance 留空）

- **AC-1 方案覆盖需求要点且每决策域 ≥2 候选对比（优缺/成本/风险）**：§3-§10 共 8 个决策域，每域 2-4 候选并给适配度/成熟度/许可/迁移成本与优缺点风险列。✅ 本文档 §3-§10。
- **AC-2 有明确推荐与理由，依据真实可查来源并注明引用**：推荐逐条锚定 [本地] 行号证据（§1.2/§15.1，可离线复核）；公开事实因本环境禁网（web_search 实测 Insufficient Balance）标注 [公开·待核] 并给规范 URL（§15.2），未编造任何数字。✅ §1.3/§15。
- **AC-3 新引入技术/依赖逐项说明影响（许可/维护/学习/生态）**：§12 逐项表 + §13 合规总表 + §14 R10 待核清单。✅
- **AC-4 结论可直接支撑后续任务拆解**：§11 给出 v1 实施拓扑（三中心 + 导航 + 依赖纪律）、边界（不做什么）、决策闸门 G-1..G-7 与建议默认值；breaker 可据此拆 S 系列子任务。✅
- **边界遵守**：本阶段只产出本文件，无代码改动、未调 taskctl、未 push、未下载任何依赖；「不确定项列为风险与备选」见 §14（R1-R10）。✅
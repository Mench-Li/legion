# T-073 需求说明：交付剩余 Legion 军团指挥团任务（三中心收尾 · 平台剩余功能）

> 阶段：需求澄清（requirement）｜任务：交付剩余 Legion 军团指挥团任务（含对话中心 · 文件中心 · 浏览器助手等）
> 原始 goal：交付剩余 Legion 军团指挥团的任务，包括但不局限于对话中心，文件中心，浏览器助手等。首先盘点全项目，找出待办任务，评估优先级，设计方案，最后拆分任务，并分配给具体的智能体进行任务开发及测试验证。
> 标记：[auto-goal] + [slice-mode]（切片式 V3 编排：coder_i 到 tester_i 微链，经 docs/ORCHESTRATION-V3.md 已验证）
> 上游：将军 goal（T-073 本任务）。历史链参考（同一目标族已完成）：T-036 需求盘点 → T-044 方案搜索 → T-038 任务拆解 → T-039 用例设计 → S1~S8 coder/reviewer/tester/devops。
> 下游：researcher（docs/RESEARCH.md）→ breaker（docs/TASK_BREAKDOWN.md，须写「## slices」机器可读切片）→ test-designer → coder → reviewer → tester → devops。
> 断言可靠性：本文件每个「现状/缺口」表述均锚定可复核证据（本地代码行号 / git 分支提交 / 既有 docs 报告），见 §2 盘点表与 §8 证据索引。

## 0. 文档状态与阅读说明

- 本文件是 T-073「需求澄清」阶段产出，**取代**同目录旧产物 docs/REQUIREMENTS.md（T-014 离线任务队列，属完全不同流水线；旧版经 git 历史可回溯，见附录 B）。
- 本文用显式标注区分三类内容：
  - ✅ **已确认口径**：已由既有证据钉死、下游可直接依据的语义与边界。
  - ⚖️ **待将军裁决**：影响范围/优先级/口径的关键分歧，裁决前不得擅自当作结论。
  - ❓ **遗留/开放问题**：需将军答复或补充输入的项目；默认取推荐值，但明示「此为假设非结论」。
- 本阶段**只产出本文档**：不写实现、不做技术选型（留给 researcher/breaker）、不调 taskctl、不 push、不下依赖。所有「验收口径」写成**可测试语句**（命令/断言/判据），供 test-designer 直转用例。

---

## 1. 目标解读：将军需求 → 可验收语义

**goal 原句**：交付剩余 Legion 军团指挥团的任务，包括但不局限于对话中心，文件中心，浏览器助手等。首先盘点全项目，找出待办任务，评估优先级，设计方案，最后拆分任务，并分配给具体的智能体进行任务开发及测试验证。

**澄清后的语义（✅ 已确认）**：

| 原句关键词 | 澄清后含义 | 是否闭环 |
| --- | --- | --- |
| 交付**剩余** | 「剩余」指**当前未闭环/未交付**的工作，不是从零新建三中心。三中心（对话/文件/浏览器）在主分支已接线可用（见 §3）；「剩余」= ①三中心存在的「必须修改」级未闭合缺陷 ②未交付的收口/回归项 ③三中心以外的平台剩余功能。 | ⚖️ 范围边界见 §3、§9 OQ-1（**关键待裁决**） |
| 包括但不局限于…**等** | 明确**范围开放**：三中心是点名项，但非封闭全集。**等** 已确认包含：日程日历 / 通知中心（当前占位）、存量回归与宿主联调、双账本收敛、旧文档归档、候选增强等。 | ✅ 见 §3 in-scope 候选 |
| 首先**盘点全项目，找出待办任务** | 本阶段（requirement）必须产出**全项目盘点 + 待办清单**，作为后续优先级/拆分/派工的事实基准。 | ✅ §2 |
| 评估优先级 | 产出**P0/P1/P2** 分级建议，供将军拍板与下游排序。 | ✅ §6 |
| 设计方案 → 拆分 → 分配 → 开发 → 测试验证 | 属后续阶段（researcher/breaker/…/devops）；本阶段**只定义需求与验收口径**，不越过边界做方案与实现。 | ✅ §2.3 边界 |

**本阶段完成 ≠ 目标全部完成**：本阶段交付一份「明确、可验收的需求说明 + 待办清单 + 优先级 + 风险依赖」，目标其余环节由将军按流水线推进。

---

## 2. 全项目盘点：谁已交付 / 谁在途 / 谁是待办

> 盘点基准 = 当前 worktree 分支 w/T-073（与 main 同点 d3e057d）。三中心已在 main 接线；以下按证据分三档。

### 2.1 已合入 main（可视为已交付，非本批待办）

| 项 | 证据 |
| --- | --- |
| 对话中心后端（S1）：conversations/messages 表 + /api/chat/* + 审计/SSE | git：T-042/T-045/T-061/T-064；README §4 接口表；docs/T064-evidence（构建/CI 全绿） |
| 对话中心前端（S2）：ChatView + SSE 单源 kind 过滤 + 分页 | git：T-047/T-060；App.tsx:31,352；docs/review/T-060-REVIEW.md |
| 文件中心只读+写面（S3/S4）：/api/files list/read/download/upload/mkdir/rename/delete + token/confirm/仅回环 | git：T-042/T-049/T-058/T-062/T-063；serve.mjs 路由；files-api.test.mjs 34/34 |
| 文件中心前端（S5）：FilesView | git：T-049；App.tsx:32,354 |
| 浏览器助手后端（S6）：/api/web/fetch（SSRF 防护 + 正文抽取 + P0-3 共享 deadline） | git：T-040/T-057/T-059；web.test.mjs 12/12 |
| 浏览器助手前端（S7）：BrowserPanel + QuickTools「浏览网页」入口 | git：T-040/T-051(未合)；App.tsx:33,356；QuickTools.tsx:13,22 |
| V3 切片编排（P1）：/api/goal/slices、/api/test-report、/api/progress、/api/artifact、/api/patch、类型化槽位、D7 机器闸门、fix 回炉 | git + docs/ORCHESTRATION-V3.md 末「P1 实施记录」+ docs/P0-CONFIRMATION.md §8/§9（现场验收通过） |

### 2.2 在途（WIP 分支，未合入 main —— 不作为本批全新待办，但应在收口时合入/核对）

| 分支 | 内容 | 状态 |
| --- | --- | --- |
| w/T-064 | S1 部署/CI（devops）：ci.mjs + docs/DEPLOY.md；未发生产 | 待 promote |
| w/T-063 | S3 部署/CI（devops） | 待 promote |
| w/T-043 | 部署与 CI/CD（三中心早期，ci.mjs + DEPLOY.md） | 待 promote |
| w/T-051 | S7 浏览器前端收口：BrowserPanel 改名 BrowserView + 错误态判定 + IME Enter 守卫 | 待 promote（含对 S7 的增强，见 §5 R-A6） |
| w/T-059 | S6 测试执行（T-057 后） | 待 promote（含遗留 M1/M2 缺陷报告） |

> 说明：以上在途分支与本批待办存在重叠（尤其 w/T-051 正是 §5 R-A6 的目标），**本需求将「在途收口」列为候选待办**，由将军决定是否纳入本次派工或沿用既有分支完成。

### 2.3 确认为待办 / 未闭环（本批核心）

| # | 待办 | 性质 | 优先级建议 | 证据 |
| --- | --- | --- | --- | --- |
| T-1 | **F1：文件中心嵌套仓库 .git 元数据外泄**（security） | 缺陷（必须修改） | **P0** | serve.mjs:209-211 只判首段 '.git'；T-062 §5 F1 实测 read/download 'subrepo/.git/config' → 200 泄出 |
| T-2 | **F2：serve.mjs 单请求畸形 % 路径崩溃进程**（DoS） | 缺陷（必须修改） | **P0** | serve.mjs:944 顶层 decodeURIComponent 未捕获；T-062 §5 F2 实测 '/api/files%zz' → 进程 exit 1，后续全 000 |
| T-3 | **S6 浏览器抓取审计留痕零实现**（S6 AC5） | 缺陷（必须修改） | **P0** | T-057 M1 / T-059 M1：fetch 全程 0 行日志 |
| T-4 | **S6 body stall 超时归类错误**（应为 timeout 而非 web_error/abort） | 缺陷（必须修改） | **P1** | T-057 M2 / T-059 M2：headers 已回 body stall 被误分类 |
| T-5 | **S2 ChatView 异步回写缺会话身份守卫**（切会话/空间竞态串显） | 缺陷（必须修改） | **P1** | T-060 review M1：loadOlder/send 异步回写无会话守卫 |
| T-6 | **S7 前端错误态/命名收口**（BrowserView 对齐 + IME Enter + 错误态不透传正文） | 收口 | **P1** | w/T-051 已实现未合入；main 仍用 BrowserPanel 未含守卫 |
| T-7 | **R-1 存量回归与宿主联调**（whiteboard/tests/contract/board-plugin） | 回归 | **P1** | TASK_BREAKDOWN §4.5 R-1；contracts 56/56、whiteboard 67 |
| T-8 | **日程日历模块**（当前占位 toast） | 新模块 | **P1（建议）** | Sidebar.tsx:21,79；TASK_BREAKDOWN G-6 默认占位 |
| T-9 | **通知中心模块**（当前占位 toast） | 新模块 | **P1（建议）** | Sidebar.tsx:22,79；TASK_BREAKDOWN G-6 默认占位 |
| T-10 | **双账本收敛**（v1 tasks.json vs v2 SQLite 写源统一，P1-6） | 架构收敛 | **P2** | T-036 P1-6；RESEARCH R8；根 README §5 「并存只写其一」 |
| T-11 | **旧流水线文档归档**（P2-8） | 文档 | **P2** | T-036 P2-8；TASK_BREAKDOWN 附录 A/B |
| T-12 | **候选增强 X-1~X-5**（markdown 渲染/文件在线编辑/正文精抽取/HTML DOMPurify/Jina 云） | 增强（默认不做） | **P2** | TASK_BREAKDOWN §4.5；RESEARCH §12 |
| T-13 | **生产发布正式落地**（P1-LIVE-ROLLOUT 生产执行 + 发布批准） | 交付 | **P2** | docs/P1-LIVE-ROLLOUT.md；T-064 未发生产 |
| T-14 | **环境构建链路保障**（vite build EPERM、node_modules junction、DSH_CHECKOUT 等宿主/CI 侧补齐） | 环境 | **P2** | T-049/T-060/T-062 均记录 vite build EPERM（沙箱 named-pipe 拦截） |

> ⚠️ 表内 T-1/T-2/T-3/T-4/T-5 为**确认存在的「必须修改」级缺陷**，其中 T-1(F1) 与 T-2(F2) 已多次真实复现；按仓库「全绿才判定通过」口径，**三中心整体仍未达到可交付判据**——这是本批最重要的待办动机。

---

## 3. 范围边界（做什么 / 明确不做什么）

> 范围必须以「是否达成三中心与平台可交付」为准；凡超出本批目标、或与现有设计冲突的，一律显式排除并说明理由（不把假设当结论）。

### 3.1 范围内（In Scope）

**A. 三中心收尾（P0/P1，必做）**
- A1 文件中心：修复嵌套/内嵌 git 仓库 .git 元数据外泄（T-1/F1）。
- A2 文件中心及服务：畸形 percent-encoding 路径不得导致进程崩溃（T-2/F2）。
- A3 浏览器助手：每次抓取必须留存审计痕迹（T-3/S6-AC5）。
- A4 浏览器助手：body stall 超时必须归类为 timeout（T-4/S6-M2）。
- A5 对话中心：切会话/切空间不得串显（T-5/S2-M1）。
- A6 浏览器助手：错误态与命名收口（T-6/S7，对齐 BrowserView + IME Enter 守卫 + 错误态不落入正文分支）。
- A7 三中心浏览器主路径 + 实时/断线语义回归锚定（防引入新回归）。

**B. 平台剩余功能（P1/P2，须将军确认取舍）**
- B1 日程日历模块（T-8，建议 P1）。
- B2 通知中心模块（T-9，建议 P1）。
- B3 存量回归与宿主联调 R-1（T-7，建议 P1，tester/devops 阶段执行）。
- B4 双账本收敛（T-10，建议 P2）。
- B5 旧流水线文档归档（T-11，建议 P2）。

**C. 交付与工程（P2）**
- C1 候选增强 X-1~X-5（T-12，默认不做，将军勾选才追加，前置=本地盘点/禁网）。
- C2 生产发布正式落地（T-13，需将军批准）。
- C3 环境构建链路保障（T-14，宿主/CI 侧）。

### 3.2 范围外（明确不做什么，Out of Scope）

| 明确不做 | 理由 / 依据 |
| --- | --- |
| 🚫 不重写三中心为新技术栈 / 换库 / 换通道 | 三中心已按 RESEARCH 一等选型落地并验证；本次只收口不改架构。改变 = 推翻既定闸门 G-1..G-7，需将军单独立项。 |
| 🚫 不引入任何新运行时依赖（除非本地盘点可得且将军批准） | 禁网纪律（LEGION.md）；RESEARCH/TASK_BREAKDOWN 均明确 v1 默认零新依赖。 |
| 🚫 不实现「公网多用户 / 云同步 / 移动端」 | RESEARCH R9 已排除；与本地自托管定位冲突。 |
| 🚫 不做在线文件编辑（v2 CodeMirror/Monaco 属 X-2 增强，默认不做） | TASK_BREAKDOWN §4.5 X-2；RESEARCH E2/E3 标 v2。 |
| 🚫 不做浏览器无头渲染（v2 Playwright/Puppeteer） | 禁网无法下载 Chromium（RESEARCH F2/R3）；JS 渲染页为 v1 显式边界。 |
| 🚫 不承诺「绝不多执行一次 / exactly-once」类强一致 | 与既有流水线结论一致的边界；三中心为本地单体，不引入分布式强一致。 |
| 🚫 不发布生产（除将军明确批准 C2） | 发布需将军批准（T-064 边界）；本文档只定义「可发布状态」。 |
| 🚫 不写实现代码 / 不做技术选型 / 不调 taskctl / 不 push | 本角色边界（LEGION.md）；技术选型留 researcher、实现留 coder。 |

---

## 4. 术语与关键不变量

### 4.1 术语

| 术语 | 定义 |
| --- | --- |
| 三中心 | 对话中心（chat）/ 文件中心（files）/ 浏览器助手（browser）；均为 workbench 左侧模块，分别由 ChatView / FilesView / BrowserPanel（→BrowserView）提供。 |
| 剩余任务 | 本批目标所指的「未闭环工作」= §2.3 待办，非三中心的全新建造。 |
| 文件中心目录根 | 当前空间在 spaces 表登记的 local_dir（绑定本地文件夹）；未绑定 → 引导到空间设置，不得静默落到根外任意目录。 |
| .git 内部 | .git 目录下（含任一层级）内容；视为凭证/元数据保护区。**嵌套仓库**指子目录内含独立 .git 的仓库。 |
| 仅回环 | 仅接受本机回环请求；非回环返回 403（serve.mjs isLoopback 语义）。 |
| SSRF 防护 | 协议白名单 + 私网/回环/链路本地段逐跳阻断 + 重定向链再校验 + 限长/总超时 + 审计。 |
| 切片（slice） | V3 编排的独立可验证垂直单元 coder_i 到 tester_i，由 breaker 在「## slices」声明、守护注册派工（[slice-mode]）。 |
| D7 机器闸门 | tester 报告 testReport.passed=true 才自动 done；失败 → fix 回炉；预算用尽 → ❓ 升级将军。 |

### 4.2 关键不变量（既有、本批不得违反，均有用例锚定）

| # | 不变量 |
| --- | --- |
| I-1 | 零新增运行时依赖（node:sqlite/node:http/node:fs/EventSource/自研 React 均在产线）。 |
| I-2 | 仅回环 + 写需 token（serve.mjs 端点）。 |
| I-3 | chat 写统一走 handleWrite（by 必填 + audit + SSE）。 |
| I-4 | 对话/文件/浏览器三中心数据按 scope 隔离。 |
| I-5 | 远端/用户/文件内容不得以未净化 HTML 直插 DOM。 |
| I-6 | 文件写：覆盖需 overwrite=1、删除需 confirm=yes、非空目录拒删。 |
| I-7 | SSRF：协议白名单 + 私网/回环逐跳阻断 + 限长/超时 + 审计。 |
| I-8 | 实时推送并入单一 /api/events 按 kind 过滤（不新增 hub 事件连接）。 |
| I-9 | **任何请求（含畸形输入）不得导致服务进程整体崩溃**（本批新增，直接对准 F2）。 |
| I-10 | **文件面任何读写不得暴露非顶层 .git 内部**（本批强化，对准 F1）。 |

---

## 5. 需求清单（编号 + 优先级，每条含 背景 / 目标 / 验收口径）

> 优先级：P0 = 安全/健壮性/可交付门槛（不得跳过）；P1 = 正确性/完整性/主体验；P2 = 增强/可选/环境。
> 每条验收口径均为**可测试语句**，供 test-designer 直转用例（正常/边界/异常成对）。

### Part A —— 三中心收尾（缺陷 + 收口）

#### R-A1｜文件中心：禁止暴露嵌套/内嵌 git 仓库内部（F1）　【P0・安全】
- **背景**：assertNotGitInternal 仅判相对路径首段 === '.git'（serve.mjs:209-211）；嵌套仓库（子目录含独立 .git）的 .git/config 可经 read/download 返回 200，外泄仓库基线/凭证/元数据。写路径同样调该守卫，但首段为子目录名，未被拦截（T-062 §5 F1 真实复现）。
- **目标**：文件中心任何文件面操作（list/read/download/upload/mkdir/rename/delete）均不得暴露任一层级 .git 内部内容。
- **验收口径**：
  1. GET /api/files/read?scope=&path=subrepo/.git/config → **403**（非 200）；download 同。
  2. 顶层 .git/config 仍 403（既有行为不回归）。
  3. 写路径（upload/mkdir/rename/delete）对 .git 内部同样拒绝（403/400）。用例覆盖：嵌套仓库路径矩阵、顶层路径对照、读+写同强度。
  4. 补充回归用例（嵌套 .git 读/写拒）后，files-api.test.mjs 全绿。

#### R-A2｜文件中心及服务：畸形 percent-encoding 不得崩溃进程（F2）　【P0・健壮性/DoS】
- **背景**：serve.mjs:944 顶层 decodeURIComponent(url.pathname) 未捕获 URIError；单请求配对非法 % 路径（如 /api/files%zz）即令整个进程 exit 1，随后所有请求均 000（拒绝服务）。**已真实复现（T-062 §5 F2）**，影响任意端点（含写面）。
- **目标**：任何 HTTP 请求（含畸形 percent-encoding / NUL / 超长）不得导致 serve.mjs 进程崩溃；非法输入应返回明确 4xx 且进程存活。
- **验收口径**：
  1. curl 「<serve>/api/files%zz」→ 返回 400/404（非 HTTP 000）；进程仍存活，随后 /api/config 正常 200。
  2. 对 /api/files/*、/api/web/* 等所有路由的畸形路径做注入矩阵，进程存活、无未捕获异常日志。
  3. 长尾/超大畸形输入（≥1 万字符、重复 % 等）不崩溃、响应受控。
  4. 回归：files-api.test.mjs、web.test.mjs 全绿；稳定性冒烟（10 并发畸形请求不崩）。

#### R-A3｜浏览器助手：每次抓取必须留审计痕（S6 AC5）　【P0・审计】
- **背景**：/api/web/fetch 全程 0 行日志，S6 AC5「审计留痕」零实现（T-057 M1 / T-059 M1 复现）。
- **目标**：每次 fetch 产生可查的审计/日志记录（url、finalUrl、status、耗时、by 默认 general）。
- **验收口径**：
  1. 发起一次真实 fetch（含本地 mock 目标）后，应存在对应审计/日志行，含 url/finalUrl/status/耗时/by。
  2. 成功与失败（ssrf_blocked/timeout/too_large/http_<code>）皆留痕；被 SSRF 拦截也应留痕（含目标 URL）。
  3. 审计可经既有 /api/activity 或日志链路查询到；无痕 = 失败。
  4. 回归：web.test.mjs 全绿。

#### R-A4｜浏览器助手：body stall 超时归类为 timeout　【P1・正确性】
- **背景**：连接/headers 已返回但 body 拖拽（stall）超时被误分类为 web_error/abort 而非 timeout（T-057 M2 / T-059 M2 复现；T-059 亦观察到 code=undefined）。
- **目标**：body stall 超时与整链超时统一归类为 timeout；错误码可枚举、稳定。
- **验收口径**：
  1. 注入「headers 已回、body 长时间不吐」场景 → 返回 {ok:false, error, code:'timeout'}。
  2. 整链超时同样 code='timeout'；web_error/abort 仅用于真正的连接/网络错误。
  3. web.test.mjs 该场景用例通过；错误枚举与既有 TC-S6-xx 一致。

#### R-A5｜对话中心：切会话/切空间不得串显（S2 M1）　【P1・正确性】
- **背景**：ChatView 的 loadOlder/send 异步回写缺少会话身份守卫；快速切会话/切空间时，旧请求回写可能串到新会话造成串显（T-060 review M1）。
- **目标**：异步加载/发送的写回只作用于发起时的会话与空间，切走后不得污染当前视图。
- **验收口径**：
  1. 快速在 A/B 会话间切换并发起 loadOlder/send → 各会话消息不回串、不混入对方。
  2. 切空间后旧空间的异步响应不回写进新空间视图。
  3. 浏览器主路径（新建会话→发消息→实时收）无回归；pnpm build 全绿。

#### R-A6｜浏览器助手前端：错误态与命名收口（S7）　【P1・收口】
- **背景**：main 的 BrowserPanel 未含 S7 最终态（错误态判定、IME 中文 Enter 守卫、命名对齐）。w/T-051 已实现未合入。
- **目标**：浏览器助手面板与 ChatView/FilesView 命名与状态语义对齐；错误态（too_many_redirects/web_error）不落入正文分支；IME 输入 Enter 不误发请求。
- **验收口径**：
  1. 命名收敛（BrowserView，与 ChatView/FilesView 一致）。
  2. too_many_redirects/web_error 显示明确错误而非伪装成正文；成功与失败态可区分、可重试。
  3. IME 中间态按 Enter 不误触发抓取；地址栏历史可复用。
  4. pnpm build 全绿；QuickTools「浏览网页」入口与侧栏「浏览器助手」进入同一面板（active 状态一致）。

#### R-A7｜三中心主路径与实时/断线语义回归锚定　【P1・无回归】
- **背景**：三中心已在 main 接线，但必须锚定既有承诺（实时、断线重连、scope 隔离、渲染安全），防止收口引入回归。
- **目标**：确认三中心既有承诺在收口后仍成立，作为交付判据之一。
- **验收口径**：
  1. 对话：第二标签页同空间 ≤15s 实时收到；EventSource 断线自动重连；消息按纯文本渲染（无 dangerouslySetInnerHTML 直插正文，grep + 评审）。
  2. 文件：list/read/download/upload/mkdir/rename/delete 主路径走通；未绑定空间引导提示；越界/.git 403；overwrite/delete confirm 语义；预览以受控文本渲染。
  3. 浏览器：SSRF 私网拦截文案「已拦截：禁止访问内网地址」；限长/超时/非文本/4xx-5xx 可区分；结果以文本/markdown 渲染不直插远端 HTML。
  4. pnpm build + node --test（chat/skills/files-api/web/contracts 基线）全绿。

### Part B —— 平台剩余功能

#### R-B1｜日程日历模块（当前占位）　【P1・建议，⚠️ 待将军确认是否纳入】
- **背景**：Sidebar.tsx:21 有「日程日历」，当前点击仅 toast「占位模块」（:79）。README §3.8 标注 P1 后续接入。属「等」的点名外剩余功能。
- **目标**：将日程日历从占位转为可用模块（至少：可查看/创建日程条目并以日历视图呈现；与当前 scope/space 关联）。
- **验收口径**：
  1. 侧栏「日程日历」点击进入真实面板（非 toast 占位）。
  2. 可创建/查看/删除日程条目（最小闭环），条目带时间/标题/scope。
  3. 空态/错误态明确；未选定具体空间给出引导（与对话中心语义一致）。
  4. pnpm build 全绿；无回归到其它模块。
- **依赖/假设**：是否纳入本批由将军裁定（§9 OQ-3）；数据层/后端存储方案留 researcher。

#### R-B2｜通知中心模块（当前占位）　【P1・建议，⚠️ 待将军确认】
- **背景**：Sidebar.tsx:22「通知中心」当前占位 toast。目标是让将军/成员在台内收到任务/事件通知（而非仅依赖实时动态流）。
- **目标**：通知中心从占位转为可用模块，可聚合会话/任务/事件类通知（至少：展示通知列表 + 已读/未读 + 与 audit 关联）。
- **验收口径**：
  1. 侧栏「通知中心」进入真实面板（非占位 toast）。
  2. 可列出通知（含未读标记），点击可跳转/匹配对应任务/事件。
  3. 通知与既有事件流数据同源（避免第三数据源）；scope 隔离。
  4. pnpm build 全绿；无回归。
- **依赖/假设**：是否纳入本批由将军裁定（§9 OQ-3）；通知触发源（哪些事件转通知）留 researcher/breaker。

#### R-B3｜存量回归与宿主联调（R-1）　【P1，tester/devops 阶段执行】
- **背景**：TASK_BREAKDOWN R-1：三中心改动不应破坏既有模块（whiteboard / tests/contract / board-plugin）。本批收口绕不开此回归兜底。
- **目标**：确认受影响的存量模块在三中心改动+本批修复后仍可运行/注入；宿主环境项给出「通过」或「环境受限+复现步骤」结论。
- **验收口径**：
  1. cd whiteboard && node --test 全绿；白板起服冒烟可访问（按 whiteboard/docs/DEPLOY.md）。
  2. node tests/contract/contracts.test.mjs 全绿（56 用例基线）。
  3. board-plugin/plugins 按各自 README 验证（typecheck/build + 注入宿主冒烟）；宿主不可达时记录「环境受限 + 复现步骤」，不冒充通过。
  4. 结论写入 docs/TEST_REPORT.md。

#### R-B4｜双账本收敛（P1-6）　【P2】
- **背景**：v1 scrum/tasks.json 与 v2 SQLite 并存；纪律为「并存只写其一」（根 README §5）。三中心未引入第三写源，但双账本仍属悬而未决的架构收敛项。
- **目标**：明确并落地唯一的任务写源（以 v2 SQLite 为准），v1 降为只读/迁移/调试；消除双写造成的漂移。
- **验收口径**：
  1. 明确唯一写源（v2 SQLite）；迁移工具可幂等导入 v1 数据。
  2. 守护/看板/UI 不落到 v1 写路径；无新增第三写源。
  3. 文档（根 README §5 + scrum/README）与实际一致。
- **依赖**：将军确认 v1 进入只读/下线时机（§9 OQ-5）。

#### R-B5｜旧流水线文档归档（P2-8）　【P2】
- **背景**：docs/ 历次产物多代并存（T-011 白板 / T-014 / T-036 / T-044 / T-038 / T-039 …），缺明确的归档与替代标注。
- **目标**：为 docs/ 各代产物加明确的「当前/历史」标注与归档方式，避免下游误读旧产物。
- **验收口径**：
  1. 每份 docs/*.md 在头部标注所属流水线/任务/阶段 + 「当前/已取代」。
  2. 建立归档目录或索引（如 docs/archive/ + docs/README 索引）。
  3. 本文档（T-073）也完成对 T-014 的替代声明（附录 B）。

### Part C —— 交付与工程（P2，可选）

#### R-C1｜候选增强 X-1~X-5　【P2，默认不做】
- **背景**：RESEARCH §11.1 / TASK_BREAKDOWN §4.5 列的候选增强（markdown 渲染 / 文件在线编辑 / 正文精抽取 / HTML DOMPurify 渲染 / Jina 云兜底），默认不做、将军勾选才追加。
- **目标**：若将军勾选，则按对应前置（本地盘点、缺失即 blocker）作为独立切片实现；未勾选不进入默认验收面。
- **验收口径**（以勾选项为准）：各自有独立可验证口径 + 前置盘点结论；全 v1 默认零新依赖。

#### R-C2｜生产发布正式落地　【P2】
- **背景**：T-064/devops 已产出运行/回滚 runbook 与 CI（ci.mjs），但未获将军批准、未发布生产；P1-LIVE-ROLLOUT 仅沙箱验收。
- **目标**：将军批准后按 runbook 发布生产，并记录发布验证与回滚演练。
- **验收口径**：按 docs/DEPLOY.md 步骤执行；发布前全量 CI 绿；发布后主路径冒烟通过；回滚方案验证过。
- **依赖**：将军批准（§9 OQ-6）；生产写权限/宿主可达。

#### R-C3｜环境构建链路保障　【P2】
- **背景**：反复出现 vite build EPERM（沙箱 named-pipe 拦截 esbuild 子进程 spawn）、worktree 无 node_modules、DSH_CHECKOUT 需显式指认等环境依赖（多任务记录同因）。
- **目标**：在 CI/宿主侧补齐构建链路，使前端 pnpm build 可在无人为提权下真实跑通。
- **验收口径**：pnpm build 在标准环境 exit 0；node_modules junction / DSH_CHECKOUT 显式化；一旦沙箱解除限制即可复现。
- **依赖**：环境/宿主；不属于纯功能需求，可经宿主侧解决。

---

## 6. 优先级与排序建议

| 级 | 需求 | 一句话理由 |
| --- | --- | --- |
| **P0** | R-A1 / R-A2 / R-A3 | 安全（F1 泄密）+ DoS（F2 崩溃）+ 审计（A3）；三中心「全绿才可交付」的门槛项，**不顺延**。 |
| **P1** | R-A4 / R-A5 / R-A6 / R-A7 / R-B3 | 正确性 + 无回归 + 存量回归兜底；使三中心达到「功能正确、可验收」。 |
| **P1（建议）** | R-B1 / R-B2 | 「等」内的剩余功能；将军拍板是否纳入（见 OQ-3）。 |
| **P2** | R-B4 / R-B5 / R-C1 / R-C2 / R-C3 | 架构收敛 / 文档 / 增强 / 发布 / 环境。 |

**建议执行顺序（供 breaker 参考，非硬约束）**：
1. 先修 P0 三缺陷（A1/A2/A3，各自独立切片、文件域可并行）。
2. 再修 P1 正确性/收口（A4/A5/A6）+ 回归锚定（A7）。
3. 将军裁定 B1/B2/B3 后纳入；增强/归档/发布按将军勾选与批准追加。

---

## 7. 风险与依赖/假设

### 7.1 风险

| 风险 | 等级 | 说明 / 应对 |
| --- | --- | --- |
| R-1 禁网/依赖 | 高 | 三中心零新依赖；增强（X-1~X-5）须先本地盘点、缺失即 blocker、不下载。 |
| R-2 前端构建受限 | 中-高 | vite build EPERM（沙箱 named-pipe 拦截 esbuild）→ 前端 UI 验收依赖宿主/CI 补跑；P0 后端契约测试（node --test）不受影响。 |
| R-3 前端无 test runner | 中 | workbench 无 vitest；UI 验收 = pnpm build（typecheck）+ 浏览器手工清单；纯逻辑全落 node --test 契约。 |
| R-4 合并冲突 | 中 | 切片按文件域不相交拆分、同域串行；收口时注意三中心共用文件（serve.mjs / App.tsx / Sidebar.tsx / QuickTools.tsx / api.ts）避免并行叠加。 |
| R-5 缺陷域交叉 | 中 | F1/F2 同在 serve.mjs；A6 与 w/T-051 重叠；建议 A1/A2 与 A6 串行或明确文件域。 |
| R-6 宿主环境 | 中 | R-B3（board-plugin 注入）需 DSH Desktop 宿主；不可达按「环境受限+复现步骤」记录。 |
| R-7 实时/连接数 | 低-中 | chat 并入单一 /api/events 按 kind 过滤；避免新增 hub 事件连接（I-8）。 |
| R-8 安全边界 | 高 | F1/F2/SSRF/渲染安全为承重墙；任何改动不得弱化 I-5/I-7/I-9/I-10。 |
| R-9 口径漂移 | 中 | 既有 TC 与实现口径偶有漂移（如 TC-S6-15 200-envelope）；需将军/评审定口径（OQ-7）。 |

### 7.2 依赖与假设

| # | 依赖/假设 | 说明 |
| --- | --- | --- |
| D-1 | [slice-mode] 生效 | 目标以 V3 切片编排；breaker 须产出「## slices」（文件域不相交），守护注册派工。 |
| D-2 | 与在途分支收口 | w/T-064/T-063/T-043/T-051/T-059 在途；本批范围与它们重叠时按将军指示合并/沿用（OQ-1/OQ-2）。 |
| D-3 | scope 隔离与写纪律 | 三中心沿用「按 scope 隔离 + chat 写经 handleWrite + 文件/浏览器写仅回环+token」，不得破坏。 |
| D-4 | 缺陷归属 | P0 缺陷（F1/F2/M1/M2/S2-M1）属「既有/必须修改」，默认本批修复；若将军认为由既有任务处理需指明（OQ-2）。 |
| D-5 | 数据/API 契约 | 后续 coder 沿用 S1/S3/S4/S6 已定契约（/api/chat/*、/api/files/*、/api/web/fetch 形状），不推翻重设计（OQ-7 除外）。 |

---

## 8. 关键澄清结论（对矛盾点/模糊点/缺失边界的裁决）

1. **「剩余」的含义（✅ 确认）**：不是新建三中心，而是「三中心未闭合缺陷 + 平台剩余功能」。三中心已在 main 接线；本批最迫切动机是三中心存在**确认的必须修改缺陷非全绿**（F1/F2 等）。
2. **「包括但不局限于…等」＝范围开放（✅ 确认）**：除三中心外，日程日历/通知中心/存量回归/双账本收敛/文档归档/候选增强均属「等」候选；是否全部纳入由将军裁定（OQ-1/OQ-3）。
3. **P0 门槛 = 安全与健壮性（✅ 确认）**：F1（嵌套 .git 泄密）与 F2（畸形路径崩溃进程）为**安全/DoS**级，属不可推迟的门槛；仓库口径「全绿才可交付」要求先修复。
4. **渲染安全（✅ 确认）**：对话正文/文件预览/抓回内容一律不得以未净化 HTML 直插 DOM（I-5）；默认文本/markdown 渲染，HTML 路径须经 DOMPurify 且仅在将军勾选 X-4 时启用。
5. **SSRF 为硬性不变量（✅ 确认）**：协议白名单 + 私网/回环逐跳阻断 + 重定向链再校验 + 限长/总超时 + 审计。
6. **零新依赖（✅ 确认）**：v1 全部零新运行时依赖；增强项前置=本地盘点、缺失即 blocker。
7. **宿主/环境限制（⚠️ 显式标注，非结论）**：vite build EPERM、worktree 无 node_modules、board-plugin 注入需宿主——这些属**环境受限项**，技术上不能在本沙箱内人工提权跑通；按仓库规则在 evidence 声明，不冒充通过，交由宿主/CI 侧处理。
8. **是否沿用既有分支（⚖️ 待裁决）**：在途分支（T-051 等）与本批 A6 等重叠；建议「沿用既有 WIP 收口 + 补缺陷回归」而非另起新任务（OQ-2）。

---

## 9. 待将军确认（open questions｜每题给倾向与依据）

> 本批最关键的模糊点是「剩余任务」的**范围界定**（OQ-1）；它直接决定下游 researcher/breaker 拆什么。其余为取舍与口径。

- **OQ-1（范围界定，最关键）**：本批「剩余任务」的范围如何界定？
  - 倾向：**「三中心收尾（P0/P1，必做 N 项）+ 平台剩余（B 项按将军勾选）+ 可选增强/归档（C 项）」三级**。依据：goal 明示「包括但不局限于…等」+ 三中心已接线但非全绿（§2.3）。若将军只想收三中心，则剔除 B/C 项；若想完整交付指挥团，则纳入 B1/B2。
- **OQ-2（缺陷归属）**：P0/P1 缺陷（F1/F2/S6-AC5/S6-M2/S2-M1）是否统一纳入本批修复？倾向：是（作为三中心收口前置）；若将军认为某些由既有/在途任务处理，请指明归属。
- **OQ-3（calendar/notify 是否纳入）**：日程日历、通知中心两占位模块是否在本批实现？倾向：**实现**（若将军要「完整指挥团」），定位 P1；否则维持占位并标注文档。依据：原 TASK_BREAKDOWN G-6 默认占位，但 goal 的「等」暗示补齐。
- **OQ-4（候选增强）**：是否勾选 X-1~X-5（markdown/在线编辑/精抽取/HTML DOMPurify/Jina 云）？倾向：**默认全不勾选**，仅在本批扫描时标注存在性与前置（禁网盘点）。
- **OQ-5（双账本/归档）**：P1-6 双账本收敛、P2-8 文档归档是否纳入本批？倾向：**P2 顺带**（低优先、纯收敛/文档），或仅标注归属与触发条件。
- **OQ-6（生产发布）**：本批是否包含生产发布（需将军批准）？倾向：**仅交付「可发布状态」+ 部署 runbook**，发布由将军另行批准执行（对齐 T-064 边界）。
- **OQ-7（口径裁决）**：TC-S6-15 的响应口径——HTTP 200-envelope（body 内 code 区分）vs 顶层层 HTTP 400？倾向：**HTTP 200-envelope（方案①）**，body 内用 code 区分业务错误（与契约形状一致）；T-059 O4 已列此倾向待定。
- **OQ-8（环境受限项处理）**：vite build EPERM / node_modules / 宿主注入等环境项，是否由宿主/CI 侧在本批内补齐（作为 R-C3），还是仅记录留待宿主处理？倾向：**记录 + 归 R-C3 交宿主**，功能验证以 node --test + 前端评审为准。

---

## 10. 本阶段验收方式（requirement 自拟）

- 本文档落盘 docs/REQUIREMENTS.md；核对点：
  - **AC-1（逐条覆盖目标核心诉求，含 背景/目标/验收口径）**：§5 每条需求含三要素；§1 把 goal 原句逐词转成可验收语义。✅（§1/§5）
  - **AC-2（明确范围边界：做什么/明确不做什么）**：§3.1 in-scope、§3.2 明确 out-of-scope（含理由，非假设）。✅
  - **AC-3（关键术语无歧义，成功标准可度量/可测试）**：§4 术语 + 不变量 I-1..I-10；§5 每条验收成可测试语句（命令/断言/判据）。✅
  - **AC-4（输出编号+优先级 + 风险与依赖假设）**：§5 编号 R-xx + 优先级；§6 排序建议；§7 风险 R-1..R-9 与依赖 D-1..D-5、假设。✅
  - **AC-5（盘点全项目找待办 + 评估优先级）**：§2 三档盘点（已交付/在途/待办）+ §2.3 待办表。✅
  - **AC-6（不把模糊点留给下游，显式提问/标注假设）**：§9 OQ-1..OQ-8 逐条给倾向+依据；§8 对无法在沙箱验证的环境项显式标「环境受限，非结论」。✅
  - **AC-7（边界遵守）**：本阶段只产出本文档、无代码改动、未调 taskctl、未 push、未下载依赖；技术选型与实现留下游。✅（见本文档变更说明）
- 因本阶段无可运行代码，「真实验证」以「文档存在 + 关键口径/覆盖度读回核验」为准；不涉及 typecheck/build/test。

---

## 附录 A：范围外 / 待将军另行裁决（防止遗漏，非悬空）

| 项 | 来源 | 为何不在默认面 | 归属/触发 |
| --- | --- | --- | --- |
| v1 看板引擎下线 | P0-CONFIRMATION/README §5 | 遗留兼容；仅调试/迁移用 | devops；将军确认 v1 进入只读/下线时 |
| 公网多用户/云同步 | RESEARCH R9 | 与本地自托管定位冲突 | 单独立项（含认证/安全专题） |
| 浏览器无头渲染（v2） | RESEARCH F2/R3 | 禁网无法下载 Chromium | 单独立项（v2） |
| 文件在线编辑（v2） | RESEARCH E2/E3 | 包体/复杂度；v1 只读预览 | X-2 增强；将军勾选才追加 |
| DSH harness 工具面深度接线 | RESEARCH D3 | v2 深度接线；需宿主插件在线 | v2 立项 |
| 生产多环境（staging/prod）部署流水线 | T-064 | 未获批；属发布环节 | OQ-6；将军批准后由 devops |

## 附录 B：替代说明与遗留

- 本文档（T-073 requirement）**取代** docs/REQUIREMENTS.md 的 T-014 旧产物（离线任务队列流水线，与本次目标无关）。旧版可经 git 历史回溯。
- 同目录 RESEARCH.md（T-044）、TASK_BREAKDOWN.md（T-038）、TEST_CASES.md（T-039）为同一目标族的既有产物；本批可能由下游角色在其上续写/覆盖（与 T-038/T-039 的「取代声明」模式一致，不属本次改动）。
- 本批 P0 缺陷（F1/F2 等）的**详细复现步骤/日志**见 docs/T062-evidence/、docs/T059-evidence/ 等既有证据目录，可作下游修复与回归依据。
- 遗留问题：本阶段（requirement）无法在沙箱内验证前端构建（vite build EPERM）与宿主注入（board-plugin）——按仓库纪律如实声明为「环境受限」，不冒充通过；交由宿主/CI 侧（R-C3 / R-B3）。

---

## 附录 C：本轮复核（re-dispatch）记录与证据锚定

> 本轮为 T-073「需求澄清」的重新派工复核。复核结论：**既有 §1~§10 需求说明完整、准确，继续保持为其唯一权威基线**；本附录仅做增量证据锚定（append-only，未删除任何既有内容），并给出本轮复核的核对点，供将军验收与下游引用。

### C.1 复核范围与方法

- 复核对象：本文件 §1~§10 全部「现状/缺口」断言。
- 复核基准：当前 worktree 分支 `w/T-073`（HEAD = `1c0172d promote T-073`），源码即仓库当前实现态。
- 方法：逐条把「现状断言」对照**实际源码行号/命令输出**（read/grep），确认「缺口」仍存在、「已交付」仍接线，未随时间漂移。

### C.2 关键断言 → 代码证据（本轮实测核对）

| 断言（本文件引用） | 实测证据（当前源码） | 结论 |
| --- | --- | --- |
| F1：文件面 `assertNotGitInternal` 仅判首段 `.git`（§2.3 T-1 / §5 R-A1，serve.mjs:209-211） | `workbench/scripts/serve.mjs:208-212`：`if (parts[0] === '.git')` — 仅拦截相对路径**首段**为 `.git`；含 `subrepo/.git/config` 这类嵌套路径（首段为子目录名）会绕过；list/read/download/upload/mkdir/rename/delete 全走该守卫（读面 `previewTextFile`/`readFileBytes`/`openDownloadStream`、写面 `uploadBytes`/`createDir`/`renamePath`/`removePath` 均先 `assertNotGitInternal`）。 | ✅ 缺陷仍存在 |
| F2：服务顶层 `decodeURIComponent` 未捕获（§2.3 T-2 / §5 R-A2，serve.mjs:944） | `workbench/scripts/serve.mjs:942-944`：`createServer((req,res)=>{\n const url=new URL(...); const pathname=decodeURIComponent(url.pathname)` — 无 try/catch，单请求非法 % 路径即抛 URIError 使进程退出。 | ✅ 缺陷仍存在 |
| S6 审计留痕零实现（§2.3 T-3 / §5 R-A3，S6-AC5） | grep 全 `serve.mjs`：`console.log|console.error|audit|logger|appendFile` 仅 1 处命中 = 启动横幅 `serve.mjs:999`；`/api/web/fetch`（`handleWebApi`，`serve.mjs:964-968`）无任何日志/审计写。 | ✅ 缺陷仍存在 |
| 三中心前端接线（§2.1，App.tsx:352/354/356） | `workbench/src/App.tsx:351-356`：`active==='chat'→<ChatView/>`、`files→<FilesView/>`、`browser→<BrowserPanel/>`（**仍为 BrowserPanel，未改名 BrowserView** → A6/S7 收口未合入 main，与 §2.2 w/T-051 一致）。 | ✅ 已接线 / A6 待收口 |
| 日程日历/通知中心占位（§5 R-B1/R-B2，Sidebar:21/22/79） | `workbench/src/components/Sidebar.tsx:21-22`（`calendar`/`notify` 模块项）、`:79`（点击仅 `toast('info','「…」为占位模块…')`）。 | ✅ 占位待实现 |
| QuickTools 入口（§2.1 浏览器助手，QuickTools:13/22） | `workbench/src/components/QuickTools.tsx:12-14`（`files`→文件浏览、`web`→浏览网页、`kanban`→内部看板）、`:21-23`（`files→onOpenModule('files')`、`web→'browser'`、`kanban→openKanban()`）。 | ✅ 已接线 |
| 三中心「已接线」与「必须修改未闭合」并存 | 与源码一致：三个中心面板均在 App.tsx 接线（聊天/文件/浏览器），但 F1/F2/S6-AC5 三项「必须修改」级缺陷仍在源码中。 | ✅ 与 §2.3 结论一致 |

### C.3 本轮复核确认的澄清结论（与 §8 一致，不复述）

- 「剩余任务」= **三中心未闭合缺陷（P0）+ 收口/回归（P1）+ 平台剩余功能（B/C 按将军钩选）**，非从零新建三中心。
- P0 门槛 = 安全（F1 嵌套 `.git` 泄密）+ 健壮性（F2 畸形路径崩溃进程）+ 审计（S6-AC5）；仓库「全绿才可交付」口径下三者**不顺延**。
- 渲染安全（I-5）、SSRF（I-7）、零新依赖（I-1）为硬性不变量，本批不得弱化。

### C.4 遗留/待将军拍板（与 §9 对齐，本轮重述为可验收的决策项）

- **OQ-1（范围界定，最关键）**：本批「剩余任务」范围 → 建议「三中心收尾（P0/P1 必做）+ 平台剩余（B 按钩选）+ 可选（C）」三级。
- **OQ-2（缺陷归属）**：P0/P1 缺陷（F1/F2/S6-AC5/S6-M2/S2-M1）是否统一纳入本批 → 建议纳入（作三中心收口前置）。
- **OQ-3（calendar/notify）**：两占位模块是否本批实现 → 建议实现（若将军要「完整指挥团」），定位 P1。
- **OQ-4（候选增强 X-1~X-5）**：是否勾选 → 建议默认全不勾选，仅标注存在性与前置（禁网盘点）。
- **OQ-5（双账本/文档归档）**：P1-6/P2-8 是否纳入 → 建议 P2 顺带或仅标注归属。
- **OQ-6（生产发布）**：是否本批发布 → 建议仅交付「可发布状态」+ runbook，发布由将军另行批准。
- **OQ-7（TC-S6-15 口径）**：HTTP 200-envelope vs 顶层 HTTP 400 → 建议 200-envelope（body 用 code 区分业务错误）。
- **OQ-8（环境受限项）**：vite build EPERM / node_modules / 宿主注入 → 建议记录 + 归 R-C3/R-B3 交宿主/CI，功能验证以 node --test + 前端评审为准。

### C.5 下游可用性与阶段边界复核

- 下游链路：researcher（可选重扫方案）→ breaker（据 §5 R-A*~R-C* 写「## slices」机器可读切片，未拆则沿用 TASK_BREAKDOWN S 系列补缺陷面）→ test-designer（§5 每条验收口径已为可测试语句，可直转用例）→ coder → reviewer → tester → devops。
- 本阶段边界复核：本轮**未改任何实现代码、未做技术选型、未调 taskctl/看板写接口、未 push、未下载依赖**——仅增补本附录（文档）。技术选型与实现细节留 researcher/breaker/coder。

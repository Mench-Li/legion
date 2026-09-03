# T-044 方案搜索与选型报告：交付剩余 Legion 指挥团任务（对话中心 · 文件中心 · 浏览器助手）

> 角色：researcher（方案搜索）｜阶段：方案搜索｜执行任务：T-044（分支 w/T-044 独立 worktree）
> 输入：T-036 需求澄清（evidence 全文，经 `GET http://127.0.0.1:8787/api/task?id=T-036` 只读读取）+ 本仓库本地代码盘点（见 §1.2 行号证据表）
> 下游：breaker（docs/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
>
> **结论一句话**：三个占位中心全部走「**零新运行时依赖自研 + 复用既有层**」主线——① 对话中心 = team-hub v2 扩表扩 API（conversations/messages，node:sqlite 已有）+ 复用 `/api/events` SSE 推送 + 指挥台自研 React 会话面板；② 文件中心 = 扩展现有 `/api/fs`（仅回环 + git 仓库探测，已有）为 `/api/files` 文件面 + 自研目录树/文件表 + 轻量文本预览；③ 浏览器助手 v1 = 服务端 fetch 代理 + 正文抽取（零二进制，SSRF 必须防护），v2 再评估无头浏览器（Playwright/Puppeteer，受禁网安装限制）；④ 导航接线 = App.tsx 按 `active` 挂面板 + `React.lazy`（仿 SkillsPanel / Scene3D 既有先例）。所有第三方组件一律「先本地盘点可用再采纳，缺失即 blocker，不联网下载」。

## 0. 结论速览（TL;DR）

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

## 1. 输入、范围与方法

### 1.1 上游结论（T-036 需求盘点，requirement evidence 要点）

1. **现状盘点**：scrum v1（:4820 遗留）/ team-hub v2（:8787 SQLite 任务池）/ workbench 军团指挥台（:5173 React）/ board-plugin / whiteboard（零依赖 CRDT 白板，测试/ADR 齐）/ mesh+workflows。
2. **目标点名项现状**（占位区）：
   - **对话中心(chat)缺失**：仅 Sidebar 模块项，点击 toast「后续步骤接入」，全仓无聊天 UI/后端；
   - **文件中心(files)缺失**：Sidebar + QuickTools「DSH 文件工具」均未接线；
   - **浏览器助手(browser)有极雏形**：QuickTools→openKanban() 只跳经典看板，非真浏览。
3. **P0/P1/P2 清单**：P0-1 三中心需求澄清（已完成）；P0-2 对话中心=会话/消息存储与 API + 前端视图；P0-3 文件中心=文件浏览/上传/存储 + 真实 DSH 文件工具面接线；P0-4 浏览器助手=真网页抓取/浏览能力；P1-5 workbench 导航接线（files/browser/chat/calendar/notify 占位改真实路由）；P1-6 双账本收敛（v1/v2 写源统一）；P1-7 存量验收（whiteboard 起服联调、board-plugin 注入宿主验证）；P2-8 旧流水线文档归档。
4. 蓝图参考：scrum/sidebar-mockup.html（聊天区 + 看板侧栏面板的视觉效果，非实现约束）。

### 1.2 盘点方法：本地代码行号证据（均可复核）

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

### 1.3 评估维度与引用分级

- 每决策域按「适配度 / 成熟度 / 许可证 / 维护活跃度 / 迁移成本」评估。
- **引用分级**：`[本地]` = 本仓库文件行号，可离线复核（上表）；`[公开·待核]` = 公开项目主页/许可证，因本环境禁网且 web_search 工具不可用（实测报 Insufficient Balance），按既有知识定性并显式标注「待核」，**不编造 star/版本号/日期**。落地前（coder/devops 或将军）按 §14 待核清单复核。

## 2. 需求要点 → 决策域映射

| 需求要点（T-036） | 决策域 | 关键取舍点 |
| --- | --- | --- |
| 对话中心：会话/消息存储与 API + 前端视图 | A（存储/API）/ B（实时）/ C（UI） | 数据放哪、推送通道、UI 自研还是组件库 |
| 文件中心：浏览/上传/存储 + 真实文件工具面接线 | D（后端访问面）/ E（前端） | 端点位置、写权限、目录根语义、预览/编辑能力 |
| 浏览器助手：真网页抓取/浏览 | F（引擎）/ G（呈现） | 无头浏览器 vs 轻量抓取、SSRF 防护、JS 渲染边界 |
| P1-5 导航接线（5 个占位） | H（导航/模块化） | 面板挂接方式、懒加载、v1 覆盖范围 |
| 依赖纪律（禁网，缺失即 blocker） | 横切 | 默认零新依赖；外部库先本地盘点 |

## 3. 决策域 A：对话中心 —— 存储与 API

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **A1（推荐）team-hub v2 扩表扩 API**：conversations/messages + REST（GET/POST `/api/chat/*`）+ 统一 handleWrite/审计 + 复用 /api/events | 高 | 极高（产线已有） | 无新增（node:sqlite 属 Node 运行时） | 极低 | 优：单库单服务零新依赖；scope 分区与 by 审计模型现成（tasks 同构，server.mjs:66-173）；消息可与任务/evidence 关联（AI 执行过程写回）；运维/迁移成本最低。缺：聊天与任务写共享 SQLite（DatabaseSync 串行写，busy_timeout=5000）；高并发聊天需节制——v1 局域网多将军单机场景完全够用，风险低 |
| A2 独立消息服务（Node + 自有存储 + ws） | 中 | 高 | 引入 ws(MIT) | 中-高 | 优：隔离、可独立扩、协议自由。缺：重复基建（成员/空间/任务数据跨服务联查）、双服务运维、破坏「轻量单体」现状；无独立价值 |
| A3 整机聊天平台（Rocket.Chat MIT / Zulip Apache-2.0 / Mattermost / Matrix-Synapse） | 低 | 极高 | MIT/Apache-2.0（逐项待核） | 高 | 优：频道/私信/富文本/移动端全套。缺：独立服务 + 独立认证体系，与 team-hub 任务/编队数据、审计 SSE、scope 语义完全不融合；v1 明显过度，维护面爆炸 |
| A4 云聊天 SaaS（Stream/Sendbird 等） | 低 | 高 | 商业 | 高 | 数据出境 + 订阅成本 + 断网不可用，与本项目「本地自托管」定位冲突；排除 |

**建议 v1 数据形态（供 breaker，非实现）：** conversations(id, scope, title, kind∈{space,direct,task}, participants JSON, created/updated, last_message_at) + messages(id, conv_id, scope, author, kind∈{text,markdown,system}, body, meta JSON, clientTs, createdAt)，JSON-in-TEXT 列与现有表同构；`POST /api/chat/messages` 走统一 handleWrite（by 必填 → 审计 + SSE 广播，机制复用 server.mjs 现状）。

## 4. 决策域 B：对话中心 —— 实时通道

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **B1 复用 Server-Sent Events（推荐）** | 高 | 零新增：EventSource 浏览器原生（[公开] WHATWG 标准，待核），服务端 text/event-stream 已实现（server.mjs:1291-1302），客户端订阅先例在 api.ts:119-120 | 低。注意 HTTP/1.1 每源连接上限约 6 条：v1 已用 board/activity 两条事件源，建议把 chat 事件并入单一 `/api/events` 流按 kind 过滤，或走 `/hub` 同源合并，避免连接数撞顶 | **一等**：单向下行天然够聊天推送；消息上行走 REST POST（与现状一致）；EventSource 自动重连免费获得 |
| B2 WebSocket（引入 `ws` MIT） | 中 | 新增依赖 `ws`；Node 内置无 ws server（服务端需手写 upgrade 或引库） | 低-中：双向低延迟，但引入新依赖 + 新连接管理代码 | 备选：若未来需要在线状态/输入中/强双向交互再切 |
| B3 轮询兜底 | 低 | 零 | 延迟 3-15s，聊天体感差 | 仅作 SSE 断线兜底（workbench 已有 15s board 轮询先例） |

## 5. 决策域 C：对话中心 —— 前端 UI

| 候选 | 适配度 | 许可证/维护 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- |
| **C1 自研轻量 ChatView（推荐）**：会话列 + 消息气泡 + 输入框 + 分页加载 | 高 | 无新依赖 | 低 | 与指挥台暗色/3D 风格完全一致；交互参照 DSH Web GUI 的 ui-conversation 范式（[本地] packages/client/ui-conversation 存在可参考，非复用代码）；消息渲染 markdown 可选 react-markdown(MIT，待核) |
| C2 chatscope/chat-ui-kit-react | 中 | MIT（待核），维护中 | 中 | 现成气泡/输入/引用组件省时间，但样式主题需大量覆写以贴近指挥台；纯 UI 不绑后端，可作备选 |
| C3 stream-chat-react | 低 | SDK MIT（待核），核心能力绑定其后端 | 高 | 后端/定价耦合；排除 |
| C4 iframe 嵌现成聊天页 | 低 | 绑定 A3 | 高 | 与 A3 同排除 |

## 6. 决策域 D：文件中心 —— 后端文件访问面

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **D1（推荐）扩展 `/api/fs` → `/api/files`**（workbench serve.mjs，与 /hub 代理同源）：list(类型/大小/mtime/.git 标记)、read(文本截断+行数)、write/rename/mkdir/delete、上传(PUT raw body)、下载；目录根 = 当前空间 local_dir（未绑定回退显式配置根/仓库根）；沿用「仅回环可访问 + token 写」边界（serve.mjs:135 已有 403 先例） | 高 | 极高（目录浏览/git 探测已在产线，serve.mjs:139-148） | 无新增（node:fs/path/http 内置） | 低 | 优：零依赖；文件=空间绑定的真实仓库目录（任务证据/文档就在其中），语义自洽；只读默认、写操作要 token + 仅回环，攻击面小。缺：上传 multipart 需手写解析——用「fetch PUT raw bytes」规避（免 busboy/multer）；大文件需限尺寸与流式落盘 |
| D2 filebrowser sidecar（Apache-2.0，待核） | 中 | 高 | Apache-2.0 | 中-高 | 优：现成网盘式管理（分享/搜索/编辑器/用户）。缺：Go 二进制整机 + 独立用户/权限模型 + 新端口进程托管（services-plugin 需扩展）；面向家目录而非「当前空间 git 仓库根」语义；v1 重 |
| D3 DSH harness 文件工具面代理（把 DSH 的 fs 能力封装为 HTTP） | 中 | 高（宿主内） | 随 DSH | 高 | 优：复用沙箱语义。缺：DSH 文件工具是 agent 沙箱接口，浏览器直连需鉴权/路径策略 + 依赖 Desktop 插件运行时在线；定位 v2 深度接线；QuickTools「DSH 文件工具」卡片可先由 D1 目录浏览器充当真实能力面（即「接线」） |
| D4 云盘/WebDAV/S3 | 低 | 高 | 平台侧 | 中 | 不在「本地仓库目录」语义内；v2 另议 |

## 7. 决策域 E：文件中心 —— 前端浏览/预览/编辑

| 候选 | 适配度 | 许可证/维护 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- |
| **E1（推荐）自研目录树 + 文件表 + 文本预览**：导航/样式复用 FolderPickerModal 的既有交互（[本地] workbench/src/components/FolderPickerModal.tsx / api.ts:222-235）；v1 预览用受控 `<pre>`（防 XSS：textContent 渲染），按扩展名出图标/行数 | 高 | 无新依赖 | 低 | 覆盖「浏览/定位/下载/上传」核心诉求；对仓库内文本查看够用 |
| E2 CodeMirror 6（MIT，待核） | 中-高 | MIT，活跃 | 中 | 轻量（相对 Monaco），懒加载分 chunk 后可做「文本查看 + 简易编辑」；若 v1 就要编辑则推荐（先本地盘点依赖） |
| E3 Monaco Editor / @monaco-editor/react（MIT，待核） | 中 | MIT，微软维护 | 中-高 | 完整 IDE 体验，但包体大 + worker 配置复杂（与现有 Vite 构建要专门处理）；v2「在指挥台内写代码/改配置」再引入 |
| E4 react-arborist 等现成树组件（MIT，待核） | 中 | 中 | 中 | 可选小件；树不复杂时自研更贴合现有样式 |

## 8. 决策域 F：浏览器助手 —— 抓取引擎

**语义**：将军在指挥台内「喂 URL → 看页面内容/快照」，替代 QuickTools「跳看板」占位；未来演进为可操作浏览。

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **F1（推荐 v1）服务端 fetch 代理 + 正文抽取**：workbench serve.mjs（或 team-hub）加 `POST /api/web/fetch`（url 入参）；Node 内置 fetch(undici) 拉取 → 抽取：纯 HTML→标题/文本/链接摘要（零依赖）；正文精抽取用 @mozilla/readability(Apache-2.0，待核) 或 cheerio(MIT，待核)；可选 Turndown(MIT，待核) 转 Markdown | 高（v1 阅读场景） | 高 | 零二进制新依赖 | 低 | 优：轻、快、无需浏览器二进制（禁网环境唯一可行）；响应限长/超时/Content-Type 白名单可控。缺：**不能执行 JS**——SPA/反爬/需登录页拿不到正文（v2 无头浏览器补）；**服务端外呼=SSRF 高危**：必须禁私有网段/回环/内网、URL 协议白名单 http/https、重定向链校验、限大小超时、审计日志（本地已有 loopback-only 先例 serve.mjs:48,135 可扩展为「仅允许显式外网」策略） |
| F2 v2 无头浏览器 sidecar：Playwright（Apache-2.0）/ Puppeteer（Apache-2.0，均待核） | 中-高（未来） | 极高 | Apache-2.0 | 高 | 优：完整渲染/截图/DOM 操作，才是「浏览器助手」完全体。缺：需下载 Chromium（约 120-300MB，**禁网环境无法安装 → 实施时本地盘点即 blocker，不擅自下载**）；进程管理/内存开销；远控浏览器攻击面大；v1 不做 |
| F3 云阅读服务（Jina AI Reader r.jina.ai 等） | 中 | 服务可用性依赖第三方 | 商业 ToS | 低 | 内容经第三方、隐私/合规不可控、断网不可用；仅作「显式开关、默认关」选项 |
| F4 window.open / iframe 直嵌目标站 | 低 | — | — | 低 | 非通用方案：X-Frame-Options/CSP 普遍禁嵌，跨域不可读；保留 openKanban 新窗口作为「打开内部看板」快捷入口，不算浏览能力本体 |

## 9. 决策域 G：浏览器助手 —— 前端呈现

| 候选 | 适配度 | 结论 |
| --- | --- | --- |
| **G1 自研阅读面板（推荐）**：地址栏 + 请求态 + 结果视图。结果若为 Markdown → react-markdown(MIT) 渲染；若直接渲染抓回 HTML → 必须先 DOMPurify(MIT/MPL-2.0，待核) 净化（防存储型 XSS——抓取内容不可信） | 高 | 一等：默认把抓回内容转 Markdown/文本渲染，**避免把远端 HTML 直接落 DOM**，从根上收窄注入面 |
| G2 sandbox iframe 受限预览 | 中 | 辅助：对同意被嵌的站（X-Frame-Options 放行）用 sandbox 属性只读预览 |
| G3 DSH Web GUI 自身浏览器 | 低 | 宿主浏览器能力面（tab/窗口）与 workbench 集成属另一主题，v2 评估 |

## 10. 决策域 H：导航接线与模块化（横切 P1-5）

| 候选 | 适配度 | 迁移成本 | 结论 |
| --- | --- | --- | --- |
| **H1（推荐）App.tsx 按 `active` 渲染面板**：仿既有 skills 分支（App.tsx:346-350）为 chat/files/browser 各挂懒加载面板（React.lazy 仿 Scene3D，CenterPanel.tsx:8 先例）；Sidebar.clickModule 把这 3 个 id 从 toast 分支移入 onNavigate 分支（Sidebar.tsx:66-77）；「任务中心」维持 openKanban 外部经典看板页；calendar/notify 维持 toast（P1 后续再接线） | 高 | 低 | 一等：改动集中在 App/Sidebar 两个文件；无路由库依赖；三个面板各自独立 chunk，首屏体积不涨 |
| H2 引入 react-router | 中 | 中 | 备选：模块到两位数/需要 URL 深链（如 `#/chat/conv/1` 可分享）时再引入；当前 state 切换够用，避免过度工程 |
| H3 每模块独立 HTML 入口 | 低 | 高 | 与 SPA + 弹窗 + 独立看板页现状割裂；否 |

## 11. 一等选型汇总 → 直接支撑任务拆解的 v1 建议

### 11.1 实施拓扑建议（供 breaker 取舍，含边界）

1. **对话中心 v1**：team-hub 新增 conversations/messages 表 + `/api/chat/conversations|messages`（scope/分页/审计）→ 复用 /api/events 推 chat 事件 → workbench 侧 ChatView（会话列/气泡/发送/markdown 可选）+ Sidebar/App 接线。不做：富文本/文件附件/已读回执/多端同步（v2）。
2. **文件中心 v1**：serve.mjs 扩 `/api/files`（list/read/download/upload-PUT + 受限写操作，仅回环 + token）→ 目录根=当前空间 local_dir/仓库根 → workbench FilesView（树+表+预览）→ QuickTools「文件浏览」卡与侧栏 files 接线。不做：跨机器访问、权限系统、版本历史（git 已天然有）、在线编辑（v1 预览只读）。
3. **浏览器助手 v1**：`/api/web/fetch` 代理（SSRF 防护：协议白名单 + 私网阻断 + 限长超时 + 审计）→ 正文抽取（先零依赖正则版，可后挂 readability/cheerio）→ BrowserView 阅读面板（结果以文本/markdown 呈现，HTML 必须净化）→ QuickTools「打开浏览器」卡拆为「打开内部看板」与「浏览网页」两个入口。不做：JS 渲染页、登录态、点击/表单操作（v2 无头浏览器）。
4. **导航接线**：按 H1；calendar/notify 仍占位。
5. **依赖纪律**：以上 v1 全部零新依赖；若采纳 E2/react-markdown/readability 等，coder 首步先本地盘点（node_modules/pnpm store/仓库缓存），缺失即 blocker，不下载（§14 风险 R1）。

### 11.2 决策闸门（G-1..G-7，请将军裁决；建议默认值即上文一等）

- G-1 对话数据入 team-hub 单库（默认✅，否=A2 独立服务）
- G-2 实时通道 = 复用 SSE（默认✅，否=ws 新依赖）
- G-3 对话 UI 自研（默认✅，否=chat-ui-kit-react）
- G-4 文件端点放 workbench serve.mjs（默认✅，否=team-hub 或 filebrowser sidecar）；写默认只读+token
- G-5 浏览器引擎 = v1 fetch+抽取 / v2 无头（默认✅）；JS 渲染/登录页明示为 v1 边界
- G-6 导航 v1 范围 = chat/files/browser 三模块（默认✅；calendar/notify 仍占位）
- G-7 新依赖引入策略 = 先本地盘点、缺失即 blocker（默认✅，全 v1 路线零新依赖即自动满足）

## 12. 新技术 / 依赖逐项影响（许可 · 维护 · 学习成本 · 生态）

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

## 13. 许可证与合规总表

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

## 14. 风险与未知（含备选方案）

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

## 15. 引用与来源清单

### 15.1 [本地] 可复核（本仓库文件/接口，行号见 §1.2 证据表）
- workbench/src/components/Sidebar.tsx:13-21,66-77（占位模块与点击行为）
- workbench/src/components/QuickTools.tsx（DSH_TOOLS 占位卡，仅 browser→openKanban）
- workbench/src/App.tsx:346-350（模块面板渲染分支）；CenterPanel.tsx:8（lazy 先例）
- workbench/scripts/serve.mjs:8-10,48,135,139-148,163-166（/api/fs 与 /hub 代理，仅回环边界）
- workbench/src/api.ts:107,119-120,222-235（SSE 订阅与 /api/fs 客户端）
- team-hub/server.mjs:35,62-64,66-173,1291-1302（node:sqlite/WAL、表结构、/api/events SSE）
- workbench/package.json（React19/Vite7/three；engines ≥22.5）；whiteboard/docs/DEPLOY.md:9（零第三方运行时依赖先例）
- T-036 需求盘点 evidence：`GET http://127.0.0.1:8787/api/task?id=T-036`（只读）

### 15.2 [公开·待核]（禁网不可实时抓取，URL 供联网复核；本报告未引用未核实数字）
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

## 16. 本阶段验收标准（researcher 自拟，因任务 acceptance 留空）

- **AC-1 方案覆盖需求要点且每决策域 ≥2 候选对比（优缺/成本/风险）**：§3-§10 共 8 个决策域，每域 2-4 候选并给适配度/成熟度/许可/迁移成本与优缺点风险列。✅ 本文档 §3-§10。
- **AC-2 有明确推荐与理由，依据真实可查来源并注明引用**：推荐逐条锚定 [本地] 行号证据（§1.2/§15.1，可离线复核）；公开事实因本环境禁网（web_search 实测 Insufficient Balance）标注 [公开·待核] 并给规范 URL（§15.2），未编造任何数字。✅ §1.3/§15。
- **AC-3 新引入技术/依赖逐项说明影响（许可/维护/学习/生态）**：§12 逐项表 + §13 合规总表 + §14 R10 待核清单。✅
- **AC-4 结论可直接支撑后续任务拆解**：§11 给出 v1 实施拓扑（三中心 + 导航 + 依赖纪律）、边界（不做什么）、决策闸门 G-1..G-7 与建议默认值；breaker 可据此拆 S 系列子任务。✅
- **边界遵守**：本阶段只产出本文件，无代码改动、未调 taskctl、未 push、未下载任何依赖；「不确定项列为风险与备选」见 §14（R1-R10）。✅
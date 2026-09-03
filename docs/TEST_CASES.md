# T-039 测试用例 / 验收测试：交付剩余 Legion 指挥团任务（对话中心 · 文件中心 · 浏览器助手 · 导航接线）

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-039（分支 w/T-039 独立 worktree）
> 上游：T-036 需求澄清（P0~P2 待办）→ T-044 方案搜索（docs/RESEARCH.md：8 决策域 A~H + 决策闸门 G-1..G-7）→ T-038 任务拆解（docs/TASK_BREAKDOWN.md：G-0 + S1~S8 + R-1 + X-1~X-5）
> 下游：coder（按 TASK_BREAKDOWN §3 波次认领 S1~S8，并把本文档 P0 用例落成契约测试）→ reviewer → tester（执行全部用例 + S8/R-1 回归，输出 docs/TEST_REPORT.md）→ devops
> 依据：TASK_BREAKDOWN §4 各子任务「验收点 AC + 完成口径 DoD + 测试锚点」、RESEARCH §11 v1 拓扑 / §11.2 闸门默认值、LEGION.md 纪律。
>
> 取代声明：本文档取代旧流水线产物 docs/TEST_CASES.md（T-012 白板用例；旧版经 git 历史可回溯）。本阶段只产出本文档：不写业务实现代码、不执行用例（执行为 tester 职责）。

## 0. 结论速览

- 本阶段交付单件：本文档。共 110 条用例（S1 18 / S2 11 / S3 15 / S4 17 / S5 10 / S6 16 / S7 10 / S8 8 / R-1 5），每条含 前置条件 / 操作步骤 / 期望结果与通过判据，类别 🟢正常 / 🟡边界 / 🔴异常，优先级 P0（该子任务验收门槛）/ P1（重要）/ P2（增强）逐条标注。
- 验收标准用例化：TASK_BREAKDOWN 每个 AC 逐条映射到 TC（见 §6 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果」列，无黑盒。
- 关键业务规则正反向成对：scope 隔离、author/by 绑定、消息分页、路径根内规范化、overwrite/delete 二次确认、写 token、SSRF（协议/网段/重定向链）、渲染安全（不直插 HTML）等均给正向 + 反向用例（§5 矩阵）。
- 测试代码落点说明（本阶段为何不新增可执行测试文件）：S1~S8 目标代码尚未实现（已 grep 复核：仓库无 /api/chat、/api/files、/api/web、ChatView、files-api.test/web.test/chat.test），此时落测试文件必然全红，违反仓库「真实验证」纪律；TASK_BREAKDOWN §4 已把测试文件所有权划给对应 coder（S1→team-hub/chat.test.mjs，S3/S4→workbench/scripts/files-api.test.mjs，S6→workbench/scripts/web.test.mjs）。本文档「自动化落点」列 + 附录 B 给出每个文件必须覆盖的断言清单与骨架，coder 实现时照此即可满足 P0；tester 照 §2 执行。
- 现存基线（今天可跑、已实测跑绿）：<code>node team-hub/skills.test.mjs</code> → 12/12 pass；<code>node tests/contract/contracts.test.mjs</code> → 56/56 pass（沙箱 spawn 限制下用直跑等效，见 §2 注）；两组是 R-1/S8 回归基线。
- 用例编号约定：TC-S<子任务>-<序号> 与 TASK_BREAKDOWN 子任务一一对应；R-1 用 TC-R1-<序号>。X-1~X-5 是「默认不做」的候选增强，未勾选前不建用例；勾选后由将军追加（每项前置 = 本地盘点，缺失即 blocker）。
- 裁决依赖标记 ⚖️：凡属「建议默认值」（消息长度上限、上传/读取上限、web maxBytes/timeout、.git 目录可读性）在用例内标注；实现以 coder 导出的配置常量/env 为准，用例断言一律用「三值法」围绕该常量（上限-1B / 上限 / 上限+1B），将军或 coder 定值后无需改用例。

## 1. 输入、工作假设与硬性不变量

### 1.1 决策闸门默认值（G-1..G-7，本用例按 RESEARCH 一等默认展开）

| 闸门 | 默认（本用例判定依据） | 对立主张 | 翻转影响（用例） |
| --- | --- | --- | --- |
| G-1 对话数据 | team-hub v2 单库扩表扩 API（A1） | 独立消息服务 / 整机聊天 | S1/S2 用例整体重写 |
| G-2 实时通道 | 复用 /api/events SSE（B1），客户端按 kind 过滤，不新增连接 | WebSocket（ws 依赖） | S1/S2 推送类用例全换 |
| G-3 对话 UI | 自研 ChatView（C1） | chat-ui-kit-react | 仅 S2 渲染类用例替换 |
| G-4 文件端点/写权限 | workbench serve.mjs 扩 /api/files（D1）；默认只读 + 写需 token + 仅回环 | filebrowser sidecar 等 | S3/S4/S5 用例迁移 |
| G-5 浏览器引擎 | v1 服务端 fetch 代理 + 正文抽取（F1）；JS 渲染/登录页 = 显式边界 | 无头浏览器 v2 / Jina 云 | S6/S7 用例整体换 |
| G-6 导航 v1 范围 | chat/files/browser 三模块接线；calendar/notify 维持占位 | 五模块全接 | 追加 2 组前端接线用例 |
| G-7 新依赖策略 | 先本地盘点、缺失即 blocker；v1 默认零新依赖 | — | 所有「零依赖」断言语义变 |

> G-0 完成 = 将军对 G-1..G-7 确认默认或给翻转裁决；未逐项裁决视为按默认放行。本文档 §1.1 即默认表，翻转时只改对应用例预期、不动其余。

### 1.2 硬性不变量（任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I1 | 零新增运行时依赖（node:sqlite / node:http / node:fs / EventSource / 自研 React） | TC-S1-18 / TC-S3-15 / TC-S4-17 / TC-S6-16 |
| I2 | 仅回环可访问 + 写需 token（serve.mjs 端点） | TC-S3-11 / TC-S4-13 |
| I3 | chat 写统一走 handleWrite（by 必填 + audit + SSE 广播） | TC-S1-03 / TC-S1-13 / TC-S1-14 / TC-S1-17 |
| I4 | 对话/文件/浏览器三中心数据按 scope 隔离 | TC-S1-03..05 / TC-S2-05 / TC-S3-03 |
| I5 | 远端/用户/文件内容不得以未净化 HTML 直插 DOM | TC-S2-09 / TC-S5-08 / TC-S7-07 |
| I6 | 文件写：覆盖需 overwrite=1、删除需 confirm 二次确认、非空目录拒删 | TC-S4-03/04/09..12 |
| I7 | SSRF：协议白名单 + 私网/回环逐跳阻断 + 限长/超时 + 审计 | TC-S6-04/05/06/07/08/09/13 |
| I8 | 实时推送并入单一 /api/events 按 kind 过滤（不新增 hub 事件连接） | TC-S1-14 / TC-S2-08 / TC-S8-05 |

## 2. 测试分层与执行方式（谁在什么时候跑）

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 契约测试（node:test）：team-hub/chat.test.mjs、workbench/scripts/files-api.test.mjs、workbench/scripts/web.test.mjs、既有 team-hub/skills.test.mjs、tests/contract/contracts.test.mjs | S1/S3/S4/S6 纯逻辑与 DAO/路由契约；既有基线 | coder 随实现交付并自跑；tester 验收复跑 | 本环境沙箱下 node --test 因 child spawn 被禁（EPERM）；已验证直跑等效：node <文件>（node:test 进程内执行、不 spawn），T-039 已以此跑绿 skills 12/12 |
| L1 | HTTP 冒烟（curl / node fetch 脚本）：team-hub 起临时库 + 临时端口；serve.mjs 起临时端口 + 本地 mock HTTP 服务 | 路由、鉴权、审计、SSE 事件、越界/SSRF 防护端到端 | tester（S1/S3/S4/S6 完成后） | 禁网：web 抓取目标一律用本地 mock 服务器（§8.1）；非回环请求本机无法制造 → 走函数级/评审证据（TC-S3-11） |
| L2 | 浏览器手工验收（:5173，构建产物） | S2/S5/S7/S8 交互主路径与错误态 | tester + 将军验收（清单模板见 §7） | 改前端后须 pnpm build 再验；旧标签 Ctrl+F5 |
| L3 | 集成回归：pnpm build + L0 全量 + 三中心主路径走查 + 文档核对 | S8 / R-1 | tester / devops | whiteboard 与 contracts 属 R-1 基线（TC-R1-01/03） |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> 带 ⚖️ 者为实现期可配项：实现必须把该值导出为常量或读 env，测试用「三值法」（常量-1 / 常量 / 常量+1）断言，定值后无需改用例。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| chat SSE 推送延迟 | ≤ 5s（S1 AC4） | 订阅 /api/events 后写一条消息，≤5s 收到对应 chat 事件帧 |
| chat UI 实时可见 | ≤ 15s（workbench 轮询/重连节拍） | 第二标签页同 scope ≤15s 出现新消息 |
| 消息分页 | limit 默认 50；缺省按默认 | 翻页结果升序、无重复、无遗漏；非法 limit 拒绝 |
| 消息正文长度上限 ⚖️ | MAX_BODY（建议 8000 字符） | MAX_BODY 长度 → 200；MAX_BODY+1 → 400 |
| 会话/消息 id | 服务端生成 | 唯一、非空、稳定排序（createdAt/updatedAt 单调） |
| 文件 read 截断阈值 ⚖️ | MAX_READ（建议 256 KiB） | 文本 ≤ 阈值全量；> 阈值 truncated=true + 行数/总长标注 |
| 文件上传上限 ⚖️ | MAX_UPLOAD（建议可配，默认 64 MiB） | MAX_UPLOAD → 200；MAX_UPLOAD+1 → 拒绝且不落盘 |
| web fetch maxBytes ⚖️ | ≤ 2 MiB（可配） | > maxBytes → error=too_large（或截断并标注） |
| web fetch timeoutMs ⚖️ | ≤ 10s（可配） | 超时 → error=timeout；测试注入小超时值 |
| SSE 事件源连接数 | hub 事件源相对改造前 ≤ +1 | devtools Network 实测（TC-S2-08 / TC-S8-05） |

## 4. 用例目录

> 图例：类别 🟢正常 / 🟡边界 / 🔴异常；优先级 P0（验收门槛）/ P1 / P2；「自动化落点」= 测试文件（coder 落盘）或 L1 curl / L2 浏览器 / 评审（grep + 代码审查断言）。

### Phase 1 对话中心（S1 后端 · S2 前端）

#### S1 对话中心后端（team-hub 扩表扩 API + 审计/SSE）——自动化：team-hub/chat.test.mjs + L1 curl + SSE 脚本

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | 临时库（TEAM_HUB_DB）起的 team-hub；已选 scope=software | POST /api/chat/conversations {scope:'software', title:'软件流水线讨论', kind:'space', participants:['general','coder'], by:'general'} | 200 {ok:true,...}；会话含 id/createdAt/updatedAt/last_message_at=null；GET /api/chat/conversations?scope=software 列表含它且按 updatedAt desc 排首 | chat.test.mjs | S1 AC1/AC3；P0-2 |
| TC-S1-02 | 🟢 P0 | 同上，已建 2 个不同 scope 会话 | GET /api/chat/conversations?scope=software | 仅返回 software 会话，一条也不含 default/marketing 会话（scope 过滤正向） | chat.test.mjs | S1 AC1；I4 |
| TC-S1-03 | 🔴 P0 | 同上 | GET /api/chat/conversations?scope=default 对比 software；再 POST 消息到 software 会话但 body 带 scope:'marketing' | default 列表查不到 software 会话（隔离反向）；跨 scope 写不串（消息只落 software 会话） | chat.test.mjs | S1 AC1；I4 |
| TC-S1-04 | 🔴 P0 | 同上 | POST /api/chat/conversations {kind:'channel', ...}（kind 非法） | 400，error 指明 kind 必须 ∈ {space,direct,task} | chat.test.mjs | S1 AC1/AC5 |
| TC-S1-05 | 🔴 P0 | 同上 | ①POST 会话缺 by ②POST 会话 body 为非法 JSON | ①400 error 含「缺少操作者身份 by」②400 非 500；两请求均无 audit 落库 | chat.test.mjs | S1 AC5；I3 |
| TC-S1-06 | 🟢 P0 | 已有会话 C1（software） | POST /api/chat/messages {conv:'C1', scope:'software', kind:'text', body:'hello', clientTs:..., by:'general'} | 200；GET /api/chat/messages?conv=C1 返回 1 条升序含 author=general、createdAt 有值；会话 last_message_at 更新为该消息时间 | chat.test.mjs | S1 AC1/AC3 |
| TC-S1-07 | 🔴 P0 | 同上 | POST /api/chat/messages 时 body 另带 author:'other' | 存储/返回的 author 恒等于 by（general），防冒名（author 由服务端绑定） | chat.test.mjs | S1 AC5；A1 |
| TC-S1-08 | 🟢 P0 | 同一会话已按序发 25 条（t1<t2<...<t25） | GET /api/chat/messages?conv=C1&limit=10 → 取末条游标 → 再取 10 → 再取 5 | 每页升序 10/10/5 条；三页拼接 = 全 25 条无重复无遗漏；支持 before 游标翻页 | chat.test.mjs | S1 AC1 分页 |
| TC-S1-09 | 🟡 P0 | 空会话 C2；会话 C1 有 3 条 | ①GET messages?conv=C2 ②before=最旧之前/最新之后 ③limit 缺省 ④limit=0/-1/abc | ①200 空数组 ②超界 → 200 空数组 ③缺省按默认(50)返回全部 ④limit≤0 或非数 → 400 | chat.test.mjs | S1 AC1 边界 |
| TC-S1-10 | 🔴 P0 | 无该会话 | POST /api/chat/messages {conv:'C-999', by:'general'} | 400（conv 不存在，error 可读），不写任何消息行 | chat.test.mjs | S1 AC1 异常 |
| TC-S1-11 | 🔴 P0 | 会话 C1 | POST 消息 body='' / body='   ' | 400 error 指明正文为空 | chat.test.mjs | S1 AC1 |
| TC-S1-12 | 🟡 P1 | 会话 C1；MAX_BODY=8000 | ①body=8000 字符 ②body=8001 字符 | ①200 ②400 拒绝且不落库 | chat.test.mjs | S1 AC1；§3 |
| TC-S1-13 | 🟢 P0 | 完成 TC-S1-01/06 | GET /api/activity?scope=software | 含 audit 行 action∈{chat:create, chat:message}，member/scope/detail 形状正确，时间升序 | chat.test.mjs + L1 | S1 AC3；I3 |
| TC-S1-14 | 🟢 P1 | 起真服务（临时端口+临时库）；HTTP 客户端连 /api/events | 流建立后 POST 一条消息；断言 5s 内收到 data 帧 | 收到事件 {action:'chat:message', scope, member:'general', detail}；broadcast 复用既有 /api/events（单一流） | L1 SSE 脚本 | S1 AC4；I8 |
| TC-S1-15 | 🟡 P1 | 同上；另开客户端订阅后主动断开 | 断开后继续 POST 两条消息 | 服务端不崩、其余订阅客户端仍收到；eventClients 清理无泄漏（重复断开/订阅循环后连接数不回涨） | L1 | S1 AC4；R5 |
| TC-S1-16 | 🟢 P1 | 旧库（无 conversations/messages 表，含旧 tasks/skills 数据） | 以 TEAM_HUB_DB=旧库 启动/import server.mjs；再跑 skills 基线 | 启动自动建 chat 两表（无异常）；旧表数据完整；skills.test 直跑仍 12/12 绿 | chat.test.mjs 迁移用例 | S1 AC2 |
| TC-S1-17 | 🔴 P1 | 以 TEAM_HUB_TOKEN=tk 起服务 | ①无 token POST 消息 ②错 token ③对 token ④无 token GET 会话列表 | ①②401 error「Bearer token 无效」③200 ④读请求仍放行 200（与既有 authorized 语义一致） | chat.test.mjs + L1 | S1 AC5；I3 |
| TC-S1-18 | 🟢 P2 | S1 实现完成 | 核对 team-hub 依赖清单 / git diff | package.json 未新增任何依赖（只用 node:sqlite/node:http/node:crypto 内置）；evidence 明示 | 评审 | S1 AC6；I1 |

#### S2 对话中心前端（ChatView + 接线）——自动化：pnpm build（L0）+ L2 浏览器清单 + 评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | workbench 依赖已装 | pnpm build（= tsc --noEmit && vite build） | 0 类型错误（strict + noUnusedLocals/noUnusedParameters）；若用 React.lazy，产物含 chat 独立 chunk | L0 build | S2 AC1 |
| TC-S2-02 | 🟢 P0 | 中枢 :8787 可达；:5173 已托管构建产物；选中具体空间 software | 侧栏点「对话中心」→ 新建会话 → 输入消息发送 | 面板出现会话列表与消息区；发送后气泡即时出现（无整页刷新）；消息内容正确显示 | L2 | S2 AC3；P0-2 |
| TC-S2-03 | 🟢 P0 | 同上；另开第二标签页同空间进入同一会话 | 标签 A 发消息，观察标签 B | B 在 ≤15s 内自动出现新消息（SSE 实时接收） | L2 | S2 AC3/AC4 |
| TC-S2-04 | 🟢 P0 | 已发 ≥3 条消息 | 刷新页面重新进入会话 | 历史消息完整恢复（经 GET /api/chat/messages） | L2 | S2 AC3 |
| TC-S2-05 | 🟡 P0 | software 与 default 两空间各有会话与消息 | 从 software 切到 default 空间再切回 | 会话/消息随空间切换、互不串：default 看不到 software 消息（反向隔离断言）；切回 software 数据仍在 | L2 | S2 AC2；I4 |
| TC-S2-06 | 🟡 P0 | 选中「全部空间」 | 打开对话中心 | 显示「请先选择具体工作空间」引导提示，不报错不白屏 | L2 | S2 AC2 |
| TC-S2-07 | 🔴 P0 | 打开对话中心已输入草稿 | 停掉中枢（或代理 502）后点发送；再恢复 | toast 错误提示；输入框草稿不丢失；中枢恢复后可重发成功 | L2 | S2 AC6 |
| TC-S2-08 | 🟡 P1 | 进入对话中心并保持打开；右侧实时动态也在订阅 | devtools Network 过滤 EventStream，数 hub 事件源连接数；再观察动态流 | hub 事件源连接数相对改造前不增加（单一 /api/events 按 kind 过滤 chat:*）；「实时动态」既有事件流正常（未被 chat 事件吞并/覆盖） | L2 devtools | S2 AC4；I8 |
| TC-S2-09 | 🔴 P1 | 会话已发含 <img src=x onerror=alert(1)>、<script>alert(1)</script>、[x](javascript:alert(1)) 的消息 | 打开会话查看消息 | 按纯文本显示、脚本不执行（无弹窗/无网络请求）；评审 + grep 断言 ChatView 无 dangerouslySetInnerHTML 直插正文（正向对照：普通文本消息正常显示） | L2 + 评审/grep | S2 AC5；I5；R7 |
| TC-S2-10 | 🟡 P1 | 打开会话 | ①点发送（空输入）②粘贴 8001 字符发送 ③快速连发 5 条 | ①按钮禁用或提示，无请求 ②错误提示（后端 400 映射 toast）且草稿保留 ③消息最终顺序与发送一致、无丢失（last_message_at 单调） | L2 | S2 AC6；§3 |
| TC-S2-11 | 🟡 P2 | 服务端已存 kind=markdown 消息（X-1 未勾选） | 打开会话查看该消息 | 按纯文本渲染（markdown 语法原样显示）；不因未知 kind 白屏/报错（kind 白名单外消息按文本兜底） | L2 | S2 AC5；X-1 前置 |

### Phase 2 文件中心（S3 只读面 · S4 写面 · S5 前端）

#### S3 文件后端·只读面（serve.mjs /api/files）——自动化：workbench/scripts/files-api.test.mjs + L1 curl + 评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | scope 已在 spaces 表登记 local_dir（夹具目录含子目录+文本+二进制+.git 仓库目录） | GET /api/files/list?scope=<id>&path= | 200；body={root,path,entries:[{name,type:'dir'|'file',size,mtime,isRepo?,ext}]}；目录在前排序；含 .git 的目录 isRepo=true；root=该空间 local_dir | files-api.test.mjs | S3 AC1/AC3；P0-3 |
| TC-S3-02 | 🟡 P0 | 同上 | ①path='' ②path='.' ③空目录 path ④path 缺省 | ①/②/④ → 200 根内容；③ → 200 entries=[]（不报错） | files-api.test.mjs | S3 AC1 |
| TC-S3-03 | 🔴 P0 | scope 无 local_dir（未绑定） | GET /api/files/list?scope=<未绑定id>&path= | 400/可理解错误：提示「请先在空间设置绑定本地文件夹」；绝不静默落到仓库根以外或任意目录（响应不含任何文件列表） | files-api.test.mjs | S3 契约；I4 |
| TC-S3-04 | 🔴 P0 | 已绑定 | ①list 指向文件路径 ②path 指向不存在目录 | 均 400，error 可读（「不是目录」/「不存在」），非 500 | files-api.test.mjs | S3 AC1 异常 |
| TC-S3-05 | 🟢 P0 | 夹具含文本文件（< MAX_READ） | GET /api/files/read?scope=&path=相对文本 | 200 含 content（全文）+ lineCount + totalBytes；truncated=false | files-api.test.mjs | S3 AC1 |
| TC-S3-06 | 🟡 P0 | 夹具含 >MAX_READ 大文本 | 同 read | 200 content 截断且 truncated=true + 提示（行数/总长仍给全）；文件缺失 → 400 | files-api.test.mjs | S3 AC1/AC4 |
| TC-S3-07 | 🔴 P0 | 夹具含 .png/.zip | read 该二进制 | 明确「二进制文件不可预览」提示响应，不输出乱码/不崩 | files-api.test.mjs | S3 AC4 |
| TC-S3-08 | 🟢 P0 | 夹具文件 F（内容已知） | GET /api/files/download?scope=&path=F | 200 原始字节与磁盘逐字节一致；Content-Type / Content-Disposition 合理（下载语义） | files-api.test.mjs | S3 AC1 |
| TC-S3-09 | 🔴 P0 | 夹具根 R 内含 escape.txt；根外 outside.txt | 逐项请求：path=../outside.txt、/绝对越根路径、..%2Foutside.txt、path 含 NUL(%00)、C:/Windows/win.ini（Windows 盘符越根） | 全部 400/403 拒绝；断言 normalize 后仍在根内才放行；错误信息明确（路径逃逸主矩阵） | files-api.test.mjs | S3 AC2 |
| TC-S3-10 | 🟡 P1 | 根内 symlink→根内文件；symlink→根外文件 | read/list 两个 symlink | 界内 symlink 放行（解析后仍在根内）；根外 symlink 拒绝 400/403（解析目标越根即拒） | files-api.test.mjs | S3 AC2 |
| TC-S3-11 | 🔴 P1 | serve.mjs 已实现守卫 | 函数级伪造非回环 socket 调 list（或评审对照 isLoopback） | 非回环地址（如 10.x/192.168.x/::ffff 以外）→ 403（复用 /api/fs 既有 isLoopback 守卫）；本机直连恒回环 → 此项以评审证据 + 函数级用例为准 | 评审 + 函数级 | S3 AC3；I2 |
| TC-S3-12 | 🔴 P2 | 绑定目录含 .git 仓库 | list 返回后 read .git/config / list .git 内部 | 默认禁止进入 .git 内部（防凭证/元数据外泄）：403 提示（⚖️ 默认契约，实现期如将军改口仅改本用例预期） | files-api.test.mjs | S3 契约；R6 |
| TC-S3-13 | 🟡 P1 | 夹具含中文/Unicode/空格文件名 | list/read/download 中文文件 | 全链路正确（UTF-8 路径无 400/乱码）；列表 name 正确 | files-api.test.mjs | S3 边界 |
| TC-S3-14 | 🟡 P2 | 夹具目录含 >100 文件、含空目录 | list 大目录 + list 空目录 | 全量返回不截断（v1 无分页要求）；空目录 entries=[]；结构稳定 | files-api.test.mjs | S3 边界 |
| TC-S3-15 | 🟢 P2 | serve.mjs 启动中 | 走查 /api/files 与既有 /hub 代理、静态托管、/api/fs 并行可用 | 各端点互不影响（文件面新增不破坏选文件夹/代理/SPA）；依赖清单零新增（node:fs/path/http 内置） | L1 + 评审 | S3 AC5；I1 |

#### S4 文件后端·写面（上传 / mkdir / rename / delete + 鉴权）——自动化：files-api.test.mjs 扩展 + L1 curl

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | 已绑定 scope；当前目录 D | PUT /api/files/upload?scope=&path=D/新文件.txt（body=raw bytes，中文名） | 200；list 可见；read/download 内容与上传字节一致 | files-api.test.mjs | S4 AC1/AC4 |
| TC-S4-02 | 🟡 P0 | MAX_UPLOAD 已导出 | ①上传 MAX_UPLOAD 字节 ②上传 MAX_UPLOAD+1 字节 | ①200 落盘 ②拒绝（413/400）且不落任何部分文件（预检 Content-Length） | files-api.test.mjs | S4 AC1/AC4 |
| TC-S4-03 | 🔴 P0 | D/exist.txt 已存在且内容已知 | 上传到 D/exist.txt（不带 overwrite） | 409，error 提示已存在/需 overwrite=1；原文件内容未被改动 | files-api.test.mjs | S4 AC1；I6 |
| TC-S4-04 | 🟢 P0 | 同上 | 上传到 D/exist.txt 且带 overwrite=1 | 200 覆盖成功；新内容可读回 | files-api.test.mjs | S4 AC1；I6 |
| TC-S4-05 | 🟢 P0 | 当前目录 D | POST /api/files/mkdir {scope, path:'D/a/b/c'} | 200；list 逐层可见（支持嵌套一次建多层） | files-api.test.mjs | S4 AC1 |
| TC-S4-06 | 🔴 P0 | D/a 已存在；D/file.txt 存在 | ①mkdir path=D/a ②mkdir path=D/file.txt | ①400「已存在」②400（目录与文件同名冲突） | files-api.test.mjs | S4 AC1 异常 |
| TC-S4-07 | 🟢 P0 | D/a.txt 存在，D/b.txt 不存在 | POST /api/files/rename {scope, from:'D/a.txt', to:'D/b.txt'} | 200；a.txt 消失、b.txt 存在且内容一致 | files-api.test.mjs | S4 AC1 |
| TC-S4-08 | 🔴 P0 | D/c.txt 存在；根外有 out.txt | ①rename to 已存在 D/c.txt ②rename from/to 任一出根（../…） | ①409 ②400 拒绝（写路径与 S3 同强度规范化） | files-api.test.mjs | S4 AC3 |
| TC-S4-09 | 🔴 P0 | D/del.txt 存在 | POST /api/files/delete {scope, path:'D/del.txt'}（无 confirm / confirm:'nope'） | 400，error 提示需 confirm=yes；文件仍在 | files-api.test.mjs | S4 AC1；I6 |
| TC-S4-10 | 🟢 P0 | D/del.txt 存在 | delete {path:'D/del.txt', confirm:'yes'} | 200；list 不再可见；download → 400 不存在 | files-api.test.mjs | S4 AC1 |
| TC-S4-11 | 🔴 P0 | D/nonempty/ 含 1 个文件 | delete {path:'D/nonempty', confirm:'yes'} | 400 拒绝（非空目录拒删，提示先清空或提供递归语义前不允许）；目录及内容原样保留 | files-api.test.mjs | S4 AC1；I6 |
| TC-S4-12 | 🟢 P0 | D/empty/ 空目录 | delete {path:'D/empty', confirm:'yes'} | 200；list 不可见 | files-api.test.mjs | S4 AC1 |
| TC-S4-13 | 🔴 P0 | 以 --token / DSH_WORKBENCH_TOKEN=tk 起 serve.mjs | ①无 token 写（upload）②错 token 写 ③对 token 写 ④无 token 读（list/read） | ①②401 ③200 ④读仍放行 200（回环内）；未配置 token 时行为与现状一致（写放行但保留回环边界） | files-api.test.mjs + L1 | S4 AC2；I2 |
| TC-S4-14 | 🔴 P0 | 已绑定 | 对 upload/mkdir/rename/delete 的 path/from/to 逐一注入 TC-S3-09 逃逸样本（../、绝对越根、NUL、盘符、根外 symlink 目标） | 每写操作均 400/403 拒绝、不产生根外任何副作用 | files-api.test.mjs | S4 AC3 |
| TC-S4-15 | 🟡 P1 | serve.mjs 运行中 | 代码审查上传路径：是否按 Content-Length 预检 + 流式落盘（非整读内存）；再以 MAX_UPLOAD+1 实测超限快速拒绝 | 审查结论 + 实测：超限请求在读取上限后即断（响应快、无整读内存迹象） | 评审 + L1 | S4 AC4 |
| TC-S4-16 | 🟡 P1 | 两个并发请求 | 同路径并发 upload（均不带 overwrite） | 至多一个 200，其余 409；文件字节 = 二写之一完整内容，无半写残留/损坏 | files-api.test.mjs | S4 健壮性 |
| TC-S4-17 | 🟢 P2 | S4 实现完成 | git diff 核对 | package.json/依赖零新增；写面只用 node:fs/path/http 内置 | 评审 | S4 AC5；I1 |

#### S5 文件中心前端（FilesView + 接线）——自动化：pnpm build（L0）+ L2 浏览器清单 + 评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | workbench 依赖已装 | pnpm build | 0 类型错误；若 lazy 则含 files 独立 chunk | L0 build | S5 AC1 |
| TC-S5-02 | 🟢 P0 | 选中已绑定空间 software | 侧栏「文件中心」→ 进入 | 显示该空间 local_dir 根目录内容（列表含目录/文件/大小/mtime/.git 标记）；点目录逐层进入；可返回上级/根 | L2 | S5 AC2 |
| TC-S5-03 | 🟢 P0 | 空间已绑定；含文本与二进制 | 点文本文件 → 预览；点二进制 → 预览区 | 文本预览显示内容 + 截断/行数提示（超长时）；二进制显示「不可预览」提示 | L2 | S5 AC2/AC4 |
| TC-S5-04 | 🟢 P0 | 位于某目录 | 上传文件到当前目录 | 上传后列表立即可见（本地刷新或重拉 list，无需整页刷新/重挂） | L2 | S5 AC2/AC5 |
| TC-S5-05 | 🟢 P0 | 目录含已知文件 | 点下载 | 浏览器拉回文件且字节与源一致 | L2 | S5 AC2 |
| TC-S5-06 | 🟢 P0 | 主界面 | QuickTools 点「文件浏览」卡 | 进入文件中心面板（接线成功，非 toast 占位） | L2 | S5 AC2；P1-5 |
| TC-S5-07 | 🟡 P0 | 选中未绑定空间 | 打开文件中心 | 显示引导：到空间设置绑定本地文件夹（含跳转入口或说明），不白屏不报 500 | L2 | S5 AC4 |
| TC-S5-08 | 🔴 P1 | 夹具含文件名/内容带 <script>alert(1)</script>、<img onerror=...> 的文件 | 列表 + 预览该文件 | 文件名与内容均按纯文本渲染、脚本不执行；评审 + grep 断言无 dangerouslySetInnerHTML 直插服务端文件内容 | L2 + 评审/grep | S5 AC3；I5 |
| TC-S5-09 | 🔴 P1 | 后端可用 | ①删除文件（弹确认，先取消再确认）②对将覆盖文件上传 ③停中枢/代理后操作 | ①取消无请求、确认后成功且列表刷新 ②出现 409 覆盖确认语义提示 ③错误以 toast/行内提示呈现，不崩溃 | L2 | S5 AC4/AC5 |
| TC-S5-10 | 🟡 P2 | 大文本/超限文件在目录中 | 预览大文件；观察截断 | 截断提示明确（含行数/大小信息）；超大文件 read 不卡死 UI（loading 态可见） | L2 | S5 AC4 |

### Phase 3 浏览器助手（S6 后端 · S7 前端）

#### S6 浏览器后端（SSRF 防护 fetch 代理 + 正文抽取）——自动化：workbench/scripts/web.test.mjs + L1（本地 mock）+ 评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 P0 | 本地 mock HTTP 服务返回含 title/h1/p/多链接的 HTML | POST /api/web/fetch {url: mock} | 200 {ok:true, finalUrl, status:200, contentType:'text/html', title, text 含正文关键句, excerpt, links 含全部外链} | web.test.mjs | S6 AC1/AC4 |
| TC-S6-02 | 🟢 P0 | mock 返回 UTF-8 中文 HTML | 同上 | title/正文中文正确解码（无乱码） | web.test.mjs | S6 AC1 |
| TC-S6-03 | 🔴 P0 | mock 返回 SPA 空壳（<div id=app></div> 无正文）或纯 JS 渲染页 | fetch | 返回可理解提示（error 含无法抽取/JS 渲染页语义），不伪造正文（text 为空且 error 说明） | web.test.mjs | S6 AC1；R3 |
| TC-S6-04 | 🔴 P0 | serve.mjs 运行 | fetch url=file:///C:/x、ftp://h/a、javascript:...、data:text/html,...、gopher://... | 全部拒绝 ssrf_blocked/unsupported（协议白名单仅 http/https） | web.test.mjs | S6 AC2；I7 |
| TC-S6-05 | 🔴 P0 | 同上 | fetch url 分别为 127.0.0.1、127.1、localhost、10.0.0.1、172.16.0.1、172.31.255.1、192.168.1.1、169.254.1.1、0.0.0.0、[::1]、fc00::1、十进制混淆 2130706433、十六进制 0x7f000001（指向 127.0.0.1） | 全部 error=ssrf_blocked，且无任何到目标的外呼证据（mock 未收到请求） | web.test.mjs | S6 AC2；I7 |
| TC-S6-06 | 🔴 P0 | mock A（公网，跳转 mock B 私网 127.0.0.1） | fetch url=A（302→B） | 首跳后重定向链任一跳到私网 → error=ssrf_blocked（逐跳校验）；同样覆盖 A→公网→私网多跳链与 302 到 file:// | web.test.mjs | S6 AC2；I7 |
| TC-S6-07 | 🟡 P1 | 实现含 DNS 解析层校验（域名→私网 IP） | fetch 域名解析到 127.0.0.1（hosts/mock DNS）→ blocked；解析失败域名 → 可理解错误 | 解析后指向私网仍拒绝 ssrf_blocked；解析失败给明确错误而非裸异常；若实现无 DNS 层 → 该条按「评审确认 + 记录」判过（不冒充） | web.test.mjs | S6 AC2 补充 |
| TC-S6-08 | 🟡 P0 | maxBytes 可注入小值（如 1 KiB） | ①mock 返回 maxBytes-1 字节 ②maxBytes+1 字节 | ①ok ②error=too_large（或截断并标注 truncated）；响应体受控 | web.test.mjs | S6 AC3 |
| TC-S6-09 | 🟡 P0 | timeoutMs 可注入小值 | ①mock 慢于 timeout ②快于 timeout | ①error=timeout ②ok；超时后请求被取消（mock 侧连接关闭） | web.test.mjs | S6 AC3 |
| TC-S6-10 | 🔴 P0 | mock 返回任意 HTML（含 script 标签） | fetch 成功 | 响应 JSON 仅含白名单结构化字段（ok/finalUrl/status/contentType/title/text/excerpt/links/error），无原始 HTML 透传字段；评审断言前端拿不到可直插 DOM 的完整 HTML | web.test.mjs + 评审 | S6 AC4；R7 |
| TC-S6-11 | 🟡 P1 | mock 返回 application/pdf、application/zip、image/png | fetch | unsupported 或明确降级提示（contentType 非文本/HTML 处理路径正确） | web.test.mjs | S6 AC1 边界 |
| TC-S6-12 | 🟡 P1 | mock 返回 404/500 页 | fetch | 可理解透传：error=http_404/http_500（或 text 说明），不 500 | web.test.mjs | S6 契约 |
| TC-S6-13 | 🟢 P1 | 执行任一 fetch | 查看服务端日志 | 每次 fetch 留痕：url、finalUrl、status、耗时、by（默认 general）（R2 审计要求） | L1 + 评审 | S6 AC5 |
| TC-S6-14 | 🟡 P2 | 并发发起 10 个慢请求 | 观察 | 有并发上限或排队，进程不崩、连接不泄漏；超限请求明确失败 | web.test.mjs | S6 健壮性 |
| TC-S6-15 | 🔴 P0 | — | ①url='' ②url 非字符串 ③url='not a url' ④url='http://' | 全部 400（参数校验），非 500 | web.test.mjs | S6 契约 |
| TC-S6-16 | 🟢 P2 | S6 实现完成 | git diff 核对；抽取先交付零依赖文本版 | package.json 零新增依赖；readability/cheerio/Turndown 缺失不阻塞（列为 X-3 增强证据说明） | 评审 | S6 AC6；I1 |

#### S7 浏览器助手前端（BrowserView + 接线）——自动化：pnpm build（L0）+ L2 浏览器清单 + 评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 P0 | workbench 依赖已装 | pnpm build | 0 类型错误；若 lazy 则含 browser 独立 chunk | L0 build | S7 AC1 |
| TC-S7-02 | 🟢 P0 | 本地 mock 网页服务运行；:5173 已更新产物 | 侧栏「浏览器助手」→ 地址栏输入 mock URL → 抓取 | 显示标题 + 正文/摘要（文本/markdown 视图），无整页刷新 | L2 | S7 AC2 |
| TC-S7-03 | 🟢 P0 | 同上 | 观察请求态；成功后再次抓取 | loading 态可见（请求中）→ 成功结果；可重复抓取/重试按钮可用 | L2 | S7 AC5 |
| TC-S7-04 | 🔴 P0 | 同上 | 输入 http://127.0.0.1:8787/api/config 抓取 | 明确展示「已拦截：禁止访问内网地址」（ssrf_blocked 映射文案），非超时/网络错误混淆 | L2 | S7 AC3 |
| TC-S7-05 | 🔴 P1 | mock 可控 | ①造 timeout（慢 mock）②造 too_large ③断开 serve.mjs 上游 | 三种错误显示不同文案且可重试；业务错误（400 参数）与网络错误区分 | L2 | S7 AC3/AC5 |
| TC-S7-06 | 🟢 P0 | 主界面 | QuickTools 两个入口分别点击 | 「打开内部看板」→ 新窗口开经典看板（openKanban 保留）；「浏览网页」→ 进入浏览器面板并聚焦地址栏（RESEARCH §11.1.3） | L2 | S7 AC2；P1-5 |
| TC-S7-07 | 🔴 P1 | mock 页面含 <script>alert(1)</script>、<img onerror=...> 正文 | 抓取并查看结果 | 内容按文本/markdown 渲染、无脚本执行；评审 + grep：默认渲染路径无 raw HTML 直插 DOM（dangerouslySetInnerHTML 仅允许出现在明确净化后的可选路径，X-4 未勾选时不得存在） | L2 + 评审/grep | S7 AC4；I5 |
| TC-S7-08 | 🟡 P1 | 打开面板 | ①输入无 scheme 的 example.com ②输入 'ht!tp://坏 url' ③留空点抓取 | ①自动补 https:// 或明确提示 ②不发起请求并提示 URL 非法 ③提示输入 URL | L2 | S7 边界 |
| TC-S7-09 | 🟡 P1 | 面板已开 | 停掉 serve.mjs 再抓取 → 恢复后重试 | 不可达给明确错误提示（非白屏）+ 可重试；恢复后成功 | L2 | S7 AC5 |
| TC-S7-10 | 🟡 P2 | — | 多次抓取不同 URL | 地址栏最近历史可复用（localStorage 可选实现；不做强制判据，P2 观察项） | L2 | S7 AC5 附 |

### Phase 4 集成收口（S8）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 P0 | S1~S7 已合并 | 逐条真跑：pnpm build（workbench）；node team-hub/skills.test.mjs、node team-hub/chat.test.mjs；node workbench/scripts/files-api.test.mjs、node workbench/scripts/web.test.mjs | 全部绿，evidence 给出各命令输出要点（直跑等效执行方式见 §2 注） | L3 | S8 AC1 |
| TC-S8-02 | 🟢 P0 | S8 文档改动完成 | 核对根 README（§3 功能指南 / §4 接口表 / 模块矩阵）与 workbench/README | 三中心标注「可用」；接口表含 /api/chat/*、/api/files/*、/api/web/fetch 行；calendar/notify 标注「占位（P1 后续）」；文档命令可复现（按文档执行可达） | 评审 + L3 | S8 AC2 |
| TC-S8-03 | 🟢 P0 | :5173 全量产物 | 侧栏 9 模块逐一点击 | home/agents/skills → 各自面板原行为不变；tasks → 打开经典看板（openKanban）；chat/files/browser → 各自面板；calendar/notify → 占位 toast（有提示，非静默无响应） | L2 | S8 AC3；G-6 |
| TC-S8-04 | 🔴 P0 | 三中心就位 | 代码走查 + grep：chat 写仅 team-hub /api/chat（统一 handleWrite），files/web 写仅 serve.mjs /api/files、/api/web；README §5「只写一个账本」警示未回退 | 无第三写源（无绕过 API 直写 DB 的 UI/脚本路径）；双写源纪律复核通过（evidence 说明） | 评审 | S8 AC4；R8 |
| TC-S8-05 | 🟡 P1 | 两个标签页打开指挥台（一页含对话中心，一页含实时动态） | devtools Network 数 hub 事件源连接 | 事件源连接数符合「≤ 改造前 +1」（chat 并入单一 /api/events 按 kind 过滤） | L2 devtools | S8 AC3；I8 |
| TC-S8-06 | 🟢 P1 | 全量产物 | 回归走查：右侧实时动态/顶部 KPI/3D 场景/任务详情弹窗/发布目标 | 与 S1~S7 前行为一致无回归 | L2/L3 | S8 AC3 |
| TC-S8-07 | 🟡 P2 | S8 代码完成 | grep calendar/notify 接线处注释/文档 | 两模块占位语义在代码注释与文档中明确标明（G-6 默认） | 评审 | S8 AC2；G-6 |
| TC-S8-08 | 🟢 P1 | 三入口存在 | 三入口维度 × 三中心交叉走查：Sidebar 模块、QuickTools 卡、App active 渲染 | 入口一致互不打架；从任一入口进入同一中心状态同步（active 高亮正确） | L2 | S8 AC3；H1 |

### Phase 5 存量回归（R-1，tester/devops 阶段）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-R1-01 | 🟢 P0 | 合并后主分支 | whiteboard 全量：apps/server/test + packages/shared/test（直跑各 *.test.mjs，或宿主环境可 spawn 时 node --test） | 全绿；输出要点入 evidence | L3 | R-1 AC1 |
| TC-R1-02 | 🟢 P1 | 同上 | 按 whiteboard/docs/DEPLOY.md 起服冒烟 | 服务可访问（healthz/页面可达） | L1 | R-1 AC1 |
| TC-R1-03 | 🟢 P0 | 同上 | node tests/contract/contracts.test.mjs | 56 用例基线全绿 | L3 | R-1 AC2 |
| TC-R1-04 | 🟡 P0 | 需 DSH Desktop/宿主环境 | board-plugin/plugins 按各自 README/build 说明 typecheck/build + 注入宿主冒烟 | 宿主可达 → 全绿；不可达 → evidence 记录「环境受限 + 复现步骤」，不静默判过也不冒充通过 | L3 | R-1 AC3；R10 |
| TC-R1-05 | 🟢 P0 | S1~S8 合并完成 | 复跑 TC-R1-01/02/03 | S1~S8 改动不破坏存量基线；结果与 S8 一并记录 | L3 | R-1 AC4 |

## 5. 关键业务规则 正反向覆盖矩阵

| 业务规则 | 正向（应成功/应放行）用例 | 反向（应拒绝/应隔离）用例 |
| --- | --- | --- |
| scope 隔离（会话/消息/文件根随空间） | TC-S1-01/02、TC-S1-06、TC-S2-02/04、TC-S3-01 | TC-S1-03、TC-S2-05、TC-S3-03 |
| 写操作必带 by（chat） | TC-S1-06（by 有效即成功） | TC-S1-05、TC-S1-07（author 冒名绑定） |
| kind 枚举合法（space/direct/task；text/markdown/system） | TC-S1-01（合法 kind） | TC-S1-04、TC-S2-11（未知 kind 兜底） |
| 消息分页不重不漏/升序 | TC-S1-08 | TC-S1-09（非法 limit/超界游标） |
| 消息正文长度上限 | TC-S1-12 ① | TC-S1-11、TC-S1-12 ② |
| 审计与 SSE 事件 | TC-S1-13/14 | TC-S1-05（失败写不留痕断言）、TC-S1-15（断连不崩） |
| 文件写需 token | TC-S4-13 ③（对 token） | TC-S4-13 ①②（无/错 token 401） |
| 路径根内规范化（读+写） | TC-S3-08/10 ①（根内可及） | TC-S3-09、TC-S3-10 ②、TC-S4-08 ②、TC-S4-14 |
| 覆盖需 overwrite=1 | TC-S4-04 | TC-S4-03 |
| 删除需 confirm=yes | TC-S4-10/12 | TC-S4-09、TC-S4-11 |
| SSRF 协议白名单 | TC-S6-01/02（http 放行） | TC-S6-04 |
| SSRF 私网/回环阻断（含混淆） | — | TC-S6-05 |
| SSRF 重定向逐跳校验 | TC-S6-06 首跳合法（公网 mock） | TC-S6-06（链中任一跳私网） |
| 抓取内容不直插 DOM | TC-S7-02 / TC-S2-02（正常文本渲染） | TC-S2-09、TC-S5-08、TC-S7-07 |
| 仅回环 + .git 保护 | TC-S3-11 回环放行（隐含） | TC-S3-11（非回环 403）、TC-S3-12（.git 内部） |
| SSE 单源按 kind 过滤 | TC-S2-08 ①（动态流不受影响） | TC-S1-14 / TC-S2-08 连接数不增 |
| 零新增依赖 | TC-S1-18 / TC-S3-15 / TC-S4-17 / TC-S6-16（清单核对） | — |
| 写源纪律（不引入第三写源） | TC-S8-04（走查通过） | TC-S8-04（grep 无越权直写） |
| 未绑定空间/空数据不静默回退 | TC-S5-07（引导提示出现即正确） | TC-S3-03（绝不落到任意目录） |

## 6. 验收标准逐条用例化：AC → 用例追溯矩阵（PASS 判据 = 该 AC 全部映射用例通过）

| 子任务 AC | 覆盖用例 | 通过判据 |
| --- | --- | --- |
| S1 AC1 chat.test 覆盖会话/分页/隔离/author/长度 | TC-S1-01..12 | chat.test.mjs 全绿（直跑等效） |
| S1 AC2 回归 + 迁移冒烟 | TC-S1-16 | 旧库建表无异常；skills.test 12/12 绿 |
| S1 AC3 curl 冒烟（会话→消息→last_message_at→审计） | TC-S1-01/06/13 | L1 curl 脚本断言全过 |
| S1 AC4 事件冒烟 ≤5s | TC-S1-14/15 | SSE 脚本断言收到 chat 事件 |
| S1 AC5 写纪律（by/scope/错误映射） | TC-S1-03/05/07/17 | 断言 400/401 与 ok/task 同构体 |
| S1 AC6 零新增依赖 | TC-S1-18 | git diff 核对无新增 |
| S2 AC1 build | TC-S2-01 | pnpm build 绿 |
| S2 AC2 scope 行为 | TC-S2-05/06 | L2 走查符合 |
| S2 AC3 主路径 | TC-S2-02/03/04 | L2 逐条可见结果 |
| S2 AC4 单事件源 kind 过滤 | TC-S2-08 | devtools 实测连接数 |
| S2 AC5 渲染安全 | TC-S2-09 | 无脚本执行 + grep 无 dangerouslySetInnerHTML |
| S2 AC6 失败路径 | TC-S2-07/10 | toast + 草稿保留 |
| S3 AC1 list/read/download 契约 | TC-S3-01/02/05/06/08 | files-api.test 全绿 |
| S3 AC2 越界防护 | TC-S3-09/10 | 逃逸矩阵全拒 |
| S3 AC3 仅回环 | TC-S3-11 | 函数级/评审证据 |
| S3 AC4 二进制与超大 read | TC-S3-06/07 | 响应受控 |
| S3 AC5 零新增依赖 | TC-S3-15 | 核对 |
| S4 AC1 写契约 | TC-S4-01..12 | files-api.test 扩展全绿 |
| S4 AC2 鉴权 | TC-S4-13 | 401/200 矩阵 |
| S4 AC3 写路径防护 | TC-S4-08②/14 | 全拒无副作用 |
| S4 AC4 大文件流式/限长 | TC-S4-02/15 | 预检拒 + 无整读 |
| S4 AC5 零新增依赖 | TC-S4-17 | 核对 |
| S5 AC1 build | TC-S5-01 | pnpm build 绿 |
| S5 AC2 主路径 | TC-S5-02..06 | L2 走查 |
| S5 AC3 预览安全 | TC-S5-08 | 无脚本 + grep |
| S5 AC4 错误/空态 | TC-S5-07/09/10 | L2 可见引导与提示 |
| S5 AC5 目录变化一致性 | TC-S5-04/09 | 列表刷新 |
| S6 AC1 抽取 | TC-S6-01/02/03 | web.test 全绿 |
| S6 AC2 SSRF 门禁 | TC-S6-04/05/06/07 | 矩阵全 blocked |
| S6 AC3 限长/超时 | TC-S6-08/09 | 三值/注入断言 |
| S6 AC4 内容安全 | TC-S6-10/11 | 响应形状白名单 |
| S6 AC5 审计留痕 | TC-S6-13 | 日志断言 |
| S6 AC6 零新增依赖 | TC-S6-16 | 核对 |
| S7 AC1 build | TC-S7-01 | pnpm build 绿 |
| S7 AC2 主路径 + QuickTools 入口 | TC-S7-02/06 | L2 |
| S7 AC3 SSRF/错误呈现 | TC-S7-04/05 | 文案映射 |
| S7 AC4 渲染安全 | TC-S7-07 | 无执行 + grep |
| S7 AC5 状态机 | TC-S7-03/09 | loading→结果/失败可重试 |
| S8 AC1 全量回归命令 | TC-S8-01 | 命令全绿留输出要点 |
| S8 AC2 文档一致 | TC-S8-02/07 | 核对矩阵 |
| S8 AC3 无回归 | TC-S8-03/05/06/08 | L2 走查 |
| S8 AC4 写源纪律 | TC-S8-04 | 走查 + evidence |
| R-1 AC1 whiteboard | TC-R1-01/02 | 全绿 + 冒烟 |
| R-1 AC2 contracts 基线 | TC-R1-03 | 56/56 |
| R-1 AC3 宿主联调 | TC-R1-04 | 通过或「环境受限 + 复现步骤」 |
| R-1 AC4 存量不破坏 | TC-R1-05 | 复跑全绿 |
| 官方验收①主路径+边界+异常+前置/步骤/期望 | 全部用例 | 每表含前置/步骤/期望三列 + 类/优标注 |
| 官方验收②验收标准用例化（PASS/FAIL 判据） | 全部用例 | 每期望列含可断言判据 |
| 官方验收③关键规则正反向 | §5 矩阵 | 每规则双向都有用例 |

## 7. 浏览器手工验收清单模板（L2，tester 执行时逐条勾选并记录可见结果）

### 7.1 对话中心（S2，配合 TC-S2-02..07）
- [ ] 已选具体空间；侧栏「对话中心」→ 会话列表出现（空态可建）
- [ ] 新建会话（标题）→ 输入消息 → 发送 → 气泡即时出现（无整页刷新）
- [ ] 第二标签页同空间同会话 → ≤15s 内自动出现新消息
- [ ] 刷新页面 → 历史消息仍在
- [ ] 切到另一空间 → 会话/消息随之切换且不含前一空间数据
- [ ] 「全部空间」下打开 → 显示先选空间的引导
- [ ] 停中枢后发送 → toast 错误 + 草稿保留；恢复后重发成功
- [ ] 发送含 script/img onerror 文本 → 纯文本显示、无弹窗
- [ ] devtools：hub 事件源连接数 = 改造前 + ≤1，「实时动态」流正常

### 7.2 文件中心（S5，配合 TC-S5-02..10）
- [ ] 打开文件中心 → 显示当前空间绑定根目录（目录/文件/大小/mtime/.git 标记）
- [ ] 逐层进入目录、返回上级/根
- [ ] 点文本 → 预览（含截断/行数提示）；点二进制 → 「不可预览」
- [ ] 当前目录上传 → 列表立即可见
- [ ] 下载 → 拉回字节与源一致
- [ ] QuickTools「文件浏览」卡 → 进入文件中心
- [ ] 未绑定空间 → 引导去空间设置绑定（不白屏）
- [ ] 删除文件 → 二次确认 → 确认后列表刷新
- [ ] 预览内容含 HTML 特义文本 → 纯文本显示、无执行

### 7.3 浏览器助手（S7，配合 TC-S7-02..09）
- [ ] 打开浏览器助手 → 地址栏输入本地 mock URL → 显示标题 + 正文/摘要
- [ ] 请求中有 loading 态；成功后可重试
- [ ] 输入 http://127.0.0.1:8787/api/config → 「已拦截：禁止访问内网地址」
- [ ] 慢 mock / 超限 / 上游断 → 三种错误文案可区分且可重试
- [ ] QuickTools「打开内部看板」→ 新窗口看板；「浏览网页」→ 面板 + 地址栏聚焦
- [ ] 抓回含 script 的内容 → 文本渲染无执行
- [ ] 无 scheme URL → 自动补 https 或提示；非法 URL 不发起请求

### 7.4 集成收口（S8，配合 TC-S8-03/05/06/08）
- [ ] 侧栏 9 模块逐一点击，落点符合预期（3 中心面板 / tasks→看板 / 2 占位 toast）
- [ ] 三入口（Sidebar / QuickTools / App active）进入同一中心状态一致
- [ ] 右侧实时动态 / KPI / 3D / 任务集 / 任务详情无回归
- [ ] 双标签页 devtools 事件源连接数检查

## 8. 测试夹具与数据约定（供 coder 落测试 / tester 执行）

### 8.1 本地 mock HTTP 服务器（禁网环境抓取目标，web.test.mjs / L1 使用）
- 起于 127.0.0.1 临时端口；端点：/（HTML：title「测试标题」+ h1 + p 关键句 + 2 个 a 链接）、/zh（UTF-8 中文）、/spa（<div id="app"></div> 空壳）、/big（可配字节数）、/slow（可配延迟）、/redirect?to=<url>（302）、/404、/file.pdf。
- SSRF 用例用「目标即使可达也必须拒绝」断言：断言 mock 侧未收到任何请求（blocked 在发往目标前）。

### 8.2 会话/消息 payload 样例（S1 契约固定形状）
- 会话：POST /api/chat/conversations，body {scope, title, kind ∈ space|direct|task, participants?} + by。
- 消息：POST /api/chat/messages，body {conv, scope, kind ∈ text|markdown|system, body, clientTs?} + by。
- 响应：{ok:true, task:{...}}（沿用 handleWrite 同构体）；列表响应含数组与分页字段（limit/before 语义以 S1 实现导出为准，分页正确性断言见 TC-S1-08/09）。

### 8.3 路径逃逸样本矩阵（S3/S4 共用，逐项必须 400/403）
../x、..\\x、a/../../x、URL 编码 ..%2Fx、双编码 ..%252Fx、绝对路径 /abs/out、Windows 盘符 C:/Windows/win.ini（含小写盘符 c:\\...）、含 NUL（%00）、超长路径、根外 symlink 目标。判定：normalize 后必须仍在目录根内；任何等价逃逸均拒绝。

### 8.4 SSRF 目标清单（TC-S6-05）
127.0.0.1、127.1、localhost、[::1]、0.0.0.0、10.0.0.1、172.16.0.1、172.31.255.1、192.168.1.1、169.254.1.1、fc00::1、fd00::1、十进制 2130706433、十六进制 0x7f000001、带端口/用户信息变体。

### 8.5 目录夹具树（files-api.test.mjs 用，mkdtemp 生成）
    root/
      docs/README.md          （< 256KiB 文本）
      big.log                 （> 阈值，可配生成）
      bin/app.exe             （二进制）
      pic.png
      中文 文件.txt
      .git/                   （空目录模拟仓库标记；.git/config 存在用于 TC-S3-12）
      link-in -> docs/README.md
      link-out -> <tmp 根外文件>
      nonempty/keep.txt
      empty/
      outside-escape.txt      （根外，仅用于越界断言）

### 8.6 token 与端口约定
- team-hub：TEAM_HUB_DB=临时库、TEAM_HUB_PORT=随机端口、TEAM_HUB_TOKEN=tk（TC-S1-17）。
- serve.mjs：--port 临时端口 + --token tk 或 env DSH_WORKBENCH_TOKEN（TC-S4-13）；DSH_HUB_UPSTREAM 指向测试 team-hub（/hub 冒烟用）。

## 9. 附录

### 附录 A：取代声明
docs/TEST_CASES.md 为共享流水线产物位，历次流水线依次重写（T-012 白板用例 → 本次 T-039）。旧版（T-012）经 git 历史可回溯；同目录 REQUIREMENTS.md 为 T-014 旧产物、RESEARCH.md 为 T-044（本次输入，保留）、TASK_BREAKDOWN.md 为 T-038（本次输入，保留），均不属本次改动范围。

### 附录 B：测试代码落点模板（coder 落盘时照此骨架；断言细则以 §4 各用例的「期望结果 / 通过判据」列为准，每个 P0 用例必须有一条对应 it()）

#### B.1 team-hub/chat.test.mjs（S1 交付，仿 skills.test.mjs：临时库 + import server.mjs 不占端口）
    // 运行：node team-hub/chat.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test）
    import { describe, it, before, after } from 'node:test'
    import assert from 'node:assert/strict'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'

    const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-chat-'))
    let dbFile, mod
    before(async () => {
      dbFile = join(tmpRoot, 'team.db')
      process.env.TEAM_HUB_DB = dbFile
      mod = await import('./server.mjs')  // 需 S1 导出 chat DAO/工厂（createConversation/listConversations/postMessage/listMessages）
    })
    after(() => { try { mod.db?.close() } catch {} rmSync(tmpRoot, { recursive: true, force: true }) })

    describe('chat 契约（对齐 TC-S1-01..18）', () => {
      it('TC-S1-01 创建会话并列表可见（scope 过滤）', () => { /* 断言见用例 */ })
      it('TC-S1-03 scope 隔离：跨 scope 查不到 / 写不串', () => { /* ... */ })
      it('TC-S1-07 author 强制绑定 by（防冒名）', () => { /* ... */ })
      it('TC-S1-08 分页 10/10/5 无重漏、升序', () => { /* ... */ })
      it('TC-S1-09 分页边界（空会话 / 超界 / 非法 limit）', () => { /* ... */ })
      it('TC-S1-12 正文长度 MAX_BODY / MAX_BODY+1', () => { /* ... */ })
      it('TC-S1-16 旧库无 chat 表自动建表 + skills 数据无损', () => { /* ... */ })
    })

#### B.2 workbench/scripts/files-api.test.mjs（S3+S4 交付；serve.mjs 需导出可测函数或在 import 时不 listen——S3 需加 isMain 守卫或导出 handleFilesApi）
    // 运行：node workbench/scripts/files-api.test.mjs
    // 前置：S3 把守卫/处理器抽成可 import 函数（如 resolveRoot(scope, db) / assertInsideRoot）
    describe('files-api 契约（对齐 TC-S3-01..15 / TC-S4-01..17）', () => {
      it('TC-S3-01/02 list 形状 + 根语义 + 空目录', () => { /* ... */ })
      it('TC-S3-03 未绑定 scope → 引导错误，绝不落到任意目录', () => { /* ... */ })
      it('TC-S3-05/06/07 read 文本 / 截断 / 二进制拒绝', () => { /* ... */ })
      it('TC-S3-08 download 字节一致', () => { /* ... */ })
      it('TC-S3-09/10 + TC-S4-14 路径逃逸矩阵全拒', () => { /* 逐样本循环断言 */ })
      it('TC-S4-01/02 upload 成功 / 上限（MAX / MAX+1）', () => { /* ... */ })
      it('TC-S4-03/04 overwrite 两态', () => { /* ... */ })
      it('TC-S4-09..12 delete confirm 语义', () => { /* ... */ })
      it('TC-S4-13 token 矩阵', () => { /* ... */ })
    })

#### B.3 workbench/scripts/web.test.mjs（S6 交付；SSRF 守卫 / 抽取抽成可 import 纯函数）
    // 运行：node workbench/scripts/web.test.mjs
    describe('web fetch 契约（对齐 TC-S6-01..16）', () => {
      it('TC-S6-01/02 抽取（HTML / 中文）', () => { /* ... */ })
      it('TC-S6-03 SPA 空壳 → 无法抽取提示', () => { /* ... */ })
      it('TC-S6-04 协议白名单拒绝', () => { /* ... */ })
      it('TC-S6-05 私网 / 回环段矩阵（含混淆）→ ssrf_blocked', () => { /* 逐地址 */ })
      it('TC-S6-06 重定向链逐跳校验', () => { /* ... */ })
      it('TC-S6-08/09 maxBytes / timeoutMs 注入值三态', () => { /* ... */ })
      it('TC-S6-10 响应形状白名单（无 HTML 透传）', () => { /* ... */ })
    })

> 前端（S2/S5/S7）无测试 runner，验收 = TC 对应的 pnpm build + §7 浏览器清单（TASK_BREAKDOWN R8 约定）。

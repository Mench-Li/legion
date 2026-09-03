# T-038 任务拆解：交付剩余 Legion 军团指挥团任务（对话中心 · 文件中心 · 浏览器助手 · 导航接线）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-038（分支 w/T-038 独立 worktree）
> 上游：T-036 需求澄清（evidence 经 GET http://127.0.0.1:8787/api/task?id=T-036 只读读取，P0~P2 待办清单）→ T-037/T-044 方案搜索（docs/RESEARCH.md：8 决策域 A~H + 决策闸门 G-1..G-7 + v1 实施拓扑）
> 下游：test-designer（docs/TEST_CASES.md）→ coder（按本清单认领实现）→ reviewer → tester → devops
> 依据：LEGION.md 纪律、T-038 验收标准与边界、RESEARCH.md §11 v1 拓扑 / §11.2 闸门默认值、T-036 需求盘点 P0~P2 清单。
>
> 本文档**取代**旧流水线产物 docs/TASK_BREAKDOWN.md（T-011 白板拆解；旧版经 git 历史 35d2978 可回溯，见附录 B）。

## 0. 结论速览

- 拆解产物：**1 个 Phase-0 决策闸门（G-1..G-7，默认值 = RESEARCH 一等选型）** + **8 个默认实施子任务（S1~S8）** + **1 个环境敏感回归任务（R-1，建议 tester/devops 阶段执行）** + **5 项候选增强（X-1~X-5，默认不做，将军勾选才追加）**。
- 文件域冲突规避（关键设计约束）：本仓库推进采用「每士兵独立 worktree + 将军逐任务 promote 合并」，**同时并行改同一文件的子任务会产生合并冲突**。因此 DAG 按**文件域不相交**分链并行、同文件域内串行（详见 §3 波次表）。前端文件域（workbench/src/*）任何时刻只允许 1 个并行任务，这是 S2→S5→S7 人为串行的唯一理由。
- 派工波次（每波 1 轮，共 5 波 + 回归波）：
  - 波 1：S1（team-hub 对话后端）∥ S3（serve.mjs 文件只读面）——两个文件域不相交，可并行。
  - 波 2：S2（对话前端）∥ S4（serve.mjs 文件写面）。
  - 波 3：S5（文件前端）∥ S6（serve.mjs 浏览器后端）。
  - 波 4：S7（浏览器前端）。
  - 波 5：S8（集成收口与文档）；R-1（存量回归，tester/devops）可与 S8 并行。
- 硬性纪律（任何子任务不得违反）：**v1 全部零新增运行时依赖**（node:sqlite/node:http/node:fs/EventSource/自研 React 均已在产线）；外部库必须先本地盘点、缺失即 blocker、不联网下载（LEGION.md 禁网纪律）；浏览器抓取内容与用户消息、文件内容**不得以未净化 HTML 直插 DOM**；chat 写一律走 team-hub 统一写纪律（by 必填 + audit + SSE 广播）；serve.mjs 新增端点沿用「仅回环 + 写需 token」边界。

## 1. 拆解原则与范围

- 原子可验收：每个子任务有独立「验收点（AC）」+「验证命令/方式」+「完成口径（DoD = 什么算完成）」，不依赖「整体做完才算数」；下游 coder 拿到即可开工、test-designer 拿到即可转用例。
- 依赖排序：按 数据/API（后端先）→ 视图/接线（前端后）→ 集成收口 → 回归 排序；后端子任务做纵向切片（一个中心一个后端任务 = 表 + DAO + API + 测试一起交付，保证每个任务有可跑测试）。
- 每个子任务标注：实施角色（coder）、需求追溯（T-036 待办编号 + RESEARCH 决策域/闸门）、工作量估计（S/M/L + 轮数）、文件域与并行约束、测试锚点（供 test-designer 直转用例）。
- 范围默认面 = RESEARCH §11.1 v1 拓扑 4 项（对话中心 / 文件中心 / 浏览器助手 / 导航接线三模块）；calendar/notify 维持占位（G-6 默认）。
- 不在默认面、需将军另行裁决/立项的项见附录 A（P1-6 双账本收敛、P2-8 旧文档归档、宿主环境联调项）；它们已在 T-036 盘点登记，本拆解不拆成悬空任务，但显式标注归属与触发条件，避免遗漏。

## 2. 决策闸门（Phase 0）与裁决影响映射

### 2.1 闸门清单（G-0，无代码，先于一切实施子任务）

本拆解已按「RESEARCH 建议默认值」展开；将军未否决即按默认开工。裁决翻转只影响映射列出的子任务，不推翻整体拓扑（同 T-011 闸门先例）。

| 闸门项 | 工作假设（默认，= RESEARCH 一等） | 对立主张（= RESEARCH 备选/排除） | 裁决翻转影响子任务 |
| --- | --- | --- | --- |
| G-1 对话数据放哪 | team-hub v2 单库扩表扩 API（A1） | A2 独立消息服务；A3/A4 整机聊天/云 SaaS | S1/S2 整体重写 → 本拆解作废重拆 |
| G-2 对话实时通道 | 复用 /api/events SSE（B1，audit 广播已在产线；客户端按 kind 过滤，避免新增连接数） | B2 WebSocket（新增 ws 依赖 + 双向） | S1 事件推送 + S2 客户端全换 |
| G-3 对话 UI | 自研 ChatView（C1，主题一致、零依赖） | C2 chat-ui-kit-react（需本地盘点） | 仅 S2 组件层替换 |
| G-4 文件端点位置与写权限 | workbench serve.mjs 扩 /api/files（D1）；默认**只读 + 写需 token + 仅回环** | D2 filebrowser sidecar；D3 DSH 工具面代理 | S3/S4 迁移；若 D2 → 本拆解作废重拆 |
| G-5 浏览器引擎 | v1 服务端 fetch 代理 + 正文抽取，JS 渲染/登录页为显式边界（F1） | F2 无头浏览器 v2；F3 Jina Reader 云开关（默认关） | S6 引擎整体换 + 禁网 blocker 大概率 |
| G-6 导航 v1 范围 | chat/files/browser 三模块接线；calendar/notify 维持占位 toast（H1） | 五模块全接 | 追加 2 个前端子任务（接线 2 个新面板） |
| G-7 新依赖引入策略 | 先本地盘点、缺失即 blocker（默认✅）；v1 默认零新依赖 | — | 任何引用外部库的 AC 前置条件变化 |

闸门验收点（G-0 完成 = 将军在任务详情对 G-1..G-7 逐项确认默认或给出翻转裁决；未逐项裁决视为按默认放行——本拆解按默认展开，故不阻塞波 1 开工）。

### 2.2 裁决 → 子任务影响映射（简版）

| 默认假设 | 翻转后影响 |
| --- | --- |
| G-1 单库 / G-2 SSE / G-3 自研 | S1、S2 重做，其余不受牵连 |
| G-4 端点 = serve.mjs + 写 token | S3/S4（及依赖它们的 S5）受影响 |
| G-5 fetch + 抽取 | S6/S7 受影响（无头引擎在禁网下大概率 blocker） |
| G-6 三模块 | 翻转则新增 S-9 calendar 面板、S-10 notify 面板（依赖 S8 后的接线基线） |
| G-7 零新依赖 | 任一翻转需在对应子任务 evidence 说明本地盘点结果 |

## 3. 依赖关系总览（DAG）与派工波次

```
Phase 0（无代码）: G-0 决策闸门（先于一切实施）
S1 (team-hub/server.mjs 域) ──► S2 (前端域 workbench/src) ──┐
S3 (serve.mjs 域) ──► S4 (serve.mjs 域) ──► S6 (serve.mjs 域) ──► S7 (前端域) ──► S8 (集成收口/文档)
                                                          ▲
S5 (前端域) ◄──────────────────────────────────────────────┘   （S5→S7 前端域串行）
R-1（whiteboard/tests/board-plugin 域，tester/devops 阶段）——与 S8 并行、无耦合
```

**依赖边（blockedBy）一览**：

| 子任务 | blockedBy | 依赖理由 |
| --- | --- | --- |
| S1 对话后端（team-hub） | G-0 | 建表/API/SSE 事件是本中心前端的数据前提 |
| S2 对话前端（workbench/src） | S1 | ChatView 依赖 S1 的 /api/chat/* 与事件 |
| S3 文件后端·只读面（serve.mjs） | G-0 | serve.mjs 域链起点（与 S1 并行） |
| S4 文件后端·写面（serve.mjs） | S3 | 写操作建立在只读面的目录根/路径防护之上 |
| S5 文件前端（workbench/src） | S4, S2 | 需 S4 读写 API；与 S2 同属前端文件域故串行（防合并冲突） |
| S6 浏览器后端（serve.mjs） | S4 | 与 S3/S4 同文件域，串行防冲突 |
| S7 浏览器前端（workbench/src） | S6, S5 | 需 S6 API；与 S2/S5 同属前端文件域故串行 |
| S8 集成收口与文档 | S7 | 三中心面板就位后统一回归 + 更新文档 |
| R-1 存量回归与宿主联调 | —（可与 S8 并行） | 独立文件域（whiteboard/tests/board-plugin），tester/devops 执行 |

**派工波次表**（每格 = 1 个士兵 1 轮；同波两格 = 文件域不相交可并行）：

| 波 | 并行任务 A | 并行任务 B |
| --- | --- | --- |
| 波 1 | S1（team-hub 域） | S3（serve.mjs 域） |
| 波 2 | S2（前端域） | S4（serve.mjs 域） |
| 波 3 | S5（前端域） | S6（serve.mjs 域） |
| 波 4 | S7（前端域） | — |
| 波 5 | S8（集成/文档） | R-1（回归，tester/devops） |

无循环依赖：所有边沿「后端 → 前端 → 收口」方向（见 §8 AC-6 校验）。

## 4. 阶段与子任务清单

工作量刻度：S ≤ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满（必要时可分两次验收提交，但验收点一次给全）。

---

### Phase 1 对话中心（chat）

#### S1 对话中心后端（team-hub 扩表扩 API + 审计/SSE）

- **目标**：team-hub v2 新增会话/消息两级存储与 REST API；消息写走统一写纪律（by 必填 + audit + SSE 广播），实时推送复用既有 /api/events（G-1/G-2 默认）。零新依赖。
- **产出**：team-hub/server.mjs（建表 + 迁移 + DAO + /api/chat/* 路由）+ team-hub/chat.test.mjs（契约测试，仿 skills.test.mjs：临时库 import server.mjs，不占端口）。
- **数据形态（按 RESEARCH §3 A1 建议，本次固化为契约）**：
  - conversations(id, scope, title, kind∈{space,direct,task}, participants JSON, created/updated, last_message_at)
  - messages(id, conv_id, scope, author, kind∈{text,markdown,system}, body, meta JSON, clientTs, createdAt)
  - 接口：GET /api/chat/conversations?scope=（按 updatedAt desc）｜POST /api/chat/conversations（创建会话）｜GET /api/chat/messages?conv=<id>&limit=&before=（升序分页）｜POST /api/chat/messages（发消息，author=by）。
- **依赖**：G-0。
- **工作量**：M（1 轮）。
- **验收点（AC）**：
  - AC1 `node --test team-hub/chat.test.mjs` 全绿。用例必须覆盖：会话创建与列表（scope 过滤）；消息追加与分页（limit/before 游标、升序返回）；scope 隔离（不同 scope 互不可见）；by/author 缺失被拒（400）；消息长度上限拒绝。
  - AC2 回归：`node --test team-hub/skills.test.mjs` 仍全绿（同一 server.mjs 未破坏既有模块）；老库迁移冒烟（无新表的旧库启动自动建表，测试覆盖，沿用 ensureColumn 先例）。
  - AC3 curl 冒烟（起真服务 + 临时 TEAM_HUB_DB）：POST 会话 → POST 消息 → GET 会话列表含 last_message_at → GET 消息分页正确；GET /api/activity 可查 chat:* 审计记录。
  - AC4 事件冒烟：订阅 /api/events（HTTP 流）期间写入一条消息，流内收到对应 chat 事件（测试/脚本断言，超时 ≤5s 内收到）。
  - AC5 写纪律：所有 chat 写经统一 handleWrite（by 必填、scope 归一），错误映射（400/401）与既有接口一致；响应含 ok/task 或同构体。
  - AC6 零新增依赖：只用 node:sqlite / node:http 等内置（evidence 说明 package.json 未新增依赖）。
- **完成口径（DoD）**：chat.test.mjs + skills.test.mjs 全绿、curl/事件冒烟通过、审计可查 = 本任务完成；无需前端。
- **追溯**：T-036 待办 P0-2（对话中心 = 会话/消息存储与 API）；RESEARCH A1/B1；闸门 G-1/G-2。
- **测试锚点**（test-designer 直接转用例）：会话 scope 隔离、消息分页边界（空会话/游标尾部）、author 必填、审计记录形状、SSE 事件载荷与 kind 命名。

---

#### S2 对话中心前端（ChatView + 接线）

- **目标**：workbench 新增对话中心面板（会话列表 + 消息气泡 + 输入发送 + 实时接收），跟随当前工作空间（scope）读写；侧栏「对话中心」由 toast 占位改为真实导航（H1）。主题与指挥台一致，样式复用 index.css 既有 token。
- **产出**：workbench/src/api.ts（hub chat 客户端函数）、workbench/src/components/ChatView.tsx（新面板）、App.tsx/Sidebar.tsx 接线（chat 分支）、types.ts 补类型。
- **依赖**：S1。
- **工作量**：L（1 轮满）。
- **验收点（AC）**：
  - AC1 `pnpm build` 全绿（tsc strict + noUnusedLocals/noUnusedParameters 零错误；若用 React.lazy，产物含独立 chunk）。
  - AC2 行为跟随当前空间：在「全部空间」提示先选具体工作空间（与任务集/编队分区语义一致）；切换空间后会话/消息随之切换且互不串（S1 的 scope 隔离为后端保障）。
  - AC3 主路径可用（将军在 :5173 按 README §2.1 启动法验收 serve.mjs 托管产物）：新建会话 → 发消息 → 气泡即时出现；第二标签页同空间 15s 内经 SSE 实时收到；刷新后历史仍在。
  - AC4 实时订阅复用单一 /api/events 源并按 kind（chat:*）过滤：不新增第二个 hub 事件连接；不影响右侧「实时动态」既有流。
  - AC5 渲染安全：消息正文按**纯文本**渲染（React 文本节点/textContent），代码审查 + grep 断言无 dangerouslySetInnerHTML 直插用户正文（X-1 markdown 增强属勾选项，未勾选前纯文本）。
  - AC6 失败路径：中枢不可达/写失败 → toast 错误提示且输入内容不丢失；事件流断线自动重连（EventSource 原生）。
- **完成口径（DoD）**：build 绿 + 主路径与实时收发的浏览器验收步骤逐条走通（每条给出可见结果）即完成。
- **追溯**：P0-2（前端视图）；RESEARCH B1/C1/H1；闸门 G-2/G-3/G-6。
- **测试锚点**：发送成功/失败、SSE 断线重连、kind 过滤不吞既有事件、scope 切换隔离。

---

### Phase 2 文件中心（files）

#### S3 文件后端·只读面（serve.mjs 扩 /api/files）

- **目标**：把现有仅「选文件夹」用的 /api/fs 扩展为按**当前工作空间（scope）** 浏览其绑定仓库目录的只读文件面：list / read / download。沿用「仅回环」边界（serve.mjs isLoopback 先例）与路径规范化防护。
- **产出**：workbench/scripts/serve.mjs（/api/files 只读路由）+ workbench/scripts/files-api.test.mjs（契约测试：临时目录 + 起临时端口或函数级直测）。
- **契约**：GET /api/files/list?scope=<spaceId>&path=<相对路径> → { root, path, entries:[{name, type(dir|file), size, mtime, isRepo(目录含 .git 时), ext}] }；GET /api/files/read?scope=&path= → 文本预览（截断 + 行数 + 长度；二进制返回明确「不可预览」而非乱码）；GET /api/files/download?scope=&path= → 原始字节 + Content-Type/Disposition。**目录根 = 该 scope 在 spaces 表登记的 local_dir**（serve.mjs 经 /hub 上游解析）；未绑定 → 返回可理解错误（提示先到空间设置绑定本地文件夹），**不得静默落到仓库根以外的任意目录**。
- **依赖**：G-0。
- **工作量**：M（1 轮）。
- **验收点（AC）**：
  - AC1 `node --test workbench/scripts/files-api.test.mjs`（或等价执行方式）全绿：list 返回文件/目录/大小/mtime/.git 标记；read 截断 + 行数；download 字节一致。
  - AC2 越界防护用例全绿：相对路径逃逸（../）、绝对路径越过目录根、NUL、符号链接指向根外 → 400/403 拒绝（路径 normalize 后必须仍在根内）。
  - AC3 仅回环：非回环请求返回 403（复用 isLoopback，与 /api/fs 既有守卫一致；评审核对 + 可行时函数级用例）。
  - AC4 二进制与超大文件 read：按扩展名拒绝预览或截断，响应体受控。
  - AC5 零新增依赖（node:fs/path/http）。
- **完成口径（DoD）**：契约测试全绿 + 越界/回环防护用例全绿 + curl 冒烟（真实空间绑定目录可 list/read/download）。
- **追溯**：P0-3（文件浏览/下载）；RESEARCH D1/E1；闸门 G-4/G-7。
- **测试锚点**：路径规范化矩阵（../、绝对路径、符号链接、盘符大小写）、目录根解析（已绑定/未绑定两态）、二进制 read 边界。

---

#### S4 文件后端·写面（上传 / mkdir / rename / delete + 鉴权）

- **目标**：在 S3 只读面之上补受限写操作：raw-body 上传、新建目录、改名、删除；默认只读 + 写需 token + 仅回环；覆盖/删除带二次确认语义（G-4/R6 默认）。零新依赖（上传用 PUT raw bytes 规避 multipart 解析依赖）。
- **产出**：workbench/scripts/serve.mjs（/api/files 写路由 + token 解析）+ files-api.test.mjs 扩展（写用例）。
- **契约**：PUT /api/files/upload?scope=&path=（body = raw bytes；Content-Length 超上限拒绝；目标已存在且未带 overwrite=1 → 409 提示）；POST /api/files/mkdir {scope,path}；POST /api/files/rename {scope,from,to}；POST /api/files/delete {scope,path,confirm}（非空目录删除需 confirm=yes 且拒绝误删；文件删除同样要求 confirm 字段）。写操作要求 token（serve.mjs --token 或 env DSH_WORKBENCH_TOKEN；未配置 token 时按现状放行但保留回环边界）。
- **依赖**：S3。
- **工作量**：M（1 轮）。
- **验收点（AC）**：
  - AC1 写契约测试全绿：上传（含中文名、超上限拒绝、overwrite 两态）、mkdir、rename、delete（confirm 缺失 400、非空目录需 confirm=yes、成功后 list 不可见）。
  - AC2 鉴权：配置 token 后，无 token 写请求 401、读请求仍放行（回环内）；未配置 token 时行为与现状一致。
  - AC3 路径防护与 S3 同强度：所有写路径同样做根内规范化，越界/symlink 逃逸拒绝（写用例覆盖）。
  - AC4 大文件上传流式/限长：Content-Length 预检 + 超限拒绝，不整读入内存（代码审查 + 上限用例）。
  - AC5 零新增依赖。
- **完成口径（DoD）**：写契约测试全绿 + 鉴权/越界用例全绿 + curl 冒烟（上传 → list 可见 → 下载一致 → 改名 → 删除）即完成。
- **追溯**：P0-3（上传/存储）；RESEARCH D1/R6；闸门 G-4/G-7。
- **测试锚点**：上传大小上限、overwrite/409、delete confirm 语义、写 token 鉴权矩阵、写路径越界。

---

#### S5 文件中心前端（FilesView + 接线）

- **目标**：workbench 新增文件中心面板（目录树 + 文件表 + 文本预览 + 下载/上传），侧栏「文件中心」与 QuickTools「文件浏览」卡接线为真实入口。文件内容预览以受控文本渲染（XSS 防护）。
- **产出**：workbench/src/api.ts（files 客户端）、workbench/src/components/FilesView.tsx、App.tsx/Sidebar.tsx/QuickTools.tsx 接线、types.ts 补类型。
- **依赖**：S4、S2（同前端文件域，串行）。
- **工作量**：L（1 轮满）。
- **验收点（AC）**：
  - AC1 `pnpm build` 全绿（含懒加载 chunk 检查，若采用 lazy）。
  - AC2 主路径（将军 :5173 浏览器验收）：进入「文件中心」显示当前空间绑定目录根；点目录逐层导航（含上级）；点文本文件出预览（显示截断/行数提示）；上传文件到当前目录并立即可见；下载可拉回且字节一致；QuickTools「文件浏览」卡进入本面板。
  - AC3 预览安全：预览内容以 textContent/受控文本渲染，grep + 评审确认无 dangerouslySetInnerHTML 直插服务端文件内容（防存储型 XSS）。
  - AC4 错误/空态：未绑定本地文件夹的空间给出引导（到空间设置）；越界/覆盖/删除等后端错误以 toast/行内提示呈现；大文件 read 截断提示明确。
  - AC5 目录变化一致性：上传/删除后列表刷新（本地刷新或重拉最新 list），不依赖全量重挂。
- **完成口径（DoD）**：build 绿 + 浏览/预览/上传/下载主路径浏览器验收走通 + 未绑定空间引导与错误提示可见。
- **追溯**：P0-3（前端 + DSH 文件工具面接线）；RESEARCH D1/E1/H1；闸门 G-4/G-6。
- **测试锚点**：预览截断边界、上传后刷新、未绑定空间引导、删除二次确认 UI、错误映射展示。

---

### Phase 3 浏览器助手（browser）

#### S6 浏览器后端（SSRF 防护 fetch 代理 + 正文抽取）

- **目标**：serve.mjs 提供 POST /api/web/fetch：给定 URL → 服务端拉取 → 限长/超时/内容安全 → 零依赖正文抽取（标题/正文文本/链接摘要，可转 Markdown）→ 结构化响应。**SSRF 是硬性不变量**（R2）；JS 渲染/登录态页为显式 v1 边界（R3，返回可理解提示而非假装抓到正文）。
- **产出**：workbench/scripts/serve.mjs（/api/web/fetch + SSRF 守卫 + 抽取函数；建议抽成可 import 的纯函数模块便于测试）+ workbench/scripts/web.test.mjs。
- **契约**：POST /api/web/fetch { url, maxBytes?, timeoutMs? } → { ok, finalUrl, status, contentType, title, text?, excerpt?, links?[], error? }；error 枚举：ssrf_blocked / timeout / too_large / unsupported / http_<status>。
- **依赖**：S4（serve.mjs 同文件域串行）。
- **工作量**：L（1 轮满）。
- **验收点（AC）**：
  - AC1 `node --test workbench/scripts/web.test.mjs` 全绿，覆盖抽取：本地 mock http 服务器返回 HTML → 标题/正文/链接正确；空正文/纯 JS 页 → 明确「无法抽取（JS 渲染页）」提示。
  - AC2 SSRF 用例全绿（硬性门禁）：协议白名单（仅 http/https）；目标 URL 与**重定向链每一跳**命中私网段（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、0.0.0.0、::1、fc00::/7 等）即拒绝 ssrf_blocked；file://、ftp:// 等非白名单协议拒绝；若实现 DNS 解析层校验，解析后指向私网也必须拒绝（测试覆盖）。
  - AC3 限长与超时：响应超 maxBytes（默认建议 ≤2MB，可配）→ too_large（或截断并标注）；总超时（默认建议 ≤10s，可配）→ timeout；默认值生效且可被单测覆盖。
  - AC4 内容安全：返回体只含结构化字段（title/text/excerpt/links），**不透传远端原始 HTML 给前端直插 DOM**（评审 + 断言响应形状）。
  - AC5 审计留痕：每次 fetch 记 console/日志（url、finalUrl、status、耗时、by；by 默认 general）。
  - AC6 零新增依赖：抽取先交付零依赖文本版；若本地盘点可得 @mozilla/readability / cheerio / Turndown 可换装，**缺失不阻塞**（列为 X-3 增强，见 §4.5）。
- **完成口径（DoD）**：web.test.mjs（抽取 + SSRF + 限长/超时）全绿 + curl 冒烟（本环境禁网时用本地 mock 服务器；若外网可达抓 https://example.com 得标题）即完成。
- **追溯**：P0-4（浏览器助手 = 真网页抓取）；RESEARCH F1/G1/R2/R3；闸门 G-5/G-7。
- **测试锚点**：SSRF 段矩阵、重定向链、限长/超时、抽取正常/异常（JS 页/二进制/空）、响应形状白名单。

---

#### S7 浏览器助手前端（BrowserView + 接线）

- **目标**：workbench 新增浏览器助手面板：地址栏 + 请求态 + 结果视图（默认文本/Markdown 渲染，HTML 不直插）；侧栏「浏览器助手」接线；QuickTools「打开浏览器」卡拆为「打开内部看板」（保留 openKanban）与「浏览网页」（进入本面板）两个入口（RESEARCH §11.1.3）。
- **产出**：workbench/src/api.ts（webFetch 客户端）、workbench/src/components/BrowserView.tsx、App.tsx/Sidebar.tsx/QuickTools.tsx 接线、types.ts 补类型。
- **依赖**：S6、S5（同前端文件域，串行）。
- **工作量**：M（1 轮）。
- **验收点（AC）**：
  - AC1 `pnpm build` 全绿（含懒加载 chunk 检查，若采用 lazy）。
  - AC2 主路径（将军 :5173 浏览器验收）：进入「浏览器助手」；输入目标 URL（禁网环境用本地 mock 服务地址）→ 显示标题 + 正文/摘要；QuickTools 两个入口各自落点正确（「浏览网页」进入本面板并聚焦地址栏、「打开内部看板」新窗口开经典看板）。
  - AC3 SSRF/错误呈现：输入私网地址（如 http://127.0.0.1:8787/api/config）→ 明确「已拦截：禁止访问内网地址」提示；超时/限长/网络错误与业务错误区分提示。
  - AC4 渲染安全：结果以文本/markdown 渲染（默认路径不把远端 HTML 直插 DOM；若决策走 HTML 渲染必须先经 DOMPurify 且本地盘点可得，缺失即 blocker 说明）。
  - AC5 状态机：请求中（loading）→ 成功/失败可重试；地址栏历史可复用（localStorage 可选，不做强制）。
- **完成口径（DoD）**：build 绿 + 抓取主路径/SSRF 拦截提示/错误态浏览器验收走通。
- **追溯**：P0-4（前端能力 + QuickTools 接线）；RESEARCH F1/G1/H1/R7；闸门 G-5/G-6/G-7。
- **测试锚点**：URL 校验提示、错误枚举到 UI 文案映射、结果渲染安全断言（评审 + grep）。

---

### Phase 4 集成收口与文档

#### S8 集成收口与文档

- **目标**：三中心面板全量就位后的收口：接线一致性回归（Sidebar/QuickTools/App 三个入口维度 × chat/files/browser 互不打架、旧模块 home/agents/skills 无回归）、calendar/notify 维持占位并在注释/文档标明（G-6）、文档同步（根 README 与 workbench/README 的功能指南/接口表/模块矩阵）、双写源纪律复核（chat 只写 team-hub、files/web 只写 serve.mjs 端点，不引入第三写源，与 README §5 警示一致）。
- **产出**：README.md（§3 功能指南 + §4 接口表增 chat/files/web 行 + 模块矩阵状态更新）、workbench/README.md（三中心实现位置/用法）、接线遗留修正（若回归发现问题）、受影响文件头注释更新。
- **依赖**：S7。
- **工作量**：M（1 轮）。
- **验收点（AC）**：
  - AC1 全量回归命令逐条真跑并留输出要点：workbench `pnpm build`；`node --test team-hub/skills.test.mjs team-hub/chat.test.mjs`；`node --test workbench/scripts/files-api.test.mjs workbench/scripts/web.test.mjs`（或 S3/S4/S6 采用的执行方式）。
  - AC2 文档与实际一致：README 模块矩阵三中心标「可用」；接口表含 /api/chat/*、/api/files/*、/api/web/fetch；calendar/notify 标注「占位（P1 后续）」；文档命令可复现。
  - AC3 无回归：sidebar 9 模块点击行为符合预期（home/agents/skills 原行为、tasks → openKanban、chat/files/browser → 各自面板、calendar/notify → 占位 toast）；右侧动态/KPI/3D 正常。
  - AC4 写源纪律：evidence 说明 chat 写仅走 team-hub /api/chat（统一 handleWrite），files 写仅走 serve.mjs /api/files，无第三写源；README §5 警示未回退。
- **完成口径（DoD）**：回归命令全绿 + 浏览器三中心主路径 + 文档更新到位 = 本拆解默认面全部交付。
- **追溯**：P1-5（导航接线收口）；RESEARCH §11.1.4/§11.1.5；闸门 G-6/H1。
- **测试锚点**：模块级回归清单（9 模块 × 期望落点）、SSE 事件源连接数目测（hub 事件源 ≤ 新增 1 条）。

---

### Phase 5 存量回归（tester/devops 阶段执行，非默认 coder 面）

#### R-1 存量回归与宿主联调（whiteboard / tests/contract / board-plugin）

- **目标**：T-036 盘点 P1-7 的落地：既有模块（whiteboard、tests/contract、plugins/board-plugin 等）在本轮改动后仍可跑/可注入，作为交付回归兜底。**本任务建议由 tester/devops 在验收阶段执行**，不占 coder 默认面；将军也可选择跳过并记录原因。
- **产出**：回归记录（evidence：命令 + 输出要点 + 通过/受限结论）。
- **依赖**：—（可与 S8 并行；文件域独立）。
- **工作量**：M（1 轮，环境敏感）。
- **验收点（AC）**：
  - AC1 whiteboard 回归：cd whiteboard && node --test（apps/server/test + packages/shared/test 全绿）；起服冒烟（node apps/server/src/index.js 或按 whiteboard/docs/DEPLOY.md）可访问。
  - AC2 契约回归：node --test tests/contract/contracts.test.mjs 全绿（56 用例基线）。
  - AC3 宿主联调（环境受限项）：board-plugin/plugins 按各自 README/build 说明验证（如 typecheck/build + 注入宿主冒烟）。**需要 DSH Desktop/宿主运行环境；本环境不可达时在 evidence 说明环境限制与复现步骤，不静默判过、也不冒充通过**——该项为显式环境依赖（见附录 A）。
  - AC4 本拆解默认面（S1~S8）改动不破坏上述存量：回归在合并主分支后执行，结果与 S8 一并记录。
- **完成口径（DoD）**：whiteboard/tests/contract 全绿 + 宿主项给出「通过」或「环境受限 + 复现步骤」结论即完成。
- **追溯**：T-036 P1-7（存量验收）；RESEARCH R8。
- **测试锚点**：whiteboard e2e 基线、contracts 56 用例、board-plugin 注入清单。

---

### 4.5 候选增强（X-1~X-5，默认不做；将军在任务详情勾选后才追加为子任务，各自前置 = 本地盘点，缺失即 blocker）

| 增强 | 内容 | 挂靠子任务 | 前置（禁网盘点） |
| --- | --- | --- | --- |
| X-1 | ChatView 消息 markdown 渲染 | S2 之后 | react-markdown（MIT）本地可得 |
| X-2 | 文件在线查看/编辑（CodeMirror 6） | S5 之后 | codemirror 包本地可得（懒加载分 chunk） |
| X-3 | 浏览器正文精抽取换装 | S6 之后 | @mozilla/readability / cheerio / Turndown 本地可得 |
| X-4 | 抓回 HTML 直接渲染（DOMPurify 净化） | S7 之后 | DOMPurify 本地可得（默认走文本/Markdown，无需本项） |
| X-5 | Jina Reader 云兜底开关（默认关） | S6 之后 | 显式开关 + 隐私声明（RESEARCH F3） |

任何增强勾选后仍遵守 G-7：先盘点、缺失即 blocker；未勾选前不进入默认验收面。

## 5. 需求追溯矩阵（T-036 待办 → 子任务）与覆盖检查

| T-036 待办 | 子任务 | 状态 |
| --- | --- | --- |
| P0-2 对话中心（存储/API + 前端视图） | S1 + S2 | 默认面 ✅ |
| P0-3 文件中心（浏览/上传/存储 + 工具面接线） | S3 + S4 + S5 | 默认面 ✅ |
| P0-4 浏览器助手（真网页抓取/浏览） | S6 + S7 | 默认面 ✅ |
| P1-5 导航接线（files/browser/chat/calendar/notify） | S2/S5/S7 各自接线 + S8 收口；calendar/notify 维持占位 | 默认面 ✅（calendar/notify 按 G-6 默认占位） |
| P1-6 双账本收敛（v1/v2 写源统一） | — | 范围外，见附录 A（devops 另立项） |
| P1-7 存量验收（whiteboard 起服联调、board-plugin 注入宿主验证） | R-1 | 默认面 ✅（tester/devops 阶段执行） |
| P2-8 旧流水线文档归档标注 | 附录 B（本文档替代声明）+ 可选归档小任务 | 本文档内已处理，正式归档见附录 A |
| 横切：零依赖纪律（禁网） | 全部子任务 AC 含零新增依赖项 | 默认纪律 ✅ |

子任务 → 闸门/决策域矩阵：S1(A1,B1,G-1,G-2) · S2(B1,C1,H1,G-2,G-3,G-6) · S3(D1,E1,G-4,G-7) · S4(D1,G-4,G-7) · S5(D1,E1,H1,G-4,G-6) · S6(F1,G1,R2,R3,G-5,G-7) · S7(F1,G1,H1,G-5,G-6,G-7) · S8(H1,G-6) · R-1(P1-7,R8)。

覆盖检查结论：默认面 = P0 三中心 + P1-5 导航 + P1-7 存量回归全部有落点；P1-6/P2-8 显式移入附录 A（附归属与触发条件），不存在「拆了但没人要」的悬空任务。

## 6. 流水线衔接（下游消费点）

- **test-designer**：以 S1~S8 的「验收点 + 测试锚点」为输入转写 docs/TEST_CASES.md（正常/边界/异常 + 浏览器手工验收清单模板）；SSRF 段矩阵、路径越界矩阵、scope 隔离、confirm/overwrite 语义是重点契约。
- **coder**：按 §3 波次认领 S1~S8（每个子任务 = 一个士兵一轮）；每完成一个跑其「验证命令」并在 evidence 给输出要点；新增依赖零/先盘点；同文件域串行纪律由任务依赖边保证（S2→S5→S7 前端域、S3→S4→S6 serve.mjs 域）。
- **reviewer**：审查重点 = SSRF 守卫完备性、/api/files 路径规范化与符号链接逃逸、chat 写纪律（by + audit + SSE）与 scope 隔离、三处渲染安全（聊天正文/文件预览/抓回内容不得直插 HTML）、serve.mjs 仅回环 + 写 token 边界。
- **tester**：执行全部用例 + S8/R-1 浏览器回归与手工验收清单；输出 docs/TEST_REPORT.md。
- **devops**：R-1 存量回归 + 服务三件套（team-hub :8787 / serve.mjs :5173 / v1 :4820）启停回归；services-plugin 托管不受影响验证。

## 7. 风险与依赖缺口

- **R1 禁网/依赖**：外部库一律先本地盘点、缺失即 blocker、不下载（v1 默认零新依赖即为此设计）。workbench 构建需 node_modules：**独立 worktree 默认没有 node_modules（主仓 workbench/node_modules 已装）**——用 junction 指向主仓 node_modules（services-plugin 已有 junction 先例）或 `pnpm install`（依赖应在本地 store/缓存；若需联网则失败并 blocker 说明，不擅自下载）。
- **R2 浏览器 SSRF**：硬性不变量（S6 AC2）；实现建议 = 协议白名单 + 私网/回环/链路本地段阻断 + 重定向链逐跳校验 + DNS 解析后复查 + 限长/超时 + 审计；评审必须逐条核对。
- **R3 JS 渲染页不可抓**：v1 显式边界（返回提示），v2 无头浏览器另议；勿把「抓回外壳」冒充正文。
- **R4 chat 与任务共享 SQLite 写**：DatabaseSync 串行写 + busy_timeout=5000 已存在；冒烟上限建议 ≤100 msg/min + P95 写延迟可观测（测试/脚本可加，不做 CI 硬闸）。
- **R5 SSE 连接数**：chat 订阅并入单一 /api/events 按 kind 过滤；S2 AC4 硬性检查不新增第二个 hub 事件连接。
- **R6 文件写越权/误删**：默认只读 + token + 仅回环 + 根内路径规范化 + 覆盖 overwrite=1 + 删除 confirm 二次确认；评审必查。
- **R7 抓回/用户内容注入**：默认文本渲染路径；HTML 渲染仅经 X-4（DOMPurify）。
- **R8 前端无测试 runner**：workbench 无 vitest；UI 子任务验收 = pnpm build（typecheck）+ 浏览器手工验收清单（每条给预期可见结果）。纯逻辑（SSRF/路径/抽取/chat DAO）全部落在 node --test 契约测试，不依赖 UI 自动测试。
- **R9 合并冲突**：任何时刻同文件域并行 >1 任务即可能冲突；§3 波次表与依赖边已显式约束（S2→S5→S7、S3→S4→S6），将军派工请勿破例并行同域任务。
- **R10 宿主环境依赖**：board-plugin 注入验证需 DSH Desktop 宿主（R-1 AC3）；不可达按「环境受限 + 复现步骤」记录，判为受限而非通过。

## 8. 本阶段验收标准（breaker 自拟，逐条对应 T-038 官方验收）

- **AC-1（官方）把需求/方案拆成可独立认领、可独立验收的子任务**：S1~S8 + R-1 每个都是纵向切片（后端任务带契约测试、前端任务带 build + 浏览器验收清单），可单独认领单独验收。✅ §4。
- **AC-2（官方）每个子任务带验收标准 + 依赖（blockedBy）+ 工作量估计**：§4 每节含「验收点（AC）+ 依赖 + 工作量」；§3 依赖边表汇总 blockedBy 及理由。✅
- **AC-3（官方）每个子任务有「完成 = 什么」的可测口径**：每节含「完成口径（DoD）」+ 可运行验证命令（node --test / pnpm build / curl / 浏览器清单），无黑盒。✅
- **AC-4（官方）任务顺序/并行关系明确，无循环依赖、无遗漏**：§3 DAG + 波次表（5 波 + 回归波）；依赖边全部朝「后端 → 前端 → 收口」方向无环（S1→S2→S5→S7→S8；S3→S4→S6→S7→S8；S4→S5）；覆盖检查见 §5（P0~P2 全部待办有落点或显式归附录 A）。✅
- **边界遵守**：本阶段只产出本文档（docs/TASK_BREAKDOWN.md），不写实现、不改需求语义与方案结论（默认值 = RESEARCH 一等，未发明新选型）、未调 taskctl、未 push、未下载依赖；候选增强与范围外项均显式标注，不拆成悬空任务。

## 附录 A：范围外 / 待将军另行裁决清单（防止遗漏，非悬空）

| 项 | 来源 | 为何不在默认面 | 归属建议 | 触发条件 |
| --- | --- | --- | --- | --- |
| P1-6 双账本收敛（v1 tasks.json 与 v2 SQLite 写源统一） | T-036 P1-6；RESEARCH R8 | RESEARCH 未纳入 v1 拓扑（§11），且现状纪律「并存期间只写其中一个」（根 README §5）已生效；本拆解三中心不引入新写源，不构成遗漏 | devops 单独立项 | 将军确认 v1 进入只读/下线时 |
| P2-8 旧流水线文档归档（docs/ 多代产物标注） | T-036 P2-8 | 低优先纯文档整理，与实施无关；本文档已先做「替代声明」（附录 B） | requirement 或将军本人 | 将军认可后随手做 |
| board-plugin / plugins 宿主注入完整验证 | T-036 P1-7 后半 | 需 DSH Desktop/宿主环境，本拆解环境不一定可达（R-1 AC3 已给受限出口） | tester/devops（R-1 内） | 宿主可达时执行，不可达记录受限 |

## 附录 B：本文档替代说明

docs/TASK_BREAKDOWN.md 为共享流水线产物位，历次流水线依次重写（T-011 白板拆解 → 本次 T-038）。旧版内容（T-011）仍可经 git 历史回溯（commit 35d2978）；同目录 REQUIREMENTS.md 当前为 T-014 旧产物、RESEARCH.md 为 T-044 方案搜索（本次输入，保留），均不属本次改动范围。

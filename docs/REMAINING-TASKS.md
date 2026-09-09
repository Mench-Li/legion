# Legion 剩余待办清单

> 更新时间：2026-09-09  
> 当前基线：`main`（P0 hardening 已合入）

本文记录当前尚未完成的产品、架构和发布工作。已完成的安全加固、CI 扩展、artifact 路径安全、插件 token 传播和白板 WebSocket 鉴权不在本文重复列出。

## 状态说明

- **可独立实施**：不依赖 DSH 宿主，可在本仓库完成并自动验证。
- **宿主依赖**：需要真实 DSH checkout、宿主进程或插件注入环境。
- **架构决策**：实现前需要确认唯一数据源或兼容策略。
- **暂缓**：价值明确，但当前优先级低于核心稳定性工作。

## P1：架构与发布可靠性

### P1-1 team-hub 两套服务实现合并

状态：**架构决策**

问题：

- `team-hub/server.mjs` 是完整 v2 独立服务，负责任务、空间、目标、聊天、日历、规范、技能、附件、审计和 SSE。
- `team-hub/src/index.ts` 是 DSH 宿主插件适配器，仍保留一套基于 `taskctl.mjs` 的旧任务 API 实现。
- 两套实现的数据来源、配置入口、鉴权和接口覆盖范围不同，后续容易出现修一处、漏一处的行为漂移。

涉及改动：

1. 以 `server.mjs` 作为唯一业务实现。
2. 从 `server.mjs` 抽取可复用的 `handle(req, res)`。
3. 将 `src/index.ts` 改成只负责 DSH `webServer` 路由注册和配置转接。
4. 统一数据库路径、token、host、scope、SSE 和附件目录配置。
5. 删除 `src/index.ts` 内重复的 taskctl 业务逻辑。
6. 为独立服务和宿主适配器增加同一套 HTTP 契约测试。

验收标准：

- 独立服务和 DSH 宿主对同一请求返回相同状态码、字段和错误语义。
- 聊天、日历、技能、空间、附件等 v2 API 在宿主模式可用。
- 不再存在第二套任务状态机和鉴权实现。

风险：高。需要先确认 `server.mjs` 是否正式成为唯一权威实现。

### P1-2 board-plugin 宿主 HTTP 契约测试

状态：**已完成**（2026-09-09，随 board-plugin 宿主 HTTP 契约套件合入）

已完成内容：

- 新增 `board-plugin/tests/http-contract.test.mjs`：构造最小 fake `webServer` context，注入编译后的
  board-plugin（`lib/index.js`）并启动临时 HTTP 服务；写入隔离的 `tasks.json`、`activity.jsonl`、
  `board.json`、`daemon.json`、`roles.json` 与 artifact fixture（`tests/fixtures/`，含 taskctl/render
  替身、kanban/console 页面、roles 映射）。
- 覆盖 32 项：`/api/artifact` 逐条（raw/content-type/越界 400/未知任务 404/越权 `../` 根外盘符 `.git`
  403/符号链接 link-out 逃逸 403 + link-in 放行/缺失 404/octet-stream）、`/api/board`、
  `/api/activity`（limit）、`/api/config`、`/api/daemon`、`/api/patch`、kanban/console 前缀重写、
  本地写接口（create/transition 乐观锁 409/comment/reject/promote）、SSE 初始 + 增量，以及 hub 模式
  （fake team-hub）scope/token/错误映射（乐观锁 409、业务 400、非 JSON 500 文案）。
- 产物 API 断言与 `scrum/artifact-detail.test.mjs`（K4-B/K5-A）同一语义组。
- 顺带修复 board-plugin 相对产物路径白名单回退缺陷（`src/index.ts`：候选路径存在但 realpath 复检不通过
  —— 仓库内 junction 指向根外 —— 不再回退到该可穿透路径，整体 403）。
- 接入发布门禁：`scripts/ci/run-ci.mjs` test 阶段在配置 `DSH_CHECKOUT` 时构建 board-plugin 并跑该套件
  （镜像 plugins 先例；无 checkout 时 SKIP 不伪造通过）。

验收标准核对：

- board-plugin 独立测试可在无完整 DSH GUI 的情况下运行：✅ `node --test board-plugin/tests/http-contract.test.mjs`（32/32）。
- 与 `scrum/artifact-detail.test.mjs` 使用同一组语义断言：✅。
- 真实宿主注入测试另行保留，不用 mock 结果冒充宿主验证：✅（注入冒烟仍列 P1-3，本套件仅用 fixture 替身覆盖 HTTP 契约面）。

### P1-3 DSH 宿主真实插件注入冒烟

状态：**已完成**（2026-09-09，证据见 `docs/P1-3-evidence/verify-evidence.md`）

问题：

- 当前已验证插件可编译、纯函数测试和部分静态契约。
- 尚未在真实 DSH 宿主验证 `inject` 生命周期、`webServer.register`、route prefix、插件加载和前端面板注入。

涉及改动：

- 启动真实 DSH 宿主 fixture（隔离 `$DSH_HOME` + 自定义 profile + dsh-base bundle，真实
  `apps/cli/lib/bin.js`；不触碰生产 3080 宿主/配置与真实任务库）。✅
- 加载 team-hub、board-plugin、plugins（profile patch insert + node_modules junction，同生产形态）。✅
- 验证 `/api/config`、`/api/board`、`/api/artifact`、SSE 和 token 矩阵。✅
- 验证宿主关闭时 watcher、SSE、定时器和数据库连接正确清理。✅

验收标准：

- 真实宿主启动、访问、关闭全流程无异常：✅（5 用例全绿，含 `ctx.appExit` bounded 优雅退出）。
- token、scope、路由前缀和插件 UI 注入均通过：token/路由前缀/注入全过；
  插件 UI（board-plugin client 半 conversation.view iframe）需真实 GUI 面验证，
  登记边界（见 evidence「诚实边界」，P0 §3 dev_inject 曾覆盖注入链路）。

顺带修复（真实宿主注入才暴露的 board-plugin 缺陷，http-contract 32/32 回归仍绿）：

- 冷启动 mount 崩溃：`watch(board.json)` 文件未生成时 ENOENT → 改目录级 watch + filename 分派。
- detectHub 硬编码 `127.0.0.1:3080` → 改探测同宿主 `ctx.webServer.port` 的 /team-hub
  （隔离/异端口宿主部署不再错配到其他实例）。

门禁：`scripts/ci/run-ci.mjs` test 阶段新增 `p13-host-injection` 套件组（无 DSH_CHECKOUT 整组 SKIP）。

## P2：接口与数据一致性

### P2-1 v1/v2 任务状态、分页和 SSE 语义统一

状态：**已完成**（2026-09-09，随 v1v2 契约对比测试与文档基线合入）

问题：

- v1 使用 `tasks.json/activity.jsonl`，v2 使用 SQLite。
- 任务状态、分页字段、SSE 初始事件、activity 结构和错误码存在潜在差异。

已完成改动：

- **契约表入库**：`docs/CONTRACT-V1V2.md` —— v1/v2/board-plugin 三路只读盘点收敛为统一接口契约表
  （任务公共字段子集、写接口入参、错误分类矩阵、SSE 生命周期、登记差异 R1-R10），作为后续实现与
  测试断言锚点。
- **v1 低风险对齐**（`scrum/serve.mjs`）：
  - `/api/activity` limit 加 cap 500（对齐 v2 上限，消除「无上限全量读」分叉；缺省 50 不变，0/NaN 兜底）。
  - 未知路径/静态缺失 404 由 text/plain 统一为 JSON `{error}`（对齐 v2/board-plugin 错误响应形态）。
- **v2 事件信封统一**（`team-hub/server.mjs`）：新增 `auditEvent()`（audit 行 → 对外事件对象），
  REST `/api/activity` 与 SSE `/api/events` 共用——既有平铺字段（seq/ts/member/scope/action/taskId/
  goalId/detail）不变，补 `event`(=action)/`id`(=seq)/`payload`(=detail) 兼容信封字段。
- **SSE 协议改造**（P2-3，见下条目）：id: 行 + Last-Event-ID 增量回放。
- **共享 fixture 契约测试**：`tests/contract/v1v2-contract.test.mjs` —— 同一业务场景（create → comment →
  transition）分别打真实 v1（serve.mjs + 临时任务库 + taskctl/render 副本 fixture）与真实 v2
  （server.mjs + mkdtemp SQLite），断言：写响应壳 `{ok,task}`、22 个任务公共字段两端一致、错误分类
  矩阵（缺参 400/非法迁移 400/乐观锁 409/未知路径 404 JSON）、`/api/activity` limit 尾部语义、v1
  `/api/board`（渲染快照）与 v2 `/api/board`（任务裸数组）语义登记、v2 SSE 信封与 Last-Event-ID、
  v1 双流既有形态锁定。
- 门禁接线：`scripts/ci/run-ci.mjs` test 阶段新增 `v1v2-contract` 套件组。

验收标准核对：

- 同一业务场景 v1/v2 公共字段与错误分类一致：✅（写契约 describe 5 用例 + 错误矩阵）。
- 保留 v1 兼容字段、不再新增语义分叉：✅（v1 仅对齐 cap 与 404 形态，未动字段面；差异登记 R1-R10）。
- SSE 统一序号、heartbeat 与断线清理：✅（v2 /api/events id: 行 + Last-Event-ID + 既有 :hb/close 清理锁定；
  v1 无全局 seq 维持回放+指纹去重，契约登记 S3）。

范围说明：v1/v2 数据底座不同是架构事实（P1-1 另立）；P2-1 统一契约面（字段/错误/SSE 行为），不合并实现。

### P2-2 team-hub 读接口权限模型统一

状态：**已完成**（2026-09-09，随远程读面鉴权门禁合入）

问题与现状（改动前）：

- team-hub 的 token 只保护写接口（`handleWrite`/附件上传），约 30 个 GET/SSE 读端点
  （`/api/board`、`/api/activity`、`/api/events`、`/api/skills`、`/api/members`、`/api/roster`、
  `/api/chat/*` 等）在非回环监听时无需任何 token 即可读取任务/审计/技能/聊天元数据。

已完成改动：

- `team-hub/server.mjs`：
  - 导出 `isLoopbackHost` / `readAuthRequired`（纯函数决策）：非回环监听 + 已配 token → 读面必须鉴权；
    本地回环（127.0.0.1/localhost/::1）无论是否配 token 读面保持开放（开发体验不回退）。
  - `handle()` 顶部统一读面门禁：远程保护模式下除 `/api/config`（能力发现）与 OPTIONS 外，全部
    端点（读/SSE/写）都需 token；未知路径同受门禁（不泄露端点存在性）。
  - `authorized()` 支持三种携带方式（对齐 v1 serve.mjs）：`Authorization: Bearer` / `x-dsh-token` /
    `?token=`（后者供 EventSource 等无法自定 header 的读订阅）。
- 测试：`team-hub/security.test.mjs` 增加决策纯函数用例；新增 `team-hub/read-auth.test.mjs`
  （远程模式 HTTP 矩阵：无 token/错 token 401、三种携带方式 200、config 放行、SSE 401/`?token=` 200、
  写面 401、OPTIONS 204、未知路径 401/404）与 `team-hub/read-open-loopback.test.mjs`
  （回环 + 已配 token：读/SSE/config 无 token 仍 200，写面仍 401、带 token 可写——不回退锁定）。
- 消费方 token 头同步：
  - Workbench `api.ts`：新增 `hubGet`（hub GET 统一带 Bearer）与 `hubEventSourceUrl`（hub 审计 SSE
    以 `?token=` 追加）；~20 个 hub 读函数全部改走 `hubGet`，`subscribeHubAudit` 改走带 token URL；
    v1（apiBase）读面本就开放不动；CalendarView 自带 token 头不动。
  - board-plugin：hub GET/POST 早已带 Bearer（P1-2 契约套件已验证），无需改动。
  - scrum v1 `serve.mjs`：读面按既有契约开放（零 token 看板/console），写面 token 门禁不变，无需改动。
- 门禁接线：`scripts/ci/run-ci.mjs` test 阶段新增 `read-auth` 套件组
  （read-auth.test.mjs + read-open-loopback.test.mjs）。
- 顺带修复 `board-plugin/tests/http-contract.test.mjs` 清理抖动：Windows 含 junction 的临时目录
  快速递归删除偶发 EPERM 导致套件假红（5/6 复现）——改为先删 junction + 宽容重试、失败仅遗留可回收
  临时目录不抛（8/8 稳定 exit 0）。

验收标准核对：

- 非回环监听无 token 时拒绝启动（既有 `validateSecurityConfig`）+ 读面全门禁：✅（HTTP 矩阵验证）。
- 正确 token 可读、错误 token 401：✅（Bearer/x-dsh-token/?token= 三路验证）。
- 本地回环开发体验不回退：✅（回环 + token 场景锁定：读开放、写面仍门禁；team-hub 全组 137/137）。

范围说明：本项覆盖 team-hub v2 读面与 Workbench/board-plugin/scrum 消费方 token 头；scope/member
一致性过滤属既有实现（skills include=pending 收口等），不在本项新增。

### P2-3 SSE 生命周期和断线恢复统一

状态：**已完成**（2026-09-09，随 v2 /api/events 信封与 Last-Event-ID 合入）

问题：

- v1、v2、board-plugin 各自维护 SSE 客户端集合。
- 初始事件、增量事件、heartbeat、重连和重复事件处理方式不同。

已完成改动：

- **统一事件信封**（v2 /api/events + REST /api/activity 共用 `auditEvent()`）：data 帧在既有平铺字段
  （seq/ts/member/scope/action/taskId/goalId/detail）之上补 `event`(=action)/`id`(=seq)/`payload`
  (=detail) 兼容字段；SSE 帧加 `id: <seq>` 行（浏览器 EventSource 原生断点续传基础）。
- **Last-Event-ID 支持**（`team-hub/server.mjs` /api/events）：读 `Last-Event-ID` 头，合法序号 → 只回放
  `seq > N` 的增量（升序）；无/非法 → 回退最近 30 条升序回放（不报错）。
- **heartbeat/关闭清理**：15s `:hb` 注释帧 + close 时 clearInterval + Set 删除既有同构行为，契约测试锁定。
- **前端去重抽纯函数 + 单测**：`workbench/src/dedupe.ts`（`dedupeSeqDesc`/`mergeById`/
  `activityFingerprint`/`dedupeByFingerprint`），NotifyView/ChatView/App 改为复用；
  新增 `workbench/scripts/dedupe.test.mjs` 9 用例（docs/review/T-100-REVIEW.md O5 缺口收口）。
- **断线/乱序测试**：`tests/contract/v1v2-contract.test.mjs` SSE describe —— 连接回放升序、信封字段、
  Last-Event-ID 增量续传（seq=max+1 单条、无重复）、非法 Last-Event-ID 回退、15s 心跳实测、
  v1 双流既有形态锁定。
- 门禁接线：`scripts/ci/run-ci.mjs` test 阶段新增 `dedupe` 套件组。

验收标准核对：

- 统一事件字段 id/event/scope/seq/ts/payload：✅（v2 data 帧含全部 6 字段，payload 兼容 detail）。
- 支持 Last-Event-ID：✅（HTTP 级续传测试）。
- 统一 heartbeat、关闭清理和前端去重：✅（心跳/清理契约锁定；去重三口径统一纯函数 + 单测）。
- 断线重连和乱序事件测试：✅（Last-Event-ID 断线续传 + 去重函数乱序收敛）。

范围说明：v1 activity 事件无全局 seq（activity.jsonl 文件追加模型），Last-Event-ID 完整闭环在 v2/
board-plugin-hub 成立；v1 维持「连接回放 + 内容指纹去重」（App.tsx seenEvents），契约表 S3 登记；
board-plugin hub 模式 SSE 桥接（R9）属跨宿主改造，登记移交 P1-3/P1-1（真实宿主联调）一并验证。

## P2：Workbench 功能完善

### P2-4 通知中心增强

当前已有 audit 派生通知、未读徽标和 scope 级已读游标。

待改动：

- 通知分类、优先级和来源统一。
- 批量标记已读。
- 任务、目标、空间跳转协议统一。
- SSE 实时通知去重和断线恢复。

### P2-5 日程日历增强

当前已有 team-hub 日历数据面和 Workbench 面板。

待改动：

- 事件与任务/目标关联。
- 编辑、删除、时区和时间区间完善。
- 明确是否支持重复事件。
- 增加冲突检测和更完整的视图。

### P2-6 对话中心真实闭环

当前已有会话、消息、awaiting/replied/failed、重试、附件和 scope 隔离。

待改动：

- 真实 DSH 守护与模型通道 E2E。
- awaiting → replied/failed 的前端合并和断线恢复。
- 模型不可用、超时、守护离线的完整 UI 验证。
- 附件上下文生命周期和清理测试。

依赖：真实 DSH 宿主和模型 provider。

### P2-7 文件中心增强

当前已有目录、读写、上传、重命名、删除、token 和路径安全。

待改动：

- 批量操作和搜索。
- 上传冲突策略。
- 大文件分片或断点续传。
- 更完整的 git 状态/差异展示。

### P2-8 浏览器助手增强

当前已有 SSRF、私网、协议、重定向、超时和大小限制。

待改动：

- 空间级抓取历史与缓存。
- 更好的正文提取。
- 可选截图能力。
- 更细的限流和配额。

## P3：生产级能力

### P3-1 白板多房间与连接治理

当前白板是单实例、单进程、单房间模型。

涉及改动：

- 房间 ID、房间级存储和成员权限。
- 连接数、消息大小和消息频率限制。
- 指标、审计和更完整的健康检查。
- 明确单实例继续运行，或设计多实例共享存储。

### P3-2 统一配置系统

当前配置分散在环境变量、CLI、services-plugin、DSH 宿主和 Workbench 本地设置。

涉及改动：

- 统一配置 schema 和优先级。
- 启动时输出脱敏后的最终配置摘要。
- 统一 token、host、port、DB 路径和附件目录。
- 增加配置校验命令。

### P3-3 历史 evidence 文档治理

当前部分历史报告仍保留旧测试数量、旧默认 host 或旧构建命令。

涉及改动：

- 标记历史 evidence 为不可作为当前状态依据。
- 统一当前状态入口为 README、`docs/DEPLOY.md` 和最新 CI 证据。
- 增加生成时间和基线 commit。

## 推荐实施顺序

1. P1-1：先决定 team-hub 唯一权威实现。
2. P1-2：~~补 board-plugin 独立 HTTP 契约测试~~（已完成，见上节）。
3. P2-1：统一 v1/v2 任务和 SSE 公共语义。
4. P2-2：~~统一 team-hub 读接口权限模型~~（已完成，见上节）。
5. P1-3：在真实 DSH 宿主完成插件注入冒烟。
6. P2-3：统一 SSE 断线恢复。
7. P2-4～P2-8：按用户价值选择 Workbench 功能增强。
8. P3：在确认部署规模后再做白板和配置系统的生产化改造。


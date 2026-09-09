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

状态：**宿主依赖**

问题：

- 当前已验证插件可编译、纯函数测试和部分静态契约。
- 尚未在真实 DSH 宿主验证 `inject` 生命周期、`webServer.register`、route prefix、插件加载和前端面板注入。

涉及改动：

- 启动真实 DSH 宿主 fixture。
- 加载 team-hub、board-plugin、plugins。
- 验证 `/api/config`、`/api/board`、`/api/artifact`、SSE 和 token 矩阵。
- 验证宿主关闭时 watcher、SSE、定时器和数据库连接正确清理。

验收标准：

- 真实宿主启动、访问、关闭全流程无异常。
- token、scope、路由前缀和插件 UI 注入均通过。

## P2：接口与数据一致性

### P2-1 v1/v2 任务状态、分页和 SSE 语义统一

状态：**可独立实施**

问题：

- v1 使用 `tasks.json/activity.jsonl`，v2 使用 SQLite。
- 任务状态、分页字段、SSE 初始事件、activity 结构和错误码存在潜在差异。

涉及改动：

- 建立 v1/v2 统一接口契约表。
- 对齐 `/api/board`、`/api/activity`、`/api/events`、`/api/create`、`/api/transition`、`/api/comment` 和 `/api/artifact`。
- 使用同一 fixture 对比状态码、JSON 字段、错误语义和 SSE event。

验收标准：

- 同一业务场景在 v1/v2 的公共字段和错误分类一致。
- 保留 v1 兼容字段，但不再新增语义分叉。
- SSE 支持统一的序号、heartbeat 和断线清理行为。

### P2-2 team-hub 读接口权限模型统一

状态：**可独立实施**

问题：

- 当前 token 主要保护写接口，部分读接口仍默认开放。
- 非回环监听时，任务、审计、技能和聊天元数据可能被读取。

涉及改动：

- 明确本地回环与远程监听两种权限模式。
- 远程模式统一保护 board、activity、events、audit、skills、chat 等读接口。
- 对 scope/member 做一致性过滤。
- 同步 Workbench、board-plugin 和 scrum 的 token 头处理。

验收标准：

- 非回环监听无 token 时启动失败或所有敏感读写接口拒绝访问。
- 正确 token 可读取授权 scope，错误 token 无法读取。
- 本地回环开发体验不回退。

### P2-3 SSE 生命周期和断线恢复统一

状态：**可独立实施**

问题：

- v1、v2、board-plugin 各自维护 SSE 客户端集合。
- 初始事件、增量事件、heartbeat、重连和重复事件处理方式不同。

涉及改动：

- 统一事件字段：`id`、`event`、`scope`、`seq`、`ts`、`payload`。
- 支持 `Last-Event-ID`。
- 统一 heartbeat、关闭清理和前端去重。
- 增加断线重连和乱序事件测试。

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
4. P2-2：统一 team-hub 读接口权限模型。
5. P1-3：在真实 DSH 宿主完成插件注入冒烟。
6. P2-3：统一 SSE 断线恢复。
7. P2-4～P2-8：按用户价值选择 Workbench 功能增强。
8. P3：在确认部署规模后再做白板和配置系统的生产化改造。


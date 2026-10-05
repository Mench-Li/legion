# Legion 服务器 / 电脑 / 手机远程 Agent 实施计划

日期：2026-10-04
状态：计划定稿，按阶段实施中
设计依据：[Legion 个人服务器、个人电脑与手机协同架构设计](../specs/2026-10-02-legion-server-pc-mobile-agent-architecture.md)
执行方式：当前会话顺序执行；不启动子代理。
代码基线：`a8ff20de`（= `origin/main` = 本计划分支的起点）
工作区：独立 worktree，分支 `worktree-legion-remote-agent`

本计划把设计文档的阶段零～阶段三转成可执行步骤，并按用户已确认的部署参数收敛范围。凡设计文档标注为「建议/示意」的契约，本文只在本阶段真正实现时才定稿；未实现的仍标为未实现。

## 0. 已确认的部署参数

2026-10-04 向用户确认，以下为实施输入，不再改动（若要改需另开一轮确认）：

| 参数 | 结论 |
| --- | --- |
| 部署模式 | **服务器权威模式 + 真机部署**（Hub 与 SQLite 部署到个人服务器） |
| 服务器 | `117.72.146.36`，Ubuntu 24.04.2 LTS，2 vCPU / 3.9 GB RAM / 49 GB 可用 |
| 服务器访问 | SSH 私钥登录（`legion.pem`），root |
| HTTPS 入口 | `117.72.146.36.sslip.io` + Let's Encrypt（无自有域名） |
| 身份模型 | **多用户 / 邀请制** |
| 手机端 | PWA（移动适配 Web 页面） |
| 电脑 Node | 原生 Windows |
| 数据出境 | **只传结构化进展与摘要**；不上传完整源码、环境变量、凭据、完整终端日志 |

由此产生的两条硬约束，贯穿全部实现：

- 因为是多用户，设备令牌、会话令牌与空间授权必须分离建模，不能沿用单一 `TEAM_HUB_TOKEN` 作为最终身份系统。
- 因为只传结构化进展与摘要，Node 的**出站**方向必须有一层独立的出境策略与脱敏，不能只依赖服务端收到后再脱敏。

## 1. 基线核对结论（设计文档阶段零的人工部分）

以下均已在本分支**读码或实测**确认，作为实施前提，不再重复验证。

1. **Hub 能脱离 DSH Host 独立运行——已实测通过。**
   `team-hub/server.mjs` 的依赖闭包零第三方包（只有 `node:` 内建与仓库内相对模块）；`isMain` 时 `server.listen(PORT, HOST)`。实测 `TEAM_HUB_PORT=18787 TEAM_HUB_DB=<临时库> TEAM_HUB_TOKEN=… node team-hub/server.mjs`：进程启动，`/api/config` 返回 `runPlane:true`，`/api/agents` 返回 200。
   → 设计文档 §1.1「迁移前必须验证 Hub 能否在没有本机 DSH Host 的服务器环境独立运行」**已通过**，不需要先拆启动职责。

2. **任务/Attempt 状态机是唯一权威**：`orchestrator/state-machine/states.mjs` 定义 13 个 Attempt 状态与 6 个任务状态；`taskStatusOf` 是全函数，且对 `RetryableFailure`（需 `retryBudgetRemaining`）与 `AwaitingApproval`（需 `approvalFrom`）**强制**要求输入，缺输入返回具名错误而不是猜。远程层不新增权威状态机。

3. **运行面已是带 `leaseEpoch` 的租约模型**：`team-hub/run-store.mjs` 提供 `claim / heartbeat / transition / release / recoverExpired / failAndRetry / recordRunEvents / listHeld / resolveAttempt`；HTTP 出口是 `team-hub/routes/runtime-lease.mjs` 的 9 条 `/api/runtime/*`。当前是**拉取式 HTTP**（worker 主动 claim）。

4. **事件流已具备可续读游标**：`GET /api/events`（SSE）支持 `sinceSeq` 与 `Last-Event-ID` 增量回放，`seq` 来自 `audit` 表且单调；`team-hub/event-delivery.mjs` 有每订阅者六态投递记账与租约回收；前端 `workbench/src/hubEventStream.ts` 已持久化游标。
   → 设计文档「手机断线重连补齐进展」所需的**传输层机制已经存在**，本计划只做接入与展示，不另造。

5. **对话/命令/幂等已落地**：`team-hub/agent-conversations.mjs` 拥有会话绑定、消息、命令、问题、汇报、读取游标、`agent_request_receipts`（幂等回执）与 `agent_run_bindings`（Attempt↔Run 绑定）。

6. **现有认证边界是本地回环，不是设备身份**：`product/local-auth.mjs` 的 `checkDesktopRequest` 要求 `Host === 127.0.0.1:<port>`；`team-hub/server.mjs` 在非回环监听时强制 `TEAM_HUB_TOKEN`（`validateSecurityConfig` 抛错），且非回环时读面与 SSE 同样需要 token（`readAuthRequired`）。
   → 这只是**单令牌门禁**。设计文档 §10 要求的用户身份、设备身份、细粒度授权、密钥轮换撤销、协议防重放全部缺失，需新增。

7. **零依赖 RFC6455 WebSocket 服务端已存在**：`whiteboard/apps/server/src/ws.mjs` 覆盖握手、文本/二进制帧、分片、ping/pong、close；其中 `encodeFrame` 只产出**未掩码**帧（服务端方向正确）。
   → Hub 侧可复用同一套形状；Node 侧需要**掩码**的客户端实现。两者共用一个帧编解码纯模块，不各自实现一遍。

8. **服务器现状（实测）**：nginx 1.24 监听 `:80`，站点 `default` 与 `legion-updates`；**未安装 Node**；**无 certbot**；`:443` 空闲；另有第三方 `ifrit-agent` 监听 `127.0.0.1:1234`——本方案不得干扰它。

### 1.1 接口清单：复用 / 扩展 / 新增

设计文档阶段零要求输出这份清单。判定依据是上文 1–8 的读码结果：

| 能力 | 判定 | 依据 |
| --- | --- | --- |
| Agent 会话、消息、命令、问题、汇报、读取游标 | **复用** | `/api/agent-conversations`、`/api/agent-messages`、`/api/agent-commands`、`/api/agent-read-cursors`、`/api/agent-runtime`、`/api/agent-questions` 已在 `team-hub/routes/agents.mjs` |
| 任务/Attempt 领取、续租、终态、失败、人工处置 | **复用** | `/api/runtime/*` 9 条 + `run-store.mjs` |
| 事件流与断线续读 | **复用** | `/api/events` 的 `sinceSeq` / `Last-Event-ID` + `event-delivery.mjs` |
| 权限评估与审批绑定 | **复用（客户端侧接线）** | `permission-engine.mjs`、`approval-binding.mjs`；远程请求必须经它们，不另造判断 |
| 任务状态投影 | **扩展** | 现有 `states.mjs` 已穷尽；远程展示必须走 `taskStatusOf`，不新增状态 |
| 用户身份、会话令牌、设备注册、配对码、能力协商、心跳、撤销 | **新增** | 现有只有单令牌；无用户/设备概念 |
| 电脑到 Hub 的出站连接与任务派发协议 | **新增** | 现只有拉取式 HTTP，无推送通道 |
| Node 本地运行账本与重连对账 | **新增** | 设计文档 §6.3 要求，现无 |
| 出境脱敏策略 | **新增** | 现只有 `runtime/adapters/dsh/redact.mjs`（入站输入保护），无出站策略 |
| 移动端时间线与移动适配界面 | **新增** | 现有 workbench 是桌面指挥台 |

## 2. 范围

### 2.1 本计划要做

- 阶段 A 帧编解码纯模块（Hub 与 Node 共用，零依赖）。
- 阶段 B 用户 / 会话 / 设备身份与配对（多用户、邀请制、可撤销、可轮换）。
- 阶段 C Node 协议契约（纯模块）：帧 schema、版本协商、大小上限、幂等与序号校验。
- 阶段 D Hub 侧 Node 网关：出站连接接入、心跳、派发、回报，**在进程内调用 `run-store`**。
- 阶段 E 电脑侧 Node 客户端：出站连接、重连退避、本地运行账本、出境脱敏、真实执行一个预配置 Agent。
- 阶段 F 手机 PWA：移动适配时间线（对话 / 任务 / 进展三类信息在同一 Agent 详情汇合，来源可区分）+ 断线游标补读。
- 阶段 G 服务器真机部署：Node 运行时、systemd 单一监督、nginx + sslip.io + Let's Encrypt、公网端到端验收。

### 2.2 本计划不做（沿用设计文档 §2.2 非目标）

- 不做桌面画面 / 鼠标键盘流式转发。
- 不承诺多 Agent 自动共享隐藏推理或完整模型上下文。
- 不把 Hub 当代码执行沙箱，不向公网开放任意 shell。
- 不要求服务器跑大模型或配 GPU。
- 首版不做透明 DSH Web 完整代理（设计文档 §1.2 把它列为独立 capability；本计划只预留 capability 边界，不实现代理）。
- 首版不做 Hub/PC 双向离线编辑与冲突合并；PC 只保留最小运行账本。
- 不引入 PostgreSQL、对象存储、消息队列；维持单 Hub 写入者 + SQLite。

## 3. 目标形态

```text
手机 PWA ── HTTPS/SSE ──┐
桌面浏览器 ── HTTPS/SSE ─┤
                         ├── nginx (TLS, 443) ── Legion Hub (127.0.0.1:8787)
电脑 Node ── 出站 WSS ───┘                            │
                                                SQLite (WAL) + 审计 + 投递记账
```

- 公网只开 `443/TCP`；Hub 绑定 `127.0.0.1`，由 nginx 反代。
- 电脑只做出站连接，家庭网络不开入站端口。
- Hub 是任务、对话、进展、授权的持久化真相源；Node 只执行已授权工作并报告事实。
- 在线/离线是 presence 投影，**不是**任务状态；Node 离线时任务状态仍从数据库读取。

## 4. 实施阶段

每阶段给出交付物与验收。验收以真实命令与输出为准，不以「应该没问题」结项。

### 阶段 A：帧编解码纯模块

**交付物**：`packages/shared/src/ws-frames.mjs`（+ `.d.mts`）、`packages/shared/test/ws-frames.test.mjs`。
把 RFC6455 帧编解码抽成纯函数，Hub 服务端与 Node 客户端共用；发送方向可指定是否掩码（服务端不掩码、客户端必须掩码）。

**验收**：握手 `Sec-WebSocket-Accept` 计算正确；长度三种编码（<126 / <65536 / 更大）往返一致；掩码帧往返一致；分片重组；超长帧按上限拒绝；缓冲区不完整返回 `null` 而不是抛错。`node --test` 通过。

### 阶段 B：用户、会话与设备身份

**交付物**：

- `team-hub/user-store.mjs`：用户、邀请、会话令牌、刷新凭据、空间角色。
- `team-hub/device-store.mjs`：设备注册、配对码、能力、心跳、撤销、轮换。
- `team-hub/routes/identity.mjs`：管理面 REST（邀请、登录、刷新、登出、设备列表、配对、撤销）。

设计要点：

- 用户口令用 `scrypt` 加盐存储；**不存明文**，也不存可逆加密。
- 访问令牌短时（默认 15 分钟）、HMAC 签名；刷新凭据长时可撤销，**库里只存哈希**。
- 配对码：一次性、短时（默认 10 分钟）、限速、单次消费，`INSERT ... ON CONFLICT` 保证只能被消费一次。
- 设备令牌绑定 `node_id` + 能力范围，可单独撤销与轮换；撤销后立即失效。
- 空间授权按 `user × space × role` 检查，角色至少区分 owner / admin / member / viewer。
- 审计追加写入，日志不记录令牌与模型密钥原文。

**验收**：邀请→接受→登录→刷新→登出全链路的单测；配对码重复消费被拒；撤销后令牌立即失效；错误口令与不存在用户返回同一形状（不泄露用户是否存在）；相同用户名并发注册只有一个成功。

### 阶段 C：Node 协议契约

**交付物**：`packages/shared/src/node-protocol.mjs`（+ `.d.mts`）、测试。纯模块，不碰 socket。

设计要点（对齐设计文档 §7.2）：

- 帧至少携带 `request_id`、`node_id`、`protocol_version`、`task_id` / `attempt_id`、`leaseEpoch`、幂等 `event_id`、确认游标。
- 版本协商：Hub 公布 `min_version` / `max_version`，首版按**精确主版本**匹配；不兼容时**具名拒绝**并给出可诊断原因，**不静默降级**。
- 消息体上限与字段级校验；未知帧类型返回具名错误而不是忽略。
- 幂等：同一 `event_id` 重复投递被识别为重复，不重复计费、不重复执行。
- 事件序号单调；乱序或倒退序号返回具名错误。

**验收**：每条拒绝路径都有单测（版本不兼容、超长、未知类型、重复 `event_id`、序号倒退、缺 `leaseEpoch`）；相同输入得到确定结果。

### 阶段 D：Hub 侧 Node 网关

**交付物**：`team-hub/node-gateway.mjs`、`team-hub/node-presence.mjs`、测试。

设计要点：

- 挂在既有 `http.Server` 的 `upgrade` 事件上，路径 `/node`，复用阶段 A 的帧模块。
- 握手前鉴权设备令牌；握手后**先**做版本协商，协商失败立即关闭并给出原因。
- 派发：Hub 通过 `runStore.claim`（以 `node_id` 为 `workerId`）取得 Attempt，经通道下发；**所有状态迁移仍走 `run-store` 事务**，网关不直接写库。
- 回报：Node 上报的 `transition` / `fail` / 事件批次经同一套校验后进入 `runStore`；`leaseEpoch` 不匹配的迟到回报被拒。
- 心跳维护 presence 表；超阈值标记连接中断，**任务状态不变**（不回退、不判失败）。
- 重连对账：Node 上报本地账本，Hub 按 task/attempt/epoch 比对；结果无法验证的进入 `UnknownOutcome`，不自动重跑。
- 待派队列有界：默认每空间 100 个、7 天过期（设计文档 §8.1 建议初值，产品配置可收紧）；到上限拒绝新任务并明确提示，不静默丢弃。

**验收**：用真实 `http.Server` + 真实 WSS 客户端跑集成测试——claim→派发→心跳→进展→终态全链路；旧 `leaseEpoch` 回报被拒；重复 `event_id` 不产生重复事件；连接断开后任务状态不被改写；Hub 重启后 Node 重连可对账。

### 阶段 E：电脑侧 Node 客户端

**交付物**：`product/node/`（`entry.mjs`、`client.mjs`、`ledger.mjs`、`egress.mjs`）、测试。

设计要点：

- 出站 WSS 连接 + 指数退避重连；断线期间不伪造任务状态。
- 本地运行账本：只记 `task_id / attempt_id / leaseEpoch / 状态 / 时间`，用于重连对账；**不是**第二套权威状态。
- 出境策略：默认只上行结构化进展与摘要（用户确认项）；源码、环境变量、凭据、完整终端日志在**发送前**被过滤并留下计数，不依赖服务端脱敏。
- 执行边界：只跑已配置的 Agent，只访问授权的项目工作区；服务端未授权的动作具名拒绝。

**验收**：替身服务端上的连接/重连/对账单测；出境策略对含密钥、路径、大段日志的样本逐条断言；`leaseEpoch` 过期时停手。

### 阶段 F：手机 PWA

**交付物**：workbench 移动适配布局 + Agent 详情时间线（`workbench/src/components/` 下新增/改造），复用 `hubEventStream.ts` 游标。

设计要点：

- 同一 Agent 详情内汇合三类信息并**来源可区分**：用户与 Agent 的对话、任务、可追溯进展；普通消息不得显示成执行进度。
- 断线重连以游标补齐缺失动态，再从 Hub 读当前投影。
- 状态展示至少区分：Hub 不可达 / Hub 可达但电脑离线 / Agent 在线但运行时不可用 / 任务运行中 / 任务等待用户 / 任务结果待确认。
- 待办任务与后续队列对用户可见（含「等待电脑上线」而不是「执行中」）。

**验收**：`npm run build`（`tsc --noEmit && vite build`）通过；移动视口下的布局与游标补读有断言或可复核的构建产物。

### 阶段 G：服务器真机部署

**交付物**：`product/server/`（bootstrap 脚本、systemd 单元、nginx 站点）。

步骤：

1. 安装 Node 运行时（发行版或 NodeSource），版本满足 `>=22.5`（`node:sqlite` 需要）。
2. 建专用系统用户与数据目录；不覆盖既有 `default` / `legion-updates` 站点，不改动 `ifrit-agent`。
3. 部署仓库代码到服务器固定路径；Hub 绑定 `127.0.0.1:<port>`，配置 `TEAM_HUB_TOKEN` 之外的用户/设备身份。
4. systemd 单实例监督（健康检查、日志轮转、重启策略）；**不同时**使用 systemd 与 PM2 管同一 Hub。
5. nginx：新增独立站点，`117.72.146.36.sslip.io` 反代到 Hub，SSE 关闭缓冲，WebSocket 升级头透传。
6. Let's Encrypt 签发证书（HTTP-01），配置自动续期；`:443` 开、`:80` 仅做 ACME 与跳转。
7. 端到端验收：公网 HTTPS 健康检查；手机可达；电脑 Node 出站连接成功；一次真实任务从手机派发到电脑执行并回报。
8. 备份：SQLite 一致性备份（WAL 检查点）+ 加密异地保存 + 恢复演练记录。

**验收**：上述 8 步各自有命令与输出留存；恢复演练在干净目录里恢复出任务、会话与进展的关联关系。

## 5. 风险与回滚

| 风险 | 处置 |
| --- | --- |
| Hub 首次暴露公网 | 只开 443；Hub 绑回环；先短时开放、验收后收紧；管理 SSH 限来源 |
| 无域名签证书失败 | `sslip.io` 已在服务器与本机实测解析到该 IP；失败则退回 VPN 内可达方案（需另行确认） |
| 新身份系统与既有 `TEAM_HUB_TOKEN` 语义冲突 | 两者并存但职责分离：token 继续保护本机/过渡面，用户与设备身份只用于远程面；不删旧路径 |
| 服务器只有 2 vCPU / 3.9 GB | 不部署模型、不做构建；Hub 只做控制面；资源与磁盘用量纳入监控 |
| 误动服务器既有服务 | 新增独立 nginx 站点与 systemd 单元，不改 `default`、`legion-updates`、`ifrit-agent` |
| 远程派发重复执行有副作用的动作 | 沿用 `leaseEpoch` 栅栏与 `run-store` 的 `UnknownOutcome` 语义；不满足条件时具名拒绝而不是猜 |

回滚：停用新 systemd 单元并移除 nginx 新站点即可回到部署前状态；数据库在独立路径，不受既有站点影响。

## 6. 进度

- [x] 独立 worktree 与分支建立（`worktree-legion-remote-agent`，基线 `a8ff20de`）
- [x] 部署参数向用户确认（§0）
- [x] 基线核对与接口清单（§1）
- [x] 计划文档定稿（本文件）
- [x] 阶段 A 帧编解码纯模块（`packages/shared/src/ws-frames.mjs`，27 项用例通过）
- [x] 阶段 B 用户 / 会话 / 设备身份（`user-store.mjs` 28 例 + `device-store.mjs` 22 例 + `remote-auth.mjs`）
- [x] 阶段 C Node 协议契约（`packages/shared/src/node-protocol.mjs`，22 项用例通过）
- [x] 阶段 D Hub 侧 Node 网关（`node-gateway.mjs` 22 例；接线测试 13 例）
- [x] 阶段 E 电脑侧 Node 客户端（`product/node/`：agent 端到端 9 例 + 出境 14 + 账本 11 + 执行器 12）
- [x] 阶段 F 手机 PWA（`workbench/mobile/`：时间线 14 例 + 静态路由 9 例；含 SW 与图标）
- [x] 阶段 G 服务器真机部署（可信域名入口从 2026-10-05 起可用）
  - [x] Node 运行时（v24.21.0）、系统用户、数据目录、密钥、systemd 单元
  - [x] Hub 上线并绑回环；`/api/identity/status` 200；无令牌读端点 401；机器令牌 200
  - [x] 云厂商拦截的实测与规避（见下「部署实录」）
  - [x] 云入口改用**公网 IP + 自签 CA**（只开 443）：手机页面公网 200、证书链 OpenSSL 验签 OK
  - [x] 首次初始化（系统管理员）与**电脑配对**（公网 HTTPS 兑换配对码）
  - [x] Node 出站连接、派发、进展回报、阶段上报、出境策略在真实链路上生效
  - [x] **上下文快照**：Hub 侧派发前冻结（远端已能合法进入 `Running`，见下）
  - [x] 租约回收与预约结清（否则一条旧尝试能把整个队列堵死）
  - [x] 完整闭环实机验证：建任务 → 4 秒内到 `in_review`，150s 后不变
  - [x] **可信域名入口**：Cloudflare 隧道 + DNS 生效；公网 https://legion-si.online 全套 200、tls=0、SSE 未被缓冲、WSS 升级通
  - [x] **备份与恢复演练**：每日定时器 + 一致快照（VACUUM INTO）+ gpg 加密 + 读回验证；恢复演练在干净目录用真实 Hub 读通
  - [x] 远端 Node 参与**写入预约**生命周期（心跳续期；申请与结清仍在 Hub 侧，见下）
  - [ ] 备份**异地存放**与目标环境演练（本仓库不假定用哪种同步方式）

## 6.1 部署实录（2026-10-04/05）

服务器 `117.72.146.36`（Ubuntu 24.04.2，2 vCPU / 3.9 GB，nginx 1.24.0）。

### 证书签发的两次失败与根因（本次最有价值的一条发现）

- Certbot HTTP-01 失败：CA 从公网访问 `http://117.72.146.36.sslip.io/.well-known/…`
  得到 **403**，响应头 `Server: JDTP`，正文是"网页禁止访问"的跳转脚本。
- 同一路径从服务器本机带同样 Host 请求，nginx 正常 200；同一时刻用裸 IP 作 Host
  请求 80 端口也正常。→ 拦截条件是「80 端口 + **未备案域名**的 Host」。
- 改用 acme.sh 的 **TLS-ALPN-01**（走 443）：CA 回报 `Connection reset by peer`。
- 进一步定位（在服务器上临时起监听，从公网对比）：裸 TCP 正常；普通 TLS 握手
  （带域名 SNI）**成功**；带 `-alpn acme-tls/1` 的握手**被重置**。
  → 443 上针对性拦了 ACME 校验。
- **结论：未备案域名在这台服务器上拿不到 Let's Encrypt 证书**（两种校验都被拦）。

### 采用方案与它的边界

先用 **Cloudflare Tunnel**（服务器主动出站，公网入口在 Cloudflare 侧）。
实测 `pkg.cloudflare.com` 在该网络下超时，故 cloudflared 走 GitHub release 静态二进制。
隧道令牌写入后连接器上线（4 条连接，lax），但 **Cloudflare Zero Trust 需要绑定支付方式**，
运营者无法进入面板添加 Public Hostname——日志因此停在
`No ingress rules were defined … will return 503`。

改用**公网 IP 过渡入口**（`product/server/setup-ip-entry.sh`）：
**只开 443**，用自签 CA 签发服务器证书（加密，但浏览器不默认信任）。
刻意**不**开 80 明文入口：只开 80 在功能上"完全可用"，而那正是危险之处——
登录口令与会话令牌会明文过网且没有任何提示。

> 途中踩到并修掉的一个真实回归：一开始 80/443 都开了，而 80 端口上既有的
> `legion-updates` 站点用的也是这个裸 IP 作 `server_name`。两个站点抢同一个名字，
> nginx 只让其中一个生效，实测把既有站点的 `/healthz` 从 200 变成 **401**。
> 现在 Hub 只占 443，`/healthz` 已恢复 200（并入验证清单）。

**必须如实记录的边界**：裸 IP 与 `sslip.io` 类域名都无法完成 ICP 备案，而境内服务器
上的网站需备案是运营者的合规义务。当前方案只让技术链路在**当前**拦截策略下可用，
**不改变合规状态**。长期方案：自有已备案域名（然后走 `setup-tls.sh`），
或把入口移到境外节点。

### 已完成的验收

| 项 | 结果 |
| --- | --- |
| Hub 独立于 DSH 运行 | ✅ 零第三方依赖，systemd 托管，只绑 `127.0.0.1:8787` |
| 远程门禁 | ✅ 无令牌 `/api/board` → 401；机器令牌 → 200；`/api/identity/status` 公开 |
| 手机页面 | ✅ `https://117.72.146.36/mobile/` → 200（公网实测） |
| 证书链 | ✅ OpenSSL 验签 `Verification: OK`（Windows schannel 需装证书到系统store） |
| 首次初始化 | ✅ 库空时用机器令牌建第一个系统管理员（口令只落 0600 文件，不进对话记录） |
| 设备配对 | ✅ 电脑经公网 HTTPS 兑换配对码 → 拿到设备令牌（`NODE_EXTRA_CA_CERTS` 指自签 CA） |
| Node 出站长连接 | ✅ 注册成功、心跳稳定、presence 在线；掉线自动重连 |
| 派发 | ✅ `node:dispatch` → `node:dispatch-ack`（审计可见） |
| 进展回报 | ✅ `node:progress` seq 1..4 入库 |
| **出境策略在真实链路上生效** | ✅ 含私钥块的进展到达 Hub 时是 `[已拦下：包含私钥块]` |
| 阶段上报 | ✅ `node:phase PreparingWorkspace` / `BuildingContext` 已入库 |
| 失败与对账路径 | ✅ 租约过期 → `UnknownOutcome`（不自动重跑）；人工对账 → `RetryableFailure` → 新尝试入队 |

### 已打通的完整闭环（2026-10-05）

一条自建任务从手机侧建起到等验收，全链在**公网 + 真机**上跑通：

```text
建任务(todo) → Hub 冻结上下文 → 派发 → 电脑执行 → 进展上报 → 终态 → Validating / in_review
```

实测读数（`T-017`）：建任务后 **4 秒内**到达 `in_review`，并在**超过租约 TTL（120s）
的 150 秒里保持 `in_review` / `Validating` 不变**。审计里能看到完整链路：

```text
node:context-frozen   {snapshotHash: sha256:af499168…}   ← Hub 侧冻结（真快照：3 候选 / 纳入 1）
node:dispatch → node:dispatch-ack
node:phase            PreparingWorkspace → BuildingContext → Running
node:progress         seq 1..4（其一被出境策略拦成 [已拦下：包含私钥块]）
node:transition       {outcome: completed}
```

`Validating` 是这条链的**合法终点**：`Completed` 需要一条验收记录
（`requiresPersist: ['attempt','validation']`），而"执行完成不等于交付被接受"
正是 Legion 的模型。所以任务停在 `in_review` 等人验收，是对的。

### 可信域名入口（2026-10-05 打通）

运营者完成 Cloudflare Zero Trust 配置后，公网入口从「IP + 自签证书」切换为
**`https://legion-si.online` + Cloudflare 可信证书**。实机验收（全部不加 `-k`）：

| 项 | 读数 |
| --- | --- |
| 能力发现 / 手机页 / app.mjs / manifest / 图标 | 全 `200`，`ssl_verify_result=0` |
| 无令牌的业务读端点 | `401`（远程门禁仍生效） |
| **SSE 未被缓冲** | 连接后立刻收到 `retry: 2000`（手机进展流靠它） |
| **WSS 升级** | 电脑经 `wss://legion-si.online/node` 注册成功 |
| 完整闭环 | 建任务 → **4 秒内**到 `in_review` |

一处配置错配与它的处理：隧道面板里的 Public Hostname 指向 `http://localhost:3000`，
而 Hub 在 **8787**，公网因此返回 **502**（服务器日志里是
`dial tcp 127.0.0.1:3000: connect: connection refused`）。

`setup-ip-entry.sh` 里加了一段**只为 3000 存在**的 nginx origin 别名，
让那份已配好的面板配置能用。把面板 Service 改成 `127.0.0.1:8787` 之后
删掉那段即可——**不**让 Hub 去听 3000：那等于让产品迁就一次配置笔误，
而"把外面的名字接到里面的端口上"本来就是入口层的职责。

备案仍是未决项：裸 IP 与 `sslip.io` 都无法备案，而境内服务器的网站需备案是
运营者的合规义务。Cloudflare 隧道让技术链路可用，**不改变合规状态**。

### 备份与恢复（2026-10-05 演练通过）

`backup.mjs` + 每日 systemd timer（03:17，避开整点；`Persistent=true` 补跑）。

**为什么不能 `cp team.db`**：实测该服务器主库 **1.1 MB**、`team.db-wal` **4.2 MB**
——大部分最近写入还在 WAL 里。只拷主库会得到「能打开、少数据」的备份，
它不报错，等恢复那一刻才发现最近的任务/消息/进展都没了。
所以用 SQLite 的 **`VACUUM INTO`**：把 WAL 一并纳入的一致快照，且可在库被写时执行。

写完立刻**读回验证**（`integrity_check` + 12 张关键表 + 行数），不通过就删文件并
返回非零——写出来但读不回去的备份，与没有备份，在出事那天是同一个东西。

恢复演练（`restore-drill.sh`）在**另一个目录**恢复，并用**真实 `server.mjs`**
起一次 Hub 去读它（"文件能打开"不是"恢复"的定义），还断言**关联**未断：

```
解密 → 1.2 MB；任务 18 / 尝试 15 / 运行事件 40 / 上下文快照 8 / 审计 179 / 用户 1 / 设备 1
断链：会话绑定 0 条、消息挂空会话 0 条
真实 Hub 起来后读得到 T-001 的验收标准
```

部署期连踩三个权限坑（都改成了具名失败，而不是让 SQLite/gpg 报原始错误）：

1. 备份目录 `install -d` 建成 root 所有 → `VACUUM INTO` 抛
   `unable to open database`（读起来像"库坏了"）；
2. 口令文件 0600 root 而备份以 `legion-hub` 跑 → gpg 前被拒；
3. 口令放在 `/etc/legion-hub/`（`0700 root`）→ 备份用户连 `stat` 都做不到，
   而 `existsSync` 把 EACCES **吞成 false**，于是报"文件不存在"，
   人会去找一个其实存在的文件。

**仍未做**：备份异地存放与在目标环境演练。备份目录与库在同一块盘上——盘坏了一起没。
本仓库不假定用哪种同步方式（`rclone`/`scp`/对象存储），但这件事不做，
"有备份"就只挡住了"误删"，挡不住"机器没了"。

### 手机端接通（2026-10-05）

手机端此前**根本用不了**——不是界面问题，是一个两处各自都对的缺陷：

- 远程门禁用**用户令牌**放行了请求；
- `routes/agents.mjs` 里的 `authorized(req)` 只认**机器令牌**。

于是手机上每一个 `/api/agent-*` 都是 401：门禁放行、路由又挡回去。
只读代码看不出来——两处的实现都没错。是**手机端接口契约用例**
（`mobile-api-contract.test.mjs`，照 `app.mjs` 的顺序打一遍真实 HTTP）抓出来的。

修法：网关在"用户令牌已验证"之后给请求打 `__legionUser` 标记，`authorized` 认得它。
没有远程通道时该标记恒为 `undefined`，既有行为一字不变。

顺带补上**空间级授权**（设计文档 §13「一个项目的 Agent 无权读取未授权项目」）：
URL 上能看见 `scope` 的请求先验这个用户在不在那个空间里，不在就 `403 SPACE_FORBIDDEN`，
SSE 同样受约束。

> **这一条曾经是缺口，现已补上（2026-10-05）。** 当时的边界写在台账里：
> `scope` 在 **POST 请求体**里时门禁查不到——门禁读不到 body，读了就把流消耗掉、
> 路由再也拿不到。"只答了「你是谁」，没答「你能不能碰这个空间」"，
> 于是任何登录用户只要把 body 里的 `scope` 换成别人的空间，就能往那里写消息、
> 建会话、下命令。
>
> 修法：判定收敛到 `server.mjs` 的 `requireSpaceAccess`（**读取与写入共用同一处**，
> 不写第二份——两份判定迟早会漂移），由**只有它同时具备**已解析 body、已注入身份
> `req.__legionUser` 与确定失败出口的 `routes/agents.mjs` 调用。
> 用例在 `mobile-api-contract.test.mjs`：`POST /api/agent-conversations` 带别人的
> `scope` 必须 `403 SPACE_FORBIDDEN`。

另外记一条与直觉相反的口径：**系统管理员不自动能读所有空间**。
系统角色管的是"造邀请 / 停用账号"，不是"看所有数据"——合并这两件事会让
"给某人管理权"顺带把全部数据交出去。

### 手机端「真的打开了」：headless Chrome 验收（2026-10-05）

接口契约用例能证明**字段名对得上**，但它们**不执行 `app.mjs`**。
一个在浏览器里一加载就抛异常的页面，在那些用例下是全绿的——
而用户看到的是一片空白。

> 「接口全通」与「页面能打开」是两种不同的坏法，
> 而它们都表现为「手机上什么都没有」。

所以加了 `product/server/check-pwa.sh`：用**真实 Chrome（headless）**打开线上页面，
把渲染后的 DOM 与浏览器控制台倒出来，并断言三件事：

1. **关键结构还在**（`#screen-login` / `#timeline` / `#btn-login` …）——
   整片消失说明脚本把 DOM 弄坏了；
2. **脚本真的执行了**——判据是状态条被 JS 改写过。
   初始 HTML 是 `dot muted` + 「连接中…」；只有 `main()` 跑完才会变。
   这条是整份检查里最有价值的一条：`--dump-dom` 拿到的 DOM 与"脚本没跑"长得一样，
   只有"某个由 JS 写入的值变了"才能区分两者；
3. **没有资源 404 / JS 异常**（控制台里的 `blink.mojom` 与 Google 默认应用安装
   是 Chrome 自身的噪音，不是页面的）。

顺手用脚本核了一遍 DOM id：`index.html` 有 23 个 id，`app.mjs` 引用 21 个，
**零缺失**（另两个是纯静态容器）。id 对不上是「页面点了没反应」最常见的原因，
而它会静默失败（`getElementById` 返回 null，`addEventListener` 抛错）。

### 一个「界面在撒谎」的缺陷

上面那个检查第一次跑就抓到一个：**未登录时状态条显示「Hub 不可达」**，
而同一时刻 `/api/identity/status` 刚刚成功返回 200。

根因是 `refreshStatus()` 把结果吞了（`catch { /* 登录页自己会报 */ }`），
于是 `main()` 在末尾一律报不可达。

用户看到「服务器挂了」会去重启服务器，而其实只需要登录。

修法：`deriveConnectionState` 新增 `signedIn`（默认 `true`，既有调用方不必改），
未登录态措辞是「未登录 / Hub 正常；登录后即可查看 Agent 与任务」，`tone` 是
`muted` 而不是 `error`；Hub 真的不可达时仍报不可达。用例里加了一条
**措辞断言**（标签里不许出现「不可达 / 连不上 / 挂了」）。

### 换口令：只能重新引导

Hub **没有改口令的接口**（身份层的未接功能）。`rebootstrap.sh` 是唯一途径，
它刻意**清整库**而不是只删 `hub_users`——只删用户会留下一批悬挂引用
（`hub_devices.user_id`、`hub_space_roles.user_id`、`hub_invites.created_by`），
它们不报错，于是表现为"一切正常"，直到有人问"这台设备是谁的"。
旧库**改名留档不删**。

本轮连带修掉三个"错误被伪装"的坑，都写进了注释：

1. 内联 `node -e` 里 `require()` + 顶层 `await` → `ERR_AMBIGUOUS_MODULE_SYNTAX`，
   而被 `|| echo "登录环节失败"` **伪装成了口令问题**；
2. `handleWrite` 的信封是 `{ ok, task }`，读错层级 → 输出 `{"ok":true}`：
   **看起来像成功、其实什么都没打出来**；
3. 口令文件有两份副本，重建后其中一份是**旧口令** → 报"口令不对"。
   现收敛到 `/etc/legion-hub/` 一处，重建脚本会主动删掉数据目录里的副本。
   （备份口令仍在数据目录——那是**另一件事**，它需要被服务账号读到。）

### 排障实录：公网**间歇性** 404，而部分端点一直正常

症状最容易误导人：同一个 URL 有时 200、有时 404，而 `/api/board` **一直正常**
——于是"服务挂了"被排除，排查方向被带到缓存与网络上去。

根因是**隧道上有两个连接器**：运营者按早期步骤在自己电脑上跑了
`cloudflared.exe service install <token>`，而连接器必须跑在 **Hub 所在那台机器**上
（它转发到 `127.0.0.1:8787`）。PC 上恰好也跑着一个 Legion Hub（**旧构建**），
于是 Cloudflare 把请求轮流送到两边：

| 路径 | PC 的 8787（旧构建） | 服务器的 8787（新构建） |
| --- | --- | --- |
| `/api/identity/status` | 404 | 200 |
| `/mobile/` | 404 | 200 |
| `/api/board` | 200 | 200 |

判别只需在两台机器上各跑一次同一条命令、比状态码：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/identity/status
```

修法是把多余的连接器卸掉（`cloudflared service uninstall`，Windows 需管理员）。
这一条已写进 `product/server/README.md` 的排障一节。

### 三个曾经挡住它的缺口（都已修）

**① 远端路径进不了 `Running`（上下文快照）。**
`BuildingContext → Running` 要求 `run_context_snapshots` 里先有这次 attempt 的一行。
而装配器、来源、仓储全都交付了却**没有生产调用方**——本仓自己的
`scripts/prt/entry-point-reachability.mjs` 把 `createContextStage` 判为 `dead`。
所以这不是远端路径引入的缺口，而是「零件齐全、从没人接线」。

修法：`team-hub/node-context.mjs` 在 **Hub 侧**装配并落库（装配要的数据都在 Hub 的库里），
只收集 Hub 确实有的五类来源（任务 / 目标 / 评论 / 用户反馈 / 产物）；缺席的来源
**不静默消失**（`collectCandidates` 产出"缺失候选"，快照里能读到"本该看团队计划、
但系统里没有"）。三条纪律：快照**先于**派发存在；冻结失败就**不派发**并把租约还回去
（造一条注定完不成的 attempt 比不派发坏得多）；**已冻结过就复用**，不重新装配
（重算会因 `frozenAtMs` 不同得到新哈希，被仓储以 `CONTEXT_SNAPSHOT_CONFLICT` 拒掉）。

**② 一条旧尝试能把整个队列堵死（没有回收器）。**
本机 worker 会自己回收自己的租约——它是长驻进程。**远程节点不是**：它断线/关机后
没有任何人收拾它留下的租约，而那条租约占着**单写者位**，于是所有新任务都领不到
（`claim` 返回 `file-contention`，界面上只是"任务不动"）。实测就是这么卡住的。

修法：`team-hub/node-recovery.mjs` + Hub 侧 30s 后台作业（unref）。一律判成
**"未知结局"**（逾期的远端尝试可能已经推了远端/删了文件/付了款，两条出口里
「可重试」会重复执行）；只结清**确定没人持有**的预约。

**③ 回收器把"已完成待验收"改写成"结果待确认"。**
`IN_FLIGHT_ATTEMPT_STATES` 里既有"正在执行"，也有"执行已结束、在等人"
（`Validating` 等验收、`HandingOff` 等交接、`AwaitingApproval` 等批准）。
对后者而言租约过期**不等于**结果不明——`runResult` 早落库了。而
`recoveryDecision` 在租约过期时一律给 `mark-unknown-outcome`，于是实测中一次
**成功完成**的任务从 `in_review` 掉进了 `blocked`。

一个**已知结果被标成未知**，与未知被标成已知是同一类错误，方向相反而已。
修法：`recoverExpired` 新增**可选** `states` 收窄（默认 `null` = 沿用完整集合，
既有调用方行为一字不变；空数组报错而不是静默"成功地什么都没做"——`IN ()` 在
SQLite 里恒为假），后台回收器只扫真正可能还在电脑上跑的那四个状态。

### 心跳续期曾经是假的（2026-10-05 修）

上面 ③ 收窄了回收器的扫描范围，但**没有**回答"为什么那些尝试会租约过期"——
节点明明每 30 秒都在心跳。查下去是两个叠在一起的问题，合起来的效果是
**"心跳续租"这件事在全部真实执行里都是假的**，而两端日志都显示正常。

**① 租约本身没被续上。** `run-store.heartbeat` 里那句 UPDATE 写死了
`AND state = 'Leased'`，而 `Leased` 只覆盖"已认领、还没开始干活"那一小段。
尝试一走到 `PreparingWorkspace` / `BuildingContext` / `Running`（**每一次真实
执行**都要经过的三个状态），这条 UPDATE 就静默地影响 0 行——**而返回值照样报
一个 `atMs + ttl` 的到期时间**。用一个探针实测（认领 → 推进到 `Running` →
跨过一个心跳间隔后心跳）：

```text
心跳说续到: 22:16:20     库里实际是: 22:15:20     ★ 不一致（心跳在撒谎）
```

后果不是"少续了一次"：认领时写下的 `lease_expires_at_ms` 会照常到点，而
`recoverExpired` 正是按它判定，于是一个**正在电脑上执行的任务**会被判成
`UnknownOutcome`（"结果待确认"）→ 任务掉进 `blocked` 要人对账。
这正是 ③ 那类错误的同一族：一个已知的进行中被读成未知。

掩住它的是这条链的时长——闭环验证里的任务 **4 秒**就跑完了，远在
120 秒租期之前。**只有跑得比租期长的任务才会撞上，而当时的验收全都很短。**

修法：续期只在**真的还持有租约**的状态里发生（改判据为
`isActiveAttemptState(row.state)`，与状态机同一份定义，不另抄一张表）；
终态不再续期但**也不报错**（"报完终态又飞一个心跳"是正常竞态），
改为如实返回库里那个值并置 `renewed: false`——**返回值不许再说一个没写进去的时间**。

**② 预约的寿命与租约脱钩。** 预约在 `claim` 时把 `expires_at_ms` 写死成
`now + leaseMs`，之后**没有任何东西**会去延长它。于是租约是新鲜的、预约已经过期，
而按 `expires_at_ms` 判定的路径会把一个**正在心跳的活任务**读成"进程未确认退出"
（`reconciling`）——一个假的冻结，会让人去查一件根本没发生的事。

修法：`write-intent-store` 新增 `renew`，由 `run-store.heartbeat` 在**同一次事务**里
调用（新端口 `renewWrite`，形状与 `reserveWrite` 对称）。两条纪律：

- **`reconciling` 一律拒绝续期。** 那个状态的含义是"进程是否还活着没人确认"，
  续期等于把它按回 `reserved`，也就抹掉了那次冻结——而正等着看它的人是唯一
  能判断该不该放锁的人。
- **预约层拒绝不让心跳失败**，原样放进应答的 `writeReservation` 字段。
  让心跳失败会让 worker 置 `leaseMayBeLost` 并停手，那是**另一个**读数。

节点侧因此"参与"了预约生命周期：它的心跳驱动续期，Hub 在**同一个事务**里
把租约与预约一起续上。申请与结清仍在 Hub 侧——锁的授予与收回属于调度者。

**修好之后回收器只在"节点真的不心跳了"时才动手**，这也正是它文件头写的用途
（断线 / 关机 / 拔网线）。在此之前，`Running` 里的租约**必然**在 120 秒后过期，
回收器实际是在"到点就判未知"——一条**活着但卡住**的任务与一条**节点已经没了**
的任务，在它眼里是同一个读数。修好之后前者不再被回收，这需要"长时间无进展"
由别的读数表达（陈旧提示、`oldestPendingAgeMs`），而不是靠租约到期来代劳。

网关把 `renewed` 与 `writeReservation` 一起带回 `heartbeat.ack`，
节点日志在两者为否时各留一行——这两条读数此前在**两端都不存在**，
排障时只能看到"一切正常"，而问题在第三处。

用例：`run-store.test.mjs` 侧 5 例（含"跑得比租期长的 Running 尝试不再被判成
结果待确认"，8 个心跳周期后 `recoverExpired` 必须扫不到它；以及"终态之后的心跳
不谎报"）；`write-intent-store.test.mjs` 侧 6 例（含"续期过的不被判过期"与它的
反证——停止续期跨过租期后**必须**被判过期，否则前一条可能只是因为扫描不起作用）。

### 闭环里仍然成立的限制（不是缺陷，是设计）

- **队列按验收串行**：一条交付验收前一直持有写入位，所以下一个任务要等。
  这是"单写者 + 交付需验收"的直接后果，不是排队坏了。
- **远端参与预约生命周期的方式是"心跳"，不是"自己拿锁"**：预约的**申请**
  （`claim` 事务里）与**结清**（尝试进终态时 `onAttemptProjected`）仍然都在 Hub 侧——
  预约是一条跨任务的调度锁，锁的授予与收回属于调度者，不属于被调度者。
  远端参与的是中间那一段：它的心跳现在会**同时续期租约与预约**（同一次事务），
  而不是只续租约。见下「心跳续期曾经是假的」。
- **上下文来源只有五类**：`teamPlan` / `employeeManifest` / 技能与文档没有接，
  它们在快照里以"缺失候选"出现。

## 7. 未决

- 手机通知通道（Web Push 还是第三方推送）尚未确定。设计文档 §8.3 要求「推送只作提醒，Hub 状态为准」，首版可先不做通知，不阻塞其余阶段。
- 保留期具体数值（消息 / 事件 / 附件 / 审计 / 备份）尚未确定。首版沿用仓库既有默认值，需要时按设计文档 §10 单独确认。
- 是否启用透明 DSH Web 管理代理尚未决定。按设计文档 §1.2，它是独立 capability，首版不实现。

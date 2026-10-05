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
- [ ] 阶段 G 服务器真机部署
  - [x] Node 运行时（v24.21.0）、系统用户、数据目录、密钥、systemd 单元
  - [x] Hub 上线并绑回环；`/api/identity/status` 200；无令牌读端点 401；机器令牌 200
  - [x] 云厂商拦截的实测与规避（见下「部署实录」）
  - [x] 云入口改用**公网 IP + 自签 CA**（只开 443）：手机页面公网 200、证书链 OpenSSL 验签 OK
  - [x] 首次初始化（系统管理员）与**电脑配对**（公网 HTTPS 兑换配对码）
  - [x] Node 出站连接、派发、进展回报、阶段上报、出境策略在真实链路上生效
  - [ ] **上下文快照**：远端路径接上下文组装，才能合法进入 `Running`（见下）
  - [ ] 远端 Node 参与**写入预约**生命周期（见下）
  - [ ] 备份与恢复演练

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

### 尚未打通：上下文快照（阻塞 `Running`）

远端尝试目前**到不了 `Running`**。状态机为 `BuildingContext → Running` 声明了
`requiresPersist: ['attempt','contextSnapshot']`，而 `run-store` 的 `EVIDENCE_CHECKS`
**真的核验**它（`run_context_snapshots` 里该 attempt 至少一行）。远端 Node 没有走
上下文组装流程，因此没有快照，Hub 以 `EVIDENCE_MISSING: contextSnapshot` 拒绝。

这不是"绕过一下就好"的事：那张快照有 23 列（含 `final_text`、`snapshot_hash`、
token 计数、候选/纳入/排除计数、`payload_json`），**伪造一行等于把"没人组装过上下文"
写成"组装过了"**——正是本方案一路在避免的那种绿灯。

所以远端路径要接的是**真正的上下文组装**（`assembleContext` / `contextStore` /
来源收集 / 分词器）。已做的两件相关的事：

- **不再死锁**：阶段被 Hub 拒绝时本机**停手**并按 `cancelled` 收尾
  （`BuildingContext → Cancelled` 是合法边）。原实现会照旧跑完执行器，
  而结果永远上报不出去（`BuildingContext → Validating` 没有边），
  于是任务卡住、执行器白跑、副作用已经发生。
- **拒绝在 Hub 侧可见**：网关把被拒的帧写进审计（`node:frame-rejected`），
  此前它只回给 Node，Hub 侧完全看不到。

另外还记录两个已修的接线缺口：

- **写入预约未结清**：`finishTaskReservationInTx` 只在**看板迁移**
  （`in_review`/`done`/`canceled`）时被调用，而 `run-store` 的 `projectToTask` 是
  直接 `UPDATE tasks.status`。于是远端尝试走到终态、看板被投影成 `in_review` 时，
  预约没被结清，下一条任务一直看到 `SINGLE_WRITER_REQUIRED`。
  远端 Node 目前**没有参与预约生命周期**——这是下一件要接的事。
- **认领被阻塞时不可见**：`claim` 在有别的任务占着单写者位时**正常返回**
  `claimed:null, reason:'file-contention'`，原实现直接 `continue`，于是
  "节点就绪、任务待办、但什么都不派发"在日志/审计/读数里全都没有痕迹。
  现在会记 `blockedClaims` 并 warn 一次（同一种阻塞只说一次）。

## 7. 未决

- 手机通知通道（Web Push 还是第三方推送）尚未确定。设计文档 §8.3 要求「推送只作提醒，Hub 状态为准」，首版可先不做通知，不阻塞其余阶段。
- 保留期具体数值（消息 / 事件 / 附件 / 审计 / 备份）尚未确定。首版沿用仓库既有默认值，需要时按设计文档 §10 单独确认。
- 是否启用透明 DSH Web 管理代理尚未决定。按设计文档 §1.2，它是独立 capability，首版不实现。

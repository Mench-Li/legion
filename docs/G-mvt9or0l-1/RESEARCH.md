# T-221 方案研究：账号管理（基础信息与账号信息）—— 选型对比与推荐

> 阶段：**方案搜索（researcher / 探微）**｜任务：**T-221**｜所属目标：**G-mvt9or0l-1**（software · active · chain）
> 上游需求：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-220 产出，冻结 blob sha256=`8e5197be34d40b52ae2ea18ca051a6d78e3a6ad39b4af0c8867358dded9f7c7f`）
> 评估基线：**w/T-221 HEAD `ff36274c017a1a0a4b4f6ef12b7fa9234036f031`（2026-10-29 17:00:25 +0800）**；Node **v24.19.0**（本 worktree 实测，§2.1）
> 下游：T-222（任务拆解）→ T-223（测试用例）→ T-224（编码）→ T-225（审查）→ T-226（测试）→ T-227（部署）
> **边界声明**：本阶段**只做调研与选型对比**——不写实现、不改任何产品代码、不调用 taskctl/看板写接口、不 push。文中所有签名与落点建议都是给 T-222/T-224 的输入，**不是已落地实现**。
> **联网口径（重要）**：本环境 `WebSearch`/`WebFetch` 均被权限层拒绝（返回 “unattended … cannot request human approval”），且任务纪律明确“禁止联网”。因此本文件**不使用任何未核验的外部版本号、星数、下载量或许可证结论**；第三方候选一律标 **[公开·待核]**，只按“架构定位”参与比较，不靠它们下结论。推荐与否决的**全部依据**来自本 worktree 可复读的 file:line 与本仓既有文档（沿用 `docs/RESEARCH.md:15.2` 的 `[公开·待核]` 惯例）。

---

## 0. 结论速览（TL;DR）

**推荐方案 A —— 在既有 identity 栈内做“追加式扩展 + 账号页区块化重组”，零新增运行时依赖。**

一句话依据：本目标要补的是「登录之后我是谁、我能改什么、我在哪些地方登录/连接」，而本仓的登录、会话、改口令、设备、审计、错误码、测试夹具**已经齐备**（§2.2–§2.5）；真正的缺口只有三个——**一个可持久化的 `displayName`、一个只更新本人的写接口、一个把既有能力重排清楚的账号页**（需求 §1.2 F1–F7、F10）。在这三个缺口上引入任何认证/账号框架，都要**替换**现有 HMAC 令牌、scrypt 口令哈希、`hub_user_sessions` 撤销语义和前端多处展示面的身份读取（§2.3、§2.6），代价与风险都远高于收益；而仓库已经提供了**并发安全的补列原语** `ensureColumn`（`team-hub/schema-util.mjs:65-90`）与**两套现成测试夹具**（内存库 / 真实 HTTP，§2.5），正好覆盖这条路的两个主要风险。

| 关键决策 | 推荐 | 主要备选 | 取舍理由（要点） |
| --- | --- | --- | --- |
| **数据落点** | **`hub_users` 追加 `display_name`（P1 再加 `avatar`），走 `ensureColumn`** | 独立 `hub_user_profiles` 表（§4.2 B） | 追加列与现有 `publicUser` 投影同源、读写都在一条记录上；代价是必须修 3 处位置式 `INSERT`（§7.1）。独立表虽不动写入路径，但每次读取都要 JOIN/二次查询，且引入“无 profile 行”的第二种空态。 |
| **接口形态** | **扩展 `GET /api/identity/me`（追加字段）+ 新增 `POST /api/identity/profile`** | 新增聚合端点 `GET /api/identity/account`（§4.2 B） | 需求 §7.3/§7.4 已冻结等价契约；`/me` 是追加式、旧客户端（手机端）只读 `user.userId`/`user.name` 不受影响（`workbench/mobile/app.mjs:230,3019-3029`）。聚合端点会把 identity 与 device 两个 store 耦合到一条路由里，且新增一份“账号快照”口径，收益（省一次 GET）不足。 |
| **会话/设备计数** | **前端组合：`/me` + `/sessions` + `/devices` 三路 `Promise.allSettled`，设备按 `userId` 过滤本人** | 服务端聚合计数 | R-01/R-09 要求“区块独立错误态”；三路独立读取天然满足，且任一失败不清空其它。设备接口对系统管理员返回全部设备（`routes/identity.mjs:585-592`），计数必须按 `userId` 过滤，不能直接 `length`（§7.7）。 |
| **显示名校验** | **自研共享纯函数**（trim、1–64 UTF-16、拒绝 C0/换行、未知字段白名单） | `zod` / `valibot`（§4.5 E） | 规则只有 4 条、服务端与前端各一份；现有 `validateName` 只查空与长度、**不查控制字符**（`user-store.mjs:153-158`），不能直接复用。引入校验库为 4 条规则增加一条供应链与一个构建面，不划算。 |
| **UI 结构** | **`AccountPanel` 作为容器 + 区块组件；`DevicePanel` 保留并接收数据/刷新回调** | 引入组件库/设计系统（§4.5 E） | workbench 是手写 CSS + 5 个运行时依赖（`workbench/package.json:17-22`），没有 Tailwind/Radix/表单库；账号页只有一个可编辑字段与两组列表，引入设计系统等于为一张表单做样式迁移。 |
| **身份底座** | **保留现有自托管 identity（HMAC 访问令牌 + 可撤销会话 + scrypt）** | 开源认证库 / 外置 IdP（§4.3 C、§4.4 D） | 现有令牌/Session 语义被手机端、桌面、Agent 网关、SSE 票据共同消费（§2.3）；换底座=迁移用户表+失效全部会话+新依赖+新部署单元，且违反 `docs/DEPLOY.md:49` 的“零新增运行时依赖”。仓库已有同类否决先例：整机聊天平台因“独立认证体系、与 team-hub 数据模型不融合”被排除（`docs/RESEARCH.md:952`）。 |
| **P1 头像** | **独立 `hub_users.avatar` 存 `human:<key>` 令牌，白名单=现有位面表 40 键；不做上传、不写 `roster`** | 头像上传 / 复用 roster 头像（§5、§7.8） | 仓库已有 `human:<key>` 令牌与 40 个位面（`workbench/src/avatar/slots.ts:13-36`、`team-hub/agent-avatars.mjs:7-25`），且已有“两端逐项 parity”测试范式（`workbench/scripts/external-avatar-parity.test.mjs:1-30`）；上传需要文件存储与清理，roster 头像是“岗位/Agent”的身份，不是人类账号的。 |

---

## 1. 研究方法与证据分级

| 级别 | 含义 | 本文件用法 |
| --- | --- | --- |
| **A（本地实测）** | 本 worktree 可复读的 file:line、命令输出、测试夹具形态 | 现状基线、可复用基座、迁移原语、测试成本、全部推荐理由 |
| **B/C（外部官方文档 / 注册表元数据）** | 官方文档语义、npm/GitHub 元数据 | **本环境不可用**：联网工具被权限拒绝，且纪律禁止联网。仅保留 “待核” 清单与复核方法（§10.2） |
| **D（厂商自述）** | 对比页/营销表述 | 本文件不引用 |

方法：
1. 逐条读上游 REQUIREMENTS.md 的 R-01–R-14、§7 契约、§9 AC、§10 风险与 §11 假设，抽出“留给方案阶段”的开放点：数据落点、接口形态、校验实现、UI 结构、身份底座、P1 头像。
2. 在本 worktree 只读实测：schema/INSERT/投影、路由与鉴权、前端 API 与 401 恢复、Toast/ARIA、CSS、测试夹具、部署约束。
3. 对每个候选只比较**架构适配度、迁移成本、回归风险、测试成本、依赖影响**；外部候选的版本/许可/维护度**不填未核验数字**。
4. 把无法在本环境证明的项（SQLite 位置式 INSERT 语义、外部库许可/维护、真实浏览器渲染）明确列为风险（§9），交给 T-224/T-226 实测。
5. 所有结论都落到“下游可直接切片”的粒度（§8）。

---

## 2. 现状基线实测（A 级）

### 2.1 版本、基线与上游哈希核对

| 项 | 实测值 | 命令/证据 |
| --- | --- | --- |
| 评估基线 HEAD | `ff36274c017a1a0a4b4f6ef12b7fa9234036f031`（2026-10-29 17:00:25 +0800） | `git log -1 --format=%H%x20%ci` |
| Node | v24.19.0 | `node --version` |
| 工作区状态 | `git status --short` 无输出（干净） | 同上 |
| 上游 REQUIREMENTS 真实性 | 上游提交 `fe163283` 中的 blob sha256 = `8e5197be…9f7c7f`，与派工登记一致 | `git show fe163283:docs/G-mvt9or0l-1/REQUIREMENTS.md` 的输出再做 `sha256sum` |
| 工作区文件哈希差异说明 | 工作区文件（CRLF）sha256=`f9cd9241…eab6`，**不是**内容被改：`core.autocrlf=true` 在 checkout 时把 LF 转成 CRLF | `git config --get core.autocrlf`；blob 哈希与登记值一致 |
| workbench 依赖是否安装 | **已安装**（`workbench/node_modules` 存在）；本阶段不需要构建 | `test -d workbench/node_modules` |

> 哈希结论：**上游交接版本未被替换**。差异只来自 Windows 换行转换；git blob 与派工登记逐字节一致。
>
> **门禁说明**：`node scripts/ci/check-docs.mjs` 在本环境被权限层拒绝（unattended approval），未能执行；该脚本的语义检查对象是 `README.md`/`docs/FEATURES.md`，本文件不在其语义范围。已手工核对本文件所有表格行均以 `|` 收尾（脚本的第 11 项结构规则）。

### 2.2 数据面：`hub_users` 的现状与迁移原语

| 项 | 实测 | 证据 |
| --- | --- | --- |
| 用户表结构 | `hub_users(id, name, name_key, password_hash, created_at_ms, disabled_at_ms, system_role)`；**没有** `display_name`/`avatar` | `team-hub/user-store.mjs:239-243` |
| 建表方式 | `CREATE TABLE IF NOT EXISTS`，只在**新库**生效；老库不会自动加列 | `user-store.mjs:239-309` |
| 位置式 INSERT（3 处） | `INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)` —— 引导 owner、接受邀请、自助注册 | `user-store.mjs:358`、`:409`、`:1088` |
| 读取 | 多处 `SELECT * FROM hub_users`，行对象会自动带上新列 | `user-store.mjs:322`、`:802`、`:1232` |
| 本人/管理投影 | `publicUser(row)` 已包含 `userId/name/createdAt/disabled/systemRole`，但只被管理员 `listUsers` 使用 | `user-store.mjs:327-332`、`:1231-1236` |
| 补列原语 | `ensureColumn(db, table, column, ddl)`：`BEGIN IMMEDIATE` 内重读再 ALTER，**跨进程并发安全、幂等**；已在 approval/automation/budget/compaction 等多处使用 | `team-hub/schema-util.mjs:36-90`；用例 `approval-binding.test.mjs:537-545` 明令“补列不许绕过 ensureColumn” |
| 列命名先例 | 其他 store 用 `display_name` 列 + camelCase 投影（如 `context-plan-store.mjs:111,225`） | 同类口径可直接沿用 |
| 审计 | `record(action, scope, detail, actor)`；**审计失败被吞掉**（设计如此：“审计失败不阻断认证”） | `user-store.mjs:311-314` |
| 口令/令牌边界 | scrypt 哈希格式、HMAC 访问令牌、刷新令牌轮换、撤销即时生效 | `user-store.mjs:183-211`、`:837-900` |
| 停用语义 | 刷新与访问令牌校验都拒绝停用账号（`SESSION_REVOKED`） | `user-store.mjs:850`、`:898` |

> 迁移要点：**加列本身简单，真正要改的是 3 处位置式 INSERT**。SQLite 的 `INSERT INTO t VALUES(...)` 按语言规范要求“值的个数 = 表的列数”；这一点本环境未能执行 SQLite 实测（`node -e` 被权限拒绝），列为 T-224 的**第一个验证点**（RK-M1）。无论结论如何，**改成显式列名**都能同时兼容“新库（建表含新列）”与“老库（ensureColumn 补列）”，建议直接按显式列名落地。

### 2.3 接口面：现有契约与鉴权

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 路由形状 | 自研路由表 `{ method, path, run }`，**没有 Express**；依赖由 `server.mjs` 注入 | `routes/identity.mjs:277-671`；`server.mjs:9285` |
| 用户鉴权 | `withUser` 从 `Authorization: Bearer` 解析用户令牌；失败直接写 `{ok:false,code,error}` | `routes/identity.mjs:239-265` |
| `GET /api/identity/me` | 只回 `user{userId,name}`、`roles`、`systemRole`；**没有** displayName/avatar/createdAt/disabled | `routes/identity.mjs:399-407` |
| 会话列表 | 返回**全部**会话（含 revoked），带 `occupied/revoked` 标志与 `currentSessionId`；按创建时间倒序 | `routes/identity.mjs:410-414`；`user-store.mjs:943-955` |
| 改口令 | 要当前口令；成功后撤销**其它**会话、保留当前会话 | `routes/identity.mjs:417-433`；`user-store.mjs:1179-1202` |
| 会话撤销 | 只能撤自己的；管理员例外；服务端强制 | `routes/identity.mjs:436-451` |
| 管理员用户 | `GET /users` 需系统管理员；`POST /users/disable` 需系统管理员 | `routes/identity.mjs:500-518` |
| 设备 | `GET /api/devices`：**管理员看全部、普通用户只看自己**；行内含 `userId` | `routes/identity.mjs:585-592`；`device-store.mjs:205-214` |
| 错误形状 | 统一 `{ok:false, code, error}`；`errorResponse` 把仓储异常映射为 HTTP | `routes/identity.mjs:31-35` |
| 参数辅助 | `requireString` 缺参数时抛 **`MISSING_PARAM`**（不是 `IDENTITY_INVALID_INPUT`）；非法 JSON 被 `readBody` 变成普通 `Error` → `IDENTITY_REQUEST_FAILED` | `server.mjs:7706-7716`、`:7793-7799`；`routes/identity.mjs:31-35` |

> 结论：新资料接口**不能直接套 `requireString`**，否则错误码与 R-08 不一致；需要在路由内做“对象 + 白名单 + 具名 `IDENTITY_INVALID_INPUT`”的独立校验（§7.2）。

### 2.4 前端面：类型、面板、401 恢复与无障碍

| 项 | 现状 | 证据 |
| --- | --- | --- |
| `MeInfo` | `{userId,name,roles,systemRole}`，无 displayName/avatar/createdAt/status | `workbench/src/identity.ts:57-62` |
| `fetchMe` | 直接 `getJson`，**没有** 401 恢复 | `identity.ts:281-289` |
| 401 恢复 | `recoverSession()` 单飞刷新存在；但只有 `api.ts` 的 `fetchWithSessionRetry` 调用它，**identity.ts 自身不调用** | `identity.ts:262-279`；`api.ts:73-89` |
| 账号面板 | 单文件 222 行：账号摘要/改口令/会话/管理员重置/邀请；读取只 `Promise.all(fetchMe,listSessions)`，非管理员不读 `/users` | `AccountPanel.tsx:34-63`、`:116-221` |
| 设备面板 | 自读 `listDevices()`、自管配对/撤销/换令牌；`DeviceRow` **类型未含 `userId`**（服务端实际返回） | `DevicePanel.tsx:35-54`；`identity.ts:388-402`；`device-store.mjs:208` |
| 页面挂载 | `settings-connections` 内并列 `AccountPanel` + `DevicePanel` + 中枢地址/令牌 | `WorkspaceSettings.tsx:21-24` |
| Toast | 模块级 `toast()` + `ToastHost`；**没有** `role="status"` / `aria-live` | `Toast.tsx:21-56` |
| 本机模式 | `hasSession()` 为假时整块不渲染（AccountPanel/DevicePanel 各自判断） | `AccountPanel.tsx:45,65-66`；`DevicePanel.tsx:42,53-54` |
| 手机端 `/me` 消费者 | 只读 `user.name`/`user.userId`；注释把 `name` 说成“显示名、可以改”（与当前“用户名不可改”口径**漂移**） | `workbench/mobile/app.mjs:230-240`、`:1418`、`:3019-3029` |
| CSS | `settings-card`/`settings-session-row`/`settings-runtime-status` 已存在；样式新增建议落 `index.css`（`workspace.css` 是压缩长行文件） | `index.css:3744-3759`；`docs/RESEARCH.md:108` 的口径同样适用 |

### 2.5 测试基座：两种夹具都已存在

| 范式 | 形态 | 证据 |
| --- | --- | --- |
| 仓储单测 | `new DatabaseSync(':memory:')` + 自造 `withTx` + 可选 audit 记录 | `team-hub/user-store.test.mjs:26-63` |
| 真实 HTTP 端到端 | 临时 `TEAM_HUB_DB` + `import server.mjs` + `listen(0)` + `fetch` | `team-hub/identity-remote.test.mjs:1-32`；`identity-registration.test.mjs:150-210` |
| 前端纯逻辑/结构测试 | 无 jsdom；用 `node --test` 读源码断言 + `react-dom/server` 渲染断言 | `workbench/scripts/identity-gate.test.mjs:1-14`；`doc-render.test.mjs` |
| 两端 parity | `ts.transpileModule` 直跑 TS 源码，逐项 `deepEqual`（零新增依赖） | `workbench/scripts/external-avatar-parity.test.mjs:1-30` |

> 结论：本目标的测试**不需要新增测试框架或依赖**；服务端可复用两套夹具，前端可复用纯函数 + 源码扫描 + SSR。

### 2.6 硬约束（选型的红线）

| 约束 | 出处 | 对选型的影响 |
| --- | --- | --- |
| **零新增运行时依赖 / 零新增构建步骤** | `docs/DEPLOY.md:49`；需求 §5.2、R-10；`workbench/package.json:17-22` 只有 5 个运行时依赖 | 任何认证库、表单库、UI 库默认**不采纳**；必须由将军书面放行 |
| 禁止联网下载依赖 | LEGION.md（派工注入）；`docs/RESEARCH.md:15.2` | 本阶段与实现阶段都不能 `npm/pnpm install`；外部候选只能“待核” |
| 单机/本地优先、SQLite 单文件 | `docs/DEPLOY.md:49,68`；README.md:3 | 外置 IdP、独立认证服务与部署形态冲突 |
| 账号管理留在桌面/网页端 | `docs/G-mvgf01af-4/REQUIREMENTS.md:168`；需求 A6 | 手机端不加“我的”页；`/me` 只做追加式兼容 |
| 成员（Agent）名称/头像不得混用 | 需求 §3、R-11；`team-hub/agent-avatars.mjs:1-25`；`workbench/src/avatar/slots.ts:1-9` | 账号资料必须用独立字段；不得写 `roster`、不得复用 roster 照片作为账号头像 |
| 错误码必须具名、前端按 code 分支 | `routes/identity.mjs:17-20`；需求 R-08 | 新接口不能用 `MISSING_PARAM`/`IDENTITY_REQUEST_FAILED` 冒充 `IDENTITY_INVALID_INPUT` |

---

## 3. 需求要点 → 方案决策映射

| 需求 | 方案阶段必须回答的问题 | 本文件落点 |
| --- | --- | --- |
| R-01 信息架构 | 账号页怎么分区、`DevicePanel` 放哪、管理员区怎么隔离 | §7.6 |
| R-02 显示名 | 存哪、怎么回退、怎么校验、怎么保存 | §7.1–§7.4 |
| R-03 账号信息总览 | 字段从哪来、计数口径、失败怎么显示 | §7.5、§7.7 |
| R-04/R-05/R-06 既有安全能力 | 重组后语义是否改变 | §7.6（只重排，不改语义） |
| R-07 权限边界 | 新接口如何只作用于本人 | §7.2、§7.4 |
| R-08 校验与错误契约 | 用什么校验、错误码怎么统一 | §7.2 |
| R-09 加载/空/错误/无障碍 | 401 恢复、独立错误态、aria-live | §7.5、§7.6、§9 |
| R-10 回归与兼容 | `/me` 追加式、旧客户端、零依赖 | §7.3、§7.9 |
| R-11 头像（P1） | 令牌集合、存储、白名单、parity | §7.8 |
| R-12 显示名传播（P1） | 哪些面替换、哪些面不动 | §7.8 |
| R-13 最近登录（P1） | 数据来源、状态口径 | §7.8 |
| R-14 后续候选（P2） | 不挤占 P0/P1 | §5、§8 |

---

## 4. 候选方案

### 4.1 方案 A（推荐）：现有 identity 栈内“追加式扩展 + 区块化重组”

**形态**：
1. **数据**：`hub_users` 追加 `display_name TEXT`（可空；读取时 `trim() || name` 回退），P1 追加 `avatar TEXT`（空 = 默认占位）。走 `ensureColumn`；同时把 3 处位置式 `INSERT` 改为显式列名（`user-store.mjs:358,409,1088`）。
2. **接口**：`GET /api/identity/me` 追加 `displayName/avatar/createdAt/disabled`（旧字段不变）；新增 `POST /api/identity/profile`（只收 `displayName`，P1 加 `avatar`）；错误统一走 `IdentityError` + `IDENTITY_INVALID_INPUT`。
3. **前端**：扩展 `MeInfo` 与 `fetchMe`，新增 `updateProfile`；`AccountPanel` 变成容器（三路 `allSettled` + 分区错误 + 401 恢复），内部按 R-01 顺序渲染摘要/基础信息/账号信息/账号安全/登录中的设备/执行设备/管理员；`DevicePanel` 保留动作能力，数据可由容器传入。
4. **校验**：服务端 `validateDisplayName` 与前端 `workbench/src/accountProfile.ts` 共享同一套规则（两份实现 + 边界测试，口径以服务端为准）。
5. **零依赖**：不新增 package.json 条目、不新增构建步骤。

**优点**：
- 与现有令牌/会话/审计/设备语义**零冲突**；手机端、Agent 网关、SSE 票据的既有消费者不需要改（§2.3、§2.4）。
- 迁移面最小：一条 `ALTER TABLE` + 3 处 INSERT 改写 + 1 个投影函数；`ensureColumn` 已经处理双进程并发（`schema-util.mjs:5-28`）。
- 测试基座现成：内存库 / 真实 HTTP / 纯函数 / 源码扫描（§2.5），不需要新框架。
- 可回滚：新列可空，旧代码 `SELECT *` 不受影响；回退时忽略新字段即可。

**缺点 / 成本**：
- `AccountPanel` 会从 222 行增长到约 350–450 行；若不拆分组件，维护性下降（建议拆分，§7.6）。
- 三路读取（me/sessions/devices）在账号页首屏有 3 个请求；用 `allSettled` 并行，成本可忽略，但“设备计数”必须过滤本人（§7.7）。
- 审计严格性需要单独处理：现有 `record` 吞掉审计失败，无法满足 R-08 “资料已改但审计未写” 的字面要求（§7.4）。

**风险**：迁移 INSERT 未同步 → 注册/邀请/引导路径全挂（高影响、易被测试抓到）；显示名与用户名混淆（UI 标签必须并列）；XSS（React 纯文本渲染 + 服务端控制字符校验）。

**适用前提**：R-01–R-10 的 P0 范围不变；P1 头像使用现有 `human:<key>` 位面表。

---

### 4.2 方案 B：独立 `hub_user_profiles` 表 + 聚合端点 `GET /api/identity/account`

**形态**：新建 `hub_user_profiles(user_id PK, display_name, avatar, updated_at_ms)`；`publicUser`/`listUsers`/`/me` 通过 LEFT JOIN 取资料（无行回退用户名）；新增一个聚合端点一次返回 `user + counts`。

**优点**：
- **完全不动** `hub_users` 的 3 处位置式 INSERT，注册/邀请/引导路径的回归面最小。
- 资料域与认证域在表级分离，未来加“个人简介/偏好”不会继续膨胀用户表。
- 聚合端点少一次往返，且计数口径集中在服务端。

**缺点 / 成本**：
- 每次读取用户投影都要 JOIN 或二次查询；`publicUser` 从纯函数变成“需要查库”，`listUsers` 的 N+1 风险需要显式 JOIN 控制。
- 新增表 + 新端点 + 新 DTO + 新测试；比 A 多约 1 个模块与 1 份契约。
- 聚合端点需要 `identity` 路由同时拿 `userStore` 与 `deviceStore`（当前两者都已注入，技术上可行），但把“设备”耦合进“身份”路由，违反现有“身份只认用户令牌、设备是另一域”的分层（`routes/identity.mjs:7-15`）。
- 旧数据没有 profile 行 → 第二种空态（“没资料” vs “资料为空”）容易在 UI 上分不清。

**结论**：**备选，不推荐作为 v1**。只有在 T-225 明确反对“在 `hub_users` 上改 INSERT”时才切换；切换成本约 +1 个服务端模块 + 1 个聚合端点 + JOIN 投影测试。

---

### 4.3 方案 C：引入开源认证/账号框架接管身份与账号管理

**候选定位（仅按架构角色列出，版本/许可/维护状态 [公开·待核]）**：
- Better Auth / Auth.js（NextAuth）一类：TS 优先、自带 `user/session/account` 模型、admin/profile 插件；
- Lucia / Passport.js 一类：会话库或 Express 中间件，负责认证策略，不含账号页；
- 共同点：它们提供的是**一整套用户/会话/账号表与令牌模型**，而不是“给现有用户表加一个显示名”。

**优点（典型能力，[公开·待核]）**：成熟的安全默认值、内置 OAuth/邮箱验证/2FA/管理插件；长期看可减少自研安全代码。

**缺点 / 成本 / 风险（全部可在本仓核对）**：
1. **替换而不是扩展**：现有访问令牌是自研 `v1.<payload>.<HMAC>`、刷新令牌轮换、`hub_user_sessions` 撤销即时生效（`user-store.mjs:837-900`）；手机端、桌面、Agent 网关、SSE 票据都依赖这套语义（§2.3）。换库意味着**迁移用户表 + 失效全部会话**，并把移动端/桌面端的令牌读取全部重写。
2. **依赖与构建面**：team-hub 目前**没有运行时 dependencies**（只有 peerDependencies，`team-hub/package.json:13-16`）；workbench 只有 5 个运行时依赖。引入任何一个认证库都会破坏 `docs/DEPLOY.md:49` 的“零新增运行时依赖”。
3. **部署形态冲突**：部分方案需要独立服务或特定框架运行时（Next.js/Express），而本仓是自研 `{method,path,run}` 路由（`routes/identity.mjs:277`）。
4. **收益错配**：本目标只做“显示名 + 只读总览 + 既有安全能力重排”，不需要 OAuth/2FA/邮箱验证（需求 §5.2 明确不做）；为一个 `displayName` 换掉整套认证，属于**用平台级方案解决字段级缺口**。
5. **许可/维护未知**：本环境不能联网核验任何候选的 SPDX 许可、最近发布、issue 状态；按仓库纪律不能据此选型。

**结论**：**否决（v1）**。若未来要做 OAuth/SSO/2FA/多账号切换（R-14），再单独立项做“认证底座替换”专题；届时必须走 `[公开·待核]` 复核 + 将军放行 + 迁移演练。

---

### 4.4 方案 D：外置 IdP（Keycloak / Ory Kratos / SuperTokens 一类）

**优点（典型能力，[公开·待核]）**：企业级 SSO、集中用户目录、成熟的管理界面。

**缺点 / 风险**：
- 新增一个**独立服务/容器**与一套运维（备份、升级、TLS、端口），与“本地优先、单机三件套、SQLite 单文件”的部署形态冲突（`docs/DEPLOY.md:49,68`）。
- 账号数据不再完全在 `team.db` 内，空间角色、审计 actor、任务归属都要做身份映射；迁移面远大于本目标。
- 仓库已有同类否决先例：整机聊天平台因“独立服务 + 独立认证体系，与 team-hub 数据模型/审计/scope 完全不融合”被排除（`docs/RESEARCH.md:952`）；“云/SaaS/重平台”在 `docs/RESEARCH.md:1083` 也被列为风险并排除。

**结论**：**否决（本目标）**。R-14 的 OAuth/SSO 若立项，再评估“外置 IdP vs 自研 OIDC 客户端”。

---

### 4.5 方案 E：只引入轻量校验/表单/UI 依赖（zod / valibot / react-hook-form / Radix 一类）

**优点**：声明式校验、可访问性原语、表单状态管理，减少手写样板。

**缺点 / 成本**：
- 规则只有 4 条（trim、1–64 UTF-16、拒绝 C0/换行、未知字段白名单）；自研纯函数约 20 行，且必须能被 `node --test` 直接覆盖（§2.5）。引入库后仍要写同样的业务规则与中文错误映射。
- workbench/team-hub **本地都没有**这些包：按 `node_modules/<pkg>` 计数，`workbench/package-lock.json` 与 `workbench/pnpm-lock.yaml` 对 zod/valibot/react-hook-form/@radix-ui/tailwindcss 的命中均为 **0**。唯一可查的 zod 在 **desktop/payload** 的依赖树里（v4.6.5，`license: MIT`，`desktop/payload/package-lock.json:8593-8600`；同组另有 `zod-to-json-schema`），但那是 Electron payload 的依赖，**不是** workbench/team-hub 的依赖；要在这里用仍然是一次新增依赖 + 新增构建面。
- UI 库需要样式体系迁移：workbench 是手写 CSS（`index.css` 已有一套 settings 类），没有 Tailwind；为一张表单引入设计系统不划算。

**结论**：**否决（v1）**。把“可访问性/校验规则”作为**实现约定**写进 T-224（label、`aria-live`、纯函数测试），而不是引入依赖。若未来账号页扩展成多表单/多步骤，再评估。

---

### 4.6 候选横向对比矩阵

| 维度 | A：内联扩展（推荐） | B：独立表 + 聚合端点 | C：开源认证框架 | D：外置 IdP | E：轻量校验/UI 依赖 |
| --- | --- | --- | --- | --- | --- |
| 覆盖 R-01–R-10 | ✅ 全部 | ✅ 全部 | ⚠️ 需重写契约 | ⚠️ 需重写契约 | ✅（仅校验/UI 部分） |
| 新增运行时依赖 | **0** | **0** | 多个 + 构建面 | 0（但是独立服务） | 1–N 个 |
| 迁移风险 | 低–中（3 处 INSERT） | 低（不动 INSERT） | **高**（用户/会话表迁移） | **高**（身份映射） | 低（但供应链新增） |
| 会话/令牌兼容 | ✅ 原样 | ✅ 原样 | ❌ 需替换 | ❌ 需替换 | ✅ |
| 测试成本 | 低（夹具现成） | 中（JOIN/聚合） | 高（双栈/迁移） | 高（集成环境） | 中（新库行为） |
| 实施成本 | 低–中 | 中 | 高 | 很高 | 低（局部）但收益低 |
| 长期维护 | 自持，随仓库演进 | 自持，多一张表 | 跟上游大版本 | 跟上游产品 | 跟上游版本 |
| 许可/供应链 | **无新增** | **无新增** | [公开·待核] | [公开·待核] | zod 本地可查 MIT（desktop payload）；其余 [待核] |
| 与本地优先/单机形态 | ✅ | ✅ | ⚠️ 部分方案需框架/服务 | ❌ | ✅ |
| 综合 | **推荐** | 备选 | 否决 | 否决 | 否决 |

---

## 5. 评估后否决 / 降级的候选（避免“潮流方案”）

| 候选 | 否决/降级理由（本地可查） |
| --- | --- |
| **把资料塞进 `hub_users` 的 JSON 列** | 依然要 ALTER TABLE → 依然要改 3 处位置式 INSERT；却把“显示名”变成不可索引/不可 SQL 断言的 JSON，校验与查询都更差。无收益。 |
| **把资料放进 `roster`/Agent 域** | `roster.avatar` 是“岗位/Agent”的身份（`team-hub/agent-avatars.mjs:1-25`；`slots.ts:1-9`），且需求 R-11/§3 明令不得混用。 |
| **扩展 `/me` 返回会话数/设备数** | `/me` 被手机端登录握手与首屏调用（`mobile/app.mjs:3019-3029`）；把设备/会话查询塞进去，会让每次 `/me` 多两次 DB 读，并把 identity 与 device 两个域耦合。R-03 的计数更适合前端组合（§7.7）。 |
| **服务端新增“账号快照”缓存** | 账号资料低频读，缓存只会引入“改了显示名但快照没刷”的第二真相；现有 `SELECT *` + 投影足够快。 |
| **头像上传 / 裁剪 / 图片存储** | 需求 §5.2 明确不做；需要文件存储、尺寸校验、清理与安全设计，另立目标。 |
| **复用 roster 的照片头像作为账号头像** | 照片是“岗位/成员”的资产（`docs/FEATURES.md:77-83`），不是当前登录人的；复用会让“换岗位=换脸”。P1 默认用 `human:<key>` 位面令牌或显示名首字占位。 |
| **用 emoji 作为账号头像** | T-195 已明确淘汰 emoji（`docs/G-mv1s6y49-1/RESEARCH.md:19,217`；`team-hub/agent-avatars.mjs:5-6`）；账号头像不得回退到 emoji。 |
| **为账号页引入 Tailwind/Radix/shadcn** | workbench 无 Tailwind/Radix 本地包（§4.5），且现有 `settings-*` CSS 已覆盖布局；为一张表单迁移样式体系成本远大于收益。 |
| **把账号页做成独立路由/独立前端应用** | 需求 A9 要求路由 id `settings-connections` 不变、旧链接不失效（`WorkspaceSettings.tsx:21`）；独立路由会增加一套导航与鉴权入口。 |

---

## 6. 新引入技术 / 依赖逐项影响（许可 · 维护 · 学习成本 · 生态）

### 6.1 方案 A 实际引入的“技术”（第三方依赖 = 0）

| 引入项 | 许可 | 维护 | 学习成本 | 生态/风险 |
| --- | --- | --- | --- | --- |
| `ensureColumn` + `ALTER TABLE ADD COLUMN`（仓库既有原语） | 自有代码，无第三方许可 | 自持；已有并发/幂等测试 | 低（`schema-util.mjs:65-90` 有完整注释与先例） | 风险是 3 处位置式 INSERT 未同步（RK-M1） |
| 新 HTTP 路由 `POST /api/identity/profile`（既有自研路由） | 自有代码 | 自持 | 低（仿 `routes/identity.mjs:417-433`） | 无供应链 |
| 共享校验纯函数（服务端 + 前端） | 自有代码 | 自持 | 低（4 条规则 + 边界测试） | 两份实现需用同一批用例锁定 |
| React 19 受控表单 + `aria-live` | 仓库既有依赖（`docs/RESEARCH.md:820` 记录为 MIT，产线已有；[公开·待核]） | 跟随 React 版本 | 低（现有面板已是受控输入） | 无新增依赖；需补 `ToastHost` 的 `role/aria-live`（`Toast.tsx:39-54`） |
| `node:sqlite` / `node:test` | Node.js 内置（Node ≥ 22.5；`docs/DEPLOY.md:49`） | 跟随 Node LTS | 低（夹具已存在） | 无供应链 |
| P1：`human:<key>` 位面令牌 + 40 键白名单 | 自有资产/代码（`slots.ts:13-36`） | 自持；已有 parity 范式 | 低 | 服务端需要一份 40 键集合，必须与 `slots.ts` 做 parity（RK-P1） |

> **结论：方案 A 的运行时依赖增量 = 0，构建步骤增量 = 0**，符合 `docs/DEPLOY.md:49` 与需求 R-10/§5.2。

### 6.2 被否决依赖的逐项影响（若未来将军放行，需先复核）

| 依赖（仅按定位） | 许可 | 维护 | 学习成本 | 生态 | 本目标结论 |
| --- | --- | --- | --- | --- | --- |
| Better Auth / Auth.js / Lucia / Passport.js 一类 | **[公开·待核]** | **[公开·待核]**（无法联网核验发布节奏/issue） | 中–高（会话模型/框架适配/迁移） | 广，但与本仓自研令牌/路由不契合 | 否决（§4.3） |
| Keycloak / Ory Kratos / SuperTokens 一类 | **[公开·待核]** | **[公开·待核]** | 高（独立服务/运维/身份映射） | 企业级，但与单机 SQLite 冲突 | 否决（§4.4） |
| `zod` | **MIT**（本地 lockfile 可查：`desktop/payload/package-lock.json:8593-8600`，v4.6.5） | 上游活跃度 **[公开·待核]** | 低–中（schema/错误映射） | 广（但 workbench/team-hub 当前为 0 依赖） | 否决（§4.5） |
| `valibot` / `react-hook-form` / Radix / Tailwind | **[公开·待核]** | **[公开·待核]** | 低–中 | 广 | 否决（§4.5） |

> 合规红线：若任何外部依赖被放行，落地前必须做 **SPDX 许可复核 + 锁文件钉版本 + SBOM 登记**（仓库已有 `legion/sbom@1` 机制，`docs/STATUS.md:735`），并在 `TASK_BREAKDOWN.md` 记录“为什么值得破坏零依赖纪律”。

---

## 7. 推荐方案的可落地设计（给 T-222 / T-224 的输入，不是实现）

### 7.1 数据模型与迁移（D1 决策：追加列）

**建议列**：

| 列 | 类型 | 默认/回退 | 语义 |
| --- | --- | --- | --- |
| `display_name` | `TEXT`（可空） | 读投影：trim 后为空则回退 `name` | 展示名；非唯一；不参与认证 |
| `avatar`（P1） | `TEXT`（可空） | 读投影：`''` | `human:<key>` 令牌；空 = 默认占位 |

**迁移顺序（必须按此顺序）**：
1. `CREATE TABLE IF NOT EXISTS hub_users(...)` 的建表语句**加上**新列（新库直接正确）；
2. `ensureColumn(db, 'hub_users', 'display_name', 'TEXT')`（老库补列，幂等/并发安全，`schema-util.mjs:65-90`）；
3. 把 3 处 `INSERT INTO hub_users VALUES(...)` 改为**显式列名**（`user-store.mjs:358,409,1088`）；
4. 投影函数：
   - `publicUser(row)` 追加 `displayName`、`avatar`（旧字段一个不改）；
   - 新增 `selfUser(row)` 或直接复用 `publicUser`（`/me` 需要 `createdAt/disabled`，`publicUser` 已有，`user-store.mjs:327-332`）。
5. 旧数据：无 `display_name` → 回退 `name`；无 `avatar` → `''`。**不迁移、不猜测、不写回**。

**不建议**：给 `display_name` 加 `NOT NULL`（老库 `ALTER TABLE` 的默认值/回填规则更容易踩坑）；用 `NOT NULL DEFAULT ''` 也行，但投影仍要做 `|| name` 回退。

### 7.2 服务端校验与错误契约（R-02 / R-08）

**显示名校验（服务端为准）**：
- 输入必须是 `string`；
- **先**对原始值检查 C0 控制字符（U+0000–U+001F、U+007F，含换行），命中即 `IDENTITY_INVALID_INPUT`（避免“`"a\n"` 被 trim 后放行”的漏洞）；
- 再 `trim()`；trim 后长度 **1–64**（`String.length`，UTF-16 code unit，与用户名校验口径一致，`user-store.mjs:153-158`）；
- 不要求唯一；不写回 `name`；纯文本渲染。

**请求体策略**：
- 必须是**普通对象**（拒绝 `null`、数组、非 JSON）；
- **未知字段拒绝**：允许键集合 = `{displayName}`（P1 加 `avatar`）；出现 `userId`/`name`/`nameKey`/`password` 等 → `IDENTITY_INVALID_INPUT`；
- 缺 `displayName` → `IDENTITY_INVALID_INPUT`；
- 不使用 `requireString`（它抛 `MISSING_PARAM`，与 R-08 不一致，`server.mjs:7793-7799`）；
- `readBody` 的非法 JSON 会变成普通 `Error`（`server.mjs:7706-7716`），新路由需要捕获并映射为 `IDENTITY_INVALID_INPUT`。

**错误码映射**：`IDENTITY_INVALID_INPUT`（400）、`IDENTITY_TOKEN_MISSING`/`MALFORMED`/`BAD_SIGNATURE`/`EXPIRED`/`SESSION_REVOKED`（401）、`IDENTITY_FORBIDDEN`（403）、`IDENTITY_USER_NOT_FOUND`（404）。全部已在 `IDENTITY_CODES` 中（`user-store.mjs:72-102`），无需新增枚举。

### 7.3 接口契约（与需求 §7.3/§7.4 等价，不改变路径）

**`GET /api/identity/me`（追加式）**：
```json
{
  "ok": true,
  "user": { "userId": "user-…", "name": "alice", "displayName": "Alice", "avatar": "", "createdAt": "…", "disabled": false },
  "roles": [{ "space": "software", "role": "member" }],
  "systemRole": "none"
}
```
- 旧字段 `user.userId`/`user.name`/`roles`/`systemRole` **名字与类型不变**；手机端只读这两个字段（`mobile/app.mjs:230,3019-3029`），不受影响。
- `avatar` 在 P0 固定 `''`（契约先稳定，P1 再填充），属于“追加式”而非语义变更。

**`POST /api/identity/profile`**：
```http
POST /api/identity/profile
Authorization: Bearer <user access token>
Content-Type: application/json

{ "displayName": "Alice" }
```
- 200：`{ ok: true, user: { userId, name, displayName, avatar, createdAt, disabled } }`（用服务端最终值回填，后写覆盖）。
- 只从 Bearer 解析 `userId`；请求体中的 `userId` 一律拒绝，不改变目标。
- 路径与需求 §7.4 的建议值一致，**不需要登记等价变更**。

### 7.4 审计与事务（R-02 / R-08 的“无部分写入”）

- `updateProfile` 在一个 `withTx` 内完成：读旧值 → 更新 → 审计 → 返回最终行。
- **审计严格性**：现有 `record` 会吞掉审计异常（`user-store.mjs:311-314`），无法满足 R-08 “资料已改但审计未写”的字面要求。建议：
  - 新增一个**仅用于资料更新**的严格路径（例如在 `updateProfile` 内直接调用注入的 `audit(...)`，不包 `try/catch`；`audit` 本身走嵌套 `withTx` SAVEPOINT，`server.mjs:3321-3346`）；
  - 失败则整个事务回滚，保证“资料与审计同生共死”；
  - **不改变**其他既有动作的 best-effort 审计语义。
- 审计 detail：`{ fields: ['displayName'], from: 'alice', to: 'Alice' }`；**不得**记录口令/令牌/哈希。
- 并发：后写覆盖；返回服务端最终值；前端以返回值回填。

### 7.5 前端 API 与 401 恢复（R-09）

- `MeInfo` 追加 `displayName/avatar/createdAt/disabled/status`；`fetchMe` 做投影与回退。
- 新增 `updateProfile(input): Promise<MeInfo['user']>`；按 `IdentityRequestError.code` 分支。
- **401 恢复**：`identity.ts` 目前不调用 `recoverSession()`（`identity.ts:281-289`）；账号页直接调用它会显示“访问令牌已过期”而不是自动续期。建议：
  - 在 `identity.ts` 增加一个**只对身份读/资料写**的包装：401 且 `code ∈ {IDENTITY_TOKEN_EXPIRED, IDENTITY_TOKEN_MISSING}` 且存在刷新凭据 → `await recoverSession()` → 重放一次（新标签页可能只有刷新凭据、没有访问令牌，`hasSession()` 仍为真）；
  - **排除** `/api/identity/refresh`（否则递归）与 `/api/identity/login`；
  - **不要**把 `IDENTITY_WRONG_PASSWORD`（401）当成过期去刷新——它必须原样提示（R-04）。
- 设备：`DeviceRow` 追加可选 `userId`（服务端已返回，`device-store.mjs:208`），供账号信息计数过滤。

### 7.6 账号页信息架构与组件拆分（R-01 / R-09）

**渲染顺序（R-01 要求）**：
1. 账号摘要（显示名 + 用户名 + 系统角色）
2. 基础信息（显示名编辑；用户名只读标注“登录名，不可修改”）
3. 账号信息（userId、用户名、显示名、系统角色、账号状态、注册时间、空间角色、当前会话、活跃会话数、执行设备数）
4. 账号安全（改口令 + 退出登录）
5. 登录中的设备（会话列表/撤销）
6. 执行设备（保留 `DevicePanel` 的配对/撤销/换令牌）
7. 管理员工具（仅 `systemRole === 'admin'`：用户列表、重置码、邀请）

**组件形态（建议，不强制）**：
- `AccountPanel.tsx` 作为**容器**：并行 `Promise.allSettled([fetchMe(), listSessions(), listDevices()])`；维护 `me`、`sessions`、`devices`、`sectionErrors`、`busy`、`loaded`；任一失败只影响对应区块（R-01/R-09）。
- 可拆分 `AccountProfileSection` / `AccountSecuritySection` / `AccountAdminSection`，但**必须在 TASK_BREAKDOWN.md 登记新增文件**（需求 §12.2 的允许文件清单需要同步扩大）；若不想扩大清单，P0 可先保留在 `AccountPanel.tsx` 内，只把**校验/投影纯函数**抽到 `workbench/src/accountProfile.ts`（测试需要）。
- `DevicePanel` 保留全部动作；建议接受可选 `devices`/`onReload` props：容器传入时共用一份数据，未传入时保持现有自取（向后兼容）。
- `WorkspaceSettings.tsx` 只渲染 `AccountPanel`（内部含 `DevicePanel`），避免同一页重复挂载；本机模式仍由 `hasSession()` 整块隐藏。
- 样式新增落 `index.css`（不要改压缩长行 `workspace.css`，`docs/RESEARCH.md:108` 同口径）。
- 可访问性：**优先**在账号页内放一个临时的 `role="status" aria-live="polite"` 区，播报保存/撤销结果（改动面最小、不影响全局 toast）；`ToastHost` 补 `role/aria-live`（`Toast.tsx:39-54` 目前没有）作为**可选的全局改进**，不作为 P0 的硬依赖。表单控件使用可见 `<label>`，保存中禁用防重复提交。

### 7.7 计数口径（R-03）

| 字段 | 来源 | 口径 |
| --- | --- | --- |
| 活跃会话数 | `GET /api/identity/sessions` | `sessions.filter(s => s.revoked !== true).length`；`listSessions` 返回全部会话（含已撤销，`user-store.mjs:943-955`） |
| 执行设备数 | `GET /api/devices` | `devices.filter(d => !d.revoked && d.userId === me.userId).length`；**管理员**的 `/devices` 返回全部（`routes/identity.mjs:589`），必须按 `userId` 过滤 |
| 当前会话 | `sessions.currentSessionId` | 与 `AccountPanel.tsx:158-163` 的“这台（现在）”标识一致 |
| 注册时间 | `/me.user.createdAt` | 服务端 ISO；前端按本地时区展示 |
| 账号状态 | `/me.user.disabled` | 本人通常 `false`；读不到时显示“—/读取失败”，不得显示“正常”或“已停用” |

> 不建议为计数新增服务端端点：三路读取已并行，且 R-09 要求独立错误态；新增聚合端点会引入第二套口径（§4.2 B 的缺点）。

### 7.8 P1 三项的推荐路径

**R-11 头像**：
- 新列 `hub_users.avatar`，存 `human:<key>`；合法集合 = `workbench/src/avatar/slots.ts:13-36` 的 40 个键（25 岗位 + s01..s15）。
- 服务端需要一份可被 `node` 导入的 40 键集合（建议新增 `team-hub/account-avatars.mjs`，或扩展 `agent-avatars.mjs` 导出 `SPARE_KEYS`）；用**现有 parity 范式**（`external-avatar-parity.test.mjs:1-30` 的 `ts.transpileModule`）逐项 `deepEqual`，防止两端漂移。
- 非法令牌/emoji/URL/HTML → `IDENTITY_INVALID_INPUT`；渲染失败 → 确定性占位（`slots.ts:75-84` 的 `PLACEHOLDER_SLOT`），不写回、不破图。
- **不写 `roster`**；不复用 roster 照片（§5）。

**R-12 显示名传播**：
- P1 只替换“当前用户”展示面（账号摘要、账号信息区、对话中“我”的标识若有）；登录页、`/users`、审计 `actor`/`by` **仍用用户名**。
- 手机端展示名来自 `me.user.name`（`mobile/app.mjs:230,3019-3029`）；是否改成 `displayName` 属于 P1 的**跨端展示决策**，必须在 T-222 明确（不改手机端 IA，但可以改显示字段）。手机端现有注释把 `name` 说成“显示名、可以改”（`mobile/app.mjs:236-240`），与本目标“用户名不可改”冲突，**文档同步时必须修正该注释**。

**R-13 最近登录**：
- 直接复用 `GET /api/identity/sessions` 的全量列表（含 `revoked`），前端取最近 5 条，显示标签/创建/最近使用/状态（当前/活跃/已撤销/已过期——过期可由 `refreshExpiresAt` 与当前时间比较得出）。
- **不新增** IP/地理/指纹字段；不把已撤销算进活跃数（§7.7）。

### 7.9 测试策略（R-10 / §9.2）

| 层 | 用例文件（建议） | 覆盖 |
| --- | --- | --- |
| 仓储 | 扩展 `team-hub/user-store.test.mjs` 或新增 `identity-profile.test.mjs` 的 store 组 | 默认回退、trim/长度/C0/换行、未知字段、后写覆盖、审计动作、旧库补列、停用账号 |
| HTTP | `team-hub/identity-profile.test.mjs`（仿 `identity-remote.test.mjs` 临时 DB + `listen(0)`） | `/me` 旧字段兼容、新字段、401 具名码、越权写 400/403、非法 JSON、`/profile` 200 响应形状 |
| 前端纯函数 | `workbench/scripts/account-profile.test.mjs` | 校验边界（与服务端同一批输入）、投影回退、计数过滤 |
| 前端结构 | 扩展 `workbench/scripts/identity-gate.test.mjs` | 非管理员不请求 `/users`；账号页使用 `recoverSession`；用户名标注“不可修改”；显示名纯文本渲染 |
| 回归 | 需求 §9.2 全量命令 | 登录/注册/邀请/重置/设备/手机端契约不回归 |

---

## 8. 任务拆解建议（T-222 可直接消费）

> 原则：P0（R-01–R-10）先全绿，P1（R-11–R-13）后做；每个切片都带“迁移 + 旧数据回退 + 测试”。

| 切片 | 内容 | 主要文件（建议） | 依赖 | 对应 AC |
| --- | --- | --- | --- | --- |
| **P0-S1 数据与仓储** | `ensureColumn` 补 `display_name`；3 处 INSERT 改显式列名；`publicUser` 追加 `displayName/avatar` + 回退；`updateProfile`（校验/事务/严格审计）；`validateDisplayName` 纯函数 | `team-hub/user-store.mjs`、`team-hub/schema-util.mjs`（仅引用）、`team-hub/identity-profile.test.mjs` | 无 | AC-03、AC-04、AC-05、AC-06 |
| **P0-S2 HTTP 契约** | `/me` 追加字段；`POST /api/identity/profile`；对象/白名单/错误映射；跨用户与停用用例 | `team-hub/routes/identity.mjs`、`team-hub/identity-profile.test.mjs` | S1 | AC-02、AC-04、AC-05、AC-10 |
| **P0-S3 前端 API + 纯函数** | `MeInfo`/`fetchMe` 扩展；`updateProfile`；`accountProfile.ts`（校验/投影/计数）；401 恢复包装；`DeviceRow.userId` | `workbench/src/identity.ts`、`workbench/src/accountProfile.ts`、`workbench/scripts/account-profile.test.mjs` | S2 | AC-02、AC-04、AC-05、AC-11 |
| **P0-S4 账号页 UI 重组** | 容器 + 区块顺序；`DevicePanel` props；`WorkspaceSettings` 挂载；加载/空/错误/重试/忙碌/局部 aria-live；本机模式不渲染 | `workbench/src/components/AccountPanel.tsx`、`DevicePanel.tsx`、`WorkspaceSettings.tsx`、`index.css`（`Toast.tsx` 可选） | S3 | AC-01、AC-07、AC-08、AC-09、AC-11 |
| **P0-S5 文档与回归** | `docs/FEATURES.md` 新增“账号与登录管理”；`README.md` 入口；手机端注释修正；跑 §9.2 | `docs/FEATURES.md`、`README.md`、`workbench/mobile/app.mjs`（仅注释/展示口径） | S4 | AC-12、AC-16 |
| **P1-S1 头像** | `avatar` 列 + 40 键白名单 + parity 测试 + 选择器 + 占位回退 | `user-store.mjs`、新 `account-avatars.mjs`、`AccountPanel.tsx`、parity 测试 | P0 全绿 | AC-13 |
| **P1-S2 显示名传播** | 当前用户展示面替换；登录/审计/用户列表不动；手机端展示决策 | `AccountPanel.tsx`、`mobile/app.mjs`（展示字段） | P1-S1 或并行 | AC-14 |
| **P1-S3 最近登录** | 全量会话最近 5 条 + 状态 | `AccountPanel.tsx`、`identity.ts`（只读） | P0 全绿 | AC-15 |

**切片排序的硬理由**：
- S1→S2：契约依赖数据投影；先有 `displayName` 才能测 `/me`。
- S2→S3：前端类型与错误码跟随服务端契约，避免“前端先猜字段”。
- S3→S4：纯函数先可测，UI 才有稳定输入；401 恢复必须在下游读取接入前完成。
- S5 最后：文档与回归需要真实行为；但手机端注释修正可与 S4 并行（仅文本）。
- P1 全部在 P0 全绿后：需求 A10 明确 P1 不得阻塞 P0。

---

## 9. 风险与不确定项（含本阶段无法核验项）

| 编号 | 风险/不确定 | 影响 | 缓解/验证 |
| --- | --- | --- | --- |
| **RK-M1** | SQLite 位置式 `INSERT INTO hub_users VALUES(...)` 在加列后是否仍接受 7 个值——本环境 `node -e` 被权限拒绝，**未实测** | 高：引导/邀请/注册全挂 | T-224 **第一步**用临时内存库实测；无论结果如何，统一改为**显式列名**（同时兼容新旧库） |
| **RK-M2** | `ALTER TABLE ADD COLUMN` 在老库/双进程启动下的行为 | 中高：迁移失败或重复列 | 只用 `ensureColumn`（`BEGIN IMMEDIATE` 内重读，`schema-util.mjs:65-90`）；不手写 PRAGMA+ALTER |
| **RK-A1** | 现有 `record` 吞审计异常，R-08 的“资料已改但审计未写”字面要求 | 中：验收争议 | §7.4 的严格审计路径（仅 `updateProfile`）；T-225 对照 R-08 复核 |
| **RK-A2** | 显示名与用户名混淆 | 中高：用户以为改了登录名 | 两个字段并列、用户名标注“登录名，不可修改”；管理员列表显示“显示名（用户名）”；文档写清 |
| **RK-A3** | 显示名 XSS/HTML 注入 | 高：脚本执行 | React 纯文本渲染；服务端拒绝 C0/换行并限长；用例覆盖 `<img onerror>` 等载荷 |
| **RK-C1** | 管理员 `/devices` 返回全部设备 | 中：账号信息“执行设备数”虚高 | 计数按 `d.userId === me.userId` 过滤；`DeviceRow` 补 `userId`（§7.7） |
| **RK-C2** | 会话列表含已撤销记录 | 中：活跃数算错 | 活跃数 `revoked !== true`；P1 最近登录显式区分状态（§7.7/§7.8） |
| **RK-U1** | `identity.ts` 无 401 恢复，账号页会显示“令牌过期” | 中：用户以为账号坏了 | §7.5 的窄条件重放（`TOKEN_EXPIRED`/`TOKEN_MISSING`）；排除 refresh/login；不吞 `WRONG_PASSWORD` |
| **RK-U2** | `AccountPanel` 单文件膨胀 | 中：维护性下降 | 纯函数抽 `accountProfile.ts`；UI 拆分需在 TASK_BREAKDOWN 登记新增文件 |
| **RK-U3** | 无 jsdom/组件测试环境 | 中：UI 行为难以自动断言 | 沿用源码扫描 + `renderToString` + 纯函数测试（§2.5）；关键旅程留给 T-226 手工走查 |
| **RK-U4** | Toast 无 `aria-live` | 中：读屏用户听不到保存结果 | 账号页内放局部 `role="status" aria-live="polite"`；表单错误另有可见文本；全局 Toast 改进可选 |
| **RK-M3** | 手机端注释把 `name` 说成“显示名、可以改” | 中：文档/行为漂移 | S5 修正注释；P1 明确手机端展示字段决策（§7.8） |
| **RK-P1** | 账号头像白名单与 `slots.ts` 两端漂移 | 中：合法令牌被拒/非法令牌被收 | 40 键集合 parity 测试（仿 `external-avatar-parity.test.mjs`）；非法值拒绝 + 占位回退 |
| **RK-P2** | 账号头像与 roster 头像混用 | 中：Agent 头像被改/显示错人 | 独立列 + 独立命名空间；不写 `roster`；R-11/§3 红线 |
| **RK-X1** | 本环境无法联网核验任何外部库的许可/维护/版本 | 中：若未来选 C/D/E，决策依据不足 | 保持 `[公开·待核]`；落地前按 `docs/RESEARCH.md:1084` 的 R10 清单做 SPDX/发布节奏复核 |
| **RK-X2** | 上游 §11 的 9 项默认口径未被将军逐条确认 | 中：范围可能变化 | 本方案按默认口径（自助账号管理、用户名不可改、显示名非唯一、P1 头像/传播/最近登录、手机端不加页）设计；若将军改口径，回到需求版本更新 |
| **RK-X3** | worktree 依赖已安装但未在本阶段跑构建/测试 | 低：下游首次构建可能暴露环境问题 | T-224 阶段 0 先跑需求 §9.2 基线；本阶段如实声明未运行 |

---

## 10. 引用来源（可查证）

### 10.1 本仓库（A 级，均在本 worktree `ff36274c` 只读核对）

- 需求与目标：`docs/G-mvt9or0l-1/REQUIREMENTS.md`（T-220；blob `8e5197be…`）；`docs/goals/G-mvt9or0l-1.md`
- 数据面：`team-hub/user-store.mjs:72-102`（错误码）、`:153-158`（用户名/口令校验）、`:183-211`（scrypt）、`:239-309`（建表）、`:311-314`（审计吞错）、`:321-332`（userRow/publicUser）、`:358,409,1088`（位置式 INSERT）、`:795-823`（login）、`:837-900`（refresh/verifyAccessToken）、`:935-955`（revoke/listSessions）、`:1179-1202`（changePassword）、`:1231-1248`（listUsers/setUserDisabled）、`:1250-1271`（导出）
- 迁移原语：`team-hub/schema-util.mjs:5-28,36-90`；用例 `team-hub/approval-binding.test.mjs:537-545`
- 接口面：`team-hub/routes/identity.mjs:17-20,31-35,239-265,277,399-407,410-414,417-433,436-451,500-518,585-592,629-656`；`team-hub/server.mjs:3321-3346`（audit）、`:7706-7716`（readBody）、`:7793-7799`（requireString）、`:9079-9083`（store 注入）
- 设备：`team-hub/device-store.mjs:118,205-214,272`；`team-hub/routes/identity.mjs:585-592`
- 前端：`workbench/src/identity.ts:33-62,122-160,239-289,296-318,363-402,432-441`；`workbench/src/components/AccountPanel.tsx:34-66,116-221`；`DevicePanel.tsx:35-54,85-151`；`WorkspaceSettings.tsx:21-24`；`Toast.tsx:21-56`；`workbench/src/api.ts:73-89`；`workbench/src/index.css:3744-3759`
- 手机端：`workbench/mobile/app.mjs:230-240,1418,2769,3019-3029`
- 头像基座：`workbench/src/avatar/slots.ts:13-36,75-94,102-116`；`team-hub/agent-avatars.mjs:1-25,39-45`；`workbench/scripts/external-avatar-parity.test.mjs:1-30`
- 测试夹具：`team-hub/user-store.test.mjs:26-63`；`team-hub/identity-remote.test.mjs:1-32`；`team-hub/identity-registration.test.mjs:150-210`；`workbench/scripts/identity-gate.test.mjs:1-14`
- 约束与先例：`docs/DEPLOY.md:49,68`；`docs/RESEARCH.md:108,820,952,1083,1084`；`docs/G-mvgf01af-4/REQUIREMENTS.md:168`；`docs/prototypes/legion-interface-implementation.md:13,18`；`docs/FEATURES.md:77-83`；`docs/G-mv1s6y49-1/RESEARCH.md:19,217`；`docs/STATUS.md:735`
- 依赖清单：`workbench/package.json:17-22`；`team-hub/package.json:13-16`；`desktop/payload/package-lock.json:8593-8600`（zod 4.6.5 / MIT）；`workbench/package-lock.json` 与 `workbench/pnpm-lock.yaml`（按 `node_modules/<pkg>` 计数，zod/valibot/react-hook-form/@radix-ui/tailwindcss 均为 0）

### 10.2 外部候选（[公开·待核]，本环境未能联网核验；URL 供后续复核）

> 本环境 `WebSearch`/`WebFetch` 均返回权限错误（unattended approval），且纪律禁止联网。以下仅列**需要复核的对象与复核项**，**不引用任何未核实的版本/星数/许可证结论**：

- Better Auth / Auth.js / Lucia / Passport.js：SPDX 许可、最近发布、issue 状态、是否要求特定框架（Next.js/Express）、会话/用户表迁移成本。
- Keycloak / Ory Kratos / SuperTokens：部署形态（容器/服务）、许可、最小资源、与 SQLite/单机部署的兼容性。
- zod / valibot / react-hook-form / Radix / Tailwind：许可、体积、是否与 React 19/Vite 7 兼容。
- 复核方法：沿用 `docs/RESEARCH.md:15.2` 的 `[公开·待核]` 惯例——联网后取 npm registry / GitHub API / 官方文档，逐项记录抓取日期；未复核前不得写入结论。

### 10.3 上游交接与版本证据

- 上游阶段 requirement（task=T-220）产物：`docs/G-mvt9or0l-1/REQUIREMENTS.md`，派工登记 sha256=`8e5197be34d40b52ae2ea18ca051a6d78e3a6ad39b4af0c8867358dded9f7c7f`；
- 本 worktree 的 git blob 校验：`git show fe163283:docs/G-mvt9or0l-1/REQUIREMENTS.md | sha256sum` → 同值；工作区文件因 `core.autocrlf=true` 为 CRLF，哈希不同属换行转换，**内容未替换**；
- 上游阶段证据：`agent-workflow-stage-checkpoint:{"stageId":"requirement","sourceCommit":"fe1632836631508e2e0a8fe13999b2a2f441c6a8"}`。

---

## 11. 本阶段自检（逐条对应任务验收标准）

| 验收标准 | 对应章节 | 结论 |
| --- | --- | --- |
| 方案覆盖需求要点，给出 **≥2 个候选方案对比（优缺点 / 成本 / 风险）** | §4.1–§4.6（A/B/C/D/E 五个候选 + 矩阵）；§3 把 R-01–R-14 映射到决策 | ✅ 5 个候选、10 个维度；P0/P1 全覆盖 |
| **有明确推荐与理由，依据为真实可查来源并注明引用** | §0 推荐 A；§4.1 依据；§10.1 逐条 file:line | ✅ 推荐依据全部来自本 worktree 可复读代码/文档；外部候选只作 `[公开·待核]` |
| **新引入技术/依赖逐项说明影响（许可 / 维护 / 学习成本 / 生态）** | §6.1（A 的 6 项，零第三方依赖）、§6.2（被否决依赖逐项，zod 本地 MIT 可查，其余待核） | ✅ 0 新增依赖的结论有 `DEPLOY.md:49` 与锁文件证据；被否决项不编造元数据 |
| **方案结论可直接支撑后续任务拆解** | §7（数据/接口/校验/审计/前端/计数/P1/测试）+ §8（8 个切片的文件/依赖/AC） | ✅ 每个切片都有文件域、依赖顺序与验收映射 |
| 边界：只做调研、不改代码 | 全文 | ✅ 未改任何产品代码；仅只读 grep/read/hash；未运行测试/构建；未 push |
| 不确定项列为风险与备选方案 | §9（RK-M1…RK-X3）+ §4.2 备选 + §0 决策表“主要备选”列 | ✅ SQLite INSERT 语义、审计严格性、管理员设备计数、401 恢复、P1 parity、外部库元数据均为显式风险 |
| 不编造数据支撑结论 | §10.1 全部 file:line；§10.2 明确“未联网、待核”；§2.1 上游哈希核对 | ✅ 无未核验数字；无“看起来应该”式结论 |
| 处理历史评论 | 派工信息为“（无）” | ✅ 无退回意见需处理 |

---

## 12. 变更记录

| 版本 | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| v1 | 2026-10-29 | 方案搜索（探微） | 首版：基于 `ff36274c` 只读实测，给出 A/B/C/D/E 五个候选与矩阵，推荐“现有 identity 栈内追加式扩展 + 账号页区块化重组”（零新增依赖），并落到数据/接口/校验/审计/前端/计数/P1/测试与 8 个切片的拆解输入；外部候选因禁网统一标 `[公开·待核]`。 |

---

> **本文件到此为止。** 下游 T-222 只能在本文件与 REQUIREMENTS.md 的交集内拆解；若选择与 §7.3/§7.4 不同的路径，必须在本文件登记等价语义并同步 TASK_BREAKDOWN/TEST_CASES。

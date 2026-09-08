# Legion —— AI Office 军团作战平台

**主体是 Web 军团指挥台（workbench），中枢是 team-hub v2；scrum 看板是历史遗留引擎。**

Legion 是一套「**将军（general）+ 编队智能体（soldier/roster）**」的多智能体协作平台：将军在指挥台上为各工作空间发布目标，目标自动拆成阶段任务链分发给该空间专属编队，智能体执行并把过程/产出沉淀回任务，将军在任务详情里直接验收——全程不离开浏览器。

> 完整功能使用介绍（每条功能的入口、操作步骤、期望结果与边界）见 **功能手册 [docs/FEATURES.md](docs/FEATURES.md)**。本文档是产品总览 + 快速开始 + 模块导航 + 关联文档入口，细节以手册为准并互链去重。

---

## 1. 一眼看懂：现在用什么

| 组件 | 形态 | 端口 | 角色 |
| --- | --- | --- | --- |
| **workbench（军团指挥台）** | React 静态应用（`legion/workbench`，构建产物托管） | `:5173` | **日常主体**：空间/编队/3D 场景/发布目标/任务详情/AI 执行过程/调度验收/持续执行编排/模型配置/技能中心 ＋ **三中心**（对话中心/文件中心/浏览器助手，见 §3.9） |
| **team-hub v2（团队中枢）** | 独立 Node 服务（`legion/team-hub/server.mjs`） | `:8787` | 数据与 API 中枢：SQLite 任务池 + 空间 + 编队 + 审计 + 目标 + 执行编排 + 模型配置 |
| **scrum v1（看板引擎）** | 早期引擎（`serve.mjs`/`taskctl.mjs`/`tasks.json`） | `:4820` | **遗留兼容**：除调试/迁移外不再日常使用（细节见 `scrum/README.md`） |

```
将军（你，浏览器 :5173）
   │  选空间 · 发布目标 · 点任务 · 验收
   ▼
workbench 军团指挥台 ──HTTP/JSON──▶ team-hub v2（:8787, team.db）
                                          │ 任务/空间/编队/审计/目标/exec/models
                                          ▼
                              编队智能体（AI 执行 → evidence/评论写回任务 → 提交待验收）
   scrum v1（:4820, tasks.json）←── 遗留，仅迁移/调试用
```

---

## 2. 快速开始

> 部署 / 发布（环境分级、步骤、验证、回滚、变更影响）见 **docs/DEPLOY.md**；发布前 CI 门禁：`node scripts/ci/run-ci.mjs`。

### 2.1 启动三件套

> 日常使用推荐走 **§2.1.1 伴随 DSH Desktop 自动启停**（不用手动开）。下面三件套命令仅用于独立调试 / 未跑 Desktop 的场合。

```powershell
# ① 团队中枢（必启，:8787）
cd D:\project\DSH\legion
node team-hub\server.mjs

# ② 军团指挥台（主体，:5173）——改前端源码后必须重新 pnpm build，5173 不是热更！
cd D:\project\DSH\legion\workbench
pnpm build
node scripts\serve.mjs --port 5173

# ③（可选）v1 看板遗留（:4820）
cd D:\project\DSH\legion
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820
```

### 2.1.1 伴随 DSH Desktop 自动启停（推荐，免每次手动）

`services-plugin`（`@dsh-external/dsh-legion-services`，本仓库 `services-plugin/`）把上面三件套托管进 **DSH Desktop 的 web profile**：Desktop 启动即自动拉起 team-hub v2（:8787）/ v1 看板（:4820）/ 指挥台（:5173），进程异常退出会自愈重启（闪退退避），Desktop 退出时随插件回收全部子服务；某端口已被监听则跳过（不重复占用）。状态日志在 `<legion根>/.legion-services.log`。

已登记（`~/.dsh/profiles/web/` 的 `package.json` 依赖 + `cordis.patch.yml` 的 `legion-services` 行，patch 里**必须显式给** `legionDir`——pnpm 对 `file:` 依赖是复制快照，运行时插件文件在 profile 的 node_modules 副本里，靠 `import.meta.url` 自定位会找错根目录）。日常改码流程：把 `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-legion-services` 建成 **junction → 本仓库 `services-plugin/`**，改代码即时生效；若曾重跑 `pnpm install`（会把 junction 替换回复制快照），需按 `Remove-Item` + `New-Item -ItemType Junction` 重建。手动三件套命令保留作独立调试用（如上）。

### 2.2 三分钟体验循环

按「选空间 → 发布目标（自动建链）→ 点任务看详情 → 自动推进或派 AI 执行 → 验收/打回」一气呵成，完整分步说明见功能手册 **[§2.3 三分钟体验循环](docs/FEATURES.md#23-三分钟体验循环)**。

---

## 3. 功能模块导航（完整细节见功能手册）

> 本小节只给每模块**一段引导 + 指向功能手册对应章节**；逐步操作细节、入口与边界见手册。功能索引见手册 **[§4 功能索引](docs/FEATURES.md#4-功能索引)**。

### 3.1 安装与启动
三件套命令 + DSH Desktop 自动启停，端口与健康检查见手册。📖 详见功能手册 **[§3.1 安装与启动](docs/FEATURES.md#31-安装与启动)**。

### 3.2 空间与专属编队
左侧「工作空间」= 真实分区（各空间岗位数量由 `seed-roster.mjs` 幂等播种）；「＋ 新建空间」两步建空间 + 选人入编；每空间可绑定自己的仓库；移除空间需影响预检 + type-to-confirm。📖 详见功能手册 **[§3.2 空间与专属编队](docs/FEATURES.md#32-空间与专属编队)**。

### 3.3 中央视图（3D / 智能体总览）
首页 3D 办公场景按状态发光，点击智能体（2D 卡/3D 身体/名牌）进入该智能体任务清单。📖 详见功能手册 **[§3.3 中央视图](docs/FEATURES.md#33-中央视图)**。

### 3.4 当前任务集与任务详情
右侧「当前任务集」按角色泳道 + 状态排序 + 一键展开；任务详情含 AI 执行过程 / 审计 / 时间线 / 状态操作。📖 详见功能手册 **[§3.4 当前任务集与任务详情](docs/FEATURES.md#34-当前任务集与任务详情)**。

### 3.5 发布目标与自动建链
底部「🎯 发布目标」每次新建一个目标（G-xxx）并自动生成独立阶段任务链；每目标带 status/version 与链进度；验收标准 + 边界自动注入。📖 详见功能手册 **[§3.5 发布目标与自动建链](docs/FEATURES.md#35-发布目标与自动建链)**。

### 3.6 任务调度与验收
底部「🗓 任务调度」中枢调度弹窗，全部任务按状态分组 + 统计条，待验收默认展开。📖 详见功能手册 **[§3.6 任务调度与验收](docs/FEATURES.md#36-任务调度与验收)**。

### 3.7 自动交接与守护流水线
守护自动认领 + 自动派工 + 人工闸门 + 将军干预 + 合入自动调解 + 重启孤儿回收。📖 详见功能手册 **[§3.7 自动交接与守护流水线](docs/FEATURES.md#37-自动交接与守护流水线)**。

### 3.8 模型 × 智能体配置
底部「⚙️ 模型配置」按空间/角色选默认模型，按省 token 档位分组；执行守护按配置选模型。📖 详见功能手册 **[§3.8 模型 × 智能体配置](docs/FEATURES.md#38-模型-智能体配置)**。

### 3.9 三中心 + 规范/技能中心

- **💬 对话中心**：随空间隔离会话 + AI 直答（气泡三态/重试）。📖 详见功能手册 **[§3.9 对话中心](docs/FEATURES.md#39-对话中心)**。
- **📁 文件中心**：浏览空间绑定本地目录 + 写操作（令牌 + 二次确认 + 越界保护）。📖 详见功能手册 **[§3.10 文件中心](docs/FEATURES.md#310-文件中心)**。
- **🌐 浏览器助手**：SSRF 防护代理抓取正文。📖 详见功能手册 **[§3.11 浏览器助手](docs/FEATURES.md#311-浏览器助手)**。
- **📜 规范中心**：全局层 rules 表 + 空间层文件族（LEGION/AGENTS/agent），分层注入。📖 详见功能手册 **[§3.12 规范中心与分层规范](docs/FEATURES.md#312-规范中心与分层规范)**。
- **🧩 技能中心**：注册/发布/跨空间授权共享。📖 详见功能手册 **[§3.13 技能中心](docs/FEATURES.md#313-技能中心)**。
- **📅 日程日历 / 🔔 通知中心**：月视图日程 + 审计派生通知（per-scope）。📖 详见功能手册 **[§3.14 日程日历与通知中心](docs/FEATURES.md#314-日程日历与通知中心)**。

右侧「实时动态」= SSE 审计流 + 顶部 KPI（目标/完成/进行中/AI 员工数）；底部命令栏：⏸ 全局暂停 / 🗓 任务调度 / 🎯 发布目标 / ⚙️ 模型配置 / ＋ 新建任务 / 📤 导出日报。

### 3.10 任务收尾审计（L1–L3）
任务详情「🧾 审计」区：L1 改动文件清单 + diff、L2 逐文件批注 + 打回闭环、L3 跨任务改动重叠警示；派工即时可见 + 证据同屏。📖 详见功能手册 **[§3.15 任务收尾审计](docs/FEATURES.md#315-任务收尾审计)**。

### 3.11 team-hub 数据与接口一览
数据与 API 中枢（SQLite/写纪律/状态机/接口域）。📖 详见功能手册 **[§3.16 team-hub 数据与接口一览](docs/FEATURES.md#316-team-hub-数据与接口一览)**。

### 3.12 v1 遗留与迁移
v1→v2 迁移脚本与并存警示；v1 为遗留兼容。📖 详见功能手册 **[§3.17 v1 遗留与迁移](docs/FEATURES.md#317-v1-遗留与迁移)**。

---

## 4. team-hub v2 一览（:8787）

- **存储**：`team-hub/team.db`（SQLite WAL）。表：`tasks` / `members` / `roster` / `skills` / `audit` / `spaces` / `goal` / `exec_state` / `exec_requests` / `agent_models`。
- **写纪律**：所有 POST 经统一 `handleWrite`，`by`（操作者）必填；每次写都落 `audit` 并 SSE 广播。
- **状态机**：`todo → in_progress → in_review → done`（`done` 仅 `by='general'` 从 `in_review` 验收）；`blocked` 受依赖阻塞（`force` 可绕）；乐观锁 `ifVersion`。

| 域 | 接口 |
| --- | --- |
| 任务 | `GET /api/board?scope=` · `GET /api/task?id=` · `POST /api/create /claim /transition /advance /reassign /release-stale /comment /heartbeat` |
| 审计 | `POST /api/patch`（结构化：files[{path,status,add,del}]+diff）· `POST /api/review-notes`（任务/文件批注 ok/issue/clear）· `GET /api/overlaps?scope=&id=`（跨任务改动重叠，L3） |
| 目标 | `GET /api/goal?scope=`（多目标列表，含 status/version/各自链进度） · `POST /api/goal`（每次新建一个目标 + 独立链） · `POST /api/goal/status`（暂停/恢复/收尾/取消，仅将军） |
| 进展 | `GET /api/activity?scope=|taskId=|limit=`（审计时间线） |
| 空间/编队 | `GET /api/spaces`（含仓库绑定 `localDir`/`remoteUrl`） `/api/roster?scope= /api/agents` · `POST /api/spaces /api/spaces/{id}/agents /api/agents` |
| 技能 | `GET /api/skills` · `POST /api/skills/register /review /grant` |
| 执行编排 | `GET/POST /api/exec`（开关） · `GET /api/exec/queue`（自动队列） · `POST /api/exec/request`（手动派活） |
| 模型配置 | `GET/POST /api/models` · `POST /api/models/clear` |
| 对话 | `GET/POST /api/chat/conversations` · `GET/POST /api/chat/messages`（scope 分区，审计+SSE 留痕；表 `conversations`/`messages`） |

## 4.1 三中心接口（workbench 同源 / 经 /hub 代理）

| 域 | 接口 | 说明 |
| --- | --- | --- |
| 对话 | `GET/POST /hub/api/chat/conversations`、`/hub/api/chat/messages` | 经 serve.mjs `/hub/*` 反向代理到 team-hub（:8787）；写=统一 handleWrite（by=general）+ 审计/SSE |
| 文件（只读） | `GET /api/files/list`、`/api/files/read`、`/api/files/download`（`?scope=&path=`） | 仅回环；scope 的 `local_dir` 即根；越界/`.git` 内部 403 |
| 文件（写） | `PUT /api/files/upload`（`overwrite=1`）· `POST /api/files/mkdir|rename|delete` | 仅回环 + 写需令牌（`--token`，无令牌=不要求）；409/413/400 语义；上传 Content-Length 预检 + 流式限长，临时文件原子发布 |
| 浏览器 | `POST /api/web/fetch`（body `{url, maxBytes?, timeoutMs?}`） | 仅回环；SSRF 防护代理 + 正文抽取；错误 `{ok:false, error, code}` |

---

## 5. 从 v1 到 v2（迁移与共存）

- **迁移**：`node team-hub/scripts/migrate-tasks.mjs [--scope software]` 把 `scrum/tasks.json` 幂等导入 SQLite（已存在 id 跳过，无 scope 任务归入 `--scope`）。
- **警示**：v1（tasks.json/serve.mjs）与 v2（SQLite/team-hub）并存期间**只写其中一个**；守护/看板换到 v2 后以 SQLite 为准。
- **v1 引擎细节**（看板协议 / taskctl 状态机与命令手册 / 守护配置 / worktree 隔离 / 审阅闭环）→ **见 `scrum/README.md`**；旧看板页仍可从 `:4820` 打开用于调试与历史对比。

---

## 6. 故障排查

完整「现象 → 处理」对照表已收敛到功能手册 **§5.1 [故障排查](docs/FEATURES.md#51-故障排查)**，常见问题覆盖：加载旧界面（强刷/重建）、`🧭 中枢` 不可达、发布目标没反应、任务不刷新、写操作缺 `by`、v1 看板 401、文件中心未绑定、浏览器助手内网拦截等。发布前 CI 门禁 `node scripts/ci/run-ci.mjs`。

---

## 附录

**关联文档**
- `docs/FEATURES.md` — **功能使用手册**（每条功能的入口/步骤/期望结果/边界 + 功能索引；本文档细节的权威来源）
- `workbench/README.md` — 军团指挥台细目（组件/数据流/各功能实现位置）
- `scrum/README.md` — v1 看板协议与 taskctl 命令手册（遗留引擎）
- `docs/ORCHESTRATION-V3.md` — v3 切片流水线编排（并行波次 / D7' 机器闸门 / 类型化槽位，含审计闸门设计）
- `docs/DEPLOY.md` — 发布部署 runbook（环境分级 / 步骤 / 验证 / 回滚 / 变更影响；发布前 CI 门禁 `node scripts/ci/run-ci.mjs`）
- `docs/TEST_REPORT.md` — 测试报告与逐套件锚定结果
- `docs/P0-CONFIRMATION.md` / `docs/P1-LIVE-ROLLOUT.md` / `docs/P2-GOALDOCS-LIVE.md` / `docs/P3-PROD-ROLLOUT.md` — P0~P3 上线与滚动记录（历史过程记录，非正文）
- `team-hub/server.mjs` — v2 中枢源码（表结构与全部路由以代码为准）
- `LEGION.md` — 军团规则（注入执行 agent 提示词）

**关键路径**
- 中枢数据库：`team-hub/team.db`
- 工作台源码：`workbench/src/`（组件在 `components/`）
- 编队播种：`node team-hub/scripts/seed-roster.mjs`
- v1 任务库：`scrum/tasks.json`

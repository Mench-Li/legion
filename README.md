# Legion —— AI Office 军团作战平台

**主体是 Web 军团指挥台（workbench），中枢是 team-hub v2；scrum 看板是历史遗留引擎。**

Legion 是一套「**将军（general）+ 编队智能体（soldier/roster）**」的多智能体协作平台：将军在指挥台上为各工作空间发布目标，目标自动拆成阶段任务链分发给该空间专属编队，智能体执行并把过程/产出沉淀回任务，将军在任务详情里直接验收——全程不离开浏览器。

---

## 1. 一眼看懂：现在用什么

| 组件 | 形态 | 端口 | 角色 |
| --- | --- | --- | --- |
| **workbench（军团指挥台）** | React 静态应用（`legion/workbench`，构建产物托管） | `:5173` | **日常主体**：空间/编队/3D 场景/发布目标/任务详情/AI 执行过程/调度验收/持续执行编排/模型配置/技能中心 |
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

### 2.1 启动三件套

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

`services-plugin`（`@dsh-external/dsh-legion-services`，本仓库 `services-plugin/`）把上面三件套托管进
**DSH Desktop 的 web profile**：Desktop 启动即自动拉起 team-hub v2（:8787）/ v1 看板（:4820）/ 指挥台（:5173），
进程异常退出会自愈重启（闪退退避），Desktop 退出时随插件回收全部子服务；某端口已被监听则跳过（不重复占用）。
状态日志在 `<legion根>/.legion-services.log`。

已登记（`~/.dsh/profiles/web/` 的 `package.json` 依赖 + `cordis.patch.yml` 的 `legion-services` 行，
依赖经 `pnpm install` 装入 profile）。改完 `services-plugin/` 代码只需重启 Desktop 生效，无需重新 install。
手动三件套命令保留作独立调试用（如上）。

### 2.2 三分钟体验循环

1. 浏览器打开 **http://127.0.0.1:5173**（旧标签页请 `Ctrl+F5` 强刷，5173 托管构建产物）。
2. 右侧顶部确认「🧭 中枢」已探测到 `:8787`；左侧选一个工作空间（如 **software 软件流水线**）。
3. 底部 **「🎯 发布目标」** 输入目标 → 该空间自动生成**阶段任务链**（需求澄清 → 方案搜索 → 任务拆解 → 测试用例设计 → 编码实现 → 代码审查 → 测试执行 → 部署与 CI/CD，`blockedBy` 串链），右侧「当前任务集」立即出现。
4. 点任意任务行 → **任务详情**：🤖 AI 执行过程 / ⏱ 进展时间线 / 📋 描述 / 🎯 验收标准。
5. 想自动推进：左侧底部开 **「⚡ 持续执行编排」** → 分析类阶段（需求/方案/拆分）由 AI 自动执行并提交待验收；写码类在任务详情点 **「🤖 派 AI 执行」**。
6. 任务到 🟡 待验收 → 详情里 **✓ 验收通过**（放行 done，解锁下游）或 **↩ 打回重做**（附原因）。

---

## 3. 工作台功能指南

### 3.1 空间与专属编队
- 左侧「工作空间」= team-hub 真实分区：**全部空间** + 各空间（software 8 软件岗 / marketing 5 市场岗 / product 5 产品岗 / ops 4 运营岗 / default 3 通用岗，`node team-hub/scripts/seed-roster.mjs` 幂等播种）。
- 「＋ 新建空间」两步建空间 + 从全局智能体目录**选人入编**或新建智能体（`POST /api/spaces`、`/api/spaces/{id}/agents`、`/api/agents`）。
- **每个空间可绑定自己的仓库**：空间行「⚙」→ 空间设置——**「📂 选择文件夹」浏览本机目录**（与 DSH 工作空间选目录一致，不手填路径），
  选定后自动识别该文件夹的 git 仓库与远程（`origin`/首个 remote 预填「远程仓库 URL」；**留空 = 仅本地 / 不进共享仓库**）。
  绑定存 `spaces` 表 `local_dir`/`remote_url`（`GET/POST /api/spaces`），守护派工/隔离按空间以该仓库为工作目录与隔离根（未绑定回退默认，见 `workbench/README.md`「空间仓库绑定」）。
- 每空间只见自己的专属编队；未入编但认领了该空间任务的执行者以「⚙️ xxx · 执行中」合流展示。

### 3.2 中央视图（3D 场景 / 智能体总览）
- **首页 3D 办公场景**：编队绕会议桌，发光头部颜色 = 状态（🟢进行中/🟡待验收/🔴受阻/🔵待命），头顶名牌带任务数 + 目标进度环。
- **点击智能体（2D 总览卡 / 3D 身体或名牌均可）** → 该智能体**任务清单**：🟢 运行中（进行中/待验收/受阻）/ ⚪ 待办 / ✅ 已完成，头部显示其默认模型徽标；点任务行 → 任务详情。
- 「全部空间」视图按分区展示全部编队。

### 3.3 当前任务集（右侧）与任务详情
- 右侧「当前任务集」= 当前空间任务按角色泳道（只显示该空间，3 条 + 「+N 更多」）。
- **点任务行 → 任务详情弹窗**：
  - **🤖 AI 执行过程**：执行该任务的 AI 沉淀的过程记录（evidence + 评论时间流）——AI 的每一步行动/产出/汇报都在这，是「任务详情看到 AI 工作过程」的落点；
  - **⏱ 进展时间线**：goal:publish / claim / transition / comment / evidence / reassign / exec / model 等审计动作（`GET /api/activity?taskId=`）；
  - 📋 描述、🎯 验收标准（空则警示）、🔗 依赖提示、创建/更新时间；
  - **状态操作**（按状态出现）：todo →「▶ 开工 / 🔒 认领」；in_progress →「📮 提交验收 / 归还待办」；in_review →「✓ 验收通过（仅将军）/ ↩ 打回重做」；blocked →「解阻」；另有「💬 评论/记录」「转派」「🤖 派 AI 执行」。

### 3.4 发布目标与自动建链
- 底部「🎯 发布目标」（选中具体空间后可用）→ `POST /api/goal`：重复发布会**取消**同空间旧的 `[auto-goal]` 未完成任务，再按编队生成新阶段链（`soldier=role`、`priority=high`、`blockedBy=前一任务`）。
- 目标进度（done/total/percent）显示在中央目标卡与场景进度环。

### 3.5 任务调度与验收
- 底部「🗓 任务调度」→ 中枢调度弹窗：全部任务按状态分组 + 统计条；待验收任务默认展开（打回/通过引导）；任务行可点进详情。

### 3.6 持续执行编排（侧栏「⚡」开关）
- 按空间持久化（`POST /api/exec`）。
- **开启后自动执行分析类阶段**（需求澄清/方案设计/任务拆分等「产出报告」角色），**写码类不自动**（coder/reviewer/tester/devops/test-designer 等会动仓库的角色）——写码类在任务详情「🤖 派 AI 执行」手动请求（`POST /api/exec/request`）。
- 自动队列：`GET /api/exec/queue?scope=`（仅 `[auto-goal]` 链上、非写码角色、todo/in_progress 且未被请求）。**执行守护 = 将军 agent 侧**消费队列/请求：认领 → 派 AI 干活 → evidence 写回 → 提交待验收。
- 后台表：`exec_state`（scope×enabled）、`exec_requests`（taskId×pending）。

### 3.7 模型 × 智能体配置（底部「⚙️ 模型配置」）
- 每空间每角色可选**默认模型**（`agent_models` 表，`GET/POST /api/models`、`POST /api/models/clear`，均记审计）；未配置 = 平台默认（custom-ds / deepseek-v4-flash-openai）。
- 候选 = 本机 DSH 部署真实模型（`~/.dsh/settings.yaml`），按省 token 档位分组：

  | 档位 | 模型 |
  | --- | --- |
  | ⚡ 轻量（省 token） | `custom-ds/deepseek-v4-flash-openai`、`zai-coding-cn/glm-5.3-flash`、`zai-coding-cn/glm-5-turbo` |
  | 🔶 均衡 | `custom-gpt/gpt-5.6-luna`、`gpt-5.6-terra`、`zai-coding-cn/glm-5.1` |
  | 🟣 旗舰/强推理 | `custom-ds/deepseek-v4-pro-openai`、`custom-gpt/gpt-5.6-sol`、`zai-coding-cn/glm-5.2` |
  | 👁 视觉 | `custom-ds/deepseek-v4-flash-vision-openai`、`zai-coding-cn/glm-5v-turbo` |

  典型策略：分析类（requirement/researcher/breaker）→ 轻量；写码/审查（coder/reviewer）→ 旗舰；测试/运维 → 轻量或均衡。执行守护按角色配置选模型；智能体任务清单头部显示模型徽标。

### 3.8 其它
- **🧩 技能中心**：注册技能 → 将军发布/驳回 → 按成员或 `scope:xxx` 授权（士兵只读已发布技能）。
- **右侧「实时动态」**：SSE 审计流；顶部 KPI：目标/完成/进行中/AI 员工数。
- **底部命令栏**：⏸ 全局暂停（v1）/ 🗓 任务调度 / 🎯 发布目标 / ⚙️ 模型配置 / ＋ 新建任务 / 📤 导出日报。

---

## 4. team-hub v2 一览（:8787）

- **存储**：`team-hub/team.db`（SQLite WAL）。表：`tasks` / `members` / `roster` / `skills` / `audit` / `spaces` / `goal` / `exec_state` / `exec_requests` / `agent_models`。
- **写纪律**：所有 POST 经统一 `handleWrite`，`by`（操作者）必填；每次写都落 `audit` 并 SSE 广播。
- **状态机**：`todo → in_progress → in_review → done`（`done` 仅 `by='general'` 从 `in_review` 验收）；`blocked` 受依赖阻塞（`force` 可绕）；乐观锁 `ifVersion`。

| 域 | 接口 |
| --- | --- |
| 任务 | `GET /api/board?scope=` · `GET /api/task?id=` · `POST /api/create /claim /transition /advance /reassign /release-stale /comment /heartbeat` |
| 目标 | `GET /api/goal?scope=` · `POST /api/goal`（upsert + 自动建链） |
| 进展 | `GET /api/activity?scope=|taskId=|limit=`（审计时间线） |
| 空间/编队 | `GET /api/spaces`（含仓库绑定 `localDir`/`remoteUrl`） `/api/roster?scope= /api/agents` · `POST /api/spaces /api/spaces/{id}/agents /api/agents` |
| 技能 | `GET /api/skills` · `POST /api/skills/register /review /grant` |
| 执行编排 | `GET/POST /api/exec`（开关） · `GET /api/exec/queue`（自动队列） · `POST /api/exec/request`（手动派活） |
| 模型配置 | `GET/POST /api/models` · `POST /api/models/clear` |

---

## 5. 从 v1 到 v2（迁移与共存）

- **迁移**：`node team-hub/scripts/migrate-tasks.mjs [--scope software]` 把 `scrum/tasks.json` 幂等导入 SQLite（已存在 id 跳过，无 scope 任务归入 `--scope`）。
- **警示**：v1（tasks.json/serve.mjs）与 v2（SQLite/team-hub）并存期间**只写其中一个**；守护/看板换到 v2 后以 SQLite 为准。
- **v1 引擎细节**（看板协议 / taskctl 状态机与命令手册 / 守护配置 / worktree 隔离 / 审阅闭环）→ **见 `scrum/README.md`**；旧看板页仍可从 `:4820` 打开用于调试与历史对比。

---

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| 页面打开但没数据 / 显示旧界面 | `:5173` 托管构建产物：改前端后需 `pnpm build` 再刷新；旧标签页 `Ctrl+F5` 强刷 |
| 「🧭 中枢」不可达 | team-hub 没起：`node team-hub\server.mjs`（:8787）；可改/清中枢地址（存 localStorage） |
| 发布目标没反应 | 需中枢可达 + 已选**具体**空间（不是「全部空间」） |
| 任务不刷新 | 任务集靠 board 变化 + 15s 轮询；roster/目标/模型配置依赖空间切换刷新 |
| 写操作报「缺少操作者身份 by」 | 直连 API 测试时漏带 `by`（workbench 会自动补 `by:'general'`） |
| 智能体点不出任务 | 确认中枢模式 + 该角色有任务；页面是旧产物时强刷 |
| git push 连不上 | 全局代理指向 `127.0.0.1:7897`（可能未运行）：`git -c http.proxy= -c https.proxy= push origin main` |
| v1 看板 401 | `serve.mjs --token` 写操作需令牌（workbench 写接口与 v2 不同源，注意别混写） |

---

## 附录

**关联文档**
- `workbench/README.md` — 军团指挥台细目（组件/数据流/各功能实现位置）
- `scrum/README.md` — v1 看板协议与 taskctl 命令手册（遗留引擎）
- `team-hub/server.mjs` — v2 中枢源码（表结构与全部路由以代码为准）
- `LEGION.md` — 军团规则（注入执行 agent 提示词）

**关键路径**
- 中枢数据库：`team-hub/team.db`
- 工作台源码：`workbench/src/`（组件在 `components/`）
- 编队播种：`node team-hub/scripts/seed-roster.mjs`
- v1 任务库：`scrum/tasks.json`

# Legion —— AI Office 军团作战平台

**主体是 Web 军团指挥台（workbench），中枢是 team-hub v2；scrum 看板是历史遗留引擎。**

Legion 是一套「**将军（general）+ 编队智能体（soldier/roster）**」的多智能体协作平台：将军在指挥台上为各工作空间发布目标，目标自动拆成阶段任务链分发给该空间专属编队，智能体执行并把过程/产出沉淀回任务，将军在任务详情里直接验收——全程不离开浏览器。

---

## 1. 一眼看懂：现在用什么

| 组件 | 形态 | 端口 | 角色 |
| --- | --- | --- | --- |
| **workbench（军团指挥台）** | React 静态应用（`legion/workbench`，构建产物托管） | `:5173` | **日常主体**：空间/编队/3D 场景/发布目标/任务详情/AI 执行过程/调度验收/持续执行编排/模型配置/技能中心 ＋ **三中心**（对话中心/文件中心/浏览器助手，见 §3.8） |
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

> 日常使用推荐走 **§2.1.1 伴随 DSH Desktop 自动启停**（不用手动开）。下面三件套命令仅用于
> 独立调试 / 未跑 Desktop 的场合。

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
patch 里**必须显式给** `legionDir: 'D:/project/DSH/legion'`——pnpm 对 `file:` 依赖是**复制快照**，
运行时插件文件在 profile 的 node_modules 副本里，靠 `import.meta.url` 自定位会找错根目录）。
⚙ **日常改码流程**：`~/.dsh/profiles/web/node_modules/@dsh-external/dsh-legion-services` 已建成
**junction → 本仓库 `services-plugin/`**，改代码即时生效（重启 Desktop 或等 profile 热重载即可）；
若曾重跑 `pnpm install`（会把 junction 替换回复制快照），需按
`Remove-Item` + `New-Item -ItemType Junction` 重建。其余 `file:` 插件（`plugins/`、`team-hub/src`、
`board-plugin/`）同理按需处理。手动三件套命令保留作独立调试用（如上）。

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
- 右侧「当前任务集」= 当前空间任务按角色泳道（只显示该空间）；**每岗任务列表按状态排序**（🟢 进行中 → 🟡 待验收/受阻 → ⚪ 待认领 → ✅ 已完成），默认显示前 3 条 + 「▾ 展开全部 N 个任务（M 未完成）」一键展开为该岗**全量任务**（可滚动，任意条点进详情）；折叠/展开状态按岗位记忆。
- **点任务行 → 任务详情弹窗**：
  - **🤖 AI 执行过程**：执行该任务的 AI 沉淀的过程记录（evidence + 评论时间流）——AI 的每一步行动/产出/汇报都在这，是「任务详情看到 AI 工作过程」的落点；
  - **🧾 审计（改动 × 证据，L1/L2）**：任务收尾（🟡 待验收/✅ 已完成）时展示**改动文件清单**（A/M/D/R 徽标 + 行数 ±）→ 逐文件展开 diff、逐文件「✓ OK / ✘ 有问题」批注（存 `reviewNotes`）、整体结论一键批注；测试报告（✅/❌ + 失败用例）、产物、多轮补丁同屏；**打回自动把批注拼进原因评论交付下一轮 worker**（守护认领重跑时携带历史反馈，见 §3.9）；
  - **⚠ 并行改动重叠（L3）**：本任务改到的文件若同时被其他任务改动（如并行波次同改一个文件），审计区顶部黄色警示列出对方任务与状态（🟢进行中=活风险）——验收/合入前先想合入顺序（见 §3.9）；
  - **⏱ 进展时间线**：goal:publish / claim / transition / comment / patch / review-note / evidence / reassign 等审计动作（`GET /api/activity?taskId=`）；
  - 📋 描述、🎯 验收标准、🚧 边界（做什么 ✅ / 不做什么 🚫）、🔗 依赖提示、创建/更新时间；
  - **状态操作**（按状态出现）：todo →「▶ 开工 / 🔒 认领」；in_progress →「📮 提交验收 / 归还待办」；in_review →「✓ 验收通过（仅将军）/ ↩ 打回重做（附原因 + 审计批注）」；blocked →「解阻」；另有「💬 评论/记录」「转派」与「🤖 派 AI 执行」。
- **进行中的任务不再误导**：已认领并派工的任务显示「🤖 AI 执行中（已派工）」禁用按钮（防重复派发），过程区文案说明 AI 正在执行、完成/异常自动沉淀——不会再出现「状态进行中却提示还没有 AI 执行」的观感错位。

### 3.4 发布目标与自动建链
- 底部「🎯 发布目标」（选中具体空间后可用）→ `POST /api/goal`：重复发布会**取消**同空间旧的 `[auto-goal]` 未完成任务，再按编队生成新阶段链（`soldier=role`、`priority=high`、`blockedBy=前一任务`）。
- **验收标准 + 边界必带**：拆出的每个阶段任务都**自动生成验收标准与边界**（做什么/不做什么，按岗位模板 `team-hub/stage-standards.mjs`，如编码任务=满足验收并真实跑通 typecheck/build、不 push 不越权；需求阶段=逐条覆盖诉求并写清范围外事项）。任务详情、执行提示词、调度弹窗同步注入，杜绝「没标准就干、凭感觉验收」。手动建任务（`POST /api/create`）留空同样自动注入，可传自定义 `acceptance`/`boundary` 覆盖；服务启动时会为历史在途目标链任务自动补种。
- 目标进度（done/total/percent）显示在中央目标卡与场景进度环。

### 3.5 任务调度与验收
- 底部「🗓 任务调度」→ 中枢调度弹窗：全部任务按状态分组 + 统计条；待验收任务默认展开（打回/通过引导）；任务行可点进详情。

### 3.6 自动交接（守护全自动流水线，含写码）
- **任何 agent 环节产生的任务自动交接给对应岗位 agent 实现**：守护（scrum-worker）每 `intervalMs` 扫单，凡「角色在流水线（roles.json 8 岗）、依赖已解除、未被将军拦截、未全局暂停」的 todo/blocked 任务，即自动认领并按该岗位派 AI 执行；上一环验收 done → 下一环自动解锁、下轮自动接管，需求→方案→拆解→用例→编码→审查→测试→部署自动流转。
- **方案/设计类阶段有人工闸门**：roles.json 里配了 `gate` 的阶段（当前 = **方案搜索 researcher**）完成并合入主分支后**停在 🟡 in_review**，且要求交付的产物文档（`artifact`，方案搜索 = `docs/RESEARCH.md`）必须存在；**将军确认方案后才流转**：✓ 验收通过 → 守护自动流转到「任务实施方案构建 + 任务拆解」；↩ 打回附原因 → 士兵按反馈修订重做。需要其他阶段也人工把关时，在 roles.json 对应阶段加 `"gate": true`（可配 `"artifact"` 强制产物文档）。
- **将军干预（任意时刻）**：
  - 🖐 **拦截 / 🚀 放行**（任务详情与调度台，`POST /api/hold`）：拦截后守护不再认领/执行该任务，直到放行；
  - 🔁 **转派**：任务 soldier 与 role 一并改为目标岗位（转派给流水线外岗位则成为人工托管任务）——转派后仍由对应 agent 自动接管执行；
  - ↩ 打回重做（附原因）· ⏸ 全局暂停（CommandBar，`control.json`）· 单角色/单空间也可用模型配置区分执行强度。
- **疑问自动拦截（❓ 待将军确认）**：任何环节的士兵遇到**必须将军拍板**的疑问（关键歧义/越权取舍/缺失输入）时不臆断硬做——任务转 blocked 并在界面给出醒目的「❓ 待将军确认」徽标，评论里列明问题与倾向；守护**不自动重跑**，等将军在本任务评论答复后，下一轮自动带着答复续做（也可先 🖐 拦截/转派）。
- 「⚡ 持续执行编排」与任务详情「🤖 派 AI 执行」是另一条**执行守护（将军 agent 侧）**通道（`POST /api/exec` 开关 / `POST /api/exec/request` 派活、`GET /api/exec/queue` 仅列非写码类）；与守护自动交接互不冲突。后台表：`exec_state`、`exec_requests`。

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

### 3.8 三中心：对话 / 文件 / 浏览器（左侧模块，随时可用）
- **💬 对话中心**（`ChatPanel`）：随工作空间隔离的会话（team-hub v2 `/api/chat/*`，scope 分区）。选中**具体空间**后新建会话/发消息（Enter 发送，≤8000 字符），历史经 `GET /api/chat/messages` 恢复；跨标签页/跨端实时送达走中枢**单一 `/api/events` SSE 按 `chat:*` kind 过滤**（不新增事件源）。消息按纯文本渲染（安全：不执行任何 HTML/脚本）。
- **📁 文件中心**（`FilesPanel`）：浏览当前空间**绑定的本地文件夹**（`local_dir`；未绑定 → 面板引导到「⚙ 空间设置」绑定）。列表（目录在前/大小/时间/含 `.git` 仓库标记）→ 点目录逐层进入、点文件预览（大文本截断带行数提示、二进制提示不可预览）、下载字节一致；写操作（上传/新建目录/重命名/删除）经 serve.mjs `/api/files/*`——**仅回环 + 写需令牌**（`--token`），覆盖需二次确认（`overwrite=1` 语义）、删除需 `confirm=yes` 弹确认、`.git` 内部受保护、路径越界（`../`/盘符/符号链接出根）一律拒绝。
- **🌐 浏览器助手**（`BrowserPanel`）：地址栏输入 → serve.mjs `/api/web/fetch` **SSRF 防护代理**抓取：协议白名单（仅 http/https）、私网/回环/混淆 IP/域名解析到内网一律 `ssrf_blocked`（界面文案「已拦截：禁止访问内网地址」）、重定向逐跳再校验、限长（默认 2MiB）与整链总超时（默认 10s，含重定向共享 deadline、不逐跳重置，P0-3）可配；正文按结构化文本返回（title/正文/摘要/链接），SPA 空壳给明确提示不伪造正文。无 scheme 自动补 `https://`，最近地址可复用（datalist）。抓本地 mock 页做演示需以 `DSH_WEB_FETCH_ALLOW_PRIVATE=1` 启动 serve.mjs（生产默认关闭，勿在公网开启）。
- 左侧 QuickTools「文件浏览 / 浏览网页」与侧栏模块入口指向同一面板（`active` 状态一致）；**📅 日程日历 / 🔔 通知中心仍为占位模块**（点击给提示，P1 后续阶段接入）。
- **🧩 技能中心**：注册技能 → 将军发布/驳回 → 按成员或 `scope:xxx` 授权（士兵只读已发布技能）。
- **右侧「实时动态」**：SSE 审计流；顶部 KPI：目标/完成/进行中/AI 员工数。
- **底部命令栏**：⏸ 全局暂停（v1）/ 🗓 任务调度 / 🎯 发布目标 / ⚙️ 模型配置 / ＋ 新建任务 / 📤 导出日报。

### 3.9 任务收尾审计（L1–L3，Codex 式改动审计）
> 完成的任务怎么放心？Legion 把「**改了哪些文件 → 每处改了什么 → 谁和它改重了**」沉淀成任务自己的审计工作台（任务详情「🧾 审计」区），验收/打回都在同一视图内完成。

- **L1 改动文件清单 + diff（结构化补丁）**：守护在合入 worktree 改动时用 `git diff --numstat/--name-status` 解析，经 `POST /api/patch` 结构化登记（`files:[{path,status,add,del}]` + 全量 diff，任务 `patches` 列，≤40 条/40 条目上限）；详情审计区逐文件展开该文件自己的 hunks，多轮补丁历史可见。
- **L2 逐文件批注 + 打回闭环**：`POST /api/review-notes` 保存任务/文件级批注（`ok|issue|clear`，`review_notes` 列，全部留 audit）；「↩ 打回重做」自动把 issue 批注拼进原因评论 → 守护下次认领时把历史有效反馈（打回原因/批注）**带进 worker 提示词**，修复不丢上下文。
- **L3 跨任务改动重叠**：`GET /api/overlaps?scope=&id=` 扫描空间内所有带补丁记录的任务，按「改到同一文件」分组（≥2 任务）；任务详情自动标出**并行波次同改文件**的对方任务与状态（与 in_progress/in_review 重叠 = 黄色活风险，提醒合入顺序与语义冲突）。
- **派工即时可见**：守护派工成功即写 `🟢 已派 AI worker 开始执行（worker=…，隔离 worktree=…）` 评论——任务从认领那刻起「AI 执行过程」就有内容，不再空窗到结算。
- **证据同屏**：结构化测试报告（`testReport`，D7' 切片闸门 ✅/❌ + 失败用例/复现）+ 产物（`artifacts`，url 可点开）与 diff、批注并列同一审计区。
- 数据流：`POST /api/patch`（结构化登记）· `POST /api/review-notes` · `GET /api/overlaps`；UI 在 `TaskDetailModal`（审计工作台）。

---

## 4. team-hub v2 一览（:8787）

- **存储**：`team-hub/team.db`（SQLite WAL）。表：`tasks` / `members` / `roster` / `skills` / `audit` / `spaces` / `goal` / `exec_state` / `exec_requests` / `agent_models`。
- **写纪律**：所有 POST 经统一 `handleWrite`，`by`（操作者）必填；每次写都落 `audit` 并 SSE 广播。
- **状态机**：`todo → in_progress → in_review → done`（`done` 仅 `by='general'` 从 `in_review` 验收）；`blocked` 受依赖阻塞（`force` 可绕）；乐观锁 `ifVersion`。

| 域 | 接口 |
| --- | --- |
| 任务 | `GET /api/board?scope=` · `GET /api/task?id=` · `POST /api/create /claim /transition /advance /reassign /release-stale /comment /heartbeat` |
| 审计 | `POST /api/patch`（结构化：files[{path,status,add,del}]+diff）· `POST /api/review-notes`（任务/文件批注 ok/issue/clear）· `GET /api/overlaps?scope=&id=`（跨任务改动重叠，L3） |
| 目标 | `GET /api/goal?scope=` · `POST /api/goal`（upsert + 自动建链） |
| 进展 | `GET /api/activity?scope=|taskId=|limit=`（审计时间线） |
| 空间/编队 | `GET /api/spaces`（含仓库绑定 `localDir`/`remoteUrl`） `/api/roster?scope= /api/agents` · `POST /api/spaces /api/spaces/{id}/agents /api/agents` |
| 技能 | `GET /api/skills` · `POST /api/skills/register /review /grant` |
| 执行编排 | `GET/POST /api/exec`（开关） · `GET /api/exec/queue`（自动队列） · `POST /api/exec/request`（手动派活） |
| 模型配置 | `GET/POST /api/models` · `POST /api/models/clear` |
| 对话（S1） | `GET/POST /api/chat/conversations` · `GET/POST /api/chat/messages`（scope 分区，审计+SSE 留痕；表 `conversations`/`messages`） |

---

## 4.1 三中心接口（workbench 同源 / 经 /hub 代理）

| 域 | 接口 | 说明 |
| --- | --- | --- |
| 对话 | `GET/POST /hub/api/chat/conversations`、`/hub/api/chat/messages` | 经 serve.mjs `/hub/*` 反向代理到 team-hub（:8787）；写=统一 handleWrite（by=general）+ 审计/SSE |
| 文件（只读） | `GET /api/files/list`、`/api/files/read`、`/api/files/download`（`?scope=&path=`） | 仅回环；scope 的 `local_dir` 即根；越界/`.git` 内部 403 |
| 文件（写） | `PUT /api/files/upload`（`overwrite=1`）· `POST /api/files/mkdir|rename|delete` | 仅回环 + 写需令牌（`--token` / `DSH_WORKBENCH_TOKEN`，无令牌=不要求）；409/413/400 语义；上传 Content-Length 预检 + 流式限长，临时文件原子发布——中断/超限不破坏原文件（P0-1） |
| 浏览器 | `POST /api/web/fetch`（body `{url, maxBytes?, timeoutMs?}`） | 仅回环；SSRF 防护代理 + 正文抽取；错误 `{ok:false, error, code}` |

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
| 对话中心提示「需要中枢」 | team-hub 没起或被探测失败：`node team-hub\server.mjs`（:8787）后刷新；写被 401 → 右上角「🔑 令牌」填对 token |
| 文件中心提示未绑定/400 | 该空间没绑本地文件夹 → 侧栏空间行「⚙」绑定；「越界/.git 403」= 目标在文件根之外或仓库内部，属于预期保护 |
| 浏览器助手「已拦截：禁止访问内网地址」 | SSRF 防护默认拒绝私网/回环目标；抓本地 mock 需 `DSH_WEB_FETCH_ALLOW_PRIVATE=1` 起 serve.mjs |

---

## 附录

**关联文档**
- `workbench/README.md` — 军团指挥台细目（组件/数据流/各功能实现位置）
- `scrum/README.md` — v1 看板协议与 taskctl 命令手册（遗留引擎）
- `docs/ORCHESTRATION-V3.md` — v3 切片流水线编排（并行波次 / D7' 机器闸门 / 类型化槽位，含审计闸门设计）
- `docs/P0-CONFIRMATION.md` — P0 关键缺陷修复确认（含 §9 现场验收记录与审计相关修复）
- `docs/P1-LIVE-ROLLOUT.md` — P1 现场验收与真实软件空间流水线滚动记录
- `team-hub/server.mjs` — v2 中枢源码（表结构与全部路由以代码为准）
- `LEGION.md` — 军团规则（注入执行 agent 提示词）

**关键路径**
- 中枢数据库：`team-hub/team.db`
- 工作台源码：`workbench/src/`（组件在 `components/`）
- 编队播种：`node team-hub/scripts/seed-roster.mjs`
- v1 任务库：`scrum/tasks.json`

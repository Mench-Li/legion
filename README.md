# Legion —— AI Office 军团作战平台

Legion 是一套本地优先的多智能体协作与交付平台。人类以“将军（general）”身份在 Web 军团指挥台发布目标、组织工作空间和编队；守护进程把目标拆出的阶段任务交给对应智能体执行，并把过程、补丁、测试证据、产物和验收记录统一沉淀到任务中。

日常主入口是 **workbench 军团指挥台**，数据与 API 中枢是 **team-hub v2**。Scrum 的用户界面已经合入 workbench 的“任务中心”：其中既有按状态聚合的“指挥总览”，也有可拖拽的“Scrum 看板”。仓库中的 `scrum/` 仍保留 v1 数据/协议引擎和 `:4820` 独立页面，用于兼容、迁移、调试和历史对照，不再是日常主入口。

> 需要逐项操作说明时，请阅读 [功能使用手册](docs/FEATURES.md)；部署、验证和回滚以 [部署手册](docs/DEPLOY.md) 为准。

---

## 1. 当前形态

| 层 | 组件 | 默认地址 | 职责 |
| --- | --- | --- | --- |
| 指挥面 | `workbench/` | `http://127.0.0.1:5173` | 空间与编队、目标、任务中心、3D 总览、调度验收、对话/文件/浏览器、规范、技能、日历和通知 |
| 数据面 | `team-hub/server.mjs` | `http://127.0.0.1:8787` | SQLite 数据、HTTP API、写入纪律、任务状态机、审计和 SSE 事件流 |
| 执行面 | `plugins/` | DSH 宿主内 | 扫单、认领、派工、隔离 worktree、自动交接、合入调解、对话回复和经验召回 |
| 生命周期 | `services-plugin/` | DSH Desktop 内 | 随 Desktop 自动启停 8787 / 5173 / 4820，异常退出退避重启 |
| 兼容面 | `scrum/`、`board-plugin/` | `http://127.0.0.1:4820` | v1 任务库、独立看板和 DSH 内嵌兼容视图 |
| 独立应用 | `whiteboard/` | `http://127.0.0.1:8080` | 零第三方运行时依赖的多人实时协作白板；不属于 Legion 核心三件套 |

当前仓库定位为本机或局域网自托管的 **acceptance 基线**。仓库级发布门禁可全量跑通，但生产发布仍应按部署文档执行 go/no-go 检查，并先处理“已知限制”中的对话健康状态问题。

---

## 2. 架构与数据流

```text
将军（浏览器）
   │  选择空间 · 发布目标 · 调度 · 审查 · 验收
   ▼
workbench :5173
   ├─ /hub/* ───────────────▶ team-hub v2 :8787 ──▶ team.db / uploads
   ├─ /api/files/* ─────────▶ 空间绑定的本地目录
   └─ /api/web/fetch ───────▶ 带 SSRF 防护的正文抓取代理
                                  │
                                  │ 任务队列 / 审计 SSE / 回复队列
                                  ▼
                         dsh-scrum-worker 守护
                                  │
                    认领 · 派智能体 · 验证 · 合入 · 回写
                                  ▼
                     w/<任务ID> 隔离分支与 worktree

兼容路径：scrum v1 :4820（tasks.json / taskctl / 独立页面）
独立子项目：whiteboard :8080（Node + WebSocket + SQLite）
```

核心约束：

- `team-hub` 是 v2 任务、空间、目标、会话、技能、规范和审计的事实源；SQLite 使用 WAL。
- 所有 v2 写请求统一校验操作者 `by`，写入后落审计并通过单一 SSE 流广播。
- workbench 默认消费 v2；“Scrum 看板”是任务中心中的一种视图，不等同于继续使用 v1 `tasks.json`。
- 守护按工作空间解析绑定仓库，在 `w/<任务ID>` 隔离分支工作；该类分支由 pre-push 守卫禁止直接推送。
- 用户可见行为说明以 `docs/FEATURES.md` 为准，接口和表结构最终以 `team-hub/server.mjs` 为准。

---

## 3. 环境要求

- Windows + PowerShell 是当前主要运行和文档示例环境。
- Node.js **≥ 22.5**，需要内置 `node:sqlite`。
- workbench 构建使用 pnpm；依赖已经安装时无需联网。
- 自动派工、AI 对话回复和模型选择依赖 DSH Desktop / DSH Web 宿主及可用模型配置。
- 生产或共享环境应配置写令牌、限制监听地址，并在升级前备份数据库和附件目录。

检查环境：

```powershell
node --version
pnpm --version
git status --short --branch
```

---

## 4. 快速开始

### 4.1 推荐：随 DSH Desktop 自动启停

`@dsh-external/dsh-legion-services` 会在 DSH Desktop 的 web profile 中托管三件套：

- team-hub v2：`:8787`
- workbench：`:5173`
- scrum v1 兼容服务：`:4820`

Desktop 启动时自动拉起，端口已经被监听时跳过重复启动；子进程异常退出时按退避策略自愈，Desktop 退出时统一回收。状态日志写入仓库根目录 `.legion-services.log`。

profile 的 `cordis.patch.yml` 必须显式配置 `legionDir`。开发态建议把 profile 中的 `@dsh-external/dsh-legion-services` 建为指向本仓库 `services-plugin/` 的 junction；重新执行 `pnpm install` 后如 junction 被依赖快照替换，需要重建。

完整启动与托管说明见 [功能手册：安装与启动](docs/FEATURES.md#31-安装与启动)。

### 4.2 手动启动三件套

需要独立调试时，在三个 PowerShell 窗口中运行：

```powershell
# 窗口 1：team-hub v2（必需）
cd D:\project\DSH\legion
node team-hub\server.mjs
```

```powershell
# 窗口 2：workbench（必需）
cd D:\project\DSH\legion\workbench
pnpm build
node scripts\serve.mjs --port 5173
```

```powershell
# 窗口 3：scrum v1 兼容服务（可选）
cd D:\project\DSH\legion
node scrum\serve.mjs --port 4820 --host 127.0.0.1 --token legion-kanban-4820
```

workbench 的 `:5173` 托管构建产物，不是热更新开发服务器；修改前端源码后必须重新执行 `pnpm build` 并刷新页面。前端开发模式可在 `workbench/` 下执行 `pnpm dev`。

### 4.3 就绪检查

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/config
Invoke-WebRequest http://127.0.0.1:5173/ -Method Head
Get-Content .legion-services.log -Tail 30
```

浏览器打开 `http://127.0.0.1:5173`，确认顶部“🧭 中枢”可达；若页面仍显示旧界面，执行 `Ctrl+F5` 强制刷新。

### 4.4 三分钟体验循环

1. 在左侧选择一个具体工作空间。
2. 点击底部“🎯 发布目标”，输入目标并发布。
3. 在中央目标卡查看目标状态、版本和阶段链进度。
4. 从“📋 任务中心”或右侧“当前任务集”打开任务详情。
5. 查看 AI 执行过程、时间线、验收标准、边界、补丁、测试报告和产物。
6. 对人工闸门任务执行“✓ 验收通过”或“↩ 打回重做”；其余流水线阶段由守护自动推进。

完整操作见 [功能手册：三分钟体验循环](docs/FEATURES.md#23-三分钟体验循环)。

---

## 5. 功能总览

README 只保留入口和边界，逐步操作、预期结果及功能索引统一放在 `docs/FEATURES.md`。

### 5.1 工作空间与编队

工作空间是真实数据分区，可维护名称、专属角色编队、本地目录和远程仓库绑定。新建空间时可从全局智能体目录选人入编；删除空间前展示任务、目标、会话、技能等影响，并要求精确输入确认文本。`software` 和 `default` 为受保护空间。

详见 [功能手册：空间与专属编队](docs/FEATURES.md#32-空间与专属编队)。

### 5.2 中央视图与智能体状态

首页提供 3D 办公场景和智能体总览，按进行中、待验收、受阻、待命显示状态；点击智能体可查看其运行中、待办和已完成任务，并继续进入任务详情。

详见 [功能手册：中央视图](docs/FEATURES.md#33-中央视图)。

### 5.3 任务中心、当前任务集与详情

“📋 任务中心”已经把原 Scrum 使用体验合入 workbench：

- “🖥 指挥总览”按工作中、待我决定、待办、已完成聚合任务。
- “📋 Scrum 看板”按状态泳道展示；在中枢模式下可拖拽迁移。
- 任务中心、当前任务集、智能体任务清单和调度台共用任务详情。
- 详情展示描述、验收标准、边界、依赖、AI 执行过程、审计时间线、结构化补丁、测试结果、产物和评审批注。

详见 [功能手册：当前任务集与任务详情](docs/FEATURES.md#34-当前任务集与任务详情)及 [workbench 说明](workbench/README.md)。

### 5.4 目标与流水线

每次发布都会创建独立目标 `G-*`，目标带状态、版本、文档目录和自己的任务链；同一空间可并行推进多个目标。默认软件流水线为：

```text
需求澄清 → 方案搜索 → 任务拆解 → 测试用例设计
        → 编码实现 → 代码审查 → 测试执行 → 部署与 CI/CD
```

目标可使用传统 `chain` 模式，也可由任务拆解文档展开为 `slice` 模式：各切片形成 `coder_Si → tester_Si` 微链，多个切片并行，最后由目标级 devops 任务收尾。

详见 [功能手册：发布目标与自动建链](docs/FEATURES.md#35-发布目标与自动建链)和 [编排架构 v3](docs/ORCHESTRATION-V3.md)。

### 5.5 自动交接、闸门与人工干预

守护周期扫描已解依赖且未被拦截的任务，自动认领并派发对应角色智能体。需求澄清和方案搜索是人工闸门；普通中间阶段通过验证后可自动合入并继续流转；最终 devops 阶段在门禁和证据完成后自动合入并收官。合入失败、内容冲突或机器门禁失败时会停下并给出可处理状态。

将军仍可随时：

- 对单任务执行“🖐 拦截自动 / 🚀 放行”；
- 全局暂停或恢复守护；
- 转派任务、补充评论、打回重做；
- 对人工闸门做最终裁决；
- 处理必须由人决策的“❓ 待将军确认”任务。

详见 [功能手册：自动交接与守护流水线](docs/FEATURES.md#37-自动交接与守护流水线)。

### 5.6 调度、验收与审计

任务调度台按状态集中展示任务，待验收默认展开。审计工作台提供：

- L1：文件级改动、A/M/D/R 状态、增删行数和 diff；
- L2：逐文件与整体批注，打回时自动把问题交给下一轮 worker；
- L3：跨任务文件重叠检测，提示并行修改风险；
- 测试报告、产物和多轮补丁同屏关联。

详见 [功能手册：任务调度与验收](docs/FEATURES.md#36-任务调度与验收)和 [功能手册：任务收尾审计](docs/FEATURES.md#315-任务收尾审计)。

### 5.7 模型配置

每个空间可按角色设置默认模型；守护按照回复设置、角色模型配置和宿主默认值的优先级解析实际模型。候选模型来自本机 DSH 配置，UI 按轻量、均衡、旗舰/强推理和视觉分组。

详见 [功能手册：模型 × 智能体配置](docs/FEATURES.md#38-模型-智能体配置)。

### 5.8 对话中心

对话中心按空间隔离会话和消息，支持历史分页、SSE 实时更新、AI 直答三态和失败重试。当前上下文输入包括：

- 从“全部空间”视图选择工作空间开始对话；
- 自动注入该空间绑定仓库的只读摘要；
- 每条消息上传最多 3 个 UTF-8 文本附件，单个默认不超过 10 MB；
- 外部上下文默认总预算 8000 字符，优先保留显式附件；
- 每空间配置 AI 回复开关、模型、身份和 system hint；
- 健康点展示守护在线、回复开关、模型解析和最近失败状态。

附件正文不进入消息 `body`，只以引用关联该次回复；暂存孤儿默认 24 小时清理，已绑定附件默认保留 7 天。模型“已解析”不等于 provider 一定可用，实际状态以最近回复结果为准。

详见 [功能手册：对话中心](docs/FEATURES.md#39-对话中心)。

### 5.9 文件中心与浏览器助手

文件中心浏览空间绑定目录，支持预览、下载、上传、新建目录、重命名和删除；写操作受令牌、二次确认、根目录边界和 `.git` 内部保护约束。浏览器助手通过服务端代理抓取正文，拒绝私网、回环、链路本地地址和解析后命中内网的目标，并对超时、响应大小与审计留痕设限。

详见 [功能手册：文件中心](docs/FEATURES.md#310-文件中心)和 [功能手册：浏览器助手](docs/FEATURES.md#311-浏览器助手)。

### 5.10 规范、技能与经验知识库

规范按全局规则和空间/项目文件族分层注入；技能支持注册、复审、发布、跨空间授权和撤销。守护还维护经验知识库闭环：

```text
任务完成
  → 按打回/验收/评语计算摩擦分
  → docs/experience/drafts/<任务ID>.md
  → 统一索引与派工自动召回
  → procedure 晋升为 skill，declarative 晋升为 learning
```

召回内容会进入士兵提示词；真实召回和将军采纳会回灌晋升判断，并保留来源与晋升去向。P2 验收入口见 [经验知识库验收方案](docs/acceptance/P2-acceptance.md)。

详见 [功能手册：规范中心与分层规范](docs/FEATURES.md#312-规范中心与分层规范)及 [功能手册：技能中心](docs/FEATURES.md#313-技能中心)。

### 5.11 日历、通知与实时动态

日历按空间展示月视图事件；通知中心从审计流派生需要关注的变化。右侧实时动态消费 team-hub SSE，顶部 KPI 汇总目标、完成、进行中和 AI 员工数。

详见 [功能手册：日程日历与通知中心](docs/FEATURES.md#314-日程日历与通知中心)。

---

## 6. 状态机、隔离与文档产物

### 6.1 任务状态

主要状态流为：

```text
todo → in_progress → in_review → done
  └───────────────→ blocked
```

- `blockedBy` 未解除的任务不会被守护提前认领。
- `hold` 是将军对自动化的显式拦截，不等同于业务阻塞。
- 写操作支持 `ifVersion` 乐观锁；版本过期返回冲突。
- 人工任务和人工闸门由 general 验收；机器闸门和已授权流水线阶段可由守护按规则自动推进。

### 6.2 Git 隔离与合入

- 每个需要改仓库的任务使用 `.legion-worktrees/<任务ID>` 和分支 `w/<任务ID>`。
- worker 只在自己的 worktree 中修改、构建和提交。
- `w/*` 分支禁止直接 push；守护在验证通过后合入目标仓库主分支。
- 无冲突时自动合入；内容冲突交给调解流程，无法安全解决时保留分支并转人工处理。
- 守护重启会回收自己遗留的 `in_progress` 任务并复用已有 WIP。

### 6.3 目标级文档

新目标使用 `docs/<goalId>/` 隔离阶段文档，典型文件为：

```text
docs/<goalId>/
  REQUIREMENTS.md
  RESEARCH.md
  TASK_BREAKDOWN.md
  TEST_CASES.md
  TEST_REPORT.md
  DEPLOY.md
  T<任务ID>-evidence/
```

旧目标可能仍使用根 `docs/` 的同名槽位；这是兼容行为。目标级目录、闸门校验和派工提示词必须使用同一个 `docsDir`，避免并行目标互相覆盖。

---

## 7. team-hub v2 数据与接口

### 7.1 数据

默认数据库为 `team-hub/team.db`，附件目录与数据库同基路径保存。主要数据域包括：

- 任务、成员、编队、工作空间和目标；
- 审计、补丁、评审批注、执行状态和执行请求；
- 角色模型、规范、技能及跨空间授权；
- 对话会话、消息、回复设置和附件；
- 日历事件。

服务启动时通过 `CREATE TABLE IF NOT EXISTS` 和兼容补列做幂等迁移。升级前应同时备份 `team.db`、`team.db-wal`、`team.db-shm` 和 `uploads/`。

### 7.2 常用接口域

| 域 | 代表接口 |
| --- | --- |
| 任务 | `GET /api/board`、`GET /api/task`、`POST /api/create|claim|transition|advance|reassign|comment|heartbeat` |
| 目标 | `GET/POST /api/goal`、`POST /api/goal/status`、`POST /api/goal/slices` |
| 审计 | `GET /api/activity`、`POST /api/patch`、`POST /api/review-notes`、`GET /api/overlaps` |
| 空间与编队 | `GET /api/spaces|roster|agents`、`POST /api/spaces`、`POST /api/spaces/delete` |
| 执行与模型 | `GET/POST /api/exec`、`GET /api/exec/queue`、`GET/POST /api/models` |
| 对话 | `/api/chat/conversations`、`/messages`、`/replies`、`/reply-settings`、`/health`、`/attachments` |
| 规范与技能 | `GET/POST /api/rules`、`GET /api/skills`、`POST /api/skills/register|review|grant|revoke` |
| 日历 | `GET/POST /api/calendar/events`、`POST /api/calendar/events/delete` |
| 事件 | `GET /api/events`（统一 SSE 审计流） |

完整语义见 [功能手册：team-hub 数据与接口一览](docs/FEATURES.md#316-team-hub-数据与接口一览)。

---

## 8. 开发与验证

### 8.1 常用开发命令

```powershell
# workbench 类型检查 + 生产构建
pnpm --dir workbench build

# team-hub 测试
node --test team-hub/*.test.mjs

# 守护插件构建与测试（构建需要 DSH_CHECKOUT）
$env:DSH_CHECKOUT = 'D:\project\DSH\dsh\deepseek-harness'
pnpm --dir plugins build
node --test plugins/tests/*.test.mjs

# whiteboard 构建与测试
node whiteboard/scripts/build.mjs
node --test whiteboard/packages/shared/test/*.test.mjs whiteboard/apps/server/test/*.test.mjs

# 只检查持久产品文档
node scripts/ci/check-docs.mjs
```

### 8.2 仓库级发布门禁

```powershell
node scripts/ci/run-ci.mjs
```

门禁按顺序执行：

1. `env`：Node、平台、仓库和 `node:sqlite` 环境；
2. `deps`：依赖可用性与 workbench junction；
3. `build`：whiteboard 与 workbench；
4. `test`：对话、技能、日历、文件、浏览器、契约和白板测试；
5. `smoke`：真实服务进程、代理、SSE、鉴权和主要写读路径；
6. `stage`：生成发布快照、清单和 SHA256；
7. `doc`：README 与功能手册的结构、锚点、去重和关键入口一致性。

运行证据默认写入 `.ci/<时间戳>/`，发布快照写入 `releases/`；两者是本地运行产物。当前 HEAD 已通过七阶段门禁，后续提交仍应重新运行，以本次输出为准，不依赖 README 中的历史数字。

---

## 9. 部署、配置与运维

### 9.1 关键端口

| 端口 | 服务 | 是否核心 |
| --- | --- | --- |
| `5173` | workbench 生产构建托管 | 是 |
| `8787` | team-hub v2 | 是 |
| `4820` | scrum v1 独立兼容页 | 否 |
| `8080` | whiteboard | 否 |

### 9.2 对话相关环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHAT_REPLY_TIMEOUT_MS` | `120000` | AI 回复超时 |
| `CHAT_DAEMON_ONLINE_MS` | `60000` | 守护在线判断窗口 |
| `CHAT_ATTACH_MAX_BYTES` | `10 MB` | 单附件上限 |
| `CHAT_ATTACH_MAX_PER_MSG` | `3` | 单消息附件数量 |
| `CHAT_CTX_BUDGET_CHARS` | `8000` | 空间摘要与附件总字符预算 |
| `CHAT_ATTACH_STAGED_TTL_MS` | `24 h` | 未绑定暂存附件保留期 |
| `CHAT_ATTACH_TTL_MS` | `7 d` | 已绑定附件保留期 |
| `CHAT_ATTACH_BLACKLIST_EXT` | 内置黑名单 | 禁止作为文本上下文的扩展名 |

### 9.3 发布与回滚

发布前至少完成：

- 全量 CI 门禁 exit 0；
- 备份 team-hub 数据库及附件目录；
- 重建 workbench 产物和 plugins `lib/`；
- 重启或重载 team-hub、workbench 和 DSH 守护插件；
- 做 8787 / 5173 探活、守护心跳、真实 AI 回复与浏览器主路径抽验；
- 确认已知缺陷、回滚 commit 和上一版 `dist` 快照。

环境分级、发布清单、回滚命令及变更影响见 [部署手册](docs/DEPLOY.md)。

---

## 10. 仓库地图

```text
legion/
├─ workbench/          React 19 + Vite 军团指挥台
├─ team-hub/           v2 SQLite 数据/API/审计/SSE 中枢
├─ plugins/            dsh-scrum-worker 守护插件
├─ services-plugin/    DSH Desktop 三件套生命周期托管
├─ board-plugin/       DSH 内嵌 Scrum 兼容面板
├─ scrum/              v1 tasks.json/taskctl/独立看板引擎
├─ whiteboard/         独立多人实时协作白板
├─ mesh/               早期持久士兵消息总线协议与记录
├─ workflows/          士兵提示词与批量执行模板
├─ scripts/ci/         仓库级 CI、发布暂存与文档门禁
├─ tests/contract/     可执行行为契约
├─ docs/               产品、架构、目标链、评审、证据和经验文档
├─ roles.json          软件流水线角色、闸门和文档契约
├─ LEGION.md           派工时自动注入的仓库纪律
├─ PLUGINS.md          插件族现状与路线图
├─ ozon/               军团产出的 Ozon 业务研究与交付物
└─ ozon-api/           Ozon API 参考资料
```

`ozon/`、`ozon-api/` 是平台运行产生和使用的业务域资料，不参与 Legion 核心服务启动。`mesh/` 与 `COMMAND.md` 记录早期持久士兵编排方式；当前自动化主路径以 team-hub + dsh-scrum-worker + ORCHESTRATION-V3 为准。

---

## 11. 文档导航

| 文档 | 用途 |
| --- | --- |
| [docs/FEATURES.md](docs/FEATURES.md) | 用户视角完整功能手册、操作步骤、边界和功能索引 |
| [workbench/README.md](workbench/README.md) | 指挥台组件、交互和数据流细目 |
| [docs/ORCHESTRATION-V3.md](docs/ORCHESTRATION-V3.md) | 切片流水线、机器闸门、并行隔离和目标级文档设计 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 仓库级部署、验证、发布、回滚与已知限制 |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | 根文档槽位对应目标的测试报告；新目标优先看自己的目录 |
| `docs/<goalId>/` | 某一目标的需求、研究、拆解、用例、测试和部署证据链 |
| [scrum/README.md](scrum/README.md) | v1 任务引擎、独立看板、taskctl 和迁移兼容说明 |
| [plugins/README.md](plugins/README.md) | 守护插件构建与注入 |
| [PLUGINS.md](PLUGINS.md) | Legion 插件族现状与路线图 |
| [whiteboard/README.md](whiteboard/README.md) | 独立白板的架构、启动和测试 |
| [LEGION.md](LEGION.md) | 智能体必须遵守的仓库级执行纪律 |

历史上线过程记录保留在 `docs/P0-CONFIRMATION.md`、`docs/P1-LIVE-ROLLOUT.md`、`docs/P2-GOALDOCS-LIVE.md` 和 `docs/P3-PROD-ROLLOUT.md`，用于复盘和复跑，不作为当前产品操作正文。

---

## 12. v1 兼容与迁移

v1 和 v2 可能同时运行，但不要把两套存储当成同一个写源：

- v2：`team-hub/team.db`，是当前工作空间、目标和任务中心的主数据源；
- v1：`scrum/tasks.json`，只为兼容页面、历史插件和迁移保留；
- 迁移：`node team-hub/scripts/migrate-tasks.mjs [--scope software]`，已存在任务 ID 会跳过；
- workbench 任务中心中的“Scrum 看板”在中枢模式下读写 v2，不代表回退到 v1 数据库；
- 独立 `:4820` 页面仍可用于调试、历史对比或尚未迁移的部署。

详见 [功能手册：v1 遗留与迁移](docs/FEATURES.md#317-v1-遗留与迁移)。

---

## 13. 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 页面仍是旧版本 | 在 `workbench/` 重新 `pnpm build`，再 `Ctrl+F5`；`:5173` 不是热更新端口 |
| “🧭 中枢”不可达 | `node team-hub/server.mjs` 是否运行；检查 `:8787/api/config` 与端口占用 |
| 发布目标无响应 | 必须选中具体空间；确认中枢可达、空间编队已播种且写请求带 `by` |
| 任务或动态不刷新 | 检查 `/api/events` SSE；断线后应有轮询兜底；再检查 team-hub 日志 |
| AI 不回或回复失败 | 确认守护在线、回复开关开启、assistant 模型已配置且 provider 可用；查看健康点说明，修复后点“↻ 重试” |
| 附件上传失败 | 只接受 UTF-8 文本；检查 10 MB、3 个附件及扩展名黑名单限制 |
| 文件中心提示未绑定 | 在空间设置中选择本地文件夹；确认目录存在且服务进程有读取权限 |
| 文件写操作 401 | workbench `serve.mjs --token` 启用后，请携带 Bearer、`x-dsh-token` 或查询令牌 |
| 浏览器助手拒绝地址 | 私网、回环、链路本地和 DNS 解析到内网的地址会被 SSRF 防护主动阻止 |
| v1 看板写操作 401 | 使用启动 `:4820` 时配置的 token；只读接口仍可开放 |
| Desktop 自动服务反复退出 | 查看 `.legion-services.log`；确认 `legionDir`、Node 路径和 profile junction |

更完整的“现象 → 处理”对照见 [功能手册：故障排查](docs/FEATURES.md#51-故障排查)。

---

## 14. 安全边界与已知限制

- 默认面向本机或受信任局域网，不应把 5173、8787、4820、8080 未经认证直接暴露到公网。
- GET 读取面不等于公开互联网安全边界；涉及敏感仓库或附件时，应在外层增加网络访问控制。
- 文件中心限制在空间绑定根目录内，并拒绝 `.git` 内部路径；写操作需要令牌和二次确认。
- 浏览器助手做 SSRF、重定向、超时和大小限制，但不替代完整的企业出网代理或内容安全系统。
- 对话附件会在本地 `uploads/` 留存至 TTL 清理；上传前应确认内容可以提供给所配置的模型服务。
- whiteboard v1 是单实例、单进程部署，不承诺横向扩展。
- 当前对话健康聚合仍有两个已登记的中等问题：跨空间守护心跳可能让本空间误显示在线并回退到他空间模型；历史失败可能在后续成功后仍保留为 `lastFail`。它们不阻断构建和 acceptance 使用，但属于生产 go/no-go 前置修复项，详见 `docs/G-mtr3su6f-1/TEST_REPORT.md` 和同目录 `DEPLOY.md`。
- 真实 AI 回复取决于 DSH 守护和模型 provider；自动化测试可以验证数据面、提示词和状态机，但不能把“模型已解析”冒充为外部 provider 一定可用。

---

## 15. 贡献约定

- 修改行为时同步更新 `README.md`、`docs/FEATURES.md` 或对应模块文档。
- 所有实现变更必须至少经过 typecheck、build 或 test 中与风险相称的一项；发布前运行全量 CI。
- 不在 live `team.db` 上运行写入型测试；测试使用临时数据库和隔离服务。
- 不绕过工作空间、`by`、乐观锁、状态机、审计、依赖和验收纪律。
- 不直接 push `w/*` 任务分支；由守护或维护者完成审查后的主分支合入。
- 证据应包含真实命令、关键输出和失败/受限项，不用“应该没问题”代替验证。

Legion 的目标不是让智能体“看起来很忙”，而是让目标、责任、过程、证据、风险和最终决策始终对人类可见。

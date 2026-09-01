# 军团 Scrum 看板（scrum）

参考 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex Taskboard）设计：本地优先的任务看板，agent 通过 CLI 操作，人类通过看板视图"快速看到每个士兵的任务进度与整体 goal 的实现程度"。

## 权威与产物

| 文件 | 角色 |
| --- | --- |
| `tasks.json` | **唯一权威**任务数据库（机器可读） |
| `taskctl.mjs` | 所有任务变更的唯一入口（状态机/乐观锁/认领/依赖/评论/证据） |
| `board.json` | 看板快照（render 生成，goal 进度 + 列 + 卡 + 士兵统计） |
| `KANBAN.md` | 文本看板（可在聊天里直接展示） |
| `kanban.html` | 看板视图：**双击即开**（文件模式，30 秒自动刷新）或通过服务打开（实时模式） |
| `serve.mjs` | 零依赖本地服务：静态文件 + `/api/board` 轮询 + `/api/board/events` SSE + `/api/activity` + `/api/activity/events`（守护动态流） |

刷新看板：`node legion/scrum/render.mjs`（将军每轮结束后运行）。

## 实时模式（免手动刷新）

```bash
node legion/scrum/serve.mjs --port 4820
# 浏览器打开 http://127.0.0.1:4820
```

- 页面通过 HTTP 访问时自动切换**实时模式**：优先 SSE 订阅（board.json 变化即推，就地重渲染），SSE 断线自动降级 5 秒轮询；不再整页刷新。
- 双击 `kanban.html`（file://）仍是**文件模式**：内联数据 + 30 秒自动刷新。
- 将军每轮跑 `render.mjs` 后，所有打开的页面实时更新；`serve.mjs` 需保持运行。

## 写回接口与远程访问

`serve.mjs` 除提供读取接口外，还暴露三个 POST 写接口（看板拖拽写回、脚本、远程调用统一走它们）。写操作复用 `taskctl.mjs` 的状态机/乐观锁/角色纪律；写成功后自动重跑 `render.mjs` 刷新 board.json，fs watch 触发 SSE 广播全端。

```bash
# 局域网共享：监听所有网卡 + 令牌鉴权（其他设备只读访问 http://<本机IP>:4820，写操作需令牌）
node legion/scrum/serve.mjs --port 4820 --host 0.0.0.0 --token <t>
```

- `--token <t>`：启用写接口鉴权；未配置时写操作放行。`/api/config` 返回 `{ auth, host, port }`，页面据此探测是否需要令牌。
- `--host 0.0.0.0`：监听所有网卡（缺省 `127.0.0.1` 仅本机）；局域网内手机/其他电脑经 `http://<本机IP>:4820` 访问。
- 环境变量等价项：`DSH_KANBAN_PORT` / `DSH_KANBAN_HOST` / `DSH_KANBAN_TOKEN`。

令牌携带方式（任选其一）：`Authorization: Bearer <t>`、`x-dsh-token: <t>`、`?token=<t>`。令牌缺失/错误 → `401`；乐观锁版本冲突（`ifVersion` 过期）→ `409`；其余业务错误 → `400`。GET 读取保持开放（看板数据非机密）；跨源调用已开 CORS（`*` + OPTIONS 预检）。

### POST /api/transition —— 状态迁移

```bash
curl -X POST http://127.0.0.1:4820/api/transition -H "Authorization: Bearer <t>" -H "Content-Type: application/json" -d '{"id":"T-001","to":"in_review","by":"soldier-a","ifVersion":3}'
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 任务编号（如 `T-001`） |
| `to` | ✓ | 目标状态，走 taskctl 状态机（非法迁移被拒） |
| `by` | | 操作者（如 `soldier-a` / `general`） |
| `ifVersion` | | 乐观锁版本号（整数），过期返回 409 |
| `force` | | `true` 时跳过依赖等校验 |

### POST /api/create —— 新建任务（backlog）

```bash
curl -X POST http://127.0.0.1:4820/api/create -H "Authorization: Bearer <t>" -H "Content-Type: application/json" -d '{"title":"新任务","description":"...","acceptance":["验收1","验收2"],"priority":"high"}'
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✓ | 任务标题（非空） |
| `description` | | 任务描述 |
| `acceptance` | | 验收标准数组（内部以 `;` 拼接，等价 `--acceptance "a;b"`） |
| `priority` | | 优先级（如 `high`） |

### POST /api/comment —— 追加评论

```bash
curl -X POST http://127.0.0.1:4820/api/comment -H "Authorization: Bearer <t>" -H "Content-Type: application/json" -d '{"id":"T-001","by":"general","text":"退回：请补充验证证据"}'
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 任务编号 |
| `by` | ✓ | 评论者（如 `general` / `soldier-a`） |
| `text` | ✓ | 评论内容（非空，承载退回反馈/需求变更） |

写接口统一返回 `{"ok":true,"task":<taskctl 输出 JSON>}`；脚本可直接 `fetch` 调用（CORS 已开，含 OPTIONS 预检）。

## 士兵守护（自动工人，dsh-scrum-worker）

`@dsh-external/dsh-scrum-worker` 是一个 daemon-loop 形态的守护插件（经 dsh-super-injector 注入 web profile）。它每 `intervalMs` 扫一次任务库，代替人类盯板：

1. **todo 任务** → `claim` 认领（互斥由状态机保证）→ 派一次性 worker subagent（携带任务完整上下文：标题/描述/验收/评论/依赖）→ 完成 → 提交 `in_review` 并附证据评论。
2. **被退回的 in_progress 任务**（认领后出现他人评论，通常是将军把 in_review 拖回并写了原因）→ 派纠错 worker，提示词附最新退回评论，**迭代纠错重做**。
3. **依赖解除的 blocked 任务**（属于本角色）→ 解阻认领 → 续做。

**done 永远留给人类**：守护最多把任务交到 `in_review`；是否真正完成由你在看板上把卡片拖到 Done 决定。

配置（改 `cordis.patch.yml` 中插件行或注入器配置）：`role`（默认 `soldier-auto`）、`intervalMs`（默认 30000）、`maxWorkers`（并发上限，默认 1）、`workerTimeoutMs`（默认 600000）、`staleMinutes`（认领租约分钟数，默认 30，超时自动释放回 todo）、`provider`（默认 `spawn`）、`scrumDir`（默认 `D:/project/dsh/legion/scrum`）、`workspace`（worker 工作目录，默认 `D:/project/dsh`）、`isolate`（worktree 隔离开关，默认 **true**）、`repoRoot`（隔离所用 git 仓库根，默认 `D:/project/dsh/legion`）、`worktreeRoot`（worktree 目录根，默认 `repoRoot/.legion-worktrees`）。

日志：`~/.dsh/super-injector/dsh-scrum-worker.log`（每轮扫单/派工/提交都落盘）。卸载：`dev_uninject_plugin`（匹配 `dsh-scrum-worker`）。

### 进度心跳（P3）与守护能力自述（P6）

- **进度心跳**：士兵/守护用 `taskctl progress <id> --by <角色> --percent <0-100> --note <一句话>` 上报进度（借鉴 agent-network 的 `report_status`）。它是 **append-only 遥测**：不 bump `version`、不改 `updatedAt`，避免与状态迁移的乐观锁互相干扰。看板每张卡显示最新进度条（`board.json` 卡片带 `progress` 字段，`kanban.html` 渲染百分比 + note）。守护在 `claim` 后写 `0% 认领开工`、派工后写 `10% 已派工`（本地模式直接调 taskctl，hub 模式走 `POST /api/progress`）。
- **守护能力自述**：守护每轮扫单结束把自身状态写入 `scrum/daemon.json`（角色/并发/隔离/超时/scope/流水线阶段/当前模型/inbox 计数/本轮时间/uptime）。看板 `GET /api/daemon` 直接返回该文件，`GET /api/config` 附带 `pipeline`（roles.json 阶段）与 `daemon`——将军/用户随时能确认"守护活着吗、在跑哪个流水线、当前用哪个模型"。新增一个守护节点 = 在 `cordis.patch.yml` 加一个 worker 插件配置（`role`/`intervalMs`/`scrumDir` 等），重启后 `daemon.json` 出现即自述成功。

### 军团总指挥部 / 产物挂载 / 待决发光 / 动态预览（借鉴 dsh-worktable）

- **🖥 军团总指挥部（`console.html`，看板右上角入口）**：借鉴 dsh-worktable 控制室的「节点 + 任务实时总览」——顶部守护状态条（角色/模型/流水线/并发/inbox/uptime/最近扫单），三列卡片（⚡ 工作中 / ⏳ 待你决定 = in_review+blocked / ✅ 已完成），每卡带运行时长、进度条、最近评论预览，底部滚动最近动态。数据源 = `daemon.json` + `board.json` + `activity.jsonl`，经 `board/events` SSE + 轮询驱动，**纯 UI、零 Token**。board-plugin 挂在 `/scrum-board/console`，serve.mjs 挂在 `/console.html`。
- **📦 产物自动挂载**：借鉴 dsh-worktable 的 `widget-result.json` 握手——worker 完成时可在 JSON 报告里带 `artifact: {kind:'html'|'file'|'url', path, title}`；守护校验文件存在后 `taskctl artifact <id> --kind --path --title` 登记（hub 模式走 `POST /api/artifact`）。看板卡片显示「📦N 产物」徽标，详情页最新 html 产物直接 **iframe 预览**、file 下载链接、url 跳转。预览端点 `GET /api/artifact?task=<id>[&raw=1]` **只读 tasks.json 里的登记路径**（不读查询串），并做**根白名单校验**（仅 repoRoot + 配置的 `artifactRoots`，防任意文件读取）。
- **✨ 待决发光 + ack**：借鉴 dsh-worktable 的 done/need 提醒镜像——卡片按状态发光（in_review 黄「待你决定」/ blocked 红 / done 绿 / in_progress 蓝），点开详情即 **ack**（localStorage `legion.notifyAck.v1`，同状态不重复亮），状态转移后重新点亮。
- **👁 卡片动态预览**：借鉴 dsh-worktable 的冷会话消息预览（带宽非 Token 成本）——卡片显示最近一条评论的清洗预览（去代码围栏、压缩空白、截断 80 字）。

## 四项加固（隔离 / 动态流 / 租约 / 依赖环）

1. **Git worktree 隔离**（守护 `isolate: true`）：每个任务建独立 worktree（分支 `w/<任务id>`，目录 `<repoRoot>/.legion-worktrees/<任务id>`），worker 在隔离目录干活，互不污染主工作树。完成后改动提交到 `w/<id>` 分支，**promote 显式**：验收通过后 `git -C <repoRoot> merge --no-ff w/<id>`；放弃则 `git -C <repoRoot> worktree remove --force <目录> && git -C <repoRoot> branch -D w/<id>`。守护同时安装公共 pre-push 守卫——`w/*` 分支一律禁止 push（防 worker 误推远程）。
2. **实时动态流**：守护把认领/派工/完成/受阻/释放等生命周期事件写入 `scrum/activity.jsonl`；看板点"⚡ 动态"打开抽屉实时滚动（`/api/activity` + `/api/activity/events` SSE，断线自动降级轮询）。
3. **认领租约**：`taskctl release <id>` 归还任务；`taskctl release-stale --older-than <分钟>` 批量回收认领超时无进展的 `in_progress`（守护每轮自动跑，`staleMinutes` 控阈值）。
4. **依赖环检测**：`taskctl link --blockedBy/--blocks` 建边时检测传递依赖——A↔B 互依或自依赖直接拒绝，避免死锁。

## 多终端接入（手机 / 其他电脑）

两条路线，按需选择：

**路线 A｜看板远程（轻量，已就绪）**：手机/其他电脑直接访问看板并下达任务。

```bash
node legion/scrum/serve.mjs --host 0.0.0.0 --port 4820 --token <看板令牌>
# 手机浏览器打开 http://<台式机IP>:4820 —— 拖拽卡片、新建任务、评论/退回
```

首次使用在页面上点"🔑 令牌"输入 `<看板令牌>`（存 localStorage）；写操作（拖拽/新建/评论）需令牌，读取开放。Windows 防火墙需放行 4820 入站。

**路线 B｜DSH Web GUI 远程（完整能力，需认证）**：从其他电脑/手机使用完整 GUI（对话、发令、看板面板、设置）。

```bash
# 认证门禁 + 监听所有网卡（未带 --auth-token 时 0.0.0.0 会被拒绝）
dsh --profile web --auth-token <GUI口令> --host 0.0.0.0
# 浏览器打开 http://<台式机IP>:3080 → 输入口令（/login）→ 全部页面与 WebSocket 均需认证
```

令牌携带：`Authorization: Bearer` / `x-dsh-token` / `?token=` / 登录后的 `dsh_token` cookie。Windows 防火墙需放行 3080 入站。

**路线 C｜Tailscale 内网（零改动，推荐）**：在台式机与每台设备装 [Tailscale](https://tailscale.com)，登录同一账号后，任何设备直接访问 `http://<台式机Tailscale IP>:3080`（GUI）与 `http://<台式机Tailscale IP>:4820`（看板）——流量经加密隧道，无需开放防火墙、无需 `0.0.0.0`/令牌（可再叠加 `--auth-token` 双保险）。不装 Tailscale 时，局域网访问至少给看板加 `--token`、给 GUI 加 `--auth-token`，绝不要裸绑 `0.0.0.0`。

## Web GUI 侧栏插件（ui-kanban）

`@deepseek-ai/dsh-client-ui-kanban` 在 DSH Web GUI 侧栏底部注册一个"🏛 军团看板"操作项，点击在右侧抽屉内嵌实时看板（SSE 推送）。**启用/停用**在 `packages/bundle/web-app/cordis.patch.yml` 的 `ui-kanban` 行（删除或 `disabled: true` 即卸载）。

- 插件依赖 `serve.mjs`（4820）提供数据；未启动时抽屉显示启动命令提示。
- 看板 URL 是模块常量 `http://127.0.0.1:4820`（部署改端口需改源码，见 README Known Limitations）。
- 重启 DSH web 后生效（加载新 web 产物与 patch 行）。

## 状态机

```
backlog ──将军批准──▶ todo ──士兵认领──▶ in_progress ──完成提交──▶ in_review
  in_review ──将军验证+用户接受──▶ done       任意 ──▶ blocked / canceled
blocked ──解阻──▶ todo | in_progress        in_progress ──归还──▶ todo
```

- `backlog` 未批准不得开工；`done` 只有将军（`--by general`）在验证通过且用户接受后才能到达。
- `blocked` 必须写"卡在哪个文件/命令/报错"（写进评论）；连续 3 轮未解除 → 向用户上报。

## 命令速查

```bash
# 初始化 / 创建（默认 backlog）/ 读取 / 列出
node legion/scrum/taskctl.mjs init
node legion/scrum/taskctl.mjs create --title "..." --description "..." --acceptance "验收1;验收2" --priority high
node legion/scrum/taskctl.mjs get T-001
node legion/scrum/taskctl.mjs list [--status in_progress] [--soldier soldier-a]

# 认领与状态迁移（写操作必须带最新 --if-version）
node legion/scrum/taskctl.mjs approve T-001 --if-version 1            # 将军：backlog → todo
node legion/scrum/taskctl.mjs claim T-001 --soldier soldier-a --round 5 --if-version 2
node legion/scrum/taskctl.mjs transition T-001 --to in_review --by soldier-a --if-version 3
node legion/scrum/taskctl.mjs transition T-001 --to done --by general --if-version 5

# 评论 / 验证证据 / 依赖（link 建边会检测依赖环，成环/自依赖被拒绝）
node legion/scrum/taskctl.mjs comment T-001 --by soldier-a --text "..."
node legion/scrum/taskctl.mjs evidence T-001 --by general --text "typecheck 通过"
node legion/scrum/taskctl.mjs link T-003 --blockedBy T-002

# 归还 / 认领租约超时回收（守护每轮自动跑 release-stale）
node legion/scrum/taskctl.mjs release T-001 --by soldier-a --reason "主动放弃"
node legion/scrum/taskctl.mjs release-stale --older-than 60 --by daemon

# 进度心跳（遥测：append-only，不 bump version）/ 离线 inbox / 转派
node legion/scrum/taskctl.mjs progress T-001 --by soldier-a --percent 40 --note "实现中"
node legion/scrum/taskctl.mjs inbox --role coder
node legion/scrum/taskctl.mjs reassign T-001 --soldier soldier-b --by general

# 产物登记（看板详情 iframe 预览 / 链接）
node legion/scrum/taskctl.mjs artifact T-001 --by soldier-a --kind html --path "D:/legion/report.html" --title "验收报表"

# 刷新看板
node legion/scrum/render.mjs
```

## 认领与并发纪律（源自 dashi-taskboard）

1. **backlog 未批准不开工**；`todo` 才可认领。认领先于一切任务工作（读代码、分析都不算开工前行为）。
2. **乐观锁**：每次写操作 `version` 递增；用过期 `--if-version` 会被拒绝，必须先 `get` 重读再重试——**绝不覆盖他人变更**。
3. **认领互斥**：已被其他士兵认领的任务拒绝抢占；一个任务同一时间只有一个拥有者。
4. **依赖**：`blockedBy` 未完成时无法认领/开工（除非确认后 `--force`）；完成后自动解除。
5. **done 需要人类确认**：士兵完成 → `in_review` → 将军独立验证（跑真实命令）→ 写入 `evidence` → 用户接受后 `done`。

## 士兵与将军的分工

- **士兵**：`claim` 认领（先 `mesh_recv` 看有没有新方向）→ 干活 → 完成时 `transition --to in_review` → 在任务上 `comment` 写变更与风险；受阻写 `blocked` + 具体原因。
- **将军**：把用户需求/回执翻译成任务（`create` + `approve`）→ 每轮收士兵报告后更新任务（`evidence`/`transition`）→ 用户接受后 `done` → 每轮跑 `render.mjs` 刷新看板 → 看板展示在聊天（KANBAN.md）与浏览器（kanban.html）。

## 与消息总线（mesh）的关系

任务库负责"做什么、做到哪"（看板），mesh 负责"角色间怎么沟通"（消息）。两者正交：士兵通过 `mesh_send` 上报 → 将军把结果落到 `tasks.json`（评论/证据/状态）→ `render` 把落盘状态投影成看板。

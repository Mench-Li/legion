# Legion 军团 Scrum — 完整说明与使用手册

Legion 是一套「**将军（general）+ 士兵（soldier）**」的多智能体 Scrum 系统，用一块 Kanban 看板驱动整个作战流程。

- **将军**：你 + 主 Agent。负责建任务、批准 backlog、独立验收、放行 done。
- **士兵**：一次性 worker subagent。由守护自动认领 todo 任务，在隔离的 git worktree 里干活，完成后提交 `in_review`。
- **守护（dsh-scrum-worker）**：后台轮询守护。自动扫单 → 认领 → 派工 → 提交，将军无需手动派活。

核心原则：**`scrum/tasks.json` 是唯一权威数据库**；所有任务变更只走 `taskctl.mjs`（状态机 + 乐观锁 + 角色纪律强制）。其余脚本和接口都只是它的封装。

---

## 1. 目录地图

| 路径 | 职责 |
| --- | --- |
| `scrum/tasks.json` | 权威任务库（唯一事实源） |
| `scrum/taskctl.mjs` | 任务变更**唯一入口** CLI（状态机/乐观锁/角色纪律） |
| `scrum/render.mjs` | 生成 `board.json` / `KANBAN.md` / `kanban.html` 静态快照 |
| `scrum/serve.mjs` | 实时看板服务（:4820，SSE 推送 + 拖拽写回） |
| `scrum/activity.jsonl` | 动态流（守护生命周期事件，gitignored） |
| `plugins/` | `@dsh-external/dsh-scrum-worker` 士兵守护插件 |
| `COMMAND.md` | 作战总纲（指挥官轮次循环 + 军团纪律） |
| `scrum/README.md` | Scrum 看板协议（命令速查 / API / 守护配置） |

---

## 2. 快速上手（5 分钟）

### 2.1 打开看板

```bash
cd D:\project\dsh\legion
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820
```

浏览器打开 **http://127.0.0.1:4820**。局域网/手机访问用 `http://<本机IP>:4820`，令牌 `legion-kanban-4820`（写操作需令牌，读操作开放）。

右上角 **「⚡ 动态」** 按钮是实时活动流。

### 2.2 下达第一个任务

```bash
# 1) 建任务（默认进 backlog，未批准不开工）
node scrum\taskctl.mjs create --title "写一个 hello 脚本" --description "在 worktree 里输出 hello" --acceptance "node hello.js 打印 hello"

# 2) 将军批准（backlog → todo）
node scrum\taskctl.mjs approve T-006
```

批准后，守护会在下一个扫单周期（默认 30s）**自动**认领 → 建隔离 worktree → 派 worker 干活 → 提交 `in_review`。全程不用手动派工。

### 2.3 验收并放行

worker 完成后任务停在 `in_review`，任务评论里会自动附上 promote 命令。将军独立验证通过后：

```bash
git -C D:/project/dsh/legion merge --no-ff w/T-006          # promote：合入主分支
node scrum\taskctl.mjs transition T-006 --to done --by general   # 放行 done
```

放弃则：

```bash
git -C D:/project/dsh/legion worktree remove --force .legion-worktrees\T-006
git -C D:/project/dsh/legion branch -D w/T-006
```

---

## 3. 任务状态机

```
backlog ──将军批准──▶ todo ──士兵认领──▶ in_progress ──完成提交──▶ in_review
   in_review ──将军验证+用户接受──▶ done        任意 ──▶ blocked / canceled
 blocked ──解阻──▶ todo | in_progress           in_progress ──归还──▶ todo
```

| 当前状态 | 允许迁往 |
| --- | --- |
| `backlog` | `todo`, `blocked`, `canceled` |
| `todo` | `in_progress`, `blocked`, `canceled` |
| `in_progress` | `in_review`, `todo`, `blocked`, `canceled` |
| `in_review` | `done`, `in_progress`, `blocked`, `canceled` |
| `blocked` | `todo`, `in_progress`, `canceled` |
| `done` | `in_progress`, `canceled` |
| `canceled` | （终态） |

优先级：`high` / `medium` / `low`。

---

## 4. taskctl 命令手册

所有命令成功时向 stdout 输出 JSON，失败时向 stderr 输出原因并退出码 1。

```bash
node scrum\taskctl.mjs <命令> [--key value …]
```

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `init` | 初始化 `tasks.json` | — |
| `create` | 建任务（backlog） | `--title`（必填）、`--description`、`--acceptance "a;b;c"`、`--priority high\|medium\|low`、`--parent <id>` |
| `get` | 读一个任务 | `<id>` |
| `list` | 列任务 | `--status <s>`、`--soldier <s>` |
| `approve` | 批准 backlog → todo | `<id>`、`--if-version <N>` |
| `claim` | 认领 todo/blocked → in_progress（互斥） | `<id>`、`--soldier <s>`（必填）、`--round <N>`、`--force`、`--if-version <N>` |
| `transition` | 通用状态迁移（含合法性/依赖/角色检查） | `<id>`、`--to <status>`（必填）、`--by <who>`、`--force`、`--if-version <N>` |
| `comment` | 追加评论（退回反馈/需求变更） | `<id>`、`--by <who>`（必填）、`--text <t>`（必填） |
| `evidence` | 追加验证证据 | `<id>`、`--by <who>`（必填）、`--text <t>`（必填） |
| `link` | 建依赖/父子关系（成环即拒绝） | `<id>`、`--blocks "A,B"`、`--blockedBy "A,B"`、`--parent <id>` |
| `release` | 归还 in_progress → todo | `<id>`、`--by <who>`（必填）、`--reason <r>` |
| `release-stale` | 批量回收超时认领 | `--older-than <分钟>`（必填）、`--by <who>` |

### 角色纪律（命令内强制）

- **`approve`** 只能把 `backlog` 变 `todo`（将军批准）。
- **`claim`** 是互斥的：已被其他士兵认领的任务拒绝抢占；被未完成依赖阻塞时拒绝（除非 `--force`）。
- **`transition --to done`** 只接受 `--by general`，且只允许从 `in_review` 迁入（将军验证 + 用户接受后才放行）。
- **`transition --to in_review`** 必须由该任务的负责士兵提交。
- **乐观锁**：每次写操作 `version` 递增；带 `--if-version N` 时版本不匹配则拒绝（绝不覆盖过期状态）。

### 常用示例

```bash
# 建任务并批准
node scrum\taskctl.mjs create --title "修复登录 bug" --description "..." --acceptance "登录成功返回 token" --priority high
node scrum\taskctl.mjs approve T-007

# 建立依赖（T-008 依赖 T-007 完成）
node scrum\taskctl.mjs link T-008 --blockedBy T-007

# 退回（将军评论 + 打回 in_progress）
node scrum\taskctl.mjs comment T-007 --by general --text "登录后缺少刷新逻辑，重做"
node scrum\taskctl.mjs transition T-007 --to in_progress --by general

# 放行 done
node scrum\taskctl.mjs transition T-007 --to done --by general

# 查看任务与过滤
node scrum\taskctl.mjs get T-007
node scrum\taskctl.mjs list --status in_review
node scrum\taskctl.mjs list --soldier soldier-auto
```

---

## 5. 看板服务 serve.mjs

### 启动

```bash
node scrum\serve.mjs [--port 4820] [--host 127.0.0.1] [--token <t>]
```

- 局域网共享：`--host 0.0.0.0 --token <t>`，手机/其他电脑访问 `http://<本机IP>:4820`。
- 环境变量：`DSH_KANBAN_PORT` / `DSH_KANBAN_HOST` / `DSH_KANBAN_TOKEN`。

### 接口

**读（GET，开放）**：

| 路径 | 说明 |
| --- | --- |
| `/` | 看板页（SSE 实时 + 轮询兜底 + 拖拽写回） |
| `/board.json` | 看板数据快照 |
| `/KANBAN.md` | 文本看板 |
| `/api/board` | board.json 内容（轮询端点） |
| `/api/board/events` | SSE：board.json 变化时推全量看板 |
| `/api/activity?limit=N` | 最近动态事件（JSON 数组） |
| `/api/activity/events` | SSE：activity.jsonl 追加时推新事件 |
| `/api/config` | `{ auth, host, port }` |

**写（POST，配了 token 时必须带令牌）**：`/api/create`、`/api/transition`、`/api/comment`。

令牌携带方式（任选其一）：`Authorization: Bearer <t>` / `x-dsh-token: <t>` / `?token=<t>`。

### 刷新静态快照

```bash
node scrum\render.mjs [--out DIR]
```

生成 `board.json` / `KANBAN.md` / `kanban.html`（serve.mjs 每次写成功后也会自动跑一次）。

---

## 6. 士兵守护 dsh-scrum-worker

插件包：`legion/plugins`（`@dsh-external/dsh-scrum-worker`）。

### 行为

守护每 `intervalMs` 扫一次看板：

1. **todo** → 认领（互斥由状态机保证）→ 派一次性 worker subagent（携带标题/描述/验收/评论/依赖完整上下文）→ 完成后提交 `in_review`。
2. **in_progress 且认领后有他人评论** → 视为被将军退回 → 派纠错 worker（提示词附最新退回评论）。
3. **blocked 且依赖已全部解除** → 解阻认领 → 派 worker 续做。
4. **release-stale**：`in_progress` 认领超过 `staleMinutes` 无进展 → 自动释放回 `todo`。
5. **done 永远由用户决定**：守护最多提交到 `in_review`。

worker 是一次性 subagent，父为按 cwd 惰性创建的 foreman agent。worker 只做实现并回报 `{status, summary, evidence, blocker}`，状态迁移一律由守护经 taskctl 完成。

### 配置（默认值）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `role` | `soldier-auto` | 守护士兵身份（认领/提交验收用） |
| `intervalMs` | `30000` | 扫单间隔（毫秒，≥5000） |
| `maxWorkers` | `1` | 并发 worker 上限（1–8） |
| `workerTimeoutMs` | `600000` | 单 worker 超时（毫秒，≥60000） |
| `staleMinutes` | `30` | 认领租约（分钟，≥5，须 > workerTimeoutMs/60000） |
| `provider` | `spawn` | ctx.subagents 上的 provider 名 |
| `scrumDir` | `D:/project/dsh/legion/scrum` | taskctl.mjs 所在目录 |
| `workspace` | `D:/project/dsh` | worker 工作目录（isolate=false 时用） |
| `isolate` | `true` | 是否用 git worktree 隔离每个任务 |
| `repoRoot` | `D:/project/dsh/legion` | worktree 隔离所用 git 仓库根 |
| `worktreeRoot` | 空 | worktree 目录根（默认 `repoRoot/.legion-worktrees`） |
| `logFile` | 空 | 日志文件（默认 `~/.dsh/super-injector/dsh-scrum-worker.log`） |

守护当前经 `@dsh-external/dsh-super-injector` 注入到 DSH Desktop 的 `desktop` profile 中运行。

---

## 7. 隔离与 promote（worktree 工作流）

`isolate: true` 时，每个任务的改动都被隔离到独立的 git worktree：

```
D:/project/dsh/legion/.legion-worktrees/<id>/    ← 任务专属工作树（分支 w/<id>）
```

- worker 只在这个 worktree 里改，提交到分支 `w/<id>`，**主分支和主工作树不被污染**。
- 守护会安装 pre-push 守卫（`.git/hooks/pre-push`），拦截 `w/*` 分支的直接 push。
- 合入是**显式**的（将军验收后手动 promote）：

```bash
git -C D:/project/dsh/legion merge --no-ff w/<id>    # 合入
```

- 每次 worker 完成，任务评论里都会自动附上 promote / 放弃两条命令。
- **注意**：isolate 只覆盖 `repoRoot`（legion 仓库）。若某任务要改 legion 之外的代码（如 `deepseek-harness`），需单独关掉该任务的隔离。

---

## 8. 四项加固

| 加固 | 说明 |
| --- | --- |
| ① git worktree 隔离 | 每任务独立 worktree，主树零污染，promote 显式 |
| ② 实时活动流 | `activity.jsonl` + SSE，看板「⚡ 动态」实时展示 claim/worktree/dispatch/done 等生命周期 |
| ③ 认领租约 / 过期检测 | `staleMinutes` 超时自动 `release-stale`，防止士兵认领后失踪 |
| ④ pre-push 守卫 + 依赖环检测 | 拦截 `w/*` 分支 push；`link` 建依赖时成环即拒绝 |

---

## 9. 日常工作流

### 将军（你 / 主 Agent）

1. 建任务 → `create`。
2. 批准 → `approve`（backlog → todo）。之后守护自动接手。
3. 对 `in_review` 任务**独立验证**（跑真实命令，不信士兵自报）。
4. 验收通过 → promote 合入 + `transition --to done --by general`；不通过 → `comment` 退回 + `transition --to in_progress`。

### 士兵（守护自动）

1. 认领 todo → `claim`（互斥）。
2. 在隔离 worktree 里实现。
3. 提交 `w/<id>` 分支 → `in_review` + 附验收证据与 promote 命令。

---

## 10. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 看板打不开（:4820 无响应） | `serve.mjs` 没在跑（进程/会话重启会挂）。手动重跑启动命令 |
| 守护不认领任务 | 看日志 `~/.dsh/super-injector/dsh-scrum-worker.log`；确认任务已 `approve`（是 todo） |
| 日志出现「taskctl 输出不是 JSON」 | Electron 下 `process.execPath` 非 node，已修复（`ELECTRON_RUN_AS_NODE=1`） |
| 改完 `plugins/lib` 守护还是旧逻辑 | Electron 里 `loader.internal` 不可用，热重载清不掉模块缓存 → **重启 Desktop** 清缓存 |
| 任务卡 `in_progress` 不动 | 守护会按 `staleMinutes` 自动回收（默认 30 分钟）；也可手动 `release` |
| `git push` 推 `w/*` 分支被拒 | pre-push 守卫在拦，属正常；先 `merge --no-ff` promote 再 push |
| 依赖阻塞开工 | `claim`/`transition` 报「被未完成依赖阻塞」；先完成依赖任务，或确认后加 `--force` |

---

## 11. 附录

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `DSH_KANBAN_PORT` | serve.mjs 端口（默认 4820） |
| `DSH_KANBAN_HOST` | serve.mjs 监听地址（默认 127.0.0.1） |
| `DSH_KANBAN_TOKEN` | serve.mjs 写操作令牌 |

### 关键路径

- 任务库：`D:/project/dsh/legion/scrum/tasks.json`
- 守护日志：`C:/Users/86135/.dsh/super-injector/dsh-scrum-worker.log`
- 隔离 worktree：`D:/project/dsh/legion/.legion-worktrees/<id>/`
- 动态流：`D:/project/dsh/legion/scrum/activity.jsonl`

### 关联文档

- `COMMAND.md` — 作战总纲（指挥官轮次循环 + 军团纪律）
- `scrum/README.md` — 看板协议（命令速查 / API / 守护配置）
- `PLUGINS.md` — 插件状态

# P1-1 team-hub 双实现合并 — 现状盘点与决策书

> 盘点时间：2026-09-09　基线：`main`（`d47c6f5`，P1-3 合入后）
> 范围：`team-hub/server.mjs`（v2 独立中枢）与 `team-hub/src/index.ts`（DSH 宿主插件适配器）
> 关联：`docs/CONTRACT-V1V2.md`（P2-1 契约表，R1-R10 语义差异登记）· `docs/P0-CONFIRMATION.md`
> 本文只盘点与决策，**不修改任何生产代码/配置**。

## 1. 两套实现事实表

### 1.1 `server.mjs` — v2 独立中枢（3223 行）

| 维度 | 事实 |
|---|---|
| 数据源 | SQLite（`node:sqlite`，WAL）`TEAM_HUB_DB`，默认 `team-hub/team.db`；**生产 :8787 权威执行池** |
| 配置入口 | 环境变量：`TEAM_HUB_PORT`(8787)/`DB`/`TOKEN`/`HOST`；P2-2 读面门禁 `readAuthRequired`（非回环+token → 全读面鉴权） |
| API 面 | ~45 个 v2 独有端点：任务 + 目标/切片（goal/slices/test-report/patch/progress/hold）+ 聊天 + 日历 + skills/rules/spaces/exec/roster/members/scopes/models/overlaps/附件/审计 |
| SSE | `/api/events` 单流：audit 信封（seq/ts/member/scope/action/…）+ `id:` 行 + Last-Event-ID 增量续传 + 30 条回放 + 15s `:hb`（P2-3 统一） |
| 进程形态 | `handle(req,res)` 模块级闭包（未导出）→ `server = http.createServer`；`isMain` 守卫下 `listen`（被 import 时不占端口） |
| 生产角色 | services-plugin 托管 :8787；**scrum-worker 守护（scope=software）+ workbench :5173（`DSH_HUB_UPSTREAM` 默认 8787，/hub 反代）→ 全部消费 v2**（P0 §1-2） |
| 测试基线 | team-hub 组 137/137：chat/calendar/skills/rules/spaces/goal/artifact-content/read-auth/read-open-loopback/security |
| 附加 | 附件落盘目录与库同基（`uploads/`）；启动周期性附件孤儿清理（`setInterval(...).unref()`） |

### 1.2 `src/index.ts` — v1 宿主适配器（442 行，cordis 插件）

| 维度 | 事实 |
|---|---|
| 数据源 | `config.scrumDir` 下 **v1 文件库** `tasks.json` + `activity.jsonl`；所有任务 API 经子进程 `taskctl.mjs`（跨进程文件锁 + 乐观锁），与 serve.mjs/:4820/board-plugin 本地模式共享同一 tasks.json |
| 配置入口 | cordis `Config`（scrumDir/routePrefix/teamToken/members/scopes）——与 env 是**两套配置入口** |
| API 面 | 16 端点：create/claim/reassign/progress/release-stale/artifact/transition/advance/comment/reject/promote/board/activity/events/inbox/config。**独有 `/api/reject`、`/api/promote`**（v1 隔离 worktree 的 git 打回/合入语义；v2 无） |
| SSE | `/api/events` activity.jsonl `watchFile` 增量（activityOffset）→ data 行；无信封、无 Last-Event-ID（v1 形态，契约 R4/S3 登记） |
| 进程形态 | cordis 插件：`inject ['webServer']` + `ctx.webServer.register({kind:'prefix', path})` + effect 清理（unwatchFile/end SSE 客户端） |
| 生产角色 | 3080 DSH web profile `legion-team-hub` 行（scrumDir=`D:/project/DSH/legion/scrum`）；**同宿主 board-plugin 的 hub 模式后端**（detectHub → `/team-hub/api/config` → useHub） |
| 测试基线 | **无专项测试**；P1-3 host fixture ② 覆盖部分（create/comment/transition/board/config + token 401/409） |

## 2. 消费方与部署拓扑（生产，2026-09 现状）

| 消费方 | 后端 | 数据池 |
|---|---|---|
| scrum-worker 守护（3080 宿主插件，scope=software） | `hubUrl=http://127.0.0.1:8787` → **server.mjs v2** | team.db |
| workbench :5173（ServeView/Chat/Notify/日历/看板） | `DSH_HUB_UPSTREAM` 默认 8787（/hub 反代）→ **v2** | team.db |
| board-plugin（3080 宿主 `/scrum-board`） | hub 模式 → 同宿主 `/team-hub` → **src/index.ts v1 适配器** | scrum/tasks.json |
| v1 kanban :4820（serve.mjs，独立进程） | 自身 | scrum/tasks.json |
| 测试（v1v2-contract、team-hub 组、P1-3） | 各自临时库/fixture | 隔离 |
| exec/queue 通道 | **无消费者**（P0 §2 已确认） | — |

→ **双数据池事实**：生产 `scrum/tasks.json`（v1 文件库：serve.mjs + src/index.ts 操作，board-plugin hub 展示）与 `team.db`（v2 SQLite：worker 执行 + workbench 展示）**并存**。worker 在 v2 干活，board-plugin 看板展示 v1 文件库 → 两者内容不同源（正是 P1-1「修一处漏一处」担忧的实例）。

## 3. 语义差异（引用 P2-1 契约表，`docs/CONTRACT-V1V2.md` R1-R10）

状态机/迁移/优先级/完成纪律两端**逐字一致**（契约 §1）；任务公共字段 22 个两端一致（§2.1）。
登记差异：R1 /api/board（v1 渲染快照 vs v2 裸数组）、R2/R3 activity 结构/参数、R4 SSE 形态、
R5 /api/config、R6 artifact 分层、R7 404 形态（已随 P2-1 统一 JSON）、R8 写响应壳、R9 board-plugin
hub SSE 桥接缺口、R10 scope 写默认。v1v2-contract 14/14 锁定。

## 4. 合并选项

### 选项 A — v2 唯一权威，宿主 `/team-hub` 收敛为 v2 外壳（推荐方向）

1. `server.mjs` 工厂化：抽出 `createHub(options)`（db/token/… 参数化，模块级状态入工厂闭包），
   现有 env 默认路径保持（`isMain` + import 即建库语义不破坏 137/137 测试的「import 前设 env」范式，或
   改为「懒初始化单例 + 测试逐步迁移」）。
2. `src/index.ts` 只留 cordis 外壳：Config/`inject ['webServer']`/prefix 注册/生命周期清理 →
   业务 handle 改调 v2 工厂（同进程共享 db/eventClients/审计），**删除 taskctl 子进程旧实现**。
3. 统一数据源为 team.db；配置收敛为「宿主 config 派生 → v2 工厂」单入口。
4. 相邻处置（需用户拍板）：board-plugin hub 目标改指 8787（v2）或宿主 /team-hub（v2）；v1 文件库
   `scrum/tasks.json` 与 serve.mjs :4820 的迁移/退役；`/api/reject|promote`（v1 worktree git 语义）在
   v2 的映射或 board-plugin 动作降级。

- 改动面：server.mjs 重构（中-高）、src/index.ts 重写（低）、board-plugin hub 语义（中）、迁移脚本（中）。
- 回归：team-hub 137/137 + board-plugin 32/32 + v1v2-contract 14/14 + P1-3 5/5 + 新增宿主对拍断言。
- 风险：v2 工厂化波及面大；board-plugin 行为变更（reject/promote/数据源切换）需现场验收。

### 选项 B — 保留双轨，仅抽公共 taskctl 业务层

src/index.ts 与 serve.mjs 共用同一份 taskctl 调用封装（消除适配器内重复），v1/v2 双数据池维持现状。
改动小、风险低，但**不消除双实现/双配置/双池**，P1-1 目标只完成一半。

### 选项 C — 维持现状，强化契约锁定

以 CONTRACT-V1V2 + v1v2-contract 继续锁定差异，不合并实现。零改动风险，但行为漂移风险持续存在。

## 5. 推荐

**选项 A**（分两步走）：
- 第 1 步（本次）：`server.mjs` 工厂化 + `src/index.ts` 收敛为 v2 外壳 + 同请求双形态对拍测试
  （隔离库上「8787 独立进程」vs「宿主 /team-hub」返回一致），不动生产拓扑；
- 第 2 步（发布决策，另立批次）：board-plugin hub 指 v2、v1 文件库/serve.mjs 退役迁移、现场切换。
  第 2 步涉及生产行为变更，需单独现场验收（P1-LIVE-ROLLOUT 同款 runbook）。

## 6. 待用户拍板决策点

- D1：唯一权威 = `server.mjs`(v2)，`src/index.ts` 收敛为 v2 宿主外壳？还是保留 v1 适配器面？
- D2（若 D1=A）：第 2 步发布范围——board-plugin hub 切 v2 + v1 文件库退役是否本次一并排期？
- D3：v1 独有的 `/api/reject|promote`（worktree git 语义）——映射到 v2 还是随 board-plugin 动作降级移除？

---

## 7. 拍板结果与实施记录（2026-09-09）

**D1 = 选项 A（v2 server.mjs 唯一权威，适配器收敛为外壳）**；
**D2 = 只做第 1 步代码收敛，生产拓扑切换另立批次**。

### 第 1 步实施清单（已合入基线验证，未动生产拓扑）

| 文件 | 改动 |
|---|---|
| `team-hub/server.mjs` | ① 导出 `DEFAULT_DB_FILE`；② `handle(req,res,stripPrefix?)` 支持可选前缀剥离（宿主外壳传 routePrefix，独立进程不传 → 行为不变）；③ 导出 `handle` 与 `disposeHub()`（end SSE 客户端，宿主 teardown 用）；④ 修尾部 export 列表与 `export function disposeHub` 的重复导出 |
| `team-hub/src/index.ts` | 重写为 v2 外壳（442 行 → ~90 行）：Config 保留旧键接受 + 新增 `dbPath`；apply 把 dbPath/teamToken/port 写入 env → 动态 import `../server.mjs` → `webServer.register(prefix)` 挂 v2 handle（剥离前缀）；teardown 摘路由 + `disposeHub()`。**taskctl 子进程 v1 实现全部删除** |
| `team-hub/server.d.mts` | 新增 ambient 类型声明（tsc 解析相对 .mjs import） |
| `board-plugin/src/index.ts` | Config 新增 `hubProbe`（默认 true）：隔离 fixture 可关探测避免 v1/v2 语义混淆；生产默认行为不变 |
| `tests/contract/team-hub-parity.test.mjs` | 新增双形态对拍（独立服务无前缀 vs 宿主 `/team-hub` 前缀外壳：config/404/401/409/board/comment 全等或归一化等价） |
| `tests/p13-fixture/*` | team-hub 行改用隔离 `dbPath`（p13-hub.db）；board 行 `hubProbe:false`；① config 断言改 v2 形状；④ team-hub SSE 改 v2 audit 信封（回放+seq 递增） |
| `scripts/ci/run-ci.mjs` | suite 表登记 `team-hub-parity` |

### 回归结果（第 1 步后全绿）

- team-hub 全组 **138/138**（137 原 + 1 parity）——server.mjs 改动零回归。
- P1-3 真实宿主注入冒烟 **5/5**（v2 外壳：config/②契约/board 本地/SSE 信封/dispose 退出 0）。

### 决策记录（D3 / 遗留，归第 2 步批次）

- v1 独有 `/api/reject|promote`（taskctl worktree git 语义）随 v1 适配器下线；v2 无对应端点。
  第 2 步需为 board-plugin hub 模式（UI 有 reject/promote 动作）决定映射或降级——未实施。
- 宿主默认 `dbPath=''` → 与 8787 同库 `team-hub/team.db`（services-plugin 托管 8787 未设 TEAM_HUB_DB）。
- 生产 web profile 未改；**重启宿主前须先完成第 2 步消费方兼容**（junction=源码，重启即切 v2 外壳）。

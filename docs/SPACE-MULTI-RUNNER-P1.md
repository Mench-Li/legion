# SP-P1 单进程多空间守护（多空间编排）

> 目标：**一个插件行接管 N 个空间**。新增空间 = 在指挥台建空间 + 提交流水线，不再需要改 DSH profile 配置文件、
> 不再需要重启宿主来「多加一个守护实例」。这是「编队即流水线」（SP-P0）之后的第二步：
> P0 让**流水线**脱离配置文件，P1 让**实例**脱离配置文件。

## 1. 问题（P1 之前）

`dsh-scrum-worker` 的一个插件行 = 一个空间：`scope` 是启动期常量，`rolesFile`/`workspace`/`repoRoot`/`worktreeRoot`/`logFile`
都是行内配置。于是：

| 症状 | 现场 |
| --- | --- |
| 新增一个空间要改配置文件 | `~/.dsh/profiles/web/cordis.patch.yml` 里再抄一段 `legion-scrum-worker-<space>` |
| 改配置文件还要重启宿主才生效 | 插件代码/行都要重启进程（runbook §8 更正） |
| 多实例互相踩同一份状态文件 | N 个实例都写 `scrum/daemon.json`（后写者覆盖，看板只看到最后一个） |
| 全局暂停/并发是实例级不是空间级 | `control.json` 一份、`maxWorkers` 一份，暂停一个空间会停掉所有空间 |
| 忘了加行 = 空间静默不动 | T-127：ozon 空间发布目标后链停在 todo，因为没有人服务 ozon |

## 2. 方案：监督者 + 子实例（而不是把状态改成 Map）

一个监督者实例（`scopes` 非 `off`）自己**不派工**，只负责：读数据面 → 算出应接管的空间 → 用 `ctx.plugin`
为每个空间挂一个子实例（= 完整的单空间守护）→ 周期对齐（挂载/卸载/重启 diff）。

```
legion-scrum-worker (scopes: 'auto')          ← 监督者：只做编排
├── space:software  (spaceWorker, scope=software)   ← 子实例：闭包状态全独立
├── space:ozon      (spaceWorker, scope=ozon)
└── space:shop      (spaceWorker, scope=shop)       ← 新增空间：15s 内自动出现
```

**为什么用子实例而不是把 3000 行闭包状态改成 `Map<scope, …>`**：单空间守护的 `pipeline`/`control`/`inflight`/
`foremen`/`controllers`/`lastTasks`/日志都是 `apply()` 的闭包变量；改成 per-space Map 等于重写整个派工路径
（3460 行、146 个回归用例）。用子实例则**派工逻辑零改动**，隔离性天然成立（不同 Fiber、不同闭包、不同 interval），
卸载时 `fiber.dispose()` 一次性回收该空间的 interval/effect/在跑 controller。

## 3. 数据面 → 部署面映射（唯一来源）

| 数据面 | 子实例 |
| --- | --- |
| `GET /api/spaces` 空间清单 | 参与接管集合（`scopes: 'auto'` = 全部；数组 = 白名单） |
| `space_runtime.enabled` | **是否挂载**（false = 不接管 → 该空间无人派工，指挥台预检会报 `runtime-disabled`） |
| `space_runtime.maxWorkers` | 子实例并发上限 |
| `space_runtime.isolate` | 子实例是否隔离仓库 |
| `space_stages`（enabled，`include=active`） | 子实例的水线；**0 环 = 不接管** |
| `GET /api/spaces/{id}` 的 `localDir` | 子实例每轮按空间绑定覆盖工作目录/隔离仓库根（P0 已有） |

**为什么「无流水线不接管」**：单空间守护在没有水线时退化成「认领该 scope 下任意 todo」。单实例服务单空间时这是
遗留兼容行为；多空间共用进程时它会用通用士兵提示词去跑别人的角色任务，因此宁可跳过并在日志里点名。

## 4. 状态文件与日志：按空间分文件

- 守护状态：每个子实例写 `scrum/daemon-<scope>.json`；**主 scope** 额外维护 `scrum/daemon.json`
  （看板/健康页只认它，保持兼容）。
- 主 scope 归属：优先父配置声明的 `scope`；父 scope 不在接管集合里时**交给第一个空间**——否则
  `daemon.json` 没人写，看板守护卡片会永久停在旧数据。
- 日志：`logFile` 按空间派生（`worker.log` → `worker-ozon.log`），避免多空间互相淹没。

## 5. 部署方式

**多空间（推荐，P1 之后的新形态）** —— 用一行替换 N 行：

```yaml
- id: legion-scrum-worker
  name: '@dsh-external/dsh-scrum-worker'
  config:
    scopes: 'auto'          # ← 唯一开关：接管数据面里所有「已开通执行 + 已配流水线」的空间
    scope: 'software'       # 主 scope（维护 daemon.json；也是未接管时的兜底）
    role: 'soldier-auto'
    intervalMs: 20000
    scrumDir: 'D:/project/DSH/legion/scrum'
    hubUrl: 'http://127.0.0.1:8787'
    logFile: 'C:/Users/<你>/.dsh/super-injector/dsh-scrum-worker.log'
    # workspace/repoRoot/worktreeRoot/rolesFile 都可省：子实例按数据面空间绑定 + 数据面水线
```

新增空间流程（**不需要改配置文件、不需要重启**）：指挥台建空间 → `seed-pipeline --scope <id> --file <roles>.json
--runtime-enabled` → 监督者下一轮对齐（≤15s）自动挂载，日志出现 `[+] 空间 <id> 已挂载`。

**单空间（兼容形态）**：不写 `scopes`（默认 `'off'`）→ 与 P1 之前逐字相同，行为不变。

**生效条件**：`scopes` 是**插件代码**里的能力，切换该行会重新挂载但**不会重新加载模块**（runbook §8 更正），
所以从单空间切到多空间需要**重启宿主一次**。

**回退**：把 `scopes` 改回 `'off'`（或删掉该字段）并重启宿主 → 回到单空间；或恢复原来的多行部署。
两种形态可以并存：一行多空间 + 若干行单空间互不冲突（只要空间不重叠；重叠会让两个实例抢同一空间的任务，
守护的认领是原子的，不会重复执行，但会互相抢单）。

## 6. 交付状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1-a | 监督者 + 子实例挂载/卸载/重启 diff；`scopes` 配置面；`space_runtime` 下发；per-scope 状态文件与日志；`daemon.json` 兼容归属 | ✅ 已交付（`plugins/tests/multi-space.test.mjs` 11 项 + `multi-space-supervisor.test.mjs` 7 项） |
| P1-b | 每空间 `control.json`（暂停/继续按空间）；per-scope 心跳与看板聚合（读 `daemon-<scope>.json` 汇总成一张「守护矩阵」） | 待做 |
| P1-c | 指挥台一键开通/停用空间（写 `space_runtime.enabled`）+ 预览「谁会接管」；彻底去掉 profile 行依赖 | 待做 |

**P1-b 的动机**（P1-a 之后仍然存在的缺口）：暂停仍是全局的（`control.json` 一份，任一子实例读到都会停），
看板只显示主 scope 的守护状态——多空间部署下需要「守护矩阵」才能一眼看到哪个空间在跑、并发多少、卡在哪。

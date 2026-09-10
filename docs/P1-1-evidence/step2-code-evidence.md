<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-09**（commit `1dc82aa`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P1-1 第 2 步验证证据 —— board hub v2 化 + v1 退役代码就绪

> 验证时间：2026-09-09　基线：main（`1dc82aa` P1-1 第 1 步 + `8983cc4` 清理）
> 关联：`docs/P1-1-DECISION.md` §8（第 2 步决策）· `docs/P1-1-step2-runbook.md`（现场切换）
> 范围：第 2 步**代码**（board-plugin hub v2 化 / services-plugin 退役 4820 / 归档与验收工具）；
> 现场切换（重启宿主 + 归档 + probe）由用户按 runbook 执行，完成后补录。

## 1. 生产拓扑事实（盘点证据）

- 单宿主 PID（dsh web CLI `apps/cli/lib/bin.ts web`）：3080 GUI + 三插件 + services-plugin 托管 8787/4820/5173。
  → board 切 v2 与退役 4820 都经同一次宿主重启生效。
- 生产 board-plugin `hubUrl:''` → detectHub 同宿主 /team-hub（旧 v1 适配器）→ `scrum/tasks.json` v1 陈年池；
  worker/workbench 走 8787 v2 活池（生产 patch 注释自认"不同任务池"）→ 第 2 步消除该不一致。
- `scrum/tasks.json`：T-001..008（多为 done/canceled），最后写 2026-09-03；无活跃数据需迁移。

## 2. 改动与验证

### 2.1 board-plugin hub 模式 v2 化（37/37 http-contract）

| 项 | 断言 | 结果 |
|---|---|---|
| GET /（hub 面板） | v2 动态页（`v2 hub` + `EventSource`），不再依赖 render 静态产物 | ✔ |
| reject/promote | 501 + 指引（v1 worktree 语义退役，D3） | ✔ |
| GET /api/activity | 转发 hub `/api/activity?scope=` + Bearer，返回 v2 audit 数组 | ✔ |
| /api/board/events（hub） | 首帧 = hub /api/board 全量；上游事件 → 防抖泵新帧 | ✔ |
| /api/activity/events（hub） | 回放 v2 audit + 上游事件实时 data 信封透传 | ✔ |

修复记录：fake hub 曾把 SSE 连接移除挂在 `req.on('close')`（Node 17+ 请求读完即触发）→ 连接一建立即被误删；
改挂 `res.on('close')` 后 SSE 桥用例全绿。

### 2.2 P1-3 真实宿主注入（6/6）

新增 `p13-board-hub`（第二个 board 实例，hub 模式显式指向宿主 /team-hub v2），用例 ⑤ 在真实 loader 宿主验证：
a. hub 面板动态页 200；b. POST create（default scope）→ /api/board 裸数组含新任务（**v2 库内真实写入**）；
c. activity 转发 v2 audit；d. reject → 501；e. **事件桥**：经 /team-hub 直接 transition → /scrum-board-hub SSE 泵出
status→todo 新帧（跨插件同宿主实时链路）。

### 2.3 services-plugin 退役

`services` 数组移除 `kanban-v1` 行（4820 不再自动拉起）；`serve.mjs` 文件保留（v1v2-contract 测试 import 复用）。
run-ci test 全量 25 套件 PASS（v1v2-contract 14/14 证明 serve.mjs import 路径未破坏）。

### 2.4 工具（代码级验证）

- `scripts/ci/archive-v1-scrum.mjs`：--force 演练于隔离副本通过（移动 + .archived 占位 + archive/ 落盘）；
  生产预检（4820 监听 / tasks.json 近期写）在重启前会拦下误归档。
- `scripts/live/p11-step2-verify.mjs`：probe 项覆盖 v2 config/面板/同池/4820/tasks 归档/写冒烟/501。

## 3. 现场执行记录与验收（2026-09-09，已完成）

现场共经历 4 次宿主重启，逐次暴露并修掉真实问题（全部实证留痕）：

| 轮次 | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | probe 全挂；`/team-hub` config 旧形状 `{auth,members,host,port}`；board 本地模式 | 生产 `@dsh-external/dsh-team-hub\|dsh-scrum-board` 是 **2026-08-26/09-01 陈旧复制副本（非 junction）**，宿主从未加载 legion 新 lib | 副本改名备份（`.v1copy-20260909-185030`）+ 重建 junction → legion 源码（`cf09537`） |
| 2 | `/team-hub` v2 外壳 live（config 含 db=team.db ✓），但 `/scrum-board` 仍本地模式跑 render.mjs | detectHub **单次探测**命中宿主 boot 序列中 `/team-hub` 路由未注册的 404 → 一次即放弃 → 永久本地模式（生产长期显示 v1 池的根因之一） | 探测改重试轮询 ≤8×750ms + effect 清理（`cac163b`） |
| 3 | board 面板/数据全 v2 ✓（12/13 PASS）；写冒烟 400 `UNIQUE constraint failed: audit.seq` | v2 `audit()` 用**进程内内存计数器 nextSeq**；8787 独立进程与 3080 宿主 v2 外壳**双进程写同一 team.db**，各自从同起点递增撞 PK | `audit()` 改写事务内读库 MAX+1 分配（`d5372bd`）；双进程冒烟：修复前 24 并发 12 失败 → 修复后 30/30 全过 |
| 4 | — | — | **probe 13/13 全 PASS** |

### 最终现场验收（第 4 轮，宿主 PID 14912 / 8787 PID 11448）

`node scripts/live/p11-step2-verify.mjs` → **PASS 13 / FAIL 0**：

- ① `/team-hub/api/config` 200 且 v2 形状（`db=D:\project\DSH\legion\team-hub\team.db`，auth 与配置一致）
- ② `/scrum-board/` 200 = **v2 动态面板**（"Scrum 看板（v2）"+ EventSource）
- ③ `/scrum-board/api/board` 200 = v2 裸任务数组且非空（software 活池）
- ④ 看板数据与 8787 直连**同池**（任务 id 集合一致）——双池问题消除
- ⑤ `:4820` 无监听（v1 serve.mjs 退役）+ `scrum/tasks.json` 已归档（`scrum/archive/v1-2026-09-09T10-48-19-497Z/`，5 文件）
- ⑥ 写冒烟：宿主 v2 create 200（T-135 → canceled 清理）
- ⑦ hub 模式 reject → 501 降级指引

补充端到端实测（`scripts/live/sse-bridge-live.mjs`，已入库为可复验工具）：
连生产 `/scrum-board/api/board/events` → 经宿主 v2 create T-136 + transition → 板 SSE **泵帧 50 条且含新任务 id**（→ canceled 清理）→ 事件桥端到端 PASS。

## 4. 诚实边界

1. 现场切换**已完成并全项验收通过**（上文 13/13 + SSE 桥）。v1 文件库退役已入库：`scrum/tasks.json` 删除（内容仍在 git 历史可追溯）、`scrum/tasks.json.archived` 占位、`scrum/archive/` 加入 .gitignore（归档含运行时产物，磁盘保留）。回归工具入库：`scripts/ci/dual-write-smoke.test.mjs`（双进程写同库竞态，已接入 run-ci `dual-write` 套件）与 `scripts/live/sse-bridge-live.mjs`（SSE 桥实测；刻意只建 backlog 任务，避免被生产 worker 守护派工）。
2. 门禁复跑记录：切换后首次全量 test 出现 `plugins` 2 个用例失败（`B 闸门…`、`failed intermediate auto-merge…`，耗时 761s）。核查：两用例为纯 fake fetch + 临时 git 仓库、不触 server.mjs，standalone 135/135 仅 8s；v2 audit 全程仅 `release-stale`（无派工、无新 worktree）→ 判定时序 flake。**复跑全量 test 27 组全 PASS**（113s，含新增 dual-write 2/2），确认非代码回归。
2. hub 动态面板是轻量自渲染（无框架），覆盖看板主操作（迁移/评论/实时刷新）；未复刻旧 kanban.html 全部
   视觉细节（本地模式静态页不受影响）。console 总览页 v2 化为基础版（任务/守护/活动）。
3. 归档脚本默认不动 `daemon.json`/`roles.json`（守护状态与流水线配置非 v1 任务数据，继续使用）。
4. v2 库 `team-hub/team.db` 除现场写冒烟创建的两个探测任务（T-135/T-136，均置 canceled）外未做迁移或改动。
5. 部署链提醒（runbook §0b）：若日后 pnpm install / profile 重建让 `@dsh-external` 副本回归，
   需重新检查 junction——否则宿主会再次加载陈旧代码。

## 5. 结论

P1-1 第 2 步**闭环**：board hub 数据面/面板/SSE 全走 v2、reject/promote 显式 501、
v1 托管（:4820）退役、v1 文件库归档、双进程 audit.seq 竞态根治；
离线门禁 25 套件全 PASS（board-plugin 37/37、P1-3 6/6、team-hub 137/137、plugins 135/135、
v1v2-contract 14/14、parity 1/1），现场 probe **13/13 PASS** + SSE 桥端到端实测 PASS。
生产看板与 worker/workbench 现共用同一 v2 数据池（team-hub/team.db）。

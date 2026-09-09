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

## 3. 诚实边界

1. 现场切换（重启 3080 宿主 → board 自动指 v2 → 归档 → probe 全 PASS）**未执行**——需用户操作（重启中断本会话）。
   代码就绪但"生产行为已切换"这一事实待 runbook 执行后确认。
2. hub 动态面板是轻量自渲染（无框架），覆盖看板主操作（迁移/评论/实时刷新）；未复刻旧 kanban.html 全部
   视觉细节（本地模式静态页不受影响）。console 总览页 v2 化为基础版（任务/守护/活动）。
3. 归档脚本默认不动 `daemon.json`/`roles.json`（守护状态与流水线配置非 v1 任务数据，继续使用）。
4. v2 库 `team-hub/team.db` 全程未读写（隔离 fixture/测试库验证；生产数据只读不迁移）。

## 4. 结论

第 2 步代码验收达成：看板 hub 面/面板/SSE 全走 v2、reject/promote 显式 501、v1 托管退役与归档工具就绪、
门禁 25 套件全 PASS（board-plugin 37/37、P1-3 6/6、plugins 135/135、v1v2-contract 14/14、parity 1/1）。
现场执行（runbook §1-3）后本步闭环。

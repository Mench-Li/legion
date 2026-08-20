# 军团作战总纲（COMMAND）

本文是军团唯一的权威作战指令。指挥官（主 Agent）每一轮开始必须重读本文件与 `state.json`，结束前必须更新它们。任何跨轮次需要记住的信息必须落盘，不得依赖对话记忆。

## 当前目标（objective）

> 待填写：把目标写进 `state.json` 的 `objective`，并在此处用一句话概括。

## 当前阶段（phase）

> bootstrapping → planning → executing → verifying → complete / blocked

## 目录地图

| 路径 | 职责 |
| --- | --- |
| `state.json` | 机器可读状态：目标、轮次、任务计数、历史。每轮必读必写 |
| `tasks/backlog.md` | 待办队列：每个任务含验收标准（acceptance），表格维护 |
| `tasks/done.md` | 已完成任务，附验证证据（build/test 真实输出） |
| `tasks/blocked.md` | 受阻任务，附具体阻塞项（同一阻塞连续 3 轮未解除 → 向用户上报） |
| `reports/` | 每批战斗报告：`YYYYMMDD-HHMM-roundN-batch.md` |
| `workflows/batch-execute.js` | 批量扇出模板：一次性任务批次，提交 workflow 工具时作为 script 参数使用 |
| `workflows/soldier-prompt.md` | 士兵部署提示词模板：派发**持久士兵**时填充使用 |
| `mesh/` | 消息总线（`@deepseek-ai/dsh-tool-mesh` 插件）：注册/发送/拉取工具 + 需求版本（协议见 `mesh/README.md`） |
| `scrum/` | **Scrum 看板**：`tasks.json` 权威任务库 + `taskctl.mjs` 唯一变更入口 + `render.mjs` 生成 `KANBAN.md`/`kanban.html` + `serve.mjs`（实时服务，含 POST 写接口：拖拽/新建/评论）+ `plugins/dsh-scrum-worker`（士兵守护：自动认领 todo→派工→in_review，退回纠错，blocked 解阻；协议见 `scrum/README.md`） |

## 轮次循环（指挥官每轮执行）

1. 读 `COMMAND.md` + `state.json` + `scrum/tasks.json`（权威任务库）+ `mesh/orders.md`（最新需求版本）。
2. **读总线与唤醒**：`mesh_recv({ inbox: 'all' })` 查看总线动态，处理士兵报告/问题；对需要响应新消息的士兵 `send_message` 唤醒（内容已由总线直达，唤醒只负责叫它拉取）。
3. 从 `scrum/tasks.json` 的 backlog/todo 挑选下一批任务（2–5 个），用 `taskctl` 迁移状态（`approve` → `claim` 交给士兵）。
4. 新任务用 `workflow` 工具提交 `workflows/batch-execute.js`（`args.tasks` 填本批任务）；**持久士兵**用 `workflows/soldier-prompt.md` 模板派发后台 `subagent`（角色名唯一，先 `mesh_register`）。
5. 需求变更：更新 `mesh/orders.md`（bump 版本），`mesh_send({ to: '<受影响士兵>', type: 'order' })` 并唤醒。
6. 收集结果：士兵报告后，用 `taskctl` 落盘（`comment` 变更/风险 → `transition --to in_review` → `evidence` 验证证据）。
7. **独立验证**：对 `in_review` 任务跑真实检查（typecheck / build / test）；用户接受后 `transition --to done --by general`。
8. **刷新看板**：跑 `node legion/scrum/render.mjs`，在回复里贴 `KANBAN.md` 摘要（goal 进度 + 士兵统计），提醒用户可打开 `kanban.html`。
9. 更新 `state.json`（轮次/任务计数/history）、写 `reports/`。
10. 轮次结束，等待目标驱动器自动开启下一轮。

## 角色与通信协议

- 角色：`general`（将军，主 Agent，goal 驱动常驻）+ 若干 `soldier-*`（持久后台 subagent），全部经 `mesh_register` 绑定。
- 消息总线：`@deepseek-ai/dsh-tool-mesh` 插件（`mesh_send` 直发 / `mesh_recv` 游标拉取 / `mesh_register` 注册）；需求版本在 `mesh/orders.md`。
- 士兵 ↔ 将军：双向（`report`/`question` 上行，`order`/`relay` 下行）。
- 士兵 ↔ 士兵：**内容直连**——`mesh_send({ to: '<目标>', type: 'relay' })` 直接投递，无需将军中转；将军每轮 `mesh_recv({ inbox: 'all' })` 只负责唤醒。
- "实时"由 goal 轮次驱动：每轮 = 一次"读总线 → 唤醒 → 发令 → 收报"心跳；士兵被唤醒后先 `mesh_recv()` 再按 `soldier-prompt.md` 的固定流程行动。

## 军团纪律（不可违反）

1. **士兵提示词自包含**：士兵看不到对话，提示词必须包含仓库路径、验收标准、输出位置、成功定义。
2. **状态落盘**：任何下一轮需要知道的信息必须写进文件，靠叙述等于失忆。
3. **验证者独立**：士兵自报完成不算数，必须由指挥官或专职验证 agent 跑真实命令。
4. **受阻必须具体**：blocked 要写"卡在哪个文件 / 哪个命令 / 什么报错"，不是"遇到了困难"。
5. **预算纪律**：`max_goal_rounds` 是轮次军费，workflow 的 `maxTotalAgents` 是单批士兵上限，都不超支。
6. **超长任务拆解**：单任务上下文装不下就拆成多阶段；整体迭代过长时，用户明确要求才用 ralph（全新上下文轮换）。
7. **看板纪律**（见 `scrum/README.md`）：任务变更只走 `taskctl`；写操作带最新 `--if-version`（乐观锁）；backlog 未批准不开工；士兵认领互斥不抢活；`done` 必须将军验证 + 用户接受（用户在看板上把 in_review 拖到 Done）；每轮跑 `render.mjs` 刷新看板。**士兵守护（soldier-auto）会自动认领 todo 并派工到 in_review**：将军无需重复派活，把精力放在批准 backlog、独立验证与最终拖拽放行上；若守护与持久士兵并存，认领互斥会自动仲裁，谁先 claim 谁干。

## 使用方式

- 用户说"开始" → 指挥官 `create_goal`（objective 取自 `state.json`），之后自动续轮。
- 用户说"暂停 / 继续" → `update_goal` pause / resume。
- 用户说"换目标" → 更新 `state.json` 与本文档，再 `update_goal` edit。

# 当前状态入口（STATUS）

> **这是判断「Legion 现在是什么状态」的唯一入口。** 全仓所有 `docs/**-evidence/`、`docs/G-*/`
> 目录内的文档都是**历史快照**（顶部带 `⚠️ 历史快照` banner），其中的测试数量、端口、命令与
> 结论只代表当时基线，**不得作为当前状态依据**。

**最近一次全量基线**：2026-09-10　commit `4b81c8f`　`run-ci --only test` **25 套件 / 576 测试全 PASS**（113s）

---

## 1. 当前形态与拓扑

| 层 | 组件 | 默认地址 | 说明 |
| --- | --- | --- | --- |
| 指挥台 | `workbench/` | `http://127.0.0.1:5173` | 空间/编队、目标、任务中心（含 Scrum 看板视图）、3D 总览、调度验收、对话/文件/浏览器、规范/技能/日历/通知 |
| 数据面 | `team-hub/server.mjs`（v2） | `http://127.0.0.1:8787` | **唯一业务实现**：SQLite（`team-hub/team.db`）、HTTP API、任务状态机、审计与 SSE 事件流 |
| 宿主外壳 | `team-hub/src/index.ts` | 宿主 `:3080` 的 `/team-hub` | 仅做该前缀路由注册 + env 转接，业务全部委托 `server.mjs`；与 8787 **同库** |
| 看板面板 | `board-plugin/` | 宿主 `:3080` 的 `/scrum-board` | DSH 会话内 iframe 面板；配置 `hubUrl` 或探测同宿主 `/team-hub` 后走 v2（hub 模式），否则退回本地文件模式 |
| 执行面 | `plugins/` | DSH 宿主内 | 扫单、认领、派工、隔离 worktree、自动交接、合入调解、对话回复、经验召回 |
| 生命周期 | `services-plugin/` | DSH Desktop 内 | 随 Desktop 自启停 8787 / 5173；**`:4820` v1 看板已退役**（不再托管） |
| v1 兼容面 | `scrum/` | — | 保留 v1 协议引擎与 `serve.mjs`（供契约测试与本地自托管）；**任务库 `tasks.json` 已归档**，日常入口不再使用 |
| 独立应用 | `whiteboard/` | `http://127.0.0.1:8080` | 零第三方依赖的多人实时协作白板，不属 Legion 核心三件套 |

关键约定：

- **单一数据池**：宿主 `/team-hub` 与独立进程 8787 共用 `team-hub/team.db`（`team-hub/src/index.ts` 默认
  `dbPath=''` → server.mjs 默认库）。因此两者是**多进程写同一库**：`audit.seq` 等分配必须在写事务内读库
  取号（回归见 `scripts/ci/dual-write-smoke.test.mjs`，已入 CI）。
- **单一事件流**：写操作一律经 `audit()` 落库并广播 SSE；`/api/events` 带 `id:` 行（seq）与信封字段
  `{seq, event, id, payload}`，支持 `Last-Event-ID` 断线续传（契约见 `docs/CONTRACT-V1V2.md`）。
- **部署链**：`~/.dsh/profiles/web/node_modules/@dsh-external/*` **必须是 junction（指向本仓源码目录）**，
  否则宿主会加载陈旧复制副本而不生效：
  ```powershell
  Get-Item ~/.dsh/profiles/web/node_modules/@dsh-external/* | Select-Object Name, LinkType   # 应全为 Junction
  ```
- **v1 独有动作**：`/api/reject`、`/api/promote`（v1 worktree git 语义）在 v2 hub 模式下返回 **501 降级指引**，
  请改用 `transition` + `comment`（v2 分支合入由 worker 完成）。

## 2. 测试基线与复跑方式

全量门禁（单命令）：

```powershell
cd D:\project\DSH\legion
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'   # 宿主面测试需要 DSH checkout
node scripts/ci/run-ci.mjs --only test --out .ci\<run-name>
```

产物：`.ci/<run-name>/ci.log`（全量输出）与 `summary.json`（阶段结论）。当前基线 25 套件：

| 套件 | 用例 | 套件 | 用例 |
| --- | --- | --- | --- |
| chat | 42 | contracts | 56 |
| skills | 20 | v1v2-contract | 14 |
| calendar | 13 | team-hub-parity | 1 |
| spaces | 5 | dedupe | 9 |
| goal | 14 | dual-write | 2 |
| rules | 7 | p13-host-injection | 6 |
| artifact | 16 | whiteboard | 70 |
| security | 6 | plugins | 135 |
| read-auth | 14 | board-plugin | 37 |
| files-api | 41 | scrum | 25 |
| web | 24 | skill-importer | 4 |
| doc-render | 11 | hub-board / artifact-policy | 1 / 3 |

其他阶段：`--only doc`（文档新鲜度 + 历史 evidence banner 覆盖）、`--only build|smoke|env|deps|stage`。
部署与回滚：`docs/DEPLOY.md`。现场（真实宿主）验收脚本：`scripts/live/p11-step2-verify.mjs`。

## 3. 文档地图（按可信度分层）

| 层级 | 文档 | 用途 |
| --- | --- | --- |
| **当前状态（权威）** | 本文件 `docs/STATUS.md` | 形态/拓扑/测试基线/约定；状态变化先改这里 |
| | `README.md` | 产品总览与快速上手 |
| | `docs/FEATURES.md` | 功能操作手册 |
| | `docs/DEPLOY.md` | 部署、验证、回滚 |
| | `docs/REMAINING-TASKS.md` | 未完成事项与优先级 |
| | `.ci/<run>/summary.json` + `ci.log` | 最近一次机器证据 |
| **契约（权威）** | `docs/CONTRACT-V1V2.md` | v1/v2 语义统一表（状态机、分页、SSE 信封） |
| | `docs/REQUIREMENTS.md`、`docs/ORCHESTRATION-V3.md` | 需求与编排设计 |
| **历史快照（非当前依据）** | `docs/**-evidence/**`、`docs/G-*/**` | 各任务/目标的当时验证记录，顶部均有 `⚠️ 历史快照` banner（含生成日期与基线 commit） |
| **历史交付文档** | `docs/TEST_REPORT.md`、`docs/TEST_CASES.md`、`docs/TASK_BREAKDOWN.md`、`docs/RESEARCH.md`、`docs/P0-CONFIRMATION.md` 等 | 立项期交付物，测试数字以本文件 §2 为准 |
| **运维叙事（过程）** | `docs/P1-LIVE-ROLLOUT.md`、`docs/P2-GOALDOCS-LIVE.md`、`docs/P3-PROD-ROLLOUT.md`、`docs/P1-1-DECISION.md`、`docs/P1-1-step2-runbook.md` | 当时决策与现场步骤；结论已并入本文件 |

## 4. 已知限制（诚实登记）

1. Workbench 部分面板为功能基础版（通知分类/批量已读、日历冲突检测、文件批量与续传、浏览器缓存与截图、
   对话真实模型通道 E2E 等仍在 `docs/REMAINING-TASKS.md` 待办）。
2. 白板为单实例单房间模型（多房间与连接治理待办）。
3. 配置仍分散在环境变量 / CLI / services-plugin / 宿主 patch / Workbench 本地设置之间（统一配置系统待办）。
4. board-plugin 的 hub 动态面板为轻量自渲染（覆盖看板主操作），未复刻旧静态页全部视觉细节；
   无 hub 时退回本地文件模式，此时不渲染 v1 静态产物。
5. 生产宿主 `/team-hub` 与 8787 双进程写同库：已通过事务内取号保证一致性，但两进程的
   `audit` 广播各自独立（事件流不跨进程合并）；消费方以 SSE 连接的那个实例为准。

## 5. 维护约定

- **状态变化**（拓扑、端口、数据池、测试基线、已知限制）→ 更新本文件，并同步 `README.md` 的必要部分。
- **新增 evidence**：在 `docs/` 下建立 `*-evidence/` 目录后运行
  `node scripts/ci/evidence-banner.mjs` 补 banner（幂等）；CI `doc` 阶段会校验覆盖完整性
  （`node scripts/ci/evidence-banner.mjs --check`，由 `check-docs.mjs` 统一驱动）。
- **不要**把历史快照的结论回填进本文件；本文件只写当前可复现的事实与命令。

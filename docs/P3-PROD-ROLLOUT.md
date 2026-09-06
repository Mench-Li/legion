# P3 生产滚动 Runbook —— 「目标级分析文档目录（docs/<goalId>/）」上线

> 前置（均已就绪，2026-09-06 核对）：
> - 特性代码：`team-hub/server.mjs`（goal.docsDir 列 + publish 自动赋值 + goalDocDirOf/goalDocPathOf）、
>   `plugins/src/index.ts`（buildWorkerPrompt 目标目录注入 / gate 按目标目录校验 / orchestrateSlices 读取）已合入 main。
> - 回归基线：plugins tsc 0 错、plugins 测试 36/36、team-hub 测试 82/82。
> - 沙箱实弹验收通过：见 `docs/P2-GOALDOCS-LIVE.md`（f04801d）与 `D:\tmp\docacc-acceptance-evidence.txt`。
> - 生产 DB 现状：`team.db` 的 `goal` 表**已含 docsDir 列**（早前某次测试误触迁移，幂等无害）；
>   全部 4 个目标行 `docsDir=NULL` → 保持 legacy 根 `docs/` 槽位行为，不受上线影响。
> - `plugins/lib/index.js` 已含新符号（mtime 14:19:39 当日重建；junction 直出源码）。

## 1. 重启动作（唯一需要人做的步骤，会中断当前 GUI 会话）

目标：让 8787 team-hub 与 DSH web 宿主内的守护进程都按新代码运行。
两进程是同一宿主树（legion-services 托管 team-hub），**必须整宿主重启一次到位**，不要只重启 hub
（hub 新 + worker 旧会导致新目标文档落位与 gate 校验不一致）。

1. 停止 DSH web：结束 3080 监听进程树
   ```powershell
   $pid3080 = (Get-NetTCPConnection -LocalPort 3080 -State Listen).OwningProcess
   taskkill /PID $pid3080 /T /F
   ```
   （若你用桌面/脚本方式启动，按你的日常方式停启亦可；随后 legion-services 会回收 8787/4820/5173。）
2. 在仓库根重新启动：
   ```powershell
   cd D:\project\DSH\dsh\deepseek-harness
   pnpm dsh web
   ```
   （与本机当前宿主同款命令；启动完成以 3080 可访问为准，冷启动约 3–4 分钟。）
3. 记录重启时间：________（UTC ________）

## 2. 重启后核对清单（由将军/下个会话执行）

- [ ] `curl http://127.0.0.1:8787/api/config` 返回 200
- [ ] goal 表 docsDir 列仍在（迁移 no-op 幂等）：`PRAGMA table_info(goal)` 含 docsDir
- [ ] `GET /api/goal?scope=software`：既有 4 目标行仍 `docsDir:null`（legacy 不变）
- [ ] 守护日志恢复扫单：`~/.dsh/super-injector/dsh-scrum-worker.log` 出现新的 `inbox=N` 行
- [ ] 在办 worker 孤儿回收符合预期：重启前 in_progress 的任务被守护释放回 todo 并重派续做
      （w/<id> WIP 保留；G-mtolvlpy-1 / G-mtpaab3x-1 继续以根 docs/ 收尾，不受影响）
- [ ] （可选抽查，仅在确有真实新需求时）发布新目标 → 返回 `docsDir: docs/G-<id>`，
      需求/方案文档落 `docs/G-<id>/`，闸门注释带目标目录路径

## 3. 回滚点

- **目标级回滚（默认手段，零代码）**：某新目标出问题 → 退回 legacy 根 docs/ 行为：
  ```sql
  UPDATE goal SET docsDir = NULL WHERE id = '<G-x>';
  ```
  守护随后对该目标按根 `docs/` 槽位处理（与另两个 legacy 目标一致）。
- **代码级回滚**：需 git revert + 重建 plugins/lib + 再整宿主重启，成本高；因 NULL 兼容已兜底，
  一般不需要。

## 4. 行为分界（上线语义）

| 目标 | docsDir | 行为 |
|---|---|---|
| 既有 4 目标（G-001/G-002/G-mtolvlpy-1/G-mtpaab3x-1） | NULL | legacy：写根 `docs/`，与现状完全一致 |
| 重启后新发布目标 | `docs/G-<id>` | 目录隔离：阶段文档/闸门/提示词全走本目标目录，可跨目标并行 |

## 5. 备注

- 运行中生产调解流（T-099/T-107 等 stash/pop）与工作树：重启前若遇新冲突标记，先按
  docs/ORCHESTRATION-V3.md 惯例三方合并再重启；本次预检工作树无 tracked 改动。
- 验收证据、复跑步骤见 P2 runbook；设计说明见 ORCHESTRATION-V3.md §12。

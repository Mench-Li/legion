# BUG-045：守护重启会打断正在跑的工作流阶段，结果被标 unknown 并挂起，产物其实已落盘

## 现象

目标 `G-mw34jokf-2` 的最后一环 `T-307`（devops）跑了 **1586 秒**，期间宿主重启（本次是人工重启 hub 加载新代码）。重启后：

```
attempt: unknown
摘要: worker process ended before a terminal provider result was recorded
评论: 守护重启后工作流阶段结果未知（stage=devops, provider=unknown）；
      可能已发生外部副作用，已挂起等待人工核对，不自动重派
```

而实际上 **产物已经完整落盘**：

```
docs/G-mw34jokf-2/DEPLOY.md          38,735 字节 / 467 行
docs/G-mw34jokf-2/deploy-evidence/   18 份真证据（CI 绿基线、274 例回归、tsc 0 诊断…）
git status: 仅新增 docs/G-mw34jokf-2/（产品代码 0 改动）
```

## 根因

1. 阶段执行的终态事实**只由 provider 回报**（`agent-workflow:attempt-report` → `completed`）；
2. 守护进程被重启时，正在跑的 provider 句柄随之消失，没有任何一方写下终态 ⇒ attempt 停在 `running`，重启后被"结果未知"回收（`releaseStaleTasks` / 隔离逻辑）；
3. 隔离逻辑出于"可能有外部副作用，不能自动重派"的保守原则，把任务挂到 `in_review` 等人工核对——**这条原则本身是对的**，问题在于：**它没有去看现场到底留下了什么**。

> 一个"结果未知就等人"的回收器，
> 与一个"结果未知、但先说清现场留下了什么"的回收器，
> 区别只在被重启打断的那一次——而那一天恰好是最需要它说清楚的一天。

## 影响面

- 任何长阶段（devops 常跑 20+ 分钟）都可能被重启/崩溃打断；
- 每次都要人工去 worktree 里翻产物、判断"到底做完了没有"，再手工收口；
- 更危险的一面：如果产物**只做了一半**，人工也可能误判为完成（本次是我逐份核对了 DEPLOY.md 467 行 + 18 份证据才收口）。

## 修复方向（待实现，本次只记录）

- **A**：attempt 进入 `running` 时把 `workspace_dir` / 分支 / 起始 HEAD 落库（现在 `workspace_dir` 有写但未用于回收）；重启后回收器先采集现场事实（`git status`、新增/修改文件清单、HEAD 变化），随"未知"一起写进评论，再挂起等人工；
- **B**：区分"未知但有产物"与"未知且无产物"——前者给一句"现场已产出 N 个文件，请核对后收口"，后者提示"无产物，可直接重派"；
- **C**：长阶段加"心跳存证"（每 N 分钟写一条 attempt 进展），重启后至少知道跑到哪一步。

## 现场证据

- `T-307` 的 attempt：`state=unknown`，`created_at_ms → updated_at_ms` = 1586 秒；
- 任务评论最后两条即上述隔离提示（"守护重启后工作流阶段结果未知…"）；
- 工作区 `.legion-worktrees/T-307`（HEAD `49b26df5`）里 `docs/G-mw34jokf-2/DEPLOY.md` + `deploy-evidence/` 完整；
- 收口时我把核对结论（产物清单、274 例回归读数、产品代码零改动）写成 evidence 评论附在 T-307 上，可追溯。

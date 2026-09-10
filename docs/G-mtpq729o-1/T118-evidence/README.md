<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `9f374fa`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-118 证据目录（devops 收尾部署）

> 目标 G-mtpq729o-1｜阶段 devops（T-118）｜角色：部署与 CI/CD
> 正式产物：docs/G-mtpq729o-1/DEPLOY.md（部署/发布清单 + 影响 + 验证 + 回滚）

| 文件 | 内容 |
| --- | --- |
| 00-env.txt | 执行环境基线（node v24.19.0 / HEAD 6553d3e / worktree w/T-118 / 行尾与依赖 junction 事实） |
| 01-ci-full-run.txt | 全量发布前 CI 门禁（run-ci 7 阶段全 PASS，含 ci.log 全文 + summary.json） |
| ci-run-6553d3e/ | run-ci 原始产物（ci.log + summary.json，stage 记录） |
| neg-doc-run/ | 负例 run-ci --only doc 产物（doc FAIL exit=1，含 README.md:180 明细） |
| 02-plugins-surface.txt | 机制面回归：plugins tsc 0 诊断 + node --test 54/54 |
| 03-doc-gate-negative.txt | 门禁负例注入验证（坏锚点 -> doc FAIL 可读；字节级还原后全绿） |

全部命令在隔离 worktree（w/T-118）真实执行；零新增依赖、未联网、未 push。

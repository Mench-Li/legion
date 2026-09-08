# T-117 测试执行 · 验证证据（docs/G-mtpq729o-1/T117-evidence/）

任务：[[auto-goal] 功能使用介绍文档 + 功能/迭代持续同步] 测试执行（S1~S5，66 用例）。
验证结论：**56 PASS / 8 FAIL / 2 环境受限（R-18）**，判定未全绿。文档内容（S1/S2）与校验逻辑（S3/S5 LF 语义）通过；发现 4 类缺陷/缺口（详见 TEST_REPORT.md §3/§4）：

- RC-1（S3-02/S5-02，P0）：check-docs.mjs 不兼容 CRLF（autocrlf=true 的 Windows checkout 假红 44 处；提交 blob 纯 LF、工作区 CRLF 实测）。
- RC-2（S4-01/04/06/07，P0）：docSync 无声明/持久化通道（hub API 实测丢弃 docSync/feature；plugins 三处 t.docSync===true 分支真实流不可达）。
- RC-3（S5-07，P1）：run-ci stageDoc 过滤吞掉模块级错误细节。
- RC-4（S2-13，P2）：FEATURES.md 无指向 README 的反向锚点链接。

| 文件 | 内容 |
| --- | --- |
| 00-env.txt | 环境基线（node v24.19.0 / git ce87364 / autocrlf=true / 无 node_modules） |
| 01-s1-s2-assert.txt | 独立内容断言输出：42 PASS / 1 FAIL（TC-S2-13） |
| 02-s3-check-docs.txt | --help exit0；CRLF 假红 44 FAIL（exit1）；LF 镜像正向 exit0；TC-S3-05/06/07 负例注入+还原；零依赖 import 区 |
| 03-s5-run-ci.txt | STAGES 清单；CRLF --only doc FAIL / --skip doc PASS；LF 镜像正/负/skip/还原；summary.json + ci.log 摘录 |
| 04-s4-review.txt | plugins docSync 消费/追加/提示词/goalize 源码走查；team-hub 无列无透传；hub API 实测（create/goal 丢弃字段）；sim 7/7；stage-standards 验收项；环境受限复现步骤 |
| 05-regression.txt | 改动文件域、零依赖断言、回归范围与静态结论 |
| assert-docs.mjs | 自写独立断言 harness（S1/S2 机器行，内存归一化 \r，42 断言） |

## 执行要点
- 文档断言：check-docs.mjs 与 assert-docs.mjs 双轨互证；负例注入均在 LF 归一化镜像 scratch/t117-lf-mirror/ 执行，仓库真实文档零改动（git status 仅本报告/证据/目标镜像）。
- S4 实测：scratch team-hub 实例（TEAM_HUB_PORT 18787/18788 + 独立 DB）POST /api/create 与 POST /api/goal；随机种子铺 8 岗后验证链任务无 docSync。
- 环境受限（R-18）：plugins typecheck 与 node --test plugins/tests 需宿主 pnpm install && build（worktree 无 node_modules、禁网）。

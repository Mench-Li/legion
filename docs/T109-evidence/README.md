# T-109 测试执行证据目录

| 文件 | 内容 |
| --- | --- |
| 01-env.txt | 执行环境：node v24.19.0、worktree w/T-109 @ HEAD 310002a、依赖搭建方式、沙箱边界 |
| 02-s1-doc-contract.txt | S1 契约套件 node plugins/tests/doc-contract.test.mjs → 4/4 pass |
| 03-s2-artifact-register.txt | S2 登记套件 node plugins/tests/artifact-register.test.mjs → 7/7 pass |
| 04-s3-artifact-content.txt | S3 内容端点套件 node team-hub/artifact-content.test.mjs → 16/16 pass |
| 05-s4-doc-render.txt | S4 渲染器套件 node workbench/scripts/doc-render.test.mjs → 11/11 pass |
| 06-s6-artifact-detail.txt | S6 看板逐条套件 node scrum/artifact-detail.test.mjs → 10/10 pass |
| 07-typechecks.txt | plugins/board-plugin tsc --noEmit 0 诊断；workbench TS1185×3（F1）|
| 08-hub-regression.txt | hub 回归六套件 goal/skills/calendar/chat/spaces/rules = 82/82 pass |
| 09-plugins-worker-regression.txt | worker-regression 5/7；2 条 git-spawn EPERM 环境受限 |
| 10-taskctl-ttl-env.txt | taskctl.ttl 套件受限根因：node spawnSync EPERM 探针 |
| 11-l1-smoke.txt | S3 hub 内容端点真进程 HTTP L1 冒烟 RESULT: PASS |
| 12-static-redline.txt | dangerouslySetInnerHTML 零命中、零新增运行时依赖、roles.json 仅新增 docs |
| 13-m1m2-probes.txt | M1/M2 探针输出（A1/A2/B）：F2/F3 确定性复现 |
| 14-live-artifacts.txt | live team.db 只读核对：当前链 T-108 登记正确；docsDir 目标 T-111 误登记根路径（F2 实锤）|
| 15-apptsx-conflict.txt | workbench/src/App.tsx 314-330 已提交冲突标记 + 引入提交 82d610c + T-101 F4 历史 |

复现探针（scratch/t109-probes/）：probe-m1m2.mjs（F2/F3 确定性复现，驱动真实 plugins lib apply 结算）、db-probe2/3.cjs（live 库只读核对）、snip-apptsx.cjs。

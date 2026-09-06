# T-107 编码实现证据目录

本目录存放 T-107「环节产出文档在任务详情直接打开预览」编码实现批的真实命令证据（每次均为实际运行输出要点）。

| 文件 | 内容 |
| --- | --- |
| 01-s1-doc-contract.txt | S1 契约测试：node plugins/tests/doc-contract.test.mjs → tests 4 pass 4 fail 0 |
| 02-s2-artifact-register.txt | S2 登记测试：node plugins/tests/artifact-register.test.mjs → tests 7 pass 7 fail 0 |
| 03-s3-artifact-content.txt | S3 hub 内容端点测试：node team-hub/artifact-content.test.mjs → tests 16 pass 16 fail 0 |
| 04-s4-doc-render.txt | S4 渲染器测试：node workbench/scripts/doc-render.test.mjs → tests 11 pass 11 fail 0 |
| 05-s6-artifact-detail.txt | S6 看板逐条测试：node scrum/artifact-detail.test.mjs → tests 10 pass 10 fail 0 |
| 06-plugins-worker-regression.txt | plugins 回归：5/7 绿；2 条 fixture git-spawn 用例沙箱 EPERM 环境受限（R-18）|
| 07-plugins-typecheck.txt | plugins tsc --noEmit exit 0 |
| 08-board-plugin-typecheck.txt | board-plugin tsc --noEmit exit 0 |
| 09-workbench-typecheck.txt | workbench tsc --noEmit exit 0 |
| 10-workbench-vite-build.txt | vite→esbuild spawn EPERM 复现（R-18 环境受限记录）|
| 11-plugins-build.txt | plugins tsc emit exit 0 → lib/ |
| 12-hub-l1-smoke.txt | S3 真实进程 HTTP L1 冒烟 RESULT: PASS |
| 13-board-plugin-build.txt | board-plugin 构建记录（bash 不可用；tsc emit 产出 lib/）|
| s3-l1-smoke.mjs | S3 L1 冒烟脚本（可复跑：起临时 hub + 临时仓库 fixture）|

汇总报告见 docs/TEST_REPORT.md（S8 集成回归锚定）。

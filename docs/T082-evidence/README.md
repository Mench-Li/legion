# T-082 证据目录 —— 切片 S3 ChatView 会话/空间身份守卫（R-A5）测试执行

报告：docs/TEST_REPORT.md（T-082）

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| 01-chat-dao.txt | node team-hub/chat.test.mjs | 13/13 exit 0 |
| 02-skills.txt | node team-hub/skills.test.mjs | 12/12 exit 0 |
| 03-chat-l1-smoke.txt | node team-hub/chat-l1-smoke.mjs（真实双进程 + SSE） | 22/22 |
| 04-contracts.txt | node tests/contract/contracts.test.mjs | 56/56 exit 0 |
| 05-files-api.txt | node workbench/scripts/files-api.test.mjs | 40/40 exit 0 |
| 06-web.txt | node workbench/scripts/web.test.mjs | 21/21 exit 0 |
| 07-l2-e2e.txt | node docs/T082-evidence/l2-s3-guard.e2e.mjs（headless Chrome + 真 hub + 延迟代理） | 17/17 |
| 08-tsc-noemit.txt | tsc -p workbench/tsconfig.json --noEmit | exit 0 零错误 |
| 09-build.txt | vite build（workbench） | exit 0（615 modules） |
| 10-s3-review.txt | node docs/T082-evidence/s3-static-review.mjs（TC-S3-01/06/08 断言） | 23/23 |

复现脚本（随证据留存，零第三方依赖）：
- l2-s3-guard.e2e.mjs —— L2 行为级竞态 E2E（TC-S3-02/03/04/05/08）：真 hub + 延迟代理(2600ms loadOlder/send) + serve.mjs 静态 + headless Chrome CDP；node docs/T082-evidence/l2-s3-guard.e2e.mjs
- s3-static-review.mjs —— TC-S3-01/06/08 静态断言（行号/顺序/无残留/渲染安全）；node docs/T082-evidence/s3-static-review.mjs

环境注记：本 worktree 无 node_modules（不随 git 分发），tsc/vite build 经 mklink /J 指向宿主主 worktree 既有 node_modules（git 忽略）；沙箱禁网未下载任何依赖，零新增依赖由 T-081 diff（仅 ChatView.tsx 1 文件）实证。

<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-06**（commit `766c7df`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-101 测试执行证据目录

> 任务 T-101（tester）：四能力批（R-1 跨空间技能 / R-2 分层规范 / R-3 移除空间 / R-4 对话 AI 回复）验收测试执行。
> 基线：HEAD dd2fbe3（promote T-100）。被审实现 = T-099 104f99a。报告 = docs/TEST_REPORT.md。
> 全部为真实命令原始输出；日期 2026-09-06。

| 文件 | 来源命令 | 内容 |
| --- | --- | --- |
| 01-plugins-skills-fingerprint.txt | node plugins/tests/skills-fingerprint.test.mjs | S3 指纹缓存 6/6 pass fail 0 exit 0 |
| 02-plugins-norms.txt | node plugins/tests/norms.test.mjs | S5 分层规范 7/7 pass fail 0 exit 0 |
| 03-plugins-chat-responder.txt | node plugins/tests/chat-responder.test.mjs | S10 提示词/护栏 4/4 pass fail 0 exit 0 |
| 04-hub-skills.txt | node team-hub/skills.test.mjs | S1 技能 20/20 pass fail 0（含 HTTP 门禁/审计/级联）|
| 05-hub-rules.txt | node team-hub/rules.test.mjs | S4 rules 7/7 pass fail 0 |
| 06-hub-spaces.txt | node team-hub/spaces.test.mjs | S7 删除级联 5/5 pass fail 0 |
| 07-hub-chat.txt | node team-hub/chat.test.mjs | S9 回复数据面 23/23 pass fail 0 |
| 08-hub-calendar.txt | node team-hub/calendar.test.mjs | 存量回归 13/13 pass fail 0 |
| 09-l1-smoke.txt | node team-hub/chat-l1-smoke.mjs | L1 冒烟 35/35 断言；进程级异常 0；含超龄兜底 |
| 10-m1-chatview-merge.txt | node scratch/repro/m1-merge-ghost.mjs | **F1 复现**：3 FAIL（源消息 meta 不随 replied/failed 流转；chat:fail 无 SSE 消费）|
| 11-m2-grants-leak.txt | node scratch/repro/m2-leak.mjs | **F2 复现**：1 FAIL（A 改版 pending 后 B 复审视图带出草稿全文）|
| 12-m3-window-ghost.txt | node scratch/repro/m3-ghost.mjs | **F3 复现**：2 FAIL（窗口外 awaiting 不 failed、不进队）+ 对照组 PASS |
| 13-o2-unwrap.txt | node scratch/repro/o2-unwrap.mjs | **O2 复核**：7/7 PASS（.task 消费链一致，未复现 undefined）|
| 14-workbench-tsc.txt | node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit | **F4**：3 error TS1185（App.tsx 314/328/330）|
| 15-apptsx-conflict-markers.txt | Select-String workbench/src/App.tsx | F4 冲突标记行原文 |
| 16-plugins-tsc.txt | node workbench/node_modules/typescript/bin/tsc -p plugins/tsconfig.json --noEmit | plugins tsc exit 0（0 诊断）|

复现脚本保留于 scratch/repro/（m1-merge-ghost.mjs / m2-leak.mjs / m3-ghost.mjs / o2-unwrap.mjs）。

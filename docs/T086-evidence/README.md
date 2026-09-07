# T-086 evidence — 切片 S5 日程日历后端测试（R-B1 数据面）

> 测试执行（tester）｜HEAD=5813ae5（含 be34de7 promote T-085）｜沙箱 workspace-write，node v24.19.0
> 被测：team-hub/server.mjs calendar_events + /api/calendar/*（T-085 交付）；只测不修，未改任何源码/用例。

## 文件清单

| 文件 | 来源命令 | 内容要点 |
| --- | --- | --- |
| 01-calendar-suite.txt | node team-hub/calendar.test.mjs | TC-S5-01..09/11 + DAO：tests 13 / suites 10 / pass 13 / fail 0，exit 0 |
| 02-chat-regression.txt | node team-hub/chat.test.mjs | TC-S5-10 回归：13/13 fail 0 |
| 03-skills-regression.txt | node team-hub/skills.test.mjs | TC-S5-10 回归：12/12 fail 0 |
| 04-l1-curlsmoke.txt | 真实 server.mjs（TEAM_HUB_DB=临时库, PORT=29137）+ curl.exe 13 步 | POST×2 → GET 双 scope 日期窗 → delete confirm/越权/非法 400 → activity 审计（calendar:create/delete） |
| 05-sse-live.txt | curl.exe -N 订阅 /api/events 期间 POST create+delete | live 帧 seq4 calendar:create（即时）、seq5 calendar:delete（+145ms），≤5s；seq1-3 为订阅前回放 |

## 判定

- TC-S5-01..12 全部通过，testReport.passed=true，failures=[]。
- 说明：本批 T-085（S5 coder）经 mediator 合入 main（be34de7），修正 T-091 S8 报告 §2.6 "calendar.test.mjs 不存在" 的过时基线结论（详见 docs/TEST_REPORT.md §5）。
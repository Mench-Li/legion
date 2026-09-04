# T-061 S1 测试证据（tester）

> 任务：T-061｜阶段：测试执行（tester）｜对象：S1 team-hub 扩表扩 /api/chat/* + 审计/SSE
> 环境：Windows 沙箱（workspace-write，禁网）；node v24.19.0（唯一运行时）；零第三方依赖下载。
> 证据均为真实命令输出；工作目录 D:/project/DSH/legion/.legion-worktrees/T-061（分支 w/T-061）。

## 文件清单

| 文件 | 内容 | 关键结果 |
| --- | --- | --- |
| 01-chat-dao.txt | node team-hub/chat.test.mjs | 13 tests / 5 suites / pass 13 / fail 0，exit 0 |
| 02-skills-regression.txt | node team-hub/skills.test.mjs | 12 tests / 5 suites / pass 12 / fail 0，exit 0 |
| 03-chat-l1-smoke.txt | node team-hub/chat-l1-smoke.mjs | 22/22 断言通过、进程级异常 0，exit 0 |
| 04-contracts-baseline.txt | node tests/contract/contracts.test.mjs | 56 tests / 8 suites / pass 56 / fail 0，exit 0 |
| 05-sse-latency.txt | node docs/T061-evidence/sse-latency.mjs | live chat:message 推送 avg 234.5ms（min 229.2 / max 241.0），验收 ≤5000ms，exit 0 |
| 06-typecheck.txt | tsc -p team-hub/tsconfig.json --noEmit | 仅 TS2688（缺 @types/node，worktree 无 node_modules）；S1 为纯 JS 不在 TS 构建图 |
| sse-latency.mjs | 自建 SSE 延迟测量探针（真实 server.mjs + 随机端口 + 临时库） | 复跑见 05 日志 |

## 关键判据复跑命令

```
node team-hub/chat.test.mjs        # S1 DAO/路由契约 → 13/13 PASS
node team-hub/skills.test.mjs      # 同模块回归基线 → 12/12 PASS
node team-hub/chat-l1-smoke.mjs    # L1 真实进程 HTTP/SSE/审计/鉴权 → 22/22 PASS
node tests/contract/contracts.test.mjs  # L0 全量基线 → 56/56 PASS
node docs/T061-evidence/sse-latency.mjs # TC-S1-14 SSE ≤5s → avg 234ms
node --check team-hub/server.mjs team-hub/chat.test.mjs team-hub/chat-l1-smoke.mjs team-hub/skills.test.mjs  # exit 0
```

## 判定

S1 对话中心后端（扩表 + 扩 /api/chat/* + 审计/SSE）**全部实测通过，无失败项**。非全绿无；未修改任何实现代码。

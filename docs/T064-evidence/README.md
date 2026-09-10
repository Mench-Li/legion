<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-064 部署与 CI/CD 验证证据（devops）

> 任务：T-064 ｜ 阶段：部署与 CI/CD（devops）｜ 对象：S1 team-hub 扩表扩 /api/chat/* + 审计/SSE
> 环境：Windows 沙箱（workspace-write，禁网）；node v24.19.0；零新增运行时依赖（node:sqlite/http 内置）
> 工作目录：D:/project/DSH/legion/.legion-worktrees/T-064（分支 w/T-064，代码已 promote 入主线，本次仅做构建/部署留痕，未改业务代码）
> 构建基线：DSH_CHECKOUT=D:/project/DSH/dsh/deepseek-harness（build.sh 依赖该 checkout 的 tsc 与 vendor/ 依赖）

## 文件清单

| 文件 | 内容 | 关键结果 |
| --- | --- | --- |
| 00-typecheck.txt | tsc -p team-hub/tsconfig.json --noEmit | exit 0（无输出=类型检查通过） |
| 01-build-compile.txt | tsc -p team-hub/tsconfig.json（src→lib） | exit 0，产出 lib/index.js 21023B + lib/types/index.d.ts 2381B + sourcemap |
| 02-chat-test.txt | node team-hub/chat.test.mjs | 13 tests / 5 suites / pass 13 / fail 0，exit 0 |
| 03-skills-test.txt | node team-hub/skills.test.mjs | 12 tests / 5 suites / pass 12 / fail 0，exit 0 |
| 04-contracts-baseline.txt | node tests/contract/contracts.test.mjs | 56 tests / 8 suites / pass 56 / fail 0（白板/S 面回归基线，未受影响） |
| 05-chat-l1-smoke.txt | node team-hub/chat-l1-smoke.mjs | 22/22 断言通过；进程级异常 0；exit 0 |
| 06-node-check.txt | node --check server/chat/smoke/skills | 各文件 exit 0；node v24.19.0 |

## 复跑命令（真实输出见对应文件）

```
node D:/project/DSH/dsh/deepseek-harness/node_modules/typescript/bin/tsc -p team-hub/tsconfig.json --noEmit   # typecheck → exit 0
node D:/project/DSH/dsh/deepseek-harness/node_modules/typescript/bin/tsc -p team-hub/tsconfig.json         # build     → exit 0, lib/index.js
node team-hub/chat.test.mjs        # S1 对话 DAO/路由契约      → 13/13 PASS
node team-hub/skills.test.mjs      # 同模块技能回归基线        → 12/12 PASS
node tests/contract/contracts.test.mjs   # L0 契约回归基线      → 56/56 PASS
node team-hub/chat-l1-smoke.mjs    # L1 真实进程 HTTP/SSE/审计/鉴权 → 22/22 PASS
node --check team-hub/server.mjs 等 5 文件  # 语法门禁 → exit 0

# 依赖接线（build.sh 等价步骤复刻；node_modules + lib 均为 gitignore，不进提交）
New-Item -ItemType Junction -Path node_modules/@deepseek-ai -Target <checkout>/vendor/cordis 等 7 个 junction
```

## 判定

构建 / CI 全绿：typecheck 0、build 0（lib 产物产出）、S1 对话契约 13/13、同模块回归 12/12、契约基线 56/56、
L1 真实进程冒烟 22/22（含 TC-S1-14 SSE ≤5s live 接收、TC-S1-17 Bearer 鉴权矩阵、TC-S1-15 断连不崩）。
未修改任何业务实现代码（git status 仅 docs/DEPLOY.md、docs/T064-evidence/ 与 team-hub 的 node_modules/lib 构建产物，
后两者在 .gitignore 内）。部署 / 发布清单与变更影响见 docs/DEPLOY.md。

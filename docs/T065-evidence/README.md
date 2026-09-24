# T065-evidence —— S2 workbench ChatView + 接线（tester 实测日志）

> 任务 T-065｜角色 tester｜分支 w/T-065｜日期 2026-09-04｜沙箱 workspace-write（禁网、禁装依赖）

## 复现/复验方法
1. 复用主仓库同 commit（HEAD=d3e057d）的 node_modules（junction）与 dist（同 commit 构建产物，已 grep 含 S2 特征串）。
2. `node team-hub/chat.test.mjs` / `node team-hub/skills.test.mjs`：S1/S2 后端契约（node:test 进程内）。
3. `node workbench/scripts/chat-s2-smoke.mjs`：真实双服务（team-hub + serve.mjs /hub 代理）L1 数据面冒烟。
4. `node docs/T065-evidence/s2-probes.mjs`：双服务 + 边界/安全/XSS/kind/SSE 探针。
5. `node_modules/.bin/tsc.cmd --noEmit`：前端类型检查。

## 文件
| 文件 | 内容 | 结果 |
| --- | --- | --- |
| 01-typecheck.txt | tsc --noEmit | EXIT=0，0 类型错误 |
| 02-vite-build.txt | vite build | spawn EPERM（esbuild 服务子进程被沙箱 named-pipe 拦截，环境） |
| 03-pnpm-build.txt | pnpm build（=tsc && vite） | 同 EPERM（tsc 先过，vite 崩） |
| 04-chat-test.txt | team-hub/chat.test.mjs | 13/13 pass |
| 05-skills-test.txt | team-hub/skills.test.mjs | 12/12 pass |
| 06-chat-s2-smoke.txt | workbench/scripts/chat-s2-smoke.mjs | 9/9 断言通过 |
| 07-s2-probes.txt | docs/T065-evidence/s2-probes.mjs | 10/10 通过 |
| 08-static-wiring.txt | read+grep 静态核对 | 见报告 §4 静态表 |
| s2-probes.mjs | 边界/安全探针源码（可复跑） | node --check exit 0 |

## 结语
- 可执行面全部通过（tsc 0、chat 13/13、skills 12/12、smoke 9/9、probes 10/10、静态无 dangerouslySetInnerHTML 直插正文）。
- 未闭环：① vite build esbuild spawn EPERM（宿主补跑 pnpm build）；② §7.1 L2 浏览器清单纯 GUI 渲染项（沙箱无浏览器，需 tester+将军手工验收）。
- 零新增依赖，未改任何实现代码（git status 仅 docs/ 下报告与证据）。


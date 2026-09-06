# T-107 编码实现自测报告 + S8 集成回归锚定 —— 「环节产出文档在任务详情直接打开预览」

> 角色：编码实现（coder）｜任务：T-107｜分支：w/T-107（独立 worktree）
> 上游：T-103 REQUIREMENTS.md（R-1~R-4 + AC-R1-1..5 / AC-R2-1..5 / AC-R3-1..7 / AC-R4-1..3 + §6 E2E）→ T-104 RESEARCH.md → T-105 TASK_BREAKDOWN.md（切片 S1~S8 机器行）→ T-106 TEST_CASES.md（82 条用例）
> 运行时：node v24.19.0、tsc 5.9.3（宿主沙箱 workspace-write、禁网、无审批通道）
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-092 三中心批报告；git 历史可回溯）。
> 环境受限标注（R-18，仓库既定口径，不冒充通过）：沙箱边界 =「子进程经 pipe stdio 捕获输出 → spawn EPERM」，因此
>  ① node:test 测试以仓库 L0 既定等价形态 **`node <file>` 直跑**（进程内执行、不 spawn 子进程）；
>  ② vite build / bash scripts 属宿主侧（esbuild/WSL EPERM 与 E_ACCESSDENIED，本批复现记录于证据 10/13）；
>  ③ worker-regression 中 2 条依赖 fixture 自身 `git init`（测试内 spawn pipe）的用例为环境受限失败（与 T-092 同因），非实现回归（其余 5 条全绿）。

---

## 0. 结论速览

| 切片 | 实现落点 | 自测判定 | 要点 |
| --- | --- | --- | --- |
| S1 岗位文档契约数据模型 | roles.json + plugins/src/index.ts（stageContractDocs/resolveStageDocPaths 纯函数）| ✅ 4/4 | node plugins/tests/doc-contract.test.mjs exit 0；roles.json 七文档岗 docs 契约 + 模板 {taskId} + artifact 回退 + 既有字段逐字节不动（AC-R1-1/5） |
| S2 结算自动登记 + 缺失软门禁 | plugins/src/index.ts（registerContractDocs/contractDocSummary，done 结算在 commitWorktree 后 autoPromote 前）| ✅ 7/7 | node plugins/tests/artifact-register.test.mjs exit 0：登记相对路径/带 digest、{taskId} 展开、缺失停 in_review + 评论提示、gate 岗不回归、补全重跑、coder 无登记、幂等+变化追加（AC-R1-2..5 / AC-R2-3 / G-R2）|
| S3 hub 内容端点 | team-hub/server.mjs（GET /api/artifact/content + resolveArtifactReadTarget）| ✅ 16/16 + L1 PASS | node team-hub/artifact-content.test.mjs exit 0（16 用例：逐字/分支态/主仓兜底/403 三类逃逸/404 vs 400/512KB 截断/二进制降级）；真实进程 HTTP 冒烟 PASS（证据 12：200 分支态内容 + digest 落库 + 400/404）（AC-R3-1..7 / K5-A / K9 / K10）|
| S4 md 渲染器 | workbench/src/components/MarkdownDocView.tsx（React 元素直出、零 dangerouslySetInnerHTML、协议白名单集中 SAFE_PROTOCOLS）| ✅ 11/11 | node workbench/scripts/doc-render.test.mjs exit 0（结构/安全/回退/真实文档冒烟）（AC-R3-4/5 / G-R4 / K6-A）|
| S5 任务详情直达区 | workbench TaskDetailModal.tsx（产出文档区 + 同屏 MarkdownDocView 预览 + 多轮倒序最新高亮 + 空态 + 错误文案）+ api.ts fetchHubDocContent + types.ts HubDocContent + index.css | ✅ typecheck 0 诊断 | tsc -p workbench/tsconfig.json --noEmit exit 0；vite 段沙箱 EPERM 复现（证据 10，R-18）（AC-R2-1..5）|
| S6 经典看板逐条补齐 | scrum/render.mjs（artifactSection 逐条条目 + wireArtifacts 逐条预览接线，替换“仅最新一条”旧块）+ serve.mjs /api/artifact（i 逐条 + md/txt/html content-type + url/file 语义 + ../、.git、根外 403 + 分支态优先/主仓兜底）| ✅ 10/10 | node scrum/artifact-detail.test.mjs exit 0（新增测试文件；含两条 html 逐条、md 全文、降级提示、错误码矩阵）；node --check 通过（AC-R4-1/2/3 / K4-B / K8-A）|
| S7 DSH board-plugin | board-plugin/src/index.ts serveArtifact 逐条化（i 缺省兼容/越界 400/未知 404/url 302/md 内容类型/分支态优先 + resolveArtifactFile 白名单）| ✅ typecheck 0 + lib 产出 | tsc -p board-plugin/tsconfig.json --noEmit exit 0 + 服务端 emit → board-plugin/lib/index.js；DSH 宿主不可达 → R-18 记录（证据 13）（AC-R4-1 DSH 面）|
| S8 集成回归锚定 | docs/TEST_REPORT.md + docs/T107-evidence/ | ✅ 见 §3 | 全批套件真实运行记录 + E2E 口径逐条对应 |

- 全批**零新增运行时依赖**（见 §4 复核）。
- 边界红线：MarkdownDocView 与 md 预览路径零 dangerouslySetInnerHTML / 零 innerHTML（§4 grep）；渲染原始 HTML 一律按文本；javascript:/data: 协议白名单外退化纯文本。

## 1. 切片执行证据（命令 + 输出要点）

| 证据文件 | 命令 | 输出要点 |
| --- | --- | --- |
| 01-s1-doc-contract.txt | `node plugins/tests/doc-contract.test.mjs` | exit 0；tests 4 / pass 4 / fail 0（roles.json 契约 + 纯函数 + JSON 合法 + next 闭环快照）|
| 02-s2-artifact-register.txt | `node plugins/tests/artifact-register.test.mjs` | exit 0；tests 7 / pass 7 / fail 0（登记/缺失/回退/gate/重跑/幂等/多轮追加）|
| 03-s3-artifact-content.txt | `node team-hub/artifact-content.test.mjs` | exit 0；tests 16 / pass 16 / fail 0（6 suites）|
| 04-s4-doc-render.txt | `node workbench/scripts/doc-render.test.mjs` | exit 0；tests 11 / pass 11 / fail 0（4 suites）|
| 05-s6-artifact-detail.txt | `node scrum/artifact-detail.test.mjs` | exit 0；tests 10 / pass 10 / fail 0（render.mjs 静态断言 + serve.mjs L1 真 HTTP）|
| 06-plugins-worker-regression.txt | `node plugins/tests/worker-regression.test.mjs` | exit 1 为环境受限：5/7 全绿；2 条在 fixture `initGitRepo`（git init spawn pipe → EPERM）处失败，非本批实现回归（R-18）|
| 07-plugins-typecheck.txt / 08-board-plugin-typecheck.txt / 09-workbench-typecheck.txt | `tsc -p <pkg>/tsconfig.json --noEmit`（三包各自） | 均为 exit 0、零诊断 |
| 10-workbench-vite-build.txt | `pnpm build`（workbench）| tsc 段通过；vite→esbuild spawn EPERM（沙箱既有边界，复现记录；与 T-047/T-083/T-091/T-092 同因）|
| 11-plugins-build.txt | `tsc -p plugins/tsconfig.json`（emit）| exit 0 → plugins/lib/index.js 产出（doc-contract/artifact-register import 目标）|
| 12-hub-l1-smoke.txt | `node docs/T107-evidence/s3-l1-smoke.mjs` | RESULT: PASS —— POST 建空间/建任务/登记（带 digest）→ GET /api/artifact/content 200（分支态优先 source=worktree、mime=text/markdown、内容 BRANCH-L1）→ digest 落库 PASS → i=9 400 / 未知任务 404 |
| 13-board-plugin-build.txt | `bash scripts/build.sh` | exit 1（沙箱无 bash/WSL E_ACCESSDENIED）；等价替代：tsc emit → board-plugin/lib/index.js + lib/types/index.d.ts（R-18）|
| s3-l1-smoke.mjs | （冒烟脚本本体，可复跑）| 起临时 hub 进程 + 临时仓库 fixture，零外部依赖 |

另有：`node --check scrum/serve.mjs / scrum/render.mjs / team-hub/server.mjs` 全部 exit 0（JS 语法校验）。

## 2. 既有套件回归（本批改动相邻面）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| team-hub skills | `node team-hub/skills.test.mjs` | ✅ 12/12 exit 0 |
| team-hub chat | `node team-hub/chat.test.mjs` | ✅ 13/13 exit 0 |
| team-hub calendar | `node team-hub/calendar.test.mjs` | ✅ 13/13 exit 0 |
| plugins worker-regression | `node plugins/tests/worker-regression.test.mjs` | 5/7 ✅；2 条 git-spawn fixture 环境受限（§0）|
| scrum/taskctl.ttl.test.mjs | `node scrum/taskctl.ttl.test.mjs` | 环境受限：fixture 需 spawn taskctl CLI（pipe → EPERM），沙箱内无法执行（与 T-092 §2.1 同因，非本批改动）|

## 3. E2E 口径对应（REQUIREMENTS §6 + AC 逐条）

| 口径 | 证据落点 | 判定 |
| --- | --- | --- |
| 主分支态逐字（AC-R3-1/E2E-1）| S3 套件「主分支态逐字一致」+「删除 worktree 后回退主仓（source=main）」| ✅ |
| 未 promote 分支态逐字（AC-R3-2/E2E-2，K5-A 零 git CLI）| S3 套件分支态用例 + S6 serve L1（i=0 raw 读 `.legion-worktrees/<taskId>/` 内容）+ hub L1（source=worktree）| ✅ |
| 契约登记/缺失提示（AC-R1-4/E2E-3，G-R2 软门禁）| S2 套件缺失用例：停 in_review + 评论含期望路径/已登记清单；补全重跑解阻 | ✅ |
| 打回多轮倒序最新高亮（AC-R2-3/E2E-4）| S2 幂等/追加用例（同 path 字节未变不重复、变化追加，at 递增）+ S5 UI 按 at 倒序且首条「最新」徽标（docCandidates.sort desc + k===0 doc-newest，typecheck 锚定）| ✅ |
| 渲染安全样例（AC-R3-5/E2E-5）| S4 套件：script/img onerror 按文本转义、javascript:/data: 拒绝、事件属性不存在、safeHref 矩阵；源码零 dangerouslySetInnerHTML | ✅ |
| 512KB 截断/二进制降级（AC-R3-6/K9）| S3 套件：big → truncated=true 内容恰 512KB；NUL/非法 UTF-8 → previewable=false 空内容 | ✅ |
| 存量绝对路径读取期兼容（K10/G-R8）| S3 套件 T-LEGACY（绝对路径剥前缀 + 删 worktree 回退主仓）、根外绝对 403 | ✅ |
| S1 详情直达区（AC-R2-1..5）| S5 typecheck 0 + 组件代码走查（fetchHubDocContent 错误透传、docState loading/ok/err、路径复制、空态文案）| ✅（L2 浏览器级因 GUI 宿主不可达按 R-18 记录）|
| S2 看板逐条（AC-R4-1..3）| S6 套件 10/10（渲染产物静态断言 + serve L1 逐条内容/降级/错误码）| ✅ |
| S7 DSH 托管态 | board-plugin typecheck 0 + serveArtifact 语义与 serve.mjs 对齐（同契约函数级）+ 宿主注入冒烟 R-18 记录 | ⚠️ typecheck✅ 宿主冒烟受限 |

## 4. 纪律复核

- 零新增运行时依赖：git diff --stat 无 package.json 变更（plugins/workbench/board-plugin/team-hub 均未新增依赖；roles.json 仅加 docs 字段）。
- innerHTML 红线：`grep dangerouslySetInnerHTML` 命中仅既有组件（CalendarView/ChatView/FilesView/NotifyView，本批未触碰）；新增 MarkdownDocView、serve/render/hub/plugins 零命中；md 预览路径用 textContent/pre/iframe（html 产物 iframe 隔离预览）。
- 文件域：改动限于本批切片声明域（roles.json、plugins/src/index.ts、plugins/tests、team-hub/server.mjs、workbench/src/{api.ts,types.ts,index.css,components/TaskDetailModal.tsx,components/MarkdownDocView.tsx,scripts/doc-render.test.mjs}、scrum/{render.mjs,serve.mjs,artifact-detail.test.mjs}、board-plugin/src/index.ts）+ docs（TEST_REPORT.md / T107-evidence/）。taskctl.mjs 未改。
- 未 push；改动保留在 w/T-107 worktree，由守护 promote 捕获。
- git add/commit 尝试记录：`git add -A` / `git commit` 均 exit 128 —— `Unable to create 'D:/project/DSH/legion/.git/worktrees/T-107/index.lock': Permission denied`（沙箱禁写共享 .git，与既有批次同因，T-092 §尾注先例）。

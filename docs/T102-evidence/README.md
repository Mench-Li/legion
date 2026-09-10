<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

T-102（部署与 CI/CD，devops）真实命令证据目录
===================================================
任务：T-102｜分支：w/T-102｜发布基线 = main HEAD 92cd5e1（promote T-101）
范围：四能力链（T-095..T-101，R-1 共享技能 / R-2 分层规范 / R-3 移除空间 / R-4 对话 AI 回复）
      + 产物文档直达预览链规划（T-103..T-106）+ P2/平台支撑；上一发布基线 = 06480ba（T-093）
本目录证据均由真实命令产出（run_code 宿主进程直跑，等价普通终端）；CI 全量日志见子目录。

文件清单
--------
- ci-run-92cd5e1/ci.log      六阶段门禁全量日志（env/deps/build/test/smoke/stage，exit 0）
- ci-run-92cd5e1/summary.json 门禁阶段汇总（failed=0，各阶段耗时）
- 01-f4-build-repair.diff     F4 构建修复 git diff（App.tsx 4 行删除，冲突标记清除）
- 02-f4-tsc-after.txt         修复后 workbench tsc --noEmit 输出（exit 0，0 诊断）
- 03-markers-scan.txt         git grep 全仓冲突标记扫描（修复后 0 残留）
- 04-plugins-compile.txt      plugins tsc src→lib 编译 + 6 测试文件契约（36/36 pass）输出
- 05-suite-baseline.txt       goal/rules/spaces/plugins 套件基线实测（接入门禁前）
- 06-diff-overview.txt        git diff --stat（全部改动文件一览）

关键命令与结论
-------------
1) node scripts/ci/run-ci.mjs --out docs/T102-evidence/ci-run-92cd5e1
   → 六阶段全 PASS，exit 0，44.3s；build：plugins 编译 + whiteboard + workbench（vite 618 modules）；
     test：11 套件 305/305；smoke：chat-l1 35/35 + chat-s2 9/9 + files-s5 32/32 + whiteboard + v1；
     stage：releases/legion-92cd5e1-2026-09-06/（MANIFEST+SHA256SUMS+dist 快照）
2) plugins 编译（DSH 检出 tsc -p tsconfig.json）→ plugins/lib；node --test 6 文件 → 36/36 pass
3) F4 构建修复：workbench/src/App.tsx 移除 82d610c 残留冲突标记（git diff 见 01）；修复后 tsc 0 诊断（02）

放行状态（诚实结论）
-------------------
- 构建/CI 门禁：全绿放行（可部署 dev/acceptance）。
- 产品放行：T-101 实测 M1/M2/M3 三项产品缺陷未修复（本任务边界只做构建部署，不代改业务代码）
  → 不宣称产品放行；逐条状态与复现见 docs/DEPLOY.md §7.2。
- 未发布生产（未获授权）；未 push（pre-push 拦截 w/*）。

<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-088 · 切片 S6 测试证据 —— 日程日历前端（自研月视图 + 接线）

> 角色：测试执行（tester）｜任务：T-088（[slice-test]）｜分支：w/T-088｜HEAD=5813ae5（promote T-091）
> 被测实现：T-087（S6 前端，5c402f8 合入）＋ T-085（S5 后端，8039556 合入）—— 均已在本 HEAD。
> 只测不修：本轮零改动产品源码/测试用例（git status 仅 docs/TEST_REPORT.md + 本证据目录）。

## 环境事实（R-18）
- node v24.19.0；沙箱 workspace-write；禁网、无审批通道；子进程 pipe-stdio spawn → EPERM
  （故 vite build 复现 EPERM，见 build.txt；tsc 0 诊断可用）。
- 浏览器（Chrome/Edge）因 mojo 命名管道被沙箱拒绝无法启动（browser-limited.txt）—— GUI 交互本轮环境受限如实记录。
- 线上服务现状：:8787 真实中枢（main team.db，PID 9304）与 :4820 看板已在运行 —— 本轮全部测试走**隔离 hub
  :8791 + %TEMP% 临时库**（start-hub.mjs），绝不触碰线上数据；app 由 :5273 serve.mjs（DSH_HUB_UPSTREAM=8791）承载。

## 运行了什么（真实命令 → 证据文件）
| 层 | 命令（cwd） | 结果 | 证据 |
| --- | --- | --- | --- |
| 构建门 | node node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit (workbench) | exit 0，0 诊断 | typecheck.txt |
| 构建门 | node node_modules/vite/bin/vite.js build (workbench) | exit 1 spawn EPERM（R-18 复现） | build.txt |
| 构建门(替代) | 原生 esbuild.exe CLI 打包 src/main.tsx → workbench/dist（main.js/main.css/Scene3D chunk） | exit 0；bundle 含 CalendarView 标记 | build.txt 尾注 |
| L0 | node team-hub/calendar.test.mjs 等 6 套件（node <file> 直跑） | 158/158 全绿 | suites-run.txt |
| L1 | node docs/T088-evidence/env/l1-calendar-smoke.mjs（真进程隔离 hub） | 22/22 exit 0 | l1-calendar-smoke.txt |
| 纯函数 | node docs/T088-evidence/env/grid-unit.mjs | 14/14 exit 0 | grid-unit.txt |
| 渲染安全 | grep dangerouslySetInnerHTML（src 全量） | 0 处 JSX 属性式使用 | render-safety.txt |
| L2 GUI | （Chrome 无法启动）上轮 T-087 浏览器闭环 9/9 + 本轮环境受限记录 | 见 browser-limited.txt | T087-evidence/browser-test.txt |

## TC-S6 逐条映射（判定口径：可执行全绿 + 受限如实标注，R-18 与 T-091 同例）
| 用例 | 判定 | 依据 |
| --- | --- | --- |
| TC-S6-01 真实月视图面板（7×N 网格/日期对齐/今天高亮） | ✅ | grid-unit 14/14（35 格/9-1 列 2/今天 5 高亮）+ T-087 浏览器 PASS；tsc/构建绿 |
| TC-S6-02 新建（标题+日期必填、时间可选）入格 + toast + 无整页刷新 | ✅ | L1 create 信封/形状 + 前端校验代码路径（doCreate）+ T-087 浏览器 PASS（全天/带时间两条） |
| TC-S6-03 ①空/日期空保存 ②标题101 ③hub 不可达 | ✅ | 前端校验静态（禁用/拦截 toast）+ L1 400 零落库 5 项 + T-087 浏览器 PASS（断连 toast/恢复重试） |
| TC-S6-04 删除二次确认（取消/确认持久） | ✅ | L1 delete 契约（缺 confirm 400/越权 400/confirm=yes 200）+ T-087 浏览器 PASS |
| TC-S6-05 刷新后条目仍在（GET 非 localStorage） | ✅ | L1 GET 窗 + CalendarView 无 localStorage（grep）+ T-087 浏览器 PASS（reload 后 GET 拉回） |
| TC-S6-06 空间切换隔离互不串 + 未选空间引导 | ✅ | L1 scope 隔离反向双向 + 前端 !scope 引导分支静态 + T-087 浏览器 PASS |
| TC-S6-07 上月/下月/今天 跨月正确 + 今天高亮恢复 | ✅ | grid-unit 跨月/补位/今天高亮 14/14 + T-087 浏览器 PASS |
| TC-S6-08 停 hub 点新建/删除/切换月 → toast、面板不崩；恢复后可操作 | ⚠️ 受限 | 浏览器无法启动 → 代码路径静态（doCreate/confirmDelete catch → toast err）+ L1 SSE/错误语义；上轮 T-087 浏览器 PASS（errToast=1 gridAlive=true）；复验步骤 browser-limited.txt |
| TC-S6-09 XSS 标题纯文本渲染 | ✅ | grep 0 dangerouslySetInnerHTML JSX 使用 + 标题均为 React 文本节点（源码审）+ T-087 浏览器 PASS |
| TC-S6-10 回归 chat/files/browser + tsc/build | ✅ | 六套件 158/158 全绿（含 files-api 40/web 24 回归）；tsc 0 诊断；本片 diff 仅 4 前端文件（T-087），chat/files/browser 面板源零改动 |

## 改动清单（本轮）
```
docs/T088-evidence/*           新增证据（本 README + 6 个 log/txt + env/ 脚本）
docs/TEST_REPORT.md            替换为 T-088 S6 测试报告（上版 T-091 S8 报告在 git 历史可回溯）
workbench/dist/*               测试用构建产物（gitignore，不入 diff）
```
零产品源码/测试用例改动。
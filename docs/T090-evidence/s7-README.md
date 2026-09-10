<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-090 证据目录 —— 切片 S7 通知中心测试执行（tester，只测不修）

任务：切片 S7 测试 —— 通知中心：audit 派生面板 + 接线（R-B2，G-13 门）
分支：w/T-090（HEAD = 5813ae5 = promote T-091 后的主库快照；未 push）
角色纪律：未修改任何源码 / 测试用例（git status 除 docs/TEST_REPORT.md 外仅有本证据目录的新文件）。
被测代码：T-089（切片 S7 coder）合入内容 —— workbench/src/App.tsx、api.ts、components/NotifyView.tsx、components/Sidebar.tsx
（git show dd33c26 --stat / 15c65b9 可查，共 4 文件 +430/-8，无 team-hub 服务端改动 = J8-A 纯前端派生）。

## 环境与命令形态（R-18 环境事实，同 T-083/T-091 先例）

- node v24.19.0；workbench/node_modules = 目录 junction 指向主库既有依赖（git 忽略），零联网零新增依赖。
- 沙箱禁子进程管道捕获：node --test 按文件 spawn 子进程 → EPERM；仓库既定等价形态为 `node <file>` 直跑
  （L0 套件均以该形态执行，进程内不 spawn）。
- vite build（esbuild 原生服务 spawn EPERM）复现见 s7-vite-eperm.txt（本轮实跑 exit 1）；pnpm 不在 PATH。
- 无浏览器 GUI 自动化能力（同 T-083/T-084/T-091 沙箱边界）：L2 纯点击项按「环境受限 + 复现步骤」记录，
  以同代码逻辑探针（编译自 HEAD 真实源码）+ L1 真进程数据面 + 真实组件 SSR 渲染 + 静态接线评审覆盖。

## 文件清单

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| s7-L0-rerun.txt | 本轮（HEAD 5813ae5）六套件复跑：files-api 40/40、web 24/24、chat 13/13、skills 12/12、calendar 13/13、contracts 56/56 = 158/158 全绿 exit 0 | ✅ |
| s7-tsc.txt | tsc -p workbench/tsconfig.json --noEmit（node_modules/typescript/bin/tsc） | exit 0 零诊断 |
| s7-vite-eperm.txt | vite build 复现：esbuild ensureServiceIsRunning spawn EPERM exit 1（R-18 受限，非代码问题） | ⚠️ 受限 |
| s7-l1-notify.mjs + s7-L1-notify-run.txt | L1 数据面探针：真实 team-hub server.mjs（临时库随机端口）+ 既有写接口播种 13 类 audit + /api/activity 语义 + 已读零写 + 单一 /api/events live ≤6s | 23/23 ✅ |
| s7-notify-logic.mjs + s7-logic-run.txt | 白名单/已读游标逻辑探针：被测代码 = HEAD 真实 api.ts 经仓库 tsc 5.9.3 编译（见下编译命令） | 14/14 ✅ |
| s7-ssr-panel.mjs + s7-ssr-run.txt | 真实 NotifyView 组件 SSR 渲染（react 19.2.8 renderToString）：面板结构/引导/scope 文本转义/无 dangerouslySetInnerHTML | 5/5 ✅ |
| s7-static-review.txt | 评审锚点：渲染安全 grep、单一 hub EventSource、无第三数据源、S7 提交域、接线行号 | 见文件 |
| 07-tsc-vite.txt | 上一轮（同 HEAD，被守护中断的 T-090 尝试）遗留的 tsc/vite 记录（保留备查） | — |

> 说明：上一轮遗留的 01~06（六套件旧日志）与本轮 s7-L0-rerun.txt 完全重复且曾遭转码损坏，
> 已删除避免提交乱码内容；同 HEAD 六套件已全部重跑留档（s7-L0-rerun.txt）。

## 编译命令（保证「测的是 HEAD 真实源码」）

- 逻辑探针编译：`node workbench/node_modules/typescript/bin/tsc -p %TEMP%/s7-apitest/tsconfig.json`
  （include = workbench/src/api.ts + types.ts，outDir %TEMP%/s7-apitest/out；module ESNext；产物仅转译零改动）
- SSR 编译：同 tsc 编译 NotifyView/Toast/TaskDetailModal/api/types 五文件（jsx react-jsx；react 19.2.8 自 junction
  解析）；产物相对导入补 .js 后缀/或加无扩展副本后由 node 直接运行；localStorage/window/fetch 注入内存 stub。
- L1 探针直跑：`node docs/T090-evidence/s7-l1-notify.mjs`（临时库真进程，零第三方依赖）

## 逐用例判定速查（详情见 docs/TEST_REPORT.md §2）

TC-S7-01 ✅ / TC-S7-02 ✅ / TC-S7-03 ✅ / TC-S7-04 ✅ / TC-S7-05 ✅ / TC-S7-06 ✅（评审+导航复用锚定）/
TC-S7-07 ✅（L1 SSE 单流 + 静态单 EventSource）/ TC-S7-08 ✅（错误路径静态+SSR 引导）/ TC-S7-09 ✅（渲染安全 + 回归）
—— 无失败项；纯 GUI 点击步骤按 R-18 附宿主复现清单（见 TEST_REPORT §4）。

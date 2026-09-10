<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-084 切片 S4 测试执行证据 —— 浏览器前端收口：合入 w/T-051 为 BrowserView（R-A6）

> 角色：tester（测试执行，只测不修）｜分支 w/T-084（HEAD=c9a8282 promote T-083，工作树干净）
> 依据用例：docs/TEST_CASES.md §4.4（TC-S4-01..10）+ §7.3 L2 清单 + §2 分层（R-18 环境受限记录口径）
> 被测代码：workbench/src/components/BrowserView.tsx / App.tsx / QuickTools.tsx / Sidebar.tsx / serve.mjs（枚举对照）/ api.ts / types.ts —— 本切片未修改任何源码与测试用例。

## 文件清单（均为真实命令输出/日志）
| 文件 | 内容 | 对应用例 |
| --- | --- | --- |
| 01-review.txt | 评审/grep 证据：w/T-051 逐字节 hash 核对、BrowserPanel 残留、XSS 直插扫描、IME 守卫行、双入口接线、历史上限 | TC-S4-01/03/06/07/09/10 |
| 02-web.txt | node workbench/scripts/web.test.mjs —— 21/21 pass exit 0 | TC-S4-02/03 契约锚（S6 抓取契约无回归） |
| 02-files-api.txt | node workbench/scripts/files-api.test.mjs —— 40/40 pass exit 0 | 回归（文件面不受前端切片影响） |
| 02-chat.txt / 02-skills.txt / 02-contracts.txt | team-hub chat 13/13、skills 12/12、tests/contract 56/56 —— 均 exit 0 | 回归（L0 基线全绿） |
| 03-tsc.txt | pnpm exec tsc --noEmit —— exit 0 零诊断（node_modules 经 junction 指宿主） | TC-S4-02 |
| 03-build.txt | pnpm build —— tsc 段过、vite 段 spawn EPERM 复现（沙箱边界，非代码问题） | TC-S4-02 |
| 04-alignment.txt | 错误码三方对齐机器核对（枚举表 × 前端 errorText/isErrorResult × L1 实际发射） | TC-S4-03 / R-13 / G-11 |
| 05-l1-smoke.txt | L1 真进程 smoke：serve.mjs ×2（4851 默认 / 4852 allow-private 测试注入口）+ 本地 mock（4950），15/15 PASS | TC-S4-04/05/08/09（后端半）+ R-A3 审计留痕 |
| l1-audit-default.jsonl / l1-audit-test.jsonl | 两次真进程每次抓取各 1 行审计 JSONL（4 + 11 = 15 行，字段齐） | R-A3 旁证 |

## 环境事实
- 沙箱 workspace-write、禁网；无浏览器/GUI → L2 交互渲染不可执行（R-18：记录复现步骤，见 TEST_REPORT §7.3 清单；由 tester/将军在宿主构建产物验收）。
- node v24.19.0；契约套件零第三方依赖（node 内置）；node_modules 以 junction 指向宿主 workbench/node_modules（.gitignore 覆盖，git status 不显示），tsc 直跑 exit 0。
- pnpm build 的 vite 段 spawn esbuild 原生服务被沙箱拒（spawn EPERM，完整栈见 03-build.txt）——与 T-083/T-079 记录一致的环境边界，非代码问题。

## L1 smoke 设计（可复跑）
1. 起本地 mock HTTP 目标（127.0.0.1:4950：/page /p2 /spa /404 /500 /flaky /pdf /xss /big /slow）
2. 起 serve.mjs 默认实例（4851，SSRF 守卫开）+ 测试实例（4852，DSH_WEB_FETCH_ALLOW_PRIVATE=1，TEST_CASES §8.3 注入口）
3. 以与 BrowserView.webFetchPage 完全相同的 POST /api/web/fetch 驱动 15 例（ssrf_private/protocol_ftp/invalid_url/dns_error/ok 主路径/xss/http_404/http_500/flaky×2/unsupported_pdf/too_large/timeout/fetch_error/empty_content）→ 15/15 PASS，exit 0

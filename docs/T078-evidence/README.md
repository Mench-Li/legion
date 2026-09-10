<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-078 S1 测试证据（tester）

> 任务：T-078｜阶段：测试执行（tester）｜对象：S1 serve.mjs 文件面加固（R-A1 嵌套/内嵌 .git 防护 + R-A2 畸形路径防崩溃）
> 依据用例：docs/TEST_CASES.md §4.1（TC-S1-01..13）+ TASK_BREAKDOWN S1 机器验收行（依赖 T-077 coder 实现已合入本 worktree：ec228c0 + promote e7677fc）。
> 环境：Windows 沙箱（workspace-write，禁网）；node v24.19.0（唯一运行时）；零第三方依赖下载。只测不修。
> 工作目录：D:/project/DSH/legion/.legion-worktrees/T-078（分支 w/T-078，工作树仅新增 docs/T078-evidence/）。

## 文件清单

| 文件 | 内容 | 关键结果 |
| --- | --- | --- |
| 01-filesapi.txt | node workbench/scripts/files-api.test.mjs | 40 tests / 16 suites / pass 40 / fail 0（含 S1 追加 6 例 + 既有 34 例基线），exit 0 |
| 02-web.txt | node workbench/scripts/web.test.mjs | 21 tests / 12 suites / pass 21 / fail 0（serve.mjs 共享面回归，routeRequest 重构未破坏 S2 域），exit 0 |
| 03-l1-server.log | 独立 serve.mjs 进程（port 4987）stderr | 仅启动行，URIError 0 次、崩溃痕迹 0 次（畸形注入全程未击穿进程） |
| 04-l1-probe.txt | node docs/T078-evidence/l1-probe.mjs（真进程 raw 请求探针） | 57/57 PASS，exit 0 |
| l1-probe.mjs | 自建 L1 探针（真进程 4987：R-A1 七操作矩阵 + junction→.git realpath + R-A2 单发/超长/并发畸形 + 存活/数据面） | 复跑见 04 日志 |
| l1-g8-probe.mjs | 自建模块级 G-8 细节探针（根 list 的 isRepo 标记与 .git 隐藏条目） | subrepo isRepo=true、.git 不出现、list 进入 .git 抛「禁止访问 .git」 |

## 关键判据复跑命令

```
node workbench/scripts/files-api.test.mjs        # L0 S1 契约 + 34 例基线 → 40/40 PASS
node workbench/scripts/web.test.mjs              # L0 S2 域回归（serve.mjs 共享面）→ 21/21 PASS
node docs/T078-evidence/l1-probe.mjs             # L1 真进程 4987 → 57/57 PASS（夹具目录创建方式见 TEST_REPORT §4）
node docs/T078-evidence/l1-g8-probe.mjs          # G-8 isRepo/隐藏条目细节 → 全 PASS
node --check workbench/scripts/serve.mjs workbench/scripts/files-api.test.mjs  # 语法 exit 0
```

## 判定

S1 serve.mjs 文件面加固（R-A1 + R-A2）**全部实测通过，无失败项**（TC-S1-01..13 逐条见 docs/TEST_REPORT.md §2）。未修改任何源码/测试用例。

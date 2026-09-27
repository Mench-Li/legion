<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录为 T-169（w/T-169 HEAD 9282ca1）测试用例设计的自检证据，命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md) · [README.md](../../../README.md) · 最新 CI 证据 .ci/&lt;run&gt;/summary.json。
<!-- evidence-banner:end -->

# T-169 用例文档自检证据

- machcheck-test-cases.mjs：用例文档机器自检（列完整/ID 唯一/类别枚举/AC 全覆盖/BR 正反向配对/§0 计数一致/骨架 node --check），零第三方依赖。
- 01-doc-machcheck.txt：运行输出。
- 02-skeleton-syntax.txt：附录 B 全部 JS 骨架的 node --check 结果。

复跑：node docs/G-mujfc9vi-1/T169-evidence/machcheck-test-cases.mjs（期望 exit 0）。

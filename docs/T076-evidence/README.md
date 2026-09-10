<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-04**（commit `8a8cd0d`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-076 evidence（test-designer 测试用例设计）

| 文件 | 内容 | 产出 |
| --- | --- | --- |
| 01-baselines.txt | 现存基线五套件逐套运行日志（files-api 34 / web 12 / chat 13 / skills 12 / contracts 56，均 exit 0，node v24.19.0 直跑） | docs/TEST_CASES.md §0/§2 |
| 02-doc-machcheck.txt | docs/TEST_CASES.md 一次性机器复核：84 条用例（P0=57/P1=23/P2=4；🟢37/🟡26/🔴21）、切片分布、无重复 ID、表结构一致、§5/§6 引用无缺失 | docs/TEST_CASES.md §9 附录 C |

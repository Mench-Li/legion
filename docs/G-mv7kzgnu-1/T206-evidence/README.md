<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（w/T-206 HEAD `9c4e242d`） 的基线，其中的测试数量、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md)（状态与测试基线）· [README.md](../../../README.md)（总览）· [docs/DEPLOY.md](../../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T206-evidence —— T-206（测试用例设计）的文档自检证据

本目录是 T-206 在【测试用例设计】阶段的**只读**自检证据：校验 `docs/G-mv7kzgnu-1/TEST_CASES.md` 的结构完整性（用例 7 列、ID 唯一、类别/优先级枚举、§0 统计一致、35 条 AC 全覆盖、15 条 BR 正反向配对、M-1~M-7 追溯）与附录 B 骨架的语法合法性。

## 怎么跑

```
node docs/G-mv7kzgnu-1/T206-evidence/machcheck-test-cases.mjs
```

- 需要 Node >= 22（本仓实测 Node v24.19.0）；零第三方依赖。
- **只读**：只读 `TEST_CASES.md`，只把骨架片段写到系统临时目录做 `node --check`，随后删除；不写仓库、不联网、不调任何 HTTP 接口、**不执行任何业务用例**（执行是 T-209 tester 的职责）。
- `01-doc-machcheck.txt` 是该脚本在本机的一次真实输出，供复核与留痕。

## 判据边界

- 本脚本**只**证明「用例文档结构自洽 + 骨架语法合法」，**不**证明业务行为正确。
- 业务验收由 T-209 tester 按 `TEST_CASES.md` §2 分层执行，并把结果写入 `docs/G-mv7kzgnu-1/TEST_REPORT.md`。

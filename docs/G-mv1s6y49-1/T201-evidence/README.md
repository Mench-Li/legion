<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录为 T-201（w/T-201 HEAD `c1ec9496`）测试执行的证据，命令与读数只代表当时状态（2026-10-10）。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md) · [README.md](../../../README.md) · 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T201-evidence —— T-201 测试执行证据

本目录是任务 T-201（tester，目标 G-mv1s6y49-1）的测试执行证据，配合 [../TEST_REPORT.md](../TEST_REPORT.md) 阅读。全部命令使用 **临时库**（`TEAM_HUB_DB=mkdtemp()/team.db`）+ 空闲端口，**未触碰 live `team-hub/team.db`，未改任何产品源码**。

| 文件 | 说明 |
| --- | --- |
| `run-suite-log.txt` | 15 支套件的执行日志（S1~S6 新增 + 9 支基线），含逐支 `tests/pass/fail` 与退出码 |
| `probe-avatar-boundary.mjs` | M1（备用池越界）/ M2（重复 POST 漂移）与数据面名单的只读复现探针 |
| `probe-output.txt` | 上述探针的原始输出（PROBE-1 / PROBE-2 / PROBE-3） |
| `probe-interface-and-boundary.mjs` | 接口/边界探针：role 长度 63/64/65、kind 缺省、sort 递增、无身份被拒、令牌合法性、size 三值 |
| `probe-interface-output.txt` | 上述探针的原始输出（PROBE-A ~ PROBE-F） |

运行：`node docs/G-mv1s6y49-1/T201-evidence/probe-avatar-boundary.mjs` 与 `node docs/G-mv1s6y49-1/T201-evidence/probe-interface-and-boundary.mjs`（均自建临时库、退出码 0）。

基线：w/T-201 HEAD `c1ec9496`，Node v24.19.0（Windows）。本目录不含任何产品源码改动。

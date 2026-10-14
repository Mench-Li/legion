<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（w/T-209 HEAD `24814fb8`） 的基线，其中的测试数量、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md)（状态与测试基线）· [README.md](../../../README.md)（总览）· [docs/DEPLOY.md](../../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T209-evidence —— T-209（测试执行）的复现证据

本目录是 T-209 在【测试执行】阶段的**只读/可复现**证据：对 G-mv7kzgnu-1（软件流水线空间外部执行者头像补齐）
按 `docs/G-mv7kzgnu-1/TEST_CASES.md` 的用例逐层执行，命令、原始日志与探针脚本都留在这里。
结论写在 [docs/G-mv7kzgnu-1/TEST_REPORT.md](../TEST_REPORT.md)。

## 目录内容

| 文件 | 是什么 |
| --- | --- |
| `01~09-*.log` | 9 支受影响/回归套件的原始 stdout（`node <suite>.test.mjs`） |
| `10-tsc-noEmit.log` | `workbench` 下 `node node_modules/typescript/bin/tsc --noEmit` 的输出（空 = 0 错误） |
| `11-evidence-banner.log` / `12-check-docs.log` | 两道文档门禁的原始输出 |
| `20/21-e2e-*.json.log` | 真库快照 + 真 HTTP 的端到端探针两轮输出（E2E-1/2/3/4/6） |
| `20-e2e-state-1.json` / `20-e2e-state-2.json` | 跨重启对比用的两轮结构化快照 |
| `probe-e2e.mjs` | 端到端探针：SQLite 一致性快照（`VACUUM INTO`，只读源）+ 起真 hub + 抓 `/api/roster`/`/api/agents`/`/api/spaces` |
| `injections.ps1` / `injections2.ps1` | 负例注入夹具：改一行 → 跑套件 → **原样按字节恢复**（含恢复校验） |
| `check-suite-registered.mjs` / `check-readme-wording.mjs` | CI 套件清单完备性 / 文档旧口径的机械判据 |
| `30-injections.log` | 负例注入结果汇总（13 条；每条含 `restored=True` 原样恢复证明） |
| `13-banner-fail-scene.log` | 「证据快照目录缺 banner 载体」的失败现场复现（用临时快照目录 `docs/G-mv7kzgnu-1/zevidence` 触发，跑完即删） |

## 怎么复跑

```
node docs/G-mv7kzgnu-1/T209-evidence/probe-e2e.mjs --state=st1.json
node docs/G-mv7kzgnu-1/T209-evidence/probe-e2e.mjs --compare=st1.json --state=st2.json
$code = Get-Content -Raw -Encoding UTF8 ./docs/G-mv7kzgnu-1/T209-evidence/injections.ps1; Invoke-Expression $code
```

- 需要 Node >= 22（本仓实测 Node v24.19.0）；探针只读 live 库 `D:/project/DSH/legion/team-hub/team.db` 并写临时快照目录，**不写 live 库、不改主工作区**。
- 负例注入夹具逐文件先 `ReadAllBytes` 备份、跑完 `WriteAllBytes` 原样恢复，并逐字节校验；结果里 `restored=True` 即证明工作区被还原。

## 边界

- 本目录是**证据**不是实现：不含任何产品代码变更。
- 探针读的库会随时间变化，输出里的条目清单只代表采样时刻；复跑即可得到当时的真实值。

# PRT-009 成本 / 延迟 / 资源基线（自动生成）

> 由 `scripts/prt/baseline-measure.mjs --record` 生成。
> 「已由 GF-001 真实执行采集」段的数值**不在本文件里**，而是运行期从证据文件读出来的——
> 抄一份进来就多一处会与源漂移的副本。仍待采集的项**不给数值**：编造数值会让阶段 3 误判性能回退。
> 完整口径、复现命令与未覆盖项见 [docs/PRT-009-evidence/verify-evidence.md](../../PRT-009-evidence/verify-evidence.md)。

- Node：`v24.19.0`　平台：`win32/x64`

## 已测量（可重复采集）

| 项 | 值 |
| --- | --- |
| `plugins/src/index.ts` | 1 文件 / 221631 字节 / 3718 行 |
| `team-hub/server.mjs` | 1 文件 / 259698 字节 / 4488 行 |
| `team-hub/permission-engine.mjs` | 1 文件 / 3561 字节 / 57 行 |
| `runtime/contracts` | 9 文件 / 104056 字节 |
| `scripts/ci/dsh-boundary.mjs` | 1 文件 / 18199 字节 / 461 行 |
| 平台 HTTP 路由 | 85 |
| 数据库表 | 22 |
| 任务状态 / 迁移边 | 7 / 20 |
| 权限模式 | 5 |
| team-hub 首次就绪 | 236 ms |

## 已由 GF-001 真实执行采集

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| `token-usage` | input 68822 / output 50122 / cacheRead 1563264（provider 上报，非估算；3 个岗位会话） | `docs/superpowers/prt/prt-009-gf001-execution.json` |
| `end-to-end-latency` | 目标级 402.0s（G-mtwxx7an-2）；逐岗位 planner 219.6s / implementer 53.6s / reviewer 103.4s | `docs/superpowers/prt/prt-009-gf001-execution.json` |
| `old-path-task-state-sequence` | 76 个有轨迹的已完成任务中，与字面预期序列相符 4 个；42 个不经过 in_review → 预期序列已被实测修正为「模态序列 + 可接受集合」 | `docs/superpowers/prt/prt-009-execution-evidence.json` |
| `human-intervention-rate` | 95 次，涉及 46 个任务，每个完成任务 1.2 次（125 个任务的样本） | `docs/superpowers/prt/prt-009-execution-evidence.json` |

## 仍待采集

| 项 | 内容 | 阻塞原因 |
| --- | --- | --- |
| `estimated-cost` | 黄金任务的费用估算 | token 已采集；仍缺**有来源**的单价——自建网关无公开报价，PRICING.asOf 仍是 UNSET |
| `peak-resource` | 峰值内存与 CPU | 会话转录不记录进程资源；需在执行期外部采样，且目标平台取决于 PRT-011 分发形态裁决（Task 4 待业主裁决） |


# PRT-009 成本 / 延迟 / 资源基线（自动生成）

> 由 `scripts/prt/baseline-measure.mjs --record` 生成。`pending` 段不含数值：
> 这些量必须有一次真实模型执行才能得到，编造数值会让阶段 3 误判性能回退。

- Node：`v24.19.0`　平台：`win32/x64`

## 已测量（可重复采集）

| 项 | 值 |
| --- | --- |
| `plugins/src/index.ts` | 1 文件 / 221631 字节 / 3718 行 |
| `team-hub/server.mjs` | 1 文件 / 259698 字节 / 4488 行 |
| `team-hub/permission-engine.mjs` | 1 文件 / 3561 字节 / 57 行 |
| `runtime/contracts` | 9 文件 / 103541 字节 |
| `scripts/ci/dsh-boundary.mjs` | 1 文件 / 17258 字节 / 446 行 |
| 平台 HTTP 路由 | 85 |
| 数据库表 | 22 |
| 任务状态 / 迁移边 | 7 / 20 |
| 权限模式 | 5 |
| team-hub 首次就绪 | 240 ms |

## 待采集（需一次真实模型执行）

| 项 | 内容 | 阻塞原因 |
| --- | --- | --- |
| `token-usage` | 黄金任务的 token 用量（input / output） | 需要模型凭证（spec §6.1 SECRET_UNAVAILABLE 之外的正常路径） |
| `estimated-cost` | 黄金任务的费用估算 | 依赖 token-usage；且 PRICING.asOf 仍是 UNSET |
| `end-to-end-latency` | 黄金任务端到端耗时（计划→实现→评审全流程） | 需要一次真实多岗位执行 |
| `peak-resource` | 峰值内存与 CPU | 本机跨平台采样不可靠，需在目标平台按 PRT-011 选定的分发形态采集 |
| `old-path-task-state-sequence` | 旧路径实际发生的任务状态序列（§14.2 对拍基准） | 需要一次真实执行（当前只有预期序列，尚无实测序列） |
| `human-intervention-rate` | 人工介入次数与原因分布 | 需要真实执行样本（单次运行不足以给出比率） |

